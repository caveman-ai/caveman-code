// The preview's promise: what it shows is exactly what Send sends. These run the
// real pipeline (prepareReport, preparedView, finalizeReport from
// @caveman-app/shared) and hold the page's model to it.
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";

import type { BugReportPrepared } from "@caveman-app/session-protocol";
import {
  finalizeReport,
  prepareReport,
  type ReportEnvironment,
} from "@caveman-app/bug-report/node";
import { editsOf, preparedView } from "@caveman-app/shared/bugReportWire";

import {
  desktopBackend,
  excerptSent,
  filesSent,
  initialInclude,
  removedLine,
  reportedError,
  reportPart,
  REPORT_EVENT,
  reportProblem,
  runtimeBackend,
  statusLine,
  threadExcerpt,
  typed,
  type Include,
} from "./bug-report.ts";
import type { TranscriptItem } from "./transcript-model.ts";

const env: ReportEnvironment = {
  appVersion: "1.4.0",
  buildChannel: "stable",
  platform: "darwin",
  osVersion: "25",
  arch: "arm64",
  homeDir: "/Users/ada",
  userName: "ada",
};

function prepared() {
  const dir = mkdtempSync(join(tmpdir(), "web-report-"));
  const at = new Date().toISOString();
  const log = join(dir, "desktop.log");
  const events = join(dir, "events.log");
  writeFileSync(log, `${at} runtime: failed for ada@x.io with Bearer abc123def456ghi`);
  writeFileSync(events, `${at} provider: \`\`\`\nsecret code\n\`\`\``);
  for (const f of [log, events]) utimesSync(f, Date.now() / 1000, Date.now() / 1000);
  const report = prepareReport(
    {
      surface: "chat",
      error: { name: "TypeError", message: "boom" },
      context: { providerId: "codex", threadId: "t1" },
      threadExcerpt: "person: hi\n```\nconst x = 1\n```",
      screenshot: new Uint8Array([1, 2, 3]),
    },
    [
      { name: "desktop.log", path: log, code: false },
      { name: "provider-events.log", path: events, code: true },
    ],
    env,
  );
  // Through JSON, as the wire carries it.
  return { report, view: JSON.parse(JSON.stringify(preparedView(report))) as BugReportPrepared };
}

const tarNames = (gz: Buffer) => {
  const tar = gunzipSync(gz);
  const names: string[] = [];
  for (let at = 0; at + 512 <= tar.length;) {
    const name = tar
      .subarray(at, at + 100)
      .toString("utf8")
      .replace(/\0.*$/s, "");
    if (!name) break;
    names.push(name);
    at +=
      512 + Math.ceil(parseInt(tar.subarray(at + 124, at + 136).toString("ascii"), 8) / 512) * 512;
  }
  return names;
};

describe("the preview shows exactly what Send sends", () => {
  const draft = {
    title: "  Chat   crashed  ",
    summary: ("What happened\nIt broke. Key sk-" + "ant-api03-zzzzzzzzzzzzzzzzzzzz"),
    note: "me: ada@x.io",
  };
  const cases: ReadonlyArray<Include> = [
    { logs: true, screenshot: false, thread_excerpt: false, code: false },
    { logs: true, screenshot: true, thread_excerpt: true, code: false },
    { logs: true, screenshot: true, thread_excerpt: true, code: true },
    { logs: false, screenshot: false, thread_excerpt: true, code: false },
    { logs: false, screenshot: false, thread_excerpt: false, code: false },
  ];
  it.each(cases)("with %o", (include) => {
    const { report, view } = prepared();
    const sent = finalizeReport(report, editsOf({ ...draft, include }));
    const { redaction: _shownRedaction, ...shown } = reportPart(view, draft, include);
    const { redaction, ...actual } = sent.payload;
    expect(shown).toEqual(actual);
    expect(redaction.version).toBe(view.redaction.version);
    // The files and excerpt the preview lists are the logs part's entries.
    const expected = [
      ...filesSent(view, include).map((f) => `logs/${f.name}`),
      ...(excerptSent(view, include) !== undefined ? ["thread-excerpt.txt"] : []),
    ];
    expect(sent.logs ? tarNames(sent.logs) : []).toEqual(expected);
    expect(sent.screenshot !== undefined).toBe(include.screenshot);
  });

  it("starts with only the logs on", () => {
    const { view } = prepared();
    expect(initialInclude(view)).toEqual({
      logs: true,
      screenshot: false,
      thread_excerpt: false,
      code: false,
    });
    expect(initialInclude({ files: [] }).logs).toBe(false);
  });

  it("keeps code out of the excerpt unless code is on", () => {
    const { view } = prepared();
    expect(
      excerptSent(view, { logs: true, screenshot: false, thread_excerpt: true, code: false }),
    ).not.toContain("const x");
    expect(
      excerptSent(view, { logs: true, screenshot: false, thread_excerpt: true, code: true }),
    ).toContain("const x");
    expect(
      excerptSent(view, { logs: true, screenshot: false, thread_excerpt: false, code: true }),
    ).toBeUndefined();
  });

  it("warns when the person types a secret", () => {
    expect(
      typed(("my key is gh" + "p_abcdefghijklmnopqrstuvwxyz0123456789"), { code: false }),
    ).toMatchObject({ removed: 1 });
    expect(typed("it crashed twice", { code: false }).removed).toBe(0);
  });
});

