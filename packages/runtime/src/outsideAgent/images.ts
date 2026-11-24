// chat_read's images go out at most 1568 px on their longer side (docs/ §3):
// what Claude reads at full detail. A larger one costs the agent's model for nothing, and past 8000 px a side Claude's
// API refuses it, and every later request of the conversation holding it. PNG and JPEG are shrunk here; a larger GIF
// or WebP is left out. Nothing larger than MAX_PIXELS is decoded: a small file can hold a huge image.
import * as jpeg from "jpeg-js";
import { PNG } from "pngjs";

export const IMAGE_EDGE = 1568;
const MAX_PIXELS = 64_000_000;
const JPEG_QUALITY = 85;

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** What may go to an agent: the image (itself when it fits), or why not. */
export type Fitted = { readonly mime: string; readonly data: string } | "too_large" | "unreadable";

/** Width and height as the image's header says: PNG, JPEG, GIF or WebP (`mime` as sniffed from its bytes). */
export function imageSize(bytes: Buffer, mime: string): Size | undefined {
  const size = (width: number, height: number) =>
    width > 0 && height > 0 ? { width, height } : undefined;
  try {
    switch (mime) {
      case "image/png":
        return bytes.toString("latin1", 12, 16) === "IHDR"
          ? size(bytes.readUInt32BE(16), bytes.readUInt32BE(20))
          : undefined;
      case "image/gif":
        return size(bytes.readUInt16LE(6), bytes.readUInt16LE(8));
      case "image/webp": {
        const chunk = bytes.toString("latin1", 12, 16);
        if (chunk === "VP8 ")
          return size(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
        if (chunk === "VP8L") {
          const bits = bytes.readUInt32LE(21);
          return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
        }
        if (chunk === "VP8X") return size(bytes.readUIntLE(24, 3) + 1, bytes.readUIntLE(27, 3) + 1);
        return undefined;
      }
      case "image/jpeg": {
        let i = 2;
        while (i + 9 < bytes.length) {
          if (bytes[i] !== 0xff) return undefined;
          const marker = bytes[i + 1]!;
          if (marker === 0xff) {
            i++;
            continue;
          }
          if (
            marker >= 0xc0 &&
            marker <= 0xcf &&
            marker !== 0xc4 &&
            marker !== 0xc8 &&
            marker !== 0xcc
          )
            return size(bytes.readUInt16BE(i + 7), bytes.readUInt16BE(i + 5));
          i += 2 + bytes.readUInt16BE(i + 2);
        }
        return undefined;
      }
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

/** The image at most IMAGE_EDGE px a side: unchanged when it fits, else shrunk to fit (`mime` as sniffed). */
export function fitImage(bytes: Buffer, mime: string): Fitted {
  const size = imageSize(bytes, mime);
  if (size === undefined) return "unreadable";
  const scale = IMAGE_EDGE / Math.max(size.width, size.height);
  if (scale >= 1) return { mime, data: bytes.toString("base64") };
  if ((mime !== "image/png" && mime !== "image/jpeg") || size.width * size.height > MAX_PIXELS)
    return "too_large";
  const width = Math.max(1, Math.round(size.width * scale));
  const height = Math.max(1, Math.round(size.height * scale));
  try {
    if (mime === "image/png") {
      const decoded = PNG.sync.read(bytes);
      const out = new PNG({ width, height });
      out.data = Buffer.from(
        shrink(decoded.data, decoded.width, decoded.height, width, height).buffer,
      );
      const opaque = out.data.every((value, i) => i % 4 !== 3 || value === 255);
      return { mime, data: PNG.sync.write(out, opaque ? { colorType: 2 } : {}).toString("base64") };
    }
    const decoded = jpeg.decode(bytes, {
      useTArray: true,
      formatAsRGBA: true,
      maxResolutionInMP: MAX_PIXELS / 1_000_000,
    });
    const oriented = orient(
      shrink(decoded.data, decoded.width, decoded.height, width, height),
      width,
      height,
      exifOrientation(bytes),
    );
    return { mime, data: jpeg.encode(oriented, JPEG_QUALITY).data.toString("base64") };
  } catch {
    return "unreadable";
  }
}

/** For each of `to` cells over `from` (fewer), the source cells under it and the share of it each covers. */
function spans(
  from: number,
  to: number,
): Array<{ readonly first: number; readonly weights: Float64Array }> {
  const step = from / to;
  return Array.from({ length: to }, (_, t) => {
    const start = t * step;
    const end = Math.min(from, start + step);
    const first = Math.floor(start);
    const weights = new Float64Array(Math.max(1, Math.ceil(end) - first));
    for (let k = 0; k < weights.length; k++)
      weights[k] = (Math.min(end, first + k + 1) - Math.max(start, first + k)) / step;
    return { first, weights };
  });
}

/** RGBA shrunk by area averaging (each pixel the mean of what it covers), colour weighted by alpha. */
function shrink(
  src: Uint8Array,
  width: number,
  height: number,
  toWidth: number,
  toHeight: number,
): Uint8Array {
  const xs = spans(width, toWidth);
  const ys = spans(height, toHeight);
  const out = new Uint8Array(toWidth * toHeight * 4);
  const row = new Float64Array(toWidth * 4);
  const sum = new Float64Array(toWidth * 4);
  for (let ty = 0; ty < toHeight; ty++) {
    sum.fill(0);
    const { first: firstY, weights: wy } = ys[ty]!;
    for (let ky = 0; ky < wy.length; ky++) {
      row.fill(0);
      const line = (firstY + ky) * width * 4;
      for (let tx = 0; tx < toWidth; tx++) {
        const { first: firstX, weights: wx } = xs[tx]!;
        for (let kx = 0; kx < wx.length; kx++) {
          const i = line + (firstX + kx) * 4;
          const j = tx * 4;
          const a = src[i + 3]! * wx[kx]!;
          row[j] = row[j]! + src[i]! * a;
          row[j + 1] = row[j + 1]! + src[i + 1]! * a;
          row[j + 2] = row[j + 2]! + src[i + 2]! * a;
          row[j + 3] = row[j + 3]! + a;
        }
      }
      for (let k = 0; k < row.length; k++) sum[k] = sum[k]! + row[k]! * wy[ky]!;
    }
    for (let tx = 0; tx < toWidth; tx++) {
      const a = sum[tx * 4 + 3]!;
      const o = (ty * toWidth + tx) * 4;
      if (a > 0) for (let c = 0; c < 3; c++) out[o + c] = Math.round(sum[tx * 4 + c]! / a);
      out[o + 3] = Math.round(a);
    }
  }
  return out;
}

/** The Exif orientation (1 to 8) of a JPEG; 1 when it has none. */
function exifOrientation(bytes: Buffer): number {
  try {
    let i = 2;
    while (i + 4 < bytes.length && bytes[i] === 0xff) {
      const marker = bytes[i + 1]!;
      const length = bytes.readUInt16BE(i + 2);
      if (marker === 0xda) return 1;
      if (marker === 0xe1 && bytes.toString("latin1", i + 4, i + 10) === "Exif\0\0") {
        const tiff = i + 10;
        const little = bytes.toString("latin1", tiff, tiff + 2) === "II";
        const u16 = (at: number) => (little ? bytes.readUInt16LE(at) : bytes.readUInt16BE(at));
        const ifd = tiff + (little ? bytes.readUInt32LE(tiff + 4) : bytes.readUInt32BE(tiff + 4));
        for (let n = 0, count = u16(ifd); n < count; n++) {
          const entry = ifd + 2 + n * 12;
          if (u16(entry) === 0x0112) {
            const value = u16(entry + 8);
            return value >= 1 && value <= 8 ? value : 1;
          }
        }
        return 1;
      }
      i += 2 + length;
    }
  } catch {
    // A broken Exif block shows the pixels as stored.
  }
  return 1;
}

/** RGBA turned upright as its Exif orientation says (the encoder writes no Exif, so the pixels must carry it). */
function orient(
  src: Uint8Array,
  width: number,
  height: number,
  orientation: number,
): { width: number; height: number; data: Uint8Array } {
  if (orientation === 1) return { width, height, data: src };
  const swap = orientation >= 5;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [sx, sy] =
        orientation === 2
          ? [width - 1 - x, y]
          : orientation === 3
            ? [width - 1 - x, height - 1 - y]
            : orientation === 4
              ? [x, height - 1 - y]
              : orientation === 5
                ? [y, x]
                : orientation === 6
                  ? [y, height - 1 - x]
                  : orientation === 7
                    ? [width - 1 - y, height - 1 - x]
                    : [width - 1 - y, x];
      out.set(src.subarray((sy * width + sx) * 4, (sy * width + sx) * 4 + 4), (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data: out };
}
