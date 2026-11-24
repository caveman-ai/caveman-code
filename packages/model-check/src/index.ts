/**
 * A bounded explicit-state model checker for driving real reducers and state machines through every reachable
 * state, plus schedule enumeration for code that cannot be snapshotted (Effect services over SQLite, file systems).
 *
 * `check` walks the state graph breadth-first, so a violation comes back as the shortest trace that reaches it.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export { FaultError, FaultPlan, GateQueue, macrotask, settle } from "./gates.ts";
export { VirtualTimers } from "./timers.ts";

export interface Step<S> {
  readonly action: string;
  readonly state: S;
}

export interface Spec<S> {
  readonly init: ReadonlyArray<S>;
  /** Every step enabled in `state`. An empty list makes `state` final. */
  readonly next: (state: S) => ReadonlyArray<Step<S>>;
  /** Must hold in every reachable state. */
  readonly invariants?: Readonly<Record<string, (state: S) => boolean>>;
  /** Must hold in every reachable final state: what the system promises once nothing is left to do. */
  readonly atEnd?: Readonly<Record<string, (state: S) => boolean>>;
  /** Identity of a state for deduplication. Defaults to `canonicalKey`. */
  readonly key?: (state: S) => string;
  readonly maxDepth?: number;
  readonly maxStates?: number;
}

export type Verdict<S> =
  | {
      readonly ok: true;
      readonly states: number;
      readonly transitions: number;
      readonly depth: number;
      /** False when a bound cut the search short: the verdict covers only what was explored. */
      readonly exhaustive: boolean;
    }
  | {
      readonly ok: false;
      readonly kind: "invariant" | "atEnd" | "eventually" | "conformance" | "error";
      readonly property: string;
      readonly trace: ReadonlyArray<Step<S>>;
      readonly error?: unknown;
      readonly states: number;
    };

interface Visit<S> {
  readonly state: S;
  readonly depth: number;
  readonly parent: string | undefined;
  readonly action: string;
}

const traceIn = <S>(seen: ReadonlyMap<string, Visit<S>>, id: string): Array<Step<S>> => {
  const steps: Array<Step<S>> = [];
  for (let at: string | undefined = id; at !== undefined;) {
    const visit: Visit<S> = seen.get(at)!;
    steps.push({ action: visit.action, state: visit.state });
    at = visit.parent;
  }
  return steps.reverse();
};

export const check = <S>(spec: Spec<S>): Verdict<S> => {
  const key = spec.key ?? canonicalKey;
  const maxDepth = spec.maxDepth ?? Number.POSITIVE_INFINITY;
  const maxStates = spec.maxStates ?? 1_000_000;
  const invariants = Object.entries(spec.invariants ?? {});
  const atEnd = Object.entries(spec.atEnd ?? {});
  const seen = new Map<string, Visit<S>>();
  const queue: Array<string> = [];
  let transitions = 0;
  let depthReached = 0;
  let exhaustive = true;

  const traceTo = (id: string): Array<Step<S>> => traceIn(seen, id);

  const violated = (id: string): Verdict<S> | undefined => {
    const { state } = seen.get(id)!;
    for (const [name, holds] of invariants) {
      let ok: boolean;
      try {
        ok = holds(state);
      } catch (error) {
        return {
          ok: false,
          kind: "error",
          property: name,
          trace: traceTo(id),
          error,
          states: seen.size,
        };
      }
      if (!ok)
        return {
          ok: false,
          kind: "invariant",
          property: name,
          trace: traceTo(id),
          states: seen.size,
        };
    }
    return undefined;
  };

  for (const state of spec.init) {
    const id = key(state);
    if (seen.has(id)) continue;
    seen.set(id, { state, depth: 0, parent: undefined, action: "init" });
    const bad = violated(id);
    if (bad) return bad;
    queue.push(id);
  }

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const visit = seen.get(id)!;
    let steps: ReadonlyArray<Step<S>>;
    try {
      steps = spec.next(visit.state);
    } catch (error) {
      return {
        ok: false,
        kind: "error",
        property: "next",
        trace: traceTo(id),
        error,
        states: seen.size,
      };
    }
    if (steps.length === 0) {
      for (const [name, holds] of atEnd) {
        let ok: boolean;
        try {
          ok = holds(visit.state);
        } catch (error) {
          return {
            ok: false,
            kind: "error",
            property: name,
            trace: traceTo(id),
            error,
            states: seen.size,
          };
        }
        if (!ok)
          return {
            ok: false,
            kind: "atEnd",
            property: name,
            trace: traceTo(id),
            states: seen.size,
          };
      }
      continue;
    }
    if (visit.depth >= maxDepth) {
      exhaustive = false;
      continue;
    }
    for (const step of steps) {
      transitions++;
      const nextId = key(step.state);
      if (seen.has(nextId)) continue;
      if (seen.size >= maxStates) {
        exhaustive = false;
        continue;
      }
      seen.set(nextId, {
        state: step.state,
        depth: visit.depth + 1,
        parent: id,
        action: step.action,
      });
      depthReached = Math.max(depthReached, visit.depth + 1);
      const bad = violated(nextId);
      if (bad) return bad;
      queue.push(nextId);
    }
  }

  return { ok: true, states: seen.size, transitions, depth: depthReached, exhaustive };
};

