// Plan usage is a percent and a reset, never dollars (docs/ section 9). These read Cloud's answer and the
// answers of a Cloud or a runtime from before it, and keep only the percent.
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  AccountSummary,
  CodeOffer,
  publicCredits,
  publicOffer,
  usageWindows,
  usedPct,
  wholePct,
} from "../src/index.ts";

const $ = (dollars: number) => Math.round(dollars * 1e6);
const PRIVATE =
  /cap_micros|used_micros|spent_micros|minute_micros|included_usd|window_5h_pct|window_week_pct|rate_permille|computer_minute_micros|"rates"|"models"|"basis"/;

describe("a percent of a limit", () => {
  it("rounds down, so 80 is where amber starts and 99.5% still reads 99", () => {
    expect(usedPct(0, $(7))).toBe(0);
    expect(usedPct(1, $(7))).toBe(0);
    expect(usedPct($(5.5999), $(7))).toBe(79);
    expect(usedPct($(5.6), $(7))).toBe(80);
    expect(usedPct($(6.965), $(7))).toBe(99);
    expect(usedPct($(7) - 1, $(7))).toBe(99);
  });

  it("says 100 only once the limit is reached, and never more", () => {
    expect(usedPct($(7), $(7))).toBe(100);
    // Open holds can carry use past the limit.
    expect(usedPct($(9), $(7))).toBe(100);
    // No limit at all reads as full; use below zero as none.
    expect(usedPct(0, 0)).toBe(100);
    expect(usedPct(-5, $(7))).toBe(0);
  });

  it("holds a percent as sent to a whole number from 0 to 100", () => {
    expect([0, 58, 99.5, 100, 140, -3].map(wholePct)).toEqual([0, 58, 99, 100, 100, 0]);
    expect([undefined, null, "58", Number.NaN, Number.POSITIVE_INFINITY].map(wholePct)).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe("a plan's limits from an account answer", () => {
  it("reads Cloud's percent and reset as they are sent", () => {
    expect(
      usageWindows([
        { window: "5h", used_pct: 58, resets_at: "2026-10-16T20:00:00Z" },
        { window: "month", used_pct: 0 },
      ]),
    ).toEqual([
      { window: "5h", used_pct: 58, resets_at: "2026-10-16T20:00:00Z" },
      { window: "month", used_pct: 0 },
    ]);
  });

  it("works the percent out from an older answer's dollars, and passes none of them on", () => {
    const read = usageWindows([
      {
        window: "week",
        cap_micros: $(7),
        used_micros: $(4.1),
        started_at: "2026-10-13T15:00:00Z",
        resets_at: "2026-10-20T15:00:00Z",
      },
      { window: "month", cap_micros: $(20), used_micros: $(20.4) },
    ]);
    expect(read).toEqual([
      { window: "week", used_pct: 58, resets_at: "2026-10-20T15:00:00Z" },
      { window: "month", used_pct: 100 },
    ]);
    expect(JSON.stringify(read)).not.toMatch(PRIVATE);
    // Both sent (a Cloud in its changeover): the percent is Cloud's.
    expect(
      usageWindows([{ window: "week", used_pct: 61, cap_micros: $(7), used_micros: $(4.1) }]),
    ).toEqual([{ window: "week", used_pct: 61 }]);
  });

  it("leaves out a limit that meters nothing or says nothing", () => {
    expect(
      usageWindows([
        { window: "week", cap_micros: 0, used_micros: 0 },
        { window: "month" },
        { used_pct: 5 },
        { window: "", used_pct: 5 },
        null,
        "week",
        7,
      ]),
    ).toEqual([]);
    expect(usageWindows(undefined)).toEqual([]);
    expect(usageWindows({ window: "week", used_pct: 5 })).toEqual([]);
  });
});

describe("an answer read straight from Cloud, or kept by an earlier build", () => {
  const credits = {
    plan: "pro",
    seats: 1,
    windows: [{ window: "week", cap_micros: $(7), used_micros: $(4.1) }],
    models: [
      {
        model: "z-ai/glm-5.3",
        rate_permille: 3000,
        monthly_micros: $(60),
        remaining_micros: $(8.7),
      },
    ],
    basis: "list_price",
    balance_micros: $(12.5),
    grants: [{ kind: "topup", amount_micros: $(25), remaining_micros: $(12.5) }],
    use_balance: true,
    computers: {
      kept: 2,
      kept_limit: 10,
      awake_gib: 32,
      awake_gib_limit: 160,
      max_size: "4x16",
      spent_micros: $(2.9),
      minute_micros: { default: 3333 },
    },
  };
  const offer = {
    catalog_version: 20,
    purchasable: true,
    basis: "list_price",
    plans: [
      {
        plan: "pro",
        label: "Pro",
        usd_month: 20,
        usd_year: 192,
        included_usd: 20,
        per_seat: false,
        window_5h_pct: 35,
        window_week_pct: 35,
        up_to_usd: 60,
        on_sale: true,
        computers: { kept: 10, awake_gib: 160, max_size: "4x16" },
        gifts: 1,
      },
    ],
    rates: [{ model: "z-ai/glm-5.3", rate_permille: 3000 }],
    top_up: { min_usd: 5, max_usd: 500, expires_days: 365 },
    computer_minute_micros: { default: 3333 },
  };

  it("keeps the percent, the price, the headline and the person's own credits, and drops every dollar of what the plan holds", () => {
    const read = publicCredits(credits as unknown as Parameters<typeof publicCredits>[0]);
    expect(read).toEqual({
      plan: "pro",
      seats: 1,
      windows: [{ window: "week", used_pct: 58 }],
      balance_micros: $(12.5),
      grants: [{ kind: "topup", amount_micros: $(25), remaining_micros: $(12.5) }],
      use_balance: true,
      computers: { kept: 2, kept_limit: 10, awake_gib: 32, awake_gib_limit: 160, max_size: "4x16" },
    });
    const plans = publicOffer(offer as unknown as Parameters<typeof publicOffer>[0]);
    expect(plans).toEqual({
      catalog_version: 20,
      purchasable: true,
      plans: [
        {
          plan: "pro",
          label: "Pro",
          usd_month: 20,
          usd_year: 192,
          per_seat: false,
          up_to_usd: 60,
          on_sale: true,
          computers: { kept: 10, awake_gib: 160, max_size: "4x16" },
          gifts: 1,
        },
      ],
      top_up: { min_usd: 5, max_usd: 500, expires_days: 365 },
    });
    expect(JSON.stringify([read, plans])).not.toMatch(PRIVATE);
    // What is left is what the protocol carries.
    expect(Schema.decodeUnknownSync(CodeOffer)(plans)).toEqual(plans);
    expect(
      Schema.decodeUnknownSync(AccountSummary)({ signed_in: true, credits: read, offer: plans }),
    ).toEqual({ signed_in: true, credits: read, offer: plans });
  });

  it("leaves an answer already in the new shape as it is", () => {
    const now = {
      plan: "pro",
      seats: 1,
      windows: [{ window: "week", used_pct: 58, resets_at: "2026-10-20T15:00:00Z" }],
      balance_micros: 0,
      grants: [],
      use_balance: true,
      computers: {
        kept: 2,
        kept_limit: 10,
        awake_gib: 32,
        awake_gib_limit: 160,
        max_size: "4x16",
        used_pct: 12,
      },
    };
    expect(publicCredits(now)).toEqual(now);
    const plans = {
      catalog_version: 20,
      purchasable: true,
      usage_base: "pro",
      plans: [
        {
          plan: "max",
          label: "Max $100",
          usd_month: 100,
          usd_year: 960,
          per_seat: false,
          up_to_usd: 315,
          on_sale: true,
          usage_times: 5,
          windows: ["5h", "week", "month"],
        },
      ],
      top_up: { min_usd: 5, max_usd: 500, expires_days: 365 },
    };
    expect(publicOffer(plans)).toEqual(plans);
  });
});

describe("the protocol", () => {
  it("has no field for what a plan holds in dollars: an answer that carries one is not the protocol's", () => {
    const fields = (schema: { readonly ast: unknown }) => JSON.stringify(schema.ast);
    expect(fields(CodeOffer)).not.toMatch(PRIVATE);
    expect(fields(AccountSummary)).not.toMatch(PRIVATE);
    // The offer says a plan's price and its headline, and compares plans in whole times.
    for (const field of ["usd_month", "usd_year", "up_to_usd", "usage_times", "usage_base"])
      expect(fields(CodeOffer)).toContain(field);
    for (const field of ["used_pct", "resets_at", "balance_micros"])
      expect(fields(AccountSummary)).toContain(field);
  });
});
