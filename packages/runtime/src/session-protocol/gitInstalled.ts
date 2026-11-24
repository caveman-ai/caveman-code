// Git on this computer (git.installed): adding a folder, cloning and every chat's worktree run it. A fresh Mac has only
// Apple's /usr/bin/git stub until the Command Line Tools (or Xcode) are installed: running the stub opens Apple's
// installer and fails, so a project could not be added and the person read "is not a git repository". A fresh Windows
// has no git until Git for Windows is installed, which also brings the bash Claude Code and the Caveman engine run
// commands in. Your setup and the project step say what is missing and how to get it.

import * as path from "node:path";

import * as Effect from "effect/Effect";

export interface GitInstall {
  readonly label: string;
  /** A page to open. */
  readonly url?: string;
  /** What to run in a terminal, shown and copied as is. */
  readonly command?: string;
  /** git.install runs it: Apple's installer, which asks the person itself. */
  readonly runs?: boolean;
}

export interface GitInstalled {
  readonly ready: boolean;
  /** "2.50.1". */
  readonly version?: string;
  /** What is wrong, in the person's words. */
  readonly problem?: string;
  readonly install?: GitInstall;
}

export interface GitProbe {
  readonly platform: NodeJS.Platform;
  /** git as PATH finds it, or undefined. */
  readonly onPath: Effect.Effect<string | undefined>;
  /** `xcode-select -p`: the active developer folder, or undefined when there is none. */
  readonly developerDir: Effect.Effect<string | undefined>;
  readonly exists: (file: string) => boolean;
  /** `git --version` as the runtime runs git; undefined when git could not be started at all. */
  readonly version: Effect.Effect<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string } | undefined>;
  /** Windows: Git for Windows' bash.exe (findGitBash), or undefined. */
  readonly gitBash?: () => string | undefined;
}

const MAC_TOOLS: GitInstall = { label: "Install developer tools", command: "xcode-select --install", runs: true };
const MAC_NO_TOOLS = "Git comes with Apple's Command Line Tools, which this Mac doesn't have yet. Installing them takes a few minutes.";
const WINDOWS_GIT: GitInstall = { label: "Install Git for Windows", url: "https://git-scm.com/download/win", command: "winget install --id Git.Git -e --source winget" };

const missing = (platform: NodeJS.Platform): GitInstalled =>
  platform === "darwin"
    ? { ready: false, problem: MAC_NO_TOOLS, install: MAC_TOOLS }
    : platform === "win32"
      ? { ready: false, problem: "Git for Windows isn't installed. Caveman Code needs its git, and the bash Claude Code and the Caveman engine run commands in.", install: WINDOWS_GIT }
      : { ready: false, problem: "git isn't installed. Install it with your package manager, then check again." };

/** Whether git runs here, and if not, why and how to get it. Never runs Apple's stub while it would only ask to install. */
export const checkGit = (probe: GitProbe): Effect.Effect<GitInstalled> =>
  Effect.gen(function* () {
    if (probe.platform === "darwin") {
      const found = yield* probe.onPath;
      if (found === undefined || found === "/usr/bin/git") {
        const developer = yield* probe.developerDir;
        if (developer === undefined || !probe.exists(path.join(developer, "usr", "bin", "git"))) return missing("darwin");
      }
    }
    const ran = yield* probe.version;
    if (ran === undefined) return missing(probe.platform);
    if (ran.exitCode !== 0) {
      if (probe.platform === "darwin" && /license/i.test(ran.stderr))
        return { ready: false, problem: "Xcode's license hasn't been accepted on this Mac, so git won't run. Accept it in Terminal, then check again.", install: { label: "Accept the license", command: "sudo xcodebuild -license accept" } };
      if (probe.platform === "darwin" && /xcrun|developer tools|xcode-select/i.test(ran.stderr)) return missing("darwin");
      const said = ran.stderr.trim().split(/\r?\n/).at(-1) ?? "";
      return { ready: false, problem: `git doesn't run here: ${said || `it exited ${ran.exitCode}`}` };
    }
    const version = /git version (\S+)/.exec(ran.stdout)?.[1] ?? ran.stdout.trim();
    if (probe.platform === "win32" && probe.gitBash?.() === undefined)
      return { ready: false, version, problem: "Git is here, but not Git for Windows' bash, which Claude Code and the Caveman engine run commands in.", install: WINDOWS_GIT };
    return { ready: true, version };
  });

/** A git failure while adding or cloning a project, in the person's words when git itself is what's missing. */
export const gitProblem = (installed: GitInstalled, fallback: string) => (installed.ready || installed.problem === undefined ? fallback : installed.problem);
