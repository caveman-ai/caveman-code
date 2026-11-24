import { expect, test } from "vitest";
import { typesCharacter } from "./type-to-focus.ts";

const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "isComposing", boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...mods });

test("a printable key types into the box; chords, named keys, space and IME composition don't", () => {
  expect(typesCharacter(key("h"))).toBe(true);
  expect(typesCharacter(key("H"))).toBe(true);
  expect(typesCharacter(key("/"))).toBe(true);
  expect(typesCharacter(key("k", { metaKey: true }))).toBe(false);
  expect(typesCharacter(key("c", { ctrlKey: true }))).toBe(false);
  expect(typesCharacter(key("∂", { altKey: true }))).toBe(false);
  expect(typesCharacter(key("Enter"))).toBe(false);
  expect(typesCharacter(key("ArrowUp"))).toBe(false);
  // Space scrolls the transcript.
  expect(typesCharacter(key(" "))).toBe(false);
  expect(typesCharacter(key("a", { isComposing: true }))).toBe(false);
});
