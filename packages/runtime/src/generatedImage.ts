// Native image bytes belong in the runtime's attachment store, never the event
// log or Session Protocol journal. media.read serves the resulting file through
// its existing authenticated, image-only route.
import * as fs from "node:fs/promises";

import { createAttachmentId, resolveAttachmentPath } from "./attachmentStore.ts";
import { imageMime, MAX_IMAGE_BYTES } from "./session-protocol/mediaRead.ts";

/** A reference must fit whole: truncating a filename points at a different file. */
export function isBoundedImagePath(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 4_096 &&
    Buffer.byteLength(value, "utf8") <= 4_096 && !value.includes("\0") && !/^[\\/]{2}/.test(value.trim());
}

const rasterExtensions: Readonly<Record<string, string>> = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "image/gif": ".gif",
};

/** Validates before decoding/writing; the filename is minted, not a provider item id. */
export async function storeGeneratedImage(attachmentsDir: string, threadId: string, data: string): Promise<string> {
  if (data.length > 4 * Math.ceil(MAX_IMAGE_BYTES / 3)) throw new Error("Generated image is over 16 MB.");
  const bytes = Buffer.from(data, "base64");
  if (bytes.length > MAX_IMAGE_BYTES) throw new Error("Generated image is over 16 MB.");
  if (bytes.length === 0 || bytes.toString("base64") !== data) throw new Error("Generated image has invalid base64 data.");
  // The same byte signature check media.read uses, but raster formats only: no SVG/text.
  const mimeType = imageMime("", bytes);
  const extension = mimeType === null ? undefined : rasterExtensions[mimeType];
  if (extension === undefined) throw new Error("Generated image is not a supported raster image.");
  const id = createAttachmentId(threadId, extension);
  if (id === null) throw new Error("Generated image cannot be stored for this chat.");
  const file = resolveAttachmentPath({ attachmentsDir, attachment: { type: "image", id, name: `generated${extension}`, mimeType: mimeType!, sizeBytes: bytes.length } });
  if (file === null || !isBoundedImagePath(file)) throw new Error("Generated image has no valid storage path.");
  await fs.mkdir(attachmentsDir, { recursive: true });
  // Acquire ownership before writing: a short/failed write may leave a partial
  // file, but an exclusive-open failure must never unlink somebody else's file.
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await fs.writeFile(handle, bytes);
    await handle.close();
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await fs.rm(file, { force: true });
    throw cause;
  }
  return file;
}
