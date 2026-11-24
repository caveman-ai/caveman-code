// Settings > Caveman MCP, as words: each client's install row (one click, or the line to add by hand) and what each
// connected agent's row says, kept apart from the page so tests read them without a browser
// (docs/).
import type { McpClientId, McpClientStatus, OutsideAgent, OutsideAgentLevel, OutsideAgentList } from "@caveman-app/session-protocol";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { ago } from "../../components/project-candidates.ts";

/** The three levels, lowest first, each with its one plain line (spec §4, "Levels, said plainly"). */
export const LEVELS: ReadonlyArray<{ readonly value: OutsideAgentLevel; readonly label: string; readonly line: string; readonly icon: PixelIconName }> = [
  { value: "read", label: "Read", line: "Reads your chats and their changes. Changes nothing.", icon: "tool-read" },
  {
    value: "supervised",
    label: "Supervised",
    line: "Starts and steers its own chats. They can read any file you can and run commands you already allowed; other commands and every edit wait for you.",
    icon: "secret",
  },
  { value: "full", label: "Full access", line: "Lets this agent run commands on this Mac as you.", icon: "unlocked" },
];

export const levelOf = (value: OutsideAgentLevel) => LEVELS.find((l) => l.value === value) ?? LEVELS[1]!;

/** A level is kept per name, so every client that connects under it shares it (spec §2.6). */
export const levelScope = (name: string): string => `Applies to every ${name} on this Mac.`;

/** One argument as a POSIX shell reads it back: bare when it is plain, else in single quotes. */
export function shellQuote(arg: string): string {
  if (arg === "") return "''";
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;
}

export const shellLine = (argv: ReadonlyArray<string>): string => argv.map(shellQuote).join(" ");

export interface ConnectLine {
  readonly id: McpClientId | "any";
  /** Who runs the line: "Claude Code", "Any MCP client". */
  readonly client: string;
  /** What Copy puts on the clipboard, as shown. */
  readonly text: string;
  /** Where it goes, when that isn't a shell: "Add to ~/.codex/config.toml". */
  readonly where?: string;
}

const json = (value: unknown) => JSON.stringify(value);
const GROK_READS_CLAUDE = "Grok Build also reads Claude Code's servers.";
const GROK_BOT_WHERE = "In Grok Bot, under Plugins, choose Add a custom MCP, name it caveman-code and paste this.";
/** The name bot connects as (its connect line passes --name). */
export const GROK_BOT_NAME = "Grok Bot";

/**
 * The line per client that adds Caveman Code by hand, from outside_agent.list's `command` (argv: the launcher's full
 * path and `mcp`), in the install rows' order. Agents with an `mcp add` take a shell line; the others the config
 * entry to add. None while the runtime has not said the command.
 */
export function connectLines(command: ReadonlyArray<string>): ReadonlyArray<ConnectLine> {
  const [bin, ...args] = command;
  if (!bin) return [];
  const add = (cli: string, scope = "") => `${cli} mcp add ${scope}caveman-code -- ${shellLine(command)}`;
  const entry = `{"command": ${json(bin)}, "args": [${args.map(json).join(", ")}]}`;
  return [
    // User scope: every project of the person's sees it, as the one-click install adds it.
    { id: "claude-code", client: "Claude Code", text: add("claude", "--scope user ") },
    // Codex asks before every MCP tool call, and `codex exec` can't ask at all (seen live: "requires approval, but
    // approval policy is never"). The agent's level in Caveman Code is the boundary, so its block approves the tools.
    {
      id: "codex",
      client: "Codex",
      where: "Add to ~/.codex/config.toml. Caveman Code's level for Codex decides what it may do, so Codex doesn't ask before each call.",
      text: [`[mcp_servers.caveman-code]`, `command = ${json(bin)}`, `args = [${args.map(json).join(", ")}]`, `default_tools_approval_mode = "approve"`].join("\n"),
    },
    { id: "cursor", client: "Cursor", where: "Add to ~/.cursor/mcp.json. Cursor and cursor-agent both read it.", text: `{"mcpServers": {"caveman-code": ${entry}}}` },
    {
      id: "vscode",
      client: "VS Code",
      where: "Add to VS Code's mcp.json (MCP: Open User Configuration).",
      text: `{"servers": {"caveman-code": {"type": "stdio", "command": ${json(bin)}, "args": [${args.map(json).join(", ")}]}}}`,
    },
    { id: "grok", client: "Grok Build", where: GROK_READS_CLAUDE, text: add("grok") },
 // bot keeps its servers in the person's account: they paste this in its Add a custom MCP. `--name` so its
 // local exec daemon shows as bot, not as the name it gives itself.
    { id: "grok-bot", client: "Grok Bot", where: GROK_BOT_WHERE, text: `{"command": ${json(bin)}, "args": [${[...args, "--name", "Grok Bot"].map(json).join(", ")}]}` },
    { id: "any", client: "Any MCP client", where: "Goose, OpenCode, anything else: the command and its arguments.", text: entry },
  ];
}

