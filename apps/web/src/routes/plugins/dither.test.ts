import { describe, expect, it } from "vitest";
import { ditherField, RAMP } from "./dither.ts";

describe("ditherField", () => {
  it("is rows of cols characters from the ramp, the same for the same name", () => {
    const field = ditherField("github", 40, 12);
    const lines = field.split("\n");
    expect(lines).toHaveLength(12);
    expect(lines.every((l) => l.length === 40 && [...l].every((c) => RAMP.includes(c)))).toBe(true);
    expect(ditherField("github", 40, 12)).toBe(field);
    expect(ditherField("linear", 40, 12)).not.toBe(field);
  });

  it("leaves the middle blank for the logo and lights the ring around it", () => {
    const lines = ditherField("slack", 96, 24, 6).split("\n");
    // The centre cell, well inside the hole.
    expect(lines[12]![48]).toBe(" ");
    // Something is drawn around it.
    expect(lines.join("").replace(/ /g, "").length).toBeGreaterThan(200);
  });
});
