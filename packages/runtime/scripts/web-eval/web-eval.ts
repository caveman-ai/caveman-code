// The search-provider eval (docs/, "Choosing the provider: the eval"): coding queries in
// five buckets (versioned APIs, verbatim errors, GitHub issues, config options, changelogs), each with
// gold URL prefixes and an answer pattern, sent to every arm through runProviderSearch
// (src/web/providers.ts) at 10 results. It reports recall@10, whether the answer appears in the
// excerpts, tokens returned, p50/p95 latency, list-price cost per query and per correct answer, 95%
// bootstrap intervals over queries, and the order the decision rule picks. Every number is labelled:
// measured (this run), verified (a list price read on the vendor's page) or inferred (price × calls).
//
// Usage (keys from the environment only; an arm without its key is skipped and reported as skipped):
//   BRAVE_API_KEY=… PERPLEXITY_API_KEY=… EXA_API_KEY=… node scripts/web-eval/web-eval.ts \
//     [--arms brave,perplexity,perplexity-fast,exa] [--runs 3] [--limit N] [--bucket api,error]
//     [--concurrency 4] [--drop-known] [--seed 1] [--out ~/.cache/caveman-web-eval]
// Prints a markdown table and writes <out>/<timestamp>.json. No arm to run: writes the report, exits 2.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  ARMS,
  BUCKETS,
  answerFound,
  goldRank,
  keyEnvOf,
  markdownReport,
  PRICES,
  providerOf,
  recommendOrder,
  summariseArm,
  type ArmName,
  type ArmSummary,
  type Bucket,
  type DropKnown,
  type Provider,
  type Query,
  type QueryOutcome,
  type SearchResponse,
  type SkippedArm,
} from "./score.ts";

/** The adapter's signature (src/web/providers.ts); imported at run time so this script typechecks before it lands. */
export type RunProviderSearch = (
  provider: Provider,
  apiKey: string,
  request: { query: string; count?: number; freshness?: "day" | "week" | "month" | "year"; domains?: string[] },
  fetchImpl?: typeof fetch,
) => Promise<SearchResponse>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run `work` over `items`, at most `limit` at a time. */
export const pool = async <T>(items: ReadonlyArray<T>, limit: number, work: (item: T, index: number) => Promise<void>) => {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
      while (next < items.length) {
        const i = next++;
        await work(items[i]!, i);
      }
    }),
  );
};

export interface PoliteOptions {
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly timeoutMs?: number;
  /** Told how long each 429 wait was, so latency can leave it out. */
  readonly onWait?: (ms: number) => void;
  /** Rewrites a JSON request body before it is sent (perplexity-fast sets search_type). */
  readonly rewriteJson?: (url: string, body: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * A fetch that waits out 429s (Retry-After, else exponential backoff), times out each attempt, and can rewrite JSON
 * bodies. It owns the timeout, per attempt (10 s, the adapter's own cap): the caller's signal is a wall clock started
 * before the first attempt, so it would count the polite waits against the provider.
 */
export const politeFetch = (base: typeof fetch, options: PoliteOptions = {}): typeof fetch => {
  const retries = options.retries ?? 4;
  const baseDelay = options.baseDelayMs ?? 1000;
  const timeout = options.timeoutMs ?? 10_000;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let body = init?.body;
    if (options.rewriteJson) {
      const text = typeof body === "string" ? body : input instanceof Request && body === undefined ? await input.clone().text() : undefined;
      const parsed = text === undefined ? undefined : (JSON.parse(text) as unknown);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`cannot rewrite the request body for ${url}: not a JSON object string`);
      body = JSON.stringify(options.rewriteJson(url, parsed as Record<string, unknown>));
    }
    for (let attempt = 0; ; attempt++) {
      const signal = AbortSignal.timeout(timeout);
      const request = input instanceof Request ? input.clone() : input;
      const response = await base(request, { ...init, ...(body === undefined ? {} : { body }), signal });
      if (response.status !== 429 || attempt >= retries) return response;
      await response.body?.cancel();
      const header = response.headers.get("retry-after");
      const seconds = header === null ? NaN : Number(header);
      const fromDate = header === null || Number.isFinite(seconds) ? NaN : Date.parse(header) - Date.now();
      const wait = Math.min(30_000, Math.max(0, Number.isFinite(seconds) ? seconds * 1000 : Number.isFinite(fromDate) ? fromDate : baseDelay * 2 ** attempt * (1 + Math.random() / 4)));
      options.onWait?.(wait);
      await sleep(wait);
    }
  }) as typeof fetch;
};

/** Perplexity's fast tier is the same POST /search with search_type "fast" (docs.perplexity.ai/api-reference/search-post, read 2026-10-18). */
const perplexityFast = (url: string, body: Record<string, unknown>) => (new URL(url).hostname.endsWith("perplexity.ai") ? { ...body, search_type: "fast" } : body);

export interface ArmToRun {
  readonly arm: ArmName;
  readonly apiKey: string;
}

