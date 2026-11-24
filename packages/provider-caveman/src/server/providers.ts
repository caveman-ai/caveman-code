/**
 * The Caveman engine's providers (Settings -> Models & keys): a curated list
 * read off the bundled pi-ai catalog, each with the model families it lists
 * (engine-core modelLine.ts), every other pi-ai provider under "More",
 * OpenAI-compatible endpoints the person adds (Ollama and LM Studio are
 * presets of one), and Caveman credits (Settings -> Account, see credits.ts).
 *
 * API keys, plus subscription sign-ins: compact (OpenAI's own flow for
 * third-party agents), GitHub Copilot (pi-ai's flow, which speaks as VS Code's
 * Copilot Chat) and SuperGrok (xAI's device flow); and external tools's sign-in,
 * which hands back an ordinary API key. Never claude.ai (Anthropic's terms,
 * README.md). Coding plans (OpenCode Go, Kimi Code, GLM) are subscriptions
 * billed through a key: pasted, and their usage counts as the plan's. Copilot,
 * SuperGrok and Kimi Code carry an account risk the founder accepted.
 *
 * @module provider-caveman/server/providers
 */
import type { Api, Model } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { CHATGPT_PLAN_PROVIDER, CREDITS_PROVIDER } from "./credits.ts";
import { modelLine, newestOfFamilies } from "@caveman-app/engine-core/server/modelLine";
import { factsFor, isDeprecated, newerModels } from "./modelsDev.ts";

/** A non-secret setting a provider needs besides its key, handed to pi-ai as the credential's env. */
export interface ProviderField {
  readonly env: string;
  readonly label: string;
  readonly placeholder?: string;
  readonly optional?: boolean;
}

export interface CavemanProviderInfo {
  /** pi-ai's provider id, `custom-<slug>` for an endpoint, or `caveman` for credits. */
  readonly id: string;
  readonly label: string;
  readonly group: "featured" | "more" | "local" | "custom" | "credits" | "plan";
  /** key: a pasted key; optional_key: an endpoint that may need none; account: Caveman credits or a plan Cloud links (Settings -> Account). */
  readonly auth: "key" | "optional_key" | "account";
  readonly keyLabel?: string;
  readonly keyUrl?: string;
  readonly fields?: ReadonlyArray<ProviderField>;
 /** A one-click sign-in beside the pasted key. `plan` names the subscription it runs on ("compact"), absent when it hands back a key. */
  readonly signIn?: { readonly label: string; readonly plan?: string };
  /** Only the sign-in: no key to paste (GitHub Copilot). */
  readonly signInOnly?: boolean;
  /** Where Models & keys lists a featured provider or preset; a subscription sign-in also shows under Subscriptions. */
  readonly section?: "keys" | "plans" | "gateways";
  /** A subscription billed through its key (Kimi Code, OpenCode Go): usage is on the plan, never priced per token. */
  readonly plan?: boolean;
  /**
   * Model families (engine-core modelLine.ts) the picker lists and Auto considers, each by its newest model, so a new version takes
   * the old one's place without an edit here. Everything else is under "More models".
   */
  readonly families?: ReadonlyArray<string>;
  /** The family a key runs on when nobody picked a model; the first family when unset. */
  readonly defaultFamily?: string;
  /**
   * Which models a key can call depends on its account (an Azure deployment's name, Bedrock model access, a Copilot
   * organization's policy): models.dev adds none, so a new version waits for the bundled catalog.
   */
  readonly modelsByAccount?: boolean;
  /** Local presets: the endpoint's usual address. */
  readonly baseUrl?: string;
}

const featured = (
  id: string,
  label: string,
  families: ReadonlyArray<string>,
  extra: Partial<CavemanProviderInfo> = {},
): CavemanProviderInfo => ({ id, label, group: "featured", auth: "key", families, ...extra });

