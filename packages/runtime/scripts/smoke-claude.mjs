#!/usr/bin/env node
// A deterministic stand-in for the `claude` CLI, for scripts/smoke.ts only: it
// speaks the Claude Agent SDK's stream-json protocol on stdio (control
// requests, user messages) and answers every prompt with a fixed reply, so the
// smoke drives the real runtime, the real SDK and a real child process
// without a model call or anyone's login. A prompt that starts with "slow:"
// holds its result for SMOKE_CLAUDE_HOLD_MS (default 2000) after the answer;
// "slow <ms>:" holds it for <ms>.
// A prompt that starts with "ask:" first asks permission to run a Bash
// command (can_use_tool), then reports what the answer was. "write: <path>
// <text>" writes that file in the working directory first (checkpoints), each
// line that starts "write:" one more file; like the real CLI's Write tool, a
// write waits for the session's PreToolUse hooks (hook_callback), which hold it
// until the turn's checkpoint baseline is kept;
// "mode?" answers with the permission mode it runs in. "cat: <path>" reads a file with Bash first (its content is
// the tool's output). Image content blocks are named after the prompt
// ("images=1 image/png:68"). A dispatched skill
// ("/name args", grill mode) answers "skill=<name>" and then its args.
// A steer (a user message with priority "now") during a held answer does what
// the real CLI does: the in-flight request ends at once with an
// `aborted_streaming` result, and the same turn goes on to answer the steer.
// Answering it as a turn of its own instead left a second result after the
// turn had ended, which the adapter rightly takes for a turn nobody started.
// "chief-shape: <answer>" answers the way a Chief turn often does: it streams the answer, runs three tool calls,
// then streams a short sign-off. "steer-cut: <words>" streams the start of a reply and holds it, unfinished, until a steer
// arrives: then the request ends with `aborted_streaming` and no snapshot of the cut-off block, as the real CLI does,
// and the turn answers the steer. SMOKE_CLAUDE_VERSION is the version it reports (an old Claude Code: 2.1.270);
// `update` updates it as the real updater does (SMOKE_CLAUDE_UPDATE_TO, SMOKE_CLAUDE_VERSION_FILE, SMOKE_CLAUDE_UPDATE_GATE).
// With SMOKE_CLAUDE_STRICT_RESUME set it resumes as the real CLI does: --resume
// reads the session's transcript under this working directory's project
// folder (up to --resume-session-at) and fails without one, and "history?"
// answers with the person's earlier prompts it holds ("history: a | b").
// "model: <words>" calls the model the way the real CLI does: POST <ANTHROPIC_BASE_URL>/v1/messages, streamed, with its
// login (CLAUDE_CODE_OAUTH_TOKEN as a bearer, else ANTHROPIC_API_KEY as x-api-key) and ANTHROPIC_CUSTOM_HEADERS. The
// answer is what the stream said ("smoke ok: model said: ..."); a 429 is tried again after its Retry-After, as the CLI
// does; any other refusal ends the turn as the CLI ends one ("API Error: <status> <message>", api_error_status).
// With SMOKE_CLAUDE_SIGNED_OUT set it reports no account, as a CLI nobody signed in to does; set to a file's
// path, only while that file is there (removing it is a sign-in made meanwhile).
// "bg: <pidfile>" starts a real shell in the background, as Bash with
// run_in_background does (a dev server left running): it writes its pid to
// <pidfile> and runs until the CLI ends it. Like the real CLI it is reported
// with task_started and background_tasks_changed, and dies with the CLI.
// "mcp: <server>/<tool> <json args>" lines call that tool on an MCP server the runtime registered
// (mcp_set_servers), over its real HTTP endpoint, as the real CLI's MCP client does; the answer says
// what each returned. "say: <words>" answers with exactly those words (up to a </note>), so a test
// can script an agent's final answer: a report, a screenshot's Markdown.
// "run <ms>: <path> <word>" runs a shell command with Bash that takes <ms> and then writes <word> to <path> (a build, a
// test run), then goes on with the rest of the prompt. A stop during it cuts it as the real CLI cuts a running tool:
// nothing is written, its result says interrupted, and the request ends. A CLI whose runtime is gone (stdin ended)
// while that command runs ends with it, as every process of a computer that goes down does. Like the real CLI's Bash it
// waits for the session's PreToolUse hooks first (the runtime's gate before each tool); a stop while it waits there
// ends the request with the command never started. A prompt may hold several, run one after another. With
// SMOKE_CLAUDE_RUN_LOG set, each command that starts adds "started <path>" to that file.
// "sh: <command>" lines each run that command in the working directory with Bash, as an agent runs a build or
// makes a commit: after the session's PreToolUse hooks, and with CLAUDE_ENV_FILE sourced first when the session set
// one, as the real CLI does. "when /<regex>/: sh: <command>" (optionally " => <words to answer>") keeps the
// command for a later prompt of this session that matches: what an agent does when its lead writes back.
// "limit: <seconds>" ends the turn as the real CLI ends one whose plan is used up: a rejected rate_limit_event that
// names the reset (that many seconds from now), then the limit's words as the turn's failed result (a 429).
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";

