// The real Session Protocol socket -> T3 v2 dispatcher -> SDK/CLI boundary.
// Scripted CLIs make handoff contents and queue timing independently observable.
import * as fs from "node:fs";
import { ThreadId } from "@caveman-app/protocol";
import { connect, type Params, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { createReady, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let n = 0;
const OTHER = "claude-opus-4-6";
const TARGET = "target-model";
const snapshots = Layer.succeed(ProviderRegistry.ProviderRegistry, {
  getProviders: Effect.succeed([
    { instanceId: "claudeAgent", installed: true, auth: { status: "authenticated" }, models: [MODEL, OTHER].map((slug) => ({ slug, name: slug, isDefault: slug === MODEL })) },
    { instanceId: "codex", installed: true, auth: { status: "authenticated" }, models: [{ slug: TARGET, name: TARGET, isDefault: true }] },
  ]),
} as unknown as ProviderRegistry.ProviderRegistry["Service"]);
beforeAll(async () => {
  root = tempRoot("sp-harness-switch-");
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { alsoAs: ["codex", "gemini"], provide: snapshots });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function chat() {
  const w = await createReady(client, { request_id: `create-${++n}`, repo: { path: makeRepo(root, { "README.md": "same checkout\n" }) }, engine: "claude-agent", options: { model: MODEL } });
  const events: SessionEvent[] = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const send = (text: string, options?: Params<"turn.submit">["options"], kind: "followup" | "steer" | "queue" = "followup") =>
    client.call("turn.submit", { request_id: `send-${++n}`, session_id: w.session_id, kind, input: { text }, ...(options ? { options } : {}) });
  const done = (count: number) => until(() => events.filter((e) => e.type === "turn.done").length === count, 30_000);
  const projection = () => Effect.runPromise(orchestratorOf(runtime).getThreadProjection(ThreadId.make(`caveman:${w.id}`)));
  return { w, events, send, done, projection };
}

test("models and harnesses switch A -> B -> A within one session, with handoff context and sticky engine state", async () => {
  const { w, events, send, done, projection } = await chat();
  await send("remember the parser decision");
  await done(1);
  await send("same harness, another model", { model: OTHER });
  await done(2);
  await send("continue on Codex", { engine: "codex", model: TARGET });
  await done(3);
  const switched = await client.call("workspace.get", { workspace_id: w.id });
  expect(switched).toMatchObject({ id: w.id, session_id: w.session_id, engine: "codex", branch: w.branch, root_path: w.root_path });
  expect((await client.call("session.attach", { session_id: w.session_id, cursor: events.at(-1)!.cursor })).session.engine).toBe("codex");
  await send("stay on Codex");
  await done(4);
  await send("back to Claude", { engine: "claude-agent", model: MODEL });
  await done(5);
  expect(events.filter((e) => e.type === "turn.started").map((e) => [e.payload.engine, e.payload.model])).toEqual([
    ["claude-agent", MODEL], ["claude-agent", OTHER], ["codex", TARGET], ["codex", TARGET], ["claude-agent", MODEL],
  ]);
  const replies = events.flatMap((e) => e.type === "message.done" && e.payload.role === "assistant" ? [e.payload.text] : []);
  expect(replies[2]).toContain("Context handoff");
  expect(replies[2]).toContain("remember the parser decision");
  expect(replies[2]).toMatch(/User message:\ncontinue on Codex$/);
  expect(replies[4]).toContain("stay on Codex");
  expect(replies[4]).toMatch(/User message:\nback to Claude$/);
  const p = await projection();
  expect(p.runs).toHaveLength(5);
  expect(p.runs.every((r) => r.status === "completed")).toBe(true);
  expect(new Set(p.providerThreads.map((t) => t.appThreadId))).toEqual(new Set([`caveman:${w.id}`]));
  expect((await client.call("workspace.get", { workspace_id: w.id })).engine).toBe("claude-agent");
}, 90_000);

test("a switch without a model takes the target harness default, never the source model", async () => {
  const { events, send, done } = await chat();
  await send("hello");
  await done(1);
  await send("target default", { engine: "codex" });
  await done(2);
  expect(events.filter((e) => e.type === "turn.started").at(-1)!.payload).toMatchObject({ engine: "codex", model: TARGET });
}, 60_000);

test("a requested cross-harness steer queues, leaves the running turn intact, then switches in place", async () => {
  const { w, events, send, done, projection } = await chat();
  await send("slow: finish the original work");
  await until(() => events.some((e) => e.type === "turn.started"));
  const result = await send("then use Codex", { engine: "codex", model: TARGET }, "steer");
  expect(result.disposition).toBe("queued");
  expect((await client.call("workspace.get", { workspace_id: w.id })).engine).toBe("claude-agent");
  expect((await projection()).runs.find((r) => r.status === "running")!.modelSelection.instanceId).toBe("claudeAgent");
  await done(2);
  expect(events.filter((e) => e.type === "turn.started").map((e) => e.payload.engine)).toEqual(["claude-agent", "codex"]);
  expect((await client.call("workspace.get", { workspace_id: w.id })).engine).toBe("codex");
}, 60_000);

test("a model-changing steer also queues instead of restarting the running harness", async () => {
  const { events, send, done } = await chat();
  await send("slow: original model work");
  await until(() => events.some((e) => e.type === "turn.started"));
  expect((await send("next model", { model: OTHER }, "steer")).disposition).toBe("queued");
  await done(2);
  expect(events.filter((e) => e.type === "turn.started").map((e) => e.payload.model)).toEqual([MODEL, OTHER]);
  expect(events.filter((e) => e.type === "turn.done").map((e) => e.payload.status)).toEqual(["completed", "completed"]);
}, 60_000);

test("prewarming another harness does not change the engine, selection, or provider conversations", async () => {
  const { w, send, done, projection } = await chat();
  await send("warm original");
  await done(1);
  const before = await projection();
  await client.call("turn.prewarm", { request_id: `warm-${++n}`, session_id: w.session_id, options: { engine: "codex", model: TARGET } });
  const after = await projection();
  expect(after.thread.modelSelection).toEqual(before.thread.modelSelection);
  expect(after.providerThreads).toEqual(before.providerThreads);
  expect((await client.call("workspace.get", { workspace_id: w.id })).engine).toBe("claude-agent");
});

test("an unavailable harness or invalid effort is refused without changing the session", async () => {
  const { w, send, projection } = await chat();
  await expect(send("no", { engine: "muse", model: "missing" })).rejects.toMatchObject({ error: { data: { reason: "engine_unavailable" } } });
  await expect(send("no", { engine: "codex", model: TARGET, effort: "impossible" })).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
  expect((await projection()).runs).toHaveLength(0);
  expect((await client.call("workspace.get", { workspace_id: w.id })).engine).toBe("claude-agent");
});
