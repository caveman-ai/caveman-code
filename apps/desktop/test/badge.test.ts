import { describe, expect, it } from "vitest";
import { BADGE_MAX, badgeCount } from "../src/badge.ts";

describe("Dock badge", () => {
  it("shows the page's count while the app is away, and nothing while it is in use", () => {
    expect(badgeCount(3, false)).toBe(3);
    expect(badgeCount(0, false)).toBe(0);
    expect(badgeCount(3, true)).toBe(0);
    expect(badgeCount(5_000, false)).toBe(BADGE_MAX);
  });

  it("ignores anything that is not a count", () => {
    for (const raw of [-1, 1.5, Number.NaN, "3", null, undefined, {}]) expect(badgeCount(raw, false)).toBeNull();
  });
});
