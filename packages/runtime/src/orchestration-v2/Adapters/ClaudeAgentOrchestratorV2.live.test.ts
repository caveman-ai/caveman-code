// ), apps/server/src/orchestration-v2/AcpRegistryOrchestratorV2.live.test.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Claude Agent against the user's own installed `claude` and its own login,
 * through the production V2 harness: provider status (version, sign-in, the
 * "Claude Agent" label), a Space plugin loaded for the session through SDK
 * options, two turns on one session, and usage recorded as events.
 *
 * Opt-in, and plan login only (no API key): it runs two short turns on the
 * cheapest model.
 *
 *   CAVEMAN_LIVE_CLAUDE=1 pnpm --filter @caveman-app/runtime exec vitest run \
 *     src/orchestration-v2/Adapters/ClaudeAgentOrchestratorV2.live.test.ts
 *
 * The suite runs in a scratch HOME (root vitest config). Only the `claude`
 * child gets the user's real home, through the instance environment, so the
 * CLI finds its own login; the runtime never opens it. The CLI loads no
 * settings files (the user's hooks stay out), asks before any tool, and saves
 * no transcript or auto-memory under the user's ~/.claude
 * (`--no-session-persistence`), so turn 2 recalls turn 1 from the live
 * process, not from a disk resume.
 */
import * as OpenCodeRuntime from "@caveman-app/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@caveman-app/provider-opencode/server/OpenCodeServerLedger";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@caveman-app/protocol";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";
import { describe } from "vitest";

import * as ResetCreditCoordinator from "../../provider/resetCreditCoordinator.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerConfig from "../../config.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ModelManifest from "../../provider/ModelManifest.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as AntigravityInstallation from "../../provider/AntigravityInstallation.ts";
import * as ProviderInstanceRegistryHydration from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderTurnStartServiceTestkit from "../ProviderTurnStartService.testkit.ts";
import * as RuntimeLayer from "../runtimeLayer.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import {
  CLAUDE_SPACE_PLUGIN_DIR,
  CLAUDE_SPACE_PLUGIN_MARKER,
  CLAUDE_SPACE_PLUGIN_PROMPT,
} from "../testkit/fixtures/claude_space_plugin/input.ts";

const live = process.env.CAVEMAN_LIVE_CLAUDE === "1";
const instanceId = ProviderInstanceId.make("claudeAgent");
const modelSelection = {
  instanceId,
  model: process.env.CAVEMAN_LIVE_CLAUDE_MODEL ?? "claude-haiku-4-5",
} satisfies ModelSelection;

// CAVEMAN_LIVE_CLAUDE_LOG=<file> keeps the CLI's native frames for diagnosis.
const nativeLogPath = process.env.CAVEMAN_LIVE_CLAUDE_LOG;
const liveEventLoggers: ProviderEventLoggers.ProviderEventLoggers["Service"] =
  nativeLogPath === undefined
    ? ProviderEventLoggers.NoOpProviderEventLoggers
    : {
        native: {
          filePath: nativeLogPath,
          write: (event) =>
            Effect.sync(() => NodeFS.appendFileSync(nativeLogPath, `${JSON.stringify(event)}\n`)),
          close: () => Effect.void,
        },
        canonical: undefined,
      };

const layerPlatformTest = Layer.merge(
  Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "caveman-claude-agent-v2-live-",
});
const layerCheckpointStore = CheckpointStore.layer.pipe(
  Layer.provide(
    VcsDriverRegistry.layer.pipe(
      Layer.provide(VcsProcess.layer),
      Layer.provide(layerServerConfig),
      Layer.provide(layerPlatformTest),
    ),
  ),
);
// The default account: no homePath, so the CLI uses the user's own config
// directory and login. binaryPath "claude" resolves past PATH shims.
const layerServerSettings = ServerSettings.layerTest({
  providerInstances: {
    [instanceId]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
      environment: [
        { name: "HOME", value: NodeOS.userInfo().homedir, sensitive: false },
        { name: "CLAUDE_CODE_DISABLE_AUTO_MEMORY", value: "1", sensitive: false },
      ],
      config: { launchArgs: "--no-session-persistence" },
    },
  },
});
const layerBackgroundPolicy = BackgroundPolicy.layer.pipe(
  Layer.provide(Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make())),
  Layer.provide(layerServerSettings),
);
const layerProviderInstanceRegistry = ProviderInstanceRegistryHydration.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerServerConfig.pipe(Layer.provide(layerPlatformTest)),
      AntigravityInstallation.AntigravityInstallation.layer.pipe(
        Layer.provide(layerServerConfig.pipe(Layer.provide(layerPlatformTest))),
        Layer.provide(FetchHttpClient.layer),
        Layer.provide(layerPlatformTest),
      ),
      layerServerSettings,
      ServerSecretStore.layer.pipe(
        Layer.provide(layerServerConfig),
        Layer.provide(layerPlatformTest),
      ),
      NodeServices.layer,
      NodeCrypto.layer,
      FetchHttpClient.layer,
      OpenCodeRuntime.layer.pipe(
        Layer.provide(OpenCodeServerLedger.layerTest),
        Layer.provide(layerPlatformTest),
      ),
      Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, liveEventLoggers),
      ProviderLatestVersions.layer,
      ModelManifest.layerTest,
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
      // What the Spaces registry hands every Claude Agent session.
      Layer.succeed(SessionPlugins.SessionPlugins, {
        acp: () => Effect.succeed([]),
        codex: () => Effect.succeed({ config: { mcp_servers: {} }, developerInstructions: "" }),
        claudeAgent: () =>
          Effect.succeed({
            plugins: [{ type: "local", path: CLAUDE_SPACE_PLUGIN_DIR, skipMcpDiscovery: true }],
            mcpServers: {},
            settingSources: [],
            appendSystemPrompt: "",
          }),
      }),
    ),
  ),
);

