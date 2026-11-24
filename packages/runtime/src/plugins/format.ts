/**
 * The on-disk formats a plugin is made of. They follow Claude Code's and
 * Codex's plugin formats so one plugin works in every engine: a manifest
 * (root `plugin.json` in the agent-plugins format, `.codex-plugin/`,
 * `.claude-plugin/` or `.cursor-plugin/plugin.json`, merged in that order),
 * `skills/`, `commands/`, `agents/`, `hooks/hooks.json`, `.mcp.json`,
 * `.lsp.json`, `monitors/monitors.json`, and marketplaces
 * (`marketplace.json` under `.agents/plugins/`, `.claude-plugin/` or
 * `.cursor-plugin/`). Additions of ours, ignored by Claude Code and Codex:
 * `rules/*.md` (always-on instructions), the manifest's `contributes`
 * section (app tools, connectors and panels), and an MCP server's `auth`
 * (how the runtime's hub signs in to it) and `unavailable` (why it cannot).
 *
 * Unknown keys are ignored, as Claude Code does.
 *
 * @module plugins/format
 */
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

/** Used in ids and paths: no separators, no leading dot. */
export const PluginName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/));

const PathOrPaths = Schema.Union([Schema.String, Schema.Array(Schema.String)]);

/** An environment variable name. Anything else could smuggle extra names past the launcher. */
export const EnvName = Schema.String.check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_]*$/));

export const McpStdioServer = Schema.Struct({
  type: Schema.optionalKey(Schema.Literal("stdio")),
  command: Schema.String,
  args: Schema.optionalKey(Schema.Array(Schema.String)),
  env: Schema.optionalKey(Schema.Record(EnvName, Schema.String)),
  cwd: Schema.optionalKey(Schema.String),
});
export const McpRemoteServer = Schema.Struct({
  type: Schema.Literals(["http", "sse"]),
  url: Schema.String,
  headers: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  /** Ours: `oauth` signs in through the runtime's hub (DCR + PKCE, or a Caveman Cloud lease); `github` takes the GitHub login. */
  auth: Schema.optionalKey(Schema.Literals(["oauth", "github"])),
  /** Ours: why Connect is off for it (no registered client for the service yet). */
  unavailable: Schema.optionalKey(Schema.String),
});
export const McpServerConfig = Schema.Union([McpRemoteServer, McpStdioServer]);

/**
 * `caveman.json` beside a plugin's standard files: what only Caveman reads,
 * kept out of `.mcp.json` so the plugin stays a valid Claude Code and Codex
 * plugin. Per remote MCP server: how it signs in, why Connect is off, a note.
 */
export const CavemanSidecar = Schema.Struct({
  mcpServers: Schema.optionalKey(
    Schema.Record(
      Schema.String,
      Schema.Struct({
        auth: Schema.optionalKey(Schema.Literals(["oauth", "github"])),
        unavailable: Schema.optionalKey(Schema.String),
        note: Schema.optionalKey(Schema.String),
      }),
    ),
  ),
});
export type McpServerConfig = typeof McpServerConfig.Type;
export const McpServers = Schema.Record(Schema.String, McpServerConfig);

