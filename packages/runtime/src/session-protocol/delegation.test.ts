// delegate_task children as first-class workspaces: an agent's delegation (driven here through upstream
// orchestrator, as the caveman-code MCP tool does) gets a workspace nested under its lead, with its own
// session, asks and transcript; the lead's transcript points at it; Stop on the lead stops it.
// Real Claude adapter and SDK on scripts/smoke-claude.mjs.
import * as fs from "node:fs";
import * as path from "node:path";

import { CommandId, ThreadId } from "@caveman-app/protocol";
import { connect, type SessionEvent, type SubagentRunner, type Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SubagentAuto } from "../router/subagentAuto.ts";
import { delegateFrom, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "./testHarness.ts";

// delegate_task's Auto (router/subagentAuto.ts), faked: the runner a delegation recorded, and the outcomes reported.
const recorded = new Map<string, SubagentRunner>();
const finished: Array<[string, string]> = [];
const fakeAuto = Layer.succeed(
  SubagentAuto,
  SubagentAuto.of({
    connected: Effect.succeed({ key: undefined, caveman: undefined }),
    ask: () => Effect.die("unused"),
    remember: (commandId, runner) => Effect.sync(() => void recorded.set(commandId, runner)),
    adopt: (commandId) => Effect.sync(() => recorded.get(commandId)),
    finish: (threadId, kind) => Effect.sync(() => void finished.push([threadId, kind])),
  }),
);

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let orchestrator: Orchestrator.OrchestratorV2["Service"];
const hold = process.env.SMOKE_CLAUDE_HOLD_MS;

beforeAll(async () => {
  // The lead's turn must outlive the child's start.
  process.env.SMOKE_CLAUDE_HOLD_MS = "15000";
  root = tempRoot("sp-delegation-");
 // upstream settings, where delegate_task's limits live, for settings.subagent_*.
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: Layer.mergeAll(ServerSettings.layerTest().pipe(Layer.orDie), fakeAuto) });
  client = connect(runtime.url, runtime.token);
  orchestrator = orchestratorOf(runtime);
});
afterAll(async () => {
  if (hold === undefined) delete process.env.SMOKE_CLAUDE_HOLD_MS;
  else process.env.SMOKE_CLAUDE_HOLD_MS = hold;
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("a delegated child is a workspace under its lead, linked from the lead's transcript, and Stop on the lead stops it", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await client.call("workspace.create", { request_id: "lead", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "slow: lead" } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));
  await until(() => leadEvents.some((e) => e.type === "turn.started"));
  await delegateFrom(orchestrator, lead, "slow: child work", "Child");
  let child: Workspace | undefined;
  await until(async () => {
    child = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0];
    return child !== undefined;
  });
  expect(child).toMatchObject({ parent_workspace_id: lead.id, title: "Child", engine: "claude-agent", repo: lead.repo, project_id: lead.project_id });
  // The lead's transcript names the child's workspace.
  await until(() => leadEvents.some((e) => e.type === "subagent.started"));
  expect(leadEvents.find((e) => e.type === "subagent.started")?.payload).toMatchObject({ title: "Child", agent: "claude-agent", workspace_id: child!.id });

  // The child opens as a chat: its brief from the lead, then its own turn.
  const childEvents: Array<SessionEvent> = [];
  await client.attach(child!.session_id, 0, (e) => childEvents.push(e));
  await until(() => childEvents.some((e) => e.type === "message.done" && e.payload.role === "user"));
  expect(childEvents.find((e) => e.type === "message.done" && e.payload.role === "user")?.payload).toMatchObject({ text: "slow: child work", from: { workspace_id: lead.id } });
  await until(async () => (await client.call("workspace.get", { workspace_id: child!.id })).status === "working");
  // It answered and is still holding its turn open (the stand-in CLI's "slow:").
  await until(() => childEvents.some((e) => e.type === "message.done" && e.payload.role === "assistant"));

  // Stop on the lead: the lead's turn and the child's both end interrupted; the child's transcript stays.
  await client.call("turn.interrupt", { request_id: "stop", session_id: lead.session_id });
  await until(() => leadEvents.some((e) => e.type === "turn.done"), 30_000);
  await until(() => childEvents.some((e) => e.type === "turn.done"), 30_000);
  expect(childEvents.find((e) => e.type === "turn.done")?.payload).toMatchObject({ status: "interrupted" });
  expect(childEvents.find((e) => e.type === "message.done" && e.payload.role === "assistant")?.payload).toMatchObject({ text: "smoke ok: child work" });

  // Renaming the child's thread (an agent's thread_update) reaches its workspace.
  const childThread = await Effect.runPromise(orchestrator.getThreadShell(ThreadId.make(`${(await Effect.runPromise(orchestrator.getThreadProjection(ThreadId.make(`caveman:${lead.id}`)))).subagents[0]!.childThreadId}`)));
  await Effect.runPromise(orchestrator.dispatch({ type: "thread.metadata.update", commandId: CommandId.make("test-rename"), threadId: childThread!.id, title: "Renamed child" }));
  await until(async () => (await client.call("workspace.get", { workspace_id: child!.id })).title === "Renamed child");

  // Archiving the child leaves the lead's checkout alone.
  await client.call("workspace.archive", { request_id: "archive-child", workspace_id: child!.id });
  expect(fs.existsSync(lead.root_path!)).toBe(true);
}, 90_000);

