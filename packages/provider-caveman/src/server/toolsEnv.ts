/**
 * The Caveman harness's ExecEnv on a Cloud computer: every command and every file read, write, stat and listing runs
 * in the tools container as its uid, through the runtime's exec channel (CavemanToolsStream), so the harness never
 * touches the runtime's Cloud key. It behaves as the harness's own envs do (LocalEnv on This Mac, DockerEnv on the
 * benchmarks): a command past its yield keeps running under a handle the model polls, waits on or kills, output
 * arrives as it is written, and close() ends every process the run started, background children included.
 *
 * Each command is its own channel request, so the tools side gives it its own process group and stop() ends that
 * group. A child a command backgrounded (`server &`) outlives its request; every process carries HARNESS_PROC, and
 * close() kills the ones tagged with this env's tag.
 *
 * @module provider-caveman/server/toolsEnv
 */
import { randomUUID } from "node:crypto";
import * as NodePath from "node:path";
import { StringDecoder } from "node:string_decoder";

import type * as Harness from "@caveman-ai/harness";

import type { CavemanToolsRun, CavemanToolsStream } from "./execution.ts";

/** What a command keeps of its output; the rest is counted and the result says it was cut. */
const CAPTURE_MAX_BYTES = 32 * 1024 * 1024;
/** How long a file operation or the probe may take. */
const REQUEST_TIMEOUT_MS = 120_000;
/** How long a stopped command gets to report its end before it is finished regardless. */
const KILL_SETTLE_MS = 2_000;
const WRITE_CONCURRENCY = 8;
/** As the harness's own envs set them: nothing waits on a pager or a credential prompt. */
const ENV_DEFAULTS = { PAGER: "cat", GIT_PAGER: "cat", GIT_TERMINAL_PROMPT: "0" };

const PROBE = `[ -d "$1" ] || { echo nocwd; exit 0; }
echo "user=$(id -un 2>/dev/null || id -u)"
if [ -x /bin/bash ]; then echo shell=/bin/bash; else echo shell=/bin/sh; fi
echo "os=$(uname -s 2>/dev/null)"
d=$(mktemp -d /tmp/harness-run-XXXXXX 2>/dev/null) || { d=/tmp/harness-run-$$; mkdir -p "$d"; }
echo "scratch=$d"`;
/** The command with stderr on stdout (in order) and no stdin, under the probed shell. */
const WRAPPER = '"$0" -c "$1" 2>&1 </dev/null';
const READ = `[ -d "$1" ] && exit 3; [ -e "$1" ] || exit 4; [ -r "$1" ] || exit 5
if [ -z "$2" ]; then exec cat "$1"; fi
if [ -z "$3" ]; then exec tail -c +$(($2 + 1)) "$1"; fi
tail -c +$(($2 + 1)) "$1" | head -c "$3"`;
const READ_MANY = `for p; do
  if [ -d "$p" ]; then echo "EISDIR 0"; elif [ ! -e "$p" ]; then echo "ENOENT 0"; elif [ ! -r "$p" ]; then echo "EACCES 0"
  elif n=$(wc -c < "$p" 2>/dev/null); then n=$((n + 0)); echo "OK $n"; { cat "$p" 2>/dev/null; cat /dev/zero; } | head -c "$n"
  else echo "EIO 0"; fi
done`;
const WRITE = `[ -d "$1" ] && exit 3; mkdir -p "$(dirname "$1")" 2>/dev/null; [ -d "$(dirname "$1")" ] || exit 6; cat > "$1" || exit 5`;
const STAT = `if [ -e "$1" ]; then
  if [ -d "$1" ]; then k=directory; elif [ -f "$1" ]; then k=file; else k=other; fi
  o=$(stat -L -c '%s %Y' "$1" 2>/dev/null) || o=$(stat -L -f '%z %m' "$1" 2>/dev/null) || { n=$(wc -c < "$1" 2>/dev/null) || n=0; o="$((n + 0)) 0"; }
  echo "$k $o"
elif [ -L "$1" ]; then echo "symlink 0 0"; else echo none; fi`;
const LIST = `[ -e "$1" ] || [ -L "$1" ] || exit 4; [ -d "$1" ] || exit 6; cd "$1" 2>/dev/null || exit 5
for f in .* *; do
  case $f in .|..) continue;; esac
  if [ -L "$f" ]; then k=symlink; elif [ -d "$f" ]; then k=directory; elif [ -f "$f" ]; then k=file; elif [ -e "$f" ]; then k=other; else continue; fi
  printf '%s/%s\\000' "$k" "$f"
done`;
/** Every process of this env's runs ($1, a pattern on HARNESS_PROC), then its scratch directory ($2, when set). */
const CLEAN_UP = `t=$1
for e in /proc/[0-9]*/environ; do p=\${e#/proc/}; p=\${p%/environ}
  [ "$p" = "$$" ] && continue
  tr '\\000' '\\n' < "$e" 2>/dev/null | grep -q "^HARNESS_PROC=$t" && kill -9 "$p" 2>/dev/null
done
[ -z "$2" ] || rm -rf -- "$2"
exit 0`;
const EXIT_CODES: Readonly<Record<number, string>> = { 3: "EISDIR", 4: "ENOENT", 5: "EACCES", 6: "ENOTDIR" };

