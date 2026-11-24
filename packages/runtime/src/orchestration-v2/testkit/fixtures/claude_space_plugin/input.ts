import { fileURLToPath } from "node:url";

import type { OrchestratorFixtureInput } from "../shared.ts";

/** The plugin directory a Space hands Claude Agent for one session. */
export const CLAUDE_SPACE_PLUGIN_DIR = fileURLToPath(new URL("./plugin", import.meta.url));

/** The plugin's namespaced command; the CLI expands it from commands/space-ping.md. */
export const CLAUDE_SPACE_PLUGIN_PROMPT = "/caveman-space-fixture:space-ping";
export const CLAUDE_SPACE_PLUGIN_MARKER = "SPACE_PING_OK";

export function claudeSpacePluginInput(): OrchestratorFixtureInput {
  return { steps: [{ type: "message", text: CLAUDE_SPACE_PLUGIN_PROMPT }] };
}
