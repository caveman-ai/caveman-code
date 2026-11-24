/// <reference types="node" />
// Chrome motion tokens live in motion.json (STYLE.md §8). A curve written out
// by hand drifts from them; this keeps every one on the tokens, and checks the
// preset turns each entrance into its animate-*-in utility.
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import motion from "./motion.json";

const require = createRequire(import.meta.url);
const ui = fileURLToPath(new URL("../../", import.meta.url));
const ROOTS = [join(ui, "src"), fileURLToPath(new URL("../../../../apps/web/src", import.meta.url))];
const LITERAL_CURVE = /cubic-bezier\(\s*[\d.]|\bease:\s*\[\s*[\d.]/;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(css|tsx?|cjs|mjs|js)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("motion tokens", () => {
  it("no curve is written out by hand outside motion.json", () => {
    const offenders = [join(ui, "tailwind-preset.cjs"), ...ROOTS.flatMap(sources)].flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => (LITERAL_CURVE.test(line) ? [`${file}:${i + 1}: ${line.trim()}`] : [])),
    );
    expect(offenders, "use ease-snap / ease-swift / ease-drawer, var(--ease-*) or easeCurve from motion.ts").toEqual([]);
  });

  it("every entrance becomes an animate-*-in utility on the snap curve", () => {
    const { theme } = require(join(ui, "tailwind-preset.cjs"));
    const snap = `cubic-bezier(${motion.ease.snap.join(", ")})`;
    for (const [name, entrance] of Object.entries(motion.enter)) {
      const length = motion.duration[entrance.duration as keyof typeof motion.duration];
      expect(length, `${name}: duration "${entrance.duration}" is on the scale`).toBeGreaterThan(0);
      expect(theme.extend.keyframes[`${name}-in`]).toEqual({ from: entrance.from });
      expect(theme.extend.animation[`${name}-in`]).toBe(`${name}-in ${length}ms ${snap} backwards`);
    }
    for (const [name, points] of Object.entries(motion.ease)) {
      expect(theme.extend.transitionTimingFunction[name]).toBe(`cubic-bezier(${points.join(", ")})`);
    }
 // Nothing overshoots: no spring curve, and no overshooting linear by hand.
    expect(theme.extend.transitionTimingFunction.spring).toBeUndefined();
    expect("spring" in motion).toBe(false);
  });

  it("no spring and no overshoot anywhere: no ease-spring, no linear() curve past 1", () => {
    const offenders = [join(ui, "tailwind-preset.cjs"), ...ROOTS.flatMap(sources)].flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, i) => {
          const overshoot = [...line.matchAll(/linear\(([^)]*)\)/g)].some(([, stops]) => stops!.split(",").some((stop) => Number.parseFloat(stop) > 1));
          return /ease-spring/.test(line) || overshoot ? [`${file}:${i + 1}: ${line.trim()}`] : [];
        }),
    );
    expect(offenders).toEqual([]);
  });

  it("what enters a chat only fades: a sent message, a view, the page and a revealed panel carry no transform", () => {
    for (const name of ["message", "view", "frame", "panel", "row", "arrive"] as const) {
      expect(Object.keys(motion.enter[name].from), name).toEqual(["opacity"]);
      expect(motion.duration[motion.enter[name].duration as keyof typeof motion.duration], name).toBeLessThanOrEqual(200);
    }
  });
});
