import { readFileSync } from "node:fs";

import type { CodeOffer, CodeSubscription } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import {
  billingFingerprint,
  canManageBilling,
  cardLabel,
  ceilingLine,
  computersLine,
  defaultLimit,
  defaultRefill,
  disputeMail,
  draftChanged,
  draftProblem,
  draftRequest,
  higherLimitMail,
  paygDraft,
  paygStatus,
  planCard,
  planLabel,
  planLadder,
  plansSmallPrint,
  planOffer,
  plansOnSale,
  planWindows,
  resetsLabel,
  roleLabel,
  subscriptionLine,
  topUps,
  usageComparison,
  usd,
  wholeDollars,
} from "./account-model.ts";
import { CATALOG, ON } from "./auto-topup.fixture.ts";
import { planDollars, PRIVATE_WORDS } from "./plan-dollars.fixture.ts";

/**
 * GET /api/v1/code/plans as Caveman Cloud answers it: a byte copy of Cloud's
 * golden file (Caveman Cloud API,
 * TestCodePlansOffer). The app shows what this says; when Cloud's catalog moves,
 * copy the new golden here and these expectations move with it.
 */
const offer = JSON.parse(readFileSync(new URL("./code-plans-offer.fixture.json", import.meta.url), "utf8")) as CodeOffer;

