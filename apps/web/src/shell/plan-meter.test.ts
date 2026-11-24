// The plan meter as it renders: the ring in the sidebar's account row, Free's row and the popover (plan-meter-model.ts decides).
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test } from "vitest";

import { readFileSync } from "node:fs";

import type { CodeOffer } from "@caveman-app/session-protocol";
import { ON } from "../routes/settings/auto-topup.fixture.ts";
import { planDollars, PRIVATE_WORDS } from "../routes/settings/plan-dollars.fixture.ts";
import { planMeter, readKept, type Credits, type PlanMeter } from "./plan-meter-model.ts";
import { GetAPlanRow, PlanRing, PlanUsageDetails } from "./PlanMeter.tsx";

const NOW = new Date(2026, 9, 22, 10, 0);
const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).toISOString();
const $ = (dollars: number) => Math.round(dollars * 1e6);
/** Pro with its week and its month this many percent used: all Cloud says of a limit, with its reset. */
const pro = (week: number, month: number, over: Partial<Credits> = {}): Credits => ({
  plan: "pro",
  seats: 1,
  windows: [
    { window: "week", used_pct: week, resets_at: at(27, 15) },
    { window: "month", used_pct: month, resets_at: at(31, 0) },
  ],
  balance_micros: $(12.34),
  grants: [],
  use_balance: true,
  ...over,
});
const offer = JSON.parse(readFileSync(new URL("../routes/settings/code-plans-offer.fixture.json", import.meta.url), "utf8")) as CodeOffer;
const meterOf = (credits: Credits, withOffer: CodeOffer | null = null) => {
  const m = planMeter({ signed_in: true, credits, offer: withOffer }, NOW);
  if (!m) throw new Error("no meter");
  return m;
};
const html = (meter: PlanMeter) =>
  renderToStaticMarkup(createElement(MemoryRouter, null, meter.kind === "windows" ? createElement(PlanRing, { meter }) : createElement(GetAPlanRow, { meter })));
const details = (meter: PlanMeter) => {
  if (meter.kind !== "windows") throw new Error("a plan with no limits has no popover");
  return renderToStaticMarkup(createElement(MemoryRouter, null, createElement(PlanUsageDetails, { meter })));
};
/** What the markup says, tags and their attributes left out. */
const said = (markup: string) => markup.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

test("a plan is a ring in the sidebar, its share and reset in words, never dollars", () => {
  const ring = html(meterOf(pro(40, 30)));
  // Nothing written: the ring is the whole meter, and the words are its name and its hover.
  expect(said(ring)).toBe("");
  expect(ring).not.toContain("$");
  expect(ring).toContain("<svg");
  expect(ring).toContain('stroke-dasharray="15.079644737231007 37.69911184307752"');
  // One keyboard stop that opens the popover, named in words.
  expect(ring).toContain('<button type="button" aria-label="Plan usage: Pro plan, this week: 40% used"');
  expect(ring).toContain('title="Pro plan, this week: 40% used. Resets Tue 3:00 PM"');
  expect(ring).toContain('aria-haspopup="dialog"');
  // The arc settles on a change, and stays still for reduced motion.
  expect(ring).toContain("motion-reduce:transition-none");
});

test("a plan's price is never in the sidebar: Pro $60 reads Pro there", () => {
  const ring = html(meterOf(pro(40, 30, { plan: "go" }), offer));
  expect(ring).toContain('aria-label="Plan usage: Pro plan, this week: 40% used"');
  expect(ring + details(meterOf(pro(40, 30, { plan: "go" }), offer))).not.toContain("$");
});

test("amber from 80% used, red and full at the cap", () => {
  expect(html(meterOf(pro(85, 60)))).toContain("text-warning");
  const cap = html(meterOf(pro(100, 70)));
  expect(cap).toContain("text-destructive");
  expect(cap).toContain('stroke-dasharray="37.69911184307752 37.69911184307752"');
  expect(cap).toContain('aria-label="Plan usage: Pro plan, this week: used up. Resets Tue 3:00 PM"');
  // The hover says the reset once.
  expect(cap).toContain('title="Pro plan, this week: used up. Resets Tue 3:00 PM"');
});

