// ), apps/server/src/mcp/OrchestratorMcpService.test.ts @ ab3a3cd1.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  type ExecutionEnvironmentDescriptor,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestrationV2ThreadShell,
  GitCommandError,
  type ScheduledTask,
  ScheduledTaskId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
  type ServerProvider,
} from "@caveman-app/protocol";
import { checkpointWorkspace } from "@caveman-app/engine-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as LegacyV1ThreadImporter from "../orchestration-v2/legacy/LegacyV1ThreadImporter.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import {
  OrchestratorProjectionError,
  OrchestratorThreadAboveModeLimitError,
} from "../orchestration-v2/Orchestrator.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { buildUnavailableProviderSnapshot } from "../provider/unavailableProviderSnapshot.ts";
import { projectIdFor } from "../orchestration-v2/ProjectCommands.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "./McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";
import { SubagentAuto, type PoolTarget, type RouteAnswer, type RouteOutcome, type routeBody } from "../router/subagentAuto.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { BuilderError, Builders, type BuilderComputers, type BuilderStart } from "../session-protocol/builders.ts";
import { MacMail, MacMailError } from "../session-protocol/macMail.ts";
import type { SubagentRunner } from "@caveman-app/session-protocol";
import type { ProjectionRecordFilter } from "../orchestration-v2/ProjectionStore.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);

