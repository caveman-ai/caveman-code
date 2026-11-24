// Settings > Plan as it renders (account-model.ts decides the words): the plans Cloud serves and nothing of the app's
// own, where the plan's billing stands, a free month and the gifts a plan earned, and who may act on any of it.
import { readFileSync } from "node:fs";

import type { AccountSummary, CodeGift, CodeOffer } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { CATALOG, ON } from "./auto-topup.fixture.ts";
import { planDollars, PRIVATE_WORDS } from "./plan-dollars.fixture.ts";
import { PlanView } from "./Plan.tsx";

// The credits switch reads the runtime client; nothing here calls it.
const runtime = { client: null, connection: "open" } as unknown as RuntimeContextValue;

const offer = JSON.parse(readFileSync(new URL("./code-plans-offer.fixture.json", import.meta.url), "utf8")) as CodeOffer;
type Credits = NonNullable<AccountSummary["credits"]>;
const free: Credits = { plan: "free", seats: 1, windows: [], balance_micros: 0, grants: [], use_balance: true };
const ending: Credits = {
  ...free,
  plan: "max",
  windows: [{ window: "month", used_pct: 4 }],
  subscription: { plan: "max", seats: 1, status: "active", interval: "year", current_period_end: "2026-11-15T09:00:00Z", cancel_at_period_end: true, pending_update: false },
  customer_linked: true,
};
/** The offer as Cloud will serve it once its catalog carries Pay as you go. */
const withPayg: CodeOffer = { ...offer, auto_topup: CATALOG };
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const trial = (days: number): Credits => ({
  ...free,
  plan: "pro",
  windows: [{ window: "month", used_pct: 5 }],
  subscription: { plan: "pro", seats: 1, status: "active", interval: "month", current_period_end: inDays(days), trial_end: inDays(days), gift_from: "Julius", cancel_at_period_end: false, pending_update: false },
  customer_linked: true,
});
const gifts: CodeGift[] = [
  { code: "g1", url: "https://app.caveman.so/gift/g1", plan: "pro", plan_label: "Pro", months: 1, status: "redeemed", redeemed_by: "Sam Lee", redeemed_at: "2026-10-23T10:00:00Z" },
  { code: "g2", url: "https://app.caveman.so/gift/g2", plan: "pro", plan_label: "Pro", months: 1, status: "sent", sent_to: "kim@hey.com", sent_at: "2026-10-24T10:00:00Z" },
  { code: "g3", url: "https://app.caveman.so/gift/g3", plan: "pro", plan_label: "Pro", months: 1, status: "open" },
];

const render = (credits: Credits, over: { offer?: CodeOffer | null; canManage?: boolean; gifts?: CodeGift[] | null; plan?: string; thanks?: boolean; organization?: string } = {}) =>
  renderToStaticMarkup(
    createElement(
      RuntimeContext.Provider,
      { value: runtime },
      createElement(PlanView, {
        credits,
        offer: over.offer === undefined ? offer : over.offer,
        canManage: over.canManage ?? true,
        busy: false,
        error: null,
        notice: null,
        gifts: over.gifts ?? null,
        thanks: over.thanks ?? false,
        initialPlan: over.plan ?? null,
        onCheckout: () => undefined,
        onBilling: () => undefined,
        onSendGift: async () => undefined,
        creditsOn: false,
        onCreditsChange: () => undefined,
        organization: over.organization ?? "Analytical Engines",
        payg: { save: async () => undefined, changeCard: async () => undefined, confirm: () => undefined },
      }),
    ),
  );

/** One plan's card in the picker, by the plan's name. */
const card = (html: string, label: string) => html.match(/<article.*?<\/article>/g)!.find((a) => a.includes(`>${label}<span aria-hidden="true"`))!;
/** What markup says, as it reads: its words, one space apart. */
const said = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

