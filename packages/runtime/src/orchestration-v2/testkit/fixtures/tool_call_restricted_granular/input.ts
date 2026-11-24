// ), apps/server/src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/input.ts @ ab3a3cd1.
import { TOOL_CALL_WRITE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallRestrictedGranularInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_WRITE_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
