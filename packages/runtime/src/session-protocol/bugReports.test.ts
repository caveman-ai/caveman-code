// End to end on this computer: the bug_report.* handlers over real log files
// (with secrets planted in them), the real outbox on disk and the real sender,
// against a stand-in Caveman Cloud on 127.0.0.1 that holds the agreed contract.
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUG_REPORT_ROUTE, BUG_REPORTS_UNAVAILABLE } from "@caveman-app/bug-report";
import { BugReportOutbox, type ReportEnvironment } from "@caveman-app/bug-report/node";

import type { AccountSession } from "../cloudLink/account.ts";
import { makeBugReportSender } from "../bugReports/sender.ts";
import { logSources } from "../bugReports/sources.ts";
import {
  parseMultipart,
  startTestBugReportCloud,
  type TestBugReportCloud,
} from "../bugReports/testCloudBugReports.ts";
import { makeBugReportHandlers, type DescribeReport } from "./bugReports.ts";

const env: ReportEnvironment = {
  appVersion: "1.4.0",
  buildChannel: "stable",
  platform: "darwin",
  osVersion: "Darwin 25.0",
  arch: "arm64",
  homeDir: "/Users/ada",
  userName: "ada",
};
const SECRETS = [
  ("sk-" + "ant-api03-SECRETSECRETSECRET0123456789"),
  ("gh" + "p_SECRETsecretSECRETsecret0123456789ab"),
  "ada.lovelace@example.com",
  ("AK" + "IAIOSFODNN7SECRET1"),
  "hunter2-db-password",
  "/Users/ada/",
  "const privateBusinessLogic",
];

let cloud: TestBugReportCloud;
beforeEach(async () => {
  cloud = await startTestBugReportCloud();
});
afterEach(() => cloud.close());

function setup(
  opts: { describe?: DescribeReport; principalAllowed?: boolean; session?: AccountSession } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "bug-report-e2e-"));
  const now = Date.now();
  const desktopLogs = join(root, "desktop-logs");
  const runtimeLogs = join(root, "logs");
  mkdirSync(desktopLogs);
  mkdirSync(join(runtimeLogs, "provider"), { recursive: true });
  const at = new Date(now - 60_000).toISOString();
  writeFileSync(
    join(desktopLogs, "desktop.log"),
    [
      `${new Date(now - 10 * 3600_000).toISOString()} runtime: an old line from yesterday`,
      `${at} runtime: starting in /Users/ada/code/app`,
      `${at} runtime: provider auth with Bearer ${SECRETS[0]} failed`,
      `${at} runtime: git push https://x:${SECRETS[1]}@github.com/acme/app.git`,
      `${at} runtime: signed in as ${SECRETS[2]}`,
      `DATABASE_PASSWORD=${SECRETS[4]}`,
      `${at} runtime: aws ${SECRETS[3]}`,
      "```ts",
      `${SECRETS[6]} = 1;`,
      "```",
      `${at} runtime: TypeError: Cannot read properties of undefined (reading 'id')`,
    ].join("\n"),
  );
  writeFileSync(
    join(runtimeLogs, "provider", "events.thread-1.log"),
    `${at} provider: the agent read ${SECRETS[6]} from /Users/ada/code/app/src/secret.ts`,
  );
  for (const f of [
    join(desktopLogs, "desktop.log"),
    join(runtimeLogs, "provider", "events.thread-1.log"),
  ])
    utimesSync(f, now / 1000, now / 1000);

  const outbox = new BugReportOutbox(join(root, "userdata", "bug-reports"));
  const store = {
    session:
      opts.session ??
      ({ cloud_url: cloud.url, access_token: "token-ada" } as AccountSession | undefined),
  };
  const accountStore = {
    load: async () => store.session,
    save: async (s: AccountSession | undefined) => void (store.session = s),
  };
  const sender = makeBugReportSender({ outbox, store: accountStore });
  const handlers = makeBugReportHandlers({
    outbox,
    sender,
    env,
    sources: () => logSources({ runtimeLogsDir: runtimeLogs, desktopLogsDir: desktopLogs }),
    describe: opts.describe,
    allowed: () => opts.principalAllowed ?? true,
    sendWaitMs: 5_000,
  });
  const call = <M extends keyof typeof handlers>(
    method: M,
    params: Parameters<(typeof handlers)[M]>[0],
    principal = "local",
  ) =>
    Effect.runPromise(
      (handlers[method] as (p: unknown, c: unknown) => Effect.Effect<never, unknown>)(params, {
        connectionId: "c1",
        principal,
      }),
    ) as Promise<Effect.Success<ReturnType<(typeof handlers)[M]>>>;
  return { call, outbox, store, sender };
}

