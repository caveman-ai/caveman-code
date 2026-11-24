// ), apps/server/src/orchestration-v2/testkit/fixtures/turn_interrupt/input.ts @ ab3a3cd1.
import { TURN_INTERRUPT_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function turnInterruptInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TURN_INTERRUPT_PROMPT },
      { type: "interrupt", targetRunIndex: 1 },
    ],
  };
}
