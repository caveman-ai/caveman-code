import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import {
  cavemanHarnessRoot,
  readCavemanRun,
  writeCavemanRun,
} from "@caveman-app/provider-caveman/server";
import { writeHarnessCheckpoint } from "@caveman-app/provider-caveman/testing";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";

// Production projections, deletion planner, SQLite outbox, effect executor and filesystem cleanup, over journals the
// engine's own DiskDurableStore wrote. No provider session runs: deleting a chat only touches files.
const database = SqlitePersistence.layerMemory;
const config = ServerConfig.layerTest(process.cwd(), { prefix: "caveman-journal-cleanup-" }).pipe(
  Layer.provide(NodeServices.layer),
);
const layerTest = (storage: "sqlite" | "memory") => {
  const projections = (
    storage === "sqlite" ? ProjectionStoreWithV1.layer : ProjectionStore.layerMemory
  ).pipe(Layer.provide(Layer.merge(database, config)));
  const cleanup = ResourceCleanupService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        config,
        projections,
        NodeServices.layer,
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          deleteForThread: () => Effect.void,
        }),
      ),
    ),
  );
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        cleanup,
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
        Layer.mock(RunFinalizationService.RunFinalizationService)({}),
        Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
        Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
        Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
        Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagementService.ThreadManagementService)({}),
        ServerSettings.layerTest(),
      ),
    ),
  );
  return Layer.mergeAll(
    database,
    config,
    IdAllocator.layer,
    projections,
    EffectOutbox.layer.pipe(Layer.provide(database)),
    executor,
  );
};

const CAVEMAN = ProviderDriverKind.make("caveman");
const instanceId = ProviderInstanceId.make("caveman");
const modelSelection = { instanceId, model: "auto" };
/** The adapter's ids: a native thread, and a run journaled on it (adapter.ts registerThread, startTurn). */
const nativeThread = () => `cvm-${randomUUID().replaceAll("-", "")}`;
const runOn = (native: string) => `${native}-${randomUUID().slice(0, 12)}`;

