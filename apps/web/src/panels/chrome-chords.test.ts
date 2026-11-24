import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { ariaChord, matchesChord } from "./chrome.tsx";

test("aria-keyshortcuts names keys the way assistive tech reads them, never with the ⌘ glyphs", () => {
  expect(ariaChord("mod+k", true)).toBe("Meta+K");
  expect(ariaChord("mod+k", false)).toBe("Control+K");
  expect(ariaChord("mod+shift+b", true)).toBe("Meta+Shift+B");
  expect(ariaChord("ctrl+`", true)).toBe("Control+`");
  expect(ariaChord("mod+alt+]", false)).toBe("Control+Alt+]");
  expect(ariaChord("mod+space", true)).toBe("Meta+Space");
  expect(ariaChord("?", true)).toBe("?");
});

test("off the Mac, AltGr types characters and never fires a chord; Ctrl+Alt still does", () => {
  // AltGr reports Ctrl+Alt: "~" on a German keyboard is AltGr on the key where a US one has "]".
  const press = (over: Partial<KeyboardEvent>, altGraph: boolean) =>
    ({ key: "~", code: "BracketRight", metaKey: false, ctrlKey: true, altKey: true, shiftKey: false, getModifierState: (k: string) => altGraph && k === "AltGraph", ...over }) as KeyboardEvent;
  expect(matchesChord(press({}, true), "mod+alt+]", false)).toBe(false);
  expect(matchesChord(press({ key: "]" }, false), "mod+alt+]", false)).toBe(true);
  // A Mac's Option is not AltGr: ⌥⌘] fires whatever the event says.
  expect(matchesChord(press({ ctrlKey: false, metaKey: true, key: "‘" }, true), "mod+alt+]", true)).toBe(true);
});

test("the sidebar's Search button follows the bound chord, not a hardcoded ⌘K", () => {
  // Settings > Keyboard rebinds app.search; the button's tooltip and aria-keyshortcuts used to stay ⌘K / Meta+K.
  const sidebar = readFileSync(new URL("../shell/Sidebar.tsx", import.meta.url), "utf8");
  expect(sidebar).not.toContain('aria-keyshortcuts="Meta+K"');
  expect(sidebar).not.toContain('title="Search (⌘K)"');
  expect(sidebar).toContain("aria-keyshortcuts={ariaChord(searchChord)}");
});
