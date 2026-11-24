/**
 * `agent exec`'s session on the harness (execSession.ts) without a network: the real harness (its loadouts, surfaces,
 * policy and tools on a temp workspace, real MCP servers on loopback), with only the model replaced by a scripted
 * stream of Pi's own events. The command end to end, against a model endpoint on the wire, is the runtime's
 * agentExec.test.ts.
 */
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Models,
} from "@earendil-works/pi-ai";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type * as Harness from "@caveman-ai/harness";

import type { ConnectorEffect, ConnectorGate } from "./connectorGate.ts";
import type { ExecModel } from "./execModels.ts";
import {
  openExecSession,
  type ExecApprovalCall,
  type ExecDraft,
  type ExecSession,
  type ExecSessionOptions,
} from "./execSession.ts";

// ── a scripted model ──────────────────────────────────────────

interface Step {
  readonly thinking?: string;
  readonly text?: string;
  readonly tools?: ReadonlyArray<{ readonly name: string; readonly args: unknown }>;
  readonly gate?: Promise<void>;
  readonly hang?: boolean;
  readonly error?: string;
}

const USAGE = {
  input: 120,
  output: 12,
  cacheRead: 30,
  cacheWrite: 0,
  reasoning: 0,
  totalTokens: 162,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function scripted(steps: ReadonlyArray<Step>) {
  const contexts: Array<Context> = [];
  let call = 0;
  const streamSimple = (
    model: { api: string; provider: string; id: string },
    context: Context,
    options?: { signal?: AbortSignal },
  ) => {
    const step = steps[call];
    const id = call++;
    contexts.push(structuredClone(context));
    if (step === undefined) throw new Error(`script exhausted at call ${id + 1}`);
    const stream = createAssistantMessageEventStream();
    const content: AssistantMessage["content"] = [];
    const message = (stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
      role: "assistant",
      content: [...content],
      api: model.api as never,
      provider: model.provider,
      model: model.id,
      usage: USAGE,
      stopReason,
      timestamp: Date.now(),
    });
    void (async () => {
      stream.push({ type: "start", partial: message("stop") });
      if (step.hang === true) {
        await new Promise<void>((resolve) =>
          options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
        stream.push({
          type: "error",
          reason: "aborted",
          error: { ...message("aborted"), errorMessage: "aborted" },
        });
        stream.end();
        return;
      }
      await step.gate;
      if (step.error !== undefined) {
        stream.push({
          type: "error",
          reason: "error",
          error: { ...message("error"), errorMessage: step.error },
        });
        stream.end();
        return;
      }
      if (step.thinking !== undefined) {
        const index = content.length;
        content.push({ type: "thinking", thinking: step.thinking });
        stream.push({ type: "thinking_start", contentIndex: index, partial: message("stop") });
        stream.push({
          type: "thinking_delta",
          contentIndex: index,
          delta: step.thinking,
          partial: message("stop"),
        });
        stream.push({
          type: "thinking_end",
          contentIndex: index,
          content: step.thinking,
          partial: message("stop"),
        });
      }
      if (step.text !== undefined) {
        const index = content.length;
        content.push({ type: "text", text: step.text });
        stream.push({ type: "text_start", contentIndex: index, partial: message("stop") });
        stream.push({
          type: "text_delta",
          contentIndex: index,
          delta: step.text,
          partial: message("stop"),
        });
        stream.push({
          type: "text_end",
          contentIndex: index,
          content: step.text,
          partial: message("stop"),
        });
      }
      for (const [n, tool] of (step.tools ?? []).entries()) {
        const toolCall = {
          type: "toolCall" as const,
          id: `call-${id}-${n}`,
          name: tool.name,
          arguments: tool.args as never,
        };
        content.push(toolCall);
        stream.push({
          type: "toolcall_start",
          contentIndex: content.length - 1,
          partial: message("stop"),
        });
        stream.push({
          type: "toolcall_end",
          contentIndex: content.length - 1,
          toolCall,
          partial: message("stop"),
        });
      }
      const reason = (step.tools ?? []).length > 0 ? "toolUse" : "stop";
      const final = message(reason);
      stream.push({ type: "done", reason, message: final });
      stream.end(final);
    })();
    return stream;
  };
  return { streamSimple, contexts };
}

/** An endpoint model whose catalog is the script: what `execModel` hands the session, minus the network. */
function execModelOf(
  script: ReturnType<typeof scripted>,
  over: { readonly api?: string; readonly provider?: string; readonly id?: string } = {},
): ExecModel {
  const record = {
    id: over.id ?? "test-model",
    name: over.id ?? "test-model",
    api: over.api ?? "openai-completions",
    provider: over.provider ?? "endpoint",
    baseUrl: "http://127.0.0.1:9",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
  };
  const models = {
    getModel: (provider: string, id: string) =>
      provider === record.provider && id === record.id ? record : undefined,
    streamSimple: script.streamSimple,
  } as unknown as Models;
  return {
    model: `${record.provider}/${record.id}`,
    shown: record.id,
    record: record as never,
    models,
    listPrice: (tokens) => (tokens.input + 2 * tokens.output) / 1_000_000,
  };
}

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part: { type?: string; text?: string }) =>
            part.type === "text" ? (part.text ?? "") : "",
          )
          .join("")
      : "";
