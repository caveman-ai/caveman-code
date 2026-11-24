// Scoring for the search-provider eval (web-eval.ts): URL matching, the answer check, latency
// percentiles, seeded bootstrap intervals, list prices, the decision rule and the markdown report.
// Pure functions only, so the tests can drive them with a fake runProviderSearch.

export const BUCKETS = ["api", "error", "issue", "config", "changelog"] as const;
export type Bucket = (typeof BUCKETS)[number];

export interface Query {
  readonly id: string;
  readonly bucket: Bucket;
  readonly query: string;
  /** URL prefixes that count as a hit (see matchesPrefix). Each one was checked to carry the answer. */
  readonly gold_urls: ReadonlyArray<string>;
  /** RegExp source, matched case-insensitively against the concatenated excerpts. */
  readonly answer: string;
  readonly note?: string;
}

export const ARMS = ["brave", "perplexity", "perplexity-fast", "exa"] as const;
export type ArmName = (typeof ARMS)[number];
export type Provider = "brave" | "perplexity" | "exa";

export interface SearchResult {
  readonly url: string;
  readonly title: string;
  readonly date?: string;
  readonly excerpts: ReadonlyArray<string>;
}
export interface SearchResponse {
  readonly results: ReadonlyArray<SearchResult>;
  readonly tokensApprox: number;
  /** What the provider says the call cost, when it says (Exa's costDollars). */
  readonly costUsd?: number;
}

/**
 * List prices per query, verified on the vendors' pages on 2026-10-18 (each arm's
 * `source` below; the providers themselves are src/web/providers.ts). A run's cost is these times its successful calls:
 * inferred, not a bill.
 */
export const PRICES: Record<ArmName, { readonly usd_per_query: number; readonly basis: string; readonly source: string; readonly read: string }> = {
  brave: {
    usd_per_query: 5 / 1000,
    basis: "Search plan, $5 per 1,000 requests; LLM Context is a Search-plan endpoint",
    source: "https://brave.com/search/api/",
    read: "2026-10-18",
  },
  perplexity: {
    usd_per_query: 5 / 1000,
    basis: "Search API, $5 per 1,000 successful requests, no token costs",
    source: "https://docs.perplexity.ai/getting-started/pricing",
    read: "2026-10-18",
  },
  "perplexity-fast": {
    usd_per_query: 1 / 1000,
    basis: 'Search API with search_type "fast", $1 per 1,000 requests',
    source: "https://docs.perplexity.ai/getting-started/pricing",
    read: "2026-10-18",
  },
  exa: {
    usd_per_query: 7 / 1000,
    basis: "/search type auto, $7 per 1,000 requests with up to 10 results; highlights in /search are not billed per page (/contents and AI summaries are). Assumes the adapter sends type auto, as docs/ says",
    source: "https://exa.ai/pricing",
    read: "2026-10-18",
  },
};

export const providerOf = (arm: ArmName): Provider => (arm === "perplexity-fast" ? "perplexity" : arm);
export const keyEnvOf = (arm: ArmName) => `${providerOf(arm).toUpperCase()}_API_KEY` as const;

/**
 * A URL as compared: no scheme, no `www.`, no fragment, no trailing slash, lower case, and a GitHub
 * `/pull/<n>` read as `/issues/<n>` (one number space; GitHub redirects between them).
 */
export const normaliseUrl = (raw: string): string => {
  const text = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return text.toLowerCase();
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "") + (parsed.port ? `:${parsed.port}` : "");
  let path = parsed.pathname.replace(/\/+$/, "");
  if (host === "github.com") path = path.replace(/^(\/[^/]+\/[^/]+)\/pull\/(\d+)/i, "$1/issues/$2");
  return `${host}${path}${parsed.search}`.toLowerCase();
};

/** A prefix hits at a path boundary: `/issues/123` hits `/issues/123/files` and `/issues/123?x`, not `/issues/1234`. */
export const matchesPrefix = (url: string, prefix: string): boolean => {
  const u = normaliseUrl(url);
  const p = normaliseUrl(prefix);
  if (u === p) return true;
  return u.startsWith(`${p}/`) || u.startsWith(p.includes("?") ? `${p}&` : `${p}?`);
};

