// Crash and onboarding counts from the desktop app, in the v4 CLI's cli/v1
// envelope, to Caveman Cloud's receiver (control-api POST /telemetry/cli,
// which stores them in ClickHouse caveman.cli_events beside the CLI's events).
// The receiver is the one of the Cloud the app uses (settings.cloud_url, or
// CAVEMAN_CLOUD_URL when an IT team pins it): Caveman's own for the hosted
// Cloud; for a company's own Cloud, that Cloud's control-api on the API host
// its /runtime-config.js names, when it takes an empty batch, else nothing is
// sent at all. Never a Caveman host for a Cloud that is not Caveman's.
// Content-free by construction: every string is from a fixed list or
// token-shaped, never a prompt, code, path, message or stack trace (stacks stay
// in this computer's desktop.log). Opt-out with disclosure, as the spec asks
// of the CLI: nothing leaves until the first onboarding screen has shown the
// disclosure line and its switch (the welcome_shown step); what happened before
// then is held in memory and sent with it. Off under Settings > General or that
// switch, and whenever DO_NOT_TRACK or CAVEMAN_TELEMETRY=0 is set, as in the CLI.
// ponytail: no retry spool and no stacks on the wire; add a frames column to the
// receiver when crash counts alone cannot place a crash.
//
// Turn stats (docs/): once a minute
// while sending, the runtime's telemetry.turns gives each settled turn's
// anonymous fact, sent as a code_turn event (Cloud stores it in
// caveman.code_turns) and acknowledged once posted, so a failed post is sent
// again. They start at `turnsSince`, the moment a disclosure naming turn stats
// was on screen: the onboarding line for a new install, Settings or the one-time
// notice (disclosed()) for one that saw the older line. Off forgets it, so turns
// from while it was off are never sent.
import type { TurnFact } from "@caveman-app/session-protocol";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { telemetryOffByEnv } from "../../../packages/bug-report/src/crash.ts";
import { writeFileStaged } from "./stagedWrite.ts";

export const TELEMETRY_URL = "https://api.caveman.so/telemetry/cli";
/** Caveman's hosted Cloud (the runtime's HOSTED_CLOUD): the only Cloud whose events go to TELEMETRY_URL. */
export const HOSTED_CLOUD = "https://app.caveman.so";
/**
 * The onboarding funnel, in order. Each step is sent once per install. The web client names the same steps
 * (apps/web/src/state/desktop.ts): signed in, Your setup shown, the first project ready, the tour done, then the
 * Unlock sheet shown, its checkout started and a plan unlocked (docs/); then the first
 * run's offers, each shown and taken, and a tour replayed from Help > Show the Tour.
 */
export const ONBOARDING_STEPS = [
  "first_launch",
  "runtime_ready",
  "welcome_shown",
  "signed_in",
  "setup_shown",
  "first_workspace",
  "project_ready",
  "tour_done",
  "unlock_shown",
  "unlock_started",
  "unlocked",
  // The first run's offers (apps/web onboarding): each shown, and taken.
  "offer_window_shown",
  "offer_window_unlock",
  "offer_lid_shown",
  "offer_lid_unlock",
  "offer_chief_shown",
  "offer_chief_unlock",
  "offer_gift_shown",
  "offer_gift_open",
  // Help > Show the Tour, after the first one.
  "tour_replayed",
] as const;
/** The step whose screen shows the disclosure (apps/web/src/routes/Onboarding.tsx). */
const DISCLOSED_AT = "welcome_shown";
export const CRASH_KINDS = ["main_exception", "main_rejection", "renderer_exception", "renderer_gone", "child_gone", "runtime_exit"] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number];
export type CrashKind = (typeof CRASH_KINDS)[number];

/**
 * Crash reasons the receiver takes (Caveman Cloud cli_telemetry.go keeps the same list):
 * Electron's gone reasons, the signals that end a process, JavaScript's built-in
 * error names, and exit_<0..255>. Anything else is "other".
 */
