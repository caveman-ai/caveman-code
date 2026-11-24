/**
 * What the person connected for the Caveman engine, as the one list Auto and
 * the Chief choose from: every API key on Models &
 * keys, each custom or local endpoint, Caveman credits, and a compact plan
 * linked through Caveman Cloud. Nothing outside it is ever picked: no ambient key, no catalog default
 * for a provider with no credential, no credits behind the person's back.
 *
 * A source is one stored credential slot, so a new kind of connection (a
 * second account of a provider, a subscription reached through its own
 * official harness) is one more slot here, not another resolver.
 *
 * @module provider-caveman/server/connected
 */
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";

import type { CavemanKeys } from "./credentials.ts";
import { CHATGPT_PLAN_PROVIDER, CREDITS_PROVIDER, accountSlug } from "./credits.ts";
import { currentModels, providerInfo, providerOrder } from "./providers.ts";

export type ConnectedKind = "key" | "endpoint" | "credits" | "plan" | "login";

export interface ConnectedSource {
  /**
 * The credential slot: a pi-ai provider id, `custom-*`, `ollama`, `lmstudio`, `caveman` (credits) or `compact`
 * (plan); a login, its engine account id (one per Claude or compact login).
   */
  readonly id: string;
  readonly kind: ConnectedKind;
  /** A login's harness (`claude-agent`, `codex`), which runs its models; absent, the Caveman engine does. */
  readonly engine?: string;
 /** Picker ids (`provider/model`; credits `caveman/provider/model`, plan `compact/provider/model`; a login, its harness's model ids), best first. */
  readonly models: ReadonlyArray<string>;
}

/**
 * A subscription login signed in with its harness's own CLI, in a config folder of its own (a Claude plan, a
 * compact login for Codex): that harness runs it, so it never joins the Caveman engine's own models.
 */
export interface HarnessLogin {
  readonly engine: string;
  /** Its engine account id (EngineAccount.id). */
  readonly account: string;
  readonly models: ReadonlyArray<string>;
}

/** Models a source with no families of its own contributes, so one big catalog cannot crowd out the rest. */
const UNPINNED_MAX = 8;

const kindOf = (id: string, keys: CavemanKeys): ConnectedKind =>
  id === CREDITS_PROVIDER ? "credits" : id === CHATGPT_PLAN_PROVIDER ? "plan" : keys[id]?.endpoint !== undefined ? "endpoint" : "key";

/** One source's models the engine can run now: its current ones (providers.ts), best first. */
function sourceModels(id: string, keys: CavemanKeys, models: MutableModels): ReadonlyArray<string> {
  const endpoint = keys[id]?.endpoint;
  if (endpoint !== undefined) return endpoint.models.filter((model) => models.getModel(id, model) !== undefined).map((model) => `${id}/${model}`);
  const catalog = models.getModels(id) as ReadonlyArray<Model<Api>>;
  if (kindOf(id, keys) !== "key") return catalog.map((model) => accountSlug(id, model));
  const picked = currentModels(id, catalog) ?? catalog;
  return (providerInfo(id)?.families === undefined ? picked.slice(0, UNPINNED_MAX) : picked).map((model) => `${id}/${model.id}`);
}

/** Every connected source with at least one model it can run, in Models & keys order, then each harness login. */
export function connectedSources(keys: CavemanKeys, models: MutableModels, logins: ReadonlyArray<HarnessLogin> = []): ReadonlyArray<ConnectedSource> {
  const own = Object.keys(keys)
    .filter((id) => providerInfo(id) !== undefined)
    .sort((a, b) => providerOrder(a) - providerOrder(b) || a.localeCompare(b))
    .flatMap((id) => {
      const list = sourceModels(id, keys, models);
      return list.length === 0 ? [] : [{ id, kind: kindOf(id, keys), models: list }];
    });
  return [...own, ...logins.flatMap((login) => (login.models.length === 0 ? [] : [{ id: login.account, kind: "login" as const, engine: login.engine, models: login.models }]))];
}

/** The models the Caveman engine's Auto routes among and the Chief may run it on: exactly the connected ones. */
export const connectedModels = (keys: CavemanKeys, models: MutableModels): ReadonlyArray<string> =>
  connectedSources(keys, models).flatMap((source) => source.models);

/** The source a picker id belongs to (`caveman/…` credits, `compact/…` plan, else its provider). */
export const sourceOf = (model: string): string => model.slice(0, model.indexOf("/"));

/** Said when nothing is connected: never a silent fallback to a model that is not. */
export const NOTHING_CONNECTED =
  "Auto has nothing to run on: connect an API key, an endpoint or Caveman credits in Settings → Models & keys.";
