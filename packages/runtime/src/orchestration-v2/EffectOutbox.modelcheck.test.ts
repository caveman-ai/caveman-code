/**
 * Model check of the orchestration effect outbox and its worker (EffectOutbox.ts, EffectWorker.ts runOnce).
 *
 * The real EffectOutbox.layer and EffectWorker.layerWithOptions run over the runtime's migrated SQLite schema. Two
 * worker slots share one worker id, as the daemon's slots do (EffectWorker.ts runDaemonWithOptions). The checker
 * owns the schedule: every outbox call a slot makes waits at a gate, the scripted executor waits until the checker
 * says it succeeds or fails (and, once a cancellation interrupts it, until its interrupt cleanup ends), a cancellation
 * commits and publishes as one step unless a check also offers the preemption between them (`publishGap`), and a
 * crash interrupts every fiber, keeps the database and boots a new process that runs reconcileAfterProcessLoss before
 * its slots start (serverRuntimeStartup.ts runOrderedV2StartupPhases).
 *
 * See .claude/skills/effect-outbox-worker/SKILL.md for the promise, the bounds and how to read a failure.
 */
import {
  CheckpointScopeId,
  CommandId,
  MessageId,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunStatus,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@caveman-app/protocol";
import {
  checkAsync,
  FaultPlan,
  formatTrace,
  type Action,
  type AsyncSpec,
  type Verdict,
} from "@caveman-app/model-check";
import {
  Gates,
  makeVirtualClock,
  openHarness,
  type Harness,
} from "@caveman-app/model-check/effect";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import { USER_STOP_REASON } from "./RunExecutionService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequests from "./RuntimeRequestService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitles from "./ThreadTitleRegenerationService.ts";

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const SLOTS = ["s0", "s1"] as const;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
/**
 * Effects that act on a live provider session, which a new process does not have: the promise is that a restart
 * cancels them rather than replays them. Kept apart from EffectOutbox.PROCESS_BOUND_EFFECT_TYPES so that moving a
 * type between that list and the replay list is a change this check sees.
 */
const PROCESS_BOUND = new Set<string>([
  "provider-turn.start",
  "provider-turn.interrupt",
  "provider-turn.steer",
  "provider-turn.restart",
  "runtime-request.respond",
]);

const threadA = ThreadId.make("thread:a");
const threadB = ThreadId.make("thread:b");
const runA = RunId.make("run:a");

/**
 * Enqueue order is rowid order. Effect ids sort against it inside thread A's main lane, so a claim that fell back to
 * claimNext's ORDER BY (available_at, created_at, effect_id) would pick a/1 before a/2.
 */
const SEED: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2> = [
  {
    id: "a/2:turn-start",
    commandId: CommandId.make("command:a:turn-start"),
    threadId: threadA,
    request: { type: "provider-turn.start", runId: runA },
  },
  {
    id: "a/1:capture",
    commandId: CommandId.make("command:a:capture"),
    threadId: threadA,
    request: {
      type: "checkpoint.capture",
      runId: runA,
      scopeId: CheckpointScopeId.make("scope:a"),
    },
  },
  {
    id: "a/0:title",
    commandId: CommandId.make("command:a:title"),
    threadId: threadA,
    request: { type: "thread-title.generate", kind: { type: "regenerate" } },
  },
  {
    id: "b/0:steer",
    commandId: CommandId.make("command:b:steer"),
    threadId: threadB,
    request: {
      type: "provider-turn.steer",
      providerSessionId: ProviderSessionId.make("provider-session:b"),
      providerThreadId: ProviderThreadId.make("provider-thread:b"),
      providerTurnId: ProviderTurnId.make("provider-turn:b"),
      messageId: MessageId.make("message:b"),
    },
  },
];

/** The cancellations commands commit: a run interrupted before its turn started, and a thread retiring its process-bound work. */
const CANCELS = [
  {
    label: "A",
    threadId: threadA,
    effectTypes: ["provider-turn.start", "provider-turn.restart"],
    reason: "Run run:a was interrupted before its provider turn started.",
  },
  {
    label: "B",
    threadId: threadB,
    effectTypes: EffectOutbox.PROCESS_BOUND_EFFECT_TYPES,
    reason: "Thread thread:b retired its process-bound work.",
  },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly threadId: ThreadId;
  readonly effectTypes: ReadonlyArray<EffectOutbox.OrchestrationEffectRequestV2["type"]>;
  readonly reason: string;
}>;

interface Bounds {
  readonly maxAttempts: number;
  readonly crashes: number;
  readonly cancels: number;
  readonly faults: number;
  /**
   * Offer a step between a cancellation's commit and its publish. Production has none there: EventSink.ts
   * commitThenPublish runs the publish (signalCancellations) straight after withTransaction's COMMIT, in the same
   * fiber, with no statement or async boundary between them, so only Effect's scheduler preempting that fiber
   * (MaxOpsBeforeYield) could put another fiber's step in the gap. With it, a check covers that preemption too.
   */
  readonly publishGap?: true;
  readonly seed: ReadonlyArray<string>;
}

const laneOf = (threadId: string, effectType: string) =>
  `${threadId}/${effectType === "thread-title.generate" ? "title" : "main"}`;

interface Row {
  readonly rowid: number;
  readonly id: string;
  readonly lane: string;
  readonly type: string;
  readonly status: string;
  readonly attempts: number;
  readonly availableAt: number;
  readonly createdAt: number;
  readonly lease: string | null;
}

interface Start {
  readonly id: string;
  readonly attempt: number;
  readonly process: number;
  /**
   * How a process-bound effect's execution ended: the executor succeeded (`ok`) or failed (`fails`), or a
   * cancellation or crash interrupted it. Absent while it runs, and for replay-safe effects: no clause reads theirs,
   * so recording it would only split states.
   */
  outcome?: "ok" | "fails" | "interrupted";
}

interface Obs {
  readonly process: number;
  readonly now: number;
  readonly rows: ReadonlyArray<Row>;
  readonly terminalRewrites: ReadonlyArray<string>;
  readonly starts: ReadonlyArray<Start>;
  readonly executorSucceeded: ReadonlyArray<string>;
  readonly overlaps: ReadonlyArray<string>;
  readonly startedWhileCancelled: ReadonlyArray<string>;
  /** Executions whose cancellation was published and that still run outside their interrupt cleanup. */
  readonly runningAfterCancel: ReadonlyArray<string>;
  readonly held: ReadonlyArray<string>;
  readonly claimableNow: boolean;
  readonly nextDue: number | null;
  readonly crashes: number;
  readonly cancels: number;
  readonly faultsArmed: number;
  readonly faultPending: number | null;
  readonly parked: ReadonlyArray<string>;
  readonly fibers: Readonly<Record<string, string>>;
}

interface Services {
  readonly outbox: EffectOutbox.EffectOutboxV2Shape;
  readonly workers: ReadonlyMap<string, EffectWorker.OrchestrationEffectWorkerV2Shape>;
}

/** One execution in flight. `cleanup` once it was interrupted and runs its interrupt finalizers. */
interface InFlight {
  readonly id: string;
  readonly attempt: number;
  readonly lane: string;
  phase: "running" | "cleanup";
}

interface System {
  harness: Harness<Services>;
  process: number;
  /** Set while the process is being killed: a dying process runs no interrupt cleanup. */
  dying: boolean;
  crashes: number;
  cancels: number;
  faultsArmed: number;
  readonly faults: FaultPlan;
  readonly outcomes: Map<string, "ok" | "fails">;
  readonly starts: Array<Start>;
  readonly executorSucceeded: Set<string>;
  readonly overlaps: Array<string>;
  readonly startedWhileCancelled: Array<string>;
  readonly inflight: Array<InFlight>;
  /** Effects whose cancellation signal (signalCancellations) has been sent. */
  readonly published: Set<string>;
  readonly held: Map<string, string>;
}

let sql: SqlClient.SqlClient;
let sqlScope: Scope.Closeable;

beforeAll(async () => {
  sqlScope = Scope.makeUnsafe();
  const context = await Effect.runPromise(
    Layer.buildWithScope(SqlitePersistence.layerMemory, sqlScope),
  );
  sql = Context.get(context, SqlClient.SqlClient);
  // Observes every UPDATE the real code issues, without touching it.
  await Effect.runPromise(
    Effect.gen(function* () {
      yield* sql`CREATE TEMP TABLE terminal_rewrites (effect_id TEXT NOT NULL, old_status TEXT NOT NULL, new_status TEXT NOT NULL)`;
      yield* sql.unsafe(`
        CREATE TEMP TRIGGER terminal_status_guard
        BEFORE UPDATE OF status ON main.orchestration_v2_effect_outbox
        WHEN OLD.status IN ('succeeded', 'failed', 'cancelled') AND NEW.status <> OLD.status
        BEGIN
          INSERT INTO terminal_rewrites (effect_id, old_status, new_status) VALUES (OLD.effect_id, OLD.status, NEW.status);
        END
      `);
    }),
  );
});

afterAll(async () => {
  await Effect.runPromise(Scope.close(sqlScope, Exit.void));
});

const quiet = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(References.MinimumLogLevel, "None"));

