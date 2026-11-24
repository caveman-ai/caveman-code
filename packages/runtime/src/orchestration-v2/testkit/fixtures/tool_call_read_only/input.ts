// ), apps/server/src/orchestration-v2/testkit/fixtures/tool_call_read_only/input.ts @ ab3a3cd1.
import { TOOL_CALL_READ_ONLY_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallReadOnlyInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TOOL_CALL_READ_ONLY_PROMPT }],
  };
}
