import { expect, test } from "vitest";
import { createCloseRouter, isCloseChord, windowCloseAction } from "../src/closeRouter.ts";

test("the newest handler that takes the request wins; otherwise the window closes", () => {
  let closed = 0;
  const router = createCloseRouter(() => closed++);
  const calls: string[] = [];
  router.register(() => (calls.push("outer"), false));
  const off = router.register(() => (calls.push("panel"), true));
  router.request();
  expect(calls).toEqual(["panel"]);
  expect(closed).toBe(0);
  off();
  router.request();
  expect(calls).toEqual(["panel", "outer"]);
  expect(closed).toBe(1);
});

test("a throwing handler never keeps the window open", () => {
  let closed = 0;
  const router = createCloseRouter(() => closed++);
  router.register(() => {
    throw new Error("boom");
  });
  router.request();
  expect(closed).toBe(1);
});

test("only the bare ⌘W chord counts", () => {
  const base = { type: "keyDown", key: "w", meta: true, control: false, alt: false, shift: false };
  expect(isCloseChord(base, "darwin")).toBe(true);
  expect(isCloseChord({ ...base, key: "W" }, "darwin")).toBe(true);
  expect(isCloseChord({ ...base, shift: true }, "darwin")).toBe(false);
  expect(isCloseChord({ ...base, type: "keyUp" }, "darwin")).toBe(false);
  expect(isCloseChord(base, "linux")).toBe(false);
  expect(isCloseChord({ ...base, meta: false, control: true }, "linux")).toBe(true);
});

const mac = { platform: "darwin" as const, quitting: false, smoke: false, fullScreen: false };

test("closing the main window only hides it on macOS, so its page keeps posting notices while the app runs", () => {
  expect(windowCloseAction(mac)).toBe("hide");
  expect(windowCloseAction({ ...mac, fullScreen: true })).toBe("leave-full-screen");
});

test("the main window closes for real when the app or the updater quits, and in the smoke test", () => {
  expect(windowCloseAction({ ...mac, quitting: true })).toBe("close");
  expect(windowCloseAction({ ...mac, quitting: true, fullScreen: true })).toBe("close");
  expect(windowCloseAction({ ...mac, smoke: true })).toBe("close");
  expect(windowCloseAction({ ...mac, platform: "win32", quitting: true })).toBe("close");
  expect(windowCloseAction({ ...mac, platform: "linux", smoke: true })).toBe("close");
});

test("off macOS closing the main window quits the app, through the question before a quit", () => {
  expect(windowCloseAction({ ...mac, platform: "win32" })).toBe("quit");
  expect(windowCloseAction({ ...mac, platform: "win32", fullScreen: true })).toBe("quit");
  expect(windowCloseAction({ ...mac, platform: "linux" })).toBe("quit");
});
