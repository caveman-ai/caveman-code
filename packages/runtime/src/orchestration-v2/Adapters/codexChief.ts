// The Chief on Codex: its turn runs in the person's own Codex app-server, on any Codex login (a compact plan or an
// API key). Its instructions replace Codex's base instructions, its tools are Codex dynamic tools answered here, and
// Codex's own are off: no shell, web, image, browser, computer, plugin, app, goal or MCP server tool, and none of the
// person's hooks, skills, memories or AGENTS.md.
//
// What a model declares itself stays, and is contained (checked live on codex-cli 0.165.0, gpt-6.1-sol): every current
// Codex model runs in code mode, so the Chief's tools are reached through Codex's JavaScript `exec` (no require,
// process or fetch there); `apply_patch` is refused by the read-only sandbox under approval "never"; the MCP resource
// tools find no server; and its multi-agent tools start agents with the same surface, no shell either.
import type * as CodexSchema from "@caveman-app/codex-app-server/schema";
import {
  chiefInstructions,
  type ChiefProfile,
} from "@caveman-app/engine-core/server/ChiefSessions";
import type { ThreadId } from "@caveman-app/protocol";
import type * as Schema from "effect/Schema";

/** As on the other engines: chat_start makes worktrees. */
const CHIEF_TOOL_TIMEOUT_MS = 120_000;

/** Thread config that turns off every tool of Codex's own a switch reaches (codex-cli 0.165.0). */
export const CODEX_CHIEF_CONFIG = {
  web_search: "disabled",
  "features.shell_tool": false,
  "features.unified_exec": false,
  "features.view_image": false,
  "features.image_generation": false,
  "features.browser_use": false,
  "features.browser_use_external": false,
  "features.computer_use": false,
  "features.apps": false,
  "features.plugins": false,
  "features.goals": false,
  "features.tool_suggest": false,
  "features.multi_agent": false,
  "features.multi_agent_v2": false,
  "features.sleep_tool": false,
  "features.hooks": false,
  "features.memories": false,
  "memories.use_memories": false,
  "memories.generate_memories": false,
  "tools.experimental_request_user_input.enabled": false,
  "skills.include_instructions": false,
  "skills.bundled.enabled": false,
  project_doc_max_bytes: 0,
} as const;

/** A Chief's turn: nothing asks, and nothing writes. */
export const CODEX_CHIEF_TURN_POLICY = {
  approvalPolicy: "never",
  sandboxPolicy: { type: "readOnly" },
} as const;

/**
 * A Chief's thread params. `mcpServers`: every MCP server the app-server's config names (config/read), each turned
 * off in one `mcp_servers` table, which Codex merges into the person's. Not a dotted key per server: Codex splits a
 * key on every dot and has no quoting, so a server named `a.b` would make the thread fail to load its config (codex-cli
 * 0.165.0: "invalid transport"). Codex keeps the dynamic tools a thread
 * started with: a resume ignores them, and one from an older app keeps its older set.
 */
export function codexChiefThreadParams(profile: ChiefProfile, mcpServers: ReadonlyArray<string>) {
  return {
    baseInstructions: chiefInstructions(profile),
    dynamicTools: profile.tools.map((spec) => ({
      type: "function" as const,
      name: spec.name,
      description: spec.description,
      inputSchema: spec.input as Schema.Json,
    })),
    sandbox: "read-only" as const,
    approvalPolicy: "never" as const,
    config: {
      ...CODEX_CHIEF_CONFIG,
      ...(mcpServers.length === 0
        ? {}
        : {
            mcp_servers: Object.fromEntries(mcpServers.map((name) => [name, { enabled: false }])),
          }),
    } as Readonly<Record<string, Schema.Json>>,
  };
}

/** The MCP servers an app-server's config/read names. */
export const codexConfigMcpServers = (
  config: CodexSchema.V2ConfigReadResponse["config"],
): ReadonlyArray<string> => {
  const servers = config.mcp_servers;
  return servers !== null && typeof servers === "object" && !Array.isArray(servers)
    ? Object.keys(servers)
    : [];
};

/**
 * Codex's `item/tool/call` for a Chief tool, run in the runtime as the Chief's thread inside the app run `runId`
 * names. A failure, or a tool the Chief has not, is the tool's error text.
 */
export async function codexChiefToolCall(
  profile: ChiefProfile,
  threadId: ThreadId,
  call: { readonly tool: string; readonly arguments: unknown; readonly callId: string },
  runId: string,
): Promise<CodexSchema.DynamicToolCallResponse> {
  const answer = (text: string, success: boolean) => ({
    success,
    contentItems: [{ type: "inputText" as const, text }],
  });
  const spec = profile.tools.find((candidate) => candidate.name === call.tool);
  if (spec === undefined) return answer(`No Chief tool ${call.tool}.`, false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${spec.name} took longer than ${CHIEF_TOOL_TIMEOUT_MS / 1000} s`)),
      CHIEF_TOOL_TIMEOUT_MS,
    );
  });
  try {
    const result = await Promise.race([
      spec.run(threadId, call.arguments ?? {}, { callId: call.callId, runId }),
      timedOut,
    ]);
    return answer(typeof result === "string" ? result : JSON.stringify(result), true);
  } catch (cause) {
    return answer(cause instanceof Error ? cause.message : String(cause), false);
  } finally {
    clearTimeout(timer);
  }
}