const offset = (iso: string) => Date.parse(iso) - T0;

/** A worker slot's view of the real outbox: every call waits at a gate, and an armed fault fails the call before it runs. */
const slotOutbox = (
  system: System,
  real: EffectOutbox.EffectOutboxV2Shape,
  gates: Gates["Service"],
  slot: string,
): EffectOutbox.EffectOutboxV2Shape => {
  const statement = <A>(
    name: string,
    operation: string,
    run: Effect.Effect<A, EffectOutbox.EffectOutboxError>,
  ) =>
    // The worker settles from uninterruptible finalizers (onError). A crash still lands before the statement there,
    // so the gate stays interruptible: a crash is the process dying, not a graceful interrupt.
    Effect.interruptible(gates.gate(`${slot}: ${name}`)).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          try {
            system.faults.hit();
          } catch (cause) {
            return Effect.fail(new EffectOutbox.EffectOutboxError({ operation, cause }));
          }
          return run;
        }),
      ),
    );
  return {
    ...real,
    claimNext: (input) =>
      statement("claim", "claim", real.claimNext(input)).pipe(
        Effect.tap((claimed) =>
          Effect.sync(() => {
            if (Option.isSome(claimed)) system.held.set(slot, claimed.value.id);
          }),
        ),
      ),
    get: (effectId) => statement(`re-read ${effectId}`, "get", real.get(effectId)),
    succeed: (input) =>
      statement(`settle ${input.effectId} succeeded`, "succeed", real.succeed(input)),
    retry: (input) => statement(`settle ${input.effectId} retry`, "retry", real.retry(input)),
    fail: (input) => statement(`settle ${input.effectId} failed`, "fail", real.fail(input)),
  };
};

