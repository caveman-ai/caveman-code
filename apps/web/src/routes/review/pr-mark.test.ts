// A chat's pull request is one glyph in its state's colour; its number and state are its name, never visible words.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";
import { PrMark } from "./parts.tsx";

const mark = (state: "open" | "draft" | "merged" | "closed", projectId: string | null = "p1") =>
  renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PrMark, { pr: { number: 42, url: "https://github.com/o/r/pull/42", state }, projectId })));

test("a pull request shows its state's icon alone, named by number and state", () => {
  for (const [state, tone] of [
    ["open", "text-success"],
    ["draft", "text-muted-foreground"],
    ["merged", "text-foreground/75"],
    ["closed", "text-destructive"],
  ] as const) {
    const html = mark(state);
    expect(html.replace(/<[^>]*>/g, ""), state).toBe("");
    expect(html, state).toContain(`aria-label="Pull request #42, ${state}"`);
    expect(html, state).toContain(tone);
  }
});

test("only a mark it can open says so and reacts to the pointer", () => {
  expect(mark("open")).toContain("Click to review");
  // GitHub, never "the host".
  expect(mark("open")).toMatch(/-click to open on GitHub"/);
  expect(mark("open")).not.toContain("the host");
  expect(mark("open")).toContain("cursor-pointer");
  expect(mark("open", null)).not.toContain("Click to review");
  expect(mark("open", null)).not.toContain("cursor-pointer");
});
