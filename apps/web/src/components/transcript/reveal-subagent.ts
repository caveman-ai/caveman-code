// The sidebar lists a chat's native subagents (Workspace.subagents); opening one opens its chat at
// the subagent's row. The sidebar asks here, the fold and subagent rows holding that row open, and
// the row scrolls into view and takes the request (Transcript.tsx). A request no row takes in a
// few seconds (an older subagent whose rows are not mounted) lapses, so it never pops open later.
import { useSyncExternalStore } from "react";
import type { TranscriptItem } from "../../state/transcript-model.ts";
import type { Row } from "./rows.ts";

const LAPSE_MS = 8000;

let wanted: string | null = null;
let lapse: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const current = () => wanted;

/** Asks the transcript showing this item to open its row and scroll to it. */
export function revealSubagent(itemId: string): void {
  wanted = itemId;
  clearTimeout(lapse);
  lapse = setTimeout(() => taken(itemId), LAPSE_MS);
  notify();
}

/** The row asked for is in view. */
export function taken(itemId: string): void {
  if (wanted !== itemId) return;
  wanted = null;
  clearTimeout(lapse);
  notify();
}

/** The subagent row asked for, if any. */
export function useRevealedSubagent(): string | null {
  return useSyncExternalStore(subscribe, current, current);
}

/** Whether `id` is a subagent among `items` or inside one of them. */
export function holdsSubagent(items: ReadonlyArray<TranscriptItem>, id: string): boolean {
  return items.some((item) => item.kind === "subagent" && (item.id === id || holdsSubagent(item.items, id)));
}

/** Whether a fold's rows hold the subagent `id`. */
export function rowsHoldSubagent(rows: ReadonlyArray<Row>, id: string): boolean {
  return rows.some((row) =>
    row.kind === "item" ? holdsSubagent([row.item], id) : row.kind === "agents" ? holdsSubagent(row.items, id) : row.kind === "fold" ? rowsHoldSubagent(row.rows, id) : false,
  );
}
