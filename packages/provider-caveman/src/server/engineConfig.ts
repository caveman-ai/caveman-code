/**
 * The Caveman engine's effort: what a turn sends when the person picked none, and the composer's levels for a model,
 * from the pi-ai catalog. Every app session (adapter.ts), the model picker (driver.ts) and the connector runner read
 * them, so the effort a person sees is the one the harness sends.
 *
 * @module provider-caveman/server/engineConfig
 */
import type { AnthropicMessagesCompat, Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";

import { slotProvider } from "./providers.ts";

/**
 * Providers whose Responses API runs a request that names no effort at medium: OpenAI's own (measured 2026-10-17
 * on gpt-6-luna, gpt-6-sol, gpt-6.1-sol, gpt-5.5); Caveman credits' OpenAI models, which the gateway forwards to it,
 * and Azure OpenAI, which serves the same models (both inferred, not measured).
 */
const MEDIUM_BY_DEFAULT = new Set(["openai", "caveman-openai", "chatgpt-openai", "azure"]);
const RESPONSES_APIS = new Set(["openai-responses", "azure-openai-responses"]);

/**
 * The effort a turn sends when the person picked none, so the composer shows (and sends) what an untouched turn
 * runs at. OpenAI's Responses models get the API's own default, medium, said explicitly so pi-ai also asks for the
 * encrypted reasoning that carries it across calls. Anthropic's managed-effort models get their API's default, high,
 * said explicitly too: since pi-ai 1.3.0 a request with no level turns thinking off, and an explicit level sends
 * adaptive thinking with top-level effort pinned high plus the effort-only system message, the form in which a later
 * per-message effort change keeps the cache. Everywhere else, the level that sends the same request as no level at
 * all: off where the model can think not at all (pi treats no level as off). Undefined: what a request with no level runs at is the
 * provider's own default, unmeasured (Google, Bedrock, most OpenAI-compatible endpoints), so the model offers no
 * effort control and the turn sends none.
 */
export const defaultEffort = (model: Model<Api>): ModelThinkingLevel | undefined => {
  if (!model.reasoning) return undefined;
  if (MEDIUM_BY_DEFAULT.has(slotProvider(model.provider)) && RESPONSES_APIS.has(model.api)) return clampThinkingLevel(model, "medium");
  if (model.api === "anthropic-messages" && (model.compat as AnthropicMessagesCompat | undefined)?.supportsMidConvoEffort === true) return clampThinkingLevel(model, "high");
  if (getSupportedThinkingLevels(model).includes("off")) return "off";
 // external tools's reasoning models that cannot think not at all (GLM 5.3): no level sends no `reasoning`, and the
  // model's own default runs, which can be its most expensive. Say high explicitly, as the bench measures them.
  return (model.compat as { thinkingFormat?: string } | undefined)?.thinkingFormat === "openrouter" ? clampThinkingLevel(model, "high") : undefined;
};

/**
 * The composer's effort ids for a model, from the catalog's reasoning levels; pi-ai's "off" is "none", as Codex
 * names it. None for a model with no known default (defaultEffort): the composer always sends a level it shows.
 */
export const effortIds = (model: Model<Api>): ReadonlyArray<string> =>
  defaultEffort(model) === undefined ? [] : getSupportedThinkingLevels(model).map((level) => (level === "off" ? "none" : level));

/** A composer effort id as the engine's level; undefined for an id the model does not offer. */
export const effortLevel = (model: Model<Api>, id: string | undefined): ModelThinkingLevel | undefined =>
  id !== undefined && effortIds(model).includes(id) ? ((id === "none" ? "off" : id) as ModelThinkingLevel) : undefined;
