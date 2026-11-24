import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { APP_URL, isOwnFrame, serveAsset, micOnly } from "../src/assets.ts";
import { routeFromDeepLink } from "../src/links.ts";

const root = mkdtempSync(join(tmpdir(), "caveman-desktop-assets-"));
mkdirSync(join(root, "assets"));
writeFileSync(join(root, "index.html"), "<!doctype html><title>Caveman Code</title>");
writeFileSync(join(root, "assets/app.js"), "console.log(1)");
writeFileSync(join(tmpdir(), "caveman-desktop-secret.txt"), "secret");
afterAll(() => rmSync(root, { recursive: true, force: true }));

const get = (path: string, accept = "*/*") => serveAsset(new Request(`${APP_URL}${path}`, { headers: { accept } }), root);

describe("serveAsset", () => {
  it("serves files with a type and the CSP", async () => {
    const res = await get("assets/app.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toContain("connect-src 'self' ws://127.0.0.1:*");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("content-security-policy")).toContain("frame-src 'self' caveman-code://html-preview blob: http://localhost:* http://127.0.0.1:* https:;");
    expect(await res.text()).toBe("console.log(1)");
  });
  it("falls back to index.html for routes, not for missing assets", async () => {
    expect(await (await get("", "text/html")).text()).toContain("Caveman Code");
    expect(await (await get("inbox", "text/html")).text()).toContain("Caveman Code");
    expect((await get("assets/missing.js")).status).toBe(404);
  });
  it("never leaves the asset directory", async () => {
    expect((await get("..%2Fcaveman-desktop-secret.txt")).status).toBe(404);
    expect((await get("%00")).status).toBe(400);
    const other = await serveAsset(new Request("caveman-code://evil/index.html"), root);
    expect(other.status).toBe(404);
  });
  it("refuses writes", async () => {
    expect((await serveAsset(new Request(`${APP_URL}index.html`, { method: "POST" }), root)).status).toBe(405);
  });
});

describe("routeFromDeepLink", () => {
  it("maps links to hash routes", () => {
    expect(routeFromDeepLink("caveman-code://w/abc")).toBe("/w/abc");
    expect(routeFromDeepLink("caveman-code://runs")).toBe("/runs");
    expect(routeFromDeepLink("caveman-code://app/#/settings/engines")).toBe("/settings/engines");
    expect(routeFromDeepLink("https://example.com/w/abc")).toBeNull();
    expect(routeFromDeepLink("not a url")).toBeNull();
  });
});

describe("isOwnFrame (gates the runtime bridge and permissions)", () => {
  it("accepts only pages on caveman-code://app/", () => {
    expect(isOwnFrame("caveman-code://app/")).toBe(true);
    expect(isOwnFrame("caveman-code://app/index.html#/runs")).toBe(true);
    for (const url of ["caveman-code://appx/", "caveman-code://w/123", "https://caveman-code://app/", "https://example.com/", "", undefined]) {
      expect(isOwnFrame(url)).toBe(false);
    }
  });
});

it("a call gets the microphone alone: never the camera or the screen", () => {
  expect(micOnly({ mediaTypes: ["audio"] })).toBe(true);
  expect(micOnly({ mediaTypes: ["audio", "video"] })).toBe(false);
  expect(micOnly({ mediaTypes: ["video"] })).toBe(false);
  expect(micOnly({ mediaTypes: [] })).toBe(false);
  expect(micOnly({})).toBe(false);
});
