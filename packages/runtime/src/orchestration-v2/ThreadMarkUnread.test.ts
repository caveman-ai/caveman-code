import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStoreWithV1.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "thread-mark-unread" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const send = (threadId: ThreadId, text: string, type: "start_immediately" | "queue_after_active") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type },
      createdBy: "user",
      creationSource: "web",
    });
  });

it.effect("Mark unread on a chat stopped with a message queued marks the stopped run unread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:mark-unread-held-queue");
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:mark-unread"),
      title: "Held queue",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* send(threadId, "active", "start_immediately");
    yield* send(threadId, "follow-up", "queue_after_active");
    const startedAt = yield* DateTime.now;
    const [first] = (yield* orchestrator.getThreadProjection(threadId)).runs;
    yield* projections.apply({
      id: EventId.make("event:mark-unread-held-queue:started"),
      type: "run.updated",
      threadId,
      runId: first!.id,
      occurredAt: startedAt,
      payload: { ...first!, status: "running", startedAt },
    });
    yield* TestClock.adjust("1 second");
    // Stop ends run 1 and holds run 2 in the queue, which is now the highest-ordinal run.
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:mark-unread-held-queue"),
      threadId,
    });
    const stopped = yield* orchestrator.getThreadProjection(threadId);
    assert.deepEqual(
      stopped.runs.map((run) => `${run.status}${run.queueHeld === true ? ":held" : ""}`),
      ["interrupted", "queued:held"],
    );
    const ended = stopped.runs[0]!;

    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.mark-unread",
      commandId: CommandId.make("mark-unread:held-queue"),
      threadId,
    });

    const after = yield* orchestrator.getThreadProjection(threadId);
    assert.equal(
      DateTime.toEpochMillis(after.thread.lastVisitedAt!),
      DateTime.toEpochMillis(ended.completedAt!) - 1,
    );
  }).pipe(Effect.provide(layerTest.pipe(Layer.provideMerge(TestClock.layer())))),
);
