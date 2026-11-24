// The exec channel between a Cloud computer's two containers. The runtime
// container holds the runtime and its Cloud identity; the tools container is
// where every tool process runs, as the tools uid: git, engines, terminals.
// The runtime cannot exec into tools itself (no Kubernetes token by design),
// so the tools container serves this channel and the runtime starts its
// children through it. The containers share the pod's loopback; a unix
// socket would not do, since gVisor does not share one through a volume.
//
//   node toolsExec.mjs serve <address>
//     in the tools container: runs each request as this uid, umask 002, its
//     own process group; a pty when asked (node-pty from the runtime bundle).
//     <address> is host:port (127.0.0.1:47917 on a computer) or a socket path.
//     A request ends when its command exits, as on This Mac (the SDK's
//     execution-backend.js): `cmd &` keeps running, and output it still writes
//     is read and dropped. Only a client that goes away first (a timeout, an
//     abort, the runtime killing it) takes the command's process group along.
//   node toolsExec.mjs exec --socket <address> [--cwd <dir>] [--env-keys <json names>] -- <command> [args...]
//     in the runtime container: runs <command> in tools and behaves as that
//     process: stdin, stdout, stderr, signals, window size, exit status. For
//     what needs a process there (an engine an SDK starts, a terminal): the
//     runtime's own calls speak the channel in-process (toolsChannel.ts), since
//     booting this client was most of a call's time under gVisor.
//     What <command> gets on top of tools' environment never rides in argv
//     (any process can read it): CAVEMAN_RUNTIME_TOOLS_ENV (base64 JSON) in
//     this client's environment, else the --env-keys names read from it.
//
// Anything in the tools container can reach the socket too and gains nothing:
// it runs commands as the uid it already is. The servers container (MCP
// servers and their keys, under their own uid) serves the same channel with a
// token: CAVEMAN_TOOLS_TOKEN in serve's environment (taken out before anything
// starts), CAVEMAN_RUNTIME_EXEC_TOKEN in the client's. Each side proves it to
// the other and the token never crosses: the agent's own commands, which share
// the pod's loopback, cannot run anything as the servers uid, and one that
// listens on the servers address first (before the servers container starts,
// or after it stops) is never sent a request, its keys or the token. The
// runtime treats what comes back as it treats the repository: untrusted data.
// No credential crosses here; remote git uses the runtime's own mirror
// (cloudLink/tools.ts).
//
// Wire: the client sends one JSON line {argv, cwd, env, pty?}, then frames
// [type u8][length u32 BE][payload]: 0 stdin, 1 stdin end, 2 signal name,
// 3 resize {cols, rows}. The server answers 16 stdout, 17 stderr,
// 18 exit {code, signal}, 19 error message. A frame carries at most 1 MiB:
// either side drops a peer that declares more.
// With a token (the servers channel), first a handshake: the client sends
// {hello: N_c} (16 random bytes, hex) on a line; the server answers frame 20
// {proof: HMAC-SHA256(token, "server|" N_c), nonce: N_s}; only once the proof
// holds does the client send its request line, with auth: HMAC-SHA256(token,
// "client|" N_s) in place of the token, which the server checks before it
// starts anything.
import { spawn } from "node:child_process";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";

const STDIN = 0, STDIN_END = 1, SIGNAL = 2, RESIZE = 3, STDOUT = 16, STDERR = 17, EXIT = 18, ERROR = 19, HELLO = 20;
const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL", "SIGUSR1", "SIGUSR2", "SIGWINCH"]);
/** How long a command that exited gets for its pipes to close: a background child holding them never closes them. */
const EXIT_FLUSH_GRACE_MS = 100;
/**
 * The longest request line serve reads before its newline, read before any token check. Past what execve accepts (an
 * argument up to 128 KiB, argv and env together about 2 MiB on Linux), so no command that could run is refused; an
 * unbounded line grew the server to about 10 GB in the lab.
 */
const MAX_HEADER = 4 * 1024 * 1024;
/** How long a client waits for the servers channel to prove its token. */
const HELLO_WAIT_MS = 10_000;
/**
 * The longest frame either side reads. A command's output goes out as its pipe hands it over (64 KiB at most), stdin in
 * frames of at most 256 KiB (toolsChannel.ts), and every other frame is a short line; a length may declare up to 4 GiB.
 */
