import type { McpClientStatus, OutsideAgent } from "@caveman-app/session-protocol";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { expect, test, vi } from "vitest";

// The drag engine's store reads `window` on load; nothing here drags.
vi.mock("../../panes/drag.ts", () => ({}));
import { RuntimeContext, type RuntimeContextValue } from "../../state/runtime.tsx";
import { AgentRow, InstallClientRow } from "./CavemanMcp.tsx";
import {
  agentChats,
  agentLine,
  agentMark,
  agentPresence,
  connectLines,
  installRows,
  LEVELS,
  levelScope,
  patchAgent,
  shellLine,
  shellQuote,
  sortAgents,
  withAgent,
  withClient,
} from "./caveman-mcp-model.ts";

const NOW = Date.parse("2026-10-31T12:00:00Z");
const agent = (over: Partial<OutsideAgent> = {}): OutsideAgent => ({
  name: "Grok",
  level: "supervised",
  blocked: false,
  connected: 0,
  first_seen_at: "2026-10-30T09:00:00Z",
  last_seen_at: "2026-10-31T09:00:00Z",
  chats: 0,
  working: 0,
  ...over,
});

test("an argument is bare when the shell reads it back as is, else single-quoted", () => {
  expect(shellQuote("/Users/me/.caveman-code/bin/caveman-code")).toBe("/Users/me/.caveman-code/bin/caveman-code");
  expect(shellQuote("mcp")).toBe("mcp");
  // A space in the path (a home folder, "Application Support") stays one argument.
  expect(shellQuote("/Users/Jane Doe/.caveman-code/bin/caveman-code")).toBe("'/Users/Jane Doe/.caveman-code/bin/caveman-code'");
  // A quote inside is closed, escaped and reopened; `$` and `~` stay literal.
  expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  expect(shellQuote("$HOME")).toBe("'$HOME'");
  expect(shellQuote("~/bin")).toBe("'~/bin'");
  expect(shellQuote("")).toBe("''");
  expect(shellLine(["/opt/Caveman Code/caveman-code", "mcp"])).toBe("'/opt/Caveman Code/caveman-code' mcp");
});

test("each client gets the line that adds Caveman Code by hand, built from the runtime's command", () => {
  const lines = connectLines(["/Users/Jane Doe/.caveman-code/bin/caveman-code", "mcp"]);
  expect(lines.map((l) => [l.client, l.text])).toEqual([
    ["Claude Code", "claude mcp add --scope user caveman-code -- '/Users/Jane Doe/.caveman-code/bin/caveman-code' mcp"],
    ["Codex", '[mcp_servers.caveman-code]\ncommand = "/Users/Jane Doe/.caveman-code/bin/caveman-code"\nargs = ["mcp"]\ndefault_tools_approval_mode = "approve"'],
    ["Cursor", '{"mcpServers": {"caveman-code": {"command": "/Users/Jane Doe/.caveman-code/bin/caveman-code", "args": ["mcp"]}}}'],
    ["VS Code", '{"servers": {"caveman-code": {"type": "stdio", "command": "/Users/Jane Doe/.caveman-code/bin/caveman-code", "args": ["mcp"]}}}'],
    ["Grok Build", "grok mcp add caveman-code -- '/Users/Jane Doe/.caveman-code/bin/caveman-code' mcp"],
 // bot: pasted in its Add a custom MCP, named so its local exec daemon shows as bot.
    ["Grok Bot", '{"command": "/Users/Jane Doe/.caveman-code/bin/caveman-code", "args": ["mcp", "--name", "Grok Bot"]}'],
    // Any other client takes the command and its args as JSON: no shell quoting there.
    ["Any MCP client", '{"command": "/Users/Jane Doe/.caveman-code/bin/caveman-code", "args": ["mcp"]}'],
  ]);
  // Every JSON line parses.
  for (const line of lines.filter((l) => l.text.startsWith("{"))) expect(() => JSON.parse(line.text)).not.toThrow();
  // On the PATH (Settings > General), the lines say just caveman-code.
  expect(connectLines(["caveman-code", "mcp"])[0]!.text).toBe("claude mcp add --scope user caveman-code -- caveman-code mcp");
  // A runtime that has not said its command (one from before outside agents) offers no line.
  expect(connectLines([])).toEqual([]);
});

