/**
 * A secret provider's own credential (a 1Password service account token): sealed with the
 * provider-key seal (ProviderKeySeal, AES-256-GCM under a random key in the runtime's secret
 * store, never the OS keychain) and kept in the secret store, never in settings. Sealing and
 * opening put it in the egress scrub (`providerKeyValues`), as every provider key is.
 *
 * It goes in once (secret_provider.save) and out only to the provider's CLI, in that process's
 * environment. Nothing here returns it to a client, logs it or journals it.
 *
 * @module secrets/SecretProviderTokens
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ProviderKeySeal from "../provider/ProviderKeySeal.ts";

export class SecretProviderTokens extends Context.Service<
  SecretProviderTokens,
  {
    readonly get: (providerId: string) => Effect.Effect<string | undefined>;
    readonly has: (providerId: string) => Effect.Effect<boolean>;
    readonly set: (
      providerId: string,
      token: Redacted.Redacted<string>,
    ) => Effect.Effect<void, Error>;
    readonly remove: (providerId: string) => Effect.Effect<void>;
  }
>()("caveman/secrets/SecretProviderTokens") {}

const storeName = (providerId: string) =>
  `secret-provider-token-${Buffer.from(providerId, "utf8").toString("base64url")}`;
const aad = (providerId: string) => `secret-provider:${providerId}`;

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore;
  const seal = yield* ProviderKeySeal.make;
  const get = (providerId: string) =>
    store.get(storeName(providerId)).pipe(
      Effect.flatMap((stored) =>
        Option.isNone(stored)
          ? Effect.succeed(Option.none())
          : seal.open(stored.value, aad(providerId)),
      ),
      Effect.map((opened) => {
        if (Option.isNone(opened)) return undefined;
        try {
          const parsed = JSON.parse(new TextDecoder().decode(opened.value.plain)) as {
            readonly key?: unknown;
          };
          return typeof parsed.key === "string" && parsed.key !== "" ? parsed.key : undefined;
        } catch {
          return undefined;
        }
      }),
      Effect.catch(() =>
        Effect.logWarning("A secret provider's token could not be read", { providerId }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
  return SecretProviderTokens.of({
    get,
    has: (providerId) => Effect.map(get(providerId), (token) => token !== undefined),
    set: (providerId, token) =>
      // `key`: ProviderKeySeal scrubs every `key` it seals or opens.
      seal
        .seal(
          new TextEncoder().encode(JSON.stringify({ key: Redacted.value(token) })),
          aad(providerId),
        )
        .pipe(
          Effect.flatMap((sealed) => store.set(storeName(providerId), sealed)),
          Effect.mapError(() => new Error("Could not keep the service account token.")),
        ),
    remove: (providerId) => store.remove(storeName(providerId)).pipe(Effect.ignore),
  });
});

export const layer = Layer.effect(SecretProviderTokens, make);

/** For tests and runtimes without a secret store: holds tokens in memory. */
export const layerMemory = Layer.sync(SecretProviderTokens, () => {
  const tokens = new Map<string, string>();
  return SecretProviderTokens.of({
    get: (id) => Effect.sync(() => tokens.get(id)),
    has: (id) => Effect.sync(() => tokens.has(id)),
    set: (id, token) => Effect.sync(() => void tokens.set(id, Redacted.value(token))),
    remove: (id) => Effect.sync(() => void tokens.delete(id)),
  });
});