// With SMOKE_CLAUDE_VERSION_FILE set, the version a `claude update` installed is kept there, as the real updater
// replaces the binary; SMOKE_CLAUDE_UPDATE_TO is the version it updates to.
const versionFile = process.env.SMOKE_CLAUDE_VERSION_FILE;
const VERSION = (versionFile && existsSync(versionFile) && readFileSync(versionFile, "utf8").trim()) || process.env.SMOKE_CLAUDE_VERSION || "2.1.111";
const signedOut = () => { const out = process.env.SMOKE_CLAUDE_SIGNED_OUT; return out === "1" || (!!out && existsSync(out)); };
if (process.argv.includes("--version")) {
  process.stdout.write(`${VERSION} (Claude Code)\n`);
  process.exit(0);
}
if (process.argv[2] === "update") {
  const to = process.env.SMOKE_CLAUDE_UPDATE_TO;
  // SMOKE_CLAUDE_UPDATE_GATE: the update waits for that file, as a download takes its time, so a test sees both sides.
  const gate = process.env.SMOKE_CLAUDE_UPDATE_GATE;
  for (const until = Date.now() + 240_000; gate && !existsSync(gate) && Date.now() < until; ) await new Promise((r) => setTimeout(r, 100));
  process.stdout.write(`Current version: ${VERSION}\nChecking for updates to latest version...\n`);
  if (to && versionFile && to !== VERSION) {
    writeFileSync(versionFile, to);
    process.stdout.write(`Successfully updated from ${VERSION} to version ${to}\n`);
  } else process.stdout.write(`Claude Code is up to date (${VERSION})\n`);
  process.exit(0);
}
// The SDK passes most flags as one argv entry (--session-id=<id>, --resume=<id>), some as two.
/** "when /<regex>/: sh: <command>" lines of earlier prompts: what to run when a later prompt matches. */
const reactions = [];
/** The MCP servers the runtime registered (mcp_set_servers), by name. */
let mcpServers = {};
/** One tool call on a registered HTTP MCP server: initialize, then tools/call; answers its result as JSON text. */
async function mcpCall(name, tool, args) {
  // The runtime registers its servers over the control channel, which may land just after the first prompt.
  for (let waited = 0; !mcpServers[name] && waited < 10_000; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
  const server = mcpServers[name];
  if (!server?.url) throw new Error(`no MCP server ${name} (registered: ${Object.keys(mcpServers).join(", ") || "none"})`);
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", ...server.headers };
  const post = async (body, session) => {
    const res = await fetch(server.url, { method: "POST", headers: { ...headers, ...(session ? { "mcp-session-id": session } : {}) }, body: JSON.stringify(body) });
    const text = (await res.text()).trim();
    const data = text.startsWith("{") ? text : text.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5)).pop();
    return { json: data ? JSON.parse(data) : undefined, session: res.headers.get("mcp-session-id") ?? session };
  };
  const init = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke-claude", version: VERSION } } });
  await post({ jsonrpc: "2.0", method: "notifications/initialized" }, init.session);
  const result = await post({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: tool, arguments: args } }, init.session);
  return JSON.stringify(result.json?.result?.structuredContent ?? result.json?.result ?? result.json?.error);
}
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1);
};
const sessionId = arg("--session-id") ?? arg("--resume") ?? randomUUID();
const model = arg("--model") ?? "claude-sonnet-4-6";
const trace = (what, frame) => process.env.SMOKE_CLAUDE_TRACE && appendFileSync(process.env.SMOKE_CLAUDE_TRACE, `${JSON.stringify({ pid: process.pid, what, frame })}\n`);
trace("argv", process.argv.slice(2));
const write = (frame) => (trace("out", frame), process.stdout.write(`${JSON.stringify(frame)}\n`));
/** From the launch, then from live apply_flag_settings, as the real CLI keeps it. */
let effort = arg("--effort") ?? process.argv.find((a) => a.startsWith("--effort="))?.slice(9);
let permissionMode = arg("--permission-mode") ?? process.argv.find((a) => a.startsWith("--permission-mode="))?.slice(18) ?? "default";
const usage = { input_tokens: 12, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 };
// Its session transcript where the real CLI keeps one ($CLAUDE_CONFIG_DIR or ~/.claude, projects/<cwd as a name>), so the
// Agent SDK's forkSession can copy it: a forked chat then resumes the copy like the real CLI does.
let lastUuid = null;
const projectDir = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects", process.cwd().replace(/[^a-zA-Z0-9]/g, "-"));
/** The person's prompts the resumed transcript holds, oldest first (strict resume). */
const earlier = [];
if (process.env.SMOKE_CLAUDE_STRICT_RESUME && arg("--resume")) {
  const file = join(projectDir(), `${arg("--resume")}.jsonl`);
  if (!existsSync(file)) {
    process.stderr.write(`No conversation found with session ID: ${arg("--resume")}\n`);
    process.exit(1);
  }
  const at = arg("--resume-session-at");
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const entry = JSON.parse(line);
    if (entry.type === "user" && typeof entry.message?.content === "string") earlier.push(entry.message.content);
    if (typeof entry.uuid === "string") lastUuid = entry.uuid;
    if (at !== undefined && entry.uuid === at) break;
  }
}
const transcript = (entry) => {
  const dir = projectDir();
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${sessionId}.jsonl`), `${JSON.stringify({ ...entry, parentUuid: lastUuid, sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), isSidechain: false, userType: "external", version: VERSION })}\n`);
  lastUuid = entry.uuid;
};

let initialized = false;
const asks = new Map();
/** Ends the answer being held, when a steer arrives. */
let abortHold;
/** A "run" command is running: it dies with the CLI's runtime. */
let running = false;
const ask = (request) =>
  new Promise((resolve) => {
    const id = `smoke-${randomUUID()}`;
    asks.set(id, resolve);
    write({ type: "control_request", request_id: id, request });
  });
/** The PreToolUse hooks the SDK registered at initialize ({ matcher, hookCallbackIds }). */
let preToolUseHooks = [];
const matches = (matcher, toolName) => {
  if (!matcher || matcher === "*") return true;
  try {
    return new RegExp(`^(?:${matcher})$`).test(toolName);
  } catch {
    return matcher === toolName;
  }
};
/**
 * Runs a tool's PreToolUse hooks (hook_callback) the way the real CLI does before it runs the tool: Claude Agent holds
 * every tool there until its turn's checkpoint baseline is kept. False when a hook denies the tool.
 */
const preToolUse = async (toolName, toolInput, toolUseId = `toolu_${randomUUID().slice(0, 8)}`) => {
  const input = {
    session_id: sessionId, transcript_path: join(projectDir(), `${sessionId}.jsonl`), cwd: process.cwd(), permission_mode: permissionMode,
    hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, tool_use_id: toolUseId,
  };
  for (const { matcher, hookCallbackIds = [] } of preToolUseHooks) {
    if (!matches(matcher, toolName)) continue;
    for (const callbackId of hookCallbackIds) {
      const output = await ask({ subtype: "hook_callback", callback_id: callbackId, input, tool_use_id: toolUseId });
      if (output?.decision === "block" || output?.hookSpecificOutput?.permissionDecision === "deny") return false;
    }
  }
  return true;
};
const reply = async (prompt) => {
  // Only the person's own words hold: a note the runtime wrote ("[Caveman Code] ...") that quotes them does not.
  // A line of its own, "hold: <ms>", holds whatever comes before it (a builder's brief after the runtime's boot note).
  const holdFor = (prompt.startsWith("[Caveman Code]") ? null : /\bhold (\d+)\b/.exec(prompt)) ?? /^hold:\s*(\d+)\s*$/m.exec(prompt);
  const retrieveStatus = /retrieve-status:(\S+)/.exec(prompt)?.[1];
  if (!initialized || retrieveStatus !== undefined) {
    initialized = true;
    write({
      type: "system", subtype: "init", session_id: sessionId, uuid: randomUUID(), cwd: process.cwd(), model,
      tools: [], mcp_servers: retrieveStatus === undefined ? [] : [{ name: "caveman", status: retrieveStatus, source: "dynamic" }], permissionMode: arg("--permission-mode") ?? "default", slash_commands: [],
      apiKeySource: "none", claude_code_version: VERSION, output_style: "default", agents: [], skills: [], plugins: [],
    });
  }
  // An agent's brief (agentTypePrompt) puts its instructions first and the task after a rule: the verbs read the task.
  const agentAt = prompt.indexOf("You are the ");
  const rule = agentAt < 0 ? -1 : prompt.indexOf("\n\n---\n\n", agentAt);
  if (rule >= 0) prompt = prompt.slice(rule + 7);
  // "edit: <path> <old> => <new>" edits a file in the working directory with Edit, as the real CLI records it: the
  // tool result carries the hunk (structuredPatch) with its line numbers.
  const edit = /^edit:\s*(\S+)\s+(.+?)\s+=>\s+(.+)$/m.exec(prompt);
  if (edit) {
    const [, file, oldString, newString] = edit;
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    const filePath = join(process.cwd(), file);
    const input = { file_path: filePath, old_string: oldString, new_string: newString, replace_all: false };
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id, name: "Edit", input }], stop_reason: null, stop_sequence: null, usage },
    });
    const originalFile = readFileSync(filePath, "utf8");
    const lines = originalFile.split("\n");
    const at = lines.findIndex((l) => l.includes(oldString));
    writeFileSync(filePath, originalFile.replace(oldString, newString));
    const changed = lines[at] ?? "";
    const structuredPatch = at < 0 ? [] : [{ oldStart: at + 1, oldLines: 1, newStart: at + 1, newLines: 1, lines: [`-${changed}`, `+${changed.replace(oldString, newString)}`] }];
    write({
      type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `The file ${filePath} has been updated successfully.`, is_error: false }] },
      tool_use_result: { filePath, oldString, newString, originalFile, structuredPatch, userModified: false, replaceAll: false },
    });
    prompt = `edited ${file}`;
  }
  // "create: <path> <word>" writes <word> to a file in the working directory with the Write tool (no approval asked),
  // as an agent writes a file, then goes on with the rest of the prompt. <word> "random:<n>": n MiB of random bytes.
  const create = /^create:\s*(\S+)\s+(\S+)/.exec(prompt);
  if (create) {
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    const random = /^random:(\d+)$/.exec(create[2]);
    const input = { file_path: join(process.cwd(), create[1]), content: random ? randomBytes(Number(random[1]) * 1024 * 1024).toString("latin1") : `${create[2]}\n` };
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id, name: "Write", input: random ? { file_path: input.file_path, content: `(${random[1]} MiB)` } : input }], stop_reason: null, stop_sequence: null, usage },
    });
    mkdirSync(dirname(input.file_path), { recursive: true });
    writeFileSync(input.file_path, input.content, random ? "latin1" : "utf8");
    write({
      type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `File created successfully at: ${input.file_path}`, is_error: false }] },
      tool_use_result: { type: "create", filePath: input.file_path, content: random ? `(${random[1]} MiB)` : input.content, structuredPatch: [] },
    });
    prompt = `wrote ${create[1]}${prompt.slice(create[0].length)}`;
  }
  // "run <ms>: <path> <word>" is a shell command that takes <ms> and writes a file as it ends (no approval asked);
  // several in a prompt run one after another.
  for (let run; (run = /^run (\d+):\s*(\S+)\s+(\S+)/.exec(prompt)); ) {
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    const input = { command: `sleep ${Number(run[1]) / 1000} && echo ${run[3]} > ${run[2]}`, description: "Run the build" };
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id, name: "Bash", input }], stop_reason: null, stop_sequence: null, usage },
    });
    // The session's PreToolUse hooks first, as the real CLI's Bash: a stop while it waits there ends the request.
    const allowed = await new Promise((resolve) => {
      abortHold = () => resolve(undefined);
      void preToolUse("Bash", input, id).then(resolve);
    });
    abortHold = undefined;
    const cut =
      allowed === undefined ||
      (allowed &&
        (await new Promise((resolve) => {
          running = true;
          if (process.env.SMOKE_CLAUDE_RUN_LOG) appendFileSync(process.env.SMOKE_CLAUDE_RUN_LOG, `started ${run[2]}\n`);
          const timer = setTimeout(() => resolve(false), Number(run[1]));
          abortHold = () => (clearTimeout(timer), resolve(true));
        })));
    abortHold = undefined;
    running = false;
    if (allowed === false) {
      write({
        type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "Denied by a hook.", is_error: true }] },
        tool_use_result: { stdout: "", stderr: "", interrupted: false, isImage: false },
      });
      const after = prompt.slice(run[0].length);
      prompt = /^\s*run \d+:/.test(after) ? after.trimStart() : `not run ${run[2]}${after}`;
      continue;
    }
    if (!cut) {
      mkdirSync(dirname(join(process.cwd(), run[2])), { recursive: true });
      writeFileSync(join(process.cwd(), run[2]), `${run[3]}\n`);
    }
    write({
      type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: cut ? "[Request interrupted by user for tool use]" : "", is_error: cut }] },
      tool_use_result: { stdout: "", stderr: "", interrupted: cut, isImage: false },
    });
    if (cut) {
      write({
        type: "result", subtype: "error_during_execution", is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1,
        terminal_reason: "aborted_streaming", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], errors: [], uuid: randomUUID(),
      });
      return;
    }
    // The next command of the prompt, if it holds one; else the words go on as the answer.
    const rest = prompt.slice(run[0].length);
    prompt = /^\s*run \d+:/.test(rest) ? rest.trimStart() : `ran ${run[2]}${rest}`;
  }
  // "cat: <path>" reads a file in the working directory with Bash (no approval asked), as an agent does, then says so.
  const cat = /^cat:\s*(\S+)/.exec(prompt);
  const rest = cat ? prompt.slice(cat[0].length) : "";
  if (cat) {
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id, name: "Bash", input: { command: `cat ${cat[1]}`, description: "Read the file" } }], stop_reason: null, stop_sequence: null, usage },
    });
    let content;
    try {
      content = readFileSync(cat[1], "utf8");
    } catch (error) {
      content = String(error.message);
    }
    // As the real CLI sends a Bash result: the content block, and the streams beside it.
    write({
      type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error: false }] },
      tool_use_result: { stdout: content, stderr: "", interrupted: false, isImage: false },
    });
    prompt = `read ${cat[1]}${rest}`;
  }
  // "sh: <command>" lines, and the commands earlier prompts kept for one like this ("when /<regex>/: sh: ...").
  const kept = reactions.filter((r) => r.pattern.test(prompt));
  for (const [, pattern, command, words] of prompt.matchAll(/^when \/(.+?)\/: sh:\s*(.+?)(?:\s+=>\s+(.+))?$/gm)) reactions.push({ pattern: new RegExp(pattern), command, words });
  const shells = [...[...prompt.matchAll(/^sh:\s*(.+)$/gm)].map((m) => m[1]), ...kept.map((r) => r.command)];
  for (const command of shells) {
    if (!(await preToolUse("Bash", { command }))) continue;
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id, name: "Bash", input: { command, description: "Run the command" } }], stop_reason: null, stop_sequence: null, usage },
    });
    const envFile = process.env.CLAUDE_ENV_FILE;
    const ran = spawnSync("/bin/sh", ["-c", `${envFile && existsSync(envFile) ? `. "${envFile}"\n` : ""}${command}`], { cwd: process.cwd(), encoding: "utf8" });
    const failed = ran.status !== 0;
    write({
      type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${ran.stdout}${ran.stderr}${failed ? `\nExit code ${ran.status}` : ""}`, is_error: failed }] },
      tool_use_result: { stdout: ran.stdout, stderr: ran.stderr, interrupted: false, isImage: false },
    });
  }
  const keptWords = kept.map((r) => r.words).filter(Boolean).pop();
  if (keptWords) prompt = `say: ${keptWords}`;
  // "bg: <pidfile>" leaves a real process running after the turn, as the real CLI's background Bash does.
  const bg = /^bg:\s*(\S+)/.exec(prompt);
  if (bg) {
    const id = `toolu_${randomUUID().slice(0, 8)}`;
    const taskId = `b${randomUUID().slice(0, 8)}`;
    const command = `echo $$ > ${bg[1]}; while :; do sleep 1; done`;
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "tool_use", id, name: "Bash", input: { command, run_in_background: true } }], stop_reason: null, stop_sequence: null, usage },
    });
    backgroundShells.add(spawn("/bin/sh", ["-c", command], { stdio: "ignore" }));
    write({ type: "system", subtype: "task_started", task_id: taskId, tool_use_id: id, description: command, task_type: "local_bash", uuid: randomUUID(), session_id: sessionId });
    write({ type: "system", subtype: "background_tasks_changed", tasks: [{ task_id: taskId, description: command, task_type: "local_bash" }], uuid: randomUUID(), session_id: sessionId });
    write({
      type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `Command running in background with ID: ${taskId}.`, is_error: false }] },
      tool_use_result: { stdout: "", stderr: "", interrupted: false, isImage: false, backgroundTaskId: taskId },
    });
    prompt = `started ${taskId}`;
  }
  // "asks: <n>" asks n approvals at once (parallel tool calls), then reports each answer.
  const many = /^asks:\s*(\d+)/.exec(prompt);
  if (prompt.startsWith("ask:") || many) {
    const inputs = Array.from({ length: many ? Number(many[1]) : 1 }, (_, i) => ({ id: `toolu_${randomUUID().slice(0, 8)}`, input: { command: many ? `echo smoke ${i + 1}` : "echo smoke", description: "Print smoke" } }));
    write({
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: inputs.map((t) => ({ type: "tool_use", id: t.id, name: "Bash", input: t.input })), stop_reason: null, stop_sequence: null, usage },
    });
    const decisions = await Promise.all(inputs.map((t) => ask({ subtype: "can_use_tool", tool_name: "Bash", input: t.input, tool_use_id: t.id, permission_suggestions: [] })));
    const words = decisions.map((decision, i) => {
      const allowed = decision?.behavior === "allow";
 // A deny's own message (the person's note, upstream #23657) is what the tool call reads; the default one says nothing more.
      const note = !allowed && typeof decision?.message === "string" && !/^User (declined|cancelled) tool execution\.$/.test(decision.message) ? decision.message : undefined;
      write({
        type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: inputs[i].id, content: allowed ? "smoke" : (note ?? "denied"), is_error: !allowed }] },
      });
      return allowed ? "allowed" : note === undefined ? "denied" : `denied (${note})`;
    });
    prompt = `${words.join(" ")} ${prompt.slice(many ? many[0].length : 4).trim()}`;
  }
  // A skill the runtime dispatched ("/plugin:skill args"): say which, then answer the args.
  const skill = /^\/(\S+)\s*([\s\S]*)$/.exec(prompt);
  if (skill) prompt = skill[2];
  if (/^write:\s/.test(prompt)) {
    for (const part of prompt.split(/\n(?=write:\s)/)) {
      const file = /^write:\s*(\S+)\s+([\s\S]*)$/.exec(part);
      if (!file) continue;
      // A Write tool call: it runs once the session's PreToolUse hooks let it, not before.
      if (!(await preToolUse("Write", { file_path: join(process.cwd(), file[1]), content: file[2] }))) continue;
      mkdirSync(dirname(join(process.cwd(), file[1])), { recursive: true });
      writeFileSync(file[1], file[2]);
    }
  }
  if (prompt.startsWith("mode?")) prompt = `mode=${permissionMode}`;
  const calls = [...prompt.matchAll(/^mcp:\s*([^/\s]+)\/(\S+)\s+(.*)$/gm)];
  const called = [];
  for (const [, server, tool, args] of calls) called.push(`${tool} -> ${await mcpCall(server, tool, JSON.parse(args)).catch((error) => `error: ${error.message}`)}`);
  const said = /(?:^|\n|>)\s*say:\s*([\s\S]*?)\s*(?:<\/note>|$)/.exec(prompt);
  // A call that failed is said even then: a test reads why.
  if (said) prompt = [said[1], ...called.filter((line) => / -> error: /.test(line))].join("\n");
  else if (called.length > 0) prompt = called.join("\n");
  // Context put before the person's message (a handoff, what ran on another computer): the verbs read their message.
  const own = prompt.lastIndexOf("\nUser message:\n");
  const asked = own < 0 ? prompt : prompt.slice(own + "\nUser message:\n".length);
  // The person's own prompts: notes the runtime wrote ("[Caveman Code] ...") are left out.
  if (asked.startsWith("history?")) prompt = `history: ${earlier.filter((p) => !p.startsWith("[")).map((p) => p.replace(/\s+/g, " ")).join(" | ")}`;
  if (prompt.startsWith("effort?")) prompt = `effort=${effort ?? "none"}`;
  const limited = /^limit:\s*(\d+)/m.exec(asked);
  if (limited) {
    write({ type: "rate_limit_event", rate_limit_info: { status: "rejected", rateLimitType: "five_hour", resetsAt: Math.floor(Date.now() / 1000) + Number(limited[1]) }, uuid: randomUUID(), session_id: sessionId });
    const text = "You've hit your session limit";
    const failed = {
      type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
      message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage },
    };
    write(failed);
    transcript({ type: "assistant", uuid: failed.uuid, message: failed.message });
    write({
      type: "result", subtype: "success", is_error: true, api_error_status: 429, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: text,
      stop_reason: null, session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID(),
    });
    return;
  }
  const modelCall = /^model:\s*([\s\S]*)$/.exec(asked);
  if (modelCall) {
    const base = (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com").replace(/\/+$/, "");
    const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
    for (const line of (process.env.ANTHROPIC_CUSTOM_HEADERS ?? "").split(/\r?\n/)) {
      const colon = line.indexOf(":");
      if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) headers.authorization = `Bearer ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`;
    else if (process.env.ANTHROPIC_API_KEY) headers["x-api-key"] = process.env.ANTHROPIC_API_KEY;
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(`${base}/v1/messages`, { method: "POST", headers, body: JSON.stringify({ model, stream: true, max_tokens: 64, messages: [{ role: "user", content: modelCall[1] }] }) });
      if (response.status !== 429 || attempt >= 2) break;
      await response.arrayBuffer();
      await new Promise((r) => setTimeout(r, Math.min(2_000, (Number(response.headers.get("retry-after")) || 1) * 1_000)));
    }
    const body = await response.text();
    if (!response.ok) {
      let message = body;
      try {
        const parsed = JSON.parse(body);
        message = parsed?.error?.message ?? body;
      } catch {}
      const text = `API Error: ${response.status} ${message}`;
      const failed = {
        type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
        message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage },
      };
      write(failed);
      transcript({ type: "assistant", uuid: failed.uuid, message: failed.message });
      write({
        type: "result", subtype: "success", is_error: true, api_error_status: response.status, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: text,
        stop_reason: null, session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID(),
      });
      return;
    }
    const answered = [...body.matchAll(/"type":"text_delta","text":("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1])).join("");
    prompt = `model said: ${answered}`;
  }
  // What a Bash command gets from the workspace: claude runs CLAUDE_ENV_FILE in the command's
  // shell first. The CLI's own environment must not carry the workspace's variables.
  if (prompt.startsWith("env?")) {
    const bash = execFileSync("/bin/sh", ["-c", '[ -n "$CLAUDE_ENV_FILE" ] && . "$CLAUDE_ENV_FILE"; echo "port=${CAVEMAN_PORT_WEB:-unset} env=${SMOKE_ENV:-unset}"'], { encoding: "utf8" }).trim();
    // Nor the runtime's own variables (the smoke starts the runtime with CAVEMAN_CODE_HOME).
    prompt = `${bash} cli=${process.env.CAVEMAN_PORT_WEB ?? process.env.SMOKE_ENV ?? "unset"} runtime=${process.env.CAVEMAN_CODE_HOME === undefined ? "unset" : "leaked"}`;
  }
  // "hold <ms>" anywhere in what was asked: the answer comes that much later, after any tool ran (a turn caught mid-way); a stop ends it.
  if (holdFor) {
    const stopped = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Number(holdFor[1]));
      abortHold = () => (clearTimeout(timer), resolve(true));
    });
    abortHold = undefined;
    if (stopped) {
      write({
        type: "result", subtype: "error_during_execution", is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1,
        terminal_reason: "aborted_streaming", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], errors: [], uuid: randomUUID(),
      });
      return;
    }
  }
  // Anywhere in what was asked: the Chief wraps the person's note in its own context.
  const shaped = /chief-shape:[ \t]*([^\n]*)/.exec(asked);
  if (shaped) return chiefShape(shaped[1].trim() || "I'm the Chief. I coordinate your work.");
  const cut = /steer-cut:[ \t]*([^\n]*)/.exec(asked);
  if (cut) return cutOff(cut[1].trim() || "I'm the Chief for your Caveman Code setup. You type notes to");
  const text = said ? prompt : `smoke ok: ${skill ? `skill=${skill[1]} ` : ""}${prompt.replace(/^slow(?: \d+)?:\s*/, "")}`;
  const answer = {
    type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null,
    message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage },
  };
  write(answer);
  transcript({ type: "assistant", uuid: answer.uuid, message: answer.message });
  const slow = /^slow(?: (\d+))?:/.exec(prompt);
  const aborted =
    slow &&
    (await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Number(slow[1] ?? process.env.SMOKE_CLAUDE_HOLD_MS ?? 2000));
      abortHold = () => (clearTimeout(timer), resolve(true));
    }));
  abortHold = undefined;
  if (aborted) {
    write({
      type: "result", subtype: "error_during_execution", is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1,
      terminal_reason: "aborted_streaming", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], errors: [], uuid: randomUUID(),
    });
    return;
  }
  write({
    type: "result", subtype: "success", is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result: text,
    stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID(),
  });
};

