// ↑ in an empty box brings back what you sent before in this chat, ↓ walks
// forward again, as in a shell, Codex and upstream (ported from upstream
// apps/web/src/components/chat/composerPromptHistory.ts, MIT): the entries are
// the chat's own messages, newest last, a repeat kept once.
import type { TranscriptItem } from "../state/transcript-model.ts";
import { draftFromWire } from "./thread-refs.ts";

export interface PromptEntry {
  readonly id: string;
  /** As sent (thread links in wire form), so a recalled message gets its pills back. */
  readonly wire: string;
  /** As the box shows it ("@Title"). */
  readonly shown: string;
}

/** Where a walk through the history stands: the entry on screen and the text it put there. */
export interface PromptPosition {
  readonly id: string;
  readonly recalled: string;
}

/** The person's own messages in this chat, in order; another agent's messages and empty ones are left out. */
export function promptEntries(items: ReadonlyArray<TranscriptItem>): PromptEntry[] {
  const out: PromptEntry[] = [];
  for (const item of items) {
    if (item.kind !== "user" || item.from) continue;
    const wire = item.text.trim();
    if (!wire) continue;
    const shown = draftFromWire(wire).text;
    if (out.at(-1)?.shown === shown) out[out.length - 1] = { id: item.id, wire, shown };
    else out.push({ id: item.id, wire, shown });
  }
  return out;
}

/**
 * One step back or forward from `position` while the box holds `current`. Back starts only from an
 * empty box (or from text a step put there); forward past the newest empties the box. Null: no step.
 */
export function stepPrompt(direction: "back" | "forward", entries: ReadonlyArray<PromptEntry>, position: PromptPosition | null, current: string): { readonly position: PromptPosition | null; readonly entry: PromptEntry | null } | null {
  const at = position && position.recalled === current ? entries.findIndex((e) => e.id === position.id) : -1;
  if (direction === "back") {
    if (at < 0 && current.length > 0) return null;
    const entry = entries[at < 0 ? entries.length - 1 : at - 1];
    return entry ? { position: { id: entry.id, recalled: entry.shown }, entry } : null;
  }
  if (at < 0) return null;
  const entry = entries[at + 1];
  return entry ? { position: { id: entry.id, recalled: entry.shown }, entry } : { position: null, entry: null };
}

/** Which way a key walks the history: a bare ↑ with the caret on the first line, a bare ↓ on the last; otherwise the caret moves. */
export function historyKey(e: { readonly key: string; readonly shiftKey: boolean; readonly altKey: boolean; readonly metaKey: boolean; readonly ctrlKey: boolean }, text: string, start: number, end: number): "back" | "forward" | null {
  if (e.shiftKey || e.altKey || e.metaKey || e.ctrlKey || start !== end) return null;
  if (e.key === "ArrowUp") return text.lastIndexOf("\n", start - 1) < 0 ? "back" : null;
  if (e.key === "ArrowDown") return text.indexOf("\n", end) < 0 ? "forward" : null;
  return null;
}
