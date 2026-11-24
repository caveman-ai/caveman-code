/**
 * Personal MCP servers: the ones a person adds by hand, imports from Claude
 * Code or Codex, or connects as a connector, outside any space. They become
 * one synthetic plugin (`my-servers@personal`) so the bundle's containment,
 * broker and per-engine projections apply to them unchanged. Credentials are
 * names here; values are granted to the `personal` space through the broker,
 * or are OAuth tokens only the runtime's MCP hub holds.
 *
 * @module plugins/personal
 */
import { ENV_VAR_NAME, HEADER_NAME, PluginServer } from "@caveman-app/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { KEY_FLAG, KEYLIKE } from "../session-protocol/setupScan.ts";
import type { McpServerConfig } from "./format.ts";
import { type LoadedPlugin, reservedServerName } from "./load.ts";

/** The pseudo-space personal servers live in; `credential.grant` takes it as `space_id`. */
export const PERSONAL_SPACE_ID = "personal";
/** What the broker keys personal grants by (a space's repo URL elsewhere). */
export const PERSONAL_SPACE_URL = "caveman:personal";
export const PERSONAL_PLUGIN_ID = `my-servers@${PERSONAL_SPACE_ID}`;
const SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$/;

/** The credential a personal server's header is granted under: `sentry` + `Authorization` -> `SENTRY_AUTHORIZATION`. */
export const headerCredential = (server: string, header: string) =>
  `${server}_${header}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_").replace(/^(\d)/, "_$1");

/** Every credential name a personal server needs. */
export const serverCredentials = (server: PluginServer): ReadonlyArray<string> => [
  ...(server.env ?? []),
  ...(server.headers ?? []).map((header) => headerCredential(server.name, header)),
];

/**
 * What a personal server's row says on a Cloud computer whose person's credentials stay outside it, when it needs a
 * key: the key was never brought in and cannot be, so the server is in no chat there (resolve.ts keysStayOutside).
 */
export const keyStaysOnMac = (name: string) => `${name} needs a key that stays on your Mac, so it isn't in Cloud.`;

/** Why a server cannot be saved, or undefined. */
export function serverProblem(server: PluginServer): string | undefined {
  if (!SERVER_NAME.test(server.name)) return `${server.name}: a server name is letters, digits, - and _`;
  if (reservedServerName(server.name)) return `the name "${server.name}" is reserved by Caveman Code`;
  if ((server.command === undefined) === (server.url === undefined)) return `${server.name}: give a command or a URL, not both`;
  if (server.url !== undefined) {
    try {
      const url = new URL(server.url);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) {
        return `${server.name}: a remote server needs https (http only on this computer)`;
      }
    } catch {
      return `${server.name}: ${server.url} is not a URL`;
    }
  }
  if (server.auth !== undefined && server.url === undefined) return `${server.name}: only a URL server signs in`;
  const header = (server.headers ?? []).find((h) => !HEADER_NAME.test(h));
  if (header !== undefined) return `${server.name}: "${header}" is not a header name`;
  const env = (server.env ?? []).find((name) => !ENV_VAR_NAME.test(name));
  if (env !== undefined) return `${server.name}: "${env}" is not an environment variable name`;
  // Whatever else Settings would refuse: one server never fails the write of the others.
  if (!isSaveable(server)) return `${server.name}: its settings cannot be saved`;
  return undefined;
}

/** Whether Settings takes it as it is read back (defaults applied), as the settings write checks every server. */
const decodeServer = Schema.decodeUnknownOption(PluginServer);
const isSaveable = (server: PluginServer) => Option.isSome(decodeServer(server));

const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "caveman-code", version: "1" } } });

/** Read no more of an answer than this: an initialize result is a few hundred bytes. */
const READ_LIMIT = 64 * 1024;

/** An MCP initialize result, as a JSON body or one of an event stream's `data:` lines. A catch-all page is not one. */
function holdsInitResult(text: string): boolean {
  const lines = text.split(/\r?\n/).flatMap((line) => (line.startsWith("data:") ? [line.slice(5).trim()] : []));
  return [text, ...lines].some((candidate) => {
    try {
      const value = JSON.parse(candidate) as { result?: { protocolVersion?: unknown } } | null;
      return typeof value?.result?.protocolVersion === "string";
    } catch {
      return false;
    }
  });
}

/** Up to READ_LIMIT of a body, stopping as soon as the initialize result is in (an event stream stays open). */
async function readInitResult(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (reader === undefined) return false;
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < READ_LIMIT) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (holdsInitResult(text)) return true;
    }
    return holdsInitResult(text);
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

