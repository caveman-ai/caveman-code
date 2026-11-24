// ), apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts @ ab3a3cd1; perf from 07d38b8d17.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { historyResponseItems } from "@caveman-app/engine-core/server/handoffBudget";
import { makeProviderFailure } from "@caveman-app/engine-core/server/failure";
import {
  makeProviderTextDeltaCoalescer,
  type ProviderTextDeltaUpdate,
} from "./ProviderTextDeltaCoalescer.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  CheckpointId,
  CodexSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  ProjectId,
  type ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  parseGoalCommand,
} from "@caveman-app/protocol";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vitest";

import { appProxy, codexProxy } from "../../router/proxyLauncher.ts";
import { followedLogins } from "../../cloudLink/engineLogins.ts";

// The app's own proxies, as if the runtime had started them (proxyLauncher.ts); Codex's own is the one Auto uses.
vi.spyOn(appProxy, "url").mockReturnValue("http://127.0.0.1:8787");
vi.spyOn(codexProxy, "url").mockReturnValue("http://127.0.0.1:8787");
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { SpawnExecutableResolution } from "@caveman-app/shared/shell";
import * as CodexClient from "@caveman-app/codex-app-server/client";
import * as CodexError from "@caveman-app/codex-app-server/errors";
import * as CodexReplay from "@caveman-app/codex-app-server/replay";
import type * as CodexSchema from "@caveman-app/codex-app-server/schema";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as FileSystem from "effect/FileSystem";
import { MCP_APP_OUTPUT_KEY, readMcpAppReference } from "@caveman-app/shared/mcpApp";
import { resolveAttachmentPath, resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import { TestClock } from "effect/testing";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import packageJson from "../../../package.json" with { type: "json" };
import * as ServerConfig from "../../config.ts";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as EffectWorker from "../EffectWorker.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as ProviderReplayHarness from "../testkit/ProviderReplayHarness.ts";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import type * as ProviderContinuationRequests from "@caveman-app/engine-core/server/ProviderContinuationRequests";
import * as PortScanner from "../../preview/PortScanner.ts";
import * as CodexAdapterV2 from "./CodexAdapterV2.ts";
import * as NodeFS from "node:fs";
import { GRILL_SKILL_PATH } from "../../grill/grill.ts";
import { resolveCodexLaunch } from "../../provider/CodexApiKeyAccount.ts";
import { resolveCodexLaunchArgs } from "../../provider/codexLaunchArgs.ts";
import { mapCodexModelCapabilities } from "../../provider/CodexProvider.ts";
import { makeReplayServerConfig, withCodexReplayChildMetadata } from "./CodexAdapterV2.testkit.ts";
import * as CodexAdapterV2Testkit from "./CodexAdapterV2.testkit.ts";
import { emptyThreadState, projectEvent } from "../../session-protocol/projector.ts";
import { projectDomainEventForWire } from "../WireProjection.ts";

const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const replayTranscriptJson = Schema.fromJsonString(CodexReplay.CodexAppServerReplayTranscript);
const encodeReplayTranscriptJson = Schema.encodeEffect(replayTranscriptJson);
const decodeReplayTranscriptJson = Schema.decodeUnknownEffect(replayTranscriptJson);
const encodeStringJson = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const isProviderAdapterEventStreamError = Schema.is(
  ProviderAdapter.ProviderAdapterEventStreamError,
);

describe("Codex context usage compatibility", () => {
  const previous: ModelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-6-astra",
  };
  it("retains measured usage for reasoning-only changes in either direction", () => {
    const low: ModelSelection = { ...previous, options: [{ id: "reasoningEffort", value: "low" }] };
    assert.isTrue(CodexAdapterV2.canReuseCodexContextUsage(previous, low));
    assert.isTrue(CodexAdapterV2.canReuseCodexContextUsage(low, previous));
    assert.isTrue(
      CodexAdapterV2.canReuseCodexContextUsage(low, {
        ...low,
        options: [{ id: "reasoningEffort", value: "high" }],
      }),
    );
  });
  it("invalidates usage for model, instance, context-window and unknown option changes", () => {
    for (const next of [
      { ...previous, model: "other-model" },
      { ...previous, instanceId: ProviderInstanceId.make("other-codex") },
      { ...previous, options: [{ id: "contextWindow", value: "32k" }] },
      { ...previous, options: [{ id: "customOption", value: "value" }] },
    ])
      assert.isFalse(CodexAdapterV2.canReuseCodexContextUsage(previous, next));
  });
});

describe("CodexAdapterV2 file change approvals", () => {
  it("uses nonblank reasons before sorted file operations and renamed paths", () => {
    const fileChanges = {
      "/tmp/removed.md": { type: "delete" as const, content: "gone" },
      "/tmp/added.ts": { type: "add" as const, content: "export {};" },
      "/tmp/moved.ts": {
        type: "update" as const,
        unified_diff: "@@",
        move_path: "/tmp/renamed.ts",
      },
    };
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: "  Update configuration. ",
        fileChanges,
      }),
      "Update configuration.",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", fileChanges }),
      "add /tmp/added.ts\nupdate /tmp/moved.ts -> /tmp/renamed.ts\ndelete /tmp/removed.md",
    );
  });

  it("falls back to a nonblank grant root and omits empty details", () => {
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ reason: " ", grantRoot: " /workspace " }),
      "/workspace",
    );
    assert.equal(
      CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges: {}, grantRoot: "/workspace" }),
      "/workspace",
    );
    assert.isUndefined(
      CodexAdapterV2.codexFileChangeApprovalPrompt({
        reason: " ",
        grantRoot: " ",
        fileChanges: {},
      }),
    );
  });

  it("bounds large patch descriptions without losing the remaining count", () => {
    const fileChanges = Object.fromEntries(
      Array.from({ length: 25 }, (_, index) => [
        `/tmp/file-${String(index).padStart(2, "0")}.ts`,
        { type: "add" as const, content: "" },
      ]),
    );
    const detail = CodexAdapterV2.codexFileChangeApprovalPrompt({ fileChanges });
    assert.equal(detail?.split("\n").length, 21);
    assert.isTrue(detail?.startsWith("add /tmp/file-00.ts") ?? false);
    assert.isTrue(detail?.endsWith("+5 more") ?? false);
    assert.notInclude(detail, "file-20.ts");
  });
});

describe("CodexAdapterV2 context usage", () => {
  it("uses the current context rather than cumulative processed tokens", () => {
    const usage = CodexAdapterV2.codexProviderTurnTokenUsage(
      {
        total: {
          totalTokens: 180_000,
          inputTokens: 160_000,
          cachedInputTokens: 20_000,
          outputTokens: 20_000,
          reasoningOutputTokens: 5_000,
        },
        last: {
          totalTokens: 50_000,
          inputTokens: 45_000,
          cachedInputTokens: 10_000,
          outputTokens: 5_000,
          reasoningOutputTokens: 1_000,
        },
        modelContextWindow: 200_000,
      },
      "2026-08-29T00:00:00.000Z",
    );

    assert.deepEqual(usage, {
      usedTokens: 50_000,
      maxTokens: 200_000,
      inputTokens: 45_000,
      cachedInputTokens: 10_000,
      outputTokens: 5_000,
      reasoningOutputTokens: 1_000,
      updatedAt: "2026-08-29T00:00:00.000Z",
    });
  });
});

describe("CodexAdapterV2 assistant message streaming", () => {
  it.effect("shows an answer's first text at once, then at most one update per flush interval", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "partial" });
      assert.deepEqual(yield* Ref.get(updates), [{ turnId: "turn-1", itemId: "message-1", text: "partial", completed: false }]);
      // Within the interval: held, then sent together when it is over.
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " one" });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " two" });
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(updates)).length, 1);
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.deepEqual((yield* Ref.get(updates)).at(-1), { turnId: "turn-1", itemId: "message-1", text: "partial one two", completed: false });
      assert.equal((yield* Ref.get(updates)).length, 2);
      // After a quiet spell the next text goes at once again.
      yield* TestClock.adjust("100 millis");
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: " three" });
      assert.deepEqual((yield* Ref.get(updates)).at(-1), { turnId: "turn-1", itemId: "message-1", text: "partial one two three", completed: false });
    }),
  );

  it.effect("flushes buffered text synchronously before item and turn completion", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "item final" });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
      });
      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "turn final" });
      yield* coalescer.flushTurn("turn-1");

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        // The first text goes at once; the next item's waits for the interval, which its completion overtakes.
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: false },
        { turnId: "turn-1", itemId: "message-1", text: "item final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "turn final", completed: true },
      ]);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      assert.equal((yield* Ref.get(updates)).length, 3);
    }),
  );

  it.effect("retains buffered text until completion updates are emitted", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const failNext = yield* Ref.make(false);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Ref.getAndSet(failNext, false).pipe(
            Effect.flatMap((shouldFail) =>
              shouldFail
                ? Effect.die("projection unavailable")
                : Ref.update(updates, (current) => [...current, update]),
            ),
          ),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "turn final" });
      yield* Ref.set(failNext, true);
      const failedFlush = yield* coalescer.flushTurn("turn-1").pipe(Effect.exit);
      assert.equal(failedFlush._tag, "Failure");
      yield* coalescer.flushTurn("turn-1");

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "item final" });
      yield* Ref.set(failNext, true);
      const failedComplete = yield* coalescer
        .complete({ turnId: "turn-1", itemId: "message-2" })
        .pipe(Effect.exit);
      assert.equal(failedComplete._tag, "Failure");
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-2",
      });

      assert.equal(completedText, "item final");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "turn final", completed: false },
        { turnId: "turn-1", itemId: "message-1", text: "turn final", completed: true },
        { turnId: "turn-1", itemId: "message-2", text: "item final", completed: true },
      ]);
    }),
  );

  it.effect("can discard an empty completion without emitting an assistant update", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-1", delta: "" });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("50 millis");
      yield* Effect.yieldNow;
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
        emitEmpty: false,
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), []);

      yield* coalescer.append({ turnId: "turn-1", itemId: "message-2", delta: "buffered" });
      assert.equal(
        yield* coalescer.complete({
          turnId: "turn-1",
          itemId: "message-2",
          emitEmpty: false,
        }),
        "buffered",
      );
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-2", text: "buffered", completed: false },
        {
          turnId: "turn-1",
          itemId: "message-2",
          text: "buffered",
          completed: true,
        },
      ]);
    }),
  );

  it.effect("treats explicit empty final text as authoritative over buffered deltas", () =>
    Effect.gen(function* () {
      const updates = yield* Ref.make<ReadonlyArray<ProviderTextDeltaUpdate>>([]);
      const coalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) => Ref.update(updates, (current) => [...current, update]),
      });

      yield* coalescer.append({
        turnId: "turn-1",
        itemId: "message-1",
        delta: "stale buffered text",
      });
      const completedText = yield* coalescer.complete({
        turnId: "turn-1",
        itemId: "message-1",
        finalText: "",
      });

      assert.equal(completedText, "");
      assert.deepEqual(yield* Ref.get(updates), [
        { turnId: "turn-1", itemId: "message-1", text: "stale buffered text", completed: false },
        {
          turnId: "turn-1",
          itemId: "message-1",
          text: "",
          completed: true,
        },
      ]);
    }),
  );
});

describe("CodexAdapterV2 runtime policy", () => {
  it.effect.each([undefined, false, true])(
    "selects native collaboration modes without prompt overrides with hasCavemanMcp=%s",
    (hasCavemanMcp) =>
      Effect.gen(function* () {
        // Grill mode stays in Codex's default collaboration mode.
        for (const interactionMode of ["grill", "default"] as const) {
          for (const reasoningEffort of [undefined, "high"] as const) {
            const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
              nativeThreadId: "native-mode-switch",
              codexInput: [{ type: "text", text: "test" }],
              runtimePolicy: { runtimeMode: "full-access", interactionMode, cwd: null },
              modelSelection: {
                instanceId: ProviderInstanceId.make("codex"),
                model: "gpt-5.4",
                ...(reasoningEffort === undefined
                  ? {}
                  : { options: [{ id: "reasoningEffort", value: reasoningEffort }] }),
              },
              ...(hasCavemanMcp === undefined ? {} : { hasCavemanMcp }),
            });

            assert.deepEqual(params.collaborationMode, {
              mode: "default",
              settings: {
                model: "gpt-5.4",
                ...(reasoningEffort === undefined ? {} : { reasoning_effort: reasoningEffort }),
              },
            });
            assert.equal(params.effort, reasoningEffort);
            assert.equal(params.additionalContext !== undefined, hasCavemanMcp === true);
          }
        }
      }),
  );

  it.effect("derives concrete Codex turn policies from every T3 runtime mode", () =>
    Effect.gen(function* () {
      const build = (
        runtimeMode: "approval-required" | "auto-accept-edits" | "auto" | "full-access",
      ) =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode,
            interactionMode: "default",
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
        });

      const approvalRequired = yield* build("approval-required");
      const autoAcceptEdits = yield* build("auto-accept-edits");
      const auto = yield* build("auto");
      const fullAccess = yield* build("full-access");

      assert.equal(approvalRequired.approvalPolicy, "untrusted");
      assert.equal(approvalRequired.approvalsReviewer, "user");
      assert.equal(approvalRequired.sandboxPolicy?.type, "readOnly");
      assert.equal(autoAcceptEdits.approvalPolicy, "on-request");
      assert.equal(autoAcceptEdits.approvalsReviewer, "user");
      assert.equal(autoAcceptEdits.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(auto.approvalPolicy, "on-request");
      assert.equal(auto.approvalsReviewer, "auto_review");
      assert.equal(auto.sandboxPolicy?.type, "workspaceWrite");
      assert.equal(fullAccess.approvalPolicy, "never");
      assert.equal(fullAccess.approvalsReviewer, "user");
      assert.equal(fullAccess.sandboxPolicy?.type, "dangerFullAccess");
    }),
  );

  it.effect("preserves explicit Codex turn policy overrides", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-override",
        codexInput: [{ type: "text", text: "test" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
          approvalPolicy: "on-request",
          sandboxPolicy: {
            type: "readOnly",
          },
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
      });

      assert.equal(params.approvalPolicy, "on-request");
      assert.equal(params.sandboxPolicy?.type, "readOnly");
    }),
  );

  it.effect("adds memory's copy to workspace-write roots only", () =>
    Effect.gen(function* () {
      const build = (runtimeMode: "approval-required" | "auto" | "full-access") =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: `native-memory-${runtimeMode}`,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: { runtimeMode, interactionMode: "default", cwd: null },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          writableRoots: ["/copies/thread-1/memory"],
        });
      const auto = yield* build("auto");
      assert.deepEqual(auto.sandboxPolicy?.type === "workspaceWrite" ? auto.sandboxPolicy.writableRoots : undefined, ["/copies/thread-1/memory"]);
      // Read-only stays read-only; full access needs no extra root.
      assert.deepEqual((yield* build("approval-required")).sandboxPolicy, { type: "readOnly" });
      assert.deepEqual((yield* build("full-access")).sandboxPolicy, { type: "dangerFullAccess" });
    }),
  );

  it.effect("sends MCP app model context as untrusted Codex context", () =>
    Effect.gen(function* () {
      const policy = { runtimeMode: "full-access", interactionMode: "default", cwd: null } as const;
      const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" };
      const appContext = [{ key: "mcp_app_todos_list_todos_item-1", text: "Filtered to overdue" }];
      const alone = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        appContext,
      });
      assert.deepEqual(alone.additionalContext, {
        "mcp_app_todos_list_todos_item-1": { kind: "untrusted", value: "Filtered to overdue" },
      });
 // Alongside upstream own context, both are kept.
      const withT3 = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-app-context",
        codexInput: [{ type: "text", text: "what's on my list?" }],
        runtimePolicy: policy,
        modelSelection,
        hasCavemanMcp: true,
        appContext,
      });
      assert.deepEqual(withT3.additionalContext?.["mcp_app_todos_list_todos_item-1"], {
        kind: "untrusted",
        value: "Filtered to overdue",
      });
      assert.isDefined(withT3.additionalContext?.["caveman_code_runtime"]);
    }),
  );

  it.effect("adds default-mode developer instructions when the T3 MCP server is attached", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-orchestration-instructions",
        codexInput: [{ type: "text", text: "delegate this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasCavemanMcp: true,
      });

      assert.equal(params.collaborationMode?.mode, "default");
      assert.include(
        params.additionalContext?.caveman_code_orchestration_01?.value ?? "",
        "Subagents: `delegate_task`",
      );
      assert.include(
        params.additionalContext?.caveman_code_orchestration_02?.value ?? "",
        "`schedule_task`, without running its prompt",
      );
    }),
  );

  it.effect("keeps Codex's own default-mode text without the T3 MCP server", () =>
    Effect.gen(function* () {
      const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
        nativeThreadId: "native-default-without-t3-mcp",
        codexInput: [{ type: "text", text: "implement this task" }],
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: null,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        hasCavemanMcp: false,
      });

      assert.deepEqual(params.collaborationMode, {
        mode: "default",
        settings: { model: "gpt-5.4" },
      });
      assert.isUndefined(params.additionalContext);
    }),
  );

  it.effect("keeps Codex's default collaboration mode, approvals and sandbox in grill mode", () =>
    Effect.gen(function* () {
      const params = (interactionMode: "default" | "grill") =>
        CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-grill",
          codexInput: [{ type: "text", text: "grill me" }],
          runtimePolicy: { runtimeMode: "approval-required", interactionMode, cwd: null },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          hasCavemanMcp: true,
        });
      const grill = yield* params("grill");
      assert.deepEqual(grill, yield* params("default"));
      assert.equal(grill.collaborationMode?.mode, "default");
      assert.equal(grill.approvalPolicy, "untrusted");
      assert.deepEqual(grill.sandboxPolicy, { type: "readOnly" });
    }),
  );

  it.effect.each(["default", "grill"] as const)(
    "compiles per-turn Codex model options and cwd from their owning inputs in %s mode",
    (interactionMode) =>
      Effect.gen(function* () {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-model-options",
          hasCavemanMcp: true,
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode,
            cwd: "/workspace/model-options",
            reasoningEffort: "low",
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
            options: [
              { id: "reasoningEffort", value: "xhigh" },
              { id: "serviceTier", value: "priority" },
            ],
          },
        });

        assert.equal(params.model, "gpt-5.4");
        assert.equal(params.effort, "xhigh");
        assert.equal(params.serviceTier, "priority");
        assert.equal(params.cwd, "/workspace/model-options");
        assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
        // Grill mode leaves Codex in its default collaboration mode.
        assert.equal(params.collaborationMode?.mode, "default");
        assert.equal(params.collaborationMode?.settings.reasoning_effort, "xhigh");
        assert.include(
          params.additionalContext?.caveman_code_runtime?.value ?? "",
          "as gpt-5.4 with xhigh reasoning effort",
        );

 // compact token sharing rejects service tiers, so managed sessions drop a stale pick.
        const managed = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-model-options",
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace/model-options",
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
            options: [{ id: "serviceTier", value: "priority" }],
          },
          omitServiceTier: true,
        });
        assert.equal(managed.serviceTier, undefined);

        for (const tier of [undefined, "default"]) {
          const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
            nativeThreadId: "native-model-options",
            codexInput: [{ type: "text", text: "test" }],
            runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "gpt-5.4",
              options: tier === undefined ? [] : [{ id: "serviceTier", value: tier }],
            },
          });
          if (tier === undefined) assert.notProperty(params, "serviceTier");
          else assert.equal(params.serviceTier, "default");
        }
      }),
  );

  it.effect("uses Astra's advertised effort default while preserving explicit selections", () =>
    Effect.gen(function* () {
      const model = "gpt-6-astra";
      const capabilities = mapCodexModelCapabilities({
        id: model,
        model,
        displayName: model,
        description: "Test model",
        hidden: false,
        isDefault: true,
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high"].map((reasoningEffort) => ({
          reasoningEffort,
          description: reasoningEffort,
        })),
        additionalSpeedTiers: [],
      });
      const advertised = capabilities.optionDescriptors?.find(
        (option) => option.id === "reasoningEffort",
      )?.currentValue;
      assert.equal(advertised, "medium");
      for (const selected of [undefined, "high"] as const) {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-astra-effort",
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model,
            ...(selected ? { options: [{ id: "reasoningEffort", value: selected }] } : {}),
          },
          hasCavemanMcp: true,
        });
        const expected = selected ?? advertised;
        assert.equal(params.effort, expected);
        assert.equal(params.collaborationMode?.settings.reasoning_effort, expected);
        assert.include(
          params.additionalContext?.caveman_code_runtime?.value ?? "",
          `${expected} reasoning effort`,
        );
      }
    }),
  );

  it.effect.each(["default", "grill"] as const)(
    "omits unset effort from %s collaboration settings and runtime context",
    (interactionMode) =>
      Effect.gen(function* () {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: "native-unset-effort",
          codexInput: [{ type: "text", text: "test" }],
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode,
            cwd: null,
          },
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          hasCavemanMcp: true,
        });

        assert.isUndefined(params.effort);
        // Grill mode leaves Codex in its default collaboration mode.
        assert.equal(params.collaborationMode?.mode, "default");
        assert.equal(params.collaborationMode?.settings.model, "gpt-5.4");
        assert.notProperty(params.collaborationMode?.settings, "reasoning_effort");
        const runtimeContext = params.additionalContext?.caveman_code_runtime?.value ?? "";
        assert.include(runtimeContext, "as gpt-5.4");
        assert.notInclude(runtimeContext, "reasoning effort");
      }),
  );
});

describe("CodexAdapterV2 process spawning", () => {
  it("injects cwd, model, and MCP authorization into thread-scoped params", () => {
    const threadId = ThreadId.make("thread-codex-mcp");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-mcp"),
      threadId,
      providerSessionId: "mcp-session-codex",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    };

    assert.deepEqual(
      CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession,
        modelSelection: { model: "gpt-5.4" },
        runtimePolicy: {
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/workspace/thread-codex-mcp",
        },
      }),
      {
        cwd: "/workspace/thread-codex-mcp",
        model: "gpt-5.4",
        config: {
          "tools.update_plan.enabled": true,
          // Codex waits up to 10 s, not 1 s, for MCP servers before the first request (#13437).
          mcp_optional_startup_grace_ms: 10_000,
          // Codex's own memory never loads into, or learns from, the app's chats (memory mode "disabled").
          "memories.use_memories": false,
          "memories.generate_memories": false,
          // A repo with only a CLAUDE.md still gives Codex its instructions (AGENTS.md wins per directory).
          project_doc_fallback_filenames: ["CLAUDE.md"],
          // Web search on OpenAI's cache, not live under full access.
          web_search: "cached",
          // One key per server, so the servers Codex's launch arguments add survive.
          "mcp_servers.caveman-code": {
            url: "http://127.0.0.1:43123/mcp",
            tool_timeout_sec: 3_900,
            http_headers: {
              Authorization: "Bearer secret-codex-token",
            },
            disabled_tools: ["thread_wait"],
            tools: { desktop: { approval_mode: "approve" } },
          },
          // The delegate wait, registered again so Code Mode can't run it as a nested call.
          "mcp_servers.caveman-code-direct": {
            url: "http://127.0.0.1:43123/mcp",
            tool_timeout_sec: 3_900,
            http_headers: { Authorization: "Bearer secret-codex-token" },
            enabled_tools: ["thread_wait"],
            omit_tools_from: ["code_mode", "deferred"],
          },
        },
      },
    );

    // Grill mode's server rides along only while the thread is in grill mode.
    const grill = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession,
      runtimePolicy: { runtimeMode: "approval-required", interactionMode: "grill", cwd: null },
    });
    assert.deepEqual(CodexAdapterV2.codexMcpServersOf(grill.config), {
      "caveman-code": {
        url: "http://127.0.0.1:43123/mcp",
        tool_timeout_sec: 3_900,
        http_headers: { Authorization: "Bearer secret-codex-token" },
        disabled_tools: ["thread_wait"],
        tools: { desktop: { approval_mode: "approve" } },
      },
      "caveman-code-direct": {
        url: "http://127.0.0.1:43123/mcp",
        tool_timeout_sec: 3_900,
        http_headers: { Authorization: "Bearer secret-codex-token" },
        enabled_tools: ["thread_wait"],
        omit_tools_from: ["code_mode", "deferred"],
      },
      "caveman-grill": {
        url: "http://127.0.0.1:43123/mcp/grill",
        http_headers: { Authorization: "Bearer secret-codex-token" },
        // A round waits for a person: a day, not Codex's 60 s default.
        tool_timeout_sec: 86_400,
        default_tools_approval_mode: "approve",
      },
    });
  });

  it("gives a thread's commands its app thread id, overriding a plugin's", () => {
    const config = CodexAdapterV2.codexThreadRuntimeParams({
      threadId: "thread-codex-own-id",
      mcpSession: undefined,
      plugins: {
        config: {},
        developerInstructions: "",
        toolEnv: { CAVEMAN_CODE_THREAD_ID: "spoofed", WORKSPACE: "set" },
      } as never,
    }).config;
    assert.equal(config["shell_environment_policy.set.CAVEMAN_CODE_THREAD_ID"], "thread-codex-own-id");
    assert.equal(config["shell_environment_policy.set.WORKSPACE"], "set");
    assert.isUndefined(
      CodexAdapterV2.codexThreadRuntimeParams({ threadId: null, mcpSession: undefined }).config[
        "shell_environment_policy.set.CAVEMAN_CODE_THREAD_ID"
      ],
    );
  });

  it("on a Cloud computer the desktop's input asks like a command, and its looks answer yes unasked", () => {
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-computer"),
      threadId: ThreadId.make("thread-codex-computer"),
      providerSessionId: "mcp-session-codex-computer",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    };
    const tools = (runtimeMode: "approval-required" | "auto-accept-edits" | "full-access") => {
      const before = process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
      process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = "127.0.0.1:47917";
      try {
        const config = CodexAdapterV2.codexThreadRuntimeParams({ mcpSession, runtimePolicy: { runtimeMode, interactionMode: "default", cwd: null } }).config;
        const servers = CodexAdapterV2.codexMcpServersOf(config) as Record<string, { tools?: unknown }>;
        return servers["caveman-code"]?.tools;
      } finally {
        if (before === undefined) delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
        else process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = before;
      }
    };
    assert.deepEqual(tools("approval-required"), { computer: { approval_mode: "prompt" } });
    assert.deepEqual(tools("auto-accept-edits"), { computer: { approval_mode: "prompt" } });
    assert.deepEqual(tools("full-access"), { computer: { approval_mode: "approve" } });

    const ask = (action: string, serverName = "caveman-code", tool = "computer") => ({
      serverName,
      threadId: "native-thread",
      turnId: "turn-1",
      message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
      mode: "form" as const,
      requestedSchema: { type: "object" as const, properties: {} },
      _meta: { codex_approval_kind: "mcp_tool_call", persist: ["session", "always"], tool_params: { action } },
    });
    for (const action of ["screenshot", "cursor_position", "wait"]) assert.isTrue(CodexAdapterV2.codexComputerLooks(ask(action)));
    for (const action of ["key", "type", "left_click"]) assert.isFalse(CodexAdapterV2.codexComputerLooks(ask(action)));
    assert.isTrue(CodexAdapterV2.codexComputerLooks(ask("screenshot", "t3-code")));
    assert.isFalse(CodexAdapterV2.codexComputerLooks(ask("key", "t3-code")));
    assert.isFalse(CodexAdapterV2.codexComputerLooks(ask("screenshot", "other-server")));
    assert.isFalse(CodexAdapterV2.codexComputerLooks(ask("screenshot", "caveman-code", "html_preview")));
  });

  it("sends grill mode's skill the way Codex injects a skill", () => {
    const skillFile = NodeFS.readFileSync(GRILL_SKILL_PATH, "utf8");
    assert.include(skillFile, "grill_round");
    assert.deepEqual(CodexAdapterV2.codexGrillSkillItem(skillFile), {
      type: "text",
      text: `<skill>\n<name>grill</name>\n${skillFile}\n</skill>`,
    });
  });

  it("carries a mentioned plugin skill into the turn, shaped like Codex's own", () => {
    const skills = [
      { name: "lane-echo", path: "/plugins/lane-kit/skills/lane-echo/SKILL.md" },
      { name: "review", path: "/plugins/kit/skills/review/SKILL.md" },
    ];
    assert.deepEqual(
      CodexAdapterV2.mentionedPluginSkills("$review then $lane-echo and $review again", skills).map((s) => s.name),
      ["review", "lane-echo"],
    );
    // Unknown names, a sigil glued to a word and a missing skill list stay prose.
    assert.deepEqual(CodexAdapterV2.mentionedPluginSkills("echo $HOME, 5$review, $lane-echo,", skills), []);
    assert.deepEqual(CodexAdapterV2.mentionedPluginSkills("$review", undefined), []);
    assert.deepEqual(CodexAdapterV2.codexPluginSkillItem("lane-echo", "/p/SKILL.md", "---\nname: lane-echo\n---\nReply.\n"), {
      type: "text",
      text: "<skill>\n<name>lane-echo</name>\n<path>/p/SKILL.md</path>\n---\nname: lane-echo\n---\nReply.\n</skill>",
    });
  });

  it("passes a thread's space plugins as per-thread overrides, never through CODEX_HOME", () => {
    const threadId = ThreadId.make("thread-codex-space");
    const mcpSession = {
      environmentId: EnvironmentId.make("environment-codex-space"),
      threadId,
      providerSessionId: "mcp-session-codex-space",
      providerInstanceId: ProviderInstanceId.make("codex"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret-codex-token",
      browserToolsAvailable: true,
    };
    // SessionPlugins.codex's projection: names are already `<plugin>__<server>`.
    const plugins = {
      config: {
        mcp_servers: {
          linear__tools: { command: "launcher", args: ["npx", "linear-mcp"], env: { LINEAR: "1" } },
          docs__search: { url: "https://docs.example/mcp", http_headers: { "X-Space": "a" } },
          // A plugin cannot replace the runtime's own MCP server.
          "caveman-code": { command: "not-the-runtime" },
        },
      },
      developerInstructions: "  Follow the space's rules.  ",
    };
    const t3Code = {
      url: "http://127.0.0.1:43123/mcp",
      tool_timeout_sec: 3_900,
      http_headers: { Authorization: "Bearer secret-codex-token" },
      disabled_tools: ["thread_wait"],
      tools: { desktop: { approval_mode: "approve" } },
    };
    const t3CodeDirect = {
      url: "http://127.0.0.1:43123/mcp",
      tool_timeout_sec: 3_900,
      http_headers: { Authorization: "Bearer secret-codex-token" },
      enabled_tools: ["thread_wait"],
      omit_tools_from: ["code_mode", "deferred"],
    };

    assert.deepEqual(CodexAdapterV2.codexThreadRuntimeParams({ mcpSession, plugins }), {
      developerInstructions: "Follow the space's rules.",
      config: {
        ...CodexAdapterV2.CODEX_THREAD_CONFIG,
        "mcp_servers.linear__tools": { command: "launcher", args: ["npx", "linear-mcp"], env: { LINEAR: "1" } },
        "mcp_servers.docs__search": { url: "https://docs.example/mcp", http_headers: { "X-Space": "a" } },
        "mcp_servers.caveman-code": t3Code,
        "mcp_servers.caveman-code-direct": t3CodeDirect,
      },
    });

    // The workspace's [env], one shell_environment_policy.set key per name: the user's own policy stays.
    assert.deepEqual(
      CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession: undefined,
        plugins: { config: { mcp_servers: {} }, developerInstructions: "", toolEnv: { API_URL: "http://localhost:3000", "BAD NAME": "x" } },
      }).config,
      { ...CodexAdapterV2.CODEX_THREAD_CONFIG, "shell_environment_policy.set.API_URL": "http://localhost:3000" },
    );

    // Full access approves the plugins' tools; Codex rejects them under "never" otherwise.
    const fullAccess = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession,
      plugins,
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
    });
    const servers = CodexAdapterV2.codexMcpServersOf(fullAccess.config);
    assert.deepEqual(servers.docs__search, {
      url: "https://docs.example/mcp",
      http_headers: { "X-Space": "a" },
      default_tools_approval_mode: "approve",
    });
    assert.deepEqual(servers["caveman-code"], t3Code);
  });

  it("runs an Auto thread on the app proxy's route for Codex's login, under the slug Cloud holds to OpenAI models", () => {
    const auto = (chatgpt: boolean) =>
      CodexAdapterV2.codexThreadRuntimeParams({
        mcpSession: undefined,
        modelSelection: { model: "caveman-auto" },
        router: { proxy: "http://127.0.0.1:8787", session: "thread-auto", chatgpt },
      });
    const provider = (baseUrl: string) => ({
      name: "Caveman",
      base_url: baseUrl,
      wire_api: "responses",
      requires_openai_auth: true,
      http_headers: { "x-cave-session": "thread-auto", "x-cave-agent": "caveman-code-codex" },
    });

    assert.deepEqual(auto(true), {
      model: "caveman-auto",
      modelProvider: "caveman",
      config: {
        ...CodexAdapterV2.CODEX_THREAD_CONFIG,
        "model_providers.caveman": provider("http://127.0.0.1:8787/chatgpt"),
      },
    });
    assert.deepEqual(
      auto(false).config["model_providers.caveman"],
      provider("http://127.0.0.1:8787/w/caveman-code-codex/v1"),
    );
    // Any other model keeps Codex's own provider.
    const plain = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: undefined,
      modelSelection: { model: "gpt-5.4" },
    });
    assert.isUndefined(plain.modelProvider);
    assert.notProperty(plain.config, "model_providers.caveman");
  });

  it("searches the web on OpenAI's cache unless the person chose a mode", () => {
    const config = (ownWebSearch?: boolean) =>
      CodexAdapterV2.codexThreadRuntimeParams({ mcpSession: undefined, ...(ownWebSearch === undefined ? {} : { ownWebSearch }) }).config;
    assert.equal(config().web_search, "cached");
    assert.equal(config(false).web_search, "cached");
    assert.notProperty(config(true), "web_search");
    // Everything else the thread is sent stays.
    const { web_search: _cached, ...rest } = CodexAdapterV2.CODEX_THREAD_CONFIG;
    assert.deepEqual(config(true), rest);
  });

  it("reads the person's own web search choice from config.toml and launch arguments", () => {
    const own = CodexAdapterV2.codexOwnWebSearch;
    assert.isFalse(own(""));
    assert.isFalse(own('model = "gpt-5.4"\nsandbox_mode = "danger-full-access"\n\n[features]\nmemories = true\n'));
    // The mode, top level, however it is written.
    assert.isTrue(own('web_search = "live"\n'));
    assert.isTrue(own('  "web_search"  =  "disabled" # off\n'));
    // The older switches Codex still reads.
    assert.isTrue(own("[tools]\nweb_search = true\n"));
    assert.isTrue(own("tools.web_search = false\n"));
    assert.isTrue(own("tools = { web_search = true }\n"));
    assert.isTrue(own("[features]\nweb_search_request = true\n"));
    assert.isTrue(own("[features]\nweb_search_cached = true\n"));
    // Search options without a mode are not a choice of mode; neither is another table's key.
    assert.isFalse(own('[tools.web_search]\ncontext_size = "high"\n'));
    assert.isFalse(own('[mcp_servers.search]\nweb_search = "live"\n'));
    // A profile's mode counts only when Codex runs that profile.
    const profiles = '[profiles.research]\nweb_search = "live"\n';
    assert.isFalse(own(profiles));
    assert.isTrue(own(`profile = "research"\n${profiles}`));
    assert.isTrue(own(profiles, "--profile research"));
    assert.isFalse(own(`profile = "other"\n${profiles}`));
    // Launch arguments.
    assert.isTrue(own("", `-c 'web_search="live"'`));
    assert.isTrue(own("", "--config=web_search=disabled"));
    assert.isTrue(own("", "--enable web_search_request"));
    assert.isFalse(own("", `-c 'cli_auth_credentials_store="file"' -c 'forced_login_method="api"'`));
    assert.isTrue(own("", "--search"));
    // A project's .codex/config.toml, read after the home's: its own tables, and a profile either names.
    assert.isTrue(own(["", 'web_search = "disabled"\n']));
    assert.isFalse(own(["[features]\nmemories = true\n", 'model = "gpt-5.4"\n']));
    assert.isTrue(own(['profile = "research"\n', '[profiles.research]\nweb_search = "live"\n']));
  });

  it.effect("finds the project's .codex/config.toml files from the repository's root down to the thread's folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codex-project-" });
      const repo = NodePath.join(root, "repo");
      const app = NodePath.join(repo, "apps", "web");
      yield* fileSystem.makeDirectory(NodePath.join(repo, ".git"), { recursive: true });
      yield* fileSystem.makeDirectory(NodePath.join(app, ".codex"), { recursive: true });
      yield* fileSystem.makeDirectory(NodePath.join(repo, ".codex"), { recursive: true });
      yield* fileSystem.makeDirectory(NodePath.join(root, ".codex"), { recursive: true });
      yield* fileSystem.writeFileString(NodePath.join(repo, ".codex", "config.toml"), 'web_search = "live"\n');
      yield* fileSystem.writeFileString(NodePath.join(app, ".codex", "config.toml"), 'model = "gpt-5.4"\n');
      // Above the repository: not the project's.
      yield* fileSystem.writeFileString(NodePath.join(root, ".codex", "config.toml"), 'web_search = "disabled"\n');
      assert.deepEqual(yield* CodexAdapterV2.codexProjectConfigs(app), ['web_search = "live"\n', "", 'model = "gpt-5.4"\n']);
      // Outside a repository, only the folder's own.
      assert.deepEqual(yield* CodexAdapterV2.codexProjectConfigs(NodePath.join(root, ".codex")), [""]);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("resolves Windows command shims through the shared spawn policy", () =>
    Effect.gen(function* () {
      const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
        command: "codex",
        args: ["app-server", "argument with spaces"],
        cwd: "C:\\workspace",
        env: { CUSTOM: "1" },
        extendEnv: true,
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(
        command.command,
        '^"C:\\npm\\codex.cmd^" ^"app-server^" ^"argument^ with^ spaces^"',
      );
      assert.deepEqual(command.args, []);
      assert.equal(command.options.shell, true);
      assert.equal(command.options.cwd, "C:\\workspace");
      assert.deepEqual(command.options.env, { CUSTOM: "1" });
      assert.equal(command.options.extendEnv, true);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(HostProcess.Environment, {
        PATH: "C:\\Windows\\System32",
        HOST_ONLY: "1",
      }),
      Effect.provideService(SpawnExecutableResolution, (_command, _platform, environment) => {
        assert.equal(environment.HOST_ONLY, "1");
        assert.equal(environment.CUSTOM, "1");
        return "C:\\npm\\codex.cmd";
      }),
    ),
  );

  it.effect("uses direct execution for native executables", () =>
    Effect.gen(function* () {
      const command = yield* CodexAdapterV2.makeCodexAppServerSpawnCommand({
        command: "codex.exe",
        args: ["app-server"],
      });

      assert.isTrue(ChildProcess.isStandardCommand(command));
      if (!ChildProcess.isStandardCommand(command)) {
        return;
      }
      assert.equal(command.command, "C:\\bin\\codex.exe");
      assert.deepEqual(command.args, ["app-server"]);
      assert.equal(command.options.shell, false);
    }).pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => "C:\\bin\\codex.exe"),
    ),
  );

  it.effect("launches the app-server with the configured launch arguments", () =>
    Effect.gen(function* () {
      const spawnedArgs: Array<ReadonlyArray<string>> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedArgs.push(command.args.map(String));
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory.pipe(
        Effect.provide(CodexAdapterV2.layerAppServerClientFactory),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );
      const open = (environment: NodeJS.ProcessEnv) =>
        factory
          .open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-launch-args"),
            providerSessionId: ProviderSessionId.make("provider-session-launch-args"),
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            }),
            settings: {
              ...DEFAULT_CODEX_SETTINGS,
              launchArgs: " --strict-config -c model_reasoning_summary=detailed ",
            },
            environment,
          })
          .pipe(Effect.scoped, Effect.exit);

      yield* open({});
      yield* open({ CAVEMAN_CODE_CODEX_LAUNCH_ARGS: " --enable env-feature " });

      assert.deepEqual(spawnedArgs, [
        ["app-server", "--strict-config", "-c", "model_reasoning_summary=detailed"],
        ["app-server", "--enable", "env-feature"],
      ]);
    }).pipe(Effect.provideService(HostProcess.Platform, "linux")),
  );

  it.effect("expands ~ in the configured binary path before spawning", () =>
    Effect.gen(function* () {
      const spawnedCommands: Array<string> = [];
      const spawner = ChildProcessSpawner.make((command) => {
        if (ChildProcess.isStandardCommand(command)) spawnedCommands.push(command.command);
        return Effect.fail(
          PlatformError.systemError({ _tag: "NotFound", module: "ChildProcess", method: "spawn" }),
        );
      });
      const path = yield* Path.Path;
      const adapter = yield* CodexAdapterV2.createCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        displayName: undefined,
        environment: [],
        enabled: true,
        config: { ...DEFAULT_CODEX_SETTINGS, binaryPath: "~/bin/codex" },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            CodexAdapterV2.layerAppServerClientFactory,
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-codex-binary-home-" }),
          ),
        ),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      );

      yield* adapter
        .openSession({
          threadId: ThreadId.make("thread-binary-home"),
          providerSessionId: ProviderSessionId.make("provider-session-binary-home"),
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        })
        .pipe(Effect.scoped, Effect.exit);

      assert.deepEqual(spawnedCommands, [path.join(NodeOS.homedir(), "bin", "codex")]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
      Effect.provideService(HostProcess.Platform, "linux"),
    ),
  );
});

describe("CodexAdapterV2 dynamic tool projection", () => {
  it.effect("keeps a failed Sky MCP call in Computer Use when its error has no metadata", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "failed-sky-js",
        server: "node_repl",
        tool: "js",
        status: "failed",
        arguments: {
          title: "Restrict the breakpoint to Git actions",
          code: "await sky.type_text({app:'Caveman Code (Nightly)',text:'debug(ga.run)'});",
        },
        result: { content: [{ type: "text", text: "Illegal Unicode escape sequence" }] },
      });
      assert.equal(projection.title, "Restrict the breakpoint to Git actions");
      assert.equal(projection.toolSurface, "computer");
      assert.deepEqual(projection.toolSource, {
        key: "computer-use",
        name: "Computer Use",
        kind: "computer",
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["inProgress", "completed", "failed"] as const)(
    "preserves a bare js action's title and computer surface when %s without result metadata",
    (status) =>
      Effect.gen(function* () {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
          type: "dynamicToolCall",
          id: "bare-js",
          tool: "js",
          status,
          arguments: { code: "await sky.get_app_state(app);", title: "Read the desktop window" },
          contentItems: [],
          success: status !== "failed",
        });
        assert.equal(projection.title, "Read the desktop window");
        assert.equal(projection.toolSurface, "computer");
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["cua_repl", "node_repl"])(
    "uses the %s call title while leaving other MCP titles as tool arguments",
    (server) =>
      Effect.gen(function* () {
        const call = {
          type: "mcpToolCall" as const,
          id: "inspect",
          server,
          tool: "js",
          status: "completed" as const,
          arguments: {
            code: "await game.getAXStateAndScreenshot();",
            title: "Inspect Saga music screen",
          },
          result: { content: [] },
        };
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem(call)).title,
          "Inspect Saga music screen",
        );
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem({
            ...call,
            arguments: { title: "  " },
          })).title,
          server === "cua_repl" ? "Computer use" : "Run JavaScript",
        );
        assert.equal(
          (yield* CodexAdapterV2.projectCodexDynamicToolItem({ ...call, server: "github" })).title,
          "js",
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect.each(["inProgress", "completed", "failed"] as const)(
    "presents ordinary MCP calls when %s",
    (status) =>
      Effect.gen(function* () {
        const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
          type: "mcpToolCall",
          id: "weather-call",
          server: "weather",
          tool: "get_weather",
          status,
          arguments: { city: "Berlin" },
        });
        assert.equal(projection.title, "get weather");
        assert.deepEqual(projection.toolSource, {
          key: "mcp:weather",
          name: "weather",
          kind: "integration",
        });
        assert.deepEqual(projection.input, { city: "Berlin" });
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("uses Codex connector names without reading a display title from arguments", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "connector-call",
        server: "_apps",
        tool: "connector_get_weather",
        status: "completed",
        arguments: { title: "Argument, not display metadata" },
        appContext: {
          connectorId: "weather-app",
          appName: "Weather",
          actionName: "Check weather",
        },
        result: {
          content: [],
          _meta: { source: { logoUrl: "https://example.com/weather.png" } },
        },
      });
      assert.equal(projection.title, "Check weather");
      assert.equal(projection.toolSource?.name, "Weather");
      assert.deepEqual(projection.toolIcon, {
        _tag: "themed-logo",
        logoUrl: "https://example.com/weather.png",
      });
      assert.deepEqual(projection.toolSource?.icon, projection.toolIcon);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("preserves native browser and app icons alongside MCP tool output", () =>
    Effect.gen(function* () {
      const browser = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "browser",
        server: "browser",
        tool: "open",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "browserUse",
              browserFamily: "Chrome",
              screenshot: {
                pageUrl: "https://example.com/docs",
                faviconUrl: "https://example.com/icon.png",
              },
            },
          },
        },
      });
      assert.equal(browser.toolSurface, "browser");
      assert.deepEqual(browser.toolIcon, {
        _tag: "website",
        pageUrl: "https://example.com/docs",
        faviconUrl: "https://example.com/icon.png",
      });
      assert.equal(browser.toolSource?.name, "Chrome");
      const app = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "app",
        server: "computer",
        tool: "click",
        status: "completed",
        arguments: {},
        result: {
          content: [],
          _meta: {
            "codex/toolSurface": {
              kind: "computerUse",
              app: { kind: "appId", appId: "com.apple.finder" },
            },
          },
        },
      });
      assert.deepEqual(app.toolIcon, {
        _tag: "native-app",
        app: { _tag: "app-id", appId: "com.apple.finder" },
      });
      assert.equal(app.toolSource?.name, "Finder");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("preserves MCP arguments and prefers structured output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "mcpToolCall",
        id: "call-create-threads",
        server: "caveman-code",
        tool: "create_threads",
        status: "completed",
        arguments: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        result: {
          content: [{ type: "text", text: '{"threads":[{"threadId":"thread:mcp:fixture:0"}]}' }],
          structuredContent: {
            threads: [{ threadId: "thread:mcp:fixture:0" }],
          },
        },
      });

      assert.deepEqual(projection, {
        toolName: "caveman-code.create_threads",
        input: {
          threads: [{ title: "Fixture child", prompt: "fixture child prompt" }],
        },
        output: {
          threads: [{ threadId: "thread:mcp:fixture:0" }],
        },
        status: "completed",
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("preserves namespaced dynamic tool output", () =>
    Effect.gen(function* () {
      const projection = yield* CodexAdapterV2.projectCodexDynamicToolItem({
        type: "dynamicToolCall",
        id: "call-dynamic",
        namespace: "workspace",
        tool: "inspect",
        status: "failed",
        arguments: { path: "package.json" },
        contentItems: [{ type: "inputText", text: "inspection failed" }],
        success: false,
      });

      assert.deepEqual(projection, {
        toolName: "workspace.inspect",
        input: { path: "package.json" },
        output: [{ type: "inputText", text: "inspection failed" }],
        status: "failed",
      });
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});

describe("CodexAdapterV2 process exit", () => {
  it.effect.each([
    { exit: "numeric", active: false },
    { exit: "SIGKILL", active: false },
    { exit: "numeric", active: true },
    { exit: "SIGKILL", active: true },
  ] as const)("retires the shared session after $exit (active turn: $active)", ({ exit, active }) =>
    Effect.gen(function* () {
      const scenario = `process-exit-${exit}-${active}`;
      const nativeThreadId = `native-${scenario}`;
      const nativeTurnId = `turn-${scenario}`;
      const input = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const emit = (frame: unknown) =>
        Queue.offer(input, new TextEncoder().encode(JSON.stringify(frame) + "\n"));
      const outputEnded = yield* Deferred.make<void>();
      const turnStarted = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
      const terminationError =
        exit === "numeric"
          ? new CodexError.CodexAppServerProcessExitedError({ code: 17, pid: 52 })
          : new CodexError.CodexAppServerTransportError({
              operation: "read-process-exit-status",
              pid: 52,
              cause: PlatformError.systemError({
                _tag: "Unknown",
                module: "ChildProcess",
                method: "exitCode",
                cause: new Error("Process terminated by SIGKILL"),
              }),
            });
      const client = yield* CodexClient.make(
        Stdio.make({
          args: Effect.succeed([]),
          stdin: Stream.fromQueue(input),
          stdout: () =>
            Sink.forEach((chunk: string | Uint8Array) =>
              Effect.gen(function* () {
                const frame = JSON.parse(
                  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk),
                ) as { readonly id?: number; readonly method: string };
                const response = preamble.find(
                  (entry) =>
                    entry.type === "emit_inbound" &&
                    entry.label === frame.method &&
                    Predicate.isObject(entry.frame) &&
                    "id" in entry.frame,
                );
                if (response?.type === "emit_inbound") {
                  yield* emit(response.frame);
                }
              }),
            ).pipe(Sink.ensuring(Deferred.succeed(outputEnded, undefined))),
          stderr: () => Sink.drain,
        }),
        {},
        Effect.succeed(terminationError),
      );
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory: { open: () => Effect.succeed(client) },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(scenario).pipe(Effect.orDie),
      });
      const threadId = ThreadId.make(`thread-${scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`session-${scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const eventReader = yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "provider_turn.updated" && event.providerTurn.status === "running"
                ? Deferred.succeed(turnStarted, undefined)
                : event.type === "turn.terminal"
                  ? Deferred.succeed(turnCompleted, undefined)
                  : Effect.void,
            ),
          ),
        ),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      yield* runtime.startTurn(
        makeCodexTestTurnInput({
          threadId,
          providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`attempt-${scenario}`),
          text: "work",
        }),
      );
      yield* emit({
        method: "turn/started",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
        },
      });
      yield* Deferred.await(turnStarted);
      if (!active) {
        yield* emit({
          method: "turn/completed",
          params: {
            threadId: nativeThreadId,
            turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
          },
        });
        yield* Deferred.await(turnCompleted);
        assert.isTrue(
          events.some((event) => event.type === "turn.terminal" && event.status === "completed"),
        );
      }

      yield* Queue.end(input);
      // Output closes only after the protocol records the process termination.
      yield* Deferred.await(outputEnded);
      const rpcError = yield* client.request("thread/list", {}).pipe(Effect.flip);
      assert.strictEqual(rpcError, terminationError);
      // Without the fix the stream never ends, so this waits until the project timeout.
      const readerExit = yield* Fiber.await(eventReader);
      // A failure, not a clean end, carries the Codex error into the session's lastError.
      assert.isTrue(
        Exit.isFailure(readerExit) &&
          isProviderAdapterEventStreamError(Cause.squash(readerExit.cause)),
        "the session manager must receive process death so it can retire the shared process",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("counts the app-server as a running agent until its session closes", () => {
    let runningAgents = 0;
    const factoryLayer = CodexAdapterV2.layerAppServerClientFactory.pipe(
      Layer.provide(
        Layer.mock(PortScanner.PortDiscovery)({
          trackAgent: () => {
            runningAgents += 1;
            return () => {
              runningAgents -= 1;
            };
          },
        }),
      ),
      Layer.provide(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provide(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() =>
            Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(999_999_999),
                exitCode: Effect.never,
                isRunning: Effect.succeed(true),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.never,
                stderr: Stream.empty,
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            ),
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const factory = yield* CodexAdapterV2.CodexAppServerClientFactory;
      yield* Effect.scoped(
        factory
          .open({
            instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
            threadId: ThreadId.make("thread-codex-agent"),
            providerSessionId: ProviderSessionId.make("session-codex-agent"),
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
            settings: DEFAULT_CODEX_SETTINGS,
            environment: {},
          })
          .pipe(Effect.tap(() => Effect.sync(() => assert.equal(runningAgents, 1)))),
      );
      assert.equal(runningAgents, 0);
    }).pipe(Effect.provide(factoryLayer));
  });
});

describe("CodexAdapterV2 native protocol logging", () => {
  it.effect("logs decoded app-server frames once with credentials redacted", () =>
    Effect.gen(function* () {
      const writes: Array<{
        readonly event: unknown;
        readonly threadId: ThreadId | null;
      }> = [];
      const logger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event, threadId) =>
          Effect.sync(() => {
            writes.push({ event, threadId });
          }),
        close: () => Effect.void,
      };
      const threadId = ThreadId.make("thread-1");
      const providerSessionId = ProviderSessionId.make("provider-session-1");
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId,
        providerSessionId,
      });

      assert.notEqual(protocolLogger, undefined);
      if (protocolLogger === undefined) {
        return;
      }

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "thread/event",
          params: {
            id: "evt-1",
            http_headers: { Authorization: "Bearer secret-codex-token" },
            usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        payload:
          '{"method":"thread/event","params":{"http_headers":{"Authorization":"Bearer secret-codex-token"}}}\n',
      });

      assert.equal(writes.length, 1);
      assert.equal(writes[0]?.threadId, threadId);
      assert.deepEqual(writes[0]?.event, {
        provider: "codex",
        protocol: "codex.app-server",
        kind: "protocol",
        providerSessionId,
        event: {
          direction: "incoming",
          stage: "decoded",
          payload: {
            method: "thread/event",
            params: {
              id: "evt-1",
              http_headers: { Authorization: "[REDACTED]" },
              usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
            },
          },
        },
      });
    }),
  );

  it.effect("never logs the egress scrub's token (Auto's provider, an echoed URL) or the login's email", () =>
    Effect.gen(function* () {
      const token = "ab".repeat(32);
      const scrubUrl = `http://127.0.0.1:41234/${token}/0123456789abcdef`;
      const written: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) => Effect.sync(() => void written.push(event)),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.isDefined(protocolLogger);

      yield* protocolLogger!({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          id: 2,
          method: "thread/start",
          params: {
            modelProvider: "caveman",
            config: {
              "model_providers.caveman": { name: "Caveman", base_url: scrubUrl },
              nested: JSON.stringify({ base_url: scrubUrl }),
            },
          },
        },
      });
      yield* protocolLogger!({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "error",
          params: { message: `error sending request for url (${scrubUrl}/responses)` },
        },
      });

      // Auto reads the login type; the login's email stays out of the log too.
      yield* protocolLogger!({
        direction: "incoming",
        stage: "decoded",
        payload: {
          id: 3,
          result: {
            account: { type: "chatgpt", email: "someone@example.com", planType: "plus" },
            requiresOpenaiAuth: true,
          },
        },
      });

      const logged = JSON.stringify(written);
      assert.equal(written.length, 3);
      assert.notInclude(logged, token);
      assert.include(logged, "http://127.0.0.1:41234/[REDACTED]/0123456789abcdef");
      assert.notInclude(logged, "someone@example.com");
      assert.include(logged, '"type":"chatgpt"');
    }),
  );

  it.effect("filters streaming frames before redaction without losing decode failures", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) =>
            Effect.sync(() => {
              writes.push(event);
            }),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.exists(protocolLogger);
      if (protocolLogger === undefined) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "item/agentMessage/delta",
          get params() {
            throw new Error("delta must not be copied");
          },
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "raw",
        get payload() {
          throw new Error("raw frame must not be parsed");
        },
      });
      yield* protocolLogger({
        direction: "incoming",
        stage: "decode_failed",
        payload: { operation: "decode", method: "turn/completed", issueCount: 1 },
      });

      assert.equal(writes.length, 1);
      assert.nestedPropertyVal(writes[0], "event.stage", "decode_failed");
      assert.nestedPropertyVal(writes[0], "event.payload.method", "turn/completed");
    }),
  );

  it.effect("retains redacted failures when large payloads are summarized", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: {
          filePath: "/tmp/events.log",
          write: (event) =>
            Effect.sync(() => {
              writes.push(event);
            }),
          close: () => Effect.void,
        },
        threadId: ThreadId.make("thread-1"),
        providerSessionId: ProviderSessionId.make("provider-session-1"),
      });
      assert.exists(protocolLogger);
      if (protocolLogger === undefined) return;

      yield* protocolLogger({
        direction: "incoming",
        stage: "decoded",
        payload: {
          method: "error",
          params: {
            threadId: "native-thread",
            turnId: "native-turn",
            error: {
              code: "unauthorized",
              message: '{"message":"Unauthorized","Authorization":"Bearer secret-token"}',
            },
            history: "x".repeat(128 * 1_024),
          },
        },
      });

      const serialized = encodeUnknownJson(writes);
      assert.equal(writes.length, 1);
      assert.isBelow(serialized.length, 2_048);
      assert.notInclude(serialized, "secret-token");
      assert.include(serialized, "[REDACTED]");
      assert.nestedPropertyVal(writes[0], "event.payload.params.error.code", "unauthorized");
      assert.nestedPropertyVal(writes[0], "event.payload.params.turnId", "native-turn");
    }),
  );

});

describe("CodexAdapterV2 rollback mapping", () => {
  it.effect("derives the native rollback boundary from durable provider turns", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const providerThreadId = ProviderThreadId.make("provider-thread-codex-rollback");
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerSessionId: ProviderSessionId.make("provider-session-codex-rollback"),
        appThreadId: ThreadId.make("thread-codex-rollback"),
        ownerNodeId: null,
        nativeThreadRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: "native-thread-codex-rollback",
          strength: "strong",
        },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 3,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      };
      const providerTurn = (
        id: string,
        ordinal: number,
        status: OrchestrationV2ProviderTurn["status"],
      ): OrchestrationV2ProviderTurn => ({
        id: ProviderTurnId.make(id),
        providerThreadId,
        nodeId: NodeId.make(`node-${id}`),
        runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
        nativeTurnRef: {
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeId: `native-${id}`,
          strength: "strong",
        },
        ordinal,
        status,
        startedAt: now,
        completedAt: status === "running" || status === "pending" ? null : now,
      });
      const firstTurn = providerTurn("provider-turn-first", 1, "completed");
      const secondTurn = providerTurn("provider-turn-second", 2, "completed");
      const runningTurn = providerTurn("provider-turn-running", 3, "running");
      const interruptedTurn = providerTurn("provider-turn-interrupted", 4, "interrupted");
      // `/goal` control turns never reached Codex, so revert must not count them.
      const goalCommandTurn = {
        ...providerTurn("provider-turn-goal-command", 5, "completed"),
        nativeTurnRef: null,
      };

      const boundary = yield* CodexAdapterV2.resolveCodexRollbackBoundary({
        providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-first"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [goalCommandTurn, interruptedTurn, runningTurn, secondTurn, firstTurn],
      });

      assert.deepEqual(boundary, { firstTurnId: "native-provider-turn-second", turnCount: 2 });
    }),
  );
});

describe("CodexAdapterV2 fork boundary", () => {
  const providerThreadId = ProviderThreadId.make("provider-thread-codex-fork-boundary");
  const makeProviderThread = (now: DateTime.Utc): OrchestrationV2ProviderThread => ({
    id: providerThreadId,
    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: ProviderSessionId.make("provider-session-codex-fork-boundary"),
    appThreadId: ThreadId.make("thread-codex-fork-boundary"),
    ownerNodeId: null,
    nativeThreadRef: {
      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
      nativeId: "native-thread-codex-fork-boundary",
      strength: "strong",
    },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: 1,
    lastRunOrdinal: 2,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  });
  const makeProviderTurn = (
    id: string,
    ordinal: number,
    nativeId: string | null,
    now: DateTime.Utc,
  ): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(id),
    providerThreadId,
    nodeId: NodeId.make(`node-${id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${id}`),
    nativeTurnRef:
      nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId, strength: "strong" },
    ordinal,
    status: "completed",
    startedAt: now,
    completedAt: now,
  });

  it.effect("resolves the selected provider turn to an inclusive native fork boundary", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-first",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("resolves the latest source turn to a native fork boundary without rollback", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: secondTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, {
        lastTurnId: "native-turn-second",
        rollbackTurnCount: 0,
      });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn lacks a native id", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, null, now);
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("keeps the rollback-count fallback when the boundary turn has no native ref", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn: OrchestrationV2ProviderTurn = {
        ...makeProviderTurn("provider-turn-first", 1, "native-turn-first", now),
        nativeTurnRef: null,
      };
      const secondTurn = makeProviderTurn("provider-turn-second", 2, "native-turn-second", now);

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        sourceProviderTurns: [firstTurn, secondTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 1 });
    }),
  );

  it.effect("forks at head without a boundary when no provider turn is selected", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;

      const boundary = yield* CodexAdapterV2.resolveCodexForkBoundary({
        sourceProviderThread: makeProviderThread(now),
        targetThreadId: ThreadId.make("thread-codex-fork-target"),
      });

      assert.deepEqual(boundary, { lastTurnId: undefined, rollbackTurnCount: 0 });
    }),
  );

  it.effect("fails with a typed error when the selected source turn is missing", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const firstTurn = makeProviderTurn("provider-turn-first", 1, "native-turn-first", now);

      const error = yield* Effect.flip(
        CodexAdapterV2.resolveCodexForkBoundary({
          sourceProviderThread: makeProviderThread(now),
          sourceProviderTurns: [firstTurn],
          providerTurnId: ProviderTurnId.make("provider-turn-missing"),
          targetThreadId: ThreadId.make("thread-codex-fork-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
      assert.include(String(error.cause), "provider-turn-missing");
    }),
  );
});

describe("CodexAdapterV2 skill mentions", () => {
  it("sends currency-sigil skill mentions as the $ mention Codex parses", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["€review do it", "$review do it"],
      ["£ship", "$ship"],
      ["please ¥review this diff", "please $review this diff"],
      ["first line\n₹ship it", "first line\n$ship it"],
      ["𑿝review then €2spec", "$review then $2spec"],
      ["$review", "$review"],
      ["costs €20", "costs €20"],
      ["€5k", "€5k"],
      ["budget €100M or €1e6", "budget €100M or €1e6"],
      ["5€review", "5€review"],
    ];
    for (const [text, expected] of cases) {
      assert.equal(CodexAdapterV2.codexSkillMentionText(text), expected, text);
    }
  });
});

describe("CodexAdapterV2 background command detail", () => {
  it("summarizes command, exit code, and output tail", () => {
    assert.equal(
      CodexAdapterV2.codexBackgroundCommandDetail({
        command: "sleep 20 && echo CODEX_BG_WAKE_DONE",
        exitCode: 0,
        aggregatedOutput: "CODEX_BG_WAKE_DONE\n",
      }),
      "Background command completed (exit 0): sleep 20 && echo CODEX_BG_WAKE_DONE\n\n" +
        "Output tail:\nCODEX_BG_WAKE_DONE",
    );
  });

  it("omits the output section and exit code when absent", () => {
    assert.equal(
      CodexAdapterV2.codexBackgroundCommandDetail({
        command: "sleep 20",
        exitCode: null,
        aggregatedOutput: null,
      }),
      "Background command completed: sleep 20",
    );
  });

  it("truncates long commands and keeps only the output tail", () => {
    const detail = CodexAdapterV2.codexBackgroundCommandDetail({
      command: "x".repeat(300),
      exitCode: 1,
      aggregatedOutput: `${"y".repeat(2000)}TAIL`,
    });
    assert.include(detail, `(exit 1): ${"x".repeat(200)}...`);
    assert.include(detail, "Output tail:\n...");
    assert.include(detail, "TAIL");
    assert.notInclude(detail, "y".repeat(1001));
  });
});

const DEFAULT_CODEX_SETTINGS = Schema.decodeSync(CodexSettings)({});
const CODEX_TEST_MODEL_SELECTION = {
  instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
  model: "gpt-5.4",
} satisfies ModelSelection;
const CODEX_TEST_RUNTIME_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: "/workspace",
});

function makeCodexTestAppThread(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Codex continuation test",
    providerInstanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function makeCodexTestTurnInput(input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly attemptId: RunAttemptId;
  readonly text: string;
}): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: makeCodexTestAppThread(input),
    threadId: input.threadId,
    runId: RunId.make(`run-${input.attemptId}`),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: input.attemptId,
    rootNodeId: NodeId.make(`node-${input.attemptId}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message-${input.attemptId}`),
      text: input.text,
      attachments: [],
    },
    modelSelection: CODEX_TEST_MODEL_SELECTION,
    runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
  };
}

function makeCodexReplayTurn(input: {
  readonly id: string;
  readonly status: "inProgress" | "completed" | "interrupted" | "failed";
}): Record<string, unknown> {
  const terminal =
    input.status === "completed" || input.status === "interrupted" || input.status === "failed";
  return {
    id: input.id,
    items: [],
    itemsView: "notLoaded",
    status: input.status,
    error: null,
    startedAt: 1782622440,
    completedAt: terminal ? 1782622450 : null,
    durationMs: null,
  };
}

function codexReplayPreamble(input: {
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly prompt: string;
  /** Text the adapter should send, when it differs from what the user typed. */
  readonly sentPrompt?: string;
  readonly effort?: string;
}): Array<CodexReplay.CodexAppServerReplayEntry> {
  return [
    {
      type: "expect_outbound",
      label: "initialize",
      frame: {
        id: 1,
        method: "initialize",
        params: {
          clientInfo: { name: "Caveman Code", title: "Caveman Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "initialize",
      frame: {
        id: 1,
        result: {
          userAgent: "Caveman Code/0.156.1",
          codexHome: "/tmp/codex-home",
          platformFamily: "unix",
          platformOs: "macos",
        },
      },
    },
    { type: "expect_outbound", label: "initialized", frame: { method: "initialized" } },
    {
      type: "expect_outbound",
      label: "thread/start",
      frame: {
        id: 2,
        method: "thread/start",
        params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG },
      },
    },
    {
      type: "emit_inbound",
      label: "thread/start",
      frame: {
        id: 2,
        result: {
          thread: {
            id: input.nativeThreadId,
            sessionId: input.nativeThreadId,
            projectId: null,
            forkedFromId: null,
            preview: "",
            ephemeral: false,
            modelProvider: "openai",
            createdAt: 1782622440,
            updatedAt: 1782622440,
            status: { type: "idle" },
            path: `/tmp/${input.nativeThreadId}.jsonl`,
            cwd: "/workspace",
            cliVersion: "0.144.0",
            source: "vscode",
            threadSource: null,
            agentNickname: null,
            agentRole: null,
            gitInfo: null,
            name: null,
            turns: [],
          },
          model: "gpt-5.4",
          modelProvider: "openai",
          serviceTier: null,
          cwd: "/workspace",
          instructionSources: [],
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
          reasoningEffort: "medium",
        },
      },
    },
    {
      type: "expect_outbound",
      label: "turn/start",
      frame: {
        id: 3,
        method: "turn/start",
        params: {
          threadId: input.nativeThreadId,
          input: [{ type: "text", text: input.sentPrompt ?? input.prompt }],
          cwd: "/workspace",
          model: "gpt-5.4",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          summary: "detailed",
          ...(input.effort === undefined ? {} : { effort: input.effort }),
          collaborationMode: {
            mode: "default",
            settings: {
              model: "gpt-5.4",
              ...(input.effort === undefined ? {} : { reasoning_effort: input.effort }),
            },
          },
        },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/start",
      frame: {
        id: 3,
        result: { turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }) },
      },
    },
    {
      type: "emit_inbound",
      label: "turn/started",
      frame: {
        method: "turn/started",
        params: {
          threadId: input.nativeThreadId,
          turn: makeCodexReplayTurn({ id: input.nativeTurnId, status: "inProgress" }),
        },
      },
    },
  ];
}

function makeCodexReplayTranscript(input: {
  readonly scenario: string;
  readonly entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>;
}): CodexReplay.CodexAppServerReplayTranscript {
  return {
    provider: "codex",
    protocol: "codex.app-server",
    version: "0.144.0",
    scenario: input.scenario,
    entries: input.entries,
  };
}

function withReplayRequestId(
  entry: CodexReplay.CodexAppServerReplayEntry,
  id: number,
): CodexReplay.CodexAppServerReplayEntry {
  return entry.type !== "runtime_exit" && Predicate.isObject(entry.frame)
    ? { ...entry, frame: { ...entry.frame, id } }
    : entry;
}

describe("CodexAdapterV2 session initialize", () => {
  const openReplaySession = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    beforeEmitInbound?: CodexReplay.CodexAppServerReplayDriver["beforeEmitInbound"],
    settings: CodexSettings = DEFAULT_CODEX_SETTINGS,
  ) =>
    Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(
        transcript,
        beforeEmitInbound === undefined ? {} : { beforeEmitInbound },
      );
      let initializeRequests = 0;
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings,
        environment: {},
        clientFactory: {
          open: (openInput) =>
            Layer.build(CodexReplay.layerReplayWithDriver(driver)).pipe(
              Effect.flatMap((context) =>
                Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context)),
              ),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "initialize") initializeRequests++;
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
      });
      const runtime = yield* adapter.openSession({
        threadId: ThreadId.make(`thread-${transcript.scenario}`),
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      return {
        ensureThread: (threadId: string) =>
          runtime.ensureThread({
            threadId: ThreadId.make(threadId),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        initializeRequests: () => initializeRequests,
      };
    });

  const replayPreamble = (nativeThreadId: string) =>
    codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });

  it.effect("leaves web search to the person's own config.toml in the home Codex runs on", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "codex-own-web-search-" });
      yield* fileSystem.writeFileString(path.join(home, "config.toml"), 'web_search = "live"\n');
      const { web_search: _cached, ...config } = CodexAdapterV2.CODEX_THREAD_CONFIG;
      // The replay fails on a thread/start whose config differs: this one has no web_search.
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "own-web-search",
          entries: replayPreamble("own-web-search")
            .slice(0, 5)
            .map((entry) =>
              entry.type === "expect_outbound" && entry.label === "thread/start"
                ? { ...entry, frame: { id: 2, method: "thread/start", params: { config } } }
                : entry,
            ),
        }),
        undefined,
        { ...DEFAULT_CODEX_SETTINGS, homePath: home },
      );
      const providerThread = yield* session.ensureThread("thread-own-web-search");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "own-web-search");
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect("a chat's session takes the app-server started ahead of it: one launch, one initialize", () =>
    Effect.gen(function* () {
      const transcript = makeCodexReplayTranscript({ scenario: "warm-app-server", entries: replayPreamble("warm-app-server").slice(0, 5) });
      const driver = yield* CodexReplay.makeReplayDriver(transcript, {});
      let opens = 0;
      let initializeRequests = 0;
      const released: Array<string> = [];
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory: {
          open: (openInput) =>
            Effect.sync(() => void opens++).pipe(
              Effect.andThen(Layer.build(CodexReplay.layerReplayWithDriver(driver))),
              Effect.flatMap((context) => Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context))),
              Effect.map(
                (client) =>
                  ({
                    ...client,
                    request: (method, params) =>
                      Effect.sync(() => {
                        if (method === "initialize") initializeRequests++;
                      }).pipe(Effect.andThen(client.request(method, params))),
                  }) satisfies CodexClient.CodexAppServerClient["Service"],
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
      });
      const threadId = ThreadId.make("thread-warm-app-server");
      // Started (and initialized) as the person types, before the chat's session opens.
      yield* adapter.prewarmThread!({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        releaseMcp: Effect.sync(() => void released.push(threadId)),
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-warm-app-server"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      assert.equal(providerThread.nativeThreadRef?.nativeId, "warm-app-server");
      // The session's app-server is the one started ahead: no second launch, no second handshake.
      assert.equal(opens, 1);
      assert.equal(initializeRequests, 1);
      // Taken, it keeps the chat's credential.
      assert.deepEqual(released, []);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect("an app-server started ahead and never taken gives the chat's credential back as it goes", () =>
    Effect.gen(function* () {
      const released: Array<string> = [];
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        // Still starting when the chat goes.
        clientFactory: { open: () => Effect.never },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig("warm-app-server-unused").pipe(Effect.orDie),
      });
      const threadId = ThreadId.make("thread-warm-app-server-unused");
      yield* adapter.prewarmThread!({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        releaseMcp: Effect.sync(() => void released.push(threadId)),
      });
      yield* adapter.releasePrewarm!(threadId);
      assert.deepEqual(released, [threadId]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  /** An adapter whose app-servers replay `transcript`, recording what the adapter sends. */
  const warmReplayAdapter = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    hooks: Pick<CodexAdapterV2.CodexAdapterV2Options, "onUsageLimits"> = {},
  ) =>
    Effect.gen(function* () {
      const driver = yield* CodexReplay.makeReplayDriver(transcript, {});
      const sent: Array<{ readonly method: string; readonly params: unknown }> = [];
      // Notifications the app-server's handlers have taken in.
      const heard: Array<string> = [];
      let opens = 0;
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        ...hooks,
        clientFactory: {
          open: (openInput) =>
            Effect.sync(() => void opens++).pipe(
              Effect.andThen(Layer.build(CodexReplay.layerReplayWithDriver(driver))),
              Effect.flatMap((context) => Effect.service(CodexClient.CodexAppServerClient).pipe(Effect.provide(context))),
              Effect.map(
                (client): CodexAdapterV2.CodexEgressClient => ({
                  ...client,
                  request: (method, params) =>
                    Effect.sync(() => void sent.push({ method, params })).pipe(Effect.andThen(client.request(method, params))),
                  handleServerNotification: (method, handler) =>
                    client.handleServerNotification(method, (payload) => handler(payload).pipe(Effect.ensuring(Effect.sync(() => void heard.push(method))))),
                  // The app's retrieve server: its start-up status decides whether a turn asks for it.
                  compressionRetrieveExpected: () => true,
                }),
              ),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterOpenSessionError({
                    driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                    providerSessionId: openInput.providerSessionId,
                    cause,
                  }),
              ),
            ),
        },
        digest: yield* Digest.Digest,
        fileSystem: yield* FileSystem.FileSystem,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        serverConfig: yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie),
      });
      const waitFor = (done: Effect.Effect<boolean>, what: Effect.Effect<string>) =>
        Effect.gen(function* () {
          // Real time (the test clock stands still): the adapter reads files on the way.
          for (let attempt = 0; attempt < 2000; attempt++) {
            if (yield* done) return;
            yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 1)));
          }
          return yield* Effect.die(yield* what);
        });
      /** Waits until the app-server has replayed `count` entries. */
      const replayed = (count: number) =>
        waitFor(
          Ref.get(driver.state).pipe(Effect.map((state) => state.cursor >= count)),
          Ref.get(driver.state).pipe(Effect.map((state) => `The app-server replayed ${state.cursor} of ${count} entries: ${state.failure?.message ?? "no failure"}.`)),
        );
      /** Waits until the app-server's handlers have taken in these notifications. */
      const hasHeard = (...methods: ReadonlyArray<string>) =>
        waitFor(Effect.sync(() => methods.every((method) => heard.includes(method))), Effect.sync(() => `Heard only ${heard.join(", ")}.`));
      return { adapter, sent, opens: () => opens, replayed, hasHeard };
    });
  const putMcpSession = (threadId: ThreadId, token: string) =>
    Effect.flatMap(McpProviderSessions.McpProviderSessions, (sessions) =>
      sessions.set({
        environmentId: EnvironmentId.make("test"),
        threadId,
        providerSessionId: `mcp-${token}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: `Bearer ${token}`,
        browserToolsAvailable: true,
      }),
    );

  it.effect("a new chat's thread starts ahead with its credential; its session takes it, hears what Codex said meanwhile, and runs no SessionStart hook again", () =>
    Effect.gen(function* () {
      const nativeThreadId = "thread-ahead";
      const developerInstructions = "Follow the space's rules.";
      const hooksRun: Array<string> = [];
      const plugins = SessionPlugins.SessionPlugins.of({
        acp: () => Effect.succeed([]),
        claudeAgent: () => Effect.die("not used by Codex"),
        // Reading the thread's plugins runs their SessionStart hooks.
        codex: (threadId) => Effect.sync(() => (hooksRun.push(threadId), { config: { mcp_servers: {} }, developerInstructions })),
      });
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" }).map((entry) =>
        entry.type === "expect_outbound" && entry.label === "thread/start"
          ? { ...entry, frame: { id: 2, method: "thread/start", params: { config: CodexAdapterV2.CODEX_THREAD_CONFIG, developerInstructions } } }
          : entry,
      );
      const limits: Array<unknown> = [];
      const { adapter, sent, opens, replayed, hasHeard } = yield* warmReplayAdapter(
        makeCodexReplayTranscript({
          scenario: "thread-ahead",
          entries: [
            ...preamble.slice(0, 5),
            // Said while no session listens yet: its retrieve server is up, and the account's limits.
            {
              type: "emit_inbound",
              label: "retrieve startup",
              frame: { method: "mcpServer/startupStatus/updated", params: { threadId: nativeThreadId, name: "caveman", status: "ready" } },
            },
            {
              type: "emit_inbound",
              label: "account/rateLimits/updated",
              frame: { method: "account/rateLimits/updated", params: { rateLimits: { limitId: "codex", primary: { usedPercent: 40, resetsAt: 2000100000, windowDurationMins: 300 } } } },
            },
          ],
        }),
        { onUsageLimits: (update) => Effect.sync(() => void limits.push(update)) },
      ).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
      const threadId = ThreadId.make("thread-ahead-chat");
      yield* putMcpSession(threadId, "minted-at-prewarm");
      yield* adapter.prewarmThread!({ threadId, modelSelection: CODEX_TEST_MODEL_SELECTION, runtimePolicy: CODEX_TEST_RUNTIME_POLICY });
      // The thread is started and Codex has spoken before the chat's session opens.
      yield* replayed(7);
      yield* hasHeard("mcpServer/startupStatus/updated", "account/rateLimits/updated");
      assert.deepEqual(limits, []);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-thread-ahead"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      assert.equal(limits.length, 1);
      const providerThread = yield* runtime.ensureThread({ threadId, modelSelection: CODEX_TEST_MODEL_SELECTION, runtimePolicy: CODEX_TEST_RUNTIME_POLICY });
      assert.equal(providerThread.nativeThreadRef?.nativeId, nativeThreadId);
      // One app-server, one thread, started with the chat's credential minted at prewarm.
      assert.equal(opens(), 1);
      const starts = sent.filter(({ method }) => method === "thread/start");
      assert.equal(starts.length, 1);
      const servers = CodexAdapterV2.codexMcpServersOf((starts[0]!.params as { config: Record<string, unknown> }).config) as Record<string, { http_headers?: Record<string, string> }>;
      assert.deepEqual(
        Object.values(servers).map((server) => server.http_headers?.Authorization),
        ["Bearer minted-at-prewarm", "Bearer minted-at-prewarm"],
      );
      // The plugins' SessionStart hooks ran once, as the thread started ahead; not again as the chat took it.
      assert.deepEqual(hooksRun, [threadId]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect("a thread started ahead that the chat does not run on is deleted: the chat asks for another model, or never comes", () =>
    Effect.gen(function* () {
      const preamble = (nativeThreadId: string) => codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" });
      const deleted = (id: number, threadId: string): Array<CodexReplay.CodexAppServerReplayEntry> => [
        { type: "expect_outbound", label: "thread/delete", frame: { id, method: "thread/delete", params: { threadId } } },
        { type: "emit_inbound", label: "thread/delete", frame: { id, result: {} } },
      ];
      // The chat comes with another model: the thread started ahead goes, and its own starts as asked.
      const other = yield* warmReplayAdapter(
        makeCodexReplayTranscript({
          scenario: "thread-ahead-other-model",
          entries: [...preamble("ahead").slice(0, 5), ...deleted(3, "ahead"), ...preamble("asked").slice(3, 5).map((entry) => withReplayRequestId(entry, 4))],
        }),
      );
      const chat = ThreadId.make("thread-ahead-other-model");
      yield* other.adapter.prewarmThread!({ threadId: chat, modelSelection: CODEX_TEST_MODEL_SELECTION, runtimePolicy: CODEX_TEST_RUNTIME_POLICY });
      yield* other.replayed(5);
      const runtime = yield* other.adapter.openSession({
        threadId: chat,
        providerSessionId: ProviderSessionId.make("provider-session-thread-ahead-other-model"),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const asked = { ...CODEX_TEST_MODEL_SELECTION, model: "gpt-5.5" };
      const providerThread = yield* runtime.ensureThread({ threadId: chat, modelSelection: asked, runtimePolicy: CODEX_TEST_RUNTIME_POLICY });
      assert.equal(providerThread.nativeThreadRef?.nativeId, "asked");
      assert.deepEqual(
        other.sent.filter(({ method }) => method.startsWith("thread/")).map(({ method, params }) => [method, (params as { model?: string; threadId?: string }).model ?? (params as { threadId?: string }).threadId]),
        [["thread/start", CODEX_TEST_MODEL_SELECTION.model], ["thread/delete", "ahead"], ["thread/start", "gpt-5.5"]],
      );
      // The spare goes unused: its thread is deleted as its app-server stops, and its credential is given back.
      const unused = yield* warmReplayAdapter(
        makeCodexReplayTranscript({ scenario: "thread-ahead-unused", entries: [...preamble("unused-ahead").slice(0, 5), ...deleted(3, "unused-ahead")] }),
      );
      const released: Array<string> = [];
      const spare = ThreadId.make("thread-ahead-unused");
      yield* unused.adapter.prewarmThread!({
        threadId: spare,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        releaseMcp: Effect.sync(() => void released.push(spare)),
      });
      yield* unused.replayed(5);
      yield* unused.adapter.releasePrewarm!(spare);
      yield* unused.replayed(7);
      assert.deepEqual(released, [spare]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
    ),
  );

  it.effect("sends one initialize when two threads start on a fresh session at once", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      // The transcript allows exactly one handshake: a second `initialize`
      // frame fails the replay, as Codex rejects it with "Already initialized".
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "concurrent-initialize",
          entries: [
            ...replayPreamble("concurrent-first").slice(0, 5),
            ...replayPreamble("concurrent-second")
              .slice(3, 5)
              .map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const first = yield* session
        .ensureThread("thread-concurrent-first")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      // The second thread arrives while the handshake is still unanswered.
      const second = yield* session
        .ensureThread("thread-concurrent-second")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThreads = [yield* Fiber.join(first), yield* Fiber.join(second)];
      assert.equal(session.initializeRequests(), 1);
      assert.sameMembers(
        providerThreads.map((providerThread) => providerThread.nativeThreadRef?.nativeId),
        ["concurrent-first", "concurrent-second"],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("retries initialize after a failed handshake", () =>
    Effect.gen(function* () {
      const preamble = replayPreamble("initialize-retry");
      const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
        ...preamble.slice(0, 1),
        {
          type: "emit_inbound",
          label: "initialize",
          frame: { id: 1, error: { code: -32603, message: "Codex is not ready." } },
        },
        ...preamble.slice(0, 2).map((entry) => withReplayRequestId(entry, 2)),
        ...preamble.slice(2, 3),
        ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
      ];
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({ scenario: "initialize-retry", entries }),
      );

      const failure = yield* session.ensureThread("thread-initialize-retry").pipe(Effect.flip);
      assert.equal(failure._tag, "ProviderAdapterEnsureThreadError");
      const providerThread = yield* session.ensureThread("thread-initialize-retry");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-retry");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("completes the handshake after a caller is interrupted mid-initialize", () =>
    Effect.gen(function* () {
      const initializeAwaitingResponse = yield* Deferred.make<void>();
      const releaseInitialize = yield* Deferred.make<void>();
      const preamble = replayPreamble("initialize-interrupted");
      const session = yield* openReplaySession(
        makeCodexReplayTranscript({
          scenario: "initialize-interrupted",
          entries: [
            ...preamble.slice(0, 2),
            // Codex handled the interrupted caller's `initialize`, so it
            // rejects the next one.
            ...preamble.slice(0, 1).map((entry) => withReplayRequestId(entry, 2)),
            {
              type: "emit_inbound",
              label: "initialize-rejected",
              frame: { id: 2, error: { code: -32600, message: "Already initialized" } },
            },
            ...preamble.slice(2, 3),
            ...preamble.slice(3, 5).map((entry) => withReplayRequestId(entry, 3)),
          ],
        }),
        (entry) =>
          entry.label === "initialize"
            ? Deferred.succeed(initializeAwaitingResponse, undefined).pipe(
                Effect.andThen(Deferred.await(releaseInitialize)),
              )
            : Effect.void,
      );

      const interrupted = yield* session
        .ensureThread("thread-initialize-interrupted")
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* Deferred.await(initializeAwaitingResponse);
      yield* Fiber.interrupt(interrupted);
      yield* Deferred.succeed(releaseInitialize, undefined);

      const providerThread = yield* session.ensureThread("thread-initialize-interrupted");
      assert.equal(providerThread.nativeThreadRef?.nativeId, "initialize-interrupted");
      assert.equal(session.initializeRequests(), 2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );
});

describe("CodexAdapterV2 post-settle continuation", () => {
  const awaitUntil = (predicate: () => boolean, label: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 5000; attempt++) {
        if (predicate()) {
          return;
        }
        yield* Effect.yieldNow;
      }
      return yield* Effect.die(`Timed out waiting for ${label}.`);
    });

  const makeCodexReplayHarness = (
    transcript: CodexReplay.CodexAppServerReplayTranscript,
    onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<unknown> = () =>
      Effect.void,
    onRequest: (method: string, params: unknown) => Effect.Effect<void> = () => Effect.void,
    readChildMetadata?: Parameters<typeof withCodexReplayChildMetadata>[2],
    retrieveExpected = false,
    promptSuggestions: Effect.Effect<boolean> = Effect.succeed(false),
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const serverConfig = yield* makeReplayServerConfig(transcript.scenario).pipe(Effect.orDie);
      const continuationRequests: Array<ProviderContinuationRequests.ProviderContinuationRequest> =
        [];
      let replayDriver: CodexReplay.CodexAppServerReplayDriver | undefined;
      const clientFactory: CodexAdapterV2.CodexAppServerClientFactoryShape = {
        open: (openInput) =>
          CodexReplay.makeReplayDriver(transcript).pipe(
            Effect.tap((driver) => Effect.sync(() => (replayDriver = driver))),
            Effect.flatMap((driver) => Layer.build(CodexReplay.layerReplayWithDriver(driver))),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                  providerSessionId: openInput.providerSessionId,
                  cause,
                }),
            ),
            Effect.flatMap((context) =>
              Effect.service(CodexClient.CodexAppServerClient).pipe(
                Effect.map((client) =>
                  withCodexReplayChildMetadata(client, transcript, readChildMetadata),
                ),
                Effect.map(
                  (client) =>
                    ({
                      ...client,
                      compressionRetrieveExpected: () => retrieveExpected,
                      request: (method, params) =>
                        onRequest(method, params).pipe(
                          Effect.andThen(client.request(method, params)),
                        ),
                      // thread/resume goes through the raw client.
                      raw: {
                        ...client.raw,
                        request: (method, params) =>
                          onRequest(method, params).pipe(
                            Effect.andThen(client.raw.request(method, params)),
                          ),
                      },
                    }) satisfies CodexAdapterV2.CodexEgressClient,
                ),
                Effect.provide(context),
              ),
            ),
          ),
      };
      const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
        instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
        settings: DEFAULT_CODEX_SETTINGS,
        environment: {},
        clientFactory,
        digest: yield* Digest.Digest,
        fileSystem,
        idAllocator,
        serverConfig,
        continuationRequests: {
          offer: (request) =>
            Effect.sync(() => {
              continuationRequests.push(request);
            }),
        },
      });
      const threadId = ThreadId.make(`thread-${transcript.scenario}`);
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-${transcript.scenario}`),
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        promptSuggestions,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: CODEX_TEST_MODEL_SELECTION,
        runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
      });
      const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      const firstTerminal = yield* Deferred.make<void>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            events.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "turn.terminal"
                ? Deferred.succeed(firstTerminal, undefined)
                : Effect.void,
            ),
            Effect.andThen(onEvent(event)),
          ),
        ),
        Effect.forkScoped,
      );
      if (runtime.hasPendingBackgroundWork === undefined) {
        return yield* Effect.die("Codex adapter runtime must expose hasPendingBackgroundWork.");
      }
      const hasPendingBackgroundWork = runtime.hasPendingBackgroundWork;
      const terminalEvents = () =>
        events.filter(
          (
            event,
          ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn.terminal" }> =>
            event.type === "turn.terminal",
        );
      const subagentUpdates = () =>
        events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "subagent.updated" }
          > => event.type === "subagent.updated",
        );
      return {
        runtime,
        providerThread,
        threadId,
        serverConfig,
        events,
        continuationRequests,
        terminalEvents,
        subagentUpdates,
        hasPendingBackgroundWork,
        firstTerminal: Deferred.await(firstTerminal),
        until: (predicate: () => boolean) => awaitUntil(predicate, "the replay condition"),
        awaitTerminal: (count: number) =>
          awaitUntil(() => terminalEvents().length >= count, `${count} terminal event(s)`),
        /** How far the latest app-server's replay got, once it ended, failed or stopped moving. */
        replayProgress: Effect.gen(function* () {
          const read = () =>
            replayDriver === undefined
              ? Effect.succeed({ cursor: 0, failure: null })
              : Ref.get(replayDriver.state);
          for (let attempt = 0; attempt < 5000; attempt++) {
            const state = yield* read();
            if (state.cursor >= transcript.entries.length || state.failure !== null) break;
            yield* Effect.yieldNow;
          }
          const state = yield* read();
          return {
            cursor: state.cursor,
            failure: state.failure === null ? null : state.failure.message,
          };
        }),
      };
    });

  // Native image generation is Caveman-specific; neither T3 reference handles these items.
  describe("native image generation", () => {
    type NativeImage = Extract<CodexSchema.V2ItemCompletedNotification__ThreadItem, { type: "imageGeneration" }>;
    const image = (fields: Partial<NativeImage> = {}): NativeImage => ({
      type: "imageGeneration", id: "native-image", status: "in_progress", result: "", ...fields,
    });
    const revisedPrompt = "A pixel caveman holding a blue flower";
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWZkAAAAASUVORK5CYII=";
    const limitError = "Image generation usage limit exceeded (image_generation). Resets at 1782623000 (Unix seconds).";
    const cases: ReadonlyArray<{
      name: string;
      start: NativeImage | null;
      completion: NativeImage | null;
      turnStatus?: "completed" | "interrupted" | "failed";
      expectedStatus: "completed" | "failed" | "interrupted" | "cancelled";
      expectedInput?: { revised_prompt: string };
      expectedOutput?: unknown;
    }> = [
      {
        name: "saved path preferred over large base64",
        start: image({ revisedPrompt }),
        completion: image({ status: "completed", savedPath: "/tmp/nonexistent-native-image.png", result: "A".repeat(1024 * 1024), revisedPrompt, transparentBackground: true }),
        expectedStatus: "completed", expectedInput: { revised_prompt: revisedPrompt },
        expectedOutput: { saved_path: "/tmp/nonexistent-native-image.png", revised_prompt: revisedPrompt, transparent_background: true },
      },
      {
        name: "base64 fallback and late prompt",
        start: image(),
        completion: image({ status: "completed", savedPath: null, result: png, revisedPrompt, transparentBackground: false }),
        expectedStatus: "completed", expectedInput: { revised_prompt: revisedPrompt },
        expectedOutput: { result: png, revised_prompt: revisedPrompt, transparent_background: false },
      },
      {
        name: "completion without start and non-enum status",
        start: null, completion: image({ status: "done", result: png }),
        expectedStatus: "completed", expectedOutput: { result: png },
      },
      {
        name: "native completed status on start",
        start: image({ status: "completed", result: png }), completion: null,
        expectedStatus: "completed", expectedOutput: { result: png },
      },
      {
        name: "native failed status without image",
        start: image(), completion: image({ status: "failed" }),
        expectedStatus: "failed", expectedOutput: { error: "Image generation failed (failed)." },
      },
      {
        name: "structured quota failure overrides completed status",
        start: image(), completion: image({ status: "completed", failure: { type: "usageLimitExceeded", limitId: "image_generation", resetsAt: 1782623000 } }),
        expectedStatus: "failed", expectedOutput: { error: limitError },
      },
      {
        name: "quota failure on start without reset time",
        start: image({ failure: { type: "usageLimitExceeded", limitId: "images", resetsAt: null } }), completion: null,
        expectedStatus: "failed", expectedOutput: { error: "Image generation usage limit exceeded (images)." },
      },
      {
        name: "empty completed image is not a success",
        start: image(), completion: image({ status: "completed", savedPath: "", revisedPrompt: null, transparentBackground: null }),
        expectedStatus: "failed", expectedOutput: { error: "Image generation completed without an image." },
      },
      // Codex 0.165 keeps new images in its attachment store and sends a file id, not the bytes.
      {
        name: "stored image with a saved path",
        start: image({ revisedPrompt }),
        completion: { type: "imageGeneration", id: "native-image", status: "completed", fileId: "file_native", savedPath: "/tmp/nonexistent-native-image.png", revisedPrompt },
        expectedStatus: "completed", expectedInput: { revised_prompt: revisedPrompt },
        expectedOutput: { saved_path: "/tmp/nonexistent-native-image.png", revised_prompt: revisedPrompt },
      },
      {
        name: "stored image without a saved path",
        start: image(), completion: { type: "imageGeneration", id: "native-image", status: "completed", fileId: "file_native" },
        expectedStatus: "failed", expectedOutput: { error: "Image generation completed without an image." },
      },
      ...(["interrupted", "failed", "completed"] as const).map((turnStatus) => ({
        name: `${turnStatus} turn finalizes unfinished generation`,
        start: image({ revisedPrompt }), completion: null, turnStatus,
        expectedStatus: turnStatus === "completed" ? "cancelled" as const : turnStatus,
        expectedInput: { revised_prompt: revisedPrompt },
      })),
    ];

    it.effect.each(cases)("$name", (testCase) =>
      Effect.gen(function* () {
        const nativeThreadId = "image-thread";
        const nativeTurnId = "image-turn";
        const prompt = "Generate an image.";
        const startedAtMs = 1782622445000;
        const notifications: Array<CodexReplay.CodexAppServerReplayEntry> = [];
        for (const [phase, item] of [["started", testCase.start], ["completed", testCase.completion]] as const) {
          if (item === null) continue;
          notifications.push({
            type: "emit_inbound", label: `image/${phase}`,
            frame: { method: `item/${phase}`, params: {
              threadId: nativeThreadId, turnId: nativeTurnId, item,
              ...(phase === "started" ? { startedAtMs } : { completedAtMs: startedAtMs + 1000 }),
            } },
          });
        }
        const harness = yield* makeCodexReplayHarness(makeCodexReplayTranscript({
          scenario: `native-image-${testCase.name.replace(/\W+/g, "-")}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            ...notifications,
            { type: "emit_inbound", label: "turn/completed", frame: { method: "turn/completed", params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: testCase.turnStatus ?? "completed" }),
            } } },
          ],
        }));
        yield* harness.runtime.startTurn(makeCodexTestTurnInput({
          threadId: harness.threadId, providerThread: harness.providerThread, now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-native-image"), text: prompt,
        }));
        yield* harness.firstTerminal;

        const itemEvents = harness.events.filter((event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool");
        const items = itemEvents.flatMap((event) => event.type === "turn_item.updated" && event.turnItem.type === "dynamic_tool" ? [event.turnItem] : []);
        assert.isNotEmpty(items, "native image notifications must produce dynamic tools");
        const finalItem = items.at(-1)!;
        assert.equal(finalItem.toolName, "image_generation");
        assert.equal(finalItem.status, testCase.expectedStatus);
        assert.deepEqual(finalItem.input, testCase.expectedInput ?? {});
        const expectedRaw = testCase.expectedOutput as { result?: string } | undefined;
        let expectedOutput = testCase.expectedOutput;
        if (expectedRaw?.result !== undefined) {
          const { result, ...metadata } = expectedRaw;
          const saved = (finalItem.output as { saved_path: string }).saved_path;
          assert.equal(NodePath.dirname(saved), harness.serverConfig.attachmentsDir);
          assert.deepEqual(NodeFS.readFileSync(saved), Buffer.from(result, "base64"));
          expectedOutput = { ...metadata, saved_path: saved };
        }
        assert.deepEqual(finalItem.output, expectedOutput);
        assert.isNotNull(finalItem.completedAt);
        assert.isTrue(items.every((item) => item.id === finalItem.id && item.ordinal === finalItem.ordinal && item.nodeId === finalItem.nodeId));
        if (testCase.start !== null) assert.equal(finalItem.startedAt?.epochMilliseconds, startedAtMs);
        const startsRunning = testCase.start !== null && testCase.start.failure == null && testCase.start.status !== "completed";
        assert.deepEqual(items.map((item) => item.status), startsRunning ? ["running", testCase.expectedStatus] : [testCase.expectedStatus]);
        const nodes = harness.events.flatMap((event) => event.type === "node.updated" && event.node.id === finalItem.nodeId ? [event.node] : []);
        assert.deepEqual(nodes.map((node) => node.status), items.map((item) => item.status));
        assert.isTrue(nodes.every((node) => node.kind === "tool_call" && node.nativeItemRef?.nativeId === "native-image"));
        assert.isBelow(harness.events.indexOf(itemEvents.at(-1)!), harness.events.findIndex((event) => event.type === "turn.terminal"));
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.deepEqual(harness.continuationRequests, []);

        // The ordinary-chat production boundary, not a raw adapter-only projection.
        const state = emptyThreadState();
        const projected = items.flatMap((item) => projectEvent(state,
          projectDomainEventForWire({ type: "turn-item.updated", payload: item } as OrchestrationV2DomainEvent),
          { at: "2026-06-28T00:00:00.000Z", displayText: () => undefined },
        ).events);
        const starts = projected.filter((event) => event.type === "tool.started");
        const done = projected.filter((event) => event.type === "tool.done");
        assert.isNotEmpty(starts);
        assert.deepEqual(starts.at(-1)!.payload, { name: "image_generation", title: "image_generation", kind: "other", input: testCase.expectedInput ?? {} });
        assert.lengthOf(done, 1);
        assert.deepEqual(done[0]!.payload, {
          status: testCase.expectedStatus === "interrupted" || testCase.expectedStatus === "cancelled" ? "declined" : testCase.expectedStatus,
          ...(expectedOutput === undefined ? {} : { result: testCase.expectedStatus === "failed" ? { ...expectedOutput as object, isError: true } : expectedOutput }),
          ...(testCase.expectedStatus === "failed" && testCase.expectedOutput !== undefined ? { error: (testCase.expectedOutput as { error: string }).error } : {}),
        });
        assert.equal(done[0]!.item_id, starts[0]!.item_id);
      }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))),
    );
  });

  it.effect.each([true, false])("reports app retrieve startup changes, excluding user servers (%s)", (expected) =>
    Effect.gen(function* () {
      const nativeThreadId = "retrieve-startup";
      const nativeTurnId = "retrieve-turn";
      const prompt = "check retrieve";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const status = (state: string, threadId = nativeThreadId): CodexReplay.CodexAppServerReplayEntry => ({
        type: "emit_inbound", label: "retrieve startup",
        frame: { method: "mcpServer/startupStatus/updated", params: { threadId, name: "caveman", status: state, ...(state === "failed" ? { error: "probe failed to connect" } : {}) } },
      });
      const harness = yield* makeCodexReplayHarness(makeCodexReplayTranscript({
        scenario: `retrieve-startup-${expected}`,
        entries: [
          ...preamble.slice(0, 5),
          ...(expected ? [
            { type: "expect_outbound" as const, label: "retrieve inventory", frame: { id: 3, method: "mcpServerStatus/list", params: { threadId: nativeThreadId, serverName: "caveman", detail: "toolsAndAuthOnly" } } },
            { type: "emit_inbound" as const, label: "retrieve inventory", frame: { id: 3, result: { data: [], nextCursor: null } } },
          ] : []),
          ...preamble.slice(5).map((entry) => expected && "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame ? { ...entry, frame: { ...entry.frame, id: 4 } } : entry),
          status("failed"), status("ready"), status("ready"), status("failed", "unrelated-thread"), status("failed"),
        ],
      }), () => Effect.void, () => Effect.void, undefined, expected);
      yield* harness.runtime.startTurn(makeCodexTestTurnInput({
        threadId: harness.threadId, providerThread: harness.providerThread, now: yield* DateTime.now,
        attemptId: RunAttemptId.make("retrieve-startup"), text: prompt,
      }));
      const statuses = () => harness.events.flatMap((event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice" && event.turnItem.compressionRetrieveStatus !== undefined ? [event.turnItem.compressionRetrieveStatus] : []);
      yield* awaitUntil(() => !expected || statuses().length === 3, "retrieve startup changes");
      assert.deepEqual(statuses(), expected ? ["failed", "connected", "failed"] : []);
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("checks retrieve inventory when startup notifications were missed", () => Effect.gen(function* () {
    const nativeThreadId = "retrieve-inventory";
    const nativeTurnId = "retrieve-inventory-turn";
    const prompt = "check retrieve";
    const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
    const harness = yield* makeCodexReplayHarness(makeCodexReplayTranscript({
      scenario: "retrieve-inventory",
      entries: [
        ...preamble.slice(0, 5),
        { type: "expect_outbound", label: "retrieve inventory", frame: { id: 3, method: "mcpServerStatus/list", params: { threadId: nativeThreadId, serverName: "caveman", detail: "toolsAndAuthOnly" } } },
        { type: "emit_inbound", label: "retrieve inventory", frame: { id: 3, result: { data: [], nextCursor: null } } },
        ...preamble.slice(5).map((entry) => "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame ? { ...entry, frame: { ...entry.frame, id: 4 } } : entry),
      ],
    }), () => Effect.void, () => Effect.void, undefined, true);
    yield* harness.runtime.startTurn(makeCodexTestTurnInput({
      threadId: harness.threadId, providerThread: harness.providerThread, now: yield* DateTime.now,
      attemptId: RunAttemptId.make("retrieve-inventory"), text: prompt,
    }));
    yield* awaitUntil(() => harness.events.some((event) => event.type === "turn_item.updated" && event.turnItem.type === "system_notice" && event.turnItem.compressionRetrieveStatus === "failed"), "retrieve inventory failure");
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))));

  it.effect.each(["before", "after"] as const)(
    "rejects a previous run's native turn when it completes %s the new start response",
    (completionOrder) =>
      Effect.gen(function* () {
        const nativeThreadId = "reused-turn-thread";
        const nativeTurnId = "reused-turn";
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const retry = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "retry-turn",
          prompt: "work",
        });
        const completion: CodexReplay.CodexAppServerReplayEntry = {
          type: "emit_inbound",
          label: "original turn completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        };
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: `reused-turn-${completionOrder}`,
            entries: [
              ...preamble,
              withReplayRequestId(preamble[5]!, 4),
              ...(completionOrder === "before" ? [completion] : []),
              withReplayRequestId(preamble[6]!, 4),
              ...(completionOrder === "after" ? [completion] : []),
              ...retry.slice(5, 7).map((entry) => withReplayRequestId(entry, 5)),
              {
                type: "emit_inbound",
                label: "retry completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: "retry-turn", status: "completed" }),
                  },
                },
              },
            ],
          }),
        );
        const first = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("original"),
          text: "work",
        });
        yield* harness.runtime.startTurn(first);
        const result = yield* harness.runtime
          .startTurn({
            ...first,
            runId: RunId.make("replacement"),
            attemptId: RunAttemptId.make("replacement"),
            rootNodeId: NodeId.make("replacement"),
            runOrdinal: 2,
            providerTurnOrdinal: 2,
          })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure", "a different run must not adopt the original turn");
        if (result._tag !== "Failure") return;
        const failure = result.failure;
        assert.equal(failure._tag, "ProviderAdapterTurnStartError");
        assert.instanceOf(failure.cause, ProviderAdapter.ProviderAdapterProtocolError);
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.runOrdinal),
          [1],
        );
        yield* harness.runtime.startTurn({
          ...first,
          runId: RunId.make("retry"),
          attemptId: RunAttemptId.make("retry"),
          rootNodeId: NodeId.make("retry"),
          runOrdinal: 3,
          providerTurnOrdinal: 3,
        });
        yield* harness.awaitTerminal(2);
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.runOrdinal, event.status]),
          [
            [1, "completed"],
            [3, "completed"],
          ],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
  );

  it.effect.each(["supported", "unsupported", "invalid"] as const)(
    "delivers native history with %s app-server protocol",
    (response) =>
      Effect.gen(function* () {
        const nativeThreadId = `inject-${response}`;
        const prompt = "Only the current request";
        const history: ProviderAdapter.ProviderAdapterV2HistoricalContext = {
          context: "Historical conversation",
          messages: (["user", "assistant"] as const).map((role) => ({
            role,
            text:
              role === "user"
                ? "Original request\n" + "界".repeat(300)
                : "Partial interrupted work",
            threadId: ThreadId.make("source"),
            runId: RunId.make("source-run"),
            itemId: TurnItemId.make(`source-${role}`),
            providerThreadId: null,
            kind: `${role}_message`,
            status: "interrupted",
          })),
        };
        const items = historyResponseItems(history.messages, history.context);
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "current-turn",
          prompt,
        });
        const transcript = makeCodexReplayTranscript({
          scenario: `inject-${response}`,
          entries: [
            ...preamble.slice(0, -3),
            {
              type: "expect_outbound",
              label: "inject",
              frame: {
                id: 3,
                method: "thread/inject_items",
                params: { threadId: nativeThreadId, items },
              },
            },
            {
              type: "emit_inbound",
              label: "inject-result",
              frame:
                response === "supported"
                  ? { id: 3, result: {} }
                  : {
                      id: 3,
                      error: {
                        code: response === "unsupported" ? -32601 : -32602,
                        message: "Injection rejected",
                      },
                    },
            },
            ...(response === "invalid"
              ? []
              : preamble
                  .slice(-3)
                  .map((entry) =>
                    "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry, frame: { ...entry.frame, id: 4 } }
                      : entry,
                  )),
          ],
        });
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const injection = yield* harness.runtime.injectHistory!({
          providerThread: harness.providerThread,
          ...history,
        }).pipe(Effect.result);
        if (response === "invalid") {
          assert.equal(injection._tag, "Failure");
          if (injection._tag === "Failure") {
            assert.equal(injection.failure._tag, "ProviderAdapterProtocolError");
            assert.propertyVal(injection.failure.cause, "code", -32602);
            assert.notProperty(injection.failure, "payload");
          }
          assert.notInclude(requests, "turn/start");
          return;
        }
        assert.equal(injection._tag, "Success");
        if (injection._tag === "Success") assert.equal(injection.success, response === "supported");
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("inject-attempt"),
            text: prompt,
          }),
        );
        assert.equal(requests.filter((method) => method === "turn/start").length, 1);
        assert.isBelow(requests.indexOf("thread/inject_items"), requests.indexOf("turn/start"));
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  it.effect("adds the session MCP server without replacing launch-argument servers", () =>
    Effect.gen(function* () {
      const scenario = "launch-mcp-servers";
      yield* (yield* McpProviderSessions.McpProviderSessions).set({
        environmentId: EnvironmentId.make("environment-codex-mcp"),
        threadId: ThreadId.make(`thread-${scenario}`),
        providerSessionId: `provider-session-${scenario}`,
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1:43123/mcp",
        authorizationHeader: "Bearer secret-codex-token",
        browserToolsAvailable: true,
      });
      const requests: Array<unknown> = [];
      yield* makeCodexReplayHarness(
        makeCodexReplayTranscript({
          scenario,
          entries: codexReplayPreamble({
            nativeThreadId: "launch-mcp-thread",
            nativeTurnId: "unused",
            prompt: "unused",
          }).slice(0, 5),
        }),
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/start") requests.push(params);
          }),
      );
      assert.deepEqual(requests, [
        {
          cwd: "/workspace",
          model: "gpt-5.4",
          config: {
            ...CodexAdapterV2.CODEX_THREAD_CONFIG,
            "mcp_servers.caveman-code": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer secret-codex-token" },
              disabled_tools: ["thread_wait"],
              tools: { desktop: { approval_mode: "approve" } },
            },
            "mcp_servers.caveman-code-direct": {
              url: "http://127.0.0.1:43123/mcp",
              tool_timeout_sec: 3_900,
              http_headers: { Authorization: "Bearer secret-codex-token" },
              enabled_tools: ["thread_wait"],
              omit_tools_from: ["code_mode", "deferred"],
            },
            // The thread's commands see their chat (dev servers show under it).
            "shell_environment_policy.set.CAVEMAN_CODE_THREAD_ID": "thread-launch-mcp-servers",
          },
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("replays historical and dotted MCP config while enforcing other thread config", () =>
    Effect.gen(function* () {
      const recordedServer = {
        url: "http://127.0.0.1:41000/mcp",
        http_headers: { Authorization: "Bearer recorded-token" },
      };
      const currentConfig = {
        "tools.update_plan.enabled": true,
        "mcp_servers.caveman-code": {
          url: "http://127.0.0.1:42000/mcp",
          http_headers: { Authorization: "Bearer current-token" },
        },
        "mcp_servers.extra.command": "cat",
      };
      for (const recordedMcp of [
        { mcp_servers: { "caveman-code": recordedServer } },
        { "mcp_servers.caveman-code": recordedServer, "mcp_servers.extra.command": "echo" },
      ]) {
        const entries = codexReplayPreamble({
          nativeThreadId: "replayed-mcp-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        })
          .slice(3, 5)
          .map((entry) => withReplayRequestId(entry, 1));
        entries[0] = {
          type: "expect_outbound",
          frame: {
            id: 1,
            method: "thread/start",
            params: { config: { "tools.update_plan.enabled": true, ...recordedMcp } },
          },
        };
        entries.push({
          ...entries[0],
          frame: {
            id: 2,
            method: "thread/start",
            params: { config: { "tools.update_plan.enabled": true, ...recordedMcp } },
          },
        });
        const driver = yield* CodexReplay.makeReplayDriver(
          makeCodexReplayTranscript({
            scenario: "mcp-config-normalization",
            entries,
          }),
        );
        yield* Effect.gen(function* () {
          const client = yield* CodexClient.CodexAppServerClient;
          const response = yield* client.request("thread/start", { config: currentConfig });
          assert.equal(response.thread.id, "replayed-mcp-thread");
          assert.isNull((yield* Ref.get(driver.state)).failure);
          yield* client
            .request("thread/start", {
              config: { ...currentConfig, "tools.update_plan.enabled": false },
            })
            .pipe(Effect.flip);
          assert.instanceOf(
            (yield* Ref.get(driver.state)).failure,
            CodexReplay.CodexAppServerReplayFrameMismatchError,
          );
        }).pipe(Effect.provide(CodexReplay.layerReplayWithDriver(driver)));
      }
    }).pipe(Effect.scoped),
  );

  it.effect("identifies sessions to Codex with the same client info as main", () =>
    Effect.gen(function* () {
      const transcript = makeCodexReplayTranscript({
        scenario: "initialize-client-info",
        entries: codexReplayPreamble({
          nativeThreadId: "client-info-thread",
          nativeTurnId: "unused",
          prompt: "unused",
        }).slice(0, 5),
      });
      const initializeParams: Array<unknown> = [];
      yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "initialize") initializeParams.push(params);
          }),
      );
      // Codex uses clientInfo.name as the request originator. Replays ignore the
      // version, so pin the whole value here.
      assert.deepEqual(initializeParams, [
        {
          clientInfo: { name: "Caveman Code", title: "Caveman Code", version: packageJson.version },
          capabilities: {
            experimentalApi: true,
            optOutNotificationMethods: ["turn/diff/updated"],
            extensions: {
              "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] },
            },
          },
        },
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("unsubscribes from the native thread when it is unloaded", () =>
    Effect.gen(function* () {
      const nativeThreadId = "unload-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "unload-thread",
        entries: [
          // initialize + thread/start only; no turn runs.
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          // Response shape recorded from codex app-server 0.156.1.
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 3, result: { status: "unsubscribed" } },
          },
        ],
      });
      const requests: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) => Effect.sync(() => requests.push(method)),
      );
      assert.isDefined(harness.runtime.unloadThread);
      yield* harness.runtime.unloadThread!({ providerThread: harness.providerThread });
      assert.deepEqual(requests, ["initialize", "thread/start", "thread/unsubscribe"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("keeps the app-server failure as the cause when an unload is rejected", () =>
    Effect.gen(function* () {
      const nativeThreadId = "unload-thread-rejected";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "unused",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "unload-thread-rejected",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/unsubscribe",
            frame: { id: 3, method: "thread/unsubscribe", params: { threadId: nativeThreadId } },
          },
          {
            type: "emit_inbound",
            label: "thread/unsubscribe",
            frame: { id: 3, error: { code: -32600, message: "invalid thread id" } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const error = yield* harness.runtime.unloadThread!({
        providerThread: harness.providerThread,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterProtocolError");
      const cause = error._tag === "ProviderAdapterProtocolError" ? error.cause : undefined;
      assert.equal((cause as { _tag?: string } | undefined)?._tag, "CodexAppServerRequestError");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("waits for native start before interrupting an acknowledged queued turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-await-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/started",
            afterMs: 1000,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
              },
            },
          },
          {
            type: "expect_outbound",
            label: "turn/interrupt",
            frame: {
              id: 4,
              method: "turn/interrupt",
              params: { threadId: nativeThreadId, turnId: nativeTurnId },
            },
          },
          { type: "emit_inbound", label: "turn/interrupt", frame: { id: 4, result: {} } },
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "interrupted" }),
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("settles Stop when a queued native turn fails before starting", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-failed-before-native-start",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/failed",
            afterMs: 1000,
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                  startedAt: null,
                  error: {
                    message: "Failed before native start",
                    codexErrorInfo: null,
                    additionalDetails: null,
                  },
                },
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.forkScoped);
      yield* TestClock.adjust("500 millis");
      assert.isFalse(interruptSent, "Stop must not reach Codex before native turn/started");
      yield* TestClock.adjust("500 millis");
      yield* Fiber.join(interrupt);
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "failed");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(interruptSent, "A terminal native turn must not receive turn/interrupt");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("bounds Stop when a queued native turn never starts", () =>
    Effect.gen(function* () {
      const nativeThreadId = "early-stop-thread";
      const nativeTurnId = "early-stop-turn";
      const prompt = "Run a command.";
      const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
      const transcript = makeCodexReplayTranscript({
        scenario: "early-stop-never-starts",
        entries: [
          ...preamble.slice(0, -2),
          {
            type: "emit_inbound",
            label: "turn/start/queued",
            frame: {
              id: 3,
              result: {
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                  startedAt: null,
                },
              },
            },
          },
        ],
      });
      let interruptSent = false;
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            if (method === "turn/interrupt") interruptSent = true;
          }),
      );
      yield* harness.runtime.startTurn(
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("early-stop-attempt"),
          text: prompt,
        }),
      );
      const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
        driver: CodexAdapterV2.CODEX_DRIVER_KIND,
        nativeTurnId,
      });
      const interrupt = yield* harness.runtime
        .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
        .pipe(Effect.exit, Effect.forkScoped);
      yield* TestClock.adjust("10 seconds");
      assert.equal((yield* Fiber.join(interrupt))._tag, "Failure");
      yield* harness.firstTerminal;
      assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      assert.lengthOf(harness.terminalEvents(), 1);
      assert.isFalse(interruptSent, "An unstarted native turn must not receive turn/interrupt");
      assert.isFalse(yield* harness.hasPendingBackgroundWork);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("sends currency-sigil skill mentions to Codex as $ mentions", () =>
    Effect.gen(function* () {
      const nativeThreadId = "skill-sigil-thread";
      const nativeTurnId = "skill-sigil-turn";
      const transcript = makeCodexReplayTranscript({
        scenario: "skill-sigil-canonicalized",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId,
            prompt: "€review do it",
            sentPrompt: "$review do it",
          }),
          {
            type: "expect_outbound",
            label: "turn/steer",
            frame: {
              id: 4,
              method: "turn/steer",
              params: {
                expectedTurnId: nativeTurnId,
                input: [{ type: "text", text: "then $ship it" }],
                threadId: nativeThreadId,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "turn/steer",
            frame: { id: 4, result: { turnId: nativeTurnId } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const turnInput = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("skill-sigil-attempt"),
        text: "€review do it",
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.runtime.steerTurn({
        threadId: harness.threadId,
        runId: turnInput.runId,
        providerThread: harness.providerThread,
        providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeTurnId,
        }),
        message: {
          ...turnInput.message,
          messageId: MessageId.make("message-skill-sigil-steer"),
          text: "then £ship it",
        },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect.each(["subagent", "toggled-off"] as const)(
    "never samples a suggestion for a %s thread",
    (delegation) =>
      Effect.gen(function* () {
        const nativeThreadId = `suggest-${delegation}-thread`;
        const prompt = "Continue the task.";
        const first = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: `${delegation}-turn-1`,
          prompt,
        });
        const second = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: `${delegation}-turn-2`,
          prompt,
        });
        const completed = (nativeTurnId: string): CodexReplay.CodexAppServerReplayEntry => ({
          type: "emit_inbound",
          label: `${nativeTurnId} completed`,
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        });
        // The second turn is a barrier: a stray sample from the first turn is sent before it ends.
        const requests: Array<string> = [];
        const enabled = yield* Ref.make(true);
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: `prompt-suggestion-${delegation}`,
            entries: [
              ...first,
              completed(`${delegation}-turn-1`),
              ...second.slice(5, 7).map((entry) => withReplayRequestId(entry, 4)),
              completed(`${delegation}-turn-2`),
            ],
          }),
          undefined,
          (method) => Effect.sync(() => requests.push(method)),
          undefined,
          false,
          Ref.get(enabled),
        );
        // The flag is read per turn: turning it off after the session opened stops sampling.
        if (delegation === "toggled-off") yield* Ref.set(enabled, false);
        const base = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(`${delegation}-attempt-1`),
          text: prompt,
        });
        const parentThreadId = ThreadId.make("thread-codex-suggestion-parent");
        const turn = {
          ...base,
          appThread:
            delegation === "toggled-off"
              ? base.appThread
              : {
                  ...base.appThread,
                  lineage: {
                    parentThreadId,
                    relationshipToParent: "subagent" as const,
                    rootThreadId: parentThreadId,
                  },
                },
        };
        yield* harness.runtime.startTurn(turn);
        yield* harness.awaitTerminal(1);
        yield* harness.runtime.startTurn({
          ...turn,
          runId: RunId.make(`${delegation}-run-2`),
          attemptId: RunAttemptId.make(`${delegation}-attempt-2`),
          rootNodeId: NodeId.make(`${delegation}-root-2`),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        });
        yield* harness.awaitTerminal(2);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed", "completed"],
        );
        assert.notInclude(requests, "thread/sample");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  it.effect("samples a next-prompt suggestion after a completed root turn", () =>
    Effect.gen(function* () {
      const nativeThreadId = "suggest-thread";
      const nativeTurnId = "suggest-turn";
      const prompt = "Add a subtract function.";
      const transcript = makeCodexReplayTranscript({
        scenario: "prompt-suggestion",
        entries: [
          ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
          {
            type: "emit_inbound",
            label: "turn/completed",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
              },
            },
          },
          {
            type: "expect_outbound",
            label: "thread/sample",
            frame: {
              id: 4,
              method: "thread/sample",
              params: {
                threadId: nativeThreadId,
                expectedTurnId: nativeTurnId,
                prompt: CodexAdapterV2.CODEX_PROMPT_SUGGESTION_PROMPT,
                effort: "low",
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/sample",
            frame: {
              id: 4,
              result: {
                sourceTurnId: nativeTurnId,
                responseId: "resp-suggest",
                text: "  add tests for subtract\n",
                inputTokens: 11448,
                cachedInputTokens: 11264,
                outputTokens: 16,
              },
            },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(
        transcript,
        undefined,
        undefined,
        undefined,
        false,
        Effect.succeed(true),
      );
      const turnInput = makeCodexTestTurnInput({
        threadId: harness.threadId,
        providerThread: harness.providerThread,
        now: yield* DateTime.now,
        attemptId: RunAttemptId.make("suggest-attempt"),
        text: prompt,
      });
      yield* harness.runtime.startTurn(turnInput);
      yield* harness.until(() =>
        harness.events.some((event) => event.type === "prompt_suggestion.updated"),
      );
      assert.deepEqual(
        harness.events.filter((event) => event.type === "prompt_suggestion.updated"),
        [
          {
            type: "prompt_suggestion.updated",
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            threadId: harness.threadId,
            runId: turnInput.runId,
            text: "add tests for subtract",
          },
        ],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  const assistantMessages = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.filter(
      (
        event,
      ): event is Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "message.updated" }> =>
        event.type === "message.updated" && event.message.role === "assistant",
    );
  const assistantTurnItems = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
        ? [event.turnItem]
        : [],
    );

  it.effect("keeps an asynchronous Codex question actionable after the turn completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "async-question-thread";
        const nativeTurnId = "async-question-turn";
        const usage = {
          totalTokens: 15,
          inputTokens: 10,
          cachedInputTokens: 2,
          outputTokens: 5,
          reasoningOutputTokens: 1,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "async-question-and-billed-usage",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Continue while I decide.",
            }),
            {
              type: "emit_inbound",
              label: "question",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: {
                    type: "agentMessage",
                    id: "async-question-item",
                    text: "Which branch?",
                    delivery: "async",
                    questions: [{ title: "Which branch?", options: ["main", "dev"] }],
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "usage",
              frame: {
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("async-question-attempt"),
            text: "Continue while I decide.",
          }),
        );
        yield* harness.firstTerminal;
        const requests = harness.events.flatMap((event) =>
          event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
        );
        assert.lengthOf(requests, 1);
        assert.equal(requests[0]?.status, "pending");
        assert.deepEqual(requests[0]?.responseCapability, { type: "message" });
        const questionItem = harness.events.find(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "user_input_request",
        );
        assert.equal(questionItem?.type, "turn_item.updated");
        if (
          questionItem?.type === "turn_item.updated" &&
          questionItem.turnItem.type === "user_input_request"
        ) {
          assert.deepEqual(
            questionItem.turnItem.questions[0]?.options.map((option) => option.label),
            ["main", "dev"],
          );
          assert.equal(questionItem.turnItem.responseMode, "message");
        }
        const questionNode = harness.events.find(
          (event) => event.type === "node.updated" && event.node.id === requests[0]?.nodeId,
        );
        assert.equal(
          questionNode?.type === "node.updated" && questionNode.node.countsForRun,
          false,
        );
        const contextReport = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.tokenUsage !== undefined,
        );
        assert.equal(contextReport?.type, "provider_turn.updated");
        if (contextReport?.type === "provider_turn.updated") {
          assert.equal(
            contextReport.providerTurn.runAttemptId,
            RunAttemptId.make("async-question-attempt"),
          );
          assert.equal(contextReport.providerTurn.providerThreadId, harness.providerThread.id);
          assert.equal(contextReport.providerTurn.tokenUsage?.usedTokens, 15);
          assert.equal(contextReport.providerTurn.tokenUsage?.maxTokens, 200_000);
        }
        const completed = harness.events.find(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "completed",
        );
        assert.equal(completed?.type, "provider_turn.updated");
        if (completed?.type === "provider_turn.updated") {
          assert.deepEqual(completed.providerTurn.turnTokenUsage, {
            usageStatus: "complete",
            usageScope: "main_agent",
            hasSubagents: false,
            inputTokens: 10,
            cachedInputTokens: 2,
            outputTokens: 5,
            reasoningTokens: 1,
          });
        }
        assert.isEmpty(assistantMessages(harness.events));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect("stops asking for commands the user allowed for the session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "session-approval-thread";
        const turnIds = [
          "session-approval-turn-1",
          "session-approval-turn-2",
          "session-approval-turn-3",
        ];
        const turnPolicies = {
          "approval-required": {
            approvalPolicy: "untrusted",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "readOnly" },
          },
          "full-access": {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            sandboxPolicy: { type: "dangerFullAccess" },
          },
        } as const;
        const turnModes = ["approval-required", "full-access", "approval-required"] as const;
        const turnText = (index: number) => `Review round ${index + 1}.`;
        const startTurn = (index: number): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "expect_outbound",
            label: `turn ${index + 1} turn/start`,
            frame: {
              id: 3 + index,
              method: "turn/start",
              params: {
                threadId: nativeThreadId,
                input: [{ type: "text", text: turnText(index) }],
                cwd: "/workspace",
                model: "gpt-5.4",
                ...turnPolicies[turnModes[index]!],
                summary: "detailed",
                collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
              },
            },
          },
          {
            type: "emit_inbound",
            label: `turn ${index + 1} turn/start`,
            frame: {
              id: 3 + index,
              result: { turn: makeCodexReplayTurn({ id: turnIds[index]!, status: "inProgress" }) },
            },
          },
          turnEvent("turn/started", turnIds[index]!),
        ];
        const approval = (input: {
          readonly id: number;
          readonly turnId: string;
          readonly kind: "commandExecution" | "fileChange";
          readonly itemId: string;
          readonly decision: string;
        }): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            label: `${input.itemId} approval`,
            frame: {
              id: input.id,
              method: `item/${input.kind}/requestApproval`,
              params: {
                threadId: nativeThreadId,
                turnId: input.turnId,
                itemId: input.itemId,
                startedAtMs: 1782622441000,
                ...(input.kind === "commandExecution" ? { command: `cat ${input.itemId}` } : {}),
              },
            },
          },
          {
            type: "expect_outbound",
            label: `${input.itemId} decision`,
            frame: { id: input.id, result: { decision: input.decision } },
          },
        ];
        const turnEvent = (
          method: "turn/started" | "turn/completed",
          turnId: string,
        ): CodexReplay.CodexAppServerReplayEntry => ({
          type: "emit_inbound",
          label: `${turnId} ${method}`,
          frame: {
            method,
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({
                id: turnId,
                status: method === "turn/started" ? "inProgress" : "completed",
              }),
            },
          },
        });
        const [patchRequest, patchDecision] = approval({
          id: 102,
          turnId: turnIds[0]!,
          kind: "fileChange",
          itemId: "first-patch",
          decision: "acceptForSession",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-session-approvals",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: turnIds[0]!,
              prompt: turnText(0),
            }).slice(0, -3),
            ...startTurn(0),
            ...approval({
              id: 100,
              turnId: turnIds[0]!,
              kind: "commandExecution",
              itemId: "first-command",
              decision: "acceptForSession",
            }),
            // Only commands were allowed, so a file change still asks. The user
            // answers it after the turn ended and the mode changed.
            patchRequest!,
            // Answered without asking: Codex alone would ask for every new command.
            ...approval({
              id: 101,
              turnId: turnIds[0]!,
              kind: "commandExecution",
              itemId: "second-command",
              decision: "acceptForSession",
            }),
            turnEvent("turn/completed", turnIds[0]!),
            ...startTurn(1),
            patchDecision!,
            turnEvent("turn/completed", turnIds[1]!),
            ...startTurn(2),
            // Back in the first mode, neither allowance comes back.
            ...approval({
              id: 103,
              turnId: turnIds[2]!,
              kind: "commandExecution",
              itemId: "third-command",
              decision: "accept",
            }),
            ...approval({
              id: 104,
              turnId: turnIds[2]!,
              kind: "fileChange",
              itemId: "second-patch",
              decision: "accept",
            }),
            turnEvent("turn/completed", turnIds[2]!),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const requests = () => [
          ...new Map(
            harness.events.flatMap((event) =>
              event.type === "runtime_request.updated"
                ? [[event.runtimeRequest.id, event.runtimeRequest] as const]
                : [],
            ),
          ).values(),
        ];
        const answer = (
          count: number,
          kind: "command" | "file-change",
          decision: ProviderApprovalDecision,
        ) =>
          Effect.gen(function* () {
            yield* awaitUntil(() => requests().length === count, `approval request ${count}`);
            const request = requests()[count - 1]!;
            assert.equal(request.kind, kind);
            yield* harness.runtime.respondToRuntimeRequest({ requestId: request.id, decision });
          });

        const runTurn = (index: number) =>
          Effect.gen(function* () {
            yield* harness.runtime.startTurn({
              ...makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`session-approvals-${index + 1}`),
                text: turnText(index),
              }),
              runOrdinal: index + 1,
              providerTurnOrdinal: index + 1,
              runtimePolicy: { ...CODEX_TEST_RUNTIME_POLICY, runtimeMode: turnModes[index]! },
            });
          });

        yield* runTurn(0);
        yield* answer(1, "command", "acceptForSession");
        yield* awaitUntil(() => requests().length === 2, "file change request");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "turn 1");
        yield* runTurn(1);
        yield* answer(2, "file-change", "acceptForSession");
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "turn 2");
        yield* runTurn(2);
        yield* answer(3, "command", "accept");
        yield* answer(4, "file-change", "accept");
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "turn 3");
        assert.lengthOf(requests(), 4);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("preserves T3 context on the wire and restores it after compaction", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "context-thread";
        const nativeTurnId = "context-turn";
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId,
          codexInput: [{ type: "text", text: "work" }],
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          hasCavemanMcp: true,
        });
        assert.include(
          params.additionalContext?.caveman_code_orchestration_01?.value ?? "",
          "delegate_task",
        );
        const entries = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "work" });
        const transcript = makeCodexReplayTranscript({
          scenario: "restore-context",
          entries: [
            ...entries.slice(0, 5),
            {
              type: "expect_outbound",
              label: "context turn",
              frame: { id: 3, method: "turn/start", params },
            },
            ...entries.slice(6),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  item: { type: "contextCompaction", id: "compact-context" },
                },
              },
            },
            {
              type: "expect_outbound",
              label: "restore context",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: Object.entries(params.additionalContext ?? {}).map(([key, entry]) => ({
                    type: "message",
                    role: "developer",
                    content: [{ type: "input_text", text: `<${key}>${entry.value}</${key}>` }],
                  })),
                },
              },
            },
            { type: "emit_inbound", label: "restored", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "done",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId: harness.threadId,
          providerSessionId: "context-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: true,
        });
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("context-attempt"),
            text: "work",
          }),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("compacts Codex with the native RPC and completes the compaction turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "compact-thread";
        const nativeTurnId = "compact-turn";
        const item = { type: "contextCompaction", id: "compact-item" };
        const transcript = makeCodexReplayTranscript({
          scenario: "native-compaction",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "unused" }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "compact",
              frame: {
                id: 3,
                method: "thread/compact/start",
                params: { threadId: nativeThreadId },
              },
            },
            { type: "emit_inbound", label: "compact", frame: { id: 3, result: {} } },
            {
              type: "emit_inbound",
              label: "start",
              frame: {
                method: "turn/started",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }),
                },
              },
            },
            ...(["item/started", "item/completed"] as const).map((method) => ({
              type: "emit_inbound" as const,
              label: method,
              frame: { method, params: { threadId: nativeThreadId, turnId: nativeTurnId, item } },
            })),
            {
              type: "emit_inbound",
              label: "complete",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        assert.isDefined(harness.runtime.compactThread);
        yield* harness.runtime.compactThread!(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("compact-attempt"),
            text: "/compact",
          }),
        );
        yield* harness.firstTerminal;
        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "compaction"
            ? [event.turnItem]
            : [],
        );
        assert.deepEqual(
          items.map((entry) => entry.status),
          ["running", "completed"],
        );
        assert.equal(items[0]?.id, items[1]?.id);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect.each(["failed", "interrupted", "Stop"] as const)(
    "settles unfinished compaction on %s without changing completed compaction",
    (outcome) =>
      Effect.scoped(
        Effect.gen(function* () {
          const nativeThreadId = "compact-thread";
          const nativeTurnId = "compact-turn";
          const error = {
            message: "Remote compaction stream disconnected",
            codexErrorInfo: "other",
            additionalDetails: null,
          };
          const transcript = makeCodexReplayTranscript({
            scenario: `automatic-compaction-${outcome}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
              ...(
                [
                  { method: "item/started", id: "completed-item", startedAtMs: 1782622441000 },
                  { method: "item/completed", id: "completed-item", completedAtMs: 1782622442000 },
                  { method: "item/started", id: "unfinished-item", startedAtMs: 1782622443000 },
                ] as const
              ).map(({ method, id, ...timestamps }) => ({
                type: "emit_inbound" as const,
                label: `${method}/${id}`,
                frame: {
                  method,
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    item: { type: "contextCompaction", id },
                    ...timestamps,
                  },
                },
              })),
              ...(outcome === "Stop"
                ? [
                    {
                      type: "expect_outbound" as const,
                      label: "turn/interrupt",
                      frame: {
                        id: 4,
                        method: "turn/interrupt",
                        params: { threadId: nativeThreadId, turnId: nativeTurnId },
                      },
                    },
                    {
                      type: "emit_inbound" as const,
                      label: "turn/interrupt/failed",
                      frame: { id: 4, error: { code: -32_000, message: "Interrupt failed" } },
                    },
                  ]
                : [
                    {
                      type: "emit_inbound" as const,
                      label: "turn/completed",
                      frame: {
                        method: "turn/completed",
                        params: {
                          threadId: nativeThreadId,
                          turn: {
                            ...makeCodexReplayTurn({ id: nativeTurnId, status: outcome }),
                            error: outcome === "failed" ? error : null,
                          },
                        },
                      },
                    },
                  ]),
            ],
          });
          const compactionStarted = yield* Deferred.make<ProviderTurnId>();
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.nativeItemRef?.nativeId === "unfinished-item" &&
            event.turnItem.status === "running" &&
            event.turnItem.providerTurnId !== null
              ? Deferred.succeed(compactionStarted, event.turnItem.providerTurnId)
              : Effect.void,
          );
          yield* TestClock.setTime(1782622445000);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`compact-${outcome}-attempt`),
              text: "Continue.",
            }),
          );
          if (outcome === "Stop") {
            const providerTurnId = yield* Deferred.await(compactionStarted);
            const interrupt = yield* harness.runtime
              .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
              .pipe(Effect.exit);
            assert.equal(interrupt._tag, "Failure");
          }
          yield* harness.firstTerminal;
          const items = harness.events.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "compaction"
              ? [event.turnItem]
              : [],
          );
          const completed = items.filter(
            (item) => item.nativeItemRef?.nativeId === "completed-item",
          );
          const unfinished = items.filter(
            (item) => item.nativeItemRef?.nativeId === "unfinished-item",
          );
          const status = outcome === "failed" ? "failed" : "interrupted";
          assert.deepEqual(
            unfinished.map((item) => item.status),
            ["running", status],
          );
          assert.equal(unfinished[0]?.id, unfinished[1]?.id);
          assert.deepEqual(unfinished[1]?.startedAt, DateTime.makeUnsafe(1782622443000));
          assert.deepEqual(
            unfinished[1]?.completedAt,
            DateTime.makeUnsafe(outcome === "Stop" ? 1782622445000 : 1782622450000),
          );
          assert.deepEqual(
            completed.map((item) => item.status),
            ["running", "completed"],
          );
          assert.deepEqual(completed[1]?.startedAt, DateTime.makeUnsafe(1782622441000));
          assert.deepEqual(completed[1]?.completedAt, DateTime.makeUnsafe(1782622442000));
          assert.equal(harness.terminalEvents()[0]?.status, status);
          if (outcome === "failed") {
            assert.equal(harness.terminalEvents()[0]?.failure?.message, error.message);
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect.each([
    { hook: "stopped", status: "interrupted", expected: true },
    { hook: "completed", status: "interrupted", expected: false },
    { hook: "warning", status: "interrupted", expected: false },
    { hook: "empty", status: "interrupted", expected: false },
    { hook: "wrong-turn", status: "interrupted", expected: false },
    { hook: "wrong-thread", status: "interrupted", expected: false },
    { hook: "unscoped", status: "interrupted", expected: false },
    { hook: "stopped", status: "completed", expected: false },
    { hook: "stopped", status: "failed", expected: false },
  ] as const)(
    "correlates $hook hook output with a $status turn only",
    ({ hook, status, expected }) =>
      Effect.gen(function* () {
        const nativeThreadId = "hook-thread";
        const stopReason = "Save a current task checkpoint before compaction.";
        const hookCompleted = (turnId: string | null) => ({
          type: "emit_inbound" as const,
          label: "hook/completed",
          frame: {
            method: "hook/completed",
            params: {
              threadId: hook === "wrong-thread" ? "other-thread" : nativeThreadId,
              turnId: hook === "unscoped" ? null : hook === "wrong-turn" ? "other-turn" : turnId,
              run: {
                id: "checkpoint-hook",
                eventName: "preCompact",
                source: "project",
                sourcePath: "/workspace/.codex/hooks.json",
                scope: "turn",
                executionMode: "sync",
                handlerType: "command",
                displayOrder: 1,
                startedAt: 1782622440,
                status: hook === "completed" ? "completed" : "stopped",
                entries: [
                  { kind: "warning", text: "Unrelated hook diagnostic" },
                  {
                    kind: hook === "warning" ? "warning" : "stop",
                    text: hook === "empty" ? "  " : stopReason,
                  },
                ],
              },
            },
          },
        });
        const transcript = makeCodexReplayTranscript({
          scenario: `hook-stop-${hook}-${status}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "hook-turn", prompt: "work" }),
            hookCompleted("hook-turn"),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "hook-turn", status }),
                },
              },
            },
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "next-turn", prompt: "work" })
              .slice(-3)
              .map((entry, index) => (index < 2 ? withReplayRequestId(entry, 4) : entry)),
            hookCompleted("hook-turn"),
            {
              type: "emit_inbound",
              label: "turn/completed/next",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: "next-turn", status: "interrupted" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        for (const turn of ["hook-turn", "next-turn"]) {
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(turn),
              text: "work",
            }),
          );
          yield* harness.awaitTerminal(turn === "hook-turn" ? 1 : 2);
        }
        assert.deepEqual(
          harness.terminalEvents().map((event) => ({
            status: event.status,
            reason: event.status === "failed" ? undefined : event.reason,
          })),
          [
            { status, reason: expected ? `preCompact hook (project): ${stopReason}` : undefined },
            { status: "interrupted", reason: undefined },
          ],
        );
        // Our chat shows the reason as a notice in the turn.
        const notices = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
            ? [event.turnItem.message]
            : [],
        );
        assert.deepEqual(
          notices.filter((message) => message.includes("hook")),
          expected ? [`preCompact hook (project): ${stopReason}`] : [],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
  );

  it.effect("resumes a provider thread without requesting or decoding its history", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-resume-metadata";
        const nativeThreadId = `native-${scenario}-thread`;
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused-turn",
          prompt: "unused-prompt",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });

        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("on a Cloud computer whose Cloud routes Codex's Auto, a thread on Auto stays on Codex's own provider: no proxy, Auto's model to the data plane", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-cloud-auto";
        const nativeThreadId = `native-${scenario}-thread`;
        const thread = { id: nativeThreadId, updatedAt: 1782622450 };
        // Cloud names Codex in routes_auto, and the app's proxy is not consulted even where one runs.
        const routes = vi.spyOn(followedLogins, "routesAuto").mockResolvedValue(true);
        yield* Effect.addFinalizer(() => Effect.sync(() => routes.mockRestore()));
        const plainParams = { threadId: nativeThreadId, excludeTurns: true, config: CodexAdapterV2.CODEX_THREAD_CONFIG };
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused-turn", prompt: "unused-prompt" }).slice(0, 5),
            { type: "expect_outbound", label: "thread/resume", frame: { id: 3, method: "thread/resume", params: plainParams } },
            { type: "emit_inbound", label: "thread/resume", frame: { id: 3, result: { thread, model: "caveman-auto", modelProvider: "openai" } } },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          threadId: harness.threadId,
          modelSelection: { ...CODEX_TEST_MODEL_SELECTION, model: "caveman-auto" },
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.isTrue(routes.mock.calls.every(([engine]) => engine === "codex"));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("reloads a thread Codex still holds when it switches into or out of Auto", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-router-switch";
        const nativeThreadId = `native-${scenario}-thread`;
        const thread = { id: nativeThreadId, updatedAt: 1782622450 };
        const autoParams = {
          threadId: nativeThreadId,
          excludeTurns: true,
          modelProvider: "caveman",
          config: {
            ...CodexAdapterV2.CODEX_THREAD_CONFIG,
            "model_providers.caveman": {
              name: "Caveman",
              base_url: "http://127.0.0.1:8787/chatgpt",
              wire_api: "responses",
              requires_openai_auth: true,
              http_headers: { "x-cave-session": `thread-${scenario}`, "x-cave-agent": "caveman-code-codex" },
            },
          },
        };
        const plainParams = {
          threadId: nativeThreadId,
          excludeTurns: true,
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
        };
        const exchange = (
          id: number,
          method: string,
          params: unknown,
          result: unknown,
        ): Array<CodexReplay.CodexAppServerReplayEntry> => [
          { type: "expect_outbound", label: method, frame: { id, method, params } },
          { type: "emit_inbound", label: method, frame: { id, result } },
        ];
        const chatgpt = { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true };
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused-turn",
              prompt: "unused-prompt",
            }).slice(0, 5),
            // Into Auto: Codex rejoins the loaded thread on its old provider.
            ...exchange(3, "account/read", {}, chatgpt),
            ...exchange(4, "thread/resume", autoParams, { thread, model: "gpt-5.4", modelProvider: "openai" }),
            ...exchange(5, "thread/unsubscribe", { threadId: nativeThreadId }, { status: "unsubscribed" }),
            ...exchange(6, "account/read", {}, chatgpt),
            ...exchange(7, "thread/resume", autoParams, { thread, model: "caveman-auto", modelProvider: "caveman" }),
            // Out of Auto: the same, back to Codex's own provider.
            ...exchange(8, "thread/resume", plainParams, { thread, model: "caveman-auto", modelProvider: "caveman" }),
            ...exchange(9, "thread/unsubscribe", { threadId: nativeThreadId }, { status: "unsubscribed" }),
            ...exchange(10, "thread/resume", plainParams, { thread, model: "gpt-5.4", modelProvider: "openai" }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resume = (model: string) =>
          harness.runtime.resumeThread({
            providerThread: harness.providerThread,
            threadId: harness.threadId,
            modelSelection: { ...CODEX_TEST_MODEL_SELECTION, model },
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          });

        assert.equal((yield* resume("caveman-auto")).nativeThreadRef?.nativeId, nativeThreadId);
        assert.equal((yield* resume("gpt-5.4")).nativeThreadRef?.nativeId, nativeThreadId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("sends a thread's space plugins on thread/start and thread/resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-space-plugins";
        const nativeThreadId = `native-${scenario}-thread`;
        const developerInstructions = "Follow the space's rules.";
        const askedFor: Array<string> = [];
        const plugins = SessionPlugins.SessionPlugins.of({
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("not used by Codex"),
          codex: (threadId) =>
            Effect.sync(() => {
              askedFor.push(threadId);
              return {
                config: {
                  mcp_servers: { linear__tools: { command: "launcher", args: ["linear"] } },
                },
                developerInstructions,
              };
            }),
          env: () => Effect.succeed({ CAVEMAN_PORT_WEB: "42100" }),
        });
        const threadConfig = {
          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
          "shell_environment_policy.set.CAVEMAN_PORT_WEB": "42100",
        };
        // The replay compares developerInstructions; mcp_servers is checked on the sent params.
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused-turn",
          prompt: "unused-prompt",
        })
          .slice(0, 5)
          .map((entry) =>
            entry.type === "expect_outbound" && entry.label === "thread/start"
              ? {
                  ...entry,
                  frame: {
                    id: 2,
                    method: "thread/start",
                    params: { config: threadConfig, developerInstructions },
                  },
                }
              : entry,
          );
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  developerInstructions,
                  config: threadConfig,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
          ],
        });
        const sent: Array<{ readonly method: string; readonly params: unknown }> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method, params) => Effect.sync(() => void sent.push({ method, params })),
        ).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
        // CODEX_TEST_RUNTIME_POLICY is full access.
        yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });

        const threadRequests = sent.filter(
          ({ method }) => method === "thread/start" || method === "thread/resume",
        );
        assert.deepEqual(
          threadRequests.map(({ method }) => method),
          ["thread/start", "thread/resume"],
        );
        for (const request of threadRequests) {
          const params = request.params as {
            readonly developerInstructions?: string;
            readonly config: { readonly mcp_servers?: unknown } & Record<string, unknown>;
          };
          assert.strictEqual(params.developerInstructions, developerInstructions);
          // The workspace's [env] reaches only the commands Codex runs.
          assert.strictEqual(params.config["shell_environment_policy.set.CAVEMAN_PORT_WEB"], "42100");
          // Full access approves the plugins' tools: Codex rejects them under "never" otherwise.
          assert.notProperty(params.config, "mcp_servers");
          assert.deepEqual(CodexAdapterV2.codexMcpServersOf(params.config), {
            linear__tools: {
              command: "launcher",
              args: ["linear"],
              default_tools_approval_mode: "approve",
            },
          });
        }
        assert.deepEqual(askedFor, [`thread-${scenario}`, `thread-${scenario}`]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("sends a thread's space plugins on thread/start and thread/resume, telling its SessionStart hooks which", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-space-plugins";
        const nativeThreadId = `native-${scenario}-thread`;
        const developerInstructions = "Follow the space's rules.";
        const askedFor: Array<string> = [];
        const plugins = SessionPlugins.SessionPlugins.of({
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("not used by Codex"),
          codex: (threadId, source) =>
            Effect.sync(() => {
              askedFor.push(`${threadId} ${source}`);
              return {
                config: {
                  mcp_servers: { linear__tools: { command: "launcher", args: ["linear"] } },
                },
                developerInstructions,
              };
            }),
          env: () => Effect.succeed({ CAVEMAN_PORT_WEB: "42100" }),
        });
        const threadConfig = {
          ...CodexAdapterV2.CODEX_THREAD_CONFIG,
          "shell_environment_policy.set.CAVEMAN_PORT_WEB": "42100",
        };
        // The replay compares developerInstructions; mcp_servers is checked on the sent params.
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "unused-turn",
          prompt: "unused-prompt",
        })
          .slice(0, 5)
          .map((entry) =>
            entry.type === "expect_outbound" && entry.label === "thread/start"
              ? {
                  ...entry,
                  frame: {
                    id: 2,
                    method: "thread/start",
                    params: { config: threadConfig, developerInstructions },
                  },
                }
              : entry,
          );
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  developerInstructions,
                  config: threadConfig,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
          ],
        });
        const sent: Array<{ readonly method: string; readonly params: unknown }> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method, params) => Effect.sync(() => void sent.push({ method, params })),
        ).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
        // CODEX_TEST_RUNTIME_POLICY is full access.
        yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });

        const threadRequests = sent.filter(
          ({ method }) => method === "thread/start" || method === "thread/resume",
        );
        assert.deepEqual(
          threadRequests.map(({ method }) => method),
          ["thread/start", "thread/resume"],
        );
        for (const request of threadRequests) {
          const params = request.params as {
            readonly developerInstructions?: string;
            readonly config: { readonly mcp_servers?: unknown } & Record<string, unknown>;
          };
          assert.strictEqual(params.developerInstructions, developerInstructions);
          // The workspace's [env] reaches only the commands Codex runs.
          assert.strictEqual(params.config["shell_environment_policy.set.CAVEMAN_PORT_WEB"], "42100");
          // Full access approves the plugins' tools: Codex rejects them under "never" otherwise.
          assert.notProperty(params.config, "mcp_servers");
          assert.deepEqual(CodexAdapterV2.codexMcpServersOf(params.config), {
            linear__tools: {
              command: "launcher",
              args: ["linear"],
              default_tools_approval_mode: "approve",
            },
          });
        }
        // The thread started, then the same thread loaded again: its SessionStart hooks ran for startup, then resume.
        assert.deepEqual(askedFor, [`thread-${scenario} startup`, `thread-${scenario} resume`]);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("starts the app-server without the workspace's [env] (its commands get it), never over a managed launch's credentials or arguments", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened: Array<{ environment: NodeJS.ProcessEnv; launchArgs: string }> = [];
        // The real managed (API-key) launch: ambient credentials stripped, managed flags in the arguments.
        const launch = resolveCodexLaunch({
          path: yield* Path.Path,
          stateDir: "/state",
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          config: DEFAULT_CODEX_SETTINGS,
          environment: { HOME: "/home/test", OPENAI_BASE_URL: "https://ambient.example" },
        });
        assert.isTrue(launch.managed);
        const adapter = yield* CodexAdapterV2.makeCodexAdapterV2({
          instanceId: CodexAdapterV2.CODEX_DEFAULT_INSTANCE_ID,
          settings: DEFAULT_CODEX_SETTINGS,
          environment: { HOME: "/home/test" },
          resolveRuntime: Effect.succeed({ config: launch.config, environment: launch.environment, revision: "r" }),
          clientFactory: {
            open: (openInput) =>
              Effect.sync(
                () =>
                  void opened.push({
                    environment: openInput.environment,
                    launchArgs: resolveCodexLaunchArgs(openInput.settings.launchArgs, openInput.environment),
                  }),
              ).pipe(
                Effect.andThen(
                  Effect.fail(
                    new ProviderAdapter.ProviderAdapterOpenSessionError({
                      driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                      providerSessionId: openInput.providerSessionId,
                      cause: "captured",
                    }),
                  ),
                ),
              ),
          },
          digest: yield* Digest.Digest,
          fileSystem: yield* FileSystem.FileSystem,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          serverConfig: yield* makeReplayServerConfig("codex-workspace-env").pipe(Effect.orDie),
          continuationRequests: { offer: () => Effect.void },
        }).pipe(
          Effect.provideService(SessionPlugins.SessionPlugins, {
            acp: () => Effect.die("unused"),
            claudeAgent: () => Effect.die("unused"),
            codex: () => Effect.die("unused"),
            // Hostile [env] that got past the store's filter: the adapter still holds the line.
            env: () =>
              Effect.succeed({
                CAVEMAN_PORT_WEB: "42100",
                API_URL: "http://localhost:42100",
                OPENAI_BASE_URL: "http://localhost:4000/v1",
                CAVEMAN_CODE_CODEX_LAUNCH_ARGS: "-c mcp_servers.x.command=evil",
              }),
          }),
        );
        yield* adapter
          .openSession({
            threadId: ThreadId.make("thread-codex-workspace-env"),
            providerSessionId: ProviderSessionId.make("provider-session-codex-workspace-env"),
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          })
          .pipe(Effect.ignore);
        assert.equal(opened.length, 1);
        const [{ environment, launchArgs }] = opened as [(typeof opened)[number]];
        // [env] goes to Codex's commands through the thread config, never onto the app-server.
        assert.isUndefined(environment.CAVEMAN_PORT_WEB);
        assert.isUndefined(environment.API_URL);
        assert.equal(environment.HOME, "/home/test");
        assert.isUndefined(environment.OPENAI_BASE_URL);
        assert.isUndefined(environment.CAVEMAN_CODE_CODEX_LAUNCH_ARGS);
        assert.equal(launchArgs, launch.config.launchArgs);
        assert.include(launchArgs, 'forced_login_method="api"');
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect.each(
    (
      [
        ["recovers archived-session errors", "session saved-thread is archived", 0, ""],
        [
          "recovers unarchive hints",
          "Run `codex unarchive saved-thread` to unarchive it first.",
          0,
          "",
        ],
        ["preserves missing-thread errors", "thread not found", 3, "thread not found"],
        ["preserves missing-rollout errors", "no rollout found", 3, "no rollout found"],
        ["preserves authentication errors", "authentication failed", 3, "authentication failed"],
        [
          "preserves archived-workspace errors",
          "workspace is archived",
          3,
          "workspace is archived",
        ],
        [
          "preserves unrelated archive-path errors",
          "permission denied reading archived_sessions/saved-thread",
          3,
          "permission denied reading archived_sessions/saved-thread",
        ],
        [
          "propagates unarchive missing-thread errors",
          "session saved-thread is archived",
          4,
          "thread not found",
        ],
        [
          "propagates unarchive archived errors",
          "session saved-thread is archived",
          4,
          "session saved-thread is archived",
        ],
        [
          "propagates retry missing-thread errors",
          "session saved-thread is archived",
          5,
          "thread not found",
        ],
        [
          "does not retry archived errors twice",
          "session saved-thread is archived",
          5,
          "session saved-thread is archived",
        ],
      ] as const
    ).map(([name, resumeError, failAt, finalError]) => ({ name, resumeError, failAt, finalError })),
  )("$name", ({ name, resumeError, failAt, finalError }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "saved-thread";
        const params = {
          threadId: nativeThreadId,
          excludeTurns: true,
          cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
          model: CODEX_TEST_MODEL_SELECTION.model,
          config: CodexAdapterV2.CODEX_THREAD_CONFIG,
        };
        const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "unused-turn",
            prompt: "unused-prompt",
          }).slice(0, 5),
          {
            type: "expect_outbound",
            label: "resume archived thread",
            frame: { id: 3, method: "thread/resume", params },
          },
          {
            type: "emit_inbound",
            label: "resume error",
            frame: { id: 3, error: { code: -32600, message: resumeError } },
          },
        ];
        if (failAt !== 3) {
          entries.push(
            {
              type: "expect_outbound",
              label: "unarchive same thread",
              frame: { id: 4, method: "thread/unarchive", params: { threadId: nativeThreadId } },
            },
            {
              type: "emit_inbound",
              label: "unarchive result",
              frame:
                failAt === 4
                  ? { id: 4, error: { code: -32600, message: finalError } }
                  : { id: 4, result: { thread: { turns: [{ type: "unknown-history-item" }] } } },
            },
          );
        }
        if (failAt === 0 || failAt === 5) {
          entries.push(
            {
              type: "expect_outbound",
              label: "retry identical resume",
              frame: { id: 5, method: "thread/resume", params },
            },
            {
              type: "emit_inbound",
              label: "retry result",
              frame:
                failAt === 5
                  ? { id: 5, error: { code: -32600, message: finalError } }
                  : {
                      id: 5,
                      result: {
                        thread: {
                          id: nativeThreadId,
                          updatedAt: 1782622450,
                          turns: [{ type: "unknown-history-item" }],
                        },
                      },
                    },
            },
          );
        }
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: name, entries }),
        );
        const resume = harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        if (failAt !== 0) {
          const error = yield* Effect.flip(resume);
          assert.equal(error._tag, "ProviderAdapterResumeThreadError");
          assert.nestedPropertyVal(error, "cause.errorMessage", finalError);
          assert.nestedPropertyVal(
            error,
            "cause.method",
            failAt === 4 ? "thread/unarchive" : "thread/resume",
          );
          assert.nestedPropertyVal(error, "cause.requestId", String(failAt));
          return;
        }
        const resumed = yield* resume;
        assert.equal(resumed.id, harness.providerThread.id);
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
        assert.deepEqual(
          resumed.nativeConversationHeadRef,
          harness.providerThread.nativeConversationHeadRef,
        );
        assert.equal(resumed.status, "idle");
        assert.equal(DateTime.toEpochMillis(resumed.updatedAt), 1782622450000);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("continues an interrupted native thread with empty input and reasoning summaries", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-restart-promptless";
        const nativeThreadId = "native-restart-promptless";
        const nativeTurnId = "turn-restart-promptless";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId,
          prompt: "unused",
        }).slice(0, 5);
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...preamble,
            {
              type: "expect_outbound",
              label: "resume",
              frame: {
                id: 3,
                method: "thread/resume",
                params: {
                  threadId: nativeThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "resume",
              frame: { id: 3, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              label: "continue",
              frame: {
                id: 4,
                method: "turn/start",
                params: {
                  threadId: nativeThreadId,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                  collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "continue",
              frame: {
                id: 4,
                result: { turn: makeCodexReplayTurn({ id: nativeTurnId, status: "inProgress" }) },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const resumed = yield* harness.runtime.resumeThread({
          providerThread: harness.providerThread,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
        });
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: resumed,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-restart-promptless"),
            text: "Continue where you left off.",
          }),
          restartContinuationOfRunId: RunId.make("run-before-restart"),
        });
        assert.equal(resumed.nativeThreadRef?.nativeId, nativeThreadId);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("reports a thread another Codex client is writing to as in use", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "thread-open-elsewhere";
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-resume-active-writer",
            entries: [
              ...codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "unused-turn",
                prompt: "unused-prompt",
              }).slice(0, 5),
              {
                type: "expect_outbound",
                label: "thread/resume",
                frame: {
                  id: 3,
                  method: "thread/resume",
                  params: {
                    threadId: nativeThreadId,
                    excludeTurns: true,
                    config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "active writer",
                frame: {
                  id: 3,
                  error: {
                    code: -32600,
                    message: `thread ${nativeThreadId} already has an active writer`,
                  },
                },
              },
            ],
          }),
        );

        const error = yield* Effect.flip(
          harness.runtime.resumeThread({
            providerThread: harness.providerThread,
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimePolicy: CODEX_TEST_RUNTIME_POLICY,
          }),
        );

        assert.equal(error._tag, "ProviderAdapterThreadInUseError");
        assert.nestedPropertyVal(error, "providerThreadId", harness.providerThread.id);
        assert.include(error.message, "open in another Codex client");
        assert.nestedPropertyVal(
          error,
          "cause.errorMessage",
          `thread ${nativeThreadId} already has an active writer`,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect("resolves retryable app-server errors on resumed provider activity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-provider-api-retry";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Open github.com.",
            }),
            {
              type: "emit_inbound",
              label: "error/retry",
              frame: {
                method: "error",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  willRetry: true,
                  error: {
                    message: "Reconnecting... 2/5",
                    additionalDetails: "The response stream disconnected.",
                    codexErrorInfo: {
                      responseStreamDisconnected: { httpStatusCode: 529 },
                    },
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/started/after-retry",
              frame: {
                method: "item/started",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622445000,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "inProgress",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: null,
                    exitCode: null,
                    durationMs: null,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/after-retry",
              frame: {
                method: "item/completed",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622445010,
                  item: {
                    type: "commandExecution",
                    id: "command-after-provider-retry",
                    command: "pwd",
                    cwd: "/workspace",
                    processId: "42",
                    source: "unifiedExecStartup",
                    status: "completed",
                    commandActions: [{ type: "unknown", command: "pwd" }],
                    aggregatedOutput: "/workspace\n",
                    exitCode: 0,
                    durationMs: 10,
                  },
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-provider-api-retry"),
            text: "Open github.com.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex retry recovery");

        const retryItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.retry !== undefined
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(retryItems, 2);
        assert.equal(retryItems[0]?.status, "running");
        assert.equal(retryItems[0]?.failure.code, "responseStreamDisconnected");
        assert.deepEqual(retryItems[0]?.retry, {
          attempt: 2,
          maxAttempts: 5,
          retryDelayMs: null,
        });
        assert.equal(retryItems[1]?.id, retryItems[0]?.id);
        assert.equal(retryItems[1]?.status, "completed");
        assert.equal(retryItems[1]?.title, "Provider recovered");

        const recoveredIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "completed",
        );
        const resumedCommandIndex = harness.events.findIndex(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.input === "pwd",
        );
        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(recoveredIndex, 0);
        assert.isAbove(resumedCommandIndex, recoveredIndex);
        assert.isAbove(terminalIndex, resumedCommandIndex);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("stamps Codex items with their own start time, not the turn's", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-item-start-times";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const commandLifecycle = (id: string, startedAtMs: number) =>
          (["started", "completed"] as const).map((phase) => ({
            type: "emit_inbound" as const,
            label: `item/${phase}/${id}`,
            frame: {
              method: `item/${phase}`,
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                ...(phase === "started" ? { startedAtMs } : { completedAtMs: startedAtMs + 10 }),
                item: {
                  type: "commandExecution",
                  id,
                  command: "pwd",
                  cwd: "/workspace",
                  processId: "42",
                  source: "unifiedExecStartup",
                  status: phase === "started" ? "inProgress" : "completed",
                  commandActions: [{ type: "unknown", command: "pwd" }],
                  aggregatedOutput: phase === "started" ? null : "/workspace\n",
                  exitCode: phase === "started" ? null : 0,
                  durationMs: phase === "started" ? null : 10,
                },
              },
            },
          }));
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Run two commands." }),
            ...commandLifecycle("first-command", 1782622445000),
            ...commandLifecycle("second-command", 1782622505000),
            ...(["started", "completed"] as const).map((phase) => ({
              type: "emit_inbound" as const,
              label: `item/${phase}/compaction`,
              frame: {
                method: `item/${phase}`,
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  ...(phase === "started"
                    ? { startedAtMs: 1782622565000 }
                    : { completedAtMs: 1782622575000 }),
                  item: { type: "contextCompaction", id: "compaction" },
                },
              },
            })),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-item-start-times"),
            text: "Run two commands.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex item start times");

        const startedAtByItem = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          (event.turnItem.type === "command_execution" || event.turnItem.type === "compaction")
            ? [[event.turnItem.nativeItemRef?.nativeId, event.turnItem.startedAt] as const]
            : [],
        );
        assert.deepEqual(
          startedAtByItem.map(([id, startedAt]) => [id, startedAt?.epochMilliseconds]),
          [
            ["first-command", 1782622445000],
            ["first-command", 1782622445000],
            ["second-command", 1782622505000],
            ["second-command", 1782622505000],
            ["compaction", 1782622565000],
            ["compaction", 1782622565000],
          ],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("hands completed file changes to the thread's memory, each with its own kind and diff", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-memory-file-changes";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const handed: Array<ReadonlyArray<{ readonly path: string; readonly kind: string; readonly diff: string }>> = [];
        const pushed: Array<SessionPlugins.MemoryPushEvent> = [];
        const ingestionStarted = yield* Deferred.make<void>();
        const releaseIngestion = yield* Deferred.make<void>();
        let pluginReads = 0;
        const plugins = SessionPlugins.SessionPlugins.of({
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("not used by Codex"),
          codex: () =>
            Effect.sync(() => {
              pluginReads++;
              return {
                config: { mcp_servers: {} },
                developerInstructions: "",
                memory: {
                  writableRoot: "/copies/t/memory",
                  onFileChange: async (changes) => {
                    await Effect.runPromise(Deferred.succeed(ingestionStarted, undefined));
                    await Effect.runPromise(Deferred.await(releaseIngestion));
                    handed.push(changes);
                  },
                  // No notes: nothing is steered.
                  push: async (event) => void pushed.push(event),
                },
              };
            }),
        });
        const changes = [
          { path: "/copies/t/memory/feedback_a.md", kind: { type: "add" }, diff: "note a\n" },
          { path: "/copies/t/memory/feedback_b.md", kind: { type: "update", move_path: null }, diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n" },
          { path: "/copies/t/memory/feedback_c.md", kind: { type: "delete" }, diff: "" },
        ];
        const fileChange = (phase: "started" | "completed") => ({
          type: "emit_inbound" as const,
          label: `item/${phase}/file-change`,
          frame: {
            method: `item/${phase}`,
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              ...(phase === "started" ? { startedAtMs: 1782622445000 } : { completedAtMs: 1782622446000 }),
              item: { type: "fileChange", id: "file-change", changes, status: phase === "started" ? "inProgress" : "completed" },
            },
          },
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Remember three things." }),
            fileChange("started"),
            fileChange("completed"),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-memory-file-changes"),
            text: "Remember three things.",
          }),
        );
        // Hold ingestion explicitly: a real timer races the iteration-bounded yield loop on fast runners.
        yield* Deferred.await(ingestionStarted);
        assert.isEmpty(handed);
        assert.isEmpty(harness.terminalEvents());
        yield* Deferred.succeed(releaseIngestion, undefined);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex memory file changes");
        // Only the completed item, once, with every change as Codex reported it.
        assert.deepEqual(handed, [
          [
            { path: "/copies/t/memory/feedback_a.md", kind: "add", diff: "note a\n" },
            { path: "/copies/t/memory/feedback_b.md", kind: "update", diff: "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n" },
            { path: "/copies/t/memory/feedback_c.md", kind: "delete", diff: "" },
          ],
        ]);
        // The changed files are asked about too (memory skips its own copy).
        assert.deepEqual(pushed, [{ kind: "files", paths: changes.map((c) => c.path) }]);
        // The plugins (their SessionStart hooks run as they are read) were read once, as the thread started:
        // not again for the turn, its writable roots or the file change.
        assert.equal(pluginReads, 1);
      }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))),
    ),
  );

  it.effect("steers memory's notes about a command's reads and its failure into the running turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-memory-push";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const pushed: Array<SessionPlugins.MemoryPushEvent> = [];
        const plugins = SessionPlugins.SessionPlugins.of({
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("not used by Codex"),
          codex: () =>
            Effect.succeed({
              config: { mcp_servers: {} },
              developerInstructions: "",
              memory: {
                writableRoot: "/copies/t/memory",
                onFileChange: () => undefined,
                push: async (event) => {
                  pushed.push(event);
                  return event.kind === "failure" ? "memory · notes about this failure:\n- test/day.test.js needs TZ=UTC (2026-10-09)" : undefined;
                },
              },
            }),
        });
        const command = (phase: "started" | "completed") => ({
          type: "emit_inbound" as const,
          label: `item/${phase}/command`,
          frame: {
            method: `item/${phase}`,
            params: {
              threadId: nativeThreadId,
              turnId: nativeTurnId,
              ...(phase === "started" ? { startedAtMs: 1782622445000 } : { completedAtMs: 1782622446000 }),
              item: {
                type: "commandExecution",
                id: "failing-command",
                command: "cat test/day.test.js && node --test test/day.test.js",
                cwd: "/workspace",
                processId: "42",
                source: "unifiedExecStartup",
                status: phase === "started" ? "inProgress" : "failed",
                commandActions: [
                  { type: "read", command: "cat test/day.test.js", name: "day.test.js", path: "test/day.test.js" },
                  { type: "unknown", command: "node --test test/day.test.js" },
                ],
                aggregatedOutput: phase === "started" ? null : "not ok 1 - midnight",
                exitCode: phase === "started" ? null : 1,
                durationMs: phase === "started" ? null : 900,
              },
            },
          },
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Fix the day test." }),
            command("started"),
            command("completed"),
            {
              type: "expect_outbound",
              label: "turn/steer",
              frame: {
                id: 4,
                method: "turn/steer",
                params: {
                  expectedTurnId: nativeTurnId,
                  threadId: nativeThreadId,
                  // Tagged: a steer is user input on the wire, and a note is never the person speaking.
                  input: [{ type: "text", text: "<memory>\nmemory · notes about this failure:\n- test/day.test.js needs TZ=UTC (2026-10-09)\n</memory>" }],
                },
              },
            },
            { type: "emit_inbound", label: "turn/steer", frame: { id: 4, result: { turnId: nativeTurnId } } },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-memory-push"),
            text: "Fix the day test.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex memory push");
        // The read resolved against the command's directory, then the failure with its output.
        assert.deepEqual(pushed, [
          { kind: "files", paths: [NodePath.resolve("/workspace", "test/day.test.js")] },
          { kind: "failure", command: "cat test/day.test.js && node --test test/day.test.js", output: "not ok 1 - midnight" },
        ]);
      }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))),
    ),
  );

  it.effect("puts memory's notes back after a compaction as developer context, never as the person's words", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-memory-compact";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const pushed: Array<SessionPlugins.MemoryPushEvent> = [];
        const notes = "memory · notes this session saved or was shown before its context was compacted:\n- run `make check` before committing (2026-10-17)";
        const plugins = SessionPlugins.SessionPlugins.of({
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("not used by Codex"),
          codex: () =>
            Effect.succeed({
              config: { mcp_servers: {} },
              developerInstructions: "",
              memory: {
                writableRoot: "/copies/t/memory",
                onFileChange: () => undefined,
                push: async (event) => {
                  pushed.push(event);
                  return event.kind === "compact" ? notes : undefined;
                },
              },
            }),
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Keep going." }),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: { method: "item/completed", params: { threadId: nativeThreadId, turnId: nativeTurnId, item: { type: "contextCompaction", id: "compact-memory" } } },
            },
            {
              type: "expect_outbound",
              label: "notes put back",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: `<memory>\n${notes}\n</memory>` }] }],
                },
              },
            },
            { type: "emit_inbound", label: "put back", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-memory-compact"),
            text: "Keep going.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "Codex memory compaction push");
        assert.deepEqual(pushed, [{ kind: "compact" }]);
      }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))),
    ),
  );

  it.effect("puts back what trusted plugins' SessionStart hooks say for a compaction, as developer context", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-session-start-compact";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const ran: Array<string> = [];
        const plugins = SessionPlugins.SessionPlugins.of({
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("not used by Codex"),
          codex: (_threadId, source) =>
            Effect.sync(() => {
              ran.push(source);
              return {
                config: { mcp_servers: {} },
                developerInstructions: "",
                afterCompaction: async () => (ran.push("compact"), "The plan is in PLAN.md; read it again."),
              };
            }),
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Keep going." }),
            {
              type: "emit_inbound",
              label: "compacted",
              frame: { method: "item/completed", params: { threadId: nativeThreadId, turnId: nativeTurnId, item: { type: "contextCompaction", id: "compact-start" } } },
            },
            {
              type: "expect_outbound",
              label: "SessionStart text put back",
              frame: {
                id: 4,
                method: "thread/inject_items",
                params: {
                  threadId: nativeThreadId,
                  items: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "# SessionStart hooks\n\nThe plan is in PLAN.md; read it again." }] }],
                },
              },
            },
            { type: "emit_inbound", label: "put back", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript).pipe(Effect.provideService(SessionPlugins.SessionPlugins, plugins));
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-session-start-compact"),
            text: "Keep going.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1 && ran.length === 2, "Codex SessionStart after compaction");
        assert.deepEqual(ran, ["startup", "compact"]);
      }).pipe(Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer))),
    ),
  );

  it.effect.each(["completed", "interrupted"] as const)(
    "retains Codex reasoning parts when the turn is %s",
    (terminalStatus) =>
      Effect.scoped(
        Effect.gen(function* () {
          const scenario = `codex-reasoning-${terminalStatus}`;
          const nativeThreadId = `native-${scenario}-thread`;
          const nativeTurnId = `native-${scenario}-turn`;
          const prompt = "Explain the check.";
          const transcript = makeCodexReplayTranscript({
            scenario,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              ...[
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 0, delta: "Summary " },
                },
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 0, delta: "one" },
                },
                {
                  method: "item/reasoning/summaryTextDelta",
                  params: { itemId: "thought", summaryIndex: 1, delta: "Summary two" },
                },
                {
                  method: "item/reasoning/textDelta",
                  params: { itemId: "thought", contentIndex: 0, delta: "Raw trace" },
                },
                {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "commandExecution",
                      id: "after-thought",
                      command: "pwd",
                      cwd: "/workspace",
                      processId: "42",
                      source: "unifiedExecStartup",
                      status: "completed",
                      commandActions: [{ type: "unknown", command: "pwd" }],
                      aggregatedOutput: "/workspace",
                      exitCode: 0,
                      durationMs: 1,
                    },
                  },
                },
                ...(terminalStatus === "completed"
                  ? [
                      {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "reasoning",
                            id: "thought",
                            summary: ["Final summary one", "Summary two"],
                            content: ["Raw trace"],
                          },
                        },
                      },
                      {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "reasoning",
                            id: "completion-only",
                            summary: ["Completion without deltas"],
                            content: [],
                          },
                        },
                      },
                      {
                        method: "item/reasoning/textDelta",
                        params: {
                          itemId: "delta-only",
                          contentIndex: 0,
                          delta: "Retained when completion omits content",
                        },
                      },
                      {
                        method: "item/completed",
                        params: {
                          item: { type: "reasoning", id: "delta-only", summary: [], content: [] },
                        },
                      },
                    ]
                  : []),
              ].map((event, index) => ({
                type: "emit_inbound" as const,
                label: `reasoning-${index}`,
                frame: {
                  method: event.method,
                  params: { threadId: nativeThreadId, turnId: nativeTurnId, ...event.params },
                },
              })),
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: terminalStatus }),
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`attempt-${scenario}`),
              text: prompt,
            }),
          );
          yield* harness.firstTerminal;
          const latest = new Map(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "reasoning"
                ? [[event.turnItem.id, event.turnItem] as const]
                : [],
            ),
          );
          assert.deepEqual(
            [...latest.values()].map((item) => item.text),
            terminalStatus === "completed"
              ? [
                  "Final summary one",
                  "Summary two",
                  "Raw trace",
                  "Completion without deltas",
                  "Retained when completion omits content",
                ]
              : ["Summary one", "Summary two", "Raw trace"],
          );
          assert.isTrue([...latest.values()].every((item) => item.status === terminalStatus));
          assert.isTrue([...latest.values()].every((item) => item.streaming === false));
          assert.isTrue(
            [...latest.values()].every(
              (item) => item.runId !== null && item.providerTurnId !== null,
            ),
          );
          assert.equal(new Set([...latest.values()].map((item) => item.ordinal)).size, latest.size);
          const command = harness.events.find(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          );
          assert.isDefined(command);
          if (command?.type === "turn_item.updated") {
            assert.isTrue(
              [...latest.values()]
                .slice(0, 3)
                .every((item) => item.ordinal < command.turnItem.ordinal),
            );
          }
          assert.deepEqual(assistantMessages(harness.events), []);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  const finalAnswerTranscript = (
    scenario: string,
    answers: ReadonlyArray<{
      readonly id: string;
      readonly text: string;
      readonly phase?: "commentary" | "partial_answer" | "final_answer" | null;
      readonly omitPhase?: boolean;
      readonly streamed?: boolean;
      readonly completionDelayMs?: number;
    }>,
  ) => {
    const nativeThreadId = `native-${scenario}-thread`;
    const nativeTurnId = `native-${scenario}-turn`;
    const prompt = "Reply with the requested recovery marker.";
    return makeCodexReplayTranscript({
      scenario,
      entries: [
        ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
        ...answers.flatMap(
          (answer, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => {
            const phase = answer.omitPhase
              ? {}
              : { phase: answer.phase === undefined ? ("final_answer" as const) : answer.phase };
            const completed: CodexReplay.CodexAppServerReplayEntry = {
              type: "emit_inbound",
              label: `item/completed/${answer.id}`,
              ...(answer.completionDelayMs === undefined
                ? {}
                : { afterMs: answer.completionDelayMs }),
              frame: {
                method: "item/completed",
                params: {
                  item: {
                    type: "agentMessage",
                    id: answer.id,
                    text: answer.text,
                    ...phase,
                    memoryCitation: null,
                  },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000 + index,
                },
              },
            };
            if (!answer.streamed) {
              return [completed];
            }
            return [
              {
                type: "emit_inbound",
                label: `item/started/${answer.id}`,
                frame: {
                  method: "item/started",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: answer.id,
                      text: "",
                      ...phase,
                      memoryCitation: null,
                    },
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    startedAtMs: 1782622440500 + index,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: `item/agentMessage/delta/${answer.id}`,
                frame: {
                  method: "item/agentMessage/delta",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    itemId: answer.id,
                    delta: answer.text,
                  },
                },
              },
              completed,
            ];
          },
        ),
        {
          type: "emit_inbound",
          label: "turn/completed",
          frame: {
            method: "turn/completed",
            params: {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
            },
          },
        },
      ],
    });
  };

  it.effect.each([false, true])(
    "preserves a final answer that repeats a preceding partial answer (streamed: %s)",
    (streamed) =>
      Effect.scoped(
        Effect.gen(function* () {
          const transcript = finalAnswerTranscript("codex-partial-then-final", [
            { id: "partial", text: "CODEX_RECOVERY_OK", phase: "partial_answer", streamed },
            { id: "final", text: "CODEX_RECOVERY_OK", phase: "final_answer", streamed },
          ]);
          const harness = yield* makeCodexReplayHarness(transcript);
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-partial-then-final"),
              text: "Reply with the requested recovery marker.",
            }),
          );
          yield* harness.awaitTerminal(1);
          assert.deepEqual(
            assistantMessages(harness.events).map((event) => event.message.text),
            ["CODEX_RECOVERY_OK", "CODEX_RECOVERY_OK"],
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect("suppresses a trailing empty final answer after a non-empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-redundant-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-redundant-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  // Codex 0.165 added the `partial_answer` phase, and a turn's summary carries
  // its last message whatever the phase.
  it.effect("ends a failed turn whose last message Codex marks as a partial answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "native-codex-partial-answer-thread";
        const nativeTurnId = "native-codex-partial-answer-turn";
        const prompt = "Reply with the requested recovery marker.";
        const message = {
          type: "agentMessage",
          id: "answer",
          text: "CODEX_PARTIAL_OK",
          phase: "partial_answer",
          memoryCitation: null,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-partial-answer-failed-turn",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "emit_inbound",
              label: "item/started/answer",
              frame: {
                method: "item/started",
                params: {
                  item: { ...message, text: "" },
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  startedAtMs: 1782622440500,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/answer",
              frame: {
                method: "item/completed",
                params: {
                  item: message,
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                    items: [message],
                    itemsView: "summary",
                    error: {
                      message: "stream disconnected before completion",
                      codexErrorInfo: null,
                      additionalDetails: null,
                    },
                  },
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-partial-answer-failed-turn"),
            text: prompt,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.equal(harness.terminalEvents()[0]?.status, "failed");
        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_PARTIAL_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("streams text on the turn item and sends the message once, when it completes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-streamed-message-once", [
          { id: "answer", text: "CODEX_RECOVERY_OK", streamed: true, completionDelayMs: 100 },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-streamed-message-once"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(
          () => assistantTurnItems(harness.events).length === 1,
          "streamed turn item",
        );
        assert.deepEqual(
          assistantTurnItems(harness.events).map(({ text, streaming }) => ({ text, streaming })),
          [{ text: "CODEX_RECOVERY_OK", streaming: true }],
        );
        assert.deepEqual(assistantMessages(harness.events), []);

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.deepEqual(
          assistantMessages(harness.events).map(({ message }) => ({
            text: message.text,
            streaming: message.streaming,
          })),
          [{ text: "CODEX_RECOVERY_OK", streaming: false }],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses a later streamed duplicate final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-streamed-duplicate-final", [
          { id: "answer-original", text: "CODEX_RECOVERY_OK" },
          {
            id: "answer-duplicate",
            text: "CODEX_RECOVERY_OK",
            streamed: true,
            completionDelayMs: 100,
          },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-streamed-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => assistantMessages(harness.events).length === 1, "original answer");
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("buffers an overlapping later final stream until duplicate detection", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = "codex-overlapping-duplicate-final";
        const nativeThreadId = `native-${scenario}-thread`;
        const nativeTurnId = `native-${scenario}-turn`;
        const answerItem = (id: string, text: string) => ({
          type: "agentMessage" as const,
          id,
          text,
          phase: "final_answer" as const,
          memoryCitation: null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario,
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId,
              prompt: "Reply with the requested recovery marker.",
            }),
            ...["answer-overlap-original", "answer-overlap-duplicate"].flatMap(
              (itemId, index): ReadonlyArray<CodexReplay.CodexAppServerReplayEntry> => [
                {
                  type: "emit_inbound",
                  label: `item/started/${itemId}`,
                  frame: {
                    method: "item/started",
                    params: {
                      item: answerItem(itemId, ""),
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      startedAtMs: 1782622440500 + index,
                    },
                  },
                },
                {
                  type: "emit_inbound",
                  label: `item/agentMessage/delta/${itemId}`,
                  frame: {
                    method: "item/agentMessage/delta",
                    params: {
                      threadId: nativeThreadId,
                      turnId: nativeTurnId,
                      itemId,
                      delta: "CODEX_RECOVERY_OK",
                    },
                  },
                },
              ],
            ),
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-original",
              afterMs: 100,
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-original", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441000,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "item/completed/answer-overlap-duplicate",
              frame: {
                method: "item/completed",
                params: {
                  item: answerItem("answer-overlap-duplicate", "CODEX_RECOVERY_OK"),
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  completedAtMs: 1782622441001,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-overlapping-duplicate-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* Effect.yieldNow;
        yield* TestClock.adjust("50 millis");
        yield* Effect.yieldNow;

        assert.equal(new Set(assistantTurnItems(harness.events).map((item) => item.id)).size, 1);

        yield* TestClock.adjust("50 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(
          new Set(assistantMessages(harness.events).map((event) => event.message.id)).size,
          1,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("preserves a sole empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-sole-empty-final", [
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-sole-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          [""],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses a second empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-duplicate-empty-final", [
          { id: "answer-empty-original", text: "" },
          { id: "answer-empty-duplicate", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-duplicate-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          [""],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("preserves an empty final answer when only commentary preceded it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-commentary-then-empty-final", [
          { id: "answer-commentary", text: "Working on it.", phase: "commentary" },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-commentary-then-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["Working on it.", ""],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses an empty final answer after a non-empty unknown-phase answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-unknown-non-empty-then-empty-final", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK", phase: null },
          { id: "answer-empty", text: "" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-unknown-non-empty-then-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("suppresses a trailing empty answer with an omitted phase", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-final-then-empty-unknown", [
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
          { id: "answer-empty", text: "", omitPhase: true },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-final-then-empty-unknown"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("keeps a later non-empty final answer after an initial empty final answer", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const transcript = finalAnswerTranscript("codex-empty-then-non-empty-final", [
          { id: "answer-empty", text: "" },
          { id: "answer-non-empty", text: "CODEX_RECOVERY_OK" },
        ]);
        const harness = yield* makeCodexReplayHarness(transcript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-empty-then-non-empty-final"),
            text: "Reply with the requested recovery marker.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");

        assert.deepEqual(
          assistantMessages(harness.events).map((event) => event.message.text),
          ["", "CODEX_RECOVERY_OK"],
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    "recover",
    "completion-only",
    "exhaust",
    "stop",
    "stop-continued",
    "stop-starting",
    "started-first",
    "completed-first",
    "new-run",
    "steer",
    "start-fails",
  ] as const)("handles terminal Codex capacity failures when retries %s", (outcome) =>
    Effect.scoped(
      Effect.gen(function* () {
        const scenario = `capacity-${outcome}`;
        const nativeThreadId = `native-${scenario}`;
        const nativeTurnId = (attempt: number) => `${nativeThreadId}-${attempt}`;
        const prompt = "Continue the task.";
        const capacityError = {
          message: "Selected model is at capacity. Please try a different model.",
          codexErrorInfo: "serverOverloaded",
        };
        const failureEntries = (attempt: number): Array<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            frame: {
              method: "error",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId(attempt),
                willRetry: false,
                error: capacityError,
              },
            },
          },
          {
            type: "emit_inbound",
            frame: {
              method: "turn/completed",
              params: {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId(attempt), status: "failed" }),
                  error: capacityError,
                },
              },
            },
          },
        ];
        const entries = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: nativeTurnId(0),
          prompt,
        });
        entries.push(
          ...(outcome === "completion-only" ? failureEntries(0).slice(1) : failureEntries(0)),
        );
        if (outcome === "completion-only") entries.push(...failureEntries(0).slice(1));
        const retries = outcome === "exhaust" ? 5 : outcome === "stop" ? 0 : 1;
        const steeredText = "Use the smaller change.";
        for (let attempt = 1; attempt <= retries; attempt++) {
          const start = codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: nativeTurnId(attempt),
            prompt,
          }).slice(-3);
          if (
            outcome === "started-first" ||
            outcome === "stop-starting" ||
            outcome === "completed-first" ||
            outcome === "new-run"
          ) {
            start.splice(1, 0, ...start.splice(2, 1));
          }
          for (const entry of start) {
            if (entry.type === "expect_outbound") {
              entries.push({
                ...entry,
                frame: {
                  id: 3 + attempt,
                  method: "turn/start",
                  params: {
                    threadId: nativeThreadId,
                    input: [],
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    summary: "detailed",
                    collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                  },
                },
              });
            } else if (entry.type === "emit_inbound" && entry.label === "turn/start") {
              if (outcome === "completed-first" || outcome === "new-run")
                entries.push({
                  type: "emit_inbound",
                  frame: {
                    method: "turn/completed",
                    params: {
                      threadId: nativeThreadId,
                      turn: makeCodexReplayTurn({ id: nativeTurnId(attempt), status: "completed" }),
                    },
                  },
                });
              if (outcome === "new-run") {
                entries.push(
                  ...codexReplayPreamble({
                    nativeThreadId,
                    nativeTurnId: nativeTurnId(2),
                    prompt: "Next task.",
                  })
                    .slice(-3)
                    .map((next, index) => (index < 2 ? withReplayRequestId(next, 5) : next)),
                  ...failureEntries(2),
                );
              }
              entries.push(
                outcome === "start-fails"
                  ? {
                      type: "emit_inbound",
                      frame: {
                        id: 3 + attempt,
                        error: { code: -32603, message: "Start failed" },
                      },
                    }
                  : withReplayRequestId(entry, 3 + attempt),
              );
            } else if (outcome !== "start-fails") {
              entries.push(
                outcome === "stop-starting" && entry.type === "emit_inbound"
                  ? { ...entry, afterMs: 1_000 }
                  : entry,
              );
              if (outcome === "stop-starting") {
                entries.push(
                  {
                    type: "expect_outbound",
                    frame: {
                      id: 5,
                      method: "turn/interrupt",
                      params: { threadId: nativeThreadId, turnId: nativeTurnId(attempt) },
                    },
                  },
                  { type: "emit_inbound", frame: { id: 5, result: {} } },
                );
              }
            }
          }
          if (outcome === "exhaust") entries.push(...failureEntries(attempt));
          if (
            outcome === "recover" ||
            outcome === "completion-only" ||
            outcome === "started-first" ||
            outcome === "stop-starting"
          ) {
            entries.push({
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: makeCodexReplayTurn({
                    id: nativeTurnId(attempt),
                    status: outcome === "stop-starting" ? "interrupted" : "completed",
                  }),
                },
              },
            });
          }
          if (outcome === "stop-continued" || outcome === "steer") {
            const steering = outcome === "steer";
            entries.push(
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: steering ? "turn/steer" : "turn/interrupt",
                  params: steering
                    ? {
                        threadId: nativeThreadId,
                        expectedTurnId: nativeTurnId(attempt),
                        input: [{ type: "text", text: steeredText }],
                      }
                    : { threadId: nativeThreadId, turnId: nativeTurnId(attempt) },
                },
              },
              {
                type: "emit_inbound",
                frame: { id: 5, result: steering ? { turnId: nativeTurnId(attempt) } : {} },
              },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({
                      id: nativeTurnId(attempt),
                      status: steering ? "completed" : "interrupted",
                    }),
                  },
                },
              },
            );
          }
        }
        const milestones = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const starts: Array<unknown> = [];
        const retryStarted = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario, entries }),
          (event) =>
            event.type === "turn.terminal" ||
            (event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.status === "running")
              ? Queue.offer(milestones, event)
              : Effect.void,
          (method, params) =>
            Effect.gen(function* () {
              if (method === "turn/start") {
                starts.push(params);
                if (starts.length === 2) yield* Deferred.succeed(retryStarted, undefined);
              }
            }),
        );
        const turnInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make(scenario),
          text: prompt,
        });
        yield* harness.runtime.startTurn(turnInput);
        for (let attempt = 1; attempt <= Math.max(retries, 1); attempt++) {
          const milestone = yield* Queue.take(milestones);
          assert.equal(milestone.type, "turn_item.updated");
          if (milestone.type !== "turn_item.updated" || milestone.turnItem.type !== "error") return;
          const providerTurnId = milestone.turnItem.providerTurnId;
          assert.isNotNull(providerTurnId);
          if (providerTurnId === null) return;
          assert.deepEqual(milestone.turnItem.retry, {
            attempt,
            maxAttempts: 5,
            retryDelayMs: Math.min(2_000 * 2 ** (attempt - 1), 30_000),
          });
          assert.isEmpty(harness.terminalEvents());
          if (outcome === "stop") {
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId,
            });
          }
          const steering =
            outcome === "steer"
              ? yield* harness.runtime
                  .steerTurn({
                    ...turnInput,
                    providerTurnId,
                    message: { ...turnInput.message, text: steeredText },
                  })
                  .pipe(Effect.forkScoped)
              : undefined;
          yield* TestClock.adjust(Math.min(2_000 * 2 ** (attempt - 1), 30_000));
          if (outcome === "stop-starting") {
            yield* Deferred.await(retryStarted);
            const stopping = yield* harness.runtime
              .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
              .pipe(Effect.forkScoped);
            yield* TestClock.adjust("1 second");
            yield* Fiber.join(stopping);
          }
          if (steering !== undefined) yield* Fiber.join(steering);
          if (outcome === "stop-continued") {
            yield* harness.until(() =>
              harness.events.some(
                (event) =>
                  event.type === "provider_turn.updated" &&
                  event.providerTurn.nativeTurnRef?.nativeId === nativeTurnId(1),
              ),
            );
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId,
            });
          }
        }
        yield* harness.awaitTerminal(1);
        if (outcome === "new-run") {
          assert.equal((yield* Queue.take(milestones)).type, "turn.terminal");
          yield* harness.runtime.startTurn({
            ...turnInput,
            attemptId: RunAttemptId.make("capacity-next-task"),
            message: { ...turnInput.message, text: "Next task." },
          });
          const nextRetry = yield* Queue.take(milestones);
          assert.equal(nextRetry.type, "turn_item.updated");
          if (nextRetry.type !== "turn_item.updated" || nextRetry.turnItem.type !== "error") return;
          assert.equal(nextRetry.turnItem.retry?.attempt, 1);
          return;
        }
        const terminal = harness.terminalEvents()[0];
        assert.equal(
          terminal?.status,
          outcome === "recover" ||
            outcome === "completion-only" ||
            outcome === "steer" ||
            outcome === "started-first" ||
            outcome === "completed-first"
            ? "completed"
            : outcome === "stop" || outcome === "stop-continued" || outcome === "stop-starting"
              ? "interrupted"
              : "failed",
        );
        assert.lengthOf(starts, 1 + retries);
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "running",
          ),
          outcome === "start-fails" ? 1 : 1 + retries,
        );
        const retryItems = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "error"
            ? [event.turnItem]
            : [],
        );
        assert.isTrue(
          ["completed", "failed", "interrupted"].includes(retryItems.at(-1)?.status ?? ""),
        );
        assert.lengthOf(new Set(retryItems.map((item) => item.id)), 1);

        if (outcome === "recover") {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-capacity-retry-" });
          const localTranscript = yield* decodeReplayTranscriptJson(
            (yield* encodeReplayTranscriptJson(
              makeCodexReplayTranscript({ scenario, entries }),
            )).replaceAll(yield* encodeStringJson("/workspace"), yield* encodeStringJson(cwd)),
          );
          const driver = yield* CodexReplay.makeReplayDriver(localTranscript);
          yield* Effect.gen(function* () {
            const orchestrator = yield* Orchestrator.OrchestratorV2;
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            const threadId = ThreadId.make("thread:capacity-retry");
            yield* orchestrator.dispatch({
              type: "thread.create",
              commandId: CommandId.make("create-capacity-retry"),
              threadId,
              projectId: ProjectId.make("project:capacity-retry"),
              title: "Capacity retry",
              modelSelection: CODEX_TEST_MODEL_SELECTION,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
              createdBy: "user",
              creationSource: "web",
            });
            const retrying = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) =>
                  event.type === "turn-item.updated" &&
                  event.payload.type === "error" &&
                  event.payload.retry != null &&
                  event.payload.status === "running",
              ),
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("start-capacity-retry"),
              threadId,
              messageId: MessageId.make("message:capacity-retry"),
              text: prompt,
              attachments: [],
              createdBy: "user",
              creationSource: "web",
              dispatchMode: { type: "start_immediately" },
            });
            yield* worker.drain();
            yield* Fiber.join(retrying);
            assert.equal(
              (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
              "running",
            );
            const completed = yield* orchestrator.streamDomainEvents.pipe(
              Stream.filter(
                (event) => event.type === "run.updated" && event.payload.status === "waiting",
              ),
              Stream.runHead,
              Effect.forkChild({ startImmediately: true }),
            );
            yield* TestClock.adjust("2 seconds");
            yield* Fiber.join(completed);
            yield* worker.drain();
            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.equal(projection.runs.at(-1)?.status, "completed");
            assert.deepEqual(
              projection.providerTurns.map((turn) => turn.status),
              ["failed", "completed"],
            );
            assert.lengthOf(
              projection.messages.filter((message) => message.role === "user"),
              1,
            );
            assert.isNull((yield* Ref.get(driver.state)).failure);
          }).pipe(
            Effect.provide(
              ProviderReplayHarness.layerWithRegistry(
                { name: "codex-capacity-retry", runtimePolicyOverride: { cwd } },
                CodexAdapterV2Testkit.layer({ transcript: localTranscript, driver }),
                { runEffectWorker: false },
              ),
            ),
          );
        }
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  const BG_SCENARIO = "codex-bg-exec-wake";
  const BG_NATIVE_THREAD = "native-codex-bg-thread";
  const BG_NATIVE_TURN = "native-codex-bg-turn";
  const BG_COMMAND_ITEM = "call-codex-bg-command";
  const BG_COMMAND = "sleep 20 && echo CODEX_BG_WAKE_DONE";
  const BG_PROMPT = "Start the sleep in the background and reply STARTED.";

  const backgroundCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: BG_COMMAND_ITEM,
    command: BG_COMMAND,
    cwd: "/workspace",
    processId: "4242",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: BG_COMMAND }],
    aggregatedOutput: status === "completed" ? "CODEX_BG_WAKE_DONE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 25_000 : null,
  });

  const backgroundExecTranscript = makeCodexReplayTranscript({
    scenario: BG_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: BG_NATIVE_THREAD,
        nativeTurnId: BG_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-bg",
              text: "STARTED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: BG_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: BG_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect(
    "projects a post-settle background command completion and requests a continuation",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(backgroundExecTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-wake"),
              text: BG_PROMPT,
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.isTrue(
            yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
          );
          assert.lengthOf(harness.continuationRequests, 0);
          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");

          yield* TestClock.adjust("30 seconds");
          yield* awaitUntil(
            () => harness.continuationRequests.length === 1,
            "continuation request",
          );
          const request = harness.continuationRequests[0];
          assert.equal(request?.threadId, harness.threadId);
          assert.equal(request?.providerThreadId, harness.providerThread.id);
          assert.equal(request?.driver, CodexAdapterV2.CODEX_DRIVER_KIND);
          assert.deepEqual(request?.notification, {
            source: { kind: "command" },
            outcome: "completed",
            summary: `Command "${BG_COMMAND}" finished (exit 0)`,
            detail: BG_COMMAND,
          });
          assert.equal(
            request?.detail,
            `Background command completed (exit 0): ${BG_COMMAND}\n\n` +
              "Output tail:\nCODEX_BG_WAKE_DONE",
          );

          const lateCommandUpdateIndex = () =>
            harness.events.findIndex(
              (event, index) =>
                index > terminalIndex &&
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.output === "CODEX_BG_WAKE_DONE\n" &&
                event.turnItem.exitCode === 0,
            );
          yield* awaitUntil(
            () => lateCommandUpdateIndex() > terminalIndex,
            "post-settle command projection",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect("wakes with well-formed text when the cuts split an emoji", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-bg-wake-surrogate",
            entries: [
              ...backgroundExecTranscript.entries.slice(0, -1),
              {
                type: "emit_inbound",
                label: "item/completed/command-late",
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      ...backgroundCommandItem("completed"),
                      command: `${"c".repeat(199)}🚀`,
                      aggregatedOutput: `🚀${"x".repeat(999)}\n`,
                    },
                    threadId: BG_NATIVE_THREAD,
                    turnId: BG_NATIVE_TURN,
                    completedAtMs: 1782622465500,
                  },
                },
              },
            ],
          }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-bg-wake-surrogate"),
            text: BG_PROMPT,
          }),
        );
        yield* harness.until(() => harness.continuationRequests.length > 0);
        assert.isTrue(harness.continuationRequests[0]?.detail?.isWellFormed());
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect.each([false, true])(
    "keeps commands interrupted after native thread closure (persistent tool: %s)",
    (retainContext) =>
      Effect.gen(function* () {
        const notification = (method: string, params: unknown) => ({
          type: "emit_inbound" as const,
          label: method,
          frame: { method, params },
        });
        const monitor = (status: "inProgress" | "completed") =>
          notification(status === "inProgress" ? "item/started" : "item/completed", {
            threadId: BG_NATIVE_THREAD,
            turnId: BG_NATIVE_TURN,
            item: {
              type: "dynamicToolCall",
              id: "persistent-monitor",
              namespace: "grok",
              tool: "monitor",
              status,
              arguments: { persistent: true, command: "tail -f" },
            },
          });
        // Replies fence notification handling on the same protocol reader.
        const unsubscribe = (id: number, notifications: ReturnType<typeof notification>[] = []) => [
          {
            type: "expect_outbound" as const,
            label: `unsubscribe-${id}`,
            frame: { id, method: "thread/unsubscribe", params: { threadId: BG_NATIVE_THREAD } },
          },
          ...notifications,
          {
            type: "emit_inbound" as const,
            label: `unsubscribe-result-${id}`,
            frame: { id, result: { status: "notSubscribed" } },
          },
        ];
        const closed = notification("thread/closed", { threadId: BG_NATIVE_THREAD });
        const transcript = makeCodexReplayTranscript({
          scenario: `codex-background-thread-closed-${retainContext}`,
          entries: [
            ...backgroundExecTranscript.entries.slice(0, -2),
            ...(retainContext ? [monitor("inProgress")] : []),
            backgroundExecTranscript.entries.at(-2)!,
            ...unsubscribe(4),
            ...unsubscribe(5, [notification("thread/closed", { threadId: "unrelated-thread" })]),
            ...unsubscribe(6, [closed]),
            ...unsubscribe(7, [
              closed,
              notification("item/completed", {
                threadId: BG_NATIVE_THREAD,
                turnId: BG_NATIVE_TURN,
                item: backgroundCommandItem("completed"),
              }),
              ...(retainContext ? [monitor("completed")] : []),
            ]),
          ],
        });
        const interrupted = yield* Deferred.make<void>();
        const monitorCompleted = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) => {
          if (event.type !== "turn_item.updated") return Effect.void;
          if (
            event.turnItem.nativeItemRef?.nativeId === BG_COMMAND_ITEM &&
            event.turnItem.status === "interrupted"
          ) {
            return Deferred.succeed(interrupted, undefined);
          }
          return event.turnItem.nativeItemRef?.nativeId === "persistent-monitor" &&
            event.turnItem.status === "completed"
            ? Deferred.succeed(monitorCompleted, undefined)
            : Effect.void;
        });
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-thread-closed"),
            text: BG_PROMPT,
          }),
        );
        yield* harness.firstTerminal;
        const unload = harness.runtime.unloadThread!({ providerThread: harness.providerThread });
        yield* unload;
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        yield* unload;
        assert.isTrue(yield* harness.hasPendingBackgroundWork);
        yield* unload;
        assert.equal(yield* harness.hasPendingBackgroundWork, retainContext);
        yield* Deferred.await(interrupted);
        yield* unload;
        if (retainContext) yield* Deferred.await(monitorCompleted);
        assert.deepEqual(
          {
            items: harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.nativeItemRef?.nativeId === BG_COMMAND_ITEM
                ? [event.turnItem.status]
                : [],
            ),
            nodes: harness.events.flatMap((event) =>
              event.type === "node.updated" &&
              event.node.nativeItemRef?.nativeId === BG_COMMAND_ITEM
                ? [event.node.status]
                : [],
            ),
            roots: harness.terminalEvents().map((event) => event.status),
            continuations: harness.continuationRequests.length,
          },
          {
            items: ["running", "interrupted"],
            nodes: ["running", "interrupted"],
            roots: ["completed"],
            continuations: 0,
          },
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.isFalse(
          yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
  );

  // "thread_unloaded": the thread was settled, so T3 unsubscribed and Codex
  // unloaded it (killing its terminals) before Stop arrived.
  const backgroundStopCases = [true, false, "still_running", "thread_unloaded"] as const;
  const makeBackgroundStopTranscript = (terminated: (typeof backgroundStopCases)[number]) => {
    const stillRunning = terminated === "still_running";
    return makeCodexReplayTranscript({
      scenario: `codex-bg-stop-${terminated}`,
      entries: [
        ...backgroundExecTranscript.entries.slice(0, -1),
        {
          type: "expect_outbound",
          label: "terminate-background-command",
          frame: {
            id: 4,
            method: "thread/backgroundTerminals/terminate",
            params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
          },
        },
        {
          type: "emit_inbound",
          label: "terminate-background-command",
          frame:
            terminated === "thread_unloaded"
              ? {
                  id: 4,
                  error: { code: -32600, message: `thread not found: ${BG_NATIVE_THREAD}` },
                }
              : { id: 4, result: { terminated: terminated === true } },
        },
        ...(terminated === false || stillRunning
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 5,
                  method: "thread/backgroundTerminals/list",
                  params: { threadId: BG_NATIVE_THREAD },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: {
                  id: 5,
                  result: { data: stillRunning ? [{ processId: "4242" }] : [], nextCursor: null },
                },
              },
            ]
          : []),
        ...(stillRunning
          ? [
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 6,
                  method: "thread/backgroundTerminals/terminate",
                  params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 6, result: { terminated: false } },
              },
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 7,
                  method: "thread/backgroundTerminals/list",
                  params: { threadId: BG_NATIVE_THREAD },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 7, result: { data: [{ processId: "4242" }], nextCursor: null } },
              },
              {
                type: "expect_outbound" as const,
                frame: {
                  id: 8,
                  method: "thread/backgroundTerminals/terminate",
                  params: { threadId: BG_NATIVE_THREAD, processId: "4242" },
                },
              },
              {
                type: "emit_inbound" as const,
                frame: { id: 8, result: { terminated: true } },
              },
            ]
          : []),
        backgroundExecTranscript.entries.at(-1)!,
      ],
    });
  };

  it.effect.each(backgroundStopCases)(
    "stops a command after root completion when termination returns %s",
    (terminated) => {
      const stillRunning = terminated === "still_running";
      const transcript = makeBackgroundStopTranscript(terminated);
      return Effect.scoped(
        Effect.gen(function* () {
          const stopped = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(transcript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? Deferred.succeed(stopped, undefined)
              : Effect.void,
          );
          const now = yield* DateTime.now;
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-bg-stop"),
              text: BG_PROMPT,
            }),
          );
          yield* harness.firstTerminal;
          const terminal = harness.terminalEvents()[0]!;
          assert.equal(terminal.status, "completed");
          assert.isTrue(yield* harness.hasPendingBackgroundWork);
          assert.isFalse(
            yield* harness.runtime.hasPendingBackgroundWorkForThread!({
              ...harness.providerThread,
              id: ProviderThreadId.make("unrelated-provider-thread"),
            }),
          );
          if (stillRunning) {
            const failed = yield* harness.runtime
              .interruptTurn({
                providerThread: harness.providerThread,
                providerTurnId: terminal.providerTurnId,
                requestRuntimeRestart: true,
              })
              .pipe(Effect.exit);
            assert.equal(failed._tag, "Failure");
            assert.isTrue(yield* harness.hasPendingBackgroundWork);
          }
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: stillRunning
              ? ProviderTurnId.make("later-completed-turn")
              : terminal.providerTurnId,
            requestRuntimeRestart: true,
          });
          yield* Deferred.await(stopped);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.equal(harness.terminalEvents()[0]?.status, "completed");
          assert.lengthOf(harness.continuationRequests, 0);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      );
    },
  );
  it.effect("interrupts a completed run's background command through orchestration", () => {
    const transcript = makeBackgroundStopTranscript(true);
    return Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bg-stop-workspace-" });
        const localTranscript = yield* decodeReplayTranscriptJson(
          (yield* encodeReplayTranscriptJson(transcript)).replaceAll(
            yield* encodeStringJson("/workspace"),
            yield* encodeStringJson(cwd),
          ),
        );
        const replayDriver = yield* CodexReplay.makeReplayDriver(localTranscript);
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        assert.equal(
          Number(yield* spawner.exitCode(ChildProcess.make("git", ["init", "--quiet"], { cwd }))),
          0,
        );
        assert.equal(
          Number(
            yield* spawner.exitCode(
              ChildProcess.make(
                "git",
                [
                  "-c",
                  "user.name=Test",
                  "-c",
                  "user.email=test@example.com",
                  "commit",
                  "--allow-empty",
                  "--quiet",
                  "-m",
                  "Initial commit",
                ],
                { cwd },
              ),
            ),
          ),
          0,
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop"),
            threadId,
            projectId: ProjectId.make("project:background-stop"),
            title: "Background stop",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const waiting = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) => event.type === "run.updated" && event.payload.status === "waiting",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop"),
            threadId,
            messageId: MessageId.make("message:background-stop"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          assert.isNull((yield* Ref.get(replayDriver.state)).failure);
          yield* Fiber.join(waiting);
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          const run = projection.runs.at(-1)!;
          assert.equal(run.status, "completed");
          assert.equal(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks?.length,
            1,
          );
          const stopped = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "turn-item.updated" &&
                event.payload.type === "command_execution" &&
                event.payload.status === "interrupted",
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-background-command"),
            threadId,
            runId: run.id,
          });
          yield* worker.drain();
          yield* Fiber.join(stopped);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)?.status,
            "completed",
          );
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "codex-background-stop", runtimePolicyOverride: { cwd } },
              CodexAdapterV2Testkit.layer({
                transcript: localTranscript,
                driver: replayDriver,
              }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    );
  });

  // The app-server exits after the root turn, before the command's own
  // item/completed (Codex always sends one, so only a lost notification or a
  // gone process leaves it running). Nothing tracks the command any more, yet
  // the thread still shows it, and Stop is the only way to clear it.
  it.effect("Stop ends a background command no Codex process tracks any more", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-bg-stale-workspace-" });
        const staleTranscript = makeCodexReplayTranscript({
          scenario: "codex-bg-stop-untracked",
          entries: [
            ...backgroundExecTranscript.entries.slice(0, -1),
            { type: "runtime_exit", status: "success" },
          ],
        });
        const localTranscript = yield* decodeReplayTranscriptJson(
          (yield* encodeReplayTranscriptJson(staleTranscript)).replaceAll(
            yield* encodeStringJson("/workspace"),
            yield* encodeStringJson(cwd),
          ),
        );
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        for (const args of [
          ["init", "--quiet"],
          [
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "--allow-empty",
            "--quiet",
            "-m",
            "Initial commit",
          ],
        ]) {
          assert.equal(Number(yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }))), 0);
        }
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
          const threadId = ThreadId.make("thread:background-stop-untracked");
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("create-background-stop-untracked"),
            threadId,
            projectId: ProjectId.make("project:background-stop-untracked"),
            title: "Background stop untracked",
            modelSelection: CODEX_TEST_MODEL_SELECTION,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: cwd,
            createdBy: "user",
            creationSource: "web",
          });
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.type === "run.updated" &&
                (event.payload.status === "waiting" || event.payload.status === "completed"),
            ),
            Stream.runHead,
            Effect.forkChild({ startImmediately: true }),
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make("start-background-stop-untracked"),
            threadId,
            messageId: MessageId.make("message:background-stop-untracked"),
            text: BG_PROMPT,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
            dispatchMode: { type: "start_immediately" },
          });
          yield* worker.drain();
          yield* Fiber.join(settled);
          yield* worker.drain();
          const before = yield* orchestrator.getThreadShell(threadId);
          assert.deepEqual(
            before?.pendingBackgroundTasks?.map((task) => task.kind),
            ["command"],
            "the thread still shows the command the gone process never finished",
          );
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop-background-untracked"),
            threadId,
            runId: run.id,
            holdQueue: true,
          });
          yield* worker.drain();
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.deepEqual(
            projection.turnItems.flatMap((item) =>
              item.type === "command_execution" ? [item.status] : [],
            ),
            ["interrupted"],
          );
          assert.equal(projection.runs.at(-1)?.status, "completed");
          assert.deepEqual(
            (yield* orchestrator.getThreadShell(threadId))?.pendingBackgroundTasks,
            [],
          );
        }).pipe(
          Effect.provide(
            ProviderReplayHarness.layerWithRegistry(
              { name: "codex-background-stop-untracked", runtimePolicyOverride: { cwd } },
              CodexAdapterV2Testkit.layer({ transcript: localTranscript }),
              { runEffectWorker: false },
            ),
          ),
        );
      }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
    ),
  );

  const PRE_SETTLE_SCENARIO = "codex-bg-exec-pre-settle";
  const PRE_SETTLE_NATIVE_THREAD = "native-codex-pre-settle-thread";
  const PRE_SETTLE_NATIVE_TURN = "native-codex-pre-settle-turn";

  const preSettleTranscript = makeCodexReplayTranscript({
    scenario: PRE_SETTLE_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: PRE_SETTLE_NATIVE_THREAD,
        nativeTurnId: PRE_SETTLE_NATIVE_TURN,
        prompt: BG_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: backgroundCommandItem("inProgress"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-pre-settle",
        frame: {
          method: "item/completed",
          params: {
            item: backgroundCommandItem("completed"),
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-pre-settle",
              text: "DONE",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turnId: PRE_SETTLE_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: PRE_SETTLE_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: PRE_SETTLE_NATIVE_TURN, status: "completed" }),
          },
        },
      },
    ],
  });

  it.effect("does not request a continuation for a command that completes before settle", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(preSettleTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-bg-pre-settle"),
            text: BG_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "completed" &&
                event.turnItem.exitCode === 0,
            ),
          "pre-settle command projection",
        );

        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  const INTERRUPT_SCENARIO = "codex-interrupt-mid-command";
  const INTERRUPT_NATIVE_THREAD = "native-codex-interrupt-thread";
  const INTERRUPT_NATIVE_TURN = "native-codex-interrupt-turn";
  const INTERRUPT_COMMAND_ITEM = "exec-codex-interrupt-command";
  const INTERRUPT_COMMAND_ITEM_TWO = "exec-codex-interrupt-command-two";
  const INTERRUPT_CHILD_COMMAND_ITEM = "exec-codex-interrupt-child-command";
  const INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-child-timeout-boundary";
  const INTERRUPT_CHILD_NATIVE_THREAD = "native-codex-interrupt-child-thread";
  const INTERRUPT_CHILD_NATIVE_TURN = "native-codex-interrupt-child-turn";
  const INTERRUPT_LATE_CHILD_NATIVE_TURN = "native-codex-interrupt-late-child-turn";
  const INTERRUPT_LATE_CHILD_2_NATIVE_TURN = "native-codex-interrupt-late-child-2-turn";
  const INTERRUPT_TIMEOUT_BOUNDARY_ITEM = "exec-codex-interrupt-timeout-boundary";
  const INTERRUPT_TIMEOUT_LATE_ITEM = "exec-codex-interrupt-timeout-late";
  const INTERRUPT_COMMAND = "bash -c 'sleep 30; echo SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE'";
  const INTERRUPT_COMMAND_TWO = "bash -c 'sleep 20; echo SECOND_COMMAND'";
  const INTERRUPT_PROMPT = "Run a long foreground command and wait until interrupted.";

  const interruptCommandItem = (status: "inProgress" | "completed"): Record<string, unknown> => ({
    type: "commandExecution",
    id: INTERRUPT_COMMAND_ITEM,
    command: INTERRUPT_COMMAND,
    cwd: "/workspace",
    processId: "57680",
    source: "unifiedExecStartup",
    status,
    commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND }],
    aggregatedOutput: status === "completed" ? "SHOULD_NOT_FINISH_CMD_INTERRUPT_FIXTURE\n" : null,
    exitCode: status === "completed" ? 0 : null,
    durationMs: status === "completed" ? 30_000 : null,
  });

  const interruptMidCommandTranscript = makeCodexReplayTranscript({
    scenario: INTERRUPT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false",
        frame: { id: 6, result: { data: [], nextCursor: null } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 7,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 7, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
    ],
  });

  it.effect("contains commands that start before and after the interrupt response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-mid-command"),
            text: INTERRUPT_PROMPT,
          }),
        );

        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );

        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        assert.isAtLeast(terminalIndex, 0);

        let lastCommandBeforeTerminal:
          | Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>
          | undefined;
        for (let index = 0; index < terminalIndex; index++) {
          const event = harness.events[index];
          if (event?.type === "turn_item.updated" && event.turnItem.type === "command_execution") {
            lastCommandBeforeTerminal = event;
          }
        }
        assert.isDefined(lastCommandBeforeTerminal);
        assert.equal(lastCommandBeforeTerminal.turnItem.status, "interrupted");
        assert.isNotNull(lastCommandBeforeTerminal.turnItem.completedAt);

        const interruptedCommandsBeforeTerminal = harness.events
          .slice(0, terminalIndex)
          .flatMap((event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted"
              ? [event.turnItem.input]
              : [],
          )
          .sort();
        assert.deepEqual(
          interruptedCommandsBeforeTerminal,
          [INTERRUPT_COMMAND, INTERRUPT_COMMAND_TWO].sort(),
        );

        const interruptedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "interrupted",
        );
        assert.isAbove(
          terminalIndex,
          interruptedCommandIndex,
          "command terminalization must precede turn.terminal",
        );

        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);

        // Late provider item/completed after interrupt must not revive the card
        // or request a background-command wake continuation.
        yield* TestClock.adjust("30 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.continuationRequests, 0);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);

        const postTerminalCommandUpdates = harness.events.filter(
          (event, index) =>
            index > terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution",
        );
        assert.lengthOf(
          postTerminalCommandUpdates,
          0,
          "late item/completed after interrupt must not project",
        );

        const commandUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > => event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        assert.isAtLeast(commandUpdates.length, 2, "start + interrupt terminalization");
        assert.equal(commandUpdates[commandUpdates.length - 1]?.turnItem.status, "interrupted");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  const interruptSubagentCommandTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-command",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-interrupt-subagent",
              kind: "started",
              agentThreadId: INTERRUPT_CHILD_NATIVE_THREAD,
              agentPath: "/root/stop_hold",
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/child-command",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_COMMAND_ITEM,
              processId: "57682",
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/root",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/root",
        frame: { id: 4, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: { id: 5, result: {} },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/child",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, processId: "57682" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/child",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/child-completed-race",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_CHILD_NATIVE_TURN,
              status: "completed",
            }),
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  const assertChildProviderTerminalBeforeRoot = (
    events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
    rootThreadId: ThreadId,
  ) => {
    const terminalIndex = events.findIndex((event) => event.type === "turn.terminal");
    const childProviderTurnIndex = events.findIndex(
      (event) =>
        event.type === "provider_turn.updated" &&
        event.threadId !== rootThreadId &&
        event.providerTurn.status === "interrupted",
    );
    const childProviderThreadIndex = events.findIndex(
      (event) =>
        event.type === "provider_thread.updated" &&
        event.providerThread.appThreadId !== rootThreadId &&
        event.providerThread.status === "idle",
    );
    assert.isAtLeast(childProviderTurnIndex, 0, "child provider turn must terminalize");
    assert.isAtLeast(childProviderThreadIndex, 0, "child provider thread must become idle");
    assert.isAbove(
      terminalIndex,
      childProviderTurnIndex,
      "child provider turn must terminalize before the root run",
    );
    assert.isAbove(
      terminalIndex,
      childProviderThreadIndex,
      "child provider thread must become idle before the root run",
    );
  };

  it.effect("contains descendant commands and keeps Stop authoritative", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-command"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const childCommandUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM,
        );
        assert.equal(childCommandUpdates.at(-1)?.turnItem.status, "interrupted");
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const childInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/child",
  );
  const rootInterruptResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/interrupt/root",
  );
  const interruptSubagentRequestFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-request-failure",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootInterruptResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/completed/root-before-child-interrupt-failure",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "interrupted" }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(
        rootInterruptResponseIndex + 1,
        childInterruptResponseIndex,
      ),
      {
        type: "emit_inbound",
        label: "turn/interrupt/child",
        frame: {
          id: 5,
          error: { code: -32_000, message: "child interrupt request failed" },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("terminalizes descendants before the root when an interrupt request fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentRequestFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-request-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  const childTurnStartedIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/started/child",
  );
  const failedRootLiveChildTranscript = makeCodexReplayTranscript({
    scenario: "codex-failed-root-live-subagent",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTurnStartedIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/completed/root-failed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({ id: INTERRUPT_NATIVE_TURN, status: "failed" }),
              error: {
                message: "unsupported websocket request type: response.interrupt",
                codexErrorInfo: "other",
                additionalDetails: null,
              },
            },
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/child",
        afterMs: 30_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: INTERRUPT_CHILD_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("settles a failed root without waiting for subagents that keep running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedRootLiveChildTranscript);
        const now = yield* DateTime.now;
        const childTurnCompleted = () =>
          harness.events.some(
            (event) =>
              event.type === "provider_turn.updated" &&
              event.threadId !== harness.threadId &&
              event.providerTurn.status === "completed",
          );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-failed-root-live-subagent"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed root terminal");

        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        assert.isTrue(terminal?.status === "failed" && terminal.childTurnsContinue === true);
        assert.isFalse(childTurnCompleted(), "the subagent is still running");

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(childTurnCompleted, "subagent turn completion");
        assert.lengthOf(harness.terminalEvents(), 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect("stops a subagent's turn that starts after its root failed without holding up what Codex says next", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lateChildTurn = "native-codex-interrupt-late-child-turn";
        const rootFailedIndex = failedRootLiveChildTranscript.entries.findIndex(
          (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root-failed",
        );
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-late-subagent-turn-after-failed-root",
          entries: [
            ...failedRootLiveChildTranscript.entries.slice(0, rootFailedIndex + 1),
            {
              type: "emit_inbound",
              label: "turn/completed/child",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: INTERRUPT_CHILD_NATIVE_THREAD,
                  turn: makeCodexReplayTurn({ id: INTERRUPT_CHILD_NATIVE_TURN, status: "completed" }),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/started/late-child",
              frame: {
                method: "turn/started",
                params: {
                  threadId: INTERRUPT_CHILD_NATIVE_THREAD,
                  turn: makeCodexReplayTurn({ id: lateChildTurn, status: "inProgress" }),
                },
              },
            },
            {
              type: "expect_outbound",
              label: "turn/interrupt/late-child",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, turnId: lateChildTurn },
              },
            },
            // Codex answers at once, then goes on talking.
            { type: "emit_inbound", label: "turn/interrupt/late-child", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "model/rerouted/late-child",
              frame: {
                method: "model/rerouted",
                params: {
                  threadId: INTERRUPT_CHILD_NATIVE_THREAD,
                  turnId: lateChildTurn,
                  fromModel: "gpt-5.4",
                  toModel: "gpt-5.4-after-late-interrupt",
                  reason: "highRiskCyberActivity",
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed root terminal");

        // No clock time passes: the reply to the interrupt is read as soon as it arrives.
        const heardNext = yield* awaitUntil(
          () =>
            harness
              .subagentUpdates()
              .some((event) => event.subagent.model === "gpt-5.4-after-late-interrupt"),
          "what Codex said after the interrupt's reply",
        ).pipe(Effect.exit);
        assert.deepEqual(
          { heardNext: Exit.isSuccess(heardNext), replay: yield* harness.replayProgress },
          { heardNext: true, replay: { cursor: transcript.entries.length, failure: null } },
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("stops a subagent's turn that starts after its root failed without holding up what Codex says next", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const lateChildTurn = "native-codex-interrupt-late-child-turn";
        const rootFailedIndex = failedRootLiveChildTranscript.entries.findIndex(
          (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root-failed",
        );
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-late-subagent-turn-after-failed-root",
          entries: [
            ...failedRootLiveChildTranscript.entries.slice(0, rootFailedIndex + 1),
            {
              type: "emit_inbound",
              label: "turn/completed/child",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: INTERRUPT_CHILD_NATIVE_THREAD,
                  turn: makeCodexReplayTurn({ id: INTERRUPT_CHILD_NATIVE_TURN, status: "completed" }),
                },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/started/late-child",
              frame: {
                method: "turn/started",
                params: {
                  threadId: INTERRUPT_CHILD_NATIVE_THREAD,
                  turn: makeCodexReplayTurn({ id: lateChildTurn, status: "inProgress" }),
                },
              },
            },
            {
              type: "expect_outbound",
              label: "turn/interrupt/late-child",
              frame: {
                id: 4,
                method: "turn/interrupt",
                params: { threadId: INTERRUPT_CHILD_NATIVE_THREAD, turnId: lateChildTurn },
              },
            },
            // Codex answers at once, then goes on talking.
            { type: "emit_inbound", label: "turn/interrupt/late-child", frame: { id: 4, result: {} } },
            {
              type: "emit_inbound",
              label: "model/rerouted/late-child",
              frame: {
                method: "model/rerouted",
                params: {
                  threadId: INTERRUPT_CHILD_NATIVE_THREAD,
                  turnId: lateChildTurn,
                  fromModel: "gpt-5.4",
                  toModel: "gpt-5.4-after-late-interrupt",
                  reason: "highRiskCyberActivity",
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed root terminal");

        // No clock time passes: the reply to the interrupt is read as soon as it arrives.
        const heardNext = yield* awaitUntil(
          () =>
            harness
              .subagentUpdates()
              .some((event) => event.subagent.model === "gpt-5.4-after-late-interrupt"),
          "what Codex said after the interrupt's reply",
        ).pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(heardNext));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  const childTerminationResponseIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) =>
      entry.type === "emit_inbound" && entry.label === "thread/backgroundTerminals/terminate/child",
  );
  const interruptSubagentTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-timeout",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "item/started/child-timeout-boundary",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM,
              processId: null,
            },
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_CHILD_NATIVE_TURN,
            startedAtMs: 1782622441600,
          },
        },
      },
    ],
  });

  it.effect("terminalizes timed-out descendants before the root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptSubagentTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_TIMEOUT_BOUNDARY_ITEM &&
                event.turnItem.status === "running",
            ),
          "child timeout boundary item",
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const rootCompletionIndex = interruptSubagentCommandTranscript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === "turn/completed/root",
  );
  const interruptLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, rootCompletionIndex),
      {
        type: "emit_inbound",
        label: "turn/started/late-child",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      ...interruptSubagentCommandTranscript.entries.slice(rootCompletionIndex, -1),
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child",
        frame: { id: 7, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("interrupts descendants that start after the initial Stop snapshot", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          "late child provider turn",
        );
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        const lateChildUpdates = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
        );
        assert.equal(lateChildUpdates.at(-1)?.providerTurn.status, "interrupted");
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const interruptSubagentTurnAfterStopTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-subagent-turn-after-stop",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, -1),
      {
        type: "emit_inbound",
        label: "turn/started/child-after-stop",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/child-after-stop",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/child-after-stop",
        frame: { id: 7, result: {} },
      },
      {
        type: "emit_inbound",
        label: "thread/goal/updated/root",
        frame: {
          method: "thread/goal/updated",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: null,
            goal: {
              threadId: INTERRUPT_NATIVE_THREAD,
              objective: INTERRUPT_PROMPT,
              status: "paused",
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1782622440,
              updatedAt: 1782622450,
            },
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect(
    "keeps reading notifications while interrupting a child turn that starts after Stop",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const harness = yield* makeCodexReplayHarness(interruptSubagentTurnAfterStopTranscript);
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-interrupt-subagent-turn-after-stop"),
              text: INTERRUPT_PROMPT,
            }),
          );
          yield* harness.until(() =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          );
          const providerTurnId = harness.events.find(
            (
              event,
            ): event is Extract<
              ProviderAdapter.ProviderAdapterV2Event,
              { type: "provider_turn.updated" }
            > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
          )?.providerTurn.id;
          assert.isDefined(providerTurnId);

          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          });
          yield* harness.awaitTerminal(1);

          // The TestClock never reaches the interrupt's timeout, so this arrives only
          // if the reader is free to read the interrupt response and the frame after it.
          yield* harness.until(() =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.status === "paused",
            ),
          );
          assert.isFalse(
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          );
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  const interruptRescanLateSubagentTurnTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-rescan-late-subagent-turn",
    entries: [
      ...interruptSubagentCommandTranscript.entries.slice(0, childTerminationResponseIndex + 1),
      {
        type: "emit_inbound",
        label: "turn/started/late-child-1",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-1",
        frame: {
          id: 7,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/started/late-child-2",
        frame: {
          method: "turn/started",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
              status: "inProgress",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-1",
        frame: { id: 7, result: {} },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt/late-child-2",
        frame: {
          id: 8,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_CHILD_NATIVE_THREAD,
            turnId: INTERRUPT_LATE_CHILD_2_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt/late-child-2",
        frame: { id: 8, result: {} },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("interrupts descendants discovered only by the final interrupt rescan", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptRescanLateSubagentTurnTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-rescan-late-subagent-turn"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.nativeItemRef?.nativeId === INTERRUPT_CHILD_COMMAND_ITEM &&
                event.turnItem.status === "running",
            ),
          "running child command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated" && event.threadId === harness.threadId,
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({ providerThread: harness.providerThread, providerTurnId })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN,
            ),
          "late child 1 provider turn",
        );
        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);

        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted root terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");

        const rootTerminalIndex = harness.events.findIndex(
          (event) => event.type === "turn.terminal",
        );
        const lateChild1InterruptedIndex = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_NATIVE_TURN &&
            event.providerTurn.status === "interrupted",
        );
        const lateChild2InterruptedIndex = harness.events.findIndex(
          (event) =>
            event.type === "provider_turn.updated" &&
            event.providerTurn.nativeTurnRef?.nativeId === INTERRUPT_LATE_CHILD_2_NATIVE_TURN &&
            event.providerTurn.status === "interrupted",
        );
        assert.isAtLeast(
          lateChild1InterruptedIndex,
          0,
          "late child 1 must terminalize interrupted",
        );
        assert.isAtLeast(
          lateChild2InterruptedIndex,
          0,
          "late child 2 must terminalize interrupted",
        );
        assert.isAbove(
          rootTerminalIndex,
          lateChild1InterruptedIndex,
          "late child 1 must terminalize before the root run",
        );
        assert.isAbove(
          rootTerminalIndex,
          lateChild2InterruptedIndex,
          "late child 2 must terminalize before the root run",
        );
        assertChildProviderTerminalBeforeRoot(harness.events, harness.threadId);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const interruptTimeoutTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-timeout",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: INTERRUPT_NATIVE_THREAD,
        nativeTurnId: INTERRUPT_NATIVE_TURN,
        prompt: INTERRUPT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: interruptCommandItem("inProgress"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "turn/interrupt",
        frame: {
          id: 4,
          method: "turn/interrupt",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/interrupt",
        frame: { id: 4, result: {} },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-two-after-interrupt-response",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_COMMAND_ITEM_TWO,
              command: INTERRUPT_COMMAND_TWO,
              processId: "57681",
              commandActions: [{ type: "unknown", command: INTERRUPT_COMMAND_TWO }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622440600,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: {
          id: 5,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one",
        frame: { id: 5, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-at-timeout-boundary",
        afterMs: 9_999,
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
              command: "echo TIMEOUT_BOUNDARY",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo TIMEOUT_BOUNDARY" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622450500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: {
          id: 6,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57681" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/two",
        frame: { id: 6, result: { terminated: true } },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/late",
        afterMs: 20_000,
        frame: {
          method: "turn/completed",
          params: {
            threadId: INTERRUPT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: INTERRUPT_NATIVE_TURN,
              status: "interrupted",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/command-after-timeout",
        frame: {
          method: "item/started",
          params: {
            item: {
              ...interruptCommandItem("inProgress"),
              id: INTERRUPT_TIMEOUT_LATE_ITEM,
              command: "echo LATE_AFTER_TIMEOUT",
              processId: null,
              commandActions: [{ type: "unknown", command: "echo LATE_AFTER_TIMEOUT" }],
            },
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            startedAtMs: 1782622470500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/command-late",
        frame: {
          method: "item/completed",
          params: {
            item: interruptCommandItem("completed"),
            threadId: INTERRUPT_NATIVE_THREAD,
            turnId: INTERRUPT_NATIVE_TURN,
            completedAtMs: 1782622465500,
          },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("bounds interrupt settlement and drops late completion events", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTimeoutTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-timeout"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 1,
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptFiber = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.forkScoped);
        yield* awaitUntil(
          () =>
            harness.events.filter(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ).length === 2,
          "post-interrupt running command item",
        );

        yield* TestClock.adjust("10 seconds");
        yield* Fiber.join(interruptFiber);
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "timeout terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        const terminalProviderTurnsBeforeLateEvents = harness.events.filter(
          (event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
        );
        assert.lengthOf(terminalProviderTurnsBeforeLateEvents, 1);

        const commandUpdatesBeforeLateEvents = harness.events.filter(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "turn_item.updated" }
          > => event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
        );
        const terminalCommands = commandUpdatesBeforeLateEvents.filter(
          (event) =>
            event.turnItem.status === "interrupted" &&
            event.turnItem.nativeItemRef?.nativeId !== INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        assert.lengthOf(terminalCommands, 2);
        const boundaryUpdates = commandUpdatesBeforeLateEvents.filter(
          (event) => event.turnItem.nativeItemRef?.nativeId === INTERRUPT_TIMEOUT_BOUNDARY_ITEM,
        );
        const lastBoundaryUpdate = boundaryUpdates.at(-1);
        assert.isDefined(lastBoundaryUpdate);
        assert.equal(lastBoundaryUpdate.turnItem.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("20 seconds");
        for (let attempt = 0; attempt < 100; attempt++) {
          yield* Effect.yieldNow;
        }
        assert.lengthOf(harness.terminalEvents(), 1);
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "provider_turn.updated" && event.providerTurn.status === "interrupted",
          ),
          terminalProviderTurnsBeforeLateEvents.length,
          "late completion must not duplicate provider-turn finalization",
        );
        assert.lengthOf(
          harness.events.filter(
            (event) =>
              event.type === "turn_item.updated" && event.turnItem.type === "command_execution",
          ),
          commandUpdatesBeforeLateEvents.length,
          "late starts and completions must not project after timeout",
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  const interruptTerminationFailureTranscript = makeCodexReplayTranscript({
    scenario: "codex-interrupt-termination-failure",
    entries: [
      ...interruptMidCommandTranscript.entries
        .filter(
          (entry) => entry.type === "runtime_exit" || entry.label !== "item/completed/command-late",
        )
        .map((entry) =>
          entry.type === "emit_inbound" &&
          entry.label === "thread/backgroundTerminals/list/after-false"
            ? {
                ...entry,
                frame: {
                  id: 6,
                  result: {
                    data: [{ processId: "57680" }],
                    nextCursor: null,
                  },
                },
              }
            : entry,
        ),
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: {
          id: 8,
          method: "thread/backgroundTerminals/terminate",
          params: { threadId: INTERRUPT_NATIVE_THREAD, processId: "57680" },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/terminate/one-retry",
        frame: { id: 8, result: { terminated: false } },
      },
      {
        type: "expect_outbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          method: "thread/backgroundTerminals/list",
          params: { threadId: INTERRUPT_NATIVE_THREAD },
        },
      },
      {
        type: "emit_inbound",
        label: "thread/backgroundTerminals/list/after-false-retry",
        frame: {
          id: 9,
          result: { data: [{ processId: "57680" }], nextCursor: null },
        },
      },
      { type: "runtime_exit", status: "success" },
    ],
  });

  it.effect("attempts every terminal and cleans up tracking when termination fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(interruptTerminationFailureTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-interrupt-termination-failure"),
            text: INTERRUPT_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "running",
            ),
          "running command item",
        );
        const providerTurnId = harness.events.find(
          (
            event,
          ): event is Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { type: "provider_turn.updated" }
          > => event.type === "provider_turn.updated",
        )?.providerTurn.id;
        assert.isDefined(providerTurnId);

        const interruptExit = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId,
          })
          .pipe(Effect.exit);

        assert.equal(interruptExit._tag, "Failure");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "interrupted terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    {
      name: "usage",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "rate", code: "rateLimitExceeded", notification: false, expectedClass: "usage_limit" },
    {
      name: "ordinary",
      code: "contextWindowExceeded",
      notification: false,
      expectedClass: "provider_error",
    },
    {
      name: "notification",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "replacement",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "provider_error",
    },
    {
      name: "known-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "late-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "matching-details",
      code: "usageLimitExceeded",
      notification: true,
      expectedClass: "usage_limit",
    },
    {
      name: "deferred-reset",
      code: "usageLimitExceeded",
      notification: false,
      expectedClass: "usage_limit",
    },
    { name: "retry", code: "usageLimitExceeded", notification: true, expectedClass: "usage_limit" },
    {
      name: "exhausted-429",
      code: "responseTooManyFailedAttempts",
      errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      notification: false,
      expectedClass: "usage_limit",
    },
    {
      name: "exhausted-500",
      code: "responseTooManyFailedAttempts",
      errorInfo: { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
      notification: false,
      expectedClass: "provider_error",
    },
  ] as const)("classifies Codex terminal failures from $name evidence", (scenario) =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = `native-limit-${scenario.name}`;
        const nativeTurnId = `turn-limit-${scenario.name}`;
        const message = "Provider stopped this request.";
        const errorInfo = "errorInfo" in scenario ? scenario.errorInfo : scenario.code;
        const resetAt = "2033-05-19T07:20:00.000Z";
        const snapshot = {
          type: "emit_inbound" as const,
          label: "account/rateLimits/updated",
          frame: {
            method: "account/rateLimits/updated",
            params: {
              rateLimits: {
                limitId: "codex",
                primary: { usedPercent: 100, resetsAt: 2000100000, windowDurationMins: 300 },
              },
            },
          },
        };
        const transcript = makeCodexReplayTranscript({
          scenario: `codex-limit-${scenario.name}`,
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
            ...(scenario.name === "known-reset" || scenario.name === "deferred-reset"
              ? [snapshot]
              : []),
            ...(scenario.name === "deferred-reset"
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "item/completed/subAgentActivity-started",
                    frame: {
                      method: "item/completed",
                      params: {
                        threadId: nativeThreadId,
                        turnId: nativeTurnId,
                        item: {
                          type: "subAgentActivity",
                          id: "limit-child-spawn",
                          kind: "started",
                          agentThreadId: "native-limit-child",
                          agentPath: "/root/limit_child",
                        },
                      },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/started/child",
                    frame: {
                      method: "turn/started",
                      params: {
                        threadId: "native-limit-child",
                        turn: makeCodexReplayTurn({
                          id: "limit-child-turn",
                          status: "inProgress",
                        }),
                      },
                    },
                  },
                ]
              : []),
            ...(scenario.notification
              ? [
                  {
                    type: "emit_inbound" as const,
                    label: "error",
                    frame: {
                      method: "error",
                      params: {
                        threadId: nativeThreadId,
                        turnId: nativeTurnId,
                        willRetry: scenario.name === "retry",
                        error: {
                          message,
                          codexErrorInfo: errorInfo,
                          additionalDetails:
                            scenario.name === "matching-details"
                              ? "Detailed provider allowance explanation."
                              : null,
                        },
                      },
                    },
                  },
                ]
              : []),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: {
                    ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                    error: {
                      message: scenario.name === "replacement" ? "A different failure." : message,
                      ...(scenario.notification && scenario.name !== "matching-details"
                        ? {}
                        : { codexErrorInfo: errorInfo }),
                    },
                  },
                },
              },
            },
            ...(scenario.name === "late-reset" ? [snapshot] : []),
            ...(scenario.name === "deferred-reset"
              ? [
                  {
                    ...snapshot,
                    frame: {
                      method: "account/rateLimits/updated",
                      params: {
                        rateLimits: {
                          limitId: "codex",
                          primary: {
                            usedPercent: 100,
                            resetsAt: 2000200000,
                            windowDurationMins: 300,
                          },
                        },
                      },
                    },
                  },
                  {
                    type: "emit_inbound" as const,
                    label: "turn/completed/child",
                    frame: {
                      method: "turn/completed",
                      params: {
                        threadId: "native-limit-child",
                        turn: makeCodexReplayTurn({
                          id: "limit-child-turn",
                          status: "completed",
                        }),
                      },
                    },
                  },
                ]
              : []),
          ],
        });
        const resetReceipt = yield* Deferred.make<void>();
        const harness = yield* makeCodexReplayHarness(transcript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "error" &&
          event.turnItem.failure.resetAt === resetAt
            ? Deferred.succeed(resetReceipt, undefined)
            : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            text: "Continue.",
            attemptId: RunAttemptId.make(`attempt-limit-${scenario.name}`),
          }),
        );
        yield* harness.firstTerminal;
        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.failure.class, scenario.expectedClass);
        assert.equal(terminal.threadDisposition, "reusable");
        if (scenario.name === "known-reset" || scenario.name === "deferred-reset")
          assert.equal(terminal.failure.resetAt, resetAt);
        if (scenario.name === "matching-details")
          assert.equal(terminal.failure.message, "Detailed provider allowance explanation.");
        if (scenario.name === "late-reset") {
          yield* Deferred.await(resetReceipt);
          const item = harness.events.find(
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.failure.resetAt === resetAt,
          );
          assert.isDefined(item);
        }
        if (scenario.name === "retry") assert.equal(terminal.retry?.attempt, 1);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect.each([
    {
      notificationStatus: 500,
      completionStatus: 429,
      willRetry: false,
      expectedClass: "usage_limit",
    },
    {
      notificationStatus: 429,
      completionStatus: 500,
      willRetry: true,
      expectedClass: "provider_error",
    },
    {
      notificationStatus: 429,
      completionStatus: null,
      willRetry: false,
      expectedClass: "usage_limit",
    },
    {
      notificationStatus: 429,
      completionStatus: null,
      willRetry: true,
      expectedClass: "usage_limit",
    },
  ] as const)(
    "honors completion HTTP status from $notificationStatus to $completionStatus (retry: $willRetry)",
    ({ notificationStatus, completionStatus, expectedClass, willRetry }) =>
      Effect.scoped(
        Effect.gen(function* () {
          const name = `${notificationStatus}-${completionStatus}-${willRetry}`;
          const nativeThreadId = `native-exhaustion-status-${name}`;
          const nativeTurnId = `turn-exhaustion-status-${name}`;
          const message = "Provider stopped this request.";
          const additionalDetails = "Detailed notification evidence.";
          const transcript = makeCodexReplayTranscript({
            scenario: `codex-exhaustion-status-${name}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Continue." }),
              {
                type: "emit_inbound",
                label: "error",
                frame: {
                  method: "error",
                  params: {
                    threadId: nativeThreadId,
                    turnId: nativeTurnId,
                    willRetry,
                    error: {
                      message,
                      codexErrorInfo: {
                        responseTooManyFailedAttempts: { httpStatusCode: notificationStatus },
                      },
                      additionalDetails,
                    },
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: {
                      ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                      error: {
                        message,
                        codexErrorInfo: {
                          responseTooManyFailedAttempts: { httpStatusCode: completionStatus },
                        },
                      },
                    },
                  },
                },
              },
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              text: "Continue.",
              attemptId: RunAttemptId.make(`attempt-exhaustion-status-${name}`),
            }),
          );
          yield* harness.firstTerminal;
          const terminal = harness.terminalEvents()[0];
          assert.equal(terminal?.status, "failed");
          if (terminal?.status !== "failed") return;
          assert.equal(terminal.failure.class, expectedClass);
          assert.equal(terminal.failure.code, "responseTooManyFailedAttempts");
          assert.equal(terminal.threadDisposition, "reusable");
          const notificationClass = notificationStatus === 429 ? "usage_limit" : "provider_error";
          assert.equal(
            terminal.failure.message,
            expectedClass === notificationClass ? additionalDetails : message,
          );
          if (willRetry) assert.equal(terminal.retry?.attempt, 1);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  // regression: #28032 an unlisted codexErrorInfo dropped the failed turn/completed
  it.effect("fails the turn when Codex reports an error info the schema does not list", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "native-unlisted-error-info";
        const nativeTurnId = "turn-unlisted-error-info";
        const message =
          "The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.";
        const error = { message, codexErrorInfo: "modelNotFound", additionalDetails: null };
        const usage = {
          totalTokens: 1,
          inputTokens: 1,
          cachedInputTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        };
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-unlisted-error-info",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "say hi" }),
            {
              type: "emit_inbound",
              label: "error",
              frame: {
                method: "error",
                params: { threadId: nativeThreadId, turnId: nativeTurnId, willRetry: false, error },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: nativeThreadId,
                  turn: { ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }), error },
                },
              },
            },
            // Notifications dispatch in order, so this marks turn/completed as handled.
            {
              type: "emit_inbound",
              label: "usage",
              frame: {
                method: "thread/tokenUsage/updated",
                params: {
                  threadId: nativeThreadId,
                  turnId: nativeTurnId,
                  tokenUsage: { total: usage, last: usage, modelContextWindow: 200_000 },
                },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            text: "say hi",
            attemptId: RunAttemptId.make("attempt-unlisted-error-info"),
          }),
        );
        yield* harness.until(
          () =>
            harness.terminalEvents().length > 0 ||
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" && event.providerTurn.tokenUsage != null,
            ),
        );
        const terminal = harness.terminalEvents()[0];
        assert.equal(terminal?.status, "failed");
        if (terminal?.status !== "failed") return;
        assert.equal(terminal.failure.message, message);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const FAILED_SCENARIO = "codex-failed-mid-command";
  const FAILED_NATIVE_THREAD = "native-codex-failed-thread";
  const FAILED_NATIVE_TURN = "native-codex-failed-turn";
  const FAILED_COMMAND_ITEM = "exec-codex-failed-command";
  const FAILED_COMMAND = "sleep 30";
  const FAILED_PROMPT = "Run a command that will be abandoned when the turn fails.";

  const failedMidCommandTranscript = makeCodexReplayTranscript({
    scenario: FAILED_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: FAILED_NATIVE_THREAD,
        nativeTurnId: FAILED_NATIVE_TURN,
        prompt: FAILED_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/command",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "commandExecution",
              id: FAILED_COMMAND_ITEM,
              command: FAILED_COMMAND,
              cwd: "/workspace",
              processId: "99",
              source: "unifiedExecStartup",
              status: "inProgress",
              commandActions: [{ type: "unknown", command: FAILED_COMMAND }],
              aggregatedOutput: null,
              exitCode: null,
              durationMs: null,
            },
            threadId: FAILED_NATIVE_THREAD,
            turnId: FAILED_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: FAILED_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({
                id: FAILED_NATIVE_TURN,
                status: "failed",
              }),
              error: { message: "provider failed mid-command" },
            },
          },
        },
      },
    ],
  });

  it.effect("terminalizes running command items before turn.terminal on failed turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedMidCommandTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-failed-mid-command"),
            text: FAILED_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        const failedCommandIndex = harness.events.findIndex(
          (event, index) =>
            index < terminalIndex &&
            event.type === "turn_item.updated" &&
            event.turnItem.type === "command_execution" &&
            event.turnItem.status === "failed",
        );
        assert.isAtLeast(failedCommandIndex, 0);
        assert.isAbove(
          terminalIndex,
          failedCommandIndex,
          "failed-turn command terminalization must precede turn.terminal",
        );
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const MCP_APP_SCENARIO = "codex-mcp-app-capture";
  const MCP_APP_NATIVE_THREAD = "native-codex-mcp-app-thread";
  const MCP_APP_NATIVE_TURN = "native-codex-mcp-app-turn";
  const MCP_APP_ITEM = "mcp-weather-call";
  const MCP_APP_PROMPT = "Show the weather in Oslo.";
  const MCP_APP_RESOURCE = "ui://weather/dashboard";
  const MCP_APP_HTML = "<!doctype html><html><body><p>Weather</p><script>1</script></body></html>";
  const mcpAppToolItem = (status: "inProgress" | "completed") => ({
    type: "mcpToolCall",
    id: MCP_APP_ITEM,
    server: "weather",
    tool: "get_weather",
    status,
    arguments: { city: "Oslo" },
    mcpAppResourceUri: MCP_APP_RESOURCE,
    ...(status === "completed"
      ? { result: { content: [{ type: "text", text: "Sunny" }], structuredContent: { temp: 21 } } }
      : {}),
  });

  const mcpAppTranscript = makeCodexReplayTranscript({
    scenario: MCP_APP_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: MCP_APP_NATIVE_THREAD,
        nativeTurnId: MCP_APP_NATIVE_TURN,
        prompt: MCP_APP_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/app-tool",
        frame: {
          method: "item/started",
          params: {
            item: mcpAppToolItem("inProgress"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/app-tool",
        frame: {
          method: "item/completed",
          params: {
            item: mcpAppToolItem("completed"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: MCP_APP_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      {
        type: "expect_outbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          method: "mcpServer/resource/read",
          params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
        },
      },
      {
        type: "emit_inbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          result: {
            contents: [
              {
                uri: MCP_APP_RESOURCE,
                mimeType: "text/html;profile=mcp-app",
                text: MCP_APP_HTML,
                _meta: { ui: { csp: { connectDomains: ["https://api.weather.test"] } } },
              },
            ],
          },
        },
      },
    ],
  });

  // Caveman Code: T3 ships no Codex attachment test; images go native, every attachment by path.
  it.effect("sends an image attachment as a native image and names its stored path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "thread-codex-image";
        const nativeTurnId = "turn-codex-image";
        const prompt = "What is in this screenshot?";
        const preamble = codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt });
        // The stored path exists only once the harness has its attachments dir,
        // so the expected turn/start input is filled in below.
        const turnStart = preamble.find(
          (entry) => entry.type === "expect_outbound" && entry.label === "turn/start",
        ) as { readonly frame: { readonly params: Record<string, unknown> } };
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-image-attachment",
            entries: [
              ...preamble,
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                  },
                },
              },
            ],
          }),
        );
        const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
        const attachment = {
          type: "image",
          id: "thread-codex-image-1",
          name: "shot.png",
          mimeType: "image/png",
          sizeBytes: png.length,
        } as const;
        const stored = resolveAttachmentPath({
          attachmentsDir: harness.serverConfig.attachmentsDir,
          attachment,
        })!;
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fileSystem.makeDirectory(stored.slice(0, stored.lastIndexOf("/")), { recursive: true });
        yield* fileSystem.writeFile(stored, png);
        turnStart.frame.params.input = [
          { type: "text", text: `${prompt}\n\n[Attached image "shot.png" is saved at: ${stored}]` },
          { type: "image", url: `data:image/png;base64,${png.toString("base64")}` },
        ];

        const turnInput = makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now: yield* DateTime.now,
          attemptId: RunAttemptId.make("attempt-codex-image"),
          text: prompt,
        });
        yield* harness.runtime.startTurn({
          ...turnInput,
          message: { ...turnInput.message, attachments: [attachment] },
        });
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  // Codex 0.161 suggests the user's next prompt; the transcript never shows it.
  it.effect("ignores Codex next-prompt predictions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const nativeThreadId = "thread-codex-prediction";
        const nativeTurnId = "turn-codex-prediction";
        const prompt = "Say hi.";
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-prediction",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              {
                type: "emit_inbound",
                label: "thread/prediction/updated",
                frame: {
                  method: "thread/prediction/updated",
                  params: {
                    threadId: nativeThreadId,
                    sourceTurnId: nativeTurnId,
                    result: { type: "completed", text: "run the tests next" },
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: nativeThreadId,
                    turn: makeCodexReplayTurn({ id: nativeTurnId, status: "completed" }),
                  },
                },
              },
            ],
          }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-prediction"),
            text: prompt,
          }),
        );
        yield* harness.firstTerminal;
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.notInclude(JSON.stringify(harness.events), "run the tests next");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("captures an MCP app's resource and holds the turn open until it lands", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const appCaptured = yield* Deferred.make<OrchestrationV2TurnItem>();
        const harness = yield* makeCodexReplayHarness(mcpAppTranscript, (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed"
            ? Deferred.succeed(appCaptured, event.turnItem)
            : Effect.void,
        );
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-mcp-app"),
            text: MCP_APP_PROMPT,
          }),
        );
        const item = yield* Deferred.await(appCaptured);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");

        // The completed tool row is emitted once, with the app, never as a bare row first.
        const completedRows = harness.events.filter(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed",
        );
        assert.lengthOf(completedRows, 1);

        assert.equal(item.type, "dynamic_tool");
        const output = item.type === "dynamic_tool" ? (item.output as Record<string, unknown>) : {};
        const reference = readMcpAppReference(output[MCP_APP_OUTPUT_KEY]);
        assert.deepEqual(
          { ...reference, attachmentId: undefined },
          {
            attachmentId: undefined,
            server: "weather",
            tool: "get_weather",
            resourceUri: MCP_APP_RESOURCE,
            csp: { connectDomains: ["https://api.weather.test"] },
          },
        );
        assert.deepEqual(output.result, {
          content: [{ type: "text", text: "Sunny" }],
          structuredContent: { temp: 21 },
        });

        const fileSystem = yield* FileSystem.FileSystem;
        const stored = yield* fileSystem.readFileString(
          resolveAttachmentPathById({
            attachmentsDir: harness.serverConfig.attachmentsDir,
            attachmentId: reference!.attachmentId,
          })!,
        );
        // Stored with the app's declared policy ahead of its scripts.
        assert.include(stored, "connect-src https://api.weather.test");
        assert.isBelow(stored.indexOf("Content-Security-Policy"), stored.indexOf("<script>"));
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  // The turn fails while the app's resource read is still outstanding (Codex
  // never answers it), so the capture must be cancelled and its tool row
  // settled before the terminal event closes ingestion.
  const failedMcpAppTranscript = makeCodexReplayTranscript({
    scenario: "codex-mcp-app-capture-failed-turn",
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: MCP_APP_NATIVE_THREAD,
        nativeTurnId: MCP_APP_NATIVE_TURN,
        prompt: MCP_APP_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/app-tool",
        frame: {
          method: "item/completed",
          params: {
            item: mcpAppToolItem("completed"),
            threadId: MCP_APP_NATIVE_THREAD,
            turnId: MCP_APP_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "expect_outbound",
        label: "mcpServer/resource/read",
        frame: {
          id: 4,
          method: "mcpServer/resource/read",
          params: { threadId: MCP_APP_NATIVE_THREAD, server: "weather", uri: MCP_APP_RESOURCE },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: MCP_APP_NATIVE_THREAD,
            turn: {
              ...makeCodexReplayTurn({ id: MCP_APP_NATIVE_TURN, status: "failed" }),
              error: { message: "provider failed mid-capture" },
            },
          },
        },
      },
    ],
  });

  it.effect("settles a pending MCP app capture before a failed turn's terminal event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(failedMcpAppTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-mcp-app-failed"),
            text: MCP_APP_PROMPT,
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "failed terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "failed");

        const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
        const rows = harness.events.flatMap((event, index) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "dynamic_tool" &&
          event.turnItem.status === "completed"
            ? [{ index, turnItem: event.turnItem }]
            : [],
        );
        // Settled once, as a plain tool row, ahead of the terminal event.
        assert.lengthOf(rows, 1);
        assert.isBelow(rows[0]!.index, terminalIndex);
        const output = rows[0]!.turnItem.type === "dynamic_tool" ? rows[0]!.turnItem.output : null;
        assert.isUndefined((output as Record<string, unknown> | null)?.[MCP_APP_OUTPUT_KEY]);
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const ORPHAN_WAIT_SCENARIO = "codex-orphaned-dynamic-tool";
  const ORPHAN_WAIT_NATIVE_THREAD = "native-codex-orphan-wait-thread";
  const ORPHAN_WAIT_NATIVE_TURN = "native-codex-orphan-wait-turn";
  const ORPHAN_WAIT_ITEM = "exec-4669f3bb-78c9-4af1-b44e-daa340d2c538";
  const PERSISTENT_MONITOR_ITEM = "exec-persistent-monitor";
  const COMPLETED_WAIT_ITEM = "exec-completed-wait";
  const ORPHAN_WAIT_PROMPT = "Wait on two nested tasks, then finish.";

  const orphanedDynamicToolTranscript = makeCodexReplayTranscript({
    scenario: ORPHAN_WAIT_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: ORPHAN_WAIT_NATIVE_THREAD,
        nativeTurnId: ORPHAN_WAIT_NATIVE_TURN,
        prompt: ORPHAN_WAIT_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/started/completed-wait",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "mcpToolCall",
              id: COMPLETED_WAIT_ITEM,
              server: "caveman-code",
              tool: "thread_wait",
              status: "inProgress",
              arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622440500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/completed-wait",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "mcpToolCall",
              id: COMPLETED_WAIT_ITEM,
              server: "caveman-code",
              tool: "thread_wait",
              status: "completed",
              arguments: { threadId: "thread:completed-wait", timeoutMs: 30000 },
              result: { content: [{ type: "text", text: "idle" }] },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            completedAtMs: 1782622441500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/orphan-wait",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "mcpToolCall",
              id: ORPHAN_WAIT_ITEM,
              server: "caveman-code",
              tool: "thread_wait",
              status: "inProgress",
              arguments: {
                threadId:
                  "thread:delegated-task:command%3Amcp%3Aaafffab1-e811-458a-ae83-558e542c61ff%3Adelegate-task%3Areview-mobile-reconnect-opus-20260815",
                timeoutMs: 30000,
              },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622442500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/started/persistent-monitor",
        frame: {
          method: "item/started",
          params: {
            item: {
              type: "dynamicToolCall",
              id: PERSISTENT_MONITOR_ITEM,
              namespace: "grok",
              tool: "monitor",
              status: "inProgress",
              arguments: { persistent: true, command: "tail -f" },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            startedAtMs: 1782622443500,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed",
        frame: {
          method: "turn/completed",
          params: {
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turn: makeCodexReplayTurn({
              id: ORPHAN_WAIT_NATIVE_TURN,
              status: "completed",
            }),
          },
        },
      },
      {
        type: "emit_inbound",
        label: "item/completed/persistent-monitor",
        afterMs: 30_000,
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "dynamicToolCall",
              id: PERSISTENT_MONITOR_ITEM,
              namespace: "grok",
              tool: "monitor",
              status: "completed",
              arguments: { persistent: true, command: "tail -f" },
              result: { content: [{ type: "text", text: "stopped" }] },
            },
            threadId: ORPHAN_WAIT_NATIVE_THREAD,
            turnId: ORPHAN_WAIT_NATIVE_TURN,
            completedAtMs: 1782622473500,
          },
        },
      },
    ],
  });

  it.effect(
    "terminalizes leftover nonpersistent dynamic tools when a completed turn never closes them",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const monitorCompleted = yield* Deferred.make<void>();
          const harness = yield* makeCodexReplayHarness(orphanedDynamicToolTranscript, (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM &&
            event.turnItem.status === "completed"
              ? Deferred.succeed(monitorCompleted, undefined)
              : Effect.void,
          );
          const now = yield* DateTime.now;

          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now,
              attemptId: RunAttemptId.make("attempt-codex-orphan-wait"),
              text: ORPHAN_WAIT_PROMPT,
            }),
          );
          yield* harness.firstTerminal;
          assert.equal(harness.terminalEvents()[0]?.status, "completed");

          const terminalIndex = harness.events.findIndex((event) => event.type === "turn.terminal");
          const cancelledWait = harness.events.find(
            (event, index) =>
              index < terminalIndex &&
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === ORPHAN_WAIT_ITEM &&
              event.turnItem.status === "cancelled",
          );
          assert.isDefined(cancelledWait);
          assert.isAbove(
            terminalIndex,
            harness.events.indexOf(cancelledWait!),
            "orphaned wait terminalization must precede turn.terminal",
          );

          const completedWaitStatuses = new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === COMPLETED_WAIT_ITEM
                ? [event.turnItem.status]
                : [],
            ),
          );
          assert.isTrue(
            completedWaitStatuses.has("completed"),
            "the wait that received item/completed must stay completed",
          );
          assert.isFalse(
            completedWaitStatuses.has("cancelled"),
            "a completed wait must not be rewritten as cancelled",
          );

          const persistentMonitorStatuses = new Set(
            harness.events.flatMap((event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM
                ? [event.turnItem.status]
                : [],
            ),
          );
          assert.isTrue(persistentMonitorStatuses.has("running"));
          assert.isFalse(
            persistentMonitorStatuses.has("cancelled"),
            "persistent monitors must remain running after the root turn completes",
          );
          assert.isTrue(
            yield* harness.hasPendingBackgroundWork,
            "persistent dynamic tools must keep the session residency pin until they complete",
          );

          yield* TestClock.adjust("30 seconds");
          yield* Deferred.await(monitorCompleted);
          const lateMonitorUpdateIndex = harness.events.findIndex(
            (event, index) =>
              index > terminalIndex &&
              event.type === "turn_item.updated" &&
              event.turnItem.type === "dynamic_tool" &&
              event.turnItem.nativeItemRef?.nativeId === PERSISTENT_MONITOR_ITEM &&
              event.turnItem.status === "completed",
          );
          assert.isAbove(
            lateMonitorUpdateIndex,
            terminalIndex,
            "persistent tool completion must follow turn.terminal",
          );
          assert.lengthOf(harness.terminalEvents(), 1);
          assert.isFalse(yield* harness.hasPendingBackgroundWork);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );

  const RESUME_SCENARIO = "codex-resume-subagent";
  const RESUME_NATIVE_THREAD = "native-codex-resume-thread";
  const RESUME_NATIVE_TURN = "native-codex-resume-root-turn";
  const RESUME_CHILD_THREAD = "native-codex-resume-child-thread";
  const RESUME_CHILD_TURN_1 = "native-codex-resume-child-turn-1";
  const RESUME_CHILD_TURN_2 = "native-codex-resume-child-turn-2";
  const RESUME_PROMPT = "Spawn a sub-agent, nudge it, and reply NUDGED.";

  const childAgentMessage = (input: {
    readonly id: string;
    readonly text: string;
    readonly turnId: string;
    readonly completedAtMs: number;
    readonly afterMs?: number;
    readonly omitPhase?: boolean;
  }): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `item/completed/${input.id}`,
    ...(input.afterMs === undefined ? {} : { afterMs: input.afterMs }),
    frame: {
      method: "item/completed",
      params: {
        item: {
          type: "agentMessage",
          id: input.id,
          text: input.text,
          ...(input.omitPhase ? {} : { phase: "final_answer" as const }),
          memoryCitation: null,
        },
        threadId: RESUME_CHILD_THREAD,
        turnId: input.turnId,
        completedAtMs: input.completedAtMs,
      },
    },
  });

  const childTurnStarted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/started/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/started",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: {
          ...makeCodexReplayTurn({ id: turnId, status: "inProgress" }),
          startedAt: turnId === RESUME_CHILD_TURN_2 ? 1782622470 : 1782622440,
        },
      },
    },
  });

  const childTurnCompleted = (
    turnId: string,
    afterMs?: number,
  ): CodexReplay.CodexAppServerReplayEntry => ({
    type: "emit_inbound",
    label: `turn/completed/${turnId}`,
    ...(afterMs === undefined ? {} : { afterMs }),
    frame: {
      method: "turn/completed",
      params: {
        threadId: RESUME_CHILD_THREAD,
        turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
      },
    },
  });

  const resumeSubagentTranscript = makeCodexReplayTranscript({
    scenario: RESUME_SCENARIO,
    entries: [
      ...codexReplayPreamble({
        nativeThreadId: RESUME_NATIVE_THREAD,
        nativeTurnId: RESUME_NATIVE_TURN,
        prompt: RESUME_PROMPT,
      }),
      {
        type: "emit_inbound",
        label: "item/completed/subAgentActivity-started",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "subAgentActivity",
              id: "call-codex-resume-spawn",
              kind: "started",
              agentThreadId: RESUME_CHILD_THREAD,
              agentPath: "/root/resume_agent",
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622441000,
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_1),
      childAgentMessage({
        id: "child-first-answer",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442000,
      }),
      childAgentMessage({
        id: "child-first-answer-empty",
        text: "",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442001,
        omitPhase: true,
      }),
      childAgentMessage({
        id: "child-first-answer-duplicate",
        text: "CODEX_FIRST_DONE",
        turnId: RESUME_CHILD_TURN_1,
        completedAtMs: 1782622442002,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_1, 100),
      {
        type: "emit_inbound",
        label: "item/completed/root-answer",
        frame: {
          method: "item/completed",
          params: {
            item: {
              type: "agentMessage",
              id: "root-answer-resume",
              text: "NUDGED",
              phase: "final_answer",
              memoryCitation: null,
            },
            threadId: RESUME_NATIVE_THREAD,
            turnId: RESUME_NATIVE_TURN,
            completedAtMs: 1782622443000,
          },
        },
      },
      {
        type: "emit_inbound",
        label: "turn/completed/root",
        frame: {
          method: "turn/completed",
          params: {
            threadId: RESUME_NATIVE_THREAD,
            turn: makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "completed" }),
          },
        },
      },
      childTurnStarted(RESUME_CHILD_TURN_2, 30_000),
      childAgentMessage({
        id: "child-resume-answer",
        text: "CODEX_RESUME_DONE",
        turnId: RESUME_CHILD_TURN_2,
        completedAtMs: 1782622480000,
        afterMs: 30_000,
      }),
      childTurnCompleted(RESUME_CHILD_TURN_2),
    ],
  });

  it.effect.each([
    { name: "current Codex Sol", model: "gpt-6-sol" },
    { name: "current Codex wrong child", model: null },
    { name: "Sol", model: "gpt-5.6-sol" },
    { name: "Fable", model: "gpt-5.6-fable" },
    { name: "Astra", model: "gpt-6-astra" },
    { name: "missing", model: null },
    { name: "invalid", model: null },
    { name: "wrong child", model: null },
  ])("reads $name child metadata without using the parent model", ({ name, model }) =>
    Effect.scoped(
      Effect.gen(function* () {
        const metadataRead = yield* Deferred.make<void>();
        const modelReported = yield* Deferred.make<void>();
        let metadataRequests = 0;
        const harness = yield* makeCodexReplayHarness(
          resumeSubagentTranscript,
          (event) =>
            event.type === "subagent.updated" && event.subagent.model === model
              ? Deferred.succeed(modelReported, undefined)
              : Effect.void,
          undefined,
          (threadId) => {
            metadataRequests++;
            assert.equal(threadId, RESUME_CHILD_THREAD);
            return Deferred.succeed(metadataRead, undefined).pipe(
              Effect.as(
                name === "invalid"
                  ? {}
                  : {
                      thread: {
                        id: name.includes("wrong child") ? "other-child" : threadId,
                        ...(name.startsWith("current Codex")
                          ? { model: "gpt-6-sol", reasoningEffort: "high" }
                          : {}),
                      },
                      model: name.startsWith("current Codex")
                        ? null
                        : name === "wrong child"
                          ? "gpt-5.6-sol"
                          : model,
                      reasoningEffort: "high",
                      serviceTier: "priority",
                    },
              ),
            );
          },
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-child-model"),
            text: RESUME_PROMPT,
          }),
        );
        yield* Deferred.await(metadataRead);
        yield* Deferred.await(modelReported);
        yield* TestClock.adjust("100 millis");
        yield* harness.firstTerminal;
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
        if (model) {
          assert.deepEqual(harness.subagentUpdates().at(-1)?.subagent.modelSelection?.options, [
            { id: "reasoningEffort", value: "high" },
            ...(name.startsWith("current Codex") ? [] : [{ id: "serviceTier", value: "priority" }]),
          ]);
        }
        assert.equal(metadataRequests, name === "current Codex Sol" ? 1 : 2);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect.each(["failed", "malformed", "wrong child", "blank model"] as const)(
    "resumes child metadata after a %s read",
    (readResult) =>
      Effect.scoped(
        Effect.gen(function* () {
          const modelReported = yield* Deferred.make<void>();
          const model = "gpt-6-sol";
          const metadataRequests: Array<string> = [];
          const harness = yield* makeCodexReplayHarness(
            resumeSubagentTranscript,
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(modelReported, undefined)
                : Effect.void,
            undefined,
            (threadId, method) => {
              assert.equal(threadId, RESUME_CHILD_THREAD);
              metadataRequests.push(method);
              if (method === "thread/resume") {
                return Effect.succeed({ thread: { id: threadId }, model });
              }
              switch (readResult) {
                case "failed":
                  return Effect.fail(
                    new CodexError.CodexAppServerRequestError({
                      code: -32000,
                      errorMessage: "Child metadata unavailable",
                      method,
                    }),
                  );
                case "malformed":
                  return Effect.succeed({});
                case "wrong child":
                  return Effect.succeed({ thread: { id: "other-child", model: "gpt-6-astra" } });
                case "blank model":
                  return Effect.succeed({ thread: { id: threadId, model: " \t " } });
              }
            },
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model-fallback"),
              text: RESUME_PROMPT,
            }),
          );
          yield* Deferred.await(modelReported);
          yield* TestClock.adjust("100 millis");
          yield* harness.firstTerminal;
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
          assert.deepEqual(metadataRequests, ["thread/read", "thread/resume"]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect.each(["thread/settings/updated", "model/rerouted"] as const)(
    "keeps %s child metadata when an older lookup finishes later",
    (method) =>
      Effect.scoped(
        Effect.gen(function* () {
          const releaseMetadata = yield* Deferred.make<void>();
          const observed = yield* Deferred.make<void>();
          const model = "gpt-5.6-sol";
          const notification: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method,
              params:
                method === "model/rerouted"
                  ? {
                      threadId: RESUME_CHILD_THREAD,
                      turnId: RESUME_CHILD_TURN_1,
                      fromModel: "gpt-6-astra",
                      toModel: model,
                      reason: "highRiskCyberActivity",
                    }
                  : {
                      threadId: RESUME_CHILD_THREAD,
                      threadSettings: {
                        model,
                        effort: "low",
                        serviceTier: "ultrafast",
                        modelProvider: "openai",
                        cwd: "/workspace",
                        approvalPolicy: "never",
                        approvalsReviewer: "auto_review",
                        collaborationMode: { mode: "default", settings: { model } },
                        sandboxPolicy: { type: "dangerFullAccess" },
                      },
                    },
            },
          };
          const initialSettings: CodexReplay.CodexAppServerReplayEntry = {
            type: "emit_inbound",
            frame: {
              method: "thread/settings/updated",
              params: {
                threadId: RESUME_CHILD_THREAD,
                threadSettings: {
                  model: "gpt-6-astra",
                  effort: "low",
                  serviceTier: "ultrafast",
                  modelProvider: "openai",
                  cwd: "/workspace",
                  approvalPolicy: "never",
                  approvalsReviewer: "auto_review",
                  collaborationMode: { mode: "default", settings: { model: "gpt-6-astra" } },
                  sandboxPolicy: { type: "dangerFullAccess" },
                },
              },
            },
          };
          const harness = yield* makeCodexReplayHarness(
            {
              ...resumeSubagentTranscript,
              entries: resumeSubagentTranscript.entries.flatMap((entry) =>
                entry.type === "emit_inbound" && entry.label === "turn/completed/root"
                  ? [entry, initialSettings, notification]
                  : [entry],
              ),
            },
            (event) =>
              event.type === "subagent.updated" && event.subagent.model === model
                ? Deferred.succeed(observed, undefined)
                : Effect.void,
            undefined,
            (threadId) =>
              Deferred.await(releaseMetadata).pipe(
                Effect.as({ thread: { id: threadId }, model: "gpt-6-astra" }),
              ),
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-model-update"),
              text: RESUME_PROMPT,
            }),
          );
          yield* TestClock.adjust("100 millis");
          yield* Deferred.await(observed);
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
          yield* Deferred.succeed(releaseMetadata, undefined);
          yield* TestClock.adjust("30 seconds");
          assert.equal(harness.subagentUpdates().at(-1)?.subagent.model, model);
          assert.deepEqual(harness.subagentUpdates().at(-1)?.subagent.modelSelection?.options, [
            { id: "reasoningEffort", value: "low" },
            { id: "serviceTier", value: "ultrafast" },
          ]);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect.each(["activity", "spawn", "activity then spawn"] as const)(
    "creates a child from %s without the parent's effort",
    (source) =>
      Effect.scoped(
        Effect.gen(function* () {
          const created = yield* Deferred.make<OrchestrationV2AppThread>();
          const completed = yield* Deferred.make<OrchestrationV2Subagent>();
          const activity = {
            type: "subAgentActivity",
            id: "call-codex-resume-spawn",
            kind: "started",
            agentThreadId: RESUME_CHILD_THREAD,
            agentPath: "/root/resume_agent",
          };
          const spawn = {
            type: "collabAgentToolCall",
            id: "call-codex-resume-spawn",
            tool: "spawnAgent",
            status: "completed",
            senderThreadId: RESUME_NATIVE_THREAD,
            receiverThreadIds: [RESUME_CHILD_THREAD],
            model: "gpt-5.4",
            reasoningEffort: "high",
            agentsStates: { [RESUME_CHILD_THREAD]: { status: "completed", message: "finished" } },
          };
          const items =
            source === "activity" ? [activity] : source === "spawn" ? [spawn] : [activity, spawn];
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({
              scenario: RESUME_SCENARIO,
              entries: [
                ...codexReplayPreamble({
                  nativeThreadId: RESUME_NATIVE_THREAD,
                  nativeTurnId: RESUME_NATIVE_TURN,
                  prompt: RESUME_PROMPT,
                  effort: "low",
                }),
                ...items.map((item) => ({
                  type: "emit_inbound" as const,
                  frame: {
                    method: "item/completed",
                    params: {
                      item,
                      threadId: RESUME_NATIVE_THREAD,
                      turnId: RESUME_NATIVE_TURN,
                      completedAtMs: 1782622441000,
                    },
                  },
                })),
              ],
            }),
            (event) =>
              event.type === "app_thread.created"
                ? Deferred.succeed(created, event.appThread)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(completed, event.subagent)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn({
            ...makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("attempt-child-effort"),
              text: RESUME_PROMPT,
            }),
            modelSelection: {
              ...CODEX_TEST_MODEL_SELECTION,
              options: [{ id: "reasoningEffort", value: "low" }],
            },
          });
          const child = yield* Deferred.await(created);
          assert.equal(
            child.modelSelection.options?.find(({ id }) => id === "reasoningEffort")?.value,
            source === "spawn" ? "high" : undefined,
          );
          if (source !== "activity") {
            const task = yield* Deferred.await(completed);
            assert.equal(
              task.modelSelection?.options?.find(({ id }) => id === "reasoningEffort")?.value,
              "high",
            );
            assert.lengthOf(
              harness.events.filter((event) => event.type === "app_thread.created"),
              1,
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
      ),
  );

  it.effect("preserves a subagent result across a trailing empty final and resume", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeCodexReplayHarness(resumeSubagentTranscript);
        const now = yield* DateTime.now;

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("attempt-codex-resume"),
            text: RESUME_PROMPT,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.subagentUpdates().some((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          "first subagent result",
        );
        assert.lengthOf(
          harness.subagentUpdates().filter((event) => event.subagent.result === "CODEX_FIRST_DONE"),
          1,
        );
        yield* TestClock.adjust("100 millis");
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "root turn terminal");
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        const settledUpdates = harness.subagentUpdates();
        const firstCompletion = settledUpdates[settledUpdates.length - 1];
        assert.equal(firstCompletion?.subagent.status, "completed");
        assert.equal(firstCompletion?.subagent.result, "CODEX_FIRST_DONE");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        const settledUpdateCount = settledUpdates.length;

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(
          () => harness.subagentUpdates().length > settledUpdateCount,
          "subagent re-open",
        );
        const reopened = harness.subagentUpdates()[settledUpdateCount];
        assert.equal(reopened?.subagent.status, "running");
        assert.equal(DateTime.toEpochMillis(reopened!.subagent.startedAt!), 1782622470000);
        assert.isNull(reopened!.subagent.completedAt);
        assert.isTrue(yield* harness.hasPendingBackgroundWork);

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(() => {
          const updates = harness.subagentUpdates();
          const latest = updates[updates.length - 1];
          return (
            latest !== undefined &&
            latest.subagent.status === "completed" &&
            latest.subagent.result === "CODEX_RESUME_DONE"
          );
        }, "resumed subagent completion");
        assert.isFalse(yield* harness.hasPendingBackgroundWork);
        assert.lengthOf(harness.terminalEvents(), 1);
        // The first child turn finished inside the root turn; only the resume wakes it.
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "CODEX_RESUME_DONE");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect("rejects duplicate child starts across parent runs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const firstDone = yield* Deferred.make<void>();
        const resumed = yield* Deferred.make<void>();
        const secondTurn = "native-parent-resume-turn";
        const secondPrompt = "Resume the child.";
        const entries = [...resumeSubagentTranscript.entries];
        const resumeIndex = entries.findIndex(
          (e) => e.type === "emit_inbound" && e.label === `turn/started/${RESUME_CHILD_TURN_2}`,
        );
        const suffix = entries.splice(resumeIndex);
        for (const entry of codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: secondTurn,
          prompt: secondPrompt,
        }).slice(-3)) {
          entries.push(
            entry.type === "expect_outbound" || entry.type === "emit_inbound"
              ? {
                  ...entry,
                  frame:
                    Predicate.isObject(entry.frame) && "id" in entry.frame
                      ? { ...entry.frame, id: 4 }
                      : entry.frame,
                }
              : entry,
          );
        }
        entries.push(childTurnStarted(RESUME_CHILD_TURN_1));
        entries.push(...suffix);
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "codex-cross-run-resume",
            entries,
          }),
          (event) =>
            event.type === "turn.terminal"
              ? Deferred.succeed(firstDone, undefined)
              : event.type === "subagent.updated" && event.subagent.runId === "run-cross-run-second"
                ? Deferred.succeed(resumed, undefined)
                : Effect.void,
        );
        const now = yield* DateTime.now;
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("cross-run-first"),
            text: RESUME_PROMPT,
          }),
        );
        yield* TestClock.adjust("100 millis");
        yield* Deferred.await(firstDone);
        yield* harness.runtime.startTurn({
          ...makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("cross-run-second"),
            text: secondPrompt,
          }),
          runOrdinal: 2,
          providerTurnOrdinal: 2,
        });
        yield* TestClock.adjust("30 seconds");
        yield* Deferred.await(resumed);
        const row = harness
          .subagentUpdates()
          .find((e) => e.subagent.runId === "run-cross-run-second")?.subagent;
        assert.equal(row?.status, "running");
        assert.equal(row?.parentNodeId, "node-cross-run-second");
        assert.isNull(row?.completedAt);
        assert.isNotNull(row?.startedAt);
        assert.equal(DateTime.toEpochMillis(row!.startedAt!), 1782622470000);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect.each([
    ["pendingInit", "pending"],
    ["running", "running"],
    ["interrupted", "interrupted"],
    ["shutdown", "cancelled"],
    ["notFound", "failed"],
    ["errored", "failed"],
    ["completed", "completed"],
    ["activity-completed", "completed"],
    ["late-activity-completed", "completed"],
    ["stale-running", "completed"],
    ["duplicate-completed", "completed"],
  ] as const)(
    "normalizes subagent %s without losing its lifecycle",
    ([nativeStatus, expectedStatus]) =>
      Effect.scoped(
        Effect.gen(function* () {
          const marker = yield* Deferred.make<void>();
          const firstCompletion = yield* Deferred.make<void>();
          const stateEntry = (
            status: string,
            id: string,
          ): Extract<CodexReplay.CodexAppServerReplayEntry, { type: "emit_inbound" }> => ({
            type: "emit_inbound",
            label: id,
            frame: {
              method: "item/completed",
              params: {
                threadId: RESUME_NATIVE_THREAD,
                turnId: RESUME_NATIVE_TURN,
                item: {
                  type: "collabAgentToolCall",
                  id,
                  tool: "listAgents",
                  status: "completed",
                  senderThreadId: RESUME_NATIVE_THREAD,
                  receiverThreadIds: [RESUME_CHILD_THREAD],
                  agentsStates: { [RESUME_CHILD_THREAD]: { status, message: null } },
                },
              },
            },
          });
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...codexReplayPreamble({
              nativeThreadId: RESUME_NATIVE_THREAD,
              nativeTurnId: RESUME_NATIVE_TURN,
              prompt: RESUME_PROMPT,
            }),
            resumeSubagentTranscript.entries.find(
              (e) =>
                e.type === "emit_inbound" && e.label === "item/completed/subAgentActivity-started",
            )!,
          ];
          if (nativeStatus === "late-activity-completed") {
            entries.push(
              resumeSubagentTranscript.entries.find(
                (e) => e.type === "emit_inbound" && e.label === "turn/completed/root",
              )!,
            );
          }
          if (nativeStatus === "activity-completed" || nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "activity-done",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "subAgentActivity",
                    id: "activity-done",
                    kind: "completed",
                    agentThreadId: RESUME_CHILD_THREAD,
                    agentPath: "/root/resume_agent",
                  },
                },
              },
            });
          } else if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            entries.push(stateEntry("completed", "child-completed"), {
              ...stateEntry(
                nativeStatus === "stale-running" ? "running" : "completed",
                "trailing-snapshot",
              ),
              afterMs: 100,
            });
          } else {
            entries.push(stateEntry(nativeStatus, "status-update"));
          }
          // A known child's turn provides a receipt even after the parent context is released.
          if (nativeStatus === "late-activity-completed") {
            entries.push({
              type: "emit_inbound",
              label: "late-marker",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_CHILD_THREAD,
                  turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "inProgress" }),
                },
              },
            });
          } else {
            entries.push({
              type: "emit_inbound",
              label: "marker",
              frame: {
                method: "item/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turnId: RESUME_NATIVE_TURN,
                  item: {
                    type: "agentMessage",
                    id: "marker",
                    text: "LIFECYCLE_MARKER",
                    phase: "final_answer",
                    memoryCitation: null,
                  },
                },
              },
            });
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: `subagent-${nativeStatus}`, entries }),
            (event) =>
              (event.type === "message.updated" && event.message.text === "LIFECYCLE_MARKER") ||
              (nativeStatus === "late-activity-completed" &&
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === RESUME_CHILD_TURN_1)
                ? Deferred.succeed(marker, undefined)
                : event.type === "subagent.updated" && event.subagent.status === "completed"
                  ? Deferred.succeed(firstCompletion, undefined)
                  : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make(`subagent-${nativeStatus}`),
              text: RESUME_PROMPT,
            }),
          );
          if (nativeStatus === "stale-running" || nativeStatus === "duplicate-completed") {
            yield* Deferred.await(firstCompletion);
            yield* TestClock.adjust("100 millis");
          }
          yield* Deferred.await(marker);
          const latest = harness.subagentUpdates().at(-1)!.subagent;
          assert.equal(latest.status, expectedStatus);
          if (nativeStatus === "duplicate-completed") {
            const first = harness.subagentUpdates().find((e) => e.subagent.status === "completed")!;
            assert.equal(
              DateTime.toEpochMillis(latest.completedAt!),
              DateTime.toEpochMillis(first.subagent.completedAt!),
            );
          }
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );

  const codexReplayThreadResult = (input: {
    readonly nativeThreadId: string;
    readonly forkedFromId: string | null;
  }) => ({
    thread: {
      id: input.nativeThreadId,
      sessionId: input.nativeThreadId,
      forkedFromId: input.forkedFromId,
      preview: "",
      ephemeral: false,
      modelProvider: "openai",
      createdAt: 1782622440,
      updatedAt: 1782622440,
      status: { type: "idle" },
      path: `/tmp/${input.nativeThreadId}.jsonl`,
      cwd: "/workspace",
      cliVersion: "0.144.0",
      source: "vscode",
      threadSource: null,
      agentNickname: null,
      agentRole: null,
      gitInfo: null,
      name: null,
      turns: [],
    },
    model: "gpt-5.4",
    modelProvider: "openai",
    serviceTier: null,
    cwd: "/workspace",
    instructionSources: [],
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false },
    reasoningEffort: "medium",
  });

  const errorCauseChainText = (error: unknown): string =>
    error instanceof Error ? `${error.message} ${errorCauseChainText(error.cause)}` : String(error);

  const codexReplaySourceTurn = (input: {
    readonly id: string;
    readonly ordinal: number;
    readonly nativeId: string | null;
    readonly providerThreadId: ProviderThreadId;
    readonly now: DateTime.Utc;
  }): OrchestrationV2ProviderTurn => ({
    id: ProviderTurnId.make(input.id),
    providerThreadId: input.providerThreadId,
    nodeId: NodeId.make(`node-${input.id}`),
    runAttemptId: RunAttemptId.make(`run-attempt-${input.id}`),
    nativeTurnRef:
      input.nativeId === null
        ? { driver: CodexAdapterV2.CODEX_DRIVER_KIND, nativeId: null, strength: "none" }
        : {
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeId: input.nativeId,
            strength: "strong",
          },
    ordinal: input.ordinal,
    status: "completed",
    startedAt: input.now,
    completedAt: input.now,
  });

  it.effect("wakes the parent when a native child finishes after the parent's turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entries = resumeSubagentTranscript.entries;
        const labelIndex = (label: string) =>
          entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
        const rootCompleted = labelIndex("turn/completed/root");
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
              ...entries.slice(rootCompleted - 1, rootCompleted + 1),
              childAgentMessage({
                id: "child-late-answer",
                text: "NATIVE_CHILD_16900_DONE",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
                afterMs: 60_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "completed");
        assert.lengthOf(harness.continuationRequests, 0);

        yield* TestClock.adjust("60 seconds");
        yield* harness.until(
          () => harness.subagentUpdates().at(-1)?.subagent.result === "NATIVE_CHILD_16900_DONE",
        );
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "completed");
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "NATIVE_CHILD_16900_DONE");
        assert.equal(harness.continuationRequests[0]?.delivery, "message_text");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  const lateChildPrefix = () => {
    const entries = resumeSubagentTranscript.entries;
    const labelIndex = (label: string) =>
      entries.findIndex((entry) => entry.type === "emit_inbound" && entry.label === label);
    const rootCompleted = labelIndex("turn/completed/root");
    return {
      spawned: entries.slice(0, labelIndex(`turn/started/${RESUME_CHILD_TURN_1}`) + 1),
      rootFinished: entries.slice(rootCompleted - 1, rootCompleted + 1),
    };
  };

  it.effect.each(["completed", "failed", "interrupted", "starting", "replied-last"] as const)(
    "handles a late native child after the capacity retry %s",
    (parentStatus) =>
      Effect.scoped(
        Effect.gen(function* () {
          const retriedTurnId = "native-capacity-recovered-parent";
          const retrying = yield* Deferred.make<void>();
          const entries: Array<CodexReplay.CodexAppServerReplayEntry> = [
            ...lateChildPrefix().spawned,
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turn: {
                    ...makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "failed" }),
                    error: {
                      message: "Selected model is at capacity.",
                      codexErrorInfo: "serverOverloaded",
                    },
                  },
                },
              },
            },
            {
              type: "expect_outbound",
              frame: {
                id: 4,
                method: "turn/start",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  input: [],
                  cwd: "/workspace",
                  model: "gpt-5.4",
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandboxPolicy: { type: "dangerFullAccess" },
                  summary: "detailed",
                  collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                },
              },
            },
            ...(parentStatus === "starting" ? [childTurnCompleted(RESUME_CHILD_TURN_1)] : []),
            {
              type: "emit_inbound",
              frame: {
                id: 4,
                result: {
                  turn: makeCodexReplayTurn({ id: retriedTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/started",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turn: makeCodexReplayTurn({ id: retriedTurnId, status: "inProgress" }),
                },
              },
            },
            {
              type: "emit_inbound",
              frame: {
                method: "turn/completed",
                params: {
                  threadId: RESUME_NATIVE_THREAD,
                  turn: {
                    ...makeCodexReplayTurn({
                      id: retriedTurnId,
                      status:
                        parentStatus === "starting" || parentStatus === "replied-last"
                          ? "completed"
                          : parentStatus,
                    }),
                    error:
                      parentStatus === "failed"
                        ? { message: "Recovery failed.", codexErrorInfo: "internalServerError" }
                        : null,
                  },
                },
              },
            },
            childAgentMessage({
              id: "child-after-capacity",
              text: "CAPACITY_CHILD_DONE",
              turnId: RESUME_CHILD_TURN_1,
              completedAtMs: 1782622480000,
              afterMs: 60_000,
            }),
            childTurnCompleted(RESUME_CHILD_TURN_1),
          ];
          if (parentStatus === "replied-last") {
            entries.push(...entries.splice(lateChildPrefix().spawned.length + 2, 1));
          }
          const harness = yield* makeCodexReplayHarness(
            makeCodexReplayTranscript({ scenario: "capacity-late-child", entries }),
            (event) =>
              event.type === "turn_item.updated" &&
              event.turnItem.type === "error" &&
              event.turnItem.status === "running"
                ? Deferred.succeed(retrying, undefined)
                : Effect.void,
          );
          yield* harness.runtime.startTurn(
            makeCodexTestTurnInput({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              now: yield* DateTime.now,
              attemptId: RunAttemptId.make("capacity-late-child"),
              text: RESUME_PROMPT,
            }),
          );
          yield* Deferred.await(retrying);
          yield* TestClock.adjust("2 seconds");
          if (parentStatus === "interrupted") assert.isEmpty(harness.terminalEvents());
          else {
            yield* harness.awaitTerminal(1);
            const terminal = harness.terminalEvents()[0];
            if (terminal?.status === "failed") assert.isTrue(terminal.childTurnsContinue);
          }
          yield* TestClock.adjust("60 seconds");
          yield* harness.until(
            () => harness.subagentUpdates().at(-1)?.subagent.status === "completed",
          );
          yield* harness.awaitTerminal(1);
          assert.lengthOf(
            harness.continuationRequests,
            parentStatus === "completed" || parentStatus === "replied-last" ? 1 : 0,
          );
          if (parentStatus === "completed" || parentStatus === "replied-last")
            assert.include(harness.continuationRequests[0]?.detail, "CAPACITY_CHILD_DONE");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              McpProviderSessions.layer,
              NodeServices.layer,
              NodeCrypto.layer,
            ),
          ),
        ),
      ),
  );

  it.effect("stops native children when capacity retry startup fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const retrying = yield* Deferred.make<void>();
        const starting = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const interrupts: unknown[] = [];
        let starts = 0;
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "capacity-start-fails-stop-child",
            entries: [
              ...lateChildPrefix().spawned,
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: RESUME_NATIVE_THREAD,
                    turn: {
                      ...makeCodexReplayTurn({ id: RESUME_NATIVE_TURN, status: "failed" }),
                      error: { message: "At capacity", codexErrorInfo: "serverOverloaded" },
                    },
                  },
                },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "turn/start",
                  params: {
                    threadId: RESUME_NATIVE_THREAD,
                    input: [],
                    cwd: "/workspace",
                    model: "gpt-5.4",
                    approvalPolicy: "never",
                    approvalsReviewer: "user",
                    sandboxPolicy: { type: "dangerFullAccess" },
                    summary: "detailed",
                    collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                  },
                },
              },
              {
                type: "emit_inbound",
                frame: { id: 4, error: { code: -32603, message: "Start failed" } },
              },
              {
                type: "expect_outbound",
                frame: {
                  id: 5,
                  method: "turn/interrupt",
                  params: { threadId: RESUME_CHILD_THREAD, turnId: RESUME_CHILD_TURN_1 },
                },
              },
              { type: "emit_inbound", frame: { id: 5, result: {} } },
              {
                type: "emit_inbound",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: RESUME_CHILD_THREAD,
                    turn: makeCodexReplayTurn({ id: RESUME_CHILD_TURN_1, status: "interrupted" }),
                  },
                },
              },
            ],
          }),
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "running"
              ? Deferred.succeed(retrying, undefined)
              : Effect.void,
          (method, params) =>
            Effect.gen(function* () {
              if (method === "turn/interrupt") interrupts.push(params);
              if (method === "turn/start" && ++starts === 2) {
                yield* Deferred.succeed(starting, undefined);
                yield* Deferred.await(release);
              }
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("capacity-start-fails-stop-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* Deferred.await(retrying);
        const root = harness.events.find((event) => event.type === "provider_turn.updated");
        assert.equal(root?.type, "provider_turn.updated");
        if (root?.type !== "provider_turn.updated") return;
        yield* TestClock.adjust("2 seconds");
        yield* Deferred.await(starting);
        const stopping = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: root.providerTurn.id,
          })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(stopping);
        assert.lengthOf(interrupts, 1);
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.status, "interrupted");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect("names a late child spawned without a prompt in its wake", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { spawned, rootFinished } = lateChildPrefix();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...spawned.map((entry) =>
                entry.type === "emit_inbound" &&
                entry.label === "item/completed/subAgentActivity-started"
                  ? {
                      ...entry,
                      frame: {
                        method: "item/completed",
                        params: {
                          item: {
                            type: "collabAgentToolCall",
                            id: "call-codex-resume-spawn",
                            tool: "spawnAgent",
                            status: "completed",
                            senderThreadId: RESUME_NATIVE_THREAD,
                            receiverThreadIds: [RESUME_CHILD_THREAD],
                            agentsStates: {},
                          },
                          threadId: RESUME_NATIVE_THREAD,
                          turnId: RESUME_NATIVE_TURN,
                          completedAtMs: 1782622441000,
                        },
                      },
                    }
                  : entry,
              ),
              ...rootFinished,
              childAgentMessage({
                id: "child-late-answer",
                text: "UNPROMPTED_CHILD_DONE",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
                afterMs: 60_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-unprompted-child"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);
        yield* TestClock.adjust("60 seconds");
        yield* harness.until(() => harness.continuationRequests.length > 0);
        const subagent = harness.subagentUpdates().at(-1)?.subagent;
        assert.equal(subagent?.prompt, "");
        assert.equal(
          harness.continuationRequests[0]?.detail,
          `Subagent completed: ${subagent?.id}\n\nResult:\nUNPROMPTED_CHILD_DONE`,
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    ),
  );

  it.effect("wakes the root only when its direct child finishes, not a grandchild", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const grandchildThread = "native-codex-resume-grandchild-thread";
        const grandchildTurn = "native-codex-resume-grandchild-turn";
        const { spawned, rootFinished } = lateChildPrefix();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...spawned,
              {
                type: "emit_inbound",
                label: "item/completed/grandchild-spawn",
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "subAgentActivity",
                      id: "call-codex-grandchild-spawn",
                      kind: "started",
                      agentThreadId: grandchildThread,
                      agentPath: "/root/resume_agent/grandchild",
                    },
                    threadId: RESUME_CHILD_THREAD,
                    turnId: RESUME_CHILD_TURN_1,
                    completedAtMs: 1782622441500,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/started/grandchild",
                frame: {
                  method: "turn/started",
                  params: {
                    threadId: grandchildThread,
                    turn: makeCodexReplayTurn({ id: grandchildTurn, status: "inProgress" }),
                  },
                },
              },
              ...rootFinished,
              {
                type: "emit_inbound",
                label: "item/completed/grandchild-answer",
                afterMs: 30_000,
                frame: {
                  method: "item/completed",
                  params: {
                    item: {
                      type: "agentMessage",
                      id: "grandchild-answer",
                      text: "GRANDCHILD_DONE",
                      phase: "final_answer",
                      memoryCitation: null,
                    },
                    threadId: grandchildThread,
                    turnId: grandchildTurn,
                    completedAtMs: 1782622470000,
                  },
                },
              },
              {
                type: "emit_inbound",
                label: "turn/completed/grandchild",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: grandchildThread,
                    turn: makeCodexReplayTurn({ id: grandchildTurn, status: "completed" }),
                  },
                },
              },
              childAgentMessage({
                id: "child-late-answer",
                text: "CHILD_AFTER_GRANDCHILD",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622500000,
                afterMs: 30_000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
            ],
          }),
        );

        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("attempt-codex-late-grandchild"),
            text: RESUME_PROMPT,
          }),
        );
        yield* harness.awaitTerminal(1);

        yield* TestClock.adjust("30 seconds");
        yield* harness.until(() =>
          harness.subagentUpdates().some((event) => event.subagent.result === "GRANDCHILD_DONE"),
        );
        assert.lengthOf(harness.continuationRequests, 0);

        yield* TestClock.adjust("30 seconds");
        yield* harness.until(() => harness.continuationRequests.length > 0);
        assert.lengthOf(harness.continuationRequests, 1);
        assert.include(harness.continuationRequests[0]?.detail, "CHILD_AFTER_GRANDCHILD");
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("leaves a late child's result to the root's next turn when one is running", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secondPrompt = "Wait for the sub-agent.";
        const secondTurn = "native-codex-resume-root-turn-2";
        const { spawned, rootFinished } = lateChildPrefix();
        // Reuse the preamble's turn/start exchange under the session's next request id.
        const secondTurnStart = codexReplayPreamble({
          nativeThreadId: RESUME_NATIVE_THREAD,
          nativeTurnId: secondTurn,
          prompt: secondPrompt,
        })
          .slice(-3)
          .map((entry) =>
            entry.type !== "runtime_exit" &&
            typeof entry.frame === "object" &&
            entry.frame !== null &&
            "id" in entry.frame
              ? { ...entry, frame: { ...entry.frame, id: 4 } }
              : entry,
          );
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: RESUME_SCENARIO,
            entries: [
              ...spawned,
              ...rootFinished,
              ...secondTurnStart,
              childAgentMessage({
                id: "child-late-answer",
                text: "CHILD_DURING_SECOND_TURN",
                turnId: RESUME_CHILD_TURN_1,
                completedAtMs: 1782622480000,
              }),
              childTurnCompleted(RESUME_CHILD_TURN_1),
              {
                type: "emit_inbound",
                label: "turn/completed/root-2",
                frame: {
                  method: "turn/completed",
                  params: {
                    threadId: RESUME_NATIVE_THREAD,
                    turn: makeCodexReplayTurn({ id: secondTurn, status: "completed" }),
                  },
                },
              },
            ],
          }),
        );

        const turnInput = (index: number, text: string) =>
          Effect.gen(function* () {
            return {
              ...makeCodexTestTurnInput({
                threadId: harness.threadId,
                providerThread: harness.providerThread,
                now: yield* DateTime.now,
                attemptId: RunAttemptId.make(`attempt-codex-active-root-${index}`),
                text,
              }),
              runOrdinal: index,
              providerTurnOrdinal: index,
            };
          });
        yield* harness.runtime.startTurn(yield* turnInput(1, RESUME_PROMPT));
        yield* harness.awaitTerminal(1);
        yield* harness.runtime.startTurn(yield* turnInput(2, secondPrompt));
        yield* harness.awaitTerminal(2);
        assert.equal(harness.subagentUpdates().at(-1)?.subagent.result, "CHILD_DURING_SECOND_TURN");
        assert.lengthOf(harness.continuationRequests, 0);
      }).pipe(
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    ),
  );

  it.effect("fails honestly when rolling back a legacy Codex thread", () =>
    Effect.gen(function* () {
      const nativeThreadId = "legacy-rollback-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "legacy-rollback-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-legacy-rollback",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/read",
            frame: {
              id: 3,
              method: "thread/read",
              params: { threadId: nativeThreadId, includeTurns: false },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/read",
            frame: {
              id: 3,
              result: { thread: { id: nativeThreadId, historyMode: "legacy" } },
            },
          },
        ],
      });
      const outbound: Array<string> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method) =>
          Effect.sync(() => {
            outbound.push(method);
          }),
      );
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.rollbackThread({
          providerThread: harness.providerThread,
          target: {
            type: "provider_turn",
            checkpointId: CheckpointId.make("checkpoint-legacy-rollback"),
            appRunOrdinal: 1,
            providerTurn: firstTurn,
          },
          providerThreadTurns: [firstTurn, secondTurn],
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterRollbackThreadError);
      assert.include(
        errorCauseChainText(error),
        "legacy",
        "legacy rollback must surface an honest unsupported-history failure",
      );
      assert.notInclude(
        outbound,
        "thread/rollback",
        "thread/rollback must not be sent to a legacy Codex thread",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("unarchives an unloaded Codex thread before rolling it back", () =>
    Effect.gen(function* () {
      const nativeThreadId = "archived-rollback-thread";
      const resumeParams = {
        threadId: nativeThreadId,
        excludeTurns: true,
        cwd: CODEX_TEST_RUNTIME_POLICY.cwd,
        model: CODEX_TEST_MODEL_SELECTION.model,
        config: CodexAdapterV2.CODEX_THREAD_CONFIG,
      };
      const thread = codexReplayThreadResult({ nativeThreadId, forkedFromId: null });
      const exchange = (
        id: number,
        method: string,
        params: unknown,
        reply: { readonly result: unknown } | { readonly error: unknown },
      ): Array<CodexReplay.CodexAppServerReplayEntry> => [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, ...reply } },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-archived-rollback",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "archived-rollback-turn",
            prompt: "unused",
          }).slice(0, 5),
          ...exchange(
            3,
            "thread/read",
            { threadId: nativeThreadId, includeTurns: false },
            {
              result: {
                thread: {
                  id: nativeThreadId,
                  historyMode: "paginated",
                  status: { type: "notLoaded" },
                },
              },
            },
          ),
          ...exchange(4, "thread/resume", resumeParams, {
            error: { code: -32600, message: `session ${nativeThreadId} is archived` },
          }),
          ...exchange(5, "thread/unarchive", { threadId: nativeThreadId }, { result: thread }),
          ...exchange(6, "thread/resume", resumeParams, { result: thread }),
          ...exchange(
            7,
            "thread/turns/list",
            {
              threadId: nativeThreadId,
              cursor: null,
              limit: 1,
              sortDirection: "desc",
              itemsView: "summary",
            },
            {
              result: {
                data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                nextCursor: null,
              },
            },
          ),
          ...exchange(
            8,
            "thread/revert",
            { threadId: nativeThreadId, beforeTurnId: "native-turn-second" },
            { result: thread },
          ),
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });
      const secondTurn = codexReplaySourceTurn({
        id: "provider-turn-second",
        ordinal: 2,
        nativeId: "native-turn-second",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const snapshot = yield* harness.runtime.rollbackThread({
        providerThread: harness.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-archived-rollback"),
          appRunOrdinal: 1,
          providerTurn: firstTurn,
        },
        providerThreadTurns: [firstTurn, secondTurn],
      });

      assert.equal(snapshot.providerThread.nativeThreadRef?.nativeId, nativeThreadId);
      assert.deepEqual(snapshot.providerThread.nativeConversationHeadRef, firstTurn.nativeTurnRef);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  it.effect("a rollback retried after a later step failed keeps every turn up to the target", () =>
    Effect.gen(function* () {
      const nativeThreadId = "retried-rollback-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "retried-rollback-turn",
        prompt: "unused",
      });
      const paginatedHistory = (id: number): Array<CodexReplay.CodexAppServerReplayEntry> => [
        {
          type: "expect_outbound",
          label: "thread/read",
          frame: {
            id,
            method: "thread/read",
            params: { threadId: nativeThreadId, includeTurns: false },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/read",
          frame: { id, result: { thread: { id: nativeThreadId, historyMode: "paginated" } } },
        },
      ];
      const newestTurns = (
        id: number,
        turns: ReadonlyArray<string>,
        nextCursor: string | null,
      ): Array<CodexReplay.CodexAppServerReplayEntry> => [
        {
          type: "expect_outbound",
          label: "thread/turns/list",
          frame: {
            id,
            method: "thread/turns/list",
            params: {
              threadId: nativeThreadId,
              cursor: null,
              limit: 3,
              sortDirection: "desc",
              itemsView: "summary",
            },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/turns/list",
          frame: {
            id,
            result: {
              data: turns.map((turnId) => ({
                id: turnId,
                items: [],
                status: "completed",
                error: null,
              })),
              nextCursor,
            },
          },
        },
      ];
      const threadResult = codexReplayThreadResult({ nativeThreadId, forkedFromId: null });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-retried-rollback",
        entries: [
          ...preamble.slice(0, 5),
          // Attempt 1: Codex holds [n1, n2a, n2b, n3]; rolling back to n1 drops n2a and later.
          ...paginatedHistory(3),
          ...newestTurns(4, ["n3", "n2b", "n2a"], "older"),
          {
            type: "expect_outbound",
            label: "thread/revert",
            frame: {
              id: 5,
              method: "thread/revert",
              params: { threadId: nativeThreadId, beforeTurnId: "n2a" },
            },
          },
          { type: "emit_inbound", label: "thread/revert", frame: { id: 5, result: threadResult } },
          // Attempt 2, the effect worker's retry with the same input: Codex holds [n1], keeps it.
          ...paginatedHistory(6),
          ...newestTurns(7, ["n1"], null),
          {
            type: "expect_outbound",
            label: "thread/read",
            frame: {
              id: 8,
              method: "thread/read",
              params: { threadId: nativeThreadId, includeTurns: false },
            },
          },
          { type: "emit_inbound", label: "thread/read", frame: { id: 8, result: threadResult } },
        ],
      });
      const reverts: Array<unknown> = [];
      const harness = yield* makeCodexReplayHarness(
        transcript,
        () => Effect.void,
        (method, params) =>
          Effect.sync(() => {
            if (method === "thread/revert") reverts.push(params);
          }),
      );
      const now = yield* DateTime.now;
      const turns = ["n1", "n2a", "n2b", "n3"].map((nativeId, index) =>
        codexReplaySourceTurn({
          id: `provider-turn-${nativeId}`,
          ordinal: index + 1,
          nativeId,
          providerThreadId: harness.providerThread.id,
          now,
        }),
      );
      // No run is marked rolled back until the whole rollback lands: the retry gets the same input.
      const input: ProviderAdapter.ProviderAdapterV2RollbackThreadInput = {
        providerThread: harness.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-retried-rollback"),
          appRunOrdinal: 1,
          providerTurn: turns[0]!,
        },
        providerThreadTurns: turns,
      };

      yield* harness.runtime.rollbackThread(input);
      const retry = yield* Effect.exit(harness.runtime.rollbackThread(input));

      assert.deepEqual(reverts, [{ threadId: nativeThreadId, beforeTurnId: "n2a" }]);
      assert.isTrue(Exit.isSuccess(retry));
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect(
    "falls back to fork-local thread/revert on paginated history when the source turn lacks a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "fallback-source-thread";
        const forkThreadId = "fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-paginated-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "paginated" } },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                method: "thread/turns/list",
                params: {
                  threadId: forkThreadId,
                  cursor: null,
                  limit: 1,
                  sortDirection: "desc",
                  itemsView: "summary",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/turns/list",
              frame: {
                id: 5,
                result: {
                  data: [{ id: "native-turn-second", items: [], status: "completed", error: null }],
                  nextCursor: null,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/revert",
              frame: {
                id: 6,
                method: "thread/revert",
                params: { threadId: forkThreadId, beforeTurnId: "native-turn-second" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/revert",
              frame: {
                id: 6,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: null,
                }),
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              outbound.push(method);
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const forkedProviderThread = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn, secondTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-paginated-fallback-target"),
        });

        assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
        assert.notEqual(forkedProviderThread.id, harness.providerThread.id);
        assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
        assert.deepEqual(outbound.slice(-2), ["thread/turns/list", "thread/revert"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  it.effect(
    "fails honestly when a legacy fork cannot honor a source turn without a native reference",
    () =>
      Effect.gen(function* () {
        const nativeThreadId = "legacy-fallback-source-thread";
        const forkThreadId = "legacy-fallback-fork-thread";
        const preamble = codexReplayPreamble({
          nativeThreadId,
          nativeTurnId: "legacy-fallback-source-turn",
          prompt: "unused",
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "codex-fork-legacy-fallback",
          entries: [
            ...preamble.slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: nativeThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: nativeThreadId,
                }),
              },
            },
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 4,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 4,
                result: { thread: { id: forkThreadId, historyMode: "legacy" } },
              },
            },
          ],
        });
        const outbound: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              outbound.push(method);
            }),
        );
        const now = yield* DateTime.now;
        const firstTurn = codexReplaySourceTurn({
          id: "provider-turn-first",
          ordinal: 1,
          nativeId: null,
          providerThreadId: harness.providerThread.id,
          now,
        });
        const secondTurn = codexReplaySourceTurn({
          id: "provider-turn-second",
          ordinal: 2,
          nativeId: "native-turn-second",
          providerThreadId: harness.providerThread.id,
          now,
        });

        const error = yield* Effect.flip(
          harness.runtime.forkThread({
            sourceProviderThread: harness.providerThread,
            sourceProviderTurns: [firstTurn, secondTurn],
            providerTurnId: firstTurn.id,
            targetThreadId: ThreadId.make("thread-fork-legacy-fallback-target"),
          }),
        );

        assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
        assert.include(
          errorCauseChainText(error),
          "legacy",
          "the missing-native-reference fallback must name the legacy limitation",
        );
        assert.notInclude(
          outbound,
          "thread/rollback",
          "thread/rollback must not be sent to a legacy Codex fork",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
  );

  it.effect("propagates native thread/fork failures as typed fork errors", () =>
    Effect.gen(function* () {
      const nativeThreadId = "fork-failure-source-thread";
      const preamble = codexReplayPreamble({
        nativeThreadId,
        nativeTurnId: "fork-failure-source-turn",
        prompt: "unused",
      });
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-fork-request-failure",
        entries: [
          ...preamble.slice(0, 5),
          {
            type: "expect_outbound",
            label: "thread/fork",
            frame: {
              id: 3,
              method: "thread/fork",
              params: {
                threadId: nativeThreadId,
                lastTurnId: "native-turn-first",
                config: CodexAdapterV2.CODEX_THREAD_CONFIG,
              },
            },
          },
          {
            type: "emit_inbound",
            label: "thread/fork",
            frame: { id: 3, error: { code: -32000, message: "fork exploded" } },
          },
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const error = yield* Effect.flip(
        harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          sourceProviderTurns: [firstTurn],
          providerTurnId: firstTurn.id,
          targetThreadId: ThreadId.make("thread-fork-failure-target"),
        }),
      );

      assert.instanceOf(error, ProviderAdapter.ProviderAdapterForkThreadError);
      assert.include(errorCauseChainText(error), "fork exploded");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
      ),
    ),
  );

  it.effect("unarchives an archived Codex source thread before forking it", () =>
    Effect.gen(function* () {
      const nativeThreadId = "archived-fork-source";
      const forkThreadId = "archived-fork-target";
      const forkParams = {
        threadId: nativeThreadId,
        lastTurnId: "native-turn-first",
        config: CodexAdapterV2.CODEX_THREAD_CONFIG,
      };
      const exchange = (
        id: number,
        method: string,
        params: unknown,
        reply: { readonly result: unknown } | { readonly error: unknown },
      ): Array<CodexReplay.CodexAppServerReplayEntry> => [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, ...reply } },
      ];
      const transcript = makeCodexReplayTranscript({
        scenario: "codex-archived-fork",
        entries: [
          ...codexReplayPreamble({
            nativeThreadId,
            nativeTurnId: "archived-fork-turn",
            prompt: "unused",
          }).slice(0, 5),
          ...exchange(3, "thread/fork", forkParams, {
            error: {
              code: -32600,
              message: `session ${nativeThreadId} is archived. Run \`codex unarchive ${nativeThreadId}\` to unarchive it first.`,
            },
          }),
          ...exchange(
            4,
            "thread/unarchive",
            { threadId: nativeThreadId },
            { result: codexReplayThreadResult({ nativeThreadId, forkedFromId: null }) },
          ),
          ...exchange(5, "thread/fork", forkParams, {
            result: codexReplayThreadResult({
              nativeThreadId: forkThreadId,
              forkedFromId: nativeThreadId,
            }),
          }),
        ],
      });
      const harness = yield* makeCodexReplayHarness(transcript);
      const now = yield* DateTime.now;
      const firstTurn = codexReplaySourceTurn({
        id: "provider-turn-first",
        ordinal: 1,
        nativeId: "native-turn-first",
        providerThreadId: harness.providerThread.id,
        now,
      });

      const forkedProviderThread = yield* harness.runtime.forkThread({
        sourceProviderThread: harness.providerThread,
        sourceProviderTurns: [firstTurn],
        providerTurnId: firstTurn.id,
        targetThreadId: ThreadId.make("thread-archived-fork-target"),
      });

      assert.equal(forkedProviderThread.nativeThreadRef?.nativeId, forkThreadId);
      assert.equal(forkedProviderThread.forkedFrom?.providerTurnId, firstTurn.id);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          McpProviderSessions.layer,
          NodeServices.layer,
          NodeCrypto.layer,
        ),
      ),
    ),
  );

  describe("native goals", () => {
    const nativeThreadId = "goal-thread";
    const objective = "Ship the feature";
    const codexGoal = (status: string, tokensUsed: number) => ({
      threadId: nativeThreadId,
      objective,
      status,
      tokenBudget: null,
      tokensUsed,
      timeUsedSeconds: 3,
      createdAt: 1782622440,
      updatedAt: 1782622450,
    });
    const notification = (
      label: string,
      method: string,
      params: unknown,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label,
      frame: { method, params },
    });
    const request = (id: number, method: string, params: unknown, result: unknown) =>
      [
        { type: "expect_outbound", label: method, frame: { id, method, params } },
        { type: "emit_inbound", label: method, frame: { id, result } },
      ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;
    const withReplayRequestId = (
      entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
      id: number,
    ) =>
      entries.map((entry) =>
        "frame" in entry && Predicate.isObject(entry.frame) && "id" in entry.frame
          ? { ...entry, frame: { ...entry.frame, id } }
          : entry,
      );
    const sessionStart = codexReplayPreamble({
      nativeThreadId,
      nativeTurnId: "unused",
      prompt: "unused",
    }).slice(0, 5);
    const goalTurnInput = (
      harness: {
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
      },
      text: string,
    ) =>
      DateTime.now.pipe(
        Effect.map((now) =>
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now,
            attemptId: RunAttemptId.make("goal-attempt"),
            text,
          }),
        ),
      );
    const providerGoals = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      events.flatMap((event) =>
        event.type === "provider_thread.updated" ? [event.providerThread.goal?.status ?? null] : [],
      );

    it("parses /goal like the Codex TUI", () => {
      const parse = (text: string) => parseGoalCommand({ text });
      assert.deepEqual(parse("/goal"), { type: "show" });
      assert.deepEqual(parse(" /goal Pause "), { type: "pause" });
      assert.deepEqual(parse("/goal resume"), { type: "resume" });
      assert.deepEqual(parse("/goal clear"), { type: "clear" });
      assert.deepEqual(parse("/goal fix the\nflaky tests"), {
        type: "set",
        objective: "fix the\nflaky tests",
      });
      assert.isNull(parse("/goals"));
      assert.isNull(parse("set a /goal"));
      // An attachment makes it an ordinary prompt.
      assert.isNull(parseGoalCommand({ text: "/goal clear", attachments: [{}] }));
    });

    it.effect("keeps a /goal run open across the turns Codex continues on its own", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective, status: "paused" },
              { goal: codexGoal("paused", 0) },
            ),
            // The first goal turn carries this run's turn configuration.
            ...withReplayRequestId(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-1",
                prompt: objective,
                sentPrompt: `Start working toward this goal: ${objective}`,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: codexGoal("active", 0) },
            ),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-1",
              goal: codexGoal("active", 0),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-1", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-2",
              goal: codexGoal("complete", 1200),
            }),
            notification("continuation done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${objective}`));
        yield* harness.firstTerminal;

        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const providerTurnId = (nativeTurnId: string) =>
          idAllocator.derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId,
          });
        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [[providerTurnId("goal-turn-2"), "completed"]],
        );
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.status === "running"
              ? [
                  [
                    event.providerTurn.id,
                    event.providerTurn.runAttemptId,
                    event.providerTurn.ordinal,
                  ],
                ]
              : [],
          ),
          [
            [providerTurnId("goal-turn-1"), RunAttemptId.make("goal-attempt"), 1],
            [providerTurnId("goal-turn-2"), RunAttemptId.make("goal-attempt"), 2],
          ],
        );
        // The goal is set paused until its first turn starts; only the result shows.
        assert.notInclude(providerGoals(harness.events), "paused");
        assert.equal(providerGoals(harness.events).at(-1), "complete");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("settles /goal pause through the goal row instead of a native turn", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-pause",
          entries: [
            ...sessionStart,
            ...request(
              3,
              "thread/goal/get",
              { threadId: nativeThreadId },
              { goal: codexGoal("active", 10) },
            ),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, "/goal pause"));
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
        const turns = harness.events.flatMap((event) =>
          event.type === "provider_turn.updated" ? [event.providerTurn] : [],
        );
        assert.isTrue(turns.every((turn) => turn.nativeTurnRef === null));
        // The goal row shows the pause; no reply echoes it.
        assert.deepEqual(
          harness.events.flatMap((event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? [event.message.text]
              : [],
          ),
          [],
        );
        assert.equal(providerGoals(harness.events).at(-1), "paused");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("rejects an oversized /goal objective before any goal request", () =>
      Effect.gen(function* () {
        const oversized = "x".repeat(4001);
        const requests: string[] = [];
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({ scenario: "goal-oversized", entries: sessionStart }),
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        const start = yield* harness.runtime
          .startTurn(yield* goalTurnInput(harness, `/goal ${oversized}`))
          .pipe(Effect.result);

        assert.deepEqual(
          requests.filter((method) => method.startsWith("thread/goal/") || method === "turn/start"),
          [],
        );
        assert.equal(start._tag, "Failure");
        if (start._tag === "Failure") {
          const { message } = makeProviderFailure({ cause: start.failure });
          assert.match(message, /4,?001/u);
          assert.match(message, /4,?000/u);
        }
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("sends a /goal objective at the 4000 character limit unchanged", () =>
      Effect.gen(function* () {
        const atLimit = "y".repeat(4000);
        const goal = (status: string) => ({ ...codexGoal(status, 0), objective: atLimit });
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-at-limit",
          entries: [
            ...sessionStart,
            ...request(3, "thread/goal/get", { threadId: nativeThreadId }, { goal: null }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, objective: atLimit, status: "paused" },
              { goal: goal("paused") },
            ),
            ...withReplayRequestId(
              codexReplayPreamble({
                nativeThreadId,
                nativeTurnId: "goal-turn-limit",
                prompt: atLimit,
                sentPrompt: `Start working toward this goal: ${atLimit}`,
              }).slice(5),
              5,
            ),
            ...request(
              6,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "active" },
              { goal: goal("active") },
            ),
            notification("goal complete", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-limit",
              goal: goal("complete"),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-limit", status: "completed" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(yield* goalTurnInput(harness, `/goal ${atLimit}`));
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("settles a run held for the next goal turn when Stop arrives in between", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-between-turns",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            // Notifications run in order, so seeing this one proves the turn settled.
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 10),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-hold-attempt"),
            text: prompt,
          }),
        );
        const providerTurnId = (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
          driver: CodexAdapterV2.CODEX_DRIVER_KIND,
          nativeTurnId: "goal-turn",
        });
        const turnStatuses = () =>
          harness.events.flatMap((event) =>
            event.type === "provider_turn.updated" && event.providerTurn.id === providerTurnId
              ? [event.providerTurn.status]
              : [],
          );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        // The held turn keeps reading as running, so Stop still reaches the adapter.
        assert.deepEqual(turnStatuses(), ["running"]);
        assert.lengthOf(harness.terminalEvents(), 0);

        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId,
        });
        yield* harness.firstTerminal;

        assert.notInclude(requests, "turn/interrupt");
        assert.deepEqual(turnStatuses(), ["running", "completed"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("moves a Stop that names an earlier goal turn to the turn Codex continued with", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-after-continuation",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              5,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-b" },
              {},
            ),
            notification("continuation interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-successor-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the continuation to be adopted",
        );
        // The projection may still name the first turn when Stop is dispatched.
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-a",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("stops a held goal run's background command when Stop arrives between turns", () =>
      Effect.gen(function* () {
        const prompt = "Start the server";
        const command = "node server.js";
        const commandItem = (status: "inProgress" | "completed") => ({
          type: "commandExecution",
          id: "goal-bg-command",
          command,
          cwd: "/workspace",
          processId: "4242",
          source: "unifiedExecStartup",
          status,
          commandActions: [{ type: "unknown", command }],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
        });
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-held-background",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("command started", "item/started", {
              item: commandItem("inProgress"),
              threadId: nativeThreadId,
              turnId: "goal-turn",
              startedAtMs: 1782622440500,
            }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              5,
              "thread/backgroundTerminals/terminate",
              { threadId: nativeThreadId, processId: "4242" },
              { terminated: true },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-held-background-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        // The settled-turn path terminates the process (the replay expects that
        // request) before it marks the command interrupted.
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "turn_item.updated" &&
                event.turnItem.type === "command_execution" &&
                event.turnItem.status === "interrupted",
            ),
          "the background command to be interrupted",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("moves Stop to a continuation Codex starts while the goal pause is in flight", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-races-continuation",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            {
              type: "expect_outbound",
              label: "thread/goal/set",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            {
              type: "emit_inbound",
              label: "thread/goal/set",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
            ...request(
              5,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-b" },
              {},
            ),
            notification("continuation interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-stop-race-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.status === "active",
            ),
          "the goal to be active",
        );
        // Stop names the first turn while it still runs.
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-a",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("stops a subagent an earlier goal turn left running when Stop settles the run", () =>
      Effect.gen(function* () {
        const prompt = "Delegate the audit";
        const childThreadId = "goal-child-thread";
        const childTurnId = "goal-child-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-held-subagent",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("subagent started", "item/completed", {
              item: {
                type: "subAgentActivity",
                id: "goal-subagent-call",
                kind: "started",
                agentThreadId: childThreadId,
                agentPath: "/root/audit",
              },
              threadId: nativeThreadId,
              turnId: "goal-turn",
              completedAtMs: 1782622441000,
            }),
            notification("child turn", "turn/started", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "inProgress" }),
            }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(5, "turn/interrupt", { threadId: childThreadId, turnId: childTurnId }, {}),
            notification("child interrupted", "turn/completed", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-held-subagent-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the completed turn to be held",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
          requestRuntimeRestart: true,
        });
        yield* harness.firstTerminal;
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === childTurnId &&
                event.providerTurn.status === "interrupted",
            ),
          "the subagent turn to be interrupted",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("stops an earlier goal turn's subagent when the run settles during the pause", () =>
      Effect.gen(function* () {
        const prompt = "Delegate the audit";
        const childThreadId = "goal-race-child-thread";
        const childTurnId = "goal-race-child-turn";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop-run-settles-during-pause",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn-a", prompt }),
            notification("subagent started", "item/completed", {
              item: {
                type: "subAgentActivity",
                id: "goal-race-subagent-call",
                kind: "started",
                agentThreadId: childThreadId,
                agentPath: "/root/audit",
              },
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              completedAtMs: 1782622441000,
            }),
            notification("child turn", "turn/started", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "inProgress" }),
            }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-a",
              goal: codexGoal("active", 10),
            }),
            notification("first turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-a", status: "completed" }),
            }),
            notification("continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "inProgress" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "thread/goal/set",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn-b",
              goal: codexGoal("paused", 11),
            }),
            notification("continuation done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-b", status: "completed" }),
            }),
            {
              type: "emit_inbound",
              label: "thread/goal/set",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
            ...request(5, "turn/interrupt", { threadId: childThreadId, turnId: childTurnId }, {}),
            notification("child interrupted", "turn/completed", {
              threadId: childThreadId,
              turn: makeCodexReplayTurn({ id: childTurnId, status: "interrupted" }),
            }),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-settles-during-pause-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_thread.updated" &&
                event.providerThread.goal?.tokensUsed === 11,
            ),
          "the continuation to be adopted",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn-b",
          }),
          requestRuntimeRestart: true,
        });
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) =>
                event.type === "provider_turn.updated" &&
                event.providerTurn.nativeTurnRef?.nativeId === childTurnId &&
                event.providerTurn.status === "interrupted",
            ),
          "the subagent turn to be interrupted",
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("pauses a goal Codex does not continue before its run settles", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation-expired",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-expired-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        assert.lengthOf(harness.terminalEvents(), 0);
        yield* TestClock.adjust("5 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(providerGoals(harness.events), ["active", "active", "paused"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("stops a turn Codex starts while the expiry pause is in flight", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-continuation-during-expiry",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "pause",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
            notification("goal paused", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("paused", 11),
            }),
            notification("late continuation", "turn/started", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn-2", status: "inProgress" }),
            }),
            ...request(
              5,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 11) },
            ),
            ...request(
              6,
              "turn/interrupt",
              { threadId: nativeThreadId, turnId: "goal-turn-2" },
              {},
            ),
            {
              type: "emit_inbound",
              label: "paused",
              frame: { id: 4, result: { goal: codexGoal("paused", 11) } },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-race-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        yield* TestClock.adjust("5 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => [event.providerTurnId, event.status]),
          [
            [
              (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
                driver: CodexAdapterV2.CODEX_DRIVER_KIND,
                nativeTurnId: "goal-turn",
              }),
              "completed",
            ],
          ],
        );
        assert.equal(providerGoals(harness.events).at(-1), "paused");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("settles the run when Codex never answers the expiry pause", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-expiry-pause-unanswered",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            notification("turn done", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "completed" }),
            }),
            notification("goal accounted", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: null,
              goal: codexGoal("active", 11),
            }),
            {
              type: "expect_outbound",
              label: "pause",
              frame: {
                id: 4,
                method: "thread/goal/set",
                params: { threadId: nativeThreadId, status: "paused" },
              },
            },
          ],
        });
        const harness = yield* makeCodexReplayHarness(transcript);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-unanswered-attempt"),
            text: prompt,
          }),
        );
        yield* harness.until(() =>
          harness.events.some(
            (event) =>
              event.type === "provider_thread.updated" &&
              event.providerThread.goal?.tokensUsed === 11,
          ),
        );
        yield* TestClock.adjust("5 seconds");
        yield* TestClock.adjust("10 seconds");
        yield* harness.firstTerminal;

        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("Stop prevents a capacity retry while pausing its goal", () =>
      Effect.gen(function* () {
        const nativeTurnId = "goal-capacity-stop";
        const prompt = "Keep going";
        const retrying = yield* Deferred.make<void>();
        const pausing = yield* Deferred.make<void>();
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario: "goal-capacity-stop",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              notification("goal active", "thread/goal/updated", {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                goal: codexGoal("active", 10),
              }),
              notification("capacity failure", "turn/completed", {
                threadId: nativeThreadId,
                turn: {
                  ...makeCodexReplayTurn({ id: nativeTurnId, status: "failed" }),
                  error: {
                    message: "Selected model is at capacity.",
                    codexErrorInfo: "serverOverloaded",
                  },
                },
              }),
              {
                type: "expect_outbound",
                frame: {
                  id: 4,
                  method: "thread/goal/set",
                  params: { threadId: nativeThreadId, status: "paused" },
                },
              },
              {
                type: "emit_inbound",
                afterMs: 3_000,
                frame: { id: 4, result: { goal: codexGoal("paused", 10) } },
              },
            ],
          }),
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "error" &&
            event.turnItem.status === "running"
              ? Deferred.succeed(retrying, undefined)
              : Effect.void,
          (method) =>
            Effect.gen(function* () {
              requests.push(method);
              if (method === "thread/goal/set") yield* Deferred.succeed(pausing, undefined);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-capacity-stop"),
            text: prompt,
          }),
        );
        yield* Deferred.await(retrying);
        const stopping = yield* harness.runtime
          .interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
              driver: CodexAdapterV2.CODEX_DRIVER_KIND,
              nativeTurnId,
            }),
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(pausing);
        yield* TestClock.adjust("3 seconds");
        assert.lengthOf(
          requests.filter((method) => method === "turn/start"),
          1,
        );
        yield* Fiber.join(stopping);
        yield* harness.awaitTerminal(1);
        assert.equal(harness.terminalEvents()[0]?.status, "interrupted");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("pauses an active goal before Stop interrupts its turn", () =>
      Effect.gen(function* () {
        const prompt = "Keep going";
        const transcript = makeCodexReplayTranscript({
          scenario: "goal-stop",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "goal-turn", prompt }),
            notification("goal active", "thread/goal/updated", {
              threadId: nativeThreadId,
              turnId: "goal-turn",
              goal: codexGoal("active", 10),
            }),
            ...request(
              4,
              "thread/goal/set",
              { threadId: nativeThreadId, status: "paused" },
              { goal: codexGoal("paused", 10) },
            ),
            ...request(5, "turn/interrupt", { threadId: nativeThreadId, turnId: "goal-turn" }, {}),
            notification("interrupted", "turn/completed", {
              threadId: nativeThreadId,
              turn: makeCodexReplayTurn({ id: "goal-turn", status: "interrupted" }),
            }),
          ],
        });
        const requests: Array<string> = [];
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          (method) =>
            Effect.sync(() => {
              requests.push(method);
            }),
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("goal-stop-attempt"),
            text: prompt,
          }),
        );
        yield* awaitUntil(
          () => providerGoals(harness.events).includes("active"),
          "the active goal to reach the provider thread",
        );
        yield* harness.runtime.interruptTurn({
          providerThread: harness.providerThread,
          providerTurnId: (yield* IdAllocator.IdAllocatorV2).derive.providerTurn({
            driver: CodexAdapterV2.CODEX_DRIVER_KIND,
            nativeTurnId: "goal-turn",
          }),
        });
        yield* harness.firstTerminal;

        assert.deepEqual(requests.slice(-2), ["thread/goal/set", "turn/interrupt"]);
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["interrupted"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );
  });

  describe("grill mode switch", () => {
    const GRILL_POLICY = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "grill",
      cwd: "/workspace",
    });

    const attachMcp = (threadId: ThreadId) =>
      Effect.gen(function* () {
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("test"),
          threadId,
          providerSessionId: "grill-session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer test",
          browserToolsAvailable: true,
        });
      });

    /**
     * thread/unsubscribe, then the resume, around which Codex unloads the thread and says so
     * with thread/status/changed notLoaded (before or after the resume answers, as codex-cli
     * 0.161 does), or not at all when the thread stayed loaded. Uses ids `id` and `id + 1`.
     */
    const reloadEntries = (input: {
      readonly id: number;
      readonly nativeThreadId: string;
      readonly notice: "before" | "after" | "none";
    }): Array<CodexReplay.CodexAppServerReplayEntry> => {
      const notLoaded: CodexReplay.CodexAppServerReplayEntry = {
        type: "emit_inbound",
        label: "thread/status/changed",
        frame: {
          method: "thread/status/changed",
          params: { threadId: input.nativeThreadId, status: { type: "notLoaded" } },
        },
      };
      return [
        {
          type: "expect_outbound",
          label: "thread/unsubscribe",
          frame: {
            id: input.id,
            method: "thread/unsubscribe",
            params: { threadId: input.nativeThreadId },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/unsubscribe",
          frame: { id: input.id, result: { status: "unsubscribed" } },
        },
        {
          type: "expect_outbound",
          label: "thread/resume",
          frame: {
            id: input.id + 1,
            method: "thread/resume",
            params: {
              threadId: input.nativeThreadId,
              excludeTurns: true,
              config: CodexAdapterV2.CODEX_THREAD_CONFIG,
            },
          },
        },
        ...(input.notice === "before" ? [notLoaded] : []),
        {
          type: "emit_inbound",
          label: "thread/resume",
          frame: {
            id: input.id + 1,
            result: { thread: { id: input.nativeThreadId, updatedAt: 1782622450 } },
          },
        },
        ...(input.notice === "after" ? [notLoaded] : []),
      ];
    };

    /** Runs an effect while moving the test clock, for the reload's bounded wait. */
    const advancingClock = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        let done = false;
        const fiber = yield* effect.pipe(
          Effect.ensuring(Effect.sync(() => (done = true))),
          Effect.forkScoped,
        );
        // The replayed Codex answers on real I/O: each tick first gives that a real moment, so a wait the adapter arms
        // after a reply is still ahead of the clock however slowly the machine runs (a busy CI runner).
        for (let tick = 0; !done && tick < 4000; tick++) {
          yield* TestClock.withLive(Effect.sleep("1 millis"));
          yield* TestClock.adjust("25 millis");
        }
        return yield* Fiber.join(fiber);
      });

    /** A turn on a thread with the T3 MCP server that completes at once. */
    const turnEntries = (input: {
      readonly id: number;
      readonly nativeThreadId: string;
      readonly nativeTurnId: string;
      readonly text: string;
      readonly model?: string;
      readonly runtimePolicy?: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
    }) =>
      Effect.gen(function* () {
        const params = yield* CodexAdapterV2.buildCodexTurnStartParams({
          nativeThreadId: input.nativeThreadId,
          codexInput: [{ type: "text", text: input.text }],
          runtimePolicy: input.runtimePolicy ?? GRILL_POLICY,
          modelSelection: { ...CODEX_TEST_MODEL_SELECTION, ...(input.model ? { model: input.model } : {}) },
          hasCavemanMcp: true,
        });
        const turn = (status: "inProgress" | "completed") =>
          makeCodexReplayTurn({ id: input.nativeTurnId, status });
        return [
          {
            type: "expect_outbound",
            label: "turn/start",
            frame: { id: input.id, method: "turn/start", params },
          },
          {
            type: "emit_inbound",
            label: "turn/start",
            frame: { id: input.id, result: { turn: turn("inProgress") } },
          },
          ...(["turn/started", "turn/completed"] as const).map((method) => ({
            type: "emit_inbound" as const,
            label: method,
            frame: {
              method,
              params: {
                threadId: input.nativeThreadId,
                turn: turn(method === "turn/started" ? "inProgress" : "completed"),
              },
            },
          })),
        ] satisfies Array<CodexReplay.CodexAppServerReplayEntry>;
      });

    const recordRequests = () => {
      const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
      return {
        requests,
        methods: () => requests.map((request) => request.method),
        onRequest: (method: string, params: unknown) =>
          Effect.sync(() => {
            requests.push({ method, params });
          }),
      };
    };

    const grillTurn = (input: {
      readonly threadId: ThreadId;
      readonly providerThread: OrchestrationV2ProviderThread;
      readonly attempt: string;
      readonly text: string;
      readonly mode?: "grill" | "default";
    }) =>
      Effect.map(DateTime.now, (now) => ({
        ...makeCodexTestTurnInput({
          threadId: input.threadId,
          providerThread: input.providerThread,
          now,
          attemptId: RunAttemptId.make(input.attempt),
          text: input.text,
        }),
        runtimePolicy:
          input.mode === "default"
            ? ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({ ...GRILL_POLICY, interactionMode: "default" })
            : GRILL_POLICY,
      }));

    it.effect("reloads into grill mode when Codex unloads the thread, also when it says so after the resume answers", () =>
      Effect.gen(function* () {
        const nativeThreadId = "grill-reload-thread";
        const transcript = makeCodexReplayTranscript({
          scenario: "grill-reload",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "default-turn", prompt: "Hello." }),
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: "default-turn", status: "completed" }) } },
            },
            ...reloadEntries({ id: 4, nativeThreadId, notice: "after" }),
            ...(yield* turnEntries({ id: 6, nativeThreadId, nativeTurnId: "grill-turn-1", text: "Grill me." })),
            // Still in grill mode: no second reload.
            ...(yield* turnEntries({ id: 7, nativeThreadId, nativeTurnId: "grill-turn-2", text: "Next round." })),
          ],
        });
        const recorder = recordRequests();
        const harness = yield* makeCodexReplayHarness(transcript, () => Effect.void, recorder.onRequest);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("default-attempt"),
            text: "Hello.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "the default turn");
        yield* attachMcp(harness.threadId);
        yield* advancingClock(
          harness.runtime.startTurn(
            yield* grillTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt: "grill-attempt-1", text: "Grill me." }),
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "the first grill turn");
        yield* harness.runtime.startTurn(
          yield* grillTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt: "grill-attempt-2", text: "Next round." }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "the second grill turn");
        assert.deepEqual(recorder.methods(), [
          "initialize",
          "thread/start",
          "turn/start",
          "thread/unsubscribe",
          "thread/resume",
          "turn/start",
          "turn/start",
        ]);
        const resume = recorder.requests.find((request) => request.method === "thread/resume");
        assert.property(CodexAdapterV2.codexMcpServersOf((resume?.params as { config: Record<string, unknown> }).config), "caveman-grill");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
      ),
    );

    it.effect("keeps Auto's provider while reloading a thread into grill mode", () =>
      Effect.gen(function* () {
        const nativeThreadId = "auto-grill-reload-thread";
        const reload = reloadEntries({ id: 4, nativeThreadId, notice: "after" });
        const turns = yield* turnEntries({ id: 7, nativeThreadId, nativeTurnId: "auto-grill-turn", text: "Grill me.", model: "caveman-auto" });
        const transcript = makeCodexReplayTranscript({
          scenario: "auto-grill-reload",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "default-turn", prompt: "Hello." }),
            { type: "emit_inbound", label: "turn/completed", frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: "default-turn", status: "completed" }) } } },
            ...reload.slice(0, 2),
            { type: "expect_outbound", label: "account/read", frame: { id: 5, method: "account/read", params: {} } },
            { type: "emit_inbound", label: "account/read", frame: { id: 5, result: { account: { type: "chatgpt", email: null, planType: "plus" }, requiresOpenaiAuth: true } } },
            ...reload.slice(2).map((entry) => {
              if (!("frame" in entry)) return entry;
              const frame = entry.frame as { id?: number; method?: string; params?: Record<string, unknown> };
              if (frame.id === undefined) return entry;
              return { ...entry, frame: { ...frame, id: 6, ...(entry.type === "expect_outbound" ? {
                params: { ...frame.params, modelProvider: "caveman", config: {
                  ...CodexAdapterV2.CODEX_THREAD_CONFIG,
                  "model_providers.caveman": { name: "Caveman", base_url: "http://127.0.0.1:8787/chatgpt", wire_api: "responses", requires_openai_auth: true, http_headers: { "x-cave-session": "thread-auto-grill-reload", "x-cave-agent": "caveman-code-codex" } },
                } },
              } : {}) } };
            }),
            ...turns,
          ],
        });
        const recorder = recordRequests();
        const harness = yield* makeCodexReplayHarness(transcript, () => Effect.void, recorder.onRequest);
        yield* harness.runtime.startTurn(makeCodexTestTurnInput({ threadId: harness.threadId, providerThread: harness.providerThread, now: yield* DateTime.now, attemptId: RunAttemptId.make("default-attempt"), text: "Hello." }));
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "the default turn");
        yield* attachMcp(harness.threadId);
        const turn = yield* grillTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt: "auto-grill-attempt", text: "Grill me." });
        yield* advancingClock(harness.runtime.startTurn({ ...turn, modelSelection: { ...turn.modelSelection, model: "caveman-auto" } }));
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "the Auto grill turn");
        const resumed = recorder.requests.find((request) => request.method === "thread/resume")?.params as { modelProvider: string; config: Record<string, unknown> };
        assert.equal(resumed.modelProvider, "caveman");
        assert.property(CodexAdapterV2.codexMcpServersOf(resumed.config), "caveman-grill");
        assert.deepInclude(resumed.config["model_providers.caveman"], { base_url: "http://127.0.0.1:8787/chatgpt" });
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
      ),
    );

    it.effect("never reloads over background work: entering grill mode is refused until it ends", () =>
      Effect.gen(function* () {
        const nativeThreadId = "grill-busy-thread";
        const transcript = makeCodexReplayTranscript({
          scenario: "grill-busy-enter",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "default-turn", prompt: "Start the sleep in the background." }),
            {
              type: "emit_inbound",
              label: "item/started/command",
              frame: {
                method: "item/started",
                params: { item: backgroundCommandItem("inProgress"), threadId: nativeThreadId, turnId: "default-turn", startedAtMs: 1782622440500 },
              },
            },
            {
              type: "emit_inbound",
              label: "turn/completed",
              frame: { method: "turn/completed", params: { threadId: nativeThreadId, turn: makeCodexReplayTurn({ id: "default-turn", status: "completed" }) } },
            },
            {
              type: "emit_inbound",
              label: "item/completed/command",
              afterMs: 30_000,
              frame: {
                method: "item/completed",
                params: { item: backgroundCommandItem("completed"), threadId: nativeThreadId, turnId: "default-turn", completedAtMs: 1782622470500 },
              },
            },
            ...reloadEntries({ id: 4, nativeThreadId, notice: "before" }),
            ...(yield* turnEntries({ id: 6, nativeThreadId, nativeTurnId: "grill-turn", text: "Grill me." })),
          ],
        });
        const recorder = recordRequests();
        const harness = yield* makeCodexReplayHarness(transcript, () => Effect.void, recorder.onRequest);
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make("default-attempt"),
            text: "Start the sleep in the background.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "the default turn");
        yield* attachMcp(harness.threadId);
        const refused = yield* harness.runtime
          .startTurn(yield* grillTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt: "grill-attempt-1", text: "Grill me." }))
          .pipe(Effect.flip);
        assert.include(JSON.stringify(refused), CodexAdapterV2.CODEX_GRILL_BUSY_THREAD);
        // The thread, its terminal and its tools are untouched.
        assert.deepEqual(recorder.methods(), ["initialize", "thread/start", "turn/start"]);
        assert.isTrue(yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread));

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(
          () =>
            harness.events.some(
              (event) => event.type === "turn_item.updated" && event.turnItem.type === "command_execution" && event.turnItem.status === "completed",
            ),
          "the background command to finish",
        );
        assert.isFalse(yield* harness.runtime.hasPendingBackgroundWorkForThread!(harness.providerThread));
        yield* advancingClock(
          harness.runtime.startTurn(
            yield* grillTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt: "grill-attempt-2", text: "Grill me." }),
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "the grill turn");
        assert.deepEqual(recorder.methods().slice(3), ["thread/unsubscribe", "thread/resume", "turn/start"]);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
      ),
    );

    it.effect("never reloads over background work: leaving grill mode keeps its tools until the work ends", () =>
      Effect.gen(function* () {
        const sourceThreadId = "grill-busy-source";
        const nativeThreadId = "grill-busy-fork";
        const targetThreadId = ThreadId.make("thread-grill-busy-fork");
        const grillTurnEntries = yield* turnEntries({ id: 4, nativeThreadId, nativeTurnId: "grill-turn", text: "Start the sleep in the background." });
        const transcript = makeCodexReplayTranscript({
          scenario: "grill-busy-leave",
          entries: [
            ...codexReplayPreamble({ nativeThreadId: sourceThreadId, nativeTurnId: "unused", prompt: "unused" }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: { id: 3, method: "thread/fork", params: { threadId: sourceThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG } },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: { id: 3, result: codexReplayThreadResult({ nativeThreadId, forkedFromId: sourceThreadId }) },
            },
            // A grill turn that leaves a command running in the background.
            ...grillTurnEntries.slice(0, -1),
            {
              type: "emit_inbound",
              label: "item/started/command",
              frame: {
                method: "item/started",
                params: { item: backgroundCommandItem("inProgress"), threadId: nativeThreadId, turnId: "grill-turn", startedAtMs: 1782622440500 },
              },
            },
            ...grillTurnEntries.slice(-1),
            // Default mode while it runs: no reload.
            ...(yield* turnEntries({ id: 5, nativeThreadId, nativeTurnId: "default-turn-1", text: "Build it." })),
            {
              type: "emit_inbound",
              label: "item/completed/command",
              afterMs: 30_000,
              frame: {
                method: "item/completed",
                params: { item: backgroundCommandItem("completed"), threadId: nativeThreadId, turnId: "grill-turn", completedAtMs: 1782622470500 },
              },
            },
            // Once it ends, the next default turn reloads without the grill server.
            ...reloadEntries({ id: 6, nativeThreadId, notice: "before" }),
            ...(yield* turnEntries({ id: 8, nativeThreadId, nativeTurnId: "default-turn-2", text: "Go on." })),
          ],
        });
        const recorder = recordRequests();
        const harness = yield* makeCodexReplayHarness(transcript, () => Effect.void, recorder.onRequest);
        yield* attachMcp(targetThreadId);
        const forked = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          targetThreadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: GRILL_POLICY,
        });
        yield* harness.runtime.startTurn(
          yield* grillTurn({ threadId: targetThreadId, providerThread: forked, attempt: "grill-attempt", text: "Start the sleep in the background." }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "the grill turn");
        assert.isTrue(yield* harness.runtime.hasPendingBackgroundWorkForThread!(forked));
        yield* harness.runtime.startTurn(
          yield* grillTurn({ threadId: targetThreadId, providerThread: forked, attempt: "default-attempt-1", text: "Build it.", mode: "default" }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "the first default turn");
        assert.isTrue(yield* harness.runtime.hasPendingBackgroundWorkForThread!(forked));

        yield* TestClock.adjust("30 seconds");
        yield* awaitUntil(() => harness.events.some((event) => event.type === "turn_item.updated" && event.turnItem.type === "command_execution" && event.turnItem.status === "completed"), "the background command to finish");
        yield* advancingClock(
          harness.runtime.startTurn(
            yield* grillTurn({ threadId: targetThreadId, providerThread: forked, attempt: "default-attempt-2", text: "Go on.", mode: "default" }),
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 3, "the second default turn");
        assert.deepEqual(recorder.methods().slice(2), ["thread/fork", "turn/start", "turn/start", "thread/unsubscribe", "thread/resume", "turn/start"]);
        const resume = recorder.requests.find((request) => request.method === "thread/resume");
        assert.notProperty(CodexAdapterV2.codexMcpServersOf((resume?.params as { config: Record<string, unknown> }).config), "caveman-grill");
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
      ),
    );

    it.effect("keeps the old mode when Codex does not unload the thread, and retries", () =>
      Effect.gen(function* () {
        const nativeThreadId = "grill-no-unload-thread";
        const transcript = makeCodexReplayTranscript({
          scenario: "grill-no-unload",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 5),
            // Another subscriber keeps the thread loaded: no notLoaded, the old tools stay.
            ...reloadEntries({ id: 3, nativeThreadId, notice: "none" }),
            ...(yield* turnEntries({
              id: 5,
              nativeThreadId,
              nativeTurnId: "grill-turn-1",
              text: "Grill me.",
            })),
            ...reloadEntries({ id: 6, nativeThreadId, notice: "before" }),
            ...(yield* turnEntries({
              id: 8,
              nativeThreadId,
              nativeTurnId: "grill-turn-2",
              text: "Next round.",
            })),
          ],
        });
        const recorder = recordRequests();
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          recorder.onRequest,
        );
        yield* attachMcp(harness.threadId);
        yield* advancingClock(
          harness.runtime.startTurn(
            yield* grillTurn({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              attempt: "grill-attempt-1",
              text: "Grill me.",
            }),
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "the first grill turn");
        yield* advancingClock(
          harness.runtime.startTurn(
            yield* grillTurn({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              attempt: "grill-attempt-2",
              text: "Next round.",
            }),
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "the second grill turn");
        assert.deepEqual(recorder.methods(), [
          "initialize",
          "thread/start",
          "thread/unsubscribe",
          "thread/resume",
          "turn/start",
          "thread/unsubscribe",
          "thread/resume",
          "turn/start",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("records the mode a fork and a rollback's resume load the thread with", () =>
      Effect.gen(function* () {
        const sourceThreadId = "grill-fork-source";
        const forkThreadId = "grill-fork-thread";
        const targetThreadId = ThreadId.make("thread-grill-fork-target");
        const transcript = makeCodexReplayTranscript({
          scenario: "grill-fork-rollback",
          entries: [
            ...codexReplayPreamble({
              nativeThreadId: sourceThreadId,
              nativeTurnId: "unused",
              prompt: "unused",
            }).slice(0, 5),
            {
              type: "expect_outbound",
              label: "thread/fork",
              frame: {
                id: 3,
                method: "thread/fork",
                params: { threadId: sourceThreadId, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/fork",
              frame: {
                id: 3,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: sourceThreadId,
                }),
              },
            },
            // The fork loaded grill mode's server: no reload.
            ...(yield* turnEntries({
              id: 4,
              nativeThreadId: forkThreadId,
              nativeTurnId: "fork-turn",
              text: "Grill me.",
            })),
            {
              type: "expect_outbound",
              label: "thread/read",
              frame: {
                id: 5,
                method: "thread/read",
                params: { threadId: forkThreadId, includeTurns: false },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/read",
              frame: {
                id: 5,
                result: {
                  thread: {
                    id: forkThreadId,
                    historyMode: "paginated",
                    status: { type: "notLoaded" },
                  },
                },
              },
            },
            // The rollback loads it with the session's default mode.
            {
              type: "expect_outbound",
              label: "thread/resume",
              frame: {
                id: 6,
                method: "thread/resume",
                params: {
                  threadId: forkThreadId,
                  excludeTurns: true,
                  config: CodexAdapterV2.CODEX_THREAD_CONFIG,
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/resume",
              frame: { id: 6, result: { thread: { id: forkThreadId, updatedAt: 1782622450 } } },
            },
            {
              type: "expect_outbound",
              label: "thread/turns/list",
              frame: {
                id: 7,
                method: "thread/turns/list",
                params: {
                  threadId: forkThreadId,
                  cursor: null,
                  limit: 1,
                  sortDirection: "desc",
                  itemsView: "summary",
                },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/turns/list",
              frame: {
                id: 7,
                result: {
                  data: [{ id: "fork-turn", items: [], status: "completed", error: null }],
                  nextCursor: null,
                },
              },
            },
            {
              type: "expect_outbound",
              label: "thread/revert",
              frame: {
                id: 8,
                method: "thread/revert",
                params: { threadId: forkThreadId, beforeTurnId: "fork-turn" },
              },
            },
            {
              type: "emit_inbound",
              label: "thread/revert",
              frame: {
                id: 8,
                result: codexReplayThreadResult({
                  nativeThreadId: forkThreadId,
                  forkedFromId: null,
                }),
              },
            },
            // Back in grill mode: reload.
            ...reloadEntries({ id: 9, nativeThreadId: forkThreadId, notice: "before" }),
            ...(yield* turnEntries({
              id: 11,
              nativeThreadId: forkThreadId,
              nativeTurnId: "fork-turn-after-rollback",
              text: "Grill me again.",
            })),
          ],
        });
        const recorder = recordRequests();
        const harness = yield* makeCodexReplayHarness(
          transcript,
          () => Effect.void,
          recorder.onRequest,
        );
        yield* attachMcp(targetThreadId);
        const forked = yield* harness.runtime.forkThread({
          sourceProviderThread: harness.providerThread,
          targetThreadId,
          modelSelection: CODEX_TEST_MODEL_SELECTION,
          runtimePolicy: GRILL_POLICY,
        });
        yield* harness.runtime.startTurn(
          yield* grillTurn({
            threadId: targetThreadId,
            providerThread: forked,
            attempt: "fork-attempt",
            text: "Grill me.",
          }),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 1, "the fork's grill turn");
        const forkTurn = codexReplaySourceTurn({
          id: "provider-fork-turn",
          ordinal: 1,
          nativeId: "fork-turn",
          providerThreadId: forked.id,
          now: yield* DateTime.now,
        });
        const rolledBack = yield* harness.runtime.rollbackThread({
          providerThread: forked,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-grill-rollback"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [forkTurn],
        });
        yield* advancingClock(
          harness.runtime.startTurn(
            yield* grillTurn({
              threadId: targetThreadId,
              providerThread: rolledBack.providerThread,
              attempt: "rollback-attempt",
              text: "Grill me again.",
            }),
          ),
        );
        yield* awaitUntil(() => harness.terminalEvents().length === 2, "the grill turn after rollback");
        assert.deepEqual(recorder.methods().slice(2), [
          "thread/fork",
          "turn/start",
          "thread/read",
          "thread/resume",
          "thread/turns/list",
          "thread/revert",
          "thread/unsubscribe",
          "thread/resume",
          "turn/start",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    describe("on a Cloud computer, where the desktop's input asks unless the chat has Full access", () => {
      const FULL = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      });
      const SUPERVISED = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        ...FULL,
        runtimeMode: "approval-required",
      });
      const onCloudComputer = Effect.acquireRelease(
        Effect.sync(() => {
          const before = process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
          process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = "127.0.0.1:47917";
          return before;
        }),
        (before) =>
          Effect.sync(() => {
            if (before === undefined) delete process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS;
            else process.env.CAVEMAN_RUNTIME_TOOLS_ADDRESS = before;
          }),
      );
      const accessTurn = (input: {
        readonly threadId: ThreadId;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly attempt: string;
        readonly text: string;
        readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
      }) =>
        Effect.map(DateTime.now, (now) => ({
          ...makeCodexTestTurnInput({ ...input, now, attemptId: RunAttemptId.make(input.attempt) }),
          runtimePolicy: input.runtimePolicy,
        }));
      /** The desktop tool's approval in each thread/start or thread/resume's config. */
      const computerApprovals = (recorder: ReturnType<typeof recordRequests>) =>
        recorder.requests.flatMap((request) => {
          if (request.method !== "thread/start" && request.method !== "thread/resume") return [];
          const config = (request.params as { readonly config: Record<string, unknown> }).config;
          const t3 = CodexAdapterV2.codexMcpServersOf(config)["caveman-code"] as
            | { readonly tools?: { readonly computer?: { readonly approval_mode?: string } } }
            | undefined;
          return [`${request.method} ${t3?.tools?.computer?.approval_mode}`];
        });
      const rejoinEntries = (id: number, nativeThreadId: string): Array<CodexReplay.CodexAppServerReplayEntry> => [
        {
          type: "expect_outbound",
          label: "thread/resume (rejoin)",
          frame: {
            id,
            method: "thread/resume",
            params: { threadId: nativeThreadId, excludeTurns: true, config: CodexAdapterV2.CODEX_THREAD_CONFIG },
          },
        },
        {
          type: "emit_inbound",
          label: "thread/resume (rejoin)",
          frame: { id, result: { thread: { id: nativeThreadId, updatedAt: 1782622450 } } },
        },
      ];

      it.effect("a chat that leaves Full access reloads its thread, so the desktop's input asks again, and back", () =>
        Effect.gen(function* () {
          yield* onCloudComputer;
          const nativeThreadId = "access-switch-thread";
          const transcript = makeCodexReplayTranscript({
            scenario: "access-switch",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" }).slice(0, 5),
              ...(yield* turnEntries({ id: 3, nativeThreadId, nativeTurnId: "full-turn", text: "Click around.", runtimePolicy: FULL })),
              // The run's new load key: ProviderSessionManager resumes the loaded thread, which Codex only rejoins.
              ...rejoinEntries(4, nativeThreadId),
              ...reloadEntries({ id: 5, nativeThreadId, notice: "after" }),
              ...(yield* turnEntries({ id: 7, nativeThreadId, nativeTurnId: "supervised-turn", text: "Ask me first.", runtimePolicy: SUPERVISED })),
              ...rejoinEntries(8, nativeThreadId),
              ...reloadEntries({ id: 9, nativeThreadId, notice: "before" }),
              ...(yield* turnEntries({ id: 11, nativeThreadId, nativeTurnId: "full-again-turn", text: "Go ahead.", runtimePolicy: FULL })),
            ],
          });
          yield* attachMcp(ThreadId.make(`thread-${transcript.scenario}`));
          const recorder = recordRequests();
          const harness = yield* makeCodexReplayHarness(transcript, () => Effect.void, recorder.onRequest);
          const switchTo = (runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy, attempt: string, text: string) =>
            Effect.gen(function* () {
              const providerThread = yield* harness.runtime.resumeThread({
                providerThread: harness.providerThread,
                threadId: harness.threadId,
                modelSelection: CODEX_TEST_MODEL_SELECTION,
                runtimePolicy,
              });
              return yield* advancingClock(
                harness.runtime
                  .startTurn(yield* accessTurn({ threadId: harness.threadId, providerThread, attempt, text, runtimePolicy }))
                  .pipe(Effect.exit),
              );
            });

          yield* harness.runtime.startTurn(
            yield* accessTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt: "full-attempt", text: "Click around.", runtimePolicy: FULL }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "the Full access turn");
          yield* switchTo(SUPERVISED, "supervised-attempt", "Ask me first.");
          assert.deepEqual(recorder.methods().slice(2), [
            "turn/start",
            "thread/resume",
            "thread/unsubscribe",
            "thread/resume",
            "turn/start",
          ]);
          yield* awaitUntil(() => harness.terminalEvents().length === 2, "the supervised turn");
          yield* switchTo(FULL, "full-again-attempt", "Go ahead.");
          yield* awaitUntil(() => harness.terminalEvents().length === 3, "the Full access turn after it");
          assert.deepEqual(computerApprovals(recorder), [
            "thread/start approve",
            "thread/resume prompt",
            "thread/resume prompt",
            "thread/resume approve",
            "thread/resume approve",
          ]);
          assert.deepEqual(yield* harness.replayProgress, { cursor: transcript.entries.length, failure: null });
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
        ),
      );

      it.effect("never leaves Full access's approvals in force over background work: leaving it is refused until the work ends", () =>
        Effect.gen(function* () {
          yield* onCloudComputer;
          const nativeThreadId = "access-busy-thread";
          const fullTurn = yield* turnEntries({
            id: 3,
            nativeThreadId,
            nativeTurnId: "full-turn",
            text: "Start the server in the background.",
            runtimePolicy: FULL,
          });
          const transcript = makeCodexReplayTranscript({
            scenario: "access-busy",
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt: "unused" }).slice(0, 5),
              ...fullTurn.slice(0, -1),
              {
                type: "emit_inbound",
                label: "item/started/command",
                frame: {
                  method: "item/started",
                  params: { item: backgroundCommandItem("inProgress"), threadId: nativeThreadId, turnId: "full-turn", startedAtMs: 1782622440500 },
                },
              },
              ...fullTurn.slice(-1),
              {
                type: "emit_inbound",
                label: "item/completed/command",
                afterMs: 30_000,
                frame: {
                  method: "item/completed",
                  params: { item: backgroundCommandItem("completed"), threadId: nativeThreadId, turnId: "full-turn", completedAtMs: 1782622470500 },
                },
              },
              ...reloadEntries({ id: 4, nativeThreadId, notice: "before" }),
              ...(yield* turnEntries({ id: 6, nativeThreadId, nativeTurnId: "supervised-turn", text: "Ask me first.", runtimePolicy: SUPERVISED })),
            ],
          });
          yield* attachMcp(ThreadId.make(`thread-${transcript.scenario}`));
          const recorder = recordRequests();
          const harness = yield* makeCodexReplayHarness(transcript, () => Effect.void, recorder.onRequest);
          const supervisedTurn = (attempt: string) =>
            accessTurn({ threadId: harness.threadId, providerThread: harness.providerThread, attempt, text: "Ask me first.", runtimePolicy: SUPERVISED });
          yield* harness.runtime.startTurn(
            yield* accessTurn({
              threadId: harness.threadId,
              providerThread: harness.providerThread,
              attempt: "full-attempt",
              text: "Start the server in the background.",
              runtimePolicy: FULL,
            }),
          );
          yield* awaitUntil(() => harness.terminalEvents().length === 1, "the Full access turn");

          let answered = false;
          const refusal = yield* harness.runtime.startTurn(yield* supervisedTurn("supervised-attempt-1")).pipe(
            Effect.flip,
            Effect.ensuring(Effect.sync(() => (answered = true))),
            Effect.forkScoped,
          );
          yield* awaitUntil(() => answered || recorder.methods().length > 3, "the supervised turn's answer");
          // The thread, its terminal and its tools are untouched.
          assert.deepEqual(recorder.methods(), ["initialize", "thread/start", "turn/start"]);
          assert.include(JSON.stringify(yield* Fiber.join(refusal)), CodexAdapterV2.CODEX_ACCESS_BUSY_THREAD);

          yield* TestClock.adjust("30 seconds");
          yield* awaitUntil(
            () =>
              harness.events.some(
                (event) => event.type === "turn_item.updated" && event.turnItem.type === "command_execution" && event.turnItem.status === "completed",
              ),
            "the background command to finish",
          );
          yield* advancingClock(harness.runtime.startTurn(yield* supervisedTurn("supervised-attempt-2")));
          yield* awaitUntil(() => harness.terminalEvents().length === 2, "the supervised turn");
          assert.deepEqual(recorder.methods().slice(3), ["thread/unsubscribe", "thread/resume", "turn/start"]);
          assert.deepEqual(computerApprovals(recorder), ["thread/start approve", "thread/resume prompt"]);
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer)),
        ),
      );
    });
  });

  describe("Codex file-change approval paths", () => {
    const nativeThreadId = "file-approval-thread";
    const nativeTurnId = "file-approval-turn";
    const prompt = "Edit the files.";
    type FileUpdateChange = CodexSchema.V2ItemStartedNotification__FileUpdateChange;
    const addA: FileUpdateChange = { path: "/w/a.ts", kind: { type: "add" }, diff: "export {};" };
    const updateB: FileUpdateChange = {
      path: "/w/b.ts",
      kind: { type: "update", move_path: null },
      diff: "@@",
    };
    const renameC: FileUpdateChange = {
      path: "/w/c.ts",
      kind: { type: "update", move_path: "/w/d.ts" },
      diff: "@@",
    };

    const deleteE: FileUpdateChange = { path: "/w/e.ts", kind: { type: "delete" }, diff: "gone" };

    const fileChange = (
      phase: "started" | "completed",
      turnId: string,
      itemId: string,
      changes: ReadonlyArray<FileUpdateChange>,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `${phase} ${itemId}`,
      frame: {
        method: `item/${phase}`,
        params: {
          threadId: nativeThreadId,
          turnId,
          ...(phase === "started" ? { startedAtMs: 1 } : { completedAtMs: 3 }),
          item: {
            type: "fileChange",
            id: itemId,
            status: phase === "started" ? "inProgress" : "completed",
            changes,
          },
        },
      },
    });

    const approval = (input: {
      readonly id: number;
      readonly turnId: string;
      readonly itemId: string;
    }): Array<CodexReplay.CodexAppServerReplayEntry> => [
      {
        type: "emit_inbound",
        label: `approval ${input.itemId}`,
        frame: {
          id: input.id,
          method: "item/fileChange/requestApproval",
          params: {
            threadId: nativeThreadId,
            turnId: input.turnId,
            itemId: input.itemId,
            startedAtMs: 2,
            reason: null,
            grantRoot: null,
          },
        },
      },
      {
        type: "expect_outbound",
        label: `approval ${input.itemId}`,
        frame: { id: input.id, result: { decision: "accept" } },
      },
    ];

    const turnCompleted = (turnId: string): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `complete ${turnId}`,
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: makeCodexReplayTurn({ id: turnId, status: "completed" }),
        },
      },
    });

    const startApprovalTurn = (
      scenario: string,
      entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
    ) =>
      Effect.gen(function* () {
        const pending = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
        const harness = yield* makeCodexReplayHarness(
          makeCodexReplayTranscript({
            scenario,
            entries: [...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }), ...entries],
          }),
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
              ? Queue.offer(pending, event.runtimeRequest)
              : Effect.void,
        );
        yield* harness.runtime.startTurn(
          makeCodexTestTurnInput({
            threadId: harness.threadId,
            providerThread: harness.providerThread,
            now: yield* DateTime.now,
            attemptId: RunAttemptId.make(`${scenario}-attempt`),
            text: prompt,
          }),
        );
        return {
          harness,
          answerNext: Queue.take(pending).pipe(
            Effect.tap((request) =>
              harness.runtime.respondToRuntimeRequest({
                requestId: request.id,
                decision: "accept",
              }),
            ),
          ),
        };
      });

    const approvalItem = (
      events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
      request: OrchestrationV2RuntimeRequest,
    ) =>
      events.flatMap((event) =>
        event.type === "turn_item.updated" &&
        event.turnItem.type === "approval_request" &&
        event.turnItem.requestId === request.id
          ? [event.turnItem]
          : [],
      )[0];

    it.effect("answers without waiting for late paths or borrowing another item's paths", () =>
      Effect.gen(function* () {
        const { harness, answerNext } = yield* startApprovalTurn("file-approval-after", [
          fileChange("started", nativeTurnId, "other-patch", [updateB]),
          // Late details cannot arrive until the approval response has been sent.
          ...approval({ id: 0, turnId: nativeTurnId, itemId: "patch-a" }),
          fileChange("started", nativeTurnId, "patch-a", [addA]),
          fileChange("completed", nativeTurnId, "patch-a", [addA]),
          fileChange("completed", nativeTurnId, "other-patch", [updateB]),
          turnCompleted(nativeTurnId),
        ]);
        const request = yield* answerNext;
        yield* harness.firstTerminal;

        const items = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "approval_request" &&
          event.turnItem.requestId === request.id
            ? [event.turnItem]
            : [],
        );
        assert.equal(request.nativeRequestRef?.nativeId, "patch-a");
        assert.isNotEmpty(items);
        for (const item of items) {
          assert.equal(item.requestKind, "file-change");
          assert.isUndefined(item.prompt);
        }
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("matches file paths to items approved out of order", () =>
      Effect.gen(function* () {
        const { harness, answerNext } = yield* startApprovalTurn("file-approval-concurrent", [
          fileChange("started", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          fileChange("started", nativeTurnId, "patch-b", [updateB]),
          ...approval({ id: 0, turnId: nativeTurnId, itemId: "patch-b" }),
          fileChange("completed", nativeTurnId, "patch-b", [updateB]),
          ...approval({ id: 1, turnId: nativeTurnId, itemId: "patch-a" }),
          fileChange("completed", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          turnCompleted(nativeTurnId),
        ]);
        const first = yield* answerNext;
        const second = yield* answerNext;
        yield* harness.firstTerminal;

        assert.deepEqual(
          [first, second].map((request) => [
            request.nativeRequestRef?.nativeId,
            approvalItem(harness.events, request)?.prompt,
          ]),
          [
            ["patch-b", "update /w/b.ts"],
            ["patch-a", "add /w/a.ts\nupdate /w/c.ts -> /w/d.ts\ndelete /w/e.ts"],
          ],
        );
        assert.deepEqual(
          harness.terminalEvents().map((event) => event.status),
          ["completed"],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("keeps every path of a completed multi-file patch", () =>
      Effect.gen(function* () {
        const { harness } = yield* startApprovalTurn("file-change-multi-path", [
          fileChange("started", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          fileChange("completed", nativeTurnId, "patch-a", [renameC, deleteE, addA]),
          turnCompleted(nativeTurnId),
        ]);
        yield* harness.firstTerminal;

        const fileChanges = harness.events.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "file_change"
            ? [event.turnItem]
            : [],
        );
        assert.lengthOf(fileChanges, 1);
        assert.equal(fileChanges[0]?.fileName, "/w/c.ts");
        assert.deepEqual(fileChanges[0]?.changes, [
          { operation: "update", path: "/w/d.ts", oldPath: "/w/c.ts" },
          { operation: "delete", path: "/w/e.ts" },
          { operation: "add", path: "/w/a.ts" },
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            McpProviderSessions.layer,
            NodeServices.layer,
            NodeCrypto.layer,
          ),
        ),
      ),
    );

    it.effect("classifies permission requests that only list sandbox entries", () =>
      Effect.gen(function* () {
        const permissionRequest = (
          id: number,
          itemId: string,
          entries: CodexSchema.PermissionsRequestApprovalParams__AdditionalFileSystemPermissions["entries"],
        ): Array<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "emit_inbound",
            label: `permissions ${itemId}`,
            frame: {
              id,
              method: "item/permissions/requestApproval",
              params: {
                threadId: nativeThreadId,
                turnId: nativeTurnId,
                itemId,
                cwd: "/w",
                startedAtMs: 2,
                permissions: { fileSystem: { entries } },
              },
            },
          },
          {
            type: "expect_outbound",
            label: `permissions ${itemId}`,
            frame: { id, result: { permissions: { fileSystem: { entries } }, scope: "turn" } },
          },
        ];
        const { harness, answerNext } = yield* startApprovalTurn("permission-entries", [
          ...permissionRequest(0, "write-glob", [
            { access: "read", path: { type: "path", path: "/w/src" } },
            { access: "write", path: { type: "glob_pattern", pattern: "/w/out/**" } },
          ]),
          ...permissionRequest(1, "read-glob", [
            { access: "read", path: { type: "glob_pattern", pattern: "/w/docs/**" } },
          ]),
          turnCompleted(nativeTurnId),
        ]);
        const write = yield* answerNext;
        const read = yield* answerNext;
        yield* harness.firstTerminal;

        assert.deepEqual(
          [write, read].map((request) => [
            request.kind,
            approvalItem(harness.events, request)?.requestKind,
          ]),
          [
            ["file-change", "file-change"],
            ["file-read", "file-read"],
          ],
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );
  });

  // Codex waits on every request it sends: each one is answered, or its turn never ends.
  describe("Codex requests and the turns they belong to", () => {
    const nativeThreadId = "request-turn-thread";
    const nativeTurnId = "request-turn";
    const prompt = "Build it.";
    const kinds = {
      command: {
        method: "item/commandExecution/requestApproval",
        params: (turnId: string, threadId: string) => ({
          threadId,
          turnId,
          itemId: `command-${turnId}`,
          startedAtMs: 2,
          command: "make build",
        }),
        noTurn: (turnId: string, _threadId: string) =>
          `No active Codex turn context for approval turn ${turnId}.`,
        cancelled: { decision: "cancel" },
      },
      "file change": {
        method: "item/fileChange/requestApproval",
        params: (turnId: string, threadId: string) => ({
          threadId,
          turnId,
          itemId: `patch-${turnId}`,
          startedAtMs: 2,
          reason: null,
          grantRoot: null,
        }),
        noTurn: (turnId: string, _threadId: string) =>
          `No active Codex turn context for file change approval turn ${turnId}.`,
        cancelled: { decision: "cancel" },
      },
      permissions: {
        method: "item/permissions/requestApproval",
        params: (turnId: string, threadId: string) => ({
          threadId,
          turnId,
          itemId: `permissions-${turnId}`,
          cwd: "/workspace",
          startedAtMs: 2,
          permissions: { network: { enabled: true } },
        }),
        noTurn: (turnId: string, _threadId: string) =>
          `No active Codex turn context for permissions approval turn ${turnId}.`,
        cancelled: { permissions: {}, scope: "turn" },
      },
      question: {
        method: "item/tool/requestUserInput",
        params: (turnId: string, threadId: string) => ({
          threadId,
          turnId,
          itemId: `question-${turnId}`,
          isBlocking: true,
          questions: [{ id: "branch", header: "Branch", question: "Which branch?" }],
        }),
        noTurn: (turnId: string, _threadId: string) =>
          `No active Codex turn context for user input request turn ${turnId}.`,
        cancelled: { answers: {} },
      },
      "legacy command": {
        method: "execCommandApproval",
        params: (_turnId: string, threadId: string) => ({
          conversationId: threadId,
          callId: `exec-${threadId}`,
          command: ["make", "build"],
          cwd: "/workspace",
          parsedCmd: [],
        }),
        noTurn: (_turnId: string, threadId: string) =>
          `No active Codex turn context for exec approval thread ${threadId}.`,
        cancelled: { decision: "abort" },
      },
      "legacy patch": {
        method: "applyPatchApproval",
        params: (_turnId: string, threadId: string) => ({
          conversationId: threadId,
          callId: `apply-${threadId}`,
          fileChanges: {},
        }),
        noTurn: (_turnId: string, threadId: string) =>
          `No active Codex turn context for apply patch approval thread ${threadId}.`,
        cancelled: { decision: "abort" },
      },
    } as const;
    type Kind = keyof typeof kinds;
    const kindNames = Object.keys(kinds) as Array<Kind>;

    const request = (
      kind: Kind,
      id: number,
      turnId: string,
      threadId = nativeThreadId,
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `${kind} request ${id}`,
      frame: { id, method: kinds[kind].method, params: kinds[kind].params(turnId, threadId) },
    });
    const turnEnded = (
      turnId: string,
      status: "completed" | "interrupted" | "failed",
    ): CodexReplay.CodexAppServerReplayEntry => ({
      type: "emit_inbound",
      label: `turn/completed ${turnId}`,
      frame: {
        method: "turn/completed",
        params: {
          threadId: nativeThreadId,
          turn: {
            ...makeCodexReplayTurn({ id: turnId, status }),
            ...(status === "failed"
              ? {
                  error: {
                    message: "stream disconnected before completion",
                    codexErrorInfo: "other",
                    additionalDetails: null,
                  },
                }
              : {}),
          },
        },
      },
    });
    const stopEntries = (id: number, turnId: string): Array<CodexReplay.CodexAppServerReplayEntry> => [
      {
        type: "expect_outbound",
        label: `turn/interrupt ${turnId}`,
        frame: { id, method: "turn/interrupt", params: { threadId: nativeThreadId, turnId } },
      },
      { type: "emit_inbound", label: `turn/interrupt ${turnId}`, frame: { id, result: {} } },
      turnEnded(turnId, "interrupted"),
    ];
    const collectRequests = Effect.gen(function* () {
      const shown = yield* Queue.unbounded<OrchestrationV2RuntimeRequest>();
      return {
        shown,
        onEvent: (event: ProviderAdapter.ProviderAdapterV2Event) =>
          event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
            ? Queue.offer(shown, event.runtimeRequest)
            : Effect.void,
      };
    });
    const turnInput = (
      harness: { readonly threadId: ThreadId; readonly providerThread: OrchestrationV2ProviderThread },
      attempt: string,
      text = prompt,
    ) =>
      Effect.map(DateTime.now, (now) =>
        makeCodexTestTurnInput({
          threadId: harness.threadId,
          providerThread: harness.providerThread,
          now,
          attemptId: RunAttemptId.make(attempt),
          text,
        }),
      );

    it.effect.each(kindNames)(
      "answers a %s request for a turn it does not run with an error, so Codex never waits on it",
      (kind) =>
        Effect.gen(function* () {
          const staleTurnId = "request-turn-gone";
          // The legacy requests name a thread; the others a turn of this thread.
          const staleThreadId = kind.startsWith("legacy") ? "request-thread-gone" : nativeThreadId;
          const transcript = makeCodexReplayTranscript({
            scenario: `request-for-gone-turn-${kind.replace(" ", "-")}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              request(kind, 90, staleTurnId, staleThreadId),
              {
                type: "expect_outbound",
                label: `${kind} request 90 refused`,
                frame: {
                  id: 90,
                  error: { code: -32602, message: kinds[kind].noTurn(staleTurnId, staleThreadId) },
                },
              },
              turnEnded(nativeTurnId, "completed"),
            ],
          });
          const harness = yield* makeCodexReplayHarness(transcript);
          yield* harness.runtime.startTurn(yield* turnInput(harness, `gone-turn-${kind}`));

          assert.deepEqual(yield* harness.replayProgress, {
            cursor: transcript.entries.length,
            failure: null,
          });
          yield* harness.awaitTerminal(1);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
    );

    it.effect.each(kindNames.flatMap((kind) => [[kind, "Stop"] as const, [kind, "failed"] as const]))(
      "answers a %s request left open when its turn ends by %s, so its handler ends with the turn",
      ([kind, end]) =>
        Effect.gen(function* () {
          const transcript = makeCodexReplayTranscript({
            scenario: `request-left-open-${kind.replace(" ", "-")}-${end}`,
            entries: [
              ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
              request(kind, 70, nativeTurnId),
              ...(end === "Stop" ? stopEntries(4, nativeTurnId) : [turnEnded(nativeTurnId, "failed")]),
              {
                type: "expect_outbound",
                label: `${kind} request 70 cancelled`,
                frame: { id: 70, result: kinds[kind].cancelled },
              },
            ],
          });
          const { shown, onEvent } = yield* collectRequests;
          const harness = yield* makeCodexReplayHarness(transcript, onEvent);
          yield* harness.runtime.startTurn(yield* turnInput(harness, `left-open-${kind}-${end}`));
          const card = yield* Queue.take(shown);
          if (end === "Stop") {
            assert.isNotNull(card.providerTurnId);
            yield* harness.runtime.interruptTurn({
              providerThread: harness.providerThread,
              providerTurnId: card.providerTurnId!,
              requestRuntimeRestart: true,
            });
          }

          assert.deepEqual(yield* harness.replayProgress, {
            cursor: transcript.entries.length,
            failure: null,
          });
          // The card can no longer reach Codex.
          const late = yield* harness.runtime
            .respondToRuntimeRequest(
              kind === "question"
                ? { requestId: card.id, answers: { branch: "main" } }
                : { requestId: card.id, decision: "accept" },
            )
            .pipe(Effect.flip);
          assert.include(JSON.stringify(late), `No pending Codex runtime request ${card.id}.`);
        }).pipe(
          Effect.scoped,
          Effect.provide(
            Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
          ),
        ),
    );

    // Codex finishes a turn without the answer to a non-blocking question (isBlocking: false), and the
    // transcript cancels the question's card with the turn.
    it.effect("answers a non-blocking question left open when its turn completes, so its handler ends with the turn", () =>
      Effect.gen(function* () {
        const transcript = makeCodexReplayTranscript({
          scenario: "non-blocking-question-left-open-completed",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt }),
            {
              type: "emit_inbound",
              label: "non-blocking question 70",
              frame: {
                id: 70,
                method: kinds.question.method,
                params: { ...kinds.question.params(nativeTurnId, nativeThreadId), isBlocking: false },
              },
            },
            turnEnded(nativeTurnId, "completed"),
            {
              type: "expect_outbound",
              label: "question 70 answered with the turn",
              frame: { id: 70, result: kinds.question.cancelled },
            },
          ],
        });
        const { shown, onEvent } = yield* collectRequests;
        const harness = yield* makeCodexReplayHarness(transcript, onEvent);
        yield* harness.runtime.startTurn(yield* turnInput(harness, "non-blocking-question"));
        const card = yield* Queue.take(shown);
        yield* harness.awaitTerminal(1);

        assert.deepEqual(yield* harness.replayProgress, {
          cursor: transcript.entries.length,
          failure: null,
        });
        const late = yield* harness.runtime
          .respondToRuntimeRequest({ requestId: card.id, answers: { branch: "main" } })
          .pipe(Effect.flip);
        assert.include(JSON.stringify(late), `No pending Codex runtime request ${card.id}.`);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );

    it.effect("an approval still reaches the person after 32 earlier ones were left open by Stop", () =>
      Effect.gen(function* () {
        // codex-app-server serves at most 32 requests at once (protocol.ts MAX_BUFFERED_RAW_MESSAGES).
        const stoppedTurns = 32;
        const supervised = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          ...CODEX_TEST_RUNTIME_POLICY,
          runtimeMode: "approval-required",
        });
        const turnId = (index: number) => `request-turn-${index}`;
        const text = (index: number) => `Build round ${index + 1}.`;
        const turnStart = (index: number): Array<CodexReplay.CodexAppServerReplayEntry> => [
          {
            type: "expect_outbound",
            label: `turn ${index} turn/start`,
            frame: {
              id: 3 + 2 * index,
              method: "turn/start",
              params: {
                threadId: nativeThreadId,
                input: [{ type: "text", text: text(index) }],
                cwd: "/workspace",
                model: "gpt-5.4",
                approvalPolicy: "untrusted",
                approvalsReviewer: "user",
                sandboxPolicy: { type: "readOnly" },
                summary: "detailed",
                collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
              },
            },
          },
          {
            type: "emit_inbound",
            label: `turn ${index} turn/start`,
            frame: {
              id: 3 + 2 * index,
              result: { turn: makeCodexReplayTurn({ id: turnId(index), status: "inProgress" }) },
            },
          },
          {
            type: "emit_inbound",
            label: `turn ${index} turn/started`,
            frame: {
              method: "turn/started",
              params: {
                threadId: nativeThreadId,
                turn: makeCodexReplayTurn({ id: turnId(index), status: "inProgress" }),
              },
            },
          },
          request("command", 1000 + index, turnId(index)),
        ];
        const transcript = makeCodexReplayTranscript({
          scenario: "requests-left-open-by-stop",
          entries: [
            ...codexReplayPreamble({ nativeThreadId, nativeTurnId: "unused", prompt }).slice(0, -3),
            ...Array.from({ length: stoppedTurns }, (_, index) => [
              ...turnStart(index),
              ...stopEntries(4 + 2 * index, turnId(index)),
              {
                type: "expect_outbound" as const,
                label: `turn ${index} approval cancelled`,
                frame: { id: 1000 + index, result: { decision: "cancel" } },
              },
            ]).flat(),
            ...turnStart(stoppedTurns),
            {
              type: "expect_outbound",
              label: "the last approval answered",
              frame: { id: 1000 + stoppedTurns, result: { decision: "accept" } },
            },
            turnEnded(turnId(stoppedTurns), "completed"),
          ],
        });
        const { shown, onEvent } = yield* collectRequests;
        const harness = yield* makeCodexReplayHarness(transcript, onEvent);
        for (let index = 0; index < stoppedTurns; index++) {
          yield* harness.runtime.startTurn({
            ...(yield* turnInput(harness, `left-open-${index}`, text(index))),
            runOrdinal: index + 1,
            providerTurnOrdinal: index + 1,
            runtimePolicy: supervised,
          });
          const card = yield* Queue.take(shown);
          yield* harness.runtime.interruptTurn({
            providerThread: harness.providerThread,
            providerTurnId: card.providerTurnId!,
            requestRuntimeRestart: true,
          });
          yield* harness.awaitTerminal(index + 1);
        }
        yield* harness.runtime.startTurn({
          ...(yield* turnInput(harness, "answered", text(stoppedTurns))),
          runOrdinal: stoppedTurns + 1,
          providerTurnOrdinal: stoppedTurns + 1,
          runtimePolicy: supervised,
        });
        const last = yield* Queue.take(shown);
        yield* harness.runtime.respondToRuntimeRequest({ requestId: last.id, decision: "accept" });

        assert.deepEqual(yield* harness.replayProgress, {
          cursor: transcript.entries.length,
          failure: null,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer, NodeCrypto.layer),
        ),
      ),
    );
  });
});
