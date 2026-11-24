// The test Cloud's side of "credentials stay outside a Cloud computer" (cloud-computers CONTRACT §2 to §4), in front
// of the stand-in Cloud (testCloud.ts): the `credentials_outside` answer of `GET runtime`, the read-only list of model
// connections, the refusals a hosted runtime gets under the rule (403 `cave_code_outside_computer`), and the data
// plane (`/relay/v1/engine/...`), which checks the runtime's token, drops whatever credential the caller sent,
// attaches the connection's real one and forwards to a provider. Everything else passes through to the stand-in
// Cloud behind it, the relay's WebSocket included.
//
// It runs in a process of its own, and that is the point: the credentials it attaches are canaries made there, so the
// process a test runs the runtime in never holds one unless the runtime was handed it. A test reads what happened as
// a report (what the provider received, which answers carried a canary) and gets each canary only masked (every byte
// XOR 0xff, hex), to search files and a heap snapshot for it without ever holding the value itself (`holdsCanary`).
// With the rule off this Cloud answers as Cloud did before it: the sign-in routes and the lease hand the canaries out.
//
// It is the connector proxy too (CONTRACT §3.2, `/relay/v1/mcp/...`): a hosted runtime names a connection by the id
// the list gave it, and this Cloud checks the runtime's token, drops whatever credential the caller sent, attaches
// the connector's canary (or GitHub's) and forwards to an upstream that is here as well (`/__upstream/...`): an MCP
// server, GitHub's API and GitHub's MCP server, each recording what it received and refusing anything but its own
// canary in words that repeat what it was sent. The upstream's errors go back as their status in Cloud's words (a 401
// that stays as 409 `cave_code_connection_reconnect`), a credential an answer repeats goes back as asterisks, and a
// GitHub read names only a repository Cloud placed.
//
// It is also "sign in once" (CONTRACT §4): one ordered list of model connections per person, the same from every
// runtime of theirs. A person's own device and a laptop's runtime add, order, rename and remove; a laptop reads a
// credential for its own egress through the access route; a Cloud computer only reads the list. A connection made
// through the routes holds what it was given, and the data plane attaches that. Cloud alone refreshes a compact
// sign-in. The providers are here too (`/__provider/...`): the sign-in the official CLIs' stand-ins run
// (scripts/fake-plan-clis.mjs), the model endpoints, which accept only a credential that is still good, and the
// refresh endpoint, which counts who asked. Every secret a sign-in issued is reported masked, like the canaries.
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as net from "node:net";
import { fileURLToPath } from "node:url";

export type CanaryKind =
  | "claudePlan"
  | "chatgptAccess"
  | "chatgptRefresh"
  | "chatgptId"
  | "anthropicKey"
  | "openaiKey"
  | "gatewayKey"
  | "connectorToken"
  | "githubToken";

export interface EngineConnection {
  id: string;
  kind: "claude_plan" | "chatgpt_plan" | "copilot" | "supergrok" | "api_key" | "gateway";
  provider: string;
  label: string;
  position: number;
  status: "ready" | "used_up" | "expired" | "revoked";
  used_up_until?: string | null;
  expires_at?: string | null;
  serves: Array<"claude-agent" | "codex" | "caveman">;
  added_at?: string;
}

/** What Caveman Cloud's control API says for a path it has no route for (control-api httpapi/errors.go). */
const NO_ROUTE = "No route matches this path.";

export interface EngineCloudConfig {
  /** `GET runtime`'s `credentials_outside`; null: a Cloud from before the rule, which says nothing. */
  credentialsOutside: boolean | null;
  /**
   * `GET runtime`'s `routes_auto`: the agents whose Auto this data plane routes; null: a Cloud from before
   * the field, which says nothing (and routes nothing).
   */
  routesAuto: Array<"claude-agent" | "codex"> | null;
  /**
   * Cloud's router as the data plane asks it, a stub: the model it picks for each lane's request on Auto, or `down` (it
   * fails, and the request goes on with the lane's default model). The policy stays here: a computer never sees why.
   */
  router: { claude: string; codex: string } | "down";
  /**
   * The first person's list (`user-1`, whose token the stand-in Cloud's `personToken` is), set whole. Each of these
   * attaches its kind's canary; a connection made through the routes attaches what it was given.
   */
  connections: Array<EngineConnection>;
  /**
   * False: a Cloud from before model connections (Caveman Cloud up to v0.1.0-rc.41). Every model-connections route,
   * a runtime's and a person's, answers as a route it does not have: 404 `cave_not_found`, "No route matches this path."
   */
  knowsConnections: boolean;
  /** The runtimes that are Cloud computers, by id ("all": every one). The others are laptops. */
  hosted: "all" | Array<string>;
  /** Runtimes (by id) that cannot reach Cloud: its routes and its data plane drop their calls. The providers stay reachable. */
  offline: Array<string>;
 /** How long a compact access token lasts once the provider issues it. */
  accessTtlMs: number;
  /**
   * What the provider itself says of a connection's plan, by connection id, in its own words: used up until a time
 * (Anthropic's unified rate limit headers; compact `usage_limit_reached`), or over (a Claude token revoked; a
 * compact sign-in signed out, so its refresh is refused too). A Mac hears it from the provider; the data plane reads
   * it as Cloud does.
   */
  provider: Record<string, { usedUpUntil?: string; over?: boolean }>;
  kinds: Partial<Record<EngineConnection["kind"], { on: boolean }>>;
  /** The provider says these connections' plans are used up on their next request, until the time given. */
  usedUpOnUse: Record<string, string>;
  /** This many data plane requests are refused first as over the runtime's rate (429, with this Retry-After). */
  rateLimited: { count: number; retryAfter: string };
  /** The provider holds each streamed answer after its first event until `release` (a stream that is not buffered shows it). */
  holdStream: boolean;
  /** What `GET runtime/connections` lists for the person: names and states, never a token. */
  connectors: Array<ConnectorRow>;
  /** The repositories Cloud placed on the computer (`owner/name`): the only ones a GitHub read through the proxy may name. */
  placed: Array<string>;
  /** "on": the connector proxy runs. "absent": this Cloud's relay does not serve the route (its own 404). "off": switched off (403 `cave_code_connection_kind_off`). */
  connectorProxy: "on" | "absent" | "off";
  /**
   * The computer runs a service account's session: under the rule `POST runtime/secrets/resolve` names these
   * credentials of the account (no value), and the proxy serves each by its id with the connector's canary.
   */
  account: Array<{ id: string; type: "static_bearer" | "mcp_oauth"; match_url: string }>;
}

/** A row of `GET runtime/connections` (Cloud's connections.go Connection). */
export interface ConnectorRow {
  connection_id: string;
  provider: "mcp" | "github";
  resource?: string;
  status: "connected" | "pending" | "needs_reconnect" | "error";
  owner?: "person" | "org";
  plugin_id?: string;
  /** An org row: whether Cloud offers it to the workspace asked about. */
  offered?: boolean;
  signed_in_by_name?: string;
}

/** One request to the connector proxy: the connection it named, the repository it said its chat works in, and the answer. */
export interface ProxySeen {
  connection: string;
  method: string;
  path: string;
  repository: string | null;
  status: number;
  code?: string;
}

/** What an upstream behind the connector proxy received, with each credential named by its kind and never shown. */
export interface ConnectorSeen {
  upstream: "mcp" | "github-api" | "github-mcp";
  method: string;
  path: string;
  /** The canaries among its headers. */
  credentials: Array<CanaryKind>;
  /** The runtime's own token, or a credential header the caller set, reached the upstream: neither ever may. */
  runtimeToken: boolean;
  callerCredential: boolean;
  /** GitHub's MCP server: the proxy said read-only. */
  readOnly: boolean;
  status: number;
  body: string;
}

/** What the provider behind the data plane received, with each credential named by its kind and never shown. */
export interface UpstreamSeen {
  lane: string;
  method: string;
  path: string;
  /** The request body's top-level model: the one that answered. */
  model?: string;
  /** The canaries among its headers. */
  credentials: Array<CanaryKind>;
  /** A stand-in or the runtime's own token reached the provider: neither ever may. */
  standIn: boolean;
  runtimeToken: boolean;
 /** The secrets a sign-in issued among its headers, by name (`claude-1`, `compact-1.access-2`). */
  issued: Array<string>;
  status: number;
  body: string;
}

