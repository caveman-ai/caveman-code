/**
 * EngineEgress - what an engine process gets for its project's secrets:
 * the values in its environment (so its bash and the repo's own MCP servers
 * see them) and its model traffic pointed at the egress scrub (so their
 * values never reach the provider). Always routed, secrets or not, so a
 * secret added mid-session changes nothing about routing.
 *
 * Claude Agent: `ANTHROPIC_BASE_URL`, in the process env and in the SDK's
 * flag settings (which outrank `~/.claude/settings.json`, where a Caveman
 * proxy install puts its own). Works for API keys and claude.ai logins alike:
 * the CLI sends its own credentials, the proxy only forwards them.
 *
 * Codex: a model provider whose `base_url` is the scrub, with WebSockets off
 * (Codex's built-in OpenAI provider opens a Responses WebSocket that a body
 * scrub cannot see). The built-in provider is replaced by one named "OpenAI"
 * so Codex keeps its OpenAI behaviour; a user's own provider keeps every
 * field except `base_url`, which chains to theirs.
 *
 * OpenCode 2: its server's OPENCODE_CONFIG points the Anthropic and OpenAI
 * providers at the app's caveman-proxy through the scrub, over HTTP. A provider
 * the person configured anywhere keeps
 * its own setup (openCodeRouting). OpenCode gets no project secrets: it is not routed for every
 * provider it can run.
 *
 * Bedrock, Vertex and Codex's local or AWS providers sign or route requests in
 * ways a body rewrite cannot follow: with a secret in the project the engine
 * does not start.
 *
 * Spec: docs/
 *
 * @module EngineEgress
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { randomUUID } from "node:crypto";

import { isHiddenSecret, isReservedEnvName, type SecretEntry } from "@caveman-app/session-protocol";
import type * as CodexAppServerClient from "@caveman-app/codex-app-server/client";
import { CodexAppServerRequestError } from "@caveman-app/codex-app-server/errors";
import { tokenizeCliArgs } from "@caveman-app/shared/cliArgs";
import { ProviderDriverKind, type ThreadId } from "@caveman-app/protocol";
import * as OpenCodeRuntime from "@caveman-app/provider-opencode/server/OpenCodeRuntime";
import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { fromLenientJson } from "@caveman-app/shared/schemaJson";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { PERSONAL_PROXY_URL, proxySession, ROUTER_SESSION_HEADER, withCustomHeader } from "../router/cavemanRouter.ts";
import { appProxyUrl, codexProxyUrl } from "../router/proxyLauncher.ts";
import { holdsCloudStandIn } from "../cloudLink/engineKeys.ts";

import { SECRET_NAMES_ENV } from "../git/coAuthorHooks.ts";
import { ANTHROPIC_VIA_PROXY, CODEX_VIA_PROXY, OPENAI_AUTO_UPSTREAM, OPENAI_VIA_PROXY } from "./EgressScrub.ts";

type Env = NodeJS.ProcessEnv;

/** What routing needs from the egress scrub. */
export interface Egress {
  readonly route: (upstream: string) => string | undefined;
  readonly owns: (url: string) => boolean;
}

/**
 * Secrets an engine process may get: every one but the names the engine itself uses, and the names of the
 * hidden ones (SECRET_NAMES_ENV) for the runtime's git hooks, which refuse a commit or push adding their values.
 */
export const engineSecretEnv = (secrets: ReadonlyArray<SecretEntry>): Record<string, string> => {
  const allowed = secrets.filter(({ name }) => !isReservedEnvName(name, "engine"));
  const hidden = allowed.filter(({ name, value }) => isHiddenSecret(name, value)).map(({ name }) => name);
  return {
    ...Object.fromEntries(allowed.map(({ name, value }) => [name, value])),
    ...(hidden.length === 0 ? {} : { [SECRET_NAMES_ENV]: hidden.join(" ") }),
  };
};

/** Keeps a configured HTTP(S) proxy from catching loopback traffic to the scrub. */
export const loopbackNoProxy = (env: Env): Record<string, string> => {
  if (![env.HTTPS_PROXY, env.https_proxy, env.HTTP_PROXY, env.http_proxy, env.ALL_PROXY, env.all_proxy].some(Boolean)) {
    return {};
  }
  const add = (current: string | undefined) =>
    current === undefined || current === "" ? "127.0.0.1,localhost" : `${current},127.0.0.1,localhost`;
  return { NO_PROXY: add(env.NO_PROXY), no_proxy: add(env.no_proxy) };
};

export const unroutableMessage = (engine: string, why: string) =>
  `This project has secrets, and ${engine} cannot start without the egress scrub that keeps them from the model (${why}).`;

export const startedUnroutedMessage = (engine: string) =>
  `This project has secrets now, and this ${engine} session started without the egress scrub that keeps them from the model. Start a new session.`;

// ── Claude Agent ──────────────────────────────────────────────

type ClaudeOptions = ClaudeAdapterV2.ClaudeAgentSdkQueryOptions;
type SettingSource = "user" | "project" | "local";