/** One streamed text block, as the CLI streams it with partial messages on: start, deltas, then (unless cut) stop and its snapshot. */
const streamText = async (text, { finish = true } = {}) => {
  const id = `msg_${randomUUID()}`;
  const stream = (event) => write({ type: "stream_event", event, parent_tool_use_id: null, uuid: randomUUID(), session_id: sessionId });
  stream({ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } });
  stream({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  // A pause between pieces and none after the last: whoever streams a block and then waits (cutOff, for the steer)
  // waits from the moment its last piece is out, so a steer sent on seeing that piece never finds nobody waiting.
  for (const [i, piece] of (text.match(/.{1,12}/gs) ?? []).entries()) {
    if (i > 0) await new Promise((r) => setTimeout(r, 15));
    stream({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: piece } });
  }
  if (!finish) return;
  stream({ type: "content_block_stop", index: 0 });
  const answer = { type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, message: { id, type: "message", role: "assistant", model, content: [{ type: "text", text }], stop_reason: null, stop_sequence: null, usage } };
  write(answer);
  transcript({ type: "assistant", uuid: answer.uuid, message: answer.message });
  stream({ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage });
  stream({ type: "message_stop" });
};
const done = (result) =>
  write({ type: "result", subtype: "success", is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1, result, stop_reason: "end_turn", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], uuid: randomUUID() });

