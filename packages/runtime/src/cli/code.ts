// `caveman code` runs `<runtime>/node <runtime>/bin.mjs code [attach [session]]`.
// bin.ts dispatches here before the Effect CLI loads, so this module is plain
// Node and owns its signals.
//
// - `code`: attach to the runtime that owns the Caveman Code home; else, when
//   this is the desktop app's bundled runtime and that app shows this home,
//   open the app (it runs and owns the runtime); else run the runtime in the
//   foreground until Ctrl-C. Then open a client: the desktop app when it shows
//   this home, else a browser link (printed only to a terminal: it carries the
//   token, in the #fragment so no server or log ever sees it).
// - `code attach [session]`: one session as text; each typed line is a turn.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";

import type { SessionEvent, Workspace } from "@caveman-app/session-protocol";
import { connect } from "@caveman-app/session-protocol/client";
import { killProcessTree } from "@caveman-app/shared/processTree";
import { discoverRuntime, runtimeTokenPath, type PublishedRuntime } from "@caveman-app/shared/runtimeDiscovery";

const APP = "Caveman Code.app";
const USAGE = "usage: caveman code\n       caveman code attach [session]\n       caveman code mcp [--name <label>] [--at-most read|supervised]";
/** SERVER_EXIT_CODE_STATE_DIR_OWNED: another runtime owns the home. */
const STATE_DIR_OWNED = 78;
/** How long `attach` waits for a runtime that went away to come back. */
const GONE_MS = 5_000;

type Out = Pick<NodeJS.WriteStream, "write"> & { readonly isTTY?: boolean };

/** The runtime's home, resolved as resolveBaseDir does: CAVEMAN_CODE_HOME, else ~/.caveman-code. */
export function codeHome(env: NodeJS.ProcessEnv = process.env): string {
  const set = env.CAVEMAN_CODE_HOME?.trim();
  if (!set) return path.join(os.homedir(), ".caveman-code");
  return path.resolve(set === "~" ? os.homedir() : set.replace(/^~(?=[/\\])/, os.homedir()));
}

const within = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms);
    promise.then(
      (value) => (clearTimeout(timer), resolve(value)),
      (error: unknown) => (clearTimeout(timer), reject(error)),
    );
  });

/** The published runtime, when it also answers engine.list on its token. */
export async function liveRuntime(home: string): Promise<PublishedRuntime | undefined> {
  const found = discoverRuntime(home);
  if (found === undefined) return undefined;
  const client = connect(found.url, found.token);
  try {
    await within(client.call("engine.list", {}), 5_000);
    return found;
  } catch {
    return undefined;
  } finally {
    client.close();
  }
}

