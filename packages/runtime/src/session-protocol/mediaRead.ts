// media.read: the image a chat shows (most often the screenshot an agent saved
// as proof of UI work and put in its reply as `![alt](/abs/shot.png)`). The
// one Session Protocol read that takes a host path, so it serves image files,
// recognized by their bytes, never by their name alone (a credentials file
// named shot.png is refused like any other non-image), markdown an agent
// wrote outside the chat's folder (a plan, a memory), known by its real name
// and UTF-8 text, and the audio and video an agent shares (a clip it recorded
// or generated, `![take](/tmp/take.mp3)`), known by their bytes too.
import * as fs from "node:fs";
import * as path from "node:path";

import { expandHomePath } from "@caveman-app/engine-core/server/pathExpansion";

/** The runtime's fs.read clamp; a full-page capture fits well inside it. */
export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

export type ImageRead =
  | { readonly kind: "image"; readonly path: string; readonly mime: string; readonly bytes: Buffer }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly message: string };

/**
 * An absolute path, `~/…`, or one relative to `base` (the worktree; null when
 * there is none). Never a network share (`\\host\share`, `//host`): opening
 * one sends the person's Windows credentials to that host.
 */
export function resolveImagePath(given: string, home: string, base: string | null): string | null {
  const trimmed = given.trim();
  if (!trimmed || trimmed.includes("\0") || /^[\\/]{2}/.test(trimmed)) return null;
  const expanded = expandHomePath(trimmed, home);
  if (path.isAbsolute(expanded)) return path.normalize(expanded);
  return base === null ? null : path.resolve(base, expanded);
}

/** `refused` names what is never served whatever its bytes (the runtime's own state); it reads as missing. */
export async function readImageFile(file: string, refused?: (real: string) => boolean): Promise<ImageRead> {
  let real: string;
  try {
    real = await fs.promises.realpath(file);
  } catch {
    return { kind: "missing" };
  }
  if (refused?.(real)) return { kind: "missing" };
  // A device or a pipe is never opened: some do something when they are.
  try {
    if (!(await fs.promises.stat(real)).isFile()) return { kind: "refused", message: `${file} is not a file` };
  } catch {
    return { kind: "missing" };
  }
  let handle: fs.promises.FileHandle;
  try {
    // Non-blocking: a FIFO swapped in since the stat can't stall the runtime on open.
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0));
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "missing" } : { kind: "refused", message: `can't read ${file}` };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { kind: "refused", message: `${file} is not a file` };
    if (stat.size > MAX_IMAGE_BYTES) return { kind: "refused", message: `${file} is over 16 MB` };
    const bytes = Buffer.alloc(stat.size);
    let read = 0;
    while (read < bytes.length) {
      const { bytesRead } = await handle.read(bytes, read, bytes.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    const data = bytes.subarray(0, read);
    const mime = imageMime(real, data) ?? markdownMime(real, data) ?? playableMime(real, data);
    return mime ? { kind: "image", path: real, mime, bytes: data } : { kind: "refused", message: `${file} is not an image, markdown, audio or video` };
  } finally {
    await handle.close();
  }
}

const ascii = (bytes: Buffer, at: number, text: string) => bytes.subarray(at, at + text.length).toString("latin1") === text;

