// The app's shortcuts while a page in the side panel's browser has focus.
// Keys typed there go to the guest's own page and never reach the app's
// document, so ⌘K, ⌘T, ⌘⇧B, ⌘⌥B or the browser bar's ⌘L, ⌘[ and ⌘] did
// nothing once the person clicked into the page. Main stops the app's chords
// in the guest and replays them in the app's page, where its handlers run as
// for any key press (upstream forwards its keybindings from previews the same
// way: preview/Manager.ts setForwardedShortcuts). Every other key, bare keys
// included, stays the page's. Electron-free, so it tests without Electron.

/** The parts of Electron's Input (before-input-event) read here. */
export interface KeyInput {
  readonly type: string;
  readonly key: string;
  readonly code: string;
  readonly meta: boolean;
  readonly control: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

/**
 * The browser bar's own chords (apps/web panels/browser/BrowserBar.tsx CHORDS), minus reload. ⌘R and ⌘⇧R stay the
 * page's, and when it leaves them the View menu's Reload and Force Reload reload the page, not the app: those roles act
 * on the focused web contents, which Electron resolves to a focused <webview> (webContents.getFocusedWebContents).
 * Checked live on Electron 44.10.1.
 */
export const BROWSER_CHORDS = ["mod+l", "mod+[", "mod+]"] as const;

const MOD_KEYS = new Set(["Meta", "Control", "Alt", "Shift", "CapsLock", "Fn"]);
// As apps/web state/keybindings.ts: keys named by their place, so Alt and Shift never change them.
const CODE_KEYS: Readonly<Record<string, string>> = {
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Space: "space",
};
const MOD_ORDER = ["mod", "ctrl", "meta", "alt", "shift"];

const split = (chord: string): { mods: string[]; key: string } => {
  const parts = chord.toLowerCase().split("+");
  // "mod++": the key is "+".
  const key = chord.endsWith("++") ? (parts.splice(-2), "+") : parts.pop()!;
  return { mods: MOD_ORDER.filter((m) => parts.includes(m)), key };
};

/** "shift+mod+K" and "mod+shift+k" name the same chord. */
export function normalizeChord(chord: string): string {
  const { mods, key } = split(chord);
  return [...mods, key].join("+");
}

/** The chord a key press makes, as apps/web chordFromEvent writes it; null for a lone modifier or a key-up. */
export function chordOfInput(input: KeyInput, mac: boolean): string | null {
  if (input.type !== "keyDown" || MOD_KEYS.has(input.key)) return null;
  const key = /^Key[A-Z]$/.test(input.code)
    ? input.code.slice(3).toLowerCase()
    : /^Digit\d$/.test(input.code)
      ? input.code.slice(5)
      : (CODE_KEYS[input.code] ?? input.key.toLowerCase());
  const mods = [(mac ? input.meta : input.control) && "mod", mac && input.control && "ctrl", !mac && input.meta && "meta", input.alt && "alt", input.shift && "shift"];
  return normalizeChord([...mods.filter(Boolean), key].join("+"));
}

/**
 * The chords the app takes from a guest: the page's bound shortcuts and the browser bar's. Only chords with ⌘, Ctrl
 * or ⌥: a bare key or Shift+key (the app's "?") is typing, which stays the page's.
 */
export function forwardedChords(appChords: ReadonlyArray<unknown>): Set<string> {
  const chords = [...appChords.filter((c): c is string => typeof c === "string" && c.length > 0), ...BROWSER_CHORDS];
  return new Set(chords.filter((c) => split(c).mods.some((m) => m !== "shift")).map(normalizeChord));
}