/** A step a live system can take, named so a trace can be replayed by name. */
export interface Action<Sys> {
  readonly name: string;
  readonly run: (system: Sys) => Promise<void> | void;
}

/**
 * A system that cannot be cloned: services over SQLite, a git repo, fibers parked on gates. Every frontier node is
 * rebuilt by replaying its trace into a fresh `make()`, so `make`, `actions` and each action must be deterministic.
 */
export interface AsyncSpec<Sys, Obs> {
  readonly make: () => Promise<Sys> | Sys;
  /** The actions enabled right now. Names are unique within one call: a trace is a list of them. */
  readonly actions: (system: Sys, observation: Obs) => ReadonlyArray<Action<Sys>>;
  /** The abstract state that decides identity: durable rows, parked gates, model fields; never the heap. */
  readonly observe: (system: Sys) => Promise<Obs> | Obs;
  readonly key?: (observation: Obs) => string;
  readonly invariants?: Readonly<Record<string, (observation: Obs) => boolean>>;
  readonly atEnd?: Readonly<Record<string, (observation: Obs) => boolean>>;
  /**
   * Liveness by bound: from every reachable state, `drain` rounds make each predicate true within `drainRounds`
   * (default 10). A failure carries the trace to the stuck state plus the drain tail. Every state the drain passes
   * through is reachable too, so `invariants` are checked on each one: a break there is an "invariant" verdict whose
   * trace ends in the drain tail.
   */
  readonly eventually?: Readonly<Record<string, (observation: Obs) => boolean>>;
  /** One fair round: release every parked gate first in first out, move the clock past the next timer. Returns what it did; empty means nothing was left. */
  readonly drain?: (system: Sys) => Promise<ReadonlyArray<string>> | ReadonlyArray<string>;
  readonly drainRounds?: number;
  readonly maxDepth?: number;
  readonly maxStates?: number;
  readonly dispose?: (system: Sys) => Promise<void> | void;
}

/**
 * Model-guided: a pure reference model is the search state, and the real system is rebuilt along each new node's
 * trace to confirm it agrees. Cheaper than `checkAsync` when the model is small and the system is expensive.
 */
export interface GuidedSpec<M, Sys, Obs> {
  readonly model: Spec<M>;
  readonly make: () => Promise<Sys> | Sys;
  /** Runs the real step the model's action names. */
  readonly apply: (system: Sys, action: string) => Promise<void> | void;
  readonly observe: (system: Sys) => Promise<Obs> | Obs;
  readonly agrees: (observation: Obs, model: M) => boolean;
  readonly dispose?: (system: Sys) => Promise<void> | void;
}

