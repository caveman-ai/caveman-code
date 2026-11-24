import { expect, test } from "vitest";
import { contentSecurityPolicy, isOwnFrame } from "../src/assets.ts";
import { HtmlPreviews, HTML_PREVIEW_CSP, HTML_PREVIEW_ORIGIN } from "../src/htmlPreview.ts";

test("HTML is an independently sandboxed response, never an app/IPC origin", async () => {
  const store = new HtmlPreviews();
  const html = '<!doctype html><script>document.body.dataset.ready="yes"</script>';
  const url = store.create(1, html)!;
  expect(url.startsWith(`${HTML_PREVIEW_ORIGIN}/`)).toBe(true);
  expect(isOwnFrame(url)).toBe(false);
  const response = store.serve(new Request(url));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(html);
  expect(response.headers.get("content-security-policy")).toBe(HTML_PREVIEW_CSP);
  expect(HTML_PREVIEW_CSP).toContain("sandbox allow-scripts allow-downloads");
  expect(HTML_PREVIEW_CSP).not.toContain("allow-same-origin");
  expect(HTML_PREVIEW_CSP).toContain("connect-src 'none'");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(contentSecurityPolicy()).toContain(HTML_PREVIEW_ORIGIN);
  // The authenticated app's script policy has not been weakened.
  expect(contentSecurityPolicy().split(";").find((d) => d.trim().startsWith("script-src"))).toBe(" script-src 'self' 'wasm-unsafe-eval'");
  expect(await store.serve(new Request(url, { method: "HEAD" })).text()).toBe("");
  expect(store.serve(new Request(url, { method: "POST" })).status).toBe(405);
  expect(store.serve(new Request(`${url}/anything`)).status).toBe(404);
  // A page's fragment (an HTML render's theme) addresses the same page.
  expect(await store.serve(new Request(`${url}#t3-theme=%7B%7D`)).text()).toBe(html);
  store.release(2, url);
  expect(store.serve(new Request(url)).status).toBe(200);
  store.release(1, url);
  expect(store.serve(new Request(url)).status).toBe(404);
});

test("preview capabilities expire, close with their owner, and have finite count/byte budgets", () => {
  let now = 0;
  const store = new HtmlPreviews(() => now);
  const expired = store.create(1, "a")!;
  now = 3_600_001;
  expect(store.serve(new Request(expired)).status).toBe(404);
  const closed = store.create(1, "b")!;
  const other = store.create(2, "c")!;
  store.clearOwner(1);
  expect(store.serve(new Request(closed)).status).toBe(404);
  expect(store.serve(new Request(other)).status).toBe(200);
  for (let i = 0; i < 16; i++) store.create(2, "next");
  expect(store.serve(new Request(other)).status).toBe(404);
  const big = "x".repeat(8 * 1024 * 1024);
  const first = store.create(3, big)!;
  for (let i = 0; i < 8; i++) store.create(3, big);
  expect(store.serve(new Request(first)).status).toBe(404);
  expect(store.create(3, big.repeat(3))).toBeNull();
  expect(store.create(3, { html: "no" })).toBeNull();
});
