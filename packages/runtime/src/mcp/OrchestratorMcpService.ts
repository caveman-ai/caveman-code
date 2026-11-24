// ), apps/server/src/mcp/OrchestratorMcpService.ts @ ab3a3cd1.
import { createHash, randomUUID } from "node:crypto";
import * as os from "node:os";

import {
  DEFAULT_SERVER_SETTINGS,
  CommandId,
  RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2TurnItem,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpModelOption,
  type OrchestratorMcpComputer,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpInteractionMode,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpRuntimeMode,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ScheduledTask,
  ScheduledTaskId,
  ScheduledTaskSchedule,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  ProviderRequestKind,
  isOrchestrationV2WorkActive,
  resolveProjectProviderInstanceEnabled,
  SECRET_REQUEST_UNSAVED_NOTE,
} from "@caveman-app/protocol";
import { getProviderOptionCurrentValue } from "@caveman-app/shared/model";
import { runRanAfter } from "@caveman-app/shared/orchestrationV2ThreadError";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "@caveman-app/shared/threadPullRequests";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  subagentResultForRun,
  delegatedTaskProgress,
} from "@caveman-app/engine-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import { isSessionProtocolProject } from "../orchestration-v2/ProjectCommands.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PluginRegistry from "../plugins/PluginRegistry.ts";
import { agentTypePrompt, listAgentTypes, type AgentType } from "../agents/agentTypes.ts";
import { effortOf, effortOptions, onCredits, personPin, pickOrder, planModels, planServing, routeBody, routePool, SubagentAuto, variantOf, type Fallback, type RouteOutcome } from "../router/subagentAuto.ts";
import { classifyTask } from "../askModel/index.ts";
import { accountIdOf, engineIdForInstance, instanceForEngine } from "../session-protocol/projector.ts";
import { BuilderError, Builders, CLOUD_THREAD, NOT_A_LEAD, type BuilderStarted, type BuilderStatus } from "../session-protocol/builders.ts";
import { MAC_THREAD, MacMail } from "../session-protocol/macMail.ts";
import { CLOUD_SCHEDULE_ID, CloudSchedules, type CloudSchedule, type CloudScheduleError } from "../session-protocol/cloudSchedules.ts";
import type { SubagentRunner } from "@caveman-app/session-protocol";
import {
  ACTIVE_TASK_STATUSES,
  AUTOMATION_STEP_STARTS_NO_THREADS,
  DELEGATED_AGENT_STARTS_NO_THREADS,
  delegationRefusal,
  freshTokens,
  inAutomationRun,
  resolveChildSelection,
} from "./delegationPolicy.ts";
import {
  clientRuntimeModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import { ProjectSecrets, secretNameFor } from "../secrets/ProjectSecrets.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
/** The branch of a delegated agent's own worktree in a Caveman Code chat: caveman/<words of its title>-<6 hex of its command>. */
const agentBranch = (title: string, commandId: string) => {
  const slug =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/g, "") || "agent";
  return `caveman/${slug}-${createHash("sha256").update(commandId).digest("hex").slice(0, 6)}`;
};

export const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
// Events that can end a delegated task wait: the parent's task record,
// and the child's runs, nested tasks, provider background work, and questions.
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
/** A person answers the card, so a slower poll is plenty. */
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /**
   * Asks the user for a secret through a card in the calling thread and waits
   * for the answer. The value never reaches the agent: the result is a status.
   */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("caveman-code/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

/**
 * A caller's thread is live while it is not archived, runs on the caller's
 * provider instance, and has an active run or a background subagent that
 * instance started. A background subagent outlives its run and calls tools
 * with its thread's credential, which is revoked when the provider process
 * goes away.
 */
export const isLiveCallerShell = (
  shell: Pick<
    OrchestrationV2ThreadShell,
    "archivedAt" | "activeRunId" | "providerInstanceId" | "pendingBackgroundTasks"
  > | null,
  providerInstanceId: ProviderInstanceId | undefined,
) =>
  shell !== null &&
  shell.archivedAt === null &&
  shell.providerInstanceId === providerInstanceId &&
  (shell.activeRunId !== null ||
    (shell.pendingBackgroundTasks?.some(
      (task) => task.kind === "subagent" && task.providerInstanceId === providerInstanceId,
    ) ??
      false));

/**
 * Threads an agent starts over MCP are `mcp:<uuid>`, and agents often paste the
 * bare uuid. The id is never rewritten, so permission checks keyed on it still
 * hold; the miss only names a live thread the caller could read by its full id.
 */
export const threadNotFound = Effect.fn("OrchestratorMcpService.threadNotFound")(function* (
  threads: Pick<ThreadManagementService.ThreadManagementService["Service"], "getThreadShell">,
  threadId: ThreadId,
  message: string,
) {
  const prefixed = ThreadId.make(`mcp:${threadId}`);
  const shell = yield* threads.getThreadShell(prefixed).pipe(Effect.orElseSucceed(() => null));
  return yield* failure(
    "thread_not_found",
    shell === null || shell.deletedAt !== null
      ? message
      : `${message} Did you mean \`${prefixed}\`?`,
  );
});

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

// Without a reason, a Stop reads as the user's (see RunExecutionService.USER_STOP_REASON).
function agentStopReason(reason: string | undefined): string {
  return reason === undefined ? "Stopped by an agent" : `Stopped by an agent: ${reason}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * A scheduled task as an agent sees it. `mayRun` says whether the caller may
 * run it: a webhook's URL carries the secret that starts the task's runs, so
 * only such a caller sees it.
 */
function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    // A bare path is not a URL anyone can call, so agents never get one to share.
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}

const decodeStoredSchedule = Schema.decodeUnknownOption(ScheduledTaskSchedule);

/** A Cloud schedule as schedule_task and list_scheduled_tasks show it; undefined for a kind this build cannot read. */
function cloudScheduleSummary(schedule: CloudSchedule): OrchestratorMcpScheduledTask | undefined {
  const decoded = decodeStoredSchedule(schedule.schedule);
  if (decoded._tag === "None") return undefined;
  return {
    scheduledTaskId: ScheduledTaskId.make(schedule.id),
    title: schedule.title,
    prompt: schedule.prompt,
    enabled: schedule.enabled,
    projectId: ProjectId.make(schedule.projectId),
    boundThreadId: ThreadId.make(schedule.leadThreadId),
    schedule: decoded.value,
    nextRunAt: schedule.nextRunAt,
    lastRunStatus: schedule.lastStatus,
    where: "cloud",
    status: schedule.state,
  };
}

const isCloudSchedule = (id: string) => id.startsWith(CLOUD_SCHEDULE_ID);

/**
 * Large catalogs (OpenCode, Cursor, Pi) can list hundreds of models, so agents
 * get a short list by default and search for the rest. These providers have
 * small official catalogs, so all their current models are listed.
 */
const FULL_CATALOG_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "muse", "grok"]);
const LISTED_MODEL_LIMIT = 8;

/**
 * Lists visible models, keeping pinned models and limiting large catalogs by default.
 * Whole provider words select the provider; partial words filter models when any match.
 */
function listCapabilityModels(input: {
  readonly provider: ServerProvider;
  readonly preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly isPinned: (model: ServerProviderModel) => boolean;
  readonly searchTerms: ReadonlyArray<string>;
}) {
  const rank = new Map(input.preferences?.modelOrder.map((slug, index) => [slug, index]));
  const visible = input.provider.models
    .filter((model) => model.isCustom || !input.preferences?.hiddenModels.includes(model.slug))
    .toSorted((a, b) => (rank.get(a.slug) ?? rank.size) - (rank.get(b.slug) ?? rank.size));
  const { instanceId, driver, displayName } = input.provider;
  const providerText = `${instanceId} ${driver} ${displayName ?? ""}`.toLowerCase();
  // Whole ids like "codex-work" and their parts both name the provider.
  const providerWords = new Set([
    ...providerText.split(/\s+/),
    ...providerText.split(/[^\p{L}\p{N}]+/u),
  ]);
  const modelText = (model: ServerProviderModel) =>
    `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
  // Part of a provider word ("agent" in "claudeAgent") names the provider unless a model matches it.
  const modelTerms = input.searchTerms.filter(
    (term) =>
      !providerWords.has(term) &&
      (!providerText.includes(term) || visible.some((model) => modelText(model).includes(term))),
  );
  if (modelTerms.length > 0) {
    const matches = visible.filter((model) => {
      const text = modelText(model);
      return modelTerms.every((term) => text.includes(term));
    });
    const listed = matches.slice(0, LISTED_MODEL_LIMIT);
    return { listed, omitted: matches.length - listed.length };
  }
  const current = visible.filter((model) => !model.isLegacy);
  const shown = new Set(
    FULL_CATALOG_DRIVERS.has(input.provider.driver)
      ? current
      : current.slice(0, LISTED_MODEL_LIMIT),
  );
  const listed = visible.filter((model) => input.isPinned(model) || shown.has(model));
  return { listed, omitted: visible.length - listed.length };
}

/** Option ids and allowed values are all a delegating agent needs; labels are UI copy. */
function capabilityModelOption(descriptor: ProviderOptionDescriptor): OrchestratorMcpModelOption {
  const defaultValue = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    values:
      descriptor.type === "boolean" ? [false, true] : descriptor.options.map((choice) => choice.id),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

/** What the person's settings say of an Auto pool or a plan (subagentAuto.ts PoolInput): models they hid, Codex's compact login. */
const poolSettings = (settings: typeof DEFAULT_SERVER_SETTINGS) => ({
  hidden: (instanceId: string, slug: string) => settings.providerModelPreferences?.[ProviderInstanceId.make(instanceId)]?.hiddenModels.includes(slug) === true,
  chatGptLogin: (instanceId: string) => (settings.providerInstances[ProviderInstanceId.make(instanceId)]?.config as { chatGptLogin?: unknown } | undefined)?.chatGptLogin === true,
});

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  // Driver availability comes from the registry, even when health probes are skipped.
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/** thread_launch keeps a selection as given, so it can hold options its model does not have. */
function knownOptions(
  options: ReadonlyArray<ProviderOptionSelection> | undefined,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  if (options === undefined || descriptors === undefined) return options;
  return options.filter((option) => descriptors.some((descriptor) => descriptor.id === option.id));
}

/**
 * Checks requested option selections for duplicates and, when the model
 * advertises option descriptors, against those descriptors. Models without
 * descriptors skip the descriptor checks (mirroring how model slugs are only
 * validated when the provider advertises models), but duplicate ids always
 * fail: downstream consumers disagree on whether the first or last value of
 * a duplicated id wins.
 */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

export function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    // Legacy delegated-task projections predate the durable spawn transfer.
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

export function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  // Held queued runs wait for the user to resume the child; task_cancel holds them.
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

/** A task the parent has to act on now: finished, or waiting on an answer or an approval. */
function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    result.hasPendingQuestion ||
    result.pendingApproval !== undefined ||
    isTerminalTaskStatus(result.status)
  );
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

/** The oldest live approval the task's own unfinished runs wait on, if any. */
function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "nodes" | "runtimeRequests">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
) {
  const taskRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            // Legacy tasks own only their original run, not later turns in the child thread.
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"];
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    ) {
      continue;
    }
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId === undefined || runId === null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      approval = { requestId: request.id, kind: request.kind, runId };
    }
  }
  return approval;
}