const readJsonEnv = (file: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(NodeFS.readFileSync(file, "utf8"));
    const env = typeof parsed === "object" && parsed !== null ? (parsed as { env?: unknown }).env : undefined;
    return typeof env === "object" && env !== null ? (env as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const CLAUDE_SETTINGS_ROUTING_ENV = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
] as const;

/**
 * The `env` block of the settings files the CLI will load, later ones winning
 * (user, project, local). Read for the upstream base URL, provider switches
 * custom headers and proxy variables only; nothing else is kept.
 */
export function claudeSettingsEnv(input: {
  readonly configDir: string;
  readonly cwd: string | undefined;
  readonly sources: ReadonlyArray<SettingSource>;
}): Record<string, string> {
  const files: Array<[SettingSource, string]> = [["user", NodePath.join(input.configDir, "settings.json")]];
  if (input.cwd !== undefined) {
    files.push(["project", NodePath.join(input.cwd, ".claude", "settings.json")]);
    files.push(["local", NodePath.join(input.cwd, ".claude", "settings.local.json")]);
  }
  const out: Record<string, string> = {};
  for (const [source, file] of files) {
    if (!input.sources.includes(source)) continue;
    const env = readJsonEnv(file);
    for (const name of [...CLAUDE_SETTINGS_ROUTING_ENV]) {
      const value = env[name];
      if (typeof value === "string") out[name] = value;
    }
  }
  return out;
}

const truthy = (value: string | undefined) => value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
};

/**
 * The app's chats run through the app's own caveman-proxy (founder ruling
 * 2026-10-17) wherever they would reach the provider's own API, or the
 * person's own proxy (`caveman start`, whose mode is theirs): it records usage,
 * keeps the chosen model, and routes only Auto. Any other endpoint (a
 * company gateway, a cloud lane) is left as it is.
 */
const viaAppProxy = (upstream: string, providerHost: string) =>
  upstream === OPENAI_AUTO_UPSTREAM || originOf(upstream) === originOf(PERSONAL_PROXY_URL) || (() => {
    try {
      return new URL(upstream).hostname === providerHost;
    } catch {
      return false;
    }
  })();

/**
 * The server name v4's proxy counts as a way back: `mcp__caveman__caveman_retrieve` (and OpenCode's
 * `caveman_caveman_retrieve`). The app hands no engine one of its own since compression left (README.md).
 */
export const RETRIEVE_MCP_SERVER = "caveman";
/** Claude Code's name for it: the proxy compresses a Claude request only when it carries this tool. */
export const CLAUDE_RETRIEVE_TOOL = `mcp__${RETRIEVE_MCP_SERVER}__caveman_retrieve`;

/** Applies to initial options and every live replacement: the SDK replaces the entire dynamic server set. */
function routeClaudeMcpOptions(options: ClaudeOptions, secrets: ReadonlyArray<SecretEntry>, viaProxy: boolean): ClaudeOptions {
  const servers = options.mcpServers;
  return {
    ...options,
    // Through the app's proxy no server named caveman (a plugin's, a .mcp.json's, the person's v4) may claim recovery.
    ...(viaProxy ? { disallowedTools: [...new Set([...(options.disallowedTools ?? []), CLAUDE_RETRIEVE_TOOL])] } : {}),
    // Plugin stdio servers must not inherit project secrets from the CLI.
    ...(servers === undefined ? {} : {
      mcpServers: Object.fromEntries(Object.entries(servers).map(([key, server]) => [
        key,
        "command" in server && (server.type === undefined || server.type === "stdio")
          ? { ...server, env: { ...server.env, ...Object.fromEntries(secrets.map(({ name }) => [name, ""])) } }
          : server,
      ])) as NonNullable<ClaudeOptions["mcpServers"]>,
    }),
  };
}

/** Claude query options routed through the scrub, with the project's secrets. Fails when it must not start. */
export function routeClaudeOptions(
  options: ClaudeOptions,
  input: {
    readonly egress: Egress;
    readonly secrets: ReadonlyArray<SecretEntry>;
    /** From `claudeSettingsEnv`: the CLI applies it over the process env. */
    readonly settingsEnv: Readonly<Record<string, string>>;
    readonly threadId?: string;
    /** Refuse when unroutable even with nothing to inject (the cwd's repository has secrets). */
    readonly mustRoute?: boolean;
  },
): { readonly options: ClaudeOptions; readonly unrouted?: true; readonly viaProxy?: true } | { readonly refused: string } {
  const env: Env = { ...(options.env ?? process.env) };
  const settings =
    typeof options.settings === "string"
      ? options.settings.trimStart().startsWith("{")
        ? (JSON.parse(options.settings) as Record<string, unknown>)
        : undefined
      : (options.settings as Record<string, unknown> | undefined);
  // The CLI's order: process env, then the settings files, then flag settings (Auto's base URL is there).
  const effective = { ...env, ...input.settingsEnv, ...(settings?.env as Record<string, string> | undefined) };
  const provider = ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].find((name) =>
    truthy(effective[name]),
  );
  const current = effective.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com";
  const app = appProxyUrl();
  // On Auto, Claude Code already names the app's proxy (flag settings).
  const onAuto = provider === undefined && app !== undefined && originOf(current) === originOf(app);
  // The app's proxy: on a chosen model through the scrub's via-proxy route; on Auto Claude already names it.
  const proxied = provider === undefined && (viaAppProxy(current, "api.anthropic.com") || onAuto);
  const upstream = proxied && viaAppProxy(current, "api.anthropic.com") ? ANTHROPIC_VIA_PROXY : current;
  const base =
    provider !== undefined ? undefined : input.egress.owns(current) ? current : input.egress.route(upstream);
  if (base === undefined) {
    // Unrouted but on Auto, it still talks to the proxy: it still needs its way back.
    if (input.secrets.length === 0 && input.mustRoute !== true) return { options: onAuto ? routeClaudeMcpOptions(options, input.secrets, true) : options, unrouted: true, ...(onAuto ? { viaProxy: true as const } : {}) };
    return {
      refused: unroutableMessage(
        "Claude Agent",
        provider === undefined ? "the scrub is not running" : `${provider} requests are signed for their cloud and cannot be rewritten`,
      ),
    };
  }
  // NO_PROXY from the effective env (settings files included) goes into the flag settings too,
  // so a proxy set in ~/.claude/settings.json never sees the loopback request.
  const routed: Record<string, string> = { ANTHROPIC_BASE_URL: base, ...loopbackNoProxy(effective) };
  if (proxied && input.threadId !== undefined && input.threadId !== "") {
    routed.ANTHROPIC_CUSTOM_HEADERS = withCustomHeader(effective.ANTHROPIC_CUSTOM_HEADERS, ROUTER_SESSION_HEADER, proxySession(input.threadId));
  }
  // Claude withholds first-party features (1M context, tool search) from a
  // non-Anthropic base URL. The scrub forwards to api.anthropic.com unchanged
  // but for secrets, so the claim stays true. A user's own value wins.
  if (URL.canParse(current) && new URL(current).hostname === "api.anthropic.com" && effective._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL === undefined) {
    routed._CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL = "1";
  }
  const withTool = routeClaudeMcpOptions(options, input.secrets, proxied);
  return {
    ...(proxied ? { viaProxy: true as const } : {}),
    options: {
      ...withTool,
      env: { ...env, ...engineSecretEnv(input.secrets), ...routed },
      // Flag settings outrank the user's settings files, where a proxy install
      // (Caveman v4) sets its own ANTHROPIC_BASE_URL. A settings file path
      // cannot be merged; the env and the upstream above still apply.
      ...(typeof options.settings === "string" && settings === undefined
        ? {}
        : {
            settings: {
              ...settings,
              env: { ...(settings?.env as Record<string, string> | undefined), ...routed },
            } as NonNullable<ClaudeOptions["settings"]>,
          }),
    },
  };
}