/**
 * Records each execution, then waits until the checker picks its outcome. A crash or cancellation interrupts it there.
 *
 * An execution interrupted by a cancellation then runs an interrupt cleanup that takes a step (`cleanup <id> #n`),
 * as the real executors' finalizers do: Effect runs onError, onInterrupt and acquireRelease finalizers
 * uninterruptibly, and runOnce's raceFirst returns only once its losing execution has ended (raceAllFirst interrupts
 * the losers in an uninterruptible onExit and awaits them). For provider-turn.start that cleanup is real work:
 * ProviderSessionManager.ts's session open closes the provider process it started (`closeScopeWithin`, time-boxed)
 * and revokes a freshly issued MCP credential (`clearMcpSession`) in its onError; ensureThreadAttached's onError
 * detaches the thread; startTurn's acquireUseRelease marks the session idle. A dying process runs no cleanup.
 */
const scriptedExecutor = (
  system: System,
  real: EffectOutbox.EffectOutboxV2Shape,
  gates: Gates["Service"],
): EffectWorker.OrchestrationEffectExecutorV2Shape => ({
  execute: (effect) => {
    const lane = laneOf(effect.threadId, effect.request.type);
    const name = `exec ${effect.id} #${effect.attemptCount}`;
    const entry: InFlight = { id: effect.id, attempt: effect.attemptCount, lane, phase: "running" };
    const start: Start = { id: effect.id, attempt: effect.attemptCount, process: system.process };
    const ended = (outcome: NonNullable<Start["outcome"]>) => {
      if (PROCESS_BOUND.has(effect.request.type)) start.outcome = outcome;
    };
    return Effect.gen(function* () {
      const row = yield* real.get(effect.id).pipe(Effect.orDie);
      if (Option.exists(row, (current) => current.status === "cancelled")) {
        system.startedWhileCancelled.push(`${effect.id} #${effect.attemptCount}`);
      }
      const others = system.inflight
        .filter((other) => other.lane === lane)
        .map((other) => other.id);
      if (others.length > 0)
        system.overlaps.push(`${effect.id} started while ${others.join(", ")} still ran`);
      system.inflight.push(entry);
      system.starts.push(start);
      yield* gates.gate(name);
      if (system.outcomes.get(name) === "fails") {
        ended("fails");
        return yield* new EffectWorker.OrchestrationEffectExecutionError({
          effectId: effect.id,
          effectType: effect.request.type,
          cause: "scripted failure",
        });
      }
      ended("ok");
      system.executorSucceeded.add(effect.id);
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.suspend(() => {
          ended("interrupted");
          if (system.dying) return Effect.void;
          entry.phase = "cleanup";
          return gates.gate(`cleanup ${effect.id} #${effect.attemptCount}`);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          const at = system.inflight.indexOf(entry);
          if (at >= 0) system.inflight.splice(at, 1);
        }),
      ),
    );
  },
});

const boot = async (system: System, bounds: Bounds, startTime: number) => {
  system.process++;
  system.dying = false;
  const workerId = `orchestration-v2:process-${system.process}`;
  system.harness = await openHarness(
    Effect.gen(function* () {
      const gates = yield* Gates;
      const outboxContext = yield* Layer.build(
        EffectOutbox.layer.pipe(Layer.provide(Layer.succeed(SqlClient.SqlClient, sql))),
      );
      const outbox = Context.get(outboxContext, EffectOutbox.EffectOutboxV2);
      const executor = scriptedExecutor(system, outbox, gates);
      const workers = new Map<string, EffectWorker.OrchestrationEffectWorkerV2Shape>();
      for (const slot of SLOTS) {
        const context = yield* Layer.build(
          EffectWorker.layerWithOptions({
            workerId,
            maxAttempts: bounds.maxAttempts,
          }).pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(EffectOutbox.EffectOutboxV2, slotOutbox(system, outbox, gates, slot)),
                Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, executor),
              ),
            ),
          ),
        );
        workers.set(slot, Context.get(context, EffectWorker.OrchestrationEffectWorkerV2));
      }
      return { outbox, workers } satisfies Services;
    }),
    { startTime },
  );
  const { outbox, workers } = system.harness.value;
  if (system.process === 1) {
    await system.harness.run(
      outbox.enqueue(SEED.filter((effect) => bounds.seed.includes(effect.id))),
    );
  } else {
    await system.harness.run(outbox.reconcileAfterProcessLoss);
  }
  for (const [slot, worker] of workers) {
    // The daemon's loop (runDaemonWithOptions runWorker): run, swallow and log a failure, run again.
    system.harness.fork(
      slot,
      quiet(
        worker.runOnce.pipe(
          Effect.catchCause(() => Effect.succeed(false)),
          Effect.ensuring(Effect.sync(() => system.held.delete(slot))),
          Effect.forever,
        ),
      ),
    );
  }
  await system.harness.settle();
};

/**
 * Kills the process: interrupts every fiber and drops in-memory state, keeping the database. A process dies inside an
 * interrupt cleanup too, but Effect cannot interrupt a finalizer, so the double's parked cleanups are let go first.
 */
const kill = async (system: System) => {
  system.dying = true;
  for (const name of system.harness.gates.parked()) {
    if (name.startsWith("cleanup ")) system.harness.gates.release(name);
  }
  await system.harness.close();
  if (system.inflight.length > 0) {
    throw new Error(
      `a dead process still runs ${system.inflight.map((entry) => `${entry.id} #${entry.attempt}`).join(", ")}`,
    );
  }
};

const readRows = () =>
  Effect.runSync(
    sql<{
      readonly rowid: number;
      readonly effect_id: string;
      readonly thread_id: string;
      readonly effect_type: string;
      readonly status: string;
      readonly attempt_count: number;
      readonly available_at: string;
      readonly created_at: string;
      readonly lease_owner: string | null;
    }>`
      SELECT rowid, effect_id, thread_id, effect_type, status, attempt_count, available_at, created_at, lease_owner
      FROM orchestration_v2_effect_outbox
      ORDER BY rowid
    `,
  );

