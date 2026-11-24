/**
 * Connector-suite runner over the app's Caveman engine (harness-v3 connector-run, arm kind `app`): one task, or a
 * whole session as one conversation with one user message per turn, headless, with the task world's MCP servers.
 *
 *   node connector-runner.ts --model anthropic/claude-opus-5-5 --effort high \
 *     --base-url http://127.0.0.1:18091 --api-key-env TB4_TRIAL_TOKEN --mcp-config mcp.json --logs <dir> \
 *     (--prompt-file instruction.txt | --messages-file messages.json [--on-turn-end '<sh command>']) \
 *     [--exec local[:<dir>] | docker:<container>:<dir> | backend:<container>:<dir>] [--max-wall-s 900]
 *
 * The engine is the harness (harness.ts), as adapter.ts builds a coding thread's session: the app loadout for the
 * model (v4's compact surface plus programs on Claude, Codex's exec surface on GPT), the task's MCP servers reached
 * from programs or exec cells, the runtime text every thread gets (UI_PROOF_INSTRUCTIONS plus the runtime blocks for
 * the tools it has: none here), one HarnessSession across turns with its cache keep-alive, a full-access turn (no
 * approvals), and the app's model registry (credentials.ts cavemanModels: the key store's credential only).
 *
 * `--api-key-env NAME`: the variable holding the key (in the bench, the proxy's trial token). It goes into the
 * engine's key store, as Settings would put a key, and leaves this process's environment before any tool runs. Every
 * model of the lead's provider calls `--base-url` (OpenAI: with /v1), so every request is metered there.
 *
 * `--exec`: where commands and file tools run. `local` (default: the cwd) is a full-access thread on This Mac: reads
 * anywhere. `docker:<container>:<dir>` runs them in a running container through the harness's DockerEnv (streamed
 * output, background processes). `backend:<container>:<dir>` runs them there through an execution backend over
 * `docker exec` and the app's BackendEnv, exactly as a Cloud computer's thread runs them in its tools container. In
 * both, reads stay in the workspace. MCP servers always run on this host.
 *
 * Sessions: `--messages-file` is `{"messages": [...]}` or a JSON array of strings or `{message}` objects. After each
 * turn `--on-turn-end` runs through /bin/sh with HARNESS_TURN=<n> and the turn's final text on stdin, before the next
 * message is sent (the v4 harness's hook contract; the connector bench's session-step.mjs).
 *
 * Writes to --logs: events.jsonl (every session event with its turn, without streaming deltas) and result.json
 * ({stop_reason, final_text, usage, cost_usd (the harness's list-price count), turns[]}). Prints one bench.config
 * line, one bench.turn line per turn and one bench.stop line.
 *
 * @module provider-caveman/bench/connector-runner
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { UI_PROOF_INSTRUCTIONS } from "@caveman-app/engine-core/server/runtimeInstructions";
import type { ExecRequest, ExecResult, ExecutionBackend } from "@caveman-ai/agent/execution-backend";
import type { Api, Model, MutableModels } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";

import { BackendEnv } from "../src/server/backendEnv.ts";
import { cavemanModels } from "../src/server/credentials.ts";
import { effortLevel } from "../src/server/engineConfig.ts";
import { runtimeInstructionBlocks, runtimeTextChoice } from "../src/server/runtimeText.ts";
import type * as Harness from "@caveman-ai/harness";
import { harnessMcpServers, loadHarness, WorkspaceEnv, type CavemanMcpServerEntry } from "../src/server/harness.ts";

function sessionMessages(value: unknown): string[] {
  const list = Array.isArray(value) ? value : (value as { messages?: unknown }).messages;
  if (!Array.isArray(list)) throw new Error("--messages-file: expected an array or {messages: [...]}");
  return list.map((item, i) => {
    const text = typeof item === "string" ? item : (item as { message?: unknown }).message;
    if (typeof text !== "string") throw new Error(`--messages-file: message ${i + 1} is not text`);
    return text;
  });
}

/** `--mcp-config` (`{"mcpServers": {...}}`) as adapter.ts passes a Space's servers started here (cavemanMcpServers, stdio "local"). */
function mcpServers(file: string | undefined): CavemanMcpServerEntry[] {
  if (file === undefined) return [];
  const servers = (JSON.parse(readFileSync(file, "utf8")) as { mcpServers?: Record<string, Record<string, unknown>> }).mcpServers ?? {};
  return Object.entries(servers).flatMap(([name, server]): CavemanMcpServerEntry[] => {
    if (typeof server.command === "string") {
      const env = server.env as Record<string, string> | undefined;
      const cwd = server.cwd as string | undefined;
      return [{ name, source: "space", config: { command: server.command, args: [...((server.args as string[] | undefined) ?? [])], ...(env === undefined ? {} : { env }), ...(cwd === undefined ? {} : { cwd }) } }];
    }
    if (typeof server.url === "string") return [{ name, source: "space", config: { url: server.url, headers: (server.headers as Record<string, string> | undefined) ?? {} } }];
    throw new Error(`--mcp-config: server ${name} has neither command nor url`);
  });
}

