// What the Chief passes up to you, as cards (docs/, "The Chief"): what its chats ask first
// (approvals and questions alike, each a summary card, src/asks), the longest-waiting first, then changes ready to try.
// A card is about one of the Chief's chats, the row you know; when the ask comes from one of its subagents, the card
// still names the parent and answers the subagent, so a subagent never shows on the Chief's screen as a chat of its
// own (store/select.ts phaseOf: its ask lights the parent).
import type { Chat, Need } from "../board/model";
import type { Reply } from "../board/script";
import type { InboxState } from "../store/inbox";
import { askerOf as anyAskerOf, needOf, type Row } from "../store/select";
import type { Pendings } from "./decide";

export interface Card {
  kind: "ask" | "ready";
  /** The chat the answer goes to: the one asking, or the one that's ready. */
  chat: Chat;
  /** The Chief's chat it shows under: the same chat, or the parent of the subagent that asks. */
  row: Chat;
  /** An ask's card: what it waits on, approval or question, with what it did so far. */
  need?: Need;
  /** The answer picked on the card (an option, your words), when it is more than a yes or a no. */
  reply?: Reply;
}

export const cardKey = (card: Card) =>
  `${card.kind}:${card.chat.id}:${card.kind === "ready" ? card.chat.moment?.headline : (card.need?.at ?? card.chat.ask)}`;

/**
 * The chat in a family that waits on an approval: the chat itself, else the first of its subagents (deepest first).
 * Only approvals (a sheet's row and a peek offer Deny | Allow); the deck takes questions too (deckOf).
 */
export function askerOf(chat: Chat, chats: readonly Chat[], depth = 0): Chat | null {
  if (chat.phase === "needs" && chat.ask) return chat;
  if (depth > 6) return null;
  for (const child of chats.filter((c) => c.parent === chat.id)) {
    const found = askerOf(child, chats, depth + 1);
    if (found) return found;
  }
  return null;
}

/**
 * Put off with Later and not back yet: before its wake time, and no hand raised since (shell/inbox.ts snoozedUntil, the
 * desktop's rule: it asks something, or its turn ends after the snooze).
 */
export function isSnoozed(inbox: InboxState, chat: Chat, now = Date.now()): boolean {
  const s = inbox.snoozed[chat.id];
  return !!s && s.until > now && chat.phase !== "needs" && chat.phase === s.phase;
}

/**
 * The deck, top first: every approval in the Chief's chats, then every change ready to try that isn't put off. A card
 * whose answer waits behind Undo is out of it until the Undo goes, either way.
 */
export function deckOf(
  rows: readonly Row[],
  chats: readonly Chat[],
  inbox: InboxState,
  pending: Pendings,
): Card[] {
  const asks: Card[] = [];
  const ready: Card[] = [];
  for (const r of rows) {
    if (r.phase === "needs") {
      const asker = anyAskerOf(r.chat, chats);
      const need = needOf(asker);
      if (need && !pending[asker.id]) asks.push({ kind: "ask", chat: asker, row: r.chat, need });
    } else if (
      r.chat.phase === "ready" &&
      r.chat.moment &&
      !pending[r.chat.id] &&
      !isSnoozed(inbox, r.chat)
    ) {
      ready.push({ kind: "ready", chat: r.chat, row: r.chat });
    }
  }
  // The one order for asks: the longest-waiting first, so answering one never moves the rest.
  asks.sort((a, b) => (a.need?.at ?? 0) - (b.need?.at ?? 0));
  return [...asks, ...ready];
}

/**
 * Who asks, as the dock's line names it: the chat you know, then which of its agents, in its own short name ("Audit
 * the phone app › the composer" for the subagent "Audit: the composer").
 */
export function askedBy(card: Card): string {
  if (card.chat.id === card.row.id) return card.row.title;
  const own = card.chat.title.replace(/^[^:]{1,24}:\s+/, "");
  return `${card.row.title} › ${own}`;
}

/** The card a chat would make, for answering it from a peek or a row the same way as from the deck. */
export function cardFor(chat: Chat, chats: readonly Chat[]): Card | null {
  const asker = askerOf(chat, chats);
  if (asker) return { kind: "ask", chat: asker, row: chat, need: needOf(asker) ?? undefined };
  if (chat.phase === "ready") return { kind: "ready", chat, row: chat };
  return null;
}