interface Reached<S, Sys> {
  readonly action: string;
  readonly state: S;
  readonly system: Sys;
}

interface Problem<S> {
  readonly kind: Extract<Verdict<S>, { ok: false }>["kind"];
  readonly property: string;
  readonly tail?: ReadonlyArray<Step<S>>;
  readonly error?: unknown;
}

interface Search<S, Sys> {
  readonly key: (state: S) => string;
  readonly init: () => AsyncIterable<Reached<S, Sys>>;
  /** Successors of the node `trace` reaches. The iterable owns each yielded system and disposes it on resume. */
  readonly successors: (trace: ReadonlyArray<string>, state: S) => AsyncIterable<Reached<S, Sys>>;
  readonly invariants: ReadonlyArray<readonly [string, (state: S) => boolean]>;
  readonly atEnd: ReadonlyArray<readonly [string, (state: S) => boolean]>;
  /** Runs once per new node while its system is live. */
  readonly onNew?: (
    reached: Reached<S, Sys>,
    trace: ReadonlyArray<string>,
  ) => Promise<Problem<S> | undefined>;
  readonly maxDepth: number;
  readonly maxStates: number;
}

interface Exploration {
  readonly stop: AbortController;
  readonly over: Promise<void>;
}

/**
 * The exploration running in this process. Systems may own process globals (`VirtualTimers` patches setTimeout and
 * Date.now), so two explorations alive at once see each other's timers and report breaks neither system has. A test
 * runner runs a file's tests one at a time, so an exploration still going when the next check or replay starts belongs
 * to a test the runner gave up on (it timed out): the newer one stops it at its next step and waits until its system is
 * disposed. A step that never returns therefore holds every later check, which times out rather than report a break it
 * did not see. Checks started together (Promise.all, describe.concurrent) look the same: the later one stops the earlier.
 */
let exploring: Exploration | undefined;

/** Set while an exploration's own steps run: a check or replay started there would wait on the step that started it. */
const insideExploration = new AsyncLocalStorage<true>();

/**
 * Stops the exploration a timed-out test left running and waits until its live system is disposed. `self` becomes the
 * running exploration at once, before the wait, so a check started meanwhile stops it in turn.
 */
const takeTurn = async (self?: Exploration): Promise<void> => {
  if (insideExploration.getStore() === true) {
    throw new Error(
      "model check started inside another check's own steps (make, an action, observe, dispose); it would wait for that check forever",
    );
  }
  const previous = exploring;
  if (self !== undefined) exploring = self;
  if (previous === undefined) return;
  previous.stop.abort(
    new Error(
      "model check stopped: another check or replay started in this process while this one was still exploring (a test runner leaves a check running when its test times out; checks started together cannot share a process)",
    ),
  );
  await previous.over;
};

const explore = async <S, Sys>(search: Search<S, Sys>): Promise<Verdict<S>> => {
  const over = Promise.withResolvers<void>();
  const self: Exploration = { stop: new AbortController(), over: over.promise };
  try {
    await takeTurn(self);
    return await insideExploration.run(true, () => exploreAlone(search, self.stop.signal));
  } finally {
    if (exploring === self) exploring = undefined;
    over.resolve();
  }
};

