// ), apps/server/src/orchestration-v2/Adapters/GrokAdapterV2.test.ts @ 13aa882c22.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  MessageId,
  NodeId,
  RunAttemptId,
  RunId,
  type OrchestrationV2UserInputQuestion,
  type OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@caveman-app/protocol";
import { GrokSettings } from "@caveman-app/provider-grok/settings";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { resolveSelfInvocation } from "@caveman-app/shared/nodeRuntime";
import * as EffectAcpErrors from "@caveman-app/effect-acp/errors";
import {
  makeXAiPromptCompletionRuntime,
  xAiRateLimitedErrorCode,
} from "@caveman-app/provider-grok/testing";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpSchema from "@caveman-app/effect-acp/compat";

import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as ProjectStore from "../ProjectStore.ts";
import { buildInitialGrokProviderSnapshot } from "@caveman-app/provider-grok/testing";
import type { ProviderInstance } from "@caveman-app/engine-core/server/driver";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as AcpSessionRuntime from "@caveman-app/provider-acp/server/AcpSessionRuntime";
import { handoffBudget } from "@caveman-app/engine-core/server/handoffBudget";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as RuntimePolicy from "../RuntimePolicy.ts";
import { acpPermissionDisposition } from "@caveman-app/provider-acp/server/clientPolicy";
import {
  AcpProviderCapabilitiesV2,
  acpCompletedTurnShouldTerminalizeTool,
  acpSubagentStatusBlocksTurnSettlement,
  acpSupportsImagePrompts,
} from "@caveman-app/provider-acp/server/adapter";
import {
  makeGrokAcpAdapterFlavor,
  makeGrokAdapterV2,
  GrokProviderCapabilitiesV2,
  GROK_PROVIDER,
  GROK_ACP_INITIALIZE_META,
} from "@caveman-app/provider-grok/testing";

import { makeAcpReplayRuntime, type AcpReplayTranscript } from "./AcpAdapterV2.testkit.ts";

const LAUNCH_TEST_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({
  binaryPath: "grok-launch-test",
});

function permissionRequest(
  kind: EffectAcpSchema.ToolKind,
): EffectAcpSchema.RequestPermissionRequest {
  return {
    sessionId: "session-1",
    options: [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
      { optionId: "reject-once", name: "Reject", kind: "reject_once" },
    ],
    toolCall: {
      toolCallId: "tool-1",
      title: "Test tool",
      kind,
    },
  };
}

function runtimePolicy(input: {
  readonly runtimeMode: RuntimeMode;
  readonly approvalPolicy?: unknown;
  readonly sandboxPolicy?: unknown;
}) {
  return ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: input.runtimeMode,
    interactionMode: "default",
    cwd: "/workspace",
    ...(input.approvalPolicy === undefined ? {} : { approvalPolicy: input.approvalPolicy }),
    ...(input.sandboxPolicy === undefined ? {} : { sandboxPolicy: input.sandboxPolicy }),
  });
}

describe("acpSubagentStatusBlocksTurnSettlement", () => {
  it("blocks settlement for pending and running subagents", () => {
    assert.isTrue(acpSubagentStatusBlocksTurnSettlement("pending"));
    assert.isTrue(acpSubagentStatusBlocksTurnSettlement("running"));
  });

  it("does not block settlement for terminal subagents", () => {
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("cancelled"));
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("completed"));
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("failed"));
    assert.isFalse(acpSubagentStatusBlocksTurnSettlement("interrupted"));
  });
});

