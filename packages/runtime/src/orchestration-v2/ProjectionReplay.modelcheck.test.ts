// Bounded model checks for the promises ProjectionStore, ProjectionMaintenance and
// TurnItemPositionStore make together. The procedure, bounds and coverage record
// live in .claude/skills/projection-replay-equivalence/SKILL.md.
import { createHash } from "node:crypto";

import { canonicalKey, check, formatTrace, sequences, type Step } from "@caveman-app/model-check";
import {
  CommandId,
  ContextTransferId,
  EventId,
  MessageId,
  NodeId,
  OrchestrationV2AppThreadJson,
  OrchestrationV2CheckpointJson,
  OrchestrationV2CheckpointScopeJson,
  OrchestrationV2ContextHandoffJson,
  OrchestrationV2ContextTransferJson,
  OrchestrationV2ConversationMessageJson,
  OrchestrationV2DomainEventJson,
  OrchestrationV2ExecutionNodeJson,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProjectedTurnItemJson,
  OrchestrationV2ProviderSessionJson,
  OrchestrationV2ProviderThreadJson,
  OrchestrationV2ProviderTurnJson,
  OrchestrationV2RunAttemptJson,
  OrchestrationV2RunJson,
  OrchestrationV2RuntimeRequestJson,
  OrchestrationV2SubagentJson,
  OrchestrationV2ThreadProjectionJson,
  OrchestrationV2TurnItemJson,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type OrchestrationV2ThreadProjection,
} from "@caveman-app/protocol";
import { it } from "@effect/vitest";
import * as Arbitrary from "effect/Arbitrary";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import { afterAll, beforeAll, describe, expect } from "vitest";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProjectionReplay from "./testkit/ProjectionReplay.ts";
import { journalThroughHead } from "./testkit/SessionProtocolJournal.ts";
import {
  EVENT_LOG_PRUNE_MARK,
  EVENT_LOG_PRUNED_THROUGH,
} from "../persistence/OrchestrationEventStore.ts";

/* ------------------------------------------------------------------------------------------------
 * The id universe: thread A, and thread B, A's subagent thread.
 * ---------------------------------------------------------------------------------------------- */

const instance = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId: instance, model: "gpt-5.4" };
const EPOCH = Date.UTC(2026, 0, 1);
const at = (second: number) => DateTime.makeUnsafe(EPOCH + second * 1000);
const iso = (second: number) => new Date(EPOCH + second * 1000).toISOString();

const A = ThreadId.make("thread:A");
const B = ThreadId.make("thread:B");
const THREADS = [A, B] as const;
const r1 = RunId.make("run:r1");
const r2 = RunId.make("run:r2");
const r3 = RunId.make("run:r3");
const rootR1 = NodeId.make("node:root:r1");
const g1 = NodeId.make("subagent:g1");
const s1 = ProviderSessionId.make("session:s1");
const p1 = ProviderThreadId.make("provider-thread:p1");
const a1 = RunAttemptId.make("attempt:a1");
const t1 = ProviderTurnId.make("provider-turn:t1");

