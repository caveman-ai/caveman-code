// Grill rounds on the real runtime: a round is an ask.user the client answers
// with one ask.respond, and the grill tool gets the answers back. The
// workspace needs input while a round waits; a second answer is refused; a
// round whose tool call ends is cancelled; grill.finished; nothing works
// outside grill mode. Rounds are posted through the Grill service as the grill
// MCP tool does, and once over /mcp/grill itself with an engine credential;
// the engine is the real Claude adapter and SDK on scripts/smoke-claude.mjs,
// which also stands in for an ACP agent "acp:gemini" (no grill mode) and "codex" (native
// /goal) so the tests can read what those engines are sent.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { Grill, type GrillQuestion } from "./grill.ts";
import { grillLoadedIn } from "./handlers.ts";
import { makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

// A "slow:" prompt keeps its turn running this long (scripts/smoke-claude.mjs).
process.env.SMOKE_CLAUDE_HOLD_MS = "4000";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let grill: Grill["Service"];

let config: Awaited<ReturnType<typeof makeConfig>>;

beforeAll(async () => {
  root = tempRoot("sp-grill-");
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { grillMcp: true, alsoAs: ["gemini", "codex"] });
  client = connect(runtime.url, runtime.token);
  grill = Context.get(runtime.context as unknown as Context.Context<Grill>, Grill);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const reason = (promise: Promise<unknown>) =>
  promise.then(
    () => "ok",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );
const failure = (effect: Effect.Effect<unknown, { readonly message: string }>) =>
  Effect.runPromise(effect.pipe(Effect.flip, Effect.map((error) => error.message)));
async function sessionMode(sessionId: string) {
  const other = connect(runtime.url, runtime.token);
  try {
    return (await other.call("session.attach", { session_id: sessionId, cursor: 0 })).session.mode;
  } finally {
    other.close();
  }
}

const questions: ReadonlyArray<GrillQuestion> = [
  {
    title: "Which database?",
    body: "We store **sessions** and audit logs.",
    options: [{ label: "Postgres" }, { label: "SQLite", description: "one file" }],
    recommended: 0,
  },
  { title: "How do people sign in?", body: "Web and desktop.", options: [{ label: "Magic link" }, { label: "Password" }], recommended: 1 },
];

test("a round asks, one ask.respond answers it, a second is refused; cancel, finish, and nothing outside grill mode", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const changes: Array<Workspace> = [];
  client.on("workspace.changed", (w) => changes.push(w));
  const w = await client.call("workspace.create", { request_id: "g", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, mode: "grill" } });
  const threadId = `caveman:${w.id}`;
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await until(async () => (await sessionMode(w.session_id)) === "grill");
  const asks = () => events.filter((e): e is Extract<SessionEvent, { type: "ask.user" }> => e.type === "ask.user");
  const resolved = (id: string) => events.find((e) => e.type === "ask.resolved" && e.item_id === id);

  // Round 1: the ask the client renders, needs_input, then the answers the tool returns.
  const answers = Effect.runPromise(grill.round(threadId, questions));
  await until(() => asks().length === 1);
  const ask = asks()[0]!;
  expect(ask.item_id).toMatch(/^grill:/);
  expect(ask.payload).toEqual({
    kind: "question",
    round: 1,
    questions: [
      {
        id: "q1",
        prompt: "Which database?",
        detail: "We store **sessions** and audit logs.",
        options: [{ id: "o1", label: "Postgres" }, { id: "o2", label: "SQLite", description: "one file" }],
        recommended: "o1",
        multi_select: false,
        allow_text: true,
      },
      {
        id: "q2",
        prompt: "How do people sign in?",
        detail: "Web and desktop.",
        options: [{ id: "o1", label: "Magic link" }, { id: "o2", label: "Password" }],
        recommended: "o2",
        multi_select: false,
        allow_text: true,
      },
    ],
  });
  await until(() => changes.some((c) => c.id === w.id && c.status === "needs_input"));
  // A row reads the round without attaching the session (Workspace.activity).
  const latest = () => changes.filter((c) => c.id === w.id).at(-1);
  expect(latest()?.activity?.ask).toEqual({ kind: "question", prompt: "Which database?" });
  const respond =(request_id: string, ask_id: string, answers: Array<{ question_id: string; option_ids: Array<string>; text?: string }>) =>
    client.call("ask.respond", { request_id, session_id: w.session_id, ask_id, response: { kind: "question", answers } });
  // One ask.respond carries the whole round.
  expect(await reason(respond("partial", ask.item_id!, [{ question_id: "q1", option_ids: ["o1"] }]))).toBe("invalid_params");
  expect(await reason(respond("bad-option", ask.item_id!, [{ question_id: "q1", option_ids: ["o9"] }, { question_id: "q2", option_ids: ["o1"] }]))).toBe("invalid_params");
  expect(await reason(respond("empty", ask.item_id!, [{ question_id: "q1", option_ids: ["o1"] }, { question_id: "q2", option_ids: [], text: " " }]))).toBe("invalid_params");
  await respond("r1", ask.item_id!, [
    { question_id: "q1", option_ids: ["o1"] },
    { question_id: "q2", option_ids: [], text: "Passkeys" },
  ]);
  expect(await answers).toEqual([
    { title: "Which database?", answer: "Postgres", took_recommendation: true },
    { title: "How do people sign in?", answer: "Passkeys", took_recommendation: false },
  ]);
  expect(resolved(ask.item_id!)?.payload).toMatchObject({ outcome: "answered", response: { kind: "question" } });
  expect(await reason(respond("r1-again", ask.item_id!, [{ question_id: "q1", option_ids: ["o2"] }, { question_id: "q2", option_ids: ["o1"] }]))).toBe("invalid_state");
  await until(() => changes.filter((c) => c.id === w.id).at(-1)?.status === "idle");
  expect(latest()?.activity?.ask).toBeUndefined();

  // A multi-select question takes several options and the user's own words beside them; a single-choice one takes one.
  const clients: GrillQuestion = { title: "Which clients?", body: "", options: [{ label: "Web" }, { label: "Desktop" }, { label: "Mobile" }], recommended: 0, multi_select: true };
  const multi = Effect.runPromise(grill.round(threadId, [clients, questions[0]!]));
  await until(() => asks().length === 2);
  const multiAsk = asks()[1]!;
  expect(multiAsk.payload).toMatchObject({ round: 2, questions: [{ id: "q1", multi_select: true }, { id: "q2", multi_select: false }] });
  expect(await reason(respond("two-single", multiAsk.item_id!, [{ question_id: "q1", option_ids: ["o1"] }, { question_id: "q2", option_ids: ["o1", "o2"] }]))).toBe("invalid_params");
  expect(await reason(respond("twice", multiAsk.item_id!, [{ question_id: "q1", option_ids: ["o1", "o1"] }, { question_id: "q2", option_ids: ["o1"] }]))).toBe("invalid_params");
  await respond("r2", multiAsk.item_id!, [
    { question_id: "q1", option_ids: ["o1", "o3"], text: "CLI" },
    { question_id: "q2", option_ids: ["o2"] },
  ]);
  expect(await multi).toEqual([
    { title: "Which clients?", answer: "Web, Mobile, CLI", took_recommendation: false },
    { title: "Which database?", answer: "SQLite", took_recommendation: false },
  ]);
  await until(() => changes.filter((c) => c.id === w.id).at(-1)?.status === "idle");

  // Round 3 ends with its tool call (the engine stopped): cancelled, and the tool reads why.
  const second = Effect.runFork(grill.round(threadId, [questions[0]!]));
  await until(() => asks().length === 3);
  expect(asks()[2]!.payload).toMatchObject({ round: 3 });
  await Effect.runPromise(Fiber.interrupt(second));
  await until(() => resolved(asks()[2]!.item_id!) !== undefined);
  expect(resolved(asks()[2]!.item_id!)?.payload).toEqual({ outcome: "cancelled" });

  // The tool's own checks, as the agent reads them.
  expect(await failure(grill.round(threadId, [{ ...questions[0]!, options: [{ label: "Only one" }] }]))).toMatch(/2 to 5 options/);
  expect(await failure(grill.round(threadId, [{ ...questions[0]!, recommended: 4 }]))).toMatch(/recommended must be an option index/);

  // Finish: the doc the engine wrote, relative on the wire, whichever form of the worktree path names it.
  expect(await failure(grill.finish(threadId, { doc_path: "docs/", summary: "not written yet" }))).toMatch(/the decisions doc you wrote/);
  fs.mkdirSync(path.join(w.root_path!, "docs/decisions"), { recursive: true });
  fs.writeFileSync(path.join(w.root_path!, "docs/"), "# Decisions\n");
  const real = fs.realpathSync(w.root_path!);
  // macOS: the temp worktree is /var/... to the runtime and /private/var/... to an engine that resolved it.
  const other = real.startsWith("/private/") ? real.slice("/private".length) : real;
  for (const form of [path.join(w.root_path!, "docs/"), path.join(real, "docs/"), path.join(other, "docs/")]) {
    expect(await Effect.runPromise(grill.finish(threadId, { doc_path: form, summary: "Postgres; passkeys." }))).toEqual({ doc_path: "docs/" });
  }
  await until(() => events.some((e) => e.type === "grill.finished"));
  expect(events.find((e) => e.type === "grill.finished")?.payload).toEqual({ doc_path: "docs/", summary: "Postgres; passkeys." });
  // The decisions doc waits to be built, and the row says so.
  await until(() => latest()?.activity?.ready_to_build === true);
  expect(await failure(grill.finish(threadId, { doc_path: "/etc/passwd", summary: "x" }))).toMatch(/inside the workspace/);
  expect(await failure(grill.finish(threadId, { doc_path: "docs/../../etc/passwd", summary: "x" }))).toMatch(/inside the workspace/);
  expect(await failure(grill.finish(threadId, { doc_path: ".", summary: "x" }))).toMatch(/inside the workspace/);
  expect(await failure(grill.finish(threadId, { doc_path: "docs", summary: "x" }))).toMatch(/inside the workspace/);

  // The user types instead of answering: the open round ends, and the tool reads why.
  const third = failure(grill.round(threadId, [questions[0]!]));
  await until(() => asks().length === 4);
  await client.call("turn.submit", { request_id: "build", session_id: w.session_id, kind: "followup", input: { text: "Build it" }, options: { mode: "default" } });
  expect(await third).toMatch(/did not answer this round \(cancelled\)/);
  expect(resolved(asks()[3]!.item_id!)?.payload).toEqual({ outcome: "cancelled" });
  // The person's next turn is the build: the row is no longer ready to build.
  await until(() => latest()?.activity?.turn_started_at !== undefined || latest()?.activity?.last_outcome !== undefined);
  expect(latest()?.activity?.ready_to_build).toBeUndefined();
  // An answer that comes too late reads that the round was cancelled.
  const late = client.call("ask.respond", { request_id: "late", session_id: w.session_id, ask_id: asks()[3]!.item_id!, response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["o1"] }] } });
  await expect(late).rejects.toMatchObject({ error: { data: { reason: "invalid_state" }, message: expect.stringMatching(/cancelled/) } });

  // Default mode: a retried round tells the agent to stop, not to build in the old turn.
  await until(async () => (await sessionMode(w.session_id)) === "default");
  expect(await failure(grill.round(threadId, questions))).toMatch(/The user left grill mode\. Stop now and wait for their next message; do not start building\./);
});