describe("GrokAdapterV2 capabilities", () => {
  it("preserves Grok's rate-limit stop and distinguishes other prompt failures", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );
    const limit = flavor.promptFailure?.(
      new EffectAcpErrors.AcpRequestError({
        code: xAiRateLimitedErrorCode,
        errorMessage: "Grok usage limit reached. Try again later.",
      }),
    );
    assert.equal(limit?.class, "usage_limit");
    assert.equal(limit?.code, String(xAiRateLimitedErrorCode));
    assert.equal(limit?.message, "Grok usage limit reached. Try again later.");
    assert.equal(
      flavor.promptFailure?.(
        new EffectAcpErrors.AcpRequestError({
          code: -32603,
          errorMessage: "Internal error",
        }),
      ).class,
      "provider_error",
    );
    assert.equal(
      flavor.promptFailure?.(new Error("Rate limit mentioned in an ordinary error")).class,
      "provider_error",
    );
  });

  it("wires hard Stop teardown but soft non-Stop interrupts in the constructor flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );

    assert.isFalse(flavor.interruptPromptOnCancel);
    // User Stop (requestRuntimeRestart) keeps the hard process-group kill and
    // respawn: Grok cancel is detach-and-continue, so only a process kill
    // stops the work.
    assert.isTrue(flavor.restartRuntimeAfterInterrupt);
    assert.isTrue(flavor.terminateRuntimeProcessGroupOnInterrupt);
    assert.isUndefined(flavor.restartRuntimeOnEveryInterrupt);
    assert.isTrue(flavor.preserveRuntimeOnSettledInterrupt);
  });

  it("terminalizes only foreground tools under the actual Grok flavor", () => {
    const flavor = makeGrokAcpAdapterFlavor(
      {
        makeRuntime: () => Effect.never,
      } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
      "/home/ada",
    );
    const foreground = {
      toolCallId: "foreground-1",
      title: "Terminal",
      status: "inProgress" as const,
      data: {
        rawInput: { command: "true" },
        rawOutput: { type: "Bash", exit_code: 0 },
      },
    };
    const monitor = {
      toolCallId: "monitor-1",
      title: "Monitor",
      status: "inProgress" as const,
      data: {
        rawInput: { variant: "Monitor", command: "sleep 30" },
        rawOutput: {
          type: "Monitor",
          taskId: "019f44b8-8e98-7c80-a40e-df1e26a5f9e3",
        },
      },
    };
    const subagent = {
      toolCallId: "subagent-1",
      title: "Task",
      status: "inProgress" as const,
      data: {
        rawInput: {
          description: "Inspect interrupt handling",
          prompt: "Review the adapter.",
          subagent_type: "generalPurpose",
        },
      },
    };

    assert.isTrue(acpCompletedTurnShouldTerminalizeTool(foreground, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(monitor, flavor));
    assert.isFalse(acpCompletedTurnShouldTerminalizeTool(subagent, flavor));
  });

  it("keeps optional protocol features conservative until a flavor or handshake confirms them", () => {
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.sessions.supportsRuntimeModeSwitchInSession);
    assert.isFalse(AcpProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isFalse(AcpProviderCapabilitiesV2.tools.supportsMcpTools);
  });

  it("overrides ACP image capability false so screenshot attachments can prompt", () => {
    assert.isFalse(
      acpSupportsImagePrompts({
        negotiatedImage: false,
      }),
    );
    assert.isTrue(
      acpSupportsImagePrompts({
        flavorSupportsImagePrompts: true,
        negotiatedImage: false,
      }),
    );
    assert.isTrue(
      acpSupportsImagePrompts({
        negotiatedImage: true,
      }),
    );
  });

  it("declares Grok Task envelopes as native subagents", () => {
    assert.isFalse(GrokProviderCapabilitiesV2.threads.canForkThread);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.supportsSubagents);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.exposesSubagentThreadIds);
    assert.isTrue(GrokProviderCapabilitiesV2.subagents.emitsSubagentLifecycle);
    assert.isFalse(GrokProviderCapabilitiesV2.turns.supportsActiveSteering);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsInterrupt);
    assert.isTrue(GrokProviderCapabilitiesV2.turns.supportsSteeringByInterruptRestart);
    assert.isTrue(GrokProviderCapabilitiesV2.context.supportsFullThreadHandoff);
  });

  it("declares the optional ACP features verified by the Grok handshake", () => {
    assert.isTrue(GrokProviderCapabilitiesV2.sessions.supportsModelSwitchInSession);
    assert.isTrue(GrokProviderCapabilitiesV2.threads.canReadThreadSnapshot);
    assert.isTrue(GrokProviderCapabilitiesV2.tools.supportsMcpTools);
    assert.isTrue(GrokProviderCapabilitiesV2.checkpointing.providerCanReadConversationSnapshot);
  });
});

describe("ACP permission policy", () => {
  it("honors explicit on-request approval over full-access runtime mode", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "on-request",
          sandboxPolicy: { type: "readOnly" },
        }),
        permissionRequest("execute"),
      ),
      "ask",
    );
  });

  it("rejects mutating escalation under a non-interactive read-only policy", () => {
    const policy = runtimePolicy({
      runtimeMode: "full-access",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(acpPermissionDisposition(policy, permissionRequest("execute")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("edit")), "deny");
    assert.equal(acpPermissionDisposition(policy, permissionRequest("read")), "allow");
  });

  it("auto-approves requests only when the resolved policy permits them", () => {
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxPolicy: { type: "dangerFullAccess" },
        }),
        permissionRequest("execute"),
      ),
      "allow",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("edit"),
      ),
      "ask",
    );
    assert.equal(
      acpPermissionDisposition(
        runtimePolicy({ runtimeMode: "approval-required" }),
        permissionRequest("read"),
      ),
      "allow",
    );
  });
});

