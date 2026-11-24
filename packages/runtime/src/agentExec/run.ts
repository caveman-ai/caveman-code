// `caveman-runtime agent exec` (platform CONTRACT §8.1): one agent, headless,
// in place, to its end. A third way into code that exists, beside an app chat and a Cloud computer's mail: the agent
// file goes through the one agent loader (@caveman-app/automations parseAgentFile), the engine is the Caveman engine in
// the shape its file asks for (provider-caveman exec, on the Caveman harness: the coding loadout its model was measured
// on, or the general loadout with only its own tools), and every event goes through the one
// Session-Protocol-to-public-event mapper (cloudLink/publicEvents.ts) on its way out.
// Flags stand where Cloud's session_start mail stands, stdin where its mailbox does, and stdout or a file where its
// outbox does. No desktop, no Cloud link, no worktree, no keychain: the model endpoint is CAVEMAN_MODEL_BASE_URL and a
// key from CAVEMAN_MODEL_API_KEY_FILE (read, then deleted) or CAVEMAN_MODEL_API_KEY, all taken out of this process's
// environment before anything starts, so no tool, command or MCP server the agent runs inherits the key. Only the file
// keeps it out of the spawn environment, which same-user processes can read (`ps eww`, /proc/<pid>/environ).
// CAVEMAN_CONNECTORS_URL, when Cloud's harness pool sets it, is the session's endpoint at Cloud's connector gate
// (provider-caveman connectorGate.ts): taken out with them, its card read once before the session opens, with the
// model key as its bearer.
//
// With --sandbox-file (tier linux on Cloud's harness pool), a coding agent's commands and files run on the session's
// Caveman sandbox instead of in --cwd: the harness drives it through the public sandbox API with the endpoint's key (the
// session's own), makes it at the first tool call that needs one (or attaches the session's), writes the build's files
// (--cwd) into one it made, and says what happens to it as session.sandbox events (sandboxFile.ts). Nothing in the
// sandbox holds the key. A build's secrets (CAVEMAN_SANDBOX_SECRETS_FILE, read and deleted at start, kept in memory) ride
// in each command's environment there, never in its files, and are redacted from all this command says.
//
// Lifecycle. Without --input the run ends at its first end of turn (exit 0). With --input -, a finished turn leaves the
// session idle and a user.message starts the next; stdin ending ends it (`terminated`, end_turn). A `finish` custom
// tool call ends it at once (exit 0). Budget and time limits end it with `budget_reached` (exit 3, 4).
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";

import { parseAgentFile, type ParsedAgent } from "@caveman-app/automations";
import {
  approvalKindFor,
  approvalPrompt,
  defaultEffort,
  effortLevel,
  endpointFamily,
  execModel,
  openConnectorGate,
  openExecSession,
  parseBaseUrl,
  parseConnectorsUrl,
  reservedServerName,
  type ConnectorGate,
  type ExecApprovalCall,
  type ExecDraft,
  type ExecSession,
} from "@caveman-app/provider-caveman/exec";
import type { SessionEvent } from "@caveman-app/session-protocol";

import { agentTypePrompt } from "../agents/agentTypes.ts";
import { expectInput, initialMapperState, mapSessionEvent, sandboxEvent, sessionError, terminated, type PublicEvent } from "../cloudLink/publicEvents.ts";
import { responseFor } from "../session-protocol/askAnswers.ts";
import { startClientServer, type ClientServer } from "./clientServer.ts";
import { EXIT, parseExecFlags, USAGE, UsageError, type Access, type ExecFlags } from "./flags.ts";
import { resolveExecModel } from "./model.ts";
import { buildFiles, readSandboxFile, readSandboxSecrets, SECRETS_ENV, type SandboxFile, type SandboxSecret } from "./sandboxFile.ts";

/** The environment the model endpoint and the connector gate come from; taken out of this process's before anything starts. */
export const MODEL_ENV = ["CAVEMAN_MODEL_BASE_URL", "CAVEMAN_MODEL_API_KEY", "CAVEMAN_MODEL_API_KEY_FILE", "CAVEMAN_CONNECTORS_URL"] as const;
const PARK_FILE_ENV = "CAVEMAN_PARK_FILE";
/** Keep park.json safely below Cloud's 256 KiB pool limit (harness pool maxParkFileBytes). */
const MAX_PARK_JSON_BYTES = 240 * 1024;

type AskUser = Extract<SessionEvent, { type: "ask.user" }>["payload"];
type AskAnswer = { readonly ask_id: string; readonly decision?: "allow" | "deny"; readonly text?: string; readonly message?: string; readonly content?: string; readonly is_error?: boolean };
/** What this session says: the engine's drafts, and the runtime's own (the caller's messages, the asks, a turn's end). */
type Draft =
  | ExecDraft
  | { readonly type: "ask.user"; readonly item_id: string; readonly payload: AskUser }
  | { readonly type: "ask.resolved"; readonly item_id: string; readonly payload: Extract<SessionEvent, { type: "ask.resolved" }>["payload"] }
  | { readonly type: "turn.done"; readonly payload: Extract<SessionEvent, { type: "turn.done" }>["payload"] };

const MODES: Record<Access, "full-access" | "auto-accept-edits" | "approval-required"> = { full: "full-access", auto: "auto-accept-edits", ask: "approval-required" };
const FINISH = "finish";

export interface ExecIo {
  readonly stdin: NodeJS.ReadableStream;
  readonly stdout: NodeJS.WritableStream;
  readonly stderr: NodeJS.WritableStream;
}

