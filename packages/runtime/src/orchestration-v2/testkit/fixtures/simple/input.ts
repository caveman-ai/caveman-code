// ), apps/server/src/orchestration-v2/testkit/fixtures/simple/input.ts @ ab3a3cd1.
import { SIMPLE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function simpleInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: SIMPLE_PROMPT }],
  };
}