/** Every task `directAppOwnedChildTasks` can return, so callers load only those. */
function directChildTaskIds(
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<NodeId> {
  const ids = new Set<NodeId>();
  if (target.thread.forkedFrom?.type === "node") ids.add(target.thread.forkedFrom.nodeId);
  for (const run of target.runs) {
    if (returnedRunIds.has(run.id) && run.delegatedTaskId !== undefined) {
      ids.add(run.delegatedTaskId);
    }
  }
  return [...ids];
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= textPageEnd(text, 0, input.maxChars);
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function runtimeModeRank(mode: RuntimeMode): number {
  switch (mode) {
    case "approval-required":
      return 0;
    case "auto-accept-edits":
      return 1;
    case "auto":
      return 2;
    case "full-access":
      return 3;
  }
}

// Grill mode grants nothing beyond default (access applies as set), so no mode is broader.
function interactionModeRank(_mode: ProviderInteractionMode): number {
  return 1;
}

/**
 * The mode a new thread runs in: the requested mode, else the parent's, never
 * broader than the parent's. Pass `target` when the thread runs on a known
 * provider. A provider runs a mode it does not offer as Supervised, so an
 * explicit request for one is refused, and an inherited one steps down to the
 * broadest mode the provider offers.
 */
export function resolveRuntimeMode(
  parentMode: RuntimeMode,
  requested: OrchestratorMcpRuntimeMode | undefined,
  target?: Pick<ResolvedTarget, "modelSelection" | "supportedRuntimeModes">,
): Effect.Effect<RuntimeMode, OrchestratorMcpFailure> {
  const inherited = requested === undefined || requested === "inherit";
  const resolved = inherited ? parentMode : requested;
  if (runtimeModeRank(resolved) > runtimeModeRank(parentMode)) {
    return Effect.fail(
      failure(
        "runtime_mode_escalation_denied",
        `Child runtime mode ${resolved} is broader than parent mode ${parentMode}.`,
      ),
    );
  }
  const supported = target?.supportedRuntimeModes;
  if (supported === undefined || supported.length === 0 || supported.includes(resolved)) {
    return Effect.succeed(resolved);
  }
  if (!inherited) {
    return Effect.fail(
      failure(
        "invalid_request",
        `Provider ${target?.modelSelection.instanceId} does not offer runtime mode ${resolved}, so it would run as approval-required. Use one of: ${supported.join(", ")}.`,
      ),
    );
  }
  return Effect.succeed(
    supported
      .filter((mode) => runtimeModeRank(mode) <= runtimeModeRank(resolved))
      .toSorted((left, right) => runtimeModeRank(right) - runtimeModeRank(left))[0] ??
      "approval-required",
  );
}

export function resolveInteractionMode(
  parentMode: ProviderInteractionMode,
  requested: OrchestratorMcpInteractionMode | ProviderInteractionMode | undefined,
): Effect.Effect<ProviderInteractionMode, OrchestratorMcpFailure> {
  // Grill mode is the user's: an agent never starts, schedules or reaches a thread in it.
  const asked = requested === undefined || requested === "inherit" ? parentMode : requested;
  const resolved = asked === "grill" ? "default" : asked;
  return interactionModeRank(resolved) > interactionModeRank(parentMode)
    ? Effect.fail(
        failure(
          "interaction_mode_escalation_denied",
          `Child interaction mode ${resolved} is broader than parent mode ${parentMode}.`,
        ),
      )
    : Effect.succeed(resolved);
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  if (detail.length <= 80) return detail;
  let end = 77;
  const previous = detail.charCodeAt(end - 1);
  const next = detail.charCodeAt(end);
  if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    end -= 1;
  }
  return `${detail.slice(0, end)}...`;
}

/** A builder's task id (session-protocol/builders.ts): its workspace, here or on a Cloud computer. */
const BUILDER_TASK = "builder:";

/** The Session Protocol engine a provider driver runs a builder on, for the drivers a Cloud computer has too. */
const BUILDER_DRIVER_ENGINES: Readonly<Record<string, string>> = { claudeAgent: "claude-agent", codex: "codex", caveman: "caveman" };

/**
 * A builder as delegate_task and task_status answer for it: always async, its result wakes the lead by itself.
 * `asked`: the provider instance delegate_task's target named.
 */
function builderTask(started: BuilderStarted, lead: ModelSelection, status?: BuilderStatus, asked?: ProviderInstanceId): OrchestratorMcpDelegateTaskResult {
  const ended = status?.state === "completed" || status?.state === "failed";
  const where =
    started.where === "here" ? "in a worktree on this computer" : started.computerName !== undefined ? `on Cloud computer ${started.computerName}` : "on a Cloud computer of its own";
  return {
    taskId: NodeId.make(`${BUILDER_TASK}${started.workspaceId}`),
    childThreadId: ThreadId.make(started.threadId ?? `${CLOUD_THREAD}${started.workspaceId}`),
    childRunId: null,
    childNodeId: NodeId.make(`${BUILDER_TASK}${started.workspaceId}`),
    status: status?.state ?? "running",
    workState: ended ? "result_available" : "working",
    hasPendingChildRuns: false,
    latestTerminalRunId: null,
    latestTerminalStatus: ended ? (status!.state as "completed" | "failed") : null,
    latestTerminalSummary: ended ? (status!.summary ?? null) : null,
    latestTerminalResultContextTransferId: null,
    // The builder's own. Here: the instance asked for, else the lead's when it runs the lead's engine, else that
    // engine's. On another computer, that engine's default instance: this computer's accounts are not there.
    providerInstanceId:
      started.where === "here"
        ? (asked ?? (started.engine === engineIdForInstance(lead.instanceId) ? lead.instanceId : ProviderInstanceId.make(instanceForEngine(started.engine))))
        : ProviderInstanceId.make(instanceForEngine(started.engine)),
    model: started.model ?? null,
    ...(started.where === "cloud" && started.computerId ? { computerId: started.computerId } : {}),
    summary:
      status?.summary ??
      `Builder "${started.title}" runs ${where} (workspace ${started.workspaceId}). Its result wakes this thread when it finishes; end your turn instead of polling.`,
    resultContextTransferId: null,
    hasPendingQuestion: false,
    waitTimedOut: false,
  };
}

function taskPrompt(input: OrchestratorMcpDelegateTaskInput): string {
  return input.role === undefined || input.role === "general"
    ? input.task
    : `Act as the ${input.role} sub-agent for this task.\n\n${input.task}`;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

/** The same links `list_thread_pull_requests` reports, without the snapshot details. */
function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

function listItemFromShell(
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    // From the shell, like the list, so read and list agree on snooze state.
    ...threadSnooze(shell, nowMs),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
      return item.message;
    case "system_notice":
      return item.compressionRetrieveStatus === undefined ? item.message : null;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

/** A cut inside a surrogate pair would leave half an emoji on each page. */
function textPageEnd(text: string | null, offset: number, maxChars: number): number {
  const end = offset + maxChars;
  if (text === null || end >= text.length) return end;
  const last = text.charCodeAt(end - 1);
  if (last < 0xd800 || last > 0xdbff) return end;
  return end - 1 > offset ? end - 1 : end + 1;
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = textPageEnd(text, offset, input.maxChars);
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    runId: input.row.item.runId,
    messageId,
    ...(input.row.item.type === "user_message" && message?.senderThreadId !== undefined
      ? {
          senderThreadId: message.senderThreadId,
          ...(message.inReplyTo === undefined ? {} : { inReplyTo: message.inReplyTo }),
        }
      : {}),
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const random = yield* SecureRandom.SecureRandom;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const pluginRegistry = yield* Effect.serviceOption(PluginRegistry.PluginRegistry);
  const subagentAuto = yield* Effect.serviceOption(SubagentAuto);
  // A Caveman Code lead's builders (session-protocol/builders.ts), when the Session Protocol route runs here.
  const builders = yield* Effect.serviceOption(Builders);
  // Mail to a chat on another of the person's Macs (session-protocol/macMail.ts), when the Session Protocol route runs here.
  const macMail = yield* Effect.serviceOption(MacMail);
  // Schedules that run on Cloud (session-protocol/cloudSchedules.ts), beside this computer's scheduled tasks.
  const cloudSchedules = yield* Effect.serviceOption(CloudSchedules);
  const cloudScheduleFailure = (error: CloudScheduleError) =>
    failure(error.reason === "not_found" ? "task_not_found" : error.reason === "invalid_request" ? "invalid_request" : "orchestration_error", error.message);
  const requireCloudSchedules = Option.isNone(cloudSchedules)
    ? failure("invalid_request", "Schedules on Cloud need the Caveman Code app's runtime.")
    : Effect.succeed(cloudSchedules.value);
  const cloudSummary = (schedule: CloudSchedule) =>
    Effect.suspend(() => {
      const summary = cloudScheduleSummary(schedule);
      return summary === undefined ? failure("orchestration_error", `Cloud schedule ${schedule.id} has a schedule this build cannot read.`) : Effect.succeed(summary);
    });
  // This computer as orchestrator_capabilities names it.
  const environment = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);

  /** A project that exists, whoever owns it. */
  const readProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  /** A caller-named project, which must exist before anything is recorded against it. */
  const requireProject = (projectId: ProjectId) =>
    readProject(projectId).pipe(
      Effect.flatMap((project) =>
        // Ours: work started here would be invisible to Caveman Code, which owns these projects.
        isSessionProtocolProject(project.id)
          ? Effect.fail(
              failure(
                "invalid_request",
                `Project ${projectId} belongs to Caveman Code sessions; Use workspace tools to start work in it.`,
              ),
            )
          : Effect.succeed(project),
      ),
    );

  /** A client has no thread to inherit a model from, so it falls back to the project default. */
  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);
  const secretRequests = yield* SecretRequests.SecretRequests;
  // Where the Session Protocol runs: an answered request is also a repository env var (16-SECRETS.md).
  const projectSecrets = yield* Effect.serviceOption(ProjectSecrets);

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadThreadRecords = <K extends ProjectionRecordField>(
    threadId: ThreadId,
    fields: ReadonlyArray<K>,
    filter?: ProjectionRecordFilter,
  ) =>
    threadManagement
      .getThreadRecords(threadId, fields, filter)
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjection = (threadId: ThreadId, includeUserMessages = true) =>
    loadThreadRecords(
      threadId,
      [
        "runs",
        "messages",
        "providerThreads",
        "providerTurns",
        "runtimeRequests",
        "contextTransfers",
        "turnItems",
      ],
      { turnItemTypes: [], messageRoles: includeUserMessages ? ["user"] : [] },
    );

  // A dispatcher thread holds thousands of tasks, each with its full prompt; read only the ones named.
  const loadTasks = (threadId: ThreadId, taskIds: ReadonlyArray<NodeId>) =>
    threadManagement.getThreadRecords(threadId, ["subagents"], { subagentIds: taskIds }).pipe(
      Effect.map(({ subagents }) => subagents),
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read thread ${threadId}: ${errorMessage(error)}`),
      ),
    );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  /**
   * The caller's own thread and the most it may hand to threads it targets. A
   * thread caller is capped by its own modes; an OAuth client by the ceiling
   * chosen when it was approved.
   */
  const loadCaller = (scope: McpInvocationScope) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      if (scope.thread === undefined) {
        return {
          parent: undefined,
          limits: {
            runtimeMode: clientRuntimeModeCeiling(scope.client),
            interactionMode: "default",
          } satisfies { runtimeMode: RuntimeMode; interactionMode: ProviderInteractionMode },
        } as const;
      }
      // No loadCaller consumer reads the caller's own prompts, and a long thread has thousands.
      const parent = yield* loadProjection(scope.thread.threadId, false);
      return {
        parent,
        limits: {
          runtimeMode: parent.thread.runtimeMode,
          interactionMode: parent.thread.interactionMode,
        },
      } as const;
    });

  /** The caller's own thread, for operations that act as the caller. */
  const loadThreadCaller = (scope: McpInvocationScope, operation: string) =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      const threadScope = yield* requireThreadScope(scope, operation);
      const parent = yield* loadProjection(threadScope.thread.threadId);
      return { scope: threadScope, parent } as const;
    });

  /** A target project: the one passed, else the calling thread's. */
  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a Caveman Code thread.",
            ),
          );

  /** Any live thread in the environment. */
  const loadTargetThread = (threadId: ThreadId, includeHistory = true) =>
    Effect.gen(function* () {
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (shell === null || shell.deletedAt !== null) {
        return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
      }
      // A wait reads its own history; this keeps the legacy import and project check.
      return yield* includeHistory
        ? loadProjectThread(shell.projectId, threadId)
        : threadManagement
            .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [])
            .pipe(Effect.mapError(threadManagementFailure));
    });

  const loadScopedThread = (scope: McpInvocationScope, threadId: ThreadId, includeHistory = true) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller(scope);
      const target =
        caller.parent !== undefined && threadId === caller.parent.thread.id
          ? caller.parent
          : yield* loadTargetThread(threadId, includeHistory);
      return { ...caller, target } as const;
    });

  /**
   * A thread caller writes to another thread only while its own run is live,
   * so a credential that outlived its session cannot reach across threads.
   */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  /** Scheduled work outside the caller's own project needs the same live run. */
  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return threadManagement.getThreadShell(parent.thread.id).pipe(
        Effect.mapError(threadManagementFailure),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(notActive)
      : Effect.void;
  };

  const loadReadableThread = (scope: McpInvocationScope, threadId: ThreadId) =>
    Effect.gen(function* () {
      const { parent } = yield* loadCaller(scope);
      const shell = yield* threadManagement
        .getThreadShell(threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      if (shell === null || shell.deletedAt !== null) {
        return yield* threadNotFound(
          threadManagement,
          threadId,
          `Thread ${threadId} is no longer available.`,
        );
      }
      const input = { projectId: shell.projectId, threadId };
      // Transfers are needed only to acknowledge a caller's child-task result.
      const records =
        parent === undefined
          ? threadManagement
              .getProjectThreadRecords(input, ["runs", "runtimeRequests"])
              .pipe(Effect.map((target) => ({ ...target, contextTransfers: [] })))
          : threadManagement.getProjectThreadRecords(input, [
              "runs",
              "runtimeRequests",
              "contextTransfers",
            ]);
      const target = yield* records.pipe(Effect.mapError(threadManagementFailure));
      return { parent, target, shell } as const;
    });

  const loadProviders = providerRegistry.getProviders;

  // One delegation at a time per root thread, from the limit check to the dispatch, so agents in one
  // tree delegating at once cannot all pass the concurrency limit.
  // ponytail: one lock per root thread ever delegated from, never dropped; a few bytes each.
  const delegationLocks = new Map<string, Semaphore.Semaphore>();
  const delegationLock = (rootThreadId: string) => {
    let lock = delegationLocks.get(rootThreadId);
    if (lock === undefined) delegationLocks.set(rootThreadId, (lock = Semaphore.makeUnsafe(1)));
    return lock;
  };

  /** Agent types a thread may delegate to: its checkout's, the user's, enabled Space plugins', then the built-ins. */
  const agentTypesFor = (thread: Pick<OrchestrationV2ThreadProjection["thread"], "worktreePath" | "projectId">) =>
    Effect.gen(function* () {
      // An unreadable project or plugin list still leaves the user's and the built-in types.
      const project = yield* projects.getById(thread.projectId).pipe(Effect.map(Option.getOrUndefined), Effect.catchCause(() => Effect.succeed(undefined)));
      const pluginAgentFiles = Option.isSome(pluginRegistry)
        ? yield* pluginRegistry.value.known.pipe(
            Effect.map((known) => known.plugins.filter((p) => p.enabled).flatMap((p) => p.plugin.agents.map((agent) => agent.path))),
            Effect.catchCause(() => Effect.succeed([])),
          )
        : [];
      return yield* Effect.promise(() => listAgentTypes({ projectRoot: thread.worktreePath ?? project?.workspaceRoot, home: os.homedir(), pluginAgentFiles }));
    });

  /** This computer's name: its environment's label, else the machine's. */
  const thisComputerName = Option.isNone(environment)
    ? Effect.succeed(os.hostname())
    : environment.value.getDescriptor.pipe(
        Effect.map((descriptor) => descriptor.label),
        Effect.catchCause(() => Effect.succeed(os.hostname())),
      );

  /**
   * Where a thread's builders may run (orchestrator_capabilities computers): this computer first, with the harnesses
   * that run a child task here, then the person's Cloud computers, which Builders asks Cloud for (never failing).
   */
  const computersFor = (scope: McpInvocationScope, threadId: string, providers: ReadonlyArray<ServerProvider>, capable: ReadonlySet<string>) =>
    Effect.gen(function* () {
      const here: OrchestratorMcpComputer = {
        // Its Cloud computer id when signed in, as Cloud and the person's other computers know it.
        id: (Option.isSome(builders) ? builders.value.thisComputer() : undefined) ?? scope.environmentId,
        name: yield* thisComputerName,
        kind: "this",
        os: process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux",
        state: "awake",
        driverKinds: [...new Set(providers.filter((p) => providerConstraints(p, capable.has(p.instanceId)).length === 0).map((p) => p.driver))],
        canRunBuilder: true,
      };
      const elsewhere = Option.isSome(builders) ? yield* builders.value.computers(threadId) : { computers: [], note: NOT_A_LEAD };
      return { computers: [here, ...elsewhere.computers], note: elsewhere.note };
    });

  /**
   * For Settings > Subagents' limits: how deep the caller is (its delegated ancestors), and across
   * everything delegated under its root thread, how many agents work now and the tokens they used.
   */
  const delegationTree = (thread: Pick<OrchestrationV2ThreadProjection["thread"], "lineage">) =>
    Effect.gen(function* () {
      let callerDepth = 0;
      let lineage = thread.lineage;
      while (lineage.relationshipToParent === "subagent" && lineage.parentThreadId !== null && callerDepth < 16) {
        callerDepth += 1;
        const shell = yield* threadManagement.getThreadShell(lineage.parentThreadId).pipe(Effect.mapError(threadManagementFailure));
        if (shell === null) break;
        lineage = shell.lineage;
      }
      let running = 0;
      let tokens = 0;
      const seen = new Set<string>();
      const queue = [thread.lineage.rootThreadId];
      // ponytail: one read per delegated thread in the tree on every delegation; an index if trees get large.
      while (queue.length > 0 && seen.size < 512) {
        const threadId = queue.shift()!;
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        const records = yield* threadManagement.getThreadRecords(threadId, ["subagents", "providerTurns"]).pipe(Effect.mapError(threadManagementFailure));
        if (threadId !== thread.lineage.rootThreadId) tokens += freshTokens(records.providerTurns ?? []);
        for (const task of records.subagents) {
          if (task.origin !== "app_owned" || task.childThreadId === null) continue;
          if (ACTIVE_TASK_STATUSES.has(task.status)) running += 1;
          queue.push(task.childThreadId);
        }
      }
      // A Caveman Code lead's builders are chats of their own, not T3 tasks: the same limits count them (P4).
      if (Option.isSome(builders)) {
        const mine = yield* builders.value.tree(thread.lineage.rootThreadId);
        running += mine.running;
        // Its builders on other computers: what each last said it has used.
        tokens += mine.tokens;
        for (const threadId of mine.threadIds) {
          if (seen.has(threadId)) continue;
          seen.add(threadId);
          const records = yield* threadManagement.getThreadRecords(ThreadId.make(threadId), ["providerTurns"]).pipe(Effect.orElseSucceed(() => ({ providerTurns: [] })));
          tokens += freshTokens(records.providerTurns ?? []);
        }
      }
      return { callerDepth, running, tokens };
    });

  /**
   * An agent's message to a delegated agent with no task at work sets it working again, and the orchestrator
   * records that as a new delegated task (recordSubagentFollowup), so Settings > Agents' limits apply as if its
   * parent delegated again. Run under the root's delegation lock together with the send, as delegate_task's check is.
   */
  const followupLimits = (child: Pick<OrchestrationV2ThreadProjection["thread"], "id" | "lineage">, commandId: CommandId) =>
    Effect.gen(function* () {
      const parentThreadId = child.lineage.parentThreadId;
      if (child.lineage.relationshipToParent !== "subagent" || parentThreadId === null) return;
      // A retry of an accepted send starts nothing new.
      if (yield* threadManagement.hasReceipt(commandId)) return;
      const { subagents } = yield* threadManagement.getThreadRecords(parentThreadId, ["subagents"]).pipe(Effect.mapError(threadManagementFailure));
      // At work on a task already: the message joins or follows that counted work.
      if (subagents.some((task) => task.origin === "app_owned" && task.childThreadId === child.id && ACTIVE_TASK_STATUSES.has(task.status))) return;
      const limits = yield* serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.subagents),
        Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.subagents),
      );
      const tree = yield* delegationTree(child);
      const refusal = delegationRefusal(limits, { ...tree, callerDepth: tree.callerDepth - 1 });
      if (refusal !== undefined) return yield* failure("limit_reached", refusal);
    });

  /**
   * Instance ids the adapter registry resolves — the same lookup a
   * `delegated_task.request` performs when it runs. Capability reporting and
   * target resolution must not advertise a set narrower (or wider) than what
   * dispatch can actually serve.
   */
  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /**
   * A child below full access never runs on an engine that can't ask before acting: it would take no approval at all
   * (Cursor reviews its own steps), so a parent kept below full (by the person, or an outside agent's level) would
   * reach past it. A target whose capabilities can't be read is left as before.
   */
  const assertChildAsks = (runtimeMode: RuntimeMode, target: ResolvedTarget) =>
    runtimeMode === "full-access"
      ? Effect.void
      : providerAdapters.get(target.modelSelection.instanceId).pipe(
          Effect.flatMap((adapter) => adapter.getCapabilities()),
          Effect.catchCause(() => Effect.succeed(undefined)),
          Effect.flatMap((caps) =>
            caps !== undefined && !caps.approvals.supportsCommandApproval && !caps.approvals.supportsFileChangeApproval
              ? Effect.fail(
                  failure(
                    "runtime_mode_escalation_denied",
                    `${target.modelSelection.instanceId} can't ask before acting, so a child on it would run without approvals under a parent running ${runtimeMode}. Pick a target that asks first.`,
                  ),
                )
              : Effect.void,
          ),
        );

  /**
   * Provider snapshots only re-probe while a client is in the foreground, so an
   * unattended agent can see a provider as unavailable after it was fixed.
   * Re-probe the requested instance once before refusing it.
   */
  const assertTargetEnabledForProject = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /**
     * Skips the per-candidate project-enablement check in driver-only
     * resolution. Set only when the command that will dispatch this target
     * already has a receipt: that dispatch can only replay the recorded
     * result, never start anything new, so filtering candidates by the
     * project's current settings would just refuse a retry that does no new
     * work. Never set this for a resolution whose dispatch uses a different
     * command id than the one checked for a receipt.
     */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.Effect<ResolvedTarget, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const requestedInstanceId = input.target?.providerInstanceId;
      const requestedDriver = input.target?.driverKind;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      let instanceId = requestedInstanceId;

      if (instanceId === undefined && requestedDriver !== undefined) {
        const candidates = input.providers.filter(
          (provider) =>
            provider.driver === requestedDriver &&
            orchestrationCapableInstanceIds.has(provider.instanceId),
        );
        if (candidates.length === 0) {
          return yield* failure(
            "provider_unavailable",
            `No V2 provider adapter is registered for driver ${requestedDriver}.`,
          );
        }
        // Inherit the parent's instance only when it can actually serve the
        // child; an unavailable parent yields to a healthy instance of the
        // requested driver rather than failing the delegation. An instance
        // the project turned off cannot serve either, so selection skips it
        // for the next candidate instead of failing the enablement check.
        const healthyCandidates = candidates.filter(
          (candidate) => providerConstraints(candidate, true).length === 0,
        );
        const inheritedCandidate = healthyCandidates.find(
          (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
        );
        const orderedCandidates = [
          ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
          ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
        ];
        for (const candidate of orderedCandidates) {
          const enabledForProject =
            input.skipProjectEnablementFilter === true ||
            (yield* threadManagement.isProviderInstanceEnabledForProject({
              projectId: input.parent.thread.projectId,
              instanceId: candidate.instanceId,
            }));
          if (enabledForProject) {
            instanceId = candidate.instanceId;
            break;
          }
        }
        if (instanceId === undefined) {
          return yield* failure(
            "provider_unavailable",
            healthyCandidates.length === 0
              ? `No available V2 provider instance for driver ${requestedDriver}.`
              : `No instance of driver ${requestedDriver} is enabled for this project.`,
          );
        }
      }
      instanceId ??= input.parent.thread.modelSelection.instanceId;

      const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
      if (provider === undefined) {
        return yield* failure(
          "provider_unavailable",
          `Provider instance ${instanceId} is not registered.`,
        );
      }
      if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
        return yield* failure(
          "invalid_request",
          `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
        );
      }
      const constraints = providerConstraints(
        provider,
        orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (constraints.length > 0) {
        return yield* failure(
          "provider_unavailable",
          `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
        );
      }

      const inheritedSelection = input.parent.thread.modelSelection;
      const requestedModel = input.target?.model;
      const model =
        requestedModel ??
        (instanceId === inheritedSelection.instanceId
          ? inheritedSelection.model
          : provider?.models[0]?.slug);
      if (model === undefined) {
        return yield* failure(
          "model_unavailable",
          `Provider ${instanceId} has no model available for inheritance.`,
        );
      }
      if (
        requestedModel !== undefined &&
        provider !== undefined &&
        provider.models.length > 0 &&
        !provider.models.some((candidate) => candidate.slug === requestedModel)
      ) {
        return yield* failure(
          "model_unavailable",
          `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
        );
      }

      const descriptors = provider.models.find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors;
      const requestedOptions = input.target?.options;
      if (requestedOptions !== undefined) {
        const invalid = invalidOptionSelections(requestedOptions, descriptors);
        if (invalid.length > 0) {
          return yield* failure(
            "invalid_request",
            `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
          );
        }
      }

      // Options inherit only for the same instance and model. Requested entries override single values
      // (so asking for one effort keeps the inherited fast mode), and an empty list clears them.
      const inheritsOptions =
        instanceId === inheritedSelection.instanceId && model === inheritedSelection.model;
      // An inherited option the target model has no descriptor for would be refused downstream.
      let options = inheritsOptions
        ? knownOptions(inheritedSelection.options, descriptors)
        : undefined;
      if (requestedOptions !== undefined) {
        const selections = new Map(
          (requestedOptions.length === 0 ? [] : (options ?? [])).map((selection) => [
            selection.id,
            selection,
          ]),
        );
        for (const selection of requestedOptions) {
          selections.set(selection.id, selection);
        }
        options = [...selections.values()];
      }
      return {
        modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
        supportedRuntimeModes: provider.supportedRuntimeModes,
      };
    });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined ? random.uuidV4() : Effect.succeed(clientRequestId);

  const readTask = (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      yield* requireCapability(scope);
      // Task waits read on every wake of a parent that may hold thousands of tasks and
      // messages, so read only the watched task and what its status and acknowledgement use.
      const parentThreadId = scope.thread.threadId;
      const parentProjection = yield* threadManagement
        .getThreadRecords(parentThreadId, ["runs", "subagents", "contextTransfers"], {
          subagentIds: [taskId],
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to read thread ${parentThreadId}: ${errorMessage(error)}`,
            ),
          ),
        );
      const task = parentProjection.subagents.find(
        (candidate) =>
          candidate.id === taskId &&
          candidate.origin === "app_owned" &&
          candidate.threadId === scope.thread.threadId,
      );
      if (task === undefined || task.childThreadId === null) {
        return yield* failure(
          "task_not_found",
          `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
        );
      }
      const childControls = yield* threadManagement
        .getThreadRecords(
          task.childThreadId,
          [
            "runs",
            "messages",
            "contextTransfers",
            "subagents",
            "providerThreads",
            "runtimeRequests",
            "nodes",
          ],
          // Progress reads only active or undelivered tasks under the child.
          { messageRoles: ["user"], omitSettledLeafNodes: true, omitSettledSubagents: true },
        )
        .pipe(Effect.mapError(threadManagementFailure));
      const childRun = delegatedTaskRun(childControls, task);
      const terminalRun = latestTerminalResultRun(childControls, childRun);
      const progress = delegatedTaskProgress(childControls);
      const taskResultRun =
        childRun?.delegatedTaskId === task.id
          ? childControls.runs
              .filter((run) => run.delegatedTaskId === task.id)
              .toSorted((a, b) => b.ordinal - a.ordinal)[0]
          : progress.resultRun;
      const taskWorkState =
        childRun?.delegatedTaskId === task.id
          ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
            ? "result_available"
            : "working"
          : progress.state;
      const resultRunIds = [
        ...new Set(
          [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
        ),
      ];
      const resultRecords = yield* threadManagement
        .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
          messageRoles: ["assistant"],
          messageRunIds: resultRunIds,
          turnItemRunIds: resultRunIds,
          turnItemTypes: ["assistant_message", "error"],
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const childProjection = {
        ...childControls,
        messages: [...childControls.messages, ...resultRecords.messages],
        turnItems: resultRecords.turnItems,
      };
      // A restart cut the child's run and its continuation has not settled, or
      // the child started working again after this read.
      const heldForRestart =
        task.result === null &&
        taskWorkState === "result_available" &&
        (yield* threadManagement
          .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
          .pipe(Effect.mapError(threadManagementFailure)));
      const workState =
        task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
      const status =
        task.result !== null
          ? taskStatusForRun(
              task.status === "completed" ||
                task.status === "failed" ||
                task.status === "cancelled" ||
                task.status === "interrupted"
                ? { status: task.status }
                : childRun,
            )
          : workState === "result_available"
            ? taskStatusForRun(taskResultRun ?? childRun)
            : taskStatusForRun(taskResultRun ?? childRun) === "queued"
              ? "queued"
              : "running";
      const derivedResult =
        task.result !== null
          ? task.result
          : taskResultRun !== undefined && isTerminalTaskStatus(status)
            ? subagentResultForRun(childProjection, taskResultRun).text
            : null;
      const resultTransfers = parentProjection.contextTransfers.filter(
        (transfer) =>
          transfer.type === "subagent_result" &&
          transfer.sourceThreadId === task.childThreadId &&
          transfer.targetThreadId === scope.thread.threadId,
      );
      const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
        !canExposeTaskRunResult(run)
          ? null
          : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
            (run.id === childRun?.id
              ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
              : undefined) ??
            null);
      const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
      const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
      const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
        ? terminalRun.id === childRun?.id
          ? derivedResult
          : subagentResultForRun(childProjection, terminalRun).text
        : null;
      const resultContextTransferId = resultTransfer?.id ?? null;
      const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
      const result = {
        taskId: task.id,
        childThreadId: task.childThreadId,
        childRunId: childRun?.id ?? null,
        childNodeId: task.id,
        status,
        workState,
        hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
        providerInstanceId: task.providerInstanceId,
        model: task.model,
        summary: derivedResult,
        resultContextTransferId,
        latestTerminalRunId: terminalRun?.id ?? null,
        latestTerminalStatus:
          terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
        latestTerminalSummary:
          latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
        latestTerminalResultContextTransferId:
          latestTerminalResultContextTransferId === resultContextTransferId
            ? null
            : latestTerminalResultContextTransferId,
        // A finished task has no question of its own; later child runs belong to other tasks.
        hasPendingQuestion:
          !isTerminalTaskStatus(status) &&
          childControls.runtimeRequests.some(
            (request) =>
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type === "live",
          ),
        ...(isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? {}
          : (() => {
              const approval = pendingTaskApproval(childControls, task.id, childRun);
              return approval === undefined ? {} : { pendingApproval: approval };
            })()),
        waitTimedOut,
      } satisfies OrchestratorMcpDelegateTaskResult;
      const response: OrchestratorMcpDelegateTaskResult =
        endsTaskWait(result) || task.completionDelivery?.state === "disposed"
          ? result
          : { ...result, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT };
      if (
        acknowledgeTerminal &&
        isTerminalTaskStatus(status) &&
        task.completionDelivery?.state !== "acknowledged" &&
        task.completionDelivery?.state !== "disposed"
      ) {
        const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
        const acknowledgementRequestKey = yield* requestKey(undefined);
        yield* threadManagement
          .dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: stableCommandId({
              scope,
              requestKey: acknowledgementRequestKey,
              operation: acknowledgementOperation,
            }),
            parentThreadId: scope.thread.threadId,
            taskId,
            observedByRunId:
              observingRun?.providerInstanceId === scope.thread.providerInstanceId
                ? observingRun.id
                : null,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
      }
      return response;
    });

  // Re-read the task only when an event on the parent or child thread can
  // change its status, instead of polling the projections every 50 ms.
  const waitForTask = (scope: McpThreadInvocationScope, taskId: NodeId, timeoutMs: number) =>
    Effect.gen(function* () {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // Sequences are global, so one cursor taken before the first read
      // replays anything either thread records after it.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      return yield* Stream.mergeAll(
        TASK_WAKE_EVENTS.map(({ thread, eventType }) =>
          threadManagement
            .streamStoredEventsFrom({
              threadId: thread === "parent" ? scope.thread.threadId : initial.childThreadId,
              afterSequence,
              eventType,
            })
            .pipe(
              // A sibling task's update on the parent never changes this task's status.
              Stream.filter(
                ({ event }) =>
                  thread === "child" ||
                  event.type !== "subagent.updated" ||
                  event.payload.id === taskId,
              ),
            ),
        ),
        { concurrency: "unbounded" },
      ).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter(endsTaskWait),
        Stream.runHead,
      );
    }).pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten));

  /**
   * The modes a task's runs execute at: its own, or for a task bound to a
   * thread, also that thread's modes as they are now, since its runs are
   * messages to that thread.
   */
  const refExists = (cwd: string, revision: string) =>
    gitDriver.resolveCommit({ cwd, revision }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  /** The branch a scheduled task's worktree starts from: the remote's default, else main or master. */
  const resolveScheduledTaskBaseRef = (cwd: string) =>
    Effect.gen(function* () {
      const remoteName = yield* gitDriver
        .resolvePrimaryRemoteName(cwd)
        .pipe(Effect.orElseSucceed(() => null));
      const conventional = ["main", "master"];
      if (remoteName !== null) {
        const remoteDefault = yield* gitDriver
          .resolveDefaultBranchName(cwd, remoteName)
          .pipe(Effect.orElseSucceed(() => null));
        // Fetch does not update a recorded HEAD, so it can outlive the branch it names.
        for (const branch of remoteDefault === null
          ? conventional
          : [remoteDefault, ...conventional]) {
          // Launch resolves a bare name through a local branch's upstream, or else assumes `origin`.
          if (yield* refExists(cwd, `refs/remotes/${remoteName}/${branch}`)) {
            return `${remoteName}/${branch}`;
          }
        }
      }
      // Local-only repositories, or a remote with neither a usable HEAD nor a conventional branch.
      for (const branch of conventional) {
        if (yield* refExists(cwd, `refs/heads/${branch}`)) return branch;
      }
      return "main";
    });

  /**
   * Workspace strategy for a scheduled task created/updated over MCP: bound runs
   * post into the existing thread (the strategy is unused, keep root); unbound
   * runs launch a fresh worktree per run from the repository's default branch.
   */
  const scheduledTaskWorkspaceStrategy = (boundToThread: boolean, projectId: ProjectId) =>
    Effect.gen(function* () {
      if (boundToThread) return { type: "root" as const };
      const { workspaceRoot } = yield* requireProject(projectId);
      return {
        type: "worktree" as const,
        baseRef: yield* resolveScheduledTaskBaseRef(workspaceRoot),
        startFromOrigin: true,
      };
    });

  const scheduledTaskRunModes = (task: ScheduledTask) =>
    Effect.gen(function* () {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    });

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * A task as the caller may see it. Its webhook URL starts runs, so only a
   * caller that may start one sees it: never a client approved for read-only
   * access, and a thread caller only with a live turn, at modes covering every
   * mode the task runs at.
   */
  const summarizeScheduledTask = (
    scope: McpInvocationScope,
    caller: {
      readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
      readonly limits: {
        readonly runtimeMode: RuntimeMode;
        readonly interactionMode: ProviderInteractionMode;
      };
    },
    task: ScheduledTask,
  ) =>
    Effect.gen(function* () {
      const live =
        caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      // This runs after a save, so a failed lookup of the bound thread hides
      // the webhook URL instead of reporting a saved task as an error.
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    });

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.Effect<ScheduledTask, OrchestratorMcpFailure> =>
    Effect.gen(function* () {
      const { tasks } = yield* scheduledTasks
        .list()
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
          ),
        );
      const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
      if (task === undefined) {
        return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
      }
      for (const modes of yield* scheduledTaskRunModes(task)) {
        yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
        yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
      }
      return task;
    });

  return OrchestratorMcpService.of({
    scheduleTask: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        if (input.where === "cloud") {
          // It runs as a builder of this chat's on a Cloud computer, and each run wakes this chat.
          if (parent === undefined)
            return yield* failure("invalid_request", "A Cloud schedule wakes the chat that set it, so it needs an agent running in a Caveman Code chat.");
          if (input.bindToCurrentThread === false)
            return yield* failure("invalid_request", "A Cloud schedule's runs always come back to this chat; leave bindToCurrentThread out.");
          if (input.projectId !== undefined && input.projectId !== parent.thread.projectId)
            return yield* failure("invalid_request", "A Cloud schedule runs on this chat's repository; leave projectId out.");
          if (input.enabled === false) return yield* failure("invalid_request", "A Cloud schedule starts once the person allows it; leave enabled out.");
          const service = yield* requireCloudSchedules;
          const firstLine = input.prompt.split("\n")[0]?.trim() ?? "";
          const created = yield* service
            .create({
              threadId: parent.thread.id,
              title: input.title ?? (firstLine.length > 0 ? firstLine.slice(0, 80) : "Scheduled task"),
              prompt: input.prompt,
              schedule: input.schedule as unknown as Record<string, unknown>,
              requestKey:
                input.clientRequestId === undefined
                  ? `mcp:${randomUUID()}`
                  : stableCommandId({ scope, requestKey: input.clientRequestId, operation: "schedule-task-cloud" }),
              by: "agent",
            })
            .pipe(Effect.mapError(cloudScheduleFailure));
          return yield* cloudSummary(created);
        }
        const projectId = yield* resolveProjectTarget(parent, input.projectId);
        yield* assertLiveCallerForOtherProject(scope, parent, projectId);
        const project = yield* requireProject(projectId);
        // Binding means "wake this thread", which only a thread caller in that project has.
        const bindToCurrentThread =
          input.bindToCurrentThread ??
          (parent !== undefined && parent.thread.projectId === projectId);
        if (
          bindToCurrentThread &&
          (parent === undefined || parent.thread.projectId !== projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a Caveman Code thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const modelSelection =
          parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
        const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
        const title =
          input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
        const upsertInput: ScheduledTaskUpsertInput = {
          title,
          prompt: input.prompt,
          enabled: input.enabled ?? true,
          schedule: input.schedule,
          projectId,
          threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
          workspaceStrategy: yield* scheduledTaskWorkspaceStrategy(bindToCurrentThread, projectId),
          modelSelection,
          runtimeMode: limits.runtimeMode,
          interactionMode: yield* resolveInteractionMode(limits.interactionMode, "inherit"),
          createdBy: "agent",
          creationSource: "mcp",
          // Scope the idempotency key by provider session so two callers
          // reusing the same clientRequestId cannot collide on one task row.
          ...(input.clientRequestId === undefined
            ? {}
            : {
                commandId: stableCommandId({
                  scope,
                  requestKey: input.clientRequestId,
                  operation: "schedule-task",
                }),
              }),
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not schedule task: ${error.message}`),
            ),
          );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      }),
    listScheduledTasks: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        const onCloud = Option.isNone(cloudSchedules) ? [] : yield* cloudSchedules.value.list();
        return {
          tasks: [
            ...(yield* Effect.forEach(
              tasks.filter((task) => projectId === undefined || task.projectId === projectId),
              (task) => summarizeScheduledTask(scope, { parent, limits }, task),
            )),
            ...onCloud.flatMap((schedule) => {
              const summary = projectId === undefined || schedule.projectId === projectId ? cloudScheduleSummary(schedule) : undefined;
              return summary === undefined ? [] : [summary];
            }),
          ],
        };
      }),
    updateScheduledTask: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        if (isCloudSchedule(input.scheduledTaskId)) {
          const service = yield* requireCloudSchedules;
          const existing = yield* service.get(input.scheduledTaskId);
          if (existing === undefined) return yield* failure("task_not_found", `Scheduled task ${input.scheduledTaskId} was not found.`);
          yield* assertLiveCallerForOtherProject(scope, parent, ProjectId.make(existing.projectId));
          if (input.bindToCurrentThread !== undefined)
            return yield* failure("invalid_request", "A Cloud schedule's runs always come back to the chat that set it.");
          const updated = yield* service
            .update(
              existing.id,
              {
                ...(input.title === undefined ? {} : { title: input.title }),
                ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
                ...(input.schedule === undefined ? {} : { schedule: input.schedule as unknown as Record<string, unknown> }),
                ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
              },
              "agent",
            )
            .pipe(Effect.mapError(cloudScheduleFailure));
          return yield* cloudSummary(updated);
        }
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a Caveman Code thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Rebinding changes where runs execute, so the workspace strategy must
        // follow: unbinding a root-strategy task would otherwise run loose
        // prompts in the shared project checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : yield* scheduledTaskWorkspaceStrategy(input.bindToCurrentThread, existing.projectId);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      }),
    deleteScheduledTask: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        if (isCloudSchedule(input.scheduledTaskId)) {
          const service = yield* requireCloudSchedules;
          const existing = yield* service.get(input.scheduledTaskId);
          if (existing === undefined) return yield* failure("task_not_found", `Scheduled task ${input.scheduledTaskId} was not found.`);
          yield* assertLiveCallerForOtherProject(scope, parent, ProjectId.make(existing.projectId));
          yield* service.remove(existing.id).pipe(Effect.mapError(cloudScheduleFailure));
          return { scheduledTaskId: input.scheduledTaskId, deleted: true };
        }
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      }),
    requestSecret: (scope, input) =>
      Effect.gen(function* () {
        // The card is shown in, and answered from, the caller's own thread.
        const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "request_secret");
        const threadId = threadScope.thread.threadId;
        const run = ThreadManagementService.latestActiveRun(parent);
        if (
          run === undefined ||
          run.rootNodeId === null ||
          run.providerInstanceId !== threadScope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Asking for a secret requires an active run owned by this MCP provider session.",
          );
        }
        const runId = run.id;
        const nodeId = run.rootNodeId;
        const key = yield* requestKey(input.clientRequestId);
        // Turn item ids are global; scope the key to this thread. A retry with
        // the same clientRequestId finds this card, answered or not.
        const turnItemId = TurnItemId.make(
          `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
        );
        const record = (secretStatus: "pending" | "cancelled") =>
          threadManagement
            .dispatch({
              type: "secret_request.record",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `secret-${secretStatus}`,
              }),
              threadId: threadId,
              runId,
              nodeId,
              turnItemId,
              label: input.label,
              reason: input.reason,
              ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
              secretStatus,
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Could not record the secret request: ${errorMessage(error)}`,
                ),
              ),
            );
        yield* record("pending");
        // Only this call can hand the agent its ref, so the card must not
        // outlive it: a timeout, a failed wait or an aborted call closes it as
        // cancelled. If even that fails, the server still refuses an answer
        // once the run ends, and an unused value expires.
        const closeCard = record("cancelled").pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not close a secret request card", { error: error.message }),
          ),
        );

        // The user answers the card (secrets.answerRequest), or it ends with
        // the run; poll it like a delegated task.
        const answered = yield* Effect.gen(function* () {
          while (true) {
            const projection = yield* threadManagement
              .getThreadRecords(threadId, ["runs", "turnItems"], {
                turnItemTypes: ["secret_request"],
                messageRoles: [],
              })
              .pipe(
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to read the secret request: ${errorMessage(error)}`,
                  ),
                ),
              );
            const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
            if (item?.type === "secret_request" && item.secretStatus !== "pending") {
              return item.secretStatus;
            }
            const current = projection.runs.find((candidate) => candidate.id === runId);
            if (
              current === undefined ||
              ThreadManagementService.isTerminalRunStatus(current.status)
            ) {
              yield* record("cancelled");
              return "cancelled" as const;
            }
            yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
          }
        }).pipe(
          Effect.timeoutOption(
            Duration.millis(
              Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
            ),
          ),
          Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
        );
        if (Option.isNone(answered)) yield* closeCard;
        // An answer that raced the timeout still wins: the card is answered once.
        const status = Option.isSome(answered)
          ? answered.value
          : yield* threadManagement
              .getThreadRecords(threadId, ["turnItems"], {
                turnItemTypes: ["secret_request"],
                messageRoles: [],
              })
              .pipe(
                Effect.map((records) => {
                  const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
                  return item?.type === "secret_request" &&
                    (item.secretStatus === "saved" || item.secretStatus === "declined")
                    ? item.secretStatus
                    : ("timed_out" as const);
                }),
                Effect.orElseSucceed(() => "timed_out" as const),
              );
        yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
        yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
        if (status !== "saved") return { status, note: SECRET_REQUEST_UNSAVED_NOTE[status] };
        // Saved means the value was stored before the card said so; a missing
        // value is a storage fault, not an answer the agent can act on.
        const secretRef = yield* secretRequests.savedRef({ threadId: threadId, turnItemId });
        if (Option.isNone(secretRef)) {
          return yield* failure(
            "orchestration_error",
            "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
          );
        }
        // A Caveman Code client stores the answer as the repository's env var named after the label; say so, never the value.
        const env = secretNameFor(input.label);
        const project = yield* projects.getById(parent.thread.projectId).pipe(Effect.map(Option.getOrUndefined), Effect.orElseSucceed(() => undefined));
        const stored =
          Option.isSome(projectSecrets) && project !== undefined
            ? (yield* projectSecrets.value.keyOf({ path: project.workspaceRoot }).pipe(Effect.flatMap(projectSecrets.value.list), Effect.orElseSucceed(() => []))).some(
                (s) => s.name === env,
              )
            : false;
        return { status, secretRef: secretRef.value, ...(stored ? { env } : {}) };
      }).pipe(Effect.withSpan("OrchestratorMcpService.requestSecret")),

    capabilities: (scope, input = {}) =>
      Effect.gen(function* () {
        const { parent, limits } = yield* loadCaller(scope);
        const providers = yield* loadProviders;
        const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
        );
        const inherited = parent?.thread.modelSelection;
        const searchTerms = input.search?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
        // Cloud's list of computers and the agent files are read side by side: neither waits on the other.
        const [listed, agentTypes] =
          parent === undefined
            ? [undefined, undefined]
            : yield* Effect.all([computersFor(scope, parent.thread.id, providers, orchestrationCapableInstanceIds), agentTypesFor(parent.thread)], { concurrency: "unbounded" });
        // Snapshots list instances any project enables; delegate_task checks the caller's project.
        const enabledForCaller = (provider: ServerProvider) =>
          parent === undefined || resolveProjectProviderInstanceEnabled(settings, parent.thread.projectId, provider.instanceId);
        const constraintsOf = (provider: ServerProvider) =>
          providerConstraints(enabledForCaller(provider) ? provider : { ...provider, enabled: false }, orchestrationCapableInstanceIds.has(provider.instanceId));
        // A model on Caveman credits that a plan of the person's runs now is listed once, under the plan's engine:
        // delegate_task would run it on the plan anyway, and credits pay last.
        const onPlans = planModels({
          providers,
          capable: (provider) => constraintsOf(provider).length === 0,
          ...poolSettings(settings),
          now: Date.now(),
        });
        return {
          parentThreadId: parent?.thread.id ?? null,
          inheritedProviderInstanceId: inherited?.instanceId ?? null,
          inheritedModel: inherited?.model ?? null,
          runtimeMode: limits.runtimeMode,
          interactionMode: limits.interactionMode,
          providers: providers.map((provider) => {
            const constraints = constraintsOf(provider);
            // Models the user hid from pickers stay out of the catalog agents choose from.
            const { listed, omitted } = listCapabilityModels({
              provider: { ...provider, models: provider.models.filter((model) => !(onCredits(provider, model.slug) && onPlans.has(variantOf(model.slug)))) },
              preferences: settings.providerModelPreferences?.[provider.instanceId],
              searchTerms,
              isPinned: (model) =>
                model.isCustom ||
                (inherited?.instanceId === provider.instanceId && inherited.model === model.slug) ||
                (settings.favorites ?? []).some(
                  (favorite) =>
                    favorite.provider === provider.instanceId && favorite.model === model.slug,
                ),
            });
            return {
              providerInstanceId: provider.instanceId,
              driverKind: provider.driver,
              displayName: provider.displayName ?? null,
              models: listed.map((model) => {
                const options = model.capabilities?.optionDescriptors ?? [];
                return {
                  id: model.slug,
                  ...(model.name.toLowerCase() === model.slug.toLowerCase()
                    ? {}
                    : { label: model.name }),
                  ...(options.length === 0 ? {} : { options: options.map(capabilityModelOption) }),
                };
              }),
              ...(omitted === 0 ? {} : { omittedModels: omitted }),
              ...(provider.supportedRuntimeModes === undefined ||
              provider.supportedRuntimeModes.length === 0
                ? {}
                : { runtimeModes: [...provider.supportedRuntimeModes] }),
              canRunChildTask: constraints.length === 0,
              canRunCrossProviderChildTask: constraints.length === 0,
              constraints: [...constraints],
            };
          }),
          features: {
            appOwnedSubagents: true,
            asyncPolling: true,
            cancellation: true,
            batchThreadCreation: true,
            threadManagement: true,
            incrementalThreadRead: true,
            scheduledTasks: true,
            maxBatchThreads: 20,
          },
          ...(agentTypes === undefined ? {} : { agentTypes: agentTypes.map(({ name, description }) => ({ name, description })) }),
          ...(listed === undefined ? {} : { computers: listed.computers, ...(listed.note === undefined ? {} : { computersNote: listed.note }) }),
        };
      }),
    delegateTask: (callerScope, input) =>
      Effect.gen(function* () {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
        const parentRun = parent.runs
          .filter(ThreadManagementService.isActiveRun)
          .toSorted((left, right) => right.ordinal - left.ordinal)[0];
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Delegated tasks require an active run owned by this MCP provider session.",
          );
        }
        // An automation step's delegates finish inside its turn: its tree always waits, as long as a wait may last
        // (the runner closes the step thread's family when the step ends, so nothing outlives it).
        const automationTree = inAutomationRun(parent.thread);
        const mode = automationTree ? "wait" : input.mode;
        const providers = yield* loadProviders;
        // Computed before resolving the target so a retry of an already
        // accepted delegation can be recognized: dispatching under the same
        // command id only replays the recorded result, so candidate
        // selection must not refuse it over the project's current settings.
        const key = yield* requestKey(input.clientRequestId);
        const commandId = stableCommandId({
          scope,
          requestKey: key,
          operation: "delegate-task",
        });
        const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
        const subagentSettings = yield* serverSettings.getSettings.pipe(
          Effect.map((settings) => settings.subagents),
          Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS.subagents),
        );
        // A retry of an accepted delegation starts nothing new, so the limits never refuse it.
        // Checked under the tree's lock together with the dispatch (below).
        const checkLimits = Effect.gen(function* () {
          if (isRetryOfAcceptedDelegation) return;
          const refusal = delegationRefusal(subagentSettings, yield* delegationTree(parent.thread));
          if (refusal !== undefined) return yield* failure("limit_reached", refusal);
        });
        let agentType: AgentType | undefined;
        if (input.agent !== undefined) {
          const types = yield* agentTypesFor(parent.thread);
          agentType = types.find((type) => type.name === input.agent);
          if (agentType === undefined) {
            return yield* failure("invalid_request", `No agent type named ${input.agent}. Known: ${types.map((type) => type.name).join(", ")}.`);
          }
        }
        const role = input.role ?? agentType?.role ?? "general";
        if (input.where !== undefined && input.computerId !== undefined) return yield* failure("invalid_request", "Name computerId or where, not both.");
        // This computer's own id (orchestrator_capabilities lists it first) runs the task here, as without one.
        const thisComputer = Option.isSome(builders) ? builders.value.thisComputer() : undefined;
        const computerId = input.computerId === scope.environmentId || input.computerId === thisComputer ? undefined : input.computerId;
        const elsewhere = input.where === "cloud" || computerId !== undefined;
        const lead = parent.thread.modelSelection;
        const leadPinned = input.target?.providerInstanceId !== undefined || input.target?.driverKind !== undefined || input.target?.model !== undefined;
        const resolveOr = (target: OrchestratorMcpTarget | undefined) =>
          resolveTargetRechecking({ parent, target, providers, skipProjectEnablementFilter: isRetryOfAcceptedDelegation });
        // What a pin or Auto may pick: on for this project, and offering the runtime mode the child gets
        // (asked for, else the parent's) without stepping it down.
        const wantedMode = input.runtimeMode === undefined || input.runtimeMode === "inherit" ? parent.thread.runtimeMode : input.runtimeMode;
        const modeFits = (supported: ReadonlyArray<string> | undefined) => supported === undefined || supported.length === 0 || supported.includes(wantedMode);
        const enabledHere = new Map<string, boolean>();
        const enabledForProject = (instanceId: string) =>
          enabledHere.has(instanceId)
            ? Effect.succeed(enabledHere.get(instanceId)!)
            : threadManagement.isProviderInstanceEnabledForProject({ projectId: parent.thread.projectId, instanceId: ProviderInstanceId.make(instanceId) }).pipe(
                Effect.orElseSucceed(() => false),
                Effect.tap((on) => Effect.sync(() => enabledHere.set(instanceId, on))),
              );
        /** A pin's or Auto's target, when it resolves and can run here; else nothing, and the next rung decides. */
        const runnable = (target: OrchestratorMcpTarget) =>
          Effect.gen(function* () {
            const resolved = Option.getOrUndefined(yield* resolveOr(target).pipe(Effect.option));
            if (resolved === undefined || !modeFits(resolved.supportedRuntimeModes)) return undefined;
            return (yield* enabledForProject(resolved.modelSelection.instanceId)) ? resolved : undefined;
          });
        /** What a pin, Auto or a plan may run on here: no orchestrator constraint, on for this project, the child's mode. */
        const runsHere = Effect.gen(function* () {
          const capable = yield* loadOrchestrationCapableInstanceIds();
          for (const p of providers) yield* enabledForProject(p.instanceId);
          return (p: ServerProvider) =>
            providerConstraints(p, capable.has(p.instanceId)).length === 0 && enabledHere.get(p.instanceId) === true && modeFits(p.supportedRuntimeModes);
        });
        // The lead named a model on Caveman credits that one of the person's plans runs now (orchestrator_capabilities
        // folds such duplicates away, but a lead may still name one): the child runs on the plan, at the effort asked.
        // Who pays is the runtime's call, never the prompt's; credits pay last. A retry keeps what it started on. Only
        // for a child that runs here: a builder on another computer is told an engine and a model, not this Mac's
        // logins, so its credits stay as named and its own runtime decides there.
        let leadTarget = input.target;
        if (leadPinned && !isRetryOfAcceptedDelegation && !elsewhere) {
          // Resolved without a fresh probe: an unavailable target is refused (and probed once) by the path below.
          const named = Option.getOrUndefined(yield* resolveTarget({ parent, target: input.target, providers }).pipe(Effect.option));
          const namedProvider = named === undefined ? undefined : providers.find((p) => p.instanceId === named.modelSelection.instanceId);
          if (named !== undefined && namedProvider !== undefined && onCredits(namedProvider, named.modelSelection.model)) {
            const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS));
            const plan = planServing({ providers, capable: yield* runsHere, ...poolSettings(settings), now: Date.now() }, named.modelSelection.model);
            if (plan !== undefined) {
              const planModel = providers.find((p) => p.instanceId === plan.instanceId)?.models.find((m) => m.slug === plan.model);
              const options = effortOptions(planModel, effortOf(named.modelSelection.options));
              leadTarget = { providerInstanceId: ProviderInstanceId.make(plan.instanceId), model: plan.model, ...(options === undefined ? {} : { options }) };
            }
          }
        }
        /**
         * Auto's pick for this delegation, a builder's as much as a child's: the connected options go to Cloud with
         * the brief, and one of them comes back, with an effort. `kept`: Cloud kept the caller's own selection, or
         * there was nothing to pick from. A fallback says why Cloud was not the one that picked.
         */
        const autoPick = (fallbackModel: string) =>
          Effect.gen(function* () {
            let picked: ResolvedTarget | undefined;
            let fallback: Fallback | undefined;
            let outcome: RouteOutcome | undefined;
            /** How many connected options Auto sent Cloud. */
            let options: number | undefined;
            let kept = false;
            if (Option.isNone(subagentAuto)) fallback = "cloud_unlinked";
            else {
              // A refused delegation never spends a (billed) route decision.
              yield* checkLimits;
              // Local reads (the key store, the model catalog) get their own time box.
              const local = yield* subagentAuto.value.connected.pipe(Effect.timeoutOption("2 seconds"));
              const key = Option.isSome(local) ? local.value.key : undefined;
              if (Option.isNone(local)) fallback = "cloud_error";
              else if (key === undefined) fallback = "cloud_unlinked";
              else {
                const capable = yield* runsHere;
                const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => DEFAULT_SERVER_SETTINGS));
                // The brief leaves the machine: no repository secret in it.
                const scrub = Option.isSome(projectSecrets) ? yield* projectSecrets.value.scrubber.pipe(Effect.option) : Option.none();
                const brief = Option.isSome(scrub) ? scrub.value.scrub(input.task) : input.task;
                const { pool, targets } = routePool({
                  providers,
                  capable,
                  cavemanConnected: local.value.caveman,
                  ...poolSettings(settings),
                  now: Date.now(),
                });
                if (pool.length > 0) options = pool.length;
                const answer =
                  pool.length === 0
                    ? ({ kind: "default" } as const)
                    : yield* subagentAuto.value.ask(key, routeBody(fallbackModel, { kind: role, agent: agentType?.name, brief }, pool), targets);
                if (answer.kind === "fallback") fallback = answer.reason;
                else {
                  outcome = answer.outcome;
                  if (answer.kind === "pick") {
                    const model = providers.find((p) => p.instanceId === answer.target.instanceId)?.models.find((m) => m.slug === answer.target.model);
                    picked = yield* runnable({ providerInstanceId: ProviderInstanceId.make(answer.target.instanceId), model: answer.target.model, options: effortOptions(model, answer.effort) });
                    if (picked === undefined) [fallback, outcome] = ["cloud_error", undefined];
                  } else {
                    // Nothing to pick from, or Cloud kept the lead's selection.
                    kept = true;
                  }
                }
              }
            }
            return { picked, fallback, outcome, options, kept };
          });
        // The person's pin in Settings > Subagents (personPin): the named role's, the brief's task kind's, general's;
        // counted only when a provider here still lists its model. The classifier gets 5 s, its first load included.
        const { pin, task: taskKind } = yield* Effect.promise(() =>
          personPin({
            role,
            rolePins: subagentSettings.rolePins,
            taskPins: subagentSettings.taskPins,
            classify: async () => (await Promise.race([classifyTask(input.task), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000).unref())]))?.kind,
          }),
        );
        const pinModel = pin === undefined ? undefined : providers.find((p) => p.instanceId === pin.instanceId)?.models.find((m) => m.slug === pin.model);
        // A pin marked always outranks the lead's own pick; one that can't run now leaves it.
        const pinAlways = pinModel !== undefined && pin?.always === true;
        // A Caveman Code lead's builder: on a Cloud computer a workspace of its own in a worktree there, or past the
        // computer's limit (and anywhere with where "cloud") a Cloud computer of its own, or the Cloud computer named.
 // Undefined: upstream child below.
        if (Option.isSome(builders) && ((input.isolation ?? agentType?.isolation) === "worktree" || elsewhere)) {
          // The harness by the instance's driver (a second Codex instance is Codex), else as its id or driver kind reads.
          const asked = leadTarget?.providerInstanceId;
          const engineOf = (instance: string | undefined, kind: string | undefined) => {
            const driver = instance !== undefined ? providers.find((p) => p.instanceId === instance)?.driver : kind;
            const harness = instance ?? kind;
            return driver !== undefined && BUILDER_DRIVER_ENGINES[driver] !== undefined ? BUILDER_DRIVER_ENGINES[driver] : harness !== undefined ? engineIdForInstance(harness) : undefined;
          };
          let engine = engineOf(asked, leadTarget?.driverKind) ?? agentType?.engine;
          let model = leadTarget?.model;
          // Who picks a builder's engine and model is who picks any delegation's (subagentAuto.ts pickOrder): a pin
          // marked always, the lead's target, an agent type's engine, the person's pin, Auto where that is the default,
          // else the lead's own.
          // A builder is a chat of its own, so a pin or Auto may put it on another engine than its lead's. A retry of
          // one that started is that builder: nothing is picked, and no route decision is spent.
          const nothingNamed = !leadPinned && agentType?.engine === undefined;
          if ((pinAlways || nothingNamed) && !isRetryOfAcceptedDelegation) {
            let chosen: ResolvedTarget | undefined;
            // A pin that can't run now (signed out, removed) gives way to Auto, never a refused delegation.
            if (pin !== undefined && pinModel !== undefined) chosen = yield* runnable({ providerInstanceId: ProviderInstanceId.make(pin.instanceId), model: pin.model });
            if (chosen === undefined && nothingNamed && subagentSettings.defaultModel === "auto") chosen = (yield* autoPick(lead.model)).picked;
            if (chosen !== undefined) {
              const picked = engineOf(chosen.modelSelection.instanceId, undefined);
              // An engine no builder runs on (an ACP agent's) leaves the lead's.
              if (picked !== undefined) [engine, model] = [picked, chosen.modelSelection.model];
            }
          }
 // Under the tree's lock with the limits, as upstream child is: a builder and a child racing never both take the
          // last place. The limits run inside start, once it knows the delegation is new (admit).
          const started = yield* delegationLock(parent.thread.lineage.rootThreadId)
            .withPermits(1)(
              builders.value.start({
                parentThreadId: scope.thread.threadId,
                task: agentType === undefined ? taskPrompt(input) : agentTypePrompt(agentType, input.task),
                title: input.title,
                engine,
                model,
                where: input.where,
                computerId,
                requestKey: commandId,
                admit: checkLimits.pipe(Effect.mapError((error) => new BuilderError({ reason: "limit_reached", message: error.message }))),
              }),
            )
            .pipe(Effect.mapError((error) => failure(error.reason === "unavailable" ? "orchestration_error" : error.reason, error.message)));
          if (started !== undefined) return builderTask(started, parent.thread.modelSelection, undefined, asked !== undefined && started.engine === engine ? asked : undefined);
        }
 // upstream child runs on this computer: never in place of the one asked for.
        if (elsewhere) return yield* failure("invalid_request", `${NOT_A_LEAD} This thread's delegated tasks run on this computer: leave out where and computerId.`);
        // An agent type's `engine:`, as automation steps honor it: unless the lead picked a target, its child runs on
        // that engine's instance (its default instance first). An engine that can't run a child here leaves the lead's.
        const typeEngine = agentType?.engine;
        let typeInstance: ProviderInstanceId | undefined;
        if (typeEngine !== undefined && !leadPinned && engineIdForInstance(lead.instanceId) !== typeEngine) {
          const own = providers
            .filter((p) => engineIdForInstance(p.instanceId) === typeEngine)
            .toSorted((a, b) => Number(b.instanceId === instanceForEngine(typeEngine)) - Number(a.instanceId === instanceForEngine(typeEngine)));
          for (const p of own) {
            if ((yield* runnable({ providerInstanceId: p.instanceId })) === undefined) continue;
            typeInstance = p.instanceId;
            break;
          }
        }
        const baseTarget: OrchestratorMcpTarget | undefined = typeInstance === undefined ? leadTarget : { ...leadTarget, providerInstanceId: typeInstance };
        // Without a Cloud pick, use the person's configured model, else inherit the lead's selection.
        // Another engine's child takes only an exact model id from its type; on the type's own engine a class
        // anchors on that engine's model, as a step's does.
        const sameEngine = (baseTarget?.providerInstanceId ?? (baseTarget?.driverKind === undefined ? lead.instanceId : undefined)) === lead.instanceId;
        const childProvider = providers.find((provider) => provider.instanceId === (baseTarget?.providerInstanceId ?? lead.instanceId));
        const childModel =
          leadTarget?.model !== undefined
            ? undefined
            : typeInstance !== undefined
              ? resolveChildSelection({ provider: childProvider, parentModel: childProvider?.models[0]?.slug ?? lead.model, sameEngine: true, wanted: agentType?.model })
              : resolveChildSelection({ provider: childProvider, parentModel: lead.model, sameEngine, wanted: agentType?.model });
        // Who picks (subagentAuto.ts pickOrder): the lead's target, the person's pin, Cloud, the lead's selection.
        // An agent type's model counts only when it resolved on the child's provider; its engine always counts.
        const typeModel = agentType?.model !== undefined && agentType.model !== "inherit" && childModel !== undefined;
        const typePicked = typeModel || typeInstance !== undefined;
        let by = pickOrder({
          leadPinned,
          agentTypeModel: typePicked,
          pinned: pinModel !== undefined,
          pinAlways,
          defaultModel: subagentSettings.defaultModel,
        });
        let picked: ResolvedTarget | undefined;
        let fallback: Fallback | undefined;
        let outcome: RouteOutcome | undefined;
        /** How many connected options Auto sent Cloud. */
        let options: number | undefined;
        /** The person's pin ran this child: only then does its task kind go on the runner. */
        let pinRan = false;
        if (by === "user" && (!typePicked || pinAlways) && pin !== undefined) {
          // A pin that can't run now (signed out, removed) gives way to the lead's pick, else Auto, never a refused
          // delegation. The lead's effort went with the lead's model: an always pin over it runs at its own.
          picked = yield* runnable({ providerInstanceId: ProviderInstanceId.make(pin.instanceId), model: pin.model, options: effortOptions(pinModel, pin.effort) ?? (leadPinned ? undefined : leadTarget?.options) });
          if (picked === undefined) by = leadPinned ? "lead" : subagentSettings.defaultModel === "auto" ? "auto" : "default";
          else pinRan = true;
        }
        if (by === "auto" && !isRetryOfAcceptedDelegation) {
          const auto = yield* autoPick(childModel ?? parent.thread.modelSelection.model);
          [picked, fallback, outcome, options] = [auto.picked, auto.fallback, auto.outcome, auto.options];
          if (fallback !== undefined || auto.kept) by = "default";
        }
        let target = picked ?? (yield* resolveOr(childModel === undefined ? baseTarget : { ...baseTarget, model: childModel }));
        // An agent type's effort (Claude Code's `effort` field) where nothing else picked one: not Auto, a pin
        // or the lead's options. A level the model doesn't offer leaves the inherited one.
        if (picked === undefined && leadTarget?.options === undefined && agentType?.effort !== undefined) {
          const { instanceId, model } = target.modelSelection;
          const options = effortOptions(providers.find((p) => p.instanceId === instanceId)?.models.find((m) => m.slug === model), agentType.effort);
          if (options !== undefined) target = { ...target, modelSelection: { instanceId, model, options } };
        }
        const effort = effortOf(target.modelSelection.options);
        const runner: SubagentRunner = {
          engine: engineIdForInstance(target.modelSelection.instanceId) as SubagentRunner["engine"],
          instance_id: accountIdOf(target.modelSelection.instanceId, target.modelSelection.model),
          model: target.modelSelection.model,
          ...(effort === undefined ? {} : { effort }),
          pick: { by, kind: role, ...(taskKind === undefined || !pinRan ? {} : { task: taskKind }), ...(fallback === undefined ? {} : { fallback }), ...(options === undefined ? {} : { options }) },
        };
        const runtimeMode = yield* resolveRuntimeMode(
          parent.thread.runtimeMode,
          input.runtimeMode,
          target,
        );
        yield* assertChildAsks(runtimeMode, target);
        const interactionMode = yield* resolveInteractionMode(
          parent.thread.interactionMode,
          input.interactionMode,
        );
        let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
        if ((input.isolation ?? agentType?.isolation) === "worktree" && !isRetryOfAcceptedDelegation) {
          // Only the parent's checkout is read: a delegated child in a Caveman Code chat's project is that chat's
          // own work (the projector adopts it), not a T3 tool starting work there.
          const project = yield* readProject(parent.thread.projectId);
          const base = yield* gitDriver
            .resolveCommit({
              cwd: parent.thread.worktreePath ?? project.workspaceRoot,
              revision: "HEAD",
            })
            .pipe(
              Effect.mapError(() =>
                failure("invalid_request", "Unable to resolve the parent checkout commit."),
              ),
            );
          // Launch preparation creates the worktree from the project root, so a
          // parent checkout in another repository (such as a Git folder inside
          // Scratch) would hand it a commit it cannot find.
          if (parent.thread.worktreePath !== null) {
            yield* gitDriver
              .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
              .pipe(
                Effect.mapError(() =>
                  failure(
                    "invalid_request",
                    `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                  ),
                ),
              );
          }
          // A Caveman Code chat's agent gets a branch named the way the app names a chat's (caveman/<slug>-<id>),
 // never upstream temporary t3/<hash>, which nothing renames here and which a pushed branch would carry.
          workspaceStrategy = {
            type: "worktree",
            baseRef: base.commitSha,
            startFromOrigin: false,
            ...(isSessionProtocolProject(project.id) ? { branch: agentBranch(input.title ?? input.task, commandId) } : {}),
          };
        }
        // Before the dispatch, so the projector finds it when it adopts the child's thread. ponytail: a
        // delegation refused below leaves its row behind; a sweep if that ever adds up.
        if (Option.isSome(subagentAuto)) yield* subagentAuto.value.remember(commandId, runner, outcome);
        // ThreadManagementService.dispatch is the chokepoint for this command
        // type's own enablement check, using the same command id and its
        // receipt-replay exemption, so no separate assert runs here.
        const request = threadManagement
          .dispatch({
            type: "delegated_task.request",
            createdBy: "agent",
            creationSource: "mcp",
            commandId,
            parentThreadId: scope.thread.threadId,
            parentRunId: parentRun.id,
            parentNodeId: parentRun.rootNodeId,
            task: agentType === undefined ? taskPrompt(input) : agentTypePrompt(agentType, input.task),
            ...(input.title === undefined ? {} : { title: input.title }),
            modelSelection: target.modelSelection,
            runtimeMode,
            interactionMode,
            ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
            // Async delegations wake the parent on every child terminal; wait
            // delegations deliver through the blocking tool call, so a wake is
            // only needed if the parent settled first (timeout, disconnect).
            completionWake: mode === "wait" ? "settled_only" : "always",
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === "ThreadManagementProviderInstanceDisabledError"
                ? threadManagementFailure(error)
                : failure(
                    "orchestration_error",
                    `Unable to create delegated task: ${errorMessage(error)}`,
                  ),
            ),
          );
        const result = yield* delegationLock(parent.thread.lineage.rootThreadId).withPermits(1)(Effect.andThen(checkLimits, request));
        const taskEvent = result.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
        );
        if (taskEvent?.event.type !== "subagent.updated") {
          return yield* failure(
            "orchestration_error",
            "Delegated task command did not produce a task projection.",
          );
        }
        const taskId = taskEvent.event.payload.id;
        const childThreadId = taskEvent.event.payload.childThreadId;
        const childRunEvent = result.storedEvents.find(
          (stored) =>
            stored.event.type === "run.created" && stored.event.threadId === childThreadId,
        );
        if (
          childThreadId !== null &&
          childRunEvent?.event.type === "run.created" &&
          childRunEvent.event.payload.workspacePreparation !== undefined
        ) {
          yield* threadLaunch.prepareRun({
            commandId,
            threadId: childThreadId,
            runId: childRunEvent.event.payload.id,
          });
        }

        if (mode !== "wait") {
          return yield* readTask(scope, taskId, false, true);
        }
        const timeoutMs = automationTree
          ? MAX_WAIT_TIMEOUT_MS
          : Math.min(MAX_WAIT_TIMEOUT_MS, Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS));
        const waited = yield* waitForTask(scope, taskId, timeoutMs);
        if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
          return waited.value;
        }
        // An incomplete wait gives up delivery: upgrade so a later terminal
        // wakes the parent even mid-turn. Best effort; settled_only still
        // wakes a settled parent if the upgrade fails.
        yield* threadManagement
          .dispatch({
            type: "delegated_task.wake-policy",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "delegate-task-wake-policy",
            }),
            parentThreadId: scope.thread.threadId,
            taskId,
            completionWake: "always",
          })
          .pipe(
            // The tool result still returns after a timeout or question, so failures
            // stay warnings. Keep the two shapes apart: a rejected receipt
            // means this exact command id already failed (a replay of a
            // no-op upgrade), while anything else is a fresh dispatch fault.
            Effect.catch((error) =>
              Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
                taskId,
                outcome:
                  error._tag === "OrchestratorCommandPreviouslyRejectedError"
                    ? "previously_rejected"
                    : "dispatch_failed",
                error,
              }),
            ),
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
                taskId,
                outcome: "defect",
                cause,
              }),
            ),
          );
        return yield* readTask(scope, taskId, Option.isNone(waited), true);
      }),
    taskStatus: (callerScope, taskId) =>
      Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "task_status");
        if (Option.isSome(builders) && taskId.startsWith(BUILDER_TASK)) {
          const workspaceId = taskId.slice(BUILDER_TASK.length);
          const found = yield* builders.value.status(workspaceId);
          if (found === undefined) return yield* failure("task_not_found", `No builder ${workspaceId} of this thread.`);
          const parent = yield* loadProjection(scope.thread.threadId);
          return builderTask(found, parent.thread.modelSelection, found);
        }
        return yield* readTask(scope, taskId, false, true);
      }),
    cancelTask: (callerScope, input) =>
      Effect.gen(function* () {
        const scope = yield* requireThreadScope(callerScope, "task_cancel");
        if (input.taskId.startsWith(BUILDER_TASK))
          return yield* failure("task_not_cancellable", "A builder in a chat of its own stops from that chat (Stop), or when you mail it to stop.");
        const current = yield* readTask(scope, input.taskId);
        const key = yield* requestKey(input.clientRequestId);
        // Only the parent's modes: the task itself is read by id below.
        const parentProjection = yield* loadThreadRecords(scope.thread.threadId, []);
        // Cancelling stops the child and every task under it, each a write to a
        // thread its user may have raised above the parent's modes since it was
        // delegated. All of them are checked before anything is stopped.
        const assertStoppable = (threadId: ThreadId): Effect.Effect<void, OrchestratorMcpFailure> =>
          Effect.gen(function* () {
            const shell = yield* threadManagement
              .getThreadShell(threadId)
              .pipe(Effect.mapError(threadManagementFailure));
            // A deleted thread takes no stop, but the tasks under it still do.
            if (shell !== null && shell.deletedAt === null) {
              yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
              yield* resolveInteractionMode(
                parentProjection.thread.interactionMode,
                shell.interactionMode,
              );
            }
            const childThreadIds = yield* threadManagement
              .listAppOwnedChildThreadIds(threadId)
              .pipe(Effect.mapError(threadManagementFailure));
            for (const childThreadId of childThreadIds) {
              yield* assertStoppable(childThreadId);
            }
          });
        yield* assertStoppable(current.childThreadId);
        const parentTask = (yield* loadTasks(scope.thread.threadId, [input.taskId])).find(
          (task) => task.id === input.taskId && task.origin === "app_owned",
        );
        const disposeCompletionDelivery =
          parentTask?.completionDelivery?.state === "disposed"
            ? Effect.void
            : threadManagement
                .dispatch({
                  type: "delegated_task.completion-delivery.dispose",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "cancel-task-completion-delivery",
                  }),
                  parentThreadId: scope.thread.threadId,
                  taskId: input.taskId,
                })
                .pipe(
                  Effect.asVoid,
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                    ),
                  ),
                );
        // Cancelling stops the child thread the way Stop does, including work that came
        // after a published result: follow-up runs, pull request watch wakes, and the
        // tasks it delegated. The published result stays terminal.
        const stopChild = Effect.gen(function* () {
          const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
          const reason = agentStopReason(input.reason);
          yield* threadManagement
            .dispatch({
              type: "thread.stop",
              commandId,
              threadId: current.childThreadId,
              stopDelegatedTasks: false,
              reason,
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "task_not_cancellable",
                  `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}`,
                ),
              ),
            );
          // A retry with the same clientRequestId repeats only the stops that failed.
          yield* threadManagement
            .stopDelegatedTasks({ threadId: current.childThreadId, commandId, reason })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "task_not_cancellable",
                  `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
                ),
              ),
            );
          const stopped = yield* threadManagement
            .getThreadRecords(current.childThreadId, ["runs"])
            .pipe(Effect.mapError(threadManagementFailure));
          for (const run of stopped.runs) {
            if (
              run.status !== "queued" ||
              (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
            )
              continue;
            // Stop preserves the queue for Resume. Cancelling a task must also
            // remove that task's queued turn, including a previously held one.
            yield* threadManagement
              .dispatch({
                type: "queued-run.cancel",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: `cancel-task-queued-run:${run.id}`,
                }),
                threadId: current.childThreadId,
                runId: run.id,
              })
              .pipe(Effect.mapError(threadManagementFailure));
          }
        });
        // Checked above; a user raising one of these threads meanwhile is
        // caught again under that thread's lock, which leaves it running.
        const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
        const stopWithinLimit = stopChild.pipe(
          Effect.provideService(DispatchModeLimit, {
            runtimeMode: parentProjection.thread.runtimeMode,
            interactionMode: parentProjection.thread.interactionMode,
            refused,
          }),
          Effect.catch((error) =>
            Effect.flatMap(Ref.get(refused), (refusal) =>
              Effect.fail(
                refusal === undefined
                  ? error
                  : failure(
                      refusal.mode === "runtime"
                        ? "runtime_mode_escalation_denied"
                        : "interaction_mode_escalation_denied",
                      `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                    ),
              ),
            ),
          ),
        );
        // A follow-up that lost its child run (#19002) stays running on the parent, while its
        // status here comes from the child's last run. Stop on the parent cancels that task.
        const cancelOrphan = Effect.gen(function* () {
          if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
            return false;
          yield* threadManagement
            .dispatch({
              type: "subagent.stop",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: "cancel-task-orphan",
              }),
              threadId: scope.thread.threadId,
              runId: parentTask.runId,
              subagentId: parentTask.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
          const { subagents } = yield* threadManagement
            .getThreadRecords(scope.thread.threadId, ["subagents"], { subagentIds: [input.taskId] })
            .pipe(Effect.mapError(threadManagementFailure));
          return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
        });
        if (isTerminalTaskStatus(current.status)) {
          // The child can still run work for another turn, so it is stopped either way.
          yield* stopWithinLimit;
          const cancelled = yield* cancelOrphan;
          yield* disposeCompletionDelivery;
          return {
            taskId: input.taskId,
            status: cancelled ? "cancelled" : current.status,
          } satisfies OrchestratorMcpTaskCancelResult;
        }
        // A task waiting on its own delegates has work to stop below it. One with neither
        // a running turn nor delegates (such as one awaiting a restart) keeps its delivery.
        const child = yield* loadThreadRecords(current.childThreadId, ["runs"]);
        if (
          current.workState !== "waiting_for_children" &&
          ThreadManagementService.latestActiveRun(child) === undefined &&
          !child.runs.some(
            (run) =>
              run.status === "queued" &&
              (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
          )
        ) {
          if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" };
          return yield* failure(
            "task_not_cancellable",
            `Delegated task ${input.taskId} has no interruptible child run.`,
          );
        }
        yield* stopWithinLimit;
        yield* disposeCompletionDelivery.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
              taskId: input.taskId,
              cause,
            }),
          ),
        );
        return {
          taskId: input.taskId,
          status: "cancel_requested",
        };
      }),
    createThreads: (callerScope, input) =>
      Effect.gen(function* () {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
        if (parent.thread.lineage.relationshipToParent === "subagent") {
          return yield* failure("capability_denied", DELEGATED_AGENT_STARTS_NO_THREADS);
        }
        if (inAutomationRun(parent.thread)) return yield* failure("capability_denied", AUTOMATION_STEP_STARTS_NO_THREADS);
        const parentRun = ThreadManagementService.latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const isRetryOfAcceptedCreation = yield* threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              yield* assertChildAsks(runtimeMode, target);
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* assertTargetEnabledForProject(parent, commandId, target);
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "record-created-thread",
                    index,
                  }),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      }),
    listThreads: (scope, input) =>
      Effect.gen(function* () {
        const { parent } = yield* loadCaller(scope);
        const projectId = input.allProjects
          ? null
          : yield* resolveProjectTarget(parent, input.projectId);
        const projectThreads = yield* threadManagement
          .listProjectThreads({
            projectId: projectId ?? undefined,
            includeSubagents: input.includeSubagents !== false,
          })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
            ),
          );
        const nowMs = yield* Clock.currentTimeMillis;
        // An empty list is no filter: clients that fill every optional field send `[]`.
        const statuses =
          input.statuses === undefined || input.statuses.length === 0
            ? null
            : new Set(input.statuses);
        const titleContains = input.titleContains?.toLocaleLowerCase();
        const filtered = projectThreads
          .filter(
            (thread) =>
              statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
          )
          .filter(
            (thread) =>
              input.settled === undefined || threadSettlement(thread).settled === input.settled,
          )
          .filter(
            (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
          )
          .filter(
            (thread) =>
              titleContains === undefined ||
              thread.title.toLocaleLowerCase().includes(titleContains),
          );
        const cursor = input.cursor ?? 0;
        const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
        const page = filtered.slice(cursor, cursor + limit);
        const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
        return {
          projectId,
          currentThreadId: parent?.thread.id ?? null,
          threads: page.map((shell) => listItemFromShell(shell, nowMs)),
          nextCursor,
          total: filtered.length,
        } satisfies OrchestratorMcpThreadListResult;
      }),
    readThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
        const view = input.view ?? "messages";
        const afterPosition = input.afterPosition ?? -1;
        const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
        const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
        const timeline = yield* threadManagement
          .getTimelinePage(input.threadId, {
            afterPosition,
            limit,
            view,
            ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const page = timeline.items;
        const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
        for (const row of page) {
          if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
          const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
          ids.push(row.item.messageId);
          messageIdsByThread.set(row.sourceThreadId, ids);
        }
        const sourceMessages = yield* Effect.forEach(
          [...messageIdsByThread],
          ([threadId, messageIds]) =>
            threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
              Effect.map((records) => [threadId, records.messages] as const),
              Effect.mapError(threadManagementFailure),
            ),
          { concurrency: 1 },
        );
        const messagesByThreadId = new Map(sourceMessages);
        const returnedRunIds = new Set(
          page
            .filter((row) => row.sourceThreadId === target.thread.id)
            .map((row) => row.item.runId),
        );
        const tasks =
          parent === undefined
            ? []
            : directAppOwnedChildTasks(
                {
                  thread: parent.thread,
                  subagents: yield* loadTasks(
                    parent.thread.id,
                    directChildTaskIds(target, returnedRunIds),
                  ),
                },
                target,
                returnedRunIds,
              );
        if (
          parent !== undefined &&
          scope.thread !== undefined &&
          tasks.length > 0 &&
          (input.textOffset ?? 0) === 0
        ) {
          for (const task of tasks) {
            const transfer = taskResultTransfer(parent, target, task);
            const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
            const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
            const resultRecords = yield* threadManagement
              .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
                messageRoles: ["assistant"],
                messageRunIds: resultRunIds,
                turnItemRunIds: resultRunIds,
                turnItemTypes: ["assistant_message", "error"],
              })
              .pipe(Effect.mapError(threadManagementFailure));
            if (
              pageIncludesTerminalTaskResult({
                parent,
                page,
                task,
                target: { ...target, ...resultRecords },
                maxChars,
              })
            ) {
              yield* readTask(
                scope as McpThreadInvocationScope,
                task.id,
                false,
                true,
                "thread-read-acknowledge",
              );
            }
          }
        }
        return {
          thread: threadDetail(target, timeline.totalItems, shell, yield* Clock.currentTimeMillis),
          recentRuns: target.runs
            .toSorted((left, right) => right.ordinal - left.ordinal)
            .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
            .map(threadRun),
          items: page.filter((row) => row.item.type !== "system_notice" || row.item.compressionRetrieveStatus === undefined).map((row) =>
            timelineItem({
              row,
              maxChars,
              messagesByThreadId,
              ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
            }),
          ),
          nextPosition: page.at(-1)?.position ?? null,
          hasMore: timeline.hasMore,
        } satisfies OrchestratorMcpThreadReadResult;
      }),
    sendToThread: (scope, input) =>
      Effect.gen(function* () {
        // A tree mate on another computer (a builder on Cloud, a builder's lead elsewhere): mail through Cloud.
        if (Option.isSome(builders) && input.threadId.startsWith(CLOUD_THREAD) && scope.thread !== undefined) {
          const key = yield* requestKey(input.clientRequestId);
          const sent = yield* builders.value
            .message({ fromThreadId: scope.thread.threadId, toThreadId: input.threadId, text: input.message, requestKey: key, ask: input.expectReply === true })
            .pipe(Effect.mapError((error) => failure(error.reason === "unavailable" ? "orchestration_error" : error.reason, error.message)));
          if (sent !== undefined) {
            return {
              threadId: input.threadId,
              messageId: MessageId.make(`${CLOUD_THREAD}${sent.id}`),
              runId: RunId.make(`${CLOUD_THREAD}${sent.id}`),
              status: "queued",
              delivery: "queued",
            } satisfies OrchestratorMcpThreadSendResult;
          }
        }
        // A chat on another of the person's Macs: signed mail through Cloud, from a live run of a chat here, with this
        // chat's modes as the most it may run with there. It queues there as the next turn: never a steer or restart.
        if (Option.isSome(macMail) && input.threadId.startsWith(MAC_THREAD)) {
          if (scope.thread === undefined) {
            return yield* failure("invalid_request", "Mail to a chat on another of your Macs goes from a Caveman Code chat on this Mac.");
          }
          const { parent, limits } = yield* loadCaller(scope);
          if (parent !== undefined) yield* assertLiveCaller(scope, parent);
          const mode = input.mode ?? "auto";
          if (mode === "steer" || mode === "restart") {
            return yield* failure("invalid_request", `A chat on another of your Macs takes mail as its next turn: send with mode auto or queue, not ${mode}.`);
          }
          const key = yield* requestKey(input.clientRequestId);
          const sent = yield* macMail.value
            .send({
              fromThreadId: scope.thread.threadId,
              toThreadId: input.threadId,
              text: input.message,
              requestKey: key,
              ask: input.expectReply === true,
              ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
              limits,
            })
            .pipe(Effect.mapError((error) => failure(error.reason === "unavailable" ? "orchestration_error" : error.reason, error.message)));
          if (sent !== undefined) {
            return {
              threadId: input.threadId,
              messageId: MessageId.make(`${MAC_THREAD}${sent.id}`),
              runId: RunId.make(`${MAC_THREAD}${sent.id}`),
              status: "queued",
              delivery: "queued",
            } satisfies OrchestratorMcpThreadSendResult;
          }
        }
        const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
        yield* assertLiveCallerForOtherThread(scope, parent, target);
        yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
        yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

        const mode = input.mode ?? "auto";
        if (
          input.expectReply === true &&
          input.inReplyTo === undefined &&
          (mode === "steer" || mode === "restart")
        ) {
          return yield* failure(
            "invalid_request",
            `A question needs a turn of its own: send expectReply with mode auto or queue, not ${mode}.`,
          );
        }
        const key = yield* requestKey(input.clientRequestId);
        const messageId = stableOperationMessageId({
          scope,
          requestKey: key,
          operation: "thread-send",
        });
        const commandId = stableCommandId({
          scope,
          requestKey: key,
          operation: "thread-send",
        });
        const send = threadManagement
          .sendToThread({
            projectId: target.thread.projectId,
            commandId,
            threadId: input.threadId,
            ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
            messageId,
            text: input.message,
            ...(input.expectReply === undefined ? {} : { expectReply: input.expectReply }),
            ...(input.inReplyTo === undefined ? {} : { inReplyTo: input.inReplyTo }),
            attachments: [],
            mode,
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(
            Effect.mapError((error) =>
              isThreadManagementError(error)
                ? threadManagementFailure(error)
                : failure(
                    "orchestration_error",
                    `Unable to send to thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                  ),
            ),
          );
        const result = yield* target.thread.lineage.relationshipToParent === "subagent"
          ? delegationLock(target.thread.lineage.rootThreadId).withPermits(1)(Effect.andThen(followupLimits(target.thread, commandId), send))
          : send;
        return {
          threadId: input.threadId,
          messageId,
          runId: result.run.id,
          ...(result.run.delegatedTaskId === undefined
            ? {}
            : { taskId: result.run.delegatedTaskId }),
          status: result.run.status,
          delivery: result.delivery,
        } satisfies OrchestratorMcpThreadSendResult;
      }),
    waitForThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, target } = yield* loadScopedThread(scope, input.threadId, false);
        const result = yield* threadManagement
          .waitForThread({
            projectId: target.thread.projectId,
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            timeoutMs: Math.min(
              MAX_WAIT_TIMEOUT_MS,
              Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
            ),
          })
          .pipe(Effect.mapError(threadManagementFailure));
        const status = result.run === null ? "idle" : runOutcome(result.run);
        const taskId = result.run?.delegatedTaskId;
        const ownedTask =
          result.timedOut &&
          status !== "waiting" &&
          parent !== undefined &&
          taskId !== undefined &&
          (yield* loadTasks(parent.thread.id, [taskId])).some(
            (task) =>
              task.id === taskId &&
              task.origin === "app_owned" &&
              task.threadId === parent.thread.id &&
              task.childThreadId === input.threadId &&
              task.completionDelivery?.state !== "disposed",
          );
        // A child waiting on a question or approval needs an answer, not a wake.
        const childRequests = ownedTask
          ? (yield* threadManagement
              .getThreadRecords(input.threadId, ["runtimeRequests"])
              .pipe(Effect.mapError(threadManagementFailure))).runtimeRequests
          : [];
        const wakesCaller =
          ownedTask && !childRequests.some((request) => request.status === "pending");
        return {
          threadId: input.threadId,
          runId: result.run?.id ?? null,
          status,
          timedOut: result.timedOut,
          ...(wakesCaller ? { next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : {}),
        } satisfies OrchestratorMcpThreadWaitResult;
      }),
    interruptThread: (scope, input) =>
      Effect.gen(function* () {
        const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
        yield* assertLiveCallerForOtherThread(scope, parent, target);
        // Stopping another thread's work is a write: it must run within the caller's modes.
        yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
        yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
        const key = yield* requestKey(input.clientRequestId);
        const result = yield* threadManagement
          .interruptThread({
            projectId: target.thread.projectId,
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: "thread-interrupt",
            }),
            threadId: input.threadId,
            ...(input.runId === undefined ? {} : { runId: input.runId }),
            reason: agentStopReason(input.reason),
          })
          .pipe(
            Effect.mapError((error) =>
              isThreadManagementError(error)
                ? threadManagementFailure(error)
                : failure(
                    "orchestration_error",
                    `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                  ),
            ),
          );
        if (result.type === "no_active_run") {
          return {
            threadId: input.threadId,
            runId: null,
            status: "no_active_run",
          } satisfies OrchestratorMcpThreadInterruptResult;
        }
        return {
          threadId: input.threadId,
          runId: result.run.id,
          status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | SecureRandom.SecureRandom
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | ServerSettings.ServerSettingsService
> = Layer.effect(OrchestratorMcpService, make);
