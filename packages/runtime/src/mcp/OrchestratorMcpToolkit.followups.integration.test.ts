// Settings > Agents' limits on an agent that sets a finished delegated agent working again with thread_send:
// the real orchestrator turns that message into a new delegated task, so it counts like delegate_task.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadProjection,
  OrchestratorMcpDelegateTaskResult,
  OrchestratorMcpThreadSendResult,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import { ClaudeProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { checkpointWorkspace } from "@caveman-app/engine-testing/replayWorkspace";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const layerOrchestratorToolkit = McpHttpServer.layerOrchestratorToolkit.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const parentThreadId = ThreadId.make("thread:followup-limits-parent");
const projectId = ProjectId.make("project:followup-limits");
const codexInstanceId = ProviderInstanceId.make("codex");
const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
const codexModel = "gpt-5.4";
const claudeModel = "claude-sonnet-4-6";
const keepWorking = "Keep working until stopped.";

const decodeDelegateTaskResult = Schema.decodeUnknownEffect(OrchestratorMcpDelegateTaskResult);
const decodeThreadSendResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSendResult);

const codexSelection = { instanceId: codexInstanceId, model: codexModel } satisfies ModelSelection;

function makeProviderSnapshot(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
}): ServerProvider {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: true,
    installed: true,
    version: "test",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-06-17T00:00:00.000Z",
    models: [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  };
}

function unsupported(driver: ProviderDriverKind, detail: string) {
  return Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
}

