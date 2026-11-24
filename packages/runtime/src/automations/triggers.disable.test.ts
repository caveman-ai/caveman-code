// SEMANTICS §8.3 and §8.5: turning a file automation off, or deleting it, cancels the runs it has going with
// policy_denied. Driven through the Session Protocol handlers over the real files and triggers services and the
// real runner on a SQLite journal in a temp git repository; only the engine is played.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import { makeAutomationHandlers } from "../session-protocol/automations.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { layer as filesLayer } from "./files.ts";
import { makeJournal } from "./journal.ts";
import { NO_COST } from "./machine.ts";
import { makeRunner } from "./runner.ts";
import { AutomationRunner } from "./services.ts";
import type { Git, StepEngine } from "./steps.ts";
import { projectStoreFor, testRepo } from "./testing.ts";
import { AutomationTriggers, fileAutomationId, makeTriggers } from "./triggers.ts";

const PROJECT = "caveman-repo:abc123";
const SIX_HOURS = 6 * 3_600_000;
/** Parks on an approval gate once its first step is done. */
const GATED = `on: { schedule: { every: 6h } }
steps:
  plan:
    prompt: Plan it.
    approve: { by: owner }
  act:
    prompt: Do it.
`;
/** Its step is still working: the engine's turn never ends until it is stopped. */
const LONG = `on: { schedule: { every: 6h } }
steps:
  work:
    prompt: Work forever.
    model: fast
    computer: none
`;

const cleanup: Array<() => void> = [];
afterEach(() => cleanup.splice(0).forEach((fn) => fn()));

const git: Git = (cwd, args) =>
  Effect.sync(() => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  });

const engine = (hang: boolean): StepEngine => ({
  select: (input) =>
    Effect.succeed({
      engine: "caveman",
      modelSelection: { instanceId: "caveman", model: "fake" } as never,
      runtimeMode: "auto-accept-edits",
      model: { asked: input.asked, resolved: "fake", via: "default" },
    }),
  start: (input) => Effect.succeed({ runId: input.threadId }),
  send: (input) => Effect.succeed({ runId: `${input.threadId}:${input.key}` }),
  wait: () =>
    hang ? Effect.never : Effect.succeed({ status: "completed" as const, text: "done" }),
  stop: () => Effect.void,
  settle: () => Effect.void,
  close: () => Effect.void,
  usage: (ids) => Effect.succeed(new Map(ids.map((id) => [id, NO_COST]))),
  workspaces: () => Effect.succeed(new Map()),
});

type Handlers = Effect.Success<ReturnType<typeof makeAutomationHandlers>>;
interface Status {
  readonly status?: string | undefined;
  readonly reason: string | null;
}
interface World {
  readonly h: Handlers;
  readonly triggers: AutomationTriggers["Service"];
  readonly runner: AutomationRunner["Service"];
  readonly id: string;
  readonly advance: (ms: number) => void;
  readonly statusOf: (runId: string) => Effect.Effect<Status>;
  /** Reads the run's status until `ok` holds or `ms` passes. */
  readonly until: (runId: string, ok: (s: Status) => boolean, ms: number) => Effect.Effect<Status>;
}

/** A temp repo with `.caveman/automations/<name>.yaml`, the app's handlers, and the real triggers and runner over it. */
function world<A>(
  name: string,
  yaml: string,
  hang: boolean,
  body: (w: World) => Effect.Effect<A, unknown>,
): Promise<A> {
  const r = testRepo({ [`.caveman/automations/${name}.yaml`]: yaml });
  cleanup.push(r.remove);
  const stateDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-disable-")));
  cleanup.push(() => fs.rmSync(stateDir, { recursive: true, force: true }));
  const kv = new Map<string, string>();
  const store = {
    kvGet: (key: string) => Effect.succeed(kv.get(key)),
    kvSet: (key: string, value: string) => Effect.sync(() => void kv.set(key, value)),
  };
  const base = Layer.mergeAll(
    SqlitePersistence.layerFromPath(path.join(stateDir, "state.sqlite")),
    ProcessRunner.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  const runner = Layer.effect(
    AutomationRunner,
    Effect.gen(function* () {
      return yield* makeRunner({
        journal: yield* makeJournal,
        engine: engine(hang),
        git,
        processRunner: yield* ProcessRunner.ProcessRunner,
        github: undefined,
        projectRoot: (id) => Effect.succeed(id === PROJECT ? r.root : undefined),
        worktreesDir: path.join(stateDir, "worktrees"),
        coAuthor: Effect.succeed(true),
        pollMs: 20,
      });
    }),
  ).pipe(Layer.provide(base));
  let now = Date.parse("2026-10-20T08:00:00Z");
  const services = Layer.mergeAll(
    filesLayer.pipe(Layer.provide(projectStoreFor({ [PROJECT]: r.root }))),
    runner,
    Layer.succeed(SessionStore, store as never),
  );
  const triggers = Layer.effect(AutomationTriggers, makeTriggers({ now: () => now })).pipe(
    Layer.provideMerge(services),
  );
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const runs = yield* AutomationRunner;
        const statusOf = (runId: string) =>
          runs
            .get(runId)
            .pipe(
              Effect.map((rec): Status => ({ status: rec?.status, reason: rec?.reason ?? null })),
            );
        return yield* body({
          h: yield* makeAutomationHandlers({
            store: store as never,
            launch: () => Effect.die("no launches here"),
          }),
          triggers: yield* AutomationTriggers,
          runner: runs,
          id: fileAutomationId(PROJECT, "project", name),
          advance: (ms) => void (now += ms),
          statusOf,
          until: (runId, ok, ms) =>
            Effect.gen(function* () {
              const deadline = Date.now() + ms;
              for (;;) {
                const s = yield* statusOf(runId);
                if (ok(s) || Date.now() > deadline) return s;
                yield* Effect.sleep("20 millis");
              }
            }),
        });
      }).pipe(Effect.provide(triggers)),
    ) as Effect.Effect<A>,
  );
}

