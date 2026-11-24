// What the real-stack tests of a person's several Macs share (devicesAcrossMacs.e2e.test.ts): the Cloud, its SQL and the
// person's sign-in (moves.e2e.kit.ts, with its lab hygiene), one front origin for control-api and the relay, a Mac (a real runtime process, moves.e2e.runtime.ts, with its own
// state dir, link key and device key; or the whole runtime as the desktop app starts it, startDesktopMac), and a
// device's connection to a Mac through the real relay. Each Mac's desktop
// key is a software P-256 key standing in for the keychain-sealed one (same signatures); a phone's is a WebCrypto key.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createPublicKey, generateKeyPairSync, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type DeviceKey, type DeviceList } from "@caveman-app/session-protocol";
import WebSocket from "ws";

import { allowedOn, helloOn, removeStatement, sealedOn, testDevice, type HelloOptions, type Wire } from "../session-protocol/devices.testkit.ts";
import { FAKE_CLAUDE, git, tempRoot, until } from "../session-protocol/testHarness.ts";
import { enroll } from "./identity.ts";
import { linkDirOf } from "./index.ts";
import { CloudLink } from "./link.ts";
import { CLOUD, labFunding, person as signIn, retireLabComputers, sql } from "./moves.e2e.kit.ts";

export { CLOUD, PSQL, sql } from "./moves.e2e.kit.ts";
export const RELAY = process.env.CAVEMAN_E2E_RELAY_URL;
const RUNTIME = fileURLToPath(new URL("./moves.e2e.runtime.ts", import.meta.url));
/** The runtime the desktop app starts (packages/runtime/src/bin.ts), as it starts it: `--bootstrap-fd 3`. */
const BIN = fileURLToPath(new URL("../bin.ts", import.meta.url));

const children: Array<ChildProcess> = [];
const links: Array<CloudLink> = [];
const servers: Array<http.Server> = [];
const sockets: Array<WebSocket> = [];
/** The Cloud computers startBox made: deleted again at the end, so they never count against the person's next run. */
const boxes: Array<string> = [];
/** Ends every process, server and socket this kit started, and deletes the Cloud computers it made (afterAll). */
export function stopAll() {
  for (const socket of sockets) socket.terminate();
  for (const link of links) link.stop();
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  for (const server of servers) server.close();
  if (boxes.length > 0) sql(`UPDATE code_computers SET desired_state = 'deleted' WHERE id IN (${boxes.map((id) => `'${id}'`).join(", ")})`);
}

/**
 * The person signed in (moves.e2e.kit), with the move tests' lab hygiene first: earlier runs' Cloud computers retired,
 * so the person's awake quota is this test's own, and a fresh lab stack's organization funded (labFunding, when asked).
 * Both only on a Cloud and a database on this machine.
 */
export async function person() {
  const me = await signIn();
  retireLabComputers(me);
  labFunding(me);
  return me;
}

