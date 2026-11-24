// The app's shortcuts wait while a confirmation is open (upstream #27157). Focus inside a ConfirmDialog
// ("Restore to this turn?", data-confirmation) and ⌘1 or ⌘T used to switch the tab under it, and a panel
// chord opened a panel behind it. The chord is used up there, as upstream dispatcher does: nothing runs, and the
// browser's own action for it (switching the browser's tab) doesn't either. Copy, paste and the dialog's own
// keys (Tab, Enter, Escape) are not app shortcuts and pass.
import { isComposing, matchesChord } from "../panels/chrome.tsx";
import { launcherSurfaces } from "../panels/registry.ts";
import { chord, SHORTCUTS } from "../state/keybindings.ts";
import { tabDigit } from "./tab-nav.ts";

type Target = { readonly closest?: (selector: string) => unknown } | null;

/** Focus (or the key's target) is inside a confirmation (packages/ui ConfirmDialog marks its content). */
export function inConfirmation(target: EventTarget | null): boolean {
  const el = target as Target;
  return typeof el?.closest === "function" && el.closest("[data-confirmation]") != null;
}

/** A chord the app runs: a bound shortcut, a tab's ⌘1..⌘9, or a side panel surface's own. */
export function isAppChord(e: KeyboardEvent): boolean {
  return (
    tabDigit(e) !== null ||
    SHORTCUTS.some((s) => matchesChord(e, chord(s.command))) ||
    launcherSurfaces().some((d) => d.chord !== undefined && matchesChord(e, d.chord))
  );
}

/** Whether this key press is an app shortcut pressed inside a confirmation, to be used up there. */
export function heldByConfirmation(e: KeyboardEvent): boolean {
  return !isComposing(e) && inConfirmation(e.target) && isAppChord(e);
}

let installed = false;

/** Once, before any other key listener (main.tsx): this capture listener runs first and stops the rest. */
export function installConfirmationKeys(win: Window = window): void {
  if (installed) return;
  installed = true;
  win.addEventListener(
    "keydown",
    (e) => {
      if (!heldByConfirmation(e)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
    },
    true,
  );
}
