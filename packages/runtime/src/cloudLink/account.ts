// The person's Caveman account in the app (account, plan,
// credits and members in the app over the Cloud API). The Code device grant
// (org:read, code:read, code:write, and billing:write when the role holds
// it) is kept sealed in the runtime's secret store (session-protocol/account.ts),
// never in a client, a log or a trace. A 401 refreshes it once, one refresh at
// a time, and saves the new pair; a refused refresh forgets it, so the app asks
// the person to sign in again.
import { parseCreditsModels } from "@caveman-app/provider-caveman/server";
import { usageWindows, wholePct } from "@caveman-app/session-protocol";

import { CALL_TIMEOUT_MS } from "./computers.ts";
import { within } from "./copy.ts";
import { CloudError, cloudFailure } from "./identity.ts";

/** Where an earlier build kept the sign-in unsealed; read once and moved (session-protocol/account.ts). */
export const ACCOUNT_SECRET = "caveman-account-session";

export interface AccountSession {
  readonly cloud_url: string;
  readonly access_token: string;
  readonly refresh_token?: string | undefined;
  /** The credits key this runtime minted, revoked when credits go off or the person signs out. */
  readonly credits_key_id?: string | undefined;
  readonly routing_key?: string | undefined;
  readonly routing_expires_at?: string | undefined;
  /** The gateway the Cloud's device grant named: where a Cloud other than Caveman's hosted one takes credits and Auto (hosted.ts cloudGateway). */
  readonly gateway_url?: string | undefined;
}

/** Where the session lives: the runtime secret store in production, memory in tests. */
export interface AccountStore {
  readonly load: () => Promise<AccountSession | undefined>;
  readonly save: (session: AccountSession | undefined) => Promise<void>;
}

