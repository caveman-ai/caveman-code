// The web search providers (docs/ "Search providers and keys"): Brave LLM Context, Perplexity Search and
// Exa, each turned into one result shape, `{ url, title, date?, excerpts[] }`, under one budget of about 3k tokens
// and 10 results. Plain async on purpose: the provider eval (scripts/web-eval) imports `runProviderSearch` as is.
// The runtime's own search (WebTools.ts) adds keys, failover, caches and caps around it.
import { cutToFit, jsonBytes, MAX_URL_CHARS } from "./inline.ts";

export type WebProviderId = "brave" | "perplexity" | "exa";
export type WebFreshness = "day" | "week" | "month" | "year";

export interface WebSearchRequest {
  readonly query: string;
  /** 1 to 10; 8 when absent. */
  readonly count?: number;
  readonly freshness?: WebFreshness;
  /** Hosts the results must come from (a subdomain counts). */
  readonly domains?: ReadonlyArray<string>;
}

export interface WebResult {
  readonly url: string;
  readonly title: string;
  /** `YYYY-MM-DD` when the provider knows it. */
  readonly date?: string;
  readonly excerpts: ReadonlyArray<string>;
}

export interface WebSearchResponse {
  readonly results: ReadonlyArray<WebResult>;
  /** Characters / 4 over titles, URLs and excerpts. */
  readonly tokensApprox: number;
  /** What the provider says the call cost, when it says (Exa). */
  readonly costUsd?: number;
}

/**
 * Why a call failed. auth: the key was refused; limit: rate limited or out of quota; unavailable: 5xx, a timeout
 * or no answer; invalid: the provider would not take the request.
 */
export type WebProviderFailure = "auth" | "limit" | "unavailable" | "invalid";

export class WebProviderError extends Error {
  /** `credits`: Cloud's search on Caveman credits (credits.ts). `firecrawl`: web_fetch's second reader (firecrawl.ts). */
  readonly provider: WebProviderId | "credits" | "firecrawl";
  readonly kind: WebProviderFailure;
  readonly status: number | undefined;
  constructor(provider: WebProviderId | "credits" | "firecrawl", kind: WebProviderFailure, message: string, status?: number) {
    super(message);
    this.name = "WebProviderError";
    this.provider = provider;
    this.kind = kind;
    this.status = status;
  }
}

export interface WebProviderInfo {
  readonly id: WebProviderId;
  readonly label: string;
  readonly keyUrl: string;
  /** List price of one call, for the spend row (estimated: the person's own key is billed by the provider). */
  readonly listPriceUsd: (results: number) => number;
  /** Its terms let us keep results for a while (Exa's forbid copying, so it is never cached). */
  readonly cacheable: boolean;
}

/** In the order searches try them (Exa only once the person adds its key). */
export const WEB_PROVIDERS: ReadonlyArray<WebProviderInfo> = [
  // $5 per 1,000 calls (brave.com/search/api, read 2026-10-18).
  { id: "brave", label: "Brave Search", keyUrl: "https://api-dashboard.search.brave.com/app/keys", listPriceUsd: () => 0.005, cacheable: true },
  // $5 per 1,000 requests (docs.perplexity.ai/getting-started/pricing).
  { id: "perplexity", label: "Perplexity", keyUrl: "https://www.perplexity.ai/account/api/keys", listPriceUsd: () => 0.005, cacheable: true },
  // $7 per 1,000 auto searches, up to 10 results with contents or highlights included; only summaries cost more
  // (exa.ai/pricing, read 2026-10-18). Exa also reports each call's cost, which the spend row prefers.
  { id: "exa", label: "Exa", keyUrl: "https://dashboard.exa.ai/api-keys", listPriceUsd: () => 0.007, cacheable: false },
];

export const webProviderInfo = (id: WebProviderId): WebProviderInfo => WEB_PROVIDERS.find((p) => p.id === id)!;

export const MAX_RESULTS = 10;
export const DEFAULT_RESULTS = 8;
/** About 3k tokens of excerpts across every result. */
export const RESULT_TOKEN_BUDGET = 3_000;
/**
 * The excerpts' share of an answer, in bytes once JSON-escaped (inline.ts): four a token in English. Characters
 * would let CJK excerpts (three bytes each) overflow the inline cap.
 */
const BUDGET_BYTES = RESULT_TOKEN_BUDGET * 4;
export const PROVIDER_TIMEOUT_MS = 10_000;
const TIMEOUT_MS = PROVIDER_TIMEOUT_MS;
/** A 429 is tried again once when the provider asks for at most this long a wait; longer, it is a failure. */
const MAX_RETRY_WAIT_MS = 2_000;

const clampCount = (count: number | undefined) => Math.min(MAX_RESULTS, Math.max(1, Math.round(count ?? DEFAULT_RESULTS)));

/** `docs.example.com` from `https://docs.example.com/x`, `*.example.com` or `www.example.com`. */
export const normalizeDomain = (domain: string) =>
  domain
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^\*\./, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/, 1)[0]!;

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return undefined;
  }
};

