import { describe, expect, it } from "vitest";

import {
  assertHolds,
  checkAsync,
  GateQueue,
  macrotask,
  replay,
  VirtualTimers,
  type AsyncSpec,
} from "./index.ts";

/** Retries a send after a timeout; the seeded bug lets a late answer to an earlier attempt report a second result. */
const sendWithRetry = (
  send: (attempt: number) => Promise<string>,
  onResult: (result: string) => void,
  options: { readonly timeoutMs: number; readonly attempts: number; readonly fixed: boolean },
): void => {
  const startedAt = Date.now();
  let settled = false;
  const finish = (result: string) => {
    if (options.fixed && settled) return;
    settled = true;
    onResult(`${result} after ${Date.now() - startedAt}ms`);
  };
  const attempt = (n: number) => {
    const timer = setTimeout(
      () => (n < options.attempts ? attempt(n + 1) : finish("timeout")),
      options.timeoutMs,
    );
    void send(n).then((answer) => {
      clearTimeout(timer);
      finish(answer);
    });
  };
  attempt(1);
};

interface Retrying {
  readonly timers: VirtualTimers;
  readonly gates: GateQueue;
  readonly results: Array<string>;
  readonly restore: () => void;
}

const ADVANCE = "clock: fire the next timer";

const spec = (fixed: boolean): AsyncSpec<Retrying, object> => ({
  make: async () => {
    const timers = new VirtualTimers();
    const gates = new GateQueue();
    const results: Array<string> = [];
    const restore = timers.install();
    sendWithRetry(
      (n) => gates.park(`answer ${n}`).then(() => `ok${n}`),
      (r) => results.push(r),
      {
        timeoutMs: 100,
        attempts: 2,
        fixed,
      },
    );
    await timers.settle();
    return { timers, gates, results, restore };
  },
  actions: (system) => [
    ...system.gates.parked().map((name) => ({
      name,
      run: async () => {
        system.gates.release(name);
        await system.timers.settle();
      },
    })),
    ...(system.timers.nextAt() === undefined
      ? []
      : [{ name: ADVANCE, run: () => system.timers.advanceToNext().then(() => {}) }]),
  ],
  observe: (system) => ({
    results: system.results,
    parked: system.gates.parked(),
    timers: system.timers.pending().map((timer) => timer.at),
    now: system.timers.now,
  }),
  invariants: { "at most one result": (o: any) => o.results.length <= 1 },
  atEnd: { "exactly one result": (o: any) => o.results.length === 1 },
  dispose: (system) => system.restore(),
});

