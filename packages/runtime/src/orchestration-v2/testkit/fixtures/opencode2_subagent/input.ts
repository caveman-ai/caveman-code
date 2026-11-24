// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_subagent/input.ts @ 13aa882c22.
import { OPENCODE2_SUBAGENT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2SubagentInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OPENCODE2_SUBAGENT_PROMPT }] };
}
