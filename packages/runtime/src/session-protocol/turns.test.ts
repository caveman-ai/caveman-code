// turn.submit kinds onto upstream steering and queue: queue goes to the back,
// followup ahead of the queue, steer into the running turn; interrupt keeps
// what waits behind it. Real Claude adapter and SDK on scripts/smoke-claude.mjs.
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect, formatThreadReference, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test, vi } from "vitest";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { ROUTER_UNAVAILABLE, ROUTER_UNAVAILABLE_HERE } from "../router/cavemanRouter.ts";
import { COMPRESSION_OFF, COMPRESSION_OFF_RETRIEVE, writeProxyCloud } from "../router/proxyLauncher.ts";

/** What a Cloud computer's chats were told before computers compressed: never again. */
const COMPRESSION_OFF_ON_COMPUTERS = "Compression off on Cloud computers";

// Auto's proxy check answers here; no test reaches a real caveman-proxy.
// The app's own caveman-proxies, as if the runtime had started them (proxyLauncher.ts), and their home.
const proxyHome = vi.hoisted(() => ({ dir: undefined as string | undefined, state: undefined as string | undefined, computer: false }));
vi.mock("../router/proxyLauncher.ts", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appProxyUrl: () => "http://127.0.0.1:8787",
  codexProxyUrl: () => "http://127.0.0.1:8788",
  appProxyHome: () => proxyHome.dir,
  appProxyState: () => proxyHome.state,
  onCloudComputer: () => proxyHome.computer,
}));

import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;

beforeAll(async () => {
  root = tempRoot("sp-turns-");
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { compressionRetrieveExpected: true });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/**
 * The app quit and opened again on the same state, with the startup recovery every launch runs (serverRuntimeStartup).
 * A quit can land after a turn's checkpoint capture committed (turn.done already sent) and before the effect worker
 * settled that capture: the claim outlives the process and holds the thread's effect lane until recovery requeues it.
 */
const reopen = async (options: { readonly compressionRetrieveExpected?: boolean } = {}) => {
  client.close();
  await runtime.close();
  runtime = await startRuntime(config, "fake-claude", undefined, { ...options, recoverOnStartup: true });
  client = connect(runtime.url, runtime.token);
};

const userTexts = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" ? [e.payload.text] : []));

test("a new chat opens before its worktree: the person's message, then the worktree row; a message sent meanwhile waits behind the task; each shows once", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  // git worktree add runs post-checkout: a slow one is a big repository's checkout.
  fs.writeFileSync(path.join(repo, ".git", "hooks", "post-checkout"), "#!/bin/sh\nsleep 2\n", { mode: 0o755 });
  const asked = Date.now();
  const w = await client.call("workspace.create", { request_id: "early", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "the task" } });
  expect(Date.now() - asked).toBeLessThan(1500);
  expect(w.status).toBe("starting");
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await until(() => events.length >= 2);
  const [message, row] = events;
  expect(message).toMatchObject({ type: "message.done", payload: { role: "user", text: "the task" } });
  expect(message?.turn_id).toBeUndefined();
  expect(row).toMatchObject({
    type: "tool.started",
    item_id: `worktree:${w.id}`,
    payload: { name: "worktree", kind: "command", title: `git worktree add ${w.root_path}`, input: { path: w.root_path, branch: w.branch, base_ref: "main" } },
  });
  expect(events.some((e) => e.type === "tool.done")).toBe(false);
  // Sent while the worktree is made: it waits for the start, then goes behind the task's turn.
  const next = await client.call("turn.submit", { request_id: "early-next", session_id: w.session_id, kind: "followup", input: { text: "after" } });
  expect(next.disposition).toBe("queued");
  await until(() => events.filter((e) => e.type === "turn.done").length === 2, 30_000);
  const done = events.findIndex((e) => e.type === "tool.done");
  expect(events[done]).toMatchObject({ item_id: `worktree:${w.id}`, payload: { status: "completed" } });
  expect(done).toBeLessThan(events.findIndex((e) => e.type === "turn.started"));
 // The task once (upstream own record of it is not shown again), then the one sent meanwhile.
  expect(userTexts(events)).toEqual(["the task", "after"]);
  expect(events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").map((e) => e.type === "message.done" && e.payload.text)).toEqual([
    "smoke ok: the task",
    "smoke ok: after",
  ]);
  // What a reader of the journal (a replay, an export) sees: the same, once.
  const replayed: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => replayed.push(e));
  await until(() => replayed.length >= events.length);
  expect(userTexts(replayed)).toEqual(["the task", "after"]);
  expect((await client.call("workspace.get", { workspace_id: w.id })).status).toBe("idle");
});

