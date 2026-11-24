/*
 * What the model picker knows about a model beyond its name: how smart it is and what it costs, by effort
 * (STYLE.md 11, "Smarts and cost"). A dated snapshot, never a guess: a model that is not here
 * shows no meter.
 *
 * runs: Artificial Analysis Intelligence Index and its measured cost per task in USD, by effort
 * (artificialanalysis.ai/leaderboards/models, read 2026-10-20; their terms ask for the attribution the card
 * shows). The run without an effort name is the one effort they measured; a $0 run (unmeasured) is left
 * out. price: list USD per 1M tokens, input, cached input, output; context: input tokens (LiteLLM
 * model_prices_and_context_window.json, 2026-10-20). Refresh both together and move MODEL_FACTS_AS_OF.
 */

export type ModelRun = readonly [intelligence: number, usdPerTask: number];
export type ModelFacts = {
  readonly runs: Readonly<Record<string, ModelRun>>;
  readonly price?: readonly [input: number, cachedInput: number, output: number];
  readonly context?: number;
};

export const MODEL_FACTS_AS_OF = "2026-10-20";

// prettier-ignore
const FACTS: Readonly<Record<string, ModelFacts>> = {
  "apodex-1-1": { runs: { "": [26, 0.46] } },
  "celeris-1": { runs: { "": [6, 0.05] } },
  "claude-fable-5-1": { runs: { low: [47, 2.37], medium: [49, 2.98], high: [51, 3.91], xhigh: [53, 5.98], max: [53, 7.63] }, price: [10, 0.25, 50], context: 1000000 },
  "claude-haiku-5-5": { runs: { low: [29, 0.02], medium: [34, 0.05], high: [38, 0.08], xhigh: [41, 0.12], max: [43, 0.21] }, price: [0.1, 0.01, 0.5], context: 1000000 },
  "claude-opus-5-5": { runs: { low: [42, 0.55], medium: [51, 1.34], high: [54, 1.82], xhigh: [56, 3.46], max: [58, 5.98] }, price: [4, 0.2, 20], context: 1000000 },
  "claude-sonnet-5-5": { runs: { low: [36, 0.35], medium: [41, 0.48], high: [47, 0.88], xhigh: [52, 2.01], max: [56, 5.46] }, price: [2, 0.1, 10], context: 1000000 },
  "deepseek-v4-1-flash-1017": { runs: { max: [45, 0.26] }, price: [0.14, 0.0042, 0.42], context: 1048576 },
  "deepseek-v4-flash-vision": { runs: { max: [35, 1.04] } },
  "deepseek-v4-pro": { runs: { none: [20, 0.36], max: [36, 0.67] }, price: [1.32, 0.044, 3.96], context: 1000000 },
  "gemini-3-1-pro-preview": { runs: { "": [30, 1.3] }, price: [2, 0.2, 12], context: 1048576 },
  "gemini-3-5-flash-lite": { runs: { "": [22, 0.19] }, price: [0.3, 0.03, 2.5], context: 1048576 },
  "gemini-3-8-flash": { runs: { medium: [40, 0.93], high: [41, 1.24] }, price: [0.75, 0.075, 3.75], context: 1048576 },
  "gemini-4-argon": { runs: { high: [53, 1.99] }, price: [2, 0.1, 10], context: 1048576 },
  "gemma-4-e4b": { runs: { "": [9, 0.01] } },
  "glm-5-3": { runs: { low: [34, 0.85], max: [45, 2.01] }, price: [1.12, 0, 4.4], context: 1048576 },
  "glm-5-3-flash": { runs: { "": [42, 0.28] }, price: [0.11, 0.02, 0.35], context: 1048576 },
  "gpt-5-5-instant-06-26": { runs: { "": [26, 0.69] } },
  "gpt-5-6-terra": { runs: { none: [21, 0.14], low: [27, 0.14], medium: [30, 0.18], high: [34, 0.34], xhigh: [38, 0.63], max: [42, 1.4] }, price: [2, 0.2, 12], context: 922000 },
  "gpt-6-1-sol": { runs: { low: [42, 0.13], medium: [48, 0.21], high: [50, 0.32], xhigh: [51, 0.39], max: [52, 0.72] }, price: [2, 0.1, 10], context: 922000 },
  "gpt-6-astra": { runs: { low: [46, 0.82], medium: [50, 1.54], high: [51, 1.73], xhigh: [52, 2.31], max: [53, 3.26] }, price: [10, 1, 50], context: 922000 },
  "gpt-6-luna": { runs: { none: [18, 0.01], low: [22, 0.0045], medium: [30, 0.02], high: [33, 0.03], xhigh: [35, 0.04], max: [38, 0.07] }, price: [0.1, 0.01, 0.5], context: 922000 },
  "gpt-oss-120b": { runs: { high: [12, 0.11] }, price: [0.15, 0.15, 0.6], context: 131072 },
  "gpt-oss-20b": { runs: { high: [9, 0.01] }, price: [0.2, 0.2, 0.3], context: 128000 },
  "granite-4-2-30b": { runs: { "": [13, 0.07] } },
  "granite-4-2-3b": { runs: { "": [9, 0.01] } },
  "granite-4-2-8b": { runs: { "": [11, 0.02] }, price: [0.1, 0.05, 0.15], context: 131000 },
  "grok-4-7": { runs: { low: [42, 1.25], high: [46, 2.73], xhigh: [46, 3.74] }, price: [2, 0.5, 6], context: 500000 },
  "hy3": { runs: { "": [25, 0.07] }, price: [0.14, 0.035, 0.58], context: 262144 },
  "inkling-small": { runs: { "": [26, 0.09] }, price: [0.45, 0.1, 1.2], context: 524288 },
  "kimi-k2-7-code": { runs: { "": [26, 0.54] }, price: [0.95, 0.19, 4], context: 262144 },
  "kimi-k3": { runs: { low: [30, 1.15], max: [44, 2] }, price: [2.5, 0.25, 12.5], context: 1048576 },
  "ling-3-1-flash": { runs: { "": [41, 1] } },
  "llama-4-maverick": { runs: { "": [9, 0.04] }, price: [0.2, 0.2, 0.6], context: 131072 },
  "llama-4-scout": { runs: { "": [6, 0.11] }, price: [0.1, 0.1, 0.3], context: 131072 },
  "longcat-2-0": { runs: { "": [19, 0.15] }, price: [0.7746, 0.0155, 3.0984], context: 1000000 },
  "mercury-2-5": { runs: { "": [12, 0.12] }, price: [0.2, 0.02, 0.75], context: 260000 },
  "mimo-v2-6-flash": { runs: { "": [38, 0.06] }, price: [0.14, 0.0028, 0.28], context: 1048576 },
  "mimo-v2-6-pro": { runs: { "": [46, 0.13] }, price: [0.435, 0.0036, 0.87], context: 1048576 },
  "minimax-m3": { runs: { "": [29, 0.51] }, price: [0.3, 0.06, 1.2], context: 512000 },
  "minimax-m3-1-flash": { runs: { "": [43, 0.22] } },
  "ministral-3-14b": { runs: { "": [6, 0.02] } },
  "ministral-3-3b": { runs: { "": [5, 0.01] } },
  "ministral-3-8b": { runs: { "": [5, 0.01] } },
  "mistral-large-4": { runs: { "": [38, 1.13] }, price: [0.68, 0.068, 2.09], context: 1048576 },
  "mistral-medium-3-5": { runs: { "": [14, 0.5] }, price: [1.5, 0.15, 7.5], context: 262144 },
  "mistral-small-4": { runs: { "": [11, 0.02] } },
  "muse-glimmer": { runs: { high: [17, 0.06] } },
  "muse-spark-1-3": { runs: { xhigh: [45, 1.37], max: [48, 1.6] }, price: [1.25, 0.15, 4.25], context: 1048576 },
  "muse-spark-open": { runs: { xhigh: [39, 0.84] }, price: [1.25, 0.15, 4.25], context: 1048576 },
  "muse-wonder": { runs: { max: [52, 4.52] } },
  "nemotron-3-5-lightning": { runs: { "": [13, 0.08] } },
  "nemotron-3-5-super-vl": { runs: { "": [26, 0.19] } },
  "nvidia-nemotron-3-nano-30b-a3b-reasoning": { runs: { "": [9, 0.02] } },
  "nvidia-nemotron-3-ultra-550b-a55b": { runs: { "": [23, 0.58] }, price: [0.5, 0.1, 2.15], context: 262000 },
  "quasar-438b": { runs: { max: [27, 2.02] } },
  "qwen3-5-122b-a10b": { runs: { "": [16, 0.32] }, price: [0.25, 0.25, 1.75], context: 262144 },
  "qwen3-5-397b-a17b": { runs: { "": [18, 0.47] }, price: [0.6, 0.6, 3.6], context: 262144 },
  "qwen3-5-9b": { runs: { "": [11, 0.21] }, price: [0.17, 0.17, 0.25], context: 262144 },
  "qwen3-6-35b-a3b": { runs: { "": [18, 0.48] }, price: [0.05, 0.02, 0.4], context: 262144 },
  "qwen3-7-plus": { runs: { "": [25, 0.22] }, price: [0.32, 0.32, 1.28], context: 1000000 },
  "qwen3-8-2-4t-a95b": { runs: { "": [40, 2.16] }, price: [2, 0.25, 6], context: 1010000 },
  "qwen3-8-27b": { runs: { none: [20, 2.49], low: [26, 1.05], medium: [28, 1.13], xhigh: [34, 1.01] }, price: [0.45, 0.45, 3], context: 262144 },
  "qwen3-8-flash-next": { runs: { "": [40, 0.37] } },
  "qwen3-8-max": { runs: { "": [45, 5.41] }, price: [2, 0.25, 6], context: 991808 },
  "qwen3-coder-next": { runs: { "": [9, 0.47] }, price: [0.2, 0.2, 1.5], context: 262144 },
  "reflection-beam": { runs: { "": [30, 0.57] } },
  "ring-2-6-1t": { runs: { "": [17, 0.29] } },
  "solar-mini4": { runs: { "": [24, 0.37] } },
  "solar-pro4": { runs: { "": [27, 0.71] } },
  "step-5": { runs: { "": [44, 1.03] } },
  "trinity-large-thinking": { runs: { "": [11, 0.12] } },
};

