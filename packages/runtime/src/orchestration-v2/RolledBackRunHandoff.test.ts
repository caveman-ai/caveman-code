import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RunId,
  ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process: the effect worker is off"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStoreWithV1.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "rolled-back-run-handoff" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

const UNDONE = "APPROACH-A-UNDONE";

const harness = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  let seq = 0;
  const nextId = (label: string) => `${label}:${++seq}`;

  const createThread = (threadId: ThreadId) =>
    orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(nextId("create")),
      threadId,
      projectId: ProjectId.make("project:rolled-back-run-handoff"),
      title: "Thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

  const sendMessage = (threadId: ThreadId, text: string) =>
    Effect.gen(function* () {
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(nextId("send")),
        threadId,
        messageId: MessageId.make(nextId("message")),
        text,
        attachments: [],
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      return (yield* projections.getThreadProjection(threadId)).runs.at(-1)!;
    });

  // What the provider ingestor records when a turn finishes: a reply, a file
  // edit, and the run and its attempt completed with a checkpoint. A restart
  // cuts a turn as cancelled instead.
  const finishRun = (
    run: OrchestrationV2Run,
    reply: string,
    fileName: string,
    ended: "completed" | "cancelled" = "completed",
  ) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const attempt = (yield* projections.getThreadProjection(run.threadId)).attempts.find(
        (candidate) => candidate.id === run.activeAttemptId,
      )!;
      const item = (suffix: string, ordinal: number) => ({
        id: TurnItemId.make(`${run.id}:${suffix}`),
        threadId: run.threadId,
        runId: run.id,
        nodeId: run.rootNodeId,
        providerThreadId: run.providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: run.ordinal * 100 + ordinal,
        status: "completed" as const,
        title: null,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const events: Array<OrchestrationV2DomainEvent> = [
        {
          id: EventId.make(nextId("event")),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...item("assistant", 50),
            type: "assistant_message",
            messageId: MessageId.make(`${run.id}:assistant`),
            text: reply,
            streaming: false,
          },
        },
        {
          id: EventId.make(nextId("event")),
          type: "turn-item.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...item("edit", 40), type: "file_change", fileName },
        },
        {
          id: EventId.make(nextId("event")),
          type: "run-attempt.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: { ...attempt, status: ended, startedAt: now, completedAt: now },
        },
        {
          id: EventId.make(nextId("event")),
          type: "run.updated",
          threadId: run.threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...run,
            status: ended,
            startedAt: now,
            completedAt: now,
            checkpointId: CheckpointId.make(`${run.id}:checkpoint`),
          },
        },
      ];
      yield* eventSink.write({ events });
    });

  // The run.updated CheckpointRollbackService.execute writes, in one write, for
  // each run after the rollback target. The runs' turn items stay in the store.
  const rollBack = (threadId: ThreadId, runIds: ReadonlyArray<RunId>) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const { runs } = yield* projections.getThreadProjection(threadId);
      yield* eventSink.write({
        events: yield* Effect.forEach(runIds, (runId) =>
          Effect.sync(() => {
            const run = runs.find((candidate) => candidate.id === runId)!;
            return {
              id: EventId.make(nextId("event")),
              type: "run.updated" as const,
              threadId,
              runId,
              occurredAt: now,
              payload: { ...run, status: "rolled_back" as const, completedAt: now },
            };
          }),
        ),
      });
    });

  // Keep approach B, undo approach A between them.
  const runApproaches = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const kept = yield* sendMessage(threadId, "Add the tokenizer tests");
      yield* finishRun(kept, "Tokenizer tests added", "src/tokenizer.test.ts");
      const undone = yield* sendMessage(threadId, `Try ${UNDONE}: a regex-table parser`);
      yield* finishRun(undone, `${UNDONE} done: regex-table parser written`, "src/regex-table.ts");
      yield* rollBack(threadId, [undone.id]);
      const next = yield* sendMessage(threadId, "Try approach B: a hand-written parser");
      yield* finishRun(next, "Approach B done: hand-written parser", "src/hand-parser.ts");
      assert.deepEqual(
        (yield* projections.getThreadProjection(threadId)).runs.map((run) => run.status),
        ["completed", "rolled_back", "completed"],
      );
    });

  const handoffFor = (threadId: ThreadId, run: OrchestrationV2Run) =>
    Effect.gen(function* () {
      const handoff = (yield* projections.getThreadProjection(threadId)).contextHandoffs.find(
        (candidate) => candidate.id === run.contextHandoffId,
      );
      assert.isDefined(handoff, `run ${run.id} carries a context handoff`);
      return handoff!;
    });

  return {
    orchestrator,
    createThread,
    sendMessage,
    finishRun,
    rollBack,
    runApproaches,
    handoffFor,
    nextId,
  };
});

const historyText = (handoff: OrchestrationV2ContextHandoff) =>
  (handoff.history?.messages ?? []).map((message) => message.text).join("\n");

