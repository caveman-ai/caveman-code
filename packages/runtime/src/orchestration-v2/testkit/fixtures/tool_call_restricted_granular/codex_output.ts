// ), apps/server/src/orchestration-v2/testkit/fixtures/tool_call_restricted_granular/codex_output.ts @ ab3a3cd1.
import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@caveman-app/protocol";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
  TOOL_CALL_WRITE_PROMPT,
} from "../shared.ts";

export function assertToolCallRestrictedGranularOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });

  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, [
    "user_message",
    "file_change",
    "approval_request",
    "assistant_message",
  ]);
  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_WRITE_PROMPT]);

  const approval = projection.turnItems.find((item) => item.type === "approval_request");
  assert.equal(
    approval?.prompt,
    "add /home/replay-user/t3code/packages/effect-codex-app-server/.codex-probe-write-action.txt",
  );
}
