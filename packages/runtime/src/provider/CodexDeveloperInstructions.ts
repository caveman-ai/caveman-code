// ), apps/server/src/provider/CodexDeveloperInstructions.ts @ ab3a3cd1.
import type { V2TurnStartParams__AdditionalContextEntry } from "@caveman-app/codex-app-server/schema";
import { buildRuntimeInstructions } from "@caveman-app/engine-core/server/runtimeInstructions";

import {
  CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS,
  CAVEMAN_CODE_ORCHESTRATION_SECTIONS,
} from "@caveman-app/engine-core/server/orchestrationInstructions";

/**
 * Codex cuts the middle out of any `additionalContext` value over 1,000 tokens,
 * which it counts as UTF-8 bytes divided by four. It does this silently, so
 * every value built here has to fit.
 */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

const CAVEMAN_CODE_DEVICE_TOOL_INSTRUCTIONS = `## Caveman Code devices

For iOS Simulators and Android Emulators here, call \`device_list\`, then \`device_open\`. Drive the device with the exact \`agent-device\` launcher and flags it returns, on every command. Prefer \`agent-device snapshot -i\` refs over coordinates. Use \`device_screenshot\` to see the screen. Use \`xcrun simctl\` or \`adb\` only for builds, logs, and ports. If a platform is unavailable, say so.`;

export interface CavemanCodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | CavemanCodeToolAvailability,
): CavemanCodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/**
 * Each block is omitted entirely when its tools aren't attached. Describing
 * `preview_*` or `device_*` tools that aren't in the turn's tool list would be
 * worse than saying nothing: the instructions actively steer the model away
 * from Playwright, agent-browser, and raw simctl/adb, so leaving them in would
 * talk it out of the only automation it still has.
 */
const toolInstructions = (availability: boolean | CavemanCodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? CAVEMAN_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/**
 * Caveman Code context for `turn/start.additionalContext`. Codex renders each entry
 * as a `<key>value</key>` developer message and resends it only when the value
 * changes.
 *
 * This must stay out of the collaboration mode: when the model catalog ships
 * its own text for a mode, as newer models do, Codex uses that text and drops
 * the client's `developer_instructions` entirely.
 */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  /**
   * Whether the `caveman-code` MCP server is attached to this turn. Callers derive
   * it from the session's actual MCP configuration rather than re-reading the
   * setting, so the prompt cannot claim tools the turn doesn't have.
   */
  toolsAvailable: boolean | CavemanCodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Separate keys keep each value under Codex's per-entry cap. Codex emits
  // entries in key order, so the numbering preserves the authored order.
  return {
    ...Object.fromEntries(
      CAVEMAN_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `caveman_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    caveman_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { caveman_code_tools: { kind: "application", value: tools } } : {}),
  };
}
