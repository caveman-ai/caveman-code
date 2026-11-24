// The link with the real Session Protocol client against a stand-in runtime: `become` is the first frame on every
// socket (a reconnect's included, before a pending call goes out again); a refused `become` answers the Disconnected
// text and is tried again on the next call; no runtime opens the app or says how to start one; a runtime restarted on
// another port gets a new client with the same agent_id; a call given up on never goes out later, and one that changes
// something and had gone out says it may have gone through.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { connect, type ConnectionState } from "@caveman-app/session-protocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { liveRuntime } from "../cli/code.ts";
import { Bridge } from "./bridge.ts";
import { NOT_RUNNING, RuntimeLink, STARTING, TOO_OLD, disconnected, type Acquired } from "./connection.ts";
import { forbidden, startFakeRuntime, type FakeRuntime } from "./fakeRuntime.testkit.ts";
import { workspace } from "./fixtures.testkit.ts";

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) await step();
});

const home = () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "cc-mcp-home-"));
  fs.chmodSync(dir, 0o700);
  cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const runtime = async () => {
  const rt = await startFakeRuntime();
  cleanup.push(() => rt.close());
  rt.handlers.set("workspace.list", () => ({ workspaces: [] }));
  return rt;
};

const link = (options: Partial<ConstructorParameters<typeof RuntimeLink>[0]> & { readonly home: string }) => {
  const made = new RuntimeLink({ agentId: "agent-1", find: liveRuntime, readyMs: 5_000, ...options });
  cleanup.push(() => made.close());
  return made;
};

const ok = (acquired: Acquired) => {
  if (!acquired.ok) throw new Error(`not connected: ${acquired.text}`);
  return acquired.session;
};

/** Each socket's frames, leaving out liveRuntime's probes (an owner connection that only asks engine.list). */
/** Each socket's calls after the runtime.hello every socket opens with (session-protocol client.ts). */
const sockets = (rt: FakeRuntime) => {
  const by = new Map<number, Array<string>>();
  for (const frame of rt.frames)
    if (frame.method !== "runtime.hello") by.set(frame.socket, [...(by.get(frame.socket) ?? []), frame.method]);
  return [...by.values()].filter((methods) => !methods.every((m) => m === "engine.list"));
};

const until = async (check: () => boolean, ms = 10_000) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe("RuntimeLink", () => {
  it("becomes the agent first on every socket, a reconnect's included, before a waiting call goes out again", async () => {
    const dir = home();
    const rt = await runtime();
    rt.publish(dir);
    const session = ok(await link({ home: dir }).acquire("Grok"));
    expect(session.agent).toEqual({ name: "Grok", level: "supervised" });
    await session.client.call("workspace.list", {});
    rt.dropAll();
    // Made while the link is down: it waits, and goes out on the next socket only after `become`.
    await session.client.call("workspace.list", {});
    const opened = sockets(rt);
    expect(opened.length).toBeGreaterThanOrEqual(2);
    for (const methods of opened) expect(methods[0]).toBe("outside_agent.become");
    const becomes = rt.frames.filter((f) => f.method === "outside_agent.become").map((f) => f.params);
    expect(new Set(becomes.map((p) => p.agent_id))).toEqual(new Set(["agent-1"]));
    expect(becomes.every((p) => p.name === "Grok" && p.at_most === undefined)).toBe(true);
  });

  it("passes --at-most, and never sends the token anywhere but the bearer", async () => {
    const dir = home();
    const rt = await runtime();
    rt.publish(dir);
    const session = ok(await link({ home: dir, atMost: "read" }).acquire("Bot"));
    expect(session.agent.level).toBe("read");
    expect(rt.frames.find((f) => f.method === "outside_agent.become")?.params).toEqual({ agent_id: "agent-1", name: "Bot", at_most: "read" });
    expect(JSON.stringify(rt.frames)).not.toContain(rt.token);
  });

  it("answers the Disconnected text for a blocked name, and tries again on the next call", async () => {
    const dir = home();
    const rt = await runtime();
    rt.publish(dir);
    const become = rt.handlers.get("outside_agent.become")!;
    rt.handlers.set("outside_agent.become", () => forbidden("Grok was disconnected by the person"));
    const made = link({ home: dir });
    expect(await made.acquire("Grok")).toEqual({ ok: false, text: disconnected("Grok") });
    expect(await made.acquire("Grok")).toEqual({ ok: false, text: disconnected("Grok") });
    rt.handlers.set("outside_agent.become", become);
    expect((await made.acquire("Grok")).ok).toBe(true);
  });

  it("says a runtime without outside agents is too old", async () => {
    const dir = home();
    const rt = await runtime();
    rt.publish(dir);
    rt.handlers.delete("outside_agent.become");
    expect(await link({ home: dir }).acquire("Grok")).toEqual({ ok: false, text: TOO_OLD });
  });

  it("with no runtime: says how to start one, or opens the app hidden once and connects when it is up", async () => {
    expect(await link({ home: home() }).acquire("Grok")).toEqual({ ok: false, text: NOT_RUNNING });
    const dir = home();
    const openApp = vi.fn();
    const made = link({ home: dir, app: "/Applications/Caveman Code.app", openApp, startMs: 300, pollMs: 50 });
    expect(await made.acquire("Grok")).toEqual({ ok: false, text: STARTING });
    expect(openApp).toHaveBeenCalledExactlyOnceWith("/Applications/Caveman Code.app");
    const rt = await runtime();
    rt.publish(dir);
    expect((await made.acquire("Grok")).ok).toBe(true);
    expect(openApp).toHaveBeenCalledTimes(1);
  });

  it("makes a new client, with the same agent_id, for a runtime restarted on another port", async () => {
    const dir = home();
    const first = await runtime();
    first.publish(dir);
    const made = link({ home: dir });
    const ready = vi.fn();
    made.onReady(ready);
    ok(await made.acquire("Grok"));
    const second = await startFakeRuntime("a-new-token");
    cleanup.push(() => second.close());
    second.handlers.set("workspace.list", () => ({ workspaces: [] }));
    second.publish(dir);
    await first.close();
    await until(() => second.frames.some((f) => f.method === "outside_agent.become"));
    expect(second.frames.find((f) => f.method === "outside_agent.become")?.params.agent_id).toBe("agent-1");
    const session = ok(await made.acquire("Grok"));
    await session.client.call("workspace.list", {});
    expect(second.frames.at(-1)?.method).toBe("workspace.list");
    expect(ready).toHaveBeenCalledTimes(2);
  });

  it("hears workspace.changed as the agent", async () => {
    const dir = home();
    const rt = await runtime();
    rt.publish(dir);
    const made = link({ home: dir });
    const seen = vi.fn();
    made.onWorkspace(seen);
    ok(await made.acquire("Grok"));
    rt.notify("workspace.changed", { id: "w1" });
    await until(() => seen.mock.calls.length > 0);
    expect(seen).toHaveBeenCalledWith({ id: "w1" });
  });
});

