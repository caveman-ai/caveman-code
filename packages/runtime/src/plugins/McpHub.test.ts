import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import { type AddressInfo, connect as connectNet, createServer as createNetServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { SessionPlugins } from "@caveman-app/engine-core/server/SessionPlugins";
import { ThreadId } from "@caveman-app/protocol";
import { McpClient, StdioTransport } from "@earendil-works/pi-mcp";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import { TestClock } from "effect/testing";
import { afterAll, describe, expect, it } from "vitest";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { SessionStore } from "../session-protocol/store.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import { layerSecretStore } from "./CredentialBroker.ts";
import { TOOLS_EXEC } from "../cloudLink/tools.ts";
import { lastWords, McpHub, McpHubAuth, McpHubHooks, personalServer, PROBE_MS, layer as hubLayer, schemaBytes, stdioLaunch } from "./McpHub.ts";
import { headerCredential } from "./personal.ts";
import * as PluginRegistry from "./PluginRegistry.ts";
import { makePluginHandlers } from "./protocolHandlers.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-hub-"));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** A stdio MCP server: newline-delimited JSON-RPC, one `echo` tool that also reports an env variable. */
const SERVER = `
import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "echo", version: "1" }, instructions: "Echo things." } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "echo", description: "Echo text", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
  if (m.method === "tools/call") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "echo:" + m.params.arguments.text + ":" + (process.env.ECHO_TOKEN ?? "none") + ":" + (process.env.SECRET_IN_RUNTIME ?? "hidden") }] } });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`;

/** A stdio MCP server with one tool, named by its first argument. */
const NAMED_SERVER = `
import { createInterface } from "node:readline";
const tool = process.argv[2];
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: tool, version: "1" } } });
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: tool, inputSchema: { type: "object" } }] } });
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });
});
`;

const layer = (extra: Layer.Layer<never> = Layer.empty) =>
  hubLayer.pipe(
    Layer.provideMerge(extra),
    Layer.provideMerge(PluginRegistry.layer),
    Layer.provideMerge(layerSecretStore),
    Layer.provideMerge(ServerSettingsModule.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(Layer.fresh(SqlitePersistence.layerMemory)),
    Layer.provideMerge(Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "caveman-hub-" }))),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );

const caller = { threadId: ThreadId.make("hub-thread"), hooks: true };

