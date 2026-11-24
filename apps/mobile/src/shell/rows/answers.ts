// An answer given from a list row (the Needs you list's Deny and Allow, a Ready row's Ship it), held behind Undo before
// it lands: the approval dock's grammar (thread/AskDock.tsx) and the Chief's (chief/decide.ts). The row keeps its place
// and says what it is doing ("Allowing vercel deploy --prod", "Shipping") with Undo where Allow or the age was for
// DOCK_UNDO_MS, then folds away over FOLD_MS, and only then does the answer reach the chat. It is held here, not in the row, so it still lands when the list is left or the row is
// recycled. Here too is when the list last moved under the thumb: a row's Allow ignores taps for ARM_MS after that, so
// a second tap meant for one ask never answers the next one sliding up into its place.
import { useSyncExternalStore } from "react";
import * as script from "../../board/script";
import { store } from "../../store/store";
import { ARM_MS, DOCK_UNDO_MS } from "../../thread/AskDock";

/** How long a resolved row takes to fold away once its Undo has passed. */
export const FOLD_MS = 240;
/** A landed answer is remembered this long, so a row the list still shows (held under a finger) stays folded. */
const FORGET_MS = 6000;

export interface Answer {
  /** The chat that asks (a subagent's ask lights its parent's row; this is the asker), or the chat being shipped. */
  id: string;
  /** An ask's Allow or Deny, or a Ready chat's Ship it (always a yes; its Later is a snooze, which needs no hold). */
  kind: "ask" | "ship";
  yes: boolean;
  /** What Allow lets run; for a ship, the chat's title. */
  command: string;
  /** When it was given. */
  at: number;
  /** It reached the chat: the row stays folded until the list lets it go. */
  landed: boolean;
}

const answers = new Map<string, Answer & { timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** What a ship says to the chat: the Chief's Ship it sends the same words (chief/decide.ts). */
const SHIP_WORDS = "Looks great, ship it";

/** Gives the answer: it lands after Undo's window and the fold, unless Undo comes first. */
export function answer(id: string, yes: boolean, command: string) {
  give(id, "ask", yes, command);
}

/** Ships a Ready chat from its row (its swipe right, its menu's first entry): the same hold, Undo and fold as Allow. */
export function ship(id: string, title: string) {
  give(id, "ship", true, title);
}

function give(id: string, kind: Answer["kind"], yes: boolean, command: string) {
  const was = answers.get(id);
  if (was && !was.landed) return;
  if (was) clearTimeout(was.timer);
  const at = Date.now();
  // The fold starts when Undo's window ends: everything under the row starts to move then.
  const fold = setTimeout(moved, DOCK_UNDO_MS);
  const timer = setTimeout(() => {
    clearTimeout(fold);
    land(id);
  }, DOCK_UNDO_MS + FOLD_MS);
  answers.set(id, { id, kind, yes, command, at, landed: false, timer });
  changed();
}

function land(id: string) {
  const a = answers.get(id);
  if (!a || a.landed) return;
  // Only if it still asks the same thing (or is still ready to ship): an answer given in the chat meanwhile wins.
  const chat = store.get().board.chats.find((ch) => ch.id === id);
  if (a.kind === "ship") {
    if (chat && chat.phase === "ready") script.send(id, SHIP_WORDS);
  } else if (chat && chat.phase === "needs" && (chat.ask ?? "") === a.command) {
    if (a.yes) script.allow(id);
    else script.deny(id);
  }
  moved();
  answers.set(id, { ...a, landed: true, timer: setTimeout(() => (answers.delete(id), changed()), FORGET_MS) });
  changed();
}

/** Takes the answer back while Undo still shows: the ask returns as it was. */
export function undoAnswer(id: string) {
  const a = answers.get(id);
  if (!a || a.landed) return;
  clearTimeout(a.timer);
  answers.delete(id);
  moved();
  changed();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The answer given for this asker, while it is held, folding, or just landed. */
export function useAnswer(id: string | null | undefined): Answer | undefined {
  return useSyncExternalStore(subscribe, () => (id ? answers.get(id) : undefined));
}

// ---------------------------------------------------------------- arming

let movedAt = 0;

/** The list reflowed, or a row grew, shrank or went: what sits under the thumb may be another row now. */
export function moved() {
  movedAt = Date.now();
}

/** Whether a tap on an answer is meant: not within ARM_MS of `since` (the control appearing) or of the list moving. */
export const armed = (since: number) => Date.now() - Math.max(since, movedAt) >= ARM_MS;
