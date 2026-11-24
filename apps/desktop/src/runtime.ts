// ), apps/desktop/src/backend/DesktopBackendManager.ts @ ab3a3cd1.
// Also from backend/DesktopBackendConfiguration.ts, cut down to one local runtime.
// The desktop owns the endpoint: it picks a free 127.0.0.1 port and a random
// token, hands both to the runtime child as upstream bootstrap envelope on fd 3
// (never argv or env, which other processes can read), and restarts the child
// on the same port and token if it dies, so the client just reconnects (on a
// new port when another process took the old one while it was down). A
// runtime refused by the state-directory owner (exit 78) is not restarted: the
// desktop attaches to that owner (`caveman code` may have started it) instead,
// and starts its own again once that owner is gone, never stopping or signalling
// it. A runtime that keeps exiting soon after it starts is not restarted
// forever: after MAX_FAST_RESTARTS the supervisor stops and the app asks the
// person. One that refuses its data because a newer build wrote it (exit 79) is
// not restarted at all: restarting cannot help, and nothing is deleted.
// Stopping it (README, Runtime contract: Lifecycle): SIGTERM to
// its process group, SIGKILL after the grace period; on Windows, which has
// neither, its stdin ends (the runtime's graceful shutdown) and after the grace
// period `taskkill /T /F` ends the tree, as upstream Effect spawner does there.
// Dropped from T3: WSL and SSH backends, the backend pool, telemetry and
// browser fds, Tailscale exposure, rotating bootstrap secrets.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createConnection, createServer, type AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { connect } from "@caveman-app/session-protocol/client";
import type { EngineDescriptor } from "@caveman-app/session-protocol";
import { discoverRuntime } from "../../../packages/shared/src/runtimeDiscovery.ts";

export const RUNTIME_HOST = "127.0.0.1";
/** Where the runtime serves Session Protocol v1 (see apps/desktop/README.md). */
export const SESSION_PROTOCOL_PATH = "/session/v1";

export interface RuntimeCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
}

/** The Node shipped beside the packaged runtime bundle (scripts/package.mjs): `node.exe` on Windows. */
export const bundledNode = (resourcesPath: string, platform: NodeJS.Platform = process.platform): string =>
  join(resourcesPath, "runtime", platform === "win32" ? "node.exe" : "node");

/**
 * How the desktop starts the runtime: `node` (the bundled one when packaged)
 * runs `entry` with the bootstrap envelope on fd 3. --disable-sigusr1, or any
 * process of this user could `kill -USR1` the runtime and attach an inspector
 * on 127.0.0.1:9229. --max-semi-space-size: V8 sizes the young generation by the
 * Mac's memory (up to 32 MB a semi-space), and the pages the startup burst grows
 * it to are handed back only minutes after the runtime goes idle; 4 MB keeps the
 * runtime at rest about 100 MB smaller, with no slower start. It is not part of
 * V8's flag hash, so the prepared compile cache still matches. `preload`: a module
 * Node imports first, the packaged build's prepared compile cache
 * (src/serverCompileCache.ts).
 */
const RUNTIME_SEMI_SPACE = "--max-semi-space-size=4";

export const runtimeCommand = (node: string, entry: string, cwd: string, preload?: string): RuntimeCommand => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  // Computer use: this app shows its own guide over System Settings (src/computerGuide.ts), so the runtime asks it to.
  if (process.platform === "darwin") env.CAVEMAN_DESKTOP_GUIDE = "1";
  const imports = preload === undefined ? [] : [`--import=${pathToFileURL(preload).href}`];
  return { command: node, args: ["--disable-sigusr1", RUNTIME_SEMI_SPACE, ...imports, entry, "--bootstrap-fd", "3"], env, cwd };
};

