// App-owned pass-through proxies (the pinned caveman v4 binary). They record
// usage and preserve Auto routing without transforming conversation content.
// Their home, ports and credentials are isolated from the person's caveman.
// The runtime starts, monitors and stops only the children it owns.
import { spawn, type ChildProcess } from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import { fileURLToPath } from "node:url";

import { pickEnv } from "@caveman-app/shared/processEnv";
import { killProcessTree, killProcessTreeAsync } from "@caveman-app/shared/processTree";
import * as Context from "effect/Context";

import { awaitingClaim } from "../cloudLink/identity.ts";
import { toolsSocket } from "../cloudLink/tools.ts";

/** Pass-through recording preserves Auto routing without compressing requests. */
export const APP_PROXY_MODE = "record";
/** The one quiet line a Claude Agent or Codex chat shows while its proxy is missing or broken. */
export const COMPRESSION_OFF = "Compression off: proxy unavailable";
export const COMPRESSION_OFF_RETRIEVE = "Compression off: retrieve unavailable";
/** The proxy's agent slugs for the app's chats: Cloud holds their Auto to their vendor's models. */
export const APP_CLAUDE_AGENT = "caveman-code-claude";
export const APP_CODEX_AGENT = "caveman-code-codex";

/** Where the desktop app and a Cloud computer's runtime carry the pinned binaries: `bin/` beside the bundle. */
const BUNDLED_DIR = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "bin");

const executable = (file: string | undefined): file is string => {
  if (!file) return false;
  try {
    NodeFS.accessSync(file, NodeFS.constants.X_OK);
    return NodeFS.statSync(file).isFile();
  } catch {
    return false;
  }
};

/**
 * The app's own copy of a caveman v4 binary: `override` (development and
 * tests), else the one bundled beside the runtime. Never one the person
 * installed, so the app's mode and version are its own.
 */
export function findCavemanBinary(name: string, override: string | undefined, bundledDir: string = BUNDLED_DIR): string | undefined {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return [override, NodePath.join(bundledDir, file)].find(executable);
}

/** The proxy binary: CAVEMAN_PROXY_BIN, else the bundled one. */
export const findProxyBinary = (env: NodeJS.ProcessEnv = process.env) => findCavemanBinary("caveman-proxy", env.CAVEMAN_PROXY_BIN);

/** caveman-mcp: CAVEMAN_MCP_BIN, else the bundled one. */
export const findMcpBinary = (env: NodeJS.ProcessEnv = process.env) => findCavemanBinary("caveman-mcp", env.CAVEMAN_MCP_BIN);

/** A Cloud computer: engines and their MCP servers run in the tools container, which cannot read the proxies' home. */
export const onCloudComputer = (env: NodeJS.ProcessEnv = process.env): boolean => toolsSocket(env) !== undefined;

/** Whether the app's caveman-mcp could read back what the proxy cut: never on a Cloud computer, whose tools cannot read its home. */
export const retrieveReachable = (env: NodeJS.ProcessEnv = process.env): boolean => findMcpBinary(env) !== undefined && !onCloudComputer(env);

let home: string | undefined;

/**
 * Every access token and routing key written for the proxies (refreshed ones too): an engine's bash
 * can read `<home>/credentials`, so each joins the egress scrub (EgressScrub.ts) until exit, like provider keys.
 */
export const appProxyTokens = new Set<string>();

const credentialsFile = (dir: string) => NodePath.join(dir, "credentials");

/**
 * The proxies' home, made if missing and private to the runtime's uid either way: mkdir's mode applies only to a
 * directory it creates, and a home an older runtime or a restore left wider must not stay readable by the tools uid.
 */
export const privateHome = (dir: string): void => {
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(dir, 0o700);
};

/** The app proxies' CAVEMAN_HOME (the runtime sets it from its state dir at start); undefined until then, and nothing starts. */
export const appProxyHome = (): string | undefined => home;
export const setAppProxyHome = (dir: string | undefined): void => {
  if (dir !== home) cloudWritten = undefined;
  home = dir;
  if (dir === undefined) return;
  // A sign-in an earlier run wrote is scrubbed from the start, before this run writes its own.
  try {
    const stored = JSON.parse(NodeFS.readFileSync(credentialsFile(dir), "utf8"));
    for (const token of [stored.access_token, stored.gateway_api_key]) if (typeof token === "string" && token !== "") appProxyTokens.add(token);
  } catch {
    // None yet.
  }
};

