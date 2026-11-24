import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import type { SessionEvent } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { CloudComputer } from "../cloudLink/computers.ts";
import type { Identity } from "../cloudLink/identity.ts";
import { builderBranch, makeBuilderRoute, NO_SUCH_COMPUTER, NOT_A_LEAD, resultOf, type BuilderError, type BuilderRouteDeps, type BuilderStart, type BuilderStarted } from "./builders.ts";
import type { SessionStore, WorkspaceRecord } from "./store.ts";

test("a builder's branch is named as a chat's, the same for a retry of one delegation and apart for another", () => {
  expect(builderBranch("Part one: the API", "k1")).toMatch(/^caveman\/part-one-the-api-[0-9a-f]{6}$/);
  expect(builderBranch("Part one: the API", "k1")).toBe(builderBranch("Part one: the API", "k1"));
  expect(builderBranch("Part one: the API", "k2")).not.toBe(builderBranch("Part one: the API", "k1"));
  expect(builderBranch("???", "k1")).toMatch(/^caveman\/builder-/);
});

test("what a lead reads of a builder's turn: how it ended and its last answer", () => {
  const at = "2026-10-21T00:00:00Z";
  const events = [
    { cursor: 1, at, type: "message.done", payload: { role: "assistant", text: "first" } },
    { cursor: 2, at, type: "turn.done", payload: { status: "completed" } },
    { cursor: 3, at, type: "message.done", payload: { role: "assistant", text: "second" } },
    { cursor: 4, at, type: "turn.done", payload: { status: "failed", error: "rate limited" } },
  ] as unknown as ReadonlyArray<SessionEvent>;
  expect(resultOf(events, 2)).toEqual({ status: "completed", text: "first" });
  expect(resultOf(events, 4)).toEqual({ status: "failed", text: "second" });
  expect(resultOf(events.slice(3), 4)).toEqual({ status: "failed", text: "It stopped: rate limited" });
  const long = [{ cursor: 1, at, type: "message.done", payload: { role: "assistant", text: "x".repeat(20_000) } }] as unknown as ReadonlyArray<SessionEvent>;
  expect(resultOf(long, 1).text).toMatch(/\[cut: the builder's full answer is in its chat\]$/);
});

/** A workspace record as daemon.ts adopts it: an automation's run or step (delegated, no parent), or a lead's builder. */
const recordOf = (threadId: string, over: { readonly parent?: string; readonly delegated?: true; readonly step?: true }) =>
  ({
    workspace: {
      id: `ws-${threadId}`,
      title: threadId,
      repo: { path: "/workspace" },
      base_ref: "HEAD",
      branch: "HEAD",
      engine: "claude-agent",
      computer: "this-mac",
      session_id: `s-${threadId}`,
      status: "idle",
      root_path: "/workspace",
      project_id: "p1",
      ...(over.parent === undefined ? {} : { parent_workspace_id: over.parent }),
      ...(over.step ? { automation: { name: "nightly", run_id: "run-1", step: "build", attempt: 1 } } : {}),
      created_at: "2026-11-06T00:00:00Z",
      updated_at: "2026-11-06T00:00:00Z",
    },
    session: { id: `s-${threadId}`, workspace_id: `ws-${threadId}`, engine: "claude-agent", state: "live", head: 0, created_at: "2026-11-06T00:00:00Z", updated_at: "2026-11-06T00:00:00Z" },
    internal: {
      threadId,
      worktreePath: "/workspace",
      repoPath: "/workspace",
      setup: "none",
      ...(over.delegated ? { delegated: true } : {}),
      ...(over.step ? { automation: { automation: "nightly", run: "run-1", step: "build", attempt: 1 } } : {}),
    },
  }) as unknown as WorkspaceRecord;

/** These tests start and message builders; none finishes, so nothing is merged (the integration step has tests of its own). */
const NO_INTEGRATION = {
  git: () => () => Effect.die("no git here"),
  fetchBranch: () => Effect.succeed(false),
  publishBranch: () => Effect.succeed(undefined),
  refreshBranch: () => Effect.succeed(false),
  openPullRequest: () => Effect.die("no pull request here"),
  note: () => Effect.void,
  windDown: () => Effect.void,
  planReset: () => Effect.succeed(undefined),
} satisfies Partial<BuilderRouteDeps>;

describe("delegating from an automation's run", () => {
  const records = [
    recordOf("automation-step", { delegated: true, step: true }),
    recordOf("scheduled-run", { delegated: true }),
    recordOf("builder", { parent: "ws-lead" }),
 // upstream waiting child of the step, which daemon.ts adopts with the step as its parent.
    recordOf("step-child", { parent: "ws-automation-step", delegated: true }),
  ];
  const created: Array<string> = [];
  const routeOn = (onComputer: boolean) =>
    Effect.gen(function* () {
      return yield* makeBuilderRoute({
        sql: yield* SqlClient.SqlClient,
        store: { getByThread: (thread: string) => Effect.succeed(records.find((r) => r.internal.threadId === thread)) } as unknown as SessionStore["Service"],
        onComputer,
        freeSlots: Effect.succeed(2),
        agentsAtOnce: Effect.succeed(8),
        createLocal: (input) => Effect.sync(() => (created.push(input.requestId), records[0]!)),
        wake: () => Effect.void,
        keep: () => Effect.void,
        registerLead: () => Effect.succeed("cloud-ws"),
        modelOf: () => Effect.succeed(undefined),
        shareBranch: () => Effect.succeed(false),
        link: () => undefined,
        holdSchedule: () => Effect.die("no Cloud schedules here"),
        controlSchedule: () => Effect.void,
        scheduleRan: () => Effect.succeed("done" as const),
        ...NO_INTEGRATION,
      });
    });
 /** What Builders.start answers delegate_task from the thread: undefined for upstream child, else its refusal. */
  const startFrom = (threadId: string, onComputer: boolean, where?: "cloud") =>
    Effect.gen(function* () {
      const route = yield* routeOn(onComputer);
      // What delegate_task passes for isolation "worktree", or for where "cloud".
      const out = yield* Effect.result(
        route.start({ parentThreadId: threadId, task: "Fix the flaky test in a worktree", title: "Fix flaky test", where, requestKey: `cmd-${threadId}-${where}` }),
      );
      return out._tag === "Success" ? out.success : out.failure.message;
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" })));

  test("an automation's worktree delegation gets T3's waiting child on a Cloud computer, as on This Mac; a builder still may not start builders", async () => {
    const answers = await Effect.runPromise(
      Effect.all({
        stepHere: startFrom("automation-step", false),
        stepOnComputer: startFrom("automation-step", true),
        runOnComputer: startFrom("scheduled-run", true),
        builderOnComputer: startFrom("builder", true),
      }),
    );
    expect(answers).toEqual({
      stepHere: undefined,
      stepOnComputer: undefined,
      runOnComputer: undefined,
      builderOnComputer: "A builder does its own work: only its lead starts builders. Message the lead if the work needs more hands.",
    });
    expect(created).toEqual([]);
  });

  test("an automation's run that asks for a Cloud computer of its own is told so, here and on a Cloud computer, not given a child here", async () => {
    const answers = await Effect.runPromise(
      Effect.all({
        stepHere: startFrom("automation-step", false, "cloud"),
        stepOnComputer: startFrom("automation-step", true, "cloud"),
        runHere: startFrom("scheduled-run", false, "cloud"),
      }),
    );
    const told = "An automation's helpers work where it runs; a Cloud computer of their own (where \"cloud\") is for a chat's builders. Delegate without where.";
    expect(answers).toEqual({ stepHere: told, stepOnComputer: told, runHere: told });
    expect(created).toEqual([]);
  });

  test("an automation's run or step on a Cloud computer may take its desktop; a builder or a child beside its lead may not", async () => {
    // What the computer tool asks before it acts (mcp/toolkits/computer/handlers.ts): true refuses the desktop.
    const shares = await Effect.runPromise(
      Effect.gen(function* () {
        const route = yield* routeOn(true);
        return {
          step: yield* route.sharesComputer("automation-step"),
          run: yield* route.sharesComputer("scheduled-run"),
          builder: yield* route.sharesComputer("builder"),
          stepChild: yield* route.sharesComputer("step-child"),
        };
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
    );
    expect(shares).toEqual({ step: false, run: false, builder: true, stepChild: true });
  });
});

// ------------------------------------------------------------------ the route's start, against a stand-in Cloud

/** Cloud as mail/spawn and computers?mine=true answer, recording what the route sent. */
function standInCloud(answer: { computers?: () => Response } = {}) {
  const sent: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname.replace(/^\/api\/v1\/code\//, "") + new URL(String(url)).search;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    sent.push({ path, body });
    if (path.startsWith("runtime/computers")) return answer.computers?.() ?? Response.json({ computers: [], cloud_computers: true });
    const at = typeof body.computer_id === "string" ? body.computer_id : "cc-fresh";
    return Response.json({ workspace: { id: `ws-${body.request_id}`, title: body.title, repo: "acme/widgets", branch: body.branch, engine: body.engine, computer_id: at }, message: { id: `mail-${body.request_id}` } }, { status: 201 });
  });
  vi.stubGlobal("fetch", fetch);
  return { sent, fetch };
}

const LEAD_MODEL = "claude-sonnet-5-5";

/** A lead chat on This Mac (claude-agent), signed in to Cloud as computer `mac-1`; `signedIn: false` has no link. */
/** Databases the routes write to, open until the test ends. */
const scopes: Array<Scope.Closeable> = [];

const routeOf = (options: { signedIn?: boolean; lead?: Partial<WorkspaceRecord["internal"]> & { parent?: string } } = {}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    scopes.push(scope);
    const sql = Context.get(yield* Layer.buildWithScope(NodeSqliteClient.layer({ filename: ":memory:" }), scope), SqlClient.SqlClient);
    const lead = {
      workspace: { id: "lead", engine: "claude-agent", ...(options.lead?.parent ? { parent_workspace_id: options.lead.parent } : {}) },
      session: { id: "lead-session" },
      internal: { threadId: "caveman:lead", ...options.lead },
    } as unknown as WorkspaceRecord;
    const store = {
      getByThread: (threadId: string) => Effect.succeed(threadId === "caveman:lead" ? lead : undefined),
      getWorkspace: () => Effect.succeed(undefined),
    } as unknown as SessionStore["Service"];
    const identity = { cloudUrl: "http://cloud.test", runtimeId: "rt-1", organizationId: "org-1", computerId: "mac-1" } as unknown as Identity;
    return yield* makeBuilderRoute({
      sql,
      store,
      onComputer: false,
      freeSlots: Effect.succeed(0),
      agentsAtOnce: Effect.succeed(8),
      createLocal: () => Effect.die("no builder here"),
      wake: () => Effect.void,
      keep: () => Effect.void,
      registerLead: () => Effect.succeed("cloud-lead"),
      modelOf: () => Effect.succeed(LEAD_MODEL),
      shareBranch: () => Effect.succeed(false),
      link: () => (options.signedIn === false ? undefined : { identity, state: { cloudUrl: "http://cloud.test", token: "rt-token" } }),
      holdSchedule: () => Effect.die("no Cloud schedules here"),
      controlSchedule: () => Effect.void,
      scheduleRan: () => Effect.succeed("done" as const),
      ...NO_INTEGRATION,
    });
  }).pipe(Effect.orDie);

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);
const start = (route: Effect.Success<ReturnType<typeof routeOf>>, input: Partial<BuilderStart>) =>
  run(route.start({ parentThreadId: "caveman:lead", task: "Build the part.", title: "Part", requestKey: "k1", ...input }).pipe(Effect.flip, Effect.map((e) => ({ refused: e })), Effect.catch((ok) => Effect.succeed({ started: ok }))));

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const scope of scopes.splice(0)) await Effect.runPromise(Scope.close(scope, Exit.void));
});

