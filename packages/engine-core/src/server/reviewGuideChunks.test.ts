import { describe, expect, it } from "vitest";

import {
  chunkExcerpt,
  chunkQuoteLine,
  renderReviewGuideChunks,
  resolveChunkStop,
  reviewGuideChunks,
} from "./reviewGuideChunks.ts";
import { reviewGuideFromChunkReply } from "./textGenerationOperations.ts";

const context = (count: number, from = 0) =>
  Array.from({ length: count }, (_, index) => ` keep ${from + index}`);

// One hunk at line 100: 21 context, 2 added, a blank context line, 6 context, 1 removed, 2 context.
const LONG = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -100,30 +100,31 @@ function a() {",
  ...context(21),
  "+  const added = 1;",
  "+  return added;",
  " ",
  ...context(6, 21),
  "-  gone();",
  ...context(2, 27),
  // A second hunk with no change in its chunk after the split is dropped.
  "@@ -200,2 +201,2 @@",
  ...context(2, 40),
].join("\n");

const DELETED = [
  "diff --git a/old.ts b/old.ts",
  "deleted file mode 100644",
  "--- a/old.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const old = 1;",
  "-export const older = 2;",
  "\\ No newline at end of file",
  "",
].join("\n");

describe("reviewGuideChunks", () => {
  it("splits a hunk after a blank context line once it has 24 lines, keeps only changes", () => {
    const chunks = reviewGuideChunks(LONG + "\n" + DELETED);
    expect(chunks.map((chunk) => [chunk.id, chunk.path, chunk.lines.length])).toEqual([
      ["C1", "src/a.ts", 24],
      ["C2", "src/a.ts", 9],
      ["C3", "old.ts", 2],
    ]);
    expect(chunks[0]!.lines[21]).toEqual({ text: "+  const added = 1;", old: null, new: 121 });
    expect(chunks[0]!.lines.at(-1)).toEqual({ text: " ", old: 121, new: 123 });
    expect(chunks[1]!.lines[6]).toEqual({ text: "-  gone();", old: 128, new: null });
    expect(chunks[2]!.lines).toEqual([
      { text: "-export const old = 1;", old: 1, new: null },
      { text: "-export const older = 2;", old: 2, new: null },
    ]);
  });

  it("keeps a short hunk whole and reads `--- ` inside a hunk as a removed line", () => {
    const chunks = reviewGuideChunks(
      ["diff --git a/b.md b/b.md", "--- a/b.md", "+++ b/b.md", "@@ -1,2 +1,2 @@", " ", "--- old rule", "+++ new rule", " "].join("\n"),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.lines.map((line) => [line.old, line.new])).toEqual([
      [1, 1],
      [2, null],
      [null, 2],
      [3, 3],
    ]);
  });

  it("heads each chunk with its path and range, old for an all-deletion chunk", () => {
    const rendered = renderReviewGuideChunks(reviewGuideChunks(LONG + "\n" + DELETED));
    expect(rendered).toContain("[C1] src/a.ts (new 100-123)\n keep 0\n");
    expect(rendered).toContain("\n\n[C3] old.ts (old 1-2)\n-export const old = 1;\n-export const older = 2;");
    expect(rendered).not.toMatch(/^\s*\d+\s+\d+ /m);
  });
});

describe("chunk citations", () => {
  const [c1, c2, c3] = reviewGuideChunks(LONG + "\n" + DELETED);

  it("maps a chunk to its changed lines padded by two context lines inside it", () => {
    expect(chunkExcerpt(c1!, "the return")).toEqual({
      path: "src/a.ts",
      side: "new",
      start: 119,
      end: 123,
      caption: "the return",
    });
    // An all-deletion chunk shows the old side; padding stops at the chunk's edge.
    expect(chunkExcerpt(c2!, "")).toMatchObject({ side: "old", start: 126, end: 130 });
    expect(chunkExcerpt(c3!, "")).toMatchObject({ path: "old.ts", side: "old", start: 1, end: 2 });
  });

  it("finds the quoted line, whitespace-normalized, a changed line before context", () => {
    expect(chunkQuoteLine(c1!, "return   added")).toBe(122);
    expect(chunkQuoteLine(c1!, "keep 1")).toBe(101);
    expect(chunkQuoteLine(c3!, "older = 2")).toBe(2);
    expect(chunkQuoteLine(c1!, "not in the chunk")).toBeNull();
    expect(chunkQuoteLine(c1!, "  ")).toBeNull();
  });

  it("keeps an unknown id as an excerpt that lands nowhere, drops quotes no line holds, and tolerates [C2] and c2", () => {
    const stop = resolveChunkStop(
      {
        title: "t",
        chunks: [
          { id: "C1", caption: "a" },
          { id: "C9", caption: "unknown" },
          { id: "[C2]", caption: "b" },
        ],
        notes: [
          { chunk: "c1", quote: "const added = 1", title: "why", body: "b" },
          { chunk: "C1", quote: "made up", title: "dropped", body: "b" },
          { chunk: "C7", quote: "keep", title: "dropped", body: "b" },
        ],
      },
      [c1!, c2!, c3!],
    );
    expect(stop).toEqual({
      title: "t",
      excerpts: [
        { path: "src/a.ts", side: "new", start: 119, end: 123, caption: "a" },
        { path: "?C9", side: "new", start: 1, end: 1, caption: "unknown" },
        { path: "src/a.ts", side: "old", start: 126, end: 130, caption: "b" },
      ],
      notes: [{ path: "src/a.ts", line: 121, title: "why", body: "b" }],
    });
  });

  it("turns a single pass's reply into a guide", () => {
    const guide = reviewGuideFromChunkReply(
      {
        tldr: "t",
        overview: "what: a\nwhy: b",
        before_after: { title: "x", rows: [{ op: "+", depth: 0, text: "y", stop: null }] },
        stops: [
          {
            title: "Add it",
            summary: "before: a\nafter: b\nwhy: c",
            attention: null,
            chunks: [{ id: "C3", caption: "" }],
            files: [],
            notes: [],
            questions: [],
          },
        ],
      },
      [c1!, c2!, c3!],
    );
    expect(guide.beforeAfter?.rows).toEqual([{ op: "+", depth: 0, text: "y" }]);
    expect(guide.stops[0]?.excerpts).toEqual([
      { path: "old.ts", side: "old", start: 1, end: 2, caption: "" },
    ]);
  });
});
