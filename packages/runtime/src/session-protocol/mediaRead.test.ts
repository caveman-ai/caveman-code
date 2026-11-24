import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, expect, test } from "vitest";

import { imageMime, markdownMime, MAX_IMAGE_BYTES, playableMime, readImageFile, resolveImagePath } from "./mediaRead.ts";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "media-read-")));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const write = (name: string, bytes: Buffer | string) => {
  const file = path.join(root, name);
  fs.writeFileSync(file, bytes);
  return file;
};

test("paths: absolute, ~/, or relative to the worktree", () => {
  // Native paths come back (backslashes on Windows, where only a path resolved against a base gains a drive).
  expect(resolveImagePath("/tmp/a b/shot.png", "/home/me", null)).toBe(path.normalize("/tmp/a b/shot.png"));
  expect(resolveImagePath("~/shots/a.png", "/home/me", null)).toBe(path.normalize("/home/me/shots/a.png"));
  expect(resolveImagePath("shots/../a.png", "/home/me", "/w")).toBe(path.resolve("/w/a.png"));
  expect(resolveImagePath("shots/a.png", "/home/me", null)).toBeNull();
  expect(resolveImagePath("  ", "/home/me", "/w")).toBeNull();
  expect(resolveImagePath("/a\0b.png", "/home/me", "/w")).toBeNull();
  for (const share of ["\\\\evil.example\\s\\a.png", "//evil.example/s/a.png", "\\\\?\\UNC\\evil\\a.png", "  \\/evil/a.png"]) {
    expect(resolveImagePath(share, "/home/me", "/w"), share).toBeNull();
  }
});

test("an image is known by its bytes; SVG also by its name", () => {
  expect(imageMime("x.bin", PNG)).toBe("image/png");
  expect(imageMime("x.png", Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
  expect(imageMime("x", Buffer.from("GIF89a...."))).toBe("image/gif");
  expect(imageMime("x", Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]))).toBe("image/webp");
  expect(imageMime("x", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypavif")]))).toBe("image/avif");
  expect(imageMime("a.svg", Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBe("image/svg+xml");
  expect(imageMime("a.png", Buffer.from("<svg/>"))).toBeNull();
  expect(imageMime("a.svg", Buffer.from("not svg"))).toBeNull();
  expect(imageMime("creds.png", Buffer.from('{"claudeAiOauth":{"accessToken":"x"}}'))).toBeNull();
  const bmp = Buffer.alloc(30);
  bmp.write("BM", 0, "latin1");
  bmp.writeUInt32LE(40, 14);
  expect(imageMime("x.bmp", bmp)).toBe("image/bmp");
  expect(imageMime("page.html", Buffer.from("BM<html><script>alert(1)</script></html>"))).toBeNull();
});

test("reads an image whole, from its real path", async () => {
  const file = write("shot.png", PNG);
  const link = path.join(root, "link to shot.png");
  fs.symlinkSync(file, link);
  const read = await readImageFile(link);
  expect(read).toEqual({ kind: "image", path: file, mime: "image/png", bytes: PNG });
});

test("markdown by its real name and UTF-8 text", async () => {
  expect(markdownMime("/m/plan.md", Buffer.from("# Plan\n"))).toBe("text/markdown");
  expect(markdownMime("/m/plan.txt", Buffer.from("# Plan\n"))).toBeNull();
  expect(markdownMime("/m/plan.md", Buffer.from([0x23, 0x00, 0x41]))).toBeNull();
  expect(markdownMime("/m/plan.md", Buffer.from([0xff, 0xfe, 0x41]))).toBeNull();
  const plan = write("plan.md", "# Plan\n");
  expect(await readImageFile(plan)).toEqual({ kind: "image", path: plan, mime: "text/markdown", bytes: Buffer.from("# Plan\n") });
  // A link named like markdown is judged by what it points at.
  const secret = write("token.json", '{"token":"secret"}');
  const link = path.join(root, "notes.md");
  fs.symlinkSync(secret, link);
  expect(await readImageFile(link)).toEqual({ kind: "refused", message: expect.stringContaining("is not an image, markdown, audio or video") });
});

test("audio and video are known by their bytes; the MP4 and WebM containers by the name too", async () => {
  const mp4 = (brand: string) => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from(`ftyp${brand}`, "latin1"), Buffer.alloc(8)]);
  expect(playableMime("a.mp3", Buffer.from("ID3\x04\x00", "latin1"))).toBe("audio/mpeg");
  expect(playableMime("a.mp3", Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toBe("audio/mpeg");
  expect(playableMime("a.wav", Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1"))).toBe("audio/wav");
  expect(playableMime("a.flac", Buffer.from("fLaC\x00", "latin1"))).toBe("audio/flac");
  expect(playableMime("a.ogg", Buffer.from("OggS\x00", "latin1"))).toBe("audio/ogg");
  expect(playableMime("a.m4a", mp4("M4A "))).toBe("audio/mp4");
  expect(playableMime("clip.mp4", mp4("isom"))).toBe("video/mp4");
  expect(playableMime("clip.mov", mp4("qt  "))).toBe("video/quicktime");
  expect(playableMime("clip.webm", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("video/webm");
  expect(playableMime("voice.weba", Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01]))).toBe("audio/webm");
  // A name is never enough: a text file called take.mp3 is not audio.
  expect(playableMime("take.mp3", Buffer.from("TOKEN=secret", "latin1"))).toBeNull();
  const read = await readImageFile(write("take.wav", Buffer.from("RIFF\x00\x00\x00\x00WAVEfmt ", "latin1")));
  expect(read).toMatchObject({ kind: "image", mime: "audio/wav" });
  expect(await readImageFile(write("take.mp3", "TOKEN=secret"))).toEqual({ kind: "refused", message: expect.stringContaining("is not an image") });
});

test("refuses what is not an image, too big, or not a file; missing is missing", async () => {
  expect(await readImageFile(write("creds.png", '{"token":"secret"}'))).toEqual({ kind: "refused", message: expect.stringContaining("is not an image") });
  expect(await readImageFile(path.join(root, "nope.png"))).toEqual({ kind: "missing" });
  expect(await readImageFile(root)).toEqual({ kind: "refused", message: expect.stringContaining("is not a file") });
  const big = path.join(root, "big.png");
  fs.writeFileSync(big, PNG);
  fs.truncateSync(big, MAX_IMAGE_BYTES + 1);
  expect(await readImageFile(big)).toEqual({ kind: "refused", message: expect.stringContaining("over 16 MB") });
});

test.skipIf(process.platform === "win32")("a FIFO named like an image is refused at once, never waited on", async () => {
  const fifo = path.join(root, "pipe.png");
  execFileSync("mkfifo", [fifo]);
  expect(await readImageFile(fifo)).toEqual({ kind: "refused", message: expect.stringContaining("is not a file") });
});