/** Whether the server publishes OAuth protected-resource metadata (RFC 9728), which is how MCP clients find its sign-in. */
async function offersSignIn(url: string, signal: AbortSignal): Promise<boolean> {
  const at = new URL(url);
  const path = at.pathname === "/" ? "" : at.pathname;
  for (const where of new Set([`${at.origin}/.well-known/oauth-protected-resource${path}`, `${at.origin}/.well-known/oauth-protected-resource`])) {
    try {
      const response = await fetch(where, { redirect: "manual", signal, headers: { accept: "application/json" } });
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined);
        continue;
      }
      const metadata = (await response.json()) as { authorization_servers?: unknown } | null;
      if (Array.isArray(metadata?.authorization_servers) && metadata.authorization_servers.length > 0) return true;
    } catch {
      // Not there, or not JSON: no sign-in offered at this address.
    }
  }
  return false;
}

/**
 * Whether a URL server keeps its sign-in: an MCP initialize sent without credentials, as Claude Code first connects.
 * true: it asks for one (401 or 403), or answers but offers one (OAuth metadata), which signing in may unlock; false:
 * it answers with an initialize result and offers no sign-in, so there is nothing to sign in to; undefined: it could
 * not tell (no answer in time, a redirect, an error or a page that is not MCP), and the caller keeps what it had.
 */
export async function signInNeeded(url: string, timeoutMs = 4000): Promise<boolean | undefined> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: INITIALIZE,
    });
    if (response.status === 401 || response.status === 403) {
      void response.body?.cancel().catch(() => undefined);
      return true;
    }
    if (response.status < 200 || response.status >= 300) {
      void response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    if (!(await readInitResult(response))) return undefined;
    return await offersSignIn(url, signal);
  } catch {
    return undefined;
  }
}

/**
 * A URL server set to sign in (an import marks every remote one without headers so, as Claude Code assumes) that
 * answers without credentials and offers no sign-in is saved without one: OAuth could not start there, and every
 * engine reaches it directly. One that asks, offers, or can't be asked keeps its sign-in.
 */
export async function settleSignIn(server: PluginServer, probe: (url: string) => Promise<boolean | undefined> = signInNeeded): Promise<PluginServer> {
  if (server.url === undefined || server.auth !== "oauth" || (server.headers?.length ?? 0) > 0) return server;
  if ((await probe(server.url).catch(() => undefined)) !== false) return server;
  const { auth: _auth, ...open } = server;
  return open;
}

/**
 * The enabled personal servers as one plugin, or undefined when there are
 * none. `root` only anchors `${CLAUDE_PLUGIN_ROOT}`; nothing is read from it,
 * and Claude Agent gets no plugin copy of it (only its MCP servers).
 */
export function personalPlugin(servers: ReadonlyArray<PluginServer>, root: string): LoadedPlugin | undefined {
  const enabled = servers.filter((server) => server.enabled && serverProblem(server) === undefined);
  if (enabled.length === 0) return undefined;
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const server of enabled) {
    mcpServers[server.name] =
      server.url !== undefined
        ? {
            type: "http",
            url: server.url,
            headers: Object.fromEntries(
              (server.headers ?? []).map((header) => [header, `\${${headerCredential(server.name, header)}}`]),
            ),
          }
        : {
            command: server.command!,
            ...(server.args === undefined ? {} : { args: server.args }),
            env: Object.fromEntries((server.env ?? []).map((name) => [name, `\${${name}}`])),
          };
  }
  return {
    id: PERSONAL_PLUGIN_ID,
    name: "my-servers",
    space: PERSONAL_SPACE_ID,
    root,
    description: "Your own MCP servers and connectors",
    skills: [],
    commands: [],
    agents: [],
    hooks: {},
    mcpServers,
    lspServers: {},
    monitors: [],
    rules: [],
    contributes: {
      connectors: enabled.map((server) => ({ id: server.name, title: server.name, server: server.name, credentials: [...serverCredentials(server)] })),
    },
    manifest: { name: "my-servers" },
    interface: {},
    problems: [],
    origin: { url: PERSONAL_SPACE_URL, commit: "" },
  };
}

/**
 * Connectors before plugins: the personal servers Connect added, by name, and
 * the Caveman catalog plugin each now is. Sign-ins are kept by URL, the same
 * in both, so moving one keeps it connected (marketplaces.ts migrateConnectors).
 */
