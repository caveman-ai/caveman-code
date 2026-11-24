import { describe, expect, it } from "vitest";
import {
  DEFAULT_WALLPAPER,
  EFFECTS,
  INKS,
  RANGE,
  READING_CONTRAST,
  effectUniforms,
  inkFor,
  luminance,
  parseWallpaper,
  readingLimit,
  type EffectId,
} from "./look.ts";

const SOURCES = ["none", "mist", "flow", "image"];
const DARK_PANEL = [0.07, 0.07, 0.075] as const;
const LIGHT_PANEL = [1, 1, 1] as const;

describe("parseWallpaper", () => {
  it("is the default when nothing was kept, or what was kept is not a wallpaper", () => {
    for (const raw of [null, "", "{", "null", "[]", '"dusk"', "42"])
      expect(parseWallpaper(raw, SOURCES)).toEqual(DEFAULT_WALLPAPER);
  });

  it("keeps a whole pick as it was", () => {
    const pick = {
      source: "image",
      matchTheme: false,
      effect: "glass",
      amount: 80,
      size: 10,
      brightness: 120,
      blur: 12,
      dim: 40,
      fade: 30,
      box: 55,
      motion: false,
      imageLight: 0.7,
    };
    expect(parseWallpaper(JSON.stringify(pick), SOURCES)).toEqual(pick);
  });

  it("puts back what this build does not know, and keeps the rest", () => {
    // An older build kept a scene and a finish; a newer one might keep an effect this one has not heard of.
    const kept = parseWallpaper(
      JSON.stringify({
        scene: "dusk",
        finish: "bayer",
        source: "campfire",
        effect: "plasma",
        dim: 40,
      }),
      SOURCES,
    );
    expect(kept).toEqual({ ...DEFAULT_WALLPAPER, dim: 40 });
  });

  it("holds every number inside its range", () => {
    const wild = parseWallpaper(
      JSON.stringify({
        amount: 900,
        size: -4,
        brightness: 0,
        blur: 1e9,
        dim: 100,
        fade: -1,
        box: 0,
        imageLight: 7,
      }),
      SOURCES,
    );
    for (const name of Object.keys(RANGE) as (keyof typeof RANGE)[]) {
      expect(wild[name]).toBeGreaterThanOrEqual(RANGE[name].min);
      expect(wild[name]).toBeLessThanOrEqual(RANGE[name].max);
    }
    expect(wild.imageLight).toBe(1);
    expect(
      parseWallpaper(JSON.stringify({ amount: "lots", dim: null, blur: Number.NaN }), SOURCES),
    ).toEqual(DEFAULT_WALLPAPER);
  });

  it("goes back to the default picture when the kept one is gone", () => {
    expect(parseWallpaper(JSON.stringify({ source: "image" }), ["none", "mist"]).source).toBe(
      DEFAULT_WALLPAPER.source,
    );
    expect(parseWallpaper(JSON.stringify({ source: "none" }), SOURCES).source).toBe("none");
  });

  it("keeps independent pictures across reloads and migrates older manual choices without relinking", () => {
    const sources = [...SOURCES, "theme", "super-visuals-mint-drift"];
    for (const source of ["image", "none", "mist", "super-visuals-mint-drift"]) {
      const kept = parseWallpaper(JSON.stringify({ source }), sources);
      expect(kept.matchTheme).toBe(false);
      expect(parseWallpaper(JSON.stringify(kept), sources)).toEqual(kept);
    }
    expect(parseWallpaper(JSON.stringify({ source: "theme" }), sources).matchTheme).toBe(true);
  });
});

describe("readingLimit", () => {
  const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

  it("is the luminance that leaves each ink at the reading contrast exactly", () => {
    for (const ink of ["light", "dark"] as const)
      expect(contrast(luminance(INKS[ink]), readingLimit(ink))).toBeCloseTo(READING_CONTRAST, 6);
  });

  it("is a ceiling under light ink and a floor under dark ink", () => {
    expect(readingLimit("light")).toBeLessThan(luminance(INKS.light));
    expect(readingLimit("dark")).toBeGreaterThan(luminance(INKS.dark));
  });
});

describe("inkFor", () => {
  const plain = { brightness: 100, dim: 0 };

  it("gives a dark picture light words in either theme, as a desktop does", () => {
    expect(inkFor(plain, 0.1, DARK_PANEL)).toBe("light");
    expect(inkFor(plain, 0.1, LIGHT_PANEL)).toBe("light");
  });

  it("gives a pale picture dark words in either theme", () => {
    expect(inkFor(plain, 0.9, DARK_PANEL)).toBe("dark");
    expect(inkFor(plain, 0.9, LIGHT_PANEL)).toBe("dark");
  });

  it("follows the picture as it is shown: turned down, or dimmed toward the panel", () => {
    expect(inkFor({ brightness: 40, dim: 0 }, 0.9, DARK_PANEL)).toBe("light");
    expect(inkFor({ brightness: 100, dim: 90 }, 0.9, DARK_PANEL)).toBe("light");
    expect(inkFor({ brightness: 100, dim: 90 }, 0.1, LIGHT_PANEL)).toBe("dark");
  });

  it("gives a painting in the page's own colour the theme's ink", () => {
    expect(inkFor(plain, "panel", DARK_PANEL)).toBe("light");
    expect(inkFor(plain, "panel", LIGHT_PANEL)).toBe("dark");
  });
});

describe("effectUniforms", () => {
  const at = (effect: EffectId, amount: number, size: number) =>
    effectUniforms({ effect, amount, size });

  it("gives every effect the shader knows its own number", () => {
    const numbers = (Object.keys(EFFECTS) as EffectId[]).map((effect) => at(effect, 50, 50).effect);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(at("none", 50, 50).effect).toBe(0);
  });

  it("draws a dither in whole pixels, with fewer tones the more of it there is", () => {
    for (const size of [0, 13, 50, 87, 100])
      expect(Number.isInteger(at("dither", 50, size).grain)).toBe(true);
    expect(at("dither", 50, 0).grain).toBe(1);
    const tones = [0, 25, 50, 75, 100].map((amount) => at("dither", amount, 50).amount);
    expect(tones).toEqual([...tones].sort((a, b) => b - a));
    // Never under two tones: one step from the panel is the least a dither can be.
    expect(tones.at(-1)).toBeGreaterThan(1);
  });

  it("makes every pattern larger as its size goes up", () => {
    for (const effect of ["dither", "grain", "glass", "dots"] as const)
      expect(at(effect, 50, 100).grain).toBeGreaterThan(at(effect, 50, 0).grain);
  });
});