const exploreAlone = async <S, Sys>(
  search: Search<S, Sys>,
  stop: AbortSignal,
): Promise<Verdict<S>> => {
  const seen = new Map<string, Visit<S> & { readonly trace: ReadonlyArray<string> }>();
  const queue: Array<string> = [];
  let transitions = 0;
  let depthReached = 0;
  let exhaustive = true;

  const failed = (id: string, problem: Problem<S>): Verdict<S> => ({
    ok: false,
    kind: problem.kind,
    property: problem.property,
    trace: [...traceIn(seen, id), ...(problem.tail ?? [])],
    ...(problem.error !== undefined ? { error: problem.error } : {}),
    states: seen.size,
  });

  const admit = async (
    reached: Reached<S, Sys>,
    parent: string | undefined,
  ): Promise<Verdict<S> | "seen" | "full" | "new"> => {
    const id = search.key(reached.state);
    if (seen.has(id)) return "seen";
    if (seen.size >= search.maxStates) return "full";
    const above = parent === undefined ? undefined : seen.get(parent)!;
    const depth = above === undefined ? 0 : above.depth + 1;
    const trace = above === undefined ? [] : [...above.trace, reached.action];
    seen.set(id, { state: reached.state, depth, parent, action: reached.action, trace });
    depthReached = Math.max(depthReached, depth);
    for (const [name, holds] of search.invariants) {
      let ok: boolean;
      try {
        ok = holds(reached.state);
      } catch (error) {
        return failed(id, { kind: "error", property: name, error });
      }
      if (!ok) return failed(id, { kind: "invariant", property: name });
    }
    if (search.onNew) {
      const problem = await search.onNew(reached, trace);
      if (problem) return failed(id, problem);
    }
    queue.push(id);
    return "new";
  };

  // Leaving a `for await` disposes the system the iterable yielded, so a stopped search breaks out before it throws.
  for await (const reached of search.init()) {
    if (stop.aborted) break;
    const outcome = await admit(reached, undefined);
    if (typeof outcome === "object") return outcome;
  }
  stop.throwIfAborted();

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const visit = seen.get(id)!;
    let count = 0;
    try {
      for await (const reached of search.successors(visit.trace, visit.state)) {
        if (stop.aborted) break;
        count++;
        if (visit.depth >= search.maxDepth) {
          exhaustive = false;
          break;
        }
        transitions++;
        const outcome = await admit(reached, id);
        if (outcome === "full") exhaustive = false;
        if (typeof outcome === "object") return outcome;
      }
    } catch (error) {
      return failed(id, { kind: "error", property: "next", error });
    }
    stop.throwIfAborted();
    if (count > 0) continue;
    for (const [name, holds] of search.atEnd) {
      let ok: boolean;
      try {
        ok = holds(visit.state);
      } catch (error) {
        return failed(id, { kind: "error", property: name, error });
      }
      if (!ok) return failed(id, { kind: "atEnd", property: name });
    }
  }

  return { ok: true, states: seen.size, transitions, depth: depthReached, exhaustive };
};

const applyAction = async <Sys, Obs>(
  spec: AsyncSpec<Sys, Obs>,
  system: Sys,
  name: string,
): Promise<Obs> => {
  const observation = await spec.observe(system);
  const action = spec.actions(system, observation).find((candidate) => candidate.name === name);
  if (action === undefined) {
    throw new Error(
      `"${name}" is not enabled here: the system is not deterministic, or the trace is stale`,
    );
  }
  await action.run(system);
  return spec.observe(system);
};

