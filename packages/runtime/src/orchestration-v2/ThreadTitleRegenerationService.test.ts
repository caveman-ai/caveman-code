// ), apps/server/src/orchestration-v2/ThreadTitleRegenerationService.test.ts @ ab3a3cd1.
import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  type ChatAttachment,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type ServerProvider,
  ThreadId,
  TextGenerationError,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { projectIdFor } from "./ProjectCommands.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitleRegeneration from "./ThreadTitleRegenerationService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:title-regeneration");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title regeneration tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

function makeHarness(
  options: {
    readonly generateTitle?: TextGeneration.TextGeneration["Service"]["generateThreadTitle"];
    /** The project the harness's threads live in. */
    readonly projectId?: ProjectId;
    /** The providers' snapshots the title's writers are ranked from. */
    readonly providers?: ReadonlyArray<ServerProvider>;
    /** The person's existing topics the writer may reuse (ProjectionStore.getRecentThreadTopics); none when absent. */
    readonly recentTopics?: ReadonlyArray<ProjectionStore.RecentThreadTopic>;
  } = {},
) {
  const providers = options.providers ?? [];
  const harnessProjectId = options.projectId ?? projectId;
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerRegistry = ProviderAdapterRegistry.layerFromAdapters([adapter]);
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-regeneration" },
    layerRegistry,
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
 // The compact account is a configured instance, as on a Mac that added it beside the default Codex one.
  const layerServerSettings = ServerSettings.layerTest({
    providerInstances: {
      [ProviderInstanceId.make("codex-account-chatgpt")]: { driver: ProviderDriverKind.make("codex"), config: {} },
    },
  });
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerOutbox = EffectOutbox.layer.pipe(Layer.provide(layerDatabase));
  const generateThreadTitle = vi.fn(
    options.generateTitle ?? (() => Effect.succeed({ title: "Generated title" })),
  );
  const layerProjectedProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: (requestedProjectId) =>
      Effect.succeed(
        requestedProjectId === harnessProjectId
          ? Option.some({
              projectId: harnessProjectId,
              title: "Project",
              workspaceRoot: "/repo",
              defaultModelSelection: modelSelection,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              pinnedAt: null,
              archivedAt: null,
              createdAt: "2026-06-20T00:00:00.000Z",
              updatedAt: "2026-06-20T00:00:00.000Z",
              deletedAt: null,
            })
          : Option.none(),
      ),
  });
  const layerTitleRegeneration = ThreadTitleRegeneration.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        layerProjectedProjects,
        Layer.mock(TextGeneration.TextGeneration)({ generateThreadTitle }),
        ProviderRegistryMock.instanceRegistryLayer(providers),
        layerServerSettings,
        NodeServices.layer,
        options.recentTopics === undefined
          ? Layer.empty
          : Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecentThreadTopics: () => Effect.succeed(options.recentTopics!),
            }),
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      layerTitleRegeneration,
      layerOutbox,
      layerDatabase,
    ),
    generateThreadTitle,
  };
}

function createThread(input: {
  readonly command: string;
  readonly thread: string;
  readonly projectId?: ProjectId;
  readonly worktreePath?: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(input.thread);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(input.command),
      threadId,
      projectId: input.projectId ?? projectId,
      title: "Seed title",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: input.worktreePath ?? null,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });
}

function dispatchUserMessage(input: {
  readonly command: string;
  readonly threadId: ThreadId;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    yield* threads.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(input.command),
      threadId: input.threadId,
      messageId: MessageId.make(`${input.command}:message`),
      text: input.text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "defer_start" },
      createdBy: "user",
      creationSource: "web",
    });
  });
}

/** Records a settled source run with one exchange, as a provider turn would. */
function recordRun(input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly ordinal: number;
  readonly user: string;
  readonly assistant: string;
  readonly status?: "completed" | "rolled_back";
}) {
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const providerThreadId = ProviderThreadId.make(`${input.threadId}:provider`);
    const message = (role: "user" | "assistant", text: string) => ({
      id: EventId.make(`${input.runId}:${role}`),
      type: "message.updated" as const,
      threadId: input.threadId,
      runId: input.runId,
      occurredAt: now,
      payload: {
        id: MessageId.make(`${input.runId}:${role}`),
        threadId: input.threadId,
        runId: input.runId,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: "user" as const,
        creationSource: "web" as const,
        createdAt: now,
        updatedAt: now,
      },
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${input.runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId: input.runId,
          occurredAt: now,
          payload: {
            id: input.runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`${input.runId}:user`),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.status ?? "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${input.runId}:provider-thread`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: adapter.driver, nativeId: "native", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: input.ordinal,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        message("user", input.user),
        message("assistant", input.assistant),
      ],
    });
  });
}

