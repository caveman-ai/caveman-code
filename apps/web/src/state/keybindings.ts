// Settings > Keyboard: the app's shortcuts. Each command has a default here
// (the same as the runtime's DEFAULT_KEYBINDINGS); the runtime's
// keybindings.get answers with the user's own, which take over. Chords are
// "mod+shift+b" strings: mod is ⌘ on a Mac and Ctrl elsewhere (chrome.tsx).
import type { Client } from "@caveman-app/session-protocol/client";
import { useEffect, useSyncExternalStore } from "react";
import { useRuntimeClient } from "./runtime.tsx";

export type ShortcutGroup = "App" | "Tabs" | "Panes";

export const SHORTCUTS = [
  { command: "app.search", label: "Search and go to", group: "App", key: "mod+k" },
  { command: "app.findInChat", label: "Find in chat", group: "App", key: "mod+f" },
  { command: "app.openFile", label: "Open anything in the side panel", group: "App", key: "mod+p" },
  { command: "app.toggleSidebar", label: "Show or hide the sidebar", group: "App", key: "mod+b" },
  { command: "app.sidePanel", label: "Show or hide the side panel", group: "App", key: "mod+alt+b" },
  { command: "app.browser", label: "Browser", group: "App", key: "mod+shift+b" },
  { command: "app.terminal", label: "Terminal", group: "App", key: "ctrl+`" },
  { command: "app.changes", label: "Changes", group: "App", key: "ctrl+shift+g" },
  { command: "app.shortcuts", label: "Keyboard shortcuts", group: "App", key: "?" },
  { command: "app.increaseEffort", label: "Raise effort one step", group: "App", key: "mod+shift+." },
  { command: "app.decreaseEffort", label: "Lower effort one step", group: "App", key: "mod+shift+," },
  { command: "app.toggleSpeed", label: "Next speed (Fast, Ultrafast)", group: "App", key: "mod+shift+f" },
  { command: "app.pickModel", label: "Pick the chat's model", group: "App", key: "mod+shift+m" },
  { command: "app.pickPermissions", label: "Pick the chat's permissions", group: "App", key: "mod+shift+a" },
  { command: "app.dictate", label: "Talk to type", group: "App", key: "mod+shift+space" },
 // upstream #25877: the sidebar, each pane's conversation and box, the side panel; with ⌘ (Ctrl) in a browser too.
  { command: "app.focusNextArea", label: "Move to the next area", group: "App", key: "f6" },
  { command: "app.focusPreviousArea", label: "Move to the previous area", group: "App", key: "shift+f6" },
  { command: "app.newTab", label: "New tab", group: "Tabs", key: "mod+t" },
  { command: "app.nextTab", label: "Next tab", group: "Tabs", key: "ctrl+tab" },
  { command: "app.previousTab", label: "Previous tab", group: "Tabs", key: "ctrl+shift+tab" },
  { command: "app.reopenTab", label: "Reopen closed tab", group: "Tabs", key: "mod+shift+t" },
  { command: "app.back", label: "Back in this tab", group: "Tabs", key: "mod+[" },
  { command: "app.forward", label: "Forward in this tab", group: "Tabs", key: "mod+]" },
  { command: "app.splitRight", label: "Split right", group: "Panes", key: "mod+d" },
  { command: "app.splitDown", label: "Split down", group: "Panes", key: "mod+shift+d" },
  { command: "app.nextPane", label: "Next pane", group: "Panes", key: "mod+alt+]" },
  { command: "app.previousPane", label: "Previous pane", group: "Panes", key: "mod+alt+[" },
  { command: "app.closePane", label: "Close pane", group: "Panes", key: "mod+alt+w" },
  { command: "app.zoomPane", label: "Zoom pane to fill the tab, or back", group: "Panes", key: "mod+alt+f" },
  { command: "app.equalizePanes", label: "Make every pane the same size", group: "Panes", key: "mod+alt+=" },
  { command: "app.focusPaneLeft", label: "Focus the pane to the left", group: "Panes", key: "mod+alt+arrowleft" },
  { command: "app.focusPaneRight", label: "Focus the pane to the right", group: "Panes", key: "mod+alt+arrowright" },
  { command: "app.focusPaneUp", label: "Focus the pane above", group: "Panes", key: "mod+alt+arrowup" },
  { command: "app.focusPaneDown", label: "Focus the pane below", group: "Panes", key: "mod+alt+arrowdown" },
] as const satisfies ReadonlyArray<{ command: string; label: string; group: ShortcutGroup; key: string }>;

export type ShortcutCommand = (typeof SHORTCUTS)[number]["command"];

