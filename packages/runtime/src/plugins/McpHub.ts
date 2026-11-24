/**
 * The runtime's MCP hub: the runtime is the MCP client for plugin, personal
 * and connector servers, and serves each one to engines as a streamable
 * HTTP endpoint (`/mcp/hub/<key>`, JSON responses, no server stream) on the
 * runtime's own origin, behind the thread's runtime MCP credential.
 *
 * Why: a server's sign-in (runtime-held OAuth tokens, the runtime's GitHub
 * login) never reaches an engine or a plugin; a thread's stdio servers start
 * once in the runtime, contained by the same launcher, and are shared by
 * every model the thread switches to; the runtime sees every tool call (its
 * hook set for the Caveman engine) and each server's tool schemas, which give
 * the idle token estimate.
 *
 * The Caveman engine reaches every server through the hub. Claude Agent,
 * Codex and ACP agents keep their native projections and reach only the
 * servers that sign in through it (`hubRoute.ts`).
 *
 * @module plugins/McpHub
 */
import { withoutRuntimeEnv } from "@caveman-app/engine-core/server/instanceEnvironment";
import { MCP_HUB_PATH } from "@caveman-app/engine-core/server/mcpSession";
import type { PluginMcpServer, RuntimeHooks } from "@caveman-app/engine-core/server/SessionPlugins";
import type { ThreadId } from "@caveman-app/protocol";
import { containsKnownSecret } from "@caveman-app/session-protocol";
import { McpClient, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import type { AuthProvider, McpFetch } from "@earendil-works/pi-mcp";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { accountVault } from "../cloudLink/accountCredentials.ts";
import { liveServersSocket, serversSocket, toolsCommand, toolsSocket } from "../cloudLink/tools.ts";
import { forTools } from "../cloudLink/toolsMirror.ts";
import { ServerConfig } from "../config.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { makeHookRunner } from "./hooks.ts";
import { PERSONAL_PLUGIN_ID } from "./personal.ts";
import { PluginRegistry, type PluginSession } from "./PluginRegistry.ts";
import { serverKeys } from "./resolve.ts";

export class McpHubError extends Schema.TaggedError<McpHubError>()("McpHubError", {
  message: Schema.String,
  /** `not_found`: no such server for the caller; `sign_in`: it needs a (new) sign-in. */
  reason: Schema.Literals(["not_found", "sign_in", "failed"]),
}) {}

/** Who is calling: the thread whose runtime credential it carries, if any. */
export interface HubCaller {
  readonly threadId: ThreadId | undefined;
  /** Run the runtime's hook set on its tool calls (the Caveman engine; other engines run their own). */
  readonly hooks: boolean;
}

/**
 * A server by what it is, whatever key a thread's bundle gives it: a plugin's server by the plugin's id and the name
 * its .mcp.json gives it, a personal one under PERSONAL_PLUGIN_ID (personalServer). A key is per bundle (resolve.ts
 * serverKeys): a personal server whose name a plugin's server took in one repository is keyed by its full id there
 * and by its name elsewhere, and another server may hold that name.
 */
export interface HubServer {
  readonly plugin: string;
  readonly server: string;
}

export const personalServer = (name: string): HubServer => ({ plugin: PERSONAL_PLUGIN_ID, server: name });

const identity = (server: HubServer) => `${server.plugin}\0${server.server}`;

/** One server the hub can connect: its bundle entry, and how it signs in when it does. */
export interface HubTarget {
  readonly key: string;
  readonly server: PluginMcpServer;
  /**
   * `plugin`: the plugin id it serves and `repository` the repository the
   * session works in, so Caveman Cloud can lease the org's shared account
   * for that plugin there (Cloud finds the project from the repository).
   * `account`: a service account's connector Cloud named for this server where its credentials stay outside the
   * computer (accountCredentials.ts): the id Cloud's connector proxy knows it by, and the match_url it covers.
   */
  readonly auth?: {
    readonly auth: "oauth" | "github";
    readonly url: string;
    readonly plugin?: string;
    readonly repository?: string;
    readonly account?: { readonly id: string; readonly matchUrl: string };
  };
}

/**
 * How a server that signs in gets its credentials: headers to add, or an OAuth provider the transport asks.
 * `url`: the address to send to instead of the server's own. On a Cloud computer whose person's sign-ins stay outside
 * it, that is Cloud's connector proxy (cloudLink/connectorProxy.ts): the provider's token is then the runtime's own,
 * Cloud attaches the server's sign-in outside the computer, and the server's own URL is never dialed from here.
 * `fetch` reads that address's answers (the proxy's own refusals as sentences).
 */
export interface TransportAuth {
  readonly headers?: Readonly<Record<string, string>>;
  readonly authProvider?: AuthProvider;
  readonly url?: string;
  readonly fetch?: McpFetch;
}

/** Sign-ins for the hub (connectors). Absent: servers that sign in cannot connect. */
export class McpHubAuth extends Context.Service<
  McpHubAuth,
  { readonly transportAuth: (target: HubTarget & { readonly auth: NonNullable<HubTarget["auth"]> }) => Effect.Effect<TransportAuth, McpHubError> }
>()("caveman/plugins/McpHubAuth") {}

/** Runs the runtime's hook set around a tool call (hooks.ts). Absent: no hooks. */
export class McpHubHooks extends Context.Service<
  McpHubHooks,
  {
    /** A reason to refuse the call, or undefined to let it run. `signal` aborts when the call is stopped. */
    readonly before: (threadId: ThreadId, tool: string, input: unknown, signal?: AbortSignal) => Promise<string | undefined>;
    /** Text to hand the model with the result, or undefined. */
    readonly after: (threadId: ThreadId, tool: string, input: unknown, result: unknown) => Promise<string | undefined>;
  }
>()("caveman/plugins/McpHubHooks") {}

/** What a server's tool list measured: names, and the bytes of the schemas an engine is handed. */
export interface Measured {
  readonly tools: ReadonlyArray<string>;
  readonly bytes: number;
}

export interface McpTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

export class McpHub extends Context.Service<
  McpHub,
  {
    /** One JSON-RPC message from an engine for server `key`; undefined answers a notification. */
    readonly handle: (caller: HubCaller, key: string, message: unknown) => Effect.Effect<unknown>;
    /**
     * Connects outside any thread and lists the server's tools now: the check a person asks for (mcp.tools),
     * so it is bounded: a server that has not answered in PROBE_MS is closed and says so.
     */
    readonly tools: (server: HubServer) => Effect.Effect<ReadonlyArray<McpTool>, McpHubError>;
    /** What the server's last tool list measured, from any caller under any key. */
    readonly measured: (server: HubServer) => Option.Option<Measured>;
    /** Closes every connection to the server, in every thread's pool whatever key it has there (a sign-out or a changed server). */
    readonly disconnect: (server: HubServer) => Effect.Effect<void>;
  }
>()("caveman/plugins/McpHub") {}

/** Versions the hub answers with: the client's when it is one of these. */
const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
/** A connection nobody used for this long is closed. */
const IDLE_MS = 15 * 60_000;
/** The engine's own client times a call out; the hub waits longer so it never answers first. */
const CALL_TIMEOUT_MS = 30 * 60_000;
/** How long a person's tool-list check waits for a server to start and answer (npx's first download included). */
export const PROBE_MS = 60_000;

interface Connection {
  /** The server it is to (identity). */
  readonly server: string;
  readonly client: McpClient;
  readonly ready: Promise<void>;
  /** A stdio server's own words on stderr so far (its transport keeps them). */
  readonly stderr?: () => string;
  lastUsed: number;
  /** Opened with a service account's credential of this generation (accountCredentials.ts); never reused after it changes. */
  readonly account?: number;
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/**
 * Why a stdio server that never started says it stopped: the last line of its stderr that names an error
 * (`Error: Cannot find module './server.js'`, `can't open file`), else its last line; none that looks like
 * a credential. So a missing script, a failed install and a missing library read differently.
 */
export function lastWords(stderr: string): string | undefined {
  const lines = stderr.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  const line = [...lines].reverse().find((l) => /\berror\b|not found|no such file|cannot|can't|denied/i.test(l)) ?? lines.at(-1);
  return line === undefined || containsKnownSecret(line) ? undefined : line.slice(0, 300);
}
const rpcError = (id: unknown, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

/**
 * How the hub starts a stdio server. Here: as an engine would, the user's environment without the
 * runtime's own variables (the launcher in argv keeps only the plugin's allowlist from it). On a
 * Cloud computer: in the servers container (else the tools container) through its exec channel, with
 * exactly its configured environment, never beside runtime.key (cloudLink/tools.ts).
 */
export function stdioLaunch(server: Extract<PluginMcpServer, { readonly type: "stdio" }>, socket = toolsSocket()) {
  const env = withoutRuntimeEnv(process.env) as Record<string, string>;
  if (socket === undefined) {
    return { command: server.command, args: [...server.args], ...(server.cwd === undefined ? {} : { cwd: server.cwd }), env: { ...env, ...server.env } };
  }
  const routed = toolsCommand(socket, server.command, server.args, server.cwd, server.env, {});
  return { command: routed.command, args: [...routed.args], env: { ...env, ...routed.env } };
}

/**
 * An HTTP server's headers on a service account's computer: host-bound variables' stand-ins swapped in only for their
 * hosts, and a static_bearer token added only when the server's URL is under its match_url (and nothing else signs
 * it in). Elsewhere the headers as they are.
 */
export function accountHeaders(url: string, headers: Readonly<Record<string, string>>, signedIn: boolean): Record<string, string> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { ...headers };
  }
  const out = accountVault.swap({ ...headers }, target);
  const bearer = signedIn || Object.keys(out).some((name) => name.toLowerCase() === "authorization") ? undefined : accountVault.bearerFor(url);
  return bearer === undefined ? out : { ...out, Authorization: `Bearer ${bearer}` };
}

/** Schema bytes an engine is handed for these tools. */
export const schemaBytes = (tools: ReadonlyArray<McpTool>) => Buffer.byteLength(JSON.stringify(tools), "utf8");

export const make = Effect.gen(function* () {
  const registry = yield* PluginRegistry;
  const store = yield* Effect.serviceOption(SessionStore);
  const auth = yield* Effect.serviceOption(McpHubAuth);
  const hooks = yield* Effect.serviceOption(McpHubHooks);
  const config = yield* Effect.serviceOption(ServerConfig);
  const pool = new Map<string, Connection>();
  const measuredByServer = new Map<string, Measured>();

  const worktreeOf = (threadId: ThreadId | undefined) =>
    threadId === undefined || Option.isNone(store)
      ? Effect.succeed(undefined)
      : store.value.getByThread(threadId).pipe(
          Effect.map((record) => record?.internal.worktreePath || undefined),
          Effect.orElseSucceed(() => undefined),
        );

  const failed = (error: { readonly message: string }) => new McpHubError({ message: error.message, reason: "failed" });
  const notHere = (key: string) => new McpHubError({ message: `no MCP server ${key} here`, reason: "not_found" });
  /** The key `server` has in `session`, if it is on there. */
  const keyIn = (session: PluginSession, server: HubServer) =>
    [...serverKeys(session.plugins)].find(([, owner]) => owner.plugin.id === server.plugin && owner.server === server.server)?.[0];

  /**
   * The server a caller's `key` names: in a thread, the one its engine was given under that key (the thread's plugin
   * snapshot), whatever the key names for chats started since; elsewhere, the one it names now.
   */
  const serverFor = (threadId: ThreadId | undefined, key: string) =>
    Effect.gen(function* () {
      const session = yield* (threadId === undefined ? registry.session() : registry.forThread(threadId, yield* worktreeOf(threadId))).pipe(Effect.mapError(failed));
      const owner = serverKeys(session.plugins).get(key);
      const config = session.bundle.mcpServers[key];
      if (owner === undefined || config === undefined || config.type === "sse") return yield* notHere(key);
      return { plugin: owner.plugin.id, server: owner.server } satisfies HubServer;
    });

  /**
   * How `server` starts now where the caller works (a thread's worktree is a stdio server's write root), under whatever
   * key it has there: its launch, sign-in and credentials as they are now, so a sign-out or a revoked credential reaches
   * it when it next opens. `key` is what the caller calls it.
   */
  const targetFor = (threadId: ThreadId | undefined, server: HubServer, key: string) =>
    Effect.gen(function* () {
      const session = yield* registry.session(yield* worktreeOf(threadId)).pipe(Effect.mapError(failed));
      const here = keyIn(session, server);
      const config = here === undefined ? undefined : session.bundle.mcpServers[here];
      if (here === undefined || config === undefined || config.type === "sse") return yield* notHere(key);
      const signIn = session.remoteAuth[here];
      return { key, server: config, ...(signIn === undefined ? {} : { auth: signIn }) } satisfies HubTarget;
    });

  /** The key a server has where no thread is (the session a person's check opens it in). */
  const keyOutside = (server: HubServer) =>
    registry.session().pipe(
      Effect.mapError(failed),
      Effect.flatMap((session) => {
        const key = keyIn(session, server);
        return key === undefined ? Effect.fail(notHere(server.server)) : Effect.succeed(key);
      }),
    );

  const open = (given: HubTarget) =>
    Effect.gen(function* () {
      // A service account's mcp_oauth credential covering this server: its token is leased for match_url.
      const leasedFor = given.server.type === "http" && given.auth === undefined ? accountVault.oauthFor(given.server.url) : undefined;
      // Where the account's credentials stay outside the computer Cloud names them only: the server goes through
      // Cloud's connector proxy by that name, whichever kind of credential it is (accountCredentials.ts proxiedFor).
      const named = given.server.type === "http" && given.auth === undefined && leasedFor === undefined ? accountVault.proxiedFor(given.server.url) : undefined;
      const target: HubTarget =
        leasedFor !== undefined
          ? { ...given, auth: { auth: "oauth", url: leasedFor } }
          : named !== undefined && given.server.type === "http"
            ? { ...given, auth: { auth: "oauth", url: given.server.url, account: { id: named.id, matchUrl: named.match_url } } }
            : given;
      const signIn: TransportAuth =
        target.auth === undefined
          ? {}
          : Option.isNone(auth)
            ? yield* new McpHubError({ message: `${target.key} signs in, and this runtime has no sign-ins`, reason: "sign_in" })
            : yield* auth.value.transportAuth({ ...target, auth: target.auth });
      // A Cloud computer: in the servers container (its own uid, beside no agent process) when the pod has
      // one, else in the tools container; from its checkout, which both mount read-only.
      const servers = target.server.type === "stdio" ? yield* Effect.promise(() => liveServersSocket()) : undefined;
      // A pod that names a servers container which did not prove its token: something else may hold its address, so
      // a server with keys does not start, there or beside the agent. One without keys starts in tools, as before.
      if (target.server.type === "stdio" && servers === undefined && serversSocket() !== undefined && Object.keys(target.server.env ?? {}).length > 0) {
        return yield* new McpHubError({
          message: `${target.key} has keys, and this computer's servers container did not prove itself just now, so it does not start; try again in a minute, and restart the computer if it keeps failing`,
          reason: "failed",
        });
      }
      const socket = target.server.type === "stdio" ? (servers ?? toolsSocket()) : undefined;
      const server =
        socket !== undefined && target.server.type === "stdio" && Option.isSome(config)
          ? yield* Effect.tryPromise({
              try: () => forTools(socket, target.server as Extract<PluginMcpServer, { readonly type: "stdio" }>, config.value.stateDir),
              catch: (cause) => new McpHubError({ message: `${target.key}: ${errorText(cause)}`, reason: "failed" }),
            })
          : target.server;
      const transport =
        server.type === "stdio"
          ? new StdioTransport({ ...stdioLaunch(server, socket), inheritEnv: false, stderr: "pipe" })
          : new StreamableHttpTransport({
              // The sign-in's own address when it names one (Cloud's connector proxy), else the server's.
              url: signIn.url ?? server.url,
              headers: accountHeaders(server.url, { ...server.headers, ...signIn.headers }, signIn.authProvider !== undefined),
              ...(signIn.authProvider === undefined ? {} : { authProvider: signIn.authProvider }),
              ...(signIn.fetch === undefined ? {} : { fetch: signIn.fetch }),
              openGetStream: false,
            });
      const client = new McpClient({ name: "caveman-code", version: RUNTIME_VERSION, requestTimeoutMs: CALL_TIMEOUT_MS });
      const account = server.type === "http" && (leasedFor !== undefined || named !== undefined || accountVault.bearerFor(server.url) !== undefined) ? { account: accountVault.generation() } : {};
      return { client, ready: client.connect(transport).then(() => undefined), ...account, ...(transport instanceof StdioTransport ? { stderr: () => transport.stderr } : {}) };
    });

  /** Opens under way, by pool key: a request that finds one shares its connection instead of starting a second server. */
  const opening = new Map<string, Deferred.Deferred<Connection, McpHubError>>();

  /**
   * The pool's connection for `poolKey`, opened once however many requests miss it together: a second open would
   * start a second process, and the one the pool loses track of is never closed.
   */
  const pooled = (threadId: ThreadId | undefined, server: HubServer, key: string, poolKey: string): Effect.Effect<Connection, McpHubError> =>
    Effect.uninterruptibleMask((restore) => {
      const entry = pool.get(poolKey);
      if (entry !== undefined) return Effect.succeed(entry);
      const pending = opening.get(poolKey);
      if (pending !== undefined) {
        return restore(
          Deferred.await(pending).pipe(
            // Its opener was interrupted (a check that timed out) before it had a connection: this request opens one.
            Effect.catchCause((cause) => (Cause.hasInterruptsOnly(cause) ? pooled(threadId, server, key, poolKey) : Effect.failCause(cause))),
          ),
        );
      }
      const opened = Deferred.makeUnsafe<Connection, McpHubError>();
      opening.set(poolKey, opened);
      return restore(
        Effect.gen(function* () {
          const fresh: Connection = { ...(yield* open(yield* targetFor(threadId, server, key))), server: identity(server), lastUsed: Date.now() };
          pool.set(poolKey, fresh);
          fresh.client.onClose(() => pool.get(poolKey) === fresh && pool.delete(poolKey));
          fresh.ready.catch(() => {
            if (pool.get(poolKey) === fresh) pool.delete(poolKey);
            void fresh.client.close().catch(() => undefined);
          });
          return fresh;
        }),
      ).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            opening.delete(poolKey);
            Deferred.doneUnsafe(opened, exit);
          }),
        ),
      );
    });

  /**
   * A ready connection for the caller's thread to `server` (`key`: what the caller calls it), shared by its later requests.
   * Pooled by the server, not the key: a key can name another server for another caller or later on.
   */
  const connection = (threadId: ThreadId | undefined, server: HubServer, key: string) =>
    Effect.gen(function* () {
      const poolKey = `${threadId ?? ""}\0${identity(server)}`;
      const held = pool.get(poolKey);
      // The account's credentials changed or were withdrawn (disabled, shared computer): what it opened with goes.
      if (held?.account !== undefined && held.account !== accountVault.generation()) {
        pool.delete(poolKey);
        void held.client.close().catch(() => undefined);
      }
      const ready = yield* pooled(threadId, server, key, poolKey);
      ready.lastUsed = Date.now();
      yield* Effect.tryPromise({
        try: () => ready.ready,
        catch: (cause) => {
          const said = ready.stderr === undefined ? undefined : lastWords(ready.stderr());
          return new McpHubError({
            message: `${key}: ${errorText(cause)}${said === undefined ? "" : ` (it said: ${said})`}`,
            reason: /auth|401|sign.?in|unauthori[sz]ed/i.test(errorText(cause)) ? "sign_in" : "failed",
          });
        },
      });
      return ready;
    });

  const listTools = (connection: Connection) =>
    Effect.promise(() => connection.client.listTools()).pipe(
      Effect.tap((tools) => Effect.sync(() => measuredByServer.set(connection.server, { tools: tools.map((t) => t.name), bytes: schemaBytes(tools) }))),
    );

  // `signal` aborts when the request's fiber is interrupted: the engine's Stop closes its request to the hub.
  const call = (caller: HubCaller, key: string, client: McpClient, params: Record<string, unknown>) =>
    Effect.promise(async (signal) => {
      const name = String(params.name ?? "");
      const input = (params.arguments ?? {}) as Record<string, unknown>;
      // Claude Code names MCP tools this way, so a hook's matcher means the same in every engine.
      const tool = `mcp__${key}__${name}`;
      const runHooks = caller.hooks && caller.threadId !== undefined && Option.isSome(hooks) ? { threadId: caller.threadId, run: hooks.value } : undefined;
      const refused = runHooks === undefined ? undefined : await runHooks.run.before(runHooks.threadId, tool, input, signal);
      if (refused !== undefined) return { content: [{ type: "text", text: `Blocked by a hook: ${refused}` }], isError: true };
      signal.throwIfAborted();
      const result = await client.callTool(name, input, { signal });
      const note = runHooks === undefined ? undefined : await runHooks.run.after(runHooks.threadId, tool, input, result);
      return note === undefined ? result : { ...result, content: [...(result.content ?? []), { type: "text", text: note }] };
    });

  const handle = (caller: HubCaller, key: string, message: unknown): Effect.Effect<unknown> => {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return Effect.succeed(rpcError(null, -32600, "one JSON-RPC message per request"));
    }
    const { id, method, params } = message as { id?: unknown; method?: unknown; params?: Record<string, unknown> };
    // Notifications and responses need no answer: the hub keeps no session with the engine.
    if (id === undefined || typeof method !== "string") return Effect.succeed(undefined);
    const answer = Effect.gen(function* () {
      if (method === "ping") return {};
      const opened = yield* connection(caller.threadId, yield* serverFor(caller.threadId, key), key);
      const client = opened.client;
      switch (method) {
        case "initialize": {
          const asked = typeof params?.protocolVersion === "string" ? params.protocolVersion : "";
          return {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: key, version: RUNTIME_VERSION },
            ...(client.instructions === undefined ? {} : { instructions: client.instructions }),
          };
        }
        case "tools/list":
          return { tools: yield* listTools(opened) };
        case "tools/call":
          return yield* call(caller, key, client, params ?? {});
        default:
          return undefined;
      }
    });
    return answer.pipe(
      Effect.map((result) =>
        result === undefined ? rpcError(id, -32601, `${method} is not served by the hub`) : { jsonrpc: "2.0", id, result },
      ),
      Effect.catch((error) => Effect.succeed(rpcError(id, -32000, error.message))),
      Effect.catchDefect((defect) => Effect.succeed(rpcError(id, -32603, `${key}: ${errorText(defect)}`))),
    );
  };

  const closeWhere = (pick: (poolKey: string, entry: Connection) => boolean) =>
    Effect.promise(() =>
      Promise.allSettled(
        [...pool].filter(([poolKey, entry]) => pick(poolKey, entry)).map(([poolKey, entry]) => {
          pool.delete(poolKey);
          return entry.client.close();
        }),
      ),
    ).pipe(Effect.asVoid);

  yield* closeWhere((_, entry) => Date.now() - entry.lastUsed > IDLE_MS).pipe(
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() => closeWhere(() => true));

  return McpHub.of({
    handle,
    tools: (server) =>
      keyOutside(server).pipe(
        Effect.flatMap((key) =>
          connection(undefined, server, key).pipe(
            Effect.flatMap(listTools),
            // A server that fails its tool list answers as a failed check, never a runtime error.
            Effect.catchDefect((defect) => Effect.fail(new McpHubError({ message: `${key}: ${errorText(defect)}`, reason: "failed" }))),
            Effect.timeoutOrElse({
              duration: `${PROBE_MS} millis`,
              // Only the check's own connection goes; a chat's stays.
              orElse: () =>
                closeWhere((poolKey) => poolKey === `\0${identity(server)}`).pipe(
                  Effect.andThen(Effect.fail(new McpHubError({ message: `${key} did not start and list its tools within ${PROBE_MS / 1000} s`, reason: "failed" }))),
                ),
            }),
          ),
        ),
      ),
    measured: (server) => Option.fromNullishOr(measuredByServer.get(identity(server))),
    disconnect: (server) => closeWhere((_, entry) => entry.server === identity(server)),
  });
});