test("a Code-only organization on Free sees every plan side by side, the recommended one raised", () => {
  const html = render(free);
  for (const label of ["Free", "Pro", "Pro $60", "Max $100", "Max $200"]) expect(html).toContain(`>${label}<`);
  // Every plan has its own button; the one note they share is said once, under the cards.
  for (const label of ["Pro", "Pro $60", "Max $100", "Max $200"]) expect(html).toContain(`>Choose ${label}<`);
  expect(html.match(/Checkout opens in your browser\. The plan starts as soon as Stripe confirms the payment\./g)).toHaveLength(1);
  expect(html).toContain(">Your plan<");
  expect(html).toContain("1 free month of Pro for friends");
  // The headline and plain words; no rate, no included dollars.
  expect(said(html)).toContain("Up to $60 of usage a month Goes furthest on open models");
  expect(html).not.toMatch(PRIVATE_WORDS);
  // On Free the recommended plan wears the ribbon, and it alone is raised with the filled button.
  expect(html.match(/>Recommended</g)).toHaveLength(1);
  expect(card(html, "Max $100")).toContain("data-raised");
  expect(card(html, "Max $100")).toContain(">Recommended<");
  expect(html.match(/data-raised/g)).toHaveLength(1);
  // Free brings nobody; a bigger plan brings more of the cast, and their line.
  expect(card(html, "Free")).not.toContain("px-strip");
  expect(card(html, "Pro").match(/px-strip /g)).toHaveLength(1);
  expect(card(html, "Max $200").match(/px-strip /g)).toHaveLength(4);
  expect(card(html, "Max $200")).toContain("Whole tribe code all day.");
  expect(html).toContain("Yearly · save 20%");
  for (const amount of ["$5", "$10", "$25", "$50", "$100"]) expect(html).toContain(`>${amount}<`);
  expect(html).not.toContain("Manage billing");
  expect(html).not.toContain(">Team<");
});

test("a link to a plan raises its card, with its limits and gifts", () => {
  const html = render(free, { plan: "max20" });
  expect(card(html, "Max $200")).toContain("data-raised");
  expect(html.match(/data-raised/g)).toHaveLength(1);
  expect(card(html, "Max $200")).toContain("Choose Max $200");
  expect(card(html, "Max $200")).toContain("3 free months of Pro for friends");
  // Limits read by name, exactly the ones Cloud lists for the plan, never as dollars or as a share of the month.
  expect(card(html, "Max $200")).toContain("5-hour, weekly and monthly limits");
  expect(html.match(/Limits keep one long day or week from using up the month\./g)).toHaveLength(1);
  expect(html).not.toMatch(/per 5 hours|per week|% of the month/);
  // A Cloud whose plans have no 5-hour window lists none, and none is named.
  const noFive = render(free, { plan: "max20", offer: { ...offer, plans: offer.plans.map((p) => ({ ...p, windows: ["week", "month"] })) } });
  expect(noFive).toContain("Weekly and monthly limits");
  expect(noFive).toContain("Limits keep a long week from using up the month.");
  expect(noFive).not.toContain("5-hour");
  // How it compares, in plain words.
  expect(said(card(html, "Max $200"))).toContain("Up to $660 of usage a month 11 times as much as Pro");
  expect(html).not.toMatch(PRIVATE_WORDS);
});

test("the plan held shows exactly the windows Cloud sends as bars, never dollars", () => {
  const windows = [
    { window: "5h", used_pct: 14 },
    { window: "week", used_pct: 40, resets_at: "2026-10-27T15:00:00Z" },
    { window: "month", used_pct: 47 },
  ];
  const html = render({ ...free, plan: "pro", windows });
  const plan = html.slice(0, html.indexOf("Plans<"));
  expect(plan).toContain(">5 hours<");
  expect(plan).toContain(">This week<");
  expect(plan).toContain(">This month<");
  expect(plan).toContain('aria-label="5 hours: 14% used"');
  expect(plan).toContain('aria-label="This week: 40% used"');
  expect(plan).toContain('aria-label="This month: 47% used"');
  expect(plan).not.toMatch(/\$\d+(\.\d\d)? of \$/);
  // A Cloud whose plans have no 5-hour window sends none, and none shows.
  const two = render({ ...free, plan: "pro", windows: windows.slice(1) });
  expect(two.slice(0, two.indexOf("Plans<"))).not.toContain("5 hours");
});

/** Max $100 mid-month: the week nearly used, the month at its limit, computers awake, credits and Pay as you go on. */
const busy: Credits = {
  ...free,
  plan: "max",
  windows: [
    { window: "week", used_pct: 85, resets_at: inDays(3) },
    { window: "month", used_pct: 100, resets_at: inDays(9) },
  ],
  balance_micros: 12_340_000,
  subscription: { plan: "max", seats: 1, status: "active", interval: "month", current_period_end: "2026-11-15T09:00:00Z", cancel_at_period_end: false, pending_update: false },
  customer_linked: true,
  computers: { kept: 3, kept_limit: 30, awake_gib: 32, awake_gib_limit: 384, max_size: "16x64", used_pct: 12 },
  auto_topup: ON,
};