const appThread = (
  id: ThreadId,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => ({
  id,
  projectId: ProjectId.make("project:model-check"),
  title: "Model check",
  providerInstanceId: instance,
  modelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { rootThreadId: id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  createdAt: at(1),
  updatedAt: at(1),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  ...overrides,
});
const threadA = appThread(A);
const threadB = appThread(B, {
  lineage: { rootThreadId: A, parentThreadId: A, relationshipToParent: "subagent" },
  forkedFrom: { type: "node", nodeId: g1 },
  createdBy: "agent",
  creationSource: "provider",
  createdAt: at(2),
  updatedAt: at(2),
});

const domainEvent = (
  id: string,
  type: OrchestrationV2DomainEvent["type"],
  threadId: ThreadId,
  second: number,
  payload: unknown,
): OrchestrationV2DomainEvent =>
  ({
    id: EventId.make(id),
    type,
    threadId,
    occurredAt: at(second),
    payload,
  }) as OrchestrationV2DomainEvent;

const run = (
  id: RunId,
  threadId: ThreadId,
  ordinal: number,
  status: "running" | "queued" | "completed",
  second: number,
  extra: Record<string, unknown> = {},
) => ({
  id,
  threadId,
  ordinal,
  providerInstanceId: instance,
  modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make(`message:${id}`),
  rootNodeId: NodeId.make(`node:root:${id}`),
  activeAttemptId: null,
  status,
  requestedAt: at(second),
  startedAt: status === "queued" ? null : at(second),
  completedAt: status === "completed" ? at(second) : null,
  checkpointId: null,
  contextHandoffId: null,
  ...extra,
});

const session = (status: "running" | "stopped", second: number) => ({
  id: s1,
  driver,
  providerInstanceId: instance,
  status,
  cwd: "/repo",
  model: "gpt-5.4",
  capabilities: CodexProviderCapabilitiesV2,
  createdAt: at(20),
  updatedAt: at(second),
  lastError: null,
});

const providerThread = (overrides: Record<string, unknown>) => ({
  id: p1,
  driver,
  providerInstanceId: instance,
  providerSessionId: s1,
  appThreadId: A,
  ownerNodeId: null,
  nativeThreadRef: { driver, nativeId: "native-p1", strength: "strong" },
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: at(24),
  updatedAt: at(24),
  ...overrides,
});

const subagent = (second: number, overrides: Record<string, unknown>) => ({
  id: g1,
  threadId: A,
  runId: null,
  parentNodeId: NodeId.make("node:parent:g1"),
  origin: "app_owned",
  createdBy: "agent",
  driver,
  providerInstanceId: instance,
  providerThreadId: null,
  childThreadId: B,
  nativeTaskRef: null,
  prompt: "Review the diff",
  title: "Review",
  model: null,
  status: "running",
  result: null,
  startedAt: at(30),
  completedAt: null,
  updatedAt: at(second),
  ...overrides,
});

const itemBase = (
  id: string,
  threadId: ThreadId,
  ordinal: number,
  second: number,
  status: "running" | "completed",
  runId: RunId | null = null,
) => ({
  id: TurnItemId.make(id),
  threadId,
  runId,
  nodeId: null,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal,
  status,
  title: id,
  startedAt: at(second),
  completedAt: status === "completed" ? at(second) : null,
  updatedAt: at(second),
});

/* ------------------------------------------------------------------------------------------------
 * Part 1. The SQL projection (ProjectionStoreWithV1.layer) against the pure reducer: layerMemory, and
 * applyToProjection folded over the full stored projection. Orchestrator.getProjectionWithPendingEvents
 * folds over readCommandProjection instead, a filtered subset with updatedAt = thread.updatedAt.
 * ---------------------------------------------------------------------------------------------- */

interface Move {
  readonly event: OrchestrationV2DomainEvent;
  /** A thread that must exist before the event can happen: the code never writes to an unknown thread. */
  readonly needs?: ThreadId;
  readonly once?: boolean;
}

const A_CREATED = "A is created";
const B_CREATED = "B is created as A's subagent thread";

const MOVES: Record<string, Move> = {
  [A_CREATED]: { event: domainEvent("A-created", "thread.created", A, 1, threadA), once: true },
  [B_CREATED]: { event: domainEvent("B-created", "thread.created", B, 2, threadB), once: true },
  // Orchestrator re-emits the stored row with a newer occurredAt ("preserve the current row").
  "A is renamed from a stale snapshot": {
    event: domainEvent("A-renamed", "thread.metadata-updated", A, 11, {
      ...threadA,
      title: "Renamed",
    }),
  },

  "r1 starts": {
    event: domainEvent("r1-starts", "run.created", A, 12, run(r1, A, 1, "running", 12)),
  },
  "r1 completes with a delegated delivery": {
    event: domainEvent(
      "r1-completes",
      "run.updated",
      A,
      13,
      run(r1, A, 1, "completed", 13, {
        delegatedCompletion: {
          disposition: "open",
          nextGeneration: 2,
          delivery: { generation: 1, messageId: MessageId.make("message:delivery"), taskIds: [g1] },
        },
      }),
    ),
  },
  "r1's restart cancels its background work": {
    event: domainEvent("r1-cancels-work", "run.background-work-cancelled", A, 14, {
      runId: r1,
      restartCancelledBackgroundWork: [{ kind: "shell", label: "dev server", updatedAt: at(14) }],
    }),
  },
  "a stale r1 snapshot arrives": {
    event: domainEvent("r1-stale", "run.updated", A, 15, run(r1, A, 1, "running", 12)),
  },
  "r2 is queued": {
    event: domainEvent("r2-queued", "run.created", A, 16, run(r2, A, 2, "queued", 16)),
  },
  "r2 is held": {
    event: domainEvent(
      "r2-held",
      "run.updated",
      A,
      17,
      run(r2, A, 2, "queued", 16, { queueHeld: true }),
    ),
  },
  "n1 settles inside r1": {
    event: domainEvent("n1-settles", "node.updated", A, 18, {
      id: NodeId.make("node:n1"),
      threadId: A,
      runId: r1,
      parentNodeId: rootR1,
      rootNodeId: rootR1,
      kind: "assistant_message",
      status: "completed",
      countsForRun: true,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: at(18),
      completedAt: at(18),
    }),
  },

  "s1 attaches to A": {
    event: domainEvent("s1-attaches-A", "provider-session.attached", A, 20, session("running", 20)),
  },
  "s1 attaches to B": {
    event: domainEvent("s1-attaches-B", "provider-session.attached", B, 21, session("running", 21)),
    needs: B,
  },
  "s1 stops, reported on B": {
    event: domainEvent("s1-stops", "provider-session.updated", B, 22, session("stopped", 22)),
    needs: B,
  },
  "s1 detaches from A": {
    event: domainEvent("s1-detaches-A", "provider-session.detached", A, 23, {
      providerSessionId: s1,
      detachedAt: at(23),
    }),
  },
  "p1 runs for A": {
    event: domainEvent("p1-runs-for-A", "provider-thread.updated", A, 24, providerThread({})),
  },
  // Latent: the event contract allows a provider-thread snapshot sent on one thread that assigns it
  // to another, with an updatedAt older than the event. No current writer was found to send it:
  // the ingestor writes on appThreadId (ProviderEventIngestor.ts:580-586), and the Orchestrator's
  // re-sends set updatedAt to input.now (Orchestrator.ts:9350-9364, 9467).
  "A hands p1 to B with an old snapshot": {
    event: domainEvent(
      "p1-to-B",
      "provider-thread.updated",
      A,
      25,
      providerThread({ appThreadId: B, status: "idle", updatedAt: at(5) }),
    ),
  },
  "p1 is reserved as a queued placeholder": {
    event: domainEvent(
      "p1-placeholder",
      "provider-thread.updated",
      A,
      26,
      providerThread({
        status: "not_loaded",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        nativeThreadRef: null,
        providerSessionId: null,
        updatedAt: at(26),
      }),
    ),
  },
  "p1 loses its app thread": {
    event: domainEvent(
      "p1-unowned",
      "provider-thread.updated",
      A,
      27,
      providerThread({ appThreadId: null, status: "idle", updatedAt: at(27) }),
    ),
  },

  "A delegates g1 to B": {
    event: domainEvent(
      "g1-delegated",
      "subagent.updated",
      A,
      30,
      subagent(30, { completionDelivery: { state: "pending", observedByRunId: null } }),
    ),
  },
  "a stale g1 snapshot arrives": {
    event: domainEvent(
      "g1-stale",
      "subagent.updated",
      A,
      31,
      subagent(31, { status: "completed", completedAt: at(31) }),
    ),
  },
  "g1 records its result": {
    event: domainEvent(
      "g1-result",
      "subagent.updated",
      A,
      32,
      subagent(32, { status: "completed", completedAt: at(32), result: "done" }),
    ),
  },
  "B finishes the run for g1": {
    event: domainEvent(
      "B-finishes",
      "run.created",
      B,
      33,
      run(r3, B, 1, "completed", 33, { delegatedTaskId: g1 }),
    ),
    needs: B,
  },
  // Orchestrator writes a subagent's result transfer on the parent (target) thread.
  "A records B's result": {
    event: domainEvent("B-result-recorded", "context-transfer.created", A, 34, {
      id: ContextTransferId.make("transfer:B-result"),
      type: "subagent_result",
      sourceThreadId: B,
      targetThreadId: A,
      sourcePoint: { threadId: B },
      basePoint: null,
      sourceProviderInstanceId: instance,
      targetProviderInstanceId: instance,
      targetRunId: null,
      status: "consumed",
      resolution: null,
      createdBy: "system",
      error: null,
      createdAt: at(34),
      updatedAt: at(34),
      consumedAt: at(34),
    }),
    needs: B,
  },

  "B asks A a question that starts r1": {
    event: domainEvent("B-asks", "message.updated", A, 28, {
      id: MessageId.make(`message:${r1}`),
      threadId: A,
      runId: r1,
      nodeId: null,
      role: "user",
      text: "Which tests fail?",
      attachments: [],
      streaming: false,
      senderThreadId: B,
      expectsReply: true,
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: at(28),
      updatedAt: at(28),
    }),
  },
  "A replies to B": {
    event: domainEvent("A-replies", "message.updated", B, 29, {
      id: MessageId.make("message:reply"),
      threadId: B,
      runId: null,
      nodeId: null,
      role: "user",
      text: "None.",
      attachments: [],
      streaming: false,
      senderThreadId: A,
      inReplyTo: MessageId.make(`message:${r1}`),
      createdBy: "agent",
      creationSource: "mcp",
      createdAt: at(29),
      updatedAt: at(29),
    }),
    needs: B,
  },

  "i1 starts a command": {
    event: domainEvent("i1-starts", "turn-item.updated", A, 35, {
      ...itemBase("item:i1", A, 1, 35, "running"),
      type: "command_execution",
      input: "pnpm test",
    }),
  },
  "i1 finishes": {
    event: domainEvent("i1-finishes", "turn-item.updated", A, 36, {
      ...itemBase("item:i1", A, 1, 36, "completed"),
      type: "command_execution",
      input: "pnpm test",
      output: "ok",
      exitCode: 0,
    }),
  },
  "a1 runs r1": {
    event: domainEvent("a1-runs", "run-attempt.updated", A, 37, {
      id: a1,
      runId: r1,
      attemptOrdinal: 1,
      rootNodeId: rootR1,
      providerInstanceId: instance,
      providerThreadId: p1,
      providerTurnId: t1,
      reason: "initial",
      status: "running",
      startedAt: at(37),
      completedAt: null,
    }),
  },
  "t1 reports token usage": {
    event: domainEvent("t1-usage", "provider-turn.updated", A, 38, {
      id: t1,
      providerThreadId: p1,
      nodeId: rootR1,
      runAttemptId: a1,
      nativeTurnRef: null,
      ordinal: 1,
      status: "running",
      startedAt: at(38),
      completedAt: null,
      tokenUsage: { usedTokens: 1200, maxTokens: 200000, updatedAt: iso(38) },
    }),
  },
  "a stale t1 snapshot arrives": {
    event: domainEvent("t1-stale", "provider-turn.updated", A, 39, {
      id: t1,
      providerThreadId: p1,
      nodeId: rootR1,
      runAttemptId: a1,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: at(38),
      completedAt: at(39),
    }),
  },
  "i2 shows p1's subagent": {
    event: domainEvent("i2-subagent", "turn-item.updated", A, 40, {
      ...itemBase("item:i2", A, 2, 40, "running"),
      providerThreadId: p1,
      type: "subagent",
      subagentId: g1,
      origin: "provider_native",
      driver,
      providerInstanceId: instance,
      childThreadId: null,
      prompt: "Explore",
      result: null,
    }),
  },
};

/**
 * Each group exercises one coupling between the two implementations. maxDepth is a ceiling: every
 * group closes (no new state) well below it, and the test fails if one stops closing.
 */
const GROUPS = {
  "run field preservation and queue recovery": {
    moves: [
      "r1 starts",
      "r1 completes with a delegated delivery",
      "r1's restart cancels its background work",
      "a stale r1 snapshot arrives",
      "r2 is queued",
      "r2 is held",
      "n1 settles inside r1",
    ],
    maxDepth: 12,
  },
  "provider sessions and provider threads across threads": {
    moves: [
      B_CREATED,
      "s1 attaches to A",
      "s1 attaches to B",
      "s1 stops, reported on B",
      "s1 detaches from A",
      "p1 runs for A",
      "A hands p1 to B with an old snapshot",
      "p1 is reserved as a queued placeholder",
      "p1 loses its app thread",
    ],
    maxDepth: 12,
  },
  "subagent delivery and child results": {
    moves: [
      B_CREATED,
      "A delegates g1 to B",
      "a stale g1 snapshot arrives",
      "g1 records its result",
      "B finishes the run for g1",
      "A records B's result",
    ],
    maxDepth: 12,
  },
  "questions between threads and their replies": {
    moves: [
      B_CREATED,
      "B asks A a question that starts r1",
      "r1 starts",
      "r1 completes with a delegated delivery",
      "A replies to B",
    ],
    maxDepth: 12,
  },
  "turn items, attempts and provider turns": {
    moves: [
      "A is renamed from a stale snapshot",
      "i1 starts a command",
      "i1 finishes",
      "a1 runs r1",
      "t1 reports token usage",
      "a stale t1 snapshot arrives",
      "i2 shows p1's subagent",
      "p1 runs for A",
    ],
    maxDepth: 12,
  },
} as const satisfies Record<
  string,
  { readonly moves: ReadonlyArray<string>; readonly maxDepth: number }
>;
type GroupName = keyof typeof GROUPS;

// Orchestrator.readCommandProjection: what every command decides on.
const COMMAND_FIELDS = [
  "runs",
  "attempts",
  "nodes",
  "subagents",
  "providerSessions",
  "providerThreads",
  "providerTurns",
  "runtimeRequests",
  "messages",
  "turnItems",
  "checkpointScopes",
  "contextTransfers",
] as const;
const COMMAND_FILTER = {
  turnItemTypes: ["user_message", "error"],
  messageRoles: ["user"],
  omitSettledLeafNodes: true,
} as const;
const RECOVERY_KINDS = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
  "thread-replies",
] as const satisfies ReadonlyArray<ProjectionStore.ProjectionRecoveryKind>;

const ELEMENT_SCHEMAS = {
  runs: OrchestrationV2RunJson,
  attempts: OrchestrationV2RunAttemptJson,
  nodes: OrchestrationV2ExecutionNodeJson,
  subagents: OrchestrationV2SubagentJson,
  providerSessions: OrchestrationV2ProviderSessionJson,
  providerThreads: OrchestrationV2ProviderThreadJson,
  providerTurns: OrchestrationV2ProviderTurnJson,
  runtimeRequests: OrchestrationV2RuntimeRequestJson,
  messages: OrchestrationV2ConversationMessageJson,
  plans: OrchestrationV2PlanArtifact,
  turnItems: OrchestrationV2TurnItemJson,
  checkpointScopes: OrchestrationV2CheckpointScopeJson,
  checkpoints: OrchestrationV2CheckpointJson,
  contextHandoffs: OrchestrationV2ContextHandoffJson,
  contextTransfers: OrchestrationV2ContextTransferJson,
  visibleTurnItems: OrchestrationV2ProjectedTurnItemJson,
} as const;
type ArrayField = keyof typeof ELEMENT_SCHEMAS;
const ARRAY_FIELDS = Object.keys(ELEMENT_SCHEMAS) as ReadonlyArray<ArrayField>;

// Encode, decode, encode: both stores are compared in the shape SQLite persists, so decoding
// defaults (an omitted roster reads back as []) are not mistaken for a divergence.
const persistedShape = (schema: Schema.Top) => {
  const encode = Schema.encodeUnknownSync(schema as Schema.Codec<unknown, unknown>);
  const decode = Schema.decodeUnknownSync(schema as Schema.Codec<unknown, unknown>);
  return (value: unknown): unknown => encode(decode(encode(value)));
};
const persistElement = Object.fromEntries(
  ARRAY_FIELDS.map((field) => [field, persistedShape(ELEMENT_SCHEMAS[field])]),
) as Record<ArrayField, (value: unknown) => unknown>;
const persistThread = persistedShape(OrchestrationV2AppThreadJson);
const persistInstant = persistedShape(Schema.DateTimeUtcFromString);

const sortKeys = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => [key, sortKeys(record[key])]),
  );
};