export const api = async (token: string, method: string, route: string, body?: unknown) => {
  const response = await fetch(`${CLOUD}${route}`, {
    method,
    headers: { authorization: `Bearer ${token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as any) : undefined };
};

/** One origin for every Mac, as the chart's ingress serves it: /relay/* to the relay (WebSocket upgrades too), the rest to control-api. */
export async function front() {
  const relay = new URL(RELAY!);
  const control = new URL(CLOUD!);
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
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A Mac: a runtime process enrolled with the person's sign-in under `name`, Remote control and sync on, and its desktop key. */
export async function startMac(name: string, origin: string, bearer: string, env: Record<string, string> = {}) {
  const outFile = path.join(tempRoot("macs-e2e-"), "out.json");
  const log = fs.openSync(`${outFile}.log`, "w");
  const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
    env: { ...process.env, ...env, MOVES_ROLE: "mac", MOVES_NAME: name, MOVES_OUT: outFile, MOVES_CLOUD_URL: origin, MOVES_BEARER: bearer },
    stdio: ["ignore", log, log],
  });
  children.push(child);
  await until(() => fs.existsSync(outFile) || child.exitCode !== null, 120_000);
  if (!fs.existsSync(outFile)) throw new Error(`${name} exited: ${fs.readFileSync(`${outFile}.log`, "utf8").slice(-2000)}`);
  const info = JSON.parse(fs.readFileSync(outFile, "utf8")) as { url: string; token: string; stateDir: string };
  const client = connect(info.url, info.token);
  const requests: Array<string> = [];
  client.on("device.request", (r) => requests.push(r.device_id));
  await client.call("engine.account.add", { request_id: `key-${name}`, engine: "caveman", provider: "anthropic", key: `sk-${""}ant-macs-e2e-${name.replace(/\W/g, "")}-0123456789abcdef` });
  await client.call("settings.set", { request_id: `on-${name}`, settings: { sync_chats: true, remote_control: true } });
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 60_000);
  const status = await client.call("cloud.status", {});
  // The Mac's own desktop key: a software stand-in for the keychain-sealed one, of kind "mac".
  const key = await testDevice(name, "mac");
  return { name, child, client, key, requests, origin, bearer, log: `${outFile}.log`, runtimeId: status.runtime_id!, computerId: status.computer_id!, ...info };
}
export type Mac = Awaited<ReturnType<typeof startMac>>;

/**
 * A model endpoint of the person's own (an OpenAI-compatible URL, the Caveman engine's custom endpoint), scripted as
 * agents-smoke.ts scripts one, for a Mac running the whole runtime (startDesktopMac): no model is called, nothing leaves
 * the machine. A person's message "MAIL <threadId> <text>" makes the agent call thread_send(threadId, text,
 * expectReply) through the engine's code tool (codeTool), found by name among its tools as a real model's cell finds it; a tool's
 * result is acknowledged; anything else is answered "heard: <its first line> (on <name>)".
 */
/**
 * The Caveman engine's code tool among the tools a model is offered: the harness's `program` (Claude Code's surface,
 * which every model without one of its own runs on) or `exec` (Codex's). The runtime's own tools that are not declared
 * beside the surface (thread_send among them) are reached from it.
 */
export const codeTool = (tools: ReadonlyArray<string>) => tools.find((t) => t === "program") ?? tools.find((t) => t === "exec");

export async function scriptedModel(name: string) {
  const calls: Array<{ model: string; last: string; tools: Array<string> }> = [];
  let n = 0;
  const textOf = (content: unknown): string =>
    typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? "").join("") : "";
  const reply = (body: { model: string; messages?: Array<{ role: string; content?: unknown }>; tools?: Array<{ function?: { name: string } }> }) => {
    const messages = body.messages ?? [];
    const tools = (body.tools ?? []).map((t) => t.function?.name ?? "");
    const last = messages.at(-1);
    calls.push({ model: body.model, last: textOf(last?.content).slice(0, 400), tools });
    if (messages.some((m) => m.role === "user" && textOf(m.content).includes("Reply with the word OK"))) return { text: "OK" };
    if (last?.role === "tool") return { text: `sent (on ${name}): ${textOf(last.content).slice(0, 300)}` };
    const said = textOf(last?.content);
    const mail = /\bMAIL (\S+) ([^\n]*)/.exec(said);
    if (mail) {
      const code = codeTool(tools);
      if (code === undefined) return { text: `cannot mail (on ${name}): no code tool` };
      const args = JSON.stringify({ threadId: mail[1], message: mail[2], expectReply: true });
      const cell = [
        "const names = (Array.isArray(ALL_TOOLS) ? ALL_TOOLS : Object.keys(ALL_TOOLS)).map((t) => (typeof t === 'string' ? t : t.name));",
        "const name = names.find((n) => /thread_send$/.test(n));",
        "if (!name) return 'no send tool among ' + names.join(',');",
        `return await tools[name](${args});`,
      ].join("\n");
      return { calls: [{ name: code, args: { code: cell } }] };
    }
    const words = /\b(?:ask|hang|slow)\b[^\n]*/i.exec(said)?.[0] ?? said.split("\n")[0] ?? "";
    return { text: `heard: ${words.trim()} (on ${name})` };
  };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST" || !(req.url ?? "").endsWith("/chat/completions")) return void res.writeHead(404).end();
      const body = JSON.parse(raw || "{}");
      const out = reply(body);
      const id = `chatcmpl-${++n}`;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: "assistant", content: "" });
      if (out.calls) {
        out.calls.forEach((c, index) => chunk({ tool_calls: [{ index, id: `call_${n}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
        chunk({}, "tool_calls");
      } else {
        chunk({ content: out.text ?? "" });
        chunk({}, "stop");
      }
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, calls };
}

/**
 * A Mac running the whole runtime as the desktop app starts it (bin.ts, `--bootstrap-fd 3`): its agents key (`agentsKey`,
 * PEM) is handed over on that private descriptor only, never in the environment or argv, as apps/desktop runtime.ts
 * does; enrolled with the person's sign-in under `name`, Remote control and sync on, its chats on `model` (a
 * scriptedModel endpoint). Its Claude Agent is the stand-in CLI, its home a scratch one: nothing of this machine's own.
 */
export async function startDesktopMac(name: string, origin: string, bearer: string, options: { readonly agentsKey: string; readonly model: string; readonly env?: Record<string, string> }) {
  const scratch = tempRoot("macs-desktop-");
  const home = path.join(scratch, "home");
  const baseDir = path.join(scratch, "caveman");
  const stateDir = path.join(baseDir, "userdata");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: FAKE_CLAUDE } } } }));
  await enroll({ dir: linkDirOf(stateDir), cloudUrl: origin, bearer, name });
  const port = await new Promise<number>((resolve) => {
    const probe = net.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const p = (probe.address() as AddressInfo).port;
      probe.close(() => resolve(p));
    });
  });
  const token = randomUUID();
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), CAVEMAN_CODE_NO_BROWSER: "1" };
  for (const variable of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CAVEMAN_PROXY_BIN", "CAVEMAN_MCP_BIN", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CAVEMAN_CODE_HOME"]) delete env[variable];
  const log = path.join(scratch, "runtime.log");
  const out = fs.openSync(log, "w");
  // stdin stays open, as the desktop app keeps it: the runtime ends when its parent's pipe closes.
  const child = spawn(process.execPath, ["--no-warnings", "--disable-sigusr1", BIN, "--bootstrap-fd", "3"], { env, cwd: home, stdio: ["pipe", out, out, "pipe"] });
  children.push(child);
  // apps/desktop runtime.ts bootstrapEnvelope: the agents key here only.
  (child.stdio[3] as NodeJS.WritableStream).end(`${JSON.stringify({ mode: "desktop", noBrowser: true, host: "127.0.0.1", port, t3Home: baseDir, desktopBootstrapToken: token, agentsKey: options.agentsKey })}\n`);
  await until(() => fs.readFileSync(log, "utf8").includes("Listening on") || child.exitCode !== null, 180_000);
  if (child.exitCode !== null) throw new Error(`${name} exited: ${fs.readFileSync(log, "utf8").slice(-2000)}`);
  const url = `ws://127.0.0.1:${port}/session/v1`;
  const client = connect(url, () => token);
  const requests: Array<string> = [];
  client.on("device.request", (r) => requests.push(r.device_id));
  await client.call("engine.account.add", { request_id: `endpoint-${name}`, engine: "caveman", provider: "custom-agents", endpoint: { name: `${name} model`, base_url: options.model, models: ["mail-m"] } });
  let model = "";
  await until(async () => (model = (await client.call("engine.list", {})).engines.find((e) => e.id === "caveman")?.models.find((m) => m.id.endsWith("/mail-m"))?.id ?? "") !== "", 60_000);
  await client.call("settings.set", { request_id: `on-${name}`, settings: { sync_chats: true, remote_control: true } });
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 60_000);
  const status = await client.call("cloud.status", {});
  const key = await testDevice(name, "mac");
  return { name, child, client, key, requests, origin, bearer, log, runtimeId: status.runtime_id!, computerId: status.computer_id!, url, token, stateDir: baseDir, model };
}

