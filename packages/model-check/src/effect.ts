/**
 * The checker's grip on Effect fibers: a Gates service that parks a fiber until the checker releases it, a clock whose
 * sleepers wake only when the checker says so, and a harness that runs the system to quiescence after every step.
 * Gates live in test-double layers and wrappers around the real services, never in production code.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scheduler from "effect/Scheduler";
import * as Scope from "effect/Scope";

import { GateQueue, macrotask, settle } from "./gates.ts";
import type { Action } from "./index.ts";

export class Gates extends Context.Service<
  Gates,
  { readonly gate: (name: string) => Effect.Effect<void> }
>()("@caveman-app/model-check/Gates") {}

/** Parks the calling fiber at `name` until the checker releases it. Interrupting the fiber withdraws the gate. */
export const gate = (name: string): Effect.Effect<void, never, Gates> =>
  Effect.flatMap(Gates, (gates) => gates.gate(name));

export const gatesFrom = (queue: GateQueue): Gates["Service"] => ({
  gate: (name) =>
    Effect.callback<void>((resume) => {
      const withdraw = queue.parkUnsafe(name, () => resume(Effect.void));
      return Effect.sync(withdraw);
    }),
});

export interface VirtualClock extends Clock.Clock {
  readonly nextDeadline: () => number | undefined;
  /** Moves time to the earliest deadline and wakes every sleeper due by then; false when nobody sleeps. */
  readonly advanceToNext: () => boolean;
  readonly advanceTo: (timestamp: number) => void;
}

/** A Clock whose sleepers are visible, so "advance to the next timer" can be an action. Time moves only through it. */
export const makeVirtualClock = (start = 0): VirtualClock => {
  let now = start;
  let sequence = 0;
  const sleepers: Array<{
    readonly at: number;
    readonly sequence: number;
    readonly wake: () => void;
  }> = [];
  const nanos = (millis: number) => BigInt(Math.floor(millis)) * 1_000_000n;
  const advanceTo = (timestamp: number) => {
    while (sleepers[0] !== undefined && sleepers[0].at <= timestamp) {
      const next = sleepers.shift()!;
      now = Math.max(now, next.at);
      next.wake();
    }
    now = Math.max(now, timestamp);
  };
  return {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => nanos(now),
    currentTimeNanos: Effect.sync(() => nanos(now)),
    monotonicTimeNanosUnsafe: () => nanos(now - start),
    monotonicTimeNanos: Effect.sync(() => nanos(now - start)),
    sleep: (duration) =>
      Effect.callback<void>((resume) => {
        const millis = Duration.toMillis(duration);
        if (millis <= 0) {
          resume(Effect.void);
          return;
        }
        const entry = { at: now + millis, sequence: sequence++, wake: () => resume(Effect.void) };
        sleepers.push(entry);
        sleepers.sort((a, b) => a.at - b.at || a.sequence - b.sequence);
        return Effect.sync(() => {
          const at = sleepers.indexOf(entry);
          if (at >= 0) sleepers.splice(at, 1);
        });
      }),
    nextDeadline: () => sleepers[0]?.at,
    advanceToNext: () => {
      const next = sleepers[0];
      if (next === undefined) return false;
      advanceTo(next.at);
      return true;
    },
    advanceTo,
  };
};

export const ADVANCE_CLOCK = "clock: wake the next sleeper";

export type FiberStatus = "running" | "done" | "failed" | "interrupted";

export interface Harness<A> {
  /** What `build` returned: the services under test. */
  readonly value: A;
  readonly gates: GateQueue;
  readonly clock: VirtualClock;
  /** Forks a tracked fiber under the harness services; `fibers()` reports its outcome. */
  readonly fork: <E>(name: string, effect: Effect.Effect<unknown, E, Gates | Scope.Scope>) => void;
  /** Runs an effect against the harness services to completion: observations and setup. */
  readonly run: <B, E>(effect: Effect.Effect<B, E, Gates | Scope.Scope>) => Promise<B>;
  /** Parked gates in arrival order, plus `ADVANCE_CLOCK` while a sleeper waits: the enabled actions. */
  readonly enabled: () => ReadonlyArray<string>;
  /** Releases that gate, or wakes the next sleeper, then settles. */
  readonly step: (action: string) => Promise<void>;
  /** Runs until every fiber has finished or parked. The clock does not move. */
  readonly settle: () => Promise<void>;
  /** One fair round: every parked gate released in arrival order, the next sleeper woken, then settled. Returns what it did. */
  readonly fairRound: () => Promise<ReadonlyArray<string>>;
  readonly fibers: () => Readonly<Record<string, FiberStatus>>;
  /** What an observation needs from the harness: parked gates, fiber outcomes, the time. */
  readonly snapshot: () => {
    readonly parked: ReadonlyArray<string>;
    readonly fibers: Readonly<Record<string, FiberStatus>>;
    readonly now: number;
  };
  /** Interrupts every tracked fiber and closes the scope: a crash. In-memory services are gone; what lives outside survives. */
  readonly close: () => Promise<void>;
}

