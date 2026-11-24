// A stand-in for the Anthropic Messages API that records every request and answers from a script, as ADEMark's
// replay server (bench/replay in zqkra/ademark) does for its Track A: the app's real Claude Code sends real requests,
// no model runs, nothing leaves this computer. Each request's body is kept (auth headers never are), so the token
// tests can read what the app put in it.
//
// Track B's model: ADEMark's B3 prompt reads its two files (two Read calls, then an answer); anything else gets one
// short answer that ends with the arena's canary. Track A runs on ADEMark's own replay server (harness.ts startReplay).
import * as http from "node:http";
import type { AddressInfo } from "node:net";

export interface Usage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
}

export interface CapturedRequest {
  readonly at_ms: number;
  readonly path: string;
  readonly user_agent: string;
  readonly body: Record<string, unknown>;
  readonly bytes: number;
  /** In pass-through mode: what the real API reported for this request. */
  usage?: Usage;
}

export interface FakeModel {
  readonly url: string;
  readonly requests: Array<CapturedRequest>;
  /** Text streams this many tokens per second (ADEMark: 80). */
  tokensPerSecond: number;
  close(): Promise<void>;
}

type Block =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

const CHUNK_CHARS = 16;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let ids = 0;
const nextId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}${(ids++).toString(36).padStart(6, "0")}`;

/** The first user message's text: the chat's prompt, which keys its script. */
function promptOf(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role: string; content: unknown }>)
    : [];
  for (const message of messages) {
    if (message.role !== "user") continue;
    const parts =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : (message.content as Array<{ type: string; text?: string }>);
    // Claude Code puts its own reminders before the person's words; the last text part is what they typed.
    const texts = parts
      .filter(
        (p) =>
          p.type === "text" &&
          typeof p.text === "string" &&
          !p.text.startsWith("<system-reminder>"),
      )
      .map((p) => p.text!);
    if (texts.length > 0) return texts.at(-1)!.trim();
  }
  return "";
}

/** How many tool results the conversation holds: the step of a scripted tool loop. */
function toolResults(body: Record<string, unknown>): number {
  const messages = Array.isArray(body.messages)
    ? (body.messages as Array<{ role: string; content: unknown }>)
    : [];
  let count = 0;
  for (const message of messages)
    if (message.role === "user" && Array.isArray(message.content))
      count += (message.content as Array<{ type: string }>).filter(
        (p) => p.type === "tool_result",
      ).length;
  return count;
}

/** What the model says next, for the conversation in this request. */
function script(body: Record<string, unknown>): { blocks: Array<Block> } {
  const prompt = promptOf(body);
  const done = toolResults(body);
  if (/^Read src\/paginate\.ts and src\/dates\.ts/.test(prompt) && done === 0) {
    return {
      blocks: [
        { type: "text", text: "Reading both files." },
        {
          type: "tool_use",
          id: nextId("toolu_"),
          name: "Read",
          input: { file_path: "src/paginate.ts" },
        },
        {
          type: "tool_use",
          id: nextId("toolu_"),
          name: "Read",
          input: { file_path: "src/dates.ts" },
        },
      ],
    };
  }
  return {
    blocks: [
      { type: "text", text: "LEDGERMARK. Hi! How can I help you with Ledger?\n\nledger-ok" },
    ],
  };
}

const sse = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function streamReply(
  res: http.ServerResponse,
  model: string,
  plan: ReturnType<typeof script>,
  tps: number,
) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  const write = (event: string, data: unknown) => res.write(sse(event, data));
  write("message_start", {
    type: "message_start",
    message: {
      id: nextId("msg_"),
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  // 50 ms chunks of 16 characters is ADEMark's pace; tokensPerSecond scales it (4 characters a token).
  const chunkMs = Math.max(1, Math.round((CHUNK_CHARS / 4 / tps) * 1000));
  let index = 0;
  for (const block of plan.blocks) {
    if (block.type === "text") {
      write("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "text", text: "" },
      });
      for (let at = 0; at < block.text.length; at += CHUNK_CHARS) {
        write("content_block_delta", {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text.slice(at, at + CHUNK_CHARS) },
        });
        if (tps < 1e6) await sleep(chunkMs);
      }
    } else {
      write("content_block_start", {
        type: "content_block_start",
        index,
        content_block: { type: "tool_use", id: block.id, name: block.name, input: {} },
      });
      write("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
      });
    }
    write("content_block_stop", { type: "content_block_stop", index });
    index++;
  }
  const toolUse = plan.blocks.some((b) => b.type === "tool_use");
  write("message_delta", {
    type: "message_delta",
    delta: { stop_reason: toolUse ? "tool_use" : "end_turn", stop_sequence: null },
    usage: { output_tokens: 16 },
  });
  write("message_stop", { type: "message_stop" });
  res.end();
}

/** Reads the usage out of a Messages API answer, streamed or not. */
function usageOf(text: string): Usage | undefined {
  const usage: Usage = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  let found = false;
  const take = (u: Partial<Usage> | undefined) => {
    if (!u) return;
    found = true;
    for (const key of Object.keys(usage) as Array<keyof Usage>)
      if (typeof u[key] === "number") usage[key] = u[key]!;
  };
  if (text.trimStart().startsWith("{")) {
    try {
      take((JSON.parse(text) as { usage?: Usage }).usage);
    } catch {
      return undefined;
    }
    return found ? usage : undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue;
    try {
      const event = JSON.parse(line.slice(6)) as {
        type: string;
        message?: { usage?: Usage };
        usage?: Usage;
      };
      if (event.type === "message_start") take(event.message?.usage);
      if (event.type === "message_delta") take(event.usage);
    } catch {
      // A partial line: the next one is whole.
    }
  }
  return found ? usage : undefined;
}

/**
 * Pass-through: every request goes on to `upstream` (the real API) with its own headers, and its answer comes back as
 * it streams. Only the body and the reported usage are kept; the credential is never read or stored.
 */
function forward(
  upstream: string,
  req: http.IncomingMessage,
  raw: Buffer,
  res: http.ServerResponse,
  captured?: CapturedRequest,
) {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers))
    if (
      typeof value === "string" &&
      !["host", "connection", "content-length", "accept-encoding"].includes(key)
    )
      headers[key] = value;
  void fetch(new URL(req.url ?? "/", upstream), {
    method: req.method ?? "POST",
    headers,
    ...(raw.length > 0 ? { body: new Uint8Array(raw) } : {}),
  })
    .then(async (answer) => {
      const out: Record<string, string> = {};
      answer.headers.forEach((value, key) => {
        if (
          !["content-encoding", "content-length", "transfer-encoding", "connection"].includes(key)
        )
          out[key] = value;
      });
      res.writeHead(answer.status, out);
      let text = "";
      const decoder = new TextDecoder();
      for await (const chunk of answer.body ?? []) {
        res.write(chunk);
        if (captured) text += decoder.decode(chunk as Uint8Array, { stream: true });
      }
      res.end();
      const usage = captured ? usageOf(text) : undefined;
      if (captured && usage) captured.usage = usage;
    })
    .catch(() => res.destroy());
}

export async function startFakeModel(
  options: { tokensPerSecond?: number; upstream?: string } = {},
): Promise<FakeModel> {
  const requests: Array<CapturedRequest> = [];
  const state = { tokensPerSecond: options.tokensPerSecond ?? 80 };
  const started = performance.now();
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks);
      const path = (req.url ?? "/").split("?")[0]!;
      let body: Record<string, unknown> = {};
      try {
        body = raw.length > 0 ? (JSON.parse(raw.toString("utf8")) as Record<string, unknown>) : {};
      } catch {
        // Not JSON: kept as its size only.
      }
      if (options.upstream !== undefined) {
        const captured =
          req.method === "POST" && path === "/v1/messages"
            ? {
                at_ms: performance.now() - started,
                path,
                user_agent: String(req.headers["user-agent"] ?? ""),
                body,
                bytes: raw.length,
              }
            : undefined;
        if (captured) requests.push(captured);
        forward(options.upstream, req, raw, res, captured);
        return;
      }
      if (req.method === "POST" && path === "/v1/messages/count_tokens") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ input_tokens: Math.ceil(raw.length / 4) }));
        return;
      }
      if (req.method !== "POST" || path !== "/v1/messages") {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ type: "error", error: { type: "not_found_error", message: path } }),
        );
        return;
      }
      requests.push({
        at_ms: performance.now() - started,
        path,
        user_agent: String(req.headers["user-agent"] ?? ""),
        body,
        bytes: raw.length,
      });
      const model = typeof body.model === "string" ? body.model : "claude-opus-5-5";
      const plan = script(body);
      if (body.stream === true) {
        void streamReply(res, model, plan, state.tokensPerSecond).catch(() => res.destroy());
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: nextId("msg_"),
          type: "message",
          role: "assistant",
          model,
          content: plan.blocks.map((b) =>
            b.type === "text" ? { type: "text", text: b.text || "ok" } : b,
          ),
          stop_reason: plan.blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 16 },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    get tokensPerSecond() {
      return state.tokensPerSecond;
    },
    set tokensPerSecond(value: number) {
      state.tokensPerSecond = value;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
