// Grill mode on a real engine, through the real runtime: one default turn,
// then a grill session the script answers with each round's recommended
// options, until grill.finished; then back to default. It uses your own
// signed-in `claude` or `codex` (your HOME; it never reads their login; Codex
// gets the chatGptLogin setting) and a scratch runtime home and repo. It calls
// the model, so it uses your plan.
//
//   node packages/runtime/scripts/grill-live.ts claude-agent|codex [model] [effort]
//
// It prints the session events, then what the engine was given in each mode,
// from the runtime's native provider log. GRILL_LIVE_KEEP=1 keeps the scratch dir;
// GRILL_LIVE_ANSWER_DELAY_S=360 leaves the first round open for 6 minutes.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, type EngineId, type SessionEvent } from "@caveman-app/session-protocol";

const [engineArg = "claude-agent", model, effort] = process.argv.slice(2);
/** GRILL_LIVE_ANSWER_DELAY_S: how long the first round is left unanswered. */
const answerDelayMs = Number(process.env.GRILL_LIVE_ANSWER_DELAY_S ?? 0) * 1000;
const engine = engineArg as EngineId;
const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "caveman-grill-live-"));
const runtimeHome = path.join(scratch, "runtime");
const stateDir = path.join(runtimeHome, "userdata");
fs.mkdirSync(stateDir, { recursive: true });
if (engine === "codex")
  fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ providerInstances: { codex: { driver: "codex", config: { chatGptLogin: true } } } }));

const repo = path.join(scratch, "repo");
fs.mkdirSync(repo);
const git = (...args: Array<string>) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "# todo\n\nA tiny Node CLI: `todo add <text>`, `todo list`. Todos live in todos.json.\n");
fs.writeFileSync(
  path.join(repo, "todo.mjs"),
  'import fs from "node:fs";\nconst file = "todos.json";\nconst todos = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : [];\nconst [cmd, ...rest] = process.argv.slice(2);\nif (cmd === "add") { todos.push({ text: rest.join(" ") }); fs.writeFileSync(file, JSON.stringify(todos)); }\nelse for (const [i, t] of todos.entries()) console.log(`${i + 1}. ${t.text}`);\n',
);
git("add", ".");
git("-c", "user.name=grill", "-c", "user.email=grill@example.invalid", "commit", "-qm", "init");

const started = Date.now();
const log = (...parts: Array<unknown>) => console.log(`[grill ${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s]`, ...parts);
const fail = (message: string): never => {
  throw new Error(`GRILL LIVE FAILED: ${message}`);
};
const until = async (what: string, check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};
const port = await new Promise<number>((resolve) => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1", () => {
    const p = (server.address() as net.AddressInfo).port;
    server.close(() => resolve(p));
  });
});

