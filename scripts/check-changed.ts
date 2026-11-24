// Format check and lint for this branch's changes, .ts runs them.
//
//   pnpm check:changed                compare against the merge base with origin/main (else main)
//   pnpm check:changed <ref>          compare against the merge base with <ref>
//   pnpm fmt                          format the files the check holds to the formatter, instead of checking
//
// Committed, uncommitted and untracked changes all count. About half the repo predates the formatter, and
// reformatting a whole file would collide with every branch editing it, so a changed file is held to
// .oxfmtrc.jsonc only if this branch adds it or it was already formatted at the merge base. Format any other
// file whole with `pnpm exec oxfmt <file>` when nothing else is editing it. Lint covers every changed file: it
// fails on errors and prints the warnings of the rules not yet clean across the repo (.oxlintrc.json).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "..");
const CODE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
// Keeps each command line far below Windows' 32k characters.
const BATCH = 200;

const args = process.argv.slice(2);
const write = args.includes("--write");
const refs = args.filter((arg) => !arg.startsWith("--"));

const resolveBin = (name: string) =>
  NodePath.join(
    NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve(`${name}/package.json`)),
    "bin",
    name,
  );
const oxfmt = resolveBin("oxfmt");
const oxlint = resolveBin("oxlint");

function run(command: string, commandArgs: ReadonlyArray<string>, input?: string) {
  const result = NodeChildProcess.spawnSync(command, commandArgs, {
    cwd: root,
    encoding: "utf8",
    input,
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function git(...gitArgs: ReadonlyArray<string>) {
  const result = run("git", gitArgs);
  if (result.status !== 0) {
    throw new Error(
      `git ${gitArgs.join(" ")} exited with ${result.status}: ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

const lines = (text: string) => text.split("\n").filter((line) => line !== "");

// The closest merge base: a local main ahead of origin/main holds merged work this branch did not write.
function mergeBase(): { readonly ref: string; readonly sha: string } {
  const candidates = refs.length > 0 ? refs : ["origin/main", "main"];
  const bases = candidates.flatMap((ref) => {
    const result = run("git", ["merge-base", "HEAD", ref]);
    if (result.status !== 0) return [];
    const sha = result.stdout.trim();
    return [{ ref, sha, ahead: Number(git("rev-list", "--count", `${sha}..HEAD`).trim()) }];
  });
  const closest = bases.sort((a, b) => a.ahead - b.ahead)[0];
  if (!closest) {
    throw new Error(`no merge base with ${candidates.join(" or ")}: run git fetch, or pass a ref.`);
  }
  return closest;
}

function batches<T>(items: ReadonlyArray<T>): Array<ReadonlyArray<T>> {
  const out: Array<ReadonlyArray<T>> = [];
  for (let i = 0; i < items.length; i += BATCH) out.push(items.slice(i, i + BATCH));
  return out;
}

// The given files oxfmt would change; files .oxfmtrc.jsonc ignores are never listed.
function unformatted(files: ReadonlyArray<string>): Array<string> {
  return batches(files).flatMap((batch) => {
    const result = run(process.execPath, [
      oxfmt,
      "--list-different",
      "--no-error-on-unmatched-pattern",
      ...batch,
    ]);
    // 0: all formatted; 1: some listed. Anything else is oxfmt failing.
    if (result.status > 1) throw new Error(`oxfmt failed:\n${result.stdout}${result.stderr}`);
    return lines(result.stdout).map((file) => file.trim());
  });
}

function formattedAt(sha: string, file: string): boolean {
  const shown = run("git", ["show", `${sha}:${file}`]);
  if (shown.status !== 0) return false;
  const formatted = run(process.execPath, [oxfmt, `--stdin-filepath=${file}`], shown.stdout);
  return formatted.status === 0 && formatted.stdout === shown.stdout;
}

const base = mergeBase();
const changed = [
  ...new Set([
    ...lines(git("diff", "--name-only", "--no-renames", base.sha, "--")),
    ...lines(git("ls-files", "--others", "--exclude-standard")),
  ]),
]
  .filter((file) => CODE.test(file) && NodeFS.existsSync(NodePath.join(root, file)))
  .sort();

console.log(
  `check:changed: ${changed.length} changed code file(s) against ${base.ref} (${base.sha.slice(0, 10)}).`,
);
if (changed.length === 0) process.exit(0);

// A file is held to the formatter when it is new on this branch or was formatted at the merge base.
const held: Array<string> = [];
const exempt: Array<string> = [];
for (const file of unformatted(changed)) {
  const existed = run("git", ["cat-file", "-e", `${base.sha}:${file}`]).status === 0;
  if (!existed || formattedAt(base.sha, file)) held.push(file);
  else exempt.push(file);
}
if (exempt.length > 0) {
  console.log(
    `\nNot formatted before this branch, so not held to the formatter (${exempt.length}):\n${exempt.map((file) => `  ${file}`).join("\n")}`,
  );
}

if (write) {
  for (const batch of batches(held)) {
    const result = run(process.execPath, [oxfmt, "--write", ...batch]);
    if (result.status !== 0) throw new Error(`oxfmt failed:\n${result.stdout}${result.stderr}`);
  }
  console.log(
    held.length > 0
      ? `\nFormatted (${held.length}):\n${held.map((file) => `  ${file}`).join("\n")}`
      : "\nNothing to format.",
  );
  process.exit(0);
}

let failed = false;
if (held.length > 0) {
  failed = true;
  console.log(
    `\nNot formatted (${held.length}); run pnpm fmt:\n${held.map((file) => `  ${file}`).join("\n")}`,
  );
} else {
  console.log("\nFormat: ok.");
}

console.log("\nLint:");
for (const batch of batches(changed)) {
  const result = run(process.execPath, [oxlint, ...batch]);
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) failed = true;
}

process.exit(failed ? 1 : 0);
