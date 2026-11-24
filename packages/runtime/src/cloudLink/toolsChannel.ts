// The exec channel spoken from the runtime's own process. On a Cloud computer every child the runtime starts
// runs in the tools container (tools.ts); started through `node toolsExec.mjs exec`, each one first booted a Node
// client in the runtime container, which under gVisor took about 95 ms of every call: three quarters of a
// `git status` or a file read (Caveman Cloud docs/cavebench/COMPUTERS.md, "What a computer uses while an agent
// works"). Here the runtime connects to the channel itself and speaks the frames toolsExec.mjs serves (its header
// documents them): the command, its cwd and env, the exit code and the process group's fate are what the client
// gave. A terminal (a pty), an engine the SDKs start themselves, or a command whose stdio is not piped still take
// the client.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as net from "node:net";
import * as os from "node:os";

import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const STDIN = 0, STDIN_END = 1, SIGNAL = 2, STDOUT = 16, STDERR = 17, EXIT = 18, ERROR = 19, HELLO = 20;
/** The signals toolsExec.mjs forwards to a command's process group. */
const SIGNALS = new Set(["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGKILL", "SIGUSR1", "SIGUSR2", "SIGWINCH"]);
/** A stdin frame at most this big: a large write streams instead of arriving as one buffer. */
const STDIN_FRAME = 256 * 1024;
/** How long a command whose container is still starting is waited for, as the client waited. */
const CONNECT_WAIT_MS = 30_000;
/** How long the servers channel gets to prove its token, as toolsExec.mjs's client gives it. */
const HELLO_WAIT_MS = 10_000;
/**
 * The longest frame read from the channel. toolsExec.mjs sends a command's output as its pipe hands it over (64 KiB at
 * most) and every other frame is a short line; whatever holds the address may declare up to 4 GiB in a frame's length.
 */
const MAX_FRAME = 1024 * 1024;
/**
 * What a command's output may hold here unread before the channel stops reading it, as a pipe nobody reads fills and
 * its writer waits. A chunk costs its object as well as its bytes, so a short one counts as CHUNK_COST: whatever holds
 * the address chooses how its output is cut into frames.
 */
const UNREAD_MAX = MAX_FRAME;
const CHUNK_COST = 1024;

/** What the runtime asks tools to run: toolsExec.mjs's request line. */
export interface ChannelRequest {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly token?: string;
}

/** A command's end as the exec client reported it: its code, 128 + a signal's number, 127 or 125. */
export interface ChannelEnd {
  readonly code: number;
  /** The command was stopped from here (a timeout, an abort, a scope that closed). */
  readonly stopped: boolean;
}

const frame = (type: number, payload: Uint8Array | string) => {
  const body = typeof payload === "string" ? Buffer.from(payload) : Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(body.length, 1);
  return Buffer.concat([head, body]);
};

/**
 * The servers channel's handshake (toolsExec.mjs's header): a nonce goes out on a line, and frame 20 must come back
 * with HMAC-SHA256(token, "server|" nonce) and the server's own nonce, before the request (and its keys) is sent.
 */
const channelHello = () => {
  const nonce = randomBytes(16).toString("hex");
  return { nonce, line: `${JSON.stringify({ hello: nonce })}\n` };
};
const mac = (token: string, label: string, nonce: string) => createHmac("sha256", token).update(`${label}|${nonce}`).digest();
/**
 * The request's auth (HMAC-SHA256(token, "client|" the server's nonce)) when `payload`, a HELLO frame's, proves `token`
 * for `nonce`; undefined when it does not, or is not a `{proof, nonce}` at all: whatever holds the address wrote it.
 */
const answerHello = (token: string, nonce: string, payload: Buffer): string | undefined => {
  let answer: unknown;
  try {
    answer = JSON.parse(payload.toString());
  } catch {
    return undefined;
  }
  if (typeof answer !== "object" || answer === null) return undefined;
  const { proof, nonce: theirs } = answer as { proof?: unknown; nonce?: unknown };
  const want = mac(token, "server", nonce);
  const given = typeof proof === "string" && /^[0-9a-f]{64}$/.test(proof) ? Buffer.from(proof, "hex") : Buffer.alloc(0);
  if (given.length !== want.length || !timingSafeEqual(given, want) || typeof theirs !== "string" || !/^[0-9a-f]{32}$/.test(theirs)) return undefined;
  return mac(token, "client", theirs).toString("hex");
};
/**
 * The command's code from an EXIT frame's `{code, signal}`, as the exec client reads it (128 + a signal's number, 1 for a
 * name no signal has), or undefined for a payload that is not one, a code no exit status holds included: what comes back
 * is untrusted data (toolsExec.mjs).
 */
