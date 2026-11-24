// An outside agent through the real Session Protocol server (the fake `claude` answers every turn): become as the
// client's handshake, start a chat and message it with every message stamped as the agent's, read it through
// workspace.digest, and be refused what the gate keeps for the person (installing into clients too); the person lists,
// then disconnects it.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { afterAll, beforeAll, expect, test } from "vitest";

import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "./testHarness.ts";

let root: string;
let repo: string;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let owner: ReturnType<typeof connect>;
const agentId = randomUUID();

/** A client whose every socket becomes the agent's first (the bridge's handshake). */
const agentClient = (name: string, id = agentId) =>
  connect(runtime.url, runtime.token, undefined, {
    handshake: async (link) => void (await link.call("outside_agent.become", { agent_id: id, name })),
  });

const refusal = (call: Promise<unknown>) =>
  call.then(
    () => ({ reason: "none", message: "" }),
    (error: { error?: { message: string; data?: { reason?: string } } }) => ({ reason: error.error?.data?.reason ?? String(error), message: error.error?.message ?? "" }),
  );

beforeAll(async () => {
  root = tempRoot("sp-outside-");
  repo = makeRepo(root, { "README.md": "hello\n" });
  runtime = await startRuntime(await makeConfig(), "fake-claude");
  owner = connect(runtime.url, runtime.token);
  await owner.call("project.create", { request_id: "p1", path: repo });
});
afterAll(async () => {
  owner.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

test("an outside agent starts and messages its own chat as itself, reads through the digest, and is refused the rest", async () => {
  const listed: Array<unknown> = [];
  owner.on("outside_agent.changed", (list) => listed.push(list));
  // The person's own chat, which a Supervised agent may read but not change.
  const persons = await createReady(owner, { request_id: "own-1", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL } });

  const agent = agentClient("Grok");
  const heard: Array<string> = [];
  for (const name of ["workspace.changed", "engine.changed", "outside_agent.changed", "secret.changed", "chief.board.updated", "cloud.changed", "session.moved"] as const) {
    agent.on(name, () => heard.push(name));
  }
  const workspace = await agent.call("workspace.create", { request_id: "c1", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL }, task: { text: "Say hi" } });
  expect(workspace.started_by).toEqual({ agent: "Grok" });

  // The person's window: the chat is there, its task the agent's, at Supervised (the person's default, Full, lowered).
  const events: Array<SessionEvent> = [];
  const attached = await owner.attach(workspace.session_id, 0, (event) => events.push(event));
  const userMessages = () => events.filter((e): e is Extract<SessionEvent, { type: "message.done" }> => e.type === "message.done" && e.payload.role === "user");
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  expect(userMessages()[0]?.payload).toMatchObject({ text: "Say hi", from: { title: "Grok", agent: true } });
  expect(events.find((e) => e.type === "turn.started")?.payload).toMatchObject({ access: "ask" });

  // A message the agent sends later reaches the transcript as the agent's too (the projector, from caveman_sp_senders).
  await agent.call("turn.submit", { request_id: "t1", session_id: workspace.session_id, kind: "followup", input: { text: "Again" } });
  await until(() => userMessages().some((m) => m.payload.text === "Again"), 60_000);
  expect(userMessages().find((m) => m.payload.text === "Again")?.payload.from).toEqual({ title: "Grok", agent: true });
  await until(() => events.filter((e) => e.type === "turn.done").length >= 2, 60_000);
  // Read back from the journal (an attach from cursor 0), the sender stays.
  const replayed: Array<SessionEvent> = [];
  const again = await owner.attach(workspace.session_id, 0, (event) => replayed.push(event));
  await until(() => replayed.some((e) => e.type === "message.done" && e.payload.text === "Again"));
  expect(replayed.filter((e) => e.type === "message.done" && e.payload.role === "user").map((e) => (e as Extract<SessionEvent, { type: "message.done" }>).payload.from)).toEqual([
    { title: "Grok", agent: true },
    { title: "Grok", agent: true },
  ]);
  await again.detach();
  await attached.detach();

  // The digest: its task, its latest answer, a page of its transcript; no usage.
  const digest = await agent.call("workspace.digest", { workspace_id: workspace.id, transcript: { max_bytes: 64 * 1024 } });
  expect(digest.workspace.started_by).toEqual({ agent: "Grok" });
  expect(digest.goal).toBe("Say hi");
  expect(digest.latest).toContain("smoke ok");
  expect(digest.messages).toBeGreaterThanOrEqual(4);
  expect(digest.options).toMatchObject({ access: "ask", model: MODEL });
  expect(digest.transcript!.events.some((e) => e.type === "usage")).toBe(false);
  expect(digest.transcript!.events.some((e) => e.type === "message.done" && e.payload.text === "Again")).toBe(true);
  // A small page ends at the head and says where the earlier one starts.
  const page = await agent.call("workspace.digest", { workspace_id: workspace.id, transcript: { max_bytes: 1024 } });
  expect(page.transcript!.more).toBe(true);
  const earlier = await agent.call("workspace.digest", { workspace_id: workspace.id, transcript: { before: page.transcript!.from, max_bytes: 1024 } });
  expect(earlier.transcript!.events.every((e) => e.cursor < page.transcript!.from)).toBe(true);

  // It reads the person's chats, never changes them; and the rest is the person's.
  expect((await agent.call("workspace.list", {})).workspaces.map((w: Workspace) => w.id)).toEqual(expect.arrayContaining([workspace.id, persons.id]));
  await agent.call("workspace.digest", { workspace_id: persons.id });
  expect((await refusal(agent.call("turn.submit", { request_id: "t2", session_id: persons.session_id, kind: "followup", input: { text: "hijack" } }))).reason).toBe("forbidden");
  expect(await refusal(agent.call("secret.list", { repo: { path: repo } }))).toEqual({ reason: "forbidden", message: "Outside agents can't call secret.list." });
  expect((await refusal(agent.call("session.attach", { session_id: workspace.session_id, cursor: 0 }))).reason).toBe("forbidden");
  expect((await refusal(agent.call("term.open", { request_id: "term-1", workspace_id: workspace.id, cols: 80, rows: 24 }))).reason).toBe("forbidden");
  expect((await refusal(agent.call("settings.set", { request_id: "s1", settings: { default_access: "full" } }))).reason).toBe("forbidden");
  expect((await refusal(agent.call("workspace.create", { request_id: "c2", repo: { path: repo }, branch: "main", engine: "claude-agent" }))).reason).toBe("forbidden");
  expect((await refusal(agent.call("workspace.create", { request_id: "c3", repo: { path: repo }, engine: "claude-agent", options: { access: "full" } }))).reason).toBe("forbidden");
  expect((await refusal(agent.call("git.push", { request_id: "g1", workspace_id: workspace.id }))).message).toContain("needs the Full access level");
  expect(await refusal(agent.call("outside_agent.become", { agent_id: agentId, name: "You" }))).toEqual({ reason: "forbidden", message: "Outside agents can't call outside_agent.become." });
  expect((await refusal(agent.call("outside_agent.list", {}))).reason).toBe("forbidden");
  // Installing Caveman MCP into a client writes the person's configs: theirs alone (mcpClients.test.ts has the rest).
  expect(await refusal(agent.call("outside_agent.install", { request_id: "i1", client: "codex" }))).toEqual({ reason: "forbidden", message: "Outside agents can't call outside_agent.install." });
  // It heard its chats change, and nothing that is the person's alone.
  expect(heard).toContain("workspace.changed");
  expect(heard.filter((h) => h !== "workspace.changed" && h !== "engine.changed")).toEqual([]);

  // The person's Settings: the agent, connected, with its chat; the command that connects one.
  const list = await owner.call("outside_agent.list", {});
  expect(list.agents).toEqual([expect.objectContaining({ name: "Grok", level: "supervised", blocked: false, connected: 1, chats: 1 })]);
  expect(list.command.at(-1)).toBe("mcp");
  // The install rows: every client, in order (what this machine has is its own; nothing is written by a list).
  expect(list.clients?.map((c) => c.id)).toEqual(["claude-code", "codex", "grok", "cursor", "vscode", "grok-bot"]);
  expect(listed.length).toBeGreaterThan(0);

  // One agent_id keeps its first name.
  const renamed = connect(runtime.url, runtime.token);
  expect((await refusal(renamed.call("outside_agent.become", { agent_id: agentId, name: "Codex" }))).message).toContain("keeps the name it first connected with");
  renamed.close();

  // Raised to Full: the next call reads the new level, with no reconnect.
  await owner.call("outside_agent.update", { request_id: "u1", name: "Grok", level: "full" });
  await agent.call("turn.submit", { request_id: "t3", session_id: persons.session_id, kind: "followup", input: { text: "From Grok at full" } });

  // Disconnected: its socket closes, and becoming it again is refused.
  const states: Array<string> = [];
  const watched = connect(runtime.url, runtime.token, (state) => states.push(state));
  await watched.call("outside_agent.become", { agent_id: randomUUID(), name: "Grok" });
  await owner.call("outside_agent.update", { request_id: "u2", name: "Grok", blocked: true });
  // Its socket closed: the client goes back to connecting (and its handshake-less become would run as the owner, which
  // the bridge never does: its handshake runs become on every socket, refused from now on).
  const opens = states.filter((s) => s === "open").length;
  await until(() => states.lastIndexOf("connecting") > states.lastIndexOf("open") || states.filter((s) => s === "open").length > opens);
  const blocked = connect(runtime.url, runtime.token);
  expect((await refusal(blocked.call("outside_agent.become", { agent_id: randomUUID(), name: "Grok" }))).message).toContain("Disconnected in Caveman Code > Settings > Caveman MCP");
  expect((await owner.call("outside_agent.list", {})).agents[0]).toMatchObject({ name: "Grok", blocked: true });
  for (const client of [agent, watched, blocked]) client.close();
}, 180_000);
