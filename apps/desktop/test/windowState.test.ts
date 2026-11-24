import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SIZE, initialBounds, readWindowState, sameState, writeWindowState } from "../src/windowState.ts";

const laptop = { x: 0, y: 0, width: 1512, height: 982 };
const external = { x: 1512, y: -200, width: 2560, height: 1440 };

describe("window state", () => {
  it("round-trips through the file, rounded, and leaves no staging file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "caveman-window-"));
    const file = join(dir, "window-state.json");
    expect(readWindowState(file)).toBeNull();
    writeWindowState(file, { bounds: { x: 120.4, y: 90.6, width: 1111, height: 707 }, maximized: true });
    expect(readWindowState(file)).toEqual({ bounds: { x: 120, y: 91, width: 1111, height: 707 }, maximized: true });
    expect(readdirSync(dir)).toEqual(["window-state.json"]);
  });

  it("ignores a file it did not write, a broken one, or bounds below the minimum size", () => {
    const file = join(mkdtempSync(join(tmpdir(), "caveman-window-")), "window-state.json");
    for (const body of ["{", "null", "[]", `{"bounds":{"x":"1","y":0,"width":900,"height":600}}`, `{"bounds":{"x":0,"y":0,"width":200,"height":100}}`]) {
      writeFileSync(file, body);
      expect(readWindowState(file)).toBeNull();
    }
    writeFileSync(file, `{"bounds":{"x":0,"y":0,"width":900,"height":600}}`);
    expect(readWindowState(file)).toEqual({ bounds: { x: 0, y: 0, width: 900, height: 600 }, maximized: false });
  });

  it("reopens where it was on a display that is still there, else at the default size, centred", () => {
    const onLaptop = { bounds: { x: 120, y: 90, width: 1111, height: 707 }, maximized: false };
    expect(initialBounds(onLaptop, [laptop])).toEqual(onLaptop.bounds);
    const onExternal = { bounds: { x: 2000, y: -100, width: 1400, height: 900 }, maximized: false };
    expect(initialBounds(onExternal, [laptop, external])).toEqual(onExternal.bounds);
    // The external monitor was unplugged: never open off screen.
    expect(initialBounds(onExternal, [laptop])).toBe(DEFAULT_SIZE);
    // Straddling two displays is not wholly on either.
    expect(initialBounds({ bounds: { x: 1000, y: 0, width: 1200, height: 800 }, maximized: false }, [laptop, external])).toBe(DEFAULT_SIZE);
    expect(initialBounds(null, [laptop])).toBe(DEFAULT_SIZE);
    expect(initialBounds(onLaptop, [])).toBe(DEFAULT_SIZE);
  });

  it("tells a change from the state already saved", () => {
    const s = { bounds: { x: 1, y: 2, width: 900, height: 600 }, maximized: false };
    expect(sameState(null, s)).toBe(false);
    expect(sameState(s, { ...s })).toBe(true);
    expect(sameState(s, { ...s, maximized: true })).toBe(false);
    expect(sameState(s, { ...s, bounds: { ...s.bounds, x: 3 } })).toBe(false);
  });
});
