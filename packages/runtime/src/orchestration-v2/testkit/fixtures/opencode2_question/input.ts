// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_question/input.ts @ 13aa882c22.
import { OPENCODE2_QUESTION_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2QuestionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_QUESTION_PROMPT },
      { type: "answer_next_user_input_request", answers: { q0: "blue" } },
    ],
  };
}
