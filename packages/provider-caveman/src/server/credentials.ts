/**
 * API keys and sign-ins for the Caveman engine. They live in the runtime's secret store
 * (`ProviderHost.credentials("caveman", instanceId)`), one JSON blob per
 * instance, sealed by the runtime with a key held in the OS keychain, never in
 * `~/.claude`, `~/.codex`, Pi's auth file or the process environment. The
 * engine sees them through a pi-ai `Models` whose credential store holds
 * exactly these keys and whose ambient context is empty, so an
 * `OPENAI_API_KEY` in the runtime's own environment can never pay for a turn.
 * A sign-in's tokens (Sign in with compact) rotate: every Models refreshes
 * them against the stored entry, one refresh at a time, and stores them back.
 *
 * @module provider-caveman/server/credentials
 */
import type { ProviderInstanceId } from "@caveman-app/protocol";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import {
  InMemoryCredentialStore,
  type Api,
  type AuthContext,
  type AuthOperationOptions,
  type Credential as PiCredential,
  type Model,
  type MutableModels,
  type OAuthCredential,
  type OAuthCredentials,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { createProvider, type Provider } from "@earendil-works/pi-ai/models";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../package.json" with { type: "json" };
import { CHATGPT_PLAN_PROVIDER, CREDITS_PROVIDER, gatewayOf, withChatGptPlan, withCredits } from "./credits.ts";
import { withModels } from "./modelsDev.ts";
import { isPlanKey, newModels, providerInfo, signInOf, slotProvider } from "./providers.ts";

/** An OpenAI-compatible endpoint the person added (custom-*, Ollama, LM Studio). */
export interface CavemanEndpoint {
  readonly name: string;
  readonly baseUrl: string;
  readonly models: ReadonlyArray<string>;
}

/** A subscription sign-in's tokens as pi-ai's OAuth flow returns them (access, refresh, expiry, and the flow's own fields). */
export type CavemanSignIn = Readonly<OAuthCredentials>;

/** One provider's stored credential. */
export interface CavemanCredential {
  /** The secret: an API key. Absent for a keyless local endpoint or a sign-in. */
  readonly key?: string;
  /** Non-secret settings (a region, an Azure resource) handed to pi-ai as the credential's env. */
  readonly env?: Readonly<Record<string, string>>;
  readonly endpoint?: CavemanEndpoint;
 /** A subscription sign-in in place of a key (Sign in with compact): its usage is on the plan. */
  readonly oauth?: CavemanSignIn;
  /** Caveman credits and a linked plan: the gateway of the Cloud that minted the key; absent for the hosted Cloud's (credits.ts gatewayOf). */
  readonly gateway?: string;
  /**
   * A Cloud computer's credits key (ProviderHost.credits): the one its runtime holds now and its gateway, read for every
   * request (asking Cloud only when none is held), so a turn that outlives the key it started with goes on with the
   * renewed one. Never stored; `key` is the one held when the slot was read, empty before the first request.
   */
  readonly live?: () => Promise<{ readonly key: string; readonly gateway?: string } | undefined>;
}

/** Provider id -> credential: pi-ai ids, custom-*, ollama, lmstudio, `caveman` (credits) and `compact` (a linked plan), see credits.ts. */
export type CavemanKeys = Readonly<Record<string, CavemanCredential>>;

/** A provider id: a key slot's name, checked against the registry (providers.ts) wherever one is stored. */
export type CavemanKeyProvider = string;

const Endpoint = Schema.Struct({ name: Schema.String, baseUrl: Schema.String, models: Schema.Array(Schema.String) });
const SignIn = Schema.StructWithRest(Schema.Struct({ access: Schema.String, refresh: Schema.String, expires: Schema.Number }), [
  Schema.Record(Schema.String, Schema.Json),
]);
const Credential = Schema.Struct({
  key: Schema.optionalKey(Schema.String),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  endpoint: Schema.optionalKey(Endpoint),
  oauth: Schema.optionalKey(SignIn),
  gateway: Schema.optionalKey(Schema.String),
});
const StoredKeys = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ version: Schema.Literal(1), keys: Schema.Record(Schema.String, Schema.String) }),
    Schema.Struct({ version: Schema.Literal(2), providers: Schema.Record(Schema.String, Credential) }),
  ]),
);
const decodeStoredKeys = Schema.decodeUnknownEffect(StoredKeys);
const encodeStoredKeys = Schema.encodeEffect(StoredKeys);

