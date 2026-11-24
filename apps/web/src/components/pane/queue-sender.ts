import type { Result } from "@caveman-app/session-protocol";

type QueuedTurn = Result<"queue.list">["turns"][number];

/**
 * Who sent a queued message when it was not the person (upstream #26159), as its queue row says it before the
 * words: another chat's agent ("From Release lead"), or a scheduled task ("Scheduled Nightly triage"). Nothing for
 * the person's own.
 */
export function queuedSender(turn: Pick<QueuedTurn, "from" | "scheduled_task">): { readonly sender?: string } {
  if (turn.from) return { sender: `From ${turn.from.title}` };
  if (turn.scheduled_task) return { sender: turn.scheduled_task.title ? `Scheduled ${turn.scheduled_task.title}` : "Scheduled" };
  return {};
}
