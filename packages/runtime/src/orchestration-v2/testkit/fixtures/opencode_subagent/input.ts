// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode_subagent/input.ts @ 13aa882c22.
import { OPENCODE_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCodeSubagentInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: OPENCODE_SUBAGENT_PROMPT }],
  };
}
