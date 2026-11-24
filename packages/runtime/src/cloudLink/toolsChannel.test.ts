// The exec channel's two clients, the runtime's in-process one (toolsChannel.ts) and toolsExec.mjs's exec, against
// tools sides that misbehave. Real sockets and a real client process; nothing is mocked.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

import * as Effect from "effect/Effect";
import * as ChildProcess from "effect/process/ChildProcess";
import * as Stream from "effect/Stream";
import { afterEach, expect, it, vi } from "vitest";

import { toolsRun, toolsToFile } from "./tools.ts";
import { channelHandle, channelRun, provesToken } from "./toolsChannel.ts";

const TOOLS_EXEC = path.join(import.meta.dirname, "toolsExec.mjs");
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A tools side on loopback that resets each connection once its request line arrives; counts connections. */
const resettingServer = async (delayMs = 0) => {
  let connections = 0;
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    connections++;
    open.add(socket.once("close", () => open.delete(socket)));
    socket.on("error", () => {});
    let header = "";
    socket.on("data", (chunk) => {
      header += chunk.toString();
      if (header.includes("\n")) setTimeout(() => socket.resetAndDestroy(), delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), open.forEach((socket) => socket.destroy()))));
  return { address: `127.0.0.1:${(server.address() as net.AddressInfo).port}`, connections: () => connections };
};

// Audit K (stale retry handler): the connect retry's error handler stayed on the socket after it connected, so a reset
// mid-command dialled the tools side again and left that socket open.
it("a channel reset after the request is one connection and ends 125, without a second dial", async () => {
  const tools = await resettingServer();
  const stderr: Array<string> = [];
  const run = channelRun(tools.address, { argv: ["sleep", "5"], cwd: "/", env: {} }, { stdout: () => {}, stderr: (chunk) => stderr.push(chunk.toString()) });
  expect(await run.done).toEqual({ code: 125, stopped: false });
  expect(stderr.join("")).toBe("toolsExec: the tools container closed the channel\n");
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect(tools.connections()).toBe(1);
});