test("Stop on a lead whose turn ended stops its running agent, and the stopped agent does not wake the lead", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  // The lead's turn ends while its agent still works.
  const lead = await client.call("workspace.create", { request_id: "idle-lead", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "slow 2000: lead" } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));
  await until(() => leadEvents.some((e) => e.type === "turn.started"));
  await delegateFrom(orchestrator, lead, "slow 60000: async work", "Async");
  let child: Workspace | undefined;
  await until(async () => {
    child = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0];
    return child !== undefined;
  });
  const childEvents: Array<SessionEvent> = [];
  await client.attach(child!.session_id, 0, (e) => childEvents.push(e));
  await until(() => childEvents.some((e) => e.type === "message.done" && e.payload.role === "assistant"));
  await until(() => leadEvents.some((e) => e.type === "turn.done"), 30_000);
  expect(childEvents.some((e) => e.type === "turn.done")).toBe(false);
  // Its turn ended, but it waits on its agent: at work, not finished (Workspace.activity.awaiting).
  const leadOf = () => client.call("workspace.get", { workspace_id: lead.id });
  await until(async () => (await leadOf()).status === "idle");
  const waiting = await leadOf();
  expect(waiting.activity).toMatchObject({ last_outcome: "completed", awaiting: true });

  const startedBefore = leadEvents.filter((e) => e.type === "turn.started").length;
  await client.call("turn.interrupt", { request_id: "stop-idle", session_id: lead.session_id });
  await until(() => childEvents.some((e) => e.type === "turn.done"), 30_000);
  expect(childEvents.find((e) => e.type === "turn.done")?.payload).toMatchObject({ status: "interrupted" });
  // No completion wake is left to deliver: the lead's cohort is disposed as stopped, and no lead turn starts.
  await new Promise((r) => setTimeout(r, 2_000));
  const leadThread = await Effect.runPromise(orchestrator.getThreadProjection(ThreadId.make(`caveman:${lead.id}`)));
  expect(leadThread.subagents[0]?.completionDelivery?.state).toBe("disposed");
  expect(leadThread.runs.map((r) => r.delegatedCompletion?.disposition)).toEqual(["stopped"]);
  expect(leadEvents.filter((e) => e.type === "turn.started").length).toBe(startedBefore);
  // Its agent ended: nothing is left that would wake it.
  await until(async () => (await leadOf()).activity?.awaiting === undefined);
  expect((await leadOf()).updated_at).toBe(waiting.updated_at);
}, 90_000);

