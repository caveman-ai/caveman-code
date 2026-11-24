/**
 * The model endpoint of `caveman-runtime agent exec`: one base URL and one key, from CAVEMAN_MODEL_BASE_URL and
 * CAVEMAN_MODEL_API_KEY (platform CONTRACT §8.1), never the keychain-sealed store the app reads, and never an
 * ambient key: the catalog is authenticated with exactly that one key (credentials.ts cavemanModels), so a stray
 * OPENAI_API_KEY still never pays.
 *
 * The endpoint's family decides the wire. A provider's own API (api.anthropic.com, api.openai.com, external tools.ai), or
 * a proxy that CAVEMAN_MODEL_PROVIDER names, speaks that provider's own wire (Anthropic Messages, OpenAI Responses,
 * external tools's), with the catalog's model records: priced, with their context windows and effort levels. Any other
 * endpoint (Caveman Cloud's gateway, the credential broker, a local server) is OpenAI-compatible Chat Completions and
 * gets the model id exactly as given.
 *
 * @module provider-caveman/server/execModels
 */
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as Effect from "effect/Effect";

import { resolveCavemanModel } from "./autoModel.ts";
import { cavemanModels, type CavemanKeys } from "./credentials.ts";
import { inListedOrder, listPriceUsd } from "./providers.ts";

export const ENDPOINT_FAMILIES = ["anthropic", "openai", "openrouter"] as const;
export type EndpointFamily = (typeof ENDPOINT_FAMILIES)[number];

/** The provider id an endpoint of unknown family runs under: `endpoint/<the model id as given>`. */
export const ENDPOINT_PROVIDER = "endpoint";

/** Each family's own API host. */
const OWN_HOSTS: Readonly<Record<string, EndpointFamily>> = { "api.anthropic.com": "anthropic", "api.openai.com": "openai", "openrouter.ai": "openrouter" };

