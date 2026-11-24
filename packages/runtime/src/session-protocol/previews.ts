// A chat's preview server (Workspace.preview, workspace.preview.open): what its agent registered (register_preview)
// started in the chat's worktree on the chat's port, so the person can try what it built in their own browser with one
// click. The runtime owns each server it starts: one per chat, in a process group of its own (a dev server is a tree:
// pnpm, then vite, then esbuild), stopped as a whole group when it sits idle, when the chat is archived or its preview
// re-registered, and when the runtime stops. A runtime that died without stopping them (SIGKILL, a crash) finds them in
// its ledger at the next start and stops them then, checking each is still the process it started.
//
// Not the agent's own background work: a server started here is no child of the engine CLI, so the chat's Stop
// (turn.interrupt, thread.stop) never ends it, and it never shows as the chat's pending background work.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";

import { signalProcessGroup } from "@caveman-app/engine-core/server/processGroup";
import { posixShellCommand } from "@caveman-app/shared/posixShell";

/** How long a server may take to listen on its port. A cold `pnpm dev` with a first bundle can take a while. */
export const READY_TIMEOUT_MS = 90_000;
/** Nobody opened it this long, and nothing is connected to it: it stops. A browser tab on a dev server holds its HMR socket open. */
export const IDLE_MS = 15 * 60_000;
/** SIGTERM, then SIGKILL after this. */
const STOP_GRACE_MS = 3_000;
/** At shutdown the desktop waits a few seconds for the runtime: a shorter grace there. */
const SHUTDOWN_GRACE_MS = 1_200;
/** Maximum command output kept for an error, including its omission marker. */
const OUTPUT_TAIL = 4_000;
/** A command may name the exact address to open (with a token, say) on a line of its own output, before it listens. */
const ANNOUNCE = /^CAVEMAN_PREVIEW_URL=(\S+)\s*$/m;

/** Bounded at collection time too: noisy commands must not erase their first diagnosis. */
function previewOutput() {
  const side = (OUTPUT_TAIL - 80) / 2;
  let head = "";
  let tail = "";
  let shortened = false;
  let breaks = 0;
  return {
    take(chunk: string) {
      breaks += chunk.split("\n").length - 1;
      if (!shortened) {
        head += chunk;
        if (head.length <= OUTPUT_TAIL) return;
        tail = head.slice(-side);
        head = head.slice(0, side);
        shortened = true;
      } else tail = `${tail}${chunk}`.slice(-side);
    },
    text() {
      if (!shortened) {
        const lines = head.trim().split("\n");
        if (lines.length <= 15) return head.trim();
        const selected = [
          ...lines.slice(0, 7),
          `… ${lines.length - 15} lines omitted …`,
          ...lines.slice(-8),
        ].join("\n");
        if (selected.length <= OUTPUT_TAIL) return selected;
        tail = head.slice(-side);
        head = head.slice(0, side);
        shortened = true;
      }
      // Discard the partial lines at the two character boundaries; count them as omitted.
      const first = head.trimStart().split("\n").slice(0, -1).slice(0, 7);
      const last = tail.trimEnd().split("\n").slice(1).slice(-8);
      const leading = head.slice(0, head.length - head.trimStart().length).split("\n").length - 1;
      const trailing = tail.slice(tail.trimEnd().length).split("\n").length - 1;
      const omitted = breaks + 1 - leading - trailing - first.length - last.length;
      // A single enormous line has no complete line at either boundary. Keep its fragments.
      if (first.length === 0 && last.length === 0)
        return `${head.trimStart()}\n… output omitted …\n${tail.trimEnd()}`;
      // Preserve a fragment when the first or last line alone exceeds its budget.
      if (first.length === 0) first.push(`${head.trimStart()}…`);
      if (last.length === 0) last.push(`…${tail.trimEnd()}`);
      return [...first, `… ${omitted} lines omitted …`, ...last].join("\n");
    },
  };
}