test("Undo on a lead's turn refuses while its agent still works in the same checkout, and goes ahead once it is stopped", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await client.call("workspace.create", { request_id: "undo-lead", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "write: lead.md lead\nhold 8000" } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));
  await until(() => leadEvents.some((e) => e.type === "turn.started"));
  // No isolation: the agent works in its lead's checkout, writes there during the lead's turn, and keeps working after it.
  await delegateFrom(orchestrator, lead, "write: child.md child work\nhold 60000", "Sharer");
  let child: Workspace | undefined;
  await until(async () => {
    child = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0];
    return child !== undefined;
  });
  expect(child!.root_path).toBe(lead.root_path);
  const childEvents: Array<SessionEvent> = [];
  await client.attach(child!.session_id, 0, (e) => childEvents.push(e));
  await until(() => fs.existsSync(path.join(lead.root_path!, "child.md")), 30_000);
  await until(() => leadEvents.some((e) => e.type === "turn.done") && leadEvents.some((e) => e.type === "checkpoint.created"), 30_000);
  const card = leadEvents.flatMap((e) => (e.type === "checkpoint.created" ? [e.payload] : [])).at(-1)!;
  expect(card.files?.map((f) => f.path).toSorted()).toEqual(["child.md", "lead.md"]);
  expect(childEvents.some((e) => e.type === "turn.done")).toBe(false);

  const undo = (id: string) =>
    client.call("checkpoint.undo", { request_id: id, session_id: lead.session_id, checkpoint_id: card.checkpoint_id }).then(
      (result) => `ok: ${result.files.toSorted().join(", ")}`,
      (error: { error?: { message?: string; data?: { reason?: string } } }) => `${error.error?.data?.reason}: ${error.error?.message}`,
    );
  expect(await undo("undo-under-agent")).toMatch(/^invalid_state: .*still working in this checkout/);
  expect(fs.readFileSync(path.join(lead.root_path!, "child.md"), "utf8")).toContain("child work");
  expect(fs.existsSync(path.join(lead.root_path!, "lead.md"))).toBe(true);

  // Stop on the lead stops its agent (and no wake starts a lead turn): the turn's changes can go.
  await client.call("turn.interrupt", { request_id: "undo-stop", session_id: lead.session_id });
  await until(() => childEvents.some((e) => e.type === "turn.done"), 30_000);
  expect(await undo("undo-after-stop")).toBe("ok: child.md, lead.md");
  expect(fs.existsSync(path.join(lead.root_path!, "child.md"))).toBe(false);
  expect(fs.existsSync(path.join(lead.root_path!, "lead.md"))).toBe(false);
}, 90_000);

test("a lead and the agent in its checkout, archived together (Tidy) and restored lead first (its Undo): the agent comes back into the lead's checkout as it is now", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await client.call("workspace.create", { request_id: "back-lead", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "slow 2000: lead" } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));
  await until(() => leadEvents.some((e) => e.type === "turn.started"));
  await delegateFrom(orchestrator, lead, "write: child.md child work", "Back");
  let child: Workspace | undefined;
  await until(async () => {
    child = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0];
    return child !== undefined;
  });
  expect(child!.root_path).toBe(lead.root_path);
  const childEvents: Array<SessionEvent> = [];
  await client.attach(child!.session_id, 0, (e) => childEvents.push(e));
  await until(() => childEvents.some((e) => e.type === "turn.done"), 30_000);
  expect(fs.readFileSync(path.join(lead.root_path!, "child.md"), "utf8")).toContain("child work");

  await client.call("workspace.archive", { request_id: "back-archive-lead", workspace_id: lead.id });
  await client.call("workspace.archive", { request_id: "back-archive-child", workspace_id: child!.id });
  expect(fs.existsSync(lead.root_path!)).toBe(false);
  // The agent alone waits for its lead: the checkout it worked in comes back with the lead.
  const early = await client.call("workspace.restore", { request_id: "back-child-early", workspace_id: child!.id }).then(
    () => "restored",
    (error: { error?: { message?: string; data?: { reason?: string } } }) => `${error.error?.data?.reason}: ${error.error?.message}`,
  );
  expect(early).toMatch(/^invalid_state: This agent worked in its lead's checkout: restore .* first/);

  const back = await client.call("workspace.restore", { request_id: "back-lead-restore", workspace_id: lead.id });
  const agent = await client.call("workspace.restore", { request_id: "back-child-restore", workspace_id: child!.id });
  expect(agent).toMatchObject({ status: "idle", branch: back.branch, root_path: back.root_path });
  // Its work came back with the lead's checkout, and it takes turns there again.
  expect(fs.readFileSync(path.join(back.root_path!, "child.md"), "utf8")).toContain("child work");
  expect((await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces.map((w) => w.id)).toEqual([child!.id]);
}, 90_000);

