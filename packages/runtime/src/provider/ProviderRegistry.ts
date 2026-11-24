// ), apps/server/src/provider/ProviderRegistry.ts @ ab3a3cd1.
/**
 * ProviderRegistry - Provider snapshot service.
 *
 * Owns provider install/auth/version/model snapshots and exposes the latest
 * provider state to transport layers.
 *
 * The live layer aggregates per-instance snapshot streams into a
 * single materialized list.
 *
 * Historically this Layer composed four per-kind Live Layers
 * (`CodexProviderLive`, `ClaudeProviderLive`, …) that each exposed a
 * `ManagedServerProvider`. Those Lives were deleted during the driver /
 * instance refactor — every driver now carries its `snapshot: ManagedServerProvider`
 * bundled onto the `ProviderInstance` the registry produces.
 *
 * Each configured instance (including multi-instance setups like
 * `codex_personal` + `codex_work`) contributes one `ProviderSnapshotSource`,
 * keyed by `instanceId`. Instances whose driver is unavailable or whose
 * config failed to decode are merged from `instanceRegistry.listUnavailable`
 * as shadow snapshots so the UI can render their exact unavailable reason.
 *
 * Cache paths on disk are now keyed by `instanceId`. Because
 * `defaultInstanceIdForDriver(kind) === kind` for built-in kinds, existing
 * `<kind>.json` files remain the on-disk location for that driver's default
 * instance. Identity-less legacy cache contents are ignored and replaced by
 * the first live refresh.
 *
 * @module ProviderRegistry
 */
import {
  defaultInstanceIdForDriver,
  isProviderWorkspaceSnapshotCurrent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUpdateState,
} from "@caveman-app/protocol";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as ModelManifest from "./ModelManifest.ts";
import { applyProviderCompatibility } from "./providerCompatibility.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import {
  hydrateCachedProvider,
  isCachedProviderCorrelated,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "./providerStatusCache.ts";
import type {
  ProviderInstance,
  ProviderWorkspaceSnapshot,
} from "@caveman-app/engine-core/server/driver";
import {
  latestProviderVersionCacheKeys,
  makeManualOnlyProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilities,
} from "@caveman-app/engine-core/server/maintenanceResolver";
import type { ProviderSnapshotSource } from "./builtInProviderCatalog.ts";

export type ProviderMaintenanceActionKind = "update";

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    /**
     * Read the latest provider snapshots for every configured instance.
     * Multiple snapshots may share the same `provider` kind (multiple
     * instances of the same driver) and disambiguate via `instanceId`.
     */
    readonly getProviders: Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Refresh all providers, or the default instance of the specified
     * kind when supplied.
     *
     * Retained for back-compat with legacy call sites (WS refresh RPC,
     * orchestration metrics). New code should prefer `refreshInstance`.
     *
     * @deprecated prefer `refreshInstance` for new call sites.
     */
    readonly refresh: (
      provider?: ProviderDriverKind,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Refresh the specific configured instance. Returns the updated snapshot
     * list. When the instance id is unknown the call resolves with the
     * currently cached list (no error) — matching the legacy `refresh` shim
     * behaviour so transport layers don't have to special-case unknowns.
     */
    readonly refreshInstance: (
      instanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /** Only refreshed instances can verify an update; the published list still includes every row. */
    readonly refreshAfterUpdate: (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Fill the skills and slash commands snapshot for one cwd. A cwd that
     * already has a snapshot is left alone unless `fresh` is set. A fresh scan
     * also refreshes the instance's machine snapshot and drops other
     * instances' snapshots for the cwd.
     */
    readonly refreshWorkspaceSnapshot: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Resolve the maintenance capabilities owned by one live provider instance.
     * Falls back to manual-only capabilities when the instance is not live.
     * `fresh` re-derives ownership from the executable instead of the cache.
     */
    readonly getProviderMaintenanceCapabilitiesForInstance: (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) => Effect.Effect<ProviderMaintenanceCapabilities>;

    /**
     * Apply volatile maintenance-action state to one configured instance.
     * This state is never persisted to disk. Today only update actions are
     * projected onto `ServerProvider.updateState`; install/auth actions can
     * extend this action map without adding driver-scoped APIs.
     */
    readonly setProviderMaintenanceActionState: (input: {
      readonly instanceId: ProviderInstanceId;
      readonly action: ProviderMaintenanceActionKind;
      readonly state: ServerProviderUpdateState | null;
    }) => Effect.Effect<ReadonlyArray<ServerProvider>>;

    /**
     * Stream of provider snapshot updates — one emission per aggregated
     * change. The array contains the full current state.
     */
    readonly streamChanges: Stream.Stream<ReadonlyArray<ServerProvider>>;
  }
>()("t3/provider/ProviderRegistry") {}

const loadProviders = (
  providerSources: ReadonlyArray<ProviderSnapshotSource>,
): Effect.Effect<ReadonlyArray<ServerProvider>> =>
  Effect.forEach(
    providerSources,
    (providerSource) =>
      providerSource.getSnapshot.pipe(
        Effect.flatMap((snapshot) => correlateSnapshotWithSource(providerSource, snapshot)),
      ),
    {
      concurrency: "unbounded",
    },
  );

const makeManualProviderMaintenanceCapabilities = (provider: ProviderDriverKind) =>
  makeManualOnlyProviderMaintenanceCapabilities({
    provider,
    packageName: null,
  });

const hasModelCapabilities = (model: ServerProvider["models"][number]): boolean =>
  (model.capabilities?.optionDescriptors?.length ?? 0) > 0;

const MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER = 16;

function dropProviderWorkspaceSnapshot(provider: ServerProvider, cwd: string): ServerProvider {
  return provider.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)
    ? {
        ...provider,
        workspaceSnapshots: provider.workspaceSnapshots.filter((snapshot) => snapshot.cwd !== cwd),
      }
    : provider;
}

export function upsertProviderWorkspaceSnapshot(
  provider: ServerProvider,
  cwd: string,
  scopedSnapshot: ProviderWorkspaceSnapshot,
): ServerProvider {
  const previousSnapshot = provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd);
  const optionDescriptors = scopedSnapshot.optionDescriptors ?? previousSnapshot?.optionDescriptors;
  const workspaceSnapshot = {
    cwd,
    checkedAt: scopedSnapshot.checkedAt,
    slashCommands: scopedSnapshot.slashCommandsPending
      ? (previousSnapshot?.slashCommands ?? scopedSnapshot.slashCommands)
      : scopedSnapshot.slashCommands,
    ...(scopedSnapshot.slashCommandsPending ? { slashCommandsPending: true } : {}),
    skills: scopedSnapshot.skills,
    ...(optionDescriptors === undefined ? {} : { optionDescriptors }),
  } satisfies NonNullable<ServerProvider["workspaceSnapshots"]>[number];
  return {
    ...provider,
    workspaceSnapshots: [
      ...(provider.workspaceSnapshots ?? []).filter((snapshot) => snapshot.cwd !== cwd),
      workspaceSnapshot,
    ].slice(-MAX_WORKSPACE_SNAPSHOTS_PER_PROVIDER),
  };
}