const usable = (c: CavemanCredential) => (c.key !== undefined && c.key.trim() !== "") || c.endpoint !== undefined || c.oauth !== undefined;

/** Whether a provider's usage is on a subscription plan (a sign-in, or a plan's key) rather than paid per token. */
export const onPlan = (provider: string, credential: CavemanCredential | undefined): boolean =>
  credential !== undefined && (credential.oauth !== undefined || isPlanKey(provider));

/**
 * The providers whose calls are on the person's plan in a run on `model`, named as a run's receipt names them: a key
 * slot's calls go out, and are recorded, under its provider (`openai~2` as `openai`). A provider is on a plan when all
 * its slots are; the run's own slot decides for its provider, so a compact sign-in beside an OpenAI key is told apart.
 */
export const planProvidersFor = (keys: CavemanKeys, model: string): ReadonlySet<string> => {
  const slots = new Map<string, Array<boolean>>();
  for (const [slot, credential] of Object.entries(keys)) slots.set(slotProvider(slot), [...(slots.get(slotProvider(slot)) ?? []), onPlan(slot, credential)]);
  const plan = new Set([...slots].flatMap(([provider, onPlans]) => (onPlans.every(Boolean) ? [provider] : [])));
  const slot = model.slice(0, Math.max(0, model.indexOf("/")));
  if (keys[slot] !== undefined) {
    if (onPlan(slot, keys[slot])) plan.add(slotProvider(slot));
    else plan.delete(slotProvider(slot));
  }
  return plan;
};

/** Every stored entry, providers the registry no longer offers included. A damaged blob reads as none; a v1 blob (key strings) as keys. */
const readStored = Effect.fnUntraced(function* (credentials: ProviderHost.ProviderCredentials) {
  const stored = yield* credentials.get;
  if (Option.isNone(stored)) return {} as Record<string, CavemanCredential>;
  const decoded = yield* decodeStoredKeys(new TextDecoder().decode(stored.value)).pipe(Effect.option);
  if (Option.isNone(decoded)) return {} as Record<string, CavemanCredential>;
  return decoded.value.version === 1
    ? Object.fromEntries(Object.entries(decoded.value.keys).map(([provider, key]) => [provider, { key } as CavemanCredential]))
    : { ...(decoded.value.providers as Record<string, CavemanCredential>) };
});

/**
 * Stored keys for an instance, for providers the registry offers; a damaged blob reads as no keys, never as a crash.
 * On a Cloud computer, with no credits key stored, the credits slot is the one its runtime holds for the computer's
 * person (ProviderHost.credits), offered while credits may pay there: reading it asks Cloud for nothing (the key held,
 * if any, and where it runs); a request reads it again through `live`, which asks for one only when none is held.
 */
export const readCavemanKeys = Effect.fn("readCavemanKeys")(function* (instanceId: ProviderInstanceId) {
  const host = yield* ProviderHost.ProviderHost;
  // Where the person's credentials stay outside the computer (ProviderHost.connections) no key is stored or read
  // here: each provider they connected a key for is a slot whose key is a stand-in. While Cloud cannot say, none.
  const outside = host.connections === undefined ? undefined : yield* Effect.promise(() => host.connections!.keys().catch(() => []));
  const entries: Record<string, CavemanCredential> =
    outside === undefined ? yield* readStored(yield* host.credentials("caveman", instanceId)) : Object.fromEntries(outside.map(({ provider, key }) => [provider, { key }]));
  const keys: Record<string, CavemanCredential> = {};
  for (const [provider, credential] of Object.entries(entries)) {
    if (providerInfo(provider) === undefined || !usable(credential)) continue;
    // Tokens only for a provider whose sign-in we offer for a plan (never claude.ai's); a sign-in-only provider takes nothing else.
    if (credential.oauth !== undefined ? signInOf(provider)?.plan === undefined : providerInfo(provider)?.signInOnly === true) continue;
    keys[provider] = credential.key === undefined ? credential : { ...credential, key: credential.key.trim() };
  }
  const source = host.credits;
  if (keys[CREDITS_PROVIDER] === undefined && source !== undefined && source.available()) {
    const held = source.peek();
    keys[CREDITS_PROVIDER] = {
      key: held?.key.trim() ?? "",
      ...(held?.gateway === undefined ? {} : { gateway: held.gateway }),
      live: () => source.get().then((now) => (now !== undefined && now.key.trim() !== "" ? { ...now, key: now.key.trim() } : undefined), () => undefined),
    };
  }
  return keys as CavemanKeys;
});

