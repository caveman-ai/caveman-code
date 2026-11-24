// A one-tool stdio MCP server standing in for a space's MCP server in the live Codex test.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "space-echo", version: "1.0.0" });
server.registerTool(
  "space_echo",
  { description: "Returns the space's check phrase." },
  async () => ({ content: [{ type: "text", text: "SPACE-TOOL-OK" }] }),
);
await server.connect(new StdioServerTransport());