test("a builder sent to a named Cloud computer: computer_id, never where, on the harness and model asked for", async () => {
  const cloud = standInCloud();
  const route = await run(routeOf());
  const out = await start(route, { engine: "codex", model: "gpt-5.5", computerId: "cc-2" });
  // Not listed yet: the computer goes by its id.
  expect(out).toEqual({ started: { workspaceId: "ws-builder:k1", where: "cloud", computerId: "cc-2", computerName: "cc-2", title: "Part", engine: "codex", model: "gpt-5.5" } });
  expect(cloud.sent).toHaveLength(1);
  expect(cloud.sent[0]!.path).toBe("mail/spawn");
  expect(cloud.sent[0]!.body).toMatchObject({ request_id: "builder:k1", from_workspace_id: "cloud-lead", engine: "codex", model: "gpt-5.5", computer_id: "cc-2", lead_session_id: "lead-session" });
  expect(cloud.sent[0]!.body).not.toHaveProperty("where");
  // task_status reads the builder's own engine, model and computer.
  expect(await run(route.status("ws-builder:k1"))).toEqual({ workspaceId: "ws-builder:k1", where: "cloud", computerId: "cc-2", computerName: "cc-2", title: "Part", engine: "codex", model: "gpt-5.5", state: "running" });
  // A retry is that builder: nothing more asked of Cloud.
  expect(await start(route, { engine: "codex", model: "gpt-5.5", computerId: "cc-2" })).toEqual(out);
  expect(cloud.sent).toHaveLength(1);
});