type AskUser = Extract<SessionEvent, { type: "ask.user" }>;
const texts = (events: ReadonlyArray<SessionEvent>, role: "user" | "assistant") =>
  events.flatMap((e) => (e.type === "message.done" && e.payload.role === role ? [e.payload.text] : []));
const doneCount = (events: ReadonlyArray<SessionEvent>) => events.filter((e) => e.type === "turn.done").length;
const oneQuestion = (title: string): GrillQuestion => ({ title, body: "b", options: [{ label: "Yes" }, { label: "No" }], recommended: 0 });

async function workspace(title: string, engine: "claude-agent" | "codex", mode?: "grill") {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: title, repo: { path: repo }, title, engine, options: { model: MODEL, ...(mode ? { mode } : {}) } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  let n = 0;
  const send = (text: string, kind: "followup" | "queue" | "steer" = "followup", options?: { mode: "grill" | "default" }) =>
    client.call("turn.submit", { request_id: `${title}-${n++}`, session_id: w.session_id, kind, input: { text }, ...(options ? { options } : {}) });
  const asks = () => events.filter((e): e is AskUser => e.type === "ask.user");
  const resolved = (id: string) => events.find((e) => e.type === "ask.resolved" && e.item_id === id);
  return { w, threadId: `caveman:${w.id}`, events, send, asks, resolved };
}

