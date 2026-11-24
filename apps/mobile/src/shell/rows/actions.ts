// What a row's swipes do, and what a group's head does to all its rows at once (DECISIONS.md "Gaps", Bulk triage).
// Swiping right ships a Ready chat (Ship it, held behind the row's own Undo as Allow is: answers.ts), settles a chat
// (Done, the desktop's Mark done) or brings it back; swiping left pins, snoozes or archives it. Each is reversible: a
// snooze and an archive say so in a notice with Undo (the row is gone, so nothing else could hold it), Done becomes
// Not done. A chat that asks you something can't be settled or snoozed (the runtime refuses, upstream canSnooze), and one
// at work can't be archived; those swipes aren't offered. A whole group's Mark all seen and Archive all keep their
// Undo where their button was, for BULK_UNDO_MS (useBulk), and no toast carries it.
import { useSyncExternalStore } from "react";
import type { Chat, Phase } from "../../board/model";
import * as script from "../../board/script";
import { dispatch } from "../../store/store";
import type { Colors } from "../../theme";
import { alpha } from "../../theme";
import { type Inbox, snoozePresets } from "../inbox";
import { archive, notice } from "../ui";
import { ship } from "./answers";
import type { SwipeAction } from "./SwipeRow";

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** Snoozes a chat for an hour, with Undo. */
export function snoozeHour(chat: Chat, inbox: Inbox) {
  const preset = snoozePresets(new Date())[0]!;
  inbox.snooze(chat, preset.until);
  notice({ id: `snooze-${chat.id}-${Date.now()}`, text: `Snoozed until ${clock(preset.until)}`, tone: "info", icon: "snooze", action: { label: "Undo", onPress: () => inbox.wake(chat.id) } });
}

export function rowActions(chat: Chat, phase: Phase, inbox: Inbox, c: Colors): { leading: SwipeAction[]; trailing: SwipeAction[] } {
  const done = inbox.isDone(chat);
  const snoozed = inbox.snoozedUntil(chat) !== null;
  // Ready leads with Ship it, so a long swipe right ships it, as the Chief's card does in one tap (Later | Ship it).
  const shipIt: SwipeAction[] =
    phase === "ready" && !done ? [{ key: "ship", label: "Ship it", icon: "merge", fill: c.primary, ink: c.onPrimary, onPress: () => ship(chat.id, inbox.title(chat)) }] : [];
  const leading: SwipeAction[] =
    phase === "needs"
      ? []
      : done
        ? [{ key: "reopen", label: "Not done", icon: "undo", fill: c.control, ink: c.text, onPress: () => inbox.reopen(chat.id) }]
        : [...shipIt, { key: "done", label: "Done", icon: "markDone", fill: alpha(c.success, 0.22), ink: c.success, onPress: () => inbox.markDone(chat) }];
  const trailing: SwipeAction[] = [
    { key: "pin", label: chat.pinned ? "Unpin" : "Pin", icon: chat.pinned ? "unpin" : "pin", fill: c.control, ink: c.text, onPress: () => script.pin(chat.id, !chat.pinned) },
    ...(phase === "needs"
      ? []
      : snoozed
        ? [{ key: "wake", label: "Wake", icon: "wake" as const, fill: c.raised, ink: c.text, onPress: () => inbox.wake(chat.id) }]
        : [{ key: "snooze", label: "Snooze", icon: "snooze" as const, fill: c.raised, ink: c.text, onPress: () => snoozeHour(chat, inbox) }]),
    ...(phase === "working" ? [] : [{ key: "archive", label: "Archive", icon: "archive" as const, fill: alpha(c.text, 0.16), ink: c.text, onPress: () => archive(chat.id) }]),
  ];
  return { leading, trailing };
}

// ---------------------------------------------------------------- a whole group at once

/** How long a whole group's Undo stays in reach, where its button was: an answer's 4 s (answers.ts). */
export const BULK_UNDO_MS = 4000;

/** A whole-group action behind its Undo. `where` is the slot that took it (a list's title line, a group's head). */
export interface Bulk {
  where: string;
  kind: "seen" | "archive";
  /** How many chats it moved. */
  count: number;
  at: number;
}

const bulks = new Map<string, Bulk & { undo: () => void; timer: ReturnType<typeof setTimeout> }>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** The action held in this slot while its Undo shows there, if any. */
export function useBulk(where: string | null | undefined): Bulk | undefined {
  return useSyncExternalStore(subscribe, () => (where ? bulks.get(where) : undefined));
}

function hold(bulk: Omit<Bulk, "at">, undo: () => void) {
  const was = bulks.get(bulk.where);
  if (was) clearTimeout(was.timer);
  const timer = setTimeout(() => drop(bulk.where), BULK_UNDO_MS);
  bulks.set(bulk.where, { ...bulk, at: Date.now(), undo, timer });
  changed();
}

function drop(where: string) {
  const was = bulks.get(where);
  if (!was) return;
  clearTimeout(was.timer);
  bulks.delete(where);
  changed();
}

/** Takes a whole-group action back while its Undo still shows. */
export function undoBulk(where: string) {
  const was = bulks.get(where);
  if (!was) return;
  drop(where);
  was.undo();
}

/**
 * Marks every chat seen: the Ready group's "Mark all seen". They leave every Ready count and fold under "Seen" at the
 * foot of Ready; Undo, where the button was for 4 s, marks them unseen again.
 */
export function markAllSeen(chats: readonly Chat[], inbox: Inbox, where: string) {
  const ids = chats.filter((ch) => inbox.unread(ch)).map((ch) => ch.id);
  if (!ids.length) return;
  for (const chat of chats) inbox.markRead(chat);
  hold({ where, kind: "seen", count: ids.length }, () => ids.forEach((id) => inbox.markUnread(id)));
}

let pendingAll: { ids: string[]; where: string; timer: ReturnType<typeof setTimeout> } | null = null;

function letAllGo() {
  const was = pendingAll;
  if (!was) return;
  pendingAll = null;
  clearTimeout(was.timer);
  drop(was.where);
  for (const id of was.ids) {
    script.archive(id);
    dispatch({ type: "inbox/restore", id });
  }
}

/** Archives a whole group behind one Undo (the Done group's "Archive all"); after the Undo window the board lets them go. */
export function archiveAll(chats: readonly Chat[], where: string) {
  const ids = chats.filter((ch) => ch.phase !== "working").map((ch) => ch.id);
  if (!ids.length) return;
  // One at a time: an earlier Archive all lets its chats go now, and its Undo goes with them.
  letAllGo();
  for (const id of ids) dispatch({ type: "inbox/archive", id });
  pendingAll = { ids, where, timer: setTimeout(letAllGo, BULK_UNDO_MS) };
  hold({ where, kind: "archive", count: ids.length }, () => {
    const was = pendingAll;
    if (!was || was.where !== where) return;
    clearTimeout(was.timer);
    pendingAll = null;
    for (const id of was.ids) dispatch({ type: "inbox/restore", id });
  });
}
