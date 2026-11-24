// The `client` MCP server's engine-facing pieces (session-protocol/clientTools.ts holds the asks): its name, path
// and timeout, and the threads whose agent file declares custom tools, which adapters read synchronously when they
// attach MCP servers, as they read setup chats' threads. Nothing here reaches a thread without custom tools.
import type { CustomToolDecl } from "@caveman-app/automations";

/** A custom tool as the agent file declares it (the one agent loader reads them: @caveman-app/automations). */
export type CustomTool = CustomToolDecl;

export const CLIENT_MCP_SERVER = "client";
export const CLIENT_MCP_PATH = "/mcp/client";
export const clientMcpEndpoint = (runtimeEndpoint: string) => `${runtimeEndpoint.replace(/\/+$/, "")}/client`;
/** A custom tool waits for whoever drives the session, who may take hours. */
export const CLIENT_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;

/** Threads with custom tools, and the tools: kept by ClientTools.setTools and reloaded from the store at start. */
export const clientToolThreads = new Map<string, ReadonlyArray<CustomTool>>();

/** The tools' names as Claude Agent's allow rules spell them: they ask the session's driver, so never also the engine's approval. */
export const claudeClientToolRules = (tools: ReadonlyArray<CustomTool>) => tools.map((tool) => `mcp__${CLIENT_MCP_SERVER}__${tool.name}`);
