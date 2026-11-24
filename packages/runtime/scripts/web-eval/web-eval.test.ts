// The search-provider eval's scoring, decision rule and runner, driven by a fake runProviderSearch,
// plus a shape check on the shipped query set. No network.
import * as fs from "node:fs";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  ARMS,
  BUCKETS,
  answerFound,
  bootstrap,
  goldRank,
  matchesPrefix,
  normaliseUrl,
  percentile,
  recommendOrder,
  summariseArm,
  type ArmName,
  type ArmSummary,
  type Query,
  type SearchResult,
  type SkippedArm,
} from "./score.ts";
import { loadQueries, politeFetch, runArms, takeBalanced, type RunProviderSearch } from "./web-eval.ts";

const result = (url: string, excerpts: Array<string> = [], title = ""): SearchResult => ({ url, title, excerpts });

describe("URL matching", () => {
  it("ignores scheme, www, trailing slash, fragment and case", () => {
    expect(normaliseUrl("https://www.Example.com/Docs/Page/#intro")).toBe("example.com/docs/page");
    expect(normaliseUrl("http://example.com/docs/page")).toBe("example.com/docs/page");
    expect(normaliseUrl("example.com/docs/page/")).toBe("example.com/docs/page");
    expect(normaliseUrl("https://example.com/a?b=1#c")).toBe("example.com/a?b=1");
  });

  it("reads a GitHub pull request as the issue of the same number", () => {
    expect(normaliseUrl("https://github.com/vitejs/vite/pull/123/files")).toBe("github.com/vitejs/vite/issues/123/files");
    expect(matchesPrefix("https://github.com/vitejs/vite/pull/123", "https://github.com/vitejs/vite/issues/123")).toBe(true);
  });

  it("matches a prefix only at a path boundary", () => {
    const gold = "https://github.com/vitejs/vite/issues/123";
    expect(matchesPrefix("https://github.com/vitejs/vite/issues/123", gold)).toBe(true);
    expect(matchesPrefix("https://github.com/vitejs/vite/issues/123#issuecomment-9", gold)).toBe(true);
    expect(matchesPrefix("https://github.com/vitejs/vite/issues/123?q=1", gold)).toBe(true);
    expect(matchesPrefix("https://github.com/vitejs/vite/issues/1234", gold)).toBe(false);
    expect(matchesPrefix("https://nodejs.org/api/fs.html", "https://nodejs.org/api/")).toBe(true);
    expect(matchesPrefix("https://nodejs.org/apifoo", "https://nodejs.org/api")).toBe(false);
  });

  it("ranks the first gold hit within the top 10", () => {
    const gold = ["https://nodejs.org/api/fs.html"];
    const results = Array.from({ length: 12 }, (_, i) => result(`https://example.com/${i}`));
    expect(goldRank(results, gold)).toBeNull();
    results[3] = result("http://nodejs.org/api/fs.html#fspromisesglobpattern-options");
    expect(goldRank(results, gold)).toBe(4);
    results[3] = result("https://example.com/3");
    results[10] = result("https://nodejs.org/api/fs.html");
    expect(goldRank(results, gold)).toBeNull();
  });
});

describe("answer in excerpts", () => {
  it("matches case-insensitively across excerpts of the top 10, never titles", () => {
    expect(answerFound([result("a", ["use the EXCLUDE option"])], "exclude")).toBe(true);
    expect(answerFound([result("a", ["first"]), result("b", ["second", "withFileTypes: true"])], "withFileTypes:\\s*true")).toBe(true);
    expect(answerFound([result("a", [], "exclude in the title only")], "exclude")).toBe(false);
    const eleven = [...Array.from({ length: 10 }, (_, i) => result(`u${i}`, ["nothing"])), result("u10", ["exclude"])];
    expect(answerFound(eleven, "exclude")).toBe(false);
  });
});

