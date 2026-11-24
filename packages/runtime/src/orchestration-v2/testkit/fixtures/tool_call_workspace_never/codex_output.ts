// ), apps/server/src/orchestration-v2/testkit/fixtures/tool_call_workspace_never/codex_output.ts @ ab3a3cd1.
import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@caveman-app/protocol";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

export function assertToolCallWorkspaceNeverOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "command_execution", "assistant_message"]);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assert.equal(projection.turnItems.filter((item) => item.type === "approval_request").length, 0);
}