// The reducer stores event payloads by reference, so most rows repeat across observations.
const persistedRows = new WeakMap<object, { readonly json: string; readonly value: unknown }>();
const persistedRow = (field: ArrayField, row: object) => {
  const cached = persistedRows.get(row);
  if (cached !== undefined) return cached;
  const { position: _position, ...rest } = persistElement[field](row) as Record<string, unknown>;
  const value = sortKeys(
    field === "visibleTurnItems"
      ? rest
      : { ...rest, ...(_position === undefined ? {} : { position: _position }) },
  );
  const persisted = { json: JSON.stringify(value), value };
  persistedRows.set(row, persisted);
  return persisted;
};

/** Order-insensitive: SQL orders rows by ORDER BY clauses, the reducer by first write. */
const asSet = (field: ArrayField, rows: ReadonlyArray<object>): string =>
  JSON.stringify(
    rows
      .map((row) => persistedRow(field, row))
      .sort((left, right) => (left.json < right.json ? -1 : left.json > right.json ? 1 : 0))
      .map(({ value }) => value),
  );

type Views = Record<string, string>;

const threadViews = (
  prefix: string,
  projection: Partial<OrchestrationV2ThreadProjection>,
): Views => {
  const views: Views = {};
  if (projection.thread !== undefined) {
    const { updatedAt, ...thread } = persistThread(projection.thread) as Record<string, unknown>;
    views[`${prefix}.thread`] = JSON.stringify(sortKeys(thread));
    views[`${prefix}.thread.updatedAt`] = String(updatedAt);
  }
  if (projection.updatedAt !== undefined) {
    views[`${prefix}.updatedAt`] = String(persistInstant(projection.updatedAt));
  }
  for (const field of ARRAY_FIELDS) {
    const rows = projection[field];
    if (rows !== undefined) views[`${prefix}.${field}`] = asSet(field, rows);
  }
  return views;
};

const observe = (store: ProjectionStore.ProjectionStoreV2Shape) =>
  Effect.gen(function* () {
    const views: Views = {};
    for (const threadId of THREADS) {
      const projection = yield* Effect.exit(store.getThreadProjection(threadId));
      views[`${threadId} exists`] = Exit.isSuccess(projection) ? "yes" : "no";
      if (Exit.isFailure(projection)) continue;
      Object.assign(views, threadViews(`getThreadProjection(${threadId})`, projection.value));
      const records = yield* store.getThreadRecords(threadId, COMMAND_FIELDS, COMMAND_FILTER);
      Object.assign(views, threadViews(`command records(${threadId})`, records));
    }
    for (const kind of RECOVERY_KINDS) {
      views[`getRecoveryThreadIds(${kind})`] = JSON.stringify(
        [...(yield* store.getRecoveryThreadIds(kind))].sort(),
      );
    }
    return views;
  });

/**
 * SQL deliberately casts a wider net for these two kinds (the outbox, unbound sessions, owner
 * nodes; the reply check on delivery), so the promise is containment, not equality.
 */
const RECOVERY_RELATION: Partial<
  Record<(typeof RECOVERY_KINDS)[number], "sql contains memory" | "memory contains sql">
> = {
  runtime: "sql contains memory",
  "thread-replies": "memory contains sql",
};

const agrees = (name: string, sql: string | undefined, memory: string | undefined): boolean => {
  const kind = /^getRecoveryThreadIds\((.+)\)$/.exec(name)?.[1] as
    | (typeof RECOVERY_KINDS)[number]
    | undefined;
  const relation = kind === undefined ? undefined : RECOVERY_RELATION[kind];
  if (relation === undefined || sql === undefined || memory === undefined) return sql === memory;
  const [outer, inner] = relation === "sql contains memory" ? [sql, memory] : [memory, sql];
  const contained = new Set(JSON.parse(outer) as Array<string>);
  return (JSON.parse(inner) as Array<string>).every((id) => contained.has(id));
};

const PROJECTION_VIEW_FIELDS = ["thread", "thread.updatedAt", "updatedAt", ...ARRAY_FIELDS];
const ALL_VIEW_NAMES = [
  ...THREADS.flatMap((threadId) => [
    `${threadId} exists`,
    ...PROJECTION_VIEW_FIELDS.map((field) => `getThreadProjection(${threadId}).${field}`),
    ...["thread", "thread.updatedAt", ...COMMAND_FIELDS].map(
      (field) => `command records(${threadId}).${field}`,
    ),
  ]),
  ...RECOVERY_KINDS.map((kind) => `getRecoveryThreadIds(${kind})`),
];
const STEP_PREFIX = "applyToProjection over the stored projection.";
const STEP_VIEW_NAMES = PROJECTION_VIEW_FIELDS.map((field) => `${STEP_PREFIX}${field}`);
const SAME_EVENTS_ACCEPTED = "both stores accept the same events";
const EVERY_OTHER_VIEW = "every view outside this list agrees too";
const INVARIANT_NAMES = [SAME_EVENTS_ACCEPTED, ...ALL_VIEW_NAMES, ...STEP_VIEW_NAMES];
const NAMED_VIEWS = new Set(INVARIANT_NAMES);

/* ------------------------------------------------------------------------------------------------
 * Known findings: divergences the code has today. None is exempted by view. Each one rewrites one
 * side's answer to remove exactly its own difference, only in the views it names and only in
 * histories that contain its cause. Any other difference in the same view still fails the check.
 * Each finding keeps a test below that fails once the divergence is gone.
 * ---------------------------------------------------------------------------------------------- */

type FindingId = "F2" | "F3" | "F4" | "F6";

const EVENTS_BY_ID = new Map<string, OrchestrationV2DomainEvent>(
  Object.values(MOVES).map(({ event }) => [event.id, event]),
);
const eventById = (id: string | undefined): OrchestrationV2DomainEvent | undefined =>
  id === undefined ? undefined : EVENTS_BY_ID.get(id);

