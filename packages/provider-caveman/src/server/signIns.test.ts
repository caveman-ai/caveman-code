/** Subscription sign-ins: their stored tokens, refreshes shared and stored back, and plan billing (their egress route: egress.test.ts). */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, vi } from "vitest";

import { cavemanModels, cavemanSecrets, onPlan, planProvidersFor, readCavemanKeys, setCavemanKey, storedSignIns, type CavemanSignIn } from "./credentials.ts";
import { sideCallUsage } from "./rewriter.ts";

const INSTANCE_ID = ProviderInstanceId.make("caveman");
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const TOKEN_URL = "https://auth.openai.com/api/accounts/oauth/token";
const SCOPES = "openid offline_access chatgpt.tokens.use.direct";

const chatGpt = (over: Partial<CavemanSignIn> = {}): CavemanSignIn => ({
  access: "chatgpt-access-old-0123456789",
  refresh: "chatgpt-refresh-old-0123456789",
  expires: Date.now() - 1_000,
  clientId: "issued-client",
  scopes: SCOPES.split(" "),
  ...over,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Caveman engine sign-ins", () => {
  it.effect("stores a sign-in's tokens with the flow's own fields, as a plan whose tokens are secrets", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", { oauth: chatGpt({ expires: 123 }) });
      yield* setCavemanKey(INSTANCE_ID, "deepseek", "sk-deepseek-0123456789abcdef");
      const keys = yield* readCavemanKeys(INSTANCE_ID);
      assert.equal(keys.openai?.oauth?.clientId, "issued-client");
      assert.deepEqual(keys.openai?.oauth?.scopes, SCOPES.split(" "));
      assert.ok(onPlan("openai", keys.openai));
      assert.ok(!onPlan("deepseek", keys.deepseek));
      assert.ok(onPlan("opencode-go", { key: "sk-go" }), "a coding plan's key is a plan too");
      assert.deepEqual([...planProvidersFor(keys, "deepseek/deepseek-v4-pro")], ["openai"]);
 // A compact sign-in beside an OpenAI key: receipts name both `openai`, so the run's own slot decides.
      const both = { openai: { key: "sk-openai-0123456789" }, "openai~2": { oauth: chatGpt() } };
      assert.ok(planProvidersFor(both, "openai~2/gpt-6.1-sol").has("openai"));
      assert.ok(!planProvidersFor(both, "openai/gpt-6.1-sol").has("openai"));
      assert.ok(!planProvidersFor(both, "deepseek/deepseek-v4-pro").has("openai"), "a provider with a per-token key is not all plan");
      const secrets = cavemanSecrets(keys);
      assert.ok(secrets.includes("chatgpt-access-old-0123456789") && secrets.includes("chatgpt-refresh-old-0123456789"));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("never uses tokens for a provider without a plan sign-in (claude.ai)", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "anthropic", { oauth: chatGpt() });
      assert.deepEqual(yield* readCavemanKeys(INSTANCE_ID), {});
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refreshes an expired sign-in once for every session at once, and stores the rotated tokens", () =>
    Effect.gen(function* () {
      let calls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          assert.equal(String(input), TOKEN_URL);
          const body = new URLSearchParams(String(init?.body));
          assert.equal(body.get("refresh_token"), "chatgpt-refresh-old-0123456789", "a rotated refresh token is never spent twice");
          calls += 1;
          await new Promise((resolve) => setTimeout(resolve, 20));
          return new Response(JSON.stringify({ access_token: "chatgpt-access-new", refresh_token: "chatgpt-refresh-new", scope: SCOPES, expires_in: 3600 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }),
      );
      yield* setCavemanKey(INSTANCE_ID, "openai", { oauth: chatGpt() });
      const keys = yield* readCavemanKeys(INSTANCE_ID);
      const stored = yield* storedSignIns(INSTANCE_ID);
      // Two sessions, each with its own Models built from the same (expired) stored tokens.
      const a = yield* cavemanModels(keys, stored);
      const b = yield* cavemanModels(keys, stored);
      const [authA, authB] = yield* Effect.promise(() => Promise.all([a.getAuth("openai"), b.getAuth("openai")]));
      assert.equal(calls, 1);
      assert.equal(authA?.auth.apiKey, "chatgpt-access-new");
      assert.equal(authB?.auth.apiKey, "chatgpt-access-new");
      const after = (yield* readCavemanKeys(INSTANCE_ID)).openai?.oauth;
      assert.equal(after?.access, "chatgpt-access-new");
      assert.equal(after?.refresh, "chatgpt-refresh-new");
      assert.equal(after?.clientId, "issued-client");
      // A third session that read the old tokens takes the stored ones instead of refreshing again.
      const c = yield* cavemanModels(keys, stored);
      assert.equal((yield* Effect.promise(() => c.getAuth("openai")))?.auth.apiKey, "chatgpt-access-new");
      assert.equal(calls, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps a new sign-in over a refresh of the tokens it replaced", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "openai", { oauth: chatGpt({ access: "fresh-sign-in", refresh: "fresh-refresh" }) });
      const stored = yield* storedSignIns(INSTANCE_ID);
      yield* Effect.promise(() => stored.write("openai", chatGpt(), chatGpt({ access: "stale-lineage", refresh: "stale-refresh" })));
      assert.equal((yield* readCavemanKeys(INSTANCE_ID)).openai?.oauth?.access, "fresh-sign-in");
      // Removed meanwhile: a refresh does not bring it back.
      yield* setCavemanKey(INSTANCE_ID, "openai", null);
      yield* Effect.promise(() => stored.write("openai", chatGpt({ access: "fresh-sign-in", refresh: "fresh-refresh" }), chatGpt({ access: "late" })));
      assert.equal((yield* readCavemanKeys(INSTANCE_ID)).openai, undefined);
    }).pipe(Effect.provide(layer)),
  );


  it("records a side request on a plan as the plan's, with no price", () => {
    const result = { requests: 1, input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0, costUsd: 0.01 };
    const onChatGpt = sideCallUsage("openai/gpt-5-nano", result, { openai: { oauth: chatGpt() } });
    assert.equal(onChatGpt?.cost, null);
    assert.equal(onChatGpt?.billing, "plan");
    const onKey = sideCallUsage("openai/gpt-5-nano", result, { openai: { key: "sk-x" } });
    assert.deepEqual(onKey?.cost, { usd: 0.01, basis: "list_price" });
    assert.equal(onKey?.billing, undefined);
  });
});
