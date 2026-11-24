// ), apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_mid_tool/input.ts @ ab3a3cd1.
import { TURN_INTERRUPT_MID_TOOL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function turnInterruptMidToolInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}