/**
 * What the rewrites read from a history. A state's identity includes every field except `move` and
 * `boundBeforeMove`, so deduplication never merges two histories that a later rewrite would tell
 * apart. Those two fields only shape the check of the move just made, and that check's outcome is
 * part of the identity.
 */
interface TraceFacts {
  /** The event just applied, which the step check folds. */
  readonly move: string;
  /**
   * Per thread, the last event the reducer folded into its projection: one written on the thread,
   * or a provider thread that another thread's event assigned to it after it existed.
   */
  readonly lastFoldedInto: Readonly<Record<string, string>>;
  /** Per thread, the provider threads whose latest event assigned them to it, from another thread, before it was created. */
  readonly assignedBeforeCreated: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Per thread, the context transfers written on it. */
  readonly transfersWrittenOn: Readonly<Record<string, ReadonlyArray<string>>>;
  /** Per thread, the provider sessions attached to it and not detached since, before the move. */
  readonly boundBeforeMove: Readonly<Record<string, ReadonlyArray<string>>>;
}

type ProviderThreadEvent = Extract<
  OrchestrationV2DomainEvent,
  { readonly type: "provider-thread.updated" }
>;

const traceFacts = (events: ReadonlyArray<OrchestrationV2DomainEvent>): TraceFacts => {
  const createdAt = new Map<string, number>();
  const lastFoldedInto: Record<string, string> = {};
  // The SQL row of a provider thread is its latest write, whichever thread wrote it.
  const latestProviderThread = new Map<
    string,
    { readonly index: number; readonly event: ProviderThreadEvent }
  >();
  const transfersWrittenOn: Record<string, Array<string>> = {};
  const bound = new Map<string, Set<string>>();
  let boundBeforeMove: Record<string, ReadonlyArray<string>> = {};
  events.forEach((event, index) => {
    if (index === events.length - 1) {
      boundBeforeMove = Object.fromEntries(
        [...bound].map(([threadId, sessions]) => [threadId, [...sessions].sort()]),
      );
    }
    if (event.type === "thread.created" && !createdAt.has(event.threadId))
      createdAt.set(event.threadId, index);
    if (event.type === "provider-thread.updated")
      latestProviderThread.set(event.payload.id, { index, event });
    // applyToProjectionReplayState ignores an event on a thread it does not know.
    if (!createdAt.has(event.threadId)) return;
    lastFoldedInto[event.threadId] = event.id;
    switch (event.type) {
      case "provider-thread.updated": {
        const target = event.payload.appThreadId;
        if (target !== null && target !== event.threadId && createdAt.has(target))
          lastFoldedInto[target] = event.id;
        break;
      }
      case "provider-session.attached":
        bound.set(
          event.threadId,
          new Set([...(bound.get(event.threadId) ?? []), event.payload.id]),
        );
        break;
      case "provider-session.detached":
        bound.get(event.threadId)?.delete(event.payload.providerSessionId);
        break;
      case "context-transfer.created":
      case "context-transfer.updated":
        if (!(transfersWrittenOn[event.threadId] ??= []).includes(event.payload.id)) {
          transfersWrittenOn[event.threadId]!.push(event.payload.id);
        }
        break;
    }
  });
  const assignedBeforeCreated: Record<string, Array<string>> = {};
  for (const [providerThreadId, { index, event }] of latestProviderThread) {
    const target = event.payload.appThreadId;
    const created = target === null ? undefined : createdAt.get(target);
    if (target !== null && target !== event.threadId && created !== undefined && index < created) {
      (assignedBeforeCreated[target] ??= []).push(providerThreadId);
    }
  }
  return {
    move: events.at(-1)!.id,
    lastFoldedInto,
    assignedBeforeCreated,
    transfersWrittenOn,
    boundBeforeMove,
  };
};

/** Which store read a view comes from, for which thread, and which field. */
interface ViewRef {
  readonly source: "getThreadProjection" | "command records" | "step";
  readonly threadId: string;
  readonly field: string;
}
const viewRef = (view: string, facts: TraceFacts): ViewRef | undefined => {
  if (view.startsWith(STEP_PREFIX)) {
    return {
      source: "step",
      threadId: eventById(facts.move)!.threadId,
      field: view.slice(STEP_PREFIX.length),
    };
  }
  const match = /^(getThreadProjection|command records)\(([^)]+)\)\.(.+)$/.exec(view);
  return match === null
    ? undefined
    : { source: match[1] as ViewRef["source"], threadId: match[2]!, field: match[3]! };
};

/** A view's rows (already persisted and sorted) without the ones `drop` picks, in the same encoding. */
const withoutRows = (
  value: string,
  drop: (row: Readonly<Record<string, unknown>>) => boolean,
): string =>
  JSON.stringify(
    (JSON.parse(value) as Array<Readonly<Record<string, unknown>>>).filter((row) => !drop(row)),
  );

interface KnownFinding {
  readonly id: FindingId;
  readonly summary: string;
  /** The group whose search reaches it. Its test expects `witness` to be a view this finding explains. */
  readonly group: GroupName;
  readonly witness: string;
  /** Whose answer the rewrite changes: SQL's (ProjectionStoreWithV1.layer) or the reducer's (layerMemory, or the step fold). */
  readonly side: "sql" | "reducer";
  /**
   * That side's answer for `view` with this finding's difference removed, or undefined when the
   * finding does not apply to this view in this history.
   */
  readonly normalize: (view: ViewRef, value: string, facts: TraceFacts) => string | undefined;
}

const KNOWN_FINDINGS: ReadonlyArray<KnownFinding> = [
  {
    id: "F2",
    summary:
      "applyToProjection keeps a provider thread on the event's thread after payload.appThreadId moves it elsewhere",
    group: "provider sessions and provider threads across threads",
    witness: `${STEP_PREFIX}providerThreads`,
    side: "reducer",
    // Only the step view. Only when the move is a provider-thread.updated whose appThreadId is not
    // the event's thread. Only that provider thread's row is removed.
    normalize: (view, value, facts) => {
      const move = eventById(facts.move)!;
      if (view.source !== "step" || view.field !== "providerThreads") return undefined;
      if (move.type !== "provider-thread.updated" || move.payload.appThreadId === move.threadId)
        return undefined;
      return withoutRows(value, (row) => row.id === move.payload.id);
    },
  },
  {
    id: "F3",
    summary:
      "a context transfer shows in both endpoint threads' SQL projections, but only in the writing thread's reducer projection",
    group: "subagent delivery and child results",
    witness: "getThreadProjection(thread:B).contextTransfers",
    side: "sql",
    // Only the stored views. Only transfers that name the thread as source or target but were
    // never written on it.
    normalize: (view, value, facts) => {
      if (view.source === "step" || view.field !== "contextTransfers") return undefined;
      const written = facts.transfersWrittenOn[view.threadId] ?? [];
      return withoutRows(
        value,
        (row) =>
          !written.includes(row.id as string) &&
          (row.sourceThreadId === view.threadId || row.targetThreadId === view.threadId),
      );
    },
  },
  {
    id: "F4",
    summary:
      "applyToProjection adds a provider session to a thread that only reported its update, without a binding",
    group: "provider sessions and provider threads across threads",
    witness: `${STEP_PREFIX}providerSessions`,
    side: "reducer",
    // Only the step view. Only when the move is a provider-session.updated for a session that is
    // not bound to the event's thread. Only that session's row is removed.
    normalize: (view, value, facts) => {
      const move = eventById(facts.move)!;
      if (view.source !== "step" || view.field !== "providerSessions") return undefined;
      if (move.type !== "provider-session.updated") return undefined;
      if ((facts.boundBeforeMove[move.threadId] ?? []).includes(move.payload.id)) return undefined;
      return withoutRows(value, (row) => row.id === move.payload.id);
    },
  },
  {
    id: "F6",
    summary:
      "a provider thread assigned to a thread before that thread exists shows up in its SQL projection, not in the reducer's",
    group: "provider sessions and provider threads across threads",
    witness: "getThreadProjection(thread:B).providerThreads",
    side: "sql",
    // Only the thread's providerThreads views (the step view only for its own thread.created). Only
    // provider threads whose latest event assigned them to it from another thread before it existed.
    normalize: (view, value, facts) => {
      const early = facts.assignedBeforeCreated[view.threadId] ?? [];
      if (view.field !== "providerThreads" || early.length === 0) return undefined;
      if (view.source === "step" && eventById(facts.move)!.type !== "thread.created")
        return undefined;
      return withoutRows(value, (row) => early.includes(row.id as string));
    },
  },
];

interface Divergence {
  readonly sql: string;
  readonly memory: string;
  /** Known findings whose rewrite applied, and the two answers after the rewrites. */
  readonly findings: ReadonlyArray<FindingId>;
  readonly residual: { readonly sql: string; readonly memory: string };
}