export interface EngineCloudReport {
  upstream: Array<UpstreamSeen>;
  /** Each data plane request: its lane, the connection it named and the one that served it, and its answer. */
  plane: Array<{
    lane: string;
    path: string;
    named: string | null;
    served: string | null;
    status: number;
    code?: string;
  }>;
  /** Each request on Auto the data plane routed: its lane, the model the router chose, or the default after it failed. */
  routed: Array<{ lane: string; model: string; fallback: boolean }>;
  /** Each connector proxy request, and what the upstreams behind it received. */
  proxy: Array<ProxySeen>;
  connectors: Array<ConnectorSeen>;
  /** Every call to one of Cloud's `runtime` routes, by method and route (those passed on to the stand-in Cloud behind too). */
  asked: Array<string>;
  /**
   * Every call the runtime made to a route the rule closes to a Cloud computer (CONTRACT §2's table, and the removal of
   * a connector's sign-in), whether or not the rule applied: under it a runtime that asks none shows an empty list.
   */
  closed: Array<string>;
  /** Those of them refused with 403 `cave_code_outside_computer`: all of `closed` under the rule, none without it. */
  refused: Array<string>;
  /** Every answer this Cloud gave the runtime (the relay's frames too) that carried a canary, by route and kind. */
  answersWithCanary: Array<{ route: string; kind: CanaryKind }>;
  answers: number;
  /** Each canary masked: every byte XOR 0xff, hex. */
  canaries: Record<CanaryKind, string>;
  /** Every refresh the provider was asked for: by Cloud itself, or by anything else (a computer never may), and whether it gave new tokens. */
  refreshes: Array<{ by: "cloud" | "other"; ok: boolean }>;
  /** Every credential a laptop read through the access route. */
  access: Array<{ connection: string; runtime: string; status: number }>;
  /** Every answer Cloud gave that carried a secret a sign-in issued: only a laptop's access route ever may. */
  answersWithIssued: Array<{ route: string; name: string }>;
 /** Every secret a sign-in issued (a Claude token; each compact access, refresh and id token), by name, masked like the canaries. */
  issued: Record<string, string>;
  /** The connections as Cloud keeps them, by person: never a secret. */
  people: Record<string, Array<EngineConnection>>;
}

const mask = (value: string) =>
  Buffer.from(Buffer.from(value, "utf8").map((byte) => byte ^ 0xff)).toString("hex");

/**
 * Whether `haystack` holds the canary behind `masked`, without the canary ever being a value in this process: each
 * byte is compared masked. Also finds it as JSON carries it (a canary is ASCII letters, digits and dashes).
 */
export function holdsCanary(haystack: Buffer, masked: string): boolean {
  const needle = Buffer.from(masked, "hex");
  const first = needle[0]! ^ 0xff;
  outer: for (
    let at = haystack.indexOf(first);
    at >= 0 && at + needle.length <= haystack.length;
    at = haystack.indexOf(first, at + 1)
  ) {
    for (let i = 1; i < needle.length; i++)
      if ((haystack[at + i]! ^ 0xff) !== needle[i]) continue outer;
    return true;
  }
  return false;
}

/** `holdsCanary` over a file read in pieces (a heap snapshot is hundreds of megabytes): a canary across two pieces is still found. */
export function fileHoldsCanaries(
  file: string,
  masked: Readonly<Record<string, string>>,
): Array<string> {
  const found = new Set<string>();
  const longest = Math.max(...Object.values(masked).map((m) => m.length / 2));
  const fd = fs.openSync(file, "r");
  try {
    const piece = Buffer.alloc(8 * 1024 * 1024 + longest);
    let carried = 0;
    for (;;) {
      const read = fs.readSync(fd, piece, carried, piece.length - carried, null);
      if (read === 0) break;
      const window = piece.subarray(0, carried + read);
      for (const [kind, m] of Object.entries(masked))
        if (!found.has(kind) && holdsCanary(window, m)) found.add(kind);
      carried = Math.min(longest, window.length);
      piece.copy(piece, 0, window.length - carried, window.length);
    }
  } finally {
    fs.closeSync(fd);
  }
  return [...found];
}

export interface EngineCloud {
  readonly url: string;
  readonly configure: (change: Partial<EngineCloudConfig>) => Promise<void>;
  readonly report: () => Promise<EngineCloudReport>;
  /** Lets held streams go on. */
  readonly release: () => Promise<void>;
  /** The person approves every sign-in that waits on the provider's page. Answers how many did. */
  readonly approve: () => Promise<number>;
  readonly close: () => Promise<void>;
}

