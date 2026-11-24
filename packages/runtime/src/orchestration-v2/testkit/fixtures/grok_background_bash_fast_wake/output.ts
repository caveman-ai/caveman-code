// ), apps/server/src/orchestration-v2/testkit/fixtures/grok_background_bash_fast_wake/output.ts @ 13aa882c22.
import type { ProviderReplayTranscript } from "@caveman-app/protocol";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertGrokBackgroundBashOutput } from "../grok_background_bash/output.ts";

export function assertGrokBackgroundBashFastWakeOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertGrokBackgroundBashOutput(result, transcript, "Run tock loop in background");
}