const outboxSpec = (bounds: Bounds, omit: ReadonlyArray<string> = []): AsyncSpec<System, Obs> => ({
  make: async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* sql`DELETE FROM orchestration_v2_effect_outbox`;
        yield* sql`DELETE FROM temp.terminal_rewrites`;
      }),
    );
    const system: System = {
      harness: undefined as never,
      process: 0,
      dying: false,
      crashes: 0,
      cancels: 0,
      faultsArmed: 0,
      faults: new FaultPlan(),
      outcomes: new Map(),
      starts: [],
      executorSucceeded: new Set(),
      overlaps: [],
      startedWhileCancelled: [],
      inflight: [],
      published: new Set(),
      held: new Map(),
    };
    await boot(system, bounds, T0);
    return system;
  },
  observe: async (system) => {
    const now = system.harness.clock.currentTimeMillisUnsafe();
    const rows: Array<Row> = readRows().map((row) => ({
      rowid: row.rowid,
      id: row.effect_id,
      lane: laneOf(row.thread_id, row.effect_type),
      type: row.effect_type,
      status: row.status,
      attempts: row.attempt_count,
      availableAt: offset(row.available_at),
      createdAt: offset(row.created_at),
      lease: row.lease_owner,
    }));
    const rewrites = Effect.runSync(
      sql<{
        readonly effect_id: string;
        readonly old_status: string;
        readonly new_status: string;
      }>`
        SELECT effect_id, old_status, new_status FROM temp.terminal_rewrites
      `,
    );
    const nextClaimableAt = Effect.runSync(system.harness.value.outbox.nextClaimableAt);
    const due = rows
      .filter((row) => row.status === "pending" && row.availableAt > now - T0)
      .map((row) => row.availableAt);
    const { parked, fibers } = system.harness.snapshot();
    return {
      process: system.process,
      now: now - T0,
      rows,
      terminalRewrites: rewrites.map((r) => `${r.effect_id}: ${r.old_status} -> ${r.new_status}`),
      // Only each effect's own order of executions matters, and every gate name is distinct, so arrival order across
      // effects and gates is dropped: schedules that reach the same rows and fibers become one state.
      starts: system.starts
        .map((start) => ({ ...start }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.attempt - b.attempt)),
      executorSucceeded: [...system.executorSucceeded].sort(),
      overlaps: [...system.overlaps].sort(),
      startedWhileCancelled: [...system.startedWhileCancelled].sort(),
      runningAfterCancel: system.inflight
        .filter((entry) => entry.phase === "running" && system.published.has(entry.id))
        .map((entry) => `${entry.id} #${entry.attempt}`)
        .sort(),
      held: [...system.held.entries()].map(([slot, id]) => `${slot}:${id}`).sort(),
      claimableNow: Option.exists(nextClaimableAt, (at) => DateTime.toEpochMillis(at) <= now),
      nextDue: due.length === 0 ? null : Math.min(...due),
      crashes: system.crashes,
      cancels: system.cancels,
      faultsArmed: system.faultsArmed,
      faultPending: system.faults.pending ?? null,
      parked: [...parked].sort(),
      fibers,
    };
  },
  actions: (system, o) => {
    const unsettled = o.rows.some((row) => !TERMINAL.has(row.status));
    const actions: Array<Action<System>> = [];
    for (const name of o.parked) {
      if (name.startsWith("exec ")) {
        for (const outcome of ["ok", "fails"] as const) {
          actions.push({
            name: `${name} -> ${outcome}`,
            run: async () => {
              system.outcomes.set(name, outcome);
              await system.harness.step(name);
            },
          });
        }
      } else if (!name.endsWith(": claim") || o.claimableNow) {
        actions.push({ name, run: () => system.harness.step(name) });
      }
    }
    if (o.nextDue !== null) {
      const at = o.nextDue;
      actions.push({
        name: `clock: advance to +${at}ms`,
        run: async () => {
          system.harness.clock.advanceTo(T0 + at);
          await system.harness.settle();
        },
      });
    }
    // A server can restart at any moment, settled outbox or not.
    if (system.crashes < bounds.crashes) {
      actions.push({
        name: "crash, restart, reconcileAfterProcessLoss",
        run: async () => {
          const now = system.harness.clock.currentTimeMillisUnsafe();
          await kill(system);
          system.crashes++;
          await boot(system, bounds, now);
        },
      });
    }
    if (!unsettled) return actions;
    if (system.cancels < bounds.cancels && o.fibers.canceller === undefined) {
      for (const cancel of CANCELS) {
        // EventSink.ts commitCommandEffect: cancelUnsettled inside the command's transaction, then, after the
        // commit, signalCancellations (which also wakes claimers with notifyAvailable).
        actions.push({
          name: `cancel ${cancel.label}: ${bounds.publishGap ? "commit" : "commit and publish"}`,
          run: async () => {
            system.cancels++;
            const outbox = system.harness.value.outbox;
            system.harness.fork(
              "canceller",
              Effect.gen(function* () {
                const gates = yield* Gates;
                const ids = yield* outbox.cancelUnsettled(cancel);
                if (bounds.publishGap) yield* gates.gate(`cancel ${cancel.label}: publish`);
                yield* outbox.signalCancellations(ids);
                for (const id of ids) system.published.add(id);
              }),
            );
            await system.harness.settle();
          },
        });
      }
    }
    if (system.faultsArmed < bounds.faults && system.faults.pending === undefined) {
      actions.push({
        name: "fault: the next outbox call fails",
        run: () => {
          system.faultsArmed++;
          system.faults.arm(1);
        },
      });
    }
    return actions;
  },
  invariants: Object.fromEntries(
    Object.entries(invariantsFor(bounds)).filter(([name]) => !omit.includes(name)),
  ),
  atEnd: {
    "every row settles": (o) => o.rows.every((row) => TERMINAL.has(row.status)),
  },
  dispose: kill,
});

