/**
 * EgressScrub - the loopback proxy every engine's model traffic goes through,
 * so a project secret never reaches a model provider. Claude Agent and Codex
 * run their tool loop in their own process: `cat .env` output goes straight
 * into their next model request, past every scrub the runtime does on events.
 * This is the one place that sees those requests.
 *
 * Each request body is buffered, decompressed, scrubbed as raw text (every
 * JSON string is covered, in every form `createScrubber` knows) and forwarded
 * to the real upstream with the engine's own headers: its API key or OAuth
 * bearer passes through and is never stored or logged. The scrubbed body goes
 * out gzipped to an upstream known to take it (Anthropic's API; Claude Code
 * gzips its own requests there, but not to a loopback base URL like this
 * one), uncompressed to every other. Responses
 * stream back byte for byte (SSE stays incremental). Anything that cannot be
 * scrubbed (an unknown encoding, a body that is not UTF-8, a scrubber error)
 * gets a 502 and nothing is forwarded. WebSocket upgrades are refused, so an
 * engine falls back to HTTP; engines are configured not to try them.
 *
 * Only 127.0.0.1, and every URL carries a per-runtime random token, so other
 * local processes cannot use it as an open relay.
 *
 * On a Cloud computer whose person's credentials stay outside it
 * (cloudLink/credentialRule.ts) this process holds no token or key to swap in.
 * A request carrying one of the stand-ins its engines were launched with
 * (cloudLink/modelConnections.ts) goes, scrubbed the same way and only on the
 * endpoints listed below, to Cloud's data plane with the runtime's own token
 * and the connection's id; the data plane attaches the real credential there
 * (`forwardOutside`).
 *
 * On a Mac whose person connected a plan once (cloudLink/macConnections.ts) the
 * engine holds the same kind of stand-in, and the real credential goes in here,
 * on the same endpoints: the sealed Claude token, or the short-lived compact
 * access token Cloud hands out. A plan its provider calls used up is passed
 * over for the next connection in the person's order, as on a Cloud computer.
 *
 * Spec: docs/
 *
 * @module EgressScrub
 */
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import * as NodeUtil from "node:util";
import * as NodeZlib from "node:zlib";

import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import { createScrubber, type Scrubber } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { CALL_TIMEOUT_MS } from "../cloudLink/computers.ts";
import { leasedTokens } from "../cloudLink/connections.ts";
import { ruleOf } from "../cloudLink/credentialRule.ts";
import { vaultKeyFor } from "../cloudLink/engineKeys.ts";
import { CODEX_LOGIN_REFRESH, followedLogins, followedTokens, type FollowedEngine, type FollowedLogins } from "../cloudLink/engineLogins.ts";
import { CloudLinkState } from "../cloudLink/index.ts";
import { egressRuns, macConnectionsOf, type LocalPlane } from "../cloudLink/macConnections.ts";
import { connectionsOf, laneOf, RATE_MESSAGE, UPSTREAM_MESSAGE, type Issued, type ModelConnection, type OutsideConnections } from "../cloudLink/modelConnections.ts";
import { credentialRefused, planUsedUp } from "../cloudLink/providerSignals.ts";
import { grantedCredentials } from "../plugins/CredentialBroker.ts";
import { providerKeyValues } from "../provider/ProviderKeySeal.ts";
import { ROUTER_SESSION_HEADER } from "../router/cavemanRouter.ts";
import { APP_CLAUDE_AGENT, APP_CODEX_AGENT, appProxyTokens, appProxyUrl, codexProxyUrl } from "../router/proxyLauncher.ts";
import { accountVault } from "../cloudLink/accountCredentials.ts";
import { ProjectSecrets } from "./ProjectSecrets.ts";
import { secretProviderValues } from "./secretProviderValues.ts";

/**
 * Upstream for Codex on the built-in OpenAI provider: its API for an API key,
 * compact Codex backend for a compact login (whose requests carry
 * `compact-account-id`), which is the choice Codex itself makes.
 */
export const OPENAI_AUTO_UPSTREAM = "openai:auto";
const OPENAI_API = "https://api.openai.com/v1";
const CHATGPT_CODEX = "https://chatgpt.com/backend-api/codex";
const ANTHROPIC_API = "https://api.anthropic.com";

/**
 * Upstreams through the app's own caveman-proxies (proxyLauncher.ts): Claude
 * Agent's Anthropic traffic (and OpenCode's two providers) on the one that
 * compresses only what carries caveman_retrieve, Codex's on the built-in
 * OpenAI provider on Codex's own (the compact route for a compact login).
 * Resolved per request, so a chat on a chosen model still runs, direct,
 * while its proxy is down.
 */
export const ANTHROPIC_VIA_PROXY = "caveman-proxy:anthropic";
export const OPENAI_VIA_PROXY = "caveman-proxy:openai";
export const CODEX_VIA_PROXY = "caveman-proxy:codex";

/** Where a request for `upstream` goes now, by its compact account header. */
export function resolveUpstream(upstream: string, chatgpt: boolean, proxy: string | undefined = appProxyUrl(), codex: string | undefined = codexProxyUrl()): string {
  const openai = (via: string | undefined) =>
    via === undefined ? resolveUpstream(OPENAI_AUTO_UPSTREAM, chatgpt) : chatgpt ? `${via}/chatgpt` : `${via}/w/${APP_CODEX_AGENT}/v1`;
  switch (upstream) {
    case OPENAI_AUTO_UPSTREAM:
      return chatgpt ? CHATGPT_CODEX : OPENAI_API;
    case ANTHROPIC_VIA_PROXY:
      return proxy === undefined ? ANTHROPIC_API : `${proxy}/w/${APP_CLAUDE_AGENT}`;
    case OPENAI_VIA_PROXY:
      return openai(proxy);
    case CODEX_VIA_PROXY:
      return openai(codex);
    default:
      return upstream;
  }
}

