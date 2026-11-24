// ), packages/contracts/src/orchestratorMcp.ts @ ab3a3cd1.
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ContextTransferId,
  IsoDateTime,
  MessageId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  RuntimeRequestId,
  ScheduledTaskId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskUpsertSchedule,
} from "./scheduledTask.ts";
import { ProviderInteractionModeLiteral, ProviderRequestKind, RuntimeMode } from "./providerPolicy.ts";
import { PullRequestState } from "./pullRequest.ts";
import {
  ThreadLinkedPullRequest,
  ThreadPullRequestKey,
  ThreadPullRequestLinkSource,
} from "./threadPullRequest.ts";
import { hasOnlyPairedSurrogates } from "./threadMetadataMcp.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";
import {
  OrchestrationV2Actor,
  OrchestrationV2CreationSource,
  OrchestrationV2RunStatus,
  OrchestrationV2TurnItemStatus,
} from "./orchestrationV2.ts";
import { ProviderOptionSelection, ProviderOptionSelectionValue } from "./model.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

const OrchestratorMcpPrompt = TrimmedNonEmptyString.check(Schema.isMaxLength(120_000));
const OrchestratorMcpTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512));
export const OrchestratorMcpClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Reuse it to retry the same call. A new call gets a new key." });

/**
 * OpenCode 1.15 has been observed serializing nested MCP union objects as JSON
 * strings. Keep the structured object as the documented form while accepting
 * that compatibility shape at the tool boundary and decoding it immediately.
 */
const OrchestratorMcpScheduleFromJsonString = Schema.fromJsonString(
  ScheduledTaskUpsertSchedule,
).annotate({
  description: "JSON-text schedule. Prefer the object form.",
});

const OrchestratorMcpSchedule = Schema.Union([
  ScheduledTaskUpsertSchedule,
  OrchestratorMcpScheduleFromJsonString,
]).annotate({
  description:
    "Trigger: {type:'once',runAt}, {type:'interval',everyMs}, {type:'fixed_time',timeOfDay,weekdays?,everyDays?|everyWeeks?}, {type:'monthly',timeOfDay,days}, {type:'cron',expression,timeZone}, or {type:'webhook'}. Repeats take startAt?, until?, maxRuns?; wall-clock ones timeZone?.",
});

/**
 * Shorthand `{ id: value }` record form for target model options. Unlike the
 * legacy-tolerant `ProviderOptionSelections` persistence schema, this decodes
 * strictly: a value that is not a string or boolean fails the request rather
 * than being silently dropped.
 */
const OrchestratorMcpTargetOptionsFromRecord = Schema.Record(
  Schema.String,
  ProviderOptionSelectionValue,
).pipe(
  Schema.decodeTo(
    Schema.Array(ProviderOptionSelection),
    SchemaTransformation.transformEffect({
      decode: (record) =>
        Effect.succeed(Object.entries(record).map(([id, value]) => ({ id, value }))),
      encode: (selections: ReadonlyArray<ProviderOptionSelection>) =>
        Effect.succeed(
          Object.fromEntries(selections.map((selection) => [selection.id, selection.value])),
        ),
    }),
  ),
);

export const OrchestratorMcpTargetOptions = Schema.Union([
  Schema.Array(ProviderOptionSelection),
  OrchestratorMcpTargetOptionsFromRecord,
]);
export type OrchestratorMcpTargetOptions = typeof OrchestratorMcpTargetOptions.Type;

/**
 * An optional target field where an empty string reads as absent: some models
 * fill every optional field (`{ providerInstanceId: "", model: "" }`), and
 * that means "inherit", never a failed call.
 */
const blankAsAbsent = <S extends Schema.Top & { readonly Encoded: string }>(value: S, description: string) =>
  Schema.optional(Schema.String.annotate({ description })).pipe(
    Schema.decodeTo(
      Schema.optional(value),
      SchemaTransformation.transformOptional<S["Encoded"] | undefined, string | undefined>({
        decode: (raw) => (Option.isSome(raw) && raw.value?.trim() === "" ? Option.none() : raw),
        encode: (raw) => raw,
      }),
    ),
  );

