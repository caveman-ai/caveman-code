// The composer's rows on the real runtime: grill mode, the queue read-back,
// restore to a turn (with the later turns kept as a branch), the session
// goal, Record a skill and the Remote control setting. Real Claude adapter
// and SDK on scripts/smoke-claude.mjs; the skill writer is a fake.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as ServerSettings from "../serverSettings.ts";
import { layerDenyAll } from "../plugins/CredentialBroker.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { byTaskStart, grillModeRefusal } from "./handlers.ts";
import { SkillWriter } from "./services.ts";
import { normalizeSkill, writeSkill } from "./skills.ts";
import { createAttachmentId } from "../attachmentStore.ts";
import { git, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

process.env.SMOKE_CLAUDE_HOLD_MS = "3000";

let root: string;
let space: { bare: string; commit: string };
let home: string;
let config: Awaited<ReturnType<typeof makeConfig>>;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
const written: Array<string> = [];

const SKILL = `---
name: ship-parser
description: Ship a parser change with its tests.
---

# Ship a parser change

1. Edit the parser.
2. Run the tests.
`;

beforeAll(async () => {
  root = tempRoot("sp-composer-");
  // A space: a bare repo holding one plugin at its root.
  const seed = makeRepo(root, { ".claude-plugin/plugin.json": JSON.stringify({ name: "kit" }), "README.md": "kit\n" });
  const bare = path.join(root, "kit.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, bare]);
  space = { bare, commit: git(seed, "rev-parse", "HEAD").trim() };
  home = path.join(root, "home");
  fs.mkdirSync(home);
  const settings = ServerSettings.layerTest({ plugins: { spaces: [{ url: bare, commit: space.commit, enabled: true }] } }).pipe(Layer.orDie);
  const provide = Layer.mergeAll(
    Layer.succeed(HostProcess.HomeDirectory, home),
    settings,
    // Plugins, as server.ts has them (marketplaces, skill.save into a plugin, @plugin mentions).
    PluginRegistry.layer.pipe(Layer.provide(Layer.mergeAll(settings, layerDenyAll))),
    Layer.succeed(SkillWriter, {
      write: (input) =>
        Effect.sync(() => {
          written.push(input.transcript);
          return { text: `Here it is:\n\n${SKILL}`, usage: { model: "fake/skill-writer", input_tokens: 100, output_tokens: 20, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.001, basis: "list_price" as const } } };
        }),
    }),
  );
  config = await makeConfig();
  runtime = await startRuntime(config, "fake-claude", undefined, { provide });
  client = connect(runtime.url, runtime.token);
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
const texts = (events: ReadonlyArray<SessionEvent>, role: "user" | "assistant") =>
  events.flatMap((e) => (e.type === "message.done" && e.payload.role === role ? [e.payload.text] : []));
const doneCount = (events: ReadonlyArray<SessionEvent>) => events.filter((e) => e.type === "turn.done").length;
/** Session.mode as a client reads it after a reload, on a connection of its own. */
async function sessionMode(sessionId: string) {
  const other = connect(runtime.url, runtime.token);
  try {
    return (await other.call("session.attach", { session_id: sessionId, cursor: 0 })).session.mode;
  } finally {
    other.close();
  }
}

async function workspace(title: string, mode?: "grill") {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: title, repo: { path: repo }, title, engine: "claude-agent", options: { model: MODEL, ...(mode ? { mode } : {}) } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  let n = 0;
  const send = async (text: string, kind: "followup" | "queue" = "followup", options?: { mode: "grill" | "default" }) =>
    client.call("turn.submit", { request_id: `${title}-${n++}`, session_id: w.session_id, kind, input: { text }, ...(options ? { options } : {}) });
  return { w, events, send };
}

test("grill mode: engine.list says so; the skill loads once on entry, never in default mode; access is unchanged", async () => {
  const { engines } = await client.call("engine.list", {});
  expect(engines.find((e) => e.id === "claude-agent")?.capabilities).toMatchObject({ grill_mode: true, native_goal: false, compact: true });
  expect(grillModeRefusal("caveman", "grill")).toBeNull();
  expect(grillModeRefusal("acp:gemini", "grill")).toBe("acp:gemini has no grill mode");
  expect(grillModeRefusal("caveman", "default")).toBeNull();
  expect(grillModeRefusal("codex", "grill")).toBeNull();

  const { w, events, send } = await workspace("grill");
  await send("mode?");
  await until(() => doneCount(events) === 1, 30_000);
  await send("mode?", "followup", { mode: "grill" });
  await until(() => doneCount(events) === 2, 30_000);
  expect(await sessionMode(w.session_id)).toBe("grill");
  await send("mode?");
  await until(() => doneCount(events) === 3, 30_000);
  await send("mode?", "followup", { mode: "default" });
  await until(() => doneCount(events) === 4, 30_000);
  await send("mode?");
  await until(() => doneCount(events) === 5, 30_000);

  const replies = texts(events, "assistant");
  // Default mode sees nothing of grill mode; entering runs the user-only skill natively, once.
  expect(replies[0]).toBe("smoke ok: mode=bypassPermissions");
  expect(replies[1]).toBe("smoke ok: skill=caveman-grill:grill mode=bypassPermissions");
  expect(replies[2]).toBe("smoke ok: mode=bypassPermissions");
  // The first turn after grill mode says, in one line, that it ended.
  expect(replies[3]).toBe("smoke ok: [Caveman Code] Grill mode has ended; don't call the grill tools, work normally from here.\n\nmode?");
  expect(replies[4]).toBe("smoke ok: mode=bypassPermissions");
  expect(replies.filter((r) => r.includes("caveman-grill"))).toHaveLength(1);
  // The transcript keeps the user's own words.
  expect(texts(events, "user")).toEqual(["mode?", "mode?", "mode?", "mode?", "mode?"]);
  expect(events.flatMap((e) => (e.type === "turn.started" ? [e.payload.mode] : []))).toEqual(["default", "grill", "grill", "default", "default"]);
  expect(await sessionMode(w.session_id)).toBe("default");
});

test("a workspace created in grill mode loads the skill with its first turn", async () => {
  const { w, events, send } = await workspace("grill-create", "grill");
  await until(async () => (await sessionMode(w.session_id)) === "grill");
  await send("mode?");
  await until(() => doneCount(events) === 1, 30_000);
  expect(texts(events, "assistant")).toEqual(["smoke ok: skill=caveman-grill:grill mode=bypassPermissions"]);
});

test("queue: list, edit, reorder and remove what waits; the edits are what runs", async () => {
  const { w, events, send } = await workspace("queue");
  const session_id = w.session_id;
  await send("slow: one");
  await until(() => events.some((e) => e.type === "turn.started"));
  const two = await send("two", "queue");
  const three = await send("three", "queue");
  const four = await send("four", "queue");
  expect([two, three, four].map((r) => r.disposition)).toEqual(["queued", "queued", "queued"]);
  const listed = await client.call("queue.list", { session_id });
  expect(listed.turns.map((t) => [t.turn_id, t.text])).toEqual([[two.turn_id, "two"], [three.turn_id, "three"], [four.turn_id, "four"]]);
  // A second client attached to the session sees every queue change as it happens.
  const other = connect(runtime.url, runtime.token);
  const seen: Array<SessionEvent> = [];
  await other.attach(session_id, 0, (e) => seen.push(e));
  const lastQueue = () => seen.filter((e) => e.type === "queue.updated").at(-1) as Extract<SessionEvent, { type: "queue.updated" }> | undefined;
  await until(() => lastQueue()?.payload.turns.length === 3);

  expect(await client.call("queue.edit", { request_id: "e1", session_id, turn_id: three.turn_id, text: "THREE" })).toMatchObject({ turn_id: three.turn_id, text: "THREE" });
  await until(() => lastQueue()?.payload.turns.map((t) => t.text).join() === "two,THREE,four");
  const reordered = await client.call("queue.reorder", { request_id: "r1", session_id, turn_id: four.turn_id, before_turn_id: two.turn_id });
  expect(reordered.turns.map((t) => t.text)).toEqual(["four", "two", "THREE"]);
  await until(() => lastQueue()?.payload.turns.map((t) => t.text).join() === "four,two,THREE");
  await client.call("queue.remove", { request_id: "x1", session_id, turn_id: two.turn_id });
  expect((await client.call("queue.list", { session_id })).turns.map((t) => t.text)).toEqual(["four", "THREE"]);
  await until(() => lastQueue()?.payload.turns.map((t) => t.text).join() === "four,THREE");
  other.close();
  expect(await reason(client.call("queue.remove", { request_id: "x2", session_id, turn_id: two.turn_id }))).toBe("invalid_state");

  await until(() => doneCount(events) === 3, 40_000);
  expect(texts(events, "user")).toEqual(["slow: one", "four", "THREE"]);
  expect(texts(events, "assistant")).toEqual(["smoke ok: one", "smoke ok: four", "smoke ok: THREE"]);
  expect((await client.call("queue.list", { session_id })).turns).toEqual([]);
});

test("restore: files and transcript back to a turn, the later turns and edits kept as a branch", async () => {
  const { w, events, send } = await workspace("restore");
  expect((await client.call("engine.list", {})).engines.find((e) => e.id === "claude-agent")?.capabilities.restore).toBe(true);
  await send("write: notes.txt first");
  await until(() => doneCount(events) === 1, 30_000);
  const at = events.find((e) => e.type === "turn.done")!.cursor;
  await send("write: notes.txt second");
  await until(() => doneCount(events) === 2, 30_000);
  // An edit of the user's own after the last turn.
  fs.writeFileSync(path.join(w.root_path!, "draft.md"), "mine\n");
  expect(fs.readFileSync(path.join(w.root_path!, "notes.txt"), "utf8")).toBe("second");
  expect(await reason(client.call("session.restore", { request_id: "bad", session_id: w.session_id, at: 1 }))).toBe("invalid_params");

  const restored = await client.call("session.restore", { request_id: "rs1", session_id: w.session_id, at });
  expect(fs.readFileSync(path.join(w.root_path!, "notes.txt"), "utf8")).toBe("first");
  expect(fs.existsSync(path.join(w.root_path!, "draft.md"))).toBe(false);
  await until(() => events.some((e) => e.type === "session.restored"));
  const marker = events.find((e) => e.type === "session.restored")!;
  expect(marker.payload).toEqual({ at, branch_workspace_id: restored.branch!.id });

  // The branch: both turns in its transcript, the files as they were (the user's edit included).
  const branch = restored.branch!;
  expect(branch.title).toBe("restore (before restore)");
  expect((await client.call("fs.read", { workspace_id: branch.id, path: "notes.txt" })).content).toBe("second");
  expect((await client.call("fs.read", { workspace_id: branch.id, path: "draft.md" })).content).toBe("mine\n");
  const branchEvents: Array<SessionEvent> = [];
  await client.attach(branch.session_id, 0, (e) => branchEvents.push(e));
  await until(() => doneCount(branchEvents) === 2);
  expect(texts(branchEvents, "user")).toEqual(["write: notes.txt first", "write: notes.txt second"]);

  // The session goes on from the restored turn.
  await send("after the restore");
  await until(() => doneCount(events) === 3, 30_000);
  expect(texts(events, "assistant").at(-1)).toBe("smoke ok: after the restore");
});

test("restore twice without a turn between: each restore keeps one branch, the files follow", async () => {
  const { w, events, send } = await workspace("twice");
  for (const word of ["one", "two", "three"]) {
    await send(`write: notes.txt ${word}`);
    await until(() => doneCount(events) === ["one", "two", "three"].indexOf(word) + 1, 30_000);
  }
  const [c1, c2] = events.filter((e) => e.type === "turn.done").map((e) => e.cursor);
  const count = async () => (await client.call("workspace.list", {})).workspaces.length;
  const before = await count();

  const first = await client.call("session.restore", { request_id: "tw1", session_id: w.session_id, at: c2! });
  expect(fs.readFileSync(path.join(w.root_path!, "notes.txt"), "utf8")).toBe("two");
  expect((await client.call("fs.read", { workspace_id: first.branch!.id, path: "notes.txt" })).content).toBe("three");
  expect(await count()).toBe(before + 1);

  const second = await client.call("session.restore", { request_id: "tw2", session_id: w.session_id, at: c1! });
  expect(fs.readFileSync(path.join(w.root_path!, "notes.txt"), "utf8")).toBe("one");
  expect((await client.call("fs.read", { workspace_id: second.branch!.id, path: "notes.txt" })).content).toBe("two");
  expect(await count()).toBe(before + 2);
  // The undone turn cannot be restored to; nothing is left behind by the refusal.
  const c3 = events.filter((e) => e.type === "turn.done")[2]!.cursor;
  expect(await reason(client.call("session.restore", { request_id: "tw3", session_id: w.session_id, at: c3 }))).toBe("invalid_state");
  expect(await count()).toBe(before + 2);
});

test("restore refuses, keeping the ignored file, where the turn's file is now a folder holding one", async () => {
  const { w, events, send } = await workspace("ignored");
  const checkout = w.root_path!;
  await send("write: config first");
  await until(() => doneCount(events) === 1, 30_000);
  const at = events.find((e) => e.type === "turn.done")!.cursor;
  // The person turns the file into a folder and keeps a secret in it, one the checkpoint never saw.
  fs.appendFileSync(git(checkout, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim(), ".env\n");
  fs.rmSync(path.join(checkout, "config"));
  fs.mkdirSync(path.join(checkout, "config"));
  fs.writeFileSync(path.join(checkout, "config", ".env"), "SECRET=1\n");
  const count = async () => (await client.call("workspace.list", {})).workspaces.length;
  const before = await count();

  const refused = await client.call("session.restore", { request_id: "ig1", session_id: w.session_id, at }).then(
    () => "restored",
    (error: { error?: { message?: string; data?: { reason?: string } } }) => `${error.error?.data?.reason}: ${error.error?.message}`,
  );
  expect(refused).toBe("invalid_state: Restoring would delete ignored files this checkpoint never saved: config/.env. Move them elsewhere, then restore again.");
  expect(fs.readFileSync(path.join(checkout, "config", ".env"), "utf8")).toBe("SECRET=1\n");
  expect(await count()).toBe(before);

  // Moved out of the way, the restore goes ahead.
  fs.rmSync(path.join(checkout, "config", ".env"));
  await client.call("session.restore", { request_id: "ig2", session_id: w.session_id, at });
  expect(fs.readFileSync(path.join(checkout, "config"), "utf8")).toBe("first");
});

test("a fork's copied turns are not restorable there; a goal goes with the fork", async () => {
  const { w, events, send } = await workspace("forked");
  await client.call("goal.set", { request_id: "fg", session_id: w.session_id, objective: "Ship the parser" });
  await send("hello");
  await until(() => doneCount(events) === 1, 30_000);
  const at = events.find((e) => e.type === "turn.done")!.cursor;
  const fork = await client.call("session.fork", { request_id: "ff", session_id: w.session_id, at });
  expect(await reason(client.call("session.restore", { request_id: "fr", session_id: fork.session.id, at }))).toBe("unsupported");
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const row = db.prepare("SELECT internal FROM caveman_sp_workspaces WHERE session_id = ?").get(fork.session.id) as { internal: string };
  db.close();
  expect(JSON.parse(row.internal).goal).toEqual({ objective: "Ship the parser", native: false });
});

test("a fork reads the html_render pages its source chat published", async () => {
  const { w, events, send } = await workspace("forked-page");
  await send("hello");
  await until(() => doneCount(events) === 1, 30_000);
  const db = new DatabaseSync(config.dbPath, { readOnly: true });
  const { thread_id } = db.prepare("SELECT thread_id FROM caveman_sp_workspaces WHERE id = ?").get(w.id) as { thread_id: string };
  db.close();
  const page = createAttachmentId(thread_id, "html")!;
  fs.mkdirSync(config.attachmentsDir, { recursive: true });
  fs.writeFileSync(path.join(config.attachmentsDir, `${page}.html`), "<!doctype html><p>Chart</p>");
  const fork = await client.call("session.fork", { request_id: "fp", session_id: w.session_id, at: events.find((e) => e.type === "turn.done")!.cursor });
  expect(await client.call("htmlRender.read", { workspace_id: fork.workspace.id, attachment_id: page })).toEqual({ html: "<!doctype html><p>Chart</p>" });
});

test("goal: kept by the runtime and prepended to each turn; the transcript keeps the user's words", async () => {
  const { w, events, send } = await workspace("goal");
  expect(await client.call("goal.set", { request_id: "g1", session_id: w.session_id, objective: "  Ship the parser " })).toEqual({ objective: "Ship the parser", native: false });
  await until(() => events.some((e) => e.type === "goal.updated"));
  await send("hello");
  await until(() => doneCount(events) === 1, 30_000);
  expect(texts(events, "user")).toEqual(["hello"]);
  expect(texts(events, "assistant")[0]).toContain("keep working toward it: Ship the parser");
  expect(texts(events, "assistant")[0]).toMatch(/hello$/);

  await client.call("goal.set", { request_id: "g2", session_id: w.session_id, objective: null });
  await send("bye");
  await until(() => doneCount(events) === 2, 30_000);
  expect(texts(events, "assistant")[1]).toBe("smoke ok: bye");
  expect(events.filter((e) => e.type === "goal.updated").map((e) => e.payload)).toEqual([
    { objective: "Ship the parser", native: false },
    { objective: null, native: false },
  ]);
});

test("Record a skill: a SKILL.md from the session into the project's skills or mine, never over one already there", async () => {
  const { w, events, send } = await workspace("skill");
  expect(await reason(client.call("skill.record", { request_id: "k0", session_id: w.session_id, scope: "project", project_id: w.project_id! }))).toBe("invalid_state");
  await send("write: parser.ts export {};");
  await until(() => doneCount(events) === 1, 30_000);

  const project = (await client.call("project.list", {})).projects.find((p) => p.id === w.project_id)!;
  const skill = await client.call("skill.record", { request_id: "k1", session_id: w.session_id, scope: "project", project_id: project.id, note: "for parser work" });
  const file = path.join(fs.realpathSync(project.path), ".agents", "skills", "ship-parser", "SKILL.md");
  expect(skill).toEqual({ name: "ship-parser", path: file, markdown: SKILL.replace("Ship a parser change with its tests.", '"Ship a parser change with its tests."') });
  expect(fs.readFileSync(file, "utf8")).toBe(skill.markdown);
  expect(written.at(-1)).toContain("User: write: parser.ts export {};");
  // Every engine lists it from there.
  expect((await client.call("skill.list", {})).skills.find((s) => s.path === file)).toMatchObject({ scope: "project", project_id: project.id });
  // The same name again is refused, never written over; mine is a separate folder.
  expect(await reason(client.call("skill.record", { request_id: "k2", session_id: w.session_id, scope: "project", project_id: project.id }))).toBe("invalid_state");
  const mine = await client.call("skill.record", { request_id: "k3", session_id: w.session_id, scope: "me" });
  expect(mine.path).toBe(path.join(fs.realpathSync(home), ".agents", "skills", "ship-parser", "SKILL.md"));
  expect(await reason(client.call("skill.record", { request_id: "k4", session_id: w.session_id, scope: "plugin", plugin_id: "nope@x" }))).toBe("not_found");
  // The writer's call is spend: a runtime-level row under the Caveman engine and this workspace, never a session event.
  expect(events.some((e) => e.type === "usage" && e.payload.model === "fake/skill-writer")).toBe(false);
  const byEngine = await client.call("spend.summary", { group_by: "engine" });
  expect(byEngine.rows.find((r) => r.key === "caveman")).toMatchObject({ input_tokens: 300, output_tokens: 60, measured_usd: 0.003, basis: "list_price" });
  const byWorkspace = await client.call("spend.summary", { group_by: "workspace" });
  expect(byWorkspace.rows.find((r) => r.key === w.id)).toMatchObject({ label: "skill", output_tokens: expect.any(Number) });
});

test("a skill is never written outside its folder: a linked skills folder, a linked skill", async () => {
  const base = tempRoot("sp-skill-");
  const within = path.join(base, "repo");
  const outside = path.join(base, "outside");
  fs.mkdirSync(within);
  fs.mkdirSync(outside);
  const markdown = "---\nname: x\n---\n";
  fs.symlinkSync(outside, path.join(within, "linked"));
  await expect(writeSkill({ dir: path.join(within, "linked"), within, name: "x", markdown })).rejects.toThrow(/outside/);
  fs.mkdirSync(path.join(within, "skills"));
  fs.symlinkSync(outside, path.join(within, "skills", "y"));
  await expect(writeSkill({ dir: path.join(within, "skills"), within, name: "y", markdown })).rejects.toThrow(/outside/);
  expect(fs.readdirSync(outside)).toEqual([]);
  expect(await writeSkill({ dir: path.join(within, "skills"), within, name: "x", markdown })).toBe(path.join(fs.realpathSync(within), "skills", "x", "SKILL.md"));
  fs.rmSync(base, { recursive: true, force: true });
});

test("@plugin: a mentioned plugin's capabilities reach the engine with the turn; the transcript keeps the user's words", async () => {
  const folder = path.join(root, "mention-plugins");
  fs.mkdirSync(path.join(folder, ".codex-plugin"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "notes", interface: { displayName: "Notes" } }));
  fs.mkdirSync(path.join(folder, "skills", "jot"), { recursive: true });
  fs.writeFileSync(path.join(folder, "skills", "jot", "SKILL.md"), "---\nname: jot\ndescription: Jot it down\n---\n");
  const { name } = await client.call("marketplace.add", { request_id: "m1", source: folder });
  await client.call("plugin.install", { request_id: "m2", id: `notes@${name}`, scope: "me" });
  const { events, send } = await workspace("mention");
  const typed = `[@Notes](plugin://notes@${name}) write it down`;
  await send(typed);
  await until(() => doneCount(events) === 1, 30_000);
  expect(texts(events, "user")).toEqual([typed]);
  expect(texts(events, "assistant")[0]).toContain("Capabilities from the `Notes` plugin:\n- Skills from this plugin are prefixed with `notes:`.");
  // A plugin that is not installed adds nothing.
  await send("[@Other](plugin://other@nowhere) hi");
  await until(() => doneCount(events) === 2, 30_000);
  expect(texts(events, "assistant")[1]).toBe("smoke ok: [@Other](plugin://other@nowhere) hi");
});

test("engine.commands: a Claude Agent chat lists its plugins' commands as /plugin:command", async () => {
  const folder = path.join(root, "command-plugins");
  fs.mkdirSync(path.join(folder, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "kit" }));
  fs.mkdirSync(path.join(folder, "commands", "git"), { recursive: true });
  fs.writeFileSync(path.join(folder, "commands", "hello.md"), "---\ndescription: Say hello\n---\nSay hello.\n");
  fs.writeFileSync(path.join(folder, "commands", "git", "commit.md"), "Commit it.\n");
  const { name } = await client.call("marketplace.add", { request_id: "pc1", source: folder });
  await client.call("plugin.install", { request_id: "pc2", id: `kit@${name}`, scope: "me" });
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "pc3", repo: { path: repo }, title: "plugin commands", engine: "claude-agent", options: { model: MODEL } });
  const { commands } = await client.call("engine.commands", { workspace_id: w.id });
  // Claude's names (verified on the CLI: probe-pl:git:commit), so a pick sent as typed is a command it has.
  expect(commands).toEqual(expect.arrayContaining([{ name: "kit:hello", description: "Say hello" }, { name: "kit:git:commit" }]));
  await client.call("plugin.uninstall", { request_id: "pc4", id: `kit@${name}`, scope: "me" });
  expect((await client.call("engine.commands", { workspace_id: w.id })).commands.some((c) => c.name.startsWith("kit:"))).toBe(false);
});

