// Cloud's connector gate on loopback, for `agent exec`'s tests: one session endpoint that answers tools/list with a
// card and tools/call from a script, in the relay's bytes (Caveman Cloud connector relay; the client's
// own tests hold the exact bytes, provider-caveman connectorGate.test.ts). Every call is kept with its headers and the
// time it arrived, and `onCall` runs as it arrives, before it is answered.
import * as http from "node:http";

export interface GateTool {
  readonly connector: string;
  readonly tool: string;
  readonly effect: "read" | "write" | "external";
}

export interface GateCall {
  readonly name: string;
  readonly arguments: unknown;
  readonly headers: http.IncomingHttpHeaders;
  /** When it arrived (Date.now()). */
  readonly at: number;
}

export interface FakeGate {
  /** The session's endpoint: what CAVEMAN_CONNECTORS_URL holds. */
  readonly url: string;
  readonly lists: Array<{ readonly headers: http.IncomingHttpHeaders }>;
  readonly calls: Array<GateCall>;
  readonly close: () => Promise<void>;
}

const ANNOTATIONS = {
  read: { readOnlyHint: true, destructiveHint: false },
  write: { readOnlyHint: false, destructiveHint: true },
  external: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
} as const;

/** A card tool as the relay lists one. */
const cardTool = ({ connector, tool, effect }: GateTool) => ({
  name: `${connector}__${tool}`,
  description: `${tool.replaceAll("_", " ")} in ${connector}.`,
  inputSchema: { type: "object", properties: { team: { type: "string" } } },
  annotations: ANNOTATIONS[effect],
  _meta: {
    "caveman/connector": connector,
    "caveman/tool": tool,
    "caveman/effect": effect,
    "caveman/pinned": {},
  },
});

export async function startFakeGate(options: {
  readonly card: ReadonlyArray<GateTool>;
  /** Answer tools/list with this status (and no card) instead. */
  readonly listStatus?: number;
  /** A call's answer; by default `ran <tool>`. */
  readonly answer?: (call: GateCall) => { readonly text: string; readonly isError?: boolean };
  readonly onCall?: (call: GateCall) => void;
}): Promise<FakeGate> {
  const lists: FakeGate["lists"] = [];
  const calls: Array<GateCall> = [];
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const at = Date.now();
      const frame = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: number;
        method: string;
        params?: { name: string; arguments?: unknown };
      };
      const send = (status: number, result?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(
          result === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }),
        );
      };
      if (frame.method === "tools/list") {
        lists.push({ headers: req.headers });
        if (options.listStatus !== undefined) return send(options.listStatus);
        return send(200, {
          tools: options.card.map(cardTool),
          _meta: { "caveman/card": "the card", "caveman/revision": 5 },
        });
      }
      const call: GateCall = {
        name: frame.params?.name ?? "",
        arguments: frame.params?.arguments,
        headers: req.headers,
        at,
      };
      calls.push(call);
      options.onCall?.(call);
      const answer = options.answer?.(call) ?? {
        text: `ran ${call.name.slice(call.name.indexOf("__") + 2)}`,
      };
      send(200, {
        content: [{ type: "text", text: answer.text }],
        isError: answer.isError === true,
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}/relay/v1/sessions/0199e2a0-3333-7000-8000-000000000001/mcp`,
    lists,
    calls,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
