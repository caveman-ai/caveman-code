import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { jumpTo, onJump, takeJump } from "./jump.ts";

// The node environment has no window: an EventTarget stands in for it.
beforeEach(() => vi.stubGlobal("window", new EventTarget()));
afterEach(() => vi.unstubAllGlobals());

test("a jump waits until the chat holds its item, then is taken once", () => {
  const heard: string[] = [];
  const stop = onJump("s1", () => heard.push("s1"));
  jumpTo("s1", { item: "msg-7", query: "Stripe" });
  expect(heard).toEqual(["s1"]);
  // Still loading: the item is not there yet, so the jump waits.
  expect(takeJump("s1", () => false)).toBeUndefined();
  expect(takeJump("s1", (item) => item === "msg-7")).toEqual({ item: "msg-7", query: "Stripe", at: expect.any(Number) });
  expect(takeJump("s1", () => true)).toBeUndefined();
  // Another chat's jump is not this one's.
  jumpTo("s2", { item: "x", query: "" });
  expect(heard).toEqual(["s1"]);
  stop();
});

test("a jump never taken goes stale", () => {
  vi.useFakeTimers();
  jumpTo("s3", { item: "gone", query: "" });
  vi.advanceTimersByTime(16_000);
  expect(takeJump("s3", () => true)).toBeUndefined();
  vi.useRealTimers();
});