describe("OrchestratorMcpService", () => {
  it.effect("retries terminal acknowledgement with a fresh command id", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-ack-parent");
      const childThreadId = ThreadId.make("thread:mcp-ack-child");
      const childRunId = RunId.make("run:mcp-ack-child");
      const taskId = NodeId.make("node:mcp-ack-task");
      const acknowledgementCommandIds = yield* Ref.make<ReadonlyArray<string>>([]);
      const acknowledgementAttempts = yield* Ref.make(0);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: "terminal result",
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: childRunId,
            ordinal: 1,
            status: "completed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:00:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:10:00Z"),
          },
          {
            id: RunId.make("run:mcp-ack-continuation"),
            ordinal: 2,
            status: "failed",
            startedAt: DateTime.makeUnsafe("2026-10-03T10:02:00Z"),
            completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00Z"),
          },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      let hasNestedWork = true;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? hasNestedWork
                  ? {
                      ...parentProjection,
                      subagents: parentProjection.subagents.map((task) => ({
                        ...task,
                        result: null,
                        status: "running" as const,
                      })),
                    }
                  : parentProjection
                : hasNestedWork
                  ? {
                      ...childProjection,
                      subagents: [
                        { ...parentProjection.subagents[0]!, status: "running" as const },
                      ],
                    }
                  : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(acknowledgementCommandIds, (commandIds) => [
              ...commandIds,
              String(command.commandId),
            ]).pipe(
              Effect.andThen(Ref.updateAndGet(acknowledgementAttempts, (count) => count + 1)),
              Effect.flatMap((attempt) =>
                attempt === 1
                  ? Effect.fail(new Error("simulated acknowledgement failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-ack"),
        requestNamespace: "provider-session:mcp-ack",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-ack",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const pending = yield* service.taskStatus(scope, taskId);
        assert.equal(pending.status, "running");
        assert.equal(pending.workState, "waiting_for_children");
        assert.isNull(pending.summary);
        assert.equal(yield* Ref.get(acknowledgementAttempts), 0);
        hasNestedWork = false;
        const error = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(error.code, "orchestration_error");

        const result = yield* service.taskStatus(scope, taskId);
        assert.equal(result.status, "completed");
        assert.equal(result.summary, "terminal result");
        assert.equal(result.latestTerminalRunId, childRunId);
        assert.equal(result.latestTerminalStatus, "completed");
        const commandIds = yield* Ref.get(acknowledgementCommandIds);
        assert.equal(commandIds.length, 2);
        assert.notEqual(commandIds[0], commandIds[1]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("reports a restart-cut child as working until its continuation settles", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-restart-parent");
      const childThreadId = ThreadId.make("thread:mcp-restart-child");
      const taskId = NodeId.make("node:mcp-restart-task");
      const dispatched = yield* Ref.make(0);
      let awaitsRestart = true;
      let readFails = true;
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [
          {
            id: RunId.make("run:mcp-restart-child"),
            ordinal: 1,
            status: "cancelled",
            delegatedTaskId: taskId,
          },
          // An unrelated later run cannot supply this follow-up's result.
          { id: RunId.make("run:mcp-restart-later"), ordinal: 2, status: "running" },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          delegatedTaskResultPending: () =>
            readFails
              ? Effect.fail(new OrchestratorProjectionError({ threadId: childThreadId }))
              : Effect.succeed(awaitsRestart),
          dispatch: () => Ref.update(dispatched, (count) => count + 1).pipe(Effect.as({} as never)),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-restart"),
        requestNamespace: "provider-session:mcp-restart",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-restart",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const failed = yield* service.taskStatus(scope, taskId).pipe(Effect.flip);
        assert.equal(failed.code, "orchestration_error");
        assert.equal(yield* Ref.get(dispatched), 0);
        readFails = false;
        const held = yield* service.taskStatus(scope, taskId);
        assert.equal(held.status, "running");
        assert.equal(held.workState, "working");
        assert.isNull(held.summary);
        // Acknowledging the cut run would suppress the real result's wake.
        assert.equal(yield* Ref.get(dispatched), 0);
        awaitsRestart = false;
        const settled = yield* service.taskStatus(scope, taskId);
        assert.equal(settled.status, "cancelled");
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("tells the parent to end its turn only while its task still runs", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-next-parent");
      const childThreadId = ThreadId.make("thread:mcp-next-child");
      const taskId = NodeId.make("node:mcp-next-task");
      let finished = false;
      let pendingRequest = false;
      const parentProjection = () =>
        ({
          thread: { id: parentThreadId },
          runs: [],
          contextTransfers: [],
          subagents: [
            {
              id: taskId,
              threadId: parentThreadId,
              origin: "app_owned",
              childThreadId,
              driver: "codex",
              model: "gpt-5.6-terra",
              status: finished ? "completed" : "running",
              result: finished ? "done" : null,
              completionDelivery: { state: "pending" },
            },
          ],
        }) as unknown as OrchestrationV2ThreadProjection;
      const childRun = () => ({
        id: RunId.make("run:mcp-next-child"),
        ordinal: 1,
        status: finished ? ("completed" as const) : ("running" as const),
        delegatedTaskId: taskId,
      });
      const childProjection = () =>
        ({
          thread: { id: childThreadId, title: "Child task" },
          runs: [childRun()],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: pendingRequest ? [{ status: "pending" }] : [],
          nodes: [],
          turnItems: [],
        }) as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection() : childProjection()),
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          getProjectThreadRecords: () => Effect.succeed(childProjection()),
          waitForThread: () =>
            Effect.succeed({
              threadId: childThreadId,
              run: childRun() as unknown as OrchestrationV2ThreadProjection["runs"][number],
              timedOut: !finished,
            }),
          dispatch: () => Effect.succeed({} as never),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-next"),
        requestNamespace: "provider-session:mcp-next",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-next",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const running = yield* service.taskStatus(scope, taskId);
        assert.equal(running.status, "running");
        assert.equal(running.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);
        const waiting = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(waiting.timedOut);
        assert.equal(waiting.next, ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

        // A child waiting on a question or approval needs an answer, not a wake.
        pendingRequest = true;
        const asking = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.isTrue(asking.timedOut);
        assert.notProperty(asking, "next");
        pendingRequest = false;

        finished = true;
        const completed = yield* service.taskStatus(scope, taskId);
        assert.equal(completed.status, "completed");
        assert.notProperty(completed, "next");
        const waited = yield* service.waitForThread(scope, { threadId: childThreadId });
        assert.equal(waited.status, "completed");
        assert.notProperty(waited, "next");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("task status reads only the watched task and none of the caller's messages", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-narrow-parent");
      const childThreadId = ThreadId.make("thread:mcp-narrow-child");
      const taskId = NodeId.make("node:mcp-narrow-task");
      const reads: Array<{
        readonly threadId: ThreadId;
        readonly fields: ReadonlyArray<string> | undefined;
        readonly filter: unknown;
      }> = [];
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            status: "running",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId, title: "Child task" },
        runs: [
          { id: RunId.make("run:mcp-narrow-child"), ordinal: 1, status: "running", delegatedTaskId: taskId },
        ],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
        nodes: [],
        turnItems: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId, fields, filter) => {
            reads.push({ threadId, fields, filter });
            return Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection);
          },
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          dispatch: () => Effect.succeed({} as never),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-narrow"),
        requestNamespace: "provider-session:mcp-narrow",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-narrow",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const status = yield* service.taskStatus(scope, taskId);
        assert.equal(status.status, "running");
        const parentReads = reads.filter((read) => read.threadId === parentThreadId);
        assert.deepEqual(parentReads, [
          {
            threadId: parentThreadId,
            fields: ["runs", "subagents", "contextTransfers"],
            filter: { subagentIds: [taskId] },
          },
        ]);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("does not dispose delivery when a nonterminal task has no active child run", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-child");
      const taskId = NodeId.make("node:mcp-cancel-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // The child still runs within the parent's modes.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel"),
        requestNamespace: "provider-session:mcp-cancel",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-unstarted-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each(["no runs", "a finished run"] as const)(
    "cancels an orphaned follow-up through its parent when the child has %s",
    (childState) =>
      Effect.gen(function* () {
        const parentThreadId = ThreadId.make("thread:mcp-orphan-parent");
        const childThreadId = ThreadId.make("thread:mcp-orphan-child");
        const taskId = NodeId.make("node:mcp-orphan-task");
        const parentRunId = RunId.make("run:mcp-orphan-parent");
        const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
        const status = yield* Ref.make("running");
        const parentProjection = (taskStatus: string) =>
          ({
            thread: { id: parentThreadId },
            runs: [],
            contextTransfers: [],
            subagents: [
              {
                id: taskId,
                threadId: parentThreadId,
                runId: parentRunId,
                origin: "app_owned",
                childThreadId,
                driver: "codex",
                model: "gpt-5.6-terra",
                status: taskStatus,
                result: null,
                completionDelivery: { state: "pending" },
              },
            ],
          }) as unknown as OrchestrationV2ThreadProjection;
        // A finished run whose binding to the follow-up was lost (#19002).
        const childProjection = {
          thread: { id: childThreadId },
          runs:
            childState === "no runs"
              ? []
              : [{ id: RunId.make("run:mcp-orphan-child"), ordinal: 1, status: "completed" }],
          contextTransfers: [],
          messages: [],
          subagents: [],
          providerThreads: [],
          runtimeRequests: [],
          turnItems: [],
        } as unknown as OrchestrationV2ThreadProjection;
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              threadId === parentThreadId
                ? Effect.map(Ref.get(status), parentProjection)
                : Effect.succeed(childProjection),
            getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
            listAppOwnedChildThreadIds: () => Effect.succeed([]),
            delegatedTaskResultPending: () => Effect.succeed(false),
            stopDelegatedTasks: () => Effect.void,
            // The orchestrator's subagent.stop repair is covered in ThreadStop.test.ts.
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  command.type === "subagent.stop" ? Ref.set(status, "cancelled") : Effect.void,
                ),
                Effect.as({} as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:mcp-orphan"),
          requestNamespace: "provider-session:mcp-orphan",
          thread: {
            threadId: parentThreadId,
            providerSessionId: "provider-session:mcp-orphan",
            providerInstanceId: ProviderInstanceId.make("codex"),
          },
          client: undefined,
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.cancelTask(scope, {
            taskId,
            clientRequestId: "cancel-orphan-task",
          });
          assert.deepEqual(result, { taskId, status: "cancelled" });
          const commands = yield* Ref.get(dispatched);
          // A child whose run finished can still run another turn's work, so it is stopped too.
          assert.deepEqual(
            commands.flatMap((command) =>
              command.type === "thread.stop" ? [command.threadId] : [],
            ),
            childState === "a finished run" ? [childThreadId] : [],
          );
          const stop = commands.find((command) => command.type === "subagent.stop");
          if (stop?.type !== "subagent.stop") return;
          assert.deepEqual(
            { threadId: stop.threadId, runId: stop.runId, subagentId: stop.subagentId },
            { threadId: parentThreadId, runId: parentRunId, subagentId: taskId },
          );
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("does not dispose delivery when the child stop fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // The child still runs within the parent's modes.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(Effect.fail(new Error("simulated stop failure") as never)),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-failed"),
        requestNamespace: "provider-session:mcp-cancel-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-failed-task" })
          .pipe(Effect.flip);
        assert.equal(error.code, "task_not_cancellable");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("returns cancel requested when post-stop disposal fails", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const parentProjection = {
        thread: { id: parentThreadId },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // The child still runs within the parent's modes.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.cancelTask(scope, {
          taskId,
          clientRequestId: "cancel-dispose-failed-task",
        });
        assert.equal(result.status, "cancel_requested");
        assert.deepEqual(
          (yield* Ref.get(dispatched)).map((command) => (command as { type: string }).type),
          ["thread.stop", "delegated_task.completion-delivery.dispose"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses to cancel a task whose child now runs above the parent's modes", () =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-dispose-failed-child");
      const childRunId = RunId.make("run:mcp-cancel-dispose-failed-child");
      const taskId = NodeId.make("node:mcp-cancel-dispose-failed-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      // The parent runs Supervised in plan mode.
      const parentProjection = {
        thread: { id: parentThreadId, runtimeMode: "approval-required", interactionMode: "plan" },
        runs: [],
        contextTransfers: [],
        subagents: [
          {
            id: taskId,
            threadId: parentThreadId,
            origin: "app_owned",
            childThreadId,
            driver: "codex",
            model: "gpt-5.6-terra",
            result: null,
            completionDelivery: { state: "pending" },
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const childProjection = {
        thread: { id: childThreadId },
        runs: [{ id: childRunId, status: "running" }],
        contextTransfers: [],
        messages: [],
        subagents: [],
        providerThreads: [],
        runtimeRequests: [],
      } as unknown as OrchestrationV2ThreadProjection;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId) =>
            Effect.succeed(threadId === parentThreadId ? parentProjection : childProjection),
          // Its user has since raised the child to full access.
          getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
          listAppOwnedChildThreadIds: () => Effect.succeed([]),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                command.type === "delegated_task.completion-delivery.dispose"
                  ? Effect.fail(new Error("simulated disposal failure") as never)
                  : Effect.succeed({} as never),
              ),
            ),
          stopDelegatedTasks: () => Effect.void,
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-dispose-failed"),
        requestNamespace: "provider-session:mcp-cancel-dispose-failed",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-dispose-failed",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-above-modes" })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.deepEqual(yield* Ref.get(dispatched), []);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  /**
   * A Supervised parent cancels its Supervised child, under which a task
   * now runs at full access. Reports what the cancel did.
   */
  const cancelOverRaisedGrandchild = (child: {
    readonly deleted: boolean;
    /** The grandchild passes the check, and its user raises it before the stop reaches it. */
    readonly raisedDuringStop?: boolean;
  }) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:mcp-cancel-grandchild-parent");
      const childThreadId = ThreadId.make("thread:mcp-cancel-grandchild-child");
      const grandchildThreadId = ThreadId.make("thread:mcp-cancel-grandchild-grandchild");
      const taskId = NodeId.make("node:mcp-cancel-grandchild-task");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const stoppedBelow = yield* Ref.make(false);
      const subagentReads = yield* Ref.make<ReadonlyArray<ProjectionRecordFilter | undefined>>([]);
      const appOwnedTask = (
        id: string,
        threadId: ThreadId,
        childId: ThreadId,
        settled?: "settled",
      ) => ({
        id: NodeId.make(id),
        threadId,
        origin: "app_owned",
        childThreadId: childId,
        driver: "codex",
        model: "gpt-5.6-terra",
        status: settled === undefined ? "running" : "completed",
        result: settled === undefined ? null : "Done.",
        completionDelivery: { state: settled === undefined ? "pending" : "delivered" },
      });
      // Older tasks the parent and child dispatched and that have long settled.
      const settledThreadId = ThreadId.make("thread:mcp-cancel-grandchild-settled");
      // A Supervised parent delegated a Supervised child, which delegated a task of its own.
      const projections = new Map([
        [
          parentThreadId,
          {
            thread: {
              id: parentThreadId,
              runtimeMode: "approval-required",
              interactionMode: "default",
            },
            runs: [],
            contextTransfers: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-old",
                parentThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask(taskId, parentThreadId, childThreadId),
            ],
          },
        ],
        [
          childThreadId,
          {
            thread: { id: childThreadId },
            runs: [{ id: RunId.make("run:mcp-cancel-grandchild-child"), status: "running" }],
            contextTransfers: [],
            messages: [],
            subagents: [
              appOwnedTask(
                "node:mcp-cancel-grandchild-done",
                childThreadId,
                settledThreadId,
                "settled",
              ),
              appOwnedTask("node:mcp-cancel-grandchild-below", childThreadId, grandchildThreadId),
            ],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          settledThreadId,
          {
            thread: { id: settledThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
        [
          grandchildThreadId,
          {
            thread: { id: grandchildThreadId },
            runs: [],
            contextTransfers: [],
            messages: [],
            subagents: [],
            providerThreads: [],
            runtimeRequests: [],
          },
        ],
      ]) as unknown as ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection>;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: (threadId, fields, filter) =>
            ((fields as ReadonlyArray<string>).includes("subagents")
              ? Ref.update(subagentReads, (reads) => [...reads, filter])
              : Effect.void
            ).pipe(Effect.as(projections.get(threadId)!)),
          listAppOwnedChildThreadIds: (threadId) =>
            Effect.succeed(
              projections
                .get(threadId)!
                .subagents.flatMap((task) =>
                  task.origin === "app_owned" && task.childThreadId !== null
                    ? [task.childThreadId]
                    : [],
                ),
            ),
          // The child still runs Supervised; its user has since raised the task under it
          // to full access.
          getThreadShell: (threadId) =>
            Effect.succeed(
              threadId === grandchildThreadId && child.raisedDuringStop !== true
                ? liveThreadShell(threadId)
                : threadId === childThreadId && child.deleted
                  ? null
                  : liveThreadShell(threadId, { runtimeMode: "approval-required" }),
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({} as never),
            ),
          // Stands in for the orchestrator, which finds the grandchild raised
          // under its lock, when the stop runs under the parent's limit.
          stopDelegatedTasks: () =>
            Effect.gen(function* () {
              const limit = yield* DispatchModeLimit;
              if (child.raisedDuringStop === true && limit?.refused !== undefined) {
                const refusal: DispatchModeRefusal = {
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                };
                yield* Ref.set(limit.refused, refusal);
                return yield* new OrchestratorThreadAboveModeLimitError({
                  commandId: CommandId.make("stop-grandchild"),
                  threadId: grandchildThreadId,
                  mode: "runtime",
                  runtimeMode: "full-access",
                  interactionMode: "default",
                });
              }
              yield* Ref.set(stoppedBelow, true);
            }),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const scope: McpInvocationScope = {
        environmentId: EnvironmentId.make("environment:mcp-cancel-grandchild"),
        requestNamespace: "provider-session:mcp-cancel-grandchild",
        thread: {
          threadId: parentThreadId,
          providerSessionId: "provider-session:mcp-cancel-grandchild",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      };

      return yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .cancelTask(scope, { taskId, clientRequestId: "cancel-grandchild-above-modes" })
          .pipe(Effect.flip);
        // No read decodes every task a thread has dispatched.
        for (const filter of yield* Ref.get(subagentReads)) {
          assert.isTrue(
            filter?.subagentIds !== undefined || filter?.omitSettledSubagents !== undefined,
          );
        }
        return {
          code: error.code,
          dispatched: yield* Ref.get(dispatched),
          stoppedBelow: yield* Ref.get(stoppedBelow),
        };
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    });

  it.effect("refuses to cancel a task when a task under it now runs above the parent's modes", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: false }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );

  it.effect("reports a task under the child that its user raises while it is being stopped", () =>
    Effect.gen(function* () {
      const outcome = yield* cancelOverRaisedGrandchild({ deleted: false, raisedDuringStop: true });
      assert.equal(outcome.code, "runtime_mode_escalation_denied");
      assert.isFalse(outcome.stoppedBelow);
    }),
  );

  it.effect("checks the tasks under a deleted child before cancelling it", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* cancelOverRaisedGrandchild({ deleted: true }), {
        code: "runtime_mode_escalation_denied",
        dispatched: [],
        stoppedBelow: false,
      });
    }),
  );
});

describe("OrchestratorMcpService provider resolution", () => {
  const parentThreadId = ThreadId.make("thread:mcp-providers-parent");
  const childThreadId = ThreadId.make("thread:mcp-providers-child");
  const parentRunId = RunId.make("run:mcp-providers-parent");
  const parentNodeId = NodeId.make("node:mcp-providers-root");
  const taskId = NodeId.make("node:mcp-providers-task");
  const projectId = ProjectId.make("project:mcp-providers");
  const codexInstanceId = ProviderInstanceId.make("codex");
  const antigravityInstanceId = ProviderInstanceId.make("antigravity");

  const scope: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:mcp-providers"),
    requestNamespace: "provider-session:mcp-providers",
    thread: {
      threadId: parentThreadId,
      providerSessionId: "provider-session:mcp-providers",
      providerInstanceId: codexInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };

  const providerSnapshot = (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly model?: string;
    readonly enabled?: boolean;
  }): ServerProvider => ({
    instanceId: input.instanceId,
    driver: input.driver,
    enabled: input.enabled ?? true,
    installed: input.enabled !== false,
    version: input.enabled === false ? null : "test",
    status: input.enabled === false ? "disabled" : "ready",
    auth: { status: input.enabled === false ? "unknown" : "authenticated" },
    ...(input.enabled === false ? { message: "Provider is disabled in T3 Code settings." } : {}),
    checkedAt: "2026-09-13T00:00:00.000Z",
    models:
      input.model === undefined
        ? []
        : [{ slug: input.model, name: input.model, isCustom: false, capabilities: null }],
    slashCommands: [],
    skills: [],
  });

  /** A registry whose probes report the same snapshots it already holds. */
  const providerRegistryLayer = (providers: ReadonlyArray<ServerProvider>) =>
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(providers),
      refreshInstance: () => Effect.succeed(providers),
    });

  const adapterRegistryLayer = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    Layer.succeed(
      ProviderAdapterRegistry.ProviderAdapterRegistryV2,
      ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
        list: () => Effect.succeed(instanceIds),
        get: (instanceId) =>
          instanceIds.includes(instanceId)
            ? Effect.succeed({
                instanceId,
              } as unknown as ProviderAdapter.ProviderAdapterV2["Service"])
            : Effect.fail(
                new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
              ),
      }),
    );

  const parentProjection = (
    subagents: ReadonlyArray<unknown>,
    modelSelection: {
      readonly instanceId: ProviderInstanceId;
      readonly model: string;
      readonly options?: ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
    } = { instanceId: codexInstanceId, model: "gpt-5.4" },
  ): OrchestrationV2ThreadProjection =>
    ({
      thread: {
        id: parentThreadId,
        projectId,
        title: "MCP parent",
        createdBy: "user",
        creationSource: "web",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId },
      },
      runs: [
        {
          id: parentRunId,
          ordinal: 1,
          status: "running",
          rootNodeId: parentNodeId,
          providerInstanceId: codexInstanceId,
          modelSelection,
        },
      ],
      contextTransfers: [],
      subagents,
    }) as unknown as OrchestrationV2ThreadProjection;

  const childProjection = {
    thread: { id: childThreadId },
    runs: [],
    contextTransfers: [],
    messages: [],
    subagents: [],
    providerThreads: [],
    runtimeRequests: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;

  it.effect(
    "advertises orchestration capability from registered adapters rather than a driver allowlist",
    () =>
      Effect.gen(function* () {
        const disabledAntigravityInstanceId = ProviderInstanceId.make("antigravity-alt");
        const disabledWithoutAdapterInstanceId = ProviderInstanceId.make("codex-without-adapter");
        const projectDisabledInstanceId = ProviderInstanceId.make("codex-project-off");
        const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
        const forkShadow = yield* buildUnavailableProviderSnapshot({
          driverKind: "forkOnly",
          instanceId: forkOnlyInstanceId,
          reason: "Driver 'forkOnly' is not registered in this build.",
          checkedAt: "2026-09-13T00:00:00.000Z",
        });
        let providers: ReadonlyArray<ServerProvider> = [
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("claudeAgent"),
            driver: ProviderDriverKind.make("claudeAgent"),
            model: "claude-sonnet-4-6",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("pi"),
            driver: ProviderDriverKind.make("pi"),
            model: "pi-model",
          }),
          providerSnapshot({
            instanceId: ProviderInstanceId.make("acpRegistry"),
            driver: ProviderDriverKind.make("acpRegistry"),
            model: "acp-model",
          }),
          // Antigravity has a live orchestration adapter through the provider
          // instance registry even though no adapter driver entry exists in
          // the static built-in list.
          providerSnapshot({
            instanceId: antigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
          }),
          // A second Antigravity instance whose adapter resolves but whose
          // provider state still blocks delegation.
          providerSnapshot({
            instanceId: disabledAntigravityInstanceId,
            driver: ProviderDriverKind.make("antigravity"),
            model: "ant-model",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: disabledWithoutAdapterInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
            enabled: false,
          }),
          providerSnapshot({
            instanceId: projectDisabledInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ];
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(parentProjection([])),
          }),
          ServerSettings.layerTest({
            providerInstances: {
              [ProviderInstanceId.make("pi")]: {
                driver: ProviderDriverKind.make("pi"),
                enabled: true,
              },
              [ProviderInstanceId.make("acpRegistry")]: {
                driver: ProviderDriverKind.make("acpRegistry"),
                enabled: true,
              },
              [antigravityInstanceId]: {
                driver: ProviderDriverKind.make("antigravity"),
                enabled: true,
              },
              [projectDisabledInstanceId]: { driver: ProviderDriverKind.make("codex") },
            },
            projectSettingsOverrides: {
              [projectId]: {
                providerInstances: { [projectDisabledInstanceId]: { enabled: false } },
              },
            },
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.sync(() => providers),
          }),
          adapterRegistryLayer([
            codexInstanceId,
            projectDisabledInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
            disabledAntigravityInstanceId,
          ]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const capabilities = yield* service.capabilities(scope);
          const byId = new Map(
            capabilities.providers.map((provider) => [provider.providerInstanceId, provider]),
          );
          for (const provider of providers) {
            assert.deepEqual(
              byId.get(provider.instanceId)?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          providers = providers.map((provider) => ({
            ...provider,
            models: [
              ...provider.models,
              {
                slug: `${provider.driver}/custom-model-after-refresh`,
                name: "Custom model",
                isCustom: true,
                capabilities: null,
              },
            ],
          }));
          const refreshed = yield* service.capabilities(scope);
          for (const provider of providers) {
            assert.deepEqual(
              refreshed.providers
                .find((entry) => entry.providerInstanceId === provider.instanceId)
                ?.models.map((model) => model.id),
              provider.models.map((model) => model.slug),
            );
          }

          for (const instanceId of [
            codexInstanceId,
            ProviderInstanceId.make("claudeAgent"),
            ProviderInstanceId.make("pi"),
            ProviderInstanceId.make("acpRegistry"),
            antigravityInstanceId,
          ]) {
            const entry = byId.get(instanceId);
            assert.isDefined(entry);
            assert.isTrue(
              entry!.canRunChildTask,
              `expected ${instanceId} to advertise canRunChildTask`,
            );
            assert.isTrue(entry!.canRunCrossProviderChildTask);
            assert.deepEqual(entry!.constraints, []);
          }

          const disabled = byId.get(disabledAntigravityInstanceId);
          assert.isDefined(disabled);
          assert.isFalse(disabled!.canRunChildTask);
          assert.isFalse(disabled!.canRunCrossProviderChildTask);
          assert.deepEqual(disabled!.constraints, ["Provider instance is disabled."]);

          const projectDisabled = byId.get(projectDisabledInstanceId);
          assert.isDefined(projectDisabled);
          assert.isFalse(projectDisabled!.canRunChildTask);
          assert.deepEqual(projectDisabled!.constraints, ["Provider instance is disabled."]);

          const disabledWithoutAdapter = byId.get(disabledWithoutAdapterInstanceId);
          assert.isDefined(disabledWithoutAdapter);
          assert.isFalse(disabledWithoutAdapter!.canRunChildTask);
          assert.isFalse(disabledWithoutAdapter!.canRunCrossProviderChildTask);
          assert.deepEqual(disabledWithoutAdapter!.constraints, [
            "No V2 provider adapter is registered.",
            "Provider instance is disabled.",
          ]);

          const fork = byId.get(forkOnlyInstanceId);
          assert.isDefined(fork);
          assert.isFalse(fork!.canRunChildTask);
          assert.isFalse(fork!.canRunCrossProviderChildTask);
          assert.deepEqual(fork!.constraints, [
            "No V2 provider adapter is registered.",
            "Driver 'forkOnly' is not registered in this build.",
            "Provider instance is disabled.",
          ]);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  describe("listed models", () => {
    const opencodeInstanceId = ProviderInstanceId.make("opencode");
    const model = (slug: string, extra: Partial<ServerProvider["models"][number]> = {}) => ({
      slug,
      name: slug,
      isCustom: false,
      capabilities: null,
      ...extra,
    });
    const opencodeSlugs = Array.from(
      { length: 12 },
      (_, index) => `oc/m${String(index + 1).padStart(2, "0")}`,
    );
    const catalog: ReadonlyArray<ServerProvider> = [
      {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
        }),
        displayName: "Codex",
        models: [
          model("gpt-6", {
            name: "Sol",
            capabilities: {
              optionDescriptors: [
                {
                  id: "effort",
                  label: "Reasoning",
                  description: "How hard the model thinks.",
                  type: "select",
                  options: [
                    { id: "low", label: "Low", description: "Fast." },
                    { id: "high", label: "High", isDefault: true },
                  ],
                  promptInjectedValues: ["high"],
                },
                { id: "fastMode", label: "Fast", type: "boolean" },
                {
                  id: "agent",
                  label: "Agent",
                  type: "select",
                  options: [{ id: "build", label: "Build" }],
                  currentValue: "build",
                },
              ],
            },
          }),
          model("gpt-5", { name: "Code Legacy", isLegacy: true }),
          model("gpt-4", { isLegacy: true }),
          model("gpt-3", { name: "GPT-3", isLegacy: true }),
          model("my-alpha", { isCustom: true }),
        ],
      },
      {
        ...providerSnapshot({
          instanceId: opencodeInstanceId,
          driver: ProviderDriverKind.make("opencode"),
        }),
        models: [
          ...opencodeSlugs.map((slug) => model(slug, { isLegacy: slug === "oc/m03" })),
          model("oc-custom", { isCustom: true }),
        ],
      },
    ];

    const capabilitiesWith = (search?: string) =>
      Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.capabilities(scope, search === undefined ? {} : { search });
      }).pipe(
        Effect.provide(
          layerOrchestratorService.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                Layer.mock(ThreadManagementService.ThreadManagementService)({
                  getThreadRecords: () =>
                    Effect.succeed(
                      parentProjection([], { instanceId: codexInstanceId, model: "gpt-3" }),
                    ),
                }),
                ServerSettings.layerTest({
                  favorites: [
                    { provider: codexInstanceId, model: "gpt-4" },
                    { provider: opencodeInstanceId, model: "oc/m10" },
                  ],
                  providerModelPreferences: {
                    [opencodeInstanceId]: { hiddenModels: ["oc/m02"], modelOrder: ["oc/m12"] },
                  },
                }),
                providerRegistryLayer(catalog),
                adapterRegistryLayer([codexInstanceId, opencodeInstanceId]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          ),
        ),
      );

    const listing = (capabilities: OrchestratorMcpCapabilitiesResult) =>
      capabilities.providers.map((provider) => ({
        id: provider.providerInstanceId,
        models: provider.models.map((entry) => entry.id),
        omitted: provider.omittedModels ?? 0,
      }));

    it.effect(
      "skips legacy models, lists the first 8 of large catalogs, and keeps pinned models",
      () =>
        Effect.gen(function* () {
          assert.deepEqual(listing(yield* capabilitiesWith()), [
            // gpt-4 is a favorite and gpt-3 is the caller's model; legacy gpt-5 is left out.
            { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
            {
              id: opencodeInstanceId,
              models: [
                "oc/m12",
                "oc/m01",
                "oc/m04",
                "oc/m05",
                "oc/m06",
                "oc/m07",
                "oc/m08",
                "oc/m09",
                "oc/m10",
                "oc-custom",
              ],
              omitted: 2,
            },
          ]);
        }),
    );

    it.effect("search matches every word and caps each provider's matches", () =>
      Effect.gen(function* () {
        assert.deepEqual(listing(yield* capabilitiesWith("GPT 5")), [
          { id: codexInstanceId, models: ["gpt-5"], omitted: 0 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        // A word naming the provider matches all its models, so legacy ones stay out.
        assert.deepEqual(listing(yield* capabilitiesWith("Codex")), [
          { id: codexInstanceId, models: ["gpt-6", "gpt-4", "gpt-3", "my-alpha"], omitted: 1 },
          { id: opencodeInstanceId, models: [], omitted: 0 },
        ]);
        assert.deepEqual(listing(yield* capabilitiesWith(" ")), listing(yield* capabilitiesWith()));
        for (const search of ["code", "codex code", "  CODE  "]) {
          assert.deepEqual(listing(yield* capabilitiesWith(search))[0], {
            id: codexInstanceId,
            models: ["gpt-5"],
            omitted: 0,
          });
        }
        assert.deepEqual(
          listing(yield* capabilitiesWith("open"))[1],
          listing(yield* capabilitiesWith())[1],
        );
        assert.deepEqual(listing(yield* capabilitiesWith("codex gpt 5"))[0], {
          id: codexInstanceId,
          models: ["gpt-5"],
          omitted: 0,
        });
        const opencode = listing(yield* capabilitiesWith("oc/m"))[1];
        assert.deepEqual(opencode, {
          id: opencodeInstanceId,
          models: ["oc/m12", "oc/m01", "oc/m03", "oc/m04", "oc/m05", "oc/m06", "oc/m07", "oc/m08"],
          omitted: 3,
        });
      }),
    );

    it.effect("describes models by id, distinct label, and option values", () =>
      Effect.gen(function* () {
        const codex = (yield* capabilitiesWith()).providers[0];
        assert.deepEqual(codex?.models.slice(0, 4), [
          {
            id: "gpt-6",
            label: "Sol",
            options: [
              { id: "effort", values: ["low", "high"], default: "high" },
              { id: "fastMode", values: [false, true] },
              { id: "agent", values: ["build"], default: "build" },
            ],
          },
          { id: "gpt-4" },
          { id: "gpt-3" },
          { id: "my-alpha" },
        ]);
      }),
    );
  });


  it.effect("leaves models the user hid out of the capability catalog", () =>
    Effect.gen(function* () {
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest({
          providerModelPreferences: {
            [codexInstanceId]: { hiddenModels: ["gpt-5.4-mini", "my-model"], modelOrder: [] },
          },
        }),
        providerRegistryLayer([
          {
            ...codex,
            models: [
              ...codex.models,
              { slug: "gpt-5.4-mini", name: "Mini", isCustom: false, capabilities: null },
              // Custom models cannot be hidden, matching the client pickers.
              { slug: "my-model", name: "Mine", isCustom: true, capabilities: null },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(
          capabilities.providers[0]?.models.map((model) => model.id),
          ["gpt-5.4", "my-model"],
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect.each([
    {
      name: "installation",
      snapshot: { installed: false, version: null, status: "warning", auth: { status: "unknown" } },
      constraints: ["Provider executable is not installed."],
    },
    {
      name: "health",
      snapshot: { status: "error", message: "Provider health check failed." },
      constraints: ["Provider health check failed."],
    },
    {
      name: "authentication",
      snapshot: { auth: { status: "unauthenticated" } },
      constraints: ["Provider is not authenticated."],
    },
    {
      name: "combined installation and health",
      snapshot: {
        installed: false,
        version: null,
        status: "error",
        message: "Provider executable could not be found.",
        auth: { status: "unknown" },
      },
      constraints: [
        "Provider executable is not installed.",
        "Provider executable could not be found.",
      ],
    },
    {
      name: "disabled with stale probe failures",
      snapshot: {
        enabled: false,
        installed: false,
        version: null,
        status: "error",
        message: "Stale provider health failure.",
        auth: { status: "unauthenticated" },
      },
      constraints: ["Provider instance is disabled."],
    },
  ] as const)("reports $name provider constraints", (testCase) =>
    Effect.gen(function* () {
      const provider: ServerProvider = {
        ...providerSnapshot({
          instanceId: codexInstanceId,
          driver: ProviderDriverKind.make("codex"),
          model: "gpt-5.4",
        }),
        ...testCase.snapshot,
      };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([provider]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        const entry = capabilities.providers.find(
          (candidate) => candidate.providerInstanceId === codexInstanceId,
        );
        assert.isDefined(entry);
        assert.isFalse(entry!.canRunChildTask);
        assert.isFalse(entry!.canRunCrossProviderChildTask);
        assert.deepEqual(entry!.constraints, testCase.constraints);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("drops inherited options the delegate's model has no descriptor for", () =>
    Effect.gen(function* () {
      // thread_launch keeps a model selection as given, so a thread can hold an option its model lacks.
      const inherited = {
        instanceId: codexInstanceId,
        model: "gpt-5.4",
        options: [
          { id: "reasoningEffort", value: "low" },
          { id: "fastMode", value: false },
        ],
      } as const;
      let delegated = false;
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the change.",
        title: null,
        model: inherited.model,
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const dispatched = yield* Ref.make<ReadonlyArray<{ readonly modelSelection?: unknown }>>([]);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [], inherited)
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command as never]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  { sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          {
            ...providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: inherited.model,
            }),
            models: [
              {
                slug: inherited.model,
                name: inherited.model,
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      options: [{ id: "low", label: "Low" }],
                    },
                  ],
                },
              },
            ],
          } as ServerProvider,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.delegateTask(scope, {
          task: "Review the change.",
          target: { providerInstanceId: codexInstanceId, model: inherited.model },
          mode: "async",
          clientRequestId: "delegate-inherited-options",
        });
        const [request] = yield* Ref.get(dispatched);
        assert.deepEqual(request?.modelSelection, {
          ...inherited,
          options: [inherited.options[0]],
        });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "delegates to an Antigravity instance whose adapter resolves through the registry",
    () =>
      Effect.gen(function* () {
        let delegated = false;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("antigravity"),
          providerInstanceId: antigravityInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "ant-model",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: (threadId) =>
              Effect.succeed(
                threadId === parentThreadId
                  ? parentProjection(delegated ? [task] : [])
                  : childProjection,
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(
                  Effect.sync(() => {
                    delegated = true;
                  }),
                ),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver: ProviderDriverKind.make("codex"),
                model: "gpt-5.4",
              }),
              providerSnapshot({
                instanceId: antigravityInstanceId,
                driver: ProviderDriverKind.make("antigravity"),
                model: "ant-model",
              }),
            ]),
          }),
          adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const result = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
            mode: "async",
            clientRequestId: "delegate-antigravity-1",
          });
          assert.equal(result.status, "running");
          assert.equal(result.providerInstanceId, antigravityInstanceId);
          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 1);
          const request = commands[0] as {
            type: string;
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(request.type, "delegated_task.request");
          assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
          assert.equal(request.modelSelection.model, "ant-model");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect(
    "refuses a child on an engine that can't ask before acting under a parent below full access",
    () =>
      Effect.gen(function* () {
        const supervised = parentProjection([]);
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            hasReceipt: () => Effect.succeed(false),
            assertProviderInstanceEnabled: () => Effect.void,
            getThreadRecords: () => Effect.succeed({ ...supervised, thread: { ...supervised.thread, runtimeMode: "approval-required" } }),
            dispatch: () => Effect.die("a refused child is never dispatched"),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed([
              providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
              providerSnapshot({ instanceId: antigravityInstanceId, driver: ProviderDriverKind.make("antigravity"), model: "ant-model" }),
            ]),
          }),
          Layer.succeed(
            ProviderAdapterRegistry.ProviderAdapterRegistryV2,
            ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
              list: () => Effect.succeed([codexInstanceId, antigravityInstanceId]),
              // Antigravity here asks before nothing.
              get: (instanceId) =>
                Effect.succeed({
                  instanceId,
                  getCapabilities: () =>
                    Effect.succeed({ approvals: { supportsCommandApproval: instanceId !== antigravityInstanceId, supportsFileChangeApproval: instanceId !== antigravityInstanceId } }),
                } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]),
            }),
          ),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const refused = yield* service
            .delegateTask(scope, {
              task: "Summarize the diff.",
              target: { providerInstanceId: antigravityInstanceId, model: "ant-model" },
              mode: "async",
              clientRequestId: "delegate-no-approvals-1",
            })
            .pipe(Effect.flip);
          assert.equal(refused.code, "runtime_mode_escalation_denied");
          assert.include(refused.message, "can't ask before acting");
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("starts a Caveman Code lead's builder through Builders instead of a T3 child, and reads and refuses on it", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const asked: Array<BuilderStart> = [];
      let started = true;
      // On another harness and model than its lead's (Codex, gpt-5.4).
      const builder = { workspaceId: "ws-builder", where: "cloud" as const, computerId: "cc-1", title: "Part", engine: "claude-agent", model: "claude-opus-5-5" };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) => Effect.succeed(threadId === parentThreadId ? parentProjection([]) : childProjection),
          dispatch: (command) => Ref.update(dispatched, (commands) => [...commands, command]).pipe(Effect.andThen(Effect.die("a T3 child was dispatched"))),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" })]),
        }),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.succeed(
          Builders,
          Builders.of({
            start: (input) =>
              Effect.suspend(() => {
                asked.push(input);
                if (input.title === "Too many") return Effect.fail(new BuilderError({ reason: "limit_reached", message: "This lead may start 2 builders, and has." }));
                return Effect.succeed(started ? builder : undefined);
              }),
            status: (workspaceId) => Effect.succeed(workspaceId === "ws-builder" ? { ...builder, state: "completed" as const, summary: "The part is done." } : undefined),
            thisComputer: () => undefined,
            computers: () => Effect.succeed({ computers: [] }),
            tree: () => Effect.succeed({ running: 0, threadIds: [], tokens: 0 }),
            sharesComputer: () => Effect.succeed(false),
            message: () => Effect.succeed(undefined),
            bind: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, { task: "Build the part.", title: "Part", role: "implementation", where: "cloud", clientRequestId: "builder-1" });
        assert.equal(result.taskId, "builder:ws-builder");
        assert.equal(result.childThreadId, "cloud:ws-builder");
        assert.equal(result.status, "running");
        // where cloud: a computer Cloud made for it, not one the lead named.
        assert.include(result.summary ?? "", "on a Cloud computer of its own");
        // The builder's own harness, model and computer, not its lead's.
        assert.deepEqual([result.providerInstanceId, result.model, result.computerId], ["claudeAgent", "claude-opus-5-5", "cc-1"]);
        assert.deepEqual(
          asked.map((a) => [a.parentThreadId, a.where, a.title, a.task]),
          [[parentThreadId, "cloud", "Part", "Act as the implementation sub-agent for this task.\n\nBuild the part."]],
        );
        // One key per delegation: a retry of it asks with the same key.
        yield* service.delegateTask(scope, { task: "Build the part.", title: "Part", role: "implementation", where: "cloud", clientRequestId: "builder-1" });
        assert.equal(asked[1]!.requestKey, asked[0]!.requestKey);
        assert.lengthOf(yield* Ref.get(dispatched), 0);
        const status = yield* service.taskStatus(scope, NodeId.make("builder:ws-builder"));
        assert.equal(status.status, "completed");
        assert.equal(status.workState, "result_available");
        assert.equal(status.summary, "The part is done.");
        assert.deepEqual([status.providerInstanceId, status.model, status.computerId], ["claudeAgent", "claude-opus-5-5", "cc-1"]);
        assert.equal((yield* service.taskStatus(scope, NodeId.make("builder:nobody")).pipe(Effect.flip)).code, "task_not_found");
        assert.equal((yield* service.cancelTask(scope, { taskId: NodeId.make("builder:ws-builder") }).pipe(Effect.flip)).code, "task_not_cancellable");
        // The lead's own limit is the tool's refusal.
        const refused = yield* service.delegateTask(scope, { task: "More.", title: "Too many", isolation: "worktree", clientRequestId: "builder-2" }).pipe(Effect.flip);
        assert.equal(refused.code, "limit_reached");
 // Shared isolation never asks Builders: upstream child (its dispatch, which this stand-in refuses).
        const before = asked.length;
        yield* service.delegateTask(scope, { task: "Here.", clientRequestId: "builder-3" }).pipe(Effect.exit);
        assert.equal(asked.length, before);
        assert.lengthOf(yield* Ref.get(dispatched), 1);
 // A lead Builders does not take (This Mac, no where) goes on to upstream worktree child.
        started = false;
        const t3 = yield* service.delegateTask(scope, { task: "Here.", isolation: "worktree", clientRequestId: "builder-4" }).pipe(Effect.exit);
        assert.equal(asked.length, before + 1);
        assert.isTrue(t3._tag === "Failure" && !String(t3.cause).includes("builder"));
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("a lead's builders meet Settings > Agents' limits as its delegated agents do: agents at once and the tree's tokens, never a retry (P4)", () =>
    Effect.gen(function* () {
      // What the builders' route reports of this lead: how many are at work and the threads of those here.
      let tree: { running: number; threadIds: ReadonlyArray<string>; tokens?: number } = { running: 0, threadIds: [] };
      // The route's own record of what it started (its retry lookup): the limits run only for a new one.
      const known = new Set<string>();
      const builderThread = ThreadId.make("caveman:ws-b1");
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection([])
                : threadId === builderThread
                  ? ({ ...childProjection, providerTurns: [{ turnTokenUsage: { inputTokens: 900_000, cachedInputTokens: 500_000, outputTokens: 700_000 } }] } as unknown as OrchestrationV2ThreadProjection)
                  : childProjection,
            ),
          dispatch: () => Effect.die("a T3 child was dispatched"),
        }),
        // Three agents at once under one chat; a million tokens for everything delegated under it.
        ServerSettings.layerTest({ subagents: { maxConcurrent: 3, treeTokenCeiling: 1_000_000 } }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" })]),
        }),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.succeed(
          Builders,
          Builders.of({
            // As the route: a delegation it already started is that builder; a new one passes `admit` first.
            start: (input) =>
              Effect.gen(function* () {
                if (!known.has(input.requestKey)) {
                  if (input.admit !== undefined) yield* input.admit;
                  known.add(input.requestKey);
                }
                return { workspaceId: "ws-b1", threadId: builderThread as string, where: "here" as const, title: input.title ?? "Builder", engine: "claude-agent" };
              }),
            status: () => Effect.succeed(undefined),
            thisComputer: () => undefined,
            computers: () => Effect.succeed({ computers: [] }),
            tree: (leadThreadId) => Effect.succeed(leadThreadId === parentThreadId ? { tokens: 0, ...tree } : { running: 0, threadIds: [], tokens: 0 }),
            sharesComputer: () => Effect.succeed(false),
            message: () => Effect.succeed(undefined),
            bind: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const builder = (clientRequestId: string) => service.delegateTask(scope, { task: "Build the part.", title: "Part", isolation: "worktree", mode: "async", clientRequestId });
        // Two builders at work under a limit of three: the next starts.
        tree = { running: 2, threadIds: [] };
        assert.equal((yield* builder("limit-ok")).status, "running");
        // Three at work: the next is refused in the words every delegation gets, and nothing is started.
        tree = { running: 3, threadIds: [] };
        const startedSoFar = known.size;
        const busy = yield* builder("limit-busy").pipe(Effect.flip);
        assert.equal(busy.code, "limit_reached");
        assert.equal(busy.message, "Not delegated: 3 delegated agents are already working in this task. Wait for one to finish (its result wakes you), then delegate again.");
        assert.equal(known.size, startedSoFar);
        // A retry of the one that started is that builder still, though the limit is now met.
        assert.equal((yield* builder("limit-ok")).status, "running");
        // One finished: its place is free again.
        tree = { running: 2, threadIds: [] };
        assert.equal((yield* builder("limit-freed")).status, "running");
        // The builders here have used 1.1M fresh tokens (uncached input plus output) against a ceiling of 1M.
        tree = { running: 0, threadIds: [builderThread] };
        const spent = yield* builder("limit-spent").pipe(Effect.flip);
        assert.equal(spent.code, "limit_reached");
        assert.equal(spent.message, "Not delegated: the agents in this task have used their budget. Finish the work yourself, or tell the user what is left.");
        // Builders on other computers count too, by what each last said it used: 0.4M there is under the ceiling,
        // and with the 1.1M used here, or 1M there alone, the budget is spent.
        tree = { running: 0, threadIds: [], tokens: 400_000 };
        assert.equal((yield* builder("limit-remote-under")).status, "running");
        tree = { running: 0, threadIds: [], tokens: 1_000_000 };
        assert.equal((yield* builder("limit-remote-spent").pipe(Effect.flip)).message, "Not delegated: the agents in this task have used their budget. Finish the work yourself, or tell the user what is left.");
        tree = { running: 0, threadIds: [builderThread], tokens: 1 };
        assert.equal((yield* builder("limit-both-spent").pipe(Effect.flip)).code, "limit_reached");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("mails a chat on another of the person's Macs through MacMail, with the caller's modes as its limits, never as a steer", () =>
    Effect.gen(function* () {
      const sent: Array<Parameters<MacMail["Service"]["send"]>[0]> = [];
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          // The caller's own run is live: it may write to another thread.
          getThreadRecords: (threadId) => Effect.succeed(threadId === parentThreadId ? ({ ...parentProjection([]), thread: { ...parentProjection([]).thread, archivedAt: null } } as never) : childProjection),
          dispatch: () => Effect.die("a T3 send was dispatched"),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.succeed(
          MacMail,
          MacMail.of({
            send: (input) =>
              Effect.suspend(() => {
                sent.push(input);
                if (input.toThreadId === "mac:gone") return Effect.fail(new MacMailError({ reason: "thread_not_found", message: "That chat is not on another of your Macs." }));
                return Effect.succeed({ id: "0b6c1f2e-1111-4222-8333-444455556666" });
              }),
            bind: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const parent = parentProjection([]).thread;
        const result = yield* service.sendToThread(scope, { threadId: ThreadId.make("mac:ws-on-studio"), message: "What broke?", expectReply: true, clientRequestId: "mac-1" });
        assert.deepEqual<unknown>(result, { threadId: "mac:ws-on-studio", messageId: "mac:0b6c1f2e-1111-4222-8333-444455556666", runId: "mac:0b6c1f2e-1111-4222-8333-444455556666", status: "queued", delivery: "queued" });
        assert.deepEqual(sent[0], {
          fromThreadId: parentThreadId,
          toThreadId: "mac:ws-on-studio",
          text: "What broke?",
          requestKey: sent[0]!.requestKey,
          ask: true,
          limits: { runtimeMode: parent.runtimeMode, interactionMode: parent.interactionMode },
        });
        // A retry is the same message: the same key.
        yield* service.sendToThread(scope, { threadId: ThreadId.make("mac:ws-on-studio"), message: "What broke?", expectReply: true, clientRequestId: "mac-1" });
        assert.equal(sent[1]!.requestKey, sent[0]!.requestKey);
        // It takes mail as its next turn only: a steer or restart is refused before anything is sent.
        const steer = yield* service.sendToThread(scope, { threadId: ThreadId.make("mac:ws-on-studio"), message: "Now!", mode: "steer", clientRequestId: "mac-2" }).pipe(Effect.flip);
        assert.equal(steer.code, "invalid_request");
        assert.lengthOf(sent, 2);
        const gone = yield* service.sendToThread(scope, { threadId: ThreadId.make("mac:gone"), message: "hi", clientRequestId: "mac-3" }).pipe(Effect.flip);
        assert.equal(gone.code, "thread_not_found");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  /** A Builders that takes every thread's builder while `lead.is` (a Caveman Code lead), else none (a T3 thread). */
  const buildersFor = (asked: Array<BuilderStart>, lead: { is: boolean }, listing: () => BuilderComputers, thisComputer: () => string | undefined) =>
    Layer.succeed(
      Builders,
      Builders.of({
        start: (input) =>
          Effect.sync(() => {
            asked.push(input);
            if (!lead.is) return undefined;
            return { workspaceId: `ws-${asked.length}`, where: "cloud" as const, ...(input.computerId ? { computerId: input.computerId } : {}), title: input.title ?? "Builder", engine: input.engine ?? "codex", ...(input.model ? { model: input.model } : {}) };
          }),
        status: () => Effect.succeed(undefined),
        thisComputer,
        computers: () => Effect.sync(listing),
        tree: () => Effect.succeed({ running: 0, threadIds: [], tokens: 0 }),
        sharesComputer: () => Effect.succeed(false),
        message: () => Effect.succeed(undefined),
        bind: () => Effect.void,
      }),
    );

  const builderDependencies = (dispatched: Ref.Ref<ReadonlyArray<unknown>>, builders: Layer.Layer<Builders> | undefined, providers: ReadonlyArray<ServerProvider> = [providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" })]) =>
    Layer.mergeAll(
      NodeServices.layer,
      NodeCrypto.layer,
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        hasReceipt: () => Effect.succeed(false),
        assertProviderInstanceEnabled: () => Effect.void,
        getThreadRecords: (threadId) => Effect.succeed(threadId === parentThreadId ? parentProjection([]) : childProjection),
        dispatch: (command) => Ref.update(dispatched, (commands) => [...commands, command]).pipe(Effect.andThen(Effect.die("a T3 child was dispatched"))),
      }),
      ServerSettings.layerTest(),
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed(providers) }),
      adapterRegistryLayer([codexInstanceId]),
      Layer.mock(ProjectService.ProjectService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      builders ?? Layer.empty,
    );

  it.effect("sends a builder to the computer named, on the target's harness and model, and never runs work asked for elsewhere here", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const asked: Array<BuilderStart> = [];
      const lead = { is: true };
      const brief = { task: "Build the part.", title: "Part" };
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const sent = yield* service.delegateTask(scope, { ...brief, computerId: "cc-2", target: { driverKind: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" }, clientRequestId: "named-1" });
        assert.deepEqual([asked[0]!.computerId, asked[0]!.where, asked[0]!.engine, asked[0]!.model], ["cc-2", undefined, "claude-agent", "claude-opus-5-5"]);
        assert.deepEqual([sent.taskId, sent.providerInstanceId, sent.model, sent.computerId], ["builder:ws-1", "claudeAgent", "claude-opus-5-5", "cc-2"]);
        // An instance names the harness too.
        yield* service.delegateTask(scope, { ...brief, computerId: "cc-2", target: { providerInstanceId: codexInstanceId, model: "gpt-5.4-mini" }, clientRequestId: "named-2" });
        assert.deepEqual([asked[1]!.engine, asked[1]!.model], ["codex", "gpt-5.4-mini"]);
        // Both: refused before anything starts.
        const both = yield* service.delegateTask(scope, { ...brief, where: "cloud", computerId: "cc-2", clientRequestId: "both" }).pipe(Effect.flip);
        assert.equal(both.code, "invalid_request");
        assert.lengthOf(asked, 2);
 // This computer's own id (its Cloud computer's, or its environment's when signed out) is here: upstream child.
        for (const here of ["cc-this", scope.environmentId]) yield* service.delegateTask(scope, { ...brief, computerId: here, clientRequestId: `here-${here}` }).pipe(Effect.exit);
        assert.lengthOf(asked, 2);
        assert.lengthOf(yield* Ref.get(dispatched), 2);
        // A thread that is no Caveman Code chat: refused, and nothing runs here instead.
        lead.is = false;
        for (const [key, elsewhere] of [["t3-named", { computerId: "cc-2" }], ["t3-cloud", { where: "cloud" as const }]] as const) {
          const refused = yield* service.delegateTask(scope, { ...brief, ...elsewhere, clientRequestId: key }).pipe(Effect.flip);
          assert.equal(refused.code, "invalid_request");
          assert.include(refused.message, "Only a Caveman Code chat sends builders to other computers.");
        }
        assert.lengthOf(yield* Ref.get(dispatched), 2);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(builderDependencies(dispatched, buildersFor(asked, lead, () => ({ computers: [] }), () => "cc-this"))))));
      // Without the Session Protocol route here, the same.
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const refused = yield* service.delegateTask(scope, { ...brief, computerId: "cc-2", clientRequestId: "no-builders" }).pipe(Effect.flip);
        assert.equal(refused.code, "invalid_request");
        assert.lengthOf(yield* Ref.get(dispatched), 2);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(builderDependencies(dispatched, undefined)))));
    }),
  );

  it.effect("a second instance of a driver is that driver's harness for a builder: reported as asked here, as its engine's default on Cloud", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const asked: Array<BuilderStart> = [];
      const personal = ProviderInstanceId.make("codex_personal");
      const providers = [
        providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
        providerSnapshot({ instanceId: personal, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
      ];
      const builders = Layer.succeed(
        Builders,
        Builders.of({
          start: (input) =>
            Effect.sync(() => {
              asked.push(input);
              const elsewhere = input.where === "cloud" || input.computerId !== undefined;
              const id = `ws-${asked.length}`;
              return {
                workspaceId: id,
                ...(elsewhere ? {} : { threadId: `caveman:${id}` }),
                where: elsewhere ? ("cloud" as const) : ("here" as const),
                ...(input.computerId !== undefined ? { computerId: input.computerId, computerName: "Box" } : input.where === "cloud" ? { computerId: "cc-fresh" } : {}),
                title: input.title ?? "Builder",
                engine: input.engine ?? "codex",
              };
            }),
          status: () => Effect.succeed(undefined),
          thisComputer: () => "cc-this",
          computers: () => Effect.succeed({ computers: [] }),
          tree: () => Effect.succeed({ running: 0, threadIds: [], tokens: 0 }),
          sharesComputer: () => Effect.succeed(false),
          message: (input) =>
            Effect.fail(new BuilderError({ reason: input.text === "down" ? "unavailable" : input.text === "full" ? "limit_reached" : "invalid_request", message: `refused: ${input.text}` })),
          bind: () => Effect.void,
        }),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const brief = { task: "Build the part.", title: "Part" };
        // Named by that instance: Codex on the computer named (never acp:codex_personal, which Cloud refuses), its own Codex there.
        const named = yield* service.delegateTask(scope, { ...brief, computerId: "cc-box", target: { providerInstanceId: personal, model: "gpt-5.4" }, clientRequestId: "personal-named" });
        assert.deepEqual([asked[0]!.engine, asked[0]!.computerId], ["codex", "cc-box"]);
        assert.deepEqual([named.providerInstanceId, named.computerId], ["codex", "cc-box"]);
        assert.include(named.summary ?? "", "on Cloud computer Box");
        const own = yield* service.delegateTask(scope, { ...brief, where: "cloud", target: { providerInstanceId: personal }, clientRequestId: "personal-cloud" });
        assert.equal(asked[1]!.engine, "codex");
        assert.deepEqual([own.providerInstanceId, own.computerId], ["codex", "cc-fresh"]);
        assert.include(own.summary ?? "", "on a Cloud computer of its own");
        // A builder in a worktree here: the instance asked for.
        const here = yield* service.delegateTask(scope, { ...brief, isolation: "worktree", target: { providerInstanceId: personal }, clientRequestId: "personal-here" });
        assert.equal(asked[2]!.engine, "codex");
        assert.equal(here.providerInstanceId, "codex_personal");
        assert.include(here.summary ?? "", "in a worktree on this computer");
        assert.lengthOf(yield* Ref.get(dispatched), 0);
        // A message to a builder on another computer: what the agent asked wrong stays invalid_request.
        for (const [text, code] of [["wrong", "invalid_request"], ["full", "limit_reached"], ["down", "orchestration_error"]] as const) {
          const refused = yield* service.sendToThread(scope, { threadId: ThreadId.make("cloud:ws-1"), message: text, clientRequestId: `send-${text}` }).pipe(Effect.flip);
          assert.deepEqual([refused.code, refused.message], [code, `refused: ${text}`]);
        }
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(builderDependencies(dispatched, builders, providers)))));
    }),
  );

  it.effect("lists this computer first with the harnesses it runs, then the person's Cloud computers, or a note why none", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const box = { id: "cc-2", name: "Box", kind: "cloud" as const, os: "linux" as const, state: "asleep" as const, driverKinds: ["caveman", "claudeAgent", "codex"], canRunBuilder: true };
      let listing: BuilderComputers = { computers: [box] };
      let linked: string | undefined = "cc-this";
      // Claude Agent has no adapter here: a child task cannot run on it, so it is not this computer's.
      const providers = [
        providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
        providerSnapshot({ instanceId: ProviderInstanceId.make("claudeAgent"), driver: ProviderDriverKind.make("claudeAgent"), model: "claude-sonnet-4-6" }),
      ];
      const environment = Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(scope.environmentId),
        getDescriptor: Effect.succeed({ label: "Julius's MacBook" } as unknown as ExecutionEnvironmentDescriptor),
      });
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const platform = process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
        const here = { name: "Julius's MacBook", kind: "this", os: platform, state: "awake", driverKinds: ["codex"], canRunBuilder: true } as const;
        const linkedCaps = yield* service.capabilities(scope);
        assert.deepEqual(linkedCaps.computers, [{ id: "cc-this", ...here }, box]);
        assert.isUndefined(linkedCaps.computersNote);
        // Signed out: this computer by its environment id, and why there is no other.
        listing = { computers: [], note: "Signed out of Caveman Cloud: sign in to send builders to Cloud computers." };
        linked = undefined;
        const signedOut = yield* service.capabilities(scope);
        assert.deepEqual(signedOut.computers, [{ id: scope.environmentId, ...here }]);
        assert.equal(signedOut.computersNote, listing.note);
      }).pipe(
        Effect.provide(
          layerOrchestratorService.pipe(
            Layer.provide(Layer.merge(builderDependencies(dispatched, buildersFor([], { is: true }, () => listing, () => linked), providers), environment)),
          ),
        ),
      );
    }),
  );

  it.effect("resolves a driverKind target to a capable Antigravity instance", () =>
    Effect.gen(function* () {
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("antigravity"),
        providerInstanceId: antigravityInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "ant-model",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: antigravityInstanceId,
              driver: ProviderDriverKind.make("antigravity"),
              model: "ant-model",
            }),
          ]),
        }),
        adapterRegistryLayer([codexInstanceId, antigravityInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("antigravity") },
          mode: "async",
          clientRequestId: "delegate-antigravity-driver-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, antigravityInstanceId);
        assert.equal(request.modelSelection.model, "ant-model");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("rejects delegation to a provider without a registered adapter", () =>
    Effect.gen(function* () {
      const forkOnlyInstanceId = ProviderInstanceId.make("forkOnly");
      const forkShadow = yield* buildUnavailableProviderSnapshot({
        driverKind: "forkOnly",
        instanceId: forkOnlyInstanceId,
        reason: "Driver 'forkOnly' is not registered in this build.",
        checkedAt: "2026-09-13T00:00:00.000Z",
      });
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          forkShadow,
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const byInstance = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: forkOnlyInstanceId },
            mode: "async",
            clientRequestId: "delegate-fork-1",
          })
          .pipe(Effect.flip);
        assert.equal(byInstance.code, "provider_unavailable");
        assert.isTrue(byInstance.message.includes("No V2 provider adapter is registered."));

        const byDriver = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("forkOnly") },
            mode: "async",
            clientRequestId: "delegate-fork-2",
          })
          .pipe(Effect.flip);
        assert.equal(byDriver.code, "provider_unavailable");
        assert.isTrue(
          byDriver.message.includes("No V2 provider adapter is registered for driver forkOnly."),
        );
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("refuses delegation to a provider the project turned off", () =>
    Effect.gen(function* () {
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: () => Effect.succeed(parentProjection([])),
          // ThreadManagementService.dispatch is the chokepoint now: it is the
          // one that refuses, not a separate pre-dispatch assert.
          dispatch: () =>
            Effect.fail(
              new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                projectId,
                instanceId: codexInstanceId,
              }),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const error = yield* service
          .delegateTask(scope, {
            task: "Summarize the diff.",
            target: { providerInstanceId: codexInstanceId },
            mode: "async",
            clientRequestId: "delegate-disabled-1",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("driver-only delegation skips an instance the project turned off", () =>
    Effect.gen(function* () {
      const altInstanceId = ProviderInstanceId.make("codex-alt");
      const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: altInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Summarize the diff.",
        title: null,
        model: "gpt-5.4",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      let delegated = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId
                ? parentProjection(delegated ? [task] : [])
                : childProjection,
            ),
          // The parent's own instance is off for this project; the other
          // instance of the same driver is on.
          isProviderInstanceEnabledForProject: ({ instanceId }) =>
            Effect.succeed(instanceId !== codexInstanceId),
          assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
            instanceId === codexInstanceId
              ? Effect.fail(
                  new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                    projectId,
                    instanceId,
                  }),
                )
              : Effect.void,
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.andThen(
                Effect.sync(() => {
                  delegated = true;
                }),
              ),
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        providerRegistryLayer([
          providerSnapshot({
            instanceId: codexInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
          providerSnapshot({
            instanceId: altInstanceId,
            driver: ProviderDriverKind.make("codex"),
            model: "gpt-5.4",
          }),
        ]),
        adapterRegistryLayer([codexInstanceId, altInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ServerSettings.layerTest(),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const result = yield* service.delegateTask(scope, {
          task: "Summarize the diff.",
          target: { driverKind: ProviderDriverKind.make("codex") },
          mode: "async",
          clientRequestId: "delegate-driver-skip-disabled-1",
        });
        assert.equal(result.status, "running");
        const commands = yield* Ref.get(dispatched);
        assert.equal(commands.length, 1);
        const request = commands[0] as {
          modelSelection: { instanceId: string; model: string };
        };
        assert.equal(request.modelSelection.instanceId, altInstanceId);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "retrying an accepted driver-only delegation replays even after the project disables every candidate",
    () =>
      Effect.gen(function* () {
        const altInstanceId = ProviderInstanceId.make("codex-alt");
        const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
        const accepted = yield* Ref.make(false);
        const everyCandidateDisabled = yield* Ref.make(false);
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const layerDependencies = Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: (threadId) =>
              Ref.get(accepted).pipe(
                Effect.map((isAccepted) =>
                  threadId === parentThreadId
                    ? parentProjection(isAccepted ? [task] : [])
                    : childProjection,
                ),
              ),
            // A command id already accepted once, even if the project later
            // disables every candidate: its retry must replay, not re-resolve.
            hasReceipt: () => Ref.get(accepted),
            // Effective settings once the project turns every instance off,
            // ignoring the already-accepted command's replay exemption.
            isProviderInstanceEnabledForProject: () =>
              Ref.get(everyCandidateDisabled).pipe(Effect.map((disabled) => !disabled)),
            assertProviderInstanceEnabled: ({ projectId, instanceId }) =>
              Effect.all([Ref.get(accepted), Ref.get(everyCandidateDisabled)]).pipe(
                Effect.flatMap(([isAccepted, disabled]) =>
                  isAccepted || !disabled
                    ? Effect.void
                    : Effect.fail(
                        new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({
                          projectId,
                          instanceId,
                        }),
                      ),
                ),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                Effect.andThen(Ref.set(accepted, true)),
                Effect.as({
                  sequence: 1,
                  storedEvents: [
                    {
                      sequence: 1,
                      commandId: null,
                      event: { type: "subagent.updated", payload: task },
                    },
                  ],
                } as never),
              ),
          }),
          providerRegistryLayer([
            providerSnapshot({
              instanceId: codexInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
            providerSnapshot({
              instanceId: altInstanceId,
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4",
            }),
          ]),
          adapterRegistryLayer([codexInstanceId, altInstanceId]),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          ServerSettings.layerTest(),
        );

        yield* Effect.gen(function* () {
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          const first = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(first.status, "running");

          // The project turns off every instance of this driver only after
          // the delegation above was already accepted.
          yield* Ref.set(everyCandidateDisabled, true);

          const retry = yield* service.delegateTask(scope, {
            task: "Summarize the diff.",
            target: { driverKind: ProviderDriverKind.make("codex") },
            mode: "async",
            clientRequestId: "delegate-driver-retry-after-disable-1",
          });
          assert.equal(retry.status, "running");

          const commands = yield* Ref.get(dispatched);
          assert.equal(commands.length, 2);
          const retryCommand = commands[1] as {
            modelSelection: { instanceId: string; model: string };
          };
          assert.equal(retryCommand.modelSelection.instanceId, codexInstanceId);
        }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      }),
  );

  it.effect("enforces Settings > Subagents limits and inherits the lead for research and review without Cloud", () =>
    Effect.gen(function* () {
      const runningTask = (n: number) => ({
        id: NodeId.make(`node:limits-task-${n}`),
        threadId: parentThreadId,
        origin: "app_owned",
        childThreadId: ThreadId.make(`thread:limits-child-${n}`),
        status: "running",
      });
      let subagents: ReadonlyArray<unknown> = [];
      let lineage: unknown = { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId };
      const dispatched = yield* Ref.make<ReadonlyArray<{ readonly type: string; readonly task: string; readonly modelSelection: { readonly model: string } }>>([]);
      // The task every dispatch reports; finished, so it never counts as working.
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Find where retries happen.",
        title: null,
        model: "gpt-5.4",
        status: "completed",
        result: "done",
        startedAt: null,
        completedAt: null,
      };
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadShell: (threadId) => Effect.succeed({ id: threadId, lineage: { parentThreadId: ThreadId.make("thread:limits-root"), relationshipToParent: threadId === ThreadId.make("thread:limits-root") ? null : "subagent", rootThreadId: ThreadId.make("thread:limits-root") } } as never),
          // A waited delegation (an automation step's) watches from here; its task is already finished.
          getThreadEventSequence: () => Effect.succeed(0 as never),
          // Reads yield, as a store does, so concurrent delegations interleave.
          getThreadRecords: (threadId) =>
            Effect.yieldNow.pipe(
              Effect.as(
                threadId === parentThreadId
                  ? ({ ...parentProjection([task, ...subagents]), thread: { ...parentProjection([]).thread, lineage } } as never)
                  : ({ ...childProjection, providerTurns: [] } as never),
              ),
            ),
          // Each started child works until the test says otherwise.
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command as never]).pipe(
              Effect.andThen(Effect.sync(() => (subagents = [...subagents, runningTask(100 + subagents.length)]))),
              Effect.as({ sequence: 1, storedEvents: [{ sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } }] } as never),
            ),
        }),
        ServerSettings.layerTest(),
        providerRegistryLayer([
          {
            ...providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
            models: [
              { slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: null },
              { slug: "gpt-5.4-mini", name: "gpt-5.4-mini", isCustom: false, capabilities: null },
            ],
          },
        ]),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string, extra: Partial<Parameters<typeof service.delegateTask>[1]> = {}) =>
          service.delegateTask(scope, { task: "Find where retries happen.", mode: "async", clientRequestId, ...extra });

        // No Cloud: every role inherits, even with a cheaper model in the catalog.
        yield* delegate("limits-research", { role: "research" });
        yield* delegate("limits-review", { role: "review" });
        yield* delegate("limits-build", { role: "implementation" });
        // An agent type: its instructions lead the brief; investigator is a research type.
        yield* delegate("limits-agent", { agent: "investigator" });
        const requests = () => Ref.get(dispatched).pipe(Effect.map((commands) => commands.filter((c) => c.type === "delegated_task.request")));
        const sent = yield* requests();
        assert.deepEqual(sent.map((c) => c.modelSelection.model), ["gpt-5.4", "gpt-5.4", "gpt-5.4", "gpt-5.4"]);
        assert.isTrue(sent[3]!.task.startsWith("You are the investigator agent."));
        assert.isTrue(sent[3]!.task.endsWith("Find where retries happen."));
        const unknown = yield* delegate("limits-unknown-agent", { agent: "nobody" }).pipe(Effect.flip);
        assert.equal(unknown.code, "invalid_request");
        assert.include(unknown.message, "investigator, builder, reviewer");

        // Eight agents already working under this root: the ninth is refused, with what to do instead.
        subagents = Array.from({ length: 8 }, (_, n) => runningTask(n));
        const busy = yield* delegate("limits-ninth").pipe(Effect.flip);
        assert.equal(busy.code, "limit_reached");
        assert.include(busy.message, "Wait for one to finish");

        // A caller already two levels deep (root > child > this thread) may not nest further.
        subagents = [];
        lineage = { parentThreadId: ThreadId.make("thread:limits-child"), relationshipToParent: "subagent", rootThreadId: ThreadId.make("thread:limits-root") };
        const deep = yield* delegate("limits-deep").pipe(Effect.flip);
        assert.equal(deep.code, "limit_reached");
        assert.include(deep.message, "at most 2 levels");
        assert.equal((yield* requests()).length, 4);

        // Seven working and three delegations at the same moment: exactly one starts.
        lineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId };
        subagents = Array.from({ length: 7 }, (_, n) => runningTask(n));
        const outcomes = yield* Effect.all(
          ["race-1", "race-2", "race-3"].map((id) => delegate(id).pipe(Effect.match({ onFailure: (error) => error.code, onSuccess: () => "started" }))),
          { concurrency: "unbounded" },
        );
        assert.deepEqual(outcomes.toSorted(), ["limit_reached", "limit_reached", "started"]);

        // A delegated agent starts no new top-level chats: each would be a fresh root outside these limits.
        lineage = { parentThreadId: ThreadId.make("thread:limits-root"), relationshipToParent: "subagent", rootThreadId: ThreadId.make("thread:limits-root") };
        const roots = yield* service.createThreads(scope, { threads: [{ prompt: "Summarize the diff." }], clientRequestId: "limits-roots" }).pipe(Effect.flip);
        assert.equal(roots.code, "capability_denied");
        assert.include(roots.message, "Use delegate_task");

        // An automation step's tree: no new top-level chats (they would escape the run), and its delegates
        // finish inside its turn, so an async request waits as long as a wait may last.
        lineage = { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make("automation:r_1.build.1") };
        subagents = [];
        const stepRoots = yield* service.createThreads(scope, { threads: [{ prompt: "Summarize the diff." }], clientRequestId: "automation-roots" }).pipe(Effect.flip);
        assert.equal(stepRoots.code, "capability_denied");
        assert.include(stepRoots.message, "An automation step cannot start chats");
        yield* delegate("automation-async", { mode: "async", timeoutMs: 5 });
        const fromStep = (yield* requests()).at(-1) as unknown as { readonly completionWake: string };
        assert.equal(fromStep.completionWake, "settled_only");
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect("picks a child's runner: explicit target, configured model, Cloud, then the lead's selection", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const cursorInstanceId = ProviderInstanceId.make("cursor");
      // Turned off for this project, and one that can't run the parent's full-access mode.
      const offInstanceId = ProviderInstanceId.make("grok");
      const narrowInstanceId = ProviderInstanceId.make("muse");
      const effort = (id: string) => ({
        optionDescriptors: [{ id, label: "Effort", type: "select" as const, options: ["low", "medium", "high"].map((level) => ({ id: level, label: level })) }],
      });
      const providers: ReadonlyArray<ServerProvider> = [
        {
          ...providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex") }),
          models: [
            { slug: "gpt-5.4", name: "gpt-5.4", isCustom: false, capabilities: effort("reasoningEffort") },
            { slug: "gpt-5.4-mini", name: "gpt-5.4-mini", isCustom: false, capabilities: null },
            { slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: effort("reasoningEffort") },
          ],
        },
        {
          ...providerSnapshot({ instanceId: claudeInstanceId, driver: ProviderDriverKind.make("claudeAgent") }),
          auth: { status: "authenticated", type: "max" },
          models: [
            { slug: "claude-sonnet-5-5", name: "Sonnet", isCustom: false, capabilities: effort("effort") },
            { slug: "claude-opus-5-5", name: "Opus", isCustom: false, capabilities: effort("effort") },
            { slug: "claude-haiku-5-5", name: "Haiku", isCustom: false, capabilities: null },
          ],
        },
        // Out of quota until a reset still ahead: never in the pool.
        {
          ...providerSnapshot({ instanceId: cursorInstanceId, driver: ProviderDriverKind.make("cursor"), model: "composer-2" }),
          usageLimits: { checkedAt: "2026-10-17T00:00:00.000Z", windows: [{ id: "monthly", kind: "monthly", label: "Monthly", usedPercent: 100, resetsAt: "2999-01-01T00:00:00.000Z" }] },
        },
        providerSnapshot({ instanceId: offInstanceId, driver: ProviderDriverKind.make("grok"), model: "grok-5" }),
        { ...providerSnapshot({ instanceId: narrowInstanceId, driver: ProviderDriverKind.make("muse"), model: "muse-1" }), supportedRuntimeModes: ["approval-required"] },
      ];
      const dispatched = yield* Ref.make<ReadonlyArray<{ readonly type: string; readonly commandId: string; readonly runtimeMode: string; readonly modelSelection: { readonly instanceId: string; readonly model: string; readonly options?: unknown } }>>([]);
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: codexInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "gpt-5.4",
        status: "completed",
        result: "done",
        startedAt: null,
        completedAt: null,
      };
      // Agent types in the parent's checkout: one whose model this engine has, one whose model it lacks.
      const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-auto-"));
      fs.mkdirSync(path.join(checkout, ".caveman", "agents"), { recursive: true });
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "cheap.md"), "---\nname: cheap\nmodel: gpt-5.4-mini\nrole: review\n---\nReview.\n");
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "elsewhere.md"), "---\nname: elsewhere\nmodel: no-such-model\nrole: review\n---\nReview.\n");
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "careful.md"), "---\nname: careful\nmodel: gpt-5.4\neffort: low\nrole: research\n---\nRead slowly.\n");
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "reader.md"), "---\nname: reader\nmodel: haiku\nrole: research\n---\nRead.\n");
      // Agent types that name their engine (as automation steps honor it), and one whose engine isn't installed here.
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "onclaude.md"), "---\nname: onclaude\nengine: claude-agent\nmodel: fast\nrole: research\n---\nRead.\n");
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "nowhere.md"), "---\nname: nowhere\nengine: acp:nowhere\nrole: research\n---\nRead.\n");
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "quick.md"), "---\nname: quick\nmodel: fast\nrole: research\n---\nRead.\n");
      let leadSelection = parentProjection([]).thread.modelSelection;
      // Caveman Cloud, faked at the service: what it was asked, what it answers, what was kept.
      let key: string | undefined = "cave_test";
      let answer: (targets: ReadonlyMap<string, PoolTarget>) => RouteAnswer = () => ({ kind: "default" });
      const asked: Array<ReturnType<typeof routeBody>> = [];
      const kept: Array<{ readonly commandId: string; readonly runner: SubagentRunner; readonly outcome: RouteOutcome | undefined }> = [];
      const auto = Layer.succeed(
        SubagentAuto,
        SubagentAuto.of({
          connected: Effect.sync(() => ({ key, caveman: undefined })),
          ask: (_key, body, targets) => Effect.sync(() => (asked.push(body), answer(targets))),
          remember: (commandId, runner, outcome) => Effect.sync(() => void kept.push({ commandId, runner, outcome })),
          adopt: () => Effect.succeed(undefined),
          finish: () => Effect.void,
        }),
      );
      const enabled = (instanceId: string) => instanceId !== offInstanceId;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          // The project's provider switch, as the dispatch enforces it.
          isProviderInstanceEnabledForProject: ({ instanceId }) => Effect.succeed(enabled(instanceId)),
          assertProviderInstanceEnabled: ({ instanceId, projectId }) =>
            enabled(instanceId) ? Effect.void : Effect.fail(new ThreadManagementService.ThreadManagementProviderInstanceDisabledError({ projectId, instanceId })),
          getThreadShell: (threadId) => Effect.succeed({ id: threadId, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId } } as never),
          getThreadRecords: (threadId) => {
            const parent = parentProjection([task], leadSelection);
            return Effect.succeed((threadId === parentThreadId ? { ...parent, thread: { ...parent.thread, worktreePath: checkout }, runs: parent.runs.map((run) => ({ ...run, providerInstanceId: leadSelection.instanceId })) } : { ...childProjection, providerTurns: [] }) as never);
          },
          dispatch: (command) =>
            enabled((command as { modelSelection?: { instanceId: string } }).modelSelection?.instanceId ?? "")
              ? Ref.update(dispatched, (commands) => [...commands, command as never]).pipe(
                  Effect.as({ sequence: 1, storedEvents: [{ sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } }] } as never),
                )
              : Effect.die("dispatched a provider this project turned off"),
        }),
        ServerSettings.layerTest({ subagents: { rolePins: { review: { instanceId: claudeInstanceId, model: "claude-sonnet-5-5", effort: "high" } } } }),
        providerRegistryLayer(providers),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId, cursorInstanceId, offInstanceId, narrowInstanceId]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        auto,
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string, extra: Partial<Parameters<typeof service.delegateTask>[1]> = {}) =>
          service.delegateTask({ ...scope, thread: { ...scope.thread!, providerInstanceId: leadSelection.instanceId } }, { task: "Look at the retry loop.", mode: "async", clientRequestId, ...extra });
        const last = () => Ref.get(dispatched).pipe(Effect.map((commands) => commands.filter((c) => c.type === "delegated_task.request").at(-1)!));

        // The lead's target wins: Cloud is not asked.
        yield* delegate("pick-lead", { role: "review", target: { model: "gpt-5.4-mini" } });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: codexInstanceId, model: "gpt-5.4-mini" });
        assert.deepEqual(kept.at(-1)!.runner, { engine: "codex", instance_id: "codex", model: "gpt-5.4-mini", pick: { by: "lead", kind: "review" } });
        assert.equal(kept.at(-1)!.commandId, (yield* last()).commandId);
        assert.equal(asked.length, 0);

        // An agent type's own model, when this engine has it, is the person's pick.
        yield* delegate("pick-type", { agent: "cheap" });
        assert.equal((yield* last()).modelSelection.model, "gpt-5.4-mini");
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "review" });
        // With its effort, in the model's own option; the lead's options still win.
        yield* delegate("pick-type-effort", { agent: "careful" });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: codexInstanceId, model: "gpt-5.4", options: [{ id: "reasoningEffort", value: "low" }] });
        assert.equal(kept.at(-1)!.runner.effort, "low");
        yield* delegate("pick-type-lead-effort", { agent: "careful", target: { options: [{ id: "reasoningEffort", value: "high" }] } });
        assert.deepEqual((yield* last()).modelSelection.options, [{ id: "reasoningEffort", value: "high" }]);

        // Then the person's pin for the role, with its effort; also for a type whose model this engine lacks.
        for (const extra of [{ role: "review" as const }, { agent: "elsewhere" }]) {
          yield* delegate(`pick-pin-${JSON.stringify(extra)}`, extra);
          assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-sonnet-5-5", options: [{ id: "effort", value: "high" }] });
          assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "review" });
          assert.equal(kept.at(-1)!.runner.effort, "high");
        }
        assert.equal(asked.length, 0);

        // Then Auto. The pool: every ready instance x model, without the spent Cursor login, the provider
        // this project turned off, or one that would drop the child below the parent's full-access.
        answer = (targets) => ({ kind: "pick", target: targets.get("claudeAgent/claude-sonnet-5-5")!, effort: "medium", outcome: { token: "tok-1", url: "https://gateway.example" } });
        yield* delegate("pick-auto", { role: "implementation", agent: "builder" });
        const body = asked.at(-1)!;
        assert.deepEqual(body.models, ["gpt-5.4"]);
        assert.deepEqual({ kind: body.task.kind, agent: body.task.agent }, { kind: "implementation", agent: "builder" });
        assert.include(body.task.brief!, "Look at the retry loop.");
        assert.deepEqual(
          body.pool.map((e) => [e.id, e.harness, e.host, e.billing]),
          [
            ["codex/gpt-5.4", "codex", "openai", undefined],
            ["claudeAgent/claude-sonnet-5-5", "claude-agent", "anthropic", "subscription"],
            ["codex/gpt-5.4-mini", "codex", "openai", undefined],
            ["claudeAgent/claude-opus-5-5", "claude-agent", "anthropic", "subscription"],
            ["codex/gpt-6-luna", "codex", "openai", undefined],
            ["claudeAgent/claude-haiku-5-5", "claude-agent", "anthropic", "subscription"],
          ],
        );
        assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-sonnet-5-5", options: [{ id: "effort", value: "medium" }] });
        assert.deepEqual(kept.at(-1), { commandId: (yield* last()).commandId, outcome: { token: "tok-1", url: "https://gateway.example" }, runner: { engine: "claude-agent", instance_id: "claudeAgent:default", model: "claude-sonnet-5-5", effort: "medium", pick: { by: "auto", kind: "implementation", options: 6 } } });

        // Cloud keeps the lead's selection (no_alternative), with no local role-based pick.
        answer = () => ({ kind: "default", outcome: { token: "tok-2", url: "https://gateway.example" } });
        yield* delegate("pick-auto-default", { role: "research" });
        assert.deepEqual(asked.at(-1)!.models, ["gpt-5.4"]);
        assert.equal((yield* last()).modelSelection.model, "gpt-5.4");
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "default", kind: "research", options: 6 });
        assert.deepEqual(kept.at(-1)!.outcome, { token: "tok-2", url: "https://gateway.example" });

        // Each fallback inherits and says why; none blocks the delegation.
        for (const [reason, setup] of [
          ["not_paying", () => (answer = () => ({ kind: "fallback", reason: "not_paying" }))],
          ["quota", () => (answer = () => ({ kind: "fallback", reason: "quota" }))],
          ["cloud_error", () => (answer = () => ({ kind: "fallback", reason: "cloud_error" }))],
          // A pick that no longer resolves, is off for this project, or would narrow the child's mode is no decision either.
          ["cloud_error", () => (answer = () => ({ kind: "pick", target: { instanceId: "gone", model: "x" } }))],
          ["cloud_error", () => (answer = () => ({ kind: "pick", target: { instanceId: offInstanceId, model: "grok-5" } }))],
          ["cloud_error", () => (answer = () => ({ kind: "pick", target: { instanceId: narrowInstanceId, model: "muse-1" } }))],
          ["cloud_unlinked", () => (key = undefined)],
        ] as const) {
          setup();
          yield* delegate(`pick-fallback-${reason}-${kept.length}`, { role: "research" });
          assert.equal((yield* last()).modelSelection.model, "gpt-5.4");
          assert.equal((yield* last()).runtimeMode, "full-access");
          assert.deepEqual(kept.at(-1)!.runner.pick, { by: "default", kind: "research", fallback: reason, ...(reason === "cloud_unlinked" ? {} : { options: 6 }) });
          assert.isUndefined(kept.at(-1)!.outcome);
        }

        // Opus lead, research on another harness: only Cloud chooses Luna and its effort.
        leadSelection = { instanceId: claudeInstanceId, model: "claude-opus-5-5", options: [{ id: "effort", value: "high" }] };
        key = "cave_test";
        answer = (targets) => ({ kind: "pick", target: targets.get("codex/gpt-6-luna")!, effort: "low" });
        yield* delegate("pick-research-cross-harness", { role: "research" });
        assert.deepEqual(asked.at(-1)!.models, ["claude-opus-5-5"]);
        assert.equal(asked.at(-1)!.task.kind, "research");
        assert.deepEqual((yield* last()).modelSelection, { instanceId: codexInstanceId, model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] });
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "auto", kind: "research", options: 6 });

        // User-configured aliases resolve on Claude, never to a cheap model on Codex.
        yield* delegate("pick-haiku-claude", { agent: "reader" });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-haiku-5-5" });
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "research" });
        leadSelection = { instanceId: codexInstanceId, model: "gpt-5.4", options: [{ id: "reasoningEffort", value: "high" }] };
        key = undefined;
        yield* delegate("pick-haiku-codex", { agent: "reader" });
        assert.deepEqual((yield* last()).modelSelection, leadSelection);

        // An agent type's engine: its child runs on that engine, its class anchored on that engine's models,
        // never the lead's engine's fast model. An engine not installed here leaves the lead's.
        yield* delegate("pick-type-engine", { agent: "onclaude" });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-haiku-5-5" });
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "research" });
        yield* delegate("pick-type-engine-missing", { agent: "nowhere" });
        assert.deepEqual((yield* last()).modelSelection, leadSelection);
        // The lead's own target still wins over the type's engine.
        yield* delegate("pick-type-engine-lead", { agent: "onclaude", target: { model: "gpt-5.4-mini" } });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: codexInstanceId, model: "gpt-5.4-mini" });

        // Under an Auto lead a class anchors on the engine's own models (the first of a family the table knows).
        leadSelection = { instanceId: claudeInstanceId, model: "caveman-auto" };
        yield* delegate("pick-class-under-auto", { agent: "quick" });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-haiku-5-5" });
        leadSelection = { instanceId: codexInstanceId, model: "gpt-5.4", options: [{ id: "reasoningEffort", value: "high" }] };

        // Legacy By role settings inherit too. Pins still win with Auto off.
        const settings = yield* ServerSettings.ServerSettingsService;
        for (const defaultModel of ["inherit", "auto-by-role"] as const) {
          yield* settings.updateSettings({ subagents: { defaultModel, rolePins: { review: null } } });
          for (const role of ["research", "review"] as const) {
            yield* delegate(`pick-off-${defaultModel}-${role}`, { role });
            assert.deepEqual((yield* last()).modelSelection, leadSelection);
            assert.deepEqual(kept.at(-1)!.runner.pick, { by: "default", kind: role });
          }
          yield* settings.updateSettings({ subagents: { rolePins: { review: { instanceId: claudeInstanceId, model: "claude-sonnet-5-5" } } } });
          yield* delegate(`pick-off-pin-${defaultModel}`, { role: "review" });
          assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-sonnet-5-5" });
          assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "review" });
        }

        // A task kind's pin: with no role named, a brief the classifier reads (on this computer) as frontend work runs
        // on it. Prefer leaves the lead's own pick; Always outranks it. A named role's own pin comes first.
        yield* settings.updateSettings({ subagents: { rolePins: { review: null }, taskPins: { frontend_ui: { instanceId: claudeInstanceId, model: "claude-opus-5-5" } } } });
        const ui = "The settings page buttons are misaligned and the sidebar colors look wrong in dark mode. Fix the CSS so the React components match the mockup.";
        yield* delegate("pick-task", { task: ui });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-opus-5-5" });
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "general", task: "frontend_ui" });
        yield* delegate("pick-task-prefer", { task: ui, target: { model: "gpt-5.4-mini" } });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: codexInstanceId, model: "gpt-5.4-mini" });
        assert.equal(kept.at(-1)!.runner.pick.by, "lead");
        // An agent type's own model beats a Prefer pin, and the runner never credits the kind's pin with it.
        yield* delegate("pick-task-type", { task: ui, agent: "cheap" });
        assert.equal((yield* last()).modelSelection.model, "gpt-5.4-mini");
        assert.equal(kept.at(-1)!.runner.pick.task, undefined);
        yield* settings.updateSettings({ subagents: { taskPins: { frontend_ui: { instanceId: claudeInstanceId, model: "claude-opus-5-5", always: true } } } });
        yield* delegate("pick-task-always", { task: ui, target: { model: "gpt-5.4-mini" } });
        assert.deepEqual((yield* last()).modelSelection, { instanceId: claudeInstanceId, model: "claude-opus-5-5" });
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "general", task: "frontend_ui" });
        yield* settings.updateSettings({ subagents: { rolePins: { review: { instanceId: claudeInstanceId, model: "claude-sonnet-5-5" } } } });
        yield* delegate("pick-task-role", { task: ui, role: "review" });
        assert.equal((yield* last()).modelSelection.model, "claude-sonnet-5-5");
        assert.deepEqual(kept.at(-1)!.runner.pick, { by: "user", kind: "review" });
        yield* settings.updateSettings({ subagents: { taskPins: { frontend_ui: null } } });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(layerDependencies))));

      // ---- A builder (a chat of its own in a worktree, or on another computer) is picked for in the same order: it
      // may run on another engine than its lead's, which a T3 child of a Caveman Code lead never needed to.
      const builderAsks: Array<BuilderStart> = [];
      const takesBuilders = Layer.succeed(
        Builders,
        Builders.of({
          start: (input) =>
            Effect.sync(() => {
              builderAsks.push(input);
              const id = `ws-${builderAsks.length}`;
              return { workspaceId: id, threadId: `caveman:${id}`, where: "here" as const, title: input.title ?? "Builder", engine: input.engine ?? "codex", ...(input.model ? { model: input.model } : {}) };
            }),
          status: () => Effect.succeed(undefined),
          thisComputer: () => "cc-this",
          computers: () => Effect.succeed({ computers: [] }),
          tree: () => Effect.succeed({ running: 0, threadIds: [], tokens: 0 }),
          sharesComputer: () => Effect.succeed(false),
          message: () => Effect.succeed(undefined),
          bind: () => Effect.void,
        }),
      );
      leadSelection = parentProjection([]).thread.modelSelection;
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const settings = yield* ServerSettings.ServerSettingsService;
        const build = (clientRequestId: string, extra: Partial<Parameters<typeof service.delegateTask>[1]> = {}) =>
          service.delegateTask({ ...scope, thread: { ...scope.thread!, providerInstanceId: leadSelection.instanceId } }, { task: "Build the part.", mode: "async", isolation: "worktree", clientRequestId, ...extra });
        const lastBuilder = () => [builderAsks.at(-1)!.engine, builderAsks.at(-1)!.model];
        key = "cave_test";
        asked.length = 0;

        // The role's pin (Settings > Agents): a Codex lead's review builder runs on Claude Agent, on the pinned model.
        yield* settings.updateSettings({ subagents: { defaultModel: "auto", rolePins: { review: { instanceId: claudeInstanceId, model: "claude-sonnet-5-5" } } } });
        yield* build("builder-pin", { role: "review" });
        assert.deepEqual(lastBuilder(), ["claude-agent", "claude-sonnet-5-5"]);
        assert.equal(asked.length, 0);
        // The lead's own target still wins over the pin.
        yield* build("builder-lead", { role: "review", target: { model: "gpt-5.4-mini" } });
        assert.deepEqual(lastBuilder(), [undefined, "gpt-5.4-mini"]);
        // An agent type's engine too.
        yield* build("builder-type", { agent: "onclaude" });
        assert.equal(lastBuilder()[0], "claude-agent");
        assert.equal(asked.length, 0);

        // No pin for the role and Auto the default: Cloud is asked once, and the builder runs on what it picked.
        let pickedModel: string | undefined;
        answer = (targets) => {
          const target = [...targets.values()].find((candidate) => candidate.instanceId === claudeInstanceId)!;
          pickedModel = target.model;
          return { kind: "pick", target, effort: "low" };
        };
        yield* build("builder-auto", { role: "research" });
        assert.equal(asked.length, 1);
        assert.isDefined(pickedModel);
        assert.deepEqual(lastBuilder(), ["claude-agent", pickedModel]);
        // Cloud keeps the lead's selection: the lead's own engine and model, as before.
        answer = () => ({ kind: "default" });
        yield* build("builder-auto-kept", { role: "research" });
        assert.deepEqual(lastBuilder(), [undefined, undefined]);
        // No routing credential here (signed out; a computer whose Cloud runs no credits): the lead's own, never a refusal.
        key = undefined;
        yield* build("builder-unlinked", { role: "research" });
        assert.deepEqual(lastBuilder(), [undefined, undefined]);
        key = "cave_test";
        // Auto off and no pin: Cloud is not asked.
        yield* settings.updateSettings({ subagents: { defaultModel: "inherit" } });
        const before = asked.length;
        yield* build("builder-inherit", { role: "research" });
        assert.deepEqual(lastBuilder(), [undefined, undefined]);
        assert.equal(asked.length, before);
        // A builder never becomes a T3 child along the way.
        assert.lengthOf(builderAsks, 7);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provideMerge(Layer.mergeAll(layerDependencies, takesBuilders)))));
      fs.rmSync(checkout, { recursive: true, force: true });
    }),
  );

  it.effect("a role pinned to a provider this project turned off gives way to Auto", () =>
    Effect.gen(function* () {
      const offInstanceId = ProviderInstanceId.make("claudeAgent");
      const providers: ReadonlyArray<ServerProvider> = [
        providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
        providerSnapshot({ instanceId: offInstanceId, driver: ProviderDriverKind.make("claudeAgent"), model: "claude-sonnet-5-5" }),
      ];
      const task = { id: taskId, threadId: parentThreadId, origin: "app_owned", childThreadId, status: "completed", providerInstanceId: codexInstanceId, model: "gpt-5.4" };
      const dispatched: Array<{ readonly modelSelection: { readonly instanceId: string } }> = [];
      const kept: Array<SubagentRunner> = [];
      const pools: Array<ReadonlyArray<string>> = [];
      const briefs: Array<string | undefined> = [];
      let hang = false;
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          isProviderInstanceEnabledForProject: ({ instanceId }) => Effect.succeed(instanceId !== offInstanceId),
          getThreadShell: (threadId) => Effect.succeed({ id: threadId, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId } } as never),
          getThreadRecords: (threadId) => Effect.succeed((threadId === parentThreadId ? parentProjection([task]) : { ...childProjection, providerTurns: [] }) as never),
          dispatch: (command) =>
            Effect.sync(() => dispatched.push(command as never)).pipe(
              Effect.as({ sequence: 1, storedEvents: [{ sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } }] } as never),
            ),
        }),
        ServerSettings.layerTest({ subagents: { rolePins: { review: { instanceId: offInstanceId, model: "claude-sonnet-5-5" } } } }),
        providerRegistryLayer(providers),
        adapterRegistryLayer([codexInstanceId, offInstanceId]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        // The brief leaves the machine scrubbed of repository secrets.
        Layer.mock(ProjectSecrets)({ scrubber: Effect.succeed({ scrub: (text: string) => text.replaceAll("hunter2-value", "[secret:API_KEY]") } as never) }),
        Layer.succeed(
          SubagentAuto,
          SubagentAuto.of({
            // A key store that never answers is cut off at its own time box.
            connected: Effect.suspend(() => (hang ? Effect.never : Effect.succeed({ key: "cave_test", caveman: undefined }))),
            ask: (_key, body, targets) =>
              Effect.sync(() => (pools.push(body.pool.map((e) => e.id)), briefs.push(body.task.brief), { kind: "pick" as const, target: targets.get("codex/gpt-5.4")! })),
            remember: (_id, runner) => Effect.sync(() => void kept.push(runner)),
            adopt: () => Effect.succeed(undefined),
            finish: () => Effect.void,
          }),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.delegateTask(scope, { task: "Review it; the key is hunter2-value.", role: "review", mode: "async", clientRequestId: "pin-off" });
        hang = true;
        const slow = yield* service.delegateTask(scope, { task: "Review again.", role: "review", mode: "async", clientRequestId: "pin-off-slow" }).pipe(Effect.forkChild);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(slow);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      assert.deepEqual(pools, [["codex/gpt-5.4"]]);
      assert.deepEqual(briefs, ["Review it; the key is [secret:API_KEY]."]);
      const requests = dispatched.filter((c) => (c as { type?: string }).type === "delegated_task.request");
      assert.equal(requests[0]!.modelSelection.instanceId, codexInstanceId);
      assert.deepEqual(kept[0]!.pick, { by: "auto", kind: "review", options: 1 });
      assert.equal(requests.length, 2);
      assert.deepEqual(kept[1]!.pick, { by: "default", kind: "review", fallback: "cloud_error" });
    }),
  );

  it.effect("a lead's credits Opus runs on the person's Claude plan, and the catalog lists that Opus once", () =>
    Effect.gen(function* () {
      const claudeId = ProviderInstanceId.make("claudeAgent");
      const cavemanId = ProviderInstanceId.make("caveman");
      const claude = providerSnapshot({ instanceId: claudeId, driver: ProviderDriverKind.make("claudeAgent"), model: "claude-opus-5-5" });
      const caveman = providerSnapshot({ instanceId: cavemanId, driver: ProviderDriverKind.make("caveman") });
      const providers: ReadonlyArray<ServerProvider> = [
        providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" }),
        { ...claude, auth: { status: "authenticated", type: "max" } },
        {
          ...caveman,
          models: ["caveman/anthropic/claude-opus-5-5", "caveman/zai/glm-5.3"].map((slug) => ({ slug, name: slug, isCustom: false, capabilities: null })),
        },
      ];
      const task = { id: taskId, threadId: parentThreadId, origin: "app_owned", childThreadId, status: "completed", providerInstanceId: codexInstanceId, model: "gpt-5.4" };
      const dispatched: Array<{ readonly type?: string; readonly modelSelection: { readonly instanceId: string; readonly model: string } }> = [];
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadShell: (threadId) => Effect.succeed({ id: threadId, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId } } as never),
          getThreadRecords: (threadId) => Effect.succeed((threadId === parentThreadId ? parentProjection([task]) : { ...childProjection, providerTurns: [] }) as never),
          dispatch: (command) =>
            Effect.sync(() => dispatched.push(command as never)).pipe(
              Effect.as({ sequence: 1, storedEvents: [{ sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } }] } as never),
            ),
        }),
        ServerSettings.layerTest({}),
        providerRegistryLayer(providers),
        adapterRegistryLayer([codexInstanceId, claudeId, cavemanId]),
        Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeed(Option.none()) }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const capabilities = yield* service.capabilities(scope);
        assert.deepEqual(capabilities.providers.find((p) => p.providerInstanceId === cavemanId)?.models.map((m) => m.id), ["caveman/zai/glm-5.3"]);
        yield* service.delegateTask(scope, { task: "Build it.", target: { providerInstanceId: cavemanId, model: "caveman/anthropic/claude-opus-5-5" }, mode: "async", clientRequestId: "credits-opus" });
        // Nothing of the person's runs GLM: credits pay for it.
        yield* service.delegateTask(scope, { task: "Build it.", target: { providerInstanceId: cavemanId, model: "caveman/zai/glm-5.3" }, mode: "async", clientRequestId: "credits-glm" });
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
      const requests = dispatched.filter((c) => c.type === "delegated_task.request");
      assert.deepEqual(
        requests.map((r) => [r.modelSelection.instanceId, r.modelSelection.model]),
        [
          [claudeId, "claude-opus-5-5"],
          [cavemanId, "caveman/zai/glm-5.3"],
        ],
      );
    }),
  );

  it.effect("a worktree delegation in a Caveman Code chat's project starts from the parent's checkout commit", () =>
    Effect.gen(function* () {
      // Chats on the Session Protocol own their projects (caveman-repo:…); a delegated child there is the chat's own work.
      const owned = ProjectId.make("caveman-repo:0123456789abcdef");
      const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-parent-checkout-"));
      fs.mkdirSync(path.join(checkout, ".caveman", "agents"), { recursive: true });
      fs.writeFileSync(path.join(checkout, ".caveman", "agents", "auditor.md"), "---\nname: auditor\nisolation: worktree\n---\nAudit.\n");
      const providers: ReadonlyArray<ServerProvider> = [providerSnapshot({ instanceId: codexInstanceId, driver: ProviderDriverKind.make("codex"), model: "gpt-5.4" })];
      const task = { id: taskId, threadId: parentThreadId, origin: "app_owned", childThreadId, status: "running", providerInstanceId: codexInstanceId, model: "gpt-5.4" };
      const dispatched: Array<Record<string, unknown>> = [];
      const resolved: Array<string> = [];
      const parent = parentProjection([task]);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          isProviderInstanceEnabledForProject: () => Effect.succeed(true),
          getThreadShell: (threadId) => Effect.succeed({ id: threadId, lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: parentThreadId } } as never),
          getThreadRecords: (threadId) =>
            Effect.succeed((threadId === parentThreadId ? { ...parent, thread: { ...parent.thread, projectId: owned, worktreePath: checkout } } : { ...childProjection, providerTurns: [] }) as never),
          dispatch: (command) =>
            Effect.sync(() => dispatched.push(command as never)).pipe(
              Effect.as({ sequence: 1, storedEvents: [{ sequence: 1, commandId: null, event: { type: "subagent.updated", payload: task } }] } as never),
            ),
        }),
        ServerSettings.layerTest({}),
        providerRegistryLayer(providers),
        adapterRegistryLayer([codexInstanceId]),
        Layer.mock(ProjectService.ProjectService)({ getById: (id) => Effect.succeed(Option.some({ id, workspaceRoot: "/tmp/caveman-project-root" } as never)) }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      );
      const layer = OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({ resolveCommit: ({ cwd }) => Effect.sync(() => (resolved.push(cwd), { commitSha: "abc123" } as never)) })),
      );
      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        yield* service.delegateTask(scope, { task: "Work in your own checkout.", isolation: "worktree", mode: "async", clientRequestId: "iso-owned", target: { model: "gpt-5.4" } });
        // An agent type with `isolation: worktree` gets its own checkout too, unless the lead asks for shared.
        yield* service.delegateTask(scope, { task: "Audit it.", agent: "auditor", mode: "async", clientRequestId: "iso-type", target: { model: "gpt-5.4" } });
        yield* service.delegateTask(scope, { task: "Audit here.", agent: "auditor", isolation: "shared", mode: "async", clientRequestId: "iso-type-shared", target: { model: "gpt-5.4" } });
      }).pipe(Effect.provide(layer.pipe(Layer.provide(layerDependencies))));
      const requests = dispatched.filter((c) => c.type === "delegated_task.request");
      const request = requests[0];
 // Its branch is named as the app names a chat's, never upstream temporary t3/<hash>.
      const strategy = request?.workspaceStrategy as { type: string; baseRef: string; startFromOrigin: boolean; branch?: string } | undefined;
      assert.deepEqual({ ...strategy, branch: undefined }, { type: "worktree", baseRef: "abc123", startFromOrigin: false, branch: undefined });
      assert.match(strategy?.branch ?? "", /^caveman\/work-in-your-own-checkout-[0-9a-f]{6}$/);
      assert.equal((requests[1]?.workspaceStrategy as { type?: string } | undefined)?.type, "worktree");
      assert.equal(requests[2]?.workspaceStrategy, undefined);
      // Each worktree delegation reads the parent's checkout, then checks the project root has that commit.
      const root = "/tmp/caveman-project-root";
      assert.deepEqual(resolved, [checkout, root, checkout, root]);
      fs.rmSync(checkout, { recursive: true, force: true });
    }),
  );

  it.live.each([
    { name: "parent instance", parentEnabled: true, model: "gpt-5.4" },
    { name: "alternate instance", parentEnabled: false, model: "gpt-5.5" },
  ])(
    "replays accepted creation on the $name without authorizing new disabled work",
    ({ parentEnabled, model }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const altInstanceId = ProviderInstanceId.make("codex-alt");
          const driver = ProviderDriverKind.make("codex");
          const cwd = yield* checkpointWorkspace("mcp-create-retry");
          const layerRegistry = ProviderAdapterRegistry.layerFromAdapters(
            [codexInstanceId, altInstanceId].map((instanceId) => ({
              instanceId,
              driver,
              getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
              planSelectionTransition: () =>
                Effect.succeed({ type: "apply_on_next_turn" as const }),
              openSession: () =>
                Effect.die("These tests exercise committed commands before provider execution."),
            })),
          );
          const layerDatabase = SqlitePersistence.layerMemory;
          const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
            { name: "mcp-create-retry", runtimePolicyOverride: { cwd } },
            layerRegistry,
            { databaseLayer: layerDatabase, runEffectWorker: false },
          );
          const layerSettings = ServerSettings.layerTest({
            providerInstances: {
              [codexInstanceId]: { driver: "codex", enabled: true },
              [altInstanceId]: { driver: "codex", enabled: true },
            },
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [codexInstanceId]: { enabled: parentEnabled } } },
            },
          });
          const layerThreads = ThreadManagementService.layer.pipe(
            Layer.provideMerge(layerOrchestrator),
            Layer.provide(
              LegacyV1ThreadImporter.layer.pipe(
                Layer.provide(layerOrchestrator),
                Layer.provide(layerDatabase),
              ),
            ),
            Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
            Layer.provideMerge(layerSettings),
          );
          const layerTest = layerOrchestratorService.pipe(
            Layer.provideMerge(layerThreads),
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                NodeCrypto.layer,
                layerRegistry,
                layerSettings,
                providerRegistryLayer([
                  providerSnapshot({ instanceId: codexInstanceId, driver, model: "gpt-5.4" }),
                  providerSnapshot({ instanceId: altInstanceId, driver, model: "gpt-5.5" }),
                ]),
                Layer.mock(ProjectService.ProjectService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
              ),
            ),
          );
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const settings = yield* ServerSettings.ServerSettingsService;
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:create"),
              threadId: parentThreadId,
              projectId,
              title: "MCP parent",
              modelSelection: { instanceId: codexInstanceId, model: "gpt-5.4" },
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "user",
              creationSource: "web",
              commandId: CommandId.make("parent:start"),
              threadId: parentThreadId,
              messageId: MessageId.make("parent:message"),
              text: "Create a thread.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const request = {
              threads: [{ target: { driverKind: driver, model } }],
              clientRequestId: "create-retry",
            };
            const first = yield* service.createThreads(scope, request);
            const child = first.threads[0]!;
            const selection = parentEnabled
              ? { instanceId: codexInstanceId, model: "gpt-5.4" }
              : { instanceId: altInstanceId, model: "gpt-5.5" };
            assert.equal(first.threads.length, 1);
            assert.equal(child.providerInstanceId, selection.instanceId);
            assert.equal(child.model, selection.model);
            assert.deepEqual(yield* service.createThreads(scope, request), first);

            // The creation receipt exists, but this prompt has not been accepted yet.
            const withPrompt = {
              ...request,
              threads: [{ ...request.threads[0]!, prompt: "Start work." }],
            };
            const started = yield* service.createThreads(scope, withPrompt);
            assert.equal(started.threads[0]?.threadId, child.threadId);
            const before = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(before.runs[0]?.modelSelection, selection);
            assert.equal(before.messages.length, 1);
            const empty = yield* service.createThreads(scope, {
              ...request,
              clientRequestId: "empty",
            });
            const emojiAtLimit = yield* service.createThreads(scope, {
              threads: [{ ...request.threads[0]!, prompt: `${"a".repeat(76)}😀 and more work.` }],
              clientRequestId: "emoji-title",
            });
            const titled = yield* orchestrator.getThreadProjection(
              emojiAtLimit.threads[0]!.threadId,
            );
            assert.equal(titled.thread.title, `${"a".repeat(76)}...`);

            yield* settings.updateSettings({
              projectSettingsOverrides: {
                [projectId]: {
                  providerInstances: {
                    [codexInstanceId]: { enabled: false },
                    [altInstanceId]: { enabled: false },
                  },
                },
              },
            });
            assert.deepEqual(yield* service.createThreads(scope, withPrompt), started);
            const after = yield* orchestrator.getThreadProjection(child.threadId);
            assert.deepEqual(after.thread.modelSelection, selection);
            assert.deepEqual(after.runs, before.runs);
            assert.deepEqual(after.messages, before.messages);

            const freshError = yield* service
              .createThreads(scope, {
                ...request,
                clientRequestId: "fresh",
              })
              .pipe(Effect.flip);
            assert.equal(freshError.code, "provider_unavailable");
            const promptError = yield* service
              .createThreads(scope, {
                ...withPrompt,
                clientRequestId: "empty",
              })
              .pipe(Effect.flip);
            assert.equal(promptError.code, "invalid_request");
            assert.include(promptError.message, "disabled");
            const untouched = yield* orchestrator.getThreadProjection(empty.threads[0]!.threadId);
            assert.equal(untouched.messages.length, 0);
            assert.equal(untouched.runs.length, 0);
          }).pipe(Effect.provide(layerTest));
        }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
      ),
  );

  it.effect("re-probes an unavailable target once before refusing it", () =>
    Effect.gen(function* () {
      const claudeInstanceId = ProviderInstanceId.make("claudeAgent");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      const task = {
        id: taskId,
        threadId: parentThreadId,
        runId: parentRunId,
        parentNodeId,
        origin: "app_owned",
        createdBy: "agent",
        driver: claudeDriver,
        providerInstanceId: claudeInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Review the diff.",
        title: null,
        model: "claude-opus-5-5",
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
      };
      const healthy = providerSnapshot({
        instanceId: claudeInstanceId,
        driver: claudeDriver,
        model: "claude-opus-5-5",
      });
      const missingCli: ServerProvider = {
        ...healthy,
        installed: false,
        status: "error",
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      };
      const codex = providerSnapshot({
        instanceId: codexInstanceId,
        driver: ProviderDriverKind.make("codex"),
        model: "gpt-5.4",
      });
      // The cache still says the CLI is missing; a probe reports `cliInstalled`.
      let cliInstalled = false;
      const probes = yield* Ref.make(0);
      const dispatched = yield* Ref.make(0);
      const layerDependencies = Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          hasReceipt: () => Effect.succeed(false),
          assertProviderInstanceEnabled: () => Effect.void,
          getThreadRecords: (threadId) =>
            Effect.succeed(
              threadId === parentThreadId ? parentProjection([task]) : childProjection,
            ),
          dispatch: () =>
            Ref.update(dispatched, (count) => count + 1).pipe(
              Effect.as({
                sequence: 1,
                storedEvents: [
                  {
                    sequence: 1,
                    commandId: null,
                    event: { type: "subagent.updated", payload: task },
                  },
                ],
              } as never),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([codex, missingCli]),
          refreshInstance: () =>
            Ref.update(probes, (count) => count + 1).pipe(
              Effect.as([codex, cliInstalled ? healthy : missingCli]),
            ),
        }),
        adapterRegistryLayer([codexInstanceId, claudeInstanceId]),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
      );

      yield* Effect.gen(function* () {
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        const delegate = (clientRequestId: string) =>
          service.delegateTask(scope, {
            task: "Review the diff.",
            target: { providerInstanceId: claudeInstanceId, model: "claude-opus-5-5" },
            mode: "async",
            clientRequestId,
          });

        const error = yield* delegate("delegate-recheck-1").pipe(Effect.flip);
        assert.equal(error.code, "provider_unavailable");
        assert.equal(yield* Ref.get(probes), 1);
        assert.equal(yield* Ref.get(dispatched), 0);

        cliInstalled = true;
        const result = yield* delegate("delegate-recheck-2");
        assert.equal(result.providerInstanceId, claudeInstanceId);
        assert.equal(yield* Ref.get(probes), 2);
        assert.equal(yield* Ref.get(dispatched), 1);
      }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
    }),
  );

  it.effect(
    "inherits an available parent instance for driver-only targets and otherwise selects a healthy peer",
    () =>
      Effect.gen(function* () {
        const codexAltInstanceId = ProviderInstanceId.make("codex-alt");
        const driver = ProviderDriverKind.make("codex");
        const claudeDriver = ProviderDriverKind.make("claudeAgent");
        const parentModelSelection = {
          instanceId: codexInstanceId,
          model: "gpt-5.4",
          options: [{ id: "reasoningEffort", value: "high" }],
        } as const;
        const task = {
          id: taskId,
          threadId: parentThreadId,
          runId: parentRunId,
          parentNodeId,
          origin: "app_owned",
          createdBy: "agent",
          driver,
          providerInstanceId: codexInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef: null,
          prompt: "Summarize the diff.",
          title: null,
          model: "gpt-5.4",
          status: "running",
          result: null,
          startedAt: null,
          completedAt: null,
        };
        const cases = [
          {
            name: "healthy-inherited",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexInstanceId,
            candidateDriver: driver,
          },
          {
            name: "unavailable-inherited-falls-back-to-healthy-peer",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
          {
            name: "no-available-peer",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "cross-driver-no-available-candidate",
            inheritedEnabled: false,
            peerEnabled: false,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: claudeDriver,
          },
          {
            name: "explicit-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "inherited-unavailable",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: false,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-disabled-without-adapter",
            inheritedEnabled: false,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: null,
            candidateDriver: driver,
          },
          {
            name: "explicit-healthy",
            inheritedEnabled: true,
            peerEnabled: true,
            explicit: true,
            selectedInstanceId: codexAltInstanceId,
            candidateDriver: driver,
          },
        ] as const;

        for (const testCase of cases) {
          const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
          let delegated = false;
          const layerDependencies = Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              hasReceipt: () => Effect.succeed(false),
              assertProviderInstanceEnabled: () => Effect.void,
              isProviderInstanceEnabledForProject: () => Effect.succeed(true),
              getThreadRecords: (threadId) =>
                Effect.succeed(
                  threadId === parentThreadId
                    ? parentProjection(delegated ? [task] : [], parentModelSelection)
                    : childProjection,
                ),
              dispatch: (command) =>
                Ref.update(dispatched, (commands) => [...commands, command]).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delegated = true;
                    }),
                  ),
                  Effect.as({
                    sequence: 1,
                    storedEvents: [
                      {
                        sequence: 1,
                        commandId: null,
                        event: { type: "subagent.updated", payload: task },
                      },
                    ],
                  } as never),
                ),
            }),
            ServerSettings.layerTest(),
            providerRegistryLayer([
              providerSnapshot({
                instanceId: codexInstanceId,
                driver,
                model: "gpt-5.4",
                enabled: testCase.inheritedEnabled,
              }),
              providerSnapshot({
                instanceId: codexAltInstanceId,
                driver: testCase.candidateDriver,
                model: "codex-alt-model",
                enabled: testCase.peerEnabled,
              }),
            ]),
            adapterRegistryLayer(
              testCase.name === "explicit-disabled-without-adapter"
                ? [codexAltInstanceId]
                : [codexInstanceId, codexAltInstanceId],
            ),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
          );

          yield* Effect.gen(function* () {
            const service = yield* OrchestratorMcpService.OrchestratorMcpService;
            const target =
              testCase.name === "inherited-unavailable"
                ? undefined
                : testCase.explicit
                  ? ({
                      providerInstanceId:
                        testCase.selectedInstanceId === null
                          ? codexInstanceId
                          : testCase.selectedInstanceId,
                    } as const)
                  : ({ driverKind: testCase.candidateDriver } as const);
            if (testCase.selectedInstanceId === null) {
              const error = yield* service
                .delegateTask(scope, {
                  task: "Summarize the diff.",
                  target,
                  mode: "async",
                  clientRequestId: `delegate-select-${testCase.name}`,
                })
                .pipe(Effect.flip);
              assert.equal(error.code, "provider_unavailable", testCase.name);
              if (
                testCase.name === "explicit-unavailable" ||
                testCase.name === "inherited-unavailable" ||
                testCase.name === "explicit-disabled-without-adapter"
              ) {
                const expectedMessage =
                  `Provider ${codexInstanceId} cannot run a child task: ` +
                  (testCase.name === "explicit-disabled-without-adapter"
                    ? "No V2 provider adapter is registered. "
                    : "") +
                  "Provider instance is disabled.";
                assert.equal(error.message, expectedMessage);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `disabled-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(threadError.code, "provider_unavailable");
                assert.equal(threadError.message, expectedMessage);
              }
              if (testCase.name === "cross-driver-no-available-candidate") {
                assert.isTrue(error.message.includes("driver claudeAgent"), testCase.name);
                const threadError = yield* service
                  .createThreads(scope, {
                    threads: [{ prompt: "Summarize the diff.", target }],
                    clientRequestId: `delegate-threads-${testCase.name}`,
                  })
                  .pipe(Effect.flip);
                assert.equal(
                  threadError.code,
                  "provider_unavailable",
                  `${testCase.name}-createThreads`,
                );
                assert.isTrue(
                  threadError.message.includes("driver claudeAgent"),
                  `${testCase.name}-createThreads`,
                );
              }
              assert.deepEqual(yield* Ref.get(dispatched), [], testCase.name);
              return;
            }
            const result = yield* service.delegateTask(scope, {
              task: "Summarize the diff.",
              target,
              mode: "async",
              clientRequestId: `delegate-select-${testCase.name}`,
            });
            assert.equal(result.status, "running", testCase.name);
            const commands = yield* Ref.get(dispatched);
            assert.equal(commands.length, 1, testCase.name);
            const request = commands[0] as {
              type: string;
              modelSelection: {
                instanceId: string;
                model: string;
                options?: ReadonlyArray<{ id: string; value: unknown }>;
              };
            };
            assert.equal(request.type, "delegated_task.request", testCase.name);
            assert.equal(
              request.modelSelection.instanceId,
              testCase.selectedInstanceId,
              testCase.name,
            );
            if (testCase.name === "healthy-inherited") {
              assert.deepEqual(request.modelSelection, parentModelSelection, testCase.name);
            } else {
              assert.equal(request.modelSelection.model, "codex-alt-model", testCase.name);
            }
          }).pipe(Effect.provide(layerOrchestratorService.pipe(Layer.provide(layerDependencies))));
        }
      }),
  );

  describe("scheduled tasks at modes above the caller's", () => {
    const projectId = ProjectId.make("project:scheduled");
    const boundThreadId = ThreadId.make("thread:scheduled-bound");
    const task = (overrides: Partial<ScheduledTask>): ScheduledTask => ({
      id: ScheduledTaskId.make("scheduled-task:webhook"),
      title: "On push",
      prompt: "Do {{body.instruction}}",
      enabled: true,
      schedule: { type: "webhook", signature: null },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
      webhook: {
        path: "/hooks/scheduled-task/secret",
        url: "https://t3.example/hooks/secret",
        hasSecret: false,
      },
      ...overrides,
    });
    const supervisedClient: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled"),
      requestNamespace: "client:scheduled",
      thread: undefined,
      client: {
        sessionId: "scheduled",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      tasks: ReadonlyArray<ScheduledTask>,
      boundThread: OrchestrationV2ThreadShell | null,
      upserted: Ref.Ref<number>,
    ) =>
      layerOrchestratorService.pipe(
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadShell: (threadId) =>
                Effect.succeed(threadId === boundThreadId ? boundThread : null),
            }),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({}),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks }),
              upsert: () =>
                Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: tasks[0]! })),
            }),
          ),
        ),
      );

    // Ours: scheduled (and isolated delegated) work in a Caveman Code project would be invisible to it.
    it.effect("refuses to schedule work in a Caveman Code project", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const failed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.scheduleTask(supervisedClient, {
              projectId: projectIdFor("/repo/caveman"),
              prompt: "check in later",
              schedule: { type: "interval", everyMs: 3_600_000 },
            }),
          ),
          Effect.flip,
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({
                    getById: (id) =>
                      Effect.succeed(Option.some({ id, workspaceRoot: "/repo/caveman" } as never)),
                  }),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: task({}) })),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(failed.code, "invalid_request");
        assert.include(failed.message, "Caveman Code");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("hides a webhook URL from a caller below the task's modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) => mcp.listScheduledTasks(supervisedClient, { projectId })),
          Effect.provide(
            service(
              [
                task({ runtimeMode: "full-access" }),
                task({ id: ScheduledTaskId.make("scheduled-task:supervised") }),
              ],
              null,
              upserted,
            ),
          ),
        );
        assert.deepEqual(
          listed.tasks.map((summary) => summary.webhookUrl),
          [undefined, "https://t3.example/hooks/secret"],
        );
      }),
    );

    it.effect("hides a webhook URL from a thread whose turn has ended", () =>
      Effect.gen(function* () {
        const callerId = ThreadId.make("thread:scheduled-ended");
        const shell = liveThreadShell(callerId, { activeRunId: null });
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                requestNamespace: "provider:scheduled-ended",
                thread: {
                  threadId: callerId,
                  providerSessionId: "provider:scheduled-ended",
                  providerInstanceId: shell.providerInstanceId,
                },
                client: undefined,
              },
              { projectId },
            ),
          ),
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: () => Effect.succeed(null),
                    // Its turn ended: no run is active.
                    getThreadRecords: () => Effect.succeed(idleThreadProjection(shell)),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [task({})] }),
                  }),
                ),
              ),
            ),
          ),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("never shows a read-only client a webhook URL", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const listed = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.flatMap((mcp) =>
            mcp.listScheduledTasks(
              {
                ...supervisedClient,
                client: { sessionId: "scheduled", label: "Claude Code", access: "read-only" },
              },
              { projectId },
            ),
          ),
          Effect.provide(service([task({})], null, upserted)),
        );
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
      }),
    );

    it.effect("checks a bound task against its thread's current modes", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        // Scheduled while the thread was Supervised; the thread now runs in full access.
        const bound = task({ threadId: boundThreadId });
        const layer = service(
          [bound],
          liveThreadShell(boundThreadId, { runtimeMode: "full-access" }),
          upserted,
        );
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(layer),
        );
        const listed = yield* mcp.listScheduledTasks(supervisedClient, { projectId });
        assert.equal(listed.tasks[0]?.webhookUrl, undefined);
        const error = yield* mcp
          .updateScheduledTask(supervisedClient, {
            scheduledTaskId: bound.id,
            prompt: "Something else",
          })
          .pipe(Effect.flip);
        assert.equal(error.code, "runtime_mode_escalation_denied");
        assert.equal(yield* Ref.get(upserted), 0);
      }),
    );

    it.effect("reports a saved task even when its bound thread cannot be read", () =>
      Effect.gen(function* () {
        const upserted = yield* Ref.make(0);
        const bound = task({ threadId: boundThreadId });
        const lookups = yield* Ref.make(0);
        // The edit's own check reads the thread; the read after the save fails.
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            layerOrchestratorService.pipe(
              Layer.provide(
                Layer.mergeAll(
                  NodeServices.layer,
                  NodeCrypto.layer,
                  Layer.mock(ThreadManagementService.ThreadManagementService)({
                    getThreadShell: (threadId) =>
                      Ref.getAndUpdate(lookups, (count) => count + 1).pipe(
                        Effect.flatMap((count) =>
                          count === 0
                            ? Effect.succeed(
                                liveThreadShell(threadId, { runtimeMode: "approval-required" }),
                              )
                            : Effect.fail(new OrchestratorProjectionError({ threadId })),
                        ),
                      ),
                  }),
                  ServerSettings.layerTest(),
                  Layer.mock(ProviderRegistry.ProviderRegistry)({
                    getProviders: Effect.succeed([]),
                  }),
                  Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
                    list: () => Effect.succeed([]),
                  }),
                  Layer.mock(ProjectService.ProjectService)({}),
                  Layer.mock(SecretRequests.SecretRequests)({}),
                  Layer.mock(ScheduledTaskService.ScheduledTaskService)({
                    list: () => Effect.succeed({ tasks: [bound] }),
                    upsert: () =>
                      Ref.update(upserted, (count) => count + 1).pipe(Effect.as({ task: bound })),
                  }),
                ),
              ),
            ),
          ),
        );
        const updated = yield* mcp.updateScheduledTask(supervisedClient, {
          scheduledTaskId: bound.id,
          prompt: "Something else",
        });
        assert.equal(yield* Ref.get(upserted), 1);
        assert.equal(updated.scheduledTaskId, bound.id);
        assert.equal(updated.webhookUrl, undefined);
      }),
    );
  });

  describe("resolveRuntimeMode", () => {
    // Muse offers only these two, and runs any other mode as Supervised.
    const muse = {
      modelSelection: { instanceId: ProviderInstanceId.make("muse"), model: "muse-model" },
      supportedRuntimeModes: ["approval-required", "full-access"] as const,
    };

    it.effect("refuses an explicit mode the target provider does not offer", () =>
      Effect.gen(function* () {
        const error = yield* OrchestratorMcpService.resolveRuntimeMode(
          "full-access",
          "auto-accept-edits",
          muse,
        ).pipe(Effect.flip);
        assert.equal(error.code, "invalid_request");
        assert.include(error.message, "approval-required, full-access");
      }),
    );

    it.effect("steps an inherited mode down to the broadest one the provider offers", () =>
      Effect.gen(function* () {
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("full-access", "inherit", muse),
          "full-access",
        );
        assert.equal(
          yield* OrchestratorMcpService.resolveRuntimeMode("auto", undefined, muse),
          "approval-required",
        );
      }),
    );
  });
});

describe("OrchestratorMcpService thread lookup", () => {
  const bareId = ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  const launched = liveThreadShell(ThreadId.make(`mcp:${bareId}`));
  const deletedLaunched = { ...launched, deletedAt: DateTime.makeUnsafe("2026-10-05T00:00:00Z") };
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-lookup"),
    requestNamespace: "client:thread-lookup",
    thread: undefined,
    client: { sessionId: "thread-lookup", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const service = (shells: ReadonlyArray<OrchestrationV2ThreadShell>, sent: Ref.Ref<number>) =>
    layerOrchestratorService.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (threadId) =>
              Effect.succeed(shells.find((shell) => shell.id === threadId) ?? null),
            sendToThread: () => Ref.update(sent, (count) => count + 1).pipe(Effect.as({} as never)),
          }),
          ServerSettings.layerTest(),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
            list: () => Effect.succeed([]),
          }),
          Layer.mock(ProjectService.ProjectService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
        ),
      ),
    );
  const failuresFor = (shells: ReadonlyArray<OrchestrationV2ThreadShell>) =>
    Effect.gen(function* () {
      const sent = yield* Ref.make(0);
      return yield* Effect.gen(function* () {
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
        const read = yield* mcp.readThread(client, { threadId: bareId }).pipe(Effect.flip);
        const send = yield* mcp
          .sendToThread(client, { threadId: bareId, message: "hello" })
          .pipe(Effect.flip);
        return { read, send, sends: yield* Ref.get(sent) };
      }).pipe(Effect.provide(service(shells, sent)));
    });

  it.effect("points a bare uuid at the mcp: thread it belongs to", () =>
    Effect.gen(function* () {
      const { read, send, sends } = yield* failuresFor([launched]);
      for (const error of [read, send]) {
        assert.equal(error.code, "thread_not_found");
        assert.include(error.message, `mcp:${bareId}`);
      }
      assert.equal(sends, 0);
    }),
  );

  it.effect("keeps the plain message for an id that matches nothing", () =>
    Effect.gen(function* () {
      const { read, send } = yield* failuresFor([]);
      assert.equal(read.code, "thread_not_found");
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.code, "thread_not_found");
      assert.equal(send.message, `Thread ${bareId} was not found.`);
    }),
  );

  it.effect("does not name an mcp: thread that was deleted", () =>
    Effect.gen(function* () {
      const { read, send } = yield* failuresFor([deletedLaunched]);
      assert.equal(read.message, `Thread ${bareId} is no longer available.`);
      assert.equal(send.message, `Thread ${bareId} was not found.`);
    }),
  );
});

describe("OrchestratorMcpService thread list", () => {
  const client: McpInvocationScope = {
    environmentId: EnvironmentId.make("environment:thread-list"),
    requestNamespace: "client:thread-list",
    thread: undefined,
    client: { sessionId: "thread-list", label: "Claude Code", access: "full-access" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 1,
  };
  const shell = (id: string, projectId: string, snoozed: boolean) => ({
    ...liveThreadShell(ThreadId.make(id)),
    projectId: ProjectId.make(projectId),
    status: "completed" as const,
    snoozedUntil: snoozed ? DateTime.makeUnsafe("2099-01-01T00:00:00Z") : null,
  });
  const shells = [
    shell("thread:a-snoozed", "project:a", true),
    shell("thread:a-awake", "project:a", false),
    shell("thread:b-snoozed", "project:b", true),
  ];
  const service = layerOrchestratorService.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          listProjectThreads: (input) =>
            Effect.succeed(
              shells.filter(
                (thread) => input.projectId === undefined || thread.projectId === input.projectId,
              ),
            ),
        }),
        ServerSettings.layerTest(),
        Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
        Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
          list: () => Effect.succeed([]),
        }),
        Layer.mock(ProjectService.ProjectService)({}),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({}),
      ),
    ),
  );

  it.effect("lists snoozed threads across every project with allProjects", () =>
    Effect.gen(function* () {
      const mcp = yield* OrchestratorMcpService.OrchestratorMcpService;
      const listed = yield* mcp.listThreads(client, {
        allProjects: true,
        projectId: ProjectId.make("project:a"),
        snoozed: true,
      });
      assert.equal(listed.projectId, null);
      assert.deepStrictEqual(
        listed.threads.map((thread) => [thread.threadId, thread.projectId]),
        [
          ["thread:a-snoozed", "project:a"],
          ["thread:b-snoozed", "project:b"],
        ],
      );
    }).pipe(Effect.provide(service)),
  );
});

describe("OrchestratorMcpService scheduled tasks", () => {
  describe("the base branch of an unbound scheduled task", () => {
    const projectId = ProjectId.make("project:scheduled-base");
    const workspaceRoot = "/repo/scheduled-base";
    const existing: ScheduledTask = {
      id: ScheduledTaskId.make("scheduled-task:base"),
      title: "Nightly",
      prompt: "Check the build",
      enabled: true,
      schedule: { type: "interval", everyMs: 3_600_000 },
      projectId,
      threadId: null,
      workspaceStrategy: { type: "root" },
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: "2026-10-05T00:00:00.000Z",
      updatedAt: "2026-10-05T00:00:00.000Z",
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "never",
      lastRunError: null,
      runCount: 0,
    };
    const client: McpInvocationScope = {
      environmentId: EnvironmentId.make("environment:scheduled-base"),
      requestNamespace: "client:scheduled-base",
      thread: undefined,
      client: {
        sessionId: "scheduled-base",
        label: "Claude Code",
        access: "approval-required",
      },
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
    };
    const service = (
      git: Partial<GitVcsDriver.GitVcsDriver["Service"]>,
      saved: Ref.Ref<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>,
    ) =>
      OrchestratorMcpService.layer.pipe(
        Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)(git)),
        Layer.provide(
          Layer.mergeAll(
            NodeServices.layer,
            NodeCrypto.layer,
            Layer.mock(ThreadManagementService.ThreadManagementService)({}),
            ServerSettings.layerTest(),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
              list: () => Effect.succeed([]),
            }),
            Layer.mock(ProjectService.ProjectService)({
              getById: () =>
                Effect.succeedSome({
                  id: projectId,
                  workspaceRoot,
                  defaultModelSelection: existing.modelSelection,
                } as never),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ScheduledTaskService.ScheduledTaskService)({
              list: () => Effect.succeed({ tasks: [existing] }),
              upsert: (input) =>
                Ref.update(saved, (strategies) => [...strategies, input.workspaceStrategy]).pipe(
                  Effect.as({ task: existing }),
                ),
            }),
          ),
        ),
      );
    const masterRepository: Partial<GitVcsDriver.GitVcsDriver["Service"]> = {
      resolvePrimaryRemoteName: () => Effect.succeed("origin"),
      resolveDefaultBranchName: (cwd, remoteName) =>
        Effect.succeed(cwd === workspaceRoot && remoteName === "origin" ? "master" : null),
      resolveCommit: () => Effect.succeed({ commitSha: "abc123" }),
    };
    const schedule = { type: "interval", everyMs: 3_600_000 } as const;

    it.effect("starts from the project's default branch", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect("follows the default branch when a task is unbound from its thread", () =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(service(masterRepository, saved)),
        );
        yield* mcp.updateScheduledTask(client, {
          scheduledTaskId: existing.id,
          bindToCurrentThread: false,
        });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef: "origin/master", startFromOrigin: true },
        ]);
      }),
    );

    it.effect.each([
      {
        name: "no remote, only master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master"],
        baseRef: "master",
      },
      {
        name: "no remote, main and master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/heads/main"],
        baseRef: "main",
      },
      {
        name: "no remote, neither main nor master",
        remote: null,
        remoteDefault: null,
        refs: ["refs/heads/develop"],
        baseRef: "main",
      },
      {
        name: "no recorded HEAD, remote main and a stale local master",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/master", "refs/remotes/origin/main"],
        baseRef: "origin/main",
      },
      {
        name: "no recorded HEAD, master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, local main and master only on the remote",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "no recorded HEAD, nothing conventional on the remote, local main",
        remote: "origin",
        remoteDefault: null,
        refs: ["refs/heads/main", "refs/remotes/origin/develop"],
        baseRef: "main",
      },
      {
        name: "a recorded HEAD whose branch is gone",
        remote: "origin",
        remoteDefault: "main",
        refs: ["refs/heads/main", "refs/remotes/origin/master"],
        baseRef: "origin/master",
      },
      {
        name: "a remote not called origin",
        remote: "upstream",
        remoteDefault: "develop",
        refs: ["refs/remotes/upstream/develop"],
        baseRef: "upstream/develop",
      },
      {
        name: "a remote not called origin, no recorded HEAD",
        remote: "upstream",
        remoteDefault: null,
        refs: ["refs/remotes/upstream/main"],
        baseRef: "upstream/main",
      },
    ])("$name starts from $baseRef", ({ remote, remoteDefault, refs, baseRef }) =>
      Effect.gen(function* () {
        const saved = yield* Ref.make<ReadonlyArray<ScheduledTask["workspaceStrategy"]>>([]);
        const gitFailure = (cwd: string, detail: string) =>
          new GitCommandError({ operation: "GitVcsDriver.test", command: "git", cwd, detail });
        const mcp = yield* OrchestratorMcpService.OrchestratorMcpService.pipe(
          Effect.provide(
            service(
              {
                resolvePrimaryRemoteName: (cwd) =>
                  remote === null
                    ? Effect.fail(gitFailure(cwd, "No git remote is configured."))
                    : Effect.succeed(remote),
                resolveDefaultBranchName: () => Effect.succeed(remoteDefault),
                resolveCommit: ({ cwd, revision }) =>
                  refs.includes(revision)
                    ? Effect.succeed({ commitSha: "abc123" })
                    : Effect.fail(gitFailure(cwd, "Needed a single revision")),
              },
              saved,
            ),
          ),
        );
        yield* mcp.scheduleTask(client, { projectId, prompt: "Check the build", schedule });
        assert.deepEqual(yield* Ref.get(saved), [
          { type: "worktree", baseRef, startFromOrigin: true },
        ]);
      }),
    );
  });
});
