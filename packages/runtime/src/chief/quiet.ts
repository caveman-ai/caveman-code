// Lines a Chief writes that say nothing: the person never sees them (session-protocol/projector.ts holds a Chief's
// short reply until it is finished, and drops it when this says so). The prompt asks for no text at all on a turn
// with nothing to say; this is the backstop for when the model writes one anyway. Only on a turn the runtime woke it
// for, never on one a note of the person's is in: a short answer to them ("Not yet.") always shows. The one exception:
// a turn that reacted to their note (react) answered it with the reaction, so a bare acknowledgement after it
// ("Noted.", "On it.") says nothing more. The engine asks the model again after an empty reply, so a turn meant to end
// in silence after a reaction can come back with one.

/** Longer than this is a real reply, never a no-op: the projector streams it as it comes. */
export const QUIET_MAX = 160;

/** Whole lines that only say nothing needs doing, lowercased, with no end punctuation. Exact matches only. */
const NO_OP: ReadonlySet<string> = new Set([
  "nothing new to act on",
  "nothing to act on",
  "nothing new here",
  "nothing new",
  "nothing here needs you",
  "nothing needs you",
  "nothing needs you right now",
  "nothing to report",
  "nothing to do",
  "no reply needed",
  "no action needed",
  "no update",
  "no updates",
  "noted",
]);

/** Acknowledgements a reaction already gives, lowercased, with no end punctuation. Exact matches only. */
const ACKNOWLEDGED: ReadonlySet<string> = new Set(["noted", "got it", "will do", "on it", "queued", "sounds good"]);

/** A closing word after tool calls whose cards already say it. */
const CLOSING: ReadonlySet<string> = new Set(["done", "started", "sent", "on it"]);

/**
 * The Chief's tools that change something and draw a card the person sees: a closing word after only these repeats
 * the cards. Never chat_digest or memory_sql: what they read shows nowhere, so the words after them are the answer.
 */
const SHOWN_CHANGES: ReadonlySet<string> = new Set(["queue_add", "queue_update", "queue_drop", "queue_order", "chat_start", "chat_send", "chat_stop", "remember", "ask", "chat_answer", "schedule"]);

/** Card-less tools that do not make a closing word an answer. */
const NEUTRAL: ReadonlySet<string> = new Set(["playbook", "react"]);

/** A tool's own name, without an MCP server's prefix (mcp__chief__chat_start). */
const bare = (name: string) => name.split("__").at(-1)!;

export interface QuietTurn {
  /** The runtime woke it (a notification opened the turn) and no message of the person's joined it. */
  readonly wake: boolean;
  /** The tools the turn called, by name. */
  readonly tools: ReadonlyArray<string>;
  /** One of them failed or was declined. */
  readonly toolFailed: boolean;
}

/**
 * Whether the person sees nothing of this Chief reply. After a reaction (react, none of the turn's tools failed): a
 * bare acknowledgement from ACKNOWLEDGED, in any turn. Else only in a wake turn: a line from NO_OP, or a closing word
 * from CLOSING when every non-neutral tool it called changes something with a card, and none failed.
 */
export const quietChiefReply = (text: string, turn: QuietTurn) => {
  const line = text.replace(/\s+/g, " ").trim().toLowerCase().replace(/[.!…]+$/, "");
  if (!turn.toolFailed && turn.tools.some((t) => bare(t) === "react") && (line === "" || ACKNOWLEDGED.has(line))) return true;
  if (!turn.wake) return false;
  if (line === "") return true;
  if (NO_OP.has(line)) return true;
  const acting = turn.tools.filter((t) => !NEUTRAL.has(bare(t)));
  return CLOSING.has(line) && acting.length > 0 && !turn.toolFailed && acting.every((t) => SHOWN_CHANGES.has(bare(t)));
};

/** What the projector takes for a Chief's thread (ProjectionContext.quietReply). */
export const CHIEF_QUIET = { max: QUIET_MAX, hides: quietChiefReply } as const;
