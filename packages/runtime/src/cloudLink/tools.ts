// A Cloud computer's tool processes run in its tools container, never beside
// the runtime: the runtime container holds runtime.key and the git proxy
// token, and the checkout's git config, hooks and the agent's own processes
// are the agent's to write. The computers service sets
// CAVEMAN_RUNTIME_TOOLS_ADDRESS; with it every child the runtime starts (git,
// engines, terminals, probes) goes through toolsExec.mjs, except the runtime's
// own node entries. Remote git, which needs the token, runs here on a
// runtime-owned bare mirror that tools only ever hands git bundles to.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { CavemanToolsStream } from "@caveman-app/provider-caveman/server";
import { AgentScope, type AgentScopeShape } from "@caveman-app/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { type ChannelRequest, channelHandle, channelable, channelRun, provesToken } from "./toolsChannel.ts";

export const TOOLS_EXEC = fileURLToPath(new URL("./toolsExec.mjs", import.meta.url));
/** What Claude Agent's shell runs before each command on a Cloud computer (CLAUDE_ENV_FILE): the tools PATH back. */
export const TOOLS_SHELL_ENV = fileURLToPath(new URL("./toolsShellEnv.sh", import.meta.url));

/**
 * The image's own git, claude and codex (Caveman Cloud cloud/runner/code/Dockerfile). On a Cloud computer the
 * runtime starts these by absolute path, with the system directories first on PATH, so a `git` or `claude` that the
 * agent, a postinstall or a setup a snapshot kept left in the tools home (~/.local/bin, mise's shims) never stands
 * in for them. The engines' own commands still get the tools PATH: claude's shell through CLAUDE_ENV_FILE, codex's
 * through its shell_environment_policy.
 */
export const IMAGE_BINARIES: Readonly<Record<string, string>> = { git: "/usr/bin/git", claude: "/usr/local/bin/claude", codex: "/usr/local/bin/codex" };
const SYSTEM_DIRS = ["/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"];
/** `path` with the system directories moved to its front. */
export const systemFirst = (pathValue: string | undefined) => [...SYSTEM_DIRS, ...(pathValue ?? "").split(":").filter((dir) => dir !== "" && !SYSTEM_DIRS.includes(dir))].join(":");

/**
 * `command args` as tools starts it: git, claude and codex under /usr/bin/env with the system directories first on
 * PATH (in argv, which an engine's caller starts the exec client with: neither is a secret), a bare name as the
 * image's binary. A path stays: the runtime resolved it in its own container, which the agent cannot write, or a
 * person set it.
 */
export const pinnedLaunch = (command: string, args: ReadonlyArray<string>, env: NodeJS.ProcessEnv | undefined, base: NodeJS.ProcessEnv): { command: string; args: ReadonlyArray<string> } => {
  const name = path.posix.basename(command);
  if (!Object.hasOwn(IMAGE_BINARIES, name)) return { command, args };
  const image = command.includes("/") ? command : IMAGE_BINARIES[name]!;
  // The PATH the command would have had: tools' own, the same image PATH the runtime has, unless the caller set one.
  const toolsPath = env?.PATH ?? base.PATH ?? "";
  const engine = name === "claude" ? [`CLAUDE_ENV_FILE=${TOOLS_SHELL_ENV}`] : [];
  const policy = name === "codex" ? ["-c", `shell_environment_policy.set.PATH=${JSON.stringify(toolsPath)}`] : [];
  return { command: "/usr/bin/env", args: [`PATH=${systemFirst(toolsPath)}`, ...engine, image, ...policy, ...args] };
};

/** The tools container's exec channel on a Cloud computer (host:port on the pod's loopback), else undefined. */
export const toolsSocket = (env: NodeJS.ProcessEnv = process.env) => env.CAVEMAN_RUNTIME_TOOLS_ADDRESS || undefined;

/**
 * The servers container's exec channel (same toolsExec.mjs, its own uid, no shared process namespace with the
 * tools container), else undefined. Hub-started MCP servers and their keys go there, never to the agent's uid.
 */
export const serversSocket = (env: NodeJS.ProcessEnv = process.env) => env.CAVEMAN_RUNTIME_SERVERS_ADDRESS || undefined;

const probed = new Map<string, { at: number; live: Promise<string | undefined>; proven?: boolean }>();
/** How long a proof holds before the servers channel is asked again; a failed one only briefly (m-p). */
const PROVEN_FOR_MS = 60_000;
export const UNPROVEN_FOR_MS = 3_000;
/**
 * The servers channel when it proves the servers token (CAVEMAN_RUNTIME_SERVERS_TOKEN; toolsExec.mjs's handshake),
 * else undefined: nothing answers (a pod whose servers container predates the token idles and refuses connections),
 * or something that does not hold the token listens there (any process on the pod's loopback could, before the servers
 * container starts or after it stops). A proof is asked again after a minute; a failed one after a few seconds, so one
 * slow answer (a 1 s timeout on a busy pod) never refuses every keyed MCP server for a minute (m-p).
 */