/** Whether `url` is on one of `domains` or a subdomain of one. */
export const onDomains = (url: string, domains: ReadonlyArray<string>) => {
  const host = hostOf(url);
  return host !== undefined && domains.some((d) => host === d || host.endsWith(`.${d}`));
};

const DAYS: Record<WebFreshness, number> = { day: 1, week: 7, month: 31, year: 365 };

/** Whitespace tidied: no carriage returns, no runs of blank lines, no trailing spaces. */
const tidy = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/** One line: a title never spans lines (the transcript parses the result list by line). */
const oneLine = (text: string, max = 200) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** An excerpt's bytes in the answer: JSON-escaped, without the quotes. */
const bytes = (text: string) => jsonBytes(text) - 2;

/**
 * The results within budget: at most `count`, deduplicated by URL, on `domains` when given, none with a URL
 * web_fetch would refuse, each result's excerpts cut to its share of the byte budget (an unused share passes to
 * the next result).
 */
export function fitResults(raw: ReadonlyArray<WebResult>, count: number, domains: ReadonlyArray<string>): WebSearchResponse {
  const seen = new Set<string>();
  const picked = raw.filter((r) => {
    if (r.url === "" || r.url.length > MAX_URL_CHARS || seen.has(r.url) || (domains.length > 0 && !onDomains(r.url, domains))) return false;
    seen.add(r.url);
    return true;
  }).slice(0, count);
  let left = BUDGET_BYTES;
  let chars = 0;
  const results = picked.map((r, i) => {
    const share = Math.floor(left / (picked.length - i));
    const excerpts: Array<string> = [];
    let used = 0;
    for (const excerpt of r.excerpts.map(tidy).filter((e) => e !== "")) {
      if (used >= share) break;
      const kept = cutToFit(excerpt, (text) => bytes(text) <= share - used);
      if (kept === "") break;
      excerpts.push(kept);
      used += bytes(kept);
      chars += kept.length;
    }
    left -= used;
    const title = oneLine(r.title) || r.url;
    chars += title.length + r.url.length;
    return { url: r.url, title, ...(r.date ? { date: r.date } : {}), excerpts };
  });
  return { results, tokensApprox: Math.ceil(chars / 4) };
}

const dateOnly = (value: unknown) => (typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : undefined);
const str = (value: unknown) => (typeof value === "string" ? value : "");
const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const list = (value: unknown): ReadonlyArray<unknown> => (Array.isArray(value) ? value : []);

interface ProviderCall {
  readonly url: string;
  readonly init: RequestInit;
  readonly parse: (body: unknown) => { readonly results: ReadonlyArray<WebResult>; readonly costUsd?: number };
}

