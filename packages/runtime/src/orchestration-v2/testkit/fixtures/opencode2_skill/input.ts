// ), apps/server/src/orchestration-v2/testkit/fixtures/opencode2_skill/input.ts @ 13aa882c22.
import { OPENCODE2_SKILL_PROMPT, type OrchestratorFixtureInput } from "../shared.ts";

export function openCode2SkillInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: OPENCODE2_SKILL_PROMPT }] };
}
