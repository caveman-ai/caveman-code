// A note's images. They live where every chat's attachments live (the runtime's attachment store,
// session-protocol/attachments.ts), under the Chief's own thread; the board keeps only references
// (ChiefAttachment). The Chief's turn reads the files as they are; a chat the Chief hands them to
// gets its own copy, as every chat owns the attachments of its turns. Never anything but an image,
// never executed: a file the engines open by path is a chat's to take, not a note's.
import * as fs from "node:fs";

import { ChatAttachment, isProviderSendTurnSupportedImageMimeType } from "@caveman-app/protocol";
import type { ChiefAttachment, TurnInput } from "@caveman-app/session-protocol";
import * as Schema from "effect/Schema";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { storeTurnAttachments } from "../session-protocol/attachments.ts";

export type WireAttachment = NonNullable<TurnInput["attachments"]>[number];

const decodeChatAttachment = Schema.decodeUnknownSync(ChatAttachment);

export const IMAGES_ONLY = "The Chief takes images only; attach files in a chat.";

/** What a note's images became in the store: their references for the board, and their files (to remove if the note is refused). */
export interface StoredImages {
  readonly refs: ReadonlyArray<ChiefAttachment>;
  readonly paths: ReadonlyArray<string>;
}

/** Writes a note's images under `threadId` (the Chief's). Throws, before writing, on anything that is not an image a model takes as one. */
export function storeNoteImages(attachmentsDir: string, threadId: string, sent: ReadonlyArray<WireAttachment>): StoredImages {
  if (sent.length === 0) return { refs: [], paths: [] };
  if (sent.some((a) => a.type !== "image" || !isProviderSendTurnSupportedImageMimeType(a.mime_type.trim().toLowerCase()))) throw new Error(IMAGES_ONLY);
  const stored = storeTurnAttachments(attachmentsDir, threadId, sent);
  return { refs: stored.attachments.map(toRef), paths: stored.paths };
}

export const toRef = (a: ChatAttachment): ChiefAttachment => ({ id: a.id, name: a.name, mime_type: a.mimeType, size_bytes: a.sizeBytes });

/** A reference as the dispatcher takes it: the Chief's own turn reads the stored file, no copy. */
export const toStored = (a: ChiefAttachment): ChatAttachment => decodeChatAttachment({ type: "image", id: a.id, name: a.name, mimeType: a.mime_type, sizeBytes: a.size_bytes });

/** The images inline (base64), as turn.submit takes them: a chat the Chief hands them to stores its own copy. Throws when a file is gone. */
export function inlineImages(attachmentsDir: string, refs: ReadonlyArray<ChiefAttachment>): WireAttachment[] {
  return refs.map((ref) => {
    const file = resolveAttachmentPath({ attachmentsDir, attachment: toStored(ref) });
    if (file === null || !fs.existsSync(file)) throw new Error(`Image ${ref.id} is no longer in the store.`);
    return { type: "image", name: ref.name, mime_type: ref.mime_type, data: fs.readFileSync(file).toString("base64") };
  });
}
