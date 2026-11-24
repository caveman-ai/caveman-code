// Test-only: the runtime's Session Protocol route on upstream orchestrator with
// the Claude replay provider, served on a real port, plus a temp repo.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CommandId, EnvironmentId, ProviderDriverKind, ThreadId } from "@caveman-app/protocol";
import type { connect, Params, Workspace } from "@caveman-app/session-protocol";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import type { ProviderReplayGate } from "@caveman-app/engine-testing/replayGate";
import { readProviderReplayTranscript } from "@caveman-app/engine-testing/replayTranscript";
import * as Context from "effect/Context";
import { CavemanKeyTester } from "@caveman-app/provider-caveman/server";
import { FirecrawlLocalBinary } from "../web/firecrawlLocal.ts";
import { WebKeyChecker } from "../web/WebKeys.ts";
import { AppProxyLauncher } from "../router/proxyLauncher.ts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import { FetchHttpClient, HttpRouter, HttpServer } from "effect/http";

import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import { fileURLToPath } from "node:url";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CloudTools from "../cloudLink/tools.ts";
import { toolsRun, toolsSocket } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import { CloudComputer, CloudLinkState, type CloudComputerInfo, type LinkState } from "../cloudLink/index.ts";
import * as EgressScrub from "../secrets/EgressScrub.ts";
import * as EngineEgress from "../secrets/EngineEgress.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { ClaudeOrchestratorReplayHarness, makeClaudeRestartReplayHarness } from "../orchestration-v2/Adapters/ClaudeAdapterV2.testkit.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "../orchestration-v2/testkit/ReplayRuntimeInstructions.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as ClientToolsEndpoint from "../mcp/clientToolsEndpoint.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as DesktopBrowserChannel from "../preview/DesktopBrowserChannel.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SessionProtocol from "./index.ts";

export const PROMPT = "Respond with the following text: fixture simple ok";
export const MODEL = "claude-sonnet-4-6";

export const loadTranscript = () =>
  Effect.runPromise(
    readProviderReplayTranscript(new URL("../orchestration-v2/testkit/fixtures/simple/claude_transcript.ndjson", import.meta.url)).pipe(
      Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
      Effect.flatMap((raw) =>
        ClaudeOrchestratorReplayHarness.decodeTranscript(
          materializeReplayTranscriptRuntimeInstructions(raw, { driver: ProviderDriverKind.make("claudeAgent"), model: MODEL }),
        ),
      ),
    ),
  );

export type Transcript = Awaited<ReturnType<typeof loadTranscript>>;

export const git = (cwd: string, ...args: Array<string>) => execFileSync("git", args, { cwd, encoding: "utf8" });

