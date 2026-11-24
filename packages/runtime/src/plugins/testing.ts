/** Test helpers for plugins. */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** Writes `files` into a tree; `.sh` files are executable. */
export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text, { mode: rel.endsWith(".sh") ? 0o755 : 0o644 });
  }
}

/** A bare repo with two commits; returns [bare path, first commit, second commit]. */
export function makeSpaceRepo(
  dir: string,
  files: Record<string, string>,
  later: Record<string, string> = { "skills/late/SKILL.md": "---\nname: late\n---\n" },
): readonly [string, string, string] {
  const work = path.join(dir, "work");
  fs.mkdirSync(work, { recursive: true });
  git(work, "init", "-q", "-b", "main");
  const write = (set: Record<string, string>) => {
    writeTree(work, set);
    git(work, "add", "-A");
    // The suite runs git with core.filemode=false; record exec bits explicitly.
    const scripts = Object.keys(set).filter((rel) => rel.endsWith(".sh"));
    if (scripts.length > 0) git(work, "add", "--chmod=+x", "--", ...scripts);
    git(work, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "c");
    return git(work, "rev-parse", "HEAD");
  };
  const first = write(files);
  const second = write(later);
  const bare = path.join(dir, "space.git");
  git(dir, "clone", "-q", "--bare", work, bare);
  return [bare, first, second];
}

