import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ProviderAdapterRegistry from "../../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
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
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "orchestrator-handlers-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "orchestrator-handlers-test", version: "1" },
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
    enabled: false,
    projectId: "project:mcp-test",
    threadId: null,
    schedule: { type: "interval", everyMs: 86_400_000 },
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
  const saved: Array<{ readonly id: string | undefined; readonly prompt: string }> = [];
  const layer = McpHttpServer.layerOrchestratorToolkit.pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(Layer.mock(ProviderRegistry.ProviderRegistry)({})),
    Layer.provide(Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({})),
    Layer.provide(Layer.mock(ProjectService.ProjectService)({})),
    Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
    Layer.provide(
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.succeed({ tasks: [scheduledTask("task-nightly")] }),
        upsert: (input) =>
          Effect.sync(() => {
            saved.push({ id: input.id, prompt: input.prompt });
            return {
              task: { ...(scheduledTask(input.id ?? "task-new") as object), ...input },
            } as never;
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
        getThreadRecords: (id) => Effect.succeed(idleThreadProjection(shells.get(id)!) as never),
      }),
    ),
  );
  const call = (name: string, args: Record<string, unknown>, caller: ThreadId) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: args })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, callerScope(caller)),
      Effect.provideService(McpSchema.McpServerClient, mcpClient),
    );
  return { saved, layer, call };
};

// Each update would make the paused task run every minute as a fresh root, outside the caller's tree or run.
const rearm = {
  scheduledTaskId: "task-nightly",
  prompt: "Run the deploy script",
  schedule: { type: "interval", everyMs: 60_000 },
  enabled: true,
};

it.effect(
  "a delegated agent cannot rearm a scheduled task to start chats outside its tree's limits",
  () => {
    const { saved, layer, call } = makeHarness();
    return Effect.gen(function* () {
      const byLead = yield* call("schedule_task", rearm, leadId);
      expect(byLead.isError).toBe(false);
      expect(saved).toEqual([{ id: "task-nightly", prompt: "Run the deploy script" }]);

      saved.length = 0;
      const byDelegate = yield* call("schedule_task", rearm, delegatedId);
      expect({ failure: declaredFailure(byDelegate), saved }).toEqual({
        failure: expect.objectContaining({
          code: "capability_denied",
          message: DELEGATED_AGENT_STARTS_NO_THREADS,
        }),
        saved: [],
      });
    }).pipe(Effect.provide(layer));
  },
);

it.effect("an automation step cannot rearm a scheduled task to start chats outside its run", () => {
  const { saved, layer, call } = makeHarness();
  return Effect.gen(function* () {
    const byStep = yield* call("schedule_task", { ...rearm, bindToCurrentThread: true }, stepId);
    expect({ failure: declaredFailure(byStep), saved }).toEqual({
      failure: expect.objectContaining({
        code: "capability_denied",
        message: AUTOMATION_STEP_STARTS_NO_THREADS,
      }),
      saved: [],
    });
  }).pipe(Effect.provide(layer));
});