interface ModelState {
  readonly path: ReadonlyArray<string>;
  /** Views whose answers still differ after every applicable known-finding rewrite. Each one fails the check. */
  readonly disagreements: ReadonlyArray<string>;
  /** Views whose answers differ only by known findings, and which findings. */
  readonly explained: Readonly<Record<string, ReadonlyArray<FindingId>>>;
  readonly details: Readonly<Record<string, Divergence>>;
  readonly digest: string;
}

const sqlRuntime = ManagedRuntime.make(
  ProjectionStoreWithV1.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
);

const PROJECTION_TABLES = [
  "orchestration_v2_projection_threads",
  "orchestration_v2_projection_runs",
  "orchestration_v2_projection_run_attempts",
  "orchestration_v2_projection_nodes",
  "orchestration_v2_projection_subagents",
  "orchestration_v2_projection_provider_sessions",
  "orchestration_v2_projection_provider_session_bindings",
  "orchestration_v2_projection_provider_threads",
  "orchestration_v2_projection_provider_turns",
  "orchestration_v2_projection_runtime_requests",
  "orchestration_v2_projection_messages",
  "orchestration_v2_projection_plans",
  "orchestration_v2_projection_turn_items",
  "orchestration_v2_projection_checkpoint_scopes",
  "orchestration_v2_projection_checkpoints",
  "orchestration_v2_projection_context_handoffs",
  "orchestration_v2_projection_context_transfers",
];

/** One statement that returns every projection row as JSON, so hidden rows count toward a state's identity. */
const tableDumpQuery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selects: Array<string> = [];
  for (const table of PROJECTION_TABLES) {
    const columns = yield* sql.unsafe<{ readonly name: string }>(
      `SELECT name FROM pragma_table_info('${table}')`,
    );
    const fields = columns.map(({ name }) => `'${name}', "${name}"`).join(", ");
    selects.push(`SELECT '${table}:' || json_object(${fields}) AS row FROM ${table}`);
  }
  return selects.join(" UNION ALL ");
}).pipe(Effect.cached, Effect.runSync);

const errorTag = (exit: Exit.Exit<unknown, unknown>): string => {
  if (Exit.isSuccess(exit)) return "ok";
  const error = Cause.squash(exit.cause) as { readonly _tag?: string } | undefined;
  return error?._tag ?? "defect";
};

const memoryObservation = (events: ReadonlyArray<OrchestrationV2DomainEvent>) =>
  Effect.runSync(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      let last = "ok";
      for (const event of events) last = errorTag(yield* Effect.exit(store.apply(event)));
      return { applied: last, views: yield* observe(store) };
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
  );

/**
 * applyToProjection (or emptyProjection for a new thread) over the full getThreadProjection read
 * before the move. This is a superset of the Orchestrator's fold base (readCommandProjection:
 * filtered records, with checkpoints, plans, contextHandoffs and visibleTurnItems emptied).
 */
const stepViews = (
  before: OrchestrationV2ThreadProjection | undefined,
  event: OrchestrationV2DomainEvent,
): Views | undefined => {
  const folded =
    before !== undefined
      ? ProjectionStore.applyToProjection(before, event)
      : event.type === "thread.created"
        ? ProjectionStore.emptyProjection(event)
        : undefined;
  if (folded === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(threadViews("step", folded)).map(([name, value]) => [
      name.replace(/^step\./, STEP_PREFIX),
      value,
    ]),
  );
};

class Undo {
  readonly _tag = "Undo";
  readonly value: unknown;
  constructor(value: unknown) {
    this.value = value;
  }
}

/** Runs `effect` in a transaction (a savepoint when nested) and rolls it back, keeping its result. */
const thenRollBack = <A, E, R>(sql: SqlClient.SqlClient, effect: Effect.Effect<A, E, R>) =>
  sql
    .withTransaction(effect.pipe(Effect.flatMap((value) => Effect.fail(new Undo(value)))))
    .pipe(
      Effect.catch((error) =>
        error instanceof Undo ? Effect.succeed(error.value as A) : Effect.die(error),
      ),
    );

/**
 * Expands one state: replays its path once inside a transaction, then tries each enabled move
 * under a nested savepoint, so every successor is observed on real SQLite and rolled back.
 */
const successors = (
  path: ReadonlyArray<string>,
  moves: ReadonlyArray<string>,
): Array<Step<ModelState>> =>
  sqlRuntime.runSync(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const events = path.map((name) => MOVES[name]!.event);
      return yield* thenRollBack(
        sql,
        Effect.gen(function* () {
          for (const event of events) yield* Effect.exit(store.apply(event));
          const before = new Map<ThreadId, OrchestrationV2ThreadProjection>();
          for (const threadId of THREADS) {
            const projection = yield* Effect.exit(store.getThreadProjection(threadId));
            if (Exit.isSuccess(projection)) before.set(threadId, projection.value);
          }
          const steps: Array<Step<ModelState>> = [];
          for (const name of moves) {
            const move = MOVES[name]!;
            if (move.once === true && path.includes(name)) continue;
            if (move.needs !== undefined && !before.has(move.needs)) continue;
            const { applied, sqlViews, rows } = yield* thenRollBack(
              sql,
              Effect.gen(function* () {
                const applied = errorTag(yield* Effect.exit(store.apply(move.event)));
                const sqlViews = yield* observe(store);
                const rows = (yield* sql.unsafe<{ readonly row: string }>(yield* tableDumpQuery))
                  .map(({ row }) => row)
                  .sort();
                return { applied, sqlViews, rows };
              }),
            );

            const memory = memoryObservation([...events, move.event]);
            const facts = traceFacts([...events, move.event]);
            const details: Record<string, Divergence> = {};
            const disagreements: Array<string> = [];
            const explained: Record<string, ReadonlyArray<FindingId>> = {};
            const compare = (
              view: string,
              sqlValue: string | undefined,
              memoryValue: string | undefined,
            ) => {
              if (agrees(view, sqlValue, memoryValue)) return;
              const raw = { sql: sqlValue ?? "(absent)", memory: memoryValue ?? "(absent)" };
              const residual = { ...raw };
              const findings: Array<FindingId> = [];
              const ref =
                sqlValue === undefined || memoryValue === undefined
                  ? undefined
                  : viewRef(view, facts);
              for (const finding of ref === undefined ? [] : KNOWN_FINDINGS) {
                const side = finding.side === "sql" ? "sql" : "memory";
                const rewritten = finding.normalize(ref!, residual[side], facts);
                if (rewritten === undefined || rewritten === residual[side]) continue;
                residual[side] = rewritten;
                findings.push(finding.id);
              }
              details[view] = { ...raw, findings, residual };
              if (findings.length > 0 && residual.sql === residual.memory)
                explained[view] = findings;
              else disagreements.push(view);
            };
            if (applied !== memory.applied) compare(SAME_EVENTS_ACCEPTED, applied, memory.applied);
            for (const view of new Set([...Object.keys(sqlViews), ...Object.keys(memory.views)])) {
              compare(view, sqlViews[view], memory.views[view]);
            }
            const step = stepViews(before.get(move.event.threadId), move.event);
            for (const [view, value] of Object.entries(step ?? {})) {
              compare(
                view,
                sqlViews[view.replace(STEP_PREFIX, `getThreadProjection(${move.event.threadId}).`)],
                value,
              );
            }
            disagreements.sort();
            const { lastFoldedInto, assignedBeforeCreated, transfersWrittenOn } = facts;
            const digest = createHash("sha256")
              .update(
                canonicalKey({
                  rows,
                  sqlViews,
                  memory: memory.views,
                  disagreements,
                  explained,
                  facts: { lastFoldedInto, assignedBeforeCreated, transfersWrittenOn },
                }),
              )
              .digest("hex");
            steps.push({
              action: name,
              state: { path: [...path, name], disagreements, explained, details, digest },
            });
          }
          return steps;
        }),
      );
    }),
  );

const initialState = (): ModelState => {
  const [first] = successors([], [A_CREATED]);
  return first!.state;
};

/**
 * Plain words for a counterexample: what each store answered where they differ. Unexplained
 * divergences come first, shown after the known-finding rewrites that applied; then the views that
 * differ only by known findings, shown raw.
 */
const describeState = (state: ModelState): string => {
  const unexplained = state.disagreements.map((name) => {
    const { residual, findings } = state.details[name]!;
    const note = findings.length === 0 ? "" : ` (after removing ${findings.join(", ")})`;
    return `${name}${note}:\n${describeDiff(residual.sql, residual.memory)}`;
  });
  const known = Object.entries(state.explained).map(
    ([name, findings]) =>
      `${name} (known finding ${findings.join(", ")}):\n${describeDiff(state.details[name]!.sql, state.details[name]!.memory)}`,
  );
  const lines = [...unexplained, ...known].slice(0, 4);
  return lines.length === 0 ? "stores agree" : lines.join("\n     ");
};

