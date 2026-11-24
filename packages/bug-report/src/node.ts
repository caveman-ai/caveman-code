// Problem reports, the Node half (docs/): the error's
// signature, reading log tails, preparing a report for the preview, turning
// what the person approved into the parts Caveman Cloud takes, and the outbox
// on disk that holds a report until it is sent. The runtime and the desktop app
// both use it: the runtime prepares and sends; the desktop prepares when the
// runtime cannot start, and leaves the report in the runtime's outbox for its
// next start. Electron-free and Effect-free.
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import {
  BUG_REPORT_LIMITS,
  clip,
  redact,
  REDACTION_VERSION,
  rulesOf,
  sumCounts,
  templateDraft,
  type BugReportPayload,
  type BugReportSurface,
  type Redaction,
  type RedactionContext,
  type ReportedError,
} from "./index.ts";

// --------------------------------------------------------------- signature

const FRAME =
  /^\s*at\s+(?:(?<fn>.*?)\s+\()?(?<loc>[^()]*?)(?::\d+){0,2}\)?\s*$|^\s*(?<fn2>[^@\s]*)@(?<loc2>.*?)(?::\d+){0,2}\s*$/;

/** One frame without what changes between builds and computers: line and column, folders, content hashes. */
function frameKey(line: string): string | undefined {
  const m = FRAME.exec(line);
  if (!m?.groups) return undefined;
  const fn = (m.groups.fn ?? m.groups.fn2 ?? "")
    .replace(/^async\s+/, "")
    .replace(/\[as [^\]]+\]/, "")
    .trim();
  const loc = (m.groups.loc ?? m.groups.loc2 ?? "").replace(/[?#].*$/, "");
  if (!loc && !fn) return undefined;
  const file = (loc.split(/[\\/]/).pop() ?? "")
    // Bundler hashes: index-DkF3a9xQ.js, chunk.5f2a91c3.js.
    .replace(/[-.][A-Za-z0-9_]{6,}(?=\.[cm]?[jt]sx?$)/, "")
    .replace(/:\d+(:\d+)?$/, "");
  // `Promise.all (index 0)`: no file, a position that changes.
  return `${normalizeText(fn) || "<anonymous>"}@${(file.includes(".") ? file : normalizeText(file)) || "<native>"}`;
}

/** Text without what names one occurrence: ids, numbers, quoted values, paths, URLs. */
function normalizeText(text: string): string {
  return text
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .replace(/(?:[A-Za-z]:)?(?:[\\/][^\\/\s:'"`]+){2,}/g, "<path>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[0-9a-f]{7,}\b/gi, "<hex>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "<str>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** What the signature hashes: the error's type, then its top five frames, or its message with nothing particular in it. */
export function signatureBasis(
  error: ReportedError | undefined,
  surface: BugReportSurface,
): string {
  if (!error) return `${surface}|no-error`;
  const frames = (error.stack ?? "")
    .split("\n")
    .filter(
      (line) =>
        /^\s*at\s|^[^\s@]*@\S+:\d+/.test(line) && !/node:internal|<anonymous>\)?$/.test(line),
    )
    .map(frameKey)
    .filter((key): key is string => key !== undefined)
    .slice(0, 5);
  const type = error.name?.trim() || "Error";
  return frames.length > 0
    ? `${type}|${frames.join("|")}`
    : `${type}|${surface}|${normalizeText(error.message.split("\n")[0] ?? "").slice(0, 200)}`;
}

/** Stable across builds and computers, so Cloud groups the same failure: 32 hex characters of SHA-256. */
export function errorSignature(
  error: ReportedError | undefined,
  surface: BugReportSurface,
): string {
  return createHash("sha256").update(signatureBasis(error, surface)).digest("hex").slice(0, 32);
}

// --------------------------------------------------------------- tar.gz

/** A POSIX ustar archive of `files`, gzipped. Names are kept under 100 bytes. */
export function tarGz(
  files: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array;
    readonly mtimeMs?: number;
  }>,
): Buffer {
  const blocks: Buffer[] = [];
  for (const file of files) {
    const header = Buffer.alloc(512);
    const name = Buffer.from(file.name.replace(/[^A-Za-z0-9._/-]/g, "_")).subarray(0, 99);
    name.copy(header, 0);
    const octal = (value: number, width: number) =>
      value.toString(8).padStart(width - 1, "0") + "\0";
    header.write(octal(0o644, 8), 100, "ascii");
    header.write(octal(0, 8), 108, "ascii");
    header.write(octal(0, 8), 116, "ascii");
    header.write(octal(file.data.byteLength, 12), 124, "ascii");
    header.write(octal(Math.floor((file.mtimeMs ?? Date.now()) / 1000), 12), 136, "ascii");
    header.write("        ", 148, "ascii");
    header.write("0", 156, "ascii");
    header.write("ustar\0", 257, "ascii");
    header.write("00", 263, "ascii");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    blocks.push(header, Buffer.from(file.data));
    const pad = (512 - (file.data.byteLength % 512)) % 512;
    if (pad) blocks.push(Buffer.alloc(pad));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { level: 9 });
}

// --------------------------------------------------------------- log tails

const ISO = /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/;
const NANOS = /"(?:startTimeUnixNano|timeUnixNano)"\s*:\s*"?(\d{16,19})/;

/** When a log line happened, where it says. */
export function lineTime(line: string): number | undefined {
  const nanos = NANOS.exec(line);
  if (nanos) return Number(BigInt(nanos[1]!) / 1_000_000n);
  const iso = ISO.exec(line.slice(0, 200));
  if (iso) {
    const ms = Date.parse(iso[1]!);
    return Number.isNaN(ms) ? undefined : ms;
  }
  return undefined;
}

/**
 * The last `maxBytes` of a log, lines older than `sinceMs` left out (a line
 * with no time of its own goes with the line before it). Undefined when the
 * file is missing or last written before `sinceMs`.
 */
export function readLogTail(
  path: string,
  options: { readonly sinceMs: number; readonly maxBytes: number },
): string | undefined {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.mtimeMs < options.sinceMs) return undefined;
    const length = Math.min(stat.size, options.maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, stat.size - length);
    let text = buffer.toString("utf8");
    // A cut first line is half a line: drop it.
    if (length < stat.size) text = text.slice(text.indexOf("\n") + 1);
    let keep = true;
    const kept: string[] = [];
    for (const line of text.split("\n")) {
      const at = lineTime(line);
      if (at !== undefined) keep = at >= options.sinceMs;
      if (keep) kept.push(line);
    }
    return kept.join("\n");
  } finally {
    closeSync(fd);
  }
}

// --------------------------------------------------------------- preparing

/** A log a report may carry. `code`: it holds transcripts or file contents, so it goes only when the person opts in. */
export interface LogSource {
  readonly name: string;
  readonly path: string;
  readonly code: boolean;
  readonly maxBytes?: number;
}

/** Where a report comes from: the app's version and this computer, as the contract names them. */
export interface ReportEnvironment {
  readonly appVersion: string;
  readonly buildChannel: string;
  readonly platform: BugReportPayload["platform"];
  readonly osVersion: string;
  readonly arch: string;
  readonly homeDir: string;
  readonly userName: string;
}

export interface PreparedFile {
  readonly name: string;
  readonly code: boolean;
  /** Redacted: exactly what is sent. */
  readonly text: string;
  readonly redaction: Redaction;
}

export interface PrepareInput {
  readonly surface: BugReportSurface;
  readonly error?: ReportedError | undefined;
  readonly context?:
    | {
        readonly providerId?: string | undefined;
        readonly modelId?: string | undefined;
        readonly threadId?: string | undefined;
      }
    | undefined;
  /** The end of the chat, as the page shows it: redacted here, sent only when the person turns it on. */
  readonly threadExcerpt?: string | undefined;
  /** A PNG of the window, sent only when the person turns it on. */
  readonly screenshot?: Uint8Array | undefined;
}

/** A report ready for the preview: everything redacted, nothing sent. */
export interface PreparedReport {
  readonly reportId: string;
  readonly createdAt: string;
  readonly surface: BugReportSurface;
  readonly context: NonNullable<PrepareInput["context"]>;
  readonly env: ReportEnvironment;
  readonly errorSignature: string;
  /** The error, redacted: what a model reads to describe it. */
  readonly error?: ReportedError | undefined;
  readonly draft: {
    readonly title: string;
    readonly summary: string;
    readonly by: "template" | "agent";
  };
  readonly files: ReadonlyArray<PreparedFile>;
  readonly excerpt?: { readonly plain: Redaction; readonly withCode: Redaction } | undefined;
  readonly screenshot?: Uint8Array | undefined;
  /** Rules over the error: they count in what the report passed. */
  readonly errorRedaction?: Redaction | undefined;
}

export const redactionContext = (env: ReportEnvironment, keepCode = false): RedactionContext => ({
  homeDir: env.homeDir,
  userName: env.userName,
  keepCode,
});

export const isReportId = (id: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);

/**
 * Reads and redacts each log (newest first in `sources` wins the budget), the
 * error and the excerpt, and drafts the template description. A model may
 * write a better description after (the runtime's describe).
 */
export function prepareReport(
  input: PrepareInput,
  sources: ReadonlyArray<LogSource>,
  env: ReportEnvironment,
  now: number = Date.now(),
): PreparedReport {
  const ctx = redactionContext(env);
  const sinceMs = now - BUG_REPORT_LIMITS.logWindowMs;
  let budget = BUG_REPORT_LIMITS.logTotalBytes;
  const files: PreparedFile[] = [];
  for (const source of sources) {
    if (budget <= 0) break;
    const raw = readLogTail(source.path, {
      sinceMs,
      maxBytes: source.maxBytes ?? BUG_REPORT_LIMITS.logFileTailBytes,
    });
    if (raw === undefined || raw.trim() === "") continue;
    const redaction = redact(raw, redactionContext(env, source.code));
    let text = redaction.text;
    if (Buffer.byteLength(text) > budget) {
      // Keep the end: the newest lines are the ones about the problem.
      text = Buffer.from(text).subarray(-budget).toString("utf8");
      text = text.slice(text.indexOf("\n") + 1);
    }
    budget -= Buffer.byteLength(text);
    files.push({ name: source.name, code: source.code, text, redaction: { ...redaction, text } });
  }
  const errorRedaction = input.error
    ? redact(
        [input.error.name, input.error.message, input.error.stack].filter(Boolean).join("\n"),
        ctx,
      )
    : undefined;
  const error: ReportedError | undefined = input.error && {
    ...(input.error.name ? { name: redact(input.error.name, ctx).text } : {}),
    message: redact(input.error.message, ctx).text,
    ...(input.error.stack ? { stack: redact(input.error.stack, ctx).text } : {}),
  };
  const excerptRaw = input.threadExcerpt
    ? input.threadExcerpt.slice(-BUG_REPORT_LIMITS.excerptChars)
    : undefined;
  const screenshot =
    input.screenshot && input.screenshot.byteLength <= BUG_REPORT_LIMITS.screenshotBytes
      ? input.screenshot
      : undefined;
  const draft = templateDraft({ surface: input.surface, error: input.error }, ctx);
  return {
    reportId: randomUUID(),
    createdAt: new Date(now).toISOString(),
    surface: input.surface,
    context: input.context ?? {},
    env,
    errorSignature: errorSignature(input.error, input.surface),
    ...(error ? { error } : {}),
    draft: { ...draft, by: "template" },
    files,
    ...(excerptRaw
      ? {
          excerpt: {
            plain: redact(excerptRaw, ctx),
            withCode: redact(excerptRaw, redactionContext(env, true)),
          },
        }
      : {}),
    ...(screenshot ? { screenshot } : {}),
    ...(errorRedaction ? { errorRedaction } : {}),
  };
}

/** What the person settled on in the preview. */
export interface ReportEdits {
  readonly title: string;
  readonly summary: string;
  readonly note?: string | undefined;
  readonly include: {
    readonly logs: boolean;
    readonly screenshot: boolean;
    readonly threadExcerpt: boolean;
    readonly code: boolean;
  };
}

export class ReportTooLarge extends Error {}

/** The three parts of POST /api/v1/code/bug-reports, from a prepared report and the person's edits, redacted once more. */
export function finalizeReport(
  prepared: PreparedReport,
  edits: ReportEdits,
): { payload: BugReportPayload; logs?: Buffer; screenshot?: Buffer } {
  const ctx = redactionContext(prepared.env, edits.include.code);
  const title = redact(
    clip(
      edits.title.trim().replace(/\s+/g, " ") || prepared.draft.title,
      BUG_REPORT_LIMITS.titleChars,
    ),
    ctx,
  );
  const summary = redact(
    clip(edits.summary.trim() || prepared.draft.summary, BUG_REPORT_LIMITS.summaryChars),
    ctx,
  );
  const noteText = edits.note?.trim();
  const note = noteText ? redact(clip(noteText, BUG_REPORT_LIMITS.noteChars), ctx) : undefined;
  const files = edits.include.logs
    ? prepared.files.filter((file) => !file.code || edits.include.code)
    : [];
  const excerpt =
    edits.include.threadExcerpt && prepared.excerpt
      ? edits.include.code
        ? prepared.excerpt.withCode
        : prepared.excerpt.plain
      : undefined;
  const entries = [
    ...files.map((file) => ({ name: `logs/${file.name}`, data: Buffer.from(file.text) })),
    ...(excerpt ? [{ name: "thread-excerpt.txt", data: Buffer.from(excerpt.text) }] : []),
  ];
  const logs = entries.length > 0 ? tarGz(entries) : undefined;
  if (logs && logs.byteLength > BUG_REPORT_LIMITS.logsGzipBytes)
    throw new ReportTooLarge(
      "The logs are over 25 MB even compressed. Turn logs off, or code and file contents.",
    );
  const screenshot =
    edits.include.screenshot && prepared.screenshot ? Buffer.from(prepared.screenshot) : undefined;
  if (screenshot && screenshot.byteLength > BUG_REPORT_LIMITS.screenshotBytes)
    throw new ReportTooLarge("The screenshot is over 5 MB. Turn it off to send.");
  // What is sent passed these; the error itself is not sent apart from the title and description.
  const passed = [
    title,
    summary,
    ...(note ? [note] : []),
    ...files.map((f) => f.redaction),
    ...(excerpt ? [excerpt] : []),
  ];
  const { context, env } = prepared;
  const payload: BugReportPayload = {
    reportId: prepared.reportId,
    createdAt: prepared.createdAt,
    appVersion: env.appVersion,
    buildChannel: env.buildChannel,
    platform: env.platform,
    osVersion: env.osVersion,
    arch: env.arch,
    errorSignature: prepared.errorSignature,
    title: title.text,
    agentSummary: summary.text,
    ...(note ? { userNote: note.text } : {}),
    context: {
      surface: prepared.surface,
      ...(context.providerId ? { providerId: context.providerId } : {}),
      ...(context.modelId ? { modelId: context.modelId } : {}),
      ...(context.threadId ? { threadId: context.threadId } : {}),
    },
    redaction: { version: REDACTION_VERSION, rulesApplied: rulesOf(passed) },
    includes: {
      logs: files.length > 0,
      screenshot: screenshot !== undefined,
      threadExcerpt: excerpt !== undefined,
    },
  };
  return { payload, ...(logs ? { logs } : {}), ...(screenshot ? { screenshot } : {}) };
}

/** Matches per rule over everything a report carries, for the preview's "what was removed" line. */
export const preparedCounts = (prepared: PreparedReport) =>
  sumCounts([
    ...prepared.files.map((f) => f.redaction),
    ...(prepared.excerpt ? [prepared.excerpt.plain] : []),
    ...(prepared.errorRedaction ? [prepared.errorRedaction] : []),
  ]);

// --------------------------------------------------------------- the outbox

export type OutboxState = "queued" | "sending" | "sent" | "failed";

/** One report on this computer: waiting, sent, or refused for good, and what Cloud last said of it. */
export interface OutboxRecord {
  readonly reportId: string;
  readonly title: string;
  readonly surface: BugReportSurface;
  readonly createdAt: string;
  readonly state: OutboxState;
  readonly attempts: number;
  readonly nextAttemptAt?: string | undefined;
  readonly lastError?: string | undefined;
  readonly sentAt?: string | undefined;
  readonly serverStatus?: "received" | "triaged" | "fixed" | undefined;
  readonly fixedInVersion?: string | undefined;
  readonly duplicateOf?: string | undefined;
}

/** How long a report's record stays on this computer. Its logs go as soon as it is sent. */
export const OUTBOX_KEEP_MS = 90 * 24 * 60 * 60 * 1000;

const writeAtomic = (path: string, data: string | Uint8Array) => {
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
};

/**
 * `<dir>/<reportId>/` holds `report.json` (the contract's report part),
 * `logs.tar.gz`, `screenshot.png` and `state.json`. A report lands whole or not
 * at all: it is written beside the outbox and renamed in. Private to this user.
 */
export class BugReportOutbox {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  private folder(id: string): string {
    if (!isReportId(id)) throw new Error(`not a report id: ${id}`);
    return join(this.dir, id);
  }

  /** Puts a report in the outbox; one already there is left as it is (the report id is the idempotency key). */
  enqueue(parts: {
    payload: BugReportPayload;
    logs?: Uint8Array | undefined;
    screenshot?: Uint8Array | undefined;
  }): OutboxRecord {
    const id = parts.payload.reportId;
    const folder = this.folder(id);
    const existing = this.get(id);
    if (existing) return existing;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const staging = join(this.dir, `.staging-${id}-${randomUUID()}`);
    mkdirSync(staging, { mode: 0o700 });
    const record: OutboxRecord = {
      reportId: id,
      title: parts.payload.title,
      surface: parts.payload.context.surface,
      createdAt: parts.payload.createdAt,
      state: "queued",
      attempts: 0,
    };
    try {
      writeFileSync(join(staging, "report.json"), JSON.stringify(parts.payload), { mode: 0o600 });
      if (parts.logs) writeFileSync(join(staging, "logs.tar.gz"), parts.logs, { mode: 0o600 });
      if (parts.screenshot)
        writeFileSync(join(staging, "screenshot.png"), parts.screenshot, { mode: 0o600 });
      writeFileSync(join(staging, "state.json"), JSON.stringify(record), { mode: 0o600 });
      renameSync(staging, folder);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      const raced = this.get(id);
      if (raced) return raced;
      throw error;
    }
    return record;
  }

  get(id: string): OutboxRecord | undefined {
    try {
      return JSON.parse(readFileSync(join(this.folder(id), "state.json"), "utf8")) as OutboxRecord;
    } catch {
      return undefined;
    }
  }

  /** Every report, newest first. */
  list(): OutboxRecord[] {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return [];
    }
    return names
      .filter(isReportId)
      .map((id) => this.get(id))
      .filter((record): record is OutboxRecord => record !== undefined)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  update(id: string, patch: Partial<Omit<OutboxRecord, "reportId">>): OutboxRecord | undefined {
    const record = this.get(id);
    if (!record) return undefined;
    const next = { ...record, ...patch };
    writeAtomic(join(this.folder(id), "state.json"), JSON.stringify(next));
    return next;
  }

  /** The parts to send; undefined once sent (the logs are gone) or deleted. */
  parts(id: string): { payload: BugReportPayload; logs?: Buffer; screenshot?: Buffer } | undefined {
    const folder = this.folder(id);
    try {
      const payload = JSON.parse(
        readFileSync(join(folder, "report.json"), "utf8"),
      ) as BugReportPayload;
      const read = (name: string) =>
        existsSync(join(folder, name)) ? readFileSync(join(folder, name)) : undefined;
      const logs = read("logs.tar.gz");
      const screenshot = read("screenshot.png");
      return { payload, ...(logs ? { logs } : {}), ...(screenshot ? { screenshot } : {}) };
    } catch {
      return undefined;
    }
  }

  /** Sent: Cloud holds the logs and screenshot now; this computer keeps only the record. */
  dropParts(id: string): void {
    const folder = this.folder(id);
    for (const name of ["report.json", "logs.tar.gz", "screenshot.png"])
      rmSync(join(folder, name), { force: true });
  }

  remove(id: string): void {
    rmSync(this.folder(id), { recursive: true, force: true });
  }

  /** Records older than OUTBOX_KEEP_MS, and staging left by a crash mid-write. */
  prune(now: number = Date.now()): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (name.startsWith(".staging-")) {
        try {
          if (now - statSync(join(this.dir, name)).mtimeMs > 60 * 60 * 1000)
            rmSync(join(this.dir, name), { recursive: true, force: true });
        } catch {
          // Gone already.
        }
        continue;
      }
      if (!isReportId(name)) continue;
      const record = this.get(name);
      if (record && now - Date.parse(record.createdAt) > OUTBOX_KEEP_MS) this.remove(name);
    }
  }
}

/** The outbox under a runtime's state dir (`<home>/userdata`). */
export const outboxDir = (stateDir: string) => join(stateDir, "bug-reports");

/**
 * Prepared reports waiting for the person to send them, in memory: a few at a
 * time, for an hour. A report not sent is never written anywhere.
 */
export class PreparedReports {
  private readonly held = new Map<string, { prepared: PreparedReport; at: number }>();
  private readonly max: number;
  private readonly ttlMs: number;
  constructor(max = 8, ttlMs = 60 * 60 * 1000) {
    this.max = max;
    this.ttlMs = ttlMs;
  }

  put(prepared: PreparedReport, now = Date.now()): void {
    for (const [id, entry] of this.held) if (now - entry.at > this.ttlMs) this.held.delete(id);
    while (this.held.size >= this.max) this.held.delete(this.held.keys().next().value!);
    this.held.set(prepared.reportId, { prepared, at: now });
  }

  get(id: string): PreparedReport | undefined {
    return this.held.get(id)?.prepared;
  }

  set(id: string, prepared: PreparedReport): void {
    const entry = this.held.get(id);
    if (entry) entry.prepared = prepared;
  }

  delete(id: string): void {
    this.held.delete(id);
  }
}