/**
 * One of the person's Cloud computers, as the computers service runs it: its row (made by the person, running), its
 * runtime's identity (enrolled by SQL, as moves.e2e.test.ts does) and a real runtime process on it, named `name`
 * ("heard: … (on Box one)"), reaching Cloud at `origin` (front: the relay too), whose checkout of the repository is
 * `checkout`.
 */
export async function startBox(name: string, origin: string, me: { readonly user: { readonly id: string; readonly organization_id: string } }, checkout: string, env: Record<string, string> = {}) {
  const org = me.user.organization_id;
  const computerId = randomUUID();
  const runtimeId = randomUUID();
  const { privateKey } = generateKeyPairSync("ed25519");
  const pub = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  sql(`INSERT INTO code_computers (id, organization_id, driver, size, name, created_by, observed_state, observed_generation, observed_at) VALUES ('${computerId}', '${org}', 'kubernetes', '2cpu-4gb', '${name}', '${me.user.id}', 'running', 1, now());
    INSERT INTO code_runtimes (id, organization_id, computer_id, name, public_key) VALUES ('${runtimeId}', '${org}', '${computerId}', '${name}', '\\x${pub}');`);
  boxes.push(computerId);
  const linkDir = tempRoot("macs-box-link-");
  fs.writeFileSync(path.join(linkDir, "runtime.json"), JSON.stringify({ cloud_url: origin, runtime_id: runtimeId, organization_id: org, computer_id: computerId, user_id: me.user.id }));
  fs.writeFileSync(path.join(linkDir, "runtime.key"), privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  const outFile = path.join(tempRoot("macs-box-"), "out.json");
  const log = fs.openSync(`${outFile}.log`, "w");
  const child = spawn(process.execPath, ["--no-warnings", RUNTIME], {
    env: { ...process.env, ...env, MOVES_ROLE: "cloud", MOVES_NAME: name, MOVES_OUT: outFile, CAVEMAN_CLOUD_LINK_DIR: linkDir, CAVEMAN_WORKSPACE_ROOT: checkout },
    stdio: ["ignore", log, log],
  });
  children.push(child);
  await until(() => fs.existsSync(outFile) || child.exitCode !== null, 120_000);
  if (!fs.existsSync(outFile)) throw new Error(`${name} exited: ${fs.readFileSync(`${outFile}.log`, "utf8").slice(-2000)}`);
  const info = JSON.parse(fs.readFileSync(outFile, "utf8")) as { url: string; token: string; stateDir: string };
  const client = connect(info.url, info.token);
  await client.call("engine.account.add", { request_id: `key-${runtimeId}`, engine: "caveman", provider: "anthropic", key: `sk-${""}ant-macs-e2e-box-${runtimeId.slice(0, 8)}-0123456789abcdef` });
  await until(async () => (await client.call("cloud.status", {})).state === "connected", 60_000);
  return { name, child, client, runtimeId, computerId, log: `${outFile}.log`, ...info };
}
export type Box = Awaited<ReturnType<typeof startBox>>;

/** A device's own connection to `on` through the real relay, as a phone or another Mac opens it. */
export async function relayWire(on: Mac): Promise<Wire & { readonly ws: WebSocket; readonly closed: () => boolean }> {
  const url = new URL(`/relay/v1/runtimes/${on.runtimeId}`, on.origin);
  url.protocol = "ws:";
  const ws = new WebSocket(url, ["caveman.session.v1", `base64url.bearer.${Buffer.from(on.bearer).toString("base64url")}`]);
  sockets.push(ws);
  const replies: Array<any> = [];
  let closed = false;
  ws.on("message", (data) => replies.push(JSON.parse(String(data))));
  ws.on("close", () => void (closed = true));
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => reject(new Error(`relay answered ${res.statusCode}`)));
  });
  return { ws, send: (text) => ws.send(text), replies: () => replies, closed: () => closed };
}

