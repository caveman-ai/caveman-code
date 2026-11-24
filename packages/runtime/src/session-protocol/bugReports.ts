// Problem reports on the Session Protocol (bug_report.prepare, describe, send,
// list, delete; docs/). The runtime gathers and redacts
// this computer's logs, a model describes the problem, the person reads and
// edits all of it in the preview, and only Send puts it in the outbox, which
// sends it on the kept Caveman sign-in (bugReports/sender.ts). Only this
// runtime's owner may call them, as with the account: the logs are theirs.
import * as Effect from "effect/Effect";

import { BUG_REPORT_LIMITS, clip } from "@caveman-app/bug-report";
import {
  finalizeReport,
  prepareReport,
  PreparedReports,
  ReportTooLarge,
  type BugReportOutbox,
  type LogSource,
  type ReportEnvironment,
} from "@caveman-app/bug-report/node";
import { editsOf, preparedView, recordView } from "@caveman-app/shared/bugReportWire";

import type { BugReportSender } from "../bugReports/sender.ts";
import { type Handler, ProtocolError } from "./handlers.ts";

type BugReportMethod =
  | "bug_report.prepare"
  | "bug_report.describe"
  | "bug_report.send"
  | "bug_report.list"
  | "bug_report.delete";

/** What a model reads to describe a report: already redacted. Throws when no model can (none signed in, none set). */
export type DescribeReport = (input: {
  surface: string;
  error: string;
  logs: string;
  appVersion: string;
  platform: string;
}) => Promise<{ title: string; summary: string }>;

export interface BugReportDeps {
  readonly outbox: BugReportOutbox;
  readonly sender: BugReportSender;
  readonly env: ReportEnvironment;
  readonly sources: () => ReadonlyArray<LogSource>;
  readonly describe?: DescribeReport | undefined;
  readonly allowed: (principal: string | undefined) => boolean;
  readonly now?: () => number;
  /** How long bug_report.send waits for the first attempt before answering "queued". */
  readonly sendWaitMs?: number;
  /** How long a model may take to describe a report before the template stays. */
  readonly describeTimeoutMs?: number;
}

/**
 * The newest log lines a model reads: the end of each non-code log, newest first, within its prompt budget. Traces
 * (.ndjson spans) go to the team but not to the model: their tail is database spans that would crowd out the log.
 */
function logsForModel(
  files: ReadonlyArray<{ readonly text: string; readonly code: boolean; readonly name: string }>,
): string {
  let budget = 24_000;
  const parts: string[] = [];
  for (const file of files) {
    if (file.code || file.name.endsWith(".ndjson") || budget <= 0) continue;
    const tail = file.text.slice(-Math.min(budget, 12_000));
    budget -= tail.length;
    parts.push(`--- ${file.name} (end) ---\n${tail}`);
  }
  return parts.join("\n\n");
}

/** Why no model wrote it, in a line: a CLI's failure carries its whole output, the prompt and logs included. */
export function shortReason(cause: unknown): string {
  const text = (cause instanceof Error ? cause.message : String(cause)).replace(
    /^Text generation failed in generateBugReport: /,
    "",
  );
  const line = text.split(/\n| -------- |: \d{4}-\d{2}-\d{2}T/)[0]!.trim();
  return clip(line || "the model failed", 160);
}

const MAX_SCREENSHOT_BASE64 = Math.ceil((BUG_REPORT_LIMITS.screenshotBytes * 4) / 3) + 4;

