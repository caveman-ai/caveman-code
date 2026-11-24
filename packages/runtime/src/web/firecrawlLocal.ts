// Firecrawl Local (github.com/firecrawl/firecrawl, apps/local; AGPL-3.0, run as its own program and never linked in):
// web_fetch's first reader when it is on this computer (docs/ "Reading through Firecrawl"). It
// fetches and cleans pages here, renders JavaScript in the Chrome on this computer, parses PDFs, and refuses private,
// loopback and metadata addresses at every connection itself. The runtime starts `firecrawl-local serve` the first
// time a read needs it, on a loopback port with a random token, and stops it with the runtime. Firecrawl Cloud is off
// unless the person added a Firecrawl key: then a page that blocks this computer may go to Firecrawl Cloud on that
// key. The process gets a bare environment, never the runtime's: no keys, tokens or project secrets.
//
// It is found, in order: CAVEMAN_FIRECRAWL_LOCAL_BIN (when set, the only place looked), `bin/` beside the runtime
// (where a bundled copy would go, as caveman-proxy's does), then a copy the person installed on PATH or with
// `cargo install firecrawl-local`.
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { killProcessTree, killProcessTreeAsync } from "@caveman-app/shared/processTree";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import {
  type FirecrawlEndpoint,
  type FirecrawlPage,
  FirecrawlPageRefused,
  runFirecrawlScrape,
} from "./firecrawl.ts";
import { WebProviderError } from "./providers.ts";

const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "bin");
/** How long `serve` may take to answer its health check. */
export const FIRECRAWL_LOCAL_START_MS = 10_000;
/** After a start that failed, reads go to the runtime's own reader for this long before it is tried again. */
const RETRY_AFTER_MS = 60_000;
/** How long a lookup stands: one installed while the runtime runs is picked up within this, without a restart. */
const LOOKUP_MS = 60_000;

const executable = (file: string): boolean => {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Where Firecrawl Local is on this computer, or undefined when it is not. */
export function findFirecrawlLocal(
  env: NodeJS.ProcessEnv = process.env,
  bundledDir: string = BUNDLED_DIR,
): string | undefined {
  const override = env.CAVEMAN_FIRECRAWL_LOCAL_BIN;
  if (override !== undefined) return override !== "" && executable(override) ? override : undefined;
  const file = process.platform === "win32" ? "firecrawl-local.exe" : "firecrawl-local";
  const home = env.HOME ?? env.USERPROFILE ?? os.homedir();
  const dirs = [
    bundledDir,
    ...(env.PATH ?? "").split(path.delimiter).filter((dir) => dir !== ""),
    path.join(home, ".cargo", "bin"),
  ];
  return dirs.map((dir) => path.join(dir, file)).find(executable);
}

/** Which Firecrawl Local the runtime uses (tests and the session protocol's harness swap in none). */
export class FirecrawlLocalBinary extends Context.Reference<() => string | undefined>(
  "caveman/web/FirecrawlLocalBinary",
  {
    defaultValue: () => () => findFirecrawlLocal(),
  },
) {}

/** What the process may see of the runtime's environment: enough to find Chrome and a temp folder, nothing else. */
const PASSED = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "SystemRoot",
  "SYSTEMROOT",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramFiles",
  "PROGRAMFILES",
  "ProgramFiles(x86)",
  "PROGRAMFILES(X86)",
  "XDG_RUNTIME_DIR",
];

export function firecrawlLocalEnv(
  home: string,
  cloudKey: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      PASSED.flatMap((name) => (env[name] === undefined ? [] : [[name, env[name]]])),
    ),
    FIRECRAWL_LOCAL_HOME: home,
    // Never the person's own Firecrawl CLI login: a key reaches it only from Settings, below.
    FIRECRAWL_CLI_CREDENTIALS: path.join(home, "no-login.json"),
    FIRECRAWL_CLOUD: cloudKey === undefined ? "off" : "auto",
    ...(cloudKey === undefined ? {} : { FIRECRAWL_API_KEY: cloudKey }),
  };
}

export interface FirecrawlLocal {
  /** Whether it is on this computer (looked up at most once a minute). */
  readonly installed: () => boolean;
  /**
   * `url` read by Firecrawl Local, with Firecrawl Cloud behind it on `cloudKey` when there is one. Throws a
   * `FirecrawlPageRefused` when the page answered with an error or turned it away (the answer about the page), and a
   * `WebProviderError` of kind `unavailable` for anything else (it would not start, stopped, timed out, found no text):
   * then the runtime's own reader takes the page.
   */
  readonly scrape: (
    url: string,
    cloudKey: string | undefined,
    signal: AbortSignal,
  ) => Promise<FirecrawlPage>;
  /** Stops the process, if it runs. */
  readonly close: () => void;
}

