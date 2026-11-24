// The one quiet offer of sync. Sync is a setting and its
// pop-up never opens by itself; this is the one place it is offered unasked. Once someone is
// settled (a third chat, or a second day of use) a single line offers sync for the web and the phone: one press on, or
// dismiss, and it never comes again. It is not a second prompt: it shows only while the dialog is closed and sync has
// not been answered anywhere (cloud.status `sync.ask`, Settings.sync_chats).
//
// What it remembers is per device, like the Cloud offer (state/cloud-offer.ts): the day this device was first seen, the
// most chats it has held, and what the person said to the line here. The answer itself is the setting.

import { useSyncExternalStore } from "react";
import type { WorkspaceView } from "./model.ts";

const KEY = "caveman.syncOffer";

/** Chats that make someone settled: the third. */
export const SETTLED_CHATS = 3;

export interface SyncOfferSaved {
  /** The local day (YYYY-MM-DD) this device first opened the app; null before it did. */
  readonly firstDay: string | null;
  /** The most chats this device has held at once, so putting one away does not unsettle anyone. */
  readonly chats: number;
  readonly answer: "on" | "off" | null;
}

const NOTHING: SyncOfferSaved = { firstDay: null, chats: 0, answer: null };

/** What storage holds, in whatever state it is in: a missing, blocked or damaged entry is a device never seen. */
export function readSyncOffer(raw: string | null): SyncOfferSaved {
  if (raw === null) return NOTHING;
  try {
    const saved = JSON.parse(raw) as Partial<SyncOfferSaved> | null;
    const firstDay =
      typeof saved?.firstDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(saved.firstDay)
        ? saved.firstDay
        : null;
    const chats =
      typeof saved?.chats === "number" && Number.isFinite(saved.chats) && saved.chats > 0
        ? Math.floor(saved.chats)
        : 0;
    const answer = saved?.answer === "on" || saved?.answer === "off" ? saved.answer : null;
    return { firstDay, chats, answer };
  } catch {
    return NOTHING;
  }
}

/** The local calendar day, as the person lives it (a night's sleep is the second day, not 24 hours). */
export const dayKey = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** Chats the person started: not a chat's own sub-chats, an automation's steps, or one put away. */
export const chatCount = (
  workspaces: ReadonlyArray<Pick<WorkspaceView, "parentId" | "automationStep" | "state">>,
): number =>
  workspaces.filter(
    (w) => w.parentId === null && w.automationStep !== true && w.state !== "archived",
  ).length;

export interface SyncOfferInput {
  readonly saved: SyncOfferSaved;
  /** This launch is the one that first saw this device: never offered in it. */
  readonly firstSession: boolean;
  readonly today: string;
  /** cloud.status `sync`: what this Mac's Caveman says about sync. */
  readonly sync:
    | { readonly available: boolean; readonly on: boolean; readonly ask?: boolean | undefined }
    | null
    | undefined;
  /** Settings.sync_chats: answered, whichever way, when it is set. */
  readonly syncChats: boolean | undefined;
  /** The sync dialog is open (Getting started's step opened it): the line never stands beside it. */
  readonly dialogOpen: boolean;
  /** A chat is working or waiting on the person. */
  readonly running: boolean;
  /** A browser window: sync is this Mac's to turn on. */
  readonly hosted: boolean;
}

/**
 * Whether the line shows: sync is on offer and nobody has answered it anywhere, this is not the first session, no chat
 * is running and the dialog is closed, and the person is settled: a third chat, or a day other than the first.
 */
export function showsSyncOffer(i: SyncOfferInput): boolean {
  if (i.hosted || i.saved.answer !== null || i.syncChats !== undefined) return false;
  if (i.sync?.available !== true || i.sync.on || i.sync.ask !== true) return false;
  if (i.firstSession || i.dialogOpen || i.running) return false;
  return (
    i.saved.chats >= SETTLED_CHATS || (i.saved.firstDay !== null && i.saved.firstDay !== i.today)
  );
}

let state: SyncOfferSaved | undefined;
let firstSession = false;
const listeners = new Set<() => void>();
function save(next: SyncOfferSaved) {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: nothing is kept past this window.
  }
}
const load = (): SyncOfferSaved => {
  let saved = NOTHING;
  try {
    saved = readSyncOffer(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    // Storage blocked: this window is its own first session, and the answer holds until it closes.
  }
  // A device first seen now is in its first session until the page goes (a reload counts as a launch).
  if (saved.firstDay === null) {
    firstSession = true;
    saved = { ...saved, firstDay: dayKey(new Date()) };
    save(saved);
  }
  return saved;
};
const get = (): SyncOfferSaved => (state ??= load());
const set = (next: SyncOfferSaved) => {
  state = next;
  save(next);
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The chats this device holds now: the most seen is kept. */
export function noteChats(count: number): void {
  if (count > get().chats) set({ ...get(), chats: count });
}

/** The person's answer to the line: remembered for good, and it never comes again. */
export const answerSyncOffer = (answer: "on" | "off"): void => set({ ...get(), answer });

/** This launch is the first one on this device. */
export const inFirstSession = (): boolean => (get(), firstSession);

export const useSyncOfferSaved = (): SyncOfferSaved => useSyncExternalStore(subscribe, get, get);

/** Tests start from a clean device. */
export function resetSyncOffer(): void {
  state = undefined;
  firstSession = false;
}
