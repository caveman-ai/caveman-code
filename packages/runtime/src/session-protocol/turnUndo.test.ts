// checkpoint.undo's rules on a real checkout: a file goes back only while it is what the turn left.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { afterAll, expect, test } from "vitest";

import { fileList, parseRawDiff, pathBatches, undoBlocker } from "./turnUndo.ts";
import { tempRoot } from "./testHarness.ts";

const root = tempRoot("turn-undo-");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const hash = (file: string) => execFileSync("git", ["hash-object", "--", file], { cwd: root, encoding: "utf8" }).trim();

test("raw diff records: added, modified and deleted, names with spaces kept whole", () => {
  const raw = [":000000 100644 0000 aaaa A", "new file.md", ":100644 100755 bbbb cccc M", "run.sh", ":100644 000000 dddd 0000 D", "gone.txt", ""].join("\0");
  expect(parseRawDiff(raw)).toEqual([
    { path: "new file.md", before: null, after: { mode: "100644", oid: "aaaa" } },
    { path: "run.sh", before: { mode: "100644", oid: "bbbb" }, after: { mode: "100755", oid: "cccc" } },
    { path: "gone.txt", before: { mode: "100644", oid: "dddd" }, after: null },
  ]);
  expect(parseRawDiff("")).toEqual([]);
});

test("paths batch under a command line's length; lists read as a sentence", () => {
  const long = Array.from({ length: 3000 }, (_, i) => `src/module-${i}/index.ts`);
  const batches = pathBatches(long);
  expect(batches.length).toBeGreaterThan(1);
  expect(batches.flat()).toEqual(long);
  expect(batches.every((b) => b.join(" ").length < 24_100)).toBe(true);
  expect(fileList(["a.md"])).toBe("a.md");
  expect(fileList(["a.md", "b.md"])).toBe("a.md and b.md");
  expect(fileList(["a.md", "b.md", "c.md"])).toBe("a.md, b.md and 1 more file");
  expect(fileList(["a.md", "b.md", "c.md", "d.md"])).toBe("a.md, b.md and 2 more files");
});

test("a file blocks Undo once it changed after the turn, came back after a delete, or sits behind a link", () => {
  const none = new Set<string>();
  fs.writeFileSync(path.join(root, "kept.md"), "turn\n");
  const left = hash("kept.md");
  const change = { path: "kept.md", before: { mode: "100644", oid: "x" }, after: { mode: "100644", oid: left } };
  expect(undoBlocker(root, change, left, none)).toBeNull();
  fs.writeFileSync(path.join(root, "kept.md"), "turn\nand mine\n");
  expect(undoBlocker(root, change, hash("kept.md"), none)).toBe("changed");

  // Deleted by the turn: still gone is fine; made again is not.
  const deleted = { path: "gone.md", before: { mode: "100644", oid: "x" }, after: null };
  expect(undoBlocker(root, deleted, undefined, none)).toBeNull();
  fs.writeFileSync(path.join(root, "gone.md"), "back\n");
  expect(undoBlocker(root, deleted, undefined, none)).toBe("changed");

  // Removed after the turn made it.
  expect(undoBlocker(root, { path: "missing.md", before: null, after: { mode: "100644", oid: left } }, undefined, none)).toBe("changed");

  // A symlink or submodule, or a directory on the way that is a link.
  expect(undoBlocker(root, { path: "link", before: null, after: { mode: "120000", oid: "y" } }, undefined, none)).toBe("link");
  fs.mkdirSync(path.join(root, "real"));
  fs.symlinkSync(path.join(root, "real"), path.join(root, "via"));
  fs.writeFileSync(path.join(root, "real", "f.md"), "turn\n");
  expect(undoBlocker(root, { path: "via/f.md", before: null, after: { mode: "100644", oid: hash("real/f.md") } }, hash("real/f.md"), none)).toBe("link");
});

test("a directory the turn put where it deleted a file is the turn's while it holds only files the turn made", () => {
  // The turn: rm swap/p; write swap/p/sub/x.
  fs.mkdirSync(path.join(root, "swap/p/sub"), { recursive: true });
  fs.writeFileSync(path.join(root, "swap/p/sub/x"), "inside\n");
  const deleted = { path: "swap/p", before: { mode: "100644", oid: "x" }, after: null };
  expect(undoBlocker(root, deleted, undefined, new Set(["swap/p/sub/x"]))).toBeNull();
  // The person's file in it since: putting swap/p back would take that away.
  fs.writeFileSync(path.join(root, "swap/p/mine.md"), "mine\n");
  expect(undoBlocker(root, deleted, undefined, new Set(["swap/p/sub/x"]))).toBe("changed");
});

test("a file the turn deleted is gone as the turn left it where the turn turned its directory into a file", () => {
  // The turn: rm -r swap/d (it held x); write swap/d.
  fs.mkdirSync(path.join(root, "swap"), { recursive: true });
  fs.writeFileSync(path.join(root, "swap/d"), "a file now\n");
  const deleted = { path: "swap/d/x", before: { mode: "100644", oid: "x" }, after: null };
  expect(undoBlocker(root, deleted, undefined, new Set(["swap/d"]))).toBeNull();
  // A file where the directory was that the turn did not make is the person's: Undo would lose it.
  expect(undoBlocker(root, deleted, undefined, new Set())).toBe("changed");
  // A file the turn left in that directory: it changed (the person turned the directory into a file).
  expect(undoBlocker(root, { path: "swap/d/y", before: null, after: { mode: "100644", oid: "y" } }, undefined, new Set(["swap/d/y"]))).toBe("changed");
});

test.skipIf(process.platform === "win32")("a file's execute bit counts as git records it: the owner's alone, and none where core.fileMode is off", () => {
  fs.writeFileSync(path.join(root, "g.sh"), "echo\n");
  const left = hash("g.sh");
  const recorded = (mode: string) => ({ path: "g.sh", before: null, after: { mode, oid: left } });
  const none = new Set<string>();
  // core.fileMode on: only the owner's execute bit makes git record 100755.
  fs.chmodSync(path.join(root, "g.sh"), 0o654);
  expect(undoBlocker(root, recorded("100644"), left, none, true)).toBeNull();
  expect(undoBlocker(root, recorded("100755"), left, none, true)).toBe("changed");
  fs.chmodSync(path.join(root, "g.sh"), 0o744);
  expect(undoBlocker(root, recorded("100755"), left, none, true)).toBeNull();
  // Off (exFAT, SMB, DrvFs show every file as 0777): git records the index's mode, or 100644, never the disk's.
  fs.chmodSync(path.join(root, "g.sh"), 0o777);
  expect(undoBlocker(root, recorded("100644"), left, none, false)).toBeNull();
});
