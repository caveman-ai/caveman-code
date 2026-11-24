import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { codexServers, readCodexConfig, scanSetup, setupHomes } from "./setupScan.ts";

const SECRET = "sk-live-never-read";

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "setup-scan-"));
  const repo = join(home, "acme");
  mkdirSync(join(home, ".claude", "skills", "release-notes"), { recursive: true });
  writeFileSync(join(home, ".claude", "skills", "release-notes", "SKILL.md"), "---\nname: release-notes\n---\n");
  mkdirSync(join(home, ".claude", "skills", "no-skill-file"), { recursive: true });
  writeFileSync(
    join(home, ".claude.json"),
    JSON.stringify({
      mcpServers: {
        github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_TOKEN: SECRET } },
        linear: { type: "http", url: "https://mcp.linear.app/mcp", headers: { Authorization: `Bearer ${SECRET}` } },
        // Credentials where configs often put them: an arg, a URL's userinfo, query and path, a header arg.
        postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://app:hunter2pw@db.internal/prod"] },
        zapier: { url: "https://actions.zapier.com/mcp/sk-ak-Zp4wQ9xT2mLk8vR3nB7c/sse?api_key=QUERYSECRET" },
        remote: { command: "npx", args: ["mcp-remote", "https://user:urlpass@mcp.example.com/sse", "--header", "Authorization: Bearer HEADERTOKEN"] },
        keyed: { command: "node", args: ["--api-key", "shortpw", "server.js"] },
      },
      projects: { [repo]: { mcpServers: { db: { command: "psql-mcp", env: { DATABASE_URL: SECRET } } } } },
    }),
  );
  mkdirSync(join(home, ".codex", "skills", "triage"), { recursive: true });
  writeFileSync(join(home, ".codex", "skills", "triage", "SKILL.md"), "x");
  writeFileSync(
    join(home, ".codex", "config.toml"),
    [
      'model = "gpt-6"',
      "[mcp_servers.sentry]",
      'command = "npx"',
      'args = ["-y", "@sentry/mcp-server"]',
      `env = { SENTRY_AUTH_TOKEN = "${SECRET}" }`,
      "",
      '[mcp_servers."docs-search"]',
      'url = "https://docs.example.com/mcp" # remote',
      "[mcp_servers.docs-search.env]",
      `DOCS_KEY = "${SECRET}"`,
      "[profiles.fast]",
      'command = "not-a-server"',
    ].join("\n"),
  );
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "AGENTS.md"), "# rules");
  writeFileSync(join(repo, ".mcp.json"), JSON.stringify({ mcpServers: { github: { command: "dup" }, figma: { url: "https://figma.example/mcp" } } }));
  return { home, repo };
}

