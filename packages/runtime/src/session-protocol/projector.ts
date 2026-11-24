// Session Protocol v1 projection: T3 orchestration events (entity snapshots)
// become v1 session events (deltas with a per-session cursor). Pure: the
// daemon in store.ts runs it inside the transaction that appends the result.
import { CREDITS_LIMIT_CODE, listPriceUsd } from "@caveman-app/provider-caveman/server";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  RuntimeMode,
  ServerProvider,
} from "@caveman-app/protocol";
import type { AccessMode, BuildersResult, EngineFailure, NativeSubagent, Repo, SessionEvent, SubagentRunner, ToolThread, WorkspaceActivity } from "@caveman-app/session-protocol";
import { resolveCavemanMcpToolDefinition } from "@caveman-app/shared/cavemanMcpToolPresentation";
import { compactDynamicToolOutput } from "@caveman-app/shared/toolOutput";

import { createHash } from "node:crypto";

import type { BackgroundState } from "./awaiting.ts";
import { GRILL_MCP_SERVER } from "../grill/grill.ts";
import { secretNameFor } from "../secrets/ProjectSecrets.ts";

import { DateTime } from "effect";
import { RUNTIME_MODE_TO_ACCESS } from "./access.ts";
import { harnessEngineOf } from "./harnesses.ts";
import { effortValueOf } from "../provider/effortOption.ts";
import { speedValueOf } from "../provider/speedOption.ts";

/** The engine's class and code of a failure, without its message (turn.done's and error's `failure`). */
const engineFailureOf = (failure: Extract<OrchestrationV2TurnItem, { type: "error" }>["failure"]): EngineFailure => ({
  class: failure.class,
  ...(failure.code == null ? {} : { code: failure.code }),
});

/** An event before the store gives it a session id and a cursor. */
/** What the sidebar calls the computer the runtime runs on; the id and kind stay "this-mac" on the wire. */
export const THIS_COMPUTER_LABEL = process.platform === "win32" ? "This PC" : process.platform === "darwin" ? "This Mac" : "This computer";
export const THIS_MAC = { id: "this-mac", kind: "this_mac", label: THIS_COMPUTER_LABEL, status: "online" } as const;

export type DraftEvent = Omit<SessionEvent, "session_id" | "cursor"> & {
  readonly type: SessionEvent["type"];
};

/**
 * The effort and speed a turn runs at, under its engine's own option names (provider/effortOption.ts, speedOption.ts),
 * for turn.started.
 */
export const effortOf = (selection: { readonly options?: unknown } | undefined): { effort?: string; speed?: string } => {
  const effort = effortValueOf(selection?.options);
  const speed = speedValueOf(selection?.options);
  return { ...(effort === undefined ? {} : { effort }), ...(speed === undefined ? {} : { speed }) };
};

/** What the projector remembers about one thread between events. */
export interface ThreadState {
  runs: Record<
    string,
    {
      status: string;
 /** upstream run ordinal; absent on runs remembered before it was kept. */
      ordinal?: number;
      started: boolean;
      done: boolean;
      model: string;
      engine: string;
      error?: string;
      /** The engine's own class and code of the turn's latest failure (turn.done's `failure`). */
      failure?: EngineFailure;
      /** The engine's own router's last pick this turn (Caveman engine Auto). */
      routed?: string;
      instance?: string;
      /** Epoch ms: the turn started, and its first streamed text or reasoning. */
      startedAt?: number;
      firstOutputAt?: number;
      /** A usage-limit notice was shown: the engine's own limit text and the failure banner would only repeat it. */
      limitShown?: boolean;
      /** Queued behind a Stop or a restart: it waits for the person (queue.resume or their next message), nothing runs it. */
      held?: boolean;
      /** The runtime woke it (a notification item opened the turn). */
      wake?: boolean;
      /** A message of the person's (or any sender's) joined it: never a wake again. */
      noted?: boolean;
      /** The tools it called, by name, and whether one failed or was declined. */
      tools?: Array<string>;
      toolFailed?: boolean;
    }
  >;
  /** Root node -> run, for provider turns that only name their node. */
  nodes: Record<string, string>;
  /** User messages waiting for their run to start, by run. */
  pendingUser: Record<string, Array<UserMessage>>;
  /** Text length already sent for streaming messages and reasoning, by item. */
  sent: Record<string, number>;
  /**
   * The end of the output a running command last went out with, by item. An engine that keeps only its output's
   * tail (ACP terminals) drops text from the front; this finds where the sent text now ends.
   */
  outputTails?: Record<string, string>;
  /** Items already closed (message.done, tool.done, subagent.done) or opened. */
  opened: Record<string, true>;
  closed: Record<string, true>;
  asks: Record<string, "open" | "resolved">;
  context?: { used: number; window: number; compactAt?: number | undefined };
  usageSeen: Record<string, true>;
  /**
   * Web searches of ended turns that record no usage (their engine never said the tokens), by provider turn: measured
   * all the same, they go with the chat's next usage record from the same engine.
   */
  searchesOwed?: Record<string, { engine: string; count: number }>;
  /** The thread's interaction mode (Session.mode). */
  mode?: "default" | "grill";
  /** The thread's permissions (Session.access). */
  access?: AccessMode;
  /** Grill rounds asked since the session entered grill mode (grill.ts). */
  grillRound?: number;
  /**
 * Native subagents' own threads (upstream provider-native child threads) -> their subagent item in this
   * thread and its turn: the daemon journals a child thread's events under that item (daemon.ts).
   */
  native?: Record<string, { item: string; turn?: string }>;
  /**
   * A digest of what a finished assistant message or subagent last went out with. T3 can still
   * correct one (a native subagent's result replaces the summary it first finished with), and the
   * correction goes out as another message.done / subagent.done for the same item.
   */
  done?: Record<string, string>;
  /**
   * Tool calls still running, by their provider's own id. Claude's permission callback raises an approval under the
   * tool use's id, so the ask names the call it waits on (tool_item_id) and the card can show the command.
   */
  openTools?: Record<string, string>;
  /**
   * A digest of the name and input a running tool last went out with. Claude Agent shows a call as the model
   * begins it, before its input is whole; tool.started goes out again for it once the input arrives.
   */
  shapes?: Record<string, string>;
  /**
 * Approvals whose engine takes a note with a deny (upstream supportsFeedback, Claude Agent's), by request id: the
   * runtime request comes just before its turn item, whose ask.user then says so. Dropped once it is answered.
   */
  feedback?: Record<string, true>;
  /** What background work the thread has, for Workspace.activity.awaiting (awaiting.ts). */
  background?: BackgroundState;
}

/** How much of a command's sent output `ThreadState.outputTails` keeps to find its place again. */
const OUTPUT_TAIL_CHARS = 256;

/**
 * What a command's output snapshot adds to the text already sent for it. Output usually grows in place; an engine
 * that keeps only its tail (ACP terminals, 320 KiB) drops text from the front as it adds more, so the new text
 * starts after the last sent tail. When that tail is gone too, the whole snapshot is new.
 */
function unsentOutput(state: ThreadState, id: string, output: string): string {
  const sent = state.sent[id] ?? 0;
  const tail = state.outputTails?.[id] ?? "";
  let start = sent;
  if (output.length < sent || !output.endsWith(tail, sent)) {
    const at = tail === "" ? -1 : output.lastIndexOf(tail, sent - tail.length);
    start = at === -1 ? 0 : at + tail.length;
  }
  if (start >= output.length) return "";
  state.sent[id] = output.length;
  (state.outputTails ??= {})[id] = output.slice(-OUTPUT_TAIL_CHARS);
  return output.slice(start);
}

export const emptyThreadState = (): ThreadState => ({
  runs: {},
  nodes: {},
  pendingUser: {},
  sent: {},
  opened: {},
  closed: {},
  asks: {},
  usageSeen: {},
});

/** The thread whose agent wrote a user-role message: its workspace when it is one, else just its title. */
/** `agent`: an outside agent (outsideAgents.ts) sent it, and `title` is its name. */
export type Sender = { readonly workspace_id?: string; readonly title: string; readonly agent?: true };
type UserMessage = { id: string; text: string; attachments?: unknown; from?: Sender; delivery?: "steer" | "queue"; scheduled_task?: { task_id: string; title?: string }; generated?: GeneratedMessage };

/** A user-role message the runtime wrote for an agent (a builder's result, its builders' one result): the line a person reads of it. */
export interface GeneratedMessage {
  readonly shown: string;
  readonly builders_result?: BuildersResult;
}

