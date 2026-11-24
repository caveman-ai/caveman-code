import type { AccountSummary, CodeOffer } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import offer from "../routes/settings/code-plans-offer.fixture.json";
import { planDollars, PRIVATE_WORDS } from "../routes/settings/plan-dollars.fixture.ts";
import { COLUMN_STATS, grew, offersUnlock, paidPlan, planColumns, recommended, unlockedLine, usageSlot } from "./unlock-model.ts";

describe("the plans", () => {
  const columns = planColumns(offer as unknown as CodeOffer);

  test("every plan a person can buy alone, cheapest first; Team is not a column", () => {
    expect(columns.map((c) => [c.label, c.usdMonth, c.upTo, c.more, c.kept, c.cpus])).toEqual([
      ["Pro", 20, 60, null, 10, 4],
      ["Pro $60", 60, 180, "3 times as much as Pro", 20, 8],
      ["Max $100", 100, 315, "5 times as much as Pro", 30, 16],
      ["Max $200", 200, 660, "11 times as much as Pro", 40, 16],
    ]);
    expect(columns.map((c) => c.family)).toEqual(["Pro", "Pro", "Max", "Max"]);
  });

  test("a column says its headline and how it compares in plain words: no included dollars, no rate, no computer hours", () => {
    const said = (i: number) => COLUMN_STATS.map((s) => [s.label(columns[i]!), s.sub?.(columns[i]!)]);
    expect(said(0)).toEqual([
      ["Up to $60 of usage", "Goes furthest on open models"],
      ["4 CPUs, 16 GB computers", "From the same usage"],
      ["10 computers kept", undefined],
    ]);
    expect(said(2)).toEqual([
      ["Up to $315 of usage", "5 times as much as Pro"],
      ["16 CPUs, 64 GB computers", "From the same usage"],
      ["30 computers kept", undefined],
    ]);
    expect(usageSlot(columns[2]!)).toEqual({ title: "Up to $315 of usage", desc: "Every month. Goes furthest on open models." });
    expect(unlockedLine(columns[2]!)).toBe("Up to $315 of usage is ready, and Cloud computers are on.");
    // Everything a column and its unlocked slots say: the headline is the only dollar figure.
    for (const c of columns) {
      const all = [...COLUMN_STATS.flatMap((s) => [s.label(c), s.sub?.(c)]), usageSlot(c).title, usageSlot(c).desc, unlockedLine(c)].filter(Boolean).join(". ");
      expect(planDollars(all), c.label).toEqual([]);
      expect(all, c.label).not.toMatch(PRIVATE_WORDS);
    }
    // A plan with no computers says nothing of them.
    const bare = { ...columns[0]!, cpus: null, gib: null, kept: null };
    expect(COLUMN_STATS.map((s) => s.label(bare))).toEqual(["Up to $60 of usage", null, null]);
  });

  test("raises the first plan whose headline gives more for its price than the cheapest plan's", () => {
    // Pro and Pro $60 give $3 of headline for each dollar; Max $100 gives $3.15.
    expect(recommended(columns)).toBe(2);
    // None does better than the cheapest: the middle one.
    expect(recommended(columns.slice(0, 2))).toBe(0);
    expect(recommended([])).toBe(-1);
  });

  test("a stat is white only where it beats the column to its left", () => {
    expect(grew(columns, 0, (c) => c.cpus)).toBe(true);
    expect(grew(columns, 2, (c) => c.cpus)).toBe(true);
    expect(grew(columns, 3, (c) => c.cpus)).toBe(false);
  });
});

describe("who is offered a plan", () => {
  const sub = (status: string) => ({ plan: "pro", seats: 1, status, cancel_at_period_end: false, pending_update: false });
  const account = (status: string | null, extra: Partial<AccountSummary> = {}) =>
    ({ signed_in: true, role: "owner", offer, credits: status ? { subscription: sub(status) } : {}, ...extra }) as unknown as AccountSummary;

  test("a plan past due still holds; canceled and never paid do not", () => {
    expect(paidPlan(account("active"))?.plan).toBe("pro");
    expect(paidPlan(account("trialing"))?.plan).toBe("pro");
    expect(paidPlan(account("past_due"))?.plan).toBe("pro");
    expect(paidPlan(account("canceled"))).toBeNull();
    expect(paidPlan(account("none"))).toBeNull();
    expect(paidPlan(account(null))).toBeNull();
  });

  test("only a signed-in Free account, on a Cloud that sells plans, sees Unlock", () => {
    expect(offersUnlock(account(null))).toBe(true);
    expect(offersUnlock(account("past_due"))).toBe(false);
    expect(offersUnlock(account(null, { signed_in: false }))).toBe(false);
    expect(offersUnlock(account(null, { offer: { ...(offer as unknown as CodeOffer), purchasable: false } }))).toBe(false);
    expect(offersUnlock(account(null, { offer: null }))).toBe(false);
    expect(offersUnlock(account(null, { role: "member" }))).toBe(false);
    // A plan Caveman set with no Stripe subscription still holds; credits to spend only need turning on.
    expect(offersUnlock({ ...account(null), credits: { plan: "pro" } } as unknown as AccountSummary)).toBe(false);
    expect(offersUnlock({ ...account(null), credits: { plan: "free", balance_micros: 5_000_000 } } as unknown as AccountSummary)).toBe(false);
  });
});