test("someone on a plan sees what each button does beside it: a bigger plan now, a smaller one at renewal, Free through Manage billing", () => {
  const html = render(busy);
  // The plan held is raised and says so; nothing is recommended to someone who already chose.
  expect(card(html, "Max $100")).toContain("data-raised");
  expect(card(html, "Max $100")).toContain(">Your plan<");
  expect(html).not.toContain(">Recommended<");
  expect(card(html, "Max $200")).toContain(">Move to Max $200<");
  expect(card(html, "Max $200")).toContain("Starts now. You pay the difference for the rest of this period.");
  expect(card(html, "Pro")).toContain(">Move at renewal<");
  expect(card(html, "Pro")).toContain("Pro starts Nov 15. You keep Max $100 until Nov 15.");
  expect(card(html, "Free")).toContain(">Manage billing<");
  expect(card(html, "Free")).toContain("Cancel in Manage billing to move to Free. You keep Max $100 until Nov 15.");
});

test("Cloud shows its share of the month's plan as a percent: never dollars, GB, a size or a count of computers", () => {
  const html = render(busy);
  expect(html).toContain(">12% of this month<");
  expect(html).not.toMatch(/GB awake|16x64|By the minute|computers/);
  // The bars follow Cloud's percent.
  expect(html).toContain('aria-label="This week: 85% used"');
  expect(html).toContain('aria-label="This month: 100% used"');
  // Amber from 80% used and red at the limit, as the sidebar meter.
  expect(html).toMatch(/bg-warning[^>]*translateX\(-15%\)/);
  expect(html).toMatch(/bg-destructive[^>]*translateX\(-0%\)/);
  // Free holds no usage of its own: no limits to show, and Cloud says only that credits pay.
  const none = render({ ...free, computers: { kept: 1, kept_limit: 1, awake_gib: 0, awake_gib_limit: 16, max_size: "4x16" } });
  expect(none).not.toContain("% used");
  expect(none).toContain(">From credits<");
  expect(none).not.toMatch(/GB awake|By the minute/);
});

test("an older runtime's answer in dollars shows as the same bars, and its dollars nowhere", () => {
  const { used_pct: _, ...computers } = busy.computers!;
  const old = { ...busy, windows: [{ window: "week", cap_micros: 36_750_000, used_micros: 31_300_000 }], computers: { ...computers, spent_micros: 2_900_000 } } as unknown as Credits;
  const html = render(old);
  expect(html).toContain('aria-label="This week: 85% used"');
  expect(html).not.toMatch(/GB awake|From credits/);
  expect(html).not.toMatch(/\$31\.30|\$36\.75|\$2\.90|NaN/);
});

test("nothing about a plan is said in dollars but its price and its headline: the plan held, its limits, computers and every plan in the picker", () => {
  /** The page down to the Credits card: the plan held and the picker. Credits and Pay as you go below it are the person's own money. */
  const aboutPlans = (html: string) => {
    const credits = html.lastIndexOf(">Credits<");
    expect(credits).toBeGreaterThan(0);
    return html.slice(0, credits);
  };
  for (const plan of ["free", "pro", "go", "max", "max20", "team"]) {
    for (const credits of [busy, { ...busy, plan: "pro", subscription: { ...busy.subscription!, plan: "pro" } }, { ...busy, plan: "team", seats: 3, subscription: { ...busy.subscription!, plan: "team", seats: 3 } }, trial(2), free]) {
      const html = aboutPlans(render(credits, { offer: withPayg, plan }));
      expect(planDollars(html), `${credits.plan} looking at ${plan}`).toEqual([]);
      expect(html, `${credits.plan} looking at ${plan}`).not.toMatch(PRIVATE_WORDS);
    }
  }
  // The Credits card is where dollars belong: the balance, top-ups and Pay as you go.
  const own = render(busy, { offer: withPayg });
  expect(own.slice(own.lastIndexOf(">Credits<"))).toContain("$12.34");
});

test("a plan set to end says when, offers Resume and the billing portal, and holds plan changes", () => {
  const html = render(ending, { plan: "max20" });
  expect(html).toContain("Max $100");
  expect(html).toContain("Ends Nov 15, 2026. Resume to keep it.");
  expect(html).toContain("Resume plan");
  expect(html).toContain("Manage billing");
  expect(html).toContain("Resume your plan above before changing it.");
});

