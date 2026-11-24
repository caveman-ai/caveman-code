// A chat's place in the inbox: done, snoozed, pinned (Workspace.inbox, kept on its T3 thread by the runtime).
// The rules are upstream client half (packages/client-runtime/src/state/threadSettled.ts @ 13aa882c22): when a
// snooze holds, when a chat may be snoozed, the snooze presets, and the change an action makes, applied at once
// so a row moves before the runtime answers.

import type { InboxAction, SnoozeOption, WorkspaceInbox } from "@caveman-app/session-protocol";
import { chatStage, chatStatus, leadsWithChildren, type ChatLife, type ChatStatus, type WorkspaceView } from "./model.ts";

const ms = (iso: string | null | undefined) => (iso ? Date.parse(iso) : Number.NaN);

/**
 * It raised its hand while snoozed, so the snooze no longer holds: it asks something, or failed after it was
 * snoozed (upstream threadRaisedHandWhileSnoozed). A finished turn does not: a snoozed chat that keeps waking itself
 * for background work stays hidden until its time. A chat's status change is what moves its updated_at.
 */
export function raisedHand(w: WorkspaceView): boolean {
  if (w.state === "needs_input" || w.activity?.ask) return true;
  const snoozedAt = ms(w.inbox?.snoozedAt);
  return w.state === "failed" && (Number.isNaN(snoozedAt) || ms(w.updatedAt) > snoozedAt);
}

/** Snoozed now: before its wake time and with no hand raised since (upstream effectiveSnoozed). */
export function isSnoozed(w: WorkspaceView, now = Date.now()): boolean {
  const wake = ms(w.inbox?.snoozedUntil);
  return !Number.isNaN(wake) && wake > now && !raisedHand(w);
}

/** Where a chat sits: snoozed and done chats leave the list for their shelves, pinned ones lead (upstream resolveSidebarThreadSection). */
export type InboxSection = "pinned" | "active" | "snoozed" | "done";

export function inboxSection(w: WorkspaceView, now = Date.now()): InboxSection {
  if (isSnoozed(w, now)) return "snoozed";
  if (w.inbox?.doneAt) return "done";
  if (w.inbox?.pinnedAt) return "pinned";
  return "active";
}

/**
 * Where a chat stands in the sidebar by topic, on the queue's shelves (queueSections): done once someone calls it done,
 * snoozed while it sleeps, and live otherwise (Pinned, Needs you, Working, Ready for review).
 */
export function chatLife(w: WorkspaceView, now = Date.now()): ChatLife {
  const section = inboxSection(w, now);
  return section === "snoozed" || section === "done" ? section : "live";
}

/** The pinned chats, in the order they were pinned (the folder view's Pinned section). */
export function pinnedChats(workspaces: ReadonlyArray<WorkspaceView>): WorkspaceView[] {
  return workspaces.filter((w) => w.state !== "archived" && w.inbox?.pinnedAt).sort(byPinned);
}

const byPinned = (a: WorkspaceView, b: WorkspaceView) => a.inbox!.pinnedAt!.localeCompare(b.inbox!.pinnedAt!);

export interface QueueSections {
  readonly pinned: ReadonlyArray<WorkspaceView>;
  /** Waits on the person: it asks, or its last turn failed and nobody has looked. */
  readonly needs: ReadonlyArray<WorkspaceView>;
  /** At work: its turn, its agents, or a message waiting to start. */
  readonly working: ReadonlyArray<WorkspaceView>;
  /** Its turn ended and nobody has called it done: whatever it left (an answer, work to land, a plan) is the person's. */
  readonly review: ReadonlyArray<WorkspaceView>;
  readonly snoozed: ReadonlyArray<WorkspaceView>;
  /** Called done: by the person, or by its agent or the Chief on their behalf. */
  readonly done: ReadonlyArray<WorkspaceView>;
}

const newest = (at: (w: WorkspaceView) => string) => (a: WorkspaceView, b: WorkspaceView) => at(b).localeCompare(at(a)) || a.id.localeCompare(b.id);

/**
 * The queue view. upstream sidebar partitions threads into pinned, the inbox, a Working shelf (its beta), snoozed and
 * settled (partitionSidebarThreads); the inbox here splits once more by stage (model.ts chatStage), so a chat reads
 * as waiting on you, at work or ready for review from the section it sits in, not from a glyph.
 * A chat stays in the open list until someone calls it done: nothing the person has not put away folds out of sight.
 * A finished chat is ready for review whatever it left (an answer, work to land, a merged pull request), and Done
 * holds only the chats called done (inbox.doneAt), which the archive sweep then takes (archivesAt). The mark wins
 * over the chat's state, so a chat marked done with work on its branch is done; one that asks or starts again leaves
 * it (the runtime reopens it on its next turn).
 * Pinned in the order they were pinned; needs you and ready for review newest return first (a chat returns when its
 * status changes, which moves updated_at); working by when its turn started, so rows hold still while events land;
 * snoozed by when they wake; done by when it was called done, newest first. Builders and delegated agents stay under
 * their lead unless they wait on the person. `statuses`: every chat's (model.ts chatStatuses), so a lead waiting on
 * its agents is at work.
 */
