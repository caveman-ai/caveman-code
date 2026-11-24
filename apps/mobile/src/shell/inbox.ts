// A chat's place in the inbox, as the desktop keeps it on the runtime (Workspace.inbox and `unread`; apps/web
// src/state/inbox-state.ts, .ts): read or unread, done, snoozed, renamed, and when it last
// moved. The board has none of these, so the prototype keeps them on the phone, in its store beside the board; a connected
// client reads them from the thread projection and sends the same actions (`inbox`, `workspace.rename`).
//
// The rules are the desktop's: a chat is unread when it finished or asks something since you last had it open; done
// and snoozed chats leave the queue's live sections for their shelves; a snooze lets go when the chat raises its hand
// (it asks something, or its turn ends after you snoozed it), and a done chat comes back when something new happens.
// Archive holds a chat out of every list while Undo can still bring it back; then the board lets it go.
//
// The marks live in the app's store and on disk (store/inbox.ts), so they outlive the screen and a relaunch; this hook
// reads them with the desktop's rules, the same shape as before.
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Chat, Phase } from "../board/model";
import { phaseOf } from "../store/select";
import { isDoneIn } from "../store/inbox";
import { dispatch, store, useStore } from "../store/store";

/** The queue's sections, top to bottom (inbox-state.ts queueSections). */
/** `seen`: ready, and already looked at (opened, or Mark all seen); it folds at the foot of Ready until it ships. */
export type QueueSection = "pinned" | "needs" | "working" | "finished" | "seen" | "snoozed" | "done";

// A merged chat is on the Done shelf unless you said it is not done; then it is finished, as any other turn that ended.
const STAGE: Record<Phase, QueueSection> = { needs: "needs", working: "working", ready: "finished", done: "finished" };

