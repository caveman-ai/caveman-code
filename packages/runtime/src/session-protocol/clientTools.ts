// Custom tools that return to whoever drives the session (Caveman Cloud CONTRACT §3.5). An agent file may declare
// `tools: [{type: custom, name, description, input_schema}]`; every engine sees them as the `client` MCP server
// (mcp/clientToolsEndpoint.ts). A call is an ask.user of kind `tool` the runtime journals itself, as a grill round
// is: the workspace needs input until it is answered with the tool's result (ask.respond, or an `answer` mail on a
// Cloud computer), and the agent reads that result as the tool's. On This Mac a person answers it in the ask card.
import { randomUUID } from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";

import { clientToolThreads, type CustomTool } from "../mcp/clientToolThreads.ts";
import type { DraftEvent } from "./projector.ts";
import { makeRuntimeAsks, type AskResponse } from "./runtimeAsks.ts";
import * as Store from "./store.ts";
import type { WorkspaceRecord } from "./store.ts";

export const TOOL_ASK_PREFIX = "tool:";
export const isToolAsk = (askId: string) => askId.startsWith(TOOL_ASK_PREFIX);

export { CLIENT_MCP_PATH, CLIENT_MCP_SERVER, CLIENT_TOOL_TIMEOUT_MS, claudeClientToolRules, clientMcpEndpoint, clientToolThreads, type CustomTool } from "../mcp/clientToolThreads.ts";

/** The answer the agent reads as the tool's result. */
export interface ToolResult {
  readonly content: string;
  readonly is_error: boolean;
}

/** What the agent reads when a custom tool call fails without an answer. */
export class ClientToolError extends Schema.TaggedError<ClientToolError>()("ClientToolError", { message: Schema.String }) {}

/** Why ask.respond refused a custom tool's answer (handlers.ts maps it to a ProtocolError). */
export class ClientToolRespondError extends Schema.TaggedError<ClientToolRespondError>()("ClientToolRespondError", {
  reason: Schema.Literals(["not_found", "invalid_state", "invalid_params"]),
  message: Schema.String,
}) {}

const fail = (message: string) => Effect.fail(new ClientToolError({ message }));
const now = () => new Date().toISOString();
const toolsKey = (threadId: string) => `client_tools:${threadId}`;

export class ClientTools extends Context.Service<
  ClientTools,
  {
    /** The custom tools a thread's agent declares; none for most threads. */
    readonly toolsOf: (threadId: string) => Effect.Effect<ReadonlyArray<CustomTool>>;
    /** Gives a thread its agent's custom tools (before its engine starts, so the engine lists them). */
    readonly setTools: (threadId: string, tools: ReadonlyArray<CustomTool>) => Effect.Effect<void>;
    /** Posts the call for the thread's running turn and waits for its answer. */
    readonly call: (threadId: string, name: string, input: unknown) => Effect.Effect<ToolResult, ClientToolError>;
    /** ask.respond for a custom tool call. */
    readonly respond: (record: WorkspaceRecord, askId: string, response: AskResponse) => Effect.Effect<void, ClientToolRespondError>;
  }
>()("caveman/session-protocol/ClientTools") {}

export const make = Effect.gen(function* () {
  const store = yield* Store.SessionStore;
  const { withState, askEvent, resolvedOutcome, close, runningTurn } = makeRuntimeAsks(store);
  for (const row of yield* store.sql<{ key: string; value: string }>`SELECT key, value FROM caveman_sp_kv WHERE key LIKE 'client_tools:%'`.pipe(Effect.orDie)) {
    clientToolThreads.set(row.key.slice("client_tools:".length), JSON.parse(row.value) as ReadonlyArray<CustomTool>);
  }

  const toolsOf = (threadId: string) =>
    store.kvGet(toolsKey(threadId)).pipe(Effect.map((raw): ReadonlyArray<CustomTool> => (raw === undefined ? [] : (JSON.parse(raw) as ReadonlyArray<CustomTool>))));

  const call = (threadId: string, name: string, input: unknown) =>
    Effect.gen(function* () {
      const tool = (yield* toolsOf(threadId)).find((t) => t.name === name);
      if (tool === undefined) return yield* fail(`${name} is not one of this session's custom tools.`);
      const record = yield* store.getByThread(threadId);
      if (record === undefined) return yield* fail("Custom tools work only in a Caveman Code session.");
      const runId = yield* runningTurn(threadId);
      const askId = `${TOOL_ASK_PREFIX}${randomUUID()}`;
      // Subscribe before the ask is journaled, so its answer cannot slip past.
      const sub = yield* PubSub.subscribe(store.events);
      const ask = yield* withState(record, (state) => {
        state.asks[askId] = "open";
        const payload = { kind: "tool" as const, name: tool.name, ...(tool.description ? { description: tool.description } : {}), input: input ?? {} };
        const draft = { at: now(), type: "ask.user", item_id: askId, ...(runId ? { turn_id: runId } : {}), payload } as DraftEvent;
        return { value: draft, drafts: [draft] };
      });
      const resolved = yield* Effect.gen(function* () {
        while (true) {
          const event = yield* PubSub.take(sub);
          if (event.type === "ask.resolved" && event.item_id === askId) return event;
        }
      }).pipe(
        // The tool call ended without an answer (the engine gave up or the turn stopped).
        Effect.onInterrupt(() => close(record, ask, "cancelled").pipe(Effect.asVoid)),
      );
      const response = resolved.payload.response;
      if (resolved.payload.outcome !== "answered" || response?.kind !== "tool") {
        return yield* fail(`Nobody answered ${name} (${resolved.payload.outcome}). Stop and wait for the next message.`);
      }
      return { content: response.content, is_error: response.is_error === true };
    }).pipe(Effect.scoped);

  return ClientTools.of({
    toolsOf,
    setTools: (threadId, tools) =>
      store.kvSet(toolsKey(threadId), JSON.stringify(tools)).pipe(
        Effect.tap(() => Effect.sync(() => (tools.length > 0 ? clientToolThreads.set(threadId, tools) : clientToolThreads.delete(threadId)))),
      ),
    call,
    respond: (record, askId, response) =>
      Effect.gen(function* () {
        const ask = yield* askEvent(record.session.id, askId);
        if (ask === undefined || ask.payload.kind !== "tool") return yield* new ClientToolRespondError({ reason: "not_found", message: `no ask ${askId}` });
        if (response.kind !== "tool") return yield* new ClientToolRespondError({ reason: "invalid_params", message: "a custom tool call takes a tool response: content and is_error" });
        const answered = yield* close(record, ask, "answered", response);
        if (!answered) {
          const outcome = yield* resolvedOutcome(record.session.id, askId);
          return yield* new ClientToolRespondError({
            reason: "invalid_state",
            message: outcome === "cancelled" ? "this tool call was cancelled (the turn stopped)" : "this ask was already answered",
          });
        }
      }),
  });
});

export const layer = Layer.effect(ClientTools, make).pipe(Layer.provide(Store.layer));
