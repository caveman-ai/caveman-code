// Settings > Account on a phone: the person's plan as one of their computers reads it (Session Protocol's
// account.get), one line per limit of the plan, each a whole percent used and when it starts over: "58% · resets Sat
// 7:44 AM". Nothing else of the account is read here: never dollars, rates, credits, GB or minutes, and where no
// computer has answered, or the plan has no limits, the page says nothing about the plan.
// Pure, with only types from the protocol, so account-model.test.ts pins every word.
import type { AccountSummary } from "@caveman-app/session-protocol";

import { clock } from "./models-model";

export interface PlanLine {
  /** The limit as Caveman names it: `5h`, `week`, `month`. */
  readonly window: string;
  /** "5 hours", "This week", "This month". */
  readonly label: string;
  /** "58% · resets Sat 7:44 AM"; only the percent where Caveman names no reset. */
  readonly words: string;
  /** Amber from 80% used, as the desktop's meter turns. */
  readonly tone: "quiet" | "warn";
}

/** The limits in the order people meet them, shortest first; one Caveman adds later follows them, as sent. */
const ORDER = ["5h", "week", "month"];
const LABELS: Record<string, string> = { "5h": "5 hours", week: "This week", month: "This month" };

/** A percent as sent, held to a whole number from 0 to 100; undefined when it is no number (planUsage.ts wholePct). */
const wholePct = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.min(100, Math.max(0, Math.floor(value)))
    : undefined;

/**
 * The plan's lines, or none: no computer has answered (`account` null), this Caveman sells no plans, or the plan has
 * no limits. A limit that names no percent is left out, whatever else it carries: what an older computer sent in
 * dollars is never read. `timeZone` is the device's own unless one is given.
 */
export function planLines(
  account: Pick<AccountSummary, "credits"> | null,
  now: number,
  timeZone?: string,
): PlanLine[] {
  const windows: ReadonlyArray<{
    readonly window?: unknown;
    readonly used_pct?: unknown;
    readonly resets_at?: unknown;
  }> = Array.isArray(account?.credits?.windows) ? account.credits.windows : [];
  const rank = (name: string) => {
    const at = ORDER.indexOf(name);
    return at < 0 ? ORDER.length : at;
  };
  return windows
    .flatMap((w, sent) => {
      const used = wholePct(w.used_pct);
      return typeof w.window === "string" && w.window !== "" && used !== undefined
        ? [
            {
              name: w.window,
              used,
              resets: typeof w.resets_at === "string" ? Date.parse(w.resets_at) : Number.NaN,
              sent,
            },
          ]
        : [];
    })
    .sort((a, b) => rank(a.name) - rank(b.name) || a.sent - b.sent)
    .map(({ name, used, resets }) => ({
      window: name,
      label: LABELS[name] ?? name,
      // A reset already past is being worked out by Caveman: the next answer names the new one.
      words: Number.isFinite(resets)
        ? `${used}% · ${resets > now ? `resets ${clock(resets, now, timeZone)}` : "resetting now"}`
        : `${used}%`,
      tone: used >= 80 ? ("warn" as const) : ("quiet" as const),
    }));
}
