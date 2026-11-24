// ), apps/server/src/server.ts @ ab3a3cd1.
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as DatabaseStorage from "./persistence/DatabaseStorage.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as PullRequestSyncReactor from "./orchestration-v2/PullRequestSyncReactor.ts";
import * as PullRequestWatchReactor from "./orchestration-v2/PullRequestWatchReactor.ts";
import * as DelegatedTaskQuestionReactor from "./orchestration-v2/DelegatedTaskQuestionReactor.ts";
// Effect wraps this raw Node HTTP server after its startup and write-error guards attach.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { defaultInstanceIdForDriver, EnvironmentHttpApi, type RepositoryIdentity } from "@caveman-app/protocol";
import { CAVEMAN_PROVIDER, CavemanExecutionBackend, CavemanRuntimeToolsRef, CavemanToolsLauncher, CavemanToolsStreamRef, makeCavemanRewriter } from "@caveman-app/provider-caveman/server";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as BackgroundPolicy from "./background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "./background/HostPowerMonitor.ts";
import * as ServerConfig from "./config.ts";
import * as EngineEgress from "./secrets/EngineEgress.ts";
import { withUnloggedCredentialRequests, withUntracedRequests } from "./http.ts";
import * as ServerHttp from "./http.ts";
import {
  guardHttpResponseWriteErrors,
  rejectRequestsUntilServing,
} from "./httpResponseErrorGuard.ts";
import { fixPath } from "./os-jank.ts";
import { loadCavemanEngineAfterStart } from "./cavemanEngineLoad.ts";
import { markStartup } from "./startupTrace.ts";
import * as Ws from "./ws.ts";
import * as AgentScopeLive from "./process/agentScope.ts";
import * as CloudLink from "./cloudLink/index.ts";
import * as CloudTools from "./cloudLink/tools.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as NodePtyAdapter from "./terminal/NodePtyAdapter.ts";
import * as PullRequestHttp from "./pullRequest/http.ts";
import * as PullRequestProviderRegistry from "./pullRequest/PullRequestProviderRegistry.ts";
import * as PullRequestService from "./pullRequest/PullRequestService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as PullRequestFilesViewed from "./persistence/PullRequestFilesViewed.ts";
import * as PullRequestReviewGuides from "./persistence/PullRequestReviewGuides.ts";
import * as PullRequestReviewGuideService from "./pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestReviewGuidePrewarm from "./pullRequest/PullRequestReviewGuidePrewarm.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ProviderEventIngestor from "./orchestration-v2/ProviderEventIngestor.ts";
import * as ModelManifest from "./provider/ModelManifest.ts";
import * as ResetCreditCoordinator from "./provider/resetCreditCoordinator.ts";
import * as EventNdjsonLogger from "./provider/EventNdjsonLogger.ts";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as PluginRegistry from "./plugins/PluginRegistry.ts";
import * as McpHub from "./plugins/McpHub.ts";
import * as ClientToolsEndpoint from "./mcp/clientToolsEndpoint.ts";
import * as Connectors from "./plugins/connectors.ts";
import { layerCredentialBroker, layerProjectSecrets } from "./cloudLink/computerSecrets.ts";
import * as EgressScrub from "./secrets/EgressScrub.ts";
import * as SecretProviderTokens from "./secrets/SecretProviderTokens.ts";
import * as SecretResolver from "./secrets/SecretResolver.ts";
import { ProjectSecrets } from "./secrets/ProjectSecrets.ts";
import * as ProviderHostLive from "./provider/ProviderHostLive.ts";
import * as DocumentText from "./provider/DocumentText.ts";
import * as AntigravityInstallation from "./provider/AntigravityInstallation.ts";
import * as AntigravityUsage from "./provider/Drivers/AntigravityUsage.ts";
import * as AcpRegistrySupport from "@caveman-app/provider-acp-registry/server/AcpRegistrySupport";
import * as CheckpointDiffQuery from "./checkpointing/CheckpointDiffQuery.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as SourceControlBuiltInDrivers from "./sourceControl/builtInDrivers.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryHydration from "./provider/ProviderInstanceRegistryHydration.ts";
import * as ProjectSettingsOverrideSweep from "./provider/ProjectSettingsOverrideSweep.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as SessionProtocol from "./session-protocol/index.ts";
import * as SessionProtocolStore from "./session-protocol/store.ts";
import * as StalledMcpServers from "./plugins/StalledMcpServers.ts";
import * as StalledMcpServersCheck from "./plugins/StalledMcpServersCheck.ts";
import * as MemoryService from "./memory/MemoryService.ts";
import * as ChiefHost from "./chief/host.ts";
import * as McpHttpServer from "./mcp/McpHttpServer.ts";
import * as WebTools from "./web/WebTools.ts";
import * as SubagentAuto from "./router/subagentAuto.ts";
import * as McpSessionRegistry from "./mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "./mcp/PreviewAutomationBroker.ts";
import * as PreviewManager from "./preview/Manager.ts";
import * as PortScanner from "./preview/PortScanner.ts";
import * as ServerBrowser from "./preview/ServerBrowser.ts";
import * as DesktopBrowserChannel from "./preview/DesktopBrowserChannel.ts";
import * as ServerBrowserStream from "./preview/ServerBrowserStream.ts";
import * as PreviewBrowser from "./preview/PreviewBrowser.ts";
import * as ProcessRunner from "./processRunner.ts";
import * as GitManager from "./git/GitManager.ts";
import * as EnvironmentTheme from "./environmentTheme.ts";
import * as Keybindings from "./keybindings.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as NativeAppIconResolver from "./assets/NativeAppIconResolver.ts";
import * as ProviderAdapterRegistry from "./orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as ProviderUsageLimitsIngestion from "./provider/ProviderUsageLimitsIngestion.ts";
import * as ProjectFaviconResolver from "./project/ProjectFaviconResolver.ts";
import * as T3ProjectFileLoader from "./project/T3ProjectFileLoader.ts";
import * as RepositoryIdentityResolver from "./project/RepositoryIdentityResolver.ts";
import * as WorkspaceEntries from "./workspace/WorkspaceEntries.ts";
import * as KnownWorkspaces from "./workspace/KnownWorkspaces.ts";
import * as WorkspaceFileSystem from "./workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import * as VcsProvisioningService from "./vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "./vcs/VcsStatusBroadcaster.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as GitWorkflowService from "./git/GitWorkflowService.ts";
import * as ReviewService from "./review/ReviewService.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestReadCache from "./pullRequest/PullRequestReadCache.ts";
import * as SourceControlRateLimit from "@caveman-app/source-control-core/server/SourceControlRateLimit";
import * as SourceControlRepositoryService from "./sourceControl/SourceControlRepositoryService.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as Observability from "./observability/Observability.ts";
import * as HeapSnapshot from "./observability/HeapSnapshot.ts";
import * as EventLoopMonitor from "./observability/EventLoopMonitor.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as DirectEndpoints from "./environment/DirectEndpoints.ts";
import * as AuthHttp from "./auth/http.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as WebhookRoute from "./scheduledTasks/webhookRoute.ts";
import * as McpOAuth from "./auth/McpOAuth.ts";
import * as McpOAuthHttp from "./auth/mcpOAuthHttp.ts";
import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ProcessDiagnostics from "./diagnostics/ProcessDiagnostics.ts";
import * as HostResources from "./resourceTelemetry/HostResources.ts";
import * as ProcessResourceMonitor from "./diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "./diagnostics/TraceDiagnostics.ts";
import * as DesktopTelemetryReceiver from "./resourceTelemetry/DesktopTelemetryReceiver.ts";
import * as NativeTelemetryClient from "./resourceTelemetry/NativeTelemetryClient.ts";
import * as ResourceAttribution from "./resourceTelemetry/ResourceAttribution.ts";
import * as ResourceMonitorBinary from "./resourceTelemetry/ResourceMonitorBinary.ts";
import * as ResourceTelemetry from "./resourceTelemetry/ResourceTelemetry.ts";
import * as UsageService from "./usage/UsageService.ts";
import { MuseUsageHome } from "@caveman-app/provider-muse/server";
import * as CursorAccountReader from "@caveman-app/provider-cursor/server/CursorAccountReader";
import * as CursorKeychain from "@caveman-app/provider-cursor/server/CursorKeychain";
import * as CursorUsageAccounts from "@caveman-app/provider-cursor/server/CursorUsageAccounts";
import * as OpenCodeRuntime from "@caveman-app/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@caveman-app/provider-opencode/server/OpenCodeServerLedger";
import { cavemanRuntimeTools } from "./mcp/cavemanRuntimeTools.ts";
import * as CodexUsageHistory from "./usage/CodexUsageHistory.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import * as ThreadSettlementService from "./orchestration-v2/ThreadSettlementService.ts";
import * as IdleCompactionService from "./orchestration-v2/IdleCompactionService.ts";
import * as ThreadPullRequestService from "./orchestration-v2/ThreadPullRequestService.ts";
import * as RunFinalizationService from "./orchestration-v2/RunFinalizationService.ts";
import * as ProjectionMaintenance from "./orchestration-v2/ProjectionMaintenance.ts";
import { makePersistedServerRuntimeState } from "./serverRuntimeState.ts";
import * as OrchestrationHttp from "./orchestration-v2/http.ts";
import * as ProjectHttp from "./project/http.ts";
import * as NetService from "@caveman-app/shared/Net";
import * as ServerActivation from "./serverActivation.ts";

