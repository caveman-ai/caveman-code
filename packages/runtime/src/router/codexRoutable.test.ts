// Auto for Codex only where Codex talks to OpenAI's own API: an Auto thread takes the
// proxy's OpenAI route in place of its model provider.
import { expect, test } from "vitest";

import { codexRoutable } from "./codexRoutable.ts";

const routable = (configText: string, launchArgs?: string, environment: NodeJS.ProcessEnv = {}) => codexRoutable({ configText, launchArgs, environment });

test("the built-in OpenAI provider on OpenAI's API takes Auto", () => {
  expect(routable("")).toBe(true);
  expect(routable('model = "gpt-5.5"\nmodel_provider = "openai"\n')).toBe(true);
  expect(routable('openai_base_url = "https://api.openai.com/v1"\n')).toBe(true);
});

test("another model provider, or OpenAI's provider sent elsewhere, takes no Auto", () => {
  const azure = 'model_provider = "azure"\n\n[model_providers.azure]\nname = "Azure"\nbase_url = "https://acme.openai.azure.com/openai"\nenv_key = "AZURE_OPENAI_API_KEY"\nwire_api = "responses"\n';
  expect(routable(azure)).toBe(false);
  expect(routable('model_provider = "ollama"\n')).toBe(false);
  expect(routable('model_provider = "openrouter"\n\n[model_providers.openrouter]\nname = "OpenRouter"\nbase_url = "https://openrouter.ai/api/v1"\nenv_key = "OPENROUTER_API_KEY"\n')).toBe(false);
  expect(routable('openai_base_url = "https://llm.acme.internal/v1"\n')).toBe(false);
  expect(routable("", undefined, { OPENAI_BASE_URL: "https://llm.acme.internal/v1" })).toBe(false);
  // A profile, or the launch arguments, pick the provider too.
  expect(routable(`profile = "work"\n\n[profiles.work]\nmodel_provider = "azure"\n\n${azure.slice(azure.indexOf("[model_providers"))}`)).toBe(false);
  expect(routable(azure.slice(azure.indexOf("[model_providers")), '-c model_provider="azure"')).toBe(false);
  expect(routable(azure, '-c model_provider="openai"')).toBe(true);
});