test("a builder on the lead's engine gets the lead's model unless one is asked for; on another engine, only the one asked for", async () => {
  const cloud = standInCloud();
  const route = await run(routeOf());
  await start(route, { requestKey: "same", where: "cloud" });
  await start(route, { requestKey: "picked", where: "cloud", model: "claude-opus-5-5" });
  await start(route, { requestKey: "other", where: "cloud", engine: "caveman" });
  expect(cloud.sent.map((s) => [s.body.engine, s.body.model, s.body.where, s.body.computer_id])).toEqual([
    ["claude-agent", LEAD_MODEL, "cloud", undefined],
    ["claude-agent", "claude-opus-5-5", "cloud", undefined],
    ["caveman", undefined, "cloud", undefined],
  ]);
});

test("a named computer is refused with where, an ACP engine is refused before Cloud is asked, and this computer's own id means here", async () => {
  const cloud = standInCloud();
  const route = await run(routeOf());
  const both = await start(route, { where: "cloud", computerId: "cc-2" });
  expect(both).toMatchObject({ refused: { reason: "invalid_request", message: "Name computerId or where, not both." } });
  const acp = await start(route, { engine: "acp:gemini", computerId: "cc-2" });
  expect(acp).toMatchObject({ refused: { reason: "invalid_request" } });
  expect((acp as { refused: BuilderError }).refused.message).toContain("caveman, claude-agent, codex");
 // This Mac's own Cloud computer: upstream child here, as with no computer named.
  expect(await start(route, { computerId: "mac-1" })).toEqual({ started: undefined });
  expect(cloud.sent).toHaveLength(0);
 // A thread that is no Caveman Code chat is upstream too: delegate_task refuses what it cannot honour.
  expect(await start(route, { parentThreadId: "thread-t3", computerId: "cc-2" })).toEqual({ started: undefined });
  // A builder starts none.
  expect(await start(await run(routeOf({ lead: { parent: "lead-0" } })), { computerId: "cc-2" })).toMatchObject({ refused: { reason: "invalid_request" } });
});

