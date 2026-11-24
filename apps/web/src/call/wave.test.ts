import { describe, expect, test } from "vitest";
import {
  BANDS,
  LAYERS,
  newWave,
  retargetWave,
  stepWave,
  waveAt,
  waveSettled,
  type WaveRest,
  type WaveState,
} from "./wave.ts";

/** A line after `seconds` of a sound whose loudness is `level(t)`, stepped at `hz` frames a second. */
const run = (
  hz: number,
  seconds: number,
  level: (t: number) => number,
  rest: WaveRest = "flat",
  s: WaveState = newWave(),
) => {
  const bands = new Float32Array(BANDS);
  for (let i = 1; i <= Math.round(hz * seconds); i++) {
    const loud = level(i / hz);
    bands.fill(loud);
    stepWave(s, 1 / hz, loud, bands, rest);
  }
  return s;
};
/** The line's height at 81 places across it. */
const shape = (s: WaveState, layer = 0, rest = 0.08) =>
  Array.from({ length: 81 }, (_, i) => waveAt(s, i / 40 - 1, layer, rest));
const tallest = (ys: number[]) => Math.max(...ys.map(Math.abs));
/** Speech-shaped: three syllables a second. */
const speech = (t: number) => 0.15 + 0.6 * Math.max(0, Math.sin(Math.PI * 3 * t)) ** 2;

describe("the voice's line", () => {
  test("a screen's rate doesn't change it: 60, 120 and 144 Hz trace the same curve", () => {
    const at60 = shape(run(60, 1.5, speech, "drift"));
    for (const hz of [120, 144]) {
      const other = shape(run(hz, 1.5, speech, "drift"));
      expect(Math.max(...other.map((y, i) => Math.abs(y - at60[i]!)))).toBeLessThan(0.05);
    }
    expect(tallest(at60)).toBeGreaterThan(0.3);
  });

  test("it rises out of nothing at both ends and never leaves its box, however loud", () => {
    const s = run(60, 1, () => 1, "drift");
    for (let layer = 0; layer < LAYERS; layer++) {
      const ys = shape(s, layer);
      expect(ys[0]).toBeCloseTo(0, 9);
      expect(ys.at(-1)).toBeCloseTo(0, 9);
      expect(tallest(ys)).toBeLessThanOrEqual(1);
    }
    expect(tallest(shape(s))).toBeGreaterThan(0.6);
  });

  test("a sound starts in the middle and travels out to the ends", () => {
    const s = run(120, 0.06, () => 1);
    const early = shape(s);
    // Sixty milliseconds in, the middle has risen and the outer thirds have not heard it yet.
    expect(tallest(early.slice(34, 47))).toBeGreaterThan(0.1);
    expect(tallest([...early.slice(0, 10), ...early.slice(71)])).toBe(0);
    const later = shape(run(120, 0.4, () => 1, "flat", s));
    expect(tallest([...later.slice(4, 14), ...later.slice(67, 77)])).toBeGreaterThan(0.05);
  });

  test("a word is one swell: quick to rise, slower to fall", () => {
    const s = run(60, 0.15, () => 1);
    expect(s.swell).toBeGreaterThan(0.8);
    run(60, 0.15, () => 0, "flat", s);
    expect(s.swell).toBeGreaterThan(0.4);
  });

  test("silence lies flat and comes to rest; listening drifts and thinking carries a ripple across", () => {
    // Half a second of talk, then silence: still falling a second in, at rest and flat within five.
    const talk = (t: number) => (t < 0.5 ? 0.8 : 0);
    expect(waveSettled(run(60, 1, talk))).toBe(false);
    const quiet = run(60, 5, talk);
    expect(waveSettled(quiet)).toBe(true);
    expect(tallest(shape(quiet))).toBeLessThan(0.002);

    const listening = run(60, 3, () => 0, "drift");
    expect(waveSettled(listening)).toBe(false);
    expect(tallest(shape(listening))).toBeGreaterThan(0.02);
    expect(tallest(shape(listening))).toBeLessThan(0.1);

    // The ripple is on the left a third of the way through its crossing, and on the right at two thirds.
    const heights = (s: WaveState) => shape(s).map(Math.abs);
    const left = (ys: number[]) => ys.slice(0, 40).reduce((a, b) => a + b, 0);
    const right = (ys: number[]) => ys.slice(41).reduce((a, b) => a + b, 0);
    const first = heights(run(60, 1.7 * 3 + 1.7 * 0.3, () => 0, "think"));
    const second = heights(run(60, 1.7 * 3 + 1.7 * 0.7, () => 0, "think"));
    expect(left(first)).toBeGreaterThan(right(first));
    expect(right(second)).toBeGreaterThan(left(second));
  });

  test("muted mid-word it lies flat at once; the hang-up's sound and a new source carry on from where it was", () => {
    const muted = run(60, 0.5, () => 0.9, "drift");
    expect(waveSettled(muted)).toBe(false);
    // What VoiceWave does when a call mutes: its source goes and its rest is flat.
    retargetWave(muted, false, "flat");
    expect(waveSettled(muted)).toBe(true);
    expect(tallest(shape(muted))).toBe(0);
    for (const [source, rest] of [
      [true, "flat"],
      [false, "drift"],
      [true, "think"],
    ] as const) {
      const going = run(60, 0.5, () => 0.9, "drift");
      const before = shape(going);
      retargetWave(going, source, rest);
      expect(shape(going)).toEqual(before);
    }
  });
});