interface Proc {
  readonly id: string;
  run: CavemanToolsRun | undefined;
  kept: Buffer[];
  keptBytes: number;
  totalBytes: number;
  cursor: number;
  truncated: boolean;
  readonly startedAt: number;
  exitCode: number | null;
  finished: boolean;
  readonly done: Promise<void>;
  readonly settle: () => void;
  timedOut: boolean;
  killed: boolean;
  readonly timers: Array<ReturnType<typeof setTimeout>>;
  offAbort?: () => void;
  terminating?: Promise<void>;
  readonly onOutput?: (chunk: string) => void;
  /** onOutput's decoder: a character split across two chunks reaches it whole. */
  readonly decoder?: StringDecoder;
}

interface Raw {
  readonly code: number | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const fileError = (code: string, syscall: string, path: string, detail?: string) => {
  const text =
    code === "ENOENT" ? "no such file or directory" : code === "EISDIR" ? "illegal operation on a directory" : code === "ENOTDIR" ? "not a directory" : code === "EACCES" ? "permission denied" : (detail ?? "failed");
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, path });
};

/** The end of the last whole UTF-8 character in `buffer`: a running command's output is never cut inside one. */
const utf8End = (buffer: Buffer) => {
  let back = 0;
  while (back < 4 && buffer.length - back - 1 >= 0 && (buffer[buffer.length - back - 1]! & 0xc0) === 0x80) back++;
  const lead = buffer.length - back - 1;
  if (lead < 0) return buffer.length;
  const byte = buffer[lead]!;
  const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
  return back + 1 < width ? lead : buffer.length;
};

const within = async (work: Promise<unknown>, ms: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([work, new Promise((done) => (timer = setTimeout(done, ms)))]);
  clearTimeout(timer);
};

export interface ToolsEnvOptions {
  readonly stream: CavemanToolsStream;
  /** The workspace, the same path in both containers. */
  readonly cwd: string;
  /** What every command gets on top of tools' own environment (the thread's variables, the project's secrets). */
  readonly env?: Readonly<Record<string, string>>;
}

export class ToolsEnv implements Harness.ExecEnv {
  readonly id = "cloud-tools";
  readonly cwd: string;
  user: string | undefined;
  os = "linux";
  readonly #stream: CavemanToolsStream;
  readonly #env: Readonly<Record<string, string>>;
  readonly #tag = randomUUID().slice(0, 12);
  readonly #procs = new Map<string, Proc>();
  #shell = "/bin/sh";
  #scratch: string | undefined;
  #nextId = 0;
  #nextInternalId = 0;
  #started = false;

  /**
   * An env on the tools container, after one probe (the user, the shell, the OS and a scratch directory). It never
   * throws, as LocalEnv never does: a probe that fails (tools not answering, the workspace gone) leaves the defaults,
   * commands still go to tools, and the model sees why they fail.
   */
  static async connect(options: ToolsEnvOptions): Promise<ToolsEnv> {
    const env = new ToolsEnv(options);
    await env.#probe();
    return env;
  }

  private constructor(options: ToolsEnvOptions) {
    this.cwd = NodePath.posix.resolve(options.cwd);
    this.#stream = options.stream;
    this.#env = { ...ENV_DEFAULTS, ...options.env };
  }