const exitCodeOf = (payload: Buffer): number | undefined => {
  let exit: unknown;
  try {
    exit = JSON.parse(payload.toString());
  } catch {
    return undefined;
  }
  if (typeof exit !== "object" || exit === null) return undefined;
  const { code, signal } = exit as { code?: unknown; signal?: unknown };
  if (typeof signal === "string" && signal !== "") return 128 + (Object.hasOwn(os.constants.signals, signal) ? (os.constants.signals as Record<string, number>)[signal]! : 1);
  if (signal !== null && signal !== "") return undefined;
  if (code === null) return 1;
  return typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 255 ? code : undefined;
};
/**
 * Feeds socket bytes in; `onFrame(type, payload)` for each whole frame until it returns false. A frame declared past
 * MAX_FRAME is never buffered: `onTooLarge(length)` instead, and nothing after it. Chunks are kept as they came until a
 * frame is whole, so one that arrives in many pieces is copied once, not once per piece.
 */
const frameReader = (onFrame: (type: number, payload: Buffer) => boolean | void, onTooLarge: (length: number) => void) => {
  let parts: Array<Buffer> = [];
  let held = 0;
  let over = false;
  return (chunk: Buffer) => {
    if (over) return;
    parts.push(chunk);
    held += chunk.length;
    while (held >= 5) {
      if (parts[0]!.length < 5) parts = [Buffer.concat(parts)];
      const length = parts[0]!.readUInt32BE(1);
      if (length > MAX_FRAME) {
        over = true;
        parts = [];
        return onTooLarge(length);
      }
      if (held < 5 + length) return;
      const whole = parts.length === 1 ? parts[0]! : Buffer.concat(parts);
      const rest = whole.subarray(5 + length);
      parts = rest.length === 0 ? [] : [rest];
      held = rest.length;
      if (onFrame(whole.readUInt8(0), whole.subarray(5, 5 + length)) === false) {
        over = true;
        parts = [];
        return;
      }
    }
  };
};
const connectOnce = (address: string) => {
  const tcp = /^([0-9.]+):([0-9]+)$/.exec(address);
  return tcp ? net.connect({ host: tcp[1]!, port: Number(tcp[2]) }) : net.connect({ path: address });
};

/** Whether the channel at `address` proves `token` within `ms`: the handshake alone, then the connection closes. */
export const provesToken = (address: string, token: string, ms: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connectOnce(address);
    const hello = channelHello();
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), ms);
    socket.once("error", () => done(false));
    socket.once("close", () => done(false));
    socket.once("connect", () => socket.write(hello.line));
    socket.on(
      "data",
      frameReader(
        (type, payload) => (done(type === HELLO && answerHello(token, hello.nonce, payload) !== undefined), false),
        () => done(false),
      ),
    );
  });

/** A connection to the channel, retried while the tools container starts, or undefined after CONNECT_WAIT_MS. */
const connect = (address: string, signal?: AbortSignal) =>
  new Promise<net.Socket | undefined>((resolve) => {
    const deadline = Date.now() + CONNECT_WAIT_MS;
    const attempt = () => {
      if (signal?.aborted) return resolve(undefined);
      const socket = connectOnce(address);
      const retry = () => {
        socket.destroy();
        if (Date.now() > deadline) resolve(undefined);
        else setTimeout(attempt, 200);
      };
      // Retried only until it connects: an error after that (a reset mid-command) is the command's to report.
      socket.once("connect", () => (socket.off("error", retry), resolve(socket)));
      socket.once("error", retry);
    };
    attempt();
  });

export interface ChannelRun {
  /** Resolves once the command ended (or tools never answered). */
  readonly done: Promise<ChannelEnd>;
  /** Writes to the command's stdin; ignored once it ended. */
  readonly write: (chunk: Uint8Array) => void;
  /** Ends the command's stdin. */
  readonly end: () => void;
  /** Sends `name` to the command's process group (toolsExec.mjs's set of signals). */
  readonly signal: (name: string) => void;
  /** Ends the command: its process group is killed, as when the client went away. Nothing it sent after is read. */
  readonly stop: () => void;
  /** Stops reading what the command writes, as a pipe nobody reads: it waits once the channel is full. */
  readonly pause: () => void;
  /** Reads on after pause(). */
  readonly resume: () => void;
}

/**
 * Runs `request` in tools over the channel at `address`, without a client process. stdout and stderr arrive as
 * chunks; `stdin`, when given, is written and ended (a stream is written as it is read).
 */
