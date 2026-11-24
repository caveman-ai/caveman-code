// The image viewer's way out of the app (apps/web/src/components/gallery):
// open a picture in the system's viewer (Preview on macOS), or hand it to the
// share menu. A blob: tab is refused here (main.ts setWindowOpenHandler), so
// the page sends PNG bytes instead. They are decoded and encoded again as PNG
// before they touch the disk, under a name of ours: a page can never write a
// file of its choosing and have the shell open it.
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { app, BrowserWindow, nativeImage, ShareMenu, shell, type IpcMainInvokeEvent } from "electron";

/** A full-page capture as PNG is a few MB; this only stops a runaway page. */
export const MAX_PICTURE_BYTES = 64 << 20;
/** Pixels decoded here at most (a 1440 x 20000 page fits): a small PNG may claim gigabytes, and this is the main process. */
export const MAX_PICTURE_PIXELS = 40_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A PNG's size from its header, before anything decodes it; null when the bytes are not a PNG. */
export function pngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** The page's name as a safe file stem: no folders, no extension, no odd characters. */
export function pictureStem(name: unknown): string {
  const base = typeof name === "string" ? (name.split(/[\\/]/).pop() ?? "") : "";
  const stem = base
    .replace(/\.[a-z\d]{1,10}$/i, "")
    .replace(/[^\w .()-]+/g, "_")
    .replace(/^[.\s]+/, "")
    .slice(0, 80)
    .trim();
  return stem || "image";
}

function bytesOf(value: unknown): Buffer | null {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** The picture as a PNG in its own folder under the app's temp dir; an error when the bytes are not an image. */
function writePicture(name: unknown, png: unknown): { file: string } | { error: string } {
  const bytes = bytesOf(png);
  if (!bytes || bytes.length === 0 || bytes.length > MAX_PICTURE_BYTES) return { error: "That isn't an image the app can open." };
  const size = pngSize(bytes);
  if (!size || size.width === 0 || size.height === 0) return { error: "That isn't an image the app can open." };
  if (size.width * size.height > MAX_PICTURE_PIXELS) return { error: "That image is too large to open from here; download it instead." };
  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return { error: "That isn't an image the app can open." };
  // A folder per picture keeps the person's file name (Preview's title) without two clashing.
  const dir = join(app.getPath("temp"), "caveman-code-images", randomUUID());
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${pictureStem(name)}.png`);
  writeFileSync(file, image.toPNG());
  return { file };
}

/** Opens the picture in the system's image viewer. Resolves to an error message, or null. */
export async function openPicture(name: unknown, png: unknown): Promise<string | null> {
  const written = writePicture(name, png);
  if ("error" in written) return written.error;
  const failed = await shell.openPath(written.file);
  return failed || null;
}

/** The most a web image read may bring back: the whole body crosses IPC, and this is the main process. */
export const MAX_READ_BYTES = 256 << 20;

export interface MediaRead {
  readonly status: number;
  readonly mimeType: string;
  readonly data: Uint8Array;
}

/**
 * A web image's bytes, for Copy, Share and Save on an image the page shows but cannot fetch(): the app's origin gets
 * no CORS answer from most hosts, and its CSP keeps plain http: to localhost. Like an <img>, it sends the session's
 * cookies. http(s) only; a body past MAX_READ_BYTES answers 413, a network failure null. Main reads it only for the
 * app's own pages (main.ts). , ipc/methods/window.ts (MIT).
 */
export async function readWebMedia(url: unknown, fetch: (url: string, init: RequestInit) => Promise<Response>): Promise<MediaRead | null> {
  if (typeof url !== "string" || !/^https?:$/.test(URL.parse(url)?.protocol ?? "")) return null;
  try {
    const response = await fetch(url, { credentials: "include" });
    const mimeType = response.headers.get("content-type") ?? "";
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return { status: response.status, mimeType, data: new Uint8Array() };
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      // Leaving the loop cancels the rest of the body.
      if (size > MAX_READ_BYTES) return { status: 413, mimeType, data: new Uint8Array() };
      chunks.push(chunk);
    }
    return { status: response.status, mimeType, data: Buffer.concat(chunks) };
  } catch {
    return null;
  }
}

/** The macOS share menu at the pointer, for the window that asked. Resolves to an error message, or null. */
export function sharePicture(event: IpcMainInvokeEvent, name: unknown, png: unknown): string | null {
  if (process.platform !== "darwin") return "Sharing needs macOS.";
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return "No window to share from.";
  const written = writePicture(name, png);
  if ("error" in written) return written.error;
  new ShareMenu({ filePaths: [written.file] }).popup({ window: win });
  return null;
}
