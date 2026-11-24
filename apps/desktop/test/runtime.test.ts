import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "../../../packages/protocol/src/desktopBootstrap.ts";
import { createServer, type Server } from "node:net";
import {
  assertNoSigusr1Inspector,
  bundledNode,
  DATABASE_NEWER_EXIT_CODE,
  errorLine,
  MAX_FAST_RESTARTS,
  portIsFree,
  publishedVersion,
  refusedDataLine,
  requestInspector,
  runtimeCommand,
  RuntimeSupervisor,
  STATE_DIR_OWNED_EXIT_CODE,
  versionSkew,
} from "../src/runtime.ts";

const fixture = fileURLToPath(new URL("./fixture-runtime.mjs", import.meta.url));
const fdExhaustion = fileURLToPath(new URL("./fixture-fd-exhaustion.ts", import.meta.url));
const command = { command: process.execPath, args: [fixture, "--bootstrap-fd", "3"], env: process.env, cwd: process.cwd() };
const withEnv = (env: Record<string, string>) => ({ ...command, env: { ...process.env, ...env } });

// A failed assertion must not leave a fixture runtime behind.
const started: RuntimeSupervisor[] = [];
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => s.stop()));
});

describe("a runtime that refuses its data", () => {
  it("is told by its DatabaseNewerThanRuntime line, whatever wraps it", () => {
    expect(refusedDataLine("[00:41:59.293] ERROR (#13): DatabaseNewerThanRuntimeError: Last used by 0.4.3; this is 0.4.2.")).toBe("Last used by 0.4.3; this is 0.4.2.");
    expect(refusedDataLine("DatabaseNewerThanRuntime: Last used by 0.4.3")).toBe("Last used by 0.4.3");
    expect(refusedDataLine("DatabaseNewerThanRuntime")).toBe("This runtime is older than the data it was asked to open.");
    expect(refusedDataLine("[00:41:59.293] ERROR (#13): PlatformError: BadResource")).toBeUndefined();
    expect(DATABASE_NEWER_EXIT_CODE).toBe(79);
  });
});

describe("an attached runtime's version", () => {
  const record = (fields: Record<string, unknown>) => {
    const home = mkdtempSync(join(tmpdir(), "caveman-desktop-version-"));
    mkdirSync(join(home, "userdata"));
    writeFileSync(join(home, "userdata", "server-runtime.json"), JSON.stringify({ version: 1, pid: 1, ...fields }));
    return home;
  };
  it("is the record's serverVersion; 0.0.0 or none is unknown", () => {
    expect(publishedVersion(record({ serverVersion: "0.4.1" }))).toBe("0.4.1");
    expect(publishedVersion(record({ serverVersion: "0.0.0" }))).toBeUndefined();
    expect(publishedVersion(record({}))).toBeUndefined();
    expect(publishedVersion(record({ version: "0.4.1" }))).toBe("0.4.1");
    expect(publishedVersion(join(tmpdir(), "caveman-desktop-no-such-home"))).toBeUndefined();
  });
  it("differs only when both are known", () => {
    expect(versionSkew("0.4.2", "0.4.1")).toBe(true);
    expect(versionSkew("0.4.2", "0.4.2")).toBe(false);
    expect(versionSkew("0.4.2", undefined)).toBe(false);
    expect(versionSkew("0.0.0", "0.4.1")).toBe(false);
    expect(versionSkew(undefined, "0.4.1")).toBe(false);
  });
});

