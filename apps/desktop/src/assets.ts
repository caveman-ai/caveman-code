// ), apps/desktop/src/electron/ElectronProtocol.ts @ ab3a3cd1.
// The window loads the web client from disk through a privileged custom
// scheme (caveman-code://app/), so it gets a stable secure origin, its own
// localStorage and a Content-Security-Policy header. Dropped from T3: the
// dev-server proxy, Clerk and Cloudflare Turnstile origins.
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

export const APP_SCHEME = "caveman-code";
export const APP_HOST = "app";
export const APP_URL = `${APP_SCHEME}://${APP_HOST}/`;

/** True only for our own pages; the IPC bridge and permissions check this. */
export const isOwnFrame = (url: string | undefined): boolean => url?.startsWith(APP_URL) ?? false;

/** A media request for the microphone and nothing else (a call with the Chief, or talking to type): never the camera or the screen. */
export const micOnly = (details: object): boolean => {
  const types: ReadonlyArray<unknown> = "mediaTypes" in details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  return types.length > 0 && types.every((type) => type === "audio");
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".map": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * The runtime is on 127.0.0.1. The side panel's local browser backend shows
 * dev servers and web pages in a sandboxed iframe and probes localhost ports,
 * so frames may load localhost and https pages and the page may connect to
 * localhost, until an Electron <webview> replaces the iframe.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'",
    "connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:* http://localhost:* https: wss:",
    `img-src 'self' ${APP_SCHEME}: blob: data: http: https:`,
    `media-src 'self' ${APP_SCHEME}: blob: http: https:`,
    "style-src 'self' 'unsafe-inline'",
    `font-src 'self' ${APP_SCHEME}: data:`,
    "worker-src 'self' blob:",
    `frame-src 'self' ${APP_SCHEME}://html-preview blob: http://localhost:* http://127.0.0.1:* https:`,
    "form-action 'self'",
    // Never framed: a page in the side panel's browser that navigates its
    // frame to this origin would otherwise run as the app with access to parent.
    "frame-ancestors 'none'",
  ].join("; ");
}

// Files resolve within the asset directory; any other path falls back to
// index.html, except asset-shaped misses (`/missing.js`), which 404.
export async function serveAsset(request: Request, assetDirectory: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.host !== APP_HOST) return new Response(null, { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (pathname.includes("\0")) return new Response(null, { status: 400 });
  const root = resolve(assetDirectory);
  const assetPath = resolve(root, `.${pathname}`);
  if (assetPath !== root && !assetPath.startsWith(root + sep)) return new Response(null, { status: 404 });
  let filePath = assetPath;
  const info = await stat(assetPath).catch(() => null);
  if (!info?.isFile()) {
    const wantsHtml = request.headers.get("accept")?.includes("text/html") ?? false;
    if (extname(assetPath) !== "" && !wantsHtml) return new Response(null, { status: 404 });
    filePath = join(root, "index.html");
  }
  const contents = await readFile(filePath).catch(() => null);
  if (contents === null) return new Response(null, { status: 404 });
  return new Response(request.method === "HEAD" ? null : new Uint8Array(contents), {
    headers: {
      "content-type": MIME[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-security-policy": contentSecurityPolicy(),
      "x-frame-options": "DENY",
    },
  });
}
