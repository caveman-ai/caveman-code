// The Cursor SDK loads on first use: a runtime that runs no Cursor chat (a warm Cloud computer waiting for its
// claim) never holds it.
import { execFileSync } from "node:child_process";

import { expect, test } from "vitest";

// A file URL: Windows imports no bare absolute path, and its require cache keys use backslashes.
const sdk = new URL("./sdk.ts", import.meta.url).href;

test("importing the SDK module loads no part of @cursor/sdk until it is first used", () => {
  const script = `
    import { createRequire } from "node:module";
    const { cursorSdk } = await import(${JSON.stringify(sdk)});
    const loaded = () => Object.keys(createRequire(${JSON.stringify(sdk)}).cache).some((file) => /@cursor[\\\\/]sdk/.test(file));
    const before = loaded();
    const ok = typeof cursorSdk().Cursor.me === "function";
    console.log(JSON.stringify({ before, ok, after: loaded() }));
  `;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({ before: false, ok: true, after: true });
});

test("classifying an error as an SDK error never loads the SDK", () => {
  const script = `
    import { createRequire } from "node:module";
    const { cursorSdk, isCursorSdkError } = await import(${JSON.stringify(sdk)});
    const loaded = () => Object.keys(createRequire(${JSON.stringify(sdk)}).cache).some((file) => /@cursor[\\\\/]sdk/.test(file));
    const unloaded = isCursorSdkError(new Error("load failed"), "CursorSdkError");
    const loadedByCheck = loaded();
    const { CursorSdkError } = cursorSdk();
    const sdkError = isCursorSdkError(new CursorSdkError("rejected", { status: 403 }), "CursorSdkError");
    const plainError = isCursorSdkError(new Error("plain"), "ConfigurationError");
    console.log(JSON.stringify({ unloaded, loadedByCheck, sdkError, plainError }));
  `;
  const out = execFileSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  expect(JSON.parse(out.trim().split("\n").at(-1)!)).toEqual({
    unloaded: false,
    loadedByCheck: false,
    sdkError: true,
    plainError: false,
  });
});
