// The resolver over a scripted driver: one batch per provider, held until invalidated (so a rebuild never re-prompts
// an unlock), failures kept with why, a service account's token attached from the sealed store only, and every value
// read put in the egress scrub's set.
import { createScrubber } from "@caveman-app/session-protocol";
import {
  SecretProviderId,
  SecretProviderKind,
  type SecretReference,
  type ServerSettings,
} from "@caveman-app/protocol";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  defineSecretProvider,
  defineSecretProviderDriver,
  type SecretProviderAuth,
} from "./secretProviderDriver.ts";
import { SecretProviderTokens, layerMemory as tokensInMemory } from "./SecretProviderTokens.ts";
import { layerWith, SecretResolver } from "./SecretResolver.ts";
import { secretProviderValues } from "./secretProviderValues.ts";

const KIND = SecretProviderKind.make("one_password");
const Config = Schema.Struct({
  account: Schema.optionalKey(Schema.String),
  serviceAccount: Schema.optionalKey(Schema.Boolean),
});

const ref = (provider: string, reference: string): SecretReference => ({
  provider: SecretProviderId.make(provider),
  reference,
});

/** A driver that answers from `vault` and records each batch it was asked for and the auth it got. */
const scripted = (
  vault: Record<string, string>,
  calls: Array<{ readonly references: ReadonlyArray<string>; readonly auth: SecretProviderAuth }>,
) =>
  defineSecretProviderDriver({
    kind: KIND,
    definition: defineSecretProvider({
      kind: KIND,
      label: "1Password",
      configSchema: Config,
      isReference: (r) => r.startsWith("op://"),
      referencePlaceholder: "op://vault/item/field",
      invalidReferenceMessage: "Use op://",
    }),
    read: (_config, references, auth) =>
      Effect.sync(() => {
        calls.push({ references, auth });
        return references.map((r) =>
          Object.hasOwn(vault, r) ? { value: vault[r]! } : { failure: "not_found" as const },
        );
      }),
    check: () => Effect.succeed({}),
  });

const providers = (entries: ServerSettings["secretProviders"]) => entries;
const work = providers({
  [SecretProviderId.make("work")]: {
    kind: KIND,
    label: "Work",
    config: { account: "my.1password.com" },
  },
});

const setup = (
  vault: Record<string, string>,
  secretProviders: ServerSettings["secretProviders"] = work,
) =>
  Effect.gen(function* () {
    const calls: Array<{
      readonly references: ReadonlyArray<string>;
      readonly auth: SecretProviderAuth;
    }> = [];
    const settings = yield* Ref.make(secretProviders);
    const layer = layerWith({
      drivers: [scripted(vault, calls)],
      secretProviders: Ref.get(settings),
    }).pipe(Layer.provideMerge(tokensInMemory), Layer.provide(NodeServices.layer));
    const context = yield* Layer.build(layer);
    return {
      calls,
      settings,
      resolver: Context.get(context, SecretResolver),
      tokens: Context.get(context, SecretProviderTokens),
    };
  });

describe("SecretResolver", () => {
  it.effect("reads each provider's references in one batch and holds them until invalidated", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, resolver } = yield* setup({
          "op://Dev/A/key": "resolved-a-0123456789",
          "op://Dev/B/key": "resolved-b-0123456789",
        });
        const a = ref("work", "op://Dev/A/key");
        const b = ref("work", "op://Dev/B/key");
        assert.deepStrictEqual(yield* resolver.read([a, b, a]), [
          "resolved-a-0123456789",
          "resolved-b-0123456789",
          "resolved-a-0123456789",
        ]);
        // Same references again: no second unlock.
        yield* resolver.read([a, b]);
        assert.strictEqual(calls.length, 1);
        assert.deepStrictEqual(calls[0]!.references, ["op://Dev/A/key", "op://Dev/B/key"]);
        yield* resolver.invalidate([a]);
        yield* resolver.read([a, b]);
        assert.deepStrictEqual(calls[1]!.references, ["op://Dev/A/key"]);
      }),
    ),
  );

  it.effect("a failed read is held with why, and Settings' explain never starts a read", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, resolver } = yield* setup({});
        const missing = ref("work", "op://Dev/Nope/key");
        assert.strictEqual(yield* resolver.explain(missing), undefined);
        assert.strictEqual(calls.length, 0);
        assert.deepStrictEqual(yield* resolver.read([missing]), [undefined]);
        assert.strictEqual(yield* resolver.explain(missing), "not_found");
        yield* resolver.read([missing]);
        assert.strictEqual(calls.length, 1);
      }),
    ),
  );

  it.effect(
    "an unknown provider or syntax it does not read fails at once, without the driver",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const { calls, resolver } = yield* setup({});
          assert.deepStrictEqual(
            yield* resolver.read([ref("gone", "op://Dev/A/key"), ref("work", "vault://A")]),
            [undefined, undefined],
          );
          assert.strictEqual(
            yield* resolver.explain(ref("gone", "op://Dev/A/key")),
            "unknown_provider",
          );
          assert.strictEqual(
            yield* resolver.explain(ref("work", "vault://A")),
            "invalid_reference",
          );
          assert.strictEqual(yield* resolver.accepts(ref("work", "vault://A")), false);
          assert.strictEqual(yield* resolver.accepts(ref("gone", "op://Dev/A/key")), undefined);
          assert.strictEqual(calls.length, 0);
        }),
      ),
  );

  it.effect("another account reads again: the cache is keyed by the provider's config", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { calls, resolver, settings } = yield* setup({
          "op://Dev/A/key": "resolved-a-0123456789",
        });
        const a = ref("work", "op://Dev/A/key");
        yield* resolver.read([a]);
        yield* Ref.set(
          settings,
          providers({
            [SecretProviderId.make("work")]: {
              kind: KIND,
              label: "Work",
              config: { account: "other.1password.com" },
            },
          }),
        );
        yield* resolver.read([a]);
        assert.strictEqual(calls.length, 2);
      }),
    ),
  );

  it.effect("a service account's token comes from the sealed store, attached at read time", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const ci = providers({
          [SecretProviderId.make("ci")]: {
            kind: KIND,
            label: "CI",
            config: { serviceAccount: true },
          },
        });
        const { calls, resolver, tokens } = yield* setup(
          { "op://CI/A/key": "resolved-ci-0123456789" },
          ci,
        );
        yield* tokens.set("ci", Redacted.make("ops_service_account_token_0123456789"));
        yield* resolver.read([ref("ci", "op://CI/A/key")]);
        assert.deepStrictEqual(calls[0]!.auth, {
          serviceAccountToken: "ops_service_account_token_0123456789",
        });
      }),
    ),
  );

  it.effect("every value read joins the egress scrub", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const value = "sk-resolved-egress-check-0123456789abcdef";
        const { resolver } = yield* setup({ "op://Dev/Egress/key": value });
        yield* resolver.read([ref("work", "op://Dev/Egress/key")]);
        assert.isTrue(secretProviderValues.has(value));
        const scrubber = createScrubber(
          [...secretProviderValues].map((v) => ({ name: "SECRET_MANAGER_VALUE", value: v })),
        );
        assert.notInclude(scrubber.scrub(`curl -H "Authorization: Bearer ${value}"`), value);
      }),
    ),
  );
});
