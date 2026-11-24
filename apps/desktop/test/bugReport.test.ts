import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BugReportOutbox, outboxDir } from "../../../packages/bug-report/src/node.ts";
import { DesktopBugReports, desktopEnvironment, runtimeStateDir } from "../src/bugReport.ts";

describe("DesktopBugReports (the runtime is down)", () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "desktop-bug-"));
    const logDir = join(root, "logs");
    mkdirSync(logDir);
    const at = new Date().toISOString();
    writeFileSync(
      join(logDir, "desktop.log"),
      `${at} runtime: Error: listen EADDRINUSE with token=${"ghp_" + "a".repeat(36)} in /Users/ada/x\n${at} runtime: exited pid=1 code=1 signal=null`,
    );
    const stateDir = runtimeStateDir(join(root, "home"));
    const reports = new DesktopBugReports({
      logDir,
      runtimeStateDir: stateDir,
      env: { ...desktopEnvironment("2.0.0", "stable"), homeDir: "/Users/ada", userName: "ada" },
    });
    return { reports, stateDir };
  };

  it("prepares from this app's own log, redacted, with the template", () => {
    const { reports } = setup();
    const view = reports.prepare({
      surface: "runtime",
      error: { message: "The runtime kept stopping: listen EADDRINUSE" },
    });
    expect(view.drafted_by).toBe("template");
    expect(view.title).toBe("Runtime: The runtime kept stopping: listen EADDRINUSE");
    expect(view.files.map((f) => f.name)).toEqual(["desktop.log"]);
    expect(view.files[0]!.text).not.toContain("ghp_");
    expect(view.files[0]!.text).toContain("~/x");
    expect(view.meta).toMatchObject({
      app_version: "2.0.0",
      build_channel: "stable",
      surface: "runtime",
    });
  });

  it("refuses what the page cannot have meant, and falls back to 'other'", () => {
    const { reports } = setup();
    expect(reports.prepare({ surface: "../../etc", error: { message: 42 } }).meta.surface).toBe(
      "other",
    );
    expect(() => reports.queue({ report_id: "nope" })).toThrow(/no longer waiting/);
  });

  it("queues into the runtime's outbox for its next start, once", () => {
    const { reports, stateDir } = setup();
    const view = reports.prepare({ surface: "runtime", error: { message: "boom" } });
    const record = reports.queue({
      report_id: view.report_id,
      title: "Runtime won't start",
      summary: "s",
      include: { logs: true, screenshot: false, thread_excerpt: false, code: false },
    });
    expect(record).toMatchObject({
      report_id: view.report_id,
      state: "queued",
      title: "Runtime won't start",
    });
    expect(record.last_error).toContain("runs again");
    const outbox = new BugReportOutbox(outboxDir(stateDir));
    expect(outbox.parts(view.report_id)?.payload.includes).toEqual({
      logs: true,
      screenshot: false,
      threadExcerpt: false,
    });
    expect(reports.queue({ report_id: view.report_id }).report_id).toBe(view.report_id);
    expect(outbox.list()).toHaveLength(1);
  });
});
