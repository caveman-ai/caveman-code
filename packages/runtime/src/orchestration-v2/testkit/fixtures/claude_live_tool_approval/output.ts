import type { ProviderReplayTranscript } from "@caveman-app/protocol";
import { assert } from "@effect/vitest";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAllRuntimeRequestsResolved,
  assertBaseProjection,
  assertReplayLabelPrefixCount,
  assertRuntimeRequestCounts,
  assertRuntimeRequestKinds,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  projectionFor,
} from "../shared.ts";
import { TOOL_CALL_DENIED_WRITE_PROMPT } from "../tool_call_denied_write/input.ts";

/** Recorded on Claude Agent 2.1.300 (haiku): one approval, accepted, one completed write. */
export function assertClaudeLiveToolApprovalOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertUserMessagesInclude(projection, [TOOL_CALL_DENIED_WRITE_PROMPT]);

  assertRuntimeRequestCounts(projection, { total: 1, resolved: 1 });
  assertRuntimeRequestKinds(projection, ["file-change"]);
  assertAllRuntimeRequestsResolved(projection);
  assert.deepEqual(
    projection.runtimeRequests.map((request) => request.decision),
    ["accept"],
  );
  assertReplayLabelPrefixCount(transcript, "permission.request:", 1);
  assertReplayLabelPrefixCount(transcript, "permission.response:", 1);

  const writes = projection.turnItems.filter((item) => item.type === "file_change");
  assert.lengthOf(writes, 1);
  assert.equal(writes[0]?.status, "completed");
}
