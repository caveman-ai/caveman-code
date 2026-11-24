import { afterEach, expect, test, vi } from "vitest";
import { arriveStep, isConversationScrollTarget, tailRoom } from "./conversation-scroll.ts";

// Just the layout facts the browser supplies. Live wheel/keyboard behavior is also checked in the capture lab.
class Node {
  parentElement: Node | null;
  scrollTop = 0;
  scrollHeight = 600;
  clientHeight = 100;
  style = { overflowY: "visible", overscrollBehaviorY: "auto" };
  constructor(parent: Node | null = null) { this.parentElement = parent; }
  contains(target: Node): boolean { return target === this || Boolean(target.parentElement && this.contains(target.parentElement)); }
}
afterEach(() => vi.unstubAllGlobals());

test("tool output owns its scroll; only a chainable edge releases the transcript", () => {
  vi.stubGlobal("Element", Node);
  vi.stubGlobal("getComputedStyle", (node: Node) => node.style);
  const viewport = new Node();
  const tool = new Node(viewport);
  tool.style.overflowY = "auto";
  tool.scrollTop = 100;
  const code = new Node(tool);
  const owns = (target: Node, delta = -1) => isConversationScrollTarget(target as unknown as EventTarget, viewport as unknown as HTMLElement, delta);
  expect(owns(code)).toBe(false);
  tool.scrollTop = 0;
  expect(owns(code)).toBe(true);
  tool.style.overscrollBehaviorY = "contain";
  expect(owns(code)).toBe(false);
  tool.style.overscrollBehaviorY = "none";
  expect(owns(code)).toBe(false);
  tool.style.overscrollBehaviorY = "auto";
  expect(owns(code, 1)).toBe(false);
  tool.scrollTop = 500;
  expect(owns(code, 1)).toBe(true);
  expect(owns(viewport)).toBe(true);
  expect(owns(new Node())).toBe(false);
  expect(owns(viewport, 0)).toBe(false);
});

// A sent message's arrival: the view's spring to the end.
const fly = (from: number, target: number, frameMs: number, frames: number) => {
  let view = { at: from, speed: 0 };
  const path = [view.at];
  for (let frame = 0; frame < frames; frame++) {
    view = arriveStep(view.at, view.speed, target, frameMs);
    path.push(view.at);
  }
  return path;
};

test("an arrival eases out of rest, never passes the end and is there in about a third of a second", () => {
  const path = fly(0, 400, 1000 / 60, 30);
  const steps = path.slice(1).map((at, i) => at - path[i]!);
  // It starts gently (no jump on the first frame), speeds up, then slows into the end.
  expect(steps[0]!).toBeLessThan(400 * 0.06);
  expect(steps[0]!).toBeLessThan(steps[2]!);
  expect(steps.indexOf(Math.max(...steps))).toBeGreaterThan(0);
  expect(steps.at(-1)!).toBeLessThan(1);
  // Always toward the end, never beyond it.
  expect(steps.every((step) => step >= 0)).toBe(true);
  expect(path.every((at) => at <= 400)).toBe(true);
  // Nearly there at a third of a second (frame 20), within a pixel at half a second.
  expect(400 - path[20]!).toBeLessThan(8);
  expect(400 - path.at(-1)!).toBeLessThan(1);
});

test("an arrival traces the same curve at 60 Hz and 120 Hz, and through a late frame", () => {
  const at60 = fly(0, 400, 1000 / 60, 12).at(-1)!;
  const at120 = fly(0, 400, 1000 / 120, 24).at(-1)!;
  expect(Math.abs(at60 - at120)).toBeLessThan(0.01);
  // One long frame lands where the frames it replaced would have.
  expect(Math.abs(arriveStep(0, 0, 400, 200).at - at60)).toBeLessThan(0.01);
});

test("an arrival follows an end that moves under it, without a lurch", () => {
  // The message lands, then the turn's working line: the end moves 60px further mid-flight.
  let view = { at: 0, speed: 0 };
  const path = [0];
  for (let frame = 0; frame < 40; frame++) {
    view = arriveStep(view.at, view.speed, frame < 6 ? 120 : 180, 1000 / 60);
    path.push(view.at);
  }
  const steps = path.slice(1).map((at, i) => at - path[i]!);
  // Each frame's travel differs from the last by a few pixels at most, the frame the end moved included.
  expect(Math.max(...steps.slice(1).map((step, i) => Math.abs(step - steps[i]!)))).toBeLessThan(8);
  expect(steps.every((step) => step >= 0)).toBe(true);
  expect(180 - view.at).toBeLessThan(1);
});

test("the end shows the latest turn from its start, with room under a short reply", () => {
  // A 600px view, the turn starting 2000px down, 12px from the top once at the end: 200px of turn needs 388px of room.
  expect(tailRoom(2000, 2200, 600, 12)).toBe(388);
  // At the end, the turn's start sits at the inset: content plus room, less the view, is where it starts, less the inset.
  expect(2200 + tailRoom(2000, 2200, 600, 12) - 600).toBe(2000 - 12);
  // A turn that fills the view needs none: the end is its last line.
  expect(tailRoom(2000, 2900, 600, 12)).toBe(0);
  // A first message of a new chat: the view is exactly full, so nothing scrolls.
  expect(160 + tailRoom(12, 160, 600, 12)).toBe(600);
});
