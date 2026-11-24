// Provider credentials at rest: sealed under the store's key, never the keychain; a blob an older
// runtime sealed under a keychain key opens as nothing; a pre-sealing plain blob still reads; and
// every key a blob holds joins the egress scrub's list.
import { createCipheriv, randomBytes } from "node:crypto";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ProviderKeySeal from "./ProviderKeySeal.ts";

const memoryStore = () => {
  const data = new Map<string, Uint8Array>();
  return ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(data.get(name))),
    set: (name, value) => Effect.sync(() => void data.set(name, value)),
    remove: (name) => Effect.sync(() => void data.delete(name)),
    create: (name, value) => Effect.sync(() => void data.set(name, value)),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        if (!data.has(name)) data.set(name, crypto.getRandomValues(new Uint8Array(bytes)));
        return data.get(name)!;
      }),
  });
};

const KEY = "sk-provider-seal-test-0123456789abcdef";
const blob = new TextEncoder().encode(JSON.stringify({ version: 2, providers: { openai: { key: KEY } } }));

/** A blob as an older runtime sealed it, under a key it kept in the OS keychain (flag 1). */
const sealedByOlderRuntime = (key: Uint8Array, plain: Uint8Array, aad: string) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv).setAAD(Buffer.from(aad));
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return new Uint8Array(Buffer.concat([Buffer.from("CVK1"), Buffer.from([1]), iv, cipher.getAuthTag(), body]));
};

it.effect("seals under the store's key, opens, and refuses a blob moved to another binding", () =>
  Effect.gen(function* () {
    const seal = yield* ProviderKeySeal.make;
    const sealed = yield* seal.seal(blob, "provider-auth-a");
    assert.ok(!Buffer.from(sealed).includes(KEY), "the file holds no key");
    assert.deepEqual(yield* seal.open(sealed, "provider-auth-a"), Option.some({ plain: blob, legacy: false }));
    assert.ok((yield* Effect.exit(seal.open(sealed, "provider-auth-b")))._tag === "Failure");
    assert.ok(ProviderKeySeal.providerKeyValues.has(KEY));
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, memoryStore())),
);

it.effect("a blob an older runtime sealed under a key in the OS keychain opens as nothing", () =>
  Effect.gen(function* () {
    const seal = yield* ProviderKeySeal.make;
    assert.deepEqual(yield* seal.open(sealedByOlderRuntime(randomBytes(32), blob, "provider-auth-a"), "provider-auth-a"), Option.none());
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, memoryStore())),
);

it.effect("reads a blob from before sealing as it is, and says to seal it", () =>
  Effect.gen(function* () {
    const seal = yield* ProviderKeySeal.make;
    assert.deepEqual(yield* seal.open(blob, "provider-auth-a"), Option.some({ plain: blob, legacy: true }));
    assert.deepEqual(ProviderKeySeal.keyValuesOf(new TextEncoder().encode('{"keys":{"a":"short"},"x":{"key":"' + KEY + '"}}')), [KEY]);
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, memoryStore())),
);

it.effect("a v1 blob from before W4 (provider id -> key string) puts its keys in the egress scrub on open", () =>
  Effect.gen(function* () {
    const openai = ("sk-" + "proj-v1-blob-openai-0123456789abcdefghij");
    const anthropic = ("sk-" + "ant-api03-v1-blob-anthropic-0123456789abcdef");
    const v1 = new TextEncoder().encode(JSON.stringify({ version: 1, keys: { openai, anthropic } }));
    assert.deepEqual(ProviderKeySeal.keyValuesOf(v1), [openai, anthropic]);
    const seal = yield* ProviderKeySeal.make;
    // Plain on disk (pre-sealing), and sealed but still v1 (resealed, not yet rewritten as v2): both feed the scrub.
    const resealed = yield* seal.seal(v1, "provider-auth-v1");
    ProviderKeySeal.providerKeyValues.clear();
    yield* seal.open(v1, "provider-auth-v1");
    assert.ok(ProviderKeySeal.providerKeyValues.has(openai) && ProviderKeySeal.providerKeyValues.has(anthropic));
    ProviderKeySeal.providerKeyValues.clear();
    yield* seal.open(resealed, "provider-auth-v1");
    assert.ok(ProviderKeySeal.providerKeyValues.has(openai) && ProviderKeySeal.providerKeyValues.has(anthropic));
  }).pipe(Effect.provideService(ServerSecretStore.ServerSecretStore, memoryStore())),
);
