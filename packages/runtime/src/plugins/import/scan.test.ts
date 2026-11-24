import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginServer } from "@caveman-app/protocol";
import { describe, expect, it } from "vitest";

import { applyImports, classifyFolder, codexTables, importHomes, importSources, type ImportExisting, type ImportOps, type ScannedSource, scanImports } from "./scan.ts";

/** Must never appear in any scan, apply result, saved server or log. */
const CANARY = "canary9X7Q2w8E4r6T1y3U5i";

const write = (file: string, text: string) => {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};
const skill = (dir: string, name: string) => write(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} skill\n---\nbody\n`);

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "import-scan-"));
  const claude = join(home, "claude-config"); // CLAUDE_CONFIG_DIR
  const codex = join(home, "codex-home"); // CODEX_HOME
  write(
    join(claude, "plugins", "known_marketplaces.json"),
    JSON.stringify({
      "claude-plugins-official": { source: { source: "github", repo: "anthropics/claude-plugins-official" }, installLocation: join(claude, "plugins", "x") },
      "local-market": { source: { source: "directory", path: join(home, "my-market") }, installLocation: join(home, "my-market") },
      leaky: { source: { source: "git", url: `https://bob:${CANARY}@git.example.com/team/plugins.git` } },
      "single-url": { source: { source: "url", url: "https://example.com/marketplace.json" } },
    }),
  );
  write(
    join(claude, "settings.json"),
    JSON.stringify({
      enabledPlugins: {
        "frontend-design@claude-plugins-official": true,
        "typescript-lsp@claude-plugins-official": false,
        "commit@claude-code-plugins": true,
        "tool@leaky": true,
        "thing@caveman": true,
        "x@unknown-market": true,
        "already@ponytail": true,
      },
      extraKnownMarketplaces: {
        ponytail: { source: { source: "github", repo: "DietrichGebert/ponytail" } },
        caveman: { source: { source: "github", repo: "JuliusBrussee/caveman" } },
      },
      env: { ANTHROPIC_API_KEY: CANARY },
    }),
  );
  write(
    join(claude, ".claude.json"),
    JSON.stringify({
      oauthAccount: { accessToken: CANARY },
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: CANARY } },
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${CANARY}` } },
        keyed: { command: "node", args: ["server.js", "--api-key", CANARY] },
        mine: { command: "my-server" },
        // Listed bare here; Codex sends a token to the same URL.
        Docs: { type: "http", url: "https://docs.example/mcp" },
      },
    }),
  );
  skill(join(claude, "skills"), "release-notes");
  write(join(claude, "CLAUDE.md"), "be terse\n");

  write(
    join(codex, "config.toml"),
    [
      'model = "gpt-6"',
      "[marketplaces.team-tools]",
      'source_type = "git"',
      'source = "acme/team-tools"',
      'ref = "v2"',
      "[marketplaces.gitm]",
      'source = "https://git.example.com/a/b.git"',
      'ref = "main"',
      "[plugins.\"linter@team-tools\"]",
      "enabled = true",
      "[plugins.\"off@team-tools\"]",
      "enabled = false",
      "[plugins.\"linear@openai-curated\"]",
      "enabled = true",
      "[plugins._default]",
      "enabled = true",
      "[mcp_servers.sentry]",
      'command = "npx"',
      'args = ["-y", "@sentry/mcp-server"]',
      `env = { SENTRY_AUTH_TOKEN = "${CANARY}" }`,
      "[mcp_servers.github]",
      'url = "https://api.githubcopilot.com/mcp/"',
      `http_headers = { "Authorization" = "Bearer ${CANARY}" }`,
      "[mcp_servers.docs]",
      'url = "https://docs.example/mcp"',
      'bearer_token_env_var = "DOCS_TOKEN"',
    ].join("\n"),
  );
  skill(join(codex, "skills"), "triage");
  skill(join(codex, "skills"), ".system");
  write(join(codex, "AGENTS.md"), "codex rules\n");

  write(
    join(home, ".cursor", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        figma: { url: "https://mcp.figma.com/mcp" },
        db: { command: "pg-mcp", env: { DATABASE_URL: `postgres://u:${CANARY}@h/db` } },
        // Claude Code's Linear again: one server, imported from Claude Code.
        linear: { url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${CANARY}` } },
      },
    }),
  );
  mkdirSync(join(home, "my-market", ".claude-plugin"), { recursive: true });

  const homes = importHomes({ CLAUDE_CONFIG_DIR: claude, CODEX_HOME: codex }, home);
  return { home, claude, codex, homes };
}

const existing: ImportExisting = {
  marketplaces: new Map([
    ["caveman", undefined],
    ["ponytail", "DietrichGebert/ponytail"],
  ]),
  installed: ["already@ponytail"],
  servers: ["mine"],
};

const find = (sources: Awaited<ReturnType<typeof scanImports>>, from: string, kind: string, name: string) =>
  sources.find((s) => s.from === from)!.items.find((i) => i.item.kind === kind && i.item.name === name)?.item;

describe("import.scan", () => {
  it("respects CLAUDE_CONFIG_DIR and CODEX_HOME", () => {
    const homes = importHomes({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }, "/home/me");
    expect(homes).toMatchObject({ claudeDir: "/c", claudeJson: join("/c", ".claude.json"), codexHome: "/x", cursorDir: join("/home/me", ".cursor"), agentsSkills: join("/home/me", ".agents", "skills") });
  });

  it("lists Claude Code marketplaces and enabled plugins with what importing does", async () => {
    const { homes, home } = fixture();
    const sources = await scanImports(homes, { existing, codexOwnHome: false });
    expect(sources.map((s) => [s.from, s.found])).toEqual([["claude", true], ["codex", true], ["cursor", true]]);

    expect(find(sources, "claude", "marketplace", "claude-plugins-official")).toMatchObject({ action: "add", detail: "anthropics/claude-plugins-official" });
    // Named only by an enabled plugin: mapped as Codex does.
    expect(find(sources, "claude", "marketplace", "claude-code-plugins")).toMatchObject({ action: "add", detail: "anthropics/claude-code" });
    expect(find(sources, "claude", "marketplace", "local-market")).toMatchObject({ action: "add", detail: join(home, "my-market") });
    expect(find(sources, "claude", "marketplace", "leaky")).toMatchObject({ action: "skip", reason: expect.stringContaining("credential") });
    expect(find(sources, "claude", "marketplace", "single-url")).toMatchObject({ action: "skip" });
    expect(find(sources, "claude", "marketplace", "ponytail")).toMatchObject({ action: "available" });
    // Our catalog is also named caveman: a different marketplace of that name is not merged into it.
    expect(find(sources, "claude", "marketplace", "caveman")).toMatchObject({ action: "skip", reason: "another marketplace is already named caveman" });

    expect(find(sources, "claude", "plugin", "frontend-design@claude-plugins-official")).toMatchObject({ action: "install" });
    expect(find(sources, "claude", "plugin", "typescript-lsp@claude-plugins-official")).toBeUndefined();
    expect(find(sources, "claude", "plugin", "commit@claude-code-plugins")).toMatchObject({ action: "install" });
    expect(find(sources, "claude", "plugin", "tool@leaky")).toMatchObject({ action: "skip", reason: expect.stringContaining("cannot be added") });
    expect(find(sources, "claude", "plugin", "thing@caveman")).toMatchObject({ action: "skip" });
    expect(find(sources, "claude", "plugin", "x@unknown-market")).toMatchObject({ action: "skip", reason: "its marketplace unknown-market is not known" });
    expect(find(sources, "claude", "plugin", "already@ponytail")).toMatchObject({ action: "available" });

    expect(find(sources, "claude", "skill", "release-notes")).toMatchObject({ action: "available" });
    expect(find(sources, "claude", "instructions", "CLAUDE.md")).toMatchObject({ action: "available" });
  });

  it("lists MCP servers with credential names, never values", async () => {
    const { homes } = fixture();
    const sources = await scanImports(homes, { existing, codexOwnHome: false });
    expect(find(sources, "claude", "mcp_server", "github")).toMatchObject({ action: "import", credentials: ["GITHUB_TOKEN"] });
    expect(find(sources, "claude", "mcp_server", "linear")).toMatchObject({ action: "import", credentials: ["LINEAR_AUTHORIZATION"] });
    expect(find(sources, "claude", "mcp_server", "keyed")).toMatchObject({ action: "skip" });
    expect(find(sources, "claude", "mcp_server", "mine")).toMatchObject({ action: "available" });
    expect(find(sources, "codex", "mcp_server", "sentry")).toMatchObject({ action: "import", credentials: ["SENTRY_AUTH_TOKEN"] });
    // Claude Code's github came first, and Codex's runs something else under the name.
    expect(find(sources, "codex", "mcp_server", "github")).toMatchObject({ action: "skip", reason: "Claude Code has a different server named github" });
    expect(find(sources, "cursor", "mcp_server", "figma")).toMatchObject({ action: "import", detail: "https://mcp.figma.com/mcp" });
    expect(find(sources, "cursor", "mcp_server", "db")).toMatchObject({ action: "import", credentials: ["DATABASE_URL"] });
    expect(find(sources, "cursor", "mcp_server", "linear")).toMatchObject({ action: "available", same_as: { from: "claude", name: "linear" } });
  });

  it("a server two setups list is one row, named as the first spells it, asking for every key either gives it", async () => {
    const { homes } = fixture();
    const sources = await scanImports(homes, { existing, codexOwnHome: false });
    // Codex's docs is Claude Code's Docs: the row says which, spelled as Claude Code spells it.
    expect(find(sources, "codex", "mcp_server", "docs")).toMatchObject({ action: "available", same_as: { from: "claude", name: "Docs" } });
    // Claude Code listed it bare (a sign-in); Codex's token is not lost: the one row asks for it instead.
    expect(find(sources, "claude", "mcp_server", "Docs")).toMatchObject({ action: "import", credentials: ["DOCS_AUTHORIZATION"] });
    const payload = sources.find((s) => s.from === "claude")!.items.find((i) => i.item.name === "Docs")!.payload;
    expect(payload).toMatchObject({ kind: "mcp_server", server: { name: "Docs", url: "https://docs.example/mcp", headers: ["Authorization"] } });
    expect(payload?.kind === "mcp_server" ? payload.server.auth : "no server").toBeUndefined();
    expect(JSON.stringify(sources)).not.toContain(CANARY);
  });

  it("reads Codex marketplaces, enabled plugins, skills and AGENTS.md", async () => {
    const { homes } = fixture();
    const managed = await scanImports(homes, { existing, codexOwnHome: false });
    expect(find(managed, "codex", "marketplace", "team-tools")).toMatchObject({ action: "add", detail: "acme/team-tools@v2" });
    const gitm = managed.find((s) => s.from === "codex")!.items.find((i) => i.item.name === "gitm");
    expect(gitm).toMatchObject({ item: { action: "add", detail: "https://git.example.com/a/b.git" }, payload: { source: "https://git.example.com/a/b.git#main" } });
    expect(find(managed, "codex", "marketplace", "openai-curated")).toMatchObject({ action: "add", detail: "openai/plugins" });
    expect(find(managed, "codex", "plugin", "linter@team-tools")).toMatchObject({ action: "install" });
    expect(find(managed, "codex", "plugin", "off@team-tools")).toBeUndefined();
    expect(find(managed, "codex", "plugin", "linear@openai-curated")).toMatchObject({ action: "install" });
    expect(find(managed, "codex", "skill", "triage")).toMatchObject({ action: "import" });
    expect(find(managed, "codex", "skill", ".system")).toBeUndefined();
    expect(find(managed, "codex", "instructions", "AGENTS.md")).toMatchObject({ action: "skip" });

    const own = await scanImports(homes, { existing, codexOwnHome: true });
    expect(find(own, "codex", "skill", "triage")).toMatchObject({ action: "available" });
    expect(find(own, "codex", "instructions", "AGENTS.md")).toMatchObject({ action: "available" });
  });

  it("reports nothing found on a machine without the tools", async () => {
    const home = mkdtempSync(join(tmpdir(), "import-empty-"));
    const sources = await scanImports(importHomes({}, home), { existing, codexOwnHome: false });
    expect(importSources(sources)).toEqual([
      { from: "claude", found: false, items: [] },
      { from: "codex", found: false, items: [] },
      { from: "cursor", found: false, items: [] },
    ]);
  });

  it("reads the Codex tables it needs and nothing else", () => {
    const tables = codexTables('[marketplaces.a]\nsource = "o/r"\n[marketplaces.a.extra]\nsource = "x"\n[plugins."p@a"]\nenabled = true # on\n[other]\nenabled = true\n');
    expect([...tables.marketplaces]).toEqual([["a", { source: "o/r" }]]);
    expect([...tables.plugins]).toEqual([["p@a", { enabled: true }]]);
  });
});

describe("import.apply", () => {
  function recorder(fail: { marketplace?: string } = {}, names: Record<string, string> = {}) {
    const calls: string[] = [];
    const servers: PluginServer[] = [];
    const ops: ImportOps = {
      addMarketplace: async (source) => {
        if (source === fail.marketplace) throw new Error("clone failed");
        calls.push(`add ${source}`);
        return { name: names[source] ?? source.split("/").pop()!.replace(/@.*$/, "") };
      },
      install: async (id) => void calls.push(`install ${id}`),
      saveServer: async (server) => void servers.push(server),
    };
    return { calls, servers, ops };
  }

  it("adds marketplaces before installing their plugins and reports each failure", async () => {
    const { homes } = fixture();
    const sources = await scanImports(homes, { existing, codexOwnHome: false });
    const { calls, servers, ops } = recorder({ marketplace: "acme/team-tools@v2" });
    const result = await applyImports(
      sources,
      [
        { from: "codex", kind: "plugin", name: "linter@team-tools" },
        { from: "claude", kind: "plugin", name: "frontend-design@claude-plugins-official" },
        { from: "claude", kind: "marketplace", name: "claude-plugins-official" },
        { from: "codex", kind: "marketplace", name: "team-tools" },
        { from: "claude", kind: "mcp_server", name: "github" },
        { from: "cursor", kind: "mcp_server", name: "figma" },
        { from: "claude", kind: "mcp_server", name: "keyed" },
        { from: "claude", kind: "skill", name: "release-notes" },
        { from: "codex", kind: "skill", name: "triage" },
        { from: "claude", kind: "plugin", name: "gone@nowhere" },
      ],
      ops,
      homes,
    );
    expect(calls).toEqual(["add anthropics/claude-plugins-official", "install frontend-design@claude-plugins-official"]);
    expect(servers.map((s) => [s.name, s.source, s.auth])).toEqual([
      ["github", "claude", undefined],
      ["figma", "cursor", "oauth"],
    ]);
    expect(servers[0]).toMatchObject({ env: ["GITHUB_TOKEN"] });
    expect(readFileSync(join(homes.agentsSkills, "triage", "SKILL.md"), "utf8")).toContain("name: triage");
    expect(result.imported).toBe(5);
    expect(result.failed).toEqual([
      { ref: { from: "codex", kind: "marketplace", name: "team-tools" }, reason: "clone failed" },
      { ref: { from: "codex", kind: "plugin", name: "linter@team-tools" }, reason: "its marketplace team-tools was not added: clone failed" },
      { ref: { from: "claude", kind: "plugin", name: "gone@nowhere" }, reason: "it is no longer in that setup" },
      { ref: { from: "claude", kind: "mcp_server", name: "keyed" }, reason: expect.stringContaining("credential") },
    ]);
  });

  it("installs under the name the marketplace's own file gives, not the tool's key for it", async () => {
    const { homes } = fixture();
    const sources = await scanImports(homes, { existing, codexOwnHome: false });
    const { calls, ops } = recorder({}, { "anthropics/claude-plugins-official": "official" });
    await applyImports(
      sources,
      [
        { from: "claude", kind: "marketplace", name: "claude-plugins-official" },
        { from: "claude", kind: "plugin", name: "frontend-design@claude-plugins-official" },
      ],
      ops,
      homes,
    );
    expect(calls).toEqual(["add anthropics/claude-plugins-official", "install frontend-design@official"]);
  });

  it("adds a few marketplaces at once, and one listed by two setups once", async () => {
    const market = (from: "claude" | "codex", name: string) => ({
      item: { from, kind: "marketplace" as const, name, detail: `acme/${name}`, action: "add" as const },
      payload: { kind: "marketplace" as const, source: `acme/${name}` },
    });
    const names = ["a", "b", "c", "d", "e", "f"];
    const sources: ScannedSource[] = [
      { from: "claude", found: true, items: names.map((n) => market("claude", n)) },
      { from: "codex", found: true, items: [market("codex", "a")] },
    ];
    let inFlight = 0;
    let most = 0;
    const added: string[] = [];
    const ops: ImportOps = {
      addMarketplace: async (source) => {
        most = Math.max(most, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        added.push(source);
        return { name: source.slice("acme/".length) };
      },
      install: async () => undefined,
      saveServer: async () => undefined,
    };
    const refs = sources.flatMap((s) => s.items.map(({ item }) => ({ from: item.from, kind: item.kind, name: item.name })));
    const result = await applyImports(sources, refs, ops, { agentsSkills: join(tmpdir(), "unused") });
    expect(most).toBe(4);
    expect([...added].sort()).toEqual(names.map((n) => `acme/${n}`));
    expect(result).toEqual({ imported: 7, failed: [] });
  });

  it("never lets a secret value out: scan, apply, saved servers or logs", async () => {
    const { homes } = fixture();
    const logged: unknown[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) => {
      const original = console[level];
      console[level] = (...args: unknown[]) => void logged.push(args);
      return () => (console[level] = original);
    });
    try {
      const sources = await scanImports(homes, { existing, codexOwnHome: false });
      const { calls, servers, ops } = recorder();
      const refs = sources.flatMap((s) => s.items.map((i) => ({ from: i.item.from, kind: i.item.kind, name: i.item.name })));
      const result = await applyImports(sources, refs, ops, homes);
      const copied = readdirSync(homes.agentsSkills, { recursive: true }).map(String);
      for (const output of [importSources(sources), sources, result, calls, servers, logged, copied]) {
        expect(JSON.stringify(output)).not.toContain(CANARY);
      }
    } finally {
      for (const restore of spies) restore();
    }
  });
});

describe("import.folder", () => {
  it("tells a marketplace, a plugin and skills apart, without git", async () => {
    const root = mkdtempSync(join(tmpdir(), "import-folder-"));
    write(join(root, "market", ".agents", "plugins", "marketplace.json"), "{}");
    write(join(root, "codex-plugin", ".codex-plugin", "plugin.json"), "{}");
    write(join(root, "open-plugin", "plugin.json"), JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "x" }));
    write(join(root, "not-plugin", "plugin.json"), JSON.stringify({ name: "x" }));
    skill(join(root, "tree", "skills"), "a");
    skill(join(root, "flat"), "b");
    skill(root, "one");
    mkdirSync(join(root, "empty"));
    symlinkSync(join(root, "flat"), join(root, "linked"));

    expect(await classifyFolder(join(root, "market"))).toEqual({ kind: "marketplace" });
    expect(await classifyFolder(join(root, "codex-plugin"))).toEqual({ kind: "plugin" });
    expect(await classifyFolder(join(root, "open-plugin"))).toEqual({ kind: "plugin" });
    await expect(classifyFolder(join(root, "not-plugin"))).rejects.toThrow("no marketplace, plugin or SKILL.md");
    expect(await classifyFolder(join(root, "tree"))).toEqual({ kind: "skills", skills: [{ name: "a", dir: join(root, "tree", "skills", "a") }] });
    expect(await classifyFolder(join(root, "flat"))).toEqual({ kind: "skills", skills: [{ name: "b", dir: join(root, "flat", "b") }] });
    expect(await classifyFolder(join(root, "one"))).toEqual({ kind: "skills", skills: [{ name: "one", dir: join(root, "one") }] });
    expect(await classifyFolder(join(root, "linked"))).toMatchObject({ kind: "skills" });
    await expect(classifyFolder(join(root, "empty"))).rejects.toThrow();
    await expect(classifyFolder("relative/path")).rejects.toThrow("absolute");
  });
});
