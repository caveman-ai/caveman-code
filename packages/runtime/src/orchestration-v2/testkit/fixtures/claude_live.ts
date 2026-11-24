import { ProviderInstanceId, type ModelSelection } from "@caveman-app/protocol";

/**
 * Caveman Code's own Claude Agent recordings: the cheapest model, on the
 * user's installed CLI and plan login (scripts/record-claude-agent-sdk-replay-fixture.ts).
 */
export const CLAUDE_LIVE_MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-haiku-4-5",
} satisfies ModelSelection;
