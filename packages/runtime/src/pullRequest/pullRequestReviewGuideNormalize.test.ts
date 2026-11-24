// ), apps/server/src/pullRequest/pullRequestReviewGuideNormalize.test.ts @ ab3a3cd1.
import { describe, expect, it } from "vitest";
import type { PullRequestReviewGuideStop } from "@caveman-app/protocol";
import type { ReviewGuideGenerationResult } from "@caveman-app/engine-core/server/textGeneration";

import { normalizeReviewGuide, parseReviewGuideChange } from "./pullRequestReviewGuideNormalize.ts";

// `git diff --unified=0` of: src/a.ts with lines 10-14 and 40-59 added and an old line 30
// removed; src/gone.ts deleted (old lines 1-20); docs/readme.md with line 3 added.
const patch = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -9,0 +10,5 @@ export const x = 1;",
  "+added",
  "@@ -30 +34,0 @@ function y() {",
  "-removed",
  "@@ -35,0 +40,20 @@",
  "+added",
  "diff --git a/src/gone.ts b/src/gone.ts",
  "deleted file mode 100644",
  "--- a/src/gone.ts",
  "+++ /dev/null",
  "@@ -1,20 +0,0 @@",
  "-removed",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -2,0 +3 @@",
  "+added",
  "",
].join("\n");
const change = parseReviewGuideChange("src/a.ts\0src/gone.ts\0docs/readme.md\0", patch);

const stop = (overrides: Partial<PullRequestReviewGuideStop>): PullRequestReviewGuideStop => ({
  title: "Stop",
  summary: "",
  attention: null,
  excerpts: [],
  files: [],
  notes: [],
  questions: [],
  ...overrides,
});

const guide = (overrides: Partial<ReviewGuideGenerationResult>): ReviewGuideGenerationResult => ({
  stops: [],
  ...overrides,
});

const excerpt = (path: string, start: number, end: number, side: "new" | "old" = "new") => ({
  path,
  side,
  start,
  end,
  caption: "",
});

describe("parseReviewGuideChange", () => {
  it("reads a removed or added line that looks like a file header as a source line", () => {
    const tricky = [
      "diff --git a/notes.md b/notes.md",
      "--- a/notes.md",
      "+++ b/notes.md",
      "@@ -3,1 +3,2 @@",
      "--- a/old-heading",
      "+++ b/other.ts",
      "+tail",
      "@@ -9,0 +10,1 @@",
      "+later",
      "",
    ].join("\n");
    const parsed = parseReviewGuideChange("notes.md\0", tricky);
    expect([...parsed.hunks.keys()]).toEqual(["notes.md"]);
    expect(parsed.hunks.get("notes.md")).toEqual({
      new: [
        { start: 3, end: 4 },
        { start: 10, end: 10 },
      ],
      old: [{ start: 3, end: 3 }],
    });
  });

  it("reads each side's hunks, keying a deleted file by its old path", () => {
    expect(change.files).toEqual(["src/a.ts", "src/gone.ts", "docs/readme.md"]);
    expect(change.hunks.get("src/a.ts")).toEqual({
      new: [
        { start: 10, end: 14 },
        { start: 40, end: 59 },
      ],
      old: [{ start: 30, end: 30 }],
    });
    expect(change.hunks.get("src/gone.ts")).toEqual({ new: [], old: [{ start: 1, end: 20 }] });
    expect(change.hunks.get("docs/readme.md")).toEqual({ new: [{ start: 3, end: 3 }], old: [] });
  });

  it("reads file names git quotes or ends with a tab", () => {
    const unusual = [
      "diff --git a/with space.txt b/with space.txt",
      "--- a/with space.txt\t",
      "+++ b/with space.txt\t",
      "@@ -1,0 +2 @@",
      'diff --git "a/tab\\tname.txt" "b/tab\\tname.txt"',
      '--- "a/tab\\tname.txt"',
      '+++ "b/tab\\tname.txt"',
      "@@ -1,0 +2 @@",
      'diff --git "a/back\\\\slash.txt" "b/back\\\\slash.txt"',
      '--- "a/back\\\\slash.txt"',
      '+++ "b/back\\\\slash.txt"',
      "@@ -1,0 +2 @@",
      'diff --git "a/gone\\tfile.txt" "b/gone\\tfile.txt"',
      '--- "a/gone\\tfile.txt"',
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "",
    ].join("\n");
    const names = ["with space.txt", "tab\tname.txt", "back\\slash.txt", "gone\tfile.txt"];
    const parsed = parseReviewGuideChange(names.join("\0"), unusual);
    expect([...parsed.hunks.keys()]).toEqual(names);
    expect(parsed.hunks.get("gone\tfile.txt")).toEqual({ new: [], old: [{ start: 1, end: 1 }] });
    const result = normalizeReviewGuide(
      guide({ stops: [stop({ excerpts: names.slice(0, 3).map((path) => excerpt(path, 1, 5)) })] }),
      parsed,
    );
    expect(result.stops[0]?.excerpts).toEqual(names.slice(0, 3).map((path) => excerpt(path, 2, 2)));
  });
});

