// The `caveman-code` command: a launcher for the runtime bundled in this app
// (`caveman-code` = `caveman code`, packages/runtime/src/cli/code.ts).
// Ported in spirit .ts (MIT,
// ab3a3cd1): the packaged app keeps the launcher current in the Caveman Code
// home (~/.caveman-code/bin, never on PATH, so it shadows nothing), and on the
// person's say-so links it into /usr/local/bin. On Windows the launcher is
// `caveman-code.cmd` (upstream DesktopCliShim.ts form), and installing adds its
// folder to the user's PATH (HKCU, no administrator; upstream
// DesktopCliCommand.ts). The name is not `caveman`, which is the v4 CLI's
// (@caveman-ai/cli).
import { execFile } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeFileStaged } from "./stagedWrite.ts";

export const MARKER = "Written by Caveman Code: runs the desktop app's bundled runtime.";
export const COMMAND = "caveman-code";
export const PATH_LINK = `/usr/local/bin/${COMMAND}`;

const MOVED = "Caveman Code has moved or been removed. Open the app once to update this command.";
const shellWord = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
/** cmd.exe expands `%` even inside quotes; Windows paths cannot hold `"`. */
const cmdText = (value: string) => value.replaceAll("%", "%%");
const cmdWord = (value: string) => `"${cmdText(value)}"`;

/** The launcher: the bundled Node runs the bundled runtime's `code` command. */
export const renderLauncher = (runtimeDir: string, platform: NodeJS.Platform = process.platform): string => {
  if (platform === "win32") return renderWindowsLauncher(runtimeDir);
  return [
    "#!/bin/sh",
    `# ${MARKER}`,
    `runtime=${shellWord(runtimeDir)}`,
    'if [ ! -x "$runtime/node" ]; then',
    `  echo "${MOVED}" >&2`,
    "  exit 127",
    "fi",
    'exec "$runtime/node" "$runtime/bin.mjs" code "$@"',
    "",
  ].join("\n");
};

/**
 * `caveman-code.cmd`, .cmd (DesktopCliShim.ts, MIT): CRLF, no delayed expansion (it would rewrite
 * `!name!` in paths and arguments), and a goto rather than a parenthesized block, which "Program Files (x86)" would
 * close early. The file is UTF-8: only a runtime path outside ASCII switches the console to code page 65001 to read
 * it, and back after, since a Ctrl-C that ends the batch skips the restore.
 */
const renderWindowsLauncher = (runtimeDir: string): string => {
  const node = `${runtimeDir}\\node.exe`;
  const entry = `${runtimeDir}\\bin.mjs`;
  const utf8 = [...runtimeDir].some((character) => character.codePointAt(0)! > 0x7f);
  const restore = utf8 ? ["chcp %caveman_codepage% >nul"] : [];
  return [
    "@echo off",
    `rem ${MARKER}`,
    "setlocal EnableExtensions DisableDelayedExpansion",
    ...(utf8 ? [`for /f "tokens=2 delims=:." %%c in ('chcp') do set "caveman_codepage=%%c"`, "chcp 65001 >nul"] : []),
    `if exist ${cmdWord(node)} goto run`,
    ...restore,
    `echo ${MOVED} 1>&2`,
    "exit /b 127",
    ":run",
    `${cmdWord(node)} ${cmdWord(entry)} code %*`,
    'set "caveman_exit=%ERRORLEVEL%"',
    ...restore,
    "exit /b %caveman_exit%",
    "",
  ].join("\r\n");
};

export const launcherPath = (home: string, platform: NodeJS.Platform = process.platform) =>
  join(home, "bin", platform === "win32" ? `${COMMAND}.cmd` : COMMAND);

/**
 * Writes the launcher for `runtimeDir` to `<home>/bin/caveman-code` when it
 * differs (written beside it and renamed over it, so a running command never
 * reads half a file). Leaves a file it did not write. Returns the path, or
 * undefined when it could not or would not write.
 */