describe("Grok permission prompts", () => {
  const disposition = makeGrokAcpAdapterFlavor(
    {
      makeRuntime: () => Effect.never,
    } as unknown as Parameters<typeof makeGrokAcpAdapterFlavor>[0],
    "/home/ada",
  ).permissionDisposition;

  it("leaves Auto prompts to the user unless an explicit policy launched Grok asking", () => {
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "auto" }), permissionRequest("read")),
      "ask",
    );
    const readOnly = runtimePolicy({
      runtimeMode: "auto",
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly" },
    });
    assert.equal(disposition?.(readOnly, permissionRequest("execute")), "deny");
    assert.equal(
      disposition?.(runtimePolicy({ runtimeMode: "approval-required" }), permissionRequest("edit")),
      "ask",
    );
  });
});

describe("Grok model context windows", () => {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  it.effect("budgets handoffs with the selected Grok model's window", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("grok-window-test");
      const threadId = ThreadId.make("grok-window-test");
      const modelSelection = { instanceId, model: "grok-build" };
      const policy = runtimePolicy({ runtimeMode: "full-access" });
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "linux",
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...input,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: process.cwd(),
                  env: {
                    T3_ACP_SESSION_LIFECYCLE: "1",
                    T3_ACP_GROK_MODEL: "grok-4.7",
                    T3_ACP_GROK_CONTEXT_TOKENS: "256000",
                  },
                },
                authMethodId: "test",
              }),
            );
            return yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
          }),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-window-test"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const budgetInput = {
        tokenCap: 16_000,
        userText: "Continue",
        attachments: [],
        providerThread,
        nativeContextEstimate: 160_684,
      };
      assert.isNull(providerThread.contextUsage);
      assert.equal(handoffBudget(budgetInput), 0);
      assert.equal(
        handoffBudget({
          ...budgetInput,
          modelContextWindow: runtime.getModelContextWindow?.({ instanceId, model: "grok-4.7" }),
        }),
        16_000,
      );
      assert.equal(runtime.getModelContextWindow?.({ instanceId, model: "grok-4.7" }), 256_000);
      assert.equal(runtime.getModelContextWindow?.({ instanceId, model: " grok-4.7 " }), 256_000);
      for (const model of ["custom-model", "grok-build", "toString"]) {
        assert.isUndefined(runtime.getModelContextWindow?.({ instanceId, model }));
      }
      assert.isUndefined(
        runtime.getModelContextWindow?.({
          instanceId: ProviderInstanceId.make("another-grok"),
          model: "grok-4.7",
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("Grok launch permission mode", () => {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  const launchArgs = (runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy) =>
    Effect.gen(function* () {
      const launches: Array<ReadonlyArray<string>> = [];
      const childProcessSpawner = ChildProcessSpawner.make((command) => {
        if (command._tag === "StandardCommand") launches.push(command.args.map(String));
        return Effect.fail(
          PlatformError.systemError({
            _tag: "NotFound",
            module: "grok-launch-test",
            method: "spawn",
          }),
        );
      });
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
      yield* adapter
        .openSession({
          threadId: ThreadId.make("grok-launch-test"),
          providerSessionId: ProviderSessionId.make("grok-launch-test"),
          modelSelection: { instanceId, model: "grok-build" },
          runtimePolicy,
        })
        .pipe(Effect.scoped, Effect.ignore);
      return launches;
    }).pipe(Effect.provideService(HostProcess.Platform, "darwin"), Effect.provide(layerTest));

  const policy = (
    runtimeMode: RuntimeMode,
    override: Partial<ProviderAdapter.ProviderAdapterV2RuntimePolicy> = {},
  ) =>
    ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: process.cwd(),
      ...override,
    });

  it.effect.each(
    (
      [
        ["approval-required", ["--permission-mode", "default", "agent", "stdio"]],
        ["auto", ["--permission-mode", "auto", "agent", "stdio"]],
        ["full-access", ["agent", "--always-approve", "stdio"]],
      ] as const
    ).map(([runtimeMode, args]) => [runtimeMode, args.join(" "), args] as const),
  )("launches %s threads with %s", ([runtimeMode, , args]) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* launchArgs(policy(runtimeMode)), [args]);
    }),
  );

  it.effect("launches a thread stored as Auto-accept edits asking", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialGrokProviderSnapshot(LAUNCH_TEST_GROK_SETTINGS);
      const instanceId = ProviderInstanceId.make("grok-launch-test");
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("grok-launch-test");
      const modelSelection = { instanceId, model: "grok-build" } as const;
      const resolved = yield* Effect.gen(function* () {
        const runtimePolicy = yield* RuntimePolicy.RuntimePolicyV2;
        return yield* runtimePolicy.resolve({
          thread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("grok-launch-test"),
            title: "Grok launch test",
            providerInstanceId: instanceId,
            modelSelection,
            runtimeMode: "auto-accept-edits",
            interactionMode: "default",
            branch: null,
            worktreePath: process.cwd(),
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          modelSelection,
        });
      }).pipe(
        Effect.provide(
          RuntimePolicy.layerFromProjectStore.pipe(
            Layer.provide(
              Layer.mock(ProjectStore.ProjectStoreV2)({
                get: () => Effect.die("the thread has a worktree"),
              }),
            ),
            Layer.provide(
              Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
                getInstance: () =>
                  Effect.succeed({
                    snapshot: { getSnapshot: Effect.succeed(snapshot) },
                  } as ProviderInstance),
              }),
            ),
          ),
        ),
      );
      assert.equal(resolved.runtimeMode, "approval-required");
      assert.deepEqual(yield* launchArgs(resolved), [
        ["--permission-mode", "default", "agent", "stdio"],
      ]);
    }),
  );

  it.effect("launches asking when an explicit approval or sandbox policy governs the thread", () =>
    Effect.gen(function* () {
      const asking = [["--permission-mode", "default", "agent", "stdio"]];
      assert.deepEqual(
        yield* launchArgs(
          policy("full-access", {
            approvalPolicy: "never",
            sandboxPolicy: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          }),
        ),
        asking,
      );
      assert.deepEqual(
        yield* launchArgs(policy("full-access", { approvalPolicy: "on-request" })),
        asking,
      );
    }),
  );
});