export function queueSections(workspaces: ReadonlyArray<WorkspaceView>, statuses: ReadonlyMap<string, ChatStatus | null>, now = Date.now()): QueueSections {
  const live = workspaces.filter((w) => w.state !== "archived");
  const ids = new Set(live.map((w) => w.id));
  const out = { pinned: [] as WorkspaceView[], needs: [] as WorkspaceView[], working: [] as WorkspaceView[], review: [] as WorkspaceView[], snoozed: [] as WorkspaceView[], done: [] as WorkspaceView[] };
  for (const w of live) {
    if (w.parentId && ids.has(w.parentId) && w.state !== "needs_input") continue;
    const section = inboxSection(w, now);
    if (section !== "active") out[section].push(w);
    else {
      const stage = chatStage(statuses.get(w.id) ?? chatStatus(w), w);
      out[stage === "done" ? "review" : stage].push(w);
    }
  }
  out.pinned.sort(byPinned);
  out.needs.sort(newest((w) => w.updatedAt));
  out.working.sort(newest((w) => w.activity?.turnStartedAt ?? w.updatedAt));
  out.review.sort(newest((w) => w.updatedAt));
  out.snoozed.sort((a, b) => a.inbox!.snoozedUntil!.localeCompare(b.inbox!.snoozedUntil!));
  out.done.sort(newest((w) => w.inbox!.doneAt!));
  return out;
}

/**
 * Some chat waits on the person (the sidebar's Queue bell): one on the Needs you shelf, or a pinned one that asks or
 * failed unseen, which its pin keeps off that shelf. Never a snoozed one, until it wakes.
 */
export function waitsOnYou(sections: QueueSections, statuses: ReadonlyMap<string, ChatStatus | null>): boolean {
  return sections.needs.length > 0 || sections.pinned.some((w) => chatStage(statuses.get(w.id) ?? chatStatus(w), w) === "needs");
}

const DAY = 86_400_000;

/**
 * When the runtime's sweep archives a done chat (Settings' inbox_archive_done_after_days, runtime inbox.ts
 * dueForArchive): `days` after it was marked done. Null when nothing will: auto-archive is off, or the chat is
 * pinned or still has an open pull request.
 */
export function archivesAt(w: WorkspaceView, days: number | null | undefined): number | null {
  const doneAt = ms(w.inbox?.doneAt);
  if (typeof days !== "number" || Number.isNaN(doneAt) || w.inbox?.pinnedAt) return null;
  if (w.pullRequest?.state === "open" || w.pullRequest?.state === "draft") return null;
  return doneAt + days * DAY;
}

/** How long a chat sits quiet before Tidy calls it old. */
export const TIDY_QUIET_MS = DAY;

/**
 * What Tidy archives in one press (the sidebar's ⋯ menu; Arc's Tidy, for chats): the old ones, each lead with the
 * agents under it. A chat is old when nothing is left for the person (model.ts chatStage "done": not at work, not
 * asking, its work landed) and it has sat quiet for a day; a done mark younger than a day keeps it too. Never one
 * pinned, snoozed, or held back by the caller (`keep`: on screen, or on another computer). A lead stays while anything
 * under it would, and while it is unread and not called done; its agents need not be read, nobody opens those.
 */
export function tidyable(workspaces: ReadonlyArray<WorkspaceView>, statuses: ReadonlyMap<string, ChatStatus | null>, keep: ReadonlySet<string>, now = Date.now()): WorkspaceView[] {
  const section = (w: WorkspaceView) => inboxSection(w, now);
  const quiet = (at: string | null | undefined) => now - ms(at) >= TIDY_QUIET_MS;
  const free = (w: WorkspaceView) =>
    chatStage(statuses.get(w.id) ?? chatStatus(w), w) === "done" &&
    (section(w) === "active" || (section(w) === "done" && quiet(w.inbox?.doneAt))) &&
    quiet(w.updatedAt) &&
    !w.inbox?.pinnedAt &&
    !keep.has(w.id);
  return leadsWithChildren(workspaces.filter((w) => w.state !== "archived")).flatMap(({ lead, children }) =>
    (section(lead) === "done" || !lead.unread) && [lead, ...children].every(free) ? [lead, ...children] : [],
  );
}

