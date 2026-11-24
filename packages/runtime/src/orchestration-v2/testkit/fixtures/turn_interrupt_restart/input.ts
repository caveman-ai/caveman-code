// ), apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt_restart/input.ts @ ab3a3cd1.
import {
  TURN_INTERRUPT_MID_TOOL_PROMPT,
  TURN_INTERRUPT_RECOVERY_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function turnInterruptRestartInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_MID_TOOL_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
      { type: "message", text: TURN_INTERRUPT_RECOVERY_PROMPT },
    ],
  };
}