export interface EgressProxy {
  readonly port: number;
  /** The per-runtime path token: never shown anywhere (see `layer`). */
  readonly token: string;
  /** The loopback base URL that forwards, scrubbed, to `upstream`. */
  readonly route: (upstream: string) => string;
  /** Whether `url` is one of this proxy's routes (never route a route). */
  readonly owns: (url: string) => boolean;
  readonly close: () => Promise<void>;
}

const REQUEST_DROP = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
]);
/**
 * A stream's last event (Responses completed, failed or incomplete; Messages; Chat Completions), at the start of
 * an SSE line: what a model writes is JSON inside a data line, whose newlines are escaped, so it never starts one.
 */
const STREAM_END =
  /[\r\n](?:event: ?(?:response\.(?:completed|failed|incomplete)|message_stop)|data: ?(?:\[DONE\]|\{"type": ?"(?:response\.(?:completed|failed|incomplete)|message_stop)"))/;
/** How long an upstream may take to end a finished answer the engine stopped reading before it is cut. */
const DRAIN_MS = 10_000;
/** Methods that change nothing upstream: the only ones sent again (a model call is a POST and is never sent twice). */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const RESPONSE_DROP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "trailer"]);

/** Undoes every content-encoding, last applied first. Throws on one it does not know. */
export function decodeBody(body: Buffer, contentEncoding: string | undefined): Buffer {
  const codings = (contentEncoding ?? "")
    .split(",")
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding !== "" && coding !== "identity")
    .reverse();
  let out = body;
  for (const coding of codings) {
    if (coding === "gzip" || coding === "x-gzip") out = NodeZlib.gunzipSync(out);
    else if (coding === "deflate") out = NodeZlib.inflateSync(out);
    else if (coding === "br") out = NodeZlib.brotliDecompressSync(out);
    else if (coding === "zstd") out = NodeZlib.zstdDecompressSync(out);
    else throw new Error(`unsupported content-encoding ${coding}`);
  }
  return out;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** The body as the upstream may see it. Throws when it cannot be scrubbed. */
export function scrubBody(body: Buffer, contentEncoding: string | undefined, scrubber: Scrubber): Buffer {
  if (body.length === 0) return body;
  return Buffer.from(scrubber.scrub(utf8.decode(decodeBody(body, contentEncoding))), "utf8");
}

/**
 * Where a gzip request body is known to work: Anthropic's Messages API, the
 * request that grows every turn (proven with real Claude turns). Every other
 * upstream and endpoint may not take one, so it gets the body plain.
 */
const takesGzip = (target: URL) => target.origin === "https://api.anthropic.com" && target.pathname === "/v1/messages";
const gzip = NodeUtil.promisify(NodeZlib.gzip);

/** The scrubbed body as `target` gets it: gzipped (off the event loop) where the upstream takes that. */
export async function encodeForUpstream(
  body: Buffer,
  target: URL,
): Promise<{ readonly body: Buffer; readonly encoding?: "gzip" }> {
  if (body.length === 0 || !takesGzip(target)) return { body };
  return { body: await gzip(body), encoding: "gzip" };
}

/** Anthropic's API, or the app's proxy route for Claude Agent, which forwards to it. */
const toAnthropic = (target: URL) => {
  const proxy = appProxyUrl();
  return target.origin === ANTHROPIC_API || (proxy !== undefined && target.href.startsWith(`${proxy}/w/${APP_CLAUDE_AGENT}/`));
};

/**
 * The endpoints a followed sign-in's token goes to (security finding L-2): the requests the pinned CLIs make through
 * the scrub, by method and path, nothing else on those hosts. Paths are the target's normalized pathname (`..` and
 * `%2e` already resolved by URL), taken relative to the provider's API root: Anthropic's API, or the app proxy's
 * Claude route; compact Codex backend, or the proxies' compact route.
 */
const FOLLOWED_ENDPOINTS: Record<FollowedEngine, ReadonlyArray<readonly [method: string, path: RegExp]>> = {
  "claude-agent": [
    ["POST", /^\/v1\/messages$/],
    ["POST", /^\/v1\/messages\/count_tokens$/],
    ["POST", /^\/v1\/messages\/cache_touch$/],
    ["GET", /^\/v1\/models$/],
    ["GET", /^\/v1\/models\/[A-Za-z0-9._@-]+$/],
  ],
  codex: [
    ["POST", /^\/responses$/],
    ["POST", /^\/responses\/compact$/],
    ["GET", /^\/models$/],
  ],
};

/** `target`'s path under the engine's provider root, or undefined when it is not under it. */
const providerPath = (engine: FollowedEngine, target: URL): string | undefined => {
  const under = (prefix: string) => (target.pathname === prefix ? "/" : target.pathname.startsWith(`${prefix}/`) ? target.pathname.slice(prefix.length) : undefined);
  const routeOf = (base: string | undefined, route: string) => (base !== undefined && target.origin === new URL(base).origin ? under(`${new URL(base).pathname.replace(/\/+$/, "")}${route}`) : undefined);
  if (engine === "claude-agent") {
    if (target.origin === ANTHROPIC_API) return target.pathname;
    return routeOf(appProxyUrl(), `/w/${APP_CLAUDE_AGENT}`);
  }
  if (target.origin === new URL(CHATGPT_CODEX).origin) return under(new URL(CHATGPT_CODEX).pathname);
  return routeOf(appProxyUrl(), "/chatgpt") ?? routeOf(codexProxyUrl(), "/chatgpt");
};

/** Claude Platform's exact token exchange, on Anthropic or the app-owned Claude routes (bare and named).
 * Authentication is not inference: it must not depend on the model proxy's routes, routing or credentials.
 * Custom bases, other named providers, other methods and encoded/near-matching paths are deliberately excluded.
 */
const claudeTokenExchange = (method: string | undefined, target: URL): boolean => {
  if (method !== "POST") return false;
  if (providerPath("claude-agent", target) === "/v1/oauth/token") return true;
  const proxy = appProxyUrl();
  if (proxy === undefined) return false;
  const root = new URL(proxy);
  return target.origin === root.origin && target.pathname === `${root.pathname.replace(/\/+$/, "")}/v1/oauth/token`;
};

