// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_simple/input.ts @ 13aa882c22.
import { OPENCODE2_SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2SimpleInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OPENCODE2_SIMPLE_PROMPT }] };
}
