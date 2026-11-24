import { describe, expect, it } from "vitest";
import type { ImportSource, PluginSummary } from "./api.ts";
import {
  importableCount,
  importGroups,
  initiallyPicked,
  setupsWithSomething,
} from "./import-model.ts";
import {
  blockedRows,
  filterGroups,
  installedGroups,
  needsLine,
  needsOf,
  type Server,
  type Skill,
} from "./installed.ts";

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
const skill = (name: string, over: Partial<Skill> = {}): Skill => ({
  name,
  description: `${name} things`,
  scope: "me",
  path: `/home/me/.agents/skills/${name}/SKILL.md`,
  engines: ["caveman"],
  enabled: true,
  idle_tokens_estimate: 5,
  ...over,
});

describe("the Plugins list", () => {
  const input = {
    servers: [
      server("context7", {
        url: "https://mcp.context7.com/mcp",
        credentials: [
          { name: "CONTEXT7_CONTEXT7_API_KEY", granted: false, header: "CONTEXT7_API_KEY" },
        ],
      }),
      server("figma", {
        url: "https://mcp.figma.com/mcp",
        auth: "oauth",
        status: "needs_sign_in",
        source: "codex",
      }),
      server("playwright", { command: "npx", source: "codex", tools: ["click", "open"] }),
      server("old", { command: "x", enabled: false }),
      server("ready", { url: "https://r.example/mcp", auth: "oauth", status: "connected" }),
    ],
    plugins: [
      plugin("hooky@caveman", { hooks: ["PreToolUse"], trusted: false }),
      plugin("slack@caveman", {
        mcp_servers: ["slack"],
        interface: { display_name: "Slack", short_description: "Messages" },
      }),
      plugin("browse-only@caveman", { installed: false }),
      plugin("quiet@caveman", { enabled: false, description: "Says little" }),
      plugin("policy@team", { required: true, scope: "team" }),
      plugin("only-api@caveman", {
        scope: "project",
        interface: { short_description: "For the API" },
      }),
      plugin("asked@repo", { installed: false, enabled: false, suggested: true }),
    ],
    skills: [
      skill("from-plugin", { scope: "plugin", plugin_id: "slack@caveman" }),
      skill("project-one", { scope: "project", project_id: "p1" }),
      skill("mine"),
      skill("alpha"),
    ],
    rules: [
      {
        path: "/home/me/.claude/CLAUDE.md",
        name: "CLAUDE.md",
        scope: "me" as const,
        engines: ["claude-agent" as const],
        exists: true,
        idle_tokens_estimate: 10,
      },
      {
        path: "/repo/AGENTS.md",
        name: "AGENTS.md",
        scope: "project" as const,
        project_id: "p1",
        engines: ["codex" as const, "caveman" as const],
        exists: false,
        idle_tokens_estimate: 0,
      },
    ],
  };
  const groups = installedGroups(input);
  const rows = (id: string, of = groups) =>
    of.find((g) => g.id === id)?.rows.map((r) => [r.name, r.line]);

  it("is what every agent gets: plugins and your servers with a switch each, then your own skill and rule files, folded", () => {
    expect(groups.map((g) => [g.id, g.folded])).toEqual([
      ["plugins", false],
      ["servers", false],
      ["skills", true],
      ["rules", true],
    ]);
    // On before off, then by name; an off one keeps its own line, since the switch already says off.
    expect(rows("plugins")).toEqual([
      ["hooky", "Hooks wait for your trust"],
      ["policy", "team"],
      ["Slack", "Messages"],
      ["quiet", "Says little"],
    ]);
    // A plugin's own server is on its plugin's page, not a row of its own.
    expect(rows("servers")).toEqual([
      ["context7", "Needs CONTEXT7_API_KEY"],
      ["figma", "Needs sign-in"],
      ["playwright", "From Codex · 2 tools"],
      ["ready", "From Claude Code"],
      ["old", "From Claude Code"],
    ]);
    expect(rows("skills")).toEqual([
      ["alpha", "alpha things"],
      ["mine", "mine things"],
    ]);
    expect(rows("rules")).toEqual([["CLAUDE.md", "Read by Claude Agent"]]);
  });

  it("gives a plugin and a server a switch, locks a required one, and none to a file", () => {
    const row = (name: string) => groups.flatMap((g) => g.rows).find((r) => r.name === name)!;
    expect(row("Slack").toggle).toEqual({ on: true });
    expect(row("quiet").toggle).toEqual({ on: false });
    expect(row("old").toggle).toEqual({ on: false });
    expect(row("policy").toggle).toEqual({ on: true, locked: "Your team requires it" });
    expect(row("policy").tag).toBe("Required");
    expect(row("mine").toggle).toBeUndefined();
    expect(row("CLAUDE.md").toggle).toBeUndefined();
  });

  it("with a project picked, is what that project's chats get, each switch the project's own; then its own files", () => {
    // The lists as read for the project's folder: quiet is switched on there alone, hooky off there alone, and so is a server.
    const there = {
      ...input,
      plugins: input.plugins.map((p) =>
        p.id === "quiet@caveman"
          ? { ...p, enabled: true, here: "on" as const }
          : p.id === "hooky@caveman"
            ? { ...p, enabled: false, here: "off" as const }
            : p,
      ),
      servers: input.servers.map((s) =>
        s.name === "old"
          ? { ...s, enabled: true, here: "on" as const }
          : s.name === "ready"
            ? { ...s, enabled: false, here: "off" as const }
            : s,
      ),
    };
    const here = installedGroups({ ...there, project: "p1" });
    expect(here.map((g) => g.id)).toEqual(["plugins", "servers", "skills", "rules"]);
    expect(here[0]!.rows.map((r) => [r.name, r.tag, r.toggle?.on])).toEqual([
      ["only-api", "Only here", true],
      ["policy", "Required", true],
      ["quiet", "Only here", true],
      ["Slack", undefined, true],
      ["asked", "Suggested", false],
      ["hooky", undefined, false],
    ]);
    // Off here, it waits on nothing: its hooks are not counted.
    expect(here[0]!.rows.find((r) => r.name === "hooky")!.need).toBeUndefined();
    expect(here[1]!.rows.map((r) => [r.name, r.tag, r.toggle?.on])).toEqual([
      ["context7", undefined, true],
      ["figma", undefined, true],
      ["old", "Only here", true],
      ["playwright", undefined, true],
      ["ready", undefined, false],
    ]);
    expect(rows("skills", here)).toEqual([["project-one", "project-one things"]]);
    expect(rows("rules", here)).toEqual([
      ["AGENTS.md", "Not written yet · Caveman, Codex would read it"],
    ]);
    // Everywhere, a plugin installed for one project is not listed, and nothing says "Only here".
    expect(
      groups.flatMap((g) => g.rows).some((r) => r.name === "only-api" || r.tag === "Only here"),
    ).toBe(false);
  });

  it("counts what waits on the person once, on one line, and knows what does nothing until set up", () => {
    const needs = needsOf(groups);
    expect(needs.map((n) => [n.kind, n.title, n.line, n.rows.length])).toEqual([
      ["sign_in", "Sign in to figma", "figma", 1],
      ["keys", "Add a key for context7", "context7", 1],
      ["hooks", "Trust hooky's hooks", "hooky", 1],
    ]);
    expect(needsLine(needs)).toBe("2 need a sign-in or a key · 1 has hooks to trust");
    // Hooks aren't turned off with the rest: their plugin works without them.
    expect(blockedRows(needs).map((r) => r.name)).toEqual(["figma", "context7"]);
    const many = installedGroups({
      servers: ["a", "b", "c", "d"].map((n) =>
        server(n, { url: `https://${n}.example/mcp`, auth: "oauth", status: "needs_sign_in" }),
      ),
      plugins: [],
      skills: [],
      rules: [],
    });
    expect(needsOf(many).map((n) => [n.title, n.line])).toEqual([
      ["Sign in to 4 servers", "a, b and 2 more"],
    ]);
    expect(needsLine(needsOf(many))).toBe("4 need a sign-in or a key");
    const one = installedGroups({
      servers: [
        server("solo", { url: "https://s.example/mcp", auth: "oauth", status: "needs_sign_in" }),
      ],
      plugins: [],
      skills: [],
      rules: [],
    });
    expect(needsLine(needsOf(one))).toBe("Sign in to solo");
    expect(needsLine([])).toBe("");
  });

  it("a search keeps the rows that match every word, across groups", () => {
    expect(filterGroups(groups, "from codex").flatMap((g) => g.rows.map((r) => r.name))).toEqual([
      "playwright",
    ]);
    expect(filterGroups(groups, "  ")).toBe(groups);
    expect(filterGroups(groups, "nothing-like-this")).toEqual([]);
  });
});