test("grill_round over /mcp/grill: the engine credential names its thread, the round belongs to the running turn, and the turn ending cancels it", async () => {
  const { w, threadId, events, send, asks, resolved } = await workspace("grill-http", "claude-agent", "grill");
  await send("slow: grill me");
  await until(() => events.some((e) => e.type === "turn.started"));
  const turnId = events.find((e) => e.type === "turn.started")!.turn_id;

  // The credential the runtime issues an engine session of this thread (McpSessionRegistry), on grill mode's own endpoint.
  const registry = Context.get(runtime.context as unknown as Context.Context<McpSessionRegistry.McpSessionRegistry>, McpSessionRegistry.McpSessionRegistry);
  const { config } = await Effect.runPromise(registry.issue({ threadId: ThreadId.make(threadId), providerInstanceId: ProviderInstanceId.make("claudeAgent") }));
  const url = `${config.endpoint}/grill`;
  const post = (body: unknown, headers: Record<string, string>) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(body) });
  expect((await post({ jsonrpc: "2.0", id: 0, method: "ping" }, { authorization: "Bearer not-a-credential" })).status).toBe(401);
  let session: Record<string, string> = {};
  const mcp = async (body: unknown) => {
    const res = await post(body, { authorization: config.authorizationHeader, ...session });
    const text = await res.text();
    // One JSON-RPC message, or server-sent events whose last one answers.
    const sse = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)));
    return { res, message: (sse.at(-1) ?? (text.trim() ? JSON.parse(text) : undefined)) as { result?: any; error?: unknown } | undefined };
  };
  const init = await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "grill-test", version: "0" } } });
  session = { "mcp-session-id": init.res.headers.get("mcp-session-id")! };
  await mcp({ jsonrpc: "2.0", method: "notifications/initialized" });
  expect((await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })).message?.result.tools.map((t: { name: string }) => t.name).sort()).toEqual(["grill_finish", "grill_round"]);
  const round = (id: number, title: string) =>
    mcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "grill_round", arguments: { questions: [oneQuestion(title)] } } }).then((r) => r.message?.result);

  // Round 1: asked in the running turn, answered by ask.respond, returned to the engine over HTTP.
  const first = round(3, "Ship it?");
  await until(() => asks().length === 1);
  expect(asks()[0]).toMatchObject({ turn_id: turnId, item_id: expect.stringMatching(/^grill:/) });
  await client.call("ask.respond", { request_id: "grill-http-r1", session_id: w.session_id, ask_id: asks()[0]!.item_id!, response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["o2"] }] } });
  expect(await first).toMatchObject({ isError: false, structuredContent: { answers: [{ title: "Ship it?", answer: "No", took_recommendation: false }] } });

  // Round 2 is still open when its turn ends: cancelled in that turn, and the waiting call reads why.
  const second = round(4, "Tests first?");
  await until(() => asks().length === 2);
  expect(asks()[1]).toMatchObject({ turn_id: turnId });
  const ended = await second;
  await until(() => resolved(asks()[1]!.item_id!) !== undefined);
  expect(resolved(asks()[1]!.item_id!)).toMatchObject({ turn_id: turnId, payload: { outcome: "cancelled" } });
  expect(ended.isError).toBe(true);
  expect(JSON.stringify(ended.content)).toMatch(/did not answer this round \(cancelled\)/);

  // The run is over: the credential's thread has no live run to ask in.
  await until(() => doneCount(events) === 1);
  const after = await round(5, "Again?");
  expect(after.isError).toBe(true);
  expect(JSON.stringify(after.content)).toMatch(/no longer owns an active thread run/);
  expect(asks()).toHaveLength(2);
}, 30_000);

