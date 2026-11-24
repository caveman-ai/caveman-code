// Firecrawl's v2 scrape API (docs/ "Reading through Firecrawl"), spoken by two servers: Firecrawl
// Local on this computer (firecrawlLocal.ts), web_fetch's first reader when it is installed, and Firecrawl Cloud on
// the person's own key, asked only when Firecrawl Local is not here and the runtime's own request could not read a
// page: the site turned it away (TURNED_AWAY), or answered with HTML that holds almost no text until a browser runs
// its scripts (looksUnrendered). Either answers with markdown, which the page reader then indexes like any other. The
// page is kept out of Firecrawl's cache and index (storeInCache off), and a PDF is read to MAX_PDF_PAGES, since
// Firecrawl Cloud bills a credit a PDF page. Plain async, like providers.ts.
import { readCapped } from "./fetchPage.ts";
import { MAX_URL_CHARS } from "./inline.ts";
import type { Page } from "./pages.ts";
import { errorDetail, failureOf, WebProviderError } from "./providers.ts";

export const FIRECRAWL_LABEL = "Firecrawl";
const API = "https://api.firecrawl.dev/v2";

/** A server that answers Firecrawl's v2 API, and the bearer token it takes: Firecrawl Cloud's API key, or Firecrawl Local's own. */
export interface FirecrawlEndpoint {
  readonly api: string;
  readonly token: string;
}

/** Firecrawl Cloud, on the person's own key. */
export const firecrawlCloud = (apiKey: string): FirecrawlEndpoint => ({ api: API, token: apiKey });
/** Firecrawl's own deadline for the page, and ours for its answer. */
const SCRAPE_TIMEOUT_MS = 25_000;
export const FIRECRAWL_TIMEOUT_MS = 30_000;
const CHECK_TIMEOUT_MS = 10_000;
/** A PDF's pages Firecrawl reads: each is a credit. */
export const MAX_PDF_PAGES = 20;

/** The statuses a site turns a script away with (a bot check, a rate limit), which a browser may get past. */
export const TURNED_AWAY: ReadonlySet<number> = new Set([403, 429, 503]);

const SHELL =
  /enable javascript|javascript is (?:disabled|required)|requires javascript|turn on javascript|checking your browser|verify you are human|just a moment\.\.\./i;

/** A page's readable text: its markdown without link targets and markup. */
export const textOf = (page: Page) =>
  page.markdown
    .replace(/\]\([^)]*\)/g, "]")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[#>*_`[\]!|-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** An HTML page web_fetch's reader got almost nothing from: a shell its scripts fill, or a bot check. */
export function looksUnrendered(page: Page): boolean {
  const text = textOf(page);
  return text.length < 200 || (text.length < 2_000 && SHELL.test(text));
}

export interface FirecrawlPage {
  /** After the redirects Firecrawl followed. */
  readonly url: string;
  readonly title: string | undefined;
  readonly markdown: string;
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
/** Firecrawl's metadata values are a string or a list of them. */
const first = (value: unknown) =>
  typeof value === "string"
    ? value
    : Array.isArray(value) && typeof value[0] === "string"
      ? value[0]
      : undefined;

const httpUrl = (value: string | undefined) => {
  if (value === undefined || value.length > MAX_URL_CHARS) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
};

/** The page answered Firecrawl with an error status, or turned it away: an answer about the page, not about Firecrawl. */
export class FirecrawlPageRefused extends WebProviderError {
  constructor(status: number) {
    super("firecrawl", "invalid", `the page answered ${status}`, status);
    this.name = "FirecrawlPageRefused";
  }
}

const failed = async (response: Response) => {
  const detail = await errorDetail(response);
  // A 403 is about the page (a provider-routed site, a check), not the key: only a 401 says the key is wrong.
  const kind = response.status === 403 ? "invalid" : failureOf(response.status);
  return new WebProviderError(
    "firecrawl",
    kind,
    `${response.status}${detail ? `: ${detail}` : ""}`,
    response.status,
  );
};

/**
 * `url` read by Firecrawl at `endpoint`, as markdown. Throws a `WebProviderError` saying why it could not: its own
 * refusal, or (kind `invalid`, `status` the page's) the page answering Firecrawl with an error too, or turning it away
 * (`blocked`). Its message is Firecrawl's words, for Settings; the model is told only the kind and status (WebTools.ts).
 */
export async function runFirecrawlScrape(
  endpoint: FirecrawlEndpoint,
  url: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<FirecrawlPage> {
  const timeout = AbortSignal.timeout(FIRECRAWL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${endpoint.api}/scrape`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${endpoint.token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        storeInCache: false,
        timeout: SCRAPE_TIMEOUT_MS,
        parsers: [{ type: "pdf", mode: "fast", maxPages: MAX_PDF_PAGES }],
      }),
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
    });
  } catch (cause) {
    throw new WebProviderError(
      "firecrawl",
      "unavailable",
      timeout.aborted
        ? `no answer within ${FIRECRAWL_TIMEOUT_MS / 1000} s`
        : `could not be reached (${(cause as Error).message})`,
    );
  }
  if (!response.ok) throw await failed(response);
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(await readCapped(response)));
  } catch (cause) {
    throw new WebProviderError(
      "firecrawl",
      "unavailable",
      cause instanceof Error && cause.name === "FetchRefused"
        ? cause.message
        : "answered with something that is not JSON",
    );
  }
  const data = record(record(body).data);
  const metadata = record(data.metadata);
  const status = typeof metadata.statusCode === "number" ? metadata.statusCode : undefined;
  if (status !== undefined && status >= 400) throw new FirecrawlPageRefused(status);
  // Firecrawl Local: a site that refused this computer, and Firecrawl Cloud too when it may ask.
  if (data.blocked === true) throw new FirecrawlPageRefused(status ?? 403);
  const markdown = typeof data.markdown === "string" ? data.markdown : "";
  if (markdown.trim() === "")
    throw new WebProviderError("firecrawl", "invalid", "found no text on the page");
  const title = first(metadata.title)?.replace(/\s+/g, " ").trim();
  return { url: httpUrl(first(metadata.url)) ?? url, title: title || undefined, markdown };
}

/** Whether Firecrawl takes `apiKey`: its credit balance, which costs nothing. Throws a `WebProviderError` when not. */
export async function checkFirecrawlKey(
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const timeout = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetchImpl(`${API}/team/credit-usage`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: timeout,
    });
  } catch (cause) {
    throw new WebProviderError(
      "firecrawl",
      "unavailable",
      timeout.aborted
        ? `no answer within ${CHECK_TIMEOUT_MS / 1000} s`
        : `could not be reached (${(cause as Error).message})`,
    );
  }
  if (!response.ok) throw await failed(response);
  await response.body?.cancel().catch(() => undefined);
}
