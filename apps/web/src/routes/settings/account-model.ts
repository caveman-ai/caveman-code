import { usageWindows, wholePct, type AccountSummary, type CodeGift, type CodeOffer, type CodeSubscription, type CodeUsageWindow } from "@caveman-app/session-protocol";

/** Cloud's roles as Caveman names them (rbac.Describe): Analyst and Finance hold no Code seat. */
const ROLE_LABELS: Record<string, string> = { owner: "Owner", admin: "Platform admin", engineer: "Developer", viewer: "Analyst", billing: "Finance" };
export const roleLabel = (role: string) => ROLE_LABELS[role] ?? role;

/**
 * Who may buy, change and manage the plan: Cloud's billing:write, held by Owner
 * and Finance (rbac.go). A Platform admin may not: Cloud refuses them.
 */
export const canManageBilling = (role: string | undefined) => role === "owner" || role === "billing";

export type OfferPlan = CodeOffer["plans"][number];

/**
 * Plan names for where no offer is at hand (the sidebar's plan meter, a Cloud
 * older than GET /api/v1/code/plans). Names only: every price, allowance and
 * what is on sale comes from the offer Cloud serves (launch worklist B01).
 * The ids are Cloud's plan keys, which a Postgres CHECK pins.
 */
const PLAN_NAMES: Record<string, string> = { free: "Free", pro: "Pro", go: "Pro $60", max: "Max $100", max20: "Max $200", team: "Team" };

/** Any plan an organization holds, on sale or not. */
export const planLabel = (plan: string, offer?: CodeOffer | null) => offer?.plans.find((p) => p.plan === plan)?.label ?? PLAN_NAMES[plan] ?? plan;

/** The plans a new subscriber can buy, cheapest first, without the one the organization holds. */
export const plansOnSale = (offer: CodeOffer, held: string) => offer.plans.filter((p) => p.on_sale && p.plan !== held);

/** "Pro · $20 a month · up to $60 of usage", "Max $200 · $1,920 a year · up to $660 of usage a month". */
export const planOffer = (p: OfferPlan, interval: "month" | "year") =>
  `${p.label} · $${(interval === "year" ? p.usd_year : p.usd_month).toLocaleString("en-US")} a ${interval} · up to $${p.up_to_usd.toLocaleString("en-US")} of usage${interval === "year" ? " a month" : ""}`;

/** Top-up buttons: whole-dollar presets inside the range Cloud sells. */
const TOP_UP_PRESETS = [5, 10, 25, 50, 100];
export const topUps = (offer: CodeOffer) => TOP_UP_PRESETS.filter((amount) => amount >= offer.top_up.min_usd && amount <= offer.top_up.max_usd);

/**
 * How a plan's usage compares with the base plan's, in plain words and never in dollars (docs/ section 9), from the whole
 * `usage_times` Cloud works out: "5 times as much as Pro", "twice as much as Pro". Nothing for the base plan itself,
 * for a plan that holds no more, or where Cloud does not compare.
 */
export function usageComparison(p: OfferPlan, offer: CodeOffer): string | undefined {
  const base = offer.usage_base ? offer.plans.find((b) => b.plan === offer.usage_base) : undefined;
  if (!base || p.plan === base.plan || !p.usage_times || p.usage_times < 2) return undefined;
  const times = p.usage_times === 2 ? "twice" : `${Math.floor(p.usage_times).toLocaleString("en-US")} times`;
  return `${times} as much as ${base.label}`;
}

/** Where a plan is sold, the one thing said about how far its usage goes: no rate, no number. */
export const USAGE_GOES_FURTHEST = "Goes furthest on open models";

const day = (iso: string | undefined) => {
  const at = iso ? new Date(iso) : undefined;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : undefined;
};
/** "Nov 18": a date close enough that its year goes without saying. */
export const shortDay = (iso: string | undefined) => {
  const at = iso ? new Date(iso) : undefined;
  return at && !Number.isNaN(at.getTime()) ? at.toLocaleDateString("en-US", { month: "short", day: "numeric" }) : undefined;
};