  async #probe() {
    const out = await this.#raw(PROBE, [this.cwd]).catch(() => undefined);
    const text = out?.stdout.toString("utf8") ?? "";
    const facts = Object.fromEntries(text.split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
    if (facts.user) this.user = facts.user;
    if (facts.shell === "/bin/bash" || facts.shell === "/bin/sh") this.#shell = facts.shell;
    if (facts.os && /^[A-Za-z0-9_-]+$/.test(facts.os)) this.os = facts.os.toLowerCase();
    if (facts.scratch?.startsWith("/")) this.#scratch = facts.scratch;
  }

  resolvePath(path: string) {
    return NodePath.posix.resolve(this.cwd, path);
  }

  async exec(command: string, options: Harness.ExecOptions = {}): Promise<Harness.ExecResult> {
    const proc = this.#start(command, options);
    if (options.signal?.aborted === true) await this.#terminate(proc, "killed");
    const yieldMs = options.background === true ? 0 : options.yieldMs;
    if (yieldMs === 0) return this.#snapshot(proc);
    await this.#race(proc, yieldMs, options.signal);
    if (options.signal?.aborted === true) await this.#terminate(proc, "killed");
    return this.#snapshot(proc);
  }

  async poll(handle: string) {
    return this.#snapshot(this.#proc(handle));
  }

  async wait(handle: string, ms: number, signal?: AbortSignal) {
    const proc = this.#proc(handle);
    await this.#race(proc, ms, signal);
    return this.#snapshot(proc);
  }

  async kill(handle: string) {
    const proc = this.#proc(handle);
    await this.#terminate(proc, "killed");
    return this.#snapshot(proc);
  }

  async readFile(path: string, range?: Harness.ReadRange): Promise<Uint8Array> {
    const target = this.resolvePath(path);
    const ranged = range !== undefined && (range.offset !== undefined || range.length !== undefined);
    const args = [target];
    if (ranged) {
      if (range.length !== undefined && range.length <= 0) {
        if ((await this.stat(target)) === undefined) throw fileError("ENOENT", "open", target);
        return new Uint8Array(0);
      }
      args.push(String(Math.max(0, Math.floor(range.offset ?? 0))), range.length === undefined ? "" : String(Math.floor(range.length)));
    }
    const out = await this.#raw(READ, args);
    if (out.code === 0) return out.stdout;
    throw this.#opError(out, "open", target);
  }

  /** One request for all of them, framed per file. */
  async readFiles(paths: string[]): Promise<(Uint8Array | Error)[]> {
    if (paths.length === 0) return [];
    const targets = paths.map((path) => this.resolvePath(path));
    const out = await this.#raw(READ_MANY, targets);
    const results: (Uint8Array | Error)[] = [];
    let at = 0;
    for (const target of targets) {
      const nl = out.stdout.indexOf(10, at);
      const match = /^([A-Z]+) (\d+)$/.exec(nl === -1 ? "" : out.stdout.subarray(at, nl).toString("latin1"));
      if (match === null) {
        results.push(fileError("EIO", "open", target, out.stderr.toString("utf8").trim() || `exit ${out.code}`));
        at = out.stdout.length;
        continue;
      }
      const n = Number(match[2]);
      at = nl + 1;
      if (match[1] === "OK") {
        results.push(Buffer.from(out.stdout.subarray(at, at + n)));
        at += n;
      } else {
        results.push(fileError(match[1]!, match[1] === "EISDIR" ? "read" : "open", target));
      }
    }
    return results;
  }

  async writeFile(path: string, data: Uint8Array | string) {
    const target = this.resolvePath(path);
    const out = await this.#raw(WRITE, [target], typeof data === "string" ? Buffer.from(data, "utf8") : data);
    if (out.code !== 0) throw this.#opError(out, "open", target);
  }

  async writeFiles(files: { path: string; data: Uint8Array | string }[]) {
    let next = 0;
    const worker = async () => {
      while (next < files.length) {
        const file = files[next++]!;
        await this.writeFile(file.path, file.data);
      }
    };
    await Promise.all(Array.from({ length: Math.min(WRITE_CONCURRENCY, files.length) }, worker));
  }

