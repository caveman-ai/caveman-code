import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EffortSlider, EffortWord, effortLabel, effortTier, pickEffort, stepLevel } from "./effort";

// Every level an engine offers today (Claude's catalog runs low..max, then ultracode).
const LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultracode"];

describe("effort", () => {
  it("turns red at max and purple past it", () => {
    expect(LEVELS.map(effortTier)).toEqual(["base", "base", "base", "base", "base", "base", "max", "ultra"]);
    expect(effortTier(undefined)).toBe("base");
  });

  it("names every level in words", () => {
    expect(LEVELS.map(effortLabel)).toEqual(["None", "Minimal", "Low", "Medium", "High", "Extra high", "Max", "Ultracode"]);
  });

  it("keeps a level the next model offers, else its default, else the middle", () => {
    expect(pickEffort(["low", "medium", "high"], "high")).toBe("high");
    expect(pickEffort(["low", "medium", "high"], "max", "low")).toBe("low");
    expect(pickEffort(["low", "medium", "high", "max"], "ultracode")).toBe("medium");
    expect(pickEffort([], "high")).toBeUndefined();
  });

  it("steps one level at a time and holds at either end", () => {
    const levels = ["low", "medium", "high"];
    expect(stepLevel(levels, "medium", 1)).toBe("high");
    expect(stepLevel(levels, "high", 1)).toBe("high");
    expect(stepLevel(levels, "low", -1)).toBe("low");
    expect(stepLevel(levels, undefined, 1)).toBe("medium");
  });

  it("is one slider in the level's tier, with a stop per level", () => {
    const html = renderToStaticMarkup(createElement(EffortSlider, { levels: LEVELS, value: "ultracode", onChange: () => {} }));
    expect(html).toContain('role="slider"');
    expect(html).toContain('aria-valuetext="Ultracode"');
    expect(html).toContain('data-tier="ultra"');
    expect(html.match(/size-\[3px\]/g)).toHaveLength(LEVELS.length);
  });

  it("offers no slider with one level", () => {
    expect(renderToStaticMarkup(createElement(EffortSlider, { levels: ["high"], value: "high", onChange: () => {} }))).toBe("");
  });

  it("holds the width of its longest level, so a change never shifts the chip", () => {
    const html = renderToStaticMarkup(createElement(EffortWord, { levels: ["low", "medium", "xhigh", "max"], value: "max" }));
    expect(html).toContain("--effort-max");
    expect(html.match(/invisible/g)).toHaveLength(3);
  });
});
