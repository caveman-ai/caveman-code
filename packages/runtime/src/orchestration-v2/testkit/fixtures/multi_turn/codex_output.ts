// ), apps/server/src/orchestration-v2/testkit/fixtures/multi_turn/codex_output.ts @ ab3a3cd1.
import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@caveman-app/protocol";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertConversationMessageRoles,
  assertRunOrdinals,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MULTI_TURN_FIRST_PROMPT,
  MULTI_TURN_SECOND_PROMPT,
  projectionFor,
} from "../shared.ts";

export function assertMultiTurnOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({
    result,
    transcript,
    runCount: 2,
    runStatuses: ["completed", "completed"],
  });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertRunOrdinals(projection, [1, 2]);
  assertConversationMessageRoles(projection, ["user", "assistant", "user", "assistant"]);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertUserMessagesInclude(projection, [MULTI_TURN_FIRST_PROMPT, MULTI_TURN_SECOND_PROMPT]);
  assert.equal(projection.turnItems.filter((item) => item.type === "user_message").length, 2);
  assertAssistantTextIncludes(projection, "first fixture turn complete");
  assertAssistantTextIncludes(projection, "second fixture turn complete");
}