  async stat(path: string): Promise<Harness.FileStat | undefined> {
    const target = this.resolvePath(path);
    const out = await this.#raw(STAT, [target]);
    const line = out.stdout.toString("utf8").trim();
    const match = /^(file|directory|symlink|other) (\d+) (\d+)$/.exec(line);
    if (match === null) {
      if (line === "none") return undefined;
      throw this.#opError(out, "stat", target);
    }
    return { kind: match[1] as Harness.FileStat["kind"], size: Number(match[2]), mtimeMs: Number(match[3]) * 1000 };
  }

  async listDir(path: string): Promise<Harness.DirEntry[]> {
    const target = this.resolvePath(path);
    const out = await this.#raw(LIST, [target]);
    if (out.code !== 0) throw this.#opError(out, "scandir", target);
    return out.stdout
      .toString("utf8")
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => ({ name: entry.slice(entry.indexOf("/") + 1), kind: entry.slice(0, entry.indexOf("/")) as Harness.FileStat["kind"] }));
  }

  async scratchDir() {
    if (this.#scratch === undefined) {
      const out = await this.#raw('mktemp -d /tmp/harness-run-XXXXXX', []);
      const dir = out.stdout.toString("utf8").trim();
      if (out.code !== 0 || !dir.startsWith("/")) throw new Error(`env: no scratch directory in the tools container: ${out.stderr.toString("utf8").trim().slice(0, 300)}`);
      this.#scratch = dir;
    }
    return this.#scratch;
  }

  /** Ends every command still running, every process its runs left behind, and the scratch directory. */
  async close() {
    const live = [...this.#procs.values()].filter((proc) => !proc.finished);
    for (const proc of live) {
      proc.killed = true;
      proc.run?.stop();
    }
    if (this.#started || this.#scratch !== undefined) {
      await this.#raw(CLEAN_UP, [`${this.#tag}\\.`, this.#scratch ?? ""], undefined, 30_000).catch(() => undefined);
    }
    await within(Promise.all(live.map((proc) => proc.done)), KILL_SETTLE_MS);
    for (const proc of live) this.#finish(proc, null);
    this.#procs.clear();
  }

  /** Live handles, for tests. */
  liveHandles() {
    return [...this.#procs.values()].filter((proc) => !proc.finished).map((proc) => proc.id);
  }

  #start(command: string, options: Harness.ExecOptions): Proc {
    let settle!: () => void;
    const id = options.internal === true ? `h${++this.#nextInternalId}` : `p${++this.#nextId}`;
    const proc: Proc = {
      id,
      run: undefined,
      kept: [],
      keptBytes: 0,
      totalBytes: 0,
      cursor: 0,
      truncated: false,
      startedAt: performance.now(),
      exitCode: null,
      finished: false,
      done: new Promise<void>((done) => (settle = done)),
      settle: () => settle(),
      timedOut: false,
      killed: false,
      timers: [],
      ...(options.onOutput === undefined ? {} : { onOutput: options.onOutput, decoder: new StringDecoder("utf8") }),
    };
    this.#procs.set(id, proc);
    this.#started = true;
    const cwd = options.cwd === undefined ? this.cwd : this.resolvePath(options.cwd);
    const env = { ...this.#env, ...options.env, HARNESS_PROC: `${this.#tag}.${id}` };
    const record = (chunk: Buffer) => this.#record(proc, chunk);
    const run = this.#stream({ argv: [this.#shell, "-c", WRAPPER, this.#shell, command], cwd, env }, { stdout: record, stderr: record });
    proc.run = run;
    void run.done.then(
      (end) => this.#finish(proc, end.code),
      () => this.#finish(proc, null),
    );
    if (options.signal !== undefined) {
      const onAbort = () => void this.#terminate(proc, "killed");
      options.signal.addEventListener("abort", onAbort, { once: true });
      proc.offAbort = () => options.signal?.removeEventListener("abort", onAbort);
    }
    if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
      const timer = setTimeout(() => void this.#terminate(proc, "timedOut"), options.timeoutMs);
      timer.unref?.();
      proc.timers.push(timer);
    }
    return proc;
  }

  #record(proc: Proc, chunk: Buffer) {
    if (chunk.length === 0 || proc.finished) return;
    proc.totalBytes += chunk.length;
    if (proc.keptBytes + chunk.length <= CAPTURE_MAX_BYTES) {
      proc.kept.push(chunk);
      proc.keptBytes += chunk.length;
    } else {
      proc.truncated = true;
    }
    const text = proc.decoder?.write(chunk);
    if (text) proc.onOutput?.(text);
  }

  #finish(proc: Proc, code: number | null) {
    if (proc.finished) return;
    const rest = proc.decoder?.end();
    if (rest) proc.onOutput?.(rest);
    proc.finished = true;
    proc.exitCode = proc.timedOut || proc.killed ? null : code;
    for (const timer of proc.timers) clearTimeout(timer);
    proc.offAbort?.();
    proc.settle();
  }

  /** Ends a command's process group, gives it a moment to report, then finishes it regardless. */
  #terminate(proc: Proc, how: "killed" | "timedOut"): Promise<void> {
    if (proc.finished) return Promise.resolve();
    proc[how] = true;
    return (proc.terminating ??= (async () => {
      proc.run?.stop();
      await within(proc.done, KILL_SETTLE_MS);
      this.#finish(proc, null);
    })());
  }

  async #race(proc: Proc, ms: number | undefined, signal: AbortSignal | undefined) {
    if (proc.finished) return;
    const waits: Promise<unknown>[] = [proc.done];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    if (ms !== undefined) waits.push(new Promise((done) => (timer = setTimeout(done, Math.max(0, ms)))));
    if (signal !== undefined) {
      if (signal.aborted) return;
      waits.push(new Promise<void>((done) => signal.addEventListener("abort", (onAbort = () => done()), { once: true })));
    }
    try {
      await Promise.race(waits);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
  }

  #snapshot(proc: Proc): Harness.ExecResult {
    const all = proc.kept.length === 1 ? proc.kept[0]! : Buffer.concat(proc.kept);
    if (proc.kept.length > 1) proc.kept = [all];
    const end = proc.finished ? all.length : utf8End(all);
    const output = all.subarray(proc.cursor, end).toString("utf8");
    proc.cursor = Math.max(proc.cursor, end);
    if (proc.finished) this.#procs.delete(proc.id);
    return {
      exitCode: proc.exitCode,
      output,
      truncated: proc.truncated,
      durationMs: Math.round(performance.now() - proc.startedAt),
      totalBytes: proc.totalBytes,
      running: !proc.finished,
      ...(proc.finished ? {} : { handle: proc.id }),
      ...(proc.timedOut ? { timedOut: true } : {}),
      ...(proc.killed ? { killed: true } : {}),
    };
  }

  #proc(handle: string) {
    const proc = this.#procs.get(handle);
    if (proc === undefined) throw new Error(`no background process ${JSON.stringify(handle)} (it finished and its output was returned, or it never existed)`);
    return proc;
  }

  /** A harness-internal script under /bin/sh in tools (no wrapper, no thread env): its exit code, stdout and stderr. */
  #raw(script: string, args: ReadonlyArray<string>, stdin?: Uint8Array, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Raw> {
    return new Promise((resolve) => {
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;
      const run = this.#stream(
        { argv: ["/bin/sh", "-c", script, "harness", ...args], cwd: "/", env: {}, ...(stdin === undefined ? {} : { stdin }) },
        { stdout: (chunk) => stdout.push(chunk), stderr: (chunk) => stderr.push(chunk) },
      );
      const timer = setTimeout(() => ((timedOut = true), run.stop()), timeoutMs);
      void run.done.then(
        (end) => {
          clearTimeout(timer);
          resolve({ code: timedOut || end.stopped ? null : end.code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
        },
        (error: unknown) => {
          clearTimeout(timer);
          resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.from(error instanceof Error ? error.message : String(error)) });
        },
      );
    });
  }

  #opError(out: Raw, syscall: string, target: string) {
    const code = out.code === null ? undefined : EXIT_CODES[out.code];
    if (code !== undefined) return fileError(code, code === "EISDIR" ? "read" : syscall, target);
    const why = out.stderr.toString("utf8").trim();
    if (/permission denied/i.test(why)) return fileError("EACCES", syscall, target);
    if (/not a directory/i.test(why)) return fileError("ENOTDIR", syscall, target);
    if (/no such file/i.test(why) && !/container/i.test(why)) return fileError("ENOENT", syscall, target);
    return fileError("EIO", syscall, target, `the tools container failed (exit ${out.code}): ${why.slice(0, 300)}`);
  }
}