/** Now, moved on each minute (and at the next snooze to wake), so ages and shelves stay current on an idle screen. */
function useNow(wakes: readonly number[]): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  // The next wake still ahead of the screen's clock: one it has passed is done, and would hold back every later one.
  const wake = wakes.reduce<number | null>((next, at) => (at > now && (next === null || at < next) ? at : next), null);
  useEffect(() => {
    if (wake === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, wake - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [wake]);
  return now;
}

const actions = {
  rename: (id: string, title: string) => dispatch({ type: "inbox/rename", id, title }),
  archive: (id: string) => dispatch({ type: "inbox/archive", id }),
  restore: (id: string) => dispatch({ type: "inbox/restore", id }),
  snooze: (ch: Chat, until: number) => dispatch({ type: "inbox/snooze", id: ch.id, phase: ch.phase, until }),
  wake: (id: string) => dispatch({ type: "inbox/wake", id }),
  // Done is settled: it is read too, no longer snoozed or pinned; a chat that asks something stays as it was (store/inbox.ts).
  markDone: (ch: Chat) => dispatch({ type: "inbox/done", id: ch.id, phase: ch.phase }),
  // Not done holds it off the Done shelf, merged or not, until it moves on.
  reopen: (id: string) => {
    const ch = store.get().board.chats.find((c) => c.id === id);
    if (ch) dispatch({ type: "inbox/reopen", id, phase: ch.phase });
  },
  markUnread: (id: string) => dispatch({ type: "inbox/unread", id }),
  markRead: (ch: Chat) => dispatch({ type: "inbox/read", id: ch.id, phase: ch.phase }),
};

/** `open`: the chat on screen, which counts as read while it shows. */
export function useInbox(chats: readonly Chat[], open: string | null) {
  const state = useStore((s) => s.inbox);

  // The open chat is read as it changes. (When each chat last moved is kept by the store itself: store/inbox.ts.) What
  // is seen is its status as every row shows it, its subagents' included (store/select.ts phaseOf): a parent whose
  // subagent asks something needs you, and reads unread until you open it.
  const seeing = open ? chats.find((ch) => ch.id === open) : undefined;
  const seeingPhase = seeing ? phaseOf(seeing) : null;
  useEffect(() => {
    if (seeing && seeingPhase && (state.seen[seeing.id] !== seeingPhase || state.unread[seeing.id])) dispatch({ type: "inbox/read", id: seeing.id, phase: seeingPhase });
  }, [seeing, seeingPhase, state.seen, state.unread]);

  const wakes = useMemo(() => Object.values(state.snoozed).map((s) => s.until), [state.snoozed]);
  const now = useNow(wakes);

  const unread = useCallback(
    (ch: Chat) => {
      if (ch.id === open) return false;
      if (state.unread[ch.id]) return true;
      const phase = phaseOf(ch);
      return (phase === "needs" || phase === "ready") && state.seen[ch.id] !== phase;
    },
    [open, state],
  );

  /** Still snoozed: before its wake time, and no hand raised since (it asks, or its turn ended after the snooze). */
  const snoozedUntil = useCallback(
    (ch: Chat): number | null => {
      const s = state.snoozed[ch.id];
      if (!s || s.until <= now || ch.phase === "needs" || ch.phase !== s.phase) return null;
      return s.until;
    },
    [state.snoozed, now],
  );

  /** Done: as you last said while nothing new happened since, else merged and not pinned (store/inbox.ts isDoneIn). */
  const isDone = useCallback((ch: Chat) => isDoneIn(state, ch), [state]);

  const section = useCallback(
    (ch: Chat): QueueSection => {
      if (snoozedUntil(ch) !== null) return "snoozed";
      if (isDone(ch)) return "done";
      if (ch.pinned) return "pinned";
      if (ch.phase === "ready" && ch.id !== open && !state.unread[ch.id] && state.seen[ch.id] === "ready") return "seen";
      return STAGE[ch.phase];
    },
    [snoozedUntil, isDone, open, state.unread, state.seen],
  );

  /** Archived, while Undo can still bring it back. Stable between archives, so a list filtered on it is too. */
  const archived = useCallback((id: string) => !!state.archived[id], [state.archived]);

  return {
    now,
    title: (ch: Chat) => state.titles[ch.id] ?? ch.title,
    archived,
    unread,
    since: (ch: Chat) => state.since[ch.id] ?? ch.updatedAt ?? ch.startedAt,
    snoozedUntil,
    isDone,
    section,
    ...actions,
  };
}

export type Inbox = ReturnType<typeof useInbox>;

/** How long ago, as a row says it: "now", "4m", "3h", "2d" (model.ts rowAge). */
export function rowAge(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** How long until it wakes: "40m", "3h", "2d" (inbox-state.ts wakeLabel). */
export function wakeLabel(until: number, now: number): string {
  const left = until - now;
  if (!(left > 0)) return "now";
  if (left < 3_600_000) return `${Math.max(1, Math.ceil(left / 60_000))}m`;
  if (left < 86_400_000) return `${Math.ceil(left / 3_600_000)}h`;
  return `${Math.ceil(left / 86_400_000)}d`;
}

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const atHour = (base: Date, hour: number) => {
  const d = new Date(base);
  d.setHours(hour, 0, 0, 0);
  return d;
};
// By calendar day, not a fixed 24 hours: that lands on the wrong local day across a DST change.
const addDays = (base: Date, days: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
};

/** In 1 hour, in 3 hours, this evening (while it is more than an hour off), tomorrow 9:00, next Monday 9:00 (inbox-state.ts snoozePresets). */
export function snoozePresets(now: Date): readonly { label: string; when: string; until: number }[] {
  const preset = (label: string, at: Date, when = clock(at)) => ({ label, when, until: at.getTime() });
  const hour = 3_600_000;
  const out = [preset("In 1 hour", new Date(now.getTime() + hour)), preset("In 3 hours", new Date(now.getTime() + 3 * hour))];
  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > hour) out.push(preset("This evening", evening));
  const tomorrow = atHour(addDays(now, 1), 9);
  out.push(preset("Tomorrow", tomorrow));
  const monday = atHour(addDays(now, (1 - now.getDay() + 7) % 7 || 7), 9);
  if (monday.getTime() !== tomorrow.getTime()) out.push(preset("Next week", monday, `${monday.toLocaleDateString(undefined, { weekday: "short" })} ${clock(monday)}`));
  return out;
}