test("Cloud refusing a named computer (not the person's, a laptop) is the agent's to fix", async () => {
  standInCloud();
  vi.stubGlobal("fetch", async () => Response.json({ error: { code: "cave_code_computer_not_yours", message: "A builder runs on its lead's computer or on a Cloud computer the person whose work this is made, never on someone else's." } }, { status: 403 }));
  const route = await run(routeOf());
  expect(await start(route, { computerId: "cc-theirs" })).toMatchObject({ refused: { reason: "invalid_request", message: expect.stringContaining("never on someone else's") } });
});

const computer = (id: string, fields: Partial<CloudComputer>): CloudComputer => ({
  id,
  name: id,
  driver: "kubernetes",
  size: "2cpu-4gb",
  desired_state: "running",
  observed_state: "running",
  observed_reason: "",
  updated_at: "2026-10-28T00:00:00Z",
  ...fields,
});

test("a lead's computers: the person's Cloud computers by state, never a laptop or this one, kept a while; else a note why none", async () => {
  const listed = [
    computer("mac-1", { driver: "local", name: "This Mac" }),
    computer("mac-2", { driver: "local", name: "Other Mac" }),
    computer("awake", {}),
    computer("asleep", { desired_state: "suspended", observed_state: "suspended" }),
    computer("unpaid", { name: "Unpaid", desired_state: "suspended", observed_state: "suspended", sleep_reason: "usage" }),
    computer("off", { name: "Off", desired_state: "stopped", observed_state: "stopped" }),
    computer("waking", { desired_state: "running", observed_state: "stopped" }),
    computer("booting", { observed_state: "starting" }),
    computer("broken", { observed_state: "failed" }),
    computer("gone", { desired_state: "deleted", observed_state: "stopping" }),
    // Cloud's computer for another builder (mailbox.go placeBuilder names it "builder").
    computer("spawned", { name: "builder" }),
  ];
  const cloud = standInCloud({ computers: () => Response.json({ computers: listed, cloud_computers: true }) });
  const route = await run(routeOf());
  const got = await run(route.computers("caveman:lead"));
  expect(got.note).toBe(
    "Unpaid (unpaid) is asleep because nothing pays for the time, so no builder runs there until credits are added. Off (off) is stopped, so no builder runs there until the person starts it. Pick another computer.",
  );
  expect(got.computers.map((c) => [c.id, c.state, c.canRunBuilder])).toEqual([
    ["awake", "awake", true],
    ["asleep", "asleep", true],
    // Mail to it would not wake it: nothing pays for its time.
    ["unpaid", "asleep", false],
    // Nor would it wake one the person stopped: mail resumes only a suspended computer.
    ["off", "asleep", false],
    ["waking", "starting", true],
    ["booting", "starting", true],
    ["broken", "failed", false],
  ]);
  expect(got.computers[0]).toEqual({ id: "awake", name: "awake", kind: "cloud", os: "linux", state: "awake", driverKinds: ["caveman", "claudeAgent", "codex"], canRunBuilder: true });
  expect(route.thisComputer()).toBe("mac-1");
  // Asked again soon: the same list, without asking Cloud again.
  await run(route.computers("caveman:lead"));
  expect(cloud.sent.filter((s) => s.path.startsWith("runtime/computers"))).toEqual([{ path: "runtime/computers?mine=true", body: {} }]);

  expect(await run(route.computers("thread-t3"))).toEqual({ computers: [], note: NOT_A_LEAD });
  expect((await run((await run(routeOf({ signedIn: false }))).computers("caveman:lead"))).note).toMatch(/^Signed out of Caveman Cloud/);
  standInCloud({ computers: () => Response.json({ computers: [], cloud_computers: false }) });
  expect((await run((await run(routeOf())).computers("caveman:lead"))).note).toBe("This Caveman Cloud runs no Cloud computers.");
  standInCloud({ computers: () => Response.json({ error: { code: "cave_unavailable", message: "down" } }, { status: 503 }) });
  const down = await run((await run(routeOf())).computers("caveman:lead"));
  expect(down.computers).toEqual([]);
  expect(down.note).toMatch(/^Caveman Cloud did not list its computers/);
});

