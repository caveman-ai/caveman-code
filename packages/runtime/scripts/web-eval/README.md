# web-eval: which search provider the Caveman engine uses first

The eval behind `docs/` ("Choosing the provider: the eval"). It sends
coding queries to each search provider through the runtime's own adapter,
`runProviderSearch` in `src/web/providers.ts`, and scores what comes back.

## Run it

From `packages/runtime`, with the keys you have in the environment (never from
a keychain or a file):

```sh
BRAVE_API_KEY=… PERPLEXITY_API_KEY=… EXA_API_KEY=… node scripts/web-eval/web-eval.ts
```

| Flag | Default | What it does |
|---|---|---|
| `--arms` | `brave,perplexity,perplexity-fast,exa` | arms to run; one without its key is skipped and reported as skipped |
| `--runs` | `3` | runs per query per arm (latency percentiles pool all runs) |
| `--limit N` | all | first N queries, taken round-robin across buckets |
| `--bucket` | all | `api,error,issue,config,changelog`, comma-separated |
| `--concurrency` | `4` | calls in flight per arm; a 429 is waited out (Retry-After, else backoff, 4 retries) |
| `--drop-known` | off | with `ANTHROPIC_API_KEY`, asks Claude Haiku 5.5 each query without search and drops the ones it already answers; skipped cleanly without the key |
| `--seed` | `1` | bootstrap seed |
| `--out` | `~/.cache/caveman-web-eval` | where the JSON report goes |

A quick check before a full run: `--limit 20 --runs 1`. It prints a markdown
table to stdout and writes `<out>/<timestamp>.json` (config, prices with
sources, every summary, and per query and run: gold rank, answer found, tokens,
latency, the URLs returned, the error if any). Exit code 2 means no arm had a
key; exit code 1 means `src/web/providers.ts` isn't there yet.

The eval owns the timeout, 10 s per attempt like the adapter, so waiting out
a 429 never counts against a provider. `perplexity-fast` is the Perplexity adapter with `search_type: "fast"` set on
the request body (the eval wraps the adapter's `fetch`), per
<https://docs.perplexity.ai/api-reference/search-post>.

Tests (scoring, decision rule, runner with a fake adapter, query-set shape):
`npx vitest run scripts/web-eval`.

## What a run costs

Inferred: list price × calls, prices read on the vendors' pages on
2026-10-18 (sources in `score.ts`, `PRICES`). A full run is 200 queries × 3
runs = 600 calls per arm.

| Arm | List price | Full run (600 calls) | `--limit 20 --runs 1` |
|---|---|---|---|
| brave | $5 / 1k | $3.00 | $0.10 |
| perplexity | $5 / 1k | $3.00 | $0.10 |
| perplexity-fast | $1 / 1k | $0.60 | $0.02 |
| exa (auto, highlights) | $7 / 1k | $4.20 | $0.14 |
| all four | | $10.80 | $0.36 |

Exa's pricing page (read 2026-10-18) bills `/search` at $7 / 1k with up to
10 results, highlights included, and only AI summaries on top; that is the
table's price and `src/web/providers.ts`'s ($0.007 a call). The eval records
Exa's own `costDollars` per call and prints it beside the list price, so the
first real run checks it.

`--drop-known` adds about $0.03 (200 short Haiku calls at $0.10 / $0.50 per
million tokens). A full run (600 searches an arm) is about $3 per arm at
$5 / 1k, $4.20 for Exa: the spec's figure.

## Reading the result

- **Recall@10**: a result in the top 10 starts with a gold URL prefix. URLs
  are compared without scheme, `www.`, fragment, trailing slash or case, at a
  path boundary (`/issues/123` does not hit `/issues/1234`), and a GitHub
  `/pull/N` counts as `/issues/N`.
- **Answer in excerpts**: the query's answer pattern matches the concatenated
  excerpts of the top 10 (titles don't count). This is the number the order
  is decided on: it is what reaches the model.
- A query's score is the share of its runs that hit; a failed call scores 0
  and is counted under Errors. Rates are means over queries with 95%
  percentile-bootstrap intervals (2,000 resamples over queries, seeded, so a
  rerun of the same data gives the same interval).
- **Tokens/query** is the adapter's `tokensApprox`; **latency** is p50/p95
  (nearest rank) over successful calls, with time spent waiting out 429s
  left out.
- **$/correct** is the arm's list-price spend over the calls whose excerpts
  carried the answer.
- Labels: measured (this run), verified (a list price read on the vendor's
  page), inferred (computed from list prices, not a bill).
- **Recommended order**: answer rates under 5 points apart are a tie, and a
  tie goes to the cheaper arm (same price: higher answer rate, then recall).
  With 200 queries an interval is roughly ±7 points, so read a tie as "no
  measured difference", not as "equal".

Rerun weekly; the default order in docs/ follows the result.

## The queries

`queries.jsonl`, one per line:
`{ id, bucket, query, gold_urls, answer, note? }`. Buckets: `api`
(version-specific APIs), `error` (verbatim error messages), `issue` (a
specific GitHub issue or PR), `config` (config options), `changelog` (what
changed in X version Y), across TS/JS, Python, Go, Rust and infra, mostly
2025–2026 facts.

200 queries, 40 per bucket, 335 gold URLs. Every gold URL was fetched on
2026-10-18 (GitHub issues and PRs read through the API, title, body and
comments) and answered 200 with the answer pattern on the page; the pattern
never matches the query itself, and no two queries share a fact. A wrong gold label is
worse than a missing query, so anything that couldn't be checked was left out.
Pages move: when a gold URL stops answering, fix or drop the line rather than
widening the prefix.

## Readers: what web_fetch reads pages with

`readers.ts` reads a fixed set of real pages (docs, JavaScript apps, sites that
block bots, a PDF) with each reader and checks for a phrase from the page's own
content. It is behind the choice in `docs/` ("Reading
through Firecrawl") to read with Firecrawl Local first when it is installed.

```sh
# from packages/runtime; Firecrawl Local found as the runtime finds it
node scripts/web-eval/readers.ts --runs 2 \
  --chrome ~/.caveman-code/tools/chrome-headless-shell/<platform>/<version>/chrome-headless-shell
```

| Arm | What it is |
|---|---|
| `direct` | the runtime's own request and reader (`fetchPublic`, `toPage`) |
| `local` | Firecrawl Local through the runtime's own manager (`makeFirecrawlLocal`), Firecrawl Cloud off; skipped when it is not installed |
| `chromium` | the runtime's headless Chromium, the page rendered, then the runtime's reader; only with `--chrome` |

It prints a markdown table (pages read per kind, p50 and p90 latency) and
writes every read to `~/.cache/caveman-web-eval/readers-<timestamp>.json`. The
pages are live sites, so a rerun moves with them: a site that starts or stops
blocking changes the count.