const describeDiff = (
  sql: string,
  memory: string,
  labels: readonly [string, string] = ["SQL", "reducer"],
): string => {
  const parse = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  };
  const lines: Array<string> = [];
  const byIdentity = (rows: Array<unknown>) =>
    new Map(
      rows.map((row, index) => {
        const record = row as { readonly id?: string; readonly sourceItemId?: string } | null;
        return [`[${record?.id ?? record?.sourceItemId ?? index}]`, row] as const;
      }),
    );
  const walk = (left: unknown, right: unknown, at: string) => {
    if (lines.length >= 6 || canonicalKey(left ?? null) === canonicalKey(right ?? null)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      const [leftRows, rightRows] = [byIdentity(left), byIdentity(right)];
      const before = lines.length;
      for (const key of new Set([...leftRows.keys(), ...rightRows.keys()])) {
        walk(leftRows.get(key), rightRows.get(key), `${at}${key}`);
      }
      if (lines.length === before) {
        lines.push(
          `       ${at || "value"} order: ${labels[0]} ${[...leftRows.keys()].join("")} | ${labels[1]} ${[...rightRows.keys()].join("")}`,
        );
      }
      return;
    }
    if (
      typeof left === "object" &&
      left !== null &&
      typeof right === "object" &&
      right !== null &&
      !Array.isArray(left)
    ) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
        walk(
          (left as Record<string, unknown>)[key],
          (right as Record<string, unknown>)[key],
          `${at}.${key}`,
        );
      }
      return;
    }
    const clip = (value: unknown) => {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      return text === undefined ? "undefined" : text.length > 160 ? `${text.slice(0, 160)}…` : text;
    };
    lines.push(`       ${at || "value"}: ${labels[0]} ${clip(left)} | ${labels[1]} ${clip(right)}`);
  };
  walk(parse(sql), parse(memory), "");
  return lines.join("\n");
};

type Invariants = Readonly<Record<string, (state: ModelState) => boolean>>;

/** Every view is checked in every group and every history; known findings are removed by their rewrites only. */
const AGREEMENT: Invariants = {
  ...Object.fromEntries(
    INVARIANT_NAMES.map((name) => [
      name,
      (state: ModelState) => !state.disagreements.includes(name),
    ]),
  ),
  [EVERY_OTHER_VIEW]: (state) => state.disagreements.every((name) => NAMED_VIEWS.has(name)),
};

const runGroup = (group: GroupName, invariants: Invariants) => {
  const { moves, maxDepth } = GROUPS[group];
  return check<ModelState>({
    init: [initialState()],
    next: (state) => successors(state.path, moves),
    key: (state) => state.digest,
    invariants,
    maxDepth,
    maxStates: 200_000,
  });
};

const reportVerdict = (label: string, verdict: ReturnType<typeof runGroup>) => {
  if (verdict.ok) {
    console.log(
      `[projection-replay] ${label}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}`,
    );
    return;
  }
  throw new Error(
    `${label}: "${verdict.property}" broken after ${verdict.trace.length - 1} moves (${verdict.states} states explored):\n${formatTrace(verdict.trace, describeState)}`,
  );
};

beforeAll(async () => {
  await sqlRuntime.runPromise(Effect.void);
});
afterAll(async () => {
  await sqlRuntime.dispose();
});

describe("SQL projection and pure reducer agree on every bounded history", () => {
  for (const group of Object.keys(GROUPS) as Array<GroupName>) {
    it(group, () => {
      const verdict = runGroup(group, AGREEMENT);
      reportVerdict(group, verdict);
      expect(
        verdict.ok && verdict.exhaustive,
        "the group's reachable states must close below maxDepth",
      ).toBe(true);
    });
  }

  for (const finding of KNOWN_FINDINGS) {
    it(`known finding ${finding.id} still reproduces: ${finding.summary}`, () => {
      const verdict = runGroup(finding.group, {
        [finding.witness]: (state) =>
          !(state.explained[finding.witness] ?? []).includes(finding.id),
      });
      if (verdict.ok) {
        throw new Error(
          `${finding.id} no longer reproduces in "${finding.group}": remove it from KNOWN_FINDINGS`,
        );
      }
      console.log(
        `[projection-replay] finding ${finding.id} "${finding.summary}": "${verdict.property}" after ${verdict.trace.length - 1} moves:\n${formatTrace(verdict.trace, describeState)}`,
      );
      expect(verdict.property).toBe(finding.witness);
    });
  }

  const allMoves = Object.keys(MOVES).filter((name) => name !== A_CREATED);
  it.prop(
    "seeded long histories over every move keep the stores in agreement",
    [
      Arbitrary.array(Arbitrary.schema(Schema.Literals(allMoves as [string, ...Array<string>])), {
        minLength: 8,
        maxLength: 16,
      }),
    ],
    ([history]) => {
      let state = initialState();
      for (const name of history) {
        const next = successors(state.path, [name]);
        if (next.length === 0) continue;
        state = next[0]!.state;
        if (state.disagreements.length > 0) {
          throw new Error(
            `"${state.disagreements[0]}" broken after ${state.path.join(" → ")}:\n     ${describeState(state)}`,
          );
        }
      }
    },
    { arbitrary: { runs: 40, seed: 20261106 } },
  );
});

/* ------------------------------------------------------------------------------------------------
 * Part 2. Histories written through EventSink (real position allocation, real projection), with
 * event-log prune passes among the writes, then replay from every cursor a client may still replay
 * from, and rebuild over every history no pass pruned.
 * ---------------------------------------------------------------------------------------------- */

interface Write {
  readonly commandId?: CommandId;
  readonly events: (index: number) => ReadonlyArray<OrchestrationV2DomainEvent>;
}

const writeEvent = (
  index: number,
  key: string,
  type: OrchestrationV2DomainEvent["type"],
  payload: unknown,
) => domainEvent(`event:${index}:${key}`, type, A, 100 + index, payload);

const growingCommand = (id: string, index: number, runId: RunId | null) => ({
  ...itemBase(id, A, 1, 100 + index, "running", runId),
  type: "command_execution",
  input: "pnpm test",
  output: `output after write ${index}`,
});

const subagentPrompt = "Review the whole diff carefully. ".repeat(8);

const WRITES: Record<string, Write> = {
  [A_CREATED]: { events: (index) => [writeEvent(index, "A", "thread.created", threadA)] },
  "A is renamed": {
    events: (index) => [
      writeEvent(index, "rename", "thread.metadata-updated", {
        ...threadA,
        title: `Renamed ${index}`,
        updatedAt: at(100 + index),
      }),
    ],
  },
  "A is visited": {
    events: (index) => [
      writeEvent(index, "visit", "thread.visited", { ...threadA, lastVisitedAt: at(100 + index) }),
    ],
  },
  "i1 progresses": {
    events: (index) => [
      writeEvent(index, "i1", "turn-item.updated", growingCommand("item:i1", index, null)),
    ],
  },
  "a command rewrites i1": {
    commandId: CommandId.make("command:rewrite-i1"),
    events: (index) => [
      writeEvent(index, "i1", "turn-item.updated", growingCommand("item:i1", index, null)),
    ],
  },
  "g1 reports progress": {
    events: (index) => [
      writeEvent(index, "g1", "subagent.updated", {
        ...subagent(100 + index, { origin: "provider_native", childThreadId: null }),
        prompt: subagentPrompt,
        progress: `progress ${index}`,
      }),
      writeEvent(index, "g1-item", "turn-item.updated", {
        ...itemBase("item:g1", A, 5, 100 + index, "running"),
        type: "subagent",
        subagentId: g1,
        origin: "provider_native",
        driver,
        providerInstanceId: instance,
        childThreadId: null,
        prompt: subagentPrompt,
        progress: `progress ${index}`,
        result: null,
      }),
    ],
  },
  "m1 streams": {
    events: (index) => [
      writeEvent(index, "m1", "message.updated", {
        id: MessageId.make("message:m1"),
        threadId: A,
        runId: null,
        nodeId: null,
        role: "assistant",
        text: `streamed through write ${index}`,
        attachments: [],
        streaming: true,
        createdBy: "agent",
        creationSource: "provider",
        createdAt: at(100),
        updatedAt: at(100 + index),
      }),
    ],
  },
  "r1 starts": {
    events: (index) => [
      writeEvent(index, "r1", "run.created", run(r1, A, 1, "running", 100 + index)),
    ],
  },
  "r2 starts with its first item": {
    events: (index) => [
      writeEvent(index, "i4", "turn-item.updated", growingCommand("item:i4", index, r2)),
      writeEvent(index, "r2", "run.created", run(r2, A, 2, "running", 100 + index)),
    ],
  },
  "i1 progresses in r1": {
    events: (index) => [
      writeEvent(index, "i1", "turn-item.updated", growingCommand("item:i1", index, r1)),
    ],
  },
  "i2 progresses outside any run": {
    events: (index) => [
      writeEvent(index, "i2", "turn-item.updated", growingCommand("item:i2", index, null)),
    ],
  },
  "i5 names a run that was never created": {
    events: (index) => [
      writeEvent(
        index,
        "i5",
        "turn-item.updated",
        growingCommand("item:i5", index, RunId.make("run:never-created")),
      ),
    ],
  },
};

