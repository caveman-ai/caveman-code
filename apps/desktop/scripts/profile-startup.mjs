// ), scripts/profile-startup.mjs @ 67eebaca23 (0bc95fcdea): where the runtime's start goes,
// as the desktop starts it. `pnpm profile:startup` starts the runtime the way the app does (its bootstrap envelope on
// fd 3, in a scratch home, never the person's), with this file preloaded into it and every Node it starts in the
// first 20 s, and writes per process a sampled CPU profile, a Chrome trace of module resolution, loading, synchronous
// subprocesses and `performance.measure` marks, and the process's facts. It prints the runtime's own startup phases
// (src/startupTrace.ts) and when its port first answered.
//   pnpm profile:startup                         the runtime from source (packages/runtime/src/bin.ts), on this Node
//   pnpm profile:startup --packaged <app>        a packaged app's runtime: <app>/Contents/Resources/runtime (macOS),
//                                                <app>/resources/runtime (Windows), or that folder itself, on its own
//                                                Node, with the prepared compile cache the app uses
//                                                (src/serverCompileCache.ts) unless --no-compile-cache
//   --out <dir>   where the profiles go (default apps/desktop/.startup-profiles/<time>); also CAVEMAN_STARTUP_PROFILE_DIR
// Open a .cpuprofile in Chrome DevTools' Performance panel, and a .modules.json in its trace viewer or
// ui.perfetto.dev. Profiling adds overhead: compare readiness with an ordinary start, not a profiled one.
// Dropped from T3: its per-module debugger instrumentation (profile-startup-modules.mjs), which needs
// --no-node-snapshot and a debugger pause in the live loader.
import * as NodeChildProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeInspector from "node:inspector";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeURL from "node:url";
import * as NodeWorkerThreads from "node:worker_threads";

const CAPTURE_MS = 20_000;
const directory = process.env.CAVEMAN_STARTUP_PROFILE_DIR;
const isLauncher = (() => {
  try {
    return (
      process.argv[1] !== undefined &&
      NodeFS.realpathSync(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
    );
  } catch {
    return false;
  }
})();

if (directory && !isLauncher) {
  NodeFS.mkdirSync(directory, { recursive: true });
  const { threadId } = NodeWorkerThreads;
  const prefix = NodePath.join(directory, `${process.pid}-${threadId}`);
  const origin = NodePerfHooks.performance.timeOrigin;
  const events = [];
  const session = new NodeInspector.Session();
  session.connect();
  session.post("Profiler.setSamplingInterval", { interval: 1000 });
  session.post("Profiler.enable");
  const profileStartTimeUnixMs = origin + NodePerfHooks.performance.now();
  session.post("Profiler.start");

  const measure = (name, operation, cat, args = {}) => {
    const start = NodePerfHooks.performance.now();
    try {
      return operation();
    } finally {
      events.push({
        name,
        cat,
        ph: "X",
        pid: process.pid,
        tid: threadId,
        ts: (origin + start) * 1000,
        dur: (NodePerfHooks.performance.now() - start) * 1000,
        args,
      });
    }
  };
  const recordMeasures = (entries) => {
    for (const entry of entries)
      events.push({
        name: entry.name,
        cat: "startup",
        ph: "X",
        pid: process.pid,
        tid: threadId,
        ts: (origin + entry.startTime) * 1000,
        dur: entry.duration * 1000,
      });
  };
  const observer = new NodePerfHooks.PerformanceObserver((list) =>
    recordMeasures(list.getEntries()),
  );
  observer.observe({ entryTypes: ["measure"] });
  const execFileSync = NodeChildProcess.default.execFileSync;
  NodeChildProcess.default.execFileSync = function (file, ...args) {
    return measure(
      `execFileSync ${file}`,
      () => execFileSync.call(this, file, ...args),
      "subprocess",
    );
  };
  NodeModule.syncBuiltinESMExports();
  const hooks = NodeModule.registerHooks({
    resolve(specifier, context, next) {
      const args = { specifier, parentURL: context.parentURL };
      return measure(
        `resolve ${specifier}`,
        () => {
          const result = next(specifier, context);
          args.url = result.url;
          return result;
        },
        "module",
        args,
      );
    },
    load(url, context, next) {
      return measure(`load ${url}`, () => next(url, context), "module", {
        url,
        format: context.format,
      });
    },
  });

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    hooks.deregister();
    recordMeasures(observer.takeRecords());
    observer.disconnect();
    NodeChildProcess.default.execFileSync = execFileSync;
    NodeModule.syncBuiltinESMExports();
    session.post("Profiler.stop", (error, result) => {
      if (!error) NodeFS.writeFileSync(`${prefix}.cpuprofile`, JSON.stringify(result.profile));
      session.disconnect();
    });
    NodeFS.writeFileSync(`${prefix}.modules.json`, JSON.stringify({ traceEvents: events }));
    NodeFS.writeFileSync(
      `${prefix}.process.json`,
      JSON.stringify({
        pid: process.pid,
        parentPid: process.ppid,
        threadId,
        nodeVersion: process.version,
        executable: process.execPath,
        entry: process.argv[1],
        timeOrigin: origin,
        profileStartTimeUnixMs,
        captureEnd: origin + NodePerfHooks.performance.now(),
        cpu: process.cpuUsage(),
        memory: process.memoryUsage(),
      }),
    );
  };
  // Bound the capture without keeping the runtime or a short-lived helper alive.
  setTimeout(finish, CAPTURE_MS).unref();
  process.once("exit", finish);
}