// ── where tools run ───────────────────────────────────────

interface Placement {
  readonly label: string;
  readonly workspace: string;
  /** Where: this host, a container through the harness's DockerEnv, or a container through an execution backend. */
  readonly kind: "local" | "docker" | "backend";
  readonly container?: string;
}

function placement(spec: string): Placement {
  if (spec === "local" || spec.startsWith("local:")) {
    const workspace = resolve(spec === "local" ? process.cwd() : spec.slice("local:".length));
    return { label: `local:${workspace}`, workspace, kind: "local" };
  }
  const container = /^(docker|backend):([A-Za-z0-9][A-Za-z0-9_.-]*):(\/.*)$/u.exec(spec);
  if (container) return { label: spec, workspace: container[3]!, kind: container[1] as "docker" | "backend", container: container[2]! };
  throw new Error(`--exec ${spec}: expected local[:<dir>], docker:<container>:<dir> or backend:<container>:<dir>`);
}

/** Every process an exec started carries its id in its environment; this kills them all (the image has no pkill). */
const REAP = 'for p in /proc/[0-9]*; do if tr "\\0" "\\n" < "$p/environ" 2>/dev/null | grep -qx "CVB_EXEC_ID=$1"; then kill -KILL "${p#/proc/}" 2>/dev/null; fi; done';

