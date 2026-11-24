// @effect-diagnostics nodeBuiltinImport:off - the route is served on a real Node HTTP server.
// The real T3 /ws route (ws.ts) on a free local port, for tests that read it as a client does: a WebSocket, Effect's
// RpcClient and the wire encoding. Services a test does not hand in are stubs whose every member answers Effect.void.
import * as http from "node:http";
import * as os from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ORCHESTRATION_PROTOCOL_VERSION, WsRpcGroup } from "@caveman-app/protocol";
import type { Scrubber } from "@caveman-app/session-protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as AcpRegistryRuntimeCoordinator from "@caveman-app/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import * as AcpRegistrySupport from "@caveman-app/provider-acp-registry/server/AcpRegistrySupport";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";
import { RpcClient, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import * as SqlClient from "effect/sql/SqlClient";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as PairingGrantStore from "../auth/PairingGrantStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as CheckpointDiffQuery from "../checkpointing/CheckpointDiffQuery.ts";
import * as ServerConfig from "../config.ts";
import * as ProcessDiagnostics from "../diagnostics/ProcessDiagnostics.ts";
import * as ProcessResourceMonitor from "../diagnostics/ProcessResourceMonitor.ts";
import * as TraceDiagnostics from "../diagnostics/TraceDiagnostics.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as EnvironmentTheme from "../environmentTheme.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as Keybindings from "../keybindings.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as McpAppRequests from "../mcpApps/McpAppRequests.ts";
import * as CommandOutputHub from "../orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as PullRequestSyncReactor from "../orchestration-v2/PullRequestSyncReactor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PortScanner from "../preview/PortScanner.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ExternalLauncher from "../process/externalLauncher.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as AntigravityInstallation from "../provider/AntigravityInstallation.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ModelManifest from "../provider/ModelManifest.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as PullRequestReviewGuideService from "../pullRequest/PullRequestReviewGuideService.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as HostResources from "../resourceTelemetry/HostResources.ts";
import * as ResourceTelemetry from "../resourceTelemetry/ResourceTelemetry.ts";
import * as ReviewService from "../review/ReviewService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerLifecycleEvents from "../serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as StorageCleanup from "../storageCleanup.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as UsageService from "../usage/UsageService.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as VcsProvisioningService from "../vcs/VcsProvisioningService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as WorkspaceFileSystem from "../workspace/WorkspaceFileSystem.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as Ws from "../ws.ts";

/** Both a method answering Effect.void and Effect.void itself (some services expose effects as fields). */
const voidish = () => {
  const fn = () => Effect.void;
  Object.setPrototypeOf(fn, Object.getPrototypeOf(Effect.void));
  for (const key of Object.keys(Effect.void)) {
    (fn as unknown as Record<string, unknown>)[key] = (
      Effect.void as unknown as Record<string, unknown>
    )[key];
  }
  return fn;
};

/** A service whose every member answers Effect.void; `overrides` win. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const stubService = (overrides: Record<string, unknown> = {}): any =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (typeof prop === "symbol" || prop === "then") return undefined;
        if (prop in overrides) return overrides[prop];
        return voidish();
      },
    },
  );

// Services the /ws handler layer yields while it is built.
const STUBBED = [
  AcpRegistrySupport.AcpRegistryCatalog,
  AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator,
  AgentSessionImporter.AgentSessionImporter,
  AntigravityInstallation.AntigravityInstallation,
  BackgroundPolicy.BackgroundPolicy,
  CheckpointDiffQuery.CheckpointDiffQuery,
  CommandOutputHub.CommandOutputHub,
  DirectEndpoints.DirectEndpoints,
  DocumentText.DocumentText,
  EnvironmentTheme.EnvironmentThemeService,
  EventSink.EventSinkV2,
  ExternalLauncher.ExternalLauncher,
  GitWorkflowService.GitWorkflowService,
  HostResources.HostResources,
  IdAllocator.IdAllocatorV2,
  Keybindings.Keybindings,
  ManagedProjectFolders.ManagedProjectFolders,
  McpAppRequests.McpAppRequests,
  ModelManifest.ModelManifest,
  OrchestrationEventStore.OrchestrationEventStore,
  Orchestrator.OrchestratorV2,
  PairingGrantStore.PairingGrantStore,
  PortScanner.PortDiscovery,
  PreviewAutomationBroker.PreviewAutomationBroker,
  PreviewManager.PreviewManager,
  ProcessDiagnostics.ProcessDiagnostics,
  ProcessResourceMonitor.ProcessResourceMonitor,
  ProjectCloneTracker.ProjectCloneTracker,
  ProjectEnrichmentService.ProjectEnrichmentService,
  ProjectFaviconResolver.ProjectFaviconResolver,
  ProjectService.ProjectService,
  ProjectSetupScriptRunner.ProjectSetupScriptRunner,
  ProjectStore.ProjectStoreV2,
  ProviderAuthService.ProviderAuthService,
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  ProviderLatestVersions.ProviderLatestVersions,
  ProviderRegistry.ProviderRegistry,
  ProviderSessionManager.ProviderSessionManagerV2,
  PullRequestReviewGuideService.PullRequestReviewGuideService,
  PullRequestService.PullRequestService,
  PullRequestSyncReactor.PullRequestSyncReactor,
  RepositoryIdentityResolver.RepositoryIdentityResolver,
  ResourceTelemetry.ResourceTelemetry,
  ReviewService.ReviewService,
  ScheduledTasks.ScheduledTaskService,
  SecretRequests.SecretRequests,
  ServerBrowser.ServerBrowser,
  ServerEnvironment.ServerEnvironment,
  ServerLifecycleEvents.ServerLifecycleEvents,
  ServerRuntimeStartup.ServerRuntimeStartup,
  ServerSecretStore.ServerSecretStore,
  SourceControlRepositoryService.SourceControlRepositoryService,
  StorageCleanup.StorageCleanup,
  TerminalManager.TerminalManager,
  ThreadLaunchService.ThreadLaunchService,
  ThreadManagementService.ThreadManagementService,
  ThreadSearch.ThreadSearch,
  TraceDiagnostics.TraceDiagnostics,
  UsageService.UsageService,
  VcsProcess.VcsProcess,
  VcsProvisioningService.VcsProvisioningService,
  VcsStatusBroadcaster.VcsStatusBroadcaster,
  WorkspaceEntries.WorkspaceEntries,
  WorkspaceFileSystem.WorkspaceFileSystem,
  WorkspacePaths.WorkspacePaths,
  WorktreeSetupTracker.WorktreeSetupTracker,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- services of every type, as the server's layer lists them.
] as ReadonlyArray<Context.Key<any, any>>;

/**
 * Serves /ws for a session holding `scopes`, with `scrubber` as every repository's secrets. `services` (built by the
 * test, so it can drive them) take the place of the stubs; the route queries their SqlClient, else an empty database.
 */
export const serveWs = (options: {
  readonly scopes: ReadonlyArray<string>;
  readonly scrubber: Scrubber;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- whatever services the test provides.
  readonly services?: Context.Context<any>;
}) =>
  Effect.gen(function* () {
    let stubs = Context.empty() as Context.Context<never>;
    for (const tag of STUBBED) stubs = Context.add(stubs, tag, stubService());
    const session = {
      sessionId: "ws-test-session",
      subject: "ws-test",
      method: "browser-session-cookie",
      scopes: options.scopes,
    } as unknown as EnvironmentAuth.AuthenticatedSession;
    const fixed = Context.empty().pipe(
      Context.add(ProjectSecrets, stubService({ scrubber: Effect.sync(() => options.scrubber) })),
      Context.add(
        EnvironmentAuth.EnvironmentAuth,
        stubService({ authenticateWebSocketUpgrade: () => Effect.succeed(session) }),
      ),
      Context.add(
        SessionStore.SessionStore,
        stubService({ awaitInvalidation: () => Effect.never }),
      ),
      Context.add(
        ServerSettings.ServerSettingsService,
        stubService({
          subscribeChanges: Effect.succeed(Stream.never),
          streamChanges: Stream.never,
        }),
      ),
      Context.add(
        SecureRandom.SecureRandom,
        stubService({ uuidV4: () => Effect.succeed("00000000-0000-4000-8000-000000000000") }),
      ),
      // The route follows every terminal from its start, and stops when it closes.
      Context.add(
        TerminalManager.TerminalManager,
        stubService({ subscribe: () => Effect.succeed(() => {}) }),
      ),
    );
    const services = Context.merge(
      Context.merge(stubs, fixed),
      options.services ?? Context.empty(),
    );
    const app = HttpRouter.serve(Ws.layer).pipe(
      Layer.provide(Layer.succeedContext(services)),
      Layer.provide(
        Option.isSome(Context.getOption(services, SqlClient.SqlClient))
          ? Layer.empty
          : SqlitePersistence.layerMemory,
      ),
      Layer.provide(ServerConfig.layerTest(os.tmpdir(), { prefix: "ws-test-" })),
      Layer.provide(FetchHttpClient.layer),
      Layer.provideMerge(NodeServices.layer),
      // The route digests what it signs (effect/crypto Digest), as server.ts provides it.
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(
        NodeHttpServer.layer(() => http.createServer(), { host: "127.0.0.1", port: 0 }),
      ),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the layer's errors are the test's to fail on.
    const context = yield* Layer.build(app as Layer.Layer<HttpServer.HttpServer, any, never>);
    const { port } = Context.get(context, HttpServer.HttpServer).address as {
      readonly port: number;
    };
    return `ws://127.0.0.1:${port}/ws?orchestrationProtocol=${ORCHESTRATION_PROTOCOL_VERSION}`;
  });

/** An RPC client on `url` over a real WebSocket, as the app's T3 client connects; it lives as long as the scope. */
export const wsClient = (url: string) =>
  Layer.build(
    RpcClient.layerProtocolSocket().pipe(
      Layer.provide(Socket.layerWebSocket(url)),
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provide(RpcSerialization.layerJson),
    ),
  ).pipe(
    Effect.flatMap((protocol) => RpcClient.make(WsRpcGroup).pipe(Effect.provideContext(protocol))),
  );