interface Server {
  readonly cloudKey: string | undefined;
  readonly ready: Promise<FirecrawlEndpoint>;
  child: ChildProcess | undefined;
  stopped: boolean;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });

const unavailable = (message: string) =>
  new WebProviderError("firecrawl", "unavailable", `Firecrawl Local ${message}`);

export function makeFirecrawlLocal(options: {
  /** Where Firecrawl Local is now (FirecrawlLocalBinary). */
  readonly find: () => string | undefined;
  /** Firecrawl Local's own folder (its install id), private to the runtime's user. */
  readonly home: string;
  readonly startTimeoutMs?: number;
  readonly now?: () => number;
  /**
   * Stops the process and what it started (its Chrome): on Windows `child.kill()` ends that one process only.
   * `wait` on close, where nothing asynchronous finishes; tests watch it.
   */
  readonly kill?: (pid: number | undefined, wait: boolean) => void;
}): FirecrawlLocal {
  const now = options.now ?? Date.now;
  const kill =
    options.kill ?? ((pid, wait) => (wait ? killProcessTree : killProcessTreeAsync)(pid));
  const startTimeoutMs = options.startTimeoutMs ?? FIRECRAWL_LOCAL_START_MS;
  let server: Server | undefined;
  let failedAt: number | undefined;
  let found: { readonly binary: string | undefined; readonly at: number } | undefined;
  const binary = () => {
    if (found === undefined || now() - found.at >= LOOKUP_MS)
      found = { binary: options.find(), at: now() };
    return found.binary;
  };

  const stop = (wait: boolean) => {
    if (server === undefined) return;
    server.stopped = true;
    kill(server.child?.pid, wait);
    server = undefined;
  };

  /** `serve` on a free loopback port, until it answers its health check. */
  const boot = async (entry: Omit<Server, "ready">, file: string): Promise<FirecrawlEndpoint> => {
    fs.mkdirSync(options.home, { recursive: true, mode: 0o700 });
    const port = await freePort();
    if (entry.stopped) throw unavailable("was stopped");
    const token = randomBytes(24).toString("hex");
    let exited = false;
    const child = spawn(
      file,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--token", token],
      {
        env: firecrawlLocalEnv(options.home, entry.cloudKey),
        stdio: "ignore",
      },
    );
    entry.child = child;
    const onEnd = () => {
      exited = true;
      if (server === entry) server = undefined;
    };
    child.once("exit", onEnd);
    child.once("error", onEnd);
    const deadline = now() + startTimeoutMs;
    for (;;) {
      if (exited || entry.stopped) throw unavailable("stopped as it started");
      const up = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(1_000),
      }).then(
        (response) => response.ok,
        () => false,
      );
      if (up) return { api: `http://127.0.0.1:${port}/v2`, token };
      if (now() > deadline) {
        kill(child.pid, false);
        throw unavailable(`did not answer within ${startTimeoutMs / 1000} s of starting`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };

  /** A process for `cloudKey`; one that fails to start leaves reads to the runtime's own reader for a while. */
  const start = (cloudKey: string | undefined, file: string): Server => {
    const entry = { cloudKey, child: undefined, stopped: false } as Omit<Server, "ready">;
    const started: Server = Object.assign(entry, { ready: boot(entry, file) });
    started.ready.catch(() => {
      failedAt = now();
      if (server === started) server = undefined;
    });
    return started;
  };

  const scrape: FirecrawlLocal["scrape"] = async (url, cloudKey, signal) => {
    // A key added or removed in Settings changes what it may hand to Firecrawl Cloud: a fresh process.
    if (server !== undefined && server.cloudKey !== cloudKey) stop(false);
    if (server === undefined) {
      const file = binary();
      if (file === undefined) throw unavailable("is not installed");
      if (failedAt !== undefined && now() - failedAt < RETRY_AFTER_MS)
        throw unavailable("did not start a moment ago");
      server = start(cloudKey, file);
    }
    const endpoint = await server.ready;
    try {
      return await runFirecrawlScrape(endpoint, url, signal);
    } catch (error) {
      if (error instanceof FirecrawlPageRefused) throw error;
      throw unavailable(error instanceof Error ? error.message : String(error));
    }
  };

  return { installed: () => binary() !== undefined, scrape, close: () => stop(true) };
}

/** Firecrawl Local for the runtime, its folder in `home`; stopped when the scope closes. */
export const firecrawlLocalResource = (home: string) =>
  Effect.gen(function* () {
    const find = yield* FirecrawlLocalBinary;
    return yield* Effect.acquireRelease(
      Effect.sync(() => makeFirecrawlLocal({ find, home })),
      (local) => Effect.sync(() => local.close()),
    );
  });
