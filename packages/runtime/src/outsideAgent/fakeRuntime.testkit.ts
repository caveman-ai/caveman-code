// A stand-in for the runtime's Session Protocol endpoint, for `caveman-code mcp`'s tests: a loopback WebSocket server
// that checks the bearer token, answers `outside_agent.become` as the runtime half will (and refuses everything else
// on a socket that hasn't become an agent, as the gate does for agents), records every frame per socket, and can
// publish itself as a home's runtime (server-runtime.json and the 0600 token) so liveRuntime finds it.
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import type { AddressInfo } from "node:net";

import { WebSocketServer, type WebSocket } from "ws";

export interface Frame {
  readonly socket: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export type Reply = unknown | { readonly error: { readonly code: number; readonly message: string; readonly data?: { readonly reason: string } } };

export interface FakeRuntime {
  readonly origin: string;
  readonly url: string;
  readonly token: string;
  readonly frames: Array<Frame>;
  /** Answers by method; `outside_agent.become` and `engine.list` have defaults. */
  readonly handlers: Map<string, (params: Record<string, unknown>, socket: number) => Reply>;
  /** Sockets opened so far. */
  sockets(): number;
  notify(method: string, params: unknown): void;
  /** Closes every open socket (a blip: the client reconnects). */
  dropAll(): void;
  /** Writes <home>/userdata/server-runtime.json and the token as the runtime does. */
  publish(home: string): void;
  close(): Promise<void>;
}

export const forbidden = (message: string) => ({ error: { code: -32007, message, data: { reason: "forbidden" } } });

export async function startFakeRuntime(token = "owner-token-for-tests"): Promise<FakeRuntime> {
  const server = http.createServer((_request, response) => response.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true });
  const open = new Map<number, WebSocket>();
  const agents = new Set<number>();
  const frames: Array<Frame> = [];
  const handlers = new Map<string, (params: Record<string, unknown>, socket: number) => Reply>([
    ["outside_agent.become", (params) => ({ name: String(params.name), level: params.at_most ?? "supervised" })],
    ["engine.list", () => ({ engines: [] })],
  ]);
  let count = 0;
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${token}`) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const id = ++count;
      open.set(id, ws);
      ws.on("close", () => (open.delete(id), agents.delete(id)));
      ws.on("message", (data) => {
        const message = JSON.parse(String(data)) as { id: number; method: string; params?: Record<string, unknown> };
        const params = message.params ?? {};
        frames.push({ socket: id, method: message.method, params });
        const reply = (body: Reply) =>
          ws.send(JSON.stringify(body !== null && typeof body === "object" && "error" in body ? { jsonrpc: "2.0", id: message.id, error: body.error } : { jsonrpc: "2.0", id: message.id, result: body }));
        if (message.method === "outside_agent.become" && agents.has(id)) return reply(forbidden("become runs once per connection"));
        // liveRuntime's probe is an owner call; anything else must come after become, as the gate would see it.
        if (message.method !== "outside_agent.become" && message.method !== "engine.list" && !agents.has(id)) return reply(forbidden(`owner call ${message.method} from caveman-code mcp`));
        const handler = handlers.get(message.method);
        if (!handler) return reply({ error: { code: -32601, message: `unknown method ${message.method}` } });
        const result = handler(params, id);
        if (message.method === "outside_agent.become" && !(result !== null && typeof result === "object" && "error" in result)) agents.add(id);
        reply(result);
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    url: `ws://127.0.0.1:${port}/session/v1`,
    token,
    frames,
    handlers,
    sockets: () => count,
    notify: (method, params) => {
      for (const [id, ws] of open) if (agents.has(id)) ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    },
    dropAll: () => {
      for (const ws of open.values()) ws.terminate();
    },
    publish: (home) => {
      const dir = path.join(home, "userdata");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.chmodSync(dir, 0o700);
      // This process's pid, recorded as started now: after its real start, so it never reads as a reused pid.
      const record = { pid: process.pid, origin, startedAt: new Date().toISOString() };
      fs.writeFileSync(path.join(dir, "server-runtime.json"), JSON.stringify(record), { mode: 0o600 });
      fs.writeFileSync(path.join(dir, "session-protocol.token"), token, { mode: 0o600 });
    },
    close: async () => {
      for (const ws of open.values()) ws.terminate();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
