/** The provider registry, the stored-key format (v1 still reads), endpoints, and the add-time test call. */
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as NodeHttp from "node:http";

import { CavemanSettings } from "../settings.ts";
import { cavemanModelRefusal, resolveCavemanModel } from "./adapter.ts";
import { cavemanModels, readCavemanKeys, setCavemanKey } from "./credentials.ts";
import { checkCavemanStatus } from "./driver.ts";
import { classifyProviderError, testCavemanCredential } from "./keyTest.ts";
import { newestOfFamilies } from "@caveman-app/engine-core/server/modelLine";
import { currentModels, FEATURED_PROVIDERS, MORE_PROVIDERS, isAddableProvider, isPlanKey, listPriceUsd, providerInfo, signInOf } from "./providers.ts";

const INSTANCE_ID = ProviderInstanceId.make("caveman");
const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));
const catalog = builtinModels();

describe("Caveman engine providers", () => {
  it("prices context tiers only with request input, including cache reads and 1h writes", () => {
    for (const [model, threshold, multiplier] of [["anthropic/claude-haiku-5-5", 100_000, 5], ["openai/gpt-6.1-sol", 272_000, 2]] as const) {
      const tokens = { input: 100, output: 0, cacheRead: threshold, cacheWrite: 0 };
      const base = listPriceUsd(model, tokens)!;
      assert.equal(listPriceUsd(model, tokens, threshold), base);
      assert.approximately(listPriceUsd(model, tokens, threshold + 100)!, base * multiplier, 1e-12);
    }
    assert.equal(listPriceUsd("anthropic/claude-opus-5-5", { input: 200, output: 0, cacheRead: 500, cacheWrite: 300, cacheWrite1h: 100 }), 0.0027);
    assert.equal(listPriceUsd("custom/missing", { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 }, 1), undefined);
  });
  it("pins only families the bundled catalog has a model of", () => {
    for (const p of FEATURED_PROVIDERS) {
      for (const family of p.families ?? []) {
        assert.equal(newestOfFamilies(catalog.getModels(p.id), [family]).length, 1, `${p.id} has no ${family} model in pi-ai's catalog`);
      }
    }
  });

  it("lists each pinned family's newest model, and nothing that superseded or retired", () => {
    const listed = (provider: string) => currentModels(provider, catalog.getModels(provider))?.map((m) => m.id);
    assert.deepEqual(listed("openai"), ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna", "gpt-5.6-terra"]);
    assert.deepEqual(listed("anthropic"), ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1"]);
    assert.deepEqual(listed("xai"), ["grok-4.7"]);
    assert.deepEqual(listed("amazon-bedrock"), ["us.anthropic.claude-sonnet-5-5", "us.anthropic.claude-opus-5-5", "us.openai.gpt-6.1-sol", "us.moonshotai.kimi-k3"]);
    assert.deepEqual(listed("fireworks"), ["accounts/fireworks/models/kimi-k3", "accounts/fireworks/models/glm-5p3", "accounts/fireworks/models/qwen3p8-max", "accounts/fireworks/models/minimax-m3"]);
    assert.ok(!listed("openai")!.some((id) => /^gpt-4|^o\d/.test(id)));
    // A key slot lists what its provider does; endpoints, credits and plans set nothing apart.
    assert.deepEqual(currentModels("openai~2", catalog.getModels("openai"))?.map((m) => m.id), listed("openai"));
    for (const id of ["custom-work", "ollama", "caveman", "chatgpt"]) assert.equal(currentModels(id, [{ id: "anything-1" }]), undefined, id);
    // A provider under More goes by every pinned family, and lists everything when none matches.
    assert.deepEqual(currentModels("huggingface", [{ id: "moonshotai/Kimi-K2" }, { id: "moonshotai/Kimi-K3" }, { id: "x/y" }]), [{ id: "moonshotai/Kimi-K3" }]);
    assert.equal(currentModels("huggingface", [{ id: "x/y" }]), undefined);
  });

  it("offers subscription sign-ins, never claude.ai's, and the rest under More", () => {
    assert.equal(providerInfo("openai-codex"), undefined, "OpenAI's own Sign in with ChatGPT replaced the legacy Codex backend");
    assert.equal(isAddableProvider("openai-codex"), false);
    assert.deepEqual(signInOf("openai"), { label: "Sign in with ChatGPT", plan: "ChatGPT" });
    assert.deepEqual(signInOf("xai"), { label: "Sign in with SuperGrok", plan: "SuperGrok" });
    assert.equal(signInOf("github-copilot")?.plan, "GitHub Copilot");
    assert.equal(providerInfo("github-copilot")?.signInOnly, true);
    assert.equal(signInOf("openrouter")?.plan, undefined, "OpenRouter's sign-in hands back a key, not a plan");
    assert.equal(signInOf("anthropic"), undefined, "never claude.ai login (README.md)");
    for (const id of ["opencode-go", "kimi-coding", "zai", "qwen-token-plan"]) assert.ok(isPlanKey(id), `${id} is a coding plan's key`);
    for (const id of ["opencode", "openai", "openrouter"]) assert.equal(isPlanKey(id), false);
    assert.deepEqual(
      ["keys", "plans", "gateways"].map((section) => FEATURED_PROVIDERS.filter((p) => p.section === section).length > 0),
      [true, true, true],
    );
    assert.equal(providerInfo("ollama-cloud")?.baseUrl, "https://ollama.com/v1");
    assert.ok(MORE_PROVIDERS.some((p) => p.id === "huggingface"));
    // pi-ai's Cloudflare auth needs ids beside the key: asked for, so a key never stores as failing for want of them.
    assert.deepEqual(providerInfo("cloudflare-ai-gateway")?.fields?.map((f) => f.env), ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"]);
    assert.deepEqual(providerInfo("cloudflare-workers-ai")?.fields?.map((f) => f.env), ["CLOUDFLARE_ACCOUNT_ID"]);
    assert.equal(isAddableProvider("caveman"), false, "credits come from Settings > Account only");
    assert.ok(isAddableProvider("custom-work-vllm") && !isAddableProvider("custom-Bad Name"));
  });

  it.effect("reads a v1 blob of key strings, hides providers the app does not offer, and keeps their keys on the next write", () =>
    Effect.gen(function* () {
      const store = yield* (yield* ProviderHost.ProviderHost).credentials("caveman", INSTANCE_ID);
      yield* store.set(new TextEncoder().encode(JSON.stringify({ version: 1, keys: { openai: "sk-old-0123456789abcdef", "openai-codex": "codex_x" } })));
      assert.deepEqual(yield* readCavemanKeys(INSTANCE_ID), { openai: { key: "sk-old-0123456789abcdef" } });
      yield* setCavemanKey(INSTANCE_ID, "deepseek", "sk-deepseek-0123456789abcdef");
      const raw = JSON.parse(new TextDecoder().decode((yield* store.get).pipe((o) => (o._tag === "Some" ? o.value : new Uint8Array()))));
      assert.equal(raw.version, 2);
      // A provider a pi-ai upgrade dropped or renamed is never used, and never deleted by an unrelated change.
      assert.deepEqual(Object.keys(raw.providers).sort(), ["deepseek", "openai", "openai-codex"]);
      assert.deepEqual(Object.keys(yield* readCavemanKeys(INSTANCE_ID)).sort(), ["deepseek", "openai"]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("offers a Cloud computer's credits as the credits slot without asking for a key: a request asks, never a read, and nothing is stored", () => {
    let available = true;
    let held: { key: string; gateway?: string } | undefined;
    let asked = 0;
    const credits = {
      available: () => available,
      peek: () => held,
      get: async () => {
        asked++;
        return (held ??= { key: "cave_live_computer_key_1", gateway: "https://gateway.customer.example" });
      },
    };
    return Effect.gen(function* () {
      // Credits run here and no key is held yet: the slot is offered, and reading it (a status probe, the model list) asks nothing.
      const before = yield* readCavemanKeys(INSTANCE_ID);
      assert.isDefined(before.caveman);
      assert.isDefined(before.caveman?.live);
      assert.equal(asked, 0);
      const status = yield* checkCavemanStatus(INSTANCE_ID, Schema.decodeSync(CavemanSettings)({}));
      assert.isTrue(status.models.some((m) => m.slug.startsWith("caveman/")));
      assert.equal(asked, 0);
      // A request asks, through the slot's live read: the key and the gateway its Cloud named.
      assert.deepEqual(yield* Effect.promise(() => before.caveman!.live!()), { key: "cave_live_computer_key_1", gateway: "https://gateway.customer.example" });
      assert.equal(asked, 1);
      // Held now, a read shows it, still asking nothing.
      const keys = yield* readCavemanKeys(INSTANCE_ID);
      assert.deepEqual({ key: keys.caveman?.key, gateway: keys.caveman?.gateway }, { key: "cave_live_computer_key_1", gateway: "https://gateway.customer.example" });
      assert.equal(asked, 1);
      // Settings' writes keep the person's own keys only: the computer's credits key never reaches the store.
      yield* setCavemanKey(INSTANCE_ID, "deepseek", "sk-deepseek-0123456789abcdef");
      const store = yield* (yield* ProviderHost.ProviderHost).credentials("caveman", INSTANCE_ID);
      const raw = new TextDecoder().decode((yield* store.get).pipe((o) => (o._tag === "Some" ? o.value : new Uint8Array())));
      assert.deepEqual(Object.keys(JSON.parse(raw).providers), ["deepseek"]);
      assert.notInclude(raw, "cave_live_computer_key");
      assert.deepEqual(Object.keys(yield* readCavemanKeys(INSTANCE_ID)).sort(), ["caveman", "deepseek"]);
      // Cloud said credits are not for this computer: no credits slot.
      available = false;
      assert.deepEqual(Object.keys(yield* readCavemanKeys(INSTANCE_ID)), ["deepseek"]);
      // A credits key kept in the store wins: it is the one Settings turned on.
      available = true;
      yield* setCavemanKey(INSTANCE_ID, "caveman", "cave_live_own_key_0123456789");
      assert.equal((yield* readCavemanKeys(INSTANCE_ID)).caveman?.key, "cave_live_own_key_0123456789");
      assert.equal((yield* readCavemanKeys(INSTANCE_ID)).caveman?.live, undefined);
      assert.equal(asked, 1);
    }).pipe(Effect.provide(TestProviderHost.layer({ credits }).pipe(Layer.provide(NodeServices.layer))));
  });

  it.effect("lists the current models first and keeps every other connected model under More models; Auto takes the first", () =>
    Effect.gen(function* () {
      yield* setCavemanKey(INSTANCE_ID, "mistral", "mistral-key-0123456789abcdef");
      const status = yield* checkCavemanStatus(INSTANCE_ID, Schema.decodeSync(CavemanSettings)({}));
      const slugs = status.models.map((m) => m.slug);
      assert.deepEqual(slugs.slice(0, 3), ["mistral/devstral-2512", "mistral/mistral-large-4", "mistral/codestral-2508"]);
      assert.equal(status.models.length, catalog.getModels("mistral").length);
      assert.deepEqual(status.models.map((m) => m.isLegacy === true), slugs.map((_, i) => i >= 3));
      assert.equal(resolveCavemanModel("auto", yield* readCavemanKeys(INSTANCE_ID)), "mistral/devstral-2512");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("runs an OpenAI-compatible endpoint's models, keyless", () =>
    Effect.gen(function* () {
      const models = yield* cavemanModels({ ollama: { endpoint: { name: "Ollama", baseUrl: "http://localhost:11434/v1/", models: ["qwen3-coder"] } } });
      const model = models.getModel("ollama", "qwen3-coder");
      assert.equal(model?.baseUrl, "http://localhost:11434/v1");
      assert.equal(resolveCavemanModel("auto", { ollama: { endpoint: { name: "Ollama", baseUrl: "x", models: ["qwen3-coder"] } } }), "ollama/qwen3-coder");
    }),
  );

  it("a pick whose key slot was removed resolves to nothing and says so, even with another key of its provider", () => {
    // openai's first key was removed and a second added: it holds openai~2, never openai.
    const keys = { "openai~2": { key: "sk-second-0123456789abcdef" } };
    assert.isNull(resolveCavemanModel("openai/gpt-5.5", keys));
    assert.equal(cavemanModelRefusal("openai/gpt-5.5", keys), "The OpenAI key this model ran on was removed. Pick the model again.");
    assert.equal(resolveCavemanModel("openai~2/gpt-5.5", keys), "openai~2/gpt-5.5");
    assert.equal(cavemanModelRefusal("google/gemini-3-pro", keys), "The Caveman engine has no google API key. Add one in Settings.");
  });

  it("sorts provider errors into what the page says", () => {
    assert.equal(classifyProviderError("401 invalid x-api-key"), "auth");
    assert.equal(classifyProviderError("429 You exceeded your current quota"), "limit");
    assert.equal(classifyProviderError("fetch failed: ECONNREFUSED"), "network");
    assert.equal(classifyProviderError("500 something else"), "other");
  });

  it.effect("test-calls an endpoint and reports a refused key without echoing it", () =>
    Effect.gen(function* () {
      const key = "sk-local-refused-0123456789abcdef";
      const server = NodeHttp.createServer((req, res) => {
        const ok = req.headers.authorization === "Bearer good-key-0123456789abcdef";
        res.writeHead(ok ? 200 : 401, { "content-type": ok ? "text/event-stream" : "application/json" });
        if (!ok) return res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${key}` } }));
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: "1", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
      yield* Effect.acquireRelease(
        Effect.promise(() => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))),
        () => Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      const port = (server.address() as { port: number }).port;
      const endpoint = { name: "Test", baseUrl: `http://127.0.0.1:${port}/v1`, models: ["m1"] };
      const refused = yield* testCavemanCredential("custom-test", { key, endpoint });
      assert.equal(refused.ok, false);
      if (!refused.ok) {
        assert.equal(refused.kind, "auth");
        assert.ok(!refused.message.includes(key));
      }
      const ok = yield* testCavemanCredential("custom-test", { key: "good-key-0123456789abcdef", endpoint });
      assert.deepEqual(ok, { ok: true, model: "m1" });
    }).pipe(Effect.scoped),
  );
});
