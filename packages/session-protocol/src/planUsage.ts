// Plan usage as the app carries it: a percent and a reset, never dollars (docs/ section 9: what a plan holds
// stays private). Caveman Cloud answers in that shape. A Cloud or a runtime from before it sent each limit's size and
// use in micro-dollars instead; these read either and keep only the percent, so the dollars stop at whoever reads the
// answer first and never reach a screen.

import type { AccountSummary, CodeUsageWindow } from "./protocol.ts";

/**
 * Whole percent of a limit used, rounded down: 80 is where a meter turns amber, 99.5% still reads 99, and 100 shows
 * only once the limit is reached (or passed).
 */
export function usedPct(used: number, cap: number): number {
  if (!(cap > 0) || used >= cap) return 100;
  return Math.min(99, Math.max(0, Math.floor((used / cap) * 100)));
}

/** A percent as it was sent, held to a whole number from 0 to 100; undefined when it is no number. */
export function wholePct(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.floor(value)))
    : undefined;
}

/**
 * A plan's limits from an account answer (Cloud's GET /api/v1/code/credits `windows`, or account.get's): each one's
 * `used_pct` as sent, else worked out from the micro-dollar cap and use an older Cloud or runtime sent. A limit that
 * says neither, or has no cap, is left out: it meters nothing.
 */
export function usageWindows(raw: unknown): ReadonlyArray<CodeUsageWindow> {
  if (!Array.isArray(raw)) return [];
  const out: CodeUsageWindow[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const w = item as {
      window?: unknown;
      used_pct?: unknown;
      cap_micros?: unknown;
      used_micros?: unknown;
      resets_at?: unknown;
    };
    if (typeof w.window !== "string" || w.window === "") continue;
    const sent = wholePct(w.used_pct);
    const used =
      sent ??
      (typeof w.cap_micros === "number" && w.cap_micros > 0 && typeof w.used_micros === "number"
        ? usedPct(w.used_micros, w.cap_micros)
        : undefined);
    if (used === undefined) continue;
    out.push({
      window: w.window,
      used_pct: used,
      ...(typeof w.resets_at === "string" && w.resets_at !== "" ? { resets_at: w.resets_at } : {}),
    });
  }
  return out;
}

/** What a Cloud or a runtime from before 2026-11-09 sent about what a plan holds, by key. None of it is kept. */
const PRIVATE_OFFER_KEYS = ["basis", "rates", "computer_minute_micros"];
const PRIVATE_PLAN_KEYS = ["included_usd", "window_5h_pct", "window_week_pct"];
const PRIVATE_CREDITS_KEYS = ["basis", "models"];
const PRIVATE_COMPUTERS_KEYS = ["spent_micros", "minute_micros"];

function without<T extends object>(value: T, keys: ReadonlyArray<string>): T {
  const out = { ...value } as Record<string, unknown>;
  for (const key of keys) delete out[key];
  return out as T;
}

type Credits = NonNullable<AccountSummary["credits"]>;
type Offer = NonNullable<AccountSummary["offer"]>;

/**
 * An account's credits as read straight from Caveman Cloud (the hosted client before a computer is picked) or kept
 * from an earlier answer, with only what the protocol carries about the plan: each limit as a percent and a reset,
 * and none of the dollars an older Cloud sent for limits, models or computers.
 */
export function publicCredits(raw: Credits): Credits {
  const credits = without(raw, PRIVATE_CREDITS_KEYS);
  return {
    ...credits,
    windows: usageWindows(credits.windows),
    ...(credits.computers ? { computers: without(credits.computers, PRIVATE_COMPUTERS_KEYS) } : {}),
  };
}

/** The plans on offer with only what the protocol carries: prices, the "up to" headline, and allowances that are not money. */
export function publicOffer(raw: Offer): Offer {
  const offer = without(raw, PRIVATE_OFFER_KEYS);
  return { ...offer, plans: offer.plans.map((plan) => without(plan, PRIVATE_PLAN_KEYS)) };
}
