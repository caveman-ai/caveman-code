// `bin.ts code` (caveman code): the open-the-app decision, the client link,
// the terminal renderer, attach on a runtime with the fake claude (and its
// exit when that runtime stops), the exit-78 race, the report when the runtime
// does not start or dies after it served (no credential it printed shows; its
// output read only after its exit included, without waiting on a process that
// holds that output open), Ctrl-C on a real runtime started from source, whose
// trace never holds the token, and a real runtime's crash report.
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as net from "node:net";
import * as path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { connect, type SessionEvent } from "@caveman-app/session-protocol";
import { killProcessTree } from "@caveman-app/shared/processTree";
import { discoverRuntime } from "@caveman-app/shared/runtimeDiscovery";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createReady, FAKE_CLAUDE, makeConfig, makeRepo, MODEL, startRuntime, tempRoot, until } from "../session-protocol/testHarness.ts";
import { descendantsOf } from "../testUtils/processTree.ts";
import { attach, bundledIn, clientLink, codeHome, desktopApp, inputIsPipe, relaySignals, renderer, runtimeStopper, start, type DesktopFacts } from "./code.ts";

const collect = (tty = false) => {
  const sink = { text: "", isTTY: tty, write: (chunk: string) => ((sink.text += chunk), true) };
  return sink;
};
const noApp: DesktopFacts = { platform: "darwin", userHome: "/Users/u", installed: [] };

it("opens the desktop app only when it would show this home, and knows the app it was bundled in", () => {
  const facts: DesktopFacts = { platform: "darwin", userHome: "/Users/u", installed: ["/Applications/Caveman Code.app"] };
  // The home as codeHome makes it (with this host's separator, so the darwin facts hold on any host).
  const userCodeHome = path.join("/Users/u", ".caveman-code");
  expect(desktopApp(userCodeHome, facts)).toBe("/Applications/Caveman Code.app");
  expect(desktopApp(path.join("/tmp/h", ".caveman-code"), facts)).toBeUndefined(); // a HOME or CAVEMAN_CODE_HOME override
  expect(desktopApp(userCodeHome, { ...facts, platform: "linux" })).toBeUndefined();
  expect(desktopApp(userCodeHome, { ...facts, platform: "win32" })).toBeUndefined();
  expect(desktopApp(userCodeHome, noApp)).toBeUndefined();
  expect(bundledIn("/Applications/Caveman Code.app/Contents/Resources/runtime/bin.mjs")).toBe("/Applications/Caveman Code.app");
  expect(bundledIn("/x/packages/runtime/dist/bin.mjs")).toBeUndefined();
  expect(codeHome({ CAVEMAN_CODE_HOME: "~/cc" })).toBe(path.join(os.homedir(), "cc"));
  expect(codeHome({})).toBe(path.join(os.homedir(), ".caveman-code"));
});

it("stops the runtime with Ctrl-C, SIGTERM and SIGHUP; on Windows with Ctrl-C, Ctrl-Break and the console closing", () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const on = new EventEmitter();
    const stop = vi.fn();
    const unrelay = relaySignals(stop, platform, on as unknown as NodeJS.Process);
    const signals = platform === "win32" ? ["SIGINT", "SIGBREAK", "SIGHUP"] : ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of signals) on.emit(signal, signal);
    expect(stop.mock.calls).toEqual(signals.map((signal) => [signal]));
    unrelay();
    expect(on.eventNames()).toEqual([]);
  }
});

