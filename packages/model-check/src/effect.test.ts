import * as KeyedLock from "@caveman-app/shared/KeyedLock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import { ADVANCE_CLOCK, gate, harnessActions, openHarness, type Harness } from "./effect.ts";
import { assertHolds, checkAsync, FaultPlan, macrotask, replay, type AsyncSpec } from "./index.ts";

describe("gates find a lost update between two fibers", () => {
  const counter = (
    atomic: boolean,
  ): AsyncSpec<Harness<Ref.Ref<number>>, { readonly x: number }> => ({
    make: async () => {
      const harness = await openHarness(Ref.make(0));
      for (const t of [0, 1]) {
        harness.fork(
          `t${t}`,
          atomic
            ? gate(`t${t} increment`).pipe(Effect.andThen(Ref.update(harness.value, (n) => n + 1)))
            : Effect.gen(function* () {
                const n = yield* Ref.get(harness.value);
                yield* gate(`t${t} write`);
                yield* Ref.set(harness.value, n + 1);
              }),
        );
      }
      await harness.settle();
      return harness;
    },
    actions: harnessActions,
    observe: async (harness) => ({
      x: await harness.run(Ref.get(harness.value)),
      ...harness.snapshot(),
    }),
    atEnd: { "both increments land": (o) => o.x === 2 },
    dispose: (harness) => harness.close(),
  });

  it("reports the shortest schedule that loses an increment, and replay reproduces it", async () => {
    const verdict = await checkAsync(counter(false));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.kind).toBe("atEnd");
    expect(verdict.trace.map((step) => step.action)).toEqual(["init", "t0 write", "t1 write"]);
    expect(verdict.trace.map((step) => step.state.x)).toEqual([0, 1, 1]);

    const rerun = await replay(counter(false), verdict.trace);
    expect(rerun.steps.at(-1)?.state.x, "the real system loses the increment again").toBe(1);
    await rerun.system.close();
  });

  it("passes the atomic update over every schedule", async () => {
    const verdict = await checkAsync(counter(true));
    expect(verdict).toMatchObject({ ok: true, exhaustive: true });
    expect(() => assertHolds(verdict)).not.toThrow();
  });
});

describe("the runtime's KeyedLock", () => {
  interface Workers {
    readonly harness: Harness<KeyedLock.KeyedLock<string>>;
    readonly holding: Map<string, string>;
  }
  const workers = [
    ["w0", "a"],
    ["w1", "a"],
    ["w2", "b"],
  ] as const;

  const spec = (
    lockOf: (real: KeyedLock.KeyedLock<string>) => KeyedLock.KeyedLock<string>,
  ): AsyncSpec<Workers, object> => ({
    make: async () => {
      const harness = await openHarness(KeyedLock.make<string>());
      const lock = lockOf(harness.value);
      const holding = new Map<string, string>();
      for (const [name, key] of workers) {
        harness.fork(
          name,
          Effect.gen(function* () {
            yield* gate(`${name} wants ${key}`);
            yield* lock.withLock(
              key,
              Effect.gen(function* () {
                holding.set(name, key);
                yield* gate(`${name} holds ${key}`);
                holding.delete(name);
              }),
            );
          }),
        );
      }
      await harness.settle();
      return { harness, holding };
    },
    actions: ({ harness }) => harnessActions(harness),
    observe: async ({ harness, holding }) => ({
      holding: [...holding.entries()].sort(),
      active: [...(await harness.run(harness.value.activeKeys))].sort(),
      ...harness.snapshot(),
    }),
    invariants: {
      "one holder per key": (o: any) =>
        new Set(o.holding.map(([, key]: [string, string]) => key)).size === o.holding.length,
    },
    atEnd: {
      "no leaked entries": (o: any) => o.active.length === 0,
    },
    eventually: {
      "every worker finishes": (o: any) =>
        Object.values(o.fibers).every((status) => status === "done"),
    },
    drain: ({ harness }) => harness.fairRound(),
    dispose: ({ harness }) => harness.close(),
  });

  it("gives mutual exclusion per key, leaks no entry and lets every waiter through", async () => {
    const verdict = await checkAsync(spec((real) => real));
    expect(() => assertHolds(verdict)).not.toThrow();
    expect(verdict).toMatchObject({ ok: true, exhaustive: true });
    if (verdict.ok) expect(verdict.states).toBeGreaterThan(20);
  });

  it("would catch a lock that does not lock", async () => {
    const verdict = await checkAsync(
      spec((real) => ({ ...real, withLock: (_key, effect) => effect })),
    );
    expect(verdict).toMatchObject({ ok: false, kind: "invariant", property: "one holder per key" });
    // The init state's fair drain lets both a-workers in at once, so the break shows in its tail.
    if (!verdict.ok)
      expect(verdict.trace.map((step) => step.action)).toEqual([
        "init",
        "drain 1: w0 wants a, w1 wants a, w2 wants b",
      ]);
  });
});

