// Grill mode's engine-facing pieces: the skill (a Claude plugin dir the
// bundle copies beside its chunks), the MCP server that carries grill_round
// and grill_finish, and the mention the session-protocol layer puts in the
// one turn that loads the skill. Nothing here reaches an engine in default mode.
import { fileURLToPath } from "node:url";

/** The plugin dir: `.claude-plugin/plugin.json` and `skills/grill/SKILL.md` (user-only). */
export const GRILL_PLUGIN_DIR = fileURLToPath(new URL("./grill-plugin", import.meta.url));
export const GRILL_SKILL_PATH = `${GRILL_PLUGIN_DIR}/skills/grill/SKILL.md`;
/** Claude names a plugin's skill `<plugin>:<skill>`. */
export const CLAUDE_GRILL_SKILL = "caveman-grill:grill";
export const CODEX_GRILL_SKILL = "grill";

/** The runtime's grill MCP server: its own endpoint, so it is attached only while a session is in grill mode. */
export const GRILL_MCP_SERVER = "caveman-grill";
export const grillMcpEndpoint = (runtimeEndpoint: string) =>
  `${runtimeEndpoint.replace(/\/+$/, "")}/grill`;
/** A grill round waits for a person, who may take hours. */
export const GRILL_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/** Put first in the engine text of the turn that loads the skill; adapters load it natively and drop the mention. */
export const GRILL_SKILL_MENTION = "$caveman-grill";
// Every one: a context handoff quotes earlier turns, mention included, before the turn's own.
const MENTION = /(^|\s)\$caveman-grill(?:\s+|$)/gu;

/** The text without the mention, or undefined when the turn loads no skill. */
export const takeGrillSkillMention = (text: string): string | undefined => {
  const rest = text.replace(MENTION, "$1");
  return rest === text ? undefined : rest.trim();
};

/** The grill MCP server's tools (mcp/toolkits/grill). */
export const GRILL_TOOL_NAMES = ["grill_round", "grill_finish"] as const;
