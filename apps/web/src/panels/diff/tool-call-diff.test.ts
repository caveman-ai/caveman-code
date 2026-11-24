// , apps/web/src/lib/toolCallDiff.test.ts @ 441a4ebd65), read through our
// own patch reader instead of upstream renderer.
import { describe, expect, test } from "vitest";
import { linesOf } from "./parsePatch.ts";
import { patchFiles, relativeTo, toolCallDiff, toolCallPatch } from "./tool-call-diff.ts";

const added = (file: Parameters<typeof linesOf>[0]) => linesOf(file).filter((l) => l.kind === "add").map((l) => l.text);
const removed = (file: Parameters<typeof linesOf>[0]) => linesOf(file).filter((l) => l.kind === "del").map((l) => l.text);

describe("toolCallDiff", () => {
  test("a recorded hunk becomes a file without reading the repository, under its renamed path too", () => {
    for (const changes of [undefined, [{ operation: "update", old_path: "old.ts", path: "new.ts" }]]) {
      const { files } = toolCallDiff({ path: "old.ts", diff: "@@ -1 +1 @@\n-before\n+after\n", ...(changes ? { changes } : {}) });
      expect(files).toHaveLength(1);
      expect(files[0]!.path).toBe(changes ? "new.ts" : "old.ts");
      expect(files[0]!.status).toBe(changes ? "renamed" : "modified");
      expect(added(files[0]!)).toEqual(["after"]);
      expect(removed(files[0]!)).toEqual(["before"]);
    }
  });

  test("an added or deleted file's recorded content becomes a whole-file diff", () => {
    for (const operation of ["add", "delete"]) {
      for (const [content, ending] of [
        ["first\nsecond", ""],
        ["@@ -0,0 +1 @@\n+content", "\n"],
        ["@@ -1 +0,0 @@\n-content", "\n"],
        ["first\nsecond", "\n"],
        ["--- notes\nsecond", "\n"],
        ["diff --git notes\nsecond", "\n"],
        ["--- a/embedded.ts\n+++ b/embedded.ts\n@@ -1 +1 @@\n-before\n+after", "\n"],
        ["diff --git a/embedded.ts b/embedded.ts\n--- a/embedded.ts\n+++ b/embedded.ts\n@@ -1 +1 @@\n-before\n+after", "\n"],
      ] as const) {
        const { files } = toolCallDiff({ path: "file with spaces.ts", diff: `${content}${ending}`, changes: [{ operation, path: "file with spaces.ts" }] });
        expect(files).toHaveLength(1);
        const file = files[0]!;
        expect(file.path).toBe("file with spaces.ts");
        expect(file.status).toBe(operation === "add" ? "added" : "deleted");
        const lines = content.split("\n");
        expect(operation === "add" ? added(file) : removed(file)).toEqual(lines);
        expect(operation === "add" ? removed(file) : added(file)).toEqual([]);
      }
    }
  });

  test("content written without a diff stays out of the patch, empty content included", () => {
    for (const operation of ["add", "delete"]) {
      expect(toolCallDiff({ path: "empty.ts", diff: "", changes: [{ operation, path: "empty.ts" }] }).content).toEqual([
        { label: operation === "add" ? "Recorded content after" : "Recorded content before", text: "" },
      ]);
    }
    expect(toolCallDiff({ path: "a.ts", before: "before", after: "" })).toEqual({
      files: [],
      unreadable: null,
      content: [
        { label: "Recorded content before", text: "before" },
        { label: "Recorded content after", text: "" },
      ],
      truncated: false,
      omitted: 0,
    });
    expect(toolCallDiff({ path: "a.ts", after: "after" }).content).toEqual([{ label: "Recorded content after", text: "after" }]);
  });

  test("the transport's truncation mark comes off before content becomes a diff", () => {
    const suffix = "\n… output truncated for transport";
    const diff = toolCallDiff({ path: "a.ts", diff: `first\nsecond${suffix}`, changes: [{ operation: "add", path: "a.ts" }] });
    expect(diff.truncated).toBe(true);
    expect(added(diff.files[0]!)).toEqual(["first", "second"]);
    expect(toolCallDiff({ path: "a.ts", after: `content${suffix}` })).toMatchObject({ content: [{ label: "Recorded content after", text: "content" }], truncated: true });
  });

  test("whole patches pass through, and text that is no patch is shown as it came", () => {
    for (const operation of ["add", "delete"]) {
      const diff = [
        "diff --git a/a.ts b/a.ts",
        `--- ${operation === "add" ? "/dev/null" : "a/a.ts"}`,
        `+++ ${operation === "add" ? "b/a.ts" : "/dev/null"}`,
        operation === "add" ? "@@ -0,0 +1 @@" : "@@ -1 +0,0 @@",
        operation === "add" ? "+content" : "-content",
        "",
      ].join("\n");
      expect(toolCallPatch({ path: "a.ts", diff, changes: [{ operation, path: "a.ts" }] })).toBe(diff);
    }
    for (const diff of [undefined, "", "provider output", "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n"]) {
      expect(toolCallPatch({ path: "a.ts", ...(diff === undefined ? {} : { diff }) })).toBe(diff);
    }
    expect(toolCallDiff({ path: "a.ts", diff: "provider output" })).toMatchObject({ files: [], unreadable: "provider output" });
  });

  test("names the files a step changed that its patch leaves out", () => {
    const changes = [
      { operation: "update", path: "a.ts" },
      { operation: "update", path: "b.ts" },
    ];
    expect(toolCallDiff({ path: "a.ts", diff: "--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-a\n+b\n", changes }).omitted).toBe(1);
  });
});

