// ), apps/server/src/orchestration-v2/NotificationMailbox.ts @ ab3a3cd1.
import {
  latestProviderTurnForAttempt,
  type MessageId,
  type NodeId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
} from "@caveman-app/protocol";
import {
  escapeThreadMessageTags,
  truncateCodeUnits,
} from "@caveman-app/shared/threadMessageEnvelope";

const WAKE_RESULT_MAX_CHARS_PER_TASK = 6_000;
const WAKE_RESULT_MAX_CHARS = 16_000;
const WAKE_TASK_NAME_MAX_CHARS = 120;

/**
 * The parent's wake for finished delegated tasks, carrying each result so the
 * wake turn needs no task_status call. It names task_status only for a result
 * the caps cut or that is missing.
 */
export function delegatedCompletionText(
  subagents: ReadonlyArray<Pick<OrchestrationV2Subagent, "id" | "title" | "prompt" | "status" | "result">>,
  taskIds: ReadonlyArray<NodeId>,
): string {
  let budget = WAKE_RESULT_MAX_CHARS;
  return taskIds
    .map((taskId) => {
      const task = subagents.find((candidate) => candidate.id === taskId);
      // Untitled tasks are named by their prompt, as the notification is.
      const name = task?.title?.trim() || task?.prompt.replace(/\s+/g, " ").trim();
      const title = name ? ` ${JSON.stringify(truncateCodeUnits(name, WAKE_TASK_NAME_MAX_CHARS))}` : "";
      // A child's output must not pass for a message from another thread.
      const heading = escapeThreadMessageTags(
        `Delegated task ${taskId}${title} ${task?.status ?? "finished"}`,
      );
      const pointer = `task_status(taskId=${JSON.stringify(taskId)})`;
      const result = task?.result == null ? null : escapeThreadMessageTags(task.result);
      if (result === null) {
        return `${heading}. Its result is not recorded yet; read it with ${pointer}.`;
      }
      const room = Math.min(WAKE_RESULT_MAX_CHARS_PER_TASK, budget);
      budget -= Math.min(result.length, room);
      if (result.length <= room) return `${heading}. Result:\n${result}`;
      return `${heading}. Result:\n${truncateCodeUnits(result, room)}\n[truncated — read the rest with ${pointer}]`;
    })
    .join("\n\n");
}

/** A wake attaches to output held in provider memory, which Stop or process loss discards. */
export function isBufferedProviderNotification(
  message: OrchestrationV2ConversationMessage,
): boolean {
  return (
    message.createdBy === "agent" &&
    message.creationSource === "provider" &&
    message.notification !== undefined &&
    message.delegatedCompletion === undefined
  );
}

/**
 * A persisted steer without an acceptance receipt can be retried as a continuation.
 * Delivery is at least once: provider acceptance and our receipt cannot commit
 * atomically. Reusing the message ID keeps recovery from duplicating timeline items.
 */
export function isUndeliveredMailboxSteer(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "providerTurns">,
  messageId: MessageId,
): boolean {
  const message = projection.messages.find((candidate) => candidate.id === messageId);
  if (message?.delegatedCompletion === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === message.runId);
  return (
    run !== undefined &&
    run.userMessageId !== message.id &&
    (["completed", "failed", "interrupted", "cancelled", "rolled_back"].includes(run.status) ||
      latestProviderTurnForAttempt(projection.providerTurns, run.activeAttemptId)?.status ===
        "completed")
  );
}