test("Free is its name and the way to a plan: no balance, no bar", () => {
  for (const balance_micros of [$(12.34), 0]) {
    const free = html(meterOf(pro(0, 0, { plan: "free", windows: [], balance_micros })));
    expect(said(free)).toBe("Free Get a plan");
    expect(free).toContain('href="/settings/plan"');
    expect(free).not.toContain('role="progressbar"');
    expect(free).not.toContain("$");
  }
});

test("the popover holds the week as its percent, its reset and a bar, and the way to Settings > Plan", () => {
  const calm = details(meterOf(pro(58, 47)));
  expect(said(calm)).toBe("Pro Plan usage This week 58% · Resets Tue 3:00 PM Plan and credits");
  const open = details(meterOf(pro(100, 70)));
  expect(said(open)).toBe("Pro Plan usage This week Used up · Resets Tue 3:00 PM Turns run on credits until the plan resets. Plan and credits");
  expect(open).not.toContain("5-hour");
  expect(open).not.toContain("This month");
  expect(open).toContain('role="progressbar"');
  expect(open).toContain('aria-label="This week: used up"');
  // No line about how far a model goes on a plan: that stays private.
  expect(open).not.toContain("GLM");
  expect(open).not.toMatch(PRIVATE_WORDS);
  expect(open).toContain('href="/settings/plan"');
  // The month joins the week only once it is used up.
  expect(said(details(meterOf(pro(40, 100))))).toContain("This week 40% · Resets Tue 3:00 PM This month Used up · Resets Oct 31");
});

test("the ring and the popover never say a dollar, at any fill: credits, Pay as you go and the next plan up are in Settings > Plan alone", () => {
  for (const [week, month] of [[0, 0], [40, 47], [85, 60], [99, 99], [100, 70], [100, 100]] as const) {
    const meter = meterOf(pro(week, month, { auto_topup: ON, computers: { kept: 2, kept_limit: 10, awake_gib: 32, awake_gib_limit: 160, max_size: "4x16", used_pct: 12 } }), offer);
    const both = html(meter) + details(meter);
    expect(planDollars(both)).toEqual([]);
    expect(both).not.toContain("$");
    expect(both).not.toMatch(/Pay as you go|Need more room|Move to|12\.34|Top up/);
    expect(both).not.toMatch(PRIVATE_WORDS);
  }
  // An older runtime's answer in dollars draws the same bar, and its dollars nowhere.
  const old = meterOf({ ...pro(0, 0), windows: [{ window: "week", cap_micros: $(7), used_micros: $(4.1) }] as unknown as Credits["windows"] });
  expect(html(old)).toContain('aria-label="Plan usage: Pro plan, this week: 58% used"');
  expect(html(old) + details(old)).not.toMatch(/\$|4\.1|NaN/);
});

test("a free month and gifts to give show in the popover, never on the ring", () => {
  const sub = { plan: "pro", seats: 1, status: "active", trial_end: at(30, 9), gift_from: "Julius", cancel_at_period_end: false, pending_update: false };
  const m = meterOf(pro(40, 47, { subscription: sub, gifts: { open: 2, total: 3 } }));
  const open = details(m);
  expect(open).toContain("Free month from Julius · ends Oct 30");
  expect(open).toContain("Give a free month");
  expect(open).toContain("2 left");
  expect(html(m)).not.toContain("Free month");
  expect(details(meterOf(pro(40, 47, { subscription: { ...sub, cancel_at_period_end: true } })))).toContain("ends Oct 30, nothing charged");
  expect(details(meterOf(pro(40, 47, { gifts: { open: 0, total: 3 } })))).not.toContain("Give a free month");
});

test("the kept answer carries the offer for the next launch, and drops a malformed one", () => {
  const credits = pro(14, 10);
  expect(readKept(JSON.stringify({ signed_in: true, credits, offer }))?.offer?.plans.length).toBe(offer.plans.length);
  expect(readKept(JSON.stringify({ signed_in: true, credits, offer: { plans: "no" } }))?.offer).toBeNull();
});
