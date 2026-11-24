// Permissions (upstream runtime modes): a new chat takes its project's
// default, else Settings.default_access, else full access; an explicit pick
// wins; a turn's pick changes the thread's mode and Session.access follows.
import * as fs from "node:fs";

import { ThreadId } from "@caveman-app/protocol";
import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, orchestratorOf, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let n = 0;

beforeAll(async () => {
  root = tempRoot("sp-access-");
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const runtimeModeOf = async (workspaceId: string) => {
  const orchestrator = orchestratorOf(runtime);
  return (await Effect.runPromise(orchestrator.getThreadProjection(ThreadId.make(`caveman:${workspaceId}`)))).thread.runtimeMode;
};
const sessionAccess = async (sessionId: string) => {
  const attached = await client.attach(sessionId, 0, () => undefined);
  await attached.detach();
  return attached.session.access;
};
const create = (repo: string, access?: "ask" | "auto" | "review" | "full") =>
  createReady(client, { request_id: `w${++n}`, repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, ...(access ? { access } : {}) } });

test("a new chat runs with full access when nothing says otherwise", async () => {
  const w = await create(makeRepo(root, { "README.md": "a\n" }));
  expect(await runtimeModeOf(w.id)).toBe("full-access");
  expect(await sessionAccess(w.session_id)).toBe("full");
});

test("the environment default, then a project's own, decide a new chat's permissions; an explicit pick wins", async () => {
  const repo = makeRepo(root, { "README.md": "b\n" });
  expect((await client.call("settings.set", { request_id: "s1", settings: { default_access: "ask" } })).default_access).toBe("ask");
  const first = await create(repo);
  expect(await runtimeModeOf(first.id)).toBe("approval-required");

  const project = (await client.call("project.update", { request_id: "p1", project_id: first.project_id!, default_access: "review" }));
  expect(project.default_access).toBe("review");
  const second = await create(repo);
  expect(await runtimeModeOf(second.id)).toBe("auto");
  expect(await sessionAccess(second.session_id)).toBe("review");

  const picked = await create(repo, "auto");
  expect(await runtimeModeOf(picked.id)).toBe("auto-accept-edits");

  const cleared = await client.call("project.update", { request_id: "p2", project_id: first.project_id!, default_access: null });
  expect(cleared.default_access).toBeUndefined();
  const third = await create(repo);
  expect(await runtimeModeOf(third.id)).toBe("approval-required");
  await client.call("settings.set", { request_id: "s2", settings: { default_access: "full" } });
});

test("a turn's pick changes that chat's permissions, and the session reports them", async () => {
  const w = await create(makeRepo(root, { "README.md": "c\n" }), "full");
  await client.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text: "hello" }, options: { access: "ask" } });
  await until(async () => (await runtimeModeOf(w.id)) === "approval-required");
  await until(async () => (await sessionAccess(w.session_id)) === "ask");
});

test("a steer that changes access is its own turn: the running turn keeps the access it started with", async () => {
  const w = await create(makeRepo(root, { "README.md": "d\n" }), "full");
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const running = await client.call("turn.submit", { request_id: "ts1", session_id: w.session_id, kind: "followup", input: { text: "slow: one" } });
  await until(() => events.some((e) => e.type === "turn.started"));
  const steered = await client.call("turn.submit", { request_id: "ts2", session_id: w.session_id, kind: "steer", input: { text: "only read the config, don't change it" }, options: { access: "ask" } });
  expect(steered.disposition).toBe("queued");
  await until(() => events.filter((e) => e.type === "turn.done").length === 2, 30_000);
  const started = events.flatMap((e) => (e.type === "turn.started" ? [[e.turn_id, e.payload.access]] : []));
  expect(started).toEqual([[running.turn_id, "full"], [steered.turn_id, "ask"]]);
});

test("every steer after an access change during a turn waits for its own turn: that turn keeps the access it started with until it ends", async () => {
  const w = await create(makeRepo(root, { "README.md": "e\n" }), "full");
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  const running = await client.call("turn.submit", { request_id: "tm1", session_id: w.session_id, kind: "followup", input: { text: "slow 8000: one" } });
  await until(() => events.some((e) => e.type === "turn.started"));
  // The composer keeps the access picked for the next message, so a second Enter sends it again; a steer without one
  // takes the chat's, which is Ask by now.
  const steers = [{ access: "ask" as const }, { access: "ask" as const }, undefined];
  const sent = [];
  for (const [i, options] of steers.entries()) {
    sent.push(await client.call("turn.submit", { request_id: `tm${i + 2}`, session_id: w.session_id, kind: "steer", input: { text: `only read, ${i}` }, ...(options ? { options } : {}) }));
  }
  expect(sent.map((s) => s.disposition)).toEqual(["queued", "queued", "queued"]);
  await until(() => events.filter((e) => e.type === "turn.done").length === 4, 60_000);
  const access = new Map(events.flatMap((e) => (e.type === "turn.started" ? [[e.turn_id, e.payload.access] as const] : [])));
  expect([running, ...sent].map((s) => access.get(s.turn_id))).toEqual(["full", "ask", "ask", "ask"]);
}, 90_000);
