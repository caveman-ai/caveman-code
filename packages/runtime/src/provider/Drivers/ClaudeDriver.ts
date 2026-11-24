// ), apps/server/src/provider/Drivers/ClaudeDriver.ts @ ab3a3cd1; perf from 76ff0eb2a1, 6e45544850.
/**
 * ClaudeDriver — `ProviderDriver` for the Claude Agent SDK runtime.
 *
 * Mirrors `CodexDriver`: a plain value whose `create()` returns one
 * `ProviderInstance` bundling `snapshot` / `adapter` / `textGeneration`
 * closures captured over the per-instance `ClaudeSettings`.
 *
 * Unlike Codex, the Claude snapshot probe may invoke a secondary probe
 * (`probeClaudeCapabilities`) to read Anthropic account + slash-command
 * metadata. That probe is per-instance and keyed by binary + resolved HOME so
 * two concurrent Claude instances don't cross-contaminate account metadata.
 *
 * @module provider/Drivers/ClaudeDriver
 */
import { ClaudeSettings, ProviderDriverKind } from "@caveman-app/protocol";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import { makeClaudeTextGeneration } from "../../textGeneration/ClaudeTextGeneration.ts";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@caveman-app/engine-core/server/pathExpansion";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import {
  createClaudeAdapterV2,
  type ClaudeAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import { resolveClaudeCliPath } from "./ClaudeExecutable.ts";
import { claudeUsageReader } from "./claudeUsage.ts";
import { makeClaudeScopedLimitNames } from "../claudeUsageLimits.ts";
import {
  checkClaudeProviderStatus,
  makePendingClaudeProvider,
  probeClaudeCapabilities,
  probeClaudeWorkspaceSnapshot,
} from "../ClaudeProvider.ts";
import { makeManagedServerProvider } from "@caveman-app/engine-core/server/managedProvider";
import * as ModelCatalog from "@caveman-app/engine-core/server/ModelCatalog";
import {
  rememberClaudeModelCatalog,
  resolveClaudeModelCatalog,
  withLearnedClaudeModels,
  withNewestClaudeCode,
} from "../ClaudeModelCatalog.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@caveman-app/engine-core/server/driver";
import { withInstanceIdentity } from "@caveman-app/engine-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@caveman-app/engine-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveLatestProviderVersion,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@caveman-app/engine-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@caveman-app/engine-core/server/snapshotSettings";
import {
  makeClaudeCapabilitiesCacheKey,
  makeClaudeContinuationGroupKey,
} from "./ClaudeHome.ts";
import * as HostProcess from "@caveman-app/shared/HostProcess";
const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CAPABILITIES_PROBE_TTL = Duration.minutes(5);

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  npmPackageName: "@anthropic-ai/claude-code",
  nativeUpdate: {
    args: ["update"],
    isCommandPath: isClaudeNativeCommandPath,
  },
});

export type ClaudeDriverEnv =
  | ClaudeAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig;

