// Everything Smart View needs from the right sidebar, in one narrow seam over the side panel's store (panels/store.ts)
// and its movable panes: open a tab in front or behind, close one, whether a tab still exists, what the sidebar shows
// now, and when the person last touched it. The rest of Smart View talks only to this.
//
// A tab the person moved into a pane of its own (isHosted) is theirs: Smart View never brings its pane forward
// (that can switch window tabs) unless they asked for it, and never closes it.
import { activateTab, closeTab, getPanel, getTabs, idFor, isHosted, openSurface, updateTab } from "../panels/store.ts";
import { surfaceDef } from "../panels/registry.ts";
import type { Target } from "./targets.ts";

/**
 * Shows a target. front: the panel's tab in front, the panel opening only when `asked`; behind: a tab behind the one
 * in front, its mark pulsing until the person looks. `tab`: the one already showing it, brought forward again
 * (`adopted`: it was the person's own). A tab of the person's that already shows the same thing is adopted: never
 * renamed, never brought forward unless they asked, only pulsed. Returns the tab and whether it is adopted.
 */
export function showTarget(workspaceId: string, target: Target, how: "front" | "behind", asked: boolean, tab?: { readonly id: string; readonly adopted: boolean }): { readonly tab: string; readonly adopted: boolean } {
  const tabs = getTabs(workspaceId);
  const known = tab !== undefined && tabs.some((t) => t.id === tab.id) ? tab : undefined;
  const twin = known === undefined ? idFor(target.kind, target.params as never) : null;
  const theirs = known?.adopted === true || (twin !== null && tabs.some((t) => t.id === twin));
  if (theirs) {
    const id = known?.id ?? twin!;
    if (asked) activateTab(workspaceId, id);
    else if (!isHosted(workspaceId, id)) updateTab(workspaceId, id, { attention: "pulse" });
    return { tab: id, adopted: true };
  }
  // Quietly first: a focusing open of a tab in a pane would bring that pane forward.
  const id = known?.id ?? openSurface(workspaceId, target.kind, target.params as never, { focus: false, pulse: true });
  if (target.title) updateTab(workspaceId, id, { title: target.title });
  if (isHosted(workspaceId, id)) {
    if (asked) activateTab(workspaceId, id);
    return { tab: id, adopted: false };
  }
  if (how === "front" && (asked || getPanel(workspaceId).open)) activateTab(workspaceId, id);
  else if (known) updateTab(workspaceId, id, { attention: "pulse" });
  return { tab: id, adopted: false };
}

/**
 * The Chief closed an entry: its tab closes only if the person never looked at it (it still pulses, it is not in
 * front, it is not in a pane of its own) and it was never theirs. Anything they looked at is theirs now and stays.
 */
export function closeUnseen(workspaceId: string, tabId: string, adopted: boolean): void {
  if (adopted || isHosted(workspaceId, tabId)) return;
  const tab = getTabs(workspaceId).find((t) => t.id === tabId);
  const panel = getPanel(workspaceId);
  if (tab?.attention !== "pulse" || (panel.open && panel.active === tabId)) return;
  closeTab(workspaceId, tabId);
}

/** Whether the tab is still open, in the panel's strip or in a pane of its own. */
export function hasTab(workspaceId: string, tabId: string): boolean {
  return getTabs(workspaceId).some((t) => t.id === tabId);
}

/** The sidebar as placement reads it: shown, and whether its tab in front is nothing of the person's (none, a launcher, a pinned tab such as the Chief's Work). */
export function sidebarNow(workspaceId: string): { readonly open: boolean; readonly home: boolean } {
  const panel = getPanel(workspaceId);
  const front = getTabs(workspaceId).find((t) => t.id === panel.active);
  return { open: panel.open, home: front === undefined || front.kind === "new" || surfaceDef(front.kind)?.pinned === true };
}

// ------------------------------------------------------------- touched

let touchedAt: number | null = null;
let watchers = 0;
/** The person touched a side panel (null: forget it). */
export function touched(at: number | null = Date.now()): void {
  touchedAt = at;
}
const touch = (e: Event) => {
  if ((e.target as Element | null)?.closest?.("[data-side-panel]")) touched();
};
const EVENTS = ["pointerdown", "wheel", "keydown", "focusin", "scroll"] as const;

/**
 * When the person last used a side panel (ms), or null: now while they are in it (focus in it, text selected in it,
 * the pointer over it: reading without moving), else their last click, scroll, key or focus there.
 */
export const lastTouched = (): number | null => (inUseNow() ? Date.now() : touchedAt);

function inUseNow(): boolean {
  if (typeof document === "undefined") return false;
  const inPanel = (node: Node | null | undefined): boolean => {
    const el = node && typeof (node as Element).closest === "function" ? (node as Element) : (node?.parentElement ?? null);
    return el?.closest("[data-side-panel]") != null;
  };
  if (inPanel(document.activeElement)) return true;
  const selection = document.getSelection?.();
  if (selection && !selection.isCollapsed && inPanel(selection.anchorNode)) return true;
  return document.querySelector("[data-side-panel]:hover") !== null;
}

/** Starts noticing touches (capture, passive), once however many callers; returns its stop. */
export function watchTouches(): () => void {
  if (watchers++ === 0) for (const type of EVENTS) document.addEventListener(type, touch, { capture: true, passive: true });
  return () => {
    if (--watchers === 0) for (const type of EVENTS) document.removeEventListener(type, touch, { capture: true });
  };
}
