import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { afterEach, expect, test } from "vitest";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { diffSummary } from "./lifecycle.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const layer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "sp-diff-summary-" })),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
// Windows forbids control characters and quotes, and treats backslashes as separators.
const unusualPaths = process.platform === "win32"
  ? ["café.txt", "space name.txt"]
  : ["café.txt", "tab\tname.txt", "line\nbreak.txt", 'a"quote.txt', "back\\slash.txt"];
const makeRepo = (files: ReadonlyArray<string>) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sp-diff-summary-"));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "core.quotePath", "true");
  for (const file of files) fs.writeFileSync(path.join(root, file), "before\n");
  git(root, "add", "--all");
  git(root, "commit", "--allow-empty", "-qm", "base");
  return root;
};
const summary = (root: string) => Effect.runPromise(
  Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => diffSummary(driver, root, "HEAD")).pipe(
    Effect.provide(layer),
  ),
);

test("tracked paths survive Git quoting, including tabs and newlines", async () => {
  const root = makeRepo(unusualPaths);
  for (const file of unusualPaths) fs.writeFileSync(path.join(root, file), "after\nsecond\n");
  expect(await summary(root)).toEqual(expect.arrayContaining(unusualPaths.map((file) => ({
    path: file, status: "modified", additions: 2, deletions: 1,
  }))));
});

test("untracked paths are used literally rather than stat-ing Git's quoted names", async () => {
  const root = makeRepo([]);
  for (const file of unusualPaths) fs.writeFileSync(path.join(root, file), "new\nsecond\n");
  expect(await summary(root)).toEqual(expect.arrayContaining(unusualPaths.map((file) => ({
    path: file, status: "added", additions: 2, deletions: 0,
  }))));
});

test("added and deleted tracked files retain their exact path and status", async () => {
  const root = makeRepo(unusualPaths.map((file) => `old-${file}`));
  for (const file of unusualPaths) {
    fs.rmSync(path.join(root, `old-${file}`));
    fs.writeFileSync(path.join(root, `new-${file}`), "added\n");
  }
  git(root, "add", "--all");
  const result = await summary(root);
  expect(result).toHaveLength(unusualPaths.length * 2);
  expect(result).toEqual(expect.arrayContaining(unusualPaths.flatMap((file) => [
    { path: `old-${file}`, status: "deleted", additions: 0, deletions: 1 },
    { path: `new-${file}`, status: "added", additions: 1, deletions: 0 },
  ])));
});

test("an untracked binary file adds no lines, as git counts a committed one and the Changes panel shows it", async () => {
  const root = makeRepo(["logo.png"]);
  // A PNG's signature and IHDR chunk: newline bytes, and the NULs that make git call it binary.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x0a, 0x00, 0x0a, 0x0a]);
  fs.writeFileSync(path.join(root, "logo.png"), png);
  fs.writeFileSync(path.join(root, "icon.png"), png);
  const result = await summary(root);
  // git's own count for the same bytes: numstat says "-" for a binary file, whether tracked or not.
  expect(git(root, "diff", "--numstat", "HEAD", "--", "logo.png").split("\t").slice(0, 2)).toEqual(["-", "-"]);
  expect(result).toEqual(expect.arrayContaining([
    { path: "logo.png", status: "modified", additions: 0, deletions: 0 },
    { path: "icon.png", status: "added", additions: 0, deletions: 0 },
  ]));
});

test("an untracked file's diff attribute decides as it does for git: -diff adds no lines, diff counts a file with a NUL", async () => {
  const root = makeRepo(["generated.lock", "notes.dat", "map.bin", "page.txt", ".gitattributes"]);
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.lock -diff\n*.dat diff\n*.bin diff=blob\n*.txt diff=words\n");
  // A driver whose config calls it binary is binary as -diff is; one that does not leaves it to the NUL test.
  git(root, "config", "diff.blob.binary", "true");
  git(root, "config", "diff.words.binary", "false");
  git(root, "commit", "-qam", "attributes");
  const lock = "a: 1\nb: 2\nc: 3\n";
  const dat = Buffer.from("one\0\ntwo\nthree\n");
  for (const [file, bytes] of [["generated.lock", lock], ["new.lock", lock], ["notes.dat", dat], ["new.dat", dat], ["map.bin", lock], ["new.bin", lock], ["page.txt", lock], ["new.txt", lock]] as const) {
    fs.writeFileSync(path.join(root, file), bytes);
  }
  const result = await summary(root);
  // git's own counts for the same bytes in tracked files the same attributes cover.
  expect(git(root, "diff", "--numstat", "HEAD", "--", "generated.lock", "notes.dat", "map.bin", "page.txt").trim().split("\n")).toEqual([
    "-\t-\tgenerated.lock",
    "-\t-\tmap.bin",
    "3\t1\tnotes.dat",
    "3\t1\tpage.txt",
  ]);
  expect(result).toEqual(expect.arrayContaining([
    { path: "generated.lock", status: "modified", additions: 0, deletions: 0 },
    { path: "new.lock", status: "added", additions: 0, deletions: 0 },
    { path: "notes.dat", status: "modified", additions: 3, deletions: 1 },
    { path: "new.dat", status: "added", additions: 3, deletions: 0 },
    { path: "new.bin", status: "added", additions: 0, deletions: 0 },
    { path: "new.txt", status: "added", additions: 3, deletions: 0 },
  ]));
});

// git lists an untracked link as a file and diffs it as its target's name: one line, whatever it points at.
test.skipIf(process.platform === "win32").each([
  ["a folder", "src"],
  ["nothing (dangling)", "no-such-target"],
])("an untracked link to %s counts as git counts it, one added line", async (_label, target) => {
  const root = makeRepo([]);
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.ts"), "export const a = 1;\n");
  fs.symlinkSync(target, path.join(root, "lib"));
  expect(await summary(root)).toEqual(expect.arrayContaining([{ path: "lib", status: "added", additions: 1, deletions: 0 }]));
});

test.skipIf(process.platform === "win32")("an untracked link to a FIFO is never opened, so the runtime's thread never waits on it", async () => {
  const root = makeRepo([]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "sp-diff-summary-fifo-"));
  roots.push(outside);
  const fifo = path.join(outside, "p");
  execFileSync("mkfifo", [fifo]);
  fs.symlinkSync(fifo, path.join(root, "pipe"));
  // Opening the FIFO blocks the thread until a writer comes; this one comes after 2 s so a blocked run still ends.
  const writer = spawn("sh", ["-c", `sleep 2; printf 'one\\ntwo\\n' > '${fifo}'`], { stdio: "ignore" });
  try {
    const started = Date.now();
    const files = await summary(root);
    expect({ files, returnedAtOnce: Date.now() - started < 1000 }).toEqual({
      files: [{ path: "pipe", status: "added", additions: 1, deletions: 0 }],
      returnedAtOnce: true,
    });
  } finally {
    writer.kill();
  }
}, 20_000);

// Every caller recovers a failed summary (no diff this time); a throw would be a defect that stops the projector.
test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("an unreadable untracked file fails the summary, never as a defect", async () => {
  const root = makeRepo([]);
  fs.writeFileSync(path.join(root, "locked.txt"), "secret\n", { mode: 0o000 });
  const exit = await Effect.runPromiseExit(
    Effect.flatMap(GitVcsDriver.GitVcsDriver, (driver) => diffSummary(driver, root, "HEAD")).pipe(Effect.provide(layer)),
  );
  expect(Exit.isFailure(exit) && Cause.hasFails(exit.cause) && !Cause.hasDies(exit.cause)).toBe(true);
});