const invariantsFor = (bounds: Bounds): Readonly<Record<string, (o: Obs) => boolean>> => ({
  "one running row per lane": (o) => {
    const running = o.rows.filter((row) => row.status === "running").map((row) => row.lane);
    return new Set(running).size === running.length;
  },
  "a lane runs its rows in rowid order": (o) =>
    o.rows
      .filter((row) => row.status === "running")
      .every((row) =>
        o.rows.every(
          (other) =>
            other.lane !== row.lane || other.rowid >= row.rowid || TERMINAL.has(other.status),
        ),
      ),
  "terminal statuses never change": (o) => o.terminalRewrites.length === 0,
  "every running row is held by a live worker slot": (o) =>
    o.rows
      .filter((row) => row.status === "running")
      .every((row) => o.held.some((held) => held.endsWith(`:${row.id}`))),
  "no two executions overlap in one lane": (o) => o.overlaps.length === 0,
  // runOnce races the execution against awaitCancellation: the published signal interrupts it, and from then on it
  // only runs its interrupt cleanup.
  "a published cancellation stops the cancelled execution": (o) =>
    o.runningAfterCancel.length === 0,
  "a cancelled effect never starts executing": (o) => o.startedWhileCancelled.length === 0,
  "a process-bound effect never executes in two server processes": (o) =>
    o.rows
      .filter((row) => PROCESS_BOUND.has(row.type))
      .every(
        (row) =>
          new Set(o.starts.filter((start) => start.id === row.id).map((start) => start.process))
            .size <= 1,
      ),
  "one execution per claim": (o) =>
    o.rows.every((row) => {
      const attempts = o.starts
        .filter((start) => start.id === row.id)
        .map((start) => start.attempt);
      return attempts.every((attempt, index) => index === 0 || attempt > attempts[index - 1]!);
    }),
  "a row succeeds only after its executor succeeded": (o) =>
    o.rows
      .filter((row) => row.status === "succeeded")
      .every((row) => o.executorSucceeded.includes(row.id)),
  "replay-safe effects are never cancelled": (o) =>
    o.rows.filter((row) => row.status === "cancelled").every((row) => PROCESS_BOUND.has(row.type)),
  // A crash replays a replay-safe execution, and a failed settle after a success requeues it.
  "the executor runs a row at most maxAttempts times, plus once per crash or failed outbox call": (
    o,
  ) =>
    o.rows.every(
      (row) =>
        o.starts.filter((start) => start.id === row.id).length <=
        bounds.maxAttempts + o.crashes + o.faultsArmed,
    ),
  // A process-bound effect gets none of that slack. Within one process, too, only a failed execution may be retried:
  // after a success whose settle failed, recoverPostSuccessSettlement terminalizes it (terminalizeClaim) rather than
  // requeue it, and a failed settle at the last attempt terminalizes it too. A crash cancels it (reconcile).
  "a process-bound effect executes again only after its last execution failed": (o) =>
    o.rows
      .filter((row) => PROCESS_BOUND.has(row.type))
      .every((row) =>
        o.starts
          .filter((start) => start.id === row.id)
          .every((start, index, own) => index === 0 || own[index - 1]!.outcome === "fails"),
      ),
  "a process-bound effect executes at most maxAttempts times, through crashes and failed outbox calls":
    (o) =>
      o.rows
        .filter((row) => PROCESS_BOUND.has(row.type))
        .every(
          (row) => o.starts.filter((start) => start.id === row.id).length <= bounds.maxAttempts,
        ),
});

const show = (o: Obs) =>
  [
    `process ${o.process} at +${o.now}ms`,
    ...o.rows.map(
      (row) =>
        `${row.rowid} ${row.id} ${row.status} attempts=${row.attempts} due=+${row.availableAt}ms${row.lease === null ? "" : ` lease=${row.lease}`}`,
    ),
    `held [${o.held.join(", ")}] parked [${o.parked.join(" | ")}]`,
    ...(o.starts.length > 0
      ? [
          `executions ${o.starts.map((start) => `${start.id} #${start.attempt} p${start.process}${start.outcome === undefined ? "" : ` ${start.outcome}`}`).join(", ")}`,
        ]
      : []),
    ...(o.overlaps.length > 0 ? [`overlaps ${o.overlaps.join("; ")}`] : []),
    ...(o.startedWhileCancelled.length > 0
      ? [`started while cancelled ${o.startedWhileCancelled.join(", ")}`]
      : []),
    ...(o.runningAfterCancel.length > 0
      ? [`still running after its cancellation was published ${o.runningAfterCancel.join(", ")}`]
      : []),
    ...(o.terminalRewrites.length > 0
      ? [`terminal rewrites ${o.terminalRewrites.join("; ")}`]
      : []),
  ].join("\n     ");

const report = (verdict: Verdict<Obs>) =>
  verdict.ok
    ? `ok: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}`
    : `${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states):\n${formatTrace(verdict.trace, show)}${verdict.error === undefined ? "" : `\nerror: ${String(verdict.error)}`}`;

