// ), apps/server/src/orchestration-v2/ProjectionStore.test.ts @ ab3a3cd1; perf from c7f8404d2e, ddafde5e9a.
import { assert, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  CommandId,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  ContextTransferId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ThreadShellSnapshot,
  type OrchestrationV2TurnItem,
  NodeId,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type ThreadPullRequestLink,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import { projectThreadAwarenessV2 } from "@caveman-app/shared/agentAwareness";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import {
  buildBoundedThreadProjection,
  decodeThreadHistoryCursor,
  selectHistoryPageFromCursor,
  THREAD_HISTORY_PAGE_POLICY,
  THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
} from "./threadHistoryPaging.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";

import { layerReaderDatabase, traceSqlRouting } from "../persistence/testkit/SqliteRouting.ts";

const layerTest = Layer.mergeAll(
  ProjectionStoreWithV1.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstanceId = modelSelection.instanceId;
const encodeUnknownJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const traceSqlStatements = () => {
  const statements: Array<string> = [];
  const queryTransactions: Array<string | null> = [];
  const tracer = Tracer.make({
    span(options) {
      const span = new Tracer.NativeSpan(options);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const query = span.attributes.get("db.query.text");
        if (typeof query === "string") {
          statements.push(query);
          let parent = Option.getOrUndefined(span.parent);
          while (parent?._tag === "Span" && parent.name !== "sql.transaction") {
            parent = Option.getOrUndefined(parent.parent);
          }
          queryTransactions.push(parent?._tag === "Span" ? parent.spanId : null);
        }
      };
      return span;
    },
  });
  return { statements, tracer, queryTransactions };
};

const addRolledBackRecoveryCandidate = Effect.fn("addRolledBackRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:rolled-back`);
  const runId = RunId.make(`run:${suffix}:rolled-back`);
  const rootNodeId = NodeId.make(`node:${suffix}:rolled-back`);
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message:${suffix}:rolled-back`),
    rootNodeId,
    activeAttemptId: null,
    status: "running" as const,
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Rolled-back recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-created`),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: run,
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:rolled-back`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "abandoned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:run-rolled-back`),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: { ...run, status: "rolled_back", completedAt: now },
  });

  return threadId;
});

// .
it.effect("idle compaction filters keep the latest run, live work and the newest usage", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    // Its rolled-back run 1 still has a running item, which background work must ignore.
    const threadId = yield* addRolledBackRecoveryCandidate("idle-compaction");
    const now = yield* DateTime.now;
    const minutes = (count: number) => DateTime.add(now, { minutes: count });
    const selected = ProviderThreadId.make("provider-thread:idle-selected");
    const nodeId = NodeId.make("node:idle-compaction");
    for (const [ordinal, status] of [
      [2, "completed"],
      [3, "completed"],
      [4, "failed"],
      // A removed or steered queued message.
      [5, "cancelled"],
    ] as const) {
      const runId = RunId.make(`run:idle-compaction:${ordinal}`);
      yield* store.apply({
        id: EventId.make(`event:idle-compaction:run-${ordinal}`),
        type: "run.created",
        threadId,
        runId,
        nodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId,
          modelSelection,
          providerThreadId: selected,
          userMessageId: MessageId.make(`message:idle-compaction:${ordinal}`),
          rootNodeId: nodeId,
          activeAttemptId: null,
          status,
          requestedAt: now,
          startedAt: status === "cancelled" ? null : now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
    }
    for (const [id, providerThreadId, ordinal, usageAt] of [
      ["turn:idle-old", selected, 1, minutes(1)],
      ["turn:idle-newest", selected, 2, minutes(3)],
      ["turn:idle-later-ordinal", selected, 3, minutes(2)],
      ["turn:idle-no-usage", selected, 4, null],
      [
        "turn:idle-other-thread",
        ProviderThreadId.make("provider-thread:idle-other"),
        1,
        minutes(9),
      ],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:${id}`),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(id),
          providerThreadId,
          nodeId,
          runAttemptId: null,
          nativeTurnRef: null,
          ordinal,
          status: "completed",
          startedAt: now,
          completedAt: now,
          ...(usageAt === null
            ? {}
            : { tokenUsage: { usedTokens: 150_000, updatedAt: DateTime.formatIso(usageAt) } }),
        },
      });
    }
    for (const status of ["pending", "resolved"] as const) {
      yield* store.apply({
        id: EventId.make(`event:idle-compaction:request-${status}`),
        type: "runtime-request.updated",
        threadId,
        nodeId,
        occurredAt: now,
        payload: {
          id: RuntimeRequestId.make(`request:idle-compaction:${status}`),
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status,
          responseCapability: { type: "message" },
          createdAt: now,
          resolvedAt: status === "pending" ? null : now,
        },
      });
    }
    for (const status of ["pending", "consumed"] as const) {
      yield* store.apply({
        id: EventId.make(`event:idle-compaction:transfer-${status}`),
        type: "context-transfer.created",
        threadId,
        occurredAt: now,
        payload: {
          id: ContextTransferId.make(`transfer:idle-compaction:${status}`),
          type: "merge_back",
          sourceThreadId: ThreadId.make("thread:idle-compaction:side"),
          targetThreadId: threadId,
          sourcePoint: { threadId: ThreadId.make("thread:idle-compaction:side") },
          basePoint: null,
          sourceProviderInstanceId: providerInstanceId,
          targetProviderInstanceId: providerInstanceId,
          targetRunId: null,
          status,
          resolution: null,
          createdBy: "user",
          error: null,
          createdAt: now,
          updatedAt: now,
          consumedAt: status === "pending" ? null : now,
        },
      });
    }

    const records = yield* store.getThreadRecords(
      threadId,
      ["runs", "providerTurns", "runtimeRequests", "contextTransfers"],
      {
        runStatuses: ["preparing", "starting", "running", "rolled_back"],
        includeLatestRun: true,
        providerTurnThreadIds: [selected],
        latestProviderTurnUsageOnly: true,
        runtimeRequestStatuses: ["pending"],
        contextTransferStatuses: ["pending"],
      },
    );
    // The failed latest run stays, so a completed earlier run is not mistaken for the latest,
    // and a cancelled queued run never counts as the latest.
    assert.deepEqual(
      records.runs.map((run) => run.id),
      ["run:idle-compaction:rolled-back", "run:idle-compaction:4"],
    );
    assert.deepEqual(
      records.providerTurns.map((turn) => turn.id),
      ["turn:idle-newest"],
    );
    assert.deepEqual(
      records.runtimeRequests.map((request) => request.id),
      ["request:idle-compaction:pending"],
    );
    assert.deepEqual(
      records.contextTransfers.map((transfer) => transfer.id),
      ["transfer:idle-compaction:pending"],
    );
    const empty = yield* store.getThreadRecords(threadId, ["runs", "providerTurns"], {
      runStatuses: [],
      providerTurnThreadIds: [],
      latestProviderTurnUsageOnly: true,
    });
    assert.deepEqual([empty.runs, empty.providerTurns], [[], []]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("routes full projection reads to readers and retains uncommitted writer state", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const parentId = yield* addRolledBackRecoveryCandidate("reader-routing");
    const parent = yield* store.getThreadProjection(parentId);
    const threadId = ThreadId.make("thread:reader-routing:fork");
    yield* store.apply({
      id: EventId.make("event:reader-routing:fork"),
      type: "thread.created",
      threadId,
      occurredAt: parent.thread.createdAt,
      payload: {
        ...parent.thread,
        id: threadId,
        forkedFrom: { type: "run", threadId: parentId, runId: parent.runs[0]!.id },
      },
    });
    const messageId = MessageId.make("message:reader-routing");
    yield* store.apply({
      id: EventId.make("event:reader-routing:message"),
      type: "message.updated",
      threadId,
      occurredAt: parent.thread.createdAt,
      payload: {
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: "user",
        text: "Committed message",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: parent.thread.createdAt,
        updatedAt: parent.thread.createdAt,
      },
    });
    const { queries, trace } = traceSqlRouting();
    const projection = yield* store.getThreadProjection(threadId).pipe(trace);
    assert.equal(projection.thread.id, threadId);
    assert.deepEqual(
      projection.visibleTurnItems
        .filter((row) => row.visibility === "inherited")
        .map((row) => row.sourceItemId),
      parent.turnItems.map((item) => item.id),
    );
    assert.equal(
      (yield* store.getMessagesById(threadId, [messageId]).pipe(trace)).get(messageId)?.text,
      "Committed message",
    );
    assert.isAbove(queries.length, 1);
    assert.deepEqual([...new Set(queries.map((row) => row.connection))], ["reader"]);
    const commitRequested = yield* Deferred.make<void>();
    const writer = yield* Deferred.await(commitRequested).pipe(
      Effect.andThen(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
          UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, '$.title', 'Committed title')
          WHERE thread_id = ${threadId}
        `;
            yield* sql`
          UPDATE orchestration_v2_projection_turn_items
          SET payload_json = json_set(payload_json, '$.title', 'Committed command')
          WHERE thread_id = ${parentId}
        `;
          }),
        ),
      ),
      Effect.forkChild,
    );
    let commitInjected = false;
    const duringCommit = yield* store.getThreadProjection(threadId).pipe(
      Effect.provideService(Statement.CurrentTransformer, (statement) => {
        const [query] = statement.compile();
        if (!commitInjected && query.includes("FROM orchestration_v2_projection_turn_items")) {
          commitInjected = true;
          return Deferred.succeed(commitRequested, undefined).pipe(
            Effect.andThen(Fiber.join(writer).pipe(Effect.orDie)),
            Effect.as(statement),
          );
        }
        return Effect.succeed(statement);
      }),
    );
    assert.isTrue(commitInjected);
    assert.deepEqual(duringCommit, projection);
    const afterCommit = yield* store.getThreadProjection(threadId);
    assert.equal(afterCommit.thread.title, "Committed title");
    assert.equal(
      afterCommit.visibleTurnItems.find((row) => row.visibility === "inherited")?.item.title,
      "Committed command",
    );
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.title', 'Uncommitted title')
        WHERE thread_id = ${threadId}
      `;
        yield* sql`
          UPDATE orchestration_v2_projection_messages
          SET payload_json = json_set(payload_json, '$.text', 'Uncommitted message')
          WHERE message_id = ${messageId}
        `;
        assert.equal(
          (yield* store.getMessagesById(threadId, [messageId])).get(messageId)?.text,
          "Uncommitted message",
        );
        assert.equal(
          (yield* store.getThreadProjection(threadId)).thread.title,
          "Uncommitted title",
        );
      }),
    );
  }).pipe(Effect.provide(ProjectionStoreWithV1.layer.pipe(Layer.provideMerge(layerReaderDatabase)))),
);


it.effect("record reads restrict provider histories to delivery identities", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("delivery-identities");
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    for (const suffix of ["selected", "history"]) {
      const id = ProviderThreadId.make(`provider-thread:${suffix}`);
      yield* store.apply({
        id: EventId.make(`event:delivery-identities:${suffix}`),
        type: "provider-thread.updated",
        threadId,
        occurredAt: now,
        payload: {
          id,
          appThreadId: threadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          lastRunOrdinal: null,
          handoffIds: [],
          forkedFrom: null,
          status: "active",
          firstRunOrdinal: 1,
          createdAt: now,
          updatedAt: now,
        },
      });
    }
    for (const [suffix, attempt] of [
      ["selected", "current"],
      ["history", "old"],
      ["runless", null],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:delivery-turn:${suffix}`),
        type: "provider-turn.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: ProviderTurnId.make(`turn:${suffix}`),
          providerThreadId: ProviderThreadId.make("provider-thread:selected"),
          nodeId: NodeId.make("node:delivery"),
          runAttemptId: attempt === null ? null : RunAttemptId.make(attempt),
          nativeTurnRef: null,
          ordinal: suffix === "selected" ? 1 : suffix === "history" ? 2 : 3,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
    }
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [RunAttemptId.make("current")],
      })).providerTurns.map((turn) => turn.id),
      ["turn:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerTurns"], {
        providerTurnAttemptIds: [],
      })).providerTurns,
      [],
    );
    const selected = yield* store.getThreadRecords(threadId, ["providerThreads"], {
      providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
    });
    assert.deepEqual(
      selected.providerThreads.map((row) => row.id),
      ["provider-thread:selected"],
    );
    assert.deepEqual(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [],
      })).providerThreads,
      [],
    );
    // Unselected history must not be decoded, even if its payload is unreadable.
    yield* sql`UPDATE orchestration_v2_projection_provider_threads SET payload_json = '{}'
      WHERE provider_thread_id = 'provider-thread:history'`;
    assert.lengthOf(
      (yield* store.getThreadRecords(threadId, ["providerThreads"], {
        providerThreadIds: [ProviderThreadId.make("provider-thread:selected")],
      })).providerThreads,
      1,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)("%s queue readiness skips held runs without bypassing active work", ([, layer]) =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("held-queue");
    const { runs } = yield* store.getThreadProjection(threadId);
    const run = runs[0]!;
    const now = yield* DateTime.now;
    const held = { ...run, status: "queued" as const, queueHeld: true };
    yield* store.apply({
      id: EventId.make("held-queue:held"),
      type: "run.updated",
      threadId,
      occurredAt: now,
      payload: held,
    });
    assert.isFalse(yield* store.canStartQueuedRun(threadId));

    const wake = { ...run, id: RunId.make("held-queue:wake"), ordinal: 2 };
    for (const status of ["running", "queued", "completed"] as const) {
      yield* store.apply({
        id: EventId.make(`held-queue:wake:${status}`),
        type: "run.updated",
        threadId,
        occurredAt: now,
        payload: { ...wake, status },
      });
      assert.equal(yield* store.canStartQueuedRun(threadId), status === "queued");
    }
    assert.deepEqual((yield* store.getThreadProjection(threadId)).runs[0], held);
  }).pipe(Effect.provide(layer)),
);

it.effect.each([
  ["memory", ProjectionStore.layerMemory],
  ["SQL", layerTest],
] as const)(
  "%s shells use the latest subagent owner for duplicate provider-thread ids",
  ([, layer]) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("duplicate-provider-thread-owner");
      const initial = yield* store.getThreadProjection(threadId);
      const at = initial.updatedAt;
      const otherThreadId = yield* addRolledBackRecoveryCandidate(
        "duplicate-provider-thread-owner:other",
      );
      const other = yield* store.getThreadProjection(otherThreadId);
      const otherRun = other.runs[0]!;
      const otherInstanceId = ProviderInstanceId.make("codex-other");
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-completed"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "completed", completedAt: at },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-switched"),
        type: "thread.provider-switched",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...other.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      const providerThreadId = ProviderThreadId.make("provider-thread:duplicate-owner");
      const nativeTaskId = "native-task:duplicate-provider-thread-owner";
      // The latest upsert moves the row off the later-created thread.
      for (const [appThreadId, owner] of [
        [otherThreadId, otherInstanceId],
        [threadId, providerInstanceId],
      ] as const) {
        yield* store.apply({
          id: EventId.make(`event:duplicate-provider-thread-owner:${owner}`),
          type: "provider-thread.updated",
          threadId: appThreadId,
          occurredAt: at,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId: owner,
            providerSessionId: null,
            appThreadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: at,
            updatedAt: at,
            pendingBackgroundTasks:
              owner === otherInstanceId
                ? [{ taskId: nativeTaskId, kind: "subagent", description: "Review" }]
                : [],
          },
        });
      }
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:completed"),
        type: "run.updated",
        threadId,
        occurredAt: at,
        payload: { ...initial.runs[0]!, status: "completed", completedAt: at },
      });
      const item = {
        ...initial.turnItems[0]!,
        id: TurnItemId.make("item:duplicate-provider-thread-owner"),
        providerThreadId,
        nativeItemRef: { driver, nativeId: nativeTaskId, strength: "strong" as const },
        type: "subagent" as const,
        status: "running" as const,
        subagentId: NodeId.make("node:duplicate-provider-thread-owner"),
        origin: "provider_native" as const,
        driver,
        providerInstanceId,
        childThreadId: null,
        title: "Review",
        prompt: "Review",
        result: null,
      };
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:item"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: item,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-item"),
        type: "turn-item.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: {
          ...item,
          id: TurnItemId.make("item:duplicate-provider-thread-owner:other"),
          threadId: otherThreadId,
          runId: otherRun.id,
          nodeId: otherRun.rootNodeId,
          subagentId: NodeId.make("node:duplicate-provider-thread-owner:other"),
        },
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:switched"),
        type: "thread.provider-switched",
        threadId,
        occurredAt: at,
        payload: {
          ...initial.thread,
          providerInstanceId: otherInstanceId,
          modelSelection: { ...modelSelection, instanceId: otherInstanceId },
        },
      });
      // The other thread's item reads its owner from a provider thread stored on another thread.
      assert.deepEqual((yield* store.getThreadProjection(otherThreadId)).providerThreads, []);
      const assertOwners = Effect.fnUntraced(function* (
        targetThreadId: ThreadId,
        expected: ReadonlyArray<unknown>,
      ) {
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (thread) => thread.id === targetThreadId,
        );
        for (const shell of [yield* store.getThreadShell(targetThreadId), listed]) {
          assert.equal(shell?.providerInstanceId, otherInstanceId);
          assert.equal(shell?.activeRunId, null);
          assert.deepEqual(
            shell?.pendingBackgroundTasks?.filter((task) => task.kind === "subagent"),
            expected,
          );
        }
      });
      const owned = [
        { taskId: nativeTaskId, description: item.title, kind: "subagent", providerInstanceId },
      ];
      yield* assertOwners(threadId, owned);
      yield* assertOwners(otherThreadId, owned);
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:stopped"),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload: { ...item, status: "cancelled", completedAt: at },
      });
      yield* assertOwners(threadId, []);
      const ownerSnapshot = (yield* store.getThreadProjection(threadId)).providerThreads[0]!;
      // Rollback writes its provider snapshot before the rolled-back run events.
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:rollback-provider-thread"),
        type: "provider-thread.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: ownerSnapshot,
      });
      yield* store.apply({
        id: EventId.make("event:duplicate-provider-thread-owner:other-rolled-back"),
        type: "run.updated",
        threadId: otherThreadId,
        occurredAt: at,
        payload: { ...otherRun, status: "rolled_back", completedAt: at },
      });
      const rolledBack = yield* store.getThreadProjection(otherThreadId);
      assert.deepEqual(rolledBack.providerThreads, []);
      assert.equal(
        (yield* store.getThreadProjection(threadId)).thread.activeProviderThreadId,
        providerThreadId,
      );
      assert.deepEqual(
        ProjectionStore.threadShellFromProjection(rolledBack).pendingBackgroundTasks,
        [],
      );
    }).pipe(Effect.provide(layer)),
);

const addOrphanedRecoveryCandidate = Effect.fn("addOrphanedRecoveryCandidate")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make(`thread:${suffix}:orphaned`);
  const runId = RunId.make(`run:${suffix}:missing`);
  const rootNodeId = NodeId.make(`node:${suffix}:orphaned`);

  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:thread-created`),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make(`project:${suffix}`),
      title: "Orphaned recovery candidate",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadId,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:item-running`),
    type: "turn-item.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`item:${suffix}:orphaned`),
      threadId,
      runId,
      nodeId: rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: "orphaned command",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "sleep 60",
    },
  });

  return threadId;
});

it("includes imported runless history when selecting fork context through a run", () => {
  const firstRunId = RunId.make("run:projection-imported-fork:1");
  const secondRunId = RunId.make("run:projection-imported-fork:2");
  const runOrdinalById = new Map([
    [firstRunId, 1],
    [secondRunId, 2],
  ]);

  assert.isTrue(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: undefined,
      itemRunId: null,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isTrue(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: firstRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
  assert.isFalse(
    ProjectionStore.isTurnItemAtOrBeforeRun({
      historyOrigin: "v1_import",
      itemRunId: secondRunId,
      runOrdinalById,
      sourceRunOrdinal: 1,
    }),
  );
});

// Recovery records the work, then a run.updated snapshot taken before it lands.
const restartCancelledWorkSurvivesStaleRunUpdate = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work-stale-update");
  const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const now = yield* DateTime.now;
  const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:recorded"),
    type: "run.background-work-cancelled",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { runId: run.id, restartCancelledBackgroundWork: work },
  });
  yield* store.apply({
    id: EventId.make("event:restart-cancelled-work-stale-update:completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    providerInstanceId,
    occurredAt: now,
    payload: { ...run, status: "completed", completedAt: now },
  });
  const updated = (yield* store.getThreadProjection(threadId)).runs[0];
  assert.equal(updated?.status, "completed");
  assert.deepEqual(updated?.restartCancelledBackgroundWork, work);
});

const threadWorktreePathsIncludeArchivedOnRequest = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (id: string, input: { worktreePath: string | null; archived?: boolean }) => {
    const threadId = ThreadId.make(id);
    const thread = {
      createdBy: "user" as const,
      creationSource: "web" as const,
      id: threadId,
      projectId: ProjectId.make("project:worktree-paths"),
      title: id,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      branch: input.worktreePath === null ? null : id,
      worktreePath: input.worktreePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: input.archived === true ? now : null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return store
      .apply({
        id: EventId.make(`event:${id}:created`),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      })
      .pipe(Effect.as(thread));
  };
  yield* create("thread:active", { worktreePath: "/worktrees/active" });
  yield* create("thread:archived", { worktreePath: "/worktrees/archived", archived: true });
  yield* create("thread:local", { worktreePath: null });
  const deleted = yield* create("thread:deleted", { worktreePath: "/worktrees/deleted" });
  yield* store.apply({
    id: EventId.make("event:thread:deleted:deleted"),
    type: "thread.deleted",
    threadId: deleted.id,
    occurredAt: now,
    payload: { ...deleted, deletedAt: now },
  });

  assert.deepEqual(yield* store.getThreadWorktreePaths(), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
  ]);
  assert.deepEqual(yield* store.getThreadWorktreePaths({ includeArchived: true }), [
    { threadId: ThreadId.make("thread:active"), worktreePath: "/worktrees/active" },
    { threadId: ThreadId.make("thread:archived"), worktreePath: "/worktrees/archived" },
  ]);
});

