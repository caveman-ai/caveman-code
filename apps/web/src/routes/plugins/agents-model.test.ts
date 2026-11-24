import { describe, expect, it } from "vitest";
import {
  agentSections,
  agentsWithSetup,
  canTurnOff,
  canTurnOn,
  filterSections,
  turnOnPlan,
} from "./agents-model.ts";
import type { ImportSource, PluginSummary } from "./api.ts";
import type { Server } from "./installed.ts";

type Item = ImportSource["items"][number];
const item = (
  from: Item["from"],
  kind: Item["kind"],
  name: string,
  over: Partial<Item> = {},
): Item => ({ from, kind, name, detail: "", action: "import", ...over });
const server = (name: string, over: Partial<Server> = {}): Server => ({
  name,
  source: "claude",
  enabled: true,
  credentials: [],
  ...over,
});
const none = {
  skills: 0,
  mcp_servers: 0,
  connections: 0,
  hooks: 0,
  commands: 0,
  agents: 0,
  rules: 0,
};
const plugin = (id: string, over: Partial<PluginSummary> = {}): PluginSummary => ({
  id,
  name: id.split("@")[0]!,
  marketplace: id.split("@")[1]!,
  enabled: true,
  installed: true,
  required: false,
  needs_connect: false,
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcp_servers: [],
  panels: [],
  interface: {},
  includes: none,
  ...over,
});

const sources: ImportSource[] = [
  {
    from: "claude",
    found: true,
    items: [
      item("claude", "marketplace", "official", {
        detail: "anthropics/claude-plugins-official",
        action: "add",
      }),
      item("claude", "marketplace", "posthog", {
        detail: "PostHog/ai-plugin",
        action: "available",
      }),
      item("claude", "plugin", "frontend-design@official", { action: "install" }),
      item("claude", "plugin", "posthog@posthog", { action: "available" }),
      item("claude", "plugin", "resting@posthog", { action: "available" }),
      item("claude", "plugin", "lost@nowhere", {
        action: "skip",
        reason: "its marketplace nowhere is not known",
      }),
      item("claude", "mcp_server", "context7", {
        detail: "https://mcp.context7.com/mcp",
        credentials: ["CONTEXT7_API_KEY"],
      }),
      item("claude", "mcp_server", "paper", {
        detail: "~/.paper/bin/paper mcp",
        action: "available",
      }),
      item("claude", "mcp_server", "Agent Browser", {
        detail: "agent-browser mcp",
        action: "available",
      }),
      item("claude", "mcp_server", "pg", {
        detail: "postgres://…",
        action: "skip",
        reason: "pg: its command line or URL holds a credential",
      }),
      item("claude", "skill", "notes", { detail: "~/.claude/skills/notes", action: "available" }),
      item("claude", "instructions", "CLAUDE.md", {
        detail: "~/.claude/CLAUDE.md",
        action: "available",
      }),
    ],
  },
  {
    from: "codex",
    found: true,
    items: [
      // Spelled differently in Codex: still Claude Code's context7, which is what brings it in.
      item("codex", "mcp_server", "Context7", {
        detail: "https://mcp.context7.com/mcp",
        action: "available",
        same_as: { from: "claude", name: "context7" },
      }),
      item("codex", "mcp_server", "figma", { detail: "https://mcp.figma.com/mcp" }),
      item("codex", "skill", "imagegen", { detail: "~/.codex/skills/imagegen" }),
    ],
  },
  {
    from: "cursor",
    found: true,
    items: [item("cursor", "marketplace", "only-a-marketplace", { action: "add" })],
  },
  { from: "cursor", found: false, items: [] },
];
const mine = {
  plugins: [
    plugin("posthog@posthog", {
      interface: { display_name: "PostHog", short_description: "Product analytics" },
    }),
    plugin("resting@posthog", { enabled: false }),
  ],
  servers: [server("paper"), server("agent-browser", { enabled: false })],
};