/** The app's sign-in and paid routing credential; only the latter authenticates Auto. */
export interface AppProxyCloud {
  readonly cloudUrl: string;
  readonly accessToken: string;
  readonly gatewayUrl?: string | undefined;
  readonly routingKey?: string | undefined;
}

let cloudSource: (() => Promise<AppProxyCloud | undefined>) | undefined;
/** Where the proxies' sign-in comes from: the runtime's account store (session-protocol/account.ts). */
export const setAppProxyCloud = (source: () => Promise<AppProxyCloud | undefined>): void => void (cloudSource = source);

const writeAtomic = (file: string, text: string) => {
  const tmp = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, text, { mode: 0o600 });
  NodeFS.renameSync(tmp, file);
};

/**
 * cloud.json and credentials in `dir`, as caveman v4's CLI writes them, for
 * the app's own sign-in; signed out, a cloud.json with none. Always a
 * cloud.json: without one the proxy reads the person's old
 * ~/.caveman-cloud/config.json. Telemetry stays off: the app reports its own
 * usage. Returns what it wrote, so an unchanged sign-in is not written again.
 */
export function writeProxyCloud(dir: string, cloud: AppProxyCloud | undefined, previous?: string): string {
  const doc =
    cloud === undefined
      ? { telemetry: { enabled: false } }
      : {
          baseURL: cloud.cloudUrl,
          ...(cloud.gatewayUrl ? { gatewayUrl: cloud.gatewayUrl } : {}),
          tokenStore: "file",
          deviceId: "caveman-code",
          modules: { routing: !!cloud.routingKey },
          telemetry: { enabled: false },
        };
  const credentials = cloud === undefined ? "" : JSON.stringify({ access_token: cloud.accessToken, ...(cloud.routingKey ? { gateway_api_key: cloud.routingKey } : {}) });
  const written = JSON.stringify(doc) + credentials;
  if (written === previous) return written;
  if (cloud !== undefined) appProxyTokens.add(cloud.accessToken);
  if (cloud?.routingKey) appProxyTokens.add(cloud.routingKey);
  privateHome(dir);
  if (cloud === undefined) NodeFS.rmSync(credentialsFile(dir), { force: true });
  else writeAtomic(credentialsFile(dir), credentials);
  writeAtomic(NodePath.join(dir, "cloud.json"), `${JSON.stringify(doc, null, 2)}\n`);
  return written;
}

/**
 * What the proxy needs from the runtime's environment: what a provider call
 * needs on this network (an HTTP proxy, CA bundles), and on Windows what any
 * process needs there (pickEnv: SystemRoot for Winsock, the profile dirs).
 * Nothing else, no credential, and none of the person's caveman settings
 * (CAVEMAN_HOME, CAVEMAN_CONFIG): its home is the app's.
 */
const KEPT_ENV = [
  "HOME", "USER", "LOGNAME", "PATH", "TMPDIR", "LANG",
  "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "REQUESTS_CA_BUNDLE", "CAVE_CA_BUNDLE", "CAVE_UPSTREAM_PROXY",
  // A local model server the person opted in (Ollama, a LAN box).
  "CAVE_SSRF_ALLOWLIST",
];

/** `recovery`: the proxy may shorten any request, every chat holding caveman_retrieve (Codex); only where it is reachable. */
export const appProxyEnv = (env: NodeJS.ProcessEnv, listen: string, input: { readonly home: string; readonly recovery: boolean }): NodeJS.ProcessEnv => {
  const out: NodeJS.ProcessEnv = pickEnv(env, KEPT_ENV);
  const recovery = input.recovery && retrieveReachable(env) ? { CAVEMAN_RECOVERY: "mcp" } : {};
  return { ...out, ...recovery, CAVEMAN_HOME: input.home, CAVEMAN_MODE: APP_PROXY_MODE, CAVEMAN_LISTEN: listen };
};

/** `port` (0: any) when it is free on 127.0.0.1 now, else undefined. */
const freePort = (port = 0) =>
  new Promise<number | undefined>((resolve) => {
    const server = NodeNet.createServer();
    server.once("error", () => resolve(undefined));
    server.listen(port, "127.0.0.1", () => {
      const free = (server.address() as NodeNet.AddressInfo).port;
      server.close(() => resolve(free));
    });
  });

