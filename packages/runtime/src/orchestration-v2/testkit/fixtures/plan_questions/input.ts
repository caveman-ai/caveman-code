// ), apps/server/src/orchestration-v2/testkit/fixtures/plan_questions/input.ts @ ab3a3cd1.
import { PLAN_QUESTIONS_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function planQuestionsInput(): OrchestratorFixtureInput {
  return {
    interactionMode: "default",
    steps: [
      { type: "message", text: PLAN_QUESTIONS_PROMPT },
      {
        type: "answer_next_user_input_request",
        answers: {
          schema_vs_ui_flexibility: "Strict schemas (Recommended)",
          schema_preference: "Strict schemas (Recommended)",
          "question-0-schema-vs-flexibility": "Strict schemas",
        },
      },
    ],
  };
}