const recentThreadTopicsCarryTheirLatestEmoji = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const create = (
    id: string,
    input: { topic: { name: string; icon?: string }; minutesAgo: number; archived?: boolean },
  ) => {
    const threadId = ThreadId.make(id);
    const at = DateTime.subtract(now, { minutes: input.minutesAgo });
    return store.apply({
      id: EventId.make(`event:${id}:created`),
      type: "thread.created",
      threadId,
      occurredAt: at,
      payload: {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:recent-topics"),
        title: id,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        topic: { ...input.topic, by: "title" as const },
        createdAt: at,
        updatedAt: at,
        archivedAt: input.archived === true ? at : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  };
  yield* create("thread:topic:latest-bare", { topic: { name: "Sidebar Grouping" }, minutesAgo: 0 });
  yield* create("thread:topic:marked", { topic: { name: "Sidebar Grouping", icon: "🧭" }, minutesAgo: 3 });
  yield* create("thread:topic:older-mark", { topic: { name: "Sidebar Grouping", icon: "🗂️" }, minutesAgo: 5 });
  yield* create("thread:topic:unmarked", { topic: { name: "Relay Reliability" }, minutesAgo: 1 });
  yield* create("thread:topic:archived", { topic: { name: "Billing Redesign", icon: "💸" }, minutesAgo: 0, archived: true });

  // Most recently active first; each with the emoji of its most recently active thread that has one.
  assert.deepEqual(yield* store.getRecentThreadTopics(10), [
    { name: "Sidebar Grouping", icon: "🧭" },
    { name: "Relay Reliability" },
  ]);
  assert.deepEqual(yield* store.getRecentThreadTopics(1), [{ name: "Sidebar Grouping", icon: "🧭" }]);
});

const commandReadsSkipSettledLeafNodes = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const threadId = yield* addRolledBackRecoveryCandidate("settled-leaf-nodes");
  const settledRun = (yield* store.getThreadProjection(threadId)).runs[0]!;
  const activeRun = {
    ...settledRun,
    id: RunId.make("run:settled-leaf-nodes:active"),
    ordinal: 2,
    userMessageId: MessageId.make("message:settled-leaf-nodes:active"),
    rootNodeId: NodeId.make("node:settled-leaf-nodes:active-root"),
    status: "running" as const,
    completedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:settled-leaf-nodes:active-run"),
    type: "run.created",
    threadId,
    runId: activeRun.id,
    nodeId: activeRun.rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: activeRun,
  });
  const nodes = [
    ["settled-root", settledRun, "root_turn", "completed"],
    ["settled-tool", settledRun, "tool_call", "completed"],
    ["settled-message", settledRun, "assistant_message", "failed"],
    ["settled-reasoning", settledRun, "reasoning", "cancelled"],
    ["settled-subagent", settledRun, "subagent", "completed"],
    ["settled-run-live-tool", settledRun, "tool_call", "running"],
    ["active-run-done-tool", activeRun, "tool_call", "completed"],
  ] as const;
  for (const [name, run, kind, status] of nodes) {
    const id = NodeId.make(`node:settled-leaf-nodes:${name}`);
    yield* store.apply({
      id: EventId.make(`event:settled-leaf-nodes:${name}`),
      type: "node.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: run.id,
        rootNodeId: kind === "root_turn" ? id : run.rootNodeId!,
        parentNodeId: kind === "root_turn" ? null : run.rootNodeId,
        kind,
        status,
        countsForRun: kind === "root_turn",
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: status === "running" ? null : now,
      },
    });
  }
  const nodeNames = (records: { readonly nodes: ReadonlyArray<{ readonly id: string }> }) =>
    records.nodes
      .map((node) => node.id.replace("node:settled-leaf-nodes:", ""))
      .filter((name) => nodes.some(([candidate]) => candidate === name))
      .toSorted();

  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"], { omitSettledLeafNodes: true })),
    ["active-run-done-tool", "settled-root", "settled-run-live-tool", "settled-subagent"],
  );
  assert.deepEqual(
    nodeNames(yield* store.getThreadRecords(threadId, ["nodes"])),
    nodes.map(([name]) => name).toSorted(),
  );

  const subagents = [
    ["delivered", settledRun, "completed", "delivered"],
    ["acknowledged", settledRun, "failed", "acknowledged"],
    ["disposed", settledRun, "cancelled", "disposed"],
    ["pending-delivery", settledRun, "completed", "pending"],
    ["claimed", settledRun, "completed", "claimed"],
    ["no-delivery", settledRun, "interrupted", null],
    ["running", settledRun, "running", null],
    ["active-run-delivered", activeRun, "completed", "delivered"],
  ] as const;
  // A follow-up reuses its task's child thread.
  const childThreadIds: Partial<Record<(typeof subagents)[number][0], ThreadId>> = {
    delivered: ThreadId.make("thread:settled-subagents:child-a"),
    running: ThreadId.make("thread:settled-subagents:child-a"),
    "no-delivery": ThreadId.make("thread:settled-subagents:child-b"),
  };
  for (const [index, [name, run, status, delivery]] of subagents.entries()) {
    const id = NodeId.make(`node:settled-subagents:${name}`);
    const childThreadId = childThreadIds[name] ?? null;
    yield* store.apply({
      id: EventId.make(`event:settled-subagents:item:${name}`),
      type: "turn-item.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      occurredAt: now,
      payload: {
        id: TurnItemId.make(`item:settled-subagents:${name}`),
        type: "subagent",
        threadId,
        runId: run.id,
        nodeId: id,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 100 + index,
        status: status === "running" ? "running" : "completed",
        title: name,
        startedAt: now,
        completedAt: status === "running" ? null : now,
        updatedAt: now,
        subagentId: id,
        origin: "app_owned",
        driver,
        providerInstanceId,
        childThreadId,
        prompt: "Do the work",
        result: null,
      },
    });
    yield* store.apply({
      id: EventId.make(`event:settled-subagents:${name}`),
      type: "subagent.updated",
      threadId,
      runId: run.id,
      nodeId: id,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: run.id,
        parentNodeId: run.rootNodeId!,
        origin: "app_owned",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Do the work",
        title: name,
        model: null,
        ...(delivery === null
          ? {}
          : { completionDelivery: { state: delivery, observedByRunId: null } }),
        status,
        result: null,
        startedAt: now,
        completedAt: status === "running" ? null : now,
        updatedAt: now,
      },
    });
  }
  const subagentNames = (records: {
    readonly subagents: ReadonlyArray<{ readonly title: string | null }>;
  }) => records.subagents.map((subagent) => subagent.title ?? "").toSorted();
  assert.deepEqual(
    subagentNames(
      yield* store.getThreadRecords(threadId, ["subagents"], { omitSettledSubagents: true }),
    ),
    ["active-run-delivered", "claimed", "no-delivery", "pending-delivery", "running"],
  );
  assert.deepEqual(
    subagentNames(yield* store.getThreadRecords(threadId, ["subagents"])),
    subagents.map(([name]) => name).toSorted(),
  );
  // A command about one settled task keeps it, and reads only its node and turn item.
  const deliveredId = NodeId.make("node:settled-subagents:delivered");
  const forTask = yield* store.getThreadRecords(threadId, ["subagents", "nodes", "turnItems"], {
    omitSettledSubagents: { except: [deliveredId] },
    nodeIds: [NodeId.make("node:settled-leaf-nodes:settled-tool")],
    turnItemNodeIds: [deliveredId],
  });
  assert.deepEqual(subagentNames(forTask), [
    "active-run-delivered",
    "claimed",
    "delivered",
    "no-delivery",
    "pending-delivery",
    "running",
  ]);
  assert.deepEqual(nodeNames(forTask), ["settled-tool"]);
  assert.deepEqual(
    forTask.turnItems.map((item) => item.title),
    ["delivered"],
  );
  assert.strictEqual(yield* store.getSubagentCount(threadId), subagents.length);
  assert.deepEqual(
    [...(yield* store.listAppOwnedChildThreadIds(threadId))],
    [childThreadIds.delivered, childThreadIds["no-delivery"]],
  );
});

it.effect("memory command reads skip finished leaf nodes of finished runs", () =>
  commandReadsSkipSettledLeafNodes.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "memory worktree path lookup defaults to active threads and can include archived threads",
  () =>
    threadWorktreePathsIncludeArchivedOnRequest.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory recent topics carry the emoji of their latest thread that has one", () =>
  recentThreadTopicsCarryTheirLatestEmoji.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory projection keeps restart-cancelled work through a stale run.updated", () =>
  restartCancelledWorkSurvivesStaleRunUpdate.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const backgroundThreadUpdatesKeepTimestamp = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const createdAt = DateTime.makeUnsafe("2026-10-06T14:00:00.000Z");
  const threadId = ThreadId.make("thread:background-updates");
  const thread = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id: threadId,
    projectId: ProjectId.make("project:background-updates"),
    title: "Background updates",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: thread,
  });
  const readActivity = Effect.gen(function* () {
    const projection = yield* store.getThreadProjection(threadId);
    const thread = yield* store.getThread(threadId);
    const shell = yield* store.getThreadShell(threadId);
    const listed = (yield* store.getShellSnapshot()).threads.find((entry) => entry.id === threadId);
    assert.deepEqual(projection.thread.updatedAt, createdAt);
    assert.deepEqual(thread.updatedAt, createdAt);
    assert.deepEqual(shell?.updatedAt, createdAt);
    assert.deepEqual(listed?.updatedAt, createdAt);
    return projection;
  });
  const link = {
    host: "github.com",
    repository: "owner/repository",
    number: 42,
    url: "https://github.com/owner/repository/pull/42",
    source: "manual" as const,
    linkedAt: DateTime.formatIso(createdAt),
    snapshot: null,
    stack: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:pull-request-synced"),
    type: "thread.pull-request-synced",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 45 }),
    payload: { ...thread, pullRequests: [link] },
  });
  const synced = yield* readActivity;
  assert.deepEqual(synced.updatedAt, createdAt);
  assert.equal(synced.thread.pullRequests?.[0]?.number, 42);

  const snapshot = {
    state: "open" as const,
    title: "Ship it",
    headBranch: "feature",
    baseBranch: "main",
    isDraft: false,
    updatedAt: DateTime.formatIso(DateTime.add(createdAt, { minutes: 46 })),
    syncedAt: DateTime.formatIso(DateTime.add(createdAt, { minutes: 47 })),
    closedAt: null,
    mergedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:background-updates:pull-request-link-updated"),
    type: "thread.pull-request-link-updated",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 48 }),
    payload: { ...link, snapshot },
  });
  const refreshed = yield* readActivity;
  assert.deepEqual(refreshed.updatedAt, createdAt);
  assert.deepEqual(refreshed.thread.pullRequests?.[0]?.snapshot, snapshot);

  yield* store.apply({
    id: EventId.make("event:background-updates:active-reordered"),
    type: "thread.active-reordered",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 50 }),
    payload: { ...refreshed.thread, activeOrderKey: "a" },
  });
  const reordered = yield* readActivity;
  assert.deepEqual(reordered.updatedAt, createdAt);
  assert.equal(reordered.thread.activeOrderKey, "a");

  // An already-unpinned thread keeps its activity time even when replay's envelope advances.
  yield* store.apply({
    id: EventId.make("event:background-updates:already-unpinned"),
    type: "thread.unpinned",
    threadId,
    occurredAt: DateTime.add(createdAt, { minutes: 55 }),
    payload: { ...reordered.thread, pinnedAt: null, pinOrderKey: null },
  });
  yield* readActivity;
});

it.effect("memory projection keeps background thread updates out of updatedAt", () =>
  backgroundThreadUpdatesKeepTimestamp.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("SQL projection keeps background thread updates out of updatedAt", () =>
  backgroundThreadUpdatesKeepTimestamp.pipe(Effect.provide(layerTest)),
);

// A thread command builds its whole-thread event from a read taken before its
// commit. A run's start and its streamed events write the thread without that
// command's lock, so they can land in between.
const staleThreadEventsKeepRunWrites = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const createdAt = DateTime.makeUnsafe("2026-11-06T18:00:00.000Z");
  const startedAt = DateTime.add(createdAt, { seconds: 5 });
  const visitedAt = DateTime.add(createdAt, { seconds: 6 });
  const renamedAt = DateTime.add(createdAt, { seconds: 7 });
  const streamedAt = DateTime.add(createdAt, { seconds: 8 });
  const renamedAgainAt = DateTime.add(createdAt, { seconds: 9 });
  const threadId = ThreadId.make("thread:stale-thread-events");
  const runId = RunId.make("run:stale-thread-events");
  const rootNodeId = NodeId.make("node:stale-thread-events");
  const providerThreadId = ProviderThreadId.make("provider-thread:stale-thread-events");
  const created = {
    createdBy: "user" as const,
    creationSource: "web" as const,
    id: threadId,
    projectId: ProjectId.make("project:stale-thread-events"),
    title: "Stale thread events",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: created,
  });
  // The run's start, as ProviderTurnStartService writes it.
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:provider-thread"),
    type: "provider-thread.updated",
    threadId,
    driver,
    providerInstanceId,
    occurredAt: startedAt,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    },
  });
  const readThread = (expected: {
    readonly title: string;
    readonly updatedAt: DateTime.Utc;
  }) =>
    Effect.gen(function* () {
      const projection = yield* store.getThreadProjection(threadId);
      const thread = yield* store.getThread(threadId);
      const shell = yield* store.getThreadShell(threadId);
      for (const read of [projection.thread, thread]) {
        assert.deepEqual(
          {
            title: read.title,
            activeProviderThreadId: read.activeProviderThreadId,
            updatedAt: DateTime.formatIso(read.updatedAt),
            lastVisitedAt: read.lastVisitedAt && DateTime.formatIso(read.lastVisitedAt),
          },
          {
            title: expected.title,
            activeProviderThreadId: providerThreadId,
            updatedAt: DateTime.formatIso(expected.updatedAt),
            lastVisitedAt: DateTime.formatIso(visitedAt),
          },
        );
      }
      assert.equal(
        shell && DateTime.formatIso(shell.updatedAt),
        DateTime.formatIso(expected.updatedAt),
      );
    });

  // Both commands read the thread as it was created.
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:visited"),
    type: "thread.visited",
    threadId,
    occurredAt: visitedAt,
    payload: { ...created, lastVisitedAt: visitedAt },
  });
  yield* readThread({ title: created.title, updatedAt: startedAt });
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:renamed"),
    type: "thread.metadata-updated",
    threadId,
    occurredAt: renamedAt,
    payload: { ...created, title: "Renamed", lastVisitedAt: visitedAt, updatedAt: renamedAt },
  });
  yield* readThread({ title: "Renamed", updatedAt: renamedAt });

  // Streamed activity, then a rename planned before it.
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:run-created"),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: streamedAt,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("message:stale-thread-events"),
      rootNodeId,
      activeAttemptId: null,
      status: "running",
      requestedAt: streamedAt,
      startedAt: streamedAt,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:renamed-stale"),
    type: "thread.metadata-updated",
    threadId,
    occurredAt: renamedAt,
    payload: { ...created, title: "Renamed twice", lastVisitedAt: visitedAt, updatedAt: renamedAt },
  });
  yield* readThread({ title: "Renamed twice", updatedAt: streamedAt });

  // A later change still moves the activity time.
  yield* store.apply({
    id: EventId.make("event:stale-thread-events:renamed-again"),
    type: "thread.metadata-updated",
    threadId,
    occurredAt: renamedAgainAt,
    payload: {
      ...created,
      title: "Renamed again",
      lastVisitedAt: visitedAt,
      updatedAt: renamedAgainAt,
    },
  });
  yield* readThread({ title: "Renamed again", updatedAt: renamedAgainAt });
});

it.effect(
  "memory projection keeps a run's provider thread and activity time through stale thread events",
  () => staleThreadEventsKeepRunWrites.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "SQL projection keeps a run's provider thread and activity time through stale thread events",
  () => staleThreadEventsKeepRunWrites.pipe(Effect.provide(layerTest)),
);

// Stop stamps its events when it plans and commits them later, so a session
// attach or a terminal write stamped after the plan can commit first.
const earlierStampedRunEventsKeepActivityTime = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const createdAt = DateTime.makeUnsafe("2026-11-06T18:00:00.000Z");
  const stopPlannedAt = DateTime.add(createdAt, { seconds: 3 });
  const providerThreadAt = DateTime.add(createdAt, { seconds: 4 });
  const attachedAt = DateTime.add(createdAt, { seconds: 5 });
  const laterAt = DateTime.add(createdAt, { seconds: 6 });
  const threadId = ThreadId.make("thread:earlier-stamped-run-events");
  const runId = RunId.make("run:earlier-stamped-run-events");
  const rootNodeId = NodeId.make("node:earlier-stamped-run-events");
  const providerSessionId = ProviderSessionId.make("provider-session:earlier-stamped-run-events");
  const providerThreadId = ProviderThreadId.make("provider-thread:earlier-stamped-run-events");
  const run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make("message:earlier-stamped-run-events"),
    rootNodeId,
    activeAttemptId: null,
    status: "starting" as const,
    requestedAt: createdAt,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const readUpdatedAt = Effect.gen(function* () {
    const projection = yield* store.getThreadProjection(threadId);
    const thread = yield* store.getThread(threadId);
    const shell = yield* store.getThreadShell(threadId);
    const listed = (yield* store.getShellSnapshot()).threads.find(
      (entry) => entry.id === threadId,
    );
    return [
      projection.updatedAt,
      projection.thread.updatedAt,
      thread.updatedAt,
      shell?.updatedAt,
      listed?.updatedAt,
    ].map((at) => at && DateTime.formatIso(at));
  });
  const activityTime = (at: DateTime.Utc) => Array(5).fill(DateTime.formatIso(at));

  yield* store.apply({
    id: EventId.make("event:earlier-stamped-run-events:created"),
    type: "thread.created",
    threadId,
    occurredAt: createdAt,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project:earlier-stamped-run-events"),
      title: "Earlier stamped run events",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt,
      updatedAt: createdAt,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* store.apply({
    id: EventId.make("event:earlier-stamped-run-events:run-created"),
    type: "run.created",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: createdAt,
    payload: run,
  });
  // The start opens the provider session and commits its attach.
  yield* store.apply({
    id: EventId.make("event:earlier-stamped-run-events:attached"),
    type: "provider-session.attached",
    threadId,
    driver,
    occurredAt: attachedAt,
    payload: {
      id: providerSessionId,
      driver,
      providerInstanceId,
      status: "running",
      cwd: "/workspace",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: attachedAt,
      updatedAt: attachedAt,
      lastError: null,
    },
  });
  assert.deepEqual(yield* readUpdatedAt, activityTime(attachedAt));

  // Stop, planned before the attach, commits after it.
  yield* store.apply({
    id: EventId.make("event:earlier-stamped-run-events:stopped"),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: stopPlannedAt,
    payload: { ...run, status: "interrupted", completedAt: stopPlannedAt },
  });
  assert.deepEqual(yield* readUpdatedAt, activityTime(attachedAt));

  // So does a provider thread stamped before the attach.
  yield* store.apply({
    id: EventId.make("event:earlier-stamped-run-events:provider-thread"),
    type: "provider-thread.updated",
    threadId,
    driver,
    providerInstanceId,
    occurredAt: providerThreadAt,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "active",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: providerThreadAt,
      updatedAt: providerThreadAt,
    },
  });
  assert.deepEqual(yield* readUpdatedAt, activityTime(attachedAt));
  assert.equal((yield* store.getThread(threadId)).activeProviderThreadId, providerThreadId);

  // Later activity still moves it.
  yield* store.apply({
    id: EventId.make("event:earlier-stamped-run-events:later"),
    type: "run.updated",
    threadId,
    runId,
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    occurredAt: laterAt,
    payload: { ...run, status: "interrupted", completedAt: stopPlannedAt },
  });
  assert.deepEqual(yield* readUpdatedAt, activityTime(laterAt));
});

it.effect(
  "memory projection: a run event stamped before a later write commits leaves the thread's activity time",
  () => earlierStampedRunEventsKeepActivityTime.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect(
  "SQL projection: a run event stamped before a later write commits leaves the thread's activity time",
  () => earlierStampedRunEventsKeepActivityTime.pipe(Effect.provide(layerTest)),
);

// A restore rolls back every finished run after its target. A fork inherits
// its source as the source showed when the fork was made.
const forkAfterRestoreInheritsShownHistory = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const p = "fork-after-restore";
  const start = DateTime.makeUnsafe("2026-11-06T10:00:00.000Z");
  const at = (seconds: number) => DateTime.add(start, { seconds });
  const projectId = ProjectId.make(`project:${p}`);
  const sourceThreadId = ThreadId.make(`thread:${p}:source`);
  const targetThreadId = ThreadId.make(`thread:${p}:target`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${p}:source`);
  const runId = (ordinal: number) => RunId.make(`run:${p}:${ordinal}`);
  const nodeId = (ordinal: number) => NodeId.make(`node:${p}:${ordinal}`);
  const createThread = (id: ThreadId, forkRun: number | null, createdAt: DateTime.Utc) =>
    store.apply({
      id: EventId.make(`event:${p}:${id}:created`),
      type: "thread.created",
      threadId: id,
      occurredAt: createdAt,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id,
        projectId,
        title: id,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: forkRun === null ? providerThreadId : null,
        lineage: {
          parentThreadId: forkRun === null ? null : sourceThreadId,
          relationshipToParent: forkRun === null ? null : "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom:
          forkRun === null
            ? null
            : { type: "run", threadId: sourceThreadId, runId: runId(forkRun) },
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  const writeRun = (
    ordinal: number,
    status: "completed" | "cancelled" | "rolled_back",
    startedAt: DateTime.Utc | null,
    completedAt: DateTime.Utc,
  ) =>
    store.apply({
      id: EventId.make(`event:${p}:run:${ordinal}:${status}`),
      type: "run.updated",
      threadId: sourceThreadId,
      runId: runId(ordinal),
      nodeId: nodeId(ordinal),
      driver,
      occurredAt: completedAt,
      payload: {
        id: runId(ordinal),
        threadId: sourceThreadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:${p}:prompt:${ordinal}`),
        rootNodeId: nodeId(ordinal),
        activeAttemptId: null,
        status,
        requestedAt: startedAt ?? completedAt,
        startedAt,
        completedAt,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  const writeTurn = (
    ordinal: number,
    inputIntent: "turn_start" | "queued_turn",
    answered: boolean,
  ) =>
    Effect.gen(function* () {
      const item = {
        threadId: sourceThreadId,
        runId: runId(ordinal),
        nodeId: nodeId(ordinal),
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        status: "completed" as const,
        title: null,
        startedAt: at(ordinal),
        completedAt: at(ordinal),
        updatedAt: at(ordinal),
      };
      yield* store.apply({
        id: EventId.make(`event:${p}:prompt:${ordinal}`),
        type: "turn-item.updated",
        threadId: sourceThreadId,
        runId: runId(ordinal),
        nodeId: nodeId(ordinal),
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...item,
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make(`turn-item:${p}:prompt:${ordinal}`),
          ordinal: ordinal * 100,
          type: "user_message",
          messageId: MessageId.make(`message:${p}:prompt:${ordinal}`),
          inputIntent,
          text: `prompt ${ordinal}`,
          attachments: [],
        },
      });
      if (!answered) return;
      yield* store.apply({
        id: EventId.make(`event:${p}:answer:${ordinal}`),
        type: "turn-item.updated",
        threadId: sourceThreadId,
        runId: runId(ordinal),
        nodeId: nodeId(ordinal),
        driver,
        occurredAt: at(ordinal),
        payload: {
          ...item,
          id: TurnItemId.make(`turn-item:${p}:answer:${ordinal}`),
          ordinal: ordinal * 100 + 1,
          type: "assistant_message",
          messageId: MessageId.make(`message:${p}:answer:${ordinal}`),
          text: `answer ${ordinal}`,
          streaming: false,
        },
      });
    });
  const text = (rows: ReadonlyArray<{ readonly item: OrchestrationV2TurnItem }>) =>
    rows.map(({ item }) =>
      item.type === "user_message" || item.type === "assistant_message" ? item.text : item.type,
    );
  const readFork = Effect.gen(function* () {
    const projection = yield* store.getThreadProjection(targetThreadId);
    const window = yield* store.getThreadSnapshotWindow(targetThreadId, { rowLimit: 200 });
    const page = yield* store.getTimelinePage(targetThreadId, { view: "activity", limit: 50 });
    const shell = yield* store.getThreadShell(targetThreadId);
    const listed = (yield* store.getShellSnapshot()).threads.find(
      (entry) => entry.id === targetThreadId,
    );
    return {
      projection: text(projection.visibleTurnItems),
      window: text(window.projection.visibleTurnItems),
      timelineItems: page.totalItems,
      shellItems: shell?.visibleItemCount,
      listedShellItems: listed?.visibleItemCount,
    };
  });
  const shown = ["prompt 1", "answer 1", "prompt 4", "answer 4", "prompt 6", "answer 6", "fork"];
  const expected = {
    projection: shown,
    window: shown,
    timelineItems: shown.length,
    shellItems: shown.length,
    listedShellItems: shown.length,
  };

  yield* createThread(sourceThreadId, null, at(0));
  for (const ordinal of [1, 2, 3]) {
    yield* writeRun(ordinal, "completed", at(ordinal), at(ordinal));
    yield* writeTurn(ordinal, "turn_start", true);
  }
  // The user restores to turn 1.
  yield* writeRun(2, "rolled_back", at(2), at(10));
  yield* writeRun(3, "rolled_back", at(3), at(10));
  yield* writeRun(4, "completed", at(14), at(14));
  yield* writeTurn(4, "turn_start", true);
  // A message queued behind turn 4 is cancelled before it is sent.
  yield* writeRun(5, "cancelled", null, at(15));
  yield* writeTurn(5, "queued_turn", false);
  yield* writeRun(6, "completed", at(16), at(16));
  yield* writeTurn(6, "turn_start", true);
  assert.deepEqual(
    text((yield* store.getThreadProjection(sourceThreadId)).visibleTurnItems),
    shown.slice(0, -1),
  );

  yield* createThread(targetThreadId, 6, at(20));
  assert.deepEqual(yield* readFork, expected);

  // Restoring the source to turn 1 again undoes the fork run too. The fork
  // keeps what it was made from: turns 4 and 6, still not turns 2, 3 or the
  // message that was never sent.
  for (const ordinal of [4, 6]) yield* writeRun(ordinal, "rolled_back", at(ordinal), at(30));
  yield* writeRun(5, "rolled_back", null, at(30));
  assert.deepEqual(
    text((yield* store.getThreadProjection(sourceThreadId)).visibleTurnItems),
    ["prompt 1", "answer 1"],
  );
  assert.deepEqual(yield* readFork, expected);
});

