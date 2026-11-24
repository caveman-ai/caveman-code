import type { EngineAccount, EngineProvider } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";
import { accountsOf, connectedSources, keyChoiceCount, keyChoices, providerBrand, providerFor, sourceName, subscriptions, worstAccount } from "./caveman-sources.ts";

const providers: ReadonlyArray<EngineProvider> = [
  { id: "github-copilot", label: "GitHub Copilot", group: "featured", auth: "key", sign_in: true, sign_in_label: "Sign in with GitHub", sign_in_plan: "GitHub Copilot", sign_in_only: true },
  { id: "openai", label: "OpenAI", group: "featured", section: "keys", auth: "key", sign_in: true, sign_in_label: "Sign in with ChatGPT", sign_in_plan: "ChatGPT" },
  { id: "anthropic", label: "Anthropic", group: "featured", section: "keys", auth: "key" },
  { id: "zai", label: "GLM Coding Plan", group: "featured", section: "plans", auth: "key", plan: true },
  { id: "openrouter", label: "OpenRouter", group: "featured", section: "gateways", auth: "key", sign_in: true, sign_in_label: "Sign in with OpenRouter" },
  { id: "ollama", label: "Ollama", group: "local", auth: "optional_key", base_url: "http://localhost:11434/v1" },
  { id: "cohere", label: "Cohere", group: "more", auth: "key" },
  { id: "caveman", label: "Caveman credits", group: "credits", auth: "account" },
];

const account = (id: string, extra: Partial<EngineAccount> = {}): EngineAccount => ({ id: `caveman:${id}`, label: id, kind: "api_key", active: true, provider: id.split("~")[0]!, ...extra });

describe("connectedSources", () => {
  it("keeps a subscription apart from its provider's keys, and a provider's further keys together", () => {
    const sources = connectedSources(
      [account("openai", { kind: "login", label: "ChatGPT plan" }), account("openai~2", { label: "OpenAI API key …4f2a" }), account("openai~3", { label: "OpenAI API key …9c1d" }), account("anthropic")],
      providers,
    );
    expect(sources.map((s) => [s.key, s.accounts.length])).toEqual([
      ["plan:openai", 1],
      ["openai", 2],
      ["anthropic", 1],
    ]);
    expect(sources.map(sourceName)).toEqual(["ChatGPT", "OpenAI", "Anthropic"]);
  });

  it("leaves Caveman credits to their own row", () => {
    expect(connectedSources([account("caveman", { label: "Caveman credits" })], providers)).toEqual([]);
  });

  it("names an endpoint of your own as you did, and takes no key for a plan linked through Cloud", () => {
    const [endpoint, plan] = connectedSources([account("custom-work-vllm", { label: "Work vLLM at gpu.lan:8000" }), account("chatgpt", { label: "ChatGPT plan" })], providers);
    expect(endpoint!.provider).toMatchObject({ id: "custom-work-vllm", label: "Work vLLM", auth: "optional_key" });
    expect(plan!.provider).toMatchObject({ id: "chatgpt", label: "ChatGPT plan", auth: "account" });
  });

  it("reads the provider from an older account's id", () => {
    const { provider: _, ...old } = account("anthropic");
    expect(connectedSources([old], providers)[0]!.key).toBe("anthropic");
  });
});

it("accountsOf splits a provider's sign-ins from its keys", () => {
  const accounts = [account("openai", { kind: "login" }), account("openai~2")];
  expect(accountsOf(accounts, "plan:openai").map((a) => a.id)).toEqual(["caveman:openai"]);
  expect(accountsOf(accounts, "openai").map((a) => a.id)).toEqual(["caveman:openai~2"]);
});

it("subscriptions lists sign-ins, then coding plans", () => {
  expect(subscriptions(providers).map((s) => [s.key, s.name, s.how])).toEqual([
    ["plan:github-copilot", "GitHub Copilot", "sign_in"],
    ["plan:openai", "ChatGPT", "sign_in"],
    ["zai", "GLM Coding Plan", "key"],
  ]);
});

describe("keyChoices", () => {
  it("shows the featured sections and your own server, without sign-in-only providers, plans or credits", () => {
    expect(keyChoices(providers, "").map((g) => [g.label, g.items.map((p) => p.id)])).toEqual([
      ["API keys", ["openai", "anthropic"]],
      ["Gateways", ["openrouter"]],
      ["Your own server", ["ollama", "custom"]],
    ]);
  });

  it("searches every provider, the rest of the catalog too", () => {
    expect(keyChoices(providers, "coh").flatMap((g) => g.items.map((p) => p.id))).toEqual(["cohere"]);
    expect(keyChoices(providers, "nothing like it")).toEqual([]);
  });

  it("counts what the search covers", () => {
    expect(keyChoiceCount(providers)).toBe(6);
  });
});

it("worstAccount shows a source by its worst key", () => {
  const ok = account("openai", { health: { state: "ok", checked_at: "2026-10-22T00:00:00Z" } });
  const failing = account("openai~2", { health: { state: "failing", checked_at: "2026-10-22T00:00:00Z" } });
  expect(worstAccount([ok, failing])).toBe(failing);
});

it("providerBrand marks the vendors the kit has, slots included", () => {
  expect([providerBrand("openai~2"), providerBrand("chatgpt"), providerBrand("github-copilot"), providerBrand("xai"), providerBrand("mistral")]).toEqual(["openai", "openai", "github", "grok", undefined]);
  expect(providerFor("custom", providers).label).toBe("OpenAI-compatible endpoint");
});