export const liveServersSocket = (env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> => {
  const address = serversSocket(env);
  const token = env.CAVEMAN_RUNTIME_SERVERS_TOKEN;
  if (address === undefined || !token) return Promise.resolve(undefined);
  const known = probed.get(address);
  if (known !== undefined && (known.proven === undefined || Date.now() - known.at < (known.proven ? PROVEN_FOR_MS : UNPROVEN_FOR_MS))) return known.live;
  const entry: { at: number; live: Promise<string | undefined>; proven?: boolean } = { at: Date.now(), live: Promise.resolve(undefined) };
  entry.live = provesToken(address, token, 1_000)
    .catch(() => false)
    .then((ok) => {
    entry.proven = ok;
    entry.at = Date.now();
    return ok ? address : undefined;
  });
  probed.set(address, entry);
  return entry.live;
};

/** Whatever `env` sets beyond the runtime's own environment: what the tool process needs on top of tools' own. */
export function envDelta(env: NodeJS.ProcessEnv | undefined, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const delta: Record<string, string> = {};
  // git's GIT_CONFIG_* entries cross whole: tools adds them to its own (toolsExec.mjs), numbered from 0.
  const gitConfig = env?.GIT_CONFIG_COUNT !== undefined;
  for (const [key, value] of Object.entries(env ?? {})) {
    const whole = gitConfig && /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key);
    if (typeof value !== "string" || (base[key] === value && !whole) || /^CAVEMAN_(RUNTIME|CODE)_|^CAVEMAN_CLOUD_LINK_DIR$/.test(key)) continue;
    // The token never crosses (remote git goes through the mirror below): a git that wanted it fails without it.
    if (/Bearer\s+ccrt_/.test(value)) continue;
    delta[key] = value;
  }
  return delta;
}

/** Carries a tools command's env to the exec client (base64 JSON): any process can read argv, only its uid a process's environment. */
const TOOLS_ENV = "CAVEMAN_RUNTIME_TOOLS_ENV";

/**
 * `command args` as tools runs it (toolsExec.mjs's request): the pinned launch, the env it adds to `base` (the
 * runtime's own environment unless said otherwise), and the servers channel's token when `socket` is that one
 * (never the tools channel: the agent's uid serves that one).
 */
export const toolsRequest = (
  socket: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv | undefined,
  base: NodeJS.ProcessEnv = process.env,
): ChannelRequest => {
  const pinned = pinnedLaunch(command, args, env, base);
  const token = socket === serversSocket() ? process.env.CAVEMAN_RUNTIME_SERVERS_TOKEN : undefined;
  return { argv: [pinned.command, ...pinned.args], cwd, env: envDelta(env, base), ...(token ? { token } : {}) };
};

/**
 * `command args` as a client process starts it in the tools container (`node toolsExec.mjs exec`), for what needs a
 * process here: an engine the SDKs start, a terminal. Without `cwd`, in the directory the client is started in.
 * `env` crosses as what it adds to `base`. No value goes in argv: start the client with `env` added to its
 * environment. A caller that starts it with the command's whole env instead (AgentScope) is covered by the names
 * in --env-keys, which the client reads from its own environment. The runtime's own calls skip the client
 * (toolsChannel.ts).
 */
export const toolsCommand = (
  socket: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv | undefined,
  base: NodeJS.ProcessEnv = process.env,
) => {
  const request = toolsRequest(socket, command, args, cwd ?? "", env, base);
  return {
    command: process.execPath,
    args: ["--disable-sigusr1", TOOLS_EXEC, "exec", "--socket", socket, ...(cwd === undefined ? [] : ["--cwd", cwd]), "--env-keys", JSON.stringify(Object.keys(request.env)), "--", ...request.argv],
    env: { [TOOLS_ENV]: Buffer.from(JSON.stringify(request.env)).toString("base64"), ...(request.token ? { CAVEMAN_RUNTIME_EXEC_TOKEN: request.token } : {}) },
  };
};

/** The runtime's own entries (node running a file of the runtime) stay here; everything else goes to tools. */
const isRuntimeOwn = (command: ChildProcess.StandardCommand) => command.command === process.execPath;

// The tools container runs the real command, so Redacted arguments and env values cross as their values.
const reveal = <A>(value: A | Redacted.Redacted<A>): A => (Redacted.isRedacted(value) ? Redacted.value(value) : value);
const commandArgs = (command: ChildProcess.StandardCommand): ReadonlyArray<string> => command.args.map(reveal);
const commandEnv = (command: ChildProcess.StandardCommand): NodeJS.ProcessEnv | undefined => {
  const own =
    command.options.env === undefined
      ? undefined
      : Object.fromEntries(Object.entries(command.options.env).map(([key, value]) => [key, value === undefined ? undefined : reveal(value)]));
  return command.options.extendEnv === false ? own : { ...process.env, ...own };
};

/**
 * A spawner that runs every child but the runtime's own in the tools container: over the channel from this process
 * when its stdio is piped (git, probes, scripts), else through a client process (a pipeline's sides, an inherited
 * stdio).
 */
export const toolsSpawner = (base: ChildProcessSpawner.ChildProcessSpawner["Service"], socket: string) => {
  const reroute = (command: ChildProcess.Command): ChildProcess.Command => {
    if (command._tag === "PipedCommand") return ChildProcess.pipeTo(reroute(command.left), reroute(command.right), command.options);
    if (isRuntimeOwn(command)) return command;
    const routed = toolsCommand(socket, command.command, commandArgs(command), command.options.cwd ?? process.cwd(), commandEnv(command));
    // The client runs here; its cwd and env are the runtime's, the command's travel in argv and TOOLS_ENV.
    return ChildProcess.make(routed.command, routed.args, { ...command.options, cwd: "/", env: { ...process.env, ...routed.env }, extendEnv: false });
  };
  return ChildProcessSpawner.make((command) => {
    if (command._tag === "StandardCommand" && !isRuntimeOwn(command) && channelable(command)) {
      return channelHandle(socket, command, toolsRequest(socket, command.command, commandArgs(command), command.options.cwd ?? process.cwd(), commandEnv(command)));
    }
    return base.spawn(reroute(command));
  });
};