const COMMAND = ["/Users/me/.caveman-code/bin/caveman-code", "mcp"];
const clients = (over: Partial<Record<McpClientStatus["id"], Partial<McpClientStatus>>> = {}): ReadonlyArray<McpClientStatus> =>
  (["claude-code", "codex", "grok", "cursor", "vscode", "grok-bot"] as const).map((id) => ({ id, found: false, installed: false, ...over[id] }));

test("install rows: in the page's order, Install when found, Installed when its config holds it, Copy when not here", () => {
  const rows = installRows(COMMAND, clients({ "claude-code": { found: true }, codex: { found: true, installed: true }, cursor: { found: true }, grok: { found: false } }));
  expect(rows.map((r) => [r.client, r.state, r.line])).toEqual([
    ["Claude Code", "ready", "Adds caveman-code to your Claude Code user servers."],
    ["Codex", "installed", "In ~/.codex/config.toml."],
    ["Cursor", "ready", "Adds caveman-code to ~/.cursor/mcp.json, for Cursor and cursor-agent."],
    ["VS Code", "manual", "Not found on this Mac."],
    ["Grok Build", "manual", "Not found on this Mac. Grok Build also reads Claude Code's servers."],
    ["Grok Bot", "manual", "Not found on this Mac."],
    ["Any MCP client", "manual", "Goose, OpenCode, anything else: the command and its arguments."],
  ]);
  // Each row keeps its line to add by hand, for a failed install too.
  expect(rows.find((r) => r.id === "vscode")!.manual.text).toContain('"servers"');
  expect(installRows(COMMAND, clients({ grok: { found: true } })).find((r) => r.id === "grok")!.line).toBe(
    "Adds caveman-code to ~/.grok/config.toml. Grok Build also reads Claude Code's servers.",
  );
});

test("Grok Bot: Copy and open, which copies its server first; connected once an agent named Grok Bot has", () => {
  const ready = installRows(COMMAND, clients({ "grok-bot": { found: true } })).find((r) => r.id === "grok-bot")!;
  expect([ready.state, ready.action, ready.copies]).toEqual(["ready", "Copy and open", true]);
  expect(ready.line).toContain("Add a custom MCP");
  expect(JSON.parse(ready.manual.text)).toEqual({ command: COMMAND[0], args: ["mcp", "--name", "Grok Bot"] });
  const connected = installRows(COMMAND, clients({ "grok-bot": { found: true } }), [{ name: "Grok Bot" }]).find((r) => r.id === "grok-bot")!;
  expect([connected.state, connected.line]).toEqual(["installed", "Grok Bot has connected."]);
  // Every other row installs, and copies nothing.
  expect(installRows(COMMAND, clients({ codex: { found: true } })).find((r) => r.id === "codex")).toMatchObject({ action: "Install", copies: false });
});

test("a runtime that can't install (no clients) gets every client's line to copy, as before", () => {
  const rows = installRows(COMMAND, undefined);
  expect(rows.every((r) => r.state === "manual")).toBe(true);
  expect(rows.find((r) => r.id === "claude-code")!.line).toBe("");
  expect(rows.find((r) => r.id === "codex")!.line).toContain("Add to ~/.codex/config.toml");
  expect(installRows([], undefined)).toEqual([]);
});