const shouldRetainMissingProviderModels = (provider: ServerProvider): boolean => {
  if (provider.driver === ProviderDriverKind.make("caveman")) {
    // This in-process catalog is complete: a missing model's key or endpoint was removed.
    return provider.status === "error";
  }

  if (provider.driver === ProviderDriverKind.make("pi")) {
    // Pi reports known auth only after RPC inventory discovery completes.
    // An empty inventory is warning/unauthenticated; failed or interactive
    // discovery stays ready/unknown and must keep the last known models.
    return !(
      provider.installed &&
      (provider.status === "ready" || provider.status === "warning") &&
      provider.auth.status !== "unknown"
    );
  }

  if (provider.driver === ProviderDriverKind.make("acpRegistry")) {
    // ACP Registry discovery probes return the agent's complete inventory, so
    // a completed probe replaces the model list — otherwise agents that rename
    // or collapse models leave stale entries pinned forever through the
    // snapshot cache. Only a completed probe reports `nativeSessions`;
    // readiness-only and failed probe snapshots only know the "default"
    // placeholder and stay partial. Auth is no signal here: agents without
    // sign-in stay "unknown" after every probe.
    return !(
      provider.installed &&
      provider.status === "ready" &&
      provider.nativeSessions !== undefined
    );
  }

  if (provider.driver === ProviderDriverKind.make("grok")) {
    // Grok reports ready only after it discovers a model list; the pending,
    // ACP-failed, empty-inventory, and logged-out probes are warning/error.
    return !(provider.installed && provider.status === "ready");
  }

  const isAntigravity = provider.driver === ProviderDriverKind.make("antigravity");
  const isCodex = provider.driver === ProviderDriverKind.make("codex");
  if (!isAntigravity && !isCodex && provider.driver !== ProviderDriverKind.make("opencode")) {
    return true;
  }

  if (
    (isAntigravity || isCodex) &&
    (!provider.enabled || provider.auth.status === "unauthenticated")
  ) {
    return false;
  }

  // Successful discovery replaces these inventories so cached retired models disappear.
  // Antigravity's local health check does not authenticate or discover models.
  const isPendingAntigravityAuthentication =
    isAntigravity && provider.status === "warning" && provider.auth.status === "unknown";
  const isPendingInitialProbe =
    provider.enabled && !provider.installed && provider.status === "warning";
  const isIncompleteInstalledProbe =
    provider.installed &&
    (provider.status === "error" || (isCodex && provider.status === "warning"));
  return isPendingAntigravityAuthentication || isPendingInitialProbe || isIncompleteInstalledProbe;
};

const shouldRetainMissingOpenCodeMetadata = (provider: ServerProvider): boolean =>
  provider.driver === ProviderDriverKind.make("opencode") &&
  shouldRetainMissingProviderModels(provider);

const mergeProviderModels = (
  provider: ServerProvider,
  previousModels: ReadonlyArray<ServerProvider["models"][number]>,
  nextModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const shouldRetainMissingModels = shouldRetainMissingProviderModels(provider);
  // Custom rows are derived from settings and every snapshot carries the full
  // current list, so a custom model missing from `nextModels` was removed by
  // the user and must not be resurrected from the previous snapshot.
  // A model the installed CLI is too old to run was offered by the pending
  // snapshot, before the version was known; retaining it would make it
  // selectable again.
  const updateRequiredSlugs = new Set(provider.updateRequiredModels?.map((model) => model.slug));
  const retainablePreviousModels = previousModels.filter(
    (model) => !model.isCustom && !updateRequiredSlugs.has(model.slug),
  );

  if (shouldRetainMissingModels && nextModels.length === 0 && retainablePreviousModels.length > 0) {
    return retainablePreviousModels;
  }

  const previousBySlug = new Map(previousModels.map((model) => [model.slug, model] as const));
  const mergedModels = nextModels.map((model) => {
    const previousModel = previousBySlug.get(model.slug);
    if (!previousModel || hasModelCapabilities(model) || !hasModelCapabilities(previousModel)) {
      return model;
    }
    return {
      ...model,
      capabilities: previousModel.capabilities,
    };
  });
  const nextSlugs = new Set(nextModels.map((model) => model.slug));
  return shouldRetainMissingModels
    ? [...mergedModels, ...retainablePreviousModels.filter((model) => !nextSlugs.has(model.slug))]
    : mergedModels;
};

/**
 * Antigravity's health check only initializes the agent, so after a server
 * restart it reports the account as unchecked. The saved Google login still
 * works, and the previous snapshot proves it. Carry that account state until
 * a session, refresh, or sign-out reports something new. A confirmed missing
 * installation, sign-out, disabled instance, or a changed sign-in method is
 * never overridden.
 */