export const layer = Layer.effect(McpHub, make);

const json = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });

/**
 * `POST /mcp/hub/<key>`: one JSON-RPC message from an engine, answered as
 * JSON. Only a thread's runtime MCP credential gets in (never an OAuth
 * client from outside). `?hooks=1` asks for the runtime's hook set.
 */
export const layerRoute = Layer.unwrap(
  Effect.gen(function* () {
    const hub = yield* McpHub;
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    return HttpRouter.add(
      "*",
      `${MCP_HUB_PATH}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        // No server-to-client stream and no session to end: the hub answers each request on its own.
        if (request.method !== "POST") return HttpServerResponse.empty({ status: 405, headers: { allow: "POST" } });
        const url = HttpServerRequest.toURL(request);
        if (Option.isNone(url)) return json(rpcError(null, -32600, "bad request"), 400);
        const key = decodeURIComponent(url.value.pathname.slice(`${MCP_HUB_PATH}/`.length));
        const authorization = request.headers.authorization ?? "";
        const token = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length).trim() : "";
        const invocation = token === "" ? undefined : yield* registry.resolve(token);
        if (invocation === undefined) {
          return json({ error: "invalid_mcp_credential", message: "A valid Caveman Code MCP credential is required." }, 401);
        }
        const body = yield* Effect.option(request.json);
        if (Option.isNone(body)) return json(rpcError(null, -32700, "the body is not JSON"), 400);
        const answer = yield* hub.handle(
          { threadId: invocation.thread?.threadId, hooks: url.value.searchParams.get("hooks") === "1" },
          key,
          body.value,
        );
        return answer === undefined ? HttpServerResponse.empty({ status: 202 }) : json(answer);
      }),
    );
  }),
);

/**
 * The hub's side of the hook set: a thread's trusted hooks around its MCP
 * calls, from the bundle its worktree would get now.
 * ponytail: a runner per thread cached for a minute; rebuilt each time after that.
 */
export const layerHubHooks = Layer.effect(
  McpHubHooks,
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    const store = yield* Effect.serviceOption(SessionStore);
    const cache = new Map<string, { readonly at: number; readonly hooks: RuntimeHooks | undefined }>();
    const runnerFor = (threadId: ThreadId) =>
      Effect.gen(function* () {
        const hit = cache.get(threadId);
        if (hit !== undefined && Date.now() - hit.at < 60_000) return hit.hooks;
        const record = Option.isSome(store) ? yield* store.value.getByThread(threadId).pipe(Effect.orElseSucceed(() => undefined)) : undefined;
        const worktree = record?.internal.worktreePath || undefined;
        const session = yield* registry.session(worktree).pipe(Effect.orElseSucceed(() => undefined));
        const hooks = session === undefined ? undefined : makeHookRunner(session.bundle, { sessionId: threadId, cwd: worktree ?? process.cwd() });
        cache.set(threadId, { at: Date.now(), hooks });
        return hooks;
      });
    const runner = (threadId: ThreadId) => Effect.runPromise(runnerFor(threadId));
    return McpHubHooks.of({
      before: async (threadId, tool, input, signal) => (await runner(threadId))?.preToolUse(tool, input, signal),
      after: async (threadId, tool, input, result) => (await runner(threadId))?.postToolUse(tool, input, result),
    });
  }),
);
