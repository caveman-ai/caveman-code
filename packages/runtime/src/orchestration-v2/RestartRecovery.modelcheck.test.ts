/**
 * Restart recovery, checked over bounded universes against the real services.
 *
 * Property: after a reconcile nothing a dead provider process owned still looks live, a second reconcile changes
 * nothing, and a restart continuation reaches a cut run at most once, never past three in a row, never where the
 * user must step in, and always for an unblocked cut turn, even when a process is killed after any durable write.
 * Harm: a crash loop restarts work forever, a stopped turn resumes editing files, a thread spins forever after an
 * update, an approval looks answerable with no callback behind it, or a turn the restart cut is silently dropped.
 *
 * Everything runs on the real ProviderRuntimeRecoveryService, EventSink, EventStore, ProjectionStore (SQL),
 * EffectOutbox and ProviderSessionManager over SQLite, plus the real continueRestartedRun. Only the orchestrator's
 * message.dispatch, the provider's turn start after its session opens, and the provider process itself are stand-ins
 * (`threadsStandIn`, `startTurn`, `codexAdapter`), and the first two write what the real ones write through the real
 * EventSink. Counts go to stderr. The skill that keeps this in step with the code is
 * .claude/skills/restart-recovery/SKILL.md.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";
import { canonicalKey } from "@caveman-app/model-check";
import { afterAll } from "vitest";
import {
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import { continueRestartedRun } from "./RestartContinuation.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

// ---------------------------------------------------------------------------------------------------------------
// The universe: one app thread's persisted state when the server died.
// ---------------------------------------------------------------------------------------------------------------

/** The thread's latest run when the process died. */
type RunShape =
  | "none"
  | "preparing"
  | "starting"
  | "continuation-starting"
  | "running"
  | "waiting"
  | "waiting-checkpoint"
  | "completed";
/** A runtime request on that run's turn. */
type RequestShape =
  | "none"
  | "approval"
  | "tool-call"
  | "question"
  | "question-without-card"
  | "question-by-message";
/** Work that can outlive the turn that started it. */
type BackgroundShape = "none" | "shell" | "native-subagent" | "delegation";
/** A run queued behind it. */
type QueuedShape = "none" | "durable" | "held" | "buffered";

interface ThreadShape {
  readonly run: RunShape;
  readonly request: RequestShape;
  readonly background: BackgroundShape;
  readonly queued: QueuedShape;
  /** The provider thread still lists a background task it reported. */
  readonly roster: boolean;
}

interface World {
  readonly threads: ReadonlyArray<ThreadShape>;
  /** One provider session (one Codex app server) bound to every thread. */
  readonly session: "live" | "stopped";
}

const RUN_SHAPES: ReadonlyArray<RunShape> = [
  "none",
  "preparing",
  "starting",
  "continuation-starting",
  "running",
  "waiting",
  "waiting-checkpoint",
  "completed",
];
const REQUEST_SHAPES: ReadonlyArray<RequestShape> = [
  "none",
  "approval",
  "tool-call",
  "question",
  "question-without-card",
  "question-by-message",
];
const BACKGROUND_SHAPES: ReadonlyArray<BackgroundShape> = [
  "none",
  "shell",
  "native-subagent",
  "delegation",
];
const QUEUED_SHAPES: ReadonlyArray<QueuedShape> = ["none", "durable", "held", "buffered"];

const turnStarted = (run: RunShape) =>
  run === "running" || run === "waiting" || run === "waiting-checkpoint" || run === "completed";

/**
 * Shapes the runtime can persist: requests, background work and a roster need a turn that started, and only a
 * question answerable by message outlives its turn.
 */
const reachable = (shape: ThreadShape): boolean =>
  (shape.request === "none" ||
    (turnStarted(shape.run) &&
      (shape.run !== "completed" || shape.request === "question-by-message"))) &&
  (shape.background === "none" || turnStarted(shape.run)) &&
  (!shape.roster || turnStarted(shape.run));

const allThreadShapes: ReadonlyArray<ThreadShape> = RUN_SHAPES.flatMap((run) =>
  REQUEST_SHAPES.flatMap((request) =>
    BACKGROUND_SHAPES.flatMap((background) =>
      QUEUED_SHAPES.flatMap((queued) =>
        [false, true].map((roster) => ({ run, request, background, queued, roster })),
      ),
    ),
  ),
).filter(reachable);

// ---------------------------------------------------------------------------------------------------------------
// Seeding: the shapes written through the real projector.
// ---------------------------------------------------------------------------------------------------------------

const t0 = DateTime.makeUnsafe("2026-11-06T12:00:00.000Z");
const minutesAfterT0 = (minutes: number) => DateTime.add(t0, { minutes });
const instance = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: instance, model: "gpt-5.4" };

const ids = (threadId: ThreadId) => ({
  providerThread: ProviderThreadId.make(`pt:${threadId}`),
  earlierRun: RunId.make(`run:${threadId}:1`),
  run: RunId.make(`run:${threadId}:2`),
  queuedRun: RunId.make(`run:${threadId}:3`),
  attempt: RunAttemptId.make(`attempt:${threadId}`),
  turn: ProviderTurnId.make(`turn:${threadId}`),
  rootNode: NodeId.make(`node:${threadId}:root`),
  requestNode: NodeId.make(`node:${threadId}:request`),
  request: RuntimeRequestId.make(`request:${threadId}`),
  backgroundNode: NodeId.make(`node:${threadId}:background`),
  childThread: ThreadId.make(`${threadId}:child`),
  userMessage: MessageId.make(`message:${threadId}:user`),
  queuedMessage: MessageId.make(`message:${threadId}:queued`),
  assistantMessage: MessageId.make(`message:${threadId}:assistant`),
});

const eventId = (() => {
  let next = 0;
  return () => EventId.make(`event:mc:${++next}`);
})();

const threadPayload = (
  threadId: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: ProjectId.make("project:mc"),
  title: threadId,
  providerInstanceId: instance,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: t0,
  updatedAt: t0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});

const runPayload = (
  threadId: ThreadId,
  id: RunId,
  ordinal: number,
  fields: Partial<OrchestrationV2Run>,
): OrchestrationV2Run => ({
  id,
  threadId,
  ordinal,
  providerInstanceId: instance,
  modelSelection,
  providerThreadId: ids(threadId).providerThread,
  userMessageId: MessageId.make(`message:${id}`),
  rootNodeId: null,
  activeAttemptId: null,
  status: "completed",
  requestedAt: minutesAfterT0(ordinal),
  startedAt: minutesAfterT0(ordinal),
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  ...fields,
});

const userMessage = (
  threadId: ThreadId,
  id: MessageId,
  runId: RunId,
  kind: "user" | "buffered" | "durable-notification",
  text = "Do the work",
) =>
  ({
    id,
    threadId,
    runId,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: t0,
    updatedAt: t0,
    createdBy: kind === "user" ? "user" : "agent",
    creationSource: kind === "buffered" ? "provider" : kind === "user" ? "web" : "server",
    ...(kind === "user"
      ? {}
      : {
          notification: {
            source: { kind: "background_task" as const },
            outcome: "updated" as const,
            summary: "Background activity updated",
          },
        }),
  }) as const;

