// The agent's screens while it works: the one floating over the chat (T3
// Code's floating preview), the ones it is using right now, and the ones the
// person put away. Per workspace, never stored.
//
// The agent asking to show a screen (its preview_open, a desktop's first use)
// floats it. The agent using one (the runtime's `active`) floats it too,
// unless the person closed the float or watched the screen in the side panel
// since the agent last asked; then it only reads as in use, its tab and the
// chat header's live button pulsing in the blue, until LIVE_MS after its last
// use or the turn's end. The side panel showing a screen takes the float's
// place.

import { useSyncExternalStore } from "react";
import { getPanel, type PanelState, type SurfaceParams } from "../store.ts";

export type Screen = "browser" | "computer";

/** How long a screen reads as in use after the agent last used it: past the runtime's notices (every 3 s) and the agent's thinking between steps. */
export const LIVE_MS = 15_000;

const floating = new Map<string, Screen>();
/** Screens (`at`) the person closed or watched in the side panel since the agent last asked to show them. */
const quiet = new Set<string>();
/** Screens (`at`) the agent is using, each with the timer that ends it. */
const inUse = new Map<string, ReturnType<typeof setTimeout>>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
const at = (workspaceId: string, screen: Screen) => `${workspaceId}\0${screen}`;

/** The side panel is open on this screen's tab. */
export function panelShows(panel: PanelState, screen: Screen): boolean {
  const tab = panel.open ? panel.tabs.find((t) => t.id === panel.active) : undefined;
  if (screen === "computer") return tab?.kind === "computer";
  return tab?.kind === "browser" && (tab.params as SurfaceParams["browser"]).backend === "agent";
}

/**
 * The agent used `screen`; `asked`: it asked to show it. Marks it in use and floats it, unless the side panel shows
 * it, or the person put it away and the agent didn't ask. Asking also takes the float from another screen.
 */
export function agentUsed(workspaceId: string, screen: Screen, asked: boolean): void {
  const key = at(workspaceId, screen);
  let change = !inUse.has(key);
  clearTimeout(inUse.get(key));
  inUse.set(key, setTimeout(() => endUse(workspaceId, screen), LIVE_MS));
  if (asked) quiet.delete(key);
  if (panelShows(getPanel(workspaceId), screen)) quiet.add(key);
  else if (!quiet.has(key) && floating.get(workspaceId) !== screen && (asked || !floating.has(workspaceId))) {
    floating.set(workspaceId, screen);
    change = true;
  }
  if (change) changed();
}

/** The agent stopped using `screen` (every screen, without one): its turn ended, or LIVE_MS passed. */
export function endUse(workspaceId: string, screen?: Screen): void {
  let change = false;
  for (const s of screen ? [screen] : (["browser", "computer"] as const)) {
    const key = at(workspaceId, s);
    if (!inUse.has(key)) continue;
    clearTimeout(inUse.get(key));
    inUse.delete(key);
    change = true;
  }
  if (change) changed();
}

/** The person closed the float, or the side panel took its place: it stays away until the agent asks to show the screen again. */
export function closeFloatingScreen(workspaceId: string): void {
  const screen = floating.get(workspaceId);
  if (!screen) return;
  quiet.add(at(workspaceId, screen));
  floating.delete(workspaceId);
  changed();
}

export function getFloatingScreen(workspaceId: string): Screen | null {
  return floating.get(workspaceId) ?? null;
}

export function useFloatingScreen(workspaceId: string): Screen | null {
  return useSyncExternalStore(subscribe, () => getFloatingScreen(workspaceId));
}

export function isInUse(workspaceId: string, screen: Screen): boolean {
  return inUse.has(at(workspaceId, screen));
}

/** The agent is using `screen` right now. */
export function useInUse(workspaceId: string, screen: Screen): boolean {
  return useSyncExternalStore(subscribe, () => isInUse(workspaceId, screen));
}

/** For tests. */
export function resetFloatingScreens(): void {
  floating.clear();
  quiet.clear();
  inUse.forEach((timer) => clearTimeout(timer));
  inUse.clear();
  changed();
}
