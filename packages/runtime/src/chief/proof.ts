// What a chat showed of its work, on its Chief's board (ChiefItem.proof). Every engine ends UI work with screenshots
// as Markdown images on absolute paths (<ui_proof>, engine-core runtimeInstructions.ts): its chat draws them as a strip
// under the answer. When a chat on a Chief's board finishes a turn whose answer has any, they are copied into the
// attachment store under the Chief's thread, as a note's images are (chief/attachments.ts): they outlive the temp
// folder they were saved in, the Chief's message and board show them as thumbnails, and the Chief hands them to
// another chat by id. In order, each with its caption (the alt text), so a run of them reads as a walkthrough.
// Images only, as models take them (PNG, JPEG, GIF, WebP), read as media.read reads them; never anything else.
import * as os from "node:os";
import * as path from "node:path";

import { isProviderSendTurnSupportedImageMimeType } from "@caveman-app/protocol";
import type { ChiefProof, ChiefProofImage } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import { removeStoredAttachments, storeTurnAttachments } from "../session-protocol/attachments.ts";
import { readImageFile, resolveImagePath } from "../session-protocol/mediaRead.ts";
import type { WorkspaceRecord } from "../session-protocol/store.ts";
import type { Item } from "./Board.ts";
import { toRef, toStored } from "./attachments.ts";
import type { BoardStore } from "./store.ts";

/** At most this many screenshots per chat: a walkthrough, not an album. */
export const PROOF_MAX = 6;
const CAPTION_MAX = 200;

/** `![caption](path)`, the path bare or in angle brackets (a path with spaces), an optional "title" after it. */
const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)(?:\s+"[^"\n]*")?\s*\)/g;

/** The local images an answer shows, in order, each once: absolute, `~/…`, `file://` or relative to the checkout. Never a web or data URL. */
export function proofImagesOf(
  text: string,
): ReadonlyArray<{ readonly caption: string; readonly src: string }> {
  const out: Array<{ caption: string; src: string }> = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(IMAGE)) {
    let src = match[2]!.replace(/^<(.*)>$/, "$1").trim();
    if (/^file:\/\//i.test(src)) {
      try {
        const url = new URL(src);
        if (url.host && url.host !== "localhost") continue;
        src = decodeURIComponent(url.pathname);
      } catch {
        continue;
      }
    } else if (/^[a-z][a-z\d+.-]*:/i.test(src) && !/^[a-z]:[\\/]/i.test(src)) continue;
    if (seen.has(src)) continue;
    seen.add(src);
    out.push({ caption: match[1]!.replace(/\s+/g, " ").trim().slice(0, CAPTION_MAX), src });
  }
  return out;
}

/**
 * The answer's screenshots, stored under the Chief's thread: undefined when it shows none that can be read as an
 * image a model takes. One that is gone, too large or not such an image is left out; the rest still go.
 */
export async function storeProof(input: {
  readonly attachmentsDir: string;
  /** The Chief's thread: the store keeps them under it. */
  readonly threadId: string;
  readonly workspaceId: string;
  readonly turnId: string | undefined;
  readonly answer: string;
  /** The chat's checkout, for a path relative to it. */
  readonly worktree: string | null;
  readonly at: string;
}): Promise<ChiefProof | undefined> {
  const images: Array<ChiefProofImage> = [];
  for (const { caption, src } of proofImagesOf(input.answer)) {
    if (images.length >= PROOF_MAX) break;
    const file = resolveImagePath(src, os.homedir(), input.worktree);
    if (file === null) continue;
    const read = await readImageFile(file);
    if (read.kind !== "image" || !isProviderSendTurnSupportedImageMimeType(read.mime)) continue;
    try {
      const stored = storeTurnAttachments(input.attachmentsDir, input.threadId, [
        {
          type: "image",
          name: path.basename(read.path),
          mime_type: read.mime,
          data: read.bytes.toString("base64"),
        },
      ]);
      const attachment = stored.attachments[0]!;
      const ref = toRef(attachment);
      const where = resolveAttachmentPath({
        attachmentsDir: input.attachmentsDir,
        attachment: toStored(ref),
      });
      if (where === null) continue;
      images.push({ ...ref, caption: caption || path.basename(read.path), path: where });
    } catch {
      // Over a provider's size for one image, or the store refused it: the rest still go.
    }
  }
  if (images.length === 0) return undefined;
  return {
    workspace_id: input.workspaceId,
    ...(input.turnId ? { turn_id: input.turnId } : {}),
    at: input.at,
    images,
  };
}

/** The item with this chat's latest proof in place of its earlier one; the files the earlier one held, to remove. */
export function withProof(
  item: Item,
  proof: ChiefProof,
): { readonly item: Item; readonly replaced: ReadonlyArray<string> } {
  const earlier = (item.proof ?? []).filter((p) => p.workspace_id === proof.workspace_id);
  const kept = (item.proof ?? []).filter((p) => p.workspace_id !== proof.workspace_id);
  return {
    item: { ...item, proof: [...kept, proof], updated_at: proof.at },
    replaced: earlier.flatMap((p) => p.images.map((i) => i.path)),
  };
}

/** The ids and captions a Chief reads for one chat (chat_update `proof=`), to pass them on. */
export const proofLine = (item: Pick<Item, "proof">, workspaceId: string) =>
  (item.proof ?? [])
    .filter((p) => p.workspace_id === workspaceId)
    .flatMap((p) => p.images)
    .map((i) => ({ id: i.id, caption: i.caption }));

/**
 * The watcher's hook (watch.ts): a chat on a Chief's board finished a turn with this answer. Its screenshots go onto
 * its item, once per turn (a replay at startup finds the turn already there).
 */
export const makeProofCapture =
  (deps: {
    readonly board: BoardStore;
    readonly attachmentsDir: string;
    /** The thread of the Chief whose board holds the item; undefined when it is gone. */
    readonly chiefThread: (item: Item) => Effect.Effect<string | undefined, unknown>;
  }) =>
  (record: WorkspaceRecord, itemId: string, turnId: string | undefined, answer: string) =>
    Effect.gen(function* () {
      if (proofImagesOf(answer).length === 0) return;
      const item = yield* deps.board.get(itemId);
      if (item === undefined) return;
      if (
        turnId !== undefined &&
        item.proof?.some((p) => p.workspace_id === record.workspace.id && p.turn_id === turnId)
      )
        return;
      const threadId = yield* deps.chiefThread(item);
      if (threadId === undefined) return;
      const proof = yield* Effect.promise(() =>
        storeProof({
          attachmentsDir: deps.attachmentsDir,
          threadId,
          workspaceId: record.workspace.id,
          turnId,
          answer,
          worktree: record.internal.worktreePath ?? null,
          at: new Date().toISOString(),
        }),
      );
      if (proof === undefined) return;
      const replaced = yield* deps.board.update("proof", (items) => {
        const current = items.find((i) => i.id === itemId);
        if (current === undefined)
          return Effect.succeed({ write: [], value: proof.images.map((i) => i.path) });
        const next = withProof(current, proof);
        return Effect.succeed({ write: [next.item], value: next.replaced });
      });
      removeStoredAttachments(replaced);
    });
