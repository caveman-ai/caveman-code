// "Report a problem" (docs/): the one button beside an
// error, Help > Report a Problem… and Settings open the same preview
// (shell/ReportProblem.tsx). This is its model: who gathers the report (the
// runtime, or the desktop app while the runtime cannot run), the end of a chat
// as an excerpt, and exactly what Send would send. Nothing leaves the computer
// until the person presses Send in the preview.
import type { BugReportPrepared, BugReportRecord, Client } from "@caveman-app/session-protocol";
import { BUG_REPORT_LIMITS, redact, type BugReportSurface } from "@caveman-app/bug-report";
import type { DesktopBugReport } from "@caveman-app/desktop/bridge";
import type { TranscriptItem } from "./transcript-model.ts";

/** What a button asks to report: where, the error it shows, and the chat it is in. */
export interface ReportRequest {
  readonly surface: BugReportSurface;
  readonly error?:
    | { readonly name?: string; readonly message: string; readonly stack?: string }
    | undefined;
  readonly providerId?: string | undefined;
  readonly modelId?: string | undefined;
  readonly threadId?: string | undefined;
  /** The end of the chat, as the page shows it. Redacted where the report is gathered; sent only if turned on. */
  readonly threadExcerpt?: string | undefined;
}

export const REPORT_EVENT = "caveman:report-problem";

declare global {
  interface Window {
    /** A report the desktop asked for before this page listened (apps/desktop src/main.ts openReport). */
    cavemanPendingReport?: ReportRequest | null;
  }
}

/** Opens the report preview over whatever is open. Sends nothing. */
export function reportProblem(request: ReportRequest): void {
  window.dispatchEvent(new CustomEvent<ReportRequest>(REPORT_EVENT, { detail: request }));
}

/** An error as a report takes it, from whatever was thrown or shown. */
export function reportedError(error: unknown): NonNullable<ReportRequest["error"]> {
  if (error instanceof Error)
    return {
      name: error.name,
      message: error.message || String(error),
      ...(error.stack ? { stack: error.stack } : {}),
    };
  return { message: typeof error === "string" ? error : (JSON.stringify(error) ?? String(error)) };
}

/** What the person settled on in the preview. */
export interface Include {
  readonly logs: boolean;
  readonly screenshot: boolean;
  readonly thread_excerpt: boolean;
  readonly code: boolean;
}

/** Privacy first: logs on (they are why a report helps), everything else off until the person turns it on. */
export function initialInclude(prepared: Pick<BugReportPrepared, "files">): Include {
  return {
    logs: prepared.files.some((f) => !f.code),
    screenshot: false,
    thread_excerpt: false,
    code: false,
  };
}

/** The files Send would put in the logs part, as the preview lists them. */
export function filesSent(prepared: Pick<BugReportPrepared, "files">, include: Include) {
  return include.logs ? prepared.files.filter((f) => !f.code || include.code) : [];
}

/** The chat excerpt Send would put beside the logs, or undefined. */
export function excerptSent(
  prepared: Pick<BugReportPrepared, "excerpt">,
  include: Include,
): string | undefined {
  if (!include.thread_excerpt || !prepared.excerpt) return undefined;
  return include.code ? prepared.excerpt.with_code : prepared.excerpt.plain;
}

/**
 * The person's own words as they will leave: the same rules the runtime runs again on Send, so the preview never
 * shows text that is not what is sent. `removed` counts what the rules took out.
 */
export function typed(
  text: string,
  include: Pick<Include, "code">,
): { text: string; removed: number } {
  const out = redact(text, { keepCode: include.code });
  return { text: out.text, removed: Object.values(out.counts).reduce((a, b) => a + b, 0) };
}

/** The report part exactly as Send would send it (the runtime adds nothing but the redaction rules' list). */
export function reportPart(
  prepared: BugReportPrepared,
  draft: { title: string; summary: string; note: string },
  include: Include,
) {
  const title = typed(
    draft.title.trim().replace(/\s+/g, " ").slice(0, BUG_REPORT_LIMITS.titleChars) ||
      prepared.title,
    include,
  ).text;
  const summary = typed(
    draft.summary.trim().slice(0, BUG_REPORT_LIMITS.summaryChars) || prepared.summary,
    include,
  ).text;
  const note = draft.note.trim()
    ? typed(draft.note.trim().slice(0, BUG_REPORT_LIMITS.noteChars), include).text
    : undefined;
  const { meta } = prepared;
  return {
    reportId: prepared.report_id,
    createdAt: prepared.created_at,
    appVersion: meta.app_version,
    buildChannel: meta.build_channel,
    platform: meta.platform,
    osVersion: meta.os_version,
    arch: meta.arch,
    errorSignature: meta.error_signature,
    title,
    agentSummary: summary,
    ...(note ? { userNote: note } : {}),
    context: {
      surface: meta.surface,
      ...(meta.provider_id ? { providerId: meta.provider_id } : {}),
      ...(meta.model_id ? { modelId: meta.model_id } : {}),
      ...(meta.thread_id ? { threadId: meta.thread_id } : {}),
    },
    redaction: { version: prepared.redaction.version },
    includes: {
      logs: filesSent(prepared, include).length > 0,
      screenshot: include.screenshot && prepared.screenshot !== undefined,
      threadExcerpt: excerptSent(prepared, include) !== undefined,
    },
  };
}