export const spawnerLayer = (socket: string) =>
  Layer.effect(
    ChildProcessSpawner.ChildProcessSpawner,
    Effect.map(Effect.service(ChildProcessSpawner.ChildProcessSpawner), (base) => toolsSpawner(base, socket)),
  );

/** Agents and terminals start in tools; there is no systemd scope there to ask about. */
export const agentScope = (socket: string): AgentScopeShape => ({
  // The caller starts the client with `env` itself, so the values are in its environment already.
  wrap: ({ command, args, env }) => Effect.succeed({ command: process.execPath, args: toolsCommand(socket, command, args, undefined, env).args }),
  oomKilled: () => Effect.succeed(false),
  stop: () => Effect.void,
  clear: () => Effect.void,
});
export const agentScopeLayer = (socket: string) => Layer.succeed(AgentScope, agentScope(socket));

// ------------------------------------------------------- the runtime's own git

/**
 * The email git falls back to in the runtime's own git (the clone, fetches through the mirror, checkouts, worktrees,
 * work-in-progress packs): the `EMAIL` variable, which git reads below every identity anyone set (GIT_AUTHOR_* and
 * GIT_COMMITTER_* in a command's environment, user.email in any config or `-c`) and above its last resort,
 * `<user>@<this machine's name, as its resolver knows it>`. That last resort asks the resolver for the hostname each
 * time git writes a reflog entry (a fetch into the checkout, `checkout -B`, `worktree add`), and on a Cloud computer
 * whose name nothing resolved each such command waited 10 s on it. Measured in the computer image, the hostname out of
 * /etc/hosts and no resolver answering: `git checkout -q -B x HEAD` takes 10 028 ms, 5 ms with EMAIL set.
 * A fallback, never an override: a person's or an agent's commit is by their own settings, as before.
 */
export const RUNTIME_GIT_EMAIL = "code@caveman.so";

/**
 * The fallback as a tools command's env, which goes on top of tools' own environment. There it does replace an `EMAIL`
 * tools was started with, which the runtime cannot read: the runtime's own git writes its reflog entries by this
 * address, and every identity git reads above `EMAIL` still wins.
 */
const GIT_FALLBACK: Readonly<Record<string, string>> = { EMAIL: RUNTIME_GIT_EMAIL };

/** `env` for a git of the runtime's own: the fallback email in it, unless the command or this process's own environment names one. */
export const gitEnv = (env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...env, EMAIL: env?.EMAIL || process.env.EMAIL || RUNTIME_GIT_EMAIL });

