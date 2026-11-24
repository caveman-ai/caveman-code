// setup.scan, for first run's "Bring my setup": the MCP servers and skills the
// user already set up for Claude Code and Codex, and the repository's
// instruction files, with the engines that load each by themselves today.
//
// Names, commands and addresses only. Environment values, headers and auth
// files are never read into the result: an MCP server's env is reported as the
// variable names it expects, and its args and URL are cut down (commandLine).
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { SetupItem } from "@caveman-app/session-protocol";
import { parse as parseToml, TomlError } from "smol-toml";

type Engines = SetupItem["loaded_by"];

export interface SetupHomes {
  /** Claude Code's user config file (user- and local-scope MCP servers). */
  readonly claudeJson: string;
  /** Claude Code's config directory (skills/). */
  readonly claudeDir: string;
  /** Codex's home (config.toml, skills/). */
  readonly codexHome: string;
}

/** Where Claude Code and Codex keep their config, honouring CLAUDE_CONFIG_DIR and CODEX_HOME as they do. */
export function setupHomes(env: NodeJS.ProcessEnv, home: string): SetupHomes {
  const claudeDir = env.CLAUDE_CONFIG_DIR || path.join(home, ".claude");
  return {
    claudeJson: env.CLAUDE_CONFIG_DIR ? path.join(env.CLAUDE_CONFIG_DIR, ".claude.json") : path.join(home, ".claude.json"),
    claudeDir,
    codexHome: env.CODEX_HOME || path.join(home, ".codex"),
  };
}

export interface ScanOptions {
  readonly repoPath?: string;
 /** Codex runs on the user's own home (their compact login) rather than a managed one, so it reads their config.toml. */
  readonly codexOwnHome: boolean;
}

const readText = (file: string) => fs.readFile(file, "utf8").catch(() => undefined);

// Shown, never run. Credentials often sit in a server's args or URL (a postgres:// password, a key in a Zapier
// path or a ?api_key= query, `--header "Authorization: Bearer …"`), so the result keeps only the command, its
// leading bare flags and its first argument (the package or script), and a URL's host and path, with anything
// key-like masked. ponytail: a heuristic for display; the import (W7) reads the config itself, never this.
const MASK = "…";
export const KEYLIKE = /^(?=.*\d)(?=.*[A-Za-z])[\w.~+=-]{20,}$/;
export const KEY_FLAG = /key|token|secret|pass|auth|header|bearer|cred/i;

export function shownUrl(raw: string): string {
  try {
    const url = new URL(raw);
    const segments = url.pathname.split("/").map((s) => (KEYLIKE.test(decodeURIComponent(s)) ? MASK : s));
    return `${url.protocol}//${url.host}${segments.join("/")}`;
  } catch {
    return MASK;
  }
}

export function commandLine(command: unknown, args: unknown): string {
  if (typeof command !== "string" || !command) return "";
  const list = (Array.isArray(args) ? args : []).filter((a): a is string => typeof a === "string");
  const shown: string[] = [command];
  for (const arg of list) {
    if (/^-[\w-]*$/.test(arg) && !KEY_FLAG.test(arg)) {
      shown.push(arg);
      continue;
    }
    if (!arg.startsWith("-")) shown.push(/^[a-z][a-z0-9+.-]*:\/\//i.test(arg) ? shownUrl(arg) : KEYLIKE.test(arg) ? MASK : arg);
    break;
  }
  return shown.length - 1 < list.length ? `${shown.join(" ")} ${MASK}` : shown.join(" ");
}

/** One Claude `mcpServers` map: stdio ({command, args, env}) or remote ({type, url, headers}). */
function claudeServers(servers: unknown, loaded: Engines): SetupItem[] {
  if (!servers || typeof servers !== "object") return [];
  return Object.entries(servers as Record<string, Record<string, unknown>>).flatMap(([name, entry]) => {
    if (!entry || typeof entry !== "object") return [];
    const detail = typeof entry.url === "string" ? shownUrl(entry.url) : commandLine(entry.command, entry.args);
    if (!detail) return [];
    const env = entry.env && typeof entry.env === "object" ? Object.keys(entry.env) : [];
    return [{ kind: "mcp_server" as const, name, source: "claude" as const, detail, ...(env.length ? { env } : {}), loaded_by: loaded }];
  });
}

/** One Codex `[mcp_servers.<name>]` table as written: values for command, args and url; names only for env and headers. */
export interface CodexServer {
  readonly name: string;
  readonly command?: string;
  readonly args?: ReadonlyArray<string>;
  readonly url?: string;
  /** Names from `env` and `env_vars`; never a value. */
  readonly env: ReadonlySet<string>;
  /** Header names: `http_headers`/`env_http_headers` keys, and Authorization for `bearer_token_env_var`. */
  readonly headers: ReadonlySet<string>;
  /** `enabled = false`: Codex keeps it but leaves it off. */
  readonly enabled?: boolean;
  /** Why it cannot come over as Codex runs it: a setting Caveman Code cannot carry, or a value of the wrong type. */
  readonly problem?: string;
}

/** Codex's config.toml as TOML 1.0 reads it. */
export interface CodexConfig {
  readonly servers: ReadonlyArray<CodexServer>;
  /** `[marketplaces.<name>]` tables, as written. */
  readonly marketplaces: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** `[plugins."<id>"]` tables, as written. */
  readonly plugins: ReadonlyMap<string, Readonly<Record<string, unknown>>>;
  /** Not TOML: nothing is taken from it, as Codex refuses the whole file. Names the line, never its text. */
  readonly problem?: string;
}

const isTable = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);
const tables = (value: unknown) => new Map(isTable(value) ? Object.entries(value).filter((entry): entry is [string, Record<string, unknown>] => isTable(entry[1])) : []);
const strings = (value: unknown): value is ReadonlyArray<string> => Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * Settings Caveman Code cannot carry, where dropping one would run the server differently from Codex or with
 * less care (docs: learn.compact.com/docs/extend/mcp, read 2026-10-22). Timeouts, `required`, `scopes` and
 * a tool's `output_token_limit` change neither and are not carried.
 */