// MCP handoff thread IDs include escaped provenance and can exceed find-my-way's
// 100-character default for one path segment.
const HTTP_ROUTER_CONFIG = {
  maxParamLength: 512,
} as const;

// Effect's default preemptive shutdown waits 20s before finalizing request scopes.
// upstream primary transport is long-lived WebSocket RPC, whose Effect scope finalizer
// already closes the websocket gracefully. Do not add an artificial drain before
// those finalizers get a chance to run.
const HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS = 0;
const layerResourceAttribution = ResourceAttribution.layer;
const layerApplicationObservability = EventLoopMonitor.layer.pipe(
  Layer.provideMerge(Observability.layer),
  Layer.provideMerge(layerResourceAttribution),
);

// One rotating store behind both logger views, so driver instances never race
// its rotation. Diagnostics must not block startup: a store that cannot open
// degrades to the no-op loggers.
const layerProviderEventLoggers = Layer.effect(
  ProviderEventLoggers.ProviderEventLoggers,
  Effect.gen(function* () {
    const { providerEventLogPath } = yield* ServerConfig.ServerConfig;
    const attribution = yield* ResourceAttribution.ResourceAttribution;
    // Native logs carry raw protocol frames: every record is scrubbed of secret values first.
    const { scrubber } = yield* ProjectSecrets;
    const store = yield* EventNdjsonLogger.makeEventNdjsonLogStore(providerEventLogPath, {
      attribution,
      scrubber,
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning(error.message, { error }).pipe(
          Effect.annotateLogs({ scope: "provider-observability" }),
          Effect.as(undefined),
        ),
      ),
    );
    if (!store) return ProviderEventLoggers.NoOpProviderEventLoggers;
    yield* Effect.addFinalizer(() => store.close());
    return { native: store.logger("native"), canonical: store.logger("canonical") };
  }),
);

