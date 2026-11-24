/**
 * The harness's ExecEnv over the runtime's ExecutionBackend (`@caveman-ai/agent/execution-backend`). On a Cloud
 * computer the backend runs every command and file read or write in the tools container, so the harness's tools
 * (bash, read, edit, write, programs, spill files) never run beside the runtime's Cloud key.
 *
 * The backend is one request and one answer per call: no streamed output and no background processes. So:
 * - a command is `sh -c <command>` on one backend call (what the classic engine ran on a remote backend), its output
 *   stdout then stderr (the classic engine's combinedProcessOutput), not interleaved in arrival order;
 * - a handle is that call still in flight: `background` or a `yieldMs` that passes returns `running` with no output,
 *   poll says running until the call settles and then gives the whole result once, kill aborts the call (the backend
 *   kills the process tree), and onOutput gets the output once, at the end;
 * - stat, listDir, scratchDir and a missing parent on write are small POSIX sh scripts on the backend (GNU, busybox
 *   and BSD tools alike), each path an argument, never part of the script.
 *
 * The backend is shared runtime-wide: close() aborts this env's calls and removes its scratch dir, never the backend.
 *
 * @module provider-caveman/server/backendEnv
 */
import type * as Harness from "@caveman-ai/harness";
import type {
  ExecResult as BackendExecResult,
  ExecutionBackend,
} from "@caveman-ai/agent/execution-backend";
import * as PosixPath from "node:path/posix";

/** What every harness env sets for commands (the harness's ENV_DEFAULTS: a pager would hang a headless run). */
const ENV_DEFAULTS: Readonly<Record<string, string>> = {
  PAGER: "cat",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};
/** The host variables LocalEnv passes, for a backend that runs here (the SDK's local backend): nothing else of the runtime's. */
const HOST_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
];
/** The backend needs a deadline; a command given none gets the app loadouts' hard timeout. */
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000;
/** Output a command may return (the classic engine's capture); the harness keeps 50 KB for the model and spills the rest. */
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
/** A backend that never answers (a hung connection) still ends: this long past the command's own deadline. */
const DEADLINE_GRACE_MS = 30_000;
/** How long a killed call may take to settle before it is finished here anyway (the http backend's /cancel takes up to 5 s). */
const KILL_SETTLE_MS = 2_000;
/** stat, listDir, mkdir, mktemp: small scripts, their own deadline and output cap. */
const SCRIPT_TIMEOUT_MS = 120_000;
const SCRIPT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Concurrent backend calls for readFiles and writeFiles. */
const FILE_CONCURRENCY = 8;

/** `<kind> <size> <mtime s>` of $1, symlinks followed (a dangling one is a symlink), or `none`. GNU/busybox stat, BSD stat, else wc and date. */
const STAT = `if [ -e "$1" ]; then
  if [ -d "$1" ]; then k=directory; elif [ -f "$1" ]; then k=file; else k=other; fi
  o=$(stat -L -c '%s %Y' "$1" 2>/dev/null) || o=$(stat -L -f '%z %m' "$1" 2>/dev/null) || o="$(wc -c < "$1" 2>/dev/null || echo 0) $(date -r "$1" +%s 2>/dev/null || echo 0)"
  echo "$k $o"
elif [ -L "$1" ]; then echo "symlink 0 0"; else echo none; fi`;
/** NUL-separated `<kind>/<name>` entries of $1 (symlinks not followed, as LocalEnv's readdir); exit 4 missing, 6 not a directory, 5 unreadable. */
const LIST = `[ -e "$1" ] || [ -L "$1" ] || exit 4; [ -d "$1" ] || exit 6; cd "$1" 2>/dev/null || exit 5
for f in .* *; do
  case $f in .|..) continue;; esac
  if [ -L "$f" ]; then k=symlink; elif [ -d "$f" ]; then k=directory; elif [ -f "$f" ]; then k=file; elif [ -e "$f" ]; then k=other; else continue; fi
  printf '%s/%s\\000' "$k" "$f"
done`;
/** Make the directory $1 when it is missing (exit 0), or exit 3 when it was there already (a write failed for another reason). */
const MKDIR_MISSING = `[ -d "$1" ] && exit 3; mkdir -p "$1"`;
/** A fresh directory under TMPDIR (else /tmp), outside the workspace. */
const MKTEMP = `t=\${TMPDIR:-/tmp}; t=\${t%/}
d=$(mktemp -d "$t/harness-run-XXXXXX" 2>/dev/null) || d=$(mktemp -d 2>/dev/null) || { d=/tmp/harness-run-$$; mkdir -p "$d" || exit 1; }
printf '%s\\n' "$d"`;
const REMOVE = `rm -rf -- "$1"`;

