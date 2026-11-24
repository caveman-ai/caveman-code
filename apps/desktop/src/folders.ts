// Reveal in Finder (File Explorer on Windows) and Open in Terminal for a
// project's folder or a chat's worktree (the sidebar's menus). The page names
// a path; main only ever reveals it (showItemInFolder, which selects and never
// opens or runs anything) or opens a terminal at a directory, and only for an
// absolute, existing path. Electron-free, so it tests without Electron.
import { existsSync, lstatSync, statSync } from "node:fs";
import { isAbsolute, normalize, win32 } from "node:path";

/** The directory to act on, or null: absolute, normalized, existing, a directory. */
export function folderToOpen(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.includes("\0") || !isAbsolute(raw)) return null;
  const path = normalize(raw);
  try {
    return statSync(path).isDirectory() ? path : null;
  } catch {
    return null;
  }
}

export interface TerminalCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  /** Started in this directory; the folder then never enters a command line another program parses. */
  readonly cwd?: string;
  /** Windows: `args` are cmd.exe's command line as is (spawn's windowsVerbatimArguments), not quoted by Node. */
  readonly verbatim?: boolean;
}

/**
 * A new terminal window in `dir`: Terminal on macOS (`open -a Terminal <dir>`); on Windows, Windows Terminal when it
 * is installed (its `wt.exe` alias, `-d .` from the folder), else a Command Prompt window that `start` opens there,
 * as VS Code's external terminal does. Every program by absolute path: started in the folder, a bare `cmd.exe`
 * would be the folder's own copy first. Null where none is offered.
 */
export function terminalCommand(dir: string, platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (path: string) => boolean = isFile): TerminalCommand | null {
  if (platform === "darwin") return { command: "open", args: ["-a", "Terminal", dir] };
  if (platform !== "win32") return null;
  const wt = env.LOCALAPPDATA && WINDOWS_ABSOLUTE.test(env.LOCALAPPDATA) ? win32.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "wt.exe") : undefined;
  if (wt && exists(wt)) return { command: wt, args: ["-d", "."], cwd: dir };
  const cmd = commandPrompt(env);
  // `start`'s first quoted argument is the window's title. /s: cmd.exe drops the outer quotes and keeps the rest.
  return { command: cmd, args: ["/d", "/s", "/c", `"start "" "${cmd}""`], cwd: dir, verbatim: true };
}

/** A drive or UNC path: never resolved against the folder a program starts in. */
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:\\|\\\\)/;

/** cmd.exe by absolute path: ComSpec when it is one (and holds no quote), else System32's. */
function commandPrompt(env: NodeJS.ProcessEnv): string {
  const comspec = env.ComSpec;
  if (comspec && WINDOWS_ABSOLUTE.test(comspec) && !comspec.includes('"')) return comspec;
  return win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "cmd.exe");
}

/** The WindowsApps alias is a reparse point that stat may not follow; lstat sees it. */
const isFile = (path: string): boolean => existsSync(path) || lstatSync(path, { throwIfNoEntry: false }) !== undefined;
