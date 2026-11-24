import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  BugReportOutbox,
  finalizeReport,
  prepareReport,
  type ReportEnvironment,
} from "@caveman-app/bug-report/node";

import { BUG_REPORTS_UNAVAILABLE } from "@caveman-app/bug-report";

import type { AccountSession, AccountStore } from "../cloudLink/account.ts";
import {
  backoffMs,
  GIVE_UP_AFTER_MS,
  makeBugReportSender,
  MAX_BACKOFF_MS,
  MIN_BACKOFF_MS,
  secureCloudUrl,
  SIGNED_OUT_WAIT_MS,
  UNAVAILABLE_WAIT_MS,
} from "./sender.ts";
import { startTestBugReportCloud, type TestBugReportCloud } from "./testCloudBugReports.ts";

const env: ReportEnvironment = {
  appVersion: "1.0.0",
  buildChannel: "stable",
  platform: "darwin",
  osVersion: "25",
  arch: "arm64",
  homeDir: "/Users/ada",
  userName: "ada",
};

const memoryStore = (
  session: AccountSession | undefined,
): AccountStore & { session: AccountSession | undefined } => {
  const store = {
    session,
    load: async () => store.session,
    save: async (next: AccountSession | undefined) => void (store.session = next),
  };
  return store;
};

let cloud: TestBugReportCloud;
beforeEach(async () => {
  cloud = await startTestBugReportCloud();
});
afterEach(() => cloud.close());

function setup(opts: { session?: AccountSession | null; clock?: { t: number } } = {}) {
  const outbox = new BugReportOutbox(join(mkdtempSync(join(tmpdir(), "outbox-")), "bug-reports"));
  const store = memoryStore(
    opts.session === null
      ? undefined
      : (opts.session ?? { cloud_url: cloud.url, access_token: "token-ada" }),
  );
  const clock = opts.clock ?? { t: Date.parse("2026-11-08T12:00:00Z") };
  const sender = makeBugReportSender({ outbox, store, now: () => clock.t, random: () => 0.5 });
  const enqueue = (opts2: { logs?: boolean; screenshot?: boolean; message?: string } = {}) => {
    const prepared = {
      ...prepareReport(
        {
          surface: "chat",
          error: { name: "Error", message: opts2.message ?? "boom" },
          screenshot: new Uint8Array([1, 2, 3]),
        },
        [],
        env,
        clock.t,
      ),
    };
    const withExcerpt = {
      ...prepared,
      excerpt: {
        plain: { text: "x", counts: {}, rules: [] },
        withCode: { text: "x", counts: {}, rules: [] },
      },
    };
    const parts = finalizeReport(withExcerpt, {
      title: "t",
      summary: "s",
      include: {
        logs: opts2.logs ?? true,
        screenshot: opts2.screenshot ?? true,
        threadExcerpt: opts2.logs ?? true,
        code: false,
      },
    });
    return outbox.enqueue(parts);
  };
  return { outbox, store, clock, sender, enqueue };
}

describe("secureCloudUrl", () => {
  it("allows HTTPS and this computer only", () => {
    expect(secureCloudUrl("https://app.caveman.so")).toBe(true);
    expect(secureCloudUrl("http://127.0.0.1:8080")).toBe(true);
    expect(secureCloudUrl("http://localhost:3000")).toBe(true);
    expect(secureCloudUrl("http://app.caveman.so")).toBe(false);
    expect(secureCloudUrl("http://10.0.0.5")).toBe(false);
    expect(secureCloudUrl("not a url")).toBe(false);
  });
});

describe("backoffMs", () => {
  it("doubles from 30 s to an hour, with jitter", () => {
    expect(backoffMs(1, () => 0.5)).toBe(MIN_BACKOFF_MS);
    expect(backoffMs(2, () => 0.5)).toBe(2 * MIN_BACKOFF_MS);
    expect(backoffMs(30, () => 0.5)).toBe(MAX_BACKOFF_MS);
    expect(backoffMs(1, () => 0)).toBe(0.8 * MIN_BACKOFF_MS);
  });
});

