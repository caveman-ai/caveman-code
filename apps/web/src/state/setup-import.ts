// The setup the first run brings over (Your setup's "Bring your setup"), as one run that outlives the page it started
// on: import.apply can take a minute, the first run moves on without waiting, and it may end, reload or quit before the
// answer. Kept on this device; Plugins offers to bring the rest when a run didn't finish (PR #78 review).

import { useSyncExternalStore } from "react";
import type { Client } from "@caveman-app/session-protocol/client";
import { requestId } from "./runtime.tsx";
import type { Bringing } from "../routes/onboarding/model.ts";

const KEY = "caveman.setupImport";
type Ref = { from: "claude" | "codex" | "cursor"; kind: "marketplace" | "plugin" | "skill" | "mcp_server" | "instructions"; name: string };

/** What this device last knew; a run it never saw answer reads as interrupted (the app quit or the page reloaded). */
export function readKept(raw: string | null): Bringing | null {
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as Bringing;
    return kept.state === "running" ? { state: "interrupted", parts: kept.parts } : kept;
  } catch {
    return null;
  }
}

let current: Bringing | null = typeof localStorage === "undefined" ? null : readKept(localStorage.getItem(KEY));
const listeners = new Set<() => void>();
const onFinish = new Set<() => void>();

function set(next: Bringing | null) {
  current = next;
  if (typeof localStorage !== "undefined") {
    if (next) localStorage.setItem(KEY, JSON.stringify(next));
    else localStorage.removeItem(KEY);
  }
  for (const l of listeners) l();
}

export const bringingNow = (): Bringing | null => current;

export function useBringing(): Bringing | null {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => current,
    () => current,
  );
}

/** Runs when a run answers (the cached import.scan is stale then). */
export function onBringingFinished(fn: () => void): () => void {
  onFinish.add(fn);
  return () => void onFinish.delete(fn);
}

/**
 * Starts bringing `items` over. One run at a time, and once per first run: Back then Continue on Your setup must not
 * start a second import.apply over the first (they install the same marketplaces and plugins at once). `again` is
 * Plugins' "Bring the rest": a new run after one that didn't finish. Answers whether it started.
 */
export function startBringing(client: Pick<Client, "call">, items: ReadonlyArray<Ref>, parts: ReadonlyArray<string>, again = false): boolean {
  if (current?.state === "running") return false;
  if (!again && current?.state === "done") return false;
  if (items.length === 0) return false;
  set({ state: "running", parts });
  client.call("import.apply", { request_id: requestId(), items: [...items] }).then(
    (r) => set({ state: "done", parts, imported: r.imported, failed: r.failed.map((f) => f.ref.name) }),
    (e: unknown) => set({ state: "failed", error: e instanceof Error ? e.message : String(e) }),
  ).finally(() => {
    for (const fn of onFinish) fn();
  });
  return true;
}

/** Plugins' dismiss: the person saw how it went. */
export const forgetBringing = () => set(null);
