import { expect, test } from "vitest";
import { unseenSessions } from "./unseen.ts";

test("chats let go of stay attached, the most recent ones; the oldest detaches past the limit", () => {
  const unseen = unseenSessions(2);
  const detached: string[] = [];
  const a = {};
  const b = {};
  const c = {};
  unseen.keep(a, () => detached.push("a"));
  unseen.keep(b, () => detached.push("b"));
  expect(detached).toEqual([]);
  unseen.keep(c, () => detached.push("c"));
  expect(detached).toEqual(["a"]);
  expect(unseen.has(a)).toBe(false);
  expect(unseen.has(b) && unseen.has(c)).toBe(true);
});

test("a chat shown again is taken back still attached, and no longer counts against the limit", () => {
  const unseen = unseenSessions(1);
  const detached: string[] = [];
  const a = {};
  const b = {};
  unseen.keep(a, () => detached.push("a"));
  expect(unseen.take(a)).toBe(true);
  expect(unseen.take(a)).toBe(false);
  unseen.keep(b, () => detached.push("b"));
  expect(detached).toEqual([]);
});

test("let go of again, a chat counts as the most recent", () => {
  const unseen = unseenSessions(2);
  const detached: string[] = [];
  const a = {};
  const b = {};
  const c = {};
  unseen.keep(a, () => detached.push("a"));
  unseen.keep(b, () => detached.push("b"));
  unseen.keep(a, () => detached.push("a"));
  unseen.keep(c, () => detached.push("c"));
  expect(detached).toEqual(["b"]);
});
