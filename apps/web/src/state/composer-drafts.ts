// What is typed in a chat's box outlives leaving it, like upstream
// composerDraftStore: a draft per box (a chat, New chat, the Chief) kept in
// localStorage, so switching chats, opening Settings or reloading never loses
// it, and sending clears it. Attached files stay in memory for the page's
// life only: their data URLs are too big for localStorage.
import type { Draft, ThreadRef } from "../components/thread-refs.ts";

export interface DraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type Stored = { readonly text: string; readonly refs: ReadonlyArray<Omit<ThreadRef, "id">>; readonly at: number };

export const DRAFTS_KEY = "caveman.composer.drafts.v1";
/** Boxes kept, newest first; the oldest go. */
const MAX_DRAFTS = 50;
/** A draft longer than this is kept in memory only (a pasted log is not worth a full localStorage). */
const MAX_TEXT = 100_000;
const WRITE_MS = 250;

function readAll(storage: DraftStorage): Record<string, Stored> {
  try {
    const parsed = JSON.parse(storage.getItem(DRAFTS_KEY) ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, Stored>) : {};
  } catch {
    return {};
  }
}

/** The draft kept for `scope`, or null. */
export function readDraft(storage: DraftStorage, scope: string): { text: string; refs: ReadonlyArray<Omit<ThreadRef, "id">> } | null {
  const d = readAll(storage)[scope];
  if (!d || typeof d.text !== "string" || d.text === "") return null;
  return { text: d.text, refs: Array.isArray(d.refs) ? d.refs : [] };
}

/** Keeps `draft` for `scope` (an empty one removes it), newest first, at most MAX_DRAFTS boxes. */
export function writeDraft(storage: DraftStorage, scope: string, draft: Pick<Draft, "text" | "refs">, now = Date.now()): void {
  const all = readAll(storage);
  delete all[scope];
  if (draft.text.trim() !== "" && draft.text.length <= MAX_TEXT) {
    all[scope] = { text: draft.text, refs: draft.refs.map(({ id: _id, ...r }) => r), at: now };
  }
  const kept = Object.entries(all)
    .sort(([, a], [, b]) => (b.at ?? 0) - (a.at ?? 0))
    .slice(0, MAX_DRAFTS);
  try {
    if (kept.length === 0) storage.removeItem(DRAFTS_KEY);
    else storage.setItem(DRAFTS_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    // Storage full or blocked: the draft lives as long as the box does.
  }
}

// Keystrokes land many per second; one write per box after a pause, and at once when the box goes.
const pending = new Map<string, Pick<Draft, "text" | "refs">>();
/** Drafts over MAX_TEXT, written as nothing: what the box gets back while the page lives. */
const unstored = new Map<string, Pick<Draft, "text" | "refs">>();
let timer: ReturnType<typeof setTimeout> | null = null;

const browserStorage = (): DraftStorage | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Writes what waits for `scope` now (every box when absent). */
export function flushDrafts(scope?: string): void {
  const storage = browserStorage();
  for (const [s, d] of [...pending]) {
    if (scope !== undefined && s !== scope) continue;
    pending.delete(s);
    if (d.text.length > MAX_TEXT) unstored.set(s, d);
    else unstored.delete(s);
    if (storage) writeDraft(storage, s, d);
  }
  if (pending.size === 0 && timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/** Keeps `draft` for `scope` shortly. */
export function keepDraft(scope: string, draft: Pick<Draft, "text" | "refs">): void {
  pending.set(scope, draft);
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flushDrafts();
  }, WRITE_MS);
}

/** The kept draft for `scope`, with what waits to be written first. */
export function keptDraft(scope: string): { text: string; refs: ReadonlyArray<Omit<ThreadRef, "id">> } | null {
  const waiting = pending.get(scope) ?? unstored.get(scope);
  if (waiting) return waiting.text === "" ? null : { text: waiting.text, refs: waiting.refs };
  const storage = browserStorage();
  return storage ? readDraft(storage, scope) : null;
}

if (typeof window !== "undefined") window.addEventListener("pagehide", () => flushDrafts());

/** Files attached in a box, kept while the page lives (never in storage). */
const attached = new Map<string, ReadonlyArray<unknown>>();
export const keptFiles = <T>(scope: string): T[] => [...((attached.get(scope) ?? []) as ReadonlyArray<T>)];
export function keepFiles(scope: string, files: ReadonlyArray<unknown>): void {
  if (files.length === 0) attached.delete(scope);
  else attached.set(scope, files);
}
