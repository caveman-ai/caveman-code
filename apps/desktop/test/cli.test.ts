import { execFile, execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addToUserPath, cliStatus, installOnPath, launcherPath, MARKER, registryUserPath, renderLauncher, userPathStatus, writeLauncher, type UserPath } from "../src/cli.ts";

// The administrator prompt (osascript) is recorded, never run; anything else (Windows' PowerShell) runs.
vi.mock("node:child_process", async (actual) => {
  const real = await actual<typeof import("node:child_process")>();
  return {
    ...real,
    execFile: vi.fn((file: string, args: string[], options: object, callback: (error: Error | null, out: string, err: string) => void) =>
      file === "/usr/bin/osascript" ? callback(null, "", "") : real.execFile(file, args, options, callback),
    ),
  };
});

const temp = () => mkdtempSync(join(tmpdir(), "caveman-cli-"));

const WINDOWS = process.platform === "win32";

/** A stand-in runtime dir: `node` (`node.exe`) is this Node, and bin.mjs prints its argv. */
function fakeRuntime(parent: string, name = "it's Caveman Code.app"): string {
  const dir = join(parent, name, "runtime");
  mkdirSync(dir, { recursive: true });
  const node = join(dir, WINDOWS ? "node.exe" : "node");
  // A hard link where it can (same volume), else a copy: a symlink needs Developer Mode on Windows.
  try {
    linkSync(process.execPath, node);
  } catch {
    copyFileSync(process.execPath, node);
  }
  writeFileSync(join(dir, "bin.mjs"), "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return dir;
}

/** Runs the launcher as a terminal would: directly, or on Windows through cmd.exe (Node runs no .cmd without it). */
const runLauncher = (launcher: string, args: string[]): string => {
  const run = WINDOWS
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[launcher, ...args].map((a) => `"${a}"`).join(" ")}"`], { encoding: "utf8", windowsVerbatimArguments: true })
    : spawnSync(launcher, args, { encoding: "utf8" });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${launcher} exited ${run.status}: ${run.stderr}`);
  return run.stdout;
};

describe("caveman-code launcher", () => {
  it("runs the bundled runtime's code command with the arguments, from a path with a quote in it", () => {
    const root = temp();
    const runtime = fakeRuntime(root);
    const launcher = writeLauncher(join(root, "home"), runtime, () => undefined)!;
    expect(launcher).toBe(launcherPath(join(root, "home")));
    expect(JSON.parse(runLauncher(launcher, ["attach", "s 1"]))).toEqual(["code", "attach", "s 1"]);
  });

  // What cmd.exe reads specially in a batch file: % (expansion, even quoted), ! (delayed expansion), & and the
  // parentheses of "Program Files (x86)" (a parenthesized block), and a path outside ASCII (the console code page).
  it("runs from a path with %, !, &, parentheses and letters outside ASCII", () => {
    const root = temp();
    for (const name of ["100% & (x86) !Caveman! Code", "Cavémán Côde 洞穴"]) {
      const launcher = writeLauncher(join(root, `home ${name}`), fakeRuntime(root, name), () => undefined)!;
      expect(JSON.parse(runLauncher(launcher, ["attach", "s 1"]))).toEqual(["code", "attach", "s 1"]);
    }
  });

  it("says the app moved when the runtime is gone, and leaves a file it did not write", () => {
    const root = temp();
    const launcher = writeLauncher(join(root, "home"), join(root, "gone"), () => undefined)!;
    expect(() => runLauncher(launcher, [])).toThrow(/exited 127: Caveman Code has moved or been removed/);
    const foreign = join(root, "other");
    mkdirSync(join(foreign, "bin"), { recursive: true });
    writeFileSync(launcherPath(foreign), "#!/bin/sh\necho mine\n");
    const lines: string[] = [];
    expect(writeLauncher(foreign, join(root, "gone"), (l) => lines.push(l))).toBeUndefined();
    expect(readFileSync(launcherPath(foreign), "utf8")).toBe("#!/bin/sh\necho mine\n");
    expect(lines.join("\n")).toMatch(/did not write/);
  });

  it("is a CRLF caveman-code.cmd on Windows, with % doubled and no delayed expansion", () => {
    expect(launcherPath("C:\\Users\\me\\.caveman-code", "win32")).toBe(join("C:\\Users\\me\\.caveman-code", "bin", "caveman-code.cmd"));
    const ascii = renderLauncher("C:\\Program Files (x86)\\100% Caveman\\resources\\runtime", "win32");
    expect(ascii.split("\r\n").every((line) => !line.includes("\n"))).toBe(true);
    expect(ascii).toContain(MARKER);
    expect(ascii).toContain("setlocal EnableExtensions DisableDelayedExpansion");
    expect(ascii).toContain('"C:\\Program Files (x86)\\100%% Caveman\\resources\\runtime\\node.exe" "C:\\Program Files (x86)\\100%% Caveman\\resources\\runtime\\bin.mjs" code %*');
    expect(ascii).not.toContain("chcp");
    expect(renderLauncher("C:\\Users\\Zoë\\AppData\\Local\\Programs\\Caveman Code\\resources\\runtime", "win32")).toContain("chcp 65001 >nul");
  });

  // Windows puts the launcher's folder on the user's PATH instead (below).
  it.skipIf(WINDOWS)("links the launcher onto PATH, replaces an older link of ours, and never a foreign file", async () => {
    const root = temp();
    const launcher = writeLauncher(join(root, "home"), fakeRuntime(root), () => undefined)!;
    const link = join(root, "bin", "caveman-code");
    expect(cliStatus(launcher, link)).toMatchObject({ onPath: false, conflict: false });
    expect(await installOnPath(launcher, link)).toMatchObject({ onPath: true, conflict: false });
    expect(readlinkSync(link)).toBe(launcher);

    const older = writeLauncher(join(root, "old-home"), fakeRuntime(join(root, "old")), () => undefined)!;
    expect(await installOnPath(older, link)).toMatchObject({ onPath: true });
    expect(readlinkSync(link)).toBe(older);

    const foreign = join(root, "bin", "foreign");
    writeFileSync(foreign, "#!/bin/sh\n");
    expect(await installOnPath(launcher, foreign)).toMatchObject({ onPath: false, conflict: true });
    expect(readFileSync(foreign, "utf8")).not.toContain(MARKER);
  });

  // macOS only: /usr/local/bin and osascript; a Windows user's PATH needs no administrator.
  it.skipIf(WINDOWS)("asks for an administrator when an older link of ours sits in a directory it cannot write", async () => {
    if (process.getuid?.() === 0) return; // root writes anywhere
    const root = temp();
    const older = writeLauncher(join(root, "old-home"), fakeRuntime(join(root, "old")), () => undefined)!;
    const launcher = writeLauncher(join(root, "home"), fakeRuntime(root), () => undefined)!;
    const bin = join(root, "bin");
    mkdirSync(bin);
    const link = join(bin, "caveman-code");
    symlinkSync(older, link);
    chmodSync(bin, 0o555);
    try {
      const status = await installOnPath(launcher, link);
      expect(status.error).toBeUndefined();
      expect(vi.mocked(execFile)).toHaveBeenCalledWith("/usr/bin/osascript", expect.arrayContaining([launcher, bin, link]), expect.anything(), expect.any(Function));
    } finally {
      chmodSync(bin, 0o755);
    }
  });
});

describe("caveman-code on the Windows user PATH", () => {
  const memoryPath = (value: string): UserPath & { value: string; writes: number } => {
    const path = {
      value,
      writes: 0,
      read: async () => path.value,
      write: async (next: string) => {
        path.value = next;
        path.writes += 1;
      },
    };
    return path;
  };

  it("adds the launcher's folder once, after the entries already there, and says so", async () => {
    const launcher = launcherPath(join(temp(), "home"), "win32");
    const bin = dirname(launcher);
    const path = memoryPath("%USERPROFILE%\\.cargo\\bin;C:\\Tools");
    expect(await userPathStatus(launcher, path)).toMatchObject({ onPath: false, link: bin, via: "user-path", conflict: false });
    expect(await addToUserPath(launcher, path)).toMatchObject({ onPath: true, link: bin, via: "user-path" });
    expect(path.value).toBe(`%USERPROFILE%\\.cargo\\bin;C:\\Tools;${bin}`);
    // Already there, in another case or with a trailing separator: nothing written.
    path.value = `${bin.toUpperCase()}\\;C:\\Tools`;
    expect(await addToUserPath(launcher, path)).toMatchObject({ onPath: true });
    expect(path.writes).toBe(1);
  });

  it("leaves the PATH alone when it cannot read it", async () => {
    const launcher = launcherPath(join(temp(), "home"), "win32");
    let wrote = false;
    const broken: UserPath = {
      read: () => Promise.reject(new Error("Could not read your PATH, so it was left unchanged.")),
      write: async () => void (wrote = true),
    };
    expect(await addToUserPath(launcher, broken)).toMatchObject({ onPath: false, error: "Could not read your PATH, so it was left unchanged." });
    expect(wrote).toBe(false);
  });

  it("reads the registry PATH as a read whatever this process's environment says, and only as base64", async () => {
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const answer = (out: string) =>
      vi.mocked(execFile).mockImplementationOnce(((_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }, callback: (error: Error | null, out: string, err: string) => void) => {
        envs.push(options.env);
        callback(null, out, "");
      }) as never);
    const before = process.env.CAVEMAN_PATH_SET;
    process.env.CAVEMAN_PATH_SET = "1";
    try {
      answer(`${Buffer.from("C:\\bin;%USERPROFILE%\\x").toString("base64")}\r\n`);
      expect(await registryUserPath("Elsewhere").read()).toBe("C:\\bin;%USERPROFILE%\\x");
      // A profile that printed a line first: not the PATH to write back.
      answer("Welcome!\nQzpcYmlu");
      await expect(registryUserPath("Elsewhere").read()).rejects.toThrow("Could not read your PATH, so it was left unchanged.");
      expect(envs).toHaveLength(2);
      for (const env of envs) expect(env).toMatchObject({ CAVEMAN_PATH_SET: "0", CAVEMAN_PATH_NAME: "Elsewhere" });
    } finally {
      if (before === undefined) delete process.env.CAVEMAN_PATH_SET;
      else process.env.CAVEMAN_PATH_SET = before;
    }
  });

  // The registry exists only on Windows. A value of its own beside Path, so the runner's PATH is never touched.
  it.skipIf(!WINDOWS)("reads and writes the registry value as REG_EXPAND_SZ, keeping %VAR% entries unexpanded", { timeout: 120_000 }, async () => {
    const name = `CavemanCodeTest${process.pid}`;
    const path = registryUserPath(name);
    try {
      expect(await path.read()).toBe("");
      await path.write("%USERPROFILE%\\bin;C:\\Program Files (x86)\\Tools;C:\\Zoë");
      expect(await path.read()).toBe("%USERPROFILE%\\bin;C:\\Program Files (x86)\\Tools;C:\\Zoë");
      expect(execFileSync("reg", ["query", "HKCU\\Environment", "/v", name], { encoding: "utf8" })).toMatch(/REG_EXPAND_SZ\s+%USERPROFILE%\\bin;/);
    } finally {
      try {
        execFileSync("reg", ["delete", "HKCU\\Environment", "/v", name, "/f"], { stdio: "ignore" });
      } catch {
        // never written
      }
    }
  });
});
