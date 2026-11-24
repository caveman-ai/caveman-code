// Pay as you go as Cloud serves it, for the tests of Settings > Plan and the sidebar meter.
import type { AutoTopup, AutoTopupCatalog } from "./account-model.ts";

import offer from "./code-plans-offer.fixture.json";

/**
 * Pay as you go in Cloud's catalog, from the copy of Cloud's golden for GET /code/plans, and an organization's view as
 * docs/ sets it.
 */
export const CATALOG: AutoTopupCatalog = offer.auto_topup;
export const ON: AutoTopup = {
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
