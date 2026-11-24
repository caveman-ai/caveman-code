// The person's own keys for the web tools (docs/ "Search providers and keys", "Reading through
// Firecrawl"), added in Settings > Models & keys: the search providers' and Firecrawl's. Sealed like the Caveman
// engine's model keys (provider-caveman credentials.ts): one blob in the runtime's secret store through
// ProviderHost.credentials, sealed under a key in the OS keychain. A key is checked with one call before it is kept
// (a search; Firecrawl's credit balance), and a key the provider refuses is not stored. A kept key a provider refuses
// later (at search or read time) is marked by a fingerprint, so Settings can say so until it is replaced or answers
// again. Nothing here returns, logs or journals a key.
import { createHash } from "node:crypto";

import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { checkFirecrawlKey, FIRECRAWL_LABEL } from "./firecrawl.ts";
import { runProviderSearch, WEB_PROVIDERS, webProviderInfo, WebProviderError, type WebProviderId } from "./providers.ts";

/** Whose key it is: a search provider's, or Firecrawl's (web_fetch's second reader). */
export type WebKeyId = WebProviderId | "firecrawl";
export const WEB_KEY_IDS: ReadonlyArray<WebKeyId> = [...WEB_PROVIDERS.map((p) => p.id), "firecrawl"];
const isWebKeyId = (id: string): id is WebKeyId => (WEB_KEY_IDS as ReadonlyArray<string>).includes(id);

const NAMESPACE = "caveman-web";
const BINDING = "search";

const Stored = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    keys: Schema.Record(Schema.String, Schema.String),
    /** Per provider, the fingerprint of the key it refused at search time. */
    refused: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  }),
);
const decodeStored = Schema.decodeUnknownEffect(Stored);
const encodeStored = Schema.encodeEffect(Stored);

export type WebKeys = Partial<Record<WebKeyId, string>>;

export class WebKeyRefused extends Schema.TaggedError<WebKeyRefused>()("WebKeyRefused", { message: Schema.String }) {}
export class WebKeyStoreError extends Schema.TaggedError<WebKeyStoreError>()("WebKeyStoreError", { message: Schema.String }) {}

/** What the check call found: ok; or the key works but the provider limited or could not answer, kept with this note. */
export type WebKeyCheck = { readonly ok: true } | { readonly ok: false; readonly kind: "auth" | "limit" | "unavailable" | "invalid"; readonly message: string };

export type CheckWebKey = (provider: WebKeyId, key: string) => Promise<WebKeyCheck>;

/** One cheap call with the key: a one-result search, or Firecrawl's free credit balance (Settings swaps it in tests). */
export class WebKeyChecker extends Context.Reference<CheckWebKey>("caveman/web/WebKeyChecker", {
  defaultValue: () => (provider, key) =>
    (provider === "firecrawl" ? checkFirecrawlKey(key) : runProviderSearch(provider, key, { query: "caveman code", count: 1 }, fetch, { retries: 0 })).then(
      (): WebKeyCheck => ({ ok: true }),
      (error: unknown): WebKeyCheck =>
        error instanceof WebProviderError ? { ok: false, kind: error.kind, message: error.message } : { ok: false, kind: "unavailable", message: String(error) },
    ),
}) {}

const credentials = ProviderHost.ProviderHost.pipe(Effect.flatMap((host) => host.credentials(NAMESPACE, BINDING)));

type Refused = Partial<Record<WebKeyId, string>>;

/** Which key a refusal was about, without keeping the key twice. */
const fingerprint = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** The stored keys and refusals; a damaged blob reads as none, never as a crash. */
const readStored = Effect.fn("readStoredWebKeys")(function* () {
  const stored = yield* (yield* credentials).get.pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  if (Option.isNone(stored)) return { keys: {} as WebKeys, refused: {} as Refused };
  const decoded = yield* decodeStored(new TextDecoder().decode(stored.value)).pipe(Effect.option);
  if (Option.isNone(decoded)) return { keys: {} as WebKeys, refused: {} as Refused };
  const keys = Object.fromEntries(Object.entries(decoded.value.keys).filter(([id, key]) => isWebKeyId(id) && key.trim() !== "")) as WebKeys;
  // A mark holds only for the key it was made about.
  const refused = Object.fromEntries(Object.entries(decoded.value.refused ?? {}).filter(([id, mark]) => isWebKeyId(id) && keys[id] !== undefined && fingerprint(keys[id]) === mark)) as Refused;
  return { keys, refused };
});

