// A coding agent's custom tools on `agent exec`: the app's `client` MCP server (mcp/clientToolsRpc.ts), served on a
// loopback port of this process with a bearer only the engine holds, so the engine declares them beside its coding
// tools exactly as it does in an app chat. A call is answered by `call`, which waits for whoever drives the session.
import { randomBytes } from "node:crypto";
import * as http from "node:http";

import type { CustomToolDecl } from "@caveman-app/automations";
import * as Effect from "effect/Effect";

import { handleClientMcp, rpcError } from "../mcp/clientToolsRpc.ts";

const MAX_BODY = 4 * 1024 * 1024;

export interface ClientServer {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly close: () => Promise<void>;
}

export async function startClientServer(
  tools: ReadonlyArray<CustomToolDecl>,
  call: (name: string, input: unknown) => Promise<{ readonly content: string; readonly is_error: boolean }>,
): Promise<ClientServer> {
  const token = randomBytes(24).toString("base64url");
  const service = {
    toolsOf: () => Effect.succeed(tools),
    call: (_thread: string, name: string, input: unknown) =>
      Effect.promise(() =>
        tools.some((tool) => tool.name === name)
          ? call(name, input).catch((error: unknown) => ({ content: error instanceof Error ? error.message : String(error), is_error: true }))
          : Promise.resolve({ content: `${name} is not one of this session's custom tools.`, is_error: true }),
      ),
  };
  const server = http.createServer((req, res) => {
    const reply = (status: number, body?: unknown) => {
      if (!res.headersSent) res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };
    if (req.method !== "POST") return reply(405);
    if (req.headers.authorization !== `Bearer ${token}`) return reply(401, { error: "invalid_mcp_credential" });
    const chunks: Array<Buffer> = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size <= MAX_BODY) chunks.push(chunk);
    });
    req.on("end", () => {
      let message: unknown;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, rpcError(null, -32700, "the body is not JSON"));
      }
      // A tool call waits for the caller's answer: its headers go now, so the engine's client never times out on them.
      if ((message as { method?: unknown } | null)?.method === "tools/call") {
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.flushHeaders();
      }
      void Effect.runPromise(handleClientMcp(service, "exec", message)).then((answer) => (answer === undefined ? reply(202) : reply(200, answer)));
    });
  });
  // Answers may take as long as the caller does.
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/mcp/client`,
    headers: { Authorization: `Bearer ${token}` },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
