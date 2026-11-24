// ), packages/secret-provider-core/src/server/SecretResolver.ts @ 81899ce04c
// (#27746) and apps/server/src/secrets/SecretResolver.ts @ 97e35bcf23 (#27115).
/**
 * SecretResolver - reads the secrets settings point at (`SecretReference`) through a configured
 * secret provider, at use time. Values live in memory only: never in settings, the database,
 * the event log, a log line or a client reply.
 *
 * Each read, a failed one too, is held for the runtime's life so rebuilds never re-prompt an
 * unlock; `invalidate` (Settings > Secret providers > Refresh, or a provider change) is the only
 * way to read again. Cache hits answer without the lock, so a read waiting on an unlock never
 * stalls a cached one.
 *
 * Every value read joins the egress scrub (`secretProviderValues`), as provider keys do, and
 * stays there until the runtime exits: a process started with it may still hold it.
 *
 * Caveman's additions to upstream resolver: a failed read keeps why (`explain`), so Settings can say
 * "locked" rather than nothing; `check` asks a provider whether it is signed in without reading
 * a secret; a provider's own credential (a service account token) is attached here, by the
 * broker, never taken from settings or the environment.
 *
 * @module secrets/SecretResolver
 */
import type { SecretReference, ServerSettings } from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Settings from "../serverSettings.ts";
import * as OnePassword from "./OnePasswordSecretProvider.ts";
import type {
  SecretProviderDriver,
  SecretProviderDriverServices,
  SecretReadFailure,
  SecretReadOutcome,
} from "./secretProviderDriver.ts";
import { SecretProviderTokens } from "./SecretProviderTokens.ts";
import { secretProviderValues } from "./secretProviderValues.ts";

export { secretProviderValues };

export class SecretResolver extends Context.Service<
  SecretResolver,
  {
    /** Values in input order; `undefined` marks a reference that could not be read (`explain` says why). */
    readonly read: (
      references: ReadonlyArray<SecretReference>,
    ) => Effect.Effect<ReadonlyArray<string | undefined>>;
    /** Why the last read of `reference` failed, or undefined when it was read (or never tried). */
    readonly explain: (reference: SecretReference) => Effect.Effect<SecretReadFailure | undefined>;
    /** Forgets the given references, or every reference, so the next read asks the provider again. */
    readonly invalidate: (references?: ReadonlyArray<SecretReference>) => Effect.Effect<void>;
    /** Whether a provider is reachable and signed in. Reads no secret. */
    readonly check: (
      providerId: string,
    ) => Effect.Effect<SecretReadOutcome & { readonly label: string }>;
    /** Whether `reference` is syntax the provider it names can read; undefined for an unknown provider. */
    readonly accepts: (reference: SecretReference) => Effect.Effect<boolean | undefined>;
  }
>()("caveman/secrets/SecretResolver") {}

const cacheKey = (reference: SecretReference) =>
  `${reference.provider}\u0000${reference.reference}`;

interface CachedSecret {
  // A provider whose config changed, such as another account, reads again.
  readonly config: string;
  readonly outcome: SecretReadOutcome;
}

const decodeConfigWith = Schema.decodeUnknownOption<Schema.Codec<unknown, unknown>>;

interface ReadablePlan {
  readonly providerId: string;
  readonly driver: SecretProviderDriver;
  readonly config: unknown;
  readonly configKey: string;
}

