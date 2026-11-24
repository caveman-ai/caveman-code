// Problem reports on the app's Session Protocol (docs/):
// a prepared report and an outbox record in the snake_case shapes
// bug_report.prepare and bug_report.list answer with, and the edits
// bug_report.send takes. The runtime answers with these; the desktop answers
// with the same while the runtime cannot run. The pipeline itself is
// @caveman-app/bug-report, which other Caveman clients share.
import { REDACTION_VERSION } from "@caveman-app/bug-report";
import {
  preparedCounts,
  type OutboxRecord,
  type PreparedReport,
  type ReportEdits,
} from "@caveman-app/bug-report/node";

/**
 * A prepared report as a client shows it in the preview (Session Protocol
 * bug_report.prepare, and the desktop's own when the runtime is down): snake_case,
 * every text exactly as it would be sent.
 */
export function preparedView(prepared: PreparedReport) {
  const { env, context } = prepared;
  return {
    report_id: prepared.reportId,
    created_at: prepared.createdAt,
    title: prepared.draft.title,
    summary: prepared.draft.summary,
    drafted_by: prepared.draft.by,
    files: prepared.files.map((file) => ({
      name: file.name,
      code: file.code,
      text: file.text,
      bytes: Buffer.byteLength(file.text),
    })),
    ...(prepared.excerpt
      ? {
          excerpt: {
            plain: prepared.excerpt.plain.text,
            with_code: prepared.excerpt.withCode.text,
          },
        }
      : {}),
    ...(prepared.screenshot
      ? {
          screenshot: {
            bytes: prepared.screenshot.byteLength,
            png_base64: Buffer.from(prepared.screenshot).toString("base64"),
          },
        }
      : {}),
    redaction: { version: REDACTION_VERSION, counts: preparedCounts(prepared) },
    meta: {
      app_version: env.appVersion,
      build_channel: env.buildChannel,
      platform: env.platform,
      os_version: env.osVersion,
      arch: env.arch,
      error_signature: prepared.errorSignature,
      surface: prepared.surface,
      ...(context.providerId ? { provider_id: context.providerId } : {}),
      ...(context.modelId ? { model_id: context.modelId } : {}),
      ...(context.threadId ? { thread_id: context.threadId } : {}),
    },
  };
}
export type PreparedView = ReturnType<typeof preparedView>;

/** A report on this computer as a client lists it (bug_report.list). */
export function recordView(record: OutboxRecord) {
  return {
    report_id: record.reportId,
    title: record.title,
    surface: record.surface,
    created_at: record.createdAt,
    state: record.state,
    attempts: record.attempts,
    ...(record.nextAttemptAt ? { next_attempt_at: record.nextAttemptAt } : {}),
    ...(record.lastError ? { last_error: record.lastError } : {}),
    ...(record.sentAt ? { sent_at: record.sentAt } : {}),
    ...(record.serverStatus ? { server_status: record.serverStatus } : {}),
    ...(record.fixedInVersion ? { fixed_in_version: record.fixedInVersion } : {}),
    ...(record.duplicateOf ? { duplicate_of: record.duplicateOf } : {}),
  };
}
export type RecordView = ReturnType<typeof recordView>;

/** The edits a client sends (bug_report.send), as finalizeReport takes them. */
export const editsOf = (p: {
  readonly title: string;
  readonly summary: string;
  readonly note?: string | undefined;
  readonly include: {
    readonly logs: boolean;
    readonly screenshot: boolean;
    readonly thread_excerpt: boolean;
    readonly code: boolean;
  };
}): ReportEdits => ({
  title: p.title,
  summary: p.summary,
  note: p.note,
  include: {
    logs: p.include.logs,
    screenshot: p.include.screenshot,
    threadExcerpt: p.include.thread_excerpt,
    code: p.include.code,
  },
});