export interface HarnessOptions {
  readonly startTime?: number;
  /** Event-loop turns with no fiber activity before the harness calls the system quiet. Raise it for real I/O. */
  readonly quietTurns?: number;
  /**
   * For a system that queues on something fibers outside the harness also hold (a SQL connection the rest of the
   * process uses): resolves once everything queued there before the call has had its turn. A fiber waiting there
   * schedules nothing until it does, however long that takes, so quiet turns cannot tell it from a parked one. Once
   * the system looks quiet the harness passes the barrier, and settles again if that moved anything, until a pass
   * moves nothing.
   */
  readonly barrier?: () => Promise<void>;
}

export const openHarness = async <A, E>(
  build: Effect.Effect<A, E, Gates | Scope.Scope>,
  options: HarnessOptions = {},
): Promise<Harness<A>> => {
  const gates = new GateQueue();
  const clock = makeVirtualClock(options.startTime);
  const scope = Scope.makeUnsafe();
  let scheduled = 0;
  const scheduler = new Scheduler.MixedScheduler("async", (task) => {
    scheduled++;
    const handle = setImmediate(task);
    return () => clearImmediate(handle);
  });
  const service = gatesFrom(gates);
  const provide = <B, E2>(
    effect: Effect.Effect<B, E2, Gates | Scope.Scope>,
  ): Effect.Effect<B, E2> =>
    effect.pipe(
      Effect.provideService(Gates, service),
      Effect.provideService(Scope.Scope, scope),
      Effect.provideService(Clock.Clock, clock),
    );
  const fibers = new Map<string, Fiber.Fiber<unknown, unknown>>();
  const exits = new Map<string, Exit.Exit<unknown, unknown>>();
  const fingerprint = () => `${scheduled}:${gates.activity}:${exits.size}`;
  const quiesce = async () => {
    await settle(fingerprint, options.quietTurns);
    if (options.barrier === undefined) return;
    for (;;) {
      const before = fingerprint();
      await options.barrier();
      // A waiter the barrier's own release wakes is woken from a task queued before this turn ends.
      await macrotask();
      if (fingerprint() === before) return;
      await settle(fingerprint, options.quietTurns);
    }
  };

  const status = (): Record<string, FiberStatus> =>
    Object.fromEntries(
      [...fibers.keys()].map((name) => {
        const exit = exits.get(name);
        const outcome: FiberStatus =
          exit === undefined
            ? "running"
            : Exit.isSuccess(exit)
              ? "done"
              : Cause.hasInterruptsOnly(exit.cause)
                ? "interrupted"
                : "failed";
        return [name, outcome];
      }),
    );

  const value = await Effect.runPromise(provide(build), { scheduler });
  await quiesce();

  return {
    value,
    gates,
    clock,
    fork: (name, effect) => {
      if (fibers.has(name)) throw new Error(`fiber "${name}" is already forked`);
      const fiber = Effect.runFork(provide(effect), { scheduler });
      fibers.set(name, fiber);
      fiber.addObserver((exit) => {
        exits.set(name, exit);
      });
    },
    run: (effect) => Effect.runPromise(provide(effect), { scheduler }),
    enabled: () => [
      ...gates.parked(),
      ...(clock.nextDeadline() === undefined ? [] : [ADVANCE_CLOCK]),
    ],
    step: async (action) => {
      if (action === ADVANCE_CLOCK) {
        if (!clock.advanceToNext()) throw new Error("no sleeper to wake");
      } else if (!gates.release(action)) {
        throw new Error(`no fiber is parked at "${action}"`);
      }
      await quiesce();
    },
    settle: quiesce,
    fairRound: async () => {
      const did = gates.releaseAll();
      if (clock.advanceToNext()) did.push(ADVANCE_CLOCK);
      await quiesce();
      return did;
    },
    fibers: status,
    snapshot: () => ({
      parked: gates.parked(),
      fibers: status(),
      now: clock.currentTimeMillisUnsafe(),
    }),
    close: async () => {
      await Effect.runPromise(Fiber.interruptAll(fibers.values()), { scheduler });
      await Effect.runPromise(Scope.close(scope, Exit.succeed(undefined)), { scheduler });
    },
  };
};

/** The harness's enabled actions as checker actions, for a system that is (or holds) a harness. */
export const harnessActions = <Sys>(harness: Harness<unknown>): ReadonlyArray<Action<Sys>> =>
  harness.enabled().map((name) => ({ name, run: () => harness.step(name) }));