if (isLauncher) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const at = argv.indexOf(name);
    return at < 0 ? undefined : argv[at + 1];
  };
  const repo = NodeURL.fileURLToPath(new URL("../../../", import.meta.url));
  const packaged = flag("--packaged");
  const output = NodePath.resolve(
    flag("--out") ??
      directory ??
      NodePath.join(
        repo,
        "apps/desktop/.startup-profiles",
        new Date().toISOString().replaceAll(":", "-"),
      ),
  );
  const win = process.platform === "win32";

  let node = process.execPath;
  let entry = NodePath.join(repo, "packages/runtime/src/bin.ts");
  const preloads = [];
  if (packaged) {
    const candidates = [
      NodePath.join(packaged, "Contents/Resources/runtime"),
      NodePath.join(packaged, "resources/runtime"),
      packaged,
    ];
    const runtimeDir = candidates.find((dir) => NodeFS.existsSync(NodePath.join(dir, "bin.mjs")));
    if (!runtimeDir) throw new Error(`no runtime/bin.mjs under ${packaged}`);
    node = NodePath.join(runtimeDir, win ? "node.exe" : "node");
    entry = NodePath.join(runtimeDir, "bin.mjs");
    const cache = NodePath.join(runtimeDir, "serverCompileCache.mjs");
    if (!argv.includes("--no-compile-cache") && !win && NodeFS.existsSync(cache))
      preloads.push(`--import=${NodeURL.pathToFileURL(cache).href}`);
  }

  const port = await new Promise((done, fail) => {
    const server = NodeNet.createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port: picked } = server.address();
      server.close(() => done(picked));
    });
  });
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "caveman-startup-profile-"));
  console.log(
    `[profile-startup] ${packaged ? `packaged runtime ${entry}${preloads.length ? " with its prepared compile cache" : ""}` : "runtime from source"} on ${node}`,
  );
  console.log(`[profile-startup] writing CPU profiles and traces to ${output}`);
  const env = {
    ...process.env,
    CAVEMAN_STARTUP_PROFILE_DIR: output,
    NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${import.meta.url}`.trim(),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  const child = NodeChildProcess.spawn(
    node,
    // As src/runtime.ts runtimeCommand starts it.
    ["--disable-sigusr1", "--max-semi-space-size=4", ...preloads, entry, "--bootstrap-fd", "3"],
    {
      cwd: NodeOS.homedir(),
      env,
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    },
  );
  child.stdio[3].on("error", () => undefined);
  child.stdio[3].end(
    `${JSON.stringify({ mode: "desktop", noBrowser: true, host: "127.0.0.1", port, t3Home: home, desktopBootstrapToken: randomBytes(32).toString("hex") })}\n`,
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      for (const line of chunk.split("\n"))
        if (/^startup: /.test(line)) console.log(`[profile-startup] runtime ${line}`);
    });
  }
  const stop = () => child.stdin.end();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const probe = () => {
    const socket = NodeNet.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      console.log(
        `[profile-startup] the runtime answered on its port ${Date.now() - started} ms after spawn`,
      );
      // Long enough for what follows the first answer; the capture ends at 20 s in any case.
      setTimeout(stop, 3_000).unref();
    });
    socket.once("error", () => {
      socket.destroy();
      if (child.exitCode === null) setTimeout(probe, 50);
    });
  };
  probe();
  const cap = setTimeout(stop, CAPTURE_MS + 2_000);
  child.on("exit", (code, signal) => {
    clearTimeout(cap);
    NodeFS.rmSync(home, { recursive: true, force: true });
    const files = NodeFS.existsSync(output) ? NodeFS.readdirSync(output) : [];
    console.log(
      `[profile-startup] the runtime exited (${signal ?? code}); ${files.filter((f) => f.endsWith(".cpuprofile")).length} CPU profiles in ${output}`,
    );
    process.exitCode = files.length > 0 ? 0 : 1;
  });
}
