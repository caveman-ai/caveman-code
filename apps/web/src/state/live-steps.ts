// Whether a running turn shows its steps on this device. A turn at work starts as
// its one line ("Opus 5.5 working for 12s"), its latest words and anything that
// needs the person; the line opens the steps. The last choice holds: open them
// once and every turn after opens with them, close them and turns start closed
// again. A window preference like the sidebar's shape, kept in localStorage.

import { useSyncExternalStore } from "react";

const KEY = "caveman.liveSteps";

const listeners = new Set<() => void>();
let current: boolean | null = null;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

const snapshot = (): boolean => (current ??= typeof localStorage === "undefined" ? false : read());

export function setLiveSteps(open: boolean): void {
  current = open;
  try {
    localStorage.setItem(KEY, open ? "1" : "0");
  } catch {
    // A full or blocked storage keeps the choice for this window only.
  }
  listeners.forEach((l) => l());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another window's choice reaches this one.
  const other = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    current = null;
    listener();
  };
  window.addEventListener("storage", other);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", other);
  };
}

/** Whether running turns show their steps here (off until the person opens them). */
export function useLiveSteps(): boolean {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}