/** Whether a followed sign-in's token may go with this request: its provider, on an endpoint its CLI uses. */
export const followedEndpoint = (engine: FollowedEngine, method: string | undefined, target: URL): boolean => {
  const at = providerPath(engine, target);
  return at !== undefined && FOLLOWED_ENDPOINTS[engine].some(([m, p]) => m === method && p.test(at));
};

/**
 * Where a request made on a stand-in goes under the rule: the path the data plane takes for the engine's lane
 * (CONTRACT §3), or undefined when it is not one of the endpoints that lane serves (it then goes on as it came, its
 * stand-in worth nothing). Claude's from Anthropic's root (`/v1/messages`); Codex's from its backend's root, compact
 * or OpenAI's API (`/responses`); the Caveman engine's from its provider's host.
 */
const outsidePath = (issued: Issued, method: string | undefined, target: URL): string | undefined => {
  if (issued.engine === "caveman") return target.pathname;
  const underOpenAi = () => {
    const roots = [OPENAI_API, ...[appProxyUrl(), codexProxyUrl()].flatMap((proxy) => (proxy === undefined ? [] : [`${proxy}/w/${APP_CODEX_AGENT}/v1`]))];
    for (const root of roots) {
      const base = new URL(root);
      const prefix = base.pathname.replace(/\/+$/, "");
      if (target.origin === base.origin && target.pathname.startsWith(`${prefix}/`)) return target.pathname.slice(prefix.length);
    }
    return undefined;
  };
  const at = providerPath(issued.engine, target) ?? (issued.engine === "codex" ? underOpenAi() : undefined);
  return at !== undefined && FOLLOWED_ENDPOINTS[issued.engine].some(([m, p]) => m === method && p.test(at)) ? at : undefined;
};

/** Cloud's data plane, as the scrub reaches it under the rule. */
export interface DataPlane {
  /** This runtime's connections: what each stand-in stands for, and what the data plane said since. */
  readonly connections: OutsideConnections;
  /** Cloud's origin: the data plane is under `/relay/v1/engine/`. */
  readonly cloudUrl: string;
  /** The runtime's token: the link's, or one newer than `stale`, which Cloud just refused. */
  readonly token: (stale?: string) => Promise<string>;
}

/** What the caller's request may not carry to the data plane, which sets the real ones (CONTRACT §3). */
const OUTSIDE_DROP = new Set(["authorization", "x-api-key", "cookie", "chatgpt-account-id"]);
/** The data plane's answers the scrub reads whole before the engine sees anything: Cloud's refusals are this small. */
const OUTSIDE_ANSWER_MAX = 256 * 1024;

/** An error as the engine's own client reads its provider's: Anthropic's shape for Claude, OpenAI's for the others. */
const engineError = (issued: Issued, status: number, message: string) => {
  const kind = status === 429 ? "rate_limit_error" : status === 402 ? "billing_error" : status === 403 ? "permission_error" : "api_error";
  return issued.engine === "claude-agent" || issued.provider === "anthropic" ? { type: "error", error: { type: kind, message } } : { error: { message, type: kind, code: kind } };
};

/** A JSON body, or undefined. */
const jsonOf = (body: Buffer): unknown => {
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    return undefined;
  }
};

const answer = (res: NodeHttp.ServerResponse, status: number, body: Record<string, unknown>) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) });
  res.end(text);
};

/**
 * OpenAI's API, or either app proxy's route for Codex on an API key, which forwards to it: Codex's own for its chats
 * (CODEX_VIA_PROXY), the retrieve-gated one for its text generation (OPENAI_VIA_PROXY).
 */
const toOpenAi = (target: URL) =>
  target.origin === new URL(OPENAI_API).origin ||
  [codexProxyUrl(), appProxyUrl()].some((proxy) => proxy !== undefined && target.href.startsWith(`${proxy}/w/${APP_CODEX_AGENT}/`));

const fail = (res: NodeHttp.ServerResponse, status: number, message: string) => {
  if (res.headersSent) return void res.destroy();
  const body = JSON.stringify({ type: "error", error: { type: "caveman_egress_scrub", message } });
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
};