export interface PreviewStart {
  readonly workspaceId: string;
  /** The chat's worktree: the command's working directory. */
  readonly cwd: string;
  readonly command: string;
  /** The address path, from "/". */
  readonly path: string;
  readonly port: number;
  /** The workspace's variables (computer.toml [env], CAVEMAN_PORT_*). */
  readonly env: Readonly<Record<string, string>>;
}

export class PreviewStartError extends Error {}

interface Running {
  readonly key: string;
  readonly child: ChildProcess;
  readonly pid: number;
  readonly port: number;
  /** The address its command announced, if any (CAVEMAN_PREVIEW_URL=). */
  readonly announced: string | undefined;
  lastOpened: number;
  exited: boolean;
  readonly exit: Promise<void>;
}

interface LedgerEntry {
  readonly pid: number;
  readonly port: number;
  /** `ps -o lstart=` when it started: a pid reused since is someone else's. */
  readonly started: string;
}

/** The address to open: the one the command announced, if it is this computer's, else the port and path. */
export function previewUrl(port: number, pathname: string, announced?: string): string {
  if (announced !== undefined) {
    try {
      const url = new URL(announced);
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      )
        return url.toString();
    } catch {
      // Not an address: the port's own.
    }
  }
  return `http://localhost:${port}${pathname.startsWith("/") ? pathname : `/${pathname}`}`;
}

/** The command with `{port}` filled in. */
export const withPort = (command: string, port: number) =>
  command.replaceAll("{port}", String(port));

/** Something takes connections on the port, on IPv4 or IPv6 loopback (Vite on newer Node listens on ::1 alone). */
export async function listening(port: number, timeoutMs = 500): Promise<boolean> {
  const one = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ host, port });
      const done = (ok: boolean) => {
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(timeoutMs, () => done(false));
      socket.once("connect", () => done(true));
      socket.once("error", () => done(false));
    });
  return (await one("127.0.0.1")) || (await one("::1"));
}

/** A port nothing on this computer listens on now, from the system. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

const run = (file: string, args: ReadonlyArray<string>) =>
  new Promise<string | undefined>((resolve) =>
    execFile(file, [...args], { timeout: 5_000, windowsHide: true }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim()),
    ),
  );

/** When a process started, as `ps` says it; undefined when it is gone (or on Windows). */
const startedAt = (pid: number) =>
  process.platform === "win32"
    ? Promise.resolve(undefined)
    : run("ps", ["-o", "lstart=", "-p", String(pid)]).then((out) => out || undefined);

/** Whether anything is connected to the port now; undefined when this computer can't tell (no lsof). */
const connected = (port: number) =>
  process.platform === "win32"
    ? Promise.resolve(undefined)
    : run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:ESTABLISHED", "-t"]).then((out) =>
        out === undefined ? undefined : out.length > 0,
      );

/** Signals the whole group (POSIX), or the whole tree (Windows); a group already gone is fine. */
function signalTree(pid: number, signal: "SIGTERM" | "SIGKILL") {
  if (process.platform === "win32") {
    execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true }, () => undefined);
    return;
  }
  try {
    signalProcessGroup(pid, signal);
  } catch {
    // ESRCH: nothing left in it.
  }
}