function docker(argv: string[], input?: Uint8Array): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
  return new Promise((accept) => {
    const child = spawn("docker", argv, { stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (d: Buffer) => out.push(d));
    child.stderr!.on("data", (d: Buffer) => err.push(d));
    child.once("error", (error) => accept({ code: null, stdout: Buffer.alloc(0), stderr: error.message }));
    child.once("close", (code) => accept({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    if (input !== undefined) child.stdin!.end(input);
  });
}

/**
 * The execution backend contract (the runtime's CavemanExecutionBackend) over `docker exec` into a running container:
 * as the tools container's backend a Cloud computer's runtime uses, with the same output cap and timeout semantics as the SDK's local backend (one byte budget across
 * stdout and stderr; a timeout or abort kills the command's whole process tree).
 */
export function dockerExecutionBackend(container: string): ExecutionBackend {
  const errno = (code: string, message: string) => Object.assign(new Error(message), { code });
  return {
    id: `docker:${container}`,
    exec: (request: ExecRequest) =>
      new Promise<ExecResult>((accept) => {
        const id = randomUUID();
        const env = Object.entries(request.env).flatMap(([name, value]) => ["-e", `${name}=${value}`]);
        const child = spawn("docker", ["exec", "-w", request.cwd, ...env, "-e", `CVB_EXEC_ID=${id}`, container, request.command, ...request.args], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        let timedOut = false;
        let settled = false;
        const collect = (target: Buffer[]) => (chunk: Buffer) => {
          const remaining = request.maxOutputBytes - bytes;
          if (remaining <= 0) {
            truncated = true;
            return;
          }
          if (chunk.byteLength > remaining) truncated = true;
          const kept = chunk.subarray(0, remaining);
          bytes += kept.byteLength;
          target.push(kept);
        };
        child.stdout.on("data", collect(stdout));
        child.stderr.on("data", collect(stderr));
        let reaped = false;
        const reap = () => {
          if (reaped) return;
          reaped = true;
          void docker(["exec", container, "sh", "-c", REAP, "sh", id]);
          setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          reap();
        }, request.timeoutMs);
        request.signal?.addEventListener("abort", reap, { once: true });
        if (request.signal?.aborted === true) reap();
        const settle = (result: ExecResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", reap);
          accept(result);
        };
        child.once("error", (error) => settle({ stdout: "", stderr: error.message, code: 127, timedOut: false, truncated: false, startFailed: true }));
        child.once("close", (code) => {
          const err = Buffer.concat(stderr).toString("utf8");
          // docker's own failure to start the command (not found, bad cwd): 126/127 with the OCI runtime's message.
          const startFailed = (code === 126 || code === 127) && err.startsWith("OCI runtime exec failed");
          settle({ stdout: Buffer.concat(stdout).toString("utf8"), stderr: err, code, timedOut, truncated, ...(startFailed ? { startFailed } : {}) });
        });
      }),
    async readFile(path, opts) {
      const script = 'if [ -d "$1" ]; then exit 21; fi; [ -e "$1" ] || exit 2; if [ -n "$2" ]; then exec head -c "$2" -- "$1"; fi; exec cat -- "$1"';
      const res = await docker(["exec", container, "sh", "-c", script, "sh", path, opts?.maxBytes === undefined ? "" : String(opts.maxBytes)]);
      if (res.code === 2) throw errno("ENOENT", `ENOENT: no such file or directory, open '${path}'`);
      if (res.code === 21) throw errno("EISDIR", `EISDIR: illegal operation on a directory, read '${path}'`);
      if (res.code !== 0) throw new Error(`docker read ${path} failed (${res.code}): ${res.stderr.slice(0, 500)}`);
      return new Uint8Array(res.stdout);
    },
    async writeFile(path, data) {
      const res = await docker(["exec", "-i", container, "sh", "-c", 'mkdir -p -- "$(dirname -- "$1")" && cat > "$1"', "sh", path], data);
      if (res.code !== 0) throw new Error(`docker write ${path} failed (${res.code}): ${res.stderr.slice(0, 500)}`);
    },
  };
}

// ── the engine ────────────────────────────────────────────

interface Turn {
  readonly n: number;
  readonly text: string;
  readonly stopReason: string;
  readonly error?: string;
  /** Requests and tokens of every call, keep-alive pings and compaction summaries included. */
  readonly usage: Usage;
  readonly costUsd: number;
  readonly wallMs: number;
}

interface ConnectorEngine {
  /** What this engine is, for the bench.config line and result.json. */
  readonly config: Record<string, unknown>;
  /** One user message, one turn of the conversation. */
  turn(n: number, message: string, signal: AbortSignal): Promise<Turn>;
  close(): Promise<void>;
}

interface EngineSetup {
  readonly model: string;
  readonly provider: string;
  readonly effort: string;
  readonly baseURL: string;
  readonly key: string;
  readonly place: Placement;
  readonly servers: ReadonlyArray<CavemanMcpServerEntry>;
  readonly logs: string;
  readonly event: (n: number, event: Harness.SessionEvent) => void;
}

/** Every model of the lead's provider at `baseURL`, the rest untouched (adapter.ts modelsThroughScrub, one route). */
function modelsAt(source: MutableModels, from: string, baseURL: string): MutableModels {
  const rewrite = <M extends { readonly baseUrl: string } | undefined>(m: M): M => (m === undefined || m.baseUrl !== from ? m : { ...m, baseUrl: baseURL });
  return new Proxy(source, {
    get(target, property) {
      if (property === "getModel") return (p: string, id: string) => rewrite(target.getModel(p as never, id as never));
      if (property === "getModels") return (p: string) => target.getModels(p as never).map(rewrite);
      if (property === "getAvailable") return async (p?: string) => (await target.getAvailable(p as never)).map(rewrite);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

async function harnessEngine(setup: EngineSetup): Promise<ConnectorEngine> {
  const { model, provider, place } = setup;
  const h = await loadHarness();
  const registry = await Effect.runPromise(cavemanModels({ [provider]: { key: setup.key } }));
  const catalog = registry.getModel(provider as never, model.slice(provider.length + 1) as never) as Model<Api> | undefined;
  if (catalog === undefined) throw new Error(`${model} is not in the app's catalog`);
  const models = modelsAt(registry, catalog.baseUrl, setup.baseURL);
  const routed = models.getModel(provider as never, model.slice(provider.length + 1) as never) as Model<Api>;
  const reasoning = effortLevel(catalog, setup.effort);
  if (reasoning === undefined && catalog.reasoning) throw new Error(`${model} offers no effort "${setup.effort}"`);
  const effort = reasoning === undefined || reasoning === "off" ? undefined : (reasoning as Harness.Effort);
  const base: Harness.ExecEnv =
    place.kind === "local"
      ? new h.LocalEnv({ cwd: place.workspace })
      : place.kind === "docker"
        ? await h.DockerEnv.connect({ container: place.container!, cwd: place.workspace })
        : new BackendEnv({ backend: dockerExecutionBackend(place.container!), cwd: place.workspace });
  // adapter.ts: a full-access turn on This Mac reads anywhere; in the task container reads stay in the workspace.
  const env = new WorkspaceEnv(base, { root: place.workspace, hidden: null, readAnywhere: place.kind === "local" });
  const servers = harnessMcpServers(setup.servers);
  const mcp = Object.keys(servers).length === 0 ? undefined : await h.connectMcp(servers, { tolerant: true, clientName: "caveman-code", timeoutMs: 30 * 60_000 });
  for (const failed of mcp?.failed ?? []) console.error(`MCP server ${failed.server} did not connect: ${failed.error}`);
  const instructions = [UI_PROOF_INSTRUCTIONS, ...runtimeInstructionBlocks(runtimeTextChoice(undefined))].map((text) => text.trim()).join("\n\n");
  const loadout = h.appLoadoutFor(routed as never);
  const session = new h.HarnessSession({
    model: routed as never,
    stream: (m, c, o) => models.streamSimple(m, c, o),
    effort,
    loadout,
    env,
    mcp: mcp?.tools ?? [],
    instructions,
  });
  return {
    config: {
      engine: "harness",
      sdk: "vendored @caveman-ai/harness",
      path: "HarnessSession (adapter.ts harnessSessionFor), one conversation",
      loadout: loadout.name,
      loadout_hash: h.loadoutHash(loadout),
      reasoning: reasoning ?? null,
      tools: session.toolNames,
      instructions_chars: instructions.length,
      mcp_servers: setup.servers.map((s) => s.name),
      mcp_tools: (mcp?.tools ?? []).length,
    },
    async turn(n, message, signal) {
      const started = Date.now();
      const outcome = await session.runTurn(message, {
        signal,
        onEvent: (event) => {
          if (event.type === "pi" && event.event.type === "message_update") return; // deltas
          setup.event(n, event);
        },
      });
      const usage: Usage = {
        requests: outcome.usage.requests, input_tokens: outcome.usage.input, cached_input_tokens: outcome.usage.cacheRead,
        cache_write_tokens: outcome.usage.cacheWrite, output_tokens: outcome.usage.output, reasoning_tokens: outcome.usage.reasoning,
      };
      const stopReason = signal.aborted ? "wall" : outcome.status === "finished" ? "complete" : outcome.stopReason;
      return {
        n, text: outcome.finalText, stopReason, ...(outcome.error === undefined ? {} : { error: outcome.error }), usage,
        costUsd: outcome.usage.costUsd ?? 0, wallMs: Date.now() - started,
      };
    },
    async close() {
      await session.close();
      await mcp?.close();
    },
  };
}

// ── run ───────────────────────────────────────────────────

interface Usage {
  requests: number;
  input_tokens: number;
  cached_input_tokens: number;
  cache_write_tokens: number;
  output_tokens: number;
  reasoning_tokens: number;
}
const noUsage = (): Usage => ({ requests: 0, input_tokens: 0, cached_input_tokens: 0, cache_write_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });
function runHook(command: string, n: number, text: string): Promise<number | null> {
  return new Promise((accept) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { ...process.env, HARNESS_TURN: String(n) }, stdio: ["pipe", "inherit", "inherit"] });
    const timer = setTimeout(() => child.kill("SIGTERM"), 300_000);
    child.once("error", () => accept(null));
    child.once("close", (code) => {
      clearTimeout(timer);
      accept(code);
    });
    child.stdin!.on("error", () => {});
    child.stdin!.end(text);
  });
}

/** What ran: the app commit, whether the engine's sources differ from it, and this file. */
function provenance(): Record<string, unknown> {
  const here = fileURLToPath(import.meta.url);
  const app = resolve(dirname(here), "../../..");
  const git = (...argv: string[]) => spawnSync("git", ["-C", app, ...argv], { encoding: "utf8" }).stdout?.trim() ?? "";
  const dirty = git("status", "--porcelain", "--", "packages/provider-caveman/src", "packages/engine-core/src", "vendor", "pnpm-lock.yaml");
  return {
    app_commit: git("rev-parse", "--short=12", "HEAD"),
    app_dirty: dirty === "" ? [] : dirty.split("\n"),
    runner_sha256: createHash("sha256").update(readFileSync(here)).digest("hex"),
    node: process.version,
  };
}

/** The command line (see the module comment). */
async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      model: { type: "string" },
      effort: { type: "string" },
      "base-url": { type: "string" },
      "api-key-env": { type: "string" },
      "prompt-file": { type: "string" },
      "messages-file": { type: "string" },
      "on-turn-end": { type: "string" },
      "mcp-config": { type: "string" },
      logs: { type: "string" },
      exec: { type: "string", default: "local" },
      "max-wall-s": { type: "string", default: "900" },
    },
  });
  const usage =
    "usage: connector-runner.ts --model provider/model --effort E --base-url URL --api-key-env NAME " +
    "--mcp-config FILE --logs DIR (--prompt-file FILE | --messages-file FILE [--on-turn-end CMD]) [--exec local[:DIR]|docker:CONTAINER:DIR|backend:CONTAINER:DIR] [--max-wall-s S]";
  if (!args.model?.includes("/") || !args.effort || !args["base-url"] || !args["api-key-env"] || !args.logs || (!args["prompt-file"] && !args["messages-file"])) {
    throw new Error(usage);
  }
  const model = args.model;
  const provider = model.slice(0, model.indexOf("/"));
  const logs = resolve(args.logs);
  mkdirSync(logs, { recursive: true });
  const key = process.env[args["api-key-env"]];
  if (!key) throw new Error(`${args["api-key-env"]} is empty`);
  // The key lives only in the engine's key store from here.
  delete process.env[args["api-key-env"]];

  const messages: string[] = [
    ...(args["prompt-file"] ? [readFileSync(args["prompt-file"], "utf8")] : []),
    ...(args["messages-file"] ? sessionMessages(JSON.parse(readFileSync(args["messages-file"], "utf8"))) : []),
  ];
  if (messages.length === 0) throw new Error("no messages");
  const wallMs = Number(args["max-wall-s"]) * 1000;

  const place = placement(args.exec);
  const eventsFile = join(logs, "events.jsonl");
  writeFileSync(eventsFile, "");
  const setup: EngineSetup = {
    model,
    provider,
    effort: args.effort,
    baseURL: args["base-url"],
    key,
    place,
    servers: mcpServers(args["mcp-config"]),
    logs,
    event: (n, event) => appendFileSync(eventsFile, `${JSON.stringify({ n, ...event })}\n`),
  };
  const started = Date.now();
  const version = provenance();
  const engine = await harnessEngine(setup);
  console.log(JSON.stringify({ kind: "bench.config", model, effort: args.effort, exec: place.label, workspace: place.workspace, turns: messages.length, ...engine.config, version }));

  const deadline = new AbortController();
  const wallTimer = setTimeout(() => deadline.abort(), wallMs);
  const turns: Array<Record<string, unknown>> = [];
  const total = noUsage();
  let cost = 0;
  let stop = "done";
  let finalText = "";
  try {
    for (const [i, message] of messages.entries()) {
      const n = i + 1;
      if (deadline.signal.aborted) {
        stop = "wall";
        break;
      }
      const turn = await engine.turn(n, message, deadline.signal);
      const used = turn.usage;
      for (const field of Object.keys(total) as Array<keyof Usage>) total[field] += used[field];
      const turnCost = turn.costUsd;
      cost += turnCost;
      finalText = turn.text;
      const row = { n, stop_reason: turn.stopReason, ...(turn.error === undefined ? {} : { error: turn.error.slice(0, 2000) }), requests: used.requests,
        cost_usd: Math.round(turnCost * 1e6) / 1e6, wall_s: turn.wallMs / 1000, text_chars: turn.text.length, usage: used };
      turns.push(row);
      console.log(JSON.stringify({ kind: "bench.turn", ...row }));
      if (args["on-turn-end"]) {
        const code = await runHook(args["on-turn-end"], n, turn.text);
        if (code !== 0) console.error(`on-turn-end exited ${code} after turn ${n}`);
      }
      if (turn.stopReason !== "complete") stop = turn.stopReason;
      // A wall or a spend cap ends the session: the next message would only be refused.
      if (turn.stopReason === "wall" || /cap_reached|budget/u.test(`${turn.stopReason} ${turn.error ?? ""}`)) break;
    }
  } finally {
    clearTimeout(wallTimer);
    await engine.close().catch((cause) => console.error(`close: ${cause instanceof Error ? cause.message : cause}`));
    const result = {
      schema: 1,
      status: "finished",
      stop_reason: stop,
      engine: "harness",
      model,
      effort: args.effort,
      exec: place.label,
      version,
      usage: total,
      cost_usd: Math.round(cost * 1e6) / 1e6,
      timing: { wall_s: (Date.now() - started) / 1000 },
      final_text: finalText,
      turns,
    };
    writeFileSync(join(logs, "result.json"), JSON.stringify(result, null, 1));
    console.log(JSON.stringify({ kind: "bench.stop", stop_reason: stop, turns: turns.length, requests: total.requests, cost_usd: result.cost_usd }));
    process.exitCode = stop === "done" ? 0 : 1;
    // Whatever a tool left running (a server that ignored close) does not hold the trial open.
    setTimeout(() => process.exit(), 10_000).unref();
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
