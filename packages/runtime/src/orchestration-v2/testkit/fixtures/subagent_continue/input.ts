// ), apps/server/src/orchestration-v2/testkit/fixtures/subagent_continue/input.ts @ ab3a3cd1.
import {
  SUBAGENT_CONTINUE_PARENT_PROMPT,
  SUBAGENT_CONTINUE_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function subagentContinueInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: SUBAGENT_CONTINUE_PROMPT },
      { type: "message", text: SUBAGENT_CONTINUE_PARENT_PROMPT },
    ],
  };
}