/** Not while it asks something or a message waits to start: the runtime refuses those (upstream canSnooze). */
export function canSnooze(w: WorkspaceView): boolean {
  return w.state !== "needs_input" && w.state !== "queued" && !w.activity?.ask;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
export interface SnoozePreset {
  /** "after:60", "at:tomorrow:09:00": the option it came from. */
  readonly id: string;
  readonly label: string;
  /** When it wakes, as the person reads a clock: "6:00 PM", "Mon 9:00 AM". */
  readonly when: string;
  readonly until: string;
}

/** The Snooze menu when Settings names none of its own (upstream DEFAULT_SNOOZE_PRESETS). */
export const DEFAULT_SNOOZE_OPTIONS: ReadonlyArray<SnoozeOption> = [
  { kind: "after", minutes: 60 },
  { kind: "after", minutes: 180 },
  { kind: "at", day: "today", time: "18:00" },
  { kind: "at", day: "tomorrow", time: "09:00" },
  { kind: "at", day: "monday", time: "09:00" },
];

export const MAX_SNOOZE_OPTIONS = 8;
export const MAX_SNOOZE_MINUTES = 30 * 24 * 60;

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const clock = (d: Date) => d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
// By calendar day, not DAY_MS: a fixed offset lands on the wrong local day across a DST change.
const addDays = (base: Date, days: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  return d;
};
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
export function snoozeDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return plural(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

export const snoozeOptionId = (o: SnoozeOption) => (o.kind === "after" ? `after:${o.minutes}` : `at:${o.day}:${o.time}`);

function daysAhead(o: Extract<SnoozeOption, { kind: "at" }>, now: Date): number {
  if (o.day === "today") return 0;
  if (o.day === "tomorrow") return 1;
  return (WEEKDAYS.indexOf(o.day) - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the real day gap, so a Monday option on a Sunday reads "Tomorrow". */
function optionLabel(o: SnoozeOption, ahead: number): string {
  if (o.kind === "after") return `In ${snoozeDuration(o.minutes)}`;
  if (ahead === 0) {
    const hour = Number(o.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (ahead === 1) return "Tomorrow";
  if (o.day === "monday") return "Next week";
  return ahead === 7 ? `Next ${capital(o.day)}` : capital(o.day);
}

/** One option as a menu row from `now`, or null for a today option whose time has passed. */
export function snoozePreset(o: SnoozeOption, now: Date, formatTime: (d: Date) => string = clock): SnoozePreset | null {
  let wake: Date;
  let ahead = 0;
  if (o.kind === "after") wake = new Date(now.getTime() + o.minutes * 60_000);
  else {
    ahead = daysAhead(o, now);
    wake = addDays(now, ahead);
    wake.setHours(Number(o.time.slice(0, 2)), Number(o.time.slice(3)), 0, 0);
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = optionLabel(o, ahead);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const namesDay = o.kind === "at" && label !== "Next week";
  const time = formatTime(wake);
  return {
    id: snoozeOptionId(o),
    label,
    when: namesDay || wake.toDateString() === now.toDateString() ? time : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    until: wake.toISOString(),
  };
}

/**
 * The Snooze menu (upstream resolveSnoozePresets, #26208): the person's options from Settings, else the defaults,
 * soonest first and one row per wake minute (the first in Settings wins a tie).
 */
export function snoozePresets(now: Date, options: ReadonlyArray<SnoozeOption> = DEFAULT_SNOOZE_OPTIONS, formatTime?: (d: Date) => string): ReadonlyArray<SnoozePreset> {
  const minute = (p: SnoozePreset) => Math.floor(Date.parse(p.until) / 60_000);
  const seen = new Set<number>();
  return options
    .flatMap((o) => snoozePreset(o, now, formatTime) ?? [])
    .sort((a, b) => minute(a) - minute(b))
    .filter((p) => !seen.has(minute(p)) && (seen.add(minute(p)), true));
}

/** How Settings lists an option: "In 3 hours", "Today at 6:00 PM", "Friday at 4:30 PM". */
export function snoozeOptionText(o: SnoozeOption, formatTime: (d: Date) => string = clock): string {
  if (o.kind === "after") return `In ${snoozeDuration(o.minutes)}`;
  const at = new Date(2000, 0, 1, Number(o.time.slice(0, 2)), Number(o.time.slice(3)));
  return `${capital(o.day)} at ${formatTime(at)}`;
}

/** What the Add row makes: a wait of `amount` units, or a day and an "HH:MM" time; null when it is not one. */
export function snoozeOptionFrom(
  draft: { readonly kind: "after"; readonly amount: string; readonly unit: "minutes" | "hours" | "days" } | { readonly kind: "at"; readonly day: Extract<SnoozeOption, { kind: "at" }>["day"]; readonly time: string },
): SnoozeOption | null {
  if (draft.kind === "at") return /^([01]\d|2[0-3]):[0-5]\d$/.test(draft.time) ? { kind: "at", day: draft.day, time: draft.time } : null;
  if (!/^\d+$/.test(draft.amount.trim())) return null;
  const minutes = Number(draft.amount) * (draft.unit === "days" ? 24 * 60 : draft.unit === "hours" ? 60 : 1);
  return minutes >= 1 && minutes <= MAX_SNOOZE_MINUTES ? { kind: "after", minutes } : null;
}

/** The list with one more option, unless it is already there or the list is full. */
export function withSnoozeOption(list: ReadonlyArray<SnoozeOption>, o: SnoozeOption): ReadonlyArray<SnoozeOption> {
  if (list.length >= MAX_SNOOZE_OPTIONS || list.some((x) => snoozeOptionId(x) === snoozeOptionId(o))) return list;
  return [...list, o];
}

/**
 * A menu row as picked. A wait starts at the pick, so it is worked out again then; a set time keeps the wake the
 * menu showed, which a day turning over meanwhile would otherwise move.
 */
export function pickSnooze(shown: SnoozePreset, now: Date, options: ReadonlyArray<SnoozeOption> = DEFAULT_SNOOZE_OPTIONS): string {
  const wait = options.find((o) => o.kind === "after" && snoozeOptionId(o) === shown.id);
  return (wait && snoozePreset(wait, now)?.until) ?? shown.until;
}

/** A picked local date and time ("2026-10-21", "14:30") as the wake time, or null when it is not one or not ahead. */
export function customSnooze(date: string, time: string, now: Date): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const wake = new Date(`${date}T${time}:00`);
  // A rolled-over date, or a local time a DST change skips.
  const pad = (n: number) => String(n).padStart(2, "0");
  if (`${wake.getFullYear()}-${pad(wake.getMonth() + 1)}-${pad(wake.getDate())}` !== date || `${pad(wake.getHours())}:${pad(wake.getMinutes())}` !== time) return null;
  return wake.getTime() > now.getTime() ? wake.toISOString() : null;
}

/** How long until it wakes: "40m", "3h", "2d". */
export function wakeLabel(until: string, now = Date.now()): string {
  const left = ms(until) - now;
  if (!(left > 0)) return "now";
  if (left < HOUR_MS) return `${Math.max(1, Math.ceil(left / 60_000))}m`;
  if (left < DAY_MS) return `${Math.ceil(left / HOUR_MS)}h`;
  return `${Math.ceil(left / DAY_MS)}d`;
}

/**
 * The inbox after an action, as the runtime will make it (upstream Orchestrator): done unpins and clears snooze, pinning
 * clears done and snooze, unread reads it from just before its last change. Shown until the runtime's answer replaces it.
 */
export function applyInbox(inbox: WorkspaceInbox | undefined, action: InboxAction, updatedAt: string, now = new Date()): WorkspaceInbox | undefined {
  const at = now.toISOString();
  const { done_at, snoozed_until, snoozed_at, pinned_at, visited_at } = inbox ?? {};
  const done = done_at ? { done_at } : {};
  const snooze = snoozed_until ? { snoozed_until, ...(snoozed_at ? { snoozed_at } : {}) } : {};
  const pin = pinned_at ? { pinned_at } : {};
  const read = visited_at ? { visited_at } : {};
  const next: WorkspaceInbox = (() => {
    switch (action.do) {
      case "done":
        return { ...read, done_at: done_at ?? at };
      case "reopen":
        return { ...snooze, ...pin, ...read };
      case "snooze":
        return { ...done, ...pin, ...read, snoozed_until: action.until, snoozed_at: at };
      case "wake":
        return { ...done, ...pin, ...read };
      case "pin":
        return { ...read, pinned_at: pinned_at ?? at };
      case "unpin":
        return { ...done, ...snooze, ...read };
      case "seen":
        return { ...done, ...snooze, ...pin, visited_at: visited_at && ms(visited_at) > ms(action.through) ? visited_at : action.through };
      case "unread":
        return { ...done, ...snooze, ...pin, visited_at: new Date(ms(updatedAt) - 1).toISOString() };
    }
  })();
  return Object.keys(next).length === 0 ? undefined : next;
}