test("approvals wait side by side (the transcript pages through them)", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const w = await client.call("workspace.create", { request_id: "asks", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, access: "ask" } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "asks-1", session_id: w.session_id, kind: "followup", input: { text: "asks: 2 both" } });
  await until(() => events.filter((e) => e.type === "ask.user").length === 2);
  expect(events.some((e) => e.type === "ask.resolved")).toBe(false);
  const asks = events.filter((e) => e.type === "ask.user");
  await client.call("ask.respond", { request_id: "a2", session_id: w.session_id, ask_id: asks[1]!.item_id!, response: { kind: "approval", option_id: "decline" } });
  await client.call("ask.respond", { request_id: "a1", session_id: w.session_id, ask_id: asks[0]!.item_id!, response: { kind: "approval", option_id: "accept" } });
  await until(() => doneCount(events) === 1, 30_000);
  expect(texts(events, "assistant").at(-1)).toBe("smoke ok: allowed denied both");
});

test("Remote control is a setting", async () => {
  expect(await client.call("settings.set", { request_id: "rc", settings: { remote_control: true } })).toMatchObject({ remote_control: true });
  expect((await client.call("settings.get", {})).remote_control).toBe(true);
});

test("normalizeSkill gives a model's answer Claude's front matter", () => {
  expect(normalizeSkill("```markdown\n# Deploy the app\n\nRun make deploy.\n```", undefined).markdown).toBe(
    '---\nname: deploy-the-app\ndescription: "Run make deploy."\n---\n\n# Deploy the app\n\nRun make deploy.\n',
  );
  expect(normalizeSkill(SKILL, "My Skill").name).toBe("my-skill");
  // Two horizontal rules are not front matter: nothing is lost.
  const ruled = "# Deploy\n\nStep one\n\n---\n\nStep two\n\n---\n\nChecks: curl it.";
  expect(normalizeSkill(ruled, undefined)).toEqual({ name: "deploy", markdown: `---\nname: deploy\ndescription: "Step one"\n---\n\n${ruled}\n` });
  expect(normalizeSkill("---\n---\n", undefined).name).toBe("recorded-skill");
  expect(normalizeSkill("x", "a".repeat(80)).name).toHaveLength(64);
});