test("a delegated child's spend and diff are its own workspace's, where Settings > Usage reads them", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await client.call("workspace.create", { request_id: "spend-lead", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "slow 4000: lead" } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));
  await until(() => leadEvents.some((e) => e.type === "turn.started"));
  await delegateFrom(orchestrator, lead, "write: child.txt from the child", "Writer");
  let child: Workspace | undefined;
  await until(async () => {
    child = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0];
    return child !== undefined;
  });
  const childEvents: Array<SessionEvent> = [];
  await client.attach(child!.session_id, 0, (e) => childEvents.push(e));
  await until(() => childEvents.some((e) => e.type === "turn.done"), 30_000);
  // The diff panel and a row's peek read the child's own diff.changed.
  const files = childEvents.flatMap((e) => (e.type === "diff.changed" ? e.payload.files : []));
  expect(files).toContainEqual(expect.objectContaining({ path: "child.txt", status: "added" }));
  // spend.summary (Settings > Usage) has a row for the child's workspace, apart from its lead's.
  const rows = (await client.call("spend.summary", { group_by: "workspace" })).rows;
  expect(rows.find((r) => r.key === child!.id)).toMatchObject({ label: "Writer" });
  expect(rows.find((r) => r.key === child!.id)!.input_tokens).toBeGreaterThan(0);
}, 90_000);

test("workspace.rename renames the chat and its engine thread; agent.types lists project, user and built-in types; Settings > Subagents limits round-trip", async () => {
  const repo = makeRepo(root, { "README.md": "hi\n", ".claude/agents/db.md": "---\nname: db\ndescription: Migrations only\nmodel: haiku\n---\nTouch db/ only.\n" });
  const w = await client.call("workspace.create", { request_id: "rename-me", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, title: "Old name" });
  const renamed = await client.call("workspace.rename", { request_id: "rename-1", workspace_id: w.id, title: "  New   name " });
  expect(renamed.title).toBe("New name");
  expect((await Effect.runPromise(orchestrator.getThreadShell(ThreadId.make(`caveman:${w.id}`))))?.title).toBe("New name");
  expect((await client.call("workspace.get", { workspace_id: w.id })).title).toBe("New name");

  const all = await client.call("agent.types", {});
  expect(all.types.map((t) => [t.name, t.source])).toEqual([
    ["investigator", "builtin"],
    ["builder", "builtin"],
    ["reviewer", "builtin"],
    ["tester", "builtin"],
    ["scout", "builtin"],
  ]);
  expect(all.types.find((t) => t.name === "reviewer")?.decides).toEqual(["approve", "request_changes"]);
  const inProject = await client.call("agent.types", { project_id: w.project_id! });
  expect(inProject.types[0]).toEqual({ name: "db", description: "Migrations only", source: "project", model: "haiku", path: ".claude/agents/db.md" });

  expect(await client.call("settings.get", {})).toMatchObject({ subagent_max_depth: 2, subagent_max_concurrent: 8, subagent_default_model: "auto", subagent_tree_token_ceiling: 5_000_000 });
  const next = await client.call("settings.set", { request_id: "agents-1", settings: { subagent_max_depth: 1, subagent_default_model: "inherit" } });
  expect(next).toMatchObject({ subagent_max_depth: 1, subagent_max_concurrent: 8, subagent_default_model: "inherit" });
  expect(await client.call("settings.get", {})).toMatchObject({ subagent_max_depth: 1, subagent_default_model: "inherit" });
});