export interface SupervisorOptions {
  /** Sent as `t3Home`; absent lets the runtime use its default (~/.caveman-code). */
  readonly stateDir?: string | undefined;
  /**
   * This Mac's agents key (PKCS#8 PEM), read at each start and sent on the bootstrap descriptor only (agentsKey.ts). It
   * may come later than the spawn (the keychain unseals nothing before Electron's `ready`): the descriptor waits for it
   * while the runtime loads, and a failure sends it without the key.
   */
  readonly agentsKey?: () => Promise<string | undefined> | string | undefined;
  /** Called instead of a restart when another runtime owns the state dir and cannot be attached to. */
  readonly onStateDirOwned?: () => void;
  /**
   * Called when the endpoint changed under the page: it switched to the state-dir owner's, or back to this app's
   * own runtime once that owner exited. A page that read the old one must reload.
   */
  readonly onEndpointChanged?: () => void;
  /** Called when the runtime exits on its own, before the restart (crash counts). */
  readonly onUnexpectedExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /**
   * Called instead of another restart once the runtime exited MAX_FAST_RESTARTS + 1 times in a row, each soon after
   * it started, with the last error line it wrote (errorLine). `retry()` starts it again.
   */
  readonly onGaveUp?: (lastError: string | undefined) => void;
  /**
   * Called instead of any restart when the runtime refused to start because its database was written by a newer
   * build (exit 79, or its DatabaseNewerThanRuntime line), with what it said. `retry()` starts it again.
   */
  readonly onRefusedData?: (message: string) => void;
  /** This app's version, to say when a runtime it attached to is another build. */
  readonly appVersion?: string;
  readonly stopGraceMs?: number;
  /** The first restart's delay; it doubles per fast exit up to 10 s. Tests shorten it. */
  readonly restartMinMs?: number;
  /** How long a runtime that served must have run for its exit to start a fresh count. Tests shorten it. */
  readonly healthyAfterMs?: number;
}

export interface RuntimeEndpoint {
  readonly url: string;
  readonly token: string;
}

/**
 * A runtime output line worth showing the person when it keeps exiting: an error, never a stack frame or a warning.
 * The runtime logs errors to stdout ("[00:41:59.293] ERROR (#13): PlatformError: ..."), and its stderr carries Node's
 * warnings, so both streams are read.
 */
export const errorLine = (line: string): string | undefined => {
  const text = line.trim();
  if (!/\b(error|fatal)\b/i.test(text) || /^at\s/.test(text) || /warning/i.test(text)) return undefined;
  return text.replace(/^\[[\d:.]+\]\s*/, "").slice(0, 300);
};

/** False when another process listens on host:port (bound the way the runtime binds it). */
export const portIsFree = (host: string, port: number): Promise<boolean> =>
  new Promise((done) => {
    const server = createServer();
    server.unref();
    server.once("error", () => done(false));
    server.listen(port, host, () => server.close(() => done(true)));
  });

export const freePort = (host: string): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolvePort(port));
    });
  });

/** upstream DesktopBackendBootstrap (@caveman-app/protocol), the fields a local runtime needs. */
export const bootstrapEnvelope = (port: number, token: string, stateDir?: string, agentsKey?: string) => ({
  mode: "desktop" as const,
  noBrowser: true,
  host: RUNTIME_HOST,
  port,
  ...(stateDir === undefined ? {} : { t3Home: stateDir }),
  desktopBootstrapToken: token,
  // This Mac's agents key (agentsKey.ts): here only, never in the environment or argv.
  ...(agentsKey === undefined ? {} : { agentsKey }),
});

// SERVER_EXIT_CODE_STATE_DIR_OWNED in @caveman-app/protocol (upstream serviceLauncher
// keeps the same copy); importing it would bundle Effect Schema into main.
// test/runtime.test.ts checks the two agree.
export const STATE_DIR_OWNED_EXIT_CODE = 78;
/**
 * The runtime's database is newer than it: a newer build migrated it (a nightly, or a newer `caveman code`). The
 * runtime's migration guard exits with it and prints a DatabaseNewerThanRuntime line naming both versions; either
 * one is enough here (packages/runtime/src/persistence/Migrations.ts, DatabaseNewerThanRuntime).
 */
export const DATABASE_NEWER_EXIT_CODE = 79;
const DATABASE_NEWER_TAG = "DatabaseNewerThanRuntime";

