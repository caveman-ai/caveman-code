import { describe, expect, it } from "vitest";
import { DEFAULT_SOURCE } from "./look.ts";
import { PAINTINGS, findPainting } from "./paintings.ts";

describe("the paintings that ship", () => {
  it("include the one a new install wears, first", () => {
    expect(PAINTINGS[0]?.id).toBe(DEFAULT_SOURCE);
    expect(findPainting(DEFAULT_SOURCE)).toBeDefined();
  });

  it("each have their own id and name, and none takes a name the picker keeps for itself", () => {
    const ids = PAINTINGS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(PAINTINGS.map((p) => p.name)).size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(["none", "image"]).not.toContain(id);
    }
  });

  it("each define the one function the shader calls, and say how light they are", () => {
    for (const p of PAINTINGS) {
      expect(p.glsl, p.id).toMatch(/vec3\s+paint\s*\(\s*vec2\s+\w+\s*,\s*float\s+\w+\s*\)/);
      // The shader's own header comes first: a painting that brings one does not compile.
      expect(p.glsl, p.id).not.toMatch(/#version|precision\s+\w+\s+float/);
      if (p.light !== "panel") {
        expect(p.light, p.id).toBeGreaterThanOrEqual(0);
        expect(p.light, p.id).toBeLessThanOrEqual(1);
      }
    }
  });
});
