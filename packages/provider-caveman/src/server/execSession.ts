/**
 * One headless Caveman engine session for `caveman-runtime agent exec`, on the Caveman harness (harness.ts), in the
 * shape the agent file's `computer` asks for:
 *
 * - coding (`computer: readonly | full`): the loadout the model was measured on (`appLoadoutFor`: Claude Code's compact
 *   surface, or Codex's exec surface for a GPT model on a Responses API), its commands and files on this computer in
 *   the workspace (reads and writes stay inside it), or, given `sandbox` (tier linux on Cloud's harness pool), on a
 *   Caveman sandbox through the public sandbox API (the harness's SandboxEnv: made at the first tool call that needs
 *   one, its workspace /workspace, the key the API's bearer alone). The agent's own MCP servers are reached from
 *   programs or exec cells; its custom tools are the `client` MCP server's (runtime agentExec/clientServer.ts),
 *   declared beside the surface's tools, outside a cell's time limit, as an app chat declares them. Its instructions
 *   travel in its first message, so its system text and tools are one per model, wherever it runs.
 * - general (`computer: none`): the general loadout (`appLoadouts().general`): no tool of its own, its instructions the
 *   whole system text, its tools exactly the ones it declares (its custom tools, then its connectors', then its MCP
 *   servers' tools), in a fixed order: one prefix per agent version, wherever it runs.
 *
 * Its connectors are Cloud's connector gate's (connectorGate.ts): the card's tools, read once when the session opens, so
 * the tools the model is told of never change inside it. A general agent declares them in the card's order; a coding
 * agent reaches them where it reaches its own MCP servers, before those. A connector call is told under its flat name
 * (`linear__list_issues`), the name Cloud matches against the deployment's card, and asks by the card's effect.
 *
 * Turns run on one HarnessSession, which keeps the conversation (and, on Anthropic, the cache warm) across turns. What
 * happens is told as Session Protocol event drafts, which the runtime numbers and maps to public events in its one
 * mapper (runtime cloudLink/publicEvents.ts). The asks (custom tool calls, approvals) are the runtime's: this session
 * calls its hooks and runs on with their answers. Unlike the app's adapter (adapter.ts): no orchestration, journal or
 * keychain; one process is one session.
 *
 * @module provider-caveman/server/execSession
 */
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type * as Harness from "@caveman-ai/harness";
import type { ModelThinkingLevel } from "@earendil-works/pi-ai";

import type { ConnectorEffect, ConnectorGate } from "./connectorGate.ts";
import type { ExecModel } from "./execModels.ts";
import {
  callPolicy,
  harnessStopNotice,
  itemCall,
  loadHarness,
  nestedResultText,
  patchFiles,
  patchText,
  WorkspaceEnv,
  type CavemanMcpServerEntry,
  type HarnessEffect,
} from "./harness.ts";

/** The custom tools' server name, as the app's `client` MCP server (runtime mcp/clientToolThreads.ts). */
export const EXEC_CLIENT_SERVER = "client";
/** A custom tool waits for whoever drives the session, who may take hours. */
const CUSTOM_TOOL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
/** How long each of the agent's own MCP servers has to connect before the session starts without it. */
const MCP_CONNECT_MS = 30_000;
const MCP_CLIENT_NAME = "caveman-code";
/** A refused call, as the model and the caller read it (the words the classic engine used, which callers match). */
const DENIED = "cave_tool_denied:";

/**
 * An MCP server name an agent file may not use here: exec's own custom-tool server (`client`), and the app runtime's
 * (`caveman-code`, `caveman*`), whose tools the app treats as its own. Compared as the engine names tools (`mcp__<name>__`).
 */
export const reservedServerName = (name: string): boolean => {
  const engineName = name.replace(/[^A-Za-z0-9_]/g, "_").toLowerCase();
  return engineName === EXEC_CLIENT_SERVER || engineName === "t3_code" /* legacy runtime server */ || engineName.startsWith("caveman");
};

export type ExecShape = "general" | "code" | "coding";
export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "mcp" | "browser" | "other";

