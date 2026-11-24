// An engine account's environment variable that names a secret provider reference: read when the instance is built
// (after the registry is up, so a vault prompt never holds the runtime's start), the driver gets the value, an
// unreadable one leaves the instance unavailable with why, Claude Agent never reads one, and a refresh rebuilds only
// the instances whose values changed.
import {
  ProviderDriverKind,
  ProviderInstanceId,
  SecretProviderId,
  SecretProviderKind,
  type ProviderInstanceConfigMap,
  type ResolvedProviderInstanceEnvironment,
  type ServerSettings,
} from "@caveman-app/protocol";
import type { AnyProviderDriver, ProviderInstance } from "@caveman-app/engine-core/server/driver";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  defineSecretProvider,
  defineSecretProviderDriver,
} from "../secrets/secretProviderDriver.ts";
import { layerMemory as tokensInMemory } from "../secrets/SecretProviderTokens.ts";
import { layerWith as resolverWith } from "../secrets/SecretResolver.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

const KIND = SecretProviderKind.make("one_password");
const work: ServerSettings["secretProviders"] = {
  [SecretProviderId.make("work")]: {
    kind: KIND,
    label: "Work",
    config: { account: "my.1password.com" },
  },
};

/** A vault the test can change between reads; `reads` counts the driver's batches. */
const vault = {
  values: { "op://Dev/Cursor/key": "crsr_resolved_key_0123456789" } as Record<string, string>,
  reads: 0,
};

const layerResolver = resolverWith({
  drivers: [
    defineSecretProviderDriver({
      kind: KIND,
      definition: defineSecretProvider({
        kind: KIND,
        label: "1Password",
        configSchema: Schema.Struct({ account: Schema.String }),
        isReference: (r) => r.startsWith("op://"),
        referencePlaceholder: "op://vault/item/field",
        invalidReferenceMessage: "Use op://",
      }),
      read: (_config, references) =>
        Effect.sync(() => {
          vault.reads += 1;
          return references.map((r) =>
            Object.hasOwn(vault.values, r)
              ? { value: vault.values[r]! }
              : { failure: "locked" as const },
          );
        }),
      check: () => Effect.succeed({}),
    }),
  ],
  secretProviders: Effect.succeed(work),
}).pipe(Layer.provide(tokensInMemory), Layer.provide(NodeServices.layer));

/** A driver that records the environment each instance was created with. */
const created: Array<{
  readonly instanceId: string;
  readonly environment: ResolvedProviderInstanceEnvironment;
}> = [];
const recordingDriver = (kind: string): AnyProviderDriver =>
  ({
    driverKind: ProviderDriverKind.make(kind),
    metadata: { displayName: kind } as never,
    configSchema: Schema.Struct({ enabled: Schema.optionalKey(Schema.Boolean) }),
    defaultConfig: () => ({}),
    create: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly environment: ResolvedProviderInstanceEnvironment;
    }) =>
      Effect.sync(() => {
        created.push({ instanceId: input.instanceId, environment: input.environment });
        return { instanceId: input.instanceId } as unknown as ProviderInstance;
      }),
  }) as unknown as AnyProviderDriver;

const keyRef = { provider: SecretProviderId.make("work"), reference: "op://Dev/Cursor/key" };
const configMap = (reference = keyRef): ProviderInstanceConfigMap => ({
  [ProviderInstanceId.make("cursor")]: {
    driver: ProviderDriverKind.make("cursor"),
    environment: [
      { name: "CURSOR_API_KEY", value: reference, sensitive: true },
      { name: "PLAIN", value: "plain-value", sensitive: false },
    ],
  },
});

const build = (map: ProviderInstanceConfigMap) =>
  makeProviderInstanceRegistry({
    drivers: [recordingDriver("cursor"), recordingDriver("claudeAgent")],
    configMap: map,
  });

/** Waits for the startup read (forked) to land. */
const settle = Effect.gen(function* () {
  for (let i = 0; i < 50; i++) {
    yield* Effect.yieldNow;
    yield* Effect.sleep("5 millis");
  }
});

describe("ProviderInstanceRegistry with secret references", () => {
  it.live("starts the instance with the value read, after start, never the reference", () =>
    Effect.scoped(
      Effect.gen(function* () {
        created.length = 0;
        vault.reads = 0;
        const { registry } = yield* build(configMap());
        // Until the read lands the instance waits, so a vault prompt never holds the runtime's start.
        yield* settle;
        const instances = yield* registry.listInstances;
        assert.strictEqual(instances.length, 1);
        const cursor = created.find((c) => c.instanceId === "cursor")!;
        assert.deepStrictEqual(
          cursor.environment.map((v) => [v.name, v.value, v.sensitive]),
          [
            ["CURSOR_API_KEY", "crsr_resolved_key_0123456789", true],
            ["PLAIN", "plain-value", false],
          ],
        );
        assert.strictEqual(vault.reads, 1);
      }),
    ).pipe(Effect.provide(layerResolver)),
  );

  it.live(
    "an unreadable reference leaves the instance unavailable, saying why, and never starts it blank",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          created.length = 0;
          const { registry } = yield* build(
            configMap({ ...keyRef, reference: "op://Dev/Missing/key" }),
          );
          yield* settle;
          assert.strictEqual((yield* registry.listInstances).length, 0);
          const [shadow] = yield* registry.listUnavailable;
          assert.include(
            JSON.stringify(shadow),
            "Could not read CURSOR_API_KEY from its secret provider",
          );
          assert.include(JSON.stringify(shadow), "locked or not signed in");
          assert.strictEqual(created.length, 0);
        }),
      ).pipe(Effect.provide(layerResolver)),
  );

  it.live("Claude Agent never reads a reference: its credentials are the person's own login", () =>
    Effect.scoped(
      Effect.gen(function* () {
        created.length = 0;
        vault.reads = 0;
        const { registry } = yield* build({
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            environment: [{ name: "ANTHROPIC_API_KEY", value: keyRef, sensitive: true }],
          },
        });
        yield* settle;
        assert.strictEqual(vault.reads, 0);
        assert.strictEqual(created.length, 0);
        assert.include(
          JSON.stringify(yield* registry.listUnavailable),
          "never reads its credentials",
        );
      }),
    ).pipe(Effect.provide(layerResolver)),
  );

  it.live("a refresh reads again and rebuilds only an instance whose value changed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        created.length = 0;
        vault.values["op://Dev/Cursor/key"] = "crsr_resolved_key_0123456789";
        const { mutator } = yield* build(configMap());
        yield* settle;
        assert.strictEqual(created.length, 1);
        // Same value: nothing restarts.
        yield* mutator.reloadSecrets();
        assert.strictEqual(created.length, 1);
        // Rotated in 1Password: the instance restarts on the new key.
        vault.values["op://Dev/Cursor/key"] = "crsr_rotated_key_9876543210";
        yield* mutator.reloadSecrets();
        assert.strictEqual(created.length, 2);
        assert.strictEqual(created[1]!.environment[0]!.value, "crsr_rotated_key_9876543210");
        // Locked now: the working instance keeps the value it holds.
        delete vault.values["op://Dev/Cursor/key"];
        yield* mutator.reloadSecrets();
        assert.strictEqual(created.length, 2);
      }),
    ).pipe(Effect.provide(layerResolver)),
  );
});
