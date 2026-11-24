// "?" anywhere outside a text field (Settings > Keyboard can rebind it), and
// ⌘K's "Keyboard shortcuts" row: every shortcut as it is bound now, plus the
// fixed composer and Chief keys the rebinding list leaves out.
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@caveman-app/ui/components/dialog";
import { useEffect, useState } from "react";
import { NavLink } from "react-router";
import { formatChord, IS_DESKTOP, isComposing, isTypingTarget, matchesChord } from "../panels/chrome.tsx";
import { chord, SHORTCUTS, useKeybindings, type ShortcutGroup } from "../state/keybindings.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";

const OPEN_EVENT = "caveman:shortcuts";

/** Opens the shortcut list from anywhere (⌘K's row, a menu). */
export const showShortcuts = () => window.dispatchEvent(new Event(OPEN_EVENT));

/**
 * Keys that are not rebound: the desktop menu's (New chat, Settings, Close; they never reach a page in a
 * browser tab, which keeps them for itself), the composer's and the Chief's.
 */
export function fixedShortcuts(sendWithMod: boolean, desktop: boolean = IS_DESKTOP): ReadonlyArray<{ title: string; rows: ReadonlyArray<{ label: string; keys: string }> }> {
  return [
    ...(desktop
      ? [
          {
            title: "Desktop app",
            rows: [
              { label: "New chat", keys: formatChord("mod+n") },
              { label: "Settings", keys: formatChord("mod+,") },
              { label: "Go to tab 1 to 8", keys: `${formatChord("mod+1")} to ${formatChord("mod+8")}` },
              { label: "Go to the last tab", keys: formatChord("mod+9") },
              { label: "Close the side panel's tab, the tab, then the window", keys: formatChord("mod+w") },
            ],
          },
        ]
      : []),
    {
      title: "Composer",
      rows: [
        { label: "Send", keys: formatChord(sendWithMod ? "mod+enter" : "enter") },
        { label: "New line", keys: formatChord(sendWithMod ? "enter" : "shift+enter") },
        { label: "Queue while the agent works", keys: formatChord(sendWithMod ? "mod+alt+enter" : "alt+enter") },
        { label: "Pick a favorite model (picker open)", keys: `${formatChord("mod+1")} to ${formatChord("mod+9")}` },
      ],
    },
    {
      title: "Chief",
      rows: [
        { label: "The Chief decides", keys: formatChord(sendWithMod ? "mod+enter" : "enter") },
        { label: "Queue it, no model call", keys: formatChord(sendWithMod ? "alt+mod+enter" : "alt+enter") },
        { label: "Start it now", keys: formatChord(sendWithMod ? "shift+mod+enter" : "mod+enter") },
        { label: "Walk the running chats", keys: "J  K" },
        { label: "Open the chat", keys: "O" },
        { label: "Back to the box", keys: "Esc" },
        { label: "Move a Queue item", keys: `${formatChord("alt+up")}  ${formatChord("alt+down")}` },
        { label: "Start a Queue item", keys: formatChord("mod+enter") },
        { label: "Drop a Queue item", keys: "E" },
      ],
    },
  ];
}

export function Keys({ children }: { children: string }) {
  return <kbd className="rounded border border-border bg-background px-1.5 font-mono text-[12px] leading-5 text-muted-foreground">{children}</kbd>;
}

export function ShortcutHelp() {
  const settings = useRuntimeSelector((v) => v.settings);
  const bound = useKeybindings();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || isComposing(e) || isTypingTarget(e.target) || !matchesChord(e, chord("app.shortcuts"))) return;
      e.preventDefault();
      setOpen((o) => !o);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);
  const groups: ReadonlyArray<{ title: string; rows: ReadonlyArray<{ label: string; keys: string }> }> = [
    ...(["App", ...(IS_DESKTOP ? (["Tabs"] as const) : []), "Panes"] as const satisfies ReadonlyArray<ShortcutGroup>).map((title) => ({
      title,
      rows: SHORTCUTS.filter((s) => s.group === title).map((s) => ({ label: s.label, keys: formatChord(bound[s.command] ?? s.key) })),
    })),
    ...fixedShortcuts(settings?.send_shortcut === "mod_enter"),
  ];
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press {formatChord(bound["app.shortcuts"] ?? "?")} again to close. Change them in{" "}
            <NavLink to="/settings/keyboard" onClick={() => setOpen(false)} className="underline underline-offset-2">
              Settings &gt; Keyboard
            </NavLink>
            . New here?{" "}
            {/* The browser has no Help menu: the tour's other way back (shell/Tour.tsx). */}
            <NavLink to="/tour" onClick={() => setOpen(false)} className="underline underline-offset-2">
              Show the tour
            </NavLink>
            . Something wrong?{" "}
            <NavLink to="/settings/reports" onClick={() => setOpen(false)} className="underline underline-offset-2">
              Report a problem
            </NavLink>
            .
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-x-8 gap-y-5">
          {groups.map((g) => (
            <section key={g.title}>
              <h3 className="pb-1 text-[12px] text-muted-foreground">{g.title}</h3>
              <ul>
                {g.rows.map((r) => (
                  <li key={r.label} className="flex h-8 items-center gap-3 text-[13px]">
                    <span className="min-w-0 flex-1 truncate">{r.label}</span>
                    <Keys>{r.keys}</Keys>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
