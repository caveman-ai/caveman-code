// The Chief on a Claude plan: Claude Code gets the Chief's prompt as its whole system prompt, no tool
// of its own, nothing from the person's settings, and the Chief's tools over an in-process MCP server
// that runs each call as the Chief's thread inside its current app run.
import type { ChiefProfile } from "@caveman-app/engine-core/server/ChiefSessions";
import { ProviderInstanceId, ThreadId } from "@caveman-app/protocol";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, test } from "vitest";

import { chiefMcpServer, chiefQueryOptions } from "./claudeChief.ts";
import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";

const calls: Array<{ thread: string; input: unknown; runId: string }> = [];
const profile: ChiefProfile = {
  instructions: "You are the Chief.",
  sections: [{ id: "rules", title: "Your rules", text: "Ship small." } as never],
  tools: [
    {
      name: "queue_add",
      description: "Add an item.",
      input: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (thread, input, call) => (calls.push({ thread, input, runId: call.runId }), { id: "ci-1" }),
    },
    { name: "chat_stop", description: "Stop a chat.", input: { type: "object", properties: {} }, run: async () => Promise.reject(new Error("No chat w-9")) },
  ],
};

test("Claude Code runs the Chief with its prompt alone, no built-in tools and no settings files", () => {
  const chief = chiefQueryOptions(profile);
  const options = makeClaudeQueryOptions({
    modelSelection: { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-sonnet-5-5" },
    nativeThreadId: "chief-thread",
    resume: false,
    cwd: "/state/chief",
    tools: chief.tools,
    systemPrompt: chief.systemPrompt,
    allowedTools: chief.allowedTools,
    settingSources: chief.settingSources,
  });
  expect(options.systemPrompt).toBe("You are the Chief.\n\n# Your rules\n\nShip small.");
  expect(options.tools).toEqual([]);
  expect(options.settingSources).toEqual([]);
  expect(options.allowedTools).toEqual(["mcp__chief__queue_add", "mcp__chief__chat_stop"]);
  expect(options.model).toBe("claude-sonnet-5-5");
});

test("the Chief's tools answer over MCP as the Chief's thread, inside its current run", async () => {
  const thread = ThreadId.make("caveman:chief-1");
  let run = "run-1";
  const server = chiefMcpServer(profile, thread, () => run);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const listed = await client.listTools();
  expect(listed.tools.map((t) => [t.name, t.inputSchema.required])).toEqual([["queue_add", ["text"]], ["chat_stop", undefined]]);
  run = "run-2";
  const added = await client.callTool({ name: "queue_add", arguments: { text: "ship it" } });
  expect(added.content).toEqual([{ type: "text", text: '{"id":"ci-1"}' }]);
  expect(calls).toEqual([{ thread, input: { text: "ship it" }, runId: "run-2" }]);
  // A refused call is the tool's error text, never a crash of the server.
  const refused = await client.callTool({ name: "chat_stop", arguments: {} });
  expect([refused.isError, refused.content]).toEqual([true, [{ type: "text", text: "No chat w-9" }]]);
  await client.close();
});