export const OrchestratorMcpTarget = Schema.Struct({
  providerInstanceId: blankAsAbsent(ProviderInstanceId, "Provider instance id from `orchestrator_capabilities`."),
  driverKind: blankAsAbsent(ProviderDriverKind, "Prefer `providerInstanceId`."),
  model: blankAsAbsent(TrimmedNonEmptyString, "Model id."),
  /**
   * Model option selections for the child (for example reasoning effort).
   * Accepts the canonical `[{ id, value }]` array or the shorthand
   * `{ id: value }` record; valid ids come from the option descriptors
   * advertised by orchestrator_capabilities. When omitted, options inherit
   * from the parent only when the child runs the parent's provider and model.
   */
  options: Schema.optional(
    OrchestratorMcpTargetOptions.annotate({
      description: "Options from `orchestrator_capabilities`, such as {effort:'max'}.",
    }),
  ),
});
export type OrchestratorMcpTarget = typeof OrchestratorMcpTarget.Type;

export const OrchestratorMcpRuntimeMode = Schema.Union([Schema.Literal("inherit"), RuntimeMode]);
export type OrchestratorMcpRuntimeMode = typeof OrchestratorMcpRuntimeMode.Type;

// Grill mode asks the user, so threads an agent starts or changes never run in it.
export const OrchestratorMcpInteractionMode = Schema.Literals(["inherit", "default"]);
export type OrchestratorMcpInteractionMode = typeof OrchestratorMcpInteractionMode.Type;
/**
 * A thread's interaction mode as agents read it. Grill mode is the user's and
 * reads as default, so no agent tool schema names it (README: Grill mode).
 */
export const OrchestratorMcpThreadInteractionMode = Schema.Literal("default").pipe(
  Schema.decodeTo(
    ProviderInteractionModeLiteral,
    SchemaTransformation.transform({
      decode: (mode): typeof ProviderInteractionModeLiteral.Type => mode,
      encode: (_mode: typeof ProviderInteractionModeLiteral.Type) => "default" as const,
    }),
  ),
);

export const OrchestratorMcpTaskRole = Schema.Literals([
  "implementation",
  "research",
  "review",
  "design",
  "test",
  "general",
]);
export type OrchestratorMcpTaskRole = typeof OrchestratorMcpTaskRole.Type;