/** What one click does, said before it, and where the server is once it did. */
const INSTALLS: Record<McpClientId, { readonly adds: string; readonly at: string }> = {
  "claude-code": { adds: "Adds caveman-code to your Claude Code user servers.", at: "In your Claude Code user servers." },
  codex: { adds: "Adds caveman-code to ~/.codex/config.toml.", at: "In ~/.codex/config.toml." },
  cursor: { adds: "Adds caveman-code to ~/.cursor/mcp.json, for Cursor and cursor-agent.", at: "In ~/.cursor/mcp.json." },
  vscode: { adds: "Adds caveman-code to VS Code's user MCP servers.", at: "In VS Code's user mcp.json." },
  grok: { adds: `Adds caveman-code to ~/.grok/config.toml. ${GROK_READS_CLAUDE}`, at: "In ~/.grok/config.toml." },
  "grok-bot": {
    adds: "Copies the server and opens Grok Bot: under Plugins, choose Add a custom MCP, name it caveman-code and paste.",
    at: "Grok Bot has connected.",
  },
};

export interface InstallRow {
  readonly id: McpClientId | "any";
  readonly client: string;
  /**
   * ready: here and without it, one click installs. installed: it holds the server, Install again replaces it.
   * manual: not on this Mac, the "any" row, or a runtime that can't install: the line to copy.
   */
  readonly state: "ready" | "installed" | "manual";
  /** The muted line under the name. */
  readonly line: string;
  /** The line to add by hand: shown in a manual row, and under a failed install. */
  readonly manual: ConnectLine;
 /** The button: Install, or for bot (whose servers live in its account) Copy and open. */
  readonly action: string;
 /** Whether the click copies the manual line first (bot: the person pastes it there). */
  readonly copies: boolean;
}

/**
 * One row per client, in the page's order (Claude Code, Codex, Cursor, VS Code, Grok Build, then any MCP client), from
 * outside_agent.list's command and `clients`. A runtime from before outside_agent.install sends no `clients`: every
 * row is its line to copy, as before.
 */
export function installRows(
  command: ReadonlyArray<string>,
  clients: ReadonlyArray<McpClientStatus> | undefined,
  agents: ReadonlyArray<Pick<OutsideAgent, "name">> = [],
): ReadonlyArray<InstallRow> {
  return connectLines(command).map((manual) => {
    const listed = manual.id === "any" ? undefined : clients?.find((c) => c.id === manual.id);
 // bot servers are in its account: it counts as installed once it has connected.
    const known = manual.id === "grok-bot" && listed ? { ...listed, installed: agents.some((a) => a.name === GROK_BOT_NAME) } : listed;
    const grokBot = manual.id === "grok-bot";
    const base = { id: manual.id, client: manual.client, manual, action: grokBot ? "Copy and open" : "Install", copies: grokBot };
    if (manual.id === "any" || clients === undefined) return { ...base, state: "manual", line: manual.where ?? "" };
    if (known?.installed) return { ...base, state: "installed", line: INSTALLS[manual.id].at };
    if (known?.found) return { ...base, state: "ready", line: INSTALLS[manual.id].adds };
    return { ...base, state: "manual", line: manual.id === "grok" ? `Not found on this Mac. ${GROK_READS_CLAUDE}` : "Not found on this Mac." };
  });
}

