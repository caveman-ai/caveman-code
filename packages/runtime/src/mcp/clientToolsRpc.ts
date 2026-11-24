// The `client` MCP server's JSON-RPC (platform CONTRACT §3.5): initialize, tools/list and tools/call over a thread's
// custom tools. The app serves it at /mcp/client (clientToolsEndpoint.ts); `caveman-runtime agent exec` serves the same
// handler on a loopback port of its own (agentExec/clientServer.ts), so every host speaks one server.
import * as Effect from "effect/Effect";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import type { ClientTools } from "../session-protocol/clientTools.ts";
import { CLIENT_MCP_SERVER } from "./clientToolThreads.ts";

const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/** One JSON-RPC message from a thread's engine, answered as JSON: initialize, tools/list and tools/call. */
export const handleClientMcp = (tools: Pick<ClientTools["Service"], "toolsOf" | "call">, threadId: string, message: unknown): Effect.Effect<unknown> => {
  if (message === null || typeof message !== "object" || Array.isArray(message)) return Effect.succeed(rpcError(null, -32600, "one JSON-RPC message per request"));
  const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
  // Notifications and responses need no answer: the server keeps no session with the engine.
  if (id === undefined || typeof method !== "string") return Effect.succeed(undefined);
  const answer = Effect.gen(function* () {
    switch (method) {
      case "ping":
        return {};
      case "initialize": {
        const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: CLIENT_MCP_SERVER, version: RUNTIME_VERSION },
          instructions: "Tools the caller of this session runs for you. A call waits until they answer with its result.",
        };
      }
      case "tools/list":
        return {
          tools: (yield* tools.toolsOf(threadId)).map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.input_schema })),
        };
      case "tools/call": {
        const name = typeof params?.name === "string" ? params.name : "";
        const result = yield* tools.call(threadId, name, params?.arguments ?? {}).pipe(
          Effect.catchTag("ClientToolError", (error) => Effect.succeed({ content: error.message, is_error: true })),
        );
        return { content: [{ type: "text", text: result.content }], isError: result.is_error };
      }
      default:
        return undefined;
    }
  });
  return answer.pipe(
    Effect.map((result) => (result === undefined ? rpcError(id, -32601, `${method} is not served by ${CLIENT_MCP_SERVER}`) : { jsonrpc: "2.0", id, result })),
    Effect.catchDefect((defect) => Effect.succeed(rpcError(id, -32603, defect instanceof Error ? defect.message : String(defect)))),
  );
};

export { rpcError };