/** The git command in `args`, past git's own options (`-c name=value`, `-C dir`, `--git-dir dir`). */
export const gitVerb = (args: ReadonlyArray<string>): string | undefined => {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (["-c", "-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(arg)) i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return undefined;
};

/**
 * Whether `args` is git of the runtime's own, which gets the fallback email (gitEnv). `git commit` is not: the
 * session-protocol's two (a new project's first commit, the Cloud setup's pull request) are the person's, by their
 * settings or git's own guess, and a made-up email there would be a made-up author.
 */
export const isPlumbing = (args: ReadonlyArray<string>) => gitVerb(args) !== "commit";

// ---------------------------------------------------------------- remote git

/** git in the runtime's own mirror, with the fallback email (gitEnv). */
const run = (file: string, args: ReadonlyArray<string>, options: { cwd?: string; env?: NodeJS.ProcessEnv; stdin?: string } = {}) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = execFile(file, args, { cwd: options.cwd, env: gitEnv(options.env ?? process.env), maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });

/** The most of a stream a call into tools keeps, as run()'s maxBuffer. */
const MAX_BUFFER = 64 * 1024 * 1024;

/**
 * A command's output kept up to `max` bytes, copied into one buffer as it comes: whatever holds the tools address
 * chooses how it is cut into frames, and a short chunk kept as a Buffer of its own costs far more than its bytes.
 * `take` answers whether the chunk fit whole; `bytes` is a buffer of its own, never a view of the uninitialized room
 * grown ahead.
 */
const kept = (max: number) => {
  let bytes = Buffer.alloc(0);
  let size = 0;
  return {
    take: (chunk: Uint8Array) => {
      const fits = Math.min(chunk.byteLength, max - size);
      if (size + fits > bytes.length) {
        const grown = Buffer.allocUnsafe(Math.min(max, Math.max(size + fits, 2 * bytes.length, 64 * 1024)));
        bytes.copy(grown, 0, 0, size);
        bytes = grown;
      }
      bytes.set(chunk.subarray(0, fits), size);
      size += fits;
      return fits === chunk.byteLength;
    },
    bytes: () => (size === bytes.length ? bytes : Buffer.from(bytes.subarray(0, size))),
  };
};

/**
 * `argv` in tools over the channel, its stderr (and its stdout, unless `io.stdout` takes it) kept up to MAX_BUFFER each.
 * A command that writes more is stopped, as run()'s maxBuffer stops one, and its stderr says so: whatever holds the tools
 * address can stream without end.
 */
const keptRun = async (
  socket: string,
  cwd: string,
  argv: ReadonlyArray<string>,
  env: Record<string, string>,
  io: { readonly stdout?: (chunk: Buffer) => void; readonly stdin: Uint8Array | AsyncIterable<Uint8Array> },
) => {
  const out = kept(MAX_BUFFER);
  const err = kept(MAX_BUFFER);
  let over: "stdout" | "stderr" | undefined;
  const stop = (stream: "stdout" | "stderr") => {
    over ??= stream;
    run.stop();
  };
  const run = channelRun(socket, toolsRequest(socket, argv[0]!, argv.slice(1), cwd, env, {}), {
    stdout: io.stdout ?? ((chunk) => out.take(chunk) || stop("stdout")),
    stderr: (chunk) => err.take(chunk) || stop("stderr"),
    stdin: io.stdin,
  });
  const end = await run.done;
  const said = over === undefined ? "" : `toolsExec: ${argv[0]} wrote more than ${MAX_BUFFER} bytes to its ${over}; it was stopped\n`;
  return { code: end.code, stdout: out.bytes(), stderr: `${err.bytes().toString("utf8")}${said}` };
};

/** `argv` in the tools container, in `cwd`, with exactly `env` on top of tools' own environment. */
export const toolsRun = async (socket: string, cwd: string, argv: ReadonlyArray<string>, env: Record<string, string> = {}) => {
  const ran = await keptRun(socket, cwd, argv, env, { stdin: new Uint8Array(0) });
  return { code: ran.code, stdout: ran.stdout.toString("utf8"), stderr: ran.stderr };
};

/**
 * Starts `argv` in the tools container, in `cwd`, with exactly `env` on top of tools' own environment, and leaves it
 * running: what it writes as it comes, its end, and a way to end it with everything it started. It ends with the
 * runtime too: tools kills the process group of a command whose channel closed (toolsExec.mjs).
 */
export const toolsStart = (socket: string, cwd: string, argv: ReadonlyArray<string>, env: Record<string, string>, onOutput: (chunk: Buffer) => void) => {
  const run = channelRun(socket, toolsRequest(socket, argv[0]!, argv.slice(1), cwd, env, {}), { stdout: onOutput, stderr: onOutput, stdin: new Uint8Array(0) });
  return { done: run.done, stop: run.stop };
};

/** git in the tools container, in `cwd`, with the fallback email (gitEnv). */
export const toolsGit = (socket: string, cwd: string, args: ReadonlyArray<string>) => toolsRun(socket, cwd, ["git", ...args], { ...GIT_FALLBACK });

/**
 * A temporary git index for git in the tools container: a directory mktemp makes there, `seed` (the
 * checkout's own index) copied in as `index` with its mtime when it exists, removed there when the
 * scope closes. The runtime never opens, stats or removes either: on a Cloud computer the checkout
 * and its .git are the agent's to write, and the runtime's TMPDIR is not tools'.
 */
export const toolsIndex = (socket: string, seed?: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const script = 'd=$(mktemp -d) || exit 1; if [ -n "$1" ] && [ -f "$1" ]; then cp -p -- "$1" "$d/index" || exit 1; echo "$d seeded"; else echo "$d"; fi';
        const made = await toolsRun(socket, "/", ["sh", "-c", script, "sh", seed ?? ""]);
        const [dir, seeded] = made.stdout.trim().split(" ");
        if (made.code !== 0 || !dir?.startsWith("/")) throw new Error(`no temporary index in the tools container: ${made.stderr.trim().slice(0, 300)}`);
        return { dir, path: `${dir}/index`, seeded: seeded === "seeded" };
      },
      catch: (error) => (error instanceof Error ? error : new Error(String(error))),
    }),
    ({ dir }) => Effect.promise(() => toolsRun(socket, "/", ["rm", "-rf", "--", dir])),
  );

/** Runs `command` in tools with stdout going to `file` (here); a git it runs has the fallback email (gitEnv). */
export const toolsToFile = async (socket: string, cwd: string, argv: ReadonlyArray<string>, file: string) => {
  const out = fs.openSync(file, "w", 0o600);
  try {
    const ran = await keptRun(socket, cwd, argv, { ...GIT_FALLBACK }, { stdout: (chunk) => fs.writeSync(out, chunk), stdin: new Uint8Array(0) });
    return { code: ran.code, stderr: ran.stderr };
  } finally {
    fs.closeSync(out);
  }
};

/** Runs `command` in tools with `file` (here) as its stdin; a git it runs has the fallback email (gitEnv). */
const toolsFromFile = async (socket: string, cwd: string, argv: ReadonlyArray<string>, file: string) => {
  const ran = await keptRun(socket, cwd, argv, { ...GIT_FALLBACK }, { stdout: () => {}, stdin: fs.createReadStream(file) });
  return { code: ran.code, stderr: ran.stderr };
};

const GITHUB = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+?(\.git)?$/;

/** Each mirror's clearing of what earlier processes staged (clearStaged), which every call of this process awaits. */
const cleared = new Map<string, Promise<void>>();
/** Mirrors being made now (`git init --bare`), by directory. */
const making = new Map<string, Promise<void>>();

/**
 * Removes every staged ref and bundle in mirror `dir`: those of a runtime that ended mid-call (killed, its pod stopped),
 * which would pin their objects for good, and an older runtime's single refs/caveman/push and refs/caveman/fetch,
 * which would block the per-call names. Only before this process stages anything: one call's clearing never takes
 * another's staged ref.
 */