export const checkAsync = async <Sys, Obs>(spec: AsyncSpec<Sys, Obs>): Promise<Verdict<Obs>> => {
  const dispose = spec.dispose ?? (() => {});
  const eventually = Object.entries(spec.eventually ?? {});
  const drain = spec.drain;
  if (eventually.length > 0 && drain === undefined) throw new Error("eventually needs a drain");
  const drainRounds = spec.drainRounds ?? 10;

  const rebuild = async (trace: ReadonlyArray<string>): Promise<Sys> => {
    const system = await spec.make();
    try {
      for (const name of trace) await applyAction(spec, system, name);
    } catch (error) {
      await dispose(system);
      throw error;
    }
    return system;
  };

  const invariants = Object.entries(spec.invariants ?? {});
  return explore<Obs, Sys>({
    key: spec.key ?? canonicalKey,
    invariants,
    atEnd: Object.entries(spec.atEnd ?? {}),
    maxDepth: spec.maxDepth ?? Number.POSITIVE_INFINITY,
    maxStates: spec.maxStates ?? 100_000,
    init: async function* () {
      const system = await spec.make();
      try {
        yield { action: "init", state: await spec.observe(system), system };
      } finally {
        await dispose(system);
      }
    },
    successors: async function* (trace) {
      let system = await rebuild(trace);
      try {
        const names = spec.actions(system, await spec.observe(system)).map((action) => action.name);
        for (const [index, name] of names.entries()) {
          if (index > 0) {
            await dispose(system);
            system = await rebuild(trace);
          }
          yield { action: name, state: await applyAction(spec, system, name), system };
        }
      } finally {
        await dispose(system);
      }
    },
    ...(eventually.length === 0
      ? {}
      : {
          onNew: async (reached) => {
            let pending = eventually.filter(([, holds]) => !holds(reached.state));
            const tail: Array<Step<Obs>> = [];
            for (let round = 1; round <= drainRounds && pending.length > 0; round++) {
              const did = await drain!(reached.system);
              const state = await spec.observe(reached.system);
              tail.push({
                action:
                  did.length === 0
                    ? `drain ${round}: nothing left`
                    : `drain ${round}: ${did.join(", ")}`,
                state,
              });
              for (const [name, holds] of invariants) {
                let ok: boolean;
                try {
                  ok = holds(state);
                } catch (error) {
                  return { kind: "error", property: name, tail, error };
                }
                if (!ok) return { kind: "invariant", property: name, tail };
              }
              pending = pending.filter(([, holds]) => !holds(state));
              if (did.length === 0) break;
            }
            return pending.length === 0
              ? undefined
              : { kind: "eventually", property: pending[0]![0], tail };
          },
        }),
  });
};

export const checkGuided = async <M, Sys, Obs>(
  spec: GuidedSpec<M, Sys, Obs>,
): Promise<Verdict<M>> => {
  const dispose = spec.dispose ?? (() => {});
  const model = spec.model;
  return explore<M, undefined>({
    key: model.key ?? canonicalKey,
    invariants: Object.entries(model.invariants ?? {}),
    atEnd: Object.entries(model.atEnd ?? {}),
    maxDepth: model.maxDepth ?? Number.POSITIVE_INFINITY,
    maxStates: model.maxStates ?? 1_000_000,
    init: async function* () {
      for (const state of model.init) yield { action: "init", state, system: undefined };
    },
    successors: async function* (_trace, state) {
      for (const step of model.next(state))
        yield { action: step.action, state: step.state, system: undefined };
    },
    onNew: async (reached, trace) => {
      const system = await spec.make();
      try {
        for (const name of trace) await spec.apply(system, name);
        const observation = await spec.observe(system);
        if (spec.agrees(observation, reached.state)) return undefined;
        return { kind: "conformance", property: "agrees", error: observation };
      } finally {
        await dispose(system);
      }
    },
  });
};

/**
 * Reruns a trace (the verdict's, or its action names) against a fresh real system and hands it back live, with the
 * observation after each step: a found bug pasted into a regression test. The caller disposes the system. Like a check,
 * it first stops a check a timed-out test left running.
 */
export const replay = async <Sys, Obs>(
  spec: Pick<AsyncSpec<Sys, Obs>, "make" | "actions" | "observe">,
  trace: ReadonlyArray<string | Step<unknown>>,
): Promise<{ readonly system: Sys; readonly steps: ReadonlyArray<Step<Obs>> }> => {
  await takeTurn();
  const system = await spec.make();
  const steps: Array<Step<Obs>> = [{ action: "init", state: await spec.observe(system) }];
  for (const step of trace) {
    const name = typeof step === "string" ? step : step.action;
    if (name === "init") continue;
    steps.push({ action: name, state: await applyAction(spec, system, name) });
  }
  return { system, steps };
};

