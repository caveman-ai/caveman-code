/** models.dev in the Caveman engine: what a new version looks like in the picker, and how pi-ai providers find their facts. */
import { afterEach, assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { CavemanSettings } from "../settings.ts";
import { resolveCavemanModel } from "./autoModel.ts";
import { cavemanModels, setCavemanKey } from "./credentials.ts";
import { checkCavemanStatus } from "./driver.ts";
import { parseModelsDev, setModelsDevFacts, type ModelFacts } from "@caveman-app/engine-core/server/modelsDev";
import { factsFor, isDeprecated, newerModels } from "./modelsDev.ts";
import { testModel } from "./keyTest.ts";
import { currentModels, listPriceUsd } from "./providers.ts";

const catalog = builtinModels();
const model = (over: Record<string, unknown> = {}) => ({
  name: "M",
  tool_call: true,
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_000_000, output: 64_000 },
  cost: { input: 3, output: 15, cache_read: 0.3 },
  ...over,
});
const API_JSON = {
  openai: {
    models: {
      "gpt-6.2-sol": model({ name: "GPT-6.2 Sol", reasoning: true }),
      "gpt-6.1-sol": model({ name: "GPT-6.1 Sol", status: "deprecated" }),
      "text-embedding-4": model({ tool_call: false }),
      "gpt-image-3": model({ modalities: { input: ["text"], output: ["image"] } }),
      "gpt-6.2-sol\u0000; rm -rf": model(),
    },
  },
  "kimi-code-plan-global": { models: { "k4": model({ name: "K4" }) } },
  "fireworks-ai": { models: { "accounts/fireworks/models/kimi-k4": model({ name: "Kimi K4" }) } },
};
const fact = (over: Partial<ModelFacts> = {}): ModelFacts => ({ name: "GPT-6.2 Sol", deprecated: false, reasoning: true, image: true, ...over });

afterEach(() => setModelsDevFacts(undefined));

describe("factsFor", () => {
  it("finds a pi-ai provider's facts under the id models.dev gives it", () => {
    setModelsDevFacts(parseModelsDev(API_JSON));
    assert.deepEqual(Object.keys(factsFor("kimi-coding")!), ["k4"]);
    assert.deepEqual(Object.keys(factsFor("fireworks")!), ["accounts/fireworks/models/kimi-k4"]);
    assert.ok(factsFor("openai")?.["gpt-6.2-sol"]);
    assert.equal(isDeprecated("openai", "gpt-6.1-sol"), true);
    assert.equal(factsFor("anthropic"), undefined);
  });
});