/** The events out: numbered, one JSON object per line, the model key and the build's secrets never in them. */
class EventSink {
  #seq = 0;
  #fd: number | undefined;
  #first = true;
  readonly stdout: NodeJS.WritableStream;
  readonly redact: (line: string) => string;
  readonly model: () => string | undefined;
  constructor(target: string, stdout: NodeJS.WritableStream, redact: (line: string) => string, model: () => string | undefined) {
    this.stdout = stdout;
    this.redact = redact;
    this.model = model;
    if (target !== "-") this.#fd = fs.openSync(target, "a");
  }
  write(events: ReadonlyArray<PublicEvent>): void {
    for (const event of events) {
      let data = event.data;
      // The first status says which model the session runs on.
      if (event.type === "session.status" && this.#first) {
        this.#first = false;
        const model = this.model();
        if (model !== undefined) data = { ...data, model };
      }
      const line = this.redact(JSON.stringify({ seq: ++this.#seq, type: event.type, created_at: event.created_at, data }));
      if (this.#fd !== undefined) fs.writeSync(this.#fd, `${line}\n`);
      else this.stdout.write(`${line}\n`);
    }
  }
  get seq(): number {
    return this.#seq;
  }
  async close(): Promise<void> {
    const fd = this.#fd;
    this.#fd = undefined;
    if (fd !== undefined) fs.closeSync(fd);
    else await new Promise<void>((resolve) => this.stdout.write("", () => resolve()));
  }
}

const now = () => new Date().toISOString();

/** The agent file `--agent` or `--agent-file` names, through the one agent loader; a string says why it cannot run. */
function loadAgent(flags: ExecFlags, cwd: string): ParsedAgent | string {
  const file = flags.agentFile !== undefined ? path.resolve(cwd, flags.agentFile) : path.join(cwd, ".caveman", "agents", `${flags.agent}.md`);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    return `${file}: ${(error as Error).message}`;
  }
  const where = flags.agentFile !== undefined ? flags.agentFile : `.caveman/agents/${flags.agent}.md`;
  const parsed = parseAgentFile({ path: where, text }, "project");
  const errors = parsed.diagnostics.filter((d) => d.severity === "error");
  if (parsed.agent === undefined || errors.length > 0) return errors.map((d) => `${where} line ${d.line}: ${d.message}`).join(" ") || `${where} has no usable name`;
  return parsed.agent;
}

/** One user.* event from stdin, checked against CONTRACT §3.3; a string says what is wrong with it. */
function inputEvent(line: string):
  | { readonly type: "user.message"; readonly text: string; readonly input_id?: string }
  | { readonly type: "user.interrupt" }
  | { readonly type: "user.approval" | "user.answer" | "user.tool_result"; readonly ask_id: string; readonly answer: AskAnswer }
  | string {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return "a line that is not JSON";
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return "a line that is not a JSON object";
  const event = value as Record<string, unknown>;
  const text = (key: string) => (typeof event[key] === "string" ? (event[key] as string) : undefined);
  switch (event.type) {
    case "user.message": {
      if (typeof event.text !== "string" || event.text.trim() === "") return "user.message takes text";
      const input = text("input_id");
      if (event.input_id !== undefined && !input) return "user.message's input_id is a non-empty string";
      return { type: "user.message", text: event.text, ...(input ? { input_id: input } : {}) };
    }
    case "user.interrupt":
      return { type: "user.interrupt" };
    case "user.approval":
    case "user.answer":
    case "user.tool_result": {
      const askId = text("ask_id");
      if (askId === undefined || askId === "") return `${event.type} takes ask_id`;
      if (event.type === "user.approval" && event.decision !== "allow" && event.decision !== "deny") return "user.approval takes decision allow or deny";
      if (event.type === "user.answer" && text("text") === undefined) return "user.answer takes text";
      if (event.type === "user.tool_result" && text("content") === undefined) return "user.tool_result takes content";
      if (event.is_error !== undefined && typeof event.is_error !== "boolean") return "is_error is true or false";
      const answer: AskAnswer = {
        ask_id: askId,
        ...(event.decision === "allow" || event.decision === "deny" ? { decision: event.decision } : {}),
        ...(text("text") === undefined ? {} : { text: text("text")! }),
        ...(text("message") === undefined ? {} : { message: text("message")! }),
        ...(text("content") === undefined ? {} : { content: text("content")! }),
        ...(event.is_error === true ? { is_error: true } : {}),
      };
      return { type: event.type, ask_id: askId, answer };
    }
    default:
      return `type ${JSON.stringify(event.type)} is not one of user.message, user.interrupt, user.approval, user.answer, user.tool_result`;
  }
}

/** `${VAR}` in the agent's MCP server configs, from this process's environment (the model's are gone already). */
const resolveValue = async (value: string) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? "");

/**
 * The model endpoint, out of the environment before anything starts. The key comes from CAVEMAN_MODEL_API_KEY_FILE
 * (read, then the file deleted, so the key is only in this process's memory), else from CAVEMAN_MODEL_API_KEY (C5's;
 * the environment a process was spawned with stays readable to every process of its user, `ps eww` or
 * /proc/<pid>/environ, so Cloud moves to the file). The connector gate's endpoint, CAVEMAN_CONNECTORS_URL, leaves with
 * them.
 */
export function takeModelEnv(env: NodeJS.ProcessEnv = process.env): {
  readonly baseUrl: string | undefined;
  readonly key: string;
  readonly connectorsUrl: string | undefined;
  readonly error?: string;
} {
  const baseUrl = env.CAVEMAN_MODEL_BASE_URL;
  const connectorsUrl = env.CAVEMAN_CONNECTORS_URL;
  const file = env.CAVEMAN_MODEL_API_KEY_FILE?.trim();
  let key = env.CAVEMAN_MODEL_API_KEY ?? "";
  let error: string | undefined;
  for (const name of MODEL_ENV) delete env[name];
  if (file) {
    try {
      key = fs.readFileSync(file, "utf8").trim();
      if (key === "") error = `CAVEMAN_MODEL_API_KEY_FILE ${file} is empty; write the endpoint's key in it`;
    } catch (cause) {
      key = "";
      error = `CAVEMAN_MODEL_API_KEY_FILE ${file} cannot be read (${(cause as NodeJS.ErrnoException).code ?? (cause as Error).message}); write the endpoint's key in a file this user can read`;
    }
    fs.rmSync(file, { force: true });
  }
  return { baseUrl, key, connectorsUrl, ...(error === undefined ? {} : { error }) };
}

/**
 * A linux session's build secrets, out of the environment before anything starts: read once from the file
 * CAVEMAN_SANDBOX_SECRETS_FILE names (readSandboxSecrets), the file deleted right after, and kept in this process's
 * memory alone (the pool removes the file too, after the child, should this not have).
 */
export function takeSandboxSecrets(env: NodeJS.ProcessEnv = process.env): { readonly file?: string; readonly secrets: ReadonlyArray<SandboxSecret>; readonly error?: string } {
  const file = env[SECRETS_ENV]?.trim();
  delete env[SECRETS_ENV];
  if (!file) return { secrets: [] };
  const read = readSandboxSecrets(file, { remove: true });
  return typeof read === "string" ? { file, secrets: [], error: read } : { file, secrets: read };
}

/** Where to write a durable park descriptor (CAVEMAN_PARK_FILE), removed from process.env before tools run. */
function takeParkFile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = env[PARK_FILE_ENV]?.trim();
  delete env[PARK_FILE_ENV];
  return file || undefined;
}

interface ParsedResume {
  readonly resumeCount: number;
  readonly checkpointSeq: number;
  readonly messages: ReadonlyArray<unknown>;
  readonly resolvedWaits?: unknown;
  readonly pendingMessages: ReadonlyArray<string>;
}

/** Reads a durable resume file (--resume <file>) written by Cloud's harness pool. */
function readResumeFile(file: string): ParsedResume | string {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (cause) {
    return `--resume ${file}: ${(cause as Error).message}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return `--resume ${file}: invalid JSON (${(cause as Error).message})`;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return `--resume ${file}: expected a JSON object`;
  }
  const obj = parsed as Record<string, unknown>;
  const checkpoint = obj.checkpoint !== null && typeof obj.checkpoint === "object" && !Array.isArray(obj.checkpoint)
    ? (obj.checkpoint as Record<string, unknown>)
    : undefined;
  const messages = Array.isArray(checkpoint?.messages) ? checkpoint.messages : [];
  const pendingMessages = Array.isArray(obj.pending_messages)
    ? obj.pending_messages.filter((item): item is string => typeof item === "string" && item.trim() !== "")
    : [];
  const resolvedWaits = obj.resolved_waits !== undefined && obj.resolved_waits !== null && (!Array.isArray(obj.resolved_waits) || obj.resolved_waits.length > 0)
    ? obj.resolved_waits
    : undefined;
  return {
    resumeCount: typeof obj.resume_count === "number" && Number.isFinite(obj.resume_count) ? obj.resume_count : 0,
    checkpointSeq: typeof obj.checkpoint_seq === "number" && Number.isFinite(obj.checkpoint_seq) ? obj.checkpoint_seq : 0,
    messages,
    ...(resolvedWaits === undefined ? {} : { resolvedWaits }),
    pendingMessages,
  };
}

/** Reads and validates an optional JSON Schema file (--output-schema <file>). */
function readOutputSchema(file: string): string | { readonly error: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (cause) {
    return { error: `--output-schema ${file}: ${(cause as Error).message}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return { error: `--output-schema ${file}: invalid JSON (${(cause as Error).message})` };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `--output-schema ${file}: expected a JSON Schema object` };
  }
  return JSON.stringify(parsed);
}

