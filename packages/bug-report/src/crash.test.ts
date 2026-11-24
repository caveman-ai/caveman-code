import { describe, expect, it } from "vitest";

import { scrubCrashEvent } from "./crash.ts";

const ctx = { homeDir: "/Users/ada", userName: "ada" };

const event = {
  event_id: "0123456789abcdef0123456789abcdef",
  timestamp: 1_763_300_000,
  release: "caveman-code@0.1.6",
  environment: "stable",
  platform: "node",
  level: "fatal",
  server_name: "Adas-MacBook-Pro",
  user: {
    id: "6f1c2b8e-4c1a-4f7e-9d2a-0b1c2d3e4f50",
    email: "ada@example.com",
    ip_address: "10.0.0.2",
  },
  request: { url: "file:///Users/ada/app/index.html", headers: { "User-Agent": "x" } },
  modules: { effect: "4.1.2" },
  tags: { process: "main", where: "/Users/ada/work/secret-project" },
  extra: { env: ("OPENAI_API_KEY=sk-" + "proj-AbCdEfGhIjKlMnOpQrStUvWx0123456789") },
  debug_meta: {
    images: [
      {
        type: "sourcemap",
        code_file: "app:///main.cjs",
        debug_id: "3c4d0a1e-0000-4000-8000-000000000001",
      },
    ],
  },
  exception: {
    values: [
      {
        type: "Error",
        value:
          "ENOENT: no such file or directory, open '/Users/ada/work/secret-project/.env' (ada@example.com, Bearer abcdef1234567890)",
        stacktrace: {
          frames: [
            {
              filename:
                "/Users/ada/Applications/Caveman Code.app/Contents/Resources/app.asar/dist-electron/main.cjs",
              function: "readConfig",
              lineno: 10,
              colno: 4,
              vars: { prompt: "my secret prompt" },
              pre_context: ["const a = 1;"],
              context_line: "throw new Error(x);",
              post_context: ["}"],
            },
          ],
        },
      },
    ],
  },
  breadcrumbs: [
    { category: "electron", message: "app.ready" },
    { category: "console", message: "the person's prompt was printed here" },
    { category: "ui.click", message: "button[aria-label=\"Delete chat 'secret project'\"]" },
    { category: "navigation", data: { from: "#/w/1", to: "#/w/2?token=abcdef123456" } },
    { category: "fetch", data: { url: "http://127.0.0.1:3773/api?token=abc" } },
  ],
  contexts: { os: { name: "macOS", version: "26.1" }, app: { app_name: "Caveman Code" } },
};

describe("scrubCrashEvent", () => {
  const out = scrubCrashEvent(event, ctx) as typeof event & Record<string, unknown>;
  const text = JSON.stringify(out);

  it("redacts the error's message with the problem report rules", () => {
    const value = out.exception.values[0]!.value;
    expect(value).toContain("~/work/secret-project/.env");
    expect(value).toContain("[REDACTED:email]");
    expect(value).toContain("Bearer [REDACTED:bearer]");
    expect(text).not.toContain("ada@example.com");
    expect(text).not.toContain("sk-proj-");
  });

  it("keeps where it happened, without local variables or source lines", () => {
    const frame = out.exception.values[0]!.stacktrace.frames[0]!;
    expect(frame).toEqual({
      filename:
        "~/Applications/Caveman Code.app/Contents/Resources/app.asar/dist-electron/main.cjs",
      function: "readConfig",
      lineno: 10,
      colno: 4,
    });
    expect(text).not.toContain("my secret prompt");
  });

  it("drops the request, the machine's name and installed modules, and keeps only the anonymous id of the user", () => {
    expect(out.request).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(out.modules).toBeUndefined();
    expect(out.user).toEqual({ id: "6f1c2b8e-4c1a-4f7e-9d2a-0b1c2d3e4f50" });
    expect(scrubCrashEvent({ user: { id: "ada" } })).toEqual({});
  });

  it("keeps lifecycle and navigation breadcrumbs only, redacted", () => {
    expect(out.breadcrumbs).toEqual([
      { category: "electron", message: "app.ready" },
      {
        category: "navigation",
        data: { from: "#/w/1", to: "#/w/2?token=[REDACTED:secret_query]" },
      },
    ]);
  });

  it("leaves identifiers Sentry matches on as they are", () => {
    for (const key of [
      "event_id",
      "timestamp",
      "release",
      "environment",
      "platform",
      "level",
      "debug_meta",
    ] as const)
      expect(out[key]).toEqual(event[key]);
    expect(out.tags).toEqual({ process: "main", where: "~/work/secret-project" });
    expect(out.contexts).toEqual(event.contexts);
  });

  it("is idempotent", () => {
    expect(scrubCrashEvent(out, ctx)).toEqual(out);
  });

  it("cuts what nests too deep rather than walking it", () => {
    let deep: Record<string, unknown> = { leaf: "x" };
    for (let i = 0; i < 20; i++) deep = { next: deep };
    expect(JSON.stringify(scrubCrashEvent({ extra: deep }))).toContain("[cut: too deep]");
  });
});