const groupAlive = (pid: number) => {
  if (process.platform === "win32") return false;
  try {
    signalProcessGroup(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits for every process in the group to be gone; false when one is still there after `ms`. */
async function goneWithin(pid: number, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (groupAlive(pid)) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

export interface PreviewServersOptions {
  /** Where the ledger of running servers lives (the runtime's state folder). */
  readonly stateDir: string;
  readonly idleMs?: number;
  readonly readyTimeoutMs?: number;
  readonly now?: () => number;
  /** A server stopped by itself (it exited) or by the sweep: the chat's id. */
  readonly onStopped?: (workspaceId: string) => void;
}

export function makePreviewServers(options: PreviewServersOptions) {
  const ledgerPath = path.join(options.stateDir, "preview-servers.json");
  const idleMs = options.idleMs ?? IDLE_MS;
  const readyTimeoutMs = options.readyTimeoutMs ?? READY_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const servers = new Map<string, Running>();
  /** Starts under way, so a second click joins the first. */
  const starting = new Map<string, Promise<{ url: string; started: boolean }>>();

  const readLedger = (): Record<string, LedgerEntry> => {
    try {
      return JSON.parse(fs.readFileSync(ledgerPath, "utf8")) as Record<string, LedgerEntry>;
    } catch {
      return {};
    }
  };
  const writeLedger = (ledger: Record<string, LedgerEntry>) => {
    try {
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
      if (Object.keys(ledger).length === 0) fs.rmSync(ledgerPath, { force: true });
      else fs.writeFileSync(ledgerPath, JSON.stringify(ledger), { mode: 0o600 });
    } catch {
      // The ledger only helps after a crash; a server still stops on every normal path.
    }
  };
  const record = async (workspaceId: string, pid: number, port: number) => {
    const started = await startedAt(pid);
    if (started === undefined) return;
    writeLedger({ ...readLedger(), [workspaceId]: { pid, port, started } });
  };
  const forget = (workspaceId: string) => {
    const ledger = readLedger();
    if (!(workspaceId in ledger)) return;
    delete ledger[workspaceId];
    writeLedger(ledger);
  };

  const stopRunning = async (server: Running, graceMs: number) => {
    signalTree(server.pid, "SIGTERM");
    await Promise.race([server.exit, new Promise((resolve) => setTimeout(resolve, graceMs))]);
    // The leader (a shell) may be gone while what it started is still shutting down: done when the whole group is.
    if (!(await goneWithin(server.pid, graceMs))) {
      signalTree(server.pid, "SIGKILL");
      await goneWithin(server.pid, 1_000);
    }
    // A process leaves its group a moment before the kernel closes its sockets: stopped means the port is free, so a
    // server started next on it is never mistaken for this one still listening.
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline && (await listening(server.port, 200)))
      await new Promise((resolve) => setTimeout(resolve, 50));
  };

  const stop = async (workspaceId: string, graceMs = STOP_GRACE_MS) => {
    const pending = starting.get(workspaceId);
    if (pending) await pending.catch(() => undefined);
    const server = servers.get(workspaceId);
    if (server === undefined) return false;
    servers.delete(workspaceId);
    await stopRunning(server, graceMs);
    forget(workspaceId);
    return true;
  };

  const start = async (
    spec: PreviewStart,
    key: string,
  ): Promise<{ url: string; started: boolean }> => {
    // Something already serves its port (the agent's own dev server, or one started by hand): that is the preview.
    if (await listening(spec.port))
      return { url: previewUrl(spec.port, spec.path), started: false };
    let shell;
    try {
      shell = posixShellCommand(withPort(spec.command, spec.port));
    } catch (error) {
      throw new PreviewStartError((error as Error).message);
    }
    const child = spawn(shell.command, [...shell.args], {
      cwd: spec.cwd,
      env: {
        ...process.env,
        ...spec.env,
        PORT: String(spec.port),
        CAVEMAN_PORT: spec.env.CAVEMAN_PORT ?? String(spec.port),
        BROWSER: "none",
      },
      // Its own process group: stopped as a whole, and never a member of the runtime's.
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = previewOutput();
    let announceTail = "";
    let announced: string | undefined;
    const take = (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      output.take(text);
      announceTail = `${announceTail}${text}`.slice(-OUTPUT_TAIL);
      announced ??= ANNOUNCE.exec(announceTail)?.[1];
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    let exitedEarly: { code: number | null; signal: string | null } | undefined;
    let markExited: () => void = () => undefined;
    const exit = new Promise<void>((resolve) => {
      markExited = resolve;
    });
    const spawnFailed = new Promise<Error>((resolve) => child.once("error", resolve));
    child.once("exit", (code, signal) => {
      exitedEarly = { code, signal };
      const server = servers.get(spec.workspaceId);
      if (server?.child === child) {
        server.exited = true;
        // It ended by itself: the chip opens it fresh next time.
        servers.delete(spec.workspaceId);
        forget(spec.workspaceId);
        options.onStopped?.(spec.workspaceId);
      }
      markExited();
    });
    if (child.pid === undefined)
      throw new PreviewStartError(
        `Could not start \`${spec.command}\`: ${(await spawnFailed).message}`,
      );
    const pid = child.pid;
    await record(spec.workspaceId, pid, spec.port);
    const tail = () => {
      const text = output.text();
      return text ? `\n${text}` : "";
    };
    const deadline = now() + readyTimeoutMs;
    for (;;) {
      if (exitedEarly !== undefined) {
        forget(spec.workspaceId);
        if (groupAlive(pid)) signalTree(pid, "SIGKILL");
        throw new PreviewStartError(
          `\`${spec.command}\` exited (${exitedEarly.signal ?? `code ${exitedEarly.code}`}) before it listened on port ${spec.port}.${tail()}`,
        );
      }
      if (await listening(spec.port)) break;
      if (now() > deadline) {
        const server = {
          key,
          child,
          pid,
          port: spec.port,
          announced,
          lastOpened: now(),
          exited: false,
          exit,
        };
        await stopRunning(server, STOP_GRACE_MS);
        forget(spec.workspaceId);
        throw new PreviewStartError(
          `\`${spec.command}\` did not listen on port ${spec.port} within ${Math.round(readyTimeoutMs / 1000)} s. Its command must serve on the port it is given: {port}, or PORT.${tail()}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    servers.set(spec.workspaceId, {
      key,
      child,
      pid,
      port: spec.port,
      announced,
      lastOpened: now(),
      exited: false,
      exit,
    });
    return { url: previewUrl(spec.port, spec.path, announced), started: true };
  };

  return {
    /** Serves the chat's preview and answers its address: its running server, else whatever listens on its port, else a new one. */
    open: async (spec: PreviewStart): Promise<{ url: string; started: boolean }> => {
      const key = JSON.stringify([spec.cwd, spec.command, spec.port]);
      const pending = starting.get(spec.workspaceId);
      if (pending) return pending;
      const server = servers.get(spec.workspaceId);
      if (server !== undefined && server.key === key && !server.exited) {
        server.lastOpened = now();
        return { url: previewUrl(server.port, spec.path, server.announced), started: false };
      }
      // Registered anew (another command or port): the old server goes first.
      if (server !== undefined) await stop(spec.workspaceId);
      const begun = start(spec, key).finally(() => starting.delete(spec.workspaceId));
      starting.set(spec.workspaceId, begun);
      return begun;
    },
    stop: (workspaceId: string) => stop(workspaceId),
    running: (workspaceId: string) => servers.has(workspaceId),
    /** Stops each server nobody opened for the idle time and nothing is connected to. Answers the chats it stopped. */
    sweep: async (): Promise<ReadonlyArray<string>> => {
      const stopped: Array<string> = [];
      for (const [workspaceId, server] of [...servers]) {
        if (now() - server.lastOpened < idleMs) continue;
        // A tab still on it (a dev server's HMR socket, a keep-alive) counts as use.
        if ((await connected(server.port)) === true) {
          server.lastOpened = now();
          continue;
        }
        if (await stop(workspaceId)) {
          stopped.push(workspaceId);
          options.onStopped?.(workspaceId);
        }
      }
      return stopped;
    },
    /** Every server, at once: the runtime is stopping. */
    stopAll: async () => {
      await Promise.all([...starting.values()].map((p) => p.catch(() => undefined)));
      await Promise.all([...servers.keys()].map((id) => stop(id, SHUTDOWN_GRACE_MS)));
    },
    /**
     * Servers a runtime before this one started and never stopped (it was killed): each still the process it started
     * (same pid, same start time) is stopped as a group. Run once, before anything starts. Answers how many.
     */
    reapOrphans: async (): Promise<number> => {
      const ledger = readLedger();
      let reaped = 0;
      for (const entry of Object.values(ledger)) {
        if ((await startedAt(entry.pid)) !== entry.started) continue;
        signalTree(entry.pid, "SIGTERM");
        if (!(await goneWithin(entry.pid, 1_000))) signalTree(entry.pid, "SIGKILL");
        reaped++;
      }
      writeLedger({});
      return reaped;
    },
  };
}

export type PreviewServers = ReturnType<typeof makePreviewServers>;
