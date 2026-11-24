// The agent cursor computer use on a Mac draws over the person's apps (agent-desktop's cursor overlay, --image and
// --pointer-image): a dart, the pointer a collaborator's cursor takes in a shared document, so it never passes for the
// person's own arrow. It is Caveman's green (packages/ui globals.css, the savings green, `--primary` #4ade80) for every
// agent; the label beside it says whose. The pixel is the only other Caveman in it: drawn by hand, one character per
// pixel, and kept on the grid at one pixel a point (two device pixels on a Retina screen), with the sprite outline
// and a soft shadow. Over something it can press, three click ticks show at its tip. Output:
// src/session-protocol/macDesktop/cursors.ts, which the runtime writes out for agent-desktop, and the arrow in
// apps/web/public for the guide panel.
//
//   node packages/runtime/scripts/agentDesktopCursors.ts
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as zlib from "node:zlib";

/** Caveman's green: every agent's cursor, and its label's accent. */
export const AGENT_COLOUR = "#4ade80";

/** `.` empty, `o` outline, `F` fill. Both share one canvas and one tip, so the overlay swaps them without a jump. */
const DART = `
................
................
................
...oo...........
...oFooo........
....oFFFoo......
....oFFFFFoo....
....oFFFFFFFooo.
.....oFFFFFFFFFo
.....oFFFFFFFFFo
......oFFFooooo.
......oFFFo.....
.......oFFo.....
.......oFFo.....
.......oFFo.....
........oo......`;
const PRESSED = `
....F...........
.F..F...........
................
...oo...........
FF.oFooo........
....oFFFoo......
....oFFFFFoo....
....oFFFFFFFooo.
.....oFFFFFFFFFo
.....oFFFFFFFFFo
......oFFFooooo.
......oFFFo.....
.......oFFo.....
.......oFFo.....
.......oFFo.....
........oo......`;

/** Image pixels per art pixel; at DPI 144 that is one point. */
const SCALE = 2;
const DPI = 144;
/** Room around the art for the shadow, in art pixels. */
const PAD = 4;
const SHADOW = { alpha: 0.45, blur: 2, drop: SCALE } as const;
const OUTLINE = "#0d0914"; // --id-outline

const rows = (art: string) => art.trim().split("\n");
const rgb = (hex: string) => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
/** The click position, in image points: the middle of the dart's tip, its topmost outline pixel. */
const hotspot = (art: string) => {
  const grid = rows(art);
  const y = grid.findIndex((row) => row.includes("o"));
  const x = grid[y]!.indexOf("o");
  const points = (n: number) => +(((n + 0.5 + PAD) * SCALE * 72) / DPI).toFixed(2);
  return `${points(x)},${points(y)}`;
};

/** The art as a PNG: each art pixel SCALE image pixels square, on a soft shadow. */
const paint = (art: string) => {
  const grid = rows(art);
  const width = (Math.max(...grid.map((row) => row.length)) + PAD * 2) * SCALE;
  const height = (grid.length + PAD * 2) * SCALE;
  const colours: Record<string, string> = { o: OUTLINE, F: AGENT_COLOUR };
  const rgba = new Uint8Array(width * height * 4);
  const shape = new Float32Array(width * height);
  grid.forEach((row, ay) =>
    [...row].forEach((ch, ax) => {
      if (ch === ".") return;
      const [r, g, b] = rgb(colours[ch]!);
      for (let y = (ay + PAD) * SCALE; y < (ay + PAD + 1) * SCALE; y++) {
        for (let x = (ax + PAD) * SCALE; x < (ax + PAD + 1) * SCALE; x++) {
          rgba.set([r, g, b, 255], (y * width + x) * 4);
          if (y + SHADOW.drop < height) shape[(y + SHADOW.drop) * width + x] = 1;
        }
      }
    }),
  );
  // Three box blurs make a near-Gaussian shadow; it shows only where the art does not.
  let shadow = shape;
  for (let pass = 0; pass < 3; pass++) shadow = boxBlur(shadow, width, height, SHADOW.blur);
  const [sr, sg, sb] = rgb(OUTLINE);
  for (let i = 0; i < width * height; i++) {
    if (rgba[i * 4 + 3] === 0) rgba.set([sr, sg, sb, Math.round(shadow[i]! * SHADOW.alpha * 255)], i * 4);
  }
  return encodePng(width, height, rgba);
};

const boxBlur = (src: Float32Array, width: number, height: number, radius: number) => {
  const across = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  const span = radius * 2 + 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += src[y * width + Math.min(width - 1, Math.max(0, x + k))]!;
      across[y * width + x] = sum / span;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += across[Math.min(height - 1, Math.max(0, y + k)) * width + x]!;
      out[y * width + x] = sum / span;
    }
  }
  return out;
};

// A PNG with a pHYs chunk, so macOS reads it at DPI (points = pixels * 72 / DPI).
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const out = Buffer.alloc(body.length + 8);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), body.length + 4);
  return out;
};
const encodePng = (width: number, height: number, rgba: Uint8Array) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 6, 0, 0, 0], 8); // 8-bit RGBA
  const lines = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) lines.set(rgba.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1);
  const ppm = Math.round(DPI / 0.0254);
  const phys = Buffer.alloc(9);
  phys.writeUInt32BE(ppm, 0);
  phys.writeUInt32BE(ppm, 4);
  phys[8] = 1;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("pHYs", phys),
    chunk("IDAT", zlib.deflateSync(lines)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
};

if (import.meta.main) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const cursor = paint(DART);
  const target = path.resolve(here, "../src/session-protocol/macDesktop/cursors.ts");
  fs.writeFileSync(
    target,
    `// Generated by scripts/agentDesktopCursors.ts: the agents' dart in Caveman's green, and pressed (click ticks), one
// pixel a point at 144 dpi. Do not edit; run the script.
export const AGENT_COLOUR = "${AGENT_COLOUR}";
export const CURSOR_HOTSPOT = "${hotspot(DART)}";
export const POINTER_HOTSPOT = "${hotspot(DART)}";
export const CURSOR = "${cursor.toString("base64")}";
export const POINTER = "${paint(PRESSED).toString("base64")}";
`,
  );
  // The guide panel's carry draws it too (apps/web/public/computer-guide.html).
  const guide = path.resolve(here, "../../../apps/web/public/computer-guide-cursor.png");
  fs.writeFileSync(guide, cursor);
  console.log(`wrote ${target} and ${guide}`);
}
