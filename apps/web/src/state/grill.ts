// Grill mode on the wire. The engine interviews the user in rounds (one
// ask.user with `round` per round, every question it can ask now, each with
// its recommended answer), then writes a decisions doc (grill.finished) the
// user can build from.

import type { Params, Session } from "@caveman-app/session-protocol";

export type SessionMode = NonNullable<Session["mode"]>;
export type AskReply = Params<"ask.respond">["response"];

/**
 * What one question of a round holds while the user answers. `own`: "Other"
 * is the choice (typing or moving to it sets it); the typed words stay either
 * way, and answer only while `own` and not blank. A single-choice question
 * holds at most one option, and picking it clears `own`; a multi-select one
 * holds any number, and its words answer beside them.
 */
export interface RoundDraft {
  readonly optionIds: ReadonlyArray<string>;
  readonly text: string;
  readonly own: boolean;
}

/** The whole round as one ask.respond, one answer per question; null while one is unanswered. */
export function roundReply(
  questions: ReadonlyArray<{ readonly id: string; readonly multiSelect: boolean }>,
  drafts: Readonly<Record<string, RoundDraft>>,
): AskReply | null {
  const answers = [];
  for (const q of questions) {
    const d = drafts[q.id];
    const text = d?.own ? d.text.trim() : "";
    const optionIds = q.multiSelect || !text ? [...(d?.optionIds ?? [])] : [];
    if (!text && optionIds.length === 0) return null;
    answers.push({ question_id: q.id, option_ids: optionIds, ...(text ? { text } : {}) });
  }
  return { kind: "question", answers };
}

/** An answer in words: its options' labels, then the user's own. */
export function answerText(answer: { readonly optionIds: ReadonlyArray<string>; readonly text: string | null }, label: (optionId: string) => string): string {
  return [...answer.optionIds.map(label), ...(answer.text ? [answer.text] : [])].join(", ");
}

/**
 * A question's choices are its `n` options then "Other" (index n). Where a
 * key moves the choice from `at` (the radio pattern: arrows step and wrap, a
 * digit jumps to its keycap); null for any other key.
 */
export function choiceKey(key: string, at: number, n: number): number | null {
  if (key === "ArrowDown" || key === "ArrowRight") return at >= n ? 0 : at + 1;
  if (key === "ArrowUp" || key === "ArrowLeft") return at <= 0 ? n : at - 1;
  return /^[1-9]$/.test(key) && Number(key) <= n + 1 ? Number(key) - 1 : null;
}

/**
 * The mode a turn asks for: only a change the user made in this client (the
 * Grill chip or menu), never a re-assertion of the mode it shows, which may
 * be stale. Only an engine that grills is asked for grill mode; leaving it
 * always goes through (a session handed to an engine that can't grill).
 */
export function turnMode(grills: boolean, session: SessionMode | undefined, grill: boolean): { mode?: SessionMode } {
  if (grill === (session === "grill")) return {};
  if (grill) return grills ? { mode: "grill" } : {};
  return { mode: "default" };
}

export type SendState = "idle" | "sending" | "sent";

/** Build it per finish card, by key: a card that remounts (pane or workspace switched) keeps what it sent. */
const builds = new Map<string, SendState>();
export const buildState = (key: string): SendState => builds.get(key) ?? "idle";

/**
 * Build it sends one turn per card: a click while it is in flight or after it
 * went through does nothing, from this mount or a later one; a failure allows
 * another try. `show` gets each state.
 */
export function sendOnce(key: string, send: () => Promise<void> | void, show: (state: SendState) => void): void {
  if (buildState(key) !== "idle") return;
  const set = (s: SendState) => {
    builds.set(key, s);
    show(s);
  };
  set("sending");
  Promise.resolve()
    .then(send)
    .then(
      () => set("sent"),
      () => set("idle"),
    );
}

/** The turn "Build it" sends, in default mode. */
export function buildPrompt(docPath: string): string {
  return `Build what we agreed in ${docPath}.`;
}
