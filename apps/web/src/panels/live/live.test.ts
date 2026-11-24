import { SessionProtocolError, type Client } from "@caveman-app/session-protocol/client";
import { expect, test } from "vitest";
import { contain, toBox, toFrame } from "./fit.ts";
import { browserSource, coalesce, modifiers, thumbButton, type InputEvent } from "./source.ts";

const frame = { width: 1280, height: 800 };

test("a wide box letterboxes left and right; points map to frame pixels and back", () => {
  const box = { width: 1000, height: 400 }; // frame drawn 640x400 at x=180
  expect(contain(box, frame)).toEqual({ x: 180, y: 0, scale: 0.5 });
  expect(toFrame({ x: 180, y: 0 }, box, frame)).toEqual({ x: 0, y: 0 });
  expect(toFrame({ x: 500, y: 200 }, box, frame)).toEqual({ x: 640, y: 400 });
  expect(toFrame({ x: 820, y: 400 }, box, frame)).toEqual({ x: 1280, y: 800 });
  expect(toBox({ x: 640, y: 400 }, box, frame)).toEqual({ x: 500, y: 200 });
  // In the bars: nothing, unless a drag that left the frame is clamped to its edge.
  expect(toFrame({ x: 100, y: 200 }, box, frame)).toBeNull();
  expect(toFrame({ x: 100, y: 200 }, box, frame, "center", true)).toEqual({ x: 0, y: 400 });
});

test("a tall box letterboxes top and bottom; round trips are exact", () => {
  const box = { width: 320, height: 600 }; // frame drawn 320x200 at y=200
  expect(contain(box, frame)).toEqual({ x: 0, y: 200, scale: 0.25 });
  const p = { x: 977, y: 313 };
  expect(toFrame(toBox(p, box, frame), box, frame)).toEqual(p);
  expect(toFrame({ x: 10, y: 150 }, box, frame)).toBeNull();
  expect(toFrame({ x: 10, y: 10 }, box, { width: 0, height: 0 })).toBeNull();
});

test("a page pinned to the top letterboxes below it only", () => {
  const box = { width: 320, height: 600 };
  expect(contain(box, frame, "top")).toEqual({ x: 0, y: 0, scale: 0.25 });
  expect(toFrame({ x: 160, y: 100 }, box, frame, "top")).toEqual({ x: 640, y: 400 });
  expect(toBox({ x: 640, y: 400 }, box, frame, "top")).toEqual({ x: 160, y: 100 });
  expect(toFrame({ x: 160, y: 300 }, box, frame, "top")).toBeNull();
});

test("modifiers are the CDP bitmask", () => {
  const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
  expect(modifiers(none)).toBe(0);
  expect(modifiers({ ...none, altKey: true })).toBe(1);
  expect(modifiers({ ...none, ctrlKey: true })).toBe(2);
  expect(modifiers({ ...none, metaKey: true })).toBe(4);
  expect(modifiers({ ...none, shiftKey: true })).toBe(8);
  expect(modifiers({ altKey: true, ctrlKey: true, metaKey: true, shiftKey: true })).toBe(15);
});

test("a frame's batch keeps order, collapses runs of moves and sums runs of wheels", () => {
  const q: InputEvent[] = [];
  const move = (x: number, mods = 0): InputEvent => ({ type: "pointer", action: "move", x, y: 1, modifiers: mods });
  for (const e of [move(1), move(2), move(3)]) coalesce(q, e);
  expect(q).toEqual([move(3)]);
  coalesce(q, { type: "pointer", action: "down", x: 3, y: 1, button: "left", modifiers: 0 });
  coalesce(q, move(4));
  coalesce(q, move(5, 8)); // shift changed: a new move, not a replacement
  coalesce(q, { type: "wheel", x: 5, y: 1, dx: 0, dy: 10, modifiers: 0 });
  coalesce(q, { type: "wheel", x: 6, y: 2, dx: 2, dy: 30, modifiers: 0 });
  coalesce(q, { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 0 });
  coalesce(q, { type: "wheel", x: 6, y: 2, dx: 0, dy: 5, modifiers: 0 });
  expect(q).toEqual([
    move(3),
    { type: "pointer", action: "down", x: 3, y: 1, button: "left", modifiers: 0 },
    move(4),
    move(5, 8),
    { type: "wheel", x: 6, y: 2, dx: 2, dy: 40, modifiers: 0 },
    { type: "key", action: "down", key: "a", code: "KeyA", modifiers: 0 },
    { type: "wheel", x: 6, y: 2, dx: 0, dy: 5, modifiers: 0 },
  ]);
});

test("a refused input batch means control moved elsewhere; other failures don't", async () => {
  const raf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (cb: FrameRequestCallback) => Number(setTimeout(() => cb(0), 0));
  try {
    for (const [reason, lost] of [
      ["user_in_control", 1],
      ["forbidden", 1],
      ["internal", 0],
    ] as const) {
      const batches: unknown[] = [];
      const client = {
        on: () => () => undefined,
        call: (_method: string, params: { events: unknown[] }) => {
          batches.push(params.events);
          return Promise.reject(new SessionProtocolError({ code: -32013, message: "no", data: { reason } }));
        },
      } as unknown as Client;
      let losses = 0;
      const source = browserSource(client, "w1");
      source.onControlLost(() => losses++);
      source.input({ type: "key", action: "down", key: "a", code: "KeyA", modifiers: 0 }, { type: "key", action: "up", key: "a", code: "KeyA", modifiers: 0 });
      await new Promise((r) => setTimeout(r, 5));
      expect(batches).toHaveLength(1);
      expect(losses).toBe(lost);
    }
  } finally {
    globalThis.requestAnimationFrame = raf;
  }
});

test("views of one screen share its stream: the fastest rate wins, and only the last to stop ends it", async () => {
  const calls: Array<{ enabled: boolean; max_fps?: number }> = [];
  const client = {
    on: () => () => undefined,
    call: (_method: string, params: { enabled: boolean; max_fps?: number }) => {
      calls.push({ enabled: params.enabled, ...(params.max_fps === undefined ? {} : { max_fps: params.max_fps }) });
      return Promise.resolve({});
    },
  } as unknown as Client;
  const source = browserSource(client, "shared");
  const panel = {};
  const float = {};
  expect(await source.start(panel, 10)).toBe("live");
  await source.start(float, 2);
  expect(calls.map((c) => c.max_fps)).toEqual([10, 10]);
  await source.start(float, 30);
  source.stop(panel);
  expect(calls.slice(2)).toEqual([{ enabled: true, max_fps: 30 }, { enabled: true, max_fps: 30 }]);
  source.stop(panel);
  expect(calls).toHaveLength(4);
  source.stop(float);
  expect(calls.at(-1)).toEqual({ enabled: false });
});

test("a mouse's thumb buttons are Back and Forward; the others are not (T3's #22522)", () => {
  expect(thumbButton(3)).toBe("back");
  expect(thumbButton(4)).toBe("forward");
  expect([0, 1, 2, 5].map(thumbButton)).toEqual([null, null, null, null]);
});