it("signals the runtime off Windows; on Windows ends its stdin, and ends its tree when asked again", async () => {
  const fake = () => ({ pid: 4242, exitCode: null, signalCode: null, stdin: new PassThrough(), kill: vi.fn(() => true) });
  const posix = fake();
  runtimeStopper(posix as never, "linux")("SIGINT");
  expect(posix.kill).toHaveBeenCalledExactlyOnceWith("SIGINT");
  expect(posix.stdin.writableEnded).toBe(false);

  const windows = fake();
  const killTree = vi.fn();
  const stop = runtimeStopper(windows as never, "win32", killTree);
  stop("SIGINT");
  // TerminateProcess would run none of its finalizers: its stdin ends instead, which stops it as SIGTERM would.
  expect(windows.stdin.writableEnded).toBe(true);
  expect(windows.kill).not.toHaveBeenCalled();
  expect(killTree).not.toHaveBeenCalled();
  stop("SIGINT");
  expect(killTree).toHaveBeenCalledExactlyOnceWith(4242);
});

it("puts the token in the link's fragment only", () => {
  const link = new URL(clientLink({ pid: 1, origin: "http://127.0.0.1:4100", url: "ws://127.0.0.1:4100/session/v1", token: "t0ken" }));
  expect(link.search).toBe(`?runtime=${encodeURIComponent("ws://127.0.0.1:4100/session/v1")}`);
  expect(link.hash).toBe("#token=t0ken");
});

it("renders text without terminal controls", () => {
  let text = "";
  const render = renderer((chunk) => (text += chunk));
  const at = new Date().toISOString();
  render({ session_id: "s", cursor: 1, at, item_id: "a", type: "message.delta", payload: { text: "a\u001b[31mb\u0007" } } as SessionEvent);
  render({ session_id: "s", cursor: 2, at, item_id: "a", type: "message.done", payload: { role: "assistant", text: "" } } as SessionEvent);
  render({ session_id: "s", cursor: 3, at, type: "tool.started", payload: { name: "Bash", title: "ls\r\n\tx\u009b2J", kind: "command", input: {} } } as SessionEvent);
  expect(text).toBe("a[31mb\n· command ls\n\tx2J\n");
});