/** Whole days from now until iso, at least 0; undefined without a date. */
export function daysUntil(iso: string | undefined, now = new Date()): number | undefined {
  const at = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isNaN(at) ? undefined : Math.max(0, Math.ceil((at - now.getTime()) / 86_400_000));
}

/** A free month's ending is worth the person's attention in its last three days: the reminder email goes out then too. */
export const TRIAL_REMINDER_DAYS = 3;

/**
 * One line on where the plan's billing stands, and whether it needs the person. A free month (a gift) says who gave
 * it, when it ends and what happens then, kindly: nothing to do to keep it, cancel before the end to pay nothing.
 */
export function subscriptionLine(sub: CodeSubscription, offer?: CodeOffer | null, now = new Date()): { text: string; attention: boolean } {
  const end = day(sub.current_period_end);
  const every = sub.interval === "year" ? "Yearly" : sub.interval === "month" ? "Monthly" : undefined;
  if (sub.trial_end && sub.status === "active") {
    const ends = shortDay(sub.trial_end) ?? "the end of the month";
    const from = sub.gift_from ? `, a gift from ${sub.gift_from},` : "";
    if (sub.cancel_at_period_end) return { text: `Your free month${from} ends ${ends}. You cancelled it, so nothing will be charged.`, attention: false };
    const price = offer?.plans.find((p) => p.plan === sub.plan)?.usd_month;
    const then = price ? `$${price} a month` : `${planLabel(sub.plan, offer)} at its monthly price`;
    const left = daysUntil(sub.trial_end, now) ?? Infinity;
    if (left <= TRIAL_REMINDER_DAYS) {
      return { text: `Your free month${from} ends ${ends}. To keep going, there's nothing to do: it continues at ${then}. Not for you? Cancel in Manage billing before then and nothing is charged.`, attention: true };
    }
    return { text: `Free month${from} until ${ends}. Then ${then} on your card. We'll email you three days before it ends.`, attention: false };
  }
  if (sub.status === "past_due") return { text: "A payment failed. The plan keeps working while Stripe retries; update the card in Manage billing.", attention: true };
  if (sub.status === "canceled") return { text: "Unpaid: you're on Free until the open invoice is paid in Manage billing.", attention: true };
  if (sub.status === "none") return { text: "Waiting for the first payment to go through.", attention: false };
  if (sub.cancel_at_period_end) return { text: end ? `Ends ${end}. Resume to keep it.` : "Ends with this period. Resume to keep it.", attention: true };
  if (sub.pending_update) return { text: "The upgrade starts once its prorated invoice is paid.", attention: true };
  if (sub.scheduled_plan) {
    const next = `${planLabel(sub.scheduled_plan, offer)}${sub.scheduled_interval ? ` (${sub.scheduled_interval === "year" ? "yearly" : "monthly"})` : ""}`;
    return { text: end ? `Changes to ${next} on ${end}.` : `Changes to ${next} at renewal.`, attention: false };
  }
  return { text: end ? `${every ? `${every}, renews` : "Renews"} ${end}.` : (every ?? "Active"), attention: false };
}

/**
 * What the account shows to tell a changed plan, balance or Pay as you go apart after Checkout, the billing portal
 * or Stripe's page to save a card: a card saved, changed or paused moves it.
 */
export const billingFingerprint = (credits: AccountSummary["credits"]) => {
  if (!credits) return "none";
  const a = credits.auto_topup;
  const payg = a ? [a.enabled, a.month_limit_usd, a.card ? [a.card.brand, a.card.last4, a.card.exp_month, a.card.exp_year] : null, a.paused, a.charged_micros] : null;
  return JSON.stringify([credits.plan, credits.seats, credits.balance_micros, credits.subscription ?? null, credits.fulfillment_pending ?? 0, credits.gifts ?? null, payg]);
};

export type AutoTopup = NonNullable<NonNullable<AccountSummary["credits"]>["auto_topup"]>;
export type AutoTopupCatalog = NonNullable<CodeOffer["auto_topup"]>;