/** Writes to the blob one at a time: a key added in Settings never loses a sign-in's refreshed tokens, or the reverse. */
const writes = Semaphore.makeUnsafe(1);

/**
 * Read, change and store one provider's credential. `change` gets the stored one and returns the next,
 * `null` to remove it, or `undefined` to leave the blob as it is.
 */
export const updateCavemanCredential = Effect.fn("updateCavemanCredential")(function* (
  instanceId: ProviderInstanceId,
  provider: CavemanKeyProvider,
  change: (current: CavemanCredential | undefined) => CavemanCredential | null | undefined,
) {
  const credentials = yield* (yield* ProviderHost.ProviderHost).credentials("caveman", instanceId);
  yield* writes.withPermits(1)(
    Effect.gen(function* () {
      // From the whole blob: a provider a pi-ai upgrade dropped or renamed keeps its key, only hidden from listings.
      const current: Record<string, CavemanCredential> = yield* readStored(credentials);
      const next = change(current[provider]);
      if (next === undefined) return;
      if (next === null || !usable(next)) delete current[provider];
      else current[provider] = next;
      if (Object.keys(current).length === 0) return yield* credentials.remove;
      const encoded = yield* encodeStoredKeys({ version: 2, providers: current as Record<string, typeof Credential.Type> }).pipe(Effect.orDie);
      yield* credentials.set(new TextEncoder().encode(encoded));
    }),
  );
});

/** Store (or, with `null`, remove) one provider's credential; a string is a bare key. Settings call this; turns only read. */
export const setCavemanKey = (instanceId: ProviderInstanceId, provider: CavemanKeyProvider, credential: CavemanCredential | string | null) =>
  updateCavemanCredential(instanceId, provider, () => (typeof credential === "string" ? { key: credential.trim() } : credential));

/** Every secret in `keys`, for redaction and the egress scrub. */
export const cavemanSecrets = (keys: CavemanKeys): ReadonlyArray<string> =>
  Object.values(keys).flatMap((c) => [...(c.key ? [c.key] : []), ...(c.oauth ? [c.oauth.access, c.oauth.refresh] : [])]);

/** A blob's stored sign-ins, for the Models that refresh them. */
export interface StoredSignIns {
  /** The blob: Models of instances that share one share its refreshes. */
  readonly scope: string;
  readonly read: (provider: string) => Promise<CavemanSignIn | undefined>;
  /** Stores `next` while the entry still holds the tokens it was refreshed from: a new sign-in meanwhile wins. */
  readonly write: (provider: string, from: CavemanSignIn, next: CavemanSignIn) => Promise<void>;
}

/** The instance's stored sign-ins, read and written through the runtime's secret store. */
export const storedSignIns = Effect.fn("storedSignIns")(function* (instanceId: ProviderInstanceId) {
  const host = yield* ProviderHost.ProviderHost;
  const credentials = yield* host.credentials("caveman", instanceId);
  const run = <A, E>(effect: Effect.Effect<A, E, ProviderHost.ProviderHost>) => Effect.runPromise(effect.pipe(Effect.provideService(ProviderHost.ProviderHost, host)));
  return {
    scope: credentials.binding.key,
    read: (provider) => run(readStored(credentials)).then((all) => all[provider]?.oauth),
    write: (provider, from, next) =>
      run(updateCavemanCredential(instanceId, provider, (current) => (current?.oauth?.refresh === from.refresh ? { ...current, oauth: next } : undefined))),
  } satisfies StoredSignIns;
});

