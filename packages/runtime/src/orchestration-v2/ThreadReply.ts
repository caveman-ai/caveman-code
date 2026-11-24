import {
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type RunId,
} from "@caveman-app/protocol";
import { subagentResultForRun } from "@caveman-app/engine-core/server/subagentProjection";
import { truncateCodeUnits } from "@caveman-app/shared/threadMessageEnvelope";

const THREAD_REPLY_MAX_CHARS = 8_000;

export function threadReplyFields(
  source: Pick<OrchestrationV2ConversationMessage, "expectsReply" | "inReplyTo">,
) {
  return {
    ...(source.expectsReply === undefined ? {} : { expectsReply: source.expectsReply }),
    ...(source.inReplyTo === undefined ? {} : { inReplyTo: source.inReplyTo }),
  };
}

/** One per question, so a replayed terminal event or a restart never sends a second answer. */
export function threadReplyMessageId(questionId: MessageId): MessageId {
  return MessageId.make(`message:thread-reply:${encodeURIComponent(questionId)}`);
}

/** A run and the runs it resumed after restarts: the questions it answers belong to these. */
export function restartChainRunIds(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runId: RunId,
): Array<RunId> {
  const ids: Array<RunId> = [];
  let run = runs.find((candidate) => candidate.id === runId);
  while (run !== undefined) {
    ids.push(run.id);
    const source = run.restartContinuationOfRunId;
    run = source === undefined ? undefined : runs.find((candidate) => candidate.id === source);
  }
  return ids;
}

/** The run that answers a message: the one it reached, or the restart continuation that resumed it. */
export function answeringRun(
  runs: ReadonlyArray<OrchestrationV2Run>,
  runId: RunId | null,
): OrchestrationV2Run | undefined {
  let run = runs.find((candidate) => candidate.id === runId);
  while (run !== undefined) {
    const sourceId = run.id;
    const continuation = runs.find((candidate) => candidate.restartContinuationOfRunId === sourceId);
    if (continuation === undefined) return run;
    run = continuation;
  }
  return undefined;
}

/** The answer: the run's final assistant message, or one line saying why there is none. */
export function threadReplyText(
  receiver: Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">,
  run: OrchestrationV2Run,
): string {
  const title = receiver.thread.title;
  if (run.status !== "completed") {
    const failure = receiver.turnItems.findLast(
      (item) => item.runId === run.id && item.type === "error",
    );
    const error = failure?.type === "error" ? `: ${failure.failure.message}` : "";
    return truncateCodeUnits(
      `${title} could not answer: the run ${run.status}${error}`.replace(/\s*[\r\n]+\s*/g, " "),
      THREAD_REPLY_MAX_CHARS,
    );
  }
  const result = subagentResultForRun(receiver, run);
  const text =
    result.messageId === null && result.turnItemId === null
      ? `${title} finished without a final message.`
      : result.text;
  if (text.length <= THREAD_REPLY_MAX_CHARS) return text;
  const pointer = `\n[truncated — read the rest with thread_read(threadId=${JSON.stringify(receiver.thread.id)})]`;
  return truncateCodeUnits(text, THREAD_REPLY_MAX_CHARS - pointer.length) + pointer;
}

/**
 * What a thread with broader modes than the answerer gets instead of the
 * answer: a wake that carries none of the answerer's output.
 */
export function threadReplyUndeliverableText(
  receiver: Pick<OrchestrationV2AppThread, "id" | "title">,
  run: Pick<OrchestrationV2Run, "status">,
): string {
  return (
    `${receiver.title} ended its turn (${run.status}), but its reply can't be delivered to a ` +
    `thread with broader permissions; read it with thread_read(threadId=${JSON.stringify(receiver.id)}).`
  );
}
