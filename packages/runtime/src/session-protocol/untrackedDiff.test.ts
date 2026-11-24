import { spawnSync, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";
import { afterAll, expect, test } from "vitest";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { PARSEABLE_DIFF } from "./diffSections.ts";
import { untrackedPatches, UNTRACKED_ONE_BY_ONE } from "./untrackedDiff.ts";

// The suite pins core.filemode=false (gitConfig.setup.ts); a Mac or Linux checkout has it true, which is
// what tells `add` an executable is 100755, as --no-index always reports it.
for (let i = 0; i < Number(process.env.GIT_CONFIG_COUNT ?? "0"); i++) {
  if (process.env[`GIT_CONFIG_KEY_${i}`] === "core.filemode") process.env[`GIT_CONFIG_VALUE_${i}`] = "true";
}

const repo = fs.mkdtempSync(path.join(os.tmpdir(), "untracked-diff-"));
afterAll(() => fs.rmSync(repo, { recursive: true, force: true }));
const git = (...args: Array<string>) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: repo, encoding: "utf8" });

/** Real git behind the one driver method the helper uses, counting the runs. */
const runs: Array<ReadonlyArray<string>> = [];
const driver = {
  execute: (input: { cwd: string; args: ReadonlyArray<string>; env?: NodeJS.ProcessEnv; stdin?: string; allowNonZeroExit?: boolean }) =>
    Effect.sync(() => {
      runs.push(input.args);
      const result = spawnSync("git", input.args, {
        cwd: input.cwd,
        env: { ...process.env, ...input.env },
        input: input.stdin,
        encoding: "utf8",
      });
      return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr, stdoutTruncated: false, stderrTruncated: false };
    }).pipe(
      Effect.flatMap((result) =>
        result.exitCode !== 0 && input.allowNonZeroExit !== true ? Effect.fail(new Error(result.stderr)) : Effect.succeed(result),
      ),
    ),
} as unknown as GitVcsDriver.GitVcsDriver["Service"];

const oneByOne = (file: string) => {
  const result = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", file], { cwd: repo, encoding: "utf8" });
  return result.stdout;
};

test("a turn's new files get the patches one git per file gave, from three git runs", async () => {
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\n");
  git("add", ".");
  git("commit", "-qm", "init");
  fs.writeFileSync(path.join(repo, "tracked.txt"), "base\nchanged\n");
  fs.writeFileSync(path.join(repo, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(repo, "nonl.txt"), "no newline");
  fs.writeFileSync(path.join(repo, "empty.txt"), "");
  fs.writeFileSync(path.join(repo, "bin.dat"), Buffer.from([0, 1, 2]));
  fs.writeFileSync(path.join(repo, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  fs.symlinkSync("a.txt", path.join(repo, "link"));
  fs.mkdirSync(path.join(repo, "sp ace"));
  fs.writeFileSync(path.join(repo, "sp ace", "f g.txt"), "s\n");
  fs.writeFileSync(path.join(repo, "naïve.txt"), "u\n");
  // Skipped on Windows: `"` cannot be in a file name there.
  if (process.platform !== "win32") fs.writeFileSync(path.join(repo, 'q"uote.txt'), "q\n");
  const files = git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean);
  expect(files.length).toBeGreaterThan(UNTRACKED_ONE_BY_ONE);

  runs.length = 0;
  const patches = await Effect.runPromise(untrackedPatches(driver, repo, files));
  expect(patches).toEqual(files.map((file) => ({ path: file, patch: oneByOne(file) })));
  expect(runs.length).toBe(3);
  // The checkout's own index is untouched: the tracked change is still unstaged and the new files untracked.
  expect(git("diff", "--cached", "--name-only")).toBe("");
  expect(git("ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean)).toEqual(files);
});

test("a file gone before the batch reads it falls back to one git per file", async () => {
  const files = ["a.txt", "nonl.txt", "empty.txt", "missing.txt"];
  runs.length = 0;
  const patches = await Effect.runPromise(untrackedPatches(driver, repo, files));
  expect(patches.map((p) => p.path)).toEqual(files);
  expect(patches[0]!.patch).toBe(oneByOne("a.txt"));
  expect(patches[3]!.patch).toBe("");
});

test("a few new files are each asked for on their own", async () => {
  runs.length = 0;
  const patches = await Effect.runPromise(untrackedPatches(driver, repo, ["a.txt"]));
  expect(patches).toEqual([{ path: "a.txt", patch: oneByOne("a.txt") }]);
  expect(runs).toEqual([[...PARSEABLE_DIFF, "--no-index", "--", "/dev/null", "a.txt"]]);
});

test("new files' patches stay what git writes by default, whatever the person's diff settings", async () => {
  const own = fs.mkdtempSync(path.join(os.tmpdir(), "untracked-diff-config-"));
  try {
    const at = (...args: Array<string>) => spawnSync("git", args, { cwd: own, encoding: "utf8" }).stdout;
    at("init", "-q", "-b", "main");
    const names = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
    for (const name of names) fs.writeFileSync(path.join(own, name), `${name}\n\nlast\n`);
    const plain = (file: string) => at("diff", "--no-index", "--", "/dev/null", file);
    const defaults = names.map(plain);
    // What a person's ~/.gitconfig may say, set on this repository.
    for (const [key, value] of [
      ["diff.external", "echo external"],
      ["color.ui", "always"],
      ["diff.noprefix", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.suppressBlankEmpty", "true"],
    ] as const) at("config", key, value);
    expect(plain("a.txt")).toContain("external");

    expect(await Effect.runPromise(untrackedPatches(driver, own, ["a.txt"]))).toEqual([{ path: "a.txt", patch: defaults[0] }]);
    runs.length = 0;
    const batch = await Effect.runPromise(untrackedPatches(driver, own, names));
    expect(batch).toEqual(names.map((file, i) => ({ path: file, patch: defaults[i] })));
    expect(runs.length).toBe(3);
  } finally {
    fs.rmSync(own, { recursive: true, force: true });
  }
});