describe("the runtime's MCP hub", () => {
  it("is the MCP client for a contained stdio server: initialize, tools/list (measured), tools/call with a brokered credential", async () => {
    const script = path.join(tmp, "echo-server.mjs");
    fs.writeFileSync(script, SERVER);
    process.env.SECRET_IN_RUNTIME = "runtime-secret";
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        yield* registry.saveServer({ name: "echo", command: process.execPath, args: [script], env: ["ECHO_TOKEN"], source: "manual", enabled: true }, false);
        yield* registry.grant("personal", "ECHO_TOKEN", Redacted.make("granted-token"));
        const init = yield* hub.handle(caller, "echo", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
        const note = yield* hub.handle(caller, "echo", { jsonrpc: "2.0", method: "notifications/initialized" });
        const list = yield* hub.handle(caller, "echo", { jsonrpc: "2.0", id: 2, method: "tools/list" });
        const called = yield* hub.handle(caller, "echo", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
        const missing = yield* hub.handle(caller, "nope", { jsonrpc: "2.0", id: 4, method: "tools/list" });
        const outside = yield* hub.tools(personalServer("echo"));
        const handlers = yield* makePluginHandlers;
        const listed = yield* handlers["mcp.list"]({});
        const tools = yield* handlers["mcp.tools"]({ server: "echo" });
        return { init, note, list, called, missing, measured: hub.measured(personalServer("echo")), outside, listed, tools };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    delete process.env.SECRET_IN_RUNTIME;
    expect(out.init).toMatchObject({ id: 1, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "echo" }, instructions: "Echo things." } });
    expect(out.note).toBeUndefined();
    expect(out.list).toMatchObject({ id: 2, result: { tools: [{ name: "echo" }] } });
    // The granted credential reached the server; the runtime's own environment did not (the launcher filtered it).
    expect(out.called).toMatchObject({ id: 3, result: { content: [{ type: "text", text: "echo:hi:granted-token:hidden" }] } });
    expect(out.missing).toMatchObject({ id: 4, error: { code: -32000, message: "no MCP server nope here" } });
    const tools = (out.list as { result: { tools: Array<{ name: string; description?: string; inputSchema: unknown }> } }).result.tools;
    expect(Option.getOrUndefined(out.measured)).toEqual({ tools: ["echo"], bytes: schemaBytes(tools) });
    expect(out.outside.map((t) => t.name)).toEqual(["echo"]);
    // The Session Protocol shows what the hub measured, as an estimate.
    expect(out.listed.servers[0]).toMatchObject({ name: "echo", tools: ["echo"], idle_tokens_estimate: Math.ceil(schemaBytes(tools) / 4) });
    expect(out.tools).toEqual({ tools: [{ name: "echo", description: "Echo text" }], idle_tokens_estimate: Math.ceil(schemaBytes(tools) / 4) });
  });

  it("says why a stdio server stopped in its own words, never ones that look like a credential", () => {
    const node = "node:internal/modules/cjs/loader:1228\n  throw err;\n  ^\n\nError: Cannot find module '/work/missing-server.js'\n    at Module._resolveFilename (node:internal)\n  code: 'MODULE_NOT_FOUND'\n}\n\nNode.js v24.15.0\n";
    expect(lastWords(node)).toBe("Error: Cannot find module '/work/missing-server.js'");
    expect(lastWords("python3: can't open file '/work/server.py': [Errno 2] No such file or directory\n")).toBe("python3: can't open file '/work/server.py': [Errno 2] No such file or directory");
    expect(lastWords("starting\nlistening on stdio\n")).toBe("listening on stdio");
    expect(lastWords(`error: bad key sk-ant-api03-${"a".repeat(40)}\n`)).toBeUndefined();
    expect(lastWords("")).toBeUndefined();
  });

  it("bounds the check a person asks for: a server that never answers fails it at PROBE_MS and its process is closed", async () => {
    // Reads its input and never answers initialize. The hub's write sandbox keeps it from writing anywhere, so ps finds it.
    const script = path.join(tmp, `hang-server-${process.pid}.mjs`);
    fs.writeFileSync(script, "process.stdin.resume();\n");
    // Windows has no ps that sees a native process's command line: there CIM lists them (all but the PowerShell asking).
    const powershell = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const running = () =>
      process.platform === "win32"
        ? (spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${path.basename(script)}*' } | ForEach-Object { $_.ProcessId }`], { encoding: "utf8", windowsHide: true }).stdout ?? "")
            .split(/\r?\n/)
            .filter((line) => line.trim() !== "")
            .map(Number)
        : (spawnSync("ps", ["-A", "-o", "pid=", "-o", "args="], { encoding: "utf8" }).stdout ?? "")
            .split("\n")
            .filter((line) => line.includes(script))
            .map((line) => Number(line.trim().split(/\s+/)[0]));
    const waitFor = (done: () => boolean) =>
      TestClock.withLive(
        Effect.promise(async () => {
          for (const deadline = Date.now() + 10_000; !done() && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 25));
          return done();
        }),
      );
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        yield* registry.saveServer({ name: "hang", command: process.execPath, args: [script], source: "manual", enabled: true }, false);
        // The registry's session loads on the real clock; only the check's own wait runs on the test clock.
        yield* TestClock.withLive(registry.session());
        const check = yield* Effect.forkChild(Effect.flip(hub.tools(personalServer("hang"))));
        const started = yield* waitFor(() => running().length > 0);
        yield* TestClock.adjust(`${PROBE_MS - 1000} millis`);
        const early = check.pollUnsafe();
        yield* TestClock.adjust("2 seconds");
        const error = yield* Fiber.join(check);
        const gone = yield* waitFor(() => running().length === 0);
        return { started, early, error, gone, measured: hub.measured(personalServer("hang")) };
      }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer(), TestClock.layer()))),
    );
    expect(out.started).toBe(true);
    expect(out.early).toBeUndefined();
    expect(out.error).toMatchObject({ _tag: "McpHubError", reason: "failed", message: `hang did not start and list its tools within ${PROBE_MS / 1000} s` });
    expect(out.gone).toBe(true);
    expect(Option.isNone(out.measured)).toBe(true);
  });

  it.skipIf(process.platform === "win32")("starts a thread's stdio server once when its first calls come together, and nothing it started outlives the hub", async () => {
    const script = path.join(tmp, `together-server-${process.pid}.mjs`);
    fs.writeFileSync(script, SERVER);
    // The launcher and the server it runs both name the script.
    const running = () =>
      (spawnSync("ps", ["-A", "-o", "pid=", "-o", "args="], { encoding: "utf8" }).stdout ?? "")
        .split("\n")
        .filter((line) => line.includes(script))
        .map((line) => Number(line.trim().split(/\s+/)[0]));
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        yield* registry.saveServer({ name: "together", command: process.execPath, args: [script], source: "manual", enabled: true }, false);
        yield* registry.session();
        const call = (id: number) => hub.handle(caller, "together", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "echo", arguments: { text: String(id) } } });
        // A thread's first turn (or its first after the idle sweep) calling one server twice at once.
        return yield* Effect.all([call(1), call(2)], { concurrency: "unbounded" });
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    const left = await (async () => {
      for (const deadline = Date.now() + 10_000; running().length > 0 && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 25));
      return running();
    })();
    for (const pid of left) process.kill(pid, "SIGKILL");
    expect(out).toMatchObject([{ id: 1, result: { content: [{ text: "echo:1:none:hidden" }] } }, { id: 2, result: { content: [{ text: "echo:2:none:hidden" }] } }]);
    expect(left).toEqual([]);
  });

  it("opens the server for a request that was waiting on an open interrupted before it connected", async () => {
    const upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const frame = JSON.parse(body);
      if (frame.id === undefined) return void response.writeHead(202).end();
      const result =
        frame.method === "initialize"
          ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "slow", version: "1" } }
          : { content: [{ type: "text", text: `did ${frame.params.name}` }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
    // The first sign-in never answers (a lease that hangs); the next one does.
    let signIns = 0;
    const auth = Layer.succeed(McpHubAuth, {
      transportAuth: () => (++signIns === 1 ? Effect.never : Effect.succeed({ headers: { Authorization: "Bearer t" } })),
    });
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer({ name: "slow", url, auth: "github", source: "connector", enabled: true }, false);
          yield* registry.session();
          const call = (id: number) => hub.handle(caller, "slow", { jsonrpc: "2.0", id, method: "tools/call", params: { name: "t", arguments: {} } });
          const first = yield* Effect.forkChild(call(1));
          while (signIns === 0) yield* Effect.sleep("10 millis");
          const second = yield* Effect.forkChild(call(2));
          yield* Effect.sleep("50 millis");
          yield* Fiber.interrupt(first);
          return { second: yield* Fiber.join(second), signIns };
        }).pipe(Effect.scoped, Effect.provide(layer(auth))),
      );
      expect(out).toMatchObject({ second: { id: 2, result: { content: [{ text: "did t" }] } }, signIns: 2 });
    } finally {
      upstream.close();
    }
  });

  it("attaches a server's sign-in itself and runs the runtime's hooks only when asked", async () => {
    const seen: Array<{ auth: string | undefined; method: string }> = [];
    const upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.method !== "POST") return void response.writeHead(405).end();
      const frame = JSON.parse(body);
      seen.push({ auth: request.headers.authorization, method: frame.method });
      if (frame.id === undefined) return void response.writeHead(202).end();
      const result =
        frame.method === "initialize"
          ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gh", version: "1" } }
          : frame.method === "tools/list"
            ? { tools: [{ name: "issue_read", inputSchema: { type: "object" } }, { name: "issue_write", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: `did ${frame.params.name}` }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
    const hookCalls: string[] = [];
    const extra = Layer.mergeAll(
      Layer.succeed(McpHubAuth, { transportAuth: () => Effect.succeed({ headers: { Authorization: "Bearer gh-login-token" } }) }),
      Layer.succeed(McpHubHooks, {
        before: async (_thread, tool) => {
          hookCalls.push(`pre ${tool}`);
          return tool.endsWith("issue_write") ? "writes need a person" : undefined;
        },
        after: async (_thread, tool) => {
          hookCalls.push(`post ${tool}`);
          return "checked by a hook";
        },
      }),
    );
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer({ name: "github", url, auth: "github", source: "connector", enabled: true }, false);
          const call = (name: string, hooks: boolean) =>
            hub.handle({ ...caller, hooks }, "github", { jsonrpc: "2.0", id: name, method: "tools/call", params: { name, arguments: {} } });
          return {
            read: yield* call("issue_read", true),
            write: yield* call("issue_write", true),
            noHooks: yield* call("issue_write", false),
          };
        }).pipe(Effect.scoped, Effect.provide(layer(extra))),
      );
      expect(seen.filter((s) => s.method === "tools/call").map((s) => s.auth)).toEqual(["Bearer gh-login-token", "Bearer gh-login-token"]);
      expect(out.read).toMatchObject({ result: { content: [{ text: "did issue_read" }, { text: "checked by a hook" }] } });
      expect(out.write).toMatchObject({ result: { isError: true, content: [{ text: "Blocked by a hook: writes need a person" }] } });
      expect(out.noHooks).toMatchObject({ result: { content: [{ text: "did issue_write" }] } });
      expect(hookCalls).toEqual(["pre mcp__github__issue_read", "post mcp__github__issue_read", "pre mcp__github__issue_write"]);
    } finally {
      upstream.close();
    }
  });

  it("sends to the address a sign-in names instead of the server's own, through its fetch, with the server's configured headers", async () => {
    // What stands where Cloud's connector proxy does (cloudLink/connectorProxy.ts): another address than the server's.
    const seen: Array<{ path: string | undefined; auth: string | undefined; repository: unknown; team: unknown; method: string }> = [];
    const proxy = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      if (request.method !== "POST") return void response.writeHead(405).end();
      const frame = JSON.parse(body);
      seen.push({ path: request.url, auth: request.headers.authorization, repository: request.headers["x-caveman-repository"], team: request.headers["x-team"], method: frame.method });
      if (frame.id === undefined) return void response.writeHead(202).end();
      const result =
        frame.method === "initialize"
          ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "docs", version: "1" } }
          : frame.method === "tools/list"
            ? { tools: [{ name: "lookup", inputSchema: { type: "object" } }] }
            : { content: [{ type: "text", text: `looked up ${frame.params.arguments.q}` }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const address = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/relay/v1/mcp/conn-docs`;
    // The server's own address: one nothing listens at. A request dialed there would fail the call.
    const own = "https://docs.example.test/mcp";
    const fetched: string[] = [];
    const targets: Array<{ key: string; url: string | undefined }> = [];
    const extra = Layer.succeed(McpHubAuth, {
      transportAuth: (target) => {
        targets.push({ key: target.key, url: target.auth.url });
        return Effect.succeed({
          url: address,
          authProvider: { token: async () => "runtime-token" },
          headers: { "x-caveman-repository": "github.com/acme/widgets" },
          fetch: (input, init) => {
            fetched.push(String(input));
            return fetch(input, init);
          },
        });
      },
    });
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer({ name: "docs", url: own, auth: "oauth", headers: ["X-Team"], source: "manual", enabled: true }, false);
          yield* registry.grant("personal", headerCredential("docs", "X-Team"), Redacted.make("docs-team"));
          return yield* hub.handle({ ...caller, hooks: false }, "docs", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lookup", arguments: { q: "widgets" } } });
        }).pipe(Effect.scoped, Effect.provide(layer(extra))),
      );
      expect(out).toMatchObject({ id: 1, result: { content: [{ text: "looked up widgets" }] } });
      // The sign-in was asked about the server's own address, and every request went to the one it named.
      expect(targets).toEqual([{ key: "docs", url: own }]);
      expect(seen.length).toBeGreaterThanOrEqual(2);
      expect(new Set(seen.map((s) => s.path))).toEqual(new Set(["/relay/v1/mcp/conn-docs"]));
      expect(fetched.length).toBe(seen.length);
      expect(new Set(fetched)).toEqual(new Set([address]));
      // With the sign-in's token and headers, and the header the server was configured with.
      const call = seen.find((s) => s.method === "tools/call");
      expect(call).toMatchObject({ auth: "Bearer runtime-token", repository: "github.com/acme/widgets", team: "docs-team" });
    } finally {
      proxy.close();
    }
  });

  it("hands a stopped call's signal to its PreToolUse hook, and never calls the server's tool after the Stop", async () => {
    const calls: string[] = [];
    const upstream = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      const frame = JSON.parse(body);
      if (frame.id === undefined) return void response.writeHead(202).end();
      if (frame.method === "tools/call") calls.push(frame.params.name);
      const result =
        frame.method === "initialize"
          ? { protocolVersion: frame.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "gh", version: "1" } }
          : { content: [{ type: "text", text: `did ${frame.params.name}` }] };
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: frame.id, result }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp`;
    const hook: { started: boolean; signal?: AbortSignal | undefined } = { started: false };
    const extra = Layer.mergeAll(
      Layer.succeed(McpHubAuth, { transportAuth: () => Effect.succeed({ headers: { Authorization: "Bearer gh-login-token" } }) }),
      Layer.succeed(McpHubHooks, {
        // A slow hook that lets the call through in the end.
        before: (_thread, _tool, _input, signal) => {
          hook.started = true;
          hook.signal = signal;
          return new Promise((resolve) => setTimeout(() => resolve(undefined), 300));
        },
        after: async () => undefined,
      }),
    );
    try {
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer({ name: "github", url, auth: "github", source: "connector", enabled: true }, false);
          // The engine's Stop closes its request to the hub, which interrupts the request's fiber.
          const call = yield* Effect.forkChild(hub.handle(caller, "github", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "issue_write", arguments: {} } }));
          while (!hook.started) yield* Effect.sleep("10 millis");
          yield* Fiber.interrupt(call);
          yield* Effect.sleep("500 millis");
          return { stopped: hook.signal?.aborted === true, calls };
        }).pipe(Effect.scoped, Effect.provide(layer(extra))),
      );
      expect(out).toEqual({ stopped: true, calls: [] });
    } finally {
      upstream.close();
    }
  });

  /** A stdio server whose one tool is named by its first argument, and a plugin `acme` whose server `api` runs it as `theirs`. */
  const twoServers = (label: string) => {
    const dir = path.join(tmp, `${label}-${process.pid}`);
    fs.mkdirSync(path.join(dir, "bird", ".claude-plugin"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bird", "acme", ".claude-plugin"), { recursive: true });
    const script = (name: string) => {
      const file = path.join(dir, `${name}-server.mjs`);
      fs.writeFileSync(file, NAMED_SERVER);
      return file;
    };
    const mine = script("mine");
    const theirs = script("theirs");
    fs.writeFileSync(path.join(dir, "bird", ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "bird", plugins: [{ name: "acme", source: "./acme" }] }));
    fs.writeFileSync(path.join(dir, "bird", "acme", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme" }));
    fs.writeFileSync(path.join(dir, "bird", "acme", ".mcp.json"), JSON.stringify({ mcpServers: { api: { command: process.execPath, args: [theirs, "theirs"] } } }));
    return { dir, mine, theirs, marketplace: path.join(dir, "bird") };
  };
  const toolNames = (answer: unknown) => (answer as { result?: { tools?: Array<{ name: string }> } }).result?.tools?.map((t) => t.name);

  it("lists the server a person asks about, when a plugin's server holds its name as the bundle's key", async () => {
    const { mine, marketplace } = twoServers("asked");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        // The person's own server is named as plugin acme's server api is keyed.
        yield* registry.saveServer({ name: "acme__api", command: process.execPath, args: [mine, "mine"], source: "manual", enabled: true }, false);
        yield* registry.addMarketplace(marketplace);
        yield* registry.install({ id: "acme@bird", scope: "me" });
        const keys = Object.keys((yield* registry.session()).bundle.mcpServers).sort();
        const handlers = yield* makePluginHandlers;
        // Each check on its own: one that fails says why, and the other still runs.
        const check = (params: { readonly server: string; readonly plugin?: string }) =>
          handlers["mcp.tools"](params).pipe(
            Effect.map((r) => r.tools),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
        const personal = yield* check({ server: "acme__api" });
        const plugin = yield* check({ plugin: "acme@bird", server: "api" });
        const listed = (yield* handlers["mcp.list"]({})).servers.map((s) => [s.name, s.tools]);
        return { keys, personal, plugin, listed, measured: Option.getOrUndefined(hub.measured({ plugin: "acme@bird", server: "api" }))?.tools };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.keys).toEqual(["acme__api", "my-servers_personal__acme__api"]);
    expect(out.personal).toEqual([{ name: "mine" }]);
    expect(out.plugin).toEqual([{ name: "theirs" }]);
    expect(out.listed).toEqual([["acme__api", ["mine"]]]);
    expect(out.measured).toEqual(["theirs"]);
  });

  it("lists a plugin's server for a check that names it by its key and no plugin, as clients before `plugin` send it", async () => {
    const { marketplace } = twoServers("keyed");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        yield* registry.addMarketplace(marketplace);
        yield* registry.install({ id: "acme@bird", scope: "me" });
        const handlers = yield* makePluginHandlers;
        const check = (params: { readonly server: string; readonly plugin?: string }) =>
          handlers["mcp.tools"](params).pipe(
            Effect.map((r) => r.tools),
            Effect.catch((error) => Effect.succeed(error.message)),
          );
        return { byKey: yield* check({ server: "acme__api" }), byId: yield* check({ plugin: "acme@bird", server: "api" }), unknown: yield* check({ server: "nope" }) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out).toEqual({ byKey: [{ name: "theirs" }], byId: [{ name: "theirs" }], unknown: "no MCP server nope here" });
  });

  it("lists the server a person checks, not the one an earlier check opened under the same key", async () => {
    const { mine, marketplace } = twoServers("rekeyed");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        yield* registry.saveServer({ name: "acme__api", command: process.execPath, args: [mine, "mine"], source: "manual", enabled: true }, false);
        yield* registry.addMarketplace(marketplace);
        yield* registry.install({ id: "acme@bird", scope: "me" });
        const handlers = yield* makePluginHandlers;
        // The plugin page's check: plugin acme's server holds the key acme__api outside any repository.
        const plugin = (yield* handlers["mcp.tools"]({ plugin: "acme@bird", server: "api" })).tools;
        // Turned off, it gives the key back to the person's own server, whose check comes next.
        yield* registry.setEnabled("acme@bird", false);
        const keys = Object.keys((yield* registry.session()).bundle.mcpServers);
        const personal = yield* handlers["mcp.tools"]({ server: "acme__api" });
        return { plugin, keys, personal, measured: Option.getOrUndefined(hub.measured(personalServer("acme__api")))?.tools };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.plugin).toEqual([{ name: "theirs" }]);
    expect(out.keys).toEqual(["acme__api"]);
    expect(out.personal.tools).toEqual([{ name: "mine" }]);
    expect(out.personal.idle_tokens_estimate).toBeGreaterThan(0);
    expect(out.measured).toEqual(["mine"]);
  });

  it("keeps a chat's MCP key on the server its engine was given, when a plugin turned on since takes that key", async () => {
    const { mine, marketplace } = twoServers("snapshot");
    const chat = ThreadId.make("hub-chat-before");
    const later = ThreadId.make("hub-chat-after");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const sessions = yield* SessionPlugins;
        const hub = yield* McpHub;
        const engineKeys = (threadId: ThreadId) => sessions.caveman!(threadId, process.cwd()).pipe(Effect.map((o) => Object.keys(o.mcpServers).sort()));
        const list = (threadId: ThreadId, key: string) => hub.handle({ threadId, hooks: false }, key, { jsonrpc: "2.0", id: key, method: "tools/list" }).pipe(Effect.map(toolNames));
        yield* registry.saveServer({ name: "acme__api", command: process.execPath, args: [mine, "mine"], source: "manual", enabled: true }, false);
        // The chat starts: its engine is given the person's server as acme__api.
        const given = yield* engineKeys(chat);
        const first = yield* list(chat, "acme__api");
        // Plugin acme is turned on mid-chat; its server api is keyed acme__api for chats from now on.
        yield* registry.addMarketplace(marketplace);
        yield* registry.install({ id: "acme@bird", scope: "me" });
        // The chat's connection goes (a sign-in to the person's server closes it; so do the idle sweep and an exit).
        yield* hub.disconnect(personalServer("acme__api"));
        const stillGiven = yield* engineKeys(chat);
        const reopened = yield* list(chat, "acme__api");
        const laterKeys = yield* engineKeys(later);
        const laterListed = { plugin: yield* list(later, "acme__api"), personal: yield* list(later, "my-servers_personal__acme__api") };
        return { given, first, stillGiven, reopened, laterKeys, laterListed };
      }).pipe(Effect.scoped, Effect.provide(PluginRegistry.layerSessionPlugins.pipe(Layer.provideMerge(layer())))),
    );
    expect(out.given).toEqual(["acme__api"]);
    expect(out.first).toEqual(["mine"]);
    expect(out.stillGiven).toEqual(["acme__api"]);
    expect(out.reopened).toEqual(["mine"]);
    expect(out.laterKeys).toEqual(["acme__api", "my-servers_personal__acme__api"]);
    expect(out.laterListed).toEqual({ plugin: ["theirs"], personal: ["mine"] });
  });

  it("checks a person's own server that is off as not running, though a plugin's server holds its name as a key", async () => {
    const { mine, marketplace } = twoServers("off");
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const registry = yield* PluginRegistry.PluginRegistry;
        const hub = yield* McpHub;
        yield* registry.saveServer({ name: "acme__api", command: process.execPath, args: [mine, "mine"], source: "manual", enabled: true }, false);
        yield* registry.addMarketplace(marketplace);
        yield* registry.install({ id: "acme@bird", scope: "me" });
        const handlers = yield* makePluginHandlers;
        yield* registry.setServerEnabled("acme__api", false);
        // Settings' row for the person's server, off, sends its name alone.
        const checked = yield* handlers["mcp.tools"]({ server: "acme__api" }).pipe(Effect.flip);
        const row = (yield* handlers["mcp.list"]({})).servers.find((s) => s.name === "acme__api");
        return { checked: { reason: checked.reason, message: checked.message }, row, measured: Option.getOrUndefined(hub.measured({ plugin: "acme@bird", server: "api" })) };
      }).pipe(Effect.scoped, Effect.provide(layer())),
    );
    expect(out.checked).toEqual({ reason: "not_found", message: "no MCP server acme__api here" });
    expect(out.row).toMatchObject({ name: "acme__api", enabled: false });
    expect(out.row?.tools).toBeUndefined();
    expect(out.measured).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "closes and measures a server in every thread's pool, though a repository's plugin holds its key in that repository",
    async () => {
      const { dir, mine, theirs, marketplace } = twoServers("pools");
      const work = path.join(dir, "web");
      fs.mkdirSync(work);
      spawnSync("git", ["init", "-q"], { cwd: work });
      spawnSync("git", ["remote", "add", "origin", "https://github.com/acme/web.git"], { cwd: work });
      const inRepo = ThreadId.make("hub-in-repo");
      const store = Layer.succeed(SessionStore, {
        getByThread: (threadId: ThreadId) => Effect.succeed(threadId === inRepo ? { internal: { worktreePath: work } } : undefined),
      } as never);
      const running = (script: string) =>
        (spawnSync("ps", ["-A", "-o", "pid=", "-o", "args="], { encoding: "utf8" }).stdout ?? "").split("\n").filter((line) => line.includes(script)).length > 0;
      const settle = (done: () => boolean) =>
        Effect.promise(async () => {
          for (const deadline = Date.now() + 10_000; !done() && Date.now() < deadline; ) await new Promise((r) => setTimeout(r, 25));
        });
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer({ name: "acme__api", command: process.execPath, args: [mine, "mine"], source: "manual", enabled: true }, false);
          yield* registry.addMarketplace(marketplace);
          yield* registry.install({ id: "acme@bird", scope: "project", project: { id: "p1", name: "web", repository: "github.com/acme/web" }, cwd: work });
          const keys = { outside: Object.keys((yield* registry.session()).bundle.mcpServers), inRepo: Object.keys((yield* registry.session(work)).bundle.mcpServers).sort() };
          const list = (threadId: ThreadId, key: string) => hub.handle({ threadId, hooks: false }, key, { jsonrpc: "2.0", id: key, method: "tools/list" }).pipe(Effect.map(toolNames));
          const listed = {
            outside: yield* list(caller.threadId, "acme__api"),
            inRepo: yield* list(inRepo, "acme__api"),
            personalInRepo: yield* list(inRepo, "my-servers_personal__acme__api"),
          };
          const measured = {
            personal: Option.getOrUndefined(hub.measured(personalServer("acme__api")))?.tools,
            plugin: Option.getOrUndefined(hub.measured({ plugin: "acme@bird", server: "api" }))?.tools,
          };
          // A sign-out of the person's server: both threads' connections to it go, the repository plugin's stays.
          yield* hub.disconnect(personalServer("acme__api"));
          yield* settle(() => !running(mine));
          return { keys, listed, measured, mine: running(mine), theirs: running(theirs) };
        }).pipe(Effect.scoped, Effect.provide(layer(store))),
      );
      expect(out.keys).toEqual({ outside: ["acme__api"], inRepo: ["acme__api", "my-servers_personal__acme__api"] });
      expect(out.listed).toEqual({ outside: ["mine"], inRepo: ["theirs"], personalInRepo: ["mine"] });
      expect(out.measured).toEqual({ personal: ["mine"], plugin: ["theirs"] });
      expect(out.mine).toBe(false);
      expect(out.theirs).toBe(true);
    },
  );
});

