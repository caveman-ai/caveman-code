// ), apps/server/src/provider/Drivers/CodexDriver.ts @ ab3a3cd1.
/**
 * CodexDriver — first concrete `ProviderDriver` in the new per-instance model.
 *
 * A driver is a plain value (not a Context.Service) whose `create()` returns
 * one `ProviderInstance` bundling:
 *   - `snapshot`   — the live `ManagedServerProvider` for this instance;
 *   - `adapter`    — the Codex session/turn/approval runtime;
 *   - `textGeneration` — commit/PR/branch/title generation via `codex exec`.
 *
 * Each call to `create()` captures the `codexConfig` argument in closures
 * owned by the returned instance. Two instances created with different
 * `homePath`s (e.g. `codex_personal` + `codex_work`) therefore run with
 * fully independent Codex app-server processes and `CODEX_HOME`
 * environments — no shared mutable state.
 *
 * Resource lifecycle: `create()` runs in a scope handed in by the registry.
 * Closing that scope releases the adapter's child processes, the managed
 * snapshot's refresh fibre, and the text-generation binaries' transient
 * scratch files. The registry uses this to tear down an instance when its
 * `providerInstances` entry disappears or its config changes.
 *
 * @module provider/Drivers/CodexDriver
 */
import { CodexSettings, ProviderDriverKind } from "@caveman-app/protocol";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";

import type * as CodexUsageHistory from "../../usage/CodexUsageHistory.ts";
import { makeCodexTextGeneration } from "../../textGeneration/CodexTextGeneration.ts";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as ServerConfig from "../../config.ts";
import { expandHomePath } from "@caveman-app/engine-core/server/pathExpansion";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import {
  createCodexAdapterV2,
  type CodexAdapterV2DriverEnv,
} from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ProviderDriverError } from "../Errors.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
  withCodexAppServerClient,
} from "../CodexProvider.ts";
import { resolveCodexLaunchArgs } from "../codexLaunchArgs.ts";
import { makeManagedServerProvider } from "@caveman-app/engine-core/server/managedProvider";
import * as ModelCatalog from "@caveman-app/engine-core/server/ModelCatalog";
import { applyCodexModelCatalog } from "../codexModelCatalog.ts";
import type { ProviderDriver, ProviderInstance } from "@caveman-app/engine-core/server/driver";
import { withInstanceIdentity } from "@caveman-app/engine-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@caveman-app/engine-core/server/instanceEnvironment";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@caveman-app/engine-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@caveman-app/engine-core/server/snapshotSettings";
import {
  codexContinuationIdentity,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./CodexHomeLayout.ts";
import { codexUsageReader } from "./codexUsage.ts";
import {
  ensureCodexManagedHome,
  makeCodexApiKeyAuth,
  resolveCodexLaunch,
} from "../CodexApiKeyAccount.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostProcess from "@caveman-app/shared/HostProcess";
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

const DRIVER_KIND = ProviderDriverKind.make("codex");
// The standalone installer lays out `<CODEX_HOME>/packages/standalone/…`;
// CODEX_HOME is not always `~/.codex`.
function isCodexStandaloneCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/packages/standalone/");
}

/**
 * `codex update` replaces the standalone tree under `CODEX_HOME`. That tree
 * lives in the shared home even when an auth-overlay shadow home is in use
 * (the overlay only carries auth and a few local entries), so the updater
 * runs against `sharedHomePath` rather than the instance's effective home.
 */
function makeCodexMaintenanceResolver(sharedHomePath: string) {
  return makePackageManagedProviderMaintenanceResolver({
    provider: DRIVER_KIND,
    npmPackageName: "@openai/codex",
    nativeUpdate: {
      args: ["update"],
      isCommandPath: isCodexStandaloneCommandPath,
      requiresCommandPath: true,
      env: { CODEX_HOME: sharedHomePath },
    },
  });
}