describe("Grok native questions", () => {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );

  it.live("keeps x.ai multi-select questions live and returns all selected answers", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "grok-multi-select-" });
      const questionText = "Which changes should be included?";
      const transcript: AcpReplayTranscript = {
        provider: GROK_PROVIDER,
        protocol: "acp.ndjson-jsonrpc",
        version: "1",
        scenario: "grok-multi-select",
        entries: [
          {
            type: "expect_outbound",
            label: "initialize",
            frame: { kind: "request", method: "initialize", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "initialized",
            frame: {
              kind: "response",
              method: "initialize",
              result: {
                protocolVersion: 1,
                agentCapabilities: { loadSession: true, promptCapabilities: { image: false } },
                authMethods: [{ id: "replay", name: "Replay" }],
              },
            },
          },
          {
            type: "expect_outbound",
            label: "session.new",
            frame: { kind: "request", method: "session/new", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "session.created",
            frame: {
              kind: "response",
              method: "session/new",
              result: {
                sessionId: "grok-multi-select-session",
                models: {
                  currentModelId: "grok-build",
                  availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "prompt",
            frame: { kind: "request", method: "session/prompt", params: "<any>" },
          },
          {
            type: "emit_inbound",
            label: "question",
            frame: {
              kind: "request",
              method: "_x.ai/ask_user_question",
              params: {
                method: "x.ai/ask_user_question",
                params: {
                  sessionId: "grok-multi-select-session",
                  toolCallId: "grok-question",
                  mode: "default",
                  questions: [
                    {
                      id: "changes",
                      question: questionText,
                      multiSelect: true,
                      options: [
                        { label: "Tests", description: "Cover behavior" },
                        { label: "Docs", description: "Explain usage" },
                      ],
                    },
                  ],
                },
              },
            },
          },
          {
            type: "expect_outbound",
            label: "selected answers",
            frame: {
              kind: "response",
              method: "_x.ai/ask_user_question",
              result: { outcome: "accepted", answers: { [questionText]: ["Tests", "Docs"] } },
            },
          },
          {
            type: "emit_inbound",
            label: "complete",
            frame: {
              kind: "response",
              method: "session/prompt",
              result: { stopReason: "end_turn" },
            },
          },
        ],
      };
      const statusPath = path.join(workspace, "status.json");
      const scriptPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      );
      const instanceId = ProviderInstanceId.make("grok-multi-select");
      const threadId = ThreadId.make("grok-multi-select-thread");
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "darwin",
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: makeAcpReplayRuntime({
          transcript,
          statusPath,
          scriptPath,
          childProcessSpawner,
          fileSystem: fs,
          initializeMeta: GROK_ACP_INITIALIZE_META,
        }),
      });
      const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: workspace,
      });
      const modelSelection = { instanceId, model: "grok-build" };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("grok-multi-select-session"),
        modelSelection,
        runtimePolicy: policy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy: policy,
      });
      const question = yield* Deferred.make<OrchestrationV2UserInputQuestion>();
      const request = yield* Deferred.make<OrchestrationV2RuntimeRequest>();
      const terminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => {
          if (
            event.type === "turn_item.updated" &&
            event.turnItem.type === "user_input_request" &&
            event.turnItem.questions[0]
          )
            return Deferred.succeed(question, event.turnItem.questions[0]);
          if (event.type === "runtime_request.updated")
            return Deferred.succeed(request, event.runtimeRequest);
          if (event.type === "turn.terminal") return Deferred.succeed(terminal, undefined);
          return Effect.void;
        }),
        Effect.forkScoped,
      );
      const now = yield* DateTime.now;
      yield* runtime.startTurn({
        appThread: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("grok-multi-select-project"),
          title: "Grok multi-select",
          providerInstanceId: instanceId,
          modelSelection,
          runtimeMode: "approval-required",
          interactionMode: "default",
          branch: null,
          worktreePath: workspace,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
        threadId,
        runId: RunId.make("grok-multi-select-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("grok-multi-select-attempt"),
        rootNodeId: NodeId.make("grok-multi-select-root"),
        providerThread,
        message: {
          createdBy: "user",
          creationSource: "web",
          messageId: MessageId.make("grok-multi-select-message"),
          text: "Ask which changes to include.",
          attachments: [],
        },
        modelSelection,
        runtimePolicy: policy,
      });
      assert.deepEqual(yield* Deferred.await(question), {
        id: "changes",
        header: "Question",
        question: questionText,
        multiSelect: true,
        options: [
          { label: "Tests", description: "Cover behavior" },
          { label: "Docs", description: "Explain usage" },
        ],
      });
      const pending = yield* Deferred.await(request);
      assert.equal(pending.kind, "user_input");
      assert.equal(pending.responseCapability.type, "live");
      yield* runtime.respondToRuntimeRequest({
        requestId: pending.id,
        answers: { changes: ["Tests", "Docs"] },
      });
      yield* Deferred.await(terminal);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});