/** The events that persist one thread in `shape`, in the order the runtime writes them. */
const seedEvents = (
  threadId: ThreadId,
  shape: ThreadShape,
  session: { readonly id: ProviderSessionId; readonly status: World["session"] },
  thread: Partial<OrchestrationV2AppThread> = {},
): Array<OrchestrationV2DomainEvent> => {
  const sessionId = session.id;
  const id = ids(threadId);
  const at = minutesAfterT0(2);
  const events: Array<OrchestrationV2DomainEvent> = [];
  const push = (event: Omit<OrchestrationV2DomainEvent, "id" | "occurredAt" | "threadId">) =>
    events.push({
      id: eventId(),
      occurredAt: at,
      threadId,
      ...event,
    } as OrchestrationV2DomainEvent);

  push({ type: "thread.created", payload: threadPayload(threadId, thread) } as never);
  push({
    type: "provider-session.attached",
    driver,
    providerInstanceId: instance,
    payload: {
      id: sessionId,
      driver,
      providerInstanceId: instance,
      status: session.status === "live" ? "ready" : "stopped",
      cwd: "/workspace",
      model: modelSelection.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: t0,
      updatedAt: t0,
      lastError: null,
    },
  } as never);
  push({
    type: "provider-thread.updated",
    driver,
    providerInstanceId: instance,
    payload: {
      id: id.providerThread,
      driver,
      providerInstanceId: instance,
      providerSessionId: sessionId,
      appThreadId: threadId,
      ownerNodeId: null,
      nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
      nativeConversationHeadRef: null,
      status: shape.run === "running" ? "active" : "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 2,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: shape.roster
        ? [{ taskId: `task:${threadId}`, kind: "subagent", description: "Review the diff" }]
        : [],
      createdAt: t0,
      updatedAt: t0,
    },
  } as never);

  const runEvent = (run: OrchestrationV2Run) =>
    push({ type: "run.created", runId: run.id, payload: run } as never);
  const message = (payload: ReturnType<typeof userMessage> | Record<string, unknown>) =>
    push({ type: "message.updated", payload } as never);

  if (shape.run === "none") {
    // Nothing started yet; only a queued run (below) can exist.
  } else {
    runEvent(
      runPayload(threadId, id.earlierRun, 1, {
        status: shape.run === "continuation-starting" ? "cancelled" : "completed",
        completedAt: minutesAfterT0(1),
      }),
    );
    message(userMessage(threadId, id.userMessage, id.run, "user"));
    const started = turnStarted(shape.run);
    // A starting run already has its attempt and a pending turn: the provider had not accepted it yet.
    const admitted = started || shape.run === "starting";
    const runStatus: OrchestrationV2Run["status"] =
      shape.run === "continuation-starting"
        ? "starting"
        : shape.run === "waiting-checkpoint"
          ? "waiting"
          : shape.run;
    runEvent(
      runPayload(threadId, id.run, 2, {
        status: runStatus,
        userMessageId: id.userMessage,
        startedAt: started ? at : null,
        rootNodeId: admitted ? id.rootNode : null,
        activeAttemptId: admitted ? id.attempt : null,
        completedAt: shape.run === "completed" ? at : null,
        ...(shape.run === "continuation-starting"
          ? { restartContinuationOfRunId: id.earlierRun }
          : {}),
      }),
    );
    if (admitted) {
      const pending = shape.run === "starting";
      const live = shape.run === "running";
      const settled = shape.run === "completed";
      const turnStatus = pending ? "pending" : live ? "running" : "completed";
      push({
        type: "run-attempt.created",
        runId: id.run,
        nodeId: id.rootNode,
        providerInstanceId: instance,
        payload: {
          id: id.attempt,
          runId: id.run,
          attemptOrdinal: 1,
          rootNodeId: id.rootNode,
          providerInstanceId: instance,
          providerThreadId: id.providerThread,
          providerTurnId: id.turn,
          reason: "initial",
          status: turnStatus,
          startedAt: pending ? null : at,
          completedAt: pending || live ? null : at,
        },
      } as never);
      push({
        type: "node.updated",
        runId: id.run,
        nodeId: id.rootNode,
        providerInstanceId: instance,
        payload: {
          id: id.rootNode,
          threadId,
          runId: id.run,
          parentNodeId: null,
          rootNodeId: id.rootNode,
          kind: "root_turn",
          status: pending ? "pending" : live ? "running" : settled ? "completed" : "waiting",
          countsForRun: true,
          providerThreadId: id.providerThread,
          providerTurnId: id.turn,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: pending ? null : at,
          completedAt: settled ? at : null,
        },
      } as never);
      push({
        type: "provider-turn.updated",
        runId: id.run,
        nodeId: id.rootNode,
        providerInstanceId: instance,
        payload: {
          id: id.turn,
          providerThreadId: id.providerThread,
          nodeId: id.rootNode,
          runAttemptId: id.attempt,
          nativeTurnRef: pending
            ? null
            : { driver, nativeId: `native-turn:${threadId}`, strength: "strong" },
          ordinal: 1,
          status: turnStatus,
          startedAt: pending ? null : at,
          completedAt: pending || live ? null : at,
        },
      } as never);
    }
    if (started) {
      const live = shape.run === "running";
      message({
        id: id.assistantMessage,
        threadId,
        runId: id.run,
        nodeId: id.rootNode,
        role: "assistant",
        text: "Working on it",
        attachments: [],
        streaming: live,
        createdAt: at,
        updatedAt: at,
        createdBy: "agent",
        creationSource: "provider",
      });
    }
  }

  if (shape.request !== "none") {
    const question = shape.request.startsWith("question");
    push({
      type: "node.updated",
      runId: id.run,
      nodeId: id.requestNode,
      providerInstanceId: instance,
      payload: {
        id: id.requestNode,
        threadId,
        runId: id.run,
        parentNodeId: id.rootNode,
        rootNodeId: id.rootNode,
        kind: question ? "user_input_request" : "approval_request",
        status: "waiting",
        countsForRun: false,
        providerThreadId: id.providerThread,
        providerTurnId: id.turn,
        nativeItemRef: null,
        runtimeRequestId: id.request,
        checkpointScopeId: null,
        startedAt: at,
        completedAt: null,
      },
    } as never);
    push({
      type: "runtime-request.updated",
      nodeId: id.requestNode,
      payload: {
        id: id.request,
        nodeId: id.requestNode,
        providerTurnId: id.turn,
        nativeRequestRef: null,
        kind: question
          ? "user_input"
          : shape.request === "tool-call"
            ? "dynamic_tool_call"
            : "command",
        status: "pending",
        responseCapability:
          shape.request === "question-by-message"
            ? { type: "message" }
            : { type: "live", providerSessionId: sessionId },
        createdAt: at,
        resolvedAt: null,
      },
    } as never);
    if (shape.request === "question" || shape.request === "question-by-message") {
      push({
        type: "turn-item.updated",
        runId: id.run,
        nodeId: id.requestNode,
        payload: {
          id: TurnItemId.make(`item:${threadId}:question`),
          threadId,
          runId: id.run,
          nodeId: id.requestNode,
          providerThreadId: id.providerThread,
          providerTurnId: id.turn,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 2,
          status: "waiting",
          title: null,
          startedAt: at,
          completedAt: null,
          updatedAt: at,
          type: "user_input_request",
          requestId: id.request,
          questions: [
            {
              id: "q1",
              header: "Database",
              question: "Which database?",
              options: [{ label: "SQLite", description: "Local file" }],
            },
          ],
        },
      } as never);
    }
  }

  if (shape.background !== "none") {
    const subagent = shape.background !== "shell";
    push({
      type: "node.updated",
      runId: id.run,
      nodeId: id.backgroundNode,
      providerInstanceId: instance,
      payload: {
        id: id.backgroundNode,
        threadId,
        runId: id.run,
        parentNodeId: id.rootNode,
        rootNodeId: id.rootNode,
        kind: subagent ? "subagent" : "tool_call",
        status: "running",
        countsForRun: false,
        providerThreadId: id.providerThread,
        providerTurnId: id.turn,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt: at,
        completedAt: null,
      },
    } as never);
    if (subagent) {
      const delegation = shape.background === "delegation";
      push({
        type: "subagent.updated",
        runId: id.run,
        nodeId: id.backgroundNode,
        driver,
        providerInstanceId: instance,
        payload: {
          id: id.backgroundNode,
          threadId,
          runId: id.run,
          parentNodeId: id.rootNode,
          origin: delegation ? "app_owned" : "provider_native",
          createdBy: "agent",
          driver,
          providerInstanceId: instance,
          providerThreadId: delegation ? null : id.providerThread,
          childThreadId: delegation ? id.childThread : null,
          nativeTaskRef: delegation
            ? null
            : { driver, nativeId: `native-task:${threadId}`, strength: "strong" },
          prompt: "Review the diff",
          title: "Reviewer",
          model: null,
          ...(delegation ? { completionWake: "settled_only" as const } : {}),
          status: "running",
          result: null,
          startedAt: at,
          completedAt: null,
          updatedAt: at,
        },
      } as never);
    }
    push({
      type: "turn-item.updated",
      runId: id.run,
      nodeId: id.backgroundNode,
      payload: {
        id: TurnItemId.make(`item:${threadId}:background`),
        threadId,
        runId: id.run,
        nodeId: id.backgroundNode,
        providerThreadId: id.providerThread,
        providerTurnId: id.turn,
        nativeItemRef: { driver, nativeId: `native-item:${threadId}`, strength: "strong" },
        parentItemId: null,
        ordinal: 3,
        status: "running",
        title: subagent ? "Reviewer" : "npm test",
        startedAt: at,
        completedAt: null,
        updatedAt: at,
        ...(subagent
          ? {
              type: "subagent",
              subagentId: id.backgroundNode,
              origin: shape.background === "delegation" ? "app_owned" : "provider_native",
              driver,
              providerInstanceId: instance,
              childThreadId: shape.background === "delegation" ? id.childThread : null,
              prompt: "Review the diff",
              result: null,
            }
          : { type: "command_execution", input: "npm test" }),
      },
    } as never);
  }

  if (shape.queued !== "none") {
    runEvent(
      runPayload(threadId, id.queuedRun, 3, {
        status: "queued",
        userMessageId: id.queuedMessage,
        startedAt: null,
        queuePosition: 1,
        ...(shape.queued === "held" ? { queueHeld: true } : {}),
      }),
    );
    message(
      userMessage(
        threadId,
        id.queuedMessage,
        id.queuedRun,
        shape.queued === "buffered" ? "buffered" : "user",
        "And then this",
      ),
    );
  }
  return events;
};

// ---------------------------------------------------------------------------------------------------------------
// The real stack, with every commit and outbox write recorded.
// ---------------------------------------------------------------------------------------------------------------

interface Recorded {
  /** Every commit recovery and the session manager asked for, with the events and effects it carried. */
  readonly commits: Array<{
    readonly via: "commitCommand" | "writeWithEffects" | "write";
    readonly threadId: ThreadId | undefined;
    readonly commandId: string | undefined;
    readonly events: ReadonlyArray<OrchestrationV2DomainEvent>;
    readonly effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>;
  }>;
}

/**
 * A process life that can be killed right after any durable write. Every service call that writes is wrapped: when
 * SQLite's total_changes() moved, the call was a durable write (one transaction or one autocommit statement), it is
 * named in `writes`, and the life is killed if it was the chosen one. A killed process runs nothing more: the fiber
 * is interrupted, and since the session manager catches interrupts in places (each release write runs under
 * Effect.exit), every later wrapped call is refused before it can write. The next life starts from exactly what was
 * committed. A row change outside a wrapped call is reported, since no kill could land there.
 */
interface LifeControl {
  readonly cut: Cut;
  readonly writes: Array<string>;
  step: string;
  /** total_changes() after the last wrapped write. */
  seen: number;
  readonly problems: Array<string>;
  readonly dispatched: Array<Dispatched>;
  /** Set when the worker was interrupted at a graceful shutdown: the life goes on to prepareForShutdown. */
  workerStopped: boolean;
  /** How many durable writes the life had made when the worker's interrupt landed. */
  workerStoppedAt: number | undefined;
  /**
   * Completed by the worker fiber where a graceful shutdown's interrupt lands; the life then interrupts that fiber
   * from outside, as serverRuntimeStartup's finalizer does (`Fiber.interrupt(workerFiber)`). An outside interrupt
   * skips the code's catchCause and Effect.exit and runs its onError and finalizers, unlike a failure.
   */
  stopWorker: Deferred.Deferred<void> | undefined;
  /** The worker's interrupt lands at its next wrapped call, after the chosen write's call returned. */
  stopWorkerAtNextCall: boolean;
  /** Set when the life is killed: nothing it runs after that commits. */
  dead: boolean;
  /**
   * Set once a life that shut down has run its steps. Closing its services (the session manager's own finalizer)
   * must write nothing: a write there would be a step the timelines never kill at.
   */
  closing: boolean;
  /** Writes made while this is set are setup (the sessions the mid-turn process already held), not kill points. */
  setup: boolean;
}

/**
 * Where a life ends: killed after that many durable writes, killed as a step begins, killed after the first write
 * whose description contains `afterWrite`, shut down gracefully while the effect worker was mid-effect (the worker
 * interrupted right after that many durable writes, or after the first write whose description contains the string,
 * as serverRuntimeStartup's finalizer interrupts the worker fiber before prepareForShutdown), or (undefined) shut down
 * after every step. The worker's interrupt lands inside the write's call by default; `afterCall` lands it once that
 * call has returned. The two differ only where the code handles an interrupt between them: ProviderSessionManager.open
 * releases a session whose attach write was interrupted (releaseEntry with manual_shutdown) and keeps one whose
 * attach returned.
 */
type Cut =
  | number
  | { readonly before: LifeStep }
  | { readonly afterWrite: string }
  | { readonly workerStoppedAfter: number | string; readonly afterCall?: true }
  | undefined;

interface Dispatched {
  readonly sourceRunId: RunId | undefined;
  readonly commandId: string;
  readonly messageId: string;
}

const totalChanges = (sql: SqlClient.SqlClient) =>
  sql<{ readonly changes: number }>`SELECT total_changes() AS changes`.pipe(
    Effect.map((rows) => Number(rows[0]!.changes)),
    Effect.orDie,
  );

/** The worker fiber parks here until the life interrupts it from outside. */
const awaitWorkerStop = (control: LifeControl) =>
  Effect.gen(function* () {
    if (control.stopWorker === undefined) {
      control.problems.push(
        `${control.step}: a graceful shutdown's worker interrupt landed outside the effect worker`,
      );
      return yield* Effect.interrupt;
    }
    control.workerStoppedAt = control.writes.length;
    yield* Deferred.succeed(control.stopWorker, undefined);
    return yield* Effect.never;
  });

