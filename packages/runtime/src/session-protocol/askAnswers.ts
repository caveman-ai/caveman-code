// An answer to a session's ask, from whoever drives a session nobody sits at: an `answer` mail on a Cloud computer
// (headless.ts), or a `user.approval | user.answer | user.tool_result` line on `agent exec`'s stdin. One rule for
// both, with no imports beyond types, so the fast `agent exec` path loads it without the Cloud link.
import type { SessionEvent } from "@caveman-app/session-protocol";

import type { AnswerPayload } from "../cloudLink/sessions.ts";
import type { AskResponse } from "./runtimeAsks.ts";

/**
 * An `answer` mail as the ask's own response: an approval's one-time allow or deny (a deny's note with it, where the
 * engine takes one), a question's answer, a tool's result.
 */
export function responseFor(ask: Extract<SessionEvent, { type: "ask.user" }>["payload"], answer: AnswerPayload): AskResponse | string {
  switch (ask.kind) {
    case "approval": {
      if (answer.decision !== "allow" && answer.decision !== "deny") return "an approval takes decision allow or deny";
      // This one call only: an allow is the one-time option or none, never the session-wide or always ones; any deny will do.
      const want = answer.decision === "allow" ? ["accept"] : ["decline", "cancel"];
      const option = ask.options.find((o) => want.includes(o.id)) ?? (answer.decision === "deny" ? ask.options.find((o) => o.decision === "deny") : undefined);
      if (option === undefined) return `this approval has no ${answer.decision} option`;
      // A deny's note goes with the refusal to the tool call that asked, where the engine takes one (ask.respond's rule).
      const note = answer.decision === "deny" && ask.accepts_feedback === true && option.id === "decline" ? answer.message?.trim() : undefined;
      return { kind: "approval", option_id: option.id, ...(note ? { feedback: note } : {}) };
    }
    case "question": {
      const text = (answer.text ?? answer.message ?? "").trim();
      if (text === "") return "a question takes text";
      return {
        kind: "question",
        answers: ask.questions.map((q) => {
          const picked = q.options.find((o) => o.label.toLowerCase() === text.toLowerCase());
          return picked ? { question_id: q.id, option_ids: [picked.id] } : { question_id: q.id, option_ids: [], text };
        }),
      };
    }
    case "tool":
      return { kind: "tool", content: answer.content ?? answer.text ?? "", is_error: answer.is_error === true };
    case "secret":
      // A secret never travels in mail: the agent goes on without it (grant it to the service account instead).
      return { kind: "secret", provided: false };
  }
}

/**
 * A deny's note its response could not carry, for an engine that takes none with its deny: steered into the turn that
 * asked instead, as `agent exec` does. An allow's note goes nowhere, as in the app.
 */
export function steeredNote(ask: Extract<SessionEvent, { type: "ask.user" }>["payload"], answer: AnswerPayload, response: AskResponse): string | undefined {
  if (ask.kind !== "approval" || answer.decision !== "deny") return undefined;
  if (response.kind === "approval" && response.feedback !== undefined) return undefined;
  return answer.message?.trim() || undefined;
}