const clearStaged = async (dir: string) => {
  const listed = await run("git", ["for-each-ref", "--format=%(refname)", "refs/caveman/push", "refs/caveman/fetch"], { cwd: dir });
  const refs = listed.stdout.split("\n").filter((ref) => ref !== "");
  if (refs.length > 0) await run("git", ["update-ref", "--stdin"], { cwd: dir, stdin: refs.map((ref) => `delete ${ref}\n`).join("") });
  for (const file of fs.readdirSync(dir)) if (/^(push|fetch)-.+\.bundle$/.test(file)) fs.rmSync(path.join(dir, file), { force: true });
};

/**
 * A runtime-owned bare repository outside the checkout: git here only ever reads bundles and talks to the proxy. Each
 * push or fetch stages under its own refs/caveman/<push|fetch>/<uuid> and bundle, removed when it is done; what earlier
 * processes left goes before this process's first call stages anything.
 */
const mirror = async (stateDir: string) => {
  const dir = path.join(stateDir, "git-mirror");
  // One init, which every call that came meanwhile waits for: a clone asks the default branch's name and fetches at once.
  let made = making.get(dir);
  if (made === undefined && !fs.existsSync(path.join(dir, "HEAD"))) {
    made = (async () => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const init = await run("git", ["init", "--bare", "-q", dir]);
      if (init.code !== 0) throw new Error(`git mirror: ${init.stderr.trim()}`);
    })().finally(() => making.delete(dir));
    making.set(dir, made);
  }
  await made;
  let clearing = cleared.get(dir);
  if (clearing === undefined) cleared.set(dir, (clearing = clearStaged(dir)));
  await clearing;
  return dir;
};

/** Removes a call's staged ref; a failed call may not have made it. */
const unstage = (dir: string, ref: string) => run("git", ["update-ref", "-d", ref], { cwd: dir });

/** origin's URL, as tools reports it: a github.com https URL or nothing (the proxy speaks GitHub only). */
const originUrl = async (socket: string, worktree: string) => {
  const url = (await toolsGit(socket, worktree, ["remote", "get-url", "origin"])).stdout.trim();
  if (!GITHUB.test(url)) throw new Error(`origin is not a github.com https URL the git proxy serves (${url.slice(0, 200) || "none"})`);
  return url;
};

const REF = /^(HEAD|refs\/[A-Za-z0-9._/-]+)$/;
const COMMIT_ID = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export interface RemoteGitResult {
  readonly code: number;
  readonly stderr: string;
}

/**
 * Pushes `source` from the checkout to origin's `target`: tools bundles the
 * ref, the mirror takes the bundle, and the mirror pushes with the proxy env.
 * ponytail: the whole history every push; `--not` the mirror's refs when big repos make that slow.
 */
export async function pushViaMirror(input: {
  socket: string;
  stateDir: string;
  worktree: string;
  source: string;
  target: string;
  force?: boolean;
  proxyEnv: Record<string, string>;
}): Promise<RemoteGitResult> {
  if (!REF.test(input.source) || !REF.test(input.target)) throw new Error("bad ref");
  const dir = await mirror(input.stateDir);
  const url = await originUrl(input.socket, input.worktree);
  // Its own staged ref and bundle: two chats pushing at once never send each other's commits.
  const id = randomUUID();
  const staged = `refs/caveman/push/${id}`;
  const bundle = path.join(dir, `push-${id}.bundle`);
  try {
    const made = await toolsToFile(input.socket, input.worktree, ["git", "bundle", "create", "-", input.source], bundle);
    if (made.code !== 0) return made;
    const taken = await run("git", ["fetch", "-q", "--force", bundle, `${input.source}:${staged}`], { cwd: dir });
    if (taken.code !== 0) return taken;
    return await run("git", ["push", ...(input.force ? ["--force"] : []), url, `${staged}:${input.target}`], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...input.proxyEnv },
    });
  } finally {
    fs.rmSync(bundle, { force: true });
    await unstage(dir, staged);
  }
}

/** `https://github.com/<owner>/<name>.git` for a GitHub repository URL, else undefined (the proxy speaks GitHub only). */
export const githubCloneUrl = (url: string): string | undefined => {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? `https://github.com/${m[1]}/${m[2]}.git` : undefined;
};

/**
 * What git's stderr says went wrong, as one clause for a person: its last `fatal:` line (else `remote:`), without the
 * URL it quotes (the proxy's, which means nothing to them) and past its first sentence. When the `fatal:` line only
 * names an HTTP status ("The requested URL returned error: 403"), the server's own `remote:` lines say why, whole:
 * Caveman's git proxy refuses that way (no GitHub access, a repository the GitHub App does not cover).
 */
export const gitSaid = (stderr: string): string | undefined => {
  const lines = stderr.split("\n").map((line) => line.trim());
  const fatal = lines.filter((l) => l.startsWith("fatal: ")).at(-1);
  const remote = lines.filter((l) => l.startsWith("remote: ")).map((l) => l.slice("remote: ".length).trim()).filter((l) => l !== "");
  if (fatal !== undefined && /The requested URL returned error: \d{3}/.test(fatal) && remote.length > 0) return remote.join(" ").replace(/\.+$/, "");
  const line = fatal ?? lines.filter((l) => l.startsWith("remote: ")).at(-1);
  const said = line?.replace(/^(fatal|remote): /, "").replace(/\s*(?:\b(?:for|to|from|at) )?'[a-z]+:\/\/[^']*'/gi, "").split(/\.(\s|$)/)[0]?.trim();
  return said === undefined || said === "" ? undefined : said;
};

