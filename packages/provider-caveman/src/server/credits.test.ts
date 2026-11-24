import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cavemanModels } from "./credentials.ts";
import {
  CREDITS_GATEWAY_OVERRIDE,
  creditsModels,
  creditsRefusal,
  creditsSlug,
  gatewayOf,
  HOSTED_GATEWAY_URL,
  parseCreditsModels,
  setCreditsModels,
  withCredits,
} from "./credits.ts";

const KEY = "cave_live_credits_test_key";
const closers: Array<() => Promise<void>> = [];
const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "credits-models-"));
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await setCreditsModels(stateDir, undefined);
});

/** A stand-in Cloud gateway: records each request and answers one streamed chat completion. */
async function gateway() {
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    seen.push({ path: request.url ?? "", headers: request.headers, body: JSON.parse(raw || "{}") });
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.write(chunk({ role: "assistant", content: "few word" }));
    response.write(chunk({}, "stop"));
    response.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [], usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("Caveman credits", () => {
  it("lists the plan's models under caveman/<provider>/<id>, each at its gateway route", () => {
    const models = withCredits(builtinModels({}), KEY, "caveman-code/1.0.0", "https://gateway.caveman.test");
    const slugs = models.getModels("caveman").map(creditsSlug);
    expect(slugs).toEqual(expect.arrayContaining(["caveman/anthropic/claude-opus-5-5", "caveman/openai/gpt-6.1-sol", "caveman/deepseek/deepseek-flash", "caveman/zai/glm-5.3"]));
    const opus = models.getModel("caveman", "anthropic/claude-opus-5-5")!;
    expect({ provider: opus.provider, baseUrl: opus.baseUrl, client: opus.headers?.["x-caveman-client"] }).toEqual({ provider: "caveman-anthropic", baseUrl: "https://gateway.caveman.test", client: "caveman-code/1.0.0" });
    expect(models.getModel("caveman", "openai/gpt-6.1-sol")!.baseUrl).toBe("https://gateway.caveman.test/v1");
    // A person's own provider models are untouched.
    expect(models.getModel("anthropic", "claude-opus-5-5")!.baseUrl).toBe("https://api.anthropic.com");
  });

  it("sells exactly catalog v14's nine credits models, and nothing it stopped selling", () => {
    const models = withCredits(builtinModels({}), KEY, "caveman-code/1.0.0", "https://gateway.caveman.test");
    const slugs = models.getModels("caveman").map(creditsSlug).sort();
    expect(slugs).toEqual(
      [
        "caveman/anthropic/claude-haiku-5-5",
        "caveman/anthropic/claude-opus-5-5",
        "caveman/anthropic/claude-sonnet-5-5",
        "caveman/deepseek/deepseek-flash",
        "caveman/moonshotai/kimi-k3",
        "caveman/openai/gpt-6-luna",
        "caveman/openai/gpt-6.1-sol",
        "caveman/zai/glm-5.3",
        "caveman/zai/glm-5.3-flash",
      ].sort(),
    );
    expect(slugs).toHaveLength(9);
    // Kimi K3 runs on the gateway's Moonshot route, GLM 5.3 Flash on its Z.ai route.
    expect(models.getModel("caveman", "moonshotai/kimi-k3")!.baseUrl).toBe("https://gateway.caveman.test/moonshot/v1");
    expect(models.getModel("caveman", "zai/glm-5.3-flash")!.baseUrl).toBe("https://gateway.caveman.test/z-ai/v1");
    for (const gone of ["deepseek/deepseek-v4-pro", "minimax/MiniMax-M3"]) {
      expect(models.getModel("caveman", gone), gone).toBeUndefined();
    }
  });

  it("sells what Cloud says it sells, with no app release", async () => {
    // GET /api/v1/code/credits/models as Cloud answers it, trimmed: a model the bundled list lacks, one from a provider
    // this build has no route for, and junk.
    const answer = {
      basis: "list_price",
      models: [
        { model: "anthropic/claude-opus-5-5", provider: "anthropic", wire: "anthropic", rate_permille: 1000 },
        { model: "anthropic/claude-opus-6", provider: "anthropic", wire: "anthropic", rate_permille: 1000 },
        { model: "z-ai/glm-5.3", provider: "z-ai", wire: "openai", rate_permille: 3000 },
        { model: "mistral/devstral-3", provider: "mistral", wire: "openai", rate_permille: 1000 },
        { model: "anthropic/../../etc", provider: "anthropic" },
        { provider: "openai" },
      ],
    };
    const sold = parseCreditsModels(answer)!;
    expect(sold).toEqual(["anthropic/claude-opus-5-5", "anthropic/claude-opus-6", "z-ai/glm-5.3", "mistral/devstral-3"]);
    expect(parseCreditsModels({ error: "nope" })).toBeUndefined();

    await setCreditsModels(stateDir, sold);
    const models = withCredits(builtinModels({}), KEY, "caveman-code/1.0.0", "https://gateway.caveman.test");
    expect(models.getModels("caveman").map(creditsSlug).sort()).toEqual(
      ["caveman/anthropic/claude-opus-5-5", "caveman/anthropic/claude-opus-6", "caveman/zai/glm-5.3"].sort(),
    );
    // A version newer than this build's catalog runs on its family's wire, with no price guessed.
    const opus6 = models.getModel("caveman", "anthropic/claude-opus-6")!;
    const opus55 = models.getModel("caveman", "anthropic/claude-opus-5-5")!;
    expect({ api: opus6.api, baseUrl: opus6.baseUrl, cost: opus6.cost }).toEqual({
      api: opus55.api,
      baseUrl: "https://gateway.caveman.test",
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
    expect(models.getModel("caveman", "openai/gpt-6.1-sol")).toBeUndefined();
  });

  it("keeps Cloud's list across restarts, and falls back to the bundled one when it is forgotten", async () => {
    await setCreditsModels(stateDir, ["openai/gpt-6.1-sol"]);
    vi.resetModules();
    const restarted = await import("./credits.ts");
    expect(restarted.creditsModels()).toHaveLength(9);
    await restarted.loadCreditsModels(stateDir);
    expect(restarted.creditsModels()).toEqual(["openai/gpt-6.1-sol"]);

    await setCreditsModels(stateDir, undefined);
    expect(creditsModels()).toHaveLength(9);
    expect(NodeFS.existsSync(NodePath.join(stateDir, "caveman-credits-models.json"))).toBe(false);
  });

  it("sends a turn to the gateway with the credits key and the Caveman Code client header", async () => {
    const gw = await gateway();
    // The person's own DeepSeek slot holds nothing; the credits provider has its own.
    const models = withCredits(builtinModels({}), KEY, "caveman-code/1.0.0", gw.url);
    const model = models.getModel("caveman", "deepseek/deepseek-flash")!;
    const answer = await models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
    expect(answer.stopReason).toBe("stop");
    expect(answer.content).toEqual([expect.objectContaining({ type: "text", text: "few word" })]);
    expect(gw.seen).toHaveLength(1);
    expect(gw.seen[0]!.path).toBe("/deepseek/v1/chat/completions");
    expect(gw.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(gw.seen[0]!.headers["x-caveman-client"]).toBe("caveman-code/1.0.0");
    expect(gw.seen[0]!.body.model).toBe("deepseek-flash");
  });

  it("sends each request with the credits key held now, on its gateway: a Cloud computer's renewed key reaches a turn already running", async () => {
    const gw = await gateway();
    let current: { key: string; gateway?: string } | undefined = { key: "cave_live_computer_key_1", gateway: gw.url };
    // Built before any key is held (a model list asks for none): the slot's key is empty and its gateway unknown.
    const models = await Effect.runPromise(cavemanModels({ caveman: { key: "", live: async () => current } }));
    const model = models.getModel("caveman", "deepseek/deepseek-flash")!;
    const ask = () => models.complete(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });
    await ask();
    current = { key: "cave_live_computer_key_2", gateway: gw.url };
    await ask();
    expect(gw.seen.map((s) => s.headers.authorization)).toEqual(["Bearer cave_live_computer_key_1", "Bearer cave_live_computer_key_2"]);
    // Cloud gave none meanwhile: the request fails here, never sent with a key it no longer holds.
    current = undefined;
    const failed = await ask();
    expect(failed.stopReason).toBe("error");
    expect(failed.errorMessage).toMatch(/credits/i);
    expect(gw.seen).toHaveLength(2);
  });

  it("runs a key on the gateway of the Cloud that minted it, and a key kept without one on the hosted gateway", async () => {
    // The suite runs without CAVEMAN_CREDITS_GATEWAY_URL: that override would win over both.
    expect(CREDITS_GATEWAY_OVERRIDE).toBeUndefined();
    expect([gatewayOf(undefined), gatewayOf({}), gatewayOf({ gateway: "https://gateway.customer.example" })]).toEqual([
      HOSTED_GATEWAY_URL,
      HOSTED_GATEWAY_URL,
      "https://gateway.customer.example",
    ]);
    const own = await Effect.runPromise(cavemanModels({ caveman: { key: KEY, gateway: "https://gateway.customer.example" } }));
    expect(own.getModel("caveman", "anthropic/claude-opus-5-5")!.baseUrl).toBe("https://gateway.customer.example");
    expect(own.getModel("caveman", "openai/gpt-6.1-sol")!.baseUrl).toBe("https://gateway.customer.example/v1");
    expect(own.getModels("caveman").every((m) => !m.baseUrl.includes("caveman.so"))).toBe(true);
    // The hosted Cloud's key, as every build stored it: unchanged.
    const hosted = await Effect.runPromise(cavemanModels({ caveman: { key: KEY } }));
    expect(hosted.getModel("caveman", "anthropic/claude-opus-5-5")!.baseUrl).toBe("https://gateway.caveman.so");
  });
});

describe("a Caveman credits refusal from Cloud's gateway", () => {
  const NOW = Date.parse("2026-10-23T12:00:00Z");
  /** The gateway's 402 body (httpx.ErrorWithDetails around a broker.Refusal). */
  const envelope = (reason: unknown, resetsAt: unknown = null, extra: object = {}) => ({
    error: { type: "cave_gateway_error", code: "cave_code_credits_exhausted", message: "Gateway words.", details: { reason, resets_at: resetsAt }, request_id: "0199", ...extra },
  });
  /** As Anthropic's SDK words it (the whole body), and as pi-ai words OpenAI's (the error object, after the status). */
  const anthropic = (body: object) => `402 ${JSON.stringify(body)}`;
  const openai = (body: { error: object }) => `caveman-openai API error (402): ${JSON.stringify(body.error)}`;

  it("says which plan limit binds and when it lifts, for the windows, the month and the platform ceiling", () => {
    for (const [reason, resets] of [
      ["window_5h", "2026-10-23T16:00:00Z"],
      ["window_week", "2026-10-27T00:00:00Z"],
      ["month", "2026-11-01T00:00:00Z"],
      ["platform", "2026-11-01T00:00:00Z"],
    ] as const) {
      for (const text of [anthropic(envelope(reason, resets)), openai(envelope(reason, resets))]) {
        const refusal = creditsRefusal(text, NOW);
        expect(refusal, text).toMatchObject({ reason, resetAt: new Date(resets).toISOString() });
        expect(refusal!.message).not.toContain("Gateway words");
      }
    }
    expect(creditsRefusal(anthropic(envelope("window_week", "2026-10-27T00:00:00Z")), NOW)!.message).toBe("Your Caveman plan's weekly usage window is used up.");
  });

  it("gives no reset when only credits or another plan help", () => {
    expect(creditsRefusal(anthropic(envelope("no_credits")), NOW)).toEqual({
      reason: "no_credits",
      message: "No Caveman plan usage or credits are left for this model. Top up or change plan to continue.",
      resetAt: null,
      retryable: false,
    });
    // The free lane names the next UTC midnight, and lifts then.
    expect(creditsRefusal(openai(envelope("free_daily_limit", "2026-10-24T00:00:00Z")), NOW)).toMatchObject({ reason: "free_daily_limit", resetAt: "2026-10-24T00:00:00.000Z", retryable: true });
  });

  it("says why Pay as you go did not add credits: a charge landing retries, a pause leads to the plan, the limit lifts on the 1st", () => {
    /** The 429 a charge in flight answers (Retry-After: 5), with the code the gateway gives it (gateway-managed broker.go), as each SDK words it. */
    const pending = envelope("auto_topup_pending", null, { code: "cave_code_rate_limited" });
    for (const text of [`429 ${JSON.stringify(pending)}`, `caveman-openai API error (429): ${JSON.stringify(pending.error)}`]) {
      expect(creditsRefusal(text, NOW), text).toEqual({
        reason: "auto_topup_pending",
        message: "Pay as you go is adding credits from your card. Try again in a few seconds.",
        resetAt: null,
        retryable: true,
      });
    }
    // A reset time on a charge in flight is not a reset: it lifts when the charge lands, not at a time.
    expect(creditsRefusal(anthropic(envelope("auto_topup_pending", "2026-10-23T12:00:05Z")), NOW)).toMatchObject({ resetAt: null, retryable: true });
    // Paused (declined, needs authentication, expired, disputed) or no card yet: only a fix in Settings > Plan helps.
    expect(creditsRefusal(anthropic(envelope("auto_topup_paused", "2026-11-01T00:00:00Z")), NOW)).toEqual({
      reason: "auto_topup_paused",
      message: "Credits ran out, and Pay as you go is paused or has no card. Fix it in Settings > Plan to continue.",
      resetAt: null,
      retryable: false,
    });
    // This month's limit (or the ceiling) has no room for another charge: it starts again on the 1st, or a higher limit now.
    const limit = creditsRefusal(openai(envelope("auto_topup_limit", "2026-11-01T00:00:00Z")), NOW);
    expect(limit).toEqual({
      reason: "auto_topup_limit",
      message: "Credits ran out, and Pay as you go reached this month's limit. Raise it in Settings > Plan to continue now.",
      resetAt: "2026-11-01T00:00:00.000Z",
      retryable: true,
    });
    expect(creditsRefusal(anthropic(envelope("auto_topup_limit", "next month")), NOW)).toMatchObject({ reason: "auto_topup_limit", resetAt: null, retryable: false });
    for (const reason of ["auto_topup_pending", "auto_topup_paused", "auto_topup_limit"]) {
      expect(creditsRefusal(anthropic(envelope(reason)), NOW)!.message, reason).not.toContain("Gateway words");
    }
    // Under the rate-limit code only a charge in flight is a credits refusal: an ordinary rate limit stays the SDK's.
    expect(creditsRefusal(`429 ${JSON.stringify(envelope("rate_limited", null, { code: "cave_code_rate_limited" }))}`, NOW)).toBeUndefined();
    expect(creditsRefusal(`429 ${JSON.stringify(envelope("auto_topup_paused", null, { code: "cave_code_rate_limited" }))}`, NOW)).toBeUndefined();
  });

  it("drops a reset time that does not parse, is past or is too far out, and keeps the limit", () => {
    for (const resets of ["soon", "2026-13-45T99:00:00Z", "1729512000", 1729512000, { at: 1 }, "2026-10-23T11:00:00Z", "2027-10-23T12:00:00Z", `2026-10-23T15:00:00Z${" ".repeat(50)}`]) {
      expect(creditsRefusal(anthropic(envelope("window_week", resets)), NOW), JSON.stringify(resets)).toMatchObject({ reason: "window_week", resetAt: null });
    }
  });

  it("is not a refusal unless the body is exactly the gateway's: never throws on anything else", () => {
    const html = '<html><body><script>alert("cave_code_credits_exhausted")</script></body></html>';
    const texts = [
      "",
      "429 rate_limit_error: Number of requests exceeded.",
      html,
      `402 ${html}`,
      '402 {"error":{"type":"cave_gateway_error","code":"cave_code_credits_exhausted"',
      '402 {"error": "cave_code_credits_exhausted"}',
      "402 [\"cave_code_credits_exhausted\"]",
      '402 null cave_code_credits_exhausted {}',
      anthropic({ error: { type: "other", code: "cave_code_credits_exhausted", details: { reason: "window_week" } } }),
      anthropic({ error: { type: "cave_gateway_error", code: "cave_code_rate_limited", details: { reason: "rate_limited" } } }),
      anthropic(envelope("model_not_offered")),
      anthropic(envelope("__proto__")),
      anthropic(envelope("constructor")),
      anthropic(envelope({ toString: "window_week" })),
      anthropic({ error: { type: "cave_gateway_error", code: "cave_code_credits_exhausted", details: "window_week" } }),
      anthropic({ error: { type: "cave_gateway_error", code: "cave_code_credits_exhausted", details: ["window_week"] } }),
      `402 ${JSON.stringify(envelope("window_week")).replace("cave_gateway_error", "x".repeat(20_000))}`,
    ];
    for (const text of texts) expect(() => creditsRefusal(text, NOW), text.slice(0, 80)).not.toThrow();
    for (const text of texts) expect(creditsRefusal(text, NOW), text.slice(0, 80)).toBeUndefined();
  });
});
