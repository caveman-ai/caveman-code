import type {
  OrchestrationV2AppThread,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Run,
  ThreadId,
} from "@caveman-app/protocol";
import { threadMessageEnvelope } from "@caveman-app/shared/threadMessageEnvelope";
import * as Effect from "effect/Effect";

import { messageStaysInRun } from "../mcp/delegationPolicy.ts";
import { exceededDispatchModeLimit } from "./DispatchModeLimit.ts";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";

/**
 * Work a parent hands its app-owned child: the task itself or a follow-up.
 * Its final message already returns to the parent as the task result.
 */
export function isDelegatedTaskPrompt(
  thread: Pick<OrchestrationV2AppThread, "lineage" | "forkedFrom">,
  message: Pick<OrchestrationV2ConversationMessage, "senderThreadId" | "inReplyTo">,
): boolean {
  return (
    thread.lineage.relationshipToParent === "subagent" &&
    thread.forkedFrom?.type === "node" &&
    message.senderThreadId === thread.lineage.parentThreadId &&
    message.inReplyTo === undefined
  );
}

/**
 * The prompt an agent launched a thread with (create_threads, thread_launch):
 * an agent created the thread over MCP, and this agent message started its
 * first run. The launching agent acts for the user here, so it invites no
 * report back.
 */
function isLaunchPrompt(
  thread: Pick<OrchestrationV2AppThread, "createdBy" | "creationSource">,
  run: Pick<OrchestrationV2Run, "ordinal" | "userMessageId">,
  message: Pick<OrchestrationV2ConversationMessage, "id" | "createdBy" | "creationSource">,
): boolean {
  return (
    thread.createdBy === "agent" &&
    thread.creationSource === "mcp" &&
    message.createdBy === "agent" &&
    message.creationSource === "mcp" &&
    run.ordinal === 1 &&
    run.userMessageId === message.id
  );
}

/** Provider text for a persisted message: another thread's message arrives in its envelope. */
export const providerMessageText = (
  projections: Pick<ProjectionStoreV2Shape, "getThread" | "getThreadShell">,
  input: {
    readonly threadId: ThreadId;
    readonly run: Pick<OrchestrationV2Run, "ordinal" | "userMessageId">;
    readonly message: OrchestrationV2ConversationMessage;
    readonly text: string;
    /** The receiving session has the caveman-code MCP tools, thread_send among them. */
    readonly supportsMcpTools: boolean;
  },
) =>
  Effect.gen(function* () {
    const { message } = input;
    const senderThreadId = message.senderThreadId;
    if (senderThreadId === undefined) return input.text;
    const thread = yield* projections.getThread(input.threadId);
    if (isDelegatedTaskPrompt(thread, message) || isLaunchPrompt(thread, input.run, message)) {
      return input.text;
    }
    const shell = (threadId: ThreadId) =>
      projections.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
    const sender = yield* shell(senderThreadId);
    return threadMessageEnvelope({
      senderTitle: sender?.title ?? senderThreadId,
      senderThreadId,
      messageId: message.id,
      text: input.text,
      inReplyTo: message.inReplyTo,
      expectsReply: message.expectsReply,
      // thread_send refuses a target with broader modes than its caller, or outside its automation step.
      canReply:
        input.supportsMcpTools &&
        sender !== null &&
        exceededDispatchModeLimit(thread, sender) === undefined &&
        (yield* messageStaysInRun(thread, sender, shell)),
    });
  });
