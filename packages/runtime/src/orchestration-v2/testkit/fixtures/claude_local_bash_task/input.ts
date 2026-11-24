// ), apps/server/src/orchestration-v2/testkit/fixtures/claude_local_bash_task/input.ts @ ab3a3cd1.
import { CLAUDE_LOCAL_BASH_TASK_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function claudeLocalBashTaskInput(): OrchestratorFixtureInput {
  return {
    steps: [{ type: "message", text: CLAUDE_LOCAL_BASH_TASK_PROMPT }],
  };
}
