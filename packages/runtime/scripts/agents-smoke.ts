// Agents smoke against a real `node packages/runtime/src/bin.ts` in a scratch home: a lead chat
// on the Caveman engine delegates three tasks (delegate_task, async) and each child's harness and
// model comes from Auto through a stand-in for Caveman Cloud's /v1/route. The model is a scripted
// OpenAI-compatible endpoint (an endpoint of the person's own, `custom-agents`), Claude Agent is
// scripts/smoke-claude.mjs, and Caveman credits use a test key against the same stand-in gateway
// (CAVEMAN_CREDITS_GATEWAY_URL), so no model is called, no login is read and nothing leaves the
// machine. Then the same delegation with Cloud failing (500), refusing the key (401), paused for
// quota and keeping the caller's default, a role pin in Settings > Subagents, a lead pin, and the depth
// limit. Every child's runner (subagent.started, the child Workspace) and every outcome sent back
// is checked. Then the Chief (its fast floor and its pick), one chat's agent asking another
// (thread_send through the engine's code tool), a chat pointed at another (@), and grill mode.
//
//   node packages/runtime/scripts/agents-smoke.ts [--port <runtime>] [--model-port <stand-in>]
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { connect, formatThreadReference, type SessionEvent, type SubagentRunner } from "@caveman-app/session-protocol";

const here = path.dirname(fileURLToPath(import.meta.url));
const bin = path.join(here, "..", "src", "bin.ts");
const fakeClaude = path.join(here, "smoke-claude.mjs");
const argPort = (name: string) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : Number(process.argv[i + 1]);
};
const freePort = () =>
  new Promise<number>((resolve) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const p = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(p));
    });
  });
/** --keep: leave the runtime up after the checks (for the web app) until SIGTERM or a `stop` file in the scratch dir. */
const keep = process.argv.includes("--keep");
/** --only-chief: skip the delegation phases. */
const onlyChief = process.argv.includes("--only-chief");
const port = argPort("--port") ?? (await freePort());
const modelPort = argPort("--model-port") ?? (await freePort());
const scratch = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "caveman-agents-smoke-"));
const home = path.join(scratch, "home");
const runtimeHome = path.join(scratch, "runtime");
const stateDir = path.join(runtimeHome, "userdata");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(stateDir, "secrets"), { recursive: true, mode: 0o700 });
fs.chmodSync(fakeClaude, 0o755);
fs.writeFileSync(path.join(stateDir, "settings.json"), JSON.stringify({ providerInstances: { claudeAgent: { driver: "claudeAgent", config: { binaryPath: fakeClaude } } } }));
// Caveman credits as a runtime that turned them on holds them: a credits key in the Caveman engine's
// credential slot (written unsealed; the runtime seals it on first read). Only the stand-in takes it.
const CREDITS_KEY = "cave_agents_smoke_0123456789";
const slot = createHash("sha256").update(`${"caveman".length}:cavemancaveman`).digest("hex");
const seedCredits = () =>
  fs.writeFileSync(path.join(stateDir, "secrets", `provider-auth-${slot}.bin`), JSON.stringify({ version: 2, providers: { caveman: { key: CREDITS_KEY } } }), { mode: 0o600 });
seedCredits();
// Auto asks Cloud only for a person signed in to it (src/router/routerKey.ts): a sign-in to the stand-in, which is
// that Cloud too, kept where an earlier build kept it unsealed (the runtime seals it on first read).
const CLOUD_URL = `http://127.0.0.1:${modelPort}`;
fs.writeFileSync(path.join(stateDir, "secrets", "caveman-account-session.bin"), JSON.stringify({ cloud_url: CLOUD_URL, access_token: "cave_agents_smoke_access_0123456789" }), { mode: 0o600 });

const repo = path.join(scratch, "repo");
fs.mkdirSync(repo);
const git = (...args: Array<string>) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
git("init", "-q", "-b", "main");
fs.writeFileSync(path.join(repo, "README.md"), "agents smoke\n");
git("add", ".");
git("-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init");

// A second repository, for a change across two (the Chief's change sets).
const repo2 = path.join(scratch, "repo2");
fs.mkdirSync(repo2);
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo2 });
fs.writeFileSync(path.join(repo2, "README.md"), "agents smoke two\n");
execFileSync("git", ["add", "."], { cwd: repo2 });
execFileSync("git", ["-c", "user.name=smoke", "-c", "user.email=smoke@example.invalid", "commit", "-qm", "init"], { cwd: repo2 });