/** The answer, three tool calls, then a sign-off: what a Chief turn that updates its items looks like. */
const chiefShape = async (answerText) => {
  await streamText(answerText);
  const calls = [1, 2, 3].map((n) => ({ id: `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`, input: { command: `echo item ${n}`, description: `Update item ${n}` } }));
  write({ type: "assistant", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, message: { id: `msg_${randomUUID()}`, type: "message", role: "assistant", model, content: calls.map((c) => ({ type: "tool_use", id: c.id, name: "Bash", input: c.input })), stop_reason: null, stop_sequence: null, usage } });
  for (const c of calls)
    write({ type: "user", session_id: sessionId, uuid: randomUUID(), parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: c.id, content: c.input.command.slice(5), is_error: false }] }, tool_use_result: { stdout: c.input.command.slice(5), stderr: "", interrupted: false, isImage: false } });
  const signOff = "All set. Let me know what you'd like to work on.";
  await streamText(signOff);
  done(signOff);
};

/** A reply cut off mid-stream by a steer: no snapshot, an aborted_streaming result; the queue then answers the steer. */
const cutOff = async (partial) => {
  await streamText(partial, { finish: false });
  const steered = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), Number(process.env.SMOKE_CLAUDE_HOLD_MS ?? 10_000));
    abortHold = () => (clearTimeout(timer), resolve(true));
  });
  abortHold = undefined;
  if (steered) {
    write({
      type: "result", subtype: "error_during_execution", is_error: false, duration_ms: 10, duration_api_ms: 5, num_turns: 1,
      terminal_reason: "aborted_streaming", session_id: sessionId, total_cost_usd: 0, usage, modelUsage: {}, permission_denials: [], errors: [], uuid: randomUUID(),
    });
    return;
  }
  done(partial);
};