test("only the user's own follow-up ends an open round: mail, /goal and a queued input leave it open", async () => {
  const lead = await workspace("grill-lead", "claude-agent");
  // "codex" is the stand-in CLI: its goal.set runs `/goal` as a turn.
  const { w, threadId, events, send, asks, resolved } = await workspace("grill-open", "codex", "grill");
  await send("slow: hold");
  await until(() => events.some((e) => e.type === "turn.started"));
  const open = Effect.runPromise(grill.round(threadId, [oneQuestion("Postgres?")]).pipe(Effect.flip, Effect.map((e) => e.message)));
  await until(() => asks().length === 1);
  const askId = asks()[0]!.item_id!;

  await client.call("mail.task", { request_id: "grill-mail", session_id: lead.w.session_id, to_workspace_id: w.id, body: "check the parser" });
  await client.call("goal.set", { request_id: "grill-goal", session_id: w.session_id, objective: "ship the parser" });
  expect((await send("later", "queue")).disposition).toBe("queued");
  const queued = (await client.call("queue.list", { session_id: w.session_id })).turns.map((t) => t.text);
  expect(queued).toHaveLength(3);
  expect(queued).toContain("/goal ship the parser");
  expect(queued).toContain("later");
  expect(resolved(askId)).toBeUndefined();

  // The user writes instead of answering.
  await send("never mind");
  expect(await open).toMatch(/did not answer this round \(cancelled\)/);
  expect(resolved(askId)?.payload).toEqual({ outcome: "cancelled" });
  await until(() => doneCount(events) === 5, 60_000);
}, 90_000);

