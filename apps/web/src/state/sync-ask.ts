// The sync prompt on this Mac (components/SyncPrompt.tsx): whether it is open, and the person's word to Getting started
// on this device. Sync is a setting, so the prompt never opens by itself, in any session: only an explicit
// action opens it (Getting started's sync step, openSyncAsk). The answer itself is a setting (Settings.sync_chats);
// this only remembers that Getting started's step was hidden ("never").

import { useSyncExternalStore } from "react";
import type { SyncAsk } from "./getting-started.ts";

const KEY = "caveman.syncAsk";

interface State {
  readonly answer: SyncAsk;
  /** Opened again from Getting started. */
  readonly open: boolean;
}

const read = (): SyncAsk => {
  const saved = globalThis.localStorage?.getItem(KEY);
  return saved === "later" || saved === "never" ? saved : null;
};

let state: State | undefined;
const listeners = new Set<() => void>();
const get = (): State => (state ??= { answer: read(), open: false });
const set = (next: State) => {
  state = next;
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** Not now ("later": it waits in Getting started) or hidden from there too ("never"). Closes the prompt. */
export function answerSyncAsk(answer: "later" | "never"): void {
  globalThis.localStorage?.setItem(KEY, answer);
  set({ answer, open: false });
}

/** Getting started's step: the prompt again. */
export const openSyncAsk = (): void => set({ ...get(), open: true });
export const closeSyncAsk = (): void => set({ ...get(), open: false });

export const useSyncAsk = (): State => useSyncExternalStore(subscribe, get, get);

/** Tests start from a clean device. */
export function resetSyncAsk(): void {
  state = undefined;
}