const OVERLAP = "no two executions overlap in one lane";

const LANES: Bounds = {
  maxAttempts: 2,
  crashes: 0,
  cancels: 0,
  faults: 0,
  seed: ["a/2:turn-start", "a/1:capture", "a/0:title"],
};
const CROSS_THREAD: Bounds = {
  maxAttempts: 2,
  crashes: 0,
  cancels: 1,
  faults: 0,
  publishGap: true,
  seed: ["a/2:turn-start", "b/0:steer"],
};
const CRASH: Bounds = {
  maxAttempts: 2,
  crashes: 1,
  cancels: 0,
  faults: 0,
  seed: ["a/2:turn-start", "a/1:capture"],
};
/** A cancellation as production commits it: cancelUnsettled's commit and its publish are one step. */
const CANCEL_AS_COMMITTED: Bounds = {
  maxAttempts: 2,
  crashes: 0,
  cancels: 1,
  faults: 0,
  seed: ["a/2:turn-start", "a/1:capture"],
};
/** The same, plus a preemption between the commit and the publish: every schedule of CANCEL_AS_COMMITTED and more. */
const CANCEL: Bounds = { ...CANCEL_AS_COMMITTED, publishGap: true };
const FAULT: Bounds = {
  maxAttempts: 2,
  crashes: 0,
  cancels: 0,
  faults: 1,
  seed: ["a/2:turn-start", "a/1:capture"],
};
const EVERYTHING: Bounds = {
  maxAttempts: 2,
  crashes: 1,
  cancels: 1,
  faults: 1,
  publishGap: true,
  seed: ["a/2:turn-start", "a/1:capture"],
};

const holds = async (bounds: Bounds, omit: ReadonlyArray<string> = []) => {
  const verdict = await checkAsync(outboxSpec(bounds, omit));
  // Written past vitest's console capture so a passing run still shows what it covered.
  process.stdout.write(
    `effect outbox model check ${JSON.stringify(bounds)}${omit.length === 0 ? "" : ` without "${omit.join('", "')}"`}: ${report(verdict)}\n`,
  );
  expect(verdict.ok, report(verdict)).toBe(true);
  expect(verdict.ok && verdict.exhaustive, "the search covered every reachable state").toBe(true);
};

/**
 * An exhaustive search takes as long as the machine's load makes it: CROSS_THREAD ran past vitest's 2-minute default at
 * a load average of 30. A search that times out keeps running and shares the SQLite database with the next test,
 * which then fails for no reason of its own, so these tests get 15 minutes.
 */
const SEARCH_TIMEOUT = 900_000;

describe("EffectOutbox and EffectWorker.runOnce over every schedule", () => {
  it(
    "two slots keep each lane of a thread single-runner and in rowid order through retries",
    () => holds(LANES),
    SEARCH_TIMEOUT,
  );

  it(
    "a crash anywhere leaves no row running, and never runs a process-bound effect in the next process",
    () => holds(CRASH),
    SEARCH_TIMEOUT,
  );

  it(
    "an outbox call that fails anywhere still settles every row exactly once",
    () => holds(FAULT),
    SEARCH_TIMEOUT,
  );

  // OVERLAP is finding 1 below. Every other clause holds with a cancellation at every point, including "a published
  // cancellation stops the cancelled execution", which guards runOnce's raceFirst against awaitCancellation.
  it(
    "a cancellation committed anywhere stops its execution, never lets a cancelled effect start, and never changes a settled row",
    () => holds(CANCEL, [OVERLAP]),
    SEARCH_TIMEOUT,
  );

  it(
    "two threads share two slots, and cancelling either thread keeps every clause",
    () => holds(CROSS_THREAD),
    SEARCH_TIMEOUT,
  );

  it("finding: a cancelled turn start still runs its interrupt cleanup when the next effect of its lane starts", async () => {
    const verdict = await checkAsync(outboxSpec(CANCEL_AS_COMMITTED));
    process.stdout.write(`effect outbox model check finding: ${report(verdict)}\n`);
    expect(verdict, report(verdict)).toMatchObject({
      ok: false,
      kind: "invariant",
      property: OVERLAP,
    });
    if (verdict.ok) return;
    // Every step is one production takes: the commit and its publish are one step, as in commitThenPublish.
    expect(verdict.trace.slice(1).map((step) => step.action)).toEqual([
      "s0: claim",
      "s0: re-read a/2:turn-start",
      "cancel A: commit and publish",
      "s1: claim",
      "s1: re-read a/1:capture",
    ]);
    const last = verdict.trace.at(-1)!.state;
    expect(last.overlaps).toEqual(["a/1:capture started while a/2:turn-start still ran"]);
    expect(last.parked, "turn-start was interrupted and is still in its cleanup").toContain(
      "cleanup a/2:turn-start #1",
    );
    expect(last.runningAfterCancel).toEqual([]);
  });

  it("finding: a preemption between a cancel's commit and its publish lets the next effect start before the signal", async () => {
    const verdict = await checkAsync(outboxSpec(CANCEL));
    process.stdout.write(`effect outbox model check finding: ${report(verdict)}\n`);
    expect(verdict, report(verdict)).toMatchObject({
      ok: false,
      kind: "invariant",
      property: OVERLAP,
    });
    if (verdict.ok) return;
    expect(verdict.trace.slice(1).map((step) => step.action)).toEqual([
      "s0: claim",
      "s0: re-read a/2:turn-start",
      "cancel A: commit",
      "s1: claim",
      "s1: re-read a/1:capture",
    ]);
    expect(verdict.trace.at(-1)!.state.overlaps).toEqual([
      "a/1:capture started while a/2:turn-start still ran",
    ]);
  });

  it.runIf(process.env.MODEL_CHECK_DEEP === "1")(
    "deep: crash, cancellation and a failing call combined",
    () => holds(EVERYTHING, [OVERLAP]),
    // 4 to 10 minutes idle; a regular run is six times slower at a load average of 30.
    3_600_000,
  );
});