test("a worktree made ahead (workspace.prewarm) is the next new chat's, its branch renamed; one whose base moved is not taken", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  // Native paths: git lists worktrees with forward slashes on Windows.
  const worktrees = () => git(repo, "worktree", "list", "--porcelain").split("\n").flatMap((l) => (l.startsWith("worktree ") ? [path.resolve(l.slice("worktree ".length))] : []));
  const prewarmed = async (request_id: string, count: number) => {
    const before = worktrees();
    expect(await client.call("workspace.prewarm", { request_id, repo: { path: repo } })).toEqual({});
    await until(() => worktrees().length === count);
    return worktrees().find((w) => !before.includes(w))!;
  };
  const chat = async (request_id: string, text: string) => {
    const w = await client.call("workspace.create", { request_id, repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text } });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await until(() => events.some((e) => e.type === "turn.done"), 30_000);
    return { w, events };
  };

  const spare = await prewarmed("pw-1", 2);
  // Made by now (git lists a worktree a moment before it is ready; one still being made is taken too, behind its row).
  await new Promise((r) => setTimeout(r, 500));
  const { w, events } = await chat("pw-chat", "use the spare");
  expect(fs.realpathSync(w.root_path!)).toBe(spare);
  // Nothing to wait for: no worktree row, the person's message and then the turn.
  expect(events.some((e) => e.type === "tool.started" && e.payload.name === "worktree")).toBe(false);
  expect(userTexts(events)).toEqual(["use the spare"]);
  expect(w.branch).toMatch(/^caveman\/use-the-spare-/);
  expect(git(repo, "branch", "--list", "caveman/*").trim().split(/\s+/).filter((b) => b !== "*" && b !== "+")).toEqual([w.branch]);

  // main moved after the spare was cut: the chat gets a fresh worktree and the stale spare goes.
  const stale = await prewarmed("pw-2", 3);
  fs.writeFileSync(path.join(repo, "later.txt"), "later\n");
  git(repo, "add", "later.txt");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "later");
  const fresh = await chat("pw-fresh", "after main moved");
  expect(fs.realpathSync(fresh.w.root_path!)).not.toBe(stale);
  expect(fresh.events.some((e) => e.type === "tool.started" && e.payload.name === "worktree")).toBe(true);
  expect(fs.existsSync(path.join(fresh.w.root_path!, "later.txt"))).toBe(true);
  await until(() => !worktrees().includes(stale));
});

test("workspace.prewarm with an engine makes the chat ahead, never listed, and the next new chat on it is that chat", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const spareChats = () => {
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    const rows = db.prepare("SELECT id FROM caveman_sp_workspaces WHERE json_extract(internal, '$.spare') IS NOT NULL").all() as Array<{ id: string }>;
    db.close();
    return rows.map((r) => r.id);
  };
  const before = spareChats();
  const options = { model: MODEL };
  expect(await client.call("workspace.prewarm", { request_id: "pwc-1", repo: { path: repo }, engine: "claude-agent", options })).toEqual({});
  await until(() => spareChats().length === before.length + 1, 30_000);
  const [first] = spareChats().filter((id) => !before.includes(id));
  // Other options picked: the chat is made again for them.
  expect(await client.call("workspace.prewarm", { request_id: "pwc-2", repo: { path: repo }, engine: "claude-agent", options: { ...options, access: "full" } })).toEqual({});
  await until(() => !spareChats().includes(first!) && spareChats().length === before.length + 1, 30_000);
  const [chatId] = spareChats().filter((id) => !before.includes(id));
  expect((await client.call("workspace.list", {})).workspaces.map((w) => w.id)).not.toContain(chatId);

  const w = await client.call("workspace.create", { request_id: "pwc-chat", repo: { path: repo }, engine: "claude-agent", options: { ...options, access: "full" }, task: { text: "use the chat made ahead" } });
  expect(w.id).toBe(chatId);
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await until(() => events.some((e) => e.type === "turn.done"), 30_000);
  expect(userTexts(events)).toEqual(["use the chat made ahead"]);
  expect(events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text === "smoke ok: use the chat made ahead")).toBe(true);
  expect(spareChats()).not.toContain(chatId);
  expect((await client.call("workspace.list", {})).workspaces.map((x) => x.id)).toContain(chatId);
});

