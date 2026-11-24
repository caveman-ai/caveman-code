import { describe, expect, it } from "vitest";
import { lookOf } from "./logo-look.ts";

const N = 32;
/** A transparent square with `ink` painted where `inside(x, y)`. */
function draw(ink: readonly [number, number, number], inside: (x: number, y: number) => boolean, ground?: readonly [number, number, number]) {
  const px = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const c = inside(x, y) ? ink : ground;
      if (c) px.set([...c, 255], (y * N + x) * 4);
    }
  return px;
}
const mark = (x: number, y: number) => x > 8 && x < 24 && y > 8 && y < 24;

describe("lookOf", () => {
  it("finds black ink lost on the dark tile (GitHub's mark with no dark variant)", () => {
    expect(lookOf(draw([0x18, 0x17, 0x17], mark), N)).toEqual({ tile: false, darkInk: true, lightInk: false, mono: true });
  });

  it("leaves a coloured mark alone in both themes (Linear's violet)", () => {
    expect(lookOf(draw([0x5e, 0x6a, 0xd2], mark), N)).toMatchObject({ tile: false, darkInk: false, lightInk: false });
  });

  it("finds white ink lost on a white tile, but not a yellow or mint mark drawn for white", () => {
    expect(lookOf(draw([255, 255, 255], mark), N)).toMatchObject({ lightInk: true, darkInk: false });
    expect(lookOf(draw([0xff, 0xd2, 0x1e], mark), N).lightInk).toBe(false);
    expect(lookOf(draw([0x3f, 0xcf, 0x8e], mark), N).lightInk).toBe(false);
  });

  it("tells a one-colour mark from a many-coloured one", () => {
    expect(lookOf(draw([0x18, 0x17, 0x17], mark), N).mono).toBe(true);
    const twoTone = draw([0x2d, 0x45, 0x52], (x, y) => mark(x, y) && x < 16);
    twoTone.set(draw([0xe2, 0x57, 0x4c], (x, y) => mark(x, y) && x >= 16).map((v, i) => (twoTone[i]! || v)));
    expect(lookOf(twoTone, N)).toMatchObject({ mono: false });
  });

  it("calls an icon opaque to its edges a tile, rounded corners and all (Slack's aubergine square)", () => {
    const r = 6;
    const rounded = (x: number, y: number) => {
      const cx = Math.min(Math.max(x, r), N - 1 - r);
      const cy = Math.min(Math.max(y, r), N - 1 - r);
      return Math.hypot(x - cx, y - cy) <= r;
    };
    expect(lookOf(draw([0x4a, 0x15, 0x4b], rounded), N).tile).toBe(true);
  });

  it("never calls an outline mark a tile, however thick its edge (Neon's)", () => {
    const outline = (x: number, y: number) => x < 6 || y < 6 || x > 25 || y > 25;
    expect(lookOf(draw([0x34, 0xd5, 0x9a], outline), N).tile).toBe(false);
  });

  it("never calls a wide wordmark letterboxed in the square a tile", () => {
    expect(lookOf(draw([0x63, 0x5b, 0xff], (_x, y) => y > 11 && y < 20), N).tile).toBe(false);
  });

  it("says nothing about a blank image", () => {
    expect(lookOf(new Uint8ClampedArray(N * N * 4), N)).toEqual({ tile: false, darkInk: false, lightInk: false, mono: false });
  });
});
