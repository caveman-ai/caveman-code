// The Unlock sheet's plans, worked out from Caveman Cloud's offer (account.get): every plan a person can buy alone,
// what each buys, and which one the sheet raises. Pure (components/UnlockPlans.tsx draws it).

import type { AccountSummary, CodeOffer, CodeSubscription } from "@caveman-app/session-protocol";
import { canManageBilling, USAGE_GOES_FURTHEST, usageComparison } from "../routes/settings/account-model.ts";

/** One plan as a column of the Unlock sheet. */
export type PlanColumn = {
  /** The offer's own plan, for what Settings > Plan works out the same way (its price, yearly). */
  readonly offered: CodeOffer["plans"][number];
  readonly plan: string;
  readonly label: string;
  readonly family: string;
  readonly usdMonth: number;
  readonly usdYear: number;
  /** The headline: "up to $60 of usage". The one dollar figure about what a plan holds (docs/ section 9). */
  readonly upTo: number;
  /** How its usage compares with the base plan's, in plain words: "5 times as much as Pro"; null for the base plan, or where Cloud does not compare. */
  readonly more: string | null;
  readonly kept: number | null;
  readonly cpus: number | null;
  readonly gib: number | null;
};

/** "16x64" is 16 CPUs and 64 GB. */
export function size(maxSize: string | undefined): { cpus: number; gib: number } | null {
  const m = /^(\d+)x(\d+)$/.exec(maxSize ?? "");
  return m ? { cpus: Number(m[1]), gib: Number(m[2]) } : null;
}

/** The plans a person can buy alone, cheapest first. Per-seat plans (Team) are a link, not a column. */
export function planColumns(offer: CodeOffer): PlanColumn[] {
  return offer.plans
    .filter((p) => p.on_sale && !p.per_seat && p.usd_month > 0)
    .toSorted((a, b) => a.usd_month - b.usd_month)
    .map((p) => {
      const s = size(p.computers?.max_size);
      return {
        offered: p,
        plan: p.plan,
        label: p.label,
        family: p.label.split(" ")[0] ?? p.label,
        usdMonth: p.usd_month,
        usdYear: p.usd_year,
        upTo: p.up_to_usd,
        more: usageComparison(p, offer) ?? null,
        kept: p.computers?.kept ?? null,
        cpus: s?.cpus ?? null,
        gib: s?.gib ?? null,
      };
    });
}

const usd = (n: number) => `$${n.toLocaleString("en-US")}`;
const capital = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** One line of a column: what it says (null: not for this plan), the quieter line under it, and the number that decides whether it grew. */
export type ColumnStat = { readonly label: (c: PlanColumn) => string | null; readonly sub?: (c: PlanColumn) => string; readonly value: (c: PlanColumn) => number | null };

/**
 * What a column says under its price. The headline is the only dollar figure about what a plan holds: no included
 * dollars, no rate, no price for a computer's time (docs/ section 9).
 */
export const COLUMN_STATS: ReadonlyArray<ColumnStat> = [
  // The headline, then how the plan compares in plain words; the cheapest says the one thing about how far it goes.
  { label: (c) => `Up to ${usd(c.upTo)} of usage`, sub: (c) => (c.more ? capital(c.more) : USAGE_GOES_FURTHEST), value: (c) => c.upTo },
  // Computers draw on the same usage: never a second allowance.
  { label: (c) => (c.cpus === null ? null : `${c.cpus} CPUs, ${c.gib} GB computers`), sub: () => "From the same usage", value: (c) => c.cpus },
  { label: (c) => (c.kept === null ? null : `${c.kept} computers kept`), value: (c) => c.kept },
];

/** The usage slot that opens when a plan unlocks, and the line once it has. */
export const usageSlot = (c: PlanColumn) => ({ title: `Up to ${usd(c.upTo)} of usage`, desc: `Every month. ${USAGE_GOES_FURTHEST}.` });
export const unlockedLine = (c: PlanColumn) => `Up to ${usd(c.upTo)} of usage is ready, and Cloud computers are on.`;

/**
 * The column the sheet raises: the first plan whose headline gives more for each dollar of its price than the
 * cheapest plan's does, else the middle one. Worked out from the two numbers every plan publishes, its price and its
 * "up to".
 */
export function recommended(columns: ReadonlyArray<PlanColumn>): number {
  const base = columns[0];
  const better = base ? columns.findIndex((c) => c.upTo * base.usdMonth > base.upTo * c.usdMonth) : -1;
  return better >= 0 ? better : Math.floor((columns.length - 1) / 2);
}

/** Whether a column's stat beats the column to its left (it shows in white). */
export function grew(columns: ReadonlyArray<PlanColumn>, index: number, stat: (c: PlanColumn) => number | null): boolean {
  if (index === 0) return true;
  const now = stat(columns[index]!);
  const before = stat(columns[index - 1]!);
  return now !== null && (before === null || now > before);
}

/**
 * The plan the account holds now; null on Free, or while it can't be read. Past due still counts (the plan holds while
 * Stripe retries); canceled and none (never paid) do not.
 */
export function paidPlan(account: AccountSummary | null | undefined): CodeSubscription | null {
  const sub = account?.credits?.subscription;
  return sub && sub.status !== "canceled" && sub.status !== "none" ? sub : null;
}

/** The organization holds a plan: a subscription that counts (paidPlan), or a plan Caveman set without one. */
export function holdsPlan(account: AccountSummary | null | undefined): boolean {
  const plan = account?.credits?.plan;
  return paidPlan(account) !== null || (plan !== undefined && plan !== "free");
}

/**
 * Where Unlock is offered: a signed-in Free account whose person may buy (owner or billing) on a Cloud that sells
 * plans, with no credits to spend (those only need turning on). Never to someone who holds a plan, nor as a button
 * that can only fail.
 */
export function offersUnlock(account: AccountSummary | null | undefined): boolean {
  return Boolean(
    account?.signed_in &&
      account.offer?.purchasable &&
      canManageBilling(account.role) &&
      planColumns(account.offer).length > 0 &&
      !holdsPlan(account) &&
      (account.credits?.balance_micros ?? 0) <= 0,
  );
}

/**
 * Where the Unlock sheet reads the account and starts a checkout: this computer's runtime (account.get,
 * account.checkout), or Caveman Cloud itself on the hosted client before any computer is picked (state/cloud.ts
 * hostedAccount).
 */
export interface AccountSource {
  readonly get: () => Promise<AccountSummary>;
  readonly checkout: (plan: string, interval: "month" | "year") => Promise<{ readonly url?: string; readonly effective?: string }>;
}