describe("setup.scan", () => {
  it("finds Claude and Codex servers, skills and the repo's instructions, with who loads each", async () => {
    const { home, repo } = fixture();
    const items = await scanSetup(setupHomes({}, home), { repoPath: repo, codexOwnHome: false });
    const by = (kind: string, name: string) => items.find((i) => i.kind === kind && i.name === name);
    expect(by("mcp_server", "github")).toEqual({ kind: "mcp_server", name: "github", source: "claude", detail: "npx -y @modelcontextprotocol/server-github", env: ["GITHUB_TOKEN"], loaded_by: ["claude-agent"] });
    expect(by("mcp_server", "linear")?.detail).toBe("https://mcp.linear.app/mcp");
    expect(by("mcp_server", "db")?.env).toEqual(["DATABASE_URL"]);
    expect(by("mcp_server", "figma")?.source).toBe("claude");
    // An API-key Codex never reads ~/.codex: found, but no engine loads it.
    expect(by("mcp_server", "sentry")).toMatchObject({ source: "codex", detail: "npx -y @sentry/mcp-server", env: ["SENTRY_AUTH_TOKEN"], loaded_by: [] });
    expect(by("mcp_server", "docs-search")).toMatchObject({ detail: "https://docs.example.com/mcp", env: ["DOCS_KEY"] });
    expect(by("skill", "release-notes")?.loaded_by).toEqual(["claude-agent"]);
    expect(by("skill", "no-skill-file")).toBeUndefined();
    expect(by("skill", "triage")?.source).toBe("codex");
    expect(by("instructions", "AGENTS.md")?.loaded_by).toEqual(["caveman", "codex"]);
    expect(by("instructions", "CLAUDE.md")).toBeUndefined();
    // Without AGENTS.md the Caveman engine and Codex fall back to CLAUDE.md.
    const claudeOnly = join(home, "claude-only");
    mkdirSync(claudeOnly);
    writeFileSync(join(claudeOnly, "CLAUDE.md"), "# rules");
    const fallback = await scanSetup(setupHomes({}, home), { repoPath: claudeOnly, codexOwnHome: false });
    expect(fallback.find((i) => i.name === "CLAUDE.md")?.loaded_by).toEqual(["caveman", "claude-agent", "codex"]);
    // github appears in user and project scope; shown once.
    expect(items.filter((i) => i.name === "github")).toHaveLength(1);
    expect(items.some((i) => i.name === "not-a-server")).toBe(false);
  });

  it("never carries an environment value or header into the result", async () => {
    const { home, repo } = fixture();
    const items = await scanSetup(setupHomes({}, home), { repoPath: repo, codexOwnHome: true });
    expect(JSON.stringify(items)).not.toContain(SECRET);
    for (const leak of ["hunter2pw", "QUERYSECRET", "Zp4wQ9xT2mLk8vR3nB7c", "urlpass", "HEADERTOKEN", "shortpw"]) expect(JSON.stringify(items)).not.toContain(leak);
    const detail = (name: string) => items.find((i) => i.name === name)?.detail;
    expect(detail("postgres")).toBe("npx -y @modelcontextprotocol/server-postgres …");
    expect(detail("zapier")).toBe("https://actions.zapier.com/mcp/…/sse");
    expect(detail("remote")).toBe("npx mcp-remote …");
    expect(detail("keyed")).toBe("node …");
    expect(items.find((i) => i.name === "sentry")?.loaded_by).toEqual(["codex"]);
  });

  it("follows CLAUDE_CONFIG_DIR and CODEX_HOME, and finds nothing in an empty home", async () => {
    const homes = setupHomes({ CLAUDE_CONFIG_DIR: "/c", CODEX_HOME: "/x" }, "/home/u");
    expect(homes).toEqual({ claudeJson: join("/c", ".claude.json"), claudeDir: "/c", codexHome: "/x" });
    const empty = mkdtempSync(join(tmpdir(), "setup-scan-empty-"));
    expect(await scanSetup(setupHomes({}, empty), { codexOwnHome: false })).toEqual([]);
  });

  it("reads single-quoted names and args in config.toml", () => {
    const items = codexServers("[mcp_servers.'a b']\ncommand = 'run'\nargs = ['--x', \"y\"]\n", []);
    expect(items).toEqual([{ kind: "mcp_server", name: "a b", source: "codex", detail: "run --x y", loaded_by: [] }]);
  });
});

// ------------------------------------------------------------ Codex config.toml against an independent reader

/**
 * Python's own TOML 1.0 reader (tomllib, standard library since 3.11), the independent interpretation the
 * parser is checked against. A machine without it skips these checks and says so; it never passes them.
 */
const oracle = (toml: string): Record<string, unknown> | undefined => {
  const run = spawnSync("python3", ["-I", "-c", "import json, sys, tomllib; print(json.dumps(tomllib.loads(sys.stdin.read()), default=str))"], { input: toml, encoding: "utf8" });
  return run.status === 0 ? (JSON.parse(run.stdout) as Record<string, unknown>) : undefined;
};
const hasOracle = oracle("a = 1") !== undefined;

/** What a server means as Codex reads it, from the oracle's tables: the fields readCodexConfig takes. */
const meaning = (raw: Record<string, unknown>) => ({
  command: raw.command,
  args: raw.args,
  url: raw.url,
  env: [...Object.keys((raw.env as object) ?? {}), ...((raw.env_vars as string[]) ?? [])].sort(),
  headers: [...Object.keys((raw.http_headers as object) ?? {}), ...Object.keys((raw.env_http_headers as object) ?? {}), ...(raw.bearer_token_env_var ? ["Authorization"] : [])].sort(),
  enabled: raw.enabled,
});

