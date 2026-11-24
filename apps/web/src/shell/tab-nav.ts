// Going between the window's tabs (panes/store.ts windowTabs): a change answers the route to show, and this goes there.
import { useCallback } from "react";
import { useNavigate } from "react-router";
import { IS_DESKTOP } from "../panels/chrome.tsx";
import { IS_MAC } from "../lib/platform.ts";

/**
 * Shows the route a tab change answered (null: nothing to do). It replaces the history entry: Back stays inside the
 * tab in front instead of walking into another one.
 */
export function useTabNav(): (path: string | null) => void {
  const navigate = useNavigate();
  return useCallback((path: string | null) => void (path !== null && navigate(path, { replace: true })), [navigate]);
}

/** ⌘-click (Ctrl-click off the Mac) or a middle click: open it in a new tab. Tabs are the desktop app's; a browser keeps its own. */
export function wantsNewTab(e: { readonly button: number; readonly metaKey: boolean; readonly ctrlKey: boolean }): boolean {
  return IS_DESKTOP && (e.button === 1 || (e.button === 0 && (IS_MAC ? e.metaKey : e.ctrlKey)));
}

/** ⌘1..⌘9 (Ctrl off the Mac) with no other modifier: the tab's place, or null. Fixed keys, as in a browser. */
export function tabDigit(e: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean = IS_MAC): number | null {
  if (e.altKey || e.shiftKey || (mac ? !e.metaKey || e.ctrlKey : !e.ctrlKey || e.metaKey)) return null;
  const m = /^Digit([1-9])$/.exec(e.code);
  return m ? Number(m[1]) : null;
}

/** The number ⌘ shows on a tab: its place for the first eight, 9 for the last; none for the ones between. */
export function tabNumber(index: number, count: number): number | null {
  if (index === count - 1) return Math.min(9, count);
  return index < 8 ? index + 1 : null;
}