test("skill.save writes my skill, edits it in place, and writes into a plugin of a folder marketplace; skill.read reads only listed skills", async () => {
  const markdown = "---\nname: hub-made\ndescription: Made on the Plugins page.\n---\n\nSteps.\n";
  const saved = await client.call("skill.save", { request_id: "h1", scope: "me", name: "hub-made", markdown });
  expect(saved).toEqual({ name: "hub-made", path: path.join(fs.realpathSync(home), ".agents", "skills", "hub-made", "SKILL.md"), markdown });
  const edited = `${markdown}More steps.\n`;
  expect(await client.call("skill.save", { request_id: "h2", scope: "me", name: "hub-made", markdown: edited, path: saved.path })).toMatchObject({ path: saved.path });
  expect(await client.call("skill.read", { path: saved.path })).toEqual({ markdown: edited });
  // Only a listed skill of that scope can be changed in place, and only listed skills read.
  expect(await reason(client.call("skill.save", { request_id: "h3", scope: "me", name: "hub-made", markdown, path: "/etc/hosts" }))).toBe("not_found");
  expect(await reason(client.call("skill.read", { path: "/etc/hosts" }))).toBe("not_found");
  // A new skill's name must still be a slug.
  expect(await reason(client.call("skill.save", { request_id: "h4", scope: "me", name: "Hub Made", markdown }))).toBe("invalid_params");
  // A plugin of a folder marketplace takes it in its own skills/; a pinned git one is read-only.
  const folder = path.join(root, "my-plugins");
  fs.mkdirSync(path.join(folder, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(folder, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "notes" }));
  const added = await client.call("marketplace.add", { request_id: "h5", source: folder });
  const inPlugin = await client.call("skill.save", { request_id: "h6", scope: "plugin", plugin_id: `notes@${added.name}`, name: "jot", markdown });
  expect(inPlugin.path).toBe(path.join(fs.realpathSync(folder), "skills", "jot", "SKILL.md"));
  expect(await reason(client.call("skill.save", { request_id: "h7", scope: "plugin", plugin_id: "kit@kit", name: "jot", markdown }))).toBe("invalid_state");
});

