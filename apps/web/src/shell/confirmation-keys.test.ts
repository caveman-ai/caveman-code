import { expect, test } from "vitest";
import { IS_MAC } from "../lib/platform.ts";
import { heldByConfirmation, inConfirmation } from "./confirmation-keys.ts";

// No DOM here: a target is anything with closest(), as an Element has.
const inside = { closest: (s: string) => (s.includes("[data-confirmation]") ? {} : null) };
const outside = { closest: () => null };
const key = (
  target: unknown,
  k: string,
  code: string,
  mods: { mod?: boolean; shift?: boolean; alt?: boolean } = {},
) =>
  ({
    target,
    key: k,
    code,
    metaKey: IS_MAC && !!mods.mod,
    ctrlKey: !IS_MAC && !!mods.mod,
    shiftKey: !!mods.shift,
    altKey: !!mods.alt,
    isComposing: false,
    keyCode: 0,
    getModifierState: () => false,
  }) as unknown as KeyboardEvent;

test("inside a confirmation the app's chords are used up: a tab's ⌘1, New tab, the sidebar (T3's #27157)", () => {
  expect(inConfirmation(inside as never)).toBe(true);
  expect(inConfirmation(outside as never)).toBe(false);
  expect(inConfirmation(null)).toBe(false);
  expect(heldByConfirmation(key(inside, "1", "Digit1", { mod: true }))).toBe(true);
  expect(heldByConfirmation(key(inside, "t", "KeyT", { mod: true }))).toBe(true);
  expect(heldByConfirmation(key(inside, "b", "KeyB", { mod: true }))).toBe(true);
  expect(heldByConfirmation(key(inside, "d", "KeyD", { mod: true, shift: true }))).toBe(true);
});

test("the dialog's own keys, copy and the same chords outside a confirmation pass", () => {
  for (const [k, code] of [
    ["Enter", "Enter"],
    ["Escape", "Escape"],
    ["Tab", "Tab"],
    [" ", "Space"],
  ] as const)
    expect(heldByConfirmation(key(inside, k, code))).toBe(false);
  expect(heldByConfirmation(key(inside, "c", "KeyC", { mod: true }))).toBe(false);
  expect(heldByConfirmation(key(outside, "1", "Digit1", { mod: true }))).toBe(false);
  expect(heldByConfirmation(key(outside, "t", "KeyT", { mod: true }))).toBe(false);
  // Mid-composition nothing is a chord.
  expect(
    heldByConfirmation({
      ...key(inside, "t", "KeyT", { mod: true }),
      isComposing: true,
    } as KeyboardEvent),
  ).toBe(false);
});