test("Cloud that does not answer leaves only this computer, quickly", async () => {
  vi.stubGlobal("fetch", () => new Promise<Response>(() => undefined));
  const route = await run(routeOf());
  const began = Date.now();
  expect(await run(route.computers("caveman:lead"))).toEqual({ computers: [], note: "Caveman Cloud did not answer in time." });
  expect(Date.now() - began).toBeLessThan(5_000);
});

/** Date.now `skew` ms ahead of the clock (the route's cache reads Date.now), until `restore`. */
function skewedClock() {
  const realNow = Date.now.bind(Date);
  const clock = { skew: 0, restore: () => spy.mockRestore() };
  const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clock.skew);
  return clock;
}

test("a named computer Cloud lists asleep unpaid or failed is refused before the spawn; one it listed goes by its name", async () => {
  const clock = skewedClock();
  try {
    const listed: Array<CloudComputer> = [
      computer("cc-box", { name: "Box" }),
      computer("cc-unpaid", { name: "Unpaid", desired_state: "suspended", observed_state: "suspended", sleep_reason: "usage" }),
      computer("cc-broken", { name: "Broken", observed_state: "failed" }),
    ];
    let cloudDown = false;
    const cloud = standInCloud({
      computers: () =>
        cloudDown ? Response.json({ error: { code: "cave_unavailable", message: "down" } }, { status: 503 }) : Response.json({ computers: listed, cloud_computers: true }),
    });
    const spawns = () => cloud.sent.filter((s) => s.path === "mail/spawn");
    // Before Cloud listed them, a named computer is Cloud's to place.
    const cold = await run(routeOf());
    expect(await start(cold, { requestKey: "u0", computerId: "cc-unpaid" })).toMatchObject({ started: { computerId: "cc-unpaid", computerName: "cc-unpaid" } });
    expect(spawns()).toHaveLength(1);

    // Every list in one millisecond, as on a fast machine: a refusal still sees that Cloud answered again.
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const route = await run(routeOf());
    await run(route.computers("caveman:lead"));
    expect(await start(route, { requestKey: "u1", computerId: "cc-unpaid" })).toEqual({
      refused: expect.objectContaining({ reason: "invalid_request", message: "Cloud computer Unpaid is asleep because nothing pays for its time: add credits or pick another computer." }),
    });
    expect(await start(route, { requestKey: "b1", computerId: "cc-broken" })).toEqual({
      refused: expect.objectContaining({ reason: "invalid_request", message: "Cloud computer Broken has failed and takes no builder: pick another computer." }),
    });
    expect(spawns()).toHaveLength(1);
    // One that takes it: by the name Cloud listed, kept with the builder, so task_status (and a restart) reads the same.
    expect(await start(route, { requestKey: "x1", computerId: "cc-box" })).toMatchObject({ started: { where: "cloud", computerId: "cc-box", computerName: "Box" } });
    expect(await run(route.status("ws-builder:x1"))).toMatchObject({ computerId: "cc-box", computerName: "Box" });
    // where cloud: a computer of Cloud's choosing, never one named.
    const own = (await start(route, { requestKey: "c1", where: "cloud" })) as { started: BuilderStarted };
    expect(own.started).toMatchObject({ where: "cloud", computerId: "cc-fresh" });
    expect(own.started).not.toHaveProperty("computerName");
    expect(await run(route.status("ws-builder:c1"))).not.toHaveProperty("computerName");
    // Paid for since the list: Cloud is asked again before a refusal, and now lists it as one that takes a builder.
    listed[1] = computer("cc-unpaid", { name: "Unpaid", desired_state: "running", observed_state: "running" });
    expect(await start(route, { requestKey: "u2", computerId: "cc-unpaid" })).toMatchObject({ started: { computerId: "cc-unpaid", computerName: "Unpaid" } });
    // Cloud unreachable when it is asked again: the old "no" refuses nothing, and Cloud places it.
    cloudDown = true;
    expect(await start(route, { requestKey: "b2", computerId: "cc-broken" })).toMatchObject({ started: { computerId: "cc-broken" } });
  } finally {
    clock.restore();
  }
});