/** 1-based rank of the first result in the top `k` that hits a gold prefix; null when none does. */
export const goldRank = (results: ReadonlyArray<SearchResult>, gold: ReadonlyArray<string>, k = 10): number | null => {
  const index = results.slice(0, k).findIndex((r) => gold.some((g) => matchesPrefix(r.url, g)));
  return index < 0 ? null : index + 1;
};

/** Whether the answer pattern appears in the concatenated excerpts of the top `k` results (titles don't count). */
export const answerFound = (results: ReadonlyArray<SearchResult>, pattern: string, k = 10): boolean =>
  new RegExp(pattern, "i").test(results.slice(0, k).flatMap((r) => r.excerpts).join("\n"));

/** Nearest-rank percentile; null for no samples. */
export const percentile = (values: ReadonlyArray<number>, p: number): number | null => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!;
};

/** mulberry32: a small seeded PRNG, so an interval is reproducible from its seed. */
export const seeded = (seed: number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export interface Interval {
  readonly mean: number;
  readonly lo: number;
  readonly hi: number;
}

/** Percentile bootstrap of the mean over queries (resampled with replacement); 95% by default. */
export const bootstrap = (values: ReadonlyArray<number>, options: { readonly seed: number; readonly resamples?: number; readonly level?: number }): Interval | null => {
  const n = values.length;
  if (n === 0) return null;
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const random = seeded(options.seed);
  const means: Array<number> = [];
  for (let b = 0; b < resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(random() * n)]!;
    means.push(sum / n);
  }
  means.sort((x, y) => x - y);
  const tail = (1 - level) / 2;
  return {
    mean: values.reduce((s, v) => s + v, 0) / n,
    lo: means[Math.floor(tail * resamples)]!,
    hi: means[Math.min(resamples - 1, Math.ceil((1 - tail) * resamples) - 1)]!,
  };
};

export interface CallOutcome {
  readonly ok: boolean;
  readonly rank: number | null;
  readonly answer: boolean;
  readonly tokens: number;
  /** Time in runProviderSearch minus time spent waiting out 429s. */
  readonly latency_ms: number;
  readonly urls: ReadonlyArray<string>;
  /** The provider's own figure for the call, when it gives one. */
  readonly usd_reported?: number;
  readonly error?: string;
}
export interface QueryOutcome {
  readonly id: string;
  readonly bucket: Bucket;
  /** One entry per run, in run order. */
  readonly runs: Array<CallOutcome>;
}

export interface Rates {
  readonly n: number;
  readonly recall: Interval | null;
  readonly answer: Interval | null;
}
export interface ArmSummary {
  readonly arm: ArmName;
  readonly status: "ran";
  readonly queries: number;
  readonly calls: number;
  readonly errors: number;
  readonly recall: Interval | null;
  readonly answer: Interval | null;
  readonly tokens_mean: number | null;
  readonly latency_p50_ms: number | null;
  readonly latency_p95_ms: number | null;
  readonly usd_per_query: number;
  readonly usd_total: number;
  readonly correct_calls: number;
  readonly usd_per_correct: number | null;
  /** Mean of the provider's own per-call cost, when every successful call reported one (measured). */
  readonly usd_reported_per_query: number | null;
  readonly by_bucket: Partial<Record<Bucket, Rates>>;
}
export interface SkippedArm {
  readonly arm: ArmName;
  readonly status: "skipped";
  readonly reason: string;
}

const mean = (values: ReadonlyArray<number>) => (values.length === 0 ? 0 : values.reduce((s, v) => s + v, 0) / values.length);

/** A query's score is the share of its runs that hit (or found the answer); a failed call scores 0. */
const rates = (outcomes: ReadonlyArray<QueryOutcome>, seed: number, resamples: number): Rates => ({
  n: outcomes.length,
  recall: bootstrap(outcomes.map((q) => mean(q.runs.map((r) => (r.ok && r.rank !== null ? 1 : 0)))), { seed, resamples }),
  answer: bootstrap(outcomes.map((q) => mean(q.runs.map((r) => (r.ok && r.answer ? 1 : 0)))), { seed, resamples }),
});