describe("errorLine", () => {
  it("keeps the runtime's error lines and drops stack frames and Node's warnings", () => {
    // What the real runtime printed with a state dir that is a file (packages/runtime, 2026-10-18).
    expect(errorLine("[00:41:59.293] ERROR (#13): PlatformError: BadResource: FileSystem.makeDirectory (/tmp/x/state/userdata)")).toBe(
      "ERROR (#13): PlatformError: BadResource: FileSystem.makeDirectory (/tmp/x/state/userdata)",
    );
    expect(errorLine("  [cause]: Error: ENOTDIR: not a directory, mkdir '/tmp/x/state/userdata'")).toBe(
      "[cause]: Error: ENOTDIR: not a directory, mkdir '/tmp/x/state/userdata'",
    );
    expect(errorLine("    at Module.systemError (file:///x/effect/dist/PlatformError.js:177:39)")).toBeUndefined();
    expect(errorLine("(node:15561) ExperimentalWarning: SQLite is an experimental feature and might change at any time")).toBeUndefined();
    expect(errorLine("fixture runtime listening on 127.0.0.1:5000")).toBeUndefined();
  });
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("runtimeCommand", () => {
  it("imports the prepared compile cache before the entry, keeps --disable-sigusr1 first and a small young generation, and adds nothing without one", () => {
    expect(runtimeCommand("/r/node", "/r/bin.mjs", "/home").args).toEqual(["--disable-sigusr1", "--max-semi-space-size=4", "/r/bin.mjs", "--bootstrap-fd", "3"]);
    const { args } = runtimeCommand("/r/node", "/r/bin.mjs", "/home", join(tmpdir(), "runtime", "serverCompileCache.mjs"));
    expect(args.slice(0, 2)).toEqual(["--disable-sigusr1", "--max-semi-space-size=4"]);
    expect(args[2]).toMatch(/^--import=file:\/\/.*serverCompileCache\.mjs$/);
    expect(args.slice(3)).toEqual(["/r/bin.mjs", "--bootstrap-fd", "3"]);
  });
});

describe("bundledNode", () => {
  it("is the Node beside the packaged runtime bundle, node.exe on Windows", () => {
    expect(bundledNode("/Applications/Caveman Code.app/Contents/Resources", "darwin")).toBe(join("/Applications/Caveman Code.app/Contents/Resources", "runtime", "node"));
    expect(bundledNode("C:\\Program Files\\Caveman Code\\resources", "win32")).toBe(join("C:\\Program Files\\Caveman Code\\resources", "runtime", "node.exe"));
  });
});

describe("RuntimeSupervisor", () => {
  it("hands the child its port and token on fd 3, waits for engine.list, and stops it", async () => {
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(command, (line) => lines.push(line), { stateDir: "/tmp/caveman-state" });
    started.push(supervisor);
    expect(supervisor.endpoint.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/session\/v1$/);
    expect(supervisor.endpoint.token).toMatch(/^[0-9a-f]{64}$/);
    supervisor.start();
    const engines = await supervisor.waitReady(10_000);
    expect(engines.map((e) => e.id)).toEqual(["caveman"]);
    // The token is the gate: a wrong one never gets an answer.
    const wrong = await new Promise<string>((done) => {
      const ws = new WebSocket(supervisor.endpoint.url, ["caveman.session.v1", "base64url.bearer.d3Jvbmc"]);
      ws.onerror = () => done("refused");
      ws.onopen = () => done("opened");
    });
    expect(wrong).toBe("refused");
    expect(await supervisor.stop()).toEqual({ code: 0, signal: null });
    expect(lines.some((l) => l.includes("fixture runtime listening"))).toBe(true);
    expect(lines).toContain("runtime: fixture runtime t3Home=/tmp/caveman-state");
  });

  it("restarts a child that dies, on the same endpoint", async () => {
    const supervisor = await RuntimeSupervisor.create(command, () => {});
    started.push(supervisor);
    supervisor.start();
    await supervisor.waitReady(10_000);
    const first = supervisor.pid;
    process.kill(first!, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const engines = await supervisor.waitReady(10_000);
    expect(engines).toHaveLength(1);
    expect(supervisor.pid).not.toBe(first);
    await supervisor.stop();
  });

  it("moves to a free port, and tells the page, when another process took its port while it was down", async () => {
    const lines: string[] = [];
    let changed = 0;
    const supervisor = await RuntimeSupervisor.create(command, (line) => lines.push(line), { onEndpointChanged: () => (changed += 1) });
    started.push(supervisor);
    supervisor.start();
    await supervisor.waitReady(10_000);
    const before = supervisor.endpoint;
    const port = Number(new URL(before.url).port);
    const first = supervisor.pid!;
    process.kill(first, "SIGKILL");
    // Take the port in the 500 ms before the restart, as an outgoing connection or a dev server can.
    let squatter: Server | undefined;
    for (let i = 0; i < 40 && squatter === undefined; i++) {
      const server = createServer();
      const bound = await new Promise<boolean>((done) => {
        server.once("error", () => done(false));
        server.listen(port, "127.0.0.1", () => done(true));
      });
      if (bound) squatter = server;
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(squatter).toBeDefined();
    try {
      await new Promise((r) => setTimeout(r, 700));
      expect((await supervisor.waitReady(10_000)).map((e) => e.id)).toEqual(["caveman"]);
      expect(Number(new URL(supervisor.endpoint.url).port)).not.toBe(port);
      expect(supervisor.endpoint.token).toBe(before.token);
      expect(changed).toBe(1);
      expect(lines).toContain(`runtime: port ${port} is taken by another process; moving to ${new URL(supervisor.endpoint.url).port}`);
      expect(await portIsFree("127.0.0.1", port)).toBe(false);
    } finally {
      squatter!.close();
    }
  }, 30_000);

  it("stops restarting a runtime that keeps exiting at start, says why, and starts again on retry", async () => {
    const lines: string[] = [];
    const reasons: Array<string | undefined> = [];
    let gaveUp: () => void = () => {};
    const nextGiveUp = () => new Promise<void>((done) => (gaveUp = done));
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_EXIT_CODE: "3" }), (line) => lines.push(line), {
      restartMinMs: 10,
      onGaveUp: (reason) => {
        reasons.push(reason);
        gaveUp();
      },
    });
    started.push(supervisor);
    const first = nextGiveUp();
    supervisor.start();
    await first;
    const starts = () => lines.filter((l) => l.startsWith("runtime: started")).length;
    expect(starts()).toBe(MAX_FAST_RESTARTS + 1);
    expect(reasons).toEqual(["fixture runtime: Error: cannot start, exiting 3"]);
    expect(lines).toContain(`runtime: exited ${MAX_FAST_RESTARTS + 1} times in a row before it served or soon after; not restarting`);
    await new Promise((r) => setTimeout(r, 400)); // past the next delay it would have used (320 ms)
    expect(starts()).toBe(MAX_FAST_RESTARTS + 1);
    expect(supervisor.pid).toBeUndefined();
    // Try Again: a fresh count, the full run again, then it asks again.
    const second = nextGiveUp();
    supervisor.retry();
    await second;
    expect(starts()).toBe(2 * (MAX_FAST_RESTARTS + 1));
    expect(reasons).toHaveLength(2);
  }, 30_000);

  // A damaged install: antivirus took the bundled node.exe, the bundled node lost its exec bit, or development's `node`
  // is not on the Dock-launched app's PATH. Node emits "error" for such a child, never "exit".
  const unspawnable = async (node: string) => {
    const lines: string[] = [];
    const exits: Array<number | null> = [];
    const reasons: Array<string | undefined> = [];
    let gaveUp: () => void = () => {};
    const nextGiveUp = () => new Promise<void>((done) => (gaveUp = done));
    const supervisor = await RuntimeSupervisor.create({ ...command, command: node }, (line) => lines.push(line), {
      restartMinMs: 10,
      onUnexpectedExit: (code) => exits.push(code),
      onGaveUp: (reason) => {
        reasons.push(reason);
        gaveUp();
      },
    });
    started.push(supervisor);
    const starts = () => lines.filter((l) => l.startsWith("runtime: started")).length;
    // The whole run waits 10 + 20 + 40 + 80 + 160 ms between starts.
    const asked = (question: Promise<void>) =>
      Promise.race([question.then(() => "asked"), new Promise<string>((done) => setTimeout(() => done("never asked"), 5_000))]);
    const first = nextGiveUp();
    supervisor.start();
    expect({ outcome: await asked(first), starts: starts(), exits: exits.length, pid: supervisor.pid }).toEqual({
      outcome: "asked",
      starts: MAX_FAST_RESTARTS + 1,
      exits: MAX_FAST_RESTARTS + 1,
      pid: undefined,
    });
    // Try Again is not refused.
    const second = nextGiveUp();
    supervisor.retry();
    expect({ outcome: await asked(second), starts: starts() }).toEqual({ outcome: "asked", starts: 2 * (MAX_FAST_RESTARTS + 1) });
    return reasons;
  };

  it("counts a runtime Node that is missing as a failed run: restarts it, reports it, asks, and starts again on retry", async () => {
    const node = join(mkdtempSync(join(tmpdir(), "caveman-desktop-no-node-")), "runtime", "node");
    const reasons = await unspawnable(node);
    expect(reasons[0]).toMatch(/ENOENT/);
  }, 30_000);

  it.skipIf(process.platform === "win32")("counts a runtime Node that cannot be run as a failed run, and asks", async () => {
    const node = join(mkdtempSync(join(tmpdir(), "caveman-desktop-no-exec-")), "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const reasons = await unspawnable(node);
    expect(reasons[0]).toMatch(/EACCES/);
  }, 30_000);

  // A main process out of file descriptors: Node's spawn returns before it makes the child's pipes (no stdio, no pid)
  // and emits "error" (EMFILE) a tick later. Windows has no ulimit.
  it.skipIf(process.platform === "win32")(
    "counts a runtime the app had no file descriptors to start as a failed run, and restarts it once it has them",
    async () => {
      const driver = spawn("/bin/sh", ["-c", 'ulimit -n 256 && exec "$0" "$1"', process.execPath, fdExhaustion], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let out = "";
      driver.stdout.setEncoding("utf8").on("data", (chunk: string) => (out += chunk));
      await once(driver, "close");
      const report = JSON.parse(out) as { exhausted: boolean; threw?: string; uncaught: string[]; exits: unknown[]; ready: unknown; lines: string[] };
      expect({ exhausted: report.exhausted, threw: report.threw, uncaught: report.uncaught, exits: report.exits.length, ready: report.ready }).toEqual({
        exhausted: true,
        threw: undefined,
        uncaught: [],
        exits: 1,
        ready: ["caveman"],
      });
      expect(report.lines).toContainEqual(expect.stringMatching(/^runtime: spawn failed: spawn .+ EMFILE$/));
    },
    30_000,
  );

  it("counts a slow start that never served as failed, however long it took", async () => {
    let gaveUp!: () => void;
    const reported = new Promise<void>((done) => (gaveUp = done));
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_EXIT_CODE: "3", FIXTURE_EXIT_AFTER_MS: "150" }), (l) => lines.push(l), {
      restartMinMs: 10,
      healthyAfterMs: 50, // every run outlives it
      onGaveUp: () => gaveUp(),
    });
    started.push(supervisor);
    supervisor.start();
    await reported;
    expect(lines.filter((l) => l.startsWith("runtime: started"))).toHaveLength(MAX_FAST_RESTARTS + 1);
  }, 30_000);

  it("never restarts a runtime that refused its data (exit 79), says what it said, and starts again on retry", async () => {
    const lines: string[] = [];
    const refusals: string[] = [];
    let refused: () => void = () => {};
    const nextRefusal = () => new Promise<void>((done) => (refused = done));
    let gaveUp = false;
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_EXIT_CODE: String(DATABASE_NEWER_EXIT_CODE) }), (line) => lines.push(line), {
      restartMinMs: 10,
      onGaveUp: () => (gaveUp = true),
      onRefusedData: (message) => {
        refusals.push(message);
        refused();
      },
    });
    started.push(supervisor);
    const first = nextRefusal();
    supervisor.start();
    await first;
    await new Promise((r) => setTimeout(r, 300)); // past several restart delays it would have used
    const starts = () => lines.filter((l) => l.startsWith("runtime: started")).length;
    expect(starts()).toBe(1);
    expect(lines.some((l) => l.includes("restarting in"))).toBe(false);
    expect(refusals).toEqual([`fixture runtime: Error: cannot start, exiting ${DATABASE_NEWER_EXIT_CODE}`]);
    expect(gaveUp).toBe(false);
    const second = nextRefusal();
    supervisor.retry();
    await second;
    expect(starts()).toBe(2);
  }, 30_000);

  it("restarts a runtime that served and then printed a DatabaseNewerThanRuntime line before crashing", async () => {
    const lines: string[] = [];
    const refusals: string[] = [];
    const supervisor = await RuntimeSupervisor.create(
      withEnv({ FIXTURE_SAY_REFUSE_AFTER_MS: "1500" }),
      (line) => lines.push(line),
      { restartMinMs: 10, onRefusedData: (text) => refusals.push(text) },
    );
    started.push(supervisor);
    supervisor.start();
    const deadline = Date.now() + 10_000;
    while (lines.filter((l) => l.startsWith("runtime: started")).length < 2 && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    expect(lines.filter((l) => l.startsWith("runtime: started")).length).toBeGreaterThanOrEqual(2);
    expect(refusals).toEqual([]);
  }, 30_000);

  it("knows the refusal from the runtime's DatabaseNewerThanRuntime line under any exit code", async () => {
    let message!: (text: string) => void;
    const refused = new Promise<string>((done) => (message = done));
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(
      withEnv({ FIXTURE_REFUSE_DATA: "This database was last used by Caveman Code 0.4.3 (migration 74); this runtime is 0.4.2 (migration 72)." }),
      (line) => lines.push(line),
      { restartMinMs: 10, onRefusedData: (text) => message(text) },
    );
    started.push(supervisor);
    supervisor.start();
    expect(await refused).toBe("This database was last used by Caveman Code 0.4.3 (migration 74); this runtime is 0.4.2 (migration 72).");
    await new Promise((r) => setTimeout(r, 200));
    expect(lines.filter((l) => l.startsWith("runtime: started"))).toHaveLength(1);
  }, 30_000);

  it("keeps restarting a runtime that served for a while before each exit", async () => {
    let gaveUp = false;
    const supervisor = await RuntimeSupervisor.create(command, () => {}, { restartMinMs: 10, healthyAfterMs: 50, onGaveUp: () => (gaveUp = true) });
    started.push(supervisor);
    supervisor.start();
    for (let i = 0; i < MAX_FAST_RESTARTS + 2; i++) {
      await supervisor.waitReady(10_000);
      await new Promise((r) => setTimeout(r, 700)); // past the serve probe (500 ms) and healthyAfterMs
      process.kill(supervisor.pid!, "SIGKILL");
      while (supervisor.pid !== undefined) await new Promise((r) => setTimeout(r, 10));
    }
    expect((await supervisor.waitReady(10_000)).map((e) => e.id)).toEqual(["caveman"]);
    expect(gaveUp).toBe(false);
  }, 60_000);

  it("does not restart a runtime refused by the state-dir owner (exit 78)", async () => {
    expect(STATE_DIR_OWNED_EXIT_CODE).toBe(SERVER_EXIT_CODE_STATE_DIR_OWNED);
    const lines: string[] = [];
    let owned!: () => void;
    const reported = new Promise<void>((done) => (owned = done));
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_EXIT_CODE: "78" }), (line) => lines.push(line), {
      // An owner that published nothing: there is no runtime to attach to.
      stateDir: mkdtempSync(join(tmpdir(), "caveman-desktop-owned-")),
      onStateDirOwned: () => owned(),
    });
    started.push(supervisor);
    supervisor.start();
    await reported;
    await new Promise((r) => setTimeout(r, 800)); // past the first restart delay (500 ms)
    expect(lines.filter((l) => l.startsWith("runtime: started"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("restarting in"))).toBe(false);
    expect(supervisor.pid).toBeUndefined();
  });

  it("attaches to the live runtime that owns the state dir (exit 78) and never stops it", async () => {
    const owner = await RuntimeSupervisor.create(command, () => {});
    started.push(owner);
    owner.start();
    await owner.waitReady(10_000);
 // What a runtime publishes once it serves: upstream server-runtime.json and its 0600 token file.
    const base = mkdtempSync(join(tmpdir(), "caveman-desktop-attach-"));
    mkdirSync(join(base, "userdata"));
    const origin = owner.endpoint.url.replace(/^ws/, "http").replace(/\/session\/v1$/, "");
    writeFileSync(
      join(base, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: owner.pid, port: Number(new URL(origin).port), origin, startedAt: new Date().toISOString(), serverVersion: "0.4.1" }),
    );
    writeFileSync(join(base, "userdata", "session-protocol.token"), owner.endpoint.token, { mode: 0o600 });
    let refused = false;
    let attached = 0;
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_EXIT_CODE: "78" }), (line) => lines.push(line), {
      appVersion: "0.4.2",
      stateDir: base,
      onStateDirOwned: () => (refused = true),
      onEndpointChanged: () => attached++,
    });
    started.push(supervisor);
    supervisor.start();
    expect((await supervisor.waitReady(10_000)).map((e) => e.id)).toEqual(["caveman"]);
    expect(supervisor.endpoint).toEqual(owner.endpoint);
    expect(refused).toBe(false);
    expect(attached).toBe(1);
    expect(lines).toContain(`runtime: attached to pid=${owner.pid}, which owns the state dir`);
    // Another build than the app's: said in the log (and Settings), and used as it is.
    expect(supervisor.attachedVersion).toBe("0.4.1");
    expect(lines).toContain(`runtime: pid=${owner.pid} is runtime 0.4.1, not this app's 0.4.2; using it as it is, never stopping it`);
    // The smoke test's SIGUSR1 step checks this pid (the record's), never a child of its own.
    expect(supervisor.pid).toBeUndefined();
    expect(supervisor.attachedPid).toBe(owner.pid);
    expect(await supervisor.stop()).toBeNull();
    supervisor.kill();
    expect((await owner.waitReady(2_000)).map((e) => e.id)).toEqual(["caveman"]);
  });

  it("starts its own runtime again once the state-dir owner it attached to exits", async () => {
    const owner = await RuntimeSupervisor.create(command, () => {});
    started.push(owner);
    owner.start();
    await owner.waitReady(10_000);
    const base = mkdtempSync(join(tmpdir(), "caveman-desktop-takeover-"));
    mkdirSync(join(base, "userdata"));
    const origin = owner.endpoint.url.replace(/^ws/, "http").replace(/\/session\/v1$/, "");
    writeFileSync(
      join(base, "userdata", "server-runtime.json"),
      JSON.stringify({ version: 1, pid: owner.pid, port: Number(new URL(origin).port), origin, startedAt: new Date().toISOString() }),
    );
    writeFileSync(join(base, "userdata", "session-protocol.token"), owner.endpoint.token, { mode: 0o600 });
    let changed = 0;
    let refused = false;
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_OWNED_BY_PID: String(owner.pid) }), (line) => lines.push(line), {
      stateDir: base,
      onStateDirOwned: () => (refused = true),
      onEndpointChanged: () => changed++,
    });
    started.push(supervisor);
    supervisor.start();
    await supervisor.waitReady(10_000);
    expect(supervisor.endpoint).toEqual(owner.endpoint);
    expect(changed).toBe(1);
    const ownerPid = owner.pid!;
    await owner.stop();
    // Within a poll or two the app serves on its own endpoint again.
    const deadline = Date.now() + 10_000;
    while (supervisor.pid === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect((await supervisor.waitReady(10_000)).map((e) => e.id)).toEqual(["caveman"]);
    expect(supervisor.endpoint).not.toEqual(owner.endpoint);
    expect(supervisor.attachedPid).toBeUndefined();
    expect(supervisor.pid).toBeDefined();
    expect(changed).toBe(2);
    expect(refused).toBe(false);
    expect(lines).toContain(`runtime: pid=${ownerPid}, which owned the state dir, is gone; starting this app's own`);
  }, 30_000);

  // Windows has no SIGUSR1; requestInspector asks through process._debugProcess, its way in.
  it("starts the runtime so that SIGUSR1 opens no inspector", async () => {
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(runtimeCommand(process.execPath, fixture, process.cwd()), (l) => lines.push(l));
    started.push(supervisor);
    supervisor.start();
    await supervisor.waitReady(10_000);
    const pid = supervisor.pid;
    requestInspector(pid!);
    await new Promise((r) => setTimeout(r, 1_000));
    expect(lines.filter((l) => l.includes("Debugger listening"))).toEqual([]);
    expect(supervisor.pid).toBe(pid);
    expect(await supervisor.waitReady(5_000)).toHaveLength(1);
  });

  // The control for the test above: the same request reaches a Node started without the flag, so "no inspector"
  // there is the flag's doing (on Windows too, where the request is process._debugProcess).
  it("asks a Node without --disable-sigusr1 for its inspector, and it opens one", { timeout: 20_000 }, async () => {
    const plain = spawn(process.execPath, ["-e", "process.stderr.write('ready\\n'); setInterval(() => {}, 1000)"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    try {
      await once(plain, "spawn");
      let stderr = "";
      plain.stderr!.on("data", (chunk) => (stderr += String(chunk)));
      // Its own code runs only after Node's start-up installed the debug handler: wait for that, not a guess (300 ms
      // was too short on a loaded Windows runner).
      const ready = Date.now() + 10_000;
      while (!stderr.includes("ready") && Date.now() < ready) await new Promise((r) => setTimeout(r, 20));
      expect(requestInspector(plain.pid!)).toBe(true);
      const deadline = Date.now() + 10_000;
      // "Starting inspector on 127.0.0.1:9229 failed" when another process holds the port: the handler ran all the same.
      while (!/Debugger listening|Starting inspector/.test(stderr) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(stderr).toMatch(/Debugger listening|Starting inspector/);
    } finally {
      plain.kill();
    }
  });

  // Windows reads the command line through PowerShell, which takes seconds to start on a cold runner.
  it("reads --disable-sigusr1 from an attached runtime's command line, without signalling it", { timeout: 200_000 }, async () => {
    const run = async (flags: string[]) => {
      // Alive until killed below: a cold PowerShell can take longer to start than any fixed lifetime.
      const child = spawn(process.execPath, [...flags, "-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      await once(child, "spawn");
      return child;
    };
    const flagged = await run(["--disable-sigusr1"]);
    const plain = await run([]);
    try {
      expect(assertNoSigusr1Inspector(flagged.pid!)).toContain("--disable-sigusr1");
      expect(() => assertNoSigusr1Inspector(plain.pid!)).toThrow(/runs without --disable-sigusr1/);
    } finally {
      flagged.kill();
      plain.kill();
    }
  });

  it("retries an upgrade the runtime never answers", async () => {
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_HANG_FIRST_UPGRADE: "1" }), () => {});
    started.push(supervisor);
    supervisor.start();
    expect((await supervisor.waitReady(10_000)).map((e) => e.id)).toEqual(["caveman"]);
  });

  it("SIGKILLs a runtime that ignores SIGTERM after the grace period, and the processes it started", async () => {
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(withEnv({ FIXTURE_IGNORE_STOP: "1", FIXTURE_CHILD: "1" }), (l) => lines.push(l), { stopGraceMs: 300 });
    started.push(supervisor);
    supervisor.start();
    await supervisor.waitReady(10_000);
    const engine = Number(lines.map((l) => /fixture runtime child pid=(\d+)/.exec(l)?.[1]).find(Boolean));
    expect(alive(engine)).toBe(true);
    const pid = supervisor.pid!;
    // Windows: `taskkill /T /F`, which ends a process with exit code 1 and no signal.
    expect(await supervisor.stop()).toEqual(process.platform === "win32" ? { code: 1, signal: null } : { code: null, signal: "SIGKILL" });
    const deadline = Date.now() + 5_000;
    while ((alive(engine) || alive(pid)) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
    expect(alive(engine)).toBe(false);
  }, 20_000);

  it("stops a runtime by ending its stdin on Windows, and by SIGTERM elsewhere", async () => {
    const lines: string[] = [];
    const supervisor = await RuntimeSupervisor.create(command, (l) => lines.push(l));
    started.push(supervisor);
    supervisor.start();
    await supervisor.waitReady(10_000);
    const asked = Date.now();
    // Well inside the 5 s grace period: the runtime's own shutdown ran, nothing forced it.
    expect(await supervisor.stop()).toEqual({ code: 0, signal: null });
    expect(Date.now() - asked).toBeLessThan(4_000);
    expect(lines).toContain(`runtime: fixture runtime: stopping on ${process.platform === "win32" ? "stdin EOF" : "SIGTERM"}`);
  }, 20_000);
});