const layerPtyAdapter = NodePtyAdapter.layer;

const layerServerSettings = ServerSettings.layer.pipe(
  Layer.provide(ServerSecretStore.layer),
  Layer.provideMerge(SqlitePersistence.layerConfig),
);

// Secret providers (1Password): reads the references settings point at, at use time. Everything
// that builds an engine or reads a host credential (the instance registry, the source control
// host) finds it below them; a service account's token sits sealed in the secret store.
const layerSecretResolver = SecretResolver.layer.pipe(
  Layer.provideMerge(SecretProviderTokens.layer.pipe(Layer.provide(ServerSecretStore.layer))),
  Layer.provide(layerServerSettings),
);

const layerNativeTelemetry = NativeTelemetryClient.layer.pipe(
  Layer.provide(ResourceMonitorBinary.layer),
);
const layerDesktopTelemetryReceiver = DesktopTelemetryReceiver.layer.pipe(
  Layer.provideMerge(layerServerSettings),
);

const layerResourceTelemetry = ResourceTelemetry.layer.pipe(
  Layer.provideMerge(layerNativeTelemetry),
  Layer.provideMerge(layerDesktopTelemetryReceiver),
);

const layerHostPowerMonitor = HostPowerMonitor.layer.pipe(
  Layer.provide(layerDesktopTelemetryReceiver),
);

const layerBackground = BackgroundPolicy.layer.pipe(
  Layer.provide(layerHostPowerMonitor),
  Layer.provideMerge(layerServerSettings),
);

const layerUsage = UsageService.layer.pipe(
  Layer.provide(
    AntigravityUsage.layer.pipe(
      Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(ServerSecretStore.layer))),
    ),
  ),
  Layer.provide(
    CursorUsageAccounts.layer.pipe(
      Layer.provide(CursorAccountReader.layer.pipe(Layer.provide(CursorKeychain.layer))),
      Layer.provide(ProviderHostLive.layer.pipe(Layer.provide(ServerSecretStore.layer))),
    ),
  ),
  Layer.provide(MuseUsageHome.layer),
  Layer.provide(CodexUsageHistory.layer),
  Layer.provide(layerServerSettings),
);

const layerResourceDiagnostics = Layer.mergeAll(
  HostResources.layer,
  layerResourceTelemetry,
  ProcessDiagnostics.layer.pipe(Layer.provide(layerResourceTelemetry)),
  ProcessResourceMonitor.layer.pipe(Layer.provide(layerResourceTelemetry)),
);

const layerHttpServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // The startup gate goes on last: any "request" or "upgrade" listener added after it hands off to serving.
    return NodeHttpServer.layer(
      () => rejectRequestsUntilServing(SessionProtocol.denyFraming(guardHttpResponseWriteErrors(NodeHttp.createServer()))),
      {
        host: config.host ?? "127.0.0.1",
        port: config.port,
        gracefulShutdownTimeout: HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS,
        // Negotiate permessage-deflate with clients that offer it; clients
        // that don't still get uncompressed frames on their connection.
        // Context takeover stays enabled (ws default) so the compression
        // window is shared across frames — that also makes small frames cheap
        // to compress, so no size threshold is set (ws only honors
        // `threshold` when context takeover is disabled).
        // Session Protocol clients offer caveman.session.v1; other upgrades keep ws's default pick.
        websocket: { perMessageDeflate: true, handleProtocols: SessionProtocol.selectSubprotocol },
      },
    );
  }),
);

// On a Cloud computer every child but the runtime's own runs in the tools container (cloudLink/tools.ts).
const toolsSocket = CloudTools.toolsSocket();
// Document text extraction is the runtime's own helper process, like the page reader, not a tools-container child.
const layerPlatformServices = DocumentText.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      toolsSocket === undefined ? NodeServices.layer : Layer.provideMerge(CloudTools.spawnerLayer(toolsSocket), NodeServices.layer),
      NodeCrypto.layer,
    ),
  ),
);

const layerPersistence = Layer.empty.pipe(Layer.provideMerge(SqlitePersistence.layerConfig));

const layerVcsDriverRegistry = VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer));