/**
 * The runtime's refusal in the person's words: "mod+t already runs app.newTab" reads "⌘T already runs
 * Open anything in the side panel"; `format` draws a chord as the keyboard shows it (chrome.tsx formatChord).
 */
export function shortcutError(message: string, format: (chord: string) => string): string {
  const named = message.replace(/\bapp\.[A-Za-z]+\b/g, (id) => SHORTCUTS.find((s) => s.command === id)?.label ?? id);
  const space = named.indexOf(" ");
  const head = space < 0 ? named : named.slice(0, space);
  // A leading chord ("mod+1", "ctrl+`", "?"): the runtime's canonical form, never a word.
  return /^[a-z]+\+.+$|^[^\sA-Za-z0-9]$/.test(head) ? `${format(head)}${named.slice(head.length)}` : named;
}

/** Runs an app command as if its key were pressed: the composer's /resume runs app.search. */
export const COMMAND_EVENT = "caveman:command";
export const runShortcut = (command: ShortcutCommand) => window.dispatchEvent(new CustomEvent<ShortcutCommand>(COMMAND_EVENT, { detail: command }));

const DEFAULTS: Readonly<Record<string, string>> = Object.fromEntries(SHORTCUTS.map((s) => [s.command, s.key]));
let bound: Readonly<Record<string, string>> = DEFAULTS;
const listeners = new Set<() => void>();

/** The command's chord now: the user's, or its default. */
export function chord(command: ShortcutCommand): string {
  return bound[command] ?? DEFAULTS[command]!;
}

export function defaultChord(command: ShortcutCommand): string {
  return DEFAULTS[command]!;
}

/** Takes the runtime's list; commands it leaves out keep their defaults. */
export function setKeybindings(list: ReadonlyArray<{ readonly command: string; readonly key: string }>): void {
  bound = { ...DEFAULTS, ...Object.fromEntries(list.filter((k) => k.command in DEFAULTS).map((k) => [k.command, k.key])) };
  listeners.forEach((l) => l());
}

/** Reads the runtime's shortcuts; a runtime from before keybindings.* keeps the defaults. */
export function loadKeybindings(client: Client): Promise<void> {
  return client.call("keybindings.get", {}).then(
    (r) => setKeybindings(r.keybindings),
    () => undefined,
  );
}

export function useKeybindings(): Readonly<Record<string, string>> {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => bound,
  );
}

const MOD_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"]);
/** Keys named by their place on the keyboard, so Alt and Shift never change them ("mod+alt+]" gives "‘" on a Mac). */
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`", Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]", Backslash: "\\",
  Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/", Space: "space",
};

/** The chord a key press makes, for rebinding; null for a lone modifier. */
export function chordFromEvent(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">, mac: boolean): string | null {
  if (MOD_KEYS.has(e.key)) return null;
  const key = /^Key[A-Z]$/.test(e.code) ? e.code.slice(3).toLowerCase() : /^Digit\d$/.test(e.code) ? e.code.slice(5) : (CODE_KEYS[e.code] ?? e.key.toLowerCase());
  const mods = [
    (mac ? e.metaKey : e.ctrlKey) && "mod",
    mac && e.ctrlKey && "ctrl",
    !mac && e.metaKey && "meta",
    e.altKey && "alt",
    e.shiftKey && "shift",
  ].filter(Boolean);
  return [...mods, key].join("+");
}

/**
 * Commands that act on the chat in front of you: in a side-panel browser page their keys stay the page's (a site's own
 * ⌘F find), since the chat isn't what has focus there.
 */
const CHAT_ONLY: ReadonlySet<string> = new Set(["app.findInChat", "app.pickModel", "app.pickPermissions", "app.dictate"]);

/** The chords a side-panel browser page hands back to the app. */
export function guestChords(bound: Readonly<Record<string, string>>): string[] {
  return Object.entries(bound).flatMap(([command, key]) => (CHAT_ONLY.has(command) ? [] : [key]));
}

/** ⌘1..⌘9, the tabs' fixed keys: a side-panel browser page hands them back too. */
const TAB_DIGITS = Array.from({ length: 9 }, (_, i) => `mod+${i + 1}`);

/** Mounted once: the runtime's shortcuts on every (re)connect, and the desktop told which chords are the app's. */
export function KeybindingsSync(): null {
  const { client, connection } = useRuntimeClient();
  useEffect(() => {
    if (client) void loadKeybindings(client);
  }, [client, connection]);
  // A side-panel browser page keeps its keys except these, which come back here (apps/desktop src/guestKeys.ts).
  const keys = useKeybindings();
  useEffect(() => window.cavemanDesktop?.setGuestShortcuts?.([...guestChords(keys), ...TAB_DIGITS]), [keys]);
  return null;
}
