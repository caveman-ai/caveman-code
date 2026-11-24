// The merged pack against real git: a chat's work in progress copied as a bundle per turn (as handlers.ts wipCopy
// makes them: the snapshot commit, `--not --remotes=origin <the last one>`), with large files whose next versions
// pack as deltas, a commit of the agent's between turns, and a file put back to a version an older bundle carried.
// One `index-pack --fix-thin` of the merged pack gives a checkout that never had them the same commit, every object
// whole.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test } from "vitest";

import { tempRoot } from "../session-protocol/testHarness.ts";
import { mergeWipBundles, parseBundle } from "./wipPack.ts";

const git = (cwd: string, args: ReadonlyArray<string>, input?: Buffer) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, ...(input ? { input } : {}), maxBuffer: 1 << 28 });
const out = (cwd: string, ...args: Array<string>) => git(cwd, args).toString("utf8").trim();
const REF = "refs/caveman/sessions/s1";

/** origin with main, the source's clone of it, and a checkout made from origin (the computer's snapshot). */
function world() {
  const root = tempRoot("wip-pack-");
  const origin = path.join(root, "origin.git");
  git(root, ["init", "--bare", "-q", "-b", "main", origin]);
  const source = path.join(root, "source");
  git(root, ["clone", "-q", origin, source]);
  fs.writeFileSync(path.join(source, "big.txt"), Array.from({ length: 4000 }, (_, i) => `line ${i} of the original\n`).join(""));
  fs.writeFileSync(path.join(source, "README.md"), "hi\n");
  git(source, ["add", "-A"]);
  git(source, ["commit", "-qm", "init"]);
  git(source, ["push", "-q", "origin", "main"]);
  const target = path.join(root, "target");
  git(root, ["clone", "-q", origin, target]);
  return { root, origin, source, target };
}

/** The work in progress as a commit on HEAD (the index left as it was), and its bundle against the last one. */
function copyTurn(source: string, last: string | undefined) {
  git(source, ["add", "-A"]);
  const tree = out(source, "write-tree");
  git(source, ["reset", "-q"]);
  const wip = out(source, "commit-tree", tree, "-p", "HEAD", "-m", "caveman: work in progress");
  git(source, ["update-ref", REF, wip]);
  const bundle = git(source, ["bundle", "create", "-q", "-", REF, "--not", "--remotes=origin", ...(last ? [last] : [])]);
  return { wip, bundle };
}

/** The merged pack into `target`, as applyWip's script does: index it, then every prerequisite must be there. */
function applyMerged(target: string, bundles: ReadonlyArray<Buffer>, wip: string) {
  const merged = mergeWipBundles(bundles)!;
  git(target, ["index-pack", "--stdin", "--fix-thin"], merged.pack);
  const checked = git(target, ["cat-file", "--batch-check"], Buffer.from(merged.prerequisites.map((id) => `${id}\n`).join(""))).toString("utf8");
  const missing = checked.split("\n").filter((l) => l.endsWith(" missing"));
  if (missing.length === 0) git(target, ["update-ref", REF, wip]);
  return { merged, missing };
}

test("a chat's bundles of thirteen turns merge into one pack that brings the last turn's work in progress whole", () => {
  const { source, target } = world();
  const bundles: Array<Buffer> = [];
  let last: string | undefined;
  const big = path.join(source, "big.txt");
  const original = fs.readFileSync(big, "utf8");
  for (let turn = 1; turn <= 13; turn++) {
    // A little more of the big file each turn: its versions pack as deltas on the last bundle's (thin).
    fs.writeFileSync(big, original.replace(`line ${turn * 100} of`, `line ${turn * 100} changed in turn ${turn} of`));
    fs.writeFileSync(path.join(source, `turn-${turn}.txt`), `turn ${turn}\n`);
    // The agent commits in turn 5; in turn 9 README goes back to what turn 2's bundle carried.
    if (turn === 2) fs.writeFileSync(path.join(source, "README.md"), "hi from turn 2\n");
    if (turn === 3) fs.writeFileSync(path.join(source, "README.md"), "hi from turn 3\n");
    if (turn === 9) fs.writeFileSync(path.join(source, "README.md"), "hi from turn 2\n");
    if (turn === 5) {
      git(source, ["add", "-A"]);
      git(source, ["commit", "-qm", "the agent's commit"]);
    }
    const made = copyTurn(source, last);
    bundles.push(made.bundle);
    last = made.wip;
  }
  // The bundles really are thin (deltas on objects the pack does not hold) for the merge to be worth checking.
  expect(bundles.every((b) => parseBundle(b) !== undefined)).toBe(true);
  expect(parseBundle(bundles[5]!)!.prerequisites.length).toBeGreaterThan(0);

  const { merged, missing } = applyMerged(target, bundles, last!);
  expect(missing).toEqual([]);
  expect(merged.tips.at(-1)).toBe(last);
  // Every object from the work in progress down to origin is there, and it is the source's very commit and tree.
  git(target, ["rev-list", "--objects", "--quiet", last!, "--not", "--remotes=origin"]);
  git(target, ["fsck", "--connectivity-only", "--no-dangling"]);
  expect(out(target, "rev-parse", `${last}^{tree}`)).toBe(out(source, "rev-parse", `${last}^{tree}`));
  expect(out(target, "show", `${last}:README.md`)).toBe("hi from turn 2");
  expect(out(target, "show", `${last}:big.txt`)).toBe(fs.readFileSync(big, "utf8").trim());
  expect(out(target, "rev-parse", REF)).toBe(last);
});

test("a bundle built on a commit only the source has leaves that prerequisite missing, never a broken ref", () => {
  const { source, target } = world();
  // The source's origin/main names a commit GitHub never got (K9, a stale clone): its bundle builds on that commit,
  // which the target cannot have.
  git(source, ["commit", "-q", "--allow-empty", "-m", "a base only the source has"]);
  git(source, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  fs.writeFileSync(path.join(source, "work.txt"), "work\n");
  const made = copyTurn(source, undefined);
  const { missing } = applyMerged(target, [made.bundle], made.wip);
  expect(missing).toEqual([`${out(source, "rev-parse", "HEAD")} missing`]);
  expect(() => out(target, "rev-parse", "--verify", "--quiet", REF)).toThrow();
});

test("anything but a git bundle is not merged", () => {
  expect(mergeWipBundles([])).toBeUndefined();
  expect(mergeWipBundles([Buffer.from("# v9 git bundle\n\nPACK")])).toBeUndefined();
  expect(mergeWipBundles([Buffer.from("not a bundle")])).toBeUndefined();
  // A partial bundle (v3 with a filter) is not one this takes.
  expect(parseBundle(Buffer.from("# v3 git bundle\n@filter=blob:none\n\nPACK\x00\x00\x00\x02\x00\x00\x00\x00" + "x".repeat(20)))).toBeUndefined();
});
