import { afterEach, expect, test, vi } from "vitest";
import { windowPresence } from "./presence.ts";

afterEach(() => vi.useRealTimers());

const device = () => {
  const win = new EventTarget();
  const doc = Object.assign(new EventTarget(), { visibilityState: "visible" as DocumentVisibilityState });
  // `lag`: the clock falls a little behind the timers, as a loaded machine's can.
  const clock = { lag: 0 };
  const presence = windowPresence(win as Window, doc as unknown as Document, () => Date.now() - clock.lag, 60_000);
  const changes: boolean[] = [];
  presence.subscribe(() => changes.push(presence.active()));
  return { win, doc, presence, changes, clock };
};

test("someone is at the device while its window is visible and had input lately; changes are told once each", () => {
  vi.useFakeTimers();
  const { win, doc, presence, changes } = device();
  expect(presence.active()).toBe(false); // launched, nobody has touched it
  win.dispatchEvent(new Event("pointermove"));
  win.dispatchEvent(new Event("keydown"));
  expect(presence.active()).toBe(true);
  doc.visibilityState = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  doc.visibilityState = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(59_999);
  expect(presence.active()).toBe(true);
  vi.advanceTimersByTime(1); // no input for the whole window: idle
  expect(presence.active()).toBe(false);
  expect(changes).toEqual([true, false, true, false]);
});

test("going idle is told even when the idle timer fires before the clock says the window is up", () => {
  vi.useFakeTimers();
  const { win, presence, changes, clock } = device();
  win.dispatchEvent(new Event("keydown"));
  clock.lag = 5;
  vi.advanceTimersByTime(60_000); // the timer fires; the clock still reads 5 ms short
  vi.advanceTimersByTime(5);
  expect(presence.active()).toBe(false);
  expect(changes).toEqual([true, false]);
});
