import type { TranscriptItem } from "./transcript-model.ts";

/**
 * A message sent while approvals wait redirects the agent (upstream #21503): the box stays usable, and Send first
 * declines every approval the chat shows, then the message goes. An approval left waiting would hold the agent, so
 * the message would sit behind it.
 */
export interface WaitingApproval {
  readonly askId: string;
  /** Its Deny option; null when the engine offered none, so there is nothing to decline with. */
  readonly denyId: string | null;
  /** Its deny takes a note to the agent that asked (ask.user `accepts_feedback`, Claude Agent's). */
  readonly feedback: boolean;
}

/** The approvals waiting on the person in a chat's transcript, its native subagents' included. */
export function waitingApprovals(items: ReadonlyArray<TranscriptItem>, out: WaitingApproval[] = []): WaitingApproval[] {
  for (const item of items) {
    if (item.kind === "ask" && item.askKind === "approval" && item.resolution === null) {
      out.push({ askId: item.id, denyId: item.options.find((o) => o.decision === "deny")?.id ?? null, feedback: item.acceptsFeedback === true });
    } else if (item.kind === "subagent") waitingApprovals(item.items, out);
  }
  return out;
}

/**
 * The approval a message sent now answers as its deny's note (upstream #23657), rather than declining it and sending the
 * message as a new prompt: the one approval waiting, when its deny takes a note and the message is words only (a note
 * carries no attachments). With several waiting, or one that takes no note, the message redirects as before.
 */
export function noteTarget(approvals: ReadonlyArray<WaitingApproval>, attachments: number): (WaitingApproval & { readonly denyId: string }) | null {
  const [only, ...more] = approvals;
  return only !== undefined && more.length === 0 && only.feedback && only.denyId !== null && attachments === 0 ? { ...only, denyId: only.denyId } : null;
}

/** Why a redirect did not go out; the composer puts the message back and says this. */
export class RedirectHeld extends Error {}

/**
 * Declines `approvals` one by one, before the redirect goes. A refused decline stops it (the agent would still wait),
 * except one someone answered first, which waits no more. Then, an approval that arrived meanwhile would hold the
 * redirect as the first did: the message stays in the box for a send that declines that one too.
 */
export async function declineForRedirect(
  approvals: ReadonlyArray<WaitingApproval>,
  respond: (askId: string, optionId: string) => Promise<unknown>,
  answeredFirst: (e: unknown) => boolean,
  waitingNow: () => ReadonlyArray<WaitingApproval>,
): Promise<void> {
  for (const approval of approvals) {
    // An approval with no Deny can't be declined from here; the card's own options answer it.
    if (approval.denyId === null) continue;
    try {
      await respond(approval.askId, approval.denyId);
    } catch (e) {
      if (!answeredFirst(e)) throw new RedirectHeld("The approval wasn't declined, so your message wasn't sent. Send it again.");
    }
  }
  const declined = new Set(approvals.map((a) => a.askId));
  if (waitingNow().some((a) => !declined.has(a.askId))) {
    throw new RedirectHeld("Approval declined. Another one arrived, so your message wasn't sent: send it again to decline that one too.");
  }
}
