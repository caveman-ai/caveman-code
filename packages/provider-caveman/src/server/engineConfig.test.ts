/** Effort levels, as engineConfig.ts derives them from the pi-ai catalog, and what each sends on the wire. */
import { assert, describe, it } from "@effect/vitest";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { withCredits } from "./credits.ts";
import { defaultEffort, effortIds, effortLevel } from "./engineConfig.ts";
import { effortCapabilities } from "./driver.ts";
import { FEATURED_PROVIDERS } from "./providers.ts";

const catalog = withCredits(builtinModels(), "ck-test", "caveman-code/test", "https://gateway.caveman.test");
const openai = (id: string) => catalog.getModel("openai", id)!;
const anthropic = (id: string) => catalog.getModel("anthropic", id)!;
const context = { systemPrompt: "s", messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };

/** The request pi-ai would send for `level`, as the engine hands it over (pi-agent-core sends off as no level). */
const wire = async (model: Model<Api>, level: string | undefined) => {
  let body: unknown;
  const reasoning = level === undefined || level === "off" ? undefined : (level as Exclude<ModelThinkingLevel, "off">);
  await catalog
    .completeSimple(model, context, {
      apiKey: "k-test",
      sessionId: "s1",
      // Azure, Bedrock and Cloudflare's gateway need an endpoint before they build a request; only the body is compared.
      env: { AZURE_OPENAI_BASE_URL: "https://example.openai.azure.com/openai/v1", AWS_REGION: "us-east-1", CLOUDFLARE_ACCOUNT_ID: "account", CLOUDFLARE_GATEWAY_ID: "gateway" },
      ...(reasoning === undefined ? {} : { reasoning }),
      onPayload: (payload) => {
        body = structuredClone(payload);
        throw new Error("captured");
      },
    })
    .catch(() => undefined);
  if (body === undefined) throw new Error(`no request for ${model.provider}/${model.id}`);
  return body as Record<string, unknown>;
};

