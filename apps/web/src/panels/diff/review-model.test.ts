import { describe, expect, test } from "vitest";
import { contextRows, fileLines, gapBefore, hunksOf } from "./hunks.ts";
import { diffPair, intraline } from "./intraline.ts";
import { findMoves } from "./moves.ts";
import { linesOf, type DiffFile } from "./parsePatch.ts";

const file = (path: string, patch: string): DiffFile => ({ path, status: "modified", additions: 0, deletions: 0, patch });

describe("hunksOf and gaps", () => {
  const f = file(
    "a.ts",
    ["@@ -3,3 +3,4 @@ function one", " a", "-b", "+b2", "+b3", " c", "@@ -20,2 +21,2 @@", " x", "-y", "+z", ""].join("\n"),
  );

  test("reads each hunk's range, context and rows", () => {
    const [h0, h1] = hunksOf(f);
    expect(h0).toMatchObject({ index: 0, oldStart: 3, oldCount: 3, newStart: 3, newCount: 4, context: "function one", additions: 2, deletions: 1 });
    expect(h0!.rows.map((r) => r.kind)).toEqual(["ctx", "del", "add", "add", "ctx"]);
    expect(h1).toMatchObject({ oldStart: 20, newStart: 21, additions: 1, deletions: 1 });
    expect(hunksOf(f)).toBe(hunksOf(f));
  });

  test("names the unchanged lines before, between and after hunks", () => {
    const hunks = hunksOf(f);
    expect(gapBefore(hunks, 0)).toEqual({ from: 1, to: 2, delta: 0 });
    // After the first hunk new runs one ahead: new 7..20 is old 6..19.
    expect(gapBefore(hunks, 1)).toEqual({ from: 7, to: 20, delta: 1 });
    expect(gapBefore(hunks, 2)).toEqual({ from: 23, to: null, delta: 1 });
    expect(gapBefore(hunks, 2, 30)).toEqual({ from: 23, to: 30, delta: 1 });
    expect(gapBefore(hunks, 2, 22)).toBeNull();
  });

  test("a deletion-only hunk and a new file", () => {
    const del = hunksOf(file("d.ts", "@@ -5,2 +4,0 @@\n-x\n-y\n"));
    expect(gapBefore(del, 0)).toEqual({ from: 1, to: 4, delta: 0 });
    expect(gapBefore(del, 1, 10)).toEqual({ from: 5, to: 10, delta: -2 });
    const added = hunksOf(file("n.ts", "@@ -0,0 +1,2 @@\n+a\n+b\n"));
    expect(gapBefore(added, 0)).toBeNull();
    expect(gapBefore(added, 1, 2)).toBeNull();
  });

  test("context rows carry both numbers", () => {
    expect(contextRows(["l1", "l2", "l3", "l4"], 2, 3, 1)).toEqual([
      { kind: "ctx", text: "l2", oldNo: 1, newNo: 2 },
      { kind: "ctx", text: "l3", oldNo: 2, newNo: 3 },
    ]);
    expect(fileLines("a\r\nb\n")).toEqual(["a", "b"]);
    expect(fileLines("")).toEqual([]);
  });
});

describe("intraline marks", () => {
  test("marks the words that changed, as one stretch", () => {
    const before = "// resolve the mode for a directory";
    const after = "// resolve a setting for a directory";
    const d = diffPair(before, after)!;
    expect(d.before.map(([s, e]) => before.slice(s, e))).toEqual(["the mode"]);
    expect(d.after.map(([s, e]) => after.slice(s, e))).toEqual(["a setting"]);
  });

  test("a rewrite is left unmarked, an indent change shows no marks", () => {
    expect(diffPair("const x = compute(a, b);", "return fetch(url).then(parse);")).toBeNull();
    expect(diffPair("  foo(bar);", "    foo(bar);")).toEqual({ before: [], after: [] });
  });

  test("pairs removed and added runs line by line", () => {
    const rows = linesOf(file("a.ts", "@@ -1,3 +1,3 @@\n-let a = 1;\n-let b = 2;\n+let a = 10;\n+let b = 2; // two\n ctx\n"));
    const marks = intraline(rows);
    // rows[0] is the @@ header.
    // Line 2 only gained a comment: nothing of it was removed, so only its added side is marked.
    expect([...marks.keys()].sort()).toEqual([1, 3, 4]);
    expect(marks.get(1)!.map(([s, e]) => rows[1]!.text.slice(s, e))).toEqual(["1"]);
    expect(marks.get(3)!.map(([s, e]) => rows[3]!.text.slice(s, e))).toEqual(["10"]);
    expect(marks.get(4)!.map(([s, e]) => rows[4]!.text.slice(s, e))).toEqual(["// two"]);
  });
});

describe("moves", () => {
  test("a block removed in one file and added in another is a move both ways", () => {
    const from = file("old.ts", "@@ -1,5 +1,1 @@\n keep\n-function moved() {\n-  const a = 1;\n-  return a + 1;\n-}\n");
    const to = file("new.ts", "@@ -1,1 +1,5 @@\n top\n+function moved() {\n+    const a = 1;\n+    return a + 1;\n+}\n");
    const marks = findMoves([from, to]);
    const del = linesOf(from).filter((r) => r.kind === "del");
    const add = linesOf(to).filter((r) => r.kind === "add");
    expect(del.map((r) => marks.get(r)?.to)).toEqual(del.map(() => ({ path: "new.ts", line: 2, side: "new" })));
    expect(add.map((r) => marks.get(r)?.to)).toEqual(add.map(() => ({ path: "old.ts", line: 2, side: "old" })));
    expect(marks.get(del[0]!)?.first).toBe(true);
    expect(marks.get(del[1]!)?.first).toBe(false);
  });

  test("re-indenting in place is not a move, and short blocks are not either", () => {
    const indent = file("a.ts", "@@ -1,3 +1,3 @@\n-alpha();\n-beta();\n-gamma();\n+  alpha();\n+  beta();\n+  gamma();\n");
    expect(findMoves([indent]).size).toBe(0);
    const short = file("b.ts", "@@ -1,2 +1,4 @@\n-alpha();\n-beta();\n x\n y\n+alpha();\n+beta();\n");
    expect(findMoves([short]).size).toBe(0);
  });
});