/** How a user message reached the engine, from upstream input intent: steered into a running turn, or a queued turn sent on. */
export const deliveryOf = (intent: string | undefined): "steer" | "queue" | undefined =>
  intent === "steer" || intent === "promoted_queued_to_steer" ? "steer" : intent === "queued_turn" ? "queue" : undefined;

export interface ProjectionContext {
  readonly at: string;
  /** Text the user typed, when the runtime sent the engine more (builder instructions). */
  readonly displayText: (messageId: string) => string | undefined;
  /** Who a sending thread is; undefined when the runtime does not know it. */
  readonly sender?: (threadId: string) => Sender | undefined;
  /** The sending thread of a message the runtime submitted for an agent (mail, an agent's task), which T3 does not carry. */
  readonly sentBy?: (messageId: string) => string | undefined;
  /** A scheduled task's title, by its id; undefined when the task is gone. */
  readonly scheduledTask?: (taskId: string) => string | undefined;
  /** A message the runtime wrote for an agent (caveman_sp_generated): the one line a person reads of it. */
  readonly generated?: (messageId: string) => GeneratedMessage | undefined;
  /** The workspace's repository: an agent's secret request names it. */
  readonly repo?: Repo | undefined;
  /** Who pays for a run on this provider instance: a per-token key or a subscription plan. */
  readonly billing?: (instanceId: string, engine: string) => "api_key" | "plan" | undefined;
  /** A thread one of the runtime's own tools names (ownToolThreadIds), as tool.started and tool.done say it; undefined when unknown. */
  readonly toolThread?: (threadId: string) => ToolThread | undefined;
  /** Who runs a delegate_task child and who chose it, by its thread (its workspace's runner). */
  readonly runner?: (childThreadId: string) => SubagentRunner | undefined;
  /** An attached image's bytes (base64) when small enough to keep in the journal, so a reload still draws it. */
  readonly attachmentData?: (attachment: unknown) => string | undefined;
  /**
   * A Chief's thread only (chief/quiet.ts): replies the person never sees. A reply no longer than `max` is held until
   * it finishes, then dropped when `hides` says so; a longer one streams.
   */
  readonly quietReply?: { readonly max: number; readonly hides: (text: string, turn: { readonly wake: boolean; readonly tools: ReadonlyArray<string>; readonly toolFailed: boolean }) => boolean };
}

/**
 * The daemon's `billing`, from the server settings' provider instances: the Caveman engine pays per token (its turns on a plan say so themselves),
 * Claude Agent's login metadata distinguishes keys from plans; Codex's compact toggle names its plan instance.
 */
export const usageBilling =
  (providerInstances: Readonly<Record<string, { readonly config?: unknown } | undefined>>, providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "auth">> = []) =>
  (instanceId: string, engine: string): "api_key" | "plan" | undefined =>
    engine === "caveman"
      ? "api_key"
      : engine === "claude-agent"
        ? claudeBilling(providers.find((p) => p.instanceId === instanceId)?.auth.type)
        : engine === "codex"
          ? (providerInstances[instanceId]?.config as { chatGptLogin?: unknown } | undefined)?.chatGptLogin === true
            ? "plan"
            : "api_key"
          : undefined;

/** Only a login Claude reports as a key is priced; a plan, or a login it doesn't describe, stays a plan's (no dollars). */
const claudeBilling = (type: string | undefined): "api_key" | "plan" =>
  /^((anthropic)?apikey|bedrock|vertex)$/.test((type ?? "").toLowerCase().replace(/[\s_-]+/g, "")) ? "api_key" : "plan";

const runnerOf = (ctx: ProjectionContext, item: Extract<OrchestrationV2TurnItem, { type: "subagent" }>) => {
  const runner = item.origin === "app_owned" && item.childThreadId !== null ? ctx.runner?.(item.childThreadId) : undefined;
  return runner === undefined ? {} : { runner };
};

export interface ProjectionResult {
  readonly events: ReadonlyArray<DraftEvent>;
  readonly compressionRetrieveStatus?: string;
  /** Engine's own session handle, when it became known. */
  readonly engineSessionRef?: string;
  /** Set when a checkpoint landed, so the daemon recomputes diff.changed. */
  readonly checkpointTurnId?: string;
  /** Set when the thread's interaction mode changed. */
  readonly mode?: "default" | "grill";
  /** Set when the thread's permissions changed. */
  readonly access?: AccessMode;
}

const TERMINAL_RUN = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const ACTIVE_RUN = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const TERMINAL_ITEM = new Set(["completed", "failed", "cancelled", "interrupted"]);

/** Instance ids of the Codex accounts after the first (the default `codex` instance). */
export const CODEX_ACCOUNT_PREFIX = "codex-account-";
/** Instance ids of the Claude logins after the person's own (the default `claudeAgent` instance). */
export const CLAUDE_ACCOUNT_PREFIX = "claudeAgent-account-";
/** engine.list's account id for the person's own claude login (the default instance). */
export const CLAUDE_DEFAULT_ACCOUNT = "claudeAgent:default";

/** T3 provider instance -> Session Protocol engine id. */
export function engineIdForInstance(instanceId: string): string {
  // Further Codex and Claude accounts (engine.account.add) are instances of their driver.
  if (instanceId.startsWith(CODEX_ACCOUNT_PREFIX)) return "codex";
  if (instanceId.startsWith(CLAUDE_ACCOUNT_PREFIX)) return "claude-agent";
  const harness = harnessEngineOf(instanceId);
  if (harness !== undefined) return harness;
  switch (instanceId) {
    case "claudeAgent":
      return "claude-agent";
    case "codex":
      return "codex";
    case "caveman":
      return "caveman";
    default:
      return `acp:${instanceId}`;
  }
}

/**
 * An engine's default model when nobody picked one: from the first of `instances` the provider snapshot
 * lists with models, the engine's active account first. Codex on a compact login is an instance of its
 * own (codex-account-compact); the default `codex` instance, an API key nobody added, lists none.
 */
export function defaultModelSlug(
  providers: ReadonlyArray<{ readonly instanceId: string; readonly models: ReadonlyArray<{ readonly slug: string; readonly isDefault?: boolean | undefined }> }>,
  instances: ReadonlyArray<string>,
): string | undefined {
  for (const instance of instances) {
    const models = providers.find((p) => p.instanceId === instance)?.models ?? [];
    const model = models.find((m) => m.isDefault) ?? models[0];
    if (model) return model.slug;
  }
  return undefined;
}

/** Session Protocol engine id -> T3 provider instance. */
export function instanceForEngine(engine: string): string {
  switch (engine) {
    case "claude-agent":
      return "claudeAgent";
    case "codex":
      return "codex";
    case "caveman":
      return "caveman";
    default:
      return engine.startsWith("acp:") ? engine.slice(4) : engine;
  }
}

/**
 * The engine account (EngineAccount.id, engineAccounts.ts) an instance runs `model` on: a Caveman key is
 * `caveman:<source>` (the model's slot), the person's own claude login and ACP agents their one
 * `<instance>:default`, every other instance (a further Claude login included) itself.
 */
export function accountIdOf(instanceId: string, model: string): string {
  const engine = engineIdForInstance(instanceId);
  if (engine === "caveman") return `caveman:${model.slice(0, Math.max(0, model.indexOf("/")))}`;
  // A further Claude login is its own instance, named by it like a Codex account.
  if (instanceId.startsWith(CLAUDE_ACCOUNT_PREFIX)) return instanceId;
  return engine === "claude-agent" || engine.startsWith("acp:") ? `${instanceId}:default` : instanceId;
}

/** accountIdOf's inverse: the instance and its model id (a Caveman model under its key's slot). */
export function instanceOfAccount(accountId: string, model: string): { readonly instanceId: string; readonly model: string } {
  if (accountId.startsWith("caveman:")) {
    const source = accountId.slice("caveman:".length);
    return { instanceId: "caveman", model: source === "" || model.startsWith(`${source}/`) ? model : `${source}/${model}` };
  }
  return { instanceId: accountId.endsWith(":default") ? accountId.slice(0, -":default".length) : accountId, model };
}

/**
 * The workspace a delegate_task child thread is adopted as (daemon.ts), named from its thread so the
 * parent's subagent.started can point at it before the child's own events arrive.
 */