describe("a SQLite-backed queue across crashes and faults", () => {
  interface Queue {
    readonly db: DatabaseSync;
    readonly faults: FaultPlan;
    harness: Harness<void>;
    crashes: number;
    faultsArmed: number;
  }
  interface Variant {
    readonly recovers: boolean;
    readonly transactional: boolean;
  }

  const statement = (queue: Queue, sql: string, ...params: Array<number>) => {
    queue.faults.hit();
    return queue.db.prepare(sql).all(...params) as Array<{ id: number }>;
  };

  const worker = (queue: Queue, variant: Variant) =>
    Effect.gen(function* () {
      while (true) {
        yield* gate("claim");
        const claimed = yield* Effect.try(() => {
          const [next] = statement(
            queue,
            "SELECT id FROM jobs WHERE status = 'pending' ORDER BY id LIMIT 1",
          );
          if (next === undefined) return undefined;
          statement(queue, "UPDATE jobs SET status = 'running' WHERE id = ?", next.id);
          return next.id;
        }).pipe(Effect.option);
        if (claimed._tag === "None") continue;
        if (claimed.value === undefined) return;
        const id = claimed.value;
        while (true) {
          yield* gate(`work ${id}`);
          const finished = yield* Effect.try(() => {
            if (variant.transactional) queue.db.exec("BEGIN");
            try {
              statement(queue, "UPDATE jobs SET status = 'done' WHERE id = ?", id);
              statement(queue, "INSERT INTO log (job) VALUES (?)", id);
              if (variant.transactional) queue.db.exec("COMMIT");
            } catch (error) {
              if (variant.transactional) queue.db.exec("ROLLBACK");
              throw error;
            }
          }).pipe(Effect.isSuccess);
          if (finished) break;
        }
      }
    });

  const boot = async (queue: Queue, variant: Variant) => {
    queue.harness = await openHarness(Effect.void);
    if (variant.recovers)
      queue.db.exec("UPDATE jobs SET status = 'pending' WHERE status = 'running'");
    queue.harness.fork("worker", worker(queue, variant));
    await queue.harness.settle();
  };

  const spec = (variant: Variant): AsyncSpec<Queue, object> => ({
    make: async () => {
      const db = new DatabaseSync(":memory:");
      db.exec(
        "CREATE TABLE jobs (id INTEGER PRIMARY KEY, status TEXT NOT NULL); CREATE TABLE log (job INTEGER NOT NULL)",
      );
      db.exec("INSERT INTO jobs (status) VALUES ('pending'), ('pending')");
      const queue: Queue = {
        db,
        faults: new FaultPlan(),
        harness: undefined as never,
        crashes: 0,
        faultsArmed: 0,
      };
      await boot(queue, variant);
      return queue;
    },
    actions: (queue) => [
      ...harnessActions<Queue>(queue.harness),
      ...(queue.crashes < 1
        ? [
            {
              name: "crash",
              run: async () => {
                await queue.harness.close();
                queue.crashes++;
                await boot(queue, variant);
              },
            },
          ]
        : []),
      ...(queue.faultsArmed < 1 && queue.faults.pending === undefined
        ? [1, 2].map((k) => ({
            name: `fault: statement +${k} fails`,
            run: () => {
              queue.faults.arm(k);
              queue.faultsArmed++;
            },
          }))
        : []),
    ],
    observe: (queue) => ({
      jobs: queue.db.prepare("SELECT id, status FROM jobs ORDER BY id").all(),
      log: queue.db.prepare("SELECT job FROM log ORDER BY rowid").all(),
      crashes: queue.crashes,
      fault: queue.faults.pending ?? null,
      faultsArmed: queue.faultsArmed,
      ...queue.harness.snapshot(),
    }),
    invariants: {
      "a done job is logged exactly once, and only done jobs are logged": (o: any) => {
        const done = o.jobs.filter((job: any) => job.status === "done").map((job: any) => job.id);
        const logged = o.log.map((row: any) => row.job);
        return (
          done.length === logged.length &&
          done.every((id: number) => logged.filter((j: number) => j === id).length === 1)
        );
      },
    },
    atEnd: { "every job is done": (o: any) => o.jobs.every((job: any) => job.status === "done") },
    dispose: (queue) => queue.harness.close(),
  });

  it("finds the job a crash leaves running forever when recovery forgets to reset it", async () => {
    const verdict = await checkAsync(spec({ recovers: false, transactional: true }));
    expect(verdict).toMatchObject({ ok: false, kind: "atEnd", property: "every job is done" });
    if (verdict.ok) return;
    expect(verdict.trace.map((step) => step.action)).toContain("crash");
    const end = verdict.trace.at(-1)!.state as any;
    expect(
      end.jobs.map((job: any) => job.status),
      "the crashed job is still running with nobody to finish it",
    ).toContain("running");
    expect(end.fibers, "the restarted worker found nothing pending and left").toEqual({
      worker: "done",
    });
  });

  it("finds the half-finished job a fault leaves behind without a transaction", async () => {
    const verdict = await checkAsync(spec({ recovers: true, transactional: false }));
    expect(verdict).toMatchObject({ ok: false, kind: "invariant" });
    if (verdict.ok) return;
    expect(verdict.trace.map((step) => step.action)).toContain("fault: statement +2 fails");
  });

  it("passes the queue that resets running jobs on boot and finishes in a transaction", async () => {
    const verdict = await checkAsync(spec({ recovers: true, transactional: true }));
    expect(() => assertHolds(verdict)).not.toThrow();
    expect(verdict).toMatchObject({ ok: true, exhaustive: true });
  });
});