let runtime: ChildProcess | undefined;
try {
  runtime = spawn(process.execPath, [bin, "--port", String(port)], {
    env: { ...process.env, CAVEMAN_CODE_HOME: runtimeHome, CAVEMAN_CODE_NO_BROWSER: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  runtime.stdout!.on("data", (chunk) => (output += chunk));
  runtime.stderr!.on("data", (chunk) => (output += chunk));
  log(`runtime pid ${runtime.pid}, scratch ${scratch}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 60_000);

  const client = connect(`ws://127.0.0.1:${port}/session/v1`, () => fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8"));
  // The engines' probes finish after the runtime listens.
  let { engines } = await client.call("engine.list", {});
  for (let i = 0; i < 60 && engines.find((e) => e.id === engine)?.auth.state === "unavailable"; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    ({ engines } = await client.call("engine.list", {}));
  }
  log(`engine.list: ${engines.map((e) => `${e.id} grill_mode=${e.capabilities.grill_mode ?? false} auth=${e.auth.state}`).join("; ")}`);
  const target = engines.find((e) => e.id === engine) ?? fail(`no ${engine} engine`);
  if (target.auth.state === "signed_out" || target.auth.state === "unavailable") fail(`${engine} is ${target.auth.state}`);

  const workspace = await client.call("workspace.create", {
    request_id: "grill-live-create",
    repo: { path: repo },
    title: "Grill live",
    engine,
    options: { access: "full", ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
  });
  const events: Array<SessionEvent> = [];
  await client.attach(workspace.session_id, 0, (event) => {
    events.push(event);
    const p = event.payload as Record<string, unknown>;
    if (event.type === "turn.started") log(`turn.started model=${p.model} effort=${p.effort} mode=${p.mode}`);
    else if (event.type === "tool.started") log(`tool.started ${p.name} ${JSON.stringify(p.input ?? {}).slice(0, 140)}`);
    else if (event.type === "tool.done") log(`tool.done ${p.status} ${JSON.stringify(p.result ?? p.error ?? "").slice(0, 160)}`);
    else if (event.type === "message.done") log(`message.done ${p.role}: ${String(p.text).replace(/\s+/g, " ").slice(0, 220)}`);
    else if (event.type === "ask.resolved") log(`ask.resolved ${event.item_id} ${JSON.stringify(p).slice(0, 160)}`);
    else if (event.type === "grill.finished" || event.type === "turn.done" || event.type === "error") log(`${event.type} ${JSON.stringify(p)}`);
  });
  const mode = async () => {
    const other = connect(`ws://127.0.0.1:${port}/session/v1`, () => fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8"));
    try {
      return (await other.call("session.attach", { session_id: workspace.session_id, cursor: 0 })).session.mode ?? "default";
    } finally {
      other.close();
    }
  };
  const doneTurns = () => events.filter((e) => e.type === "turn.done").length;
  // In default mode the engine must not see the grill tools: its one-line answer names none.
  const noGrillTools = (turn: string) => {
    const answer = events.filter((e) => e.type === "message.done" && (e.payload as { role?: string }).role === "assistant").at(-1);
    const text = String((answer?.payload as { text?: string } | undefined)?.text ?? "");
    if (/grill/i.test(text)) fail(`${turn} still sees grill tools: ${text.slice(0, 200)}`);
  };
  let submits = 0;
  const submit = async (text: string, mode?: "default" | "grill") => {
    const before = doneTurns();
    await client.call("turn.submit", { request_id: `grill-live-${++submits}`, session_id: workspace.session_id, kind: "followup", input: { text }, ...(mode ? { options: { mode } } : {}) });
    log(`turn.submit${mode ? ` mode=${mode}` : ""}: ${text}`);
    return before;
  };

  // 1. Default mode.
  const d = await submit("Reply with one line: the names of any tools you can call that contain the word grill, or NONE.");
  await until("the default turn", () => doneTurns() > d, 300_000);
  noGrillTools("the default turn");
  log(`session.mode after the default turn: ${await mode()}`);

  // 2. Grill mode: answer every round with its recommendations.
  let before = await submit("Grill me on adding a `todo done <n>` command to this CLI. It is small: keep it to two short rounds at most.", "grill");
  log(`session.mode after the grill submit: ${await mode()}`);
  const answered = new Set<string>();
  let nudges = 0;
  while (!events.some((e) => e.type === "grill.finished")) {
    if (Date.now() - started > 25 * 60_000) fail("the grill session took over 25 minutes");
    const open = events.find((e) => e.type === "ask.user" && !answered.has(e.item_id!) && !events.some((r) => r.type === "ask.resolved" && r.item_id === e.item_id));
    if (open?.type === "ask.user" && open.payload.kind === "question") {
      answered.add(open.item_id!);
      log(`ask.user ${open.item_id} round=${open.payload.round}`);
      for (const q of open.payload.questions) {
        log(`  ${q.id} ${q.prompt} | options: ${q.options.map((o) => `${o.id} ${o.label}`).join(" / ")} | recommended=${q.recommended} | multi_select=${q.multi_select} allow_text=${q.allow_text}`);
        if (q.detail) log(`     detail: ${q.detail.replace(/\s+/g, " ").slice(0, 200)}`);
      }
      if (answered.size === 1 && answerDelayMs > 0) {
        // A person who leaves the first round open: the engine's MCP client must keep waiting.
        log(`leaving ${open.item_id} unanswered for ${answerDelayMs / 1000}s`);
        const waitStart = Date.now();
        const from = events.indexOf(open);
        const ended = () =>
          events.slice(from).find(
            (e) =>
              (e.type === "ask.resolved" && e.item_id === open.item_id) ||
              (e.type === "tool.done" && String((e.payload as { name?: string }).name).includes("grill_round")) ||
              e.type === "turn.done",
          );
        while (Date.now() - waitStart < answerDelayMs && ended() === undefined) await new Promise((r) => setTimeout(r, 1000));
        const end = ended();
        if (end) fail(`the round ended ${((Date.now() - waitStart) / 1000).toFixed(0)}s into the wait: ${end.type} ${JSON.stringify(end.payload).slice(0, 300)}`);
        log(`${open.item_id} still open after ${((Date.now() - waitStart) / 1000).toFixed(0)}s; answering`);
      }
      await client.call("ask.respond", {
        request_id: `grill-live-ask-${answered.size}`,
        session_id: workspace.session_id,
        ask_id: open.item_id!,
        response: { kind: "question", answers: open.payload.questions.map((q) => ({ question_id: q.id, option_ids: [q.recommended ?? q.options[0]!.id] })) },
      });
      log(`ask.respond ${open.item_id}: recommended options`);
      continue;
    }
    if (doneTurns() > before) {
      // The turn ended without finishing (e.g. it asked in prose): nudge, as a person would.
      if (++nudges > 3) fail("the engine kept ending its turn without grill_finish");
      before = await submit("Go with your recommendations for anything still open, then wrap up: write the decisions doc and finish.");
      continue;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  await until("the grill turn to end", () => doneTurns() > before, 300_000);
  const finished = events.find((e) => e.type === "grill.finished")!.payload as { doc_path: string; summary: string };
  const doc = path.join(workspace.root_path ?? repo, finished.doc_path);
  log(`decisions doc ${finished.doc_path} exists=${fs.existsSync(doc)}`);
  if (fs.existsSync(doc)) console.log(fs.readFileSync(doc, "utf8").split("\n").slice(0, 30).join("\n"));

  // 3. Back to default ("Build it" would be this turn).
  const b = await submit("Thanks. Do not build yet: reply with one line, the names of any tools you can call that contain the word grill, or NONE.", "default");
  await until("the default turn after grill", () => doneTurns() > b, 300_000);
  noGrillTools("the default turn after grill");
  log(`session.mode at the end: ${await mode()}`);
  client.close();

  // What the engine itself was given, from the runtime's native log.
  const logs = path.join(stateDir, "logs", "provider");
  const lines = fs.readdirSync(logs).filter((f) => f.startsWith("events.")).flatMap((f) => fs.readFileSync(path.join(logs, f), "utf8").split("\n"));
  log(`native log: ${lines.length} lines`);
  for (const line of lines) {
    if (line.includes('"subtype":"init"')) {
      const servers = [...(line.match(/"mcp_servers":\[(.*?)\]/)?.[1] ?? "").matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
      const tools = [...(line.match(/"tools":\[(.*?)\]/)?.[1] ?? "").matchAll(/"(mcp__caveman-grill__\w+)"/g)].map((m) => m[1]);
      log(`  claude init: mcp_servers ending [${servers.slice(-2).join(",")}]; grill tools [${tools.join(",")}]`);
    } else if (line.includes("query.set_mcp_servers")) log(`  claude setMcpServers ${line.match(/"servers":\[[^\]]*\]/)?.[0]}`);
    else if (line.includes('"/caveman-grill:grill ')) log("  claude user message: /caveman-grill:grill <text>");
    if (!line.includes('"direction":"outgoing"')) continue;
    for (const m of line.matchAll(/"method":"(thread\/(?:start|resume|unsubscribe)|turn\/start)"/g)) {
      const servers = [...new Set([...line.matchAll(/"(caveman-code|caveman-grill)":\{/g)].map((s) => s[1]))];
      const skill = line.includes("<name>grill</name>") ? " with the grill skill" : "";
      log(`  codex ${m[1]}${m[1] === "turn/start" ? skill : ` mcp_servers=[${servers.join(",")}]`}`);
    }
  }
  log("GRILL LIVE OK");
} finally {
  if (runtime && runtime.exitCode === null) {
    const exited = new Promise((r) => runtime!.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
    log(`runtime pid ${runtime.pid} stopped`);
  }
  if (!process.env.GRILL_LIVE_KEEP) fs.rmSync(scratch, { recursive: true, force: true });
  else log(`kept ${scratch}`);
}