test("Cloud's refusals go by its error code: what the agent asked wrong is invalid_request, and a laptop or an unknown id says where the ids are", async () => {
  let answer: { status: number; body: unknown } = { status: 500, body: {} };
  vi.stubGlobal("fetch", async () => Response.json(answer.body, { status: answer.status }));
  const route = await run(routeOf());
  let n = 0;
  const refusal = async (status: number, body: unknown) => {
    answer = { status, body };
    return ((await start(route, { requestKey: `r${++n}`, computerId: "cc-2" })) as { refused: BuilderError }).refused;
  };
  // A laptop, someone's deleted computer, an id that is none: Cloud's bare "Computer not found." says too little.
  expect(await refusal(404, { error: { code: "cave_not_found", message: "Computer not found." } })).toMatchObject({ reason: "invalid_request", message: NO_SUCH_COMPUTER });
  expect(await refusal(400, { error: { code: "cave_bad_request", message: "title is at most 200 characters." } })).toMatchObject({ reason: "invalid_request", message: "title is at most 200 characters." });
  expect(await refusal(400, { error: { code: "cave_code_engine_unavailable", message: "ACP agents don't run on a Cloud computer yet." } })).toMatchObject({ reason: "invalid_request" });
  expect(await refusal(403, { error: { code: "cave_code_computer_not_yours", message: "never on someone else's" } })).toMatchObject({ reason: "invalid_request" });
  // Not the agent's to fix: the lead's Cloud session gone, this runtime refused, a limit.
  expect(await refusal(404, { error: { code: "cave_not_found", message: "Session not found." } })).toMatchObject({ reason: "unavailable", message: "Session not found." });
  expect(await refusal(403, { error: { code: "cave_forbidden", message: "This caller may not act on Caveman Code." } })).toMatchObject({ reason: "unavailable" });
  expect(await refusal(409, { error: { code: "cave_code_builder_limit", message: "This lead already has the most active builders a lead may have (8)." } })).toMatchObject({ reason: "limit_reached" });
  // Without Cloud's JSON (no code): by its status, as before.
  expect(await refusal(404, {})).toMatchObject({ reason: "invalid_request" });
  expect(await refusal(502, {})).toMatchObject({ reason: "unavailable" });
});