test("a free month says who gave it, when it ends and what then, and turns to the reminder in its last days", () => {
  const early = render(trial(20));
  expect(early).toContain("Free month, a gift from Julius, until");
  expect(early).toContain("Then $20 a month on your card. We&#x27;ll email you three days before it ends.");
  expect(early).toContain(">Free month<");
  const late = render(trial(2));
  expect(late).toContain("there&#x27;s nothing to do");
  expect(late).toContain("Cancel in Manage billing before then and nothing is charged.");
  expect(late).toContain(">Ends soon<");
  expect(render(trial(20), { plan: "max" })).toContain("Ends your free month and starts Max $100 now, billed today.");
  // Cancelled: nothing charged, Resume keeps Pro, and changes wait for it (Cloud refuses them until then).
  const stopped = trial(20);
  const cancelled = render({ ...stopped, subscription: { ...stopped.subscription!, cancel_at_period_end: true } }, { plan: "max" });
  expect(cancelled).toContain("You cancelled it, so nothing will be charged.");
  expect(cancelled).toContain("Resume plan");
  expect(cancelled).toContain("Resume your plan above before changing it.");
});

test("gifts list each free month: who took it, where it was sent, and the links still to give", () => {
  const credits: Credits = { ...ending, plan: "max20", subscription: { ...ending.subscription!, plan: "max20", cancel_at_period_end: false }, gifts: { open: 2, total: 3 } };
  const html = render(credits, { gifts, thanks: true });
  expect(html).toContain("Free months to give");
  expect(html).toContain("2 of 3 left");
  expect(html).toContain("Thanks for choosing Max $200. Max $200 came with 3 free months of Pro for friends.");
  expect(html).toContain("Sam Lee took it");
  expect(html).toContain("Sent to kim@hey.com");
  expect(html).toContain("Send again");
  expect(html).toContain("Send by email");
  expect(html.match(/Copy link/g)).toHaveLength(2);
  expect(render(free)).not.toContain("Free months to give");
});

test("a failed payment and a payment under review are shown, never hidden", () => {
  const html = render({ ...ending, subscription: { ...ending.subscription!, status: "past_due", cancel_at_period_end: false }, fulfillment_pending: 1 });
  expect(html).toContain("A payment failed");
  expect(html).toContain("Payment failed");
  expect(html).toContain("Payment being reviewed");
  expect(html).not.toContain("Resume plan");
});

test("only Owner and Finance act on billing; an older Cloud or one that takes no payments sells nothing here", () => {
  const viewer = render(ending, { canManage: false, plan: "max20" });
  expect(viewer).toContain("An owner of your organization can change the plan");
  expect(viewer).not.toContain("Resume plan");
  expect(viewer).not.toContain("Manage billing");
  expect(viewer).not.toContain("Move to Max $200");
  expect(render(free, { offer: null })).toContain("does not list its plans to the app yet");
  const closed = render(free, { offer: { ...offer, purchasable: false } });
  expect(closed).toContain("does not take payments");
  expect(closed).not.toContain(">$25<");
  expect(closed).not.toContain("Choose Pro");
});

/** The Pay as you go part of the page: from its row to the next row (Use credits). */
const payg = (html: string) => html.slice(html.indexOf("Pay as you go<"), html.indexOf("Use credits in the Caveman engine"));

test("Pay as you go off: one line, the limit at $1,000 or the ceiling with what unlocks more, and Turn on", () => {
  const html = payg(render(free, { offer: withPayg }));
  expect(html).toContain("When credits run low, your card adds more, never past a monthly limit you set.");
  expect(html).toContain("Monthly limit");
  expect(html).toContain('value="500"');
  expect(html).toContain("a month");
  expect(html).toContain(">Turn on<");
  expect(html).toContain("Up to $500 a month to start. $2,000 after $100 paid for 7 days.");
  // Ask for more: an email to Caveman naming the organization, a plain link the desktop hands to the mail app.
  expect(html).toMatch(/<a href="mailto:contact@caveman\.so\?subject=Higher%20Pay%20as%20you%20go%20limit%20for%20Analytical%20Engines[^"]*"[^>]*>Ask for a higher limit<\/a>/);
  expect(html).not.toContain('target="_blank"');
  // What one charge adds, Cloud's default from the limit, behind Change.
  expect(html).toContain("Adds $50 when credits fall below $25.");
  expect(html).toContain(">Change<");
  expect(html).toContain("Stripe opens in your browser once to save a card. Owners and Finance get an email at 80% and 100% of the limit.");
  expect(html).not.toContain("Turn off");
  expect(html).not.toContain("step");
  // Turned off with a card kept: the limit it had, and no trip to Stripe.
  const before = payg(render({ ...free, auto_topup: { ...ON, enabled: false } }, { offer: withPayg }));
  expect(before).toContain('value="10000"');
  expect(before).toContain("Up to $10,000 a month for now. $50,000 after $2,000 paid for 30 days · $350 so far.");
  expect(before).toContain("Charges the card you saved.");
});