// ── Codex ─────────────────────────────────────────────────────

/** The few `config.toml` keys routing needs: top-level and per-table string values. */
export function readCodexConfig(text: string): {
  readonly top: Readonly<Record<string, string>>;
  readonly tables: ReadonlyMap<string, Readonly<Record<string, string>>>;
} {
  // ponytail: line scan for basic `key = "string"` pairs and `[table]` headers; a TOML parser if configs outgrow it.
  const top: Record<string, string> = {};
  const tables = new Map<string, Record<string, string>>();
  let current: Record<string, string> = top;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[(\[)?\s*([^\]]+?)\s*\]/.exec(line);
    if (header !== null) {
      const name = header[2]!.replace(/"/g, "");
      current = header[1] === undefined ? (tables.get(name) ?? {}) : {};
      if (header[1] === undefined) tables.set(name, current);
      continue;
    }
    const pair = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"((?:[^"\\]|\\.)*)"/.exec(line);
    if (pair !== null) current[pair[1]!] = pair[2]!;
  }
  return { top, tables };
}

/** `-c key=value` overrides and `--profile` from Codex launch arguments, values unquoted. */
function codexCliOverrides(launchArgs: string | undefined): Record<string, string> {
  const args = tokenizeCliArgs(launchArgs);
  const out: Record<string, string> = {};
  const take = (pair: string) => {
    const eq = pair.indexOf("=");
    if (eq > 0) out[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "-c" || arg === "--config") && args[i + 1] !== undefined) take(args[++i]!);
    else if (arg.startsWith("--config=")) take(arg.slice("--config=".length));
    else if ((arg === "-p" || arg === "--profile") && args[i + 1] !== undefined) out.profile = args[++i]!;
    else if (arg.startsWith("--profile=")) out.profile = arg.slice("--profile=".length);
  }
  return out;
}

const SCRUB_PROVIDER = "caveman_code_egress";
const quoteCliArg = (arg: string) => `'${arg.replaceAll("'", `'"'"'`)}'`;
const BUILT_IN_UNROUTABLE = new Set(["ollama", "lmstudio", "oss", "amazon-bedrock"]);
/** Provider fields that would carry a credential onto Codex's argv: never copied. */
const CREDENTIAL_FIELD = /token|secret|password|bearer|^api_?key$/i;

/** A TOML scalar as written on one line: basic or literal string, integer, float or boolean. */
const tomlScalar = (raw: string): string | undefined => {
  const value = raw.replace(/\s+#.*$/, "").trim();
  if (value.startsWith('"""') || value.startsWith("'''")) return undefined;
  if (/^"(?:[^"\\\n]|\\.)*"$/.test(value)) return value;
  if (/^'[^'\n]*'$/.test(value)) return JSON.stringify(value.slice(1, -1));
  if (/^(?:true|false|[+-]?\d+(?:\.\d+)?)$/.test(value)) return value;
  return undefined;
};

/**
 * The fields of `[model_providers.<id>]`, each a TOML scalar ready to re-emit,
 * or why they cannot be read safely: an inline or multi-line value, a dotted
 * key, a sub-table, a credential field, or a provider defined some other way.
 */