// Skipped on Windows: a Cloud computer is Linux, and its tools channel a Unix socket.
describe.skipIf(process.platform === "win32")("the hub's stdio servers on a Cloud computer", () => {
  it("start in the tools container through its exec channel, with their configured environment", async () => {
    const socket = path.join(tmp, "tools.sock");
    // TOOLS_SIDE marks a process the tools container started; this (runtime) process has none.
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", socket], { env: { ...process.env, TOOLS_SIDE: "yes" }, stdio: "ignore" });
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(socket) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const script = path.join(tmp, "side.mjs");
      fs.writeFileSync(script, SERVER.replace('(process.env.SECRET_IN_RUNTIME ?? "hidden")', '(process.env.TOOLS_SIDE ?? "runtime")'));
      const server = { type: "stdio" as const, command: process.execPath, args: [script], env: { ECHO_TOKEN: "t0k" } };
      const launch = stdioLaunch(server, socket);
      expect([launch.command, launch.args.slice(0, 5)]).toEqual([process.execPath, ["--disable-sigusr1", TOOLS_EXEC, "exec", "--socket", socket]]);
      const client = new McpClient({ name: "test", version: "0", requestTimeoutMs: 10_000 });
      await client.connect(new StdioTransport({ ...launch, inheritEnv: false, stderr: "pipe" }));
      const out = (await client.callTool("echo", { text: "hi" })) as { content: Array<{ text: string }> };
      expect(out.content[0]!.text).toBe("echo:hi:t0k:yes");
      await client.close();
      // Off a Cloud computer the hub starts the server itself, as before.
      expect(stdioLaunch(server, undefined)).toMatchObject({ command: process.execPath, args: [script] });
    } finally {
      tools.kill();
    }
  });

  it("refuse a server with keys when the pod names a servers container that does not prove itself; one without keys starts in tools", async () => {
    const real = path.join(tmp, "tools-unproven.sock");
    const tools = spawn(process.execPath, [TOOLS_EXEC, "serve", real], { stdio: "ignore" });
    // The tools channel as the hub reaches it, through a relay that records what it is asked to run (the plugin
    // launcher passes a server only its allowlisted environment, so the server cannot say where it runs).
    const asked: Array<string> = [];
    const relay = createNetServer((client) => {
      const upstream = connectNet({ path: real });
      client.on("data", (c: Buffer) => (asked.push(c.toString()), upstream.write(c)));
      upstream.on("data", (c: Buffer) => client.write(c));
      for (const end of [client, upstream]) end.on("error", () => {}).on("close", () => (client.destroy(), upstream.destroy()));
    });
    const socket = path.join(tmp, "tools-relay.sock");
    await new Promise<void>((resolve) => relay.listen(socket, resolve));
    // Something else holds the servers address (a process on the pod's loopback): it accepts, and never proves the token.
    const heard: Array<string> = [];
    const squatter = createNetServer((s) => s.on("data", (c) => heard.push(c.toString())).on("error", () => {}));
    const squatted = path.join(tmp, "servers-squatted.sock");
    await new Promise<void>((resolve) => squatter.listen(squatted, resolve));
    const before = { ...process.env };
    try {
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(real) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      const script = path.join(tmp, "unproven.mjs");
      fs.writeFileSync(script, SERVER);
      Object.assign(process.env, { CAVEMAN_RUNTIME_TOOLS_ADDRESS: socket, CAVEMAN_RUNTIME_SERVERS_ADDRESS: squatted, CAVEMAN_RUNTIME_SERVERS_TOKEN: "f".repeat(64) });
      const out = await Effect.runPromise(
        Effect.gen(function* () {
          const registry = yield* PluginRegistry.PluginRegistry;
          const hub = yield* McpHub;
          yield* registry.saveServer({ name: "keyed", command: process.execPath, args: [script], env: ["ECHO_TOKEN"], source: "manual", enabled: true }, false);
          yield* registry.grant("personal", "ECHO_TOKEN", Redacted.make("keyed-canary"));
          yield* registry.saveServer({ name: "plain", command: process.execPath, args: [script], env: [], source: "manual", enabled: true }, false);
          const keyed = yield* hub.handle(caller, "keyed", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
          yield* hub.handle(caller, "plain", { jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25" } });
          const plain = yield* hub.handle(caller, "plain", { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } });
          return { keyed, plain };
        }).pipe(Effect.scoped, Effect.provide(layer())),
      );
      expect(out.keyed).toMatchObject({ id: 1, error: { message: expect.stringContaining("did not prove itself") } });
      expect(out.plain).toMatchObject({ id: 3, result: { content: [{ type: "text", text: "echo:hi:none:hidden" }] } });
      // The plain server started in tools; the keyed one reached neither tools nor the squatter, which heard only the
      // handshake's nonces.
      expect(asked.join("")).toContain(script);
      expect(asked.join("")).not.toContain("keyed-canary");
      expect(heard.join("")).not.toContain("keyed-canary");
      expect(heard.join("")).not.toContain("argv");
    } finally {
      for (const name of ["CAVEMAN_RUNTIME_TOOLS_ADDRESS", "CAVEMAN_RUNTIME_SERVERS_ADDRESS", "CAVEMAN_RUNTIME_SERVERS_TOKEN"]) {
        if (before[name] === undefined) delete process.env[name];
        else process.env[name] = before[name];
      }
      tools.kill();
      relay.close();
      squatter.close();
    }
  }, 60_000);
});
