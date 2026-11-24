import { describe, expect, it } from "vitest";
import { DIM, FAINT, GLYPHS, INK, PIXEL_PALETTE, SHADE } from "./glyphs";
import { PIXEL_ICON_NAMES } from "./names";
import { box, cut, narrow, OWN_TOYS, px, SPARK, squash, stretch, toyFor } from "./toys";

const drawn = PIXEL_ICON_NAMES.filter((n) => n !== "engine-caveman") as Exclude<(typeof PIXEL_ICON_NAMES)[number], "engine-caveman">[];
const known = new Set([INK, SHADE, DIM, FAINT, SPARK, ...Object.keys(PIXEL_PALETTE)]);
const cells = (d: string) => [...d.matchAll(/M(-?\d+) (-?\d+)h(\d+)/g)].flatMap((m) => Array.from({ length: Number(m[3]) }, (_, i) => [Number(m[1]) + i, Number(m[2])] as const));
const rest = (name: (typeof drawn)[number]) => new Set(px(GLYPHS[name]).map(([x, y, ch]) => `${x},${y},${ch}`));

describe("icon toys", () => {
  it.each(drawn)("%s has a hover and a click, each a short run of held frames", (name) => {
    const { hover, pop } = toyFor(name);
    expect(hover.ms, `${name} hover`).toBeGreaterThanOrEqual(100);
    expect(hover.ms, `${name} hover`).toBeLessThanOrEqual(260);
    expect(pop.ms, `${name} click`).toBeGreaterThanOrEqual(110);
    expect(pop.ms, `${name} click`).toBeLessThanOrEqual(300);
    for (const book of [hover, pop]) {
      let t = 0;
      for (const f of book.frames) {
        expect(f.t).toBe(t);
        expect(f.ms).toBeGreaterThanOrEqual(40);
        expect(f.ms).toBeLessThanOrEqual(140);
        t += f.ms;
      }
      expect(t).toBe(book.ms);
    }
  });

  it.each(drawn)("%s draws every frame in its palette, inside its box, and moves", (name) => {
    const still = rest(name);
    const ground = Math.max(...[...still].map((c) => Number(c.split(",")[1])));
    for (const book of [toyFor(name).hover, toyFor(name).pop]) {
      let moved = false;
      for (const f of book.frames) {
        const here = new Set<string>();
        for (const { char, d } of f.paths) {
          expect(known.has(char), `${name}: unknown "${char}"`).toBe(true);
          for (const [x, y] of cells(d)) {
            expect(x, name).toBeGreaterThanOrEqual(0);
            expect(x, name).toBeLessThanOrEqual(15);
            expect(y, name).toBeGreaterThanOrEqual(0);
            expect(y, name).toBeLessThanOrEqual(15);
            here.add(`${x},${y},${char}`);
          }
        }
 // Nothing hops: the drawing keeps its feet.
        expect(Math.max(...[...here].map((c) => Number(c.split(",")[1]))), `${name} lifts off`).toBeGreaterThanOrEqual(ground - 1);
        if (here.size !== still.size || [...here].some((c) => !still.has(c))) moved = true;
      }
      expect(moved, name).toBe(true);
    }
  });

  it("gives the sidebar, the composer menu, calls and Settings their own toys", () => {
    for (const name of ["new", "search", "chief", "settings", "spaces", "automations", "review", "rocket", "attach", "goal", "grill-mode", "call", "mic", "secret", "repo"] as const) {
      expect(OWN_TOYS).toContain(name);
    }
  });

  it("cuts a glyph into parts that together are the glyph", () => {
    for (const name of drawn) {
      const rig = cut(GLYPHS[name], { top: box(0, 0, 15, 6), left: (x) => x < 8 });
      const pixels = rig.flatMap(([, p]) => p.map(([x, y, ch]) => `${x},${y},${ch}`));
      expect(new Set(pixels).size, name).toBe(pixels.length);
      expect(new Set(pixels), name).toEqual(rest(name));
    }
  });

  it("squashes and stretches by whole rows, and narrows a drawing about its centre", () => {
    const bar = px(["....", ".##.", ".##.", ".##."]);
    expect(squash(bar, 2)).toEqual([[1, 2, "#"], [2, 2, "#"], [1, 3, "#"], [2, 3, "#"]]);
    expect(stretch(bar, 2).length).toBe(8);
    const wide = px(["########"]);
    expect(narrow(wide, 2).map(([x]) => x)).toEqual([3, 4]);
  });
});