const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");

/** Shells "bg:" started: the CLI ends them when it exits, as the real one does. */
const backgroundShells = new Set();
const endBackgroundShells = () => {
  for (const child of backgroundShells) child.kill("SIGKILL");
};
process.on("exit", endBackgroundShells);
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));

let queue = Promise.resolve();
createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  const frame = JSON.parse(line);
  trace("in", frame);
  if (frame.type === "control_response") {
    asks.get(frame.response?.request_id)?.(frame.response?.response);
    asks.delete(frame.response?.request_id);
  } else if (frame.type === "control_request") {
    if (frame.request?.subtype === "initialize") preToolUseHooks = frame.request.hooks?.PreToolUse ?? [];
    const response =
      frame.request?.subtype === "initialize"
        ? {
            commands: [], agents: [], output_style: "default", available_output_styles: ["default"],
            models: [{ value: model, displayName: "Claude Sonnet (smoke)", description: "smoke stand-in" }],
            account: signedOut() ? { tokenSource: "none", apiKeySource: "none", apiProvider: "firstParty" } : { email: "smoke@example.invalid", subscriptionType: "smoke", apiProvider: "firstParty" },
          }
        : frame.request?.subtype === "mcp_set_servers"
          ? ((mcpServers = frame.request.servers ?? {}), { added: Object.keys(frame.request.servers ?? {}), removed: [], errors: {} })
          : frame.request?.subtype === "set_permission_mode"
            ? ((permissionMode = frame.request.mode), {})
          : frame.request?.subtype === "apply_flag_settings"
            ? ((effort = frame.request.settings?.effortLevel ?? effort), {})
          : frame.request?.subtype === "mcp_status"
            ? { mcpServers: [] }
            : frame.request?.subtype === "interrupt"
              ? (abortHold?.(), {})
              : {};
    write({ type: "control_response", response: { subtype: "success", request_id: frame.request_id, response } });
  } else if (frame.type === "user") {
    if (frame.priority === "now") abortHold?.();
    // Image content blocks the CLI was handed: said after the prompt ("images=1 image/png:68"), as nothing else shows them.
    const images = Array.isArray(frame.message?.content) ? frame.message.content.filter((part) => part.type === "image") : [];
    const seen = images.length ? ` images=${images.length} ${images.map((part) => `${part.source?.media_type}:${Buffer.from(part.source?.data ?? "", "base64").length}`).join(",")}` : "";
    queue = queue.then(() => {
      transcript({ type: "user", uuid: frame.uuid ?? randomUUID(), message: { role: "user", content: textOf(frame.message?.content) } });
      earlier.push(textOf(frame.message?.content));
      return reply(`${textOf(frame.message?.content)}${seen}`);
    });
  }
});
process.stdin.on("end", () => (running ? process.exit(0) : queue.then(() => process.exit(0))));
