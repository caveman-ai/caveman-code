/**
 * Provider credentials at rest (the Caveman engine's API keys, through
 * ProviderHost.credentials): each blob sealed with AES-256-GCM under a random
 * key in the runtime's secret store, as ProjectSecretsLive seals repository
 * secrets.
 *
 * Never the OS keychain (see ProjectSecretsLive). Each blob says which key
 * sealed it: one an older runtime sealed under a key it kept in the keychain
 * opens as nothing, so the person adds that credential again. A blob from
 * before sealing (plain JSON, 0600) reads as it is and is sealed on the spot.
 *
 * Every key a blob holds also joins the egress scrub (`providerKeyValues`),
 * so a key that ever lands in a model request body is replaced first.
 *
 * @module provider/ProviderKeySeal
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

const MAGIC = Buffer.from("CVK1");
const STORE_KEY = "provider-keys-key";
const FLAG_KEYCHAIN = 1;
const FLAG_STORE = 0;

export interface ProviderKeySeal {
  readonly seal: (plain: Uint8Array, aad: string) => Effect.Effect<Uint8Array, Error>;
  /**
   * `legacy`: the blob predates sealing and should be written back sealed. None: an older runtime sealed it under a
   * key in the OS keychain, which is never read, so the credential is gone.
   */
  readonly open: (stored: Uint8Array, aad: string) => Effect.Effect<Option.Option<{ readonly plain: Uint8Array; readonly legacy: boolean }>, Error>;
}

/**
 * Secret values seen in provider credential blobs this run: they stay in the
 * egress scrub until exit (a removed key may still be in a running request).
 * ponytail: process-wide, like the runtime itself; a service if two runtimes ever share a process.
 */
export const providerKeyValues = new Set<string>();

/** Every `key` string (20+ characters) in a credential blob's JSON, and each value of a v1 blob's `keys` record. Not JSON: none. */
export const keyValuesOf = (plain: Uint8Array): Array<string> => {
  const found: Array<string> = [];
  const walk = (value: unknown, name?: string, inKeys = false) => {
    if (typeof value === "string") {
      if ((name === "key" || inKeys) && value.length >= 20) found.push(value);
    } else if (value && typeof value === "object") {
      const array = Array.isArray(value);
      for (const [k, v] of Object.entries(value)) walk(v, array ? name : k, !array && name === "keys");
    }
  };
  try {
    walk(JSON.parse(new TextDecoder().decode(plain)));
  } catch {
    // Opaque bytes: nothing to scrub by name.
  }
  return found;
};

export const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore;
  const storeKey = store.getOrCreateRandom(STORE_KEY, 32).pipe(Effect.map((k) => Buffer.from(k)));
  return {
    seal: (plain, aad) =>
      storeKey.pipe(
        Effect.map((key) => {
          for (const value of keyValuesOf(plain)) providerKeyValues.add(value);
          const iv = randomBytes(12);
          const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
          const body = Buffer.concat([cipher.update(plain), cipher.final()]);
          return new Uint8Array(Buffer.concat([MAGIC, Buffer.from([FLAG_STORE]), iv, cipher.getAuthTag(), body]));
        }),
        Effect.mapError((cause) => new Error("Could not seal a provider credential.", { cause })),
      ),
    open: (stored, aad) =>
      Effect.gen(function* () {
        const bytes = Buffer.from(stored);
        if (bytes.length < MAGIC.length + 29 || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
          for (const value of keyValuesOf(stored)) providerKeyValues.add(value);
          return Option.some({ plain: stored, legacy: true });
        }
        if (bytes[MAGIC.length] === FLAG_KEYCHAIN) return Option.none();
        const key = yield* storeKey;
        const at = MAGIC.length + 1;
        const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(at, at + 12)).setAAD(Buffer.from(aad));
        decipher.setAuthTag(bytes.subarray(at + 12, at + 28));
        const plain = yield* Effect.try({
          try: () => new Uint8Array(Buffer.concat([decipher.update(bytes.subarray(at + 28)), decipher.final()])),
          catch: (cause) => new Error("A provider credential could not be opened.", { cause }),
        });
        for (const value of keyValuesOf(plain)) providerKeyValues.add(value);
        return Option.some({ plain, legacy: false });
      }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause))))),
  } satisfies ProviderKeySeal;
});