test.each([undefined, "not_paying", "cloud_unlinked", "cloud_error", "quota"] as const)("a delegated child carries its runner and Auto fallback (%s) through the session protocol", async (fallback) => {
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const lead = await client.call("workspace.create", { request_id: `runner-lead-${fallback ?? "auto"}`, repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "slow 4000: lead" } });
  const leadEvents: Array<SessionEvent> = [];
  await client.attach(lead.session_id, 0, (e) => leadEvents.push(e));
  await until(() => leadEvents.some((e) => e.type === "turn.started"));
  const runner: SubagentRunner = { engine: "claude-agent", instance_id: "claudeAgent", model: MODEL, effort: "high", pick: { by: fallback === undefined ? "auto" : "default", kind: "review", ...(fallback === undefined ? {} : { fallback }) } };
  const title = `Runner ${fallback ?? "auto"}`;
  recorded.set(`test-delegate:${title}`, runner);
  await delegateFrom(orchestrator, lead, "child work", title);
  let child: Workspace | undefined;
  await until(async () => {
    child = (await client.call("workspace.list", { parent_workspace_id: lead.id })).workspaces[0];
    return child !== undefined;
  });
  expect(child!.runner).toEqual(runner);
  await until(() => leadEvents.some((e) => e.type === "subagent.started"));
  expect(leadEvents.find((e) => e.type === "subagent.started")?.payload).toMatchObject({ workspace_id: child!.id, runner });
  // The child's task ends: its outcome is reported once per terminal item (the service posts only the first).
  const childThreadId = (await Effect.runPromise(orchestrator.getThreadProjection(ThreadId.make(`caveman:${lead.id}`)))).subagents[0]!.childThreadId!;
  await until(() => finished.some(([threadId]) => threadId === childThreadId), 30_000);
  expect(finished.find(([threadId]) => threadId === childThreadId)).toEqual([childThreadId, "completed"]);
}, 90_000);

test("a role pin names the account the person picked (Claude's one login, a Caveman key) and replaces the role's last pin whole", async () => {
  const set = (pins: object) => client.call("settings.set", { request_id: `pins-${JSON.stringify(pins)}`, settings: { subagent_role_pins: pins } });
  await set({ review: { engine: "claude-agent", instance_id: "claudeAgent:default", model: "claude-opus-5-5", effort: "xhigh" }, research: { engine: "caveman", instance_id: "caveman:openai", model: "openai/gpt-6.1-sol" } });
  expect((await client.call("settings.get", {})).subagent_role_pins).toEqual({
    review: { engine: "claude-agent", instance_id: "claudeAgent:default", model: "claude-opus-5-5", effort: "xhigh" },
    research: { engine: "caveman", instance_id: "caveman:openai", model: "openai/gpt-6.1-sol" },
  });
  // Re-pinned to a model with no effort: the old effort does not carry over. null clears a role.
  await set({ review: { engine: "cursor", instance_id: "cursor", model: "composer-2" }, research: null });
  expect((await client.call("settings.get", {})).subagent_role_pins).toEqual({ review: { engine: "cursor", instance_id: "cursor", model: "composer-2" } });
  await set({ review: null });
});

test("a task kind's pin keeps Always, is replaced whole, and lives beside the role pins", async () => {
  const set = (pins: object) => client.call("settings.set", { request_id: `tasks-${JSON.stringify(pins)}`, settings: { subagent_task_pins: pins } });
  await set({ frontend_ui: { engine: "claude-agent", instance_id: "claudeAgent:default", model: "claude-opus-5-5", effort: "high", always: true } });
  expect((await client.call("settings.get", {})).subagent_task_pins).toEqual({
    frontend_ui: { engine: "claude-agent", instance_id: "claudeAgent:default", model: "claude-opus-5-5", effort: "high", always: true },
  });
  // Back to Prefer on another model: neither the effort nor Always carries over.
  await set({ frontend_ui: { engine: "cursor", instance_id: "cursor", model: "composer-2" } });
  expect((await client.call("settings.get", {})).subagent_task_pins).toEqual({ frontend_ui: { engine: "cursor", instance_id: "cursor", model: "composer-2" } });
  expect((await client.call("settings.get", {})).subagent_role_pins).toEqual({});
  await set({ frontend_ui: null });
  expect((await client.call("settings.get", {})).subagent_task_pins).toEqual({});
});