/** In the order Models & keys shows them, section by section. Each family has a model in pi-ai's catalog (providers.test.ts checks). */
export const FEATURED_PROVIDERS: ReadonlyArray<CavemanProviderInfo> = [
  // Subscriptions without a key of their own.
  featured("github-copilot", "GitHub Copilot", ["claude-sonnet", "claude-opus", "gpt-sol", "gemini-flash", "grok", "gpt-luna"], {
    signIn: { label: "Sign in with GitHub", plan: "GitHub Copilot" },
    signInOnly: true,
    modelsByAccount: true,
  }),
  // API keys.
  featured("anthropic", "Anthropic", ["claude-opus", "claude-sonnet", "claude-haiku", "claude-fable"], {
    section: "keys",
    keyUrl: "https://console.anthropic.com/settings/keys",
    defaultFamily: "claude-sonnet",
  }),
  featured("openai", "OpenAI", ["gpt-sol", "gpt-astra", "gpt-luna", "gpt-terra"], {
    section: "keys",
    keyUrl: "https://platform.openai.com/api-keys",
    signIn: { label: "Sign in with ChatGPT", plan: "ChatGPT" },
  }),
  featured("xai", "xAI", ["grok"], { section: "keys", keyUrl: "https://console.x.ai", signIn: { label: "Sign in with SuperGrok", plan: "SuperGrok" } }),
  featured("google", "Google", ["gemini-pro", "gemini-argon", "gemini-flash", "gemini-flash-lite"], { section: "keys", keyLabel: "Gemini API key", keyUrl: "https://aistudio.google.com/apikey" }),
  featured("deepseek", "DeepSeek", ["deepseek-v-pro", "deepseek-flash"], { section: "keys", keyUrl: "https://platform.deepseek.com/api_keys" }),
  featured("mistral", "Mistral", ["devstral", "mistral-large", "codestral"], { section: "keys", keyUrl: "https://console.mistral.ai/api-keys" }),
  featured("moonshotai", "Moonshot (Kimi)", ["kimi-k", "kimi-k-code"], { section: "keys", keyUrl: "https://platform.moonshot.ai/console/api-keys" }),
  featured("groq", "Groq", ["gpt-oss-120b", "qwen-27b"], { section: "keys", keyUrl: "https://console.groq.com/keys" }),
  featured("cerebras", "Cerebras", ["gpt-oss-120b", "qwen-27b"], { section: "keys", keyUrl: "https://cloud.cerebras.ai" }),
  featured("together", "Together", ["kimi-k", "glm", "deepseek-v-pro", "qwen-plus"], { section: "keys", keyUrl: "https://api.together.ai/settings/api-keys" }),
  featured("fireworks", "Fireworks", ["kimi-k", "glm", "qwen-max", "minimax-m"], {
    section: "keys",
    keyUrl: "https://fireworks.ai/account/api-keys",
  }),
  featured("amazon-bedrock", "Amazon Bedrock", ["us.claude-sonnet", "us.claude-opus", "us.gpt-sol", "us.kimi-k"], {
    section: "keys",
    keyLabel: "Bedrock API key",
    keyUrl: "https://console.aws.amazon.com/bedrock/home#/api-keys",
    fields: [{ env: "AWS_REGION", label: "Region", placeholder: "us-east-1" }],
    modelsByAccount: true,
  }),
  featured("google-vertex", "Google Vertex AI", ["gemini-pro", "gemini-argon", "gemini-flash"], {
    section: "keys",
    keyLabel: "Vertex AI API key",
    keyUrl: "https://console.cloud.google.com/vertex-ai",
    modelsByAccount: true,
  }),
  featured("azure", "Azure OpenAI", ["gpt-sol", "gpt-luna", "gpt-astra"], {
    section: "keys",
    keyLabel: "Azure OpenAI key",
    fields: [{ env: "AZURE_OPENAI_RESOURCE_NAME", label: "Resource name", placeholder: "my-resource" }],
    modelsByAccount: true,
  }),
  // Coding plans: a subscription billed through its key.
  featured("opencode-go", "OpenCode Go", ["kimi-k", "glm", "deepseek-v-pro", "qwen-max", "minimax-m", "gpt-luna"], {
    section: "plans",
    keyLabel: "OpenCode API key",
    keyUrl: "https://opencode.ai/auth",
    plan: true,
  }),
  featured("kimi-coding", "Kimi Code", ["k", "kimi-for-coding", "kimi-for-coding-highspeed"], { section: "plans", keyLabel: "Kimi Code API key", plan: true }),
  // pi-ai's Z.ai provider is the GLM Coding Plan's endpoint (api.z.ai/api/coding).
  featured("zai", "GLM Coding Plan", ["glm", "glm-flash", "glm-highspeed"], {
    section: "plans",
    keyLabel: "Z.ai API key",
    keyUrl: "https://z.ai/manage-apikey/apikey-list",
    plan: true,
  }),
  // Gateways.
  featured(
    "openrouter",
    "OpenRouter",
    ["claude-sonnet", "claude-opus", "gpt-sol", "gemini-flash", "deepseek-v-pro", "kimi-k", "glm", "grok", "qwen-max"],
    { section: "gateways", signIn: { label: "Sign in with OpenRouter" }, keyUrl: "https://openrouter.ai/settings/keys" },
  ),
  featured("opencode", "OpenCode Zen", ["claude-sonnet", "claude-opus", "gpt-sol", "gemini-flash", "kimi-k", "glm", "qwen-max"], {
    section: "gateways",
    keyLabel: "OpenCode API key",
    keyUrl: "https://opencode.ai/auth",
  }),
  featured("vercel-ai-gateway", "Vercel AI Gateway", ["claude-sonnet", "claude-opus", "gpt-sol", "gemini-flash", "kimi-k", "glm"], {
    section: "gateways",
    keyLabel: "AI Gateway API key",
    keyUrl: "https://vercel.com/docs/ai-gateway",
  }),
  featured("cloudflare-ai-gateway", "Cloudflare AI Gateway", ["claude-sonnet", "claude-opus", "gpt-sol", "kimi-k-code"], {
    section: "gateways",
    keyLabel: "Cloudflare API token",
    keyUrl: "https://dash.cloudflare.com/profile/api-tokens",
    fields: [
      { env: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID" },
      { env: "CLOUDFLARE_GATEWAY_ID", label: "Gateway ID" },
    ],
  }),
];

/** OpenAI-compatible endpoints with their usual address: on this computer, and Ollama's cloud. */
export const LOCAL_PRESETS: ReadonlyArray<CavemanProviderInfo> = [
  { id: "ollama-cloud", label: "Ollama Cloud", group: "local", section: "gateways", auth: "optional_key", keyUrl: "https://ollama.com/settings/keys", baseUrl: "https://ollama.com/v1" },
  { id: "ollama", label: "Ollama", group: "local", auth: "optional_key", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio", group: "local", auth: "optional_key", baseUrl: "http://localhost:1234/v1" },
];

/** Caveman credits: turned on from Settings -> Account (W5), listed here so the page shows it. */
export const CREDITS_INFO: CavemanProviderInfo = { id: CREDITS_PROVIDER, label: "Caveman credits", group: "credits", auth: "account" };

/** A compact plan linked through Caveman Cloud (credits.ts): only Cloud stores it, never pasted. */
export const CHATGPT_PLAN_INFO: CavemanProviderInfo = { id: CHATGPT_PLAN_PROVIDER, label: "ChatGPT plan", group: "plan", auth: "account" };

/** pi-ai providers never offered: the legacy compact Codex backend (OpenAI's own Sign in with compact replaced it), and an empty catalog. */
const NEVER = new Set(["openai-codex", "typesafe"]);

/** More providers that are plans billed through their key: their usage counts as the plan's. */
const PLAN_KEYS = new Set(["qwen-token-plan", "qwen-token-plan-cn", "qwen-token-plan-individual", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn", "xiaomi-token-plan-sgp", "zai-coding-cn"]);

/** Endpoints the person adds; their id carries this prefix. */
export const CUSTOM_PREFIX = "custom-";

const catalog = builtinModels();

/** More providers whose pi-ai auth reads settings beside the key (pi-ai's cloudflare-auth). */
const MORE_FIELDS: Readonly<Record<string, ReadonlyArray<ProviderField>>> = {
  "cloudflare-workers-ai": [{ env: "CLOUDFLARE_ACCOUNT_ID", label: "Account ID" }],
};

/** Every pi-ai provider a key can be added for, outside the featured list: "More". */
export const MORE_PROVIDERS: ReadonlyArray<CavemanProviderInfo> = catalog
  .getProviders()
  .filter((p) => !NEVER.has(p.id) && p.auth.apiKey !== undefined && !FEATURED_PROVIDERS.some((f) => f.id === p.id) && p.getModels().length > 0)
  .map(
    (p): CavemanProviderInfo => ({
      id: p.id,
      label: p.name,
      group: "more",
      auth: "key",
      ...(p.auth.apiKey?.name ? { keyLabel: p.auth.apiKey.name } : {}),
      ...(MORE_FIELDS[p.id] ? { fields: MORE_FIELDS[p.id] } : {}),
      ...(PLAN_KEYS.has(p.id) ? { plan: true } : {}),
    }),
  )
  .sort((a, b) => a.label.localeCompare(b.label));

const BY_ID = new Map([...FEATURED_PROVIDERS, ...MORE_PROVIDERS, ...LOCAL_PRESETS, CREDITS_INFO, CHATGPT_PLAN_INFO].map((p) => [p.id, p]));

/** A provider the Caveman engine takes, or undefined for one it never offers. Custom endpoints answer by their own entry. */
/**
 * A provider's further keys: each its own slot, `<provider>~<n>` (n from 2), so it is a source of its own (its
 * models, its tag, its removal) while everything about the provider (label, families, prices) is shared.
 */
export const KEY_SLOT = "~";
/** The provider a key slot belongs to; any other id is its own. */
export const slotProvider = (id: string): string => {
  const at = id.lastIndexOf(KEY_SLOT);
  return at > 0 && /^[2-9]\d*$|^1\d+$/.test(id.slice(at + 1)) && BY_ID.get(id.slice(0, at))?.auth === "key" ? id.slice(0, at) : id;
};

export const providerInfo = (id: string): CavemanProviderInfo | undefined =>
  BY_ID.get(slotProvider(id)) ?? (isCustomProvider(id) ? { id, label: id.slice(CUSTOM_PREFIX.length), group: "custom", auth: "optional_key" } : undefined);

export const isCustomProvider = (id: string) => id.startsWith(CUSTOM_PREFIX) && /^[a-z0-9][a-z0-9-]{0,39}$/.test(id.slice(CUSTOM_PREFIX.length));

/** Whether a key or endpoint for `id` may be stored: a pi-ai provider we offer, a local preset or a custom endpoint. Credits come only from the Account flow. */
export const isAddableProvider = (id: string) => {
  const info = providerInfo(id);
  return info !== undefined && info.group !== "credits" && info.group !== "plan";
};

/** A provider's one-click sign-in, if it has one (a key slot's, its provider's). */
export const signInOf = (id: string): CavemanProviderInfo["signIn"] => providerInfo(id)?.signIn;

/** A plan billed through its key (OpenCode Go, Kimi Code, the token plans). */
export const isPlanKey = (id: string): boolean => providerInfo(id)?.plan === true;

/** Every pinned family, in Models & keys order: what a provider under More lists first. */
const PINNED_FAMILIES = [...new Set(FEATURED_PROVIDERS.flatMap((p) => p.families ?? []))];

/**
 * A provider's current models, in its families' order: each family's newest model that models.dev does not call
 * deprecated (all of them deprecated: the newest anyway, never an empty list). A provider under More goes by every
 * pinned family. Undefined: nothing is set apart (an endpoint, credits, a plan, or a More provider none of whose
 * models is in a pinned family).
 */
export const currentModels = <M extends { readonly id: string }>(provider: string, models: ReadonlyArray<M>): ReadonlyArray<M> | undefined => {
  const info = BY_ID.get(slotProvider(provider));
  const families = info?.families ?? (info?.group === "more" ? PINNED_FAMILIES : undefined);
  if (families === undefined) return undefined;
  const live = newestOfFamilies(models, families, (id) => isDeprecated(slotProvider(provider), id));
  const current = live.length > 0 ? live : newestOfFamilies(models, families);
  return current.length === 0 && info?.families === undefined ? undefined : current;
};

/** A provider's catalog in the order its picker lists it: its current models first, then the rest as the catalog has them. */
export const inListedOrder = <M extends { readonly id: string }>(provider: string, models: ReadonlyArray<M>): Array<M> => {
  const current = currentModels(provider, models) ?? [];
  return [...current, ...models.filter((model) => !current.includes(model))];
};

/** What a pinned family gained on models.dev since the bundled catalog (modelsDev.ts): `provider` is pi-ai's id, never a key slot. */
export const newModels = (provider: string, bundled: ReadonlyArray<Model<Api>>): Array<Model<Api>> => {
  const info = BY_ID.get(provider);
  return info?.families === undefined || info.modelsByAccount === true ? [] : newerModels(bundled, factsFor(provider), info.families);
};

/** Whether `id` came from models.dev rather than the bundled catalog. */
export const isNewModel = (provider: string, id: string): boolean => {
  const own = slotProvider(provider);
  return catalog.getModel(own, id) === undefined && newModels(own, catalog.getModels(own)).some((model) => model.id === id);
};

/** A provider's catalog as the engine runs it: the bundled one and what its families gained since. */
const catalogModels = (provider: string): ReadonlyArray<Model<Api>> => {
  const bundled = catalog.getModels(slotProvider(provider)) as ReadonlyArray<Model<Api>>;
  return [...bundled, ...newModels(slotProvider(provider), bundled)];
};

/** Key-card order: featured first, then More (alphabetical), local, custom, credits. */
export const providerOrder = (id: string): number => {
  const featuredAt = FEATURED_PROVIDERS.findIndex((p) => p.id === slotProvider(id));
  if (featuredAt >= 0) return featuredAt;
  const group = providerInfo(id)?.group;
  return group === "more" ? 100 : group === "local" ? 200 : group === "custom" ? 300 : group === "plan" ? 350 : 400;
};

/**
 * A provider's default model id: an endpoint's first; for a featured provider its default family's newest, else its
 * first current one; else the catalog's first.
 */
export const defaultModelId = (provider: string, endpointModels?: ReadonlyArray<string>): string | undefined => {
  if (endpointModels !== undefined) return endpointModels[0];
  const models = catalogModels(provider);
  const info = BY_ID.get(slotProvider(provider));
  const current = info?.families === undefined ? undefined : currentModels(provider, models);
  const family = info?.defaultFamily;
  return (current?.find((model) => family !== undefined && modelLine(model.id).family === family) ?? current?.[0] ?? models[0])?.id;
};

/**
 * A call's cost at the bundled catalog's public list price (pi-ai's per-million
 * prices), for usage no engine priced: Codex on an API key, and Caveman engine
 * models the SDK's reviewed price table does not have yet. `model` is
 * `provider/id` (credits: `caveman/provider/id`). Undefined with no public
 * price: never a guess.
 */
export const listPriceUsd = (
  model: string,
  tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cacheWrite1h?: number },
  requestInputTokens?: number,
): number | undefined => {
  // A plan's calls are subscription usage: no list price, never dollars.
  if (model.startsWith(`${CHATGPT_PLAN_PROVIDER}/`)) return undefined;
  const bare = model.startsWith(`${CREDITS_PROVIDER}/`) ? model.slice(CREDITS_PROVIDER.length + 1) : model;
  const slash = bare.indexOf("/");
  if (slash < 1) return undefined;
  const provider = slotProvider(bare.slice(0, slash));
  const id = bare.slice(slash + 1);
  const base = (catalog.getModel(provider, id) ?? newModels(provider, catalog.getModels(provider)).find((m) => m.id === id))?.cost;
  if (base === undefined || (base.input === 0 && base.output === 0)) return undefined;
  let cost = base;
  let threshold = -1;
  // Only per-request input can select a tier; a multi-call turn total cannot.
  for (const tier of base.tiers ?? []) {
    if (requestInputTokens !== undefined && requestInputTokens > tier.inputTokensAbove && tier.inputTokensAbove > threshold) {
      cost = tier;
      threshold = tier.inputTokensAbove;
    }
  }
  const write1h = Math.min(tokens.cacheWrite, tokens.cacheWrite1h ?? 0);
  return (tokens.input * cost.input + tokens.output * cost.output + tokens.cacheRead * (cost.cacheRead ?? 0) + (tokens.cacheWrite - write1h) * (cost.cacheWrite ?? cost.input * 1.25) + write1h * cost.input * 2) / 1e6;
};