describe("the virtual clock", () => {
  it("wakes sleepers only when the checker advances it, earliest first", async () => {
    const harness = await openHarness(Ref.make<ReadonlyArray<string>>([]));
    const log = harness.value;
    harness.fork(
      "slow",
      Effect.sleep("2 seconds").pipe(Effect.andThen(Ref.update(log, (l) => [...l, "slow"]))),
    );
    harness.fork(
      "fast",
      Effect.sleep("1 second").pipe(Effect.andThen(Ref.update(log, (l) => [...l, "fast"]))),
    );
    await harness.settle();
    expect(harness.enabled()).toEqual([ADVANCE_CLOCK]);
    expect(harness.fibers()).toEqual({ slow: "running", fast: "running" });

    await harness.step(ADVANCE_CLOCK);
    expect(await harness.run(Ref.get(log))).toEqual(["fast"]);
    expect(harness.clock.currentTimeMillisUnsafe()).toBe(1000);

    await harness.step(ADVANCE_CLOCK);
    expect(await harness.run(Ref.get(log))).toEqual(["fast", "slow"]);
    expect(harness.enabled()).toEqual([]);
    expect(harness.fibers()).toEqual({ slow: "done", fast: "done" });
    await harness.close();
  });

  it("close interrupts parked fibers and withdraws their gates", async () => {
    const harness = await openHarness(Effect.void);
    harness.fork("parked", gate("never"));
    await harness.settle();
    expect(harness.enabled()).toEqual(["never"]);
    await harness.close();
    expect(harness.fibers()).toEqual({ parked: "interrupted" });
    expect(harness.enabled()).toEqual([]);
  });
});

describe("a lock the system shares with fibers outside the harness", () => {
  // As a SQL connection the rest of the process uses: the outside holds it for as long as its work takes.
  it("a step ends once a fiber queued behind the outside's hold has reached its next gate, given the lock as a barrier", async () => {
    const lock = Semaphore.makeUnsafe(1);
    const harness = await openHarness(Effect.void, {
      barrier: () => Effect.runPromise(lock.withPermits(1)(Effect.void)),
    });
    harness.fork(
      "c",
      gate("c takes the lock").pipe(
        Effect.andThen(lock.withPermits(1)(Effect.void)),
        Effect.andThen(gate("c has used it")),
      ),
    );
    await harness.settle();
    let release!: () => void;
    const outside = Effect.runPromise(
      lock.withPermits(1)(
        Effect.promise(() => new Promise<void>((resolve) => (release = resolve))),
      ),
    );
    await macrotask();
    const stepped = harness.step("c takes the lock").then(() => harness.enabled());
    for (let turn = 0; turn < 20; turn++) await macrotask();
    release();
    await outside;
    expect(await stepped).toEqual(["c has used it"]);
    await harness.close();
  });
});