describe("a context handoff leaves out runs the person rolled back", () => {
  it.effect("merging a fork back does not tell the parent about an undone fork run", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const parentId = ThreadId.make("thread:rolled-back-merge-parent");
      const forkId = ThreadId.make("thread:rolled-back-merge-fork");
      yield* h.createThread(parentId);
      const parentRun = yield* h.sendMessage(parentId, "Set up the parser module");
      yield* h.finishRun(parentRun, "Parser module set up", "src/parser.ts");
      yield* h.orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(h.nextId("fork")),
        sourceThreadId: parentId,
        targetThreadId: forkId,
        sourcePoint: { type: "run", runId: parentRun.id },
        title: "Fork",
        createdBy: "user",
        creationSource: "web",
      });
      yield* h.runApproaches(forkId);

      yield* h.orchestrator.dispatch({
        type: "thread.merge_back",
        commandId: CommandId.make(h.nextId("merge")),
        sourceThreadId: forkId,
        targetThreadId: parentId,
        sourcePoint: { type: "latest_stable" },
        createdBy: "user",
        creationSource: "web",
      });
      const handoff = yield* h.handoffFor(
        parentId,
        yield* h.sendMessage(parentId, "Carry on from what the fork did"),
      );

      assert.equal(handoff.strategy, "fork_delta_summary");
      assert.include(historyText(handoff), "Tokenizer tests added");
      assert.include(historyText(handoff), "Approach B done");
      assert.include(handoff.summaryText, "Approach B done");
      assert.notInclude(historyText(handoff), UNDONE);
      assert.notInclude(handoff.summaryText, UNDONE);
      assert.notInclude(handoff.summaryText, "src/regex-table.ts");
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("a portable fork does not replay an undone run of its source", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const sourceId = ThreadId.make("thread:rolled-back-portable-source");
      const forkId = ThreadId.make("thread:rolled-back-portable-fork");
      yield* h.createThread(sourceId);
      yield* h.runApproaches(sourceId);

      yield* h.orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(h.nextId("fork")),
        sourceThreadId: sourceId,
        targetThreadId: forkId,
        sourcePoint: { type: "latest_stable" },
        title: "Fork",
        createdBy: "user",
        creationSource: "web",
      });
      const handoff = yield* h.handoffFor(
        forkId,
        yield* h.sendMessage(forkId, "Continue in the fork"),
      );

      assert.include(historyText(handoff), "Tokenizer tests added");
      assert.include(historyText(handoff), "Approach B done");
      assert.notInclude(historyText(handoff), UNDONE);
      assert.notInclude(handoff.summaryText, UNDONE);
    }).pipe(Effect.provide(layerTest)),
  );

  // The fork's workspace and transcript keep what its source had when the fork was made.
  it.effect("a portable fork replays runs its source rolled back only after the fork", () =>
    Effect.gen(function* () {
      const h = yield* harness;
      const sourceId = ThreadId.make("thread:rolled-back-after-fork-source");
      const forkId = ThreadId.make("thread:rolled-back-after-fork-fork");
      yield* h.createThread(sourceId);
      const kept = yield* h.sendMessage(sourceId, "Add the tokenizer tests");
      yield* h.finishRun(kept, "Tokenizer tests added", "src/tokenizer.test.ts");
      const lexer = yield* h.sendMessage(sourceId, "Write the lexer");
      yield* h.finishRun(lexer, "Lexer written", "src/lexer.ts");
      const parser = yield* h.sendMessage(sourceId, "Write the parser");
      yield* h.finishRun(parser, "Parser written", "src/parser.ts");
      const cut = yield* h.sendMessage(sourceId, "Write the docs");
      yield* h.finishRun(cut, "Docs half written", "docs/parser.md", "cancelled");
      const anchor = yield* h.sendMessage(sourceId, "Wire up the CLI");
      yield* h.finishRun(anchor, "CLI wired up", "src/cli.ts");
      yield* h.orchestrator.dispatch({
        type: "thread.fork",
        commandId: CommandId.make(h.nextId("fork")),
        sourceThreadId: sourceId,
        targetThreadId: forkId,
        sourcePoint: { type: "run", runId: anchor.id },
        title: "Fork",
        createdBy: "user",
        creationSource: "web",
      });
      // The source is then restored to its first run.
      yield* h.rollBack(sourceId, [lexer.id, parser.id, cut.id, anchor.id]);
      const transcript = (yield* h.orchestrator.getThreadProjection(
        forkId,
      )).visibleTurnItems.flatMap((row) =>
        row.item.type === "assistant_message" ? [row.item.text] : [],
      );
      assert.deepEqual(transcript, [
        "Tokenizer tests added",
        "Lexer written",
        "Parser written",
        "Docs half written",
        "CLI wired up",
      ]);

      const handoff = yield* h.handoffFor(
        forkId,
        yield* h.sendMessage(forkId, "Continue in the fork"),
      );

      for (const reply of [
        "Tokenizer tests added",
        "Lexer written",
        "Parser written",
        "CLI wired up",
      ])
        assert.include(historyText(handoff), reply);
      // A cut turn is never replayed as conversation, rolled back or not.
      assert.notInclude(historyText(handoff), "Docs half written");
      // Nor are the replayed runs labelled undone: their edits are on the fork's disk.
      assert.deepEqual(
        [...new Set((handoff.history?.messages ?? []).map((message) => message.runStatus))],
        ["completed"],
      );
    }).pipe(Effect.provide(layerTest)),
  );
});
