// The servers channel proves its token before anything is sent to it (audit K, the servers container). The pod's
// containers share one loopback, so an agent's process in the tools container could listen on the servers channel's
// address first (before the servers container starts, or after it stops): the runtime would hand it a keyed MCP
// server's environment and, with the old wire, the token itself. Real sockets, a real toolsExec.mjs serve and exec
// client; nothing is mocked.
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, expect, it } from "vitest";

import { liveServersSocket } from "./tools.ts";
import { channelRun, type ChannelRequest } from "./toolsChannel.ts";

const TOOLS_EXEC = path.join(import.meta.dirname, "toolsExec.mjs");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "servers-channel-"));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

/** A process squatting on the servers address: records every byte it is sent; `answer` is what it says to each line. */
const squatter = async (answer?: (line: string) => Buffer | undefined) => {
  const heard: Array<Buffer> = [];
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket.once("close", () => open.delete(socket)));
    socket.on("error", () => {});
    let buffered = "";
    socket.on("data", (chunk: Buffer) => {
      heard.push(chunk);
      buffered += chunk.toString();
      for (let at = buffered.indexOf("\n"); at >= 0; at = buffered.indexOf("\n")) {
        const reply = answer?.(buffered.slice(0, at));
        buffered = buffered.slice(at + 1);
        if (reply) socket.write(reply);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), open.forEach((socket) => socket.destroy()))));
  return { address: `127.0.0.1:${(server.address() as net.AddressInfo).port}`, heard: () => Buffer.concat(heard).toString() };
};