test("an install's answer replaces its client in the list; live changes keep the rest", () => {
  const list = { agents: [], command: COMMAND, clients: clients({ cursor: { found: true } }) };
  const next = withClient(list, { id: "cursor", found: true, installed: true });
  expect(next.clients!.find((c) => c.id === "cursor")).toEqual({ id: "cursor", found: true, installed: true });
  expect(next.clients!.filter((c) => c.id !== "cursor")).toEqual(list.clients.filter((c) => c.id !== "cursor"));
  // A list from an older runtime gets the one client it now knows.
  expect(withClient({ agents: [], command: COMMAND }, { id: "codex", found: true, installed: true }).clients).toEqual([{ id: "codex", found: true, installed: true }]);
});

test("a row says whether the agent is connected, else when it was last seen, then its chats", () => {
  expect(agentPresence(agent({ connected: 1 }), NOW)).toBe("Connected now");
  expect(agentPresence(agent({ connected: 2 }), NOW)).toBe("Connected now (2)");
  expect(agentPresence(agent(), NOW)).toBe("Last seen 3h ago");
  expect(agentPresence(agent({ last_seen_at: "2026-10-31T11:59:40Z" }), NOW)).toBe("Last seen just now");
  // Disconnected by the person: said first, whatever its connections were.
  expect(agentPresence(agent({ blocked: true, connected: 1 }), NOW)).toBe("Disconnected · last seen 3h ago");
  expect(agentChats(agent())).toBe("No chats");
  expect(agentChats(agent({ chats: 1 }))).toBe("1 chat");
  expect(agentChats(agent({ chats: 3, working: 1 }))).toBe("3 chats, 1 working");
  expect(agentLine(agent({ connected: 1, chats: 4, working: 2 }), NOW)).toBe("Connected now · 4 chats, 2 working");
});

test("agents keep the order they first connected in, whatever changes live", () => {
  const list = [
    agent({ name: "Codex", first_seen_at: "2026-10-29T00:00:00Z" }),
    agent({ name: "Grok", first_seen_at: "2026-10-30T00:00:00Z", connected: 1 }),
    agent({ name: "Claude Code", first_seen_at: "2026-10-28T00:00:00Z" }),
  ];
  expect(sortAgents(list).map((a) => a.name)).toEqual(["Claude Code", "Codex", "Grok"]);
  // Disconnecting Grok, or Codex connecting, moves no row: the next row's button never slides under the pointer.
  const changed = patchAgent(patchAgent({ agents: list, command: [] }, "Grok", { blocked: true }), "Codex", {});
  expect(sortAgents(changed.agents).map((a) => a.name)).toEqual(["Claude Code", "Codex", "Grok"]);
});

test("an agent wears its vendor's mark by the name it connects as; any other gets none", () => {
  expect(agentMark("Claude Code")).toBe("claude-agent");
  expect(agentMark("Codex")).toBe("codex");
  expect(agentMark("Grok Build")).toBe("grok");
  expect(agentMark("Cursor")).toBe("cursor");
  expect(agentMark("Goose")).toBeNull();
  expect(agentMark("my-script")).toBeNull();
});

test("a change shows at once and the runtime's answer replaces it", () => {
  const list = { agents: [agent({ connected: 2 }), agent({ name: "Codex" })], command: ["caveman-code", "mcp"] };
  // Disconnect closes its connections: the row stops saying "Connected now" before the answer lands.
  const moved = patchAgent(list, "Grok", { blocked: true });
  expect(moved.agents[0]).toMatchObject({ name: "Grok", blocked: true, connected: 0 });
  expect(moved.agents[1]).toBe(list.agents[1]);
  expect(withAgent(moved, agent({ level: "full" })).agents[0]).toMatchObject({ level: "full", blocked: false });
  expect(withAgent(list, agent({ name: "Cursor" })).agents.map((a) => a.name)).toEqual(["Grok", "Codex", "Cursor"]);
});