/**
 * Whether the proxy on `port` is the child `pid`: its run state in `dir` names
 * that pid, and /health/live answers with the instance token it holds (v4's own
 * probe). A foreign listener on a remembered port is never taken for it.
 */
const ours = async (dir: string, port: number, pid: number | undefined): Promise<boolean> => {
  let state: { pid?: unknown; instance_token?: unknown };
  try {
    state = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "run", `${port}.json`), "utf8"));
  } catch {
    return false;
  }
  if (state.pid !== pid || typeof state.instance_token !== "string" || state.instance_token === "") return false;
  return fetch(`http://127.0.0.1:${port}/health/live`, { signal: AbortSignal.timeout(500) }).then(
    (response) => response.ok && response.headers.get("x-caveman-instance") === state.instance_token,
    () => false,
  );
};

export type AppProxyState = "running" | "started" | "no_binary" | "failed";

export interface AppProxyOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Its CAVEMAN_HOME; appProxyHome() when absent. */
  readonly home?: string;
  /** Tell it every request carries caveman_retrieve (CAVEMAN_RECOVERY=mcp). */
  readonly recovery?: boolean;
  readonly spawn?: (bin: string, env: NodeJS.ProcessEnv) => ChildProcess;
  /** How long a start may take before it counts as failed. */
  readonly readyMs?: number;
}

/** One app proxy: started on demand, restarted on its port when it died, stopped with the runtime. */
export class AppProxy {
  #url: string | undefined;
  #port: number | undefined;
  #child: ChildProcess | undefined;
  #starting: Promise<AppProxyState> | undefined;
  #state: AppProxyState | undefined;
  #why: string | undefined;
  readonly #options: AppProxyOptions;

  constructor(options: AppProxyOptions = {}) {
    this.#options = options;
  }

  /** The proxy's base URL while it is up; undefined otherwise. */
  url(): string | undefined {
    return this.#url;
  }

  /** The child's pid while it runs: the one process this may stop. */
  pid(): number | undefined {
    return this.#child?.pid;
  }

  /** What the last start found, a running proxy that died since being "failed"; undefined before the first. */
  state(): AppProxyState | undefined {
    return this.#url === undefined && (this.#state === "running" || this.#state === "started") ? "failed" : this.#state;
  }

  /** Why the last start did not bring it up, for the runtime's log. */
  why(): string | undefined {
    return this.#why;
  }