/** A HELLO frame (type 20) holding `payload`. */
const helloFrame = (payload: string) => {
  const body = Buffer.from(payload);
  const head = Buffer.alloc(5);
  head.writeUInt8(20, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};
/** A HELLO frame as a squatter that does not know the token might forge it. */
const forgedHello = () => helloFrame(JSON.stringify({ proof: randomBytes(32).toString("hex"), nonce: randomBytes(16).toString("hex") }));

/** toolsExec.mjs serve with a token on a fresh unix socket. */
const servers = async (token: string) => {
  const address = path.join(tmp(), "servers.sock");
  const child = spawn(process.execPath, [TOOLS_EXEC, "serve", address], { env: { ...process.env, CAVEMAN_TOOLS_TOKEN: token }, stdio: "ignore" });
  cleanups.push(() => child.kill());
  for (let i = 0; i < 200 && !fs.existsSync(address); i++) await new Promise((r) => setTimeout(r, 25));
  return address;
};

const run = async (address: string, request: ChannelRequest) => {
  const out: Array<Buffer> = [];
  const err: Array<Buffer> = [];
  const end = await channelRun(address, request, { stdout: (c) => out.push(c), stderr: (c) => err.push(c) }).done;
  return { code: end.code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() };
};

/** toolsExec.mjs exec with the servers token in its environment, as toolsCommand starts it. */
const execClient = (address: string, token: string | undefined, env: Record<string, string>) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, CAVEMAN_RUNTIME_TOOLS_ENV: Buffer.from(JSON.stringify(env)).toString("base64") };
    if (token === undefined) delete childEnv.CAVEMAN_RUNTIME_EXEC_TOKEN;
    else childEnv.CAVEMAN_RUNTIME_EXEC_TOKEN = token;
    const child = spawn(process.execPath, [TOOLS_EXEC, "exec", "--socket", address, "--", "sh", "-c", 'echo "ran with $SERVER_KEY"'], { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

const token = randomBytes(32).toString("hex");
const KEY = "sk-servers-canary-0123456789";
const request: ChannelRequest = { argv: ["sh", "-c", 'echo "ran with $SERVER_KEY"'], cwd: os.tmpdir(), env: { SERVER_KEY: KEY }, token };

it("a squatter on the servers address is never sent the request, its keys or the token, and is not live", async () => {
  for (const spot of [await squatter(), await squatter(() => forgedHello()), await squatter(() => Buffer.from("toolsExec: serving\n"))]) {
    const env = { CAVEMAN_RUNTIME_SERVERS_ADDRESS: spot.address, CAVEMAN_RUNTIME_SERVERS_TOKEN: token };
    expect(await liveServersSocket(env)).toBeUndefined();
    const inProcess = await run(spot.address, request);
    expect(inProcess.code).toBe(127);
    expect(inProcess.stderr).toContain("did not prove");
    const client = await execClient(spot.address, token, { SERVER_KEY: KEY });
    expect(client.code).toBe(127);
    expect(client.stderr).toContain("did not prove");
    const heard = spot.heard();
    // What it heard is two hellos: a nonce each, nothing else.
    expect(heard).not.toContain(KEY);
    expect(heard).not.toContain("argv");
    expect(heard).not.toContain(token);
    expect(heard.trim().split("\n").every((line) => /^\{"hello":"[0-9a-f]{32}"\}$/.test(line))).toBe(true);
  }
}, 60_000);

/** `ask` (liveServersSocket, or channelRun with the request) in a Node process of its own, as the runtime runs it: how that process ended, and what it was told. */
const askElsewhere = (ask: "live" | "run", address: string) =>
  new Promise<{ status: number | null; told?: unknown; crash?: string | undefined }>((resolve) => {
    const script = `
      const { liveServersSocket } = await import(${JSON.stringify(new URL("./tools.ts", import.meta.url).href)});
      const { channelRun } = await import(${JSON.stringify(new URL("./toolsChannel.ts", import.meta.url).href)});
      const address = ${JSON.stringify(address)};
      let told;
      if (${JSON.stringify(ask)} === "live") told = (await liveServersSocket({ CAVEMAN_RUNTIME_SERVERS_ADDRESS: address, CAVEMAN_RUNTIME_SERVERS_TOKEN: ${JSON.stringify(token)} })) ?? "not live";
      else {
        const stderr = [];
        const end = await channelRun(address, ${JSON.stringify(request)}, { stdout: () => {}, stderr: (chunk) => stderr.push(chunk) }).done;
        told = { code: end.code, stderr: Buffer.concat(stderr).toString() };
      }
      process.stdout.write(JSON.stringify(told));
    `;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve(status === 0 ? { status, told: JSON.parse(out) } : { status, crash: err.split("\n").find((line) => /Error/.test(line)) }));
  });

// Audit security-4#2 (its HELLO side): a HELLO whose payload parsed to something that is not an object (`null`) was
// read for `.proof` outside the parse's guard, in the socket's 'data' listener, which nothing in the runtime catches.
// A squatter on the servers address could end the runtime that way, and liveServersSocket asks on its own (an MCP
// server that starts, cloud sync's check).
it("a squatter whose HELLO is not an object is unproven, and the process that asked lives on", async () => {
  const unproven = { code: 127, stderr: expect.stringContaining("did not prove") };
  for (const payload of ["null", "x", "5", "[]", '"proof"', "{}", JSON.stringify({ proof: 5, nonce: 7 })]) {
    const spot = await squatter(() => helloFrame(payload));
    expect.soft([payload, await askElsewhere("live", spot.address)]).toEqual([payload, { status: 0, told: "not live" }]);
    expect.soft([payload, await askElsewhere("run", spot.address)]).toEqual([payload, { status: 0, told: unproven }]);
    expect(spot.heard().trim().split("\n").every((line) => /^\{"hello":"[0-9a-f]{32}"\}$/.test(line))).toBe(true);
  }
}, 60_000);

it("the servers container proves its token: the command runs with its keys, and the token bytes never cross", async () => {
  const address = await servers(token);
  // A recording relay between the runtime and the servers side: everything either side sends.
  const crossed: Array<Buffer> = [];
  const relay = net.createServer((client) => {
    const upstream = net.connect({ path: address });
    client.on("data", (c: Buffer) => (crossed.push(c), upstream.write(c)));
    upstream.on("data", (c: Buffer) => (crossed.push(c), client.write(c)));
    for (const s of [client, upstream]) s.on("error", () => {}).on("close", () => (client.destroy(), upstream.destroy()));
  });
  await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => relay.close(() => resolve())));
  const via = `127.0.0.1:${(relay.address() as net.AddressInfo).port}`;

  expect(await liveServersSocket({ CAVEMAN_RUNTIME_SERVERS_ADDRESS: via, CAVEMAN_RUNTIME_SERVERS_TOKEN: token })).toBe(via);
  expect(await run(via, request)).toMatchObject({ code: 0, stdout: `ran with ${KEY}\n` });
  expect(await execClient(via, token, { SERVER_KEY: KEY })).toMatchObject({ code: 0, stdout: `ran with ${KEY}\n` });
  const wire = Buffer.concat(crossed);
  expect(wire.toString()).not.toContain(token);
  expect(wire.includes(Buffer.from(token, "hex"))).toBe(false);
}, 60_000);