/** One hook. Fields we do not name (once, async, statusMessage, ...) are kept for Claude. */
export const HookCommand = Schema.StructWithRest(
  Schema.Struct({
    type: Schema.String,
    command: Schema.optionalKey(Schema.String),
    /** Exec form: argv for `command`, no shell. */
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    prompt: Schema.optionalKey(Schema.String),
    timeout: Schema.optionalKey(Schema.Number),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type HookCommand = typeof HookCommand.Type;
/** Hook types the runtime can contain. An http hook would send session data wherever it points. */
export const CONTAINED_HOOK_TYPES: ReadonlySet<string> = new Set(["command", "prompt", "agent"]);
export const HookMatcher = Schema.Struct({
  matcher: Schema.optionalKey(Schema.String),
  hooks: Schema.Array(HookCommand),
});
/** Event name (PreToolUse, SessionStart, ...) to matchers. */
export const Hooks = Schema.Record(Schema.String, Schema.Array(HookMatcher));
export type Hooks = typeof Hooks.Type;
export const HooksFile = Schema.Struct({ hooks: Hooks });

/** An LSP server from `.lsp.json`. Fields we do not name (extensionToLanguage, transport, ...) are kept for Claude. */
export const LspServer = Schema.StructWithRest(
  Schema.Struct({
    command: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    env: Schema.optionalKey(Schema.Record(EnvName, Schema.String)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type LspServer = typeof LspServer.Type;
export const LspServers = Schema.Record(Schema.String, LspServer);

/** A monitor from `monitors/monitors.json`: a background shell command Claude arms as a Monitor task. */
export const Monitor = Schema.StructWithRest(
  Schema.Struct({ name: Schema.String, command: Schema.String }),
  [Schema.Record(Schema.String, Schema.Unknown)],
);
export type Monitor = typeof Monitor.Type;
export const Monitors = Schema.Array(Monitor);

/** App extension points (ours). */
export const Contributes = Schema.Struct({
  /** Tools the plugin's MCP servers offer that the app lists in its tool palette. */
  tools: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        name: Schema.String,
        title: Schema.optionalKey(Schema.String),
        description: Schema.optionalKey(Schema.String),
        /** The plugin MCP server that serves it. */
        server: Schema.String,
      }),
    ),
  ),
  /** Services the plugin reaches. `credentials` are names the broker must supply. */
  connectors: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        description: Schema.optionalKey(Schema.String),
        server: Schema.optionalKey(Schema.String),
        credentials: Schema.optionalKey(Schema.Array(Schema.String)),
      }),
    ),
  ),
  /** Session Protocol `PanelContribution`s; validated against it when listed. */
  panels: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        title: Schema.String,
        placement: Schema.Literals(["workspace_tab", "settings"]),
        entry: Schema.String,
      }),
    ),
  ),
});
export type Contributes = typeof Contributes.Type;

/** A hooks config as Claude Code takes one in plugin.json: a path, `{ hooks }`, or the event map itself. */
const HooksSource = Schema.Union([Schema.String, HooksFile, Hooks]);
/** An MCP config as Claude Code takes one in plugin.json: a path or the server map. */
const McpSource = Schema.Union([Schema.String, McpServers]);

const ManifestFields = {
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
  /** Paths, or Claude Code's map of command name to `{ source, description, ... }` (read in load.ts). */
  commands: Schema.optionalKey(Schema.Union([PathOrPaths, Schema.Record(Schema.String, Schema.Unknown)])),
  agents: Schema.optionalKey(PathOrPaths),
  skills: Schema.optionalKey(PathOrPaths),
  /** One source or a list of them, as Claude Code documents (plugins-reference). */
  hooks: Schema.optionalKey(Schema.Union([HooksSource, Schema.Array(HooksSource)])),
  mcpServers: Schema.optionalKey(Schema.Union([McpSource, Schema.Array(McpSource)])),
  /** A path or inline servers (read in load.ts; other forms are left out with a problem line). */
  lspServers: Schema.optionalKey(Schema.Unknown),
  /** A path or an inline list; replaces monitors/monitors.json, as in Claude Code. */
  monitors: Schema.optionalKey(Schema.Unknown),
  contributes: Schema.optionalKey(Contributes),
  /** Shown in the marketplace; any shape is read (Claude's `author` is `{ name }`), a bad one ignored. */
  author: Schema.optionalKey(Schema.Unknown),
  homepage: Schema.optionalKey(Schema.Unknown),
  keywords: Schema.optionalKey(Schema.Unknown),
  license: Schema.optionalKey(Schema.Unknown),
  category: Schema.optionalKey(Schema.Unknown),
  /** Codex's presentation block (displayName, shortDescription, logo, ...); read by `pluginInterface`. */
  interface: Schema.optionalKey(Schema.Unknown),
};

/** Manifest fields only the marketplace reads: they change nothing that runs, and engines are not given them. */
export const DISPLAY_FIELDS = ["author", "homepage", "keywords", "license", "category", "interface"] as const;

export const PluginManifest = Schema.Struct({ name: PluginName, ...ManifestFields });
export type PluginManifest = typeof PluginManifest.Type;

/**
 * Where a marketplace entry's plugin is: a `./path` in the marketplace, or
 * elsewhere (`local`, `url`/`github`/`git-subdir` git sources, `npm`), read
 * by `entrySource`.
 */
