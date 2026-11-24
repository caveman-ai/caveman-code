// The `client` MCP server (platform CONTRACT §3.5): the custom tools a thread's agent file declares, served at
// /mcp/client to that thread only, on its runtime MCP credential. Every engine attaches it like the runtime's own
// server, so Claude Agent, Codex and the Caveman engine see the same tools. A call is a ClientTools ask the
// session's driver answers (the person here, an `answer` mail on a Cloud computer); the answer is the tool's result.
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ClientTools } from "../session-protocol/clientTools.ts";
import { CLIENT_MCP_PATH } from "./clientToolThreads.ts";
import { handleClientMcp, rpcError } from "./clientToolsRpc.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export { handleClientMcp };

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/** `POST /mcp/client`: only a thread's runtime MCP credential gets in, and it sees only its own thread's tools. */
export const layerRoute = Layer.unwrap(
  Effect.gen(function* () {
    const tools = yield* ClientTools;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    return HttpRouter.add(
      "*",
      CLIENT_MCP_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });
        const authorization = request.headers.authorization ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
        const invocation = token === "" ? undefined : yield* registry.resolve(token);
        const threadId = invocation?.thread?.threadId;
        if (threadId === undefined) return json({ error: "invalid_mcp_credential", message: "A thread's Caveman Code MCP credential is required." }, 401);
        const body = yield* Effect.option(request.json);
        if (Option.isNone(body)) return json(rpcError(null, -32700, "the body is not JSON"), 400);
        const answer = yield* handleClientMcp(tools, threadId, body.value);
        return answer === undefined ? HttpServerResponse.empty({ status: 202 }) : json(answer);
      }),
    );
  }),
);
