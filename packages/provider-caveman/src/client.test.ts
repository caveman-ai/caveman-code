// The engine glyph is the app avatar, pixel for pixel. Redraw the avatar and this fails until client.ts follows.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { cavemanClient } from "./client.ts";

const pixels = (rects: Iterable<readonly [string, string, string, string]>) => {
  const map = new Map<string, string>();
  for (const [x, y, width, fill] of rects) {
    for (let dx = 0; dx < Number(width); dx++) map.set(`${Number(x) + dx},${y}`, fill.toLowerCase());
  }
  return Object.fromEntries([...map].sort());
};

describe("cavemanClient icon", () => {
  it("matches packages/ui/src/assets/caveman.svg", () => {
    const svg = readFileSync(new URL("../../ui/src/assets/caveman.svg", import.meta.url), "utf8");
    const avatar = pixels(
      [...svg.matchAll(/<rect x="(\d+)" y="(\d+)" width="(\d+)" height="1" fill="(#[0-9a-fA-F]{6})"\/>/g)].map(
        ([, x, y, w, fill]) => [x!, y!, w!, fill!] as const,
      ),
    );
    const icon = pixels(
      (cavemanClient.icon?.paths ?? []).flatMap((path) =>
        [...path.d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].map(([, x, y, w]) => [x!, y!, w!, path.fill!.light] as const),
      ),
    );
    expect(Object.keys(avatar).length).toBeGreaterThan(100);
    expect(icon).toEqual(avatar);
  });
});
