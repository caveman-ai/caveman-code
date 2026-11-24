// The workspace list as the runtime pushes it: every workspace.changed lands
// at once (a chat starts, finishes, asks, is renamed or archived), and the
// slow catch-up poll only fills in what a push could not carry (a runtime from
// before the push, a reconnect). The Chief and setup chats are never chats (chief-model.ts);
// workspace.list leaves archived chats out, so an archive leaves the list.

import type { Workspace } from "@caveman-app/session-protocol";

/** A pushed workspace over the list: the same Map when nothing changed, so nothing re-renders. */
export function applyWorkspaceChange(list: ReadonlyMap<string, Workspace>, w: Workspace): ReadonlyMap<string, Workspace> {
  // The Chief and setup chats are never chats in the list (chief-model.ts, environments).
  if (w.kind !== undefined) return list;
  const known = list.get(w.id);
  if (w.status === "archived") {
    if (!known) return list;
    const next = new Map(list);
    next.delete(w.id);
    return next;
  }
  if (known && JSON.stringify(known) === JSON.stringify(w)) return list;
  // New ones go first, as workspace.list orders them (newest first); a change keeps its place.
  return known ? new Map(list).set(w.id, w) : new Map([[w.id, w], ...list]);
}

/**
 * A polled list, with the pushes that arrived while the poll was out laid over it: the poll may have read the
 * store before them. A push older than the polled copy (by updated_at) loses.
 */
export function withPushes(listed: ReadonlyMap<string, Workspace>, pushed: Iterable<Workspace>): ReadonlyMap<string, Workspace> {
  let list = listed;
  for (const w of pushed) {
    const polled = list.get(w.id);
    if (polled && polled.updated_at > w.updated_at) continue;
    list = applyWorkspaceChange(list, w);
  }
  return list;
}

/** How often the catch-up poll runs: pushes carry the workspaces, so it only needs to be slow, slower still when nobody is looking. */
export function catchUpMs(visible: boolean): number {
  return visible ? 10_000 : 60_000;
}