export const summariseArm = (arm: ArmName, outcomes: ReadonlyArray<QueryOutcome>, options: { readonly seed: number; readonly resamples?: number }): ArmSummary => {
  const resamples = options.resamples ?? 2000;
  const calls = outcomes.flatMap((q) => q.runs);
  const ok = calls.filter((c) => c.ok);
  const correct = ok.filter((c) => c.answer).length;
  const price = PRICES[arm].usd_per_query;
  const usdTotal = price * ok.length;
  const byBucket: Partial<Record<Bucket, Rates>> = {};
  for (const bucket of BUCKETS) {
    const inBucket = outcomes.filter((q) => q.bucket === bucket);
    if (inBucket.length > 0) byBucket[bucket] = rates(inBucket, options.seed, resamples);
  }
  const all = rates(outcomes, options.seed, resamples);
  return {
    arm,
    status: "ran",
    queries: outcomes.length,
    calls: calls.length,
    errors: calls.length - ok.length,
    recall: all.recall,
    answer: all.answer,
    tokens_mean: ok.length === 0 ? null : mean(ok.map((c) => c.tokens)),
    latency_p50_ms: percentile(ok.map((c) => c.latency_ms), 50),
    latency_p95_ms: percentile(ok.map((c) => c.latency_ms), 95),
    usd_per_query: price,
    usd_total: usdTotal,
    correct_calls: correct,
    usd_per_correct: correct === 0 ? null : usdTotal / correct,
    usd_reported_per_query: ok.length > 0 && ok.every((c) => c.usd_reported !== undefined) ? mean(ok.map((c) => c.usd_reported!)) : null,
    by_bucket: byBucket,
  };
};

const points = (rate: number) => Math.round(rate * 1e6) / 1e4;
const pct = (rate: number | undefined | null, digits = 1) => (rate === undefined || rate === null ? "–" : `${(rate * 100).toFixed(digits)}%`);
const usd = (value: number | null) => (value === null ? "–" : `$${value < 0.01 ? value.toFixed(4) : value.toFixed(3)}`);

/**
 * The spec's rule (docs/): answer rates under `tiePoints` apart are a tie, and a tie goes to
 * the cheaper arm. Greedy, so it is well defined when ties chain: take the best remaining answer rate,
 * gather every arm within `tiePoints` of it, put the cheapest of those next (same price: higher answer
 * rate, then higher recall, then name). Arms that skipped, or whose every call failed, are left out.
 */
export const recommendOrder = (summaries: ReadonlyArray<ArmSummary | SkippedArm>, tiePoints = 5): { readonly order: Array<ArmName>; readonly reasons: Array<string> } => {
  const remaining = summaries.filter((s): s is ArmSummary => s.status === "ran" && s.calls > s.errors && s.answer !== null);
  const order: Array<ArmName> = [];
  const reasons: Array<string> = [];
  const acc = (s: ArmSummary) => s.answer!.mean;
  while (remaining.length > 0) {
    const top = remaining.reduce((best, s) => (acc(s) > acc(best) ? s : best));
    const band = remaining.filter((s) => points(acc(top)) - points(acc(s)) < tiePoints);
    band.sort((a, b) => a.usd_per_query - b.usd_per_query || acc(b) - acc(a) || (b.recall?.mean ?? 0) - (a.recall?.mean ?? 0) || a.arm.localeCompare(b.arm));
    const pick = band[0]!;
    const rivals = band.filter((s) => s !== pick);
    let why = `${pick.arm}: answer ${pct(acc(pick))}, recall@10 ${pct(pick.recall?.mean)}, ${usd(pick.usd_per_query)}/query`;
    if (rivals.length > 0) {
      const tied = rivals.map((s) => `${s.arm} (${pct(acc(s))}, ${Math.abs(points(acc(pick)) - points(acc(s))).toFixed(1)} pts)`).join(", ");
      why += pick.usd_per_query < Math.min(...rivals.map((s) => s.usd_per_query)) ? `; ties with ${tied} and is cheaper` : `; ties with ${tied} at the same or higher price and leads on answer rate`;
    }
    reasons.push(why);
    order.push(pick.arm);
    remaining.splice(remaining.indexOf(pick), 1);
  }
  return { order, reasons };
};

export interface DropKnown {
  readonly status: "ran" | "skipped" | "off";
  readonly reason?: string;
  readonly model?: string;
  readonly checked?: number;
  readonly dropped?: ReadonlyArray<string>;
  readonly errors?: number;
  readonly usd?: number;
}