test("the grill skill goes with the first turn in grill mode, a mail wake too, never in front of a slash command", async () => {
  const lead = await workspace("grill-lead-2", "claude-agent");
  const { w, events, send } = await workspace("grill-first", "codex", "grill");
  await client.call("goal.set", { request_id: "grill-first-goal", session_id: w.session_id, objective: "ship the parser" });
  await until(() => doneCount(events) === 1, 30_000);
  await send("/compact now");
  await until(() => doneCount(events) === 2, 30_000);
  await client.call("mail.task", { request_id: "grill-first-mail", session_id: lead.w.session_id, to_workspace_id: w.id, body: "check the parser" });
  await until(() => doneCount(events) === 3, 30_000);
  await send("hello");
  await until(() => doneCount(events) === 4, 30_000);
  const replies = texts(events, "assistant");
  // `/goal` reaches Codex's goal command intact, and a slash command stays first.
  expect(replies[0]).toBe("smoke ok: skill=goal ship the parser");
  expect(replies[1]).toBe("smoke ok: skill=compact now");
  // The wake runs with the grill tools, so it carries the skill.
  expect(replies[2]).toMatch(/^smoke ok: skill=caveman-grill:grill \[task from workspace "grill-lead-2"/);
  expect(replies[3]).toBe("smoke ok: hello");
}, 90_000);

test("a steer never carries the skill, and the user's steer ends an open round once it is accepted", async () => {
  const { w, threadId, events, send, asks, resolved } = await workspace("grill-steer", "claude-agent", "grill");
  // A leading slash command: no skill yet, and the stand-in holds the turn.
  await send("/compact slow: wait");
  await until(() => events.some((e) => e.type === "turn.started"));
  const open = Effect.runPromise(grill.round(threadId, [oneQuestion("Postgres?")]).pipe(Effect.flip, Effect.map((e) => e.message)));
  await until(() => asks().length === 1);
  expect((await send("keep going", "steer")).disposition).toBe("steered");
  expect(await open).toMatch(/did not answer this round \(cancelled\)/);
  expect(resolved(asks()[0]!.item_id!)?.payload).toEqual({ outcome: "cancelled" });
  await until(() => texts(events, "user").includes("keep going"));
  await until(() => events.filter((e) => e.type === "turn.done").length >= 1, 30_000);
  // The engine got the steer as typed: nothing was put in front of it (handlers keep the user's
  // own words aside only when the engine text differs).
  const steerMessage = `sp-msg:${createHash("sha256").update(`${w.session_id}\0grill-steer-1`).digest("hex").slice(0, 24)}`;
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    expect(db.prepare("SELECT text FROM caveman_sp_display_text WHERE message_id = ?").all(steerMessage)).toEqual([]);
  } finally {
    db.close();
  }
  await send("hello");
  await until(() => texts(events, "assistant").some((t) => t.endsWith("hello")), 30_000);
  expect(texts(events, "assistant").filter((r) => r.includes("caveman-grill"))).toEqual(["smoke ok: skill=caveman-grill:grill hello"]);
}, 60_000);