/** What the engine did, as Session Protocol event drafts: the runtime stamps session, cursor and time. */
export type ExecDraft =
  | { readonly type: "turn.started"; readonly payload: { readonly engine: "caveman"; readonly model: string; readonly effort?: string } }
  | { readonly type: "message.done"; readonly item_id: string; readonly payload: { readonly role: "user" | "assistant"; readonly text: string; readonly delivery?: "steer" } }
  | { readonly type: "reasoning.delta"; readonly item_id: string; readonly payload: { readonly text: string } }
  | { readonly type: "tool.started"; readonly item_id: string; readonly payload: { readonly name: string; readonly title: string; readonly kind: ToolKind; readonly input: unknown } }
  | { readonly type: "tool.done"; readonly item_id: string; readonly payload: { readonly status: "completed" | "failed" | "declined"; readonly result?: unknown; readonly error?: string } }
  | {
      readonly type: "usage";
      readonly payload: {
        readonly engine: "caveman";
        readonly model: string;
        readonly input_tokens: number;
        readonly output_tokens: number;
        readonly cache_read_tokens: number;
        readonly cache_write_tokens: number;
        readonly cost: { readonly usd: number; readonly basis: "list_price" } | null;
        readonly billing: "api_key";
      };
    };

/** How a turn ended. */
export interface TurnOutcome {
  readonly status: "completed" | "interrupted" | "failed";
  /** The harness's own stop (done, loop_repeat, empty_turns, output_cap, aborted, ...) or its error code. */
  readonly stop?: string;
  readonly error?: string;
}

/** A custom tool as the agent file declares it. */
export interface ExecCustomTool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: Readonly<Record<string, unknown>>;
}

/** A call that may need the caller's approval, under the names approvals know (approvals.ts). */
export interface ExecApprovalCall {
  readonly toolCallId: string;
  /** bash, read_file, edit_file, write_file, `mcp__<server>__<tool>`, a connector's `<connector>__<tool>`, or the tool's own name. */
  readonly name: string;
  readonly effect: HarnessEffect;
  readonly args: unknown;
}

export interface ExecSessionOptions {
  readonly shape: ExecShape;
  /** Where file tools and commands work (coding), or the cwd the harness names and nothing uses (general). */
  readonly workspace: string;
  /**
   * A coding agent's commands and files run on a Caveman sandbox, not here (tier linux): the harness's SandboxEnv, with
   * its own workspace (/workspace) in place of `workspace`. A general agent has no computer and takes none.
   */
  readonly sandbox?: Harness.SandboxEnvOptions | undefined;
  /** The agent's name: its run ids. */
  readonly agentId: string;
  /** A general or code agent's whole system text (its file's body). A coding agent's instructions travel in its first message. */
  readonly instructions: string;
  /** Prior portable harness messages restored from a durable checkpoint (--resume). */
  readonly messages?: ReadonlyArray<unknown> | undefined;
  readonly model: ExecModel;
  readonly reasoning?: ModelThinkingLevel | undefined;
  readonly customTools: ReadonlyArray<ExecCustomTool>;
  /** The agent's own MCP servers. */
  readonly mcpServers: ReadonlyArray<CavemanMcpServerEntry>;
  /** Cloud's connector gate for this session, its card already read (connectorGate.ts openConnectorGate). */
  readonly connectors?: ConnectorGate | undefined;
  /** A coding agent's custom tools are the `client` MCP server's, declared beside the surface's tools: where it listens. */
  readonly clientServer?: { readonly url: string; readonly headers: Readonly<Record<string, string>> } | undefined;
  /** `${VAR}` in the agent's server configs. */
  readonly resolveValue?: ((value: string) => string | Promise<string>) | undefined;
  /** A custom tool call: whoever drives the session answers it. */
  readonly callCustomTool: (call: { readonly name: string; readonly input: unknown; readonly toolCallId: string }) => Promise<{ readonly content: string; readonly is_error: boolean }>;
  /** Whether a tool call may run (the runtime's approvals); custom tools never come here. */
  readonly approve: (call: ExecApprovalCall) => Promise<undefined | { readonly deny: string }>;
  readonly emit: (draft: ExecDraft) => void;
  /** Engine notices (a server that did not connect, a retry, a compaction): diagnostics, never the session's. */
  readonly onNotice?: (line: string) => void;
}