const STAT_LINE = /^(file|directory|symlink|other)\s+(\d+)\s+(\d+)$/u;
const LIST_EXIT_CODES: Readonly<Record<number, string>> = {
  4: "ENOENT",
  5: "EACCES",
  6: "ENOTDIR",
};

export interface BackendEnvOptions {
  /** The runtime's backend (shared: this env never closes it). */
  readonly backend: ExecutionBackend;
  /** Absolute POSIX working directory where the backend runs (on a Cloud computer, in the tools container). */
  readonly cwd: string;
  /** Variables for every command, over the harness defaults; a call's own win over these. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

interface Settled {
  readonly output: string;
  readonly exitCode: number | null;
  readonly truncated: boolean;
}

/** One backend call, seen as a process: in flight until it settles. */
interface Proc {
  readonly id: string;
  readonly controller: AbortController;
  readonly startedAt: number;
  endedAt?: number;
  done: Promise<void>;
  finished: boolean;
  settled?: Settled;
  error?: unknown;
  timedOut: boolean;
  killed: boolean;
}

function fileError(code: string, syscall: string, path: string, detail?: string): Error {
  const text =
    code === "ENOENT"
      ? "no such file or directory"
      : code === "EISDIR"
        ? "illegal operation on a directory"
        : code === "ENOTDIR"
          ? "not a directory"
          : code === "EACCES"
            ? "permission denied"
            : (detail ?? "failed");
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, path });
}

const errorCode = (error: unknown) => (error as { code?: unknown } | null)?.code;

/** stdout then stderr, a newline between when stdout does not end in one: the classic engine's combinedProcessOutput. */
const combined = (result: BackendExecResult) =>
  `${result.stdout}${result.stdout !== "" && !result.stdout.endsWith("\n") && result.stderr !== "" ? "\n" : ""}${result.stderr}`;

/** setTimeout's longest delay; a longer one fires at once. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Resolves when `work` settles, after `ms` (undefined: no limit), or when `signal` aborts, whichever is first; never rejects. */
async function within(
  work: Promise<unknown>,
  ms: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted === true) return;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const waits: Promise<unknown>[] = [work.catch(() => undefined)];
  if (ms !== undefined)
    waits.push(
      new Promise((done) => (timer = setTimeout(done, Math.min(MAX_TIMER_MS, Math.max(0, ms))))),
    );
  if (signal !== undefined)
    waits.push(
      new Promise<void>((done) =>
        signal.addEventListener("abort", (onAbort = () => done()), { once: true }),
      ),
    );
  try {
    await Promise.race(waits);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
  }
}