describe("Caveman effort", () => {
  it("defaults an OpenAI Responses reasoning model to medium, the level its API applies to a request that names none", () => {
    for (const id of ["gpt-6.1-sol", "gpt-6-luna", "gpt-6-sol"]) assert.equal(defaultEffort(openai(id)), "medium", id);
    assert.equal(defaultEffort(catalog.getModel("caveman", "openai/gpt-6.1-sol")!), "medium", "Caveman credits' OpenAI models too");
  });

  it("defaults a Claude 5.5 model to high, the effort pi-ai sends when none is given, and sends high on the wire either way", async () => {
    for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) assert.equal(defaultEffort(anthropic(id)), "high", id);
    const sonnet = anthropic("claude-sonnet-5-5");
    const descriptor = effortCapabilities(sonnet)?.optionDescriptors?.[0];
    const shown = descriptor?.type === "select" ? descriptor.currentValue : undefined;
    assert.equal(shown, "high");
    const untouched = await wire(sonnet, effortLevel(sonnet, shown));
    assert.deepEqual(untouched, await wire(sonnet, undefined));
    assert.match(JSON.stringify(untouched), /"output_config":\{"effort":"high"\}/);
  });

  it("says high explicitly to an OpenRouter reasoning model that cannot think not at all (GLM 5.3)", () => {
    const glm = catalog.getModel("openrouter", "z-ai/glm-5.3-flash")!;
    assert.equal(defaultEffort(glm), "high");
    // One that can turn thinking off still sends none explicitly (pi-ai's reasoning: { effort: "none" }).
    assert.equal(defaultEffort(catalog.getModel("openrouter", "moonshotai/kimi-k3")!), "off");
  });

  it("offers no effort control where what a request with no level runs at is unmeasured (Gemini 3)", () => {
    const gemini = catalog.getModel("google", "gemini-3.1-pro-preview")!;
    assert.ok(gemini.reasoning);
    assert.equal(defaultEffort(gemini), undefined);
    assert.deepEqual(effortIds(gemini), []);
    assert.equal(effortCapabilities(gemini), null);
    assert.equal(effortLevel(gemini, "low"), undefined, "no pick reaches the engine");
  });

  it("marks, for every reasoning model it offers, the level that sends what an untouched turn sends", async () => {
    const providers = ["caveman", ...FEATURED_PROVIDERS.map((provider) => provider.id)];
    let checked = 0;
    for (const model of providers.flatMap((provider) => catalog.getModels(provider))) {
      const level = defaultEffort(model);
      const descriptor = effortCapabilities(model)?.optionDescriptors?.[0];
      if (level === undefined) {
        assert.equal(descriptor, undefined, `${model.provider}/${model.id}`);
        continue;
      }
      const shown = descriptor?.type === "select" ? descriptor.currentValue : undefined;
      assert.equal(effortLevel(model, shown), level, `${model.provider}/${model.id}`);
      const sent = await wire(model, level);
      if (level === clampThinkingLevel(model, "medium") && /^(openai|caveman-openai|azure)$/.test(model.provider)) {
        // OpenAI: the API's own default said explicitly, so the encrypted reasoning is asked for and carried.
        assert.deepEqual(sent.include, ["reasoning.encrypted_content"], `${model.provider}/${model.id}`);
        assert.equal((sent.reasoning as { effort?: string } | undefined)?.effort, model.thinkingLevelMap?.[level] ?? level, `${model.provider}/${model.id}`);
      } else if (model.api === "anthropic-messages" && (model.compat as { supportsMidConvoEffort?: boolean } | undefined)?.supportsMidConvoEffort === true) {
        // Anthropic's managed-effort models: since pi-ai 1.3.0 no level can send thinking disabled (Haiku 5.5), so the API's own
        // default effort (high) is said explicitly: adaptive thinking, top-level effort pinned high, and the
        // effort-only system message that lets a later per-message change keep the cache.
        assert.equal((sent.thinking as { type?: string } | undefined)?.type, "adaptive", `${model.provider}/${model.id}`);
        assert.equal((sent.output_config as { effort?: string } | undefined)?.effort, "high", `${model.provider}/${model.id}`);
      } else if ((model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat === "openrouter" && level !== "off") {
 // external tools reasoning models with no off: no level sends no `reasoning` (the model's own default, which can be
        // its dearest), so high is said explicitly.
        assert.equal((sent.reasoning as { effort?: string } | undefined)?.effort, model.thinkingLevelMap?.[level] ?? level, `${model.provider}/${model.id}`);
      } else {
        assert.deepEqual(sent, await wire(model, undefined), `${model.provider}/${model.id}`);
      }
      checked++;
    }
    assert.ok(checked > 100, `checked ${checked}`);
  });

  it("offers the catalog's levels, pi's off as none, and reads a pick back as the engine's level", () => {
    assert.deepEqual(effortIds(openai("gpt-6.1-sol")), ["low", "medium", "high", "xhigh", "max"]);
    assert.deepEqual(effortIds(openai("gpt-6-luna")), ["none", "low", "medium", "high", "xhigh", "max"]);
    assert.equal(effortLevel(openai("gpt-6-luna"), "none"), "off");
    assert.equal(effortLevel(openai("gpt-6-luna"), "xhigh"), "xhigh");
    // A level the model does not offer is no pick: the default applies.
    assert.equal(effortLevel(openai("gpt-6.1-sol"), "none"), undefined);
    assert.equal(effortLevel(openai("gpt-6.1-sol"), undefined), undefined);
  });

  it("gives the composer one effort control with the default marked", () => {
    const descriptor = effortCapabilities(openai("gpt-6.1-sol"))?.optionDescriptors?.[0];
    assert.equal(descriptor?.id, "effort");
    assert.equal(descriptor?.type === "select" && descriptor.currentValue, "medium");
    assert.deepEqual(
      descriptor?.type === "select" && descriptor.options.filter((option) => option.isDefault).map((option) => option.id),
      ["medium"],
    );
    const noReasoning = catalog.getModels("openai").find((model) => !model.reasoning);
    if (noReasoning !== undefined) assert.equal(effortCapabilities(noReasoning), null);
  });
});

