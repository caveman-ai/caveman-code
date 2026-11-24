// The two gears' hysteresis (pace.ts): catch-up starts at 8 words or 120ms behind, holds at least 250ms, lets go only
// at 2 words and 40ms, and can't start again for 250ms; each word fades in over 150ms from its own reveal.
import { describe, expect, it } from "vitest";
import { CATCH_SPAN_MS, ENTER_MS, ENTER_WORDS, fadeOf, FADE_MS, HOLD_MS, REENTRY_MS, startGear, stepGear, WORD_MS } from "./pace";

const FRAME = 1000 / 60;

describe("the gears", () => {
  it("lets out one word every 33ms on the smooth gear", () => {
    let g = startGear(0);
    for (let t = 0; t < 33 * 4; t += FRAME) g = stepGear(g, 5, 0, t, FRAME);
    expect(g.catching).toBe(false);
    expect(Math.floor(g.shown)).toBe(4);
  });

  it("starts catching up at 8 words behind, or the oldest waiting 120ms", () => {
    expect(stepGear(startGear(0), ENTER_WORDS, 0, 0, FRAME).catching).toBe(true);
    expect(stepGear(startGear(0), ENTER_WORDS - 1, 0, 0, FRAME).catching).toBe(false);
    expect(stepGear(startGear(0), 3, ENTER_MS, 0, FRAME).catching).toBe(true);
  });

  it("closes a backlog over about 180ms, never slower than the smooth gear", () => {
    const g = stepGear(startGear(0), 36, 0, 0, FRAME);
    expect(g.shown).toBeCloseTo((36 / CATCH_SPAN_MS) * FRAME, 5);
    const small = stepGear({ shown: 0, catching: true, since: 0 }, 1, 0, 300, FRAME);
    expect(small.shown).toBeCloseTo(FRAME / WORD_MS, 5);
  });

  it("holds catch-up at least 250ms, even once caught up", () => {
    let g = stepGear(startGear(0), 10, 0, 0, FRAME);
    g = stepGear({ ...g, shown: 10 }, 10, 0, HOLD_MS - 1, FRAME);
    expect(g.catching).toBe(true);
    g = stepGear(g, 10, 0, HOLD_MS, FRAME);
    expect(g.catching).toBe(false);
  });

  it("lets go only at 2 words or fewer and the oldest 40ms or less", () => {
    const catching = { shown: 0, catching: true, since: 0 };
    expect(stepGear(catching, 3, 0, 1000, FRAME).catching).toBe(true);
    expect(stepGear(catching, 2, 41, 1000, FRAME).catching).toBe(true);
    expect(stepGear(catching, 2, 40, 1000, FRAME).catching).toBe(false);
  });

  it("can't start catching up again for 250ms after it let go", () => {
    const resting = { shown: 0, catching: false, since: 1000 };
    expect(stepGear(resting, 20, 0, 1000 + REENTRY_MS - 1, FRAME).catching).toBe(false);
    expect(stepGear(resting, 20, 0, 1000 + REENTRY_MS, FRAME).catching).toBe(true);
  });

  it("never lets out more than has arrived", () => {
    const g = stepGear(startGear(4), 5, 0, 0, 1000);
    expect(g.shown).toBe(5);
  });

  it("steadies at a smooth pace on a stream faster than the smooth gear, without lurching", () => {
    // 4 words every 90ms (about 44 a second), for 3s.
    let g = startGear(0);
    let last = 0;
    let biggest = 0;
    for (let t = 0; t < 3000; t += FRAME) {
      const arrived = (Math.floor(t / 90) + 1) * 4;
      const next = Math.floor(g.shown);
      const waited = next < arrived ? t - Math.floor(next / 4) * 90 : 0;
      g = stepGear(g, arrived, waited, t, FRAME);
      biggest = Math.max(biggest, Math.floor(g.shown) - last);
      last = Math.floor(g.shown);
    }
    expect(biggest).toBeLessThanOrEqual(2);
  });
});

describe("the fade", () => {
  it("runs each word from nothing to full ink over 150ms from its own reveal", () => {
    expect(fadeOf(1000, 1000)).toBe(0);
    expect(fadeOf(1000, 1000 + FADE_MS / 2)).toBeCloseTo(0.5, 5);
    expect(fadeOf(1000, 1000 + FADE_MS)).toBe(1);
    // A frame never takes a word from under 85% to full ink: the last step is at most one frame's share.
    expect(1 - fadeOf(1000, 1000 + FADE_MS - FRAME)).toBeLessThan(0.15);
  });
});
