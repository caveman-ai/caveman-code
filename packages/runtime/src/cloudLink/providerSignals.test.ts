// What a provider's own answer says of the plan a request went out on, read as Cloud's data plane reads it
// (providerSignals.ts): a Mac that attaches a connection's credential itself must say "used up" and "connect it again"
// for exactly the answers a Cloud computer does.
import { expect, test } from "vitest";

import { credentialRefused, planUsedUp } from "./providerSignals.ts";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const epoch = (iso: string) => String(Date.parse(iso) / 1000);

test("a Claude plan is used up on Anthropic's rejected unified limit, until the reset it names", () => {
  const rejected = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": epoch("2026-11-09T17:00:00Z"),
  };
  expect(planUsedUp("claude_plan", 429, rejected, "", NOW)).toEqual({
    until: Date.parse("2026-11-09T17:00:00Z"),
  });
  // No reset named: retry-after, else no time at all.
  expect(
    planUsedUp(
      "claude_plan",
      429,
      { "anthropic-ratelimit-unified-status": "rejected", "retry-after": "90" },
      "",
      NOW,
    ),
  ).toEqual({ until: NOW + 90_000 });
  expect(
    planUsedUp("claude_plan", 429, { "anthropic-ratelimit-unified-status": "rejected" }, "", NOW),
  ).toEqual({ until: undefined });
  // A reset in the past, or further off than any plan's window, is not believed.
  expect(
    planUsedUp(
      "claude_plan",
      429,
      { ...rejected, "anthropic-ratelimit-unified-reset": epoch("2026-11-09T11:00:00Z") },
      "",
      NOW,
    ),
  ).toEqual({ until: undefined });
  expect(
    planUsedUp(
      "claude_plan",
      429,
      { ...rejected, "anthropic-ratelimit-unified-reset": epoch("2027-03-01T00:00:00Z") },
      "",
      NOW,
    ),
  ).toEqual({ until: undefined });
});

test("a Claude plan with extra usage to fall back on, a plain rate limit and any other status are not used up", () => {
  const rejected = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": epoch("2026-11-09T17:00:00Z"),
  };
  expect(
    planUsedUp(
      "claude_plan",
      429,
      { ...rejected, "anthropic-ratelimit-unified-overage-status": "allowed" },
      "",
      NOW,
    ),
  ).toBeUndefined();
  expect(
    planUsedUp(
      "claude_plan",
      429,
      { ...rejected, "anthropic-ratelimit-unified-overage-status": "allowed_warning" },
      "",
      NOW,
    ),
  ).toBeUndefined();
  expect(
    planUsedUp(
      "claude_plan",
      429,
      { "anthropic-ratelimit-unified-status": "allowed", "retry-after": "5" },
      "",
      NOW,
    ),
  ).toBeUndefined();
  expect(planUsedUp("claude_plan", 529, rejected, "", NOW)).toBeUndefined();
  expect(planUsedUp("claude_plan", 200, rejected, "", NOW)).toBeUndefined();
});

test("a ChatGPT plan is used up on usage_limit_reached, until resets_at or resets_in_seconds", () => {
  const body = (error: object) => JSON.stringify({ error });
  expect(
    planUsedUp(
      "chatgpt_plan",
      429,
      {},
      body({ type: "usage_limit_reached", resets_at: Date.parse("2026-11-10T09:00:00Z") / 1000 }),
      NOW,
    ),
  ).toEqual({ until: Date.parse("2026-11-10T09:00:00Z") });
  expect(
    planUsedUp(
      "chatgpt_plan",
      429,
      {},
      body({ type: "usage_limit_reached", resets_in_seconds: 600 }),
      NOW,
    ),
  ).toEqual({ until: NOW + 600_000 });
  expect(planUsedUp("chatgpt_plan", 429, {}, body({ type: "usage_limit_reached" }), NOW)).toEqual({
    until: undefined,
  });
  expect(
    planUsedUp("chatgpt_plan", 429, {}, body({ type: "rate_limit_exceeded" }), NOW),
  ).toBeUndefined();
  expect(planUsedUp("chatgpt_plan", 429, {}, "not json", NOW)).toBeUndefined();
});

test("a key's or a gateway's 429 is a rate limit, never a plan", () => {
  const rejected = { "anthropic-ratelimit-unified-status": "rejected" };
  expect(
    planUsedUp(
      "api_key",
      429,
      rejected,
      JSON.stringify({ error: { type: "usage_limit_reached" } }),
      NOW,
    ),
  ).toBeUndefined();
  expect(planUsedUp("gateway", 429, rejected, "", NOW)).toBeUndefined();
});

test("a Claude plan's token is refused only in Anthropic's own words, on a 401 or a 403", () => {
  const says = (message: string) =>
    JSON.stringify({ type: "error", error: { type: "authentication_error", message } });
  expect(
    credentialRefused(
      "claude_plan",
      401,
      says(
        "OAuth token has been revoked. Please obtain a new token or refresh your existing token.",
      ),
    ),
  ).toBe(true);
  expect(credentialRefused("claude_plan", 403, says("OAuth token has been revoked."))).toBe(true);
  expect(credentialRefused("claude_plan", 401, says("OAuth access token has expired."))).toBe(true);
  expect(credentialRefused("claude_plan", 401, says("OAuth token has expired"))).toBe(true);
  // Anything else on a 401 or 403 is not the token's fault: a header an agent chose, a model it may not use.
  expect(credentialRefused("claude_plan", 401, says("invalid x-api-key"))).toBe(false);
  expect(
    credentialRefused(
      "claude_plan",
      403,
      says("This credential is only authorized for use with Claude Code."),
    ),
  ).toBe(false);
  expect(
    credentialRefused("claude_plan", 401, says("An OAuth token has been revoked somewhere")),
  ).toBe(false);
  expect(credentialRefused("claude_plan", 500, says("OAuth token has been revoked."))).toBe(false);
});

test("a ChatGPT sign-in is refused on any 401; a key or a gateway never", () => {
  expect(credentialRefused("chatgpt_plan", 401, "")).toBe(true);
  expect(credentialRefused("chatgpt_plan", 403, "")).toBe(false);
  expect(
    credentialRefused(
      "api_key",
      401,
      JSON.stringify({ error: { message: "OAuth token has been revoked." } }),
    ),
  ).toBe(false);
  expect(credentialRefused("gateway", 401, "")).toBe(false);
});