const MAX_FRAME = 1024 * 1024;
/**
 * What the servers channel holds for connections whose request has not proven the token, since anyone on the pod's
 * loopback may open one: a hello line of at most MAX_HELLO bytes (one is about 44), at most MAX_UNPROVEN such
 * connections at once (each may still buffer a request line up to MAX_HEADER), none quiet for UNPROVEN_QUIET_MS, and
 * none past UNPROVEN_DEADLINE_MS from when it connected, however its bytes trickle in (they reset the quiet timer).
 */
const MAX_HELLO = 256;
const MAX_UNPROVEN = 16;
const UNPROVEN_QUIET_MS = HELLO_WAIT_MS;
/** Its hello's wait and a short allowance for the request after it: the client sends that at once. */
const UNPROVEN_DEADLINE_MS = HELLO_WAIT_MS + 5_000;

/** The handshake's MAC: HMAC-SHA256(token, "<label>|<nonce>"). */
const mac = (token, label, nonce) => createHmac("sha256", token).update(`${label}|${nonce}`).digest();
const NONCE = /^[0-9a-f]{32}$/;
/** Whether `hex` is the MAC of label and nonce under token, in constant time. */
const proves = (token, label, nonce, hex) => {
  const want = mac(token, label, nonce);
  const given = typeof hex === "string" && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, "hex") : Buffer.alloc(0);
  return given.length === want.length && timingSafeEqual(given, want);
};

/**
 * The command's code from an EXIT frame's {code, signal} (128 + a signal's number, 1 for a name no signal has), or
 * undefined for a payload that is not one: what the channel sends back is untrusted (toolsChannel.ts reads it alike).
 */
const exitCodeOf = (payload) => {
  let exit;
  try {
    exit = JSON.parse(payload.toString());
  } catch {
    return undefined;
  }
  if (typeof exit !== "object" || exit === null) return undefined;
  const { code, signal } = exit;
  if (typeof signal === "string" && signal !== "") return 128 + (Object.hasOwn(os.constants.signals, signal) ? os.constants.signals[signal] : 1);
  if (signal !== null && signal !== "") return undefined;
  if (code === null) return 1;
  return Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
};

/** host:port, or a unix socket path. */
const endpoint = (address) => {
  const tcp = /^([0-9.]+):([0-9]+)$/.exec(address);
  return tcp ? { host: tcp[1], port: Number(tcp[2]) } : { path: address };
};

const frame = (type, payload) => {
  const body = typeof payload === "string" ? Buffer.from(payload) : payload;
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};

/**
 * Feeds socket bytes in; calls onFrame(type, payload) for each whole frame. A frame declared past MAX_FRAME is never
 * buffered: onTooLarge(length) instead, and nothing after it. Chunks are kept as they came until a frame is whole, so one
 * that arrives in many pieces is copied once, not once per piece (toolsChannel.ts reads frames alike).
 */
const frames = (onFrame, onTooLarge) => {
  let parts = [];
  let held = 0;
  let over = false;
  return (chunk) => {
    if (over) return;
    parts.push(chunk);
    held += chunk.length;
    while (held >= 5) {
      if (parts[0].length < 5) parts = [Buffer.concat(parts)];
      const length = parts[0].readUInt32BE(1);
      if (length > MAX_FRAME) {
        over = true;
        parts = [];
        return onTooLarge(length);
      }
      if (held < 5 + length) return;
      const whole = parts.length === 1 ? parts[0] : Buffer.concat(parts);
      const rest = whole.subarray(5 + length);
      parts = rest.length === 0 ? [] : [rest];
      held = rest.length;
      onFrame(whole.readUInt8(0), whole.subarray(5, 5 + length));
    }
  };
};

/**
 * A request's env on top of this container's. git's GIT_CONFIG_* entries add to this container's own instead of
 * replacing them: the computer sets safe.directory there (the checkout's root is not the tools uid's), and git
 * from the runtime brings entries of its own (safe.bareRepository, the git proxy) numbered from 0.
 */
