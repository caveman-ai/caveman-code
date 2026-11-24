import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// A long work title once stretched the Chief's transcript sideways (white-space: nowrap with no limit).
test("a work chip truncates at the column's edge instead of widening it", () => {
  const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  const start = css.indexOf(".work-link {");
  const rule = css.slice(start, css.indexOf("}", start));
  for (const decl of [
    "display: inline-block;",
    "max-width: 100%;",
    "overflow: hidden;",
    "text-overflow: ellipsis;",
  ])
    expect(rule).toContain(decl);
  // The whole name stays on hover.
  expect(readFileSync(new URL("./refs.tsx", import.meta.url), "utf8")).toContain(
    "title={`${workId(prefix, item)",
  );
});
