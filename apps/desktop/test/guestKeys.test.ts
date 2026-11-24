import { expect, test } from "vitest";
import { chordOfInput, forwardedChords, normalizeChord } from "../src/guestKeys.ts";

const down = (code: string, key: string, mods: Partial<{ meta: boolean; control: boolean; alt: boolean; shift: boolean }> = {}) => ({
  type: "keyDown",
  code,
  key,
  meta: false,
  control: false,
  alt: false,
  shift: false,
  ...mods,
});

test("a key press reads as the chord the app's keybindings write", () => {
  expect(chordOfInput(down("KeyK", "k", { meta: true }), true)).toBe("mod+k");
  expect(chordOfInput(down("KeyB", "B", { meta: true, shift: true }), true)).toBe("mod+shift+b");
  // ⌥ changes the key on a Mac ("∫"); the code does not.
  expect(chordOfInput(down("KeyB", "∫", { meta: true, alt: true }), true)).toBe("mod+alt+b");
  expect(chordOfInput(down("Backquote", "`", { control: true }), true)).toBe("ctrl+`");
  expect(chordOfInput(down("BracketLeft", "[", { meta: true }), true)).toBe("mod+[");
  expect(chordOfInput(down("Backslash", "|", { meta: true, shift: true }), true)).toBe("mod+shift+\\");
  // Off the Mac, mod is Ctrl.
  expect(chordOfInput(down("KeyK", "k", { control: true }), false)).toBe("mod+k");
  expect(chordOfInput({ ...down("KeyK", "k", { meta: true }), type: "keyUp" }, true)).toBeNull();
  expect(chordOfInput(down("MetaLeft", "Meta", { meta: true }), true)).toBeNull();
});

test("forwards the app's chords and the browser bar's, never typing", () => {
  const chords = forwardedChords(["mod+k", "mod+t", "shift+mod+B", "ctrl+`", "?", "shift+a", "", 7]);
  for (const c of ["mod+k", "mod+t", "mod+shift+b", "ctrl+`", "mod+l", "mod+[", "mod+]"]) expect(chords.has(c)).toBe(true);
  for (const c of ["?", "shift+a", "a", "mod+r"]) expect(chords.has(normalizeChord(c))).toBe(false);
  // The page sent nothing yet: the browser bar's chords still work.
  expect([...forwardedChords([])]).toEqual(["mod+l", "mod+[", "mod+]"]);
});