/**
 * The branch a GitHub repository's HEAD names and the commit that branch was at, one answer of one ask, through the
 * proxy from the runtime's mirror (never the checkout).
 */
export async function remoteDefaultBranch(input: { stateDir: string; url: string; proxyEnv: Record<string, string> }): Promise<{ readonly branch: string; readonly commit: string | undefined }> {
  if (githubCloneUrl(input.url) === undefined) throw new Error("not a github.com repository URL");
  const dir = await mirror(input.stateDir);
  const out = await run("git", ["ls-remote", "--symref", input.url, "HEAD"], { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...input.proxyEnv } });
  if (out.code !== 0) {
    throw new Error(gitSaid(out.stderr) ?? `git ls-remote exited ${out.code}`);
  }
  const branch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(out.stdout)?.[1];
  if (branch === undefined) throw new Error("the repository has no default branch yet");
  return { branch, commit: /^([0-9a-f]{40,64})\tHEAD$/m.exec(out.stdout)?.[1] };
}

/**
 * Branches of origin (or commits, by id) as the mirror fetched and bundled them: the part of a fetch that waits on the
 * network, held in the runtime's own state, nothing of it in any checkout. A checkout takes it (takeStaged,
 * cloneStaged); `drop` removes it, taken or not.
 */
export interface StagedFetch {
  readonly url: string;
  /** Each source as asked for, the mirror's own ref that holds it (the name a checkout fetches it by), and the commit it fetched. */
  readonly refs: ReadonlyArray<{ readonly source: string; readonly staged: string; readonly commit: string }>;
  readonly bundle: string;
  readonly drop: () => Promise<void>;
}

/**
 * Fetches origin's `sources` through the proxy into the mirror, as one fetch and one bundle. Without `staged` in the
 * answer the fetch failed, and nothing is left staged.
 */
export async function stageFetch(input: { stateDir: string; url: string; sources: ReadonlyArray<string>; proxyEnv: Record<string, string> }): Promise<RemoteGitResult & { readonly staged?: StagedFetch }> {
  // A branch, or one commit by its id (one a force-push took off GitHub's branches, which GitHub still hands out by id).
  if (input.sources.length === 0 || input.sources.some((source) => !(REF.test(source) || COMMIT_ID.test(source)))) throw new Error("bad ref");
  const dir = await mirror(input.stateDir);
  // Its own staged refs and bundle: two chats fetching at once never take each other's commits.
  const id = randomUUID();
  const names = input.sources.map((source, i) => ({ source, staged: `refs/caveman/fetch/${id}${i === 0 ? "" : `-${i}`}` }));
  const bundle = path.join(dir, `fetch-${id}.bundle`);
  const drop = async () => {
    fs.rmSync(bundle, { force: true });
    for (const ref of names) await unstage(dir, ref.staged);
  };
  try {
    const fetched = await run("git", ["fetch", "-q", "--force", input.url, ...names.map((ref) => `${ref.source}:${ref.staged}`)], {
      cwd: dir,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...input.proxyEnv },
    });
    const made = fetched.code !== 0 ? fetched : await run("git", ["bundle", "create", "-q", bundle, ...names.map((ref) => ref.staged)], { cwd: dir });
    const read = made.code !== 0 ? made : await run("git", ["rev-parse", ...names.map((ref) => `${ref.staged}^{commit}`)], { cwd: dir });
    const commits = read.stdout.trim().split("\n");
    if (read.code !== 0 || commits.length !== names.length) {
      await drop();
      return { code: read.code || 1, stderr: read.stderr };
    }
    return { code: 0, stderr: "", staged: { url: input.url, refs: names.map((ref, i) => ({ ...ref, commit: commits[i]! })), bundle, drop } };
  } catch (error) {
    await drop();
    throw error;
  }
}

/** A staged fetch into the checkout at `worktree`, each source into its target: tools writes the bundle to its own temp file, then fetches from it. */
const takeStaged = (socket: string, worktree: string, staged: StagedFetch, targets: ReadonlyArray<string>): Promise<RemoteGitResult> => {
  if (targets.length !== staged.refs.length || targets.some((target) => !REF.test(target))) throw new Error("bad ref");
  const script = 'f=$(mktemp) && cat > "$f" && git fetch -q --force "$f" "$@"; s=$?; rm -f "$f"; exit $s';
  return toolsFromFile(socket, worktree, ["sh", "-c", script, "sh", ...staged.refs.map((ref, i) => `${ref.staged}:${targets[i]}`)], staged.bundle);
};

/** Fetches origin's `source` into the checkout's `target`: the mirror fetches through the proxy, tools takes a bundle of it. */
export async function fetchViaMirror(input: {
  socket: string;
  stateDir: string;
  worktree: string;
  source: string;
  target: string;
  proxyEnv: Record<string, string>;
}): Promise<RemoteGitResult> {
  if (!(REF.test(input.source) || COMMIT_ID.test(input.source)) || !REF.test(input.target)) throw new Error("bad ref");
  const url = await originUrl(input.socket, input.worktree);
  const fetched = await stageFetch({ stateDir: input.stateDir, url, sources: [input.source], proxyEnv: input.proxyEnv });
  if (fetched.staged === undefined) return { code: fetched.code, stderr: fetched.stderr };
  try {
    return await takeStaged(input.socket, input.worktree, fetched.staged, [input.target]);
  } finally {
    await fetched.staged.drop();
  }
}

