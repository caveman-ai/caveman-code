import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EffortSlider } from "./effort";
import { nextSpeed, pickSpeed, SpeedMark, SpeedToggle, speedLabel } from "./speed";

describe("speed", () => {
  it("names each speed", () => {
    expect(["standard", "fast", "ultrafast", "turbo"].map(speedLabel)).toEqual(["Standard", "Fast", "Ultrafast", "Turbo"]);
  });

  it("keeps a speed the model offers, else its fallback, else standard; none on a model without speeds", () => {
    expect(pickSpeed(["fast", "ultrafast"], "ultrafast")).toBe("ultrafast");
    expect(pickSpeed(["fast"], "ultrafast", "fast")).toBe("fast");
    expect(pickSpeed(["fast"], "ultrafast")).toBe("standard");
    expect(pickSpeed(["fast"], "standard", "fast")).toBe("standard");
    expect(pickSpeed([], "fast")).toBeUndefined();
    expect(pickSpeed(undefined, "fast")).toBeUndefined();
  });

  it("goes from standard through each faster speed and back", () => {
    expect(nextSpeed(["fast"], "standard")).toBe("fast");
    expect(nextSpeed(["fast"], "fast")).toBe("standard");
    expect(nextSpeed(["fast", "ultrafast"], "fast")).toBe("ultrafast");
    expect(nextSpeed(["fast", "ultrafast"], "ultrafast")).toBe("standard");
    expect(nextSpeed(["fast", "ultrafast"], undefined)).toBe("fast");
  });

  it("shows nothing at standard, one bolt when fast, two at the fastest of two", () => {
    const bolts = (speeds: string[], speed: string) => (renderToStaticMarkup(createElement(SpeedMark, { speeds, speed })).match(/<svg/g) ?? []).length;
    expect(bolts(["fast"], "standard")).toBe(0);
    expect(bolts(["fast"], "fast")).toBe(1);
    expect(bolts(["fast", "ultrafast"], "fast")).toBe(1);
    expect(bolts(["fast", "ultrafast"], "ultrafast")).toBe(2);
  });

  it("is a grey outline off and amber on, and names the speed", () => {
    const off = renderToStaticMarkup(createElement(SpeedToggle, { speeds: ["fast"], value: "standard", onChange: () => {} }));
    const on = renderToStaticMarkup(createElement(SpeedToggle, { speeds: ["fast"], value: "fast", onChange: () => {} }));
    expect(off).toContain('aria-label="Speed: Standard"');
    expect(off).toContain("text-muted-foreground");
    expect(on).toContain('aria-label="Speed: Fast"');
    expect(on).toContain("--speed");
    expect(renderToStaticMarkup(createElement(SpeedToggle, { speeds: [], value: undefined, onChange: () => {} }))).toBe("");
  });

  it("marks where the model starts on the effort slider only while the thumb is elsewhere", () => {
    const levels = ["low", "medium", "high", "max"];
    const away = renderToStaticMarkup(createElement(EffortSlider, { levels, value: "max", start: "medium", onChange: () => {} }));
    expect(away.match(/data-start/g)).toHaveLength(1);
    expect(away.match(/size-\[3px\]/g)).toHaveLength(levels.length - 1);
    const home = renderToStaticMarkup(createElement(EffortSlider, { levels, value: "medium", start: "medium", onChange: () => {} }));
    expect(home).not.toContain("data-start");
  });

  it("makes the level's word, dotted, the way to save the start, and adds nothing when there is nothing to save", () => {
    const levels = ["low", "medium", "high", "max"];
    const save = { label: "Make Max, Fast the default for Claude Opus 5.5", onSave: () => {} };
    const away = renderToStaticMarkup(createElement(EffortSlider, { levels, value: "max", start: "medium", save, onChange: () => {} }));
    expect(away).toContain('aria-label="Make Max, Fast the default for Claude Opus 5.5"');
    expect(away).toContain("decoration-dotted");
    const home = renderToStaticMarkup(createElement(EffortSlider, { levels, value: "medium", start: "medium", onChange: () => {} }));
    expect(home).not.toContain("<button");
  });
});
