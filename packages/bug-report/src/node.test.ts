import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { BUG_REPORT_LIMITS } from "./index.ts";
import {
  BugReportOutbox,
  errorSignature,
  finalizeReport,
  OUTBOX_KEEP_MS,
  prepareReport,
  readLogTail,
  ReportTooLarge,
  signatureBasis,
  tarGz,
  type ReportEnvironment,
} from "./node.ts";

const env: ReportEnvironment = {
  appVersion: "1.2.3",
  buildChannel: "stable",
  platform: "darwin",
  osVersion: "25.0",
  arch: "arm64",
  homeDir: "/Users/ada",
  userName: "ada",
};
const dir = () => mkdtempSync(join(tmpdir(), "bug-report-"));
const NOW = Date.parse("2026-11-08T12:00:00.000Z");

/** The files of a tar.gz, read back without a tar library. */
function untar(gz: Buffer): Record<string, string> {
  const tar = gunzipSync(gz);
  const out: Record<string, string> = {};
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar
      .subarray(at, at + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(
      tar
        .subarray(at + 124, at + 136)
        .toString("ascii")
        .replace(/\0.*$/s, ""),
      8,
    );
    out[name] = tar.subarray(at + 512, at + 512 + size).toString("utf8");
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("errorSignature", () => {
  const stack = (root: string, line: number) =>
    [
      "TypeError: Cannot read properties of undefined (reading 'id')",
      `    at readThread (${root}/assets/index-DkF3a9xQ.js:${line}:12)`,
      `    at async Promise.all (index 0)`,
      `    at load (${root}/assets/chunk.5f2a91c3.js:9:1)`,
      "    at node:internal/process/task_queues:95:5",
    ].join("\n");

  it("is the same across builds, computers and line numbers", () => {
    const a = errorSignature(
      { name: "TypeError", message: "x", stack: stack("/Users/ada/app", 10) },
      "chat",
    );
    const b = errorSignature(
      { name: "TypeError", message: "y", stack: stack("C:/Users/bob/app", 4410) },
      "chat",
    );
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(signatureBasis({ name: "TypeError", message: "x", stack: stack("/a", 1) }, "chat")).toBe(
      "TypeError|readthread@index.js|promise.all@index <n>|load@chunk.js",
    );
  });

  it("tells different errors apart", () => {
    expect(
      errorSignature({ name: "TypeError", message: "x", stack: stack("/a", 1) }, "chat"),
    ).not.toBe(errorSignature({ name: "RangeError", message: "x", stack: stack("/a", 1) }, "chat"));
  });

  it("uses the message without its particulars when there is no stack", () => {
    const a = errorSignature(
      {
        message:
          "Request 1234 to https://a.example/x failed for /Users/ada/p (id 0f3a9b2c-1111-2222-3333-444455556666)",
      },
      "onboarding",
    );
    const b = errorSignature(
      {
        message:
          "Request 99 to https://b.example/y failed for /home/bob/q (id 9f3a9b2c-1111-2222-3333-444455556666)",
      },
      "onboarding",
    );
    expect(a).toBe(b);
  });
});

describe("tarGz", () => {
  it("round-trips through the system's tar", () => {
    const work = dir();
    const gz = tarGz([
      { name: "logs/desktop.log", data: Buffer.from("hello\n") },
      { name: "thread-excerpt.txt", data: Buffer.from("x".repeat(1000)) },
    ]);
    writeFileSync(join(work, "a.tar.gz"), gz);
    // A relative name: GNU tar (Git for Windows') reads the "C:" of an absolute Windows path as a remote host.
    expect(
      execFileSync("tar", ["-tzf", "a.tar.gz"], { cwd: work, encoding: "utf8" })
        .trim()
        .split(/\r?\n/),
    ).toEqual(["logs/desktop.log", "thread-excerpt.txt"]);
    expect(untar(gz)["logs/desktop.log"]).toBe("hello\n");
  });
});

describe("readLogTail", () => {
  it("keeps only lines inside the time window, with untimed lines following the line before", () => {
    const work = dir();
    const file = join(work, "desktop.log");
    writeFileSync(
      file,
      [
        "2026-11-08T01:00:00.000Z runtime: old",
        "  old continuation",
        "2026-11-08T11:00:00.000Z runtime: new",
        "  new continuation",
        '{"type":"effect-span","startTimeUnixNano":"1794106800000000000"}',
      ].join("\n"),
    );
    utimesSync(file, NOW / 1000, NOW / 1000);
    expect(
      readLogTail(file, { sinceMs: NOW - BUG_REPORT_LIMITS.logWindowMs, maxBytes: 1 << 20 }),
    ).toBe("2026-11-08T11:00:00.000Z runtime: new\n  new continuation");
  });

  it("reads at most maxBytes from the end and drops the cut line", () => {
    const work = dir();
    const file = join(work, "big.log");
    writeFileSync(file, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n"));
    const tail = readLogTail(file, { sinceMs: 0, maxBytes: 100 })!;
    expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(100);
    expect(tail.split("\n")[0]).toMatch(/^line \d+$/);
    expect(tail.endsWith("line 999")).toBe(true);
  });

  it("skips a log last written before the window, and a missing one", () => {
    const work = dir();
    const file = join(work, "old.log");
    writeFileSync(file, "x");
    utimesSync(file, (NOW - 7 * 3600_000) / 1000, (NOW - 7 * 3600_000) / 1000);
    expect(
      readLogTail(file, { sinceMs: NOW - BUG_REPORT_LIMITS.logWindowMs, maxBytes: 100 }),
    ).toBeUndefined();
    expect(readLogTail(join(work, "nope.log"), { sinceMs: 0, maxBytes: 100 })).toBeUndefined();
  });
});

describe("prepareReport and finalizeReport", () => {
  const setup = () => {
    const work = dir();
    const desktop = join(work, "desktop.log");
    const events = join(work, "events.log");
    writeFileSync(
      desktop,
      `2026-11-08T11:59:00.000Z runtime: failed with Bearer abc123def456 for ada@x.io in /Users/ada/p\n\`\`\`\nconst a = 1;\n\`\`\``,
    );
    writeFileSync(events, "2026-11-08T11:59:00.000Z provider: wrote ```\nfile body\n```");
    for (const f of [desktop, events]) utimesSync(f, NOW / 1000, NOW / 1000);
    const prepared = prepareReport(
      {
        surface: "chat",
        error: {
          name: "Error",
          message: ("Turn failed: OPENAI key sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789 refused"),
          stack: "Error: x\n    at run (/Users/ada/app/run.js:1:1)",
        },
        context: { providerId: "codex", modelId: "gpt-5", threadId: "t-1" },
        threadExcerpt: "user: fix it\n```\nsecret code\n```\nassistant: done",
        screenshot: new Uint8Array([137, 80, 78, 71]),
      },
      [
        { name: "desktop.log", path: desktop, code: false },
        { name: "provider-events.log", path: events, code: true },
      ],
      env,
      NOW,
    );
    return prepared;
  };

  it("redacts everything it collects and drafts from the template", () => {
    const prepared = setup();
    expect(prepared.draft.by).toBe("template");
    expect(prepared.draft.title).toContain("[REDACTED:openai_key]");
    expect(prepared.files.map((f) => [f.name, f.code])).toEqual([
      ["desktop.log", false],
      ["provider-events.log", true],
    ]);
    expect(prepared.files[0]!.text).toBe(
      "2026-11-08T11:59:00.000Z runtime: failed with Bearer [REDACTED:bearer] for [REDACTED:email] in ~/p\n[code removed: 3 lines]",
    );
    // A code log keeps its code: it is only sent when the person opts in.
    expect(prepared.files[1]!.text).toContain("file body");
    expect(prepared.error?.stack).toContain("~/app/run.js");
  });

  it("sends only what the person turned on", () => {
    const prepared = setup();
    const off = finalizeReport(prepared, {
      title: "T",
      summary: "S",
      include: { logs: false, screenshot: false, threadExcerpt: false, code: false },
    });
    expect(off.logs).toBeUndefined();
    expect(off.screenshot).toBeUndefined();
    expect(off.payload.includes).toEqual({ logs: false, screenshot: false, threadExcerpt: false });

    const plain = finalizeReport(prepared, {
      title: "T",
      summary: "S",
      include: { logs: true, screenshot: true, threadExcerpt: true, code: false },
    });
    const files = untar(plain.logs!);
    expect(Object.keys(files)).toEqual(["logs/desktop.log", "thread-excerpt.txt"]);
    expect(files["thread-excerpt.txt"]).not.toContain("secret code");
    expect(plain.screenshot).toBeDefined();
    expect(plain.payload.redaction.rulesApplied).toContain("code_block");

    const withCode = finalizeReport(prepared, {
      title: "T",
      summary: "S",
      include: { logs: true, screenshot: false, threadExcerpt: true, code: true },
    });
    const all = untar(withCode.logs!);
    expect(Object.keys(all)).toEqual([
      "logs/desktop.log",
      "logs/provider-events.log",
      "thread-excerpt.txt",
    ]);
    expect(all["thread-excerpt.txt"]).toContain("secret code");
  });

  it("redacts what the person typed and keeps the contract's limits", () => {
    const prepared = setup();
    const { payload } = finalizeReport(prepared, {
      title: `My key gh${""}p_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789 ${"long ".repeat(50)}`,
      summary: "",
      note: "mail me at ada@x.io",
      include: { logs: false, screenshot: false, threadExcerpt: false, code: false },
    });
    expect(payload.title.length).toBeLessThanOrEqual(BUG_REPORT_LIMITS.titleChars);
    expect(payload.title).toContain("[REDACTED:github_token]");
    expect(payload.agentSummary).toBe(prepared.draft.summary);
    expect(payload.userNote).toBe("mail me at [REDACTED:email]");
    expect(payload).toMatchObject({
      appVersion: "1.2.3",
      buildChannel: "stable",
      platform: "darwin",
      arch: "arm64",
      context: { surface: "chat", providerId: "codex", modelId: "gpt-5", threadId: "t-1" },
    });
    expect(payload.redaction.version).toMatch(/^\d{4}/);
  });

  it("holds every log together under the total cap", () => {
    const work = dir();
    const sources = Array.from({ length: 8 }, (_, i) => {
      const path = join(work, `l${i}.log`);
      writeFileSync(
        path,
        Array.from(
          { length: 30_000 },
          (_, n) => `2026-11-08T11:59:00.000Z line ${n} ${"x".repeat(30)}`,
        ).join("\n"),
      );
      utimesSync(path, NOW / 1000, NOW / 1000);
      return { name: `l${i}.log`, path, code: false };
    });
    const prepared = prepareReport({ surface: "other" }, sources, env, NOW);
    const total = prepared.files.reduce((n, f) => n + Buffer.byteLength(f.text), 0);
    expect(total).toBeLessThanOrEqual(BUG_REPORT_LIMITS.logTotalBytes);
    for (const f of prepared.files)
      expect(Buffer.byteLength(f.text)).toBeLessThanOrEqual(BUG_REPORT_LIMITS.logFileTailBytes);
    // The newest lines are kept.
    expect(prepared.files[0]!.text.endsWith(`line 29999 ${"x".repeat(30)}`)).toBe(true);
  });

  it("leaves out a screenshot over 5 MB and refuses to finalize one", () => {
    const big = new Uint8Array(BUG_REPORT_LIMITS.screenshotBytes + 1);
    expect(
      prepareReport({ surface: "other", screenshot: big }, [], env, NOW).screenshot,
    ).toBeUndefined();
    const prepared = { ...prepareReport({ surface: "other" }, [], env, NOW), screenshot: big };
    expect(() =>
      finalizeReport(prepared, {
        title: "t",
        summary: "s",
        include: { logs: false, screenshot: true, threadExcerpt: false, code: false },
      }),
    ).toThrow(ReportTooLarge);
  });
});

describe("BugReportOutbox", () => {
  const payload = (reportId: string, createdAt = new Date(NOW).toISOString()) =>
    finalizeReport(
      { ...prepareReport({ surface: "runtime" }, [], env, NOW), reportId, createdAt },
      {
        title: "t",
        summary: "s",
        include: { logs: false, screenshot: false, threadExcerpt: false, code: false },
      },
    ).payload;
  const ID = "0f3a9b2c-1111-4222-8333-444455556666";

  it("enqueues once per report id and keeps the parts until sent", () => {
    const outbox = new BugReportOutbox(join(dir(), "bug-reports"));
    const first = outbox.enqueue({ payload: payload(ID), logs: Buffer.from("gz") });
    expect(first.state).toBe("queued");
    outbox.update(ID, { attempts: 2 });
    expect(outbox.enqueue({ payload: payload(ID) }).attempts).toBe(2);
    expect(outbox.parts(ID)?.logs?.toString()).toBe("gz");
    outbox.dropParts(ID);
    expect(outbox.parts(ID)).toBeUndefined();
    expect(outbox.list().map((r) => r.reportId)).toEqual([ID]);
    expect(readdirSync(outbox.dir).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("refuses ids that are not report ids", () => {
    const outbox = new BugReportOutbox(join(dir(), "bug-reports"));
    expect(() => outbox.enqueue({ payload: payload("../../etc") })).toThrow();
  });

  it("prunes records past the retention", () => {
    const outbox = new BugReportOutbox(join(dir(), "bug-reports"));
    outbox.enqueue({ payload: payload(ID, new Date(NOW - OUTBOX_KEEP_MS - 1).toISOString()) });
    outbox.prune(NOW);
    expect(outbox.list()).toEqual([]);
  });

  it("writes the report private to this user", () => {
    const outbox = new BugReportOutbox(join(dir(), "bug-reports"));
    outbox.enqueue({ payload: payload(ID) });
    expect(JSON.parse(readFileSync(join(outbox.dir, ID, "report.json"), "utf8")).reportId).toBe(ID);
    if (process.platform !== "win32")
      expect(statSync(join(outbox.dir, ID, "report.json")).mode & 0o777).toBe(0o600);
  });
});