const outputSchemaNote = (schemaJson: string) =>
  `Output format requirement: your final response must be valid JSON conforming to this JSON Schema, with no surrounding markdown fences or extra commentary:\n${schemaJson}`;

interface ParkWait {
  readonly kind: "approval" | "caller_tool";
  readonly ask_id: string;
  readonly reason?: string;
}

interface ParkRequest {
  readonly state: "waiting" | "idle";
  readonly stop_reason: "requires_action" | "end_turn";
  readonly waits: ReadonlyArray<ParkWait>;
}

/** Writes the durable park descriptor to CAVEMAN_PARK_FILE, redacted and bounded under Cloud's 256 KiB limit. */
function writeParkFile(
  parkFile: string,
  park: ParkRequest,
  checkpointSeq: number,
  messages: ReadonlyArray<unknown>,
  redact: (text: string) => string,
): void {
  const build = (includeMessages: boolean) =>
    redact(
      JSON.stringify({
        state: park.state,
        stop_reason: park.stop_reason,
        checkpoint_seq: checkpointSeq,
        checkpoint: includeMessages ? { version: 1, messages } : { version: 1, messages: [], truncated: true },
        waits: park.waits,
      }),
    );
  let body = build(true);
  if (Buffer.byteLength(body, "utf8") > MAX_PARK_JSON_BYTES) body = build(false);
  fs.writeFileSync(parkFile, `${body}\n`, { encoding: "utf8", mode: 0o600 });
}

