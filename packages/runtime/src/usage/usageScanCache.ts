// ), apps/server/src/usage/usageScanCache.ts @ ab3a3cd1.
/**
 * Durable per-file scan cache.
 *
 * Transcripts are append-only and a file that has not changed can never yield
 * different usage, so parsed records are keyed by `(size, mtime)` and reused.
 * Without this every server restart re-parses the whole window: roughly 3.5s
 * for a 30-day scan here, against ~11ms to reload this cache.
 *
 * Caching *per file* rather than per day is deliberate. It is timezone
 * independent, so changing the reporting zone does not invalidate anything, and
 * it keeps cross-file de-duplication exact: cached entries are de-duplicated
 * within their own file only, and the aggregator still applies the global
 * dedupe pass over the small surviving key set.
 *
 * @module usageScanCache
 */
import type { UsageProviderKind } from "@caveman-app/protocol";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@caveman-app/engine-core/server/usage";
import * as Schema from "effect/Schema";

import { CLAUDE_SYNTHETIC_MODEL } from "../provider/Drivers/claudeUsage.ts";
import { GUARD_LENGTH, type TranscriptParsePosition } from "./usageTranscriptReader.ts";

// v2: Codex fork-copy suppression changed what a file parses to, so v1
// entries would keep serving double-counted records forever.
// v3: entries carry the parse position and reducer state so a grown file
// re-parses only its appended bytes instead of starting over.
// v4: records carry Claude fast mode, which v3 rows never captured.
// v5: Codex records carry their service tier. v4 rows store speed the same
// way, so v4 entries still load; see `decodeScanCache` for v4 stateful entries.
// v6: Codex reconciles request deltas against cumulative counters, so older
// Codex reducer state re-parses live rollouts.
// v7: Codex records may carry the turn whose service tier history resolves.
// v8: Codex counts requests after a compaction or a resume in a new process.
// v9: Codex counts a fork's first request, whose running totals it inherited.
// v10: Claude records include advisor calls, each under the advisor's model.
// v11: Codex bills the requests of an interrupted turn that no snapshot reported.
const USAGE_SCAN_CACHE_VERSION = 11 as const;
const SPEED_COMPATIBLE_SINCE_VERSION = 4;

/**
 * Each cache version writes its own file in the state directory. An older
 * server sharing that directory cannot read a newer cache and would replace
 * it, dropping saved usage for deleted transcripts. Separate files keep both.
 * A v5 server reads the legacy (v4) file once, when its own file is missing.
 */
export const SCAN_CACHE_FILE_NAME = "usage-scan-cache-v11.json";
export const LEGACY_SCAN_CACHE_FILE_NAMES = [
  "usage-scan-cache-v10.json",
  "usage-scan-cache-v9.json",
  "usage-scan-cache-v8.json",
  "usage-scan-cache-v7.json",
  "usage-scan-cache-v6.json",
  "usage-scan-cache-v5.json",
  "usage-scan-cache.json",
] as const;

/** Serialised as the index into this list. */
const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

export interface CachedFile {
  readonly size: number;
  readonly mtimeMs: number;
  readonly provider: UsageProviderKind;
  /** Records from newline-terminated lines, up to `position.resumeOffset`. */
  readonly records: readonly UsageRecord[];
  /**
   * Records from a trailing segment the writer had not newline-terminated at
   * parse time. Kept apart from `records` because an incremental parse
   * re-reads that segment and would otherwise double count it.
   */
  readonly tailRecords: readonly UsageRecord[];
  /** Whole-file count, including diagnostics from the tentative tail. */
  readonly malformedRecords: number;
  readonly position: TranscriptParsePosition;
}

export type ScanCache = Map<string, CachedFile>;

/**
 * Row layout for the serialised form. Positional and interned rather than
 * object-per-record: on a 30-day window that is the difference between a file
 * measured in tens of megabytes and one under six.
 */
type SerializedRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speed: number,
  /** Optional trailing field keeps existing cache rows readable. */
  rateModelIndex?: number | null,
  unresolvedServiceTierTurnId?: string,
];

interface SerializedFile {
  readonly s: number;
  readonly m: number;
  readonly p: UsageProviderKind;
  readonly r: readonly SerializedRecord[];
  /** Tail records; see `CachedFile.tailRecords`. */
  readonly t: readonly SerializedRecord[];
  readonly mr: number;
  /** Parse position: resume offset, guard length, guard hash. */
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  /** The format's encoded reducer state at `o`; `null` for stateless formats. */
  readonly cs: unknown;
}

interface SerializedCache {
  readonly version: number;
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly files: Readonly<Record<string, SerializedFile>>;
}

/** Model and session strings, each stored once and referenced by index. */
interface InternTables {
  readonly models: string[];
  readonly sessions: string[];
  readonly modelIndex: Map<string, number>;
  readonly sessionIndex: Map<string, number>;
}

function makeInternTables(): InternTables {
  return { models: [], sessions: [], modelIndex: new Map(), sessionIndex: new Map() };
}

