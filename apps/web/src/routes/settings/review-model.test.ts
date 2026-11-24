import { describe, expect, it } from "vitest";
import { advancedSummary, RULER_STOPS, rulerAt, rulerLanes, stepStop, stopAt } from "./review-model.ts";

describe("rulerAt", () => {
  it("spaces each tenfold evenly and clamps at both ends", () => {
    expect(rulerAt(1)).toBe(0);
    expect(rulerAt(10)).toBeCloseTo(1 / 3);
    expect(rulerAt(100)).toBeCloseTo(2 / 3);
    expect(rulerAt(1000)).toBe(1);
    expect(rulerAt(0)).toBe(0);
    expect(rulerAt(50_000)).toBe(1);
  });
});

describe("stopAt", () => {
  it("lands on the nearest stop, so a drag clicks through round numbers", () => {
    expect(stopAt(rulerAt(30))).toBe(30);
    expect(stopAt(rulerAt(33))).toBe(30);
    expect(stopAt(0)).toBe(1);
    expect(stopAt(1)).toBe(1000);
  });
  it("reaches every stop", () => {
    for (const stop of RULER_STOPS) expect(stopAt(rulerAt(stop))).toBe(stop);
  });
});

describe("stepStop", () => {
  it("moves one stop either way and holds at the ends", () => {
    expect(stepStop(30, 1)).toBe(40);
    expect(stepStop(30, -1)).toBe(25);
    expect(stepStop(35, 1)).toBe(40);
    expect(stepStop(35, -1)).toBe(30);
    expect(stepStop(1000, 1)).toBe(1000);
    expect(stepStop(1, -1)).toBe(1);
  });
});

describe("rulerLanes", () => {
  it("stacks marks that would touch and keeps far ones on the bottom lane", () => {
    expect(rulerLanes([0.1, 0.5, 0.9], 0.02)).toEqual([0, 0, 0]);
    expect(rulerLanes([0.5, 0.505, 0.51], 0.02)).toEqual([0, 1, 2]);
  });
  it("shares the bottom lane past the most lanes", () => {
    expect(rulerLanes([0.5, 0.5, 0.5, 0.5], 0.02, 3)).toEqual([0, 1, 2, 0]);
  });
});

describe("advancedSummary", () => {
  it("says every value in words and flags only the ones off their default", () => {
    expect(advancedSummary({})).toEqual([
      { text: "steps up once", changed: false },
      { text: "48 KB in one call", changed: false },
      { text: "20 ahead a day", changed: false },
      { text: "under 70% of a plan", changed: false },
      { text: "after 2 min quiet", changed: false },
    ]);
    const changed = advancedSummary({ review_step_up: false, review_prewarm_daily: 5, review_single_pass_kb: 48 });
    expect(changed.map((p) => p.changed)).toEqual([true, false, true, false, false]);
    expect(changed[0]!.text).toBe("never steps up");
  });
});
