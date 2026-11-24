// Archived chats opened from search (⌘K): the live list leaves them out (workspace.list), so a pane reads them
// from here, with the header's Restore; once restored the live list has them again and wins.
import type { Workspace } from "@caveman-app/session-protocol";
import { useSyncExternalStore } from "react";

const found = new Map<string, Workspace>();
const listeners = new Set<() => void>();

export function peek(workspace: Workspace): void {
  found.set(workspace.id, workspace);
  for (const listener of listeners) listener();
}

/** The archived chat search opened as `id`, re-rendering when one is opened (a pane may already show its id). */
export function usePeeked(id: string | null): Workspace | undefined {
  return useSyncExternalStore(
    (listener) => (listeners.add(listener), () => void listeners.delete(listener)),
    () => (id ? found.get(id) : undefined),
  );
}
