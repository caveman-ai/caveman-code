// Fetched pages are turned into markdown in child processes (page-worker.ts), POOL_SIZE at most, one page each at a
// time: Defuddle on a 1 MB docs page takes about 5 s of CPU, and the runtime's thread serves every chat. A process,
// not a thread, because only a process can be killed with its memory: a 600 KB PDF can inflate to gigabytes. Each
// child reports its memory every REPORT_MS while it reads, from a thread of its own so a busy parse can't hold the
// report back. The parent kills it above MAX_RSS_BYTES, when reports stop for MISSED_MS, or when its page has taken
// PARSE_TIMEOUT_MS since it started; the next page gets a fresh child.
import { type ChildProcess, fork } from "node:child_process";
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Readable } from "node:stream";

import type { Page } from "./pages.ts";
import type { PageInput } from "./pageText.ts";

const POOL_SIZE = 2;
export const PARSE_TIMEOUT_MS = 20_000;
export const MAX_RSS_BYTES = 512 * 1024 * 1024;
export const REPORT_MS = 100;
const MISSED_MS = 5_000;
/** The child's memory reports arrive on this descriptor; IPC (fd 3) carries the pages. */
export const REPORT_FD = 4;

/** The child's entry beside this module: page-worker.mjs in the bundle (dist/), page-worker.ts in the source tree. */
const workerEntry = (): string => {
  for (const name of ["page-worker.mjs", "page-worker.ts"]) {
    const entry = fileURLToPath(new URL(`./${name}`, import.meta.url));
    if (fs.existsSync(entry)) return entry;
  }
  throw new Error("web_fetch's page reader is missing beside the runtime");
};

type Reply = { readonly page?: Page; readonly error?: string };

interface Job {
  readonly input: PageInput;
  readonly resolve: (page: Page) => void;
  readonly reject: (error: Error) => void;
}

export interface PageParserOptions {
  readonly size?: number;
  /** The reader's script; page-worker beside this module unless a test scripts one. */
  readonly entry?: string;
  readonly timeoutMs?: number;
  readonly maxRssBytes?: number;
  readonly missedMs?: number;
}

export interface PageParser {
  readonly parse: (input: PageInput) => Promise<Page>;
  /** Kills every child; pages waiting or being read are refused. */
  readonly close: () => void;
}

const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

export function makePageParser(options: PageParserOptions = {}): PageParser {
  const { size = POOL_SIZE, timeoutMs = PARSE_TIMEOUT_MS, maxRssBytes = MAX_RSS_BYTES, missedMs = MISSED_MS } = options;
  const entry = options.entry ?? workerEntry();
  const queue: Array<Job> = [];
  const idle: Array<ChildProcess> = [];
  const busy = new Map<ChildProcess, (error: Error) => void>();
  let closed = false;

  const spawn = () => {
    const child = fork(entry, [], {
      execArgv: ["--no-warnings"],
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"],
    });
    child.on("error", () => {});
    child.once("exit", () => {
      const at = idle.indexOf(child);
      if (at >= 0) idle.splice(at, 1);
    });
    return child;
  };

  // Idle, a child never keeps the runtime running.
  const hold = (child: ChildProcess, held: boolean) => {
    const report = child.stdio[REPORT_FD] as Readable | null;
    if (held) {
      child.ref();
      child.channel?.ref();
      (report as unknown as { ref?: () => void } | null)?.ref?.();
    } else {
      child.unref();
      child.channel?.unref();
      (report as unknown as { unref?: () => void } | null)?.unref?.();
    }
  };

  const next = () => {
    while (!closed && queue.length > 0 && busy.size < size) run(queue.shift()!);
  };

  const run = (job: Job) => {
    const child = idle.pop() ?? spawn();
    const report = child.stdio[REPORT_FD] as Readable;
    let lastReport = Date.now();
    let lastCheck = lastReport;
    let pending = "";
    const settle = (outcome: { page: Page } | { error: Error }, keep: boolean) => {
      if (!busy.has(child)) return;
      busy.delete(child);
      clearTimeout(timer);
      clearInterval(check);
      child.off("message", receive);
      child.off("exit", exited);
      report.off("data", reported);
      if (keep && !closed) {
        hold(child, false);
        idle.push(child);
      } else child.kill("SIGKILL");
      if ("page" in outcome) job.resolve(outcome.page);
      else job.reject(outcome.error);
      next();
    };
    const kill = (reason: string) => settle({ error: new Error(reason) }, false);
    const receive = (reply: Reply) =>
      reply.page !== undefined ? settle({ page: reply.page }, true) : settle({ error: new Error(reply.error ?? "the page reader gave no page") }, true);
    const exited = (code: number | null, signal: NodeJS.Signals | null) => kill(`the page reader exited (${signal ?? code})`);
    const reported = (chunk: Buffer) => {
      const lines = (pending + chunk.toString("latin1")).split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        lastReport = Date.now();
        if (Number(line) > maxRssBytes) return kill(`it needed more than ${mb(maxRssBytes)} of memory to read`);
      }
    };
    const timer = setTimeout(() => kill(`the page took longer than ${timeoutMs / 1000} s to read`), timeoutMs);
    const check = setInterval(() => {
      const now = Date.now();
      // The runtime itself was too busy to look: its reports are waiting to be read, not missing.
      const stalled = now - lastCheck > missedMs / 2;
      lastCheck = now;
      if (stalled) lastReport = now;
      else if (now - lastReport > missedMs) kill("the page reader stopped responding");
    }, Math.min(1_000, missedMs / 4));
    busy.set(child, (error) => settle({ error }, false));
    child.on("message", receive);
    child.once("exit", exited);
    report.on("data", reported);
    hold(child, true);
    child.send({ input: job.input });
  };

  return {
    parse: (input) =>
      new Promise<Page>((resolve, reject) => {
        if (closed) return reject(new Error("web_fetch is shutting down"));
        queue.push({ input, resolve, reject });
        next();
      }),
    close: () => {
      closed = true;
      const shuttingDown = new Error("web_fetch is shutting down");
      for (const job of queue.splice(0)) job.reject(shuttingDown);
      for (const stop of [...busy.values()]) stop(shuttingDown);
      for (const child of idle.splice(0)) child.kill("SIGKILL");
    },
  };
}
