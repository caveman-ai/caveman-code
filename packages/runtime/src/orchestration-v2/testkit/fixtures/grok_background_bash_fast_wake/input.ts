// ), apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/input.ts @ 13aa882c22.
import type { OrchestratorFixtureInput } from "../shared.ts";
import { GROK_BACKGROUND_BASH_PROMPT } from "../grok_background_bash/input.ts";

export function grokBackgroundBashFastWakeInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: GROK_BACKGROUND_BASH_PROMPT },
      { type: "finish_held_run", targetRunIndex: 1, status: "completed" },
      { type: "finish_held_run", targetRunIndex: 2, status: "completed" },
    ],
  };
}