/** A repo on main with one commit holding `files`. */
export function makeRepo(root: string, files: Record<string, string>): string {
  const repo = path.join(root, `repo-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
    fs.writeFileSync(path.join(repo, name), text);
  }
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  return repo;
}

export const makeConfig = () =>
  Effect.runPromise(ProviderReplayHarness.makeReplayServerConfig("session-protocol").pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))));

/** scripts/smoke-claude.mjs: a stand-in `claude` CLI that answers any prompt with "smoke ok: <prompt>". */
export const FAKE_CLAUDE = fileURLToPath(new URL("../../scripts/smoke-claude.mjs", import.meta.url));

/**
 * One runtime on `config`'s state dir. With a transcript: the Claude replay
 * provider (with a gate it must play the whole transcript, a turn runs;
 * without one, no turn is expected). With "fake-claude": the real Claude
 * adapter and SDK spawning scripts/smoke-claude.mjs, which answers any prompt.
 */
/**
 * Where tests keep upstream headless shell (about 100 MB, downloaded once on the
 * first browser test, as the runtime itself does on first use).
 */
export const TEST_BROWSER_HOME = process.env.CAVEMAN_TEST_BROWSER_HOME ?? path.join(os.tmpdir(), "caveman-runtime-test-browser");
const layerPreviewBrowser = Layer.effect(PreviewBrowser.PreviewBrowser, PreviewBrowser.makePreviewBrowser({ baseDir: TEST_BROWSER_HOME })).pipe(
  Layer.provide(Layer.mergeAll(FetchHttpClient.layer, NodeServices.layer, NodeCrypto.layer)),
);

/** Installs the headless shell if missing; T3 answers "installing" after 45 s, so this asks again. */
export const ensureTestBrowser = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const browser = yield* PreviewBrowser.PreviewBrowser;
      for (let attempt = 1; ; attempt++) {
        const exit = yield* Effect.exit(browser.executable);
        if (exit._tag === "Success" || attempt === 12) return yield* exit;
      }
    }).pipe(Effect.provide(layerPreviewBrowser)),
  );

export async function startRuntime(
  config: ServerConfig.ServerConfig["Service"],
  engine: Transcript | "fake-claude",
  gate?: ProviderReplayGate,
  options: {
    readonly browser?: boolean;
    /** Services the route sees first (a fake SkillWriter, settings with spaces). */
    readonly provide?: Layer.Layer<any, never, any>;
    /** Engines to run instead of `engine`'s Claude (a scripted Caveman engine). */
    readonly registry?: Layer.Layer<ProviderAdapterRegistry.ProviderAdapterRegistryV2>;
    /** Also serves grill mode's MCP endpoint (/mcp/grill) with the runtime's real credential registry, in the returned context. */
    readonly grillMcp?: boolean;
    /** Also serves the custom tools' MCP endpoint (/mcp/client), with that registry. */
    readonly clientMcp?: boolean;
    /** With "fake-claude": engines the stand-in CLI also serves (Claude driver, that engine's id), to watch what they are sent. */
    readonly alsoAs?: ReadonlyArray<"caveman" | "codex" | "gemini">;
    /** With "fake-claude": the claude to run instead of the stand-in itself (a wrapper around it). */
    readonly claudeBinary?: string;
    /** Exercise retrieve status projection from the real SDK with the stand-in CLI. */
    readonly compressionRetrieveExpected?: boolean;
    /** As serverRuntimeStartup does: settle the runs a crash left open before serving (a restart on the same state dir). */
    readonly recoverOnStartup?: boolean;
    /**
     * T3 is left unstarted: no startup recovery, no effect worker. The test runs them itself, at a moment of its own and
     * in serverRuntimeStartup's order, from the returned context (ProviderRuntimeRecoveryService, the orchestrator, the
     * effect worker): what a call that arrives while the runtime starts meets.
     */
    readonly startT3?: false;
    /** Exercise the production attachment cleanup worker, not the replay default's no-op. */
    readonly realResourceCleanup?: boolean;
    /**
     * This runtime is a Cloud computer: its identity and its one link state, seen by every part of it (the route, the
     * egress scrub, the engines' launches) as the two defaults are in production.
     */
    readonly cloudComputer?: { readonly computer: CloudComputerInfo; readonly link: LinkState };
    /** With "fake-claude": its model requests go through the egress scrub, as server.ts routes every engine (EngineEgress). */
    readonly egress?: boolean;
  } = {},
) {
  const db = SqlitePersistence.layerFromPath(config.dbPath).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const layerConfig = Layer.succeed(ServerConfig.ServerConfig, config);
  const computerWide = options.cloudComputer
    ? Layer.mergeAll(Layer.succeed(CloudComputer, options.cloudComputer.computer), Layer.succeed(CloudLinkState, options.cloudComputer.link))
    : Layer.empty;
  // Repository secrets on the state dir's secret store (never the keychain), in the returned context for tests.
  // Wrapped in EgressScrub.layer as server.ts does, so handlers see the scrubber production hands them.
  const secrets = EgressScrub.layer.pipe(
    Layer.provide(ProjectSecretsLive.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(Layer.mergeAll(layerConfig, NodeServices.layer, NodeCrypto.layer)),
    Layer.provide(computerWide),
  );
  // One registry instance, shared by the orchestrator and the route (engine.list), by layer identity.
  const registry =
    options.registry ??
    (engine === "fake-claude"
      ? ProviderAdapterRegistry.layerFromDrivers({
          drivers: [ClaudeAdapterV2.ClaudeAdapterV2Driver],
          configMap: Object.fromEntries(
            [ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID, ...(options.alsoAs ?? [])].map((id) => [id, { driver: ClaudeAdapterV2.CLAUDE_PROVIDER, config: { binaryPath: options.claudeBinary ?? FAKE_CLAUDE } }]),
          ),
        }).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.effect(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, Effect.gen(function* () {
                const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
                return {
                  ...runner,
                  open: (input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput) => runner.open(input).pipe(
                    Effect.map((session) => ({ ...session, compressionRetrieveExpected: options.compressionRetrieveExpected === true })),
                  ),
                };
              })).pipe(
                Layer.provide(options.egress ? EngineEgress.layerClaudeEgress.pipe(Layer.provide(ClaudeAdapterV2.layerQueryRunner), Layer.provide(secrets)) : ClaudeAdapterV2.layerQueryRunner),
                Layer.provide(Layer.succeed(ProviderEventLoggers.ProviderEventLoggers, ProviderEventLoggers.NoOpProviderEventLoggers)),
                // As server.ts: on a Cloud computer the CLI starts in the tools container.
                Layer.provide(toolsSocket() === undefined ? Layer.empty : CloudTools.agentScopeLayer(toolsSocket()!)),
                Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
              ),
              IdAllocator.layer,
              McpProviderSessions.layer,
              layerConfig,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
          Layer.provide(computerWide),
          Layer.orDie,
        )
      : (gate ? ClaudeOrchestratorReplayHarness : makeClaudeRestartReplayHarness(engine).harness)
          .makeProviderAdapterRegistryLayer(engine, gate ? { replayGate: gate } : {})
          .pipe(Layer.provide(McpProviderSessions.layer)));
  const orchestration = ProviderReplayHarness.layerWithRegistry({ name: "session-protocol" }, registry, {
    databaseLayer: db,
    ...(options.recoverOnStartup ? { recoverOnStartup: true } : {}),
    ...(options.startT3 === false ? { runEffectWorker: false } : {}),
    ...(options.realResourceCleanup ? {
      serverConfig: config,
      resourceCleanupLayer: ResourceCleanupService.layer.pipe(Layer.provide(Layer.mergeAll(
        layerConfig, NodeServices.layer, NodeCrypto.layer,
        // This test runtime never opens terminals or previews; filesystem cleanup is real.
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({ deleteForThread: () => Effect.void }),
      ))),
    } : {}),
  });
  const gitLayer = GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer), Layer.provide(layerConfig), Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  // As server.ts: fs.diff reads a turn's authored paths through it.
  const checkpointStore = CheckpointStore.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProcess.layer), Layer.provide(layerConfig), Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)))),
  );
  const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("session-protocol-test")),
    getDescriptor: Effect.die("unused descriptor"),
  });
 // upstream server browser as server.ts wires it, without a desktop.
  const browser = ServerBrowser.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        PreviewAutomationBroker.layer,
        PreviewManager.layer,
        environment,
        layerPreviewBrowser,
        DesktopBrowserChannel.layer,
      ),
    ),
    Layer.provide(Layer.mergeAll(layerConfig, NodeServices.layer, NodeCrypto.layer)),
  );
  // As server.ts serves it: the grill toolkit answers as the calling thread, which must have a live run.
  const grillMcp = McpHttpServer.layerGrillToolkit.pipe(
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          return Layer.mock(ThreadManagementService.ThreadManagementService)({ getThreadShell: orchestrator.getThreadShell });
        }),
      ),
    ),
    Layer.provide(SessionProtocol.layerGrill),
  );
  // A key's add-time test call never leaves the machine in tests: one holding "refused" is refused, any other works.
  const keyTester = Layer.succeed(CavemanKeyTester, (_provider, credential) =>
    Effect.succeed(credential.key?.includes("refused") ? { ok: false as const, kind: "auth" as const, message: "401 invalid key" } : { ok: true as const, model: "stub" }),
  );
  // Nor does a web search key's check: one holding "refused" is refused, "limited" is rate limited, any other works.
  const webKeyChecker = Layer.succeed(WebKeyChecker, async (_provider, key) =>
    key.includes("refused") ? { ok: false as const, kind: "auth" as const, message: "401: invalid key" } : key.includes("limited") ? { ok: false as const, kind: "limit" as const, message: "429: slow down" } : { ok: true as const },
  );
  // Nor a Firecrawl Local this machine happens to have.
  const noFirecrawlLocal = Layer.succeed(FirecrawlLocalBinary, () => undefined);
  // Never a real caveman-proxy.
  const noProxy = Layer.succeed(AppProxyLauncher, () => Promise.resolve({ app: "no_binary" as const, codex: "no_binary" as const }));
  // As server.ts: an attached document's text is read out beside it, in a child process of the runtime's own.
  const documents = DocumentText.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));
  const baseRoute = SessionProtocol.layerRoute.pipe(
    Layer.provide(options.provide ? Layer.mergeAll(keyTester, webKeyChecker, noFirecrawlLocal, noProxy, documents, options.provide) : Layer.mergeAll(keyTester, webKeyChecker, noFirecrawlLocal, noProxy, documents)),
    Layer.provide(computerWide),
  );
  const clientMcp = ClientToolsEndpoint.layerRoute.pipe(Layer.provide(SessionProtocol.layerClientTools));
  const route = Layer.mergeAll(baseRoute, ...(options.grillMcp ? [grillMcp] : []), ...(options.clientMcp ? [clientMcp] : []));
  // With the browser, its services are also in the returned context (tests read the preview manager).
  const served = options.browser ? HttpRouter.serve(route).pipe(Layer.provideMerge(browser)) : HttpRouter.serve(route);
  // Grill keeps nothing in memory, so tests post rounds through it as the grill MCP tool does.
  const app = served.pipe(
    Layer.provideMerge(SessionProtocol.layerGrill),
    // Custom tool calls, as the client MCP endpoint posts them (session-protocol/clientTools.ts).
    Layer.provideMerge(SessionProtocol.layerClientTools),
    Layer.provideMerge(secrets),
 // In the returned context too: tests drive upstream orchestrator as an agent would (delegate_task).
    Layer.provideMerge(orchestration),
    Layer.provide(registry),
    // The Chief's host, shared by the route and the registry's Caveman adapter (one instance), and in the returned context.
    Layer.provideMerge(SessionProtocol.layerChiefHost),
    // Setup chats' tool bridge, in the returned context too (tests call environment_build through it).
    Layer.provideMerge(SessionProtocol.layerSetupChats),
    Layer.provideMerge(SessionProtocol.layerChatPreviews),
    // Builders' bridge, in the returned context too (tests call delegate_task's builder path through it).
    Layer.provideMerge(SessionProtocol.layerBuilders),
    Layer.provideMerge(SessionProtocol.layerMacMail),
    // Cloud schedules' bridge, in the returned context too (tests call schedule_task's Cloud path through it).
    Layer.provideMerge(SessionProtocol.layerCloudSchedules),
    Layer.provide(Layer.mergeAll(db, gitLayer, checkpointStore, layerConfig, environment, NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(
      options.grillMcp || options.clientMcp ? McpSessionRegistry.layer.pipe(Layer.provide(Layer.mergeAll(environment, NodeServices.layer, NodeCrypto.layer))) : Layer.empty,
    ),
    Layer.provideMerge(
      NodeHttpServer.layer(() => SessionProtocol.denyFraming(http.createServer()), {
        host: "127.0.0.1",
        port: 0,
        // As server.ts (HTTP_PREEMPTIVE_SHUTDOWN_GRACE_MS): no 20 s drain while a client is still connected.
        gracefulShutdownTimeout: 0,
        websocket: { handleProtocols: SessionProtocol.selectSubprotocol },
      }),
    ),
  );
  const scope = await Effect.runPromise(Scope.make());
  const context = await Effect.runPromise(Layer.buildWithScope(app as Layer.Layer<HttpServer.HttpServer>, scope));
  const port = (Context.get(context, HttpServer.HttpServer).address as { port: number }).port;
  const token = () => fs.readFileSync(path.join(config.stateDir, SessionProtocol.TOKEN_FILE), "utf8");
  return { port, url: `ws://127.0.0.1:${port}/session/v1`, token, context, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
}

export const tempRoot = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/**
 * A real app for a test desktop (CAVEMAN_TEST_DESKTOP_TOOLS): one text field over the whole page; its text is the
 * window's title, or past 200 characters its length and end (desktopLongTitle), so long text doesn't redraw a long title.
 */
const DESKTOP_TEST_PAGE =
  "data:text/html,<title>Desktop test</title><style>input{position:fixed;inset:0;width:100%;height:100%;border:0;padding:40px;font:40px sans-serif}</style><input placeholder=\"Type here\" oninput=\"const v=this.value;document.title=v.length>200?v.length+' chars, ending '+v.slice(-12):v||'Desktop test'\">";
/** The test window's title for `text` past 200 characters. */
export const desktopLongTitle = (text: string) => `${text.length} chars, ending ${text.slice(-12)}`;

/** Whether a window on the test desktop is titled exactly `title`. */
export const desktopWindowTitled = async (socket: string, title: string) =>
  (await toolsRun(socket, "/", ["sh", "-c", 'DISPLAY=:99 LC_ALL=C.UTF-8 xdotool search --onlyvisible --name "^$1$"', "sh", title])).code === 0;

/** The image's Chrome as an app window over the test desktop, started as the agent would, from its shell. */
export async function openDesktopTestWindow(socket: string) {
  // As the computer tool's description says: backgrounded from the shell, it outlives the command.
  const script =
    'rm -rf /tmp/desktop-test-chrome; DISPLAY=:99 chrome --no-first-run --no-default-browser-check --disable-gpu --user-data-dir=/tmp/desktop-test-chrome --window-position=0,0 --window-size=1280,800 "--app=$1" >/dev/null 2>&1 &';
  await toolsRun(socket, "/", ["sh", "-c", script, "sh", DESKTOP_TEST_PAGE]);
  const deadline = Date.now() + 120_000;
  while (!(await desktopWindowTitled(socket, "Desktop test"))) {
    if (Date.now() > deadline) throw new Error("the test window never showed on the desktop");
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export async function until(check: () => boolean | Promise<boolean>, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * workspace.create, then the workspace once its start ended (worktree, thread, the task's turn sent): it answers
 * before its worktree exists. Any call acting on a workspace waits for that; queue.list is the cheapest.
 */
export async function createReady(client: ReturnType<typeof connect>, params: Params<"workspace.create">) {
  const workspace = await client.call("workspace.create", params);
  await client.call("queue.list", { session_id: workspace.session_id });
  return client.call("workspace.get", { workspace_id: workspace.id });
}

/** upstream orchestrator from a runtime's context: tests act as an agent would. */
export const orchestratorOf = (runtime: { readonly context: unknown }) =>
  Context.get(runtime.context as Context.Context<Orchestrator.OrchestratorV2>, Orchestrator.OrchestratorV2);

/** What the caveman-code MCP's delegate_task dispatches, from the lead's running turn. */
export async function delegateFrom(orchestrator: Orchestrator.OrchestratorV2["Service"], lead: Workspace, task: string, key: string) {
  const parentThreadId = ThreadId.make(`caveman:${lead.id}`);
  await until(async () => (await Effect.runPromise(orchestrator.getThreadProjection(parentThreadId))).runs.some((r) => r.status === "running"));
  const projection = await Effect.runPromise(orchestrator.getThreadProjection(parentThreadId));
  const run = projection.runs.find((r) => r.status === "running")!;
  await Effect.runPromise(
    orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make(`test-delegate:${key}`),
      parentThreadId,
      parentRunId: run.id,
      parentNodeId: run.rootNodeId!,
      task,
      title: key,
      modelSelection: projection.thread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
    }),
  );
}