describe("another agent's own setup", () => {
  const claude = agentSections("claude", sources, mine);
  const rows = (kind: string, of = claude) =>
    of.find((s) => s.kind === kind)?.rows.map((r) => [r.name, r.state]);

  it("lists an agent that has something beyond marketplaces", () => {
    expect(agentsWithSetup(sources)).toEqual(["claude", "codex"]);
  });

  it("is its plugins and servers with a switch each, then its skill and rule files, folded; marketplaces are not rows", () => {
    expect(claude.map((s) => [s.kind, s.title, s.folded])).toEqual([
      ["plugin", "Plugins", false],
      ["mcp_server", "MCP servers", false],
      ["skill", "Skills", true],
      ["instructions", "Rules", true],
    ]);
    // What every agent has first, then this agent's alone, then what cannot be shared.
    expect(rows("plugin")).toEqual([
      ["PostHog", "on"],
      ["frontend-design", "off"],
      ["resting", "off"],
      ["lost", "cant"],
    ]);
    expect(rows("mcp_server")).toEqual([
      ["paper", "on"],
      ["Agent Browser", "off"],
      ["context7", "off"],
      ["pg", "cant"],
    ]);
    expect(rows("skill")).toEqual([["notes", "own"]]);
  });

  it("turning one on the first time brings it in, its marketplace first; after that the switch is the thing's own", () => {
    const row = (name: string) => claude.flatMap((s) => s.rows).find((r) => r.name === name)!;
    expect(row("frontend-design").refs).toEqual([
      { from: "claude", kind: "marketplace", name: "official" },
      { from: "claude", kind: "plugin", name: "frontend-design@official" },
    ]);
    expect(row("context7")).toMatchObject({
      refs: [{ from: "claude", kind: "mcp_server", name: "context7" }],
      hint: "Needs a key",
    });
    expect(row("context7").here).toBeUndefined();
    // Here already, and off: the switch turns that plugin, that server, back on. A name two setups spell differently is one server.
    expect(row("resting")).toMatchObject({
      refs: [],
      here: { kind: "plugin", id: "resting@posthog" },
      to: "/plugins/p/resting%40posthog",
    });
    expect(row("Agent Browser")).toMatchObject({
      refs: [],
      here: { kind: "server", name: "agent-browser" },
      to: "/plugins/mcp/agent-browser",
    });
    expect(row("pg").reason).toBe("Its command line or URL holds a credential");
    expect(canTurnOn(claude).map((r) => r.name)).toEqual([
      "frontend-design",
      "resting",
      "Agent Browser",
      "context7",
    ]);
    expect(canTurnOff(claude).map((r) => r.name)).toEqual(["PostHog", "paper"]);
    expect(turnOnPlan(canTurnOn(claude))).toEqual({
      bring: [
        { from: "claude", kind: "marketplace", name: "official" },
        { from: "claude", kind: "plugin", name: "frontend-design@official" },
        { from: "claude", kind: "mcp_server", name: "context7" },
      ],
      enable: [
        { kind: "plugin", id: "resting@posthog" },
        { kind: "server", name: "agent-browser" },
      ],
    });
  });

  it("a server another setup lists too comes in through that setup's row until it is here", () => {
    const codex = agentSections("codex", sources, mine);
    expect(rows("mcp_server", codex)).toEqual([
      ["Context7", "off"],
      ["figma", "off"],
    ]);
    expect(codex[0]!.rows[0]).toMatchObject({
      refs: [{ from: "claude", kind: "mcp_server", name: "context7" }],
      hint: "Needs a key",
    });
    expect(codex[0]!.rows[1]!.hint).toBe("Signs in");
    // A skill only Codex's folder holds can be copied to where every agent reads.
    expect(rows("skill", codex)).toEqual([["imagegen", "off"]]);
    // Once Claude Code's context7 is here, Codex's row is that server's switch.
    const after = sources.map((s) =>
      s.from === "claude"
        ? {
            ...s,
            items: s.items.map((i) =>
              i.name === "context7" ? { ...i, action: "available" as const } : i,
            ),
          }
        : s,
    );
    const then = agentSections("codex", after, {
      ...mine,
      servers: [...mine.servers, server("context7")],
    });
    expect(then[0]!.rows[0]).toMatchObject({
      name: "Context7",
      state: "on",
      refs: [],
      here: { kind: "server", name: "context7" },
    });
  });

  it("a search keeps the rows that match every word", () => {
    expect(filterSections(claude, "paper").flatMap((s) => s.rows.map((r) => r.name))).toEqual([
      "paper",
    ]);
    expect(filterSections(claude, " ")).toBe(claude);
    expect(filterSections(claude, "nothing-like-this")).toEqual([]);
  });
});
