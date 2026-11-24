import * as Effect from "effect/Effect";
import { expect, test } from "vitest";

import { checkGit, gitProblem, type GitProbe } from "./gitInstalled.ts";

const ran = (exitCode: number, stdout: string, stderr = "") => Effect.succeed({ exitCode, stdout, stderr });
const probe = (over: Partial<GitProbe>): GitProbe => ({
  platform: "darwin",
  onPath: Effect.succeed("/usr/bin/git"),
  developerDir: Effect.succeed("/Library/Developer/CommandLineTools"),
  exists: () => true,
  version: ran(0, "git version 2.50.1 (Apple Git-155)\n"),
  gitBash: () => "C:\\Program Files\\Git\\bin\\bash.exe",
  ...over,
});
const check = (over: Partial<GitProbe>) => Effect.runPromise(checkGit(probe(over)));

test("a Mac with the Command Line Tools, or its own git, has git", async () => {
  expect(await check({})).toEqual({ ready: true, version: "2.50.1" });
  // Homebrew's git: the developer folder is not asked about.
  expect(await check({ onPath: Effect.succeed("/opt/homebrew/bin/git"), developerDir: Effect.die("not asked") })).toEqual({ ready: true, version: "2.50.1" });
});

test("a Mac with only Apple's stub is told to install the Command Line Tools, and the stub is never run", async () => {
  const stubRun = Effect.die("the stub would open Apple's installer");
  const none = await check({ developerDir: Effect.succeed(undefined), version: stubRun });
  expect(none).toMatchObject({ ready: false, install: { label: "Install developer tools", command: "xcode-select --install", runs: true } });
  expect(none.problem).toMatch(/^Git comes with Apple's Command Line Tools/);
  // A developer folder whose tools were removed is the same.
  expect(await check({ exists: () => false, version: stubRun })).toEqual(none);
  // An unaccepted Xcode license: git runs and refuses.
  expect(await check({ developerDir: Effect.succeed("/Applications/Xcode.app/Contents/Developer"), version: ran(69, "", "You have not agreed to the Xcode license agreements. Please run 'sudo xcodebuild -license'") })).toMatchObject({
    ready: false,
    install: { command: "sudo xcodebuild -license accept" },
  });
});

test("Windows without Git for Windows, or without its bash, is told to install it", async () => {
  const win = { platform: "win32" as const, onPath: Effect.die("not asked on Windows"), developerDir: Effect.die("not asked on Windows") };
  expect(await check({ ...win, version: ran(0, "git version 2.51.0.windows.1\n") })).toEqual({ ready: true, version: "2.51.0.windows.1" });
  const none = await check({ ...win, version: Effect.succeed(undefined) });
  expect(none).toMatchObject({ ready: false, install: { label: "Install Git for Windows", url: "https://git-scm.com/download/win" } });
  expect(none.problem).toMatch(/^Git for Windows isn't installed/);
  expect(await check({ ...win, version: ran(0, "git version 2.51.0\n"), gitBash: () => undefined })).toMatchObject({ ready: false, version: "2.51.0", install: { label: "Install Git for Windows" } });
});

test("a git failure reads as what's missing only when git is", () => {
  expect(gitProblem({ ready: true, version: "2.50.1" }, "/x is not a git repository")).toBe("/x is not a git repository");
  expect(gitProblem({ ready: false, problem: "Git for Windows isn't installed." }, "could not clone x: git did not finish")).toBe("Git for Windows isn't installed.");
});