describe("a call given up on", () => {
  // The link goes down with the runtime dropping every socket while its token file no longer matches (upgrades refused,
  // the URL unchanged, as a runtime restarting on its own port), and comes back when the token is restored.
  const setup = async () => {
    const dir = home();
    const rt = await runtime();
    rt.publish(dir);
    const tokenFile = path.join(dir, "userdata", "session-protocol.token");
    const down = () => (fs.writeFileSync(tokenFile, "not-the-token", { mode: 0o600 }), rt.dropAll());
    const up = () => fs.writeFileSync(tokenFile, rt.token, { mode: 0o600 });
    rt.handlers.set("workspace.list", () => ({ workspaces: [workspace({ id: "w1", title: "Fix login", repo: { path: dir } })] }));
    rt.handlers.set("project.list", () => ({ projects: [] }));
    rt.handlers.set("turn.submit", () => ({ disposition: "started" }));
    const submitted = () => rt.frames.filter((f) => f.method === "turn.submit").map((f) => String(f.params.request_id));
    const states: Array<ConnectionState> = [];
    const made = link({
      home: dir,
      callMs: 600,
      readyMs: 10_000,
      connect: (url, token, onState, options) => connect(url, token, (state, error) => (states.push(state), onState(state, error)), options),
    });
    let n = 0;
    const bridge = new Bridge({ link: made, cwd: os.tmpdir(), requestId: () => `req-${++n}` });
    const run = (tool: string, params: Record<string, unknown>) => bridge.call(tool, params, { clientName: "codex-mcp-client" });
    expect((await run("chats", {})).isError).toBeFalsy();
    return { rt, made, states, down, up, submitted, run };
  };

  it("never goes out later, so a chat_send retried as its error says reaches the runtime once", async () => {
    const { made, states, down, up, submitted, run } = await setup();
    // A tool call that acquired the session before the link dropped, and makes its turn.submit once the client knows.
    const session = ok(await made.acquire("Codex"));
    down();
    // A retry since the link was open: each says "connecting", then "closed" through its backoff, so a poll can miss
    // "connecting" as the latest state.
    await until(() => states.lastIndexOf("connecting") > states.lastIndexOf("open"));
    const given = session.client.call("turn.submit", { request_id: "given-up", session_id: "s-w1", kind: "followup", input: { text: "add a test" } });
    await expect(given).rejects.toThrow("Caveman Code didn't answer turn.submit in time; call again in a few seconds.");
    up();
    const retried = await run("chat_send", { chat: "w1", text: "add a test" });
    expect(retried.isError).toBeFalsy();
    // Anything still waiting in the client went out on the new socket before the retry did.
    expect(submitted()).toEqual(["req-1"]);
  }, 30_000);

  it("says a change that went out unanswered may still have gone through, and never sends it again", async () => {
    const { rt, down, up, submitted, run } = await setup();
    // The runtime takes turn.submit and the link drops before its answer comes.
    rt.handlers.set("turn.submit", () => (down(), { disposition: "started" }));
    const first = await run("chat_send", { chat: "w1", text: "add a test" });
    expect(first).toEqual({
      text: "Caveman Code didn't answer turn.submit in time, and it may still have gone through. Check before you call again.",
      isError: true,
    });
    rt.handlers.set("turn.submit", () => ({ disposition: "started" }));
    up();
    expect((await run("chats", {})).isError).toBeFalsy();
    expect(submitted()).toEqual(["req-1"]);
  }, 30_000);
});