  /** Starts it when it is not running and waits until it answers; never throws. */
  ensure(): Promise<AppProxyState> {
    if (this.#url !== undefined && this.#child?.exitCode === null) return Promise.resolve((this.#state = "running"));
    return (this.#starting ??= this.#start()
      .then((state) => (this.#state = state))
      .finally(() => (this.#starting = undefined)));
  }

  async #start(): Promise<AppProxyState> {
    const env = this.#options.env ?? process.env;
    const bin = findProxyBinary(env);
    this.#why = undefined;
    if (bin === undefined) {
      this.#why = "no caveman-proxy beside the runtime (bin/) and no CAVEMAN_PROXY_BIN";
      return "no_binary";
    }
    const dir = this.#options.home ?? appProxyHome();
    if (dir === undefined) {
      this.#why = "the runtime has not set the proxy's home yet";
      return "failed";
    }
    try {
      privateHome(dir);
      // The port it had while it is free, so engines' base URLs keep working; another process took it meanwhile: a new one.
      const port = (this.#port = (this.#port === undefined ? undefined : await freePort(this.#port)) ?? (await freePort()));
      if (port === undefined) throw new Error("no free port on 127.0.0.1");
      const url = `http://127.0.0.1:${port}`;
      const start = this.#options.spawn ?? ((file, childEnv) => spawn(file, ["serve"], { stdio: "ignore", env: childEnv, windowsHide: true }));
      const child = start(bin, appProxyEnv(env, `127.0.0.1:${port}`, { home: dir, recovery: this.#options.recovery === true }));
      let spawnError = "";
      child.on("error", (error) => void (spawnError = error.message));
      child.once("exit", () => {
        if (this.#child === child) {
          this.#child = undefined;
          this.#url = undefined;
        }
      });
      this.#child = child;
      const deadline = Date.now() + (this.#options.readyMs ?? 10_000);
      while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
        if (await ours(dir, port, child.pid)) {
          this.#url = url;
          return "started";
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const exited = child.exitCode ?? child.signalCode;
      this.stop();
      this.#why = `${bin} on ${url}: ${spawnError || (exited === null ? "no answer from it" : `it exited (${exited})`)}; its log is ${NodePath.join(dir, "proxy.log")}`;
      return "failed";
    } catch (error) {
      this.#why = `${bin}: ${error instanceof Error ? error.message : String(error)}`;
      return "failed";
    }
  }

  /**
   * Stops the child it started, and only that one. `wait`: on Windows, until taskkill is done, for the `exit` handler
   * and the runtime's shutdown; otherwise it runs on its own, never stalling the event loop.
   */
  stop(wait = false): void {
    const child = this.#child;
    this.#child = undefined;
    this.#url = undefined;
    if (child === undefined || child.exitCode !== null) return;
    // Windows: taskkill, as kill() there is TerminateProcess of the one process.
    if (process.platform === "win32") (wait ? killProcessTree : killProcessTreeAsync)(child.pid);
    else child.kill("SIGTERM");
  }
}

// ponytail: process-wide instances; the runtime is one per computer. A SIGKILLed runtime leaves its proxies
// running (macOS does not reap children) and the next runtime takes new ports; reap by run state if that piles up.
/** Claude Agent's chats (and OpenCode's): compresses only what carries caveman_retrieve. */
export const appProxy = new AppProxy();
/** Codex's chats: told every request carries it (CAVEMAN_RECOVERY=mcp). */
export const codexProxy = new AppProxy({ recovery: true });
process.once("exit", () => {
  appProxy.stop(true);
  codexProxy.stop(true);
});

let cloudWritten: string | undefined;
let reads = 0;
let readWritten = 0;
/**
 * Writes the app's sign-in where the proxies read it, when it changed. Writes overlap (the proxy pass, a refresh, a
 * sign-out), and a read that refreshed the sign-in at Cloud can finish after one started later. A read older than the
 * last one written is dropped, so an older credential never replaces a newer one, and no write waits on another's read.
 */
export const writeAppProxyCloud = async (): Promise<void> => {
  const dir = appProxyHome();
  if (dir === undefined) return;
  const read = ++reads;
  const cloud = await cloudSource?.().catch(() => undefined);
  if (read < readWritten) return;
  try {
    cloudWritten = writeProxyCloud(dir, cloud, cloudWritten);
    readWritten = read;
  } catch {
    // Unwritable: Auto stays off (routingConfigured reads the same file); compression still runs.
  }
};

/**
 * Writes the app's sign-in where the proxies read it, then ensures `proxy`. A warm Cloud computer starts neither
 * before its claim (no chat runs there before it, and each holds about 40 MiB): the runtime's own proxy pass starts
 * them at the claim.
 */
export const ensureAppProxy = async (proxy: AppProxy, env: NodeJS.ProcessEnv = process.env): Promise<AppProxyState> => {
  if (awaitingClaim(env)) return proxy.state() ?? "failed";
  await writeAppProxyCloud();
  return proxy.ensure();
};

/** Claude Agent's proxy URL now, for the engines' egress; undefined while it is down. */
export const appProxyUrl = (): string | undefined => appProxy.url();
/** Codex's proxy URL now; undefined while it is down. */
export const codexProxyUrl = (): string | undefined => codexProxy.url();

/** What the last check found for an engine's proxy: "no_binary" or "failed" means its chats run uncompressed. */
export const appProxyState = (engine: string): AppProxyState | undefined => (engine === "codex" ? codexProxy : appProxy).state();

export type AppProxyStates = { readonly app: AppProxyState; readonly codex: AppProxyState };

/** How the runtime starts its proxies; tests swap in one that starts nothing. */
export class AppProxyLauncher extends Context.Reference<() => Promise<AppProxyStates>>("caveman/router/AppProxyLauncher", {
  defaultValue: () => async () => ({ app: await ensureAppProxy(appProxy), codex: await ensureAppProxy(codexProxy) }),
}) {}
