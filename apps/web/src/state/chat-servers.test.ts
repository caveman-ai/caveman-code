import { SessionProtocolError } from "@caveman-app/session-protocol";
import type { Client } from "@caveman-app/session-protocol/client";
import { describe, expect, test } from "vitest";
import { chatServers, serverKey, serverMeta, stopChatServer } from "./chat-servers.ts";

describe("chatServers", () => {
  test("keeps only the servers this chat started, by port", () => {
    const read = chatServers({
      servers: [
        { port: 5173, url: "http://localhost:5173", process_name: "node", pid: 41, started_by: "agent" },
        // Another chat's, or one nobody here started: listed for the new tab, not for this chat.
        { port: 8080, url: "http://localhost:8080", process_name: "python3" },
        { port: 3000, url: "http://localhost:3000", pid: 42, started_by: "terminal", terminal_id: "term-1" },
      ],
      can_stop: true,
    });
    expect(read.canStop).toBe(true);
    expect(read.servers).toEqual([
      { port: 3000, url: "http://localhost:3000", pid: 42, startedBy: "terminal", processName: null, terminalId: "term-1" },
      { port: 5173, url: "http://localhost:5173", pid: 41, startedBy: "agent", processName: "node", terminalId: null },
    ]);
  });

  test("an older runtime's answer lists none and can't stop", () => {
    expect(chatServers({ servers: [{ port: 5173, url: "http://localhost:5173", process_name: "node" }] })).toEqual({ servers: [], canStop: false });
  });

  test("a server without a pid can't be stopped, so it isn't listed as the chat's", () => {
    expect(chatServers({ servers: [{ port: 5173, url: "http://localhost:5173", started_by: "agent" }], can_stop: true }).servers).toEqual([]);
  });
});

test("serverMeta says who started it, then its process", () => {
  const base = { port: 1, url: "http://localhost:1", pid: 7, terminalId: null };
  expect(serverMeta({ ...base, startedBy: "agent", processName: "node" })).toBe("Agent · node");
  expect(serverMeta({ ...base, startedBy: "terminal", processName: null })).toBe("Terminal");
  expect(serverKey({ pid: 7, port: 1 })).toBe("7:1");
});

describe("stopChatServer", () => {
  const refused = (reason: string) => new SessionProtocolError({ code: -32004, message: "shares a process group", data: { reason } } as never);
  const clientThat = (fail: Error | null) => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const client = {
      call: async (method: string, params: unknown) => {
        calls.push({ method, params });
        if (fail) throw fail;
        return {};
      },
    } as unknown as Client;
    return { client, calls };
  };
  const terminalServer = { pid: 7, port: 5173, startedBy: "terminal" as const, terminalId: "term-1" };

  test("asks the runtime to stop the server's job", async () => {
    const { client, calls } = clientThat(null);
    const runs: string[] = [];
    await stopChatServer(client, "w1", terminalServer, async (_c, _w, t) => void runs.push(t));
    expect(calls).toMatchObject([{ method: "workspace.servers.stop", params: { workspace_id: "w1", pid: 7, port: 5173 } }]);
    expect(runs).toEqual([]);
  });

  test("an action's own process (its terminal's group) stops as its run does", async () => {
    const { client } = clientThat(refused("invalid_state"));
    const runs: string[] = [];
    await stopChatServer(client, "w1", terminalServer, async (_c, _w, t) => void runs.push(t));
    expect(runs).toEqual(["term-1"]);
  });

  test("an agent's server the runtime refuses says why; no terminal is touched", async () => {
    const { client } = clientThat(refused("invalid_state"));
    const runs: string[] = [];
    await expect(
      stopChatServer(client, "w1", { ...terminalServer, startedBy: "agent", terminalId: null }, async (_c, _w, t) => void runs.push(t)),
    ).rejects.toThrow("shares a process group");
    expect(runs).toEqual([]);
  });

  test("a server that is gone is not retried through its terminal", async () => {
    const { client } = clientThat(refused("not_found"));
    await expect(stopChatServer(client, "w1", terminalServer, async () => undefined)).rejects.toBeInstanceOf(SessionProtocolError);
  });
});
