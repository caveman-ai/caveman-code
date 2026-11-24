// Problem reports when the runtime cannot run (docs/).
// Normally the page prepares and sends a report through the runtime
// (Session Protocol bug_report.*). When the runtime keeps stopping, the page
// prepares one here instead: this app's own logs (which hold every line the
// runtime printed), redacted by the same rules, with the template description.
// Send leaves it in the runtime's outbox, which sends it with the person's
// sign-in once the runtime runs again; this app never holds that sign-in.
// Electron-free.
import { homedir, release, userInfo, version as osVersionName } from "node:os";
import { join } from "node:path";

import {
  BUG_REPORT_SURFACES,
  type BugReportSurface,
} from "../../../packages/bug-report/src/index.ts";
import {
  BugReportOutbox,
  finalizeReport,
  outboxDir,
  prepareReport,
  PreparedReports,
  type LogSource,
  type ReportEnvironment,
} from "../../../packages/bug-report/src/node.ts";
import {
  editsOf,
  preparedView,
  recordView,
  type PreparedView,
  type RecordView,
} from "../../../packages/shared/src/bugReportWire.ts";

/** The runtime's state dir for a desktop runtime home (`<home>/userdata`, packages/runtime config.ts). */
export const runtimeStateDir = (runtimeHome: string | undefined) =>
  join(runtimeHome ?? join(homedir(), ".caveman-code"), "userdata");

export const desktopLogSources = (logDir: string): LogSource[] => [
  { name: "desktop.log", path: join(logDir, "desktop.log"), code: false },
  { name: "desktop.1.log", path: join(logDir, "desktop.1.log"), code: false },
];

export function desktopEnvironment(appVersion: string, buildChannel: string): ReportEnvironment {
  let userName = "";
  try {
    userName = userInfo().username;
  } catch {
    // No passwd entry: the home path rule still covers it.
  }
  return {
    appVersion,
    buildChannel,
    platform:
      process.platform === "win32" || process.platform === "darwin" ? process.platform : "linux",
    osVersion: `${osVersionName()} ${release()}`.trim(),
    arch: process.arch,
    homeDir: homedir(),
    userName,
  };
}

const str = (value: unknown, max: number): string | undefined =>
  typeof value === "string" && value !== "" ? value.slice(0, max) : undefined;

export class DesktopBugReports {
  private readonly prepared = new PreparedReports();
  private readonly logDir: string;
  private readonly outbox: BugReportOutbox;
  private readonly env: ReportEnvironment;

  constructor(options: {
    readonly logDir: string;
    readonly runtimeStateDir: string;
    readonly env: ReportEnvironment;
  }) {
    this.logDir = options.logDir;
    this.outbox = new BugReportOutbox(outboxDir(options.runtimeStateDir));
    this.env = options.env;
  }

  /** As bug_report.prepare, from what the page sends (checked: it crosses a process boundary). */
  prepare(input: unknown): PreparedView {
    const p = (input ?? {}) as Record<string, unknown>;
    const surface: BugReportSurface = BUG_REPORT_SURFACES.includes(p.surface as BugReportSurface)
      ? (p.surface as BugReportSurface)
      : "other";
    const error = p.error as Record<string, unknown> | undefined;
    const message = str(error?.message, 20_000);
    const png = p.screenshot_png_base64;
    const report = prepareReport(
      {
        surface,
        ...(message
          ? { error: { message, name: str(error?.name, 200), stack: str(error?.stack, 20_000) } }
          : {}),
        context: {
          providerId: str(p.provider_id, 200),
          modelId: str(p.model_id, 200),
          threadId: str(p.thread_id, 200),
        },
        threadExcerpt: str(p.thread_excerpt, 200_000),
        ...(typeof png === "string" && png.length < 8 * 1024 * 1024
          ? { screenshot: new Uint8Array(Buffer.from(png, "base64")) }
          : {}),
      },
      desktopLogSources(this.logDir),
      this.env,
    );
    this.prepared.put(report);
    return preparedView(report);
  }

  /** As bug_report.send, except that it only queues: the runtime sends it on its next start. */
  queue(input: unknown): RecordView {
    const p = (input ?? {}) as Record<string, unknown>;
    const id = str(p.report_id, 64) ?? "";
    const kept = this.outbox.get(id);
    if (kept) return recordView(kept);
    const report = this.prepared.get(id);
    if (!report) throw new Error("That report is no longer waiting here. Start it again.");
    const include = (p.include ?? {}) as Record<string, unknown>;
    const parts = finalizeReport(
      report,
      editsOf({
        title: str(p.title, 1_000) ?? "",
        summary: str(p.summary, 20_000) ?? "",
        note: str(p.note, 10_000),
        include: {
          logs: include.logs === true,
          screenshot: include.screenshot === true,
          thread_excerpt: include.thread_excerpt === true,
          code: include.code === true,
        },
      }),
    );
    this.outbox.enqueue(parts);
    this.prepared.delete(id);
    return recordView(
      this.outbox.update(id, { lastError: "Sends when Caveman Code's runtime runs again." })!,
    );
  }
}