export function readCodexProvider(
  text: string,
  id: string,
): { readonly fields: ReadonlyArray<readonly [string, string]> } | { readonly unreadable: string } {
  const header = `model_providers.${id}`;
  const inline = new RegExp(`^\\s*model_providers(?:\\.${id.replace(/-/g, "\\-")})?\\s*=`);
  const fields: Array<readonly [string, string]> = [];
  let inside = false;
  let found = false;
  for (const line of text.split(/\r?\n/)) {
    const table = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
    if (table !== null) {
      const name = table[1]!.replace(/\s/g, "");
      if (name === header || name === `model_providers."${id}"`) {
        inside = true;
        found = true;
        continue;
      }
      if (name.startsWith(`${header}.`)) return { unreadable: `its model provider "${id}" has a sub-table` };
      inside = false;
      continue;
    }
    if (!inside) {
      if (inline.test(line)) return { unreadable: `its model provider "${id}" is defined inline` };
      continue;
    }
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    const pair = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.*)$/.exec(line);
    if (pair === null) return { unreadable: `a field of its model provider "${id}" is not one key = value line` };
    const value = tomlScalar(pair[2]!);
    if (value === undefined) {
      return { unreadable: `its model provider "${id}" has an inline, list or multi-line value (${pair[1]})` };
    }
    if (CREDENTIAL_FIELD.test(pair[1]!) && pair[1] !== "env_key") {
      return { unreadable: `its model provider "${id}" holds a credential in ${pair[1]}` };
    }
    fields.push([pair[1]!, value]);
  }
  return found ? { fields } : { unreadable: `its model provider "${id}" is not in config.toml` };
}

/**
 * Codex launch arguments that point its model provider at the scrub. Always
 * the same provider id, forced last on the command line: a `-c` beats every
 * config layer but managed config, so no other layer can pick a provider the
 * scrub does not see. It is the built-in OpenAI provider, or a copy of the
 * user's own provider, with `base_url` chained through the scrub and
 * WebSockets off.
 */
export function routeCodexLaunch(input: {
  readonly egress: Egress;
  readonly configText: string;
  readonly launchArgs: string | undefined;
  readonly environment: Env;
  /** Side calls disable MCP, so only the proxy that checks for retrieve on the wire may compress them. */
  readonly textGeneration?: true;
}): { readonly args: ReadonlyArray<string>; readonly viaProxy?: true } | { readonly unroutable: string } {
  const { top, tables } = readCodexConfig(input.configText);
  const cli = codexCliOverrides(input.launchArgs);
  if (Object.keys(cli).some((key) => key.startsWith("model_providers."))) {
    return { unroutable: "its launch arguments change a model provider, which cannot be read safely" };
  }
  const profile = cli.profile ?? top.profile;
  const provider =
    cli.model_provider ??
    (profile === undefined ? undefined : tables.get(`profiles.${profile}`)?.model_provider) ??
    top.model_provider ??
    "openai";
  const routeTo = (upstream: string) => (input.egress.owns(upstream) ? upstream : input.egress.route(upstream));
  const args = (fields: ReadonlyArray<readonly [string, string]>, base: string) => [
    "-c",
    `model_provider="${SCRUB_PROVIDER}"`,
    "-c",
    `model_providers.${SCRUB_PROVIDER}={ ${[
      ...fields.filter(([key]) => key !== "base_url" && key !== "supports_websockets").map(([key, value]) => `${key} = ${value}`),
      `base_url = ${JSON.stringify(base)}`,
      "supports_websockets = false",
    ].join(", ")} }`,
  ];
  // Codex's own app proxy for the provider's own API or the person's proxy (viaAppProxy); the scrub picks its route.
  let viaProxy = false;
  const routeVia = (upstream: string) => {
    viaProxy = viaAppProxy(upstream, "api.openai.com");
    const proxyRoute = input.textGeneration ? OPENAI_VIA_PROXY : CODEX_VIA_PROXY;
    return routeTo(viaProxy ? proxyRoute : upstream);
  };
  if (provider === "openai" || provider === SCRUB_PROVIDER) {
    const upstream =
      cli.openai_base_url ?? top.openai_base_url ?? (input.environment.OPENAI_BASE_URL?.trim() || OPENAI_AUTO_UPSTREAM);
    const base = routeVia(upstream);
    if (base === undefined) return { unroutable: "the scrub is not running" };
    // Named "OpenAI" so Codex keeps its OpenAI behaviour (request compression, routing hints).
    return { args: args([["name", '"OpenAI"'], ["wire_api", '"responses"'], ["requires_openai_auth", "true"]], base), ...(viaProxy ? { viaProxy: true as const } : {}) };
  }
  if (!/^[A-Za-z0-9_-]+$/.test(provider)) {
    return { unroutable: `its model provider id "${provider}" cannot be read safely` };
  }
  if (BUILT_IN_UNROUTABLE.has(provider)) return { unroutable: `its model provider "${provider}" cannot be routed` };
  const read = readCodexProvider(input.configText, provider);
  if ("unreadable" in read) return { unroutable: read.unreadable };
  const upstream = read.fields.find(([key]) => key === "base_url")?.[1];
  if (upstream === undefined) return { unroutable: `its model provider "${provider}" has no base_url` };
  const base = routeVia(JSON.parse(upstream) as string);
  if (base === undefined) return { unroutable: "the scrub is not running" };
  return { args: args(read.fields, base), ...(viaProxy ? { viaProxy: true as const } : {}) };
}

type CodexOpenInput = Parameters<CodexAdapterV2.CodexAppServerClientFactory["Service"]["open"]>[0];

