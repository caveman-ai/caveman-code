// One run wallet (SEMANTICS §9): the file's budget, clamped by every cap above it (never raised), drawn
// on by every attempt, retry, agent check and delegate child of the run. Spend is measured from the
// engines' own usage events: dollars where the turn was priced, tokens and turns always. A turn on a
// subscription login has no price, so only the token and turn caps can hold for it (§9.6), and the
// record says so through its billing. Nothing here is inferred.
import type { BudgetLimits } from "@caveman-app/automations";

import { NO_COST, addCost, type Cost } from "./machine.ts";

export interface Wallet extends BudgetLimits {
  /** Where the limits came from, for the record: "file", "default", or the caps' sources. */
  readonly source: string;
  /** Where each limit came from, so a stop can say which cap held. */
  readonly sources?: { readonly usd?: string; readonly tokens?: string; readonly turns?: string };
}

/** A file with no budget gets this run wallet (one constant; explain shows it through the environment's budget cap). */
export const DEFAULT_RUN_USD = 10;
/** F-5: a subscription login has no price, so these hold a run that the file gives no token or turn cap. */
export const DEFAULT_PLAN_TOKENS = 4_000_000;
export const DEFAULT_PLAN_TURNS = 200;

/** The file's budget (a file with none: DEFAULT_RUN_USD) clamped by the caps: the lowest of each limit anyone set. */
export function walletOf(file: BudgetLimits | undefined, caps: ReadonlyArray<BudgetLimits & { readonly source: string }> = []): Wallet {
  let wallet: { usd?: number; tokens?: number; turns?: number } = file === undefined ? { usd: DEFAULT_RUN_USD } : { ...file };
  const origin = file === undefined ? "default" : "file";
  const sources: string[] = [origin];
  const each: { usd?: string; tokens?: string; turns?: string } = Object.fromEntries(Object.keys(wallet).map((k) => [k, origin]));
  for (const cap of caps) {
    const before = { ...wallet };
    for (const key of ["usd", "tokens", "turns"] as const) {
      const limit = cap[key];
      if (limit !== undefined && (wallet[key] === undefined || limit < wallet[key]!)) {
        wallet = { ...wallet, [key]: limit };
        each[key] = cap.source;
      }
    }
    if (JSON.stringify(before) !== JSON.stringify(wallet)) sources.push(cap.source);
  }
  return { ...wallet, source: sources.join(", "), sources: each };
}

/** One usage event as the Session Protocol journals it (`caveman_sp_events` type `usage`). */
export interface UsagePayload {
  readonly engine?: string;
  readonly model?: string;
  readonly input_tokens: number;
  readonly output_tokens: number;
  readonly cache_read_tokens: number;
  readonly cache_write_tokens: number;
  readonly cost: { readonly usd: number; readonly basis: string } | null;
  readonly billing?: "api_key" | "plan";
}

/** A turn's cost: priced turns carry dollars; an unpriced one is a plan unless it says it is a key. */
export function costOfUsage(usage: UsagePayload): Cost {
  return {
    usd: usage.cost?.usd ?? 0,
    input: usage.input_tokens,
    output: usage.output_tokens,
    cache_read: usage.cache_read_tokens,
    cache_write: usage.cache_write_tokens,
    turns: 1,
    billing: usage.cost !== null ? "api_key" : (usage.billing ?? "plan"),
  };
}

export const sumCosts = (costs: Iterable<Cost | undefined>): Cost => {
  let total = NO_COST;
  for (const cost of costs) total = addCost(total, cost);
  return total;
};

/** What `after` added to `before` (one thread's totals then and now). */
export function costSince(after: Cost, before: Cost): Cost {
  return {
    usd: Math.max(0, after.usd - before.usd),
    input: Math.max(0, after.input - before.input),
    output: Math.max(0, after.output - before.output),
    cache_read: Math.max(0, after.cache_read - before.cache_read),
    cache_write: Math.max(0, after.cache_write - before.cache_write),
    turns: Math.max(0, after.turns - before.turns),
    billing: after.turns > before.turns ? after.billing : "none",
  };
}

/** Tokens a token cap counts: input plus output as the engines report them (cache reads are left out, as the delegate tree ceiling does). */
export const tokensOf = (cost: Cost): number => cost.input + cost.output + cost.cache_write;

const whose = (source: string | undefined) =>
  source === "file" ? "the file's budget" : source === "default" ? `the $${DEFAULT_RUN_USD} default for a file with no budget` : source === undefined ? "its budget" : `the ${source} cap`;
const n = (value: number) => value.toLocaleString("en-US");

/**
 * Why the wallet is empty, in words that name the cap that held, or undefined while it holds. Turns on a
 * subscription login (billing plan) are unpriced, so the token and turn caps hold them: the file's, else the
 * plan defaults (F-5).
 */
export function exhausted(wallet: Wallet, spent: Cost): string | undefined {
  const plan = spent.billing === "plan" || spent.billing === "mixed";
  if (wallet.usd !== undefined && spent.usd >= wallet.usd) return `The run spent $${spent.usd.toFixed(2)} of its $${wallet.usd.toFixed(2)}, ${whose(wallet.sources?.usd)}.`;
  const tokens = wallet.tokens ?? (plan ? DEFAULT_PLAN_TOKENS : undefined);
  const tokenSource = wallet.tokens !== undefined ? whose(wallet.sources?.tokens) : "the default for a subscription login (set budget.tokens to change it)";
  if (tokens !== undefined && tokensOf(spent) >= tokens) return `The run used ${n(tokensOf(spent))} of its ${n(tokens)} tokens, ${tokenSource}.`;
  const turns = wallet.turns ?? (plan ? DEFAULT_PLAN_TURNS : undefined);
  const turnSource = wallet.turns !== undefined ? whose(wallet.sources?.turns) : "the default for a subscription login (set budget.turns to change it)";
  if (turns !== undefined && spent.turns >= turns) return `The run took ${n(spent.turns)} of its ${n(turns)} turns, ${turnSource}.`;
  return undefined;
}
