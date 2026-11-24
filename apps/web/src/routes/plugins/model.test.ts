import { describe, expect, it } from "vitest";
import type { MarketplaceInfo, PluginSummary } from "./api.ts";
import {
  browseSections,
  recommended,
  containmentText,
  hookEngines,
  includesLine,
  installParams,
  nameList,
  splitCommand,
  suggestServerName,
  notConnected,
  oldTabTarget,
  type PluginInfo,
  pluginBrings,
  pluginEngines,
  pluginScope,
  policyChoices,
  rowState,
  signInTag,
  runsOutside,
  serverEngines,
  sharedByLine,
  sharedLine,
  skillEngines,
  teamReach,
  tokenLabel,
} from "./model.ts";
import { browseSources, CAVEMAN, sourceOf, sourcePath, sourcePlugins, TEAM } from "./browse-model.ts";

const plugin = (over: Partial<PluginInfo>): PluginInfo => ({
  id: "ops@kit-1",
  name: "ops",
  enabled: true,
  skills: [],
  commands: [],
  agents: [],
  hooks: [],
  mcp_servers: [],
  panels: [],
  tools: [],
  connectors: [],
  marketplace: "kit-1",
  installed: true,
  required: false,
  interface: {},
  includes: { skills: 0, mcp_servers: 0, connections: 0, hooks: 0, commands: 0, agents: 0, rules: 0 },
  needs_connect: false,
  ...over,
});