describe("statistics", () => {
  it("takes nearest-rank percentiles", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 50)).toBeNull();
  });

  it("bootstraps reproducibly from a seed", () => {
    const values = Array.from({ length: 50 }, (_, i) => (i % 3 === 0 ? 1 : 0));
    const a = bootstrap(values, { seed: 42 });
    expect(bootstrap(values, { seed: 42 })).toEqual(a);
    expect(bootstrap(values, { seed: 43 })).not.toEqual(a);
    expect(a!.mean).toBeCloseTo(17 / 50);
    expect(a!.lo).toBeLessThan(a!.mean);
    expect(a!.hi).toBeGreaterThan(a!.mean);
    expect(bootstrap([1, 1, 1], { seed: 1 })).toEqual({ mean: 1, lo: 1, hi: 1 });
    expect(bootstrap([], { seed: 1 })).toBeNull();
  });
});

const summary = (arm: ArmName, answer: number, recall = answer, extra: Partial<ArmSummary> = {}): ArmSummary => ({
  arm,
  status: "ran",
  queries: 100,
  calls: 100,
  errors: 0,
  recall: { mean: recall, lo: recall, hi: recall },
  answer: { mean: answer, lo: answer, hi: answer },
  tokens_mean: 3000,
  latency_p50_ms: 600,
  latency_p95_ms: 1200,
  usd_per_query: { brave: 0.005, perplexity: 0.005, "perplexity-fast": 0.001, exa: 0.007 }[arm],
  usd_total: 0,
  correct_calls: 0,
  usd_per_correct: null,
  usd_reported_per_query: null,
  by_bucket: {},
  ...extra,
});

describe("decision rule", () => {
  it("orders by answer rate when the gaps are 5 points or more", () => {
    expect(recommendOrder([summary("brave", 0.6), summary("exa", 0.7), summary("perplexity", 0.5)]).order).toEqual(["exa", "brave", "perplexity"]);
  });

  it("gives a tie (under 5 points) to the cheaper arm", () => {
    const { order, reasons } = recommendOrder([summary("exa", 0.64), summary("perplexity-fast", 0.6)]);
    expect(order).toEqual(["perplexity-fast", "exa"]);
    expect(reasons[0]).toMatch(/ties with exa .*4\.0 pts.*cheaper/);
  });

  it("does not count exactly 5 points as a tie", () => {
    expect(recommendOrder([summary("exa", 0.65), summary("perplexity-fast", 0.6)]).order).toEqual(["exa", "perplexity-fast"]);
  });

  it("breaks a tie at the same price on answer rate, then recall", () => {
    expect(recommendOrder([summary("brave", 0.6), summary("perplexity", 0.62)]).order).toEqual(["perplexity", "brave"]);
    expect(recommendOrder([summary("brave", 0.6, 0.7), summary("perplexity", 0.6, 0.5)]).order).toEqual(["brave", "perplexity"]);
  });

  it("is well defined when ties chain", () => {
    // exa leads; fast is within 5 of exa and cheapest, so it goes first; then exa (brave is 6 below exa).
    expect(recommendOrder([summary("exa", 0.7), summary("perplexity-fast", 0.67), summary("brave", 0.64)]).order).toEqual(["perplexity-fast", "exa", "brave"]);
  });

  it("leaves out skipped arms and arms whose every call failed", () => {
    const skipped: SkippedArm = { arm: "exa", status: "skipped", reason: "no EXA_API_KEY" };
    const failed = summary("perplexity", 0, 0, { errors: 100 });
    expect(recommendOrder([skipped, failed, summary("brave", 0.5)]).order).toEqual(["brave"]);
    expect(recommendOrder([skipped]).order).toEqual([]);
  });
});

const queries: Array<Query> = [
  { id: "q1", bucket: "api", query: "node fs glob exclude", gold_urls: ["https://nodejs.org/api/fs.html"], answer: "withFileTypes" },
  { id: "q2", bucket: "error", query: "TS1484 type-only import", gold_urls: ["https://www.typescriptlang.org/tsconfig/verbatimModuleSyntax.html"], answer: "import type" },
  { id: "q3", bucket: "issue", query: "vite hmr loop", gold_urls: ["https://github.com/vitejs/vite/issues/100"], answer: "fixed in 7\\.1\\.2" },
  { id: "q4", bucket: "config", query: "compose watch", gold_urls: ["https://docs.docker.com/compose/how-tos/file-watch/"], answer: "sync\\+restart" },
];

