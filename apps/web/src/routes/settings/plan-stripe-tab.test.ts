// Settings > Plan in a browser: Stripe's page opens in a tab the click itself opened, since the answer that names the
// page comes after the click (over the relay on the hosted client), when a browser blocks a new tab.
import { button, click, deferred, mount, popups, settle } from "./browser.fixture.ts";

import { readFileSync } from "node:fs";

import type { AccountSummary, CodeOffer } from "@caveman-app/session-protocol";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, expect, test, vi } from "vitest";

import { RuntimeContext } from "../../state/runtime.tsx";
import { PlanSettings } from "./Plan.tsx";

// The real useRemoteControl subscribes to cloud.* on the runtime; the page only reads its status.
vi.mock("../../components/RemoteControl.tsx", () => ({
  useRemoteControl: () => ({ status: null }),
}));

const offer = JSON.parse(
  readFileSync(new URL("./code-plans-offer.fixture.json", import.meta.url), "utf8"),
) as CodeOffer;
type Credits = NonNullable<AccountSummary["credits"]>;
const free: Credits = {
  plan: "free",
  seats: 1,
  windows: [],
  balance_micros: 0,
  grants: [],
  use_balance: true,
  customer_linked: true,
};
const pro: Credits = {
  ...free,
  plan: "pro",
  subscription: {
    plan: "pro",
    seats: 1,
    status: "active",
    interval: "month",
    current_period_end: "2026-12-01T09:00:00Z",
    cancel_at_period_end: false,
    pending_update: false,
  },
};
const accountOn = (credits: Credits) =>
  ({
    signed_in: true,
    role: "owner",
    organization_name: "Analytical Engines",
    credits,
    offer,
    credits_on: false,
    cloud_url: "https://app.caveman.so",
  }) as unknown as AccountSummary;

let page: Awaited<ReturnType<typeof mount>> | undefined;
afterEach(async () => {
  await page?.unmount();
  page = undefined;
});

/** The page on a runtime whose account.checkout and account.billing answer when the test says. */
async function plan(credits: Credits) {
  const answer = deferred<{ url?: string; effective?: string }>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    on: () => () => undefined,
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "account.get") return Promise.resolve(accountOn(credits));
      if (method === "account.checkout" || method === "account.billing") return answer.promise;
      return new Promise(() => undefined);
    },
  };
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client, connection: "open" } as never },
        createElement(PlanSettings),
      ),
    ),
  );
  return { container: page.container, answer, calls };
}

const open = () => popups.tabs.filter((t) => !t.closed).map((t) => t.url);
/** The Plans section of the page: the cards and what is said under them. */
const plans = (container: Element) =>
  [...container.querySelectorAll("section")].find(
    (s) => s.querySelector("h2, h3")?.textContent === "Plans",
  )!;

test("a top-up's Stripe Checkout opens in the tab its click opened, though the answer comes after the click", async () => {
  const p = await plan(free);
  await click(button(p.container, "$25"));
  expect(p.calls.filter((c) => c.method === "account.checkout")).toHaveLength(1);
  p.answer.resolve({ url: "https://checkout.stripe.com/c/pay/cs_test_a1" });
  await settle();
  expect({ open: open(), refused: popups.refused }).toEqual({
    open: ["https://checkout.stripe.com/c/pay/cs_test_a1"],
    refused: [],
  });
  expect(popups.tabs[0]?.opener).toBeNull();
});

test("choosing a first plan opens its Stripe Checkout in the tab its click opened", async () => {
  const p = await plan(free);
  await click(button(p.container, "Choose Pro"));
  p.answer.resolve({ url: "https://checkout.stripe.com/c/pay/cs_test_pro" });
  await settle();
  expect({ open: open(), refused: popups.refused }).toEqual({
    open: ["https://checkout.stripe.com/c/pay/cs_test_pro"],
    refused: [],
  });
});

test("Manage billing opens Stripe's portal in the tab its click opened", async () => {
  const p = await plan(pro);
  await click(button(p.container, "Manage billing"));
  p.answer.resolve({ url: "https://billing.stripe.com/p/session/test_b2" });
  await settle();
  expect({ open: open(), refused: popups.refused }).toEqual({
    open: ["https://billing.stripe.com/p/session/test_b2"],
    refused: [],
  });
});

test("moving a held plan, which Cloud does in place, opens no tab at all", async () => {
  const p = await plan(pro);
  await click(button(p.container, "Move to Max $100"));
  p.answer.resolve({ effective: "now" });
  await settle();
  expect(popups.tabs).toEqual([]);
  // The answer shows under the plan cards, where the click was, and once.
  expect(plans(p.container).querySelector('[role="status"]')?.textContent).toBe(
    "Your plan changed.",
  );
  expect(p.container.textContent!.match(/Your plan changed\./g)).toHaveLength(1);
});

test("a refused plan change says why under the plan cards, where the click was", async () => {
  const p = await plan(pro);
  await click(button(p.container, "Move to Max $100"));
  p.answer.reject(new Error("This card was declined"));
  await settle();
  expect(plans(p.container).querySelector('[role="alert"]')?.textContent).toBe(
    "This card was declined",
  );
  expect(p.container.querySelectorAll('[role="alert"]')).toHaveLength(1);
});

test("a refused checkout closes the tab its click opened and says why", async () => {
  const p = await plan(free);
  await click(button(p.container, "$25"));
  p.answer.reject(new Error("Stripe is not answering"));
  await settle();
  expect(open()).toEqual([]);
  expect(p.container.querySelector('[role="alert"]')?.textContent).toBe("Stripe is not answering");
  // A top-up is not a plan card's button: its answer shows in the plan held.
  expect(plans(p.container).querySelector('[role="alert"]')).toBeNull();
});

test("a first plan bought here turns Caveman credits on once it lands, as the Unlock sheet does", async () => {
  let credits = free;
  const answer = deferred<{ url?: string }>();
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    on: () => () => undefined,
    call: (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "account.get") return Promise.resolve(accountOn(credits));
      if (method === "account.checkout") return answer.promise;
      if (method === "account.credits") return Promise.resolve({ enabled: true });
      return new Promise(() => undefined);
    },
  };
  page = await mount(
    createElement(
      MemoryRouter,
      null,
      createElement(
        RuntimeContext.Provider,
        { value: { client, connection: "open" } as never },
        createElement(PlanSettings),
      ),
    ),
  );
  await click(button(page.container, "Choose Pro"));
  answer.resolve({ url: "https://checkout.stripe.com/c/pay/cs_test_pro" });
  await settle();
  expect(calls.filter((c) => c.method === "account.credits")).toEqual([]);
  // Back from Stripe: Cloud holds the plan now.
  credits = pro;
  window.dispatchEvent(new Event("focus"));
  await settle();
  await settle();
  expect(
    calls
      .filter((c) => c.method === "account.credits")
      .map((c) => (c.params as { enabled: boolean }).enabled),
  ).toEqual([true]);
});