describe("makeBugReportSender", () => {
  it("sends the report part first, then logs and screenshot, and keeps only the record after", async () => {
    const { sender, enqueue, outbox } = setup();
    const record = enqueue();
    const sent = await sender.attempt(record.reportId);
    expect(sent).toMatchObject({ state: "sent", serverStatus: "received", attempts: 1 });
    const stored = cloud.reports.get(record.reportId)!;
    expect(stored.order).toEqual(["report", "logs", "screenshot"]);
    expect(stored.report.reportId).toBe(record.reportId);
    expect(cloud.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/api/v1/code/bug-reports",
      status: 201,
    });
    expect(outbox.parts(record.reportId)).toBeUndefined();
  });

  it("sends a report without attachments as the report part alone", async () => {
    const { sender, enqueue } = setup();
    const record = enqueue({ logs: false, screenshot: false });
    await sender.attempt(record.reportId);
    expect(cloud.reports.get(record.reportId)!.order).toEqual(["report"]);
  });

  it("queues while offline and sends once back, with backoff between", async () => {
    const { sender, enqueue, clock, outbox } = setup();
    const record = enqueue();
    cloud.offline = true;
    const first = await sender.attempt(record.reportId);
    expect(first).toMatchObject({ state: "queued", attempts: 1 });
    expect(Date.parse(first!.nextAttemptAt!) - clock.t).toBe(MIN_BACKOFF_MS);
    // Not due yet: nothing is tried.
    cloud.offline = false;
    await sender.sendDue();
    expect(outbox.get(record.reportId)!.state).toBe("queued");
    clock.t += MIN_BACKOFF_MS;
    await sender.sendDue();
    expect(outbox.get(record.reportId)).toMatchObject({ state: "sent" });
    expect(cloud.reports.has(record.reportId)).toBe(true);
  });

  it("retries a server error and a rate limit, honouring Retry-After", async () => {
    const { sender, enqueue, clock } = setup();
    const record = enqueue();
    cloud.failNext.push(503);
    expect(await sender.attempt(record.reportId)).toMatchObject({ state: "queued", attempts: 1 });
    cloud.dailyLimit = 0;
    const limited = await sender.attempt(record.reportId);
    expect(limited).toMatchObject({ state: "queued", attempts: 2 });
    expect(Date.parse(limited!.nextAttemptAt!) - clock.t).toBe(3_600_000);
  });

  it("stops for good on 413 and on a refusal, saying why", async () => {
    const { sender, enqueue } = setup();
    const a = enqueue();
    cloud.failNext.push(413);
    expect(await sender.attempt(a.reportId)).toMatchObject({ state: "failed" });
    const b = enqueue({ message: "other" });
    cloud.failNext.push(400);
    const refused = await sender.attempt(b.reportId);
    expect(refused).toMatchObject({ state: "failed" });
    expect(refused!.lastError).toContain("refused");
  });

  it("waits for a sign-in without spending attempts", async () => {
    const { sender, enqueue, store, clock } = setup({ session: null });
    const record = enqueue();
    const waiting = await sender.attempt(record.reportId);
    expect(waiting).toMatchObject({
      state: "queued",
      attempts: 0,
      lastError: "Sign in to Caveman to send it.",
    });
    expect(Date.parse(waiting!.nextAttemptAt!) - clock.t).toBe(SIGNED_OUT_WAIT_MS);
    store.session = { cloud_url: cloud.url, access_token: "token-ada" };
    clock.t += SIGNED_OUT_WAIT_MS;
    await sender.sendDue();
    expect(cloud.reports.has(record.reportId)).toBe(true);
  });

  it("treats a sign-in Cloud no longer takes as signed out, and keeps the report", async () => {
    const { sender, enqueue, store } = setup({
      session: { cloud_url: cloud.url, access_token: "revoked" },
    });
    const record = enqueue();
    expect(await sender.attempt(record.reportId)).toMatchObject({
      state: "queued",
      lastError: "Sign in to Caveman to send it.",
    });
    expect(store.session).toBeUndefined();
  });

  it("never sends to a Cloud that is not on HTTPS", async () => {
    const { sender, enqueue } = setup({
      session: { cloud_url: "http://cloud.example.com", access_token: "token-ada" },
    });
    const record = enqueue();
    const refused = await sender.attempt(record.reportId);
    expect(refused).toMatchObject({ state: "failed" });
    expect(refused!.lastError).toContain("HTTPS");
    expect(cloud.requests).toEqual([]);
  });

  it("gives up after a week of trying", async () => {
    const { sender, enqueue, clock } = setup();
    const record = enqueue();
    cloud.offline = true;
    clock.t += GIVE_UP_AFTER_MS + 1;
    expect(await sender.attempt(record.reportId)).toMatchObject({ state: "failed" });
  });

  it("puts a report left mid-send by a crash back in the queue", async () => {
    const { sender, enqueue, outbox } = setup();
    const record = enqueue();
    outbox.update(record.reportId, { state: "sending" });
    sender.recover();
    expect(outbox.get(record.reportId)!.state).toBe("queued");
  });

  it("refreshes a sent report's status and deletes it from Cloud and this computer", async () => {
    const { sender, enqueue, outbox } = setup();
    const record = enqueue();
    await sender.attempt(record.reportId);
    const stored = cloud.reports.get(record.reportId)!;
    stored.status = "fixed";
    stored.fixedInVersion = "1.0.1";
    expect(await sender.refresh(record.reportId)).toMatchObject({
      serverStatus: "fixed",
      fixedInVersion: "1.0.1",
    });
    await sender.remove(record.reportId);
    expect(cloud.reports.has(record.reportId)).toBe(false);
    expect(outbox.get(record.reportId)).toBeUndefined();
    expect(
      cloud.requests.map(
        (r) => `${r.method} ${r.path.replace(record.reportId, ":id")} ${r.status}`,
      ),
    ).toEqual([
      "POST /api/v1/code/bug-reports 201",
      "GET /api/v1/code/bug-reports/:id 200",
      "DELETE /api/v1/code/bug-reports/:id 204",
    ]);
  });

  it("deletes a report not sent yet without calling Cloud", async () => {
    const { sender, enqueue, outbox } = setup({ session: null });
    const record = enqueue();
    await sender.remove(record.reportId);
    expect(outbox.get(record.reportId)).toBeUndefined();
    expect(cloud.requests).toEqual([]);
  });

  it("sends one report once when attempts overlap", async () => {
    const { sender, enqueue } = setup();
    const record = enqueue();
    await Promise.all([
      sender.attempt(record.reportId),
      sender.attempt(record.reportId),
      sender.sendDue(),
    ]);
    expect(cloud.requests.filter((r) => r.method === "POST")).toHaveLength(1);
  });
});