test("each level says what it allows; Full access says it runs commands as you", () => {
  expect(LEVELS.map((l) => l.label)).toEqual(["Read", "Supervised", "Full access"]);
  expect(LEVELS.find((l) => l.value === "full")!.line).toBe("Lets this agent run commands on this Mac as you.");
  // Supervised is hard for changes, not for reading (spec v3).
  expect(LEVELS.find((l) => l.value === "supervised")!.line).toBe(
    "Starts and steers its own chats. They can read any file you can and run commands you already allowed; other commands and every edit wait for you.",
  );
  // A level is kept per name: every client connecting under it shares it.
  expect(levelScope("Claude Code")).toBe("Applies to every Claude Code on this Mac.");
});

const render = (element: ReactElement) =>
  renderToStaticMarkup(
    createElement(MemoryRouter, null, createElement(RuntimeContext.Provider, { value: { client: null, engines: [], workspaces: [], refresh: async () => undefined } as unknown as RuntimeContextValue }, element)),
  );

test("an agent's row: its level and Disconnect; a disconnected one says so and offers Allow again", () => {
  const live = render(createElement(AgentRow, { agent: agent({ connected: 1, chats: 2 }), error: null, onUpdate: () => undefined }));
  expect(live).toContain("Grok");
  expect(live).toContain("Connected now · 2 chats");
  expect(live).toContain("Supervised");
  expect(live).toContain('aria-label="Disconnect Grok"');
  expect(live).not.toContain("Allow again");
  const blocked = render(createElement(AgentRow, { agent: agent({ blocked: true }), error: null, onUpdate: () => undefined }));
  expect(blocked).toContain("Disconnected");
  expect(blocked).toContain("Allow again");
  expect(blocked).not.toContain('aria-label="Disconnect Grok"');
  // At Full access the boundary is said on the row itself, not only in the menu.
  expect(render(createElement(AgentRow, { agent: agent({ level: "full" }), error: null, onUpdate: () => undefined }))).toContain("Lets this agent run commands on this Mac as you.");
});

test("an install row: Install, Installed with Install again, or Copy with its line; busy and failed say so", () => {
  const rows = installRows(COMMAND, clients({ "claude-code": { found: true }, codex: { found: true, installed: true } }));
  const row = (id: string) => rows.find((r) => r.id === id)!;
  const html = (id: string, over: { busy?: boolean; error?: string | null } = {}) =>
    render(createElement(InstallClientRow, { row: row(id), busy: over.busy ?? false, error: over.error ?? null, onInstall: () => undefined }));
  const ready = html("claude-code");
  expect(ready).toContain('aria-label="Install Caveman MCP in Claude Code"');
  expect(ready).not.toContain("claude mcp add");
  expect(ready).not.toContain("Copy");
  expect(html("claude-code", { busy: true })).toContain("Installing…");
  const installed = html("codex");
  expect(installed).toContain("Installed");
  expect(installed).toContain("Install again");
  const manual = html("vscode");
  expect(manual).toContain("Not found on this Mac.");
  expect(manual).toContain("Copy the line for VS Code");
  expect(manual).not.toContain("Install Caveman MCP");
  // A failed install: why, under the row, and the line to add by hand beside Install.
  const failed = html("claude-code", { error: "claude mcp add failed: Error: config is locked" });
  expect(failed).toContain("claude mcp add failed: Error: config is locked");
  expect(failed).toContain("claude mcp add --scope user caveman-code");
  expect(failed).toContain("Copy the line for Claude Code");
  expect(failed).toContain('aria-label="Install Caveman MCP in Claude Code"');
});

test("no spend or cost anywhere on an agent's row or an install row", () => {
  const html =
    render(createElement(AgentRow, { agent: agent({ connected: 1, chats: 9, working: 3 }), error: null, onUpdate: () => undefined })) +
    installRows(["caveman-code", "mcp"], clients({ codex: { found: true }, cursor: { found: true, installed: true } }))
      .map((row) => render(createElement(InstallClientRow, { row, busy: false, error: null, onInstall: () => undefined })))
      .join("");
  expect(html).not.toMatch(/\$|cost|spend|token|usage/i);
});
