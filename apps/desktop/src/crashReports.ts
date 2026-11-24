// Crash reports to Caveman's crash service, Sentry (docs/): what failed and where, so a crash
// can be found and fixed. The app's main process, its page (over IPC, src/preload.ts), its native crashes
// (Crashpad's minidumps) and the runtime (its spool, below) all leave through the one transport here, which asks
// the telemetry gate (src/telemetry.ts crashGate) before anything goes:
//   - telemetry off, DO_NOT_TRACK or CAVEMAN_TELEMETRY=0: dropped;
//   - before a line naming crash reports has shown (onboarding, Settings, or the one-time notice): held in memory,
//     sent once one has, dropped if the app quits first;
//   - the Cloud in use is a company's own: dropped. They never go to Caveman, and that Cloud gets none either.
// Every event is scrubbed first by the problem report rules (@caveman-app/bug-report/crash): the error, its stack
// and app context stay; secrets, emails, the home folder, local variables, source lines, the request and every
// breadcrumb but lifecycle and navigation go.
//
// Loaded only where reports could go (a DSN in this build, telemetry on, Caveman's Cloud): elsewhere minidumps stay in
// the crashDumps folder as before and the SDK never loads. Main-process errors come from the existing monitor in
// main.ts, which reports without changing what Electron does with them; the SDK's own handlers would.
import type * as SentryMain from "@sentry/electron/main";
import {
  parseEnvelope,
  type Envelope,
  type Transport,
  type TransportMakeRequestResponse,
} from "@sentry/core";
import { readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CRASH_REDACTION_VERSION,
  scrubCrashEvent,
} from "../../../packages/bug-report/src/crash.ts";
import type { CrashGate } from "./telemetry.ts";

/** Reports held in memory before the disclosure: past this, a crash loop's first ones say why. */
export const MAX_HELD = 30;
/** Runtime reports older than this are deleted unsent: a crash that old has been fixed or reported again. */
const SPOOL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** How often the runtime's spool is read while the app runs (and at once after the runtime exits). */
const SPOOL_EVERY_MS = 60_000;

/** The transport every report leaves through; `release` re-asks the gate for what it held. */
export interface GatedTransport extends Transport {
  release(): Promise<void>;
}

/** Asks `gate` before each send: sends, holds in memory (at most MAX_HELD), or drops. */
export function gatedTransport(
  inner: Transport,
  gate: () => Promise<CrashGate>,
  log: (line: string) => void,
): GatedTransport {
  let held: Envelope[] = [];
  const sent: TransportMakeRequestResponse = {};
  return {
    async send(envelope) {
      const now = await gate();
      if (now === "send") return inner.send(envelope);
      if (now === "hold" && held.length < MAX_HELD) held.push(envelope);
      return sent;
    },
    flush: (timeout) => inner.flush(timeout),
    async release() {
      const now = await gate();
      if (now === "hold") return;
      const waiting = held;
      held = [];
      if (now === "drop") return;
      for (const envelope of waiting)
        await inner
          .send(envelope)
          .then(undefined, (error: unknown) =>
            log(
              `crash reports: a held report was not sent (${error instanceof Error ? error.name : "error"})`,
            ),
          );
    },
  };
}

/** What the spool holds as Sentry envelopes, oldest first; unreadable and stale files are deleted. */
export function readSpool(
  dir: string,
  now: number = Date.now(),
): Array<{ file: string; envelope: Envelope | undefined }> {
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out: Array<{ file: string; envelope: Envelope | undefined }> = [];
  for (const name of names) {
    const file = join(dir, name);
    try {
      const age = now - statSync(file).mtimeMs;
      // A write the runtime never finished (left a minute, in case it is finishing it now), or a report too old to matter.
      if (name.endsWith(".envelope") ? age > SPOOL_MAX_AGE_MS : age > 60_000)
        rmSync(file, { force: true });
      if (!name.endsWith(".envelope") || age > SPOOL_MAX_AGE_MS) continue;
      out.push({ file, envelope: parseEnvelope(readFileSync(file)) });
    } catch {
      out.push({ file, envelope: undefined });
    }
  }
  return out;
}

/**
 * Sends the runtime's reports through `send` (the gated transport, via the client) and deletes them, unless they must
 * wait for the disclosure; dropped ones are deleted unsent.
 */
export async function drainSpool(
  dir: string,
  gate: () => Promise<CrashGate>,
  send: (envelope: Envelope) => PromiseLike<unknown>,
): Promise<number> {
  const now = await gate();
  if (now === "hold") return 0;
  let sent = 0;
  for (const { file, envelope } of readSpool(dir)) {
    rmSync(file, { force: true });
    if (now === "send" && envelope !== undefined) {
      await send(envelope);
      sent += 1;
    }
  }
  return sent;
}