/**
 * The executor's side of the same promise: what the real EffectWorker.layerExecutor does with a steer whose turn
 * ended and with a checkpoint capture that keeps failing, run through the real worker and outbox until the row
 * settles (production maxAttempts, 5). Each provider turn status a steer can meet, and each count of capture
 * failures from 0 to 5, is one case: the input space is small enough to enumerate.
 */
interface ExecutorCase {
  readonly row: EffectOutbox.OrchestrationEffectV2;
  /** What reached the agent or the thread: steerTurn calls and dispatched command types. */
  readonly calls: ReadonlyArray<string>;
}

const runToSettled = (
  request: EffectOutbox.OrchestrationEffectRequestV2,
  threadId: ThreadId,
  dependencies: Layer.Layer<
    | ProviderSessions.ProviderSessionManagerV2
    | RunFinalization.RunFinalizationService
    | ProviderTurnControl.ProviderTurnControlServiceV2
    | ThreadManagement.ThreadManagementService,
    never,
    never
  >,
) =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* outbox.enqueue([
      { id: "effect:case", commandId: CommandId.make("command:case"), threadId, request },
    ]);
    let row = Option.getOrThrow(yield* outbox.get("effect:case"));
    for (let round = 0; round < 10 && !TERMINAL.has(row.status); round++) {
      yield* worker.drain();
      // Past the longest backoff (EffectWorker.ts runOnce: min(30s, 100ms * 2^(attempt-1))).
      yield* Effect.sync(() => clock.advanceTo(clock.currentTimeMillisUnsafe() + 30_000));
      row = Option.getOrThrow(yield* outbox.get("effect:case"));
    }
    return row;
  }).pipe(
    Effect.provide(
      EffectWorker.layerWithOptions({ workerId: "orchestration-v2:case" }).pipe(
        Layer.provideMerge(
          Layer.merge(
            EffectWorker.layerExecutor.pipe(
              Layer.provide(
                Layer.mergeAll(
                  dependencies,
                  Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
                  Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
                  Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
                  Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({}),
                  ServerSettings.layerTest(),
                ),
              ),
            ),
            EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ),
        ),
      ),
    ),
    quiet,
    Effect.provideService(Clock.Clock, clock),
  );

const clock = makeVirtualClock(T0);

/** Which attempt the steer's run is on when the steer executes: the target turn's, a later one (a restart), or none. */
type ActiveAttempt = "the turn's" | "a later one" | "none";

/**
 * Whose stop the steer's run records (its `run_interrupt_request`): none, the person's Stop (Orchestrator.ts
 * dispatchRunInterrupt and markStoppedRun), or the stop the steer itself made on an earlier attempt when the provider
 * did not answer it (EffectWorker.ts, STEER_UNANSWERED_STOP_REASON).
 */
type StopReached = "none" | "the person's" | "the steer's own";

interface SteerState {
  readonly turn: OrchestrationV2ProviderTurn["status"];
  readonly run: OrchestrationV2RunStatus;
  readonly activeAttempt: ActiveAttempt;
  readonly stop: StopReached;
}

/**
 * Every state a steer can meet when it executes. Orchestrator.ts accepts a steer only into a running provider turn on
 * its run's active attempt, so a turn it targets is never `pending`; by execution time the turn, its run and the
 * run's active attempt may each have moved on, and a stop may have reached the run.
 */
const STEER_STATES: ReadonlyArray<SteerState> = OrchestrationV2ProviderTurn.fields.status.literals
  .filter((turn) => turn !== "pending")
  .flatMap((turn) =>
    OrchestrationV2RunStatus.literals.flatMap((run) =>
      (["the turn's", "a later one", "none"] as const).flatMap((activeAttempt) =>
        (["none", "the person's", "the steer's own"] as const).map((stop) => ({
          turn,
          run,
          activeAttempt,
          stop,
        })),
      ),
    ),
  );

const describeSteer = (state: SteerState) =>
  `turn ${state.turn}, run ${state.run} on ${state.activeAttempt === "none" ? "no" : state.activeAttempt} attempt, ${state.stop === "none" ? "no" : state.stop} stop`;