const layerSourceControlProviderRegistry = SourceControlProviderRegistry.layer.pipe(
  Layer.provideMerge(SourceControlBuiltInDrivers.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerRepositoryIdentityResolver = Layer.effect(
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  Effect.gen(function* () {
    const registry = yield* SourceControlProviderRegistry.SourceControlProviderRegistry;
    return yield* RepositoryIdentityResolver.make({
      // Each host that can refine an identity gets a turn; the first one that changes it wins.
      refine: Effect.fn(function* (identity: RepositoryIdentity) {
        for (const kind of SourceControlBuiltInDrivers.BUILT_IN_SOURCE_CONTROL_DRIVERS.map(
          (driver) => driver.kind,
        )) {
          const provider = yield* registry.get(kind);
          if (provider.refineRepositoryIdentity === undefined) continue;
          const refined = yield* provider.refineRepositoryIdentity({
            identity,
            resolveContext: (input) =>
              registry.resolveHandle(input).pipe(Effect.map((handle) => handle.context)),
          });
          if (refined !== identity) return refined;
        }
        return identity;
      }),
    });
  }),
).pipe(Layer.provide(layerSourceControlProviderRegistry), Layer.provide(ProcessRunner.layer));

const layerPullRequestService = PullRequestService.layer.pipe(
  Layer.provide(PullRequestProviderRegistry.layer),
  // Where the viewed-file marks live for a host that keeps none of its own.
  Layer.provide(PullRequestFilesViewed.layer),
  Layer.provide(PullRequestReadCache.layer),
  Layer.provide(layerSourceControlProviderRegistry),
  Layer.provide(SourceControlRateLimit.layer),
);

const layerGitManager = GitManager.layer.pipe(
  // Per-project git settings resolve the acting thread's project.
  Layer.provide(Layer.merge(RuntimeLayer.layerProjectionStore, ProjectStore.layer)),
  Layer.provideMerge(RuntimeLayer.layerProjectSetupScriptRunner),
  Layer.provideMerge(WorktreeSetupTracker.layer),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(TextGeneration.layer.pipe(Layer.provide(layerSourceControlProviderRegistry))),
);

const layerGit = Layer.empty.pipe(
  Layer.provideMerge(layerGitManager),
  Layer.provideMerge(GitVcsDriver.layer),
);

const layerGitWorkflow = GitWorkflowService.layer.pipe(
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(layerGit),
);

const layerSourceControlRepositoryService = SourceControlRepositoryService.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerSourceControlProviderRegistry),
);

const layerProjectCloneTracker = ProjectCloneTracker.layer.pipe(
  Layer.provide(layerSourceControlRepositoryService),
);

const layerKnownWorkspaces = KnownWorkspaces.layer.pipe(
  Layer.provide(ProjectStore.layer),
  Layer.provide(GitVcsDriver.layer),
);

const layerReview = ReviewService.layer.pipe(
  Layer.provideMerge(layerKnownWorkspaces),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
);

const layerVcs = Layer.empty.pipe(
  Layer.provideMerge(VcsProjectConfig.layer),
  Layer.provideMerge(layerVcsDriverRegistry),
  Layer.provideMerge(VcsProvisioningService.layer.pipe(Layer.provide(layerVcsDriverRegistry))),
  Layer.provideMerge(layerGitWorkflow),
  Layer.provideMerge(layerReview),
  Layer.provideMerge(layerSourceControlRepositoryService),
  Layer.provideMerge(layerProjectCloneTracker),
  Layer.provideMerge(
    VcsStatusBroadcaster.layer.pipe(
      Layer.provide(layerGitWorkflow),
      Layer.provide(VcsStatusBroadcaster.layerAutomaticFetchInterval),
      // Auto-pull reads the project row. The orchestration runtime also
      // consumes the broadcaster (run finalization), so the policy cannot read
      // the store from the runtime's output.
      Layer.provide(
        VcsStatusBroadcaster.layerAutoPullPolicy.pipe(Layer.provide(ProjectStore.layer)),
      ),
    ),
  ),
);

const layerCheckpointStore = CheckpointStore.layer.pipe(Layer.provide(layerVcsDriverRegistry));

const layerPortScanner = PortScanner.layer.pipe(Layer.provide(ProcessRunner.layer));

const layerTerminal = TerminalManager.layer.pipe(
  Layer.provide(layerPtyAdapter),
  Layer.provide(layerPortScanner),
  Layer.provide(layerNativeTelemetry),
);

const layerPreview = Layer.empty.pipe(
  Layer.provideMerge(PreviewManager.layer),
  Layer.provideMerge(layerPortScanner),
);

const layerWorkspaceEntries = WorkspaceEntries.layer.pipe(Layer.provide(WorkspacePaths.layer));

const layerWorkspaceFileSystem = WorkspaceFileSystem.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(layerWorkspaceEntries),
  Layer.provide(layerKnownWorkspaces),
);

const layerWorkspace = Layer.mergeAll(
  WorkspacePaths.layer,
  layerWorkspaceEntries,
  layerWorkspaceFileSystem,
);

const layerProjectFaviconResolver = ProjectFaviconResolver.layer.pipe(
  Layer.provide(WorkspacePaths.layer),
  Layer.provide(T3ProjectFileLoader.layer),
);

const layerServerEnvironment = ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer));

const layerAuth = EnvironmentAuth.layer.pipe(
  Layer.provideMerge(layerPersistence),
  Layer.provide(layerServerEnvironment),
  Layer.provide(ServerSecretStore.layer),
);

const layerOrchestrationV2Runtime = RuntimeLayer.layerProduction.pipe(
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerGitWorkflow),
  Layer.provide(
    RunFinalizationService.layerObserver.pipe(
      Layer.provide(RuntimeLayer.layerProjectionStore),
      Layer.provide(layerPullRequestService),
      Layer.provide(RuntimeLayer.layerProjectService),
    ),
  ),
);

const layerOrchestrationApplication = CheckpointDiffQuery.layer.pipe(
  Layer.provideMerge(layerCheckpointStore),
  Layer.provideMerge(layerOrchestrationV2Runtime),
);

// Automatic thread settlement (#8600): a server-owned sweep evaluates
// inactivity and merged pull requests, then settles through the orchestrator
// so every client sees the same shelf.
const layerThreadSettlementWorker = Layer.effectDiscard(
  ThreadSettlementService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService), Layer.provide(RuntimeLayer.layerProjectionStore));

const layerIdleCompactionWorker = Layer.effectDiscard(
  IdleCompactionService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(RuntimeLayer.layerProjectionStore));

