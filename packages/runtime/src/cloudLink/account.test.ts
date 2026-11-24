import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

import { accountAutoTopup, accountAutoTopupCard, accountBilling, accountCall, accountCheckout, accountSignOut, accountSummary, autoTopupOf, creditsModelsOf, freshSession, mintCreditsKey, SignedOut, type AccountSession, type AccountStore } from "./account.ts";
import { CALL_TIMEOUT_MS } from "./computers.ts";

/** GET /api/v1/code/plans as Cloud answers it: the app's byte copy of Cloud's golden file. */
/** Cloud's golden offer, less Pay as you go: each test says whether this Cloud sells it (`catalog`). */
const { auto_topup: GOLDEN_AUTO_TOPUP, ...OFFER } = JSON.parse(readFileSync(new URL("../../../../apps/web/src/routes/settings/code-plans-offer.fixture.json", import.meta.url), "utf8")) as Record<string, unknown>;

const CLOUD = "https://app.caveman.test";

/** Pay as you go in Cloud's plan catalog (`code.auto_topup`), as docs/ sets it. */
const CATALOG = {
  min_month_usd: 20,
  amount_usd: { min: 10, max: 2000 },
  below_usd: { min: 5 },
  alert_pcts: [80, 100],
  ceilings: [
    { month_usd: 500, after_paid_usd: 0, after_days: 0, requests_per_minute: 240, concurrent_requests: 32 },
    { month_usd: 2000, after_paid_usd: 100, after_days: 7, requests_per_minute: 360, concurrent_requests: 48 },
    { month_usd: 10000, after_paid_usd: 500, after_days: 14, requests_per_minute: 720, concurrent_requests: 96 },
    { month_usd: 50000, after_paid_usd: 2000, after_days: 30, requests_per_minute: 1500, concurrent_requests: 200 },
  ],
};
/** GET /api/v1/code/credits `auto_topup`, the spec's example. */
const VIEW = {
  enabled: true,
  month_limit_usd: 10000,
  amount_usd: 1000,
  below_usd: 500,
  charged_micros: 3_000_000_000,
  charging: false,
  card: { brand: "visa", last4: "4242", exp_month: 12, exp_year: 2028 },
  paused: null,
  confirm_url: null,
  ceiling_usd: 10000,
  next_ceiling: { month_usd: 50000, after_paid_usd: 2000, after_days: 30, paid_usd: 350 },
};

/**
 * What a Cloud from before 2026-11-09 sent about what a plan holds, and what a Cloud with its changeover switch on
 * still sends beside the percent (Caveman Cloud the spec): the runtime reads none of it into account.get.
 */
const LEGACY_OFFER = {
  basis: "list_price",
  rates: [
    { model: "z-ai/glm-5.3", rate_permille: 3000 },
    { model: "anthropic/claude-opus-5-5", rate_permille: 1000 },
  ],
  computer_minute_micros: { default: 3333, "4x16": 3333 },
};
const LEGACY_PLAN: Record<string, { included_usd: number; window_5h_pct: number; window_week_pct: number }> = {
  pro: { included_usd: 20, window_5h_pct: 35, window_week_pct: 35 },
  team: { included_usd: 40, window_5h_pct: 30, window_week_pct: 60 },
  go: { included_usd: 60, window_5h_pct: 35, window_week_pct: 35 },
  max: { included_usd: 105, window_5h_pct: 35, window_week_pct: 35 },
  max20: { included_usd: 220, window_5h_pct: 35, window_week_pct: 35 },
};
/** Everything private that must never be in what the runtime answers. */
const PRIVATE = /cap_micros|used_micros|spent_micros|minute_micros|included_usd|window_5h_pct|window_week_pct|rate_permille|monthly_micros|"rates"|"models"|"basis"/;

function memory(session?: AccountSession): AccountStore & { current: () => AccountSession | undefined } {
  let kept = session;
  return { load: async () => kept, save: async (s) => void (kept = s), current: () => kept };
}