/** The list with one client as outside_agent.install answered it. */
export function withClient(list: OutsideAgentList, client: McpClientStatus): OutsideAgentList {
  const clients = list.clients ?? [];
  return { ...list, clients: clients.some((c) => c.id === client.id) ? clients.map((c) => (c.id === client.id ? client : c)) : [...clients, client] };
}

/** "Connected now", "Connected now (2)", "Last seen 3h ago"; a disconnected agent says so first. */
export function agentPresence(agent: OutsideAgent, now = Date.now()): string {
  const seen = ago(agent.last_seen_at, now);
  const lastSeen = seen === "now" ? "last seen just now" : /^\d+[mhdw]$/.test(seen) ? `last seen ${seen} ago` : seen ? `last seen ${seen}` : "";
  if (agent.blocked) return lastSeen ? `Disconnected · ${lastSeen}` : "Disconnected";
  if (agent.connected > 0) return agent.connected > 1 ? `Connected now (${agent.connected})` : "Connected now";
  return lastSeen ? lastSeen[0]!.toUpperCase() + lastSeen.slice(1) : "Not connected";
}

/** "3 chats, 1 working", "1 chat", "No chats". */
export function agentChats(agent: OutsideAgent): string {
  if (agent.chats === 0) return "No chats";
  const chats = `${agent.chats} ${agent.chats === 1 ? "chat" : "chats"}`;
  return agent.working > 0 ? `${chats}, ${agent.working} working` : chats;
}

/** The row's one line under the name. */
export const agentLine = (agent: OutsideAgent, now = Date.now()): string => `${agentPresence(agent, now)} · ${agentChats(agent)}`;

/**
 * In the order they first connected, a new one at the end. Nothing live moves a row: after Disconnect, the next
 * agent's Disconnect never slides under the pointer.
 */
export function sortAgents(agents: ReadonlyArray<OutsideAgent>): ReadonlyArray<OutsideAgent> {
  return [...agents].sort((a, b) => Date.parse(a.first_seen_at) - Date.parse(b.first_seen_at) || a.name.localeCompare(b.name));
}

/** The engine whose vendor mark an agent wears, by the name it connects as; null for any other (it gets the MCP glyph). */
export function agentMark(name: string): "claude-agent" | "codex" | "grok" | "cursor" | "opencode" | null {
  const n = name.toLowerCase();
  if (n.startsWith("claude")) return "claude-agent";
  if (n.startsWith("codex")) return "codex";
  if (n.startsWith("grok")) return "grok";
  if (n.startsWith("cursor")) return "cursor";
  if (n.startsWith("opencode")) return "opencode";
  return null;
}

/** The list with one agent as outside_agent.update answered it. */
export function withAgent(list: OutsideAgentList, agent: OutsideAgent): OutsideAgentList {
  const known = list.agents.some((a) => a.name === agent.name);
  return { ...list, agents: known ? list.agents.map((a) => (a.name === agent.name ? agent : a)) : [...list.agents, agent] };
}

/** The list with one agent changed in place, before the runtime answers. */
export function patchAgent(list: OutsideAgentList, name: string, patch: Partial<Pick<OutsideAgent, "level" | "blocked">>): OutsideAgentList {
  return { ...list, agents: list.agents.map((a) => (a.name === name ? { ...a, ...patch, ...(patch.blocked ? { connected: 0 } : {}) } : a)) };
}
