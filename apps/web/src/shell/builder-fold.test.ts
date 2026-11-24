import { expect, test } from "vitest";
import { foldOpen, manyLine, opensForChild } from "./builder-fold.ts";

test("a chat's fold of agents starts shut, even with agents at work or asking", () => {
  expect(foldOpen({ choice: null, live: 0, viewingChild: false })).toBe(false);
  expect(foldOpen({ choice: null, live: 3, viewingChild: false })).toBe(false);
  expect(foldOpen({ choice: null, live: 12, viewingChild: false })).toBe(false);
});

test("one of its agents on screen opens it, unless many are live", () => {
  expect(foldOpen({ choice: null, live: 3, viewingChild: true })).toBe(true);
  expect(foldOpen({ choice: null, live: 12, viewingChild: true })).toBe(false);
});

test("the person's own open or shut holds over the default", () => {
  expect(foldOpen({ choice: true, live: 0, viewingChild: false })).toBe(true);
  expect(foldOpen({ choice: false, live: 3, viewingChild: true })).toBe(false);
  // An agent coming on screen opens it with a few live, never with many.
  expect(opensForChild(3, true)).toBe(true);
  expect(opensForChild(12, true)).toBe(false);
  expect(opensForChild(3, false)).toBe(false);
});

test("the shut fold's count line: how many agents, how many work, how many need the person", () => {
  expect(manyLine(12, 9, 0).join(" · ")).toBe("12 agents · 9 working");
  expect(manyLine(30, 24, 2).join(" · ")).toBe("30 agents · 24 working · 2 need you");
  expect(manyLine(8, 0, 1).join(" · ")).toBe("8 agents · 1 needs you");
});