/** Where Caveman answers, as Cloud's own app names it (cloud/web SUPPORT_EMAIL): the Code app had no address of its own. */
export const SUPPORT_EMAIL = "contact@caveman.so";

/** Stripe's card brands as people write them. */
const CARD_BRANDS: Record<string, string> = {
  visa: "Visa",
  mastercard: "Mastercard",
  amex: "American Express",
  discover: "Discover",
  diners: "Diners Club",
  jcb: "JCB",
  unionpay: "UnionPay",
  cartes_bancaires: "Cartes Bancaires",
  eftpos_au: "eftpos",
};
/** "Visa 4242". */
export const cardLabel = (card: NonNullable<AutoTopup["card"]>) => `${CARD_BRANDS[card.brand] ?? card.brand.charAt(0).toUpperCase() + card.brand.slice(1)} ${card.last4}`;

/** Micro-dollars as whole dollars when they are ("$3,000", "$0"), else as usd does. */
const money = (micros: number) => (Number.isInteger(micros / 1e6) ? dollars(micros / 1e6) : usd(micros));

/** "Adds $1,000 when credits fall below $500": what one charge does, never called a step. */
export const refillLine = (amount: number, below: number) => `Adds ${dollars(amount)} when credits fall below ${dollars(below)}`;

/**
 * What Cloud adds and below what when the person leaves them to it, from the limit (pay-as-you-go spec, Numbers): a
 * tenth of the limit rounded up, inside the catalog's bounds and never over the limit, and half of that in whole
 * dollars. Only a preview: an omitted amount is Cloud's to work out, and the page then shows Cloud's.
 */
export function defaultRefill(limit: number, catalog: AutoTopupCatalog): { amount: number; below: number } {
  const amount = Math.min(limit, Math.max(catalog.amount_usd.min, Math.min(catalog.amount_usd.max, Math.ceil(limit / 10))));
  return { amount, below: Math.max(catalog.below_usd.min, Math.floor(amount / 2)) };
}

/** The amount and threshold are the person's own rather than the default from the limit. */
export const customRefill = (a: AutoTopup, catalog: AutoTopupCatalog) => {
  const d = defaultRefill(a.month_limit_usd, catalog);
  return a.amount_usd !== d.amount || a.below_usd !== d.below;
};

/** What a new organization can set at once: the ceiling that asks for no paid history. */
export const startingCeiling = (catalog: AutoTopupCatalog) => (catalog.ceilings.find((c) => c.after_paid_usd === 0) ?? catalog.ceilings[0])?.month_usd ?? 0;

/** The limit field's first value: the limit set, else $1,000, or the starting ceiling where that is lower. */
export const defaultLimit = (a: AutoTopup | undefined, catalog: AutoTopupCatalog) => a?.month_limit_usd ?? Math.min(startingCeiling(catalog), 1000);

/** "$50,000 after $2,000 paid for 30 days". */
const unlock = (next: { readonly month_usd: number; readonly after_paid_usd: number; readonly after_days: number }) =>
  `${dollars(next.month_usd)} after ${dollars(next.after_paid_usd)} paid${next.after_days > 0 ? ` for ${plural(next.after_days, "day")}` : ""}`;

/**
 * Beside the limit field: the most the organization can set now, and what unlocks more with how much counts so far,
 * "Up to $10,000 a month for now. $50,000 after $2,000 paid for 30 days · $350 so far." Before anything is set, the
 * catalog's starting ceiling and the next one. At the top, or under a limit Caveman set by hand, only the first.
 */
export function ceilingLine(a: AutoTopup | undefined, catalog: AutoTopupCatalog): string {
  if (a) return `Up to ${dollars(a.ceiling_usd)} a month for now.${a.next_ceiling ? ` ${unlock(a.next_ceiling)} · ${dollars(a.next_ceiling.paid_usd)} so far.` : ""}`;
  const start = startingCeiling(catalog);
  const next = catalog.ceilings.find((c) => c.month_usd > start);
  return `Up to ${dollars(start)} a month to start.${next ? ` ${unlock(next)}.` : ""}`;
}