const UNCARRIED: ReadonlyArray<readonly [string, string]> = [
  ["cwd", "it starts in a folder of its own (cwd), which Caveman Code can't set yet"],
  ["experimental_environment", "it starts in Codex's remote environment, which only Codex has"],
  ["http_headers_helper", "a command on this computer makes its headers (http_headers_helper), which Caveman Code can't run yet"],
  ["oauth", "it signs in with an OAuth client of its own (oauth), which Caveman Code can't use yet"],
  ["enabled_tools", "Codex gives it only some of its tools (enabled_tools); here it would get all of them"],
  ["disabled_tools", "Codex hides some of its tools (disabled_tools); here it would show all of them"],
  ["default_tools_approval_mode", "Codex sets how its tools are approved (default_tools_approval_mode), which Caveman Code can't carry yet"],
];

function codexServer(name: string, raw: unknown): CodexServer {
  const env = new Set<string>();
  const headers = new Set<string>();
  if (!isTable(raw)) return { name, env, headers, problem: "it is not a table" };
  const wrong = (key: string, kind: string) => ({ name, env, headers, problem: `its ${key} is not ${kind}` });
  const { command, args, url, enabled } = raw;
  if (command !== undefined && typeof command !== "string") return wrong("command", "a string");
  if (args !== undefined && !strings(args)) return wrong("args", "a list of strings");
  if (url !== undefined && typeof url !== "string") return wrong("url", "a string");
  if (enabled !== undefined && typeof enabled !== "boolean") return wrong("enabled", "true or false");
  for (const key of ["env", "http_headers", "env_http_headers"] as const) if (raw[key] !== undefined && !isTable(raw[key])) return wrong(key, "a table");
  for (const key of Object.keys(isTable(raw.env) ? raw.env : {})) env.add(key);
  if (raw.env_vars !== undefined) {
    if (!Array.isArray(raw.env_vars)) return wrong("env_vars", "a list");
    for (const entry of raw.env_vars) {
      // A name, or {name, source}; a `remote` source is read on Codex's remote executor, which this is not.
      const named = typeof entry === "string" ? entry : isTable(entry) && typeof entry.name === "string" && (entry.source ?? "local") === "local" ? entry.name : undefined;
      if (named === undefined) return wrong("env_vars", "a list of variable names");
      env.add(named);
    }
  }
  for (const key of [...Object.keys(isTable(raw.http_headers) ? raw.http_headers : {}), ...Object.keys(isTable(raw.env_http_headers) ? raw.env_http_headers : {})]) headers.add(key);
  if (raw.bearer_token_env_var !== undefined) headers.add("Authorization");
  const server = {
    name,
    ...(command === undefined ? {} : { command }),
    ...(args === undefined ? {} : { args }),
    ...(url === undefined ? {} : { url }),
    env,
    headers,
    ...(enabled === undefined ? {} : { enabled }),
  };
  const uncarried = UNCARRIED.find(([key]) => raw[key] !== undefined)?.[1];
  if (uncarried !== undefined) return { ...server, problem: uncarried };
  if (raw.auth === "chatgpt") return { ...server, problem: "it signs in with your ChatGPT session, which only Codex holds" };
  const perTool = Object.values(isTable(raw.tools) ? raw.tools : {}).some((tool) => isTable(tool) && tool.approval_mode !== undefined);
  if (perTool) return { ...server, problem: "Codex sets how some of its tools are approved (tools.<tool>.approval_mode), which Caveman Code can't carry yet" };
  return server;
}

/**
 * Codex's config.toml: its MCP servers, marketplaces and plugins, read by a TOML 1.0 parser (smol-toml), so
 * a multi-line array, a quoted or dotted key, an inline table or a `#` inside a string means what it means to
 * Codex. A server whose settings cannot come over says why instead of arriving cut down.
 */
