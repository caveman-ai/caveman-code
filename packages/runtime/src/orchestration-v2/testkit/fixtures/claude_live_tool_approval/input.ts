import type { OrchestratorFixtureInput } from "../shared.ts";
import { TOOL_CALL_DENIED_WRITE_PROMPT } from "../tool_call_denied_write/input.ts";

/** Ask mode: the Write call asks, and the user approves it. */
export function claudeLiveToolApprovalInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: TOOL_CALL_DENIED_WRITE_PROMPT },
      { type: "approve_next_runtime_request", decision: "accept" },
    ],
  };
}