/** A Cloud that accepts `valid` access tokens, rotates `refresh` once, and records every call. */
function cloud(opts: {
  valid: Set<string>;
  refresh?: Record<string, { access_token: string; refresh_token: string }>;
  credits?: number;
  bound?: boolean;
  plans?: number;
  portal?: string;
  /** GET /code/credits `auto_topup` and GET /code/plans `auto_topup`, when set. */
  autoTopup?: unknown;
  catalog?: unknown;
  /** A card is saved for pay as you go; the card page Cloud answers. */
  card?: boolean;
  cardUrl?: string;
  /**
   * How this Cloud says plan usage. Default: a percent and a reset. "old": a Cloud from before 2026-11-09, dollars
   * only. "both": the changeover switch on, the percent with the old dollars beside it.
   */
  shape?: "old" | "both";
}) {
  const percent = opts.shape !== "old";
  const dollars = opts.shape !== undefined;
  const calls: Array<{ method: string; path: string; auth?: string; body?: unknown }> = [];
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push({ method: init?.method ?? "GET", path: url.pathname, ...(auth ? { auth } : {}), ...(body ? { body } : {}) });
    if (url.pathname === "/api/v1/auth/refresh") {
      const next = opts.refresh?.[body.refresh_token];
      if (!next) return json(401, { error: { code: "cave_invalid_refresh" } });
      opts.valid.add(next.access_token);
      return json(200, { user: {}, ...next });
    }
    if (url.pathname === "/api/v1/auth/logout") return new Response(null, { status: 204 });
    if (!auth || !opts.valid.has(auth.replace("Bearer ", ""))) return json(401, { error: { code: "cave_unauthorized" } });
    switch (url.pathname) {
      case "/api/v1/auth/me":
        return json(200, { user: { email: "ada@caveman.test", role: "owner" } });
      case "/api/v1/org":
        return json(200, { name: "Analytical Engines" });
      case "/api/v1/org/members":
        return json(200, { data: [{ user: { email: "ada@caveman.test", name: "Ada" }, role: "owner", status: "active" }, { user: { email: "fin@caveman.test" }, role: "billing", status: "pending" }] });
      case "/api/v1/code/credits":
        return opts.credits === 404
          ? json(404, { error: { code: "cave_code_credits_unavailable" } })
          : json(200, { plan: "pro", seats: 1,
              windows: [
                { window: "5h", ...(percent ? { used_pct: 58 } : {}), ...(dollars ? { cap_micros: 7_000_000, used_micros: 4_100_000, started_at: "2026-10-16T15:00:00Z" } : {}), resets_at: "2026-10-16T20:00:00Z" },
                { window: "month", ...(percent ? { used_pct: 100 } : {}), ...(dollars ? { cap_micros: 20_000_000, used_micros: 20_400_000 } : {}), resets_at: "2026-11-01T00:00:00Z" },
              ],
              ...(dollars ? { models: [{ model: "z-ai/glm-5.3", rate_permille: 3000, monthly_micros: 60_000_000, remaining_micros: 0 }], basis: "list_price" } : {}),
              computers: { kept: 2, kept_limit: 10, awake_gib: 32, awake_gib_limit: 160, max_size: "4x16", ...(percent ? { used_pct: 12 } : {}), ...(dollars ? { spent_micros: 2_900_000, minute_micros: { default: 3333 } } : {}) },
              balance_micros: 12_500_000, grants: [{ id: "g", kind: "topup", amount_micros: 25_000_000, remaining_micros: 12_500_000, created_at: "2026-10-01T00:00:00Z" }], use_balance: true, contributor_opt_in: false,
              subscription: { plan: "pro", seats: 1, status: "active", interval: "month", current_period_end: "2026-11-15T09:00:00Z", cancel_at_period_end: true, pending_update: false }, customer_linked: true, fulfillment_pending: 1,
              ...(opts.autoTopup === undefined ? {} : { auto_topup: opts.autoTopup }) });
      case "/api/v1/code/plans":
        if (opts.plans === 404) return json(404, { error: { code: "not_found" } });
        return json(200, {
          ...OFFER,
          ...(dollars ? LEGACY_OFFER : {}),
          // A Cloud from before the change named no comparison and no limits; one in its changeover names both and the old dollars.
          plans: (OFFER["plans"] as ReadonlyArray<Record<string, unknown>>).map(({ usage_times, windows, ...p }) => ({ ...p, ...(percent ? { usage_times, windows } : {}), ...(dollars ? LEGACY_PLAN[p["plan"] as string] : {}) })),
          ...(percent ? {} : { usage_base: undefined }),
          ...(opts.catalog === undefined ? {} : { auto_topup: opts.catalog }),
        });
      case "/api/v1/code/credits/auto": {
        if (init?.method !== "PUT") return json(405, {});
        const limit = body.month_limit_usd ?? 500;
        if (limit > 10000) return json(409, { error: { code: "cave_code_auto_topup_over_ceiling", message: "Your organization can set up to $10,000 a month for now. $50,000 opens after $2,000 paid for 30 days." } });
        const add = body.amount_usd ?? Math.min(2000, Math.ceil(limit / 10));
        return json(200, { ...VIEW, enabled: body.enabled, month_limit_usd: limit, amount_usd: add, below_usd: body.below_usd ?? Math.floor(add / 2), charged_micros: 0, card: opts.card ? VIEW.card : null });
      }
      case "/api/v1/code/credits/auto/card":
        return json(200, { url: opts.cardUrl ?? "https://checkout.stripe.test/c/setup_1" });
      case "/api/v1/code/billing/portal":
        return json(200, { url: opts.portal ?? "https://billing.stripe.test/p/session_1" });
      case "/api/v1/code/plan/resume":
        return json(200, { plan: "pro", seats: 1, status: "active", cancel_at_period_end: false });
      case "/api/v1/code/plan/checkout":
        if (opts.bound) return json(409, { error: { code: "cave_code_plan_exists", message: "This organization already has a Caveman Code plan. Change it instead." } });
        return json(200, { url: "https://checkout.stripe.test/c/pay_1" });
      case "/api/v1/code/credits/checkout":
        return json(200, { url: "https://checkout.stripe.test/c/pay_1" });
      case "/api/v1/code/plan/change":
        return json(200, { plan: body.plan, seats: body.seats, status: "active", cancel_at_period_end: false, effective: "renewal" });
      case "/api/v1/code/credits/models":
        // Cloud's BrokerModel rows (control-api store/broker.go), trimmed.
        return opts.credits === 404
          ? json(404, { error: { code: "cave_code_credits_unavailable" } })
          : json(200, { basis: "list_price", models: [
              { model: "anthropic/claude-opus-5-5", provider: "anthropic", upstream_model: "claude-opus-5-5", gateway_path: "/v1/messages", wire: "anthropic", rate_permille: 1000, included: true, free_lane: false, data_policy: "zdr" },
              { model: "moonshot/kimi-k3", provider: "moonshot", upstream_model: "kimi-k3", gateway_path: "/moonshot/v1/chat/completions", wire: "openai", rate_permille: 1000, included: true, free_lane: true, free_daily_requests: 5, data_policy: "no_training" },
            ] });
      case "/api/v1/code/credits/keys":
        return json(201, { id: `key-${calls.length}`, full_key: `cave_live_${calls.length}` });
    }
    if (url.pathname.startsWith("/api/v1/code/credits/keys/") && init?.method === "DELETE") return new Response(null, { status: 204 });
    return json(404, {});
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("account", () => {
  it("reads who is signed in, the organization, plan, credits and members", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1", refresh_token: "r1" });
    const { fetchImpl } = cloud({ valid: new Set(["a1"]) });
    const summary = await accountSummary(store, fetchImpl);
    expect(summary).toMatchObject({ email: "ada@caveman.test", role: "owner", organization_name: "Analytical Engines" });
    expect(summary.credits).toMatchObject({ plan: "pro", balance_micros: 12_500_000 });
    // Plan usage is a percent and a reset; Cloud computers their share of the month's plan.
    expect(summary.credits?.windows).toEqual([
      { window: "5h", used_pct: 58, resets_at: "2026-10-16T20:00:00Z" },
      { window: "month", used_pct: 100, resets_at: "2026-11-01T00:00:00Z" },
    ]);
    expect(summary.credits?.computers).toEqual({ kept: 2, kept_limit: 10, awake_gib: 32, awake_gib_limit: 160, max_size: "4x16", used_pct: 12 });
    expect(summary.members.map((m) => m.role)).toEqual(["owner", "billing"]);
  });

  it("never passes on what a plan holds in dollars, whatever shape Cloud answers in", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const now = await accountSummary(store, cloud({ valid: new Set(["a1"]) }).fetchImpl);
    // A Cloud in its changeover sends the percent with the old dollars beside it: the same answer, the dollars dropped.
    const both = await accountSummary(store, cloud({ valid: new Set(["a1"]), shape: "both" }).fetchImpl);
    expect(both).toEqual(now);
    // A Cloud from before the change sent only dollars: the percent is worked out here (rounded down, 100 at the limit) and the dollars go no further.
    const old = await accountSummary(store, cloud({ valid: new Set(["a1"]), shape: "old" }).fetchImpl);
    expect(old.credits?.windows).toEqual(now.credits?.windows);
    // It named no share for computers and no comparison between plans: those are simply absent.
    expect(old.credits?.computers).toEqual({ kept: 2, kept_limit: 10, awake_gib: 32, awake_gib_limit: 160, max_size: "4x16" });
    expect(old.offer?.usage_base).toBeUndefined();
    // Its limits are named from the shares of the month it sent for the 5 hours and the week; the shares go no further.
    expect(old.offer?.plans.map((p) => [p.plan, p.up_to_usd, p.usage_times, p.windows])).toEqual(now.offer?.plans.map((p) => [p.plan, p.up_to_usd, undefined, ["5h", "week", "month"]]));
    for (const summary of [now, both, old]) {
      expect(JSON.stringify(summary)).not.toMatch(PRIVATE);
      // The headline and the price are what an offer says in dollars; credits are the person's own.
      expect(summary.offer?.plans.find((p) => p.plan === "pro")).toMatchObject({ usd_month: 20, usd_year: 192, up_to_usd: 60 });
      expect(summary.credits?.balance_micros).toBe(12_500_000);
    }
    // The offer no longer hangs on the rates: a Cloud that sends none still lists its plans.
    expect(now.offer?.plans.map((p) => [p.plan, p.usage_times, p.windows])).toEqual([
      ["pro", 1, ["5h", "week", "month"]],
      ["team", 2, ["5h", "week", "month"]],
      ["go", 3, ["5h", "week", "month"]],
      ["max", 5, ["5h", "week", "month"]],
      ["max20", 11, ["5h", "week", "month"]],
    ]);
    expect(now.offer?.usage_base).toBe("pro");
  });

  it("reads the plans Cloud sells and where the plan's billing stands", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const { fetchImpl } = cloud({ valid: new Set(["a1"]) });
    const summary = await accountSummary(store, fetchImpl);
    expect(summary.credits).toMatchObject({
      subscription: { plan: "pro", status: "active", interval: "month", current_period_end: "2026-11-15T09:00:00Z", cancel_at_period_end: true, pending_update: false },
      customer_linked: true,
      fulfillment_pending: 1,
    });
    expect(summary.offer).toMatchObject({ catalog_version: OFFER["catalog_version"], purchasable: true, top_up: { min_usd: 5, max_usd: 500 } });
    expect(summary.offer?.plans.filter((p) => p.on_sale).map((p) => [p.plan, p.usd_month, p.up_to_usd])).toEqual([
      ["pro", 20, 60],
      ["go", 60, 180],
      ["max", 100, 315],
      ["max20", 200, 660],
    ]);
    // A Cloud older than GET /code/plans still shows the account, with no offer of the app's own.
    const older = cloud({ valid: new Set(["a1"]), plans: 404 });
    const old = await accountSummary(store, older.fetchImpl);
    expect(old.offer).toBeNull();
    expect(old.credits?.plan).toBe("pro");
  });

  it("opens the billing portal and keeps a plan set to end renewing, with the person's own sign-in", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const { calls, fetchImpl } = cloud({ valid: new Set(["a1"]) });
    expect(await accountBilling(store, "portal", fetchImpl)).toEqual({ url: "https://billing.stripe.test/p/session_1" });
    expect(await accountBilling(store, "resume", fetchImpl)).toEqual({});
    expect(calls.map((c) => `${c.method} ${c.path} ${c.auth}`)).toEqual(["POST /api/v1/code/billing/portal Bearer a1", "POST /api/v1/code/plan/resume Bearer a1"]);
    // Cancelling is never asked of Cloud on this sign-in: it happens in the portal.
    expect(calls.some((c) => c.path === "/api/v1/code/plan/cancel")).toBe(false);
    const odd = cloud({ valid: new Set(["a1"]), portal: "http://billing.stripe.test/p/1" });
    await expect(accountBilling(store, "portal", odd.fetchImpl)).rejects.toThrow(/no billing page/);
  });

  it("says when this Cloud sells no Code plans", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const { fetchImpl } = cloud({ valid: new Set(["a1"]), credits: 404 });
    const summary = await accountSummary(store, fetchImpl);
    expect(summary.credits).toBeNull();
    expect(summary.offer).toBeNull();
  });

  it("reads which models credits sell from Cloud, and nothing where it sells none", async () => {
    const { fetchImpl, calls } = cloud({ valid: new Set(["a1"]) });
    expect(await creditsModelsOf(memory({ cloud_url: CLOUD, access_token: "a1" }), fetchImpl)).toEqual(["anthropic/claude-opus-5-5", "moonshot/kimi-k3"]);
    expect(calls.at(-1)).toMatchObject({ method: "GET", path: "/api/v1/code/credits/models", auth: "Bearer a1" });
    const none = cloud({ valid: new Set(["a1"]), credits: 404 });
    expect(await creditsModelsOf(memory({ cloud_url: CLOUD, access_token: "a1" }), none.fetchImpl)).toBeUndefined();
  });

  it("refreshes an expired access token once and keeps the new pair", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "old", refresh_token: "r1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(), refresh: { r1: { access_token: "a2", refresh_token: "r2" } } });
    await accountSummary(store, fetchImpl);
    expect(store.current()).toEqual({ cloud_url: CLOUD, access_token: "a2", refresh_token: "r2" });
    expect(calls.filter((c) => c.path === "/api/v1/auth/refresh")).toHaveLength(1);
  });

  it("refreshes once for calls that expire together, so Cloud's one-use refresh token never signs the person out", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "old", refresh_token: "r1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(), refresh: { r1: { access_token: "a2", refresh_token: "r2" } } });
    await Promise.all([accountSummary(store, fetchImpl), accountSummary(store, fetchImpl), accountSummary(store, fetchImpl)]);
    expect(calls.filter((c) => c.path === "/api/v1/auth/refresh")).toHaveLength(1);
    expect(store.current()).toEqual({ cloud_url: CLOUD, access_token: "a2", refresh_token: "r2" });
    // A call still holding the old token after the refresh landed uses the kept pair, not a second refresh.
    const late = memory({ cloud_url: CLOUD, access_token: "old", refresh_token: "r1" });
    const second = cloud({ valid: new Set(["a3"]) });
    const loads = { n: 0 };
    const racing: AccountStore = { load: async () => (loads.n++ === 0 ? late.current() : { cloud_url: CLOUD, access_token: "a3", refresh_token: "r3" }), save: late.save };
    await accountSummary(racing, second.fetchImpl);
    expect(second.calls.filter((c) => c.path === "/api/v1/auth/refresh")).toHaveLength(0);
  });

  it("forgets a sign-in Cloud no longer honours", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "old", refresh_token: "revoked" });
    const { fetchImpl } = cloud({ valid: new Set() });
    await expect(accountSummary(store, fetchImpl)).rejects.toBeInstanceOf(SignedOut);
    expect(store.current()).toBeUndefined();
    await expect(accountSummary(store, fetchImpl)).rejects.toBeInstanceOf(SignedOut);
  });

  it("keeps the sign-in when Cloud fails a refresh it never refused: a deploy's 5xx or its own rate limit", async () => {
    const kept: AccountSession = { cloud_url: CLOUD, access_token: "old", refresh_token: "r1", credits_key_id: "key-1", routing_key: "rk_1" };
    const failing = (status: number) =>
      (async (input: string) =>
        new URL(input).pathname === "/api/v1/auth/refresh"
          ? new Response(JSON.stringify({ error: { code: status === 429 ? "cave_auth_rate_limited" : "upstream_unavailable" } }), { status, headers: { "content-type": "application/json", "retry-after": "30" } })
          : new Response(JSON.stringify({ error: { code: "cave_unauthorized" } }), { status: 401 })) as typeof fetch;
    for (const status of [500, 502, 503, 429]) {
      const store = memory(kept);
      const error = await accountSummary(store, failing(status)).catch((e: unknown) => e);
      expect(error).not.toBeInstanceOf(SignedOut);
      expect(error).toMatchObject({ status });
      // Still signed in: the refresh token for the next try, and the credits key's id for sign-out to revoke.
      expect(store.current()).toEqual(kept);
    }
    // The proxies' path near expiry keeps what there is too.
    const soon = { ...kept, access_token: `${Buffer.from(JSON.stringify({ exp: 1_000 })).toString("base64url")}.sig` };
    const store = memory(soon);
    expect(await freshSession(store, failing(503), 1_000_000)).toEqual(soon);
    expect(store.current()).toEqual(soon);
  });

  it("opens checkout for a plan or a top-up with the person's own sign-in", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(["a1"]) });
    expect(await accountCheckout(store, { kind: "plan", plan: "team", interval: "year", seats: 3 }, fetchImpl)).toEqual({ url: "https://checkout.stripe.test/c/pay_1" });
    expect(await accountCheckout(store, { kind: "topup", amount_usd: 25 }, fetchImpl)).toEqual({ url: "https://checkout.stripe.test/c/pay_1" });
    expect(calls.filter((c) => c.method === "POST").map((c) => [c.path, c.body])).toEqual([
      ["/api/v1/code/plan/checkout", { plan: "team", interval: "year", seats: 3 }],
      ["/api/v1/code/credits/checkout", { amount_usd: 25 }],
    ]);
  });

  it("moves a plan the organization already has instead of a second checkout", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(["a1"]), bound: true });
    expect(await accountCheckout(store, { kind: "plan", plan: "go", interval: "month" }, fetchImpl)).toEqual({ effective: "renewal" });
    expect(calls.filter((c) => c.method === "POST").map((c) => c.path)).toEqual(["/api/v1/code/plan/checkout", "/api/v1/code/plan/change"]);
  });

  it("signs out in Cloud and forgets the sign-in here", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1", refresh_token: "r1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(["a1"]) });
    await accountSignOut(store, fetchImpl);
    expect(store.current()).toBeUndefined();
    expect(calls).toEqual([{ method: "POST", path: "/api/v1/auth/logout", auth: "Bearer a1", body: { refresh_token: "r1" } }]);
  });

  it("a sign-out while a refresh is on its way stays signed out, and ends the refreshed sign-in in Cloud", async () => {
    /** Cloud holding its refresh answer until `answer()`; `started` once the refresh is on its way. */
    const held = (valid: Set<string>) => {
      let answer!: () => void;
      const answered = new Promise<void>((resolve) => (answer = resolve));
      let start!: () => void;
      const started = new Promise<void>((resolve) => (start = resolve));
      const base = cloud({ valid, refresh: { r1: { access_token: "a2", refresh_token: "r2" } } });
      const fetchImpl = (async (input: string, init?: RequestInit) => {
        if (new URL(input).pathname === "/api/v1/auth/refresh") {
          start();
          await answered;
        }
        return base.fetchImpl(input, init);
      }) as typeof fetch;
      return { calls: base.calls, fetchImpl, answer, started };
    };
    const soon = `${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url")}.sig`;
    // The proxies' refresh near expiry, and an account call Cloud answered 401.
    for (const [access, refresh] of [
      [soon, (store: AccountStore, fetchImpl: typeof fetch) => freshSession(store, fetchImpl)],
      ["expired", (store: AccountStore, fetchImpl: typeof fetch) => accountCall(store, "/api/v1/auth/me", {}, fetchImpl)],
    ] as const) {
      const store = memory({ cloud_url: CLOUD, access_token: access, refresh_token: "r1" });
      const held$ = held(new Set([soon]));
      const refreshing = refresh(store, held$.fetchImpl).catch((e: unknown) => e);
      await held$.started;
      const signingOut = accountSignOut(store, held$.fetchImpl);
      held$.answer();
      await Promise.all([refreshing, signingOut]);
      expect(store.current()).toBeUndefined();
      // Cloud ends the sign-in as the refresh left it, not the refresh token it just spent.
      expect(held$.calls.filter((c) => c.path === "/api/v1/auth/logout").map((c) => c.body)).toEqual([{ refresh_token: "r2" }]);
    }
    // Signed out (or in again) some other way while Cloud answered: the refreshed pair is not this sign-in's to keep.
    for (const meanwhile of [undefined, { cloud_url: CLOUD, access_token: "a9", refresh_token: "r9" }]) {
      const store = memory({ cloud_url: CLOUD, access_token: "expired", refresh_token: "r1" });
      const held$ = held(new Set(["a9"]));
      const call = accountCall(store, "/api/v1/auth/me", {}, held$.fetchImpl).catch((e: unknown) => e);
      await held$.started;
      await store.save(meanwhile);
      held$.answer();
      const answer = await call;
      expect(store.current()).toEqual(meanwhile);
      if (meanwhile === undefined) expect(answer).toBeInstanceOf(SignedOut);
      else expect(answer).toMatchObject({ status: 200 });
    }
  });

  it("keeps the credits key's id, revokes it before minting another, and on sign-out", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1", refresh_token: "r1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(["a1"]) });
    expect(await mintCreditsKey(store, fetchImpl)).toMatch(/^cave_live_/);
    const first = store.current()?.credits_key_id;
    expect(first).toMatch(/^key-/);
    await mintCreditsKey(store, fetchImpl);
    expect(store.current()?.credits_key_id).not.toBe(first);
    await accountSignOut(store, fetchImpl);
    expect(calls.filter((c) => c.method === "DELETE").map((c) => c.path)).toEqual([`/api/v1/code/credits/keys/${first}`, expect.stringMatching(/^\/api\/v1\/code\/credits\/keys\/key-/)]);
    expect(calls.at(-1)?.path).toBe("/api/v1/auth/logout");
  });

  it("reads Pay as you go: the catalog's limits and the organization's own, every number Cloud's", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const on = await accountSummary(store, cloud({ valid: new Set(["a1"]), autoTopup: VIEW, catalog: CATALOG }).fetchImpl);
    expect(on.offer?.auto_topup).toEqual(CATALOG);
    // Cloud's own golden block reads whole.
    const golden = await accountSummary(store, cloud({ valid: new Set(["a1"]), catalog: GOLDEN_AUTO_TOPUP }).fetchImpl);
    expect(golden.offer?.auto_topup).toEqual(GOLDEN_AUTO_TOPUP);
    expect(on.credits?.auto_topup).toEqual(VIEW);
    // Absent until first set, and on a Cloud that offers none: no row of the app's own.
    const none = await accountSummary(store, cloud({ valid: new Set(["a1"]) }).fetchImpl);
    expect(none.offer).not.toHaveProperty("auto_topup");
    expect(none.credits).not.toHaveProperty("auto_topup");
    // A catalog block half understood is no offer: limits are never shown from a guess.
    const { amount_usd: _, ...noAmount } = CATALOG;
    for (const odd of [
      { ...CATALOG, min_month_usd: "20" },
      noAmount,
      { ...CATALOG, amount_usd: { min: 2000, max: 10 } },
      { ...CATALOG, below_usd: {} },
      { ...CATALOG, alert_pcts: ["80"] },
      { ...CATALOG, alert_pcts: [180] },
      { ...CATALOG, ceilings: [] },
      { ...CATALOG, ceilings: [{ month_usd: 1000 }] },
      [],
      "on",
    ]) {
      const read = await accountSummary(store, cloud({ valid: new Set(["a1"]), catalog: odd }).fetchImpl);
      expect(read.offer?.plans.length, JSON.stringify(odd)).toBeGreaterThan(0);
      expect(read.offer, JSON.stringify(odd)).not.toHaveProperty("auto_topup");
    }
    // Alerts left out promise no emails; ceilings read cheapest first whatever order Cloud sends.
    const { alert_pcts: __, ...noAlerts } = CATALOG;
    const quiet = await accountSummary(store, cloud({ valid: new Set(["a1"]), catalog: { ...noAlerts, ceilings: [...CATALOG.ceilings].reverse() } }).fetchImpl);
    expect(quiet.offer?.auto_topup).toEqual({ ...CATALOG, alert_pcts: [] });
  });

  it("drops a Pay as you go view it cannot read whole, and keeps a pause it does not know as paused", () => {
    expect(autoTopupOf(VIEW)).toEqual(VIEW);
    // Before a card is saved, and at the top ceiling.
    expect(autoTopupOf({ ...VIEW, card: null, next_ceiling: null })).toMatchObject({ card: null, next_ceiling: null });
    // A missing number, a card that is not one, or a negative amount is not shown at all.
    const { charged_micros: _, ...noCharged } = VIEW;
    for (const odd of [
      noCharged,
      { ...VIEW, enabled: "yes" },
      { ...VIEW, month_limit_usd: -1 },
      { ...VIEW, amount_usd: Number.NaN },
      { ...VIEW, amount_usd: undefined, step_usd: 1000 },
      { ...VIEW, card: { ...VIEW.card, last4: "42" } },
      { ...VIEW, card: { ...VIEW.card, exp_month: 13 } },
      { ...VIEW, card: { ...VIEW.card, brand: "" } },
      { ...VIEW, card: "visa 4242" },
      { ...VIEW, next_ceiling: { month_usd: 50000 } },
      { ...VIEW, paused: 7 },
      null,
      [],
    ]) {
      expect(autoTopupOf(odd), JSON.stringify(odd)).toBeUndefined();
    }
    // A pause is its reason, bare or under `reason`; one this runtime does not know reads as a failed charge.
    expect(autoTopupOf({ ...VIEW, paused: "card_declined" })?.paused).toBe("card_declined");
    expect(autoTopupOf({ ...VIEW, paused: { reason: "disputed", at: "2026-10-30T10:00:00Z" } })?.paused).toBe("disputed");
    expect(autoTopupOf({ ...VIEW, paused: "bank_on_fire" })?.paused).toBe("charge_failed");
    expect(autoTopupOf({ ...VIEW, charging: "yes" })?.charging).toBe(false);
    // Paused for a payment the cardholder must confirm: its invoice page, over https only.
    const confirm = "https://invoice.stripe.test/i/acct_1/in_1";
    expect(autoTopupOf({ ...VIEW, paused: "authentication_required", confirm_url: confirm })).toMatchObject({ paused: "authentication_required", confirm_url: confirm });
    for (const odd of ["http://invoice.stripe.test/i/1", "javascript:alert(1)", 7, ""]) expect(autoTopupOf({ ...VIEW, paused: "authentication_required", confirm_url: odd })?.confirm_url).toBeNull();
  });

  it("turns Pay as you go on and opens Stripe to save a card only when none is saved", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const first = cloud({ valid: new Set(["a1"]) });
    const on = await accountAutoTopup(store, { enabled: true, month_limit_usd: 10000 }, first.fetchImpl);
    expect(on).toEqual({ auto_topup: expect.objectContaining({ enabled: true, month_limit_usd: 10000, amount_usd: 1000, below_usd: 500, card: null }), url: "https://checkout.stripe.test/c/setup_1" });
    expect(first.calls.map((c) => `${c.method} ${c.path} ${c.auth} ${JSON.stringify(c.body)}`)).toEqual([
      'PUT /api/v1/code/credits/auto Bearer a1 {"enabled":true,"month_limit_usd":10000}',
      "POST /api/v1/code/credits/auto/card Bearer a1 {}",
    ]);
    // A card already saved: no trip to the browser. Off names no limit.
    const saved = cloud({ valid: new Set(["a1"]), card: true });
    expect(await accountAutoTopup(store, { enabled: true, month_limit_usd: 2000 }, saved.fetchImpl)).toEqual({ auto_topup: expect.objectContaining({ enabled: true, month_limit_usd: 2000, card: VIEW.card }) });
    // The person's own amount and threshold go as they set them; off names nothing else.
    expect(await accountAutoTopup(store, { enabled: true, month_limit_usd: 2000, amount_usd: 300, below_usd: 100 }, saved.fetchImpl)).toEqual({
      auto_topup: expect.objectContaining({ month_limit_usd: 2000, amount_usd: 300, below_usd: 100 }),
    });
    expect(await accountAutoTopup(store, { enabled: false, month_limit_usd: undefined, amount_usd: undefined }, first.fetchImpl)).toEqual({ auto_topup: expect.objectContaining({ enabled: false }) });
    expect([...saved.calls, ...first.calls.slice(2)].map((c) => [c.method, c.path, c.body])).toEqual([
      ["PUT", "/api/v1/code/credits/auto", { enabled: true, month_limit_usd: 2000 }],
      ["PUT", "/api/v1/code/credits/auto", { enabled: true, month_limit_usd: 2000, amount_usd: 300, below_usd: 100 }],
      ["PUT", "/api/v1/code/credits/auto", { enabled: false }],
    ]);
    // Change card is the same page on its own.
    expect(await accountAutoTopupCard(store, saved.fetchImpl)).toEqual({ url: "https://checkout.stripe.test/c/setup_1" });
  });

  it("keeps Cloud's words when it refuses a limit, and refuses a card page that is not Stripe's over https", async () => {
    const store = memory({ cloud_url: CLOUD, access_token: "a1" });
    const { fetchImpl, calls } = cloud({ valid: new Set(["a1"]) });
    await expect(accountAutoTopup(store, { enabled: true, month_limit_usd: 50000 }, fetchImpl)).rejects.toMatchObject({
      status: 409,
      code: "cave_code_auto_topup_over_ceiling",
      message: "Your organization can set up to $10,000 a month for now. $50,000 opens after $2,000 paid for 30 days.",
    });
    // Refused: no card page was opened.
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/code/credits/auto"]);
    const odd = cloud({ valid: new Set(["a1"]), cardUrl: "http://checkout.stripe.test/c/setup_1" });
    await expect(accountAutoTopupCard(store, odd.fetchImpl)).rejects.toThrow(/no page to save a card/);
    await expect(accountAutoTopup(store, { enabled: true, month_limit_usd: 100 }, odd.fetchImpl)).rejects.toThrow(/no page to save a card/);
  });

  it("a Cloud that takes the call and never answers holds no account call, refresh or sign-out past the call deadline", async () => {
    // Each deadline a call sets, fired here as its timer would: a half-open socket after a network change answers nothing.
    const deadlines: Array<{ ms: number; controller: AbortController }> = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      const controller = new AbortController();
      deadlines.push({ ms, controller });
      return controller.signal;
    });
    const silent = async <T>(call: (fetchImpl: typeof fetch) => Promise<T>) => {
      const asked: Array<string> = [];
      const fetchImpl = ((input: string, init?: RequestInit) => {
        asked.push(new URL(input).pathname);
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true }));
      }) as typeof fetch;
      let settled: { value: T } | { error: string } | undefined;
      void call(fetchImpl).then(
        (value) => (settled = { value }),
        (error: unknown) => (settled = { error: error instanceof Error ? error.name : String(error) }),
      );
      const set: Array<number> = [];
      for (let round = 0; round < 20 && settled === undefined; round++) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        for (const { ms, controller } of deadlines.splice(0)) {
          set.push(ms);
          controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        }
      }
      return { asked, deadlines: set, settled };
    };
    try {
      // Settings > Plan.
      const plan = memory({ cloud_url: CLOUD, access_token: "a1", refresh_token: "r1" });
      expect(await silent((fetchImpl) => accountSummary(plan, fetchImpl))).toEqual({ asked: ["/api/v1/auth/me"], deadlines: [CALL_TIMEOUT_MS], settled: { error: "TimeoutError" } });

      // The one refresh the proxies, the routing key's timer and every 401 wait on: it gives up, the sign-in is kept, and
      // the next caller refreshes again.
      const soon = `${Buffer.from(JSON.stringify({ exp: 1_000 })).toString("base64url")}.sig`;
      const kept: AccountSession = { cloud_url: CLOUD, access_token: soon, refresh_token: "r1" };
      const proxies = memory(kept);
      for (let i = 0; i < 2; i++) {
        expect(await silent((fetchImpl) => freshSession(proxies, fetchImpl, 1_000_000))).toEqual({ asked: ["/api/v1/auth/refresh"], deadlines: [CALL_TIMEOUT_MS], settled: { value: kept } });
      }
      expect(proxies.current()).toEqual(kept);

      // Sign out: the credits key's revoke, then Cloud's logout, each given up on; the sign-in is forgotten here.
      const signedIn = memory({ cloud_url: CLOUD, access_token: "a1", refresh_token: "r1", credits_key_id: "key-1" });
      expect(await silent((fetchImpl) => accountSignOut(signedIn, fetchImpl))).toEqual({
        asked: ["/api/v1/code/credits/keys/key-1", "/api/v1/auth/logout"],
        deadlines: [CALL_TIMEOUT_MS, CALL_TIMEOUT_MS],
        settled: { value: undefined },
      });
      expect(signedIn.current()).toBeUndefined();
    } finally {
      timeout.mockRestore();
    }
  });
});
