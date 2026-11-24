import { describe, expect, it } from "vitest";

import {
  assertHolds,
  canonicalKey,
  check,
  checkAsync,
  checkGuided,
  crashPoints,
  interleavings,
  replay,
  sequences,
  type AsyncSpec,
  type Spec,
  type Step,
} from "./index.ts";

interface Counter {
  readonly x: number;
  readonly pc: readonly [number, number];
  readonly local: readonly [number, number];
}

const counterSpec = (atomic: boolean): Spec<Counter> => ({
  init: [{ x: 0, pc: [0, 0], local: [0, 0] }],
  next: (s) => {
    const steps: Array<Step<Counter>> = [];
    for (const t of [0, 1] as const) {
      const pc = [...s.pc] as [number, number];
      const local = [...s.local] as [number, number];
      if (atomic && s.pc[t] === 0) {
        pc[t] = 2;
        steps.push({ action: `t${t} increment`, state: { x: s.x + 1, pc, local } });
      } else if (!atomic && s.pc[t] === 0) {
        pc[t] = 1;
        local[t] = s.x;
        steps.push({ action: `t${t} read`, state: { x: s.x, pc, local } });
      } else if (!atomic && s.pc[t] === 1) {
        pc[t] = 2;
        steps.push({ action: `t${t} write`, state: { x: s.local[t] + 1, pc, local } });
      }
    }
    return steps;
  },
  atEnd: { "both increments land": (s) => s.x === 2 },
});