it("the servers side runs nothing for a client that cannot answer its challenge", async () => {
  const address = await servers(token);
  // No token at all (an agent's own command on the pod's loopback), a wrong token, and the old wire's raw token.
  expect(await execClient(address, undefined, {})).toMatchObject({ code: 127, stderr: expect.stringContaining("bad request") });
  expect(await run(address, { ...request, token: randomBytes(32).toString("hex") })).toMatchObject({ code: 127 });
  const old = await new Promise<string>((resolve) => {
    const socket = net.connect({ path: address });
    let heard = "";
    socket.on("data", (c) => (heard += c.toString()));
    socket.on("close", () => resolve(heard));
    socket.write(`${JSON.stringify({ token, argv: ["sh", "-c", "echo ran"], cwd: os.tmpdir(), env: {} })}\n`);
  });
  expect(old).toContain("bad request");
  expect(old).not.toContain("ran");
}, 60_000);

// Before a request proves the token, the servers side holds little: a short hello line, at most 16 such connections at
// once, and none that falls quiet for 10 s. Unbounded, an agent's process on the pod's loopback could open connections
// that each send a hello and then 4 MiB without a newline, and hold them until the servers container is killed, every
// keyed MCP server with it.
it("the servers side bounds the connections that have not proven the token", async () => {
  const address = await servers(token);
  const hello = `${JSON.stringify({ hello: randomBytes(16).toString("hex") })}\n`;
  /** A connection to the servers side that writes `first`; `frame` is the first frame it is sent, `closed` when it ends. */
  const connect = (first: string, target = address) => {
    const socket = net.connect({ path: target });
    let got = Buffer.alloc(0);
    socket.on("error", () => {});
    const frame = new Promise<string>((resolve) => {
      socket.on("data", (chunk: Buffer) => {
        got = Buffer.concat([got, chunk]);
        if (got.length >= 5 && got.length >= 5 + got.readUInt32BE(1)) resolve(`${got.readUInt8(0)} ${got.subarray(5, 5 + got.readUInt32BE(1)).toString()}`);
      });
      socket.on("close", () => resolve(`closed after ${got.length} bytes`));
    });
    const closed = new Promise<number>((resolve) => socket.on("close", () => resolve(Date.now())));
    cleanups.push(() => socket.destroy());
    socket.write(first);
    return { socket, frame, closed };
  };
  const within = <A>(what: string, ms: number, p: Promise<A>) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${what}: nothing within ${ms} ms`)), ms))]);

  // A hello is about 44 bytes; 300 without a newline is not one. Use a separate
  // server: receiving its error frame does not mean its close handler has
  // returned the connection slot before the capacity check below begins.
  expect(await within("a long hello", 5_000, connect("a".repeat(300), await servers(token)).frame)).toBe("19 bad request");
  // Sixteen connections answered and waiting, then a seventeenth is turned away.
  const held = Array.from({ length: 16 }, () => connect(hello));
  for (const c of held) expect(await within("a held connection's HELLO", 5_000, c.frame)).toMatch(/^20 /);
  const quietFrom = Date.now();
  expect(await within("the seventeenth", 5_000, connect(hello).frame)).toBe("19 too many connections");
  // One goes, and a new one is answered again.
  held.pop()!.socket.destroy();
  await new Promise((resolve) => setTimeout(resolve, 100));
  const again = connect(hello);
  expect(await within("a connection after one closed", 5_000, again.frame)).toMatch(/^20 /);
  // Those that fall quiet after the server's answer go after 10 s.
  const ends = await within("quiet connections closing", 20_000, Promise.all(held.map((c) => c.closed)));
  for (const end of ends) expect(end - quietFrom).toBeGreaterThan(8_000);
  again.socket.destroy();
  // Every count came back: a client that proves the token runs.
  expect(await run(address, request)).toMatchObject({ code: 0, stdout: `ran with ${KEY}\n` });
}, 60_000);

// An idle timeout alone resets on every byte: a process that sends its hello and then a byte of its request line every
// few seconds would hold a slot for good, and sixteen of them every keyed MCP server for every chat on the computer.
it("a connection that trickles its request is closed at its deadline, however its bytes keep coming", async () => {
  const address = await servers(token);
  const socket = net.connect({ path: address });
  socket.on("error", () => {});
  const opened = Date.now();
  const closed = new Promise<number>((resolve) => socket.on("close", () => resolve(Date.now())));
  socket.write(`${JSON.stringify({ hello: randomBytes(16).toString("hex") })}\n`);
  const trickle = setInterval(() => socket.writable && socket.write("x"), 1_000);
  cleanups.push(() => (clearInterval(trickle), socket.destroy()));
  const end = await Promise.race([closed, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("still open after 30 s")), 30_000))]);
  // Its hello's 10 s and a short allowance for the request, from when it connected.
  expect(end - opened).toBeLessThan(20_000);
  expect(end - opened).toBeGreaterThan(10_000);
}, 60_000);

it("the tools channel's wire is unchanged: no token, no handshake", async () => {
  const address = path.join(tmp(), "tools.sock");
  const child = spawn(process.execPath, [TOOLS_EXEC, "serve", address], { env: { ...process.env }, stdio: "ignore" });
  cleanups.push(() => child.kill());
  for (let i = 0; i < 200 && !fs.existsSync(address); i++) await new Promise((r) => setTimeout(r, 25));
  const { token: _, ...plain } = request;
  expect(await run(address, plain)).toMatchObject({ code: 0, stdout: `ran with ${KEY}\n` });
  expect(await execClient(address, undefined, { SERVER_KEY: KEY })).toMatchObject({ code: 0, stdout: `ran with ${KEY}\n` });
}, 60_000);

it("a servers container that did not prove itself once is asked again within seconds, never refused for a minute (m-p)", async () => {
  // Not up yet at the first ask (a container still starting, or one slow answer on a busy pod).
  const address = path.join(tmp(), "servers.sock");
  const env = { CAVEMAN_RUNTIME_SERVERS_ADDRESS: address, CAVEMAN_RUNTIME_SERVERS_TOKEN: token };
  expect(await liveServersSocket(env)).toBeUndefined();
  // Up a moment later, and proven at the next ask after a few seconds.
  const child = spawn(process.execPath, [TOOLS_EXEC, "serve", address], { env: { ...process.env, CAVEMAN_TOOLS_TOKEN: token }, stdio: "ignore" });
  cleanups.push(() => child.kill());
  for (let i = 0; i < 200 && !fs.existsSync(address); i++) await new Promise((r) => setTimeout(r, 25));
  await new Promise((r) => setTimeout(r, 4_000));
  expect(await liveServersSocket(env)).toBe(address);
}, 30_000);