export const OrchestratorMcpDelegatedTaskStatus = Schema.Literals([
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpDelegatedTaskStatus = typeof OrchestratorMcpDelegatedTaskStatus.Type;

export const OrchestratorMcpTerminalDelegatedTaskStatus = Schema.Literals([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type OrchestratorMcpTerminalDelegatedTaskStatus =
  typeof OrchestratorMcpTerminalDelegatedTaskStatus.Type;

export const OrchestratorMcpDelegateTaskInput = Schema.Struct({
  task: OrchestratorMcpPrompt,
  target: Schema.optional(OrchestratorMcpTarget),
  title: Schema.optional(OrchestratorMcpTitle),
  role: Schema.optional(OrchestratorMcpTaskRole),
  agent: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "An agent type from orchestrator_capabilities agentTypes (built in: investigator, builder, reviewer). Its instructions go ahead of the task, and its model, role, effort and isolation apply unless target, role or isolation say otherwise.",
    }),
  ),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description:
        "'shared' (default): parent checkout. 'worktree': new prepared checkout from the parent commit, for a separate checkout or PR per child. Uncommitted edits stay out.",
    }),
  ),
  mode: Schema.optional(
    Schema.Literals(["async", "wait"]).annotate({
      description:
        "Default 'async'. 'wait' only if this turn needs the result. A question or approval ends the wait.",
    }),
  ),
  where: Schema.optional(
    Schema.Literals(["cloud"]).annotate({
      description:
        "cloud: this builder on a Cloud computer of its own (repository on GitHub). Starts on the lead's pushed branch, works on a caveman/ branch, wakes this thread by mail; always async. Omitted: here; on a Cloud computer, builders past its limit go to Cloud. Not with computerId.",
    }),
  ),
  computerId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description:
        "A Cloud computer from orchestrator_capabilities computers (kind cloud, canRunBuilder): this builder runs there, woken if suspended and paid for. As with where cloud: repository on GitHub, lead's pushed branch, caveman/ branch, wakes this thread by mail, always async. target picks harness and model among its driverKinds. Not with where.",
    }),
  ),
  timeoutMs: Schema.optional(Schema.Finite).annotate({
    description: "Mode 'wait' only. Default 10 min. A timeout does not cancel the child.",
  }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  runtimeMode: Schema.optional(
    OrchestratorMcpRuntimeMode.annotate({
      description:
        "Omit unless the user asks for a supervised child. Narrow modes pause for human approval, not read-only. Above yours is rejected.",
    }),
  ),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpDelegateTaskInput = typeof OrchestratorMcpDelegateTaskInput.Type;

// Set only on results for still-running tasks whose completion will wake the parent.
export const ORCHESTRATOR_MCP_RUNNING_TASK_NEXT =
  "Completion wakes this thread, so end your turn. Do not wait on it or poll it.";
const OrchestratorMcpRunningTaskNext = Schema.Literal(ORCHESTRATOR_MCP_RUNNING_TASK_NEXT);

export const OrchestratorMcpDelegateTaskResult = Schema.Struct({
  taskId: NodeId,
  childThreadId: ThreadId,
  childRunId: Schema.NullOr(RunId),
  childNodeId: NodeId,
  status: OrchestratorMcpDelegatedTaskStatus,
  workState: Schema.Literals(["working", "waiting_for_children", "result_available"]),
  hasPendingChildRuns: Schema.Boolean,
  latestTerminalRunId: Schema.NullOr(RunId),
  latestTerminalStatus: Schema.NullOr(OrchestratorMcpTerminalDelegatedTaskStatus),
  latestTerminalSummary: Schema.NullOr(Schema.String),
  latestTerminalResultContextTransferId: Schema.NullOr(ContextTransferId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.NullOr(Schema.String),
  /** The computer a builder runs on, when it is not this one (orchestrator_capabilities computers). */
  computerId: Schema.optional(Schema.String),
  summary: Schema.NullOr(Schema.String),
  resultContextTransferId: Schema.NullOr(ContextTransferId),
  hasPendingQuestion: Schema.Boolean.annotate({
    description:
      "A question blocks the child and ends a wait. Answer via `pending_request` on `childThreadId`, or the user does.",
  }),
  /** Only while the task's own unfinished work waits on one. */
  pendingApproval: Schema.optional(
    Schema.Struct({ requestId: RuntimeRequestId, kind: ProviderRequestKind, runId: RunId }),
  ).annotate({
    description: "Oldest pending approval. Ends a wait. Grants no approval rights.",
  }),
  waitTimedOut: Schema.Boolean.annotate({
    description: "True only on the timed-out wait call. The child keeps running.",
  }),
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
});
export type OrchestratorMcpDelegateTaskResult = typeof OrchestratorMcpDelegateTaskResult.Type;

export const OrchestratorMcpTaskStatusInput = Schema.Struct({
  taskId: NodeId,
});
export type OrchestratorMcpTaskStatusInput = typeof OrchestratorMcpTaskStatusInput.Type;

export const OrchestratorMcpTaskCancelInput = Schema.Struct({
  taskId: NodeId,
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpTaskCancelInput = typeof OrchestratorMcpTaskCancelInput.Type;

export const OrchestratorMcpTaskCancelResult = Schema.Struct({
  taskId: NodeId,
  status: Schema.Literals(["cancel_requested", "completed", "failed", "cancelled", "interrupted"]),
});
export type OrchestratorMcpTaskCancelResult = typeof OrchestratorMcpTaskCancelResult.Type;

export const OrchestratorMcpCreateThreadRequest = Schema.Struct({
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  target: Schema.optional(OrchestratorMcpTarget),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(OrchestratorMcpInteractionMode),
});
export type OrchestratorMcpCreateThreadRequest = typeof OrchestratorMcpCreateThreadRequest.Type;

export const OrchestratorMcpCreateThreadsInput = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreateThreadRequest).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(20),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpCreateThreadsInput = typeof OrchestratorMcpCreateThreadsInput.Type;

export const OrchestratorMcpCreatedThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("preparing"),
  Schema.Literal("starting"),
  OrchestratorMcpDelegatedTaskStatus,
  Schema.Literal("rolled_back"),
]);
export type OrchestratorMcpCreatedThreadStatus = typeof OrchestratorMcpCreatedThreadStatus.Type;

export const OrchestratorMcpCreatedThread = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpCreatedThreadStatus,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
});
export type OrchestratorMcpCreatedThread = typeof OrchestratorMcpCreatedThread.Type;