/** What the person typed in Pay as you go's form; `custom`: they opened Change and set their own amount and threshold. */
export interface PaygDraft {
  readonly limit: string;
  readonly amount: string;
  readonly below: string;
  readonly custom: boolean;
}

/** The form's first values: the limit, and the amount and threshold Cloud serves, else the default from the limit. */
export function paygDraft(a: AutoTopup | undefined, catalog: AutoTopupCatalog): PaygDraft {
  const limit = defaultLimit(a, catalog);
  const refill = a ? { amount: a.amount_usd, below: a.below_usd } : defaultRefill(limit, catalog);
  return { limit: String(limit), amount: String(refill.amount), below: String(refill.below), custom: a ? customRefill(a, catalog) : false };
}

/** Whole dollars from what was typed ("10,000", "$500"), or undefined. */
export function wholeDollars(text: string): number | undefined {
  const t = text.replace(/[$,\s]/g, "");
  if (!/^\d+$/.test(t)) return undefined;
  const n = Number(t);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/**
 * What is wrong with the form, said for the field it is on, or null: the limit in whole dollars from the catalog's
 * least up to the ceiling Cloud named (unknown before anything is set: Cloud then decides, and says why); an own
 * amount inside the catalog's bounds and never over the limit; an own threshold from the catalog's least and under
 * the amount.
 */
export function draftProblem(d: PaygDraft, catalog: AutoTopupCatalog, ceiling: number | undefined): { field: "limit" | "amount" | "below"; text: string } | null {
  const limit = wholeDollars(d.limit);
  if (limit === undefined) return { field: "limit", text: "Enter the limit in whole dollars." };
  if (limit < catalog.min_month_usd) return { field: "limit", text: `The limit is at least ${dollars(catalog.min_month_usd)} a month.` };
  if (ceiling !== undefined && limit > ceiling) return { field: "limit", text: `Up to ${dollars(ceiling)} a month for now.` };
  if (!d.custom) return null;
  const amount = wholeDollars(d.amount);
  const most = Math.min(catalog.amount_usd.max, limit);
  if (amount === undefined || amount < catalog.amount_usd.min || amount > most) return { field: "amount", text: `Add from ${dollars(catalog.amount_usd.min)} to ${dollars(most)} at a time.` };
  const below = wholeDollars(d.below);
  if (below === undefined || below < catalog.below_usd.min || below >= amount) return { field: "below", text: `Pick a balance from ${dollars(catalog.below_usd.min)} to ${dollars(amount - 1)}.` };
  return null;
}

/** account.auto_topup's settings from the form: the person's own amount and threshold only when they set them, else Cloud's default from the limit. */
export function draftRequest(d: PaygDraft): { month_limit_usd: number; amount_usd?: number; below_usd?: number } {
  const limit = wholeDollars(d.limit) ?? 0;
  if (!d.custom) return { month_limit_usd: limit };
  return { month_limit_usd: limit, amount_usd: wholeDollars(d.amount) ?? 0, below_usd: wholeDollars(d.below) ?? 0 };
}

/** The form changed from what Cloud holds (or nothing is held yet). */
export const draftChanged = (d: PaygDraft, a: AutoTopup | undefined) =>
  !a || wholeDollars(d.limit) !== a.month_limit_usd || (d.custom && (wholeDollars(d.amount) !== a.amount_usd || wholeDollars(d.below) !== a.below_usd));

const PAUSES: Record<NonNullable<AutoTopup["paused"]>, string> = {
  card_declined: "Your card was declined",
  authentication_required: "Your bank asked to confirm a payment",
  card_expired: "Your card expired",
  charge_failed: "A payment didn't go through",
  disputed: "A payment was disputed",
};

/** Where Pay as you go stands: off, adding credits, done for the month, paused, or on without a card. */
export type PaygState = "off" | "on" | "limit" | "paused" | "card";

export interface PaygStatus {
  readonly state: PaygState;
  /** The line under the name, every number Cloud's. */
  readonly line: string;
  /** Beside the name: what needs the person, or a charge landing now. */
  readonly tag?: { readonly text: string; readonly tone: "yellow" | "neutral" };
  /** Amber: paused, no card yet, or nothing more is added this month. */
  readonly attention: boolean;
  /** The one thing that sets it going again, for Owner and Finance. */
  readonly action?: "confirm" | "card" | "contact" | "raise";
}

/** The off line: what Pay as you go does, in one sentence. */
export const PAYG_OFF = "When credits run low, your card adds more, never past a monthly limit you set.";
const OWNER_FIXES = "An owner of your organization can fix it.";

/**
 * Pay as you go in a line, from Cloud's view. Paused says why in plain words and leads to its one fix: confirm the
 * payment on the invoice's page, a new card, or Caveman for a dispute (only Caveman clears it). On, the month so far,
 * what one charge adds below what, and the card (Owner and Finance only). Done for the month when the next charge
 * would pass the limit (or the ceiling, after a refund lowered it): it starts again on the 1st (UTC), or sooner with
 * a higher limit. Off while it is off, except a dispute, which stays until Caveman clears it.
 */
export function paygStatus(a: AutoTopup | undefined, canManage: boolean): PaygStatus {
  const off: PaygStatus = { state: "off", line: PAYG_OFF, attention: false };
  if (!a) return off;
  const paused = { text: "Paused", tone: "yellow" } as const;
  if (a.paused && (a.enabled || a.paused === "disputed")) {
    const why = `${PAUSES[a.paused]}.`;
    if (a.paused === "disputed") return { state: "paused", tag: paused, attention: true, line: `${why} ${canManage ? "Contact us to turn it back on." : OWNER_FIXES}`, action: "contact" };
    if (a.paused === "authentication_required" && a.confirm_url) {
      return { state: "paused", tag: paused, attention: true, line: `${why} ${canManage ? "Confirm it to add the credits and start again." : OWNER_FIXES}`, action: "confirm" };
    }
    return { state: "paused", tag: paused, attention: true, line: `${why} ${canManage ? "Change the card to start again." : OWNER_FIXES}`, action: "card" };
  }
  if (!a.enabled) return off;
  if (!a.card) {
    return {
      state: "card",
      tag: { text: "Needs a card", tone: "yellow" },
      attention: true,
      line: canManage ? "On, but no card is saved yet. Add one to start." : "On, but no card is saved yet. An owner of your organization can add one.",
      action: "card",
    };
  }
  const month = `${money(a.charged_micros)} of ${dollars(a.month_limit_usd)} this month`;
  const room = Math.min(a.month_limit_usd, a.ceiling_usd) * 1e6 - a.charged_micros;
  if (room < a.amount_usd * 1e6) {
    const why =
      a.ceiling_usd < a.month_limit_usd
        ? `For now your organization can add up to ${dollars(a.ceiling_usd)} a month`
        : room > 0
          ? `Another ${dollars(a.amount_usd)} would pass the limit`
          : "That's the limit";
    return { state: "limit", tag: { text: "Limit reached", tone: "yellow" }, attention: true, line: `${month}. ${why}, so nothing more is added until the 1st.`, action: "raise" };
  }
  return {
    state: "on",
    line: `${month} · ${refillLine(a.amount_usd, a.below_usd)}${canManage ? ` · ${cardLabel(a.card)}` : ""}`,
    attention: false,
    ...(a.charging ? { tag: { text: `Adding ${dollars(a.amount_usd)}`, tone: "neutral" as const } } : {}),
  };
}

const mailto = (subject: string, body: string) => `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

/** "Ask for a higher limit": an email to Caveman naming the organization and its limit now; Caveman raises it by hand, the same day. */
export function higherLimitMail(organization: string | undefined, a: AutoTopup | undefined, catalog: AutoTopupCatalog): string {
  const org = organization ?? "our organization";
  const now = a ? a.ceiling_usd : startingCeiling(catalog);
  return mailto(`Higher Pay as you go limit for ${org}`, `Organization: ${org}\nUp to now: ${dollars(now)} a month\nLimit we need: $\n`);
}

/** A dispute pauses Pay as you go until Caveman clears it: the email says which organization. */
export const disputeMail = (organization: string | undefined) => {
  const org = organization ?? "our organization";
  return mailto(`Pay as you go paused for a dispute: ${org}`, `Organization: ${org}\n`);
};

/** List-price micro-dollars as dollars: cents under $100, whole dollars above. */
export const usd = (micros: number) => {
  const dollars = micros / 1e6;
  return `$${Math.abs(dollars) < 100 ? dollars.toFixed(2) : Math.round(dollars).toLocaleString("en-US")}`;
};

/** The order a plan's limits show in: the shortest first. A limit Cloud names that is not here shows after them, by its name. */
const WINDOW_ORDER = ["5h", "week", "month"];
const WINDOW_LABELS: Record<string, string> = { "5h": "5 hours", week: "This week", month: "This month" };
export const windowLabel = (w: string) => WINDOW_LABELS[w] ?? w;

/**
 * The plan's limits that show: exactly the windows Cloud sends, no more and no fewer (a 5-hour window for as long as
 * Cloud meters one), each a whole percent used and its reset. What a plan holds stays private (docs/ section 9): Cloud says the
 * percent, and the caps an older runtime sent in micro-dollars become the percent here and go no further.
 */
export function planWindows(windows: unknown): CodeUsageWindow[] {
  const rank = (w: CodeUsageWindow) => {
    const at = WINDOW_ORDER.indexOf(w.window);
    return at < 0 ? WINDOW_ORDER.length : at;
  };
  return usageWindows(windows)
    .map((w, sent) => ({ w, sent }))
    .sort((a, b) => rank(a.w) - rank(b.w) || a.sent - b.sent)
    .map(({ w }) => w);
}

/**
 * Cloud on the Plan page: the share of this month's plan it took, "12% of this month"; where the plan has
 * no usage of its own (Free), that it runs on credits; nothing where a plan's Cloud names no share. Never an amount,
 * a rate, a size or a count of computers: a plan shows a percent and its reset, and nothing else.
 */
export function computersLine(c: { readonly used_pct?: number | undefined }, planUsage: boolean): string | undefined {
  if (!planUsage) return "From credits";
  const used = wholePct(c.used_pct);
  return used === undefined ? undefined : `${used}% of this month`;
}

/** "Resets 3:00 PM" today, else "Resets Oct 20". */
export function resetsLabel(iso: string | undefined, now = new Date()): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  const sameDay = at.toDateString() === now.toDateString();
  return `Resets ${sameDay ? at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
}

/**
 * Free, which the offer never lists (Cloud sells it without a checkout): no included usage, the person's own keys
 * and logins, Caveman models and computers from credits.
 */
export const FREE_PLAN: OfferPlan = { plan: "free", label: "Free", usd_month: 0, usd_year: 0, per_seat: false, up_to_usd: 0, on_sale: true };

/**
 * The size picker's plans, cheapest first: Free, then every plan on sale for one person, and the plan held even when
 * it is retired, so it shows as yours. Per-seat plans (the retired Code Team) only when held.
 */
export function planLadder(offer: CodeOffer, held: string): ReadonlyArray<OfferPlan> {
  return [FREE_PLAN, ...offer.plans.filter((p) => p.plan === held || (p.on_sale && !p.per_seat))];
}

/** What choosing a plan in the picker does, from the plan held and its billing interval. */
export type PlanMove = "current" | "interval" | "buy" | "upgrade" | "downgrade" | "free";

export function planMove(target: OfferPlan, held: { plan: string; interval?: string | undefined }, interval: "month" | "year", offer: CodeOffer): PlanMove {
  if (target.plan === held.plan) return held.plan === "free" || !held.interval || held.interval === interval ? "current" : "interval";
  if (target.plan === "free") return "free";
  if (held.plan === "free") return "buy";
  const from = offer.plans.find((p) => p.plan === held.plan);
  const price = (p: OfferPlan, i: string | undefined) => (i === "year" ? p.usd_year : p.usd_month * 12);
  return !from || price(target, interval) > price(from, held.interval) ? "upgrade" : "downgrade";
}

const dollars = (n: number) => `$${Number.isInteger(n) ? n.toLocaleString("en-US") : n.toFixed(2)}`;

/** "$20" a month; yearly as its monthly share ("$16") with what is billed once a year. */
export function planPrice(p: OfferPlan, interval: "month" | "year"): { amount: string; per: string; billed?: string } {
  if (p.usd_month <= 0) return { amount: "$0", per: "forever" };
  if (interval === "year") return { amount: dollars(Math.round((p.usd_year / 12) * 100) / 100), per: "a month", billed: `${dollars(p.usd_year)} billed yearly` };
  return { amount: dollars(p.usd_month), per: "a month" };
}

/** The most a year of any plan on sale saves against twelve months, in whole percent: "save 20%". */
export function yearlySaving(offer: CodeOffer): number {
  let best = 0;
  for (const p of offer.plans) if (p.on_sale && p.usd_month > 0 && p.usd_year > 0) best = Math.max(best, 1 - p.usd_year / (p.usd_month * 12));
  return Math.round(best * 100);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const LIMIT_WORDS: Record<string, string> = { "5h": "5-hour", week: "weekly", month: "monthly" };

/**
 * A plan's limits by name, exactly the ones Cloud lists for it and never their size: "Weekly and monthly limits",
 * "5-hour, weekly and monthly limits". Nothing for a plan the month alone meters, or where Cloud names none.
 */
function limitsRow(windows: ReadonlyArray<string> | undefined): string | undefined {
  const names = WINDOW_ORDER.filter((w) => windows?.includes(w)).map((w) => LIMIT_WORDS[w]!);
  if (names.length < 2) return undefined;
  const list = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  return `${list.charAt(0).toUpperCase()}${list.slice(1)} limits`;
}

/** Who each plan is for, by Cloud's plan key, in the website's words. A plan with no line here shows none. */
const PLAN_FIT: Record<string, string> = {
  free: "For the keys and logins you already pay for",
  pro: "For everyday coding",
  go: "For coding most of the day",
  max: "For several agents at once",
  max20: "For agents that run all day",
};

/** One plan as its card in the picker says it, under its name and price. */
export interface PlanCard {
  /** Who it is for, in one line. */
  readonly fit?: string;
  /** What the plan is, first: the figure, the words under it, and one quieter line on how it compares. */
  readonly lead: { readonly figure: string; readonly rest: string; readonly line?: string };
  /** What else it holds, a short line each. */
  readonly rows: ReadonlyArray<string>;
}

/**
 * A plan's card: its headline ("Up to $60" of usage a month, the one dollar figure about what a plan holds) and how
 * it compares in plain words, then its limits by name, Cloud and gifts. Free: your own keys, and what credits pay
 * for. No included dollars, no rate, no size or count of computers (docs/
 * section 9).
 */
export function planCard(p: OfferPlan, offer: CodeOffer): PlanCard {
  const fit = PLAN_FIT[p.plan];
  if (p.plan === "free") {
    return { ...(fit ? { fit } : {}), lead: { figure: "Your own keys", rest: "and logins" }, rows: ["Caveman models from credits, at list price", "Cloud from credits"] };
  }
  const more = usageComparison(p, offer);
  const rows: string[] = [];
  const limits = limitsRow(p.windows);
  if (limits) rows.push(limits);
  // What Cloud can hold on a plan is ours to manage: the plan says only that Cloud runs on its usage.
  if (p.computers) rows.push("Cloud included in your usage");
  const gifts = p.gifts ?? 0;
  if (gifts > 0 && offer.gift) rows.push(`${plural(gifts, "free month")} of ${planLabel(offer.gift.plan, offer)} for friends`);
  return {
    ...(fit ? { fit } : {}),
    lead: { figure: `Up to ${dollars(p.up_to_usd)}`, rest: "of usage a month", line: more ? `${more.charAt(0).toUpperCase()}${more.slice(1)}` : USAGE_GOES_FURTHEST },
    rows,
  };
}

/**
 * The small print under the plans, said once for all of them: why a plan has limits, and how a gift works. Nothing
 * where no plan shown has either.
 */
export function plansSmallPrint(plans: ReadonlyArray<OfferPlan>, offer: CodeOffer): string | undefined {
  const limited = plans.filter((p) => limitsRow(p.windows));
  const said: string[] = [];
  if (limited.length > 0) said.push(limited.some((p) => p.windows?.includes("5h")) ? "Limits keep one long day or week from using up the month." : "Limits keep a long week from using up the month.");
  if (offer.gift && plans.some((p) => (p.gifts ?? 0) > 0)) said.push("Free months come with your first payment. Friends add a card and can cancel before the month ends.");
  return said.length > 0 ? said.join(" ") : undefined;
}

/** The picker's one action for the plan chosen, and the line beside it on what happens; null for the plan held. */
export function moveAction(
  move: PlanMove,
  target: OfferPlan,
  held: { label: string; periodEnd?: string | undefined; trial: boolean },
  interval: "month" | "year",
): { button: string; note: string; primary: boolean } | null {
  const end = shortDay(held.periodEnd);
  const until = end ? ` until ${end}` : " until this period ends";
  switch (move) {
    case "current":
      return null;
    case "buy":
      return { button: `Choose ${target.label}`, note: "Checkout opens in your browser. The plan starts as soon as Stripe confirms the payment.", primary: true };
    case "upgrade":
      return held.trial
        ? { button: `Move to ${target.label}`, note: `Ends your free month and starts ${target.label} now, billed today.`, primary: true }
        : { button: `Move to ${target.label}`, note: "Starts now. You pay the difference for the rest of this period.", primary: true };
    case "downgrade":
      return { button: "Move at renewal", note: `${target.label} starts ${end ?? "when this period ends"}. You keep ${held.label}${until}.`, primary: false };
    case "interval":
      return interval === "year"
        ? { button: "Switch to yearly", note: held.trial ? "Ends your free month and starts the year now, billed today." : "Starts now. You pay the difference for the rest of this period.", primary: true }
        : { button: "Switch to monthly", note: `Monthly billing starts ${end ?? "when this year ends"}.`, primary: false };
    case "free":
      return { button: "Manage billing", note: held.trial ? "Cancel your free month in Manage billing and nothing is charged." : `Cancel in Manage billing to move to Free. You keep ${held.label}${until}.`, primary: false };
  }
}

/** One gift as its row says it: who has it or where it is, and when. */
export function giftLine(g: CodeGift, now = new Date()): { label: string; description: string } {
  switch (g.status) {
    case "redeemed":
      return { label: `${g.redeemed_by ?? "A friend"} took it`, description: g.redeemed_at ? `On ${shortDay(g.redeemed_at)}` : "Their free month has started" };
    case "claimed":
      return { label: "A friend is checking out", description: "The link is in use right now. If they leave, it's free again in half an hour." };
    case "sent":
      return { label: `Sent to ${g.sent_to ?? "a friend"}`, description: `${g.sent_at ? `${ago(g.sent_at, now)} · ` : ""}Not taken yet` };
    case "open":
      return { label: `${plural(g.months, "free month")} of ${g.plan_label}`, description: "Copy the link or send it by email." };
  }
}

/** "Just now", "5 hours ago", "Oct 23". */
function ago(iso: string, now: Date): string {
  const at = new Date(iso).getTime();
  if (Number.isNaN(at)) return "";
  const minutes = Math.round((now.getTime() - at) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${plural(minutes, "minute")} ago`;
  if (minutes < 24 * 60) return `${plural(Math.round(minutes / 60), "hour")} ago`;
  return shortDay(iso) ?? "";
}

/** The gifts card's line: what the plan came with and how it works for the friend. */
export function giftsBlurb(plan: string, total: number, giftPlan: string, offer: CodeOffer | null): string {
  return `${planLabel(plan, offer)} came with ${plural(total, "free month", "free months")} of ${planLabel(giftPlan, offer)} for friends. They add a card to start, we email them three days before the month ends, and they can cancel before then without paying anything.`;
}