export function routeCodexOpen(
  open: CodexOpenInput,
  input: {
    readonly egress: Egress;
    readonly secrets: ReadonlyArray<SecretEntry>;
    readonly configText: string;
    /** Refuse when unroutable even with nothing to inject (the cwd's repository has secrets). */
    readonly mustRoute?: boolean;
  },
): { readonly open: CodexOpenInput; readonly unrouted?: true; readonly viaProxy?: true } | { readonly refused: string } {
  const routed = routeCodexLaunch({
    egress: input.egress,
    configText: input.configText,
    launchArgs: open.settings.launchArgs,
    environment: open.environment,
  });
  if ("unroutable" in routed) {
    return input.secrets.length === 0 && input.mustRoute !== true
      ? { open, unrouted: true }
      : { refused: unroutableMessage("Codex", routed.unroutable) };
  }
  return {
    ...(routed.viaProxy ? { viaProxy: true as const } : {}),
    open: {
      ...open,
      // Last, so the user's own launch arguments cannot undo them.
      settings: {
        ...open.settings,
        launchArgs: [open.settings.launchArgs ?? "", ...routed.args.map(quoteCliArg)].join(" ").trim(),
      },
      environment: { ...open.environment, ...engineSecretEnv(input.secrets), ...loopbackNoProxy(open.environment) },
    },
  };
}

type CodexClient = CodexAppServerClient.CodexAppServerClient["Service"];
const CODEX_THREAD_METHODS = new Set(["thread/start", "thread/resume", "thread/fork"]);

/**
 * Per-thread provider overrides (Auto) must retain the launch-time egress
 * boundary; `egress` undefined: the session runs unrouted, so they stay as
 * they are.
 */
export function withCodexThreadEgress(client: CodexClient, egress: Egress | undefined, viaProxy = false, threadId?: string): CodexAdapterV2.CodexEgressClient {
  const toProxy = (url: unknown) => typeof url === "string" && codexProxyUrl() !== undefined && originOf(url) === originOf(codexProxyUrl()!);
  const route = (method: string, payload: unknown) =>
    Effect.try({
      try: () => {
        if (!CODEX_THREAD_METHODS.has(method)) return payload;
        const input = payload as { config?: Record<string, unknown> | null };
        const config: Record<string, unknown> = { ...input.config };
        if (viaProxy && threadId !== undefined && threadId !== "") {
          config[`model_providers.${SCRUB_PROVIDER}.http_headers.${ROUTER_SESSION_HEADER}`] = proxySession(threadId);
        }
        for (const [key, value] of Object.entries(config)) {
          if (!key.startsWith("model_providers.") || value === null || typeof value !== "object") continue;
          let provider = value as Record<string, unknown>;
          if (threadId !== undefined && threadId !== "" && toProxy(provider.base_url)) {
            provider = { ...provider, http_headers: { ...(provider.http_headers as object), [ROUTER_SESSION_HEADER]: proxySession(threadId) } };
            config[key] = provider;
          }
          if (egress === undefined || typeof provider.base_url !== "string") continue;
          const base = egress.owns(provider.base_url) ? provider.base_url : egress.route(provider.base_url);
          if (base === undefined) throw new Error("The egress scrub is not running; Codex cannot change its model provider.");
          config[key] = { ...provider, base_url: base, supports_websockets: false };
        }
        return { ...input, config };
      },
      catch: () => new CodexAppServerRequestError({ code: -32000, errorMessage: "The egress scrub is not running; Codex cannot change its model provider.", method }),
    });
  return {
    ...client,
    request: ((method: string, payload: unknown) =>
      route(method, payload).pipe(Effect.flatMap((routed) => client.request(method as never, routed as never)))) as CodexClient["request"],
    raw: {
      ...client.raw,
      request: ((method: string, payload: unknown) =>
        route(method, payload).pipe(Effect.flatMap((routed) => client.raw.request(method as never, routed as never)))) as CodexClient["raw"]["request"],
    },
  };
}

/**
 * Codex hands its commands only what its `shell_environment_policy` lets
 * through: by default nothing named like *KEY*, *SECRET* or *TOKEN*, and
 * nothing at all past the core variables with `inherit = "core"`. Its `set`
 * applies after both, so each secret goes in as
 * `shell_environment_policy.set.NAME` on every thread start, resume and fork:
 * over the app-server's stdin, never its argv.
 */
export function withCodexThreadEnv(client: CodexClient, secrets: ReadonlyArray<SecretEntry>): CodexClient {
  const set = Object.entries(engineSecretEnv(secrets)).map(([name, value]) => [`shell_environment_policy.set.${name}`, value]);
  if (set.length === 0) return client;
  const add = (method: string, payload: unknown) =>
    CODEX_THREAD_METHODS.has(method)
      ? { ...(payload as object), config: { ...(payload as { config?: object | null }).config, ...Object.fromEntries(set) } }
      : payload;
  return {
    ...client,
    request: ((method: string, payload: unknown) =>
      client.request(method as never, add(method, payload) as never)) as CodexClient["request"],
    raw: {
      ...client.raw,
      request: ((method: string, payload: unknown) =>
        client.raw.request(method as never, add(method, payload) as never)) as CodexClient["raw"]["request"],
    },
  };
}

export const codexConfigText = (open: CodexOpenInput): string => {
  const home = open.settings.homePath || open.environment.CODEX_HOME || NodePath.join(NodeOS.homedir(), ".codex");
  try {
    return NodeFS.readFileSync(NodePath.join(home, "config.toml"), "utf8");
  } catch {
    return "";
  }
};

// ── OpenCode ──────────────────────────────────────────────────