// Every shape a line reader got wrong: a multi-line args array (H07), comments between items, a `#` and a `[table]`
// inside strings, multi-line basic and literal strings, quoted and dotted keys, inline tables and subtables.
const SHAPES = `
mcp_servers.dotted = { command = "uvx", args = ["dotted-mcp", "--flag"] }

# Bring my setup reads this file as Codex does.
[mcp_servers.multiline]
command = "node" # the launcher
args = [
  "server.js",   # the script
  "--transport",
  "stdio",
]

[mcp_servers."quoted name"]
command = 'npx'
args = ['-y', "@scope/pkg#1", "--label=a # not a comment"]
env = { API_TOKEN = "never-read-1", "QUOTED_KEY" = "never-read-2" }

[mcp_servers.script]
command = "node"
args = ["-e", """
const x = "[mcp_servers.fake]";
console.log(x) # a hash in code
""", '''C:\\literal\\path''']

[mcp_servers.script.env]
SCRIPT_TOKEN = "never-read-3"

[mcp_servers.remote]
url = "https://mcp.example.com/mcp"
bearer_token_env_var = "REMOTE_TOKEN"
http_headers = { "X-Region" = "eu" }
env_http_headers = { "X-Key" = "REMOTE_KEY" }

[mcp_servers.vars]
command = "npx"
args = ["-y", "vars-mcp"]
env_vars = ["LOCAL_TOKEN", { name = "OTHER_TOKEN", source = "local" }]
enabled = false
startup_timeout_sec = 30
`;

describe("Codex config.toml", () => {
  it.skipIf(!hasOracle)("reads every server as an independent TOML reader does (python3 tomllib)", () => {
    const expected = oracle(SHAPES)!.mcp_servers as Record<string, Record<string, unknown>>;
    const servers = readCodexConfig(SHAPES).servers;
    expect(servers.map((s) => s.name).sort()).toEqual(Object.keys(expected).sort());
    for (const server of servers) {
      const want = meaning(expected[server.name]!);
      // env_vars entries as the oracle wrote them may be tables: their names are what the server needs.
      const envVars = ((expected[server.name]!.env_vars as Array<string | { name: string }>) ?? []).map((e) => (typeof e === "string" ? e : e.name));
      expect({ ...server, env: [...server.env].sort(), headers: [...server.headers].sort() }).toEqual(
        Object.fromEntries(
          Object.entries({ name: server.name, ...want, env: [...Object.keys((expected[server.name]!.env as object) ?? {}), ...envVars].sort() }).filter(([, v]) => v !== undefined),
        ),
      );
    }
    // The multi-line array kept every argument, and the fake table inside a string made no server.
    expect(servers.find((s) => s.name === "multiline")?.args).toEqual(["server.js", "--transport", "stdio"]);
    expect(servers.some((s) => s.name === "fake")).toBe(false);
    expect(JSON.stringify(servers)).not.toContain("never-read");
  });

  it("shows a multi-line server's script in setup.scan, cut down as every command line is", () => {
    // The line reader showed "node": its args were gone.
    expect(codexServers(SHAPES, ["codex"]).find((i) => i.name === "multiline")).toMatchObject({ detail: "node server.js …" });
  });

  it("says why a server cannot come over instead of cutting it down", () => {
    const problem = (body: string) => readCodexConfig(`[mcp_servers.s]\ncommand = "node"\n${body}\n`).servers[0]?.problem;
    expect(problem('args = "server.js"')).toBe("its args is not a list of strings");
    expect(problem("args = [1, 2]")).toBe("its args is not a list of strings");
    expect(problem('cwd = "/srv/app"')).toBe("it starts in a folder of its own (cwd), which Caveman Code can't set yet");
    expect(problem('enabled_tools = ["read"]')).toContain("(enabled_tools)");
    expect(problem('disabled_tools = ["delete"]')).toContain("(disabled_tools)");
    expect(problem('[mcp_servers.s.tools.delete]\napproval_mode = "approve"')).toContain("tools.<tool>.approval_mode");
    expect(problem('env_vars = [{ name = "X", source = "remote" }]')).toBe("its env_vars is not a list of variable names");
    expect(readCodexConfig('[mcp_servers.s]\nurl = "https://chatgpt.example/mcp"\nauth = "chatgpt"\n').servers[0]?.problem).toBe("it signs in with your ChatGPT session, which only Codex holds");
    expect(problem("startup_timeout_sec = 30\nrequired = true")).toBeUndefined();
  });

  it("takes nothing from a file that is not TOML, naming the line and never its text", () => {
    const config = readCodexConfig(`[mcp_servers.ok]\ncommand = "node"\n\n[mcp_servers.bad]\ncommand = "node\napi_key = "${SECRET}"\n`);
    expect(config.servers).toEqual([]);
    expect(config.problem).toMatch(/^config\.toml is not valid TOML \(line \d+\), so Codex does not load it either$/);
    expect(config.problem).not.toContain(SECRET);
  });
});
