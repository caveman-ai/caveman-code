// Test-only: a stand-in for Caveman Cloud's problem report routes, held to the
// contract both sides agreed (docs/): POST
// /api/v1/code/bug-reports (multipart, the `report` JSON part first or 400,
// logs <= 25 MB and screenshot <= 5 MB or 413, a per-account daily limit or 429,
// a repeated reportId answered as the first was, a repeated errorSignature
// flagged duplicateOf), then GET and DELETE /api/v1/code/bug-reports/{id}, each
// only for the account that sent it. A real HTTP server on 127.0.0.1.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import {
  BUG_REPORT_LIMITS,
  BUG_REPORT_ROUTE,
  type BugReportPayload,
} from "@caveman-app/bug-report";

export interface StoredReport {
  readonly account: string;
  readonly report: BugReportPayload;
  readonly logs?: Buffer | undefined;
  readonly screenshot?: Buffer | undefined;
  /** The parts in the order they arrived. */
  readonly order: ReadonlyArray<string>;
  status: "received" | "triaged" | "fixed";
  fixedInVersion?: string;
  duplicateOf?: string;
}

export interface TestBugReportCloud {
  readonly url: string;
  readonly reports: Map<string, StoredReport>;
  /** Every request, method and path, in order. */
  readonly requests: Array<{ method: string; path: string; status: number }>;
  /** Tokens and the account each one is. */
  readonly tokens: Map<string, string>;
  /** Next POSTs answer this status (once each), before anything else is checked: 500, 503, 429... */
  readonly failNext: number[];
  dailyLimit: number;
  /** Offline: every request is cut before it is answered. */
  offline: boolean;
  /** False: the report routes are not deployed, and answer 404 as any unknown route does. */
  deployed: boolean;
  close(): Promise<void>;
}

/** The parts of a multipart body, in order, each with its headers and raw bytes. */
export function parseMultipart(
  body: Buffer,
  contentType: string,
): Array<{ name: string; filename?: string; type?: string; data: Buffer }> {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) throw new Error("no boundary");
  const delimiter = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts: Array<{ name: string; filename?: string; type?: string; data: Buffer }> = [];
  let at = body.indexOf(delimiter);
  while (at !== -1) {
    const start = at + delimiter.length;
    if (body.subarray(start, start + 2).toString() === "--") break;
    const next = body.indexOf(delimiter, start);
    if (next === -1) break;
    const part = body.subarray(start + 2, next - 2);
    const split = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, split).toString("utf8");
    const disposition =
      /content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(head);
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1]?.trim();
    parts.push({
      name: disposition?.[1] ?? "",
      ...(disposition?.[2] ? { filename: disposition[2] } : {}),
      ...(type ? { type } : {}),
      data: Buffer.from(part.subarray(split + 4)),
    });
    at = next;
  }
  return parts;
}

const json = (response: http.ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

export async function startTestBugReportCloud(): Promise<TestBugReportCloud> {
  const reports = new Map<string, StoredReport>();
  const requests: TestBugReportCloud["requests"] = [];
  const tokens = new Map<string, string>([
    ["token-ada", "ada"],
    ["token-bob", "bob"],
  ]);
  const failNext: number[] = [];
  const sentToday = new Map<string, number>();
  const state = { dailyLimit: 20, offline: false, deployed: true };

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const done = (status: number, body: unknown) => {
        requests.push({ method: request.method ?? "GET", path: url.pathname, status });
        json(response, status, body);
      };
      if (state.offline) {
        requests.push({ method: request.method ?? "GET", path: url.pathname, status: 0 });
        request.socket.destroy();
        return;
      }
      if (!state.deployed || !url.pathname.startsWith(BUG_REPORT_ROUTE))
        return done(404, { error: "not_found" });
      const account = tokens.get(
        /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? "",
      );
      if (!account) return done(401, { error: "unauthorized" });
      const body = Buffer.concat(chunks);

      if (request.method === "POST" && url.pathname === BUG_REPORT_ROUTE) {
        const fail = failNext.shift();
        if (fail !== undefined) return done(fail, { error: "injected" });
        let parts;
        try {
          parts = parseMultipart(body, request.headers["content-type"] ?? "");
        } catch {
          return done(400, { error: "not multipart" });
        }
        // The contract: report first, so idempotency and limits are checked before an attachment is read.
        if (parts[0]?.name !== "report") return done(400, { error: "report_must_be_first" });
        const report = JSON.parse(parts[0].data.toString("utf8")) as BugReportPayload;
        const existing = reports.get(report.reportId);
        if (existing) {
          if (existing.account !== account) return done(409, { error: "conflict" });
          return done(201, {
            reportId: report.reportId,
            status: "received",
            ...(existing.duplicateOf ? { duplicateOf: existing.duplicateOf } : {}),
          });
        }
        const count = sentToday.get(account) ?? 0;
        if (count >= state.dailyLimit) {
          requests.push({ method: "POST", path: url.pathname, status: 429 });
          response.writeHead(429, { "content-type": "application/json", "retry-after": "3600" });
          response.end(JSON.stringify({ error: "rate_limited" }));
          return;
        }
        const logs = parts.find((p) => p.name === "logs")?.data;
        const screenshot = parts.find((p) => p.name === "screenshot")?.data;
        if (
          (logs?.byteLength ?? 0) > BUG_REPORT_LIMITS.logsGzipBytes ||
          (screenshot?.byteLength ?? 0) > BUG_REPORT_LIMITS.screenshotBytes
        )
          return done(413, { error: "too_large" });
        sentToday.set(account, count + 1);
        const first = [...reports.values()].find(
          (r) => r.report.errorSignature === report.errorSignature,
        );
        reports.set(report.reportId, {
          account,
          report,
          logs,
          screenshot,
          order: parts.map((p) => p.name),
          status: "received",
          ...(first ? { duplicateOf: first.report.reportId } : {}),
        });
        return done(201, {
          reportId: report.reportId,
          status: "received",
          ...(first ? { duplicateOf: first.report.reportId } : {}),
        });
      }

      const id = decodeURIComponent(url.pathname.slice(BUG_REPORT_ROUTE.length + 1));
      const stored = reports.get(id);
      // Another account's report reads as missing, never as forbidden.
      if (!stored || stored.account !== account) return done(404, { error: "not_found" });
      if (request.method === "GET")
        return done(200, {
          reportId: id,
          status: stored.status,
          ...(stored.fixedInVersion ? { fixedInVersion: stored.fixedInVersion } : {}),
        });
      if (request.method === "DELETE") {
        reports.delete(id);
        return done(204, {});
      }
      return done(405, { error: "method" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    reports,
    requests,
    tokens,
    failNext,
    get dailyLimit() {
      return state.dailyLimit;
    },
    set dailyLimit(n: number) {
      state.dailyLimit = n;
    },
    get deployed() {
      return state.deployed;
    },
    set deployed(on: boolean) {
      state.deployed = on;
    },
    get offline() {
      return state.offline;
    },
    set offline(on: boolean) {
      state.offline = on;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
