// A PNG from a grid of coloured cells, with no image library: the Lock Screen and the widget show each Chief's face
// as a picture file (system/faces.ts), and a pixel character is only squares. RGBA, every row unfiltered, the image
// data in stored (uncompressed) deflate blocks, which every PNG reader takes; a face is a few dozen kilobytes.

const CRC = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array, from = 0, to = bytes.length): number {
  let c = 0xffffffff;
  for (let i = from; i < to; i++) c = CRC[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const u32 = (out: Uint8Array, at: number, v: number) => {
  out[at] = v >>> 24;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
};

/** zlib around stored deflate blocks of at most 65535 bytes. */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let b = 0; b < blocks; b++) {
    const start = b * 65535;
    const len = Math.min(65535, raw.length - start);
    out[at++] = b === blocks - 1 ? 1 : 0;
    out[at++] = len & 0xff;
    out[at++] = len >>> 8;
    out[at++] = ~len & 0xff;
    out[at++] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(start, start + len), at);
    at += len;
  }
  u32(out, at, adler32(raw));
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  u32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  u32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

/** "#rrggbb" as [r, g, b]. */
export function rgb(hex: string): [number, number, number] {
  const v = Number.parseInt(hex.replace("#", "").slice(0, 6), 16);
  return [(v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

/**
 * A `cells` x `cells` grid, each cell `scale` pixels square, painted by `paint(x, y)` ("#rrggbb", or null for clear),
 * as a PNG file's bytes.
 */
export function gridPng(cells: number, scale: number, paint: (x: number, y: number) => string | null): Uint8Array {
  const size = cells * scale;
  const stride = 1 + size * 4;
  const raw = new Uint8Array(stride * size);
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0; // filter: none
    const cy = Math.floor(y / scale);
    for (let x = 0; x < size; x++) {
      const fill = paint(Math.floor(x / scale), cy);
      if (!fill) continue;
      const [r, g, b] = rgb(fill);
      const at = y * stride + 1 + x * 4;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
      raw[at + 3] = 255;
    }
  }
  const head = new Uint8Array(13);
  u32(head, 0, size);
  u32(head, 4, size);
  head[8] = 8; // bit depth
  head[9] = 6; // RGBA
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [signature, chunk("IHDR", head), chunk("IDAT", zlibStored(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A mascot sheet's frame is 24 cells square (Sprite.tsx's viewBox). */
export const CELLS = 24;

/** Which cell holds which token in frame 0 of a sheet's paths ("M5 0h6v1h-6z…", one rectangle per run). */
export function cellsOf(paths: readonly (readonly [string, string])[], colors: Record<string, string>): (string | null)[] {
  const grid: (string | null)[] = new Array(CELLS * CELLS).fill(null);
  for (const [token, d] of paths) {
    const fill = colors[token] ?? colors.outline ?? "#0d0914";
    for (const m of d.matchAll(/M(-?\d+) (-?\d+)h(\d+)v(\d+)h-?\d+z/g)) {
      const x0 = Number(m[1]);
      const y0 = Number(m[2]);
      const w = Number(m[3]);
      const h = Number(m[4]);
      for (let y = y0; y < y0 + h; y++) {
        for (let x = x0; x < x0 + w; x++) {
          if (x >= 0 && x < CELLS && y >= 0 && y < CELLS) grid[y * CELLS + x] = fill;
        }
      }
    }
  }
  return grid;
}