export const OrchestratorMcpCreateThreadsResult = Schema.Struct({
  threads: Schema.Array(OrchestratorMcpCreatedThread),
});
export type OrchestratorMcpCreateThreadsResult = typeof OrchestratorMcpCreateThreadsResult.Type;

export const OrchestratorMcpThreadStatus = Schema.Union([
  Schema.Literal("idle"),
  OrchestrationV2RunStatus,
]);
export type OrchestratorMcpThreadStatus = typeof OrchestratorMcpThreadStatus.Type;

const OrchestratorMcpProjectTarget = Schema.optional(
  ProjectId.annotate({
    description: "Project to use. Default: your thread's project. Required outside a thread.",
  }),
);

export const OrchestratorMcpThreadListInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  allProjects: Schema.optional(Schema.Boolean),
  statuses: Schema.optional(
    Schema.Array(OrchestratorMcpThreadStatus).check(Schema.isMaxLength(10)),
  ),
  titleContains: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(256))),
  settled: Schema.optional(Schema.Boolean),
  snoozed: Schema.optional(Schema.Boolean),
  includeSubagents: Schema.optional(Schema.Boolean),
  cursor: Schema.optional(NonNegativeInt),
  limit: Schema.optional(PositiveInt.check(Schema.isLessThanOrEqualTo(100))),
});
export type OrchestratorMcpThreadListInput = typeof OrchestratorMcpThreadListInput.Type;

/** A pull request linked to a thread; `state` is null until the host has been read. */
export const OrchestratorMcpThreadPullRequest = Schema.Struct({
  ...ThreadPullRequestKey.fields,
  url: TrimmedNonEmptyString,
  source: ThreadPullRequestLinkSource,
  state: Schema.NullOr(PullRequestState),
});
export type OrchestratorMcpThreadPullRequest = typeof OrchestratorMcpThreadPullRequest.Type;

export const OrchestratorMcpThreadListItem = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: OrchestratorMcpThreadInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  /** Missing on older servers. */
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  /** When a snoozed thread wakes; null when it is not snoozed. */
  snoozedUntil: Schema.NullOr(IsoDateTime),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  itemCount: NonNegativeInt,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadListItem = typeof OrchestratorMcpThreadListItem.Type;