describe("Claude Agent's recorded results", () => {
  test("an Edit's structured hunks keep their line numbers", () => {
    const result = {
      filePath: "/repo/wt/src/price.ts",
      oldString: "const price = 10;",
      newString: "const price = 12;",
      originalFile: "a\nb\nconst price = 10;\nc\n",
      structuredPatch: [{ oldStart: 2, oldLines: 3, newStart: 2, newLines: 3, lines: [" b", "-const price = 10;", "+const price = 12;", " c"] }],
      userModified: false,
      replaceAll: false,
    };
    const { files } = toolCallDiff({ path: "/repo/wt/src/price.ts", diff: JSON.stringify(result) });
    expect(files).toHaveLength(1);
    expect(relativeTo("/repo/wt", files[0]!.path)).toBe("src/price.ts");
    expect(files[0]!.status).toBe("modified");
    expect(linesOf(files[0]!).filter((l) => l.kind !== "hunk").map((l) => [l.kind, l.oldNo, l.newNo, l.text])).toEqual([
      ["ctx", 2, 2, "b"],
      ["del", 3, null, "const price = 10;"],
      ["add", null, 3, "const price = 12;"],
      ["ctx", 4, 4, "c"],
    ]);
  });

  test("a Write that created a file shows its content added", () => {
    const { files } = toolCallDiff({ path: "/repo/wt/notes.md", diff: JSON.stringify({ type: "create", filePath: "/repo/wt/notes.md", content: "# Notes\nfirst\n", structuredPatch: [] }) });
    expect(files.map((f) => [f.status, f.additions, f.deletions])).toEqual([["added", 2, 0]]);
  });

  test("a result cut short in transport is shown as it came", () => {
    const cut = `${JSON.stringify({ filePath: "a.ts", structuredPatch: [] }).slice(0, 12)}\n… output truncated for transport`;
    expect(toolCallDiff({ path: "a.ts", diff: cut })).toMatchObject({ files: [], truncated: true });
  });
});

describe("patchFiles", () => {
  test("reads several files, keeping a deleted '--- ' line as content", () => {
    const files = patchFiles(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 1..2 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1,2 +1,2 @@",
        "--- a heading that was a line",
        "+new line",
        " kept",
        "diff --git a/b.md b/b.md",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/b.md",
        "@@ -0,0 +1 @@",
        "+hello",
        "\\ No newline at end of file",
        "",
      ].join("\n"),
    );
    expect(files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
      ["src/a.ts", "modified", 1, 1],
      ["b.md", "added", 1, 0],
    ]);
    expect(removed(files[0]!)).toEqual(["-- a heading that was a line"]);
  });

  test("an unreadable text has no files", () => {
    expect(patchFiles("provider output")).toEqual([]);
  });
});

test("relativeTo names a path inside the chat's folder by its place there", () => {
  expect(relativeTo("/repo/wt", "/repo/wt/src/a.ts")).toBe("src/a.ts");
  expect(relativeTo("/repo/wt/", "/repo/wt/src/a.ts")).toBe("src/a.ts");
  expect(relativeTo("/repo/wt", "/elsewhere/a.ts")).toBe("/elsewhere/a.ts");
  expect(relativeTo(undefined, "src/a.ts")).toBe("src/a.ts");
  expect(relativeTo("/tmp/wt", "/private/tmp/wt/index.html")).toBe("index.html");
  expect(relativeTo("/private/var/wt", "/var/wt/index.html")).toBe("index.html");
});