/**
 * cloneStaged's one tools command, the bundle on its stdin: the default branch ($1), origin's URL ($2), then a refspec
 * for each staged branch into refs/remotes/origin/. Each step that fails ends it with its own exit code (CLONE_STEPS).
 * The image's git first, as for every git the runtime starts there (pinnedLaunch): never one left in the tools home.
 */
const CLONE_SCRIPT = [
  `PATH="${SYSTEM_DIRS.join(":")}:$PATH"; export PATH`,
  "branch=$1; url=$2; shift 2",
  "f=$(mktemp) || exit 20",
  'step() { n=$1; shift; "$@" || { rm -f "$f"; exit "$n"; }; }',
  'step 20 sh -c \'cat > "$1"\' sh "$f"',
  'step 21 git init -q -b "$branch"',
  'step 22 git remote add origin "$url"',
  'step 23 git fetch -q --force "$f" "$@"',
  'for spec in "$@"; do name=${spec#*:refs/remotes/origin/}; [ "$name" = "$branch" ] || step 24 git branch -f "$name" "refs/remotes/origin/$name"; done',
  'step 25 git symbolic-ref refs/remotes/origin/HEAD "refs/remotes/origin/$branch"',
  'step 26 git checkout -q -B "$branch" "refs/remotes/origin/$branch"',
  'rm -f "$f"',
].join("\n");
const CLONE_STEPS: Readonly<Record<number, string>> = { 20: "the fetched branches could not be written there", 21: "git init failed", 22: "git remote failed", 23: "git fetch failed", 24: "git branch failed", 25: "git symbolic-ref failed", 26: "git checkout failed" };

/**
 * A staged fetch as a new repository in the empty folder `root`, in one tools command: origin named, each of
 * `branches` (a staged ref and the branch it is, the default `branch` among them) as refs/remotes/origin/<branch>, a
 * local branch for each beside the default, and the default checked out. `failed`: which step, when one did.
 */
export const cloneStaged = async (
  socket: string,
  root: string,
  staged: StagedFetch,
  branch: string,
  branches: ReadonlyArray<{ readonly staged: string; readonly branch: string }>,
): Promise<RemoteGitResult & { readonly failed?: string }> => {
  const specs = branches.map((one) => `${one.staged}:refs/remotes/origin/${one.branch}`);
  const known = branches.every((one) => staged.refs.some((ref) => ref.staged === one.staged) && REF.test(`refs/remotes/origin/${one.branch}`));
  if (!known || new Set(branches.map((one) => one.branch)).size !== branches.length || !branches.some((one) => one.branch === branch)) throw new Error("bad ref");
  const ran = await toolsFromFile(socket, root, ["sh", "-c", CLONE_SCRIPT, "sh", branch, staged.url, ...specs], staged.bundle);
  return ran.code === 0 ? ran : { ...ran, failed: CLONE_STEPS[ran.code] ?? `the clone exited ${ran.code}` };
};

/** The runtime's mirror made ahead of its first use (a new computer's first clone): `git init --bare`, and what an earlier process staged cleared. */
export const warmMirror = (stateDir: string): Promise<void> => mirror(stateDir).then(
  () => undefined,
  () => undefined,
);

/**
 * `argv` in `cwd` with `stdin`, its stdout as bytes (git bundles are binary): in the tools container when `socket` is
 * set (a Cloud computer), else here. The runtime's own commands only (git, a script around git, a file read): a git
 * among them has the fallback email (gitEnv).
 */