describe("a Cloud whose report routes are not deployed yet (404)", () => {
  it("keeps the report, says so plainly, looks again a day later and sends once the route is there", async () => {
    const { sender, enqueue, clock, outbox } = setup();
    cloud.deployed = false;
    const record = enqueue();
    const waiting = await sender.attempt(record.reportId);
    expect(waiting).toMatchObject({
      state: "queued",
      attempts: 1,
      lastError: BUG_REPORTS_UNAVAILABLE,
    });
    expect(Date.parse(waiting!.nextAttemptAt!) - clock.t).toBe(UNAVAILABLE_WAIT_MS);
    // Saved here, parts and all.
    expect(outbox.parts(record.reportId)?.logs).toBeDefined();
    // Not due before the day is up: nothing is tried.
    clock.t += UNAVAILABLE_WAIT_MS - 1;
    await sender.sendDue();
    expect(cloud.requests.filter((r) => r.method === "POST")).toHaveLength(1);
    cloud.deployed = true;
    clock.t += 1;
    await sender.sendDue();
    expect(outbox.get(record.reportId)).toMatchObject({ state: "sent" });
    expect(cloud.reports.has(record.reportId)).toBe(true);
  });

  it("stops after a week, still saved and still saying why", async () => {
    const { sender, enqueue, clock, outbox } = setup();
    cloud.deployed = false;
    const record = enqueue();
    for (let day = 0; day <= 8; day++) {
      await sender.sendDue();
      clock.t += UNAVAILABLE_WAIT_MS;
    }
    expect(outbox.get(record.reportId)).toMatchObject({
      state: "failed",
      lastError: `Not sent after a week of trying: ${BUG_REPORTS_UNAVAILABLE}`,
    });
    expect(cloud.requests.filter((r) => r.method === "POST").length).toBeLessThanOrEqual(9);
    expect(outbox.parts(record.reportId)?.logs).toBeDefined();
  });
});