describe("removedLine", () => {
  it("says what the rules removed, grouped", () => {
    expect(removedLine({ email: 2, bearer: 1, openai_key: 1, home_path: 14 })).toBe(
      "Removed 2 emails, 2 keys, tokens or passwords and your name in 14 paths.",
    );
    expect(removedLine({})).toBeNull();
  });
});

describe("threadExcerpt", () => {
  const items = [
    { kind: "user", id: "1", text: "fix the build", at: "", delivery: "message" },
    { kind: "tool", id: "2" },
    { kind: "reasoning", id: "3", text: "secret thoughts", streaming: false },
    { kind: "assistant", id: "4", text: "x".repeat(3000), streaming: false, at: "" },
    { kind: "notice", id: "5", tone: "error", text: "The engine stopped: 500" },
    { kind: "notice", id: "6", tone: "info", text: "model switched" },
  ] as unknown as ReadonlyArray<TranscriptItem>;

  it("keeps messages, answers and errors, never tools or reasoning, newest last and bounded", () => {
    const text = threadExcerpt(items);
    expect(text.startsWith("person: fix the build")).toBe(true);
    expect(text.endsWith("error: The engine stopped: 500")).toBe(true);
    expect(text).not.toContain("secret thoughts");
    expect(text).not.toContain("model switched");
    expect(text).toContain("[…]");
    expect(threadExcerpt(items, 100).length).toBeLessThanOrEqual(100);
  });
});

describe("backends and plumbing", () => {
  it("calls the runtime's methods with the request and the person's edits", async () => {
    const call = vi.fn(async (method: string) => ({ method }));
    const backend = runtimeBackend({ call } as never);
    await backend.prepare(
      { surface: "chat", error: { message: "x" }, threadId: "t1", threadExcerpt: "e" },
      "AAAA",
    );
    expect(call).toHaveBeenLastCalledWith("bug_report.prepare", {
      surface: "chat",
      error: { message: "x" },
      thread_id: "t1",
      thread_excerpt: "e",
      screenshot_png_base64: "AAAA",
    });
    await backend.send(
      "r1",
      { title: "t", summary: "s", note: " " },
      { logs: true, screenshot: false, thread_excerpt: false, code: false },
    );
    expect(call).toHaveBeenLastCalledWith(
      "bug_report.send",
      expect.objectContaining({
        report_id: "r1",
        title: "t",
        summary: "s",
        include: { logs: true, screenshot: false, thread_excerpt: false, code: false },
      }),
    );
    expect(call.mock.calls.at(-1)![1 as never]).not.toHaveProperty("note");
  });

  it("queues through the desktop when the runtime is down, with no model to describe it", async () => {
    const bridge = {
      screenshot: vi.fn(),
      prepare: vi.fn(async () => ({}) as BugReportPrepared),
      queue: vi.fn(async () => ({}) as never),
      done: vi.fn(),
    };
    const backend = desktopBackend(bridge);
    expect(backend.describe).toBeUndefined();
    await backend.send(
      "r1",
      { title: "t", summary: "s", note: "n" },
      { logs: true, screenshot: false, thread_excerpt: false, code: false },
    );
    expect(bridge.queue).toHaveBeenCalledWith(
      expect.objectContaining({ report_id: "r1", note: "n" }),
    );
  });

  it("opens the preview by event and sends nothing", () => {
    const target = new EventTarget();
    vi.stubGlobal("window", target);
    const seen: unknown[] = [];
    target.addEventListener(REPORT_EVENT, (e) => seen.push((e as CustomEvent).detail));
    reportProblem({ surface: "runtime", error: { message: "gone" } });
    expect(seen).toEqual([{ surface: "runtime", error: { message: "gone" } }]);
    vi.unstubAllGlobals();
  });

  it("reads any thrown value as an error", () => {
    expect(reportedError(new TypeError("bad"))).toMatchObject({
      name: "TypeError",
      message: "bad",
    });
    expect(reportedError("plain")).toEqual({ message: "plain" });
    expect(reportedError({ code: 1 })).toEqual({ message: '{"code":1}' });
  });

  it("says where a report stands", () => {
    expect(statusLine({ state: "sent", server_status: "fixed", fixed_in_version: "1.5.0" })).toBe(
      "Fixed in 1.5.0",
    );
    expect(statusLine({ state: "sent", server_status: "received", duplicate_of: "x" })).toBe(
      "Sent: others reported this too",
    );
    expect(statusLine({ state: "queued", last_error: "Couldn't reach Caveman." })).toBe(
      "Couldn't reach Caveman.",
    );
    expect(statusLine({ state: "failed" })).toBe("Not sent");
  });
});
