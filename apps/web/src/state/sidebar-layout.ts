// The sidebar's shape on this device: shown or tucked away (⌘B, as in Codex,
// upstream and Claude's app), and how wide it is when shown (dragged or moved
// with the arrow keys on its edge, kept within bounds 
// threadSidebarWidth). Kept in localStorage like the Queue toggle: a window
// preference, not a runtime setting. On a phone the sidebar is a drawer over
// the page instead: shut on every load, opened from a page's menu button, and
// shut again by whatever it opens (shell/Sidebar.tsx).

import { useSyncExternalStore } from "react";
import { isPhone } from "../lib/screen.ts";

export const SIDEBAR_WIDTH = { min: 220, default: 272, max: 420 } as const;
const HIDDEN_KEY = "caveman.sidebarHidden";
const WIDTH_KEY = "caveman.sidebarWidth";

export interface SidebarLayout {
  readonly hidden: boolean;
  readonly width: number;
}

/** A width the sidebar can take: whole pixels within its bounds; anything unreadable is the default. */
export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return SIDEBAR_WIDTH.default;
  return Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)));
}

/** Arrow keys on the edge: 16px a press, 64 with Shift; Home and End go to the bounds. Null for any other key. */
export function keyedSidebarWidth(width: number, key: string, shift: boolean): number | null {
  const step = shift ? 64 : 16;
  if (key === "ArrowLeft") return clampSidebarWidth(width - step);
  if (key === "ArrowRight") return clampSidebarWidth(width + step);
  if (key === "Home") return SIDEBAR_WIDTH.min;
  if (key === "End") return SIDEBAR_WIDTH.max;
  return null;
}

/**
 * The sidebar's top under New chat (the places, the Chiefs), sized on the hairline under it. It stops under one of its
 * rows, so it never shows half a row: folded (0), under a row, or all of it. Dragged shorter than a row it folds away
 * whole (focus mode).
 */
export const SIDEBAR_TOP = { fold: 28 } as const;

/**
 * Where the top can stop, out of the `full` px it needs, given its rows' bottom edges (px from its top): folded, under
 * each row at least as tall as a fold, and all of it; in order, each once.
 */
export function sidebarTopStops(edges: ReadonlyArray<number>, full: number): number[] {
  const under = edges.filter((edge) => edge >= SIDEBAR_TOP.fold && edge < full - 4).map(Math.round);
  return [...new Set([0, ...under, full])].sort((a, b) => a - b);
}

/** The stop nearest `height`: where a drag lets the top rest, row by row as it moves. */
export function snapSidebarTop(height: number, stops: ReadonlyArray<number>): number {
  return stops.reduce((best, stop) => (Math.abs(stop - height) < Math.abs(best - height) ? stop : best), stops[0] ?? 0);
}

/**
 * Where the top settles at a stop out of the `full` px it needs: 0 (folded away) under a row, null (all of it) within
 * a few px of all, else that height in whole px, which it then scrolls within.
 */
export function settleSidebarTop(height: number, full: number): number | null {
  if (height < SIDEBAR_TOP.fold) return 0;
  if (height >= full - 4) return null;
  return Math.round(height);
}

/** The arrow keys on the hairline move it to the next stop up or down; Home folds the top away, End shows all of it. Null for any other key. */
export function keyedSidebarTop(shown: number, stops: ReadonlyArray<number>, key: string): number | null {
  if (stops.length === 0) return null;
  if (key === "ArrowUp") return stops.findLast((stop) => stop < shown - 1) ?? stops[0]!;
  if (key === "ArrowDown") return stops.find((stop) => stop > shown + 1) ?? stops.at(-1)!;
  if (key === "Home") return stops[0]!;
  if (key === "End") return stops.at(-1)!;
  return null;
}

function read(storage: Pick<Storage, "getItem">): SidebarLayout {
  const stored = storage.getItem(WIDTH_KEY);
  return { hidden: storage.getItem(HIDDEN_KEY) === "1", width: stored === null ? SIDEBAR_WIDTH.default : clampSidebarWidth(Number(stored)) };
}

const listeners = new Set<() => void>();
let current: SidebarLayout | null = null;
const snapshot = (): SidebarLayout => (current ??= typeof localStorage === "undefined" ? { hidden: false, width: SIDEBAR_WIDTH.default } : read(localStorage));

function write(next: SidebarLayout): void {
  current = next;
  try {
    localStorage.setItem(HIDDEN_KEY, next.hidden ? "1" : "0");
    localStorage.setItem(WIDTH_KEY, String(next.width));
  } catch {
    // A full or blocked storage keeps the shape for this window only.
  }
  listeners.forEach((l) => l());
}

export const setSidebarHidden = (hidden: boolean) => write({ ...snapshot(), hidden });
export const setSidebarWidth = (width: number) => write({ ...snapshot(), width: clampSidebarWidth(width) });

let drawer = false;
export function setSidebarDrawer(open: boolean): void {
  if (drawer === open) return;
  drawer = open;
  listeners.forEach((l) => l());
}

/** ⌘B, the sidebar's own button and a page's menu button: the drawer on a phone, the panel and its rail elsewhere. */
export const toggleSidebar = () => (isPhone() ? setSidebarDrawer(!drawer) : setSidebarHidden(!snapshot().hidden));

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarLayout(): SidebarLayout {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Whether the phone's drawer is open. */
export const sidebarDrawerOpen = (): boolean => drawer;

export function useSidebarDrawer(): boolean {
  return useSyncExternalStore(subscribe, sidebarDrawerOpen, () => false);
}

/** Exported for tests: the stored shape. */
export const readSidebarLayout = read;
