/**
 * What a Claude Agent session loads beyond the user's own setup: Space plugins
 * (skills, commands, agents, hooks), the MCP servers the credential broker
 * attached, which settings files the CLI reads, and the Spaces' instructions.
 * They reach the CLI as SDK options for that one session (`--plugin-dir`
 * flags, MCP servers over stdin, `--setting-sources`, the appended system
 * prompt), never by writing into the user's `~/.claude`.
 *
 * The runtime's `SessionPlugins` service (engine-core) supplies them per
 * thread; without it a session loads nothing extra.
 *
 * @module provider/ClaudeSessionExtensions
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { McpServerConfig, SdkPluginConfig, SettingSource } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeAgentPluginOptions } from "@caveman-app/engine-core/server/SessionPlugins";
import type { ThreadId } from "@caveman-app/protocol";
import type * as Effect from "effect/Effect";

export interface ClaudeSessionExtensions {
  /**
   * Local plugin directories. `skipMcpDiscovery` keeps the CLI from starting a
   * plugin's `.mcp.json` servers itself when the broker owns them.
   */
  readonly plugins: ReadonlyArray<SdkPluginConfig>;
  /** By server name. Sent over the CLI's stdin, so credentials stay out of argv. */
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  /** Omitted keeps the CLI default (user, project and local settings). */
  readonly settingSources?: ReadonlyArray<SettingSource>;
  /** Appended to the session's system prompt. */
  readonly appendSystemPrompt?: string;
  /** Permission deny rules for the session (the project's hidden paths as `Read(...)`). */
  readonly disallowedTools?: ReadonlyArray<string>;
  /**
   * Set on the CLI over the instance environment. The runtime puts only
   * CLAUDE_ENV_FILE here (`writeClaudeEnvFile`): the workspace's variables
   * reach the commands the CLI runs, not the CLI itself (on a Cloud computer
   * git's settings too, `claudeEnvSplit`).
   */
  readonly env?: Readonly<Record<string, string>>;
  /** Flag settings for the session (memory: Claude's auto-memory pointed at the session's copy). */
  readonly sdkSettings?: Readonly<Record<string, unknown>>;
  /** SDK hook callbacks by event, added to the adapter's own (memory's ingest and subagent refusal). */
  readonly hooks?: Readonly<Record<string, ReadonlyArray<unknown>>>;
}

export const NO_CLAUDE_SESSION_EXTENSIONS: ClaudeSessionExtensions = {
  plugins: [],
  mcpServers: {},
};

export type ClaudeSessionExtensionsResolverShape = (input: {
  readonly threadId: ThreadId;
  readonly cwd: string | null;
}) => Effect.Effect<ClaudeSessionExtensions>;

/**
 * Claude's SDK has no per-server `cwd` for stdio servers; the CLI starts them
 * in the session's directory, so a plugin server that needs its own directory
 * gets it from its launcher command.
 */
export function claudeSessionExtensionsFromPlugins(
  options: ClaudeAgentPluginOptions,
  env: Readonly<Record<string, string>> = {},
): ClaudeSessionExtensions {
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, server] of Object.entries(options.mcpServers)) {
    mcpServers[name] =
      server.type === "stdio"
        ? { type: "stdio", command: server.command, args: [...server.args], env: { ...server.env } }
        : { type: server.type, url: server.url, headers: { ...server.headers } };
  }
  return {
    plugins: options.plugins.map((plugin) => ({ ...plugin })),
    mcpServers,
    settingSources: [...options.settingSources],
    ...(options.appendSystemPrompt.length === 0
      ? {}
      : { appendSystemPrompt: options.appendSystemPrompt }),
    ...(options.disallowedTools === undefined || options.disallowedTools.length === 0
      ? {}
      : { disallowedTools: [...options.disallowedTools] }),
    ...(Object.keys(env).length === 0 ? {} : { env: { ...env } }),
    ...(options.sdkSettings === undefined ? {} : { sdkSettings: options.sdkSettings }),
    ...(options.hooks === undefined ? {} : { hooks: options.hooks }),
  };
}

/**
 * Identifies the launch flags a live CLI process was opened with; a different
 * set needs a new process. MCP servers are already part of the query policy key.
 */
export function claudeSessionExtensionsKey(extensions: ClaudeSessionExtensions): string {
  return JSON.stringify({
    plugins: extensions.plugins,
    settingSources: extensions.settingSources,
    appendSystemPrompt: extensions.appendSystemPrompt,
    disallowedTools: extensions.disallowedTools,
    env: extensions.env,
    sdkSettings: extensions.sdkSettings,
  });
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * A session's env for Claude: all of it goes to the CLI's commands through CLAUDE_ENV_FILE, except on a Cloud
 * computer, where the CLI runs in the tools container, which cannot read that file's directory: git's own settings
 * (GIT_CONFIG_*, the runtime's commit hooks) go on the CLI there. They steer no login, endpoint or launch.
 */
export function claudeEnvSplit(env: Readonly<Record<string, string>>, cloud: boolean): { readonly cli: Record<string, string>; readonly file: Record<string, string> } {
  const cli: Record<string, string> = {};
  const file: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) (cloud && name.startsWith("GIT_CONFIG_") ? cli : file)[name] = value;
  return { cli, file };
}
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * The workspace's variables (CAVEMAN_PORT_*, computer.toml [env]) as a script
 * of `export` lines the CLI runs before each Bash command (CLAUDE_ENV_FILE),
 * so its commands see them and the CLI itself does not: none of them can steer
 * its login, endpoint or launch. One 0600 file per content under `dir` (a new
 * content is a new path, so a live CLI with the old one is replaced).
 * Undefined when there is nothing to export.
 */
export async function writeClaudeEnvFile(
  dir: string,
  env: Readonly<Record<string, string>>,
): Promise<string | undefined> {
  const script = Object.entries(env)
    .filter(([name]) => ENV_NAME.test(name))
    .map(([name, value]) => `export ${name}=${shellQuote(value)}\n`)
    .join("");
  if (script === "") return undefined;
  // ponytail: one small file per distinct [env], never pruned; sweep at startup if they pile up.
  const file = path.join(dir, `${createHash("sha256").update(script).digest("hex").slice(0, 32)}.sh`);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, script, { mode: 0o600, flag: "wx" });
  await fs.rename(tmp, file);
  return file;
}
