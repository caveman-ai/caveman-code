import { describe, expect, it } from "vitest";
import { amplitude, markWidth, swell } from "./MessageRail.tsx";

describe("message rail amplitude", () => {
  it("spreads a nudge, a paragraph and a brief far apart (4 to 28 px)", () => {
    const nudge = markWidth(amplitude("ok"));
    const para = markWidth(amplitude("x".repeat(400)));
    const brief = markWidth(amplitude("x".repeat(5000)));
    expect(nudge).toBeLessThanOrEqual(6);
    expect(para).toBeGreaterThanOrEqual(13);
    expect(brief).toBe(28);
  });

  it("swells the hovered mark most, then its neighbours, and leaves far marks to their amplitude", () => {
    expect(swell(0, 0)).toBe(2.6);
    expect(swell(0, 1)).toBe(1.8);
    expect(swell(0, 3)).toBe(1.1);
    expect(swell(0, 9)).toBe(1);
    expect(swell(1, 9)).toBe(1.5);
    expect(swell(0, -1)).toBe(1);
  });
});
