// F6 / Shift+F6 between the workspace's areas, and Up/Down through the sidebar's rows (upstream #25877), on every
// screen: mounted above the shell and Settings, as ⌘K is. A browser may keep plain F6 for its own toolbar, so
// ⌘F6 / Ctrl+F6 (and with Shift) do the same. A dialog or menu keeps focus: F6 leaves it alone there.
import { useEffect } from "react";
import { isComposing, matchesChord } from "../panels/chrome.tsx";
import { chord, COMMAND_EVENT } from "../state/keybindings.ts";
import { moveFocusArea, moveSidebarRow, trackFocusAreas } from "./workspace-focus.ts";

const withMod = (c: string) => (c.startsWith("mod+") ? null : `mod+${c}`);
const hits = (e: KeyboardEvent, c: string) => matchesChord(e, c) || (withMod(c) !== null && matchesChord(e, withMod(c)!));
const held = () => document.activeElement?.closest('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]') != null;

export function WorkspaceFocus(): null {
  useEffect(() => {
    const untrack = trackFocusAreas();
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || isComposing(e)) return;
      const step = hits(e, chord("app.focusNextArea")) ? 1 : hits(e, chord("app.focusPreviousArea")) ? -1 : 0;
      if (step !== 0) {
        if (!held() && moveFocusArea(step)) e.preventDefault();
        return;
      }
      const row = e.target instanceof HTMLElement && e.target.matches("[data-sidebar-row]") ? e.target : null;
      const sidebar = row?.closest<HTMLElement>("[data-sidebar]");
      if (row && sidebar && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && moveSidebarRow(sidebar, row, e.key)) e.preventDefault();
    };
    // ⌘K's commands run the same moves.
    const onCommand = (e: Event) => {
      const command = (e as CustomEvent<string>).detail;
      if (command === "app.focusNextArea") moveFocusArea(1);
      else if (command === "app.focusPreviousArea") moveFocusArea(-1);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener(COMMAND_EVENT, onCommand);
    return () => {
      untrack();
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(COMMAND_EVENT, onCommand);
    };
  }, []);
  return null;
}
