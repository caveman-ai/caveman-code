// The Chief on Claude Agent, on any Claude login (a plan, an API key, a cloud lane): its
// turn runs through the person's own Claude Code via the Agent SDK, so the app never handles the claude.ai login. Its instructions are
// the whole system prompt, and its tools (engine-core ChiefSessions) are an in-process MCP server,
// the only tools it has: no built-in tool, no settings files, skills, hooks or plugins.
import { randomUUID } from "node:crypto";

import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { chiefInstructions, type ChiefProfile } from "@caveman-app/engine-core/server/ChiefSessions";
import type { ThreadId } from "@caveman-app/protocol";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export const CHIEF_MCP_SERVER = "chief";
/** As on the Caveman engine: chat_start makes worktrees. */
const CHIEF_TOOL_TIMEOUT_MS = 120_000;

/** Claude Code's names for the Chief's tools, approved up front: the Chief runs full access. */
export const chiefAllowedTools = (profile: ChiefProfile): ReadonlyArray<string> =>
  profile.tools.map((spec) => `mcp__${CHIEF_MCP_SERVER}__${spec.name}`);

/** Reopens the CLI when the Chief's prompt or tool set changes (its rules, the memory brief). */
export const chiefQueryKey = (profile: ChiefProfile) =>
  JSON.stringify({ chief: chiefInstructions(profile), tools: profile.tools.map((spec) => spec.name) });

/**
 * What Claude Code gets for the Chief: its system prompt, no tools of its own, nothing from the person's settings.
 * strictMcpConfig: only the servers passed in. Without it Claude Code still loads user and claude.ai connector
 * servers under setting-sources "", and the Chief's full access would run them unasked.
 */
export const chiefQueryOptions = (profile: ChiefProfile) =>
  ({
    systemPrompt: chiefInstructions(profile),
    tools: [] as ReadonlyArray<string>,
    allowedTools: chiefAllowedTools(profile),
    settingSources: [] as const,
    strictMcpConfig: true,
  }) as const;

/**
 * The Chief's tools as an in-process MCP server, their JSON Schemas as declared. Each call runs in the
 * runtime as the Chief's thread, inside the app run `runId()` names; a failure is the tool's error text.
 */
export function chiefMcpServer(profile: ChiefProfile, threadId: ThreadId, runId: () => string): McpSdkServerConfigWithInstance {
  const server = new McpServer({ name: CHIEF_MCP_SERVER, version: "1.0.0" }, { capabilities: { tools: {} } });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: profile.tools.map((spec) => ({ name: spec.name, description: spec.description, inputSchema: spec.input as { type: "object" } })),
  }));
  server.server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const spec = profile.tools.find((candidate) => candidate.name === request.params.name);
    if (spec === undefined) return { isError: true, content: [{ type: "text" as const, text: `No Chief tool ${request.params.name}.` }] };
    try {
      // Claude Code's tool_use id does not reach an MCP server: each call gets its own.
      const answer = await spec.run(threadId, request.params.arguments ?? {}, { callId: randomUUID(), runId: runId() });
      return { content: [{ type: "text" as const, text: typeof answer === "string" ? answer : JSON.stringify(answer) }] };
    } catch (cause) {
      return { isError: true, content: [{ type: "text" as const, text: cause instanceof Error ? cause.message : String(cause) }] };
    }
  });
  return { type: "sdk", name: CHIEF_MCP_SERVER, instance: server, timeout: CHIEF_TOOL_TIMEOUT_MS };
}
