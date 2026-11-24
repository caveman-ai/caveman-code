import { describe, expect, it } from "vitest";
import { maxLineNo, parsePatch, patchLines, reuseUnchanged } from "./parsePatch.ts";

const rows = (patch: string) => parsePatch(patch).map((l) => [l.kind, l.oldNo, l.newNo, l.text]);

describe("parsePatch", () => {
  it("numbers lines across hunks from each header and skips the file headers", () => {
    const patch = [
      "diff --git a/x.go b/x.go",
      "index 1111111..2222222 100644",
      "--- a/x.go",
      "+++ b/x.go",
      "@@ -10,3 +10,4 @@ func A() {",
      " a",
      "-b",
      "+B",
      "+C",
      " d",
      "@@ -40,2 +41,2 @@",
      "-y",
      "+Y",
      " z",
      "",
    ].join("\n");
    expect(rows(patch)).toEqual([
      ["hunk", null, null, "@@ -10,3 +10,4 @@ func A() {"],
      ["ctx", 10, 10, "a"],
      ["del", 11, null, "b"],
      ["add", null, 11, "B"],
      ["add", null, 12, "C"],
      ["ctx", 12, 13, "d"],
      ["hunk", null, null, "@@ -40,2 +41,2 @@"],
      ["del", 40, null, "y"],
      ["add", null, 41, "Y"],
      ["ctx", 41, 42, "z"],
    ]);
  });

  it("reads added and deleted files", () => {
    expect(rows("new file mode 100644\n@@ -0,0 +1,2 @@\n+one\n+two\n")).toEqual([
      ["hunk", null, null, "@@ -0,0 +1,2 @@"],
      ["add", null, 1, "one"],
      ["add", null, 2, "two"],
    ]);
    expect(rows("deleted file mode 100644\n@@ -1,2 +0,0 @@\n-one\n-two\n")).toEqual([
      ["hunk", null, null, "@@ -1,2 +0,0 @@"],
      ["del", 1, null, "one"],
      ["del", 2, null, "two"],
    ]);
  });

  it("never counts \\ No newline, mid-hunk or at the end", () => {
    const patch = "@@ -1,2 +1,2 @@\n a\n-b\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n";
    expect(rows(patch)).toEqual([
      ["hunk", null, null, "@@ -1,2 +1,2 @@"],
      ["ctx", 1, 1, "a"],
      ["del", 2, null, "b"],
      ["add", null, 2, "b"],
    ]);
  });

  it("keeps content that looks like a header, and blank context a tool trimmed", () => {
    expect(rows("@@ -1,3 +1,3 @@\n--- a comment\n+++ more\n\n x\n")).toEqual([
      ["hunk", null, null, "@@ -1,3 +1,3 @@"],
      ["del", 1, null, "-- a comment"],
      ["add", null, 1, "++ more"],
      ["ctx", 2, 2, ""],
      ["ctx", 3, 3, "x"],
    ]);
  });

  it("gives no rows for a binary or mode-only change, and sizes the gutter", () => {
    expect(parsePatch("Binary files a/logo.png and b/logo.png differ\n")).toEqual([]);
    expect(parsePatch("")).toEqual([]);
    expect(maxLineNo(parsePatch("@@ -98,2 +98,3 @@\n a\n+b\n c\n"))).toBe(100);
  });
});

describe("reuseUnchanged", () => {
  const file = (path: string, patch: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0, patch });
  it("keeps unchanged file objects and the whole diff when nothing changed", () => {
    const a = file("a.go", "@@ -1 +1,2 @@\n x\n+y\n");
    const b = file("b.go", "@@ -1 +1,2 @@\n x\n+z\n");
    const prev = { from: "main", to: "WORKTREE", files: [a, b] };
    const same = reuseUnchanged(prev, { from: "main", to: "WORKTREE", files: [{ ...a }, { ...b }] });
    expect(same).toBe(prev);
    const changed = reuseUnchanged(prev, { from: "main", to: "WORKTREE", files: [{ ...a }, file("b.go", "@@ -1 +1,2 @@\n x\n+w\n")] });
    expect(changed).not.toBe(prev);
    expect(changed.files[0]).toBe(a);
    expect(changed.files[1]).not.toBe(b);
    expect(patchLines(changed.files[1]!)).toBe(3);
  });
});