const carrySavedAntigravityAccount = (
  previousProvider: ServerProvider,
  nextProvider: ServerProvider,
): Pick<ServerProvider, "auth" | "status"> | undefined => {
  const antigravity = ProviderDriverKind.make("antigravity");
  if (
    nextProvider.driver !== antigravity ||
    previousProvider.driver !== antigravity ||
    !nextProvider.enabled ||
    nextProvider.auth.status !== "unknown" ||
    previousProvider.auth.status !== "authenticated" ||
    (nextProvider.auth.type !== undefined &&
      nextProvider.auth.type !== previousProvider.auth.type) ||
    (!nextProvider.installed && nextProvider.status !== "warning")
  ) {
    return undefined;
  }
  // The pending boot probe (`installed: false`, warning) and a failed probe
  // keep their own status; only a passed health check reads as ready.
  const status =
    nextProvider.installed && nextProvider.status === "warning" ? "ready" : nextProvider.status;
  return { auth: previousProvider.auth, status };
};

export const mergeProviderSnapshot = (
  previousProvider: ServerProvider | undefined,
  nextProvider: ServerProvider,
): ServerProvider => {
  if (!previousProvider) {
    return nextProvider;
  }
  const savedAccount = carrySavedAntigravityAccount(previousProvider, nextProvider);
  // "Google account access is not checked yet" describes the probe, not the
  // account; it must not outlive the state it explained.
  const { message: _uncheckedMessage, ...nextWithoutMessage } = nextProvider;
  return {
    ...(savedAccount?.status === "ready" ? nextWithoutMessage : nextProvider),
    ...savedAccount,
    models: mergeProviderModels(nextProvider, previousProvider.models, nextProvider.models),
    ...(nextProvider.workspaceSnapshots !== undefined
      ? { workspaceSnapshots: nextProvider.workspaceSnapshots }
      : previousProvider.workspaceSnapshots !== undefined
        ? { workspaceSnapshots: previousProvider.workspaceSnapshots }
        : {}),
    ...(shouldRetainMissingOpenCodeMetadata(nextProvider)
      ? {
          slashCommands:
            nextProvider.slashCommands.length === 0
              ? previousProvider.slashCommands
              : nextProvider.slashCommands,
          skills: nextProvider.skills.length === 0 ? previousProvider.skills : nextProvider.skills,
        }
      : {}),
  };
};

export const mergeProviderSnapshots = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> => {
  const mergedProviders = new Map(
    previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
  );

  for (const provider of nextProviders) {
    mergedProviders.set(
      snapshotInstanceKey(provider),
      mergeProviderSnapshot(mergedProviders.get(snapshotInstanceKey(provider)), provider),
    );
  }

  return orderProviderSnapshots([...mergedProviders.values()]);
};

export const selectProvidersByKind = (
  providers: ReadonlyArray<ServerProvider>,
  providerKinds: ReadonlySet<ProviderDriverKind>,
): ReadonlyArray<ServerProvider> =>
  providers.filter((provider) => providerKinds.has(provider.driver));

const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

const correlateSnapshotWithSource = (
  source: ProviderSnapshotSource,
  snapshot: ServerProvider,
): Effect.Effect<ServerProvider> => {
  if (snapshot.instanceId !== source.instanceId) {
    return Effect.die(
      new Error(
        `Provider snapshot instance mismatch: source '${source.instanceId}' emitted '${snapshot.instanceId}'.`,
      ),
    );
  }
  if (snapshot.driver !== source.driverKind) {
    return Effect.die(
      new Error(
        `Provider snapshot driver mismatch for instance '${source.instanceId}': source '${source.driverKind}' emitted '${snapshot.driver}'.`,
      ),
    );
  }
  return Effect.succeed(snapshot);
};

/**
 * Key a snapshot for aggregation and persistence. Snapshot sources
 * must be correlated by instance id before reaching this map; missing
 * identities are defects, not runtime routing fallbacks.
 */
const snapshotInstanceKey = (provider: ServerProvider): ProviderInstanceId => {
  return provider.instanceId;
};

// Project a live `ProviderInstance` into the aggregator's consumption
// shape. Each call re-captures the instance's `snapshot` closures, so
// after `ProviderInstanceRegistry` rebuilds an instance (e.g. because
// its settings changed), a fresh source rides the new PubSub instead
// of a closed one.
const buildSnapshotSource = (instance: ProviderInstance): ProviderSnapshotSource => ({
  instanceId: instance.instanceId,
  driverKind: instance.driverKind,
  getSnapshot: instance.snapshot.getSnapshot,
  refresh: instance.snapshot.refresh,
  streamChanges: instance.snapshot.streamChanges,
});

