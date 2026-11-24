// workspace.servers and workspace.servers.stop against a real runtime (upstream #22542): a chat sees which listening
// servers its own terminals or agent started, and can stop only those. The port scanner is a stand-in, so nothing on
// this computer is scanned or signalled.
import * as fs from "node:fs";

import { PreviewStopLocalServerError, ThreadId, type DiscoveredLocalServer } from "@caveman-app/protocol";
import { connect } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterAll, beforeAll, expect, test } from "vitest";

import * as PortScanner from "../preview/PortScanner.ts";
import * as Store from "./store.ts";
import { createReady, makeConfig, makeRepo, MODEL, startRuntime, tempRoot } from "./testHarness.ts";

const root = tempRoot("sp-workspace-servers-");
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let client: ReturnType<typeof connect>;
let sessions!: Store.SessionStore["Service"];
class Grab extends Context.Service<Grab, { readonly ok: true }>()("test/workspaceServers/Grab") {}
const grab = Layer.effect(
  Grab,
  Effect.gen(function* () {
    sessions = yield* Store.SessionStore;
    return Grab.of({ ok: true });
  }),
).pipe(Layer.provide(Store.layer)) as Layer.Layer<Grab>;

let listening: ReadonlyArray<DiscoveredLocalServer> = [];
const stops: Array<{ pid: number; port: number }> = [];
let refuse: PreviewStopLocalServerError["reason"] | null = null;
const scanner = Layer.mock(PortScanner.PortDiscovery)({
  scan: () => Effect.succeed(listening),
  trackAgent: () => () => undefined,
  stopServer: (input) =>
    refuse === null ? Effect.sync(() => void stops.push({ pid: input.pid, port: input.port })) : Effect.fail(new PreviewStopLocalServerError({ reason: refuse })),
});

beforeAll(async () => {
  runtime = await startRuntime(await makeConfig(), "fake-claude", undefined, { provide: Layer.mergeAll(grab, scanner) });
  client = connect(runtime.url, runtime.token);
});
afterAll(async () => {
  client.close();
  await runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const server = (port: number, pid: number, owner: Pick<DiscoveredLocalServer, "terminal" | "agent">): DiscoveredLocalServer => ({
  host: "localhost",
  port,
  url: `http://localhost:${port}`,
  processName: "node",
  pid,
  ...owner,
});

test("a chat's servers say who started them, and only those can be stopped from it", async () => {
  const repo = makeRepo(root, { "README.md": "servers\n" });
  const workspace = await createReady(client, { request_id: "w-servers", repo: { path: repo }, title: "servers", engine: "claude-agent", options: { model: MODEL } });
  const thread = ThreadId.make((await Effect.runPromise(sessions.getBySession(workspace.session_id)))!.internal.threadId);
  const elsewhere = ThreadId.make("thread-of-another-chat");
  listening = [
    server(3000, 300, { terminal: { threadId: thread, terminalId: "term-mine" }, agent: null }),
    server(5173, 517, { terminal: null, agent: { threadId: thread } }),
    server(8080, 808, { terminal: null, agent: { threadId: elsewhere } }),
  ];

  const read = await client.call("workspace.servers", { workspace_id: workspace.id });
  expect(read.can_stop).toBe(process.platform !== "win32");
  expect(read.servers).toEqual([
    { port: 3000, url: "http://localhost:3000", process_name: "node", pid: 300, started_by: "terminal", terminal_id: "term-mine" },
    { port: 5173, url: "http://localhost:5173", process_name: "node", pid: 517, started_by: "agent" },
    // Another chat's server is still on this computer, for the new tab, but says nothing about who started it.
    { port: 8080, url: "http://localhost:8080", process_name: "node" },
  ]);
  if (process.platform === "win32") return;

  // The pid comes from a client: another chat's server, or a port its pid does not hold, is refused untouched.
  await expect(client.call("workspace.servers.stop", { request_id: "s1", workspace_id: workspace.id, pid: 808, port: 8080 })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  await expect(client.call("workspace.servers.stop", { request_id: "s2", workspace_id: workspace.id, pid: 517, port: 3000 })).rejects.toMatchObject({ error: { data: { reason: "not_found" } } });
  expect(stops).toEqual([]);

  await client.call("workspace.servers.stop", { request_id: "s3", workspace_id: workspace.id, pid: 517, port: 5173 });
  expect(stops).toEqual([{ pid: 517, port: 5173 }]);

  // One sharing a process group with a shell or an agent CLI is the scanner's to refuse; the chat hears why.
  refuse = "shared-group";
  await expect(client.call("workspace.servers.stop", { request_id: "s4", workspace_id: workspace.id, pid: 300, port: 3000 })).rejects.toMatchObject({
    error: { data: { reason: "invalid_state" } },
  });
  refuse = null;
});
