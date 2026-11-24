import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, test } from "vitest";
import { splitDiffSections } from "./diffSections.ts";

test("one whole git diff splits into each file's own patch, in numstat's order", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "diff-sections-"));
  const git = (...args: Array<string>) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.ts"), "one\ntwo\n");
  fs.mkdirSync(path.join(repo, "dir with space"));
  fs.writeFileSync(path.join(repo, "dir with space", "b.md"), "diff --git looks like a header\n");
  fs.writeFileSync(path.join(repo, "c.bin"), Buffer.from([0, 1, 2, 3]));
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "a.ts"), "one\nthree\n");
  fs.writeFileSync(path.join(repo, "dir with space", "b.md"), "diff --git looks like a header\ndiff --git again\n");
  fs.writeFileSync(path.join(repo, "c.bin"), Buffer.from([0, 9, 2, 3]));
  const files = git("diff", "--numstat", "--no-renames", "HEAD").split("\n").filter(Boolean).map((l) => l.split("\t").slice(2).join("\t"));
  const sections = splitDiffSections(git("diff", "--no-renames", "HEAD"));
  expect(sections).toEqual(files.map((file) => git("diff", "--no-renames", "HEAD", "--", file)));
  expect(splitDiffSections("")).toEqual([]);
});