/** What the runtime said when it refused a database a newer build wrote: the text after its tag, else undefined. */
export const refusedDataLine = (line: string): string | undefined => {
  const at = line.indexOf(DATABASE_NEWER_TAG);
  if (at < 0) return undefined;
  const text = line
    .slice(at + DATABASE_NEWER_TAG.length)
    .replace(/^(Error)?[\s:\])-]*/, "")
    .trim();
  return (text || "This runtime is older than the data it was asked to open.").slice(0, 500);
};

/**
 * The build version a published runtime record names (`serverVersion` in <home>/userdata/server-runtime.json; its
 * `version` is the record's schema), undefined when it names none or 0.0.0, which unversioned builds write.
 */
export const publishedVersion = (home: string): string | undefined => {
  try {
    const record = JSON.parse(readFileSync(join(home, "userdata", "server-runtime.json"), "utf8")) as { serverVersion?: unknown; version?: unknown };
    const version = typeof record.serverVersion === "string" ? record.serverVersion : typeof record.version === "string" ? record.version : undefined;
    return version === undefined || version.trim() === "" || version === "0.0.0" ? undefined : version.trim().slice(0, 64);
  } catch {
    return undefined;
  }
};

/** Whether an attached runtime is another build than this app: only when both versions are known. */
export const versionSkew = (appVersion: string | undefined, runtimeVersion: string | undefined): boolean =>
  appVersion !== undefined && appVersion !== "0.0.0" && runtimeVersion !== undefined && runtimeVersion !== appVersion;

const WINDOWS = process.platform === "win32";

/** Windows' own tools by full path, so a `taskkill.exe` or `powershell.exe` earlier on PATH never runs instead. */
const system32 = (exe: string) => (process.env.SystemRoot ? join(process.env.SystemRoot, "System32", exe) : exe);

/**
 * The runtime leads its own process group; signal the group so its engine and pty children go too. Windows has no
 * process groups or signals: `taskkill /T /F` ends the process and every process it started (TerminateProcess, no
 * finalizers), whatever the signal asked for.
 */
const signalTree = (pid: number | undefined, signal: NodeJS.Signals) => {
  if (pid === undefined) return;
  if (WINDOWS) {
    const taskkill = spawn(system32("taskkill.exe"), ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    taskkill.on("error", () => undefined); // already gone, or no taskkill: nothing more to do
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // already gone
  }
};

/**
 * The runtime's normal shutdown: SIGTERM to its group, or on Windows the end of its stdin (the runtime starts the
 * same graceful shutdown on EOF; a signal there would be TerminateProcess).
 */
const askToStop = (child: ChildProcess) => {
  if (WINDOWS) child.stdin?.end();
  else signalTree(child.pid, "SIGTERM");
};

/** Process `pid`'s command line: `ps`, or on Windows its Win32_Process record (no `ps` there). */
const commandLineOf = (pid: number): string => {
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`not a process id: ${pid}`);
  if (!WINDOWS) return execFileSync("ps", ["-p", String(pid), "-o", "args="], { encoding: "utf8", timeout: 2_000 }).trim();
  const line = execFileSync(
    system32("WindowsPowerShell\\v1.0\\powershell.exe"),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
    // Smoke only: a cold PowerShell and CIM on a busy Windows machine have taken over 30 s.
    { encoding: "utf8", timeout: 90_000, windowsHide: true },
  ).trim();
  if (line === "") throw new Error(`no process ${pid}`);
  return line;
};

/**
 * Throws unless process `pid` runs with --disable-sigusr1, read from its command line, never by signalling it: a
 * runtime this app did not start, if old, would open an inspector on SIGUSR1.
 */
export const assertNoSigusr1Inspector = (pid: number): string => {
  const args = commandLineOf(pid);
  if (!args.includes("--disable-sigusr1")) throw new Error(`attached runtime pid=${pid} runs without --disable-sigusr1: ${args}`);
  return args;
};

/**
 * Asks process `pid` to open its inspector the way any process of this user can: SIGUSR1, or on Windows (no
 * signals) Node's process._debugProcess, which runs the target's debug handler through a remote thread. False when
 * the target has no handler to run (Windows reports that at once). Only for a runtime this app started.
 */