/** A model id as an engine reports it: `claude-opus-5-5`, `gpt-6.1-sol`, Caveman's `anthropic/claude-opus-5-5`, `claude-fable-5-1[1m]`. */
export function modelFacts(modelId: string): ModelFacts | undefined {
  const bare = modelId.slice(modelId.lastIndexOf("/") + 1).replace(/\[.*$/, "").toLowerCase().replaceAll(".", "-");
  return Object.hasOwn(FACTS, bare) ? FACTS[bare] : undefined;
}

/** The run at an effort; a model measured at one unnamed effort answers for every effort. */
export function runAt(facts: ModelFacts, effort: string | undefined): ModelRun | undefined {
  return (effort !== undefined ? facts.runs[effort] : undefined) ?? facts.runs[""];
}

// One scale for every model, so rows compare: a cent to ten dollars a task, logarithmic (prices span three decades).
const LOW_USD = 0.01;
const HIGH_USD = 10;
/** 0..1 along the cost scale. */
export function costPosition(usd: number): number {
  return Math.min(1, Math.max(0, Math.log(usd / LOW_USD) / Math.log(HIGH_USD / LOW_USD)));
}

/*
 * The picker rows' glance (STYLE.md 11, "Smarts and cost"): fixed bands, so a row reads the same in every list
 * and the rows compare. Smarts: Intelligence Index, 0 to 5 bars. Cost: cost per task, $ to $$$$.
 */
const SMARTS_BANDS = [20, 30, 40, 48, 55] as const;
const COST_BANDS = [0.1, 0.5, 2] as const;
export const SMARTS_MAX = SMARTS_BANDS.length;
export const COST_MAX = COST_BANDS.length + 1;
export function smartsLevel(index: number): number {
  return SMARTS_BANDS.filter((b) => index >= b).length;
}
export function costLevel(usdPerTask: number): number {
  return 1 + COST_BANDS.filter((b) => usdPerTask >= b).length;
}

/** $4, $0.2, $0.0045, $1.34: no trailing zeros, at most two significant figures under a dollar. */
export function usd(value: number): string {
  if (value >= 1) return `$${Number(value.toFixed(2))}`;
  return `$${Number(value.toPrecision(2))}`;
}

/** 1M, 922K, 200K. */
export function tokensShort(n: number): string {
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(2))}M` : `${Math.round(n / 1000)}K`;
}
