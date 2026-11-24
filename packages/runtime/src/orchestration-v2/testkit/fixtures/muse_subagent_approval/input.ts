// ), apps/server/src/orchestration-v2/testkit/fixtures/muse_subagent_approval/input.ts @ 13aa882c22.
import { SUBAGENT_V2_APPROVAL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function museSubagentApprovalInput(): OrchestratorFixtureInput {
  return {
    runtimeMode: "approval-required",
    steps: [
      { type: "message", text: SUBAGENT_V2_APPROVAL_PROMPT },
      { type: "approve_next_runtime_request" },
    ],
  };
}