/** The image type the bytes are; SVG also needs its .svg name, since its bytes are only text. */
export function imageMime(file: string, bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (ascii(bytes, 0, "GIF87a") || ascii(bytes, 0, "GIF89a")) return "image/gif";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WEBP")) return "image/webp";
  if (ascii(bytes, 4, "ftypavif") || ascii(bytes, 4, "ftypavis")) return "image/avif";
  // BMP: "BM", then a DIB header of a size one of its versions has.
  if (ascii(bytes, 0, "BM") && bytes.length >= 26 && [12, 40, 52, 56, 64, 108, 124].includes(bytes.readUInt32LE(14))) return "image/bmp";
  if (bytes.length >= 6 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0 && bytes[4]! > 0) return "image/x-icon";
  if (path.extname(file).toLowerCase() === ".svg") {
    const head = bytes.subarray(0, 4096).toString("utf8");
    if (!head.includes("\0") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  }
  return null;
}

/** Markdown: a .md, .mdx or .markdown real path (a link named notes.md to anything else is refused) whose bytes are UTF-8 text. */
export function markdownMime(file: string, bytes: Buffer): string | null {
  if (!/\.(md|mdx|markdown)$/i.test(file) || bytes.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  return "text/markdown";
}

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
/** Keys a tool's input or result names an image file under (a screenshot's path, a generated image's saved path). */
const IMAGE_KEYS = new Set(["path", "file_path", "filePath", "image_path", "imagePath", "saved_path", "savedPath", "saved_paths", "screenshot", "screenshot_path", "screenshotPath", "image", "images"]);

/**
 * The image files a journaled event shows as items (outside agents' media.read, outside-agents.md §4): a tool's
 * image under one of IMAGE_KEYS in its input or result, an image block's path. Never a path written in a message:
 * text anyone can write, so it proves nothing about what the chat holds.
 */
export function imageItemPaths(event: { readonly type: string; readonly payload?: unknown }): ReadonlyArray<string> {
  if (event.type !== "tool.started" && event.type !== "tool.done") return [];
  const found: Array<string> = [];
  const take = (value: unknown) => {
    if (typeof value === "string") {
      const s = value.trim();
      if (s && !s.includes("\n") && !/^(data|https?):/i.test(s) && IMAGE_FILE.test(s)) found.push(s);
    } else if (Array.isArray(value)) for (const v of value.slice(0, 50)) take(v);
  };
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const v of value.slice(0, 200)) walk(v, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    for (const [key, v] of Object.entries(record)) {
      if (IMAGE_KEYS.has(key)) take(v);
      // An image block (`{type: "image", path|url}`): the image a tool returned.
      if (record.type === "image" && (key === "url" || key === "source")) take(v);
      walk(v, depth + 1);
    }
  };
  const payload = event.payload as { input?: unknown; result?: unknown } | undefined;
  walk(event.type === "tool.started" ? payload?.input : payload?.result, 0);
  return [...new Set(found)];
}

const VIDEO_EXTENSIONS = new Set([".mp4", ".m4v", ".mov", ".webm", ".ogv"]);

/**
 * Audio or video the browser plays, by its bytes (T3 #21363, #24275): MP3, WAV, AIFF, Ogg, FLAC, and the
 * MP4 and WebM containers, which hold either, told apart by the file's name. Null for anything else.
 */
export function playableMime(file: string, bytes: Buffer): string | null {
  const video = VIDEO_EXTENSIONS.has(path.extname(file).toLowerCase());
  if (ascii(bytes, 0, "ID3") || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe6) === 0xe2)) return "audio/mpeg";
  if (ascii(bytes, 0, "RIFF") && ascii(bytes, 8, "WAVE")) return "audio/wav";
  if (ascii(bytes, 0, "FORM") && (ascii(bytes, 8, "AIFF") || ascii(bytes, 8, "AIFC"))) return "audio/aiff";
  if (ascii(bytes, 0, "fLaC")) return "audio/flac";
  if (ascii(bytes, 0, "OggS")) return video ? "video/ogg" : "audio/ogg";
  if (bytes.length >= 4 && bytes.readUInt32BE(0) === 0x1a45dfa3) return video ? "video/webm" : "audio/webm";
  if (ascii(bytes, 4, "ftyp")) {
    const brand = bytes.subarray(8, 12).toString("latin1");
    if (brand === "qt  ") return "video/quicktime";
    return brand.startsWith("M4A") || brand.startsWith("M4B") || !video ? "audio/mp4" : "video/mp4";
  }
  return null;
}
