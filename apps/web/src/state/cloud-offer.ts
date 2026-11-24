// The one-time offer to use a Claude or compact subscription in Cloud too. Your setup no
// longer asks it; it comes with the first chat or computer in Cloud (components/cloud/CloudOffer.tsx), and the same
// choice stays in Settings > Models & keys ("Use everywhere"). This is what the person said to it on this device.
//
// The answer is a per-device convenience, not a setting: a yes starts the same browser approval Settings does (the
// agent's row there then shows it waiting or connected), a no only stops the asking. Neither blocks a start. An offer
// shows the first time only (MAX_SHOWN): a chat that opened before it was read does not bring it back.

import { useSyncExternalStore } from "react";
import { andList } from "../routes/onboarding/model.ts";

const KEY = "caveman.cloudOffer";

/** How many Cloud starts show the offer: the first time only (D2), then it is left to Settings alone. */
export const MAX_SHOWN = 1;

export interface CloudOfferSaved {
  readonly answer: "yes" | "no" | null;
  /** Cloud starts that showed the offer. */
  readonly shown: number;
}

const NOTHING: CloudOfferSaved = { answer: null, shown: 0 };

/** What storage holds, in whatever state it is in: a missing, blocked or damaged entry is "never asked". */
export function readCloudOffer(raw: string | null): CloudOfferSaved {
  if (raw === null) return NOTHING;
  try {
    const saved = JSON.parse(raw) as Partial<CloudOfferSaved> | null;
    const answer = saved?.answer === "yes" || saved?.answer === "no" ? saved.answer : null;
    const shown =
      typeof saved?.shown === "number" && Number.isFinite(saved.shown) && saved.shown > 0
        ? Math.floor(saved.shown)
        : 0;
    return { answer, shown };
  } catch {
    return NOTHING;
  }
}

/** Whether a Cloud start may show the offer: nothing answered, shown fewer than MAX_SHOWN times, and something to approve. */
export const mayOfferCloud = (saved: CloudOfferSaved, offered: ReadonlyArray<unknown>): boolean =>
  saved.answer === null && saved.shown < MAX_SHOWN && offered.length > 0;

/** "Use your Claude subscription here too?", or "Use your Claude and compact subscriptions here too?". */
export function cloudOfferTitle(offered: ReadonlyArray<{ readonly approve: string }>): string {
  return `Use your ${andList(offered.map((o) => o.approve))} ${offered.length === 1 ? "subscription" : "subscriptions"} here too?`;
}

let state: CloudOfferSaved | undefined;
const listeners = new Set<() => void>();
const load = (): CloudOfferSaved => {
  try {
    return readCloudOffer(globalThis.localStorage?.getItem(KEY) ?? null);
  } catch {
    return NOTHING;
  }
};
const get = (): CloudOfferSaved => (state ??= load());
const set = (next: CloudOfferSaved) => {
  state = next;
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the answer holds until the window closes, and Settings is still there.
  }
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The offer was put on screen for a Cloud start. */
export const noteCloudOfferShown = (): void => set({ ...get(), shown: get().shown + 1 });

/** The person's answer: remembered for good, and the offer never comes again. */
export const answerCloudOffer = (answer: "yes" | "no"): void => set({ ...get(), answer });

export const useCloudOfferSaved = (): CloudOfferSaved => useSyncExternalStore(subscribe, get, get);

/** Tests start from a clean device. */
export function resetCloudOffer(): void {
  state = undefined;
}