/** One refresh at a time per stored sign-in, across every Models in this process: a rotated refresh token is never spent twice. */
const refreshes = new Map<string, Promise<unknown>>();
const oneAtATime = <A>(key: string, task: () => Promise<A>): Promise<A> => {
  const run = (refreshes.get(key) ?? Promise.resolve()).then(task);
  const tail = run.catch(() => undefined);
  refreshes.set(key, tail);
  void tail.then(() => refreshes.get(key) === tail && refreshes.delete(key));
  return run;
};

const tokensOf = ({ type: _type, ...tokens }: OAuthCredential): CavemanSignIn => tokens;

/**
 * One Models' credentials: keys in memory; a sign-in refreshed from the stored entry, which another
 * session may have rotated since this one read it, and stored back.
 */
class SignedInStore extends InMemoryCredentialStore {
  readonly #stored: StoredSignIns | undefined;

  constructor(stored: StoredSignIns | undefined) {
    super();
    this.#stored = stored;
  }

  override modify(providerId: string, fn: (current: PiCredential | undefined) => Promise<PiCredential | undefined>, options?: AuthOperationOptions) {
    const stored = this.#stored;
    return super.modify(
      providerId,
      async (current) => {
        if (stored === undefined || current?.type !== "oauth") return fn(current);
        return oneAtATime(`${stored.scope}/${providerId}`, async () => {
          const latest = (await stored.read(providerId)) ?? tokensOf(current);
          const from: OAuthCredential = { ...latest, type: "oauth" };
          const next = await fn(from);
          if (next?.type === "oauth") await stored.write(providerId, latest, tokensOf(next));
          return next ?? (latest.access === current.access ? undefined : from);
        });
      },
      options,
    );
  }
}

/** No environment variables, no credential files: only the stored keys count. */
const NO_AMBIENT_AUTH: AuthContext = {
  env: async () => undefined,
  fileExists: async () => false,
};

/**
 * A Chat Completions payload whose function parameters are all plain objects at the root. OpenAI's Chat Completions
 * refuses any other root (400 invalid_function_parameters: "schema must have type 'object' and not have
 * 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the top level"), while the Responses API takes the engine's bash as
 * it is: with command sessions its input is a union of objects (`anyOf`). Here such a union goes out as one object:
 * every branch's properties (a property several branches pin to a `const` becomes their `enum`), only what every
 * branch requires as required, and the forms, by what each one requires, in the description. The engine still
 * checks each call against the union it declared. Found live 2026-10-19: on an OpenAI-compatible endpoint every
 * Caveman-engine turn failed at its first request. Payloads of another shape, and object roots, go as they came.
 */
export const objectRootTools = (payload: unknown): unknown => {
  const tools = (payload as { tools?: unknown } | null)?.tools;
  if (!Array.isArray(tools)) return payload;
  let changed = false;
  const fixed = tools.map((tool: { type?: unknown; function?: { parameters?: Record<string, unknown> } }) => {
    const parameters = tool?.type === "function" ? tool.function?.parameters : undefined;
    const flat = parameters === undefined ? undefined : flatObjectRoot(parameters);
    if (flat === undefined) return tool;
    changed = true;
    return { ...tool, function: { ...tool.function, parameters: flat } };
  });
  return changed ? { ...(payload as object), tools: fixed } : payload;
};

type JsonSchema = Record<string, unknown>;

