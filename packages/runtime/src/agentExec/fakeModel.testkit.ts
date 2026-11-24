// A model endpoint on loopback that speaks the real wires, for `agent exec`'s tests: OpenAI Chat Completions
// (`/chat/completions`, streamed as SSE chunks) and Anthropic Messages (`/v1/messages`, streamed as SSE events). Every
// request body is kept as sent, so a test reads exactly the bytes the engine put on the wire (the prefix tests do), and
// what it answers comes from a script that reads the request.
import * as http from "node:http";

/** One reply: text, and or tool calls; usage as the provider reports it. */
export interface FakeReply {
  readonly text?: string;
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly args: Record<string, unknown> }>;
  readonly usage?: { readonly input?: number; readonly output?: number; readonly cached?: number };
  /** Hold the reply this long (a slow model, for interrupts and timeouts). */
  readonly delayMs?: number;
  /** Hold the reply until this settles: the turn runs for as long as the test needs it to. */
  readonly until?: Promise<unknown>;
  /** Answer with this HTTP status and an error body instead. */
  readonly status?: number;
}

export interface FakeRequest {
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly raw: string;
  readonly body: Record<string, unknown>;
}

export interface FakeModel {
  readonly url: string;
  readonly requests: Array<FakeRequest>;
  readonly close: () => Promise<void>;
}

/** The model's requests that are the agent's own turns (not a summarizer's or a cache warm's). */
export const turnRequests = (model: FakeModel) => model.requests.filter((r) => ((r.body.max_tokens ?? r.body.max_completion_tokens) as number | undefined) !== 1);

/** The last message's text a request carries: a user turn or a tool's result. */
export function lastText(body: Record<string, unknown>): string {
  const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
  const last = messages.at(-1);
  const content = last?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part: { text?: string; content?: unknown }) => part.text ?? (typeof part.content === "string" ? part.content : JSON.stringify(part.content ?? ""))).join("");
  return "";
}

const sse = (res: http.ServerResponse, data: unknown, event?: string) => res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`);

function openAiStream(res: http.ServerResponse, model: string, reply: FakeReply) {
  const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model };
  sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
  if (reply.text) sse(res, { ...base, choices: [{ index: 0, delta: { content: reply.text }, finish_reason: null }] });
  for (const [index, call] of (reply.tools ?? []).entries()) {
    sse(res, {
      ...base,
      choices: [{ index: 0, delta: { tool_calls: [{ index, id: `call_${Date.now()}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }],
    });
  }
  const usage = reply.usage ?? {};
  const prompt = usage.input ?? 100;
  sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.tools?.length ? "tool_calls" : "stop" }] });
  sse(res, { ...base, choices: [], usage: { prompt_tokens: prompt + (usage.cached ?? 0), completion_tokens: usage.output ?? 10, total_tokens: prompt + (usage.cached ?? 0) + (usage.output ?? 10), prompt_tokens_details: { cached_tokens: usage.cached ?? 0 } } });
  res.write("data: [DONE]\n\n");
  res.end();
}

function anthropicStream(res: http.ServerResponse, model: string, reply: FakeReply) {
  const usage = reply.usage ?? {};
  sse(res, { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: usage.input ?? 100, output_tokens: 1, cache_read_input_tokens: usage.cached ?? 0, cache_creation_input_tokens: 0 } } }, "message_start");
  let index = 0;
  if (reply.text) {
    sse(res, { type: "content_block_start", index, content_block: { type: "text", text: "" } }, "content_block_start");
    sse(res, { type: "content_block_delta", index, delta: { type: "text_delta", text: reply.text } }, "content_block_delta");
    sse(res, { type: "content_block_stop", index }, "content_block_stop");
    index++;
  }
  for (const call of reply.tools ?? []) {
    sse(res, { type: "content_block_start", index, content_block: { type: "tool_use", id: `toolu_${Date.now()}_${index}`, name: call.name, input: {} } }, "content_block_start");
    sse(res, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(call.args) } }, "content_block_delta");
    sse(res, { type: "content_block_stop", index }, "content_block_stop");
    index++;
  }
  sse(res, { type: "message_delta", delta: { stop_reason: reply.tools?.length ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: usage.output ?? 10 } }, "message_delta");
  sse(res, { type: "message_stop" }, "message_stop");
  res.end();
}

/** Starts the endpoint; `script(request, n)` answers the n-th (from 0) request the agent's turns make. */
export async function startFakeModel(script: (request: FakeRequest, n: number) => FakeReply): Promise<FakeModel> {
  const requests: Array<FakeRequest> = [];
  let turns = 0;
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // kept raw
      }
      const request = { path: req.url ?? "", headers: req.headers, raw, body };
      requests.push(request);
      const anthropic = new URL(req.url ?? "/", "http://fake").pathname.endsWith("/messages");
      const model = String(body.model ?? "fake");
      // A cache warm (max 1 token) or anything not streamed: a short answer, never a script step.
      const warm = ((body.max_tokens ?? body.max_completion_tokens) as number | undefined) === 1 || (anthropic && body.max_tokens === 0);
      const reply: FakeReply = warm ? { text: "", usage: { input: 1, output: 1 } } : script(request, turns++);
      const send = () => {
        if (reply.status !== undefined) {
          res.writeHead(reply.status, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: { message: `fake error ${reply.status}`, type: "invalid_request_error" } }));
          return;
        }
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        if (anthropic) anthropicStream(res, model, reply);
        else openAiStream(res, model, reply);
      };
      if (reply.until) void reply.until.then(send, send);
      else if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
