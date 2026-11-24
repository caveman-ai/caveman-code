// What the phone keeps on disk, so it opens where you were with everything already drawn. One synchronous key-value
// store on every platform: the browser's own `localStorage` on the web, and on iOS and Android the SQLite-backed one
// `expo-sqlite/localStorage/install` puts in place at the top of index.ts (it is in Expo Go). Reading is synchronous,
// so the first frame is drawn from disk with no spinner and no flash of an empty screen.
//
// Every key carries its version (cc/v1/...) and is read defensively: a value that doesn't decode is dropped, never
// thrown, and the app starts that part fresh. Writes are batched: the first change starts a short timer and every
// change before it fires joins the same write, through one queue, so a background flush and a timed write can never
// interleave; going to the background (or closing the tab) writes at once. `?fresh` on the web build, and Settings >
// About's reset, start the demo morning again.
import { AppState, Platform } from "react-native";

export const KEYS = {
  /** The screen you were on and when you left it (launch.ts). Under a kilobyte, read before the first frame. */
  boot: "cc/v1/boot",
  /** Chats with their transcripts, each Chief's lines, the script's own counters (store/board.ts). */
  board: "cc/v1/board",
  /** Read and unread, done, snoozed, renamed, archived (store/inbox.ts). */
  inbox: "cc/v1/inbox",
  /** Per chat, Chief and new chat: draft, queue, folds, scroll anchor, last read (store/sessions.ts). */
  sessions: "cc/v1/sessions",
  /** When the app last went out of sight, and the briefing on that time until it is read (store/away.ts). */
  away: "cc/v1/away",
  /** The computer this phone follows, and whether the board is that computer's (live/seams.ts). */
  link: "cc/v1/link",
} as const;

const PREFIX = "cc/";
/** How long a change waits for others to join its write. */
const WRITE_MS = 400;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

interface Envelope {
  v: 1;
  at: number;
  data: unknown;
}

/** A key's value, or null when there is none or it doesn't decode (then it is dropped, so it can't fail again). */
export function read<T>(key: string, decode: (data: unknown) => T | null): T | null {
  const store = storage();
  if (!store) return null;
  let text: string | null = null;
  try {
    text = store.getItem(key);
  } catch {
    return null;
  }
  if (text === null) return null;
  try {
    const envelope = JSON.parse(text) as Partial<Envelope> | null;
    if (!envelope || envelope.v !== 1) throw new Error("another version");
    const value = decode(envelope.data);
    if (value === null) throw new Error("does not decode");
    return value;
  } catch (error) {
    if (__DEV__) console.warn(`[persist] dropped ${key}:`, error instanceof Error ? error.message : error);
    try {
      store.removeItem(key);
    } catch {}
    return null;
  }
}

// The write queue: one value getter per key, read when the write happens so it carries the latest state.
const pending = new Map<string, () => unknown>();
let timer: ReturnType<typeof setTimeout> | null = null;

/** Writes `value()` under `key` within WRITE_MS, together with every other change made before then. */
export function write(key: string, value: () => unknown) {
  pending.set(key, value);
  timer ??= setTimeout(flush, WRITE_MS);
}

/** Writes everything waiting, now. */
export function flush() {
  if (timer) clearTimeout(timer);
  timer = null;
  const store = storage();
  if (!store || !pending.size) return;
  const at = Date.now();
  const writes = [...pending];
  pending.clear();
  for (const [key, value] of writes) {
    try {
      store.setItem(key, JSON.stringify({ v: 1, at, data: value() } satisfies Envelope));
    } catch (error) {
      // Full or unavailable: the phone keeps working from memory, and the next change tries again.
      if (__DEV__) console.warn(`[persist] could not write ${key}:`, error);
    }
  }
}

/** Removes a key now, and any write of it still waiting. */
export function remove(key: string) {
  pending.delete(key);
  try {
    storage()?.removeItem(key);
  } catch {}
}

/** Forgets everything the app keeps (every cc/ key), and whatever was about to be written. */
export function clearPersisted() {
  pending.clear();
  if (timer) clearTimeout(timer);
  timer = null;
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i);
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
    for (const key of keys) store.removeItem(key);
  } catch {}
}

// Leaving: what launch.ts notes as you go (when you left the screen you were on), then everything waiting is written.
const leaving = new Set<() => void>();

/** Runs `fn` as the app goes to the background or the page is closed, just before the write. */
export function onLeave(fn: () => void): () => void {
  leaving.add(fn);
  return () => void leaving.delete(fn);
}

function leave() {
  for (const fn of [...leaving]) fn();
  flush();
}

const web = Platform.OS === "web" && typeof window !== "undefined";

/** The web build opened with `?fresh`: start over from the scripted morning. */
export const FRESH = web && typeof location !== "undefined" && new URLSearchParams(location.search).has("fresh");

if (FRESH) {
  clearPersisted();
  // Take it off the address, so reloading after that restores as usual.
  try {
    const url = new URL(location.href);
    url.searchParams.delete("fresh");
    history.replaceState(history.state, "", url.toString());
  } catch {}
}

// Kept on globalThis so a hot reload of this file doesn't add a second set of listeners. AppState covers a tab going
// to the background on the web too (react-native-web reads the page's visibility); `pagehide` covers a reload.
const g = globalThis as { __ccPersistLeave?: () => void };
g.__ccPersistLeave?.();
const appState = AppState.addEventListener("change", (state) => {
  if (state !== "active") leave();
});
if (web) window.addEventListener("pagehide", leave);
g.__ccPersistLeave = () => {
  appState.remove();
  if (web) window.removeEventListener("pagehide", leave);
};
