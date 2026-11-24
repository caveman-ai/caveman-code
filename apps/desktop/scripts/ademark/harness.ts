// What every ADEMark test here shares: ADEMark itself at a pinned commit (its arena, replay server and native sampler,
// so our numbers come from its instruments), a throwaway profile per run (never ~/.caveman-code, never the person's
// Electron profile), the packaged app launched on it, and its runtime driven over Session Protocol.
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect } from "@caveman-app/session-protocol";

type SessionClient = ReturnType<typeof connect>;

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, "../../../..");

/** ADEMark v1.0.1 as published with the first results (zqkra/ademark). Change it only with budgets.json's `ademark`. */
export const ADEMARK_REPO = "https://github.com/zqkra/ademark.git";
export const ADEMARK_COMMIT = "119a5f7b99247cffbe7f96bb2c36c03496cf3018";

// Node's monotonic clock in ms. On macOS it counts time asleep, so it runs ahead of ADEMark's CLOCK_UPTIME_RAW by the
// Mac's sleep since boot: a time from ADEMark's tools (the replay log's t_ns) is moved onto it with uptimeRawOffset().
export const now = () => Number(process.hrtime.bigint()) / 1e6;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const log = (...parts: Array<unknown>) =>
  console.error(`[ademark ${new Date().toISOString().slice(11, 19)}]`, ...parts);

export async function until<T>(
  what: string,
  check: () => T | undefined | false | Promise<T | undefined | false>,
  ms = 60_000,
  every = 25,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await Promise.resolve(check()).catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms: ${what}`);
    await sleep(every);
  }
}

export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });

/** ADEMark's checkout at the pinned commit, kept between runs in the user's cache folder. */
export function ademarkCheckout(): string {
  const caches =
    process.platform === "darwin"
      ? path.join(os.homedir(), "Library", "Caches")
      : (process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"));
  const dir = path.join(caches, "caveman-ademark", ADEMARK_COMMIT);
  if (!fs.existsSync(path.join(dir, "arena", "AGENTS.md"))) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    log(`fetching ADEMark ${ADEMARK_COMMIT.slice(0, 7)} into ${dir}`);
    const git = (...args: Array<string>) =>
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q");
    git("remote", "add", "origin", ADEMARK_REPO);
    git("fetch", "-q", "--depth", "1", "origin", ADEMARK_COMMIT);
    git("checkout", "-q", "FETCH_HEAD");
  }
  return dir;
}

/** ADEMark's native helper (bench/native, Swift), built once per commit. Its sampler needs no permission. */
export function nativeHelper(checkout: string): string {
  const bin = path.join(checkout, "bench", "native", "bin", "ademark-native");
  if (!fs.existsSync(bin)) {
    log("building ADEMark's native helper (swift, about a minute, once)");
    const built = spawnSync("bash", [path.join(checkout, "bench", "native", "build.sh")], {
      stdio: ["ignore", "ignore", "inherit"],
    });
    if (built.status !== 0)
      throw new Error(
        "ADEMark's native helper did not build: it needs Swift 6 with the Command Line Tools",
      );
  }
  return bin;
}

/** A fresh copy of the arena as a git repository: the same files and AGENTS.md canary for every run. */
export function makeArena(checkout: string, parent: string): string {
  const arena = path.join(parent, "arena");
  fs.cpSync(path.join(checkout, "arena"), arena, { recursive: true });
  const git = (...args: Array<string>) =>
    execFileSync("git", args, { cwd: arena, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", ".");
  git(
    "-c",
    "user.name=ADEMark",
    "-c",
    "user.email=arena@ademark.invalid",
    "commit",
    "-qm",
    "arena-v1",
  );
  return fs.realpathSync(arena);
}

export interface Profile {
  readonly root: string;
  readonly home: string;
  readonly userData: string;
  readonly arena: string;
}

/** A throwaway home and Electron profile: what ADEMark's `ademark` macOS user is to the app. */
export function newProfile(checkout: string): Profile {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "caveman-ademark-")));
  const home = path.join(root, "home");
  const userData = path.join(root, "user-data");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(userData, { recursive: true });
  return { root, home, userData, arena: makeArena(checkout, root) };
}

/** The app as packaged here (scripts/package.mjs --local), unless --app names another. */
export function packagedApp(override?: string): string {
  const app =
    override ??
    path.join(repoRoot, "apps", "desktop", "release", `mac-${process.arch}`, "Caveman Code.app");
  if (!fs.existsSync(path.join(app, "Contents", "MacOS", "Caveman Code")))
    throw new Error(
      `${app} is not built: run \`node apps/desktop/scripts/package.mjs --local\` first, or pass --app`,
    );
  return app;
}