test("Cloud's list of computers: one request for callers at once, kept 30 s, a failure or no answer 5 s, and an answer that came late still kept", async () => {
  const clock = skewedClock();
  try {
    let answer: () => Promise<Response> = async () => Response.json({ computers: [computer("box", { name: "Box" })], cloud_computers: true });
    let asked = 0;
    vi.stubGlobal("fetch", async () => {
      asked++;
      return answer();
    });
    const route = await run(routeOf());
    const list = () => run(route.computers("caveman:lead"));
    const [a, b] = await Promise.all([list(), list()]);
    expect(a.computers.map((c) => c.id)).toEqual(["box"]);
    expect(b).toEqual(a);
    expect(asked).toBe(1);
    clock.skew += 29_000;
    expect(await list()).toEqual(a);
    expect(asked).toBe(1);

    // Down: said so, and asked again after a few seconds, not every call.
    clock.skew += 2_000;
    answer = async () => Response.json({ error: { code: "cave_unavailable", message: "down" } }, { status: 503 });
    expect((await list()).note).toBe("Caveman Cloud did not list its computers: down");
    clock.skew += 4_000;
    await list();
    expect(asked).toBe(2);
    clock.skew += 2_000;

    // No answer in time: said so at once for the next few seconds, and Cloud's late answer is the list after.
    let release = () => {};
    answer = () => new Promise<Response>((resolve) => (release = () => resolve(Response.json({ computers: [computer("late", {})], cloud_computers: true }))));
    const slow = { computers: [], note: "Caveman Cloud did not answer in time." };
    expect(await list()).toEqual(slow);
    const began = Date.now();
    expect(await list()).toEqual(slow);
    expect(Date.now() - began).toBeLessThan(1_000);
    expect(asked).toBe(3);
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await list()).computers.map((c) => c.id)).toEqual(["late"]);
    expect(asked).toBe(3);
  } finally {
    clock.restore();
  }
});