export const requestInspector = (pid: number): boolean => {
  if (!WINDOWS) {
    process.kill(pid, "SIGUSR1");
    return true;
  }
  const debugProcess = (process as unknown as { _debugProcess?: (pid: number) => void })._debugProcess;
  if (debugProcess === undefined) throw new Error("this Node has no process._debugProcess");
  try {
    debugProcess(pid);
    return true;
  } catch {
    return false;
  }
};

const RESTART_MIN_MS = 500;
/**
 * Restarts after failed runs before the supervisor gives up: 0.5 + 1 + 2 + 4 + 8 s of waiting, about half a minute
 * with the starts. A run failed when it exited before it served (accepted a connection on its port) or under
 * HEALTHY_AFTER_MS after it started. A runtime that dies at start (a broken state file, a bad install) would otherwise
 * restart every 10 s for as long as the app is open while the page says "Reconnecting". Time alone is not enough: on
 * a loaded Mac the dev runtime took 22 to 35 s to load and crash, and a run past 30 s reset the count.
 */
export const MAX_FAST_RESTARTS = 5;
const RESTART_MAX_MS = 10_000;
const HEALTHY_AFTER_MS = 30_000;
const STOP_GRACE_MS = 5_000;
const ATTEMPT_MS = 2_000;
/** How often a starting runtime's port is tried until it accepts a connection. */
const SERVE_PROBE_MS = 500;
/** How often an attached app checks that the state-dir owner still runs. */
export const OWNER_POLL_MS = 2_000;

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, but not this user's.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const sessionUrl = (port: number) => `ws://${RUNTIME_HOST}:${port}${SESSION_PROTOCOL_PATH}`;

export class RuntimeSupervisor {
  /** Ours, or the state-dir owner's once the child exits 78. */
  endpoint: RuntimeEndpoint;
  /** This app's own endpoint, the one its child serves. */
  private own: RuntimeEndpoint;
  private ownerWatch: NodeJS.Timeout | undefined;
  /** The state-dir owner's pid (from its runtime record) once attached. Never signalled or stopped. */
  attachedPid: number | undefined;
  /** The attached owner's build version from its runtime record, when it names one. */
  attachedVersion: string | undefined;
  private readonly command: RuntimeCommand;
  private port: number;
  private readonly log: (line: string) => void;
  private readonly options: SupervisorOptions;
  private child: ChildProcess | undefined;
  private stopping = false;
  private restarts = 0;
  private restartTimer: NodeJS.Timeout | undefined;
  /** The last error line the child wrote (errorLine), for the startup recovery window. */
  private lastError: string | undefined;

  private constructor(command: RuntimeCommand, port: number, log: (line: string) => void, options: SupervisorOptions) {
    this.command = command;
    this.port = port;
    this.log = log;
    this.options = options;
    this.own = { url: sessionUrl(port), token: randomBytes(32).toString("hex") };
    this.endpoint = this.own;
  }