/**
 * What agent exec redacts from every event and stderr line, as the pool does (Caveman Cloud harness pool
 * pump.go `hidden`): the key, and each build secret's value as it is and as it reads inside a JSON string (an event
 * line carries a command's output escaped), longest first, so a value inside another is never cut first.
 */
function hidden(key: string, secrets: ReadonlyArray<SandboxSecret>): ReadonlyArray<string> {
  const out = new Set(key.length >= 8 ? [key] : []);
  for (const { value } of secrets) out.add(value).add(JSON.stringify(value).slice(1, -1));
  return [...out].sort((a, b) => b.length - a.length);
}

/** Runs the command; resolves to its exit code, always one of 0-4, after a final `terminated` status once it has an events channel. */
export async function runAgentExec(argv: ReadonlyArray<string>, io: ExecIo = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr }): Promise<number> {
  // The endpoint and its key leave the environment first: every tool, command and server inherits what is left.
  const endpoint = takeModelEnv();
  const apiKey = endpoint.key;
  const secrets = takeSandboxSecrets();
  const parkFile = takeParkFile();
  const hide = hidden(apiKey, secrets.secrets);
  const redact = (text: string) => hide.reduce((out, value) => out.split(value).join("[redacted]"), text);
  const say = (line: string) => void io.stderr.write(redact(line.endsWith("\n") ? line : `${line}\n`));

  let flags: ExecFlags;
  try {
    const parsed = parseExecFlags(argv);
    if (parsed === "help") {
      say(USAGE);
      return EXIT.ended;
    }
    flags = parsed;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    say(`agent exec: ${error.message}\n\n${USAGE}`);
    return EXIT.usage;
  }
  // stdout is the events channel: nothing else may reach it.
  if (flags.events === "-") console.log = console.info = console.debug = (...args: Array<unknown>) => console.error(...args);

  const cwd = path.resolve(flags.cwd);
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    say(`agent exec: --cwd ${flags.cwd} is not a directory`);
    return EXIT.usage;
  }
  let shownModel: string | undefined;
  let sink: EventSink;
  // Relative to --cwd, like --task-file and --agent-file.
  const events = flags.events === "-" ? "-" : path.resolve(cwd, flags.events);
  try {
    sink = new EventSink(events, io.stdout, redact, () => shownModel);
  } catch (error) {
    say(`agent exec: --events ${flags.events}: ${(error as Error).message}`);
    return EXIT.usage;
  }
  const state = initialMapperState();
  /** What to undo on the way out, last first: servers, the engine, a temp home. */
  const cleanups: Array<() => unknown> = [];
  try {
    return await execSession({ flags, cwd, endpoint, secrets, parkFile, sink, state, say, redact, cleanups, io, shown: (model) => (shownModel = model) });
  } catch (error) {
    // Nothing leaves this command without its end said, and never with the key in it.
    say(`agent exec: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    const at = now();
    sink.write([sessionError(at, "internal", redact(error instanceof Error ? error.message : String(error))), ...terminated(state, at, "error")]);
    return EXIT.error;
  } finally {
    for (const cleanup of cleanups.reverse()) await Promise.resolve(cleanup()).catch(() => undefined);
    await sink.close();
  }
}

async function execSession(context: {
  readonly flags: ExecFlags;
  readonly cwd: string;
  readonly endpoint: ReturnType<typeof takeModelEnv>;
  readonly secrets: ReturnType<typeof takeSandboxSecrets>;
  readonly parkFile: string | undefined;
  readonly sink: EventSink;
  readonly state: ReturnType<typeof initialMapperState>;
  readonly say: (line: string) => void;
  readonly redact: (text: string) => string;
  readonly cleanups: Array<() => unknown>;
  readonly io: ExecIo;
  readonly shown: (model: string) => void;
}): Promise<number> {
  const { flags, cwd, endpoint, secrets, parkFile, sink, state, say, redact, cleanups, io } = context;
  const apiKey = endpoint.key;
  /** A failure before the session runs: said as a session.error and a terminated status, then the exit. */
  const refuse = (code: string, message: string, exit: number) => {
    say(`agent exec: ${message}`);
    const at = now();
    sink.write([sessionError(at, code, message), ...terminated(state, at, "error")]);
    return exit;
  };

  if (endpoint.error !== undefined) return refuse("usage", endpoint.error, EXIT.usage);
  if (secrets.error !== undefined) return refuse("usage", secrets.error, EXIT.usage);
  if (secrets.file !== undefined && flags.sandboxFile === undefined) {
    return refuse("usage", `${SECRETS_ENV} holds a build's secrets for the commands of the session's computer; it goes with --sandbox-file`, EXIT.usage);
  }
  const baseUrl = endpoint.baseUrl;
  if (baseUrl === undefined || baseUrl.trim() === "") {
    return refuse("usage", "CAVEMAN_MODEL_BASE_URL is not set: the model endpoint (an OpenAI-compatible or Anthropic Messages URL), with its key in CAVEMAN_MODEL_API_KEY_FILE", EXIT.usage);
  }
  const url = parseBaseUrl(baseUrl.trim());
  if (typeof url === "string") return refuse("usage", url, EXIT.usage);
  const family = endpointFamily(url, process.env.CAVEMAN_MODEL_PROVIDER);
  if (typeof family === "object") return refuse("usage", family.error, EXIT.usage);
  const connectorsUrl = endpoint.connectorsUrl === undefined ? undefined : parseConnectorsUrl(endpoint.connectorsUrl);
  if (typeof connectorsUrl === "string") return refuse("usage", connectorsUrl, EXIT.usage);

  const agent = loadAgent(flags, cwd);
  if (typeof agent === "string") return refuse("agent_invalid", agent, EXIT.usage);
  const reserved = Object.keys(agent.mcpServers ?? {}).filter(reservedServerName);
  if (reserved.length > 0) {
    return refuse("agent_invalid", `MCP server ${reserved.join(", ")} has a name agent exec keeps for its own (client, caveman-code, caveman*); rename it in the agent file's mcpServers`, EXIT.usage);
  }

  // Tier linux: the agent's commands and files are the sandbox's, so nothing of the agent's may start here.
  let sandbox: (SandboxFile & { readonly file: string }) | undefined;
  if (flags.sandboxFile !== undefined) {
    const read = readSandboxFile(path.resolve(cwd, flags.sandboxFile));
    if (typeof read === "string") return refuse("usage", read, EXIT.usage);
    if (agent.computer === "none" || agent.computer === "code") {
      return refuse("agent_invalid", `--sandbox-file is a coding agent's computer; this agent says computer: ${agent.computer}`, EXIT.usage);
    }
    const local = Object.entries(agent.mcpServers ?? {}).filter(([, server]) => server.type === "stdio").map(([name]) => name);
    if (local.length > 0) {
      return refuse("agent_invalid", `MCP server ${local.join(", ")} would start a process beside the harness, not on the sandbox; give it a url (a remote server)`, EXIT.usage);
    }
    if (apiKey === "") return refuse("usage", "--sandbox-file reaches the sandbox with the endpoint's key; write it in CAVEMAN_MODEL_API_KEY_FILE", EXIT.usage);
    sandbox = { ...read, file: flags.sandboxFile };
  }

  let task: string;
  try {
    task = (flags.taskFile === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(path.resolve(cwd, flags.taskFile), "utf8")).trim() || "Start.";
  } catch (error) {
    return refuse("usage", `--task-file ${flags.taskFile}: ${(error as Error).message}`, EXIT.usage);
  }

  let resume: ParsedResume | undefined;
  if (flags.resume !== undefined) {
    const read = readResumeFile(path.resolve(cwd, flags.resume));
    if (typeof read === "string") return refuse("usage", read, EXIT.usage);
    resume = read;
  }

  let outputSchema: string | undefined;
  if (flags.outputSchema !== undefined) {
    const read = readOutputSchema(path.resolve(cwd, flags.outputSchema));
    if (typeof read === "object") return refuse("usage", read.error, EXIT.usage);
    outputSchema = read;
  }

  const resolved = resolveExecModel(flags.model ?? agent.model, family);
  if ("error" in resolved) return refuse("model_invalid", resolved.error, EXIT.usage);
  const model = await execModel({ url, apiKey, family, model: resolved.model });
  if ("error" in model) return refuse("model_invalid", model.error, EXIT.usage);
  context.shown(model.shown);
  if (flags.maxCostUsd !== undefined && model.listPrice({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }) === undefined) {
    say(`agent exec: ${model.shown} has no list price, so --max-cost-usd cannot be counted here; the endpoint's own cap is what holds.`);
  }
  const reasoning = model.record === undefined ? undefined : (effortLevel(model.record, agent.effort) ?? defaultEffort(model.record));

  // The agent's connectors, from Cloud's gate: its card read once, now, with the model key as the bearer. A session whose
  // card cannot be read does not start. A call that is not a read leaves only once its tool.started is on the events
  // channel, where Cloud's pool reads that the session sent something that changes the world: the engine says a
  // connector call started before it decides it (execSession beforeCall), an events file's append has returned by
  // then (writeSync), and stdout's write is flushed here.
  let connectors: ConnectorGate | undefined;
  if (connectorsUrl !== undefined) {
    try {
      connectors = await openConnectorGate({
        url: connectorsUrl.href,
        bearer: apiKey,
        notice: (line) => say(`agent exec: ${line}`),
        ...(flags.events === "-" ? { beforeSend: () => new Promise<void>((resolve) => io.stdout.write("", () => resolve())) } : {}),
      });
    } catch (error) {
      return refuse("connectors_unavailable", `the agent's connectors could not be read: ${redact((error as Error).message)}`, EXIT.error);
    }
  }

  // ------------------------------------------------------------ the session

  const sessionId = `exec-${randomUUID()}`;
  let cursor = 0;
  let finished = false;
  let parked: ParkRequest | undefined;
  let limit: { readonly code: "budget_exceeded" | "time_limit"; readonly message: string; readonly exit: number } | undefined;
  let live: ExecSession | undefined;
  let signaled = false;
  /** A turn is running (a limit that stops one says so with its end). */
  let turnRunning = false;
  let stoppedTurn = false;
  /** The caller's messages for the next turn, each with the id its input line gave (its user.message says it). */
  const messages: Array<{ readonly text: string; readonly input?: string }> = [];
  /** Messages steered into the running turn that have not reached the agent yet. */
  const steered: Array<{ readonly text: string; readonly input: string }> = [];
  /** Nobody can answer any more: there was no --input, or stdin ended. */
  let inputEnded = flags.input === undefined;
  /** Wakes the turn loop while it waits for input (a message, stdin's end, a limit, a finish). */
  let wake: () => void = () => undefined;
  const waitForInput = () => new Promise<void>((resolve) => (wake = resolve));
  /** Something ends the session: no turn starts after it, and the running one is stopped. */
  const ending = () => finished || parked !== undefined || limit !== undefined || signaled;

  /** A draft as a Session Protocol event, through the one mapper, out. After a finish nothing more is said. */
  const emit = (draft: Draft) => {
    if (finished) return;
    // A steer reached the transcript: its user.message says which input it was.
    if (draft.type === "message.done" && draft.payload.role === "user" && draft.payload.delivery === "steer") {
      const at = steered.findIndex((steer) => steer.text === draft.payload.text);
      if (at >= 0) expectInput(state, draft.item_id, steered.splice(at, 1)[0]!.input);
    }
    const event: SessionEvent = { session_id: sessionId, cursor: ++cursor, at: now(), ...draft };
    sink.write(mapSessionEvent(state, event, "api"));
    if (event.type === "usage" && flags.maxCostUsd !== undefined && state.usage.cost_usd >= flags.maxCostUsd && limit === undefined) {
      stopFor({ code: "budget_exceeded", message: `the session's cost $${state.usage.cost_usd.toFixed(4)} reached --max-cost-usd $${flags.maxCostUsd}`, exit: EXIT.budget });
    }
  };
  const emitError = (code: string, message: string, input?: string) => {
    if (!finished) sink.write([sessionError(now(), code, message, input)]);
  };

  /** Asks waiting for an answer from stdin. */
  const asks = new Map<string, { readonly payload: AskUser; readonly resolve: (answer: AskAnswer | undefined) => void }>();
  const ask = (prefix: string, payload: AskUser) =>
    new Promise<{ readonly id: string; readonly answer: AskAnswer | undefined }>((resolve) => {
      const id = `${prefix}:${randomUUID()}`;
      asks.set(id, { payload, resolve: (answer) => resolve({ id, answer }) });
      emit({ type: "ask.user", item_id: id, payload });
    });
  /** Every open ask ends unanswered (a Stop, stdin's end, a limit): the agent reads a refusal and goes on, or stops. */
  const cancelAsks = () => {
    for (const [id, open] of asks) {
      asks.delete(id);
      emit({ type: "ask.resolved", item_id: id, payload: { outcome: "cancelled" } });
      open.resolve(undefined);
    }
  };
  const stopFor = (why: NonNullable<typeof limit>) => {
    if (limit !== undefined) return;
    limit = why;
    stoppedTurn = turnRunning;
    // Its stop is the budget's (publicEvents stopReasonOf): budget_reached.
    state.budget = true;
    cancelAsks();
    live?.interrupt();
    wake();
  };
  /** A caller's message: steered into the running turn (said once it lands), else the next turn's. */
  const message = (text: string, input?: string) => {
    if (live?.steer(text) === true) {
      if (input !== undefined) steered.push({ text, input });
      return;
    }
    messages.push({ text, ...(input === undefined ? {} : { input }) });
    wake();
  };

  const customNames = new Set((agent.customTools ?? []).map((tool) => tool.name));
  const callCustomTool = async (name: string, input: unknown): Promise<{ readonly content: string; readonly is_error: boolean }> => {
    if (name === FINISH && customNames.has(FINISH)) {
      // The caller's result: said, and the session ends here (C5).
      emit({ type: "ask.user", item_id: `tool:${randomUUID()}`, payload: { kind: "tool", name, input: input ?? {} } });
      finished = true;
      live?.interrupt();
      wake();
      return { content: "Finished.", is_error: false };
    }
    const description = agent.customTools?.find((tool) => tool.name === name)?.description;
    const payload: AskUser = { kind: "tool", name, ...(description ? { description } : {}), input: input ?? {} };
    if (inputEnded) {
      if (parkFile !== undefined) {
        const askId = `tool:${randomUUID()}`;
        emit({ type: "ask.user", item_id: askId, payload });
        parked = {
          state: "waiting",
          stop_reason: "requires_action",
          waits: [{ kind: "caller_tool", ask_id: askId, reason: `Waiting for caller tool ${name}` }],
        };
        live?.interrupt();
        wake();
        return { content: `Session parked waiting for caller tool ${name}.`, is_error: true };
      }
      return { content: `Nobody can answer ${name} in this session: ${flags.input === undefined ? "it runs without an input channel (agent exec without --input -)" : "its input ended"}.`, is_error: true };
    }
    const { id, answer } = await ask("tool", payload);
    if (answer === undefined) return { content: `Nobody answered ${name} (the turn stopped or the input ended).`, is_error: true };
    // The one answer rule (askAnswers.ts); stdin checked it already.
    const response = responseFor(payload, answer);
    const result = typeof response !== "string" && response.kind === "tool" ? { content: response.content, is_error: response.is_error === true } : { content: String(response), is_error: true };
    emit({ type: "ask.resolved", item_id: id, payload: { outcome: "answered", response: { kind: "tool", content: result.content, is_error: result.is_error } } });
    return result;
  };

  const readonly = agent.computer === "readonly";
  const approve = async (call: ExecApprovalCall) => {
    if (readonly && (call.effect === "write" || call.name === "edit_file" || call.name === "write_file")) return { deny: "readonly_computer" };
    // No app runtime here: a server named like the app's own asks like any other.
    let kind = approvalKindFor(MODES[flags.access], call.effect, { name: call.name, args: call.args }, { appServers: false });
    // A readonly computer: a command, an MCP tool or anything else with an outside effect could write, so it asks.
    if (readonly && kind === null && call.effect === "external") kind = "command";
    if (kind === null) return undefined;
    const payload: AskUser = {
      kind: "approval",
      title: approvalPrompt(call.name, call.args, redact),
      tool_item_id: call.toolCallId,
      options: [
        { id: "accept", label: "Allow", decision: "allow" },
        { id: "decline", label: "Deny", decision: "deny" },
      ],
    };
    // Nobody to ask: park for durable approval when running in Cloud's pool, else refuse (C5).
    if (inputEnded) {
      if (parkFile !== undefined) {
        const askId = `approval:${randomUUID()}`;
        emit({ type: "ask.user", item_id: askId, payload });
        parked = {
          state: "waiting",
          stop_reason: "requires_action",
          waits: [{ kind: "approval", ask_id: askId, reason: payload.title }],
        };
        live?.interrupt();
        wake();
        return { deny: "parked_for_approval" };
      }
      return { deny: readonly ? "readonly_computer" : "no_one_to_ask" };
    }
    const { id, answer } = await ask("approval", payload);
    if (answer === undefined) return { deny: "cancelled" };
    const response = responseFor(payload, answer);
    const allowed = typeof response !== "string" && response.kind === "approval" && response.option_id === "accept";
    emit({ type: "ask.resolved", item_id: id, payload: { outcome: "answered", response: typeof response === "string" ? { kind: "approval", option_id: "decline" } : response } });
    // A note with a denial is steered into the running turn (as headless.ts does with Cloud's mail where the engine takes no note).
    if (!allowed && answer.message?.trim()) message(answer.message.trim());
    return allowed ? undefined : { deny: "declined" };
  };

  // A coding agent's custom tools: the `client` MCP server, declared beside its coding tools as in an app chat.
  const shape = agent.computer === "none" ? "general" : agent.computer === "code" ? "code" : "coding";
  const instructions = outputSchema === undefined || shape === "coding"
    ? agent.instructions
    : `${agent.instructions}${agent.instructions === "" ? "" : "\n\n"}${outputSchemaNote(outputSchema)}`;
  let client: ClientServer | undefined;
  if (shape === "coding" && (agent.customTools?.length ?? 0) > 0) {
    const started = await startClientServer(agent.customTools ?? [], callCustomTool);
    client = started;
    cleanups.push(() => started.close());
  }

  try {
    live = await openExecSession({
      shape,
      workspace: cwd,
      agentId: agent.name,
      instructions,
      ...(resume !== undefined && resume.messages.length > 0 ? { messages: resume.messages } : {}),
      model,
      reasoning,
      customTools: agent.customTools ?? [],
      mcpServers: Object.entries(agent.mcpServers ?? {}).map(([name, server]) =>
        server.type === "stdio"
          ? { name, source: "agent", config: { command: server.command, args: [...server.args], ...(server.env ? { env: { ...server.env } } : {}), ...(server.cwd ? { cwd: server.cwd } : {}) } }
          : { name, source: "agent", config: { url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}) } },
      ),
      ...(client === undefined ? {} : { clientServer: { url: client.url, headers: client.headers } }),
      ...(sandbox === undefined
        ? {}
        : {
            sandbox: {
              controlURL: sandbox.apiURL,
              relayURL: sandbox.relayURL,
              apiKey,
              ...(sandbox.computerId === undefined ? {} : { computerId: sandbox.computerId }),
              idempotencyKey: `session-${sandbox.sessionId}`,
              // The session's repository, cloned from its git URL (the computer's host's git lane) once it runs.
              ...(sandbox.repository === undefined ? {} : { repository: sandbox.repository }),
              // The build's secrets, in each command's environment and nowhere else in the computer.
              ...(secrets.secrets.length === 0 ? {} : { env: Object.fromEntries(secrets.secrets.map(({ name, value }) => [name, value])) }),
              // The build's own files, read when the computer is made: --cwd but agent exec's own inputs and outputs
              // (the secrets file too, were it under --cwd).
              files: () =>
                buildFiles(
                  cwd,
                  new Set([
                    ...[flags.events, flags.taskFile, sandbox.file, ...(flags.resume === undefined ? [] : [flags.resume]), ...(flags.outputSchema === undefined ? [] : [flags.outputSchema])].map((file) =>
                      path.resolve(cwd, file),
                    ),
                    ...(secrets.file === undefined ? [] : [path.resolve(secrets.file)]),
                  ]),
                ),
              // Said as it happens, after a finish too: the computer's release comes at the session's close.
              onEvent: (event) => sink.write([sandboxEvent(now(), event)]),
            },
          }),
      ...(connectors === undefined ? {} : { connectors }),
      resolveValue,
      callCustomTool: (call) => callCustomTool(call.name, call.input),
      approve: (call) => approve(call),
      emit,
      onNotice: (line) => say(`agent exec: ${line}`),
    });
  } catch (error) {
    return refuse("start_failed", `the engine could not start: ${redact((error as Error).message)}`, EXIT.error);
  }
  const session = live;
  // Runs after the servers' cleanups (last first): the engine closes before the client server it calls. The end below
  // closes it before the last status, so what closing says (a sandbox released) comes before terminated.
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= session.close());
  cleanups.push(close);

  // ------------------------------------------------------------ input

  if (flags.input === "-") {
    const lines = readline.createInterface({ input: io.stdin, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (line.trim() === "") return;
      const event = inputEvent(line);
      if (typeof event === "string") return emitError("input_invalid", `stdin: ${event}; the line is skipped`);
      if (event.type === "user.message") return message(event.text, event.input_id);
      if (event.type === "user.interrupt") {
        cancelAsks();
        // A Stop with no turn running stops what was about to start: the messages waiting for the next turn.
        if (turnRunning) session.interrupt();
        else for (const { input } of messages.splice(0)) if (input !== undefined) emitError("message_refused", "A Stop came before this message ran.", input);
        return;
      }
      const open = asks.get(event.ask_id);
      if (open === undefined) return emitError("answer_refused", `ask ${event.ask_id}: no such ask in this session`);
      if (event.type === "user.approval" && open.payload.kind !== "approval") return emitError("answer_refused", `ask ${event.ask_id} is a ${open.payload.kind}, not an approval`);
      if (event.type !== "user.approval" && open.payload.kind !== "tool") return emitError("answer_refused", `ask ${event.ask_id} is an approval; answer it with user.approval`);
      const response = responseFor(open.payload, event.answer);
      if (typeof response === "string") return emitError("answer_refused", `ask ${event.ask_id}: ${response}`);
      asks.delete(event.ask_id);
      open.resolve(event.answer);
    });
    lines.on("close", () => {
      // Nobody is left to answer: what waits on an answer is refused now, not in an hour.
      inputEnded = true;
      cancelAsks();
      wake();
    });
  }

  // ------------------------------------------------------------ limits and signals

  const timer =
    flags.maxSeconds === undefined
      ? undefined
      : setTimeout(() => stopFor({ code: "time_limit", message: `the session ran for its --max-seconds ${flags.maxSeconds}`, exit: EXIT.time }), flags.maxSeconds * 1_000);
  const onSignal = () => {
    signaled = true;
    inputEnded = true;
    cancelAsks();
    session.interrupt();
    wake();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  // ------------------------------------------------------------ turns

  const brief = (text: string) => {
    if (shape !== "coding") return text;
    const base = agentTypePrompt({ ...agent, role: agent.role ?? "general" }, text);
    return outputSchema === undefined ? base : `${base}\n\n${outputSchemaNote(outputSchema)}`;
  };
  const resumeTurnText = (resumed: ParsedResume): string => {
    const parts: Array<string> = [];
    if (resumed.resolvedWaits !== undefined) parts.push(`Resolved waits:\n${JSON.stringify(resumed.resolvedWaits)}`);
    if (resumed.pendingMessages.length > 0) parts.push(...resumed.pendingMessages);
    return parts.length > 0 ? parts.join("\n\n") : task;
  };
  let next: ReadonlyArray<{ readonly text: string; readonly input?: string }> | undefined = [{ text: resume === undefined ? task : resumeTurnText(resume) }];
  let first = resume === undefined || resume.messages.length === 0;
  let lastFailed = false;
  try {
    // Checked right before each turn starts: a finish, a limit or a signal that came while none ran starts none.
    while (next !== undefined && !ending()) {
      // One user.message per message, each saying the input it was; the engine reads them as one.
      for (const { text, input } of next) {
        const item = `user:${cursor + 1}`;
        if (input !== undefined) expectInput(state, item, input);
        emit({ type: "message.done", item_id: item, payload: { role: "user", text } });
      }
      const text = next.map((queued) => queued.text).join("\n\n");
      turnRunning = true;
      const outcome = await session.runTurn(first ? brief(text) : text);
      turnRunning = false;
      first = false;
      // Steers the turn stopped or failed before: they never reached the agent, and no turn will run them.
      for (const { input } of steered.splice(0)) {
        emitError("message_refused", `The turn ${outcome.status === "failed" ? "failed" : "was stopped"} before the agent read this message.`, input);
      }
      if (ending()) break;
      lastFailed = outcome.status === "failed";
      emit({ type: "turn.done", payload: { status: outcome.status, ...(outcome.error === undefined ? {} : { error: outcome.error }) } });
      next = undefined;
      // Steers the turn never took, and messages that came while it ran, start the next turn.
      while (next === undefined && !inputEnded && !ending()) {
        if (messages.length > 0) next = messages.splice(0);
        else await waitForInput();
      }
      if (next === undefined && messages.length > 0 && !ending()) next = messages.splice(0);
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  }

  // ------------------------------------------------------------ the end

  const checkpointMessages = parked !== undefined ? session.harness.messages : [];
  await close();
  const at = now();
  if (finished) {
    sink.write(terminated(state, at, "end_turn"));
    return EXIT.ended;
  }
  if (parked !== undefined && parkFile !== undefined) {
    try {
      writeParkFile(parkFile, parked, sink.seq, checkpointMessages, redact);
    } catch (error) {
      say(`agent exec: could not write park file ${parkFile}: ${(error as Error).message}`);
      sink.write([sessionError(at, "park_failed", `could not write park file: ${(error as Error).message}`), ...terminated(state, at, "error")]);
      return EXIT.error;
    }
    return parked.state === "idle" ? EXIT.idle : EXIT.wait;
  }
  if (limit !== undefined) {
    // The stopped turn says it stopped for the budget (stopReasonOf), then the session ends.
    if (stoppedTurn) emit({ type: "turn.done", payload: { status: "interrupted" } });
    sink.write([sessionError(at, limit.code, limit.message), ...terminated(state, at, "budget_reached")]);
    return limit.exit;
  }
  if (signaled) {
    sink.write(terminated(state, at, "interrupted"));
    return EXIT.error;
  }
  sink.write(terminated(state, at, lastFailed ? "error" : "end_turn"));
  return lastFailed ? EXIT.error : EXIT.ended;
}
