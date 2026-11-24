// ), apps/server/src/mcp/McpToolAccess.test.ts @ ab3a3cd1.
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ProviderInteractionMode,
  RuntimeMode,
  ThreadId,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";

const supervisedThreadId = ThreadId.make("thread:supervised");
const grillThreadId = ThreadId.make("thread:grill");
const fullAccessThreadId = ThreadId.make("thread:full-access");
const endedThreadId = ThreadId.make("thread:ended");
const delegatedThreadId = ThreadId.make("thread:delegated");
const backgroundThreadId = ThreadId.make("thread:background");
const oldProviderThreadId = ThreadId.make("thread:old-provider-background");
const archivedThreadId = ThreadId.make("thread:archived-background");
const unknownOwnerThreadId = ThreadId.make("thread:unknown-background-owner");
const automationStepThreadId = ThreadId.make("automation:r_1.build.1");
const automationDelegateThreadId = ThreadId.make("thread:automation-delegate");
const automationForkThreadId = ThreadId.make("thread:automation-fork");
const automationDelegateForkThreadId = ThreadId.make("thread:automation-delegate-fork");

const backgroundShell = (threadId: ThreadId, providerInstanceId: ProviderInstanceId) => ({
  ...liveThreadShell(threadId, { activeRunId: null }),
  pendingBackgroundTasks: [
    { taskId: "task:background", kind: "subagent" as const, providerInstanceId },
  ],
});

const shells = new Map([
  [supervisedThreadId, liveThreadShell(supervisedThreadId, { runtimeMode: "approval-required" })],
  [
    grillThreadId,
    liveThreadShell(grillThreadId, { runtimeMode: "approval-required", interactionMode: "grill" }),
  ],
  [fullAccessThreadId, liveThreadShell(fullAccessThreadId)],
  [endedThreadId, liveThreadShell(endedThreadId, { activeRunId: null })],
  [
    delegatedThreadId,
    {
      ...liveThreadShell(delegatedThreadId),
      lineage: { rootThreadId: fullAccessThreadId, parentThreadId: fullAccessThreadId, relationshipToParent: "subagent" as const },
    },
  ],
  [backgroundThreadId, backgroundShell(backgroundThreadId, ProviderInstanceId.make("codex"))],
  // An automation run's step thread (full access, top level), an agent it delegated, and forks of each sharing its
  // root: the step's and the person's.
  [automationStepThreadId, liveThreadShell(automationStepThreadId)],
  [
    automationDelegateThreadId,
    {
      ...liveThreadShell(automationDelegateThreadId),
      creationSource: "mcp" as const,
      lineage: { rootThreadId: automationStepThreadId, parentThreadId: automationStepThreadId, relationshipToParent: "subagent" as const },
    },
  ],
  [
    automationForkThreadId,
    {
      ...liveThreadShell(automationForkThreadId),
      lineage: { rootThreadId: automationStepThreadId, parentThreadId: automationStepThreadId, relationshipToParent: "fork" as const },
    },
  ],
  [
    automationDelegateForkThreadId,
    {
      ...liveThreadShell(automationDelegateForkThreadId),
      creationSource: "mcp" as const,
      lineage: { rootThreadId: automationStepThreadId, parentThreadId: automationDelegateThreadId, relationshipToParent: "fork" as const },
    },
  ],
  [oldProviderThreadId, backgroundShell(oldProviderThreadId, ProviderInstanceId.make("claude"))],
  [
    archivedThreadId,
    {
      ...backgroundShell(archivedThreadId, ProviderInstanceId.make("codex")),
      archivedAt: liveThreadShell(archivedThreadId).updatedAt,
    },
  ],
  [
    unknownOwnerThreadId,
    {
      ...liveThreadShell(unknownOwnerThreadId, { activeRunId: null }),
      pendingBackgroundTasks: [{ taskId: "task:unknown", kind: "subagent" as const }],
    },
  ],
]);