it.effect("memory projection: a fork made after a restore leaves out what the restore undid", () =>
  forkAfterRestoreInheritsShownHistory.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("SQL projection: a fork made after a restore leaves out what the restore undid", () =>
  forkAfterRestoreInheritsShownHistory.pipe(Effect.provide(layerTest)),
);

// A queued message whose run was cancelled, and the result of a plain steer
// that superseded an attempt, are hidden from the transcript.
const shellCountsHiddenRowsAsTheProjectionDoes = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const p = "shell-hidden-rows";
  const at = (seconds: number) =>
    DateTime.add(DateTime.makeUnsafe("2026-11-06T12:00:00.000Z"), { seconds });
  const sourceThreadId = ThreadId.make(`thread:${p}:source`);
  const forkThreadId = ThreadId.make(`thread:${p}:fork`);
  const providerThreadId = ProviderThreadId.make(`provider-thread:${p}`);
  const runId = (ordinal: number) => RunId.make(`run:${p}:${ordinal}`);
  const nodeId = (name: string) => NodeId.make(`node:${p}:${name}`);
  const createThread = (id: ThreadId, forkedFromRun: RunId | null) =>
    store.apply({
      id: EventId.make(`event:${p}:${id}:created`),
      type: "thread.created",
      threadId: id,
      occurredAt: at(forkedFromRun === null ? 0 : 20),
      payload: {
        createdBy: "user",
        creationSource: "web",
        id,
        projectId: ProjectId.make(`project:${p}`),
        title: id,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: forkedFromRun === null ? null : sourceThreadId,
          relationshipToParent: forkedFromRun === null ? null : "fork",
          rootThreadId: sourceThreadId,
        },
        forkedFrom:
          forkedFromRun === null
            ? null
            : { type: "run", threadId: sourceThreadId, runId: forkedFromRun },
        createdAt: at(0),
        updatedAt: at(0),
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  const writeRun = (
    ordinal: number,
    status: "completed" | "cancelled",
    rootNode: string,
    startedAt: DateTime.Utc | null,
  ) =>
    store.apply({
      id: EventId.make(`event:${p}:run:${ordinal}`),
      type: "run.updated",
      threadId: sourceThreadId,
      runId: runId(ordinal),
      nodeId: nodeId(rootNode),
      driver,
      occurredAt: at(ordinal),
      payload: {
        id: runId(ordinal),
        threadId: sourceThreadId,
        ordinal,
        providerInstanceId,
        modelSelection,
        providerThreadId,
        userMessageId: MessageId.make(`message:${p}:${ordinal}`),
        rootNodeId: nodeId(rootNode),
        activeAttemptId: null,
        status,
        requestedAt: at(ordinal),
        startedAt,
        completedAt: at(ordinal),
        checkpointId: null,
        contextHandoffId: null,
      },
    });
  const writeAttempt = (
    attemptOrdinal: number,
    rootNode: string,
    status: "completed" | "superseded",
  ) =>
    store.apply({
      id: EventId.make(`event:${p}:attempt:${attemptOrdinal}`),
      type: "run-attempt.created",
      threadId: sourceThreadId,
      runId: runId(1),
      nodeId: nodeId(rootNode),
      driver,
      occurredAt: at(1),
      payload: {
        id: RunAttemptId.make(`attempt:${p}:${attemptOrdinal}`),
        runId: runId(1),
        attemptOrdinal,
        rootNodeId: nodeId(rootNode),
        providerInstanceId,
        providerThreadId,
        providerTurnId: null,
        reason: attemptOrdinal === 1 ? "initial" : "steering_restart",
        status,
        startedAt: at(1),
        completedAt: at(1),
      },
    });
  const itemBase = (ordinal: number, run: number, node: string) => ({
    id: TurnItemId.make(`turn-item:${p}:${ordinal}`),
    threadId: sourceThreadId,
    runId: runId(run),
    nodeId: nodeId(node),
    providerThreadId,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(run),
    completedAt: at(run),
    updatedAt: at(run),
  });
  const writeItem = (item: OrchestrationV2TurnItem) =>
    store.apply({
      id: EventId.make(`event:${p}:item:${item.ordinal}`),
      type: "turn-item.updated",
      threadId: sourceThreadId,
      runId: item.runId ?? undefined,
      nodeId: item.nodeId ?? undefined,
      driver,
      occurredAt: item.updatedAt,
      payload: item,
    });
  const counts = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const projection = yield* store.getThreadProjection(threadId);
      const shell = yield* store.getThreadShell(threadId);
      const listed = (yield* store.getShellSnapshot()).threads.find(
        (entry) => entry.id === threadId,
      );
      return {
        projectedRows: projection.visibleTurnItems.length,
        shellVisible: shell?.visibleItemCount,
        listedVisible: listed?.visibleItemCount,
      };
    });
  const allEqual = (rows: number) => ({
    projectedRows: rows,
    shellVisible: rows,
    listedVisible: rows,
  });

  yield* createThread(sourceThreadId, null);
  yield* writeRun(1, "completed", "steered", at(1));
  // A plain steer superseded the first attempt and restarted the turn.
  yield* writeAttempt(1, "first", "superseded");
  yield* writeAttempt(2, "steered", "completed");
  yield* writeItem({
    ...itemBase(1, 1, "first"),
    createdBy: "user",
    creationSource: "web",
    type: "user_message",
    messageId: MessageId.make(`message:${p}:1`),
    inputIntent: "turn_start",
    text: "prompt",
    attachments: [],
  });
  yield* writeItem({
    ...itemBase(2, 1, "first"),
    type: "run_interrupt_result",
    message: "Interrupted by a steer",
  });
  yield* writeItem({
    ...itemBase(3, 1, "steered"),
    type: "assistant_message",
    messageId: MessageId.make(`message:${p}:answer`),
    text: "answer",
    streaming: false,
  });
  // A follow-up queued behind it, then taken back out of the queue.
  yield* writeRun(2, "cancelled", "queued", null);
  yield* writeItem({
    ...itemBase(4, 2, "queued"),
    createdBy: "user",
    creationSource: "web",
    type: "user_message",
    messageId: MessageId.make(`message:${p}:2`),
    inputIntent: "queued_turn",
    text: "queued follow-up",
    attachments: [],
  });
  assert.deepEqual(yield* counts(sourceThreadId), allEqual(2));
  assert.equal((yield* store.getThreadShell(sourceThreadId))?.itemCount, 2);

  yield* createThread(forkThreadId, runId(1));
  // The fork shows the source's two rows and its fork marker.
  assert.deepEqual(yield* counts(forkThreadId), allEqual(3));
});

it.effect("memory shell counts the rows its thread shows", () =>
  shellCountsHiddenRowsAsTheProjectionDoes.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("SQL shell counts the rows its thread shows", () =>
  shellCountsHiddenRowsAsTheProjectionDoes.pipe(Effect.provide(layerTest)),
);

it.effect("memory recovery selection ignores unfinished items from rolled-back runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addRolledBackRecoveryCandidate("memory-recovery-candidates");

    assert.notInclude(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

it.effect("memory recovery selection includes unfinished items from missing runs", () =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = yield* addOrphanedRecoveryCandidate("memory-recovery-candidates");

    assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), threadId);
  }).pipe(Effect.provide(ProjectionStore.layerMemory)),
);

const runlessNativeSubagentNeedsRecovery = Effect.gen(function* () {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = yield* addRolledBackRecoveryCandidate("runless-native-recovery");
  const now = yield* DateTime.now;
  const id = NodeId.make("node:runless-native-recovery");
  assert.notInclude(yield* store.getRecoveryThreadIds("runtime"), threadId);
  for (const status of ["pending", "running", "waiting", "completed"] as const) {
    yield* store.apply({
      id: EventId.make(`event:runless-native-recovery:${status}`),
      type: "subagent.updated",
      threadId,
      nodeId: id,
      driver,
      providerInstanceId,
      occurredAt: now,
      payload: {
        id,
        threadId,
        runId: null,
        parentNodeId: NodeId.make("node:runless-native-parent"),
        origin: "provider_native",
        createdBy: "agent",
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: { driver, nativeId: "runless-native", strength: "strong" },
        prompt: "Do the work",
        title: "Workflow member",
        model: null,
        status,
        result: null,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        updatedAt: now,
      },
    });
    assert.equal(
      (yield* store.getRecoveryThreadIds("runtime")).includes(threadId),
      status !== "completed",
    );
  }
});

it.effect("memory recovery selects unfinished runless native subagents", () =>
  runlessNativeSubagentNeedsRecovery.pipe(Effect.provide(ProjectionStore.layerMemory)),
);

// Project A holds an active thread, an archived thread and a fork of a run in
// an archived project B thread, so a project-scoped snapshot still has to load
// a fork source that is outside the project and archived.
const assertProjectScopedShells = Effect.fn("assertProjectScopedShells")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const projectId = ProjectId.make(`project:${suffix}:a`);
  const otherProjectId = ProjectId.make(`project:${suffix}:b`);
  const activeThreadId = ThreadId.make(`thread:${suffix}:a-active`);
  const archivedThreadId = ThreadId.make(`thread:${suffix}:a-archived`);
  const forkThreadId = ThreadId.make(`thread:${suffix}:a-fork`);
  const sourceThreadId = ThreadId.make(`thread:${suffix}:b-source`);
  const otherThreadId = ThreadId.make(`thread:${suffix}:b-other`);
  const sourceRunId = RunId.make(`run:${suffix}:b-source`);
  const sourceNodeId = NodeId.make(`node:${suffix}:b-source`);
  const createThread = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly archived?: boolean;
    readonly forkedFromRunOf?: ThreadId;
  }) =>
    projectionStore.apply({
      id: EventId.make(`event:${input.threadId}:created`),
      type: "thread.created",
      threadId: input.threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: input.threadId,
        projectId: input.projectId,
        title: input.threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage:
          input.forkedFromRunOf === undefined
            ? { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId }
            : {
                parentThreadId: input.forkedFromRunOf,
                relationshipToParent: "fork",
                rootThreadId: input.forkedFromRunOf,
              },
        forkedFrom:
          input.forkedFromRunOf === undefined
            ? null
            : { type: "run", threadId: input.forkedFromRunOf, runId: sourceRunId },
        createdAt: now,
        updatedAt: now,
        archivedAt: input.archived === true ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });

  yield* createThread({ threadId: sourceThreadId, projectId: otherProjectId, archived: true });
  yield* createThread({ threadId: otherThreadId, projectId: otherProjectId });
  yield* createThread({ threadId: activeThreadId, projectId });
  yield* createThread({ threadId: archivedThreadId, projectId, archived: true });
  yield* createThread({ threadId: forkThreadId, projectId, forkedFromRunOf: sourceThreadId });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-run`),
    type: "run.created",
    threadId: sourceThreadId,
    runId: sourceRunId,
    nodeId: sourceNodeId,
    driver,
    occurredAt: now,
    payload: {
      id: sourceRunId,
      threadId: sourceThreadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${suffix}:source-user`),
      rootNodeId: sourceNodeId,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projectionStore.apply({
    id: EventId.make(`event:${suffix}:source-item`),
    type: "turn-item.updated",
    threadId: sourceThreadId,
    runId: sourceRunId,
    occurredAt: now,
    payload: {
      id: TurnItemId.make(`turn-item:${suffix}:source`),
      threadId: sourceThreadId,
      runId: sourceRunId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "assistant_message",
      messageId: MessageId.make(`message:${suffix}:source-assistant`),
      text: "Source answer",
      streaming: false,
    },
  });

  const unscoped = yield* projectionStore.getShellSnapshot();
  const inProject = (thread: { readonly projectId: ProjectId }) => thread.projectId === projectId;
  const active = yield* projectionStore.getShellSnapshot({ projectId, location: "active" });
  assert.deepEqual(active.threads, unscoped.threads.filter(inProject));
  assert.deepEqual(active.archivedThreads, []);
  assert.sameMembers(
    active.threads.map((thread) => thread.id),
    [activeThreadId, forkThreadId],
  );
  const fork = active.threads.find((thread) => thread.id === forkThreadId);
  assert.isAbove(fork?.visibleItemCount ?? 0, 0);

  const all = yield* projectionStore.getShellSnapshot({ projectId });
  assert.deepEqual(all.threads, active.threads);
  assert.deepEqual(all.archivedThreads, unscoped.archivedThreads.filter(inProject));
  assert.sameMembers(
    all.archivedThreads.map((thread) => thread.id),
    [archivedThreadId],
  );
  return { projectId, activeThreadId, forkThreadId, otherThreadId };
});

