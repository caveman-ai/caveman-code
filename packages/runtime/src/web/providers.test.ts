// Each provider's request as its docs ask for it (URL, auth header, body), and its answer read into one shape,
// from answers recorded off the docs' examples (fixtures/).
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { fitResults, runProviderSearch, webProviderInfo, WebProviderError, type WebProviderId } from "./providers.ts";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as unknown;

function recording(status: number, body: unknown) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl, sent: () => JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>, headers: () => new Headers(calls[0]!.init.headers) };
}

describe("runProviderSearch", () => {
  it("asks Brave's LLM Context with its subscription header, a token budget and site operators, and reads snippets and dates", async () => {
    const wire = recording(200, fixture("brave-llm-context.json"));
    const out = await runProviderSearch("brave", "brave-key", { query: "node read file", count: 5, freshness: "week", domains: ["https://nodejs.org/api", "stackoverflow.com"] }, wire.fetchImpl);
    expect(wire.calls[0]!.url).toBe("https://api.search.brave.com/res/v1/llm/context");
    expect(wire.calls[0]!.init.method).toBe("POST");
    expect(wire.headers().get("x-subscription-token")).toBe("brave-key");
    expect(wire.sent()).toEqual({
      q: "node read file (site:nodejs.org OR site:stackoverflow.com)",
      count: 10,
      maximum_number_of_urls: 5,
      maximum_number_of_tokens: 3000,
      maximum_number_of_tokens_per_url: 1024,
      freshness: "pw",
    });
    expect(out.results).toEqual([
      {
        url: "https://nodejs.org/api/fs.html",
        title: "File system | Node.js v24 Documentation",
        date: "2026-09-08",
        excerpts: ["fs.readFile(path[, options], callback) asynchronously reads the entire contents of a file.", '{"method":"fs.promises.readFile","returns":"Promise<Buffer|string>"}'],
      },
      {
        url: "https://stackoverflow.com/questions/10049557/reading-all-files-in-a-directory",
        title: "Reading all files in a directory, store them in objects",
        excerpts: ["Use fs.readdir to list the directory, then fs.readFile on each entry."],
      },
    ]);
    expect(out.tokensApprox).toBeGreaterThan(40);
    expect(out.tokensApprox).toBeLessThan(200);
  });

  it("asks Perplexity's Search with a bearer key, max results, token caps and filters, and splits snippets into paragraphs", async () => {
    const wire = recording(200, fixture("perplexity-search.json"));
    const out = await runProviderSearch("perplexity", "pplx-key", { query: "effect typescript", freshness: "month", domains: ["effect.website", "github.com"] }, wire.fetchImpl);
    expect(wire.calls[0]!.url).toBe("https://api.perplexity.ai/search");
    expect(wire.headers().get("authorization")).toBe("Bearer pplx-key");
    expect(wire.sent()).toEqual({
      query: "effect typescript",
      max_results: 8,
      max_tokens: 3000,
      max_tokens_per_page: 750,
      search_domain_filter: ["effect.website", "github.com"],
      search_recency_filter: "month",
    });
    expect(out.results.map((r) => [r.url, r.date, r.excerpts])).toEqual([
      ["https://effect.website/docs", "2026-08-01", ["Effect is a powerful TypeScript library.", "It helps you build robust applications."]],
      ["https://github.com/Effect-TS/effect", "2026-10-12", ["Build production-ready applications in TypeScript."]],
    ]);
  });

  it("asks Exa with x-api-key, auto search and query-guided highlights, and keeps the cost it reports", async () => {
    const wire = recording(200, fixture("exa-search.json"));
    const out = await runProviderSearch("exa", "exa-key", { query: "undici connect lookup", count: 4, freshness: "year", domains: ["undici.nodejs.org"] }, wire.fetchImpl);
    expect(wire.calls[0]!.url).toBe("https://api.exa.ai/search");
    expect(wire.headers().get("x-api-key")).toBe("exa-key");
    const sent = wire.sent();
    expect(sent).toMatchObject({ query: "undici connect lookup", type: "auto", numResults: 4, includeDomains: ["undici.nodejs.org"], contents: { highlights: { query: "undici connect lookup", maxCharacters: 3000 } } });
    expect(Date.now() - Date.parse(String(sent.startPublishedDate))).toBeGreaterThan(364 * 86_400_000);
    expect(out.results).toEqual([
      { url: "https://undici.nodejs.org/#/docs/api/Agent", title: "undici Agent connect options", date: "2026-07-14", excerpts: ["connect: ConnectOptions | Function — options for the connector, such as lookup."] },
    ]);
    expect(out.costUsd).toBe(0.008);
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [422, "invalid"],
    [429, "limit"],
    [503, "unavailable"],
  ] as const)("names a %i as %s, with the provider's own words", async (status, kind) => {
    const wire = recording(status, { error: { message: "Subscription token invalid" } });
    const error = await runProviderSearch("brave" as WebProviderId, "k", { query: "q" }, wire.fetchImpl).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WebProviderError);
    expect((error as WebProviderError).kind).toBe(kind);
    expect((error as WebProviderError).message).toBe(`${status}: Subscription token invalid`);
  });

  it("tries a 429 that asks for a short wait once more, each attempt on its own timeout; a long wait or retries 0 fails at once", async () => {
    let calls = 0;
    const signals: Array<AbortSignal> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return calls++ === 0 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : Response.json(fixture("perplexity-search.json"));
    }) as unknown as typeof fetch;
    const out = await runProviderSearch("perplexity", "k", { query: "q" }, fetchImpl);
    expect(out.results).toHaveLength(2);
    expect(calls).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
    const slow = (async () => new Response("{}", { status: 429, headers: { "retry-after": "30" } })) as unknown as typeof fetch;
    expect(((await runProviderSearch("brave", "k", { query: "q" }, slow).catch((e: unknown) => e)) as WebProviderError).kind).toBe("limit");
    calls = 0;
    expect(((await runProviderSearch("perplexity", "k", { query: "q" }, fetchImpl, { retries: 0 }).catch((e: unknown) => e)) as WebProviderError).kind).toBe("limit");
  });

  it("prices an Exa search at its list price, highlights included", () => {
    expect(webProviderInfo("exa").listPriceUsd(10)).toBe(0.007);
    expect(webProviderInfo("brave").listPriceUsd(10)).toBe(0.005);
  });

  it("names a network failure as unavailable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = (await runProviderSearch("perplexity", "k", { query: "q" }, fetchImpl).catch((e: unknown) => e)) as WebProviderError;
    expect(error.kind).toBe("unavailable");
  });
});