test("queue: an edited skill-loading turn keeps the skill; a removed one leaves it for the next turn", async () => {
  const edited = await workspace("grill-edit", "claude-agent");
  await edited.send("slow: one");
  await until(() => edited.events.some((e) => e.type === "turn.started"));
  const two = await edited.send("two", "queue", { mode: "grill" });
  expect(two.disposition).toBe("queued");
  await client.call("queue.edit", { request_id: "grill-edit-e", session_id: edited.w.session_id, turn_id: two.turn_id, text: "TWO" });
  expect((await client.call("queue.list", { session_id: edited.w.session_id })).turns.map((t) => t.text)).toEqual(["TWO"]);
  await until(() => doneCount(edited.events) === 2, 30_000);
  expect(texts(edited.events, "assistant")).toEqual(["smoke ok: one", "smoke ok: skill=caveman-grill:grill TWO"]);
  expect(texts(edited.events, "user")).toEqual(["slow: one", "TWO"]);

  const removed = await workspace("grill-remove", "claude-agent");
  await removed.send("slow: one");
  await until(() => removed.events.some((e) => e.type === "turn.started"));
  const queued = await removed.send("two", "queue", { mode: "grill" });
  await client.call("queue.remove", { request_id: "grill-remove-x", session_id: removed.w.session_id, turn_id: queued.turn_id });
  await until(() => doneCount(removed.events) === 1, 30_000);
  await removed.send("three");
  await until(() => doneCount(removed.events) === 2, 30_000);
  expect(texts(removed.events, "assistant")).toEqual(["smoke ok: one", "smoke ok: skill=caveman-grill:grill three"]);
}, 90_000);

test("a handoff to an engine without grill mode puts the session back in default mode and never sends it the skill", async () => {
  // The handoff takes the engine's default model.
  await client.call("settings.set", { request_id: "grill-handoff-model", settings: { engines: { "acp:gemini": { model: MODEL }, codex: { model: MODEL } } } });
  const { w, events, send } = await workspace("grill-handoff", "claude-agent", "grill");
  await send("hello");
  await until(() => doneCount(events) === 1, 30_000);
  await client.call("mail.handoff", { request_id: "grill-handoff-h", session_id: w.session_id, brief: "carry on with the parser", engine: "acp:gemini" });
  await until(() => doneCount(events) === 2, 30_000);
  await send("next");
  await until(() => doneCount(events) === 3, 30_000);
  expect(events.flatMap((e) => (e.type === "turn.started" ? [e.payload.mode] : []))).toEqual(["grill", "default", "default"]);
  expect(await sessionMode(w.session_id)).toBe("default");
  const replies = texts(events, "assistant");
  expect(replies[0]).toBe("smoke ok: skill=caveman-grill:grill hello");
  // The brief follows the handed-off history (which quotes the earlier reply), with no skill or end notice.
  expect(replies[1]).toMatch(/User message:\ncarry on with the parser$/);
  expect(replies.slice(1).join("\n")).not.toMatch(/\$caveman-grill|Grill mode has ended/);
  expect(replies[2]).toBe("smoke ok: next");
  // And it cannot be put back.
  await expect(send("grill me", "followup", { mode: "grill" })).rejects.toMatchObject({ error: { data: { reason: "unsupported" } } });
}, 60_000);

test("a handoff to another grill engine starts a new engine session: the user's next grill turn loads the skill there", async () => {
  await client.call("settings.set", { request_id: "grill-handoff-codex-model", settings: { engines: { "acp:gemini": { model: MODEL }, codex: { model: MODEL } } } });
  const { w, events, send } = await workspace("grill-handoff-codex", "claude-agent", "grill");
  await send("hello");
  await until(() => doneCount(events) === 1, 30_000);
  await client.call("mail.handoff", { request_id: "grill-handoff-codex-h", session_id: w.session_id, brief: "carry on", engine: "codex" });
  await until(() => doneCount(events) === 2, 30_000);
  await send("next");
  await until(() => doneCount(events) === 3, 30_000);
  await send("again");
  await until(() => doneCount(events) === 4, 30_000);
  expect(events.flatMap((e) => (e.type === "turn.started" ? [e.payload.mode] : []))).toEqual(["grill", "grill", "grill", "grill"]);
  const replies = texts(events, "assistant");
  // T3 hands the conversation to a new engine session (create_with_handoff): its first turn, the brief, loads the skill.
  expect(replies[1]).toMatch(/^smoke ok: skill=caveman-grill:grill Context handoff/);
  expect(replies[1]).toMatch(/User message:\ncarry on$/);
  expect(replies[2]).toBe("smoke ok: next");
  expect(replies[3]).toBe("smoke ok: again");
}, 60_000);