describe("on a runtime with the fake claude", () => {
  let config: Awaited<ReturnType<typeof makeConfig>>;
  let runtime: Awaited<ReturnType<typeof startRuntime>>;
  let home: string;
  let session: string;
  const record = () => path.join(config.stateDir, "server-runtime.json");
  // What the real runtime publishes once it serves (server.ts); this process stands in as its pid.
  const publish = () =>
    fs.writeFileSync(
      record(),
      JSON.stringify({ version: 1, pid: process.pid, port: runtime.port, origin: `http://127.0.0.1:${runtime.port}`, startedAt: new Date().toISOString() }),
    );

  beforeAll(async () => {
    config = await makeConfig();
    expect(path.basename(config.stateDir)).toBe("userdata");
    home = path.dirname(config.stateDir);
    runtime = await startRuntime(config, "fake-claude");
    publish();
    const client = connect(runtime.url, runtime.token);
    const repo = makeRepo(tempRoot("code-attach-"), { "README.md": "hi\n" });
    const workspace = await createReady(client, { request_id: "code-w", repo: { path: repo }, title: "Code", engine: "claude-agent", options: { model: MODEL } });
    session = workspace.session_id;
    client.close();
  }, 60_000);
  afterAll(() => runtime.close());

  it("attach sends a typed line as a turn and shows the reply", async () => {
    const out = collect();
    const err = collect();
    expect(await attach({ home, session, input: Readable.from(["hello there\n"]), out, err })).toBe(0);
    expect(err.text).toBe("");
    // The chat's worktree row, then the turn.
    expect(out.text).toContain("type a line to send it as a turn · Ctrl-D leaves\n· command git worktree add ");
    expect(out.text).toContain("\n\n> hello there\nsmoke ok: hello there\n");
  }, 30_000);

  it("start attaches to the runtime that won the home when its own exits 78", async () => {
    fs.rmSync(record());
    const out = collect();
    const err = collect();
    const pending = start({ home, entry: "/nowhere/bin.mjs", server: [process.execPath, "-e", "setTimeout(() => process.exit(78), 500)"], out, err, facts: noApp, input: new PassThrough() });
    publish();
    expect(await pending).toBe(0);
    expect(err.text).toBe("");
    expect(out.text).toContain(`attached to the Caveman Code runtime pid ${process.pid} at ${runtime.url}\n`);
    expect(out.text).toContain("client link not printed: stdout is not a terminal");
  }, 30_000);

  it.skipIf(process.platform === "win32")("start says why when the runtime it started stops without being asked: how it ended and its last output, credentials blanked", async () => {
    fs.rmSync(record());
    const root = tempRoot("code-crash-");
    const trigger = path.join(root, "crash-now");
    // Stands in for the runtime: it prints its pairing URL as the real one does (announceStartupPairingUrl) and a
    // link with a token in its query, which reaches start() in two reads; then it publishes itself on the test
    // runtime's port, serves, and dies as V8 does on a fatal error (its reason straight to fd 2, then abort()) once
    // the trigger file appears.
    const fake = `
      const fs = require("node:fs");
      console.log("  pairingUrl: http://localhost:${runtime.port}/pair#token=PAIRSECRET");
      fs.writeSync(2, "a link: http://127.0.0.1:${runtime.port}/?runtime=x&tok");
      setTimeout(() => {
        fs.writeSync(2, "en=QUERYSECRET\\n");
        fs.writeFileSync(${JSON.stringify(record())}, JSON.stringify({ version: 1, pid: process.pid, port: ${runtime.port}, origin: "http://127.0.0.1:${runtime.port}", startedAt: new Date().toISOString() }));
        console.log("serving");
      }, 200);
      setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) { fs.writeSync(2, "FATAL ERROR: stand-in crash, heap limit reached\\n"); process.abort(); } }, 50);
    `;
    const out = collect();
    const err = collect();
    // No core file from its abort().
    const server = ["/bin/sh", "-c", 'ulimit -c 0; exec "$0" -e "$1"', process.execPath, fake];
    const pending = start({ home, entry: "/nowhere/bin.mjs", server, out, err, facts: noApp, input: new PassThrough() });
    try {
      await until(() => out.text.includes("Ctrl-C stops the runtime") || err.text !== "");
      expect(err.text).toBe("");
      fs.writeFileSync(trigger, "");
      expect(await pending).toBe(134);
      // How it ended, then its last output (abort() adds Node's native stack after the reason).
      expect(err.text).toMatch(/^caveman code: the runtime stopped unexpectedly \(signal SIGABRT\):\n/);
      expect(err.text).toContain("\nFATAL ERROR: stand-in crash, heap limit reached\n");
      // A token in a link it printed is blanked, the pairing URL's one-time credential included: stderr need not be
      // a terminal.
      expect(err.text).toContain(`\n  pairingUrl: http://localhost:${runtime.port}/pair#token=<redacted>\n`);
      expect(err.text).toContain(`\na link: http://127.0.0.1:${runtime.port}/?runtime=x&token=<redacted>\n`);
      expect(err.text).not.toMatch(/PAIRSECRET|QUERYSECRET/);
    } finally {
      fs.writeFileSync(trigger, "");
      await pending;
      publish();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  /**
   * A stand-in for the runtime that publishes itself on the test runtime's port and serves. Once `root`/crash-now
   * appears it runs the shell script `holder` (its $0 the stand-in's pid) on its stdout and stderr, records the holder's
   * pid in `root`/holder.pid, writes `last`, and exits 1.
   */
  const standIn = (root: string, holder: string, last = "") => `
    const fs = require("node:fs");
    const { spawn } = require("node:child_process");
    fs.writeFileSync(${JSON.stringify(record())}, JSON.stringify({ version: 1, pid: process.pid, port: ${runtime.port}, origin: "http://127.0.0.1:${runtime.port}", startedAt: new Date().toISOString() }));
    console.log("serving");
    setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(path.join(root, "crash-now"))})) return;
      const { pid } = spawn("/bin/sh", ["-c", ${JSON.stringify(holder)}, String(process.pid)], { stdio: ["ignore", "inherit", "inherit"] });
      if (pid !== undefined) fs.writeFileSync(${JSON.stringify(path.join(root, "holder.pid"))}, String(pid));
      fs.writeSync(2, ${JSON.stringify(last)});
      process.exit(1);
    }, 50);
  `;
  /**
   * Until the holder the stand-in in `root` started, if it did, has ended. start() returns only once the stand-in
   * exited, and the stand-in records the holder before it exits.
   */
  const holderEnded = async (root: string) => {
    const file = path.join(root, "holder.pid");
    if (fs.existsSync(file)) await until(() => !alive(Number(fs.readFileSync(file, "utf8"))));
  };

  // Skipped on Windows: the stand-ins run sh, and their gate is a pid that POSIX keeps until its parent reaps it.
  it.skipIf(process.platform === "win32")("start's crash report keeps the runtime's last output when that is read only after its exit", async () => {
    fs.rmSync(record());
    const root = tempRoot("code-late-");
    const trigger = path.join(root, "crash-now");
    // Node can see a child's exit before it has read the last of its output (1 run in ~150 on Linux). Here that happens
    // every run: the runtime's reason reaches its stderr only once start() has seen it exit and reaped it.
    const holder = 'while kill -0 "$0" 2>/dev/null; do sleep 0.01; done; echo "FATAL ERROR: stand-in crash, its last line" >&2';
    const out = collect();
    const err = collect();
    const pending = start({ home, entry: "/nowhere/bin.mjs", server: [process.execPath, "-e", standIn(root, holder)], out, err, facts: noApp, input: new PassThrough() });
    try {
      await until(() => out.text.includes("Ctrl-C stops the runtime") || err.text !== "");
      expect(err.text).toBe("");
      fs.writeFileSync(trigger, "");
      expect(await pending).toBe(1);
      expect(err.text).toBe("caveman code: the runtime stopped unexpectedly (exit 1):\nserving\nFATAL ERROR: stand-in crash, its last line\n");
    } finally {
      fs.writeFileSync(trigger, "");
      await pending;
      await holderEnded(root);
      publish();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it.skipIf(process.platform === "win32")("start's crash report does not wait on a process the runtime left holding its output", async () => {
    fs.rmSync(record());
    const root = tempRoot("code-held-");
    const trigger = path.join(root, "crash-now");
    // Holds the runtime's stdout and stderr until the gate opens, which happens only once start() has returned. It also
    // ends with this test's process: a start() that never returns never reaches the finally that opens the gate.
    const gate = path.join(root, "gate");
    const holder = `while [ ! -e ${JSON.stringify(gate)} ] && kill -0 ${process.pid} 2>/dev/null; do sleep 0.05; done`;
    const out = collect();
    const err = collect();
    const pending = start({
      home,
      entry: "/nowhere/bin.mjs",
      server: [process.execPath, "-e", standIn(root, holder, "FATAL ERROR: stand-in crash, its last line\n")],
      out,
      err,
      facts: noApp,
      input: new PassThrough(),
    });
    try {
      await until(() => out.text.includes("Ctrl-C stops the runtime") || err.text !== "");
      expect(err.text).toBe("");
      fs.writeFileSync(trigger, "");
      expect(await pending).toBe(1);
      expect(err.text).toBe("caveman code: the runtime stopped unexpectedly (exit 1):\nserving\nFATAL ERROR: stand-in crash, its last line\n");
    } finally {
      fs.writeFileSync(trigger, "");
      fs.writeFileSync(gate, "");
      await pending;
      await holderEnded(root);
      publish();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it("start says why the runtime it started did not start, with the credential in its pairing URL blanked", async () => {
    fs.rmSync(record());
    const out = collect();
    const err = collect();
    // Prints its pairing URL, then fails before it serves.
    const fake = `console.log("  pairingUrl: http://localhost:4100/pair#token=PAIRSECRET"); setTimeout(() => process.exit(1), 200);`;
    try {
      expect(await start({ home, entry: "/nowhere/bin.mjs", server: [process.execPath, "-e", fake], out, err, facts: noApp, input: new PassThrough() })).toBe(1);
      expect(err.text).toBe("caveman code: the runtime did not start (exit 1):\n  pairingUrl: http://localhost:4100/pair#token=<redacted>\n");
    } finally {
      publish();
    }
  }, 30_000);

  it("attach exits non-zero once the runtime stops", async () => {
    const out = collect();
    const err = collect();
    const input = new PassThrough();
    const pending = attach({ home, session, input, out, err });
    await until(() => out.text.includes("Ctrl-D leaves"));
    fs.rmSync(record());
    await runtime.close();
    expect(await pending).toBe(1);
    expect(err.text).toBe("caveman code attach: the Caveman Code runtime stopped\n");
  }, 30_000);
});

// Skipped on Windows: it signals a process group (kill(-pid)) and SIGUSR1 and reads ps, none of which exist there; a
// console's Ctrl-C reaches the runtime itself (relaySignals' test above).
it.skipIf(process.platform === "win32")("runs a real runtime in the foreground until Ctrl-C; the token never reaches its trace", async () => {
  const root = tempRoot("code-real-");
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    // Node only: no real claude or codex can be probed.
    PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
    CAVEMAN_CODE_TRACE_BATCH_WINDOW_MS: "100",
  };
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync(process.execPath, path.join(root, "bin", "node"));
  const home = path.join(env.HOME!, ".caveman-code");
  fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "userdata", "settings.json"),
    JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: FAKE_CLAUDE } } } }),
  );
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const bin = path.resolve(import.meta.dirname, "../bin.ts");
  // Its own process group, as a terminal runs it, so Ctrl-C reaches it and the runtime it starts.
  const child = spawn(process.execPath, [bin, "code"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    await until(() => output.includes("Ctrl-C stops the runtime") || child.exitCode !== null, 60_000);
    expect(output).toMatch(/^started the Caveman Code runtime pid \d+ at ws:\/\/127\.0\.0\.1:\d+\/session\/v1$/m);
    expect(output).toContain("client link not printed: stdout is not a terminal");
    const live = discoverRuntime(home);
    expect(live).toBeDefined();
    for (const dir of [home, path.join(home, "userdata"), path.join(home, "userdata", "logs")]) expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    // A contained plugin can signal it (same user): SIGUSR1 opens no inspector, and it keeps serving.
    expect(execFileSync("ps", ["-o", "args=", "-p", String(live!.pid)], { encoding: "utf8" })).toContain("--disable-sigusr1");
    process.kill(live!.pid, "SIGUSR1");
    await new Promise((r) => setTimeout(r, 500));
    // The printed link (fetch drops the fragment), and an old-style link with the token in its query.
    await fetch(clientLink(live!));
    await fetch(`${live!.origin}/?runtime=x&token=${live!.token}`);
    await new Promise((r) => setTimeout(r, 500));
    process.kill(-child.pid!, "SIGINT");
    expect(await exited).toBe(130);
    // A stop it asked for is no crash to report: nothing on its stderr once that has closed.
    await closed;
    expect(output).not.toContain("caveman code: the runtime");
    expect(fs.existsSync(path.join(home, "userdata", "server-runtime.json"))).toBe(false);
    const trace = fs.readFileSync(path.join(home, "userdata", "logs", "server.trace.ndjson"), "utf8");
    expect(trace.length).toBeGreaterThan(0);
    expect(trace).not.toContain(live!.token);
  } finally {
    if (child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 90_000);

// Skipped on Windows: the runtime dies by SIGABRT, under sh.
it.skipIf(process.platform === "win32")("reports a real runtime that dies after it served, with the credential in the pairing URL it printed blanked", async () => {
  const root = tempRoot("code-crash-real-");
  const trigger = path.join(root, "crash-now");
  const crash = path.join(root, "crash.mjs");
  // Loaded by every Node it starts; only the runtime's main thread acts on it. Once told to, the runtime writes a
  // fatal error's reason straight to fd 2 and dies by SIGABRT.
  fs.writeFileSync(
    crash,
    `import * as fs from "node:fs";
     import { isMainThread } from "node:worker_threads";
     if (isMainThread && process.argv.includes("--no-browser"))
       setInterval(() => { if (fs.existsSync(${JSON.stringify(trigger)})) { fs.writeSync(2, "FATAL ERROR: stand-in crash, heap limit reached\\n"); process.kill(process.pid, "SIGABRT"); } }, 100).unref();`,
  );
  const env: NodeJS.ProcessEnv = {
    HOME: path.join(root, "home"),
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    PATH: `${path.join(root, "bin")}:/usr/bin:/bin`,
    NODE_OPTIONS: `--import=${pathToFileURL(crash).href}`,
  };
  fs.mkdirSync(path.join(root, "bin"));
  fs.symlinkSync(process.execPath, path.join(root, "bin", "node"));
  const home = path.join(env.HOME!, ".caveman-code");
  fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "userdata", "settings.json"),
    JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: FAKE_CLAUDE } } } }),
  );
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const bin = path.resolve(import.meta.dirname, "../bin.ts");
  // stderr is no terminal, as with `caveman code 2>log`; no core file from the SIGABRT.
  const child = spawn("/bin/sh", ["-c", 'ulimit -c 0; exec "$0" "$@"', process.execPath, bin, "code"], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (err += chunk));
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try {
    // A real runtime under the crash hook starts in 70 s on a busy CI runner (its sibling above in under 10): room for it.
    await until(() => out.includes("Ctrl-C stops the runtime") || child.exitCode !== null, 120_000);
    expect(out, err).toMatch(/^started the Caveman Code runtime pid \d+ at ws:\/\/127\.0\.0\.1:\d+\/session\/v1$/m);
    fs.writeFileSync(trigger, "");
    expect(await exited).toBe(134);
    await closed;
    expect(err).toMatch(/^caveman code: the runtime stopped unexpectedly \(signal SIGABRT\):\n/);
    expect(err).toContain("\nFATAL ERROR: stand-in crash, heap limit reached\n");
    // What it printed at startup, without the one-time credential: no token of any link it printed shows.
    expect(err).toMatch(/\n {2}pairingUrl: http:\/\/localhost:\d+\/pair#token=<redacted>\n/);
    expect(err).not.toMatch(/token=(?!<redacted>)/i);
  } finally {
    if (child.exitCode === null) process.kill(-child.pid!, "SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

it("watches its stdin for an end only when it is a pipe: never a terminal, NUL, a file or none", async () => {
  expect(inputIsPipe(new PassThrough())).toBe(false);
  expect(inputIsPipe(Object.assign(new net.Socket(), { isTTY: true }))).toBe(false);
  const code = path.resolve(import.meta.dirname, "code.ts");
  const ask = (stdin: "pipe" | "ignore" | number) =>
    execFileSync(process.execPath, ["--input-type=module", "-e", `const { inputIsPipe } = await import(${JSON.stringify(pathToFileURL(code).href)}); console.log(inputIsPipe())`], { stdio: [stdin, "pipe", "pipe"], encoding: "utf8", windowsHide: true }).trim();
  expect(ask("pipe")).toBe("true");
  expect(ask("ignore")).toBe("false");
  const root = tempRoot("code-stdin-");
  const file = fs.openSync(path.join(root, "in.txt"), "w+");
  try {
    expect(ask(file)).toBe("false");
  } finally {
    fs.closeSync(file);
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 60_000);

/** `bin.ts code` from source in a repo, with a temp home and the fake claude, its stdin as given. */
function startCode(prefix: string, stdin: "pipe" | "ignore") {
  const root = tempRoot(prefix);
  const userHome = path.join(root, "home");
  const home = path.join(userHome, ".caveman-code");
  fs.mkdirSync(path.join(home, "userdata"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "userdata", "settings.json"),
    JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: FAKE_CLAUDE } } } }),
  );
  // os.homedir() reads USERPROFILE on Windows: both point at the temp home, and CAVEMAN_CODE_HOME at its runtime home.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: userHome,
    USERPROFILE: userHome,
    CAVEMAN_CODE_HOME: home,
    CLAUDE_CONFIG_DIR: path.join(root, "claude"),
    CODEX_HOME: path.join(root, "codex"),
    XDG_CONFIG_HOME: path.join(root, "config"),
  };
  const repo = makeRepo(root, { "README.md": "hi\n" });
  const bin = path.resolve(import.meta.dirname, "../bin.ts");
  const child = spawn(process.execPath, [bin, "code"], { cwd: repo, env, stdio: [stdin, "pipe", "pipe"], windowsHide: true });
  const run = { root, home, child, output: "", exited: new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code))) };
  child.stdout!.on("data", (chunk) => (run.output += chunk));
  child.stderr!.on("data", (chunk) => (run.output += chunk));
  return run;
}

