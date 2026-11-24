// Idle compaction decides from a read outside the thread lock. A message the person sends
// between that read and the /compact dispatch must keep the thread out of compaction.
import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  ClaudeSettings,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@caveman-app/protocol";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { checkpointWorkspace } from "@caveman-app/engine-testing/replayWorkspace";

import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeAdapterV2 from "./Adapters/ClaudeAdapterV2.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const sessionId = "idle-compaction-session";
const settings = Schema.decodeSync(ClaudeSettings)({});
const modelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

function frame(value: unknown): SDKMessage {
  return value as SDKMessage;
}

// A long context (over the 200K floor) whose request wrote a 5m prompt cache.
const usage = {
  input_tokens: 10,
  cache_creation_input_tokens: 5_000,
  cache_read_input_tokens: 240_000,
  cache_creation: { ephemeral_5m_input_tokens: 5_000, ephemeral_1h_input_tokens: 0 },
  output_tokens: 100,
};

const messageStart = (id: string) =>
  frame({
    type: "stream_event",
    uuid: `start-${id}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    event: {
      type: "message_start",
      message: {
        id,
        role: "assistant",
        type: "message",
        model: modelSelection.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    },
  });

const assistant = (id: string, text: string) =>
  frame({
    type: "assistant",
    uuid: `assistant-${id}`,
    session_id: sessionId,
    parent_tool_use_id: null,
    message: {
      id,
      role: "assistant",
      type: "message",
      model: modelSelection.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    },
  });

const result = (uuid: string) =>
  frame({
    type: "result",
    subtype: "success",
    uuid,
    session_id: sessionId,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: "end_turn",
    terminal_reason: "completed",
    permission_denials: [],
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
  });

const offeredText = (message: SDKUserMessage) => {
  const content = message.message.content;
  return typeof content === "string"
    ? content
    : content.map((block) => (block.type === "text" ? block.text : "")).join("");
};

it.effect.each([
  { followUp: false, case: "compacts an idle thread before its prompt cache expires" },
  {
    followUp: true,
    case: "does not compact a thread the person wrote to after the idle check, not even after their turn",
  },
])("$case", ({ followUp }) =>
  Effect.scoped(
    Effect.gen(function* () {
      const cwd = yield* checkpointWorkspace("idle-compaction");
      const sdkMessages = yield* Queue.unbounded<SDKMessage>();
      const offers: SDKUserMessage[] = [];
      const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
        instanceId: modelSelection.instanceId,
        settings,
        environment: {},
        attachmentsDir: cwd,
        fileSystem: yield* FileSystem.FileSystem,
        path: yield* Path.Path,
        random: yield* SecureRandom.SecureRandom,
        idAllocator: yield* IdAllocator.IdAllocatorV2,
        queryRunner: {
          allocateSessionId: Effect.succeed(sessionId),
          open: () =>
            Effect.succeed({
              messages: Stream.fromQueue(sdkMessages),
              offer: (message) => Effect.sync(() => void offers.push(message)),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Effect.void,
            }),
          forkSession: () => Effect.die("unused"),
          subagentLaunchToolUseId: () => Effect.succeed(null),
          assertComplete: Effect.void,
        },
      });
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:idle-compaction");
        const projectId = ProjectId.make("project:idle-compaction");
        const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
          orchestrator.streamDomainEvents.pipe(
            Stream.filter(predicate),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );

        // The person's next message, committed once the service has read the
        // window and before its /compact dispatch takes the thread lock.
        let armed = false;
        let injected = false;
        const serviceDispatched = yield* Deferred.make<void>();
        const userFollowUp = orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("follow-up"),
          threadId,
          messageId: MessageId.make("follow-up"),
          text: "Now add the tests.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });

        // The real service on the real orchestrator and projections; the read
        // only gets a tap that places the person's commit right after it.
        const service = yield* IdleCompactionService.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(Orchestrator.OrchestratorV2, {
                ...orchestrator,
                dispatch: (command) =>
                  orchestrator
                    .dispatch(command)
                    .pipe(Effect.ensuring(Deferred.succeed(serviceDispatched, undefined))),
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: (id) =>
                  orchestrator.getThreadProjection(id).pipe(
                    Effect.map((projection) => projection.thread),
                    Effect.orDie,
                  ),
                getThreadRecords: ((id, fields, filter) =>
                  orchestrator.getThreadRecords(id, fields, filter).pipe(
                    Effect.tap(() =>
                      followUp && armed && !injected
                        ? Effect.sync(() => {
                            injected = true;
                          }).pipe(Effect.andThen(userFollowUp))
                        : Effect.void,
                    ),
                    Effect.orDie,
                  )) as ProjectionStore.ProjectionStoreV2["Service"]["getThreadRecords"],
              }),
              ServerSettings.layerTest({ compactIdleThreads: "beforeCacheExpires" }).pipe(
                Layer.orDie,
              ),
            ),
          ),
        );
        yield* service.start();
        for (let index = 0; index < 20; index++) yield* Effect.yieldNow;

        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId,
          title: "Idle compaction",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: cwd,
          createdBy: "user",
          creationSource: "web",
        });

        // Run N: a long-context turn that wrote a 5m prompt cache.
        const firstRunning = yield* watch(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("first"),
          threadId,
          messageId: MessageId.make("first"),
          text: "Refactor the parser.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* worker.drain();
        yield* Fiber.join(firstRunning);
        const firstRunId = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!.id;
        const firstCompleted = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === firstRunId &&
            event.payload.status === "completed",
        );
        const firstWaiting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === firstRunId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(sdkMessages, messageStart("msg-1"));
        yield* Queue.offer(sdkMessages, assistant("msg-1", "Done."));
        yield* Queue.offer(sdkMessages, result("result-1"));
        yield* Fiber.join(firstWaiting);
        for (let index = 0; index < 5; index++) yield* worker.drain();
        yield* Fiber.join(firstCompleted);
        for (let index = 0; index < 50; index++) yield* Effect.yieldNow;

        // Precondition: the thread is idle and its window is armed for run N.
        const idle = yield* orchestrator.getThreadProjection(threadId);
        assert.deepStrictEqual(
          idle.runs.map((run) => run.status),
          ["completed"],
        );
        assert.ok(
          (idle.providerTurns.at(-1)?.tokenUsage?.promptCacheExpiresAt ?? "") !== "",
          "run N reported when its prompt cache expires",
        );

        // The timer wakes at window.startMs (3 minutes into the 5m cache).
        armed = true;
        yield* TestClock.adjust("3 minutes");
        yield* Deferred.await(serviceDispatched);
        assert.equal(injected, followUp);

        const compactMessageId = `idle-compact:${threadId}:${firstRunId}`;
        const compactRunAfterDispatch = (yield* orchestrator.getThreadProjection(
          threadId,
        )).runs.find((run) => run.userMessageId === compactMessageId);
        if (!followUp) {
          yield* worker.drain();
          for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
          assert.deepStrictEqual(
            {
              compactRunStatusWhenDispatched: compactRunAfterDispatch?.status,
              textsSentToClaude: offers.map(offeredText),
            },
            {
              compactRunStatusWhenDispatched: "starting",
              textsSentToClaude: ["Refactor the parser.", "/compact"],
            },
          );
          return;
        }

        // The person's turn N+1 runs and ends.
        yield* worker.drain();
        const followUpRunId = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.userMessageId === "follow-up",
        )!.id;
        const followUpCompleted = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === followUpRunId &&
            event.payload.status === "completed",
        );
        const followUpWaiting = yield* watch(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === followUpRunId &&
            event.payload.status === "waiting",
        );
        yield* Queue.offer(sdkMessages, messageStart("msg-2"));
        yield* Queue.offer(sdkMessages, assistant("msg-2", "Tests added."));
        yield* Queue.offer(sdkMessages, result("result-2"));
        yield* Fiber.join(followUpWaiting);
        for (let index = 0; index < 5; index++) yield* worker.drain();
        yield* Fiber.join(followUpCompleted);
        for (let index = 0; index < 50; index++) yield* Effect.yieldNow;
        for (let index = 0; index < 5; index++) yield* worker.drain();
        for (let index = 0; index < 50; index++) yield* Effect.yieldNow;

        const after = yield* orchestrator.getThreadProjection(threadId);
        const compactRunAfterUserTurn = after.runs.find(
          (run) => run.userMessageId === compactMessageId,
        );

        // The thread stopped being idle before /compact took the lock, so
        // nothing is compacted: not queued, and not after the person's turn.
        assert.deepStrictEqual(
          {
            compactRunStatusWhenDispatched: compactRunAfterDispatch?.status,
            compactRunStatusAfterUserTurn: compactRunAfterUserTurn?.status,
            textsSentToClaude: offers.map(offeredText),
          },
          {
            compactRunStatusWhenDispatched: undefined,
            compactRunStatusAfterUserTurn: undefined,
            textsSentToClaude: ["Refactor the parser.", "Now add the tests."],
          },
        );
      }).pipe(
        Effect.provide(
          ProviderReplayHarness.layerWithRegistry(
            { name: "idle-compaction" },
            ProviderAdapterRegistry.layerSingle(adapter),
            { runEffectWorker: false },
          ),
        ),
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
