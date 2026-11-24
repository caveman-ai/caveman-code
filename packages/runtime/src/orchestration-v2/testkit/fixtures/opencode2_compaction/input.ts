// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_compaction/input.ts @ 13aa882c22.
import {
  OPENCODE2_COMPACTION_FIRST_PROMPT,
  OPENCODE2_COMPACTION_RECALL_PROMPT,
  type OrchestratorFixtureInput,
} from "../shared.ts";

export function openCode2CompactionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      { type: "message", text: OPENCODE2_COMPACTION_FIRST_PROMPT },
      { type: "message", text: "/compact" },
      { type: "message", text: OPENCODE2_COMPACTION_RECALL_PROMPT },
    ],
  };
}