const parseJsonc = Schema.decodeUnknownSync(fromLenientJson(Schema.Unknown));
const UNREADABLE = Symbol("unreadable");

/** A config file OpenCode would read: undefined when absent, UNREADABLE when it cannot be parsed. */
const readOpenCodeConfig = (file: string): unknown => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : UNREADABLE;
  }
  try {
    return parseJsonc(text);
  } catch {
    return UNREADABLE;
  }
};

/** Whether a config points provider `id` somewhere or gives it a key (2.x `providers.<id>.settings`, 1.x `provider.<id>.options`). */
const ownsProvider = (config: unknown, id: string): boolean => {
  const c = config as
    | { providers?: Record<string, { settings?: Record<string, unknown> }>; provider?: Record<string, { options?: Record<string, unknown> }> }
    | undefined;
  const set = [c?.providers?.[id]?.settings, c?.provider?.[id]?.options];
  return set.some((fields) => fields?.baseURL !== undefined || fields?.apiKey !== undefined);
};

/**
 * The config an OpenCode 2 server gets as OPENCODE_CONFIG: the person's own
 * OPENCODE_CONFIG file, with the Anthropic and OpenAI providers pointed at the
 * app's caveman-proxy through the scrub (over HTTP, so a Responses WebSocket
 * cannot slip past it).
 *
 * Undefined, so nothing changes, while the scrub is down or when any config
 * OpenCode reads before this one cannot be parsed (fail closed). A provider
 * that any of them, or OPENCODE_CONFIG_CONTENT, or ANTHROPIC_BASE_URL /
 * OPENAI_BASE_URL, points elsewhere or gives a key keeps exactly that.
 * Repository configs (opencode.json(c), .opencode/) and the inline content
 * outrank OPENCODE_CONFIG in OpenCode itself (checked on 2.0.22), so a
 * project's own provider setup wins without being read here.
 */
export function openCodeRouting(env: Env, egress: Egress): Record<string, unknown> | undefined {
  const anthropic = egress.route(ANTHROPIC_VIA_PROXY);
  const openai = egress.route(OPENAI_VIA_PROXY);
  if (anthropic === undefined || openai === undefined) return undefined;
  const configHome = NodePath.join(env.XDG_CONFIG_HOME || NodePath.join(env.HOME || NodeOS.homedir(), ".config"), "opencode");
  const files = [
    ...["config.json", "opencode.json", "opencode.jsonc"].map((name) => NodePath.join(configHome, name)),
    ...(env.OPENCODE_CONFIG_DIR ? ["opencode.json", "opencode.jsonc"].map((name) => NodePath.join(env.OPENCODE_CONFIG_DIR!, name)) : []),
  ];
  let inline: unknown;
  try {
    inline = env.OPENCODE_CONFIG_CONTENT?.trim() ? parseJsonc(env.OPENCODE_CONFIG_CONTENT) : undefined;
  } catch {
    return undefined;
  }
  const own = env.OPENCODE_CONFIG ? readOpenCodeConfig(env.OPENCODE_CONFIG) : undefined;
  const sources = [inline, own, ...files.map(readOpenCodeConfig)];
  if (sources.includes(UNREADABLE)) return undefined;
  const base = (own ?? {}) as Record<string, unknown>;
  const providers = { ...(base.providers as Record<string, Record<string, unknown>> | undefined) };
  const route = (id: string, baseURL: string, envBase: string | undefined) => {
    if (envBase?.trim() || sources.some((config) => ownsProvider(config, id))) return;
    const current = providers[id] ?? {};
    providers[id] = { ...current, settings: { ...(current.settings as object | undefined), baseURL, transport: "http" } };
  };
  // OpenCode appends /messages to Anthropic's base and /responses to OpenAI's.
  route("anthropic", `${anthropic}/v1`, env.ANTHROPIC_BASE_URL);
  route("openai", openai, env.OPENAI_BASE_URL);
  return { ...base, providers };
}

/** Where routed OpenCode configs are written: a private directory per runtime, a file per server. */
const openCodeConfigDir = () => {
  const dir = NodePath.join(NodeOS.tmpdir(), `caveman-opencode-${process.pid}`);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
};

/** An OpenCode 2 server's environment with openCodeRouting's config as its OPENCODE_CONFIG; unchanged when there is none. */
export function routeOpenCodeEnvironment(env: Env, egress: Egress, dir: string = openCodeConfigDir()): Env {
  const config = openCodeRouting(env, egress);
  if (config === undefined) return env;
  // The scrub's routes carry its path token: owner-only, like the env var they replace.
  const file = NodePath.join(dir, `${randomUUID()}.json`);
  NodeFS.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  return { ...env, ...loopbackNoProxy(env), OPENCODE_CONFIG: file };
}

/**
 * OpenCode servers, each OpenCode 2 one started with its providers routed
 * (routeOpenCodeEnvironment). OpenCode 2 is told apart by OPENCODE_PASSWORD,
 * which only its spawns carry; a 1.x server starts as before. Decorates the
 * runtime below it.
 */
export const layerOpenCodeEgress = Layer.effect(
  OpenCodeRuntime.OpenCodeRuntime,
  Effect.gen(function* () {
    const inner = yield* OpenCodeRuntime.OpenCodeRuntime;
    const egress = yield* makeEgress;
    return OpenCodeRuntime.OpenCodeRuntime.of({
      ...inner,
      startOpenCodeServerProcess: (input) =>
        Effect.suspend(() =>
          inner.startOpenCodeServerProcess(
            input.environment?.OPENCODE_PASSWORD === undefined ? input : { ...input, environment: routeOpenCodeEnvironment(input.environment, egress) },
          ),
        ),
    });
  }),
);

