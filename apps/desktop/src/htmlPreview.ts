// Separate response origin for untrusted HTML. Blob/srcDoc inherit the app's
// script-src and therefore cannot run inline HTML scripts in packaged desktop.
import { randomUUID } from "node:crypto";
import { APP_SCHEME } from "./assets.ts";

export const HTML_PREVIEW_HOST = "html-preview";
export const HTML_PREVIEW_ORIGIN = `${APP_SCHEME}://${HTML_PREVIEW_HOST}`;
export const HTML_PREVIEW_CSP = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; media-src data: blob: https:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts allow-downloads; frame-ancestors caveman-code://app";
const MAX_PAGE = 16 * 1024 * 1024 + 128 * 1024; // reader cap plus the bounded preview bootstrap
const MAX_STORED = 64 * 1024 * 1024;
const TTL = 60 * 60 * 1000;

export class HtmlPreviews {
  private pages = new Map<string, { owner: number; html: string; bytes: number; expires: number }>();
  private bytes = 0;
  private readonly now: () => number;
  constructor(now: () => number = Date.now) { this.now = now; }
  create(owner: number, html: unknown): string | null {
    if (typeof html !== "string") return null;
    const bytes = Buffer.byteLength(html);
    if (bytes > MAX_PAGE) return null;
    for (const [url, page] of this.pages) if (page.expires <= this.now()) this.remove(url);
    while (this.pages.size >= 16 || this.bytes + bytes > MAX_STORED) this.remove(this.pages.keys().next().value!);
    const url = `${HTML_PREVIEW_ORIGIN}/${randomUUID()}`;
    this.pages.set(url, { owner, html, bytes, expires: this.now() + TTL });
    this.bytes += bytes;
    return url;
  }
  release(owner: number, url: unknown): void {
    if (typeof url === "string" && this.pages.get(url)?.owner === owner) this.remove(url);
  }
  clearOwner(owner: number): void {
    for (const [url, page] of this.pages) if (page.owner === owner) this.remove(url);
  }
  serve(request: Request): Response {
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    // A page's own fragment (an HTML render's theme) is never part of its address.
    const url = request.url.split("#", 1)[0]!;
    const page = this.pages.get(url);
    if (!page || page.expires <= this.now()) { this.remove(url); return new Response(null, { status: 404 }); }
    return new Response(request.method === "HEAD" ? null : page.html, { headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": HTML_PREVIEW_CSP,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    } });
  }
  private remove(url: string): void {
    const page = this.pages.get(url);
    if (page) { this.bytes -= page.bytes; this.pages.delete(url); }
  }
}
