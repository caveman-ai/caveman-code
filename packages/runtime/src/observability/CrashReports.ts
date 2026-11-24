// Crash reports from the runtime (docs/): an RPC
// handler's defect and an uncaught exception or rejection, with its stack, to
// Caveman's crash service (Sentry), scrubbed here by the problem report rules
// (@caveman-app/bug-report/crash) before anything is written or sent.
//
// Every report is written whole and at once into a spool folder (a dying
// process finishes a write, not a request). Under the desktop app the app
// passes CAVEMAN_CRASH_SPOOL and sends what is there when its switch, its
// disclosure and the Cloud in use allow, or deletes it
// (apps/desktop/src/crashReports.ts); the runtime never sends one itself. On a
// Caveman Cloud computer, whose hosted Cloud alone sets CAVEMAN_CRASH_DSN, the
// runtime sends its own spool, at start (a fatal report from the run before)
// and every minute. Anywhere else (the `caveman-code` command, a company's own
// Cloud) neither is set and nothing starts. DO_NOT_TRACK or
// CAVEMAN_TELEMETRY=0 turns it off everywhere.
//
// @sentry/core rather than @sentry/node: no OpenTelemetry and no
// auto-instrumentation, which would load at every start and take the global
// tracer the runtime's own observability uses.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  CRASH_REDACTION_VERSION,
  scrubCrashEvent,
  telemetryOffByEnv,
} from "@caveman-app/bug-report/crash";
import {
  captureException,
  createStackParser,
  createTransport,
  dedupeIntegration,
  functionToStringIntegration,
  getClient,
  getEnvelopeEndpointWithUrlEncodedAuth,
  initAndBind,
  linkedErrorsIntegration,
  makeDsn,
  rewriteFramesIntegration,
  type BaseTransportOptions,
  type Transport,
  type TransportMakeRequestResponse,
  type TransportRequest,
} from "@sentry/core";
import {
  nodeStackLineParser,
  ServerRuntimeClient,
  type ServerRuntimeClientOptions,
} from "@sentry/core/server";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { reportCrash, setCrashSink } from "./crashSink.ts";

/** Reports the spool holds at most: past this the runtime is in a loop, and the first ones say why. */
export const SPOOL_MAX_FILES = 50;
/** One report's size cap, as Sentry's for an event. */
export const SPOOL_MAX_BYTES = 1024 * 1024;
export const SPOOL_SUFFIX = ".envelope";

/** "desktop": the app sends the spool. "direct": this runtime does (a Cloud computer). */
export interface CrashReportsMode {
  readonly kind: "desktop" | "direct";
  readonly dir: string;
  readonly dsn: string;
}

/** A Cloud computer's spool when the environment names none: beside the runtime's own state, which outlives a restart. */
const ownSpool = (env: NodeJS.ProcessEnv) =>
  path.join(
    env.CAVEMAN_CODE_HOME?.trim() || path.join(os.homedir(), ".caveman-code"),
    "crash-reports",
  );

/** Where this runtime's reports go, from its environment; undefined: nowhere, and nothing starts. */
export function crashReportsMode(
  env: NodeJS.ProcessEnv = process.env,
): CrashReportsMode | undefined {
  if (telemetryOffByEnv(env)) return undefined;
  const dsn = env.CAVEMAN_CRASH_DSN?.trim();
  if (!dsn || makeDsn(dsn) === undefined) return undefined;
  const dir = env.CAVEMAN_CRASH_SPOOL?.trim();
  return dir ? { kind: "desktop", dir, dsn } : { kind: "direct", dir: ownSpool(env), dsn };
}

/**
 * Writes each report into the spool as one file, synchronously: an uncaught exception's report is on disk before the
 * process exits. Full, it writes nothing more; the desktop empties it.
 */
export const spoolRequest =
  (dir: string) =>
  (request: TransportRequest): PromiseLike<TransportMakeRequestResponse> => {
    try {
      const body = typeof request.body === "string" ? Buffer.from(request.body) : request.body;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const queued = fs.readdirSync(dir).filter((name) => name.endsWith(SPOOL_SUFFIX)).length;
      if (body.byteLength <= SPOOL_MAX_BYTES && queued < SPOOL_MAX_FILES) {
        const file = path.join(dir, `${Date.now()}-${randomUUID()}${SPOOL_SUFFIX}`);
        fs.writeFileSync(`${file}.tmp`, body, { mode: 0o600 });
        fs.renameSync(`${file}.tmp`, file);
      }
    } catch {
      // A report that cannot be written is lost; the crash itself is still in the runtime's log.
    }
    return Promise.resolve({ statusCode: 200 });
  };