/** Hits gold and answers for q1 and q2; q3 hits gold without the answer; q4 throws on the first run only. */
const fakeSearch = (): { search: RunProviderSearch; calls: Array<{ provider: string; key: string; count?: number }> } => {
  const calls: Array<{ provider: string; key: string; count?: number }> = [];
  let q4 = 0;
  const search: RunProviderSearch = async (provider, apiKey, request) => {
    calls.push({ provider, key: apiKey, ...(request.count === undefined ? {} : { count: request.count }) });
    const q = queries.find((x) => x.query === request.query)!;
    if (q.id === "q4" && q4++ === 0) throw new Error("HTTP 500");
    const answer = q.id === "q1" ? "withFileTypes: true" : q.id === "q2" ? "use import type" : "nothing useful";
    return { results: [result("https://example.com/x", ["noise"]), result(q.gold_urls[0]!, [answer])], tokensApprox: 1000 };
  };
  return { search, calls };
};

describe("runner", () => {
  it("scores each arm over runs, counts failures as misses, and prices successful calls", async () => {
    const { search, calls } = fakeSearch();
    const out = await runArms({ queries, arms: [{ arm: "brave", apiKey: "k-brave" }], runs: 2, concurrency: 2, search });
    expect(calls).toHaveLength(8);
    expect(calls.every((c) => c.provider === "brave" && c.key === "k-brave" && c.count === 10)).toBe(true);
    const s = summariseArm("brave", out.get("brave")!, { seed: 1 });
    expect(s.calls).toBe(8);
    expect(s.errors).toBe(1);
    // recall: q1, q2, q3 hit both runs; q4 hits on run 2 only -> (1 + 1 + 1 + 0.5) / 4
    expect(s.recall!.mean).toBeCloseTo(3.5 / 4);
    // answer: q1 and q2 only
    expect(s.answer!.mean).toBeCloseTo(0.5);
    expect(s.tokens_mean).toBe(1000);
    expect(s.usd_total).toBeCloseTo(7 * 0.005);
    expect(s.correct_calls).toBe(4);
    expect(s.usd_per_correct).toBeCloseTo((7 * 0.005) / 4);
    expect(s.by_bucket.issue!.recall!.mean).toBe(1);
    expect(s.by_bucket.issue!.answer!.mean).toBe(0);
  });

  it("sends perplexity-fast as perplexity with search_type fast", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }) as typeof fetch;
    const providers: Array<string> = [];
    const search: RunProviderSearch = async (provider, _key, request, fetchImpl) => {
      providers.push(provider);
      await fetchImpl!("https://api.perplexity.ai/search", { method: "POST", body: JSON.stringify({ query: request.query, max_results: request.count }) });
      return { results: [], tokensApprox: 0 };
    };
    await runArms({ queries: queries.slice(0, 1), arms: [{ arm: "perplexity-fast", apiKey: "k" }, { arm: "perplexity", apiKey: "k" }], runs: 1, concurrency: 1, search, fetchImpl: fakeFetch });
    expect(providers).toEqual(["perplexity", "perplexity"]);
    expect(bodies).toContainEqual({ query: queries[0]!.query, max_results: 10, search_type: "fast" });
    expect(bodies).toContainEqual({ query: queries[0]!.query, max_results: 10 });
  });

  it("waits out a 429 and leaves the wait out of latency", async () => {
    let attempts = 0;
    const fakeFetch = (async () => (attempts++ === 0 ? new Response("slow down", { status: 429, headers: { "retry-after": "0.2" } }) : new Response("{}", { status: 200 }))) as typeof fetch;
    const search: RunProviderSearch = async (_p, _k, _r, fetchImpl) => {
      const response = await fetchImpl!("https://api.search.brave.com/res/v1/llm/context");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { results: [], tokensApprox: 0 };
    };
    const out = await runArms({ queries: queries.slice(0, 1), arms: [{ arm: "brave", apiKey: "k" }], runs: 1, concurrency: 1, search, fetchImpl: fakeFetch });
    const run = out.get("brave")![0]!.runs[0]!;
    expect(attempts).toBe(2);
    expect(run.ok).toBe(true);
    expect(run.latency_ms).toBeLessThan(150);
  });

  it("gives up after the retry budget and returns the 429", async () => {
    let attempts = 0;
    const fakeFetch = (async () => {
      attempts++;
      return new Response("", { status: 429 });
    }) as typeof fetch;
    const response = await politeFetch(fakeFetch, { retries: 2, baseDelayMs: 1 })("https://example.com");
    expect(response.status).toBe(429);
    expect(attempts).toBe(3);
  });

  it("takes --limit round-robin across buckets", () => {
    const many: Array<Query> = BUCKETS.flatMap((bucket) => Array.from({ length: 5 }, (_, i) => ({ ...queries[0]!, id: `${bucket}-${i}`, bucket })));
    const picked = takeBalanced(many, 7);
    expect(picked.map((q) => q.id)).toEqual(["api-0", "error-0", "issue-0", "config-0", "changelog-0", "api-1", "error-1"]);
  });
});

