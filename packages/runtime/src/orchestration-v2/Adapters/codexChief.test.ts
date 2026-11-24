// The Chief on Codex: Codex gets the Chief's prompt as its base instructions, the Chief's tools as dynamic tools, no
// tool, server, hook, skill or memory of its own, a read-only sandbox under approval "never", and each tool call runs
// as the Chief's thread inside its current app run.
import type { ChiefProfile } from "@caveman-app/engine-core/server/ChiefSessions";
import { ThreadId } from "@caveman-app/protocol";
import { expect, test } from "vitest";

import {
  CODEX_CHIEF_CONFIG,
  codexChiefThreadParams,
  codexChiefToolCall,
  codexConfigMcpServers,
} from "./codexChief.ts";
import { codexThreadRuntimeParams } from "./CodexAdapterV2.ts";

const calls: Array<{ thread: string; input: unknown; runId: string; callId: string }> = [];
const profile: ChiefProfile = {
  instructions: "You are the Chief.",
  sections: [{ id: "rules", title: "Your rules", text: "Ship small." } as never],
  tools: [
    {
      name: "queue_add",
      description: "Add an item.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (thread, input, call) => (
        calls.push({ thread, input, runId: call.runId, callId: call.callId }),
        { id: "ci-1" }
      ),
    },
    {
      name: "chat_stop",
      description: "Stop a chat.",
      input: { type: "object", properties: {} },
      run: async () => Promise.reject(new Error("No chat w-9")),
    },
  ],
};

test("a Chief thread is the Chief's prompt and tools alone, every MCP server of the person's turned off", () => {
  const chief = codexChiefThreadParams(profile, ["github", "node_repl", "acme.tools"]);
  expect(chief.baseInstructions).toBe("You are the Chief.\n\n# Your rules\n\nShip small.");
  expect(chief.dynamicTools).toEqual([
    {
      type: "function",
      name: "queue_add",
      description: "Add an item.",
      inputSchema: profile.tools[0]!.input,
    },
    {
      type: "function",
      name: "chat_stop",
      description: "Stop a chat.",
      inputSchema: { type: "object", properties: {} },
    },
  ]);
  expect([chief.sandbox, chief.approvalPolicy]).toEqual(["read-only", "never"]);
  expect(Object.keys(chief.config).some((key) => key.startsWith("mcp_servers."))).toBe(false);
  expect(codexChiefThreadParams(profile, []).config).not.toHaveProperty("mcp_servers");
  expect(chief.config).toEqual({
    ...CODEX_CHIEF_CONFIG,
    // One table, merged into the person's: a dotted key per server would split `acme.tools` at its dot.
    mcp_servers: {
      github: { enabled: false },
      node_repl: { enabled: false },
      "acme.tools": { enabled: false },
    },
  });
  expect(codexConfigMcpServers({ mcp_servers: { github: {}, node_repl: {} } } as never)).toEqual([
    "github",
    "node_repl",
  ]);
  expect(codexConfigMcpServers({} as never)).toEqual([]);
});

test("a Chief thread takes none of a chat's servers, plugins, instructions or settings, and keeps Auto's route", () => {
  const params = codexThreadRuntimeParams({
    threadId: "thread-chief",
    mcpSession: {
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer secret",
    } as never,
    plugins: {
      config: { mcp_servers: { slack: { url: "https://slack.example/mcp" } } },
      developerInstructions: "Use the space.",
      toolEnv: { TOKEN: "x" },
    } as never,
    modelSelection: { model: "caveman-auto" },
    runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/state/chief" },
    router: { proxy: "http://127.0.0.1:9", session: "thread-chief", chatgpt: true },
    chief: codexChiefThreadParams(profile, []),
  });
  expect(params.developerInstructions).toBeUndefined();
  expect(params.cwd).toBe("/state/chief");
  expect(params.modelProvider).toBe("caveman");
  expect(params.baseInstructions).toContain("You are the Chief.");
  expect(params.dynamicTools?.map((t) => t.name)).toEqual(["queue_add", "chat_stop"]);
  const keys = Object.keys(params.config);
  expect(
    keys.filter((k) => k.startsWith("mcp_servers.") || k.startsWith("shell_environment_policy.")),
  ).toEqual([]);
  expect(keys.filter((k) => k.startsWith("model_providers."))).toEqual(["model_providers.caveman"]);
  expect(params.config.web_search).toBe("disabled");
});

test("a tool call runs as the Chief's thread in its app run; a failure or an unknown tool is the tool's error text", async () => {
  const thread = ThreadId.make("thread-chief");
  expect(
    await codexChiefToolCall(
      profile,
      thread,
      { tool: "queue_add", arguments: { text: "ship it" }, callId: "call-1" },
      "run-7",
    ),
  ).toEqual({
    success: true,
    contentItems: [{ type: "inputText", text: '{"id":"ci-1"}' }],
  });
  expect(calls).toEqual([
    { thread: "thread-chief", input: { text: "ship it" }, runId: "run-7", callId: "call-1" },
  ]);
  expect(
    await codexChiefToolCall(
      profile,
      thread,
      { tool: "chat_stop", arguments: {}, callId: "call-2" },
      "run-7",
    ),
  ).toEqual({
    success: false,
    contentItems: [{ type: "inputText", text: "No chat w-9" }],
  });
  expect(
    await codexChiefToolCall(
      profile,
      thread,
      { tool: "exec_command", arguments: { cmd: "ls" }, callId: "call-3" },
      "run-7",
    ),
  ).toEqual({
    success: false,
    contentItems: [{ type: "inputText", text: "No Chief tool exec_command." }],
  });
});