export const runBytes = (socket: string | undefined, cwd: string, argv: ReadonlyArray<string>, stdin?: Uint8Array): Promise<{ readonly code: number; readonly stdout: Buffer; readonly stderr: string }> =>
  socket !== undefined
    ? runBuffered(socket, cwd, argv, { env: { ...GIT_FALLBACK }, ...(stdin === undefined ? {} : { stdin }) }).then((r) => ({ code: r.code ?? 1, stdout: r.stdout, stderr: r.stderr }))
    : new Promise((resolve) => {
        const child = spawn(argv[0]!, argv.slice(1), { cwd, env: gitEnv(process.env), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const out: Array<Buffer> = [];
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.on("error", (error) => resolve({ code: 1, stdout: Buffer.alloc(0), stderr: error.message }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout: Buffer.concat(out), stderr }));
        child.stdin.on("error", () => {}); // a command that never reads its stdin
        child.stdin.end(stdin ?? Buffer.alloc(0));
      });

/**
 * Fetches `ref` from a git bundle's bytes into `ref` of the repository at `cwd`: through a temp file, in the tools
 * container when `socket` is set (a Cloud computer), else here in Node, where no POSIX shell need exist (Windows).
 */
export const fetchBundle = async (socket: string | undefined, cwd: string, ref: string, bytes: Uint8Array): Promise<{ readonly code: number; readonly stderr: string }> => {
  if (socket !== undefined) {
    const script = 'f=$(mktemp) && cat > "$f" && git fetch -q --force "$f" "$1:$1"; s=$?; rm -f "$f"; exit $s';
    return runBytes(socket, cwd, ["sh", "-c", script, "sh", ref], bytes);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-wip-"));
  try {
    const file = path.join(dir, "wip.bundle");
    fs.writeFileSync(file, bytes);
    return await runBytes(undefined, cwd, ["git", "fetch", "-q", "--force", file, `${ref}:${ref}`]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

/**
 * A git bundle's objects into the repository at `cwd`, no ref set (the caller sets what it trusts): through a temp
 * file, in the tools container when `socket` is set, else here in Node. It fails when the repository lacks a commit the
 * bundle builds on.
 */
export const unbundle = async (socket: string | undefined, cwd: string, bytes: Uint8Array): Promise<{ readonly code: number; readonly stderr: string }> => {
  if (socket !== undefined) {
    const script = 'f=$(mktemp) && cat > "$f" && git bundle unbundle "$f" >/dev/null; s=$?; rm -f "$f"; exit $s';
    return runBytes(socket, cwd, ["sh", "-c", script, "sh"], bytes);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-checkpoints-"));
  try {
    const file = path.join(dir, "checkpoints.bundle");
    fs.writeFileSync(file, bytes);
    return await runBytes(undefined, cwd, ["git", "bundle", "unbundle", file]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

// ------------------------------------------------------ the Caveman engine's tools

interface BufferedRun {
  readonly stdout: Buffer;
  readonly stderr: string;
  readonly code: number | null;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly startFailed?: boolean;
}

/** `argv` in tools with `stdin`, its output capped at `maxBytes` each; killed at `timeoutMs` or on `signal`. */
const runBuffered = (
  socket: string,
  cwd: string,
  argv: ReadonlyArray<string>,
  options: { env?: Record<string, string>; stdin?: Uint8Array; timeoutMs?: number; maxBytes?: number; signal?: AbortSignal } = {},
) =>
  new Promise<BufferedRun>((resolve) => {
    const max = options.maxBytes ?? MAX_BUFFER;
    let truncated = false;
    let timedOut = false;
    const out = kept(max);
    const err = kept(max);
    const take = (into: ReturnType<typeof kept>) => (chunk: Buffer) => {
      if (!into.take(chunk)) truncated = true;
    };
    const run = channelRun(socket, toolsRequest(socket, argv[0]!, argv.slice(1), cwd, options.env ?? {}, {}), { stdout: take(out), stderr: take(err), stdin: options.stdin ?? new Uint8Array(0) });
    // Ending the call ends the command's whole process group, as killing its client did.
    const kill = () => run.stop();
    const timer = options.timeoutMs ? setTimeout(() => ((timedOut = true), kill()), options.timeoutMs) : undefined;
    options.signal?.addEventListener("abort", kill, { once: true });
    void run.done.then((end) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      resolve({ stdout: out.bytes(), stderr: err.bytes().toString("utf8"), code: end.stopped ? null : end.code, timedOut, truncated });
    });
  });

/**
 * The Caveman engine's execution backend on a Cloud computer (the SDK's ExecutionBackend):
 * shell commands, file reads and file writes all run in the tools container as its uid, so the
 * engine's tools never touch the runtime's Cloud key. Paths are the tools container's (the same
 * /workspace); what tools may reach is the containment.
 */
export const toolsExecutionBackend = (socket: string) => ({
  id: "caveman-cloud-tools",
  exec: async (request: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly maxOutputBytes: number;
    readonly signal?: AbortSignal;
  }) => {
    const run = await runBuffered(socket, request.cwd, [request.command, ...request.args], {
      env: { ...request.env },
      timeoutMs: request.timeoutMs,
      maxBytes: request.maxOutputBytes,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return { stdout: run.stdout.toString("utf8"), stderr: run.stderr, code: run.code, timedOut: run.timedOut, truncated: run.truncated, ...(run.startFailed ? { startFailed: true } : {}) };
  },
  readFile: async (file: string, options?: { maxBytes?: number }) => {
    const read = options?.maxBytes === undefined ? 'exec cat -- "$1"' : `exec head -c ${Math.max(0, Math.floor(options.maxBytes))} -- "$1"`;
    const run = await runBuffered(socket, "/", ["sh", "-c", `test -f "$1" || exit 66; ${read}`, "sh", file]);
    if (run.code === 66) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${file}'`), { code: "ENOENT" });
    if (run.code !== 0) throw new Error(`could not read ${file} in the tools container: ${run.stderr.trim().slice(0, 300)}`);
    return new Uint8Array(run.stdout);
  },
  writeFile: async (file: string, data: Uint8Array) => {
    const run = await runBuffered(socket, "/", ["sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", file], { stdin: data });
    if (run.code !== 0) throw new Error(`could not write ${file} in the tools container: ${run.stderr.trim().slice(0, 300)}`);
  },
});

/**
 * The Caveman harness's commands on a Cloud computer (provider-caveman toolsEnv.ts): `argv` in tools as its uid, in
 * a process group of its own, its output as it is written. stop() ends the group, as an abort of a buffered call does.
 */
export const toolsStream =
  (socket: string): CavemanToolsStream =>
  (request, io) => {
    const run = channelRun(socket, toolsRequest(socket, request.argv[0]!, request.argv.slice(1), request.cwd, { ...request.env }, {}), {
      stdout: io.stdout,
      stderr: io.stderr,
      stdin: request.stdin ?? new Uint8Array(0),
    });
    return { done: run.done, stop: run.stop };
  };
