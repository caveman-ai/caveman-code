import { describe, expect, it } from "vitest";
import { appearFrames, DIM, FAINT, FOLDER, GLYPHS, glyphPaths, INK, PIXEL_PALETTE, SHADE, STATE_STRIPS } from "./glyphs";
import { PIXEL_ICON_NAMES, PIXEL_ICONS, type PixelIconName } from "./names";

const known = new Set([".", INK, SHADE, DIM, FAINT, ...Object.keys(PIXEL_PALETTE)]);
const drawn = Object.entries(GLYPHS) as [PixelIconName, string[]][];
const strips = [...Object.entries(STATE_STRIPS), ["folder", { frames: FOLDER }] as const].flatMap(([name, s]) => s!.frames.map((f, i) => [`${name}#${i}`, f] as const));

function check(name: string, grid: string[], group: string) {
  expect(grid, name).toHaveLength(16);
  for (const row of grid) {
    expect(row, `${name}: row width`).toHaveLength(16);
    for (const ch of row) expect(known.has(ch), `${name}: unknown "${ch}"`).toBe(true);
  }
  const colours = new Set(grid.join("").replaceAll(".", ""));
  expect(colours.size, `${name}: colours`).toBeLessThanOrEqual(4);
  if (group !== "engine") {
    const edge = grid[0]! + grid[15]! + grid.map((r) => r[0]! + r[15]!).join("");
    expect(edge.replaceAll(".", ""), `${name}: 1px margin`).toBe("");
  }
}

describe("pixel glyphs", () => {
  it("draws every name except the mascot bust", () => {
    const missing = PIXEL_ICON_NAMES.filter((n) => n !== "engine-caveman" && !GLYPHS[n as keyof typeof GLYPHS]);
    expect(missing).toEqual([]);
  });

  it.each(drawn)("%s keeps the grid rules", (name, grid) => check(name, grid, PIXEL_ICONS[name].group));

  it.each(strips)("strip frame %s keeps the grid rules", (name, grid) => check(name, grid, "nav"));

  it("state strips play 2 to 8 frames (the ring's 16 half steps) at 4 to 12 fps and rest on their glyph", () => {
    for (const [name, s] of Object.entries(STATE_STRIPS)) {
      const ring = name === "state-working" || name.startsWith("state-agents");
      expect(s.frames.length, name).toBeGreaterThanOrEqual(2);
      expect(s.frames.length, name).toBeLessThanOrEqual(ring ? 16 : 8);
      expect(s.fps, name).toBeGreaterThanOrEqual(4);
      expect(s.fps, name).toBeLessThanOrEqual(12);
      expect(s.frames[s.play === "once" ? s.frames.length - 1 : 0], name).toEqual(GLYPHS[name as keyof typeof GLYPHS]);
    }
  });

  it("the ring moves on every frame: no loop holds a drawing for two frames", () => {
    for (const [name, s] of Object.entries(STATE_STRIPS)) {
      if (name !== "state-working" && !name.startsWith("state-agents")) continue;
      s.frames.forEach((f, i) => expect(f, `${name}#${i}`).not.toEqual(s.frames[(i + 1) % s.frames.length]));
    }
  });

  it.each(drawn)("%s dithers in: each frame adds pixels and the last is the glyph", (name, grid) => {
    const frames = appearFrames(grid);
    const count = (f: string[]) => f.join("").replaceAll(".", "").length;
    for (let i = 1; i < frames.length; i++) expect(count(frames[i]!), name).toBeGreaterThanOrEqual(count(frames[i - 1]!));
    expect(frames.at(-1)).toEqual(grid);
  });

  it("paths cover exactly the drawn pixels", () => {
    for (const [name, grid] of drawn) {
      const painted = new Set<string>();
      for (const { char, d } of glyphPaths(grid)) {
        for (const m of d.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
          const [x, y, w] = [Number(m[1]), Number(m[2]), Number(m[3])];
          for (let i = 0; i < w; i++) painted.add(`${x + i},${y},${char}`);
        }
      }
      const expected = new Set(grid.flatMap((row, y) => [...row].flatMap((ch, x) => (ch === "." ? [] : [`${x},${y},${ch}`]))));
      expect(painted, name).toEqual(expected);
    }
  });
});
