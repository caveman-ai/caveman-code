// Search on Caveman credits: Cloud's gateway route, asked with the credits key and the client header, answered in
// the providers' own shape; a refused key, spent credits and an outage each say so.
import { describe, expect, it } from "vitest";

import { CREDITS_SEARCH_PATH, CREDITS_TIMEOUT_MS, runCreditsSearch } from "./credits.ts";
import { WebProviderError } from "./providers.ts";

const gatewayUrl = "https://gateway.test/";

describe("runCreditsSearch", () => {
  it("asks the gateway with the credits key and client header, and reads results, provider and cost", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({
        results: [{ url: "https://nodejs.org/api/fs.html", title: "fs", date: "2026-09-08T00:00:00Z", excerpts: ["readFile reads a file."] }, { url: "", title: "dropped", excerpts: [] }],
        provider: "brave",
        cost_usd: 0.005,
      });
    }) as unknown as typeof fetch;
    const out = await runCreditsSearch("cave_live_credits_0123456789", { query: "node read file", count: 3, freshness: "month", domains: ["https://nodejs.org/api"] }, { gatewayUrl, session: "thread-1", fetchImpl });
    expect(calls[0]!.url).toBe(`https://gateway.test${CREDITS_SEARCH_PATH}`);
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("authorization")).toBe("Bearer cave_live_credits_0123456789");
    expect(headers.get("x-caveman-client")).toMatch(/^caveman-code\//);
    expect(headers.get("x-caveman-session")).toBe("thread-1");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ query: "node read file", count: 3, freshness: "month", domains: ["nodejs.org"] });
    expect(out).toEqual({
      results: [{ url: "https://nodejs.org/api/fs.html", title: "fs", date: "2026-09-08", excerpts: ["readFile reads a file."] }],
      tokensApprox: expect.any(Number),
      provider: "brave",
      costUsd: 0.005,
    });
  });

  it.each([
    [401, "auth"],
    [402, "limit"],
    [429, "limit"],
    [502, "unavailable"],
  ] as const)("names a %i as %s, in the gateway's words", async (status, kind) => {
    const fetchImpl = (async () => Response.json({ error: { code: "cave_credits_exhausted", message: "Not enough credits" } }, { status })) as unknown as typeof fetch;
    const error = (await runCreditsSearch("k", { query: "q" }, { gatewayUrl, fetchImpl }).catch((e: unknown) => e)) as WebProviderError;
    expect(error).toBeInstanceOf(WebProviderError);
    expect([error.provider, error.kind, error.message]).toEqual(["credits", kind, `${status}: Not enough credits`]);
  });

  it.each([
    [402, { code: "cave_code_credits_exhausted", message: "Credits exhausted", details: { resets_at: "2026-11-01T00:00:00Z" } }, "limit", "they come back on 1 November"],
    [402, { code: "cave_code_credits_exhausted", message: "Credits exhausted" }, "limit", "none left"],
    [503, { code: "cave_code_search_unavailable", message: "No provider answered" }, "unavailable", "search on credits is down for now; nothing was charged"],
  ] as const)("says Cloud's %i %o in plain words", async (status, error, kind, message) => {
    const fetchImpl = (async () => Response.json({ error }, { status })) as unknown as typeof fetch;
    const out = (await runCreditsSearch("k", { query: "q" }, { gatewayUrl, fetchImpl }).catch((e: unknown) => e)) as WebProviderError;
    expect([out.kind, out.message, out.status]).toEqual([kind, message, status]);
  });

  it("waits at least 40 s: Cloud tries its providers in turn before it answers", () => {
    expect(CREDITS_TIMEOUT_MS).toBeGreaterThanOrEqual(40_000);
  });
});