/** A root `anyOf`/`oneOf` of objects as one object schema; undefined for any other root (left as it is). */
const flatObjectRoot = (parameters: JsonSchema): JsonSchema | undefined => {
  const branches = (parameters.anyOf ?? parameters.oneOf) as ReadonlyArray<JsonSchema> | undefined;
  if (!Array.isArray(branches) || branches.length === 0 || Object.keys(parameters).some((key) => key !== "anyOf" && key !== "oneOf" && key !== "description" && key !== "type")) return undefined;
  if (!branches.every((branch) => branch?.type === "object" && (branch.properties === undefined || typeof branch.properties === "object"))) return undefined;
  const properties: Record<string, JsonSchema> = {};
  for (const branch of branches) {
    for (const [name, schema] of Object.entries((branch.properties ?? {}) as Record<string, JsonSchema>)) {
      const seen = properties[name];
      if (seen === undefined) properties[name] = schema;
      else if (JSON.stringify(seen) === JSON.stringify(schema)) continue;
      else if ("const" in schema && ("const" in seen || Array.isArray(seen.enum)) && seen.type === schema.type) {
        const { const: first, ...rest } = seen;
        properties[name] = { ...rest, enum: [...(Array.isArray(seen.enum) ? seen.enum : [first]), schema.const] };
      } else properties[name] = { anyOf: [...(Array.isArray(seen.anyOf) && Object.keys(seen).length === 1 ? (seen.anyOf as Array<JsonSchema>) : [seen]), schema] };
    }
  }
  const requiredOf = (branch: JsonSchema) => (Array.isArray(branch.required) ? (branch.required as Array<string>) : []);
  const required = requiredOf(branches[0]!).filter((name) => branches.every((branch) => requiredOf(branch).includes(name)));
  const form = (branch: JsonSchema) => {
    const consts = Object.entries((branch.properties ?? {}) as Record<string, JsonSchema>).filter(([, schema]) => "const" in schema);
    const fields = requiredOf(branch).map((name) => {
      const pinned = consts.find(([key]) => key === name);
      return pinned === undefined ? name : `${name}: ${JSON.stringify(pinned[1].const)}`;
    });
    return `{${fields.join(", ")}}`;
  };
  const forms = `Use exactly one of these forms (required fields): ${branches.map(form).join("; ")}.`;
  return {
    type: "object",
    description: typeof parameters.description === "string" ? `${parameters.description} ${forms}` : forms,
    properties,
    ...(required.length === 0 ? {} : { required }),
  };
};

/**
 * `provider` with objectRootTools applied to every payload before the caller's own onPayload sees it, so what the
 * engine records as sent (its cache warmer, its journal) is what left.
 */
