// A runtime that did not run for a while and runs again: a Cloud computer's guest restored from a memory snapshot (its
// wall clock stepped on by the guest agent, its timers not, its relay connection dead though open), or a process stopped
// and continued. The real runtime process (the chaos harness's, on the stand-in claude), enrolled as This Mac with sync
// on, frozen with SIGSTOP while its wall clock moves 20 min on (CHAOS_CLOCK_FILE: the process's clock only, not the
// machine's; the test Cloud's moves with it). It reconnects its relay on a fresh token, never the expired one,
// heartbeats and answers a call through the relay within 3 s, and repeats nothing: Cloud's copy is the journal, one turn.
//
// What only a runtime inside a real guest proves (its timers frozen by the restore, not late) waits for guests with a
// network (compute track H); the Firecracker lab proves the guest's half (Caveman Cloud Sandboxes TestLab).
//
// With CAVEMAN_E2E_CLOUD_URL (and CAVEMAN_E2E_EMAIL / CAVEMAN_E2E_PASSWORD, as realCloud.e2e.test.ts), the same against a
// real local Cloud (control-api and its relay): frozen 16 min with no clock offset, past the runtime token's 15 min and
// the relay's pong timeout. CAVEMAN_E2E_CLOUD_URL is one origin with /relay routed to the relay, as the chart's ingress
// serves it; or control-api alone, with CAVEMAN_E2E_RELAY_URL the relay, which a front here joins into one origin.
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as path from "node:path";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { afterEach, expect, test } from "vitest";
import WebSocket from "ws";

import { allowedOn, allowedStream, testDevice } from "../session-protocol/devices.testkit.ts";
import { createReady, makeRepo, MODEL, tempRoot, until } from "../session-protocol/testHarness.ts";
import { RuntimeProc, sleep, tcpPipe, Trace } from "./chaos/world.ts";
import { startTestCloud, type RelaySide } from "./testCloud.ts";

// SIGSTOP and SIGCONT stand for the freeze; Windows has neither.
const POSIX = process.platform !== "win32";
const CLOUD = process.env.CAVEMAN_E2E_CLOUD_URL;
const EMAIL = process.env.CAVEMAN_E2E_EMAIL;
const PASSWORD = process.env.CAVEMAN_E2E_PASSWORD;
const RELAY = process.env.CAVEMAN_E2E_RELAY_URL;

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** This Mac's runtime as a real process on its own state dir (the chaos harness's), its clock offset in `clockFile`. */
async function macProcess(env: Record<string, string>) {
  const base = tempRoot("restore-");
  const clockFile = path.join(base, "clock");
  fs.writeFileSync(clockFile, "0");
  const [desktop, admin] = [await tcpPipe(), await tcpPipe()];
  const mac = new RuntimeProc("mac", "mac", path.join(base, "state"), { ...env, CHAOS_CLOCK_FILE: clockFile }, desktop, admin, new Trace());
  cleanups.push(() => desktop.close(), () => admin.close(), () => mac.close());
  await mac.start();
  return { mac, clockFile };
}

/** One origin: /relay/* to the relay (WebSocket upgrades too), the rest to control-api, as the chart's ingress routes it. */
async function front(control: URL, relay: URL) {
  const targetOf = (url: string | undefined) => (url?.startsWith("/relay/") ? relay : control);
  const server = http.createServer((req, res) => {
    const target = targetOf(req.url);
    const forward = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: { ...req.headers, host: target.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    forward.on("error", () => req.socket.destroy());
    req.pipe(forward);
  });
  server.on("upgrade", (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    const target = targetOf(req.url);
    const upstream = net.connect(Number(target.port), target.hostname, () => {
      const headers: Array<string> = [];
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i]!.toLowerCase() === "host" ? target.host : req.rawHeaders[i + 1]}`);
      upstream.write(`${req.method} ${req.url} HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length > 0) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  const sockets = new Set<net.Socket>();
  server.on("connection", (socket) => (sockets.add(socket), socket.on("close", () => sockets.delete(socket))));
  cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), [...sockets].forEach((socket) => socket.destroy()))));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
}