const harness = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const sql = yield* SqlClient.SqlClient;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const now = yield* DateTime.now;
  let events = 0;
  const ref = (nativeId: string) => ({ driver: CAVEMAN, nativeId, strength: "strong" as const });
  const thread = (threadId: ThreadId, forkOf?: ThreadId): OrchestrationV2AppThread => ({
    id: threadId,
    projectId: ProjectId.make("caveman-journal-project"),
    title: threadId,
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: ProviderThreadId.make(`provider-thread:${threadId}`),
    lineage:
      forkOf === undefined
        ? { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId }
        : { parentThreadId: forkOf, relationshipToParent: "fork", rootThreadId: forkOf },
    forkedFrom:
      forkOf === undefined
        ? null
        : { type: "run", threadId: forkOf, runId: RunId.make(`run:${forkOf}`) },
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  });
  /** A Caveman chat whose provider thread runs on `native`, its conversation at `head`. */
  const chat = Effect.fn(function* (
    threadId: ThreadId,
    native: string,
    head: string | null,
    forkOf?: ThreadId,
  ) {
    yield* store.apply({
      id: EventId.make(`create:${threadId}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread(threadId, forkOf),
    });
    yield* moveHead(threadId, native, head);
  });
  const moveHead = (threadId: ThreadId, native: string, head: string | null) =>
    store.apply({
      id: EventId.make(`provider-thread:${threadId}:${events++}`),
      type: "provider-thread.updated",
      threadId,
      driver: CAVEMAN,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: {
        id: ProviderThreadId.make(`provider-thread:${threadId}`),
        driver: CAVEMAN,
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: ref(native),
        nativeConversationHeadRef: head === null ? null : ref(head),
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
      },
    });
  const forkTransfer = (threadId: ThreadId, source: ThreadId, consumedOn?: string) => ({
    id: ContextTransferId.make(`transfer:${threadId}`),
    type: "fork" as const,
    sourceThreadId: source,
    targetThreadId: threadId,
    sourcePoint: { threadId: source, runId: RunId.make(`run:${source}`) },
    basePoint: null,
    sourceProviderInstanceId: instanceId,
    targetProviderInstanceId: consumedOn === undefined ? null : instanceId,
    targetRunId: consumedOn === undefined ? null : RunId.make(`run:${threadId}`),
    status: consumedOn === undefined ? ("pending" as const) : ("consumed" as const),
    resolution:
      consumedOn === undefined
        ? null
        : { strategy: "native_fork" as const, providerThreadRef: ref(consumedOn) },
    createdBy: "user" as const,
    error: null,
    createdAt: now,
    updatedAt: now,
    consumedAt: consumedOn === undefined ? null : now,
  });
  /** A fork made from `source` that has not run its first turn: that turn reads its conversation from the source. */
  const pendingFork = Effect.fn(function* (threadId: ThreadId, source: ThreadId) {
    yield* store.apply({
      id: EventId.make(`create:${threadId}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: thread(threadId, source),
    });
    yield* store.apply({
      id: EventId.make(`transfer:${threadId}:${events++}`),
      type: "context-transfer.created",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: forkTransfer(threadId, source),
    });
  });
  /** The fork's first turn forked the source's conversation onto `native` (ProviderTurnStartService). */
  const forkStarted = (threadId: ThreadId, source: ThreadId, native: string) =>
    store.apply({
      id: EventId.make(`transfer:${threadId}:${events++}`),
      type: "context-transfer.updated",
      threadId,
      providerInstanceId: instanceId,
      occurredAt: now,
      payload: forkTransfer(threadId, source, native),
    });
  /**
   * A run as the engine journals it: `run_started` and `run_completed` each checkpoint the conversation; and, as a
   * harness run, its checkpoint file (adapter.ts harnessDir).
   */
  const harnessFileOf = (runId: string) => path.join(cavemanHarnessRoot(stateDir), `${runId}.json`);
  const journal = (runId: string) =>
    Effect.promise(async () => {
      await writeCavemanRun(stateDir, runId, [
        JSON.stringify({ type: "run_started", runId, checkpoint: { messages: ["..."] } }),
        JSON.stringify({ type: "run_completed", runId, checkpoint: { messages: ["...", "..."] } }),
      ]);
      await writeHarnessCheckpoint(cavemanHarnessRoot(stateDir), {
        runId,
        model: "test/model",
        loadout: "",
        messages: [
          { role: "user", content: "...", timestamp: 0 },
          { role: "user", content: "...", timestamp: 1 },
        ],
      });
    });
  const sessionStartOf = (native: string) =>
    path.join(stateDir, "caveman", "session-start", native);
  const keepSessionStart = (native: string) =>
    Effect.sync(() => {
      fs.mkdirSync(path.dirname(sessionStartOf(native)), { recursive: true });
      fs.writeFileSync(sessionStartOf(native), "what the SessionStart hooks printed");
    });
  /** Whether the run's journal and its harness checkpoint are both here; one without the other fails the test. */
  const journaled = (runId: string) =>
    Effect.promise(() => readCavemanRun(stateDir, runId)).pipe(
      Effect.map((lines) => {
        const checkpoint = fs.existsSync(harnessFileOf(runId));
        assert.strictEqual(
          lines.length > 0,
          checkpoint,
          `run ${runId}: journal and harness checkpoint disagree`,
        );
        return checkpoint;
      }),
    );
  const hasSessionStart = (native: string) =>
    Effect.sync(() => fs.existsSync(sessionStartOf(native)));
  /** Deletes the chat as the Orchestrator does, then runs every effect it enqueued through the production executor. */
  const deleteChat = Effect.fn(function* (threadId: ThreadId) {
    const command = {
      type: "thread.delete" as const,
      commandId: CommandId.make(`delete:${threadId}`),
      threadId,
    };
    const projection = yield* store.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "runtimeRequests",
      "subagents",
      "providerSessions",
    ]);
    const plan = yield* planThreadDeletion({
      command,
      projection,
      attachmentIds: yield* store.getThreadAttachmentIds(threadId),
      now,
      idAllocator,
    });
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const event of plan.events) yield* store.apply(event);
        yield* outbox.enqueue(plan.effects);
      }),
    );
    while (true) {
      const next = yield* outbox.claimNext({
        workerId: "journal-cleanup",
        leaseDurationMs: 60_000,
      });
      if (Option.isNone(next)) break;
      yield* executor.execute(next.value);
      assert.isTrue(
        yield* outbox.succeed({ effectId: next.value.id, workerId: "journal-cleanup" }),
      );
    }
  });
  return {
    chat,
    moveHead,
    pendingFork,
    forkStarted,
    journal,
    keepSessionStart,
    journaled,
    hasSessionStart,
    deleteChat,
  };
});

it.effect.each(["sqlite", "memory"] as const)(
  "deleting a Caveman chat removes the runs it journaled, their harness checkpoints and its SessionStart record, not another chat's (%s)",
  (storage) =>
    Effect.gen(function* () {
      const { chat, journal, keepSessionStart, journaled, hasSessionStart, deleteChat } =
        yield* harness;
      const deleted = ThreadId.make("caveman-deleted");
      const other = ThreadId.make("caveman-other");
      const native = nativeThread();
      const otherNative = nativeThread();
      const runs = [runOn(native), runOn(native), runOn(native)];
      const otherRuns = [runOn(otherNative), runOn(otherNative)];
      // A run no chat here names: a move's copy written before its chat is adopted (handlers.ts adopt).
      const unclaimed = runOn(nativeThread());
      yield* chat(deleted, native, runs[2]!);
      yield* chat(other, otherNative, otherRuns[1]!);
      for (const runId of [...runs, ...otherRuns, unclaimed]) yield* journal(runId);
      yield* keepSessionStart(native);
      yield* keepSessionStart(otherNative);

      yield* deleteChat(deleted);

      for (const runId of runs)
        assert.isFalse(yield* journaled(runId), `the deleted chat's run ${runId} stays on disk`);
      assert.isFalse(
        yield* hasSessionStart(native),
        "the deleted chat's SessionStart record stays on disk",
      );
      for (const runId of [...otherRuns, unclaimed]) assert.isTrue(yield* journaled(runId), runId);
      assert.isTrue(yield* hasSessionStart(otherNative));
    }).pipe(Effect.provide(layerTest(storage))),
);