describe("the timer scheduler", () => {
  it("finds the double fire when a late answer lands after the retry timer", async () => {
    const verdict = await checkAsync(spec(false));
    expect(verdict).toMatchObject({ ok: false, kind: "invariant", property: "at most one result" });
    if (verdict.ok) return;
    expect(verdict.trace.map((step) => step.action)).toEqual([
      "init",
      ADVANCE,
      "answer 1",
      "answer 2",
    ]);
    expect((verdict.trace.at(-1)!.state as any).results).toEqual([
      "ok1 after 100ms",
      "ok2 after 100ms",
    ]);
  });

  it("passes the helper that ignores answers after it settled", async () => {
    const verdict = await checkAsync(spec(true));
    expect(() => assertHolds(verdict)).not.toThrow();
    expect(verdict).toMatchObject({ ok: true, exhaustive: true });
  });

  it("a check left running by a timed-out test stops when the next check starts, and the next one never sees its timers", async () => {
    const realSetTimeout = globalThis.setTimeout;
    // Nothing awaits this check any more, as after a vitest timeout; it is mid-exploration with its clock installed.
    const abandoned = checkAsync(spec(true)).then(
      (verdict) => verdict,
      (error: Error) => error.message,
    );
    await macrotask();
    const verdict = await checkAsync(spec(true));
    expect(verdict).toMatchObject({ ok: true, exhaustive: true });
    expect(await abandoned).toMatch(/another check or replay started in this process/);
    expect(globalThis.setTimeout).toBe(realSetTimeout);
  });

  it("a check left running by a timed-out test stops before a replay makes its system, which keeps its own clock", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const abandoned = checkAsync(spec(true)).then(
      (verdict) => verdict,
      (error: Error) => error.message,
    );
    await macrotask();
    const rerun = await replay(spec(true), ["answer 1"]);
    // The caller drives the replayed system on, as replayToQuiet drains it.
    await macrotask();
    const clock = Date.now === rerun.system.timers.dateNow ? "the replayed system's" : "another";
    rerun.system.restore();
    expect({ results: rerun.system.results, clock }).toEqual({
      results: ["ok1 after 0ms"],
      clock: "the replayed system's",
    });
    expect(await abandoned).toMatch(/another check or replay started in this process/);
    expect(globalThis.setTimeout).toBe(realSetTimeout);
  });

  it("a check started inside another check's step fails at once instead of waiting on that check forever", async () => {
    const inner: Array<unknown> = [];
    const outer = await checkAsync<object, object>({
      make: async () => {
        if (inner.length > 0) return {};
        await checkAsync(spec(true)).then(
          (verdict) => inner.push(verdict),
          (error: Error) => inner.push(error.message),
        );
        await replay(spec(true), []).then(
          ({ system }) => (system.restore(), inner.push("replayed")),
          (error: Error) => inner.push(error.message),
        );
        return {};
      },
      actions: () => [],
      observe: () => ({}),
    });
    expect(outer).toMatchObject({ ok: true, exhaustive: true });
    expect(inner).toEqual([
      expect.stringMatching(/started inside another check's own steps/),
      expect.stringMatching(/started inside another check's own steps/),
    ]);
  });

  it("a second clock refuses the globals while another owns them, and a restore called twice leaves the next clock's alone", () => {
    const before = globalThis.setTimeout;
    const first = new VirtualTimers();
    const restoreFirst = first.install();
    expect(() => new VirtualTimers().install()).toThrow(
      /another VirtualTimers still owns the global timers/,
    );
    expect(globalThis.setTimeout).toBe(first.setTimeout);
    restoreFirst();
    const second = new VirtualTimers();
    const restoreSecond = second.install();
    restoreFirst();
    expect(globalThis.setTimeout).toBe(second.setTimeout);
    restoreSecond();
    expect(globalThis.setTimeout).toBe(before);
  });

  it("a system made outside the checker while a timed-out test's check still runs fails instead of sharing its clock", async () => {
    const realSetTimeout = globalThis.setTimeout;
    const abandoned = checkAsync(spec(true)).then(
      (verdict) => verdict,
      (error: Error) => error.message,
    );
    await macrotask();
    await expect(Promise.resolve(spec(true).make())).rejects.toThrow(
      /another VirtualTimers still owns the global timers/,
    );
    expect(await checkAsync(spec(true))).toMatchObject({ ok: true, exhaustive: true });
    expect(await abandoned).toMatch(/another check or replay started in this process/);
    expect(globalThis.setTimeout).toBe(realSetTimeout);
  });

  it("restores the real timers after each system is disposed", () => {
    const timers = new VirtualTimers();
    const before = globalThis.setTimeout;
    const restore = timers.install();
    expect(globalThis.setTimeout).not.toBe(before);
    restore();
    expect(globalThis.setTimeout).toBe(before);
  });

  it("runs zero-delay timers on settle, fires intervals repeatedly, and clears cancelled ones", async () => {
    const timers = new VirtualTimers(1_000);
    const fired: Array<string> = [];
    timers.setTimeout(() => fired.push(`soon@${timers.now}`), 0);
    const every = timers.setInterval(() => fired.push(`tick@${timers.now}`), 10);
    const cancelled = timers.setTimeout(() => fired.push("never"), 5);
    timers.clearTimeout(cancelled);
    await timers.settle();
    expect(fired).toEqual(["soon@1000"]);
    await timers.advanceBy(25);
    expect(fired).toEqual(["soon@1000", "tick@1010", "tick@1020"]);
    expect(timers.now).toBe(1025);
    timers.clearInterval(every);
    expect(timers.pending()).toEqual([]);
  });
});