export function startEgressProxy(input: {
  /** The scrubber for this request: rebuilt by ProjectSecrets on every change. */
  readonly scrubber: () => Scrubber | Promise<Scrubber>;
  /** DRAIN_MS; tests shorten it. */
  readonly drainMs?: number;
  /** This runtime's followed sign-ins (cloudLink/engineLogins.ts); tests give each pretend computer its own. */
  readonly logins?: FollowedLogins;
  /** Cloud's data plane while credentials stay outside this computer; undefined everywhere else. */
  readonly dataPlane?: () => DataPlane | undefined;
  /** This Mac's connections while it is signed in to Caveman (cloudLink/macConnections.ts); undefined everywhere else. */
  readonly localPlane?: () => LocalPlane | undefined;
}): Promise<EgressProxy> {
  const logins = input.logins ?? followedLogins;
  const token = NodeCrypto.randomBytes(32).toString("hex");
  const routes = new Map<string, string>();
  let origin = "";

  const handle = async (req: NodeHttp.IncomingMessage, res: NodeHttp.ServerResponse) => {
    const raw = req.url ?? "/";
    const query = raw.indexOf("?");
    const path = query === -1 ? raw : raw.slice(0, query);
    const [, givenToken = "", routeId = "", ...rest] = path.split("/");
    const tokenOk =
      givenToken.length === token.length &&
      NodeCrypto.timingSafeEqual(Buffer.from(givenToken), Buffer.from(token));
    if (!tokenOk) return fail(res, 403, "Not a Caveman egress route.");
    const upstream = routes.get(routeId);
    if (upstream === undefined) return fail(res, 404, "Unknown Caveman egress route.");

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    // codex's refresh on a sign-in that follows the person (its CODEX_REFRESH_TOKEN_URL_OVERRIDE): answered here with
    // stand-ins after Cloud's refresh. Nothing on this route is ever forwarded.
    if (upstream === CODEX_LOGIN_REFRESH) {
      let refresh: unknown;
      try {
        refresh = jsonOf(decodeBody(Buffer.concat(chunks), req.headers["content-encoding"]));
      } catch {
        refresh = undefined;
      }
      // Under the rule the stand-ins are the connection's (modelConnections.ts): Cloud is asked nothing.
 // On a Mac likewise, for a codex launched on a connection: Cloud alone refreshes a compact sign-in.
      const outside = input.dataPlane?.() ?? input.localPlane?.();
      const answered = outside === undefined ? await logins.answerRefresh("codex", refresh) : outside.connections.answerCodexRefresh(refresh);
      return answer(res, answered.status, answered.body);
    }
    let body: Buffer;
    try {
      body = scrubBody(Buffer.concat(chunks), req.headers["content-encoding"], await input.scrubber());
    } catch (cause) {
      // Fail closed: an unscrubbed body never leaves.
      return fail(res, 502, `Caveman could not check this request for project secrets, so it was not sent (${cause instanceof Error ? cause.message : "scrub failed"}).`);
    }

    const base = resolveUpstream(upstream, req.headers["chatgpt-account-id"] !== undefined);
    const requested = new URL(base.replace(/\/+$/, "") + "/" + rest.join("/") + (query === -1 ? "" : raw.slice(query)));
    const tokenExchange = claudeTokenExchange(req.method, requested);
    let target = tokenExchange ? new URL(`${ANTHROPIC_API}/v1/oauth/token${requested.search}`) : requested;
    // Credentials stay outside this computer: a request on a stand-in leaves through Cloud's data plane.
    const plane = input.dataPlane?.();
    const local = plane === undefined ? input.localPlane?.() : undefined;
    const standIn = (plane ?? local)?.connections.issuedIn(req.headers);
    const outsideAt = standIn === undefined || tokenExchange ? undefined : outsidePath(standIn.issued, req.method, requested);
    if (plane !== undefined && standIn !== undefined && outsideAt !== undefined) {
      return forwardOutside(plane, standIn, `${outsideAt}${requested.search}`, req, res, body);
    }
    // On a Mac the stand-in stands for a connection the person made once: its real credential goes in here, on the
    // same endpoints, and the request goes where the engine's own would have. `own` is that connection for this request.
    let own: { readonly plane: LocalPlane; readonly issued: Issued; readonly names: ReadonlyArray<string>; readonly at: string; readonly session: string | undefined; readonly tried: Set<string>; connection: ModelConnection; credential: Readonly<Record<string, string>>; resent: boolean } | undefined;
    /** The next connection of `run`'s that serves and whose credential can be had, from `candidate` on; false when none is left. */
    const aim = async (run: NonNullable<typeof own> | Omit<NonNullable<typeof own>, "connection" | "credential">, candidate: ModelConnection | undefined): Promise<boolean> => {
      let connection = candidate;
      while (connection !== undefined && !run.tried.has(connection.id)) {
        run.tried.add(connection.id);
        const credential = await run.plane.credential(connection);
        if (credential !== undefined) {
          own = { ...run, connection, credential };
 // Codex's compact backend for a compact plan, OpenAI's API for a key: the choice codex itself makes.
          if (run.issued.engine === "codex") target = new URL(`${resolveUpstream(upstream, connection.kind === "chatgpt_plan").replace(/\/+$/, "")}${run.at}${requested.search}`);
          return true;
        }
        const serving: ReadonlyArray<ModelConnection> = await run.plane.connections.serving(run.issued.engine, run.issued.engine === "caveman" ? run.issued.provider : undefined).catch(() => []);
        connection = serving.find((c) => !run.tried.has(c.id));
      }
      return false;
    };
    if (local !== undefined && standIn !== undefined && outsideAt !== undefined) {
      const session = typeof req.headers[ROUTER_SESSION_HEADER] === "string" ? (req.headers[ROUTER_SESSION_HEADER] as string) : undefined;
      const run = { plane: local, issued: standIn.issued, names: standIn.names, at: outsideAt, session, tried: new Set<string>(), resent: false };
      if (!(await aim(run, await local.connections.routeFor(standIn.issued)))) {
        // Nothing the person connected can pay for this now: the engine reads why, and the chat says it and asks
        // before credits.
        return answer(res, 402, engineError(standIn.issued, 402, await local.connections.noConnection(standIn.issued, session, "mac")));
      }
    }
    const sent = await encodeForUpstream(body, target);
    // The engine hung up while its body was scrubbed or compressed: send nothing.
    if (res.destroyed) return;
    const headers: NodeHttp.OutgoingHttpHeaders = {};
    const toAppProxy = [appProxyUrl(), codexProxyUrl()].some((url) => url !== undefined && (target.href === url || target.href.startsWith(`${url}/`)));
    for (const [name, value] of Object.entries(req.headers)) {
      if (value !== undefined && !REQUEST_DROP.has(name) && (toAppProxy || !name.startsWith("x-cave-"))) headers[name] = value;
    }
    if (sent.encoding !== undefined) headers["content-encoding"] = sent.encoding;
    // Claude Agent on a Cloud computer holds a stand-in for the person's vault key (cloudLink/engineKeys.ts): the
    // key goes in here, and only on its way to Anthropic, directly or through the app's proxy for Claude Agent.
    const apiKey = headers["x-api-key"];
    const vaulted = typeof apiKey === "string" ? vaultKeyFor(apiKey) : undefined;
    if (!tokenExchange && vaulted !== undefined && toAnthropic(target)) headers["x-api-key"] = vaulted;
    // Codex's likewise, as its bearer, only on its way to OpenAI's API.
    const bearer = typeof headers.authorization === "string" && headers.authorization.startsWith("Bearer ") ? headers.authorization.slice("Bearer ".length) : undefined;
    const openAiKey = bearer === undefined ? undefined : vaultKeyFor(bearer, "codex");
    if (openAiKey !== undefined && toOpenAi(target)) headers.authorization = `Bearer ${openAiKey}`;
 // A claude.ai or compact sign-in that follows the person (cloudLink/engineLogins.ts): the CLI holds a stand-in, and
    // the real access token goes in here, only on its way to that sign-in's own provider. Anywhere else the stand-in
    // goes as it came.
    // Only on the endpoints its CLI uses there (followedEndpoint): anything else on those hosts gets the stand-in.
    const followedEngine: FollowedEngine | undefined =
      bearer === undefined
        ? undefined
        : logins.owns("claude-agent", bearer) && followedEndpoint("claude-agent", req.method, target)
          ? "claude-agent"
          : logins.owns("codex", bearer) && followedEndpoint("codex", req.method, target)
            ? "codex"
            : undefined;
    // Claude's refresh at its base URL (a Claude Platform profile refreshes there): one carrying this runtime's
    // stand-in is answered here and never forwarded; any other goes on as it came.
    if (toAnthropic(target) && req.method === "POST" && target.pathname.endsWith("/v1/oauth/token")) {
      const refresh = jsonOf(body);
      if (refresh !== null && typeof refresh === "object" && logins.ownsRefresh("claude-agent", (refresh as { refresh_token?: unknown }).refresh_token)) {
        const answered = await logins.answerRefresh("claude-agent", refresh);
        return answer(res, answered.status, answered.body);
      }
    }
    let followed: { engine: FollowedEngine; token: string; version: number; resent: boolean } | undefined;
    if (followedEngine !== undefined) {
      const swapped = await logins.swap(followedEngine, bearer);
      if (swapped !== undefined) {
        followed = { ...swapped, resent: false };
        headers.authorization = `Bearer ${swapped.token}`;
      }
      // The engine hung up while the token was fetched: send nothing.
      if (res.destroyed) return;
    }
    // A service account's host-bound variable (cloudLink/accountCredentials.ts): its value only toward its hosts.
    // A token grant authenticates itself: never attach a vault/service-account credential to it.
    if (!tokenExchange) Object.assign(headers, accountVault.swap(headers, target));
    /** The request's own credential headers out, the connection's in. */
    const carry = (run: NonNullable<typeof own>) => {
      for (const name of [...OUTSIDE_DROP, ...run.names]) delete headers[name];
      Object.assign(headers, run.credential);
    };
    if (own !== undefined) carry(own);
    /**
     * What a provider's refusal means for the connection the request went on (cloudLink/providerSignals.ts), and
     * whether the request goes once more: on the next connection when its plan is used up or its credential is over,
     * on the same one when Cloud had a newer token.
     */
    const again = async (run: NonNullable<typeof own>, status: number, answerHeaders: NodeHttp.IncomingHttpHeaders, raw: Buffer): Promise<boolean> => {
      let text = "";
      try {
        text = decodeBody(raw, typeof answerHeaders["content-encoding"] === "string" ? answerHeaders["content-encoding"] : undefined).toString("utf8");
      } catch {
        // An answer that cannot be read says nothing.
      }
      const usedUp = planUsedUp(run.connection.kind, status, answerHeaders, text, Date.now());
      let next: ModelConnection | undefined;
      if (usedUp !== undefined) {
        run.plane.usedUp(run.connection, usedUp.until);
        next = await run.plane.connections.usedUp(run.issued, run.connection.id, usedUp.until === undefined ? undefined : new Date(usedUp.until).toISOString(), run.session);
      } else if (credentialRefused(run.connection.kind, status, text)) {
        if (!run.resent && (await run.plane.refused(run.connection))) {
          run.resent = true;
          run.tried.delete(run.connection.id);
          next = run.connection;
        } else next = await run.plane.connections.routeFor(run.issued);
      } else return false;
      if (!(await aim(run, next)) || own === undefined) return false;
      carry(own);
      return true;
    };
 // The proxy's compact route has no agent slug in its path, as /w/<agent> has: name the app's Codex, as Auto does.
    if (toAppProxy && (upstream === OPENAI_VIA_PROXY || upstream === CODEX_VIA_PROXY) && base.endsWith("/chatgpt")) headers["x-cave-agent"] = APP_CODEX_AGENT;
    if (sent.body.length > 0 || (req.method !== "GET" && req.method !== "HEAD")) headers["content-length"] = sent.body.length;

    // A kept-alive socket the upstream closed as this request went out fails with ECONNRESET before any
    // answer: a safe request is sent once more on a fresh socket (Node's own advice for `reusedSocket`). Any
    // other gets the 502: no answer does not mean the upstream never read it, and the engine decides on a retry.
    let upstreamRequest: NodeHttp.ClientRequest;
    const send = (retry: boolean) => {
      upstreamRequest = (target.protocol === "https:" ? NodeHttps : NodeHttp).request(target, {
        method: req.method,
        headers,
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        // A connection's request the provider refused (a plan used up, a credential that is over): held, small as it
        // is, until it is known whether the request goes again on another connection; else it goes back as it came.
        const status = upstreamResponse.statusCode ?? 502;
        if (own !== undefined && (status === 401 || status === 403 || status === 429)) {
          const run = own;
          const held: Buffer[] = [];
          let size = 0;
          let passing = false;
          const head = () => {
            const out: NodeHttp.OutgoingHttpHeaders = {};
            for (const [name, value] of Object.entries(upstreamResponse.headers)) if (value !== undefined && !RESPONSE_DROP.has(name)) out[name] = value;
            return out;
          };
          upstreamResponse.on("error", () => res.destroy());
          upstreamResponse.on("data", (chunk: Buffer) => {
            if (passing) return void res.write(chunk);
            held.push(chunk);
            size += chunk.length;
            if (size <= OUTSIDE_ANSWER_MAX) return;
            passing = true;
            res.writeHead(status, upstreamResponse.statusMessage, head());
            for (const piece of held) res.write(piece);
          });
          upstreamResponse.on("end", () => {
            if (passing) return void res.end();
            const raw = Buffer.concat(held);
            void again(run, status, upstreamResponse.headers, raw)
              .catch(() => false)
              .then((resend) => {
                if (res.destroyed) return;
                if (resend) return send(false);
                const { "content-length": _length, ...rest } = head();
                res.writeHead(status, upstreamResponse.statusMessage, { ...rest, "content-length": raw.length });
                res.end(raw);
              });
          });
          return;
        }
        // The provider refused a followed sign-in's token before answering anything: another computer may have
        // rotated it, or it expired. Hold the refusal, get a newer token (one round per engine, however many
        // requests ask), and send once more with it; with no newer token the refusal goes back as it came.
        if (followed !== undefined && !followed.resent && upstreamResponse.statusCode === 401) {
          const held = followed;
          held.resent = true;
          const refusal: Buffer[] = [];
          upstreamResponse.on("data", (chunk: Buffer) => refusal.push(chunk));
          upstreamResponse.on("error", () => res.destroy());
          upstreamResponse.on("end", () => {
            void logins.renew(held.engine, held.version, "refused").then((renewed) => {
              if (res.destroyed) return;
              if (renewed !== undefined && renewed.access !== held.token) {
                held.token = renewed.access;
                held.version = renewed.version;
                headers.authorization = `Bearer ${renewed.access}`;
                return send(false);
              }
              const refusalHeaders: NodeHttp.OutgoingHttpHeaders = {};
              for (const [name, value] of Object.entries(upstreamResponse.headers)) {
                if (value !== undefined && !RESPONSE_DROP.has(name) && name !== "content-length") refusalHeaders[name] = value;
              }
              const text = Buffer.concat(refusal);
              res.writeHead(401, upstreamResponse.statusMessage, { ...refusalHeaders, "content-length": text.length });
              res.end(text);
            });
          });
          return;
        }
        const responseHeaders: NodeHttp.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(upstreamResponse.headers)) {
          if (value !== undefined && !RESPONSE_DROP.has(name)) responseHeaders[name] = value;
        }
        res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.statusMessage, responseHeaders);
        res.flushHeaders();
        upstreamResponse.on("data", (chunk: Buffer) => {
          if (answered) return;
          // The chunk with a few bytes of the one before it: a marker split across two still matches.
          const text = tail + chunk.toString("latin1");
          answered = STREAM_END.test(text);
          tail = text.slice(-64);
        });
        upstreamResponse.pipe(res);
        upstreamResponse.on("error", () => res.destroy());
      });
      upstreamRequest.on("error", (cause: NodeJS.ErrnoException) => {
        if (retry && SAFE_METHODS.has(req.method ?? "") && upstreamRequest.reusedSocket && cause.code === "ECONNRESET" && !res.headersSent && !res.destroyed) return send(false);
        fail(res, 502, `Upstream unreachable: ${cause.message}`);
      });
      upstreamRequest.end(sent.body);
    };
    // The engine hung up: stop the upstream call too, unless the answer is already whole. Codex stops reading
    // at response.completed; cutting the upstream then made the app's proxy log a finished call as cancelled,
    // without its usage or what it compressed. That one drains instead.
    let answered = false;
    // Starts as a line start, so a stream that opens with its last event is seen.
    let tail = "\n";
    res.on("close", () => {
      if (res.writableFinished) return;
      if (!answered) return void upstreamRequest.destroy();
      const upstreamResponse = (upstreamRequest as NodeHttp.ClientRequest & { res?: NodeHttp.IncomingMessage }).res;
      if (upstreamResponse === undefined || upstreamResponse.complete) return;
      upstreamResponse.unpipe(res);
      upstreamResponse.resume();
      // Nothing is left to say after the last event: an upstream that keeps the stream open is cut.
      const cut = setTimeout(() => upstreamRequest.destroy(), input.drainMs ?? DRAIN_MS).unref();
      upstreamResponse.once("close", () => clearTimeout(cut));
    });
    send(true);
  };

  /**
   * A request made on a stand-in, sent to the data plane: the engine's own headers but for anything that carries a
   * credential, the runtime's token, and the connection the engine runs on now. Its answer streams back as it comes.
   * Cloud's own answers are read first: a connection that is used up or switched off is passed over and the request
   * sent once more on the next one in the person's order; a refusal becomes an error the engine's client reads as its
   * provider's, in the product's words; and the chat hears of each through the connections (onAnswer).
   */
  const forwardOutside = async (
    plane: DataPlane,
    standIn: { readonly issued: Issued; readonly names: ReadonlyArray<string> },
    pathAndQuery: string,
    req: NodeHttp.IncomingMessage,
    res: NodeHttp.ServerResponse,
    body: Buffer,
  ) => {
    const { issued } = standIn;
    const session = typeof req.headers[ROUTER_SESSION_HEADER] === "string" ? (req.headers[ROUTER_SESSION_HEADER] as string) : undefined;
    const headers: NodeHttp.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined || REQUEST_DROP.has(name) || OUTSIDE_DROP.has(name) || standIn.names.includes(name) || name.startsWith("x-cave-")) continue;
      headers[name] = value;
    }
    if (body.length > 0 || (req.method !== "GET" && req.method !== "HEAD")) headers["content-length"] = body.length;
    let connection: ModelConnection | undefined = await plane.connections.routeFor(issued);
    let token: string;
    try {
      token = await plane.token();
    } catch (cause) {
      return fail(res, 502, `Caveman could not be reached: ${cause instanceof Error ? cause.message : "no runtime token"}`);
    }
    if (res.destroyed) return;
    const tried = new Set<string>(connection === undefined ? [] : [connection.id]);
    let renewed = false;
    let upstreamRequest: NodeHttp.ClientRequest | undefined;
    res.on("close", () => {
      if (!res.writableFinished) upstreamRequest?.destroy();
    });
    const refuse = (status: number, message: string, retryAfter?: string) => {
      const text = JSON.stringify(engineError(issued, status, message));
      const head: NodeHttp.OutgoingHttpHeaders = { "content-type": "application/json", "cache-control": "no-store", "content-length": Buffer.byteLength(text) };
      // How long Cloud said to wait: the engine's own client waits that long and tries again.
      if (retryAfter !== undefined) head["retry-after"] = retryAfter;
      res.writeHead(status, head);
      res.end(text);
    };
    const send = () => {
      const target = new URL(`${plane.cloudUrl}/relay/v1/engine/${laneOf(issued.engine, issued.provider)}${pathAndQuery}`);
      const request = (target.protocol === "https:" ? NodeHttps : NodeHttp).request(target, {
        method: req.method,
        headers: { ...headers, authorization: `Bearer ${token}`, ...(connection === undefined ? {} : { "x-caveman-connection": connection.id }) },
      });
      upstreamRequest = request;
      request.on("error", (cause: Error) => fail(res, 502, `Caveman could not be reached: ${cause.message}`));
      request.on("response", (response) => {
        const status = response.statusCode ?? 502;
        const through: NodeHttp.OutgoingHttpHeaders = {};
        for (const [name, value] of Object.entries(response.headers)) {
          if (value !== undefined && !RESPONSE_DROP.has(name) && !name.startsWith("x-caveman-")) through[name] = value;
        }
        const usedUp = /^\s*([^;\s]+)\s*(?:;\s*until=(\S+))?/.exec(String(response.headers["x-caveman-used-up"] ?? ""));
        const mayBeClouds = status === 401 || status === 402 || status === 403 || status === 429 || status === 502;
        if ((usedUp === null || status < 400) && !mayBeClouds) {
          // The provider's answer: as it comes. A plan that ran out on an answer that still came is passed over from the next request on.
          if (usedUp !== null) void plane.connections.usedUp(issued, usedUp[1]!, usedUp[2], session);
          res.writeHead(status, response.statusMessage, through);
          res.flushHeaders();
          response.pipe(res);
          response.on("error", () => res.destroy());
          return;
        }
        // Read whole (it is small) before the engine sees anything: it may be sent again on another connection.
        const chunks: Array<Buffer> = [];
        let size = 0;
        let passing = false;
        const pass = () => {
          passing = true;
          res.writeHead(status, response.statusMessage, through);
          for (const chunk of chunks) res.write(chunk);
        };
        response.on("error", () => res.destroy());
        response.on("data", (chunk: Buffer) => {
          if (passing) return void res.write(chunk);
          chunks.push(chunk);
          size += chunk.length;
          // Too large to be Cloud's own answer: the provider's, as it comes.
          if (size > OUTSIDE_ANSWER_MAX) pass();
        });
        response.on("end", () => {
          if (passing) return void res.end();
          void (async () => {
            const text = Buffer.concat(chunks);
            const whole = () => {
              const { "content-length": _length, ...rest } = through;
              res.writeHead(status, response.statusMessage, { ...rest, "content-length": text.length });
              res.end(text);
            };
            const again = (next: ModelConnection | undefined) => {
              if (next === undefined || tried.has(next.id) || res.destroyed) return false;
              connection = next;
              tried.add(next.id);
              send();
              return true;
            };
            const parsed = jsonOf(text) as { error?: { code?: unknown }; code?: unknown } | undefined;
            const code = typeof parsed?.error?.code === "string" ? parsed.error.code : typeof parsed?.code === "string" ? parsed.code : undefined;
            if (usedUp !== null && status >= 400) {
              if (again(await plane.connections.usedUp(issued, usedUp[1]!, usedUp[2], session))) return;
              return whole();
            }
            if (status === 401 && !renewed && code !== undefined && code.startsWith("cave_")) {
              // Cloud refused the runtime's own token (rotated, expired across a sleep): once more with a newer one.
              renewed = true;
              const newer = await plane.token(token).catch(() => undefined);
              if (newer !== undefined && newer !== token && !res.destroyed) {
                token = newer;
                return send();
              }
              return whole();
            }
            // Nothing serves the engine: it reads why, in the words of its chat's note.
            if (code === "cave_code_no_connection") return refuse(402, await plane.connections.noConnection(issued, session));
            if (code === "cave_code_connection_kind_off") {
              if (again(await plane.connections.kindOff(issued, connection?.id, session))) return;
              return refuse(403, await plane.connections.refusalText(issued));
            }
            if (code === "cave_code_engine_rate") return refuse(429, RATE_MESSAGE, response.headers["retry-after"]);
            if (code === "cave_code_upstream") return refuse(502, UPSTREAM_MESSAGE);
            whole();
          })().catch(() => fail(res, 502, "Caveman egress scrub failed."));
        });
      });
      request.end(body);
    };
    send();
  };

  const server = NodeHttp.createServer((req, res) => {
    handle(req, res).catch(() => fail(res, 502, "Caveman egress scrub failed."));
  });
  // Fail closed: no frame is relayed unscrubbed. Engines fall back to HTTP.
  server.on("upgrade", (_req, socket) => {
    socket.end("HTTP/1.1 501 Not Implemented\r\nconnection: close\r\ncontent-length: 0\r\n\r\n");
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      origin = `http://127.0.0.1:${port}/${token}/`;
      resolve({
        port,
        token,
        route: (upstream) => {
          const id = NodeCrypto.createHash("sha256").update(upstream).digest("hex").slice(0, 16);
          routes.set(id, upstream);
          return origin + id;
        },
        owns: (url) => url.startsWith(origin),
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

/** The scrub as engines see it (engine-core), so in-process engines can route through it too. */
export { EgressRoute as EgressScrub };

/** `inner`, then `extra` over its output, in every mode. */
export const chainScrubbers = (inner: Scrubber, extra: Scrubber): Scrubber => ({
  scrub: (text) => extra.scrub(inner.scrub(text)),
  scrubDeep: (value) => extra.scrubDeep(inner.scrubDeep(value)),
  ...(inner.mayChangeJson && extra.mayChangeJson
    ? { mayChangeJson: (json: string) => inner.mayChangeJson!(json) || extra.mayChangeJson!(json) }
    : {}),
  stream: () => {
    const first = inner.stream();
    const second = extra.stream();
    return {
      push: (chunk) => second.push(first.push(chunk)),
      flush: () => second.push(first.flush()) + second.flush(),
    };
  },
  cutValueEnd: (text) => Math.max(inner.cutValueEnd(text), extra.cutValueEnd(text)),
  hits: () => new Map([...inner.hits(), ...extra.hits()]),
});

/**
 * One proxy per runtime, provided once at the top of the runtime so every
 * engine, side text and text generation sees the same EgressRoute. It needs
 * ProjectSecrets: without the store there is nothing to scrub with, and a
 * scrub that forwards unchanged must never look like a working one.
 *
 * It also re-provides ProjectSecrets with the proxy's path token added to the
 * scrubber, so an engine that echoes its base URL in an error never puts the
 * token in a transcript, an event or a log. Provide it over the store:
 * `layer.pipe(Layer.provide(ProjectSecretsLive.layer))`.
 *
 * If the proxy cannot start, `route` returns undefined and engines of a
 * repository with secrets refuse to start.
 */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    const secrets = yield* ProjectSecrets;
    let tokenScrubber = createScrubber([]);
    let tokenEntries: Array<{ name: string; value: string }> = [];
    // The same chained object while neither side changes: readers (spend.summary) key caches on its identity.
    let chained: { inner: Scrubber; token: Scrubber; out: Scrubber } | undefined;
    // Provider keys (ProviderKeySeal), connector leases (cloudLink/connections), the app's Caveman sign-in as the
    // proxies read it (proxyLauncher) and values read from secret providers (SecretResolver) join the token's
    // scrubber: rebuilt only when a new one was seen.
    let providerKeys = 0;
    // Followed sign-ins' access tokens (cloudLink/engineLogins.ts) too: a rotation swaps one for another at the same
    // count, so their generation decides. Likewise the credentials granted to plugins (plugins/CredentialBroker.ts),
    // under the variable each is granted as.
    let followedSeen = followedTokens.generation;
    // Grants an earlier run made are held before this is built.
    let grantedSeen = -1;
    const scrubber = Effect.map(secrets.scrubber, (inner) => {
      const seen = providerKeyValues.size + leasedTokens.size + appProxyTokens.size + secretProviderValues.size;
      if (seen !== providerKeys || followedTokens.generation !== followedSeen || grantedCredentials.generation !== grantedSeen) {
        providerKeys = seen;
        followedSeen = followedTokens.generation;
        grantedSeen = grantedCredentials.generation;
        tokenScrubber = createScrubber([
          ...tokenEntries,
          ...[...providerKeyValues].map((value) => ({ name: "PROVIDER_API_KEY", value })),
          ...[...leasedTokens].map((value) => ({ name: "CONNECTOR_TOKEN", value })),
          ...[...appProxyTokens].map((value) => ({ name: "CAVEMAN_ACCESS_TOKEN", value })),
          ...[...followedTokens.values].map((value) => ({ name: "ENGINE_SIGN_IN_TOKEN", value })),
          ...[...grantedCredentials.values].map(([value, name]) => ({ name, value })),
          ...[...secretProviderValues].map((value) => ({ name: "SECRET_MANAGER_VALUE", value })),
        ]);
      }
      if (chained?.inner !== inner || chained.token !== tokenScrubber)
        chained = { inner, token: tokenScrubber, out: chainScrubbers(inner, tokenScrubber) };
      return chained.out;
    });
    // The runtime's link (one per runtime): under the rule, where the data plane is and the token it takes.
    const link = yield* CloudLinkState;
    const dataPlane = (): DataPlane | undefined => {
      const connections = connectionsOf(link);
      const cloudUrl = link.cloudUrl;
      if (connections === undefined || cloudUrl === undefined || ruleOf(link).known() !== true) return undefined;
      return {
        connections,
        cloudUrl,
        token: (stale) =>
          link.token !== undefined && link.token !== stale
            ? Promise.resolve(link.token)
            : link.fresh !== undefined
              ? link.fresh(stale, CALL_TIMEOUT_MS)
              : Promise.reject(new Error("this computer's link to Caveman is not up")),
      };
    };
    // On a Mac signed in to Caveman: the connections its person made once, whose credentials go in here.
    const localPlane = (): LocalPlane | undefined => macConnectionsOf(link)?.plane();
    const proxy = yield* Effect.acquireRelease(
      Effect.tryPromise(() => startEgressProxy({ scrubber: () => Effect.runPromise(scrubber), dataPlane, localPlane })),
      (started) => Effect.promise(() => started.close()),
    ).pipe(
      Effect.catch((cause) =>
        Effect.logError("Egress scrub could not start; engines of repositories with secrets will not start.", cause).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (proxy !== undefined) {
      // A stand-in is worth something only through this proxy: a Mac launches on a connection from here on.
      // A launch whose base URL is already one of this proxy's routes to Anthropic's own API (straight, or through the
      // app's proxy) still goes to Anthropic: a route to a gateway of the person's own does not.
      const toAnthropic = (url: string) => {
        const app = appProxyUrl();
        return [ANTHROPIC_VIA_PROXY, ANTHROPIC_API, ...(app === undefined ? [] : [`${app}/w/${APP_CLAUDE_AGENT}`])].some((upstream) => url.replace(/\/+$/, "") === proxy.route(upstream));
      };
      egressRuns(link, proxy.route, toAnthropic);
      tokenEntries = [{ name: "CAVEMAN_EGRESS_TOKEN", value: proxy.token }];
      tokenScrubber = createScrubber(tokenEntries);
      providerKeys = 0;
      followedSeen = -1;
    }
    const route = EgressRoute.of({
      route: (upstream) => proxy?.route(upstream),
      owns: (url) => proxy?.owns(url) ?? false,
      hasSecrets: (cwd) =>
        secrets.keyOf({ path: cwd }).pipe(
          Effect.map(Option.some),
          // Only "not a repository" means none; an origin that changed or a locked store fails (refuse).
          Effect.catchIf(
            (error) => error.reason === "not_a_repository",
            () => Effect.succeedNone,
          ),
          // Not a git checkout: no repository, so no secrets. Names count even when the
          // values are locked away: a repository with names has secrets.
          Effect.flatMap((key) =>
            Option.isNone(key) ? Effect.succeed(false) : Effect.map(secrets.list(key.value), (names) => names.length > 0),
          ),
        ),
    });
    return Context.make(EgressRoute, route).pipe(Context.add(ProjectSecrets, ProjectSecrets.of({ ...secrets, scrubber })));
  }),
);