export function writeLauncher(home: string, runtimeDir: string, log: (line: string) => void, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = launcherPath(home, platform);
  const content = renderLauncher(runtimeDir, platform);
  try {
    let existing: string | undefined;
    try {
      existing = readFileSync(path, "utf8");
    } catch {
      existing = undefined;
    }
    if (existing !== undefined && !existing.includes(MARKER)) {
      log(`cli: leaving ${path}, which this app did not write`);
      return undefined;
    }
    if (existing !== content) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileStaged(path, content, { mode: 0o755 });
      log(`cli: wrote ${path}`);
    }
    return path;
  } catch (error) {
    log(`cli: could not write ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export interface CliStatus {
  /** The launcher in the Caveman Code home, if this app wrote it. */
  readonly launcher: string | null;
  /** PATH_LINK points at the launcher; on Windows, the launcher's folder is on the user's PATH. */
  readonly onPath: boolean;
  /** PATH_LINK; on Windows, the launcher's folder. */
  readonly link: string;
  /** How installing puts the command on PATH: a link (macOS), or the folder added to the user's PATH (Windows). */
  readonly via: "link" | "user-path";
  /** Something else sits at PATH_LINK. */
  readonly conflict: boolean;
  readonly error?: string;
}

export function cliStatus(launcher: string | undefined, link = PATH_LINK): CliStatus {
  let target: string | undefined;
  let present = true;
  try {
    target = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : undefined;
  } catch {
    present = false;
  }
  const onPath = launcher !== undefined && target === launcher;
  // A link to another launcher of ours (an older home) is replaced; anything else is left alone.
  let ours = false;
  try {
    ours = target !== undefined && readFileSync(link, "utf8").includes(MARKER);
  } catch {
    ours = false;
  }
  return { launcher: launcher ?? null, onPath, link, via: "link", conflict: present && !onPath && !ours };
}

const run = (file: string, args: ReadonlyArray<string>) =>
  new Promise<void>((resolve, reject) => execFile(file, [...args], { timeout: 120_000 }, (error, _out, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve())));

/**
 * Links `link` to the launcher. Replaces only a link to an older launcher of
 * ours; asks macOS for an administrator when /usr/local/bin is not writable.
 */
export async function installOnPath(launcher: string | undefined, link = PATH_LINK): Promise<CliStatus> {
  const before = cliStatus(launcher, link);
  if (!launcher || before.onPath || before.conflict) return before;
  try {
    try {
      mkdirSync(dirname(link), { recursive: true });
      try {
        unlinkSync(link);
      } catch (error) {
        // Nothing there yet is fine; an older link in a root-owned directory goes to the administrator path below.
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      symlinkSync(launcher, link);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EACCES" && (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
      // The paths travel as argv, never inside the script text.
      await run("/usr/bin/osascript", [
        "-e",
        "on run argv",
        "-e",
        'do shell script "mkdir -p " & quoted form of (item 2 of argv) & " && ln -sfn " & quoted form of (item 1 of argv) & " " & quoted form of (item 3 of argv) with administrator privileges',
        "-e",
        "end run",
        launcher,
        dirname(link),
        link,
      ]);
    }
    return cliStatus(launcher, link);
  } catch (error) {
    return { ...cliStatus(launcher, link), error: error instanceof Error ? error.message : String(error) };
  }
}

/** The user's PATH as Windows keeps it (HKCU\\Environment), `%VAR%` entries unexpanded. */
export interface UserPath {
  read(): Promise<string>;
  write(value: string): Promise<void>;
}

const pathEntries = (value: string) => value.split(";").filter((entry) => entry.length > 0);
/** Windows paths compare without case or a trailing separator. */
const sameWindowsPath = (a: string, b: string) => a.replace(/[\\/]+$/, "").toLowerCase() === b.replace(/[\\/]+$/, "").toLowerCase();
export const pathHasEntry = (value: string, dir: string): boolean => pathEntries(value).some((entry) => sameWindowsPath(entry, dir));

/**
 * Reads, or with CAVEMAN_PATH_SET=1 writes CAVEMAN_PATH_VALUE to, the user's PATH in the registry (value
 * CAVEMAN_PATH_NAME, `Path` unless a test names another), keeping `%VAR%` entries unexpanded. A write keeps
 * REG_EXPAND_SZ (SetEnvironmentVariable would store REG_SZ and break every `%VAR%` entry), then broadcasts
 * WM_SETTINGCHANGE so Explorer and the terminals it opens see it. A failed read exits nonzero rather than read as
 * empty, so a write never replaces the PATH wholesale. .ts (MIT).
 */
export const WINDOWS_USER_PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$name = if ($env:CAVEMAN_PATH_NAME) { $env:CAVEMAN_PATH_NAME } else { 'Path' }
if ($env:CAVEMAN_PATH_SET -eq '1') {
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
  $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($key.GetValueNames() -contains $name -and $key.GetValueKind($name) -eq 'String') {
    $kind = [Microsoft.Win32.RegistryValueKind]::String
  }
  $key.SetValue($name, $env:CAVEMAN_PATH_VALUE, $kind)
  Add-Type -Namespace CavemanCode -Name Env -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'
  $result = [System.UIntPtr]::Zero
  [void][CavemanCode.Env]::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
} else {
  $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  $value = if ($key) { $key.GetValue($name, '', 'DoNotExpandEnvironmentNames') } else { '' }
  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$value)))
}
`;

/** The user's PATH through PowerShell (WINDOWS_USER_PATH_SCRIPT). `name`: another value under HKCU\\Environment, for tests. */
export const registryUserPath = (name = "Path"): UserPath => {
  const powershell = (env: Record<string, string>) =>
    new Promise<string>((resolve, reject) => {
      const root = process.env.SystemRoot || process.env.windir || "C:\\Windows";
      execFile(
        join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_USER_PATH_SCRIPT],
        { env: { ...process.env, CAVEMAN_PATH_NAME: name, ...env }, timeout: 60_000, windowsHide: true },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      );
    });
  return {
    read: async () => {
      try {
        // CAVEMAN_PATH_SET "0": a read, whatever this process's own environment says. Only base64 is an answer: a
        // profile or module that printed anything else must not become the PATH written back.
        const out = (await powershell({ CAVEMAN_PATH_SET: "0" })).trim();
        if (!/^[A-Za-z0-9+/=]*$/.test(out)) throw new Error("not base64");
        return Buffer.from(out, "base64").toString("utf8");
      } catch {
        throw new Error("Could not read your PATH, so it was left unchanged.");
      }
    },
    write: async (value) => {
      try {
        await powershell({ CAVEMAN_PATH_SET: "1", CAVEMAN_PATH_VALUE: value });
      } catch {
        throw new Error("Could not update your PATH.");
      }
    },
  };
};

/** Windows: whether the launcher's folder is on the user's PATH (as new terminals get it, not this process's). */
export async function userPathStatus(launcher: string | undefined, userPath: UserPath): Promise<CliStatus> {
  const dir = launcher ? dirname(launcher) : "";
  const base = { launcher: launcher ?? null, onPath: false, link: dir, via: "user-path" as const, conflict: false };
  if (!launcher) return base;
  try {
    return { ...base, onPath: pathHasEntry(await userPath.read(), dir) };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Windows: adds the launcher's folder to the end of the user's PATH (no administrator), once. Terminals opened after it see the command. */
export async function addToUserPath(launcher: string | undefined, userPath: UserPath): Promise<CliStatus> {
  const before = await userPathStatus(launcher, userPath);
  if (!launcher || before.onPath || before.error) return before;
  try {
    const value = await userPath.read();
    await userPath.write([...pathEntries(value), dirname(launcher)].join(";"));
    return await userPathStatus(launcher, userPath);
  } catch (error) {
    return { ...before, error: error instanceof Error ? error.message : String(error) };
  }
}