const durable = <A, E>(
  control: LifeControl | undefined,
  sql: SqlClient.SqlClient,
  label: string | ((result: A) => string),
  write: Effect.Effect<A, E>,
): Effect.Effect<A, E> =>
  control === undefined
    ? write
    : Effect.gen(function* () {
        // A killed process commits nothing more, even where the code under it catches the interrupt.
        if (control.dead) return yield* Effect.interrupt;
        if (control.closing) {
          control.problems.push(
            `closing the process: a write after its last step, where no kill can land`,
          );
          return yield* Effect.interrupt;
        }
        if (control.stopWorkerAtNextCall) {
          control.stopWorkerAtNextCall = false;
          return yield* awaitWorkerStop(control);
        }
        const before = yield* totalChanges(sql);
        if (before !== control.seen)
          control.problems.push(
            `${control.step}: ${before - control.seen} row change(s) outside a wrapped write, where no kill can land`,
          );
        const result = yield* write;
        control.seen = yield* totalChanges(sql);
        if (control.seen === before || control.setup) return result;
        const line = `${control.step}: ${typeof label === "string" ? label : label(result)}`;
        control.writes.push(line);
        const cut = control.cut;
        if (
          typeof cut === "object" &&
          "workerStoppedAfter" in cut &&
          (typeof cut.workerStoppedAfter === "number"
            ? control.writes.length === cut.workerStoppedAfter
            : line.includes(cut.workerStoppedAfter) &&
              control.writes.filter((write) => write.includes(cut.workerStoppedAfter as string))
                .length === 1)
        ) {
          if (cut.afterCall === true) {
            control.stopWorkerAtNextCall = true;
            return result;
          }
          return yield* awaitWorkerStop(control);
        }
        if (
          typeof cut === "number"
            ? control.writes.length === cut
            : cut !== undefined && "afterWrite" in cut && line.includes(cut.afterWrite)
        ) {
          control.dead = true;
          return yield* Effect.interrupt;
        }
        return result;
      });

const effectIds = (effects: ReadonlyArray<EffectOutbox.PendingOrchestrationEffectV2>) =>
  effects.length === 0 ? "" : ` enqueuing ${effects.map((effect) => effect.id).join(", ")}`;

/** Event types, with the status a session or request update moves to: `provider-session.updated stopped`. */
const describeEvents = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  events
    .map((event) =>
      (event.type === "provider-session.updated" || event.type === "runtime-request.updated") &&
      typeof (event.payload as { readonly status?: unknown }).status === "string"
        ? `${event.type} ${(event.payload as { readonly status: string }).status}`
        : event.type,
    )
    .join(", ");

/** The real EventSink, with the commits recovery asks for recorded, and every write killable when `control` is set. */
const recordingEventSink = (recorded: Recorded, control?: LifeControl) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const real = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      return EventSink.EventSinkV2.of({
        ...real,
        commitCommand: (input) => {
          recorded.commits.push({
            via: "commitCommand",
            threadId: input.threadId,
            commandId: input.commandId,
            events: input.events,
            effects: input.effects,
          });
          return durable(
            control,
            sql,
            `commitCommand(${input.commandType}) on ${input.threadId}${effectIds(input.effects)}`,
            real.commitCommand(input),
          );
        },
        writeWithEffects: (input) => {
          recorded.commits.push({
            via: "writeWithEffects",
            threadId: input.effects[0]?.threadId,
            commandId: input.commandId,
            events: input.events,
            effects: input.effects,
          });
          return durable(
            control,
            sql,
            `writeWithEffects(${input.events.map((event) => event.type).join(", ")}) on ${input.effects[0]?.threadId ?? input.events[0]?.threadId}${effectIds(input.effects)}`,
            real.writeWithEffects(input),
          );
        },
        writeIfRunCurrent: (input) =>
          durable(
            control,
            sql,
            `writeIfRunCurrent(${input.runId} still ${input.expectedStatus}: ${input.events.map((event) => event.type).join(", ")})`,
            real.writeIfRunCurrent(input),
          ),
        // The session manager's writes: attachments, and the release records of a session it lets go.
        write: (input) => {
          recorded.commits.push({
            via: "write",
            threadId: input.events[0]?.threadId,
            commandId: input.commandId,
            events: input.events,
            effects: [],
          });
          return durable(
            control,
            sql,
            `write(${describeEvents(input.events)}) on ${[...new Set(input.events.map((event) => event.threadId))].join(", ")}`,
            real.write(input),
          );
        },
        writeIfProviderThreadUnchanged: (input) =>
          durable(
            control,
            sql,
            `writeIfProviderThreadUnchanged(${input.expected.id})`,
            real.writeIfProviderThreadUnchanged(input),
          ),
      });
    }),
  ).pipe(Layer.provide(EventSink.layer));

/**
 * The real outbox with its writing calls killable. Given to the recovery service and the test's effect worker; the
 * EventSink keeps the unwrapped outbox, whose calls run inside the sink's own transactions.
 */
const killableOutbox = (
  real: EffectOutbox.EffectOutboxV2Shape,
  control: LifeControl,
  sql: SqlClient.SqlClient,
): EffectOutbox.EffectOutboxV2Shape => ({
  ...real,
  cancelUnsettled: (input) =>
    durable(
      control,
      sql,
      `outbox.cancelUnsettled on ${input.threadId}`,
      real.cancelUnsettled(input),
    ),
  reconcileAfterProcessLoss: Effect.gen(function* () {
    // Two autocommit statements, wrapped as one write: the first cancels process-bound effects, the second
    // requeues replay-safe ones. A kill between them is a different state only if the first one has rows to cancel.
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
      WHERE status IN ('pending', 'running') AND effect_type IN ${sql.in(EffectOutbox.PROCESS_BOUND_EFFECT_TYPES)}
    `.pipe(Effect.orDie);
    const count = Number(rows[0]?.count ?? 0);
    if (count > 0)
      control.problems.push(
        `${control.step}: reconcileAfterProcessLoss found ${count} process-bound effect(s) no thread commit cancelled, so a kill between its two statements is a state this check does not reach`,
      );
    return yield* durable(
      control,
      sql,
      "outbox.reconcileAfterProcessLoss",
      real.reconcileAfterProcessLoss,
    );
  }),
  claimNext: (input) =>
    durable(
      control,
      sql,
      (claimed) =>
        `outbox.claimNext -> ${Option.match(claimed, { onNone: () => "none", onSome: (effect) => effect.id })}`,
      real.claimNext(input),
    ),
  succeed: (input) =>
    durable(control, sql, `outbox.succeed(${input.effectId})`, real.succeed(input)),
});

/**
 * Every world or timeline gets its own throwaway database file, copied from one the real migrations built (migrating
 * costs about 25 ms, a copy a fraction of one). A timeline branches the same way: each life starts from a copy of
 * the file the life before it left, which is what a restarted server finds.
 */
const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "restart-recovery-"));
afterAll(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));
let migratedFile: string | undefined;
const migrated = Effect.gen(function* () {
  if (migratedFile !== undefined) return migratedFile;
  const file = NodePath.join(scratch, "migrated.db");
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`VACUUM INTO '${file}'`);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));
  return (migratedFile = file);
});
let nextFile = 0;
const copyOf = (file: string) => {
  const copy = NodePath.join(scratch, `${++nextFile}.db`);
  NodeFS.copyFileSync(file, copy);
  return copy;
};
const remove = (file: string) => NodeFS.rmSync(file, { force: true });

const database = (file: string) =>
  Layer.provideMerge(
    Layer.effectDiscard(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`PRAGMA foreign_keys = ON`;
        // Throwaway copies: a kill here is an interrupt between commits, never a torn write, so skip the syncing.
        yield* sql`PRAGMA journal_mode = MEMORY`;
        yield* sql`PRAGMA synchronous = OFF`;
      }),
    ),
    NodeSqliteClient.layer({ filename: file }),
  );

const stores = (file: string) =>
  Layer.mergeAll(
    EventStore.layer,
    ProjectionStoreWithV1.layer,
    EffectOutbox.layer,
    IdAllocator.layer,
  ).pipe(Layer.provideMerge(database(file)));

/**
 * The provider process behind a session: a Codex app server that opens at once and reports nothing. Restart recovery
 * never asks a provider anything; the session manager only opens a session on it, attaches threads, and closes it.
 */
const codexAdapter = ProviderAdapter.ProviderAdapterV2.of({
  instanceId: instance,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  openSession: (input) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const unused = (operation: string) => () =>
        Effect.die(`the check never calls the provider's ${operation}`);
      return {
        instanceId: instance,
        driver,
        providerSessionId: input.providerSessionId,
        providerSession: {
          id: input.providerSessionId,
          driver,
          providerInstanceId: instance,
          status: "ready",
          cwd: "/workspace",
          model: modelSelection.model,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.never,
        ensureThread: unused("ensureThread"),
        resumeThread: unused("resumeThread"),
        startTurn: unused("startTurn"),
        steerTurn: unused("steerTurn"),
        interruptTurn: unused("interruptTurn"),
        respondToRuntimeRequest: unused("respondToRuntimeRequest"),
        readThreadSnapshot: unused("readThreadSnapshot"),
        rollbackThread: unused("rollbackThread"),
        forkThread: unused("forkThread"),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
});

/**
 * The real ProviderSessionManager over the given EventSink and stores. It owns which sessions this process holds and
 * which threads each serves, writes their attachments, and on shutdown releases them (`shutdown`, releaseEntry with
 * server_shutdown). MCP is off (`configureMcp: false`, the option replay harnesses use): credentials are in memory
 * and recovery reads none. The idle release is a day away, so it never fires inside a life.
 */
const sessionManager = ProviderSessionManager.layerWithOptions({
  idleTimeoutMs: 24 * 60 * 60 * 1_000,
  configureMcp: false,
}).pipe(
  Layer.provide(
    Layer.mergeAll(
      ProviderAdapterRegistry.layerSingle(codexAdapter),
      McpProviderSessions.layer,
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({}),
      Layer.mock(CommandOutputHub.CommandOutputHub)({}),
      Layer.mock(ProviderEventIngestor.ProviderEventIngestorV2)({}),
      FileSystem.layerNoop({}),
    ),
  ),
);

/** What ProviderTurnStartService opens a session with, minus the workspace check (`cwd: null`). */
const openSession = (threadId: ThreadId, providerSessionId: ProviderSessionId) =>
  Effect.gen(function* () {
    const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
    return yield* manager
      .open({
        threadId,
        providerSessionId,
        modelSelection,
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: null },
        initialNativeThreadId: `native:${threadId}`,
      })
      .pipe(Effect.orDie);
  });

const stack = (
  recorded: Recorded,
  file: string,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) => {
  const services = recordingEventSink(recorded).pipe(
    Layer.provideMerge(stores(file)),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
  );
  return Layer.mergeAll(ProviderRuntimeRecovery.layer, sessionManager).pipe(
    Layer.provideMerge(services),
  );
};

const outboxRows = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{
    readonly effect_id: string;
    readonly effect_type: string;
    readonly status: string;
  }>`
    SELECT effect_id, effect_type, status FROM orchestration_v2_effect_outbox ORDER BY effect_id
  `;
});

const sessionStatus = (sessionId: ProviderSessionId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly status: string }>`
      SELECT status FROM orchestration_v2_projection_provider_sessions WHERE provider_session_id = ${sessionId}
    `;
    return rows[0]?.status;
  });

// ---------------------------------------------------------------------------------------------------------------
// What recovery promises, read back from the persisted projections.
// ---------------------------------------------------------------------------------------------------------------

const OPEN_WORK = new Set(["pending", "running", "waiting"]);
const LIVE_RUN = new Set(["preparing", "starting", "running", "waiting"]);
const BACKGROUND_TYPES = new Set(["command_execution", "dynamic_tool", "subagent"]);