/**
 * The environment of a run: the profile's home, the model API at `modelUrl` (ADEMark's replay server, or the token
 * tests' stand-in), and nothing that points at the person's own runtime, Claude config or Codex home.
 */
export function runEnv(
  profile: Profile,
  modelUrl: string,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: [
      path.join(os.homedir(), ".local", "bin"),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      "/usr/bin",
      "/bin",
      "/usr/sbin",
      "/sbin",
    ].join(":"),
    HOME: profile.home,
    USER: process.env.USER,
    LOGNAME: process.env.LOGNAME,
    SHELL: "/bin/zsh",
    LANG: "en_US.UTF-8",
    TMPDIR: os.tmpdir(),
    ANTHROPIC_BASE_URL: modelUrl,
    ANTHROPIC_API_KEY: "sk-" + "ant-api03-ademark-replay",
    // The stand-in answers in place of api.anthropic.com, so Claude Code treats it as Anthropic's own API, as the app
    // tells it to on that route (EngineEgress.ts routeClaudeOptions): otherwise a local URL reads as a gateway and Claude
    // Code turns tool search off, which no one on Anthropic's API sees.
    _CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL: "1",
    // Test builds only: no update check, no telemetry leaving this computer.
    CAVEMAN_UPDATE_FEED_URL: "http://127.0.0.1:9/ademark-no-updates",
    CAVEMAN_TELEMETRY_URL: "http://127.0.0.1:9/ademark-no-telemetry",
    ...extra,
  };
  return env;
}

/**
 * now() minus ADEMark's clock (CLOCK_UPTIME_RAW, its core/clock.ts read on Bun), in ms: the round trip to a Bun that
 * reads it, the shortest of a few, its middle taken as the moment Bun read it (within a fraction of a millisecond).
 */
export async function uptimeRawOffset(checkout: string): Promise<number> {
  const clock = path.join(checkout, "bench", "core", "clock.ts");
  const script = `import { nowNs } from ${JSON.stringify(clock)}; for await (const _ of console) console.log(String(nowNs()));`;
  const child = spawn("bun", ["-e", script], { stdio: ["pipe", "pipe", "inherit"] });
  const lines: Array<string> = [];
  let buffered = "";
  child.stdout!.on("data", (c) => {
    buffered += c;
    const parts = buffered.split("\n");
    buffered = parts.pop()!;
    lines.push(...parts);
  });
  try {
    let best = { rtt: Infinity, offset: 0 };
    for (let i = 0; i < 8; i++) {
      const before = now();
      child.stdin!.write("t\n");
      const line = await until("ADEMark's clock", () => lines.shift(), 10_000, 0);
      const after = now();
      if (after - before < best.rtt)
        best = { rtt: after - before, offset: (before + after) / 2 - Number(BigInt(line)) / 1e6 };
    }
    return best.offset;
  } finally {
    child.kill("SIGTERM");
  }
}

/** A request the replay server answered, as its log has it, with `t` its time on now()'s clock. */
export interface ReplayRequest {
  readonly t_ns: number;
  readonly t: number;
  readonly path: string;
  readonly session: string | null;
  readonly bytes: number;
  readonly user_agent?: string | null;
}