/** A base URL that is http(s), with no credentials in it; else why not. */
export function parseBaseUrl(raw: string): URL | string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `CAVEMAN_MODEL_BASE_URL is not a URL: ${JSON.stringify(raw.slice(0, 200))}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "CAVEMAN_MODEL_BASE_URL must be http or https";
  if (url.username !== "" || url.password !== "") return "CAVEMAN_MODEL_BASE_URL must not carry credentials; the key goes in CAVEMAN_MODEL_API_KEY";
  return url;
}

/**
 * The family an endpoint speaks: the one CAVEMAN_MODEL_PROVIDER states, else the family whose own API host it is.
 * Undefined: an endpoint of unknown family (a gateway or proxy), OpenAI-compatible Chat Completions. A string: why the
 * stated family is not one.
 */
export function endpointFamily(url: URL, stated: string | undefined): EndpointFamily | undefined | { readonly error: string } {
  if (stated !== undefined && stated.trim() !== "") {
    const family = stated.trim().toLowerCase();
    return (ENDPOINT_FAMILIES as ReadonlyArray<string>).includes(family)
      ? (family as EndpointFamily)
      : { error: `CAVEMAN_MODEL_PROVIDER is ${JSON.stringify(stated)}; use ${ENDPOINT_FAMILIES.join(", ")}, or leave it unset for an OpenAI-compatible endpoint` };
  }
  return OWN_HOSTS[url.hostname];
}

/** A family's models as the app lists them (curated first), `provider/id` each: what model classes resolve within. */
export function familySlugs(family: EndpointFamily): ReadonlyArray<string> {
  return inListedOrder(family, builtinModels().getModels(family)).map((model) => `${family}/${model.id}`);
}

/** The engine's own `auto` on a family (the model a key of that provider runs on when nobody picked one). */
export const familyAutoModel = (family: EndpointFamily): string | undefined =>
  resolveCavemanModel("auto", { [family]: { key: "-" } } satisfies CavemanKeys) ?? undefined;

/** What the engine runs at the endpoint. */
export interface ExecModel {
  /** `provider/id` the engine runs: a catalog model, or `endpoint/<as given>`. */
  readonly model: string;
  /** The model as resolved, for the caller to see: the catalog slug, or the id as given. */
  readonly shown: string;
  /** Its record in `models` (priced when the catalog prices it), pointed at the endpoint. */
  readonly record: Model<Api> | undefined;
  /** The catalog, authenticated with the endpoint's one key and pointed at its URL. */
  readonly models: Models;
  /** A call's list price when the engine could not price it (`endpoint/...` calls): from the id as given, when the catalog knows it. */
  readonly listPrice: (tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }) => number | undefined;
}

/**
 * The model at the endpoint, or why it cannot run there. `model` is resolved already (a class or `auto` became a
 * catalog slug in the runtime's one resolver): a `provider/id` of the endpoint's family, a bare id of it, or (at an
 * endpoint of unknown family) any id, sent as given.
 */
export async function execModel(input: {
  readonly url: URL;
  readonly apiKey: string;
  readonly family: EndpointFamily | undefined;
  readonly model: string;
}): Promise<ExecModel | { readonly error: string }> {
  const { url, apiKey, family } = input;
  if (family === undefined) {
    const keys: CavemanKeys = { [ENDPOINT_PROVIDER]: { key: apiKey, endpoint: { name: "endpoint", baseUrl: url.toString().replace(/\/+$/, ""), models: [input.model] } } };
    const models = await Effect.runPromise(cavemanModels(keys));
    return {
      model: `${ENDPOINT_PROVIDER}/${input.model}`,
      shown: input.model,
      record: models.getModel(ENDPOINT_PROVIDER as never, input.model as never) as Model<Api> | undefined,
      models,
      listPrice: (tokens) => listPriceUsd(input.model, tokens),
    };
  }
  const slash = input.model.indexOf("/");
  const named = slash > 0 ? input.model.slice(0, slash) : family;
  const id = slash > 0 ? input.model.slice(slash + 1) : input.model;
  if (named !== family) {
    return { error: `--model ${input.model} is a ${named} model, but the endpoint speaks ${family}; pass a ${family}/<model>, or point CAVEMAN_MODEL_BASE_URL at a ${named} endpoint` };
  }
  const catalog = await Effect.runPromise(cavemanModels({ [family]: { key: apiKey } }));
  const listed = catalog.getModel(family as never, id as never) as Model<Api> | undefined;
  if (listed === undefined) return { error: `${family}/${id} is not a model the Caveman engine knows; pass one of ${familySlugs(family).slice(0, 6).join(", ")}, ...` };
  // The provider's own API keeps the catalog's URLs (they know its paths); a proxy of that family gets the given one.
  const own = new URL(listed.baseUrl).origin === url.origin;
  const models = own ? catalog : modelsAtBaseUrl(catalog, family, url);
  return {
    model: `${family}/${id}`,
    shown: `${family}/${id}`,
    record: models.getModel(family, id),
    models,
    listPrice: (tokens) => listPriceUsd(`${family}/${id}`, tokens),
  };
}

/**
 * The catalog with every model of `provider` pointed at `url` (a proxy of that family): the same records, wire and
 * key, requests to the given base URL. Every other provider's models are as they were.
 */
export function modelsAtBaseUrl(source: Models, provider: string, url: URL): Models {
  const baseUrl = url.toString().replace(/\/+$/u, "");
  const rewrite = <M extends Model<Api> | undefined>(model: M): M => (model !== undefined && model.provider === provider ? { ...model, baseUrl } : model);
  return new Proxy(source, {
    get(target, property) {
      if (property === "getModel") return (selected: string, id: string) => rewrite(target.getModel(selected, id));
      if (property === "getModels") return (selected?: string) => target.getModels(selected).map((model) => rewrite(model));
      if (property === "getAvailable") return async (...args: Parameters<Models["getAvailable"]>) => (await target.getAvailable(...args)).map((model) => rewrite(model));
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: Array<unknown>) => unknown).bind(target) : value;
    },
  });
}