// The contract with src/web/providers.ts, once it is on this branch: each arm through the real adapter, against
// canned provider answers in the documented shapes.
const adapter = fileURLToPath(new URL("../../src/web/providers.ts", import.meta.url));
describe.skipIf(!fs.existsSync(adapter))("with the real adapter", () => {
  it("scores every arm through runProviderSearch, sets search_type fast, and keeps Exa's own cost", async () => {
    const { runProviderSearch } = (await import(adapter)) as { runProviderSearch: RunProviderSearch };
    const gold = queries[0]!.gold_urls[0]!;
    const sent: Array<{ host: string; body: Record<string, unknown> }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const host = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url).hostname;
      sent.push({ host, body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      const body = host.includes("brave")
        ? { grounding: { generic: [{ url: gold, title: "fs", snippets: ["withFileTypes: true"] }] }, sources: {} }
        : host.includes("perplexity")
          ? { results: [{ url: gold, title: "fs", snippet: "withFileTypes: true" }] }
          : { results: [{ url: gold, title: "fs", highlights: ["withFileTypes: true"] }], costDollars: { total: 0.007 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const out = await runArms({ queries: queries.slice(0, 1), arms: ARMS.map((arm) => ({ arm, apiKey: "k" })), runs: 1, concurrency: 1, search: runProviderSearch, fetchImpl: fakeFetch });
    for (const arm of ARMS) expect(out.get(arm)![0]!.runs[0], arm).toMatchObject({ ok: true, rank: 1, answer: true });
    expect(out.get("exa")![0]!.runs[0]!.usd_reported).toBe(0.007);
    expect(sent.filter((s) => s.host.includes("perplexity")).map((s) => s.body.search_type ?? "web").sort()).toEqual(["fast", "web"]);
  });
});

describe("queries.jsonl", () => {
  let all: Array<Query> = [];
  beforeAll(() => {
    all = loadQueries(fileURLToPath(new URL("./queries.jsonl", import.meta.url)));
  });

  it("has at least 100 queries, balanced across the five buckets, with unique ids", () => {
    expect(all.length).toBeGreaterThanOrEqual(100);
    const counts = BUCKETS.map((b) => all.filter((q) => q.bucket === b).length);
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(20);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(5);
    expect(new Set(all.map((q) => q.id)).size).toBe(all.length);
    expect(all.every((q) => (BUCKETS as ReadonlyArray<string>).includes(q.bucket))).toBe(true);
  });

  it("has answer patterns that compile and don't give themselves away in the query", () => {
    for (const q of all) {
      const re = new RegExp(q.answer, "i");
      expect(re.test(q.query), `${q.id}: answer matches the query`).toBe(false);
      expect(re.test(""), `${q.id}: answer matches the empty string`).toBe(false);
    }
  });

  it("has page-level http(s) gold prefixes without fragments", () => {
    for (const q of all) {
      expect(q.gold_urls.length, q.id).toBeGreaterThan(0);
      for (const u of q.gold_urls) {
        const url = new URL(u);
        expect(url.protocol, `${q.id} ${u}`).toMatch(/^https?:$/);
        expect(url.hash, `${q.id} ${u}`).toBe("");
        expect(url.pathname.replace(/\/+$/, ""), `${q.id} ${u}: a whole site is not a gold prefix`).not.toBe("");
      }
    }
  });

  it("raw file is one JSON object per line", () => {
    const lines = fs.readFileSync(fileURLToPath(new URL("./queries.jsonl", import.meta.url)), "utf8").trim().split("\n");
    expect(lines).toHaveLength(all.length);
  });
});