test("proxy outages never emit compression notices", async () => {
  const w = await client.call("workspace.create", { request_id: "off", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const notices = () => events.filter((e) => e.type === "notification" && e.payload.title === COMPRESSION_OFF);
  const turn = async (id: string) => {
    const done = events.filter((e) => e.type === "turn.done").length;
    await client.call("turn.submit", { request_id: `${id}-${done}`, session_id: w.session_id, kind: "followup", input: { text: id } });
    await until(() => events.filter((e) => e.type === "turn.done").length === done + 1, 30_000);
  };
  try {
    proxyHome.state = "no_binary";
    await turn("retrieve-status:failed");
    await turn("retrieve-status:failed");
    expect(notices()).toHaveLength(0);
    expect(events.filter((e) => e.type === "notification" && e.payload.title === COMPRESSION_OFF_RETRIEVE)).toHaveLength(0);
    proxyHome.state = "running";
    await turn("off-3");
    proxyHome.state = "failed";
    await turn("off-4");
    expect(notices()).toHaveLength(0);
  } finally {
    proxyHome.state = undefined;
  }
}, 60_000);

test("legacy retrieve failures never emit notices, including after relaunch", async () => {
  const w = await client.call("workspace.create", { request_id: "retrieve", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  let events: Array<SessionEvent> = [];
  let turns = 0;
  const attach = async () => {
    events = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await until(() => events.filter((e) => e.type === "turn.done").length === turns, 30_000);
  };
  const notices = () => events.filter((e) => e.type === "notification" && e.payload.title === COMPRESSION_OFF_RETRIEVE);
  const turn = async (status: string) => {
    turns++;
    await client.call("turn.submit", { request_id: `retrieve-${turns}`, session_id: w.session_id, kind: "followup", input: { text: `retrieve-status:${status}` } });
    await until(() => events.filter((e) => e.type === "turn.done").length === turns, 30_000);
  };
  try {
    proxyHome.state = "running";
    await attach();
    await turn("failed");
    await turn("pending");
    expect(notices()).toHaveLength(0);
    await reopen({ compressionRetrieveExpected: true });
    await attach();
    await turn("failed");
    expect(notices()).toHaveLength(0);
    await turn("connected");
    await turn("failed");
    expect(notices()).toHaveLength(0);
    proxyHome.computer = true;
    await turn("failed");
    expect(notices()).toHaveLength(0);
    expect(events.filter((e) => e.type === "notification" && e.payload.title === COMPRESSION_OFF_ON_COMPUTERS)).toHaveLength(0);

  } finally {
    proxyHome.state = undefined;
    proxyHome.computer = false;
  }
}, 60_000);

test("compression notices stay absent across outages, relaunches and Cloud moves", async () => {
  const w = await client.call("workspace.create", { request_id: "relaunch", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  let events: Array<SessionEvent> = [];
  let turns = 0;
  const finished = () => events.filter((e) => e.type === "turn.done").length;
  // The whole journal, replayed from the start.
  const attach = async () => {
    events = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    await until(() => finished() === turns, 30_000);
  };
  const titles = () => events.flatMap((e) => (e.type === "notification" ? [e.payload.title] : []));
  const turn = async (id: string) => {
    await client.call("turn.submit", { request_id: id, session_id: w.session_id, kind: "followup", input: { text: id } });
    turns += 1;
    await until(() => finished() === turns, 30_000);
  };
  const relaunch = async () => {
    await reopen();
    await attach();
  };
  try {
    await attach();
    proxyHome.state = "no_binary";
    await turn("relaunch-1");
    await relaunch();
    await turn("relaunch-2");
    expect(titles().filter((t) => t === COMPRESSION_OFF)).toHaveLength(0);
    // Back, then out again after another relaunch: a new outage, told once more.
    proxyHome.state = "running";
    await turn("relaunch-3");
    await relaunch();
    proxyHome.state = "failed";
    await turn("relaunch-4");
    expect(titles().filter((t) => t === COMPRESSION_OFF)).toHaveLength(0);

    proxyHome.computer = true;
    await turn("relaunch-5");
    await relaunch();
    await turn("relaunch-6");
    expect(titles().filter((t) => t === COMPRESSION_OFF_ON_COMPUTERS)).toHaveLength(0);

  } finally {
    proxyHome.computer = false;
    proxyHome.state = undefined;
  }
}, 120_000);

test("Cloud chats emit no compression notices", async () => {

  const w = await client.call("workspace.create", { request_id: "here", repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const notices = () => events.flatMap((e) => (e.type === "notification" ? [e.payload.title] : []));
  try {
    proxyHome.computer = true;
    const turn = async (id: string) => {
      const done = events.filter((e) => e.type === "turn.done").length;
      await client.call("turn.submit", { request_id: id, session_id: w.session_id, kind: "followup", input: { text: id } });
      await until(() => events.filter((e) => e.type === "turn.done").length === done + 1, 30_000);
    };
    proxyHome.state = "running";
    await turn("here-1");
    proxyHome.state = "failed";
    await turn("here-2");
    await turn("here-3");
    expect(notices().filter((title) => title === COMPRESSION_OFF_ON_COMPUTERS)).toEqual([]);
    expect(notices()).not.toContain(COMPRESSION_OFF);

  } finally {
    proxyHome.computer = false;
    proxyHome.state = undefined;
  }
}, 60_000);

test("queue, followup, steer and interrupt", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "w", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const submit = (request_id: string, kind: "steer" | "followup" | "queue", text: string) =>
    client.call("turn.submit", { request_id, session_id: w.session_id, kind, input: { text } });

  const first = await submit("t1", "queue", "slow: one");
  expect(first.disposition).toBe("started");
  await until(() => events.some((e) => e.type === "turn.started"));
  const queued = await submit("t2", "queue", "two");
  const followup = await submit("t3", "followup", "three");
  expect([queued.disposition, followup.disposition]).toEqual(["queued", "queued"]);
  expect(new Set([first.turn_id, queued.turn_id, followup.turn_id]).size).toBe(3);
  await until(() => events.filter((e) => e.type === "turn.done").length === 3, 30_000);
  // The followup ran before the earlier queued input; queued inputs said nothing until they started.
  expect(userTexts(events)).toEqual(["slow: one", "three", "two"]);
  expect(events.filter((e) => e.type === "turn.done").map((e) => e.turn_id)).toEqual([first.turn_id, followup.turn_id, queued.turn_id]);
  expect(events.filter((e) => e.type === "turn.done").every((e) => e.type === "turn.done" && e.payload.status === "completed")).toBe(true);

  // Steer: goes into the running turn.
  const running = await submit("t4", "followup", "slow: four");
  await until(() => events.filter((e) => e.type === "turn.started").length === 4);
  const steered = await submit("t5", "steer", "also five");
  expect(steered).toEqual({ turn_id: running.turn_id, disposition: "steered" });
  await until(() => userTexts(events).includes("also five"));
  await until(() => events.filter((e) => e.type === "turn.done").length === 4, 30_000);
  // Each message says how it reached the engine: its own turn says nothing, a queued one "queue", a steer "steer".
  const delivery = (text: string) => {
    const e = events.find((x) => x.type === "message.done" && x.payload.role === "user" && x.payload.text === text);
    return e?.type === "message.done" ? (e.payload.delivery ?? null) : "missing";
  };
  expect(["slow: one", "two", "three", "slow: four", "also five"].map(delivery)).toEqual([null, "queue", "queue", null, "steer"]);

 // Stop: the running turn ends interrupted and the queued input behind it waits (upstream Stop holds
  // the queue); the next message lets it go, running first.
  const slow = await submit("t6", "followup", "slow: six");
  await until(() => events.filter((e) => e.type === "turn.started").length === 5);
  // Stop while the engine answers: turn.started can come before the engine has the prompt (under load it
  // did), and a Stop then ends a turn the engine never saw, with no answer to settle.
  await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant" && e.payload.text === "smoke ok: six"), 30_000);
  const behind = await submit("t7", "queue", "seven");
  const interrupted = await client.call("turn.interrupt", { request_id: "i1", session_id: w.session_id });
  expect(interrupted.turn_id).toBe(slow.turn_id);
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === slow.turn_id), 30_000);
  expect(events.find((e) => e.type === "turn.done" && e.turn_id === slow.turn_id)?.payload).toMatchObject({ status: "interrupted" });
  // The stopped engine turn settles (its held result lands) before the next one starts.
  await new Promise((r) => setTimeout(r, 1000));
  expect(events.some((e) => e.type === "turn.started" && e.turn_id === behind.turn_id)).toBe(false);
  // Clients see it as held (paused after Stop), from queue.list and from the queue.updated Stop sent.
  expect((await client.call("queue.list", { session_id: w.session_id })).turns.map((t) => [t.text, t.held])).toEqual([["seven", true]]);
  expect(events.filter((e) => e.type === "queue.updated").at(-1)?.payload).toMatchObject({ turns: [{ text: "seven", held: true }] });
 // A real turn outlasts the resume that follows its start (upstream Resume does the same pair).
  const next = await submit("t8", "followup", "slow: eight");
  expect(next.disposition).toBe("started");
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === behind.turn_id), 30_000);
  expect(userTexts(events).slice(-2)).toEqual(["slow: eight", "seven"]);

  // Or Resume lets the held queue go with no new message.
  await submit("t9", "followup", "slow: nine");
  await until(() => events.filter((e) => e.type === "turn.started").length === 8);
  const held = await submit("t10", "queue", "ten");
  await client.call("turn.interrupt", { request_id: "i2", session_id: w.session_id });
  await until(async () => (await client.call("queue.list", { session_id: w.session_id })).turns.some((t) => t.held === true), 30_000);
  await client.call("queue.resume", { request_id: "r1", session_id: w.session_id });
  await until(() => events.some((e) => e.type === "turn.done" && e.turn_id === held.turn_id), 30_000);
  expect((await client.call("queue.list", { session_id: w.session_id })).turns).toEqual([]);
});

test("turn.submit with effort low reaches the engine's model selection", async () => {
 // The model's effort options, as the provider snapshot (upstream ProviderRegistry) lists them.
  const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.succeed([
      {
        instanceId: "claudeAgent",
        models: [
          {
            slug: MODEL,
            capabilities: {
              optionDescriptors: [{ id: "effort", label: "Reasoning", type: "select", options: [{ id: "low", label: "Low" }, { id: "high", label: "High", isDefault: true }] }],
            },
          },
        ],
      },
    ]),
  } as unknown as ProviderRegistry.ProviderRegistry["Service"]);
  const own = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: providers });
  const c = connect(own.url, own.token);
  try {
    const repo = makeRepo(root, { "README.md": "hi\n" });
    const w = await c.call("workspace.create", { request_id: "we", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });
    const events: Array<SessionEvent> = [];
    await c.attach(w.session_id, 0, (e) => events.push(e));
    await c.call("turn.submit", { request_id: "te", session_id: w.session_id, kind: "followup", input: { text: "effort?" }, options: { effort: "low" } });
    // The stand-in CLI answers with the --effort the SDK launched it with, which comes from modelSelection.options.
    await until(() => events.some((e) => e.type === "message.done" && e.payload.role === "assistant"));
    expect(events.find((e) => e.type === "message.done" && e.payload.role === "assistant")?.payload).toMatchObject({ text: "smoke ok: effort=low" });
  } finally {
    c.close();
    await own.close();
  }
});

