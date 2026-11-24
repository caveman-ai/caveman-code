// `bin.ts code mcp` from source, as an MCP host runs it: stdout carries JSON-RPC and nothing else, initialize and
// tools/list answer without a runtime, the 14 tools come in their fixed order, and a tool call becomes the agent on a
// stand-in runtime first. Its flags, too.
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { startFakeRuntime } from "../outsideAgent/fakeRuntime.testkit.ts";
import { workspace } from "../outsideAgent/fixtures.testkit.ts";
import { parseMcpFlags } from "./mcp.ts";

const TOOL_ORDER = ["chats", "projects", "engines", "chat_start", "chat_send", "chat_read", "chat_wait", "chat_answer", "chat_stop", "chat_diff", "chat_undo", "chat_organize", "chat_ship", "project_add"];
const BIN = path.resolve(import.meta.dirname, "../bin.ts");

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

interface Server {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  notify(method: string, params?: unknown): void;
  /** Ends stdin (the host went away) and resolves with the exit code. */
  end(): Promise<number | null>;
  readonly lines: Array<string>;
  readonly stderr: () => string;
}

function startMcp(home: string, args: ReadonlyArray<string> = []): Server {
  const child = spawn(process.execPath, [BIN, "code", "mcp", ...args], {
    cwd: home,
    env: { ...process.env, CAVEMAN_CODE_HOME: home },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanup.push(() => child.exitCode === null && child.kill("SIGKILL"));
  const lines: Array<string> = [];
  const waiting = new Map<number, (message: Record<string, unknown>) => void>();
  let stderr = "";
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id === "number") waiting.get(message.id)?.(message);
    } catch {
      // The test reads every line again below; a line that isn't JSON fails it there.
    }
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  let next = 0;
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    lines,
    stderr: () => stderr,
    request: (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => reject(new Error(`no answer to ${method}; stderr:\n${stderr}`)), 20_000);
        waiting.set(id, (message) => (clearTimeout(timer), resolve(message)));
        send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
      }),
    notify: (method, params) => send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }),
    end: async () => {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      const code = await exited;
      clearTimeout(timer);
      return code;
    },
  };
}

const tempHome = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc-mcp-"));
  fs.chmodSync(dir, 0o700);
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const text = (response: Record<string, unknown>) => {
  const result = response.result as { content: Array<{ type: string; text?: string }>; isError?: boolean };
  return { text: result.content.map((c) => c.text ?? "").join(""), isError: result.isError === true };
};

describe("caveman-code mcp", () => {
  it("keeps stdout for JSON-RPC alone, lists the 14 tools in a fixed order, and becomes the agent on its first call", async () => {
    const home = tempHome();
    const rt = await startFakeRuntime();
    cleanup.push(() => rt.close());
    rt.handlers.set("workspace.list", () => ({ workspaces: [workspace({ id: "w1", title: "Hello from the runtime", repo: { path: home }, status: "working" })] }));
    rt.handlers.set("project.list", () => ({ projects: [] }));
    rt.handlers.set("chat.search", () => ({ chats: [], indexing: false, meaning: "unavailable" }));
    rt.publish(home);

    const server = startMcp(home, ["--name", "Test bot"]);
    const init = await server.request("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-code", version: "1.0.0" } });
    const result = init.result as { protocolVersion: string; instructions: string; serverInfo: { name: string } };
    expect(result.protocolVersion).toBe("2025-11-25");
    expect(result.serverInfo.name).toBe("Caveman Code");
    expect(result.instructions).toContain("Start with `chats`");
    server.notify("notifications/initialized");
    const list = await server.request("tools/list");
    expect((list.result as { tools: Array<{ name: string }> }).tools.map((t) => t.name)).toEqual(TOOL_ORDER);
    // Nothing reached the runtime for initialize or tools/list, past the hello every socket opens with.
    expect(rt.frames.filter((f) => f.method !== "engine.list" && f.method !== "runtime.hello")).toEqual([]);

    const chats = text(await server.request("tools/call", { name: "chats", arguments: {} }));
    expect(chats.isError).toBe(false);
    expect(chats.text).toContain("[w1] Hello from the runtime");
    const empty = text(await server.request("tools/call", { name: "chat_wait", arguments: {} }));
    expect(empty).toMatchObject({ isError: true });
    expect(empty.text).toContain("Nothing to wait for");
    // A long chat_wait doesn't hold up the calls after it.
    const waiting = server.request("tools/call", { name: "chat_wait", arguments: { chats: ["w1"], timeout_s: 3 } });
    const meanwhile = server.request("tools/call", { name: "engines", arguments: {} }).then((r) => ({ at: Date.now(), r }));
    const waited = await waiting.then((r) => ({ at: Date.now(), r }));
    expect((await meanwhile).at).toBeLessThan(waited.at);
    expect(text(waited.r).text).toContain("No change in 3 s.");
    const invalid = await server.request("tools/call", { name: "chat_send", arguments: { chat: 3 } });
    expect(invalid.error).toBeUndefined();
    expect(text(invalid).isError).toBe(true);

    expect(await server.end()).toBe(0);
    const become = rt.frames.find((f) => f.method === "outside_agent.become");
    expect(become?.params.name).toBe("Test bot");
    expect(server.lines.length).toBeGreaterThanOrEqual(5);
    for (const line of server.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
    expect(server.stderr()).not.toContain(rt.token);
  });

  it("offers 2025-03-26 and tells the agent when Caveman Code isn't running", async () => {
    const server = startMcp(tempHome());
    const init = await server.request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-mcp-client", version: "1" } });
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe("2025-03-26");
    server.notify("notifications/initialized");
    const answer = text(await server.request("tools/call", { name: "projects", arguments: {} }));
    expect(answer).toEqual({ isError: true, text: "Caveman Code isn't running. Tell your user to open it (or run `caveman-code` in a terminal), then call again." });
    expect(await server.end()).toBe(0);
    for (const line of server.lines) expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
  });

  it("reads its flags", () => {
    expect(parseMcpFlags([])).toEqual({ name: undefined, atMost: undefined });
    expect(parseMcpFlags(["--name", "Nightly", "--at-most", "read"])).toEqual({ name: "Nightly", atMost: "read" });
    expect(parseMcpFlags(["--at-most=supervised", "--name=Bot"])).toEqual({ name: "Bot", atMost: "supervised" });
    expect(parseMcpFlags(["--at-most", "full"])).toEqual({ error: "--at-most takes read or supervised" });
    expect(parseMcpFlags(["--name"])).toEqual({ error: "--name needs a label" });
    expect(parseMcpFlags(["--port", "1"])).toEqual({ error: "unknown argument --port" });
  });
});