const layerThreadPullRequestWorker = Layer.effectDiscard(
  ThreadPullRequestService.make.pipe(Effect.flatMap((service) => service.start())),
).pipe(Layer.provide(layerPullRequestService));

// ), apps/server/src/server.ts @ 13aa882c22 (Antigravity only).
const layerAntigravityInstallationRefresh = Layer.effectDiscard(
  Effect.gen(function* () {
    const antigravity = yield* AntigravityInstallation.AntigravityInstallation;
    const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
    const providers = yield* ProviderRegistry.ProviderRegistry;
    yield* antigravity.changes.pipe(
      Stream.changesWith((a, b) => a.installedVersion === b.installedVersion),
      Stream.drop(1),
      Stream.runForEach((state) =>
        instances.listInstances.pipe(
          Effect.flatMap((entries) =>
            Effect.forEach(
              entries.filter((instance) => instance.driverKind === state.driver),
              (instance) => providers.refreshInstance(instance.instanceId),
              { discard: true },
            ),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }),
);

const layerRuntimeCoreDependenciesBase = Layer.mergeAll(
  layerThreadSettlementWorker,
  layerIdleCompactionWorker,
  StorageCleanup.layer.pipe(Layer.provide(RuntimeLayer.layerProjectionStore)),
  DatabaseStorage.layer.pipe(Layer.provide(ProjectionMaintenance.layer)),
  layerThreadPullRequestWorker,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestSyncReactor.PullRequestSyncReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provideMerge(PullRequestSyncReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(RuntimeLayer.layerProjectionStore),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestWatchReactor.PullRequestWatchReactor;
      yield* service.start();
    }),
  ).pipe(
    Layer.provide(PullRequestWatchReactor.layer),
    Layer.provide(layerPullRequestService),
    Layer.provide(RuntimeLayer.layerProjectionStore),
  ),
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* DelegatedTaskQuestionReactor.DelegatedTaskQuestionReactor;
      yield* service.start();
    }),
  ).pipe(Layer.provide(DelegatedTaskQuestionReactor.layer), Layer.provide(RuntimeLayer.layerProjectionStore)),
  // Subscribes to `account.rate-limits.updated` so usage bars track live
  // telemetry instead of waiting for the next status probe.
  ProviderUsageLimitsIngestion.layer,
  // A finished Antigravity install (or removal) re-probes its instances.
  layerAntigravityInstallationRefresh,
  // Catches overrides left behind by a project deleted before this cleanup
  // existed, or by a cleanup write that failed. See ProjectService.delete
  // for the normal (on-delete) path.
  Layer.effectDiscard(ProjectSettingsOverrideSweep.sweep),
).pipe(
  // Core Services
  Layer.provideMerge(layerOrchestrationApplication),
  Layer.provideMerge(RuntimeLayer.layerEventInfrastructure),
  Layer.provideMerge(Layer.merge(ProjectStore.layer, ThreadSearch.layer)),
  Layer.provideMerge(layerServerSettings),
  // The asset route uses the registry's GitHub credential for private PR media, which the
  // built-in drivers' layer provides alongside the registry.
  Layer.provideMerge(layerSourceControlProviderRegistry),
  Layer.provideMerge(layerGit),
  Layer.provideMerge(layerVcs),
  Layer.provideMerge(Layer.mergeAll(layerTerminal, layerPreview)),
  Layer.provideMerge(layerPersistence),
  // Both read a user-owned file out of the state directory and stream changes
  // to clients; neither depends on the other.
  Layer.provideMerge(Layer.mergeAll(Keybindings.layer, EnvironmentTheme.layer)),
  Layer.provideMerge(ProviderRegistry.layer),
  // The instance registry is the new routing keystone — text generation,
  // adapter lookup, and runtime ingestion all resolve `ProviderInstanceId`
  // through this layer. Built-in drivers come from `BUILT_IN_DRIVERS`;
  // hydration adds their default instances to `providerInstances` on boot.
  Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
  // Provider hydration builds the Claude runner, which reports agents to the same scanner the
  // terminal and preview layers share.
  Layer.provideMerge(layerPortScanner),
  // The Antigravity driver resolves its ACP server (override, managed or PATH) through this.
  Layer.provideMerge(AntigravityInstallation.AntigravityInstallation.layer),
);

const layerMemory = MemoryService.layer.pipe(Layer.provide(SessionProtocolStore.layer), Layer.provide(ProviderHostLive.layer));

