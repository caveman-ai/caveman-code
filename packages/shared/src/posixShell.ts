// Commands people write for a POSIX shell (hooks, automation checks, computer.toml's [setup] and [archive]
// run lines) run in one on every platform: /bin/sh, and on Windows Git for Windows' bash.exe, found from the
// `git` it puts on PATH (Claude Code on Windows needs the same bash). Never C:\Windows\System32\bash.exe: that
// is WSL, another filesystem. Plain Node, synchronous: launchers call it before each spawn.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { envValue } from "./processEnv.ts";

export interface PosixShellCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Thrown on Windows when no Git for Windows bash is installed. */
export class PosixShellMissingError extends Error {
  constructor() {
    super(
      "This command is written for a POSIX shell, which on Windows is Git for Windows' bash; it was not found. " +
        "Install Git for Windows (https://git-scm.com/download/win), or set CLAUDE_CODE_GIT_BASH_PATH to its bash.exe.",
    );
    this.name = "PosixShellMissingError";
  }
}

const isFile = (file: string): boolean => {
  try {
    return NodeFS.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** A drive or UNC path. A relative one would be resolved against the folder a command starts in: a project's. */
const isAbsolute = (file: string): boolean => /^(?:[A-Za-z]:[\\/]|[\\/]{2})/.test(file);

/**
 * Git for Windows' bash.exe, or undefined: CLAUDE_CODE_GIT_BASH_PATH when it names a file (the variable Claude
 * Code reads), else the bash of the install whose git.exe is on PATH (`<root>\cmd`, `<root>\bin` or
 * `<root>\mingw64\bin`), else the default install locations. Only absolute paths: relative PATH entries are skipped.
 */
export function findGitBash(env: Readonly<Record<string, string | undefined>> = process.env, exists: (file: string) => boolean = isFile): string | undefined {
  const path = NodePath.win32;
  const explicit = envValue(env, "CLAUDE_CODE_GIT_BASH_PATH", "win32");
  if (explicit && isAbsolute(explicit) && exists(explicit)) return explicit;
  const roots: Array<string> = [];
  for (const dir of (envValue(env, "PATH", "win32") ?? "").split(";")) {
    if (!isAbsolute(dir) || !exists(path.join(dir, "git.exe"))) continue;
    const parent = path.dirname(dir);
    const folder = path.basename(dir).toLowerCase();
    if (folder === "cmd") roots.push(parent);
    else if (folder === "bin") roots.push(path.basename(parent).toLowerCase().startsWith("mingw") ? path.dirname(parent) : parent);
  }
  for (const base of [envValue(env, "ProgramFiles", "win32"), envValue(env, "ProgramW6432", "win32")]) if (base) roots.push(path.join(base, "Git"));
  const local = envValue(env, "LOCALAPPDATA", "win32");
  if (local) roots.push(path.join(local, "Programs", "Git"));
  for (const root of roots.filter(isAbsolute)) {
    for (const bash of [path.join(root, "bin", "bash.exe"), path.join(root, "usr", "bin", "bash.exe")]) if (exists(bash)) return bash;
  }
  return undefined;
}

/** How to run `script` in a POSIX shell here; extra `args` become $0, $1, … as with `sh -c`. Throws PosixShellMissingError on a Windows without Git Bash. */
export function posixShellCommand(
  script: string,
  args: ReadonlyArray<string> = [],
  options: { readonly platform?: NodeJS.Platform; readonly env?: Readonly<Record<string, string | undefined>>; readonly exists?: (file: string) => boolean } = {},
): PosixShellCommand {
  if ((options.platform ?? process.platform) !== "win32") return { command: "/bin/sh", args: ["-c", script, ...args] };
  const bash = findGitBash(options.env ?? process.env, options.exists);
  if (bash === undefined) throw new PosixShellMissingError();
  return { command: bash, args: ["-c", script, ...args] };
}
