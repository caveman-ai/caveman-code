// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_tool_call/input.ts @ 13aa882c22.
import { OPENCODE2_TOOL_CALL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2ToolCallInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OPENCODE2_TOOL_CALL_PROMPT }] };
}
