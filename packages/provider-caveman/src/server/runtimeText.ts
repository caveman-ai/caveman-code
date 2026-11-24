/**
 * The runtime's text in the Caveman engine's prompt: upstream orchestration, pull request and browser instructions, only
 * for the tools this session actually has, chosen once per session.
 *
 * Why once: the prompt is the cache prefix. A credential that later gains or loses browser access must not add or
 * drop text mid-session: that rewrites every cached token after it and, on preserved-thinking Claude models,
 * invalidates every later thinking block. A tool that went away answers its call with an error; one that arrived
 * later is still found in the code tool (searchTools).
 *
 * Why trimmed: upstream text serves every harness. One paragraph is about a transport this engine never has (an MCP
 * server attached lazily, after the first tool-catalog scan): the Caveman engine attaches the runtime's server
 * before the first request and lists it in its own prompt. (The ACP terminal fallback goes to ACP agents only.)
 *
 * @module provider-caveman/server/runtimeText
 */
import type { McpProviderSessionConfig } from "@caveman-app/engine-core/server/mcpSession";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@caveman-app/engine-core/server/runtimeInstructions";
import {
  CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS,
  CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS,
} from "@caveman-app/engine-core/server/orchestrationInstructions";

/** Which runtime instruction blocks a session's prompt carries. */
export interface RuntimeTextChoice {
  /** The caveman-code orchestration tools (delegate_task, threads, scheduling, secrets, html). */
  readonly orchestration: boolean;
  /** The pull request tools (link, watch). */
  readonly pullRequests: boolean;
  /** The shared browser (preview_*). */
  readonly browser: boolean;
}

/** The blocks for the tools this credential actually grants. No credential: none. */
export function runtimeTextChoice(runtimeMcp: Pick<McpProviderSessionConfig, "browserToolsAvailable" | "capabilities"> | undefined): RuntimeTextChoice {
  if (runtimeMcp === undefined) return { orchestration: false, pullRequests: false, browser: false };
  // A credential without a capability list predates them and grants orchestration and pull requests (McpSessionRegistry).
  return {
    orchestration: runtimeMcp.capabilities === undefined || runtimeMcp.capabilities.has("orchestration"),
    pullRequests: runtimeMcp.capabilities === undefined || runtimeMcp.capabilities.has("pull-requests"),
    browser: runtimeMcp.browserToolsAvailable,
  };
}

/** Paragraphs of upstream orchestration text that describe other harnesses' transports, matched by their opening words. */
const OTHER_HARNESS_PARAGRAPHS = ["Caveman Code tools may load late"] as const;

/**
 * upstream orchestration text without the paragraphs about other harnesses. Throws when upstream text no longer has them,
 * so a re-port that rewords them fails a test instead of silently shipping them again.
 */
export function cavemanOrchestrationInstructions(text: string = CAVEMAN_CODE_ORCHESTRATION_INSTRUCTIONS): string {
  const paragraphs = text.split("\n\n");
  for (const opening of OTHER_HARNESS_PARAGRAPHS) {
    if (!paragraphs.some((paragraph) => paragraph.startsWith(opening))) {
      throw new Error(`caveman runtime text: Caveman Code orchestration paragraph not found: ${opening}`);
    }
  }
  return paragraphs.filter((paragraph) => !OTHER_HARNESS_PARAGRAPHS.some((opening) => paragraph.startsWith(opening))).join("\n\n");
}

const CAVEMAN_ORCHESTRATION_INSTRUCTIONS = cavemanOrchestrationInstructions();

/** The runtime blocks for a choice, in a fixed order. */
export function runtimeInstructionBlocks(choice: RuntimeTextChoice): string[] {
  return [
    ...(choice.orchestration ? [CAVEMAN_ORCHESTRATION_INSTRUCTIONS] : []),
    ...(choice.pullRequests ? [PULL_REQUEST_LINKING_INSTRUCTIONS] : []),
    ...(choice.browser ? [CAVEMAN_CODE_BROWSER_TOOL_INSTRUCTIONS] : []),
  ];
}

/** A note the engine appends after tool results (runawayStop): engine text, not something the person said. */
export const HARNESS_NOTE_PREFIX = "[harness note]";

export function isHarnessNote(text: string): boolean {
  return text.startsWith(HARNESS_NOTE_PREFIX);
}
