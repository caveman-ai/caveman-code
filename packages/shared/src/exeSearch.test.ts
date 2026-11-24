import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { stopCurrentDirectoryExeSearch } from "./exeSearch.ts";

const ENV = "NoDefaultCurrentDirectoryInExePath";

describe("stopCurrentDirectoryExeSearch", () => {
  it("sets the switch on Windows only", () => {
    const windows: NodeJS.ProcessEnv = {};
    stopCurrentDirectoryExeSearch(windows, "win32");
    expect(windows[ENV]).toBe("1");
    for (const platform of ["darwin", "linux"] as const) {
      const env: NodeJS.ProcessEnv = {};
      stopCurrentDirectoryExeSearch(env, platform);
      expect(env).toEqual({});
    }
  });
});

// Windows only: the current-directory search is Windows' (libuv's search_path); elsewhere a bare name is PATH only.
describe.runIf(process.platform === "win32")("a git.exe planted in a project folder (Windows)", () => {
  const cwd = process.cwd();
  const saved = process.env[ENV];
  const dirs: string[] = [];
  afterEach(() => {
    process.chdir(cwd);
    if (saved === undefined) delete process.env[ENV];
    else process.env[ENV] = saved;
    // The planted git.exe just ran: Windows can hold its folder a moment after it exits.
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });

  /** A folder holding `git.exe`, a copy of this Node: run with `--version` it prints `v24...`, the real git `git version ...`. */
  function planted(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-planted-"));
    dirs.push(dir);
    fs.copyFileSync(process.execPath, path.join(dir, "git.exe"));
    return dir;
  }
  const version = (options: { cwd?: string }) => spawnSync("git", ["--version"], { ...options, encoding: "utf8", windowsHide: true, timeout: 30_000 }).stdout.trim();

  it("runs without the switch: the plant is reachable", () => {
    delete process.env[ENV];
    expect(version({ cwd: planted() })).toMatch(/^v\d+\./);
  });

  it("is skipped with the switch, for an explicit cwd", () => {
    stopCurrentDirectoryExeSearch();
    expect(version({ cwd: planted() })).toMatch(/^git version /);
  });

  it("is skipped with the switch, for the process's own cwd", () => {
    stopCurrentDirectoryExeSearch();
    process.chdir(planted());
    expect(version({})).toMatch(/^git version /);
  });

  it("is skipped with the switch by a shell the process starts", () => {
    stopCurrentDirectoryExeSearch();
    const dir = planted();
    const out = spawnSync("git --version", { cwd: dir, shell: true, encoding: "utf8", windowsHide: true, timeout: 30_000 }).stdout.trim();
    expect(out).toMatch(/^git version /);
  });
});
