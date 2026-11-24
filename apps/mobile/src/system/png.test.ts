/// <reference types="node" />
// The faces' PNGs (png.ts, faces.ts): a real PNG that a standard decoder reads back cell for cell.
import { inflateSync } from "node:zlib";
import { MASCOT_SPRITES } from "@caveman-app/ui/mascot/sprites";
import { describe, expect, it } from "vitest";
import { cellsOf, gridPng, rgb } from "./png";

/** Reads back what gridPng wrote: size and RGBA pixels. */
function decode(png: Uint8Array) {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  let at = 8;
  let width = 0;
  let height = 0;
  const data: Uint8Array[] = [];
  while (at < png.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
    }
    if (type === "IDAT") data.push(png.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(data));
  return { width, height, pixel: (x: number, y: number) => [...raw.subarray(y * (1 + width * 4) + 1 + x * 4, y * (1 + width * 4) + 5 + x * 4)] };
}

describe("gridPng", () => {
  it("writes a PNG a standard decoder reads back, cell for cell", () => {
    const png = gridPng(4, 3, (x, y) => (x === y ? "#f09c2d" : null));
    const { width, height, pixel } = decode(png);
    expect([width, height]).toEqual([12, 12]);
    expect(pixel(4, 4)).toEqual([...rgb("#f09c2d"), 255]);
    expect(pixel(5, 3)).toEqual([...rgb("#f09c2d"), 255]);
    expect(pixel(4, 0)).toEqual([0, 0, 0, 0]);
  });

  it("spans more than one stored block for a big face", () => {
    const png = gridPng(24, 8, () => "#123456");
    const { width, pixel } = decode(png);
    expect(width).toBe(192);
    expect(pixel(191, 191)).toEqual([0x12, 0x34, 0x56, 255]);
  });
});

describe("cellsOf", () => {
  it("paints frame 0 of the caveman's idle sheet and nothing past it", () => {
    const grid = cellsOf(MASCOT_SPRITES.body.idle.paths, { outline: "#000000" });
    const filled = grid.filter(Boolean).length;
    expect(filled).toBeGreaterThan(100);
    expect(grid.length).toBe(24 * 24);
  });
});