const RULE_WORDS: Record<string, string> = {
  anthropic_key: "keys",
  openai_key: "keys",
  github_token: "tokens",
  aws_access_key: "keys",
  aws_secret: "keys",
  google_api_key: "keys",
  slack_token: "tokens",
  stripe_key: "keys",
  caveman_key: "keys",
  jwt: "tokens",
  ssh_key: "keys",
  private_key: "keys",
  bearer: "tokens",
  auth_header: "tokens",
  url_credentials: "passwords",
  secret_query: "tokens",
  env_value: ".env values",
  secret_assignment: "secrets",
  secret_flag: "secrets",
  email: "emails",
  home_path: "your name in paths",
  code_block: "code blocks",
  long_line: "long lines cut",
};

/** "Removed 3 keys or tokens, 2 emails and your name in 14 paths" from the rules' counts. */
export function removedLine(counts: Readonly<Record<string, number>>): string | null {
  const by = new Map<string, number>();
  for (const [rule, n] of Object.entries(counts)) {
    if (!n) continue;
    const word = RULE_WORDS[rule] ?? "other";
    const group =
      word === "keys" || word === "tokens" || word === "passwords" || word === "secrets"
        ? "keys, tokens or passwords"
        : word;
    by.set(group, (by.get(group) ?? 0) + n);
  }
  if (by.size === 0) return null;
  const parts = [...by].map(([word, n]) =>
    word === "your name in paths" ? `your name in ${n} path${n === 1 ? "" : "s"}` : `${n} ${word}`,
  );
  return `Removed ${parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`}.`;
}

const ITEM_CHARS = 1_500;

/**
 * The end of a chat as text: the person's messages, the answers and any error, newest last, within the excerpt
 * limit. Tool output and reasoning stay out: they are where code and file contents live.
 */
export function threadExcerpt(
  items: ReadonlyArray<TranscriptItem>,
  max: number = BUG_REPORT_LIMITS.excerptChars,
): string {
  const lines: string[] = [];
  let used = 0;
  for (let i = items.length - 1; i >= 0 && used < max; i--) {
    const item = items[i]!;
    const text =
      item.kind === "user"
        ? `person: ${item.text}`
        : item.kind === "assistant"
          ? `agent: ${item.text}`
          : item.kind === "notice" && item.tone !== "info"
            ? `${item.tone}: ${item.text}`
            : null;
    if (text === null) continue;
    const clipped = text.length > ITEM_CHARS ? `${text.slice(0, ITEM_CHARS)} […]` : text;
    lines.unshift(clipped);
    used += clipped.length + 2;
  }
  const out = lines.join("\n\n");
  return out.length > max ? out.slice(out.length - max) : out;
}

/** Who gathers and sends a report: the runtime normally; the desktop app when the runtime cannot run. */
export interface ReportBackend {
  readonly kind: "runtime" | "desktop";
  prepare(request: ReportRequest, screenshot: string | undefined): Promise<BugReportPrepared>;
  /** A model's description; absent where none can run (the desktop's path: no engines without the runtime). */
  readonly describe?: (reportId: string) => Promise<{
    title: string;
    summary: string;
    drafted_by: "template" | "agent";
    error?: string | undefined;
  }>;
  send(
    reportId: string,
    draft: { title: string; summary: string; note: string },
    include: Include,
  ): Promise<BugReportRecord>;
}

const prepareParams = (request: ReportRequest, screenshot: string | undefined) => ({
  surface: request.surface,
  ...(request.error ? { error: request.error } : {}),
  ...(request.providerId ? { provider_id: request.providerId } : {}),
  ...(request.modelId ? { model_id: request.modelId } : {}),
  ...(request.threadId ? { thread_id: request.threadId } : {}),
  ...(request.threadExcerpt ? { thread_excerpt: request.threadExcerpt } : {}),
  ...(screenshot ? { screenshot_png_base64: screenshot } : {}),
});

const sendParams = (
  reportId: string,
  draft: { title: string; summary: string; note: string },
  include: Include,
) => ({
  report_id: reportId,
  title: draft.title,
  summary: draft.summary,
  ...(draft.note.trim() ? { note: draft.note } : {}),
  include,
});

export function runtimeBackend(client: Client): ReportBackend {
  return {
    kind: "runtime",
    prepare: (request, screenshot) =>
      client.call("bug_report.prepare", prepareParams(request, screenshot)),
    describe: (reportId) => client.call("bug_report.describe", { report_id: reportId }),
    send: (reportId, draft, include) =>
      client.call("bug_report.send", {
        request_id: crypto.randomUUID(),
        ...sendParams(reportId, draft, include),
      }),
  };
}

export function desktopBackend(bridge: DesktopBugReport): ReportBackend {
  return {
    kind: "desktop",
    prepare: (request, screenshot) => bridge.prepare(prepareParams(request, screenshot)),
    send: (reportId, draft, include) => bridge.queue(sendParams(reportId, draft, include)),
  };
}

/** PNG bytes as base64, in chunks (a large screenshot overflows a single spread into String.fromCharCode). */
export function base64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000)
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** A report's state in a few words, for the dialog after Send and Settings > Problem reports. */
export function statusLine(
  record: Pick<
    BugReportRecord,
    "state" | "server_status" | "fixed_in_version" | "duplicate_of" | "last_error"
  >,
): string {
  if (record.state === "sent") {
    if (record.server_status === "fixed")
      return record.fixed_in_version ? `Fixed in ${record.fixed_in_version}` : "Fixed";
    if (record.server_status === "triaged") return "The team is looking at it";
    return record.duplicate_of ? "Sent: others reported this too" : "Sent";
  }
  if (record.state === "failed") return record.last_error ?? "Not sent";
  if (record.state === "sending") return "Sending…";
  return record.last_error ?? "Waiting to send";
}