export const channelRun = (
  address: string,
  request: ChannelRequest,
  io: { readonly stdout: (chunk: Buffer) => void; readonly stderr: (chunk: Buffer) => void; readonly stdin?: Uint8Array | AsyncIterable<Uint8Array> },
): ChannelRun => {
  let socket: net.Socket | undefined;
  let stopped = false;
  let ended = false;
  let paused = false;
  // The request line went out: what was written before waits in pending until then.
  let begun = false;
  const pending: Buffer[] = [];
  const send = (data: Buffer) => {
    if (ended) return;
    if (socket && begun) socket.writable && socket.write(data);
    else pending.push(data);
  };
  const write = (chunk: Uint8Array) => {
    for (let at = 0; at < chunk.byteLength; at += STDIN_FRAME) send(frame(STDIN, chunk.subarray(at, at + STDIN_FRAME)));
  };
  const abort = new AbortController();
  const done = (async (): Promise<ChannelEnd> => {
    const connected = await connect(address, abort.signal);
    if (connected === undefined) {
      if (!stopped) io.stderr(Buffer.from(`toolsExec: the tools container is not answering on ${address}\n`));
      return { code: 127, stopped };
    }
    socket = connected;
    if (stopped) {
      socket.destroy();
      return { code: 1, stopped };
    }
    return new Promise<ChannelEnd>((resolve) => {
      const s = connected;
      let code: number | undefined;
      const begin = (auth: string | undefined) => {
        begun = true;
        s.write(`${JSON.stringify({ ...(auth === undefined ? {} : { auth }), argv: request.argv, cwd: request.cwd, env: request.env })}\n`);
        for (const data of pending.splice(0)) s.write(data);
      };
      // The servers channel (a token): nothing but our nonce goes out until it proves the token.
      const hello = request.token === undefined ? undefined : channelHello();
      const unproven = () => {
        io.stderr(Buffer.from(`toolsExec: the servers channel on ${address} did not prove its token; nothing was sent to it\n`));
        code = 127;
        s.destroy();
      };
      const helloTimer = hello === undefined ? undefined : setTimeout(unproven, HELLO_WAIT_MS);
      s.on(
        "data",
        frameReader(
          (type, payload) => {
            if (stopped) return false;
            if (!begun && hello !== undefined && type !== ERROR) {
              clearTimeout(helloTimer);
              const auth = type === HELLO ? answerHello(request.token!, hello.nonce, payload) : undefined;
              if (auth === undefined) return (unproven(), false);
              begin(auth);
            } else if (type === STDOUT) io.stdout(payload);
            else if (type === STDERR) io.stderr(payload);
            else if (type === ERROR) {
              io.stderr(Buffer.from(`toolsExec: ${payload}\n`));
              code = 127;
            } else if (type === EXIT) {
              code = exitCodeOf(payload);
              if (code === undefined) {
                io.stderr(Buffer.from("toolsExec: the tools container sent an exit status that could not be read\n"));
                code = 125;
              }
            }
          },
          (length) => {
            if (!begun && hello !== undefined) return unproven();
            io.stderr(Buffer.from(`toolsExec: the tools container sent a frame of ${length} bytes, more than the ${MAX_FRAME} the channel carries\n`));
            code = 125;
            s.destroy();
          },
        ),
      );
      s.on("error", () => {});
      s.on("close", () => {
        clearTimeout(helloTimer);
        ended = true;
        if (code === undefined && !stopped) io.stderr(Buffer.from("toolsExec: the tools container closed the channel\n"));
        resolve({ code: code ?? (stopped ? 137 : 125), stopped });
      });
      if (hello === undefined) begin(undefined);
      else s.write(hello.line);
    });
  })();
  if (io.stdin !== undefined) {
    const input = io.stdin;
    if (input instanceof Uint8Array) {
      write(input);
      send(frame(STDIN_END, ""));
    } else {
      void (async () => {
        try {
          for await (const chunk of input) {
            write(chunk);
            // A large file is read as the channel takes it, not into memory first.
            if (socket?.writableNeedDrain) await new Promise((resolve) => socket!.once("drain", resolve).once("close", resolve));
            if (ended) break;
          }
        } catch {}
        send(frame(STDIN_END, ""));
      })();
    }
  }
  return {
    done,
    write,
    end: () => send(frame(STDIN_END, "")),
    signal: (name) => SIGNALS.has(name) && send(frame(SIGNAL, name)),
    stop: () => {
      stopped = true;
      abort.abort();
      socket?.destroy();
    },
    pause: () => {
      paused = true;
      socket?.pause();
    },
    resume: () => {
      if (!paused) return;
      paused = false;
      socket?.resume();
    },
  };
};

// ---------------------------------------------------------------- as an Effect child process

/** Pids no Linux process has (pid_max is at most 2^22): what a handle names a command it did not start here. */
let nextPid = 1 << 22;

const failure = (method: string, description: string) =>
  PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method, description });

