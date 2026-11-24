// Asking the agent about a pull request from its guide, answer only: the desktop's Ask ("Answer the question below
// about this pull request. Read the code; change nothing."). A question never starts a change, never takes you out of
// the guide, and never reads as a verdict: it is kept under the chapter it was asked from, and the answer lands there
// a moment later. On one of your chats' pull requests the chat hears it too, as your words and its reply, and stays
// ready; on anyone else's an agent reads the branch and answers. The scripted world answers a guide's own questions
// in the agent's words (guides.ts ANSWERS) and anything else from the guide: the note on the line, or the chapter's
// after and why, and its call.
import type { Chat } from "../board/model";
import { itemId } from "../board/model";
import { prKey } from "../screens/pages/review-model";
import { dispatch } from "../store/store";
import { ANSWERS } from "./guides";
import type { Review } from "./source";
import { CALL_WORD, guideLinesOf, type Passage, steerText } from "./model";
import { asked } from "./state";

/** How long the agent reads before it answers. */
const ANSWER_MS = 1800;

let seq = 0;

const sentence = (s: string) => {
  const t = s.trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/([^.!?])$/, "$1.") : "";
};

/** What the agent answers: its own words for a question its guide wrote, else what the guide says about the place. */
export function answerFor(review: Review, stop: number | null, question: string, line?: { path: string; line: number }): string {
  const scripted = ANSWERS[question.trim()];
  if (scripted) return scripted;
  const guide = review.result.guide;
  const s = stop !== null ? guide?.stops[stop] : undefined;
  const parts: string[] = [];
  if (line) {
    const note = (s ? s.notes : (guide?.stops.flatMap((x) => x.notes) ?? [])).find((n) => n.path === line.path && n.line === line.line);
    if (note) parts.push(`${sentence(note.title)} ${note.body}`);
  }
  if (s) {
    const lines = guideLinesOf(s.summary);
    const after = lines.find((l) => l.label === "after")?.text;
    const why = lines.find((l) => l.label === "why")?.text;
    if (!parts.length && after) parts.push(sentence(after));
    if (why) parts.push(`That's because ${why.replace(/\.$/, "")}.`);
    if (s.attention) parts.push(`The part I'd want you to decide (${CALL_WORD[s.attention.kind].toLowerCase()}): ${s.attention.note}`);
  } else if (!parts.length && guide?.tldr) {
    parts.push(guide.tldr);
    const why = guide.overview ? guideLinesOf(guide.overview).find((l) => l.label === "why")?.text : undefined;
    if (why) parts.push(`It was done because ${why.replace(/\.$/, "")}.`);
  }
  if (!parts.length) parts.push("I read the change again and there's nothing in it that bears on that. Ask it another way, or ask me to change it.");
  return parts.join(" ");
}

/**
 * Asks; returns the asked question's id. The answer lands under the question after ANSWER_MS, and in the chat when
 * the pull request is one of your chats'.
 */
export function askAgent(input: { pr: { repo: string; number: number }; review: Review; chat: Chat | null; stop: number | null; passage?: Passage; question: string; line?: { path: string; line: number } }): string {
  const { pr, review, chat, stop, passage, question, line } = input;
  const key = prKey(pr);
  const id = `ask-${Date.now().toString(36)}-${(++seq).toString(36)}`;
  const now = Date.now();
  asked.set((was) => ({ ...was, [key]: [...(was[key] ?? []), { id, question, where: passage?.where, stop, answer: null, at: now }] }));
  if (chat) dispatch({ type: "append", id: chat.id, items: [{ kind: "you", id: itemId(), text: steerText(question, passage), at: now, state: "sent" }] });
  const answer = answerFor(review, stop, question, line);
  setTimeout(() => {
    asked.set((was) => ({ ...was, [key]: (was[key] ?? []).map((a) => (a.id === id ? { ...a, answer } : a)) }));
    if (chat) dispatch({ type: "append", id: chat.id, items: [{ kind: "text", id: itemId(), text: answer, at: Date.now(), phase: "final" }] });
  }, ANSWER_MS);
  return id;
}