export const EntrySource = Schema.Union([
  Schema.String,
  Schema.StructWithRest(Schema.Struct({ source: Schema.String }), [Schema.Record(Schema.String, Schema.Unknown)]),
]);
export type EntrySource = typeof EntrySource.Type;

export const MarketplaceEntry = Schema.Struct({
  name: PluginName,
  source: EntrySource,
  /** false: this entry is the whole manifest and plugin.json is optional. */
  strict: Schema.optionalKey(Schema.Boolean),
  /** Codex: `installation` AVAILABLE | INSTALLED_BY_DEFAULT | NOT_AVAILABLE, `authentication` ON_INSTALL | ON_USE. */
  policy: Schema.optionalKey(Schema.Unknown),
  ...ManifestFields,
});
export type MarketplaceEntry = typeof MarketplaceEntry.Type;

export const Marketplace = Schema.Struct({
  name: PluginName,
  metadata: Schema.optionalKey(Schema.Struct({ pluginRoot: Schema.optionalKey(Schema.String), description: Schema.optionalKey(Schema.String) })),
  interface: Schema.optionalKey(Schema.Struct({ displayName: Schema.optionalKey(Schema.String) })),
  plugins: Schema.Array(MarketplaceEntry),
});
export type Marketplace = typeof Marketplace.Type;

/** `.mcp.json` with or without the `mcpServers` wrapper, as Claude Code reads it. */
export function decodeMcpFile(json: unknown): Record<string, McpServerConfig> {
  const inner =
    typeof json === "object" && json !== null && "mcpServers" in json
      ? (json as { mcpServers: unknown }).mcpServers
      : json;
  return Schema.decodeUnknownSync(McpServers)(inner);
}

/**
 * Frontmatter as Claude Code (2.1.319) finds it, after a BOM: `---` and any blanks after it, then everything up to the
 * first `---`, wherever on a line that stands. A block this matches is one Claude reads, hooks and all.
 */
const FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/;
/** YAML as Claude's parser (Bun's) reads it: merge keys merged, a repeated key's last value kept. */
const YAML_AS_CLAUDE = { merge: true, uniqueKeys: false } as const;
/** A plain value Claude quotes before it reads a block YAML refused a second time. */
const NEEDS_QUOTES = /[{}[\]*&#!|>%@`]|: /;

const readYaml = (text: string): { readonly value: unknown } | undefined => {
  try {
    return { value: parseYaml(text, YAML_AS_CLAUDE) };
  } catch {
    return undefined;
  }
};

/** Claude's second reading of a block YAML refused: plain values holding YAML syntax quoted, tab indents as spaces. */
function requoted(block: string): string {
  return block
    .split("\n")
    .map((line) => {
      const match = /^([a-zA-Z_-]+):\s+(\S.*)$/.exec(line);
      if (match === null) return line;
      const key = match[1]!;
      const value = match[2]!;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return line;
      if (value.startsWith("[") && value.endsWith("]") && Array.isArray(readYaml(value)?.value)) return line;
      return NEEDS_QUOTES.test(value) ? `${key}: "${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"` : line;
    })
    .join("\n")
    .replace(/^\t+/gm, (tabs) => "  ".repeat(tabs.length));
}

/**
 * The frontmatter block of a SKILL.md, command or agent file as Claude finds it, what Claude's YAML reading makes of it
 * (`parsed` undefined when it does not parse), and the body after it; undefined when the file has none.
 */
export function findFrontmatter(markdown: string):
  | { readonly block: string; readonly parsed: { readonly value: unknown } | undefined; readonly body: string }
  | undefined {
  const text = markdown.charCodeAt(0) === 0xfeff ? markdown.slice(1) : markdown;
  const match = FRONTMATTER.exec(text);
  if (match === null) return undefined;
  const block = match[1]!;
  return { block, parsed: readYaml(block) ?? readYaml(requoted(block)), body: text.slice(match[0].length) };
}

/** YAML frontmatter of a SKILL.md, command or agent file, as Claude reads it; `{}` when absent, malformed or not a table. */
export function parseFrontmatter(markdown: string): {
  readonly data: Record<string, unknown>;
  readonly body: string;
} {
  const found = findFrontmatter(markdown);
  if (found === undefined) return { data: {}, body: markdown };
  const value = found.parsed?.value;
  return {
    data: typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {},
    body: found.body,
  };
}
