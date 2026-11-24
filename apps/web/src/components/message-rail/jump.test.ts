import { afterEach, expect, test, vi } from "vitest";
import { settleMessageJump } from "./MessageRail.tsx";

// Model changing layout and input independently of browser scroll animation. Production-browser
// regression evidence covers the real Transcript, IntersectionObserver and content-visibility.
function layout() {
  let now = 0;
  let nextFrame = 0;
  const frames = new Map<number, FrameRequestCallback>();
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("requestAnimationFrame", (run: FrameRequestCallback) => {
    frames.set(++nextFrame, run);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  class Events extends EventTarget {
    listeners = new Set<string>();
    override addEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
      this.listeners.add(type);
      super.addEventListener(type, callback, options);
    }
    override removeEventListener(type: string, callback: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
      this.listeners.delete(type);
      super.removeEventListener(type, callback, options);
    }
  }
  const scroller = Object.assign(new Events(), { scrollTop: 0 });
  const doc = new Events();
  const root = { parentElement: { closest: () => scroller }, ownerDocument: doc } as unknown as HTMLElement;
  const position = { top: 900, mounted: true };
  const target = { scrollIntoView: vi.fn(() => { scroller.scrollTop = position.top; }) } as unknown as HTMLElement;
  return {
    position, scroller, doc, target,
    jump: (smooth = false) => settleMessageJump(root, () => position.mounted ? target : null, smooth),
    frame: () => {
      now += 16;
      const work = [...frames.values()];
      frames.clear();
      for (const run of work) run(now);
    },
    expectReleased: () => {
      expect(frames.size).toBe(0);
      expect(scroller.listeners.size).toBe(0);
      expect(doc.listeners.size).toBe(0);
    },
  };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

test("a revealed message stays aligned as estimated rows acquire their measured heights, then releases", () => {
  const l = layout();
  l.position.mounted = false;
  l.jump();
  l.frame(); l.frame();
  expect(l.target.scrollIntoView).not.toHaveBeenCalled();
  l.position.mounted = true;
  l.frame(); l.frame();
  expect(l.scroller.scrollTop).toBe(900);
  l.position.top = 1400;
  l.frame(); l.frame(); l.frame();
  expect(l.scroller.scrollTop).toBe(1400);
  l.expectReleased();
  l.position.top = 1600;
  l.frame();
  expect(l.scroller.scrollTop).toBe(1400);
});

test.each(["wheel", "touchmove", "pointerdown", "keydown"])("%s cancels alignment before it can fight manual navigation", (type) => {
  const l = layout();
  l.jump(); l.frame();
  (type === "keydown" ? l.doc : l.scroller).dispatchEvent(new Event(type));
  l.scroller.scrollTop = 500;
  l.frame();
  expect(l.scroller.scrollTop).toBe(500);
  l.expectReleased();
});

test("replacement or unmount cancels a pending reveal and can clean up more than once", () => {
  const l = layout();
  l.position.mounted = false;
  const cancel = l.jump();
  cancel(); cancel();
  l.position.mounted = true;
  l.frame();
  expect(l.target.scrollIntoView).not.toHaveBeenCalled();
  l.expectReleased();
});

test.each([true, false])("alignment has a deadline even when the target keeps moving or never mounts (%s)", (mounted) => {
  const l = layout();
  l.position.mounted = mounted;
  l.jump();
  for (let i = 0; i < 40; i++) { l.position.top += 100; l.frame(); }
  l.expectReleased();
  expect(vi.mocked(l.target.scrollIntoView).mock.calls.length).toBeLessThanOrEqual(32);
});

test("a smooth jump keeps native motion, then aligns the measured target after scrollend", () => {
  const l = layout();
  l.jump(true);
  expect(l.target.scrollIntoView).toHaveBeenLastCalledWith({ block: "start", behavior: "smooth" });
  l.position.top = 1400;
  l.frame();
  expect(l.scroller.scrollTop).toBe(900);
  l.scroller.dispatchEvent(new Event("scrollend"));
  l.frame(); l.frame(); l.frame();
  expect(l.scroller.scrollTop).toBe(1400);
  l.expectReleased();
});

test.each([true, false])("smooth completion fallback is bounded and manual input cancels it (%s)", (cancelled) => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const l = layout();
  l.jump(true);
  if (cancelled) l.scroller.dispatchEvent(new Event("wheel"));
  l.position.top = 1400;
  vi.advanceTimersByTime(1500);
  l.frame(); l.frame(); l.frame();
  expect(l.scroller.scrollTop).toBe(cancelled ? 900 : 1400);
  l.expectReleased();
  expect(vi.getTimerCount()).toBe(0);
});