test("a handoff while a grill turn runs: the open round stays open until that turn ends; the brief runs in default mode", async () => {
  await client.call("settings.set", { request_id: "grill-handoff-running-model", settings: { engines: { "acp:gemini": { model: MODEL }, codex: { model: MODEL } } } });
  const { w, threadId, events, send, asks, resolved } = await workspace("grill-handoff-running", "claude-agent", "grill");
  await send("slow: hold");
  await until(() => events.some((e) => e.type === "turn.started"));
  const turnId = events.find((e) => e.type === "turn.started")!.turn_id;
  const open = Effect.runPromise(grill.round(threadId, [oneQuestion("Postgres?")]).pipe(Effect.flip, Effect.map((e) => e.message)));
  await until(() => asks().length === 1);
  await client.call("mail.handoff", { request_id: "grill-handoff-running-h", session_id: w.session_id, brief: "carry on with the parser", engine: "acp:gemini" });
  expect((await client.call("queue.list", { session_id: w.session_id })).turns.map((t) => t.text)).toEqual(["carry on with the parser"]);
  expect(resolved(asks()[0]!.item_id!)).toBeUndefined();
  // The running turn ends with the round still open: cancelled in that turn.
  expect(await open).toMatch(/did not answer this round \(cancelled\)/);
  await until(() => resolved(asks()[0]!.item_id!) !== undefined);
  expect(resolved(asks()[0]!.item_id!)).toMatchObject({ turn_id: turnId, payload: { outcome: "cancelled" } });
  await until(() => doneCount(events) === 2, 30_000);
  expect(events.flatMap((e) => (e.type === "turn.started" ? [e.payload.mode] : []))).toEqual(["grill", "default"]);
  expect(await sessionMode(w.session_id)).toBe("default");
  expect(texts(events, "assistant")[1]).toMatch(/User message:\ncarry on with the parser$/);
  expect(texts(events, "assistant")[1]).not.toMatch(/\$caveman-grill|Grill mode has ended/);
}, 60_000);

test("a session recorded with plan mode replays its proposed plans as the assistant's text, at the same cursor", async () => {
  const { w, events, send } = await workspace("grill-legacy-plan", "claude-agent");
  await send("hello");
  await until(() => doneCount(events) === 1, 30_000);
  const reply = events.find((e) => e.type === "message.done" && e.payload.role === "assistant")!;
  // What plan mode stored: a proposed plan, which v1 no longer has.
  const db = new DatabaseSync(config.dbPath);
  try {
    const legacy = { ...reply, type: "plan.updated", payload: { kind: "proposed", steps: [], markdown: "# Plan\n\n1. Do it." } };
    db.prepare("UPDATE caveman_sp_events SET type = ?, event = ? WHERE session_id = ? AND cursor = ?").run("plan.updated", JSON.stringify(legacy), w.session_id, reply.cursor);
  } finally {
    db.close();
  }
  const replayed: Array<SessionEvent> = [];
  const other = connect(runtime.url, runtime.token);
  try {
    await other.attach(w.session_id, 0, (e) => replayed.push(e));
    await until(() => replayed.length === events.length);
  } finally {
    other.close();
  }
  expect(replayed.map((e) => e.cursor)).toEqual(events.map((e) => e.cursor));
  expect(replayed.some((e) => e.type === "plan.updated")).toBe(false);
  expect(replayed.find((e) => e.cursor === reply.cursor)).toMatchObject({ type: "message.done", payload: { role: "assistant", text: "# Plan\n\n1. Do it." } });
}, 60_000);

test("a grill turn refused before the engine read it (no provider turn) never loaded the skill", () => {
  const msg = (id: string, text: string) => ({ id, text });
  const run = (ordinal: number, status: string, attempt: string) =>
    ({ id: `r${ordinal}`, ordinal, status, startedAt: "2026-10-15T00:00:00Z", providerThreadId: "pt", userMessageId: `m${ordinal}`, activeAttemptId: attempt });
  const projection = (providerTurns: Array<{ runAttemptId: string }>) =>
    ({
      runs: [run(1, "failed", "a1")],
      messages: [msg("m1", "$caveman-grill Grill me")],
      providerTurns,
    }) as never;
  // Codex refused it (busy): the marker never reached the engine, so the next grill turn must carry it again.
  expect(grillLoadedIn(projection([]), "pt")).toBe(false);
  // The engine took the prompt, then the turn failed: the skill is in its context.
  expect(grillLoadedIn(projection([{ runAttemptId: "a1" }]), "pt")).toBe(true);
});