describe("the import checklist", () => {
  const item = (
    from: "claude" | "codex" | "cursor",
    kind: ImportSource["items"][number]["kind"],
    name: string,
    over: Partial<ImportSource["items"][number]> = {},
  ) => ({ from, kind, name, detail: "", action: "import" as const, ...over });
  const sources: ImportSource[] = [
    {
      from: "claude",
      found: true,
      items: [
        item("claude", "mcp_server", "context7", {
          detail: "https://mcp.context7.com/mcp",
          credentials: ["CONTEXT7_CONTEXT7_API_KEY"],
        }),
        item("claude", "mcp_server", "mobbin", { detail: "https://api.mobbin.com/mcp" }),
        item("claude", "mcp_server", "pg", {
          action: "skip",
          reason: "pg: its command line or URL holds a credential",
        }),
        item("claude", "skill", "notes", { action: "available" }),
      ],
    },
    {
      from: "codex",
      found: true,
      items: [
        // Spelled differently in Codex: still Claude Code's context7.
        item("codex", "mcp_server", "Context7", {
          action: "available",
          same_as: { from: "claude", name: "context7" },
        }),
        item("codex", "mcp_server", "github", {
          detail: "docker run -i --rm ghcr.io/github/github-mcp-server",
        }),
        item("codex", "plugin", "linear@openai-curated", { action: "install" }),
      ],
    },
    { from: "cursor", found: false, items: [] },
  ];

  it("is one list per kind, a server two setups list is one row, and what can't come in says why without its name", () => {
    const groups = importGroups(sources);
    expect(groups.map((g) => [g.kind, g.pick.length, g.here.length, g.cant.length])).toEqual([
      ["mcp_server", 3, 0, 1],
      ["plugin", 1, 0, 0],
      ["skill", 0, 1, 0],
    ]);
    const servers = groups[0]!;
    expect(servers.pick.map((r) => [r.item.name, r.from, r.hint])).toEqual([
      ["context7", ["claude", "codex"], "Needs a key"],
      ["mobbin", ["claude"], "Signs in"],
      ["github", ["codex"], undefined],
    ]);
    expect(servers.cant.map((r) => r.reason)).toEqual([
      "its command line or URL holds a credential",
    ]);
  });

  it("starts with everything that can come in ticked, and counts it for the way in", () => {
    expect(initiallyPicked(importGroups(sources)).size).toBe(4);
    expect(importableCount(sources)).toBe(4);
    expect(setupsWithSomething(sources)).toBe("Claude Code and Codex");
  });
});