function armRegeneration(input: { readonly command: string; readonly threadId: ThreadId }) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const requestId = CommandId.make(input.command);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId: input.threadId,
      regenerateTitle: true,
    });
    return requestId;
  });
}

describe("formatThreadTitleContext", () => {
  const attachment = (id: string): ChatAttachment => ({
    type: "image",
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: 1,
  });

  it("builds a newest-first digest, skipping system messages and empty sections", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "First question" },
      { role: "system", text: "Hidden instructions" },
      { role: "assistant", text: "" },
      { role: "assistant", text: "Second answer", attachments: [attachment("shot")] },
    ]);
    assert.equal(
      context.message,
      "USER:\nFirst question\n\nASSISTANT:\nSecond answer\n[Attachments: shot.png]",
    );
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["shot.png"],
    );
  });

  it("pins the first user message ahead of the retained tail once content stops fitting", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Ancient context that anchors the topic ${"x".repeat(600)}` },
      { role: "assistant", text: "y".repeat(6_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nAncient context that anchors the topic"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
    assert.isTrue(context.message.includes("y".repeat(100)));
  });

  it("truncates an oversized pinned first user message", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: `Topic anchor ${"a".repeat(4_000)}` },
      { role: "assistant", text: "y".repeat(9_000) },
      { role: "user", text: "z".repeat(1_500) },
    ]);
    assert.isTrue(context.message.includes("USER:\nTopic anchor"));
    assert.isTrue(context.message.includes("[Content truncated]"));
    assert.isTrue(context.message.includes("[Earlier content truncated]\n\n"));
  });

  it("retains at most four attachments from the newest messages", () => {
    const context = ThreadTitleRegeneration.formatThreadTitleContext([
      { role: "user", text: "older", attachments: [attachment("a"), attachment("b")] },
      {
        role: "user",
        text: "newer",
        attachments: [attachment("c"), attachment("d"), attachment("e")],
      },
    ]);
    assert.deepEqual(
      context.attachments.map((entry) => entry.name),
      ["a.png", "c.png", "d.png", "e.png"],
    );
  });
});

describe("ThreadTitleRegenerationService", () => {
  it.effect("arms and clears the regeneration marker through metadata commands", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threadId = yield* createThread({
          command: "command:title:arm:create",
          thread: "thread:title:arm",
        });

        const firstRequest = yield* armRegeneration({ command: "command:title:arm:1", threadId });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.titleRegeneration?.requestId, firstRequest);
        assert.deepEqual(
          (yield* outbox.listByCommandId(firstRequest)).map((effect) => effect.request),
          [{ type: "thread-title.generate", kind: { type: "regenerate" } }],
        );

        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:abandon"),
          threadId,
          regenerateTitle: false,
        });
        const abandoned = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(abandoned.thread.titleRegeneration);

        yield* armRegeneration({ command: "command:title:arm:2", threadId });
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:title:arm:rename"),
          threadId,
          title: "Manual title",
        });
        const renamed = yield* threads.getThreadProjection(threadId);
        assert.equal(renamed.thread.title, "Manual title");
        assert.isNotOk(renamed.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("skips execution when the marker was superseded by a newer request", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:stale:create",
          thread: "thread:title:stale",
        });
        const staleRequest = yield* armRegeneration({ command: "command:title:stale:1", threadId });
        const currentRequest = yield* armRegeneration({
          command: "command:title:stale:2",
          threadId,
        });

        yield* titleRegeneration.execute({
          threadId,
          requestId: staleRequest,
          kind: { type: "regenerate" },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.equal(projection.thread.titleRegeneration?.requestId, currentRequest);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

 // Ours: the default Codex instance holds no login while a compact account beside it does; the title goes there.
  const codexProvider = (instanceId: string, auth: ServerProvider["auth"]) =>
    ({
      instanceId: ProviderInstanceId.make(instanceId),
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      status: "ready",
      auth,
      models: [{ slug: "gpt-6-luna", name: "GPT-6 Luna", isCustom: false, capabilities: null }],
    }) as unknown as ServerProvider;
  const signedOutDefault = codexProvider("codex", { status: "unauthenticated" });
  const chatGpt = codexProvider("codex-account-chatgpt", { status: "authenticated", type: "chatgpt" });

  it.effect("writes the title on a signed-in writer when Settings' model has no login", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        providers: [signedOutDefault, chatGpt],
        generateTitle: () => Effect.succeed({ title: "Written by the ChatGPT account" }),
      });
      yield* Effect.gen(function* () {
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({ command: "command:title:writer:create", thread: "thread:title:writer" });
        yield* dispatchUserMessage({ command: "command:title:writer:message", threadId, text: "Fix the flaky login test" });
        const requestId = yield* armRegeneration({ command: "command:title:writer:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.deepEqual(
          harness.generateThreadTitle.mock.calls.map((call) => call[0]?.modelSelection.instanceId),
          [ProviderInstanceId.make("codex-account-chatgpt")],
        );
        assert.equal(harness.generateThreadTitle.mock.calls[0]?.[0]?.modelSelection.model, "gpt-6-luna");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("hands the title to the next writer when Settings' model fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        providers: [codexProvider("codex", { status: "authenticated", type: "chatgpt" }), chatGpt],
        generateTitle: (input) =>
          input.modelSelection.instanceId === modelSelection.instanceId
            ? Effect.fail(new TextGenerationError({ operation: "generateThreadTitle", detail: "rate limited" }))
            : Effect.succeed({ title: "From the next writer" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({ command: "command:title:next:create", thread: "thread:title:next" });
        yield* dispatchUserMessage({ command: "command:title:next:message", threadId, text: "Fix the flaky login test" });
        const requestId = yield* armRegeneration({ command: "command:title:next:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.deepEqual(
          harness.generateThreadTitle.mock.calls.map((call) => call[0]?.modelSelection.instanceId),
          [ProviderInstanceId.make("codex"), ProviderInstanceId.make("codex-account-chatgpt")],
        );
        assert.equal((yield* threads.getThreadProjection(threadId)).thread.title, "From the next writer");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("lands the regenerated title from the conversation digest", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Fresh title" }),
      });
      const fs = yield* FileSystem.FileSystem;
      const existingWorktree = yield* fs.makeTempDirectoryScoped({ prefix: "title-worktree-" });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        // Storage cleanup can remove a worktree and keep its path on the thread.
        const cases = [
          { name: "removed", worktreePath: "/repo-worktrees/removed-by-cleanup", cwd: "/repo" },
          { name: "existing", worktreePath: existingWorktree, cwd: existingWorktree },
        ];
        for (const [index, testCase] of cases.entries()) {
          const threadId = yield* createThread({
            command: `command:title:landing:${testCase.name}:create`,
            thread: `thread:title:landing:${testCase.name}`,
            worktreePath: testCase.worktreePath,
          });
          yield* dispatchUserMessage({
            command: `command:title:landing:${testCase.name}:message`,
            threadId,
            text: "Investigate the flaky login test",
          });
          const requestId = yield* armRegeneration({
            command: `command:title:landing:${testCase.name}:1`,
            threadId,
          });

          yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

          const call = harness.generateThreadTitle.mock.calls[index]?.[0];
          assert.equal(call?.previousTitle, "Seed title");
          assert.equal(call?.cwd, testCase.cwd);
          assert.include(call?.message, "USER:\nInvestigate the flaky login test");
          const projection = yield* threads.getThreadProjection(threadId);
          assert.equal(projection.thread.title, "Fresh title");
          assert.isNotOk(projection.thread.titleRegeneration);
        }
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Ours: a Caveman Code chat's first message carries notes the runtime added; its title comes from what the person wrote.
  it.effect("titles a Caveman Code chat from the person's own words", () =>
    Effect.gen(function* () {
      const ours = projectIdFor("/repo");
      const harness = makeHarness({ projectId: ours, generateTitle: () => Effect.succeed({ title: "Parser Crash on Empty Input" }) });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({ command: "command:title:caveman:create", thread: "caveman:title", projectId: ours });
        const requestId = CommandId.make("command:title:caveman:message");
        const messageId = MessageId.make("command:title:caveman:message:message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: requestId,
          threadId,
          messageId,
          text: "## Memory notes\nprefers pnpm\n\nthe parser crashes when the input is empty",
          titleSeed: "the parser crashes when the input is empty",
          titleSource: "the parser crashes when the input is empty",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });
        const armed = yield* threads.getThreadProjection(threadId);
        assert.equal(armed.thread.title, "the parser crashes when the input is empty");
        assert.equal(armed.thread.titleRegeneration?.requestId, requestId);
        const kind = (yield* outbox.listByCommandId(requestId))
          .map((effect) => effect.request)
          .find((request) => request.type === "thread-title.generate")?.kind;
        assert.deepEqual(kind, { type: "initial", messageId, text: "the parser crashes when the input is empty" });

        yield* titleRegeneration.execute({ threadId, requestId, kind: kind! });

        assert.equal(harness.generateThreadTitle.mock.calls[0]?.[0]?.message, "the parser crashes when the input is empty");
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Parser Crash on Empty Input");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when generation returns the fallback", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "New thread" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:fallback:create",
          thread: "thread:title:fallback",
        });
        yield* dispatchUserMessage({
          command: "command:title:fallback:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:fallback:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the current title when regeneration reproduces it", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.succeed({ title: "Seed title" }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:unchanged:create",
          thread: "thread:title:unchanged",
        });
        yield* dispatchUserMessage({
          command: "command:title:unchanged:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({
          command: "command:title:unchanged:1",
          threadId,
        });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("names the topic with the title once, and never over one it named or the person's own", () =>
    Effect.gen(function* () {
      let topic = "Login Flow";
      const harness = makeHarness({
        // The same title each time: a regeneration that keeps the title still brings its topic.
        generateTitle: () => Effect.succeed({ title: "Seed title", topic }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({ command: "command:title:topic:create", thread: "thread:title:topic" });
        yield* dispatchUserMessage({ command: "command:title:topic:message", threadId, text: "Review the login change" });

        const first = yield* armRegeneration({ command: "command:title:topic:1", threadId });
        yield* titleRegeneration.execute({ threadId, requestId: first, kind: { type: "regenerate" } });
        assert.deepEqual((yield* threads.getThreadProjection(threadId)).thread.topic, { name: "Login Flow", by: "title" });

        // A later regeneration (an agent can ask for one) keeps the topic it named: the chat stays in its group.
        topic = "Sign In";
        const again = yield* armRegeneration({ command: "command:title:topic:again", threadId });
        yield* titleRegeneration.execute({ threadId, requestId: again, kind: { type: "regenerate" } });
        assert.deepEqual((yield* threads.getThreadProjection(threadId)).thread.topic, { name: "Login Flow", by: "title" });

        // Dragged out of every group: it stays loose, whatever the writer says next.
        yield* threads.dispatch({ type: "thread.metadata.update", commandId: CommandId.make("command:title:topic:pick"), threadId, topic: null });
        topic = "Auth";
        const second = yield* armRegeneration({ command: "command:title:topic:2", threadId });
        yield* titleRegeneration.execute({ threadId, requestId: second, kind: { type: "regenerate" } });
        assert.deepEqual((yield* threads.getThreadProjection(threadId)).thread.topic, { name: null, by: "person" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("gives a new topic the writer's emoji, and an existing topic its own", () =>
    Effect.gen(function* () {
      let result: { title: string; topic?: string; icon?: string } = { title: "Seed title", topic: "Sidebar Grouping", icon: "🗂️" };
      const harness = makeHarness({
        generateTitle: () => Effect.succeed(result),
        recentTopics: [{ name: "Sidebar Grouping", icon: "🧭" }, { name: "Relay Reliability" }],
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const topicOf = (threadId: ThreadId) => threads.getThreadProjection(threadId).pipe(Effect.map((p) => p.thread.topic));
        const titled = (thread: string) =>
          Effect.gen(function* () {
            const threadId = yield* createThread({ command: `command:${thread}:create`, thread });
            yield* dispatchUserMessage({ command: `command:${thread}:message`, threadId, text: "Group the sidebar" });
            const requestId = yield* armRegeneration({ command: `command:${thread}:title`, threadId });
            yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });
            return threadId;
          });

        // An existing topic keeps its group's emoji, whatever the writer picked.
        assert.deepEqual(yield* topicOf(yield* titled("thread:icon:existing")), { name: "Sidebar Grouping", by: "title", icon: "🧭" });
        // An existing topic with no emoji stays without one.
        result = { title: "Seed title", topic: "Relay Reliability", icon: "📡" };
        assert.deepEqual(yield* topicOf(yield* titled("thread:icon:bare")), { name: "Relay Reliability", by: "title" });
        // A new topic takes the writer's.
        result = { title: "Seed title", topic: "Billing Redesign", icon: "💸" };
        const fresh = yield* titled("thread:icon:new");
        assert.deepEqual(yield* topicOf(fresh), { name: "Billing Redesign", by: "title", icon: "💸" });

        // Never on its own: a later writer's emoji leaves the topic it named, and its emoji, as they are.
        result = { title: "Seed title", topic: "Billing Redesign", icon: "🪙" };
        const again = yield* armRegeneration({ command: "command:thread:icon:new:again", threadId: fresh });
        yield* titleRegeneration.execute({ threadId: fresh, requestId: again, kind: { type: "regenerate" } });
        assert.deepEqual(yield* topicOf(fresh), { name: "Billing Redesign", by: "title", icon: "💸" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("keeps the person's emoji while the topic's name stays, and drops it under a new name", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread({ command: "command:person-icon:create", thread: "thread:person-icon" });
        let n = 0;
        const set = (topic: string | null, topicIcon?: string | null) =>
          threads.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make(`command:person-icon:${n++}`),
            threadId,
            topic,
            ...(topicIcon === undefined ? {} : { topicIcon }),
          });
        const topic = () => threads.getThreadProjection(threadId).pipe(Effect.map((p) => p.thread.topic));

        yield* set("Sidebar Grouping", "🧭");
        assert.deepEqual(yield* topic(), { name: "Sidebar Grouping", by: "person", icon: "🧭" });
        // The same name with no emoji given keeps it.
        yield* set("Sidebar Grouping");
        assert.deepEqual(yield* topic(), { name: "Sidebar Grouping", by: "person", icon: "🧭" });
        // Another emoji replaces it.
        yield* set("Sidebar Grouping", "🗂️");
        assert.deepEqual(yield* topic(), { name: "Sidebar Grouping", by: "person", icon: "🗂️" });
        // A new name with no emoji given has none.
        yield* set("Sidebar Layout");
        assert.deepEqual(yield* topic(), { name: "Sidebar Layout", by: "person" });
        // A new name with its group's emoji takes it.
        yield* set("Sidebar Grouping", "🧭");
        assert.deepEqual(yield* topic(), { name: "Sidebar Grouping", by: "person", icon: "🧭" });
        // Null clears it.
        yield* set("Sidebar Grouping", null);
        assert.deepEqual(yield* topic(), { name: "Sidebar Grouping", by: "person" });
        // Out of every group: no emoji, even one given.
        yield* set(null, "🧭");
        assert.deepEqual(yield* topic(), { name: null, by: "person" });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("titles a fork's first message with the source history up to the fork point", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const sourceThreadId = yield* createThread({
          command: "command:title:fork:create",
          thread: "thread:title:fork:source",
        });
        yield* recordRun({
          threadId: sourceThreadId,
          runId: RunId.make("run:title:fork:0"),
          ordinal: 1,
          user: "Rolled back attempt",
          assistant: "Discarded.",
          status: "rolled_back",
        });
        const forkRunId = RunId.make("run:title:fork:1");
        yield* recordRun({
          threadId: sourceThreadId,
          runId: forkRunId,
          ordinal: 2,
          user: "Move session storage from Redis to Postgres",
          assistant: "Sessions now persist in the Postgres sessions table.",
        });
        yield* recordRun({
          threadId: sourceThreadId,
          runId: RunId.make("run:title:fork:2"),
          ordinal: 3,
          user: "Later work the fork never saw",
          assistant: "Done.",
        });
        const forkThreadId = ThreadId.make("thread:title:fork:target");
        yield* threads.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("command:title:fork:fork"),
          sourceThreadId,
          targetThreadId: forkThreadId,
          sourcePoint: { type: "run", runId: forkRunId },
          createdBy: "user",
          creationSource: "web",
        });
        const requestId = CommandId.make("command:title:fork:message");
        const messageId = MessageId.make("command:title:fork:message:message");
        yield* threads.dispatch({
          type: "message.dispatch",
          commandId: requestId,
          threadId: forkThreadId,
          messageId,
          text: "Try SQLite instead",
          titleSeed: "Try SQLite instead",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "defer_start" },
          createdBy: "user",
          creationSource: "web",
        });

        yield* titleRegeneration.execute({
          threadId: forkThreadId,
          requestId,
          kind: { type: "initial", messageId },
        });

        const call = harness.generateThreadTitle.mock.calls[0]?.[0];
        assert.equal(call?.message, "Try SQLite instead");
        assert.equal(call?.forkSource?.title, "Seed title");
        assert.include(call?.forkSource?.history, "Move session storage from Redis to Postgres");
        assert.include(call?.forkSource?.history, "Sessions now persist in the Postgres");
        assert.notInclude(call?.forkSource?.history, "Later work the fork never saw");
        assert.notInclude(call?.forkSource?.history, "Rolled back attempt");
        const fork = yield* threads.getThreadProjection(forkThreadId);
        assert.equal(fork.thread.title, "Generated title");
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("clears the marker and keeps the title when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        generateTitle: () => Effect.die(new Error("model unavailable")),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:failure:create",
          thread: "thread:title:failure",
        });
        yield* dispatchUserMessage({
          command: "command:title:failure:message",
          threadId,
          text: "Some conversation",
        });
        const requestId = yield* armRegeneration({ command: "command:title:failure:1", threadId });

        yield* titleRegeneration.execute({ threadId, requestId, kind: { type: "regenerate" } });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("completes without generating when the initial message is unavailable", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const titleRegeneration = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: "command:title:missing:create",
          thread: "thread:title:missing",
        });
        const requestId = yield* armRegeneration({ command: "command:title:missing:1", threadId });

        yield* titleRegeneration.execute({
          threadId,
          requestId,
          kind: { type: "initial", messageId: MessageId.make("message:title:missing") },
        });

        assert.equal(harness.generateThreadTitle.mock.calls.length, 0);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(projection.thread.title, "Seed title");
        assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});

it.effect.each(["success", "exhausted", "stale", "interrupted"] as const)(
  "initial title retry: %s",
  (outcome) =>
    Effect.gen(function* () {
      const attempted = yield* Deferred.make<void>();
      let attempts = 0;
      const harness = makeHarness({
        generateTitle: () =>
          Effect.gen(function* () {
            attempts += 1;
            yield* Deferred.succeed(attempted, undefined);
            if (outcome === "success" && attempts === 3) return { title: "Recovered title" };
            return yield* new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Temporary failure",
            });
          }),
      });
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* ThreadTitleRegeneration.ThreadTitleRegenerationService;
        const threadId = yield* createThread({
          command: `create:${outcome}`,
          thread: `thread:${outcome}`,
        });
        const messageCommand = `message:${outcome}`;
        yield* dispatchUserMessage({ command: messageCommand, threadId, text: "Fix the title" });
        const requestId = yield* armRegeneration({ command: `title:${outcome}`, threadId });
        const fiber = yield* service
          .execute({
            threadId,
            requestId,
            kind: { type: "initial", messageId: MessageId.make(`${messageCommand}:message`) },
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(attempted);
        if (outcome === "interrupted") {
          yield* Fiber.interrupt(fiber);
        } else {
          if (outcome === "stale")
            yield* threads.dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make("manual-title"),
              threadId,
              title: "Manual title",
            });
          yield* TestClock.adjust("2 seconds");
          if (outcome !== "stale") yield* TestClock.adjust("4 seconds");
          yield* Fiber.join(fiber);
        }
        assert.equal(attempts, outcome === "success" || outcome === "exhausted" ? 3 : 1);
        const projection = yield* threads.getThreadProjection(threadId);
        assert.equal(
          projection.thread.title,
          outcome === "success"
            ? "Recovered title"
            : outcome === "stale"
              ? "Manual title"
              : "Seed title",
        );
        if (outcome === "interrupted")
          assert.equal(projection.thread.titleRegeneration?.requestId, requestId);
        else assert.isNotOk(projection.thread.titleRegeneration);
      }).pipe(Effect.provide(harness.layer));
    }),
);