// ── Text generation ───────────────────────────────────────────

type EgressService = EgressRoute["Service"];

/** Whether text generation for `cwd` must go through the scrub: its repository has secrets, or the store cannot tell. */
const mustRouteAt = (egress: Option.Option<EgressService>, cwd: string) =>
  Option.isNone(egress) ? Effect.succeed(false) : egress.value.hasSecrets(cwd).pipe(Effect.orElseSucceed(() => true));

/**
 * `claude -p` for titles, branch names, commit messages, PR text and the
 * review guide: its env and flag settings routed through the scrub like an
 * agent session (no secrets injected). Fails when it cannot be routed and the
 * cwd's repository has secrets.
 */
export const routeClaudeTextGeneration = (input: {
  readonly egress: Option.Option<EgressService>;
  readonly env: Env;
  readonly settings: Readonly<Record<string, unknown>>;
  readonly cwd: string;
}) =>
  Effect.gen(function* () {
    const egress: Egress = Option.isSome(input.egress) ? input.egress.value : { route: () => undefined, owns: () => false };
    const routed = routeClaudeOptions({ env: input.env, settings: input.settings } as unknown as ClaudeOptions, {
      egress,
      secrets: [],
      settingsEnv: claudeSettingsEnv({
        configDir: input.env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
        cwd: input.cwd,
        sources: ["user", "project", "local"],
      }),
      mustRoute: yield* mustRouteAt(input.egress, input.cwd),
    });
    if ("refused" in routed) return yield* Effect.fail(new Error(routed.refused.replace("Claude Agent", "Claude text generation")));
    return {
      env: routed.options.env ?? input.env,
      settings: (routed.options.settings ?? input.settings) as Readonly<Record<string, unknown>>,
    };
  });

/** `codex exec` for text generation: the forced scrub provider's `-c` arguments, or a failure when it must not run. */
export const routeCodexTextGeneration = (input: {
  readonly egress: Option.Option<EgressService>;
  readonly env: Env;
  readonly launchArgs: string | undefined;
  readonly cwd: string;
}) =>
  Effect.gen(function* () {
    const egress: Egress = Option.isSome(input.egress) ? input.egress.value : { route: () => undefined, owns: () => false };
    const home = input.env.CODEX_HOME || NodePath.join(NodeOS.homedir(), ".codex");
    let configText = "";
    try {
      configText = NodeFS.readFileSync(NodePath.join(home, "config.toml"), "utf8");
    } catch {}
    const routed = routeCodexLaunch({ egress, configText, launchArgs: input.launchArgs, environment: input.env, textGeneration: true });
    if ("args" in routed) return { args: routed.args, env: loopbackNoProxy(input.env) };
    if (yield* mustRouteAt(input.egress, input.cwd)) {
      return yield* Effect.fail(new Error(unroutableMessage("Codex text generation", routed.unroutable)));
    }
    return { args: [] as ReadonlyArray<string>, env: {} };
  });

// ── Layers ────────────────────────────────────────────────────

/** The thread's repository secrets, plaintext, for the engine process env (SessionPlugins.secretEnv). */
const makeThreadSecrets = Effect.gen(function* () {
  const plugins = yield* Effect.serviceOption(SessionPlugins.SessionPlugins);
  const read = Option.isSome(plugins) ? plugins.value.secretEnv : undefined;
  return (threadId: ThreadId, cwd: string | null | undefined) =>
    read === undefined
      ? Effect.succeed([] as ReadonlyArray<SecretEntry>)
      : read(threadId, cwd ?? undefined).pipe(
          Effect.map((env): ReadonlyArray<SecretEntry> => Object.entries(env).map(([name, value]) => ({ name, value }))),
        );
});

/** The runtime's scrub (EgressScrub.layer, provided once at the top); absent, nothing routes. */
const makeEgress = Effect.gen(function* () {
  const egress = yield* Effect.serviceOption(EgressRoute);
  return Option.isSome(egress) ? egress.value : { route: () => undefined, owns: () => false };
});

/**
 * A session that started unrouted (Bedrock, Vertex, a local or unreadable
 * Codex provider) while its repository had no secrets: before each turn,
 * fails once the repository has any (or the store cannot tell).
 */
const unroutedGuard = (
  threadSecrets: Effect.Success<typeof makeThreadSecrets>,
  threadId: ThreadId,
  cwd: string | null | undefined,
) =>
  threadSecrets(threadId, cwd).pipe(
    Effect.map((secrets) => secrets.length > 0),
    Effect.orElseSucceed(() => true),
  );

