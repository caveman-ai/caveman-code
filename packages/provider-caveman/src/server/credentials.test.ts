// Chat Completions takes a function's parameters only as a plain object at the root (no anyOf/oneOf there); the
// engine's bash with command sessions declares a union of objects. Found live 2026-10-19: every Caveman-engine turn on an
// OpenAI-compatible endpoint failed at its first request with OpenAI's 400 invalid_function_parameters.
import * as http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { cavemanModels, objectRootTools } from "./credentials.ts";

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** The engine's bash input with command sessions, as the SDK declares it (abridged). */
const BASH_UNION = {
  anyOf: [
    { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    { type: "object", properties: { action: { const: "list", type: "string" } }, required: ["action"] },
    { type: "object", properties: { action: { const: "kill", type: "string" }, sessionId: { type: "string" } }, required: ["sessionId", "action"] },
  ],
};

/** BASH_UNION as one object: every branch's properties, `action`'s consts as an enum, nothing every branch requires. */
const BASH_FLAT = {
  type: "object",
  description: 'Use exactly one of these forms (required fields): {command}; {action: "list"}; {sessionId, action: "kill"}.',
  properties: { command: { type: "string" }, action: { type: "string", enum: ["list", "kill"] }, sessionId: { type: "string" } },
};

/** An OpenAI-compatible endpoint that validates function parameters as OpenAI's Chat Completions does. */
async function strictEndpoint() {
  const seen: Array<Record<string, unknown>> = [];
  const server = http.createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw || "{}") as { tools?: Array<{ function: { name: string; parameters: { type?: unknown } } }> };
    seen.push(body);
    const top = ["oneOf", "anyOf", "allOf", "enum", "const", "not"];
    const bad = (body.tools ?? []).find((tool) => tool.function.parameters.type !== "object" || top.some((key) => key in tool.function.parameters));
    if (bad !== undefined) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `Invalid schema for function '${bad.function.name}': schema must be a JSON Schema of 'type: "object"', got 'type: "${String(bad.function.parameters.type ?? "None")}"'.`, type: "invalid_request_error", code: "invalid_function_parameters" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "coder", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    response.write(chunk({ role: "assistant", content: "ok" }));
    response.write(chunk({}, "stop"));
    response.write(`data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "coder", choices: [], usage: { prompt_tokens: 9, completion_tokens: 1, total_tokens: 10 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen };
}

describe("objectRootTools", () => {
  it("sends a union of objects as one object: every branch's properties, consts as an enum, the forms in its description", () => {
    const payload = { model: "m", tools: [{ type: "function", function: { name: "bash", parameters: BASH_UNION } }] };
    const fixed = objectRootTools(payload) as typeof payload & { tools: Array<{ function: { parameters: Record<string, unknown> } }> };
    expect(fixed.tools[0]!.function.parameters).toEqual(BASH_FLAT);
    // What every branch requires stays required.
    const shared = { anyOf: [{ type: "object", properties: { id: { type: "string" }, a: { type: "string" } }, required: ["id", "a"] }, { type: "object", properties: { id: { type: "string" } }, required: ["id"] }] };
    const flat = (objectRootTools({ tools: [{ type: "function", function: { name: "x", parameters: shared } }] }) as { tools: Array<{ function: { parameters: Record<string, unknown> } }> }).tools[0]!.function.parameters;
    expect(flat.required).toEqual(["id"]);
    // The caller's payload is not mutated.
    expect(payload.tools[0]!.function.parameters).toBe(BASH_UNION);
  });

  it("leaves object roots, unions with a non-object branch and other payload shapes as they came", () => {
    const object = { model: "m", tools: [{ type: "function", function: { name: "read", parameters: { type: "object", properties: {} } } }] };
    expect(objectRootTools(object)).toBe(object);
    const mixed = { model: "m", tools: [{ type: "function", function: { name: "x", parameters: { anyOf: [{ type: "object" }, { type: "string" }] } } }] };
    expect(objectRootTools(mixed)).toBe(mixed);
    // The Responses API's tools carry parameters directly (no `function`) and take the union as it is.
    const responses = { model: "m", tools: [{ type: "function", name: "bash", parameters: BASH_UNION }] };
    expect(objectRootTools(responses)).toBe(responses);
    expect(objectRootTools(undefined)).toBe(undefined);
  });
});

describe("the engine's models on an OpenAI-compatible endpoint", () => {
  it("send bash's union as one object, and the caller's onPayload sees what was sent", async () => {
    const endpoint = await strictEndpoint();
    const models = await import("effect/Effect").then((Effect) =>
      Effect.runPromise(cavemanModels({ "custom-strict": { key: "test-key", endpoint: { name: "Strict", baseUrl: endpoint.url, models: ["coder"] } } })),
    );
    const model = models.getModel("custom-strict", "coder")!;
    const recorded: Array<unknown> = [];
    const reply = await models.completeSimple(
      model,
      {
        messages: [{ role: "user", content: "list sessions", timestamp: Date.now() }],
        tools: [{ name: "bash", description: "Run a command", parameters: BASH_UNION as never }],
      },
      { maxTokens: 16, onPayload: (payload) => void recorded.push(payload) },
    );
    expect(reply.stopReason, reply.errorMessage).toBe("stop");
    const sent = endpoint.seen[0] as { tools: Array<{ function: { parameters: Record<string, unknown> } }> };
    expect(sent.tools[0]!.function.parameters).toEqual(BASH_FLAT);
    expect((recorded[0] as typeof sent).tools[0]!.function.parameters).toEqual(sent.tools[0]!.function.parameters);
  });
});