const steerCase = async ({
  turn: turnStatus,
  run: runStatus,
  activeAttempt,
  stop,
}: SteerState): Promise<ExecutorCase> => {
  const calls: Array<string> = [];
  const providerThread = {
    id: ProviderThreadId.make("provider-thread:b"),
    providerSessionId: ProviderSessionId.make("provider-session:b"),
  };
  const attemptId = RunAttemptId.make("attempt:b");
  const providerTurn = {
    id: ProviderTurnId.make("provider-turn:b"),
    providerThreadId: providerThread.id,
    runAttemptId: attemptId,
    status: turnStatus,
  };
  const run = {
    id: RunId.make("run:b"),
    status: runStatus,
    activeAttemptId:
      activeAttempt === "the turn's"
        ? attemptId
        : activeAttempt === "a later one"
          ? RunAttemptId.make("attempt:b:2")
          : null,
    ordinal: 1,
    userMessageId: MessageId.make("message:b:first"),
  };
  const message = {
    id: MessageId.make("message:b"),
    runId: run.id,
    text: "also update the changelog",
    attachments: [],
    createdBy: "user",
    creationSource: "web",
  };
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getProviderControlContext: () =>
      Effect.succeed({ providerThread, providerTurn, attempt: undefined, message, run } as never),
  });
  const sessions = Layer.mock(ProviderSessions.ProviderSessionManagerV2)({
    get: () =>
      Effect.succeed(
        Option.some({
          providerSession: { capabilities: { tools: { supportsMcpTools: false } } },
          steerTurn: () => Effect.sync(() => calls.push("steerTurn")),
        } as never),
      ),
  });
  const turnItems =
    stop === "none"
      ? []
      : [
          {
            type: "run_interrupt_request",
            runId: run.id,
            message:
              stop === "the person's"
                ? USER_STOP_REASON
                : EffectWorker.STEER_UNANSWERED_STOP_REASON,
          },
        ];
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadRecords: () =>
      Effect.succeed({ messages: [message], runs: [run], turnItems } as never),
    dispatch: (command) => Effect.sync(() => calls.push(command.type)).pipe(Effect.as({} as never)),
  });
  const row = await Effect.runPromise(
    runToSettled(
      SEED.find((effect) => effect.id === "b/0:steer")!.request,
      threadB,
      Layer.mergeAll(
        ProviderTurnControl.layer.pipe(Layer.provide(Layer.merge(projections, sessions))),
        sessions,
        threads,
        Layer.mock(RunFinalization.RunFinalizationService)({}),
      ),
    ),
  );
  return { row, calls };
};

const captureCase = async (failures: number): Promise<ExecutorCase> => {
  const calls: Array<string> = [];
  let attempts = 0;
  const scopeId = CheckpointScopeId.make("scope:a");
  const capture = Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
    execute: (input) =>
      ++attempts <= failures
        ? Effect.fail(
            new CheckpointCapture.CheckpointCaptureExecutionError({
              ...input,
              cause: "checkpoint storage unavailable",
            }),
          )
        : Effect.sync(() => calls.push("checkpoint captured")),
  });
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getCheckpointContext: () =>
      Effect.succeed({ runs: [], checkpointScopes: [], checkpoints: [] } as never),
  });
  const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
    dispatch: (command) => Effect.sync(() => calls.push(command.type)).pipe(Effect.as({} as never)),
  });
  const row = await Effect.runPromise(
    runToSettled(
      { type: "checkpoint.capture", runId: runA, scopeId },
      threadA,
      Layer.mergeAll(
        RunFinalization.layer.pipe(Layer.provide(Layer.merge(capture, projections))),
        threads,
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
      ),
    ),
  );
  return { row, calls };
};

const steerReached = (result: ExecutorCase) =>
  result.calls.includes("steerTurn") || result.calls.includes("message.dispatch");

const UNSTOPPED_STEER_STATES = STEER_STATES.filter((state) => state.stop !== "the person's");
const STOPPED_STEER_STATES = STEER_STATES.filter((state) => state.stop === "the person's");

describe("the executor settles a steer and a checkpoint capture for good", () => {
  it(`a steer reaches the agent or comes back as a follow-up in every turn and run state (${UNSTOPPED_STEER_STATES.length} states)`, async () => {
    for (const state of UNSTOPPED_STEER_STATES) {
      const result = await steerCase(state);
      const why = `${describeSteer(state)}: ${JSON.stringify(result)}`;
      expect(result.row.status, why).toBe("succeeded");
      expect(steerReached(result), why).toBe(true);
    }
  });

  it(`a steer starts nothing once the person's Stop reached its run, in every turn and run state (${STOPPED_STEER_STATES.length} states)`, async () => {
    for (const state of STOPPED_STEER_STATES) {
      const result = await steerCase(state);
      const why = `${describeSteer(state)}: ${JSON.stringify(result)}`;
      expect(result.row.status, why).toBe("succeeded");
      // It may still reach a turn that runs until Stop's interrupt, which waits behind it in the lane.
      expect(
        result.calls.filter((call) => call !== "steerTurn"),
        why,
      ).toEqual([]);
    }
  });

  it.each([0, 1, 2, 3, 4])(
    "a capture that fails %i times still captures within maxAttempts",
    async (failures) => {
      const result = await captureCase(failures);
      expect(result.row, JSON.stringify(result)).toMatchObject({
        status: "succeeded",
        attemptCount: failures + 1,
      });
      expect(result.calls).toEqual(["checkpoint captured"]);
    },
  );

  it("finding: a capture that fails maxAttempts times fails its row and settles nothing", async () => {
    const result = await captureCase(5);
    expect(result.row, JSON.stringify(result)).toMatchObject({ status: "failed", attemptCount: 5 });
    expect(result.calls, "no command tells the waiting run its capture failed").toEqual([]);
  });
});

describe("which effects a restart replays", () => {
  it("puts every effect type in exactly one of the two lists, and cancels the live-session ones", () => {
    const types = EffectOutbox.OrchestrationEffectRequestV2.members.map(
      (member) => member.fields.type.literal,
    );
    const replayed = new Set<string>(EffectOutbox.REPLAY_SAFE_EFFECT_TYPES_AFTER_PROCESS_LOSS);
    const cancelled = new Set<string>(EffectOutbox.PROCESS_BOUND_EFFECT_TYPES);
    expect(
      types.filter((type) => replayed.has(type) === cancelled.has(type)),
      "a type in neither list stays running forever after reconcileAfterProcessLoss",
    ).toEqual([]);
    expect([...cancelled].sort()).toEqual([...PROCESS_BOUND].sort());
  });
});