/**
 * `device` says hello to `on`: what `on` answered, and the connection (sealed calls on it once approved). `options.pair`:
 * the code `on`'s screen showed, as a Mac's app that joins it proves it (decision 31).
 */
export async function hello(on: Mac, device: DeviceKey, options: HelloOptions = {}) {
  const wire = await relayWire(on);
  const { reply, keys, hello: helloText, challenge } = await helloOn(wire, device, options);
  const status = (reply.result as { status?: string } | undefined)?.status ?? `error ${JSON.stringify(reply.error)}`;
  // `helloText` and `challenge`: the hello as it went and what it answered, for a proof made over them (pairAnswer).
  return { status, wire, code: (reply.result as { code?: string } | undefined)?.code, helloText, challenge, ...sealedOn(wire, keys) };
}

/**
 * `on`'s own screen allows `device`, signed with its desktop key for the person's other Macs. A Mac's desktop key joins
 * with the code `on`'s screen shows (Add a Mac, decision 31) unless `pair` is false: then it asks as a device.
 */
export async function allowOnScreen(on: Mac, device: DeviceKey, options: { readonly pair?: boolean } = {}) {
  const wire = await relayWire(on);
  return { wire, ...(await allowedOn(wire, on.client, device, { signer: on.key, ...options })) };
}