const layerRuntimeCoreDependencies = layerRuntimeCoreDependenciesBase.pipe(
  Layer.provideMerge(layerPtyAdapter),
  // Search, prepare, status inspection, and turn launch share one registry
  // cache so every client and provider instance sees the same prepared agents.
  Layer.provideMerge(AcpRegistrySupport.layerFromHost.pipe(Layer.provide(ProviderHostLive.layer))),
  // Provider event loggers are shared by every driver instance and the
  // orchestration runtime, so they are provided once here.
  // `ModelManifest.layer` is the model manifest, refreshed from the repo's
  // `model-manifest.json` on `main`. Drivers read their entry through the
  // `ModelCatalog` port it provides.
  Layer.provideMerge(
    Layer.mergeAll(
      layerProviderEventLoggers,
      ModelManifest.layerModelCatalog.pipe(Layer.provideMerge(ModelManifest.layer)),
      ResetCreditCoordinator.layer,
      ProviderLatestVersions.layer,
      McpProviderSessions.layer,
      // MCP servers that timed out connecting at a Claude Agent start: left out of later starts, retried in Plugins.
      StalledMcpServers.layer.pipe(Layer.provide(SessionProtocolStore.layer)),
      // Plugins from the spaces in Settings: PluginRegistry for plugin.list,
      // SessionPlugins for adapters. The broker serves credentials granted to a space in Settings.
      // Memory (memory/MemoryService.ts): one store per account, a copy per session, one commit path.
      layerMemory,
      // delegate_task's Auto (router/subagentAuto.ts): the MCP service asks Cloud for a child's harness and model,
      // the Session Protocol projector puts the runner on the child and reports how it ended.
      SubagentAuto.layer.pipe(Layer.provide(ProviderHostLive.layer)),
      // The Chief's profile for the Caveman adapter, bound by the Session Protocol route (chief/host.ts).
      ChiefHost.layer,
      // environment_build's way into the route's setup chats (session-protocol/environments.ts).
      SessionProtocol.layerSetupChats,
      // register_preview's way into the route's chats (session-protocol/previewHandlers.ts).
      SessionProtocol.layerChatPreviews,
      // delegate_task's way into the route's builders (session-protocol/builders.ts).
      SessionProtocol.layerBuilders,
      // thread_send's way to a chat on another of the person's Macs (session-protocol/macMail.ts).
      SessionProtocol.layerMacMail,
      // schedule_task's way into the route's Cloud schedules (session-protocol/cloudSchedules.ts).
      SessionProtocol.layerCloudSchedules,
      PluginRegistry.layerSessionPlugins.pipe(
        Layer.provideMerge(PluginRegistry.layer),
        // The memory brief and each engine's copy.
        Layer.provide(layerMemory),
        // In the route's context too: cloud.server.set_available reads grants to mirror them (cloudLink/cloudSync.ts).
        Layer.provideMerge(layerCredentialBroker),
        Layer.provide(layerServerSettings),
        // Workspace env (ports, [env]) for engine tool processes.
        Layer.provide(SessionProtocolStore.layer),
        // A thread's project root, for its repository secrets (secretEnv).
        Layer.provide(Layer.merge(RuntimeLayer.layerProjectionStore, ProjectStore.layer)),
        // The thread's runtime MCP credential: servers that sign in reach engines through the hub with it.
        Layer.provide(McpProviderSessions.layer),
      ),
    ),
  ),
  // OpenCode's servers, one runtime for every instance; OpenCode 2's go through the egress scrub and the app's proxy.
  Layer.provideMerge(
    EngineEgress.layerOpenCodeEgress.pipe(
      Layer.provide(
        OpenCodeRuntime.layer.pipe(
          Layer.provide(
            Layer.unwrap(
              Effect.gen(function* () {
                const config = yield* ServerConfig.ServerConfig;
                return OpenCodeServerLedger.layer({ stateDir: config.stateDir });
              }),
            ),
          ),
        ),
      ),
    ),
  ),
  Layer.provideMerge(layerWorkspace),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(Layer.mergeAll(NativeAppIconResolver.layer, layerProjectFaviconResolver)),
  Layer.provideMerge(layerRepositoryIdentityResolver),
  Layer.provideMerge(layerServerEnvironment),
  Layer.provideMerge(layerAuth),
  // Repository secrets (16-SECRETS.md), beside the broker's grants on the same store: the Session Protocol's
  // secret.* methods, process env, and the scrub of every session event and terminal.
  // EgressScrub.layer wraps the store: the one egress scrub (EgressRoute) for every engine, side
  // text and text generation, and ProjectSecrets with the scrub's own path token redacted too.
  // On a Cloud computer the values come from Cloud's resolve route and live in memory only (cloudLink/computerSecrets.ts).
  Layer.provideMerge(EgressScrub.layer.pipe(Layer.provide(layerProjectSecrets))),
  Layer.provideMerge(layerSecretResolver),
  Layer.provideMerge(ServerSecretStore.layer),
);

const layerRuntimeDependencies = layerRuntimeCoreDependencies.pipe(
  // Misc.
  // Usage reads provider history through the ProviderHost, which needs the
  // background policy below it.
  Layer.provideMerge(layerUsage),
  Layer.provideMerge(layerBackground),
  Layer.provideMerge(layerResourceDiagnostics),
  Layer.provideMerge(TraceDiagnostics.layer),
  Layer.provideMerge(ExternalLauncher.layer),
  Layer.provideMerge(DirectEndpoints.layer),
  Layer.provideMerge(ServerLifecycleEvents.layer),
  Layer.provide(NetService.layer),
);

const layerCommandReadiness = HttpRouter.middleware(
  (httpEffect) =>
    Effect.flatMap(ServerRuntimeStartup.ServerRuntimeStartup, (startup) =>
      startup.awaitCommandReady.pipe(Effect.orDie, Effect.andThen(httpEffect)),
    ),
  { global: true },
);

/**
 * The MCP hub (the runtime as the MCP client for plugin, personal and
 * connector servers) and its sign-ins, one instance for its route and the
 * Session Protocol's mcp.* and connector.* methods (layer identity).
 */
const layerMcpHub = McpHub.layer.pipe(
  Layer.provideMerge(Connectors.layer),
  // Trusted plugins' hooks around the Caveman engine's MCP calls.
  Layer.provide(McpHub.layerHubHooks),
  // A thread's worktree, where its stdio servers may write and its hooks run.
  Layer.provide(SessionProtocolStore.layer),
);