const log = (...parts: Array<unknown>) => console.log(`[agents-smoke ${new Date().toISOString().slice(11, 23)}]`, ...parts);
const failures: Array<string> = [];
const check = (ok: boolean, what: string) => {
  log(`${ok ? "PASS" : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};
const fail = (message: string): never => {
  throw new Error(`AGENTS SMOKE FAILED: ${message}`);
};
const until = async (what: string, test: () => boolean | Promise<boolean>, ms = 60_000) => {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const eventually = async (test: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!test()) {
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
};

// ------------------------------------------------------------ the stand-in: model + gateway

type Route = "pick" | "error" | "unauth" | "paused" | "default";
let route: Route = "pick";
const routeAsks: Array<{ task: { kind: string; agent?: string; brief?: string }; pool: Array<{ id: string; model: string; host: string; via: string; harness?: string; billing?: string }>; models: Array<string>; auth: string }> = [];
const outcomes: Array<{ outcome_token: string; outcome_kind: string; auth: string }> = [];
/** Model calls: which model served which child (by its CHILD- tag). */
const calls: Array<{ path: string; model: string; tag: string | undefined; lead: boolean; last: string }> = [];
let tokens = 0;
const chiefCalls: Array<{ tools: Array<string>; last: string }> = [];
/** Each grill-script call's grill tools; the answer its round got back. */
const grillTools: Array<Array<string>> = [];
/** CHILD-S… children wait on this before answering (a long job), until released. */
let slowGate: Promise<void> = Promise.resolve();
let grillAnswer = "";
const standInLog: Array<string> = [];
const unhandled: Array<string> = [];
let chiefProject = "repo";

type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown };
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { text?: string }) => p?.text ?? "").join("") : "";

/** What the lead does on its plan (LEAD: in the person's message): fan out three on Auto, one by role, one pinned by the lead, or a chain that nests. */
function leadToolCalls(prompt: string, toolName: string): Array<{ name: string; args: Record<string, unknown> }> | undefined {
  const cmd = /LEAD:(\w+)(?: (\S+))?(?: (\S+))?/.exec(prompt);
  if (cmd === null) return undefined;
  const [, verb, a, b] = cmd;
  if (verb === "fan")
    return [
      { name: toolName, args: { task: "CHILD-R: read README.md and report its first line.", title: "Research README", role: "research" } },
      { name: toolName, args: { task: "CHILD-V: review the last commit.", title: "Review commit", role: "review" } },
      { name: toolName, args: { task: "CHILD-I: add nothing; report done.", title: "Implement nothing", role: "implementation" } },
    ];
  if (verb === "fanslow")
    return [
      { name: toolName, args: { task: "CHILD-S1: a long job.", title: "Slow one", role: "general", target: { providerInstanceId: "caveman", model: "custom-agents/child-m" } } },
      { name: toolName, args: { task: "CHILD-S2: another long job.", title: "Slow two", role: "general", target: { providerInstanceId: "caveman", model: "custom-agents/child-m" } } },
    ];
  if (verb === "agent") return [{ name: toolName, args: { task: `CHILD-${b}: look at the last commit.`, title: `CHILD-${b}`, agent: a } }];
  if (verb === "iso") return [{ name: toolName, args: { task: `CHILD-${b}: work in your own checkout.`, title: `CHILD-${b}`, role: "implementation", isolation: "worktree", target: { providerInstanceId: "caveman", model: a } } }];
  if (verb === "one") return [{ name: toolName, args: { task: `CHILD-${b}: report done.`, title: `CHILD-${b}`, role: a } }];
  if (verb === "pin") return [{ name: toolName, args: { task: `CHILD-${b}: report done.`, title: `CHILD-${b}`, role: "general", target: { providerInstanceId: "caveman", model: a } } }];
  if (verb === "nest") return [{ name: toolName, args: { task: "CHILD-N1: NEST-CHILD delegate one more level.", title: "Nest 1", role: "general", target: { providerInstanceId: "caveman", model: "custom-agents/child-m" } } }];
  return undefined;
}

/** Who a conversation is: the first user message that names a child's task (CHILD-X:) or the lead's plan (LEAD:). */
function whoIs(users: ReadonlyArray<string>): { tag?: string } {
  for (const text of users) {
    const child = /CHILD-[A-Z0-9]+(?=:)/.exec(text);
    if (child) return { tag: child[0] };
    if (text.includes("LEAD:")) return {};
  }
  return {};
}

/** A model request in one shape, whichever wire it came on: messages as role + content, `tool` for a tool result, and the tools' names. */
type Asked = { model: string; messages: Array<ChatMessage>; tools: Array<string>; descriptions: Record<string, string> };

/** OpenAI chat completions. */
const fromCompletions = (b: { model: string; messages?: Array<ChatMessage>; tools?: Array<{ function?: { name: string; description?: string } }> }): Asked => ({
  model: b.model,
  messages: b.messages ?? [],
  tools: (b.tools ?? []).map((t) => t.function?.name ?? ""),
  descriptions: Object.fromEntries((b.tools ?? []).map((t) => [t.function?.name ?? "", t.function?.description ?? ""])),
});

/** Anthropic messages: a user turn holding tool_result blocks is a tool result. */
const fromMessages = (b: { model: string; messages?: Array<{ role: string; content: unknown }>; tools?: Array<{ name: string; description?: string }> }): Asked => ({
  descriptions: Object.fromEntries((b.tools ?? []).map((t) => [t.name, t.description ?? ""])),
  model: b.model,
  // A per-message effort rides in an empty system turn (output_config); it says nothing.
  messages: (b.messages ?? []).filter((m) => m.role !== "system").map((m) => {
    const blocks = Array.isArray(m.content) ? (m.content as Array<{ type: string; text?: string; content?: unknown }>) : [];
    const result = blocks.find((x) => x.type === "tool_result");
    return result ? { role: "tool", content: textOf(result.content) } : { role: m.role, content: textOf(m.content) };
  }),
  tools: (b.tools ?? []).map((t) => t.name),
});

function answer(body: Asked): { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> } {
  const messages = body.messages ?? [];
  const users = messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const all = users.join("\n");
  const { tag } = whoIs(users);
  const last = messages.at(-1);
  const delegate = body.tools.find((n) => n.endsWith("delegate_task"));
  // The key test the runtime makes when a key is added.
  if (all.includes("Reply with the word OK")) return { text: "OK" };
  // The Chief: its own tools only. A note naming CHIEFJOB starts one chat in the repo's project.
  if (body.tools.includes("chat_start")) {
    chiefCalls.push({ tools: body.tools, last: textOf(last?.content) });
    if (last?.role === "tool") return { text: "Started it." };
    const note = /<note item=\\?"?(ci-[0-9a-f]+)[^>]*>([\s\S]*?)<\/note>/.exec(textOf(last?.content));
    if (note?.[2]?.includes("CHIEFJOB")) return { calls: [{ name: "chat_start", args: { item_id: note[1], project_ids: [chiefProject], title: "Chief job", brief: "CHILD-CJ: report done." } }] };
    if (note?.[2]?.includes("CHIEFSET"))
      return {
        calls: [
          {
            name: "chat_start",
            args: { item_id: note[1], project_ids: [chiefProject, "repo2"], title: "Rename in both", brief: "CHILD-CS: rename the flag in this repo and report done." },
          },
        ],
      };
    return { text: "Noted." };
  }
  // Grill mode: a round, the person's answer, the decisions doc, grill_finish. GRILL:check names its grill tools.
  if (users.some((u) => u.includes("GRILL:"))) {
    grillTools.push(body.tools.filter((n) => /grill/.test(n)));
    const round = body.tools.find((n) => n.endsWith("grill_round"));
    const finish = body.tools.find((n) => n.endsWith("grill_finish"));
    const lastText = textOf(last?.content);
    if (round === undefined || finish === undefined) return { text: "No grill tools here." };
    if (last?.role === "tool" && lastText.includes("decisions.md")) {
      if (lastText.includes("doc_path")) return { text: "Done grilling." };
      return { calls: [{ name: finish, args: { doc_path: "docs/decisions.md", summary: "Todos live in a JSON file." } }] };
    }
    if (last?.role === "tool" && lastText.includes("answers")) {
      grillAnswer = lastText;
      return { calls: [{ name: "write_file", args: { path: "docs/decisions.md", content: "# Decisions\n\n- Storage: JSON file.\n" } }] };
    }
    return { calls: [{ name: round, args: { questions: [{ title: "Where do todos live?", body: "Two simple options.", options: [{ label: "A JSON file" }, { label: "SQLite" }], recommended: 0 }] } }] };
  }
  if (tag !== undefined) {
    // A child: NEST-CHILD delegates once more (depth 2), NEST-GRAND tries a third level.
    if (last?.role === "tool") return { text: `${tag} done after delegating: ${textOf(last.content).slice(0, 160)}` };
    if (all.includes("NEST-CHILD") && delegate && !all.includes("CHILD-N2"))
      return { calls: [{ name: delegate, args: { task: "CHILD-N2: NEST-GRAND try a third level.", title: "Nest 2", role: "general", mode: "wait", target: { providerInstanceId: "caveman", model: "custom-agents/child-m" } } }] };
    if (all.includes("NEST-GRAND") && delegate)
      return { calls: [{ name: delegate, args: { task: "CHILD-N3: must be refused.", title: "Nest 3", role: "general", target: { providerInstanceId: "caveman", model: "custom-agents/child-m" } } }] };
    // CHILD-APPROVE writes a file, which a Supervised child must ask the person for.
    if (tag === "CHILD-APPROVE" && last?.role !== "tool") return { calls: [{ name: "write_file", args: { path: "approved.txt", content: "ok\n" } }] };
    return { text: `${tag} done on ${body.model}` };
  }
  if (last?.role === "tool") return { text: `LEAD dispatched: ${textOf(last.content).slice(0, 200)}` };
  const lastUser = textOf(last?.content);
  // Peers: a question from another chat's agent is answered; the answer coming back is acknowledged.
  if (lastUser.includes("<thread_message") && lastUser.includes("PEERQ")) return { text: "PEERA: four" };
  if (lastUser.includes("PEERA")) return { text: "A heard PEERA" };
  const send = /LEAD:send (\S+)/.exec(lastUser);
  if (send) {
    // The runtime's thread_send, from the engine's code tool, found by name among its tools (MCP tools are
    // discovered, not declared, in a cell).
    const code = body.tools.find((n) => n === "program") ?? body.tools.find((n) => n === "exec");
    if (code === undefined) return { text: "LEAD cannot send: no code tool" };
    const args = JSON.stringify({ threadId: send[1], message: "PEERQ: what is two plus two?", expectReply: true });
    const cell = [
      "const names = (Array.isArray(ALL_TOOLS) ? ALL_TOOLS : Object.keys(ALL_TOOLS)).map((t) => (typeof t === 'string' ? t : t.name));",
      "const name = names.find((n) => /thread_send$/.test(n));",
      "if (!name) return 'no send tool among ' + names.join(',');",
      `return await tools[name](${args});`,
    ].join("\n");
    return { calls: [{ name: code, args: { code: cell } }] };
  }
  const planned = delegate ? leadToolCalls(lastUser, delegate) : undefined;
  if (planned) return { calls: planned };
  return { text: `LEAD ack (${lastUser.slice(0, 60).replace(/\s+/g, " ")})` };
}

function sse(res: http.ServerResponse, model: string, reply: ReturnType<typeof answer>) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const id = `chatcmpl-${++tokens}`;
  const chunk = (delta: Record<string, unknown>, finish: string | null = null) =>
    res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  chunk({ role: "assistant", content: "" });
  if (reply.calls) {
    reply.calls.forEach((c, index) => chunk({ tool_calls: [{ index, id: `call_${tokens}_${index}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args) } }] }));
    chunk({}, "tool_calls");
  } else {
    chunk({ content: reply.text ?? "" });
    chunk({}, "stop");
  }
  res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
  res.end("data: [DONE]\n\n");
}