export interface CrashReportsOptions {
  readonly dsn: string;
  readonly version: string;
  /** The build channel (stable, nightly, test, dev): Sentry's environment. */
  readonly channel: string;
  readonly gate: () => Promise<CrashGate>;
  /** Runs its listener when the choice or a disclosure changes: held reports are sent or dropped then. */
  readonly onChange: (listener: () => void) => void;
  readonly anonymousId: () => string | undefined;
  /** Where the runtime this app starts writes its reports (CAVEMAN_CRASH_SPOOL). */
  readonly spoolDir: string;
  readonly homeDir: string;
  readonly userName: string | undefined;
  readonly log: (line: string) => void;
}

export interface CrashReports {
  /** A main-process failure, from main.ts's monitor (`mechanism`: main_exception, main_rejection). */
  capture(error: unknown, mechanism: string): void;
  /** The runtime exited on its own: its exit, and at once whatever it wrote in the spool. */
  runtimeExited(code: number | null, signal: string | null): void;
}

/** Loads Sentry and starts crash reports. Electron is ready (the renderer IPC is classic, which needs no scheme). */
export async function startCrashReports(options: CrashReportsOptions): Promise<CrashReports> {
  const Sentry: typeof SentryMain = await import("@sentry/electron/main");
  const ctx = { homeDir: options.homeDir, userName: options.userName };
  let transport: GatedTransport | undefined;
  Sentry.init({
    dsn: options.dsn,
    release: `caveman-code@${options.version}`,
    environment: options.channel,
    // IPC only: a custom scheme must be registered before the app is ready, and this loads after.
    ipcMode: Sentry.IPCMode.Classic,
    // Each one chosen: none that adds a handler to the process, records console output, requests or local
    // variables, reads source lines, injects a preload into every window, or takes screenshots.
    defaultIntegrations: false,
    integrations: [
      Sentry.sentryMinidumpIntegration({ maxMinidumpsPerSession: 10 }),
      Sentry.childProcessIntegration(),
      Sentry.electronBreadcrumbsIntegration(),
      Sentry.electronContextIntegration(),
      Sentry.additionalContextIntegration(),
      Sentry.gpuContextIntegration(),
      Sentry.mainProcessSessionIntegration(),
      Sentry.eventFiltersIntegration(),
      Sentry.functionToStringIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.dedupeIntegration(),
      Sentry.nodeContextIntegration({ cloudResource: false }),
      // Last: paths become app:///… once the others have read them.
      Sentry.normalizePathsIntegration(),
    ],
    // The SDK's offline store retries what failed to send; the gate sits under it, so a retry asks again too.
    transport: Sentry.makeElectronOfflineTransport(
      (transportOptions) =>
        (transport = gatedTransport(
          Sentry.makeElectronTransport(transportOptions),
          options.gate,
          options.log,
        )),
    ),
    dataCollection: { userInfo: false, cookies: false, httpBodies: [], urlQueryParams: false },
    sendClientReports: false,
    maxBreadcrumbs: 30,
    // The SDK tags each event's process (event.process: browser, renderer, native, utility); the runtime's say runtime.
    initialScope: { tags: { redaction: CRASH_REDACTION_VERSION } },
    beforeSend: (event) => scrubCrashEvent(event, ctx),
  });
  const identify = () =>
    Sentry.setUser(options.anonymousId() ? { id: options.anonymousId()! } : null);
  identify();

  const drain = () =>
    drainSpool(
      options.spoolDir,
      options.gate,
      (envelope) => Sentry.getClient()?.sendEnvelope(envelope) ?? Promise.resolve(),
    ).then(
      (sent) => sent > 0 && options.log(`crash reports: sent ${sent} from the runtime`),
      (error: unknown) =>
        options.log(
          `crash reports: the runtime's were not read (${error instanceof Error ? error.message : String(error)})`,
        ),
    );
  options.onChange(() => {
    identify();
    void transport?.release();
    void drain();
  });
  void drain();
  setInterval(() => void drain(), SPOOL_EVERY_MS).unref();
  options.log(`crash reports: on for ${options.channel}`);

  return {
    capture(error, mechanism) {
      Sentry.captureException(error, {
        mechanism: { type: mechanism, handled: false },
        captureContext: { level: "fatal" },
      });
    },
    runtimeExited(code, signal) {
      Sentry.captureMessage(`The runtime exited (${signal ?? `code ${code}`})`, {
        level: "error",
        tags: { "event.process": "runtime", "exit.reason": signal ?? `exit_${code}` },
        fingerprint: ["runtime-exit", signal ?? `exit_${code}`],
      });
      // Its own report of why, when it could write one, is in the spool by now.
      void drain();
    },
  };
}
