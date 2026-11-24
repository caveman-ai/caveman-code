// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_background/input.ts @ 13aa882c22.
import { OPENCODE2_BACKGROUND_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2BackgroundInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_BACKGROUND_PROMPT },
      { type: "await_run_status", targetRunIndex: 2, status: "completed" },
    ],
  };
}
