// When the notch takes a click: never one that was on its way to another app.
import { expect, test } from "vitest";
import { ARM_MS, ARMED, armed, disarmed, MOVE_PX, pointed, type Guard } from "./guard.ts";

const at = (x: number, y: number) => ({ x, y });
/** The pointer is reported at each place in turn. */
const path = (guard: Guard, ...places: Array<{ x: number; y: number }>) =>
  places.reduce(pointed, guard);

test("a notch nothing changed on by itself takes a click", () => {
  expect(armed(ARMED, 0)).toBe(true);
  expect(pointed(ARMED, at(5, 5))).toBe(ARMED);
});

test("a pointer that rests where a key appeared never presses it, however long it rests", () => {
  const guard = disarmed(1_000, at(100, 140));
  expect(armed(guard, 1_000)).toBe(false);
  expect(armed(guard, 1_000 + ARM_MS)).toBe(false);
  expect(armed(guard, 1_000 + 60 * 60_000)).toBe(false);
  // The move a page replays at the same place when the card appears under it is no move at all.
  expect(pointed(guard, at(100, 140))).toBe(guard);
  // A press's own jitter is not the person moving it.
  const jittered = path(guard, at(101, 140), at(103, 142), at(100, 140));
  expect(jittered.moved).toBe(false);
  expect(armed(jittered, 1_000 + 60_000)).toBe(false);
});

test("a pointer the person moved presses, once there was time to see what changed", () => {
  const moved = path(disarmed(1_000, at(100, 140)), at(102, 140), at(102 + MOVE_PX, 140));
  expect(moved.moved).toBe(true);
  // A click already on its way when the notch opened lands in its first moments: not taken.
  expect(armed(moved, 1_000 + ARM_MS - 1)).toBe(false);
  expect(armed(moved, 1_000 + ARM_MS)).toBe(true);
});

test("the travel is measured from where the pointer was first seen to go, and going back does not undo it", () => {
  let guard = disarmed(0, at(100, 100));
  // Twelve steps of a point each: never far in one move, and still not far in all.
  for (let i = 1; i <= 12; i++) guard = pointed(guard, at(100 + i, 100));
  expect([guard.from, guard.moved]).toEqual([at(101, 100), false]);
  guard = pointed(guard, at(101, 100 + MOVE_PX));
  expect(guard.moved).toBe(true);
  // Back where it rested, on the key: it was moved, so the key is the person's to press.
  expect(pointed(guard, at(100, 100))).toBe(guard);
  expect(armed(guard, ARM_MS)).toBe(true);
});

test("a pointer found somewhere else than the page believed has not been moved", () => {
  // The page last heard the pointer at 300,60. Another app dragged it to the key since, and it rests there. When the
  // notch starts taking the mouse it hears one move, at the key: where the pointer is, not that anybody moved it.
  const found = pointed(disarmed(0, at(300, 60)), at(100, 140));
  expect([found.from, found.moved]).toEqual([at(100, 140), false]);
  expect(armed(found, 60_000)).toBe(false);
  // From there the person moves it: theirs.
  expect(armed(pointed(found, at(100 + MOVE_PX, 140)), 60_000)).toBe(true);
});

test("a pointer that was not over the window is measured from where it first shows", () => {
  const away = disarmed(0, null);
  expect(armed(away, 10 * ARM_MS)).toBe(false);
  const seen = pointed(away, at(2, 300));
  expect([seen.from, seen.moved]).toEqual([at(2, 300), false]);
  expect(armed(pointed(seen, at(60, 300)), ARM_MS)).toBe(true);
});

test("each change starts it over", () => {
  const first = path(disarmed(0, at(100, 100)), at(110, 100), at(160, 100));
  expect(armed(first, ARM_MS)).toBe(true);
  // The card changed again under the pointer the person had moved to it.
  const second = disarmed(5_000, at(160, 100));
  expect(armed(second, 5_000 + ARM_MS)).toBe(false);
  expect(armed(path(second, at(160, 110), at(160, 130)), 5_000 + ARM_MS)).toBe(true);
});

test("a press meant where it lands (keyboard, assistive technology, finger, pen) needs only the time, never travel", () => {
  const g = disarmed(1_000, { x: 50, y: 50 });
  // Too soon for anyone to have read what changed, however it is pressed.
  expect(armed(g, 1_000 + ARM_MS - 1, true)).toBe(false);
  // Seen: a deliberate press counts; a resting mouse still does not.
  expect(armed(g, 1_000 + ARM_MS, true)).toBe(true);
  expect(armed(g, 1_000 + ARM_MS)).toBe(false);
});