const errorParams = {
  surface: "chat" as const,
  error: {
    name: "TypeError",
    message: `Cannot read properties of undefined (reading 'id') for ${SECRETS[2]}`,
    stack: "TypeError: x\n    at readThread (/Users/ada/app/assets/index-AbC123xy.js:10:5)",
  },
  provider_id: "codex",
  model_id: "gpt-5",
  thread_id: "thread-1",
  thread_excerpt: `user: why is ${SECRETS[0]} failing?\n\`\`\`\n${SECRETS[6]}\n\`\`\`\nassistant: let me look`,
  screenshot_png_base64: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64"),
};

/** Every byte Cloud received for a report, as text, logs unpacked. */
function everythingSent(cloud: TestBugReportCloud, id: string): string {
  const stored = cloud.reports.get(id)!;
  const tar = stored.logs ? gunzipSync(stored.logs).toString("utf8") : "";
  return `${JSON.stringify(stored.report)}\n${tar}`;
}

describe("bug_report.* end to end", () => {
  it("prepares a redacted preview, sends exactly what the person approved, and nothing secret leaves", async () => {
    const { call } = setup();
    const preview = await call("bug_report.prepare", errorParams);
    expect(preview.drafted_by).toBe("template");
    expect(preview.meta).toMatchObject({
      app_version: "1.4.0",
      platform: "darwin",
      surface: "chat",
      thread_id: "thread-1",
    });
    expect(preview.meta.error_signature).toMatch(/^[0-9a-f]{32}$/);
    const desktop = preview.files.find((f) => f.name === "desktop.log")!;
    expect(desktop.code).toBe(false);
    expect(desktop.text).not.toContain("an old line from yesterday");
    expect(desktop.text).toContain("Bearer [REDACTED:anthropic_key]");
    expect(desktop.text).toContain("~/code/app");
    expect(preview.files.find((f) => f.name.startsWith("provider-"))?.code).toBe(true);
    expect(preview.redaction.counts.email).toBeGreaterThan(0);
    for (const secret of SECRETS) {
      expect(desktop.text).not.toContain(secret);
      expect(preview.title).not.toContain(secret);
      expect(preview.excerpt!.plain).not.toContain(secret);
    }
    // Nothing is sent until Send.
    expect(cloud.requests).toEqual([]);

    const sent = await call("bug_report.send", {
      request_id: "r1",
      report_id: preview.report_id,
      title: preview.title,
      summary: preview.summary,
      note: `It happened twice. Reach me at ${SECRETS[2]}`,
      include: { logs: true, screenshot: true, thread_excerpt: true, code: false },
    });
    expect(sent).toMatchObject({
      report_id: preview.report_id,
      state: "sent",
      server_status: "received",
    });

    const stored = cloud.reports.get(preview.report_id)!;
    expect(stored.order).toEqual(["report", "logs", "screenshot"]);
    expect(stored.report).toMatchObject({
      reportId: preview.report_id,
      appVersion: "1.4.0",
      buildChannel: "stable",
      platform: "darwin",
      arch: "arm64",
      errorSignature: preview.meta.error_signature,
      context: { surface: "chat", providerId: "codex", modelId: "gpt-5", threadId: "thread-1" },
      includes: { logs: true, screenshot: true, threadExcerpt: true },
      userNote: "It happened twice. Reach me at [REDACTED:email]",
    });
    expect(stored.report.redaction.rulesApplied).toContain("code_block");
    const all = everythingSent(cloud, preview.report_id);
    for (const secret of SECRETS) expect(all).not.toContain(secret);
    // The code-bearing provider log stays home without the opt-in.
    expect(all).not.toContain("provider-events");
    expect(all).toContain("logs/desktop.log");
  });

  it("sends the code-bearing logs only with the opt-in, still without keys", async () => {
    const { call } = setup();
    const preview = await call("bug_report.prepare", errorParams);
    await call("bug_report.send", {
      request_id: "r1",
      report_id: preview.report_id,
      title: "t",
      summary: "s",
      include: { logs: true, screenshot: false, thread_excerpt: true, code: true },
    });
    const all = everythingSent(cloud, preview.report_id);
    expect(all).toContain("logs/provider-events.thread-1.log");
    expect(all).toContain(SECRETS[6]);
    expect(all).not.toContain(SECRETS[0]);
    expect(all).not.toContain("/Users/ada/");
    // The app's own log still loses incidental code; the opt-in covers chats and the engines' logs.
    expect(all).not.toContain("[code removed: 1 lines]\nassistant");
    expect(cloud.reports.get(preview.report_id)!.report.redaction.rulesApplied).toContain(
      "code_block",
    );
    expect(cloud.reports.get(preview.report_id)!.order).toEqual(["report", "logs"]);
  });

  it("lets a model describe it, and keeps the template when none can", async () => {
    let seen = "";
    const { call } = setup({
      describe: async (input) => {
        seen = `${input.error}\n${input.logs}`;
        return {
          title: "Thread view crashes reading a missing id",
          summary:
            "What happened\nThe chat crashed.\n\nLikely cause\nA thread without an id.\n\nSteps to reproduce\n1. Open a chat.",
        };
      },
    });
    const preview = await call("bug_report.prepare", errorParams);
    const described = await call("bug_report.describe", { report_id: preview.report_id });
    expect(described).toMatchObject({
      drafted_by: "agent",
      title: "Thread view crashes reading a missing id",
    });
    // The model read only redacted text, and never the code-bearing logs.
    for (const secret of SECRETS) expect(seen).not.toContain(secret);
    expect(seen).not.toContain("provider:");
    expect(seen).toContain("--- desktop.log (end) ---");

    const failing = setup({
      describe: async () => Promise.reject(new Error("No engine is signed in.")),
    });
    const p2 = await failing.call("bug_report.prepare", {
      surface: "onboarding",
      error: { message: "fetch failed" },
    });
    expect(await failing.call("bug_report.describe", { report_id: p2.report_id })).toMatchObject({
      drafted_by: "template",
      title: p2.title,
      error: "No engine is signed in.",
    });
    // A CLI's failure carries its whole output; the person sees one line of it.
    const noisy = setup({
      describe: async () =>
        Promise.reject(
          new Error(
            `Text generation failed in generateBugReport: Codex CLI command failed: 2026-11-09T04:16:41Z ERROR ${"x".repeat(5000)}`,
          ),
        ),
    });
    const p4 = await noisy.call("bug_report.prepare", { surface: "onboarding" });
    expect(await noisy.call("bug_report.describe", { report_id: p4.report_id })).toMatchObject({
      error: "Codex CLI command failed",
    });
    const none = setup();
    const p3 = await none.call("bug_report.prepare", { surface: "install" });
    expect(await none.call("bug_report.describe", { report_id: p3.report_id })).toMatchObject({
      drafted_by: "template",
    });
  });

  it("queues offline, answers 'queued', and sends on the next tick once back", async () => {
    const { call, sender, outbox } = setup();
    cloud.offline = true;
    const preview = await call("bug_report.prepare", {
      surface: "runtime",
      error: { message: "runtime exited 1" },
    });
    const queued = await call("bug_report.send", {
      request_id: "r1",
      report_id: preview.report_id,
      title: "t",
      summary: "s",
      include: { logs: true, screenshot: false, thread_excerpt: false, code: false },
    });
    expect(queued).toMatchObject({ state: "queued", attempts: 1 });
    expect(queued.last_error).toContain("online");
    cloud.offline = false;
    outbox.update(preview.report_id, { nextAttemptAt: new Date(Date.now() - 1).toISOString() });
    await sender.sendDue();
    const { reports } = await call("bug_report.list", {});
    expect(reports[0]).toMatchObject({ report_id: preview.report_id, state: "sent" });
  });

  it("before Cloud's report routes are deployed: saved, and the person reads that reports aren't available yet", async () => {
    const { call, outbox } = setup();
    cloud.deployed = false;
    const preview = await call("bug_report.prepare", {
      surface: "other",
      error: { message: "boom" },
    });
    const record = await call("bug_report.send", {
      request_id: "r1",
      report_id: preview.report_id,
      title: "t",
      summary: "s",
      include: { logs: true, screenshot: false, thread_excerpt: false, code: false },
    });
    expect(record).toMatchObject({ state: "queued", last_error: BUG_REPORTS_UNAVAILABLE });
    expect(outbox.parts(preview.report_id)?.payload.reportId).toBe(preview.report_id);
    expect((await call("bug_report.list", {})).reports[0]).toMatchObject({
      report_id: preview.report_id,
      state: "queued",
    });
  });

  it("is idempotent: a second send of the same report sends nothing more", async () => {
    const { call } = setup();
    const preview = await call("bug_report.prepare", { surface: "other" });
    const params = {
      request_id: "r1",
      report_id: preview.report_id,
      title: "t",
      summary: "s",
      include: { logs: false, screenshot: false, thread_excerpt: false, code: false },
    };
    await call("bug_report.send", params);
    await call("bug_report.send", { ...params, request_id: "r2" });
    expect(cloud.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });

  it("shows the status Caveman gives it, and deletes it everywhere", async () => {
    const { call, outbox } = setup();
    const preview = await call("bug_report.prepare", {
      surface: "chat",
      error: { message: "boom" },
    });
    await call("bug_report.send", {
      request_id: "r1",
      report_id: preview.report_id,
      title: "t",
      summary: "s",
      include: { logs: true, screenshot: false, thread_excerpt: false, code: false },
    });
    const stored = cloud.reports.get(preview.report_id)!;
    stored.status = "fixed";
    stored.fixedInVersion = "1.4.1";
    expect((await call("bug_report.list", { refresh: true })).reports[0]).toMatchObject({
      server_status: "fixed",
      fixed_in_version: "1.4.1",
    });
    expect(
      await call("bug_report.delete", { request_id: "d1", report_id: preview.report_id }),
    ).toEqual({ deleted: true });
    expect(cloud.reports.has(preview.report_id)).toBe(false);
    expect(outbox.list()).toEqual([]);
  });

  it("flags a second report of the same failure as a duplicate without dropping it", async () => {
    const { call } = setup();
    const send = async () => {
      const p = await call("bug_report.prepare", {
        surface: "chat",
        error: {
          name: "TypeError",
          message: "x",
          stack: "TypeError: x\n    at a (/Users/ada/a.js:1:1)",
        },
      });
      return call("bug_report.send", {
        request_id: p.report_id,
        report_id: p.report_id,
        title: "t",
        summary: "s",
        include: { logs: false, screenshot: false, thread_excerpt: false, code: false },
      });
    };
    const first = await send();
    const second = await send();
    expect(second.duplicate_of).toBe(first.report_id);
    expect(cloud.reports.size).toBe(2);
  });

  it("is for this runtime's owner only", async () => {
    const { call } = setup({ principalAllowed: false });
    await expect(
      call("bug_report.prepare", { surface: "other" }, "cloud:someone-else"),
    ).rejects.toMatchObject({ reason: "forbidden" });
    await expect(call("bug_report.list", {}, "cloud:someone-else")).rejects.toMatchObject({
      reason: "forbidden",
    });
  });

  it("refuses a send for a report that was never prepared, and an oversized screenshot", async () => {
    const { call } = setup();
    await expect(
      call("bug_report.send", {
        request_id: "r",
        report_id: "0f3a9b2c-1111-4222-8333-444455556666",
        title: "t",
        summary: "s",
        include: { logs: false, screenshot: false, thread_excerpt: false, code: false },
      }),
    ).rejects.toMatchObject({ reason: "not_found" });
    await expect(
      call("bug_report.prepare", {
        surface: "other",
        screenshot_png_base64: "A".repeat(8 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ reason: "invalid_params" });
  });
});

describe("the stand-in Cloud holds the contract", () => {
  it("refuses a body whose first part is not the report, and another account's report", async () => {
    const form = new FormData();
    form.append(
      "logs",
      new Blob([new Uint8Array([1])], { type: "application/gzip" }),
      "logs.tar.gz",
    );
    form.append("report", new Blob(["{}"], { type: "application/json" }), "report.json");
    const response = await fetch(`${cloud.url}${BUG_REPORT_ROUTE}`, {
      method: "POST",
      headers: { authorization: "Bearer token-ada" },
      body: form,
    });
    expect(response.status).toBe(400);
    const unauthenticated = await fetch(`${cloud.url}${BUG_REPORT_ROUTE}`, {
      method: "POST",
      body: new FormData(),
    });
    expect(unauthenticated.status).toBe(401);

    const { call } = setup();
    const p = await call("bug_report.prepare", { surface: "other" });
    await call("bug_report.send", {
      request_id: "r",
      report_id: p.report_id,
      title: "t",
      summary: "s",
      include: { logs: false, screenshot: false, thread_excerpt: false, code: false },
    });
    const asBob = await fetch(`${cloud.url}${BUG_REPORT_ROUTE}/${p.report_id}`, {
      headers: { authorization: "Bearer token-bob" },
    });
    expect(asBob.status).toBe(404);
    expect(
      parseMultipart(
        Buffer.from(
          '--b\r\nContent-Disposition: form-data; name="report"; filename="r.json"\r\n\r\n{}\r\n--b--\r\n',
        ),
        "multipart/form-data; boundary=b",
      )[0]!.name,
    ).toBe("report");
  });
});