/**
 * Not a write: a day passes for the mark the last pass left, and a pass runs with the Session
 * Protocol projector caught up (ProjectionMaintenance.test.ts covers a projector that lags). The
 * first pass of a history only marks the head; each later one prunes through the previous mark.
 */
const PRUNE_PASS = "a day later, a prune pass runs";

const HISTORY_LOOPS = {
  pruning: {
    writes: [
      "A is renamed",
      "A is visited",
      "i1 progresses",
      "a command rewrites i1",
      "g1 reports progress",
      "m1 streams",
      PRUNE_PASS,
    ],
    maxLength: 4,
  },
  positions: {
    writes: [
      "r1 starts",
      "r2 starts with its first item",
      "i1 progresses in r1",
      "i2 progresses outside any run",
      "i5 names a run that was never created",
    ],
    maxLength: 4,
  },
} as const;

const historyServices = (() => {
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStoreWithV1.layer);
  return Layer.mergeAll(
    stores,
    EventSink.layer.pipe(Layer.provide(stores)),
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
    ProjectionReplay.layer.pipe(Layer.provide(stores)),
  );
})();
const historyRuntime = ManagedRuntime.make(SqlitePersistence.layerMemory);

class RollBack {
  readonly _tag = "RollBack";
  readonly violations: ReadonlyArray<string>;
  readonly stats: HistoryStats;
  constructor(violations: ReadonlyArray<string>, stats: HistoryStats) {
    this.violations = violations;
    this.stats = stats;
  }
}
interface HistoryStats {
  readonly deleted: number;
  readonly promptAnchors: number;
  /** A surviving row borrows its prompt from an anchor at or below the pruned boundary. */
  readonly anchorKeptBelowBoundary: boolean;
  /** The stored projection and positions once every write and pass ran. */
  readonly finalState: string;
}

const RUNLESS_BAND = 0;
const bandOf = (ordinal: number) => Math.floor(ordinal / 1_000_000);

const encodeProjection = Schema.encodeUnknownSync(OrchestrationV2ThreadProjectionJson);
const encodeEvent = Schema.encodeUnknownSync(OrchestrationV2DomainEventJson);
const encodeStored = (stored: OrchestrationV2StoredEvent) =>
  canonicalKey({
    sequence: stored.sequence,
    commandId: stored.commandId,
    event: encodeEvent(stored.event),
  });

/** Order-sensitive: a client appends an entity where it first sees it, so replay must keep that order. */
const foldWithReducer = (events: ReadonlyArray<OrchestrationV2DomainEvent>): string =>
  Effect.runSync(
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      for (const event of events) yield* store.apply(event);
      return JSON.stringify(sortKeys(encodeProjection(yield* store.getThreadProjection(A))));
    }).pipe(Effect.provide(ProjectionStore.layerMemory)),
  );