const layerMakeRoutes = Layer.mergeAll(
  // Prewarm sits with the routes so it shares their guide service: a person's run sees its runs
  // and goes first (PullRequestReviewGuideService.prewarm).
  Layer.effectDiscard(
    Effect.gen(function* () {
      const service = yield* PullRequestReviewGuidePrewarm.PullRequestReviewGuidePrewarm;
      // On a warm Cloud computer, once it is claimed: until then it reads no repository.
      const afterClaim = yield* CloudLink.afterClaim(yield* CloudLink.CloudComputer);
      yield* afterClaim(service.start()).pipe(Effect.forkScoped);
    }),
  ).pipe(
    Layer.provide(PullRequestReviewGuidePrewarm.layer),
    // Turn events say when a subscription is idle.
    Layer.provide(SessionProtocolStore.layer),
  ),
  Layer.mergeAll(
    HttpApiBuilder.layer(EnvironmentHttpApi).pipe(
      Layer.provide(AuthHttp.layer),
      Layer.provide(McpOAuthHttp.layer.pipe(Layer.provide(McpOAuth.layer))),
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(PullRequestHttp.layer),
      Layer.provide(ProjectHttp.layer),
      Layer.provide(ServerHttp.layerServerEnvironmentHttpApi),
      Layer.provide(WebhookRoute.layer),
      Layer.provide(AuthHttp.layerAuthenticatedAuth),
    ),
    ServerHttp.layerOtlpTracesProxyRoute,
    ServerHttp.layerAssetRoute,
    ServerHttp.layerAttachmentUploadRoute,
    ServerBrowserStream.routeLayer,
    // /mcp/hub/<server>: plugin, personal and connector MCP servers, with the runtime as their client.
    McpHub.layerRoute.pipe(Layer.provide(layerMcpHub)),
    // A server that stalled at a Claude Agent start, checked through the same hub a little later.
    StalledMcpServersCheck.layer.pipe(Layer.provide(layerMcpHub)),
    // /mcp/client: a thread's custom tools (its agent file's), answered by whoever drives the session.
    ClientToolsEndpoint.layerRoute.pipe(Layer.provide(SessionProtocol.layerClientTools)),
    ServerHttp.layerStaticAndDevRoute,
    Ws.layer,
    // Session Protocol v1 (/session/v1) for Caveman Code clients.
    SessionProtocol.layerRoute.pipe(
      Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
      // project.* commit to the orchestrator's own event sink (the same layer value, so one instance).
      Layer.provide(RuntimeLayer.layerEventSink),
      // message.caveman_version on the cheapest model the user's Caveman keys allow.
      Layer.provide(
        Layer.effect(
          SessionProtocol.CavemanRewriter,
          makeCavemanRewriter(defaultInstanceIdForDriver(CAVEMAN_PROVIDER)),
        ),
      ),
      // chat.search by meaning on this computer: the model downloads once into the state dir.
      Layer.provide(
        Layer.effect(
          SessionProtocol.Embedder,
          Effect.gen(function* () {
            const config = yield* ServerConfig.ServerConfig;
            // Its thread ends as the runtime stops, before the process exits (makeLocalEmbedder).
            return yield* Effect.acquireRelease(
              Effect.sync(() => SessionProtocol.makeLocalEmbedder(`${config.stateDir}/models`)),
              (embedder) => Effect.promise(() => embedder.close()),
            );
          }),
        ),
      ),
      // skill.record and the rewriter run the Caveman engine on the user's stored key.
      Layer.provide(ProviderHostLive.layer),
      // mcp.* and connector.* answer from the same hub as its route.
      Layer.provide(layerMcpHub),
      // computer.* and the computer MCP tool share one desktop (layer identity), as computer.* and the desktop tool
      // share this Mac's computer use.
      Layer.provide(SessionProtocol.layerDesktop),
      Layer.provide(SessionProtocol.layerMacDesktop),
      // A Claude Code too old for a current model is updated by its own updater (session-protocol/engineUpdates.ts).
      Layer.provide(ProviderMaintenanceRunner.layer),
    ),
  ),
  // The MCP session registry is provided globally (shared with V2 provider
  // sessions) rather than inline here. The orchestrator toolkit resolves
  // delegation targets through the same live adapter facade the V2
  // orchestrator uses, so MCP capability reporting can never drift from
  // what dispatch can actually serve.
  McpHttpServer.layer.pipe(
    Layer.provide(ProviderAdapterRegistry.layerFromProviderInstanceRegistry),
    Layer.provide(McpOAuth.layerMcpClientAuthenticator),
    // The same instance as the route's (layer identity): grill rounds are answered through ask.respond.
    Layer.provide(SessionProtocol.layerGrill),
    Layer.provide(SessionProtocol.layerDesktop),
    Layer.provide(SessionProtocol.layerMacDesktop),
    // web_search and web_fetch: the person's search keys, the thread's links and the spend store (web/WebTools.ts).
    Layer.provide(WebTools.layer.pipe(Layer.provide(SessionProtocolStore.layer), Layer.provide(ProviderHostLive.layer))),
  ),
).pipe(
  // Guides read through the same pull request service as every other surface.
  Layer.provide(
    PullRequestReviewGuideService.layer.pipe(
      Layer.provide(PullRequestReviewGuides.layer),
      // Each guide run's usage lands as a runtime-level spend row.
      Layer.provide(SessionProtocolStore.layer),
    ),
  ),
  // Both transports consume the same service instance, so caches single-flight across clients
  // and mutations observed on WebSocket invalidate patches subsequently read over HTTP. Provided
  // after the guide service so it reaches that too.
  Layer.provide(layerPullRequestService),
  // The stream route and the WebSocket RPCs share one browser.
  Layer.provide(ServerBrowser.layer.pipe(Layer.provide(DesktopBrowserChannel.layer))),
  // Server browser tabs and HTML render previews install and run the same headless browser.
  Layer.provide(PreviewBrowser.layer),
  Layer.provide(PreviewAutomationBroker.layer),
  Layer.provide(layerCommandReadiness),
  Layer.provide(ServerHttp.layerBrowserApiCors),
  Layer.provide(ServerHttp.layerHttpCompression),
);