export function childWorkspaceId(threadId: string): string {
  const hex = createHash("sha256").update(`delegated\0${threadId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A short digest of text the state remembers having sent. */
const digest = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 12);

const KEEP_ITEMS = 2000;
/**
 * The state is rewritten with every event, so it keeps only the newest
 * items (insertion order). ponytail: a late event for an item older than the
 * newest 2000 would be projected again; a per-run index if sessions get that long.
 */
function trim(state: ThreadState) {
  for (const key of ["opened", "closed", "sent", "usageSeen"] as const) {
    const keys = Object.keys(state[key]);
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_ITEMS))) delete state[key][old];
  }
  for (const map of [state.native, state.done, state.searchesOwed]) {
    if (!map) continue;
    const keys = Object.keys(map);
    for (const old of keys.slice(0, Math.max(0, keys.length - KEEP_ITEMS))) delete map[old];
  }
  const runs = Object.keys(state.runs).filter((id) => state.runs[id]!.done);
  for (const old of runs.slice(0, Math.max(0, runs.length - 50))) delete state.runs[old];
}

// ponytail: the CLI's limit frame by its wording ("You've hit your weekly limit · resets …"); a flag from the adapter if it changes.
const LIMIT_TEXT = /^\s*You(?:'|’)ve hit your\b[^\n]*\blimit\b/i;

/**
 * Busy, waiting on a person, failed or idle: what the workspace list shows. Failed while the last turn that
 * ran ended in an error, until the next one starts: the sidebar, the board and "Stopped with an error" read it.
 */
export function threadActivity(state: ThreadState): "working" | "needs_input" | "failed" | "idle" {
  if (Object.values(state.asks).includes("open")) return "needs_input";
  const runs = Object.values(state.runs);
 // A held input waits for the person, as upstream own activity reads it: a chat stopped with inputs queued is not working.
  if (runs.some((run) => ACTIVE_RUN.has(run.status) && !(run.status === "queued" && run.held))) return "working";
  // Runs keep the order they started in (their ids are never integer-like keys).
  return runs.filter((run) => run.done).at(-1)?.status === "failed" ? "failed" : "idle";
}

/** An http(s) address, trimmed; anything else (a query, a file:// or javascript: link) is not one. */
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  if (!/^https?:\/\/\S+$/i.test(url)) return undefined;
  try {
    return new URL(url).host === "" ? undefined : url;
  } catch {
    return undefined;
  }
}

/** The site a page is on, as a read names it: its host, without a leading www. */
const siteOf = (url: string) => new URL(url).host.replace(/^www\./i, "");

/**
 * A web item's sources as the client lists them, `[{ title?, url }]`: Claude's search hits, a page read's
 * `{ url, snippet }`, an ACP search's bare URLs, Codex's `{ type, title, url, domain, snippet }`. Only http(s)
 * addresses, each once; never a page's text (a WebFetch's 8,000-character snippet stays off the wire).
 */
function webSources(results: unknown): Array<{ title?: string; url: string }> {
  if (!Array.isArray(results)) return [];
  const seen = new Set<string>();
  return results.flatMap((result) => {
    const fields = result !== null && typeof result === "object" ? (result as { readonly url?: unknown; readonly title?: unknown }) : {};
    const url = webUrl(fields.url);
    if (url === undefined || seen.has(url)) return [];
    seen.add(url);
    const title = typeof fields.title === "string" ? fields.title.trim() : "";
    return [title === "" ? { url } : { title, url }];
  });
}

type ToolFile = { path: string; old_path?: string; status: "added" | "modified" | "deleted" | "renamed" };

/**
 * A file_change item's files as tool.started names them, when they say more than its title: several files, or one
 * that moved. Operations vary by engine (Codex's add, delete and update; an ACP agent's own words).
 */
export function editFiles(
  changes: ReadonlyArray<{ readonly operation: string; readonly path: string; readonly oldPath?: string | undefined }> | undefined,
): ToolFile[] | undefined {
  if (changes === undefined || changes.length === 0) return undefined;
  const moved = (change: { readonly path: string; readonly oldPath?: string | undefined }) => change.oldPath !== undefined && change.oldPath !== change.path;
  if (changes.length === 1 && !moved(changes[0]!)) return undefined;
  return changes.map((change) => {
    const operation = change.operation.toLowerCase();
    const status = /^(add|added|create|created|new)$/.test(operation)
      ? "added"
      : /^(delete|deleted|remove|removed)$/.test(operation)
        ? "deleted"
        : moved(change) || /^(rename|renamed|move|moved)$/.test(operation)
          ? "renamed"
          : "modified";
    return { path: change.path, ...(moved(change) ? { old_path: change.oldPath! } : {}), status };
  });
}

function toolShape(item: OrchestrationV2TurnItem):
  | { name: string; title: string; kind: "command" | "read" | "edit" | "search" | "web" | "mcp" | "browser" | "other"; input: unknown; files?: ToolFile[] }
  | undefined {
  switch (item.type) {
    case "command_execution":
      return { name: "command", title: item.input, kind: "command", input: { command: item.input } };
    case "file_change": {
 // A patch over several files (Codex), or a move: every file, so the row can name and open each (upstream #22541).
      const files = editFiles(item.changes);
      return { name: "edit", title: item.fileName, kind: "edit", input: { path: item.fileName }, ...(files ? { files } : {}) };
    }
    case "file_search":
      return { name: "search", title: item.pattern ?? item.title ?? "", kind: "search", input: { pattern: item.pattern } };
    case "web_search": {
      // Every engine's page read is a web_search item too (Claude's WebFetch, Codex's openPage and findInPage, an ACP
      // fetch): its address among the patterns makes it a web_fetch, titled by the site it read.
      const page = item.patterns?.map(webUrl).find((url) => url !== undefined);
      if (page !== undefined) return { name: "web_fetch", title: siteOf(page), kind: "web", input: { url: page } };
      return { name: "web_search", title: item.patterns?.[0] ?? item.title ?? "", kind: "web", input: { queries: item.patterns } };
    }
    case "dynamic_tool": {
      const name = item.toolName ?? "tool";
      // Claude's Read, Grep, Glob and LS reach here as dynamic tools: name them, so a line says "Read" and a run "Read 2 files".
      const kind = name.startsWith("mcp__")
        ? "mcp"
        : /^(read|notebookread)$/i.test(name)
          ? "read"
          : /^(grep|glob|ls)$/i.test(name)
            ? "search"
            : /browser/i.test(name)
              ? "browser"
              : "other";
      return { name, title: item.title ?? name, kind, input: item.input };
    }
    default:
      return undefined;
  }
}

/**
 * The grill tools show as their round (ask.user) and grill.finished, never as
 * tool rows: Claude's `mcp__caveman-grill__*` and the ToolSearch that loads
 * them, Codex's `caveman-grill.*`.
 */
function isGrillTool(name: string, input: unknown): boolean {
  const claude = `mcp__${GRILL_MCP_SERVER}__`;
  // The Caveman engine's names: non-word characters become `_`.
  const caveman = `mcp__${GRILL_MCP_SERVER.replace(/\W/g, "_")}__`;
  if (name.startsWith(claude) || name.startsWith(caveman) || name.startsWith(`${GRILL_MCP_SERVER}.`)) return true;
  const query = (input as { query?: unknown } | null)?.query;
  return name === "ToolSearch" && typeof query === "string" && query.includes(claude);
}

function toolResult(item: OrchestrationV2TurnItem): unknown {
  switch (item.type) {
    case "file_change":
      return item.additions === undefined && item.deletions === undefined
        ? undefined
        : { additions: item.additions ?? 0, deletions: item.deletions ?? 0 };
    case "command_execution":
      return item.exitCode === undefined ? undefined : { exit_code: item.exitCode };
    case "file_search":
      return item.results;
    case "web_search": {
      const sources = webSources(item.results);
      return sources.length === 0 ? undefined : sources;
    }
    case "dynamic_tool":
      return item.output;
    default:
      return undefined;
  }
}

/**
 * The threads one of the runtime's own tools on other threads names (thread_send, thread_read, thread_launch, …): in
 * its input (its target), and once it completed, in its result (the threads thread_launch and create_threads made).
 */
export function ownToolThreadIds(item: OrchestrationV2TurnItem): { readonly input: ReadonlyArray<string>; readonly result: ReadonlyArray<string> } | undefined {
  if (item.type !== "dynamic_tool" || resolveCavemanMcpToolDefinition(item.toolName)?.named === undefined) return undefined;
  const target = (item.input as { readonly threadId?: unknown } | null | undefined)?.threadId;
  const output = item.status === "completed" ? compactDynamicToolOutput(item.output) : undefined;
  const made = output === undefined ? [] : [output.threadId, output.thread?.threadId, ...(output.threads ?? []).map((t) => t.threadId)];
  return {
    input: typeof target === "string" && target !== "" ? [target] : [],
    result: [...new Set(made.filter((id): id is string => id !== undefined))],
  };
}

/** tool.started's or tool.done's `threads`: those of `ids` the runtime knows. */
const toolThreads = (ctx: ProjectionContext, ids: ReadonlyArray<string> | undefined): { threads?: ToolThread[] } => {
  const threads = (ids ?? []).flatMap((id) => ctx.toolThread?.(id) ?? []);
  return threads.length === 0 ? {} : { threads };
};

/** Projects one T3 domain event. Mutates `state`; returns the v1 events. */
export function projectEvent(
  state: ThreadState,
  event: OrchestrationV2DomainEvent,
  ctx: ProjectionContext,
): ProjectionResult {
  const out: Array<DraftEvent> = [];
  const at = ctx.at;
  const push = (type: string, payload: unknown, ids: { turn_id?: string | null | undefined; item_id?: string | undefined; parent_item_id?: string | null | undefined } = {}) =>
    out.push({
      at,
      type,
      payload,
      ...(ids.turn_id ? { turn_id: ids.turn_id } : {}),
      ...(ids.item_id ? { item_id: ids.item_id } : {}),
      ...(ids.parent_item_id ? { parent_item_id: ids.parent_item_id } : {}),
    } as DraftEvent);
  /** A Chief's reply still short enough to be one the person never sees: none of it goes out until it finishes. */
  const holding = (id: string, text: string) => ctx.quietReply !== undefined && (state.sent[id] ?? 0) === 0 && text.trim().length <= ctx.quietReply.max;
  /** A Chief's finished reply the person never sees (chief/quiet.ts): on its first finish and on any correction. */
  const quiet = (runId: string | null | undefined, text: string) => {
    if (ctx.quietReply === undefined) return false;
    const run = runId ? state.runs[runId] : undefined;
    return ctx.quietReply.hides(text, { wake: run?.wake === true && run.noted !== true, tools: run?.tools ?? [], toolFailed: run?.toolFailed === true });
  };
  const firstOutput = (runId: string | null | undefined) => {
    const known = runId ? state.runs[runId] : undefined;
    if (known && known.firstOutputAt === undefined) known.firstOutputAt = Date.parse(at);
  };
  const emitUser = (runId: string, message: UserMessage) => {
    if (state.closed[message.id]) return;
    state.closed[message.id] = true;
    // A note steered into a wake's turn: what the Chief writes now may answer it.
    if (state.runs[runId]) state.runs[runId]!.noted = true;
    push(
      "message.done",
      {
        role: "user",
        text: ctx.displayText(message.id) ?? message.text,
        ...(Array.isArray(message.attachments) && message.attachments.length > 0
          ? { attachments: message.attachments.map((attachment) => projectAttachment(attachment, ctx.attachmentData)) }
          : {}),
        ...(message.from ? { from: message.from } : {}),
        ...(message.delivery ? { delivery: message.delivery } : {}),
        ...(message.scheduled_task ? { scheduled_task: message.scheduled_task } : {}),
        ...(message.generated ? { generated: { shown: message.generated.shown }, ...(message.generated.builders_result ? { builders_result: message.generated.builders_result } : {}) } : {}),
      },
      { turn_id: runId, item_id: message.id },
    );
  };

  switch (event.type) {
    case "run.created":
    case "run.updated": {
      const run: OrchestrationV2Run = event.payload;
      const before = state.runs[run.id]?.status;
      const known = (state.runs[run.id] ??= {
        status: run.status,
        started: false,
        done: false,
        model: run.modelSelection.model,
        engine: engineIdForInstance(run.providerInstanceId),
      });
      known.instance = run.providerInstanceId;
      known.status = run.status;
      known.ordinal = run.ordinal;
      if (run.queueHeld === true) known.held = true;
      else delete known.held;
      known.model = run.modelSelection.model;
      if (run.rootNodeId) state.nodes[run.rootNodeId] = run.id;
      // A run that failed before its engine ever ran (a session that would not open, a fork the engine refused)
      // still shows: the person's message, then the turn's end with its reason. Without this the message
      // vanished and turn.submit's "started" turn never ended. One cancelled before it started was never sent.
      const failedBeforeStart = run.status === "failed" && !known.started;
      // So does one a stop or a restart ended before its engine ran (a stop right behind a send; a kill -9 the
      // restart's recovery settles): the person's message stays, and its turn ends interrupted (CHAOS-4). One taken
      // out of the queue before it started (queue.remove, never sent) still shows nothing.
      const stoppedBeforeStart =
        !known.started && (run.status === "interrupted" || run.status === "cancelled") && before !== "queued" && (state.pendingUser[run.id]?.length ?? 0) > 0;
      if ((run.status === "running" || run.status === "waiting" || failedBeforeStart || stoppedBeforeStart) && !known.started) {
        known.started = true;
        known.startedAt = Date.parse(at);
        push(
          "turn.started",
          // The login it runs on, where the engine's accounts are its instances (the Caveman engine's are keys).
          { engine: known.engine, model: known.model, ...effortOf(run.modelSelection), mode: state.mode ?? "default", ...(state.access ? { access: state.access } : {}), ...(known.instance && known.engine !== "caveman" && !known.engine.startsWith("acp:") ? { account_id: accountIdOf(known.instance, known.model ?? "") } : {}) },
          { turn_id: run.id },
        );
        for (const message of state.pendingUser[run.id] ?? []) emitUser(run.id, message);
        delete state.pendingUser[run.id];
      }
      if (TERMINAL_RUN.has(run.status) && known.started && !known.done) {
        known.done = true;
        // A grill round still open when its turn ends is never answered (grill.ts).
        for (const [askId, status] of Object.entries(state.asks)) {
          if (status !== "open" || !askId.startsWith("grill:")) continue;
          state.asks[askId] = "resolved";
          push("ask.resolved", { outcome: "cancelled" }, { turn_id: run.id, item_id: askId });
        }
        const status = run.status === "completed" ? "completed" : run.status === "failed" ? "failed" : "interrupted";
        push(
          "turn.done",
          {
            status,
            ...(status === "failed" && known.error && !known.limitShown ? { error: known.error } : {}),
            ...(status === "failed" && known.failure ? { failure: known.failure } : {}),
          },
          { turn_id: run.id },
        );
        // Nothing of a finished run is referenced again; keep the state small.
        for (const node of Object.keys(state.nodes)) if (state.nodes[node] === run.id) delete state.nodes[node];
        trim(state);
      }
      if (TERMINAL_RUN.has(run.status) && !known.started) delete state.pendingUser[run.id];
      break;
    }
    case "node.updated": {
      if (event.payload.runId && event.payload.kind === "root_turn") state.nodes[event.payload.id] = event.payload.runId;
      break;
    }
    case "message.updated": {
      const message = event.payload;
 // An automatic delivery (a delegated task's result, a background wake) is upstream notification item, never the
      // person's bubble: closing it here keeps a user_message item for it from being emitted. Peer and scheduled messages show.
      const automatic = message.delegatedCompletion !== undefined || message.notification !== undefined;
      if (message.role === "user" && automatic && message.senderThreadId === undefined && message.scheduledTaskId === undefined) state.closed[message.id] = true;
      if (message.role !== "assistant") break;
      const turnId = message.runId;
      if (state.closed[message.id]) {
        // A finished message T3 corrected: the same item again, with the text it has now.
        const known = state.done?.[message.id];
        if (!message.streaming && known !== undefined && known !== digest(message.text)) {
          state.done![message.id] = digest(message.text);
          // A correction that is still a no-op stays unseen; one with something to say shows.
          if (quiet(turnId, message.text)) break;
          push("message.done", { role: "assistant", text: message.text }, { turn_id: turnId, item_id: message.id });
        }
        break;
      }
      // The CLI's own "You've hit your … limit" frame after a limit notice says the same thing a second time.
      if (turnId && state.runs[turnId]?.limitShown && LIMIT_TEXT.test(message.text)) {
        state.closed[message.id] = true;
        break;
      }
      const sent = state.sent[message.id] ?? 0;
      if (message.streaming) {
        if (holding(message.id, message.text)) break;
        if (message.text.length > sent) {
          push("message.delta", { text: message.text.slice(sent) }, { turn_id: turnId, item_id: message.id });
          firstOutput(turnId);
          state.sent[message.id] = message.text.length;
        }
      } else {
        state.closed[message.id] = true;
        (state.done ??= {})[message.id] = digest(message.text);
        delete state.sent[message.id];
        // A Chief's no-op line ("Nothing new to act on."), none of it sent: the person sees nothing.
        if (sent === 0 && quiet(turnId, message.text)) break;
        push("message.done", { role: "assistant", text: message.text }, { turn_id: turnId, item_id: message.id });
        firstOutput(turnId);
      }
      break;
    }
    case "turn-item.updated": {
      const item = event.payload;
      const turnId = item.runId;
      const parent = item.parentItemId;
      if (item.type === "user_message") {
        // The display text and sender are only looked up with this event, so a message that waits for its run keeps them.
        const senderThreadId = item.senderThreadId ?? ctx.sentBy?.(item.messageId);
        const from = senderThreadId === undefined ? undefined : ctx.sender?.(senderThreadId);
        const delivery = deliveryOf(item.inputIntent);
 // A scheduled task's prompt: which task sent it (upstream #22638), its title looked up with this event too.
        const title = item.scheduledTaskId === undefined ? undefined : ctx.scheduledTask?.(item.scheduledTaskId);
        const scheduled = item.scheduledTaskId === undefined ? undefined : { task_id: item.scheduledTaskId, ...(title ? { title } : {}) };
        const generated = ctx.generated?.(item.messageId);
        const message: UserMessage = { id: item.messageId, text: ctx.displayText(item.messageId) ?? item.text, attachments: item.attachments, ...(from ? { from } : {}), ...(delivery ? { delivery } : {}), ...(scheduled ? { scheduled_task: scheduled } : {}), ...(generated ? { generated } : {}) };
        if (turnId && state.runs[turnId]?.started) emitUser(turnId, message);
        else if (turnId) (state.pendingUser[turnId] ??= []).some((m) => m.id === message.id) || state.pendingUser[turnId]!.push(message);
        break;
      }
      if (item.type === "assistant_message") {
 // Codex streams an answer only on its turn item (upstream clients read streaming text there) and sends the
        // message once, finished. Its text streams as message.delta under the message's id, sharing what was sent
        // with message.updated, so an engine that streams on both sends each piece once; message.done still closes it.
        const id = item.messageId;
        if (!item.streaming || state.closed[id]) break;
        if (turnId && state.runs[turnId]?.limitShown && LIMIT_TEXT.test(item.text)) break;
        if (holding(id, item.text)) break;
        const sent = state.sent[id] ?? 0;
        if (item.text.length > sent) {
          push("message.delta", { text: item.text.slice(sent) }, { turn_id: turnId, item_id: id });
          firstOutput(turnId);
          state.sent[id] = item.text.length;
        }
        break;
      }
      if (item.type === "reasoning") {
        // A thought's line shows from the start of its block, before its text: the engine began thinking.
        if (state.sent[item.id] === undefined && item.streaming && item.text.length === 0) {
          push("reasoning.delta", { text: "" }, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
          state.sent[item.id] = 0;
        }
        const sent = state.sent[item.id] ?? 0;
        if (item.text.length > sent) {
          push("reasoning.delta", { text: item.text.slice(sent) }, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
          firstOutput(turnId);
          state.sent[item.id] = item.text.length;
        }
        if (!item.streaming) delete state.sent[item.id];
        break;
      }
      if (item.type === "error") {
        const failure = engineFailureOf(item.failure);
        if (turnId && state.runs[turnId]) {
          state.runs[turnId]!.error = item.failure.message;
          state.runs[turnId]!.failure = failure;
        }
        // A Caveman plan or credits limit (Caveman credits on the Caveman engine): one notice that says until when and
        // leads to the plan, not a failure banner too.
        if (item.status === "failed" && item.failure.class === "usage_limit" && item.failure.code === CREDITS_LIMIT_CODE && !state.opened[item.id]) {
          state.opened[item.id] = true;
          if (turnId && state.runs[turnId]) state.runs[turnId]!.limitShown = true;
          const resetsAt = item.failure.resetAt ?? undefined;
          push("engine.status", { engine: "caveman", rate_limit: { limited: true, ...(resetsAt ? { resets_at: resetsAt } : {}) }, message: item.failure.message }, { turn_id: turnId });
        }
        // One item per provider turn: each burst of retries reuses it from attempt 1 with a new startedAt.
        // One line per burst (its own item id), one event per attempt.
        const burst = item.startedAt === null ? item.id : `${item.id}@${DateTime.toEpochMillis(item.startedAt)}`;
        if (item.retry !== undefined && item.status === "running" && (state.sent[burst] ?? 0) < item.retry.attempt) {
          state.sent[burst] = item.retry.attempt;
          const { attempt, maxAttempts, retryDelayMs } = item.retry;
          push(
            "error",
            {
              reason: "engine_unavailable",
              message: item.failure.message,
              retry: { attempt, ...(maxAttempts === null ? {} : { max_attempts: maxAttempts }), ...(retryDelayMs === null ? {} : { delay_ms: retryDelayMs }) },
              failure,
            },
            { turn_id: turnId, item_id: burst },
          );
        }
        break;
      }
      if (item.type === "compaction") {
        if (!state.opened[item.id]) {
          state.opened[item.id] = true;
          if (!TERMINAL_ITEM.has(item.status)) push("compaction.started", {}, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
        }
        if (TERMINAL_ITEM.has(item.status) && !state.closed[item.id]) {
          state.closed[item.id] = true;
          push(
            "compaction.done",
            {
              status: item.status === "completed" ? "completed" : "failed",
              ...(item.beforeTokenCount === undefined ? {} : { before_tokens: item.beforeTokenCount }),
              ...(item.afterTokenCount === undefined ? {} : { after_tokens: item.afterTokenCount }),
            },
            { turn_id: turnId, item_id: item.id, parent_item_id: parent },
          );
        }
        break;
      }
      if (item.type === "system_notice" && item.compressionRetrieveStatus !== undefined) {
        if (state.opened[item.id]) break;
        state.opened[item.id] = true;
        return { events: out, compressionRetrieveStatus: item.compressionRetrieveStatus };
      }
      if (item.type === "system_notice" && item.routedModel !== undefined) {
        if (state.opened[item.id]) break;
        state.opened[item.id] = true;
        // The usage event names the model the turn's calls last ran on. ponytail: one model per turn's usage; per-call usage if Auto mixes models in one turn often.
        if (turnId && state.runs[turnId]) state.runs[turnId]!.routed = item.routedModel;
        push("model.routed", { model: item.routedModel }, { turn_id: turnId });
        break;
      }
      if (item.type === "notification" || item.type === "system_notice") {
        if (state.opened[item.id]) break;
        state.opened[item.id] = true;
        if (item.type === "notification" && turnId && state.runs[turnId]) state.runs[turnId]!.wake = true;
        if (item.type === "system_notice" && turnId && state.runs[turnId] && /usage limit reached/i.test(item.message)) state.runs[turnId]!.limitShown = true;
        // An ACP session notice keeps its title and its description apart (message is "title\n\ndescription").
        const noticeBody =
          item.type === "system_notice" && item.title && item.message.startsWith(`${item.title}\n\n`)
            ? item.message.slice(item.title.length + 2)
            : undefined;
        push(
          "notification",
          item.type === "notification"
            ? { level: item.outcome === "failed" ? "warning" : "info", title: item.summary, ...(item.detail ? { body: item.detail } : {}) }
            : noticeBody
              ? { level: "info", title: item.title!, body: noticeBody }
              : { level: "info", title: item.message },
          { turn_id: turnId, item_id: item.id },
        );
        break;
      }
      if (item.type === "approval_request" || item.type === "user_input_request") {
        const askId = item.requestId;
        if (state.asks[askId]) break;
        state.asks[askId] = "open";
        const native = item.nativeItemRef?.nativeId;
        const waitsOn = parent ?? (native ? state.openTools?.[native] : undefined);
        push(
          "ask.user",
          item.type === "approval_request"
            ? {
                kind: "approval",
                title: item.title ?? item.prompt ?? `Allow ${item.requestKind}?`,
                ...(item.prompt ? { detail: item.prompt } : {}),
                ...(waitsOn ? { tool_item_id: waitsOn } : {}),
                // Full access and it asked anyway: why, in the engine's words and as a cause the client explains.
                ...(item.reason ? { reason: item.reason } : {}),
                ...(item.fullAccessOverride
                  ? { full_access_override: item.fullAccessOverride === "ask_rule" ? ("ask_rule" as const) : ("engine_check" as const) }
                  : {}),
 // A deny can carry the person's note to the call that asked (upstream #23657).
                ...(state.feedback?.[askId] ? { accepts_feedback: true } : {}),
                options: (item.options && item.options.length > 0
                  ? item.options
                  : [
                      { decision: "accept", label: "Allow" },
                      { decision: "decline", label: "Deny" },
                    ]
                ).map((option) => ({
                  id: option.decision,
                  label: option.label,
                  decision: option.decision.startsWith("accept") ? "allow" : "deny",
                })),
              }
            : {
                kind: "question",
                questions: item.questions.map((question) => ({
                  id: question.id,
                  header: question.header,
                  prompt: question.question,
                  options: question.options.map((option) => ({
                    id: option.value ?? option.label,
                    label: option.label,
                    description: option.description,
 // What the option looks like, to compare them by (Claude's AskUserQuestion previews, upstream #21932).
                    ...(option.preview?.trim() ? { preview: option.preview } : {}),
                  })),
                  multi_select: question.multiSelect ?? false,
                  allow_text: question.allowCustomAnswer ?? true,
                })),
              },
          { turn_id: turnId, item_id: askId, parent_item_id: parent },
        );
        break;
      }
      if (item.type === "secret_request") {
 // upstream request_secret: a card the client answers by storing the value (secret.set), never in the session.
        if (item.secretStatus === "pending" && !state.asks[item.id] && ctx.repo !== undefined) {
          state.asks[item.id] = "open";
          push(
            "ask.user",
            { kind: "secret", repo: ctx.repo, name: secretNameFor(item.label), reason: item.reason },
            { turn_id: turnId, item_id: item.id, parent_item_id: parent },
          );
        } else if (item.secretStatus !== "pending" && state.asks[item.id] === "open") {
          state.asks[item.id] = "resolved";
          push(
            "ask.resolved",
            item.secretStatus === "cancelled" ? { outcome: "cancelled" } : { outcome: "answered", response: { kind: "secret", provided: item.secretStatus === "saved" } },
            { turn_id: turnId, item_id: item.id },
          );
        }
        break;
      }
      if (item.type === "subagent") {
        if (item.origin === "provider_native" && item.childThreadId !== null && state.native?.[item.childThreadId] === undefined) {
          (state.native ??= {})[item.childThreadId] = { item: item.id, ...(turnId ? { turn: turnId } : {}) };
        }
        if (!state.opened[item.id]) {
          state.opened[item.id] = true;
          push(
            "subagent.started",
            {
              title: item.title ?? item.prompt.slice(0, 120),
              agent: engineIdForInstance(item.providerInstanceId),
              ...(item.origin === "app_owned" && item.childThreadId !== null ? { workspace_id: childWorkspaceId(item.childThreadId) } : {}),
              // The delegate_task call that started it returned this as its taskId: its card takes that row's place.
              ...(item.origin === "app_owned" ? { task_id: item.subagentId } : {}),
              ...runnerOf(ctx, item),
            },
            { turn_id: turnId, item_id: item.id, parent_item_id: parent },
          );
        }
        // Its first end, or T3 correcting it (a native subagent's summary becomes its full result).
        const status = item.status === "completed" ? "completed" : item.status === "failed" ? "failed" : "interrupted";
        const ended = digest(`${status}\0${item.result ?? ""}`);
        if (TERMINAL_ITEM.has(item.status) && (!state.closed[item.id] || (state.done?.[item.id] !== undefined && state.done[item.id] !== ended))) {
          state.closed[item.id] = true;
          (state.done ??= {})[item.id] = ended;
          push("subagent.done", { status, ...(item.result ? { summary: item.result } : {}) }, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
        }
        break;
      }
      const shaped = toolShape(item);
      if (shaped === undefined) break;
      const named = ownToolThreadIds(item);
      const tool = { ...shaped, ...toolThreads(ctx, named?.input) };
      const grill = isGrillTool(tool.name, tool.input);
      if (!state.opened[item.id]) {
        // The grill tools draw as their round, never as a row.
        if (grill) break;
        // Claude starts a ToolSearch before its query, which says whether it loads the grill tools: the row
        // waits for it, or for the item's end. Codex starts a web search before it knows the query, or that it
        // reads a page: the row waits for them likewise (a search line without its query reads as nothing).
        const query = (tool.input as { query?: unknown } | null)?.query;
        if (tool.name === "ToolSearch" && typeof query !== "string" && !TERMINAL_ITEM.has(item.status)) break;
        if (item.type === "web_search" && (item.patterns ?? []).length === 0 && !TERMINAL_ITEM.has(item.status)) break;
      }
      const shape = digest(`${tool.name}\0${JSON.stringify(tool.input) ?? ""}${tool.files ? `\0${JSON.stringify(tool.files)}` : ""}${tool.threads ? `\0${JSON.stringify(tool.threads)}` : ""}`);
      if (!state.opened[item.id]) {
        state.opened[item.id] = true;
        push("tool.started", tool, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
        if (turnId && state.runs[turnId]) (state.runs[turnId]!.tools ??= []).push(tool.name);
        const native = item.nativeItemRef?.nativeId;
        if (native && !TERMINAL_ITEM.has(item.status)) (state.openTools ??= {})[native] = item.id;
        if (!TERMINAL_ITEM.has(item.status)) (state.shapes ??= {})[item.id] = shape;
      } else if (!grill && !state.closed[item.id] && state.shapes?.[item.id] !== undefined && state.shapes[item.id] !== shape) {
        // Its line went out as the model began the call; now its input is whole: the command or file it names.
        // (A row already out that turns out to load the grill tools keeps its line and still ends below.)
        state.shapes[item.id] = shape;
        push("tool.started", tool, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
      }
      if (item.type === "command_execution" && item.output !== undefined) {
        const text = unsentOutput(state, item.id, item.output);
        if (text !== "") push("tool.output", { text }, { turn_id: turnId, item_id: item.id, parent_item_id: parent });
      }
      if (TERMINAL_ITEM.has(item.status) && !state.closed[item.id]) {
        state.closed[item.id] = true;
        delete state.sent[item.id];
        delete state.outputTails?.[item.id];
        delete state.shapes?.[item.id];
        const native = item.nativeItemRef?.nativeId;
        if (native && state.openTools?.[native] === item.id) delete state.openTools[native];
        const failed = item.status === "failed" || (item.type === "command_execution" && item.outputIndicatesFailure === true);
        if (turnId && state.runs[turnId] && (failed || item.status !== "completed")) state.runs[turnId]!.toolFailed = true;
        const result = toolResult(item);
        // A failed code cell or MCP call says why (WireProjection keeps its error, bounded).
        const error = failed && item.type === "dynamic_tool" ? (item.output as { readonly error?: unknown } | undefined)?.error : undefined;
        push(
          "tool.done",
          {
            status: item.status === "cancelled" || item.status === "interrupted" ? "declined" : failed ? "failed" : "completed",
            ...(result === undefined ? {} : { result }),
            ...(typeof error === "string" && error !== "" ? { error } : {}),
            ...toolThreads(ctx, named?.result),
          },
          { turn_id: turnId, item_id: item.id, parent_item_id: parent },
        );
      }
      break;
    }
    case "runtime-request.updated": {
      const request = event.payload;
      const capability = request.responseCapability;
      if (request.status === "pending" && capability.type === "live" && capability.supportsFeedback === true && !state.asks[request.id]) {
        (state.feedback ??= {})[request.id] = true;
      } else if (request.status !== "pending" && state.feedback?.[request.id]) delete state.feedback[request.id];
      if (request.status === "pending" || state.asks[request.id] !== "open") break;
      state.asks[request.id] = "resolved";
      const outcome = request.status === "resolved" ? "answered" : request.status === "expired" ? "expired" : "cancelled";
      const response =
        request.decision !== undefined
          ? { kind: "approval", option_id: request.decision }
          : request.answers !== undefined
            ? {
                kind: "question",
                answers: Object.entries(request.answers).map(([questionId, value]) => ({
                  question_id: questionId,
                  option_ids: Array.isArray(value) ? value.map(String) : [],
                  ...(typeof value === "string" ? { text: value } : {}),
                })),
              }
            : undefined;
      push(
        "ask.resolved",
        { outcome, ...(outcome === "answered" && response ? { response } : {}) },
        { turn_id: state.nodes[request.nodeId], item_id: request.id },
      );
      break;
    }
    case "plan.updated": {
      const plan = event.payload;
      // Todos only: no plan mode (README.md), so a proposed plan has no producer.
      if (plan.kind !== "todo_list") break;
      push(
        "plan.updated",
        {
          kind: "todos",
          steps: plan.steps.map((step) => ({
            text: step.text,
            status: step.status === "running" ? "in_progress" : step.status,
          })),
          ...(plan.explanation ? { markdown: plan.explanation } : {}),
        },
        { turn_id: plan.runId, item_id: plan.id },
      );
      break;
    }
    case "checkpoint.captured": {
      const checkpoint = event.payload;
      if (checkpoint.runId === null || checkpoint.status !== "ready") break;
      // What the turn itself wrote (T3 left out what a pull or rebase in it brought): its Changes card.
      const files = checkpoint.files.map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions }));
 // A huge turn's list is a prefix on the wire (upstream #27110); its totals cover every file.
      const total = checkpoint.filesTotal;
      push(
        "checkpoint.created",
        { checkpoint_id: checkpoint.id, ref: checkpoint.ref, files, ...(total ? { files_total: { count: total.count, additions: total.additions, deletions: total.deletions } } : {}) },
        { turn_id: checkpoint.runId },
      );
      return { events: out, checkpointTurnId: checkpoint.runId };
    }
    case "provider-turn.updated": {
      const turn = event.payload;
      const runId = state.nodes[turn.nodeId];
      const usage = turn.tokenUsage;
      if (usage && usage.maxTokens) {
        const next = { used: usage.usedTokens, window: usage.maxTokens, compactAt: usage.autoCompactThreshold };
        if (state.context?.used !== next.used || state.context?.window !== next.window || state.context?.compactAt !== next.compactAt) {
          state.context = next;
          push(
            "context.updated",
            { used_tokens: next.used, window_tokens: next.window, ...(next.compactAt === undefined ? {} : { compact_at_tokens: next.compactAt }) },
            { turn_id: runId },
          );
        }
      }
      const total = turn.turnTokenUsage;
      // A turn still going carries its total so far (Muse updates it after every call): the turn's is the one it ends with.
      const ended = turn.status !== "pending" && turn.status !== "running";
      // `unavailable`, or a count left out: the engine never said what the turn spent (a Claude Agent turn stopped
      // mid-way); its counts are absent, not zero, so it is no measurement to record. Its web searches were measured all
      // the same, and the engine counts its next turn's from after them: they wait for the next record (searchesOwed).
      const inputTokens = total?.usageStatus === "unavailable" ? undefined : total?.inputTokens;
      const outputTokens = total?.usageStatus === "unavailable" ? undefined : total?.outputTokens;
      const known = runId ? state.runs[runId] : undefined;
      const engine = known?.engine ?? "";
      if (total?.webSearches && ended && (inputTokens === undefined || outputTokens === undefined) && !state.usageSeen[turn.id]) {
        (state.searchesOwed ??= {})[turn.id] = { engine, count: total.webSearches };
      }
      if (total && ended && inputTokens !== undefined && outputTokens !== undefined && !state.usageSeen[turn.id]) {
        state.usageSeen[turn.id] = true;
        // This turn's own total counts its searches; another engine's are never this one's.
        delete state.searchesOwed?.[turn.id];
        const owed = Object.entries(state.searchesOwed ?? {}).filter(([, searches]) => searches.engine === engine);
        for (const [id] of owed) delete state.searchesOwed![id];
        const webSearches = owed.reduce((sum, [, searches]) => sum + searches.count, total.webSearches ?? 0);
        const cacheRead = total.cachedInputTokens ?? 0;
        const cacheWrite = total.cacheCreationTokens ?? 0;
        // T3 counts cache reads and writes inside input; v1 reports them apart.
        const input = Math.max(0, inputTokens - cacheRead - cacheWrite);
        const model = total.model ?? known?.routed ?? known?.model ?? "unknown";
        // The engine's own word wins (a Caveman turn on the person's plan), else the instance's.
        const billing = total.billing ?? (known ? ctx.billing?.(known.instance ?? "", known.engine) : undefined);
        // An engine that priced every call (Caveman) wins; else a per-token key at the catalog's public price; a plan stays null.
        const listed =
          total.listPriceUsd !== undefined
            ? total.listPriceUsd
            : billing === "api_key"
              // Turn totals lack per-request input sizes, so list pricing cannot apply context tiers.
              ? listPriceUsd(model.includes("/") ? model : known?.engine === "codex" ? `openai/${model}` : model.startsWith("claude-") ? `anthropic/${model}` : model, { input, output: outputTokens, cacheRead, cacheWrite, cacheWrite1h: total.cacheCreation1hTokens ?? 0 })
              : undefined;
        const now = Date.parse(at);
        push(
          "usage",
          {
            ...(known ? { engine: known.engine } : {}),
            model,
            input_tokens: input,
            output_tokens: outputTokens,
            cache_read_tokens: cacheRead,
            cache_write_tokens: cacheWrite,
            ...(webSearches > 0 ? { web_searches: webSearches } : {}),
            cost: listed === undefined ? null : { usd: listed, basis: "list_price" },
            ...(billing ? { billing } : {}),
            ...(known?.startedAt !== undefined && known.firstOutputAt !== undefined ? { ttft_ms: Math.max(0, known.firstOutputAt - known.startedAt) } : {}),
            ...(known?.startedAt !== undefined && now >= known.startedAt ? { duration_ms: now - known.startedAt } : {}),
          },
          { turn_id: runId },
        );
      }
      break;
    }
    case "provider-thread.updated": {
      const native = event.payload.nativeThreadRef;
      if (native?.strength === "strong" && native.nativeId) return { events: out, engineSessionRef: native.nativeId };
      break;
    }
    default: {
      // Every thread.* event carries the thread; its interactionMode is the session's mode, its runtimeMode the access.
      if (!event.type.startsWith("thread.")) break;
      const thread = event.payload as { interactionMode?: unknown; runtimeMode?: unknown };
      const mode = thread.interactionMode;
      const access = typeof thread.runtimeMode === "string" ? RUNTIME_MODE_TO_ACCESS[thread.runtimeMode as RuntimeMode] : undefined;
      const modeChanged = (mode === "default" || mode === "grill") && mode !== (state.mode ?? "default");
      const accessChanged = access !== undefined && access !== state.access;
      if (modeChanged) {
        if (mode === "grill") state.grillRound = 0;
        state.mode = mode;
      }
      if (accessChanged) state.access = access;
      if (modeChanged || accessChanged) return { events: out, ...(modeChanged ? { mode } : {}), ...(accessChanged ? { access } : {}) };
      break;
    }
  }
  return { events: out };
}

/** What of a native subagent's own thread shows inside its row: its steps, text and asks, never turn or session state. */
const NESTED: ReadonlySet<string> = new Set([
  "message.delta",
  "message.done",
  "reasoning.delta",
  "tool.started",
  "tool.output",
  "tool.done",
  "subagent.started",
  "subagent.done",
  "ask.user",
  "ask.resolved",
  "compaction.started",
  "compaction.done",
  "notification",
]);

/**
 * A native subagent's own thread's events, journaled in the chat that started it: each under the
 * subagent's item (`parent_item_id`, so clients file them in its row) and in the turn that started it.
 * Its prompt (a user message) stays out: the row's title says what it was asked.
 */
export function nestUnder(events: ReadonlyArray<DraftEvent>, host: { readonly item: string; readonly turn?: string | undefined }): Array<DraftEvent> {
  return events.flatMap((event) => {
    if (!NESTED.has(event.type)) return [];
    if (event.type === "message.done" && (event.payload as { role?: unknown }).role === "user") return [];
    const { turn_id: _turn, parent_item_id: _parent, ...rest } = event;
    return [{ ...rest, ...(host.turn ? { turn_id: host.turn } : {}), parent_item_id: host.item } as DraftEvent];
  });
}

/** How many native subagents a workspace lists (Workspace.subagents): the latest. */
export const NATIVE_SUBAGENTS_KEPT = 20;

/**
 * A chat's native subagents (Workspace.subagents) after its newly journaled events: one per
 * subagent.started that names no workspace (a delegated agent is a workspace of its own), its status
 * and end from subagent.done. The same array when nothing changed.
 */
export function foldNativeSubagents(list: ReadonlyArray<NativeSubagent> | undefined, events: ReadonlyArray<DraftEvent>): ReadonlyArray<NativeSubagent> | undefined {
  let next: Array<NativeSubagent> | undefined;
  const current = () => (next ??= [...(list ?? [])]);
  for (const event of events) {
    if (!event.item_id) continue;
    if (event.type === "subagent.started") {
      const p = event.payload as { title: string; agent?: string; workspace_id?: string };
      if (p.workspace_id !== undefined || current().some((s) => s.item_id === event.item_id)) continue;
      current().push({
        item_id: event.item_id,
        ...(event.parent_item_id ? { parent_item_id: event.parent_item_id } : {}),
        title: p.title,
        ...(p.agent ? { agent: p.agent } : {}),
        status: "working",
        started_at: event.at,
      });
    } else if (event.type === "subagent.done") {
      const at = current().findIndex((s) => s.item_id === event.item_id);
      if (at < 0) continue;
      const status = (event.payload as { status: NativeSubagent["status"] }).status;
      if (next![at]!.status !== status) next![at] = { ...next![at]!, status, ended_at: event.at };
    }
  }
  if (next === undefined) return list;
  const kept = next.length > NATIVE_SUBAGENTS_KEPT ? next.slice(-NATIVE_SUBAGENTS_KEPT) : next;
  return JSON.stringify(kept) === JSON.stringify(list ?? []) ? list : kept;
}

/** An ask still waiting on the person (WorkspaceInternal.openAsks), as Workspace.activity shows it. */
export type OpenAsk = NonNullable<WorkspaceActivity["ask"]> & { readonly item_id: string };

/** How many open asks a workspace remembers: the latest, so asks an engine never resolved cannot pile up. */
const OPEN_ASKS_KEPT = 20;

/** One line of an ask for a row: its first line, at most 140 characters. */
const askLine = (text: string) => {
  const line = text.trim().split("\n", 1)[0]!.trim();
  return line.length > 140 ? `${line.slice(0, 139).trimEnd()}…` : line;
};

/** What a row shows of an ask.user: an approval's title, a round's first question, or the secret it needs and why. */
function askOf(payload: unknown): NonNullable<WorkspaceActivity["ask"]> | undefined {
  const p = payload as { kind?: unknown; title?: string; questions?: ReadonlyArray<{ prompt: string }>; name?: string; reason?: string };
  if (p.kind === "approval") return { kind: "approval", prompt: askLine(p.title ?? "") };
  if (p.kind === "question") return { kind: "question", prompt: askLine(p.questions?.[0]?.prompt ?? "") };
  if (p.kind === "secret") return { kind: "secret", prompt: askLine(p.reason ? `${p.name}: ${p.reason}` : (p.name ?? "")) };
  if (p.kind === "tool") return { kind: "tool", prompt: askLine(p.name ?? "") };
  return undefined;
}

/**
 * The asks still open after a chat's newly journaled events, oldest first: each ask.user opens one and its
 * ask.resolved (answered, cancelled or expired) closes it. Asks inside a native subagent count: the chat
 * still waits on the person. The same array when nothing changed.
 */
export function foldOpenAsks(open: ReadonlyArray<OpenAsk> | undefined, events: ReadonlyArray<DraftEvent>): ReadonlyArray<OpenAsk> | undefined {
  let next: ReadonlyArray<OpenAsk> | undefined;
  for (const event of events) {
    const list = next ?? open ?? [];
    if (!event.item_id) continue;
    if (event.type === "ask.user") {
      const ask = askOf(event.payload);
      if (ask === undefined || list.some((a) => a.item_id === event.item_id)) continue;
      next = [...list, { item_id: event.item_id, ...ask }].slice(-OPEN_ASKS_KEPT);
    } else if (event.type === "ask.resolved" && list.some((a) => a.item_id === event.item_id)) {
      next = list.filter((a) => a.item_id !== event.item_id);
    }
  }
  if (next === undefined) return open;
  return next.length === 0 ? undefined : next;
}

/** Longest Workspace.activity.last_reply, as Cloud's chat preview (cloudChats.ts PREVIEW_MAX). */
const REPLY_MAX = 280;

/**
 * An answer as the line under a sidebar row's title (Workspace.activity.last_reply): its markdown marks dropped (code
 * fences, headings, emphasis, list bullets, quotes; a link reads as its words), on one line, at most REPLY_MAX
 * characters with an ellipsis where it was cut. Empty when nothing readable is left.
 */
export function replyLine(markdown: string): string {
  const plain = markdown
    // A fence's own line goes with its language; a fence on a line with code keeps the code.
    .replace(/^[ \t]*`{3,}[^\n`]*$/gm, " ")
    .replace(/`{3,}/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, "")
    // Not underscores: snake_case names would lose theirs.
    .replace(/(\*\*|\*|~~|`)(?=\S)([^]*?\S)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return plain.length <= REPLY_MAX ? plain : `${plain.slice(0, REPLY_MAX - 1).trimEnd()}…`;
}

/**
 * What a chat's latest turn is at (Workspace.activity) after its newly journaled events, so a sidebar shows
 * its status without attaching its session. `open` is the asks still open after them (foldOpenAsks): the
 * latest is `ask`. Turns, todos and grill.finished count only from the chat's own events, never from inside
 * a native subagent (`parent_item_id`). `awaiting` is no event's: it stays as the daemon set it (withAwaiting).
 * The same object when nothing changed, so the workspace is not rewritten or published for nothing; undefined
 * when there is nothing to say.
 */
export function foldActivity(prev: WorkspaceActivity | undefined, events: ReadonlyArray<DraftEvent>, open: ReadonlyArray<OpenAsk> | undefined): WorkspaceActivity | undefined {
  const before: WorkspaceActivity = prev ?? {};
  const { awaiting } = before;
  let { turn_started_at, last_outcome, turn_ended_at, todos, ready_to_build, last_reply } = before;
  for (const event of events) {
    if (event.parent_item_id !== undefined) continue;
    if (event.type === "turn.started") {
      turn_started_at = event.at;
      // A turn under way has not ended; one that fails without its turn.done is dated by updated_at instead.
      turn_ended_at = undefined;
      // The person's next turn after grill mode finished is the build (or what they chose instead).
      ready_to_build = undefined;
    } else if (event.type === "turn.done") {
      turn_started_at = undefined;
      last_outcome = (event.payload as { status: NonNullable<WorkspaceActivity["last_outcome"]> }).status;
      turn_ended_at = event.at;
    } else if (event.type === "plan.updated") {
      const p = event.payload as { kind: string; steps: ReadonlyArray<{ status: string }> };
      if (p.kind !== "todos") continue;
      todos = p.steps.length === 0 ? undefined : { done: p.steps.filter((s) => s.status === "completed").length, total: p.steps.length };
    } else if (event.type === "grill.finished") {
      ready_to_build = true;
    } else if (event.type === "message.done") {
      const p = event.payload as { role: string; text: string };
      const line = p.role === "assistant" ? replyLine(p.text) : "";
      if (line) last_reply = line;
    }
  }
  const latest = open?.at(-1);
  // Always built in this key order, so comparing it with what the last fold made is a string compare.
  const next: WorkspaceActivity = {
    ...(latest ? { ask: { kind: latest.kind, prompt: latest.prompt } } : {}),
    ...(turn_started_at !== undefined ? { turn_started_at } : {}),
    ...(last_outcome !== undefined ? { last_outcome } : {}),
    ...(turn_ended_at !== undefined ? { turn_ended_at } : {}),
    ...(awaiting ? { awaiting } : {}),
    ...(todos !== undefined ? { todos } : {}),
    ...(ready_to_build ? { ready_to_build } : {}),
    ...(last_reply ? { last_reply } : {}),
  };
  if (Object.keys(next).length === 0) return undefined;
  return JSON.stringify(next) === JSON.stringify(prev) ? prev : next;
}

/** A stored attachment as message.done carries it; `attachmentData` is a small image's bytes (inlineAttachmentData). */
export function projectAttachment(value: unknown, attachmentData: ProjectionContext["attachmentData"]) {
  const record = (value ?? {}) as Record<string, unknown>;
  const image = record.type === "image";
  // Files and large images stay in the attachment store only; a large image names its id for attachment.read.
  const data = (image ? attachmentData?.(value) : undefined) ?? "";
  return {
    type: image ? "image" : "file",
    name: String(record.name ?? "attachment"),
    mime_type: String(record.mimeType ?? "application/octet-stream"),
    data,
    ...(image && data === "" && typeof record.id === "string" ? { id: record.id } : {}),
  } as const;
}