test("Pay as you go on: the month so far, what it adds below what, the card, and Edit limit, Change card, Turn off", () => {
  const html = payg(render({ ...free, auto_topup: ON }, { offer: withPayg }));
  expect(html).toContain("$3,000 of $10,000 this month · Adds $1,000 when credits fall below $500 · Visa 4242");
  for (const action of ["Edit limit", "Change card", "Turn off"]) expect(html).toContain(`>${action}<`);
  expect(html).not.toContain("Turn on");
  // The form waits behind Edit limit.
  expect(html).not.toContain("Monthly limit");
  expect(html).not.toContain("text-warning");
  expect(payg(render({ ...free, auto_topup: { ...ON, charging: true } }, { offer: withPayg }))).toContain(">Adding $1,000<");
});

test("Pay as you go paused: amber, why in plain words, one fix, and Turn off while it is on", () => {
  const declined = payg(render({ ...free, auto_topup: { ...ON, paused: "card_declined" } }, { offer: withPayg }));
  expect(declined).toContain("text-warning");
  expect(declined).toContain(">Paused<");
  expect(declined).toContain("Your card was declined. Change the card to start again.");
  expect(declined.match(/<button/g)).toHaveLength(2);
  expect(declined).toContain(">Change card<");
  expect(declined).toContain(">Turn off<");
  const held = payg(render({ ...free, auto_topup: { ...ON, paused: "authentication_required", confirm_url: "https://invoice.stripe.test/i/1" } }, { offer: withPayg }));
  expect(held).toContain(">Confirm the payment<");
  expect(held).not.toContain("Change card");
  const disputed = payg(render({ ...free, auto_topup: { ...ON, paused: "disputed" } }, { offer: withPayg }));
  expect(disputed).toContain("A payment was disputed. Contact us to turn it back on.");
  expect(disputed).toMatch(/<a [^>]*href="mailto:contact@caveman\.so\?subject=Pay%20as%20you%20go%20paused%20for%20a%20dispute%3A%20Analytical%20Engines[^"]*"[^>]*>Contact us<\/a>/);
  expect(disputed.match(/<button/g)).toHaveLength(1);
  expect(disputed).toContain(">Turn off<");
  // Turned off during a dispute: it stays paused until Caveman clears it, with nothing left to turn off.
  const disputedOff = payg(render({ ...free, auto_topup: { ...ON, paused: "disputed", enabled: false } }, { offer: withPayg }));
  expect(disputedOff).toContain("A payment was disputed.");
  expect(disputedOff).not.toContain("<button");
  // On without a card (Stripe's page was left): add one, or turn it off.
  const noCard = payg(render({ ...free, auto_topup: { ...ON, card: null } }, { offer: withPayg }));
  expect(noCard).toContain("On, but no card is saved yet. Add one to start.");
  expect(noCard).toContain(">Add card<");
});

test("Pay as you go at its limit: says it starts again on the 1st and offers a higher limit", () => {
  const html = payg(render({ ...free, auto_topup: { ...ON, charged_micros: 9_500_000_000 } }, { offer: withPayg }));
  expect(html).toContain(">Limit reached<");
  expect(html).toContain("$9,500 of $10,000 this month. Another $1,000 would pass the limit, so nothing more is added until the 1st.");
  expect(html).toContain(">Raise limit<");
  expect(html).toContain("text-warning");
});

test("only Owner and Finance change Pay as you go; others see where it stands, and nothing while it is off", () => {
  const viewer = payg(render({ ...free, auto_topup: ON }, { offer: withPayg, canManage: false }));
  expect(viewer).toContain("$3,000 of $10,000 this month · Adds $1,000 when credits fall below $500");
  expect(viewer).not.toContain("Visa 4242");
  expect(viewer).not.toContain("<button");
  expect(viewer).not.toContain("<input");
  expect(payg(render({ ...free, auto_topup: { ...ON, paused: "card_declined" } }, { offer: withPayg, canManage: false }))).toContain("An owner of your organization can fix it.");
  expect(render(free, { offer: withPayg, canManage: false })).not.toContain("Pay as you go<");
  // A Cloud that offers none, or takes no payments: no controls of the app's own.
  const { auto_topup: _none, ...withoutPayg } = offer;
  expect(render(free, { offer: withoutPayg })).not.toContain("Pay as you go<");
  expect(render(free, { offer: { ...withPayg, purchasable: false } })).not.toContain("Pay as you go<");
  expect(payg(render({ ...free, auto_topup: ON }, { offer: withoutPayg }))).not.toContain("Turn off");
});