export const readWebKeys = Effect.fn("readWebKeys")(function* () {
  return (yield* readStored()).keys;
});

const writeStored = Effect.fn("writeWebKeys")(function* (keys: WebKeys, refused: Refused) {
  const store = yield* credentials;
  const blob = { version: 1 as const, keys: keys as Record<string, string>, ...(Object.keys(refused).length === 0 ? {} : { refused: refused as Record<string, string> }) };
  const write = Object.keys(keys).length === 0 ? store.remove : encodeStored(blob).pipe(Effect.orDie, Effect.flatMap((text) => store.set(new TextEncoder().encode(text))));
  yield* write.pipe(Effect.mapError(() => new WebKeyStoreError({ message: "Could not store the key." })));
});

/**
 * Marks (or, `refused` false, unmarks) the stored key for `provider` as refused by its provider at search or read time.
 * Only when `key` is still the stored one (a search that started before the person replaced it changes nothing),
 * and only a change is written.
 */
export const noteWebKeyRefused = Effect.fn("noteWebKeyRefused")(function* (provider: WebKeyId, key: string, refused: boolean) {
  const stored = yield* readStored();
  if (stored.keys[provider] !== key || (stored.refused[provider] !== undefined) === refused) return;
  const { [provider]: _mark, ...others } = stored.refused;
  yield* writeStored(stored.keys, refused ? { ...others, [provider]: fingerprint(key) } : others);
});

/** Settings' line for a stored key: its last four characters, as model keys show. */
const hintOf = (key: string) => (key.length >= 20 ? `...${key.slice(-4)}` : undefined);

export const webKeyStatus = Effect.fn("webKeyStatus")(function* () {
  const { keys, refused } = yield* readStored();
  return WEB_KEY_IDS.map((id) => {
    const key = keys[id];
    const hint = key === undefined ? undefined : hintOf(key);
    return { id, configured: key !== undefined, ...(hint === undefined ? {} : { hint }), ...(refused[id] === undefined ? {} : { refused: true }) };
  });
});

const label = (id: WebKeyId) => (id === "firecrawl" ? FIRECRAWL_LABEL : webProviderInfo(id).label);

/**
 * Checks `key` with one call, then keeps it. Refused (401/403): not stored, WebKeyRefused. Rate limited or
 * unreachable: kept, with a note saying so, as model keys are.
 */
export const setWebKey = Effect.fn("setWebKey")(function* (provider: WebKeyId, raw: string) {
  const key = raw.trim();
  if (key === "" || key.length > 512 || /\s/.test(key)) return yield* new WebKeyRefused({ message: `That is not ${/^[aeiou]/i.test(label(provider)) ? "an" : "a"} ${label(provider)} API key.` });
  const check = yield* WebKeyChecker;
  const result = yield* Effect.promise(() => check(provider, key));
  if (!result.ok && (result.kind === "auth" || result.kind === "invalid")) {
    return yield* new WebKeyRefused({ message: `${label(provider)} refused the key (${result.message}). It was not saved.` });
  }
  const stored = yield* readStored();
  const { [provider]: _mark, ...refused } = stored.refused;
  yield* writeStored({ ...stored.keys, [provider]: key }, refused);
  return {
    checked: result.ok,
    ...(result.ok ? {} : { note: result.kind === "limit" ? `Saved. ${label(provider)} is rate limiting it right now: ${result.message}` : `Saved, but ${label(provider)} did not answer the check: ${result.message}` }),
  };
});

export const clearWebKey = Effect.fn("clearWebKey")(function* (provider: WebKeyId) {
  const stored = yield* readStored();
  const { [provider]: _removed, ...keys } = stored.keys;
  const { [provider]: _mark, ...refused } = stored.refused;
  yield* writeStored(keys, refused);
});