describe("Grok reasoning effort", () => {
  const layerHost = TestProviderHost.layer().pipe(
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const layerTest = Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    IdAllocator.layer,
    McpProviderSessions.layer,
    layerHost,
  );
  const instanceId = ProviderInstanceId.make("grok-effort-test");
  const RECORDED_SESSION_ID = "00000000-0000-4000-8000-000000000001";

  // Answers with the results it is given and applies set_model's effort and
  // set_config_option. After set_model it reports the session's options through
  // config_option_update, as Grok 1.0.41 does. Logs every request it receives,
  // and refuses the efforts and models it is told to with invalid params.
  const GROK_EFFORT_AGENT = `
const fs = require("node:fs");
const initialize = JSON.parse(process.env.GROK_EFFORT_INITIALIZE);
const created = JSON.parse(process.env.GROK_EFFORT_SESSION_NEW);
const refusedEfforts = (process.env.GROK_EFFORT_REFUSE ?? "").split(",").filter(Boolean);
const refusedModels = (process.env.GROK_MODEL_REFUSE ?? "").split(",").filter(Boolean);
let configOptions = created.configOptions;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
const refuse = (id, message) => send({ id, error: { code: -32602, message } });
const set = (id, value) => {
  configOptions = configOptions.map((option) =>
    (option.id ?? option.configId) === id ? { ...option, currentValue: value } : option,
  );
};
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) return;
  fs.appendFileSync(
    process.env.GROK_EFFORT_REQUEST_LOG,
    JSON.stringify({ method: message.method, params: message.params }) + "\\n",
  );
  if (message.id === undefined) return;
  const params = message.params;
  if (message.method === "session/set_model" && refusedModels.includes(params.modelId)) {
    return refuse(message.id, "Unknown model " + params.modelId);
  }
  if (
    (message.method === "session/set_model" && refusedEfforts.includes(params._meta?.reasoningEffort)) ||
    (message.method === "session/set_config_option" && refusedEfforts.includes(params.value))
  ) {
    return refuse(message.id, "Unsupported reasoning effort for this model");
  }
  if (message.method === "session/set_model") {
    set("model", params.modelId);
    if (params._meta?.reasoningEffort !== undefined) set("reasoning_effort", params._meta.reasoningEffort);
    send({ id: message.id, result: { _meta: { model: { Ok: params.modelId } } } });
    send({
      method: "session/update",
      params: { sessionId: params.sessionId, update: { sessionUpdate: "config_option_update", configOptions } },
    });
    return;
  }
  if (message.method === "session/set_config_option") set(params.configId, params.value);
  const result =
    message.method === "initialize"
      ? initialize
      : message.method === "session/new"
        ? created
        : message.method === "session/set_config_option"
          ? { configOptions }
          : {};
  send({ id: message.id, result });
});
`;

  type LoggedRequest = { readonly method: string; readonly params: unknown };

  /** Grok 1.0.41's own answers, from a recorded session; it negotiates ACP v1. */
  const recordedGrokResults = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const transcript = yield* fs.readFileString(
      yield* path.fromFileUrl(
        new URL("../testkit/fixtures/grok_monitor/grok_transcript.ndjson", import.meta.url),
      ),
    );
    const results = new Map<string, unknown>();
    for (const line of transcript.split("\n")) {
      if (line.trim().length === 0) continue;
      const entry = JSON.parse(line) as { label?: string; frame?: { result?: unknown } };
      if (entry.label !== undefined) results.set(entry.label, entry.frame?.result);
    }
    return {
      initialize: results.get("response:initialize"),
      sessionNew: results.get("response:session/new") as {
        readonly configOptions: ReadonlyArray<{
          readonly id: string;
          readonly options?: ReadonlyArray<{ readonly value: string }>;
        }>;
      },
    };
  });

  /** The same session as a Grok that negotiates ACP v2, where models are config options. */
  const v2GrokResults = recordedGrokResults.pipe(
    Effect.map(({ sessionNew }) => ({
      initialize: {
        protocolVersion: 2,
        info: { name: "grok", version: "2.0.0" },
        authMethods: [{ type: "agent", methodId: "cached_token", name: "Cached token" }],
      },
      sessionNew: {
        sessionId: RECORDED_SESSION_ID,
        configOptions: sessionNew.configOptions.map(({ id, ...option }) => ({
          configId: id,
          ...option,
        })),
      },
    })),
  );

  /** A v2 Grok whose live effort option, like grok-4.5's, has no Extra High. */
  const v2GrokResultsWithoutXHigh = v2GrokResults.pipe(
    Effect.map(({ initialize, sessionNew }) => ({
      initialize,
      sessionNew: {
        ...sessionNew,
        configOptions: sessionNew.configOptions.map((option) =>
          option.configId === "reasoning_effort"
            ? { ...option, options: option.options?.filter((entry) => entry.value !== "xhigh") }
            : option,
        ),
      },
    })),
  );

  interface GrokRefusals {
    readonly efforts?: ReadonlyArray<string>;
    readonly models?: ReadonlyArray<string>;
  }

  const spawnGrok = (
    results: { readonly initialize: unknown; readonly sessionNew: unknown },
    requestLog: string,
    refusals: GrokRefusals = {},
  ) => ({
    command: process.execPath,
    args: ["-e", GROK_EFFORT_AGENT],
    cwd: process.cwd(),
    env: {
      GROK_EFFORT_REQUEST_LOG: requestLog,
      GROK_EFFORT_INITIALIZE: JSON.stringify(results.initialize),
      GROK_EFFORT_SESSION_NEW: JSON.stringify(results.sessionNew),
      GROK_EFFORT_REFUSE: (refusals.efforts ?? []).join(","),
      GROK_MODEL_REFUSE: (refusals.models ?? []).join(","),
    },
  });

  const configurationRequests = (requestLog: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return (yield* fs.readFileString(requestLog))
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as LoggedRequest)
        .filter(
          (request) =>
            request.method === "session/set_model" ||
            request.method === "session/set_config_option",
        );
    });

  const selection = (model: string, effort?: string) => ({
    instanceId,
    model,
    ...(effort === undefined ? {} : { options: [{ id: "reasoningEffort", value: effort }] }),
  });

  /** Opens a Grok session and returns how the open ended and what it asked Grok to change. */
  const openGrokSessionExit = (
    results: Effect.Effect<
      { readonly initialize: unknown; readonly sessionNew: unknown },
      unknown,
      FileSystem.FileSystem | Path.Path
    >,
    modelSelection: ReturnType<typeof selection>,
    refusals?: GrokRefusals,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const requestLog = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "grok-effort-" }),
        "requests.ndjson",
      );
      yield* fs.writeFileString(requestLog, "");
      const spawn = spawnGrok(yield* results, requestLog, refusals);
      const adapter = yield* makeGrokAdapterV2({
        instanceId,
        settings: LAUNCH_TEST_GROK_SETTINGS,
        environment: {},
        hostPlatform: "linux",
        selfInvocation: yield* resolveSelfInvocation(),
        makeRuntime: (input) =>
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({ ...input, spawn, authMethodId: "cached_token" }),
            );
            return yield* makeXAiPromptCompletionRuntime(
              yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context)),
            );
          }),
      });
      const opened = yield* Effect.exit(
        adapter.openSession({
          threadId: ThreadId.make("grok-effort-test"),
          providerSessionId: ProviderSessionId.make("grok-effort-test"),
          modelSelection,
          runtimePolicy: runtimePolicy({ runtimeMode: "full-access" }),
        }),
      );
      return { opened, requests: yield* configurationRequests(requestLog) };
    }).pipe(Effect.scoped, Effect.provide(layerTest));

  const openGrokSession = (...input: Parameters<typeof openGrokSessionExit>) =>
    openGrokSessionExit(...input).pipe(
      Effect.flatMap(({ opened, requests }) =>
        Exit.isSuccess(opened) ? Effect.succeed(requests) : Effect.failCause(opened.cause),
      ),
    );

  const setModel = (modelId: string, reasoningEffort?: string) => ({
    method: "session/set_model",
    params: {
      sessionId: RECORDED_SESSION_ID,
      modelId,
      ...(reasoningEffort === undefined ? {} : { _meta: { reasoningEffort } }),
    },
  });

  const setConfigOption = (configId: string, value: string) => ({
    method: "session/set_config_option",
    params: { sessionId: RECORDED_SESSION_ID, configId, type: "id", value },
  });

  it.effect("opens a Grok session at the effort the user picked", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(recordedGrokResults, selection("grok-4.7", "xhigh")),
        [
          {
            method: "session/set_model",
            params: {
              sessionId: RECORDED_SESSION_ID,
              modelId: "grok-4.7",
              _meta: { reasoningEffort: "xhigh" },
            },
          },
        ],
      );
    }),
  );

  it.effect.each([
    { protocol: "ACP v1", results: recordedGrokResults },
    { protocol: "ACP v2", results: v2GrokResults },
  ])("does not log an applied effort as an option the $protocol session lacks", ({ results }) =>
    Effect.gen(function* () {
      const warnings: Array<string> = [];
      const logger = Logger.make(({ logLevel, message }) => {
        if (logLevel === "Warn") warnings.push(JSON.stringify(message));
      });
      const requests = yield* openGrokSession(results, selection("grok-4.7", "xhigh")).pipe(
        Effect.provide(Logger.layer([logger], { mergeWithExisting: true })),
      );
      assert.isTrue(
        requests.some((request) => JSON.stringify(request.params).includes("xhigh")),
        "Grok receives the picked effort",
      );
      assert.deepStrictEqual(warnings, []);
    }),
  );

  it.effect("switches model and effort in one request", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(recordedGrokResults, selection("grok-4.7-build-fast", "xhigh")),
        [
          {
            method: "session/set_model",
            params: {
              sessionId: RECORDED_SESSION_ID,
              modelId: "grok-4.7-build-fast",
              _meta: { reasoningEffort: "xhigh" },
            },
          },
        ],
      );
    }),
  );

  it.effect("sends nothing when Grok already runs at the picked effort", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(recordedGrokResults, selection("grok-4.7", "high")),
        [],
      );
    }),
  );

  it.effect("applies the picked effort on a Grok that speaks ACP v2", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(v2GrokResults, selection("grok-4.7-build-fast", "xhigh")),
        [
          {
            method: "session/set_config_option",
            params: {
              sessionId: RECORDED_SESSION_ID,
              configId: "model",
              type: "id",
              value: "grok-4.7-build-fast",
            },
          },
          {
            method: "session/set_config_option",
            params: {
              sessionId: RECORDED_SESSION_ID,
              configId: "reasoning_effort",
              type: "id",
              value: "xhigh",
            },
          },
        ],
      );
    }),
  );

  it.effect("opens on ACP v2 when Grok does not offer the picked effort", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(
          v2GrokResultsWithoutXHigh,
          selection("grok-4.7-build-fast", "xhigh"),
        ),
        [setConfigOption("model", "grok-4.7-build-fast")],
      );
    }),
  );

  it.effect("opens on ACP v2 when Grok refuses the picked effort", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(v2GrokResults, selection("grok-4.7-build-fast", "xhigh"), {
          efforts: ["xhigh"],
        }),
        [
          setConfigOption("model", "grok-4.7-build-fast"),
          setConfigOption("reasoning_effort", "xhigh"),
        ],
      );
    }),
  );

  it.effect("switches to a model that does not offer the picked effort without it", () =>
    Effect.gen(function* () {
      // Grok 4.5 lists no Extra High in its model metadata.
      assert.deepEqual(
        yield* openGrokSession(recordedGrokResults, selection("grok-4.5", "xhigh"), {
          efforts: ["xhigh"],
        }),
        [setModel("grok-4.5")],
      );
    }),
  );

  it.effect("keeps the model switch when Grok refuses the picked effort", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(recordedGrokResults, selection("grok-4.7-build-fast", "xhigh"), {
          efforts: ["xhigh"],
        }),
        [setModel("grok-4.7-build-fast", "xhigh"), setModel("grok-4.7-build-fast")],
      );
    }),
  );

  it.effect("opens at Grok's own effort when it refuses the picked one", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* openGrokSession(recordedGrokResults, selection("grok-4.7", "xhigh"), {
          efforts: ["xhigh"],
        }),
        [setModel("grok-4.7", "xhigh")],
      );
    }),
  );

  it.effect("still fails the open when Grok refuses the model", () =>
    Effect.gen(function* () {
      const { opened, requests } = yield* openGrokSessionExit(
        recordedGrokResults,
        selection("grok-4.6", "xhigh"),
        { models: ["grok-4.6"] },
      );
      assert.isTrue(Exit.isFailure(opened));
      if (Exit.isFailure(opened)) {
        assert.include(Cause.pretty(opened.cause), 'did not accept the model "grok-4.6"');
      }
      assert.deepEqual(requests, [setModel("grok-4.6", "xhigh"), setModel("grok-4.6")]);
    }),
  );

  /**
   * Starts a Grok session and picks efforts on it through the flavor, as a
   * switch within the session does: from the setup it started with, whose
   * model metadata still names the effort it started at.
   */
  const effortSwitches = (
    results: Effect.Effect<
      { readonly initialize: unknown; readonly sessionNew: unknown },
      unknown,
      FileSystem.FileSystem | Path.Path
    >,
  ) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const requestLog = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "grok-effort-" }),
        "requests.ndjson",
      );
      yield* fs.writeFileString(requestLog, "");
      const context = yield* Layer.build(
        AcpSessionRuntime.layer({
          spawn: spawnGrok(yield* results, requestLog),
          cwd: process.cwd(),
          clientInfo: { name: "grok-effort-test", version: "0.0.0" },
          authMethodId: "cached_token",
        }),
      );
      const runtime = yield* AcpSessionRuntime.AcpSessionRuntime.pipe(Effect.provide(context));
      const startResult = yield* runtime.start();
      const flavor = makeGrokAcpAdapterFlavor(
        {
          instanceId,
          settings: LAUNCH_TEST_GROK_SETTINGS,
          environment: {},
          hostPlatform: "linux",
          selfInvocation: yield* resolveSelfInvocation(),
        },
        "/home/ada",
      );
      return {
        runtime,
        pick: (effort: string) =>
          flavor.applyModelSelection!({
            runtime,
            startResult,
            modelSelection: selection("grok-4.7", effort),
          }),
        requests: configurationRequests(requestLog),
      };
    });

  it.effect("returns to an earlier effort within the same session", () =>
    Effect.gen(function* () {
      const { runtime, pick, requests } = yield* effortSwitches(recordedGrokResults);
      yield* pick("xhigh");
      assert.deepEqual(yield* requests, [setModel("grok-4.7", "xhigh")]);
      // Grok reports the effort it now runs at after answering.
      yield* runtime.getEvents().pipe(
        Stream.filter(
          (event) =>
            event._tag === "ConfigOptionsUpdated" &&
            event.configOptions.some(
              (option) => option.id === "reasoning_effort" && option.currentValue === "xhigh",
            ),
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* pick("high");
      assert.deepEqual(yield* requests, [
        setModel("grok-4.7", "xhigh"),
        setModel("grok-4.7", "high"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("returns to an earlier effort on a Grok that reports no effort option", () =>
    Effect.gen(function* () {
      // With no live effort to compare against, the setup's start effort would
      // make the switch back to it look like no change.
      const { pick, requests } = yield* effortSwitches(
        recordedGrokResults.pipe(
          Effect.map(({ initialize, sessionNew }) => ({
            initialize,
            sessionNew: {
              ...sessionNew,
              configOptions: sessionNew.configOptions.filter(({ id }) => id !== "reasoning_effort"),
            },
          })),
        ),
      );
      yield* pick("xhigh");
      yield* pick("high");
      assert.deepEqual(yield* requests, [
        setModel("grok-4.7", "xhigh"),
        setModel("grok-4.7", "high"),
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );
});
