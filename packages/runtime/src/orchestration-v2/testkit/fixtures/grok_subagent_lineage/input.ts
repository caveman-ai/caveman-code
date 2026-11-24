// ), apps/server/src/orchestration-v2/testkit/fixtures/grok_subagent_lineage/input.ts @ 13aa882c22.
import type { OrchestratorFixtureInput } from "../shared.ts";

const GROK_SUBAGENT_LINEAGE_PROMPT = "audit this codebase";

export function grokSubagentLineageInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: GROK_SUBAGENT_LINEAGE_PROMPT }],
  };
}