export const CONNECTOR_PLUGINS: Readonly<Record<string, string>> = {
  github: "github@caveman-curated",
  linear: "linear@caveman-curated",
  sentry: "sentry@caveman-curated",
  notion: "notion@caveman-curated",
  slack: "slack@caveman-curated",
};

// ------------------------------------------------------------ import

/** Where an imported server's config was read. */
export type ImportFrom = "claude" | "codex" | "cursor";

export interface ImportedServer<F extends ImportFrom = "claude" | "codex"> {
  readonly server: PluginServer;
  readonly from: F;
}

export interface SkippedServer<F extends ImportFrom = "claude" | "codex"> {
  readonly name: string;
  readonly from: F;
  readonly reason: string;
}

/** Whether argv or a URL carries a credential (a key-like value, a value after a key flag, userinfo, a key query). */
export function holdsCredential(values: ReadonlyArray<string>): boolean {
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!;
    const [flag, inline] = value.startsWith("-") ? value.split(/=(.*)/s) : [undefined, undefined];
    if (flag !== undefined && KEY_FLAG.test(flag)) {
      if (inline !== undefined && inline !== "") return true;
      // `--api-key VALUE`: the next argument is the value.
      if (inline === undefined && i + 1 < values.length && !values[i + 1]!.startsWith("-")) return true;
    }
    if (KEYLIKE.test(value)) return true;
    // A connection string's `Password=…`, `pwd=…`, `secret=…` (`--conn=Server=db;Password=hunter2`): a value however short.
    if (/(?:pass|pwd|secret)[\w-]*\s*[=:]\s*[^\s;&]/i.test(value)) return true;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      try {
        const url = new URL(value);
        if (url.password !== "" || url.username !== "") return true;
        for (const [name, param] of url.searchParams) if (KEY_FLAG.test(name) || KEYLIKE.test(param)) return true;
        if (url.pathname.split("/").some((segment) => KEYLIKE.test(decodeURIComponent(segment)))) return true;
      } catch {
        // Not a URL after all.
      }
    }
  }
  return false;
}

const safeName = (name: string) =>
  name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/[-_]+$/, "").slice(0, 48);

/** One config entry as a personal server, or why it was left out. Never reads a value: env and headers become names. */
export function importEntry<F extends ImportFrom>(
  name: string,
  from: F,
  entry: {
    command?: unknown;
    args?: unknown;
    url?: unknown;
    type?: unknown;
    env?: ReadonlyArray<string>;
    headers?: ReadonlyArray<string>;
    /** false: its tool keeps it off, and so does the import. */
    enabled?: boolean;
    /** Why the config reader could not take it as written (setupScan.ts readCodexConfig). */
    problem?: string;
  },
): ImportedServer<F> | SkippedServer<F> {
  const clean = safeName(name);
  const skip = (reason: string): SkippedServer<F> => ({ name, from, reason });
  if (clean === "") return skip("its name has no letters or digits");
  if (entry.problem !== undefined) return skip(entry.problem);
  if (entry.type === "sse") return skip("SSE servers are not supported; use its streamable HTTP URL");
  // A list with anything but strings would arrive cut down, starting another program than its tool does.
  if (entry.args !== undefined && !(Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string"))) return skip("its args are not a list of strings");
  const args = (entry.args ?? []) as ReadonlyArray<string>;
  const enabled = entry.enabled !== false;
  let server: PluginServer;
  if (typeof entry.url === "string") {
    // A remote server without headers signs in with OAuth (as Claude Code does); a public one never asks.
    server = { name: clean, url: entry.url, ...(entry.headers?.length ? { headers: [...entry.headers] } : { auth: "oauth" as const }), source: from, enabled };
  } else if (typeof entry.command === "string") {
    server = { name: clean, command: entry.command, ...(args.length ? { args: [...args] } : {}), ...(entry.env?.length ? { env: [...entry.env] } : {}), source: from, enabled };
  } else {
    return skip("it has neither a command nor a URL");
  }
  if (holdsCredential([...(server.command === undefined ? [] : [server.command]), ...args, ...(server.url === undefined ? [] : [server.url])])) {
    return skip("its command line or URL holds a credential; add it with Add an MCP server and paste the key there");
  }
  const problem = serverProblem(server);
  return problem === undefined ? { server, from } : skip(problem);
}

export const isSkipped = <F extends ImportFrom>(item: ImportedServer<F> | SkippedServer<F>): item is SkippedServer<F> => "reason" in item;