const layerMakeServer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    // Before anything opens the database: one server per Caveman Code home.
    const ownership = yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath);
    const activation = yield* Deferred.make<void>();
    const awaitActivation = Deferred.await(activation);
    const layerActivation = Layer.succeed(ServerActivation.ServerActivation, awaitActivation);
    const runtimeStateParked = yield* Deferred.make<void>();
    const routesReady = yield* Deferred.make<void>();

    markStartup("state dir owned");
    yield* fixPath({ shellEnvironmentPrepared: config.shellEnvironmentPrepared });
    markStartup("PATH ready");

    const layerHttpListening = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* HttpServer.HttpServer;
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        markStartup("listening");
        yield* Effect.forkScoped(loadCavemanEngineAfterStart());
      }),
    );
    const layerRuntimeState = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* Deferred.succeed(runtimeStateParked, undefined).pipe(Effect.orDie);
        yield* awaitActivation;
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          return;
        }

        const state = yield* makePersistedServerRuntimeState({ config, port: address.port });
        // Ownership release removes this record.
        yield* ownership
          .publish(state)
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to persist server runtime state", { cause }),
            ),
          );
      }),
    );

    const layerRuntimeServices = ServerRuntimeStartup.layerWithOptions({
      activate: Deferred.succeed(activation, undefined).pipe(Effect.asVoid),
      abort: (error) => Deferred.die(activation, error).pipe(Effect.asVoid),
      awaitAuxiliaryParked: Effect.all(
        [Deferred.await(runtimeStateParked), Deferred.await(routesReady)],
        { concurrency: "unbounded" },
      ).pipe(Effect.asVoid),
    }).pipe(Layer.provideMerge(layerRuntimeDependencies));

    const layerRoutes = HttpRouter.serve(layerMakeRoutes, {
      disableLogger: !config.logWebSocketEvents,
      middleware: withUnloggedCredentialRequests,
      routerConfig: HTTP_ROUTER_CONFIG,
    }).pipe(
      withUntracedRequests,
      Layer.tap(() => Deferred.succeed(routesReady, undefined).pipe(Effect.orDie)),
    );
    const layerServerApplication = Layer.mergeAll(
      layerRoutes,
      layerHttpListening,
      layerRuntimeState,
      HeapSnapshot.layer,
    );

    return layerServerApplication.pipe(
      Layer.provideMerge(layerRuntimeServices),
      Layer.provideMerge(
        McpSessionRegistry.layer.pipe(
          Layer.provide(ServerEnvironment.layer.pipe(Layer.provide(ServerSecretStore.layer))),
        ),
      ),
      Layer.provide(layerActivation),
      // NodeHttpServer.layer outputs NodeServices again, so the tools spawner goes over it too.
      Layer.provideMerge(toolsSocket === undefined ? layerHttpServer : Layer.provideMerge(CloudTools.spawnerLayer(toolsSocket), layerHttpServer)),
      Layer.provide(layerApplicationObservability),
      Layer.provideMerge(FetchHttpClient.layer),
      // PR reads, Git operations, and WebSocket discovery share one process limiter.
      Layer.provide(VcsProcess.layer),
      // Every agent and terminal spawn reads this, so it sits below everything.
      Layer.provideMerge(toolsSocket === undefined ? AgentScopeLive.layer : CloudTools.agentScopeLayer(toolsSocket)),
      // The Caveman engine's own tools (shell, file reads and writes) go to the tools container too.
      Layer.provideMerge(toolsSocket === undefined ? Layer.empty : Layer.succeed(CavemanExecutionBackend, CloudTools.toolsExecutionBackend(toolsSocket))),
      // The harness's commands stream from there, so a long one keeps running under a handle while the model reads it.
      Layer.provideMerge(toolsSocket === undefined ? Layer.empty : Layer.succeed(CavemanToolsStreamRef, CloudTools.toolsStream(toolsSocket))),
      // and the Space stdio MCP servers it starts itself, with exactly their configured environment.
      Layer.provideMerge(
        toolsSocket === undefined ? Layer.empty : Layer.succeed(CavemanToolsLauncher, (c) => CloudTools.toolsCommand(toolsSocket, c.command, c.args, c.cwd, c.env, {})),
      ),
      // The runtime's waiting tools and grill mode, declared to the Caveman engine.
      Layer.provideMerge(Layer.succeed(CavemanRuntimeToolsRef, cavemanRuntimeTools)),
      Layer.provideMerge(layerPlatformServices),
    );
  }),
).pipe(
  Layer.provide(ProcessRunner.layer),
  // Outermost too: layers shared by reference (ProcessRunner above) are built once, from the first
  // context that builds them, so on a Cloud computer they must already see the tools spawner.
  Layer.provide(layerPlatformServices),
);

// The CLI supplies configuration.
export const runServer = Layer.launch(layerMakeServer);
