// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_interrupt/input.ts @ 13aa882c22.
import { OPENCODE2_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2InterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1, waitForTurnItemType: "command_execution" },
    ],
  };
}
