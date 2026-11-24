// Which pane a shortcut acts on: the one holding focus; else the one last pointed at or focused (focus on the body or
// the sidebar); else the first. The side panel's chords and the chat's ⌘F share it.

let lastPane: Element | null = null;
if (typeof document !== "undefined") {
  const note = (e: Event) => {
    const pane = (e.target as Element | null)?.closest?.("[data-pane]");
    if (pane) lastPane = pane;
  };
  document.addEventListener("focusin", note, true);
  document.addEventListener("pointerdown", note, true);
}

/** True when shortcuts go to the pane holding `el` (always, outside any pane). */
export function ownsFocus(el: HTMLElement | null): boolean {
  const pane = el?.closest("[data-pane]");
  if (!pane) return true;
  const inPane = document.activeElement?.closest("[data-pane]");
  if (inPane) return inPane === pane;
  // A pane kept rendered but hidden (a chat switched away from) never takes shortcuts.
  const shown = (p: Element | null) => p !== null && p.isConnected && p.checkVisibility();
  return (shown(lastPane) ? lastPane : [...document.querySelectorAll("[data-pane]")].find(shown)) === pane;
}
