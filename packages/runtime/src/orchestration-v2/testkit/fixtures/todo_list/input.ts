// ), apps/server/src/orchestration-v2/testkit/fixtures/todo_list/input.ts @ ab3a3cd1.
import { TODO_LIST_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function todoListInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: TODO_LIST_PROMPT }],
  };
}
