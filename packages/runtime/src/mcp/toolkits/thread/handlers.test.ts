import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../../../orchestration-v2/ThreadSearch.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import {
  AUTOMATION_STEP_STARTS_NO_THREADS,
  DELEGATED_AGENT_STARTS_NO_THREADS,
} from "../../delegationPolicy.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";

const leadId = ThreadId.make("thread:lead");
const delegatedId = ThreadId.make("thread:delegated");
const stepId = ThreadId.make("automation:r_1.build.1");
const shells = new Map([
  [leadId, liveThreadShell(leadId)],
  [
    delegatedId,
    {
      // Full access by inheritance from its lead, mid-run.
      ...liveThreadShell(delegatedId),
      lineage: {
        rootThreadId: leadId,
        parentThreadId: leadId,
        relationshipToParent: "subagent" as const,
      },
    },
  ],
  [stepId, liveThreadShell(stepId)],
]);

const callerScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    ...(threadId === delegatedId ? { subagent: true } : {}),
  },
  client: undefined,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "thread-handlers-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "thread-handlers-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// Effect returns a declared tool failure as `isError` with its encoded payload as JSON text.
const declaredFailure = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

const scheduledTask = (id: string) =>
  ({
    id,
    title: id,
    prompt: "Check the build",
    enabled: true,
    projectId: "project:mcp-test",
    threadId: null,
    schedule: { type: "interval", everyMs: 3_600_000 },
    workspaceStrategy: { type: "worktree", baseRef: "main", startFromOrigin: true },
    modelSelection: { instanceId: "codex", model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    nextRunAt: null,
    lastRunStatus: "never",
    lastRunAt: null,
    lastRunThreadId: null,
    lastRunError: null,
    runCount: 0,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  }) as never;

const makeHarness = () => {
  const dispatched: Array<string> = [];
  const ranTasks: Array<string> = [];
  const layer = McpHttpServer.layerThreadToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
    Layer.provide(
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.succeed({ tasks: [scheduledTask("task-nightly")] }),
        runNow: (input) =>
          Effect.sync(() => {
            ranTasks.push(input.id);
            return {
              task: scheduledTask(input.id),
              threadId: ThreadId.make("thread:scheduled-run"),
            };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed(idleThreadProjection(shells.get(threadId)!) as never),
        dispatch: (command) =>
          Effect.sync(() => {
            dispatched.push(command.type);
            return { sequence: 1, storedEvents: [] };
          }),
      }),
    ),
  );
  const call = (name: string, args: Record<string, unknown>, caller: ThreadId) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(caller)),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    );
  return { dispatched, ranTasks, layer, call };
};

it.effect(
  "a delegated agent cannot fork a chat, which would start a thread outside its tree's limits",
  () => {
    const { dispatched, layer, call } = makeHarness();
    return Effect.gen(function* () {
      const byLead = yield* call("thread_transfer", { action: "fork", threadId: leadId }, leadId);
      expect(byLead.isError).toBe(false);
      expect(dispatched).toEqual(["thread.fork"]);

      dispatched.length = 0;
      const byDelegate = yield* call(
        "thread_transfer",
        { action: "fork", threadId: leadId },
        delegatedId,
      );
      expect({ failure: declaredFailure(byDelegate), dispatched }).toEqual({
        failure: expect.objectContaining({
          code: "capability_denied",
          message: DELEGATED_AGENT_STARTS_NO_THREADS,
        }),
        dispatched: [],
      });

      // Merging back starts no thread, so a delegated agent still may.
      const mergedBack = yield* call(
        "thread_transfer",
        { action: "merge_back", threadId: delegatedId, targetThreadId: leadId },
        delegatedId,
      );
      expect(mergedBack.isError).toBe(false);
      expect(dispatched).toEqual(["thread.merge_back"]);
    }).pipe(Effect.provide(layer));
  },
);

it.effect(
  "an automation step cannot fork a chat, which would start a thread outside its run",
  () => {
    const { dispatched, layer, call } = makeHarness();
    return Effect.gen(function* () {
      const byStep = yield* call("thread_transfer", { action: "fork" }, stepId);
      expect({ failure: declaredFailure(byStep), dispatched }).toEqual({
        failure: expect.objectContaining({
          code: "capability_denied",
          message: AUTOMATION_STEP_STARTS_NO_THREADS,
        }),
        dispatched: [],
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("a full-access delegated agent cannot run a scheduled task now", () => {
  const { ranTasks, layer, call } = makeHarness();
  return Effect.gen(function* () {
    const byLead = yield* call("run_scheduled_task_now", { taskId: "task-nightly" }, leadId);
    expect(byLead.isError).toBe(false);
    expect(ranTasks).toEqual(["task-nightly"]);

    ranTasks.length = 0;
    const byDelegate = yield* call(
      "run_scheduled_task_now",
      { taskId: "task-nightly" },
      delegatedId,
    );
    expect({ failure: declaredFailure(byDelegate), ranTasks }).toEqual({
      failure: expect.objectContaining({
        code: "capability_denied",
        message: DELEGATED_AGENT_STARTS_NO_THREADS,
      }),
      ranTasks: [],
    });
  }).pipe(Effect.provide(layer));
});
