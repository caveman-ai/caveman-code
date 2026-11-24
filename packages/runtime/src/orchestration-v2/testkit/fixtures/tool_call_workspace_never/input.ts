// ), apps/server/src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/input.ts @ ab3a3cd1.
import { TOOL_CALL_WRITE_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function toolCallWorkspaceNeverInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TOOL_CALL_WRITE_PROMPT }],
  };
}
