// The live Caveman Code runtime that owns a home, from what it publishes once
// it serves: <home>/userdata/server-runtime.json {pid, origin, startedAt} and
// the 0600 session-protocol.token beside it. `caveman code` and the desktop
// app (when its own runtime exits 78) read it. Plain Node: the desktop main
// process bundles it without Effect.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export interface PublishedRuntime {
  readonly pid: number;
  /** http://127.0.0.1:<port> */
  readonly origin: string;
  /** ws://127.0.0.1:<port>/session/v1 */
  readonly url: string;
  readonly token: string;
}

export const runtimeTokenPath = (home: string) => path.join(home, "userdata", "session-protocol.token");

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * When `pid` started, from ps (whole seconds), or undefined when it cannot say. Windows has no ps, and the one way to
 * ask there, PowerShell, takes 1-3 s to start, synchronously, in the desktop's main process: there it is not asked
 * (an unknown start stays trusted). The runtime's own ownership check (serverOwnership.ts) asks PowerShell, off any
 * UI thread, before a second runtime refuses the state dir; the desktop reads this record only after that.
 */
export function processStartedAt(pid: number): number | undefined {
  if (!Number.isSafeInteger(pid) || pid <= 0 || process.platform === "win32") return undefined;
  try {
    const lstart = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const at = Date.parse(`${lstart} UTC`);
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

export interface DiscoverOptions {
  /**
   * The user who must own the files; process.getuid() by default. Windows has no uid and no mode bits (every file
   * stats uid 0, mode 0666), so there the check is skipped and ownership is the profile's: the home lives under
   * the person's %USERPROFILE%, whose ACL grants only them, SYSTEM and Administrators.
   */
  readonly uid?: number | undefined;
  readonly startedAt?: (pid: number) => number | undefined;
}

/**
 * The runtime that owns `home`, or undefined unless every check holds:
 * userdata/, the record and the token file belong to `uid` and nobody else may
 * write them; the pid is a positive integer, alive, and started no later than
 * the record says (a later start means the pid was reused); the origin is
 * loopback, so the token never goes anywhere else.
 */
export function discoverRuntime(home: string, options: DiscoverOptions = {}): PublishedRuntime | undefined {
  const uid = "uid" in options ? options.uid : process.getuid?.();
  const stateDir = path.join(home, "userdata");
  const recordPath = path.join(stateDir, "server-runtime.json");
  const tokenPath = runtimeTokenPath(home);
  try {
    if (uid !== undefined) {
      for (const file of [stateDir, recordPath, tokenPath]) {
        const stat = fs.statSync(file);
        if (stat.uid !== uid || (stat.mode & 0o022) !== 0) return undefined;
      }
    }
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8")) as { pid?: unknown; origin?: unknown; startedAt?: unknown };
    const { pid, origin } = record;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || typeof origin !== "string") return undefined;
    if (!LOOPBACK.has(new URL(origin).hostname)) return undefined;
    const recordedAt = typeof record.startedAt === "string" ? Date.parse(record.startedAt) : Number.NaN;
    if (!Number.isFinite(recordedAt)) return undefined;
    process.kill(pid, 0); // throws when the pid is gone or another user's
 // As upstream serverOwnership: ps reports whole seconds; an unknown start stays trusted.
    const started = (options.startedAt ?? processStartedAt)(pid);
    if (started !== undefined && started > recordedAt + 1_000) return undefined;
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    return { pid, origin, url: `${origin.replace(/^http/, "ws")}/session/v1`, token };
  } catch {
    return undefined;
  }
}
