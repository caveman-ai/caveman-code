// chat_read's images at most 1568 px a side: sizes read from each format's header, an image that fits kept byte for
// byte, and one that can't be shrunk (a GIF or WebP, or more pixels than are ever decoded) or read left out.
import * as jpeg from "jpeg-js";
import { describe, expect, it } from "vitest";

import { fitImage, imageSize } from "./images.ts";

const pngHeader = (width: number, height: number) => {
  const bytes = Buffer.alloc(33);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
};
const riff = (chunk: string, body: Array<number>) =>
  Buffer.concat([
    Buffer.from("RIFF\0\0\0\0WEBP", "latin1"),
    Buffer.from(chunk, "latin1"),
    Buffer.alloc(4),
    Buffer.from(body),
  ]);

describe("imageSize", () => {
  it("reads the size from a PNG, JPEG, GIF or WebP header", () => {
    expect(imageSize(pngHeader(2880, 1800), "image/png")).toEqual({ width: 2880, height: 1800 });
    const photo = jpeg.encode(
      { width: 40, height: 30, data: Buffer.alloc(40 * 30 * 4, 200) },
      80,
    ).data;
    expect(imageSize(photo, "image/jpeg")).toEqual({ width: 40, height: 30 });
    expect(
      imageSize(
        Buffer.from([...Buffer.from("GIF89a", "latin1"), 0xd0, 0x07, 0x64, 0x00]),
        "image/gif",
      ),
    ).toEqual({ width: 2000, height: 100 });
    // Lossy: a frame tag, the start code, then 14-bit width and height.
    expect(
      imageSize(riff("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0xd0, 0x07, 0x64, 0x00]), "image/webp"),
    ).toEqual({ width: 2000, height: 100 });
    // Lossless: a signature byte, then width - 1 and height - 1 packed in 14 bits each.
    const packed = (2000 - 1) | ((100 - 1) << 14);
    expect(
      imageSize(
        riff("VP8L", [
          0x2f,
          packed & 0xff,
          (packed >> 8) & 0xff,
          (packed >> 16) & 0xff,
          (packed >> 24) & 0xff,
        ]),
        "image/webp",
      ),
    ).toEqual({ width: 2000, height: 100 });
    // Extended: flags, then width - 1 and height - 1 in 24 bits each.
    expect(
      imageSize(riff("VP8X", [0, 0, 0, 0, 0xcf, 0x07, 0x00, 0x63, 0x00, 0x00]), "image/webp"),
    ).toEqual({ width: 2000, height: 100 });
    expect(imageSize(Buffer.from("not an image"), "image/png")).toBeUndefined();
  });
});

describe("fitImage", () => {
  it("keeps an image that fits byte for byte", () => {
    const gif = Buffer.from([
      ...Buffer.from("GIF89a", "latin1"),
      0x20,
      0x06,
      0x64,
      0x00,
      0,
      0,
      0,
      0x3b,
    ]);
    expect(fitImage(gif, "image/gif")).toEqual({ mime: "image/gif", data: gif.toString("base64") });
  });

  it("leaves out a larger WebP, and never decodes more pixels than it may however small the file", () => {
    expect(
      fitImage(riff("VP8X", [0, 0, 0, 0, 0xcf, 0x07, 0x00, 0x63, 0x00, 0x00]), "image/webp"),
    ).toBe("too_large");
    expect(fitImage(pngHeader(10_000, 10_000), "image/png")).toBe("too_large");
  });

  it("says a larger image whose pixels can't be decoded can't be read", () => {
    expect(fitImage(pngHeader(3000, 10), "image/png")).toBe("unreadable");
    expect(
      fitImage(Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 10, 0x0b, 0xb8, 3]), "image/jpeg"),
    ).toBe("unreadable");
  });
});