export const make = Effect.fn("SecretResolver.make")(function* (options: {
  readonly drivers: ReadonlyArray<SecretProviderDriver>;
  readonly secretProviders: Effect.Effect<ServerSettings["secretProviders"]>;
}) {
  const context = yield* Effect.context<SecretProviderDriverServices | SecretProviderTokens>();
  const tokens = yield* SecretProviderTokens;
  const driversByKind = new Map(
    options.drivers.map((driver) => [
      driver.kind as string,
      { driver, decodeConfig: decodeConfigWith(driver.definition.configSchema) },
    ]),
  );
  const cache = new Map<string, CachedSecret>();
  const semaphore = yield* Semaphore.make(1);

  // Only a provider this build can read is cached; anything else fails fast and is checked again
  // on the next read.
  const planFor = (
    providers: ServerSettings["secretProviders"],
    reference: SecretReference,
  ): ReadablePlan | SecretReadFailure => {
    const provider = Object.hasOwn(providers, reference.provider)
      ? providers[reference.provider]
      : undefined;
    const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
    if (provider === undefined || entry === undefined) return "unknown_provider";
    const { driver, decodeConfig } = entry;
    if (!driver.definition.isReference(reference.reference)) return "invalid_reference";
    const config = decodeConfig(provider.config);
    return Option.isNone(config)
      ? "unknown_provider"
      : {
          providerId: reference.provider,
          driver,
          config: config.value,
          configKey: JSON.stringify(config.value),
        };
  };

  const isCached = (reference: SecretReference, plan: ReadablePlan | SecretReadFailure) =>
    typeof plan !== "string" && cache.get(cacheKey(reference))?.config === plan.configKey;

  const outcomes = (
    references: ReadonlyArray<SecretReference>,
    plans: ReadonlyArray<ReadablePlan | SecretReadFailure>,
  ): ReadonlyArray<SecretReadOutcome> =>
    references.map((reference, index) => {
      const plan = plans[index]!;
      if (typeof plan === "string") return { failure: plan };
      return isCached(reference, plan)
        ? cache.get(cacheKey(reference))!.outcome
        : { failure: "failed" };
    });

  const readOutcomes = (references: ReadonlyArray<SecretReference>) =>
    Effect.gen(function* () {
      const providers = yield* options.secretProviders;
      const plans = references.map((reference) => planFor(providers, reference));
      const isMissing = (reference: SecretReference, index: number) =>
        typeof plans[index] !== "string" && !isCached(reference, plans[index]!);
      if (!references.some(isMissing)) return outcomes(references, plans);

      return yield* semaphore.withPermits(1)(
        Effect.gen(function* () {
          const wanted = new Map<
            string,
            {
              readonly plan: ReadablePlan;
              readonly byReference: Map<string, Array<SecretReference>>;
            }
          >();
          references.forEach((reference, index) => {
            const plan = plans[index]!;
            if (typeof plan === "string" || !isMissing(reference, index)) return;
            const group = wanted.get(reference.provider) ?? { plan, byReference: new Map() };
            group.byReference.set(reference.reference, [
              ...(group.byReference.get(reference.reference) ?? []),
              reference,
            ]);
            wanted.set(reference.provider, group);
          });
          for (const { plan, byReference } of wanted.values()) {
            const token = yield* tokens.get(plan.providerId);
            const read = yield* plan.driver.read(
              plan.config,
              [...byReference.keys()],
              token === undefined ? {} : { serviceAccountToken: token },
            );
            [...byReference.values()].forEach((sameReference, index) => {
              const outcome = read[index] ?? { failure: "failed" as const };
              if (outcome.value !== undefined) secretProviderValues.add(outcome.value);
              for (const reference of sameReference)
                cache.set(cacheKey(reference), { config: plan.configKey, outcome });
            });
          }
          return outcomes(references, plans);
        }),
      );
    }).pipe(Effect.provideContext(context));

  const read: SecretResolver["Service"]["read"] = Effect.fn("SecretResolver.read")(
    function* (references) {
      return (yield* readOutcomes(references)).map((outcome) => outcome.value);
    },
  );

  const explain: SecretResolver["Service"]["explain"] = (reference) =>
    Effect.gen(function* () {
      const plan = planFor(yield* options.secretProviders, reference);
      if (typeof plan === "string") return plan;
      return isCached(reference, plan)
        ? cache.get(cacheKey(reference))!.outcome.failure
        : undefined;
    });

  const invalidate: SecretResolver["Service"]["invalidate"] = (references) =>
    semaphore.withPermits(1)(
      Effect.sync(() => {
        if (references === undefined) cache.clear();
        else for (const reference of references) cache.delete(cacheKey(reference));
      }),
    );

  const check: SecretResolver["Service"]["check"] = (providerId) =>
    Effect.gen(function* () {
      const providers = yield* options.secretProviders;
      const provider = Object.hasOwn(providers, providerId)
        ? providers[providerId as keyof typeof providers]
        : undefined;
      const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
      if (provider === undefined || entry === undefined)
        return { failure: "unknown_provider" as const, label: provider?.label ?? providerId };
      const config = entry.decodeConfig(provider.config);
      if (Option.isNone(config))
        return { failure: "unknown_provider" as const, label: provider.label };
      const token = yield* tokens.get(providerId);
      const outcome = yield* entry.driver.check(
        config.value,
        token === undefined ? {} : { serviceAccountToken: token },
      );
      return { ...outcome, label: entry.driver.definition.label };
    }).pipe(Effect.provideContext(context));

  const accepts: SecretResolver["Service"]["accepts"] = (reference) =>
    Effect.map(options.secretProviders, (providers) => {
      const provider = Object.hasOwn(providers, reference.provider)
        ? providers[reference.provider]
        : undefined;
      const entry = provider === undefined ? undefined : driversByKind.get(provider.kind);
      return entry === undefined
        ? undefined
        : entry.driver.definition.isReference(reference.reference);
    });

  return SecretResolver.of({ read, explain, invalidate, check, accepts });
});

export const BUILT_IN_SECRET_PROVIDER_DRIVERS: ReadonlyArray<SecretProviderDriver> = [
  OnePassword.driver,
];

export const layerWith = (options: Parameters<typeof make>[0]) =>
  Layer.effect(SecretResolver, make(options));

/** The runtime's resolver: providers from server settings, the built-in drivers. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    return layerWith({
      drivers: BUILT_IN_SECRET_PROVIDER_DRIVERS,
      secretProviders: serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.secretProviders),
        Effect.orElseSucceed((): ServerSettings["secretProviders"] => ({})),
      ),
    });
  }),
);