export const OrchestratorMcpThreadListResult = Schema.Struct({
  /** null with `allProjects`. */
  projectId: Schema.NullOr(ProjectId),
  /** The calling thread, or null when the caller is not a T3 thread. */
  currentThreadId: Schema.NullOr(ThreadId),
  threads: Schema.Array(OrchestratorMcpThreadListItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
  total: NonNegativeInt,
});
export type OrchestratorMcpThreadListResult = typeof OrchestratorMcpThreadListResult.Type;

// Codex hides `minimum` and `maximum` from the model, so a value above the maximum clamps on
// decode instead of failing the call; pagination returns the rest. Values below 1 still fail:
// 0 asks for nothing, and answering it with one item would be a different request.
const clampedPositiveInt = (maximum: number) =>
  PositiveInt.pipe(
    Schema.decodeTo(
      PositiveInt.check(Schema.isLessThanOrEqualTo(maximum)),
      SchemaTransformation.transform({
        decode: (value) => Math.min(value, maximum),
        encode: (value) => value,
      }),
    ),
  );

export const OrchestratorMcpThreadReadInput = Schema.Struct({
  threadId: ThreadId,
  itemId: Schema.optional(TurnItemId),
  textOffset: Schema.optional(NonNegativeInt),
  view: Schema.optional(Schema.Literals(["messages", "activity"])),
  afterPosition: Schema.optional(NonNegativeInt),
  limit: Schema.optional(clampedPositiveInt(100)).annotate({
    description: "Max items, 1 to 100.",
  }),
  runLimit: Schema.optional(clampedPositiveInt(50)).annotate({
    description: "Max recent runs, 1 to 50.",
  }),
  maxCharsPerItem: Schema.optional(clampedPositiveInt(50_000)).annotate({
    description: "Max chars per item, 1 to 50000.",
  }),
});
export type OrchestratorMcpThreadReadInput = typeof OrchestratorMcpThreadReadInput.Type;

export const OrchestratorMcpThreadDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  status: OrchestratorMcpThreadStatus,
  latestRunId: Schema.NullOr(RunId),
  activeRunId: Schema.NullOr(RunId),
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  runtimeMode: RuntimeMode,
  interactionMode: OrchestratorMcpThreadInteractionMode,
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  /** Missing on older servers. */
  pullRequests: Schema.optional(Schema.Array(OrchestratorMcpThreadPullRequest)),
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  branch: Schema.NullOr(Schema.String),
  worktreePath: Schema.NullOr(Schema.String),
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: Schema.NullOr(Schema.Literals(["fork", "subagent"])),
  runCount: NonNegativeInt,
  itemCount: NonNegativeInt,
  pendingRequestCount: NonNegativeInt,
  archived: Schema.Boolean,
  settled: Schema.Boolean,
  settledAt: Schema.NullOr(IsoDateTime),
  snoozed: Schema.Boolean,
  /** When a snoozed thread wakes; null when it is not snoozed. */
  snoozedUntil: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadDetail = typeof OrchestratorMcpThreadDetail.Type;

export const OrchestratorMcpThreadRun = Schema.Struct({
  runId: RunId,
  ordinal: PositiveInt,
  status: OrchestrationV2RunStatus,
  providerInstanceId: ProviderInstanceId,
  model: Schema.String,
  requestedAt: IsoDateTime,
  startedAt: Schema.NullOr(IsoDateTime),
  completedAt: Schema.NullOr(IsoDateTime),
});
export type OrchestratorMcpThreadRun = typeof OrchestratorMcpThreadRun.Type;

export const OrchestratorMcpThreadTimelineItem = Schema.Struct({
  position: NonNegativeInt,
  visibility: Schema.Literals(["local", "inherited", "synthetic"]),
  sourceThreadId: ThreadId,
  senderThreadId: Schema.optional(ThreadId),
  inReplyTo: Schema.optional(MessageId),
  itemId: TurnItemId,
  subagentId: Schema.optional(NodeId),
  runId: Schema.NullOr(RunId),
  messageId: Schema.NullOr(MessageId),
  createdBy: Schema.NullOr(OrchestrationV2Actor),
  creationSource: Schema.NullOr(OrchestrationV2CreationSource),
  type: Schema.String,
  status: OrchestrationV2TurnItemStatus,
  title: Schema.NullOr(Schema.String),
  text: Schema.NullOr(Schema.String),
  textTruncated: Schema.Boolean,
  nextTextOffset: Schema.optional(Schema.NullOr(NonNegativeInt)),
  updatedAt: IsoDateTime,
});
export type OrchestratorMcpThreadTimelineItem = typeof OrchestratorMcpThreadTimelineItem.Type;

export const OrchestratorMcpThreadReadResult = Schema.Struct({
  thread: OrchestratorMcpThreadDetail,
  recentRuns: Schema.Array(OrchestratorMcpThreadRun),
  items: Schema.Array(OrchestratorMcpThreadTimelineItem),
  nextPosition: Schema.NullOr(NonNegativeInt),
  hasMore: Schema.Boolean,
});
export type OrchestratorMcpThreadReadResult = typeof OrchestratorMcpThreadReadResult.Type;

export const OrchestratorMcpThreadSendInput = Schema.Struct({
  threadId: ThreadId,
  message: OrchestratorMcpPrompt,
  mode: Schema.optional(Schema.Literals(["auto", "queue", "steer", "restart"])),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
  expectReply: Schema.optional(Schema.Boolean).annotate({
    description: "Ask a question; the receiver's answer comes back to this thread.",
  }),
  inReplyTo: Schema.optional(MessageId).annotate({
    description: "The message_id of the <thread_message> this answers.",
  }),
});
export type OrchestratorMcpThreadSendInput = typeof OrchestratorMcpThreadSendInput.Type;

export const OrchestratorMcpThreadSendResult = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  runId: RunId,
  /** Fresh task for a follow-up to an app-owned child; the previous task stays terminal. */
  taskId: Schema.optional(NodeId),
  status: OrchestrationV2RunStatus,
  delivery: Schema.Literals(["started", "queued", "steered", "restarted"]),
});
export type OrchestratorMcpThreadSendResult = typeof OrchestratorMcpThreadSendResult.Type;

export const OrchestratorMcpThreadWaitInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  timeoutMs: Schema.optional(Schema.Finite),
});
export type OrchestratorMcpThreadWaitInput = typeof OrchestratorMcpThreadWaitInput.Type;

export const OrchestratorMcpThreadWaitResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: OrchestratorMcpThreadStatus,
  timedOut: Schema.Boolean,
  next: Schema.optional(OrchestratorMcpRunningTaskNext),
});
export type OrchestratorMcpThreadWaitResult = typeof OrchestratorMcpThreadWaitResult.Type;

export const OrchestratorMcpThreadInterruptInput = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.optional(RunId),
  reason: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpThreadInterruptInput = typeof OrchestratorMcpThreadInterruptInput.Type;

export const OrchestratorMcpThreadInterruptResult = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  status: Schema.Union([
    Schema.Literal("interrupt_requested"),
    Schema.Literal("no_active_run"),
    Schema.Literals(["completed", "failed", "cancelled", "interrupted", "rolled_back"]),
  ]),
});
export type OrchestratorMcpThreadInterruptResult = typeof OrchestratorMcpThreadInterruptResult.Type;

export const OrchestratorMcpCapabilitiesInput = Schema.Struct({
  search: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(200)).annotate({
      description: "Match model ids and labels. Replaces the short list.",
    }),
  ),
});
export type OrchestratorMcpCapabilitiesInput = typeof OrchestratorMcpCapabilitiesInput.Type;

export const OrchestratorMcpModelOption = Schema.Struct({
  id: Schema.String,
  values: Schema.Array(ProviderOptionSelectionValue),
  default: Schema.optional(ProviderOptionSelectionValue),
});
export type OrchestratorMcpModelOption = typeof OrchestratorMcpModelOption.Type;

export const OrchestratorMcpProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driverKind: ProviderDriverKind,
  displayName: Schema.NullOr(Schema.String),
  models: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      /** Omitted when it only restates the id. */
      label: Schema.optional(Schema.String),
      /** Model options a target may select (for example reasoning effort): ids and allowed values. */
      options: Schema.optional(Schema.Array(OrchestratorMcpModelOption)),
    }),
  ),
  /** Models left out of `models`: unlisted visible models, or matches past the cap with `search`. */
  omittedModels: Schema.optional(NonNegativeInt),
  /** Runtime modes the provider offers; omitted when it offers all of them. */
  runtimeModes: Schema.optional(Schema.Array(RuntimeMode)),
  canRunChildTask: Schema.Boolean,
  canRunCrossProviderChildTask: Schema.Boolean,
  constraints: Schema.Array(Schema.String),
});
export type OrchestratorMcpProviderCapability = typeof OrchestratorMcpProviderCapability.Type;

/** A computer a builder may run on: this one, or one of the person's Caveman Cloud computers. */
export const OrchestratorMcpComputer = Schema.Struct({
  /** For kind cloud, what delegate_task computerId takes. */
  id: Schema.String,
  name: Schema.String,
  kind: Schema.Literals(["this", "cloud"]),
  os: Schema.Literals(["macos", "linux", "windows"]),
  /** asleep: work sent to it wakes it, when the plan or credits pay for its time. */
  state: Schema.Literals(["awake", "asleep", "starting", "failed"]),
  /** The harnesses (provider driverKind) a builder may run there. */
  driverKinds: Schema.Array(Schema.String),
  canRunBuilder: Schema.Boolean,
});
export type OrchestratorMcpComputer = typeof OrchestratorMcpComputer.Type;