function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

function serializeFile(entry: CachedFile, tables: InternTables): SerializedFile {
  const serializeRecord = (record: UsageRecord): SerializedRecord => [
    record.timestampMs,
    intern(tables.models, tables.modelIndex, record.model),
    intern(tables.sessions, tables.sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed),
    record.rateModel === undefined
      ? null
      : intern(tables.models, tables.modelIndex, record.rateModel),
    ...(record.unresolvedServiceTierTurnId === undefined
      ? ([] as const)
      : ([record.unresolvedServiceTierTurnId] as const)),
  ];
  return {
    s: entry.size,
    m: entry.mtimeMs,
    p: entry.provider,
    r: entry.records.map(serializeRecord),
    t: entry.tailRecords.map(serializeRecord),
    mr: entry.malformedRecords,
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.state,
  };
}

/** Serialises the cache, interning the repeated model and session strings. */
export function encodeScanCache(cache: ScanCache): SerializedCache {
  const tables = makeInternTables();
  const files: Record<string, SerializedFile> = {};
  for (const [path, entry] of cache) files[path] = serializeFile(entry, tables);
  return {
    version: USAGE_SCAN_CACHE_VERSION,
    models: tables.models,
    sessions: tables.sessions,
    files,
  };
}

/**
 * Returns a function that serialises the cache to JSON text, re-encoding only
 * the entries that changed since its last call. Call it once per persist.
 *
 * Writes the same document as `encodeScanCache`. Most entries never change
 * between scans, and encoding all of them made each persist cost close to a
 * second on a large cache. Entries are replaced, never mutated, when their file
 * changes, so an entry's JSON is memoised by identity. The intern tables only
 * grow, so a memoised entry's indexes stay valid; a pruned entry can leave an
 * unused string behind until the next process start.
 */
export function makeScanCacheWriter(): (
  cache: ScanCache,
  extra: Readonly<Record<string, unknown>>,
) => string {
  const tables = makeInternTables();
  const fragments = new WeakMap<CachedFile, string>();
  return (cache, extra) => {
    const files: string[] = [];
    for (const [path, entry] of cache) {
      let fragment = fragments.get(entry);
      if (fragment === undefined) {
        fragment = JSON.stringify(serializeFile(entry, tables));
        fragments.set(entry, fragment);
      }
      files.push(`${JSON.stringify(path)}:${fragment}`);
    }
    // Encoded after the files, which may have added to the intern tables.
    const head = JSON.stringify({
      ...extra,
      version: USAGE_SCAN_CACHE_VERSION,
      models: tables.models,
      sessions: tables.sessions,
    });
    return `${head.slice(0, -1)},"files":{${files.join(",")}}}`;
  };
}

function isRecordArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}

/**
 * Rebuilds the cache from a parsed document.
 *
 * Anything malformed yields an empty cache rather than an error: a corrupt
 * cache should cost one cold scan, never a broken page. Entries of a provider
 * without a transcript format in `formats` are dropped.
 */