export interface ExecSession {
  /** The harness session: its loadout, declared tools and the conversation so far. */
  readonly harness: Harness.HarnessSession;
  /** The custom tools' names as the model calls them -> their own names. */
  readonly customToolNames: ReadonlyMap<string, string>;
  /** One turn: the engine runs `input` (and any steer that arrived too late for it) to its end. */
  readonly runTurn: (input: string) => Promise<TurnOutcome>;
  /**
   * A message for the running turn; one that arrives after its last model call starts another run of the turn.
   * False when no turn is running (it is the next turn's).
   */
  readonly steer: (text: string) => boolean;
  /**
   * Stop: the running turn ends at its next step. With no turn running the next one starts stopped, so a Stop that
   * races a turn's start is never lost; a host that means "nothing to stop" does not call it while idle.
   */
  readonly interrupt: () => void;
  readonly close: () => Promise<void>;
}

const field = (value: unknown, key: string): unknown => (typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined);
const str = (value: unknown, key: string): string | undefined => {
  const got = field(value, key);
  return typeof got === "string" ? got : undefined;
};
const num = (value: unknown, key: string): number => {
  const got = field(value, key);
  return typeof got === "number" && Number.isFinite(got) ? got : 0;
};
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (field(block, "type") === "text" ? (str(block, "text") ?? "") : "")).join("");
}
const byName = <T extends { readonly name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

const KINDS: Readonly<Record<string, ToolKind>> = {
  bash: "command",
  read_file: "read",
  view_image: "read",
  edit_file: "edit",
  write_file: "edit",
  apply_patch: "edit",
};
const kindOf = (name: string): ToolKind => KINDS[name] ?? (name.startsWith("mcp__") ? "mcp" : "other");

/**
 * A connector tool's effect as approvals read it. A read is a read: it never asks. A write in a connector changes the
 * world outside this computer, so it asks as an outside tool does (approvals' `write` is a workspace edit, which
 * `--access auto` takes without asking).
 */
const approvalEffect = (effect: ConnectorEffect): HarnessEffect => (effect === "read" ? "read" : "external");

/** A harness call as the caller sees it: the names and arguments approvals and items know (harness.ts itemCall). */
function shownCall(name: string, args: unknown, mcp: { readonly server: string; readonly tool: string } | undefined): { readonly name: string; readonly args: unknown } {
  if (name === "apply_patch") return { name, args: { files: patchFiles(patchText(args)).map((file) => file.path), patch: patchText(args) } };
  const shown = itemCall(name, args, mcp);
  return { name: shown.toolName, args: shown.args };
}

const expandHome = (path: string) => (path === "~" ? NodeOS.homedir() : path.startsWith("~/") ? NodePath.join(NodeOS.homedir(), path.slice(2)) : path);

/**
 * An agent's MCP server as the harness connects it, its `${VAR}`s resolved. A stdio server starts in the home
 * directory unless it names its own (never the workspace: a repository could plant what npx or uvx would run there).
 */
async function harnessServer(entry: CavemanMcpServerEntry, resolveValue: ExecSessionOptions["resolveValue"]): Promise<Harness.McpServerConfig> {
  const value = async (text: string) => (resolveValue === undefined || !text.includes("${") ? text : await resolveValue(text));
  const config = entry.config;
  if ("url" in config) {
    const headers: Record<string, string> = {};
    for (const [name, text] of Object.entries(config.headers ?? {})) headers[name] = await value(text);
    return { type: "http", url: await value(config.url), ...(Object.keys(headers).length === 0 ? {} : { headers }) };
  }
  const env: Record<string, string> = {};
  for (const [name, text] of Object.entries(config.env ?? {})) env[name] = await value(text);
  const args: Array<string> = [];
  for (const arg of config.args ?? []) args.push(expandHome(await value(arg)));
  const cwd = config.cwd === undefined ? NodeOS.homedir() : NodePath.resolve(NodeOS.homedir(), expandHome(await value(config.cwd)));
  return { command: expandHome(await value(config.command)), args, cwd, ...(Object.keys(env).length === 0 ? {} : { env }) };
}

/**
 * The agent's own MCP servers, each connected (or left out) within MCP_CONNECT_MS: a server that fails or hangs
 * costs only its own tools. Their tools in a fixed order (by server, then tool), so the prefix does not depend on
 * which server answered first.
 */
async function connectOwnServers(
  h: typeof Harness,
  entries: ReadonlyArray<CavemanMcpServerEntry>,
  resolveValue: ExecSessionOptions["resolveValue"],
  notice: (line: string) => void,
): Promise<{ readonly sessions: ReadonlyArray<Harness.McpSession>; readonly tools: ReadonlyArray<Harness.McpToolHandle> }> {
  const connected = await Promise.all(
    [...entries].sort(byName).map(async (entry): Promise<Harness.McpSession | undefined> => {
      let config: Harness.McpServerConfig;
      try {
        config = await harnessServer(entry, resolveValue);
      } catch (cause) {
        notice(`MCP server ${entry.name}'s config could not be read: ${cause instanceof Error ? cause.message : String(cause)}; its tools are left out.`);
        return undefined;
      }
      const connecting = h.connectMcp({ [entry.name]: config }, { tolerant: true, clientName: MCP_CLIENT_NAME });
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<"late">((resolve) => (timer = setTimeout(() => resolve("late"), MCP_CONNECT_MS)));
      const settled = await Promise.race([connecting, late])
        .catch((cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause))))
        .finally(() => clearTimeout(timer));
      if (settled === "late") {
        void connecting.then((session) => session.close(), () => undefined);
        notice(`MCP server ${entry.name} did not connect within ${MCP_CONNECT_MS / 1_000} s; its tools are left out.`);
        return undefined;
      }
      if (settled instanceof Error) {
        notice(`MCP server ${entry.name} did not connect: ${settled.message}; its tools are left out.`);
        return undefined;
      }
      for (const failed of settled.failed) notice(`MCP server ${failed.server} did not connect: ${failed.error}; its tools are left out.`);
      return settled;
    }),
  );
  const sessions = connected.filter((session) => session !== undefined);
  const tools: Array<Harness.McpToolHandle> = [];
  for (const handle of sessions.flatMap((session) => session.tools)) {
    if (tools.some((other) => other.qualified === handle.qualified)) notice(`MCP tool ${handle.server}/${handle.name} is named like another (${handle.qualified}); it is left out.`);
    else tools.push(handle);
  }
  return { sessions, tools };
}