/** "pipe" or "ignore" (a string or a config's stream), else undefined: a stream, a sink or "inherit". */
const pipeMode = (option: unknown): "pipe" | "ignore" | undefined => {
  const value = typeof option === "object" && option !== null && "stream" in option ? (option as { stream?: unknown }).stream : option;
  return value === undefined || value === "pipe" ? "pipe" : value === "ignore" ? "ignore" : undefined;
};

/**
 * Whether `command` can run over the channel from here: one command (no pipeline) whose stdin, stdout and stderr
 * are pipes the caller reads and writes through the handle (or ignores), with no extra fds and no shell. A
 * terminal, an inherited stdio, or a stream or sink wired in at spawn still take the client.
 */
export const channelable = (command: ChildProcess.Command): command is ChildProcess.StandardCommand => {
  if (command._tag !== "StandardCommand") return false;
  const o = command.options;
  if (o.shell || (o.additionalFds !== undefined && Object.keys(o.additionalFds).length > 0)) return false;
  return [o.stdin, o.stdout, o.stderr].every((option) => pipeMode(option) !== undefined);
};

/** `command` (channelable) as an Effect child process over the channel: the handle a Node spawn would give. */
export const channelHandle = (address: string, command: ChildProcess.StandardCommand, request: ChannelRequest) =>
  Effect.gen(function* () {
    const o = command.options;
    const stdoutQ = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const stderrQ = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const exit = yield* Deferred.make<ChannelEnd>();
    // What both queues hold that the caller has not read: past UNREAD_MAX the channel waits for it. A command being
    // stopped has its end read on, behind what it still sends, which past UNREAD_MAX is dropped: a Node child that is
    // killed exits whatever its pipes hold.
    let unread = 0;
    let stopping = false;
    const cost = (chunk: Uint8Array) => Math.max(chunk.byteLength, CHUNK_COST);
    const readToEnd = (r: ChannelRun) => {
      stopping = true;
      r.resume();
    };
    const run = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const offer = (queue: Queue.Queue<Uint8Array, Cause.Done>) => (chunk: Buffer) => {
          if (stopping && unread > UNREAD_MAX) return;
          unread += cost(chunk);
          Queue.offerUnsafe(queue, chunk);
          if (!stopping && unread > UNREAD_MAX) r.pause();
        };
        const r = channelRun(address, request, {
          stdout: pipeMode(o.stdout) === "ignore" ? () => {} : offer(stdoutQ),
          stderr: pipeMode(o.stderr) === "ignore" ? () => {} : offer(stderrQ),
          ...(pipeMode(o.stdin) === "ignore" ? { stdin: new Uint8Array(0) } : {}),
        });
        void r.done.then((end) => {
          Queue.endUnsafe(stdoutQ);
          Queue.endUnsafe(stderrQ);
          Deferred.doneUnsafe(exit, Exit.succeed(end));
        });
        return r;
      }),
      // A scope that closes on a running command ends it: SIGTERM to its group, then the group killed.
      (r) =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(exit)) return;
          readToEnd(r);
          r.signal(o.killSignal ?? "SIGTERM");
          yield* Deferred.await(exit).pipe(Effect.timeout("2 seconds"), Effect.ignore);
          r.stop();
        }),
    );
    const stdin = Sink.forEach((chunk: Uint8Array) => Effect.sync(() => run.write(chunk))).pipe(Sink.ensuring(Effect.sync(() => run.end())));
    const read = (chunk: Uint8Array) =>
      Effect.sync(() => {
        unread -= cost(chunk);
        if (unread <= UNREAD_MAX) run.resume();
      });
    const stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.fromQueue(stdoutQ).pipe(Stream.tap(read));
    const stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError> = Stream.fromQueue(stderrQ).pipe(Stream.tap(read));
    const exitCode = Effect.map(Deferred.await(exit), (end) => ChildProcessSpawner.ExitCode(end.code));
    return ChildProcessSpawner.makeHandle({
      pid: ChildProcessSpawner.ProcessId(nextPid++),
      exitCode,
      isRunning: Effect.map(Deferred.isDone(exit), (d) => !d),
      kill: (options) =>
        Effect.gen(function* () {
          readToEnd(run);
          run.signal(options?.killSignal ?? "SIGTERM");
          const waited = yield* Deferred.await(exit).pipe(Effect.timeout(options?.forceKillAfter ?? "5 seconds"), Effect.option);
          if (waited._tag === "None") run.stop();
        }),
      stdin,
      stdout,
      stderr,
      all: Stream.merge(stdout, stderr),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void),
    });
  }).pipe(Effect.mapError(() => failure("spawn", `could not start ${command.command} in the tools container`)));