describe("check", () => {
  it("finds the lost update in a non-atomic read-modify-write, as the shortest trace", () => {
    const verdict = check(counterSpec(false));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("atEnd");
    expect(verdict.property).toBe("both increments land");
    expect(verdict.trace.map((step) => step.action)).toEqual([
      "init",
      "t0 read",
      "t1 read",
      "t0 write",
      "t1 write",
    ]);
    expect(() => assertHolds(verdict)).toThrow(/atEnd "both increments land" broken after 4 steps/);
  });

  it("passes the atomic increment and visits every reachable state once", () => {
    const verdict = check(counterSpec(true));
    expect(verdict).toEqual({ ok: true, states: 4, transitions: 4, depth: 2, exhaustive: true });
    expect(() => assertHolds(verdict)).not.toThrow();
  });

  it("checks invariants on initial states", () => {
    const verdict = check({
      init: [-1],
      next: () => [],
      invariants: { nonNegative: (n: number) => n >= 0 },
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.trace).toEqual([{ action: "init", state: -1 }]);
  });

  it("says when a bound cut the search short, and assertHolds refuses that by default", () => {
    const verdict = check({
      init: [0],
      next: (n: number) => [{ action: "inc", state: n + 1 }],
      maxDepth: 5,
    });
    expect(verdict).toMatchObject({ ok: true, exhaustive: false, states: 6 });
    expect(() => assertHolds(verdict)).toThrow(/hit its bound/);
    expect(() => assertHolds(verdict, { requireExhaustive: false })).not.toThrow();
  });

  it("reports a throwing step as an error with the trace that reached it", () => {
    const verdict = check({
      init: [0],
      next: (n: number) => {
        if (n === 2) throw new Error("boom");
        return [{ action: "inc", state: n + 1 }];
      },
    });
    expect(verdict).toMatchObject({ ok: false, kind: "error", property: "next" });
    if (!verdict.ok) expect(verdict.trace.map((step) => step.state)).toEqual([0, 1, 2]);
  });
});

describe("schedules", () => {
  it("interleavings keep each thread's order and cover every merge", () => {
    const all = [
      ...interleavings([
        ["a1", "a2"],
        ["b1", "b2"],
      ]),
    ];
    expect(all).toHaveLength(6);
    expect(new Set(all.map((s) => s.join(" "))).size).toBe(6);
    for (const schedule of all) {
      expect(schedule.indexOf("a1")).toBeLessThan(schedule.indexOf("a2"));
      expect(schedule.indexOf("b1")).toBeLessThan(schedule.indexOf("b2"));
    }
  });

  it("crashPoints cut before the first step, between steps and after the last", () => {
    expect([...crashPoints([1, 2])]).toEqual([
      { ran: [], lost: [1, 2] },
      { ran: [1], lost: [2] },
      { ran: [1, 2], lost: [] },
    ]);
  });

  it("sequences enumerate every word up to the length, shortest first", () => {
    const all = [...sequences(["x", "y"], 2)];
    expect(all).toEqual([[], ["x"], ["y"], ["x", "x"], ["x", "y"], ["y", "x"], ["y", "y"]]);
  });
});

describe("canonicalKey", () => {
  it("ignores object key order and Map/Set insertion order", () => {
    expect(canonicalKey({ a: 1, b: [2, 3] })).toBe(canonicalKey({ b: [2, 3], a: 1 }));
    expect(
      canonicalKey(
        new Map([
          ["x", 1],
          ["y", 2],
        ]),
      ),
    ).toBe(
      canonicalKey(
        new Map([
          ["y", 2],
          ["x", 1],
        ]),
      ),
    );
    expect(canonicalKey(new Set([1, 2]))).toBe(canonicalKey(new Set([2, 1])));
  });

  it("tells apart values JSON would merge", () => {
    expect(canonicalKey("1")).not.toBe(canonicalKey(1));
    expect(canonicalKey([undefined])).not.toBe(canonicalKey([null]));
    expect(canonicalKey(1n)).not.toBe(canonicalKey(1));
    expect(canonicalKey(new Set([1]))).not.toBe(canonicalKey([1]));
  });
});

describe("checkAsync", () => {
  /** A counter that cannot be cloned: steps mutate it, and `stuck` stops it short of the goal. */
  interface Tally {
    n: number;
    stuck: boolean;
  }
  const tally = (
    options: {
      readonly stuckAt?: number;
      readonly maxDepth?: number;
      readonly never?: number;
    } = {},
  ): AsyncSpec<Tally, { readonly n: number; readonly stuck: boolean }> => ({
    make: () => ({ n: 0, stuck: false }),
    actions: (system) =>
      system.stuck || system.n >= 3
        ? []
        : [
            { name: "inc", run: () => void system.n++ },
            ...(system.n === options.stuckAt
              ? [{ name: "jam", run: () => void (system.stuck = true) }]
              : []),
          ],
    observe: (system) => ({ n: system.n, stuck: system.stuck }),
    eventually: { "reaches 3": (o) => o.n === 3 },
    ...(options.never === undefined
      ? {}
      : { invariants: { [`never ${options.never}`]: (o) => o.n !== options.never } }),
    drain: (system) => {
      if (system.stuck || system.n >= 3) return [];
      system.n++;
      return ["inc"];
    },
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });

  it("explores a system by replaying traces into fresh instances", async () => {
    const verdict = await checkAsync(tally());
    expect(verdict).toEqual({ ok: true, states: 4, transitions: 3, depth: 3, exhaustive: true });
  });

  it("reports a stuck state with the drain tail that failed to make progress", async () => {
    const verdict = await checkAsync(tally({ stuckAt: 1 }));
    expect(verdict).toMatchObject({ ok: false, kind: "eventually", property: "reaches 3" });
    if (verdict.ok) return;
    expect(verdict.trace.map((step) => step.action)).toEqual([
      "init",
      "inc",
      "jam",
      "drain 1: nothing left",
    ]);
  });

  it("checks invariants on the states a drain passes through", async () => {
    // maxDepth 1 explores n = 0 and 1 only, where "never 2" holds; the init state's drain passes through 2 on its way to 3.
    const verdict = await checkAsync(tally({ maxDepth: 1, never: 2 }));
    expect(verdict).toMatchObject({ ok: false, kind: "invariant", property: "never 2" });
    if (verdict.ok) return;
    expect(verdict.trace.map((step) => step.action)).toEqual([
      "init",
      "drain 1: inc",
      "drain 2: inc",
    ]);
  });

  it("marks a search cut by maxDepth as not exhaustive", async () => {
    const verdict = await checkAsync(tally({ maxDepth: 1 }));
    expect(verdict).toMatchObject({ ok: true, exhaustive: false, states: 2 });
  });

  it("replay refuses a trace the system no longer offers", async () => {
    await expect(replay(tally(), ["inc", "jam"])).rejects.toThrow(/"jam" is not enabled here/);
    const rerun = await replay(tally(), ["inc", "inc"]);
    expect(rerun.system.n).toBe(2);
    expect(rerun.steps.map((step) => step.state.n)).toEqual([0, 1, 2]);
  });
});

describe("checkGuided", () => {
  const model: Spec<number> = {
    init: [0],
    next: (n) => (n >= 2 ? [] : [{ action: "inc", state: n + 1 }]),
  };

  it("passes a real system that agrees with the model on every new node", async () => {
    const verdict = await checkGuided({
      model,
      make: () => ({ n: 0 }),
      apply: (system, action) => void (action === "inc" && system.n++),
      observe: (system) => system.n,
      agrees: (observed, expected) => observed === expected,
    });
    expect(verdict).toEqual({ ok: true, states: 3, transitions: 2, depth: 2, exhaustive: true });
  });

  it("reports the model trace where the real system diverges", async () => {
    const verdict = await checkGuided({
      model,
      make: () => ({ n: 0 }),
      apply: (system, action) => void (action === "inc" && (system.n += system.n === 1 ? 2 : 1)),
      observe: (system) => system.n,
      agrees: (observed, expected) => observed === expected,
    });
    expect(verdict).toMatchObject({ ok: false, kind: "conformance", property: "agrees", error: 3 });
    if (!verdict.ok) expect(verdict.trace.map((step) => step.state)).toEqual([0, 1, 2]);
  });
});