interface LiveRecord {
  /** The kind of record, so a run can show the universe really seeded every kind. */
  readonly kind: string;
  readonly line: string;
}

/** Every record a dead provider process owned that still looks live, minus what recovery is meant to keep. */
const stillLive = (
  projection: OrchestrationV2ThreadProjection,
  checkpointPendingRunIds: ReadonlySet<string>,
): Array<LiveRecord> => {
  const live: Array<LiveRecord> = [];
  const add = (kind: string, line: string) => live.push({ kind, line });
  // A waiting run whose checkpoint capture is still in the outbox finishes when that effect replays.
  const heldRunIds = new Set(
    projection.runs
      .filter((run) => run.status === "waiting" && checkpointPendingRunIds.has(run.id))
      .map((run) => run.id),
  );
  const backgroundNodeIds = new Set(
    projection.turnItems.flatMap((item) =>
      BACKGROUND_TYPES.has(item.type) && item.nodeId !== null ? [item.nodeId] : [],
    ),
  );
  const messageRequestNodeIds = new Set(
    projection.runtimeRequests
      .filter(
        (request) => request.status === "pending" && request.responseCapability.type === "message",
      )
      .map((request) => request.nodeId),
  );
  const delegationIds = new Set(
    projection.subagents
      .filter((task) => task.origin === "app_owned" && task.childThreadId !== null)
      .map((task) => task.id),
  );
  for (const run of projection.runs) {
    if (LIVE_RUN.has(run.status) && !heldRunIds.has(run.id))
      add("run", `run ${run.id} is ${run.status}`);
    if (run.status === "queued" && run.queueHeld !== true)
      add("queued run", `queued run ${run.id} is not held`);
  }
  for (const attempt of projection.attempts)
    if (
      (attempt.status === "pending" || attempt.status === "running") &&
      !heldRunIds.has(attempt.runId)
    )
      add(
        attempt.status === "pending" ? "pending attempt" : "attempt",
        `attempt ${attempt.id} is ${attempt.status}`,
      );
  for (const turn of projection.providerTurns)
    if (turn.status === "pending" || turn.status === "running")
      add(
        turn.status === "pending" ? "pending provider turn" : "provider turn",
        `provider turn ${turn.id} is ${turn.status}`,
      );
  for (const node of projection.nodes)
    if (
      OPEN_WORK.has(node.status) &&
      !messageRequestNodeIds.has(node.id) &&
      !delegationIds.has(node.id) &&
      !(node.runId !== null && heldRunIds.has(node.runId) && !backgroundNodeIds.has(node.id))
    )
      add(`${node.kind} node`, `node ${node.id} (${node.kind}) is ${node.status}`);
  for (const message of projection.messages)
    if (message.streaming && !(message.runId !== null && heldRunIds.has(message.runId)))
      add("streaming message", `message ${message.id} is streaming`);
  for (const item of projection.turnItems)
    if (
      OPEN_WORK.has(item.status) &&
      !(item.nodeId !== null && messageRequestNodeIds.has(item.nodeId)) &&
      !(item.type === "subagent" && delegationIds.has(item.subagentId)) &&
      !(item.runId !== null && heldRunIds.has(item.runId) && !BACKGROUND_TYPES.has(item.type))
    )
      add(`${item.type} item`, `turn item ${item.id} (${item.type}) is ${item.status}`);
  for (const request of projection.runtimeRequests)
    if (request.status === "pending" && request.responseCapability.type !== "message")
      add(
        `${request.kind} request`,
        `runtime request ${request.id} (${request.kind}) is pending on a ${request.responseCapability.type} callback`,
      );
  for (const providerThread of projection.providerThreads) {
    if (providerThread.status === "active")
      add("active provider thread", `provider thread ${providerThread.id} is active`);
    if ((providerThread.pendingBackgroundTasks?.length ?? 0) > 0)
      add("background roster", `provider thread ${providerThread.id} still lists background tasks`);
  }
  for (const task of projection.subagents)
    if (task.origin === "provider_native" && OPEN_WORK.has(task.status))
      add("native subagent", `native subagent ${task.id} is ${task.status}`);
  return live;
};

/** Every kind of live record the universe must seed somewhere, or a pass would prove nothing about it. */
const SEEDED_KINDS = [
  "run",
  "queued run",
  "attempt",
  "provider turn",
  "pending attempt",
  "pending provider turn",
  "root_turn node",
  "approval_request node",
  "user_input_request node",
  "tool_call node",
  "subagent node",
  "streaming message",
  "command_execution item",
  "subagent item",
  "user_input_request item",
  "command request",
  "user_input request",
  "dynamic_tool_call request",
  "active provider thread",
  "background roster",
  "native subagent",
];

/** The parts of each shape recovery must keep rather than end. */
const notKept = (
  shape: ThreadShape,
  projection: OrchestrationV2ThreadProjection,
  threadId: ThreadId,
): Array<string> => {
  const id = ids(threadId);
  const problems: Array<string> = [];
  const queued = projection.runs.find((run) => run.id === id.queuedRun);
  if (shape.queued === "durable" || shape.queued === "held")
    if (queued?.status !== "queued" || queued.queueHeld !== true)
      problems.push(
        `durable queued run ${id.queuedRun} is ${queued?.status} held=${queued?.queueHeld}, not held in the queue`,
      );
  if (shape.queued === "buffered" && queued?.status !== "cancelled")
    problems.push(`buffered wake ${id.queuedRun} is ${queued?.status}, not cancelled`);
  if (shape.request === "question" || shape.request === "question-by-message") {
    const request = projection.runtimeRequests.find((candidate) => candidate.id === id.request);
    if (request?.status !== "pending" || request.responseCapability.type !== "message")
      problems.push(
        `question ${id.request} is ${request?.status} via ${request?.responseCapability.type}, not answerable by message`,
      );
  }
  return problems;
};

const checkpointEffect = (threadId: ThreadId): EffectOutbox.PendingOrchestrationEffectV2 => ({
  id: `effect:checkpoint:${ids(threadId).run}`,
  commandId: CommandId.make(`command:effect:checkpoint.capture:${ids(threadId).run}`),
  threadId,
  request: {
    type: "checkpoint.capture",
    runId: ids(threadId).run,
    scopeId: CheckpointScopeId.make(`scope:${threadId}`),
  },
});

const describeWorld = (world: World) =>
  `session ${world.session}; ${world.threads
    .map((shape, index) => `thread ${index}: ${canonicalKey(shape)}`)
    .join("; ")}`;

const worldThreadId = (world: number, thread: number) =>
  ThreadId.make(`thread:mc:${world}:${thread}`);
const worldSessionId = (world: number) => ProviderSessionId.make(`session:mc:${world}`);
const worldOf = (threadId: string | undefined) => Number(threadId?.split(":")[2] ?? Number.NaN);

/**
 * Seeds every world into one database (worlds share no ids, so recovery treats them independently, as it does
 * unrelated threads), reconciles on `firstTrigger` and then on startup, and returns each world's broken promises.
 * A graceful shutdown runs prepareForShutdown, then the session manager's shutdown, first, as serverRuntimeStartup
 * does.
 */
const reconcileTwice = (worlds: ReadonlyArray<World>, firstTrigger: "startup" | "shutdown") =>
  Effect.gen(function* () {
    const recorded: Recorded = { commits: [] };
    const file = copyOf(yield* migrated);
    return yield* reconcileTwiceIn(recorded, worlds, firstTrigger).pipe(
      Effect.provide(stack(recorded, file)),
      Effect.provide(TestClock.layer()),
      Effect.ensuring(Effect.sync(() => remove(file))),
    );
  });

const reconcileTwiceIn = (
  recorded: Recorded,
  worlds: ReadonlyArray<World>,
  firstTrigger: "startup" | "shutdown",
) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
    yield* TestClock.setTime(DateTime.toEpochMillis(minutesAfterT0(30)));
    const problems = worlds.map(() => [] as Array<string>);
    const seeded = new Map<string, number>();
    const checkpointPendingRunIds = new Set<string>();
    // One transaction for the whole batch: the same rows, without a commit per event.
    yield* (yield* SqlClient.SqlClient).withTransaction(
      Effect.gen(function* () {
        for (const [w, world] of worlds.entries())
          for (const [t, shape] of world.threads.entries()) {
            const threadId = worldThreadId(w, t);
            for (const event of seedEvents(threadId, shape, {
              id: worldSessionId(w),
              status: world.session,
            }))
              yield* projections.apply(event);
            if (shape.run === "waiting-checkpoint") {
              yield* outbox.enqueue([checkpointEffect(threadId)]);
              checkpointPendingRunIds.add(ids(threadId).run);
            }
          }
      }),
    );
    for (const [w, world] of worlds.entries())
      for (const t of world.threads.keys())
        for (const { kind } of stillLive(
          yield* projections.getThreadProjection(worldThreadId(w, t)),
          new Set(),
        ))
          seeded.set(kind, (seeded.get(kind) ?? 0) + 1);

    const released = { sessions: 0, requests: 0 };
    if (firstTrigger === "shutdown") {
      // The process going down holds each world's live session, serving that world's threads.
      const manager = yield* ProviderSessionManager.ProviderSessionManagerV2;
      for (const [w, world] of worlds.entries())
        if (world.session === "live")
          for (const t of world.threads.keys())
            yield* openSession(worldThreadId(w, t), worldSessionId(w));
      // serverRuntimeStartup's finalizer, after it interrupts the effect worker.
      const beforeShutdown = recorded.commits.length;
      yield* recovery.prepareForShutdown.pipe(Effect.ensuring(manager.shutdown));
      // Coverage, not a promise: the manager really released every session it held, before reconcile("shutdown").
      const releaseEvents = recorded.commits
        .slice(beforeShutdown)
        .filter((commit) => commit.via === "write")
        .flatMap((commit) => commit.events);
      const stopped = new Set(
        releaseEvents.flatMap((event) =>
          event.type === "provider-session.updated" && event.payload.status === "stopped"
            ? [event.payload.id]
            : [],
        ),
      );
      for (const [w, world] of worlds.entries())
        if (world.session === "live" && !stopped.has(worldSessionId(w)))
          problems[w]!.push(`providerSessions.shutdown did not release ${worldSessionId(w)}`);
      released.sessions = stopped.size;
      released.requests = releaseEvents.filter(
        (event) => event.type === "runtime-request.updated",
      ).length;
    }
    yield* recovery.reconcile(firstTrigger);
    for (const [w, world] of worlds.entries()) {
      for (const [t, shape] of world.threads.entries()) {
        const threadId = worldThreadId(w, t);
        const projection = yield* projections.getThreadProjection(threadId);
        for (const line of [
          ...stillLive(projection, checkpointPendingRunIds).map((record) => record.line),
          ...notKept(shape, projection, threadId),
        ])
          problems[w]!.push(`after reconcile("${firstTrigger}"), thread ${t}: ${line}`);
      }
      const status = yield* sessionStatus(worldSessionId(w));
      if (status !== "stopped" && status !== "error")
        problems[w]!.push(`after reconcile("${firstTrigger}"), the shared session is ${status}`);
    }

    const firstPassCommits = recorded.commits.length;
    const outboxAfterFirst = yield* outboxRows;
    yield* TestClock.adjust("1 minute");
    const summary = yield* recovery.reconcile("startup");
    for (const commit of recorded.commits.slice(firstPassCommits)) {
      const into = problems[worldOf(commit.threadId)] ?? problems[0]!;
      if (commit.events.length > 0)
        into.push(
          `the second reconcile wrote ${commit.events.map((event) => event.type).join(", ")} for ${commit.threadId}`,
        );
      if (commit.effects.length > 0)
        into.push(
          `the second reconcile enqueued ${commit.effects.map((effect) => effect.id).join(", ")}`,
        );
    }
    const outboxAfterSecond = yield* outboxRows;
    for (const row of outboxAfterSecond) {
      const before = outboxAfterFirst.find((candidate) => candidate.effect_id === row.effect_id);
      if (before?.status !== row.status)
        (problems[worldOf(row.effect_id.match(/thread:mc:\d+/)?.[0])] ?? problems[0]!).push(
          `the second reconcile moved effect ${row.effect_id} from ${before?.status} to ${row.status}`,
        );
    }
    const changed = Object.entries(summary).filter(([, count]) => count !== 0);
    if (changed.length > 0 && problems.every((lines) => lines.length === 0))
      problems[0]!.push(
        `the second reconcile reported ${canonicalKey(Object.fromEntries(changed))}`,
      );
    return { problems, seeded, released };
  });