describe("fitResults", () => {
  it("keeps about 3k tokens across at most `count` results, deduplicated and on the domains asked for", () => {
    const long = "word ".repeat(2_000);
    const raw = Array.from({ length: 14 }, (_, i) => ({ url: `https://${i % 2 === 0 ? "docs.example.com" : "other.test"}/${i}`, title: `Result ${i}\nsecond line`, excerpts: [long, long] }));
    const fitted = fitResults([...raw, raw[0]!], 10, ["example.com"]);
    expect(fitted.results).toHaveLength(7);
    expect(fitted.results.every((r) => r.url.startsWith("https://docs.example.com/"))).toBe(true);
    expect(fitted.results[0]!.title).toBe("Result 0 second line");
    const chars = fitted.results.reduce((n, r) => n + r.excerpts.join("").length, 0);
    expect(chars).toBeLessThanOrEqual(12_000);
    expect(fitted.tokensApprox).toBeLessThanOrEqual(3_100);
    expect(fitted.tokensApprox).toBeGreaterThan(2_800);
  });

  it("budgets excerpts in bytes, so text of three bytes a character gets a third of the characters, and drops URLs web_fetch refuses", () => {
    const wide = "漢字の文章です。".repeat(400);
    const raw = Array.from({ length: 10 }, (_, i) => ({ url: `https://docs.example.jp/${i}`, title: `結果 ${i}`, excerpts: [wide] }));
    const fitted = fitResults([...raw, { url: `https://docs.example.jp/${"x".repeat(2_000)}`, title: "long", excerpts: ["x"] }], 10, []);
    expect(fitted.results).toHaveLength(10);
    const bytes = fitted.results.reduce((n, r) => n + Buffer.byteLength(r.excerpts.join("")), 0);
    expect(bytes).toBeLessThanOrEqual(12_000);
    expect(bytes).toBeGreaterThan(11_000);
  });
});
