/**
 * Sign-ins for servers the runtime's MCP hub reaches: a local OAuth client
 * (protected-resource and authorization-server discovery, dynamic client
 * registration, PKCE in the system browser with a loopback callback, refresh)
 * for `auth: "oauth"` servers, and this computer's GitHub login for
 * `auth: "github"`. Tokens are sealed in the repository-secrets store (key in
 * the OS keychain, values scrubbed from session events) under a repository
 * of their own, and only the hub ever attaches them; no engine or plugin
 * sees one. The loopback callback works only where the browser and the
 * runtime share a computer.
 *
 * Signed in to Caveman Cloud (This Mac enrolled, and every Cloud computer):
 * Cloud holds the connection instead (cloudLink/connections.ts). Connect
 * starts Cloud's sign-in and answers its page, which the client opens in the
 * person's browser wherever it runs; status reads Cloud's list; the hub
 * attaches a token Cloud leases, kept in memory until a minute before it
 * expires and leased again after a 401. A refused refresh is Cloud's 409: the
 * server needs a new sign-in. GitHub leases the person's Cloud GitHub login,
 * falling back to this computer's gh/GH_TOKEN on This Mac only. A sign-in
 * this Mac made before linking keeps working here until it is connected
 * through Cloud; "Move to Cloud" (connect again) makes it with Cloud and then
 * forgets this Mac's copy. A server Cloud cannot sign in to (a URL with a
 * query, a private address, no client registration: Cloud's 400 or 422) is
 * signed in on This Mac instead, and says why. Nothing a Mac holds is ever
 * uploaded. A GitHub login goes only to GitHub's own hosts.
 *
 * On a Cloud computer whose person's credentials stay outside it
 * (cloudLink/credentialRule.ts) no token is leased at all, a connector's or
 * GitHub's: Cloud refuses the lease there. A server that signs in through
 * Caveman runs through Cloud's connector proxy instead
 * (cloudLink/connectorProxy.ts, cloud-computers CONTRACT §3.2): the hub sends
 * to `{cloud}/relay/v1/mcp/{connection}` with the runtime's own token, naming
 * the connection by the id Cloud listed (the person's own, else the shared
 * account Cloud offers this workspace), and Cloud attaches the sign-in outside
 * the computer. GitHub's MCP server goes the same way, read-only, and so do
 * the runtime's own GitHub reads (github.status, github.issues). Status reads
 * Cloud's list, which carries names and no token. Connecting and removing stay
 * on the person's own device; git and pull requests go on through Cloud's git
 * proxy and App. What has no such route says so where its state is shown: a
 * GitHub login asked for by a server that is not GitHub's MCP server, and a
 * Cloud that does not run the proxy.
 *
 * @module plugins/connectors
 */
import { createHash } from "node:crypto";

