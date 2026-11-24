import { describe, expect, it } from "vitest";
import { IS_MAC, matchesChord } from "../panels/chrome.tsx";
import { chord, chordFromEvent, setKeybindings, shortcutError } from "./keybindings.ts";

const key = (init: Partial<KeyboardEvent>) => ({ key: "", code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init }) as KeyboardEvent;

describe("chordFromEvent", () => {
  it("names keys by their place, so Alt and Shift never garble them", () => {
    expect(chordFromEvent(key({ key: "‘", code: "BracketRight", metaKey: true, altKey: true }), true)).toBe("mod+alt+]");
    expect(chordFromEvent(key({ key: "|", code: "Backslash", ctrlKey: true, shiftKey: true }), false)).toBe("mod+shift+\\");
    expect(chordFromEvent(key({ key: "∫", code: "KeyB", metaKey: true, altKey: true }), true)).toBe("mod+alt+b");
    expect(chordFromEvent(key({ key: "`", code: "Backquote", ctrlKey: true }), true)).toBe("ctrl+`");
    expect(chordFromEvent(key({ key: "Meta", code: "MetaLeft", metaKey: true }), true)).toBeNull();
  });
});

// "mod" is ⌘ on a Mac and Ctrl elsewhere: the test runs on both.
const mod = IS_MAC ? { metaKey: true } : { ctrlKey: true };

describe("matchesChord", () => {
  it("matches punctuation by code and ? however it is typed", () => {
    expect(matchesChord(key({ key: "|", code: "Backslash", ...mod, shiftKey: true }), "mod+shift+\\")).toBe(true);
    expect(matchesChord(key({ key: "\\", code: "Backslash", ...mod }), "mod+shift+\\")).toBe(false);
    expect(matchesChord(key({ key: "‘", code: "BracketRight", ...mod, altKey: true }), "mod+alt+]")).toBe(true);
    expect(matchesChord(key({ key: "?", code: "Slash", shiftKey: true }), "?")).toBe(true);
    expect(matchesChord(key({ key: "?", code: "Slash", shiftKey: true, ctrlKey: true }), "?")).toBe(false);
  });
});

describe("setKeybindings", () => {
  it("takes the runtime's keys over the defaults and ignores commands it does not know", () => {
    setKeybindings([{ command: "app.terminal", key: "mod+j" }, { command: "terminal.toggle", key: "mod+y" }]);
    expect(chord("app.terminal")).toBe("mod+j");
    expect(chord("app.search")).toBe("mod+k");
    setKeybindings([]);
    expect(chord("app.terminal")).toBe("ctrl+`");
  });
});

describe("the runtime's refusals, in the person's words", () => {
  const glyphs = (chord: string) => `<${chord}>`;
  it("names commands by their labels and draws the chord the way the keyboard shows it", () => {
    expect(shortcutError("mod+t already runs app.newTab", glyphs)).toBe("<mod+t> already runs New tab");
    expect(shortcutError("mod+p already runs app.openFile", glyphs)).toBe("<mod+p> already runs Open anything in the side panel");
    expect(shortcutError("mod+1 goes to tab 1; pick another", glyphs)).toBe("<mod+1> goes to tab 1; pick another");
    expect(shortcutError("? already runs app.shortcuts", glyphs)).toBe("<?> already runs Keyboard shortcuts");
    // Anything else stays as written.
    expect(shortcutError("mod+shift is not a key", glyphs)).toBe("<mod+shift> is not a key");
    expect(shortcutError("this runtime keeps no keyboard shortcuts", glyphs)).toBe("this runtime keeps no keyboard shortcuts");
  });
});

describe("the chat's own chords", () => {
  it("find, the model picker and the permissions picker have T3's keys, and no two commands share one", async () => {
    const { SHORTCUTS, defaultChord } = await import("./keybindings.ts");
    expect(defaultChord("app.findInChat")).toBe("mod+f");
    expect(defaultChord("app.pickModel")).toBe("mod+shift+m");
    expect(defaultChord("app.pickPermissions")).toBe("mod+shift+a");
    expect(new Set(SHORTCUTS.map((s) => s.key)).size).toBe(SHORTCUTS.length);
  });
});

describe("Settings > Keyboard and the runtime", () => {
  // The runtime stores every rebind and refuses a command it does not know, so a row missing there can never change.
  it("list the same app commands with the same defaults", async () => {
    const { SHORTCUTS } = await import("./keybindings.ts");
    const { DEFAULT_KEYBINDINGS } = await import("@caveman-app/shared/keybindings");
    const runtime = DEFAULT_KEYBINDINGS.filter((rule) => rule.command.startsWith("app.")).map(({ command, key }) => [command, key]);
    expect(Object.fromEntries(SHORTCUTS.map((s) => [s.command, s.key]))).toEqual(Object.fromEntries(runtime));
  });
});

describe("a side-panel browser page", () => {
  it("keeps its own ⌘F and the chat's picker keys; the app's other chords come back to the app", async () => {
    const { guestChords } = await import("./keybindings.ts");
    const chords = guestChords({ "app.search": "mod+k", "app.findInChat": "mod+f", "app.pickModel": "mod+shift+m", "app.pickPermissions": "mod+shift+a", "app.newTab": "mod+t" });
    expect(chords).toEqual(["mod+k", "mod+t"]);
  });
});