const userTexts = (context: Context | undefined) =>
  (context?.messages ?? [])
    .filter((message) => message.role === "user")
    .map((message) => textOf(message.content));
const toolNames = (context: Context | undefined) =>
  (
    (
      context?.messages[0] as
        | { readonly toolsAdded?: ReadonlyArray<{ readonly name: string }> }
        | undefined
    )?.toolsAdded ??
    context?.tools ??
    []
  ).map((tool) => tool.name);
const systemText = (context: Context | undefined) =>
  textOf((context?.messages[0] as { content?: unknown } | undefined)?.content) ||
  (context?.systemPrompt ?? "");

// ── MCP servers on loopback ───────────────────────────────────

interface FakeMcp {
  readonly url: string;
  readonly calls: Array<{
    readonly name: string;
    readonly args: unknown;
    readonly headers: IncomingHttpHeaders;
  }>;
}

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

/** A streamable-HTTP MCP server with these tools; a call answers `<name>: <args as JSON>`. */
async function fakeMcp(tools: ReadonlyArray<string>): Promise<FakeMcp> {
  const calls: FakeMcp["calls"] = [];
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    if (request.method !== "POST") return void response.writeHead(405).end();
    const frame = JSON.parse(body);
    if (frame.id === undefined) return void response.writeHead(202).end();
    if (frame.method === "tools/call")
      calls.push({
        name: frame.params.name,
        args: frame.params.arguments,
        headers: request.headers,
      });
    const result =
      frame.method === "initialize"
        ? {
            protocolVersion: frame.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1" },
          }
        : frame.method === "tools/list"
          ? {
              tools: tools.map((name) => ({
                name,
                description: `The ${name} tool.`,
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
              })),
            }
          : {
              content: [
                {
                  type: "text",
                  text: `${frame.params.name}: ${JSON.stringify(frame.params.arguments ?? {})}`,
                },
              ],
            };
    response
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, calls };
}

// ── the session ───────────────────────────────────────────────

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "caveman-exec-session-"));
  writeFileSync(join(dir, "a.txt"), "hello from a\n");
  return dir;
}

interface Opened {
  readonly session: ExecSession;
  readonly drafts: Array<ExecDraft>;
  readonly approvals: Array<ExecApprovalCall>;
  readonly customCalls: Array<{ readonly name: string; readonly input: unknown }>;
  readonly notices: Array<string>;
}

async function open(
  script: ReturnType<typeof scripted>,
  options: Partial<ExecSessionOptions> & {
    readonly deny?: (call: ExecApprovalCall) => string | undefined;
  } = {},
): Promise<Opened> {
  const drafts: Array<ExecDraft> = [];
  const approvals: Array<ExecApprovalCall> = [];
  const customCalls: Opened["customCalls"] = [];
  const notices: Array<string> = [];
  const session = await openExecSession({
    shape: "coding",
    workspace: workspace(),
    agentId: "tester",
    instructions: "You test things.",
    model: execModelOf(script),
    customTools: [],
    mcpServers: [],
    callCustomTool: async (call) => {
      customCalls.push({ name: call.name, input: call.input });
      return { content: `answered ${call.name}`, is_error: false };
    },
    approve: async (call) => {
      approvals.push(call);
      const deny = options.deny?.(call);
      return deny === undefined ? undefined : { deny };
    },
    emit: (draft) => void drafts.push(draft),
    onNotice: (line) => void notices.push(line),
    ...options,
  });
  closers.push(() => session.close());
  return { session, drafts, approvals, customCalls, notices };
}

