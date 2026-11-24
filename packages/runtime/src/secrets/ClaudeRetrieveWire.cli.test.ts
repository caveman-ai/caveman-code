// The real `claude`, routed as EngineEgress routes a Claude Agent chat to the app's proxy, never sends
// mcp__caveman__caveman_retrieve: the app hands no engine a retrieve server since compression left (README.md),
// and v4's proxy counts a tool of that name as a way back to what it cut. Another server named caveman
// (a plugin's, a .mcp.json's, the person's v4) still loads on the CLI, so only the routed disallowedTools keeps its
// retrieve off the wire, on the initial options and on every live replacement of the dynamic set. The stand-in
// server below is alwaysLoad, so with tool search on its tools are in `tools` unless the CLI drops them. Free: a
// loopback listener stands in for the proxy and answers 400, the key is a dummy and the config dir a temp one, so
// nothing reaches a model and no login is read. Skipped without the CLI (CAVEMAN_CLAUDE_BIN, else `claude` on PATH
// or ~/.local/bin).
import * as NodeChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, it } from "vitest";

import type { ClaudeAgentSdkQueryOptions } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CLAUDE_RETRIEVE_TOOL, layerClaudeEgress, RETRIEVE_MCP_SERVER, routeClaudeOptions, type Egress } from "./EngineEgress.ts";

const claudeBin = (() => {
  const candidates = [
    process.env.CAVEMAN_CLAUDE_BIN,
    NodeChildProcess.spawnSync("which", ["claude"], { encoding: "utf8" }).stdout.trim(),
    NodePath.join(NodeOS.userInfo().homedir, ".local", "bin", "claude"),
  ];
  return candidates.find((path) => path !== undefined && path.length > 0 && NodeFS.existsSync(path));
})();

// A stdio MCP server that lists a retrieve tool and one other, as v4's caveman-mcp does.
const FOREIGN_SERVER_SCRIPT = String.raw`
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
require("node:readline").createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") send({ id, result: { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "caveman", version: "0" } } });
  else if (method === "tools/list") send({ id, result: { tools: ["caveman_retrieve", "caveman_stats"].map((name) => ({ name, description: name, inputSchema: { type: "object", properties: {} } })) } });
  else send({ id, error: { code: -32601, message: "unsupported" } });
});`;
const foreignServer = { type: "stdio" as const, command: process.execPath, args: ["-e", FOREIGN_SERVER_SCRIPT], alwaysLoad: true };
const FOREIGN_OTHER_TOOL = `mcp__${RETRIEVE_MCP_SERVER}__caveman_stats`;

let server: NodeHttp.Server;
let listenUrl = "";
const toolLists: Array<ReadonlyArray<string>> = [];
const sessionHeaders: Array<{ path: string; session: string | string[] | undefined }> = [];