/** Runs worlds in batches and fails on the first world with a broken promise, naming it and every break. */
const checkWorlds = (
  label: string,
  worlds: ReadonlyArray<World>,
  firstTrigger: "startup" | "shutdown",
  batchSize = 400,
) =>
  Effect.gen(function* () {
    const started = Date.now();
    const seeded = new Map<string, number>();
    const released = { sessions: 0, requests: 0 };
    for (let from = 0; from < worlds.length; from += batchSize) {
      const batch = worlds.slice(from, from + batchSize);
      const result = yield* reconcileTwice(batch, firstTrigger);
      const problems = result.problems;
      for (const [kind, count] of result.seeded) seeded.set(kind, (seeded.get(kind) ?? 0) + count);
      released.sessions += result.released.sessions;
      released.requests += result.released.requests;
      const broken = problems.findIndex((lines) => lines.length > 0);
      if (broken !== -1)
        assert.fail(
          `${label}: world ${from + broken} breaks restart recovery\n  world: ${describeWorld(batch[broken]!)}\n  ${problems[broken]!.join("\n  ")}`,
        );
    }
    process.stderr.write(
      `restart-recovery reconcile (${label}): ${worlds.length} worlds, ${[...seeded.values()].reduce((a, b) => a + b, 0)} live records seeded, ${firstTrigger === "shutdown" ? `prepareForShutdown, providerSessions.shutdown (${released.sessions} sessions and ${released.requests} runtime requests released), ` : ""}reconcile("${firstTrigger}") then reconcile("startup"), ${Date.now() - started} ms\n`,
    );
    return { seeded, released };
  });

/** Shapes for worlds where two threads share a session: every run shape, with and without a queued wake. */
const pairShapes = allThreadShapes.filter(
  (shape) =>
    shape.request === "none" &&
    shape.background === "none" &&
    (shape.queued === "none" || shape.queued === "buffered") &&
    !shape.roster,
);

/**
 * On a busy machine the biggest universes take well over vitest's 120 s default (the one-thread universe took 124 s at
 * load average 35 on an 18-core Mac), so they get ten minutes: a slow machine should make the run slow, not flaky.
 */
const LONG_RUN = 600_000;

it.effect(
  "recovery ends every live record of a dead process, keeps durable work, and a second pass changes nothing",
  () =>
    Effect.gen(function* () {
      const { seeded } = yield* checkWorlds(
        `one thread, exhaustive over ${allThreadShapes.length} reachable shapes x 2 session states`,
        (["live", "stopped"] as const).flatMap((session) =>
          allThreadShapes.map((shape): World => ({ session, threads: [shape] })),
        ),
        "startup",
      );
      assert.deepEqual(
        SEEDED_KINDS.filter((kind) => !seeded.has(kind)),
        [],
        "every kind of live record is seeded in some world",
      );
      const { released } = yield* checkWorlds(
        `one thread after a graceful shutdown, exhaustive over ${allThreadShapes.length} shapes on a live session`,
        allThreadShapes.map((shape): World => ({ session: "live", threads: [shape] })),
        "shutdown",
      );
      assert.isAbove(
        released.requests,
        0,
        "the session manager's shutdown released some runtime request",
      );
      yield* checkWorlds(
        `two threads on one live session, exhaustive over ${pairShapes.length}^2 shape pairs`,
        pairShapes.flatMap((first) =>
          pairShapes.map((second): World => ({ session: "live", threads: [first, second] })),
        ),
        "startup",
        200,
      );
    }),
  LONG_RUN,
);

// ---------------------------------------------------------------------------------------------------------------
// Restart continuations across a run of process lives, each killable after any durable write.
// ---------------------------------------------------------------------------------------------------------------

/** Something that must keep a restart from prompting the cut run again. */
type Blocker =
  | "none"
  | "archived"
  | "deleted"
  | "settled"
  | "snoozed"
  | "approval"
  | "question"
  | "secret"
  | "user-stopped"
  | "maintenance"
  | "provider-switched"
  | "setting-off"
  | "newer-user-work";
const BLOCKERS: ReadonlyArray<Exclude<Blocker, "none">> = [
  "archived",
  "deleted",
  "settled",
  "snoozed",
  "approval",
  "question",
  "secret",
  "user-stopped",
  "maintenance",
  "provider-switched",
  "setting-off",
  "newer-user-work",
];

/**
 * The steps of one process life after it boots, in the order serverRuntimeStartup runs them: recovery, then the
 * effect worker; on shutdown (its finalizer, after it interrupts the worker fiber), prepareForShutdown, then the
 * session manager's shutdown (`Effect.ensuring(providerSessions.shutdown)`), then reconcile("shutdown"). The user's
 * message only goes out in the newer-user-work timelines, once, after recovery. No step is atomic: a life can be
 * killed after any durable write inside one (`LifeControl`).
 */
const LIFE = [
  "reconcile startup",
  "the user sends a message",
  "run the effect worker until idle",
  "prepare for shutdown",
  "release provider sessions",
  "reconcile shutdown",
] as const;
type LifeStep = (typeof LIFE)[number];
/** The process alive when a timeline starts is mid-turn: only its shutdown is left. */
const FIRST_LIFE: ReadonlyArray<LifeStep> = [
  "prepare for shutdown",
  "release provider sessions",
  "reconcile shutdown",
];
/** The last life boots and drains, and is never killed, so every timeline ends settled. */
const LAST_LIFE: ReadonlyArray<LifeStep> = [
  "reconcile startup",
  "the user sends a message",
  "run the effect worker until idle",
];

interface DispatchInput {
  readonly threadId: ThreadId;
  readonly commandId: CommandId;
  readonly messageId: MessageId;
  readonly text: string;
  readonly createdBy: "user" | "agent";
  readonly creationSource: string;
  readonly notification?: unknown;
  readonly restartContinuationOfRunId?: RunId | undefined;
}

/**
 * What Orchestrator's message.dispatch commits for a run that starts at once (`start_immediately`): one
 * commitCommand under the command id holding the provider thread, the starting run with its pending attempt and root
 * node, the message and its turn item, and a provider-turn.start effect. The real EventSink answers a repeated command
 * id from its receipt.
 */
const dispatchCommit = (input: DispatchInput) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projection = yield* projections.getThreadRecords(input.threadId, [
      "runs",
      "providerThreads",
      "turnItems",
    ]);
    const now = yield* DateTime.now;
    const ordinal = Math.max(0, ...projection.runs.map((run) => run.ordinal)) + 1;
    const runId = RunId.make(`run:${input.threadId}:${ordinal}`);
    const attemptId = RunAttemptId.make(`attempt:${runId}`);
    const nodeId = NodeId.make(`node:${runId}:root`);
    const providerThread = projection.providerThreads[0]!;
    const scope = { threadId: input.threadId, occurredAt: now, providerInstanceId: instance };
    const runScope = { ...scope, runId, nodeId };
    const events = [
      {
        ...scope,
        id: eventId(),
        type: "provider-thread.updated",
        driver,
        payload: { ...providerThread, lastRunOrdinal: ordinal, updatedAt: now },
      },
      {
        ...runScope,
        id: eventId(),
        type: "run.created",
        payload: {
          ...runPayload(input.threadId, runId, ordinal, {
            status: "starting",
            userMessageId: input.messageId,
            requestedAt: now,
            startedAt: null,
            rootNodeId: nodeId,
            activeAttemptId: attemptId,
            queuePosition: null,
          }),
          ...(input.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuationOfRunId: input.restartContinuationOfRunId }),
        },
      },
      {
        ...runScope,
        id: eventId(),
        type: "run-attempt.created",
        payload: {
          id: attemptId,
          runId,
          attemptOrdinal: 1,
          rootNodeId: nodeId,
          providerInstanceId: instance,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          reason: "initial",
          status: "pending",
          startedAt: null,
          completedAt: null,
        },
      },
      {
        ...runScope,
        id: eventId(),
        type: "node.updated",
        payload: {
          id: nodeId,
          threadId: input.threadId,
          runId,
          parentNodeId: null,
          rootNodeId: nodeId,
          kind: "root_turn",
          status: "pending",
          countsForRun: true,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt: null,
          completedAt: null,
        },
      },
      {
        ...runScope,
        id: eventId(),
        type: "message.updated",
        payload: {
          id: input.messageId,
          threadId: input.threadId,
          runId,
          nodeId,
          role: "user",
          text: input.text,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
          createdBy: input.createdBy,
          creationSource: input.creationSource,
          ...(input.notification === undefined ? {} : { notification: input.notification }),
        },
      },
      {
        ...runScope,
        id: eventId(),
        type: "turn-item.updated",
        payload: {
          id: TurnItemId.make(`item:${input.messageId}`),
          threadId: input.threadId,
          runId,
          nodeId,
          providerThreadId: providerThread.id,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: Math.max(0, ...projection.turnItems.map((item) => item.ordinal)) + 1,
          status: "completed",
          title: null,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "user_message",
          messageId: input.messageId,
          inputIntent: "turn_start",
          text: input.text,
          attachments: [],
          createdBy: input.createdBy,
          creationSource: input.creationSource,
        },
      },
    ] as never as Array<OrchestrationV2DomainEvent>;
    yield* eventSink.commitCommand({
      commandId: input.commandId,
      threadId: input.threadId,
      commandType: "message.dispatch",
      acceptedAt: now,
      events,
      effects: [
        {
          id: `effect:${input.commandId}:provider-turn.start:${runId}`,
          commandId: input.commandId,
          threadId: input.threadId,
          request: { type: "provider-turn.start", runId },
        },
      ],
    });
  });

/**
 * What a claimed provider-turn.start persists. ProviderTurnStartService opens the session through the real session
 * manager (`providerSessions.open`: a fresh process writes its provider-session.attached, a thread joining a live
 * shared session writes its own); then its running write (writeIfRunCurrent, still expecting the run to be starting)
 * moves the session, provider thread, run, attempt and root node to running; then the adapter reports the turn it
 * started, which event ingestion writes on its own.
 */