/** Spooled reports older than this are deleted unsent: a crash that old has been fixed or reported again. */
const SPOOL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often a Cloud computer's runtime sends its spool. */
const DRAIN_EVERY_MS = 60_000;

/**
 * Sends the spool to Sentry, oldest first, deleting each report Sentry took or refused for good (2xx, or 4xx other
 * than 429). A rate limit, a server error or no network stops the round; what is left goes the next one.
 */
export async function drainOwnSpool(
  dir: string,
  url: string,
  now: number = Date.now(),
): Promise<number> {
  let names: string[];
  try {
    names = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(SPOOL_SUFFIX))
      .sort();
  } catch {
    return 0;
  }
  let sent = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (now - fs.statSync(file).mtimeMs > SPOOL_MAX_AGE_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const response = await fetch(url, {
        method: "POST",
        body: fs.readFileSync(file),
        signal: AbortSignal.timeout(10_000),
      });
      await response.body?.cancel();
      if (response.status === 429 || response.status >= 500) return sent;
      fs.rmSync(file, { force: true });
      if (response.ok) sent += 1;
    } catch {
      return sent;
    }
  }
  return sent;
}

let client: ServerRuntimeClient | undefined;

/** Starts crash reports where this runtime's environment says to; a second call does nothing. */
export function startCrashReports(env: NodeJS.ProcessEnv = process.env): boolean {
  if (client !== undefined) return true;
  const mode = crashReportsMode(env);
  if (mode === undefined) return false;
  const ctx = { homeDir: os.homedir(), userName: safeUserName() };
  const options: ServerRuntimeClientOptions = {
    dsn: mode.dsn,
    release: `caveman-code@${env.CAVEMAN_APP_VERSION?.trim() || RUNTIME_VERSION}`,
    environment: env.CAVEMAN_BUILD_CHANNEL?.trim() || (mode.kind === "direct" ? "computer" : "cli"),
    platform: "node",
    runtime: { name: "node", version: process.version },
    stackParser: createStackParser(nodeStackLineParser()),
    transport: (transportOptions: BaseTransportOptions): Transport =>
      createTransport(transportOptions, spoolRequest(mode.dir)),
    integrations: [
      functionToStringIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      // The bundle's own chunks by name (app:///server-<hash>.mjs), wherever the app is installed.
      rewriteFramesIntegration({ root: path.dirname(process.argv[1] ?? ""), prefix: "app:///" }),
    ],
    initialScope: {
      tags: {
        "event.process": "runtime",
        host: mode.kind === "desktop" ? "desktop" : "computer",
        redaction: CRASH_REDACTION_VERSION,
      },
    },
    sendClientReports: false,
    maxBreadcrumbs: 0,
    beforeSend: (event) => scrubCrashEvent(event, ctx),
  };
  initAndBind(ServerRuntimeClient, options);
  client = getClient<ServerRuntimeClient>();
  setCrashSink((error, mechanism, fatal) =>
    captureException(error, {
      mechanism: { type: mechanism, handled: !fatal },
      captureContext: { level: fatal ? "fatal" : "error" },
    }),
  );
  // A monitor reports without changing what Node does with the error: it still ends the process.
  process.on("uncaughtExceptionMonitor", (error, origin) =>
    reportCrash(
      error,
      origin === "unhandledRejection" ? "unhandled_rejection" : "uncaught_exception",
      true,
    ),
  );
  if (mode.kind === "direct") {
    const url = getEnvelopeEndpointWithUrlEncodedAuth(makeDsn(mode.dsn)!);
    const drain = () => void drainOwnSpool(mode.dir, url);
    drain();
    setInterval(drain, DRAIN_EVERY_MS).unref();
  }
  return true;
}

const safeUserName = (): string | undefined => {
  try {
    return os.userInfo().username;
  } catch {
    return undefined;
  }
};

/** Tests only: forget the client this process started. */
export const resetCrashReportsForTest = (): void => {
  client = undefined;
  setCrashSink(undefined);
};