export const OrchestratorMcpCapabilitiesResult = Schema.Struct({
  /** The calling thread, or null when the caller is not a T3 thread. */
  parentThreadId: Schema.NullOr(ThreadId),
  /** The calling thread's selection, or null when the caller is not a T3 thread. */
  inheritedProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  inheritedModel: Schema.NullOr(Schema.String),
  runtimeMode: RuntimeMode,
  interactionMode: OrchestratorMcpThreadInteractionMode,
  providers: Schema.Array(OrchestratorMcpProviderCapability),
  features: Schema.Struct({
    appOwnedSubagents: Schema.Boolean,
    asyncPolling: Schema.Boolean,
    cancellation: Schema.Boolean,
    batchThreadCreation: Schema.Boolean,
    threadManagement: Schema.Boolean,
    incrementalThreadRead: Schema.Boolean,
    scheduledTasks: Schema.Boolean,
    maxBatchThreads: Schema.Number,
  }),
  /** Agent types delegate_task's `agent` names: the project's and the user's agent files, Space plugins', and the built-ins. */
  agentTypes: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, description: Schema.String }))),
  /** Where a Caveman Code chat's builders may run (delegate_task computerId): this computer first. Absent for a caller that starts none. */
  computers: Schema.optional(Schema.Array(OrchestratorMcpComputer)),
  /** Why no Cloud computer is listed (signed out of Caveman Cloud, Cloud computers off, Cloud unreachable), or why one listed takes no builder. */
  computersNote: Schema.optional(Schema.String),
});
export type OrchestratorMcpCapabilitiesResult = typeof OrchestratorMcpCapabilitiesResult.Type;

export const OrchestratorMcpScheduleTaskInput = Schema.Struct({
  projectId: OrchestratorMcpProjectTarget,
  prompt: OrchestratorMcpPrompt,
  schedule: OrchestratorMcpSchedule,
  title: Schema.optional(OrchestratorMcpTitle),
  enabled: Schema.optional(Schema.Boolean.annotate({ description: "Default true." })),
  /**
   * When true (the default), the scheduled task fires into the calling thread
   * on each run instead of launching a fresh thread. This is the recurring
   * "wake up in this thread" behaviour reserved for agent-created tasks.
   */
  bindToCurrentThread: Schema.optional(
    Schema.Boolean.annotate({
      description: "Default true: runs post in this thread. False: new thread per run.",
    }),
  ),
  where: Schema.optional(
    Schema.Literals(["here", "cloud"]).annotate({
      description:
        "Default 'here': this computer, which must be awake. 'cloud': a Cloud computer of its own runs it, this computer off or not; each run's answer wakes this thread. It waits for the person's Allow in the app: say so and end your turn.",
    }),
  ),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type OrchestratorMcpScheduleTaskInput = typeof OrchestratorMcpScheduleTaskInput.Type;

/** `schedule_task` creates a task, or updates one when `scheduledTaskId` is given. */
export const OrchestratorMcpSaveScheduledTaskInput = Schema.Struct({
  ...OrchestratorMcpScheduleTaskInput.fields,
  scheduledTaskId: Schema.optional(ScheduledTaskId),
  prompt: Schema.optional(OrchestratorMcpPrompt),
  schedule: Schema.optional(OrchestratorMcpSchedule),
});
export type OrchestratorMcpSaveScheduledTaskInput =
  typeof OrchestratorMcpSaveScheduledTaskInput.Type;

/** Summary of a scheduled task returned by the schedule/list tools. */
export const OrchestratorMcpScheduledTask = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  projectId: ProjectId,
  boundThreadId: Schema.NullOr(ThreadId),
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  /** For webhook tasks: the public T3 Connect URL. Absent when this environment has no managed tunnel. */
  webhookUrl: Schema.optional(Schema.String).annotate({
    description:
      "Public URL for the sender. Absent: this runtime has no public tunnel.",
  }),
  webhookSignature: Schema.optional(Schema.Literals(["none", "set"])),
  /** Present on a Cloud schedule: it runs on a Cloud computer of its own. */
  where: Schema.optional(Schema.Literal("cloud")),
  /** A Cloud schedule's state: awaiting_approval until the person allows it in the app. */
  status: Schema.optional(Schema.Literals(["awaiting_approval", "starting", "active", "failed"])),
});
export type OrchestratorMcpScheduledTask = typeof OrchestratorMcpScheduledTask.Type;

