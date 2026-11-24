// Boots the runtime's Session Protocol route in-process on upstream orchestrator
// with the Claude replay provider, and drives it with
// @caveman-app/session-protocol's client over a real WebSocket.
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import { connect, type SessionEvent, type Workspace } from "@caveman-app/session-protocol";
import { makeProviderReplayGate } from "@caveman-app/engine-testing/replayGate";
import { afterAll, expect, test } from "vitest";

import * as SessionProtocol from "./index.ts";
import { git as sh, loadTranscript, makeConfig, makeRepo, MODEL, PROMPT, startRuntime as start, tempRoot, until } from "./testHarness.ts";

const transcript = await loadTranscript();
const root = tempRoot("sp-it-");
const repo = makeRepo(root, { "README.md": "hello\n" });
const config = await makeConfig();
const startRuntime = (gate?: ReturnType<typeof makeProviderReplayGate>) => start(config, transcript, gate);

/** A TCP hop between client and runtime that the test can cut, as a network drop would. */
function proxy(targetPort: () => number) {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((inbound) => {
    const outbound = net.connect(targetPort(), "127.0.0.1");
    for (const s of [inbound, outbound]) {
      sockets.add(s);
      s.on("close", () => sockets.delete(s));
      s.on("error", () => {});
    }
    inbound.pipe(outbound).pipe(inbound);
  });
  return {
    listen: () => new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port))),
    drop: () => {
      for (const s of sockets) s.destroy();
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const token = () => fs.readFileSync(path.join(config.stateDir, SessionProtocol.TOKEN_FILE), "utf8");
const cursors = (events: ReadonlyArray<SessionEvent>) => events.map((e) => e.cursor);
const contiguous = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

test("workspace -> turn -> events; drop mid-turn, replay a request_id, restart, reattach", async () => {
  const gate = makeProviderReplayGate(["result"]);
  let runtime = await startRuntime(gate);
  const hop = proxy(() => runtime.port);
  const hopPort = await hop.listen();
  const states: Array<string> = [];
  const client = connect(`ws://127.0.0.1:${hopPort}/session/v1`, token, (state) => states.push(state));

  // A bad token never gets past the upgrade.
  const rejected = await new Promise<http.IncomingMessage>((resolve, reject) => {
    const request = http.get({
      host: "127.0.0.1",
      port: runtime.port,
      path: "/session/v1",
      headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", authorization: "Bearer nope" },
    });
    request.on("response", (response) => resolve(response));
    request.on("upgrade", () => reject(new Error("upgraded with a bad token")));
    request.on("error", reject);
  });
  expect(rejected.statusCode).toBe(401);
  // Nothing from the runtime's origin may load in a frame: the rejection, a 404 and a page alike.
  const page = await fetch(`http://127.0.0.1:${runtime.port}/no-such-page`);
  for (const headers of [new Headers(rejected.headers as Record<string, string>), page.headers]) {
    expect(headers.get("content-security-policy")).toBe("frame-ancestors 'none'");
    expect(headers.get("x-frame-options")).toBe("DENY");
  }
  // Skipped on Windows: no POSIX mode bits (the profile's ACL keeps the file).
  if (process.platform !== "win32") expect(fs.statSync(path.join(config.stateDir, SessionProtocol.TOKEN_FILE)).mode & 0o777).toBe(0o600);

  const engines = await client.call("engine.list", {});
  expect(engines.engines.map((e) => [e.id, e.label])).toEqual([["claude-agent", "Claude Agent"]]);
  // Claude asks before acting, so every access mode is open; efforts come per model.
  expect(engines.engines[0]!.access_modes).toBeUndefined();
  for (const model of engines.engines[0]!.models) expect(Array.isArray(model.efforts)).toBe(true);
  const bogus = await client.call("workspace.create", { request_id: "bogus-effort", repo: { path: repo }, engine: "claude-agent", options: { model: MODEL, effort: "bogus" } }).then(
    () => "created",
    (error: { error?: { data?: { reason?: string } } }) => error.error?.data?.reason,
  );
  expect(bogus).toBe("invalid_params");

  const changed: Array<Workspace> = [];
  client.on("workspace.changed", (w) => changed.push(w));
  const workspace = await client.call("workspace.create", {
    request_id: "create-1",
    repo: { path: repo },
    title: "Fixture",
    engine: "claude-agent",
    options: { model: MODEL },
  });
  expect(workspace.branch).toMatch(/^caveman\/fixture-/);
  expect(workspace.base_ref).toBe("main");
  expect(workspace.status).toBe("starting");
  // It answered before its worktree: the chat's first events are a row for it, which ends once it is made.
  const seen: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => seen.push(event));
  await until(() => seen.some((e) => e.type === "tool.done"));
  expect(seen.map((e) => [e.type, e.item_id])).toEqual([
    ["tool.started", `worktree:${workspace.id}`],
    ["tool.done", `worktree:${workspace.id}`],
  ]);
  expect(seen[0]?.payload).toEqual({
    name: "worktree",
    kind: "command",
    title: `git worktree add ${workspace.root_path}`,
    input: { path: workspace.root_path, branch: workspace.branch, base_ref: "main" },
  });
  expect(seen[1]?.payload).toEqual({ status: "completed" });
  const worktree = sh(repo, "worktree", "list", "--porcelain");
  expect(worktree).toContain(`branch refs/heads/${workspace.branch}`);

  // An untracked file the turn's checkpoint captures: a diff since that checkpoint must not call it deleted and added.
  fs.writeFileSync(path.join(workspace.root_path!, "notes.txt"), "mine\n");
  const submitted = await client.call("turn.submit", {
    request_id: "turn-1",
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: PROMPT },
  });
  expect(submitted.disposition).toBe("started");

  // Mid-turn: the assistant has answered, the engine's result is held back.
  await until(() => seen.some((e) => e.type === "message.done" && e.payload.role === "assistant"));
  expect(seen.some((e) => e.type === "turn.done")).toBe(false);
  hop.drop();
  gate.release("result");
  await until(() => seen.some((e) => e.type === "turn.done"));
  await until(() => seen.some((e) => e.type === "diff.changed"));
  expect(states.filter((s) => s === "open").length).toBeGreaterThanOrEqual(2);

  // Every cursor exactly once, in order, across the drop.
  expect(cursors(seen)).toEqual(contiguous(seen.length));
  const turn = seen.slice(2);
  const types = turn.map((e) => e.type);
  expect(types.slice(0, 2)).toEqual(["turn.started", "message.done"]);
  expect(turn[1]?.type === "message.done" && turn[1].payload).toEqual({ role: "user", text: PROMPT });
  expect(types).toContain("usage");
  expect(types).toContain("checkpoint.created");
  expect(types.indexOf("turn.done")).toBeGreaterThan(types.indexOf("message.done"));
  const assistant = seen.find((e) => e.type === "message.done" && e.payload.role === "assistant");
  expect(assistant?.type === "message.done" && assistant.payload.text).toBe("fixture simple ok");
  expect(turn.every((e) => e.session_id === workspace.session_id && e.turn_id === submitted.turn_id)).toBe(true);
  await until(() => changed.some((w) => w.id === workspace.id && w.status === "idle"));

  // Same request_id, same params: the first result, no second turn.
  const again = await client.call("turn.submit", { request_id: "turn-1", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
  expect(again).toEqual(submitted);
  await expect(
    client.call("turn.submit", { request_id: "turn-1", session_id: workspace.session_id, kind: "followup", input: { text: "other" } }),
  ).rejects.toMatchObject({ error: { data: { reason: "request_id_conflict" } } });
  const createdAgain = await client.call("workspace.create", { request_id: "create-1", repo: { path: repo }, title: "Fixture", engine: "claude-agent", options: { model: MODEL } });
  expect(createdAgain.id).toBe(workspace.id);
  expect((await client.call("workspace.list", {})).workspaces).toHaveLength(1);

  const usage = await client.call("spend.summary", { group_by: "model" });
  // Claude Agent runs on the person's plan: tokens, no price.
  expect(usage.rows).toEqual([expect.objectContaining({ key: MODEL, measured_usd: null, basis: "plan" })]);
  expect(usage.saved_usd).toBeNull();
  const files = await client.call("fs.read", { workspace_id: workspace.id, path: "README.md" });
  expect(files.content).toBe("hello\n");
  // A window into the file: from a byte, at most so many, ending on a whole character; size stays the file's.
  expect(await client.call("fs.read", { workspace_id: workspace.id, path: "README.md", offset: 2, max_bytes: 2 })).toMatchObject({ content: "ll", size: 6, truncated: true, encoding: "utf8" });
  expect(await client.call("fs.read", { workspace_id: workspace.id, path: "README.md", offset: 4 })).toMatchObject({ content: "o\n", size: 6, truncated: false });
  await expect(client.call("fs.read", { workspace_id: workspace.id, path: "../repo/README.md" })).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
  // The checkpoint id checkpoint.created carries is what fs.diff and fs.read take as a ref.
  const checkpoint = seen.find((e) => e.type === "checkpoint.created");
  const checkpointId = checkpoint?.type === "checkpoint.created" ? checkpoint.payload.checkpoint_id : "";
  expect(checkpointId).toMatch(/^checkpoint:/);
  fs.writeFileSync(path.join(workspace.root_path!, "after.txt"), "later\n");
  fs.writeFileSync(path.join(workspace.root_path!, "notes.txt"), "mine\nand more\n");
  const sinceCheckpoint = await client.call("fs.diff", { workspace_id: workspace.id, from: checkpointId });
  expect(sinceCheckpoint.files.map((f) => [f.path, f.status, f.additions, f.deletions])).toEqual([
    ["after.txt", "added", 1, 0],
    ["notes.txt", "modified", 1, 0],
  ]);
  expect(sinceCheckpoint.to).toBe("working_tree");
  // The checkout's own index is untouched: both files are still untracked.
  expect(sh(workspace.root_path!, "status", "--porcelain")).toBe("?? after.txt\n?? notes.txt\n");
  expect((await client.call("fs.read", { workspace_id: workspace.id, path: "README.md", ref: checkpointId })).content).toBe("hello\n");
  await expect(client.call("fs.read", { workspace_id: workspace.id, path: "after.txt", ref: checkpointId })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  await expect(client.call("fs.diff", { workspace_id: workspace.id, from: "checkpoint:no-such" })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  fs.rmSync(path.join(workspace.root_path!, "after.txt"));
  fs.writeFileSync(path.join(workspace.root_path!, "notes.txt"), "mine\n");
  // An agent's proof screenshot or markdown, wherever it saved it; anything else is refused.
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const shot = path.join(root, "proof shots", "after.png");
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  fs.writeFileSync(shot, png);
  expect(await client.call("media.read", { workspace_id: workspace.id, path: shot })).toEqual({ path: fs.realpathSync(shot), mime_type: "image/png", data: png.toString("base64"), size: png.length });
  expect(await client.call("media.read", { workspace_id: workspace.id, path: "README.md" })).toMatchObject({ mime_type: "text/markdown", data: Buffer.from("hello\n").toString("base64") });
  await expect(client.call("media.read", { workspace_id: workspace.id, path: "notes.txt" })).rejects.toMatchObject({ error: { data: { reason: "invalid_params" } } });
  await expect(client.call("media.read", { workspace_id: workspace.id, path: path.join(root, "missing.png") })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });

  const head = seen.length;
  client.close();
  await hop.close();
  await runtime.close();

  // Restart on the same state dir: the journal is the same, and nothing is projected twice.
  runtime = await startRuntime();
  const reopened = connect(`ws://127.0.0.1:${runtime.port}/session/v1`, token);
  const replayed: Array<SessionEvent> = [];
  const attached = await reopened.attach(workspace.session_id, 0, (event) => replayed.push(event));
  void attached;
  await until(() => replayed.length >= head);
  await new Promise((r) => setTimeout(r, 300));
  expect(replayed).toEqual(seen);
  // A client from before `batch` gets the same backlog as one session.event per event.
  const old = new WebSocket(`ws://127.0.0.1:${runtime.port}/session/v1`, { headers: { authorization: `Bearer ${token()}` } } as never);
  const oldFrames: Array<{ method?: string; params?: SessionEvent }> = [];
  old.onmessage = (message) => oldFrames.push(JSON.parse(String(message.data)));
  await new Promise((resolve) => (old.onopen = resolve));
  old.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "session.attach", params: { session_id: workspace.session_id, cursor: 0 } }));
  await until(() => oldFrames.filter((f) => f.method === "session.event").length >= head);
  expect(oldFrames.some((f) => f.method === "session.events")).toBe(false);
  expect(oldFrames.flatMap((f) => (f.method === "session.event" ? [f.params] : []))).toEqual(seen);
  old.close();
  const tail: Array<SessionEvent> = [];
  await reopened.attach(workspace.session_id, head - 2, (event) => tail.push(event));
  await until(() => tail.length >= 2);
  expect(cursors(tail)).toEqual([head - 1, head]);
  const after = await reopened.call("workspace.get", { workspace_id: workspace.id });
  expect(after.status).toBe("idle");
  const retried = await reopened.call("turn.submit", { request_id: "turn-1", session_id: workspace.session_id, kind: "followup", input: { text: PROMPT } });
  expect(retried).toEqual(submitted);
  reopened.close();
  await runtime.close();
});