import { type AuthProvider, McpClient, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import {
  adaptOAuthProvider,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
  OAuthCallbackServer,
  OAuthError,
  refreshAuthorization,
  selectResource,
} from "@earendil-works/pi-mcp/oauth";
import * as GitHubCredentials from "@caveman-app/source-control-github/server/GitHubCredentials";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import {
  canonicalResource,
  type CloudConnection,
  type ConnectionTarget,
  deleteConnection,
  githubHost,
  leaseConnection,
  leasedTokens,
  listConnections,
  RECONNECT,
  startConnection,
} from "../cloudLink/connections.ts";
import {
  connectorUrl,
  githubApiGet,
  githubMcpBelow,
  githubMcpUrl,
  pathBelow,
  type ProxiedRead,
  proxyFetch,
  RECONNECT_ELSEWHERE_TEXT,
  REPOSITORY_HEADER,
  runtimeBearer,
  UNREACHABLE_TEXT,
} from "../cloudLink/connectorProxy.ts";
import { onYourMac, OUTSIDE_COMPUTER, PLUGINS_WHERE } from "../cloudLink/credentialRule.ts";
import { credentialRule } from "../cloudLink/credentialsOutside.ts";
import { CloudError, type Identity, readIdentity } from "../cloudLink/identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf } from "../cloudLink/index.ts";
import * as ServerConfig from "../config.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { McpHubAuth, McpHubError, type TransportAuth } from "./McpHub.ts";

/**
 * Where a person signs in again, as the app shows it: the plugin's page (its Connect row), or the server's own page
 * under Plugins > Installed for a server of their own.
 */
export const connectWhere = (pluginId: string | undefined): string =>
  pluginId === undefined ? "Plugins > Installed, on the server's page" : `Plugins > ${pluginId.split("@")[0]} > Connect`;

/** The repository key connector sign-ins are kept under in the repository-secrets store. */
export const CONNECTORS_REPOSITORY = "caveman:connectors";
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const CLIENT_METADATA = {
  client_name: "Caveman Code",
  client_uri: "https://caveman.so",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

export type SignInStatus = "connected" | "needs_sign_in" | "signing_in" | "error";

export interface Connection {
  readonly status: SignInStatus;
  /** Why it is not connected, in a sentence. */
  readonly problem?: string;
  /** While signing in: the page to open in the system browser. */
  readonly authorizationUrl?: string;
  /** Connected: who holds the sign-in, Caveman Cloud or only this computer. */
  readonly heldBy?: "cloud" | "this_computer";
  /** Held by this computer only because Caveman Cloud cannot sign in to the server: why, in a sentence. */
  readonly heldReason?: string;
  /** The sign-in in use is the team's shared account (a shared install), not the person's own. */
  readonly shared?: boolean;
  /** Who connected that shared account, when Cloud says. */
  readonly sharedBy?: string;
}

/** A shared install's plugin: its servers may use the team's account when the person has none of their own. */
export interface SharedInstall {
  readonly pluginId: string;
  /** The team's account alone, as an admin who sets it up sees it: their own sign-in does not stand in for it. */
  readonly alone?: boolean;
}

export class Connectors extends Context.Service<
  Connectors,
  {
    /**
     * A server's sign-in: the person's own. For a server of a shared install
     * (`shared`), the person's own when they have one (one that needs a
     * reconnect says so; it never silently becomes the team's), else the
     * team's account an admin connected for that plugin.
     */
    readonly status: (
      server: { readonly name: string; readonly url: string; readonly auth: "oauth" | "github" },
      /** `repository` (`host/owner/name`): the repository a chat works in, so a shared account is the one Cloud offers that chat's project on a Cloud computer. */
      options?: { readonly shared?: SharedInstall; readonly repository?: string },
    ) => Effect.Effect<Connection>;
    /**
     * Starts a sign-in: an OAuth server answers `signing_in` with the page to
     * open (the runtime waits for the browser's redirect on a loopback port),
     * or `connected` when it already holds a working one. The GitHub login
     * is the computer's own (gh or GH_TOKEN): its status, never a sign-in here.
     */
    readonly connect: (
      server: { readonly name: string; readonly url: string; readonly auth: "oauth" | "github" },
      /** `shared`: an org admin connects one account Caveman Cloud leases to every member for that plugin (signed in only). */
      options?: { readonly moveToCloud?: boolean; readonly shared?: SharedInstall },
    ) => Effect.Effect<Connection>;
    /** Forgets an OAuth server's sign-in (tokens and client registration), and the person's own connection in Cloud when linked; never the team's. */
    readonly disconnect: (url: string) => Effect.Effect<void, Error>;
    /** Removes the team's account for a shared install's server from Caveman Cloud (an org admin's; Cloud revokes its tokens). */
    readonly disconnectShared: (server: { readonly url: string; readonly auth: "oauth" | "github" }, shared: SharedInstall) => Effect.Effect<void, Error>;
    /**
     * The GitHub login the runtime's own GitHub reads use (github.status, github.issues): the person's Cloud GitHub
     * login, leased, while signed in to Caveman Cloud and connected there, else this computer's gh or GH_TOKEN (This
     * Mac only, as the hub does). Fails with what the person can do about it. The token stays in the runtime.
     */
    readonly github: Effect.Effect<GitHubLogin, string>;
    /**
     * Starts connecting the person's GitHub to Caveman Cloud (github.connect): Cloud's page to open in the browser,
     * or undefined while this runtime is not signed in to Caveman Cloud. Forgets the Cloud list and GitHub lease kept
     * here, so `github` asks Cloud afresh and sees the connection on its next read once the person is done there.
     * Fails with Cloud's refusal.
     */
    readonly connectGitHub: Effect.Effect<string | undefined, unknown>;
  }
>()("caveman/plugins/Connectors") {}

/**
 * A GitHub login and where it came from: a token (Cloud's lease, `gh`, or GH_TOKEN; a token saved in Settings counts
 * as gh's), or, on a Cloud computer the person's sign-ins stay outside of, no token at all: reads of GitHub's API
 * through Cloud's connector proxy, which attaches the person's Cloud GitHub login outside the computer.
 */
export type GitHubLogin =
  | { readonly token: Redacted.Redacted<string>; readonly source: "cloud" | "gh" | "env" }
  | { readonly source: "cloud"; readonly proxy: GitHubReads };

/** GitHub's API as such a computer reads it: GETs of the repositories Cloud placed on it, and of the login's own name. */
export interface GitHubReads {
  /** Names this login where one is remembered (a name cache); nothing of the login itself. */
  readonly key: string;
  /** One GET (`path` below the API root, query included). A refusal rejects with Cloud's status, code and sentence (CloudError). */
  readonly get: (path: string) => Promise<ProxiedRead>;
}

/** No GitHub login on This Mac. */
export const NO_GITHUB_TEXT = "Run `gh auth login` in a terminal, or connect GitHub through Caveman.";
/**
 * A server that asks for the GitHub login on a Cloud computer the login may not enter (credentialRule.ts), at an
 * address that is not GitHub's MCP server: Cloud's proxy sends the login there and to GitHub's API reads only.
 */
export const OUTSIDE_GITHUB_SERVER_TEXT = `This server doesn't work in Cloud yet. Use it in a chat ${onYourMac()}.`;
/**
 * Connecting a connector from inside such a computer: Cloud is asked nothing, and this is the answer. Also what a
 * server there whose sign-in nobody has made yet says, after its name.
 */
export const OUTSIDE_CONNECT_TEXT = `Connect it ${onYourMac(PLUGINS_WHERE)}. It then works in Cloud too.`;
/** Disconnecting or removing one from inside such a computer: Cloud is asked nothing, and this is the answer. */
export const OUTSIDE_REMOVE_TEXT = `Remove it ${onYourMac(PLUGINS_WHERE)}.`;
/**
 * GitHub on such a computer while the person has not connected it to Caveman, and what connecting it from inside one
 * says (github.connect): git itself and pull requests do not need the login.
 */
export const OUTSIDE_GITHUB_TEXT = `Connect GitHub ${onYourMac()} to read issues here. Pushing and pull requests already work.`;
/** The lease that is never asked for under the rule, and Cloud's refusal of one an older path asked for. */
class LeaseOutside extends Error {}
const leaseOutside = (cause: unknown) => cause instanceof LeaseOutside || (cause instanceof CloudError && cause.code === OUTSIDE_COMPUTER);

/** No GitHub login on a Cloud computer, which never uses a login of its own. */
export const NO_CLOUD_GITHUB_TEXT = "Connect GitHub to Caveman to use it on this computer.";

/** What is kept per server: pi-mcp's OAuth state and the redirect its client was registered with. */
interface Saved {
  readonly state: McpOAuthState;
  readonly redirectUrl: string;
  /** Signed in here because Caveman Cloud refused the server: what to tell the person. */
  readonly heldReason?: string;
  /** It had a sign-in that stopped working (its server refused the refresh): a reconnect, not a first sign-in. */
  readonly lost?: true;
}

/** A sign-in whose refresh its server refused, or that expired with nothing to refresh it. */
export const EXPIRED_TEXT = "Its sign-in stopped working: connect it again.";
/**
 * An expired access token (or one this close to it) is refreshed when its status is asked, so status tells the
 * truth. Only then: a token still in date works, and refreshing it on every list would only spend refreshes.
 */
const REFRESH_AHEAD_MS = 5_000;
/** A refresh check that could not reach the server is not tried again for this long (status stays connected). */
const RECHECK_MS = 60_000;
const REFRESH_TIMEOUT_MS = 10_000;

const secretName = (url: string) => `MCP_OAUTH_${createHash("sha256").update(url).digest("hex").slice(0, 24).toUpperCase()}`;
const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
/** A Cloud sign-in nobody finished in this long is over. */
const CLOUD_SIGN_IN_MS = SIGN_IN_TIMEOUT_MS;
/**
 * One list of Cloud's connections serves every status asked this close together (mcp.list asks per server). Shorter
 * than the app's github.status poll (3 s), so a connection finished in Cloud shows on the next poll.
 */
const LIST_REUSE_MS = 2_000;
const RECONNECT_TEXT = "Caveman's sign-in for it stopped working: reconnect it.";
const targetKey = (target: ConnectionTarget) =>
  `${"provider" in target ? `provider:${target.provider}` : target.resource}${target.plugin_id === undefined ? "" : `\0${target.plugin_id}\0${target.repository ?? ""}`}`;
/** A server that asks for the GitHub login at an address that is not GitHub's (github.com, api.github.com, api.githubcopilot.com): the login goes only there. */
const NOT_GITHUB = "This server can't use your GitHub sign-in. Give it its own key.";
/** Cloud's start refused the server itself (its URL, its address, its sign-in), not a passing failure. */
const cloudCannot = (cause: unknown) => cause instanceof CloudError && (cause.status === 400 || cause.status === 422);
/** Why This Mac holds a sign-in itself, in one sentence: Cloud's own refusal. */
const cannotText = (cause: unknown) => `Signed in on this Mac only, because Caveman refused it: ${errorText(cause)}`;

export const make = Effect.gen(function* () {
  const secrets = yield* ProjectSecrets;
  const github = yield* Effect.serviceOption(GitHubCredentials.GitHubCredentials);
  const config = yield* ServerConfig.ServerConfig;
  const computer = yield* CloudComputer;
  const link = yield* CloudLinkState;
  const rule = yield* credentialRule;
  const signingIn = new Map<string, string>();
  const failures = new Map<string, string>();
  /** The Cloud identity while this runtime is signed in to Caveman Cloud (always, on a Cloud computer). */
  const linked = () => readIdentity(computer?.linkDir ?? linkDirOf(config.stateDir));
  /**
   * Whether this is a Cloud computer whose person's sign-ins stay outside it (credentialRule.ts; never a Mac). There
   * a connector runs through Cloud's connector proxy and is never managed: Cloud is asked for its list (names, no
   * token) and for no lease, start or removal. Fails with Cloud's failure while it cannot say which.
   */
  const outsideHere = Effect.tryPromise({ try: () => rule.outside(), catch: (cause) => cause });

  const load = (url: string) =>
    Effect.runPromise(
      secrets.resolve(CONNECTORS_REPOSITORY).pipe(
        Effect.map((entries) => entries.find((e) => e.name === secretName(url))),
        Effect.map((entry) => (entry === undefined ? undefined : (JSON.parse(entry.value) as Saved))),
      ),
    );
  const save = (url: string, saved: Saved) =>
    Effect.runPromise(secrets.set(CONNECTORS_REPOSITORY, [{ name: secretName(url), value: Redacted.make(JSON.stringify(saved)) }])).then(() => undefined);

  /** When a refresh check last failed to reach the server, per URL; new tokens clear it. */
  const unreachable = new Map<string, number>();
  /** Why this Mac signed in itself, per server URL, until the sign-in is saved with it. */
  const heldReasons = new Map<string, string>();
  /** pi-mcp's state for one server, registered for `redirectUrl`; a client registered for another redirect registers again. */
  const storeFor = (url: string, redirectUrl: string): McpOAuthStateStore => ({
    load: async () => {
      const saved = await load(url);
      if (saved === undefined) return undefined;
      if (saved.redirectUrl === redirectUrl) return saved.state;
      const { clientInformation: _client, ...rest } = saved.state;
      return rest;
    },
    save: async (state) => {
      const before = await load(url);
      const heldReason = heldReasons.get(url) ?? before?.heldReason;
      // Tokens dropped by pi-mcp (a refused refresh) mean the sign-in was lost, until new ones arrive.
      const lost = state.tokens === undefined && (before?.state.tokens !== undefined || before?.lost === true);
      if (state.tokens?.access_token !== before?.state.tokens?.access_token) unreachable.delete(url);
      return save(url, { state, redirectUrl, ...(heldReason === undefined ? {} : { heldReason }), ...(lost ? { lost: true as const } : {}) });
    },
  });

  /**
   * One refresh at a time per server, shared by the status check and the hub's 401 handling: with rotating
   * refresh tokens, a second refresh with the old token would fail and throw the new grant away.
   */
  const refreshing = new Map<string, Promise<unknown>>();
  const oneAtATime = <A>(url: string, run: () => Promise<A>): Promise<A> => {
    const next = (refreshing.get(url) ?? Promise.resolve()).then(run, run);
    const settled = next.catch(() => undefined);
    refreshing.set(url, settled);
    void settled.then(() => refreshing.get(url) === settled && refreshing.delete(url));
    return next;
  };

  /**
   * A stored sign-in about to expire is refreshed now, so its status is the truth: "connected" only while it
   * works. Its server refusing the refresh (or no refresh token) means reconnect; a server that does not
   * answer leaves it connected, and is asked again a minute later. Never registers a client or opens a page.
   */
  const checkFresh = (url: string, saved: Saved): Promise<Saved | undefined> =>
    oneAtATime(url, async () => {
      const current = (await load(url)) ?? saved;
      const { tokens, tokensExpireAt, discovery, clientInformation } = current.state;
      if (tokens === undefined || tokensExpireAt === undefined || tokensExpireAt > Date.now() + REFRESH_AHEAD_MS) return current;
      if (Date.now() - (unreachable.get(url) ?? 0) < RECHECK_MS) return current;
      const provider = new McpOAuthProvider({ serverUrl: url, redirectUrl: current.redirectUrl, clientMetadata: CLIENT_METADATA, store: storeFor(url, current.redirectUrl), onRedirect: () => undefined });
      if (tokens.refresh_token === undefined) {
        await provider.invalidateCredentials("tokens");
        return load(url);
      }
      if (discovery?.authorizationServerUrl === undefined || clientInformation === undefined) return current;
      try {
        const fresh = await refreshAuthorization(discovery.authorizationServerUrl, {
          ...(discovery.authorizationServerMetadata === undefined ? {} : { metadata: discovery.authorizationServerMetadata }),
          clientInformation,
          ...(selectResource(url, discovery.resourceMetadata) === undefined ? {} : { resource: selectResource(url, discovery.resourceMetadata)! }),
          refreshToken: tokens.refresh_token,
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
        });
        // As pi-mcp keeps them: the old refresh token when none is sent back, the grant's scope when none is named.
        await provider.saveTokens({ refresh_token: tokens.refresh_token, ...(tokens.scope === undefined ? {} : { scope: tokens.scope }), ...fresh });
      } catch (cause) {
        // As pi-mcp's own flow decides: only a refused grant or client means the sign-in is gone; anything
        // else (no answer, a 5xx, temporarily_unavailable) says nothing about it.
        const gone = cause instanceof OAuthError ? (cause.code === "invalid_grant" ? "tokens" : ["invalid_client", "unauthorized_client"].includes(cause.code) ? "all" : undefined) : undefined;
        if (gone === undefined) {
          unreachable.set(url, Date.now());
          return current;
        }
        await provider.invalidateCredentials(gone);
      }
      return load(url);
    });

  const oauthStatus = (url: string) =>
    Effect.tryPromise(async () => {
      const saved = await load(url);
      return saved === undefined || signingIn.has(url) ? saved : checkFresh(url, saved);
    }).pipe(
      Effect.map((saved): Connection => {
        const heldReason = saved?.heldReason ?? heldReasons.get(url);
        const why = heldReason === undefined ? {} : { heldReason };
        if (signingIn.has(url)) return { status: "signing_in", authorizationUrl: signingIn.get(url)!, ...why };
        const failure = failures.get(url);
        if (failure !== undefined) return { status: "error", problem: failure };
        if (saved?.state.tokens !== undefined) return { status: "connected", heldBy: "this_computer", ...why };
        return saved?.lost === true ? { status: "needs_sign_in", problem: EXPIRED_TEXT } : { status: "needs_sign_in" };
      }),
      Effect.catch((error) => Effect.succeed<Connection>({ status: "error", problem: errorText(error.cause ?? error) })),
    );

  const githubToken = Option.isNone(github)
    ? Effect.fail("This runtime has no GitHub login: set GH_TOKEN, or run `gh auth login`.")
    : github.value.get("github.com").pipe(
        Effect.map((credential) => Redacted.value(credential.token)),
        Effect.mapError((error) => error.message),
      );

  const githubStatus = githubToken.pipe(
    Effect.as<Connection>({ status: "connected", heldBy: "this_computer" }),
    Effect.catch((problem) => Effect.succeed<Connection>({ status: "needs_sign_in", problem })),
  );

  const signIn = (url: string) =>
    Effect.promise(async (): Promise<Connection> => {
      const callback = await OAuthCallbackServer.listen({ host: "127.0.0.1", path: "/oauth/callback", timeoutMs: SIGN_IN_TIMEOUT_MS });
      let authorizationUrl: URL | undefined;
      const provider = new McpOAuthProvider({
        serverUrl: url,
        redirectUrl: callback.redirectUrl,
        clientMetadata: CLIENT_METADATA,
        store: storeFor(url, callback.redirectUrl),
        onRedirect: (page) => {
          authorizationUrl = page;
        },
      });
      const client = new McpClient({ name: "caveman-code", version: RUNTIME_VERSION });
      try {
        await client.connect(new StreamableHttpTransport({ url, authProvider: adaptOAuthProvider(provider), openGetStream: false }));
        await client.close();
        await callback.close();
        failures.delete(url);
        const heldReason = heldReasons.get(url);
        return { status: "connected", heldBy: "this_computer", ...(heldReason === undefined ? {} : { heldReason }) };
      } catch (cause) {
        await client.close().catch(() => undefined);
        if (!(cause instanceof McpOAuthAuthorizationRequiredError) || authorizationUrl === undefined) {
          await callback.close();
          failures.set(url, errorText(cause));
          return { status: "error", problem: errorText(cause) };
        }
      }
      const state = await provider.state();
      const page = authorizationUrl.href;
      signingIn.set(url, page);
      failures.delete(url);
      // The person finishes in the browser; the runtime takes the redirect and keeps the tokens.
      void callback
        .waitForCallback(state)
        .then(({ code, iss }) => authorizeMcp(provider, { serverUrl: url, authorizationCode: code, ...(iss === undefined ? {} : { iss }) }))
        .then(
          () => failures.delete(url),
          (cause) => failures.set(url, errorText(cause)),
        )
        .finally(() => {
          signingIn.delete(url);
          void callback.close();
        });
      const heldReason = heldReasons.get(url);
      return { status: "signing_in", authorizationUrl: page, ...(heldReason === undefined ? {} : { heldReason }) };
    });

  // Cloud-held connections.
  /** Sign-in pages Cloud gave this runtime, by target, while Cloud says the sign-in is pending. */
  const cloudPages = new Map<string, string>();
  const leases = new Map<string, Promise<{ readonly token: string; readonly refreshAt: number }>>();
  // The rule came on while this computer ran: no lease taken before it is used again.
  rule.onOutside(() => leases.clear());
  let listed: { readonly at: number; readonly rows: Promise<ReadonlyArray<CloudConnection>> } | undefined;

  const cloudRows = (identity: Identity) => {
    if (listed === undefined || Date.now() - listed.at > LIST_REUSE_MS) {
      const rows = listConnections(identity, link);
      listed = { at: Date.now(), rows };
      rows.catch(() => listed?.rows === rows && (listed = undefined));
    }
    return listed.rows;
  };
  /** Whether a row of Cloud's list is for `target`: GitHub's, or the server at that address. */
  const rowIs = (r: CloudConnection, target: ConnectionTarget) =>
    "provider" in target ? r.provider === target.provider : r.provider !== "github" && r.resource !== undefined && canonicalResource(r.resource) === canonicalResource(target.resource);
  /** The person's own row for a target; with `shared`, the team's row for that plugin instead. Org rows never stand in for a person's. */
  const rowFor = (rows: ReadonlyArray<CloudConnection>, target: ConnectionTarget, shared?: SharedInstall) =>
    rows.find((r) => (shared === undefined ? r.owner !== "org" : r.owner === "org" && r.plugin_id === shared.pluginId) && rowIs(r, target));
  const fromCloud = (row: CloudConnection | undefined, target: ConnectionTarget): Connection => {
    const key = targetKey(target);
    if (row?.status !== "pending") cloudPages.delete(key);
    switch (row?.status) {
      case undefined:
        return { status: "needs_sign_in" };
      case "connected":
        return { status: "connected", heldBy: "cloud" };
      case "pending": {
        const page = cloudPages.get(key);
        if (Date.now() - Date.parse(row.updated_at) > CLOUD_SIGN_IN_MS) {
          cloudPages.delete(key);
          return { status: "error", problem: "The sign-in was not finished in time: connect again." };
        }
        return page === undefined ? { status: "signing_in" } : { status: "signing_in", authorizationUrl: page };
      }
      case "needs_reconnect":
        return { status: "needs_sign_in", problem: row.problem || RECONNECT_TEXT };
      case "error":
        return { status: "error", problem: row.problem || "The sign-in failed: connect again." };
    }
  };
  const cloudTrouble = (cause: unknown): Connection => ({ status: "error", problem: `Caveman did not answer: ${errorText(cause)}` });

  /** A leased access token, from memory until a minute before it expires; `stale` is one a server just refused. */
  const lease = (identity: Identity, target: ConnectionTarget, stale?: string): Promise<string> => {
    const key = targetKey(target);
    const current = leases.get(key);
    let refused = false;
    const fresh = current?.then(
      (l) => {
        refused = l.token === stale;
        return !refused && Date.now() < l.refreshAt ? l : undefined;
      },
      () => undefined,
    );
    return (fresh ?? Promise.resolve(undefined)).then((l): Promise<string> | string => {
      if (l !== undefined) return l.token;
      if (leases.get(key) !== current) return lease(identity, target, stale); // another call leased meanwhile
      // Never under the rule (and not while Cloud cannot say): a leased token would sit in a computer its agent owns.
      const next = rule.outside().then((outside) => (outside ? Promise.reject(new LeaseOutside()) : leaseConnection(identity, link, target, refused))).then((out) => {
        leasedTokens.add(out.access_token);
        return { token: out.access_token, refreshAt: Date.parse(out.expires_at) - 60_000 };
      });
      leases.set(key, next);
      next.catch(() => {
        if (leases.get(key) === next) leases.delete(key);
        listed = undefined; // Cloud's status may have changed (a refused refresh)
      });
      return next.then((l) => l.token);
    });
  };
  /** Every lease kept of one connection: its own and each plugin server's (`targetKey` adds the plugin and repository). */
  const forgetLeases = (of: (head: string) => boolean) => {
    for (const key of leases.keys()) if (of(key.split("\0")[0]!)) leases.delete(key);
  };
  const reconnects = (cause: unknown) => cause instanceof CloudError && (cause.status === 409 || cause.code === RECONNECT);
  const reconnectText = (plugin: string | undefined) => `it needs a new sign-in: reconnect it in ${connectWhere(plugin)}.`;
  /** The hub's provider for a Cloud-held connection: the lease as the bearer, leased again after the server's 401. */
  const leasedAuth = (identity: Identity, target: ConnectionTarget): AuthProvider => {
    let refused: string | undefined;
    return {
      token: () =>
        lease(identity, target, refused).catch((cause) => {
          throw reconnects(cause) ? new Error(reconnectText(target.plugin_id)) : cause;
        }),
      onUnauthorized: async ({ token }) => {
        refused = token;
      },
    };
  };

  /** This Mac's own sign-in for a server Cloud now holds a working one for: forgotten (once a run). */
  const forgotten = new Set<string>();
  const forgetLocal = (url: string) =>
    forgotten.has(url)
      ? Effect.void
      : Effect.sync(() => {
          forgotten.add(url);
          heldReasons.delete(url);
        }).pipe(Effect.andThen(secrets.remove(CONNECTORS_REPOSITORY, secretName(url))), Effect.ignore);

  // On a Cloud computer the person's sign-ins stay outside of: through Cloud's connector proxy (connectorProxy.ts).
  /**
   * Cloud's list as a chat in `repository` is offered it (the `offered` of its shared accounts is about that chat's
   * workspace), read once per repository every LIST_REUSE_MS, as `cloudRows` reads the list.
   * ponytail: a list per repository is never swept; a computer's repositories number in the dozens.
   */
  const listedFor = new Map<string, { readonly at: number; readonly rows: Promise<ReadonlyArray<CloudConnection>> }>();
  const rowsFor = (identity: Identity, repository: string | undefined) => {
    if (repository === undefined) return cloudRows(identity);
    const kept = listedFor.get(repository);
    if (kept !== undefined && Date.now() - kept.at <= LIST_REUSE_MS) return kept.rows;
    const rows = listConnections(identity, link, undefined, repository);
    listedFor.set(repository, { at: Date.now(), rows });
    rows.catch(() => listedFor.get(repository)?.rows === rows && listedFor.delete(repository));
    return rows;
  };
  /**
   * The row a server runs on through the proxy, in Cloud's lease order: the person's own when it holds a sign-in,
   * else the first shared account Cloud offers this workspace for the plugin (a project's own before the team's, as
   * Cloud lists them), else a sign-in of their own that was started and never finished. `alone`: the team's only.
   */
  const proxiedRow = (rows: ReadonlyArray<CloudConnection>, target: ConnectionTarget, plugin: string | undefined, alone = false) => {
    const own = alone ? undefined : rowFor(rows, target);
    if (own !== undefined && own.status !== "pending") return { row: own, shared: false };
    const team = plugin === undefined ? undefined : rows.find((r) => r.owner === "org" && r.plugin_id === plugin && r.offered === true && rowIs(r, target));
    return team !== undefined ? { row: team, shared: true } : own === undefined ? undefined : { row: own, shared: false };
  };
  /** A server's state there, from Cloud's list alone: it runs through Cloud when its row is connected; nothing is leased to say so. */
  const proxiedStatus = (identity: Identity, server: { readonly url: string; readonly auth: "oauth" | "github" }, shared?: SharedInstall, repository?: string): Effect.Effect<Connection> => {
    if (server.auth === "github" && githubMcpBelow(server.url) === undefined) return Effect.succeed<Connection>({ status: "error", problem: OUTSIDE_GITHUB_SERVER_TEXT });
    const target: ConnectionTarget = server.auth === "github" ? { provider: "github" } : { resource: server.url };
    return Effect.tryPromise(() => rowsFor(identity, repository)).pipe(
      Effect.map((rows): Connection => {
        if (server.auth === "github") return rowFor(rows, target)?.status === "connected" ? { status: "connected", heldBy: "cloud" } : { status: "needs_sign_in", problem: OUTSIDE_GITHUB_TEXT };
        const chosen = proxiedRow(rows, target, shared?.pluginId, shared?.alone === true);
        // No row: the client says where a connector is connected (never from here).
        if (chosen === undefined) return shared?.alone === true ? { status: "needs_sign_in", shared: true } : { status: "needs_sign_in" };
        const by = chosen.shared ? chosen.row.signed_in_by_name || undefined : undefined;
        const team = chosen.shared ? { shared: true as const, ...(by === undefined ? {} : { sharedBy: by }) } : {};
        switch (chosen.row.status) {
          case "connected":
            return { status: "connected", heldBy: "cloud", ...team };
          case "pending":
            return { status: "signing_in", ...team };
          case "needs_reconnect":
            return { status: "needs_sign_in", problem: RECONNECT_ELSEWHERE_TEXT, ...team };
          case "error":
            return { status: "error", problem: chosen.row.problem || `Its sign-in failed. Reconnect it ${onYourMac(PLUGINS_WHERE)}.`, ...team };
        }
      }),
      Effect.catch((error) => Effect.succeed(cloudTrouble(error.cause))),
    );
  };
  /**
   * The hub's way to a server there: Cloud's proxy for the connection Cloud listed, with the runtime's own token and
   * the chat's repository. Nothing is leased and no token of the server's is ever here; the server's own address is
   * never dialed. A server with no connected row fails now, saying where it is connected.
   */
  const proxiedAuth = (identity: Identity, target: Parameters<McpHubAuth["Service"]["transportAuth"]>[0]): Effect.Effect<TransportAuth, McpHubError> => {
    const fail = (message: string, reason: "sign_in" | "failed" = "sign_in") => Effect.fail(new McpHubError({ message, reason }));
    const through = (url: string): TransportAuth => ({
      url,
      authProvider: runtimeBearer(identity, link),
      fetch: proxyFetch(),
      ...(target.auth.repository === undefined ? {} : { headers: { [REPOSITORY_HEADER]: target.auth.repository } }),
    });
    // A service account's connector, by the name Cloud gave it (accountCredentials.ts): its token is the account's.
    if (target.auth.account !== undefined) {
      const below = pathBelow(target.auth.url, target.auth.account.matchUrl);
      return below === undefined ? fail(`${target.key}: its address is not under the one its credential is for.`, "failed") : Effect.succeed(through(connectorUrl(identity, target.auth.account.id, below)));
    }
    const github = target.auth.auth === "github";
    const below = github ? githubMcpBelow(target.auth.url) : undefined;
    if (github && below === undefined) return fail(`${target.key}: ${OUTSIDE_GITHUB_SERVER_TEXT}`);
    const cloudTarget: ConnectionTarget = github ? { provider: "github" } : { resource: target.auth.url };
    return Effect.tryPromise(() => rowsFor(identity, target.auth.repository)).pipe(
      Effect.mapError(({ cause }) => new McpHubError({ message: `${target.key}: Caveman did not answer: ${errorText(cause)}`, reason: "failed" })),
      Effect.flatMap((rows) => {
        if (github) return rowFor(rows, cloudTarget)?.status === "connected" ? Effect.succeed(through(githubMcpUrl(identity, below))) : fail(`${target.key}: ${OUTSIDE_GITHUB_TEXT}`);
        const chosen = proxiedRow(rows, cloudTarget, target.auth.plugin);
        if (chosen === undefined) return fail(`${target.key} isn't connected. ${OUTSIDE_CONNECT_TEXT}`);
        switch (chosen.row.status) {
          case "connected":
            // The row's own address is the one Cloud sends to; what the server's URL adds below it goes with it.
            return Effect.succeed(through(connectorUrl(identity, chosen.row.connection_id, pathBelow(target.auth.url, chosen.row.resource ?? target.auth.url) ?? "")));
          case "needs_reconnect":
            return fail(`${target.key}'s sign-in expired. Reconnect it ${onYourMac(connectWhere(target.auth.plugin))}.`);
          default:
            return fail(`${target.key}'s sign-in isn't finished. Finish it ${onYourMac(connectWhere(target.auth.plugin))}.`);
        }
      }),
    );
  };

  const cloudStatus = (identity: Identity, server: { readonly url: string; readonly auth: "oauth" | "github" }, shared?: SharedInstall): Effect.Effect<Connection> => {
    const target: ConnectionTarget = server.auth === "github" ? { provider: "github" } : { resource: server.url };
    if (shared !== undefined) {
      const teams = Effect.tryPromise(() => cloudRows(identity)).pipe(
        Effect.map((rows): Connection | undefined => {
          const team = rowFor(rows, target, shared);
          if (team === undefined) return undefined;
          const by = team.signed_in_by_name || undefined;
          return { ...fromCloud(team, { ...target, owner: "org", plugin_id: shared.pluginId }), shared: true, ...(by === undefined ? {} : { sharedBy: by }) };
        }),
        Effect.catch((error) => Effect.succeed(cloudTrouble(error.cause))),
      );
      if (shared.alone === true) return teams.pipe(Effect.map((team): Connection => ({ ...(team ?? { status: "needs_sign_in" }), shared: true })));
      // Lease order (Cloud's too): the person's own connection when they have one, else the team's.
      return cloudStatus(identity, server).pipe(
        Effect.flatMap((own) => (own.status !== "needs_sign_in" || own.problem !== undefined ? Effect.succeed(own) : teams.pipe(Effect.map((team) => team ?? own)))),
      );
    }
    const github = (row: CloudConnection | undefined): Effect.Effect<Connection> =>
      row?.status === "connected"
        ? Effect.succeed<Connection>({ status: "connected", heldBy: "cloud" })
        : computer === undefined
          ? githubStatus
          : Effect.succeed({ status: "needs_sign_in", problem: "Connect GitHub to Caveman to use it on this computer." });
    return Effect.tryPromise(() => cloudRows(identity)).pipe(
      Effect.flatMap((rows): Effect.Effect<Connection> => {
        const row = rowFor(rows, target);
        // GitHub's status is Cloud's list, never a lease (a lease is an access-log row).
        if (server.auth === "github") return github(row);
        if (computer !== undefined || row?.status === "needs_reconnect") return Effect.succeed(fromCloud(row, target));
        if (row?.status === "connected") return forgetLocal(server.url).pipe(Effect.as(fromCloud(row, target)));
        if (row?.status === "pending" && cloudPages.has(targetKey(target))) return Effect.succeed(fromCloud(row, target));
        // A sign-in this Mac made before it linked, or one Cloud cannot make, works here.
        return oauthStatus(server.url).pipe(Effect.map((local) => (local.status === "needs_sign_in" ? fromCloud(row, target) : local)));
      }),
      Effect.catch((error) => (server.auth === "github" && computer === undefined ? githubStatus : Effect.succeed(cloudTrouble(error.cause)))),
    );
  };

  /** Connects with Cloud; a server Cloud cannot sign in to is signed in on This Mac instead, saying why. */
  const cloudConnect = (
    identity: Identity,
    server: { readonly url: string; readonly auth: "oauth" | "github" },
    moveToCloud: boolean,
    shared?: SharedInstall,
  ) =>
    Effect.gen(function* () {
      const target: ConnectionTarget = {
        ...(server.auth === "github" ? { provider: "github" as const } : { resource: server.url }),
        ...(shared === undefined ? {} : { owner: "org" as const, plugin_id: shared.pluginId }),
      };
      const now = yield* cloudStatus(identity, server);
      const move = moveToCloud && server.auth === "oauth" && now.heldBy === "this_computer";
      // A shared account is its own connection: the admin's own sign-in does not stand in for it.
      if (shared === undefined && ((now.status === "connected" && !move) || (now.status === "signing_in" && now.authorizationUrl !== undefined))) return now;
      return yield* Effect.tryPromise(() => startConnection(identity, link, target)).pipe(
        Effect.map((started): Connection => {
          cloudPages.set(targetKey(target), started.authorize_url);
          listed = undefined;
          return { status: "signing_in", authorizationUrl: started.authorize_url };
        }),
        Effect.catch(({ cause }): Effect.Effect<Connection> => {
          if (computer !== undefined || server.auth !== "oauth" || !cloudCannot(cause)) return Effect.succeed({ status: "error", problem: errorText(cause) });
          const heldReason = cannotText(cause);
          heldReasons.set(server.url, heldReason);
          if (now.status !== "connected") return signIn(server.url);
          // Already signed in here: keep it, now saying why it stays on this Mac.
          return Effect.tryPromise(async () => {
            const saved = await load(server.url);
            if (saved !== undefined) await save(server.url, { ...saved, heldReason });
          }).pipe(Effect.ignore, Effect.as<Connection>({ ...now, heldReason }));
        }),
      );
    });

  const cloudDisconnect = (identity: Identity, url: string) =>
    Effect.tryPromise({
      try: async () => {
        listed = undefined;
        const row = rowFor(await listConnections(identity, link), { resource: url });
        if (row !== undefined) await deleteConnection(identity, link, row.connection_id);
        forgetLeases((resource) => canonicalResource(resource) === canonicalResource(url));
        cloudPages.delete(url);
      },
      catch: (cause) => new Error(`Caveman did not forget the sign-in: ${errorText(cause)}`),
    });

  const sharedDisconnect = (identity: Identity, server: { readonly url: string; readonly auth: "oauth" | "github" }, shared: SharedInstall) =>
    Effect.tryPromise({
      try: async () => {
        listed = undefined;
        const target: ConnectionTarget = server.auth === "github" ? { provider: "github" } : { resource: server.url };
        const row = rowFor(await listConnections(identity, link), target, shared);
        if (row !== undefined) await deleteConnection(identity, link, row.connection_id, undefined, "org");
        const key = targetKey({ ...target, owner: "org", plugin_id: shared.pluginId });
        cloudPages.delete(key);
        // Leases of the team's account (any repository) end with it.
        for (const held of leases.keys()) if (held.includes(`\0${shared.pluginId}\0`)) leases.delete(held);
      },
      catch: (cause) => new Error(`Caveman did not remove the team's account: ${errorText(cause)}`),
    });

  /** A GitHub login asked for by a server that is not GitHub's: refused before anything is sent. */
  const notGithub = (server: { readonly url: string; readonly auth: "oauth" | "github" }) => server.auth === "github" && !githubHost(server.url);

  /** This computer's own GitHub login, and whether gh or the environment holds it. No login at all says what to do. */
  const localGithub: Effect.Effect<GitHubLogin, string> = Option.isNone(github)
    ? Effect.fail(NO_GITHUB_TEXT)
    : github.value.get("github.com").pipe(
        Effect.map((credential): GitHubLogin => ({ token: credential.token, source: credential.source === "env" ? "env" : "gh" })),
        // gh failing for another reason, or github.com turned off in Settings, says that instead.
        Effect.mapError((error) => (error._tag === "GitHubCliMissingError" || error._tag === "GitHubNotSignedInError" ? NO_GITHUB_TEXT : error.message)),
      );
  /**
   * Cloud's lease of the person's GitHub login when Cloud lists it connected (its list first, so nothing is leased
   * for a login Cloud does not hold; the lease is reused from memory until it nears expiry), else This Mac's own.
   */
  const githubLogin = Effect.suspend((): Effect.Effect<GitHubLogin, string> => {
    const otherwise = (problem: string) => (computer === undefined ? localGithub : Effect.fail(problem));
    const identity = linked();
    if (identity === undefined) return otherwise(NO_CLOUD_GITHUB_TEXT);
    const target: ConnectionTarget = { provider: "github" };
    const leased = Effect.tryPromise(() => cloudRows(identity)).pipe(
      Effect.mapError(({ cause }) => `Caveman did not answer: ${errorText(cause)}`),
      Effect.flatMap((rows) =>
        rowFor(rows, target)?.status !== "connected"
          ? Effect.fail(NO_CLOUD_GITHUB_TEXT)
          : Effect.tryPromise(() => lease(identity, target)).pipe(
              Effect.mapError(({ cause }) => (leaseOutside(cause) ? OUTSIDE_GITHUB_TEXT : `Caveman did not lease its GitHub login: ${errorText(cause)}`)),
              Effect.map((token): GitHubLogin => ({ token: Redacted.make(token), source: "cloud" })),
            ),
      ),
      Effect.catch(otherwise),
    );
    // Under the rule no token is leased: Cloud's list says whether GitHub is connected, and the reads go through
    // Cloud's connector proxy, which attaches the login outside this computer.
    const proxied = Effect.tryPromise(() => cloudRows(identity)).pipe(
      Effect.mapError(({ cause }) => `Caveman did not answer: ${errorText(cause)}`),
      Effect.flatMap((rows) =>
        rowFor(rows, target)?.status === "connected"
          ? Effect.succeed<GitHubLogin>({ source: "cloud", proxy: { key: `cloud-proxy:${identity.runtimeId}`, get: (path) => githubApiGet(identity, link, path) } })
          : Effect.fail(OUTSIDE_GITHUB_TEXT),
      ),
    );
    return outsideHere.pipe(
      Effect.mapError((cause) => `Caveman did not answer: ${errorText(cause)}`),
      Effect.flatMap((outside) => (outside ? proxied : leased)),
    );
  });

  const connectGitHub = Effect.suspend((): Effect.Effect<string | undefined, unknown> => {
    const identity = linked();
    if (identity === undefined) return Effect.succeed(undefined);
    const target: ConnectionTarget = { provider: "github" };
    const start = Effect.tryPromise({
      try: async () => {
        // A lease or list from before belongs to the login being replaced, or to none.
        listed = undefined;
        forgetLeases((head) => head === targetKey(target));
        const started = await startConnection(identity, link, target);
        listed = undefined;
        return started.authorize_url;
      },
      catch: (cause) => cause,
    });
    // Cloud's own refusal, as github.connect shows one.
    return outsideHere.pipe(Effect.flatMap((outside) => (outside ? Effect.fail(new CloudError(403, OUTSIDE_GITHUB_TEXT, OUTSIDE_COMPUTER)) : start)));
  });

  /** Passes where a connector may be removed; inside a computer its sign-in stays outside of, nothing is forgotten and Cloud is not asked. */
  const managedHere = outsideHere.pipe(
    Effect.mapError((cause) => new Error(`Caveman did not answer: ${errorText(cause)}`)),
    Effect.flatMap((outside) => (outside ? Effect.fail(new Error(OUTSIDE_REMOVE_TEXT)) : Effect.void)),
  );

  const connectors = Connectors.of({
    github: githubLogin,
    connectGitHub,
    status: (server, options) => {
      if (notGithub(server)) return Effect.succeed<Connection>({ status: "error", problem: NOT_GITHUB });
      const identity = linked();
      if (identity !== undefined)
        return outsideHere.pipe(
          Effect.flatMap((outside) => (outside ? proxiedStatus(identity, server, options?.shared, options?.repository) : cloudStatus(identity, server, options?.shared))),
          Effect.catch((cause) => Effect.succeed(cloudTrouble(cause))),
        );
      return server.auth === "github" ? githubStatus : oauthStatus(server.url).pipe(Effect.map(({ heldReason: _reason, ...c }) => c));
    },
    connect: (server, options) => {
      if (notGithub(server)) return Effect.succeed<Connection>({ status: "error", problem: NOT_GITHUB });
      const identity = linked();
      if (identity !== undefined)
        return outsideHere.pipe(
          Effect.flatMap((outside) =>
            outside ? Effect.succeed<Connection>({ status: "error", problem: OUTSIDE_CONNECT_TEXT }) : cloudConnect(identity, server, options?.moveToCloud === true, options?.shared),
          ),
          Effect.catch((cause) => Effect.succeed(cloudTrouble(cause))),
        );
      if (options?.shared !== undefined) return Effect.succeed<Connection>({ status: "error", problem: "A shared account is kept by Caveman: sign in first." });
      return server.auth === "github"
        ? connectors.status(server)
        : signingIn.has(server.url)
          ? Effect.succeed<Connection>({ status: "signing_in", authorizationUrl: signingIn.get(server.url)! })
          : signIn(server.url);
    },
    disconnect: (url) => {
      const identity = linked();
      const local = secrets.remove(CONNECTORS_REPOSITORY, secretName(url)).pipe(
        Effect.ignore,
        Effect.tap(() =>
          Effect.sync(() => {
            failures.delete(url);
            heldReasons.delete(url);
            forgotten.delete(url);
          }),
        ),
      );
      return identity === undefined ? local : managedHere.pipe(Effect.andThen(local), Effect.andThen(cloudDisconnect(identity, url)));
    },
    disconnectShared: (server, shared) => {
      const identity = linked();
      return identity === undefined ? Effect.fail(new Error("A shared account is kept by Caveman: sign in first.")) : managedHere.pipe(Effect.andThen(sharedDisconnect(identity, server, shared)));
    },
  });

  /** The hub's sign-in through Cloud: one lease up front, so a refused one answers now and says what to do. */
  const cloudAuth = (identity: Identity, key: string, target: ConnectionTarget, fallback: () => Effect.Effect<TransportAuth, McpHubError>) =>
    Effect.tryPromise(() => lease(identity, target)).pipe(
      Effect.as<TransportAuth>({ authProvider: leasedAuth(identity, target) }),
      Effect.catch(({ cause }) => {
        // The rule came on while this lease was asked for: the next connection goes through Cloud's proxy.
        if (leaseOutside(cause)) return Effect.fail(new McpHubError({ message: `${key}: ${UNREACHABLE_TEXT}`, reason: "sign_in" }));
        const closed = cause instanceof CloudError && (cause.code === "cave_code_service_account_inactive" || cause.code === "cave_code_computer_shared");
        const message = closed
          ? `${key}: Caveman leases no sign-in on this computer now (${errorText(cause)}).`
          : reconnects(cause)
            ? `${key} needs a new sign-in: reconnect it in ${connectWhere(target.plugin_id)}.`
            : `${key}: Caveman did not lease its sign-in: ${errorText(cause)}`;
        if (computer !== undefined) return Effect.fail(new McpHubError({ message, reason: "sign_in" }));
        // This Mac falls back to its own sign-in (one made before linking, mid-move, or one Cloud cannot make);
        // without one, a Cloud sign-in that needs reconnecting says so.
        if ("provider" in target || !reconnects(cause)) return fallback();
        return fallback().pipe(Effect.catch(() => Effect.fail(new McpHubError({ message, reason: "sign_in" }))));
      }),
    );

  /** The hub's 401 handling for a sign-in this Mac holds, queued behind a status check's refresh of it. */
  const oneRefreshAtATime = (url: string, provider: AuthProvider): AuthProvider => ({
    ...provider,
    ...(provider.onUnauthorized === undefined ? {} : { onUnauthorized: (context) => oneAtATime(url, () => provider.onUnauthorized!(context)) }),
  });

  const localTransportAuth = (target: Parameters<McpHubAuth["Service"]["transportAuth"]>[0]): Effect.Effect<TransportAuth, McpHubError> =>
      target.auth.auth === "github"
        ? githubToken.pipe(
            Effect.map((token) => ({ headers: { Authorization: `Bearer ${token}` } })),
            Effect.mapError((problem) => new McpHubError({ message: `${target.key}: ${problem}`, reason: "sign_in" })),
          )
        : Effect.tryPromise({
            try: () => load(target.auth.url),
            catch: (cause) => new McpHubError({ message: `${target.key}: ${errorText(cause)}`, reason: "failed" }),
          }).pipe(
            Effect.flatMap((saved) =>
              saved?.state.tokens === undefined
                ? Effect.fail(new McpHubError({ message: `${target.key} is not connected: sign in from ${connectWhere(target.auth.plugin)}.`, reason: "sign_in" }))
                : Effect.succeed({
                    // Refreshes in place; a refused refresh leaves it needing a new sign-in, never a browser here.
                    authProvider: oneRefreshAtATime(
                      target.auth.url,
                      adaptOAuthProvider(
                        new McpOAuthProvider({
                          serverUrl: target.auth.url,
                          redirectUrl: saved.redirectUrl,
                          clientMetadata: CLIENT_METADATA,
                          store: storeFor(target.auth.url, saved.redirectUrl),
                          onRedirect: () => undefined,
                        }),
                      ),
                    ),
                  }),
            ),
          );

  const hubAuth = McpHubAuth.of({
    transportAuth: (target) => {
      if (notGithub(target.auth)) return Effect.fail(new McpHubError({ message: `${target.key}: ${NOT_GITHUB}`, reason: "sign_in" }));
      const identity = linked();
      if (identity === undefined) return localTransportAuth(target);
      const cloudTarget: ConnectionTarget = {
        ...(target.auth.auth === "github" ? { provider: "github" as const } : { resource: target.auth.url }),
        ...(target.auth.plugin === undefined ? {} : { plugin_id: target.auth.plugin, ...(target.auth.repository === undefined ? {} : { repository: target.auth.repository }) }),
      };
      return outsideHere.pipe(
        Effect.mapError((cause) => new McpHubError({ message: `${target.key}: Caveman did not answer: ${errorText(cause)}`, reason: "failed" })),
        Effect.flatMap((outside) => (outside ? proxiedAuth(identity, target) : cloudAuth(identity, target.key, cloudTarget, () => localTransportAuth(target)))),
      );
    },
  });

  return Context.make(Connectors, connectors).pipe(Context.add(McpHubAuth, hubAuth));
});

export const layer = Layer.effectContext(make);
