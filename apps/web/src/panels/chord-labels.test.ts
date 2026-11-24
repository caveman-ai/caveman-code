import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { fixedShortcuts } from "../shell/ShortcutHelp.tsx";
import { formatChord } from "./chrome.tsx";

test("a chord reads as the keyboard shows it: Mac glyphs in the Mac's order, words elsewhere", () => {
  expect(formatChord("mod+enter", true)).toBe("⌘↵");
  expect(formatChord("mod+enter", false)).toBe("Ctrl+Enter");
  expect(formatChord("mod+shift+b", true)).toBe("⇧⌘B");
  expect(formatChord("mod+shift+b", false)).toBe("Ctrl+Shift+B");
  expect(formatChord("mod+alt+]", true)).toBe("⌥⌘]");
  expect(formatChord("shift+mod+enter", true)).toBe("⇧⌘↵");
  expect(formatChord("alt+up", true)).toBe("⌥↑");
  expect(formatChord("mod++", true)).toBe("⌘+");
  expect(formatChord("ctrl+`", true)).toBe("⌃`");
  expect(formatChord("?", true)).toBe("?");
});

test("the shortcut list names the desktop menu's keys in the desktop app only", () => {
  const titles = (desktop: boolean) => fixedShortcuts(false, desktop).map((g) => g.title);
  expect(titles(true)).toContain("Desktop app");
  expect(titles(false)).not.toContain("Desktop app");
  const desktop = fixedShortcuts(false, true).find((g) => g.title === "Desktop app")!;
  expect(desktop.rows.map((r) => r.label)).toEqual(["New chat", "Settings", "Go to tab 1 to 8", "Go to the last tab", "Close the side panel's tab, the tab, then the window"]);
});

test("menus, tips and buttons name a key as bound and as this keyboard shows it, never a hardcoded ⌘", () => {
  // Each drew a Mac glyph whatever the platform, and kept it after Settings > Keyboard rebound the command.
  const files = ["../components/pane/PaneHeader.tsx", "../shell/Tour.tsx", "../routes/new-chat-bar.tsx", "../routes/Chief.tsx", "../shell/Sidebar.tsx", "../components/ProjectPicker.tsx", "../components/Composer.tsx"];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\*|\/\*|\{\/\*)/.test(line))
      .join("\n");
    expect(source, file).not.toMatch(/>⌘[^<]*<|"⌘[^"]*"|\["⌘/);
  }
});
