// One web_fetch request on the wire (docs/ "Limits", "Safety"): public addresses only, every hop checked,
// at most 5 same-host redirects (a redirect to another host comes back as a link, never followed), 10 MB decoded,
// text, HTML, JSON, XML and PDF only. Markdown is asked for first: sites behind Cloudflare's Markdown for Agents
// and many docs sites answer `Accept: text/markdown` with the page already as markdown.
import { fetch as undiciFetch } from "undici";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { MAX_URL_CHARS } from "./inline.ts";
import type { AddressGuard } from "./ssrf.ts";

export const MAX_BODY_BYTES = 10 * 1024 * 1024;
export const MAX_REDIRECTS = 5;
export const FETCH_TIMEOUT_MS = 30_000;

const ACCEPT = "text/markdown, text/html;q=0.9, application/xhtml+xml;q=0.9, text/plain;q=0.8, application/json;q=0.7, application/pdf;q=0.7, */*;q=0.1";
const USER_AGENT = `Mozilla/5.0 (compatible; CavemanCode/${RUNTIME_VERSION})`;

export type BodyKind = "markdown" | "html" | "pdf" | "json" | "xml" | "text";

export type FetchOutcome =
  | {
      readonly kind: "page";
      /** After same-host redirects. */
      readonly url: string;
      readonly bodyKind: BodyKind;
      readonly charset: string | undefined;
      readonly body: Uint8Array;
      /** Seconds, from Cache-Control; undefined when it says nothing. */
      readonly maxAge: number | undefined;
    }
  /** Another host answered with a redirect: the model gets the link, and may fetch it next. */
  | { readonly kind: "redirect"; readonly url: string; readonly location: string };

/** Why a fetch did not produce a page, in words the model can act on. */
export class FetchRefused extends Error {
  /** The page's own status, when it answered with an error. */
  readonly status: number | undefined;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "FetchRefused";
    this.status = status;
  }
}

/** The body kind a content type is read as; undefined for one web_fetch does not read (images, archives, video). */
export function bodyKindOf(contentType: string | null, url: URL): BodyKind | undefined {
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "application/pdf") return "pdf";
  if (type === "application/json" || type.endsWith("+json")) return "json";
  if (type === "application/xml" || type === "text/xml" || type.endsWith("+xml")) return "xml";
  if (type.startsWith("text/")) return /\.(md|markdown|mdx)$/i.test(url.pathname) ? "markdown" : "text";
  // No type: read it as text only when it looks like text (checked on the body).
  return type === "" ? "text" : undefined;
}

/** A content type fit to show outside the untrusted marker: `type/subtype` only, nothing else the server wrote. */
const shownType = (contentType: string | null) => {
  const type = (contentType ?? "").split(";", 1)[0]!.trim().toLowerCase();
  return type.length <= 100 && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type : undefined;
};

const charsetOf = (contentType: string | null) => /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType ?? "")?.[1];

/** The freshness Cache-Control gives, in seconds; 0 for no-store and no-cache. */
export function maxAgeOf(cacheControl: string | null): number | undefined {
  if (cacheControl === null) return undefined;
  const value = cacheControl.toLowerCase();
  if (/\b(no-store|no-cache)\b/.test(value)) return 0;
  const age = /\bs-maxage\s*=\s*(\d+)/.exec(value)?.[1] ?? /\bmax-age\s*=\s*(\d+)/.exec(value)?.[1];
  return age === undefined ? undefined : Number(age);
}

const sameHost = (a: URL, b: URL) => a.hostname.toLowerCase() === b.hostname.toLowerCase();

/** The body, decoded by undici and stopped at MAX_BODY_BYTES. */
export async function readCapped(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new FetchRefused(`The page is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
  }
  if (response.body === null) return new Uint8Array();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    size += chunk.byteLength;
    if (size > MAX_BODY_BYTES) {
      await response.body.cancel().catch(() => undefined);
      throw new FetchRefused(`The page is larger than ${MAX_BODY_BYTES / 1024 / 1024} MB.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** Fetches `start` through `guard`. Fails with FetchRefused (or the guard's BlockedAddressError) with a reason. */
export async function fetchPublic(
  start: URL,
  guard: AddressGuard,
  signal: AbortSignal,
  fetchImpl: typeof undiciFetch = undiciFetch,
): Promise<FetchOutcome> {
  let url = start;
  for (let hop = 0; ; hop++) {
    await guard.check(url.hostname);
    const response = await fetchImpl(url, {
      redirect: "manual",
      dispatcher: guard.dispatcher,
      signal,
      headers: { accept: ACCEPT, "user-agent": USER_AGENT, "accept-language": "en" },
    }).catch((cause: Error) => {
      if (signal.aborted) throw new FetchRefused(`The page did not answer within ${FETCH_TIMEOUT_MS / 1000} s.`);
      // The guard refusing at connect time surfaces as the fetch's cause.
      const blocked = (cause as { cause?: unknown }).cause;
      if (blocked instanceof Error && blocked.name === "BlockedAddressError") throw blocked;
      throw new FetchRefused(`Could not reach ${url.hostname}: ${(blocked as Error | undefined)?.message ?? cause.message}`);
    });
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location !== null) {
      await response.body?.cancel().catch(() => undefined);
      let next: URL;
      try {
        next = new URL(location, url);
      } catch {
        throw new FetchRefused(`${url.hostname} redirected to an address that is not a URL.`);
      }
      if (next.protocol !== "http:" && next.protocol !== "https:") throw new FetchRefused(`${url.hostname} redirected to a ${next.protocol} address.`);
      next.hash = "";
      if (next.href.length > MAX_URL_CHARS) throw new FetchRefused(`${url.hostname} redirected to a URL longer than ${MAX_URL_CHARS.toLocaleString("en-US")} characters.`);
      if (!sameHost(next, url)) return { kind: "redirect", url: url.href, location: next.href };
      if (hop + 1 > MAX_REDIRECTS) throw new FetchRefused(`More than ${MAX_REDIRECTS} redirects.`);
      url = next;
      continue;
    }
    // The status alone: a reason phrase is the server's text, and only the untrusted marker carries that.
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new FetchRefused(`The page answered ${response.status}.`, response.status);
    }
    const contentType = response.headers.get("content-type");
    const bodyKind = bodyKindOf(contentType, url);
    if (bodyKind === undefined) {
      await response.body?.cancel().catch(() => undefined);
      const type = shownType(contentType);
      throw new FetchRefused(`${type === undefined ? "The page's type is not one web_fetch reads" : `The page is ${type}`}: web_fetch reads text, HTML, JSON, XML and PDF.`);
    }
    const body = await readCapped(response as unknown as Response);
    // A body with no type is read only when it looks like text.
    if (contentType === null && body.subarray(0, 4096).includes(0)) throw new FetchRefused("The page is not text and says no type.");
    return { kind: "page", url: url.href, bodyKind, charset: charsetOf(contentType), body, maxAge: maxAgeOf(response.headers.get("cache-control")) };
  }
}
