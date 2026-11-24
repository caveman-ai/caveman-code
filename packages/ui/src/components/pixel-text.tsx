import type { CSSProperties } from "react";
import { cn } from "../lib/cn";

/*
 * Blocky 5-row bitmap letters, the old NES look, drawn as crisp SVG paths in
 * currentColor: the whole alphabet, the digits and a little punctuation; any
 * other character falls back to plain uppercase text. `shadow` adds the hard
 * 1px drop under every pixel in `--px-shade` (the sprite outline unless the
 * parent sets it: dark ink on a light panel wants a light shade).
 *
 * Each glyph is its own `.px-glyph` group with its index in `--i`, so a parent
 * can move letters one at a time (the effort word's drop, slam and ripple).
 * Positions live in the path data, never a transform attribute, so a CSS
 * transform on a glyph moves it in whole grid pixels.
 */
const GLYPHS: Record<string, readonly string[]> = {
  A: [".###.", "#...#", "#####", "#...#", "#...#"],
  B: ["####.", "#...#", "####.", "#...#", "####."],
  C: [".####", "#....", "#....", "#....", ".####"],
  D: ["####.", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "####.", "#....", "#####"],
  F: ["#####", "#....", "####.", "#....", "#...."],
  G: [".####", "#....", "#..##", "#...#", ".###."],
  H: ["#...#", "#...#", "#####", "#...#", "#...#"],
  I: ["###", ".#.", ".#.", ".#.", "###"],
  J: ["....#", "....#", "....#", "#...#", ".###."],
  K: ["#...#", "#..#.", "###..", "#..#.", "#...#"],
  L: ["#....", "#....", "#....", "#....", "#####"],
  M: ["#...#", "##.##", "#.#.#", "#...#", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
  O: [".###.", "#...#", "#...#", "#...#", ".###."],
  P: ["####.", "#...#", "####.", "#....", "#...."],
  Q: [".###.", "#...#", "#.#.#", "#..#.", ".##.#"],
  R: ["####.", "#...#", "####.", "#..#.", "#...#"],
  S: [".####", "#....", ".###.", "....#", "####."],
  T: ["#####", "..#..", "..#..", "..#..", "..#.."],
  U: ["#...#", "#...#", "#...#", "#...#", ".###."],
  V: ["#...#", "#...#", "#...#", ".#.#.", "..#.."],
  W: ["#...#", "#...#", "#.#.#", "##.##", "#...#"],
  X: ["#...#", ".#.#.", "..#..", ".#.#.", "#...#"],
  Y: ["#...#", ".#.#.", "..#..", "..#..", "..#.."],
  Z: ["#####", "...#.", "..#..", ".#...", "#####"],
  "0": [".###.", "#..##", "#.#.#", "##..#", ".###."],
  "1": [".#.", "##.", ".#.", ".#.", "###"],
  "2": ["####.", "....#", ".###.", "#....", "#####"],
  "3": ["####.", "....#", ".###.", "....#", "####."],
  "4": ["#...#", "#...#", "#####", "....#", "....#"],
  "5": ["#####", "#....", "####.", "....#", "####."],
  "6": [".###.", "#....", "####.", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", "..#.."],
  "8": [".###.", "#...#", ".###.", "#...#", ".###."],
  "9": [".###.", "#...#", ".####", "....#", ".###."],
  "!": ["#", "#", "#", ".", "#"],
  "?": [".###.", "#...#", "..##.", ".....", "..#.."],
  ".": [".", ".", ".", ".", "#"],
  ",": [".", ".", ".", "#", "#"],
  ":": [".", "#", ".", "#", "."],
  "'": ["#", "#", ".", ".", "."],
  "-": ["...", "...", "###", "...", "..."],
  "+": ["...", ".#.", "###", ".#.", "..."],
  "/": ["....#", "...#.", "..#..", ".#...", "#...."],
  " ": ["..", "..", "..", "..", ".."],
};

export function PixelText({
  text,
  scale = 2,
  shadow = false,
  className,
}: {
  text: string;
  scale?: number;
  shadow?: boolean;
  className?: string;
}) {
  const chars = [...text.toUpperCase()];
  if (!chars.every((c) => c in GLYPHS)) return <span className={cn("uppercase", className)}>{text}</span>;
  let x = 0;
  const glyphs = chars.map((c) => {
    const rows = GLYPHS[c]!;
    let d = "";
    rows.forEach((row, y) => {
      for (let i = 0; i < row.length; i++) if (row[i] === "#") d += `M${x + i} ${y}h1v1h-1z`;
    });
    x += rows[0]!.length + 1;
    return d;
  });
  const w = x - 1 + (shadow ? 1 : 0);
  const h = 5 + (shadow ? 1 : 0);
  return (
    <svg
      role="img"
      aria-label={text}
      className={cn("px-art inline-block shrink-0 overflow-visible", className)}
      width={w * scale}
      height={h * scale}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
    >
      {glyphs.map((d, i) =>
        d ? (
          <g key={i} className="px-glyph" style={{ "--i": i } as CSSProperties}>
            {shadow ? <path d={d} transform="translate(1 1)" style={{ fill: "var(--px-shade, hsl(var(--id-outline)))" }} /> : null}
            <path d={d} fill="currentColor" />
          </g>
        ) : null,
      )}
    </svg>
  );
}
