import { expect, test } from "vitest";

import { wakeWatch } from "./wakeWatch.ts";

test("a sleep counts once, whether the pass or the watch looks first after it; a long pass is no sleep", () => {
  let clock = 0;
  const watch = wakeWatch(() => clock);
  // Awake: the watch looks every second, the pass every 3 s.
  for (let i = 0; i < 10; i++) {
    clock += 1_000;
    expect(watch.look()).toBe(false);
  }
  // Asleep for 100 s; woken, the pass looks first, then the watch, in the same millisecond.
  clock += 100_000;
  expect(watch.look()).toBe(true);
  expect(watch.look()).toBe(false);
  expect(watch.wakes).toBe(1);
  // The other order after the next sleep.
  clock += 7_000;
  expect(watch.look()).toBe(true);
  expect(watch.look()).toBe(false);
  expect(watch.wakes).toBe(2);
  // A pass that runs 20 s while the watch keeps looking: no sleep.
  for (let i = 0; i < 20; i++) {
    clock += 1_000;
    expect(watch.look()).toBe(false);
  }
  expect(watch.wakes).toBe(2);
  // Exactly the gap is no sleep; past it is.
  clock += 6_000;
  expect(watch.look()).toBe(false);
  clock += 6_001;
  expect(watch.look()).toBe(true);
});