/** ADEMark's replay server (bench/replay) from the pinned checkout, on Bun, logging every request it answers. */
export async function startReplay(
  checkout: string,
  logPath: string,
): Promise<{ url: string; stop: () => void; requests: () => Array<ReplayRequest> }> {
  const port = await freePort();
  const child = spawn(
    "bun",
    [
      path.join(checkout, "bench", "replay", "server.ts"),
      "--port",
      String(port),
      "--sessions",
      path.join(checkout, "bench", "replay", "sessions"),
      "--log",
      logPath,
    ],
    {
      cwd: checkout,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout!.on("data", (c) => (output += c));
  child.stderr!.on("data", (c) => (output += c));
  await until(
    "the replay server",
    async () =>
      (await fetch(`http://127.0.0.1:${port}/health`).catch(() => null)) !== null ||
      output.includes("listening"),
    20_000,
  );
  const offset = await uptimeRawOffset(checkout);
  return {
    url: `http://127.0.0.1:${port}`,
    stop: () => child.kill("SIGTERM"),
    requests: () =>
      fs.existsSync(logPath)
        ? fs
            .readFileSync(logPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((l) => {
              const entry = JSON.parse(l) as Omit<ReplayRequest, "t">;
              return { ...entry, t: entry.t_ns / 1e6 + offset };
            })
        : [],
  };
}

// ------------------------------------------------------------------ the runtime alone

export interface Runtime {
  readonly child: ChildProcess;
  readonly client: SessionClient;
  stop(): Promise<void>;
}

/** The Claude Code the Agent SDK ships for this platform, pinned by the lockfile: the same CLI on every machine. */
export function sdkClaude(): string {
  const sdk = createRequire(path.join(repoRoot, "packages", "runtime", "package.json")).resolve(
    "@anthropic-ai/claude-agent-sdk",
  );
  const platform = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  return path.join(path.dirname(createRequire(sdk).resolve(`${platform}/package.json`)), "claude");
}

/**
 * The runtime alone, headless on the profile: how the seed and the token tests drive chats. `app` runs the packaged
 * app's own runtime on its own Node; "source" runs packages/runtime/src/bin.ts on this Node (what CI has). `claude`
 * pins the Claude Code that Claude Agent runs (settings.json binaryPath); without it the runtime finds one on PATH.
 */
export async function startRuntime(
  app: string | "source",
  env: NodeJS.ProcessEnv,
  options: { claude?: string } = {},
): Promise<Runtime> {
  if (options.claude !== undefined) {
    const state = path.join(env.HOME!, ".caveman-code", "userdata");
    fs.mkdirSync(state, { recursive: true });
    fs.writeFileSync(
      path.join(state, "settings.json"),
      JSON.stringify({
        providerInstances: {
          claudeAgent: { driver: "claudeAgent", config: { binaryPath: options.claude } },
        },
      }),
    );
  }
  const resources = path.join(app, "Contents", "Resources", "runtime");
  const [node, entry] =
    app === "source"
      ? [process.execPath, path.join(repoRoot, "packages", "runtime", "src", "bin.ts")]
      : [path.join(resources, "node"), path.join(resources, "bin.mjs")];
  const port = await freePort();
  const child = spawn(node, [entry, "--port", String(port)], {
    env: { ...env, CAVEMAN_CODE_NO_BROWSER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", (c) => (output += c));
  child.stderr!.on("data", (c) => (output += c));
  // until() reads a failed check as "not yet", so a runtime that exits first is raced on its own.
  const exited = new Promise<never>((_, reject) =>
    child.once("exit", (code, signal) =>
      reject(new Error(`it exited (${code ?? signal}) before listening`)),
    ),
  );
  // A runtime stopped later rejects it too: handled here, so that is no unhandled rejection.
  exited.catch(() => undefined);
  await Promise.race([
    until("the runtime to listen", () => output.includes("Listening on"), 90_000),
    exited,
  ]).catch((error: unknown) => {
    child.kill("SIGKILL");
    throw new Error(`the runtime did not start: ${String(error)}\n${output.slice(-2000)}`);
  });
  const tokenFile = path.join(env.HOME!, ".caveman-code", "userdata", "session-protocol.token");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, () =>
    fs.readFileSync(tokenFile, "utf8"),
  );
  return {
    child,
    client,
    stop: async () => {
      client.close();
      const exited = new Promise((r) => child.once("exit", r));
      child.kill("SIGTERM");
      await Promise.race([exited, sleep(15_000)]);
      if (child.exitCode === null) child.kill("SIGKILL");
    },
  };
}

type SessionEvent = { type: string; payload: Record<string, unknown> };

/** A chat in the arena on Claude Agent (Opus 5.5, high, as ADEMark pins it); `prompt` is its first turn, run to its end. */
export async function chat(
  runtime: Runtime,
  arena: string,
  prompt: string,
  id: string,
  timeoutMs = 180_000,
): Promise<{ workspaceId: string; events: Array<SessionEvent> }> {
  const workspace = (await runtime.client.call("workspace.create", {
    // Unique per call: the runtime answers a repeated request_id with its first result, so a reused profile would
    // get an old chat back and send no request.
    request_id: `ademark-${id}-${randomUUID()}`,
    repo: { path: arena },
    title: id,
    engine: "claude-agent",
    options: { model: "claude-opus-5-5", effort: "high" },
  })) as { id: string; session_id: string };
  const events: Array<SessionEvent> = [];
  await runtime.client.attach(workspace.session_id, 0, (event: SessionEvent) => events.push(event));
  await runtime.client.call("turn.submit", {
    request_id: `ademark-${id}-turn-${randomUUID()}`,
    session_id: workspace.session_id,
    kind: "followup",
    input: { text: prompt },
  });
  await until(`the ${id} turn to end`, () => events.some((e) => e.type === "turn.done"), timeoutMs);
  return { workspaceId: workspace.id, events };
}

// ------------------------------------------------------------------ the app

export interface LaunchedApp {
  readonly child: ChildProcess;
  readonly pid: number;
  /** When the launch was posted (ADEMark's t0), in `now()` ms. */
  readonly t0: number;
  /** The app's page over CDP (playwright-core), once it has one. */
  page(): Promise<import("playwright-core").Page>;
  /** A normal quit: SIGTERM, which the app treats as Quit with nobody to ask (main.ts onQuitSignal). */
  quit(): Promise<number>;
}

const { chromium } = createRequire(path.join(repoRoot, "packages", "runtime", "package.json"))(
  "playwright-core",
) as typeof import("playwright-core");

export function launchApp(app: string, profile: Profile, env: NodeJS.ProcessEnv): LaunchedApp {
  const exe = path.join(app, "Contents", "MacOS", "Caveman Code");
  // An app outside /Applications first offers to move there (moveToApplications.ts); this profile said Not Now.
  const plist = fs.readFileSync(path.join(app, "Contents", "Info.plist"), "utf8");
  const version = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
    plist,
  )?.[1];
  fs.writeFileSync(
    path.join(profile.userData, "move-to-applications.json"),
    JSON.stringify({ notNow: version }),
  );
  // --use-mock-keychain: a test build is ad-hoc signed, so the person's keychain would ask for their password.
  const t0 = now();
  const child = spawn(
    exe,
    [`--user-data-dir=${profile.userData}`, "--remote-debugging-port=0", "--use-mock-keychain"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout!.on("data", (d) => (output += d));
  child.stderr!.on("data", (d) => (output += d));
  let page: Promise<import("playwright-core").Page> | undefined;
  return {
    child,
    pid: child.pid!,
    t0,
    page: () =>
      (page ??= (async () => {
        const port = await until(
          "the app's DevTools port",
          () => /DevTools listening on ws:\/\/127\.0\.0\.1:(\d+)\//.exec(output)?.[1],
          60_000,
          5,
        );
        const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, {
          timeout: 30_000,
        });
        return until(
          "the app's page",
          () =>
            browser
              .contexts()
              .flatMap((c) => c.pages())
              .find(
                (p) =>
                  p.url().startsWith("caveman-code://app/") && !/capture|notch|guide/.test(p.url()),
              ),
          60_000,
          5,
        );
      })()),
    quit: async () => {
      const started = now();
      if (child.exitCode === null) {
        const exited = new Promise((r) => child.once("exit", r));
        child.kill("SIGTERM");
        await Promise.race([exited, sleep(45_000)]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      return now() - started;
    },
  };
}

/** Every process under `pid`, with its parent and command: what a quit must leave gone, and what A9 weighs. */
export function processTree(pid: number): Array<{ pid: number; ppid: number; command: string }> {
  const rows = execFileSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" })
    .split("\n")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3]! }));
  const tree = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows)
      if (!tree.has(row.pid) && tree.has(row.ppid)) {
        tree.add(row.pid);
        grew = true;
      }
  }
  return rows.filter((r) => tree.has(r.pid));
}

// ------------------------------------------------------------------ the sampler

export interface SampleSummary {
  ticks: number;
  app_median_b: number;
  app_p95_b: number;
  agents_median_b: number;
  total_median_b: number;
  total_p95_b: number;
  /** From the CSV: CPU of the app group over the window, % of one core (A6). */
  app_cpu_percent: number;
  /** Idle and interrupt wakeups of the app group per second (A6). */
  app_wakeups_per_s: number;
  /** Median number of agent subtrees alive. */
  agent_count: number;
  /** The largest app-group processes at the window's end, for the report. */
  top: Array<{ exe: string; group: string; mb: number; cpu: number }>;
}

/**
 * ADEMark's sampler (`ademark-native sample`, TESTS.md §1.2) over the app's tree: phys_footprint at 4 Hz, the app group
 * and the agents group (every `claude` subtree) apart, as A5, A6 and A7 read them.
 */
export async function sample(
  helper: string,
  rootPid: number,
  seconds: number,
  dir: string,
): Promise<SampleSummary> {
  const rules = path.join(dir, `rules-${rootPid}.json`);
  const csv = path.join(dir, `samples-${rootPid}-${Date.now()}.csv`);
  fs.writeFileSync(
    rules,
    JSON.stringify({
      rootPids: [rootPid],
      bundlePaths: [],
      vendorDirs: [],
      agentExecutables: ["claude", "codex", `${os.homedir()}/.local/share/claude/versions/`],
      excludeNames: [],
      harnessPids: [process.pid],
    }),
  );
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(
      helper,
      ["sample", "--rules", rules, "--hz", "4", "--duration-s", String(seconds), "--csv", csv],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let text = "";
    child.stdout.on("data", (c) => (text += c));
    child.once("exit", (code) =>
      code === 0
        ? resolve(text)
        : reject(new Error(`ademark-native sample exited ${code}: ${text}`)),
    );
  });
  const summary = JSON.parse(out) as Omit<
    SampleSummary,
    "app_cpu_percent" | "app_wakeups_per_s" | "agent_count" | "top"
  >;
  // Per process: first and last cumulative CPU and wakeups; the window is the first to the last tick.
  const rows = fs
    .readFileSync(csv, "utf8")
    .split("\n")
    .slice(1)
    .filter(Boolean)
    .map((line) => {
      const cells = line
        .match(/("([^"]|"")*"|[^,]*)(,|$)/g)!
        .map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"'));
      return {
        t: Number(cells[0]),
        pid: Number(cells[1]),
        ppid: Number(cells[2]),
        group: cells[3]!,
        exe: cells[4]!,
        mem: Number(cells[5]),
        cpu: Number(cells[7]) + Number(cells[8]),
        wake: Number(cells[9]) + Number(cells[10]),
      };
    });
  const ticks = [...new Set(rows.map((r) => r.t))].sort((a, b) => a - b);
  const span = ((ticks.at(-1) ?? 0) - (ticks[0] ?? 0)) / 1e9;
  let cpuNs = 0;
  let wakeups = 0;
  const byPid = new Map<number, Array<(typeof rows)[number]>>();
  for (const row of rows)
    if (row.group === "app") byPid.set(row.pid, [...(byPid.get(row.pid) ?? []), row]);
  for (const series of byPid.values()) {
    cpuNs += series.at(-1)!.cpu - series[0]!.cpu;
    wakeups += series.at(-1)!.wake - series[0]!.wake;
  }
  const agentCounts = ticks.map((t) => {
    const atTick = rows.filter((r) => r.t === t && r.group === "agents");
    const pids = new Set(atTick.map((r) => r.pid));
    return atTick.filter((r) => !pids.has(r.ppid)).length;
  });
  const last = rows.filter((r) => r.t === ticks.at(-1)).sort((a, b) => b.mem - a.mem);
  const cpuOf = (pid: number) => {
    const series = rows.filter((r) => r.pid === pid);
    return span > 0 && series.length > 1
      ? ((series.at(-1)!.cpu - series[0]!.cpu) / 1e9 / span) * 100
      : 0;
  };
  return {
    ...summary,
    app_cpu_percent: span > 0 ? (cpuNs / 1e9 / span) * 100 : 0,
    app_wakeups_per_s: span > 0 ? wakeups / span : 0,
    agent_count: agentCounts.sort((a, b) => a - b)[Math.floor(agentCounts.length / 2)] ?? 0,
    top: last.slice(0, 10).map((r) => ({
      exe: path.basename(r.exe),
      group: r.group,
      mb: Math.round(r.mem / 1048576),
      cpu: Number(cpuOf(r.pid).toFixed(3)),
    })),
  };
}

export const mb = (bytes: number) => bytes / 1048576;
