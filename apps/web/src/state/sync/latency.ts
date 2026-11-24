// What this device measures of S14's budgets, per path and per way it went (loopback, relay, direct, Cloud's copy,
// queue or list): an event from its runtime's commit to this device, a send to the runtime's accept, opening a chat to
// its first content, and a chat's status change from its runtime to this device's list. Rolling p50/p95 over the last samples, shown in the developer overlay and reported to Cloud as
// measured telemetry once its ingest answers. Nothing about what a chat says: durations and labels only.
import type { CloudApi } from "./cloud-api.ts";
import { CloudError } from "./cloud-api.ts";

export type LatencyPath = "event" | "send" | "open" | "status";
/**
 * How it travelled: This Mac on loopback, Cloud's relay, a direct channel (S14 lane P), Cloud's copy, Cloud's queue, the
 * device cache, Cloud's chat list stream.
 */
export type LatencyVia = "loopback" | "relay" | "direct" | "copy" | "queue" | "cache" | "list";

export interface LatencyStat {
  readonly path: LatencyPath;
  readonly via: LatencyVia;
  readonly count: number;
  readonly p50: number;
  readonly p95: number;
}

/** Samples kept per (path, via): enough for a steady p95, small enough to follow a change of network in a minute. */
const KEEP = 200;
/** Samples waiting to be reported per (path, via), while Cloud cannot take them: the newest this many. */
const KEEP_UNREPORTED = 2_000;

export class LatencyMeter {
  private readonly samples = new Map<string, number[]>();
  /** Samples not reported to Cloud yet: each goes in one report only (F-8). */
  private unreported = new Map<string, number[]>();
  private readonly listeners = new Set<() => void>();
  private version = 0;

  record(path: LatencyPath, via: LatencyVia, ms: number): void {
    if (!Number.isFinite(ms)) return;
    const key = `${path}|${via}`;
    let list = this.samples.get(key);
    if (!list) this.samples.set(key, (list = []));
    // Clocks on two computers disagree a little: a delay below zero is zero, not a negative.
    const sample = Math.max(0, Math.round(ms));
    list.push(sample);
    if (list.length > KEEP) list.splice(0, list.length - KEEP);
    let waiting = this.unreported.get(key);
    if (!waiting) this.unreported.set(key, (waiting = []));
    waiting.push(sample);
    if (waiting.length > KEEP_UNREPORTED) waiting.splice(0, waiting.length - KEEP_UNREPORTED);
    this.version++;
    for (const listener of this.listeners) listener();
  }

  /** Changes on every sample (the overlay's re-render key, the reporter's "anything new"). */
  revision(): number {
    return this.version;
  }

  private shown: { readonly version: number; readonly stats: ReadonlyArray<LatencyStat> } | null = null;

  /** stats(), the same array until a sample changes it (a store snapshot for React). */
  snapshot = (): ReadonlyArray<LatencyStat> => {
    if (this.shown?.version !== this.version) this.shown = { version: this.version, stats: this.stats() };
    return this.shown.stats;
  };

  stats(): LatencyStat[] {
    return statsOf(this.samples);
  }