function anthropicSse(res: http.ServerResponse, model: string, reply: ReturnType<typeof answer>) {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const usage = { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  send("message_start", { message: { id: `msg_${++tokens}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  const blocks = reply.calls ?? [];
  if (blocks.length === 0) {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    send("content_block_delta", { index: 0, delta: { type: "text_delta", text: reply.text ?? "" } });
    send("content_block_stop", { index: 0 });
  }
  blocks.forEach((c, index) => {
    send("content_block_start", { index, content_block: { type: "tool_use", id: `toolu_${tokens}_${index}`, name: c.name, input: {} } });
    send("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(c.args) } });
    send("content_block_stop", { index });
  });
  send("message_delta", { delta: { stop_reason: blocks.length > 0 ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
  send("message_stop", {});
  res.end();
}

/** What a model call was, for the checks: which model served which child (its CHILD- tag), or the lead. */
function record(path: string, asked: Asked) {
  const said = asked.messages.filter((m) => m.role === "user").map((m) => textOf(m.content));
  const who = whoIs(said);
  calls.push({ path, model: asked.model, tag: who.tag, lead: who.tag === undefined, last: textOf(asked.messages.at(-1)?.content) });
}

const standIn = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const auth = String(req.headers.authorization ?? "");
    const url = req.url ?? "";
    const json = (status: number, value: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    let body: Record<string, unknown> = {};
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      return json(400, { error: "bad json" });
    }
    standInLog.push(`${req.method} ${url} model=${String(body.model ?? "-")}`);
    if (req.method === "POST" && url === "/v1/route") {
      routeAsks.push({ ...(body as unknown as (typeof routeAsks)[number]), auth });
      const pool = (body.pool ?? []) as (typeof routeAsks)[number]["pool"];
      const kind = (body.task as { kind: string } | undefined)?.kind;
      if (route === "error") return json(500, { error: "boom" });
      if (route === "unauth") return json(401, { error: "unauthorized" });
      if (route === "paused") return json(200, { model: (body.models as Array<string>)[0], reason: "allowance", notice: "Routing is paused." });
      if (route === "default") return json(200, { model: (body.models as Array<string>)[0], reason: "no_alternative", outcome_token: `tok-${routeAsks.length}` });
      const pick =
        (kind === "research" ? pool.find((e) => e.harness === "claude-agent") : undefined) ??
        (kind === "review" ? pool.find((e) => e.id.endsWith("custom-agents/child-m")) : undefined) ??
        (kind === "implementation" ? pool.find((e) => e.billing === "credits" && /deepseek|glm|kimi/.test(e.model)) : undefined) ??
        pool.find((e) => e.id.endsWith("custom-agents/child-m")) ??
        pool[0];
      if (pick === undefined) return json(200, { model: (body.models as Array<string>)[0], reason: "no_alternative" });
      return json(200, { model: pick.model, pool_id: pick.id, via: "local", reason: "route_table", effort: kind === "review" ? "high" : "", outcome_token: `tok-${routeAsks.length}` });
    }
    if (req.method === "POST" && url === "/v1/route/outcomes") {
      outcomes.push({ ...(body as unknown as (typeof outcomes)[number]), auth });
      return json(202, { accepted: true });
    }
    if (req.method === "POST" && url.endsWith("/chat/completions")) {
      const asked = fromCompletions(body as Parameters<typeof fromCompletions>[0]);
      record(url, asked);
      const slow = whoIs(asked.messages.filter((m) => m.role === "user").map((m) => textOf(m.content))).tag?.startsWith("CHILD-S") === true;
      if (slow && asked.messages.at(-1)?.role !== "tool") return void slowGate.then(() => (res.destroyed ? undefined : sse(res, asked.model, answer(asked))));
      return sse(res, asked.model, answer(asked));
    }
    // Caveman credits' Claude models: the gateway's Anthropic route.
    if (req.method === "POST" && url.split("?")[0] === "/v1/messages") {
      const asked = fromMessages(body as Parameters<typeof fromMessages>[0]);
      record(url, asked);
      return anthropicSse(res, asked.model, answer(asked));
    }
    unhandled.push(`${req.method} ${url} model=${String(body.model ?? "-")}`);
    json(404, { error: `no route ${req.method} ${url}` });
  });
});
await new Promise<void>((resolve) => standIn.listen(modelPort, "127.0.0.1", resolve));
log(`stand-in model + gateway on 127.0.0.1:${modelPort}`);

// ------------------------------------------------------------------- runtime

let runtime: ChildProcess | undefined;
let output = "";
const pidFile = path.join(scratch, "runtime.pid");
try {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    CAVEMAN_CODE_HOME: runtimeHome,
    CAVEMAN_CODE_NO_BROWSER: "1",
    CAVEMAN_CREDITS_GATEWAY_URL: `http://127.0.0.1:${modelPort}`,
    GIT_AUTHOR_NAME: "smoke",
    GIT_AUTHOR_EMAIL: "smoke@example.invalid",
    GIT_COMMITTER_NAME: "smoke",
    GIT_COMMITTER_EMAIL: "smoke@example.invalid",
  };
  // CAVEMAN_CLOUD_URL: a pin to another Cloud reads the stand-in's sign-in as none.
  for (const name of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CAVEMAN_PROXY_BIN", "CAVEMAN_MCP_BIN", "CAVEMAN_CLOUD_URL", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) delete env[name];
  runtime = spawn(process.execPath, [bin, "--port", String(port)], { env, stdio: ["pipe", "pipe", "pipe"] });
  fs.writeFileSync(pidFile, String(runtime.pid));
  runtime.stdout!.on("data", (chunk) => (output += chunk));
  runtime.stderr!.on("data", (chunk) => (output += chunk));
  log(`runtime pid ${runtime.pid} on 127.0.0.1:${port}, scratch ${scratch}`);
  await until("the runtime to listen", () => output.includes("Listening on"), 120_000);
  const token = () => fs.readFileSync(path.join(stateDir, "session-protocol.token"), "utf8");
  const client = connect(`ws://127.0.0.1:${port}/session/v1`, token, () => {});

  // An endpoint of the person's own: the lead's and children's model.
  const added = await client.call("engine.account.add", {
    request_id: "a1",
    engine: "caveman",
    provider: "custom-agents",
    endpoint: { name: "Agents smoke", base_url: `http://127.0.0.1:${modelPort}/v1`, models: ["lead-m", "child-m"] },
  });
  log(`custom endpoint added: test=${JSON.stringify(added.test)} accounts=${added.accounts.map((a) => a.id).join(",")}`);
  const engines = async () => (await client.call("engine.list", {})).engines;
  await until("claude-agent's probe", async () => {
    const claude = (await engines()).find((e) => e.id === "claude-agent");
    return claude !== undefined && claude.auth.state !== "checking";
  }, 90_000);
  for (const e of await engines())
    log(`engine ${e.id}: auth=${e.auth.state} accounts=${e.auth.accounts.map((a) => `${a.id}${a.tag ? `[${a.tag}]` : ""}`).join(",")} models=${e.models.map((m) => m.id).slice(0, 12).join(",")}`);
  const caveman = (await engines()).find((e) => e.id === "caveman") ?? fail("no caveman engine");
  const lead = caveman.models.find((m) => m.id.endsWith("/lead-m"))?.id ?? fail("the custom endpoint's lead model is not listed");
  const childM = caveman.models.find((m) => m.id.endsWith("/child-m"))?.id ?? fail("no child model");
  check(caveman.models.some((m) => m.id.startsWith("caveman/")), "Caveman credits models are listed on the test key");

  const settings = (await client.call("settings.get", {})) as Record<string, unknown>;
  log(`subagent settings in force: ${JSON.stringify(Object.fromEntries(Object.entries(settings).filter(([k]) => k.startsWith("subagent_"))))}`);
  check(settings.subagent_default_model === "auto", "the default child model is Auto");

  let n = 0;
  /** A lead chat that runs `prompt`, then every subagent it started, until their turns end. */
  async function delegate(name: string, prompt: string, expectChildren: number) {
    const ws = await client.call("workspace.create", { request_id: `ws-${name}`, repo: { path: repo }, title: `Lead ${name}`, engine: "caveman", options: { model: lead } });
    const events: Array<SessionEvent> = [];
    await client.attach(ws.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: `t-${name}-${++n}`, session_id: ws.session_id, kind: "followup", input: { text: prompt } });
    const started = () => events.filter((e) => e.type === "subagent.started") as Array<Extract<SessionEvent, { type: "subagent.started" }>>;
    if (!(await eventually(() => started().filter((e) => e.payload.workspace_id).length >= expectChildren, 90_000))) {
      log(`  ${name}: the lead's events: ${events.map((e) => `${e.type} ${JSON.stringify(e.payload).slice(0, 300)}`).join(" | ")}`);
      fail(`timed out waiting for ${name}: ${expectChildren} subagent.started`);
    }
    await until(`${name}: the lead's turn to end`, () => events.some((e) => e.type === "turn.done"), 90_000);
    const children = await Promise.all(
      started()
        .filter((e) => e.payload.workspace_id)
        .map(async (e) => {
          const child = await client.call("workspace.get", { workspace_id: e.payload.workspace_id! });
          const childEvents: Array<SessionEvent> = [];
          await client.attach(child.session_id, 0, (ce) => childEvents.push(ce));
          return { title: e.payload.title, event: e.payload.runner, child, childEvents };
        }),
    );
    for (const c of children) await until(`${name}: child "${c.title}" to finish`, () => c.childEvents.some((e) => e.type === "turn.done"), 90_000);
    // The children's ends reach the lead (subagent.done) and wake it.
    await until(`${name}: subagent.done for each child`, () => events.filter((e) => e.type === "subagent.done").length >= expectChildren, 60_000);
    for (const c of children) {
      const r = c.child.runner;
      log(`  ${name} child "${c.title}": engine=${c.child.engine} runner(event)=${JSON.stringify(c.event)} runner(workspace)=${JSON.stringify(r)}`);
      const answer = c.childEvents.filter((e) => e.type === "message.done" && e.payload.role === "assistant").map((e) => (e.payload as { text?: string }).text ?? "").join(" | ");
      log(`  ${name} child "${c.title}" answered: ${answer.slice(0, 160)}`);
    }
    return { ws, events, children };
  }
  const runnerOf = (children: Awaited<ReturnType<typeof delegate>>["children"], title: string): SubagentRunner | undefined => children.find((c) => c.title === title)?.child.runner;

  if (!onlyChief) {
  // 1. Auto, Cloud answering: three children on three connected options.
  route = "pick";
  const asks0 = routeAsks.length;
  const auto = await delegate("auto", "LEAD:fan these out", 3);
  const asked = routeAsks.slice(asks0);
  check(asked.length === 3, `Auto asked /v1/route once per child (${asked.length})`);
  check(asked.every((a) => a.auth === `Bearer ${CREDITS_KEY}`), "Auto asks with the Caveman credits key");
  const pool = asked[0]?.pool ?? [];
  log(`  pool (${pool.length}): ${pool.map((e) => `${e.id}{${e.harness},${e.host},${e.billing ?? "-"}}`).join(" ")}`);
  check(pool.some((e) => e.harness === "claude-agent") && pool.some((e) => e.harness === "caveman"), "the pool spans the connected harnesses");
  check(!pool.some((e) => e.id.endsWith("/auto")), "the pool never offers a router (auto) as a model");
  check(asked.map((a) => a.task.kind).sort().join() === "implementation,research,review", "each ask names the child's role");
  check(asked.every((a) => typeof a.task.brief === "string" && a.task.brief.includes("CHILD-")), "each ask carries the task as its brief");
  const research = runnerOf(auto.children, "Research README");
  const review = runnerOf(auto.children, "Review commit");
  const impl = runnerOf(auto.children, "Implement nothing");
  check(research?.engine === "claude-agent" && research.pick.by === "auto" && research.pick.kind === "research", `research child runs on Claude Agent, picked by Auto (${JSON.stringify(research)})`);
  check(review?.engine === "caveman" && review.model === childM && review.pick.by === "auto" && review.pick.kind === "review", `review child runs on the endpoint's child model, picked by Auto (${JSON.stringify(review)})`);
  check(impl?.engine === "caveman" && impl.model.startsWith("caveman/") && impl.pick.by === "auto", `implementation child runs on Caveman credits, picked by Auto (${JSON.stringify(impl)})`);
  check([research, review, impl].every((r) => r?.pick.options !== undefined && r.pick.options === pool.length), "each runner says how many options Auto picked among");
  check(auto.children.every((c) => JSON.stringify(c.event) === JSON.stringify(c.child.runner)), "subagent.started carries the same runner as the child Workspace");
  check(calls.some((c) => c.tag === "CHILD-V" && c.model === "child-m"), "the review child's model calls reached the endpoint's child model");
  check(calls.some((c) => c.tag === "CHILD-I" && c.path !== "/v1/chat/completions"), "the implementation child's model calls went to the credits gateway route");
  await until("three outcomes", () => outcomes.length >= 3, 30_000);
  check(outcomes.length === 3 && outcomes.every((o) => o.outcome_kind === "completed" && o.auth === `Bearer ${CREDITS_KEY}`), `each finished child's outcome went back once (${JSON.stringify(outcomes.map((o) => [o.outcome_token, o.outcome_kind]))})`);
  check(new Set(outcomes.map((o) => o.outcome_token)).size === 3, "outcomes name each decision's own token");
  check(
    await eventually(() => calls.some((c) => c.lead && c.model === "lead-m" && /CHILD-[RVI] done/.test(c.last)), 30_000),
    "the children's ends wake the lead with their results inline",
  );
  const leadText = auto.events.filter((e) => e.type === "message.done" && e.payload.role === "assistant").map((e) => (e.payload as { text?: string }).text ?? "");
  log(`  lead said: ${leadText.map((t) => t.slice(0, 80)).join(" | ")}`);

  // 2. Cloud failing: the by-role default runs and says why; the delegation is never refused. Cloud refusing the key
  // (401) comes after 4: a key Cloud refused is never asked with again (src/router/routerKey.ts).
  const fallsBack = async (mode: "error" | "unauth" | "paused", reason: string) => {
    route = mode;
    const run = await delegate(mode, `LEAD:one review F${mode.toUpperCase()}`, 1);
    const r = run.children[0]?.child.runner;
    check(r?.pick.by === "default" && r.pick.fallback === reason && r.pick.kind === "review", `Cloud ${mode}: the child runs on the default and says ${reason} (${JSON.stringify(r)})`);
  };
  for (const [mode, reason] of [["error", "cloud_error"], ["paused", "quota"]] as const) await fallsBack(mode, reason);
  route = "default";
  {
    const run = await delegate("keep", "LEAD:one research KEEP", 1);
    const r = run.children[0]?.child.runner;
    check(r?.pick.by === "default" && r.pick.fallback === undefined, `Cloud keeps the caller's default: by default, no fallback (${JSON.stringify(r)})`);
  }

  // 3. A role pin (Settings > Subagents) outranks Auto; the lead's own pin outranks the role pin.
  route = "pick";
  await client.call("settings.set", { request_id: "pin-1", settings: { subagent_role_pins: { review: { engine: "caveman", instance_id: "caveman", model: childM } } } });
  const asksBeforePin = routeAsks.length;
  {
    const run = await delegate("rolepin", "LEAD:one review PIN", 1);
    const r = run.children[0]?.child.runner;
    check(r?.pick.by === "user" && r.model === childM, `a role pin runs the pinned model, by user (${JSON.stringify(r)})`);
    check(routeAsks.length === asksBeforePin, "a role pin asks Cloud nothing");
  }
  {
    const run = await delegate("leadpin", `LEAD:pin ${lead} LEADPIN`, 1);
    const r = run.children[0]?.child.runner;
    check(r?.pick.by === "lead" && r.model === lead, `the lead's target outranks every pin, by lead (${JSON.stringify(r)})`);
  }
  await client.call("settings.set", { request_id: "pin-2", settings: { subagent_role_pins: { review: null } } });

  // An agent type (the built-in reviewer): its instructions lead the child's task and its role picks the runner.
  route = "pick";
  {
    const run = await delegate("agenttype", "LEAD:agent reviewer REVIEWER", 1);
    const r = run.children[0]?.child.runner;
    const brief = calls.find((c) => c.tag === "CHILD-REVIEWER")?.last ?? "";
    check(r?.pick.by === "auto" && r.pick.kind === "review", `an agent type's role picks the runner (${JSON.stringify(r?.pick)})`);
    check(routeAsks.at(-1)?.task.agent === "reviewer", "Auto names the agent type to Cloud");
    check(/You review; never edit files/.test(brief), "the agent type's instructions lead the child's task");
    // Its own checkout: a worktree from the lead's commit, not the lead's folder.
    const iso = await delegate("isolated", `LEAD:iso ${childM} ISO`, 1);
    const child = iso.children[0]?.child;
    log(`  isolated child: root=${child?.root_path} branch=${child?.branch} lead root=${iso.ws.root_path}`);
    check(child?.root_path !== undefined && child.root_path !== iso.ws.root_path && fs.existsSync(child.root_path), "isolation: worktree gives the child a checkout of its own");
    check(child?.branch.startsWith("caveman/") === true, `on a branch named as the app names chats (${child?.branch})`);
  }

  // 4. Depth: a child may delegate once more (depth 2); a third level is refused.
  {
    const ws = await client.call("workspace.create", { request_id: "ws-nest", repo: { path: repo }, title: "Lead nest", engine: "caveman", options: { model: lead } });
    const events: Array<SessionEvent> = [];
    await client.attach(ws.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t-nest", session_id: ws.session_id, kind: "followup", input: { text: "LEAD:nest" } });
    await until("the nested chain to settle", () => calls.some((c) => c.tag === "CHILD-N1" && c.lead === false) && events.filter((e) => e.type === "subagent.done").length >= 1, 120_000);
    const n1 = calls.filter((c) => c.tag === "CHILD-N1").length;
    const n2 = calls.filter((c) => c.tag === "CHILD-N2").length;
    const n3 = calls.filter((c) => c.tag === "CHILD-N3").length;
    log(`  nest: model calls N1=${n1} N2=${n2} N3=${n3}`);
    check(n2 > 0, "a child delegates a grandchild (depth 2)");
    check(n3 === 0, "a third level never starts (depth 2 is the limit)");
  }

  await fallsBack("unauth", "cloud_unlinked");
  }
  // 5. The Chief: ready once something is connected; a queued note never reaches the model; a note it
  // decides starts a chat in the project, and the board follows that chat to done.
  {
    // A project the Chief can start chats in: the repo, as a chat there makes it.
    if (onlyChief) await client.call("workspace.create", { request_id: "ws-project", repo: { path: repo }, title: "Project", engine: "caveman", options: { model: childM } });
    const projects = await client.call("project.list", {});
    const project = projects.projects.find((p) => p.path === repo || p.name === path.basename(repo));
    chiefProject = project?.name ?? path.basename(repo);
    log(`  projects: ${JSON.stringify(projects.projects.map((p) => ({ id: p.id, name: p.name })))}`);
    // Its chats start on the default engine and model. The Chief stays on Auto: its fast floor, the cheapest connected model.
    await client.call("settings.set", { request_id: "chief-engine", settings: { default_engine: "caveman", engines: { caveman: { model: childM } } } });
    const boards: Array<unknown> = [];
    client.on("chief.board.updated", (b) => boards.push(b));
    // The repo's project's own Chief.
    const got = await client.call("chief.get", project === undefined ? {} : { project_id: project.id });
    const chiefEvents: Array<SessionEvent> = [];
    await client.attach(got.workspace.session_id, 0, (e) => chiefEvents.push(e));
    log(`  chief.get: availability=${got.availability} workspace=${got.workspace.id} kind=${got.workspace.kind} picker=${JSON.stringify(got.picker)?.slice(0, 200)}`);
    check(got.availability === "ready" && got.workspace.kind === "chief", "the Chief is ready on what is connected");
    const listed = await client.call("workspace.list", {});
    check(!listed.workspaces.some((w) => w.kind === "chief"), "workspace.list leaves the Chief out");
    const beforeQueue = chiefCalls.length;
    const queued = await client.call("chief.capture", { request_id: "cq-1", chief_id: got.chief!.id, text: "Remember to look at the flaky test sometime", mode: "queue" });
    await new Promise((r) => setTimeout(r, 1500));
    check(queued.item.state === "queued" && chiefCalls.length === beforeQueue, `a queued note never reaches the model (${queued.item.state})`);
    const decided = await client.call("chief.capture", { request_id: "cd-1", chief_id: got.chief!.id, text: "CHIEFJOB please run the small job in the repo", mode: "decide" });
    log(`  captured ${decided.item.id} state=${decided.item.state}`);
    const items = async () => (await client.call("chief.items.list", {})).items;
    const reached = await eventually(() => chiefCalls.some((c) => c.last.includes(decided.item.id)), 60_000);
    check(reached, "a decided note reaches the Chief's model with its item id");
    const chiefTools = chiefCalls[0]?.tools ?? [];
    log(`  the Chief's tools: ${chiefTools.join(",")}`);
    log(`  the Chief's first input: ${JSON.stringify(chiefCalls[0]?.last ?? "").slice(0, 400)}`);
    check(chiefTools.includes("chat_start") && !chiefTools.some((t) => /^(bash|read|write|edit|exec|code|shell)/i.test(t)), "the Chief has only its own tools (no file, shell or code tools)");
    let item: Awaited<ReturnType<typeof items>>[number] | undefined;
    const moved = await (async () => {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        item = (await items()).find((i) => i.id === decided.item.id);
        if (item && ["done", "review"].includes(item.state) && item.workspace_ids.length > 0) return true;
        await new Promise((r) => setTimeout(r, 250));
      }
      return false;
    })();
    log(`  item after the chat: ${JSON.stringify(item)}`);
    log(`  the Chief's events: ${chiefEvents.map((e) => `${e.type}${e.type === "turn.started" ? `(${JSON.stringify((e.payload as { model?: string }).model)})` : e.type === "turn.done" || e.type === "error" || e.type.startsWith("tool.") ? JSON.stringify(e.payload).slice(0, 400) : ""}`).join(" ")}`);
    check(moved, "the Chief's chat ran and the board moved its item to done");
    if (item?.workspace_ids[0]) {
      const job = await client.call("workspace.get", { workspace_id: item.workspace_ids[0] });
      log(`  the Chief's chat: engine=${job.engine} title=${job.title}`);
      check(calls.some((c) => c.tag === "CHILD-CJ"), "the Chief's chat got the brief as its task");
    }
    check(await eventually(() => chiefCalls.some((c) => c.last.includes("chat_update")), 30_000), "the chat's end wakes the Chief once quiet (chat_update)");
    const floor = calls.filter((c) => chiefCalls.length > 0 && c.path.startsWith("/v1/messages")).map((c) => c.model);
    check(floor.length > 0 && floor.every((m) => m === "claude-haiku-5-5"), `on Auto the Chief runs on its fast floor (${[...new Set(floor)].join(",")})`);

    // 6. The Chief's picker: pinned to the endpoint's model, its next turn runs there.
    await client.call("chief.update", { request_id: "chief-pin", chief_id: got.chief!.id, model: { engine: "caveman", model: childM } });
    const pinnedFrom = calls.length;
    const note = await client.call("chief.capture", { request_id: "cd-2", chief_id: got.chief!.id, text: "Just tell me you are there", mode: "decide" });
    check(await eventually(() => calls.slice(pinnedFrom).some((c) => c.model === "child-m" && c.last.includes(note.item.id)), 60_000), "a pinned Chief's next turn runs on its pick");
    check(!calls.slice(pinnedFrom).some((c) => c.path.startsWith("/v1/messages")), "and not on the fast floor");

    // Another project's work is that project's Chief's: a chat_start there is refused, and nothing starts.
    await client.call("workspace.create", { request_id: "ws-repo2", repo: { path: repo2 }, title: "Repo two", engine: "caveman", options: { model: childM } });
    const set = await client.call("chief.capture", { request_id: "cs-1", chief_id: got.chief!.id, text: "CHIEFSET rename the flag in both repos", mode: "decide" });
    check(await eventually(() => chiefEvents.some((e) => e.type === "tool.done" && JSON.stringify(e.payload).includes("is not your project")), 60_000), "a chat in another project is refused: it has its own Chief");
    check(((await items()).find((i) => i.id === set.item.id)?.workspace_ids.length ?? 0) === 0, "nothing starts there");
  }

  // 7. Peers: one chat's agent asks another (thread_send, expectReply); the receiver gets the envelope, its
  // final message goes back, and the asker wakes with it.
  {
    const peerB = await client.call("workspace.create", { request_id: "ws-peer-b", repo: { path: repo }, title: "Peer B", engine: "caveman", options: { model: childM } });
    const bEvents: Array<SessionEvent> = [];
    await client.attach(peerB.session_id, 0, (e) => bEvents.push(e));
    const peerA = await client.call("workspace.create", { request_id: "ws-peer-a", repo: { path: repo }, title: "Peer A", engine: "caveman", options: { model: lead } });
    const aEvents: Array<SessionEvent> = [];
    await client.attach(peerA.session_id, 0, (e) => aEvents.push(e));
    const from = calls.length;
    await client.call("turn.submit", { request_id: "t-peer-a", session_id: peerA.session_id, kind: "followup", input: { text: `LEAD:send caveman:${peerB.id}` } });
    const asked = await eventually(() => calls.slice(from).some((c) => c.model === "child-m" && c.last.includes("PEERQ")), 60_000);
    const envelope = calls.slice(from).find((c) => c.model === "child-m" && c.last.includes("PEERQ"))?.last ?? "";
    log(`  peer B was sent: ${JSON.stringify(envelope.slice(0, 400))}`);
    if (!asked) log(`  peer A said: ${aEvents.filter((e) => e.type === "message.done" || e.type === "tool.done").map((e) => JSON.stringify(e.payload).slice(0, 200)).join(" | ")}`);
    check(asked, "a question from one chat's agent reaches the other chat");
    check(envelope.includes('<thread_message from="Peer A"') && envelope.includes('expects_reply="true"'), "it arrives in the envelope naming its sender, as a question");
    check(/thread_send\(threadId="caveman:[^"]+", inReplyTo="[^"]+"\)|your final message this turn is sent back/.test(envelope), "the envelope says how to reply in one call");
    check(await eventually(() => calls.slice(from).some((c) => c.model === "lead-m" && c.last.includes("PEERA")), 60_000), "the receiver's final message goes back and wakes the asker");
    const fromB = bEvents.find((e) => e.type === "message.done" && e.payload.role === "user");
    check(fromB?.type === "message.done" && fromB.payload.from?.workspace_id === peerA.id, `the receiver's transcript shows the message as from Peer A (${JSON.stringify(fromB?.payload).slice(0, 200)})`);

    // 8. The person points a new chat at Peer B (@ or a drag): the agent gets B's digest with the message, no read needed.
    const peerC = await client.call("workspace.create", { request_id: "ws-peer-c", repo: { path: repo }, title: "Peer C", engine: "caveman", options: { model: lead } });
    const refFrom = calls.length;
    await client.call("turn.submit", { request_id: "t-peer-c", session_id: peerC.session_id, kind: "followup", input: { text: `What did ${formatThreadReference(peerB.id, "Peer B")} answer? REFCHECK` } });
    const seen = await eventually(() => calls.slice(refFrom).some((c) => c.model === "lead-m" && c.last.includes("REFCHECK")), 60_000);
    const sent = calls.slice(refFrom).find((c) => c.model === "lead-m" && c.last.includes("REFCHECK"));
    const pointed = (sent ? JSON.stringify(sent) : "").slice(0, 2000);
    log(`  a chat pointed at Peer B was sent: ${pointed.slice(0, 600)}`);
    check(seen, "a message pointing at another chat reaches the agent");
    check(pointed.includes("PEERA: four"), "it carries that chat's digest with its latest answer");
  }

  // 9. Grill mode: its tools load only while it is on; a round is the person's card; finishing says where the decisions are.
  {
    const ws = await client.call("workspace.create", { request_id: "ws-grill", repo: { path: repo }, title: "Griller", engine: "caveman", options: { model: childM } });
    const events: Array<SessionEvent> = [];
    await client.attach(ws.session_id, 0, (e) => events.push(e));
    const done = () => events.filter((e) => e.type === "turn.done").length;
    const caveman = (await engines()).find((e) => e.id === "caveman");
    check(caveman?.capabilities.grill_mode === true, "the Caveman engine offers grill mode");
    let mark = grillTools.length;
    await client.call("turn.submit", { request_id: "t-grill-1", session_id: ws.session_id, kind: "followup", input: { text: "GRILL:check which tools you have" } });
    await until("the default turn", () => done() >= 1, 60_000);
    check(grillTools.slice(mark).length > 0 && grillTools.slice(mark).every((t) => t.length === 0), "in default mode the engine sees no grill tools");
    mark = grillTools.length;
    await client.call("turn.submit", { request_id: "t-grill-2", session_id: ws.session_id, kind: "followup", input: { text: "GRILL:start grill me on todo storage" }, options: { mode: "grill" } });
    await until("a grill round", () => events.some((e) => e.type === "ask.user"), 60_000);
    const ask = events.find((e) => e.type === "ask.user");
    log(`  grill round: ${JSON.stringify(ask?.payload).slice(0, 400)}`);
    check(grillTools.slice(mark).some((t) => t.some((n) => n.endsWith("grill_round")) && t.some((n) => n.endsWith("grill_finish"))), "in grill mode the engine has grill_round and grill_finish");
    check(ask?.type === "ask.user" && ask.payload.kind === "question" && ask.payload.questions[0]?.recommended !== undefined, "a round is a question card with its recommended answer");
    if (ask?.type === "ask.user" && ask.payload.kind === "question") {
      await client.call("ask.respond", {
        request_id: "grill-answer",
        session_id: ws.session_id,
        ask_id: ask.item_id!,
        response: { kind: "question", answers: ask.payload.questions.map((q) => ({ question_id: q.id, option_ids: [q.recommended ?? q.options[0]!.id] })) },
      });
    }
    await until("grill.finished", () => events.some((e) => e.type === "grill.finished"), 60_000);
    const finished = events.find((e) => e.type === "grill.finished");
    log(`  grill.finished: ${JSON.stringify(finished?.payload)}; the round answered: ${grillAnswer.slice(0, 200)}`);
    check(grillAnswer.includes("A JSON file") && grillAnswer.includes("took_recommendation"), "the person's answer reaches the engine");
    check(finished?.type === "grill.finished" && finished.payload.doc_path === "docs/decisions.md" && fs.existsSync(path.join(ws.root_path ?? repo, "docs", "decisions.md")), "grill.finished names the decisions doc, which exists in the chat's checkout");
    await until("the grill turn to end", () => done() >= 2, 60_000);
    const attached = await client.call("session.attach", { session_id: ws.session_id, cursor: 0 });
    log(`  session.mode after grill_finish: ${attached.session.mode ?? "default"}`);
    mark = grillTools.length;
    await client.call("turn.submit", { request_id: "t-grill-3", session_id: ws.session_id, kind: "followup", input: { text: "GRILL:check again" }, options: { mode: "default" } });
    await until("the turn after grill", () => done() >= 3, 60_000);
    check(grillTools.slice(mark).length > 0 && grillTools.slice(mark).every((t) => t.length === 0), "back in default mode the grill tools are gone");
  }

  // 11. A Supervised lead's agent asks the person for a write: its own chat needs them (the lead cannot answer approvals).
  {
    route = "pick";
    const ws = await client.call("workspace.create", { request_id: "ws-approve", repo: { path: repo }, title: "Lead supervised", engine: "caveman", options: { model: lead, access: "ask" } });
    const events: Array<SessionEvent> = [];
    await client.attach(ws.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t-approve", session_id: ws.session_id, kind: "followup", input: { text: "LEAD:pin custom-agents/child-m APPROVE" } });
    await until("the supervised lead's agent", () => events.some((e) => e.type === "subagent.started" && (e.payload as { workspace_id?: string }).workspace_id), 60_000);
    const childId = (events.find((e) => e.type === "subagent.started")!.payload as { workspace_id: string }).workspace_id;
    const child = await client.call("workspace.get", { workspace_id: childId });
    const childEvents: Array<SessionEvent> = [];
    await client.attach(child.session_id, 0, (e) => childEvents.push(e));
    const asked = await eventually(() => childEvents.some((e) => e.type === "ask.user"), 60_000);
    const ask = childEvents.find((e) => e.type === "ask.user");
    log(`  the agent's ask: ${JSON.stringify(ask?.payload).slice(0, 300)}`);
    check(asked && ask?.type === "ask.user" && ask.payload.kind === "approval", "a Supervised lead's agent asks the person before it writes");
    await until("the lead's turn to end", () => events.some((e) => e.type === "turn.done"), 60_000);
    const now = await client.call("workspace.list", {});
    const childNow = now.workspaces.find((w) => w.id === childId);
    const leadNow = now.workspaces.find((w) => w.id === ws.id);
    log(`  statuses while it waits: agent=${childNow?.status} lead=${leadNow?.status}`);
    check(childNow?.status === "needs_input", "the agent's chat needs the person (needs_input) while the lead's turn has ended");
    if (ask?.type === "ask.user" && ask.payload.kind === "approval") {
      const allow = ask.payload.options.find((o) => /allow|approve|yes|once/i.test(`${o.id} ${o.label}`)) ?? ask.payload.options[0]!;
      await client.call("ask.respond", { request_id: "approve-1", session_id: child.session_id, ask_id: ask.item_id!, response: { kind: "approval", option_id: allow.id } });
      check(await eventually(() => childEvents.some((e) => e.type === "turn.done"), 60_000) && fs.existsSync(path.join(child.root_path ?? repo, "approved.txt")), "approved, the agent writes and finishes");
    }
  }

  // 10. Limits that hold while agents run: one at a time refuses the second, and Stop on the lead stops its agent.
  {
    let release: () => void = () => undefined;
    slowGate = new Promise<void>((r) => (release = r));
    await client.call("settings.set", { request_id: "conc-1", settings: { subagent_max_concurrent: 1 } });
    const ws = await client.call("workspace.create", { request_id: "ws-slow", repo: { path: repo }, title: "Lead slow", engine: "caveman", options: { model: lead } });
    const events: Array<SessionEvent> = [];
    await client.attach(ws.session_id, 0, (e) => events.push(e));
    await client.call("turn.submit", { request_id: "t-slow", session_id: ws.session_id, kind: "followup", input: { text: "LEAD:fanslow" } });
    await until("the lead's turn", () => events.some((e) => e.type === "turn.done"), 60_000);
    const started = events.filter((e) => e.type === "subagent.started");
    const refused = events.filter((e) => e.type === "tool.done" && e.payload.status === "failed" && (e.payload.error ?? "").startsWith("Not delegated:"));
    log(`  one at a time: ${started.length} started; refused: ${refused.map((e) => (e.type === "tool.done" ? e.payload.error : "")).join(" | ")}`);
    check(started.length === 1 && refused.length === 1, "with one agent at a time, the second delegation is refused while the first runs, and its line says why");
    const childId = (started[0]?.payload as { workspace_id?: string } | undefined)?.workspace_id;
    const child = childId ? await client.call("workspace.get", { workspace_id: childId }) : undefined;
    const childEvents: Array<SessionEvent> = [];
    if (child) await client.attach(child.session_id, 0, (e) => childEvents.push(e));
    await until("the agent to be working", () => childEvents.some((e) => e.type === "turn.started"), 30_000);
    await client.call("turn.interrupt", { request_id: "stop-slow", session_id: ws.session_id });
    const stopped = await eventually(() => childEvents.some((e) => e.type === "turn.done"), 30_000);
    log(`  after Stop on the lead: ${JSON.stringify(childEvents.find((e) => e.type === "turn.done")?.payload)}`);
    check(stopped && (childEvents.find((e) => e.type === "turn.done")?.payload as { status?: string } | undefined)?.status === "interrupted", "Stop on the lead stops its running agent");
    release();
    await client.call("settings.set", { request_id: "conc-2", settings: { subagent_max_concurrent: 8 } });
  }

  client.close();
  if (keep) {
    log(`KEEP runtime ws://127.0.0.1:${port}/session/v1 token file ${path.join(stateDir, "session-protocol.token")}; touch ${path.join(scratch, "stop")} to end`);
    await new Promise<void>((resolve) => {
      process.once("SIGTERM", resolve);
      process.once("SIGINT", resolve);
      const timer = setInterval(() => fs.existsSync(path.join(scratch, "stop")) && (clearInterval(timer), resolve()), 500);
    });
  }
} catch (error) {
  failures.push(String(error));
  log(String(error));
  log(`runtime output tail:\n${output.split("\n").slice(-40).join("\n")}`);
} finally {
  if (runtime && runtime.exitCode === null) {
    const exited = new Promise((r) => runtime!.once("exit", r));
    runtime.kill("SIGTERM");
    await exited;
  }
  standIn.close();
  fs.writeFileSync(path.join(scratch, "runtime.log"), output);
  fs.writeFileSync(path.join(scratch, "stand-in.log"), standInLog.join("\n"));
  if (unhandled.length > 0) log(`stand-in could not answer: ${[...new Set(unhandled)].join("; ")}`);
  log(`runtime log kept at ${path.join(scratch, "runtime.log")}`);
}
log(failures.length === 0 ? "PASS" : `FAILED (${failures.length}):\n- ${failures.join("\n- ")}`);
process.exit(failures.length === 0 ? 0 : 1);