const startTurn = (threadId: ThreadId, runId: RunId, control: LifeControl) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const projection = yield* projections.getThreadRecords(threadId, [
      "runs",
      "attempts",
      "nodes",
      "providerThreads",
    ]);
    const run = projection.runs.find((candidate) => candidate.id === runId)!;
    if (run.status !== "starting") {
      control.problems.push(
        `${control.step}: provider-turn.start for ${runId} ran with the run ${run.status}: a dead process's turn start outlived the restart`,
      );
      return;
    }
    const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId)!;
    const rootNode = projection.nodes.find((candidate) => candidate.id === run.rootNodeId)!;
    const providerThread = projection.providerThreads.find(
      (candidate) => candidate.id === run.providerThreadId,
    )!;
    const session = yield* openSession(threadId, providerThread.providerSessionId!);
    const now = yield* DateTime.now;
    const scope = { threadId, occurredAt: now, providerInstanceId: instance };
    const runScope = { ...scope, runId, nodeId: rootNode.id };
    const running = yield* eventSink.writeIfRunCurrent({
      threadId,
      runId,
      activeAttemptId: attempt.id,
      expectedStatus: "starting",
      events: [
        {
          ...scope,
          id: eventId(),
          type: "provider-session.updated",
          driver,
          payload: session.providerSession,
        },
        {
          ...scope,
          id: eventId(),
          type: "provider-thread.updated",
          driver,
          payload: {
            ...providerThread,
            status: "active",
            lastRunOrdinal: run.ordinal,
            updatedAt: now,
          },
        },
        {
          ...runScope,
          id: eventId(),
          type: "run.updated",
          payload: { ...run, status: "running", startedAt: now },
        },
        {
          ...runScope,
          id: eventId(),
          type: "run-attempt.updated",
          payload: { ...attempt, status: "running", startedAt: now },
        },
        {
          ...runScope,
          id: eventId(),
          type: "node.updated",
          payload: { ...rootNode, status: "running", startedAt: now },
        },
      ] as never,
    });
    if (!running.committed) return;
    const turnId = ProviderTurnId.make(`turn:${runId}`);
    yield* eventSink.writeWithEffects({
      events: [
        {
          ...runScope,
          id: eventId(),
          type: "provider-turn.updated",
          payload: {
            id: turnId,
            providerThreadId: providerThread.id,
            nodeId: rootNode.id,
            runAttemptId: attempt.id,
            nativeTurnRef: { driver, nativeId: `native-turn:${runId}`, strength: "strong" },
            ordinal: run.ordinal,
            status: "running",
            startedAt: now,
            completedAt: null,
          },
        },
        {
          ...runScope,
          id: eventId(),
          type: "run-attempt.updated",
          payload: { ...attempt, status: "running", startedAt: now, providerTurnId: turnId },
        },
        {
          ...runScope,
          id: eventId(),
          type: "node.updated",
          payload: { ...rootNode, status: "running", startedAt: now, providerTurnId: turnId },
        },
      ] as never,
      effects: [],
    });
  });

/** The orchestrator, reduced to what a continuation needs: real reads, and message.dispatch's commit. */
const threadsStandIn = (control: LifeControl) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const eventSink = yield* EventSink.EventSinkV2;
      return Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadRecords: (threadId, fields, filter) =>
          projections.getThreadRecords(threadId, fields, filter).pipe(Effect.orDie),
        recoverDelegatedTask: () => Effect.void,
        dispatch: (command) =>
          Effect.gen(function* () {
            if (command.type !== "message.dispatch")
              return yield* Effect.die(`unexpected ${command.type}`);
            control.dispatched.push({
              sourceRunId: command.restartContinuationOfRunId,
              commandId: command.commandId,
              messageId: command.messageId,
            });
            yield* dispatchCommit({
              threadId: command.threadId,
              commandId: command.commandId,
              messageId: command.messageId,
              text: command.text,
              createdBy: command.createdBy === "user" ? "user" : "agent",
              creationSource: command.creationSource,
              notification: command.notification,
              restartContinuationOfRunId: command.restartContinuationOfRunId,
            }).pipe(
              Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
              Effect.provideService(EventSink.EventSinkV2, eventSink),
              Effect.orDie,
            );
            return {} as never;
          }),
      });
    }),
  );

/** One life's services: a fresh stack over the database file, so nothing in memory outlives the process. */
const lifeStack = (
  file: string,
  settings: Parameters<typeof ServerSettings.layerTest>[0],
  control: LifeControl,
) => {
  const services = recordingEventSink({ commits: [] }, control).pipe(
    Layer.provideMerge(stores(file)),
    Layer.provideMerge(ServerSettings.layerTest(settings)),
  );
  return Layer.mergeAll(
    services,
    threadsStandIn(control).pipe(Layer.provide(services)),
    sessionManager.pipe(Layer.provide(services)),
  );
};

/** The extra records and settings that put `blocker` on the thread whose run the first process was in. */
const blockerSeed = (threadId: ThreadId, blocker: Blocker) => {
  const id = ids(threadId);
  const at = minutesAfterT0(2);
  const shape: ThreadShape = {
    run: "running",
    request: blocker === "approval" ? "approval" : blocker === "question" ? "question" : "none",
    background: "none",
    queued: "none",
    roster: false,
  };
  const thread: Partial<OrchestrationV2AppThread> =
    blocker === "archived"
      ? { archivedAt: at }
      : blocker === "deleted"
        ? { deletedAt: at }
        : blocker === "settled"
          ? { settledOverride: "settled", settledAt: at }
          : blocker === "snoozed"
            ? ({ snoozedUntil: DateTime.add(t0, { days: 1 }) } as Partial<OrchestrationV2AppThread>)
            : blocker === "provider-switched"
              ? { providerInstanceId: ProviderInstanceId.make("claude") }
              : {};
  const item = (fields: Record<string, unknown>) =>
    ({
      id: eventId(),
      occurredAt: at,
      threadId,
      type: "turn-item.updated",
      runId: id.run,
      nodeId: id.rootNode,
      payload: {
        threadId,
        runId: id.run,
        nodeId: id.rootNode,
        providerThreadId: id.providerThread,
        providerTurnId: id.turn,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 5,
        title: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
        ...fields,
      },
    }) as never as OrchestrationV2DomainEvent;
  const extra: Array<OrchestrationV2DomainEvent> =
    blocker === "secret"
      ? [
          item({
            id: TurnItemId.make(`item:${threadId}:secret`),
            status: "waiting",
            type: "secret_request",
            label: "GITHUB_TOKEN",
            reason: "To open the pull request",
            secretStatus: "pending",
          }),
        ]
      : blocker === "user-stopped"
        ? [
            item({
              id: TurnItemId.make(`item:${threadId}:stop`),
              status: "pending",
              type: "run_interrupt_request",
              message: "Stop",
            }),
          ]
        : blocker === "maintenance"
          ? [
              {
                id: eventId(),
                occurredAt: at,
                threadId,
                type: "message.updated",
                runId: id.run,
                payload: userMessage(threadId, id.userMessage, id.run, "user", "/compact"),
              } as never,
            ]
          : [];
  return { shape, thread, extra };
};

interface Universe {
  readonly label: string;
  /** Applies to thread 0. */
  readonly blocker: Blocker;
  /** 2 puts a second, unblocked thread on the same provider session (one Codex app server). */
  readonly threads: 1 | 2;
  /** How far apart on the clock two lives start. */
  readonly lifeSeconds: number;
  /** Lives before the last one, life 0 (the process that was mid-turn) included. */
  readonly lives: number;
  /** Leading lives that only shut down gracefully: they build state (a chain of continuations) without branching. */
  readonly unbranchedLives: number;
}

const universeThreadIds = (universe: Universe) =>
  Array.from({ length: universe.threads }, (_, index) =>
    ThreadId.make(`thread:mc:continuation:${index}`),
  );

interface LifeRecord {
  readonly cut: Cut;
  readonly killed: boolean;
  /** Every durable write the life made, named by step and call. */
  readonly writes: ReadonlyArray<string>;
  /** How many of them came before a graceful shutdown interrupted the worker. */
  readonly workerStoppedAt: number | undefined;
}
interface Life {
  readonly record: LifeRecord;
  readonly dispatched: ReadonlyArray<Dispatched>;
  readonly problems: ReadonlyArray<string>;
}
/** One branch of the timeline tree: the lives played so far. */
interface Path {
  readonly lives: ReadonlyArray<LifeRecord>;
  readonly dispatched: ReadonlyArray<Dispatched>;
  readonly problems: ReadonlyArray<string>;
}
const emptyPath: Path = { lives: [], dispatched: [], problems: [] };
const extend = (path: Path, life: Life): Path => ({
  lives: [...path.lives, life.record],
  dispatched: [...path.dispatched, ...life.dispatched],
  problems: [
    ...path.problems,
    ...life.problems.map((line) => `life ${path.lives.length}: ${line}`),
  ],
});

interface Verdict {
  readonly problems: ReadonlyArray<string>;
  readonly continuations: number;
  readonly longestChain: number;
}

/** Every broken continuation promise in the timeline, read from the database the last life left. */
const judge = (universe: Universe, path: Path) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const problems = [...path.problems];
    for (const call of path.dispatched) {
      if (call.sourceRunId === undefined) continue;
      if (call.messageId !== `message:restart-continuation:${call.sourceRunId}`)
        problems.push(
          `a continuation of ${call.sourceRunId} was dispatched with message id ${call.messageId}`,
        );
      if (call.commandId !== `command:restart-continuation:${call.sourceRunId}`)
        problems.push(
          `a continuation of ${call.sourceRunId} was dispatched with command id ${call.commandId}`,
        );
    }
    let continuationCount = 0;
    let longestChain = 0;
    for (const [index, threadId] of universeThreadIds(universe).entries()) {
      const { runs } = yield* projections.getThreadRecords(threadId, ["runs"]);
      const continuations = runs.filter(
        (candidate) => candidate.restartContinuationOfRunId !== undefined,
      );
      continuationCount += continuations.length;
      for (const source of new Set(
        continuations.map((candidate) => candidate.restartContinuationOfRunId),
      ))
        if (
          continuations.filter((candidate) => candidate.restartContinuationOfRunId === source)
            .length > 1
        )
          problems.push(`thread ${index}: run ${source} was continued more than once`);
      const chainLength = (run: OrchestrationV2Run | undefined): number =>
        run?.restartContinuationOfRunId === undefined
          ? 0
          : 1 +
            chainLength(runs.find((candidate) => candidate.id === run.restartContinuationOfRunId));
      const longest = Math.max(0, ...runs.map(chainLength));
      longestChain = Math.max(longestChain, longest);
      if (longest > 3)
        problems.push(
          `thread ${index}: ${longest} automatic continuations ran in a row (${continuations
            .map((candidate) => `${candidate.id} continues ${candidate.restartContinuationOfRunId}`)
            .join(", ")})`,
        );
      const blocker = index === 0 ? universe.blocker : "none";
      const continuedSource = continuations.find(
        (candidate) => candidate.restartContinuationOfRunId === ids(threadId).run,
      );
      // A user run the restart cancelled before it started supersedes nothing (cancelledBeforeStart in
      // RestartBackgroundNote.ts, kept from T3): a continuation requested after that cancellation is allowed.
      const newerUserRun = runs.find(
        (candidate) => candidate.userMessageId === `message:${threadId}:newer`,
      );
      const supersededNothing =
        blocker === "newer-user-work" &&
        continuedSource !== undefined &&
        newerUserRun?.status === "cancelled" &&
        newerUserRun.startedAt === null &&
        newerUserRun.completedAt !== null &&
        !DateTime.isGreaterThan(newerUserRun.completedAt, continuedSource.requestedAt);
      if (blocker !== "none" && continuedSource !== undefined && !supersededNothing)
        problems.push(
          `thread ${index}: run ${ids(threadId).run} was continued despite the ${blocker} blocker`,
        );
      const latest = runs.toSorted((a, b) => b.ordinal - a.ordinal)[0];
      if (
        blocker === "none" &&
        longest < 3 &&
        !(latest?.status === "running" && latest.restartContinuationOfRunId !== undefined)
      )
        problems.push(
          `thread ${index}: left with ${latest?.id} ${latest?.status} after ${longest} continuations, so the cut turn never resumed`,
        );
    }
    return { problems, continuations: continuationCount, longestChain } satisfies Verdict;
  });