export function decodeSession(bytes: Uint8Array): AccountSession | undefined {
  try {
    const s = JSON.parse(new TextDecoder().decode(bytes)) as Partial<AccountSession>;
    return typeof s.cloud_url === "string" && typeof s.access_token === "string" && s.access_token !== ""
      ? { cloud_url: s.cloud_url, access_token: s.access_token, ...(typeof s.refresh_token === "string" ? { refresh_token: s.refresh_token } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Signed out, or the sign-in ended (revoked, expired): the person signs in again. */
export class SignedOut extends Error {}

/** One Cloud call with the kept sign-in (a JSON body, or a FormData sent as multipart), given up on after CALL_TIMEOUT_MS. Throws SignedOut when there is none or it no longer works. */
export async function accountCall(store: AccountStore, route: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const session = await store.load();
  if (!session) throw new SignedOut("Sign in to Caveman to see your account.");
  const call = (token: string) =>
    within(CALL_TIMEOUT_MS, fetchImpl)(`${session.cloud_url}${route}`, {
      method: init.method ?? "GET",
      ...(init.signal ? { signal: init.signal } : {}),
      // A form (a problem report's parts) sets its own multipart content type, boundary included.
      headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(init.body === undefined || init.body instanceof FormData ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: init.body instanceof FormData ? init.body : JSON.stringify(init.body) }),
    });
  let response = await call(session.access_token);
  if (response.status !== 401) return response;
  await response.body?.cancel();
  const fresh = await refreshOnce(store, session.access_token, fetchImpl);
  response = await call(fresh.access_token);
  if (response.status === 401) {
    await forgetIf(store, (kept) => kept.access_token === fresh.access_token);
    throw new SignedOut("Your Caveman sign-in ended. Sign in again.");
  }
  return response;
}

/** Forgets the kept sign-in only if it is still the one `which` names: a concurrent call may have replaced it. */
async function forgetIf(store: AccountStore, which: (kept: AccountSession) => boolean) {
  const kept = await store.load();
  if (kept && which(kept)) await store.save(undefined);
}

/** One refresh per store at a time: Cloud honours each refresh token once, so a second would sign the person out. */
const refreshing = new WeakMap<AccountStore, Promise<AccountSession>>();

function refreshOnce(store: AccountStore, expired: string, fetchImpl: typeof fetch): Promise<AccountSession> {
  const running = refreshing.get(store);
  if (running) return running;
  const flight = (async () => {
    const kept = await store.load();
    if (!kept) throw new SignedOut("Your Caveman sign-in ended. Sign in again.");
    // Another call refreshed already: use the pair it kept.
    if (kept.access_token !== expired) return kept;
    // Given up on in time: every caller waits on this one refresh (sign-out, the proxies, the routing key, each 401).
    const refreshed = kept.refresh_token
      ? await within(CALL_TIMEOUT_MS, fetchImpl)(`${kept.cloud_url}/api/v1/auth/refresh`, {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ refresh_token: kept.refresh_token }),
        }).catch(() => undefined)
      : undefined;
    const pair = refreshed?.ok ? ((await refreshed.json()) as { access_token?: string; refresh_token?: string }) : undefined;
    if (!pair?.access_token) {
      // Unreachable or failing (a deploy's 5xx, Cloud's auth rate limit) is not refused: keep the sign-in for the next try.
      if (refreshed === undefined && kept.refresh_token) throw new CloudError(503, "Caveman is not reachable right now.");
      if (refreshed !== undefined && (refreshed.status >= 500 || refreshed.status === 408 || refreshed.status === 429)) throw await cloudFailure(refreshed);
      await forgetIf(store, (now) => now.refresh_token === kept.refresh_token);
      throw new SignedOut("Your Caveman sign-in ended. Sign in again.");
    }
    // Signed out, or in again, while Cloud answered: the refreshed pair is not this sign-in's to keep.
    const latest = await store.load();
    if (!latest) throw new SignedOut("Your Caveman sign-in ended. Sign in again.");
    if (latest.refresh_token !== kept.refresh_token) return latest;
    const next = { ...latest, access_token: pair.access_token, refresh_token: pair.refresh_token ?? kept.refresh_token };
    await store.save(next);
    return next;
  })().finally(() => refreshing.delete(store));
  refreshing.set(store, flight);
  return flight;
}

/** Whether a Cloud access token expires within `marginMs`: its first dot-separated part is base64url JSON with `exp` (as caveman-proxy reads it). */
const expiresSoon = (token: string, now: number, marginMs: number): boolean => {
  try {
    const exp = (JSON.parse(Buffer.from(token.split(".")[0]!, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && exp * 1000 < now + marginMs;
  } catch {
    return false; // not a token this reads; Cloud decides
  }
};

/**
 * The kept sign-in, refreshed first when its access token is about to expire:
 * the app's proxies read it from a file and never spend the refresh token. A
 * failed refresh keeps what there is.
 */
export async function freshSession(store: AccountStore, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<AccountSession | undefined> {
  const session = await store.load();
  if (!session || !session.refresh_token || !expiresSoon(session.access_token, now, 5 * 60_000)) return session;
  return refreshOnce(store, session.access_token, fetchImpl).catch(() => store.load());
}

async function json<T>(response: Response): Promise<T> {
  if (!response.ok) throw await cloudFailure(response);
  return (await response.json()) as T;
}

/** One limit of the plan: whole percent used and when it starts over, never its size (session-protocol CodeUsageWindow). */
export interface CreditsWindow {
  readonly window: string;
  readonly used_pct: number;
  readonly resets_at?: string;
}
export interface CreditsGrant {
  readonly kind: string;
  readonly amount_micros: number;
  readonly remaining_micros: number;
  readonly expires_at?: string;
}
/** The bound Code plan subscription as Stripe last reported it (session-protocol CodeSubscription). */
export interface Subscription {
  readonly plan: string;
  readonly seats: number;
  readonly status: string;
  readonly interval?: string;
  readonly current_period_end?: string;
  readonly cancel_at_period_end: boolean;
  readonly scheduled_plan?: string;
  readonly scheduled_interval?: string;
  readonly scheduled_seats?: number;
  readonly pending_update: boolean;
  /** While a free month runs: when it ends, and who gave it. */
  readonly trial_end?: string;
  readonly gift_from?: string;
}
export interface Credits {
  readonly plan: string;
  readonly seats: number;
  readonly windows: ReadonlyArray<CreditsWindow>;
  readonly balance_micros: number;
  readonly grants: ReadonlyArray<CreditsGrant>;
  readonly use_balance: boolean;
  readonly subscription?: Subscription;
  readonly customer_linked?: boolean;
  readonly fulfillment_pending?: number;
  readonly computers?: Computers;
  /** Free months to give: still to give, of all earned (GET /api/v1/code/credits `gifts`). */
  readonly gifts?: { readonly open: number; readonly total: number };
  /** Pay as you go (GET /api/v1/code/credits `auto_topup`), absent until first set. */
  readonly auto_topup?: AutoTopup;
}
/** Why Cloud stopped charging the saved card (broker_auto_topups.paused_reason). */
export type AutoTopupPause = "card_declined" | "authentication_required" | "card_expired" | "disputed" | "charge_failed";
/** Pay as you go as Cloud serves it (session-protocol CodeAutoTopup): every number is Cloud's. */
export interface AutoTopup {
  readonly enabled: boolean;
  readonly month_limit_usd: number;
  readonly amount_usd: number;
  readonly below_usd: number;
  readonly charged_micros: number;
  readonly charging: boolean;
  readonly card: { readonly brand: string; readonly last4: string; readonly exp_month: number; readonly exp_year: number } | null;
  readonly paused: AutoTopupPause | null;
  /** The open invoice's page while paused for authentication_required: https only, else null. */
  readonly confirm_url: string | null;
  readonly ceiling_usd: number;
  readonly next_ceiling: { readonly month_usd: number; readonly after_paid_usd: number; readonly after_days: number; readonly paid_usd: number } | null;
}
/** Pay as you go in the plan catalog (GET /api/v1/code/plans `auto_topup`; session-protocol CodeAutoTopupCatalog). */
export interface AutoTopupCatalog {
  readonly min_month_usd: number;
  readonly amount_usd: { readonly min: number; readonly max: number };
  readonly below_usd: { readonly min: number };
  readonly alert_pcts: ReadonlyArray<number>;
  readonly ceilings: ReadonlyArray<{
    readonly month_usd: number;
    readonly after_paid_usd: number;
    readonly after_days: number;
    readonly requests_per_minute: number;
    readonly concurrent_requests: number;
  }>;
}
/** Cloud computers against the plan (GET /api/v1/code/credits `computers`): kept and awake memory now, their limits, and the share of this month's plan their time took. */
export interface Computers {
  readonly kept: number;
  readonly kept_limit: number;
  readonly awake_gib: number;
  readonly awake_gib_limit: number;
  readonly max_size: string;
  readonly used_pct?: number;
}
/**
 * The plans a Caveman Cloud sells, from its catalog (GET /api/v1/code/plans; session-protocol CodeOffer). The only
 * dollars about what a plan holds are its price and its `up_to_usd` headline (docs/ section 9).
 */
export interface Offer {
  readonly catalog_version: number;
  readonly purchasable: boolean;
  readonly plans: ReadonlyArray<{
    readonly plan: string;
    readonly label: string;
    readonly usd_month: number;
    readonly usd_year: number;
    readonly per_seat: boolean;
    readonly up_to_usd: number;
    readonly on_sale: boolean;
    readonly usage_times?: number;
    readonly windows?: ReadonlyArray<string>;
    readonly computers?: { readonly kept: number; readonly awake_gib: number; readonly max_size: string };
    readonly gifts?: number;
  }>;
  readonly gift?: { readonly plan: string; readonly months: number };
  readonly usage_base?: string;
  readonly top_up: { readonly min_usd: number; readonly max_usd: number; readonly expires_days: number };
  readonly auto_topup?: AutoTopupCatalog;
}
export interface Member {
  readonly email: string;
  readonly name?: string;
  readonly role: string;
  readonly status: string;
}
export interface AccountSummary {
  readonly cloud_url: string;
  readonly email: string;
  readonly role: string;
  readonly organization_name?: string;
  /** null: this Caveman Cloud sells no Code plans (the broker is off, or a customer install). */
  readonly credits: Credits | null;
  /** null: this Cloud lists no plans (no Code plans, or a Cloud older than GET /code/plans). */
  readonly offer: Offer | null;
  readonly members: ReadonlyArray<Member>;
}

/**
 * The limits that meter a plan, by name and never by size: as Cloud lists them, else worked out from the shares of
 * the month an older Cloud sent for the 5 hours and the week (a share that is the whole month limits nothing). The
 * shares themselves are dropped.
 */
function windowNames(plan: { readonly windows?: unknown; readonly window_5h_pct?: unknown; readonly window_week_pct?: unknown }): { windows?: ReadonlyArray<string> } {
  if (Array.isArray(plan.windows)) return { windows: plan.windows.filter((w): w is string => typeof w === "string") };
  const limits = (share: unknown) => typeof share === "number" && share > 0 && share < 100;
  if (typeof plan.window_5h_pct !== "number" && typeof plan.window_week_pct !== "number") return {};
  return { windows: [...(limits(plan.window_5h_pct) ? ["5h"] : []), ...(limits(plan.window_week_pct) ? ["week"] : []), "month"] };
}

/**
 * The plans on offer, read whole: only the fields the app shows, null for a Cloud that lists none. Whatever else a
 * Cloud sends about what a plan holds (an older one sent its included dollars, each model's rate, the size of its
 * limits and a computer minute's price) is dropped here and never reaches a client.
 */
async function readOffer(response: Response): Promise<Offer | null> {
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const o = (await response.json()) as Partial<Offer>;
  if (!Array.isArray(o.plans) || typeof o.top_up !== "object" || o.top_up === null) return null;
  return {
    catalog_version: Number(o.catalog_version ?? 0),
    purchasable: o.purchasable === true,
    plans: o.plans.map((p) => ({
      plan: p.plan,
      label: p.label,
      usd_month: p.usd_month,
      usd_year: p.usd_year,
      per_seat: p.per_seat === true,
      up_to_usd: p.up_to_usd,
      on_sale: p.on_sale === true,
      ...(typeof p.usage_times === "number" && p.usage_times >= 1 ? { usage_times: Math.floor(p.usage_times) } : {}),
      ...windowNames(p),
      ...(p.computers ? { computers: { kept: p.computers.kept, awake_gib: p.computers.awake_gib, max_size: p.computers.max_size } } : {}),
      ...(typeof p.gifts === "number" ? { gifts: p.gifts } : {}),
    })),
    ...(o.gift && typeof o.gift.plan === "string" && typeof o.gift.months === "number" ? { gift: { plan: o.gift.plan, months: o.gift.months } } : {}),
    ...(typeof o.usage_base === "string" && o.usage_base !== "" ? { usage_base: o.usage_base } : {}),
    top_up: { min_usd: o.top_up.min_usd, max_usd: o.top_up.max_usd, expires_days: o.top_up.expires_days },
    ...autoTopupCatalogOf(o.auto_topup),
  };
}

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
/** Dollars, micro-dollars, days and counts: finite and never below zero. */
const amount = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * Pay as you go's numbers from the catalog, read whole or not at all: a block
 * with a field missing or of another kind reads as none (an older Cloud), so
 * the app never offers limits it half understood. Alerts may be left out (no
 * emails promised); ceilings come cheapest first.
 */
function autoTopupCatalogOf(raw: unknown): { auto_topup?: AutoTopupCatalog } {
  const a = recordOf(raw);
  const add = recordOf(a?.amount_usd);
  const below = recordOf(a?.below_usd);
  if (!a || !add || !below || !amount(a.min_month_usd) || !amount(add.min) || !amount(add.max) || add.min > add.max || !amount(below.min)) return {};
  const alerts = a.alert_pcts ?? [];
  if (!Array.isArray(alerts) || !alerts.every((pct) => amount(pct) && pct <= 100)) return {};
  if (!Array.isArray(a.ceilings) || a.ceilings.length === 0) return {};
  const ceilings: Array<AutoTopupCatalog["ceilings"][number]> = [];
  for (const raw of a.ceilings) {
    const c = recordOf(raw);
    if (!c || !amount(c.month_usd) || !amount(c.after_paid_usd) || !amount(c.after_days) || !amount(c.requests_per_minute) || !amount(c.concurrent_requests)) return {};
    ceilings.push({ month_usd: c.month_usd, after_paid_usd: c.after_paid_usd, after_days: c.after_days, requests_per_minute: c.requests_per_minute, concurrent_requests: c.concurrent_requests });
  }
  ceilings.sort((x, y) => x.month_usd - y.month_usd);
  return { auto_topup: { min_month_usd: a.min_month_usd, amount_usd: { min: add.min, max: add.max }, below_usd: { min: below.min }, alert_pcts: [...(alerts as number[])], ceilings } };
}

const PAUSES = new Set<AutoTopupPause>(["card_declined", "authentication_required", "card_expired", "disputed", "charge_failed"]);

/**
 * Pay as you go as Cloud serves it, or undefined when the answer is not that
 * shape: a missing number or a malformed card drops the whole view rather than
 * show a limit, a charge or "no card" that Cloud did not say. A pause is its
 * reason (a bare string, or an object naming `reason`); a reason this runtime
 * does not know reads as a failed charge, so the page still says it is paused.
 * A confirm page that is not https is never offered.
 */
export function autoTopupOf(raw: unknown): AutoTopup | undefined {
  const a = recordOf(raw);
  if (!a || typeof a.enabled !== "boolean") return undefined;
  if (!amount(a.month_limit_usd) || !amount(a.amount_usd) || !amount(a.below_usd) || !amount(a.charged_micros) || !amount(a.ceiling_usd)) return undefined;
  let card: AutoTopup["card"] = null;
  if (a.card !== null && a.card !== undefined) {
    const c = recordOf(a.card);
    const month = c?.exp_month;
    const year = c?.exp_year;
    if (!c || typeof c.brand !== "string" || c.brand === "" || c.brand.length > 32 || typeof c.last4 !== "string" || !/^\d{4}$/.test(c.last4)) return undefined;
    if (!Number.isInteger(month) || (month as number) < 1 || (month as number) > 12 || !Number.isInteger(year) || (year as number) < 2000) return undefined;
    card = { brand: c.brand, last4: c.last4, exp_month: month as number, exp_year: year as number };
  }
  const reason = typeof a.paused === "string" ? a.paused : recordOf(a.paused)?.reason;
  if (a.paused !== null && a.paused !== undefined && (typeof reason !== "string" || reason === "")) return undefined;
  const paused = typeof reason === "string" ? (PAUSES.has(reason as AutoTopupPause) ? (reason as AutoTopupPause) : "charge_failed") : null;
  let next: AutoTopup["next_ceiling"] = null;
  if (a.next_ceiling !== null && a.next_ceiling !== undefined) {
    const n = recordOf(a.next_ceiling);
    if (!n || !amount(n.month_usd) || !amount(n.after_paid_usd) || !amount(n.after_days) || !amount(n.paid_usd)) return undefined;
    next = { month_usd: n.month_usd, after_paid_usd: n.after_paid_usd, after_days: n.after_days, paid_usd: n.paid_usd };
  }
  return {
    enabled: a.enabled,
    month_limit_usd: a.month_limit_usd,
    amount_usd: a.amount_usd,
    below_usd: a.below_usd,
    charged_micros: a.charged_micros,
    charging: a.charging === true,
    card,
    paused,
    confirm_url: typeof a.confirm_url === "string" && a.confirm_url.startsWith("https://") ? a.confirm_url : null,
    ceiling_usd: a.ceiling_usd,
    next_ceiling: next,
  };
}

/**
 * Cloud computers against the plan, from an older Cloud absent. Their share of the month's plan is Cloud's percent;
 * the dollars an older Cloud sent for their time are dropped.
 */
const computersOf = (c: Computers | undefined): { computers?: Computers } => {
  if (!c) return {};
  const used = wholePct(c.used_pct);
  return { computers: { kept: c.kept, kept_limit: c.kept_limit, awake_gib: c.awake_gib, awake_gib_limit: c.awake_gib_limit, max_size: c.max_size, ...(used === undefined ? {} : { used_pct: used }) } };
};

const subscriptionOf = (s: Subscription | undefined): { subscription?: Subscription } =>
  s
    ? {
        subscription: {
          plan: s.plan,
          seats: s.seats,
          status: s.status,
          ...(s.interval ? { interval: s.interval } : {}),
          ...(s.current_period_end ? { current_period_end: s.current_period_end } : {}),
          cancel_at_period_end: s.cancel_at_period_end === true,
          ...(s.scheduled_plan ? { scheduled_plan: s.scheduled_plan, ...(s.scheduled_interval ? { scheduled_interval: s.scheduled_interval } : {}), ...(s.scheduled_seats ? { scheduled_seats: s.scheduled_seats } : {}) } : {}),
          pending_update: s.pending_update === true,
          ...(s.trial_end ? { trial_end: s.trial_end } : {}),
          ...(s.gift_from ? { gift_from: s.gift_from } : {}),
        },
      }
    : {};

/** Who is signed in, their organization, plan, credits and members (read-only). */
export async function accountSummary(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<AccountSummary> {
  const get = (route: string) => accountCall(store, route, {}, fetchImpl);
  const me = await json<{ user?: { email?: string; role?: string } }>(await get("/api/v1/auth/me"));
  const org: { name?: string } = await get("/api/v1/org").then((r) => (r.ok ? (r.json() as Promise<{ name?: string }>) : {}));
  const members = await get("/api/v1/org/members").then((r) =>
    r.ok ? (r.json() as Promise<{ data?: ReadonlyArray<{ user?: { email?: string; name?: string }; role?: string; status?: string }> }>) : { data: [] },
  );
  const creditsResponse = await get("/api/v1/code/credits");
  // 404: no broker here. Anything else that fails is an error worth showing.
  const credits = creditsResponse.status === 404 ? (await creditsResponse.body?.cancel(), null) : await json<Credits>(creditsResponse);
  const offer = credits ? await get("/api/v1/code/plans").then(readOffer) : null;
  const autoTopup = credits ? autoTopupOf((credits as { auto_topup?: unknown }).auto_topup) : undefined;
  const session = (await store.load())!;
  return {
    cloud_url: session.cloud_url,
    email: me.user?.email ?? "",
    role: me.user?.role ?? "",
    ...(org.name ? { organization_name: org.name } : {}),
    credits: credits && {
      plan: credits.plan,
      seats: credits.seats,
      // Percent and reset only: an older Cloud's caps and use in micro-dollars become the percent and go no further.
      windows: usageWindows(credits.windows),
      balance_micros: credits.balance_micros,
      grants: (credits.grants ?? []).map((g) => ({ kind: g.kind, amount_micros: g.amount_micros, remaining_micros: g.remaining_micros, ...(g.expires_at ? { expires_at: g.expires_at } : {}) })),
      use_balance: credits.use_balance,
      ...subscriptionOf(credits.subscription),
      customer_linked: credits.customer_linked === true,
      fulfillment_pending: credits.fulfillment_pending ?? 0,
      ...computersOf(credits.computers),
      ...(credits.gifts ? { gifts: { open: credits.gifts.open, total: credits.gifts.total } } : {}),
      ...(autoTopup ? { auto_topup: autoTopup } : {}),
    },
    offer,
    members: (members.data ?? []).map((m) => ({ email: m.user?.email ?? "", ...(m.user?.name ? { name: m.user.name } : {}), role: m.role ?? "", status: m.status ?? "" })),
  };
}

export type CheckoutRequest =
  | { readonly kind: "plan"; readonly plan: string; readonly interval: "month" | "year"; readonly seats?: number | undefined }
  | { readonly kind: "topup"; readonly amount_usd: number };

export type CheckoutResult = { readonly url: string } | { readonly effective: "now" | "payment" | "renewal" };

/**
 * A Stripe Checkout URL for a Code plan or a credits top-up (the client opens
 * it in the browser). An organization whose plan is already bound (409
 * cave_code_plan_exists) moves it instead, and the answer says when.
 */
export async function accountCheckout(store: AccountStore, request: CheckoutRequest, fetchImpl: typeof fetch = fetch): Promise<CheckoutResult> {
  const plan = request.kind === "plan" ? { plan: request.plan, interval: request.interval, seats: request.seats ?? 1 } : undefined;
  const response = plan
    ? await accountCall(store, "/api/v1/code/plan/checkout", { method: "POST", body: plan }, fetchImpl)
    : await accountCall(store, "/api/v1/code/credits/checkout", { method: "POST", body: { amount_usd: (request as { amount_usd: number }).amount_usd } }, fetchImpl);
  if (plan && response.status === 409) {
    const refusal = await cloudFailure(response);
    if (refusal.code !== "cave_code_plan_exists") throw refusal;
    const moved = await json<{ effective?: string }>(await accountCall(store, "/api/v1/code/plan/change", { method: "POST", body: plan }, fetchImpl));
    return { effective: moved.effective === "payment" || moved.effective === "renewal" ? moved.effective : "now" };
  }
  const { url } = await json<{ url?: string }>(response);
  if (typeof url !== "string" || !url.startsWith("https://")) throw new CloudError(502, "Caveman sent no checkout page.");
  return { url };
}

/**
 * Manages the organization's Code billing: `portal` is Stripe's billing
 * portal (card, invoices, cancelling) for the client to open in the browser;
 * `resume` keeps a plan set to end renewing. Cancelling happens only in the
 * portal, never on this sign-in (Cloud refuses it).
 */
export async function accountBilling(store: AccountStore, action: "portal" | "resume", fetchImpl: typeof fetch = fetch): Promise<{ readonly url?: string }> {
  if (action === "resume") {
    await json<unknown>(await accountCall(store, "/api/v1/code/plan/resume", { method: "POST", body: {} }, fetchImpl));
    return {};
  }
  const { url } = await json<{ url?: string }>(await accountCall(store, "/api/v1/code/billing/portal", { method: "POST", body: {} }, fetchImpl));
  if (typeof url !== "string" || !url.startsWith("https://")) throw new CloudError(502, "Caveman sent no billing page.");
  return { url };
}

/** Pay as you go's settings as the app sends them: what is left out, Cloud keeps or defaults from the limit. */
export interface AutoTopupRequest {
  readonly enabled: boolean;
  readonly month_limit_usd?: number | undefined;
  readonly amount_usd?: number | undefined;
  readonly below_usd?: number | undefined;
}

/**
 * Pay as you go on or off, its monthly limit, and what one charge adds below
 * what (PUT /api/v1/code/credits/auto, billing:write). Turning it on with no
 * card saved also opens the card Checkout, whose `url` the client opens in the
 * browser; Cloud starts adding credits once Stripe saved the card. Cloud's
 * refusals (out of bounds, over the ceiling, a dispute) keep its words, which
 * name the numbers.
 */
export async function accountAutoTopup(store: AccountStore, request: AutoTopupRequest, fetchImpl: typeof fetch = fetch): Promise<{ readonly auto_topup: AutoTopup; readonly url?: string }> {
  const body: Record<string, unknown> = { enabled: request.enabled };
  for (const key of ["month_limit_usd", "amount_usd", "below_usd"] as const) if (request[key] !== undefined) body[key] = request[key];
  const answer = await json<unknown>(await accountCall(store, "/api/v1/code/credits/auto", { method: "PUT", body }, fetchImpl));
  // The view itself, as the spec answers it; an answer that wraps it under `auto_topup` reads the same.
  const view = autoTopupOf(recordOf(answer)?.auto_topup ?? answer);
  if (!view) throw new CloudError(502, "Caveman Cloud sent no pay as you go settings.");
  if (!view.enabled || view.card !== null) return { auto_topup: view };
  return { auto_topup: view, ...(await accountAutoTopupCard(store, fetchImpl)) };
}

/** Stripe's page to save a card for pay as you go (POST /api/v1/code/credits/auto/card), for the client to open in the browser. */
export async function accountAutoTopupCard(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<{ readonly url: string }> {
  const { url } = await json<{ url?: string }>(await accountCall(store, "/api/v1/code/credits/auto/card", { method: "POST", body: {} }, fetchImpl));
  if (typeof url !== "string" || !url.startsWith("https://")) throw new CloudError(502, "Caveman Cloud sent no page to save a card.");
  return { url };
}

/** One free month to give a friend (GET /api/v1/code/gifts; session-protocol CodeGift). */
export interface Gift {
  readonly code: string;
  readonly url: string;
  readonly plan: string;
  readonly plan_label: string;
  readonly months: number;
  readonly status: "open" | "sent" | "claimed" | "redeemed";
  readonly sent_to?: string;
  readonly sent_at?: string;
  readonly redeemed_by?: string;
  readonly redeemed_at?: string;
}

const GIFT_STATUSES = new Set<Gift["status"]>(["open", "sent", "claimed", "redeemed"]);

/** A gift as the app shows it, from Cloud's answer: a status this runtime does not know reads as claimed (not offered again). */
function giftOf(g: Partial<Gift>): Gift {
  return {
    code: String(g.code ?? ""),
    url: String(g.url ?? ""),
    plan: String(g.plan ?? ""),
    plan_label: String(g.plan_label ?? g.plan ?? ""),
    months: Number(g.months ?? 1),
    status: g.status && GIFT_STATUSES.has(g.status) ? g.status : "claimed",
    ...(g.sent_to ? { sent_to: g.sent_to } : {}),
    ...(g.sent_at ? { sent_at: g.sent_at } : {}),
    ...(g.redeemed_by ? { redeemed_by: g.redeemed_by } : {}),
    ...(g.redeemed_at ? { redeemed_at: g.redeemed_at } : {}),
  };
}

/** The free months the organization's plan earned to give; none on a Cloud that gives none (404). */
export async function accountGifts(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<{ readonly gifts: ReadonlyArray<Gift> }> {
  const response = await accountCall(store, "/api/v1/code/gifts", {}, fetchImpl);
  if (response.status === 404) {
    await response.body?.cancel();
    return { gifts: [] };
  }
  const { gifts } = await json<{ gifts?: ReadonlyArray<Partial<Gift>> }>(response);
  return { gifts: (gifts ?? []).map(giftOf) };
}

/** Emails a friend one gift's link; Cloud writes and sends it. */
export async function accountGiftSend(store: AccountStore, code: string, email: string, fetchImpl: typeof fetch = fetch): Promise<Gift> {
  return giftOf(await json<Partial<Gift>>(await accountCall(store, `/api/v1/code/gifts/${encodeURIComponent(code)}/send`, { method: "POST", body: { email } }, fetchImpl)));
}

/**
 * Mints a Caveman credits key for this person (shown once by Cloud) and keeps
 * its id with the sign-in, revoking one minted before; the caller keeps the
 * key where the engine reads it.
 */
/** What credits sell on the signed-in Cloud (GET /api/v1/code/credits/models); undefined where it has no broker. */
export async function creditsModelsOf(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<ReadonlyArray<string> | undefined> {
  const response = await accountCall(store, "/api/v1/code/credits/models", {}, fetchImpl);
  if (response.status === 404) return void (await response.body?.cancel());
  return parseCreditsModels(await json<unknown>(response));
}

export async function mintCreditsKey(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<string> {
  await revokeCreditsKey(store, fetchImpl).catch(() => undefined);
  const key = await json<{ id?: string; full_key?: string; key?: string }>(await accountCall(store, "/api/v1/code/credits/keys", { method: "POST", body: {} }, fetchImpl));
  const secret = key.full_key ?? key.key;
  if (typeof secret !== "string" || !secret.startsWith("cave_")) throw new CloudError(502, "Caveman sent no credits key.");
  const session = await store.load();
  if (session && typeof key.id === "string") await store.save({ ...session, credits_key_id: key.id });
  return secret;
}

/** Revokes the credits key this runtime minted, if any; already gone counts as done. */
export async function revokeCreditsKey(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  const id = (await store.load())?.credits_key_id;
  if (!id) return;
  const response = await accountCall(store, `/api/v1/code/credits/keys/${encodeURIComponent(id)}`, { method: "DELETE" }, fetchImpl);
  if (!response.ok && response.status !== 404) throw await cloudFailure(response);
  await response.body?.cancel();
  const session = await store.load();
  if (session?.credits_key_id === id) await store.save({ ...session, credits_key_id: undefined });
}

/** Revokes the credits key and ends the kept sign-in in Cloud (best effort), and forgets it here. */
export async function accountSignOut(store: AccountStore, fetchImpl: typeof fetch = fetch): Promise<void> {
  await revokeCreditsKey(store, fetchImpl).catch(() => undefined);
  // A refresh on its way spends the kept refresh token: Cloud ends the sign-in by the pair it answers.
  await refreshing.get(store)?.catch(() => undefined);
  const session = await store.load();
  await store.save(undefined);
  if (!session) return;
  await within(CALL_TIMEOUT_MS, fetchImpl)(`${session.cloud_url}/api/v1/auth/logout`, {
    method: "POST",
    headers: { authorization: `Bearer ${session.access_token}`, "content-type": "application/json" },
    body: JSON.stringify(session.refresh_token ? { refresh_token: session.refresh_token } : {}),
  }).catch(() => undefined);
}