describe("newerModels", () => {
  const openai = catalog.getModels("openai") as ReadonlyArray<Model<Api>>;

  it("runs a family's new version on the newest catalog model's wire, with models.dev's name, limits and prices", () => {
    const [added, ...rest] = newerModels(openai, { "gpt-6.2-sol": fact({ context: 2_000_000, cost: { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 } }) }, ["gpt-sol", "gpt-luna"]);
    assert.equal(rest.length, 0);
    const base = openai.find((m) => m.id === "gpt-6.1-sol")!;
    assert.equal(added!.id, "gpt-6.2-sol");
    assert.equal(added!.name, "GPT-6.2 Sol");
    assert.equal(added!.api, base.api);
    assert.equal(added!.baseUrl, base.baseUrl);
    assert.equal(added!.contextWindow, 2_000_000);
    assert.equal(added!.maxTokens, base.maxTokens);
    // An output cap above the family's is never asked for; a lower one is kept.
    assert.equal(newerModels(openai, { "gpt-6.2-sol": fact({ output: base.maxTokens * 10 }) }, ["gpt-sol"])[0]!.maxTokens, base.maxTokens);
    assert.equal(newerModels(openai, { "gpt-6.2-sol": fact({ output: 1_000 }) }, ["gpt-sol"])[0]!.maxTokens, 1_000);
    assert.deepEqual(added!.cost, { input: 1, output: 8, cacheRead: 0.1, cacheWrite: 0 });
  });

  it("keeps every newer version, deprecated ones too, so a chat on one keeps running after the next", () => {
    const ids = newerModels(openai, { "gpt-6.2-sol": fact({ deprecated: true }), "gpt-6.3-sol": fact() }, ["gpt-sol"]).map((m) => m.id);
    assert.deepEqual(ids.sort(), ["gpt-6.2-sol", "gpt-6.3-sol"]);
  });

  it("runs a successor on its family's template even when models.dev deprecated that template", () => {
    const deepseek = catalog.getModels("deepseek") as ReadonlyArray<Model<Api>>;
    const facts = { "deepseek-v4-pro": fact({ deprecated: true }), "deepseek-v5-pro": fact({ name: "DeepSeek V5 Pro" }) };
    assert.deepEqual(newerModels(deepseek, facts, ["deepseek-v-pro"]).map((m) => m.id), ["deepseek-v5-pro"]);
  });

  it("adds nothing older, of a family the catalog lacks, or unpinned; and no price it does not know", () => {
    assert.deepEqual(newerModels(openai, { "gpt-6.0-sol": fact() }, ["gpt-sol"]), []);
    assert.deepEqual(newerModels(openai, { "gpt-1-nova": fact() }, ["gpt-nova"]), []);
    assert.deepEqual(newerModels(openai, { "gpt-6.2-sol": fact() }, ["gpt-luna"]), []);
    assert.deepEqual(newerModels(openai, { "gpt-6.2-sol": fact() }, ["gpt-sol"])[0]!.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("a new version in the Caveman engine", () => {
  const INSTANCE_ID = ProviderInstanceId.make("caveman");
  const layer = TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer));

  it.effect("runs, lists first in place of the one it replaces, is Auto's default and is priced, with no app release", () =>
    Effect.gen(function* () {
      setModelsDevFacts(parseModelsDev(API_JSON));
      const keys = { openai: { key: "sk-openai-0123456789abcdef" } };
      const models = yield* cavemanModels(keys);
      assert.equal(models.getModel("openai", "gpt-6.2-sol")?.name, "GPT-6.2 Sol");
      yield* setCavemanKey(INSTANCE_ID, "openai", keys.openai.key);
      const listed = (yield* checkCavemanStatus(INSTANCE_ID, Schema.decodeSync(CavemanSettings)({}))).models;
      assert.deepEqual(listed.filter((m) => m.isLegacy !== true).map((m) => m.slug), ["openai/gpt-6.2-sol", "openai/gpt-6-astra", "openai/gpt-6-luna", "openai/gpt-5.6-terra"]);
      for (const old of ["openai/gpt-6.1-sol", "openai/gpt-4-turbo", "openai/gpt-4o"]) assert.equal(listed.find((m) => m.slug === old)?.isLegacy, true, old);
      assert.equal(resolveCavemanModel("auto", keys), "openai/gpt-6.2-sol");
      assert.equal(listPriceUsd("openai/gpt-6.2-sol", { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 3);
      // The add-time key test still calls a model every account has.
      assert.ok(testModel(models.getModels("openai"), "openai")!.id !== "gpt-6.2-sol");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("waits for the bundled catalog where an account decides its models (Azure deployments, Bedrock, Copilot)", () =>
    Effect.gen(function* () {
      setModelsDevFacts({ azure: { "gpt-6.2-sol": fact() }, "amazon-bedrock": { "us.openai.gpt-6.2-sol": fact() } });
      const models = yield* cavemanModels({ azure: { key: "k", env: { AZURE_OPENAI_RESOURCE_NAME: "r" } }, "amazon-bedrock": { key: "k" } });
      assert.equal(models.getModel("azure", "gpt-6.2-sol"), undefined);
      assert.equal(models.getModel("amazon-bedrock", "us.openai.gpt-6.2-sol"), undefined);
      assert.equal(resolveCavemanModel("auto", { azure: { key: "k" } }), "azure/gpt-6.1-sol");
    }),
  );

  it("lists a family's newest even when models.dev deprecated all of a provider's pinned models, never nothing", () => {
    setModelsDevFacts({ deepseek: { "deepseek-v4-pro": fact({ deprecated: true }), "deepseek-flash": fact({ deprecated: true }) } });
    assert.deepEqual(currentModels("deepseek", catalog.getModels("deepseek"))?.map((m) => m.id), ["deepseek-v4-pro", "deepseek-flash"]);
    setModelsDevFacts({ openai: { "gpt-6.1-sol": fact({ deprecated: true }) } });
    assert.ok(!currentModels("openai", catalog.getModels("openai"))!.some((m) => m.id === "gpt-6.1-sol"), "one deprecated model alone drops out");
  });
});