export const OrchestratorMcpScheduleTaskResult = OrchestratorMcpScheduledTask;
export type OrchestratorMcpScheduleTaskResult = typeof OrchestratorMcpScheduleTaskResult.Type;

export const OrchestratorMcpListScheduledTasksInput = Schema.Struct({
  projectId: Schema.optional(
    ProjectId.annotate({
      description: "Default: your thread's project, or all outside a thread.",
    }),
  ),
});
export type OrchestratorMcpListScheduledTasksInput =
  typeof OrchestratorMcpListScheduledTasksInput.Type;

export const OrchestratorMcpListScheduledTasksResult = Schema.Struct({
  tasks: Schema.Array(OrchestratorMcpScheduledTask),
});
export type OrchestratorMcpListScheduledTasksResult =
  typeof OrchestratorMcpListScheduledTasksResult.Type;

export const OrchestratorMcpUpdateScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  prompt: Schema.optional(OrchestratorMcpPrompt),
  title: Schema.optional(OrchestratorMcpTitle),
  schedule: Schema.optional(OrchestratorMcpSchedule),
  enabled: Schema.optional(Schema.Boolean),
  bindToCurrentThread: Schema.optional(Schema.Boolean),
});
export type OrchestratorMcpUpdateScheduledTaskInput =
  typeof OrchestratorMcpUpdateScheduledTaskInput.Type;

export const OrchestratorMcpRequestSecretInput = Schema.Struct({
  label: TrimmedNonEmptyString.annotate({
    description: "Card title, such as 'GitHub webhook secret'.",
  }),
  reason: TrimmedNonEmptyString.annotate({
    description: "What it is for and where to get it.",
  }),
  placeholder: Schema.optional(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: 60 * 60 * 1_000 })),
  ).annotate({ description: "Default 10 min." }),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId).annotate({
    description: "Retry key for this ask. New key after a timeout or cancel.",
  }),
});
export type OrchestratorMcpRequestSecretInput = typeof OrchestratorMcpRequestSecretInput.Type;

export const OrchestratorMcpRequestSecretResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("saved"),
    secretRef: SecretRef.annotate({
      description: "One-use. Pass to a tool that accepts a secretRef. You never see the value.",
    }),
    env: Schema.optional(Schema.String).annotate({
      description:
        "Also this environment variable (`$NAME`) in every command started from now on in this repository.",
    }),
  }),
  Schema.Struct({
    status: Schema.Literals(["declined", "cancelled", "timed_out"]).annotate({
      description:
        "declined: user chose not to; don't ask again. cancelled: ended with the run. timed_out: no answer in time. After cancelled or timed_out, ask again with a new `clientRequestId` only if still needed.",
    }),
    note: Schema.optional(Schema.String).annotate({ description: "What to do next." }),
  }),
]);
export type OrchestratorMcpRequestSecretResult = typeof OrchestratorMcpRequestSecretResult.Type;

export const OrchestratorMcpDeleteScheduledTaskInput = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
});
export type OrchestratorMcpDeleteScheduledTaskInput =
  typeof OrchestratorMcpDeleteScheduledTaskInput.Type;

export const OrchestratorMcpDeleteScheduledTaskResult = Schema.Struct({
  scheduledTaskId: ScheduledTaskId,
  deleted: Schema.Boolean,
});
export type OrchestratorMcpDeleteScheduledTaskResult =
  typeof OrchestratorMcpDeleteScheduledTaskResult.Type;

export class OrchestratorMcpFailure extends Schema.TaggedError<OrchestratorMcpFailure>()(
  "OrchestratorMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "parent_not_active",
      "provider_unavailable",
      "model_unavailable",
      "runtime_mode_escalation_denied",
      "interaction_mode_escalation_denied",
      "task_not_found",
      "task_not_cancellable",
      "thread_not_found",
      "run_not_found",
      "thread_not_sendable",
      "thread_not_interruptible",
      "invalid_request",
      "orchestration_error",
      "thread_credential_required",
      "target_required",
      "limit_reached",
    ]),
    message: Schema.String,
  },
) {}