export const CRASH_REASONS = new Set([
  "abnormal-exit", "killed", "crashed", "oom", "launch-failed", "integrity-failure", "memory-eviction",
  "SIGSEGV", "SIGABRT", "SIGBUS", "SIGILL", "SIGFPE", "SIGTRAP", "SIGKILL", "SIGTERM", "SIGINT", "SIGHUP",
  "Error", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "EvalError", "URIError", "AggregateError", "NonError",
]);
/** Crash events per launch: a renderer error loop must not flood the receiver. */
const MAX_CRASHES = 20;
/** Events per post: control-api cliTelemetryMaxBatch. */
const MAX_BATCH = 20;
const TOKEN = /^[A-Za-z0-9._+-]{1,64}$/;

interface Stored {
  readonly enabled: boolean;
  readonly anonymousId?: string | undefined;
  readonly steps: ReadonlyArray<string>;
  /** The disclosure has been on screen; until then events wait in memory. */
  readonly disclosed?: boolean | undefined;
  /** The Cloud the app used when last read (undefined: the hosted one), for a send while the runtime cannot say. */
  readonly cloud?: string | undefined;
  /** A line naming turn stats has been on screen with telemetry on (onboarding, Settings or the one-time notice). */
  readonly turnsShown?: boolean | undefined;
  /**
   * Turns from then on are sent: when that line showed, or telemetry was turned on, or the first launch that could
   * send after one that could not (DO_NOT_TRACK or CAVEMAN_TELEMETRY=0 was set): turns from such a launch never go.
   */
  readonly turnsSince?: string | undefined;
  /**
   * A line naming crash reports (the stack and scrubbed message of what failed) has been on screen with telemetry on:
   * the onboarding line, Settings, or the one-time notice. Until then crash reports wait in memory (src/crashReports.ts).
   */
  readonly reportsShown?: boolean | undefined;
}

/**
 * What may happen to a crash report now (src/crashReports.ts): sent, held in memory until a disclosure naming crash
 * reports has shown, or dropped (telemetry is off, or the Cloud in use is not Caveman's: a company's own Cloud gets
 * no crash reports, and they never go to Caveman for it).
 */
export type CrashGate = "send" | "hold" | "drop";

/** How long a read of the Cloud in use answers the crash gate: a burst of reports asks the runtime once. */
const CLOUD_READ_MS = 30_000;

/** The runtime's telemetry.turns, as main.ts reaches it. */
export type AskTurns = (params: { readonly since: string; readonly ack?: number }) => Promise<{ readonly facts: ReadonlyArray<TurnFact> }>;

export interface TelemetryEnv {
  readonly DO_NOT_TRACK?: string | undefined;
  readonly CAVEMAN_TELEMETRY?: string | undefined;
  /** The Cloud an IT team pinned this computer to (the runtime reads the same variable): it decides, whatever Settings says. */
  readonly CAVEMAN_CLOUD_URL?: string | undefined;
}

/** The CLI's environment override: DO_NOT_TRACK or CAVEMAN_TELEMETRY=0/false/off turns it off, crash reports too. */
export const envOff = (env: TelemetryEnv): boolean => telemetryOffByEnv(env);

/** A token the receiver accepts, or "other". */
export const token = (value: unknown): string => (typeof value === "string" && TOKEN.test(value) ? value : "other");

export const crashReason = (value: unknown): string =>
  typeof value === "string" && (CRASH_REASONS.has(value) || /^exit_(?:0|[1-9]\d?|1\d\d|2[0-4]\d|25[0-5])$/.test(value)) ? value : "other";

export type Send = (url: string, body: string) => Promise<void>;

const USER_AGENT = "caveman-code-desktop";

/** https, or http to a loopback host (a local stack), as the runtime's cloudOrigin; undefined when it is neither. */
export const cloudOrigin = (raw: string): string | undefined => {
  try {
    const url = new URL(raw.trim());
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) || url.username || url.password) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
};

/** caveman.so or a host under it. */
const onCavemanHost = (origin: string): boolean => {
  const host = new URL(origin).hostname.toLowerCase();
  return host === "caveman.so" || host.endsWith(".caveman.so");
};

