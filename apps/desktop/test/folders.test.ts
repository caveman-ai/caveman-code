import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { folderToOpen, terminalCommand } from "../src/folders.ts";

test("only an absolute, existing directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "caveman-folders-"));
  writeFileSync(join(dir, "f.txt"), "x");
  expect(folderToOpen(dir)).toBe(dir);
  expect(folderToOpen(`${dir}/./sub/..`)).toBe(dir);
  for (const raw of [join(dir, "f.txt"), join(dir, "missing"), "relative/path", "", `${dir}\0x`, 42, null, undefined]) expect(folderToOpen(raw)).toBeNull();
});

test("Terminal opens at the folder, as one argument", () => {
  expect(terminalCommand("/Users/me/My Project", "darwin")).toEqual({ command: "open", args: ["-a", "Terminal", "/Users/me/My Project"] });
});

test("Windows opens Windows Terminal in the folder when it is installed, else a Command Prompt", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", ComSpec: "C:\\Windows\\system32\\cmd.exe" };
  const wt = "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\wt.exe";
  // The folder is the new process's working directory, never part of a command line wt or cmd.exe would parse.
  expect(terminalCommand("C:\\src\\a;b & 100%", "win32", env, (path) => path === wt)).toEqual({ command: wt, args: ["-d", "."], cwd: "C:\\src\\a;b & 100%" });
  // `start` opens cmd.exe by its full path: a bare name would be looked for in the folder first.
  expect(terminalCommand("C:\\src\\a;b & 100%", "win32", env, () => false)).toEqual({
    command: "C:\\Windows\\system32\\cmd.exe",
    args: ["/d", "/s", "/c", '"start "" "C:\\Windows\\system32\\cmd.exe""'],
    cwd: "C:\\src\\a;b & 100%",
    verbatim: true,
  });
  expect(terminalCommand("/home/me", "linux")).toBeNull();
});

test("Windows never runs a program by a path relative to the folder", () => {
  const cmd = "D:\\Win\\System32\\cmd.exe";
  for (const ComSpec of [undefined, "cmd.exe", "System32\\cmd.exe", "C:cmd.exe", 'C:\\a"b\\cmd.exe']) {
    const terminal = terminalCommand("C:\\src", "win32", { ComSpec, SystemRoot: "D:\\Win", LOCALAPPDATA: "AppData" }, () => true);
    expect(terminal).toEqual({ command: cmd, args: ["/d", "/s", "/c", `"start "" "${cmd}""`], cwd: "C:\\src", verbatim: true });
  }
  expect(terminalCommand("C:\\src", "win32", {}, () => false)?.command).toBe("C:\\Windows\\System32\\cmd.exe");
});

// Windows only: cmd.exe's own parsing of the line. `echo` in place of `start` prints what `start` would be given.
test.runIf(process.platform === "win32")("cmd.exe hands `start` a title and the full path", () => {
  const terminal = terminalCommand(tmpdir(), "win32", process.env, () => false)!;
  const echoed = spawnSync(terminal.command, terminal.args.map((arg) => arg.replace('"start ', '"echo ')), {
    cwd: terminal.cwd,
    windowsVerbatimArguments: terminal.verbatim,
    encoding: "utf8",
  });
  expect(echoed.stdout.trim()).toBe(`"" "${terminal.command}"`);
});
