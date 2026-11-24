// Stopping a child and what it started. Plain Node: the runtime's launchers use it outside Effect, often in
// finalizers and `exit` handlers, which need the synchronous form.
import { spawn, spawnSync } from "node:child_process";
import { win32 } from "node:path";

interface KillOptions {
  readonly group?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Windows' own taskkill.exe by full path: a bare `taskkill` is looked for in the current directory (a project's,
 * for a runtime started there) and earlier PATH entries first.
 */
export function taskkillPath(env: NodeJS.ProcessEnv = process.env): string {
  return win32.join(env.SystemRoot || env.windir || "C:\\Windows", "System32", "taskkill.exe");
}

const taskkillArgs = (pid: number) => ["/pid", String(pid), "/T", "/F"];

// 0 and 1 would name this process's own group or every process the user owns.
const killable = (pid: number | undefined): pid is number => pid !== undefined && Number.isSafeInteger(pid) && pid > 1;

function signalTree(pid: number, signal: NodeJS.Signals, group: boolean | undefined): void {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch {
    // Already gone.
  }
}

/**
 * Stops process `pid` and its descendants. On Windows there are no signals: `child.kill()` is TerminateProcess of
 * that one process and orphans its children, so the tree goes through `taskkill /T /F`, and this waits for it: for
 * `exit` handlers and finalizers, where nothing asynchronous finishes. Anywhere else use killProcessTreeAsync.
 * Elsewhere `signal` goes to the pid, or to its process group when `group` (a child spawned `detached` leads one).
 * Never throws: a process already gone is the goal.
 */
export function killProcessTree(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM", options: KillOptions = {}): void {
  if (!killable(pid)) return;
  if ((options.platform ?? process.platform) === "win32") {
    spawnSync(taskkillPath(options.env), taskkillArgs(pid), { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    return;
  }
  signalTree(pid, signal, options.group);
}

/** killProcessTree without waiting for taskkill on Windows, so a slow one never stalls the event loop. */
export function killProcessTreeAsync(pid: number | undefined, signal: NodeJS.Signals = "SIGTERM", options: KillOptions = {}): void {
  if (!killable(pid)) return;
  if ((options.platform ?? process.platform) === "win32") {
    const taskkill = spawn(taskkillPath(options.env), taskkillArgs(pid), { stdio: "ignore", windowsHide: true, timeout: 10_000 });
    taskkill.on("error", () => undefined); // no taskkill: nothing more to do
    return;
  }
  signalTree(pid, signal, options.group);
}