// A provider whose turns either finish at once with a reply or keep running.
function makeDeterministicAdapter(input: {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly capabilities: OrchestrationV2ProviderCapabilities;
  readonly shouldComplete: (turn: ProviderAdapter.ProviderAdapterV2TurnInput) => boolean;
}): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId: input.instanceId,
    driver: input.driver,
    getCapabilities: () => Effect.succeed(input.capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (sessionInput) =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        const providerSession: OrchestrationV2ProviderSession = {
          id: sessionInput.providerSessionId,
          driver: input.driver,
          providerInstanceId: input.instanceId,
          status: "ready",
          cwd: sessionInput.runtimePolicy.cwd ?? process.cwd(),
          model: sessionInput.modelSelection.model,
          capabilities: input.capabilities,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const publish = (providerEvents: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
          Effect.forEach(providerEvents, (event) => PubSub.publish(events, event), {
            discard: true,
          });
        const runOrdinals = new Map<ProviderTurnId, number>();
        return {
          instanceId: input.instanceId,
          driver: input.driver,
          providerSessionId: sessionInput.providerSessionId,
          providerSession,
          events: Stream.fromPubSub(events),
          ensureThread: (threadInput) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeThreadId = `${input.driver}:${threadInput.threadId}`;
              return {
                id: ProviderThreadId.make(`provider-thread:${nativeThreadId}`),
                driver: input.driver,
                providerInstanceId: input.instanceId,
                providerSessionId: sessionInput.providerSessionId,
                appThreadId: threadInput.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver: input.driver,
                  nativeId: nativeThreadId,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turnInput) =>
            Effect.gen(function* () {
              const eventTime = yield* DateTime.now;
              const providerTurnId = ProviderTurnId.make(
                `provider-turn:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}`,
              );
              runOrdinals.set(providerTurnId, turnInput.runOrdinal);
              const providerTurn = (status: "running" | "completed") => ({
                id: providerTurnId,
                providerThreadId: turnInput.providerThread.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: {
                  driver: input.driver,
                  nativeId: `native-turn:${turnInput.threadId}:${turnInput.runOrdinal}`,
                  strength: "strong" as const,
                },
                ordinal: turnInput.providerTurnOrdinal,
                status,
                startedAt: eventTime,
                completedAt: status === "completed" ? eventTime : null,
              });
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: providerTurn("running"),
                },
              ]);
              if (!input.shouldComplete(turnInput)) return;
              yield* publish([
                {
                  type: "provider_turn.updated",
                  driver: input.driver,
                  providerTurn: providerTurn("completed"),
                },
                {
                  type: "turn_item.updated",
                  driver: input.driver,
                  turnItem: {
                    id: TurnItemId.make(
                      `turn-item:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    threadId: turnInput.threadId,
                    runId: turnInput.runId,
                    nodeId: turnInput.rootNodeId,
                    providerThreadId: turnInput.providerThread.id,
                    providerTurnId,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: turnInput.runOrdinal * 100 + 1,
                    status: "completed",
                    title: null,
                    startedAt: eventTime,
                    completedAt: eventTime,
                    updatedAt: eventTime,
                    type: "assistant_message",
                    messageId: MessageId.make(
                      `message:${input.instanceId}:${turnInput.threadId}:${turnInput.runOrdinal}:assistant`,
                    ),
                    text: `Done: ${turnInput.message.text}`,
                    streaming: false,
                  },
                },
                {
                  type: "turn.terminal",
                  driver: input.driver,
                  providerThreadId: turnInput.providerThread.id,
                  providerTurnId,
                  runOrdinal: turnInput.runOrdinal,
                  status: "completed",
                  failure: null,
                  threadDisposition: "reusable",
                },
              ]);
            }),
          steerTurn: () => Effect.void,
          interruptTurn: ({ providerThread, providerTurnId }) =>
            publish([
              {
                type: "turn.terminal",
                driver: input.driver,
                providerThreadId: providerThread.id,
                providerTurnId,
                runOrdinal: runOrdinals.get(providerTurnId) ?? 1,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              },
            ]),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => unsupported(input.driver, "unused"),
          rollbackThread: () => unsupported(input.driver, "unused"),
          forkThread: () => unsupported(input.driver, "unused"),
        };
      }),
  };
}

function waitForProjection(
  orchestrator: Orchestrator.OrchestratorV2Shape,
  threadId: ThreadId,
  predicate: (projection: OrchestrationV2ThreadProjection) => boolean,
) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 1_000; attempt += 1) {
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (predicate(projection)) return projection;
      yield* Effect.sleep("5 millis");
    }
    return yield* Effect.die(
      new Error(`Timed out waiting for orchestration projection ${threadId}.`),
    );
  });
}

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "followup-limits", version: "1.0.0" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "followup-limits", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const unusedScheduledTasks = Layer.succeed(
  ScheduledTaskService.ScheduledTaskService,
  ScheduledTaskService.ScheduledTaskService.of({
    list: () => Effect.succeed({ tasks: [] }),
    subscribeList: () => Stream.succeed({ tasks: [] }),
    upsert: () => Effect.die("unused"),
    setEnabled: () => Effect.die("unused"),
    delete: () => Effect.die("unused"),
    deleteForThread: () => Effect.die("unused"),
    runNow: () => Effect.die("unused"),
    rotateWebhookToken: () => Effect.die("unused"),
    listWebhookDeliveries: () => Effect.die("unused"),
    getWebhookDelivery: () => Effect.die("unused"),
    triggerWebhook: () => Effect.die("unused"),
    setRunModel: () => Effect.void,
  }),
);

const ACTIVE = new Set(["pending", "running", "waiting"]);

describe("thread_send to a delegated agent", () => {
  it.live(
    "holds a lead that sets its finished delegated agents working again to Settings > Agents' limits",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const cwd = yield* checkpointWorkspace("followup-limits");
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([
            // The lead on Codex: its turn keeps running, so it stays a live caller.
            makeDeterministicAdapter({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              capabilities: CodexProviderCapabilitiesV2,
              shouldComplete: (turn) => turn.threadId !== parentThreadId,
            }),
            // Delegates on Claude Agent: finish at once unless told to keep working.
            makeDeterministicAdapter({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              capabilities: ClaudeProviderCapabilitiesV2,
              shouldComplete: (turn) => turn.message.text !== keepWorking,
            }),
          ]);
          // Settings > Agents: one delegated agent working at once under this root.
          const settings = ServerSettings.layerTest({ subagents: { maxConcurrent: 1 } });
          const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
            {
              name: "followup-limits",
              runtimePolicyOverride: {
                cwd,
                approvalPolicy: "never",
                sandboxPolicy: {
                  type: "readOnly",
                  access: { type: "fullAccess" },
                  networkAccess: false,
                },
              },
            },
            layerRegistry,
          );
          const layerOrchestration = Layer.merge(
            layerOrchestrator,
            ThreadManagementService.layer.pipe(
              Layer.provide(layerOrchestrator),
              Layer.provide(settings),
              Layer.provide(
                CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
              ),
            ),
          );
          const layerProviderRegistry = ProviderRegistryMock.layer([
            makeProviderSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: codexModel,
            }),
            makeProviderSnapshot({
              instanceId: claudeInstanceId,
              driver: ProviderDriverKind.make("claudeAgent"),
              model: claudeModel,
            }),
          ]);
          const layerTest = Layer.merge(
            layerOrchestratorToolkit,
            McpHttpServer.layerThreadToolkit,
          ).pipe(
            Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
            Layer.provideMerge(layerOrchestration),
            Layer.provide(layerRegistry),
            Layer.provide(layerProviderRegistry),
            Layer.provide(settings),
            Layer.provide(unusedScheduledTasks),
            Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
            Layer.provide(
              Layer.mock(ProjectService.ProjectService)({
                getById: (id) =>
                  Effect.succeed(
                    id === projectId
                      ? Option.some({ id, defaultModelSelection: null } as never)
                      : Option.none(),
                  ),
              }),
            ),
            Layer.provideMerge(Layer.mock(SecretRequests.SecretRequests)({})),
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          );

          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const server = yield* McpServer.McpServer;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:followup-limits:create"),
              threadId: parentThreadId,
              projectId,
              title: "Lead",
              modelSelection: codexSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("command:followup-limits:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("message:followup-limits:start"),
              text: "Lead the work.",
              attachments: [],
              modelSelection: codexSelection,
              dispatchMode: { type: "start_immediately" },
            });
            yield* waitForProjection(
              orchestrator,
              parentThreadId,
              (projection) =>
                projection.runs.some((run) =>
                  ["starting", "running", "waiting"].includes(run.status),
                ) && projection.providerTurns.some((turn) => turn.status === "running"),
            );

            const invocation: McpInvocationContext.McpInvocationScope = {
              environmentId: EnvironmentId.make("environment:followup-limits"),
              requestNamespace: "mcp-provider-session-followup-lead",
              thread: {
                threadId: parentThreadId,
                providerSessionId: "mcp-provider-session-followup-lead",
                providerInstanceId: codexInstanceId,
              },
              client: undefined,
              capabilities: new Set(["orchestration"]),
              issuedAt: 1,
            };
            const invoke = (name: string, args: Record<string, unknown>) =>
              server
                .callTool({ name, arguments: args })
                .pipe(
                  Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
                  Effect.provideService(McpSchema.McpServerClient, client),
                );
            const target = { providerInstanceId: claudeInstanceId, model: claudeModel };
            const working = () =>
              orchestrator
                .getThreadProjection(parentThreadId)
                .pipe(
                  Effect.map((projection) =>
                    projection.subagents.filter(
                      (task) => task.origin === "app_owned" && ACTIVE.has(task.status),
                    ),
                  ),
                );

            // A delegated agent that finishes and publishes its result.
            const finishedCall = yield* invoke("delegate_task", {
              task: "Inspect the API boundary.",
              target,
              mode: "wait",
              timeoutMs: 10_000,
              clientRequestId: "followup-finished",
            });
            expect(finishedCall.isError).toBe(false);
            const finished = yield* decodeDelegateTaskResult(finishedCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(finished.status).toBe("completed");

            // Under the limit, the lead may set it working again; that follow-up finishes too.
            const followupCall = yield* invoke("thread_send", {
              threadId: finished.childThreadId,
              message: "Check the error paths too.",
              clientRequestId: "followup-under-limit",
            });
            expect(followupCall.isError).toBe(false);
            const followup = yield* decodeThreadSendResult(followupCall.structuredContent).pipe(
              Effect.orDie,
            );
            expect(followup.delivery).toBe("started");
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.id === followup.taskId && task.status === "completed",
              ),
            );

            // Another delegated agent keeps working: the tree is at maxConcurrent.
            const workingCall = yield* invoke("delegate_task", {
              task: keepWorking,
              target,
              mode: "async",
              clientRequestId: "followup-working",
            });
            expect(workingCall.isError).toBe(false);
            const busy = yield* decodeDelegateTaskResult(workingCall.structuredContent).pipe(
              Effect.orDie,
            );
            yield* waitForProjection(orchestrator, parentThreadId, (projection) =>
              projection.subagents.some(
                (task) => task.origin === "app_owned" && task.status === "running",
              ),
            );
            const refusedCall = yield* invoke("delegate_task", {
              task: keepWorking,
              target,
              mode: "async",
              clientRequestId: "followup-refused",
            });
            expect(declaredFailure(refusedCall)).toMatchObject({ code: "limit_reached" });

            // Setting the finished one working again would be a second delegated agent at work.
            const overCall = yield* invoke("thread_send", {
              threadId: finished.childThreadId,
              message: keepWorking,
              clientRequestId: "followup-over-limit",
            });
            expect({
              failure: declaredFailure(overCall),
              working: (yield* working()).length,
            }).toEqual({
              failure: expect.objectContaining({ code: "limit_reached" }),
              working: 1,
            });

            // A message to the agent already at work is part of its counted task, so the limit does not refuse it.
            const steerCall = yield* invoke("thread_send", {
              threadId: busy.childThreadId,
              message: "Also look at the retries.",
              clientRequestId: "followup-steer",
            });
            expect(steerCall.isError).toBe(false);
            expect((yield* working()).length).toBe(1);
          }).pipe(Effect.provide(layerTest));
        }),
      ),
    { timeout: 60_000 },
  );
});