  static async create(
    command: RuntimeCommand,
    log: (line: string) => void,
    options: SupervisorOptions = {},
  ): Promise<RuntimeSupervisor> {
    return new RuntimeSupervisor(command, await freePort(RUNTIME_HOST), log, options);
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    const { command, args, env, cwd } = this.command;
    const startedAt = Date.now();
    // stdin is a pipe we never write: it reaches EOF when this process dies,
    // which is how the runtime notices a crashed desktop, or on Windows when
    // stop() ends it. detached makes the runtime a process-group leader (see
    // signalTree); on Windows it would mean no console at all, so every console
    // program the runtime starts would open a window of its own. windowsHide:
    // the runtime's own hidden console instead of a window.
    const child = spawn(command, [...args], { cwd, env, stdio: ["pipe", "pipe", "pipe", "pipe"], detached: !WINDOWS, windowsHide: true });
    let refused: string | undefined;
    child.stdin?.on("error", () => {}); // ended by stop() after the child already went
    this.child = child;
    this.log(`runtime: started pid=${child.pid} ${command} ${args.join(" ")}`);
    const port = this.port;
    const token = this.endpoint.token;
    // No stdio at all when Node had no descriptors left for the pipes (EMFILE, ENFILE): "error" below ends that run.
    const fd3 = child.stdio?.[3] as Writable | undefined;
    if (fd3 !== undefined) {
      fd3.on("error", () => {}); // a child that never reads fd 3 closes it early
      void Promise.resolve()
        .then(() => this.options.agentsKey?.())
        .catch(() => undefined)
        .then((agentsKey) => fd3.end(`${JSON.stringify(bootstrapEnvelope(port, token, this.options.stateDir, agentsKey))}\n`));
    }
    for (const stream of [child.stdout, child.stderr]) {
      stream?.setEncoding("utf8");
      stream?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n")) {
          if (line.trim() === "") continue;
          this.log(`runtime: ${line}`);
          this.lastError = errorLine(line) ?? this.lastError;
          refused = refusedDataLine(line) ?? refused;
        }
      });
    }
    // Served: something accepted a TCP connection on its port while it ran (restart() made sure the port was free).
    let served = false;
    const probe = () => {
      if (this.child !== child) return;
      const socket = createConnection({ host: RUNTIME_HOST, port });
      socket.once("connect", () => {
        socket.destroy();
        served = true;
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(probe, SERVE_PROBE_MS).unref();
      });
    };
    setTimeout(probe, SERVE_PROBE_MS).unref();
    const ended = (code: number | null, signal: NodeJS.Signals | null) => {
      if (this.child === child) this.child = undefined;
      if (this.stopping) return;
      if (code === STATE_DIR_OWNED_EXIT_CODE) {
        this.stopping = true;
        // ponytail: looked up once; an owner still starting up gets the dialog.
        const home = this.options.stateDir ?? join(homedir(), ".caveman-code");
        const owner = discoverRuntime(home);
        if (owner !== undefined) {
          this.endpoint = { url: owner.url, token: owner.token };
          this.attachedPid = owner.pid;
          this.attachedVersion = publishedVersion(home);
          this.log(`runtime: attached to pid=${owner.pid}, which owns the state dir`);
          if (versionSkew(this.options.appVersion, this.attachedVersion))
            this.log(`runtime: pid=${owner.pid} is runtime ${this.attachedVersion}, not this app's ${this.options.appVersion}; using it as it is, never stopping it`);
          this.watchOwner(owner.pid);
          this.options.onEndpointChanged?.();
          return;
        }
        this.log("runtime: state dir owned by another runtime; not restarting");
        this.options.onStateDirOwned?.();
        return;
      }
      // The tag counts only before the runtime served: the guard runs at startup, and a line a runtime that ran for
      // hours printed (an engine echoing it, say) must not turn its later crash into a refusal with no Try again.
      if (code === DATABASE_NEWER_EXIT_CODE || (refused !== undefined && !served)) {
        const message = refused ?? this.lastError ?? "This runtime is older than the data it was asked to open.";
        this.log(`runtime: refused its data, which a newer build wrote; not restarting (${message})`);
        this.options.onRefusedData?.(message);
        return;
      }
      this.options.onUnexpectedExit?.(code, signal);
      if (served && Date.now() - startedAt > (this.options.healthyAfterMs ?? HEALTHY_AFTER_MS)) this.restarts = 0;
      if (this.restarts >= MAX_FAST_RESTARTS) {
        this.log(`runtime: exited ${this.restarts + 1} times in a row before it served or soon after; not restarting`);
        this.options.onGaveUp?.(this.lastError);
        return;
      }
      const delay = Math.min((this.options.restartMinMs ?? RESTART_MIN_MS) * 2 ** this.restarts, RESTART_MAX_MS);
      this.restarts += 1;
      this.log(`runtime: restarting in ${delay} ms`);
      this.restartTimer = setTimeout(() => void this.restart(false), delay);
    };
    child.on("exit", (code, signal) => {
      this.log(`runtime: exited pid=${child.pid} code=${code} signal=${signal}`);
      ended(code, signal);
    });
    // A child Node could not start (ENOENT, EACCES: a damaged install; EMFILE, ENFILE: no descriptors left) emits
    // "error" and never "exit": its run ends here.
    child.on("error", (error) => {
      if (child.pid !== undefined) return this.log(`runtime: ${error.message}`);
      this.log(`runtime: spawn failed: ${error.message}`);
      this.lastError = error.message;
      ended(child.exitCode, null);
    });
  }

  /**
   * Starts this app's own runtime again on its port, or on a new one when another process took it while the runtime
   * was down (the port came from the OS's ephemeral range, which outgoing connections and other servers draw from;
   * an app that sat attached to `caveman code`'s runtime may have left it unused for hours). A new port, or a switch
   * back from the state-dir owner's endpoint, means the page must reload.
   */
  private async restart(endpointChanged: boolean): Promise<void> {
    if (!(await portIsFree(RUNTIME_HOST, this.port))) {
      const taken = this.port;
      this.port = await freePort(RUNTIME_HOST);
      this.own = { url: sessionUrl(this.port), token: this.own.token };
      this.log(`runtime: port ${taken} is taken by another process; moving to ${this.port}`);
      endpointChanged = true;
    }
    if (this.stopping || this.child !== undefined) return;
    this.endpoint = this.own;
    this.start();
    if (endpointChanged) this.options.onEndpointChanged?.();
  }

  /** After stop() (an update that did not install after all): this app's runtime starts again. */
  resume(): void {
    if (this.child !== undefined || this.attachedPid !== undefined) return;
    this.stopping = false;
    this.restarts = 0;
    void this.restart(false);
  }

  /** After the supervisor gave up (onGaveUp): start the runtime again with a fresh count. */
  retry(): void {
    if (this.stopping || this.child !== undefined || this.attachedPid !== undefined) return;
    clearTimeout(this.restartTimer);
    this.restarts = 0;
    this.lastError = undefined;
    void this.restart(false);
  }

  /**
   * Resolves once the runtime answers engine.list over Session Protocol.
   * Each attempt reads `endpoint` afresh and gets ATTEMPT_MS: after exit 78 it
   * is the state-dir owner's, not the one the first attempt dialled.
   */
  async waitReady(timeoutMs: number): Promise<ReadonlyArray<EngineDescriptor>> {
    const deadline = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < deadline) {
      const client = connect(this.endpoint.url, this.endpoint.token);
      let timer: NodeJS.Timeout | undefined;
      const attempt = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no answer")), Math.min(ATTEMPT_MS, deadline - Date.now()));
      });
      try {
        return (await Promise.race([client.call("engine.list", {}), attempt])).engines;
      } catch (error) {
        last = error;
      } finally {
        clearTimeout(timer);
        client.close();
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `runtime did not answer engine.list on ${this.endpoint.url} within ${timeoutMs} ms` +
        (last instanceof Error ? ` (${last.message})` : ""),
    );
  }

  /**
   * The owner `caveman code` started quits while the app is open: the state dir is free (the OS drops its lock even
   * on SIGKILL), so the app starts its own runtime again rather than sit on a dead endpoint.
   */
  private watchOwner(pid: number): void {
    clearInterval(this.ownerWatch);
    this.ownerWatch = setInterval(() => {
      if (isAlive(pid)) return;
      clearInterval(this.ownerWatch);
      this.log(`runtime: pid=${pid}, which owned the state dir, is gone; starting this app's own`);
      this.attachedPid = undefined;
      this.attachedVersion = undefined;
      this.stopping = false;
      this.restarts = 0;
      void this.restart(true);
    }, OWNER_POLL_MS);
    this.ownerWatch.unref();
  }

  /** Last resort when the app exits without stopping us: starts the runtime's shutdown and does not wait for it. */
  kill(): void {
    clearInterval(this.ownerWatch);
    this.stopping = true;
    if (this.child) askToStop(this.child);
  }

  /**
   * SIGTERM (Windows: the end of stdin), then SIGKILL (Windows: `taskkill /T /F`) after a grace period. Resolves with
   * how the child exited.
   */
  async stop(): Promise<{ code: number | null; signal: NodeJS.Signals | null } | null> {
    clearInterval(this.ownerWatch);
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) return null;
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
      child.once("exit", (code, signal) => done({ code, signal })),
    );
    askToStop(child);
    const killer = setTimeout(() => signalTree(child.pid, "SIGKILL"), this.options.stopGraceMs ?? STOP_GRACE_MS);
    try {
      return await exited;
    } finally {
      clearTimeout(killer);
    }
  }
}