/** Every query × run for each arm (arms side by side, `concurrency` calls per arm), scored as it lands. */
export const runArms = async (options: {
  readonly queries: ReadonlyArray<Query>;
  readonly arms: ReadonlyArray<ArmToRun>;
  readonly runs: number;
  readonly concurrency: number;
  readonly search: RunProviderSearch;
  readonly fetchImpl?: typeof fetch;
  readonly polite?: Omit<PoliteOptions, "onWait" | "rewriteJson">;
  readonly log?: (line: string) => void;
}): Promise<Map<ArmName, Array<QueryOutcome>>> => {
  const base = options.fetchImpl ?? fetch;
  const out = new Map<ArmName, Array<QueryOutcome>>();
  await Promise.all(
    options.arms.map(async ({ arm, apiKey }) => {
      const outcomes = options.queries.map((q): QueryOutcome => ({ id: q.id, bucket: q.bucket, runs: [] }));
      out.set(arm, outcomes);
      for (let run = 0; run < options.runs; run++) {
        let errors = 0;
        await pool(options.queries, options.concurrency, async (q, i) => {
          let waited = 0;
          const fetchImpl = politeFetch(base, { ...options.polite, onWait: (ms) => (waited += ms), ...(arm === "perplexity-fast" ? { rewriteJson: perplexityFast } : {}) });
          const started = performance.now();
          try {
            const response = await options.search(providerOf(arm), apiKey, { query: q.query, count: 10 }, fetchImpl);
            const latency = performance.now() - started - waited;
            const top = response.results.slice(0, 10);
            outcomes[i]!.runs[run] = {
              ok: true,
              rank: goldRank(top, q.gold_urls),
              answer: answerFound(top, q.answer),
              tokens: response.tokensApprox,
              latency_ms: latency,
              urls: top.map((r) => r.url),
              ...(typeof response.costUsd === "number" ? { usd_reported: response.costUsd } : {}),
            };
          } catch (error) {
            errors++;
            outcomes[i]!.runs[run] = { ok: false, rank: null, answer: false, tokens: 0, latency_ms: 0, urls: [], error: error instanceof Error ? error.message : String(error) };
          }
        });
        options.log?.(`${arm}: run ${run + 1}/${options.runs} done, ${options.queries.length} queries, ${errors} errors`);
      }
    }),
  );
  return out;
};

/** --limit takes queries round-robin across buckets, in file order within each, so a small run stays balanced. */
export const takeBalanced = (queries: ReadonlyArray<Query>, limit: number): Array<Query> => {
  const lanes = BUCKETS.map((b) => queries.filter((q) => q.bucket === b)).filter((lane) => lane.length > 0);
  const out: Array<Query> = [];
  for (let i = 0; out.length < Math.min(limit, queries.length); i++) for (const lane of lanes) if (lane[i] && out.length < limit) out.push(lane[i]!);
  return out;
};

export const loadQueries = (file: string): Array<Query> =>
  fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Query);

const HAIKU = "claude-haiku-5-5";
// List price, Claude Haiku 5.5 up to 100K input tokens, per million tokens (platform.claude.com pricing, read 2026-10-18).
const HAIKU_USD_PER_MTOK = { input: 0.1, output: 0.5 };

/**
 * Asks Claude Haiku 5.5 each query with no search and drops those whose answer already matches the
 * pattern. Raw fetch: the runtime package has no Anthropic SDK dependency, and this optional step is not
 * worth adding one (and a lockfile change) for.
 */