/** `on`'s own screen removes `device`, signed. */
export const removeOnScreen = async (on: Mac, device: DeviceKey) =>
  on.client.call("device.remove", { request_id: `rm-${device.device_id}-${Date.now()}`, device_id: device.device_id, statement: await removeStatement(on.client, on.key, device.device_id) });

export const deviceList = (on: Mac): Promise<DeviceList> => on.client.call("device.list", {});
export const trusts = async (on: Mac, device: DeviceKey) => (await deviceList(on)).devices.some((d) => d.device_id === device.device_id);
/**
 * A local bare repository standing in for GitHub, which every git here (the Macs' too) reaches by its URL: the env
 * (also set on this process) makes `https://github.com/octocat/<name>` the bare repository.
 */
export function github(root: string) {
  const name = `macs-${Date.now().toString(36)}`;
  const bare = path.join(root, `${name}.git`);
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  const env = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.file://${bare}.insteadOf`, GIT_CONFIG_VALUE_0: `https://github.com/octocat/${name}` };
  Object.assign(process.env, env);
  const seed = path.join(root, "seed");
  execFileSync("git", ["clone", "-q", `https://github.com/octocat/${name}`, seed]);
  fs.writeFileSync(path.join(seed, "README.md"), "hello\n");
  git(seed, "add", ".");
  git(seed, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  git(seed, "push", "-q", "origin", "HEAD:main");
  return { name, bare, env, url: `https://github.com/octocat/${name}` };
}

/** A Mac's agents key as the desktop app hands it to its runtime (here through a test-only file: MOVES_AGENTS_KEY_FILE). */
export function agentsKeyFile() {
  const file = path.join(tempRoot("macs-agents-"), "agents.pem");
  fs.writeFileSync(file, generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  return file;
}

/**
 * A Mac whose runtime is from before repos in the heartbeat: enrolled with the person's sign-in under `name`, it
 * heartbeats through the real link client with no `repos`, as such a runtime does, and does nothing else.
 */
export async function olderMac(name: string, origin: string, bearer: string) {
  const identity = await enroll({ dir: tempRoot("macs-older-"), cloudUrl: origin, bearer, name });
  const link = new CloudLink({ identity, onStream: () => ({ message: () => undefined, closed: () => undefined }), active: () => false, log: () => undefined, relay: false, heartbeatMs: 5_000 });
  links.push(link);
  await until(() => sql(`SELECT count(*) FROM code_runtimes WHERE id = '${identity.runtimeId}' AND last_seen_at > now() - interval '30 seconds'`) === "1", 60_000);
  return { name, runtimeId: identity.runtimeId, computerId: identity.computerId, stop: () => link.stop() };
}

/** The Mac's load as `uptime` says it, for the lab-only timings. */
export const load = () => execFileSync("uptime", { encoding: "utf8" }).trim();