export function readCodexConfig(text: string): CodexConfig {
  let config: Record<string, unknown>;
  try {
    config = parseToml(text);
  } catch (cause) {
    // TomlError's message quotes the file's lines, which can hold values: only the line number is kept.
    const line = cause instanceof TomlError ? ` (line ${cause.line})` : "";
    return { servers: [], marketplaces: new Map(), plugins: new Map(), problem: `config.toml is not valid TOML${line}, so Codex does not load it either` };
  }
  const servers = isTable(config.mcp_servers) ? Object.entries(config.mcp_servers).map(([name, raw]) => codexServer(name, raw)) : [];
  // A `_default` table names no marketplace or plugin.
  const [marketplaces, plugins] = [tables(config.marketplaces), tables(config.plugins)];
  marketplaces.delete("_default");
  plugins.delete("_default");
  return { servers, marketplaces, plugins };
}

/** Codex's `[mcp_servers.<name>]` tables (readCodexConfig's servers). */
export const parseCodexServers = (toml: string): ReadonlyArray<CodexServer> => readCodexConfig(toml).servers;

/** Codex's MCP servers for setup.scan: names, a cut-down command line or URL, and env names. */
export function codexServers(toml: string, loaded: Engines): SetupItem[] {
  return parseCodexServers(toml).flatMap((s) => {
    const detail = s.url !== undefined ? shownUrl(s.url) : commandLine(s.command, s.args);
    if (!detail) return [];
    return [{ kind: "mcp_server" as const, name: s.name, source: "codex" as const, detail, ...(s.env.size ? { env: [...s.env] } : {}), loaded_by: loaded }];
  });
}

/** Skill folders (each with a SKILL.md) directly under `dir`. */
async function skills(dir: string, source: "claude" | "codex", loaded: Engines): Promise<SetupItem[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((e) => e.isDirectory() || e.isSymbolicLink())
      .map(async (e) => {
        const skillDir = path.join(dir, e.name);
        const ok = await fs.access(path.join(skillDir, "SKILL.md")).then(() => true, () => false);
        return ok ? [{ kind: "skill" as const, name: e.name, source, detail: skillDir, loaded_by: loaded }] : [];
      }),
  );
  return found.flat().sort((a, b) => a.name.localeCompare(b.name));
}

export async function scanSetup(homes: SetupHomes, options: ScanOptions): Promise<SetupItem[]> {
  const claude: Engines = ["claude-agent"];
  // An API-key Codex runs in a home Caveman Code manages and never reads ~/.codex.
  const codex: Engines = options.codexOwnHome ? ["codex"] : [];
  const items: SetupItem[] = [];

  const claudeJson = await readText(homes.claudeJson);
  let claudeConfig: { mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> } = {};
  try {
    claudeConfig = claudeJson ? JSON.parse(claudeJson) : {};
  } catch {
    // A config Claude Code is midway through writing: report nothing from it.
  }
  items.push(...claudeServers(claudeConfig.mcpServers, claude));
  if (options.repoPath) {
    // Local scope (this repo, in ~/.claude.json), then project scope (the repo's .mcp.json).
    items.push(...claudeServers(claudeConfig.projects?.[options.repoPath]?.mcpServers, claude));
    const project = await readText(path.join(options.repoPath, ".mcp.json"));
    try {
      if (project) items.push(...claudeServers((JSON.parse(project) as { mcpServers?: unknown }).mcpServers, claude));
    } catch {
      // Not JSON: Claude Code would not load it either.
    }
  }
  items.push(...(await skills(path.join(homes.claudeDir, "skills"), "claude", claude)));

  const toml = await readText(path.join(homes.codexHome, "config.toml"));
  if (toml) items.push(...codexServers(toml, codex));
  items.push(...(await skills(path.join(homes.codexHome, "skills"), "codex", codex)));

  if (options.repoPath) {
    // Each CLI reads its own file natively; the Caveman engine is given AGENTS.md, else CLAUDE.md
    // (instructions/EngineInstructions.ts), and Codex is told the same fallback (CODEX_THREAD_CONFIG).
    // Both are shown so the user sees what the repo says.
    const found = async (file: string) => ((at) => fs.access(at).then(() => at, () => undefined))(path.join(options.repoPath!, file));
    const agents = await found("AGENTS.md");
    const claudeMd = await found("CLAUDE.md");
    if (agents) items.push({ kind: "instructions", name: "AGENTS.md", source: "repo", detail: agents, loaded_by: ["caveman", "codex"] });
    if (claudeMd) items.push({ kind: "instructions", name: "CLAUDE.md", source: "repo", detail: claudeMd, loaded_by: agents ? ["claude-agent"] : ["caveman", "claude-agent", "codex"] });
  }
  // The same server listed twice (user and project scope) shows once.
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = `${item.kind}:${item.source}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
