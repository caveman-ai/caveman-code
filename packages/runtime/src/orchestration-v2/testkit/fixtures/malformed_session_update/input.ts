// ), apps/server/src/orchestration-v2/testkit/fixtures/malformed_session_update/input.ts @ 559c4b1f21.
import type { OrchestratorFixtureInput } from "../shared.ts";

export const MALFORMED_SESSION_UPDATE_PROMPT =
  "Respond with the following text: malformed update fixture ok";

/**
 * An agent sends a `usage_update` without the required `used` and `size`
 * mid-turn, the way clanka did (reported 2026-10-15). T3 drops that one
 * update and the turn completes with the text and usage that follow it.
 */
export function malformedSessionUpdateInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: MALFORMED_SESSION_UPDATE_PROMPT }],
  };
}