const requestEnv = (base, add) => {
  const env = { ...base, ...add };
  const count = (raw) => (/^[0-9]+$/.test(raw ?? "") ? Number(raw) : undefined);
  const own = count(base.GIT_CONFIG_COUNT);
  const theirs = count(add.GIT_CONFIG_COUNT);
  if (!own || !theirs) return env;
  for (let i = 0; i < own; i++) {
    env[`GIT_CONFIG_KEY_${i}`] = base[`GIT_CONFIG_KEY_${i}`];
    env[`GIT_CONFIG_VALUE_${i}`] = base[`GIT_CONFIG_VALUE_${i}`];
  }
  let n = own;
  for (let i = 0; i < theirs; i++) {
    if (typeof add[`GIT_CONFIG_KEY_${i}`] !== "string") continue;
    env[`GIT_CONFIG_KEY_${n}`] = add[`GIT_CONFIG_KEY_${i}`];
    env[`GIT_CONFIG_VALUE_${n++}`] = add[`GIT_CONFIG_VALUE_${i}`] ?? "";
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
};

function serve(address) {
  // Every process tools runs writes files the runtime (same group) can update.
  process.umask(0o002);
  // Never in a child's environment.
  const token = process.env.CAVEMAN_TOOLS_TOKEN || undefined;
  delete process.env.CAVEMAN_TOOLS_TOKEN;
  const at = endpoint(address);
  if (at.path) fs.rmSync(at.path, { force: true });
  let unproven = 0;
  const server = net.createServer((socket) => {
    socket.on("error", () => {});
    // On the servers channel, a connection counts as unproven until its command starts or it closes.
    let counted = false;
    let deadline;
    if (token !== undefined) {
      if (unproven >= MAX_UNPROVEN) {
        socket.end(frame(ERROR, "too many connections"));
        socket.setTimeout(10_000, () => socket.destroy());
        return;
      }
      unproven++;
      counted = true;
      socket.setTimeout(UNPROVEN_QUIET_MS, () => socket.destroy());
      deadline = setTimeout(() => socket.destroy(), UNPROVEN_DEADLINE_MS);
    }
    const proven = () => {
      if (!counted) return;
      counted = false;
      unproven--;
      socket.setTimeout(0);
      clearTimeout(deadline);
    };
    // The request's bytes before its newline, kept as they came (held in all): copying them into one buffer on every
    // chunk cost a 4 MiB line about 128 MiB of copies.
    let parts = [];
    let held = 0;
    let child;
    let term;
    let exited = false;
    const send = (type, payload) => socket.writable && socket.write(frame(type, payload));
    const kill = (signal) => {
      try {
        if (term) term.kill(signal);
        else if (child?.pid) process.kill(-child.pid, signal);
      } catch {}
    };
    const onFrame = (type, payload) => {
      if (type === STDIN) term ? term.write(payload.toString()) : child?.stdin?.write(payload);
      else if (type === STDIN_END) child?.stdin?.end();
      else if (type === SIGNAL && SIGNALS.has(payload.toString())) kill(payload.toString());
      else if (type === RESIZE && term) {
        const { cols, rows } = JSON.parse(payload.toString());
        term.resize(cols, rows);
      }
    };
    // A frame past what the channel carries: the client is taken for gone, and its command with it.
    const feed = frames(onFrame, () => socket.destroy());
    const start = (request, rest) => {
      proven();
      const [command, ...args] = request.argv;
      const env = requestEnv(process.env, request.env ?? {});
      let answered = false;
      const done = (code, signal) => {
        if (answered) return;
        answered = true;
        send(EXIT, JSON.stringify({ code: code ?? null, signal: signal ?? null }));
        socket.end();
      };
      try {
        if (request.pty) {
          const pty = createRequire(import.meta.url)("node-pty");
          term = pty.spawn(command, args, { cwd: request.cwd, env, cols: request.pty.cols, rows: request.pty.rows, name: env.TERM || "xterm-256color" });
          term.onData((data) => send(STDOUT, data));
          term.onExit(({ exitCode, signal }) => ((exited = true), done(exitCode, signal ? Object.keys(os.constants.signals).find((name) => os.constants.signals[name] === signal) : null)));
        } else {
          child = spawn(command, args, { cwd: request.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
          child.stdout.on("data", (data) => send(STDOUT, data));
          child.stderr.on("data", (data) => send(STDERR, data));
          child.stdin.on("error", () => {});
          child.on("error", (error) => {
            send(ERROR, `${command}: ${error.code === "ENOENT" ? "not found" : error.message}`);
            socket.end();
          });
          let streams = 2;
          let status;
          for (const stream of [child.stdout, child.stderr]) stream.on("close", () => --streams === 0 && status && done(...status));
          child.on("exit", (code, signal) => {
            exited = true;
            status = [code, signal];
            if (streams === 0) done(code, signal);
            else setTimeout(() => done(code, signal), EXIT_FLUSH_GRACE_MS);
          });
        }
      } catch (error) {
        send(ERROR, `${command}: ${error.message}`);
        socket.end();
        return;
      }
      if (rest.length > 0) feed(rest);
    };
    let refused = false;
    // With a token, the nonce this side sent once the client's hello came (the handshake in the header).
    let challenge;
    const refuse = (message) => {
      // The rest is read and dropped: the client gets the error and the channel's end, then it closes, or the
      // socket goes once it falls quiet.
      refused = true;
      parts = [];
      held = 0;
      send(ERROR, message);
      socket.end();
      socket.setTimeout(10_000, () => socket.destroy());
    };
    socket.on("data", (chunk) => {
      if (child || term) return feed(chunk);
      if (refused) return;
      for (;;) {
        const newline = chunk.indexOf(10);
        // The servers channel's first line is the client's hello.
        const limit = token !== undefined && challenge === undefined ? MAX_HELLO : MAX_HEADER;
        if (held + (newline < 0 ? chunk.length : newline) > limit) return refuse(limit === MAX_HELLO ? "bad request" : "request too large");
        if (newline < 0) {
          parts.push(chunk);
          held += chunk.length;
          return;
        }
        const line = Buffer.concat([...parts, chunk.subarray(0, newline)]).toString();
        parts = [];
        held = 0;
        chunk = chunk.subarray(newline + 1);
        if (token !== undefined && challenge === undefined) {
          // The servers channel: prove the token for the client's nonce, and ask it to prove it for ours.
          let hello;
          try {
            hello = JSON.parse(line).hello;
          } catch {}
          if (typeof hello !== "string" || !NONCE.test(hello)) return refuse("bad request");
          challenge = randomBytes(16).toString("hex");
          send(HELLO, JSON.stringify({ proof: mac(token, "server", hello).toString("hex"), nonce: challenge }));
          continue;
        }
        let request;
        try {
          request = JSON.parse(line);
          if (!Array.isArray(request.argv) || request.argv.length === 0 || request.argv.some((a) => typeof a !== "string")) throw new Error("argv");
          if (token !== undefined && !proves(token, "client", challenge, request.auth)) throw new Error("auth");
        } catch {
          return refuse("bad request");
        }
        return start(request, chunk);
      }
    });
    // The client went away while its command ran: the command goes too. After it exited, its group is left alone.
    socket.on("close", () => (proven(), exited || kill("SIGKILL")));
  });
  server.listen(at, () => {
    if (at.path) fs.chmodSync(at.path, 0o660);
    console.error(`toolsExec: serving ${address} as uid ${process.getuid()}`);
  });
}

async function exec(argv) {
  const at = argv.indexOf("--");
  const options = {};
  for (let i = 0; i < (at < 0 ? argv.length : at); i += 2) options[argv[i].replace(/^--/, "")] = argv[i + 1];
  const command = at < 0 ? [] : argv.slice(at + 1);
  if (!options.socket || command.length === 0) {
    console.error("usage: toolsExec.mjs exec --socket <s> --cwd <dir> [--env-keys <json names>] -- <command> [args...]");
    process.exit(64);
  }
  // The tools container may still be starting: wait for its socket.
  const deadline = Date.now() + 30_000;
  const socket = await new Promise((resolve) => {
    const attempt = () => {
      const s = net.connect(endpoint(options.socket));
      const retry = (error) => {
        if (Date.now() > deadline) {
          console.error(`toolsExec: the tools container is not answering on ${options.socket}: ${error.code ?? error.message}`);
          process.exit(127);
        }
        setTimeout(attempt, 200);
      };
      // Retried only until it connects: a reset after that is a closed channel (125), not a tools side that never answered.
      s.once("connect", () => (s.off("error", retry), resolve(s)));
      s.once("error", retry);
    };
    attempt();
  });
  const tty = process.stdin.isTTY === true;
  const token = process.env.CAVEMAN_RUNTIME_EXEC_TOKEN || undefined;
  // The servers channel proves its token before anything else is sent (the handshake in the header).
  const hello = token === undefined ? undefined : randomBytes(16).toString("hex");
  let begun = false;
  const unproven = () => {
    process.stderr.write(`toolsExec: the servers channel on ${options.socket} did not prove its token; nothing was sent to it\n`);
    process.exitCode = 127;
    exited = true;
    socket.destroy();
  };
  const begin = (auth) => {
    begun = true;
    socket.write(
      `${JSON.stringify({
        ...(auth === undefined ? {} : { auth }),
        argv: command,
        // No --cwd: the directory this client was started in (an engine or terminal the caller started there).
        cwd: options.cwd || process.cwd(),
        env: process.env.CAVEMAN_RUNTIME_TOOLS_ENV
          ? JSON.parse(Buffer.from(process.env.CAVEMAN_RUNTIME_TOOLS_ENV, "base64").toString("utf8"))
          : Object.fromEntries(JSON.parse(options["env-keys"] ?? "[]").flatMap((key) => (process.env[key] === undefined ? [] : [[key, process.env[key]]]))),
        ...(tty ? { pty: { cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 } } : {}),
      })}\n`,
    );
    if (tty) {
      process.stdin.setRawMode(true);
      process.stdout.on("resize", () => socket.write(frame(RESIZE, JSON.stringify({ cols: process.stdout.columns, rows: process.stdout.rows }))));
    }
    process.stdin.on("data", (data) => socket.write(frame(STDIN, data)));
    process.stdin.on("end", () => socket.writable && socket.write(frame(STDIN_END, Buffer.alloc(0))));
    process.stdin.on("error", () => {});
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGUSR1", "SIGUSR2"]) process.on(signal, () => socket.write(frame(SIGNAL, signal)));
  };
  let exited = false;
  const feed = frames((type, payload) => {
    if (!begun) {
      // Before the request: only the servers channel's HELLO, proving the token for our nonce.
      let answer;
      try {
        answer = type === HELLO ? JSON.parse(payload.toString()) : undefined;
      } catch {}
      if (type === ERROR) {
        exited = true;
        process.stderr.write(`toolsExec: ${payload}\n`);
        process.exitCode = 127;
      } else if (answer && proves(token, "server", hello, answer.proof) && typeof answer.nonce === "string" && NONCE.test(answer.nonce)) {
        clearTimeout(helloTimer);
        begin(mac(token, "client", answer.nonce).toString("hex"));
      } else unproven();
      return;
    }
    if (type === STDOUT) {
      if (!process.stdout.write(payload)) {
        socket.pause();
        process.stdout.once("drain", () => socket.resume());
      }
    } else if (type === STDERR) process.stderr.write(payload);
    else if (type === ERROR) {
      exited = true;
      process.stderr.write(`toolsExec: ${payload}\n`);
      process.exitCode = 127;
    } else if (type === EXIT) {
      exited = true;
      const code = exitCodeOf(payload);
      if (code === undefined) process.stderr.write("toolsExec: the tools container sent an exit status that could not be read\n");
      process.exitCode = code ?? 125;
    }
  }, (length) => {
    if (!begun) return unproven();
    exited = true;
    process.stderr.write(`toolsExec: the tools container sent a frame of ${length} bytes, more than the ${MAX_FRAME} the channel carries\n`);
    process.exitCode = 125;
    socket.destroy();
  });
  let helloTimer;
  if (hello === undefined) begin(undefined);
  else {
    socket.write(`${JSON.stringify({ hello })}\n`);
    helloTimer = setTimeout(unproven, HELLO_WAIT_MS);
  }
  socket.on("data", feed);
  socket.on("error", () => {});
  socket.on("close", () => {
    clearTimeout(helloTimer);
    if (!exited) {
      process.stderr.write("toolsExec: the tools container closed the channel\n");
      process.exitCode = 125;
    }
    // Flush stdout before leaving; stdin may still hold the loop open.
    process.stdout.write("", () => process.exit());
  });
}

if (process.argv[2] === "serve") serve(process.argv[3] ?? process.env.CAVEMAN_TOOLS_ADDRESS);
else if (process.argv[2] === "exec") await exec(process.argv.slice(3));
else {
  console.error("usage: toolsExec.mjs serve <socket> | exec --socket <s> --cwd <dir> [--env-keys <json names>] -- <command> [args...]");
  process.exit(64);
}