describe("account model", () => {
  it("names roles, and plans from the offer, the way Caveman does", () => {
    expect(["owner", "admin", "engineer", "viewer", "billing"].map(roleLabel)).toEqual(["Owner", "Platform admin", "Developer", "Analyst", "Finance"]);
    expect(["free", "pro", "go", "max", "max20", "team", "someday"].map((p) => planLabel(p, offer))).toEqual(["Free", "Pro", "Pro $60", "Max $100", "Max $200", "Team", "someday"]);
    // Without an offer (the sidebar meter, an older Cloud) the names still match Cloud's.
    for (const p of offer.plans) expect(planLabel(p.plan)).toBe(p.label);
  });

  it("offers the plans Cloud sells, cheapest first, with the most usage each can buy", () => {
    expect(offer.purchasable).toBe(true);
    const sold = plansOnSale(offer, "free");
    expect(sold.map((p) => planOffer(p, "month"))).toEqual([
      "Pro · $20 a month · up to $60 of usage",
      "Pro $60 · $60 a month · up to $180 of usage",
      "Max $100 · $100 a month · up to $315 of usage",
      "Max $200 · $200 a month · up to $660 of usage",
    ]);
    expect(sold.map((p) => planOffer(p, "year"))).toEqual([
      "Pro · $192 a year · up to $60 of usage a month",
      "Pro $60 · $576 a year · up to $180 of usage a month",
      "Max $100 · $960 a year · up to $315 of usage a month",
      "Max $200 · $1,920 a year · up to $660 of usage a month",
    ]);
    // "Up to" is Cloud's own headline, never a number the app works out: nothing else in the offer says what a plan holds.
    expect(sold.map((p) => p.up_to_usd)).toEqual([60, 180, 315, 660]);
    // The plan held is not offered again; retired Team is never offered, and still named for its holders.
    expect(plansOnSale(offer, "max").map((p) => p.plan)).toEqual(["pro", "go", "max20"]);
    expect(offer.plans.find((p) => p.plan === "team")?.on_sale).toBe(false);
    expect(plansOnSale(offer, "team").map((p) => p.plan)).not.toContain("team");
    // Top-ups are whole-dollar presets inside Cloud's range.
    expect(topUps(offer)).toEqual([5, 10, 25, 50, 100]);
    expect(topUps({ ...offer, top_up: { min_usd: 10, max_usd: 50, expires_days: 365 } })).toEqual([10, 25, 50]);
  });

  it("the offer carries nothing private about what a plan holds", () => {
    // What a plan includes in dollars, the size or share of its limits, what a model or a computer minute draws
    // (docs/ section 9).
    expect(JSON.stringify(offer)).not.toMatch(/included_usd|window_5h_pct|window_week_pct|rate_permille|"rates"|computer_minute_micros|"basis"|cap_micros|used_micros|spent_micros/);
    // What it does carry about usage: the headline, a whole comparison with the base plan, and the limits by name.
    expect(offer.usage_base).toBe("pro");
    expect(offer.plans.map((p) => [p.plan, p.up_to_usd, p.usage_times, p.windows])).toEqual([
      ["pro", 60, 1, ["5h", "week", "month"]],
      ["team", 120, 2, ["5h", "week", "month"]],
      ["go", 180, 3, ["5h", "week", "month"]],
      ["max", 315, 5, ["5h", "week", "month"]],
      ["max20", 660, 11, ["5h", "week", "month"]],
    ]);
  });

  it("compares plans in plain words, never in dollars", () => {
    const by = (id: string) => offer.plans.find((p) => p.plan === id)!;
    expect(usageComparison(by("pro"), offer)).toBeUndefined();
    expect(usageComparison(by("team"), offer)).toBe("twice as much as Pro");
    expect(usageComparison(by("go"), offer)).toBe("3 times as much as Pro");
    expect(usageComparison(by("max"), offer)).toBe("5 times as much as Pro");
    expect(usageComparison(by("max20"), offer)).toBe("11 times as much as Pro");
    // A Cloud that does not compare says nothing, and neither does a plan that holds no more.
    const { usage_base: _, ...noBase } = offer;
    expect(usageComparison(by("max"), noBase)).toBeUndefined();
    expect(usageComparison({ ...by("max"), usage_times: 1 }, offer)).toBeUndefined();
    const { usage_times: __, ...noTimes } = by("max");
    expect(usageComparison(noTimes, offer)).toBeUndefined();
  });

  it("says what a plan holds with its headline, its limits by name and plain words: the headline is the only dollar figure", () => {
    const card = (id: string) => planCard(planLadder(offer, "free").find((p) => p.plan === id)!, offer);
    expect(card("pro")).toEqual({
      fit: "For everyday coding",
      lead: { figure: "Up to $60", rest: "of usage a month", line: "Goes furthest on open models" },
      rows: ["5-hour, weekly and monthly limits", "Cloud included in your usage", "1 free month of Pro for friends"],
    });
    expect(card("max").lead).toEqual({ figure: "Up to $315", rest: "of usage a month", line: "5 times as much as Pro" });
    // Exactly the limits Cloud lists: a Cloud whose plans have no 5-hour window names the week and the month.
    const max = offer.plans.find((p) => p.plan === "max")!;
    expect(planCard({ ...max, windows: ["week", "month"] }, offer).rows[0]).toBe("Weekly and monthly limits");
    // A plan the month alone meters, or a Cloud that names no limits: no limits row.
    expect(planCard({ ...max, windows: ["month"] }, offer).rows).toEqual(["Cloud included in your usage", "2 free months of Pro for friends"]);
    const { windows: _, usage_times: __, ...bare } = max;
    expect(planCard(bare, offer)).toMatchObject({ lead: { figure: "Up to $315", line: "Goes furthest on open models" }, rows: ["Cloud included in your usage", "2 free months of Pro for friends"] });
    // A plan Cloud adds later has no line on who it is for until one is written.
    expect(planCard({ ...max, plan: "ultra" }, offer).fit).toBeUndefined();
    // Every paid plan: after the headline, not a dollar, and none of the words that used to say a rate or a limit's size.
    for (const p of offer.plans) {
      const { fit, lead, rows } = planCard(p, offer);
      const said = [fit, lead.figure, lead.rest, lead.line, ...rows].join(" ");
      expect(planDollars(said), p.plan).toEqual([]);
      expect(said, p.plan).not.toMatch(PRIVATE_WORDS);
      expect(said.match(/\$/g), p.plan).toHaveLength(1);
    }
    // The small print says once, for every plan, why there are limits and how a gift works.
    expect(plansSmallPrint(offer.plans, offer)).toBe("Limits keep one long day or week from using up the month. Free months come with your first payment. Friends add a card and can cancel before the month ends.");
    expect(plansSmallPrint(offer.plans.map((p) => ({ ...p, windows: ["week", "month"] })), offer)).toMatch(/^Limits keep a long week from using up the month\. /);
    const { gift: ___, ...noGift } = offer;
    expect(plansSmallPrint(offer.plans.map((p) => ({ ...p, windows: ["month"] })), noGift)).toBeUndefined();
    // Free holds no usage of its own: credits pay, at list price, which is the person's own money.
    expect(card("free")).toEqual({ fit: "For the keys and logins you already pay for", lead: { figure: "Your own keys", rest: "and logins" }, rows: ["Caveman models from credits, at list price", "Cloud from credits"] });
  });

  it("the check for plan dollars catches what used to be shown, and lets the price, the headline and plan names through", () => {
    for (const leak of ["$4.10 of $7 used", "Max $100 holds $105 a month", "$20 a month, at list price", "$7 per 5 hours · $7 per week", "$2.90 this month · 32 of 160 GB awake", "<span>$4.10</span> of $7"]) {
      expect(planDollars(leak), leak).not.toEqual([]);
    }
    for (const fine of ["Pro · $20 a month · up to $60 of usage", "Up to $315 of usage a month", "<b>Max $100</b> <span>$100</span> <span>a month</span>", "$16 / month", "$192 billed yearly", "$0 forever", "58% used this week"]) {
      expect(planDollars(fine), fine).toEqual([]);
    }
    // The person's own money passes only when the test names it, and only as a whole amount.
    expect(planDollars("Balance $12.34")).not.toEqual([]);
    expect(planDollars("Balance $12.34", ["$12.34"])).toEqual([]);
    expect(planDollars("holds $105", ["$10"])).not.toEqual([]);
    for (const words of ["glm-5.3 goes three times as far", "Every other model counts at list price", "Or 100 computer hours", "Up to 35% of the month in any one week"]) expect(words).toMatch(PRIVATE_WORDS);
  });

  it("lets only the roles Cloud lets buy, change and manage the plan", () => {
    expect(["owner", "billing", "admin", "engineer", "viewer", undefined].map(canManageBilling)).toEqual([true, true, false, false, false, false]);
  });

  it("says where the plan's billing stands", () => {
    const base: CodeSubscription = { plan: "pro", seats: 1, status: "active", interval: "month", current_period_end: "2026-11-15T09:00:00Z", cancel_at_period_end: false, pending_update: false };
    expect(subscriptionLine(base, offer)).toEqual({ text: "Monthly, renews Nov 15, 2026.", attention: false });
    expect(subscriptionLine({ ...base, cancel_at_period_end: true }, offer)).toEqual({ text: "Ends Nov 15, 2026. Resume to keep it.", attention: true });
    expect(subscriptionLine({ ...base, status: "past_due" }, offer).attention).toBe(true);
    expect(subscriptionLine({ ...base, status: "canceled" }, offer).text).toMatch(/^Unpaid/);
    expect(subscriptionLine({ ...base, status: "none" }, offer).text).toMatch(/first payment/);
    expect(subscriptionLine({ ...base, pending_update: true }, offer).text).toMatch(/prorated invoice/);
    expect(subscriptionLine({ ...base, plan: "max", scheduled_plan: "pro", scheduled_interval: "year", scheduled_seats: 1 }, offer).text).toBe("Changes to Pro (yearly) on Nov 15, 2026.");
    const { current_period_end: _, ...noEnd } = base;
    expect(subscriptionLine({ ...noEnd, interval: "year" }, offer).text).toBe("Yearly");
  });

  it("tells a changed plan or balance apart after Stripe", () => {
    const credits = { plan: "free", seats: 1, windows: [], balance_micros: 0, grants: [], use_balance: true };
    expect(billingFingerprint(credits)).toBe(billingFingerprint({ ...credits }));
    expect(billingFingerprint(credits)).not.toBe(billingFingerprint({ ...credits, balance_micros: 25_000_000 }));
    expect(billingFingerprint(credits)).not.toBe(billingFingerprint({ ...credits, fulfillment_pending: 1 }));
    expect(billingFingerprint(null)).toBe("none");
    // Back from Stripe's card page: a card saved or changed, a pause, a new limit or a charge moves it.
    const on = { ...credits, auto_topup: { ...ON, card: null } };
    expect(billingFingerprint(on)).not.toBe(billingFingerprint(credits));
    for (const next of [{ card: ON.card }, { paused: "card_declined" as const }, { month_limit_usd: 2000 }, { charged_micros: 4_000_000_000 }, { enabled: false }]) {
      expect(billingFingerprint({ ...credits, auto_topup: { ...on.auto_topup, ...next } }), JSON.stringify(next)).not.toBe(billingFingerprint(on));
    }
    expect(billingFingerprint({ ...credits, auto_topup: { ...ON, card: { ...ON.card!, last4: "1881" } } })).not.toBe(billingFingerprint({ ...credits, auto_topup: ON }));
  });

  it("shows list-price micro-dollars as dollars", () => {
    expect(usd(12_500_000)).toBe("$12.50");
    expect(usd(0)).toBe("$0.00");
    expect(usd(1_234_000_000)).toBe("$1,234");
    expect(usd(-2_000_000)).toBe("$-2.00");
  });

  it("shows exactly the windows Cloud sends, the shortest first, as Cloud's percent, and says when each resets", () => {
    expect(planWindows([{ window: "month", used_pct: 47 }, { window: "5h", used_pct: 90 }, { window: "week", used_pct: 99.5, resets_at: "2026-10-20T15:00:00Z" }])).toEqual([
      { window: "5h", used_pct: 90 },
      { window: "week", used_pct: 99, resets_at: "2026-10-20T15:00:00Z" },
      { window: "month", used_pct: 47 },
    ]);
    // No 5-hour window sent, none shown; a window this build has no name for shows last, by its name.
    expect(planWindows([{ window: "month", used_pct: 47 }, { window: "day", used_pct: 3 }, { window: "week", used_pct: 20 }]).map((w) => w.window)).toEqual(["week", "month", "day"]);
    // An older runtime's caps in micro-dollars become the percent and go no further; a window with no cap says nothing.
    expect(planWindows([{ window: "week", cap_micros: 4, used_micros: 1 }, { window: "month", cap_micros: 0, used_micros: 0 }])).toEqual([{ window: "week", used_pct: 25 }]);
    expect(planWindows(undefined)).toEqual([]);
    const now = new Date("2026-10-16T12:00:00");
    expect(resetsLabel(new Date("2026-10-16T15:00:00").toISOString(), now)).toBe("Resets 3:00 PM");
    expect(resetsLabel(new Date("2026-10-20T15:00:00").toISOString(), now)).toBe("Resets Oct 20");
    expect(resetsLabel(undefined, now)).toBeUndefined();
  });

  it("says the share of the month's plan Cloud took as a percent and nothing else: no GB, no count, no rate", () => {
    const c = { used_pct: 12, awake_gib: 32, awake_gib_limit: 160 };
    expect(computersLine(c, true)).toBe("12% of this month");
    expect(computersLine({ ...c, used_pct: 0 }, true)).toBe("0% of this month");
    expect(computersLine({ ...c, used_pct: 99.5 }, true)).toBe("99% of this month");
    expect(computersLine({ ...c, used_pct: 100 }, true)).toBe("100% of this month");
    expect(computersLine({ ...c, used_pct: 140 }, true)).toBe("100% of this month");
    // A plan with no usage of its own (Free), or a Cloud that names no share: it runs on credits, and that is all.
    expect(computersLine({}, false)).toBe("From credits");
    expect(computersLine({ ...c, used_pct: 12 }, false)).toBe("From credits");
    // A plan whose Cloud names no share says nothing rather than something untrue.
    expect(computersLine({}, true)).toBeUndefined();
    // What an older runtime sent in dollars is never read.
    expect(computersLine({ spent_micros: 2_900_000 } as Parameters<typeof computersLine>[0], true)).toBeUndefined();
    for (const said of [computersLine(c, true)!, computersLine(c, false)!, planCard(offer.plans.find((p) => p.plan === "pro")!, offer).rows.filter((row) => row.startsWith("Cloud")).join(" ")]) expect(said).not.toMatch(/GB|CPU|\d+x\d+|computers|minute|\$/);
    // The offer names each plan's allowance in units that are not money, and no price for a computer's time.
    const pro = offer.plans.find((p) => p.plan === "pro");
    expect(pro?.computers).toEqual({ kept: 10, awake_gib: 160, max_size: "4x16" });
  });

  it("says where Pay as you go stands in one line, every number Cloud's", () => {
    expect(paygStatus(undefined, true)).toEqual({ state: "off", line: "When credits run low, your card adds more, never past a monthly limit you set.", attention: false });
    expect(paygStatus(ON, true)).toEqual({ state: "on", line: "$3,000 of $10,000 this month · Adds $1,000 when credits fall below $500 · Visa 4242", attention: false });
    // Only Owner and Finance see the card.
    expect(paygStatus(ON, false).line).toBe("$3,000 of $10,000 this month · Adds $1,000 when credits fall below $500");
    expect(paygStatus({ ...ON, charging: true }, true).tag).toEqual({ text: "Adding $1,000", tone: "neutral" });
    expect(paygStatus({ ...ON, charged_micros: 0 }, true).line).toMatch(/^\$0 of \$10,000 this month/);
    expect(paygStatus({ ...ON, enabled: false }, true).state).toBe("off");
    // Turned on, but Stripe's page was left before a card was saved.
    expect(paygStatus({ ...ON, card: null }, true)).toMatchObject({ state: "card", attention: true, action: "card", line: "On, but no card is saved yet. Add one to start.", tag: { text: "Needs a card" } });
    expect(cardLabel({ ...ON.card!, brand: "amex", last4: "0005" })).toBe("American Express 0005");
    expect(cardLabel({ ...ON.card!, brand: "link", last4: "1234" })).toBe("Link 1234");
  });

  it("says why Pay as you go is paused and offers its one fix", () => {
    expect(paygStatus({ ...ON, paused: "card_declined" }, true)).toEqual({
      state: "paused",
      tag: { text: "Paused", tone: "yellow" },
      attention: true,
      line: "Your card was declined. Change the card to start again.",
      action: "card",
    });
    expect(paygStatus({ ...ON, paused: "card_expired" }, true).line).toBe("Your card expired. Change the card to start again.");
    expect(paygStatus({ ...ON, paused: "charge_failed" }, true).line).toBe("A payment didn't go through. Change the card to start again.");
    // A payment the bank held: confirm it on the invoice's page; without one, a new card.
    const held = paygStatus({ ...ON, paused: "authentication_required", confirm_url: "https://invoice.stripe.test/i/1" }, true);
    expect(held).toMatchObject({ action: "confirm", line: "Your bank asked to confirm a payment. Confirm it to add the credits and start again." });
    expect(paygStatus({ ...ON, paused: "authentication_required" }, true).action).toBe("card");
    // A dispute: only Caveman clears it, so it stays paused even turned off.
    expect(paygStatus({ ...ON, paused: "disputed", enabled: false }, true)).toMatchObject({ state: "paused", action: "contact", line: "A payment was disputed. Contact us to turn it back on." });
    // Off after a decline: turning it on again clears the pause, so it reads as off.
    expect(paygStatus({ ...ON, paused: "card_declined", enabled: false }, true).state).toBe("off");
    // Someone who cannot fix it is told who can.
    expect(paygStatus({ ...ON, paused: "card_declined" }, false).line).toBe("Your card was declined. An owner of your organization can fix it.");
  });

  it("says when the month is done: the next charge would pass the limit, or the ceiling a refund lowered", () => {
    const done = paygStatus({ ...ON, charged_micros: 9_500_000_000 }, true);
    expect(done).toMatchObject({ state: "limit", attention: true, action: "raise", tag: { text: "Limit reached", tone: "yellow" } });
    expect(done.line).toBe("$9,500 of $10,000 this month. Another $1,000 would pass the limit, so nothing more is added until the 1st.");
    expect(paygStatus({ ...ON, charged_micros: 10_000_000_000 }, true).line).toBe("$10,000 of $10,000 this month. That's the limit, so nothing more is added until the 1st.");
    expect(paygStatus({ ...ON, ceiling_usd: 2000, charged_micros: 2_000_000_000 }, true).line).toBe(
      "$2,000 of $10,000 this month. For now your organization can add up to $2,000 a month, so nothing more is added until the 1st.",
    );
    // A full charge still fits: on.
    expect(paygStatus({ ...ON, charged_micros: 9_000_000_000 }, true).state).toBe("on");
  });

  it("shows the ceiling beside the limit, what unlocks the next and how much counts so far", () => {
    expect(ceilingLine(ON, CATALOG)).toBe("Up to $10,000 a month for now. $50,000 after $2,000 paid for 30 days · $350 so far.");
    // At the top, or under a limit Caveman set by hand.
    expect(ceilingLine({ ...ON, ceiling_usd: 75000, next_ceiling: null }, CATALOG)).toBe("Up to $75,000 a month for now.");
    // Never set: the catalog's starting ceiling and the next one; Cloud says the rest once it is set.
    expect(ceilingLine(undefined, CATALOG)).toBe("Up to $500 a month to start. $2,000 after $100 paid for 7 days.");
    const mail = higherLimitMail("Analytical Engines", ON, CATALOG);
    expect(mail.startsWith("mailto:contact@caveman.so?subject=")).toBe(true);
    expect(decodeURIComponent(mail)).toContain("Higher Pay as you go limit for Analytical Engines");
    expect(decodeURIComponent(mail)).toContain("Up to now: $10,000 a month");
    expect(decodeURIComponent(disputeMail("Analytical Engines"))).toContain("Pay as you go paused for a dispute: Analytical Engines");
  });

  it("starts the form at $1,000 or the ceiling, and adds a tenth of the limit below half of that", () => {
    expect(defaultLimit(undefined, CATALOG)).toBe(500);
    expect(defaultLimit(undefined, { ...CATALOG, ceilings: [{ ...CATALOG.ceilings[1]!, after_paid_usd: 0 }] })).toBe(1000);
    expect(defaultLimit(ON, CATALOG)).toBe(10000);
    expect([10000, 50000, 500, 20, 250].map((limit) => defaultRefill(limit, CATALOG))).toEqual([
      { amount: 1000, below: 500 },
      { amount: 2000, below: 1000 },
      { amount: 50, below: 25 },
      { amount: 10, below: 5 },
      { amount: 25, below: 12 },
    ]);
    expect(paygDraft(undefined, CATALOG)).toEqual({ limit: "500", amount: "50", below: "25", custom: false });
    expect(paygDraft(ON, CATALOG)).toEqual({ limit: "10000", amount: "1000", below: "500", custom: false });
    // An amount the person set stays theirs.
    expect(paygDraft({ ...ON, amount_usd: 300, below_usd: 100 }, CATALOG)).toMatchObject({ amount: "300", below: "100", custom: true });
  });

  it("checks the form against Cloud's bounds, and sends an amount only when the person set one", () => {
    const draft = paygDraft(ON, CATALOG);
    expect(["10,000", "$500", " 20 ", "12.5", "-3", "0", "ten"].map(wholeDollars)).toEqual([10000, 500, 20, undefined, undefined, undefined, undefined]);
    expect(draftProblem(draft, CATALOG, 10000)).toBeNull();
    expect(draftProblem({ ...draft, limit: "" }, CATALOG, 10000)).toEqual({ field: "limit", text: "Enter the limit in whole dollars." });
    expect(draftProblem({ ...draft, limit: "15" }, CATALOG, 10000)).toEqual({ field: "limit", text: "The limit is at least $20 a month." });
    expect(draftProblem({ ...draft, limit: "20000" }, CATALOG, 10000)).toEqual({ field: "limit", text: "Up to $10,000 a month for now." });
    // Before anything is set the ceiling is Cloud's to check.
    expect(draftProblem({ ...draft, limit: "20000" }, CATALOG, undefined)).toBeNull();
    const own = { ...draft, custom: true };
    expect(draftProblem({ ...own, amount: "5" }, CATALOG, 10000)).toEqual({ field: "amount", text: "Add from $10 to $2,000 at a time." });
    expect(draftProblem({ ...own, limit: "300", amount: "400" }, CATALOG, 10000)).toEqual({ field: "amount", text: "Add from $10 to $300 at a time." });
    expect(draftProblem({ ...own, below: "1000" }, CATALOG, 10000)).toEqual({ field: "below", text: "Pick a balance from $5 to $999." });
    expect(draftProblem({ ...own, below: "4" }, CATALOG, 10000)?.field).toBe("below");
    expect(draftRequest(draft)).toEqual({ month_limit_usd: 10000 });
    expect(draftRequest({ ...own, amount: "300", below: "100" })).toEqual({ month_limit_usd: 10000, amount_usd: 300, below_usd: 100 });
    expect(draftChanged(draft, ON)).toBe(false);
    expect(draftChanged({ ...draft, limit: "12,000" }, ON)).toBe(true);
    expect(draftChanged({ ...own, amount: "300" }, ON)).toBe(true);
    expect(draftChanged(draft, undefined)).toBe(true);
  });
});