/** The apiURL in a Cloud's /runtime-config.js (`globalThis.__CAVE_RUNTIME_CONFIG__=Object.freeze({...});`), as an origin. */
export const runtimeConfigApi = (script: string): string | undefined => {
  const json = /Object\.freeze\((\{[\s\S]*\})\)\s*;?\s*$/.exec(script.trim())?.[1];
  if (json === undefined) return undefined;
  try {
    const api = (JSON.parse(json) as { apiURL?: unknown }).apiURL;
    return typeof api === "string" && api !== "" ? cloudOrigin(api) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * A company Cloud's own receiver: POST /telemetry/cli on the API host its
 * /runtime-config.js names (control-api answers 202 to anything it parses,
 * an empty batch included, and sends nothing on). Undefined when the Cloud
 * names no API host, names a Caveman host, or does not take the empty batch
 * (a single-host install routes /telemetry/cli to its web app, which does not).
 * No redirect is followed.
 */
export async function cloudTelemetryUrl(cloud: string, fetchImpl: typeof fetch = fetch): Promise<string | undefined> {
  try {
    const config = await fetchImpl(`${cloud}/runtime-config.js`, { headers: { "user-agent": USER_AGENT }, redirect: "error", signal: AbortSignal.timeout(5_000) });
    const api = config.ok ? runtimeConfigApi(await config.text()) : (await config.body?.cancel(), undefined);
    if (api === undefined || onCavemanHost(api)) return undefined;
    const url = `${api}/telemetry/cli`;
    const probe = await fetchImpl(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": USER_AGENT }, body: "[]", redirect: "error", signal: AbortSignal.timeout(5_000) });
    await probe.body?.cancel();
    return probe.status === 202 ? url : undefined;
  } catch {
    return undefined;
  }
}

const fetchSend: Send = async (url, body) => {
  // The receiver refuses browser posts and answers 202 to anything it parses. A 5xx or 429 came from something in
  // between (a proxy, a gateway): the post did not arrive, so turn stats send it again. Any other answer is final.
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": USER_AGENT }, body, redirect: "error", signal: AbortSignal.timeout(5_000) });
  await response.body?.cancel();
  if (response.status >= 500 || response.status === 429) throw new Error(`receiver answered ${response.status}`);
};

export interface TelemetryOptions {
  readonly file: string;
  readonly version: string;
  readonly env?: TelemetryEnv;
  readonly send?: Send;
  /** A receiver of its own (test builds' CAVEMAN_TELEMETRY_URL): used whatever Cloud the app uses. */
  readonly url?: string | undefined;
  /**
   * The Cloud the app uses now (the runtime's settings.cloud_url; undefined: the hosted one), read before each send.
   * A failed read uses the Cloud read last. Absent: the Cloud read last, else the hosted one.
   */
  readonly cloud?: () => Promise<string | undefined>;
  /** For the receiver lookup on a company's own Cloud. */
  readonly fetch?: typeof fetch;
  /** Development builds and the smoke test: everything runs, nothing is sent. */
  readonly dryRun?: boolean;
  readonly log?: (line: string) => void;
}

export class Telemetry {
  private stored: Stored;
  private crashes = 0;
  private held: Array<Record<string, unknown>> = [];
  /** Receivers looked up this launch, by Cloud origin. */
  private readonly receivers = new Map<string, Promise<string | undefined>>();
  /** The send waiting on where to send; events held meanwhile go with it. */
  private flushing: Promise<void> | undefined;
  private readonly env: TelemetryEnv;
  private readonly send: Send;
  private readonly options: TelemetryOptions;
  /** True when this launch created the file: the install's first launch. */
  readonly firstLaunch: boolean;

  constructor(options: TelemetryOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.send = options.send ?? fetchSend;
    let stored: Stored | undefined;
    try {
      const raw = JSON.parse(readFileSync(options.file, "utf8")) as Partial<Stored>;
      stored = {
        enabled: raw.enabled !== false,
        anonymousId: raw.anonymousId,
        steps: Array.isArray(raw.steps) ? raw.steps.filter((s) => typeof s === "string") : [],
        disclosed: raw.disclosed === true,
        ...(typeof raw.cloud === "string" ? { cloud: raw.cloud } : {}),
        ...(raw.turnsShown === true ? { turnsShown: true } : {}),
        ...(typeof raw.turnsSince === "string" ? { turnsSince: raw.turnsSince } : {}),
        ...(raw.reportsShown === true ? { reportsShown: true } : {}),
      };
    } catch {
      stored = undefined;
    }
    this.firstLaunch = stored === undefined;
    this.stored = stored ?? { enabled: true, anonymousId: randomUUID(), steps: [] };
    // A launch that may not send: turns run now are never sent, so the count starts again on the next one that may.
    if (envOff(this.env) && this.stored.turnsSince !== undefined) {
      const { turnsSince: _off, ...rest } = this.stored;
      this.stored = rest;
      this.save();
    }
    if (this.firstLaunch) this.save();
  }

  /**
   * What Settings shows: the stored choice, and whether the environment overrides it. `turnsDisclosed` and
   * `reportsDisclosed`: a disclosure naming turn stats, and one naming crash reports, has shown; until both have, an
   * install that saw an older line gets the one-time notice.
   */
  get choice(): { enabled: boolean; envOff: boolean; dryRun: boolean; turnsDisclosed: boolean; reportsDisclosed: boolean } {
    return {
      enabled: this.stored.enabled,
      envOff: envOff(this.env),
      dryRun: this.options.dryRun === true,
      turnsDisclosed: this.stored.turnsShown === true,
      reportsDisclosed: this.stored.reportsShown === true,
    };
  }

  /** The anonymous install id while telemetry is on: crash reports carry it, so Sentry counts installs, not people. */
  get anonymousId(): string | undefined {
    return this.stored.enabled ? this.stored.anonymousId : undefined;
  }

  private readonly listeners = new Set<() => void>();

  /** Runs `listener` whenever the choice or a disclosure changes (src/crashReports.ts releases or drops what it held). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of this.listeners) listener();
  }

  /**
   * Whether crash reports could go at all, from what this launch knows before the runtime answers: telemetry on, and
   * the Cloud pinned, or used last, Caveman's. The desktop loads its crash reporter only then; each report still asks
   * crashGate().
   */
  get crashReportsPossible(): boolean {
    if (!this.stored.enabled || envOff(this.env)) return false;
    const pinned = this.env.CAVEMAN_CLOUD_URL?.trim();
    return cloudOrigin(pinned || this.stored.cloud || HOSTED_CLOUD) === HOSTED_CLOUD;
  }

  private cloudRead: { at: number; hosted: Promise<boolean> } | undefined;

  /** What may happen to a crash report now; reads the Cloud in use at most every CLOUD_READ_MS. Never rejects. */
  async crashGate(now: number = Date.now()): Promise<CrashGate> {
    if (!this.stored.enabled || this.stored.anonymousId === undefined || envOff(this.env)) return "drop";
    if (this.stored.disclosed !== true || this.stored.reportsShown !== true) return "hold";
    if (this.cloudRead === undefined || now - this.cloudRead.at > CLOUD_READ_MS) this.cloudRead = { at: now, hosted: this.onHostedCloud() };
    return (await this.cloudRead.hosted) ? "send" : "drop";
  }

  /** The Cloud this app uses now is Caveman's: CAVEMAN_CLOUD_URL when pinned, else the runtime's, else the one read last. */
  private async onHostedCloud(): Promise<boolean> {
    const pinned = this.env.CAVEMAN_CLOUD_URL?.trim();
    let cloud: string | undefined;
    if (pinned) cloud = pinned;
    else {
      try {
        cloud = this.options.cloud ? await this.options.cloud() : this.stored.cloud;
        if (this.options.cloud) this.remember(cloud);
      } catch {
        cloud = this.stored.cloud;
      }
    }
    return cloudOrigin(cloud ?? HOSTED_CLOUD) === HOSTED_CLOUD;
  }

  private get sending(): boolean {
    return this.stored.enabled && this.stored.anonymousId !== undefined && !envOff(this.env) && this.options.dryRun !== true;
  }

  /**
   * Off forgets the anonymous id, so turning it back on starts a new one, as `caveman telemetry off` does, and forgets
   * when turn stats began. On counts turns from now: wherever it is turned on, the line beside the switch names them.
   */
  setEnabled(enabled: boolean): void {
    this.stored = enabled
      ? {
          ...this.stored,
          enabled,
          anonymousId: this.stored.anonymousId ?? randomUUID(),
          turnsShown: true,
          turnsSince: this.stored.enabled && this.stored.turnsSince !== undefined ? this.stored.turnsSince : new Date().toISOString(),
          // The line beside the switch names crash reports too.
          reportsShown: true,
        }
      : { enabled, steps: this.stored.steps, disclosed: this.stored.disclosed, ...(this.stored.cloud === undefined ? {} : { cloud: this.stored.cloud }) };
    if (!enabled) {
      this.held = [];
      this.turnsAck = undefined;
    }
    this.save();
    this.changed();
  }

  /**
   * The one-time notice, or Settings' line, naming turn stats and crash reports is on screen (an install that saw an
   * older disclosure): turns count from now, and crash reports may go.
   */
  disclosed(): void {
    if (!this.stored.enabled || envOff(this.env) || (this.stored.turnsShown === true && this.stored.reportsShown === true)) return;
    this.stored = {
      ...this.stored,
      ...(this.stored.turnsShown === true ? {} : { turnsShown: true, turnsSince: new Date().toISOString() }),
      reportsShown: true,
    };
    this.save();
    this.changed();
  }

  sent(name: OnboardingStep): boolean {
    return this.stored.steps.includes(name);
  }

  step(name: string): void {
    if (!(ONBOARDING_STEPS as ReadonlyArray<string>).includes(name) || this.stored.steps.includes(name)) return;
    // The first onboarding screen's line names turn stats and crash reports: turns count from the moment it showed.
    const shown = name === DISCLOSED_AT && this.stored.enabled && !envOff(this.env);
    const naming = shown && this.stored.turnsShown !== true;
    this.stored = {
      ...this.stored,
      steps: [...this.stored.steps, name],
      disclosed: this.stored.disclosed === true || name === DISCLOSED_AT,
      ...(naming ? { turnsShown: true, turnsSince: new Date().toISOString() } : {}),
      ...(shown ? { reportsShown: true } : {}),
    };
    this.save();
    if (name === DISCLOSED_AT) this.changed();
    this.emit({ event: "onboarding_step", command: "onboarding", subcommand: name });
  }

  /** `reason`: Electron's gone reason, a signal, exit_<code>, or an error's name (CRASH_REASONS); anything else is "other". */
  crash(kind: CrashKind, reason: unknown): void {
    if (!(CRASH_KINDS as ReadonlyArray<string>).includes(kind) || this.crashes >= MAX_CRASHES) return;
    this.crashes += 1;
    this.emit({ event: "app_crash", command: "desktop", subcommand: kind, exit_class: "error", error_class: crashReason(reason) });
  }

  private envelope(fields: Record<string, unknown>, ts: string = new Date().toISOString()): Record<string, unknown> {
    return {
      schema: "cli/v1",
      anonymous_id: this.stored.anonymousId,
      ...fields,
      cli_version: token(this.options.version),
      os: process.platform,
      arch: process.arch,
      node_major: Number(process.versions.node.split(".")[0]),
      ts,
    };
  }

  private emit(fields: Record<string, string>): void {
    if (!this.sending) return;
    this.held.push(this.envelope(fields));
    if (this.stored.disclosed !== true) return;
    this.flush();
  }

  /** The highest fact seq posted and not yet acknowledged to the runtime (it is, with the next ask). */
  private turnsAck: number | undefined;
  private asking = false;

  /**
   * One round of turn stats (main.ts runs it once a minute): ask the runtime for its settled turns, post them, and
   * acknowledge what was posted with the next ask. Nothing is asked while sending is off or before a disclosure naming
   * turn stats has shown, so the runtime does no telemetry work at all then. Never throws.
   */
  async turns(ask: AskTurns): Promise<void> {
    if (!this.sending || this.stored.disclosed !== true || this.stored.turnsShown !== true || this.asking) return;
    // The first launch that may send after one that could not: count from now.
    if (this.stored.turnsSince === undefined) {
      this.stored = { ...this.stored, turnsSince: new Date().toISOString() };
      this.save();
    }
    const since = this.stored.turnsSince!;
    this.asking = true;
    try {
      const { facts } = await ask({ since, ...(this.turnsAck === undefined ? {} : { ack: this.turnsAck }) });
      this.turnsAck = undefined;
      if (facts.length === 0 || !this.sending || this.stored.turnsSince !== since) return;
      const url = await this.receiver();
      // This Cloud takes none: they go nowhere, and are not asked for again.
      if (url === undefined) {
        this.turnsAck = Math.max(...facts.map((fact) => fact.seq));
        return;
      }
      for (let i = 0; i < facts.length; i += MAX_BATCH) {
        // Turned off while this round ran (a company Cloud's lookup, a slow post): nothing more goes.
        if (!this.sending || this.stored.turnsSince !== since) return;
        const batch = facts.slice(i, i + MAX_BATCH);
        const events = batch.map(({ seq: _seq, ...turn }) => this.envelope({ event: "code_turn", command: "code", subcommand: "turn", turn }, turn.started_at));
        await this.send(url, JSON.stringify(events));
        this.turnsAck = batch.at(-1)!.seq;
      }
    } catch (error) {
      this.options.log?.(`telemetry: turn stats not sent (${error instanceof Error ? error.name : "error"})`);
    } finally {
      this.asking = false;
    }
  }

  /** Resolves once no send waits on where to send (tests). */
  async idle(): Promise<void> {
    while (this.flushing) await this.flushing;
  }

  private flush(): void {
    const where = this.receiver();
    if (typeof where === "string" || where === undefined) return this.post(where);
    // One lookup at a time: what arrives meanwhile goes with it, or with the next.
    if (this.flushing) return;
    this.flushing = where
      .then((url) => this.post(url), () => this.post(undefined))
      .finally(() => {
        this.flushing = undefined;
        if (this.held.length > 0 && this.stored.disclosed === true) this.flush();
      });
  }

  /** Nowhere (`undefined`): this Cloud takes none, so what was held is dropped and nothing is sent. */
  private post(url: string | undefined): void {
    if (url === undefined) {
      this.held = [];
      return;
    }
    // The receiver drops a batch of more than MAX_BATCH whole.
    while (this.held.length > 0)
      this.send(url, JSON.stringify(this.held.splice(0, MAX_BATCH))).catch((error: unknown) =>
        this.options.log?.(`telemetry: not sent (${error instanceof Error ? error.name : "error"})`),
      );
  }

  /** Where events go now: a string at once for the hosted Cloud (and a test receiver), a lookup for any other. */
  private receiver(): string | undefined | Promise<string | undefined> {
    if (this.options.url !== undefined) return this.options.url;
    const pinned = this.env.CAVEMAN_CLOUD_URL?.trim();
    if (pinned) return this.receiverFor(pinned);
    const read = this.options.cloud;
    if (read === undefined) return this.receiverFor(this.stored.cloud);
    return read().then(
      (cloud) => (this.remember(cloud), this.receiverFor(cloud)),
      () => this.receiverFor(this.stored.cloud),
    );
  }

  private receiverFor(cloud: string | undefined): string | undefined | Promise<string | undefined> {
    const origin = cloudOrigin(cloud ?? HOSTED_CLOUD);
    // Not a usable Cloud URL: no Cloud, so no receiver.
    if (origin === undefined) return undefined;
    if (origin === HOSTED_CLOUD) return TELEMETRY_URL;
    let found = this.receivers.get(origin);
    if (found === undefined) this.receivers.set(origin, (found = cloudTelemetryUrl(origin, this.options.fetch)));
    return found;
  }

  private remember(cloud: string | undefined): void {
    if (cloud === this.stored.cloud) return;
    const { cloud: _was, ...rest } = this.stored;
    this.stored = cloud === undefined ? rest : { ...rest, cloud };
    this.save();
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true });
      writeFileStaged(this.options.file, `${JSON.stringify(this.stored)}\n`, { mode: 0o600 });
    } catch (error) {
      this.options.log?.(`telemetry: could not save its choice: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