/** Turns the automation on and lets its schedule fire once: the run it started. */
const fireOnce = (w: World) =>
  Effect.gen(function* () {
    yield* w.h["automation.set_enabled"]({ request_id: "on", id: w.id, enabled: true });
    yield* w.triggers.tick;
    w.advance(SIX_HOURS + 1);
    yield* w.triggers.tick;
    const runId = (yield* w.triggers.deliveries(w.id))[0]?.runId;
    expect(runId).toBeDefined();
    return runId!;
  });

/** The app's Run now: a dry run from the working tree, whatever the automation's on or off. */
const runByHand = (w: World, requestId: string) =>
  w.h["automation.run"]({ request_id: requestId, id: w.id }).pipe(
    Effect.map((ran) => (ran as { run_id?: string }).run_id!),
  );

const ended = (s: Status) =>
  s.status === "succeeded" || s.status === "failed" || s.status === "cancelled";
const policyDenied = { status: "cancelled", reason: "policy_denied" };

describe("turning a file automation off or deleting it cancels its runs (SEMANTICS §8.5)", () => {
  it("turned off while parked on an approval, after many skipped ticks: cancelled, and a later approve does not carry it on", async () => {
    const observed = await world("gated", GATED, false, (w) =>
      Effect.gen(function* () {
        const runId = yield* fireOnce(w);
        const parked = (yield* w.until(runId, (s) => s.status === "waiting", 10_000)).status;
        // Every tick while it waits is skipped and journalled, so the run is older than the newest 50 of its automation.
        for (let i = 0; i < 55; i++) {
          w.advance(SIX_HOURS);
          yield* w.triggers.tick;
        }
        expect((yield* w.triggers.deliveries(w.id))[0]).toMatchObject({ outcome: "skipped" });
        yield* w.h["automation.set_enabled"]({ request_id: "off", id: w.id, enabled: false });
        const afterOff = yield* w.statusOf(runId);
        yield* w.runner.approve({ runId, step: "plan", decision: "approve", by: "owner" });
        return { parked, afterOff, afterApprove: yield* w.until(runId, ended, 2_000) };
      }),
    );
    expect(observed).toEqual({
      parked: "waiting",
      afterOff: policyDenied,
      afterApprove: policyDenied,
    });
  }, 60_000);

  it("turned off while a step is working: cancelled", async () => {
    const observed = await world("long", LONG, true, (w) =>
      Effect.gen(function* () {
        const runId = yield* fireOnce(w);
        const working = (yield* w.until(runId, (s) => s.status === "running", 10_000)).status;
        yield* w.h["automation.set_enabled"]({ request_id: "off", id: w.id, enabled: false });
        return { working, afterOff: yield* w.statusOf(runId) };
      }),
    );
    expect(observed).toEqual({ working: "running", afterOff: policyDenied });
  }, 30_000);

  it("deleted while a step is working: cancelled", async () => {
    const observed = await world("long", LONG, true, (w) =>
      Effect.gen(function* () {
        const runId = yield* fireOnce(w);
        const working = (yield* w.until(runId, (s) => s.status === "running", 10_000)).status;
        yield* w.h["automation.delete"]({ request_id: "delete", id: w.id });
        return { working, afterDelete: yield* w.statusOf(runId) };
      }),
    );
    expect(observed).toEqual({ working: "running", afterDelete: policyDenied });
  }, 30_000);

  it("turned off with more runs going than a page of its runs holds: every one is cancelled, those waiting for a slot too", async () => {
    const observed = await world("long", LONG, true, (w) =>
      Effect.gen(function* () {
        yield* w.h["automation.set_enabled"]({ request_id: "on", id: w.id, enabled: true });
        const runIds: string[] = [];
        for (let i = 0; i < 55; i++) runIds.push(yield* runByHand(w, `run${i}`));
        const before = new Set((yield* Effect.forEach(runIds, w.statusOf)).map((s) => s.status));
        yield* w.h["automation.set_enabled"]({ request_id: "off", id: w.id, enabled: false });
        const after = new Set(
          (yield* Effect.forEach(runIds, w.statusOf)).map((s) => `${s.status} ${s.reason}`),
        );
        return { before: [...before].sort(), after: [...after] };
      }),
    );
    expect(observed).toEqual({ before: ["queued", "running"], after: ["cancelled policy_denied"] });
  }, 60_000);

  it("a run started by hand while the automation is off keeps going when it is turned off again", async () => {
    const observed = await world("long", LONG, true, (w) =>
      Effect.gen(function* () {
        const runId = yield* runByHand(w, "run");
        const working = (yield* w.until(runId, (s) => s.status === "running", 10_000)).status;
        yield* w.h["automation.set_enabled"]({ request_id: "off", id: w.id, enabled: false });
        return { working, afterOff: yield* w.statusOf(runId) };
      }),
    );
    expect(observed).toEqual({ working: "running", afterOff: { status: "running", reason: null } });
  }, 30_000);
});