export const makeBugReportHandlers = (deps: BugReportDeps) => {
  const now = deps.now ?? Date.now;
  const prepared = new PreparedReports();
  const invalid = (message: string) => new ProtocolError({ reason: "invalid_params", message });
  const notFound = new ProtocolError({
    reason: "not_found",
    message: "That report is no longer waiting here. Start it again.",
  });
  const internal = (error: unknown) =>
    new ProtocolError({
      reason: "internal",
      message: error instanceof Error ? error.message : String(error),
    });

  const handlers: { readonly [M in BugReportMethod]: Handler<M> } = {
    "bug_report.prepare": (p) =>
      Effect.gen(function* () {
        if (
          p.screenshot_png_base64 !== undefined &&
          p.screenshot_png_base64.length > MAX_SCREENSHOT_BASE64
        ) {
          return yield* Effect.fail(invalid("The screenshot is over 5 MB."));
        }
        const screenshot = p.screenshot_png_base64
          ? new Uint8Array(Buffer.from(p.screenshot_png_base64, "base64"))
          : undefined;
        const report = yield* Effect.try({
          try: () =>
            prepareReport(
              {
                surface: p.surface,
                ...(p.error
                  ? {
                      error: {
                        ...p.error,
                        message: clip(p.error.message, 20_000),
                        ...(p.error.stack ? { stack: clip(p.error.stack, 20_000) } : {}),
                      },
                    }
                  : {}),
                context: { providerId: p.provider_id, modelId: p.model_id, threadId: p.thread_id },
                threadExcerpt: p.thread_excerpt,
                screenshot,
              },
              deps.sources(),
              deps.env,
              now(),
            ),
          catch: internal,
        });
        prepared.put(report, now());
        return preparedView(report);
      }),

    "bug_report.describe": (p) =>
      Effect.promise(async () => {
        const report = prepared.get(p.report_id);
        if (!report) return undefined;
        const template = {
          title: report.draft.title,
          summary: report.draft.summary,
          drafted_by: "template" as const,
        };
        if (!deps.describe) return { ...template, error: "No model is set up to describe it." };
        const error = report.error
          ? [report.error.name, report.error.message, report.error.stack].filter(Boolean).join("\n")
          : "";
        let timer: NodeJS.Timeout | undefined;
        try {
          const written = await Promise.race([
            deps.describe({
              surface: report.surface,
              error,
              logs: logsForModel(report.files),
              appVersion: report.env.appVersion,
              platform: `${report.env.platform} ${report.env.arch}`,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("The model took too long.")),
                deps.describeTimeoutMs ?? 60_000,
              );
            }),
          ]);
          const title = clip(written.title.trim(), BUG_REPORT_LIMITS.titleChars);
          const summary = clip(written.summary.trim(), BUG_REPORT_LIMITS.summaryChars);
          if (!title || !summary) return { ...template, error: "The model wrote nothing." };
          prepared.set(report.reportId, { ...report, draft: { title, summary, by: "agent" } });
          return { title, summary, drafted_by: "agent" as const };
        } catch (cause) {
          return { ...template, error: shortReason(cause) };
        } finally {
          clearTimeout(timer);
        }
      }).pipe(
        Effect.flatMap((answer) => (answer ? Effect.succeed(answer) : Effect.fail(notFound))),
      ),

    "bug_report.send": (p) =>
      Effect.gen(function* () {
        // Sent already (a retry of the same request, or a second press): the outbox has it.
        const kept = deps.outbox.get(p.report_id);
        if (kept) return recordView(kept);
        const report = prepared.get(p.report_id);
        if (!report) return yield* Effect.fail(notFound);
        const parts = yield* Effect.try({
          try: () => finalizeReport(report, editsOf(p)),
          catch: (error) =>
            error instanceof ReportTooLarge ? invalid(error.message) : internal(error),
        });
        const queued = yield* Effect.try({
          try: () => deps.outbox.enqueue(parts),
          catch: internal,
        });
        prepared.delete(p.report_id);
        // The first attempt starts now; the answer waits for it a few seconds, then says "queued".
        const first = deps.sender.attempt(queued.reportId).catch(() => undefined);
        let timer: NodeJS.Timeout | undefined;
        const settled = yield* Effect.promise(() =>
          Promise.race([
            first,
            new Promise<undefined>(
              (resolve) =>
                (timer = setTimeout(() => resolve(undefined), deps.sendWaitMs ?? 15_000)),
            ),
          ]).finally(() => clearTimeout(timer)),
        );
        return recordView(settled ?? deps.outbox.get(queued.reportId) ?? queued);
      }),

    "bug_report.list": (p) =>
      Effect.promise(async () => {
        if (p.refresh) {
          const sent = deps.outbox
            .list()
            .filter((r) => r.state === "sent" && r.serverStatus !== "fixed")
            .slice(0, 20);
          await Promise.all(
            sent.map((r) => deps.sender.refresh(r.reportId).catch(() => undefined)),
          );
        }
        return { reports: deps.outbox.list().map(recordView) };
      }),

    "bug_report.delete": (p) =>
      Effect.tryPromise({
        try: async () => {
          prepared.delete(p.report_id);
          await deps.sender.remove(p.report_id);
          return { deleted: true };
        },
        catch: internal,
      }),
  };
  const forbidden = new ProtocolError({
    reason: "forbidden",
    message: "problem reports belong to this runtime's owner",
  });
  return Object.fromEntries(
    Object.entries(handlers).map(([method, handler]) => [
      method,
      (params: never, ctx: { readonly connectionId: string; readonly principal?: string }) =>
        deps.allowed(ctx.principal)
          ? (handler as (p: never, c: typeof ctx) => Effect.Effect<unknown, ProtocolError>)(
              params,
              ctx,
            )
          : Effect.fail(forbidden),
    ]),
  ) as unknown as typeof handlers;
};
