// A pull request's line counts; where GitHub counted only part of the change, each reads as a floor.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { Stat } from "./parts.tsx";

const text = (html: string) => html.replace(/<[^>]*>/g, "");

test("a cut count reads as at least that many, and says why", () => {
  const html = renderToStaticMarkup(
    createElement(Stat, { additions: 12_000, deletions: 3400, atLeast: true }),
  );
  expect(text(html)).toBe("+12K+ −3.4K+");
  expect(html).toContain(
    'title="At least this many lines: GitHub counted only part of the change"',
  );
});

test("a whole count reads as itself", () => {
  const html = renderToStaticMarkup(createElement(Stat, { additions: 12_000, deletions: 3400 }));
  expect(text(html)).toBe("+12K −3.4K");
  expect(html).not.toContain("title=");
});
