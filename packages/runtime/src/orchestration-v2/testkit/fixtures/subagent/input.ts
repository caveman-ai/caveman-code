// ), apps/server/src/orchestration-v2/testkit/fixtures/subagent/input.ts @ ab3a3cd1.
import { SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function subagentInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SUBAGENT_PROMPT }],
  };
}
