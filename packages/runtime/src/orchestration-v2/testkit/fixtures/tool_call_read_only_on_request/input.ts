// ), apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only_on_request/input.ts @ ab3a3cd1.
import { TOOL_CALL_WRITE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallReadOnlyOnRequestInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_WRITE_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