/** One turn on a new chat; resolves once it is done in the journal. */
async function oneTurn(mac: RuntimeProc, text: string) {
  const client = connect(mac.adminPipe.url, mac.info!.token);
  cleanups.push(() => client.close());
  const repo = makeRepo(tempRoot("restore-repo-"), { "README.md": "restore\n" });
  const w = await createReady(client, { request_id: "w1", repo: { path: repo }, title: "Frozen", engine: "claude-agent", options: { model: MODEL } });
  const events: Array<SessionEvent> = [];
  await client.attach(w.session_id, 0, (e) => events.push(e));
  await client.call("turn.submit", { request_id: "t1", session_id: w.session_id, kind: "followup", input: { text } });
  await until(() => events.some((e) => e.type === "turn.done"), 60_000);
  return w;
}

/** The chat's journal on the runtime, read anew from the start. */
async function journal(mac: RuntimeProc, sessionId: string) {
  const client = connect(mac.adminPipe.url, mac.info!.token);
  const events: Array<SessionEvent> = [];
  await client.attach(sessionId, 0, (e) => events.push(e));
  await sleep(500);
  client.close();
  return events;
}

test.skipIf(!POSIX)("a runtime frozen while its wall clock moves 20 min on reconnects on a fresh token within 3 s and repeats no turn", { timeout: 240_000 }, async () => {
  const cloud = await startTestCloud({ pingMs: 1_000 });
  cleanups.push(cloud.close);
  const { mac, clockFile } = await macProcess({ CHAOS_CLOUD_URL: cloud.url, CHAOS_BEARER: cloud.state.personToken });
  await mac.call("settings.set", { request_id: "s1", settings: { sync_chats: true, remote_control: true } });
  await until(async () => (await mac.call("cloud.status", {})).state === "connected", 30_000);
  const sideOf = () => [...cloud.state.relays].reverse().find((s) => s.ws.readyState === s.ws.OPEN && cloud.state.tokens.get(s.token)?.runtimeId === mac.runtimeId);
  await until(() => sideOf() !== undefined, 30_000);

  const w = await oneTurn(mac, "before the freeze");
  const chats = cloud.state.chats;
  await until(() => chats.copyOf(w.session_id).some((e) => e.type === "turn.done"), 30_000);
  // A device This Mac allowed, calling it through the relay.
  const device = await testDevice();
  const before = await allowedStream(sideOf()!, mac, device);
  expect((await before.call("engine.list", {})).result).toBeDefined();

  const old = sideOf()!;
  const mints = cloud.state.mints.length;
  const heartbeats = cloud.state.heartbeats.length;
  // Frozen: the relay's peer is gone though the socket looks open, and the world's clock moves 20 min on (Cloud's too).
  old.blackhole = true;
  mac.stop();
  await sleep(5_000);
  fs.writeFileSync(clockFile, String(20 * 60_000));
  cloud.state.skewMs = 20 * 60_000;
  const at = Date.now();
  mac.wake();
  let side: RelaySide | undefined;
  await until(() => {
    side = sideOf();
    return side !== undefined && side !== old && cloud.state.heartbeats.slice(heartbeats).some((h) => h.token === side!.token);
  }, 10_000);
  const took = Date.now() - at;
  console.log(`restore stand-in: relay on a fresh token and a heartbeat ${took} ms after SIGCONT`);
  expect(took).toBeLessThanOrEqual(3_000);
  // One mint, the relay dialed on it: never on the token that expired while the process did not run.
  expect(cloud.state.mints.length).toBe(mints + 1);
  expect(cloud.state.mints.at(-1)).toMatchObject({ ok: true });
  expect(cloud.state.refusedUpgrades).toBe(0);
  expect(cloud.state.tokens.get(side!.token)!.expiresAt).toBeGreaterThan(Date.now() + cloud.state.skewMs + 10 * 60_000);
  // A call through the relay, answered once.
  const after = await allowedStream(side!, mac, device);
  const reply = await after.call("engine.list", {});
  expect(reply.result).toBeDefined();
  expect((await after.opened()).filter((r) => r.id === reply.id && r.method === undefined)).toHaveLength(1);

  // Nothing repeated: Cloud's copy is the journal, one turn, each event once.
  await sleep(3_000);
  const events = await journal(mac, w.session_id);
  const copy = chats.copyOf(w.session_id);
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  expect(events.filter((e) => e.type === "message.done" && e.payload.role === "assistant")).toHaveLength(1);
  expect(copy.filter((e) => e.type === "turn.started")).toHaveLength(1);
  expect(new Set(copy.map((e) => e.cursor)).size).toBe(copy.length);
  expect(copy.map((e) => e.cursor)).toEqual(events.filter((e) => copy.some((c) => c.cursor === e.cursor)).map((e) => e.cursor));
  expect(fs.readFileSync(mac.logFile, "utf8")).toMatch(/did not run for a while \(wall clock \+1\d\d\d s/);
});

test.skipIf(!POSIX || !CLOUD || !EMAIL || !PASSWORD)("real Cloud: a runtime frozen 16 min (past its token and the relay's pong timeout) reconnects and repeats no turn", { timeout: 25 * 60_000 }, async () => {
  const origin = RELAY ? await front(new URL(CLOUD!), new URL(RELAY)) : CLOUD!;
  // The person's access token lives 15 min: their device signs in again after the freeze, as an app would refresh.
  const signIn = async () => {
    const login = await fetch(`${origin}/api/v1/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, password: PASSWORD }) });
    expect(login.status).toBe(200);
    return (await login.json()) as { access_token: string };
  };
  let person = await signIn();
  const api = async (method: string, route: string, body?: unknown) => {
    const response = await fetch(`${origin}${route}`, { method, headers: { authorization: `Bearer ${person.access_token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as any) : undefined };
  };
  // This Mac enrolls with the person's sign-in, as macToMac.e2e.test.ts's Macs do.
  const { mac } = await macProcess({ CHAOS_CLOUD_URL: origin, CHAOS_BEARER: person.access_token });
  const runtimeId = mac.runtimeId;
  expect(runtimeId).not.toBe("");
  await mac.call("settings.set", { request_id: "s2", settings: { sync_chats: true, remote_control: true } });
  await until(async () => (await mac.call("cloud.status", {})).state === "connected", 30_000);
  const w = await oneTurn(mac, "before the long freeze");
  const device = await testDevice();
  const attach = async () => {
    const url = new URL(`/relay/v1/runtimes/${runtimeId}`, origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(person.access_token).toString("base64url")}`]);
    const replies: Array<any> = [];
    let closed = false;
    ws.on("message", (data) => replies.push(JSON.parse(String(data))));
    ws.on("close", () => (closed = true));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("unexpected-response", (_req, res) => reject(new Error(`relay answered ${res.statusCode}`)));
      ws.once("error", reject);
    });
    cleanups.push(() => ws.close());
    // The relay closes a client 4404 while the runtime holds no live link; a runtime that does challenges it.
    await until(() => closed || replies.some((r) => r.method === "device.challenge"), 5_000);
    if (closed) throw new Error("the relay closed the client: the runtime is not connected");
    return { ws, ...(await allowedOn({ send: (text) => ws.send(text), replies: () => replies }, mac, device)) };
  };
  expect((await (await attach()).call("engine.list", {})).result).toBeDefined();
  const seen = async () => (await api("GET", "/api/v1/code/runtimes")).body.runtimes.find((r: { id: string }) => r.id === runtimeId)?.last_seen_at as string | null;

  mac.stop();
  await sleep(16 * 60_000);
  person = await signIn();
  const at = Date.now();
  mac.wake();
  // Reconnected: the relay routes a client to it (it holds a live link on a token Cloud takes), and its heartbeat lands.
  let client: Awaited<ReturnType<typeof attach>> | undefined;
  await until(async () => {
    client = await attach().catch(() => undefined);
    return client !== undefined;
  }, 30_000);
  const took = Date.now() - at;
  const reply = await client!.call("engine.list", {});
  console.log(`restore on the real relay: a relayed client attached ${took} ms after SIGCONT`);
  expect(reply.result).toBeDefined();
  expect((await client!.opened()).filter((r) => r.id === reply.id && r.method === undefined)).toHaveLength(1);
  await until(async () => Date.parse((await seen()) ?? "") >= at - 5_000, 30_000);
  expect(took).toBeLessThanOrEqual(3_000);
  const events = await journal(mac, w.session_id);
  expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  expect(fs.readFileSync(mac.logFile, "utf8")).toMatch(/did not run for a while/);
});
