import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

import { findGitBash, PosixShellMissingError, posixShellCommand } from "./posixShell.ts";

const files = (...paths: Array<string>) => {
  const set = new Set(paths.map((p) => p.toLowerCase()));
  return (file: string) => set.has(file.toLowerCase());
};

describe("findGitBash", () => {
  it("finds the bash of the Git for Windows whose git.exe is on PATH, never WSL's", () => {
    const exists = files("C:\\Windows\\System32\\bash.exe", "D:\\Tools\\Git\\cmd\\git.exe", "D:\\Tools\\Git\\bin\\bash.exe");
    expect(findGitBash({ Path: "C:\\Windows\\System32;D:\\Tools\\Git\\cmd" }, exists)).toBe("D:\\Tools\\Git\\bin\\bash.exe");
  });

  it("walks up from mingw64\\bin and falls back to usr\\bin", () => {
    const exists = files("E:\\Git\\mingw64\\bin\\git.exe", "E:\\Git\\usr\\bin\\bash.exe");
    expect(findGitBash({ PATH: "E:\\Git\\mingw64\\bin" }, exists)).toBe("E:\\Git\\usr\\bin\\bash.exe");
  });

  it("takes CLAUDE_CODE_GIT_BASH_PATH first, then the default install locations", () => {
    expect(findGitBash({ CLAUDE_CODE_GIT_BASH_PATH: "F:\\bash.exe" }, files("F:\\bash.exe"))).toBe("F:\\bash.exe");
    expect(findGitBash({ ProgramFiles: "C:\\Program Files" }, files("C:\\Program Files\\Git\\bin\\bash.exe"))).toBe("C:\\Program Files\\Git\\bin\\bash.exe");
    expect(findGitBash({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" }, files("C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe"))).toBe(
      "C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe",
    );
    expect(findGitBash({ PATH: "C:\\Windows\\System32" }, files("C:\\Windows\\System32\\bash.exe"))).toBeUndefined();
  });

  // Started in a project, a relative path is the project's own: `.\cmd\git.exe` beside `.\bin\bash.exe`.
  it("skips every relative path: PATH entries, CLAUDE_CODE_GIT_BASH_PATH and install roots", () => {
    const planted = files("cmd\\git.exe", "bin\\bash.exe", ".\\bash.exe", "Git\\bin\\bash.exe", "C:\\Git\\cmd\\git.exe", "C:\\Git\\bin\\bash.exe");
    expect(findGitBash({ PATH: ".;cmd;.\\cmd", CLAUDE_CODE_GIT_BASH_PATH: ".\\bash.exe", ProgramFiles: ".", LOCALAPPDATA: "" }, planted)).toBeUndefined();
    expect(findGitBash({ PATH: "cmd;C:\\Git\\cmd" }, planted)).toBe("C:\\Git\\bin\\bash.exe");
  });
});

describe("posixShellCommand", () => {
  it("is /bin/sh -c off Windows and Git Bash -c on it, with a clear error when it is missing", () => {
    expect(posixShellCommand("echo $1", ["sh", "x"], { platform: "darwin" })).toEqual({ command: "/bin/sh", args: ["-c", "echo $1", "sh", "x"] });
    expect(posixShellCommand("true", [], { platform: "win32", env: { CLAUDE_CODE_GIT_BASH_PATH: "G:\\bash.exe" }, exists: files("G:\\bash.exe") })).toEqual({
      command: "G:\\bash.exe",
      args: ["-c", "true"],
    });
    expect(() => posixShellCommand("true", [], { platform: "win32", env: {}, exists: () => false })).toThrow(PosixShellMissingError);
  });

  it("runs a POSIX script with its arguments on this machine", () => {
    const { command, args } = posixShellCommand('printf "%s|%s" "$1" "$(echo ok)"', ["sh", "a b"]);
    expect(execFileSync(command, args, { encoding: "utf8", windowsHide: true })).toBe("a b|ok");
  });
});