beforeAll(async () => {
  server = NodeHttp.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      // The CLI's /api/hello startup probe is not a model request and has no custom headers.
      if (request.url?.startsWith("/v1/messages")) sessionHeaders.push({ path: request.url, session: request.headers["x-cave-session"] });
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { tools?: ReadonlyArray<{ name?: string }> };
        toolLists.push((body.tools ?? []).map((tool) => tool.name ?? ""));
      } catch {
        // Not a Messages request.
      }
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "wire probe" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  listenUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

it.skipIf(claudeBin === undefined).each(["alone", "beside another server"])(
  "a live MCP replacement through the app's proxy keeps a foreign caveman_retrieve off the real CLI wire: %s",
  async (swap) => {
    toolLists.length = 0;
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-retrieve-swap-"));
    const configDir = NodePath.join(root, "config");
    NodeFS.mkdirSync(configDir);
    let send!: (message: SDKUserMessage) => void;
    const prompt = new Promise<SDKUserMessage>((resolve) => { send = resolve; });
    let run: ReturnType<typeof query> | undefined;
    const inner = Layer.succeed(ClaudeAdapterV2.ClaudeAgentSdkQueryRunner, {
      open: (input: ClaudeAdapterV2.ClaudeAgentSdkQueryOpenInput) => Effect.promise(async () => {
        // Production query runner strips --mcp-config and registers dynamically after opening.
        const { mcpServers, ...options } = input.options;
        run = query({ prompt: (async function* () { yield await prompt; })(), options });
        await run.setMcpServers(mcpServers ?? {});
        return { setMcpServers: (servers: NonNullable<ClaudeAgentSdkQueryOptions["mcpServers"]>) => Effect.promise(async () => { await run!.setMcpServers(servers); }) } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQuerySession;
      }),
    } as unknown as ClaudeAdapterV2.ClaudeAgentSdkQueryRunner["Service"]);
    try {
      await Effect.runPromise(Effect.gen(function* () {
        const runner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
        const session = yield* runner.open({
          threadId: ThreadId.make("caveman:wire-swap"), providerSessionId: ProviderSessionId.make("wire-swap"),
          options: {
            model: "claude-opus-5-5", sessionId: randomUUID(), tools: { type: "preset", preset: "claude_code" }, permissionMode: "default",
            ...(claudeBin === undefined ? {} : { pathToClaudeCodeExecutable: claudeBin }),
            env: { PATH: process.env.PATH ?? "/usr/bin", HOME: root, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: ("sk-" + "ant-wire-probe") },
          },
        });
        // A plugin's server named caveman arrives in a replacement of the dynamic set, as grill mode or a relaunch sends it.
        yield* session.setMcpServers!({
          [RETRIEVE_MCP_SERVER]: foreignServer,
          ...(swap === "beside another server" ? { grill: { type: "http" as const, url: listenUrl } } : {}),
        });
        const statuses = yield* Effect.promise(() => run!.mcpServerStatus());
        expect(statuses.find((entry) => entry.name === RETRIEVE_MCP_SERVER)).toMatchObject({ source: "dynamic", status: "connected" });
      }).pipe(Effect.provide(layerClaudeEgress.pipe(Layer.provide(Layer.mergeAll(inner, Layer.succeed(EgressRoute, {
        route: () => listenUrl, owns: (url) => url.startsWith(listenUrl), hasSecrets: () => Effect.succeed(false),
      })))))));
      send({ type: "user", session_id: "", parent_tool_use_id: null, message: { role: "user", content: "say hi" } });
      try {
        for await (const message of run!) if (message.type === "result") break;
      } catch { /* Listener refuses every model request. */ }
      const tools = toolLists.find((names) => names.includes("ToolSearch"));
      expect(tools, "claude sent no Messages request with tool search on").toBeDefined();
      expect(tools).toContain(FOREIGN_OTHER_TOOL);
      expect(tools).not.toContain(CLAUDE_RETRIEVE_TOOL);
    } finally {
      run?.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(claudeBin === undefined)(
  "a Claude Agent chat through the app's proxy sends no caveman_retrieve, even from a server named caveman, with tool search on",
  async () => {
    toolLists.length = 0;
    sessionHeaders.length = 0;
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-retrieve-wire-"));
    // The scrub's route stands in for scrub plus proxy: the request lands on the listener.
    const egress: Egress = { route: () => listenUrl, owns: (url) => url.startsWith(listenUrl) };
    const configDir = NodePath.join(root, "config");
    NodeFS.mkdirSync(configDir);
    const base: ClaudeAgentSdkQueryOptions = {
      model: "claude-opus-5-5",
      sessionId: randomUUID(),
      tools: { type: "preset", preset: "claude_code" },
      permissionMode: "default",
      ...(claudeBin === undefined ? {} : { pathToClaudeCodeExecutable: claudeBin }),
      env: { PATH: process.env.PATH ?? "/usr/bin", HOME: root, CLAUDE_CONFIG_DIR: configDir, ANTHROPIC_API_KEY: ("sk-" + "ant-wire-probe") },
      mcpServers: { [RETRIEVE_MCP_SERVER]: foreignServer },
    };
    const routed = routeClaudeOptions(base, { egress, secrets: [], settingsEnv: {}, threadId: "caveman:wire-probe" });
    if (!("options" in routed)) throw new Error(routed.refused);

    const run = query({ prompt: "say hi", options: { ...routed.options, maxTurns: 1 } });
    try {
      for await (const message of run) {
        if (message.type === "result") break;
      }
    } catch {
      // The listener refuses every request; only what was sent matters.
    } finally {
      run.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
    }

    const first = toolLists[0];
    expect(sessionHeaders.length).toBeGreaterThan(0);
    expect(sessionHeaders).toEqual(sessionHeaders.map(({ path }) => ({ path, session: "caveman:wire-probe" })));
    expect(first, "claude sent no Messages request to the listener").toBeDefined();
    expect(first).toContain("ToolSearch");
    expect(first).toContain(FOREIGN_OTHER_TOOL);
    expect(first).not.toContain(CLAUDE_RETRIEVE_TOOL);
  },
);