const checkHistory = (names: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const replay = yield* ProjectionReplay.ProjectionReplay;
    const sql = yield* SqlClient.SqlClient;
    const violations: Array<string> = [];
    const fail = (promise: string, detail: string) => violations.push(`${promise}: ${detail}`);

    const readPositions = sql<{ readonly turn_item_id: string; readonly ordinal: number }>`
      SELECT turn_item_id, ordinal FROM orchestration_v2_turn_item_positions WHERE thread_id = ${A} ORDER BY turn_item_id
    `;
    const storedState = Effect.gen(function* () {
      const projection = yield* projections.getThreadProjection(A);
      return canonicalKey({
        projection: encodeProjection(projection),
        positions: yield* readPositions,
      });
    });
    const highWater = Effect.all([
      eventStore.latestSequence(),
      eventStore.latestSequence({ threadId: A }),
    ]);

    const runOrdinals = new Map<string, number>();
    const firstWrites = new Map<string, { readonly order: number; readonly band: number }>();
    // Every event as written, read back before any later pass could prune it.
    const original: Array<OrchestrationV2StoredEvent> = [];
    let deleted = 0;
    // Event ids and timestamps count writes only, so a history and the same history without its
    // passes write identical events.
    let index = 0;
    for (const name of [A_CREATED, ...names]) {
      if (name === PRUNE_PASS) {
        const stateBefore = yield* storedState;
        const highWaterBefore = yield* highWater;
        yield* sql`
          UPDATE orchestration_v2_projection_metadata
          SET updated_at = ${DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 1 }))}
          WHERE projection_name = ${EVENT_LOG_PRUNE_MARK}
        `;
        yield* journalThroughHead;
        deleted += (yield* maintenance.pruneEventStore()).deletedEventCount;
        if ((yield* storedState) !== stateBefore) {
          fail(
            "a prune pass never changes the stored projection or positions",
            `after ${index} writes`,
          );
        }
        const highWaterAfter = yield* highWater;
        if (canonicalKey(highWaterAfter) !== canonicalKey(highWaterBefore)) {
          fail(
            "a prune pass keeps the global and per-thread high-water marks",
            `${JSON.stringify(highWaterBefore)} became ${JSON.stringify(highWaterAfter)}`,
          );
        }
        continue;
      }
      const write = WRITES[name]!;
      const events = write.events(index);
      index++;
      for (const event of events) {
        if (event.type === "run.created" || event.type === "run.updated") {
          runOrdinals.set(event.payload.id, event.payload.ordinal);
        }
      }
      for (const event of events) {
        if (event.type === "turn-item.updated" && !firstWrites.has(event.payload.id)) {
          const runId = event.payload.runId;
          firstWrites.set(event.payload.id, {
            order: firstWrites.size,
            band: runId === null ? RUNLESS_BAND : (runOrdinals.get(runId) ?? RUNLESS_BAND),
          });
        }
      }
      yield* sink.write({
        events,
        ...(write.commandId === undefined ? {} : { commandId: write.commandId }),
      });
      original.push(
        ...(yield* eventStore
          .read({ afterSequence: original.at(-1)?.sequence ?? 0 })
          .pipe(Stream.runCollect)),
      );
    }

    const storedFinal = yield* projections.getThreadProjection(A);
    const positionsFinal = yield* readPositions;
    const promptAnchors = (yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM orchestration_events WHERE json_type(payload_json, '$.promptSequence') = 'integer'
    `)[0]!.count;

    const ordinalsOf = new Map<string, Set<number>>();
    for (const stored of original) {
      if (stored.event.type !== "turn-item.updated") continue;
      const seen = ordinalsOf.get(stored.event.payload.id) ?? new Set<number>();
      seen.add(stored.event.payload.ordinal);
      ordinalsOf.set(stored.event.payload.id, seen);
    }
    for (const [itemId, ordinals] of ordinalsOf) {
      if (ordinals.size !== 1)
        fail(
          "an item keeps its first ordinal on every rewrite",
          `${itemId} was written with ${[...ordinals].join(", ")}`,
        );
    }
    const ordinalOf = new Map(
      storedFinal.turnItems.map((item) => [item.id as string, item.ordinal]),
    );
    if (new Set(ordinalOf.values()).size !== ordinalOf.size) {
      fail("turn-item ordinals are unique per thread", JSON.stringify([...ordinalOf]));
    }
    for (const row of positionsFinal) {
      if (ordinalOf.get(row.turn_item_id) !== row.ordinal) {
        fail(
          "the position store and the projection agree",
          `${row.turn_item_id}: position ${row.ordinal}, projection ${ordinalOf.get(row.turn_item_id)}`,
        );
      }
    }
    for (const [itemId, first] of firstWrites) {
      const ordinal = ordinalOf.get(itemId);
      if (ordinal === undefined || bandOf(ordinal) !== first.band || ordinal % 1_000_000 === 0) {
        fail(
          "an item's ordinal lies in the band of the run known at its first write",
          `${itemId} has ordinal ${ordinal}, expected band ${first.band === RUNLESS_BAND ? "runless (1..999999)" : `${first.band}xxxxxx`}`,
        );
      }
    }
    const byBand = new Map<
      number,
      Array<[string, { readonly order: number; readonly band: number }]>
    >();
    for (const entry of firstWrites)
      byBand.set(entry[1].band, [...(byBand.get(entry[1].band) ?? []), entry]);
    for (const entries of byBand.values()) {
      const ordered = entries
        .toSorted((left, right) => left[1].order - right[1].order)
        .map(([itemId]) => ordinalOf.get(itemId)!);
      if (ordered.some((ordinal, index) => index > 0 && ordinal <= ordered[index - 1]!)) {
        fail(
          "ordinals increase in first-write order within a band",
          JSON.stringify(entries.map(([itemId]) => [itemId, ordinalOf.get(itemId)])),
        );
      }
    }

    const prunedThrough =
      (yield* sql<{ readonly last_sequence: number }>`
        SELECT last_sequence FROM orchestration_v2_projection_metadata
        WHERE projection_name = ${EVENT_LOG_PRUNED_THROUGH}
      `)[0]?.last_sequence ?? 0;
    const borrowed = yield* sql<{
      readonly sequence: number;
      readonly prompt_sequence: number;
      readonly anchor: number | null;
    }>`
      SELECT
        event.sequence,
        json_extract(event.payload_json, '$.promptSequence') AS prompt_sequence,
        (SELECT anchor.sequence FROM orchestration_events AS anchor
         WHERE anchor.sequence = json_extract(event.payload_json, '$.promptSequence')) AS anchor
      FROM orchestration_events AS event
      WHERE json_type(event.payload_json, '$.promptSequence') = 'integer'
    `;
    for (const row of borrowed) {
      if (row.anchor === null)
        fail(
          "every promptSequence target survives",
          `event ${row.sequence} points at a deleted prompt`,
        );
    }
    const stats = (anchorKeptBelowBoundary: boolean): HistoryStats => ({
      deleted,
      promptAnchors,
      anchorKeptBelowBoundary,
      finalState: canonicalKey({
        projection: encodeProjection(storedFinal),
        positions: positionsFinal,
      }),
    });
    // Stop at the first broken promise: a row whose anchor is gone no longer decodes.
    if (violations.length > 0) return yield* Effect.fail(new RollBack(violations, stats(false)));
    const surviving = yield* eventStore.read().pipe(Stream.runCollect);
    const survivingIds = new Set(surviving.map((stored) => stored.event.id as string));
    const head = original.at(-1)?.sequence ?? 0;
    for (const stored of original) {
      if (survivingIds.has(stored.event.id)) continue;
      if (stored.sequence > prunedThrough) {
        fail(
          "a pass never deletes an event above the published boundary",
          `${stored.event.id} at ${stored.sequence}, boundary ${prunedThrough}`,
        );
      }
      if (
        stored.event.type === "thread.created" ||
        stored.sequence === head ||
        (stored.event.type === "run.updated" && stored.event.payload.status === "running")
      ) {
        fail(
          "a pass keeps thread.created, the stream's newest event and every running run update",
          stored.event.id,
        );
      }
    }
    const originalById = new Map(original.map((stored) => [stored.event.id as string, stored]));
    for (const stored of surviving) {
      if (encodeStored(stored) !== encodeStored(originalById.get(stored.event.id)!)) {
        fail("a surviving event reads back exactly as it was written", `${stored.event.id}`);
      }
    }

    // A cursor below the boundary resumes from a snapshot (ws.ts); every other cursor replays.
    const full = foldWithReducer(original.map((stored) => stored.event));
    for (const cursor of [0, ...original.map((stored) => stored.sequence)]) {
      if (cursor < prunedThrough) continue;
      const replayed = foldWithReducer([
        ...original.filter((stored) => stored.sequence <= cursor).map((stored) => stored.event),
        ...surviving.filter((stored) => stored.sequence > cursor).map((stored) => stored.event),
      ]);
      if (replayed !== full) {
        fail(
          "replay from any cursor at or above the boundary reaches the full fold",
          `cursor ${cursor}:\n${describeDiff(full, replayed, ["full fold", "replay"])}`,
        );
        break;
      }
    }

    // Rebuilding needs the whole log, so only histories no pass pruned can check it.
    if (prunedThrough === 0) {
      const verification = yield* replay.rebuild;
      if (!verification.valid) fail("rebuild verifies", JSON.stringify(verification));
      const rebuilt = yield* projections.getThreadProjection(A);
      if (
        JSON.stringify(encodeProjection(rebuilt)) !== JSON.stringify(encodeProjection(storedFinal))
      ) {
        fail(
          "rebuild reproduces the stored projection",
          describeDiff(
            JSON.stringify(encodeProjection(storedFinal)),
            JSON.stringify(encodeProjection(rebuilt)),
            ["stored", "rebuilt"],
          ),
        );
      }
      const positionsAfter = yield* readPositions;
      if (canonicalKey(positionsAfter) !== canonicalKey(positionsFinal)) {
        fail(
          "rebuild leaves every turn-item position unchanged",
          `${JSON.stringify(positionsFinal)} became ${JSON.stringify(positionsAfter)}`,
        );
      }
    }

    return yield* Effect.fail(
      new RollBack(
        violations,
        stats(borrowed.some((row) => row.anchor !== null && row.anchor <= prunedThrough)),
      ),
    );
  });

const runHistory = (names: ReadonlyArray<string>): Promise<RollBack> =>
  historyRuntime.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return yield* sql.withTransaction(checkHistory(names));
    }).pipe(
      Effect.provide(historyServices),
      Effect.flatMap(() => Effect.die("history did not roll back")),
      Effect.catch((error) =>
        error instanceof RollBack ? Effect.succeed(error) : Effect.die(error),
      ),
    ),
  );

/**
 * A history's violations, and one more when its passes changed what its writes stored: the same
 * writes without the passes must end in the same projection and positions. Histories are
 * enumerated shortest first, so the pass-free history has usually run already.
 */
const finalStates = new Map<string, string>();
const checkHistoryWithPasses = async (names: ReadonlyArray<string>): Promise<RollBack> => {
  const result = await runHistory(names);
  const writes = names.filter((name) => name !== PRUNE_PASS);
  const key = writes.join("\u0000");
  if (writes.length === names.length) {
    finalStates.set(key, result.stats.finalState);
    return result;
  }
  const withoutPasses =
    finalStates.get(key) ?? (await checkHistoryWithPasses(writes)).stats.finalState;
  if (withoutPasses === result.stats.finalState) return result;
  return new RollBack(
    [
      ...result.violations,
      `later writes store the same projection and positions with or without the passes: ${describeDiff(withoutPasses, result.stats.finalState, ["without passes", "with passes"])}`,
    ],
    result.stats,
  );
};

describe("pruning, rebuild and positions keep every replay intact", () => {
  beforeAll(async () => {
    await historyRuntime.runPromise(Effect.void);
  });
  afterAll(async () => {
    await historyRuntime.dispose();
  });

  for (const [loop, { writes, maxLength }] of Object.entries(HISTORY_LOOPS)) {
    it(`every ${loop} history up to ${maxLength} writes`, async () => {
      let histories = 0;
      let deleting = 0;
      let anchored = 0;
      let keptBelow = 0;
      for (const history of sequences(writes, maxLength)) {
        histories++;
        const result = await checkHistoryWithPasses(history);
        if (result.stats.deleted > 0) deleting++;
        if (result.stats.promptAnchors > 0) anchored++;
        if (result.stats.anchorKeptBelowBoundary) keptBelow++;
        if (result.violations.length > 0) {
          throw new Error(
            `Shortest failing history: ${[A_CREATED, ...history].join(" → ")}\n  ${result.violations.join("\n  ")}`,
          );
        }
      }
      console.log(
        `[projection-replay] ${loop}: ${histories} histories (exhaustive to ${maxLength} moves), ${deleting} pruned something, ${anchored} stored a prompt by reference, ${keptBelow} kept a borrowed anchor below the boundary`,
      );
      if (loop === "pruning") {
        expect(deleting, "some history must give pruning something to delete").toBeGreaterThan(0);
        expect(anchored, "some history must store a subagent prompt by reference").toBeGreaterThan(
          0,
        );
        expect(
          keptBelow,
          "some history must keep an anchor below the boundary for a later row",
        ).toBeGreaterThan(0);
      }
    });
  }

  const allMoves = [...Object.keys(WRITES).filter((name) => name !== A_CREATED), PRUNE_PASS];
  it.effect.prop(
    "seeded long histories over every write and prune passes keep replay, rebuild and positions intact",
    [
      Arbitrary.array(Arbitrary.schema(Schema.Literals(allMoves as [string, ...Array<string>])), {
        minLength: 6,
        maxLength: 14,
      }),
    ],
    ([history]) =>
      Effect.promise(() => checkHistoryWithPasses(history)).pipe(
        Effect.map((result) => {
          if (result.violations.length > 0) {
            throw new Error(
              `Failing history: ${[A_CREATED, ...history].join(" → ")}\n  ${result.violations.join("\n  ")}`,
            );
          }
        }),
      ),
    { arbitrary: { runs: 30, seed: 20261106 } },
  );
});