export const ClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Claude Agent",
    supportsMultipleInstances: true,
  },
  configSchema: ClaudeSettings,
  defaultConfig: (): ClaudeSettings => decodeClaudeSettings({}),
  usage: claudeUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // Instance-level probes are not tied to a project, so they run in the
      // server's own state dir. The server cwd is $HOME in packaged desktop
      // builds, and `claude` wrappers that scope themselves to their cwd refuse
      // to run there. Workspace probes use the thread cwd via `snapshotForCwd`.
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const catalogService = yield* ModelCatalog.ModelCatalog;
      // Sessions compile against the catalog this resolves (claudeModelCatalogNow).
      const modelCatalog = catalogService.current(DRIVER_KIND).pipe(
        Effect.map((catalog) => resolveClaudeModelCatalog(catalog)),
        Effect.tap((catalog) => Effect.sync(() => rememberClaudeModelCatalog(catalog))),
      );
      const processEnv = yield* mergeProviderInstanceEnvironment(environment);
      const fallbackContinuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      // Resolved once, so sessions, probes, text generation and update
      // ownership all describe the same `claude` (past cmux's PATH shim).
      const effectiveConfig = {
        ...config,
        enabled,
        binaryPath: yield* resolveClaudeCliPath(
          expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
          processEnv,
        ),
      } satisfies ClaudeSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const continuationGroupKey = yield* makeClaudeContinuationGroupKey(
        effectiveConfig,
        processEnv,
      );
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey,
      });

      const scopedLimitNames = yield* makeClaudeScopedLimitNames;
      const orchestrationAdapter = yield* createClaudeAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config: effectiveConfig,
        },
        { scopedLimitNames, onUsageLimits: (update) => snapshot.applyUsageLimits(update) },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Claude Agent orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeClaudeTextGeneration(
        effectiveConfig,
        processEnv,
        modelCatalog.pipe(Effect.map(withLearnedClaudeModels)),
      );

      // Per-instance capabilities cache: keyed on binary + resolved HOME so
      // account-specific probes never share auth metadata across instances.
      // Account metadata comes from the `claude` binary only. The runtime
 // never reads Claude's login files (Caveman Code product rule), so upstream
      // last-good fallback, which checks the logged-in organization in them
      // before reusing an account, is left out: a failed probe is just retried.
      const capabilitiesProbeCache = yield* Cache.makeWith(
        () => probeClaudeCapabilities(effectiveConfig, processEnv, stateDir),
        {
          capacity: 1,
          // Only a probe that answered with usage earns the TTL. A failure (a
          // timeout on a busy machine) or a usage read that did not answer is
          // asked again on the next check instead of standing for five minutes.
          timeToLive: (exit) =>
            Exit.isSuccess(exit) && exit.value.usage !== undefined
              ? CAPABILITIES_PROBE_TTL
              : Duration.zero,
        },
      );
      const capabilitiesCacheKey = yield* makeClaudeCapabilitiesCacheKey(
        effectiveConfig,
        stateDir,
        processEnv,
      );
      const resolveCapabilities = Cache.get(capabilitiesProbeCache, capabilitiesCacheKey);

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      // The newest Claude Code, for models found on models.dev (withNewestClaudeCode): the
      // version advisory's own lookup, cached for an hour, and only with update checks on.
      const newestClaudeCode = snapshotSettings.getSettings.pipe(
        Effect.flatMap((settings) =>
          settings.enableProviderUpdateChecks
            ? resolveMaintenance().pipe(Effect.flatMap(resolveLatestProviderVersion))
            : Effect.succeed(null),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        Effect.orElseSucceed(() => null),
      );

      // Start the TTL-gated refresh without delaying provider readiness. The
      // next check observes a remote manifest, and models.dev's new releases,
      // after the background fetch lands.
      const checkProvider = catalogService.refreshInBackground.pipe(
        Effect.andThen(
          modelCatalog.pipe(
            Effect.flatMap((catalog) =>
              catalog.models.some((entry) => entry.discovered)
                ? newestClaudeCode.pipe(Effect.map((newest) => withNewestClaudeCode(catalog, newest)))
                : Effect.succeed(catalog),
            ),
            Effect.flatMap((catalog) =>
              checkClaudeProviderStatus(
                effectiveConfig,
                () => resolveCapabilities,
                processEnv,
                stateDir,
                catalog,
                scopedLimitNames,
              ),
            ),
            // A signed-out answer is not kept: signing in shows on the next check.
            Effect.tap((provider) =>
              provider.auth.status === "unauthenticated"
                ? Cache.invalidateAll(capabilitiesProbeCache)
                : Effect.void,
            ),
            Effect.map(stampIdentity),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );

      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<ClaudeSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          modelCatalog.pipe(
            Effect.flatMap((catalog) => makePendingClaudeProvider(settings.provider, catalog)),
            Effect.map(stampIdentity),
          ),
        checkProvider,
        invalidateUsageCache: Cache.invalidateAll(capabilitiesProbeCache),
        enrichSnapshot: ({ settings, snapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichProviderSnapshotWithVersionAdvisory(snapshot, maintenanceCapabilities, {
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              }),
            ),
            Effect.provideService(HttpClient.HttpClient, httpClient),
            Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
            Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Claude snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity: {
          ...fallbackContinuationIdentity,
          continuationKey: continuationGroupKey,
        },
        displayName,
        accentColor,
        enabled,
        snapshot,
        invalidateCaches: Cache.invalidateAll(capabilitiesProbeCache),
        snapshotForCwd: (cwd: string) =>
          snapshot.getSnapshot.pipe(
            Effect.flatMap((machineSnapshot) =>
              probeClaudeWorkspaceSnapshot(effectiveConfig, machineSnapshot, cwd, processEnv),
            ),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          ),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
