// Claude Agent and Codex on a chosen model, on the wire: the request leaves the
// engine's egress scrub for the app's own caveman-proxies (the real binaries, record mode, one home), which pass it
// through whole, keep the model, decide no route and record its usage, never a saving. Compression left the app on
// 2026-10-27, so no request is shortened and no chat is handed caveman_retrieve. Hermetic: the provider is a
// loopback stub, the proxies' home a temp dir, nothing reaches a model. Skipped without the binaries
// (CAVEMAN_PROXY_BIN and CAVEMAN_MCP_BIN, or the bundle's bin/).
import { spawn } from "node:child_process";
import * as net from "node:net";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as sqlite from "node:sqlite";

import { createScrubber } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { startEgressProxy, type EgressProxy } from "../secrets/EgressScrub.ts";
import { CLAUDE_RETRIEVE_TOOL, routeClaudeOptions, routeCodexLaunch, withCodexThreadEgress } from "../secrets/EngineEgress.ts";
import { readRequestSavings } from "./requestSavings.ts";
import type { ClaudeAgentSdkQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { AppProxy, appProxy, appProxyEnv, codexProxy, findMcpBinary, findProxyBinary, setAppProxyHome } from "./proxyLauncher.ts";

const proxyBin = findProxyBinary();
const mcpBin = findMcpBinary();

/** A long build log: what a test run or a verbose command hands the agent. */
const BIG_LOG = Array.from({ length: 1_500 }, (_, i) =>
  i % 97 === 13
    ? `2026-10-17T10:${String(i % 60).padStart(2, "0")}:00Z ERROR worker-3 job ${i} failed: connection reset by peer (retry 2/5)`
    : `2026-10-17T10:${String(i % 60).padStart(2, "0")}:00Z INFO  worker-${i % 8} job ${i} ok in ${(i * 7) % 900} ms, ${i % 13} rows, cache hit`,
).join("\n");

/** Codex's own log, so its request is not the Claude one's, reused. */
const CODEX_LOG = BIG_LOG.replaceAll("worker-", "shard-").replaceAll("job ", "task ");

type Seen = { path: string; body: Buffer; headers: http.IncomingHttpHeaders };

const anthropicStream = (model: string) =>
  [
    ["message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, usage: { input_tokens: 900, output_tokens: 1 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "One job failed." } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } }],
    ["message_stop", { type: "message_stop" }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

const responsesStream = (model: string) =>
  [
    ["response.created", { type: "response.created", response: { id: "resp_1", model, status: "in_progress" } }],
    ["response.completed", { type: "response.completed", response: { id: "resp_1", model, status: "completed", output: [], usage: { input_tokens: 900, output_tokens: 5, total_tokens: 905, input_tokens_details: { cached_tokens: 0 } } } }],
  ]
    .map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");

const post = (url: string, headers: Record<string, string>, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }).then(async (response) => ({
    status: response.status,
    text: await response.text(),
  }));

type Row = Record<string, string | number | null>;
const rows = (home: string): Array<Row> => {
  const db = new sqlite.DatabaseSync(path.join(home, "caveman.db"), { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT session_id, session_correlation_basis, provider, model, route_from, route_to, route_reason, runtime_mode, agent_slug, auth_mode, request_bytes, optimization_ids, basis, savings_usd, total_cost_usd,
                compression_tokens_before, compression_tokens_after, recovery_handle, raw_request_sha256, transformed_request_sha256
         FROM requests ORDER BY id`,
      )
      .all() as Array<Row>;
  } finally {
    db.close();
  }
};

describe.skipIf(proxyBin === undefined || mcpBin === undefined)("Claude Agent and Codex through the app's caveman-proxy", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "app-proxy-wire-"));
  const seen: Array<Seen> = [];
  let upstream: http.Server;
  let proxy: AppProxy;
  let codex: AppProxy;
  let egress: EgressProxy;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      const chunks: Array<Buffer> = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        seen.push({ path: req.url ?? "", body, headers: req.headers });
        const model = (JSON.parse(body.toString("utf8")) as { model: string }).model;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(req.url?.endsWith("/responses") ? responsesStream(model) : anthropicStream(model));
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const stub = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    // The provider's API, moved to the stub: in the proxy's own config, as an operator would (nothing in the app does).
    fs.writeFileSync(path.join(home, "caveman.yaml"), `providers:\n  anthropic:\n    base_url: ${stub}\n  openai:\n    base_url: ${stub}\n`);
    setAppProxyHome(home);
    const env = { HOME: home, PATH: process.env.PATH, CAVEMAN_PROXY_BIN: proxyBin, CAVEMAN_MCP_BIN: mcpBin, CAVE_SSRF_ALLOWLIST: "127.0.0.1" };
    proxy = new AppProxy({ env, home });
    codex = new AppProxy({ env, home, recovery: true });
    expect(await proxy.ensure()).toBe("started");
    expect(await codex.ensure()).toBe("started");
    vi.spyOn(appProxy, "url").mockImplementation(() => proxy.url());
    vi.spyOn(codexProxy, "url").mockImplementation(() => codex.url());
    egress = await startEgressProxy({ scrubber: () => createScrubber([]) });
  }, 30_000);

  afterAll(async () => {
    proxy?.stop();
    codex?.stop();
    await egress?.close();
    upstream?.close();
  });

  it("the person's own caveman (its proxy, run state and native hook socket) is untouched by the app's", async () => {
    const person = fs.mkdtempSync(path.join(os.tmpdir(), "person-caveman-"));
    const port = await new Promise<number>((resolve) => {
      const probe = http.createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as { port: number };
        probe.close(() => resolve(port));
      });
    });
    // Their `caveman start`, on its own home; the test records its pid and stops only it.
    const theirs = spawn(proxyBin!, ["serve"], { env: { HOME: person, CAVEMAN_HOME: person, PATH: process.env.PATH, CAVEMAN_LISTEN: `127.0.0.1:${port}` }, stdio: "ignore" });
    const socket = path.join(person, "run", "native.sock");
    try {
      for (let i = 0; i < 50 && !fs.existsSync(socket); i++) await new Promise((resolve) => setTimeout(resolve, 100));
      expect(fs.existsSync(socket)).toBe(true);
      const before = fs.readdirSync(path.join(person, "run")).sort();
      const app = new AppProxy({ env: { HOME: person, PATH: process.env.PATH, CAVEMAN_PROXY_BIN: proxyBin }, home: path.join(home, "second") });
      expect(await app.ensure()).toBe("started");
      expect(fs.existsSync(path.join(home, "second", "run", "native.sock"))).toBe(true);
      app.stop();
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Same files, the socket still theirs and answering.
      expect(fs.readdirSync(path.join(person, "run")).sort()).toEqual(before);
      await new Promise<void>((resolve, reject) => {
        const conn = net.connect(socket, () => (conn.end(), resolve()));
        conn.once("error", reject);
      });
    } finally {
      theirs.kill("SIGTERM");
    }
  }, 30_000);

  it("Claude Agent on a chosen model: through the proxy, model kept, no route, the tool result preserved whole", async () => {
    const routed = routeClaudeOptions({ model: "claude-sonnet-5-5", tools: [], permissionMode: "default", env: { HOME: home, CAVEMAN_HOME: home, PATH: process.env.PATH } } as unknown as ClaudeAgentSdkQueryOptions, {
      egress,
      secrets: [],
      settingsEnv: {},
      threadId: "caveman:claude-wire",
    });
    if (!("options" in routed)) throw new Error(routed.refused);
    // Claude Code is handed no caveman_retrieve: nothing on the way is shortened, so there is nothing to get back.
    expect(routed.options.mcpServers?.caveman).toBeUndefined();
    expect(routed.options.allowedTools ?? []).not.toContain(CLAUDE_RETRIEVE_TOOL);
    const base = routed.options.env!.ANTHROPIC_BASE_URL!;
    expect(egress.owns(base)).toBe(true);

    const request = {
      model: "claude-sonnet-5-5",
      max_tokens: 32_000,
      stream: true,
      system: [{ type: "text", text: "You are Claude Code.", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
        { name: CLAUDE_RETRIEVE_TOOL, description: "Get back what Caveman shortened", input_schema: { type: "object", properties: { handle: { type: "string" } } } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Run the worker tests and tell me what failed." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "npm test" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: BIG_LOG }] },
      ],
    };
    const sent = Buffer.byteLength(JSON.stringify(request));
    const session = /^x-cave-session: (.+)$/m.exec(routed.options.env!.ANTHROPIC_CUSTOM_HEADERS!)![1]!;
    const answer = await post(`${base}/v1/messages`, { "x-api-key": ("sk-" + "ant-api03-wire-test-key"), "anthropic-version": "2023-06-01", "x-cave-session": session }, request);
    expect(answer.status).toBe(200);
    expect(answer.text).toContain("One job failed.");

    const got = seen.find((s) => s.path === "/v1/messages")!;
    const forwarded = JSON.parse(got.body.toString("utf8")) as typeof request;
    // The model went through as chosen; the key was the engine's own, forwarded.
    expect(forwarded.model).toBe("claude-sonnet-5-5");
    expect(got.headers["x-api-key"]).toBe(("sk-" + "ant-api03-wire-test-key"));
    const result = (forwarded.messages[2]!.content[0] as { content: unknown }).content;
    const resultText = typeof result === "string" ? result : JSON.stringify(result);
    console.log(`[wire] Claude request ${sent} B sent by the engine -> ${got.body.length} B at the provider (tool result ${BIG_LOG.length} -> ${resultText.length} chars)`);
    expect(got.body.length).toBe(sent);
    expect(resultText).toBe(BIG_LOG);
    // What the agent needs stays in what the model reads: every failure line, word for word.
    for (const line of BIG_LOG.split("\n").filter((l) => l.includes("ERROR"))) expect(resultText).toContain(line);

    await new Promise((resolve) => setTimeout(resolve, 1_500)); // rows are written after the response
    const row = rows(home).find((r) => r.provider === "anthropic")!;
    console.log(`[wire] Claude row ${JSON.stringify(row)}`);
    expect(row).toMatchObject({ model: "claude-sonnet-5-5", runtime_mode: "record", agent_slug: "caveman-code-claude" });
    expect(row).toMatchObject({ session_id: "caveman:claude-wire", session_correlation_basis: "explicit_header" });
    const saving = readRequestSavings(path.join(home, "caveman.db")).find((r) => r.session === "caveman:claude-wire")!;
    expect(saving?.saved_tokens ?? 0).toBe(0);
    expect(saving?.saved_usd ?? 0).toBe(0);
    // No route decision: the row's route ran from the chosen model to itself, with the route stage off
    // (named_model on the provider's own API; this stub's origin is a custom one, so custom_provider_origin).
    expect(row).toMatchObject({ route_from: "claude-sonnet-5-5", route_to: "claude-sonnet-5-5" });
    expect(["named_model", "custom_provider_origin"]).toContain(row.route_reason);
    expect(Number(row.compression_tokens_before)).toBe(Number(row.compression_tokens_after));
    expect(row.raw_request_sha256).toBe(row.transformed_request_sha256);

    expect(row.recovery_handle ?? "").toBe("");
  }, 60_000);

  it("Claude Agent on a Claude login (subscription): preserved whole, rows tokens-only", async () => {
    const routed = routeClaudeOptions({ model: "claude-opus-5-5", tools: [], permissionMode: "default", env: { HOME: home, CAVEMAN_HOME: home, PATH: process.env.PATH } } as unknown as ClaudeAgentSdkQueryOptions, {
      egress,
      secrets: [],
      settingsEnv: {},
    });
    if (!("options" in routed)) throw new Error(routed.refused);
    const log = BIG_LOG.replaceAll("INFO ", "DEBUG");
    const request = {
      model: "claude-opus-5-5",
      max_tokens: 32_000,
      stream: true,
      system: [{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral" } }],
      tools: [
        { name: "Bash", description: "Run a command", input_schema: { type: "object", properties: { command: { type: "string" } } } },
        { name: CLAUDE_RETRIEVE_TOOL, description: "Get back what Caveman shortened", input_schema: { type: "object", properties: { recovery_handle: { type: "string" } } } },
      ],
      messages: [
        { role: "user", content: [{ type: "text", text: "Why do the workers fail?" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_2", name: "Bash", input: { command: "cat worker.log" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_2", content: log }] },
      ],
    };
    const sent = Buffer.byteLength(JSON.stringify(request));
    const answer = await post(
      `${routed.options.env!.ANTHROPIC_BASE_URL!}/v1/messages`,
      { authorization: ("Bearer sk-" + "ant-oat01-wire-test-login"), "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" },
      request,
    );
    expect(answer.status).toBe(200);
    const got = seen.filter((s) => s.path === "/v1/messages").at(-1)!;
    expect((JSON.parse(got.body.toString("utf8")) as { model: string }).model).toBe("claude-opus-5-5");
    expect(got.headers.authorization).toBe(("Bearer sk-" + "ant-oat01-wire-test-login"));
    console.log(`[wire] Claude login request ${sent} B sent by the engine -> ${got.body.length} B at the provider`);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const row = rows(home).filter((r) => r.provider === "anthropic").at(-1)!;
    console.log(`[wire] Claude login row ${JSON.stringify(row)}`);
    expect(row).toMatchObject({ model: "claude-opus-5-5", runtime_mode: "record", route_to: "claude-opus-5-5", auth_mode: "subscription" });
    expect(got.body.length).toBe(sent);
    // A plan's row counts tokens, never dollars, and nothing the proxy records is a verified saving.
    expect(row.savings_usd ?? 0).toBe(0);
    expect(rows(home).every((r) => r.basis === "inferred")).toBe(true);
  }, 60_000);

  it("Claude Code's side call without caveman_retrieve (a title, WebFetch's summary, a subagent): through whole", async () => {
    const routed = routeClaudeOptions({ model: "claude-haiku-5-5", tools: [], permissionMode: "default", env: { HOME: home, PATH: process.env.PATH } } as unknown as ClaudeAgentSdkQueryOptions, {
      egress,
      secrets: [],
      settingsEnv: {},
    });
    if (!("options" in routed)) throw new Error(routed.refused);
    const log = BIG_LOG.replaceAll("INFO ", "TRACE");
    const request = {
      model: "claude-haiku-5-5",
      max_tokens: 1_000,
      stream: true,
      system: [{ type: "text", text: "Summarize the page.", cache_control: { type: "ephemeral" } }],
      messages: [
        { role: "user", content: [{ type: "text", text: "Summarize the build log." }] },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_3", name: "Bash", input: { command: "cat build.log" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_3", content: log }] },
      ],
    };
    const sent = JSON.stringify(request);
    const answer = await post(`${routed.options.env!.ANTHROPIC_BASE_URL!}/v1/messages`, { authorization: ("Bearer sk-" + "ant-oat01-wire-test-login"), "anthropic-version": "2023-06-01", "anthropic-beta": "oauth-2025-04-20" }, request);
    expect(answer.status).toBe(200);
    const got = seen.filter((s) => s.path === "/v1/messages").at(-1)!;
    const result = (JSON.parse(got.body.toString("utf8")) as typeof request).messages[2]!.content[0] as { content: unknown };
    console.log(`[wire] Claude side call ${Buffer.byteLength(sent)} B sent -> ${got.body.length} B at the provider`);
    expect(result.content).toBe(log);
  }, 60_000);

  it("Codex on a chosen model: through the proxy's OpenAI route, model kept, no route, the tool output preserved whole", async () => {
    const launched = routeCodexLaunch({ egress, configText: "", launchArgs: undefined, environment: {} });
    if (!("args" in launched)) throw new Error(launched.unroutable);
    expect(launched.viaProxy).toBe(true);
    const base = /base_url = "([^"]+)"/.exec(launched.args[3]!)![1]!;
    let headers: Record<string, string> = {};
    const client = { request: (_method: string, payload: { config: Record<string, unknown> }) => {
      headers = { "x-cave-session": String(payload.config["model_providers.caveman_code_egress.http_headers.x-cave-session"]) };
      return Effect.succeed({});
    }, raw: {} } as unknown as Parameters<typeof withCodexThreadEgress>[0];
    await Effect.runPromise(withCodexThreadEgress(client, egress, true, "caveman:codex-wire").request("thread/start", { config: {} } as never));
    const request = {
      model: "gpt-6.1-sol",
      stream: true,
      store: false,
      reasoning: { effort: "medium" },
      instructions: "You are Codex.",
      // No caveman_retrieve on the wire: Codex lists MCP tools inside its exec tool. Its proxy is told it has one.
      tools: [{ type: "function", name: "shell", parameters: { type: "object", properties: { command: { type: "array", items: { type: "string" } } } } }],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Run the worker tests and tell me what failed." }] },
        { type: "function_call", call_id: "call_1", name: "shell", arguments: JSON.stringify({ command: ["npm", "test"] }) },
        { type: "function_call_output", call_id: "call_1", output: CODEX_LOG },
      ],
    };
    const sent = Buffer.byteLength(JSON.stringify(request));
    const answer = await post(`${base}/responses`, { authorization: "Bearer sk-wire-test-openai-key", ...headers }, request);

    const got = seen.find((s) => s.path.endsWith("/responses"))!;
    console.log(`[wire] Codex reached the provider at ${got?.path} (seen ${seen.map((s) => s.path).join(", ")}; answer ${answer.status} ${answer.text.slice(0, 200)})`);
    expect(answer.status).toBe(200);
    // The last event starts its own SSE line through the proxy: what the scrub drains a finished answer on.
    expect(answer.text).toMatch(/(^|\n)event: response\.completed\n/);
    const forwarded = JSON.parse(got.body.toString("utf8")) as typeof request;
    expect(forwarded.model).toBe("gpt-6.1-sol");
    expect(got.headers.authorization).toBe("Bearer sk-wire-test-openai-key");
    const output = String((forwarded.input[2] as { output: unknown }).output);
    console.log(`[wire] Codex request ${sent} B sent by the engine -> ${got.body.length} B at the provider (tool output ${CODEX_LOG.length} -> ${output.length} chars)`);
    expect(got.body.length).toBe(sent);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const row = rows(home).find((r) => r.provider === "openai")!;
    console.log(`[wire] Codex row ${JSON.stringify(row)}`);
    expect(row).toMatchObject({ model: "gpt-6.1-sol", runtime_mode: "record", agent_slug: "caveman-code-codex" });
    expect(row).toMatchObject({ session_id: "caveman:codex-wire", session_correlation_basis: "explicit_header" });
    const saving = readRequestSavings(path.join(home, "caveman.db")).find((r) => r.session === "caveman:codex-wire")!;
    expect(saving?.saved_tokens ?? 0).toBe(0);
    expect(saving?.saved_usd ?? 0).toBe(0);
    expect(row).toMatchObject({ route_from: "gpt-6.1-sol", route_to: "gpt-6.1-sol" });
    expect(["named_model", "custom_provider_origin"]).toContain(row.route_reason);
    expect(Number(row.compression_tokens_before)).toBe(Number(row.compression_tokens_after));
  }, 60_000);

  it("Cloud requests stay whole without a recovery MCP server", async () => {
    vi.stubEnv("CAVEMAN_RUNTIME_TOOLS_ADDRESS", "127.0.0.1:47917");
    try {
      const routed = routeClaudeOptions({ model: "claude-sonnet-5-5", tools: [], permissionMode: "default" } as unknown as ClaudeAgentSdkQueryOptions, { egress, secrets: [], settingsEnv: {} });
      if (!("options" in routed)) throw new Error(routed.refused);
      expect(routed.options.mcpServers?.caveman).toBeUndefined();
      const request = { model: "claude-sonnet-5-5", max_tokens: 1000, stream: true, messages: [{ role: "user", content: BIG_LOG }] };
      const answer = await post(`${routed.options.env!.ANTHROPIC_BASE_URL!}/v1/messages`, { "x-api-key": "sk-ant-api03-wire-test-key", "anthropic-version": "2023-06-01" }, request);
      expect(answer.status).toBe(200);
      const got = seen.filter((s) => s.path === "/v1/messages").at(-1)!;
      expect(got.body.toString()).toBe(JSON.stringify(request));
    } finally {
      vi.unstubAllEnvs();
    }
  }, 60_000);

  it("Codex text generation with MCP disabled keeps tool output whole through the scrub and retrieve-gated proxy", async () => {
    const launched = routeCodexLaunch({ egress, configText: "", launchArgs: undefined, environment: {}, textGeneration: true });
    if (!("args" in launched)) throw new Error(launched.unroutable);
    const base = /base_url = "([^"]+)"/.exec(launched.args[3]!)![1]!;
    const log = CODEX_LOG.replaceAll("shard-", "side-call-");
    const request = {
      model: "gpt-6.1-sol",
      stream: true,
      store: false,
      instructions: "Summarize the changes for a commit message.",
      tools: [],
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Summarize the build log." }] },
        { type: "function_call", call_id: "side-call", name: "shell", arguments: "{}" },
        { type: "function_call_output", call_id: "side-call", output: log },
      ],
    };
    const answer = await post(`${base}/responses`, { authorization: "Bearer sk-wire-test-openai-key" }, request);
    expect(answer.status).toBe(200);
    const got = seen.filter((s) => s.path.endsWith("/responses")).at(-1)!;
    const forwarded = JSON.parse(got.body.toString("utf8")) as typeof request;
    expect(forwarded.input[2]!.output).toBe(log);
    expect(forwarded.tools).toEqual([]);
  }, 60_000);
});