// The exec client's stale handler, past its 30 s connect wait, took a reset for a tools side that never answered: exit
// 127 and the wrong message. The client runs with its clock moved 60 s on once it connected, as a command that has run
// that long sees it.
it("the exec client takes a reset after a long command for a closed channel (125), not a tools side that never answered (127)", async () => {
  const tools = await resettingServer(500);
  const later = `const now = Date.now; setTimeout(() => { Date.now = () => now() + 60_000; }, 200).unref();`;
  const client = spawn(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(later)}`, TOOLS_EXEC, "exec", "--socket", tools.address, "--cwd", "/", "--", "sleep", "5"], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  client.stderr!.on("data", (chunk) => (stderr += chunk));
  const code = await new Promise<number | null>((resolve) => client.on("exit", resolve));
  expect([code, stderr]).toEqual([125, "toolsExec: the tools container closed the channel\n"]);
  expect(tools.connections()).toBe(1);
});

const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

// Audit K (pre-auth header): the server buffered the request line until its newline with no bound, before it checked
// the token (RSS reached about 10 GB in the lab). The line is capped at 4 MiB, past what execve takes (an argument up to
// 128 KiB, argv and env together about 2 MiB on Linux), so no command that could run is refused.
it("serve refuses a request line past 4 MiB and closes the channel; a 120 KiB argument still runs", async () => {
  const address = `127.0.0.1:${await freePort()}`;
  const server = spawn(process.execPath, [TOOLS_EXEC, "serve", address], { stdio: ["ignore", "ignore", "pipe"] });
  cleanups.push(() => server.kill());
  let log = "";
  server.stderr!.on("data", (chunk) => (log += chunk));
  for (let i = 0; i < 100 && !log.includes("toolsExec: serving"); i++) await new Promise((resolve) => setTimeout(resolve, 50));

  const [host, port] = address.split(":") as [string, string];
  const answer = await new Promise<string>((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let got = Buffer.alloc(0);
    const bound = setTimeout(() => (socket.destroy(), resolve(`no answer within 5 s after ${got.length} bytes`)), 5_000);
    socket.on("data", (chunk) => (got = Buffer.concat([got, chunk])));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(bound);
      resolve(got.length >= 5 ? `${got.readUInt8(0)} ${got.subarray(5, 5 + got.readUInt32BE(1)).toString()}` : `closed after ${got.length} bytes`);
    });
    socket.write(Buffer.alloc(5 * 1024 * 1024, 0x61));
  });
  expect(answer).toBe("19 request too large");

  const big = "x".repeat(120 * 1024);
  const ran = spawnSync(process.execPath, [TOOLS_EXEC, "exec", "--socket", address, "--cwd", "/", "--", "sh", "-c", 'printf %s "$1" | wc -c', "sh", big], { encoding: "utf8" });
  expect([ran.status, ran.stdout.trim(), ran.stderr]).toEqual([0, String(big.length), ""]);
});

/** A tools side on loopback that answers the request line with one EXIT frame (18) holding `payload`, then closes. */
const exitingServer = async (payload: string) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    let header = "";
    socket.on("data", (chunk) => {
      header += chunk.toString();
      if (!header.includes("\n")) return;
      const body = Buffer.from(payload);
      const head = Buffer.alloc(5);
      head.writeUInt8(18, 0);
      head.writeUInt32BE(body.length, 1);
      socket.end(Buffer.concat([head, body]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
};

/** channelRun in a Node process of its own, as the runtime runs it: how that process ended, and what the run reported. */
const runElsewhere = (address: string) =>
  new Promise<{ status: number | null; end?: unknown; stderr?: string; crash?: string | undefined }>((resolve) => {
    const script = `
      const { channelRun } = await import(${JSON.stringify(new URL("./toolsChannel.ts", import.meta.url).href)});
      const stderr = [];
      const end = await channelRun(${JSON.stringify(address)}, { argv: ["git", "status"], cwd: "/", env: {} }, { stdout: () => {}, stderr: (chunk) => stderr.push(chunk), stdin: new Uint8Array(0) }).done;
      process.stdout.write(JSON.stringify({ end, stderr: Buffer.concat(stderr).toString() }));
    `;
    const child = spawn(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (chunk) => (out += chunk));
    child.stderr!.on("data", (chunk) => (err += chunk));
    child.on("close", (status) => resolve(status === 0 ? { status, ...(JSON.parse(out) as { end: unknown; stderr: string }) } : { status, crash: err.split("\n").find((line) => /Error/.test(line)) }));
  });

const unreadable = "toolsExec: the tools container sent an exit status that could not be read\n";
/** EXIT payloads, and the code and stderr either client makes of them. */
const exits: Array<[string, number, string]> = [
  [JSON.stringify({ code: 3, signal: null }), 3, ""],
  [JSON.stringify({ code: null, signal: "SIGTERM" }), 143, ""],
  ["x", 125, unreadable],
  ["null", 125, unreadable],
  [JSON.stringify({ code: "0", signal: null }), 125, unreadable],
  // No process exits with these: an exit status is a byte.
  [JSON.stringify({ code: 1e300, signal: null }), 125, unreadable],
  [JSON.stringify({ code: -1, signal: null }), 125, unreadable],
  // A name no signal has, an inherited property's included, is 128 + 1.
  [JSON.stringify({ code: null, signal: "constructor" }), 129, ""],
];

// Audit security-4#2: an EXIT frame whose payload was not toolsExec.mjs's {code, signal} threw out of the socket's 'data'
// listener, which nothing in the runtime catches: whatever held the tools port could end the runtime on its next call.
it("an exit status the tools side garbles fails the command, and the process that asked lives on", async () => {
  for (const [payload, code, stderr] of exits) expect([payload, await runElsewhere(await exitingServer(payload))]).toEqual([payload, { status: 0, end: { code, stopped: false }, stderr }]);
}, 60_000);

// The exec client (a terminal, an engine an SDK starts) read the same payload unguarded: a garbled one ended it with
// Node's stack trace and 1, or a RangeError for a code past what an exit status holds, where the in-process client
// says 125 and why.
it("the exec client reads a garbled exit status as the in-process client does", async () => {
  for (const [payload, code, stderr] of exits) {
    const client = spawn(process.execPath, [TOOLS_EXEC, "exec", "--socket", await exitingServer(payload), "--cwd", "/", "--", "git", "status"], { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    client.stderr!.on("data", (chunk) => (err += chunk));
    const status = await new Promise<number | null>((resolve) => client.on("close", resolve));
    expect([payload, status, err]).toEqual([payload, code, stderr]);
  }
}, 60_000);

/** A frame header: `type` and the length it declares. */
const header = (type: number, length: number) => {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(length, 1);
  return head;
};

/**
 * What holds the tools or servers address, answering the client's first line (its request, or the servers channel's
 * hello) with a frame of `type` declaring 4 GiB, then streaming up to `total` bytes of it, each write once the last
 * drained. `finished`: it sent them all before the client went.
 */
const floodingServer = async (type: number, total = 24 * 1024 * 1024) => {
  let finished!: (all: boolean) => void;
  const result = new Promise<boolean>((resolve) => (finished = resolve));
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on("error", () => {});
    let sent = 0;
    const closed = new Promise<void>((resolve) => socket.once("close", () => (open.delete(socket), finished(sent >= total), resolve())));
    let gone = false;
    void closed.then(() => (gone = true));
    socket.once("data", async () => {
      socket.write(header(type, 0xffffffff));
      const piece = Buffer.alloc(64 * 1024, 0x61);
      while (sent < total && !gone) {
        sent += piece.length;
        if (!socket.write(piece)) await Promise.race([new Promise<void>((resolve) => socket.once("drain", () => resolve())), closed]);
      }
      if (!gone) socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), open.forEach((socket) => socket.destroy()))));
  return { address: `127.0.0.1:${(server.address() as net.AddressInfo).port}`, finished: result };
};

// Audit w6-n184: neither the in-process client nor the servers channel's proof capped a frame's declared length, and
// both concatenated the whole buffer again on every chunk: whatever held the address (an agent's process on the pod's
// loopback) could declare 4 GiB and stream it, and the runtime held all of it, copying it over and over.
it("a frame declared past what the channel carries is refused at its header and the channel closed, never buffered", async () => {
  const tools = await floodingServer(16);
  const stderr: Array<string> = [];
  const run = channelRun(tools.address, { argv: ["git", "status"], cwd: "/", env: {} }, { stdout: () => {}, stderr: (chunk) => stderr.push(chunk.toString()), stdin: new Uint8Array(0) });
  expect([await run.done, stderr.join(""), await tools.finished]).toEqual([
    { code: 125, stopped: false },
    "toolsExec: the tools container sent a frame of 4294967295 bytes, more than the 1048576 the channel carries\n",
    false,
  ]);

  const token = randomBytes(32).toString("hex");
  const servers = await floodingServer(20);
  const told: Array<string> = [];
  const unproven = channelRun(servers.address, { argv: ["git", "status"], cwd: "/", env: {}, token }, { stdout: () => {}, stderr: (chunk) => told.push(chunk.toString()) });
  expect([await unproven.done, told.join(""), await servers.finished]).toEqual([
    { code: 127, stopped: false },
    `toolsExec: the servers channel on ${servers.address} did not prove its token; nothing was sent to it\n`,
    false,
  ]);

  const probed = await floodingServer(20);
  expect([await provesToken(probed.address, token, 30_000), await probed.finished]).toEqual([false, false]);
}, 60_000);

/** A tools side on loopback that answers the request line with one STDOUT frame of `size` bytes sent 4 KiB at a time, then EXIT 0. */
const piecemealServer = async (size: number) => {
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.once("data", async () => {
      socket.write(header(16, size));
      for (let at = 0; at < size; at += 4096) {
        socket.write(Buffer.alloc(4096, 0x62));
        await new Promise((resolve) => setImmediate(resolve));
      }
      const exit = Buffer.from(JSON.stringify({ code: 0, signal: null }));
      socket.write(header(18, exit.length));
      socket.end(exit);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
};

it("a frame that arrives in many small pieces is copied once when whole, not once per piece", async () => {
  const size = 512 * 1024;
  const address = await piecemealServer(size);
  // Buffer.concat as it is, counting what it copies: the only way the client joins chunks.
  let copied = 0;
  const concat = Buffer.concat;
  const spy = vi.spyOn(Buffer, "concat").mockImplementation((list, length) => {
    const joined = concat(list, length);
    copied += joined.length;
    return joined;
  });
  cleanups.push(() => spy.mockRestore());
  let received = 0;
  const end = await channelRun(address, { argv: ["cat", "big"], cwd: "/", env: {} }, { stdout: (chunk) => (received += chunk.length), stderr: () => {}, stdin: new Uint8Array(0) }).done;
  spy.mockRestore();
  expect([end, received]).toEqual([{ code: 0, stopped: false }, size]);
  expect(copied).toBeLessThanOrEqual(2 * size);
}, 60_000);

/** toolsExec.mjs's exec client running `git status` over the channel at `address`: its exit status and stderr. */
const execClient = async (address: string, env: NodeJS.ProcessEnv = {}, node: ReadonlyArray<string> = []) => {
  const client = spawn(process.execPath, [...node, TOOLS_EXEC, "exec", "--socket", address, "--cwd", "/", "--", "git", "status"], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...env } });
  let stdout = 0;
  let stderr = "";
  client.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.length));
  client.stderr!.on("data", (chunk) => (stderr += chunk));
  const status = await new Promise<number | null>((resolve) => client.on("close", resolve));
  return { status, stdout, stderr };
};

// Audit w6-n184 (review): toolsExec.mjs's exec client, which runs in the runtime container for every engine and terminal,
// read frames as the in-process client did: a declared 4 GiB frame was buffered whole before its stdout's backpressure
// could apply, and the whole buffer was joined again on every chunk.
it("the exec client refuses a frame declared past what the channel carries at its header, as the in-process client does", async () => {
  const tools = await floodingServer(16);
  const ran = await execClient(tools.address);
  expect([ran.status, ran.stderr, await tools.finished]).toEqual([125, "toolsExec: the tools container sent a frame of 4294967295 bytes, more than the 1048576 the channel carries\n", false]);

  const servers = await floodingServer(20);
  const unproven = await execClient(servers.address, { CAVEMAN_RUNTIME_EXEC_TOKEN: randomBytes(32).toString("hex") });
  expect([unproven.status, unproven.stderr, await servers.finished]).toEqual([127, `toolsExec: the servers channel on ${servers.address} did not prove its token; nothing was sent to it\n`, false]);
}, 60_000);

it("the exec client copies a frame that arrives in many small pieces once when whole, not once per piece", async () => {
  const size = 512 * 1024;
  // Buffer.concat in the client as it is, counting what it copies; said on stderr as the client exits.
  const counting = `import { writeSync } from "node:fs"; const concat = Buffer.concat; let copied = 0; Buffer.concat = (list, length) => { const joined = concat(list, length); copied += joined.length; return joined; }; process.on("exit", () => writeSync(2, "copied " + copied + "\\n"));`;
  const ran = await execClient(await piecemealServer(size), {}, ["--import", `data:text/javascript,${encodeURIComponent(counting)}`]);
  expect([ran.status, ran.stdout]).toEqual([0, size]);
  expect(Number(/^copied (\d+)\n$/.exec(ran.stderr)?.[1])).toBeLessThanOrEqual(2 * size);
}, 60_000);

// The same reader on serve's side: a client's frames (its stdin, its signals) past what the channel carries.
it("serve drops a client that declares a frame past what the channel carries instead of buffering it", async () => {
  const address = `127.0.0.1:${await freePort()}`;
  const server = spawn(process.execPath, [TOOLS_EXEC, "serve", address], { stdio: ["ignore", "ignore", "pipe"] });
  cleanups.push(() => server.kill());
  let log = "";
  server.stderr!.on("data", (chunk) => (log += chunk));
  for (let i = 0; i < 100 && !log.includes("toolsExec: serving"); i++) await new Promise((resolve) => setTimeout(resolve, 50));
  const [host, port] = address.split(":") as [string, string];
  const total = 24 * 1024 * 1024;
  const sentAll = await new Promise<boolean>((resolve) => {
    const socket = net.connect({ host, port: Number(port) });
    let sent = 0;
    let gone = false;
    const closed = new Promise<void>((done) => socket.once("close", () => ((gone = true), done())));
    socket.on("error", () => {});
    void closed.then(() => resolve(sent >= total));
    socket.once("connect", async () => {
      socket.write(`${JSON.stringify({ argv: ["sleep", "30"], cwd: "/", env: {} })}\n`);
      socket.write(header(0, 0xffffffff));
      const piece = Buffer.alloc(64 * 1024, 0x61);
      while (sent < total && !gone) {
        sent += piece.length;
        if (!socket.write(piece)) await Promise.race([new Promise<void>((done) => socket.once("drain", () => done())), closed]);
      }
      if (!gone) socket.end();
    });
  });
  expect(sentAll).toBe(false);
}, 60_000);

let sockets = 0;
/**
 * What holds the tools address, answering the request line with `count` frames of `type`, each `size` bytes (under what
 * the channel carries) of the letter k % 26 for the k-th, each write once the last drained, then EXIT 0; or, once a
 * SIGTERM comes, no more frames and EXIT by that signal. On a unix socket when `unix`, whose buffers are small, so what
 * the client took is what it read. `sent()`: the frames the client has taken so far; `finished`: whether it took them
 * all before it went.
 */
const streamingServer = async (type: number, size: number, count: number, unix = false) => {
  let sent = 0;
  let finished!: (all: boolean) => void;
  const result = new Promise<boolean>((resolve) => (finished = resolve));
  const open = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    open.add(socket);
    socket.on("error", () => {});
    let gone = false;
    const closed = new Promise<void>((resolve) => socket.once("close", () => ((gone = true), open.delete(socket), finished(sent >= count), resolve())));
    let signalled: (() => void) | undefined;
    const terminated = new Promise<void>((resolve) => (signalled = resolve));
    let asked = false;
    socket.on("data", async (chunk: Buffer) => {
      if (asked) return void (chunk.includes("SIGTERM") && signalled?.());
      asked = true;
      // A write holds about 8 KiB of short frames, or one long one.
      const batch = Math.max(1, Math.floor(8192 / (5 + size)));
      let stopped = false;
      void terminated.then(() => (stopped = true));
      while (sent < count && !gone && !stopped) {
        const frames = Array.from({ length: Math.min(batch, count - sent) }, (_, i) => [header(type, size), Buffer.alloc(size, 0x61 + ((sent + i) % 26))]).flat();
        sent += frames.length / 2;
        if (!socket.write(Buffer.concat(frames))) await Promise.race([new Promise<void>((resolve) => socket.once("drain", () => resolve())), closed, terminated]);
      }
      if (gone) return;
      const exit = Buffer.from(JSON.stringify(stopped ? { code: null, signal: "SIGTERM" } : { code: 0, signal: null }));
      socket.end(Buffer.concat([header(18, exit.length), exit]));
    });
  });
  const at = unix ? path.join(os.tmpdir(), `caveman-tc-${process.pid}-${++sockets}.sock`) : undefined;
  await new Promise<void>((resolve) => (at === undefined ? server.listen(0, "127.0.0.1", resolve) : server.listen(at, resolve)));
  cleanups.push(() => new Promise<void>((resolve) => (server.close(() => resolve()), open.forEach((socket) => socket.destroy()))));
  return { address: at ?? `127.0.0.1:${(server.address() as net.AddressInfo).port}`, sent: () => sent, finished: result };
};

// Audit w6-n184 (review): with every frame under the cap, toolsRun (and the stderr toolsToFile and toolsFromFile keep)
// still kept all a command wrote: one `git status` through the tools address put 512 MiB into the runtime and threw
// "Cannot create a string longer than 0x1fffffe8 characters".
it("toolsRun keeps 64 MiB of a command's output, as run()'s maxBuffer, and stops one that writes more in frames each under the cap", async () => {
  const MiB = 1024 * 1024;
  // The command would write 1 GiB: far more than a fast machine moves between the cap and the stop reaching it, so a
  // command that finished writing was never stopped.
  const frames = 1024 * 16;
  for (const [type, stream] of [[16, "stdout"], [17, "stderr"]] as const) {
    const tools = await streamingServer(type, 64 * 1024, frames);
    const ran = await toolsRun(tools.address, "/", ["git", "status"]);
    const said = `toolsExec: git wrote more than ${64 * MiB} bytes to its ${stream}; it was stopped\n`;
    expect([ran.code, ran[stream].length, ran.stderr.endsWith(said), await tools.finished]).toEqual([137, 64 * MiB + (stream === "stderr" ? said.length : 0), true, false]);
  }
  const tools = await streamingServer(17, 64 * 1024, frames);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-tc-")), "out");
  cleanups.push(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const ran = await toolsToFile(tools.address, "/", ["git", "bundle", "create", "-", "HEAD"], file);
  expect([ran.code, ran.stderr.length, await tools.finished]).toEqual([137, 64 * MiB + "toolsExec: git wrote more than 67108864 bytes to its stderr; it was stopped\n".length, false]);
}, 120_000);

// Audit w6-n184 (review): the handle the spawner gives (channelHandle) put every chunk into an unbounded queue and never
// stopped reading, so a command's output nobody read yet (or whatever held the address) grew the runtime without end.
it("output a command's caller has not read stops the channel reading, as a full pipe stops its writer, and all of it arrives once read", async () => {
  // Long frames are bound by their bytes; short ones by their count too (a chunk costs its object as well).
  for (const [size, count, most] of [[64 * 1024, 512, 128], [16, 200_000, 32_768]] as const) {
    const tools = await streamingServer(16, size, count, true);
    const got = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* channelHandle(tools.address, ChildProcess.make("cat", ["big"]), { argv: ["cat", "big"], cwd: "/", env: {} });
          yield* Effect.sleep("1 second");
          const unread = tools.sent();
          let k = 0;
          let inOrder = true;
          const [read, code] = yield* Effect.all(
            [
              Stream.runFold(handle.stdout, () => 0, (n, chunk) => {
                inOrder &&= chunk.byteLength === size && chunk[0] === 0x61 + (k % 26) && chunk[size - 1] === 0x61 + (k % 26);
                k++;
                return n + chunk.byteLength;
              }),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          return { unread, read, code, inOrder };
        }),
      ),
    );
    expect(got.unread).toBeLessThan(most);
    expect([got.read, got.code, got.inOrder, await tools.finished]).toEqual([size * count, 0, true, true]);
  }
  // Stopped with its output unread, it ends as it would here: at once, by the signal, its end not held behind that output.
  const tools = await streamingServer(16, 64 * 1024, 512, true);
  const stopped = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* channelHandle(tools.address, ChildProcess.make("cat", ["big"]), { argv: ["cat", "big"], cwd: "/", env: {} });
        yield* Effect.sleep("1 second");
        const at = Date.now();
        yield* handle.kill();
        return { code: yield* handle.exitCode, ms: Date.now() - at };
      }),
    ),
  );
  expect(stopped.code).toBe(143);
  expect(stopped.ms).toBeLessThan(4_000);
}, 120_000);
