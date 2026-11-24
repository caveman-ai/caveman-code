// ), apps/server/src/orchestration-v2/testkit/fixtures/web_search/input.ts @ ab3a3cd1.
import { type OrchestratorFixtureInput, WEB_SEARCH_PROMPT } from "../shared.ts";

export function webSearchInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: WEB_SEARCH_PROMPT }],
  };
}
