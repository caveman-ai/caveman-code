// turn.submit's attachments arrive inline (base64) on the Session Protocol. upstream engines read them from the
// runtime's attachment store: each becomes a file under the thread's own attachment id in attachmentsDir,
// which the adapters send on (an image as image content, a file by its path, as T3 does).
import * as fs from "node:fs";
import * as path from "node:path";

import { ChatAttachment, getProviderAttachmentLimitError, isProviderSendTurnSupportedImageMimeType } from "@caveman-app/protocol";
import type { TurnInput } from "@caveman-app/session-protocol";
import { isSvgAttachment } from "@caveman-app/shared/image";
import * as Schema from "effect/Schema";

import { attachmentFileExtension, createAttachmentId, parseThreadSegmentFromAttachmentId, resolveAttachmentPath, resolveAttachmentPathById, toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import { inferImageExtension } from "../imageMime.ts";
import { readImageFile, type ImageRead } from "./mediaRead.ts";

type WireAttachment = NonNullable<TurnInput["attachments"]>[number];

const decodeChatAttachment = Schema.decodeUnknownExit(ChatAttachment);
const NAME_MAX = 255;

/** What was written: the attachments to dispatch, and their files (removed again if the turn is refused). */
export interface StoredAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly paths: ReadonlyArray<string>;
}

/**
 * Writes each attachment into `attachmentsDir` under a new id of `threadId`'s. Throws an Error whose message
 * says what is wrong (too many, too large, an image that is not one, an empty file) before writing anything.
 */
export function storeTurnAttachments(attachmentsDir: string, threadId: string, attachments: ReadonlyArray<WireAttachment>): StoredAttachments {
  if (attachments.length === 0) return { attachments: [], paths: [] };
  const planned = attachments.map((sent) => {
    const bytes = Buffer.from(sent.data, "base64");
    const given = (sent.name.trim() || (sent.type === "image" ? "image" : "file")).slice(0, NAME_MAX);
    const mimeType = (sent.mime_type.trim() || "application/octet-stream").toLowerCase();
    // A pasted SVG often has no extension ("Pasted image"): it keeps one, so the agent opening it knows what it reads (T3 #21355).
    const name = isSvgAttachment({ name: given, mimeType }) && !/\.svg$/i.test(given) ? `${given.slice(0, NAME_MAX - 4)}.svg` : given;
    if (sent.type === "image" && !mimeType.startsWith("image/")) throw new Error(`${name} is sent as an image but is ${mimeType}.`);
    // An image no model takes as one (SVG, BMP, HEIC) goes as a file the agent opens by its path: sent as an
    // image, Claude Agent refuses the whole turn ("Unsupported Claude Agent image attachment type").
    const attachment = sent.type === "image" && !isProviderSendTurnSupportedImageMimeType(mimeType) ? { ...sent, type: "file" as const } : sent;
    if (attachment.type === "file" && bytes.length === 0) throw new Error(`${name} is empty.`);
    const extension = attachment.type === "image" ? inferImageExtension({ mimeType, fileName: name }) : attachmentFileExtension(name);
    const id = createAttachmentId(threadId, extension);
    if (id === null) throw new Error("This chat cannot take attachments.");
    const decoded = decodeChatAttachment({ type: attachment.type, id, name, mimeType, sizeBytes: bytes.length });
    if (decoded._tag === "Failure") throw new Error(`${name} cannot be attached (${attachment.type === "image" ? "an image" : "a file"} of ${bytes.length} bytes).`);
    const file = resolveAttachmentPath({ attachmentsDir, attachment: decoded.value });
    if (file === null) throw new Error(`${name} cannot be attached.`);
    return { attachment: decoded.value, bytes, file };
  });
  const limit = getProviderAttachmentLimitError(planned.map((p) => p.attachment));
  if (limit) throw new Error(limit);
  const paths: Array<string> = [];
  try {
    for (const { bytes, file } of planned) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, bytes, { flag: "wx" });
      paths.push(file);
    }
  } catch (error) {
    removeStoredAttachments(paths);
    throw error;
  }
  return { attachments: planned.map((p) => p.attachment), paths };
}

export function removeStoredAttachments(paths: ReadonlyArray<string>) {
  for (const file of paths) fs.rmSync(file, { force: true });
}

/** An attached image at most this large rides in the journal (message.done); a larger one carries its `id` for attachment.read. */
export const INLINE_IMAGE_MAX_BYTES = 1024 * 1024;

/** A stored image attachment's bytes, base64, when it is at most INLINE_IMAGE_MAX_BYTES; else undefined. */
export function inlineAttachmentData(attachmentsDir: string, value: unknown): string | undefined {
  const decoded = decodeChatAttachment(value);
  if (decoded._tag === "Failure" || decoded.value.type !== "image" || decoded.value.sizeBytes > INLINE_IMAGE_MAX_BYTES) return undefined;
  const file = resolveAttachmentPath({ attachmentsDir, attachment: decoded.value });
  if (file === null) return undefined;
  try {
    return fs.readFileSync(file).toString("base64");
  } catch {
    return undefined;
  }
}

/**
 * attachment.read: an image attached in this chat, or in a chat it was forked from (`threadIds`, the chat's own
 * first), from the store by its id. Another chat's id reads as missing, so an id never says whether it exists.
 */
export async function readChatImage(input: { readonly attachmentsDir: string; readonly attachmentId: string; readonly threadIds: ReadonlyArray<string> }): Promise<ImageRead> {
  const segment = parseThreadSegmentFromAttachmentId(input.attachmentId);
  if (segment === null || !input.threadIds.some((id) => toSafeThreadAttachmentSegment(id) === segment)) return { kind: "missing" };
  const file = resolveAttachmentPathById({ attachmentsDir: input.attachmentsDir, attachmentId: input.attachmentId });
  if (file === null) return { kind: "missing" };
  const read = await readImageFile(file);
  // Known by its bytes, as media.read knows one: a file attachment named .png is never served as a picture.
  return read.kind === "image" && !read.mime.startsWith("image/") ? { kind: "refused", message: "Not an image." } : read;
}