  /**
   * The samples since the last take, as stats, now out of the meter: a report covers each sample once. `putBack` returns
   * them (the report did not go), ahead of anything recorded since.
   */
  takeUnreported(): { readonly stats: LatencyStat[]; readonly putBack: () => void } {
    const taken = this.unreported;
    this.unreported = new Map();
    return {
      stats: statsOf(taken),
      putBack: () => {
        for (const [key, list] of taken) {
          const merged = [...list, ...(this.unreported.get(key) ?? [])];
          this.unreported.set(key, merged.slice(-KEEP_UNREPORTED));
        }
      },
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  clear(): void {
    this.samples.clear();
    this.version++;
    for (const listener of this.listeners) listener();
  }
}

function statsOf(samples: ReadonlyMap<string, ReadonlyArray<number>>): LatencyStat[] {
  return [...samples.entries()]
    .filter(([, list]) => list.length > 0)
    .map(([key, list]) => {
      const [path, via] = key.split("|") as [LatencyPath, LatencyVia];
      const sorted = [...list].sort((a, b) => a - b);
      return { path, via, count: sorted.length, p50: quantile(sorted, 0.5), p95: quantile(sorted, 0.95) };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.via.localeCompare(b.via));
}

/** Nearest-rank quantile of sorted samples. */
export function quantile(sorted: ReadonlyArray<number>, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

/** The window's meter. */
export const latency = new LatencyMeter();

/** The delay of an event from its runtime's commit (`committed_ms` when the runtime sends it, else `at`) to now. */
export function eventDelay(event: { readonly at: string; readonly committed_ms?: number }, now = Date.now()): number {
  const committed = typeof event.committed_ms === "number" ? event.committed_ms : Date.parse(event.at);
  return now - committed;
}

/** A status change stamped longer ago than this is a list catching up after an outage, not this path's delay. */
const STATUS_STALE_MS = 60_000;

/**
 * The delay of a chat's status change from its runtime to now: the runtime stamps the change on the summary's
 * `last_activity_at`. Undefined when the status did not change, or its stamp is too old to be this change's.
 */
export function statusDelay(
  held: { readonly status: string } | undefined,
  chat: { readonly status: string; readonly last_activity_at: string },
  now = Date.now(),
): number | undefined {
  if (held === undefined || held.status === chat.status) return undefined;
  const delay = now - Date.parse(chat.last_activity_at);
  return Number.isFinite(delay) && delay <= STATUS_STALE_MS ? delay : undefined;
}

export interface LatencyReport {
  readonly client: "web" | "desktop";
  readonly window_s: number;
  /** Always measured: every number is a duration this device timed itself. */
  readonly label: "measured";
  readonly paths: ReadonlyArray<{ readonly path: LatencyPath; readonly via: LatencyVia; readonly count: number; readonly p50_ms: number; readonly p95_ms: number }>;
}

/**
 * Sends Cloud the p50/p95 of the samples measured since the last report, every `everyMs` while there are any: each
 * sample counts once (F-8). A Cloud without the ingest (404, 405) or that keeps no telemetry (503) is not asked again
 * until the next launch; on other failures the samples wait for the next round. A Cloud that refuses the report (400:
 * an older one, which refuses a path or way it does not know, and the whole report with it) is sent each path alone,
 * and a path it refuses then is not sent again until the next launch. Returns stop.
 */
export function reportLatency(meter: LatencyMeter, api: Pick<CloudApi, "latency">, client: LatencyReport["client"], everyMs = 60_000): () => void {
  let off = false;
  const refused = new Set<string>();
  const send = (paths: LatencyReport["paths"]) => api.latency({ client, window_s: Math.round(everyMs / 1000), label: "measured", paths });
  const tick = async () => {
    if (off) return;
    const taken = meter.takeUnreported();
    const paths = taken.stats
      .filter((s) => !refused.has(`${s.path}|${s.via}`))
      .map((s) => ({ path: s.path, via: s.via, count: s.count, p50_ms: s.p50, p95_ms: s.p95 }));
    if (paths.length === 0) return;
    try {
      await send(paths);
    } catch (error) {
      if (error instanceof CloudError && (error.status === 404 || error.status === 405 || error.status === 503)) off = true;
      else if (error instanceof CloudError && error.status === 400 && paths.length > 1) {
        for (const path of paths) {
          // Taken out of the meter already: a path that fails here for another reason is not sent again.
          await send([path]).catch((alone: unknown) => {
            if (alone instanceof CloudError && alone.status === 400) refused.add(`${path.path}|${path.via}`);
          });
        }
      } else if (error instanceof CloudError && error.status === 400) refused.add(`${paths[0]!.path}|${paths[0]!.via}`);
      else taken.putBack();
    }
  };
  const timer = setInterval(() => void tick(), everyMs);
  return () => {
    off = true;
    clearInterval(timer);
  };
}