test("every engine but an ACP registry agent takes images", async () => {
  const { engines } = await client.call("engine.list", {});
  for (const engine of engines) expect([engine.id, engine.capabilities.images]).toEqual([engine.id, !engine.id.startsWith("acp:")]);
  expect(engines.find((e) => e.id === "claude-agent")?.capabilities.images).toBe(true);
});

test("a turn that links another workspace dispatches that thread's record and digest; unknown and self links get none", async () => {
  const workspace = async (title: string, extra: object = {}) => {
    const w = await client.call("workspace.create", { request_id: `ref-${title}`, repo: { path: makeRepo(root, { "README.md": "hi\n" }) }, title, engine: "claude-agent", options: { model: MODEL }, ...extra });
    const events: Array<SessionEvent> = [];
    await client.attach(w.session_id, 0, (e) => events.push(e));
    return { w, events };
  };
  const a = await workspace("Fix login", { task: { text: "make login work" } });
  await until(() => a.events.some((e) => e.type === "turn.done"), 30_000);
  const b = await workspace("Follow up");
  const text = `Continue ${formatThreadReference(a.w.id, "Fix login")}, not ${formatThreadReference(b.w.id, "Me")} or ${formatThreadReference("no-such-workspace", "Ghost")}`;
  await client.call("turn.submit", { request_id: "ref-submit", session_id: b.w.session_id, kind: "followup", input: { text } });
  await until(() => b.events.some((e) => e.type === "message.done" && e.payload.role === "assistant"), 30_000);

  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const row = db.prepare("SELECT payload_json FROM orchestration_v2_projection_messages WHERE thread_id = ? AND role = 'user'").get(`caveman:${b.w.id}`) as { payload_json: string };
  db.close();
  const records = JSON.parse(row.payload_json).context.records;
  expect(records).toHaveLength(1);
  expect(records[0]).toMatchObject({
    kind: "thread",
    contextId: a.w.id,
    threadId: `caveman:${a.w.id}`,
    title: "Fix login",
    environmentId: "session-protocol-test",
    digest: { status: "completed", goal: "make login work", messages: 2 },
  });
  expect(records[0].digest.latest).toBe("smoke ok: make login work");

  // The bubble keeps the link (the web's chip); the engine read the digest and saw the other two as unavailable.
  expect(userTexts(b.events)).toEqual([text]);
  const answer = b.events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []))[0]!;
  expect(answer).toContain(`threadId: caveman:${a.w.id}\nenvironmentId: session-protocol-test\nstatus: completed\nmessages: 2\ngoal:\n  make login work\nlatest:\n  smoke ok: make login work`);
  expect(answer).toContain("Call thread_read(threadId) only if you need more than the digest.");
  expect(answer).toContain(`<context kind="thread" id="${b.w.id}" unavailable="true"/>`);
  expect(answer).toContain('<context kind="thread" id="no-such-workspace" unavailable="true"/>');

  // Agent mail is not the person's words: its links attach nothing.
  await client.call("mail.ask", { request_id: "ref-mail", session_id: a.w.session_id, to_workspace_id: b.w.id, body: `see ${formatThreadReference(a.w.id, "Fix login")}` });
  const answers = () => b.events.flatMap((e) => (e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []));
  await until(() => answers().length === 2, 30_000);
  expect(answers()[1]).toContain(`<context kind="thread" id="${a.w.id}" unavailable="true"/>`);
  expect(answers()[1]).not.toContain("status: completed");
});