export interface ReportInput {
  readonly at: string;
  readonly queries: number;
  readonly by_bucket: Partial<Record<Bucket, number>>;
  readonly runs: number;
  readonly count: number;
  readonly drop_known: DropKnown;
  readonly arms: ReadonlyArray<ArmSummary | SkippedArm>;
  readonly order: ReadonlyArray<ArmName>;
  readonly reasons: ReadonlyArray<string>;
  readonly tie_points: number;
}

const interval = (i: Interval | null) => (i === null ? "–" : `${pct(i.mean)} (${(i.lo * 100).toFixed(1)}–${(i.hi * 100).toFixed(1)})`);
const ms = (value: number | null) => (value === null ? "–" : `${Math.round(value)}`);

export const markdownReport = (r: ReportInput): string => {
  const lines: Array<string> = [];
  const buckets = BUCKETS.filter((b) => (r.by_bucket[b] ?? 0) > 0);
  lines.push(`## Web search eval, ${r.at}`, "");
  lines.push(`${r.queries} queries (${buckets.map((b) => `${b} ${r.by_bucket[b]}`).join(", ")}), ${r.runs} run${r.runs === 1 ? "" : "s"} per query per arm, ${r.count} results per query.`);
  const dk = r.drop_known;
  lines.push(
    dk.status === "ran"
      ? `Dropped as known without search: ${dk.dropped?.length ?? 0} of ${dk.checked} (${dk.model}, ${dk.errors ?? 0} errors, ${usd(dk.usd ?? 0)} inferred).`
      : dk.status === "skipped"
        ? `Drop-known skipped: ${dk.reason}.`
        : "Drop-known off (pass --drop-known).",
  );
  lines.push("Labels: measured = recall, answer, tokens, latency and intervals from this run; verified = list prices, read on the vendor pages; inferred = cost (list price × successful calls, not a bill).", "");
  lines.push("| Arm | Status | Recall@10 [95% CI] (measured) | Answer in excerpts [95% CI] (measured) | Tokens/query (measured) | p50 ms (measured) | p95 ms (measured) | $/query (verified list) | $/correct (inferred) | Errors (measured) |");
  lines.push("|---|---|---|---|---|---|---|---|---|---|");
  for (const s of r.arms) {
    if (s.status === "skipped") {
      lines.push(`| ${s.arm} | skipped: ${s.reason} | – | – | – | – | – | ${usd(PRICES[s.arm].usd_per_query)} | – | – |`);
      continue;
    }
    lines.push(`| ${s.arm} | ran | ${interval(s.recall)} | ${interval(s.answer)} | ${s.tokens_mean === null ? "–" : Math.round(s.tokens_mean)} | ${ms(s.latency_p50_ms)} | ${ms(s.latency_p95_ms)} | ${usd(s.usd_per_query)} | ${usd(s.usd_per_correct)} | ${s.errors}/${s.calls} |`);
  }
  const ran = r.arms.filter((s): s is ArmSummary => s.status === "ran");
  for (const s of ran) if (s.usd_reported_per_query !== null) lines.push("", `${s.arm} reported its own cost: ${usd(s.usd_reported_per_query)}/query (measured, provider-reported), against ${usd(s.usd_per_query)} list.`);
  if (ran.length > 0) {
    lines.push("", "### By bucket: recall@10 / answer (measured)", "");
    lines.push(`| Bucket | n | ${ran.map((s) => s.arm).join(" | ")} |`);
    lines.push(`|---|---|${ran.map(() => "---").join("|")}|`);
    for (const b of buckets) lines.push(`| ${b} | ${r.by_bucket[b]} | ${ran.map((s) => `${pct(s.by_bucket[b]?.recall?.mean, 0)} / ${pct(s.by_bucket[b]?.answer?.mean, 0)}`).join(" | ")} |`);
  }
  lines.push("", `### Recommended order (answer rates under ${r.tie_points} points apart tie; a tie goes to the cheaper arm)`, "");
  if (r.order.length === 0) lines.push("None: no arm ran. Set BRAVE_API_KEY, PERPLEXITY_API_KEY or EXA_API_KEY.");
  r.reasons.forEach((why, i) => lines.push(`${i + 1}. ${why}`));
  return `${lines.join("\n")}\n`;
};