/** A custom tool of a general agent: declared as its file declares it, answered by whoever drives the session. */
const customTool = (spec: ExecCustomTool, call: ExecSessionOptions["callCustomTool"]): Harness.HarnessTool => ({
  name: spec.name,
  label: spec.name,
  description: spec.description,
  // Plain draft-07 JSON Schema: Pi's validator compiles it as it does TypeBox's.
  parameters: spec.input_schema,
  execute: async (toolCallId: string, params: unknown) => {
    const answer = await call({ name: spec.name, input: params ?? {}, toolCallId });
    if (answer.is_error) throw new Error(answer.content);
    return { content: [{ type: "text" as const, text: answer.content }], details: { truncated: false } };
  },
});

export async function openExecSession(options: ExecSessionOptions): Promise<ExecSession> {
  const reserved = options.mcpServers.find((server) => reservedServerName(server.name));
  if (reserved !== undefined) throw new Error(`MCP server name ${reserved.name} is reserved; rename it`);
  const notice = options.onNotice ?? (() => undefined);
  const h = await loadHarness();
  // `provider/id`; an endpoint's id may hold slashes of its own (`endpoint/anthropic/claude-opus-5`).
  const slash = options.model.model.indexOf("/");
  const model = slash <= 0 ? undefined : (options.model.models.getModel(options.model.model.slice(0, slash), options.model.model.slice(slash + 1)) as Harness.HarnessModel | undefined);
  if (model === undefined) throw new Error(`the Caveman engine has no model ${options.model.model}`);
  const effort = options.reasoning === undefined || options.reasoning === "off" ? undefined : (options.reasoning as Harness.Effort);
  const custom = [...options.customTools].sort(byName);
  /** The name the model calls -> the custom tool's own name. */
  const customToolNames = new Map<string, string>();
  /** Declared MCP tools by the name the model calls: the server and tool approvals and items name. */
  const direct = new Map<string, { readonly server: string; readonly tool: string }>();
  /** The gate's tools this session keeps, by their flat name, and by connector and tool (`<connector>\0<tool>`). */
  const connectorTools = new Map<string, { readonly handle: Harness.McpToolHandle; readonly effect: ConnectorEffect }>();
  const connectorPairs = new Map<string, { readonly handle: Harness.McpToolHandle; readonly effect: ConnectorEffect }>();
  const pair = (server: string, tool: string) => `${server}\u0000${tool}`;
  /** A connector call: one the model makes by its flat name, or a program's or cell's, which names its connector and tool. */
  const connectorCall = (name: string, mcp: { readonly server: string; readonly tool: string } | undefined) =>
    mcp === undefined ? connectorTools.get(name) : connectorPairs.get(pair(mcp.server, mcp.tool));
  const mcpSessions: Array<Harness.McpSession> = [];
  const closeMcp = () => Promise.allSettled(mcpSessions.map((session) => session.close()));

  interface Turn {
    readonly abort: AbortController;
    interrupted: boolean;
    /** Steers said to this turn that have not reached its transcript yet. */
    readonly steers: Array<string>;
    /** Steers the harness has not taken yet: it takes them at its next step. */
    readonly pending: Array<string>;
    /** Calls said started, and said done: a call is said once, whichever of its events comes first. */
    readonly started: Set<string>;
    readonly done: Set<string>;
  }
  let active: Turn | undefined;
  let runs = 0;
  /** A Stop that came while no turn ran: the next turn starts stopped. */
  let pendingInterrupt = false;
  let closed = false;

  const toolStarted = (id: string | undefined, rawName: string, args: unknown, mcp?: { readonly server: string; readonly tool: string }) => {
    const turn = active;
    if (id === undefined || turn === undefined || turn.started.has(id)) return;
    turn.started.add(id);
    const connector = connectorCall(rawName, mcp);
    if (connector !== undefined) {
      const name = connector.handle.qualified;
      options.emit({ type: "tool.started", item_id: id, payload: { name, title: name, kind: "mcp", input: args ?? {} } });
      return;
    }
    const shown = shownCall(rawName, args, mcp ?? direct.get(rawName));
    const name = customToolNames.get(rawName) ?? shown.name;
    options.emit({ type: "tool.started", item_id: id, payload: { name, title: name, kind: kindOf(shown.name), input: shown.args ?? {} } });
  };
  const toolDone = (id: string | undefined, isError: boolean, text: string) => {
    const turn = active;
    if (id === undefined || turn === undefined || turn.done.has(id)) return;
    turn.done.add(id);
    const denied = text.startsWith(DENIED);
    options.emit({
      type: "tool.done",
      item_id: id,
      payload: denied ? { status: "declined", error: text } : isError ? { status: "failed", error: text } : { status: "completed", result: text },
    });
  };

  let session: Harness.HarnessSession;
  try {
    const own = await connectOwnServers(h, options.mcpServers, options.resolveValue, notice);
    mcpSessions.push(...own.sessions);
    const declare = (handles: ReadonlyArray<Harness.McpToolHandle>) => {
      for (const handle of handles) direct.set(handle.qualified, { server: handle.server, tool: handle.name });
      return h.mcpDirectTools(handles, { images: true });
    };
    /** The gate's tools, in the card's order, but one named like a custom tool (called once the custom tools are named). */
    const keepConnectors = (): ReadonlyArray<Harness.McpToolHandle> => {
      const kept: Array<Harness.McpToolHandle> = [];
      for (const handle of options.connectors?.tools ?? []) {
        if (customToolNames.has(handle.qualified)) {
          notice(`Connector tool ${handle.qualified} is named like the custom tool ${customToolNames.get(handle.qualified)}; it is left out.`);
          continue;
        }
        const effect = options.connectors?.effects.get(handle.qualified) ?? "external";
        connectorTools.set(handle.qualified, { handle, effect });
        connectorPairs.set(pair(handle.server, handle.name), { handle, effect });
        kept.push(handle);
      }
      return kept;
    };
    /** The agent's own servers' tools, but one named like a connector tool. */
    const besideConnectors = (handles: ReadonlyArray<Harness.McpToolHandle>) =>
      handles.filter((handle) => {
        const connector = connectorTools.get(handle.qualified) ?? connectorPairs.get(pair(handle.server, handle.name));
        if (connector === undefined) return true;
        notice(`MCP tool ${handle.server}/${handle.name} is named like the connector tool ${connector.handle.qualified}; it is left out.`);
        return false;
      });
    let loadout: Harness.Loadout;
    let env: Harness.ExecEnv;
    let tools: Array<Harness.HarnessTool>;
    /** Reached from programs (Claude's surface) or exec cells (GPT's). */
    let reached: ReadonlyArray<Harness.McpToolHandle> = [];
    if (options.shape === "general" || options.shape === "code") {
      if (options.sandbox !== undefined) {
        throw new Error(`a ${options.shape} agent (computer: ${options.shape === "code" ? "code" : "none"}) has no computer, so it takes no sandbox`);
      }
      // Neither general nor code reaches the host filesystem or shell: the harness only names its cwd.
      env = new h.LocalEnv({ cwd: options.workspace });
      const declared = custom.map((spec) => {
        customToolNames.set(spec.name, spec.name);
        return customTool(spec, options.callCustomTool);
      });
      const connectors = keepConnectors();
      const served = besideConnectors(own.tools).filter((handle) => {
        if (!customToolNames.has(handle.qualified)) return true;
        notice(`MCP tool ${handle.server}/${handle.name} is named like the custom tool ${handle.qualified}; it is left out.`);
        return false;
      });
      if (options.shape === "general") {
        loadout = h.appLoadouts().general;
        tools = [...declared, ...declare(connectors), ...declare(served)];
      } else {
        loadout = h.appLoadouts().code;
        reached = [...connectors, ...served];
        // app-code exposes MCP tools both inside program and directly (mcp.exposure: "both"); register their
        // server/tool metadata so direct calls get the same approvals and events as program calls.
        for (const handle of reached) direct.set(handle.qualified, { server: handle.server, tool: handle.name });
        tools = declared;
      }
    } else {
      const client = options.clientServer !== undefined && custom.length > 0 ? options.clientServer : undefined;
      let clientTools: ReadonlyArray<Harness.McpToolHandle> = [];
      if (client !== undefined) {
        // Ours, on loopback: a session whose custom tools cannot be reached does not start.
        const served = await h.connectMcp(
          { [EXEC_CLIENT_SERVER]: { type: "http", url: client.url, headers: { ...client.headers } } },
          { clientName: MCP_CLIENT_NAME, timeoutMs: CUSTOM_TOOL_TIMEOUT_MS },
        );
        mcpSessions.push(served);
        clientTools = served.tools.filter((handle) => custom.some((spec) => spec.name === handle.name));
        for (const handle of clientTools) customToolNames.set(handle.qualified, handle.name);
      }
      loadout = h.appLoadoutFor(model);
      // Reads and writes stay in the workspace (as the classic engine's file tools did); commands run in it: this
      // computer's, or the sandbox's (made at the first call that needs it, released when the session closes).
      const base = options.sandbox === undefined ? new h.LocalEnv({ cwd: options.workspace }) : new h.SandboxEnv(options.sandbox);
      env = new WorkspaceEnv(base, { root: options.sandbox === undefined ? options.workspace : base.cwd, hidden: null, readAnywhere: false });
      // The custom tools wait on the caller, for hours if need be: declared, outside a cell's time limit.
      tools = declare(clientTools);
      const connectors = keepConnectors();
      reached = [...connectors, ...besideConnectors(own.tools)];
    }

    /**
     * Whether a call runs: the runtime's approvals decide every call but a custom tool's, a program's and a cell's
     * included. A call from a program or cell is said started here, so an approval it asks for names it, and said
     * declined when refused (the harness never starts a refused call, so it ends nowhere else).
     */
    const beforeCall = async (call: Harness.CallInfo): Promise<string | undefined> => {
      if (customToolNames.has(call.name)) return undefined;
      const connector = connectorCall(call.name, call.mcp);
      if (connector !== undefined) {
        // Said started before it is decided, wherever it was made: its start is out before anything is sent.
        toolStarted(call.id, call.name, call.args, call.mcp);
        const answer = await options.approve({ toolCallId: call.id, name: connector.handle.qualified, effect: approvalEffect(connector.effect), args: call.args });
        if (answer === undefined) return undefined;
        const refusal = `${DENIED}${answer.deny}`;
        if (call.parentId !== undefined) toolDone(call.id, true, refusal);
        return refusal;
      }
      const mcp = call.mcp ?? direct.get(call.name);
      const policy = callPolicy({ name: call.name, mcp });
      const shown = itemCall(call.name, call.args, mcp);
      const args = call.name === "apply_patch" ? { path: patchFiles(patchText(call.args))[0]?.path } : shown.args;
      if (call.parentId !== undefined) toolStarted(call.id, call.name, call.args, mcp);
      // The classic names approvals know: a read is read_file, as a write is write_file.
      const name = policy.name === call.name ? shown.toolName : policy.name;
      const answer = await options.approve({ toolCallId: call.id, name, effect: policy.effect, args });
      if (answer === undefined) return undefined;
      const refusal = `${DENIED}${answer.deny}`;
      if (call.parentId !== undefined) toolDone(call.id, true, refusal);
      return refusal;
    };

    session = new h.HarnessSession({
      model,
      stream: (streamModel, context, streamOptions) => options.model.models.streamSimple(streamModel, context, streamOptions),
      effort,
      loadout,
      env,
      mcp: [...reached],
      tools,
      ...(options.shape !== "coding" ? { instructions: options.instructions } : {}),
      ...(options.messages !== undefined && options.messages.length > 0 ? { messages: [...options.messages] as never } : {}),
      hooks: { beforeCall },
    });
  } catch (cause) {
    await closeMcp();
    throw cause;
  }

  /** One harness turn: its events as drafts, its usage said per call and settled against the turn's total. */
  const driveRun = async (runId: string, input: string, turn: Turn): Promise<TurnOutcome> => {
    // A provider's call ids are unique within a run only.
    turn.started.clear();
    turn.done.clear();
    let messageOrdinal = 0;
    /** What this run's usage drafts said so far, so its total only adds what they missed. */
    const said = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const usage = (tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number }) => {
      if (tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite === 0) return;
      said.input += tokens.input;
      said.output += tokens.output;
      said.cacheRead += tokens.cacheRead;
      said.cacheWrite += tokens.cacheWrite;
      const usd = options.model.listPrice(tokens);
      options.emit({
        type: "usage",
        payload: {
          engine: "caveman",
          model: options.model.shown,
          // Fresh input plus cache writes, as the app counts it (adapter.ts Usage.input).
          input_tokens: tokens.input + tokens.cacheWrite,
          output_tokens: tokens.output,
          cache_read_tokens: tokens.cacheRead,
          cache_write_tokens: tokens.cacheWrite,
          cost: usd === undefined ? null : { usd, basis: "list_price" },
          billing: "api_key",
        },
      });
    };
    const handlePi = (event: { readonly type: string; readonly [key: string]: unknown }) => {
      switch (event.type) {
        case "message_start":
          if (str(field(event, "message"), "role") === "assistant") messageOrdinal += 1;
          return;
        case "message_update": {
          const delta = field(event, "assistantMessageEvent");
          if (str(delta, "type") === "thinking_delta") {
            options.emit({ type: "reasoning.delta", item_id: `${runId}:m${messageOrdinal}:r${num(delta, "contentIndex")}`, payload: { text: str(delta, "delta") ?? "" } });
          }
          return;
        }
        case "message_end": {
          const message = field(event, "message");
          const role = str(message, "role");
          if (role === "user") {
            // A steer reached the transcript.
            const text = contentText(field(message, "content"));
            const at = turn.steers.indexOf(text);
            if (at >= 0) {
              turn.steers.splice(at, 1);
              options.emit({ type: "message.done", item_id: `${runId}:steer:${messageOrdinal}:${at}`, payload: { role: "user", text, delivery: "steer" } });
            }
            return;
          }
          if (role !== "assistant") return;
          const content = field(message, "content");
          if (Array.isArray(content)) {
            for (const [index, block] of content.entries()) {
              const blockText = field(block, "type") === "text" ? (str(block, "text") ?? "") : "";
              if (blockText.trim() !== "") options.emit({ type: "message.done", item_id: `${runId}:m${messageOrdinal}:t${index}`, payload: { role: "assistant", text: blockText } });
            }
          }
          const u = field(message, "usage");
          usage({ input: num(u, "input"), output: num(u, "output"), cacheRead: num(u, "cacheRead"), cacheWrite: num(u, "cacheWrite") });
          return;
        }
        case "tool_execution_start":
          return toolStarted(str(event, "toolCallId"), str(event, "toolName") ?? "tool", field(event, "args"));
        case "tool_execution_end": {
          const name = str(event, "toolName") ?? "tool";
          const result = field(event, "result");
          const text = contentText(field(result, "content"));
          // A command's output led by its exit code, as the classic bash wrote it (harness.ts nestedResultText).
          const code = field(field(result, "details"), "exitCode");
          return toolDone(str(event, "toolCallId"), field(event, "isError") === true, name === "bash" && typeof code === "number" ? `exit ${code}\n${text}` : text);
        }
        default:
          return;
      }
    };
    const onEvent = (event: Harness.SessionEvent) => {
      switch (event.type) {
        case "pi":
          return handlePi(event.event);
        case "nested_start":
          return toolStarted(event.call.id, event.call.name, event.call.args, event.call.mcp);
        case "nested_end":
          return toolDone(event.call.id, event.isError, nestedResultText(event.call.name, event.result));
        case "side_usage":
          // A keep-alive ping or a compaction's summary: the session's spend, never an item.
          return usage(event.usage);
        case "compacted":
          return notice(`Context compacted: the conversation so far (about ${event.before} tokens) was summarized so the work can go on.`);
        case "retry":
          return notice(`The model call failed${event.error === undefined ? "" : ` (${event.error})`}; retry ${event.attempt} of ${event.of} in ${Math.round(event.delayMs / 1_000)} s.`);
        default:
          return;
      }
    };

    let outcome: Harness.TurnOutcome;
    try {
      outcome = await session.runTurn(input, { signal: turn.abort.signal, onEvent, steering: () => turn.pending.splice(0) });
    } catch (cause) {
      return turn.interrupted ? { status: "interrupted" } : { status: "failed", error: cause instanceof Error ? cause.message : String(cause) };
    }
    // What the turn's total holds past the calls already said (a request the harness made beside the loop).
    usage({
      input: Math.max(0, outcome.usage.input - said.input),
      output: Math.max(0, outcome.usage.output - said.output),
      cacheRead: Math.max(0, outcome.usage.cacheRead - said.cacheRead),
      cacheWrite: Math.max(0, outcome.usage.cacheWrite - said.cacheWrite),
    });
    if (turn.interrupted || (outcome.status === "stopped" && outcome.stopReason === "aborted")) return { status: "interrupted", stop: outcome.stopReason };
    if (outcome.status === "error") return { status: "failed", stop: outcome.stopReason, error: outcome.error ?? `The Caveman engine stopped: ${outcome.stopReason}.` };
    // The harness's policy ended the turn (a loop, empty answers, an answer past the output limit): it ends, said why.
    if (outcome.status === "stopped") notice(harnessStopNotice(outcome.stopReason));
    return { status: "completed", stop: outcome.stopReason };
  };

  const runTurn = async (input: string): Promise<TurnOutcome> => {
    if (closed) throw new Error("the session is closed");
    if (active !== undefined) throw new Error("a turn is already running");
    const turn: Turn = { abort: new AbortController(), interrupted: pendingInterrupt, steers: [], pending: [], started: new Set(), done: new Set() };
    pendingInterrupt = false;
    if (turn.interrupted) return { status: "interrupted" };
    active = turn;
    options.emit({ type: "turn.started", payload: { engine: "caveman", model: options.model.shown, ...(options.reasoning === undefined ? {} : { effort: options.reasoning }) } });
    let text = input;
    let outcome: TurnOutcome = { status: "completed" };
    try {
      while (true) {
        const runId = `${options.agentId}-${process.pid}-${++runs}`;
        outcome = await driveRun(runId, text, turn);
        if (turn.interrupted || outcome.status !== "completed" || turn.steers.length === 0 || closed) break;
        // Steers that came after the run's last model call: the turn goes on with them.
        const late = turn.steers.splice(0);
        turn.pending.length = 0;
        for (const [index, steer] of late.entries()) options.emit({ type: "message.done", item_id: `${runId}:late:${index}`, payload: { role: "user", text: steer, delivery: "steer" } });
        text = late.join("\n\n");
      }
    } finally {
      active = undefined;
    }
    return turn.interrupted ? { status: "interrupted", ...(outcome.stop === undefined ? {} : { stop: outcome.stop }) } : outcome;
  };

  const stop = (turn: Turn) => {
    turn.interrupted = true;
    turn.steers.length = 0;
    turn.pending.length = 0;
    turn.abort.abort();
  };

  return {
    harness: session,
    customToolNames,
    runTurn,
    steer: (text) => {
      if (active === undefined || active.interrupted) return false;
      active.steers.push(text);
      active.pending.push(text);
      return true;
    },
    interrupt: () => {
      if (active === undefined) pendingInterrupt = true;
      else stop(active);
    },
    close: async () => {
      closed = true;
      if (active !== undefined) stop(active);
      await session.close().catch(() => undefined);
      await closeMcp();
    },
  };
}
