/**
 * Where an engine reaches a server through the runtime's MCP hub
 * (`McpHub.ts`): one streamable HTTP endpoint per server, on the runtime's
 * own origin, with the thread's runtime MCP credential as the bearer. The
 * hub is the MCP client to the real server, so a sign-in token never leaves
 * the runtime.
 *
 * @module plugins/hubRoute
 */
import { type McpProviderSessionConfig, mcpHubUrl } from "@caveman-app/engine-core/server/mcpSession";
import type { PluginMcpServer } from "@caveman-app/engine-core/server/SessionPlugins";

/**
 * `servers` with the keys `route` picks replaced by their hub endpoint. With
 * no runtime credential for the thread, those keys that are hub-only are
 * left out (nothing else can reach them) and the rest stay as they are.
 */
export function routeThroughHub(
  servers: Readonly<Record<string, PluginMcpServer>>,
  session: Pick<McpProviderSessionConfig, "endpoint" | "authorizationHeader"> | undefined,
  route: (key: string) => boolean,
  hubOnly: ReadonlyArray<string>,
): Record<string, PluginMcpServer> {
  const out: Record<string, PluginMcpServer> = {};
  for (const [key, server] of Object.entries(servers)) {
    if (session !== undefined && route(key)) {
      out[key] = { type: "http", url: mcpHubUrl(session.endpoint, key), headers: { Authorization: session.authorizationHeader } };
    } else if (!hubOnly.includes(key)) {
      out[key] = server;
    }
  }
  return out;
}