// .
const assertWorktreeScopedShells = Effect.fn("assertWorktreeScopedShells")(function* (
  suffix: string,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const worktreePath = `/repo-worktrees/${suffix}`;
  const ids = {
    active: ThreadId.make(`thread:${suffix}:active`),
    archived: ThreadId.make(`thread:${suffix}:archived`),
    otherWorktree: ThreadId.make(`thread:${suffix}:other-worktree`),
    noWorktree: ThreadId.make(`thread:${suffix}:no-worktree`),
  };
  for (const [threadId, threadWorktreePath, archived] of [
    [ids.active, worktreePath, false],
    [ids.archived, worktreePath, true],
    [ids.otherWorktree, `${worktreePath}-other`, false],
    [ids.noWorktree, null, false],
  ] as const) {
    yield* projectionStore.apply({
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: ProjectId.make(`project:${suffix}`),
        title: threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "t3/shared-branch",
        worktreePath: threadWorktreePath,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: archived ? now : null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  }
  const unscoped = yield* projectionStore.getShellSnapshot();
  const inWorktree = (thread: { readonly worktreePath: string | null }) =>
    thread.worktreePath === worktreePath;
  const scoped = yield* projectionStore.getShellSnapshot({ worktreePath });
  assert.deepEqual(scoped.threads, unscoped.threads.filter(inWorktree));
  assert.deepEqual(scoped.archivedThreads, unscoped.archivedThreads.filter(inWorktree));
  assert.deepEqual(
    [scoped.threads.map((thread) => thread.id), scoped.archivedThreads.map((thread) => thread.id)],
    [[ids.active], [ids.archived]],
  );
  return { worktreePath, ids };
});

it.effect("memory shell snapshots scope to one worktree", () =>
  assertWorktreeScopedShells("memory-worktree-shell").pipe(
    Effect.asVoid,
    Effect.provide(ProjectionStore.layerMemory),
  ),
);

it.effect("memory shell snapshots scope to one project", () =>
  assertProjectScopedShells("memory-project-shell").pipe(
    Effect.asVoid,
    Effect.provide(ProjectionStore.layerMemory),
  ),
);

// regression: #25621 SQLite rejects statements binding more than 32,766 variables
it.effect("lists every thread in the shell snapshot past SQLite's bound variable limit", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const templateId = ThreadId.make("thread:many:00000");
    yield* store.apply({
      id: EventId.make(`event:${templateId}:created`),
      type: "thread.created",
      threadId: templateId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: templateId,
        projectId: ProjectId.make("project:many"),
        title: "Many",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: templateId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const threadCount = 32_767;
    yield* sql`
      CREATE TEMP TABLE many_threads AS
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${threadCount - 1})
      SELECT t.*, n.i AS clone_index FROM orchestration_v2_projection_threads t, n
      WHERE t.thread_id = ${templateId}
    `;
    yield* sql`
      UPDATE many_threads SET
        thread_id = printf('thread:many:%05d', clone_index),
        payload_json = json_set(
          payload_json,
          '$.id', printf('thread:many:%05d', clone_index),
          '$.lineage.rootThreadId', printf('thread:many:%05d', clone_index)
        )
    `;
    yield* sql`ALTER TABLE many_threads DROP COLUMN clone_index`;
    yield* sql`INSERT INTO orchestration_v2_projection_threads SELECT * FROM many_threads`;

    const [unscoped, active] = yield* Effect.all([
      store.getShellSnapshot(),
      store.getShellSnapshot({ location: "active" }),
    ]);
    assert.strictEqual(unscoped.threads.length, threadCount);
    assert.strictEqual(active.threads.length, threadCount);
  }).pipe(Effect.provide(layerTest)),
);

it.layer(layerTest)("ProjectionStoreV2", (it) => {
  it.effect("returns a typed read error for malformed stored plan JSON", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("corrupt-plan");
      const planId = PlanId.make("plan:corrupt");
      yield* sql`INSERT INTO orchestration_v2_projection_plans
        (plan_id, thread_id, node_id, kind, status, payload_json)
        VALUES (${planId}, ${threadId}, 'node:corrupt-plan', 'proposed_plan', 'active', '{broken')`;

      const failure = yield* store
        .getPlan(threadId, planId)
        .pipe(
          Effect.flip,
          Effect.ensuring(
            Effect.orDie(
              sql`DELETE FROM orchestration_v2_projection_plans WHERE plan_id = ${planId}`,
            ),
          ),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  // regression: #25157 streamed payloads are not re-parsed to read their indexed timestamps
  it.effect("indexes streamed payload timestamps without parsing the payload JSON", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = yield* addRolledBackRecoveryCandidate("streamed-payload-parse");
      const runId = RunId.make("run:streamed-payload-parse:rolled-back");
      const createdAt = DateTime.makeUnsafe("2026-01-02T03:04:05.006Z");
      const updatedAt = DateTime.makeUnsafe("2026-01-02T03:04:06.007Z");
      const text = "x".repeat(128 * 1024);
      const messageId = MessageId.make("message:streamed-payload-parse");
      const itemId = TurnItemId.make("item:streamed-payload-parse");

      const parsedPayloads = yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(JSON, "parse")),
        (parse) =>
          Effect.gen(function* () {
            yield* store.apply({
              id: EventId.make("event:streamed-payload-parse:message"),
              type: "message.updated",
              threadId,
              occurredAt: updatedAt,
              payload: {
                createdBy: "agent",
                creationSource: "server",
                id: messageId,
                threadId,
                runId,
                nodeId: null,
                role: "assistant",
                text,
                attachments: [],
                streaming: true,
                createdAt,
                updatedAt,
              },
            });
            yield* store.apply({
              id: EventId.make("event:streamed-payload-parse:item"),
              type: "turn-item.updated",
              threadId,
              runId,
              occurredAt: updatedAt,
              payload: {
                id: itemId,
                threadId,
                runId,
                nodeId: null,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                type: "assistant_message",
                status: "running",
                title: "Assistant",
                messageId,
                text,
                streaming: true,
                startedAt: createdAt,
                completedAt: null,
                updatedAt,
              },
            });
            return parse.mock.calls
              .filter(([json]) => typeof json === "string" && json.includes(text))
              .map(([json]) => (JSON.parse(json) as { readonly id: string }).id);
          }),
        (parse) => Effect.sync(() => parse.mockRestore()),
      );

      assert.deepStrictEqual(parsedPayloads, []);
      assert.deepStrictEqual(
        yield* sql`
          SELECT created_at, updated_at FROM orchestration_v2_projection_messages
          WHERE message_id = ${messageId}
        `,
        [{ created_at: DateTime.formatIso(createdAt), updated_at: DateTime.formatIso(updatedAt) }],
      );
      assert.deepStrictEqual(
        yield* sql`
          SELECT updated_at FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `,
        [{ updated_at: DateTime.formatIso(updatedAt) }],
      );
    }),
  );

  it.effect(
    "SQL recovery selects unfinished runless native subagents",
    () => runlessNativeSubagentNeedsRecovery,
  );
  it.effect(
    "worktree path lookup defaults to active threads and can include archived threads",
    () => threadWorktreePathsIncludeArchivedOnRequest,
  );

  it.effect("recent topics carry the emoji of their latest thread that has one", () => recentThreadTopicsCarryTheirLatestEmoji);

  it.effect(
    "keeps restart-cancelled work through a stale run.updated",
    () => restartCancelledWorkSurvivesStaleRunUpdate,
  );
  it.effect("records restart-cancelled work without regressing a run that completed since", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("restart-cancelled-work");
      const run = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      // Recovery read the run as waiting; its checkpoint completed it before the commit.
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:completed"),
        type: "run.updated",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { ...run, status: "completed", completedAt: now },
      });
      const work = [{ kind: "subagent" as const, label: "Background subagent test" }];
      yield* store.apply({
        id: EventId.make("event:restart-cancelled-work:recorded"),
        type: "run.background-work-cancelled",
        threadId,
        runId: run.id,
        providerInstanceId,
        occurredAt: now,
        payload: { runId: run.id, restartCancelledBackgroundWork: work },
      });
      const recorded = (yield* store.getThreadProjection(threadId)).runs[0];
      assert.equal(recorded?.status, "completed");
      assert.deepEqual(recorded?.restartCancelledBackgroundWork, work);
      const [recovery] = (yield* store.getThreadRecords(threadId, ["runs"], {
        runIds: [run.id],
      })).runs;
      assert.equal(recovery?.status, "completed");
      assert.deepEqual(recovery?.restartCancelledBackgroundWork, work);
    }),
  );
  it.effect(
    "command reads skip finished leaf nodes of finished runs",
    () => commandReadsSkipSettledLeafNodes,
  );
  it.effect("limits turn-start history to the requested runs, including an empty selection", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("selected-turn-start-history");
      const runId = (yield* store.getThreadProjection(threadId)).runs[0]!.id;
      const history = yield* store.getTurnStartHistory(threadId);
      assert.isNotEmpty(history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [runId]), history);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, []), []);
      assert.deepEqual(yield* store.getTurnStartHistory(threadId, [RunId.make("run:other")]), []);
    }),
  );
  it.effect("answers empty record filters without reading the filtered tables", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("empty-record-filters");
      const runId = (yield* store.getThreadProjection(threadId)).runs[0]!.id;
      const queries: Array<string> = [];
      const recordQueries: Statement.Transformer = (statement) => {
        queries.push(statement.compile()[0]);
        return Effect.succeed(statement);
      };
      const read = (filter: ProjectionStore.ProjectionRecordFilter) =>
        store
          .getThreadRecords(threadId, ["runs", "messages", "turnItems"], filter)
          .pipe(Effect.provideService(Statement.CurrentTransformer, recordQueries));

      const emptyFilters = [
        [{ turnItemTypes: [] }, "turnItems", "turn_items"],
        [{ turnItemStatuses: [] }, "turnItems", "turn_items"],
        [{ turnItemRunIds: [] }, "turnItems", "turn_items"],
        [{ runIds: [] }, "runs", "runs"],
        [{ messageIds: [] }, "messages", "messages"],
        [{ messageRoles: [] }, "messages", "messages"],
        [{ messageRunIds: [] }, "messages", "messages"],
      ] as const;
      for (const [filter, field, table] of emptyFilters) {
        queries.length = 0;
        assert.isEmpty((yield* read(filter))[field]);
        assert.isFalse(
          queries.some((query) =>
            new RegExp(`FROM orchestration_v2_projection_${table}\\b`).test(query),
          ),
          `${JSON.stringify(filter)} read ${table}`,
        );
      }

      const selected = yield* read({ turnItemTypes: ["command_execution"], runIds: [runId] });
      assert.deepEqual(
        selected.turnItems.map((item) => item.type),
        ["command_execution"],
      );
      assert.deepEqual(
        selected.runs.map((run) => run.id),
        [runId],
      );
      assert.isEmpty((yield* read({ turnItemTypes: ["user_message"] })).turnItems);
    }),
  );
  it.effect("preserves stored provider usage when a terminal update omits it", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-usage-reload");
      const providerThreadId = ProviderThreadId.make("provider-thread:provider-usage-reload");
      const providerTurnId = ProviderTurnId.make("provider-turn:provider-usage-reload");
      const nodeId = NodeId.make("node:provider-usage-reload");
      const initialUsage = {
        usedTokens: 12_000,
        maxTokens: 200_000,
        inputTokens: 11_000,
        outputTokens: 1_000,
        updatedAt: "2026-08-29T12:00:00.000Z",
      } as const;
      const replacementUsage = {
        usedTokens: 18_000,
        maxTokens: 200_000,
        inputTokens: 16_000,
        outputTokens: 2_000,
        updatedAt: "2026-08-29T12:00:01.000Z",
      } as const;

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-usage-reload"),
          title: "Provider usage reload",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
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
      });

      const providerTurn = {
        id: providerTurnId,
        providerThreadId,
        nodeId,
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:running"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, tokenUsage: initialUsage },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:completed"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: { ...providerTurn, status: "completed", completedAt: now },
      });

      const reloaded = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(reloaded.providerTurns[0]?.tokenUsage, initialUsage);
      assert.strictEqual(reloaded.providerTurns[0]?.status, "completed");

      yield* projectionStore.apply({
        id: EventId.make("event:provider-usage-reload:replacement"),
        type: "provider-turn.updated",
        threadId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          ...providerTurn,
          status: "completed",
          completedAt: now,
          tokenUsage: replacementUsage,
        },
      });

      const replaced = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(replaced.providerTurns[0]?.tokenUsage, replacementUsage);
    }),
  );

  it.effect("pages complete user turns through SQL regardless of tool count or payload size", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:user-turn-pages");
      yield* projectionStore.apply({
        id: EventId.make("event:user-turn-pages:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:user-turn-pages"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
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
      });

      const allIds: string[] = [];
      let lastToolPayload = "";
      for (let turn = 1; turn <= 45; turn += 1) {
        const rows = Arr.makeBy(102, (offset) => {
          const ordinal = (turn - 1) * 102 + offset + 1;
          const id = `item:user-turn-pages:${ordinal}`;
          allIds.push(id);
          const base = {
            id,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
          };
          const item =
            offset < 2
              ? {
                  ...base,
                  type: "user_message",
                  createdBy: "user",
                  creationSource: "web",
                  messageId: `message:${id}`,
                  inputIntent: offset === 0 ? "turn_start" : "steer",
                  text: `Turn ${turn}`,
                  attachments: [],
                }
              : {
                  ...base,
                  type: "command_execution",
                  input: "command",
                  output: "x".repeat(2048),
                  exitCode: 0,
                };
          const payloadJson = encodeUnknownJsonString(item);
          if (offset >= 2) lastToolPayload = payloadJson;
          return {
            turn_item_id: id,
            thread_id: threadId,
            run_id: null,
            node_id: null,
            provider_thread_id: null,
            provider_turn_id: null,
            parent_item_id: null,
            ordinal,
            type: item.type,
            status: "completed",
            updated_at: nowIso,
            payload_json: payloadJson,
          };
        });
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      }
      const { statements, tracer } = traceSqlStatements();
      const initial = yield* Effect.acquireUseRelease(
        Effect.sync(() => vi.spyOn(JSON, "parse")),
        (parse) =>
          projectionStore
            .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
            .pipe(
              Effect.withTracer(tracer),
              Effect.tap(() =>
                Effect.sync(() => {
                  // Tool outputs must not be allocated again just to collect cohort IDs.
                  assert.lengthOf(
                    parse.mock.calls.filter(([input]) => input === lastToolPayload),
                    1,
                  );
                }),
              ),
            ),
        (parse) => Effect.sync(() => parse.mockRestore()),
      );
      // Large threads blocked the server for over a second here. The boundary
      // must come from the user-message index rather than a scan of every tool
      // row, and payloads must not go through a sort after they are fetched.
      const windowStatement = statements.find((statement) => statement.includes("turn_anchors"));
      assert.isDefined(windowStatement);
      const windowPlan = yield* sql.unsafe<{ readonly parent: number; readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${windowStatement}`,
      );
      assert.match(
        windowPlan.map((row) => row.detail).join("\n"),
        /SEARCH item USING INDEX orchestration_v2_projection_turn_items_user_message_idx \(thread_id=\? AND ordinal<\?\)/,
      );
      const topLevel = windowPlan.filter((row) => row.parent === 0).map((row) => row.detail);
      assert.include(topLevel, "SEARCH item USING INTEGER PRIMARY KEY (rowid=?)");
      assert.notInclude(topLevel, "USE TEMP B-TREE FOR ORDER BY");
      const nodeStatement = statements.find((statement) =>
        statement.includes("WITH RECURSIVE retained"),
      );
      assert.isDefined(nodeStatement);
      const nodePlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${nodeStatement}`,
      );
      assert.include(
        nodePlan.map((row) => row.detail),
        "SEARCH orchestration_v2_projection_nodes USING INDEX orchestration_v2_projection_nodes_live_idx (thread_id=?)",
      );
      // Only the selected turn cohort and two lookahead anchors are decoded.
      assert.lengthOf(initial.projection.turnItems, 12 * 102);
      const bounded = buildBoundedThreadProjection({
        projection: initial.projection,
        snapshotSequence: 0,
      });
      assert.lengthOf(bounded.projection.visibleTurnItems, 10 * 102);
      assert.strictEqual(bounded.projection.visibleTurnItems[0]?.sourceItemId, allIds[35 * 102]);
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      for (const turns of [20, 15]) {
        assert.isNotNull(cursor);
        const anchor = decodeThreadHistoryCursor(cursor!);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: cursor!,
          snapshotSequence: 0,
        });
        assert.lengthOf(page.items, turns * 102);
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.isNull(cursor);
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect("caps a SQL window by runs that a notification started", () =>
    Effect.gen(function* () {
      // A thread woken by PR watches: 12 user turns, then 400 runs that a
      // notification started, with a user turn every 50 runs. The user-turn
      // window reached back to the 12th-newest user turn and read almost every row.
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:notification-turn-pages");
      yield* projectionStore.apply({
        id: EventId.make("event:notification-turn-pages:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:notification-turn-pages"),
          title: "Woken by notifications",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
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
      });

      const startedRuns = 412;
      const allIds: string[] = [];
      const startIds: string[] = [];
      let ordinal = 0;
      const itemRow = (runId: string, item: Record<string, unknown>) => {
        ordinal += 1;
        const id = `turn-item:notification-turn-pages:${ordinal}`;
        allIds.push(id);
        return {
          turn_item_id: id,
          thread_id: threadId,
          run_id: runId,
          node_id: null,
          provider_thread_id: null,
          provider_turn_id: null,
          parent_item_id: null,
          ordinal,
          type: String(item.type),
          status: "completed",
          updated_at: nowIso,
          payload_json: encodeUnknownJsonString({
            id,
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            ...item,
          }),
        };
      };
      const command = { type: "command_execution", input: "command", output: "x", exitCode: 0 };
      const notification = (summary: string) => ({
        type: "notification",
        source: { kind: "monitor" },
        outcome: "completed",
        summary,
      });
      // The newest run is a wake queued behind the last one. It has no items yet,
      // like a run cancelled before it started.
      for (let run = 1; run <= startedRuns + 1; run += 1) {
        const runId = `run:notification-turn-pages:${run}`;
        const status = run > startedRuns ? "queued" : "completed";
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${run}, 'codex', NULL, ${status}, ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: run,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:notification-turn-pages:${run}`,
              rootNodeId: `node:notification-turn-pages:${run}`,
              activeAttemptId: null,
              status,
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        if (run > startedRuns) continue;
        const start =
          run <= 12 || run % 50 === 0
            ? {
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                messageId: `message:notification-turn-pages:${run}`,
                inputIntent: "turn_start",
                text: `Turn ${run}`,
                attachments: [],
              }
            : notification(`Wake ${run}`);
        // A row of the run (a handoff) can come before its first input. A wake
        // steered into the running turn follows it and starts no turn.
        const rows = [
          itemRow(runId, command),
          itemRow(runId, start),
          itemRow(runId, command),
          itemRow(runId, notification(`Steer ${run}`)),
        ] as const;
        startIds.push(rows[1]!.turn_item_id);
        yield* sql`INSERT INTO orchestration_v2_projection_turn_items ${sql.insert(rows)}`;
      }

      const { statements, tracer } = traceSqlStatements();
      const initial = yield* projectionStore
        .getThreadSnapshotWindow(threadId, { rowLimit: 77, userTurnLimit: 10 })
        .pipe(Effect.withTracer(tracer));
      // The 152 newest turns are the 152 newest started runs, 261 to 412. Only
      // three of them are user turns, short of the 12 the user-turn window needs.
      assert.deepEqual(
        initial.projection.turnItems.map((item) => String(item.id)),
        allIds.slice(allIds.indexOf(startIds[260]!)),
      );
      // Each run's first input is read by run ID, newest run first, never by a
      // walk over every turn item in the thread.
      const windowStatement = statements.find((statement) => statement.includes("run_starts"));
      assert.isDefined(windowStatement);
      const windowPlan = yield* sql.unsafe<{ readonly detail: string }>(
        `EXPLAIN QUERY PLAN ${windowStatement}`,
      );
      const windowPlanDetails = windowPlan.map((row) => row.detail);
      assert.include(
        windowPlanDetails,
        "SEARCH recent_run USING INDEX orchestration_v2_projection_runs_thread_ordinal_idx (thread_id=? AND ordinal<?)",
      );
      assert.include(
        windowPlanDetails,
        "SEARCH first_input USING INDEX orchestration_v2_projection_turn_items_run_ordinal_idx (run_id=?)",
      );
      const bounded = buildBoundedThreadProjection({
        projection: initial.projection,
        snapshotSequence: 0,
      });
      assert.strictEqual(bounded.projection.visibleTurnItems[0]?.sourceItemId, startIds[262]);
      const loaded = bounded.projection.visibleTurnItems.map((row) => String(row.sourceItemId));
      let cursor = bounded.historyCursor;
      for (let pages = 0; cursor !== null; pages += 1) {
        assert.isBelow(pages, 5);
        const anchor = decodeThreadHistoryCursor(cursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        // Older windows stay bounded too.
        assert.isAtMost(snapshot.projection.turnItems.length, 152 * 4 + 1);
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: 0,
        });
        loaded.unshift(...page.items.map((row) => String(row.sourceItemId)));
        cursor = page.nextCursor;
      }
      assert.deepEqual(loaded, allIds);
    }),
  );

  it.effect(
    "bounds completed nodes within one long run while preserving ancestry and live work",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:bounded-node-history");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:bounded-node-history"),
            title: "Bounded SQL history",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
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
        });
        const runId = RunId.make("run:bounded-node-history");
        const rootNodeId = NodeId.make("node:bounded-node-history:root");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:run"),
          type: "run.created",
          threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:bounded-node-history"),
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        const parentNodeId = NodeId.make("node:bounded-node-history:parent");
        const liveNodeId = NodeId.make("node:bounded-node-history:live");
        for (let index = -3; index < 1000; index++) {
          const id =
            index === -3
              ? rootNodeId
              : index === -2
                ? parentNodeId
                : index === -1
                  ? liveNodeId
                  : NodeId.make(`node:bounded-node-history:${index}`);
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:node:${index}`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id,
              threadId,
              runId,
              rootNodeId,
              parentNodeId: index === -3 ? null : index === -2 ? rootNodeId : parentNodeId,
              kind: index === -3 ? "root_turn" : "assistant_message",
              status: index === -1 ? "running" : "completed",
              countsForRun: index === -3,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt:
                index === 998
                  ? null
                  : index === 999
                    ? DateTime.makeUnsafe("2020-01-01T00:00:00.000Z")
                    : now,
              completedAt: index === -1 ? null : now,
            },
          });
          if (index < 0) continue;
          yield* projectionStore.apply({
            id: EventId.make(`event:bounded-node-history:item:${index}`),
            type: "turn-item.updated",
            threadId,
            runId,
            nodeId: id,
            driver,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`item:bounded-node-history:${index}`),
              threadId,
              runId,
              nodeId: id,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: index,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "command_execution",
              input: `echo ${index}`,
              output: "ok",
              exitCode: 0,
            },
          });
        }
        const requestNodeId = NodeId.make("node:bounded-node-history:0");
        yield* projectionStore.apply({
          id: EventId.make("event:bounded-node-history:request"),
          type: "runtime-request.updated",
          threadId,
          runId,
          nodeId: requestNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: RuntimeRequestId.make("request:bounded-node-history"),
            nodeId: requestNodeId,
            providerTurnId: ProviderTurnId.make("provider-turn:bounded-node-history"),
            nativeRequestRef: null,
            kind: "command",
            status: "pending",
            responseCapability: {
              type: "live",
              providerSessionId: ProviderSessionId.make("session:bounded-node-history"),
            },
            createdAt: now,
            resolvedAt: null,
          },
        });
        const { statements, tracer } = traceSqlStatements();
        const snapshot = yield* projectionStore
          .getThreadSnapshotWindow(threadId, { rowLimit: 75 })
          .pipe(Effect.withTracer(tracer));
        const nodeStatement = statements.find(
          (statement) =>
            statement.includes("payload_json") &&
            statement.includes("orchestration_v2_projection_nodes") &&
            !statement.includes("WITH RECURSIVE"),
        );
        assert.isDefined(nodeStatement);
        const nodePlan = yield* (yield* SqlClient.SqlClient).unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${nodeStatement}`,
        );
        const nodeLookups = nodePlan
          .map((row) => row.detail)
          .filter((detail) => detail.startsWith("SEARCH "));
        // Cost must follow the retained cohort, even when the thread has
        // thousands of completed nodes outside the requested window.
        assert.deepEqual(nodeLookups, [
          "SEARCH node USING INDEX sqlite_autoindex_orchestration_v2_projection_nodes_1 (node_id=?)",
        ]);
        assert.notInclude(
          nodePlan.map((row) => row.detail),
          "USE TEMP B-TREE FOR ORDER BY",
        );
        assert.lengthOf(snapshot.projection.visibleTurnItems, 75);
        assert.lengthOf(snapshot.projection.nodes, 79);
        const retained = new Set(snapshot.projection.nodes.map((node) => node.id));
        assert.isTrue(retained.has(rootNodeId));
        assert.isTrue(retained.has(parentNodeId));
        assert.isTrue(retained.has(liveNodeId));
        assert.isTrue(retained.has(requestNodeId));
        assert.lengthOf(snapshot.projection.runtimeRequests, 1);
        assert.isFalse(retained.has(NodeId.make("node:bounded-node-history:1")));
        for (const row of snapshot.projection.visibleTurnItems)
          assert.isTrue(retained.has(row.item.nodeId!));
        const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 75,
          anchorItemId: TurnItemId.make("item:bounded-node-history:925"),
        });
        assert.lengthOf(older.projection.nodes, 79);
        assert.isTrue(
          older.projection.nodes.some(
            (node) => node.id === NodeId.make("node:bounded-node-history:851"),
          ),
        );
        const full = yield* projectionStore.getThreadSnapshot(threadId);
        assert.lengthOf(full.projection.nodes, 1003);
        // Bounded reads keep the full read's payloads and ordering, including
        // null start times and equal timestamps.
        assert.deepEqual(
          snapshot.projection.nodes,
          full.projection.nodes.filter((node) => retained.has(node.id)),
        );
        const sql = yield* SqlClient.SqlClient;
        const duplicateItemId = TurnItemId.make("item:bounded-node-history:duplicate");
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items
          SELECT ${duplicateItemId}, thread_id, run_id, node_id, provider_thread_id,
            provider_turn_id, parent_item_id, ordinal + 1, type, status, updated_at,
            json_set(payload_json, '$.id', ${duplicateItemId}, '$.ordinal', ordinal + 1)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${TurnItemId.make("item:bounded-node-history:999")}
        `;
        const sharedNodeSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: 76,
        });
        assert.lengthOf(sharedNodeSnapshot.projection.visibleTurnItems, 76);
        assert.deepEqual(sharedNodeSnapshot.projection.nodes, snapshot.projection.nodes);
      }),
  );

  it.effect("reads a fixed SQL turn-item window for long histories and repeated clients", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:bounded-sql-history");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:bounded-sql-history"),
          title: "Bounded SQL history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
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
      });

      for (let ordinal = 1; ordinal <= 1_000; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:${ordinal}`;
        const runId = `run:bounded-sql-history:${ordinal}`;
        const message = ordinal === 1 || ordinal === 1_000;
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:bounded-sql-history:${ordinal}`,
              rootNodeId: `node:bounded-sql-history:${ordinal}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            ${message ? "user_message" : "command_execution"}, 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `command ${ordinal}`,
              input: `echo ${ordinal}`,
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              ...(message
                ? {
                    type: "user_message",
                    createdBy: "user",
                    creationSource: "web",
                    messageId: `message:bounded-sql-history:${ordinal}`,
                    inputIntent: "turn_start",
                    text: `Turn ${ordinal}`,
                    attachments: [],
                  }
                : { type: "command_execution" }),
            })}
          )
        `;
      }

      for (const ordinal of [1, 1_000]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-sql-history:message:${ordinal}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: MessageId.make(`message:bounded-sql-history:${ordinal}`),
            threadId,
            runId: RunId.make(`run:bounded-sql-history:${ordinal}`),
            nodeId: NodeId.make(`node:bounded-sql-history:${ordinal}`),
            role: "user",
            text: `Turn ${ordinal}`,
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        });
      }
      const scopeId = CheckpointScopeId.make("scope:bounded-sql-history:root");
      const baselineId = CheckpointId.make("checkpoint:bounded-sql-history:baseline");
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:scope"),
        type: "checkpoint-scope.created",
        threadId,
        occurredAt: now,
        payload: {
          id: scopeId,
          threadId,
          runId: RunId.make("run:bounded-sql-history:1000"),
          nodeId: NodeId.make("node:bounded-sql-history:1000"),
          parentScopeId: null,
          providerThreadId: null,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo/worktree",
          createdAt: now,
        },
      });
      // A reused root scope can retain its original baseline on a node outside the window.
      yield* projectionStore.apply({
        id: EventId.make("event:bounded-sql-history:baseline"),
        type: "checkpoint.captured",
        threadId,
        occurredAt: now,
        payload: {
          id: baselineId,
          threadId,
          scopeId,
          runId: null,
          nodeId: NodeId.make("node:bounded-sql-history:1"),
          parentCheckpointId: null,
          ordinalWithinScope: 0,
          appRunOrdinal: null,
          ref: CheckpointRef.make("refs/t3/bounded-sql-history/0"),
          status: "ready",
          files: [],
          capturedAt: now,
        },
      });

      const snapshots = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 }),
        ),
        { concurrency: 4 },
      );
      for (const snapshot of snapshots) {
        assert.lengthOf(snapshot.projection.turnItems, 76);
        assert.lengthOf(snapshot.projection.runs, 76);
        assert.lengthOf(snapshot.projection.visibleTurnItems, 76);
        assert.strictEqual(snapshot.projection.turnItems[0]?.ordinal, 925);
        assert.strictEqual(snapshot.projection.turnItems.at(-1)?.ordinal, 1_000);
        assert.deepEqual(
          snapshot.projection.messages.map((message) => message.id),
          [MessageId.make("message:bounded-sql-history:1000")],
        );
        assert.deepEqual(
          snapshot.projection.checkpointScopes.map((scope) => scope.id),
          [scopeId],
        );
        assert.deepEqual(
          snapshot.projection.checkpoints.map((checkpoint) => checkpoint.id),
          [baselineId],
        );
      }

 // Selected message reads recover ordinals for only the loaded messages (upstream #27495).
      const firstMessageId = MessageId.make("message:bounded-sql-history:1");
      const lastMessageId = MessageId.make("message:bounded-sql-history:1000");
      const insertMessageItem = (
        suffix: string,
        itemThreadId: string,
        ordinal: number,
        messageId: string | null | undefined,
      ) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${`turn-item:bounded-sql-history:ordinal-${suffix}`}, ${itemThreadId}, NULL, NULL, NULL,
          NULL, NULL, ${ordinal}, 'assistant_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({ messageId })}
        )
      `;
      yield* insertMessageItem("duplicate", threadId, 0, lastMessageId);
      yield* insertMessageItem(
        "other-thread",
        "thread:bounded-sql-history:other",
        -1,
        firstMessageId,
      );
      yield* insertMessageItem("null-id", threadId, -2, null);
      yield* insertMessageItem("missing-id", threadId, -3, undefined);
      const absentMessageId = MessageId.make("message:bounded-sql-history:absent");
      const messageReadTrace = traceSqlStatements();
      const selected = yield* projectionStore
        .getMessagesById(threadId, [firstMessageId, lastMessageId, firstMessageId, absentMessageId])
        .pipe(Effect.withTracer(messageReadTrace.tracer));
      assert.isFalse(messageReadTrace.statements.some((query) => query.includes("turn_items")));
      assert.equal(selected.size, 2);
      assert.equal(selected.get(firstMessageId)?.id, firstMessageId);
      assert.equal(selected.get(lastMessageId)?.id, lastMessageId);
      assert.isFalse(selected.has(absentMessageId));
      assert.equal((yield* projectionStore.getMessagesById(threadId, [])).size, 0);
      assert.equal(
        (yield* projectionStore.getMessagesById(ThreadId.make("other-thread"), [firstMessageId]))
          .size,
        0,
      );
      const readMessageIds = (filter?: ProjectionStore.ProjectionRecordFilter) =>
        projectionStore
          .getThreadRecords(threadId, ["messages"], filter)
          .pipe(Effect.map(({ messages }) => messages.map((message) => message.id)));
      const canonical = yield* projectionStore.getThreadRecords(threadId, ["messages"]);
      for (const message of canonical.messages) assert.deepEqual(selected.get(message.id), message);
      assert.deepEqual(yield* readMessageIds(), [lastMessageId, firstMessageId]);
      assert.deepEqual(yield* readMessageIds({ messageRoles: ["user", "assistant"] }), [
        lastMessageId,
        firstMessageId,
      ]);
      for (const filter of [
        {
          messageIds: [
            firstMessageId,
            lastMessageId,
            MessageId.make("message:bounded-sql-history:absent"),
          ],
        },
        { messageRoles: ["user" as const] },
        {
          messageRunIds: [
            RunId.make("run:bounded-sql-history:1"),
            RunId.make("run:bounded-sql-history:1000"),
          ],
        },
      ]) {
        assert.deepEqual(yield* readMessageIds(filter), [lastMessageId, firstMessageId]);
      }
      assert.deepEqual(yield* readMessageIds({ messageIds: [] }), []);
      assert.deepEqual(yield* readMessageIds({ messageIds: [firstMessageId] }), [firstMessageId]);
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id LIKE 'turn-item:bounded-sql-history:ordinal-%'
      `;
      const retainedRequestPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH selected AS (
          SELECT run_id, type
          FROM orchestration_v2_projection_turn_items
          WHERE thread_id = ${threadId}
          ORDER BY ordinal DESC, turn_item_id DESC
          LIMIT 77
        )
        SELECT request.payload_json
        FROM orchestration_v2_projection_turn_items AS request
        WHERE request.run_id IN (
            SELECT run_id FROM selected
            WHERE type = 'run_interrupt_result' AND run_id IS NOT NULL
          )
          AND request.type = 'run_interrupt_request'
      `;
      assert.isTrue(
        retainedRequestPlan.some((row) =>
          row.detail.includes("orchestration_v2_projection_turn_items_run_ordinal_idx"),
        ),
      );

      const older = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: 76,
        anchorItemId: TurnItemId.make("turn-item:bounded-sql-history:925"),
      });
      assert.lengthOf(older.projection.turnItems, 76);
      assert.lengthOf(older.projection.runs, 76);
      assert.strictEqual(older.projection.turnItems[0]?.ordinal, 850);
      assert.strictEqual(older.projection.turnItems.at(-1)?.ordinal, 925);

      // A single item reads back with its full output, scoped to its thread.
      const itemId = TurnItemId.make("turn-item:bounded-sql-history:925");
      const stored = yield* projectionStore.getTurnItem({ threadId, itemId });
      assert.strictEqual(stored?.type === "command_execution" ? stored.output : undefined, "ok");
      assert.isNull(
        yield* projectionStore.getTurnItem({ threadId: ThreadId.make("thread:other"), itemId }),
      );

      const sqlPageLimit = THREAD_HISTORY_PAGE_POLICY.maxItems + 2;
      const initialSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const initialPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: initialSnapshot.projection,
        snapshotSequence: initialSnapshot.snapshotSequence,
      });
      const loadedIds = initialPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let cursor = initialPage.historyCursor;
      let pageCount = 1;
      while (cursor !== null) {
        const anchorItemId = TurnItemId.make(decodeThreadHistoryCursor(cursor).si);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
          rowLimit: sqlPageLimit,
          anchorItemId,
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        loadedIds.push(...page.items.map((row) => String(row.sourceItemId)));
        pageCount += 1;
        cursor = page.nextCursor;
      }

      assert.isAtLeast(pageCount, 4);
      assert.lengthOf(loadedIds, 1_000);
      assert.strictEqual(new Set(loadedIds).size, 1_000);
      assert.deepEqual(
        loadedIds.toSorted(
          (left, right) => Number(left.split(":").at(-1)) - Number(right.split(":").at(-1)),
        ),
        Array.from({ length: 1_000 }, (_, index) => `turn-item:bounded-sql-history:${index + 1}`),
      );

      // Physical insertion order must not change the ordinal/ID timeline order.
      const tiedIds = [
        TurnItemId.make("turn-item:bounded-sql-history:tie:b"),
        TurnItemId.make("turn-item:bounded-sql-history:tie:a"),
      ];
      for (const id of tiedIds) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          )
          SELECT ${id}, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, 2000, type, status, updated_at,
            json_set(payload_json, '$.id', ${id}, '$.ordinal', 2000)
          FROM orchestration_v2_projection_turn_items
          WHERE turn_item_id = ${itemId}
        `;
      }
      const tied = yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 3 });
      assert.deepEqual(
        tied.projection.turnItems.map((item) => item.id),
        [TurnItemId.make("turn-item:bounded-sql-history:1000"), tiedIds[1], tiedIds[0]],
      );
      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE turn_item_id IN ${sql.in(tiedIds)}
      `;

      const hiddenRunId = RunId.make("run:bounded-sql-history:hidden-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${hiddenRunId}, ${threadId}, 1001, 'codex', NULL, 'rolled_back', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: hiddenRunId,
            threadId,
            ordinal: 1001,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:hidden-suffix",
            rootNodeId: "node:bounded-sql-history:hidden-suffix",
            activeAttemptId: null,
            status: "rolled_back",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_001; ordinal <= 1_100; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:hidden:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${hiddenRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: hiddenRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "rolled back",
              input: "echo hidden",
              output: "hidden",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const hiddenSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const hiddenSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: hiddenSuffixSnapshot.projection,
        snapshotSequence: hiddenSuffixSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixPage.projection.visibleTurnItems, 75);
      assert.strictEqual(hiddenSuffixPage.latestLocalTurnOrdinal, 1_100);
      assert.isTrue(hiddenSuffixPage.hasMoreHistory);
      assert.isFalse(
        hiddenSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":hidden:"),
        ),
      );
      const hiddenSuffixCursor = hiddenSuffixPage.historyCursor;
      assert.isNotNull(hiddenSuffixCursor);
      const hiddenSuffixAnchor = TurnItemId.make(decodeThreadHistoryCursor(hiddenSuffixCursor!).si);
      const hiddenSuffixOlderSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        anchorItemId: hiddenSuffixAnchor,
      });
      const hiddenSuffixOlderPage = selectHistoryPageFromCursor({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        items: hiddenSuffixOlderSnapshot.projection.visibleTurnItems,
        cursor: hiddenSuffixCursor!,
        snapshotSequence: hiddenSuffixOlderSnapshot.snapshotSequence,
      });
      assert.lengthOf(hiddenSuffixOlderPage.items, 75);
      assert.isTrue(hiddenSuffixOlderPage.hasMoreHistory);

      const cancelledRunId = RunId.make("run:bounded-sql-history:cancelled-suffix");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${cancelledRunId}, ${threadId}, 1002, 'codex', NULL, 'cancelled', ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: cancelledRunId,
            threadId,
            ordinal: 1002,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: "message:bounded-sql-history:cancelled-suffix",
            rootNodeId: "node:bounded-sql-history:cancelled-suffix",
            activeAttemptId: null,
            status: "cancelled",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      for (let ordinal = 1_101; ordinal <= 1_200; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:cancelled:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, ${ordinal},
            'user_message', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              createdBy: "user",
              creationSource: "web",
              id,
              threadId,
              runId: cancelledRunId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "cancelled queued message",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "user_message",
              messageId: `message:bounded-sql-history:cancelled:${ordinal}`,
              inputIntent: "queued_turn",
              text: "cancelled",
              attachments: [],
            })}
          )
        `;
      }
      const runlessQueuedId = "turn-item:bounded-sql-history:runless-queued";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${runlessQueuedId}, ${threadId}, NULL, NULL, NULL, NULL, NULL, 1201,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: runlessQueuedId,
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1201,
            status: "completed",
            title: "runless queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:runless-queued",
            inputIntent: "queued_turn",
            text: "still visible",
            attachments: [],
          })}
        )
      `;
      const laterCancelledId = "turn-item:bounded-sql-history:cancelled:1202";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${laterCancelledId}, ${threadId}, ${cancelledRunId}, NULL, NULL, NULL, NULL, 1202,
          'user_message', 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            createdBy: "user",
            creationSource: "web",
            id: laterCancelledId,
            threadId,
            runId: cancelledRunId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1202,
            status: "completed",
            title: "later cancelled queued message",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:bounded-sql-history:cancelled:1202",
            inputIntent: "queued_turn",
            text: "cancelled",
            attachments: [],
          })}
        )
      `;
      const cancelledSuffixSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      const cancelledSuffixPage = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: cancelledSuffixSnapshot.projection,
        snapshotSequence: cancelledSuffixSnapshot.snapshotSequence,
      });
      assert.strictEqual(cancelledSuffixPage.latestLocalTurnOrdinal, 1_202);
      assert.lengthOf(cancelledSuffixPage.projection.visibleTurnItems, 75);
      assert.isFalse(
        cancelledSuffixPage.projection.visibleTurnItems.some((row) =>
          String(row.sourceItemId).includes(":cancelled:"),
        ),
      );
      assert.isTrue(
        cancelledSuffixPage.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === runlessQueuedId,
        ),
      );

      const interruptRunId = RunId.make("run:bounded-sql-history:interrupt");
      const interruptNodeId = NodeId.make("node:bounded-sql-history:interrupt");
      const interruptRequestId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-request");
      const interruptResultId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-result");
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs (
          run_id, thread_id, ordinal, provider, provider_thread_id, status,
          requested_at, completed_at, payload_json
        ) VALUES (
          ${interruptRunId}, ${threadId}, 1003, 'codex', 'provider-thread:interrupt', 'completed',
          ${nowIso}, ${nowIso},
          ${encodeUnknownJsonString({
            id: interruptRunId,
            threadId,
            ordinal: 1003,
            providerInstanceId,
            modelSelection,
            providerThreadId: "provider-thread:interrupt",
            userMessageId: "message:interrupt",
            rootNodeId: interruptNodeId,
            activeAttemptId: "attempt:bounded-sql-history:interrupt",
            status: "completed",
            requestedAt: nowIso,
            startedAt: nowIso,
            completedAt: nowIso,
            checkpointId: null,
            contextHandoffId: null,
          })}
        )
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:bounded-sql-history:interrupt', ${threadId}, ${interruptRunId}, 1,
          ${interruptNodeId}, 'codex', ${providerInstanceId}, 'provider-thread:interrupt', NULL,
          'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:bounded-sql-history:interrupt",
            runId: interruptRunId,
            attemptOrdinal: 1,
            rootNodeId: interruptNodeId,
            providerInstanceId,
            providerThreadId: "provider-thread:interrupt",
            providerTurnId: null,
            reason: "initial",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      const insertInterruptItem = (input: {
        id: TurnItemId;
        ordinal: number;
        type: "run_interrupt_request" | "run_interrupt_result";
      }) => sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${input.id}, ${threadId}, ${interruptRunId}, ${interruptNodeId}, NULL, NULL, NULL,
          ${input.ordinal}, ${input.type}, 'completed', ${nowIso},
          ${encodeUnknownJsonString({
            id: input.id,
            threadId,
            runId: interruptRunId,
            nodeId: interruptNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: input.ordinal,
            status: "completed",
            title: input.type,
            message: input.type === "run_interrupt_request" ? "Stopping" : "Stopped",
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: input.type,
          })}
        )
      `;
      yield* insertInterruptItem({
        id: interruptRequestId,
        ordinal: 1_201,
        type: "run_interrupt_request",
      });
      for (let ordinal = 1_202; ordinal <= 1_281; ordinal += 1) {
        const id = `turn-item:bounded-sql-history:interrupt-filler:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${threadId}, NULL, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId,
              runId: null,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "filler",
              input: "echo filler",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      yield* insertInterruptItem({
        id: interruptResultId,
        ordinal: 1_282,
        type: "run_interrupt_result",
      });

      const interruptSnapshot = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
      });
      assert.isTrue(
        interruptSnapshot.projection.turnItems.some((item) => item.id === interruptRequestId),
      );
      assert.isTrue(
        interruptSnapshot.projection.visibleTurnItems.some(
          (row) => row.sourceItemId === interruptResultId,
        ),
      );

      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET payload_json = json_set(payload_json, '$.createdBy', 'agent')
        WHERE thread_id = ${threadId} AND type = 'user_message'
      `;
      const agentPromptId = TurnItemId.make("turn-item:bounded-sql-history:interrupt-filler:1281");
      yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'user_message',
          payload_json = json_set(payload_json,
            '$.type', 'user_message', '$.inputIntent', 'turn_start',
            '$.createdBy', 'agent', '$.creationSource', 'provider',
            '$.messageId', 'message:bounded-sql-history:agent-prompt',
            '$.text', 'Continue the child task', '$.attachments', json('[]'))
        WHERE turn_item_id = ${agentPromptId}
      `;
      const agentWindow = yield* projectionStore.getThreadSnapshotWindow(threadId, {
        rowLimit: sqlPageLimit,
        userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
      });
      assert.lengthOf(
        agentWindow.projection.visibleTurnItems.filter(
          (row) => row.item.type !== "run_interrupt_request",
        ),
        sqlPageLimit,
      );
      assert.isTrue(
        agentWindow.projection.visibleTurnItems.some((row) => row.sourceItemId === agentPromptId),
      );
    }),
  );

  it.effect("scopes actionable provider state to the requested bounded thread", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:bounded-provider-scope");
      const targetThreadId = ThreadId.make("thread:bounded-provider-scope:target");
      const unrelatedThreadId = ThreadId.make("thread:bounded-provider-scope:unrelated");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: String(threadId),
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
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
      });
      for (const threadId of [targetThreadId, unrelatedThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:thread:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
        const sessionId = ProviderSessionId.make(`provider-session:${threadId}`);
        const providerThreadId = ProviderThreadId.make(`provider-thread:${threadId}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:session:${threadId}`),
          type: "provider-session.attached",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: sessionId,
            driver,
            providerInstanceId,
            status: "running",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:bounded-provider-scope:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver,
            providerInstanceId,
            providerSessionId: sessionId,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      }

      const snapshot = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 10,
      });

      assert.deepEqual(
        snapshot.projection.providerSessions.map((session) => session.id),
        [ProviderSessionId.make(`provider-session:${targetThreadId}`)],
      );
      assert.deepEqual(
        snapshot.projection.providerThreads.map((thread) => thread.id),
        [ProviderThreadId.make(`provider-thread:${targetThreadId}`)],
      );
    }),
  );

  it.effect("projects root provider owners into the shell in first-use order", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:provider-history");
      const threadId = ThreadId.make("thread:provider-history");
      const claudeInstanceId = ProviderInstanceId.make("claude");
      const claudeDriver = ProviderDriverKind.make("claudeAgent");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-history:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Provider history",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
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
      });
      const providerThreads = [
        // The root Codex conversation, then a Claude subagent it delegated to
        // (owned by a node, so not a handoff), then the handoff target.
        { suffix: "codex", instanceId: providerInstanceId, ownerNodeId: null, seconds: 0 },
        {
          suffix: "claude-subagent",
          instanceId: claudeInstanceId,
          ownerNodeId: NodeId.make("node:provider-history"),
          seconds: 1,
        },
        { suffix: "claude", instanceId: claudeInstanceId, ownerNodeId: null, seconds: 2 },
        // A second Codex conversation after handing back: no duplicate entry.
        { suffix: "codex-again", instanceId: providerInstanceId, ownerNodeId: null, seconds: 3 },
      ] as const;
      for (const providerThread of providerThreads) {
        const createdAt = DateTime.add(now, { seconds: providerThread.seconds });
        yield* projectionStore.apply({
          id: EventId.make(`event:provider-history:${providerThread.suffix}`),
          type: "provider-thread.updated",
          threadId,
          driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
          occurredAt: createdAt,
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-history:${providerThread.suffix}`),
            driver: providerThread.instanceId === claudeInstanceId ? claudeDriver : driver,
            providerInstanceId: providerThread.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: providerThread.ownerNodeId,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            createdAt,
            updatedAt: createdAt,
          },
        });
      }

      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.deepEqual(shell?.providerInstanceHistory, [providerInstanceId, claudeInstanceId]);
    }),
  );

  it.effect("shows the native goal of the active provider thread on the shell", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:provider-goal");
      yield* projectionStore.apply({
        id: EventId.make("event:provider-goal:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:provider-goal"),
          title: "Provider goal",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
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
      });
      const applyProviderThread = (
        suffix: string,
        goal: OrchestrationV2ProviderThread["goal"],
        seconds: number,
      ) =>
        projectionStore.apply({
          id: EventId.make(`event:provider-goal:${suffix}:${seconds}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          occurredAt: DateTime.add(now, { seconds }),
          payload: {
            id: ProviderThreadId.make(`provider-thread:provider-goal:${suffix}`),
            driver,
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            goal,
            createdAt: now,
            updatedAt: DateTime.add(now, { seconds }),
          },
        });
      const shellGoal = Effect.map(
        projectionStore.getShellSnapshot(),
        (snapshot) => snapshot.threads.find((thread) => thread.id === threadId)?.goal,
      );
      const goal = { objective: "Ship it", status: "active" as const, tokensUsed: 10 };

      yield* applyProviderThread("first", goal, 0);
      assert.deepEqual(yield* shellGoal, goal);
      // A handoff moves the conversation; the previous provider's goal stays behind.
      yield* applyProviderThread("second", null, 1);
      assert.isNull(yield* shellGoal);
    }),
  );

  it.effect("reads the shell snapshot first and decodes it in a separate step", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const createThread = (threadId: ThreadId) =>
        projectionStore.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:shell-read"),
            title: "Shell read",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
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
        });
      const readThreadId = ThreadId.make("thread:shell-read:before");
      const laterThreadId = ThreadId.make("thread:shell-read:after");
      const shellIds = (snapshot: OrchestrationV2ThreadShellSnapshot) =>
        snapshot.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId);

      yield* createThread(readThreadId);
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.linkedPullRequest', json(${JSON.stringify({
          projectId: "project:shell-read",
          repository: "acme/project",
          number: 42,
          url: "https://github.com/acme/project/pull/42",
        })})) WHERE thread_id = ${readThreadId}`;
      const trace = traceSqlStatements();
      const discovery = yield* projectionStore
        .getPullRequestSnapshot({})
        .pipe(Effect.withTracer(trace.tracer));
      assert.deepEqual(
        discovery.threads
          .map((thread) => thread.id)
          .filter((id) => id === readThreadId || id === laterThreadId),
        [readThreadId],
      );
      assert.strictEqual(discovery.snapshotSequence, 0);
      assert.strictEqual(trace.queryTransactions.length, 2);
      assert.isNotNull(trace.queryTransactions[0]);
      assert.strictEqual(new Set(trace.queryTransactions).size, 1);
      assert.isFalse(
        trace.statements.some((query) =>
          /orchestration_v2_projection_(runs|messages|turn_items|provider_threads)/.test(query),
        ),
      );
      const fullShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === readThreadId,
      )!;
      const metadata = discovery.threads.find((thread) => thread.id === readThreadId)!;
      for (const key of Object.keys(metadata) as Array<keyof typeof metadata>) {
        assert.deepEqual(metadata[key], fullShell[key]);
      }
      const narrow = yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId });
      assert.deepEqual(
        narrow.threads,
        discovery.threads.filter((thread) => thread.id === readThreadId),
      );
      const settledPayload = (settledAt: string | null, archivedAt: string | null) => sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.settledAt', ${settledAt}, '$.archivedAt', ${archivedAt})
        WHERE thread_id = ${readThreadId}
      `;
      yield* settledPayload(DateTime.formatIso(now), null);
      assert.isFalse(
        (yield* projectionStore.getPullRequestSnapshot({ unsettledOnly: true })).threads.some(
          (thread) => thread.id === readThreadId,
        ),
      );
      assert.strictEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads.length,
        1,
      );
      yield* settledPayload(null, DateTime.formatIso(now));
      assert.isFalse(
        (yield* projectionStore.getPullRequestSnapshot({})).threads.some(
          (thread) => thread.id === readThreadId,
        ),
      );
      assert.strictEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads.length,
        1,
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = '2026-11-03T00:00:00.000Z' WHERE thread_id = ${readThreadId}`;
      assert.deepEqual(
        (yield* projectionStore.getPullRequestSnapshot({ threadId: readThreadId })).threads,
        [],
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${readThreadId}`;
      yield* settledPayload(null, null);
      const decode = yield* sql.withTransaction(projectionStore.readShellSnapshot());
      // Commits between the read and the decode, as another request can while
      // the HTTP and WebSocket loaders decode outside their transaction.
      yield* createThread(laterThreadId);

      assert.deepEqual(shellIds(yield* decode), [readThreadId]);
      assert.sameMembers(shellIds(yield* projectionStore.getShellSnapshot()), [
        readThreadId,
        laterThreadId,
      ]);

      // No decoding under the read transaction: a payload that cannot decode
      // fails the returned step, not the read.
      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${laterThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${laterThreadId}`;
      yield* setPayload("{}");
      const failure = yield* sql
        .withTransaction(projectionStore.readShellSnapshot())
        .pipe(
          Effect.flatMap(Effect.flip),
          Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))),
        );
      assert.strictEqual(failure._tag, "ProjectionStoreReadError");
    }),
  );

  it.effect("reads only the requested project's threads into a scoped shell snapshot", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const { projectId, activeThreadId, forkThreadId, otherThreadId } =
        yield* assertProjectScopedShells("sql-project-shell");

      // A thread in another project that cannot decode fails the unscoped
      // snapshot, so a scoped snapshot that succeeds never read it.
      const [stored] = yield* sql<{ readonly payload_json: string }>`
        SELECT payload_json FROM orchestration_v2_projection_threads
        WHERE thread_id = ${otherThreadId}
      `;
      const setPayload = (payload: string) =>
        sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${payload}
          WHERE thread_id = ${otherThreadId}`;
      yield* setPayload("{}");
      const [unscoped, scoped] = yield* Effect.all([
        projectionStore.getShellSnapshot().pipe(Effect.flip),
        projectionStore.getShellSnapshot({ projectId, location: "active" }),
      ]).pipe(Effect.ensuring(Effect.orDie(setPayload(stored!.payload_json))));
      assert.strictEqual(unscoped._tag, "ProjectionStoreReadError");
      assert.sameMembers(
        scoped.threads.map((thread) => thread.id),
        [activeThreadId, forkThreadId],
      );
    }),
  );

  it.effect("binds only the requested worktree's threads into a scoped shell snapshot", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const { worktreePath, ids } = yield* assertWorktreeScopedShells("sql-worktree-shell");
      const boundBy = (options?: ProjectionStore.ShellSnapshotOptions) => {
        const bound: Array<string> = [];
        const record: Statement.Transformer = (statement) => {
          bound.push(JSON.stringify(statement.compile()[1]));
          return Effect.succeed(statement);
        };
        return projectionStore
          .getShellSnapshot(options)
          .pipe(
            Effect.provideService(Statement.CurrentTransformer, record),
            Effect.as(bound),
          );
      };
      const binds = (bound: ReadonlyArray<string>, threadId: ThreadId) =>
        bound.some((params) => params.includes(threadId));
      // Every per-thread read binds the threads it reads: all four unscoped, one here.
      const unscoped = yield* boundBy();
      const scoped = yield* boundBy({ worktreePath });
      assert.deepEqual(
        [ids.active, ids.archived, ids.otherWorktree, ids.noWorktree].map((threadId) => [
          binds(unscoped, threadId),
          binds(scoped, threadId),
        ]),
        [
          [true, true],
          [true, true],
          [true, false],
          [true, false],
        ],
      );
    }),
  );

  it.effect("reads a run's turn-start items by thread and run, not by walking thread history", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:turn-start-items");
      const otherThreadId = ThreadId.make("thread:turn-start-items:other");
      const selectedRunId = RunId.make("run:turn-start-items:selected");
      const emptyRunId = RunId.make("run:turn-start-items:empty");
      const siblingRunId = RunId.make("run:turn-start-items:sibling");

      for (const id of [threadId, otherThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:${id}:created`),
          type: "thread.created",
          threadId: id,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id,
            projectId: ProjectId.make("project:turn-start-items"),
            title: id,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      }
      for (const [ordinal, runId] of [selectedRunId, emptyRunId, siblingRunId].entries()) {
        yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, provider_thread_id, status,
            requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, ${ordinal + 1}, 'codex', NULL, 'completed', ${nowIso}, ${nowIso},
            ${encodeUnknownJsonString({
              id: runId,
              threadId,
              ordinal: ordinal + 1,
              providerInstanceId,
              modelSelection,
              providerThreadId: null,
              userMessageId: `message:${runId}`,
              rootNodeId: `node:${runId}`,
              activeAttemptId: null,
              status: "completed",
              requestedAt: nowIso,
              startedAt: nowIso,
              completedAt: nowIso,
              checkpointId: null,
              contextHandoffId: null,
            })}
          )
        `;
      }

      const insertItem = (
        id: string,
        itemThreadId: ThreadId,
        runId: string | null,
        ordinal: number,
      ) =>
        sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${itemThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: itemThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: id,
              input: "echo",
              output: "ok",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      const addHistory = (from: number, to: number) => sql`
        WITH RECURSIVE history(position) AS (
          SELECT ${from} UNION ALL SELECT position + 1 FROM history WHERE position < ${to}
        )
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        )
        SELECT 'item:turn-start-items:history:' || position, ${threadId},
          'run:turn-start-items:history:' || (position % 100), NULL, NULL, NULL, NULL, position,
          'command_execution', 'completed', ${nowIso},
          json_object(
            'id', 'item:turn-start-items:history:' || position,
            'threadId', ${threadId},
            'runId', 'run:turn-start-items:history:' || (position % 100),
            'nodeId', NULL, 'providerThreadId', NULL, 'providerTurnId', NULL,
            'nativeItemRef', NULL, 'parentItemId', NULL, 'ordinal', position,
            'status', 'completed', 'title', 'history', 'input', 'echo', 'output', 'ok',
            'exitCode', 0, 'startedAt', ${nowIso}, 'completedAt', ${nowIso},
            'updatedAt', ${nowIso}, 'type', 'command_execution'
          )
        FROM history
      `;

      // Twelve ordinals with two items each, inserted in reverse id order.
      const selectedIds: Array<string> = [];
      for (let slot = 1; slot <= 12; slot += 1) {
        for (const suffix of ["b", "a"]) {
          yield* insertItem(
            `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:${suffix}`,
            threadId,
            selectedRunId,
            slot * 100,
          );
        }
        selectedIds.push(
          `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:a`,
          `item:turn-start-items:selected:${String(slot).padStart(2, "0")}:b`,
        );
      }
      yield* insertItem("item:turn-start-items:no-run", threadId, null, 100);
      yield* insertItem("item:turn-start-items:sibling:1", threadId, siblingRunId, 100);
      yield* insertItem("item:turn-start-items:sibling:2", threadId, siblingRunId, 101);
      yield* insertItem("item:turn-start-items:other-thread:b", otherThreadId, selectedRunId, 100);
      yield* insertItem("item:turn-start-items:other-thread:a", otherThreadId, selectedRunId, 100);

      const readItems = Effect.fn("readTurnStartItems")(function* (
        readThreadId: ThreadId,
        readRunId: RunId,
      ) {
        const { statements, tracer } = traceSqlStatements();
        const context = yield* projectionStore
          .getTurnStartContext(readThreadId, readRunId)
          .pipe(Effect.withTracer(tracer));
        const lookups = statements.filter((statement) =>
          statement.includes("FROM orchestration_v2_projection_turn_items"),
        );
        assert.lengthOf(lookups, 1);
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${lookups[0]}`,
          [readThreadId, readRunId],
        )).map((row) => row.detail);
        return { ids: context.turnItems.map((item) => item.id), plan };
      });

      const lookupPlans: Array<ReadonlyArray<string>> = [];
      for (const [from, to] of [
        [1, 1_000],
        [1_001, 10_000],
      ] as const) {
        yield* addHistory(from, to);
        const { ids, plan } = yield* readItems(threadId, selectedRunId);
        assert.deepEqual(ids, selectedIds);
        lookupPlans.push(plan);
      }

      assert.deepEqual((yield* readItems(threadId, emptyRunId)).ids, []);
      assert.deepEqual(
        (yield* readItems(threadId, RunId.make("run:turn-start-items:missing"))).ids,
        [],
      );
      assert.deepEqual((yield* readItems(threadId, siblingRunId)).ids, [
        "item:turn-start-items:sibling:1",
        "item:turn-start-items:sibling:2",
      ]);
      assert.deepEqual((yield* readItems(otherThreadId, selectedRunId)).ids, [
        "item:turn-start-items:other-thread:a",
        "item:turn-start-items:other-thread:b",
      ]);
      assert.deepEqual((yield* readItems(otherThreadId, siblingRunId)).ids, []);

      for (const plan of lookupPlans) {
        const lookup = plan.filter((detail) =>
          detail.includes("orchestration_v2_projection_turn_items"),
        );
        assert.lengthOf(lookup, 1);
        assert.match(
          lookup[0]!,
          /^SEARCH .*\((?:thread_id=\? AND )?run_id=\?(?: AND thread_id=\?)?\)$/,
        );
      }
    }),
  );

  it.effect(
    "counts each shell's own runless and live-run items, skipping rolled back and missing runs",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const now = yield* DateTime.now;
        const projectId = ProjectId.make("project:shell-item-counts");
        const busyThreadId = ThreadId.make("thread:shell-item-counts:busy");
        const emptyThreadId = ThreadId.make("thread:shell-item-counts:empty");
        const otherThreadId = ThreadId.make("thread:shell-item-counts:other");
        for (const threadId of [busyThreadId, emptyThreadId, otherThreadId]) {
          yield* projectionStore.apply({
            id: EventId.make(`event:${threadId}:created`),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: {
              createdBy: "user",
              creationSource: "web",
              id: threadId,
              projectId,
              title: threadId,
              providerInstanceId,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: null,
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
          });
        }
        const applyRun = (
          threadId: ThreadId,
          suffix: string,
          ordinal: number,
          rolledBack: boolean,
        ) => {
          const runId = RunId.make(`run:shell-item-counts:${suffix}`);
          const rootNodeId = NodeId.make(`node:shell-item-counts:${suffix}`);
          return projectionStore
            .apply({
              id: EventId.make(`event:shell-item-counts:${suffix}:run`),
              type: "run.created",
              threadId,
              runId,
              nodeId: rootNodeId,
              driver,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal,
                providerInstanceId,
                modelSelection,
                providerThreadId: null,
                userMessageId: MessageId.make(`message:shell-item-counts:${suffix}:user`),
                rootNodeId,
                activeAttemptId: null,
                status: rolledBack ? "rolled_back" : "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            })
            .pipe(Effect.as(runId));
        };
        let ordinal = 0;
        const applyItem = (threadId: ThreadId, runId: RunId | null) => {
          ordinal += 1;
          return projectionStore.apply({
            id: EventId.make(`event:shell-item-counts:item:${ordinal}`),
            type: "turn-item.updated",
            threadId,
            ...(runId === null ? {} : { runId }),
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`turn-item:shell-item-counts:${ordinal}`),
              threadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "assistant_message",
              messageId: MessageId.make(`message:shell-item-counts:${ordinal}`),
              text: `item ${ordinal}`,
              streaming: false,
            },
          });
        };

        const completedRunId = yield* applyRun(busyThreadId, "busy-completed", 1, false);
        const rolledBackRunId = yield* applyRun(busyThreadId, "busy-rolled-back", 2, true);
        const otherRunId = yield* applyRun(otherThreadId, "other", 1, false);
        yield* applyItem(busyThreadId, null);
        yield* applyItem(busyThreadId, null);
        yield* applyItem(busyThreadId, completedRunId);
        yield* applyItem(busyThreadId, completedRunId);
        yield* applyItem(busyThreadId, rolledBackRunId);
        yield* applyItem(busyThreadId, RunId.make("run:shell-item-counts:missing"));
        yield* applyItem(otherThreadId, otherRunId);

        const snapshot = yield* projectionStore.getShellSnapshot({ projectId });
        const expected = [
          [busyThreadId, 4],
          [emptyThreadId, 0],
          [otherThreadId, 1],
        ] as const;
        for (const [threadId, itemCount] of expected) {
          const shell = yield* projectionStore.getThreadShell(threadId);
          assert.deepEqual(
            snapshot.threads.find((thread) => thread.id === threadId),
            shell ?? undefined,
          );
          assert.equal(shell?.itemCount, itemCount);
        }
      }),
  );

  it.effect("does not treat visited or marked-unread state as thread activity", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const visitedOccurredAt = DateTime.add(createdAt, { seconds: 1 });
      const markedUnreadOccurredAt = DateTime.add(createdAt, { seconds: 2 });
      const threadId = ThreadId.make("thread:projection-read-state");
      const projectId = ProjectId.make("project:projection-read-state");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Projection read state",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:visited"),
        type: "thread.visited",
        threadId,
        occurredAt: visitedOccurredAt,
        payload: { ...thread, lastVisitedAt: createdAt },
      });

      const visited = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(visited.thread.lastVisitedAt, createdAt);
      assert.deepEqual(visited.thread.updatedAt, createdAt);

      yield* projectionStore.apply({
        id: EventId.make("event:projection-read-state:marked-unread"),
        type: "thread.marked-unread",
        threadId,
        occurredAt: markedUnreadOccurredAt,
        payload: thread,
      });

      const markedUnread = yield* projectionStore.getThreadProjection(threadId);
      assert.isNull(markedUnread.thread.lastVisitedAt);
      assert.deepEqual(markedUnread.thread.updatedAt, createdAt);
    }),
  );

  it.effect("dates thread activity by a run event and leaves the rest of the thread alone", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const createdAt = yield* DateTime.now;
      const runOccurredAt = DateTime.add(createdAt, { seconds: 5 });
      const threadId = ThreadId.make("thread:projection-activity");
      const runId = RunId.make("run:projection-activity");
      const rootNodeId = NodeId.make("node:projection-activity");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:projection-activity"),
        title: "Projection activity",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: "feature/activity",
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt,
        updatedAt: createdAt,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: createdAt,
        deletedAt: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-activity:created"),
        type: "thread.created",
        threadId,
        occurredAt: createdAt,
        payload: thread,
      });
      const created = (yield* projectionStore.getThreadProjection(threadId)).thread;

      const { statements, tracer } = traceSqlStatements();
      yield* projectionStore
        .apply({
          id: EventId.make("event:projection-activity:run-created"),
          type: "run.created",
          threadId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: runOccurredAt,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:projection-activity"),
            rootNodeId,
            activeAttemptId: null,
            status: "running" as const,
            requestedAt: runOccurredAt,
            startedAt: runOccurredAt,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        })
        .pipe(Effect.withTracer(tracer));
      // The thread row is patched in place, never read back to be re-encoded.
      assert.isEmpty(
        statements.filter(
          (statement) =>
            /^\s*SELECT/i.test(statement) &&
            statement.includes("orchestration_v2_projection_threads"),
        ),
      );

      const active = (yield* projectionStore.getThreadProjection(threadId)).thread;
      assert.deepEqual(active, { ...created, updatedAt: runOccurredAt });
      const shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (candidate) => candidate.id === threadId,
      );
      assert.deepEqual(shell?.updatedAt, runOccurredAt);
    }),
  );

  it.effect("preserves delegated completion ownership across stale run and task updates", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { seconds: 1 });
      const threadId = ThreadId.make("thread:projection-delegated-completion");
      const projectId = ProjectId.make("project:projection-delegated-completion");
      const runId = RunId.make("run:projection-delegated-completion");
      const rootNodeId = NodeId.make("node:projection-delegated-completion-root");
      const taskId = NodeId.make("node:projection-delegated-completion-task");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Delegated completion projection",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-delegated-completion"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
        delegatedCompletion: {
          disposition: "stopped" as const,
          nextGeneration: 2,
          delivery: null,
        },
      };
      const task = {
        id: taskId,
        threadId,
        runId,
        parentNodeId: rootNodeId,
        origin: "app_owned" as const,
        createdBy: "agent" as const,
        driver,
        providerInstanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Inspect the stop barrier.",
        title: null,
        model: null,
        completionWake: "always" as const,
        completionDelivery: {
          state: "disposed" as const,
          observedByRunId: null,
        },
        status: "running" as const,
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: thread,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: run,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: task,
      });

      const { delegatedCompletion: _delegatedCompletion, ...staleRun } = run;
      const { completionDelivery: _completionDelivery, ...staleTask } = task;
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-run"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: later,
        payload: { ...staleRun, status: "interrupted", completedAt: later },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-delegated-completion:stale-task"),
        type: "subagent.updated",
        threadId,
        runId,
        nodeId: taskId,
        driver,
        providerInstanceId,
        occurredAt: later,
        payload: {
          ...staleTask,
          status: "interrupted",
          completedAt: later,
          updatedAt: later,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);
      assert.deepEqual(projection.runs[0]?.delegatedCompletion, run.delegatedCompletion);
      assert.deepEqual(projection.subagents[0]?.completionDelivery, task.completionDelivery);

      // A task wait reads only the task it watches.
      const subagentIds = (ids: ReadonlyArray<NodeId>) =>
        projectionStore
          .getThreadRecords(threadId, ["subagents"], { subagentIds: ids })
          .pipe(Effect.map(({ subagents }) => subagents.map((subagent) => subagent.id)));
      assert.deepEqual(yield* subagentIds([taskId]), [taskId]);
      assert.deepEqual(yield* subagentIds([NodeId.make("node:projection-other-task")]), []);
      assert.deepEqual(yield* subagentIds([]), []);
      assert.deepEqual(
        (yield* projectionStore.getThreadRecords(threadId, ["subagents"], {
          omitSettledSubagents: true,
        })).subagents,
        [],
      );
    }),
  );

  it.effect("only exposes interruptible runs through the shell activeRunId", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-shell-interruptible");
      const projectId = ProjectId.make("project:projection-shell-interruptible");
      const runId = RunId.make("run:projection-shell-interruptible");
      const rootNodeId = NodeId.make("node:projection-shell-interruptible");
      const run = {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId,
        modelSelection,
        providerThreadId: null,
        userMessageId: MessageId.make("message:projection-shell-interruptible"),
        rootNodeId,
        activeAttemptId: null,
        status: "running" as const,
        requestedAt: now,
        startedAt: now,
        completedAt: null,
        checkpointId: null,
        contextHandoffId: null,
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:thread"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Interruptible shell run",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:running"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: run,
      });

      let shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "running");
      assert.equal(shell?.activeRunId, runId);
      assert.equal(
        shell?.latestRunRequestedAt && DateTime.toEpochMillis(shell.latestRunRequestedAt),
        DateTime.toEpochMillis(now),
      );
      assert.equal(
        shell?.latestRunStartedAt && DateTime.toEpochMillis(shell.latestRunStartedAt),
        DateTime.toEpochMillis(now),
      );
      assert.isNull(shell?.latestRunCompletedAt);

      const requestId = RuntimeRequestId.make("request:projection-shell-question");
      for (const [responseCapability, blocking] of [
        [{ type: "message" }, false],
        [{ type: "live", providerSessionId: ProviderSessionId.make("session:question") }, true],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shell-question:${responseCapability.type}`),
          type: "runtime-request.updated",
          threadId,
          nodeId: rootNodeId,
          driver,
          occurredAt: now,
          payload: {
            id: requestId,
            nodeId: rootNodeId,
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "user_input",
            status: "pending",
            responseCapability,
            createdAt: now,
            resolvedAt: null,
          },
        });
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
          (row) => row.id === threadId,
        )!;
        for (const questionShell of [
          sqlShell,
          ProjectionStore.threadShellFromProjection(projection),
        ]) {
          assert.equal(questionShell.activeRunId, runId);
          assert.deepEqual(questionShell.pendingRuntimeRequest, {
            id: requestId,
            kind: "user_input",
            createdAt: now,
            blocking,
          });
        }
      }

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:waiting"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: { ...run, status: "waiting" },
      });

      shell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      assert.equal(shell?.status, "waiting");
      assert.isNull(shell?.activeRunId);
      const later = DateTime.add(now, { hours: 1 });
      for (const status of ["queued", "cancelled"] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:clock:newer:${status}`),
          type: "run.updated",
          threadId,
          occurredAt: later,
          payload: {
            ...run,
            id: RunId.make("run:clock:newer"),
            ordinal: 2,
            status,
            requestedAt: later,
            startedAt: null,
            completedAt: status === "cancelled" ? later : null,
          },
        });
        for (const activityStatus of ["preparing", "running", "waiting", "completed"] as const) {
          yield* projectionStore.apply({
            id: EventId.make(`event:clock:${status}:${activityStatus}`),
            type: "run.updated",
            threadId,
            occurredAt: later,
            payload: {
              ...run,
              status: activityStatus,
              startedAt: activityStatus === "preparing" ? null : now,
              completedAt: activityStatus === "completed" ? later : null,
            },
          });
          const projection = yield* projectionStore.getThreadProjection(threadId);
          const sqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
            (row) => row.id === threadId,
          )!;
          const memoryShell = ProjectionStore.threadShellFromProjection(projection);
          const expected = activityStatus === "completed" ? null : DateTime.toEpochMillis(now);
          const timestamp = (value: DateTime.Utc | null | undefined) =>
            value == null ? null : DateTime.toEpochMillis(value);
          assert.equal(timestamp(sqlShell.activityRunStartedAt), expected);
          assert.equal(timestamp(memoryShell.activityRunStartedAt), expected);
          assert.equal(sqlShell.latestRunId, "run:clock:newer");
        }
      }

      // A held queue waits for the user, so both shells present the run before
      // it rather than reporting queued work.
      yield* projectionStore.apply({
        id: EventId.make("event:clock:newer:held"),
        type: "run.updated",
        threadId,
        occurredAt: later,
        payload: {
          ...run,
          id: RunId.make("run:clock:newer"),
          ordinal: 2,
          status: "queued",
          queueHeld: true,
          requestedAt: later,
          startedAt: null,
          completedAt: null,
        },
      });
      const heldProjection = yield* projectionStore.getThreadProjection(threadId);
      const heldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const heldShell of [
        heldSqlShell,
        ProjectionStore.threadShellFromProjection(heldProjection),
      ]) {
        assert.equal(heldShell.latestRunId, runId);
        assert.equal(heldShell.status, "completed");
      }

      // With only held runs, nothing has executed: both shells read idle.
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:held-first"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: { ...run, status: "queued", queueHeld: true, startedAt: null, completedAt: null },
      });
      const onlyHeldProjection = yield* projectionStore.getThreadProjection(threadId);
      const onlyHeldSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const onlyHeldShell of [
        onlyHeldSqlShell,
        ProjectionStore.threadShellFromProjection(onlyHeldProjection),
      ]) {
        assert.isNull(onlyHeldShell.latestRunId);
        assert.equal(onlyHeldShell.status, "idle");
      }

      // A wake run counts from the start of the work it continues.
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-interruptible:wake"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: later,
        payload: {
          ...run,
          status: "running",
          requestedAt: later,
          startedAt: later,
          workStartedAt: now,
        },
      });
      const wakeProjection = yield* projectionStore.getThreadProjection(threadId);
      const wakeSqlShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      for (const wakeShell of [
        wakeSqlShell,
        ProjectionStore.threadShellFromProjection(wakeProjection),
      ]) {
        assert.equal(
          wakeShell.activityRunStartedAt && DateTime.toEpochMillis(wakeShell.activityRunStartedAt),
          DateTime.toEpochMillis(now),
        );
      }
    }),
  );

  it.effect("selects only threads with runtime state that needs recovery", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const settledThreadId = ThreadId.make("thread:recovery-candidates:settled");
      const runningThreadId = ThreadId.make("thread:recovery-candidates:running");
      const memberThreadId = ThreadId.make("thread:recovery-candidates:member");
      const childThreadId = ThreadId.make("thread:recovery-candidates:child");
      const rolledBackThreadId = yield* addRolledBackRecoveryCandidate("recovery-candidates");
      const orphanedThreadId = yield* addOrphanedRecoveryCandidate("recovery-candidates");
      const projectId = ProjectId.make("project:recovery-candidates");
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Recovery candidate",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });

      for (const threadId of [settledThreadId, runningThreadId, memberThreadId, childThreadId]) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: makeThread(threadId),
        });
      }

      const runId = RunId.make("run:recovery-candidates:running");
      const rootNodeId = NodeId.make("node:recovery-candidates:running");
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:run-created"),
        type: "run.created",
        threadId: runningThreadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: runningThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:recovery-candidates:running"),
          rootNodeId,
          activeAttemptId: null,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const memberId = NodeId.make("node:recovery-candidates:member");
      const childRootNodeId = NodeId.make("node:recovery-candidates:child-root");
      const nativeTaskRef = { driver, nativeId: "workflow:agent:1", strength: "strong" as const };
      const memberNode = {
        id: memberId,
        threadId: memberThreadId,
        runId: null,
        parentNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        rootNodeId: NodeId.make("node:recovery-candidates:coordinator-root"),
        kind: "subagent" as const,
        status: "running" as const,
        countsForRun: false,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: nativeTaskRef,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: now,
        completedAt: null,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: memberId,
          threadId: memberThreadId,
          runId: null,
          parentNodeId: memberNode.parentNodeId,
          origin: "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId,
          providerThreadId: null,
          childThreadId,
          nativeTaskRef,
          prompt: "Do the work",
          title: "Member",
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        },
      });
      for (const [threadId, node] of [
        [memberThreadId, memberNode],
        [
          childThreadId,
          {
            ...memberNode,
            id: childRootNodeId,
            threadId: childThreadId,
            parentNodeId: null,
            rootNodeId: childRootNodeId,
            kind: "root_turn" as const,
          },
        ],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:recovery-candidates:node:${node.id}`),
          type: "node.updated",
          threadId,
          nodeId: node.id,
          driver,
          occurredAt: now,
          payload: node,
        });
      }

      const recoveryThreadIds = yield* projectionStore.getRecoveryThreadIds("runtime");
      assert.include(recoveryThreadIds, runningThreadId);
      assert.include(recoveryThreadIds, orphanedThreadId);
      assert.include(recoveryThreadIds, memberThreadId);
      assert.include(recoveryThreadIds, childThreadId);
      assert.notInclude(recoveryThreadIds, settledThreadId);
      assert.notInclude(recoveryThreadIds, rolledBackThreadId);
      const memberRecovery = yield* projectionStore.getRuntimeRecoveryProjection(memberThreadId);
      const childRecovery = yield* projectionStore.getRuntimeRecoveryProjection(childThreadId);
      assert.deepEqual(
        memberRecovery.subagents.map((subagent) => subagent.id),
        [memberId],
      );
      assert.deepEqual(
        memberRecovery.nodes.map((node) => node.id),
        [memberId],
      );
      assert.deepEqual(
        childRecovery.nodes.map((node) => node.id),
        [childRootNodeId],
      );
      yield* projectionStore.apply({
        id: EventId.make("event:recovery-candidates:member-cancelled"),
        type: "subagent.updated",
        threadId: memberThreadId,
        nodeId: memberId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...memberRecovery.subagents[0]!,
          status: "cancelled",
          completedAt: now,
          updatedAt: now,
        },
      });
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime"), childThreadId);
    }),
  );

  it.effect("projects only the latest failed root turn's limit into SQL and memory shells", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = yield* addRolledBackRecoveryCandidate("limit-shell");
      const otherThreadId = yield* addRolledBackRecoveryCandidate("other-limit-shell");
      const original = (yield* store.getThreadProjection(threadId)).runs[0]!;
      const now = yield* DateTime.now;
      const limitItem = {
        id: TurnItemId.make("limit-shell:error"),
        threadId,
        runId: original.id,
        nodeId: original.rootNodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 2,
        status: "failed" as const,
        title: "Usage limit reached",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
        type: "error" as const,
        failure: {
          class: "usage_limit" as const,
          message: "Plan limit reached.",
          resetAt: "2099-01-01T00:00:00.000Z",
          code: "usageLimitExceeded",
          retryable: null,
        },
      };
      const applyRun = (status: typeof original.status, rootNodeId = original.rootNodeId) =>
        store.apply({
          id: EventId.make(`event:limit-shell:run:${status}:${rootNodeId}`),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, rootNodeId, status },
        });
      const assertSummary = Effect.fnUntraced(function* (
        lastError: string | null,
        lastErrorClass: string | null,
      ) {
        const projection = yield* store.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const shells = yield* store.getShellSnapshot();
        const sqlShell = shells.threads.find((row) => row.id === threadId)!;
        for (const shell of [memoryShell, sqlShell]) {
          assert.equal(shell.lastError, lastError);
          assert.equal(shell.lastErrorClass, lastErrorClass);
          assert.equal(
            shell.usageLimitResetAt,
            lastErrorClass === "usage_limit" ? "2099-01-01T00:00:00.000Z" : null,
          );
        }
        assert.isNull(shells.threads.find((row) => row.id === otherThreadId)!.lastErrorClass);
        const candidates = yield* store.getLimitRecoveryCandidates({
          now,
          autoResume: true,
          snooze: false,
        });
        const candidate = candidates.find((row) => row.id === threadId);
        if (lastErrorClass === "usage_limit") {
          assert.deepEqual(candidate, {
            id: sqlShell.id,
            status: sqlShell.status,
            lastErrorClass: sqlShell.lastErrorClass,
            usageLimitResetAt: sqlShell.usageLimitResetAt,
            latestRunId: sqlShell.latestRunId,
            latestRunCompletedAt: sqlShell.latestRunCompletedAt,
            updatedAt: sqlShell.updatedAt,
            archivedAt: sqlShell.archivedAt,
            settledOverride: sqlShell.settledOverride,
            pendingRuntimeRequest: null,
            limitRecovery: sqlShell.limitRecovery,
            snoozedUntil: sqlShell.snoozedUntil,
          });
        } else assert.isUndefined(candidate);
        assert.isUndefined(candidates.find((row) => row.id === otherThreadId));
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: limitItem,
      });
      yield* applyRun("failed");
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedRunId = RunId.make("run:limit-shell:queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:queued"),
        type: "run.created",
        threadId,
        runId: queuedRunId,
        nodeId: NodeId.make("node:limit-shell:queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: queuedRunId,
          ordinal: original.ordinal + 1,
          rootNodeId: NodeId.make("node:limit-shell:queued"),
          userMessageId: MessageId.make("message:limit-shell:queued"),
          status: "queued",
          startedAt: null,
          completedAt: null,
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const queuedProjection = yield* store.getThreadProjection(threadId);
      const queuedMemoryShell = ProjectionStore.threadShellFromProjection(queuedProjection);
      const queuedSqlShell = (yield* store.getShellSnapshot()).threads.find(
        (row) => row.id === threadId,
      )!;
      assert.equal(queuedMemoryShell.status, "failed");
      assert.equal(queuedMemoryShell.latestRunId, original.id);
      assert.equal(queuedSqlShell.status, "failed");
      assert.equal(queuedSqlShell.latestRunId, original.id);
      assert.equal(queuedProjection.runs.find((run) => run.id === queuedRunId)?.status, "queued");
      const cancelledRunId = RunId.make("run:limit-shell:cancelled-queued");
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued"),
        type: "run.created",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: cancelledRunId,
          ordinal: original.ordinal + 2,
          rootNodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          userMessageId: MessageId.make("message:limit-shell:cancelled-queued"),
          status: "cancelled",
          startedAt: null,
          completedAt: now,
        },
      });
      yield* store.apply({
        id: EventId.make("event:limit-shell:cancelled-queued-message"),
        type: "turn-item.updated",
        threadId,
        runId: cancelledRunId,
        nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: TurnItemId.make("limit-shell:cancelled-queued-message"),
          threadId,
          runId: cancelledRunId,
          nodeId: NodeId.make("node:limit-shell:cancelled-queued"),
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 3,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: MessageId.make("message:limit-shell:cancelled-queued"),
          inputIntent: "turn_start",
          text: "cancelled before the provider started",
          attachments: [],
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A restart continuation ran ahead of the held queue and ended before the
      // resumed failed run: the failure is still the latest executed run.
      const aheadRunId = RunId.make("run:limit-shell:ran-ahead");
      yield* store.apply({
        id: EventId.make("event:limit-shell:ran-ahead"),
        type: "run.created",
        threadId,
        runId: aheadRunId,
        nodeId: NodeId.make("node:limit-shell:ran-ahead"),
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          ...original,
          id: aheadRunId,
          ordinal: original.ordinal + 3,
          rootNodeId: NodeId.make("node:limit-shell:ran-ahead"),
          userMessageId: MessageId.make("message:limit-shell:ran-ahead"),
          status: "completed",
          startedAt: DateTime.subtract(now, { minutes: 10 }),
          completedAt: DateTime.subtract(now, { minutes: 5 }),
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      const sql = yield* SqlClient.SqlClient;
      // The rest of this case treats the failed run as the latest run.
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${aheadRunId}`;
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${queuedRunId}`;
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${cancelledRunId}`;
      const [originalRow] = yield* sql<{
        payload_json: string;
      }>`SELECT payload_json FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
      for (const [field, value] of [
        ["archivedAt", DateTime.formatIso(now)],
        ["settledOverride", "settled"],
      ]) {
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = json_set(payload_json, ${`$.${field}`}, ${value})
          WHERE thread_id = ${threadId}`;
        assert.isUndefined(
          (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
            (row) => row.id === threadId,
          ),
        );
        yield* sql`UPDATE orchestration_v2_projection_threads
          SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      }
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = ${DateTime.formatIso(now)} WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET deleted_at = NULL WHERE thread_id = ${threadId}`;
      const recoveryOptions = { now, autoResume: false, snooze: false };
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates(recoveryOptions)).find(
          (row) => row.id === threadId,
        ),
      );
      const reset = DateTime.makeUnsafe(limitItem.failure.resetAt);
      const recovery = {
        runId: original.id,
        resetAt: limitItem.failure.resetAt,
        autoResume: true,
        requestId: CommandId.make("recovery:choice"),
      };
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.limitRecovery', json(${encodeUnknownJsonString(recovery)}))
        WHERE thread_id = ${threadId}`;
      // Armed future retries need no state decoding until they become due.
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, autoResume: true })).find(
          (row) => row.id === threadId,
        ),
      );
      assert.strictEqual(yield* store.getLimitRecoveryWakeAt(now), DateTime.toEpochMillis(reset));
      assert.isNull(yield* store.getLimitRecoveryWakeAt(reset));
      const due = (yield* store.getLimitRecoveryCandidates({
        ...recoveryOptions,
        now: reset,
      })).find((row) => row.id === threadId)!;
      assert.deepEqual(due.limitRecovery, recovery);
      yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
        VALUES ('limit-shell:pending-request', ${threadId}, ${original.rootNodeId}, 'approval', 'pending', ${DateTime.formatIso(now)}, '{}')`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      yield* sql`DELETE FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = 'limit-shell:pending-request'`;
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', ${DateTime.formatIso(DateTime.add(reset, { minutes: 1 }))})
        WHERE thread_id = ${threadId}`;
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({ ...recoveryOptions, now: reset })).find(
          (row) => row.id === threadId,
        ),
      );
      assert.strictEqual(
        yield* store.getLimitRecoveryWakeAt(reset),
        DateTime.toEpochMillis(DateTime.add(reset, { minutes: 1 })),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.snoozedUntil', NULL, '$.limitRecovery.autoResume', json('false'))
        WHERE thread_id = ${threadId}`;
      assert.isNull(yield* store.getLimitRecoveryWakeAt(now));
      assert.isUndefined(
        (yield* store.getLimitRecoveryCandidates({
          ...recoveryOptions,
          now: reset,
          autoResume: true,
        })).find((row) => row.id === threadId),
      );
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = ${originalRow!.payload_json} WHERE thread_id = ${threadId}`;
      const session = {
        id: ProviderSessionId.make("session:limit-shell:shared"),
        driver,
        providerInstanceId,
        status: "ready" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      for (const boundThreadId of [threadId, otherThreadId]) {
        yield* store.apply({
          id: EventId.make(`event:limit-shell:bind:${boundThreadId}`),
          type: "provider-session.attached",
          threadId: boundThreadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }
      yield* assertSummary("Plan limit reached.", "usage_limit");
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-failed"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: { ...session, status: "error", lastError: "Provider process exited." },
      });
      yield* assertSummary("Provider process exited.", null);
      yield* store.apply({
        id: EventId.make("event:limit-shell:session-recovered"),
        type: "provider-session.updated",
        threadId,
        occurredAt: now,
        payload: session,
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A failed child is visible in history but does not replace the root's reason.
      yield* store.apply({
        id: EventId.make("event:limit-shell:child-error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:child-error"),
          nodeId: NodeId.make("child-node"),
          ordinal: 3,
          failure: { ...limitItem.failure, class: "provider_error", message: "Child failed." },
        },
      });
      yield* assertSummary("Plan limit reached.", "usage_limit");
      // A later ordinary root error replaces the limit classification.
      yield* store.apply({
        id: EventId.make("event:limit-shell:replacement"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          ...limitItem,
          id: TurnItemId.make("limit-shell:replacement"),
          ordinal: 4,
          failure: { ...limitItem.failure, class: "provider_error", message: "Provider failed." },
        },
      });
      yield* assertSummary("Provider failed.", "provider_error");
      for (const status of [
        "running",
        "completed",
        "interrupted",
        "cancelled",
        "rolled_back",
      ] as const) {
        yield* applyRun(status);
        yield* assertSummary(null, null);
      }
      // A new attempt's root cannot inherit an earlier attempt's limit.
      yield* applyRun("failed", NodeId.make("new-attempt-root"));
      yield* assertSummary(null, null);
    }),
  );

  it.effect("does not freshly arm limit recovery for a subagent of a settled parent", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { hours: 1 }));
      const threadPayload = (
        threadId: ThreadId,
        parentThreadId: ThreadId | null,
        settledOverride: "settled" | null,
      ) =>
        ({
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:settled-parent-limit"),
          title: "Settled parent limit recovery",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId,
            relationshipToParent: parentThreadId === null ? null : "subagent",
            rootThreadId: parentThreadId ?? threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride,
          settledAt: settledOverride === null ? null : now,
          lastVisitedAt: null,
          deletedAt: null,
        }) as const;
      const createThread = (
        threadId: ThreadId,
        parentThreadId: ThreadId | null,
        settledOverride: "settled" | null,
      ) =>
        store.apply({
          id: EventId.make(`event:${threadId}:created`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: threadPayload(threadId, parentThreadId, settledOverride),
        });
      const addLimitedChild = Effect.fnUntraced(function* (name: string, parentSettled: boolean) {
        const parentId = ThreadId.make(`thread:settled-parent-limit:${name}:parent`);
        const childId = ThreadId.make(`thread:settled-parent-limit:${name}:child`);
        const runId = RunId.make(`run:settled-parent-limit:${name}`);
        const rootNodeId = NodeId.make(`node:settled-parent-limit:${name}`);
        yield* createThread(parentId, null, parentSettled ? "settled" : null);
        yield* createThread(childId, parentId, null);
        const run = {
          id: runId,
          threadId: childId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`message:settled-parent-limit:${name}`),
          rootNodeId,
          activeAttemptId: null,
          status: "failed" as const,
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        };
        yield* store.apply({
          id: EventId.make(`event:settled-parent-limit:${name}:run`),
          type: "run.created",
          threadId: childId,
          runId,
          nodeId: rootNodeId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: run,
        });
        yield* store.apply({
          id: EventId.make(`event:settled-parent-limit:${name}:error`),
          type: "turn-item.updated",
          threadId: childId,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:settled-parent-limit:${name}:error`),
            threadId: childId,
            runId,
            nodeId: rootNodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "failed",
            title: "Usage limit reached",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "error",
            failure: {
              class: "usage_limit",
              message: "Plan limit reached.",
              resetAt,
              code: "usageLimitExceeded",
              retryable: null,
            },
          },
        });
        return childId;
      });
      const settledParentChild = yield* addLimitedChild("settled", true);
      const activeParentChild = yield* addLimitedChild("active", false);
      for (const options of [
        { now, autoResume: true, snooze: false },
        { now, autoResume: false, snooze: true },
      ]) {
        const armed = (yield* store.getLimitRecoveryCandidates(options))
          .filter((row) => row.id === settledParentChild || row.id === activeParentChild)
          .filter(
            (row) =>
              limitRecoveryCommand(
                row,
                options.autoResume,
                DateTime.toEpochMillis(now),
                options.snooze,
              )?.type === "thread.metadata.update",
          )
          .map((row) => row.id);
        assert.deepEqual(
          armed,
          [activeParentChild],
          `only the child of the unsettled parent is armed (${JSON.stringify(options)})`,
        );
      }
      // A recovery armed before the parent settled still resumes at its reset.
      yield* store.apply({
        id: EventId.make("event:settled-parent-limit:settled:armed"),
        type: "thread.metadata-updated",
        threadId: settledParentChild,
        occurredAt: now,
        payload: {
          ...threadPayload(
            settledParentChild,
            ThreadId.make("thread:settled-parent-limit:settled:parent"),
            null,
          ),
          limitRecovery: {
            runId: RunId.make("run:settled-parent-limit:settled"),
            resetAt,
            autoResume: true,
          },
        },
      });
      const afterReset = DateTime.add(now, { hours: 2 });
      const resumed = (yield* store.getLimitRecoveryCandidates({
        now: afterReset,
        autoResume: true,
        snooze: false,
      })).find((row) => row.id === settledParentChild);
      assert.isDefined(resumed);
      assert.isTrue(
        limitRecoveryCommand(
          resumed,
          true,
          DateTime.toEpochMillis(afterReset),
          false,
        )?.commandId.startsWith("limit-resume:"),
      );
    }),
  );

  it.effect("projects one shared provider session into multiple thread bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-shared-provider-session");
      const firstThreadId = ThreadId.make("thread:projection-shared-provider-session:first");
      const secondThreadId = ThreadId.make("thread:projection-shared-provider-session:second");
      const providerSessionId = ProviderSessionId.make(
        "provider-session:projection-shared-provider-session",
      );
      const makeThread = (threadId: ThreadId) => ({
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId,
        title: "Shared provider session",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: {
          parentThreadId: null,
          relationshipToParent: null,
          rootThreadId: threadId,
        },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      });
      const session = {
        id: providerSessionId,
        driver,
        providerInstanceId,
        status: "error" as const,
        cwd: "/workspace",
        model: modelSelection.model,
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: "provider process exited",
      };

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-thread"),
        type: "thread.created",
        threadId: firstThreadId,
        occurredAt: now,
        payload: makeThread(firstThreadId),
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:second-thread"),
        type: "thread.created",
        threadId: secondThreadId,
        occurredAt: now,
        payload: makeThread(secondThreadId),
      });
      for (const [threadId, suffix] of [
        [firstThreadId, "first"],
        [secondThreadId, "second"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-shared-provider-session:${suffix}-binding`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: now,
          payload: session,
        });
      }

      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions.map(
          (value) => value.id,
        ),
        [providerSessionId],
      );
      assert.deepEqual(
        (yield* projectionStore.getShellSnapshot()).threads
          .filter((thread) => thread.id === firstThreadId || thread.id === secondThreadId)
          .map((thread) => ({
            id: thread.id,
            lastError: thread.lastError,
          })),
        [
          { id: firstThreadId, lastError: "provider process exited" },
          { id: secondThreadId, lastError: "provider process exited" },
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shared-provider-session:first-detached"),
        type: "provider-session.detached",
        threadId: firstThreadId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: { providerSessionId, detachedAt: now },
      });

      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(firstThreadId)).providerSessions,
        0,
      );
      assert.lengthOf(
        (yield* projectionStore.getThreadProjection(secondThreadId)).providerSessions,
        1,
      );
    }),
  );

  it.effect("looks up a thread's last provider error through its own session bindings", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const later = DateTime.add(now, { minutes: 1 });
      const projectId = ProjectId.make("project:projection-session-error-lookup");
      const attachErroredSession = Effect.fnUntraced(function* (
        name: string,
        lastError: string,
        updatedAt: DateTime.Utc,
      ) {
        const threadId = ThreadId.make(`thread:projection-session-error-lookup:${name}`);
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-session-error-lookup:${name}:thread`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId,
            title: name,
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
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
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-session-error-lookup:${name}:session`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId,
          occurredAt: updatedAt,
          payload: {
            id: ProviderSessionId.make(`provider-session:projection-session-error-lookup:${name}`),
            driver,
            providerInstanceId,
            status: "error",
            cwd: "/workspace",
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: updatedAt,
            updatedAt,
            lastError,
          },
        });
        return threadId;
      });

      const failure = {
        class: "usage_limit" as const,
        message: "Plan limit reached.",
        resetAt: "2099-01-01T00:00:00.000Z",
        code: "usageLimitExceeded",
        retryable: null,
      };
      const threadId = yield* attachErroredSession("own", failure.message, now);
      // The own session repeats the root turn's limit, so the thread stays a
      // recovery candidate only while the lookup reads that session.
      const runId = RunId.make("run:projection-session-error-lookup:own");
      const rootNodeId = NodeId.make("node:projection-session-error-lookup:own");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-session-error-lookup:own:run"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-session-error-lookup:own"),
          rootNodeId,
          activeAttemptId: null,
          status: "failed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-session-error-lookup:own:error"),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: {
          id: TurnItemId.make("projection-session-error-lookup:own:error"),
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "failed",
          title: "Usage limit reached",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "error",
          failure,
        },
      });
      // Every thread on the provider instance has its own session, and these
      // are newer. They must neither leak into the thread nor be walked for it.
      for (let index = 0; index < 24; index++) {
        yield* attachErroredSession(`other-${index}`, "other session failed", later);
      }

      const { statements, tracer } = traceSqlStatements();
      const shell = yield* projectionStore.getShellSnapshot().pipe(Effect.withTracer(tracer));
      assert.equal(
        shell.threads.find((thread) => thread.id === threadId)?.lastError,
        failure.message,
      );
      const candidates = yield* projectionStore
        .getLimitRecoveryCandidates({ now, autoResume: true, snooze: false })
        .pipe(Effect.withTracer(tracer));
      // Another thread's newer error would replace the limit and drop the candidate.
      const candidate = candidates.find((row) => row.id === threadId);
      assert.isDefined(candidate);
      assert.include(candidate, {
        status: "failed",
        lastErrorClass: "usage_limit",
        usageLimitResetAt: failure.resetAt,
        latestRunId: runId,
      });

      // One provider instance usually holds most sessions. Driving the lookup
      // from sessions walks all of them for every thread in the snapshot.
      for (const marker of ["AS blocking_failure_payload_json", "AS failure_payload_json"]) {
        const statement = statements.find((query) => query.includes(marker));
        assert.isDefined(statement, marker);
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        )).map((row) => row.detail);
        const bindingLookup = plan.findIndex((detail) => detail.startsWith("SEARCH binding "));
        const sessionLookup = plan.findIndex((detail) => detail.startsWith("SEARCH session "));
        assert.isAtLeast(bindingLookup, 0, marker);
        assert.include(
          plan[bindingLookup],
          "orchestration_v2_projection_provider_session_bindings_thread_idx (thread_id=?)",
        );
        assert.isAbove(sessionLookup, bindingLookup, marker);
        assert.include(plan[sessionLookup], "(provider_session_id=?)");
        const errorLookups = plan.filter(
          (detail) =>
            /^SEARCH (?:item|error) /.test(detail) && !detail.includes("(turn_item_id=?)"),
        );
        assert.lengthOf(errorLookups, marker.includes("blocking") ? 2 : 1, marker);
        for (const errorLookup of errorLookups) {
          assert.include(errorLookup, "turn_items_failed_error_idx");
          assert.include(errorLookup, "(thread_id=? AND run_id=? AND node_id=?)");
        }
      }
    }),
  );

  it.effect(
    "reads checkpoint context without decoding transcript or checkpoint file payloads",
    () =>
      Effect.gen(function* () {
        const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
        const memoryStore = yield* ProjectionStore.ProjectionStoreV2.pipe(
          Effect.provide(ProjectionStore.layerMemory),
        );
        const apply = (event: Parameters<typeof projectionStore.apply>[0]) =>
          Effect.all([projectionStore.apply(event), memoryStore.apply(event)]);
        const sql = yield* SqlClient.SqlClient;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:checkpoint-context");
        const runId = RunId.make("run:checkpoint-context");
        const nodeId = NodeId.make("node:checkpoint-context");
        const scopeId = CheckpointScopeId.make("scope:checkpoint-context");
        const checkpointId = CheckpointId.make("checkpoint:checkpoint-context");
        const ref = CheckpointRef.make("refs/t3/checkpoint-context/1");
        yield* apply({
          id: EventId.make("event:checkpoint-context:thread"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:checkpoint-context"),
            title: "Checkpoint context",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "feature",
            worktreePath: "/repo/worktree",
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
        });
        yield* apply({
          id: EventId.make("event:checkpoint-context:run"),
          type: "run.created",
          threadId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("message:checkpoint-context"),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId,
            contextHandoffId: null,
          },
        });
        yield* apply({
          id: EventId.make("event:checkpoint-context:scope"),
          type: "checkpoint-scope.created",
          threadId,
          occurredAt: now,
          payload: {
            id: scopeId,
            threadId,
            runId,
            nodeId,
            parentScopeId: null,
            providerThreadId: null,
            kind: "root_run",
            ordinalWithinParent: 0,
            advancesAppRunCount: true,
            cwd: "/repo/worktree",
            createdAt: now,
          },
        });
        yield* apply({
          id: EventId.make("event:checkpoint-context:checkpoint"),
          type: "checkpoint.captured",
          threadId,
          occurredAt: now,
          payload: {
            id: checkpointId,
            threadId,
            scopeId,
            runId,
            nodeId,
            parentCheckpointId: null,
            ordinalWithinScope: 1,
            appRunOrdinal: 1,
            ref,
            status: "ready",
            files: [],
            capturedAt: now,
          },
        });
        // Old transcript shapes must not make a metadata-only diff unreadable.
        yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          'turn-item:checkpoint-context:obsolete', ${threadId}, ${runId}, ${nodeId}, NULL, NULL,
          NULL, 1, 'assistant_message', 'completed', ${DateTime.formatIso(now)},
          ${encodeUnknownJsonString({ obsolete: "transcript shape" })}
        )
      `;
        assert.strictEqual(
          (yield* Effect.exit(projectionStore.getThreadProjection(threadId)))._tag,
          "Failure",
        );
        yield* sql`
        UPDATE orchestration_v2_projection_checkpoints
        SET payload_json = json_set(payload_json, '$.files', 'obsolete file summary')
        WHERE checkpoint_id = ${checkpointId}
      `;
        for (const store of [projectionStore, memoryStore]) {
          assert.deepEqual(yield* store.getCheckpointContext(threadId), {
            runs: [{ id: runId, ordinal: 1, status: "completed" }],
            checkpointScopes: [{ id: scopeId, runId, kind: "root_run", cwd: "/repo/worktree" }],
            checkpoints: [
              { scopeId, runId, ordinalWithinScope: 1, appRunOrdinal: 1, status: "ready", ref },
            ],
          });
          const missing = yield* store
            .getCheckpointContext(ThreadId.make("thread:checkpoint-context:missing"))
            .pipe(Effect.flip);
          assert.instanceOf(missing, ProjectionStore.ProjectionStoreThreadNotFoundError);
        }
      }),
  );

  it.effect("selects the latest waiting secret only from active runs", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const suffix = "shell-pending-secret";
      const threadId = yield* addRolledBackRecoveryCandidate(suffix);
      const runId = RunId.make(`run:${suffix}:rolled-back`);
      const nodeId = NodeId.make(`node:${suffix}:rolled-back`);
      const now = yield* DateTime.now;
      const addSecret = (id: string, ordinal: number, status: "waiting" | "completed") =>
        projectionStore.apply({
          id: EventId.make(`event:${id}`),
          type: "turn-item.updated",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(id),
            threadId,
            runId,
            nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status,
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: DateTime.add(now, { seconds: ordinal }),
            type: "secret_request",
            label: "Test credential",
            reason: "Test pending input",
            secretStatus: status === "waiting" ? "pending" : "saved",
          },
        });
      yield* addSecret("secret:a", 2, "waiting");
      yield* addSecret("secret:b", 3, "waiting");
      yield* addSecret("secret:c", 4, "completed");

      yield* sql`
        UPDATE orchestration_v2_projection_runs
        SET status = 'running', payload_json = json_set(payload_json, '$.status', 'running')
        WHERE run_id = ${runId}
      `;
      const secretOnlyShell = (yield* projectionStore.getShellSnapshot()).threads.find(
        (thread) => thread.id === threadId,
      );
      const secretOnlyProjection = yield* projectionStore.getThreadProjection(threadId);
      for (const shell of [
        secretOnlyShell,
        ProjectionStore.threadShellFromProjection(secretOnlyProjection),
      ]) {
        assert.equal(shell?.pendingRuntimeRequest?.id, "secret:b");
        assert.isTrue(shell?.pendingRuntimeRequest?.blocking);
      }

      const requestId = RuntimeRequestId.make(`request:${suffix}:async`);
      yield* projectionStore.apply({
        id: EventId.make(`event:${suffix}:async`),
        type: "runtime-request.updated",
        threadId,
        runId,
        nodeId,
        driver,
        occurredAt: now,
        payload: {
          id: requestId,
          nodeId,
          providerTurnId: null,
          nativeRequestRef: null,
          kind: "user_input",
          status: "pending",
          responseCapability: { type: "message" },
          createdAt: DateTime.subtract(now, { seconds: 1 }),
          resolvedAt: null,
        },
      });

      for (const status of [
        "preparing",
        "starting",
        "running",
        "waiting",
        "completed",
        "rolled_back",
      ]) {
        yield* sql`
          UPDATE orchestration_v2_projection_runs
          SET status = ${status}, payload_json = json_set(payload_json, '$.status', ${status})
          WHERE run_id = ${runId}
        `;
        const shell = yield* projectionStore.getShellSnapshot();
        const thread = shell.threads.find((candidate) => candidate.id === threadId);
        assert.isDefined(thread);
        const projection = yield* projectionStore.getThreadProjection(threadId);
        const memoryShell = ProjectionStore.threadShellFromProjection(projection);
        const terminal = status === "completed" || status === "rolled_back";
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.id, memoryShell.pendingRuntimeRequest?.id],
          terminal ? [requestId, requestId] : ["secret:b", "secret:b"],
        );
        assert.deepEqual(
          [thread?.pendingRuntimeRequest?.blocking, memoryShell.pendingRuntimeRequest?.blocking],
          terminal ? [false, false] : [true, true],
        );
      }
    }),
  );

  it.effect("builds shell snapshots without decoding full turn item payloads", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      const threadId = ThreadId.make("thread:projection-shell-stale-item");
      const projectId = ProjectId.make("project:projection-shell");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-shell-thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection shell",
          providerInstanceId,
          modelSelection: modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id,
          thread_id,
          run_id,
          node_id,
          provider_thread_id,
          provider_turn_id,
          parent_item_id,
          ordinal,
          type,
          status,
          updated_at,
          payload_json
        )
        VALUES (
          ${"turn-item:stale-user-message"},
          ${threadId},
          ${null},
          ${null},
          ${null},
          ${null},
          ${null},
          ${0},
          ${"user_message"},
          ${"completed"},
          ${nowIso},
          ${encodeUnknownJsonString({
            id: "turn-item:stale-user-message",
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 0,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "user_message",
            messageId: "message:stale-user-message",
            text: "stale user message",
            attachments: [],
          })}
        )
      `;

      const shell = yield* projectionStore.getShellSnapshot();
      const fullProjectionExit = yield* Effect.exit(projectionStore.getThreadProjection(threadId));

      assert.deepEqual(
        shell.threads
          .filter((thread) => thread.id === threadId)
          .map((thread) => ({
            id: thread.id,
            itemCount: thread.itemCount,
            visibleItemCount: thread.visibleItemCount,
            status: thread.status,
          })),
        [
          {
            id: threadId,
            itemCount: 1,
            visibleItemCount: 1,
            status: "idle",
          },
        ],
      );
      assert.equal(fullProjectionExit._tag, "Failure");
    }),
  );

  it.effect("counts imported runless history inherited by fork shells", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-imported-fork-shell");
      const sourceThreadId = ThreadId.make("thread:projection-imported-fork-shell:source");
      const targetThreadId = ThreadId.make("thread:projection-imported-fork-shell:target");
      const sourceRunId = RunId.make("run:projection-imported-fork-shell:source");
      const rootNodeId = NodeId.make("node:projection-imported-fork-shell:source");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "system",
          creationSource: "server",
          id: sourceThreadId,
          projectId,
          title: "Imported fork source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          historyOrigin: "v1_import",
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Imported fork target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-imported-fork-shell:source-run"),
        type: "run.created",
        threadId: sourceThreadId,
        runId: sourceRunId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRunId,
          threadId: sourceThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-imported-fork-shell:run"),
          rootNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const applyAssistantItem = (suffix: string, runId: RunId | null, ordinal: number) =>
        projectionStore.apply({
          id: EventId.make(`event:projection-imported-fork-shell:item:${suffix}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          ...(runId === null ? {} : { runId }),
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-imported-fork-shell:${suffix}`),
            threadId: sourceThreadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(`message:projection-imported-fork-shell:${suffix}`),
            text: suffix,
            streaming: false,
          },
        });

      yield* applyAssistantItem("imported-one", null, 1);
      yield* applyAssistantItem("imported-two", null, 2);
      yield* applyAssistantItem("native-run", sourceRunId, 3);

      const shell = yield* projectionStore.getShellSnapshot();
      const targetShell = shell.threads.find((thread) => thread.id === targetThreadId);
      const targetProjection = yield* projectionStore.getThreadProjection(targetThreadId);

      assert.isDefined(targetShell);
      assert.equal(targetShell.itemCount, 0);
      assert.equal(targetShell.visibleItemCount, 4);
      assert.equal(targetProjection.visibleTurnItems.length, 4);
    }),
  );

  it.effect("removes rolled back runs from the active visible projection", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:projection-rollback-prune");
      const projectId = ProjectId.make("project:projection-rollback-prune");
      const runId = RunId.make("run:projection-rollback-prune");
      const attemptId = RunAttemptId.make("attempt:projection-rollback-prune");
      const rootNodeId = NodeId.make("node:projection-rollback-prune:root");
      const assistantNodeId = NodeId.make("node:projection-rollback-prune:assistant");
      const providerThreadId = ProviderThreadId.make("provider-thread:projection-rollback-prune");
      const providerTurnId = ProviderTurnId.make("provider-turn:projection-rollback-prune");
      const userMessageId = MessageId.make("message:projection-rollback-prune:user");
      const assistantMessageId = MessageId.make("message:projection-rollback-prune:assistant");
      const userTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:user");
      const assistantTurnItemId = TurnItemId.make("turn-item:projection-rollback-prune:assistant");
      const backgroundTurnItemId = TurnItemId.make(
        "turn-item:projection-rollback-prune:background",
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:thread-created"),
        type: "thread.created",
        threadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId,
          title: "Projection rollback prune",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: threadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-thread"),
        type: "provider-thread.updated",
        threadId,
        driver,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "active",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-created"),
        type: "run.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:attempt-created"),
        type: "run-attempt.created",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId,
          providerInstanceId,
          providerThreadId,
          providerTurnId,
          reason: "initial",
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "completed",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-node"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantNodeId,
          threadId,
          runId,
          parentNodeId: rootNodeId,
          rootNodeId,
          kind: "assistant_message",
          status: "completed",
          countsForRun: false,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:provider-turn"),
        type: "provider-turn.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: providerTurnId,
          providerThreadId,
          nodeId: rootNodeId,
          runAttemptId: attemptId,
          nativeTurnRef: null,
          ordinal: 1,
          status: "completed",
          startedAt: now,
          completedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userMessageId,
          threadId,
          runId,
          nodeId: rootNodeId,
          role: "user",
          text: "rolled back user",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-message"),
        type: "message.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "agent",
          creationSource: "provider",
          id: assistantMessageId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          role: "assistant",
          text: "rolled back assistant",
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:user-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: userTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 100,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: userMessageId,
          inputIntent: "turn_start",
          text: "rolled back user",
          attachments: [],
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:assistant-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: assistantNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: assistantTurnItemId,
          threadId,
          runId,
          nodeId: assistantNodeId,
          providerThreadId,
          providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 101,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "assistant_message",
          messageId: assistantMessageId,
          text: "rolled back assistant",
          streaming: false,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:background-item"),
        type: "turn-item.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: backgroundTurnItemId,
          threadId,
          runId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 300,
          status: "running",
          title: "rolled back background command",
          startedAt: now,
          completedAt: null,
          updatedAt: now,
          type: "command_execution",
          input: "sleep 60",
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:run-rolled-back"),
        type: "run.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId,
          rootNodeId,
          activeAttemptId: attemptId,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-rollback-prune:root-rolled-back"),
        type: "node.updated",
        threadId,
        runId,
        nodeId: rootNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId,
          runId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "rolled_back",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: now,
          completedAt: now,
        },
      });

      const projection = yield* projectionStore.getThreadProjection(threadId);

      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["rolled_back"],
      );
      assert.deepEqual(
        projection.nodes.map((node) => [node.id, node.status]),
        [
          [assistantNodeId, "completed"],
          [rootNodeId, "rolled_back"],
        ],
      );
      assert.lengthOf(projection.providerTurns, 1);
      assert.lengthOf(projection.messages, 2);
      assert.lengthOf(projection.turnItems, 3);
      assert.lengthOf(projection.visibleTurnItems, 0);

      // A rolled-back run's background item is abandoned, not pending. The
      // shell must not report it as Waiting, or the sidebar shows Waiting for
      // work nothing will ever finish.
      const shell = yield* projectionStore.getShellSnapshot();
      const rolledBackShellThread = shell.threads.find((entry) => entry.id === threadId);
      assert.isDefined(rolledBackShellThread);
      assert.isNull(rolledBackShellThread.latestVisibleMessage);
      assert.deepEqual(rolledBackShellThread?.pendingBackgroundTasks ?? [], []);
    }),
  );

  it.effect("keeps fork visible items stable after a source run is rolled back", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:projection-fork-source-rollback");
      const sourceThreadId = ThreadId.make("thread:projection-fork-source-rollback:source");
      const targetThreadId = ThreadId.make("thread:projection-fork-source-rollback:target");
      const sourceProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:source",
      );
      const targetProviderThreadId = ProviderThreadId.make(
        "provider-thread:projection-fork-source-rollback:target",
      );
      const sourceRun1Id = RunId.make("run:projection-fork-source-rollback:source:1");
      const sourceRun2Id = RunId.make("run:projection-fork-source-rollback:source:2");
      const sourceRun3Id = RunId.make("run:projection-fork-source-rollback:source:3");
      const sourceRun1NodeId = NodeId.make("node:projection-fork-source-rollback:source:1");
      const sourceRun2NodeId = NodeId.make("node:projection-fork-source-rollback:source:2");
      const sourceRun3NodeId = NodeId.make("node:projection-fork-source-rollback:source:3");

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:source-thread"),
        type: "thread.created",
        threadId: sourceThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: sourceThreadId,
          projectId,
          title: "Projection fork source rollback source",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: sourceProviderThreadId,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: sourceThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-thread"),
        type: "thread.created",
        threadId: targetThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: targetThreadId,
          projectId,
          title: "Projection fork source rollback target",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: targetProviderThreadId,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: sourceThreadId,
            runId: sourceRun2Id,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });

      for (const [ordinal, runId, nodeId, promptText, responseText] of [
        [1, sourceRun1Id, sourceRun1NodeId, "source one", "one"],
        [2, sourceRun2Id, sourceRun2NodeId, "source two", "two"],
      ] as const) {
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:run-${ordinal}`),
          type: "run.created",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: sourceThreadId,
            ordinal,
            providerInstanceId,
            modelSelection,
            providerThreadId: sourceProviderThreadId,
            userMessageId: MessageId.make(
              `message:projection-fork-source-rollback:user:${ordinal}`,
            ),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:user-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:user:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:projection-fork-source-rollback:user:${ordinal}`),
            inputIntent: "turn_start",
            text: promptText,
            attachments: [],
          },
        });
        yield* projectionStore.apply({
          id: EventId.make(`event:projection-fork-source-rollback:assistant-item-${ordinal}`),
          type: "turn-item.updated",
          threadId: sourceThreadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`turn-item:projection-fork-source-rollback:assistant:${ordinal}`),
            threadId: sourceThreadId,
            runId,
            nodeId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: ordinal * 100 + 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make(
              `message:projection-fork-source-rollback:assistant:${ordinal}`,
            ),
            text: responseText,
            streaming: false,
          },
        });
      }

      const targetBeforeRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      assert.deepEqual(
        targetBeforeRollback.visibleTurnItems.map((row) => row.item.type),
        ["user_message", "assistant_message", "user_message", "assistant_message", "fork"],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-2-rolled-back"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun2Id,
        nodeId: sourceRun2NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun2Id,
          threadId: sourceThreadId,
          ordinal: 2,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:2"),
          rootNodeId: sourceRun2NodeId,
          activeAttemptId: null,
          status: "rolled_back",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });

      const sourceMessages = (yield* projectionStore.getThreadRecords(sourceThreadId, ["messages"]))
        .messages;
      assert.deepEqual(
        sourceMessages,
        (yield* projectionStore.getThreadProjection(sourceThreadId)).messages,
      );
      const targetAfterRollback = yield* projectionStore.getThreadProjection(targetThreadId);
      // Both shell reads drop the rolled-back run from the source count, while
      // the fork keeps the prefix it inherited.
      const shellSnapshot = yield* projectionStore.getShellSnapshot();
      for (const shell of [
        yield* projectionStore.getThreadShell(sourceThreadId),
        shellSnapshot.threads.find((thread) => thread.id === sourceThreadId),
      ]) {
        assert.equal(shell?.itemCount, 2);
      }
      for (const shell of [
        yield* projectionStore.getThreadShell(targetThreadId),
        shellSnapshot.threads.find((thread) => thread.id === targetThreadId),
      ]) {
        assert.equal(shell?.visibleItemCount, targetAfterRollback.visibleTurnItems.length);
      }
      const forwardPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 2,
      });
      assert.deepEqual(forwardPage.items, targetAfterRollback.visibleTurnItems.slice(0, 2));
      assert.equal(forwardPage.totalItems, targetAfterRollback.visibleTurnItems.length);
      assert.isTrue(forwardPage.hasMore);
      const followingPage = yield* projectionStore.getTimelinePage(targetThreadId, {
        view: "activity",
        limit: 10,
        afterPosition: 1,
      });
      assert.deepEqual(followingPage.items, targetAfterRollback.visibleTurnItems.slice(2));
      assert.isFalse(followingPage.hasMore);
      const tracedTimelinePage = (limit: number) =>
        Effect.gen(function* () {
          const { statements, tracer } = traceSqlStatements();
          const page = yield* projectionStore
            .getTimelinePage(targetThreadId, { view: "activity", limit })
            .pipe(Effect.withTracer(tracer));
          return { page, statements };
        });
      const singleItemPage = yield* tracedTimelinePage(1);
      const fullPage = yield* tracedTimelinePage(10);
      assert.deepEqual(fullPage.page.items, targetAfterRollback.visibleTurnItems);
      assert.lengthOf(fullPage.statements, singleItemPage.statements.length);

      assert.deepEqual(
        targetAfterRollback.visibleTurnItems.map((row) => [
          row.visibility,
          row.item.type,
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.title,
        ]),
        [
          ["inherited", "user_message", "source one"],
          ["inherited", "assistant_message", "one"],
          ["inherited", "user_message", "source two"],
          ["inherited", "assistant_message", "two"],
          ["synthetic", "fork", "Forked from conversation"],
        ],
      );

      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:run-3"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: sourceRun3Id,
        nodeId: sourceRun3NodeId,
        driver,
        occurredAt: now,
        payload: {
          id: sourceRun3Id,
          threadId: sourceThreadId,
          ordinal: 4,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:user:3"),
          rootNodeId: sourceRun3NodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const nowIso = DateTime.formatIso(now);
      for (let index = 0; index < 300; index += 1) {
        const id = `turn-item:projection-fork-source-rollback:post-fork:${index}`;
        const ordinal = index < 10 ? 190 + index : 300 + index;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun3Id}, ${sourceRun3NodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'command_execution',
            'completed', ${nowIso}, ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun3Id,
              nodeId: sourceRun3NodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "post fork",
              input: "echo later",
              output: "later",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }

      const { statements, tracer } = traceSqlStatements();
      const boundedFork = yield* projectionStore
        .getThreadSnapshotWindow(targetThreadId, { rowLimit: 2 })
        .pipe(Effect.withTracer(tracer));
      // Only the target's control state is hydrated. Fork ancestors contribute
      // timeline rows, runs and attempts, regardless of their own live work.
      assert.lengthOf(
        statements.filter((statement) => statement.includes("WITH RECURSIVE retained")),
        1,
      );
      assert.lengthOf(
        statements.filter((statement) => statement.includes("SELECT node.payload_json")),
        1,
      );
      assert.lengthOf(boundedFork.projection.turnItems, 0);
      assert.deepEqual(
        boundedFork.projection.visibleTurnItems.map((row) => [row.visibility, row.item.type]),
        [
          ["inherited", "user_message"],
          ["inherited", "assistant_message"],
          ["synthetic", "fork"],
        ],
      );
      const parentPage = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
        anchorItemId: TurnItemId.make("turn-item:projection-fork-source-rollback:assistant:1"),
      });
      assert.deepEqual(
        parentPage.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );

      const emptyBoundaryRunId = RunId.make(
        "run:projection-fork-source-rollback:source:empty-boundary",
      );
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-boundary-run"),
        type: "run.updated",
        threadId: sourceThreadId,
        runId: emptyBoundaryRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyBoundaryRunId,
          threadId: sourceThreadId,
          ordinal: 3,
          providerInstanceId,
          modelSelection,
          providerThreadId: sourceProviderThreadId,
          userMessageId: MessageId.make(
            "message:projection-fork-source-rollback:user:empty-boundary",
          ),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:source:empty-boundary"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const emptyBoundaryFork = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      // The boundary falls back past the empty fork run. Run 2 was rolled back
      // before that live run existed, so the fork never showed its turns.
      assert.deepEqual(
        emptyBoundaryFork.projection.visibleTurnItems.map((row) =>
          row.item.type === "user_message" || row.item.type === "assistant_message"
            ? row.item.text
            : row.item.type,
        ),
        ["source one", "one", "fork"],
      );
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${sourceRun2Id})
        WHERE thread_id = ${targetThreadId}
      `;

      const targetRunId = RunId.make("run:projection-fork-source-rollback:target:1");
      const targetNodeId = NodeId.make("node:projection-fork-source-rollback:target:1");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:target-run"),
        type: "run.updated",
        threadId: targetThreadId,
        runId: targetRunId,
        nodeId: targetNodeId,
        driver,
        occurredAt: now,
        payload: {
          id: targetRunId,
          threadId: targetThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: targetProviderThreadId,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:target:1"),
          rootNodeId: targetNodeId,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      for (let ordinal = 1; ordinal <= 102; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:target:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${targetThreadId}, ${targetRunId}, ${targetNodeId}, ${targetProviderThreadId},
            NULL, NULL, ${ordinal}, 'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: targetThreadId,
              runId: targetRunId,
              nodeId: targetNodeId,
              providerThreadId: targetProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `target ${ordinal}`,
              input: `echo target ${ordinal}`,
              output: "target",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const nestedThreadId = ThreadId.make("thread:projection-fork-source-rollback:nested");
      for (const ordinal of [
        ...Array.from({ length: 99 }, (_, index) => index + 1),
        ...Array.from({ length: 99 }, (_, index) => index + 101),
      ]) {
        const runId = ordinal < 100 ? sourceRun1Id : sourceRun2Id;
        const id = `turn-item:projection-fork-source-rollback:lineage:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${runId}, NULL, NULL, NULL, NULL, ${ordinal},
            'command_execution', 'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: `lineage ${ordinal}`,
              input: "echo lineage",
              output: "lineage",
              exitCode: 0,
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "command_execution",
            })}
          )
        `;
      }
      const inheritedSupersededNodeId = NodeId.make(
        "node:projection-fork-source-rollback:inherited-superseded",
      );
      yield* sql`
        INSERT INTO orchestration_v2_projection_run_attempts (
          attempt_id, thread_id, run_id, attempt_ordinal, root_node_id, provider,
          provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
        ) VALUES (
          'attempt:projection-fork-source-rollback:inherited-superseded',
          ${sourceThreadId}, ${sourceRun2Id}, 2, ${inheritedSupersededNodeId}, 'codex',
          ${providerInstanceId}, ${sourceProviderThreadId}, NULL, 'superseded',
          ${encodeUnknownJsonString({
            id: "attempt:projection-fork-source-rollback:inherited-superseded",
            runId: sourceRun2Id,
            attemptOrdinal: 2,
            rootNodeId: inheritedSupersededNodeId,
            providerInstanceId,
            providerThreadId: sourceProviderThreadId,
            providerTurnId: null,
            reason: "retry",
            status: "superseded",
            startedAt: nowIso,
            completedAt: nowIso,
          })}
        )
      `;
      for (let ordinal = 201; ordinal <= 300; ordinal += 1) {
        const id = `turn-item:projection-fork-source-rollback:hidden-interrupt:${ordinal}`;
        yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            ${id}, ${sourceThreadId}, ${sourceRun2Id}, ${inheritedSupersededNodeId},
            ${sourceProviderThreadId}, NULL, NULL, ${ordinal}, 'run_interrupt_result',
            'completed', ${nowIso},
            ${encodeUnknownJsonString({
              id,
              threadId: sourceThreadId,
              runId: sourceRun2Id,
              nodeId: inheritedSupersededNodeId,
              providerThreadId: sourceProviderThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal,
              status: "completed",
              title: "Stopped",
              message: "Stopped",
              startedAt: nowIso,
              completedAt: nowIso,
              updatedAt: nowIso,
              type: "run_interrupt_result",
            })}
          )
        `;
      }
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:nested-thread"),
        type: "thread.created",
        threadId: nestedThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: nestedThreadId,
          projectId,
          title: "Nested bounded fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: targetThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: targetThreadId, runId: targetRunId },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const boundedNested = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        boundedNested.projection.visibleTurnItems.map((row) => row.item.type),
        [
          "user_message",
          "assistant_message",
          "fork",
          "command_execution",
          "command_execution",
          "fork",
        ],
      );

      const nestedInitial = buildBoundedThreadProjection({
        policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
        projection: yield* projectionStore
          .getThreadSnapshotWindow(nestedThreadId, {
            rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          })
          .pipe(Effect.map((snapshot) => snapshot.projection)),
        snapshotSequence: 1,
      });
      const expectedNestedIds = (yield* projectionStore.getThreadProjection(
        nestedThreadId,
      )).visibleTurnItems.map((row) => String(row.sourceItemId));
      const nestedIds = nestedInitial.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let nestedCursor = nestedInitial.historyCursor;
      let nestedPages = 1;
      while (nestedCursor !== null) {
        const decoded = decodeThreadHistoryCursor(nestedCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: THREAD_HISTORY_PAGE_POLICY.maxItems + 2,
          anchorItemId: TurnItemId.make(decoded.si),
          anchorThreadId: ThreadId.make(decoded.st),
        });
        const page = selectHistoryPageFromCursor({
          policy: { ...THREAD_HISTORY_PAGE_POLICY, maxUserTurns: undefined },
          items: snapshot.projection.visibleTurnItems,
          cursor: nestedCursor,
          snapshotSequence: snapshot.snapshotSequence,
        });
        nestedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        nestedCursor = page.nextCursor;
        nestedPages += 1;
      }
      assert.isAtLeast(nestedPages, 3);
      assert.lengthOf(nestedIds, expectedNestedIds.length);
      assert.deepEqual(nestedIds, expectedNestedIds);

      const nestedTurnWindow = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
        rowLimit: 77,
        userTurnLimit: 10,
      });
      const nestedTurnPage = buildBoundedThreadProjection({
        projection: nestedTurnWindow.projection,
        snapshotSequence: 1,
      });
      const turnPagedIds = nestedTurnPage.projection.visibleTurnItems.map((row) =>
        String(row.sourceItemId),
      );
      let turnCursor = nestedTurnPage.historyCursor;
      while (turnCursor !== null) {
        const anchor = decodeThreadHistoryCursor(turnCursor);
        const snapshot = yield* projectionStore.getThreadSnapshotWindow(nestedThreadId, {
          rowLimit: 77,
          userTurnLimit: 20,
          anchorItemId: TurnItemId.make(anchor.si),
          anchorThreadId: ThreadId.make(anchor.st),
        });
        const page = selectHistoryPageFromCursor({
          items: snapshot.projection.visibleTurnItems,
          cursor: turnCursor,
          snapshotSequence: 1,
        });
        turnPagedIds.unshift(...page.items.map((row) => String(row.sourceItemId)));
        turnCursor = page.nextCursor;
      }
      assert.deepEqual(turnPagedIds, expectedNestedIds);
      const fullNested = yield* projectionStore.getThreadProjection(nestedThreadId);
      const nestedForward = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "activity",
        limit: expectedNestedIds.length + 1,
      });
      assert.deepEqual(nestedForward.items, fullNested.visibleTurnItems);
      const messagePage = yield* projectionStore.getTimelinePage(nestedThreadId, {
        view: "messages",
        limit: 2,
      });
      assert.deepEqual(
        messagePage.items,
        fullNested.visibleTurnItems
          .filter((row) =>
            ["user_message", "assistant_message", "proposed_plan"].includes(row.item.type),
          )
          .slice(0, 2),
      );

      const emptyMiddleThreadId = ThreadId.make(
        "thread:projection-fork-source-rollback:empty-middle",
      );
      const emptyMiddleRunId = RunId.make("run:projection-fork-source-rollback:empty-middle");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-thread"),
        type: "thread.created",
        threadId: emptyMiddleThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyMiddleThreadId,
          projectId,
          title: "Empty middle fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: sourceThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: { type: "run", threadId: sourceThreadId, runId: sourceRun2Id },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-middle-run"),
        type: "run.updated",
        threadId: emptyMiddleThreadId,
        runId: emptyMiddleRunId,
        nodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
        driver,
        occurredAt: now,
        payload: {
          id: emptyMiddleRunId,
          threadId: emptyMiddleThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:projection-fork-source-rollback:empty-middle"),
          rootNodeId: NodeId.make("node:projection-fork-source-rollback:empty-middle"),
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const emptyLeafThreadId = ThreadId.make("thread:projection-fork-source-rollback:empty-leaf");
      yield* projectionStore.apply({
        id: EventId.make("event:projection-fork-source-rollback:empty-leaf-thread"),
        type: "thread.created",
        threadId: emptyLeafThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: emptyLeafThreadId,
          projectId,
          title: "Leaf after empty fork",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: emptyMiddleThreadId,
            relationshipToParent: "fork",
            rootThreadId: sourceThreadId,
          },
          forkedFrom: {
            type: "run",
            threadId: emptyMiddleThreadId,
            runId: emptyMiddleRunId,
          },
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      const emptyMiddleSnapshot = yield* projectionStore.getThreadSnapshotWindow(
        emptyLeafThreadId,
        { rowLimit: 2 },
      );
      assert.deepEqual(
        emptyMiddleSnapshot.projection.visibleTurnItems.map((row) => [
          row.sourceThreadId,
          row.item.type,
        ]),
        [
          [sourceThreadId, "user_message"],
          [sourceThreadId, "assistant_message"],
          [sourceThreadId, "fork"],
          [emptyMiddleThreadId, "fork"],
        ],
      );

      yield* sql`
        DELETE FROM orchestration_v2_projection_turn_items
        WHERE run_id IN (${sourceRun1Id}, ${sourceRun2Id})
      `;
      const importedItemId = "turn-item:projection-fork-source-rollback:legacy-import";
      yield* sql`
        INSERT INTO orchestration_v2_projection_turn_items (
          turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
          parent_item_id, ordinal, type, status, updated_at, payload_json
        ) VALUES (
          ${importedItemId}, ${sourceThreadId}, NULL, NULL, NULL, NULL, NULL, 50,
          'assistant_message', 'completed', ${nowIso}, ${encodeUnknownJsonString({
            id: importedItemId,
            threadId: sourceThreadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 50,
            status: "completed",
            title: null,
            startedAt: nowIso,
            completedAt: nowIso,
            updatedAt: nowIso,
            type: "assistant_message",
            messageId: MessageId.make("message:projection-fork-source-rollback:legacy-import"),
            text: "legacy import before empty fork",
            streaming: false,
            historyOrigin: "v1_import",
          })}
        )
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.historyOrigin', 'v1_import')
        WHERE thread_id = ${sourceThreadId}
      `;
      yield* sql`
        UPDATE orchestration_v2_projection_threads
        SET payload_json = json_set(payload_json, '$.forkedFrom.runId', ${emptyBoundaryRunId})
        WHERE thread_id = ${targetThreadId}
      `;
      const importedEmptyBoundary = yield* projectionStore.getThreadSnapshotWindow(targetThreadId, {
        rowLimit: 2,
      });
      assert.deepEqual(
        importedEmptyBoundary.projection.visibleTurnItems.map((row) => [
          row.visibility,
          row.sourceThreadId,
          row.item.type === "assistant_message" ? row.item.text : row.item.type,
        ]),
        [
          ["inherited", sourceThreadId, "legacy import before empty fork"],
          ["synthetic", sourceThreadId, "fork"],
          ["local", targetThreadId, "command_execution"],
          ["local", targetThreadId, "command_execution"],
        ],
      );
    }),
  );

  it.effect("skips parent bodies once a fork's own turns fill its first page", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const now = DateTime.makeUnsafe("2026-10-01T00:00:00.000Z");
      const parentId = ThreadId.make("thread:filled-fork:parent");
      const forkId = ThreadId.make("thread:filled-fork:fork");
      const parentText = "parent prompt";
      const createThread = (
        threadId: ThreadId,
        forkedFrom: { readonly threadId: ThreadId; readonly runId: RunId } | null,
      ) =>
        store.apply({
          id: EventId.make(`event:${threadId}`),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project:filled-fork"),
            title: "Filled fork",
            providerInstanceId,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            activeProviderThreadId: null,
            lineage: {
              parentThreadId: forkedFrom?.threadId ?? null,
              relationshipToParent: forkedFrom === null ? null : "fork",
              rootThreadId: parentId,
            },
            forkedFrom: forkedFrom === null ? null : { type: "run", ...forkedFrom },
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
        });
      const addTurn = Effect.fnUntraced(function* (threadId: ThreadId, turn: number, text: string) {
        const runId = RunId.make(`run:${threadId}:${turn}`);
        const nodeId = NodeId.make(`node:${threadId}:${turn}`);
        yield* store.apply({
          id: EventId.make(`event:${runId}`),
          type: "run.created",
          threadId,
          runId,
          nodeId,
          driver,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: turn,
            providerInstanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make(`message:${runId}`),
            rootNodeId: nodeId,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        });
        yield* store.apply({
          id: EventId.make(`event:${runId}:prompt`),
          type: "turn-item.updated",
          threadId,
          runId,
          driver,
          occurredAt: now,
          payload: {
            id: TurnItemId.make(`item:${runId}`),
            threadId,
            runId,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: turn,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "user_message",
            messageId: MessageId.make(`message:${runId}`),
            inputIntent: "turn_start",
            createdBy: "user",
            creationSource: "web",
            text,
            attachments: [],
          },
        });
      });
      const readFirstPage = Effect.fnUntraced(function* (
        threadId: ThreadId,
        parsesParent: boolean,
      ) {
        const full = yield* store.getThreadSnapshot(threadId);
        // Measure only the window read; the full snapshot is the pagination oracle.
        const parse = yield* Effect.acquireRelease(
          Effect.sync(() => vi.spyOn(JSON, "parse")),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        const window = yield* store.getThreadSnapshotWindow(threadId, {
          rowLimit: THREAD_HISTORY_SNAPSHOT_ROW_LIMIT,
          userTurnLimit: THREAD_HISTORY_PAGE_POLICY.maxUserTurns,
        });
        assert.equal(
          parse.mock.calls.some(([text]) => text.includes(parentText)),
          parsesParent,
        );
        const page = buildBoundedThreadProjection(window);
        assert.deepEqual(page, buildBoundedThreadProjection(full));
        assert.isTrue(page.hasMoreHistory);
        assert.isNotNull(page.historyCursor);
        return page.projection.visibleTurnItems;
      }, Effect.scoped);

      yield* createThread(parentId, null);
      for (const turn of [1, 2, 3]) yield* addTurn(parentId, turn, `${parentText} ${turn}`);
      // The third parent turn is after the fork boundary and must stay excluded.
      yield* createThread(forkId, { threadId: parentId, runId: RunId.make(`run:${parentId}:2`) });
      for (let turn = 1; turn <= 9; turn += 1) yield* addTurn(forkId, turn, "fork prompt");
      const partial = yield* readFirstPage(forkId, true);
      assert.include(
        partial.map((row) => row.visibility),
        "inherited",
      );

      yield* addTurn(forkId, 10, "fork prompt");
      const filled = yield* readFirstPage(forkId, false);
      assert.notInclude(
        filled.map((row) => row.visibility),
        "inherited",
      );

      const nestedId = ThreadId.make("thread:filled-fork:nested");
      yield* createThread(nestedId, { threadId: forkId, runId: RunId.make(`run:${forkId}:10`) });
      for (let turn = 1; turn <= 10; turn += 1) yield* addTurn(nestedId, turn, "nested prompt");
      yield* readFirstPage(nestedId, true);
    }),
  );

  it.effect("a pull request watch keeps a finished thread working until it ends", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:watched-pull-request");
      const runId = RunId.make("run:watched-pull-request");
      const at = DateTime.makeUnsafe("2026-10-05T12:00:00.000Z");
      const thread = {
        createdBy: "user" as const,
        creationSource: "web" as const,
        id: threadId,
        projectId: ProjectId.make("project:watched-pull-request"),
        title: "Babysit the PR",
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: at,
        updatedAt: at,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:thread"),
        type: "thread.created",
        threadId,
        occurredAt: at,
        payload: thread,
      });
      yield* store.apply({
        id: EventId.make("event:watched-pull-request:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: at,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("message:watched-pull-request"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: at,
          startedAt: at,
          completedAt: at,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const link = {
        host: "github.com",
        repository: "acme/example-app",
        number: 7,
        url: "https://github.com/acme/example-app/pull/7",
        source: "agent" as const,
        linkedAt: DateTime.formatIso(at),
        snapshot: null,
        stack: null,
      };
      const syncPullRequests = (id: string, pullRequests: ReadonlyArray<ThreadPullRequestLink>) =>
        store.apply({
          id: EventId.make(`event:watched-pull-request:${id}`),
          type: "thread.pull-request-synced",
          threadId,
          occurredAt: at,
          payload: { ...thread, pullRequests },
        });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:watched-pull-request");
      const phase = Effect.gen(function* () {
        const shell = yield* store.getThreadShell(threadId);
        const listed = (yield* store.getShellSnapshot()).threads.find(
          (candidate) => candidate.id === threadId,
        );
        assert.deepEqual(listed?.pendingBackgroundTasks, shell?.pendingBackgroundTasks);
        return shell && projectThreadAwarenessV2({ environmentId, project, thread: shell })?.phase;
      });

      yield* syncPullRequests("watched", [
        {
          ...link,
          watch: {
            startedAt: DateTime.formatIso(at),
            headSha: null,
            failedChecks: [],
            passed: false,
            passedChecks: [],
            remarksThrough: DateTime.formatIso(at),
            remarkIds: [],
            conflicting: false,
            wakes: 0,
          },
        },
      ]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, [
        {
          taskId: "pull-request-watch:github.com/acme/example-app#7",
          description: "Watching pull request #7",
          kind: "monitor",
          awaited: true,
        },
      ]);
      assert.equal(yield* phase, "running");

      yield* syncPullRequests("unwatched", [link]);
      assert.deepEqual((yield* store.getThreadShell(threadId))?.pendingBackgroundTasks, []);
      assert.equal(yield* phase, "completed");
    }),
  );

  it.effect("dates a completion released by held background work at the release", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:held-completion");
      const runId = RunId.make("run:held-completion");
      const providerThreadId = ProviderThreadId.make("provider-thread:held-completion");
      const completedAt = DateTime.makeUnsafe("2026-09-28T12:00:00.000Z");
      const releasedAt = DateTime.makeUnsafe("2026-09-28T12:05:00.000Z");
      const providerThread = {
        id: providerThreadId,
        driver,
        providerInstanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle" as const,
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [
          { taskId: "watch", kind: "monitor" as const, awaited: true as const },
        ],
        createdAt: completedAt,
        updatedAt: completedAt,
      };
      yield* store.apply({
        id: EventId.make("event:held-completion:thread"),
        type: "thread.created",
        threadId,
        occurredAt: completedAt,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: threadId,
          projectId: ProjectId.make("project:held-completion"),
          title: "Watch the build",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null,
          createdAt: completedAt,
          updatedAt: completedAt,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:run"),
        type: "run.created",
        threadId,
        runId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:held-completion"),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: completedAt,
          startedAt: completedAt,
          completedAt,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-running"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: completedAt,
        payload: providerThread,
      });
      const project = { title: "Project" };
      const environmentId = EnvironmentId.make("environment:held-completion");
      const held = yield* store.getThreadShell(threadId);
      assert.equal(
        held && projectThreadAwarenessV2({ environmentId, project, thread: held })?.phase,
        "running",
      );

      // The monitor ends five minutes after the run: the push must not look stale.
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-ended"),
        type: "provider-thread.updated",
        threadId,
        driver,
        providerInstanceId,
        occurredAt: releasedAt,
        payload: { ...providerThread, pendingBackgroundTasks: [], updatedAt: releasedAt },
      });
      const released = yield* store.getThreadShell(threadId);
      const state =
        released && projectThreadAwarenessV2({ environmentId, project, thread: released });
      assert.equal(state?.phase, "completed");
      assert.equal(state?.updatedAt, DateTime.formatIso(releasedAt));

      // A later provider must not hide this owner's roster from restart recovery.
      yield* store.apply({
        id: EventId.make("event:held-completion:monitor-restarted"),
        type: "provider-thread.updated",
        threadId,
        occurredAt: releasedAt,
        payload: { ...providerThread, updatedAt: releasedAt },
      });
      const newerRunId = RunId.make("run:held-completion:new-provider");
      yield* store.apply({
        id: EventId.make("event:held-completion:new-provider"),
        type: "run.created",
        threadId,
        runId: newerRunId,
        occurredAt: releasedAt,
        payload: {
          ...(yield* store.getThreadProjection(threadId)).runs[0]!,
          id: newerRunId,
          ordinal: 2,
          providerThreadId: ProviderThreadId.make("provider-thread:held-completion:new-provider"),
          requestedAt: releasedAt,
          startedAt: releasedAt,
          completedAt: releasedAt,
        },
      });
      const { statements, tracer } = traceSqlStatements();
      assert.deepEqual(
        (yield* store
          .getRuntimeRecoveryProjection(threadId)
          .pipe(Effect.withTracer(tracer))).runs.map((run) => run.id),
        [runId, newerRunId],
      );
      // Live-item filters must hit the active partial indexes, not walk the thread's history.
      const sql = yield* SqlClient.SqlClient;
      for (const statement of statements.filter((query) => query.includes("turn_items"))) {
        const plan = (yield* sql.unsafe<{ readonly detail: string }>(
          `EXPLAIN QUERY PLAN ${statement}`,
        )).map((row) => row.detail);
        for (const detail of plan) {
          assert.notMatch(detail, /turn_items_(thread_ordinal|thread_run)_idx \(thread_id=\?\)$/);
        }
      }
    }),
  );
});
