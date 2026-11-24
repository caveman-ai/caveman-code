// What the Caveman engine asks a person before doing, by the thread's access
// mode and the tool's declared effect: the same three modes and cards as
// Claude Agent. ask (approval-required): edits and commands. auto
// (auto-accept-edits): commands and outside tools. full: nothing. Reads
// never ask; the code tool itself never asks, each call it makes does. The
// runtime's own orchestration tools (the caveman-code server: delegate_task,
// thread_wait, ...) never ask either, as Claude Agent pre-approves them,
// except the desktop's `computer`: its clicks and keys act like a command.
// Nor do its web tools (caveman_web: web_search, web_fetch).
import type { ProviderRequestKind, RuntimeMode } from "@caveman-app/protocol";

/** The engine's tool effects (`@caveman-ai/agent` ToolEffect). */
type ToolEffect = "read" | "write" | "idempotent" | "external";

/** The engine's names for the caveman-code server's tools (`mcp__<server>__<tool>`, non-word characters as `_`). */
const RUNTIME_MCP_TOOL_PREFIX = "mcp__caveman_code__";
// Stored engine calls still carry the old server namespace.
const LEGACY_RUNTIME_MCP_TOOL_PREFIX = "mcp__t3_code__";
/** Grill mode's tools only ask the user and record the end, so they never wait on a card (as with Claude Agent). */
const GRILL_MCP_TOOL_PREFIX = "mcp__caveman_grill__";
/** A setup chat's test builds run on a Cloud computer, never here: they never wait on a card. */
const SETUP_MCP_TOOL_PREFIX = "mcp__caveman_setup__";
/**
 * web_search and web_fetch never ask (docs/ "Approvals"): provenance, the secret check and the address
 * rules are what protect the person, and a card per lookup would cost turns.
 */
const WEB_MCP_TOOL_PREFIX = "mcp__caveman_web__";
/** bash actions on a command the person already allowed: reading its output, listing, stopping it. `write` (stdin) still asks. */
const BASH_SESSION_ACTIONS: ReadonlySet<unknown> = new Set(["read", "list", "kill"]);
/** The desktop tool, and its actions that only look. Every other action is input to the desktop: a command. */
const COMPUTER_TOOL = `${RUNTIME_MCP_TOOL_PREFIX}computer`;
const isComputerTool = (name: string | undefined) => name === COMPUTER_TOOL || name === `${LEGACY_RUNTIME_MCP_TOOL_PREFIX}computer`;
const COMPUTER_LOOKS: ReadonlySet<unknown> = new Set(["screenshot", "cursor_position", "wait"]);

// The engine's bash union members are open objects: {action:"read", command} validates as a command
// and runs it. Only a call with no command and no stdin is a session action.
function isBashSessionAction(args: unknown): boolean {
  if (typeof args !== "object" || args === null) return false;
  const a = args as Record<string, unknown>;
  return !("command" in a) && !("input" in a) && BASH_SESSION_ACTIONS.has(a.action);
}

function hasThenRun(args: unknown): boolean {
  const thenRun = typeof args === "object" && args !== null ? (args as { then_run?: unknown }).then_run : undefined;
  return thenRun !== undefined && thenRun !== null;
}

export function approvalKindFor(
  mode: RuntimeMode,
  effect: ToolEffect,
  call?: { readonly name: string; readonly readOnlySandbox?: boolean; readonly args?: unknown },
  /**
   * Whether the app runtime's own servers (caveman-code, grill, setup, web) are the ones those names reach. False where
   * they are not (`agent exec`): there a server of that name is an agent file's, and asks like any other.
   */
  options: { readonly appServers: boolean } = { appServers: true },
): Extract<ProviderRequestKind, "command" | "file-change"> | null {
  if (mode === "full-access") return null;
  const app = options.appServers;
  if (app && isComputerTool(call?.name)) return COMPUTER_LOOKS.has((call?.args as { action?: unknown } | undefined)?.action) ? null : "command";
  if (effect === "read" || effect === "idempotent") return null;
  // An edit or write carrying then_run (actionFusion) also runs a command: it asks as one, in every mode
  // that asks for commands, whatever effect a wrapper reported for it.
  if ((call?.name === "edit_file" || call?.name === "write_file") && hasThenRun(call.args)) return "command";
  if (call?.name === "bash" && isBashSessionAction(call.args)) return null;
  // ponytail: a read-only sandbox keeps the card for every caveman-code tool (Claude Agent allows its
  // read-only ones); the Caveman engine is never given one today.
  if (app && (call?.name.startsWith(RUNTIME_MCP_TOOL_PREFIX) || call?.name.startsWith(LEGACY_RUNTIME_MCP_TOOL_PREFIX)) && call?.readOnlySandbox !== true) return null;
  if (app && (call?.name.startsWith(GRILL_MCP_TOOL_PREFIX) || call?.name.startsWith(SETUP_MCP_TOOL_PREFIX))) return null;
  if (app && call?.name.startsWith(WEB_MCP_TOOL_PREFIX)) return null;
  if (effect === "write") return mode === "approval-required" ? "file-change" : null;
  return "command";
}

/** The card's line: what the tool will do, in a few words. `scrub` runs before the clip, so a cut never splits a secret. */
export function approvalPrompt(name: string, args: unknown, scrub: (text: string) => string = (text) => text): string {
  const field = (key: string) => {
    const value = typeof args === "object" && args !== null ? (args as Record<string, unknown>)[key] : undefined;
    return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
  };
  const clip = (raw: string) => {
    const text = scrub(raw);
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  };
  const command = field("command") ?? field("cmd");
  if (command) return clip(`Run ${command}`);
  const thenRun = typeof args === "object" && args !== null ? (args as { then_run?: { command?: unknown } }).then_run : undefined;
  const fused = typeof thenRun?.command === "string" && thenRun.command.trim() !== "" ? thenRun.command.trim() : undefined;
  if (fused !== undefined) {
    const target = field("path");
    return clip(`${name === "write_file" ? "Write" : "Edit"} ${target ?? "a file"}, then run ${fused}`);
  }
  if (isComputerTool(name)) {
    const at = typeof args === "object" && args !== null ? (args as { coordinate?: unknown }).coordinate : undefined;
    const where = field("text") ?? (Array.isArray(at) ? `at ${at.join(", ")}` : undefined);
    return clip(`Desktop: ${field("action") ?? "act"}${where ? ` ${where}` : ""}`);
  }
  const path = field("path") ?? field("file_path") ?? field("filePath");
  if (path) return clip(`${name === "write_file" || name === "write" ? "Write" : "Edit"} ${path}`);
  return clip(`Use ${name}`);
}

/** How long a card waits for its answer before the engine's call fails closed: an hour. */
export const APPROVAL_WAIT_MS = 60 * 60 * 1000;