describe("Manage model", () => {
  it("names what a plugin brings, leaving out kinds it has none of", () => {
    const brings = pluginBrings(
      plugin({
        tools: [{ name: "query_logs", title: "Query logs", server: "dd" }],
        connectors: [{ id: "dd", title: "Datadog", credentials: ["DD_API_KEY"] }],
        mcp_servers: ["dd"],
        skills: ["triage", "postmortem"],
        hooks: ["SessionStart"],
        lsp_servers: ["yaml"],
      }),
    );
    expect(brings.map((b) => [b.kind, b.label, b.names])).toEqual([
      ["tools", "1 tool", ["Query logs"]],
      ["connectors", "1 connector", ["Datadog"]],
      ["mcp_servers", "1 MCP server", ["dd"]],
      ["skills", "2 skills", ["triage", "postmortem"]],
      ["hooks", "1 hook", ["SessionStart"]],
      ["lsp_servers", "1 language server", ["yaml"]],
    ]);
  });

  it("says plainly when only the environment filter applies", () => {
    expect(containmentText("macos_sandbox").strong).toBe(true);
    expect(containmentText("bubblewrap").strong).toBe(true);
    // What the sandbox enforces, and that reads stay open (no overclaim).
    for (const kind of ["macos_sandbox", "bubblewrap"] as const) {
      expect(containmentText(kind).label).toMatch(/writes only to the workspace, the shared plugin cache and Claude's plugin data and session-env folders/);
      expect(containmentText(kind).label).toMatch(/your other files, except common credential files/);
      expect(containmentText(kind).label).not.toMatch(/the listed/);
    }
    expect(containmentText("macos_sandbox").label).toMatch(/can read other programs' environment/);
    expect(containmentText("env_filter")).toEqual({ label: expect.stringMatching(/^Environment filter only/), strong: false });
  });

  it("a plugin is Me unless plugin.list says Project or Team", () => {
    expect([undefined, {}, { scope: "project" }, { scope: "team" }, { scope: "space" }].map(pluginScope)).toEqual(["me", "me", "project", "team", "me"]);
  });

  it("names the engines each part reaches, hooks only once trusted", () => {
    expect(pluginEngines(plugin({ mcp_servers: ["dd"] }))).toEqual(["caveman", "claude-agent", "codex", "acp"]);
    // Codex and the Caveman engine have no SSE client.
    expect(pluginEngines(plugin({ mcp_servers: ["dd"], sse_servers: ["dd"] }))).toEqual(["claude-agent", "acp"]);
    expect(pluginEngines(plugin({ mcp_servers: ["dd", "logs"], sse_servers: ["dd"] }))).toEqual(["caveman", "claude-agent", "codex", "acp"]);
    expect(serverEngines(plugin({ mcp_servers: ["dd", "logs"], sse_servers: ["dd"] }), "logs")).toEqual(["caveman", "claude-agent", "codex", "acp"]);
    expect(pluginEngines(plugin({ skills: ["triage"] }))).toEqual(["caveman", "claude-agent", "codex"]);
    expect(pluginEngines(plugin({ commands: ["ship"] }))).toEqual(["caveman", "claude-agent", "codex"]);
    expect(pluginEngines(plugin({ agents: ["planner"] }))).toEqual(["claude-agent"]);
    expect(pluginEngines(plugin({ hooks: ["PreToolUse"] }))).toEqual([]);
    expect(pluginEngines(plugin({ hooks: ["PreToolUse"], trusted: true }))).toEqual(["caveman", "claude-agent", "codex"]);
    expect(skillEngines(["codex", "claude-agent", "acp:gemini"])).toEqual(["claude-agent", "codex", "acp"]);
  });

  it("labels estimates, and says nothing before anything is measured", () => {
    expect(tokenLabel(undefined)).toBeUndefined();
    expect(tokenLabel(45)).toBe("~45 tokens");
    expect(tokenLabel(1000)).toBe("~1k tokens");
    expect(tokenLabel(21549)).toBe("~21.5k tokens");
  });

  it("reads names typed as a list", () => {
    expect(nameList("SENTRY_TOKEN, Authorization  X-Org")).toEqual(["SENTRY_TOKEN", "Authorization", "X-Org"]);
  });
});


const none = { skills: 0, mcp_servers: 0, connections: 0, hooks: 0, commands: 0, agents: 0, rules: 0 };
const listed = (id: string, over: Partial<PluginSummary> = {}): PluginSummary =>
  plugin({ id, name: id.split("@")[0]!, marketplace: id.split("@")[1]!, installed: false, enabled: false, ...over });
const market = (name: string, kind: MarketplaceInfo["kind"]): MarketplaceInfo => ({ name, display_name: name, kind, source: name, plugin_count: 0, problems: [] });

describe("marketplace browse", () => {
  const markets = [market("caveman-curated", "caveman"), market("acme", "team"), market("personal", "personal"), market("anthropic", "added"), market("caveman", "added")];
  const all = [
    listed("slack@caveman-curated"),
    listed("deploy@acme"),
    listed("mine@personal", { installed: true }),
    listed("review@anthropic"),
    listed("linear@caveman-curated", { installed: true, scope: "team" }),
    listed("cave@caveman"),
  ];

  it("Browse lists Caveman, the team (signed in), then each other marketplace with plugins; each shows its own", () => {
    expect(browseSources(all, markets, true).map((r) => [r.source, r.title, r.line])).toEqual([
      [CAVEMAN, "Caveman", "2 plugins"],
      [TEAM, "Your team", "1 plugin"],
      ["anthropic", "anthropic", "1 plugin"],
      ["caveman", "caveman", "1 plugin"],
      ["personal", "Made by you", "1 plugin"],
    ]);
    expect(browseSources(all, markets, false).map((r) => r.source)).not.toContain(TEAM);
    expect(sourcePlugins(CAVEMAN, all, markets).map((p) => p.id)).toEqual(["slack@caveman-curated", "linear@caveman-curated"]);
    expect(sourcePlugins(TEAM, all, markets).map((p) => p.id)).toEqual(["deploy@acme"]);
    expect(sourcePlugins("anthropic", all, markets).map((p) => p.id)).toEqual(["review@anthropic"]);
    expect(sourceOf("acme", markets)).toBe(TEAM);
  });

  it("a marketplace you added named like Caveman's catalog is its own source, never Caveman's", () => {
    expect(sourcePlugins("caveman", all, markets).map((p) => p.id)).toEqual(["cave@caveman"]);
    expect([sourcePath(CAVEMAN), sourcePath(TEAM), sourcePath("caveman")]).toEqual(["/plugins/browse/%40caveman", "/plugins/browse/%40team", "/plugins/browse/caveman"]);
    // An old link naming a marketplace of the catalog opens the catalog.
    expect(sourceOf("caveman-curated", markets)).toBe(CAVEMAN);
  });

  // `n` plugins of one category: "<prefix>1@c" and on.
  const some = (prefix: string, n: number, category?: string) => Array.from({ length: n }, (_, i) => listed(`${prefix}${i + 1}@c`, category ? { interface: { category } } : {}));

  it("sections: categories in the catalog's order, unknown ones after, More last", () => {
    const ps = [
      ...some("a", 3, "Design"),
      ...some("b", 4, "Developer tools"),
      listed("c@c", { interface: { category: "Developer tools" } }),
      ...some("s", 5, "Science"),
      listed("e@c"),
      // Claude Code's official marketplace writes them in lower case.
      ...some("f", 2, "security"),
      ...some("g", 2, "Security"),
      listed("h@c", { interface: { category: "design" } }),
    ];
    const sections = browseSections(ps, ["Developer tools", "Design"]);
    expect(sections.map((s) => [s.title, s.plugins.map((p) => p.id)])).toEqual([
      ["Developer tools", ["b1@c", "b2@c", "b3@c", "b4@c", "c@c"]],
      ["Design", ["a1@c", "a2@c", "a3@c", "h@c"]],
      ["Science", ["s1@c", "s2@c", "s3@c", "s4@c", "s5@c"]],
      ["Security", ["f1@c", "f2@c", "g1@c", "g2@c"]],
      ["More", ["e@c"]],
    ]);
  });

  it("a category under four plugins closes the page under More, in the catalog's order, before the uncategorized", () => {
    const ps = [...some("d", 6, "Development"), ...some("l", 3, "learning"), listed("e@c"), ...some("m", 2, "math"), ...some("a", 3, "automation")];
    const sections = browseSections(ps, ["Automation"]);
    expect(sections.map((s) => [s.title, s.plugins.map((p) => p.id)])).toEqual([
      ["Development", ["d1@c", "d2@c", "d3@c", "d4@c", "d5@c", "d6@c"]],
      ["More", ["a1@c", "a2@c", "a3@c", "l1@c", "l2@c", "l3@c", "m1@c", "m2@c", "e@c"]],
    ]);
  });

  it("a marketplace too small for any section is one: All plugins", () => {
    const sections = browseSections([...some("p", 2, "productivity"), listed("e@c")], []);
    expect(sections.map((s) => [s.title, s.plugins.length])).toEqual([["All plugins", 3]]);
  });

  it("Recommended: the featured ids in their order, up to n, skipping ones not listed", () => {
    const ps = some("p", 5);
    expect(recommended(ps, ["p3@c", "missing@c", "p1@c", "p5@c"], 2).map((p) => p.id)).toEqual(["p3@c", "p1@c"]);
  });

  it("a row says Required over installed, installed over available", () => {
    expect([listed("a@c", { required: true, installed: true }), listed("b@c", { installed: true }), listed("c@c")].map(rowState)).toEqual(["required", "installed", "available"]);
  });

  it("the includes line names a lone MCP server and counts the rest", () => {
    const line = (inc: Partial<typeof none>, servers?: Array<{ name: string }>) => includesLine({ ...none, ...inc }, servers).map((p) => p.label).join(" · ");
    expect(line({ skills: 4, mcp_servers: 1, hooks: 1 }, [{ name: "slack" }])).toBe("4 skills · Slack MCP server · 1 hook");
    expect(line({ skills: 1, mcp_servers: 2 }, [{ name: "a" }, { name: "b" }])).toBe("1 skill · 2 MCP servers");
    expect(line({ mcp_servers: 1 })).toBe("1 MCP server");
    expect(line({})).toBe("");
  });

});

describe("old links", () => {
  it("the tabs this page had, Customize and Spaces land on their place in Installed or Browse", () => {
    expect([undefined, "connectors", "skills", "mcp", "hooks", "rules", "installed", "plugins", "caveman", "team", "yours", "sources", "marketplace", "memory", "automations"].map(oldTabTarget)).toEqual([
      "/plugins",
      "/plugins",
      "/plugins",
      "/plugins",
      "/plugins",
      "/plugins",
      "/plugins",
      "/plugins",
      "/plugins/browse",
      "/plugins/browse/%40team",
      "/plugins/browse",
      "/plugins/browse",
      "/plugins/browse",
      "/settings/memory",
      "/automations",
    ]);
  });
});

describe("adding a server", () => {
  it("splits a command line as a shell does", () => {
    expect(splitCommand(`"/Applications/My App/bin/tool" --stdio a\\ b 'c d' --x="1 2"`)).toEqual(["/Applications/My App/bin/tool", "--stdio", "a b", "c d", "--x=1 2"]);
    expect(splitCommand("  npx   -y  @acme/mcp  ")).toEqual(["npx", "-y", "@acme/mcp"]);
    expect(splitCommand(`""`)).toEqual([""]);
  });

  it("names a server from what was pasted, as people would", () => {
    const cases: Array<[string, string]> = [
      ["https://mcp.context7.com/mcp", "context7"],
      ["https://mcp.linear.app/mcp", "linear"],
      ["https://api.mobbin.com/mcp", "mobbin"],
      ["docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server", "github"],
      ["npx @playwright/mcp@latest", "playwright"],
      ["/Users/me/.paper/bin/paper mcp", "paper"],
      ["/opt/homebrew/bin/agent-browser mcp", "agent-browser"],
      ["node /Users/me/caveman-delegate-mcp.mjs", "caveman-delegate"],
      ["npx -y @modelcontextprotocol/server-github", "github"],
      ["uvx mcp-server-fetch", "fetch"],
      ["", ""],
    ];
    for (const [input, name] of cases) expect([input, suggestServerName(input)]).toEqual([input, name]);
  });
});

describe("install", () => {
  it("a project or team install reaches teammates only from a marketplace they can resolve", () => {
    expect(teamReach({ shareable: "yes" }, false)).toEqual({ ok: true, addToTeam: false });
    expect(teamReach(undefined, false)).toEqual({ ok: true, addToTeam: false });
    expect(teamReach({ shareable: "add_to_team" }, true)).toEqual({ ok: true, addToTeam: true });
    expect(teamReach({ shareable: "add_to_team" }, false)).toEqual({ ok: false, line: "Ask an admin to add this marketplace to the team" });
    // A folder never reaches anyone else, admin or not.
    expect(teamReach({ shareable: "no" }, true)).toMatchObject({ ok: false });
  });

  it("offers On by default and Required only to admins", () => {
    expect(policyChoices(true).map((c) => c.value)).toEqual(["available", "default", "required"]);
    expect(policyChoices(false).map((c) => c.value)).toEqual(["available"]);
  });

  it("sends policy, sign-in and add_to_team only beyond Me, and the project's path as cwd", () => {
    const base = { id: "linear@caveman-curated", projectId: "p1", policy: "required" as const, shared: true, signsIn: true, addToTeam: true, cwd: "/src/api" };
    expect(installParams({ ...base, scope: "me" })).toEqual({ id: base.id, scope: "me", cwd: "/src/api" });
    expect(installParams({ ...base, scope: "project" })).toEqual({ id: base.id, scope: "project", cwd: "/src/api", project_id: "p1", policy: "required", connection: "shared", add_to_team: true });
    expect(installParams({ ...base, scope: "team", policy: "available", shared: false, signsIn: false, addToTeam: false, cwd: undefined })).toEqual({ id: base.id, scope: "team", policy: "available" });
    expect(installParams({ ...base, scope: "team", shared: false })).toMatchObject({ connection: "personal" });
  });

  it("tells a hook that runs a file outside its plugin", () => {
    const outside = ["${CLAUDE_PLUGIN_ROOT}/../../scripts/run.sh", "~/bin/check.sh", "$HOME/check.sh", "sh /Users/me/check.sh", "bash -c '/opt/tools/x'"];
    const inside = ["${CLAUDE_PLUGIN_ROOT}/run.sh", "/usr/bin/env node ${CLAUDE_PLUGIN_ROOT}/x.js", "/bin/sh -c 'echo hi > /dev/null'", "npx prettier --check ."];
    expect(outside.filter((command) => !runsOutside({ command }))).toEqual([]);
    expect(inside.filter((command) => runsOutside({ command }))).toEqual([]);
    expect(runsOutside({ command: "node", args: ["/srv/hook.js"] })).toBe(true);
  });

  it("says plainly whose account a shared install uses", () => {
    expect(sharedLine("api-gateway", "Linear")).toBe("Everyone on api-gateway will use your Linear account; their computers receive a short-lived token.");
    expect(sharedByLine("Dana")).toBe("Uses Dana's account");
    expect(sharedByLine(undefined)).toBe("Uses the team's account");
  });
});

describe("notConnected", () => {
  it("flags an installed or required plugin that is on and needs a sign-in, nothing else", () => {
    expect(notConnected(plugin({ installed: true, enabled: true, needs_connect: true }))).toBe(true);
    expect(notConnected(plugin({ required: true, installed: true, enabled: true, needs_connect: true }))).toBe(true);
    expect(notConnected(plugin({ installed: true, enabled: false, needs_connect: true }))).toBe(false);
    expect(notConnected(plugin({ installed: false, enabled: false, needs_connect: true }))).toBe(false);
    expect(notConnected(plugin({ installed: true, enabled: true, needs_connect: false }))).toBe(false);
  });
});

describe("hookEngines", () => {
  it("says the Caveman engine runs the runtime's six events, Codex SessionStart only, Claude Agent all", () => {
    expect(hookEngines("UserPromptSubmit")).toEqual(["caveman", "claude-agent"]);
    expect(hookEngines("PostToolUseFailure")).toEqual(["caveman", "claude-agent"]);
    expect(hookEngines("SessionStart")).toEqual(["caveman", "claude-agent", "codex"]);
    expect(hookEngines("PreCompact")).toEqual(["claude-agent"]);
  });
});

describe("signInTag", () => {
  it("says Sign-in expired for a sign-in that stopped working, Needs sign-in for one never made", () => {
    expect(signInTag({ status: "needs_sign_in", problem: "Its sign-in stopped working: connect it again." })).toEqual({ label: "Sign-in expired", tone: "yellow" });
    expect(signInTag({ status: "needs_sign_in" })).toEqual({ label: "Needs sign-in", tone: "neutral" });
    expect(signInTag({ status: "connected" })).toEqual({ label: "Signed in", tone: "green" });
    expect(signInTag({ status: "error", problem: "boom" })).toEqual({ label: "Sign-in failed", tone: "red" });
  });
});