test("a task's thread links read as their labels in the workspace title and branch", async () => {
  const w = await client.call("workspace.create", {
    request_id: "linked-task",
    repo: { path: makeRepo(root, { "README.md": "hi\n" }) },
    engine: "claude-agent",
    options: { model: MODEL },
    task: { text: `Review ${formatThreadReference("ws-1", "Fix login")} again\nthen ship` },
  });
  expect(w.title).toBe("Review Fix login again");
  expect(w.branch).toMatch(/^caveman\/review-fix-login-again-then-ship-[0-9a-f]{6}$/);
});

test("Auto: listed first and a new chat's default while Caveman routes, taken without an effort, and a chat left on it fails plainly once routing is off", async () => {
  const home = tempRoot("sp-caveman-home-");
  proxyHome.dir = home;
  // The engine's own models, as the provider snapshot lists them: Auto goes before them.
  const providers = Layer.succeed(ProviderRegistry.ProviderRegistry, {
    getProviders: Effect.succeed([
      // caveman v4 also puts its own caveman-auto in an engine's list (Codex's did): Auto still shows once.
      {
        instanceId: "claudeAgent",
        installed: true,
        auth: { status: "authenticated" },
        models: [
          { slug: MODEL, name: "Sonnet", isDefault: true, capabilities: { optionDescriptors: [] } },
          { slug: "caveman-auto", name: "Auto", capabilities: { optionDescriptors: [] } },
        ],
      },
    ]),
  } as unknown as ProviderRegistry.ProviderRegistry["Service"]);
  const own = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: providers });
  const client = connect(own.url, own.token);
  const refusal = (call: Promise<unknown>) =>
    call.then(
      () => undefined,
      (error: { error?: { message?: string; data?: { reason?: string } } }) => ({ reason: error.error?.data?.reason, message: error.error?.message }),
    );
  const claude = async () => (await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent");
  const models = async () => (await claude())?.models ?? [];
  const create = (request_id: string, model?: string, files: Record<string, string> = {}) =>
    client.call("workspace.create", { request_id, repo: { path: makeRepo(root, { "README.md": "hi\n", ...files }) }, engine: "claude-agent", ...(model ? { options: { model } } : {}) });
  try {
    // Signed in without a paid routing credential: no Auto, new chats take the engine default.
    const cloud = { cloudUrl: "https://cloud.example", accessToken: "cave_free_login_fake" };
    writeProxyCloud(home, cloud);
    expect((await models()).map((m) => m.id)).toEqual([MODEL]);
    expect((await claude())?.default_model).toBe(MODEL);
    expect(await refusal(create("auto-off", "caveman-auto"))).toEqual({ reason: "invalid_params", message: ROUTER_UNAVAILABLE });
    // A saved default of Auto gives way to the engine's own default while Auto is down: nobody picked it now.
    await client.call("settings.set", { request_id: "auto-default", settings: { engines: { "claude-agent": { model: "caveman-auto" } } } });
    expect(await refusal(create("auto-saved"))).toBeUndefined();

    writeProxyCloud(home, { ...cloud, routingKey: "cave_paid_router_fake" });
 // First, and the default a new chat starts on; a person may set another.
    const listed = await models();
    expect(listed[0]).toEqual({ id: "caveman-auto", label: "Auto", efforts: [], description: "Caveman picks the model for each message" });
    expect(listed.filter((m) => m.label === "Auto")).toHaveLength(1);
    expect((await claude())?.default_model).toBe("caveman-auto");
    // Nothing saved: a new chat starts on Auto.
    await client.call("settings.set", { request_id: "auto-unset", settings: { engines: { "claude-agent": {} } } });
    const unset = await create("auto-unset-chat");
    const unsetEvents: Array<SessionEvent> = [];
    await client.attach(unset.session_id, 0, (e) => unsetEvents.push(e));
    await client.call("turn.submit", { request_id: "auto-unset-turn", session_id: unset.session_id, kind: "followup", input: { text: "hi" } });
    await until(() => unsetEvents.some((e) => e.type === "turn.started"));
    expect(unsetEvents.find((e) => e.type === "turn.started")?.payload).toMatchObject({ model: "caveman-auto" });
    // A non-Auto setting is the person's own default and wins over Auto.
    await client.call("settings.set", { request_id: "auto-other", settings: { engines: { "claude-agent": { model: MODEL } } } });
    expect((await claude())?.default_model).toBe("caveman-auto");
    await client.call("settings.set", { request_id: "auto-default-again", settings: { engines: { "claude-agent": { model: "caveman-auto" } } } });
    const w = await create("auto-on", "caveman-auto");
    const submit = (request_id: string, options?: { model: string; effort: string }) =>
      client.call("turn.submit", { request_id, session_id: w.session_id, kind: "followup", input: { text: "hi" }, ...(options ? { options } : {}) });
    expect(await refusal(submit("auto-effort", { model: "caveman-auto", effort: "high" }))).toMatchObject({ reason: "invalid_params" });

    // A project whose local Claude settings send Claude Code elsewhere: Auto asked for fails the chat once its worktree
    // (what the launch reads) is made, saying why; saved, it gives way.
    const elsewhere = { ".claude/settings.local.json": JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://llm.example.internal" } }) };
    const hereRepo = makeRepo(root, { "README.md": "hi\n", ...elsewhere });
    const here = await client.call("workspace.create", { request_id: "auto-here", repo: { path: hereRepo }, engine: "claude-agent", options: { model: "caveman-auto" } });
    const hereEvents: Array<SessionEvent> = [];
    await client.attach(here.session_id, 0, (e) => hereEvents.push(e));
    await until(() => hereEvents.some((e) => e.type === "notification"));
    expect(hereEvents.find((e) => e.type === "notification")?.payload).toEqual({ level: "warning", title: "This chat could not start", body: ROUTER_UNAVAILABLE_HERE });
    expect((await client.call("workspace.get", { workspace_id: here.id })).status).toBe("failed");
    // Refused after the worktree was made: the worktree and branch went again.
    expect(git(hereRepo, "worktree", "list").trim().split("\n")).toHaveLength(1);
    expect(git(hereRepo, "branch", "--list", "caveman/*").trim()).toBe("");
    // A gitignored settings.local.json stays in the main checkout: the new worktree, as each turn checks it, routes.
    const ignoredRepo = makeRepo(root, { "README.md": "hi\n", ".gitignore": ".claude/settings.local.json\n" });
    fs.mkdirSync(path.join(ignoredRepo, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(ignoredRepo, ".claude", "settings.local.json"), elsewhere[".claude/settings.local.json"]);
    const routed = await client.call("workspace.create", { request_id: "auto-ignored", repo: { path: ignoredRepo }, engine: "claude-agent", options: { model: "caveman-auto" } });
    expect(
      await refusal(client.call("turn.submit", { request_id: "auto-ignored-turn", session_id: routed.session_id, kind: "followup", input: { text: "hi" } })),
    ).toBeUndefined();
    const fellBack = await create("auto-saved-here", undefined, elsewhere);
    expect(
      await refusal(client.call("turn.submit", { request_id: "auto-saved-here-turn", session_id: fellBack.session_id, kind: "followup", input: { text: "hi" } })),
    ).toBeUndefined();

    // A project whose committed Claude settings use Bedrock: nothing asked for, its new chats start on the engine's own
    // default, which project.list names so the composer shows it, and a turn starts there.
    await client.call("settings.set", { request_id: "auto-bedrock-unset", settings: { engines: { "claude-agent": {} } } });
    const bedrockRepo = makeRepo(root, { "README.md": "hi\n", ".claude/settings.json": JSON.stringify({ env: { CLAUDE_CODE_USE_BEDROCK: "1" } }) });
    const onBedrock = await client.call("workspace.create", { request_id: "auto-bedrock", repo: { path: bedrockRepo }, engine: "claude-agent" });
    const bedrockEvents: Array<SessionEvent> = [];
    await client.attach(onBedrock.session_id, 0, (e) => bedrockEvents.push(e));
    await client.call("turn.submit", { request_id: "auto-bedrock-turn", session_id: onBedrock.session_id, kind: "followup", input: { text: "hi" } });
    await until(() => bedrockEvents.some((e) => e.type === "turn.started"));
    expect(bedrockEvents.find((e) => e.type === "turn.started")?.payload).toMatchObject({ model: MODEL });
    expect(bedrockEvents.some((e) => e.type === "notification")).toBe(false);
    const projects = (await client.call("project.list", {})).projects;
    expect(projects.find((p) => p.id === onBedrock.project_id)?.engine_default_models).toEqual({ "claude-agent": MODEL });
    expect(projects.find((p) => p.id === unset.project_id)?.engine_default_models).toBeUndefined();

    fs.rmSync(path.join(home, "cloud.json"));
    // Auto gone: no project names a default of its own.
    expect((await client.call("project.list", {})).projects.some((p) => p.engine_default_models !== undefined)).toBe(false);
    expect(await refusal(submit("auto-stale"))).toEqual({ reason: "invalid_params", message: ROUTER_UNAVAILABLE });
  } finally {
    client.close();
    await own.close();
    proxyHome.dir = undefined;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
