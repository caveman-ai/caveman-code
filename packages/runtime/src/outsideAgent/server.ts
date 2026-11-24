// The MCP side of `caveman-code mcp`: Effect's stdio MCP server (docs/ §2.9-10)
// with the 14 tools registered by hand, in their fixed order, so each answers plain text (and image blocks), and a
// failure is a result with isError, never a JSON-RPC error. initialize and tools/list answer from these static
// definitions; only a tool call reaches for Caveman Code.
import * as NodeStdio from "@effect/platform-node/NodeStdio";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import { McpProtocol, McpSchema, McpServer, Tool } from "effect/ai";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import type { Answer, Bridge } from "./bridge.ts";
import { INSTRUCTIONS, TOOLS } from "./tools.ts";

/** The protocol versions offered, newest first. */
export const PROTOCOLS = [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26] as const;

export const toResult = (answer: Answer): McpSchema.CallToolResult =>
  new McpSchema.CallToolResult({
    isError: answer.isError === true,
    content: [
      { type: "text", text: answer.text },
      ...(answer.images ?? []).map((image) => ({ type: "image" as const, data: new Uint8Array(Buffer.from(image.data, "base64")), mimeType: image.mime })),
    ],
  });

/** Every tool, in TOOLS order; a call runs on the bridge with the client's name, and stops when the client cancels it. */
export const registerTools = (bridge: Bridge) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const tool of TOOLS) {
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: tool.name,
          description: Tool.getDescription(tool),
          inputSchema: Tool.getJsonSchema(tool),
          annotations: {
            ...Context.getOption(tool.annotations, Tool.Title).pipe(
              Option.map((title) => ({ title })),
              Option.getOrUndefined,
            ),
            readOnlyHint: Context.get(tool.annotations, Tool.Readonly),
            destructiveHint: Context.get(tool.annotations, Tool.Destructive),
            idempotentHint: Context.get(tool.annotations, Tool.Idempotent),
            openWorldHint: Context.get(tool.annotations, Tool.OpenWorld),
          },
        }),
        annotations: tool.annotations,
        handle: (payload) =>
          Effect.gen(function* () {
            const request = yield* McpSchema.McpRequestContext;
            const answer = yield* Effect.promise((signal) => bridge.call(tool.name, payload, { clientName: request.clientInfo?.name, signal }));
            return toResult(answer);
          }),
      });
    }
  });

/** The server over this process's stdin and stdout; Effect's own logs go to stderr. */
export const serverLayer = (bridge: Bridge) =>
  Layer.effectDiscard(registerTools(bridge)).pipe(
    Layer.provideMerge(
      McpServer.layerStdio({
        name: "Caveman Code",
        version: RUNTIME_VERSION,
        instructions: INSTRUCTIONS,
        protocols: PROTOCOLS,
      }),
    ),
    Layer.provide(NodeStdio.layer),
    Layer.provide(Layer.succeed(Logger.LogToStderr, true)),
  );

/** Runs until stdin ends (the MCP client went away) or the process is stopped. */
export const runServer = (bridge: Bridge): Effect.Effect<never, unknown> =>
  Layer.launch(serverLayer(bridge)).pipe(Effect.provideService(Logger.LogToStderr, true));
