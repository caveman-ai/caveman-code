// A guide excerpt's L{start} opens its lines in Files: for an excerpt of removed lines, the removed lines, not
// whatever added line shares their number.
import { click, render } from "../dom.test-support.ts";
import type { PrGuideStop } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { expect, test } from "vitest";
import type { DiffFile } from "../../panels/diff/parsePatch.ts";
import { ExcerptView } from "./Excerpt.tsx";
import { partAt, partsOf, sectionsOf } from "./sections.ts";

// One file, two hunks: the first adds new lines 2-11, the second removes old lines 11-13 (new lines 20-21 there).
const PATH = "src/server.ts";
const file: DiffFile = {
  path: PATH,
  status: "modified",
  additions: 10,
  deletions: 3,
  patch: [
    "diff --git a/src/server.ts b/src/server.ts",
    "--- a/src/server.ts",
    "+++ b/src/server.ts",
    "@@ -1,2 +1,12 @@",
    " import { a } from './a';",
    ...Array.from({ length: 10 }, (_, i) => `+export const added${i + 2} = ${i + 2};`),
    " export const keep = 1;",
    "@@ -10,5 +20,2 @@",
    " function start() {",
    "-  legacyBoot();",
    "-  legacyWarmCache();",
    "-  legacyPing();",
    " }",
    "",
  ].join("\n"),
};
const stop = (title: string, excerpt: PrGuideStop["excerpts"][number]): PrGuideStop => ({
  title,
  summary: title,
  attention: null,
  excerpts: [excerpt],
  files: [],
  notes: [],
  questions: [],
});
const stops = [
  stop("Exports the new constants", { path: PATH, side: "new", start: 2, end: 11, caption: "" }),
  stop("Drops the legacy boot", { path: PATH, side: "old", start: 11, end: 13, caption: "" }),
];

test("L11 on an excerpt of removed lines opens removed line 11 in its stop's part, not added line 11", async () => {
  const opened: Array<[string, number | undefined, ("new" | "old") | undefined]> = [];
  const page = await render(
    createElement(ExcerptView, {
      excerpt: stops[1]!.excerpts[0]!,
      file,
      notes: [],
      loading: false,
      onOpenFile: (path: string, line?: number, side?: "new" | "old") =>
        void opened.push([path, line, side]),
    }),
  );
  const first = page.host.querySelector(`[data-path="${PATH}"][data-line="11"]`);
  expect(first?.getAttribute("data-side")).toBe("old");
  expect(first?.textContent).toContain("legacyBoot");

  await click(
    [...page.host.querySelectorAll("button")].find((b) => b.textContent?.includes("L11")),
  );

  expect(opened).toEqual([[PATH, 11, "old"]]);
  // Files' own lookup for that focus (Files.tsx): the part that holds the line, on the side it lives on.
  const [path, line, side] = opened[0]!;
  expect(partAt(partsOf(sectionsOf([file], stops)), path, line, side)?.key).toBe(`${PATH}#2`);
  await page.unmount();
});