test("By task: a ready kind's pin takes the chat; a login that can't run, or an engine without grill mode under Grill, leaves the page's choice", () => {
  const ready = (instanceId: string, slugs: ReadonlyArray<string>, extra: object = {}) =>
    ({
      instanceId,
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: slugs.map((slug) => ({ slug })),
      ...extra,
    }) as never;
  const page = { request_id: "r", repo: { path: "/x" }, engine: "claude-agent", task: { text: "fix the button css" }, options: { model: "claude-opus-5-5", effort: "max", speed: "fast", account_id: "claudeAgent" } } as const;
  const sonnet = { engine: "claude-agent", instance_id: "claudeAgent:work", model: "claude-sonnet-5-5", effort: "high" } as const;
  // The pin's engine, model, effort and login in place of the page's; the page's speed (another model's) goes.
  expect(byTaskStart(page, sonnet, ready("claudeAgent", ["claude-sonnet-5-5"]), Date.now())).toEqual({
    ...page,
    engine: "claude-agent",
    options: { model: "claude-sonnet-5-5", account_id: "claudeAgent:work", effort: "high" },
  });
  // Signed out, or the model gone: the page's choice stands.
  expect(byTaskStart(page, sonnet, ready("claudeAgent", ["claude-sonnet-5-5"], { auth: { status: "unauthenticated" } }), Date.now())).toBeUndefined();
  expect(byTaskStart(page, sonnet, ready("claudeAgent", ["claude-opus-5-5"]), Date.now())).toBeUndefined();
  expect(byTaskStart(page, sonnet, undefined, Date.now())).toBeUndefined();
  // Grill on the page: a pin whose engine has no grill mode would refuse the chat, so it leaves the page's.
  const grill = { ...page, options: { ...page.options, mode: "grill" } } as const;
  const gemini = { engine: "acp:gemini", instance_id: "acp:gemini", model: "gemini-3" } as const;
  expect(byTaskStart(grill, gemini, ready("acp:gemini", ["gemini-3"]), Date.now())).toBeUndefined();
  expect(byTaskStart(grill, sonnet, ready("claudeAgent", ["claude-sonnet-5-5"]), Date.now())?.options?.mode).toBe("grill");
});
