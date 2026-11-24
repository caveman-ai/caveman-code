import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { holdAwake, KeepAwake, readKeepAwake, writeKeepAwake } from "../src/keepAwake.ts";

test("holds idle sleep off only while chats work, once", () => {
  const blocker = { start: vi.fn(() => 7), stop: vi.fn() };
  const k = new KeepAwake(blocker);
  k.set(false);
  expect(blocker.start).not.toHaveBeenCalled();
  k.set(true);
  k.set(true);
  expect(blocker.start).toHaveBeenCalledTimes(1);
  expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
  expect(k.holding).toBe(true);
  k.set(false);
  k.set(false);
  expect(blocker.stop).toHaveBeenCalledTimes(1);
  expect(blocker.stop).toHaveBeenCalledWith(7);
  expect(k.holding).toBe(false);
});

test("off unless the person turned it on", () => {
  const file = join(mkdtempSync(join(tmpdir(), "caveman-power-")), "power.json");
  expect(readKeepAwake(file)).toBe(false);
  writeFileSync(file, "{");
  expect(readKeepAwake(file)).toBe(false);
  writeKeepAwake(file, true);
  expect(readKeepAwake(file)).toBe(true);
  writeKeepAwake(file, false);
  expect(readKeepAwake(file)).toBe(false);
});

test("another device driving this Mac holds idle sleep off on power only, and lets go when the rule lapses (S13)", () => {
  const blocker = { start: vi.fn(() => 9), stop: vi.fn() };
  const k = new KeepAwake(blocker);
  const rule = { quitting: false, keepAwakeOn: false, workingChats: 0, remoteWanted: false, onBattery: false };
  expect(holdAwake(rule)).toBe(false);
  // Driven, on power: held, whatever the chats setting says.
  k.set(holdAwake({ ...rule, remoteWanted: true }));
  expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
  expect(k.holding).toBe(true);
  // Unplugged: let go at once.
  k.set(holdAwake({ ...rule, remoteWanted: true, onBattery: true }));
  expect(blocker.stop).toHaveBeenCalledWith(9);
  expect(k.holding).toBe(false);
  // Plugged in again, then the 10 minutes pass (the runtime stops wanting it): held, then released.
  k.set(holdAwake({ ...rule, remoteWanted: true }));
  expect(k.holding).toBe(true);
  k.set(holdAwake({ ...rule, remoteWanted: false }));
  expect(k.holding).toBe(false);
  expect(blocker.start).toHaveBeenCalledTimes(2);
  expect(blocker.stop).toHaveBeenCalledTimes(2);
  // Quitting never holds; the person's own setting still holds on battery while chats work.
  expect(holdAwake({ ...rule, remoteWanted: true, quitting: true })).toBe(false);
  expect(holdAwake({ ...rule, keepAwakeOn: true, workingChats: 2, onBattery: true })).toBe(true);
  expect(holdAwake({ ...rule, keepAwakeOn: false, workingChats: 2 })).toBe(false);
});