describe("normalizeReviewGuide", () => {
  it("clamps excerpts to changed lines, merges touching ones, and caps their length", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [
              // Starts on context before the hunk: clamped to the hunk.
              excerpt("src/a.ts", 5, 12),
              // Touches the previous one once clamped: merged.
              excerpt("src/a.ts", 13, 14),
              // Spans the whole second hunk and beyond: clamped to it.
              excerpt("src/a.ts", 38, 80),
              // On no changed line: dropped.
              excerpt("src/a.ts", 20, 25),
              // Removed code shown from the old side.
              excerpt("src/gone.ts", 2, 8, "old"),
            ],
            files: [{ path: "docs/readme.md", note: "" }],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([
      excerpt("src/a.ts", 10, 14),
      excerpt("src/a.ts", 40, 59),
      excerpt("src/gone.ts", 2, 8, "old"),
    ]);
    expect(result.stops[0]?.files).toEqual([{ path: "docs/readme.md" }]);
    expect(result.stops).toHaveLength(1);
  });

  it("keeps a long excerpt to its first 25 lines", () => {
    const long = parseReviewGuideChange(
      "big.ts\0",
      "--- a/big.ts\n+++ b/big.ts\n@@ -0,0 +1,100 @@\n",
    );
    const result = normalizeReviewGuide(
      guide({ stops: [stop({ excerpts: [excerpt("big.ts", 1, 100)] })] }),
      long,
    );
    expect(result.stops[0]?.excerpts).toEqual([excerpt("big.ts", 1, 25)]);
  });

  it("merges excerpts that a later excerpt bridges into one", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [
              excerpt("src/a.ts", 40, 41),
              { ...excerpt("src/a.ts", 50, 51), caption: "Second" },
              excerpt("src/a.ts", 41, 50),
            ],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([
      { ...excerpt("src/a.ts", 40, 51), caption: "Second" },
    ]);

    const tailNote = { path: "src/a.ts", line: 40, title: "Tail", body: "Keep this note." };
    const wide = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [
              excerpt("src/a.ts", 1, 25),
              { ...excerpt("src/a.ts", 30, 45), caption: "Second" },
              excerpt("src/a.ts", 24, 32),
            ],
            notes: [tailNote],
          }),
        ],
      }),
      parseReviewGuideChange(
        "src/a.ts\0",
        "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -0,0 +1,60 @@\n+added",
      ),
    );
    expect(wide.stops[0]?.excerpts).toEqual([{ ...excerpt("src/a.ts", 1, 25), caption: "Second" }]);
    expect(wide.stops[0]?.notes).toEqual([]);
  });

  it("drops notes outside the stop's remaining excerpts", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [excerpt("src/a.ts", 5, 12)],
            notes: [
              { path: "src/a.ts", line: 11, title: "Inside", body: "" },
              { path: "src/a.ts", line: 6, title: "Clamped away", body: "" },
              { path: "src/other.ts", line: 11, title: "Other file", body: "" },
            ],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.notes.map((note) => note.title)).toEqual(["Inside"]);
  });

  it("drops excerpts and files outside the change", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            excerpts: [excerpt("src/unchanged.ts", 1, 5)],
            files: [{ path: "src/a.ts", note: "edited" }, { path: "src/unchanged.ts" }],
          }),
        ],
      }),
      change,
    );
    expect(result.stops[0]?.excerpts).toEqual([]);
    expect(result.stops[0]?.files).toEqual([{ path: "src/a.ts", note: "edited" }]);
  });

  it("puts changed files the tour left out into a closing stop", () => {
    const result = normalizeReviewGuide(
      guide({ stops: [stop({ excerpts: [excerpt("src/a.ts", 10, 12)] })] }),
      change,
    );
    expect(result.stops.at(-1)).toMatchObject({
      title: "Other files",
      files: [{ path: "src/gone.ts" }, { path: "docs/readme.md" }],
    });
  });

  it("lets stops show different parts of one file and lists an unshown file once", () => {
    const result = normalizeReviewGuide(
      guide({
        stops: [
          stop({
            title: "Shape",
            excerpts: [excerpt("src/a.ts", 10, 14)],
            files: [{ path: "docs/readme.md" }],
          }),
          stop({
            title: "Implementation",
            excerpts: [excerpt("src/a.ts", 40, 50)],
            files: [{ path: "src/a.ts" }, { path: "docs/readme.md" }, { path: "src/gone.ts" }],
          }),
        ],
      }),
      change,
    );
    expect(result.stops.map((s) => [s.title, s.excerpts.map((e) => e.start), s.files])).toEqual([
      ["Shape", [10], [{ path: "docs/readme.md" }]],
      ["Implementation", [40], [{ path: "src/gone.ts" }]],
    ]);
  });

  it("trims the overview and drops an empty one", () => {
    expect(normalizeReviewGuide(guide({ overview: "  Merge gate blocks red CI.  " }), change).overview).toBe(
      "Merge gate blocks red CI.",
    );
    expect(normalizeReviewGuide(guide({ overview: "   " }), change)).not.toHaveProperty("overview");
    expect(normalizeReviewGuide(guide({}), change)).not.toHaveProperty("overview");
  });

  it("holds the before/after to its limits", () => {
    const rows = [
      { op: " " as const, depth: 0, text: "  Merge pressed  " },
      { op: "-" as const, depth: 7, text: "merge at once", stop: 1 },
      { op: "+" as const, depth: -2, text: "x".repeat(100), stop: 2 },
      { op: "+" as const, depth: 1.6, text: "   ", stop: 1 },
      { op: "+" as const, depth: 1, text: "gate on CI", stop: 9 },
      ...Array.from({ length: 12 }, (_, i) => ({ op: " " as const, depth: 0, text: `row ${i}` })),
    ];
    const result = normalizeReviewGuide(
      guide({
        stops: [stop({ title: "One" }), stop({ title: "Two" })],
        beforeAfter: { title: " Merge action ", rows },
      }),
      change,
    );
    const shown = result.beforeAfter!;
    expect(shown.title).toBe("Merge action");
    expect(shown.rows).toHaveLength(12);
    expect(shown.rows.slice(0, 4)).toEqual([
      { op: " ", depth: 0, text: "Merge pressed" },
      { op: "-", depth: 3, text: "merge at once", stop: 1 },
      { op: "+", depth: 0, text: `${"x".repeat(79)}…`, stop: 2 },
      // The empty row is gone; a stop past the tour is dropped, the row kept.
      { op: "+", depth: 1, text: "gate on CI" },
    ]);
  });

  it("drops a before/after with no title or no rows", () => {
    const empty = [{ op: "+" as const, depth: 0, text: " " }];
    expect(normalizeReviewGuide(guide({ beforeAfter: { title: "Flow", rows: empty } }), change)).not.toHaveProperty("beforeAfter");
    expect(
      normalizeReviewGuide(guide({ beforeAfter: { title: " ", rows: [{ op: "+", depth: 0, text: "a" }] } }), change),
    ).not.toHaveProperty("beforeAfter");
  });

  it("keeps the tldr to one line near 140 characters, cut at a word", () => {
    const long = `Merge button locks on red CI.\n${"Now it locks and says why. ".repeat(8)}`;
    const guide = normalizeReviewGuide({ tldr: long, stops: [stop({ files: [{ path: "src/a.ts" }, { path: "src/gone.ts" }, { path: "docs/readme.md" }] })] } as ReviewGuideGenerationResult, change);
    expect(guide.tldr).not.toContain("\n");
    expect(guide.tldr!.length).toBeLessThanOrEqual(141);
    expect(guide.tldr!.endsWith("…")).toBe(true);
    expect(normalizeReviewGuide({ tldr: "  ", stops: [] } as ReviewGuideGenerationResult, change).tldr).toBeUndefined();
  });

  it("keeps a TL;DR to its line and its one call, with no closing stop: the diff shows every file", () => {
    const tldr = normalizeReviewGuide(
      guide({ depth: "tldr", tldr: " Merge locks\non red CI. ", attention: { kind: "risk", note: "Blocks hotfixes too." } }),
      change,
    );
    expect(tldr).toEqual({
      depth: "tldr",
      tldr: "Merge locks on red CI.",
      attention: { kind: "risk", note: "Blocks hotfixes too." },
      stops: [],
    });
    // An empty call is no call; stops a model added anyway are not a TL;DR's.
    expect(
      normalizeReviewGuide(
        guide({ depth: "tldr", tldr: "Merge locks.", attention: { kind: "risk", note: " " }, stops: [stop({})] }),
        change,
      ),
    ).toEqual({ depth: "tldr", tldr: "Merge locks.", stops: [] });
  });
});

