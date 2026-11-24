// `caveman-runtime agent exec`'s flags (platform CONTRACT §8.1, with the Agent SDK's additive --events -,
// --input -, --agent-file and --access). Plain parsing, no CLI framework: the command starts in well under a second.

export const EXIT = { ended: 0, error: 1, usage: 2, budget: 3, time: 4, wait: 5, idle: 6 } as const;

export const ACCESS = ["full", "auto", "ask"] as const;
export type Access = (typeof ACCESS)[number];

export interface ExecFlags {
  readonly cwd: string;
  /** `.caveman/agents/<agent>.md` under cwd, or the file at `agentFile`: exactly one. */
  readonly agent?: string;
  readonly agentFile?: string;
  /** A file, or `-` for stdin (only when stdin is not the input channel). */
  readonly taskFile: string;
  /** A file the events are appended to, or `-` for stdout. */
  readonly events: string;
  /** `-`: user.* events as JSONL on stdin. Absent: nobody answers (approvals are refused). */
  readonly input?: "-";
  readonly model?: string;
  readonly maxSeconds?: number;
  readonly maxCostUsd?: number;
  /** Which calls ask before they run: full (none, the default), auto (commands and outside tools), ask (edits too). */
  readonly access: Access;
  /**
   * A coding agent's tools run on the session's Caveman sandbox (tier linux on the harness pool), not here: the file
   * (JSON) names the session, the Caveman Cloud and the computer to attach, if any (sandboxFile.ts).
   */
  readonly sandboxFile?: string;
  /** Durable resume descriptor (JSON: resume_count, checkpoint, resolved_waits, pending_messages). */
  readonly resume?: string;
  /** Optional JSON Schema file constraining the agent's final response. */
  readonly outputSchema?: string;
}

export const USAGE = `usage: caveman-runtime agent exec --cwd <dir> (--agent <name> | --agent-file <path>) --task-file <file|-> --events <file|->
                                  [--input -] [--model <provider/model|fast|base|frontier|auto>] [--max-seconds <n>]
                                  [--max-cost-usd <x>] [--access full|auto|ask] [--sandbox-file <file>]
                                  [--resume <file>] [--output-schema <file>]

Runs one agent headless in <dir> to its end and writes its public events as JSONL (one {seq, type, created_at, data}
per line). The model endpoint is CAVEMAN_MODEL_BASE_URL (OpenAI-compatible or Anthropic Messages;
CAVEMAN_MODEL_PROVIDER=anthropic|openai|openrouter names the family of a proxy) and its key is read from the file
CAVEMAN_MODEL_API_KEY_FILE names, which is deleted once read. CAVEMAN_MODEL_API_KEY still works, but a key in the
environment stays readable to every process of the same user (ps eww, /proc/<pid>/environ) for the life of this one;
use the file. Neither reaches the agent's tools. CAVEMAN_CONNECTORS_URL, when set, is this session's endpoint at
Cloud's connector gate: its tools join the agent's, read once at start with the model key as the bearer, and the
variable never reaches the agent's tools. --events, --task-file and --agent-file are relative to --cwd.
With --input -, stdin takes user.message, user.interrupt, user.approval, user.answer and user.tool_result events as
JSONL, and the session stays open until stdin ends. --access says which calls ask first (full: none; auto: commands
and outside tools; ask: edits too); an agent with computer: readonly may not edit, and its commands and outside tools
always ask. With nobody to ask (no --input, or stdin ended) an ask is refused.
--sandbox-file runs a coding agent's commands and files on the session's Caveman sandbox instead of here: a JSON file
of session_id, api_url, relay_url, computer_id for the session's computer already made, and repository {owner, name,
base_branch, git_url} for the session's repository. The computer is made at the first tool call that needs one, with the
endpoint's key (nothing in the sandbox holds it); the repository is cloned into it through its host (no credential in
the computer), then the files in --cwd are written. What happens to the computer is said as session.sandbox events.
CAVEMAN_SANDBOX_SECRETS_FILE (with --sandbox-file) names a JSON file of a build's secrets, {"secrets": [{name, value}]},
read and deleted at start: each is in the environment of every command in the computer, never in a file there, and redacted
from every event and stderr line.
Exit: 0 ended, 1 agent or model error, 2 usage, 3 budget, 4 out of time, 5 parked waiting, 6 parked idle.`;

/** A usage problem: exit 2 with this message. */
export class UsageError extends Error {}

const FLAGS = new Set(["cwd", "agent", "agent-file", "task-file", "events", "input", "model", "max-seconds", "max-cost-usd", "access", "sandbox-file", "resume", "output-schema"]);

/** The flags, or a UsageError naming the fix. `help` asks for the usage text. */
export function parseExecFlags(argv: ReadonlyArray<string>): ExecFlags | "help" {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--help" || arg === "-h") return "help";
    if (!arg.startsWith("--")) throw new UsageError(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    const name = arg.slice(2, eq < 0 ? undefined : eq);
    if (!FLAGS.has(name)) throw new UsageError(`unknown flag --${name}`);
    const value = eq < 0 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    if (values.has(name)) throw new UsageError(`--${name} is given twice`);
    values.set(name, value);
  }
  const need = (name: string) => {
    const value = values.get(name);
    if (value === undefined || value.trim() === "") throw new UsageError(`--${name} is required`);
    return value;
  };
  const cwd = need("cwd");
  const agent = values.get("agent");
  const agentFile = values.get("agent-file");
  if ((agent === undefined) === (agentFile === undefined)) throw new UsageError("give exactly one of --agent and --agent-file");
  if (agent !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(agent)) throw new UsageError(`--agent ${JSON.stringify(agent)} is not an agent name (letters, digits, - and _)`);
  const input = values.get("input");
  if (input !== undefined && input !== "-") throw new UsageError("--input takes - (user.* events as JSONL on stdin)");
  const taskFile = need("task-file");
  if (taskFile === "-" && input === "-") throw new UsageError("--task-file - reads stdin, which --input - already takes; put the task in a file");
  const positive = (name: string) => {
    const raw = values.get(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) throw new UsageError(`--${name} must be a positive number, not ${JSON.stringify(raw)}`);
    return value;
  };
  const access = values.get("access") ?? "full";
  if (!(ACCESS as ReadonlyArray<string>).includes(access)) throw new UsageError(`--access is full, auto or ask, not ${JSON.stringify(access)}`);
  const model = values.get("model");
  if (model !== undefined && model.trim() === "") throw new UsageError("--model needs a value");
  const maxSeconds = positive("max-seconds");
  const maxCostUsd = positive("max-cost-usd");
  const sandboxFile = values.get("sandbox-file");
  if (sandboxFile !== undefined && sandboxFile.trim() === "") throw new UsageError("--sandbox-file needs a value");
  const resume = values.get("resume");
  if (resume !== undefined && resume.trim() === "") throw new UsageError("--resume needs a value");
  const outputSchema = values.get("output-schema");
  if (outputSchema !== undefined && outputSchema.trim() === "") throw new UsageError("--output-schema needs a value");
  return {
    cwd,
    ...(agent === undefined ? {} : { agent }),
    ...(agentFile === undefined ? {} : { agentFile }),
    taskFile,
    events: need("events"),
    ...(input === "-" ? { input: "-" as const } : {}),
    ...(model === undefined ? {} : { model: model.trim() }),
    ...(maxSeconds === undefined ? {} : { maxSeconds }),
    ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
    access: access as Access,
    ...(sandboxFile === undefined ? {} : { sandboxFile }),
    ...(resume === undefined ? {} : { resume }),
    ...(outputSchema === undefined ? {} : { outputSchema }),
  };
}