/** Brave's LLM Context: query-relevant snippets per URL under a token budget (api.search.brave.com/res/v1/llm/context). */
export function braveCall(apiKey: string, request: WebSearchRequest): ProviderCall {
  const count = clampCount(request.count);
  const domains = (request.domains ?? []).map(normalizeDomain).filter(Boolean);
  // No site filter in the API: search operators in the query, and the results are filtered by host after.
  const sites = domains.length === 0 ? "" : domains.length === 1 ? ` site:${domains[0]}` : ` (${domains.map((d) => `site:${d}`).join(" OR ")})`;
  const body = {
    q: `${request.query}${sites}`,
    // More candidates than URLs kept, so the context picks the best `count`.
    count: Math.min(50, count * 2),
    maximum_number_of_urls: count,
    maximum_number_of_tokens: Math.max(1024, RESULT_TOKEN_BUDGET),
    maximum_number_of_tokens_per_url: 1024,
    ...(request.freshness === undefined ? {} : { freshness: { day: "pd", week: "pw", month: "pm", year: "py" }[request.freshness] }),
  };
  return {
    url: "https://api.search.brave.com/res/v1/llm/context",
    init: {
      method: "POST",
      headers: { "X-Subscription-Token": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    parse: (raw) => {
      const sources = record(record(raw).sources);
      const results = list(record(record(raw).grounding).generic).map((entry) => {
        const r = record(entry);
        const url = str(r.url);
        // `age`: full date, YYYY-MM-DD, relative age, ISO timestamp; empty when no date is known.
        const date = dateOnly(list(record(sources[url]).age)[1]);
        return {
          url,
          title: str(r.title) || str(record(sources[url]).title),
          ...(date ? { date } : {}),
          excerpts: list(r.snippets).map(str),
        };
      });
      return { results };
    },
  };
}

/** Perplexity's Search API: ranked results with extracted page text (api.perplexity.ai/search). */
export function perplexityCall(apiKey: string, request: WebSearchRequest): ProviderCall {
  const count = clampCount(request.count);
  const domains = (request.domains ?? []).map(normalizeDomain).filter(Boolean).slice(0, 20);
  const body = {
    query: request.query,
    max_results: count,
    max_tokens: RESULT_TOKEN_BUDGET,
    max_tokens_per_page: Math.max(256, Math.floor((RESULT_TOKEN_BUDGET * 2) / count)),
    ...(domains.length === 0 ? {} : { search_domain_filter: domains }),
    ...(request.freshness === undefined ? {} : { search_recency_filter: request.freshness }),
  };
  return {
    url: "https://api.perplexity.ai/search",
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    parse: (raw) => ({
      results: list(record(raw).results).map((entry) => {
        const r = record(entry);
        const date = dateOnly(r.date) ?? dateOnly(r.last_updated);
        // One snippet per page, often several paragraphs: each paragraph its own excerpt.
        return { url: str(r.url), title: str(r.title), ...(date ? { date } : {}), excerpts: str(r.snippet).split(/\n{2,}/) };
      }),
    }),
  };
}

/** Exa's search with highlights: the passages of each page closest to the query (api.exa.ai/search). */
export function exaCall(apiKey: string, request: WebSearchRequest, now: Date = new Date()): ProviderCall {
  const count = clampCount(request.count);
  const domains = (request.domains ?? []).map(normalizeDomain).filter(Boolean);
  const body = {
    query: request.query,
    type: "auto",
    numResults: count,
    ...(domains.length === 0 ? {} : { includeDomains: domains }),
    ...(request.freshness === undefined
      ? {}
      : { startPublishedDate: new Date(now.getTime() - DAYS[request.freshness] * 86_400_000).toISOString() }),
    contents: { highlights: { query: request.query, maxCharacters: Math.floor(BUDGET_BYTES / count) } },
  };
  return {
    url: "https://api.exa.ai/search",
    init: {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    },
    parse: (raw) => {
      const total = record(record(raw).costDollars).total;
      return {
        results: list(record(raw).results).map((entry) => {
          const r = record(entry);
          const date = dateOnly(r.publishedDate);
          return { url: str(r.url), title: str(r.title), ...(date ? { date } : {}), excerpts: list(r.highlights).map(str) };
        }),
        ...(typeof total === "number" ? { costUsd: total } : {}),
      };
    },
  };
}

export const providerCall = (provider: WebProviderId, apiKey: string, request: WebSearchRequest): ProviderCall =>
  provider === "brave" ? braveCall(apiKey, request) : provider === "perplexity" ? perplexityCall(apiKey, request) : exaCall(apiKey, request);

export const failureOf = (status: number): WebProviderFailure =>
  status === 401 || status === 403 ? "auth" : status === 429 || status === 402 ? "limit" : status >= 500 ? "unavailable" : "invalid";

/** The provider's own words for a refusal, short; never the request. */
export const errorDetail = async (response: Response) => {
  const text = await response.text().catch(() => "");
  try {
    const body = record(JSON.parse(text));
    const error = body.error;
    const message =
      typeof error === "string" ? error : str(record(error).detail) || str(record(error).message) || str(body.message) || str(body.detail);
    if (message) return oneLine(message, 200);
  } catch {
    // Not JSON: the status says enough.
  }
  return oneLine(text, 200);
};

/** How long a 429 asks to wait: Retry-After in seconds or as a date; a second when it says nothing. */
const retryAfterMs = (value: string | null) => {
  if (value === null) return 1_000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : 1_000;
};

const wait = (ms: number, signal: AbortSignal | undefined) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });

/**
 * One search on one provider with the person's key. Throws a `WebProviderError` saying why it failed, so the
 * caller can fail over. A 429 that asks for a short wait is tried again (`retries`, once by default; the runtime's
 * own search fails over instead). Every attempt has its own 10 s, so a wait never eats into the next; `signal`
 * aborts it all.
 */
export async function runProviderSearch(
  provider: WebProviderId,
  apiKey: string,
  request: WebSearchRequest,
  fetchImpl: typeof fetch = fetch,
  options: { readonly signal?: AbortSignal; readonly retries?: number } = {},
): Promise<WebSearchResponse> {
  const call = providerCall(provider, apiKey, request);
  for (let attempt = 0; ; attempt++) {
    const timeout = AbortSignal.timeout(TIMEOUT_MS);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    let response: Response;
    try {
      response = await fetchImpl(call.url, { ...call.init, signal });
    } catch (cause) {
      throw new WebProviderError(provider, "unavailable", timeout.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : `could not be reached (${(cause as Error).message})`);
    }
    if (response.status === 429 && attempt < (options.retries ?? 1)) {
      const ms = retryAfterMs(response.headers.get("retry-after"));
      if (ms <= MAX_RETRY_WAIT_MS) {
        await response.body?.cancel().catch(() => undefined);
        await wait(ms, options.signal);
        continue;
      }
    }
    if (!response.ok) {
      const detail = await errorDetail(response);
      throw new WebProviderError(provider, failureOf(response.status), `${response.status}${detail ? `: ${detail}` : ""}`, response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new WebProviderError(provider, "unavailable", timeout.aborted ? `no answer within ${TIMEOUT_MS / 1000} s` : "answered with something that is not JSON");
    }
    const parsed = call.parse(body);
    const domains = (request.domains ?? []).map(normalizeDomain).filter(Boolean);
    const fitted = fitResults(parsed.results, clampCount(request.count), domains);
    return parsed.costUsd === undefined ? fitted : { ...fitted, costUsd: parsed.costUsd };
  }
}
