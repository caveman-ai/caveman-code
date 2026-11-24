// ), apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/pi_output.ts @ 13aa882c22.
import type { ProviderReplayTranscript } from "@caveman-app/protocol";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { assertPiSettledTokenUsage } from "../simple/pi_output.ts";
import { assertMultiTurnOutput } from "./codex_output.ts";

export function assertPiMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertMultiTurnOutput(result, transcript);
  assertPiSettledTokenUsage(result, transcript);
}
