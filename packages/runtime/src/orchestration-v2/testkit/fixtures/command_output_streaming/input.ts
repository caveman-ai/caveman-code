// ), apps/server/src/orchestration-v2/testkit/fixtures/command_output_streaming/input.ts @ a5d97921f6.
import { COMMAND_OUTPUT_STREAMING_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function commandOutputStreamingInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: COMMAND_OUTPUT_STREAMING_PROMPT }],
  };
}