const threadCaller = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const clientCaller = (
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

// One tool per declaration, each answering with the modes it was handed, so
// the table below reads what the gate let through.
const probe = {
  success: Schema.Struct({ ran: Schema.String }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const ProbeToolkit = Toolkit.make(
  Tool.make("reads", probe),
  Tool.make("reads_as_caller", probe),
  Tool.make("acts_as_caller", probe),
  Tool.make("writes", probe),
  Tool.make("writes_with_capability", probe),
  Tool.make("writes_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("messages_thread", { ...probe, parameters: Schema.Struct({ threadId: ThreadId }) }),
  Tool.make("forks_threads", {
    ...probe,
    parameters: Schema.Struct({ threadId: Schema.optional(ThreadId) }),
  }),
  Tool.make("starts_threads", {
    ...probe,
    parameters: Schema.Struct({
      runtimeMode: Schema.optional(RuntimeMode),
      interactionMode: Schema.optional(ProviderInteractionMode),
    }),
  }),
  Tool.make("writes_environment", probe),
);
const ran = Effect.succeed({ ran: "ran" });
const probeHandlers: McpToolAccess.Handlers<typeof ProbeToolkit.tools> = {
  reads: McpToolAccess.reads(() => ran),
  reads_as_caller: McpToolAccess.readsAsCaller(() => ran),
  acts_as_caller: McpToolAccess.actsAsCaller(() => ran),
  writes: McpToolAccess.writes(() => ran),
  writes_with_capability: McpToolAccess.writesWithCapability(() => ran),
  writes_threads: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  messages_thread: McpToolAccess.messagesThread(
    (input) => input.threadId,
    () => ran,
  ),
  forks_threads: McpToolAccess.forksThreads(
    (input) => [input.threadId],
    () => ran,
  ),
  starts_threads: McpToolAccess.startsThreads(
    (input) => input,
    (_, modes) => Effect.succeed({ ran: `${modes.runtimeMode}/${modes.interactionMode}` }),
  ),
  writes_environment: McpToolAccess.writesEnvironment(() => ran),
};
const layerProbeHandlers = McpToolAccess.toLayer(ProbeToolkit, probeHandlers);

const unchecked = () => ran;

// What the compiler refuses: each line below must fail to typecheck, and its
// `@ts-expect-error` fails the build if one ever compiles. Never called.
export const refusedAtCompileTime = () => {
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a handler that skips its declaration
    reads: unchecked,
  });
  McpToolAccess.toLayer(ProbeToolkit, {
    ...probeHandlers,
    // @ts-expect-error a declaration's fields copied onto an unchecked handler
    reads: Object.assign(
      unchecked,
      McpToolAccess.reads(() => ran),
    ),
  });
  // @ts-expect-error a declaration built outside McpToolAccess
  McpToolAccess.Declaration.make(unchecked);
  // @ts-expect-error a declaration constructed directly
  new McpToolAccess.Declaration(unchecked);
  // @ts-expect-error a handlers layer built outside McpToolAccess
  McpToolAccess.HandlersLayer.make(Layer.empty);
  // The refused layer below types its error and services as unknown, which is fine here.
  // @effect-diagnostics-next-line anyUnknownInErrorContext:off
  McpHttpServer.toolkitRegistration(
    ProbeToolkit,
    // @ts-expect-error a handlers layer that skipped `McpToolAccess.toLayer`
    ProbeToolkit.toLayer({
      reads: unchecked,
      reads_as_caller: unchecked,
      acts_as_caller: unchecked,
      writes: unchecked,
      writes_with_capability: unchecked,
      writes_threads: unchecked,
      messages_thread: unchecked,
      forks_threads: unchecked,
      starts_threads: unchecked,
      writes_environment: unchecked,
    }),
  );
};

const probeServer = (threads: Layer.Layer<ThreadManagement.ThreadManagementService>) =>
  McpHttpServer.toolkitRegistration(ProbeToolkit, layerProbeHandlers).pipe(
    Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
    Layer.provideMerge(threads),
  );

/** A probe's answer, or the gate's refusal, as the result's JSON text. */
const decodeOutcome = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([Schema.Struct({ ran: Schema.String }), Schema.Struct({ code: Schema.String })]),
  ),
);