/**
 * Plays one process life on `file` in a fresh stack, from the clock its index gives it, and kills it at `cut`.
 * With `judgePath`, judges the timeline in the same stack once the steps are done.
 */
const playLife = (
  universe: Universe,
  file: string,
  schedule: ReadonlyArray<LifeStep>,
  cut: Cut,
  index: number,
  judgePath?: { readonly path: Path },
) =>
  Effect.gen(function* () {
    const control: LifeControl = {
      cut,
      writes: [],
      step: "boot",
      seen: 0,
      problems: [],
      dispatched: [],
      workerStopped: false,
      workerStoppedAt: undefined,
      stopWorker: undefined,
      stopWorkerAtNextCall: false,
      dead: false,
      closing: false,
      setup: false,
    };
    const threadIds = universeThreadIds(universe);
    yield* TestClock.setTime(
      DateTime.toEpochMillis(minutesAfterT0(30)) + index * universe.lifeSeconds * 1_000,
    );
    return yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const outbox = killableOutbox(yield* EffectOutbox.EffectOutboxV2, control, sql);
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provideService(EffectOutbox.EffectOutboxV2, outbox),
      );
      const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
      const workerId = "worker:mc";
      const runStep = (step: LifeStep) =>
        Effect.gen(function* () {
          if (control.dead) return yield* Effect.interrupt;
          if (typeof cut === "object" && "before" in cut && cut.before === step) {
            control.dead = true;
            return yield* Effect.interrupt;
          }
          control.step = step;
          yield* TestClock.adjust("1 second");
          switch (step) {
            case "reconcile startup":
              yield* recovery.reconcile("startup");
              break;
            case "the user sends a message": {
              if (universe.blocker !== "newer-user-work") break;
              const messageId = MessageId.make(`message:${threadIds[0]}:newer`);
              const sent = yield* projections.getThreadRecords(threadIds[0]!, ["messages"], {
                messageIds: [messageId],
              });
              if (sent.messages.length > 0) break;
              yield* threads.dispatch({
                type: "message.dispatch",
                commandId: CommandId.make(`command:${messageId}`),
                threadId: threadIds[0]!,
                messageId,
                text: "Actually, do this instead",
                attachments: [],
                modelSelection,
                dispatchMode: { type: "start_immediately" },
                createdBy: "user",
                creationSource: "web",
              } as never);
              break;
            }
            case "run the effect worker until idle": {
              // EffectWorker.runOnce, one effect at a time: claim, execute, succeed.
              const worker = Effect.gen(function* () {
                for (;;) {
                  const claimed = yield* outbox.claimNext({ workerId, leaseDurationMs: 60_000 });
                  if (Option.isNone(claimed)) return;
                  const effect = claimed.value;
                  const request = effect.request;
                  if (request.type === "provider-runtime.continue")
                    yield* continueRestartedRun({
                      threadId: effect.threadId,
                      sourceRunId: request.sourceRunId,
                    });
                  else if (request.type === "provider-turn.start")
                    yield* startTurn(effect.threadId, request.runId, control);
                  else return yield* Effect.die(`no timeline enqueues ${request.type}`);
                  yield* outbox.succeed({ effectId: effect.id, workerId });
                }
              });
              // The worker runs on its own fiber, as EffectWorker.runDaemon does, so a graceful shutdown can interrupt it
              // from outside wherever it parked (`awaitWorkerStop`); the shutdown steps still run after it.
              const stopWorker = yield* Deferred.make<void>();
              control.stopWorker = stopWorker;
              const fiber = yield* Effect.forkChild(worker, { startImmediately: true });
              const stopped = yield* Effect.raceFirst(
                Deferred.await(stopWorker).pipe(Effect.as(true)),
                Fiber.await(fiber).pipe(Effect.as(false)),
              );
              control.stopWorker = undefined;
              if (stopped) {
                yield* Fiber.interrupt(fiber);
                control.workerStopped = true;
                break;
              }
              const exit = yield* Fiber.await(fiber);
              if (control.dead) return yield* Effect.interrupt;
              if (Exit.isFailure(exit)) return yield* Effect.failCause(exit.cause);
              if (control.stopWorkerAtNextCall)
                control.problems.push(`${step}: the worker went idle before its interrupt landed`);
              break;
            }
            case "prepare for shutdown":
              yield* recovery.prepareForShutdown;
              break;
            case "release provider sessions":
              // ProviderSessionManager.shutdown: releaseEntry(server_shutdown) for every session this process holds.
              yield* providerSessions.shutdown;
              break;
            case "reconcile shutdown":
              yield* recovery.reconcile("shutdown");
              break;
          }
          const changes = yield* totalChanges(sql);
          if (changes !== control.seen)
            control.problems.push(
              `${step}: ${changes - control.seen} row change(s) outside a wrapped write, where no kill can land`,
            );
          control.seen = changes;
          // Recovery's first promise, now after histories killed between its per-thread commits. Deleted threads
          // are left alone on purpose: getRecoveryThreadIds reads only threads WHERE deleted_at IS NULL.
          if (step === "reconcile startup" || step === "reconcile shutdown")
            for (const [thread, threadId] of threadIds.entries()) {
              const projection = yield* projections.getThreadProjection(threadId);
              if (projection.thread.deletedAt !== null) continue;
              for (const record of stillLive(projection, new Set()))
                control.problems.push(`after ${step}, thread ${thread}: ${record.line}`);
            }
        });
      // The process that was mid-turn holds the shared session, serving every thread. It opened it long before it
      // died, so these attachments are setup, not kill points.
      if (index === 0) {
        control.setup = true;
        for (const threadId of threadIds) yield* openSession(threadId, worldSessionId(0));
        control.setup = false;
      }
      control.seen = yield* totalChanges(sql);
      const exit = yield* Effect.exit(
        cut === 0
          ? Effect.sync(() => (control.dead = true)).pipe(Effect.andThen(Effect.interrupt))
          : Effect.forEach(schedule, runStep, { discard: true }),
      );
      // A killed process's last moments do not matter: whatever its code made of the interrupt, nothing committed.
      const killed = control.dead;
      if (Exit.isFailure(exit) && !killed) return yield* Effect.failCause(exit.cause);
      const graceful = typeof cut === "object" && "workerStoppedAfter" in cut;
      if (killed !== (cut !== undefined && !graceful) || control.workerStopped !== graceful)
        return yield* Effect.die(
          new Error(
            `life ${index} was to end at ${canonicalKey(cut ?? "the end")} but ${killed ? "was killed" : "ran every step"}`,
          ),
        );
      const life: Life = {
        record: {
          cut,
          killed,
          writes: [...control.writes],
          workerStoppedAt: control.workerStoppedAt,
        },
        dispatched: control.dispatched,
        problems: control.problems,
      };
      const verdict =
        judgePath === undefined ? undefined : yield* judge(universe, extend(judgePath.path, life));
      // The last life is judged and thrown away, so whatever its services write as they close does not matter.
      if (judgePath !== undefined) control.dead = true;
      else control.closing = !killed;
      return { life, verdict };
    }).pipe(
      Effect.provide(
        lifeStack(
          file,
          { continueThreadsAfterServerUpdate: universe.blocker !== "setting-off" },
          control,
        ),
      ),
    );
    // Each process has its own clock: sleeps a closed life left behind (its idle releases) never pile up.
  }).pipe(Effect.provide(TestClock.layer()));

const seedTimeline = (universe: Universe, file: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* sql.withTransaction(
      Effect.forEach(
        universeThreadIds(universe).flatMap((threadId, index) => {
          const seed = blockerSeed(threadId, index === 0 ? universe.blocker : "none");
          return [
            ...seedEvents(
              threadId,
              seed.shape,
              { id: worldSessionId(0), status: "live" },
              seed.thread,
            ),
            ...seed.extra,
          ];
        }),
        (event) => projections.apply(event),
        { discard: true },
      ),
    );
  }).pipe(Effect.provide(stores(file)));

const describeLife = (record: LifeRecord, index: number, last: boolean) => {
  const name = index === 0 ? "life 0 (mid-turn)" : last ? `life ${index} (last)` : `life ${index}`;
  const end = !record.killed
    ? last
      ? "ran every step"
      : typeof record.cut === "object" && "workerStoppedAfter" in record.cut
        ? `shut down gracefully with the effect worker interrupted after durable write ${record.workerStoppedAt ?? "?"}${record.cut.afterCall === true ? " (once that call returned)" : ""}`
        : "shut down after every step"
    : `was killed ${typeof record.cut === "object" && "before" in record.cut ? `as ${record.cut.before} began, ` : ""}after durable write ${record.writes.length}`;
  return [
    `${name} ${end}${record.writes.length === 0 ? " (it wrote nothing)" : ":"}`,
    ...record.writes.map((write, number) => `    ${number + 1}. ${write}`),
  ].join("\n    ");
};

const describePath = (universe: Universe, path: Path, last: LifeRecord) =>
  [
    `blocker ${universe.blocker} on thread 0, ${universe.threads} thread(s) on one provider session, lives ${universe.lifeSeconds} s apart`,
    ...path.lives.map((record, index) => describeLife(record, index, false)),
    describeLife(last, path.lives.length, true),
  ].join("\n    ");

/** Plays one timeline: life 0 and each later life ended at its cut, then the last life. */
const playTimeline = (universe: Universe, cuts: ReadonlyArray<Cut>) =>
  Effect.gen(function* () {
    const file = copyOf(yield* migrated);
    yield* seedTimeline(universe, file);
    let path = emptyPath;
    for (const [index, cut] of cuts.entries())
      path = extend(
        path,
        (yield* playLife(universe, file, index === 0 ? FIRST_LIFE : LIFE, cut, index)).life,
      );
    const last = yield* playLife(universe, file, LAST_LIFE, undefined, cuts.length, { path });
    remove(file);
    return { verdict: last.verdict!, description: describePath(universe, path, last.life.record) };
  });

/** A per-thread write of one recovery pass: its step and thread. A kill between two of them is the shared-session gap. */
const PER_THREAD_WRITE =
  /^(reconcile startup|reconcile shutdown|prepare for shutdown): (?:commitCommand\(provider-runtime\.reconcile\)|outbox\.cancelUnsettled|writeWithEffects\(\)) on (\S+)/;