export const layer = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const manifestService = yield* ModelManifest.ModelManifest;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const serviceScope = yield* Effect.scope;
    const config = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    // Aggregator PubSub — consumers (WS gateway, etc.) subscribe here for
    // coalesced updates across every instance.
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );

    // Boot-only: hydrate `providersRef` from the on-disk per-instance
    // cache so the UI has something to render during the first refresh.
    // Instances added post-boot skip this path; their first entry in
    // `providersRef` comes from the reactive `syncLiveSources` pass
    // below.
    const bootInstances = yield* instanceRegistry.listInstances;
    const bootSources = bootInstances.map(buildSnapshotSource);
    const fallbackProviders = yield* loadProviders(bootSources);
    const fallbackByInstance = new Map<ProviderInstanceId, ServerProvider>();
    for (let index = 0; index < fallbackProviders.length; index++) {
      const provider = fallbackProviders[index];
      const source = bootSources[index];
      if (provider === undefined || source === undefined) {
        continue;
      }
      fallbackByInstance.set(source.instanceId, provider);
    }

    const cachedProviders = yield* Effect.forEach(
      bootSources,
      (source) =>
        Effect.gen(function* () {
          // One cache file per configured instance. For the default
          // instance of a built-in kind the path equals `<kind>.json` —
          // identical to the legacy filename. We still require the cache
          // payload to carry matching instance id + driver kind; old
          // identity-less payloads are discarded and the awaited refresh
          // below repopulates the cache.
          const filePath = yield* resolveProviderStatusCachePath({
            cacheDir: config.providerStatusCacheDir,
            instanceId: source.instanceId,
          }).pipe(Effect.provideService(Path.Path, path));
          const fallbackProvider = fallbackByInstance.get(source.instanceId);
          if (fallbackProvider === undefined) {
            return undefined;
          }
          return yield* readProviderStatusCache(filePath).pipe(
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.flatMap((cachedProvider) => {
              if (cachedProvider === undefined) {
                return Effect.void.pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              const correlation = {
                cachedProvider,
                fallbackProvider,
              } as const;
              if (!isCachedProviderCorrelated(correlation)) {
                return Effect.logWarning("provider status cache identity mismatch, ignoring", {
                  path: filePath,
                  instanceId: source.instanceId,
                  cachedInstanceId: cachedProvider.instanceId ?? null,
                  driver: source.driverKind,
                  cachedDriver: cachedProvider.driver ?? null,
                }).pipe(Effect.as(undefined as ServerProvider | undefined));
              }
              return Effect.succeed(hydrateCachedProvider(correlation));
            }),
          );
        }),
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const initialManifest = yield* manifestService.current;
    const classifyCompatibility = (
      provider: ServerProvider,
      manifest: ModelManifest.ModelManifestData,
    ) =>
      applyProviderCompatibility(
        provider,
        manifest.compatibility,
        ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
      );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      cachedProviders.map((provider) => classifyCompatibility(provider, initialManifest)),
    );
    // Instances showing the last run's answer from the cache: this run's placeholder (probePending) does not
    // replace it, so engine.list never reads "checking" for an engine it knew; the first probe, or a rebuild
    // (settings changed what is probed), ends that.
    const cacheShownUntilProbed = new Set(
      cachedProviders.filter((provider) => provider.probePending !== true).map(snapshotInstanceKey),
    );
    const workspaceRefreshesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstance, ReadonlyMap<string, Deferred.Deferred<void>>>
    >(new Map());
    const maintenanceActionStatesRef = yield* Ref.make<
      ReadonlyMap<ProviderInstanceId, { readonly update?: ServerProviderUpdateState | undefined }>
    >(new Map());

    // Live-source registry — the dynamic counterpart to the boot-time
    // `bootSources`. Keyed by `instanceId`; the stored `ProviderInstance`
    // reference is used for identity equality so "no-op" reconciles
    // (settings unchanged) skip re-subscribing + re-probing.
    const liveSubsRef = yield* Ref.make<ReadonlyMap<ProviderInstanceId, ProviderInstance>>(
      new Map(),
    );
    // Serialize `syncLiveSources` so a rapid burst of reconciles doesn't
    // interleave two passes clobbering each other's fiber bookkeeping.
    const syncSemaphore = yield* Semaphore.make(1);

    const persistProvider = (provider: ServerProvider) =>
      Effect.gen(function* () {
        // Persist every instance — the file name is the instance id, so
        // multi-instance setups (e.g. `codex_personal`, `codex_work`) each
        // get their own cache. We resolve the path fresh so snapshots
        // produced by newly-added instances post-boot still land on disk
        // without the aggregator holding a stale `cachePathByInstance`
        // entry.
        const key = snapshotInstanceKey(provider);
        const filePath = yield* resolveProviderStatusCachePath({
          cacheDir: config.providerStatusCacheDir,
          instanceId: key,
        }).pipe(Effect.provideService(Path.Path, path));
        const { workspaceSnapshots: _workspaceSnapshots, ...machineProvider } = provider;
        yield* writeProviderStatusCache({ filePath, provider: machineProvider }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.tapError(Effect.logError),
          Effect.ignore,
        );
      });

    const applyProviderUpdateState = Effect.fn("applyProviderUpdateState")(function* (
      provider: ServerProvider,
    ) {
      const maintenanceActionStates = yield* Ref.get(maintenanceActionStatesRef);
      const updateState = maintenanceActionStates.get(provider.instanceId)?.update;
      if (!updateState) {
        const { updateState: _updateState, ...providerWithoutUpdateState } = provider;
        return providerWithoutUpdateState;
      }
      return {
        ...provider,
        updateState,
      };
    });

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
        readonly persist?: boolean;
        readonly replace?: boolean;
      },
    ) {
      const manifest = yield* manifestService.current;
      const nextProvidersWithUpdateState = yield* Effect.forEach(
        nextProviders,
        applyProviderUpdateState,
        {
          concurrency: "unbounded",
        },
      );
      const [previousProviders, providers, providersToPersist] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [snapshotInstanceKey(provider), provider] as const),
          );
          const updatedKeys = new Set<ProviderInstanceId>();

          for (const provider of nextProvidersWithUpdateState) {
            const key = snapshotInstanceKey(provider);
            if (provider.probePending === true && cacheShownUntilProbed.has(key) && mergedProviders.has(key)) continue;
            if (provider.probePending !== true) cacheShownUntilProbed.delete(key);
            updatedKeys.add(key);
            mergedProviders.set(
              key,
              options?.replace === true
                ? provider
                : mergeProviderSnapshot(mergedProviders.get(key), provider),
            );
          }

          const providers = orderProviderSnapshots(
            [...mergedProviders.values()].map((provider) =>
              classifyCompatibility(provider, manifest),
            ),
          );
          const providersToPersist = providers.filter((provider) =>
            updatedKeys.has(snapshotInstanceKey(provider)),
          );
          return [[previousProviders, providers, providersToPersist] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        if (options?.persist !== false) {
          yield* Effect.forEach(providersToPersist, persistProvider, {
            concurrency: "unbounded",
            discard: true,
          });
        }
        if (options?.publish !== false) {
          // A newer upsert may have committed and published during the cache write; never republish an older array.
          yield* PubSub.publish(changesPubSub, yield* Ref.get(providersRef));
        }
      }

      return providers;
    });

    const compatibilityRefreshRunning = yield* Ref.make(false);
    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const providers = yield* upsertProviders([provider], options);
      // Reclassify the current read model after fetching. Never republish the
      // probe captured before the fetch: a newer health result may have landed.
      if (!(yield* Ref.getAndSet(compatibilityRefreshRunning, true))) {
        yield* manifestService.refresh.pipe(
          Effect.andThen(upsertProviders([], { persist: false })),
          Effect.ensuring(Ref.set(compatibilityRefreshRunning, false)),
          Effect.forkIn(serviceScope),
        );
      }
      return providers;
    });

    const setProviderMaintenanceActionState = Effect.fn("setProviderMaintenanceActionState")(
      function* (input: {
        readonly instanceId: ProviderInstanceId;
        readonly action: "update";
        readonly state: ServerProviderUpdateState | null;
      }) {
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const previousActions = previous.get(input.instanceId);
          const nextActions = { ...previousActions };
          if (input.state === null || input.state.status === "idle") {
            delete nextActions[input.action];
          } else {
            nextActions[input.action] = input.state;
          }

          const next = new Map(previous);
          if (Object.keys(nextActions).length === 0) {
            next.delete(input.instanceId);
          } else {
            next.set(input.instanceId, nextActions);
          }
          return next;
        });

        const existingProviders = yield* Ref.get(providersRef);
        const matchingProvider = existingProviders.find(
          (candidate) => candidate.instanceId === input.instanceId,
        );
        if (!matchingProvider) {
          return existingProviders;
        }

        const nextProvider = yield* applyProviderUpdateState(matchingProvider);
        return yield* upsertProviders([nextProvider], {
          persist: false,
        });
      },
    );

    const isCurrentInstance = (instance: ProviderInstance) =>
      instanceRegistry
        .getInstance(instance.instanceId)
        .pipe(Effect.map((current) => current === instance));

    const refreshOneSource = Effect.fn("refreshOneSource")(function* (instance: ProviderInstance) {
      const providerSource = buildSnapshotSource(instance);
      // Enrichment can publish a newer snapshot before refresh returns its pre-enrichment
      // probe, so the later of the two is kept.
      const probe = yield* providerSource.refresh.pipe(
        Effect.flatMap((refreshed) =>
          providerSource.getSnapshot.pipe(
            Effect.map((current) => (current.checkedAt > refreshed.checkedAt ? current : refreshed)),
          ),
        ),
        Effect.exit,
      );
      // Settings can replace or remove the instance mid-probe; its late result or failure is
      // stale. The sync permit keeps a sync pass from replacing or pruning the row between the
      // check and the merge.
      return yield* syncSemaphore.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* isCurrentInstance(instance))) {
            return yield* Ref.get(providersRef);
          }
          const nextProvider = yield* probe;
          return yield* correlateSnapshotWithSource(providerSource, nextProvider).pipe(
            Effect.flatMap(syncProvider),
          );
        }),
      );
    });

    type RefreshAllCompletion = Deferred.Deferred<ReadonlyArray<ServerProvider>>;
    const refreshAllInFlightRef = yield* Ref.make<Option.Option<RefreshAllCompletion>>(
      Option.none(),
    );

    // Untargeted refreshes probe every live source, so any read-scoped client
    // can request them. Concurrent callers share one in-flight pass instead of
    // each starting their own set of provider processes.
    const refreshAll = Effect.fn("refreshAll")(function* () {
      const claimed = yield* Ref.modify(
        refreshAllInFlightRef,
        (
          inFlight,
        ): readonly [
          { readonly owner: boolean; readonly completion: RefreshAllCompletion },
          Option.Option<RefreshAllCompletion>,
        ] => {
          if (Option.isSome(inFlight)) {
            return [{ owner: false, completion: inFlight.value }, inFlight];
          }
          const completion = Deferred.makeUnsafe<ReadonlyArray<ServerProvider>>();
          return [{ owner: true, completion }, Option.some(completion)];
        },
      );
      if (claimed.owner) {
        // Detached so an interrupted first caller cannot cancel the pass that
        // other callers are already awaiting.
        yield* syncLiveSourcesBeforeRefresh.pipe(
          Effect.andThen(Ref.get(liveSubsRef)),
          Effect.flatMap((instances) =>
            Effect.forEach(instances.values(), (instance) => refreshOneSource(instance), {
              concurrency: "unbounded",
              discard: true,
            }),
          ),
          Effect.andThen(Ref.get(providersRef)),
          Effect.onExit((exit) =>
            Ref.set(refreshAllInFlightRef, Option.none()).pipe(
              Effect.andThen(Deferred.done(claimed.completion, exit)),
            ),
          ),
          Effect.forkDetach,
        );
      }
      return yield* Deferred.await(claimed.completion);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderDriverKind) {
      if (provider === undefined) {
        return yield* refreshAll();
      }
      // Kind-scoped refreshes target the default instance for that driver.
      yield* syncLiveSourcesBeforeRefresh;
      const instance = (yield* Ref.get(liveSubsRef)).get(defaultInstanceIdForDriver(provider));
      if (!instance) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(instance);
    });

    const refreshInstance = Effect.fn("refreshInstance")(function* (
      instanceId: ProviderInstanceId,
    ) {
      yield* syncLiveSourcesBeforeRefresh;
      const instance = (yield* Ref.get(liveSubsRef)).get(instanceId);
      if (!instance) {
        return yield* Ref.get(providersRef);
      }
      return yield* refreshOneSource(instance);
    });

    const refreshAfterUpdate = Effect.fn("refreshAfterUpdate")(function* (
      provider: ProviderDriverKind,
      selectedInstanceId: ProviderInstanceId,
    ) {
      yield* manifestService.forceRefresh;
      const instances = (yield* instanceRegistry.listInstances).filter(
        (instance) =>
          instance.driverKind === provider &&
          (instance.enabled || instance.instanceId === selectedInstanceId),
      );
      const failedInstances = new Set<ProviderInstanceId>();
      const recoverInstanceFailure = Effect.fn("recoverPostUpdateRefreshFailure")(function* (
        instance: ProviderInstance,
        cause: Cause.Cause<unknown>,
      ) {
        if (Cause.hasInterruptsOnly(cause)) {
          return yield* Effect.interrupt;
        }
        const instanceId = instance.instanceId;
        yield* Effect.logError("provider post-update refresh failed", {
          instanceId,
          cause: Cause.pretty(cause),
        });
        failedInstances.add(instanceId);
        // A cached ready snapshot cannot verify a successful update. A retired instance's
        // failure says nothing about its replacement, which owns the row now (see
        // refreshOneSource).
        return yield* syncSemaphore.withPermits(1)(
          Effect.gen(function* () {
            if (!(yield* isCurrentInstance(instance))) {
              return yield* Ref.get(providersRef);
            }
            return yield* updateProviders((providers) =>
              providers.map((candidate) =>
                candidate.instanceId === instanceId
                  ? {
                      ...candidate,
                      status: "error",
                      message: "Provider refresh failed after update.",
                    }
                  : candidate,
              ),
            );
          }),
        );
      });
      // Accounts can share an installation, but discovery must use each
      // instance's own executable, environment, and credentials.
      yield* Effect.forEach(
        instances,
        (instance) =>
          Effect.gen(function* () {
            yield* instance.invalidateCaches ?? Effect.void;
            const maintenance = yield* instance.snapshot.resolveMaintenance({ fresh: true });
            // Both the npm entry and the installer's own answer (pnpm's eligible release).
            yield* Effect.forEach(
              latestProviderVersionCacheKeys(maintenance),
              latestVersions.invalidate,
              { discard: true },
            );
          }).pipe(Effect.catchCause((cause) => recoverInstanceFailure(instance, cause))),
        { concurrency: "unbounded", discard: true },
      );
      yield* Effect.forEach(
        instances.filter((instance) => !failedInstances.has(instance.instanceId)),
        (instance) =>
          refreshOneSource(instance).pipe(
            Effect.catchCause((cause) => recoverInstanceFailure(instance, cause)),
          ),
        { concurrency: "unbounded", discard: true },
      );
      // A replaced instance's row did not come from this pass's probe.
      const refreshedInstances = yield* Effect.filter(
        instances.filter((instance) => !failedInstances.has(instance.instanceId)),
        isCurrentInstance,
      );
      const refreshedInstanceIds = new Set(
        refreshedInstances.map((instance) => instance.instanceId),
      );
      return (yield* Ref.get(providersRef)).filter((candidate) =>
        refreshedInstanceIds.has(candidate.instanceId),
      );
    });

    const getProviderMaintenanceCapabilitiesForInstance = Effect.fn(
      "getProviderMaintenanceCapabilitiesForInstance",
    )(function* (
      instanceId: ProviderInstanceId,
      provider: ProviderDriverKind,
      options?: { readonly fresh?: boolean },
    ) {
      // Read the instance registry, not `liveSubsRef`: the latter trails
      // reconciliation, and an update must never run a retired instance's
      // command against a freshly configured executable.
      const instance = yield* instanceRegistry.getInstance(instanceId);
      if (!instance || instance.driverKind !== provider) {
        return makeManualProviderMaintenanceCapabilities(provider);
      }
      return yield* instance.snapshot.resolveMaintenance(options);
    });

    /**
     * Diff the aggregator's live-source set against the current
     * `ProviderInstanceRegistry` and:
     *   - subscribe to each newly-added or rebuilt instance's
     *     `streamChanges` (so periodic + enrichment refreshes land in
     *     `providersRef`);
     *   - read each newly-added/rebuilt instance's current snapshot after
     *     subscribing, closing the race with its independently-running
     *     background startup probe;
     *   - prune `providersRef` of instances that no longer exist.
     *
     * Provider refreshes are owned by each managed provider and never run
     * on this layer's construction path. Consumers see cached or pending
     * snapshots immediately, then receive live probe results through the
     * already-attached change stream.
     *
     * Per-instance subscription fibers are not tracked explicitly. When
     * a rebuilt instance's old child scope closes, its PubSub shuts
     * down and our `Stream.runForEach` fiber exits naturally.
     */
    const syncLiveSources = syncSemaphore.withPermits(1)(
      Effect.gen(function* () {
        const instances = yield* instanceRegistry.listInstances;
        const unavailableProviders = yield* instanceRegistry.listUnavailable;
        const nextByInstance = new Map<ProviderInstanceId, ProviderInstance>(
          instances.map((instance) => [instance.instanceId, instance] as const),
        );
        const knownInstanceIds = new Set<ProviderInstanceId>(nextByInstance.keys());
        for (const provider of unavailableProviders) {
          knownInstanceIds.add(snapshotInstanceKey(provider));
        }
        const previousSubs = yield* Ref.get(liveSubsRef);

        // Carry over subscriptions for instances whose identity is
        // unchanged (reconcile treated them as no-op). Instances that
        // disappeared, or were rebuilt with a different reference,
        // fall through to the "newly-added" branch below.
        const carriedOver = new Map<ProviderInstanceId, ProviderInstance>();
        for (const [instanceId, previousInstance] of previousSubs) {
          const nextInstance = nextByInstance.get(instanceId);
          if (nextInstance !== undefined && nextInstance === previousInstance) {
            carriedOver.set(instanceId, previousInstance);
          }
        }

        // Collect new/rebuilt instances in `nextByInstance` insertion
        // order (which preserves settings-author order).
        const newlyAdded: Array<readonly [ProviderInstanceId, ProviderInstance]> = [];
        for (const [instanceId, instance] of nextByInstance) {
          if (carriedOver.has(instanceId)) {
            continue;
          }
          newlyAdded.push([instanceId, instance] as const);
        }

        const rebuiltInstanceIds = new Set(
          newlyAdded
            .map(([instanceId]) => instanceId)
            .filter((instanceId) => previousSubs.has(instanceId)),
        );
        for (const instanceId of rebuiltInstanceIds) cacheShownUntilProbed.delete(instanceId);
        if (rebuiltInstanceIds.size > 0) {
          const [previousProviders, providers] = yield* Ref.modify(
            providersRef,
            (previousProviders) => {
              const providers = previousProviders.map((provider) => {
                if (!rebuiltInstanceIds.has(provider.instanceId)) return provider;
                const { workspaceSnapshots: _workspaceSnapshots, ...machineSnapshot } = provider;
                return machineSnapshot;
              });
              return [[previousProviders, providers] as const, providers];
            },
          );
          if (haveProvidersChanged(previousProviders, providers)) {
            yield* PubSub.publish(changesPubSub, providers);
          }
        }

        // Fork long-lived subscriptions to each new/rebuilt instance's
        // change stream before reading its current snapshot. If the
        // driver's own initial probe finishes during this sync, either
        // the current read or the active subscriber observes the result.
        for (const [, instance] of newlyAdded) {
          const source = buildSnapshotSource(instance);
          yield* Stream.runForEach(source.streamChanges, (provider) =>
            correlateSnapshotWithSource(source, provider).pipe(Effect.flatMap(syncProvider)),
          ).pipe(Effect.forkScoped);
        }
        yield* Effect.yieldNow;

        // Snapshot current state without starting a probe. Managed providers
        // launch their startup refresh independently, so this closes the
        // subscription race without putting external work on the registry
        // or HTTP server construction path.
        yield* Effect.forEach(
          newlyAdded,
          ([, instance]) =>
            Effect.gen(function* () {
              const source = buildSnapshotSource(instance);
              const provider = yield* source.getSnapshot;
              yield* correlateSnapshotWithSource(source, provider).pipe(
                Effect.flatMap(syncProvider),
              );
            }).pipe(Effect.ignoreCause({ log: true })),
          { concurrency: "unbounded", discard: true },
        );
        yield* upsertProviders(unavailableProviders, {
          persist: false,
          replace: true,
        });

        const nextSubs = new Map(carriedOver);
        for (const [instanceId, instance] of newlyAdded) {
          nextSubs.set(instanceId, instance);
        }
        yield* Ref.set(liveSubsRef, nextSubs);

        // Drop aggregator state for instances that have disappeared —
        // otherwise the UI would keep rendering ghosts.
        const [previousProviders, providers] = yield* Ref.modify(
          providersRef,
          (previousProviders) => {
            const providers = orderProviderSnapshots(
              previousProviders.filter((provider) =>
                knownInstanceIds.has(snapshotInstanceKey(provider)),
              ),
            );
            return [[previousProviders, providers] as const, providers];
          },
        );
        if (haveProvidersChanged(previousProviders, providers)) {
          yield* PubSub.publish(changesPubSub, providers);
        }
        yield* Ref.update(maintenanceActionStatesRef, (previous) => {
          const next = new Map(previous);
          for (const instanceId of previous.keys()) {
            if (!knownInstanceIds.has(instanceId)) {
              next.delete(instanceId);
            }
          }
          return next;
        });
      }),
    );
    const syncLiveSourcesAndContinue = syncLiveSources.pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Effect.interrupt;
        }
        return Effect.logError(
          "provider registry instance sync failed; keeping subscription alive",
          {
            cause: Cause.pretty(cause),
          },
        );
      }),
    );
    // A refresh syncs first so it never probes an instance settings replaced. The
    // subscriptions that sync attaches belong to the service, not to the caller.
    const syncLiveSourcesBeforeRefresh = syncLiveSourcesAndContinue.pipe(
      Scope.provide(serviceScope),
    );

    // Seed `providersRef` with the boot-time fallback snapshots so
    // consumers calling `getProviders` immediately after layer build see
    // a populated list — even before the first `syncLiveSources` refresh
    // resolves. Cached snapshots (already in `providersRef`) merge with
    // these via `upsertProviders` so on-disk state wins where present
    // and pending fallbacks fill the gaps.
    yield* upsertProviders(fallbackProviders, { publish: false });
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the dequeue synchronously in this
    // fibre; the subscription is active the instant this `yield*`
    // returns. Forking the consumer loop later cannot lose a publish
    // because no publish can reach a not-yet-subscribed dequeue.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `Stream.fromPubSub` defers `PubSub.subscribe` to stream start,
    // and `forkScoped` only schedules the fibre — so a reconcile that
    // published between "fibre scheduled" and "fibre starts running"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    // Subscribe to registry mutations BEFORE running the initial sync.
    // `subscribeChanges` acquires the `PubSub.Subscription` synchronously
    // in this fibre; the subscription is registered with the PubSub the
    // instant this `yield*` returns, so any subsequent publish is
    // buffered in the subscription regardless of when the consumer
    // fibre below actually starts running.
    //
    // (Contrast with the pre-fix code that did
    // `Stream.runForEach(instanceRegistry.streamChanges, …).pipe(Effect.forkScoped)`.
    // `instanceRegistry.streamChanges` is `Stream.fromPubSub(changes)`,
    // which defers `PubSub.subscribe` to stream start. `forkScoped` only
    // schedules the consumer fibre — so a reconcile that published
    // between "fibre scheduled" and "fibre starts running + subscribes"
    // was dropped, which made any settings change that replaced an
    // instance never propagate to the aggregator's `providersRef`.)
    const instanceChanges = yield* instanceRegistry.subscribeChanges;
    // Initial sync attaches subscriptions and snapshots current state for
    // every instance present at boot. Provider probes are already running in
    // their managed background fibers and never block this layer.
    yield* syncLiveSources;
    // React to registry mutations — instance added / removed / rebuilt.
    // `Stream.fromSubscription` builds a stream over the pre-acquired
    // subscription rather than subscribing on stream start, which is
    // what closes the race.
    yield* Stream.runForEach(
      Stream.fromSubscription(instanceChanges),
      () => syncLiveSourcesAndContinue,
    ).pipe(Effect.forkScoped);

    const recoverRefreshFailure = Effect.fn("recoverRefreshFailure")(function* (
      cause: Cause.Cause<unknown>,
    ) {
      if (Cause.hasInterruptsOnly(cause)) {
        return yield* Effect.interrupt;
      }
      yield* Effect.logError("provider registry refresh failed; preserving cached providers", {
        cause: Cause.pretty(cause),
      });
      return yield* Ref.get(providersRef);
    });

    const updateProviders = (
      update: (providers: ReadonlyArray<ServerProvider>) => ReadonlyArray<ServerProvider>,
    ) =>
      Ref.modify(providersRef, (currentProviders) => {
        const nextProviders = update(currentProviders);
        return [[currentProviders, nextProviders] as const, nextProviders];
      }).pipe(
        Effect.tap(([previousProviders, nextProviders]) =>
          haveProvidersChanged(previousProviders, nextProviders)
            ? PubSub.publish(changesPubSub, nextProviders)
            : Effect.void,
        ),
        Effect.map(([, nextProviders]) => nextProviders),
      );

    const refreshWorkspaceSnapshot = Effect.fn("refreshWorkspaceSnapshot")(function* (input: {
      readonly instanceId: ProviderInstanceId;
      readonly cwd: string;
      readonly fresh?: boolean;
    }) {
      // Fresh scans drop other instances' snapshots for this cwd first, so a
      // composer on one of them scans again on next use, even when this
      // instance is gone or cannot be scanned.
      if (input.fresh) {
        yield* updateProviders((providers) =>
          providers.map((candidate) =>
            candidate.instanceId === input.instanceId
              ? candidate
              : dropProviderWorkspaceSnapshot(candidate, input.cwd),
          ),
        );
      }
      const providers = yield* Ref.get(providersRef);
      const provider = providers.find((candidate) => candidate.instanceId === input.instanceId);
      const workspaceSnapshotOf = (candidate: ServerProvider | undefined) =>
        candidate?.workspaceSnapshots?.find((s) => s.cwd === input.cwd);
      const scannedFrom = workspaceSnapshotOf(provider);
      const now = yield* DateTime.now;
      if (
        !provider ||
        !provider.enabled ||
        (!input.fresh &&
          scannedFrom &&
          !scannedFrom.slashCommandsPending &&
          isProviderWorkspaceSnapshotCurrent(scannedFrom, DateTime.toEpochMillis(now)))
      ) {
        return providers;
      }
      // Drivers spread their machine snapshot, whose `checkedAt` is the last
      // health check. The TTL needs the time this scan started reading files.
      const scannedAt = DateTime.formatIso(now);
      const instance = yield* instanceRegistry.getInstance(input.instanceId);
      if (!instance?.snapshotForCwd) return providers;
      const token = yield* Deferred.make<void>();
      // Fresh scans also re-read the machine snapshot after invalidating caches.
      const refreshMachineSnapshot = input.fresh
        ? (instance.invalidateCaches ?? Effect.void).pipe(
            Effect.andThen(refreshInstance(input.instanceId)),
          )
        : Effect.void;
      const runScan = refreshMachineSnapshot.pipe(
        Effect.andThen(instance.snapshotForCwd(input.cwd)),
        // A failed scan fails this effect, so a returned snapshot is a real
        // inventory even while the provider's health check reports an error.
        Effect.flatMap((scopedSnapshot) =>
          instanceRegistry.getInstance(input.instanceId).pipe(
            Effect.flatMap((currentInstance) => {
              if (currentInstance !== instance) return Ref.get(providersRef);
              return updateProviders((currentProviders) => {
                // Read ownership inside the update so a newer claim cannot race publication.
                if (Ref.getUnsafe(workspaceRefreshesRef).get(instance)?.get(input.cwd) !== token) {
                  return currentProviders;
                }
                // Write only if the cwd's snapshot did not change during the
                // scan. A session event or another scan that landed first is newer.
                return currentProviders.map((candidate) =>
                  candidate.instanceId === input.instanceId &&
                  Equal.equals(workspaceSnapshotOf(candidate), scannedFrom)
                    ? upsertProviderWorkspaceSnapshot(candidate, input.cwd, {
                        ...scopedSnapshot,
                        checkedAt: scannedAt,
                        // Unless the driver reports its own command discovery,
                        // commands come from the health check. A failed check
                        // leaves them unknown, so keep the last ones and retry.
                        slashCommandsPending:
                          scopedSnapshot.slashCommandsPending ?? scopedSnapshot.status === "error",
                      })
                    : candidate,
                );
              });
            }),
          ),
        ),
        Effect.ensuring(
          Ref.update(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            if (current?.get(input.cwd) !== token) return refreshes;
            const next = new Map(refreshes);
            const nextCwds = new Map(current);
            nextCwds.delete(input.cwd);
            if (nextCwds.size) next.set(instance, nextCwds);
            else next.delete(instance);
            return next;
          }).pipe(Effect.andThen(Deferred.succeed(token, undefined))),
        ),
      );
      // The claim and the fork happen together, so the token is always completed. The scan is
      // detached so a disconnecting caller cannot cancel the result other callers wait on.
      const claim = yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const inFlight = yield* Ref.modify(workspaceRefreshesRef, (refreshes) => {
            const current = refreshes.get(instance);
            const running = current?.get(input.cwd);
            // A fresh scan never joins a running one, which may predate the change.
            if (!input.fresh && running) return [running, refreshes] as const;
            const next = new Map(refreshes);
            next.set(instance, new Map(current).set(input.cwd, token));
            return [undefined, next] as const;
          });
          if (inFlight) return { inFlight } as const;
          return {
            // Starting now attaches the scan's `ensuring` before anything can close the scope.
            scan: yield* Effect.forkIn(runScan, serviceScope, { startImmediately: true }),
          } as const;
        }),
      );
      // Wait for the running scan, so this caller gets its result instead of the snapshot before it.
      if ("inFlight" in claim) {
        return yield* Deferred.await(claim.inFlight).pipe(Effect.andThen(Ref.get(providersRef)));
      }
      return yield* Fiber.join(claim.scan);
    });

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderDriverKind) =>
        refresh(provider).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshInstance: (instanceId: ProviderInstanceId) =>
        refreshInstance(instanceId).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshWorkspaceSnapshot: (input) =>
        refreshWorkspaceSnapshot(input).pipe(Effect.catchCause(recoverRefreshFailure)),
      refreshAfterUpdate,
      getProviderMaintenanceCapabilitiesForInstance,
      setProviderMaintenanceActionState,
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistry["Service"];
  }),
);