const started = (drafts: ReadonlyArray<ExecDraft>) =>
  drafts.flatMap((d) => (d.type === "tool.started" ? [d] : []));
const doneOf = (drafts: ReadonlyArray<ExecDraft>, itemId: string) =>
  drafts.find(
    (d): d is Extract<ExecDraft, { type: "tool.done" }> =>
      d.type === "tool.done" && d.item_id === itemId,
  );

describe("agent exec on the harness", () => {
  it("a coding agent: the measured loadout, its calls as drafts, approvals asked for every call and a denial read by the model", async () => {
    const script = scripted([
      {
        thinking: "Look first.",
        tools: [
          { name: "read", args: { path: "a.txt" } },
          { name: "bash", args: { command: "echo approved" } },
          { name: "write", args: { path: "b.txt", content: "no" } },
        ],
      },
      { text: "Read it; the write was declined." },
    ]);
    const { session, drafts, approvals } = await open(script, {
      deny: (call) => (call.effect === "write" ? "declined" : undefined),
    });
    const outcome = await session.runTurn("Look at a.txt, run a command, write b.txt");
    expect(outcome).toEqual({ status: "completed", stop: "done" });
    expect(session.harness.loadout.name).toBe("app-claude");
    expect(toolNames(script.contexts[0])).toEqual(["bash", "edit", "read", "wait", "write"]);
    expect(systemText(script.contexts[0])).toMatch(/^You are a coding agent/);
    // A coding agent's instructions are not its system text (they ride in its first message).
    expect(systemText(script.contexts[0])).not.toContain("You test things.");
    expect(userTexts(script.contexts[0])[0]).toMatch(
      /^<env>\ncwd: [^\n]+\n(os: [^\n]+\n)?(shell: [^\n]+\n)?<\/env>\n\nLook at a\.txt/,
    );

    // Every call comes to the runtime's approvals under the names they know, its effect with it.
    expect(approvals.map((call) => [call.name, call.effect, call.args])).toEqual([
      ["read_file", "read", { path: "a.txt" }],
      ["bash", "external", { command: "echo approved" }],
      ["write_file", "write", { path: "b.txt", content: "no" }],
    ]);
    const tools = started(drafts);
    expect(tools.map((d) => [d.payload.name, d.payload.kind])).toEqual([
      ["read_file", "read"],
      ["bash", "command"],
      ["write_file", "edit"],
    ]);
    expect(approvals.map((call) => call.toolCallId)).toEqual(tools.map((d) => d.item_id));
    expect(doneOf(drafts, tools[0]!.item_id)?.payload).toMatchObject({
      status: "completed",
      result: expect.stringContaining("hello from a"),
    });
    expect(doneOf(drafts, tools[1]!.item_id)?.payload).toEqual({
      status: "completed",
      result: "exit 0\napproved",
    });
    expect(doneOf(drafts, tools[2]!.item_id)?.payload).toEqual({
      status: "declined",
      error: "cave_tool_denied:declined",
    });
    expect(existsSync(join(session.harness.env.cwd, "b.txt"))).toBe(false);
    expect(JSON.stringify(script.contexts[1])).toContain("cave_tool_denied:declined");

    // The turn's drafts in order: started, reasoning, the calls, the answer; spend per model call at list price.
    expect(drafts[0]).toEqual({
      type: "turn.started",
      payload: { engine: "caveman", model: "test-model" },
    });
    expect(drafts.find((d) => d.type === "reasoning.delta")?.payload).toEqual({
      text: "Look first.",
    });
    expect(drafts.filter((d) => d.type === "message.done").map((d) => d.payload)).toEqual([
      { role: "assistant", text: "Read it; the write was declined." },
    ]);
    const usage = drafts.flatMap((d) => (d.type === "usage" ? [d.payload] : []));
    expect(usage).toHaveLength(2);
    expect(usage[0]).toEqual({
      engine: "caveman",
      model: "test-model",
      input_tokens: 120,
      output_tokens: 12,
      cache_read_tokens: 30,
      cache_write_tokens: 0,
      cost: { usd: (120 + 24) / 1_000_000, basis: "list_price" },
      billing: "api_key",
    });
  });

  it("file tools stay in the workspace: a read outside it is refused, a command is not", async () => {
    const outside = mkdtempSync(join(tmpdir(), "caveman-exec-outside-"));
    writeFileSync(join(outside, "secret.txt"), "outside\n");
    const script = scripted([
      { tools: [{ name: "read", args: { path: join(outside, "secret.txt") } }] },
      { text: "Refused." },
    ]);
    const { session, drafts } = await open(script);
    await session.runTurn("Read the file outside");
    const read = started(drafts)[0]!;
    expect(doneOf(drafts, read.item_id)?.payload).toMatchObject({
      status: "failed",
      error: expect.stringContaining("outside the workspace"),
    });
  });

  it("two turns keep the conversation; the env block leads only the first", async () => {
    const script = scripted([{ text: "one" }, { text: "two" }]);
    const { session } = await open(script);
    expect(await session.runTurn("first question")).toMatchObject({ status: "completed" });
    expect(await session.runTurn("second question")).toMatchObject({ status: "completed" });
    const seen = userTexts(script.contexts[1]);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatch(/^<env>[\s\S]*first question$/);
    expect(seen[1]).toBe("second question");
    expect(JSON.stringify(script.contexts[1])).toContain('"one"');
    expect(session.harness.messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
  });

  it("a general agent declares exactly its tools (custom, then its MCP servers'), its instructions the whole system text; custom calls go to the caller", async () => {
    const orders = await fakeMcp(["order_status"]);
    const script = scripted([
      { tools: [{ name: "lookup_invoice", args: { id: "4411" } }] },
      { tools: [{ name: "orders__order_status", args: { id: "9" } }] },
      { text: "Order 9 shipped; invoice 4411 found." },
    ]);
    const { session, drafts, approvals, customCalls } = await open(script, {
      shape: "general",
      instructions: "You answer billing questions.",
      customTools: [
        {
          name: "refund",
          description: "Refund a charge",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
        },
        {
          name: "lookup_invoice",
          description: "Find an invoice",
          input_schema: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      ],
      mcpServers: [{ name: "orders", source: "agent", config: { url: orders.url } }],
    });
    expect(session.harness.loadout.name).toBe("app-general");
    expect(await session.runTurn("Where is order 9, and invoice 4411?")).toMatchObject({
      status: "completed",
    });
    expect(systemText(script.contexts[0])).toBe("You answer billing questions.");
    expect(toolNames(script.contexts[0])).toEqual([
      "lookup_invoice",
      "refund",
      "orders__order_status",
    ]);
    expect(customCalls).toEqual([{ name: "lookup_invoice", input: { id: "4411" } }]);
    expect(JSON.stringify(script.contexts[1])).toContain("answered lookup_invoice");
    // Custom tools never ask; an MCP tool asks as an outside tool, by the name approvals know.
    expect(approvals.map((call) => [call.name, call.effect])).toEqual([
      ["mcp__orders__order_status", "external"],
    ]);
    expect(orders.calls.map((call) => [call.name, call.args])).toEqual([
      ["order_status", { id: "9" }],
    ]);
    expect(started(drafts).map((d) => [d.payload.name, d.payload.kind])).toEqual([
      ["lookup_invoice", "other"],
      ["mcp__orders__order_status", "mcp"],
    ]);
    const mcpDone = doneOf(drafts, started(drafts)[1]!.item_id);
    expect(mcpDone?.payload).toEqual({ status: "completed", result: 'order_status: {"id":"9"}' });
  });

  it("a general agent's custom tool error is the model's to read; an MCP server that fails is left out with a notice", async () => {
    const script = scripted([
      { tools: [{ name: "lookup_invoice", args: { id: "1" } }] },
      { text: "No one answered." },
    ]);
    const { session, drafts, notices } = await open(script, {
      shape: "general",
      customTools: [
        {
          name: "lookup_invoice",
          description: "Find an invoice",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      mcpServers: [
        { name: "broken", source: "agent", config: { command: "/nonexistent/server-binary" } },
      ],
      callCustomTool: async () => ({
        content: "Nobody can answer lookup_invoice in this session.",
        is_error: true,
      }),
    });
    await session.runTurn("Look 1 up");
    expect(toolNames(script.contexts[0])).toEqual(["lookup_invoice"]);
    expect(notices.some((line) => line.startsWith("MCP server broken did not connect"))).toBe(true);
    expect(doneOf(drafts, started(drafts)[0]!.item_id)?.payload).toEqual({
      status: "failed",
      error: "Nobody can answer lookup_invoice in this session.",
    });
  });

  it("a coding agent's custom tools are the client server's, declared beside the surface; its own MCP servers are reached from a program", async () => {
    const client = await fakeMcp(["finish"]);
    const orders = await fakeMcp(["order_status"]);
    const code = [
      'const status = await tools.orders__order_status({ id: "7" });',
      "print(status);",
    ].join("\n");
    const script = scripted([
      { tools: [{ name: "program", args: { code } }] },
      { tools: [{ name: "client__finish", args: { id: "done" } }] },
      { text: "Finished." },
    ]);
    const { session, drafts, approvals } = await open(script, {
      customTools: [
        {
          name: "finish",
          description: "End with a result",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
        },
      ],
      clientServer: { url: client.url, headers: { Authorization: "Bearer client-token" } },
      mcpServers: [{ name: "orders", source: "agent", config: { url: orders.url } }],
    });
    expect(await session.runTurn("Check order 7, then finish")).toMatchObject({
      status: "completed",
    });
    expect(toolNames(script.contexts[0])).toEqual([
      "bash",
      "edit",
      "program",
      "read",
      "wait",
      "write",
      "client__finish",
    ]);
    expect([...session.customToolNames]).toEqual([["client__finish", "finish"]]);
    expect(client.calls.map((call) => [call.name, call.args, call.headers.authorization])).toEqual([
      ["finish", { id: "done" }, "Bearer client-token"],
    ]);
    expect(orders.calls.map((call) => [call.name, call.args])).toEqual([
      ["order_status", { id: "7" }],
    ]);
    // The program never asks itself; the call it makes does; the custom tool never does.
    expect(approvals.map((call) => [call.name, call.effect])).toEqual([
      ["program", "read"],
      ["mcp__orders__order_status", "external"],
    ]);
    expect(started(drafts).map((d) => [d.payload.name, d.payload.kind])).toEqual([
      ["program", "other"],
      ["mcp__orders__order_status", "mcp"],
      ["finish", "mcp"],
    ]);
    expect(doneOf(drafts, started(drafts)[1]!.item_id)?.payload).toEqual({
      status: "completed",
      result: 'order_status: {"id":"7"}',
    });
  });

  it("a steer reaches the running turn at its next step and is said once; with no turn running it is the next turn's", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const script = scripted([
      { gate, tools: [{ name: "bash", args: { command: "true" } }] },
      { text: "Checked the README too." },
      { text: "next" },
    ]);
    const { session, drafts } = await open(script);
    expect(session.steer("too early")).toBe(false);
    const running = session.runTurn("Run the check.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.steer("also check the README")).toBe(true);
    release();
    expect(await running).toMatchObject({ status: "completed" });
    expect(userTexts(script.contexts[1]).at(-1)).toBe("also check the README");
    expect(script.contexts).toHaveLength(2);
    expect(
      drafts
        .filter((d) => d.type === "message.done" && d.payload.role === "user")
        .map((d) => d.payload),
    ).toEqual([{ role: "user", text: "also check the README", delivery: "steer" }]);
  });

  it("Stop: a running turn ends interrupted, and one that came while idle stops the next turn before it reaches the model", async () => {
    const script = scripted([{ hang: true }, { text: "after" }]);
    const { session, drafts } = await open(script);
    const running = session.runTurn("Think forever.");
    await new Promise((resolve) => setTimeout(resolve, 50));
    session.interrupt();
    expect(await running).toMatchObject({ status: "interrupted" });

    session.interrupt();
    const before = drafts.length;
    expect(await session.runTurn("Never sent")).toEqual({ status: "interrupted" });
    expect(drafts.length).toBe(before);
    expect(script.contexts).toHaveLength(1);
    expect(await session.runTurn("Go on")).toMatchObject({ status: "completed" });
    expect(script.contexts).toHaveLength(2);
  });

  it("a model error no retry answers fails the turn with the provider's words", async () => {
    const script = scripted([{ error: "401 invalid api key" }]);
    const { session } = await open(script);
    const outcome = await session.runTurn("Hi");
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toContain("401 invalid api key");
  });

  it("a GPT model on a Responses API gets Codex's exec surface; a cell's command asks as bash and its denial reaches the cell", async () => {
    const code = `const r = await tools.exec_command({ cmd: "echo cell" }); text(String(r.output ?? r));`;
    const script = scripted([
      { tools: [{ name: "exec", args: { input: code } }] },
      { text: "Done." },
    ]);
    const opened = await open(script, {
      model: execModelOf(script, {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-6.1-sol",
      }),
      deny: (call) => (call.name === "bash" ? "declined" : undefined),
    });
    const { session, drafts, approvals } = opened;
    expect(await session.runTurn("Run it.")).toMatchObject({ status: "completed" });
    expect(session.harness.loadout.name).toBe("app-gpt");
    expect(toolNames(script.contexts[0]).sort()).toEqual(["exec", "wait"]);
    expect(approvals.map((call) => [call.name, call.effect, call.args])).toEqual([
      ["exec", "read", { code }],
      ["bash", "external", { command: "echo cell" }],
    ]);
    const nested = started(drafts).find((d) => d.payload.name === "bash")!;
    expect(nested.payload).toMatchObject({ kind: "command", input: { command: "echo cell" } });
    expect(doneOf(drafts, nested.item_id)?.payload).toMatchObject({ status: "declined" });
    expect(JSON.stringify(script.contexts[1])).toContain("cave_tool_denied:declined");
    expect(readFileSync(join(session.harness.env.cwd, "a.txt"), "utf8")).toBe("hello from a\n");
  });
});

// ── Cloud's connector gate ────────────────────────────────────

/**
 * A gate whose card is `tools`, as connectorGate.ts answers it (the gate's wire is connectorGate.test.ts's): a call
 * answers `<flat name>: <args as JSON>`, or the tool's refusal line.
 */
function gateOf(
  tools: ReadonlyArray<{
    readonly flat: string;
    readonly effect: ConnectorEffect;
    readonly refuse?: string;
  }>,
) {
  const calls: Array<{ readonly name: string; readonly args: unknown; readonly raw: boolean }> = [];
  const handles = tools.map(({ flat, refuse }): Harness.McpToolHandle => {
    const split = flat.indexOf("__");
    const answer = (args: unknown) =>
      refuse === undefined
        ? { text: `${flat}: ${JSON.stringify(args)}`, isError: false }
        : { text: refuse, isError: true };
    return {
      server: flat.slice(0, split),
      name: flat.slice(split + 2),
      qualified: flat,
      description: `The ${flat} tool.`,
      inputSchema: { type: "object", properties: { id: { type: "string" } } },
      call: async (args) => {
        calls.push({ name: flat, args, raw: false });
        return answer(args);
      },
      callRaw: async (args) => {
        calls.push({ name: flat, args, raw: true });
        const { text, isError } = answer(args);
        return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
      },
    };
  });
  const connectors: ConnectorGate = {
    tools: handles,
    effects: new Map(tools.map((tool) => [tool.flat, tool.effect])),
    card: "the card",
    revision: 3,
  };
  return { connectors, calls };
}

const READ_ONLY =
  "read_only_here: linear.create_comment writes, and in production this agent may only read linear.";

describe("connectors from Cloud's gate", () => {
  it("a general agent declares custom tools, then the gate's in the card's order, then its own servers'; a call is told and asked under its flat name and the card's effect", async () => {
    const own = await fakeMcp(["list_issues", "search"]);
    const gate = gateOf([
      { flat: "linear__list_issues", effect: "read" },
      { flat: "linear__create_comment", effect: "write", refuse: READ_ONLY },
      { flat: "linear__archive", effect: "write" },
      { flat: "github__get_repo", effect: "read" },
    ]);
    const script = scripted([
      { tools: [{ name: "linear__list_issues", args: { id: "1" } }] },
      { tools: [{ name: "linear__create_comment", args: { id: "2" } }] },
      { text: "Listed; the comment was refused." },
      { text: "Again." },
    ]);
    const spec = (name: string) => ({
      name,
      description: `The custom ${name}.`,
      input_schema: { type: "object", properties: { id: { type: "string" } } },
    });
    const { session, drafts, approvals, notices } = await open(script, {
      shape: "general",
      customTools: [spec("refund"), spec("linear__archive"), spec("lookup_invoice")],
      mcpServers: [{ name: "linear", source: "agent", config: { url: own.url } }],
      connectors: gate.connectors,
    });
    expect(await session.runTurn("List, then comment")).toMatchObject({ status: "completed" });
    expect(toolNames(script.contexts[0])).toEqual([
      "linear__archive",
      "lookup_invoice",
      "refund",
      "linear__list_issues",
      "linear__create_comment",
      "github__get_repo",
      "linear__search",
    ]);
    expect(notices).toEqual([
      "Connector tool linear__archive is named like the custom tool linear__archive; it is left out.",
      "MCP tool linear/list_issues is named like the connector tool linear__list_issues; it is left out.",
    ]);
    // Reached through the gate's handles (callRaw: a declared tool's answer may hold an image), never the own server.
    expect(gate.calls).toEqual([
      { name: "linear__list_issues", args: { id: "1" }, raw: true },
      { name: "linear__create_comment", args: { id: "2" }, raw: true },
    ]);
    expect(own.calls).toEqual([]);
    // The card's effect: a read asks as a read; a write in a connector as an outside tool.
    expect(approvals.map((call) => [call.name, call.effect, call.args])).toEqual([
      ["linear__list_issues", "read", { id: "1" }],
      ["linear__create_comment", "external", { id: "2" }],
    ]);
    const tools = started(drafts);
    expect(
      tools.map((d) => [d.payload.name, d.payload.title, d.payload.kind, d.payload.input]),
    ).toEqual([
      ["linear__list_issues", "linear__list_issues", "mcp", { id: "1" }],
      ["linear__create_comment", "linear__create_comment", "mcp", { id: "2" }],
    ]);
    expect(approvals.map((call) => call.toolCallId)).toEqual(tools.map((d) => d.item_id));
    expect(doneOf(drafts, tools[0]!.item_id)?.payload).toEqual({
      status: "completed",
      result: 'linear__list_issues: {"id":"1"}',
    });
    // A refusal reaches the model as the gate wrote it, and the turn goes on.
    expect(doneOf(drafts, tools[1]!.item_id)?.payload).toEqual({
      status: "failed",
      error: READ_ONLY,
    });
    expect(JSON.stringify(script.contexts[2])).toContain(READ_ONLY);
    // The list is read once: the next turn declares the same tools.
    expect(await session.runTurn("Once more")).toMatchObject({ status: "completed" });
    expect(toolNames(script.contexts[3])).toEqual(toolNames(script.contexts[0]));
  });

  it("a coding agent reaches the gate's tools from a program, before its own servers'; each call told and asked under its flat name", async () => {
    const orders = await fakeMcp(["order_status"]);
    const gate = gateOf([
      { flat: "linear__list_issues", effect: "read" },
      { flat: "linear__create_comment", effect: "write" },
    ]);
    const code = [
      'print(await tools.linear__list_issues({ id: "7" }));',
      'try { await tools.linear__create_comment({ id: "8" }); } catch (error) { print(String(error)); }',
    ].join("\n");
    const script = scripted([{ tools: [{ name: "program", args: { code } }] }, { text: "Done." }]);
    const { session, drafts, approvals } = await open(script, {
      mcpServers: [{ name: "orders", source: "agent", config: { url: orders.url } }],
      connectors: gate.connectors,
      deny: (call) => (call.name === "linear__create_comment" ? "declined" : undefined),
    });
    expect(await session.runTurn("List the issues, then comment")).toMatchObject({
      status: "completed",
    });
    // Not declared: reached from the program, whose description lists the gate's tools first.
    expect(toolNames(script.contexts[0])).toEqual([
      "bash",
      "edit",
      "program",
      "read",
      "wait",
      "write",
    ]);
    const context = script.contexts[0] as
      | {
          readonly messages: ReadonlyArray<{
            readonly toolsAdded?: ReadonlyArray<{
              readonly name: string;
              readonly description: string;
            }>;
          }>;
          readonly tools?: ReadonlyArray<{ readonly name: string; readonly description: string }>;
        }
      | undefined;
    const declared = context?.messages[0]?.toolsAdded ?? context?.tools ?? [];
    const program = declared.find((tool) => tool.name === "program")!.description;
    expect(program.indexOf("linear__list_issues(")).toBeGreaterThan(0);
    expect(program.indexOf("linear__create_comment(")).toBeGreaterThan(
      program.indexOf("linear__list_issues("),
    );
    expect(program.indexOf("orders__order_status(")).toBeGreaterThan(
      program.indexOf("linear__create_comment("),
    );
    expect(approvals.map((call) => [call.name, call.effect])).toEqual([
      ["program", "read"],
      ["linear__list_issues", "read"],
      ["linear__create_comment", "external"],
    ]);
    const tools = started(drafts);
    expect(tools.map((d) => [d.payload.name, d.payload.kind])).toEqual([
      ["program", "other"],
      ["linear__list_issues", "mcp"],
      ["linear__create_comment", "mcp"],
    ]);
    expect(doneOf(drafts, tools[1]!.item_id)?.payload).toEqual({
      status: "completed",
      result: 'linear__list_issues: {"id":"7"}',
    });
    expect(doneOf(drafts, tools[2]!.item_id)?.payload).toEqual({
      status: "declined",
      error: "cave_tool_denied:declined",
    });
    // The declined write never reached the gate.
    expect(gate.calls).toEqual([{ name: "linear__list_issues", args: { id: "7" }, raw: false }]);
  });

  it("a GPT model's exec cell reaches a gate tool as mcp__<flat name>; it is told under the flat name", async () => {
    const gate = gateOf([{ flat: "linear__list_issues", effect: "read" }]);
    const code =
      'const r = await tools.mcp__linear__list_issues({ id: "5" }); text(JSON.stringify(r));';
    const script = scripted([
      { tools: [{ name: "exec", args: { input: code } }] },
      { text: "Done." },
    ]);
    const { session, drafts, approvals } = await open(script, {
      model: execModelOf(script, {
        api: "openai-responses",
        provider: "openai",
        id: "gpt-6.1-sol",
      }),
      connectors: gate.connectors,
    });
    expect(await session.runTurn("List them.")).toMatchObject({ status: "completed" });
    expect(approvals.map((call) => [call.name, call.effect])).toEqual([
      ["exec", "read"],
      ["linear__list_issues", "read"],
    ]);
    const nested = started(drafts).find((d) => d.payload.name === "linear__list_issues")!;
    expect(nested.payload).toMatchObject({ kind: "mcp", input: { id: "5" } });
    expect(doneOf(drafts, nested.item_id)?.payload).toMatchObject({ status: "completed" });
    expect(gate.calls).toEqual([{ name: "linear__list_issues", args: { id: "5" }, raw: true }]);
  });

  it("code shape (computer: code): uses app-code loadout (program without sandbox + direct MCP) and rejects sandbox", async () => {
    const gate = gateOf([{ flat: "linear__list_issues", effect: "read" }]);
    const orders = await fakeMcp(["order_status"]);
    const code = 'const r = await tools.linear__list_issues({ id: "3" }); print(r);';
    const script = scripted([
      { tools: [{ name: "program", args: { code } }] },
      { tools: [{ name: "orders__order_status", args: { id: "8" } }] },
      { text: "All checked." },
    ]);
    await expect(
      open(script, {
        shape: "code",
        sandbox: { controlURL: "http://127.0.0.1:1", relayURL: "http://127.0.0.1:1", apiKey: "k" },
      }),
    ).rejects.toThrow(/computer: code.*takes no sandbox/);

    const { session, drafts, approvals } = await open(script, {
      shape: "code",
      instructions: "Compose tool calls cleanly.",
      connectors: gate.connectors,
      mcpServers: [{ name: "orders", source: "agent", config: { url: orders.url } }],
    });
    expect(await session.runTurn("Check linear and orders.")).toMatchObject({
      status: "completed",
    });
    expect(session.harness.loadout.name).toBe("app-code");
    expect(toolNames(script.contexts[0])).toEqual([
      "program",
      "linear__list_issues",
      "orders__order_status",
    ]);
    expect(approvals.map((call) => [call.name, call.effect])).toEqual([
      ["program", "read"],
      ["linear__list_issues", "read"],
      ["mcp__orders__order_status", "external"],
    ]);
    expect(gate.calls).toEqual([{ name: "linear__list_issues", args: { id: "3" }, raw: false }]);
    expect(orders.calls.map((call) => [call.name, call.args])).toEqual([
      ["order_status", { id: "8" }],
    ]);
    const nested = started(drafts).find((d) => d.payload.name === "linear__list_issues")!;
    expect(nested.payload).toMatchObject({ kind: "mcp", input: { id: "3" } });
  });

  it("restores prior messages when resuming from a checkpoint", async () => {
    const script = scripted([{ text: "Continuing with the answer." }]);
    const { session } = await open(script, {
      shape: "general",
      instructions: "Answer concisely.",
      messages: [
        { role: "user", content: [{ type: "text", text: "Earlier question" }], timestamp: 1 },
        {
          role: "assistant",
          content: [{ type: "text", text: "Earlier reply" }],
          api: "anthropic-messages",
          provider: "anthropic",
          model: "claude-sonnet-5-5",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 2,
        },
      ],
    });
    expect(await session.runTurn("Follow up")).toMatchObject({ status: "completed" });
    expect(userTexts(script.contexts[0])).toContain("Earlier question");
    expect(userTexts(script.contexts[0]).at(-1)).toBe("Follow up");
  });
});