/**
 * Services the driver needs to materialize an instance. Surfaced as the
 * driver's `R` so the registry layer aggregates these across every
 * registered driver and the runtime satisfies them once.
 */
export type CodexDriverEnv =
  | CodexAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | ResetCreditCoordinator.ResetCreditCoordinator
  | Digest.Digest
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | ModelCatalog.ModelCatalog
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers
  | ServerConfig.ServerConfig
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironmentIdentity;

export const CodexDriver: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | ServerConfig.ServerConfig | CodexUsageHistory.CodexUsageHistory
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Codex",
    supportsMultipleInstances: true,
  },
  configSchema: CodexSettings,
  defaultConfig: (): CodexSettings => decodeCodexSettings({}),
  usage: codexUsageReader,
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const resetCreditCoordinator = yield* ResetCreditCoordinator.ResetCreditCoordinator;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
      const modelCatalog = yield* ModelCatalog.ModelCatalog;
      const currentCatalog = modelCatalog.current(DRIVER_KIND);
      // API-key accounts (the default) launch in an app-managed home; the
 // user's own login (`chatGptLogin`) keeps upstream behaviour.
      const launch = resolveCodexLaunch({
        path: pathService,
        stateDir: (yield* ServerConfig.ServerConfig).stateDir,
        instanceId,
        config,
        environment: yield* mergeProviderInstanceEnvironment(environment),
      });
      const processEnv = launch.environment;
      yield* ensureCodexManagedHome(launch).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not prepare the Codex home for this account.",
              cause,
            }),
        ),
      );
      // The user's own login with no home configured runs in the instance's CODEX_HOME, when its
      // environment sets one (a managed home strips it), so each account keeps its own continuations.
      const environmentHome = processEnv.CODEX_HOME;
      const homeLayout = yield* resolveCodexHomeLayout(
        !launch.config.homePath.trim() &&
          !launch.config.shadowHomePath.trim() &&
          environmentHome?.trim()
          ? { ...launch.config, homePath: environmentHome }
          : launch.config,
      );
      const continuationIdentity = codexContinuationIdentity(homeLayout);
      const stampInstance = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      // An API-key account signs in and out inside the app.
      const stampIdentity: typeof stampInstance = (draft) => {
        const snapshot = stampInstance(draft);
        return launch.managed
          ? {
              ...snapshot,
              setup: { canAuthenticate: true, canInstall: false },
              auth: { ...snapshot.auth, canLogout: snapshot.auth.status === "authenticated" },
            }
          : snapshot;
      };
      yield* materializeCodexShadowHome(homeLayout).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: cause.message,
              cause,
            }),
        ),
      );
      const effectiveConfig = {
        ...launch.config,
        enabled,
        binaryPath: expandHomePath(config.binaryPath, yield* HostProcess.HomeDirectory),
        homePath: homeLayout.effectiveHomePath ?? "",
      } satisfies CodexSettings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(
          // The installer lives in the user's own home, never the managed one.
          makeCodexMaintenanceResolver((yield* resolveCodexHomeLayout(config)).sharedHomePath),
          {
            binaryPath: effectiveConfig.binaryPath,
            env: processEnv,
          },
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      const orchestrationAdapter = yield* createCodexAdapterV2(
        {
          instanceId,
          displayName,
          accentColor,
          environment,
          enabled,
          config,
        },
        { onUsageLimits: (update) => snapshot.applyUsageLimits(update) },
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Codex orchestration adapter.",
              cause,
            }),
        ),
      );

      // Build a managed snapshot whose settings never change — mutations come
      // in as instance rebuilds from the registry rather than in-place
      // updates. Pre-provide `ChildProcessSpawner` so the check fits
      // `makeManagedServerProvider.checkProvider`'s `R = never`.
      // Kick the TTL-gated manifest refresh in the background and classify
      // with the in-memory manifest, so a slow or hung fetch never delays the
      // provider check. A refresh that lands mid-probe applies on the next one.
      const checkProvider = modelCatalog.refreshInBackground.pipe(
        Effect.andThen(
          Effect.zipWith(
            checkCodexProviderStatus(effectiveConfig, undefined, processEnv),
            currentCatalog,
            (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
            { concurrent: true },
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, pathService),
      );
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CodexSettings>>({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          Effect.zipWith(
            makePendingCodexProvider(settings.provider),
            currentCatalog,
            (draft, catalog) => stampIdentity(applyCodexModelCatalog(draft, catalog)),
          ),
        checkProvider,
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
              detail: `Failed to build Codex snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeCodexTextGeneration(
        effectiveConfig,
        processEnv,
        snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
      );
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([
              snapshot.getSnapshot,
              probeCodexSkillsForCwd({
                binaryPath: effectiveConfig.binaryPath,
                homePath: effectiveConfig.homePath,
                launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
                cwd,
                environment: processEnv,
              }).pipe(
                Effect.scoped,
                Effect.timeout("20 seconds"),
                Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              ),
            ]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to probe Codex skills for '${cwd}'`,
                    cause,
                  }),
              ),
            );

      // Redemption spends something on the user's account. It serialises on
      // the account (instances sharing a Codex home share the credit), keeps
      // one idempotency key until Codex reports an outcome, and is bounded so
      // a hung app-server cannot hold the account lock.
      // Keyed on the directory holding auth.json: an auth-overlay instance has
      // its own account under `effectiveHomePath`, while plain instances share
      // the common home. The continuation key would conflate the two.
      const accountKey = homeLayout.effectiveHomePath ?? homeLayout.sharedHomePath;
      const consumeResetCredit: NonNullable<ProviderInstance["consumeResetCredit"]> = () =>
        resetCreditCoordinator
          .redeem(accountKey, (idempotencyKey) =>
            Effect.gen(function* () {
              const { client } = yield* withCodexAppServerClient({
                binaryPath: effectiveConfig.binaryPath,
                homePath: effectiveConfig.homePath,
                launchArgs: resolveCodexLaunchArgs(effectiveConfig.launchArgs, processEnv),
                // Account-level request; any directory serves, same as the status probe.
                cwd: process.cwd(),
                environment: processEnv,
              });
              const response = yield* client.request("account/rateLimitResetCredit/consume", {
                idempotencyKey,
              });
              return response.outcome;
            }).pipe(Effect.scoped, Effect.timeout("20 seconds")),
          )
          .pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.mapError(
              (cause) =>
                new ProviderDriverError({
                  driver: DRIVER_KIND,
                  instanceId,
                  detail: "Codex could not redeem the reset credit.",
                  cause,
                }),
            ),
            // The windows just changed; re-probe so the snapshot says so. A
            // failed probe republishes the pre-redemption limits rather than
            // marking them failed, so "confirmed" means `checkedAt` moved
            // past what was published before the redemption started. Only a
            // reset claims the limits changed, so only a reset reports an
            // unconfirmed refresh.
            Effect.tap((outcome) =>
              Effect.gen(function* () {
                const before = (yield* snapshot.getSnapshot).usageLimits?.checkedAt;
                const refreshed = yield* snapshot.refresh;
                const after = refreshed.usageLimits?.checkedAt;
                if (
                  outcome === "reset" &&
                  (after === undefined ||
                    after === before ||
                    refreshed.usageLimits?.unavailable?.reason === "probeFailed")
                ) {
                  return yield* new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail:
                      "The reset was applied, but Codex could not confirm the new limits. Refresh to check.",
                  });
                }
              }),
            ),
          );

      const auth = launch.managed
        ? yield* makeCodexApiKeyAuth({
            instanceId,
            launch: { ...launch, config: effectiveConfig },
            onChanged: snapshot.refresh.pipe(Effect.ignore),
          })
        : undefined;

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        consumeResetCredit,
        orchestrationAdapter,
        textGeneration,
        ...(auth ? { auth } : {}),
      } satisfies ProviderInstance;
    }),
};