const layerLive = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(layerCheckpointStore),
  Layer.provide(layerServerConfig),
  Layer.provide(layerServerSettings),
  Layer.provideMerge(layerProviderInstanceRegistry),
  Layer.provide(ResetCreditCoordinator.layer),
  Layer.provide(layerBackgroundPolicy),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(layerPlatformTest),
  Layer.provide(McpProviderSessions.layer),
);

const waitForIdle = Effect.fn("ClaudeAgentOrchestratorV2Live.waitForIdle")(function* (
  threadId: ThreadId,
  expectedRunCount: number,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const projection = yield* orchestrator.getThreadProjection(threadId);
    if (
      projection.runs.length >= expectedRunCount &&
      projection.runs.every(
        (run) => !["queued", "starting", "running", "waiting"].includes(run.status),
      )
    ) {
      return projection;
    }
    yield* Effect.sleep("500 millis");
  }
  const projection = yield* orchestrator.getThreadProjection(threadId);
  return yield* Effect.die(
    new Error(
      `Timed out waiting for Claude Agent thread ${threadId}: runs ${JSON.stringify(
        projection.runs.map((run) => run.status),
      )}, provider turns ${JSON.stringify(projection.providerTurns.map((turn) => turn.status))}, items ${JSON.stringify(
        projection.turnItems.map((item) => item.type),
      )}`,
    ),
  );
});

describe.runIf(live)("Claude Agent V2 live orchestrator", () => {
  it.live(
    "runs the user's own claude with a Space plugin through the production V2 harness",
    () =>
      Effect.gen(function* () {
        // The outbox daemon starts provider turns, as the server runs it.
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(Effect.forkScoped);
        const registry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
        const instance = yield* registry.getInstance(instanceId);
        assert.isDefined(instance);
        const status = yield* instance!.snapshot.refresh;
        yield* Console.log(
          `provider: ${status.displayName} ${status.version} ${status.status} auth=${status.auth.status} (${status.auth.label ?? "no label"})`,
        );
        assert.equal(status.displayName, "Claude Agent");
        assert.equal(status.status, "ready");
        assert.equal(status.auth.status, "authenticated");
        assert.match(status.version ?? "", /^\d+\.\d+\.\d+/);

        // A scratch cwd stands in for the workspace; no project is registered.
        const fileSystem = yield* FileSystem.FileSystem;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "claude-agent-live-" });
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projectId = ProjectId.make("project:claude-agent-live");
        const threadId = ThreadId.make("thread:claude-agent-live");
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:claude-agent-live:create"),
          threadId,
          projectId,
          title: "Claude Agent live",
          modelSelection,
          // The prompts need no tool; any tool the model picks would ask.
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:claude-agent-live:first"),
          threadId,
          messageId: MessageId.make("message:claude-agent-live:first"),
          text: CLAUDE_SPACE_PLUGIN_PROMPT,
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const first = yield* waitForIdle(threadId, 1);
        const firstText = first.messages.findLast((message) => message.role === "assistant")?.text;
        yield* Console.log(`turn 1 (${CLAUDE_SPACE_PLUGIN_PROMPT}): ${JSON.stringify(firstText)}`);
        assert.deepEqual(
          first.runs.map((run) => run.status),
          ["completed"],
        );
        assert.include(firstText ?? "", CLAUDE_SPACE_PLUGIN_MARKER);

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("command:claude-agent-live:second"),
          threadId,
          messageId: MessageId.make("message:claude-agent-live:second"),
          text: "Repeat the exact word you replied with in your previous message. Reply with only that word.",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const second = yield* waitForIdle(threadId, 2);
        const secondText = second.messages.findLast((message) => message.role === "assistant")?.text;
        yield* Console.log(`turn 2 (recall): ${JSON.stringify(secondText)}`);
        assert.deepEqual(
          second.runs.map((run) => run.status),
          ["completed", "completed"],
        );
        assert.include(secondText ?? "", CLAUDE_SPACE_PLUGIN_MARKER);
        assert.deepEqual(
          second.providerTurns.map((turn) => turn.status),
          ["completed", "completed"],
        );
        // Usage is recorded per provider turn (never shown inside the session).
        const usage = second.providerTurns.map((turn) => turn.turnTokenUsage);
        yield* Console.log(`turn usage: ${JSON.stringify(usage)}`);
        for (const turn of usage) {
          assert.equal(turn?.usageStatus, "complete");
          assert.isAbove(turn?.outputTokens ?? 0, 0);
        }
        yield* Console.log(
          `provider sessions: ${second.providerSessions.length}, provider threads: ${second.providerThreads.length}`,
        );
      }).pipe(Effect.provide(Layer.merge(layerLive, Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))), Effect.scoped),
    300_000,
  );
});