const withObjectRootTools = (provider: Provider): Provider => {
  type Hook = ((payload: unknown, model: never) => unknown) | undefined;
  const hooked = <O extends { onPayload?: Hook } | undefined>(options: O): O =>
    ({
      ...options,
      onPayload: async (payload: unknown, model: never) => {
        const fixed = objectRootTools(payload);
        const replaced = await options?.onPayload?.(fixed, model);
        return replaced ?? (fixed === payload ? undefined : fixed);
      },
    }) as O;
  const stream: Provider["stream"] = (model, context, options) => provider.stream(model, context, hooked(options as never));
  const streamSimple: Provider["streamSimple"] = (model, context, options) => provider.streamSimple(model, context, hooked(options as never));
  // A proxy, not a copy: a provider may keep its methods on a prototype or read its own state through `this`.
  return new Proxy(provider, {
    get(target, property) {
      if (property === "stream") return stream;
      if (property === "streamSimple") return streamSimple;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/** Every provider whose models speak Chat Completions, with objectRootTools on its payloads (custom endpoints, credits' and external tools's routes, DeepSeek, ...). */
const objectRootsOnCompletions = (models: MutableModels): MutableModels => {
  for (const provider of models.getProviders()) {
    if (provider.getModels().some((model) => model.api === "openai-completions")) models.setProvider(withObjectRootTools(provider));
  }
  return models;
};

/** An endpoint's models: chat over OpenAI's completions wire, unpriced (spend says so). */
const endpointProvider = (id: string, endpoint: CavemanEndpoint, key: string | undefined) => {
  const baseUrl = endpoint.baseUrl.replace(/\/+$/, "");
  const models = endpoint.models.map(
    (modelId): Model<Api> =>
      ({
        id: modelId,
        name: modelId,
        api: "openai-completions",
        provider: id,
        baseUrl,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
      }) as Model<Api>,
  );
  return createProvider({
    id,
    name: endpoint.name,
    baseUrl,
    // A keyless local server still gets a bearer value on the wire; it ignores it.
    auth: { apiKey: { name: `${endpoint.name} key`, resolve: async () => ({ auth: { apiKey: key ?? "none" }, source: "Caveman Code" }) } },
    models,
    api: openAICompletionsApi(),
  });
};

/**
 * A provider's further key as a provider of its own (`openai~2`): the same models and wire, its own credential
 * (stored under the slot's id) and its own picker ids. Requests go out as the provider's own, so nothing that
 * keys on the provider id (compat flags, headers) sees the slot.
 */
const keySlotProvider = (slot: string, base: Provider): Provider => {
  const asBase = <M extends Model<Api>>(model: M): M => ({ ...model, provider: base.id });
  return {
    id: slot,
    name: base.name,
    ...(base.baseUrl === undefined ? {} : { baseUrl: base.baseUrl }),
    ...(base.headers === undefined ? {} : { headers: base.headers }),
    auth: base.auth,
    getModels: () => base.getModels().map((model) => ({ ...model, provider: slot })),
    stream: (model, context, options) => base.stream(asBase(model), context, options),
    streamSimple: (model, context, options) => base.streamSimple(asBase(model), context, options),
  };
};

/**
 * The engine's model catalog, authenticated with exactly `keys` (Caveman credits and endpoints on providers of their own).
 * With `stored`, a sign-in's refreshed tokens are stored back; without it (a credential tested before it is kept) they live
 * only in this Models.
 */
export const cavemanModels = (keys: CavemanKeys, stored?: StoredSignIns): Effect.Effect<MutableModels> =>
  Effect.promise(async () => {
    const credentials = new SignedInStore(stored);
    for (const [provider, credential] of Object.entries(keys)) {
      if (provider === CREDITS_PROVIDER || provider === CHATGPT_PLAN_PROVIDER || credential.endpoint !== undefined) continue;
      if (credential.oauth !== undefined) await credentials.modify(provider, async () => ({ ...credential.oauth!, type: "oauth" }));
      else if (credential.key !== undefined) {
        await credentials.modify(provider, async () => ({ type: "api_key", key: credential.key!, ...(credential.env ? { env: { ...credential.env } } : {}) }));
      }
    }
    const models = builtinModels({ credentials, authContext: NO_AMBIENT_AUTH });
    // A version models.dev lists that this build's catalog does not yet runs on its family's wire (modelsDev.ts).
    for (const provider of models.getProviders()) {
      const added = newModels(provider.id, provider.getModels());
      if (added.length > 0) models.setProvider(withModels(provider, added));
    }
 // Keys and the registry's plan sign-ins only (compact, GitHub Copilot, SuperGrok): every other pi-ai OAuth is
 // stripped, so pi-ai's Claude Pro/Max OAuth (Claude Code's client id) and the legacy compact Codex login are
    // unreachable from any turn or the Chief. A Claude plan runs only through Claude Code itself (Claude Agent).
    for (const provider of models.getProviders()) {
      if (provider.auth.oauth === undefined || signInOf(provider.id)?.plan !== undefined) continue;
      const { oauth: _subscription, ...keyOnly } = provider.auth;
      models.setProvider({ ...provider, auth: keyOnly });
    }
    for (const [provider, credential] of Object.entries(keys)) {
      if (credential.endpoint !== undefined) models.setProvider(endpointProvider(provider, credential.endpoint, credential.key));
      const base = slotProvider(provider) === provider ? undefined : models.getProvider(slotProvider(provider));
      if (base !== undefined) models.setProvider(keySlotProvider(provider, base));
    }
    const client = `caveman-code/${packageJson.version}`;
    // A Cloud computer's credits slot may hold no key yet (`live` asks at the first request).
    const credits = keys[CREDITS_PROVIDER];
    const plan = keys[CHATGPT_PLAN_PROVIDER]?.key;
    const withPlan = plan ? withChatGptPlan(models, plan, client, gatewayOf(keys[CHATGPT_PLAN_PROVIDER])) : models;
    return objectRootsOnCompletions(credits !== undefined && (credits.key || credits.live) ? withCredits(withPlan, credits.key ?? "", client, gatewayOf(credits), credits.live) : withPlan);
  });