const call = (
  tool: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name: tool, arguments: args })),
    Effect.flatMap(({ content }) =>
      decodeOutcome(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
    ),
    Effect.map((outcome) => ("code" in outcome ? outcome.code : outcome.ran)),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const supervised = threadCaller(supervisedThreadId);
const grill = threadCaller(grillThreadId);
const fullAccess = threadCaller(fullAccessThreadId);
const ended = threadCaller(endedThreadId);
// Its turn ended, but a background subagent it started still runs.
const background = threadCaller(backgroundThreadId);
const oldProviderBackground = threadCaller(oldProviderThreadId);
const archivedBackground = threadCaller(archivedThreadId);
const unknownOwnerBackground = threadCaller(unknownOwnerThreadId);
const mismatchedProvider = {
  ...background,
  thread: { ...background.thread!, providerInstanceId: ProviderInstanceId.make("claude") },
};
const supervisedClient = clientCaller("approval-required");
const fullAccessClient = clientCaller("full-access");
const readOnlyClient = clientCaller("read-only");
// A live full-access thread whose credential may use its browser but not control threads.
const previewOnly = { ...fullAccess, capabilities: new Set(["preview"] as const) };

it.effect.each([
  // Reads are open to every caller, even one whose turn ended.
  ["reads", ended, {}, "ran"],
  ["reads", supervisedClient, {}, "ran"],
  ["reads", readOnlyClient, {}, "ran"],

  // A client approved for read-only access changes nothing.
  ["writes", readOnlyClient, {}, "capability_denied"],
  ["writes_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["starts_threads", readOnlyClient, {}, "capability_denied"],
  ["writes_environment", readOnlyClient, {}, "capability_denied"],

  // What belongs to the calling thread needs one; changing it needs its live turn.
  ["reads_as_caller", ended, {}, "ran"],
  ["reads_as_caller", fullAccessClient, {}, "thread_credential_required"],
  ["acts_as_caller", supervised, {}, "ran"],
  ["acts_as_caller", ended, {}, "parent_not_active"],
  ["acts_as_caller", background, {}, "ran"],
  ["acts_as_caller", oldProviderBackground, {}, "parent_not_active"],
  ["acts_as_caller", mismatchedProvider, {}, "parent_not_active"],
  ["acts_as_caller", archivedBackground, {}, "parent_not_active"],
  ["acts_as_caller", unknownOwnerBackground, {}, "parent_not_active"],
  ["acts_as_caller", fullAccessClient, {}, "thread_credential_required"],

  // Any change needs a thread caller's live turn; a client has none to lose.
  ["writes", supervised, {}, "ran"],
  ["writes", ended, {}, "parent_not_active"],
  ["writes", background, {}, "ran"],
  ["writes", oldProviderBackground, {}, "parent_not_active"],
  ["writes", supervisedClient, {}, "ran"],
  // Uploads, scheduled tasks, projects and settings need a credential that controls threads.
  ["writes", previewOnly, {}, "capability_denied"],
  ["writes_environment", previewOnly, {}, "capability_denied"],

  // A tool's own capability stands in for thread control; the rest of a change still applies.
  ["writes_with_capability", previewOnly, {}, "ran"],
  ["writes_with_capability", readOnlyClient, {}, "capability_denied"],
  ["writes_with_capability", ended, {}, "parent_not_active"],

  // Changing a thread: only one that runs within the caller's modes.
  ["writes_threads", supervised, {}, "ran"],
  ["writes_threads", supervised, { threadId: grillThreadId }, "ran"],
  [
    "writes_threads",
    supervised,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  // Grill mode grants nothing beyond default, so a grill caller may change a default thread.
  ["writes_threads", grill, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", ended, { threadId: supervisedThreadId }, "parent_not_active"],
  ["writes_threads", supervisedClient, { threadId: supervisedThreadId }, "ran"],
  [
    "writes_threads",
    supervisedClient,
    { threadId: fullAccessThreadId },
    "runtime_mode_escalation_denied",
  ],
  // A thread that does not exist is the tool's to report.
  ["writes_threads", supervised, { threadId: "thread:missing" }, "ran"],

  // A message starts a turn in an idle thread, so it reaches only threads the caller may change.
  ["messages_thread", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["messages_thread", supervised, { threadId: fullAccessThreadId }, "runtime_mode_escalation_denied"],
  ["messages_thread", fullAccess, { threadId: automationStepThreadId }, "ran"],
  // An automation step messages only what its run pays for and stops: its own thread and the agents it delegated.
  // A turn anywhere else, here or on another computer, would escape the run's wallet and outlive the step.
  ["messages_thread", threadCaller(automationStepThreadId), { threadId: fullAccessThreadId }, "capability_denied"],
  ["messages_thread", threadCaller(automationStepThreadId), { threadId: "mac:ws-on-studio" }, "capability_denied"],
  // Its own builder on a Cloud computer included: the run neither pays for nor stops it, and its answer still comes back.
  ["messages_thread", threadCaller(automationStepThreadId), { threadId: "cloud:ws-builder" }, "capability_denied"],
  ["messages_thread", threadCaller(automationStepThreadId), { threadId: automationDelegateThreadId }, "ran"],
  ["messages_thread", threadCaller(automationDelegateThreadId), { threadId: automationStepThreadId }, "ran"],
  ["messages_thread", threadCaller(automationDelegateThreadId), { threadId: supervisedThreadId }, "capability_denied"],
  // A fork shares the step's root but is no delegate of it: steps.ts neither counts its usage nor stops it.
  ["messages_thread", threadCaller(automationStepThreadId), { threadId: automationForkThreadId }, "capability_denied"],
  ["messages_thread", threadCaller(automationStepThreadId), { threadId: automationDelegateForkThreadId }, "capability_denied"],
  ["messages_thread", threadCaller(automationDelegateThreadId), { threadId: automationDelegateForkThreadId }, "capability_denied"],
  // Changing a thread starts no turn, so writesThreads keeps no such limit.
  ["writes_threads", threadCaller(automationStepThreadId), { threadId: supervisedThreadId }, "ran"],
  ["writes_threads", threadCaller(automationStepThreadId), { threadId: automationForkThreadId }, "ran"],

  // Forking a thread: one within the caller's modes, and never from an automation run, whose run would neither pay
  // for the fork nor stop it.
  ["forks_threads", fullAccess, {}, "ran"],
  ["forks_threads", fullAccess, { threadId: supervisedThreadId }, "ran"],
  ["forks_threads", supervised, { threadId: fullAccessThreadId }, "runtime_mode_escalation_denied"],
  ["forks_threads", readOnlyClient, { threadId: supervisedThreadId }, "capability_denied"],
  ["forks_threads", threadCaller(automationStepThreadId), {}, "capability_denied"],
  ["forks_threads", threadCaller(automationStepThreadId), { threadId: automationDelegateThreadId }, "capability_denied"],
  ["forks_threads", threadCaller(automationDelegateThreadId), {}, "capability_denied"],
  ["forks_threads", threadCaller(automationForkThreadId), {}, "capability_denied"],

  // Starting a thread: the caller's own modes or narrower.
  ["starts_threads", supervised, {}, "approval-required/default"],
  ["starts_threads", supervised, { runtimeMode: "full-access" }, "runtime_mode_escalation_denied"],
  // Grill mode is the user's: a started thread never inherits it, nor gets it by asking.
  ["starts_threads", grill, {}, "approval-required/default"],
  ["starts_threads", grill, { interactionMode: "default" }, "approval-required/default"],
  ["starts_threads", grill, { interactionMode: "grill" }, "approval-required/default"],
  ["starts_threads", supervised, { interactionMode: "grill" }, "approval-required/default"],
  ["starts_threads", fullAccess, { runtimeMode: "auto", interactionMode: "default" }, "auto/default"],
  ["starts_threads", ended, {}, "parent_not_active"],
  // A delegated agent starts no new roots: they would escape its tree's limits.
  ["starts_threads", threadCaller(delegatedThreadId), {}, "capability_denied"],
  // An automation step starts no chats, scheduled tasks or runs: they would escape its run's wallet.
  ["starts_threads", threadCaller(automationStepThreadId), {}, "capability_denied"],
  ["starts_threads", threadCaller(automationDelegateThreadId), {}, "capability_denied"],
  ["starts_threads", threadCaller(automationForkThreadId), {}, "capability_denied"],
  ["acts_as_caller", threadCaller(automationStepThreadId), {}, "ran"],
  ["starts_threads", supervisedClient, {}, "approval-required/default"],
  ["starts_threads", supervisedClient, { runtimeMode: "auto" }, "runtime_mode_escalation_denied"],
  ["starts_threads", fullAccessClient, { runtimeMode: "full-access" }, "full-access/default"],

  // Projects and environment settings need full access.
  ["writes_environment", fullAccess, {}, "ran"],
  ["writes_environment", supervised, {}, "capability_denied"],
  ["writes_environment", grill, {}, "capability_denied"],
  ["writes_environment", fullAccessClient, {}, "ran"],
  ["writes_environment", supervisedClient, {}, "capability_denied"],
  // Nor does an automation step change projects or settings, or run a scheduled task, even with full access.
  ["writes_environment", threadCaller(automationStepThreadId), {}, "capability_denied"],
] as const)("%s from %o with %o: %s", ([tool, scope, args, expected]) =>
  call(tool, scope, args).pipe(
    Effect.map((outcome) => expect(outcome).toBe(expected)),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        }),
      ),
    ),
  ),
);

it("refuses a declaration or handlers layer built outside McpToolAccess", () => {
  // Private constructors only bind the type checker; Reflect.construct reaches them anyway.
  expect(() => Reflect.construct(McpToolAccess.Declaration, [unchecked])).toThrow(TypeError);
  expect(() => Reflect.construct(McpToolAccess.HandlersLayer, [Layer.empty])).toThrow(TypeError);
});

it("refuses a declaration or handlers layer that only wears another's fields", () => {
  // The types already refuse these; at runtime the private fields are missing too.
  const copiedDeclaration = Object.assign(
    unchecked,
    McpToolAccess.reads(() => ran),
  );
  expect(() =>
    McpToolAccess.toLayer(ProbeToolkit, {
      ...probeHandlers,
      // @ts-expect-error a declaration's fields copied onto an unchecked handler
      reads: copiedDeclaration,
    }),
  ).toThrow(TypeError);
  const copiedLayer = Object.assign(Layer.empty, layerProbeHandlers);
  expect(() => McpToolAccess.HandlersLayer.layer(copiedLayer)).toThrow(TypeError);
});

it.effect("refuses a change when the calling thread cannot be read", () =>
  call("writes", supervised).pipe(
    Effect.map((outcome) => expect(outcome).toBe("orchestration_error")),
    Effect.provide(
      probeServer(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.fail(new OrchestratorProjectionError({ threadId, cause: "unreadable" })),
        }),
      ),
    ),
  ),
);