// Windows only: there `caveman code` has no signal for the runtime it started, so the end of its input (a smoke's
// pipe, or the pipe breaking when it is killed) stops it through its stdin. Elsewhere the Ctrl-C test covers it.
it.runIf(process.platform === "win32")("on Windows the end of its input stops the runtime it started: exit 0, nothing left running", async () => {
  const run = startCode("code-win-eof-", "pipe");
  const { root, home, child, exited } = run;
  try {
    await until(() => run.output.includes("Ctrl-C stops the runtime") || child.exitCode !== null, 120_000);
    expect(run.output).toMatch(/^started the Caveman Code runtime pid \d+ at ws:\/\/127\.0\.0\.1:\d+\/session\/v1\r?$/m);
    const live = discoverRuntime(home);
    expect(live).toBeDefined();
    // The runtime and whatever it started (Windows gives each console process a conhost, which proves nothing).
    const before = descendantsOf(child.pid!).filter((row) => !/conhost/i.test(row));
    expect(before.map((row) => Number(row.split(" ")[0]))).toContain(live!.pid);

    const ended = Date.now();
    child.stdin!.end();
    const outcome = await Promise.race([exited, new Promise<"still running">((resolve) => setTimeout(() => resolve("still running"), 60_000))]);
    // On a failure: how long it took, and what the runtime was last doing.
    const trace = path.join(home, "userdata", "logs", "server.trace.ndjson");
    const last = fs.existsSync(trace) ? fs.readFileSync(trace, "utf8").trim().split("\n").slice(-3).map((l) => l.slice(0, 300)) : [];
    expect(outcome, `${run.output}\nafter ${Date.now() - ended} ms; trace ends:\n${last.join("\n")}`).toBe(0);
    expect(run.output).not.toContain("caveman code: the runtime");
    let left = before;
    for (let i = 0; i < 25 && left.length > 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      left = left.filter((row) => alive(Number(row.split(" ")[0])));
    }
    expect(left).toEqual([]);
    expect(fs.existsSync(path.join(home, "userdata", "server-runtime.json"))).toBe(false);
  } finally {
    if (child.exitCode === null) killProcessTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}, 240_000);

// Windows only: a parent that gives no input (`stdio: "ignore"`, `< nul`, Task Scheduler) is not done with us.
it.runIf(process.platform === "win32")("on Windows keeps the runtime running when its stdin is NUL, not a pipe", async () => {
  const run = startCode("code-win-nul-", "ignore");
  const { root, home, child } = run;
  try {
    await until(() => run.output.includes("Ctrl-C stops the runtime") || child.exitCode !== null, 120_000);
    expect(run.output).toMatch(/^started the Caveman Code runtime pid \d+ at ws:\/\/127\.0\.0\.1:\d+\/session\/v1\r?$/m);
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    expect(child.exitCode, run.output).toBeNull();
    expect(discoverRuntime(home)).toBeDefined();
  } finally {
    if (child.exitCode === null) killProcessTree(child.pid);
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}, 240_000);