export const dropKnown = async (queries: ReadonlyArray<Query>, apiKey: string, concurrency: number, fetchImpl: typeof fetch = fetch): Promise<{ keep: Array<Query>; report: DropKnown }> => {
  const dropped = new Set<string>();
  let errors = 0;
  let usd = 0;
  const call = politeFetch(fetchImpl, { timeoutMs: 60_000 });
  await pool(queries, concurrency, async (q) => {
    try {
      const response = await call("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: HAIKU,
          max_tokens: 1024,
          thinking: { type: "disabled" },
          system: "Answer the developer's question from memory, in at most four sentences. Name the exact option, API, error cause, fix, issue or version. If you do not know, say so.",
          messages: [{ role: "user", content: q.query }],
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const message = (await response.json()) as { content?: Array<{ type: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
      usd += ((message.usage?.input_tokens ?? 0) * HAIKU_USD_PER_MTOK.input + (message.usage?.output_tokens ?? 0) * HAIKU_USD_PER_MTOK.output) / 1e6;
      const text = (message.content ?? []).flatMap((b) => (b.type === "text" && b.text ? [b.text] : [])).join("\n");
      if (new RegExp(q.answer, "i").test(text)) dropped.add(q.id);
    } catch {
      errors++;
    }
  });
  return {
    keep: queries.filter((q) => !dropped.has(q.id)),
    report: { status: "ran", model: HAIKU, checked: queries.length, dropped: queries.filter((q) => dropped.has(q.id)).map((q) => q.id), errors, usd },
  };
};

const main = async () => {
  const { values } = parseArgs({
    options: {
      arms: { type: "string", default: ARMS.join(",") },
      runs: { type: "string", default: "3" },
      limit: { type: "string" },
      bucket: { type: "string" },
      concurrency: { type: "string", default: "4" },
      "drop-known": { type: "boolean", default: false },
      seed: { type: "string", default: "1" },
      out: { type: "string", default: path.join(os.homedir(), ".cache", "caveman-web-eval") },
    },
  });
  const arms = values.arms.split(",").map((a) => a.trim()).filter(Boolean);
  for (const a of arms) if (!(ARMS as ReadonlyArray<string>).includes(a)) throw new Error(`unknown arm "${a}"; arms: ${ARMS.join(", ")}`);
  const buckets = values.bucket?.split(",").map((b) => b.trim());
  for (const b of buckets ?? []) if (!(BUCKETS as ReadonlyArray<string>).includes(b)) throw new Error(`unknown bucket "${b}"; buckets: ${BUCKETS.join(", ")}`);
  const runs = Number(values.runs);
  const concurrency = Number(values.concurrency);
  const seed = Number(values.seed);
  if (!(runs >= 1) || !(concurrency >= 1) || !Number.isInteger(seed)) throw new Error("--runs and --concurrency must be >= 1, --seed an integer");

  let queries = loadQueries(fileURLToPath(new URL("./queries.jsonl", import.meta.url))).filter((q) => !buckets || buckets.includes(q.bucket));
  if (values.limit !== undefined) {
    const limit = Number(values.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error("--limit must be a whole number >= 1");
    queries = takeBalanced(queries, limit);
  }

  let drop: DropKnown = { status: "off" };
  if (values["drop-known"]) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) drop = { status: "skipped", reason: "ANTHROPIC_API_KEY is not set" };
    else {
      const result = await dropKnown(queries, key, concurrency);
      queries = result.keep;
      drop = result.report;
      console.error(`drop-known: dropped ${result.report.dropped?.length} of ${result.report.checked} (${result.report.errors} errors)`);
    }
  }

  const toRun: Array<ArmToRun> = [];
  const skipped: Array<SkippedArm> = [];
  for (const arm of arms as Array<ArmName>) {
    const key = process.env[keyEnvOf(arm)];
    if (key) toRun.push({ arm, apiKey: key });
    else skipped.push({ arm, status: "skipped", reason: `no ${keyEnvOf(arm)}` });
  }

  let outcomes = new Map<ArmName, Array<QueryOutcome>>();
  if (toRun.length > 0) {
    let search: RunProviderSearch;
    try {
      ({ runProviderSearch: search } = (await import(new URL("../../src/web/providers.ts", import.meta.url).href)) as { runProviderSearch: RunProviderSearch });
      if (typeof search !== "function") throw new Error("src/web/providers.ts does not export runProviderSearch");
    } catch (error) {
      console.error(`Cannot load runProviderSearch from packages/runtime/src/web/providers.ts (it lands with src/web): ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
    outcomes = await runArms({ queries, arms: toRun, runs, concurrency, search, log: (line) => console.error(line) });
  }

  const summaries: Array<ArmSummary | SkippedArm> = (arms as Array<ArmName>).map((arm) => {
    const ran = outcomes.get(arm);
    return ran ? summariseArm(arm, ran, { seed }) : skipped.find((s) => s.arm === arm)!;
  });
  const { order, reasons } = recommendOrder(summaries, 5);
  const at = new Date().toISOString();
  const byBucket: Partial<Record<Bucket, number>> = {};
  for (const q of queries) byBucket[q.bucket] = (byBucket[q.bucket] ?? 0) + 1;
  const input = { at, queries: queries.length, by_bucket: byBucket, runs, count: 10, drop_known: drop, arms: summaries, order, reasons, tie_points: 5 };
  console.log(markdownReport(input));

  fs.mkdirSync(values.out, { recursive: true });
  const file = path.join(values.out, `${at.replace(/[:.]/g, "-")}.json`);
  const report = {
    ...input,
    labels: {
      measured: ["recall", "answer", "tokens_mean", "latency_p50_ms", "latency_p95_ms", "errors", "intervals", "usd_reported_per_query", "drop_known.dropped"],
      verified: ["prices"],
      inferred: ["usd_total", "usd_per_correct", "drop_known.usd"],
    },
    config: { arms, runs, concurrency, limit: values.limit === undefined ? null : Number(values.limit), buckets: buckets ?? null, seed, resamples: 2000, decision: "answer rates under 5 points apart tie; a tie goes to the cheaper arm" },
    prices: PRICES,
    details: Object.fromEntries([...outcomes].map(([arm, rows]) => [arm, rows])),
  };
  fs.writeFileSync(file, `${JSON.stringify(report, null, 1)}\n`);
  console.error(`report: ${file}`);
  process.exit(toRun.length === 0 ? 2 : 0);
};

if (import.meta.main) await main();
