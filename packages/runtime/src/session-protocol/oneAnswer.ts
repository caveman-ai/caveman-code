import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * One answer per ask (K3, CHAOS-13): answers to the same ask, from several devices at the same instant, go one at a
 * time, and which one counts is decided inside that turn. The first to go through is the answer; every later one gets
 * `already` (its device says it was answered elsewhere), whether or not the engine's own record shows it yet.
 * Answers are kept `keepMs` (the engine's record has caught up by then); their locks go with them.
 */
export function oneAnswerPerAsk(keepMs = 10 * 60_000) {
  const locks = new Map<string, Semaphore.Semaphore>();
  const answered = new Map<string, number>();
  return <A, E>(key: string, answer: Effect.Effect<A, E>, already: Effect.Effect<never, E>): Effect.Effect<A, E> =>
    Effect.suspend(() => {
      for (const [k, at] of answered) if (Date.now() - at > keepMs) (answered.delete(k), locks.delete(k));
      let lock = locks.get(key);
      if (lock === undefined) locks.set(key, (lock = Semaphore.makeUnsafe(1)));
      return lock.withPermits(1)(Effect.suspend(() => (answered.has(key) ? already : answer.pipe(Effect.tap(() => Effect.sync(() => void answered.set(key, Date.now())))))));
    });
}
