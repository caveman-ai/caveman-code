import { expect, test } from "vitest";
import { holds, type Switch } from "./hold.ts";

const base: Switch = {
  onScreen: true,
  current: "b",
  showing: "a",
  ready: false,
  waited: null,
  kept: ["b", "a"],
};

test("a switch to a chat still loading keeps the one on screen", () => {
  expect(holds(base)).toBe(true);
});

test("a chat whose history is in shows at once", () => {
  expect(holds({ ...base, ready: true })).toBe(false);
});

test("once the hold ran out for that chat, it shows with its loading line", () => {
  expect(holds({ ...base, waited: "b" })).toBe(false);
  // A hold that ran out for another chat holds this one as usual.
  expect(holds({ ...base, waited: "c" })).toBe(true);
});

test("a pane coming on screen (from the Chief, another tab) has nothing on screen to hold", () => {
  expect(holds({ ...base, onScreen: false })).toBe(false);
});

test("nothing to hold: the same chat, an empty pane, or a chat the pane no longer keeps", () => {
  expect(holds({ ...base, showing: "b" })).toBe(false);
  expect(holds({ ...base, showing: null })).toBe(false);
  expect(holds({ ...base, current: null })).toBe(false);
  expect(holds({ ...base, kept: ["b"] })).toBe(false);
});