/** Claude Agent's query runner, every query routed through the scrub. Decorates the runner below it. */
export const layerClaudeEgress = Layer.effect(
  ClaudeAdapterV2.ClaudeAgentSdkQueryRunner,
  Effect.gen(function* () {
    const inner = yield* ClaudeAdapterV2.ClaudeAgentSdkQueryRunner;
    const egress = yield* makeEgress;
    const threadSecrets = yield* makeThreadSecrets;
    return ClaudeAdapterV2.ClaudeAgentSdkQueryRunner.of({
      ...inner,
      open: (input) =>
        Effect.gen(function* () {
          const secrets = yield* threadSecrets(input.threadId, input.options.cwd);
          const env = input.options.env ?? process.env;
          const routed = routeClaudeOptions(input.options, {
            threadId: input.threadId,
            egress,
            secrets,
            settingsEnv: claudeSettingsEnv({
              configDir: env.CLAUDE_CONFIG_DIR || NodePath.join(NodeOS.homedir(), ".claude"),
              cwd: input.options.cwd,
              sources: input.options.settingSources ?? ["user", "project", "local"],
            }),
          });
          if ("refused" in routed) return yield* Effect.fail(new Error(routed.refused));
          return routed;
        }).pipe(
          Effect.mapError((cause) => new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({ method: "open", cause })),
          Effect.flatMap((routed) =>
            inner.open({ ...input, options: routed.options }).pipe(
              Effect.map((session) => {
                const checked = {
                  ...session,
                  ...(session.setMcpServers === undefined ? {} : {
                    setMcpServers: (servers: NonNullable<ClaudeOptions["mcpServers"]>) =>
                      threadSecrets(input.threadId, input.options.cwd).pipe(
                        Effect.mapError((cause) => new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({ method: "setMcpServers", cause })),
                        Effect.flatMap((secrets) => session.setMcpServers!(routeClaudeMcpOptions({ ...routed.options, mcpServers: servers }, secrets, routed.viaProxy === true).mcpServers ?? {})),
                      ),
                  }),
                };
                return routed.unrouted !== true
                  ? checked
                  : {
                      ...checked,
                      offer: (message: Parameters<typeof session.offer>[0]) =>
                        unroutedGuard(threadSecrets, input.threadId, input.options.cwd).pipe(
                          Effect.flatMap((blocked) =>
                            blocked
                              ? Effect.fail(
                                  new ClaudeAdapterV2.ClaudeAgentSdkQueryRunnerError({
                                    method: "offer",
                                    cause: new Error(startedUnroutedMessage("Claude Agent")),
                                  }),
                                )
                              : session.offer(message),
                          ),
                        ),
                    };
              }),
            ),
          ),
        ),
    });
  }),
);

const CODEX_PROVIDER = ProviderDriverKind.make("codex");
const CODEX_TURN_METHODS = new Set(["turn/start", "turn/steer"]);

/** A Codex client that refuses new turns once an unrouted session's repository has secrets. */
export function withUnroutedGuard(client: CodexClient, blocked: Effect.Effect<boolean>): CodexClient {
  const guard = (method: string, request: Effect.Effect<unknown, unknown>): Effect.Effect<unknown, unknown> =>
    !CODEX_TURN_METHODS.has(method)
      ? request
      : Effect.flatMap(blocked, (isBlocked): Effect.Effect<unknown, unknown> =>
          isBlocked
            ? Effect.fail(
                new CodexAppServerRequestError({ code: -32000, errorMessage: startedUnroutedMessage("Codex"), method }),
              )
            : request,
        );
  return {
    ...client,
    request: ((method: string, payload: unknown) =>
      guard(method, client.request(method as never, payload as never))) as CodexClient["request"],
    raw: {
      ...client.raw,
      request: ((method: string, payload: unknown) =>
        guard(method, client.raw.request(method as never, payload as never))) as CodexClient["raw"]["request"],
    },
  };
}

/** Codex app-servers, each launched with its model provider routed through the scrub. Decorates the factory below it. */
export const layerCodexEgress = Layer.effect(
  CodexAdapterV2.CodexAppServerClientFactory,
  Effect.gen(function* () {
    const inner = yield* CodexAdapterV2.CodexAppServerClientFactory;
    const egress = yield* makeEgress;
    const threadSecrets = yield* makeThreadSecrets;
    return CodexAdapterV2.CodexAppServerClientFactory.of({
      open: (input) =>
        Effect.gen(function* () {
          const secrets = yield* threadSecrets(input.threadId, input.runtimePolicy.cwd);
          // A codex holding a stand-in (its person's vault key or followed sign-in) only works through the scrub,
          // which swaps the real one in. Asked of the lane, so no key is read for it.
          const standIn = yield* holdsCloudStandIn("codex");
          const routed = routeCodexOpen(input, { egress, secrets, configText: codexConfigText(input), ...(standIn ? { mustRoute: true } : {}) });
          if ("refused" in routed) return yield* Effect.fail(new Error(routed.refused));
          return { routed, secrets };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterOpenSessionError({
                driver: CODEX_PROVIDER,
                providerSessionId: input.providerSessionId,
                cause,
              }),
          ),
          Effect.flatMap(({ routed, secrets }) =>
            inner.open(routed.open).pipe(
              Effect.map((client) =>
                routed.unrouted === true
                  ? withUnroutedGuard(withCodexThreadEgress(client, undefined, false, input.threadId), unroutedGuard(threadSecrets, input.threadId, input.runtimePolicy.cwd))
                  : withCodexThreadEgress(withCodexThreadEnv(client, secrets), egress, routed.viaProxy === true, input.threadId),
              ),
            ),
          ),
        ),
    });
  }),
);

/**
 * Both engines routed through the runtime's one scrub. EgressRoute comes from
 * the context (EgressScrub.layer at the top of the runtime), so the Caveman
 * engine, side text and text generation see the same proxy.
 */
export const layerEngines = Layer.mergeAll(
  layerClaudeEgress.pipe(Layer.provide(ClaudeAdapterV2.layerQueryRunner)),
  layerCodexEgress.pipe(Layer.provide(CodexAdapterV2.layerAppServerClientFactory)),
);