it.effect.each(["sqlite", "memory"] as const)(
  "a deleted chat's run stays while a live chat continues from it, and goes once none does (%s)",
  (storage) =>
    Effect.gen(function* () {
      const { chat, moveHead, journal, keepSessionStart, journaled, hasSessionStart, deleteChat } =
        yield* harness;
      const source = ThreadId.make("caveman-source");
      const fork = ThreadId.make("caveman-fork");
      const left = ThreadId.make("caveman-left");
      const adopted = ThreadId.make("caveman-adopted");
      const unrelated = ThreadId.make("caveman-unrelated");
      const sourceNative = nativeThread();
      const sourceRuns = [runOn(sourceNative), runOn(sourceNative)];
      const forkNative = nativeThread();
      const leftNative = nativeThread();
      const leftRuns = [runOn(leftNative), runOn(leftNative)];
      const adoptedNative = nativeThread();
      // The source at its second turn; its fork, made at the first, has not journaled a turn of its own (adapter.ts forkThread).
      yield* chat(source, sourceNative, sourceRuns[1]!);
      yield* chat(fork, forkNative, sourceRuns[0]!, source);
      // A chat that came back to this computer: a new thread continues from the old one's head run, then the old
      // thread is deleted (handlers.ts adopt).
      yield* chat(left, leftNative, leftRuns[1]!);
      yield* chat(adopted, adoptedNative, leftRuns[1]!);
      yield* chat(unrelated, nativeThread(), null);
      for (const runId of [...sourceRuns, ...leftRuns]) yield* journal(runId);
      yield* keepSessionStart(sourceNative);
      yield* keepSessionStart(leftNative);

      yield* deleteChat(source);
      yield* deleteChat(left);

      assert.isTrue(
        yield* journaled(sourceRuns[0]!),
        "the fork's conversation starts from the source's first run",
      );
      assert.isFalse(yield* journaled(sourceRuns[1]!));
      assert.isFalse(yield* hasSessionStart(sourceNative));
      assert.isTrue(
        yield* journaled(leftRuns[1]!),
        "the adopted chat's conversation starts from the old thread's head run",
      );
      assert.isFalse(yield* journaled(leftRuns[0]!));
      assert.isFalse(yield* hasSessionStart(leftNative));

      // Each has journaled a turn of its own: nothing reads the deleted chats' runs any more.
      const forkRun = runOn(forkNative);
      const adoptedRun = runOn(adoptedNative);
      yield* journal(forkRun);
      yield* journal(adoptedRun);
      yield* moveHead(fork, forkNative, forkRun);
      yield* moveHead(adopted, adoptedNative, adoptedRun);
      yield* deleteChat(unrelated);

      assert.isFalse(
        yield* journaled(sourceRuns[0]!),
        "the deleted source's run outlives the fork's need of it",
      );
      assert.isFalse(
        yield* journaled(leftRuns[1]!),
        "the deleted thread's head run outlives the adopted chat's need of it",
      );
      assert.isTrue(yield* journaled(forkRun));
      assert.isTrue(yield* journaled(adoptedRun));
    }).pipe(Effect.provide(layerTest(storage))),
);

it.effect.each(["sqlite", "memory"] as const)(
  "a fork that has not run yet keeps its deleted source's engine state until its first turn (%s)",
  (storage) =>
    Effect.gen(function* () {
      const {
        chat,
        moveHead,
        pendingFork,
        forkStarted,
        journal,
        keepSessionStart,
        journaled,
        hasSessionStart,
        deleteChat,
      } = yield* harness;
      const source = ThreadId.make("caveman-pending-source");
      const fork = ThreadId.make("caveman-pending-fork");
      const unrelated = ThreadId.make("caveman-pending-unrelated");
      const sourceNative = nativeThread();
      const sourceRuns = [runOn(sourceNative), runOn(sourceNative)];
      yield* chat(source, sourceNative, sourceRuns[1]!);
      yield* pendingFork(fork, source);
      yield* chat(unrelated, nativeThread(), null);
      for (const runId of sourceRuns) yield* journal(runId);
      yield* keepSessionStart(sourceNative);

      yield* deleteChat(source);

      // Its first turn forks the source's conversation and SessionStart text (adapter.ts forkThread, startSession).
      for (const runId of sourceRuns) assert.isTrue(yield* journaled(runId), runId);
      assert.isTrue(yield* hasSessionStart(sourceNative));

      // The fork's first turn ran on a native thread of its own and journaled its run.
      const forkNative = nativeThread();
      const forkRun = runOn(forkNative);
      yield* forkStarted(fork, source, forkNative);
      yield* journal(forkRun);
      yield* moveHead(fork, forkNative, forkRun);
      yield* deleteChat(unrelated);

      for (const runId of sourceRuns) assert.isFalse(yield* journaled(runId), runId);
      assert.isFalse(yield* hasSessionStart(sourceNative));
      assert.isTrue(yield* journaled(forkRun));
    }).pipe(Effect.provide(layerTest(storage))),
);