/** Throws a readable error naming the broken property and the shortest trace to it. */
export const assertHolds = <S>(
  verdict: Verdict<S>,
  options: { readonly show?: (state: S) => string; readonly requireExhaustive?: boolean } = {},
): void => {
  if (verdict.ok) {
    if (options.requireExhaustive !== false && !verdict.exhaustive) {
      throw new Error(
        `model check hit its bound after ${verdict.states} states; raise maxDepth/maxStates or pass requireExhaustive: false`,
      );
    }
    return;
  }
  const lines = [
    `${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps:`,
  ];
  lines.push(formatTrace(verdict.trace, options.show));
  if (verdict.error !== undefined) lines.push(`error: ${String(verdict.error)}`);
  throw new Error(lines.join("\n"));
};

export const formatTrace = <S>(
  trace: ReadonlyArray<Step<S>>,
  show: (state: S) => string = canonicalKey,
): string =>
  trace.map((step, index) => `  ${index}. ${step.action}\n     ${show(step.state)}`).join("\n");

/**
 * Every merge of the threads that keeps each thread's own order: the schedules a set of concurrent actors can run
 * in when each step is atomic.
 */
export function* interleavings<T>(threads: ReadonlyArray<ReadonlyArray<T>>): Generator<Array<T>> {
  const positions = threads.map(() => 0);
  const total = threads.reduce((sum, thread) => sum + thread.length, 0);
  const schedule: Array<T> = [];
  function* go(): Generator<Array<T>> {
    if (schedule.length === total) {
      yield [...schedule];
      return;
    }
    for (let index = 0; index < threads.length; index++) {
      const thread = threads[index]!;
      const at = positions[index]!;
      if (at >= thread.length) continue;
      positions[index] = at + 1;
      schedule.push(thread[at]!);
      yield* go();
      schedule.pop();
      positions[index] = at;
    }
  }
  yield* go();
}

/** The schedule cut after each prefix: where a crash can land between atomic steps, including before the first. */
export function* crashPoints<T>(
  schedule: ReadonlyArray<T>,
): Generator<{ readonly ran: Array<T>; readonly lost: Array<T> }> {
  for (let cut = 0; cut <= schedule.length; cut++) {
    yield { ran: schedule.slice(0, cut), lost: schedule.slice(cut) };
  }
}

/** Every sequence of length 0..maxLength drawn from the alphabet, shortest first. */
export function* sequences<T>(alphabet: ReadonlyArray<T>, maxLength: number): Generator<Array<T>> {
  let layer: Array<Array<T>> = [[]];
  yield [];
  for (let length = 1; length <= maxLength; length++) {
    const nextLayer: Array<Array<T>> = [];
    for (const prefix of layer) {
      for (const symbol of alphabet) {
        const sequence = [...prefix, symbol];
        nextLayer.push(sequence);
        yield sequence;
      }
    }
    layer = nextLayer;
  }
}

/** A deterministic identity for plain data: object keys sorted, Map and Set entries sorted, bigint and undefined kept. */
export const canonicalKey = (value: unknown): string => {
  const encode = (input: unknown): string => {
    if (input === undefined) return "u";
    if (input === null) return "n";
    switch (typeof input) {
      case "string":
        return JSON.stringify(input);
      case "number":
        return Object.is(input, -0) ? "-0" : String(input);
      case "boolean":
        return input ? "t" : "f";
      case "bigint":
        return `${input}n`;
      case "object":
        break;
      default:
        throw new TypeError(`canonicalKey cannot encode a ${typeof input}`);
    }
    if (Array.isArray(input)) return `[${input.map(encode).join(",")}]`;
    if (input instanceof Map) {
      const entries = [...input.entries()].map(([k, v]) => [encode(k), encode(v)] as const);
      entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `M{${entries.map(([k, v]) => `${k}:${v}`).join(",")}}`;
    }
    if (input instanceof Set) {
      const items = [...input].map(encode).sort();
      return `S{${items.join(",")}}`;
    }
    if (input instanceof Date) return `D${input.toISOString()}`;
    const record = input as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${encode(record[k])}`).join(",")}}`;
  };
  return encode(value);
};