async function waitLive(home: string, pid: number | undefined, gone: () => boolean, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !gone()) {
    const live = await liveRuntime(home);
    if (live !== undefined && (pid === undefined || live.pid === pid)) return live;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

export interface DesktopFacts {
  readonly platform: NodeJS.Platform;
  /** The logged-in user's home (os.userInfo ignores a HOME override): the packaged app runs on <it>/.caveman-code. */
  readonly userHome: string;
  readonly installed: ReadonlyArray<string>;
}

const desktopFacts = (): DesktopFacts => ({
  platform: process.platform,
  userHome: os.userInfo().homedir,
  // Only a Mac has these folders, and only there does `caveman code` open the app (desktopApp).
  installed:
    process.platform === "darwin"
      ? [path.join("/Applications", APP), path.join(os.homedir(), "Applications", APP)].filter((app) => fs.existsSync(app))
      : [],
});

/** The installed desktop app when it would show the runtime of `home`. */
export function desktopApp(home: string, facts: DesktopFacts = desktopFacts()): string | undefined {
  if (facts.platform !== "darwin" || home !== path.join(facts.userHome, ".caveman-code")) return undefined;
  return facts.installed[0];
}

/** The app this runtime was bundled in (<app>/Contents/Resources/runtime/bin.mjs), if any. */
export const bundledIn = (entry: string): string | undefined =>
  /^(.*\.app)\/Contents\/Resources\/runtime\/bin\.mjs$/.exec(entry)?.[1];

/** What apps/web takes: the runtime in the query, the token in the fragment, which never reaches a server. */
export function clientLink(live: PublishedRuntime): string {
  const url = new URL(live.origin);
  url.pathname = "/";
  url.searchParams.set("runtime", live.url);
  url.hash = new URLSearchParams([["token", live.token]]).toString();
  return url.toString();
}

const openApp = (app: string) => spawnSync("/usr/bin/open", ["-a", app], { stdio: "ignore" });

async function openClient(live: PublishedRuntime, home: string, out: Out, facts: DesktopFacts) {
  const app = desktopApp(home, facts);
  if (app !== undefined) {
    openApp(app);
    out.write(`opened ${path.basename(app, ".app")} on runtime pid ${live.pid}\n`);
    return;
  }
  if (!out.isTTY) {
    out.write("client link not printed: stdout is not a terminal, and the link carries the runtime's token\n");
    return;
  }
  out.write(`open: ${clientLink(live)}\n`);
  // node:http, not fetch: a proxy-aware fetch could send this through HTTP_PROXY.
  const served = await new Promise<boolean>((resolve) =>
    http.get(live.origin, (response) => (response.resume(), resolve(response.statusCode === 200))).on("error", () => resolve(false)),
  );
  if (!served) out.write("this runtime serves no web client: paste the link into Caveman Code's Connect screen\n");
}

async function attached(live: PublishedRuntime, home: string, out: Out, facts: DesktopFacts) {
  out.write(`attached to the Caveman Code runtime pid ${live.pid} at ${live.url}\n`);
  await openClient(live, home, out, facts);
  out.write("caveman code attach   follow a session in this terminal\n");
}

export interface StartOptions {
  readonly home: string;
  /** This runtime's entry (bin.mjs or src/bin.ts). */
  readonly entry: string;
  /** What runs the runtime; the entry on this Node by default. */
  readonly server?: ReadonlyArray<string>;
  readonly out?: Out;
  readonly err?: Out;
  readonly facts?: DesktopFacts;
  /** Our own input (process.stdin when it is a pipe, inputIsPipe): on Windows its end stops the runtime. A test's stream counts as a pipe unless it is a TTY. */
  readonly input?: NodeJS.ReadableStream & { readonly isTTY?: boolean };
}

/**
 * Set on the runtime `caveman code` starts on Windows: the server stops once its stdin ends, as it does for the
 * desktop (cli/server.ts), because there is no signal to stop it with.
 */
export const EXIT_WITH_STDIN_ENV = "CAVEMAN_CODE_EXIT_WITH_STDIN";
/**
 * On Windows, how long the runtime has to stop once its stdin ended before its process tree is ended: its finalizers
 * end each engine's tree with taskkill there, which is slower than a signal. A second Ctrl-C does not wait.
 */
const STOP_GRACE_MS = 30_000;
/**
 * How long a report waits for the rest of the runtime's output once it exited: Node can see the exit before it has read
 * all of it, and a process the runtime left behind can hold its stdout and stderr open.
 */
const LAST_OUTPUT_MS = 2_000;

type Runtime = Pick<ChildProcess, "kill" | "pid" | "stdin" | "exitCode" | "signalCode">;

/**
 * How `caveman code` stops the runtime it started. Off Windows, with the signal it was sent. Windows has no signal
 * to send (child.kill there is TerminateProcess, which runs none of the runtime's finalizers and orphans its
 * engines, ptys and proxies): the end of its stdin instead, which stops it as SIGTERM would (EXIT_WITH_STDIN_ENV).
 * Asked again, or once it has not stopped within STOP_GRACE_MS, its process tree goes (taskkill /T /F).
 */
export function runtimeStopper(child: Runtime, platform: NodeJS.Platform = process.platform, killTree = killProcessTree): (signal: NodeJS.Signals) => void {
  if (platform !== "win32") return (signal) => void child.kill(signal);
  const running = () => child.exitCode === null && child.signalCode === null;
  let asked = false;
  return () => {
    if (!running()) return;
    if (asked) return killTree(child.pid);
    asked = true;
    child.stdin?.end();
    setTimeout(() => running() && killTree(child.pid), STOP_GRACE_MS).unref();
  };
}

/**
 * A terminal's Ctrl-C reaches both of us; `caveman code` stops the runtime with it (and with SIGTERM and SIGHUP).
 * On Windows what Node emits for Ctrl-C, Ctrl-Break and the console window closing. Returns the listeners' removal.
 */
export function relaySignals(
  stop: (signal: NodeJS.Signals) => void,
  platform: NodeJS.Platform = process.platform,
  on: Pick<NodeJS.Process, "on" | "off"> = process,
): () => void {
  const signals = platform === "win32" ? (["SIGINT", "SIGBREAK", "SIGHUP"] as const) : (["SIGINT", "SIGTERM", "SIGHUP"] as const);
  for (const signal of signals) on.on(signal, stop);
  return () => {
    for (const signal of signals) on.off(signal, stop);
  };
}

/**
 * Whether our stdin is a pipe: whoever holds its other end (a script, a smoke) ending it means they are done with us.
 * A terminal, NUL (`< nul`, a parent's `stdio: "ignore"`), a file (read to its end at once) or no stdin at all (Task
 * Scheduler) is not, and never stops the runtime. Node's own reading of the handle: a pipe or socket becomes a
 * net.Socket, a terminal a tty.ReadStream (one too), NUL and a file an fs.ReadStream, none a stream already ended.
 * Not fstat: on Windows it fails for a pipe.
 */
export function inputIsPipe(stdin: NodeJS.ReadableStream & { readonly isTTY?: boolean } = process.stdin): boolean {
  return stdin.isTTY !== true && stdin instanceof net.Socket;
}

/**
 * A line of the runtime's output with every `token=` value blanked. Its pairing URL carries a one-time credential
 * (#token=), and a report shows that output on our stderr whether or not it is a terminal: openClient prints a link
 * with a token to a terminal only.
 */
const redact = (line: string) => line.replace(/(token=)[^\s&#"'<>]+/gi, "$1<redacted>");

/** Resolves with the exit code. */
export async function start(options: StartOptions): Promise<number> {
  const { home, entry } = options;
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const facts = options.facts ?? desktopFacts();
  const running = await liveRuntime(home);
  if (running !== undefined) return attached(running, home, out, facts).then(() => 0);
  const app = desktopApp(home, facts);
  if (app !== undefined && bundledIn(entry) === app) {
    // The app runs its own runtime and keeps it for as long as it runs.
    openApp(app);
    const live = await waitLive(home, undefined, () => false);
    if (live !== undefined) return attached(live, home, out, facts).then(() => 0);
    err.write(`caveman code: ${app} did not start its runtime; see Help > Show Logs in the app\n`);
    return 1;
  }
  // A contained plugin can signal same-user processes: SIGUSR1 must not open an inspector here.
  const [command, ...args] = options.server ?? [process.execPath, "--disable-sigusr1", entry, "--no-browser"];
  // On Windows it is stopped through its stdin (runtimeStopper): a pipe, and the variable that makes its end stop it.
  const windows = process.platform === "win32";
  const child: ChildProcess = spawn(command!, args, {
    cwd: process.cwd(),
    env: windows ? { ...process.env, [EXIT_WITH_STDIN_ENV]: "1" } : process.env,
    stdio: [windows ? "pipe" : "ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // Ending the stdin of a runtime that already exited is no failure.
  child.stdin?.on("error", () => undefined);
  // Its last 40 lines, for a report. Whole lines, as a chunk can end inside one: redact must see a token in one piece.
  const tail: Array<string> = [];
  const keep = (lines: ReadonlyArray<string>) => {
    tail.push(...lines.filter(Boolean).map(redact));
    tail.splice(0, tail.length - 40);
  };
  const unfinished = [child.stdout, child.stderr].map((stream) => {
    let rest = "";
    stream?.setEncoding("utf8");
    stream?.on("data", (chunk: string) => {
      const lines = (rest + chunk).split("\n");
      rest = lines.pop()!;
      // A line that never ends is kept in pieces rather than held whole.
      if (rest.length > 65_536) (lines.push(rest), (rest = ""));
      keep(lines);
    });
    return () => (keep([rest]), (rest = ""));
  });
  let exit: { code: number; signal?: NodeJS.Signals | null; error?: string } | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once("exit", (code, signal) => ((exit ??= { code: code ?? 128 + (os.constants.signals[signal!] ?? 0), signal }), resolve()));
    child.once("error", (error) => ((exit ??= { code: 1, error: `${command}: ${error.message}` }), resolve()));
  });
  // It exited, and its stdout and stderr have ended.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const report = async (what: string) => {
    await within(closed, LAST_OUTPUT_MS).catch(() => undefined);
    for (const flush of unfinished) flush();
    const why = exit?.error ?? (exit?.signal ? `signal ${exit.signal}` : `exit ${exit?.code}`);
    err.write(`caveman code: the runtime ${what} (${why})${tail.length ? `:\n${tail.join("\n")}` : ""}\n`);
  };
  const stopper = runtimeStopper(child);
  // Set once `caveman code` stops the runtime (a relayed signal, the end of its input): any other exit is reported.
  let asked = false;
  const stop = (signal: NodeJS.Signals) => ((asked = true), stopper(signal));
  const unrelay = relaySignals(stop);
  // On Windows the end of our own input, when it is a pipe (a script or a smoke started us on one), stops the runtime
  // too; without a stdin Node makes one that has already ended, which never counts.
  const watchInput = windows && (options.input ? options.input.isTTY !== true : inputIsPipe());
  const input = options.input ?? (watchInput ? process.stdin : undefined);
  // Once: its end and its close both fire, and a second stop would end the runtime's tree.
  let inputDone = false;
  const inputEnded = () => {
    if (inputDone) return;
    inputDone = true;
    stop("SIGTERM");
  };
  if (watchInput && input) {
    for (const event of ["end", "close"] as const) input.once(event, inputEnded);
    input.resume();
  }
  try {
    const live = await waitLive(home, child.pid, () => exit !== undefined);
    if (live === undefined) {
      if (exit === undefined) stop("SIGTERM");
      await exited;
      // Another runtime took the home first: attach to that one.
      const owner = exit?.code === STATE_DIR_OWNED ? await waitLive(home, undefined, () => false, 10_000) : undefined;
      if (owner !== undefined) return attached(owner, home, out, facts).then(() => 0);
      await report("did not start");
      return 1;
    }
    out.write(`started the Caveman Code runtime pid ${live.pid} at ${live.url}\n`);
    await openClient(live, home, out, facts);
    out.write("caveman code attach   follow a session in this terminal · Ctrl-C stops the runtime\n");
    await exited;
    if (!asked) await report("stopped unexpectedly");
    return exit?.code ?? 0;
  } finally {
    unrelay();
    if (watchInput && input) {
      for (const event of ["end", "close"] as const) input.off(event, inputEnded);
      input.pause();
    }
  }
}

/** Model and tool text may carry terminal escapes: keep \n and \t, drop every other C0 and C1 control. */
const printable = (text: string) => text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");

/** One event as terminal text; deltas stream, a done message closes the line. Usage and cost never show. */
export function renderer(write: (text: string) => void): (event: SessionEvent) => void {
  const streamed = new Set<string>();
  let open = false;
  const end = () => {
    if (open) write("\n");
    open = false;
  };
  const line = (text: string) => {
    end();
    write(`${printable(text)}\n`);
  };
  return (event) => {
    switch (event.type) {
      case "turn.started":
        return line("");
      case "message.delta":
        if (event.item_id !== undefined) streamed.add(event.item_id);
        open = true;
        return write(printable(event.payload.text));
      case "message.done":
        if (event.payload.role === "user") return line(`> ${event.payload.text}`);
        if (event.item_id !== undefined && streamed.has(event.item_id)) return end();
        return line(event.payload.text);
      case "tool.started":
        return line(`· ${event.payload.kind} ${event.payload.title}`);
      case "tool.done":
        return event.payload.status === "completed" ? undefined : line(`  ${event.payload.status}${event.payload.error ? `: ${event.payload.error}` : ""}`);
      case "ask.user":
        return line(
          `? ${event.payload.kind === "approval" ? event.payload.title : event.payload.kind === "secret" ? `The agent needs ${event.payload.name}: ${event.payload.reason}` : event.payload.kind === "tool" ? `The agent called ${event.payload.name} and waits for its result` : event.payload.questions.map((q) => q.prompt).join(" / ")} (answer in Caveman Code)`,
        );
      case "turn.done":
        return event.payload.status === "completed" ? undefined : line(`turn ${event.payload.status}${event.payload.error ? `: ${event.payload.error}` : ""}`);
      case "notification":
        return line(`! ${event.payload.title}${event.payload.body ? `: ${event.payload.body}` : ""}`);
      case "error":
        return line(`error: ${event.payload.message}`);
    }
  };
}

export interface AttachOptions {
  readonly home: string;
  readonly session?: string | undefined;
  readonly input?: NodeJS.ReadableStream;
  readonly out?: Out;
  readonly err?: Out;
}

/** Resolves with the exit code. */
export async function attach(options: AttachOptions): Promise<number> {
  const { home } = options;
  const out = options.out ?? process.stdout;
  const err = options.err ?? process.stderr;
  const live = await liveRuntime(home);
  if (live === undefined) {
    err.write("caveman code attach: no Caveman Code runtime is running; start one with `caveman code`\n");
    return 1;
  }
  let failure: string | undefined;
  let leave!: () => void;
  const left = new Promise<void>((resolve) => (leave = resolve));
  const fail = (message: string) => {
    failure ??= message;
    leave();
  };
  // A runtime restart writes a new token file, so read it before every connection attempt.
  let opened = false;
  let goneSince: number | undefined;
  /** What the home says while the link is down: a runtime at another address, or none for GONE_MS. */
  const checkRuntime = () => {
    const now = discoverRuntime(home);
    if (now !== undefined && now.url !== live.url) fail(`the Caveman Code runtime restarted at ${now.url}; run caveman code attach again`);
    else if (now === undefined && Date.now() - (goneSince ??= Date.now()) > GONE_MS) fail("the Caveman Code runtime stopped");
    else if (now !== undefined) goneSince = undefined;
  };
  // Checked on its own clock while the link is down: reconnects back off (and a connect to a closed port can hang
  // on Windows), so waiting for the next attempt to look could take far longer than GONE_MS.
  let watching: ReturnType<typeof setInterval> | undefined;
  const stopWatching = () => {
    clearInterval(watching);
    watching = undefined;
  };
  const client = connect(live.url, () => fs.readFileSync(runtimeTokenPath(home), "utf8").trim(), (state) => {
    if (state === "open") {
      opened = true;
      goneSince = undefined;
      stopWatching();
    } else if (state === "unauthorized") {
      fail("the Caveman Code runtime no longer accepts this connection's token");
    } else if (state === "connecting" && opened) {
      checkRuntime();
      watching ??= setInterval(checkRuntime, 500);
    }
  });
  void left.then(stopWatching);
  /** A call that gives up once the attach is failing or leaving. */
  const guard = <T>(promise: Promise<T>) => Promise.race([promise, left.then((): never => { throw new Error(failure ?? "left"); })]);
  const onSigint = () => leave();
  process.once("SIGINT", onSigint);
  try {
    const { workspaces } = await guard(client.call("workspace.list", {}));
    const wanted = options.session;
    const workspace: Workspace | undefined = wanted
      ? workspaces.find((w) => w.session_id === wanted || w.id === wanted)
      : [...workspaces].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (workspace === undefined) {
      err.write(wanted ? `caveman code attach: no session ${wanted}\n` : "caveman code attach: no sessions yet; start one in Caveman Code\n");
      return 1;
    }
    out.write(`${printable(`${workspace.title} · ${workspace.engine} · ${workspace.branch}`)} · session ${workspace.session_id}\n`);
    out.write("type a line to send it as a turn · Ctrl-D leaves\n");
    const render = renderer((text) => out.write(text));
    const done = new Set<string>();
    const pending = new Set<string>();
    let inputClosed = false;
    let head = Number.POSITIVE_INFINITY;
    let cursor = 0;
    // Leave once input closed, the transcript so far is out, and every turn sent here finished.
    const maybeLeave = () => inputClosed && cursor >= head && pending.size === 0 && leave();
    const subscription = await guard(client.attach(
      workspace.session_id,
      0,
      (event) => {
        render(event);
        cursor = event.cursor;
        if (event.type === "turn.done" && event.turn_id !== undefined) {
          done.add(event.turn_id);
          pending.delete(event.turn_id);
        }
        maybeLeave();
      },
      (error) => fail(error.message),
    ));
    head = subscription.session.head;
    const input = createInterface({ input: options.input ?? process.stdin, terminal: false });
    const submits: Array<Promise<void>> = [];
    input.on("line", (text) => {
      if (text.trim() === "") return;
      submits.push(
        client
          .call("turn.submit", { request_id: randomUUID(), session_id: workspace.session_id, kind: "followup", input: { text } })
          .then(
            ({ turn_id }) => void (done.has(turn_id) || pending.add(turn_id)),
            (error: Error) => void err.write(`caveman code attach: ${error.message}\n`),
          ),
      );
    });
    input.once("close", () => void Promise.all(submits).then(() => ((inputClosed = true), maybeLeave())));
    await left;
    input.close();
    if (failure !== undefined) {
      err.write(`caveman code attach: ${failure}\n`);
      return 1;
    }
    await within(subscription.detach(), 2_000).catch(() => undefined);
    return 0;
  } catch (error) {
    err.write(`caveman code attach: ${failure ?? (error instanceof Error ? error.message : String(error))}\n`);
    return 1;
  } finally {
    stopWatching();
    process.off("SIGINT", onSigint);
    client.close();
  }
}

/** `bin.mjs code ...`, from bin.ts. */
export async function runCodeCommand(argv: ReadonlyArray<string>): Promise<void> {
  if (argv[0] === "mcp") {
    // `caveman-code mcp`: the stdio MCP server outside agents run (cli/mcp.ts), loaded only for it. Its stdout is MCP's.
    const { runMcpCommand } = await import("./mcp.ts");
    return runMcpCommand(argv.slice(1));
  }
  const home = codeHome();
  let code: number;
  // The real path: a `caveman-code` bin link must not start the runtime as `caveman code` again.
  if (argv.length === 0) code = await start({ home, entry: fs.realpathSync(path.resolve(process.argv[1] ?? "")) });
  else if (argv[0] === "attach" && argv.length <= 2 && !argv[1]?.startsWith("-")) code = await attach({ home, session: argv[1] });
  else if (argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") (process.stdout.write(`${USAGE}\n`), (code = 0));
  else (process.stderr.write(`${USAGE}\n`), (code = 2));
  process.exitCode = code;
}
