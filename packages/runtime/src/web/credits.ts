// Search on Caveman credits, at cost: Cloud's gateway route `POST /v1/code/search` runs
// the search on Caveman's own provider key and bills the person's credits what it cost. Same credits key and
// `x-caveman-client` header as the Caveman engine's credits models (provider-caveman credits.ts); same result shape
// as a person's own provider (providers.ts), so WebTools tries it as one more source, after their own keys.
import { creditsHeaders, gatewayFailure, resetsOn } from "../cloudLink/creditsGateway.ts";
import { fitResults, normalizeDomain, WebProviderError, type WebFreshness, type WebResult, type WebSearchRequest, type WebSearchResponse } from "./providers.ts";

export const CREDITS_SEARCH_PATH = "/v1/code/search";
/** Cloud tries its providers in turn before it answers, so this waits longer than a provider of the person's own. */
export const CREDITS_TIMEOUT_MS = 45_000;

export interface CreditsSearchResponse extends WebSearchResponse {
  /** The provider Cloud searched with. */
  readonly provider: "brave" | "perplexity";
  /** What Cloud billed the credits. */
  readonly costUsd: number;
}

const record = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {});
const str = (value: unknown) => (typeof value === "string" ? value : "");

/**
 * One search billed to Caveman credits, for the chat `session` names (Cloud's `x-caveman-session`). Throws a
 * WebProviderError (provider `credits`): auth when Cloud refused the credits key, limit when the credits ran out
 * (402) or the route is rate limited, unavailable otherwise.
 */
export async function runCreditsSearch(
  creditsKey: string,
  request: WebSearchRequest,
  options: { readonly gatewayUrl: string; readonly session?: string; readonly fetchImpl?: typeof fetch; readonly signal?: AbortSignal },
): Promise<CreditsSearchResponse> {
  const domains = (request.domains ?? []).map(normalizeDomain).filter(Boolean);
  const body: { query: string; count?: number; freshness?: WebFreshness; domains?: ReadonlyArray<string> } = {
    query: request.query,
    ...(request.count === undefined ? {} : { count: request.count }),
    ...(request.freshness === undefined ? {} : { freshness: request.freshness }),
    ...(domains.length === 0 ? {} : { domains }),
  };
  const timeout = AbortSignal.timeout(CREDITS_TIMEOUT_MS);
  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(`${options.gatewayUrl.replace(/\/+$/, "")}${CREDITS_SEARCH_PATH}`, {
      method: "POST",
      headers: creditsHeaders(creditsKey, options.session),
      body: JSON.stringify(body),
      signal: options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]),
    });
  } catch (cause) {
    throw new WebProviderError("credits", "unavailable", timeout.aborted ? `no answer within ${CREDITS_TIMEOUT_MS / 1000} s` : `could not be reached (${(cause as Error).message})`);
  }
  if (!response.ok) {
    const { code, words, details } = await gatewayFailure(response);
    // Cloud's two answers a person acts on, in plain words: out of credits (until when), and search down (unbilled).
    if (response.status === 402 && code === "cave_code_credits_exhausted") {
      const resets = resetsOn(details.resets_at);
      throw new WebProviderError("credits", "limit", resets === undefined ? "none left" : `they come back ${resets}`, 402);
    }
    if (response.status === 503 && code === "cave_code_search_unavailable") {
      throw new WebProviderError("credits", "unavailable", "search on credits is down for now; nothing was charged", 503);
    }
    const kind = response.status === 401 || response.status === 403 ? "auth" : response.status === 402 || response.status === 429 ? "limit" : response.status >= 500 ? "unavailable" : "invalid";
    throw new WebProviderError("credits", kind, `${response.status}${words ? `: ${words}` : ""}`, response.status);
  }
  const answer = record(await response.json().catch(() => undefined));
  const provider = answer.provider === "perplexity" ? "perplexity" : "brave";
  const results: ReadonlyArray<WebResult> = (Array.isArray(answer.results) ? answer.results : []).map((entry: unknown) => {
    const r = record(entry);
    const date = typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}/.test(r.date) ? r.date.slice(0, 10) : undefined;
    return { url: str(r.url), title: str(r.title), ...(date ? { date } : {}), excerpts: (Array.isArray(r.excerpts) ? r.excerpts : []).map(str) };
  });
  const cost = typeof answer.cost_usd === "number" && Number.isFinite(answer.cost_usd) ? answer.cost_usd : 0;
  return { ...fitResults(results, Math.min(10, Math.max(1, request.count ?? 8)), domains), provider, costUsd: cost };
}
