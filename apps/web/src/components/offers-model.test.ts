import type { AccountSummary, CodeOffer, EngineDescriptor } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import offer from "../routes/settings/code-plans-offer.fixture.json";
import { fullWindow, pickOffer } from "./offers-model.ts";

const free = { signed_in: true, role: "owner", offer, credits: {} } as unknown as AccountSummary;
const pro = (gifts: number) =>
  ({ signed_in: true, role: "owner", offer, credits: { subscription: { plan: "pro", seats: 1, status: "active", cancel_at_period_end: false, pending_update: false }, gifts: { open: gifts, total: 1 } } }) as unknown as AccountSummary;
const claude = (used: number, resets_at?: string) =>
  ({ id: "claude-agent", label: "Claude Agent", auth: { state: "signed_in", accounts: [] }, usage_limits: [{ id: "5h", label: "5 hours", kind: "session", used_percent: used, ...(resets_at ? { resets_at } : {}) }] }) as unknown as EngineDescriptor;
const loud = () => false;

describe("the later offers", () => {
  test("a used-up Claude or ChatGPT window, never one with room left, past its reset, or on credits", () => {
    const now = new Date("2026-10-26T12:00:00Z");
    expect(fullWindow([claude(100, "2026-10-26T15:40:00Z")], now)).toEqual({ who: "Claude", resetsAt: "2026-10-26T15:40:00Z" });
    expect(fullWindow([claude(99)], now)).toBeNull();
    expect(fullWindow([claude(100, "2026-10-26T11:00:00Z")], now)).toBeNull();
    expect(fullWindow([{ ...claude(100), usage_on_credits: true } as EngineDescriptor], now)).toBeNull();
  });

  test("the window offer names the plan's price and usage from the offer", () => {
    const o = pickOffer({ account: free, engines: [claude(100)], lidPaused: 0, merged: false, giftsToGive: 0, quiet: loud });
    expect(o).toMatchObject({ id: "window", title: "Your Claude limit is used up", action: "unlock" });
    expect(o?.body).toContain("$20 a month comes with up to $60 of usage");
  });

  test("the lid comes first, and Not now quiets only the offer it was said to", () => {
    expect(pickOffer({ account: free, engines: [claude(100)], lidPaused: 2, merged: false, giftsToGive: 0, quiet: loud })?.title).toBe("2 chats paused while your Mac slept");
    expect(pickOffer({ account: free, engines: [claude(100)], lidPaused: 2, merged: false, giftsToGive: 0, quiet: (id) => id === "lid" })?.id).toBe("window");
  });

  test("someone who holds a plan is never sold one, but a merged pull request offers a gift to give", () => {
    expect(pickOffer({ account: pro(1), engines: [claude(100)], lidPaused: 3, merged: false, giftsToGive: 1, quiet: loud })).toBeNull();
    expect(pickOffer({ account: pro(1), engines: [], lidPaused: 0, merged: true, giftsToGive: 1, quiet: loud })).toMatchObject({ id: "gift", action: "gift" });
    expect(pickOffer({ account: pro(1), engines: [], lidPaused: 0, merged: true, giftsToGive: 0, quiet: loud })).toBeNull();
  });

  test("nothing without an account that may buy (a member, a Cloud that takes no payments)", () => {
    const member = { ...free, role: "member" } as AccountSummary;
    const unpaid = { ...free, offer: { ...(offer as unknown as CodeOffer), purchasable: false } } as AccountSummary;
    expect(pickOffer({ account: member, engines: [claude(100)], lidPaused: 1, merged: false, giftsToGive: 0, quiet: loud })).toBeNull();
    expect(pickOffer({ account: unpaid, engines: [claude(100)], lidPaused: 1, merged: false, giftsToGive: 0, quiet: loud })).toBeNull();
    expect(pickOffer({ account: null, engines: [claude(100)], lidPaused: 1, merged: false, giftsToGive: 0, quiet: loud })).toBeNull();
  });
});
