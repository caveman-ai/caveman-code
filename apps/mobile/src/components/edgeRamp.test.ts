// The edges' ramps (edgeRamp.ts): flat at both ends, so neither end of a band draws a line across the page, and
// sampled densely enough that no line of text straddles a big step in the dim or the blur.
import { describe, expect, it } from "vitest";
import { cssMask, samples, smooth, windowed } from "./edgeRamp";

describe("smooth", () => {
  it("runs 0 to 1 and holds outside", () => {
    expect(smooth(-1)).toBe(0);
    expect(smooth(0)).toBe(0);
    expect(smooth(0.5)).toBeCloseTo(0.5);
    expect(smooth(1)).toBe(1);
    expect(smooth(2)).toBe(1);
  });

  it("is flat where it starts and where it ends", () => {
    const step = 0.01;
    expect(smooth(step) - smooth(0)).toBeLessThan(0.001);
    expect(smooth(1) - smooth(1 - step)).toBeLessThan(0.001);
  });
});

describe("windowed", () => {
  it("hands a layer in between its two strengths", () => {
    expect(windowed(0.1, 0.25, 0.55)).toBe(0);
    expect(windowed(0.4, 0.25, 0.55)).toBeCloseTo(0.5);
    expect(windowed(0.9, 0.25, 0.55)).toBe(1);
  });
});

describe("samples", () => {
  it("covers the box from its top to its foot, a few points apart", () => {
    const ys = samples(78, 4);
    expect(ys[0]).toBe(0);
    expect(ys[ys.length - 1]).toBe(78);
    for (let i = 1; i < ys.length; i++) expect(ys[i]! - ys[i - 1]!).toBeLessThanOrEqual(4);
  });
});

describe("a bottom band's dim", () => {
  it("never steps more than 7% between neighbouring stops, on the thread's 78 pt ramp", () => {
    const ramp = 78;
    const dim = (y: number) => 0.92 * smooth(y / ramp);
    const ys = samples(ramp, 4);
    for (let i = 1; i < ys.length; i++) expect(Math.abs(dim(ys[i]!) - dim(ys[i - 1]!))).toBeLessThan(0.07);
  });
});

describe("cssMask", () => {
  it("writes px stops from clear to whole", () => {
    const mask = cssMask(40, (y) => y / 40, 20);
    expect(mask).toBe("linear-gradient(to bottom, rgba(0,0,0,0.000) 0.0px, rgba(0,0,0,0.500) 20.0px, rgba(0,0,0,1.000) 40.0px)");
  });
});