async function eachLimited<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export class BackendEnv implements Harness.ExecEnv {
  readonly id: string;
  readonly cwd: string;
  readonly user: string | undefined = undefined;
  /** The tools container is Linux; the SDK's local backend runs on this host. */
  readonly os: string;
  readonly #backend: ExecutionBackend;
  readonly #baseEnv: Readonly<Record<string, string>>;
  readonly #procs = new Map<string, Proc>();
  #scratch: Promise<string> | undefined;
  #nextId = 0;
  #nextInternalId = 0;

  constructor(options: BackendEnvOptions) {
    if (!options.cwd.startsWith("/"))
      throw new Error(
        `BackendEnv: cwd must be an absolute POSIX path, got ${JSON.stringify(options.cwd)}`,
      );
    const local = options.backend.id === "local";
    this.#backend = options.backend;
    this.id = `backend:${options.backend.id}`;
    this.cwd = PosixPath.resolve(options.cwd);
    this.os = local ? process.platform : "linux";
    const host: Record<string, string> = {};
    if (local) {
      for (const key of HOST_ALLOWLIST) {
        const value = process.env[key];
        if (value !== undefined) host[key] = value;
      }
    }
    this.#baseEnv = { ...ENV_DEFAULTS, ...host, ...options.env };
  }

  resolvePath(path: string): string {
    return PosixPath.resolve(this.cwd, path);
  }

  // ── commands ──────────────────────────────────────────────

  async exec(command: string, options: Harness.ExecOptions = {}): Promise<Harness.ExecResult> {
    const proc = this.#start(command, options);
    const yieldMs = options.background === true ? 0 : options.yieldMs;
    if (yieldMs === 0) return this.#snapshot(proc);
    await within(proc.done, yieldMs, options.signal);
    // An abort kills the call: give the backend a moment to answer with what the command left.
    if (options.signal?.aborted === true && !proc.finished) await this.#settleKilled(proc);
    return this.#snapshot(proc);
  }

  async poll(handle: string): Promise<Harness.ExecResult> {
    return this.#snapshot(this.#proc(handle));
  }

  async wait(handle: string, ms: number, signal?: AbortSignal): Promise<Harness.ExecResult> {
    const proc = this.#proc(handle);
    if (!proc.finished) await within(proc.done, ms, signal);
    return this.#snapshot(proc);
  }

  async kill(handle: string): Promise<Harness.ExecResult> {
    const proc = this.#proc(handle);
    if (!proc.finished) {
      proc.killed = true;
      proc.controller.abort();
      await this.#settleKilled(proc);
    }
    return this.#snapshot(proc);
  }

  #start(command: string, options: Harness.ExecOptions): Proc {
    const proc: Proc = {
      id: options.internal === true ? `h${++this.#nextInternalId}` : `p${++this.#nextId}`,
      controller: new AbortController(),
      startedAt: performance.now(),
      done: Promise.resolve(),
      finished: false,
      timedOut: false,
      killed: false,
    };
    const onAbort = () => {
      proc.killed = true;
      proc.controller.abort();
    };
    if (options.signal?.aborted === true) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });
    const timeoutMs =
      options.timeoutMs !== undefined && options.timeoutMs > 0
        ? Math.min(Math.round(options.timeoutMs), MAX_TIMER_MS - DEADLINE_GRACE_MS)
        : DEFAULT_TIMEOUT_MS;
    const deadline = setTimeout(() => {
      proc.timedOut = true;
      proc.controller.abort();
    }, timeoutMs + DEADLINE_GRACE_MS);
    deadline.unref();
    // A backend that throws instead of rejecting still ends up here, as a failed call.
    proc.done = new Promise<BackendExecResult>((resolve) =>
      resolve(
        this.#backend.exec({
          command: "sh",
          args: ["-c", command],
          cwd: options.cwd === undefined ? this.cwd : this.resolvePath(options.cwd),
          env: { ...this.#baseEnv, ...options.env },
          timeoutMs,
          maxOutputBytes: MAX_OUTPUT_BYTES,
          signal: proc.controller.signal,
        }),
      ),
    )
      .then(
        (result) => {
          // Finished here already (killed and not answered in time): a late answer is dropped.
          if (proc.finished) return;
          if (result.timedOut) proc.timedOut = true;
          const output = combined(result);
          this.#finish(proc, {
            output,
            exitCode: proc.timedOut || proc.killed ? null : result.code,
            truncated: result.truncated,
          });
          if (output === "") return;
          try {
            options.onOutput?.(output);
          } catch {
            // a tracing callback's failure is not the command's
          }
        },
        (error: unknown) => {
          if (proc.finished) return;
          proc.error = error;
          this.#finish(proc, { output: "", exitCode: null, truncated: false });
        },
      )
      .finally(() => {
        clearTimeout(deadline);
        options.signal?.removeEventListener("abort", onAbort);
      });
    this.#procs.set(proc.id, proc);
    return proc;
  }

  #finish(proc: Proc, settled: Settled): void {
    if (proc.finished) return;
    proc.finished = true;
    proc.endedAt = performance.now();
    proc.settled = settled;
  }

  /** After an abort: wait for the backend's answer a little, then finish the call here (a late answer is dropped). */
  async #settleKilled(proc: Proc): Promise<void> {
    await within(proc.done, KILL_SETTLE_MS);
    this.#finish(proc, { output: "", exitCode: null, truncated: false });
  }

  #snapshot(proc: Proc): Harness.ExecResult {
    const durationMs = Math.round((proc.endedAt ?? performance.now()) - proc.startedAt);
    const flags = {
      ...(proc.timedOut ? { timedOut: true } : {}),
      ...(proc.killed ? { killed: true } : {}),
    };
    if (!proc.finished)
      return {
        exitCode: null,
        output: "",
        truncated: false,
        durationMs,
        totalBytes: 0,
        running: true,
        handle: proc.id,
        ...flags,
      };
    this.#procs.delete(proc.id);
    // A backend that failed (not a command that failed): the call's error, unless the call was stopped on purpose.
    if (proc.error !== undefined && !proc.killed && !proc.timedOut) throw proc.error;
    const settled = proc.settled!;
    return {
      exitCode: settled.exitCode,
      output: settled.output,
      truncated: settled.truncated,
      durationMs,
      totalBytes: Buffer.byteLength(settled.output, "utf8"),
      running: false,
      ...flags,
    };
  }

  #proc(handle: string): Proc {
    const proc = this.#procs.get(handle);
    if (proc === undefined)
      throw new Error(
        `no background process ${JSON.stringify(handle)} (it finished and its output was returned, or it never existed)`,
      );
    return proc;
  }

  // ── files ─────────────────────────────────────────────────

  async readFile(path: string, range?: Harness.ReadRange): Promise<Uint8Array> {
    const target = this.resolvePath(path);
    const ranged =
      range !== undefined && (range.offset !== undefined || range.length !== undefined);
    if (!ranged) return await this.#read(target);
    const offset = Math.max(0, Math.floor(range.offset ?? 0));
    if (range.length === undefined) return (await this.#read(target)).subarray(offset);
    const length = Math.max(0, Math.floor(range.length));
    // The backend reads from the start: as far as the range ends, then the range is cut out here.
    return (await this.#read(target, offset + length)).subarray(offset, offset + length);
  }

  async #read(target: string, maxBytes?: number): Promise<Uint8Array> {
    try {
      return await this.#backend.readFile(
        target,
        maxBytes === undefined ? undefined : { maxBytes },
      );
    } catch (error) {
      // The Cloud tools backend answers a directory as missing (`test -f`); the harness tells the model which it was.
      if (
        errorCode(error) === "ENOENT" &&
        (await this.stat(target).catch(() => undefined))?.kind === "directory"
      )
        throw fileError("EISDIR", "read", target);
      throw error;
    }
  }

  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    const target = this.resolvePath(path);
    const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
    try {
      await this.#backend.writeFile(target, bytes);
    } catch (error) {
      // The SDK's local backend writes without making parents (the Cloud one makes them); an escape is never retried.
      if (/escapes the workspace/u.test(error instanceof Error ? error.message : "")) throw error;
      const made = await this.#script(MKDIR_MISSING, [PosixPath.dirname(target)]).catch(
        () => undefined,
      );
      // 3: the folder is there now, perhaps made by a write beside this one in the same batch: the write is tried
      // again, and fails as before if the folder was never what it lacked.
      if (made?.code !== 0 && made?.code !== 3) throw error;
      await this.#backend.writeFile(target, bytes);
    }
  }

  async readFiles(paths: string[]): Promise<(Uint8Array | Error)[]> {
    return await eachLimited(paths, FILE_CONCURRENCY, (path) =>
      this.readFile(path).catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }

  async writeFiles(files: { path: string; data: Uint8Array | string }[]): Promise<void> {
    await eachLimited(files, FILE_CONCURRENCY, (file) => this.writeFile(file.path, file.data));
  }

  async stat(path: string): Promise<Harness.FileStat | undefined> {
    const target = this.resolvePath(path);
    const out = await this.#script(STAT, [target]);
    const line = out.stdout.trim().split("\n").at(-1)?.trim() ?? "";
    if (line === "none") return undefined;
    const match = STAT_LINE.exec(line);
    if (match === null)
      throw fileError(
        "EIO",
        "stat",
        target,
        `stat in ${this.id} failed (exit ${out.code}): ${out.stderr.trim().slice(0, 300)}`,
      );
    return {
      kind: match[1] as Harness.FileStat["kind"],
      size: Number(match[2]),
      mtimeMs: Number(match[3]) * 1000,
    };
  }

  async listDir(path: string): Promise<Harness.DirEntry[]> {
    const target = this.resolvePath(path);
    const out = await this.#script(LIST, [target]);
    const code = out.code === null ? undefined : LIST_EXIT_CODES[out.code];
    if (code !== undefined) throw fileError(code, "scandir", target);
    if (out.code !== 0 || out.truncated) {
      throw fileError(
        "EIO",
        "scandir",
        target,
        `listing in ${this.id} failed (exit ${out.code}${out.truncated ? ", output cut" : ""}): ${out.stderr.trim().slice(0, 300)}`,
      );
    }
    return out.stdout
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => {
        const slash = entry.indexOf("/");
        return {
          name: entry.slice(slash + 1),
          kind: entry.slice(0, slash) as Harness.DirEntry["kind"],
        };
      });
  }

  scratchDir(): Promise<string> {
    this.#scratch ??= this.#script(MKTEMP, []).then((out) => {
      const dir = out.stdout.trim().split("\n").at(-1)?.trim() ?? "";
      if (out.code !== 0 || !dir.startsWith("/"))
        throw new Error(
          `no scratch directory in ${this.id} (exit ${out.code}): ${out.stderr.trim().slice(0, 300)}`,
        );
      return dir;
    });
    // A failed attempt is not kept: the next call asks again.
    this.#scratch.catch(() => (this.#scratch = undefined));
    return this.#scratch;
  }

  /** Aborts this env's calls still in flight and removes its scratch dir; the backend stays open (it is the runtime's). */
  async close(): Promise<void> {
    const live = [...this.#procs.values()].filter((proc) => !proc.finished);
    for (const proc of live) {
      proc.killed = true;
      proc.controller.abort();
    }
    await within(Promise.all(live.map((proc) => proc.done)), KILL_SETTLE_MS);
    for (const proc of live) this.#finish(proc, { output: "", exitCode: null, truncated: false });
    this.#procs.clear();
    const scratch = this.#scratch;
    this.#scratch = undefined;
    const dir = await scratch?.catch(() => undefined);
    if (dir !== undefined) await this.#script(REMOVE, [dir]).catch(() => undefined);
  }

  /** `sh -c <script> sh <args...>` on the backend, in / (every path is absolute): paths ride as arguments, never in the script. */
  #script(script: string, args: readonly string[]): Promise<BackendExecResult> {
    return this.#backend.exec({
      command: "sh",
      args: ["-c", script, "sh", ...args],
      cwd: "/",
      env: { ...this.#baseEnv },
      timeoutMs: SCRIPT_TIMEOUT_MS,
      maxOutputBytes: SCRIPT_MAX_OUTPUT_BYTES,
    });
  }
}
