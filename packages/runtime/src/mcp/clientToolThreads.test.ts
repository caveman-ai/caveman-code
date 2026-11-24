// Custom tools reach every engine as the `client` MCP server, on the thread whose agent declares them only.
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import { afterEach, expect, test } from "vitest";

import { claudeClientMcp, claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { codexMcpServersOf, codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { cavemanRuntimeTools } from "./cavemanRuntimeTools.ts";
import { clientToolThreads } from "./clientToolThreads.ts";

const tool = { name: "lookup_order", description: "Looks an order up.", input_schema: { type: "object", properties: { id: { type: "string" } } } };
const session = (threadId: string) => ({
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make(threadId),
  providerSessionId: "mcp-session",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer thread-token",
  browserToolsAvailable: false,
});

afterEach(() => clientToolThreads.clear());

test("Claude Agent: the client server and its allow rules for a thread with custom tools, nothing for any other", () => {
  clientToolThreads.set("caveman:with", [tool]);
  expect(claudeClientMcp("caveman:without", session("caveman:without"))).toBeUndefined();
  const client = claudeClientMcp("caveman:with", session("caveman:with"))!;
  expect(client.server).toMatchObject({ type: "http", url: "http://127.0.0.1:43123/mcp/client", headers: { Authorization: "Bearer thread-token" } });
  expect(client.allowedTools).toEqual(["mcp__client__lookup_order"]);
  expect(claudeMcpQueryOverrides({ mcpSession: session("caveman:with"), readOnlySandbox: false, clientRules: client.allowedTools }).allowedTools).toContain("mcp__client__lookup_order");
});

test("Codex: the client server is in the thread's config only when it has custom tools", () => {
  const servers = (clientTools?: boolean) => codexMcpServersOf(codexThreadRuntimeParams({ mcpSession: session("caveman:with"), ...(clientTools ? { clientTools } : {}) }).config) as Record<string, Record<string, unknown>>;
  expect(servers().client).toBeUndefined();
  expect(servers(true).client).toMatchObject({ url: "http://127.0.0.1:43123/mcp/client", http_headers: { Authorization: "Bearer thread-token" }, default_tools_approval_mode: "approve" });
});

test("the Caveman engine: the client tools declared for that thread (provider-caveman attaches the server)", () => {
  clientToolThreads.set("caveman:with", [tool]);
  const client = cavemanRuntimeTools.client!;
  expect(client.tools("caveman:without")).toEqual([]);
  expect(client.tools("caveman:with")).toEqual([{ tool: "lookup_order", description: "Looks an order up.", input: tool.input_schema, timeoutMs: 24 * 60 * 60 * 1_000 }]);
  expect(client.endpoint("http://127.0.0.1:43123/mcp")).toBe("http://127.0.0.1:43123/mcp/client");
});