/** Starts this Cloud in its own process, in front of the stand-in Cloud at `innerUrl`. */
export async function startEngineCloud(
  innerUrl: string,
  config: Partial<EngineCloudConfig> = {},
): Promise<EngineCloud> {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", innerUrl], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const url = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const line = /^listening (\S+)$/m.exec(out);
      if (line) resolve(line[1]!);
    });
    child.once("exit", (code) => reject(new Error(`the engine Cloud stand-in exited (${code})`)));
  });
  const control = async (route: string, body?: unknown) => {
    const response = await fetch(
      `${url}/__test/${route}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
    );
    if (!response.ok)
      throw new Error(`engine Cloud stand-in: ${route} answered ${response.status}`);
    return response.json();
  };
  const cloud: EngineCloud = {
    url,
    configure: (change) => control("config", change).then(() => undefined),
    report: () => control("report") as Promise<EngineCloudReport>,
    release: () => control("release", {}).then(() => undefined),
    approve: () => control("approve", {}).then((out) => (out as { approved: number }).approved),
    close: () =>
      new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill();
      }),
  };
  await cloud.configure(config);
  return cloud;
}

// ------------------------------------------------------------------------------------------------ the process itself

function serve(innerUrl: string) {
  const inner = new URL(innerUrl);
  const canary = (kind: string) => `CANARY-${kind}-${randomBytes(18).toString("hex")}`;
  const canaries: Record<CanaryKind, string> = {
    claudePlan: canary("claude-plan"),
    chatgptAccess: canary("chatgpt-access"),
    chatgptRefresh: canary("chatgpt-refresh"),
    chatgptId: canary("chatgpt-id"),
    anthropicKey: canary("anthropic-key"),
    openaiKey: canary("openai-key"),
    gatewayKey: canary("gateway-key"),
    connectorToken: canary("connector-token"),
    githubToken: canary("github-token"),
  };
  const kindsIn = (text: string) =>
    (Object.keys(canaries) as Array<CanaryKind>).filter((kind) => text.includes(canaries[kind]));
  const config: Omit<EngineCloudConfig, "connections"> = {
    credentialsOutside: true,
    routesAuto: null,
    router: { claude: "claude-sonnet-5-5", codex: "gpt-6-luna" },
    knowsConnections: true,
    hosted: "all",
    offline: [],
    accessTtlMs: 3_600_000,
    provider: {},
    kinds: {},
    usedUpOnUse: {},
    rateLimited: { count: 0, retryAfter: "1" },
    holdStream: false,
    connectors: [
      { connection_id: "github", provider: "github", status: "connected" },
      {
        connection_id: "conn-mcp",
        provider: "mcp",
        resource: "https://mcp.example.test/mcp",
        status: "connected",
        owner: "person",
      },
    ],
    placed: ["acme/widgets"],
    connectorProxy: "on",
    account: [],
  };
  const report: Omit<EngineCloudReport, "canaries" | "issued" | "people"> = {
    upstream: [],
    plane: [],
    routed: [],
    proxy: [],
    connectors: [],
    asked: [],
    closed: [],
    refused: [],
    answersWithCanary: [],
    answers: 0,
    refreshes: [],
    access: [],
    answersWithIssued: [],
  };
  let release: Array<() => void> = [];

  // ------------------------------------------------------------------------------------------------- who is asking

  /** The person every runtime is before its enrolment was seen, and whose list `connections` sets. */
  const FIRST = "user-1";
  /** Runtime tokens this Cloud saw minted (the mint passes through it): when each ends, and whose runtime it is. */
  const tokens = new Map<string, { until: number; runtime: string }>();
  /** Each runtime's person and each person's own session, learned as an enrolment passes through. */
  const runtimes = new Map<string, string>();
  const persons = new Map<string, string>();
  const bearerOf = (request: http.IncomingMessage) =>
    request.headers.authorization?.replace(/^Bearer /, "");
  const runtimeOf = (request: http.IncomingMessage) => {
    const token = tokens.get(bearerOf(request) ?? "");
    return token !== undefined && token.until > Date.now() ? token.runtime : undefined;
  };
  const personOf = (runtime: string | undefined) =>
    runtime === undefined ? FIRST : (runtimes.get(runtime) ?? FIRST);
  const hosted = (runtime: string | undefined) =>
    config.hosted === "all" || (runtime !== undefined && config.hosted.includes(runtime));
  /** Whether this call is from a runtime that cannot reach Cloud now (its token mint names it in the path). */
  const cutOff = (request: http.IncomingMessage, url: URL) => {
    const runtime =
      /^\/api\/v1\/code\/runtimes\/([^/]+)\/token$/.exec(url.pathname)?.[1] ??
      tokens.get(bearerOf(request) ?? "")?.runtime;
    return runtime !== undefined && config.offline.includes(runtime);
  };

  // ----------------------------------------------------------------------------------------------- what Cloud keeps

  /** What a connection made through the routes was given. One set by the test has none: its kind's canary stands for it. */
  type Secret =
    | { readonly token: string }
    | {
        readonly access_token: string;
        readonly refresh_token: string;
        readonly expires: number;
        readonly account: string;
      }
    | { readonly key: string; readonly base_url?: string };
  type Stored = EngineConnection & { secret?: Secret };
  const people = new Map<string, Array<Stored>>();
  const listOf = (person: string) => {
    let list = people.get(person);
    if (list === undefined) people.set(person, (list = []));
    return list;
  };
  const ordered = (person: string) => [...listOf(person)].sort((a, b) => a.position - b.position);
  /** A connection as every route shows it: never its secret, and `used_up` read from `used_up_until`. */
  const wire = ({ secret: _secret, ...c }: Stored): EngineConnection =>
    c.status === "used_up" &&
    typeof c.used_up_until === "string" &&
    Date.parse(c.used_up_until) <= Date.now()
      ? { ...c, status: "ready", used_up_until: null }
      : c;

  /** Every answer the runtime gets is looked through for canaries and for secrets a sign-in issued, headers and body. */
  const answered = (route: string, headers: unknown, body: Buffer | string) => {
    report.answers++;
    const text = `${JSON.stringify(headers)}\n${typeof body === "string" ? body : body.toString("latin1")}`;
    for (const kind of kindsIn(text)) report.answersWithCanary.push({ route, kind });
    for (const [name, value] of issued)
      if (text.includes(value)) report.answersWithIssued.push({ route, name });
  };
  const json = (
    response: http.ServerResponse,
    route: string,
    status: number,
    body: unknown,
    headers: http.OutgoingHttpHeaders = {},
  ) => {
    const text = JSON.stringify(body);
    const head = { "content-type": "application/json", ...headers };
    answered(route, head, text);
    response.writeHead(status, head);
    response.end(text);
  };
  const refuse = (
    response: http.ServerResponse,
    route: string,
    status: number,
    code: string,
    headers: http.OutgoingHttpHeaders = {},
    message = code,
  ) => json(response, route, status, { error: { code, message } }, headers);
  const live = (token: string | undefined) =>
    token !== undefined && (tokens.get(token)?.until ?? 0) > Date.now();

  // ---------------------------------------------------------------------------------------------------- the providers

  /** Every secret a sign-in issued, by name. */
  const issued = new Map<string, string>();
  const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwt = (claims: Record<string, unknown>) =>
    `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ ...claims, jti: randomUUID() })}.${randomBytes(32).toString("base64url")}`;
 /** A compact sign-in at the provider: its one refresh token that is good now, and each access token until it ends. */
  interface Login {
    readonly name: string;
    readonly account: string;
    readonly email: string;
    refresh: string;
    readonly access: Map<string, number>;
    rotation: number;
  }
  const claudeTokens = new Map<string, string>();
  const logins: Array<Login> = [];
  /** Sign-ins the official CLIs' stand-ins started, waiting for the person on the provider's page. */
  const waiting = new Map<string, { kind: "claude" | "chatgpt"; approved: boolean }>();

  /** New tokens for a sign-in: the refresh token before them is spent. */
  const rotate = (login: Login) => {
    login.rotation++;
    const until = Date.now() + config.accessTtlMs;
    const auth = { chatgpt_account_id: login.account, chatgpt_plan_type: "pro" };
    const access_token = jwt({
      exp: Math.floor(until / 1000),
      "https://api.openai.com/auth": auth,
    });
    const id_token = jwt({
      exp: Math.floor(until / 1000),
      email: login.email,
      "https://api.openai.com/auth": auth,
    });
    const refresh_token = `rt_${randomBytes(32).toString("base64url")}`;
    login.refresh = refresh_token;
    login.access.set(access_token, until);
    issued.set(`${login.name}.access-${login.rotation}`, access_token);
    issued.set(`${login.name}.refresh-${login.rotation}`, refresh_token);
    issued.set(`${login.name}.id-${login.rotation}`, id_token);
    return {
      access_token,
      refresh_token,
      id_token,
      account_id: login.account,
      expires_in: Math.max(1, Math.round(config.accessTtlMs / 1000)),
    };
  };
  /** What the test said the provider says of the connection that holds this credential. */
  const saysOf = (holds: (secret: Secret) => boolean) => {
    for (const list of people.values())
      for (const c of list)
        if (c.secret !== undefined && holds(c.secret) && config.provider[c.id] !== undefined)
          return config.provider[c.id];
    return undefined;
  };
  const saysOfLogin = (login: Login) =>
    saysOf((secret) => "account" in secret && secret.account === login.account);
  const usedUpUntil = (says: { usedUpUntil?: string } | undefined) => {
    const until = says?.usedUpUntil === undefined ? Number.NaN : Date.parse(says.usedUpUntil);
    return until > Date.now() ? until : undefined;
  };
  /** The provider's refresh endpoint: a refresh token is good once, and never after the sign-in is over. */
  const refresh = (token: string, by: "cloud" | "other") => {
    const login = logins.find((l) => l.refresh === token);
    const ok = login !== undefined && saysOfLogin(login)?.over !== true;
    report.refreshes.push({ by, ok });
    return ok ? rotate(login) : undefined;
  };

  /** The sign-in the official CLIs' stand-ins run against the provider, and the refresh endpoint as anything but Cloud reaches it. */
  const oauth = (response: http.ServerResponse, route: string, body: Buffer) => {
    const out = (status: number, value: unknown) => (
      response.writeHead(status, { "content-type": "application/json" }),
      response.end(JSON.stringify(value))
    );
    let asked: Record<string, unknown> = {};
    try {
      asked = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      return out(400, {});
    }
    if (route === "start") {
      const state = randomUUID();
      waiting.set(state, {
        kind: asked.kind === "chatgpt" ? "chatgpt" : "claude",
        approved: false,
      });
      return out(200, { state });
    }
    if (route === "finish") {
      const state = String(asked.state);
      const sign = waiting.get(state);
      if (sign === undefined) return out(404, {});
      if (!sign.approved) return out(202, { pending: true });
      waiting.delete(state);
      if (sign.kind === "claude") {
        const name = `claude-${claudeTokens.size + 1}`;
        const token = `sk-ant-oat01-${randomBytes(72).toString("base64url")}`;
        claudeTokens.set(token, name);
        issued.set(name, token);
        return out(200, { token });
      }
      const n = logins.length + 1;
      const login: Login = {
        name: `chatgpt-${n}`,
        account: `acct-${randomUUID()}`,
        email: `person-${n}@example.test`,
        refresh: "",
        access: new Map(),
        rotation: 0,
      };
      logins.push(login);
      return out(200, rotate(login));
    }
    if (route === "token") {
      const fresh =
        asked.grant_type === "refresh_token" && typeof asked.refresh_token === "string"
          ? refresh(asked.refresh_token, "other")
          : (report.refreshes.push({ by: "other", ok: false }), undefined);
      return fresh === undefined
        ? out(401, {
            error: {
              code: "refresh_token_expired",
              message: "Your refresh token has expired. Please log out and sign in again.",
            },
          })
        : out(200, fresh);
    }
    return out(404, {});
  };

  /** The provider: records what it was sent, accepts a credential a sign-in issued only while it is good, and answers a stream (or a model list). */
  const provider = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    lane: string,
    path: string,
    body: Buffer,
  ) => {
    const headers = JSON.stringify(request.headers);
    const bearer = bearerOf(request) ?? "";
    const names = [...issued].filter(([, value]) => headers.includes(value)).map(([name]) => name);
    const model = modelIn(body);
    const seen = (status: number) =>
      report.upstream.push({
        lane,
        method: request.method ?? "GET",
        path,
        ...(model === undefined ? {} : { model }),
        credentials: kindsIn(headers),
        standIn: headers.includes("caveman-stand-in"),
        runtimeToken: headers.includes("ccrt_"),
        issued: names,
        status,
        body: body.toString("utf8").slice(0, 4_000),
      });
    const says = (status: number, out: unknown, extra: http.OutgoingHttpHeaders = {}) => {
      seen(status);
      response.writeHead(status, { "content-type": "application/json", ...extra });
      response.end(JSON.stringify(out));
    };
    if (claudeTokens.has(bearer)) {
      const said = saysOf((secret) => "token" in secret && secret.token === bearer);
      if (said?.over === true)
        return says(401, {
          type: "error",
          error: {
            type: "authentication_error",
            message:
              "OAuth token has been revoked. Please obtain a new token or refresh your existing token.",
          },
        });
      const until = usedUpUntil(said);
      if (until !== undefined) {
        return says(
          429,
          {
            type: "error",
            error: {
              type: "rate_limit_error",
              message:
                "This request would exceed your account's rate limit. Please try again later.",
            },
          },
          {
            "anthropic-ratelimit-unified-status": "rejected",
            "anthropic-ratelimit-unified-reset": String(Math.ceil(until / 1000)),
          },
        );
      }
    }
    const login = logins.find((l) => l.access.has(bearer));
    if (login !== undefined) {
      const said = saysOfLogin(login);
      if (said?.over === true || login.access.get(bearer)! <= Date.now())
        return says(401, {
          error: {
            code: "token_expired",
            message: "Provided authentication token is expired. Please try signing in again.",
          },
        });
      const until = usedUpUntil(said);
      if (until !== undefined)
        return says(429, {
          error: {
            type: "usage_limit_reached",
            message: "The usage limit has been reached",
            plan_type: "pro",
            resets_at: Math.ceil(until / 1000),
          },
        });
    }
    seen(200);
    if (request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      return void response.end(JSON.stringify({ data: [{ id: "model-of-the-provider" }] }));
    }
    // The answer names the model that answered, as Anthropic's message_start and the Responses API's response.created do.
    const named =
      model === undefined
        ? ""
        : lane === "claude"
          ? `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { model } })}\n\n`
          : `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { model } })}\n\n`;
    const events =
      lane === "claude"
        ? [
            `${named}event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "answer from " } })}\n\n`,
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "the provider" } })}\n\nevent: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
          ]
        : [
            `${named}event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer from " })}\n\n`,
            `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: "the provider" })}\n\nevent: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`,
          ];
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(events[0]);
    const rest = () => response.end(events[1]);
    if (config.holdStream) release.push(rest);
    else setTimeout(rest, 20);
  };

  // ------------------------------------------------------------------------------------------------- model connections

  const laneServes = (lane: string, c: EngineConnection) => {
    if (lane === "claude")
      return (
        c.serves.includes("claude-agent") &&
        (c.kind === "claude_plan" || (c.kind === "api_key" && c.provider === "anthropic"))
      );
    if (lane === "codex")
      return (
        c.serves.includes("codex") &&
        (c.kind === "chatgpt_plan" || (c.kind === "api_key" && c.provider === "openai"))
      );
    return (
      c.serves.includes("caveman") &&
      (c.kind === "api_key" || c.kind === "gateway") &&
      lane === `key/${c.provider}`
    );
  };
  const ready = (c: EngineConnection) =>
    c.status === "ready" ||
    (c.status === "used_up" &&
      typeof c.used_up_until === "string" &&
      Date.parse(c.used_up_until) <= Date.now());
  /**
 * Cloud is the only refresher: a compact sign-in near its end (or one the provider just refused, `force`) gets new
   * tokens here. False: the provider refused the refresh, and the connection reads expired until it is connected again.
   */
  const freshen = (c: Stored, force = false): boolean => {
    const secret = c.secret;
    if (secret === undefined || !("refresh_token" in secret)) return true;
    if (!force && secret.expires - Date.now() > Math.min(60_000, config.accessTtlMs / 2))
      return true;
    const fresh = refresh(secret.refresh_token, "cloud");
    if (fresh === undefined) return ((c.status = "expired"), false);
    c.secret = {
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token,
      expires: Date.now() + config.accessTtlMs,
      account: secret.account,
    };
    return true;
  };
  /** What the data plane sets on the provider's request for a connection (CONTRACT §3.1 `headers`); undefined: its sign-in is over. */
  const credentialOf = (c: Stored): Record<string, string> | undefined => {
    const secret = c.secret;
    if (secret !== undefined && "token" in secret)
      return { authorization: `Bearer ${secret.token}` };
    if (secret !== undefined && "refresh_token" in secret)
      return freshen(c)
        ? {
            authorization: `Bearer ${(c.secret as typeof secret).access_token}`,
            "chatgpt-account-id": secret.account,
          }
        : undefined;
    if (secret !== undefined)
      return c.provider === "anthropic"
        ? { "x-api-key": secret.key }
        : { authorization: `Bearer ${secret.key}` };
    if (c.kind === "claude_plan") return { authorization: `Bearer ${canaries.claudePlan}` };
    if (c.kind === "chatgpt_plan")
      return {
        authorization: `Bearer ${canaries.chatgptAccess}`,
        "chatgpt-account-id": "acct-of-the-person",
      };
    if (c.kind === "gateway") return { authorization: `Bearer ${canaries.gatewayKey}` };
    return c.provider === "anthropic"
      ? { "x-api-key": canaries.anthropicKey }
      : { authorization: `Bearer ${canaries.openaiKey}` };
  };
  const servesOf = (kind: string, provider: string): EngineConnection["serves"] =>
    kind === "claude_plan"
      ? ["claude-agent"]
      : kind === "chatgpt_plan"
        ? ["codex", "caveman"]
        : kind === "api_key" && provider === "anthropic"
          ? ["claude-agent", "caveman"]
          : kind === "api_key" && provider === "openai"
            ? ["codex", "caveman"]
            : ["caveman"];
  const claimsOf = (token: unknown): Record<string, unknown> | undefined => {
    const parts = typeof token === "string" ? token.split(".") : [];
    if (parts.length !== 3) return undefined;
    try {
      const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as unknown;
      return claims !== null && typeof claims === "object"
        ? (claims as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  };
  /** Cloud's code for an upstream's own answer, passed on with its status and Cloud's words (CONTRACT §3.2). */
  const UPSTREAM_CODE = "cave_code_upstream";
  const KIND_NAMES: Record<string, string> = {
    claude_plan: "Claude plan",
    chatgpt_plan: "ChatGPT plan",
    copilot: "GitHub Copilot",
    supergrok: "SuperGrok",
  };
  const RECONNECT =
    "This connection is no longer accepted by its provider. Connect it again in Settings > Models & keys.";

  /**
   * CONTRACT §4's routes for `person`, `route` being what follows `model-connections`. `laptop`: the laptop runtime
   * that asks as its enroller, which alone may read a credential; undefined: the person's own device.
   */
  const connectionRoutes = (
    response: http.ServerResponse,
    name: string,
    method: string,
    route: string,
    body: Buffer,
    person: string,
    laptop: string | undefined,
  ) => {
    const list = listOf(person);
    const bad = (message: string) => refuse(response, name, 400, "cave_bad_request", {}, message);
    const kindOff = (kind: string) =>
      refuse(
        response,
        name,
        403,
        "cave_code_connection_kind_off",
        {},
        `${KIND_NAMES[kind] ?? kind} connections are switched off on this Caveman Cloud.`,
      );
    let asked: Record<string, unknown> = {};
    try {
      asked = JSON.parse(body.toString("utf8") || "{}") as Record<string, unknown>;
    } catch {
      return bad("Invalid JSON.");
    }
    const all = () => ({ connections: ordered(person).map(wire), kinds: config.kinds });
    if (route === "" && method === "GET") return json(response, name, 200, all());
    if (route === "" && method === "POST") {
      const kind = String(asked.kind);
      if (config.kinds[kind as EngineConnection["kind"]]?.on === false) return kindOff(kind);
      const add = (
        fields: Pick<Stored, "kind" | "provider" | "label" | "secret"> & { expires_at?: string },
      ) => {
        const connection: Stored = {
          id: randomUUID(),
          position: list.reduce((most, c) => Math.max(most, c.position + 1), 0),
          status: "ready",
          serves: servesOf(fields.kind, fields.provider),
          added_at: new Date().toISOString(),
          ...fields,
        };
        list.push(connection);
        return json(response, name, 201, wire(connection));
      };
      if (kind === "claude_plan") {
        // Checked by its form only: Cloud makes no request of its own with a person's plan.
        if (typeof asked.token !== "string" || !/^sk-ant-oat[A-Za-z0-9_-]{32,}$/.test(asked.token))
          return bad("token is the line `claude setup-token` prints: it starts with sk-ant-oat.");
        return add({
          kind,
          provider: "anthropic",
          label: "Claude plan",
          expires_at: new Date(Date.now() + 365 * 86_400_000).toISOString(),
          secret: { token: asked.token },
        });
      }
      if (kind === "chatgpt_plan") {
        const credential = (asked.credential ?? {}) as Record<string, unknown>;
        const access = claimsOf(credential.access_token);
        if (
          access === undefined ||
          typeof credential.refresh_token !== "string" ||
          credential.refresh_token === ""
        )
          return bad(
            "chatgpt_plan takes credential: the access_token, refresh_token and id_token that `codex login` left on your own machine.",
          );
        const id = claimsOf(credential.id_token);
        const account = [id, access]
          .map(
            (claims) =>
              (
                claims?.["https://api.openai.com/auth"] as
                  | { chatgpt_account_id?: unknown }
                  | undefined
              )?.chatgpt_account_id,
          )
          .find((value) => typeof value === "string" && value !== "") as string | undefined;
        if (account === undefined)
          return bad(
            "This sign-in names no ChatGPT account. Run `codex login`, sign in with ChatGPT (not an API key), and connect again.",
          );
        const expires =
          typeof access.exp === "number"
            ? access.exp * 1000
            : typeof credential.expires_at === "string"
              ? Date.parse(credential.expires_at)
              : Date.now() + config.accessTtlMs;
        if (!(expires > Date.now()))
          return refuse(
            response,
            name,
            422,
            "cave_code_connection_invalid",
            {},
            "This ChatGPT sign-in's access token has already expired. Run `codex login` again and connect it straight away.",
          );
        const secret: Secret = {
          access_token: credential.access_token as string,
          refresh_token: credential.refresh_token,
          expires,
          account,
        };
 // One connection per compact account: one that is ready stays as it is; one that ended takes the new sign-in.
        const same = list.find(
          (c) => c.secret !== undefined && "account" in c.secret && c.secret.account === account,
        );
        if (same !== undefined) {
          if (same.status !== "ready")
            Object.assign(same, { secret, status: "ready", used_up_until: null });
          return json(response, name, 200, wire(same));
        }
        return add({
          kind,
          provider: "openai",
          label: `ChatGPT Pro${typeof id?.email === "string" ? ` · ${id.email}` : ""}`,
          secret,
        });
      }
      if (kind === "api_key" || kind === "gateway") {
        if (typeof asked.provider !== "string" || typeof asked.key !== "string" || asked.key === "")
          return bad(`${kind} takes kind, provider, key and an optional label.`);
        return add({
          kind,
          provider: asked.provider,
          label:
            typeof asked.label === "string" && asked.label !== "" ? asked.label : asked.provider,
          secret: {
            key: asked.key,
            ...(typeof asked.base_url === "string" ? { base_url: asked.base_url } : {}),
          },
        });
      }
      return bad("kind is one of claude_plan, chatgpt_plan, api_key and gateway.");
    }
    if (route === "/order" && method === "PATCH") {
      const ids = asked.ids;
      if (
        !Array.isArray(ids) ||
        ids.length !== list.length ||
        new Set(ids).size !== ids.length ||
        !ids.every((id) => list.some((c) => c.id === id))
      ) {
        return refuse(
          response,
          name,
          409,
          "cave_code_connections_changed",
          {},
          "The list changed: read it again and send every connection's id once, in the order you want.",
        );
      }
      ids.forEach((id, position) => (list.find((c) => c.id === id)!.position = position));
      return json(response, name, 200, all());
    }
    const one = /^\/([^/]+)(\/access)?$/.exec(route);
    const connection =
      one === null ? undefined : list.find((c) => c.id === decodeURIComponent(one[1]!));
    // Another person's connection is as absent as one that never was.
    if (one === null || connection === undefined)
      return refuse(response, name, 404, "cave_not_found");
    if (one[2] === undefined && method === "PATCH") {
      if (typeof asked.label !== "string" || asked.label.trim() === "")
        return bad("label is a short name.");
      connection.label = asked.label.trim();
      return json(response, name, 200, wire(connection));
    }
    if (one[2] === undefined && method === "DELETE") {
      list.splice(list.indexOf(connection), 1);
      report.answers++;
      response.writeHead(204);
      return void response.end();
    }
    if (one[2] !== undefined && method === "POST" && laptop !== undefined) {
      const done = (status: number, out: unknown) => (
        report.access.push({ connection: connection.id, runtime: laptop, status }),
        json(response, name, status, out)
      );
      if (config.kinds[connection.kind]?.on === false)
        return (
          report.access.push({ connection: connection.id, runtime: laptop, status: 403 }),
          kindOff(connection.kind)
        );
      const over = () =>
        done(409, { error: { code: "cave_code_connection_reconnect", message: RECONNECT } });
      if (connection.status === "expired" || connection.status === "revoked") return over();
      const secret = connection.secret;
      if (connection.kind === "claude_plan")
        return done(200, {
          token: secret !== undefined && "token" in secret ? secret.token : canaries.claudePlan,
          expires_at: connection.expires_at ?? null,
        });
      if (connection.kind === "chatgpt_plan") {
        if (secret === undefined || !("refresh_token" in secret))
          return done(200, {
            access_token: canaries.chatgptAccess,
            account_id: "acct-of-the-person",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          });
        if (!freshen(connection)) return over();
        const now = connection.secret as typeof secret;
        return done(200, {
          access_token: now.access_token,
          account_id: now.account,
          expires_at: new Date(now.expires).toISOString(),
        });
      }
      const key =
        secret !== undefined && "key" in secret
          ? secret
          : {
              key:
                connection.kind === "gateway"
                  ? canaries.gatewayKey
                  : connection.provider === "anthropic"
                    ? canaries.anthropicKey
                    : canaries.openaiKey,
            };
      return done(200, key);
    }
    return refuse(response, name, 404, "cave_not_found");
  };

  /** What a provider's own answer says of the plan it went out on, read as Cloud's data plane reads it (CONTRACT §3). */
  const heard = (
    connection: Stored,
    status: number,
    headers: http.IncomingHttpHeaders,
    text: string,
  ): { usedUp?: string | null; over?: true } => {
    let error: { type?: unknown; message?: unknown; resets_at?: unknown } = {};
    try {
      error = ((JSON.parse(text) as { error?: typeof error }).error ?? {}) as typeof error;
    } catch {
      // Not JSON: it says nothing.
    }
    if (connection.kind === "claude_plan") {
      if (status === 429 && headers["anthropic-ratelimit-unified-status"] === "rejected") {
        const reset = Number(headers["anthropic-ratelimit-unified-reset"]);
        return {
          usedUp: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : null,
        };
      }
      if (
        (status === 401 || status === 403) &&
        typeof error.message === "string" &&
        /^OAuth (?:access )?token has (?:been revoked|expired)\b/.test(error.message)
      )
        return { over: true };
    }
    if (
      connection.kind === "chatgpt_plan" &&
      status === 429 &&
      error.type === "usage_limit_reached"
    )
      return {
        usedUp:
          typeof error.resets_at === "number"
            ? new Date(error.resets_at * 1000).toISOString()
            : null,
      };
    return {};
  };

  /** A JSON body's top-level model, or undefined. */
  const modelIn = (body: Buffer): string | undefined => {
    try {
      const model = (JSON.parse(body.toString("utf8")) as { model?: unknown }).model;
      return typeof model === "string" ? model : undefined;
    } catch {
      return undefined;
    }
  };

  /** The lanes' default models (the agent's own, first of Cloud's pool), what a request on Auto runs on when the router fails. */
  const DEFAULT_MODEL: Record<string, string> = { claude: "claude-opus-5-5", codex: "gpt-6.1-sol" };

  /**
   * Auto in the data plane (CONTRACT §3.3): a request on Auto, on a lane whose agent this Cloud routes, gets the model
   * the router picks in its body's top-level `model` and nothing else changed; a router that fails leaves the default.
   */
  const routeAuto = (lane: string, path: string, body: Buffer): Buffer => {
    const agent = lane === "claude" ? "claude-agent" : lane === "codex" ? "codex" : undefined;
    const endpoint =
      lane === "claude" ? /^\/v1\/messages(\/count_tokens)?$/ : /^\/responses(\/compact)?$/;
    if (agent === undefined || !(config.routesAuto ?? []).includes(agent) || !endpoint.test(path))
      return body;
    const asked = modelIn(body);
    if (asked !== "caveman-auto" && asked !== "caveman-auto[1m]") return body;
    const fallback = config.router === "down";
    const model =
      config.router === "down" ? DEFAULT_MODEL[lane]! : config.router[lane as "claude" | "codex"];
    report.routed.push({ lane, model, fallback });
    const text = body.toString("utf8");
    const at = text.indexOf(JSON.stringify(asked));
    return Buffer.from(
      `${text.slice(0, at)}${JSON.stringify(model)}${text.slice(at + JSON.stringify(asked).length)}`,
      "utf8",
    );
  };

  /** The data plane (CONTRACT §3). */
  const dataPlane = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    given: Buffer,
  ) => {
    const match = /^\/relay\/v1\/engine\/(claude|codex|key\/[^/]+)(\/.*)$/.exec(url.pathname);
    const route = `plane ${url.pathname}`;
    if (match === null) return refuse(response, route, 404, "cave_not_found");
    const [, lane, path] = match as unknown as [string, string, string];
    const body = routeAuto(lane, path, given);
    const named =
      typeof request.headers["x-caveman-connection"] === "string"
        ? request.headers["x-caveman-connection"]
        : null;
    const done = (status: number, served: string | null, code?: string) =>
      report.plane.push({
        lane,
        path,
        named,
        served,
        status,
        ...(code === undefined ? {} : { code }),
      });
    if (!live(bearerOf(request)))
      return (
        done(401, null, "cave_unauthorized"), refuse(response, route, 401, "cave_unauthorized")
      );
    if (config.rateLimited.count > 0) {
      config.rateLimited.count--;
      return (
        done(429, null, "cave_code_engine_rate"),
        refuse(response, route, 429, "cave_code_engine_rate", {
          "retry-after": config.rateLimited.retryAfter,
        })
      );
    }
    const on = (c: EngineConnection) => config.kinds[c.kind]?.on !== false;
    const mine = ordered(personOf(runtimeOf(request)));
    const wanted = named === null ? undefined : mine.find((c) => c.id === named);
    if (wanted !== undefined && !on(wanted))
      return (
        done(403, null, "cave_code_connection_kind_off"),
        refuse(response, route, 403, "cave_code_connection_kind_off")
      );
    const connection =
      named === null
        ? mine.find((c) => laneServes(lane, c) && on(c) && ready(c))
        : wanted !== undefined && laneServes(lane, wanted) && ready(wanted)
          ? wanted
          : undefined;
    const credential = connection === undefined ? undefined : credentialOf(connection);
    if (connection === undefined || credential === undefined)
      return (
        done(402, null, "cave_code_no_connection"),
        refuse(response, route, 402, "cave_code_no_connection")
      );
    const until = config.usedUpOnUse[connection.id];
    if (until !== undefined) {
      // The provider says the plan ran out: its own answer goes back, beside what Cloud learned from it.
      delete config.usedUpOnUse[connection.id];
      connection.status = "used_up";
      connection.used_up_until = until;
      done(429, connection.id);
      return json(
        response,
        route,
        429,
        {
          type: "error",
          error: { type: "rate_limit_error", message: "This plan's usage limit is reached." },
        },
        {
          "x-caveman-connection": connection.id,
          "x-caveman-used-up": `${connection.id}; until=${until}`,
        },
      );
    }
    // Whatever credential the caller sent is dropped, and the real one set.
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        value !== undefined &&
        ![
          "host",
          "connection",
          "authorization",
          "x-api-key",
          "cookie",
          "chatgpt-account-id",
          "x-caveman-connection",
          "content-length",
        ].includes(name)
      )
        headers[name] = value;
    }
    const address = server.address() as net.AddressInfo;
    const send = (attach: Record<string, string>, again: boolean) => {
      const forward = http.request({
        host: "127.0.0.1",
        port: address.port,
        path: `/__provider/${lane}${path}${url.search}`,
        method: request.method,
        headers: { ...headers, ...attach, "content-length": body.length },
      });
      forward.on(
        "error",
        () => (
          done(502, connection.id, "cave_code_upstream"),
          refuse(response, route, 502, "cave_code_upstream")
        ),
      );
      forward.on("response", (answer) => {
        const status = answer.statusCode ?? 502;
        const chunks: Array<Buffer> = [];
        const head: http.OutgoingHttpHeaders = {
          ...answer.headers,
          "x-caveman-connection": connection.id,
        };
        if (status !== 401 && status !== 403 && status !== 429) {
          done(status, connection.id);
          response.writeHead(status, head);
          response.flushHeaders();
          // Unbuffered: each piece goes on as it comes.
          answer.on("data", (chunk: Buffer) => (chunks.push(chunk), response.write(chunk)));
          answer.on("end", () => (answered(route, head, Buffer.concat(chunks)), response.end()));
          return;
        }
        // A refusal is short: read whole, for what it says of the plan.
        answer.on("data", (chunk: Buffer) => chunks.push(chunk));
        answer.on("end", () => {
          const text = Buffer.concat(chunks);
 // A compact 401 is refreshed once, by Cloud, and the request resent.
          if (
            status === 401 &&
            again &&
            connection.secret !== undefined &&
            "refresh_token" in connection.secret &&
            freshen(connection, true)
          )
            return send(credentialOf(connection) ?? attach, false);
          const said = heard(connection, status, answer.headers, text.toString("utf8"));
          if (said.over) connection.status = "expired";
          if (said.usedUp !== undefined) {
            connection.status = "used_up";
            connection.used_up_until = said.usedUp;
            head["x-caveman-used-up"] =
              said.usedUp === null ? connection.id : `${connection.id}; until=${said.usedUp}`;
          }
          done(status, connection.id);
          answered(route, head, text);
          response.writeHead(status, head);
          response.end(text);
        });
      });
      forward.end(body);
    };
    send(credential, true);
  };

  // -------------------------------------------------------------------------------------------- the connector proxy

  /** A header a caller may not send on to an upstream: its own bearer, a cookie, anything that could carry a credential, Cloud's own. */
  const staysBehind = (name: string) =>
    [
      "host",
      "connection",
      "content-length",
      "accept-encoding",
      "authorization",
      "proxy-authorization",
      "cookie",
    ].includes(name) ||
    /api-?key|token|secret|credential|password/.test(name) ||
    name.startsWith("x-caveman-");
  const placedRepo = (owner: unknown, repo: unknown) =>
    typeof owner === "string" &&
    typeof repo === "string" &&
    config.placed.some((placed) => placed.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  /** What GitHub's API serves through the proxy below `repos/{owner}/{repo}` (CONTRACT §3.2). */
  const GITHUB_READS =
    /^(?:|\/(?:issues|pulls|commits|check-runs|check-suites|actions\/(?:runs|jobs|workflows)|branches|labels|milestones|releases|tags|compare)(?:\/.*)?)$/;
  /** A GitHub MCP tool named as a read. */
  const READ_TOOL = /^(?:get|list)_[a-z0-9_]+$|^[a-z0-9_]+_(?:read|get|list)$/;

  /** An MCP server behind the proxy (streamable HTTP, JSON answers). It takes `wanted` as its bearer and nothing else, and says what it was sent when it refuses. */
  const mcpUpstream = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    upstream: ConnectorSeen["upstream"],
    path: string,
    body: Buffer,
    wanted: string,
  ) => {
    const headers = JSON.stringify(request.headers);
    const bearer = bearerOf(request) ?? "";
    const seen = (status: number) =>
      report.connectors.push({
        upstream,
        method: request.method ?? "GET",
        path,
        credentials: kindsIn(headers),
        runtimeToken: headers.includes("ccrt_"),
        callerCredential: headers.includes("caller-held"),
        readOnly: request.headers["x-mcp-readonly"] === "true",
        status,
        body: body.toString("utf8").slice(0, 4_000),
      });
    const says = (status: number, out: unknown, extra: http.OutgoingHttpHeaders = {}) => {
      seen(status);
      response.writeHead(status, { "content-type": "application/json", ...extra });
      response.end(out === undefined ? undefined : JSON.stringify(out));
    };
    // A refusal that repeats the credential it was sent, as careless servers do.
    if (bearer !== wanted)
      return says(
        401,
        { error: "invalid_token", error_description: `the bearer ${bearer} is not accepted` },
        {
          "www-authenticate": `Bearer error="invalid_token", token="${bearer}"`,
          "set-cookie": `session=${bearer}`,
        },
      );
    if (request.method === "DELETE") return says(204, undefined);
    if (request.method !== "POST") return says(405, { error: "no stream here" });
    let frame: {
      id?: unknown;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown>; protocolVersion?: string };
    };
    try {
      frame = JSON.parse(body.toString("utf8")) as typeof frame;
    } catch {
      return says(400, { error: "not JSON" });
    }
    if (frame.id === undefined) return says(202, undefined);
    const result = (value: unknown) =>
      says(
        200,
        { jsonrpc: "2.0", id: frame.id, result: value },
        { "mcp-session-id": "session-of-the-upstream" },
      );
    if (frame.method === "initialize")
      return result({
        protocolVersion: frame.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: upstream, version: "1" },
      });
    if (frame.method === "tools/list")
      return result({
        tools: ["lookup", "echo_headers", "fail", "list_issues"].map((name) => ({
          name,
          inputSchema: { type: "object" },
        })),
      });
    const tool = frame.params?.name;
    // What it was sent, its bearer included: an answer that repeats the credential.
    if (tool === "echo_headers")
      return result({
        content: [
          {
            type: "text",
            text: `the upstream was sent authorization: ${request.headers.authorization}`,
          },
        ],
      });
    // An error that repeats it too.
    if (tool === "fail") return says(500, { error: `failed while holding ${bearer}` });
    return result({
      content: [
        {
          type: "text",
          text: `answer from the connector: ${tool}(${JSON.stringify(frame.params?.arguments ?? {})})`,
        },
      ],
    });
  };

  /** GitHub's API behind the proxy: the login's name and a repository's issues, for GitHub's canary only. */
  const githubUpstream = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    path: string,
    body: Buffer,
  ) => {
    const headers = JSON.stringify(request.headers);
    const says = (status: number, out: unknown) => {
      report.connectors.push({
        upstream: "github-api",
        method: request.method ?? "GET",
        path,
        credentials: kindsIn(headers),
        runtimeToken: headers.includes("ccrt_"),
        callerCredential: headers.includes("caller-held"),
        readOnly: false,
        status,
        body: body.toString("utf8").slice(0, 4_000),
      });
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(out));
    };
    const bearer = bearerOf(request) ?? "";
    if (bearer !== canaries.githubToken)
      return says(401, { message: `Bad credentials: ${bearer}` });
    if (path === "/user") return says(200, { login: "octo-person", id: 7 });
    const issues = /^\/repos\/([^/]+\/[^/]+)\/issues$/.exec(path);
    if (issues !== null) {
      return says(200, [
        {
          number: 12,
          title: "Widgets wobble",
          html_url: `https://github.com/${issues[1]}/issues/12`,
          created_at: "2026-11-01T00:00:00Z",
          labels: [{ name: "bug" }],
          assignees: [{ login: "octo-person" }],
        },
        {
          number: 11,
          title: "A pull request, left out",
          pull_request: {},
          created_at: "2026-10-30T00:00:00Z",
          labels: [],
        },
      ]);
    }
    return says(404, {
      message: "Not Found",
      documentation_url: `https://docs.github.com/rest (asked with ${bearer})`,
    });
  };

  /** The connector proxy (CONTRACT §3.2). */
  const connectorProxy = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
  ) => {
    const route = `proxy ${url.pathname}`;
    // A Cloud whose relay does not serve the route: its own 404, not Cloud's error body.
    if (config.connectorProxy === "absent") {
      answered(route, {}, "404 page not found\n");
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return void response.end("404 page not found\n");
    }
    const method = request.method ?? "GET";
    const match = /^\/relay\/v1\/mcp\/([^/]+)(\/.*)?$/.exec(url.pathname);
    const id = match === null ? "" : decodeURIComponent(match[1]!);
    const rest = (match?.[2] ?? "").replace(/\/+$/, "");
    const repository =
      typeof request.headers["x-caveman-repository"] === "string"
        ? request.headers["x-caveman-repository"]
        : null;
    const done = (status: number, code?: string) =>
      report.proxy.push({
        connection: id,
        method,
        path: rest,
        repository,
        status,
        ...(code === undefined ? {} : { code }),
      });
    const no = (status: number, code: string, message = code) => (
      done(status, code),
      refuse(response, route, status, code, {}, message)
    );
    if (!live(bearerOf(request))) return no(401, "cave_unauthorized");
    // Hosted runtimes only: the scope is read from the rows Cloud keeps about a computer.
    if (
      match === null ||
      !hosted(runtimeOf(request)) ||
      !["GET", "POST", "DELETE"].includes(method)
    )
      return no(404, "cave_not_found");
    if (config.connectorProxy === "off")
      return no(
        403,
        "cave_code_connection_kind_off",
        "The connector proxy is switched off on this Caveman Cloud.",
      );
    let target: { upstream: string; attach: string; extra?: http.OutgoingHttpHeaders };
    if (id === "github") {
      const kind = /^\/(api|mcp)(\/.*)?$/.exec(rest);
      if (kind === null) return no(404, "cave_not_found");
      if (config.connectors.find((c) => c.provider === "github")?.status !== "connected")
        return no(
          409,
          "cave_code_connection_reconnect",
          "GitHub is not connected for you in Caveman Cloud: connect it in the console first.",
        );
      const below = kind[2] ?? "";
      if (kind[1] === "api") {
        const repo = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(below);
        const allowed =
          method === "GET" &&
          (below === "/user" ||
            (repo !== null && placedRepo(repo[1], repo[2]) && GITHUB_READS.test(repo[3] ?? "")));
        if (!allowed)
          return no(
            403,
            "cave_code_github_scope",
            "On a Cloud computer GitHub's API is read-only, and only for the repositories this computer works in.",
          );
        target = { upstream: `/__upstream/github/api${below}`, attach: canaries.githubToken };
      } else {
        if (method === "POST") {
          let frame:
            | {
                id?: unknown;
                method?: string;
                params?: { name?: string; arguments?: { owner?: unknown; repo?: unknown } };
              }
            | undefined;
          try {
            frame = JSON.parse(body.toString("utf8")) as typeof frame;
          } catch {
            frame = undefined;
          }
          if (frame === undefined || Array.isArray(frame))
            return no(400, "cave_bad_request", "Send one JSON-RPC message per request.");
          const answer = (out: Record<string, unknown>) => (
            done(200),
            json(response, route, 200, { jsonrpc: "2.0", id: frame.id, ...out })
          );
          if (frame.method === "tools/call") {
            const args = frame.params?.arguments;
            if (!READ_TOOL.test(frame.params?.name ?? "") || !placedRepo(args?.owner, args?.repo)) {
              return answer({
                result: {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: "On a Cloud computer GitHub's tools only read the repositories this computer works in.",
                    },
                  ],
                },
              });
            }
          } else if (
            frame.id !== undefined &&
            !["initialize", "ping", "tools/list"].includes(frame.method ?? "")
          ) {
            return answer({
              error: {
                code: -32601,
                message: `${frame.method} is not served for GitHub on a Cloud computer.`,
              },
            });
          }
        }
        // Read-only, by the header and the path both.
        target = {
          upstream: `/__upstream/github/mcp${/(?:^|\/)readonly$/.test(below) ? below : `${below}/readonly`}`,
          attach: canaries.githubToken,
          extra: { "x-mcp-readonly": "true" },
        };
      }
    } else {
      // The person's own, a shared account Cloud offers this workspace, or (a service account's session) the account's.
      const row = config.connectors.find(
        (c) =>
          c.provider === "mcp" &&
          c.connection_id === id &&
          (c.owner !== "org" || c.offered === true),
      );
      const account = config.account.find((c) => c.id === id);
      if (row === undefined && account === undefined) return no(404, "cave_not_found");
      if (row !== undefined && row.status !== "connected")
        return no(
          409,
          "cave_code_connection_reconnect",
          "This connection needs you to sign in again.",
        );
      target = {
        upstream: `/__upstream/mcp/${encodeURIComponent(id)}${rest}`,
        attach: canaries.connectorToken,
      };
    }
    // Whatever credential the caller sent stays behind, and the connection's own is set.
    const headers: http.OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(request.headers))
      if (value !== undefined && !staysBehind(name)) headers[name] = value;
    const address = server.address() as net.AddressInfo;
    const forward = http.request({
      host: "127.0.0.1",
      port: address.port,
      path: `${target.upstream}${url.search}`,
      method,
      headers: {
        ...headers,
        ...target.extra,
        authorization: `Bearer ${target.attach}`,
        "accept-encoding": "identity",
        "content-length": body.length,
      },
    });
    forward.on("error", () => no(502, UPSTREAM_CODE, "The connector did not answer."));
    forward.on("response", (answer) => {
      const status = answer.statusCode ?? 502;
      const chunks: Array<Buffer> = [];
      answer.on("data", (chunk: Buffer) => chunks.push(chunk));
      answer.on("end", () => {
        // The upstream's own words for an error never reach the computer: its status, in Cloud's words. Its 401 is never
        // passed as one (that is the runtime token's): a sign-in the server no longer takes needs a new one.
        if (status === 401)
          return no(
            409,
            "cave_code_connection_reconnect",
            "The connector no longer accepts the sign-in Caveman holds for it: connect it again.",
          );
        if (status >= 400) return no(status, UPSTREAM_CODE, `The connector answered ${status}.`);
        const head: http.OutgoingHttpHeaders = { "x-caveman-connection": id };
        for (const [name, value] of Object.entries(answer.headers)) {
          if (
            value !== undefined &&
            ![
              "set-cookie",
              "www-authenticate",
              "content-length",
              "transfer-encoding",
              "connection",
            ].includes(name) &&
            !String(value).includes(target.attach)
          )
            head[name] = value;
        }
        // Every byte is searched for the credential the proxy attached: an occurrence goes back as asterisks.
        const text = Buffer.from(
          Buffer.concat(chunks)
            .toString("latin1")
            .split(target.attach)
            .join("*".repeat(target.attach.length)),
          "latin1",
        );
        done(status);
        answered(route, head, text);
        response.writeHead(status, { ...head, "content-length": text.length });
        response.end(text);
      });
    });
    forward.end(body);
  };

  /**
   * The routes Cloud closes to a hosted runtime under the rule (CONTRACT §2): a person's sign-in read, written or
   * refreshed; a connector's or GitHub's token leased, or its sign-in removed; secrets listed or changed (an engine's
   * key switch is one such write); synced settings written; a model connection's credential taken.
   */
  const closes = (method: string, route: string) =>
    /^\/engine-logins\/[^/]+(?:\/refresh)?$/.test(route) ||
    (route === "/connections/lease" && method === "POST") ||
    (/^\/connections\/[^/]+$/.test(route) && method === "DELETE") ||
    ((route === "/secrets" || (route.startsWith("/secrets/") && route !== "/secrets/resolve")) &&
      ["GET", "PUT", "DELETE"].includes(method)) ||
    (route === "/settings" && method === "PATCH") ||
    /^\/model-connections\/[^/]+\/access$/.test(route);

  /** Cloud's own routes that change under the rule, and a runtime's model connections; false: not one of them, so it passes through. */
  const cloudRoutes = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
  ): boolean => {
    const method = request.method ?? "GET";
    const under = "/api/v1/code/runtime";
    if (url.pathname !== under && !url.pathname.startsWith(`${under}/`)) return false;
    const route = url.pathname.slice(under.length);
    const name = `${method} runtime${route}`;
    const runtime = runtimeOf(request);
    const cloudComputer = hosted(runtime);
    const outside = config.credentialsOutside === true && cloudComputer;
    const authed = () =>
      live(bearerOf(request)) || (refuse(response, name, 401, "cave_unauthorized"), false);
    const connections = /^\/model-connections(\/.*)?$/.exec(route);
    // A laptop's other routes are the stand-in Cloud's behind this one, as they were.
    if (!cloudComputer && connections === null) return false;
    report.asked.push(name);
    if (connections !== null && !config.knowsConnections) {
      refuse(response, name, 404, "cave_not_found", {}, NO_ROUTE);
      return true;
    }
    if (cloudComputer && closes(method, route)) {
      report.closed.push(name);
      if (outside) {
        if (authed())
          (report.refused.push(name), refuse(response, name, 403, "cave_code_outside_computer"));
        return true;
      }
    }
    if (connections !== null) {
      if (!authed()) return true;
      const rest = connections[1] ?? "";
      // A Cloud computer only reads the list: everything else is the person's, from their own device or their laptop.
      if (cloudComputer && !(rest === "" && method === "GET"))
        refuse(response, name, 403, outside ? "cave_code_outside_computer" : "cave_forbidden");
      else
        connectionRoutes(
          response,
          name,
          method,
          rest,
          body,
          personOf(runtime),
          cloudComputer ? undefined : runtime,
        );
      return true;
    }
    if (route === "" && method === "GET") {
      if (authed())
        json(response, name, 200, {
          runtime_id: runtime ?? randomUUID(),
          hosted: true,
          ...(config.credentialsOutside === null
            ? {}
            : { credentials_outside: config.credentialsOutside }),
          ...(config.routesAuto === null
            ? {}
            : { routes_auto: config.credentialsOutside === true ? config.routesAuto : [] }),
        });
      return true;
    }
    const login = /^\/engine-logins(?:\/(claude|codex))?(\/refresh)?$/.exec(route);
    if (login !== null) {
      if (!authed()) return true;
      if (login[1] === undefined) {
        // The lanes, with no token (unchanged under the rule).
        const engines = ["claude", "codex"];
        json(response, name, 200, {
          logins: engines.map((engine) => ({ engine, status: "ready" })),
          lanes: engines.map((engine) => ({ engine, lane: "followed_login" })),
          person: "person-1",
        });
        return true;
      }
      // As Cloud answered before the rule: the person's sign-in, handed to the computer.
      const claude = login[1] === "claude";
      json(response, name, 200, {
        engine: login[1],
        version: 1,
        status: "ready",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        access_token: claude ? canaries.claudePlan : canaries.chatgptAccess,
        profile: claude
          ? { subscription_type: "max" }
          : { auth_mode: "chatgpt", account_id: "acct-of-the-person" },
        person: "person-1",
      });
      return true;
    }
    if (route === "/connections/lease" && method === "POST") {
      if (!authed()) return true;
      const asked = JSON.parse(body.toString("utf8") || "{}") as { provider?: string };
      json(response, name, 200, {
        access_token: asked.provider === "github" ? canaries.githubToken : canaries.connectorToken,
        token_type: "Bearer",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
      return true;
    }
    if (route === "/connections" && method === "GET") {
      // Names and states, never a token: allowed under the rule, and what the connector proxy is asked by.
      if (authed())
        json(response, name, 200, {
          connections: config.connectors.map((c) => ({
            ...c,
            updated_at: new Date().toISOString(),
          })),
        });
      return true;
    }
    if (route === "/secrets/resolve" && method === "POST") {
      if (!authed()) return true;
      const repository = url.searchParams.get("repository") ?? "";
      // Under the rule: the workspace's own repository secrets only, and no `credentials`.
      if (repository === "caveman:servers") {
        json(
          response,
          name,
          200,
          outside
            ? { secrets: [] }
            : {
                secrets: [
                  { name: "8f2b6c1d4a7e9f30.ANTHROPIC_API_KEY", value: canaries.anthropicKey },
                  { name: "personal.GATEWAY_KEY", value: canaries.gatewayKey },
                ],
              },
        );
        return true;
      }
      const secrets = [
        { name: "TEST_DATABASE_URL", value: "postgres://test:only-a-test-value@db.test/app" },
      ];
      // Under the rule a service account's credentials are named and not handed over (CONTRACT §3.2 `connectors`).
      json(
        response,
        name,
        200,
        outside
          ? { secrets, ...(config.account.length === 0 ? {} : { connectors: config.account }) }
          : {
              secrets,
              credentials: [
                {
                  type: "static_bearer",
                  match_url: "https://mcp.example.test/mcp",
                  token: canaries.connectorToken,
                },
              ],
            },
      );
      return true;
    }
    return false;
  };

  /** A person's own device, with their own Cloud session: §4's routes without `runtime/`. False: not one of them. */
  const personRoutes = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    url: URL,
    body: Buffer,
  ): boolean => {
    const match = /^\/api\/v1\/code\/model-connections(\/.*)?$/.exec(url.pathname);
    if (match === null) return false;
    const name = `${request.method} ${url.pathname.slice("/api/v1/code/".length)}`;
    if (!config.knowsConnections) {
      refuse(response, name, 404, "cave_not_found", {}, NO_ROUTE);
      return true;
    }
    const person = persons.get(bearerOf(request) ?? "");
    if (person === undefined) refuse(response, name, 401, "cave_unauthorized");
    else
      connectionRoutes(
        response,
        name,
        request.method ?? "GET",
        match[1] ?? "",
        body,
        person,
        undefined,
      );
    return true;
  };

  /** Everything else is the stand-in Cloud's: passed through, and its answer looked through like any other. */
  const passThrough = (
    request: http.IncomingMessage,
    response: http.ServerResponse,
    body: Buffer,
  ) => {
    const forward = http.request({
      host: inner.hostname,
      port: inner.port,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: inner.host },
    });
    forward.on("error", () => response.destroy());
    forward.on("response", (answer) => {
      const chunks: Array<Buffer> = [];
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.on("data", (chunk: Buffer) => (chunks.push(chunk), response.write(chunk)));
      answer.on("end", () => {
        const text = Buffer.concat(chunks);
        const path = (request.url ?? "").split("?")[0]!;
        // A runtime token this Cloud mints passes here: it is what the data plane takes.
        const mint = /^\/api\/v1\/code\/runtimes\/([^/]+)\/token$/.exec(path);
        if (mint !== null && answer.statusCode === 200) {
          const minted = JSON.parse(text.toString("utf8")) as { token: string; expires_at: string };
          tokens.set(minted.token, { until: Date.parse(minted.expires_at), runtime: mint[1]! });
        }
        // An enrolment passes here too: whose the runtime is, and that its enroller's session is that person's.
        if (
          path === "/api/v1/code/runtimes" &&
          request.method === "POST" &&
          answer.statusCode === 201
        ) {
          const enrolled = JSON.parse(text.toString("utf8")) as { id: string; user_id?: string };
          runtimes.set(enrolled.id, enrolled.user_id ?? FIRST);
          const session = bearerOf(request);
          if (session !== undefined) persons.set(session, enrolled.user_id ?? FIRST);
        }
        answered(`${request.method} ${request.url}`, answer.headers, text);
        response.end();
      });
    });
    forward.end(body);
  };

  const server = http.createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      const url = new URL(request.url ?? "/", "http://x");
      if (url.pathname.startsWith("/__test/")) {
        const done = (out: unknown) => (
          response.writeHead(200, { "content-type": "application/json" }),
          response.end(JSON.stringify(out))
        );
        if (url.pathname === "/__test/config") {
          const { connections, ...change } = JSON.parse(
            body.toString("utf8") || "{}",
          ) as Partial<EngineCloudConfig>;
          Object.assign(config, change);
          if (connections !== undefined)
            people.set(
              FIRST,
              connections.map((c) => ({ ...c })),
            );
          return done({});
        }
        if (url.pathname === "/__test/release") {
          for (const go of release.splice(0)) go();
          config.holdStream = false;
          return done({});
        }
        if (url.pathname === "/__test/approve") {
          let approved = 0;
          for (const sign of waiting.values())
            if (!sign.approved) ((sign.approved = true), approved++);
          return done({ approved });
        }
        const masked = (values: Iterable<[string, string]>) =>
          Object.fromEntries([...values].map(([name, value]) => [name, mask(value)]));
        return done({
          ...report,
          canaries: masked(Object.entries(canaries)),
          issued: masked(issued),
          people: Object.fromEntries(
            [...people.keys()].map((person) => [person, ordered(person).map(wire)]),
          ),
        });
      }
      const signIn = /^\/__provider\/oauth\/(start|finish|token)$/.exec(url.pathname);
      if (signIn !== null) return oauth(response, signIn[1]!, body);
      const provided = /^\/__provider\/(claude|codex|key\/[^/]+)(\/.*)$/.exec(url.pathname);
      if (provided !== null) return provider(request, response, provided[1]!, provided[2]!, body);
      // The upstreams behind the connector proxy: an MCP server, GitHub's API and GitHub's MCP server.
      const connector = /^\/__upstream\/(mcp\/[^/]+|github\/mcp|github\/api)(\/.*)?$/.exec(
        url.pathname,
      );
      if (connector !== null) {
        if (connector[1] === "github/api")
          return githubUpstream(request, response, connector[2] ?? "", body);
        return mcpUpstream(
          request,
          response,
          connector[1] === "github/mcp" ? "github-mcp" : "mcp",
          connector[2] ?? "",
          body,
          connector[1] === "github/mcp" ? canaries.githubToken : canaries.connectorToken,
        );
      }
      // A runtime that cannot reach Cloud: its call ends as a dead network ends it.
      if (cutOff(request, url)) return void request.socket.destroy();
      if (url.pathname.startsWith("/relay/v1/engine/"))
        return dataPlane(request, response, url, body);
      if (url.pathname.startsWith("/relay/v1/mcp/"))
        return connectorProxy(request, response, url, body);
      if (cloudRoutes(request, response, url, body)) return;
      if (personRoutes(request, response, url, body)) return;
      passThrough(request, response, body);
    });
  });
  // The relay's WebSocket, tunnelled as it is; what comes back to the runtime is looked through too.
  server.on("upgrade", (request, socket, head) => {
    if (cutOff(request, new URL(request.url ?? "/", "http://x"))) return void socket.destroy();
    const up = net.connect(Number(inner.port), inner.hostname, () => {
      up.write(
        `${request.method} ${request.url} HTTP/1.1\r\n${request.rawHeaders.reduce((lines, value, i) => (i % 2 === 0 ? lines : `${lines}${request.rawHeaders[i - 1]}: ${value}\r\n`), "")}\r\n`,
      );
      up.write(head);
      socket.pipe(up);
      up.on("data", (chunk: Buffer) => (answered("relay", {}, chunk), socket.write(chunk)));
    });
    const end = () => (up.destroy(), socket.destroy());
    up.on("error", end);
    up.on("close", end);
    socket.on("error", end);
    socket.on("close", end);
  });
  server.listen(0, "127.0.0.1", () =>
    process.stdout.write(
      `listening http://127.0.0.1:${(server.address() as net.AddressInfo).port}\n`,
    ),
  );
}

if (process.argv[2] === "serve" && process.argv[1] === fileURLToPath(import.meta.url))
  serve(process.argv[3]!);
