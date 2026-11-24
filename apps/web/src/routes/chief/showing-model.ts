// What a piece of work shows of itself, under the Chief's message that names it and on its board row: its chats'
// screenshots (ChiefItem.proof, a walkthrough when there are several) and an Open preview chip for each chat that
// registered one (Workspace.preview). Pure, so the message, the row and the card read one model.
import type { ChiefItem } from "@caveman-app/session-protocol";
import type { WorkspaceView } from "../../state/model.ts";
import type { Artifact } from "../../state/transcript-model.ts";
import { CHAT_REF, itemByRef, WORK_REF_PATTERN } from "./work-model.ts";

export type ProofImage = Extract<Artifact, { kind: "image" }>;

/**
 * The item's screenshots as the image strip and viewer take them: in order, chat by chat, each captioned. Read from
 * the stored copy (its `path`, with the Chief's workspace for media.read). `upTo`: only those kept by then, so a
 * message shows what its words were about, never screenshots that came later.
 */
export function proofImages(
  item: Pick<ChiefItem, "id" | "proof">,
  upTo?: string,
  workspaceId?: string,
): ReadonlyArray<ProofImage> {
  return (item.proof ?? [])
    .filter(
      (p) =>
        (upTo === undefined || p.at <= upTo) &&
        (workspaceId === undefined || p.workspace_id === workspaceId),
    )
    .flatMap((p) =>
      p.images.map((image, i, all) => ({
        id: `proof:${image.id}`,
        itemId: `proof:${item.id}`,
        title: image.caption || image.name,
        meta: all.length > 1 ? `${i + 1} of ${all.length}` : "",
        kind: "image" as const,
        src: image.path,
        alt: image.caption,
        line: null,
      })),
    );
}

/** The item's chats that registered a preview and still have a checkout: each gets an Open preview chip. */
export function previewChats(
  item: Pick<ChiefItem, "workspace_ids">,
  workspaces: ReadonlyArray<WorkspaceView>,
): ReadonlyArray<WorkspaceView> {
  return item.workspace_ids.flatMap((id) => {
    const chat = workspaces.find((w) => w.id === id);
    return chat?.preview && chat.state !== "archived" ? [chat] : [];
  });
}

/**
 * The work a Chief message names that has something to show, in the order it names it: a piece of work ([[12]]) with
 * all its chats' screenshots kept by the time the message was written and their Open preview chips, or one chat of it
 * ([[chat:<id>]]) with only its own. Each screenshot and chip shows once, under the first name that brings it. A chat
 * whose result card is in the conversation (`carded`) shows them on that card, never again under a message.
 */
export function shownIn(
  text: string,
  at: string,
  items: ReadonlyArray<ChiefItem>,
  workspaces: ReadonlyArray<WorkspaceView>,
  carded: ReadonlySet<string> = new Set(),
): ReadonlyArray<{
  readonly key: string;
  readonly item: ChiefItem;
  readonly images: ReadonlyArray<ProofImage>;
  readonly previews: ReadonlyArray<WorkspaceView>;
}> {
  const seenImages = new Set<string>();
  const seenChats = new Set<string>();
  const out: Array<{
    key: string;
    item: ChiefItem;
    images: ReadonlyArray<ProofImage>;
    previews: ReadonlyArray<WorkspaceView>;
  }> = [];
  for (const [ref] of text.matchAll(new RegExp(WORK_REF_PATTERN.source, "g"))) {
    // A chat ref resolves through the board, not the chat list: its screenshots stay on the item after the chat goes.
    const chatId = CHAT_REF.exec(ref)?.[1];
    const item = chatId
      ? items.find((i) => i.workspace_ids.includes(chatId))
      : itemByRef(ref, items);
    if (!item) continue;
    const uncarded = {
      id: item.id,
      proof: (item.proof ?? []).filter((p) => !carded.has(p.workspace_id)),
    };
    const images = proofImages(uncarded, at, chatId).filter((image) => !seenImages.has(image.id));
    const previews = (
      chatId
        ? previewChats({ workspace_ids: [chatId] }, workspaces)
        : previewChats(item, workspaces)
    ).filter((c) => !seenChats.has(c.id) && !carded.has(c.id));
    for (const image of images) seenImages.add(image.id);
    for (const c of previews) seenChats.add(c.id);
    if (images.length > 0 || previews.length > 0)
      out.push({ key: chatId ?? item.id, item, images, previews });
  }
  return out;
}