const betweenThreadWrites = (before: string, after: string) => {
  const [, beforeStep, beforeThread] = PER_THREAD_WRITE.exec(before) ?? [];
  const [, afterStep, afterThread] = PER_THREAD_WRITE.exec(after) ?? [];
  return beforeStep !== undefined && beforeStep === afterStep && beforeThread !== afterThread;
};

interface Explored {
  timelines: number;
  continuations: number;
  capped: number;
  kills: number;
  workerStops: number;
  workerStopsAfterAttach: number;
  killsBetweenThreadWrites: number;
  killsAfterReleaseWrite: number;
  killsBeforeProcessLossReconcile: number;
  maxWrites: number;
}

/**
 * Explores the tree of timelines depth first. Life 0 can be killed after any of its durable writes (after none: the
 * process died mid-turn) or shut down; every later life up to `lives` can be killed after any durable write from its
 * first or shut down; a life killed before its first write is left out after life 0, because it writes nothing and
 * moving the later lives one life later on the clock changes no decision (lives are at most 120 s apart, the loop
 * window between two continuations is 5 minutes, a snooze a day). Each life starts from a copy of the file its parent
 * left, and every node is judged by playing the last life on another copy.
 */
const exploreUniverse = (universe: Universe) =>
  Effect.gen(function* () {
    const started = Date.now();
    const explored: Explored = {
      timelines: 0,
      continuations: 0,
      capped: 0,
      kills: 0,
      workerStops: 0,
      workerStopsAfterAttach: 0,
      killsBetweenThreadWrites: 0,
      killsAfterReleaseWrite: 0,
      killsBeforeProcessLossReconcile: 0,
      maxWrites: 0,
    };
    const visit = (file: string, path: Path): Effect.Effect<void, unknown> =>
      Effect.gen(function* () {
        // The seeded state itself is the timeline where life 0 wrote nothing, which its cut 0 covers.
        if (path.lives.length > 0) yield* judgeNode(file, path);
        const index = path.lives.length;
        if (index >= universe.lives) return;
        const schedule = index === 0 ? FIRST_LIFE : LIFE;
        const fullFile = copyOf(file);
        const full = (yield* playLife(universe, fullFile, schedule, undefined, index)).life;
        explored.maxWrites = Math.max(explored.maxWrites, full.record.writes.length);
        yield* visit(fullFile, extend(path, full));
        remove(fullFile);
        if (index < universe.unbranchedLives) return;
        const writes = full.record.writes;
        const branch = (cut: Cut) =>
          Effect.gen(function* () {
            const cutFile = copyOf(file);
            const ended = (yield* playLife(universe, cutFile, schedule, cut, index)).life;
            yield* visit(cutFile, extend(path, ended));
            remove(cutFile);
          });
        for (let cut = index === 0 ? 0 : 1; cut < writes.length; cut++) {
          explored.kills += 1;
          if (cut > 0 && betweenThreadWrites(writes[cut - 1]!, writes[cut]!))
            explored.killsBetweenThreadWrites += 1;
          if (writes[cut]!.endsWith("outbox.reconcileAfterProcessLoss"))
            explored.killsBeforeProcessLossReconcile += 1;
          if (cut > 0 && writes[cut - 1]!.startsWith("release provider sessions"))
            explored.killsAfterReleaseWrite += 1;
          yield* branch(cut);
        }
        // A graceful shutdown can also land while the worker is mid-effect: after any worker write but its last. The
        // interrupt lands inside that write's call; after an attach write it can also land once the call returned,
        // where ProviderSessionManager.open no longer releases the session it attached.
        const lastWorkerWrite = writes.findLastIndex((write) =>
          write.startsWith("run the effect worker"),
        );
        for (let cut = 1; cut <= lastWorkerWrite; cut++)
          if (writes[cut - 1]!.startsWith("run the effect worker")) {
            explored.workerStops += 1;
            yield* branch({ workerStoppedAfter: cut });
            if (writes[cut - 1]!.includes("provider-session.attached")) {
              explored.workerStopsAfterAttach += 1;
              yield* branch({ workerStoppedAfter: cut, afterCall: true });
            }
          }
      });
    const judgeNode = (file: string, path: Path) =>
      Effect.gen(function* () {
        const lastFile = copyOf(file);
        const last = yield* playLife(universe, lastFile, LAST_LIFE, undefined, path.lives.length, {
          path,
        });
        remove(lastFile);
        const verdict = last.verdict!;
        explored.timelines += 1;
        explored.continuations += verdict.continuations;
        if (verdict.longestChain === 3) explored.capped += 1;
        if (verdict.problems.length > 0)
          assert.fail(
            `${universe.label}: timeline ${explored.timelines} breaks restart continuation\n    ${describePath(universe, path, last.life.record)}\n  ${verdict.problems.join("\n  ")}`,
          );
      });
    const root = copyOf(yield* migrated);
    yield* seedTimeline(universe, root);
    yield* visit(root, emptyPath);
    remove(root);
    const counts = [
      `${explored.timelines} timelines`,
      `${explored.kills} kills (${explored.killsBetweenThreadWrites} between two threads' writes in one recovery pass, ${explored.killsBeforeProcessLossReconcile} just before reconcileAfterProcessLoss, ${explored.killsAfterReleaseWrite} after a provider session release write)`,
      `${explored.workerStops} shutdowns mid-effect (${explored.workerStopsAfterAttach} more landing after an attach returned)`,
      `up to ${explored.maxWrites} durable writes in a life`,
      `${explored.continuations} continuations started`,
      `${explored.capped} reached the cap of 3`,
      `${Date.now() - started} ms`,
    ];
    process.stderr.write(
      `restart-recovery continuation (${universe.label}): ${counts.join(", ")}\n`,
    );
    return explored;
  });

const oneThread: Universe = {
  label: "one thread, 3 lives before the last",
  blocker: "none",
  threads: 1,
  lifeSeconds: 10,
  lives: 3,
  unbranchedLives: 0,
};
const deepChain: Universe = {
  label: "one thread, 3 graceful lives (two continuations deep), then 2 more before the last",
  blocker: "none",
  threads: 1,
  lifeSeconds: 10,
  lives: 5,
  unbranchedLives: 3,
};
/** A turn that brings the server down two minutes after each resume is the same loop as a fast one. */
const slowChain: Universe = {
  ...deepChain,
  label:
    "one thread, lives 120 s apart, 3 graceful lives (two continuations deep), then 2 more before the last",
  lifeSeconds: 120,
};
const twoThreads: Universe = {
  label: "two threads on one session, 2 lives before the last",
  blocker: "none",
  threads: 2,
  lifeSeconds: 10,
  lives: 2,
  unbranchedLives: 0,
};

it.effect(
  "a restart continuation reaches a cut run at most once, never past three in a row, and always resumes an unblocked turn",
  () =>
    Effect.gen(function* () {
      const { killsAfterReleaseWrite, workerStopsAfterAttach } = yield* exploreUniverse(oneThread);
      assert.isAbove(
        killsAfterReleaseWrite,
        0,
        "some kill lands after a provider session release write",
      );
      assert.isAbove(
        workerStopsAfterAttach,
        0,
        "some graceful shutdown lands after a session attach returned",
      );
    }),
  LONG_RUN,
);

it.effect(
  "a chain of restart continuations stops at three in a row",
  () =>
    Effect.gen(function* () {
      for (const universe of [deepChain, slowChain]) {
        const { capped } = yield* exploreUniverse(universe);
        assert.isAbove(
          capped,
          0,
          `${universe.label}: some timeline runs the chain into the cap of three`,
        );
      }
    }),
  LONG_RUN,
);

it.effect(
  "a restart never continues a run the user must step in for, or a thread put away",
  () =>
    Effect.gen(function* () {
      for (const blocker of BLOCKERS)
        yield* exploreUniverse({
          label: `blocker ${blocker}, 2 lives before the last`,
          blocker,
          threads: 1,
          lifeSeconds: 10,
          lives: 2,
          unbranchedLives: 0,
        });
    }),
  LONG_RUN,
);

it.effect(
  "threads sharing one provider session are each continued once",
  () =>
    Effect.gen(function* () {
      const explored = yield* exploreUniverse(twoThreads);
      assert.isAbove(
        explored.killsBetweenThreadWrites,
        0,
        "some kill lands between two threads' recovery writes",
      );
    }),
  LONG_RUN,
);

const runId = (thread: number, ordinal: number) =>
  `run:thread:mc:continuation:${thread}:${ordinal}`;

/**
 * Fixed finding shared-session-stop: reconcile commits one thread at a time, and the first thread's commit persists the
 * shared provider session (one Codex app server) as stopped. Startup records every thread's continuation before any of
 * those commits, so a process killed after the first one still leaves the second thread's continuation recorded.
 */
it.effect("a kill between two threads' reconcile commits still continues both threads' turns", () =>
  Effect.gen(function* () {
    const { verdict, description } = yield* playTimeline(twoThreads, [
      0,
      {
        afterWrite:
          "reconcile startup: commitCommand(provider-runtime.reconcile) on thread:mc:continuation:0",
      },
    ]);
    assert.include(
      description,
      "reconcile startup: commitCommand(provider-runtime.reconcile) on thread:mc:continuation:0",
    );
    assert.deepEqual(verdict.problems, [], description);
  }),
);

/**
 * Fixed finding turn-not-reported: ProviderTurnStartService commits its running write (writeIfRunCurrent: run, attempt
 * and root node running, provider thread active) before the adapter reports the provider turn, and for most sessions
 * before RunExecutionService.startRootRun has even captured the baseline checkpoint the turn waits for. A restart
 * continuation cut in that gap, by a crash or by an update's graceful shutdown, is continued like one cut a moment
 * earlier, still starting (preparedContinuation).
 */
it.effect("a continuation cut before its provider turn is reported is continued", () =>
  Effect.gen(function* () {
    const crash = yield* playTimeline(oneThread, [
      0,
      { afterWrite: `writeIfRunCurrent(${runId(0, 3)}` },
    ]);
    assert.include(
      crash.description,
      `run the effect worker until idle: writeIfRunCurrent(${runId(0, 3)}`,
    );
    assert.deepEqual(crash.verdict.problems, [], crash.description);
    const update = yield* playTimeline(oneThread, [
      0,
      { workerStoppedAfter: `writeIfRunCurrent(${runId(0, 3)}` },
    ]);
    assert.include(
      update.description,
      `run the effect worker until idle: writeIfRunCurrent(${runId(0, 3)}`,
    );
    assert.deepEqual(update.verdict.problems, [], update.description);
    // One write earlier, after the session attached, the continuation is still starting and the next life continues
    // it, whether the interrupt made ProviderSessionManager.open release the session or landed once open returned.
    for (const afterCall of [false, true]) {
      const starting = yield* playTimeline(oneThread, [
        0,
        {
          workerStoppedAfter: "provider-session.attached",
          ...(afterCall ? { afterCall: true as const } : {}),
        },
      ]);
      assert.include(
        starting.description,
        "run the effect worker until idle: write(provider-session.attached)",
      );
      assert.deepEqual(starting.verdict.problems, [], starting.description);
    }
  }),
);