export function decodeScanCache(
  document: unknown,
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ScanCache {
  const cache: ScanCache = new Map();
  const isValidState = makeStateValidators(formats);
  if (typeof document !== "object" || document === null) return cache;

  const root = document as Partial<SerializedCache>;
  const version = root.version;
  if (
    typeof version !== "number" ||
    version < SPEED_COMPATIBLE_SINCE_VERSION ||
    version > USAGE_SCAN_CACHE_VERSION
  ) {
    return cache;
  }
  if (!isRecordArray(root.models) || !isRecordArray(root.sessions)) return cache;
  if (typeof root.files !== "object" || root.files === null) return cache;

  // The intern tables must be all strings: a numeric entry would pass the
  // undefined guard below, land in a record's model, and crash the aggregate
  // at lookupRate. A corrupt table rejects the whole cache.
  if (!root.models.every((value) => typeof value === "string")) return cache;
  if (!root.sessions.every((value) => typeof value === "string")) return cache;
  const models = root.models as readonly string[];
  const sessions = root.sessions as readonly string[];

  // Any corrupt row disqualifies the whole entry. Keeping the survivors
  // under the original (size, mtime) would read as a valid warm hit and the
  // file would never be re-parsed, silently losing the dropped rows' usage.
  const decodeRecords = (
    rows: readonly unknown[],
    provider: UsageProviderKind,
  ): UsageRecord[] | null => {
    const records: UsageRecord[] = [];
    for (const row of rows) {
      if (!isRecordArray(row) || row.length < 11) return null;
      const [
        timestampMs,
        modelIndex,
        sessionIndex,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIndex,
        rateModelIndex,
        unresolvedServiceTierTurnId,
      ] = row as SerializedRecord;
      const speed = typeof speedIndex === "number" ? SPEEDS[speedIndex] : undefined;

      const model = typeof modelIndex === "number" ? models[modelIndex] : undefined;
      const rateModel = typeof rateModelIndex === "number" ? models[rateModelIndex] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        (unresolvedServiceTierTurnId !== undefined &&
          typeof unresolvedServiceTierTurnId !== "string") ||
        (rateModelIndex != null && rateModel === undefined) ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning) ||
        speed === undefined
      ) {
        return null;
      }

      // Unchanged and deleted transcripts may only exist in the cache, so the
      // parser cannot remove their previously saved local placeholders.
      if (provider === "claude" && model === CLAUDE_SYNTHETIC_MODEL) continue;

      records.push({
        provider,
        timestampMs,
        model,
        ...(rateModel === undefined ? {} : { rateModel }),
        sessionId: (typeof sessionIndex === "number" ? sessions[sessionIndex] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        ...(version >= 7 && unresolvedServiceTierTurnId !== undefined
          ? { unresolvedServiceTierTurnId }
          : {}),
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    return records;
  };

  for (const [path, raw] of Object.entries(root.files)) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Partial<SerializedFile>;
    if (typeof entry.s !== "number" || typeof entry.m !== "number") continue;
    if (entry.p === undefined) continue;
    const format = formats.get(entry.p);
    if (format === undefined) continue;
    if (!isRecordArray(entry.r) || !isRecordArray(entry.t)) continue;
    const malformedRecords = entry.mr === undefined ? 0 : entry.mr;
    if (!Number.isSafeInteger(malformedRecords) || malformedRecords < 0) continue;
    // Position fields feed byte offsets and a Buffer allocation in the reader,
    // so anything outside their real ranges must reject the entry: a bogus
    // guard length would otherwise fail every parse of the file, silently
    // dropping its usage instead of costing the documented cold re-parse.
    if (
      typeof entry.o !== "number" ||
      !Number.isSafeInteger(entry.o) ||
      entry.o < 0 ||
      typeof entry.gl !== "number" ||
      !Number.isSafeInteger(entry.gl) ||
      entry.gl < 0 ||
      entry.gl > GUARD_LENGTH ||
      entry.gl > entry.o ||
      typeof entry.gh !== "number" ||
      !Number.isFinite(entry.gh)
    ) {
      continue;
    }
    // Keep history for deleted rollouts, but re-parse incompatible reducer state.
    // v10 adds Claude advisor calls, which no older Claude entry holds. Every Codex entry before
    // v11 re-parses once: older parsers billed a resumed session's replayed first request twice
    // without counting it as skipped, and could end past an interrupted request whose usage the
    // state dropped. A deleted rollout keeps the records it had.
    const legacy =
      (entry.p === "claude" && version < 10) ||
      (format.state !== undefined && (version < 6 || (entry.p === "codex" && version < 11)));
    // A corrupt state disqualifies the entry: resuming with it would attach
    // appended usage to the wrong model or replay fork-copied history.
    if (!legacy && !isValidState.get(entry.p)?.(entry.cs)) continue;
    const resumable = !legacy;

    const provider = entry.p;
    const records = decodeRecords(entry.r, provider);
    const tailRecords = decodeRecords(entry.t, provider);
    if (records === null || tailRecords === null) continue;

    cache.set(path, {
      size: legacy ? -1 : entry.s,
      mtimeMs: entry.m,
      provider,
      records,
      tailRecords,
      malformedRecords,
      position: resumable
        ? {
            resumeOffset: entry.o,
            guardLength: entry.gl,
            guardHash: entry.gh,
            state: entry.cs,
          }
        : { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
    });
  }

  return cache;
}

/**
 * Per provider, whether a persisted state is valid: `null`, or one the
 * format's schema accepts.
 */
function makeStateValidators(
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ReadonlyMap<UsageProviderKind, (value: unknown) => boolean> {
  return new Map(
    [...formats].map(([provider, format]) => {
      const isState = format.state === undefined ? undefined : Schema.is(format.state.schema);
      return [
        provider,
        (value: unknown) => value === null || (isState !== undefined && isState(value)),
      ] as const;
    }),
  );
}

/** Keeps saved usage after transcript cleanup, until the reporting retention expires. */
export function pruneScanCache(cache: ScanCache, retentionCutoffMs: number): number {
  let removed = 0;
  for (const [path, entry] of cache) {
    if (entry.mtimeMs < retentionCutoffMs) {
      cache.delete(path);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Within-file de-duplication, applied before an entry is cached.
 *
 * Callers stitching an incremental parse together pass one `seen` set across
 * the line and tail record batches so the whole file stays deduplicated as a
 * unit; the set is mutated in place.
 */
export function dedupeWithinFile(
  records: readonly UsageRecord[],
  seen: Set<string> = new Set(),
): readonly UsageRecord[] {
  const kept: UsageRecord[] = [];
  for (const record of records) {
    if (record.dedupeKey !== null) {
      if (seen.has(record.dedupeKey)) continue;
      seen.add(record.dedupeKey);
    }
    kept.push(record);
  }
  return kept;
}
