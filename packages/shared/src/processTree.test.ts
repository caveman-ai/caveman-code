import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { killProcessTree, killProcessTreeAsync, taskkillPath } from "./processTree.ts";

const ENV = "NoDefaultCurrentDirectoryInExePath";
const cwd = process.cwd();
const saved = process.env[ENV];
const dirs: string[] = [];
const children: number[] = [];
afterEach(() => {
  process.chdir(cwd);
  if (saved === undefined) delete process.env[ENV];
  else process.env[ENV] = saved;
  for (const pid of children.splice(0)) {
    try {
      process.kill(pid);
    } catch {}
  }
  // Retried: on Windows a taskkill still finishing in the planted folder (its cwd) holds it a moment longer.
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
});

it("names System32's taskkill.exe by full path", () => {
  expect(taskkillPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\taskkill.exe");
  expect(taskkillPath({ windir: "E:\\Windows" })).toBe("E:\\Windows\\System32\\taskkill.exe");
  expect(taskkillPath({})).toBe("C:\\Windows\\System32\\taskkill.exe");
});

/** Whether `child` exits within 15 s. */
async function exits(child: ReturnType<typeof spawn>): Promise<boolean> {
  const timer = new Promise<false>((resolve) => setTimeout(() => resolve(false), 15_000).unref());
  return Promise.race([once(child, "exit").then(() => true), timer]);
}

/** A child that runs until killed. */
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: os.tmpdir(), stdio: "ignore", windowsHide: true });
  if (child.pid !== undefined) children.push(child.pid);
  return child;
}

describe.each([
  ["killProcessTree", killProcessTree],
  ["killProcessTreeAsync", killProcessTreeAsync],
] as const)("%s", (_name, kill) => {
  it("stops a running child", async () => {
    const child = sleeper();
    await once(child, "spawn");
    const exited = exits(child);
    kill(child.pid);
    expect(await exited).toBe(true);
  });

  // Windows only: the current-directory search for a bare name is Windows' own (libuv's search_path).
  it.runIf(process.platform === "win32")("runs the real taskkill when the current folder holds a taskkill.exe", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-planted-"));
    dirs.push(dir);
    // A copy of Node: run as `taskkill /pid N /T /F` it fails to load `/pid` and stops nothing.
    fs.copyFileSync(process.execPath, path.join(dir, "taskkill.exe"));
    delete process.env[ENV];
    process.chdir(dir);
    const child = sleeper();
    await once(child, "spawn");
    const exited = exits(child);
    kill(child.pid);
    expect(await exited).toBe(true);
  });
});
