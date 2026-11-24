// Sign-ins that follow the person. A claude.ai or compact
// sign-in made on a Cloud computer is sealed in Caveman Cloud for that person and used on all their Cloud computers.
// This Mac's own login is never read or uploaded: nothing here runs off a Cloud computer.
//
// - Capture: the sign-in is made where the agent can neither read nor write it (signInHere.ts, security ruling S-R3):
//   the CLI's login runs in the runtime container with a fresh 0700 config folder under the runtime's state, and
//   `captureFrom` takes what it wrote there. Nothing in the tools container (its home, the Codex home it mounts) is
//   ever read as a sign-in, so nothing a tools process writes can be taken as the person's.
// - Use: claude gets CLAUDE_CODE_OAUTH_TOKEN=<stand-in>, codex a stand-in auth.json (written through the tools channel
//   as the agent's uid). The runtime holds the real access token in memory only (never the refresh token: Cloud is the
//   only refresher) and the egress scrub swaps it in only on the provider endpoints the CLIs use
//   (secrets/EgressScrub.ts followedEndpoint).
// - Refresh: claude refreshes a claude.ai login at https://platform.claude.com/v1/oauth/token, hardcoded in the CLI,
//   so it never passes the scrub; the stand-ins are long-lived so neither CLI needs to. The runtime refreshes through
//   Cloud's serialized refresh (one provider call however many computers ask) only 5 minutes before expiry, or after a
//   provider 401 on an allowed endpoint at most once in REFRESH_MIN_MS; codex's own refresh
//   (CODEX_REFRESH_TOKEN_URL_OVERRIDE) is answered here with stand-ins and never makes one. A tools process cannot
//   drive refreshes.
// - Sign out everywhere: Cloud drops the login; each computer learns it within a minute of its next use (a cheap
//   `known_version` check, no access-log row), drops the token and removes its stand-ins.
// - Who pays (docs/ §7.4): Cloud says, per engine, which of the person's Cloud logins
//   pays: this sign-in (`followed_login`) or their API key in the vault (`vault_key`), as the person last chose it.
//   A launch runs only on that lane; when it can't (signed out, needs a new sign-in, Cloud unreachable) the launch
//   fails and says so. It never falls to the key or another account. Asked at every launch, so a computer that
//   restarted or changed person learns it again; a person change drops everything held for the last one.
// - Where the person's credentials stay outside the computer (credentialRule.ts, 2026-11-09: on boat the agent is root,
//   so "the runtime holds it and the agent can't read it" does not hold there) none of this runs: no token is asked
//   for, held or uploaded here, and engines launch on a connection's stand-in instead (modelConnections.ts).
import { randomBytes } from "node:crypto";
import * as path from "node:path";

import { EgressRoute } from "@caveman-app/engine-core/server/EgressRoute";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { CONNECT_WHERE, OUTSIDE_REMOVE } from "./credentialRule.ts";
import type { OutsideConnections } from "./modelConnections.ts";
import { CloudError } from "./identity.ts";
import { runBytes } from "./tools.ts";

/** The engines whose sign-in follows the person, by the app's engine id. */
export type FollowedEngine = "claude-agent" | "codex";
export const FOLLOWED_ENGINES: ReadonlyArray<FollowedEngine> = ["claude-agent", "codex"];
/** Cloud's name for each (the `{engine}` of /api/v1/code/runtime/engine-logins/{engine}). */
export const CLOUD_ENGINE: Record<FollowedEngine, "claude" | "codex"> = { "claude-agent": "claude", codex: "codex" };

/** What a followed sign-in keeps beside its tokens. Nothing in it is a secret. */
export interface LoginProfile {
  readonly scopes?: ReadonlyArray<string>;
  readonly subscription_type?: string;
  readonly rate_limit_tier?: string;
  readonly auth_mode?: string;
  readonly account_id?: string;
 /** The compact id token's claims (email, plan, account): codex reads them from its id token. */
  readonly id_claims?: Record<string, unknown>;
}

/** Cloud's answer to a read or a refresh. `unchanged`: the version asked about is current (no token, no audit row). */
export interface LoginAccess {
  readonly engine: string;
  readonly version: number;
  readonly status: string;
  readonly expires_at?: string | null;
  readonly access_token?: string;
  readonly profile?: LoginProfile;
  readonly unchanged?: boolean;
  /** Who the runtime acts for, an opaque tag (Cloud from 2026-10-23); a change means another person's login. */
  readonly person?: string;
}

/** Which of the person's Cloud logins pays for an engine on their Cloud computers. */
export type EngineLane = "followed_login" | "vault_key";

/** Cloud's word on who pays, names only (GET engine-logins). */
export interface CloudLanes {
  /** Each engine's lane; an engine left out has neither. Undefined from a Cloud from before lanes. */
  readonly lanes?: Partial<Record<FollowedEngine, EngineLane>>;
  /** The engines a sign-in follows the person for, in any state. */
  readonly followed: ReadonlyArray<FollowedEngine>;
  readonly person?: string;
}

/**
 * The lane a launch of an engine runs on here: one Cloud names, `none` (the person has neither, so the CLI's own
 * login on this computer), or `legacy` (no word from Cloud on lanes, an older Cloud or a runtime not joined to one,
 * and no followed sign-in: a vault key when there is one, else the CLI's own login).
 */
export type LaunchLane = EngineLane | "none" | "legacy";

/** Why a launch on a followed sign-in can't run now. Never a reason to use another login. */
export type FollowedMiss = "needs_sign_in" | "unreachable";

/** A launch on a followed sign-in: its env, or why it can't run (the message says what to do). */
export type FollowedLaunch = { readonly env: Record<string, string | undefined> } | { readonly unavailable: FollowedMiss; readonly message: string };

export interface LoginCredential {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at?: string;
  readonly id_token?: string;
}

/** The runtime routes for followed sign-ins. Refusals throw CloudError; a missing login is undefined. */
export interface FollowedCloud {
  readonly list: () => Promise<ReadonlyArray<{ readonly engine: string; readonly status: string }>>;
  /** Who pays for each engine (the list route's `lanes` and `person`); a Cloud without the route answers none. */
  readonly lanes: () => Promise<CloudLanes>;
  readonly get: (engine: "claude" | "codex", knownVersion?: number) => Promise<LoginAccess | undefined>;
  readonly refresh: (engine: "claude" | "codex", version: number) => Promise<LoginAccess>;
  readonly put: (engine: "claude" | "codex", body: { consent: true; credential: LoginCredential; profile: LoginProfile; label: string }) => Promise<{ readonly version: number }>;
  readonly remove: (engine: "claude" | "codex") => Promise<void>;
}

/** `send(method, path under engine-logins, body)` as the five routes; a 404 is "none" (an older Cloud too). */
export const followedCloudOver = (send: (method: string, route: string, body?: unknown) => Promise<unknown>): FollowedCloud => {
  const none = (error: unknown) => error instanceof CloudError && error.status === 404;
  const access = (answer: unknown): LoginAccess => {
    // A 304 or empty answer says nothing: never read as "signed out".
    if (answer === undefined || answer === null || typeof (answer as LoginAccess).version !== "number") throw new Error("Caveman sent no sign-in");
    return answer as LoginAccess;
  };
  return {
    list: () =>
      send("GET", "").then(
        (answer) => (answer as { logins?: ReadonlyArray<{ engine: string; status: string }> } | undefined)?.logins ?? [],
        (error) => (none(error) ? [] : Promise.reject(error)),
      ),
    lanes: () =>
      send("GET", "").then(
        (answer) => {
          const body = answer as { logins?: ReadonlyArray<{ engine: string }>; lanes?: ReadonlyArray<{ engine: string; lane: string }>; person?: unknown } | undefined;
          const app = (engine: string) => FOLLOWED_ENGINES.find((e) => CLOUD_ENGINE[e] === engine);
          const lanes = body?.lanes?.flatMap((l) => {
            const engine = app(l.engine);
            return engine !== undefined && (l.lane === "followed_login" || l.lane === "vault_key") ? [[engine, l.lane] as const] : [];
          });
          return {
            ...(lanes === undefined ? {} : { lanes: Object.fromEntries(lanes) }),
            followed: (body?.logins ?? []).flatMap((l) => app(l.engine) ?? []),
            ...(typeof body?.person === "string" ? { person: body.person } : {}),
          };
        },
        (error) => (none(error) ? { followed: [] } : Promise.reject(error)),
      ),
    get: (engine, knownVersion) =>
      send("GET", `/${engine}${knownVersion === undefined ? "" : `?known_version=${knownVersion}`}`).then(access, (error) => (none(error) ? undefined : Promise.reject(error))),
    refresh: (engine, version) => send("POST", `/${engine}/refresh`, { version }).then(access),
    put: (engine, body) => send("PUT", `/${engine}`, body).then((answer) => answer as { version: number }),
    remove: (engine) => send("DELETE", `/${engine}`).then(
      () => undefined,
      (error) => (none(error) ? undefined : Promise.reject(error)),
    ),
  };
};

/** Reads and writes a sign-in file where the engine reads it. */
export interface LoginFiles {
  /** The file's text; undefined when there is none (or it is a symlink). */
  readonly read: (file: string) => Promise<string | undefined>;
  /** Replaces the file in one step (temporary file, then rename), readable by its owner only. */
  readonly write: (file: string, text: string) => Promise<void>;
  /** Removes the file only while it holds a stand-in: a real login is never deleted. */
  readonly removeStandIn: (file: string) => Promise<void>;
}

/**
 * The files through the tools channel (`socket`, a Cloud computer), as the agent's uid: the homes are the agent's
 * to write, so the runtime never follows a path there with its own privileges. Without a socket, here (tests).
 */
export const toolsLoginFiles = (socket: string | undefined): LoginFiles => ({
  read: async (file) => {
    const read = await runBytes(socket, "/", ["sh", "-c", 'if [ -f "$1" ] && [ ! -L "$1" ]; then exec head -c 262144 -- "$1"; else exit 3; fi', "sh", file]);
    return read.code === 0 ? read.stdout.toString("utf8") : undefined;
  },
  write: async (file, text) => {
    const script = 'set -e; umask 077; d=$(dirname -- "$1"); mkdir -p -- "$d"; t="$d/.caveman-login.$$"; cat > "$t"; chmod 600 "$t"; mv -f -- "$t" "$1"';
    const wrote = await runBytes(socket, "/", ["sh", "-c", script, "sh", file], Buffer.from(text, "utf8"));
    if (wrote.code !== 0) throw new Error(`could not write the sign-in's stand-ins (${wrote.stderr.trim().slice(0, 200)})`);
  },
  removeStandIn: async (file) => {
    await runBytes(socket, "/", ["sh", "-c", `if [ -f "$1" ] && [ ! -L "$1" ] && grep -q ${STAND_IN_MARK} -- "$1"; then rm -f -- "$1"; fi`, "sh", file]);
  },
});

/** In every stand-in this runtime makes, in any run: how a stand-in is told from a real token. */
export const STAND_IN_MARK = "caveman-stand-in";

/** Whether `token` is a stand-in (this run's or an earlier one's), never a real token. */
export const isStandIn = (token: unknown): boolean => typeof token === "string" && token.includes(STAND_IN_MARK);

const TEN_YEARS_S = 10 * 365 * 24 * 3600;
const b64url = (value: unknown) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
/** A JWT's claims, unverified (codex reads its tokens this way); undefined when it is not one. */
export const jwtClaims = (token: string | undefined): Record<string, unknown> | undefined => {
  const part = token?.split(".")[1];
  if (part === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return claims !== null && typeof claims === "object" && !Array.isArray(claims) ? (claims as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
};
/** A JWT-shaped stand-in: unsigned (its signature is the mark), `claims` plus a far expiry. Worth nothing anywhere. */
export const standInJwt = (claims: Record<string, unknown>, nonce: string, nowMs = Date.now()) =>
  `${b64url({ alg: "none", typ: "JWT" })}.${b64url({ ...claims, iat: Math.floor(nowMs / 1000), exp: Math.floor(nowMs / 1000) + TEN_YEARS_S, [STAND_IN_MARK.replaceAll("-", "_")]: nonce })}.${STAND_IN_MARK}-${nonce}`;

/** Claude's credential file, as the CLI writes it (`claudeAiOauth`). */
export const parseClaudeCredentials = (text: string): { credential: LoginCredential; profile: LoginProfile; label: string } | undefined => {
  let parsed: { claudeAiOauth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown; scopes?: unknown; subscriptionType?: unknown; rateLimitTier?: unknown } };
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const oauth = parsed?.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || typeof oauth.refreshToken !== "string" || oauth.accessToken === "" || oauth.refreshToken === "") return undefined;
  const expiresAt = typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt) ? new Date(oauth.expiresAt).toISOString() : undefined;
  const subscription = typeof oauth.subscriptionType === "string" ? oauth.subscriptionType : undefined;
  return {
    credential: { access_token: oauth.accessToken, refresh_token: oauth.refreshToken, ...(expiresAt ? { expires_at: expiresAt } : {}) },
    profile: {
      ...(Array.isArray(oauth.scopes) ? { scopes: oauth.scopes.filter((s): s is string => typeof s === "string") } : {}),
      ...(subscription ? { subscription_type: subscription } : {}),
      ...(typeof oauth.rateLimitTier === "string" ? { rate_limit_tier: oauth.rateLimitTier } : {}),
    },
    label: subscription ? `Claude ${subscription.charAt(0).toUpperCase()}${subscription.slice(1)}` : "Claude sign-in",
  };
};

/** Codex's auth.json on a compact login (`tokens`). */
export const parseCodexAuth = (text: string): { credential: LoginCredential; profile: LoginProfile; label: string } | undefined => {
  let parsed: { auth_mode?: unknown; tokens?: { id_token?: unknown; access_token?: unknown; refresh_token?: unknown; account_id?: unknown } | null };
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const tokens = parsed?.tokens;
  if (typeof tokens?.access_token !== "string" || typeof tokens.refresh_token !== "string" || tokens.access_token === "" || tokens.refresh_token === "") return undefined;
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token : undefined;
  const claims = jwtClaims(idToken);
  const exp = jwtClaims(tokens.access_token)?.exp;
  const auth = claims?.["https://api.openai.com/auth"] as Record<string, unknown> | undefined;
  const accountId = typeof tokens.account_id === "string" ? tokens.account_id : typeof auth?.chatgpt_account_id === "string" ? auth.chatgpt_account_id : undefined;
  return {
    credential: {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      ...(idToken ? { id_token: idToken } : {}),
      ...(typeof exp === "number" ? { expires_at: new Date(exp * 1000).toISOString() } : {}),
    },
    profile: {
      auth_mode: typeof parsed.auth_mode === "string" ? parsed.auth_mode : "chatgpt",
      ...(accountId ? { account_id: accountId } : {}),
      ...(claims ? { id_claims: claims } : {}),
    },
    label: typeof claims?.email === "string" ? claims.email : "ChatGPT sign-in",
  };
};

/** Where each engine's sign-in file is: Claude's in the tools home, Codex's in the active CODEX_HOME. */
export interface LoginPaths {
  readonly claude: () => Promise<string>;
  readonly codex: () => Promise<string>;
}

interface Held {
  version: number;
  access: string;
  expiresAt: number | undefined;
  profile: LoginProfile;
  checkedAt: number;
}

/** A request the scrub sent with a followed sign-in's token, for a resend after a 401. */
export interface Swapped {
  readonly engine: FollowedEngine;
  readonly token: string;
  readonly version: number;
}

/** Every real access token any instance held: the scrub's token scrubber joins them (rebuilt when `generation` moves). */
export const followedTokens = { values: new Set<string>(), generation: 0 };

/** Look at Cloud's copy at most this often while a login is in use (sign out everywhere arrives within it). */
export const REVALIDATE_MS = 60_000;
/** Refresh this long before the access token expires. */
export const REFRESH_AHEAD_MS = 5 * 60_000;
/** After a provider 401, at most one refresh this often per engine (one near expiry is never held back). */
export const REFRESH_MIN_MS = 5 * 60_000;
/** The stand-ins' lifetime as the CLIs see it: long enough that neither ever refreshes on its own clock. */
const STAND_IN_EXPIRES_S = 365 * 24 * 3600;

/** codex's refresh URL (CODEX_REFRESH_TOKEN_URL_OVERRIDE): an egress route the scrub answers itself, never forwarded. */
export const CODEX_LOGIN_REFRESH = "caveman-login:codex-refresh";

const gone = (error: unknown) => error instanceof CloudError && (error.status === 401 || error.status === 403 || error.status === 404 || error.status === 409);
const expired = (error: unknown) => error instanceof CloudError && error.status === 409;

/** Whose sign-in each engine's is, as a person names it. */
const PLAN: Record<FollowedEngine, string> = { "claude-agent": "Claude", codex: "ChatGPT" };
/** What a launch says when Caveman did not say what it runs on, or did not hand that over: nothing started. */
export const NOT_STARTED = "Can't reach Caveman, so this didn't start. Try again in a moment.";
/** What a launch that can't run on its followed sign-in says. The API key is never used instead (engineKeys.ts). */
export const followedMissMessage = (engine: FollowedEngine, why: FollowedMiss) => (why === "needs_sign_in" ? `Your ${PLAN[engine]} sign-in expired. Reconnect it in ${CONNECT_WHERE}.` : NOT_STARTED);

/** Cloud could not say which login pays for an engine, and nothing recent is known here: nothing launches. */
export class LaneUnknown extends Error {
  constructor(_engine: FollowedEngine) {
    super(NOT_STARTED);
  }
}

export type CaptureResult = "captured" | "none" | "failed";

/** Why a newer token is asked for: the held one nears expiry, or the provider refused it on an allowed endpoint. */
export type RenewReason = "expiry" | "refused";

/**
 * One runtime's followed sign-ins: what it holds in memory, its stand-ins, and the Cloud and files it reaches.
 * The runtime has one (`followedLogins`); tests make one per pretend computer.
 */
export class FollowedLogins {
  private cloud: FollowedCloud | undefined;
  private files: LoginFiles | undefined;
  private paths: LoginPaths | undefined;
  private readonly held = new Map<FollowedEngine, Held>();
  /** Engines Cloud listed as followed (names only), before a token was read. */
  private readonly known = new Set<FollowedEngine>();
  private readonly absentAt = new Map<FollowedEngine, number>();
  /** Why each engine has no sign-in held (the last check's answer), for the launch's refusal. */
  private readonly missed = new Map<FollowedEngine, FollowedMiss>();
  /** Who this runtime acts for, as Cloud last tagged them; a change drops everything held. */
  private person: string | undefined;
  private lanesKnown: { readonly at: number; readonly answer: CloudLanes } | undefined;
  private lanesRound: Promise<CloudLanes> | undefined;
  private readonly checks = new Map<FollowedEngine, Promise<Held | undefined>>();
  private readonly renewals = new Map<FollowedEngine, Promise<Held | undefined>>();
  /** When this runtime last asked Cloud to refresh each engine's sign-in. */
  private readonly refreshedAt = new Map<FollowedEngine, number>();
  private readonly codexFiles = new Set<string>();
  private readonly listeners = new Set<(engine: FollowedEngine) => void>();
  private readonly nonce = { claude: randomBytes(24).toString("hex"), codexAccess: randomBytes(24).toString("hex"), codexId: randomBytes(24).toString("hex") };
  /** claude's stand-ins: one per runtime run, shaped like Claude's OAuth tokens. */
  readonly claudeStandIn = { access: `sk-ant-oat01-${STAND_IN_MARK}-${this.nonce.claude}`, refresh: `sk-ant-ort01-${STAND_IN_MARK}-${randomBytes(24).toString("hex")}` };
  private readonly codexRefreshStandIn = `rt_${STAND_IN_MARK}-${randomBytes(24).toString("hex")}`;

  private readonly now: () => number;
  /** Whether credentials stay outside this computer (credentialRule.ts); unset: never (tests, a Cloud from before the rule). */
  private outside: (() => Promise<boolean>) | undefined;
  /** This computer's connections while they do (modelConnections.ts). */
  private outsideConnections: (() => Promise<OutsideConnections | undefined>) | undefined;
  /** Whether Cloud's data plane routes an agent's Auto for this computer (credentialRule.ts routesAuto). */
  private autoRouted: ((engine: "claude-agent" | "codex") => Promise<boolean>) | undefined;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /** The rule now: true, nothing of the person's is asked for or held here; undefined, Cloud could not say, so nothing is asked either. */
  private ruled(): Promise<boolean | undefined> {
    return this.outside === undefined ? Promise.resolve(false) : this.outside().catch(() => undefined);
  }

  /**
   * What this computer's engines launch on while its person's credentials stay outside it: their connections
   * (modelConnections.ts). Undefined everywhere else, where a launch goes on as before; rejects while Cloud cannot say
   * which it is, and nothing launches on a guess.
   */
  connections(): Promise<OutsideConnections | undefined> {
    return this.outsideConnections === undefined ? Promise.resolve(undefined) : this.outsideConnections();
  }

  /**
   * Whether a chat on Auto with `engine` runs here with its model left to Cloud: the engine sends Auto's model and
   * Cloud's data plane picks. False off a Cloud computer, at an older Cloud, and while Cloud cannot say.
   */
  routesAuto(engine: "claude-agent" | "codex"): Promise<boolean> {
    return this.autoRouted === undefined ? Promise.resolve(false) : this.autoRouted(engine).catch(() => false);
  }

  /** Where this computer's engines read their sign-in files, once joined: a launch on a connection's stand-in writes there too. */
  get joined(): { readonly files: LoginFiles; readonly paths: LoginPaths } | undefined {
    return this.files === undefined || this.paths === undefined ? undefined : { files: this.files, paths: this.paths };
  }

  /** The rule came on while this computer ran: every token held goes, and the stand-ins that stood for them. */
  async dropAll() {
    this.lanesKnown = undefined;
    await Promise.all(FOLLOWED_ENGINES.map((engine) => this.clear(engine)));
  }

  /**
   * One round per engine in `rounds`: a caller while one runs gets its answer. Registered before anything of the
   * round can settle, and dropped only when it is still the one registered.
   */
  private flight<T>(rounds: Map<FollowedEngine, Promise<T>>, engine: FollowedEngine, round: Promise<T>): Promise<T> {
    rounds.set(engine, round);
    const settled = round.finally(() => {
      if (rounds.get(engine) === round) rounds.delete(engine);
    });
    void settled.catch(() => undefined);
    return round;
  }

  /** Joins this runtime to Cloud on a Cloud computer. Off one it stays unjoined and does nothing. */
  connect(input: {
    readonly cloud: FollowedCloud;
    readonly files: LoginFiles;
    readonly paths: LoginPaths;
    readonly outside?: () => Promise<boolean>;
    readonly connections?: () => Promise<OutsideConnections | undefined>;
    readonly routesAuto?: (engine: "claude-agent" | "codex") => Promise<boolean>;
  }) {
    this.cloud = input.cloud;
    this.files = input.files;
    this.paths = input.paths;
    this.outside = input.outside;
    this.outsideConnections = input.connections;
    this.autoRouted = input.routesAuto;
    // Nothing held or known from another join stands for this one.
    this.held.clear();
    this.known.clear();
    this.absentAt.clear();
    this.missed.clear();
    this.lanesKnown = undefined;
    this.person = undefined;
    // Which engines follow the person, names only (no token, no access-log row), for the heartbeat. Where their
    // credentials stay outside this computer nothing follows them here and Cloud is not asked (nor while it cannot
    // say): what they connected says which engines run (hasFollowedLogin), news once Cloud has said the rule applies.
    void this.ruled()
      .then(async (ruled) => {
        if (ruled === true) for (const engine of FOLLOWED_ENGINES) this.emit(engine);
        if (ruled !== false) return;
        for (const login of await input.cloud.list()) {
          const engine = FOLLOWED_ENGINES.find((e) => CLOUD_ENGINE[e] === login.engine);
          if (engine !== undefined && login.status === "ready") this.known.add(engine);
        }
      })
      .catch(() => undefined);
  }

  get connected() {
    return this.cloud !== undefined;
  }

  /** Whether this computer runs `engine` on a followed sign-in (A3's heartbeat `engines_signed_in`). */
  hasLogin(engine: FollowedEngine) {
    return this.held.has(engine) || this.known.has(engine);
  }

  /** Hears a sign-in arrive or go (the engine's sign-in state changed). */
  onChange(listener: (engine: FollowedEngine) => void) {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /** The file `engine`'s sign-in lands in on this computer. */
  private signInFile(engine: FollowedEngine) {
    return engine === "claude-agent" ? this.paths!.claude() : this.paths!.codex();
  }

  /** codex's access-token stand-in, carrying the account's non-secret auth claims. */
  private codexAccessStandIn(profile: LoginProfile) {
    const auth = profile.id_claims?.["https://api.openai.com/auth"];
    return standInJwt(auth === undefined ? {} : { "https://api.openai.com/auth": auth }, this.nonce.codexAccess);
  }
  private codexIdStandIn(profile: LoginProfile) {
    const { exp: _exp, iat: _iat, ...claims } = profile.id_claims ?? {};
    return standInJwt(claims, this.nonce.codexId);
  }

  /** Whether `token` is this runtime's stand-in for `engine`'s access token. */
  owns(engine: FollowedEngine, token: string | undefined): boolean {
    if (token === undefined || !isStandIn(token)) return false;
    return engine === "claude-agent" ? token === this.claudeStandIn.access : jwtClaims(token)?.[STAND_IN_MARK.replaceAll("-", "_")] === this.nonce.codexAccess;
  }

  /** Whether `token` is this runtime's stand-in for `engine`'s refresh token. */
  ownsRefresh(engine: FollowedEngine, token: unknown): boolean {
    return typeof token === "string" && token === (engine === "claude-agent" ? this.claudeStandIn.refresh : this.codexRefreshStandIn);
  }

  private nearExpiry(held: Held) {
    return held.expiresAt !== undefined && held.expiresAt - this.now() < REFRESH_AHEAD_MS;
  }

  private emit(engine: FollowedEngine) {
    for (const listener of this.listeners) {
      try {
        listener(engine);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  private hold(engine: FollowedEngine, access: LoginAccess): Held | undefined {
    if (access.access_token === undefined || access.access_token === "" || isStandIn(access.access_token)) return this.held.get(engine);
    const before = this.held.get(engine);
    const expires = access.expires_at ? Date.parse(access.expires_at) : Number.NaN;
    const held: Held = { version: access.version, access: access.access_token, expiresAt: Number.isFinite(expires) ? expires : undefined, profile: access.profile ?? before?.profile ?? {}, checkedAt: this.now() };
    this.held.set(engine, held);
    this.known.add(engine);
    this.absentAt.delete(engine);
    this.missed.delete(engine);
    if (!followedTokens.values.has(held.access)) {
      followedTokens.values.add(held.access);
      followedTokens.generation++;
    }
    if (before === undefined) this.emit(engine);
    return held;
  }

  /** Drops the sign-in here: memory, then the stand-in files (only while they hold stand-ins). */
  private async clear(engine: FollowedEngine, why: FollowedMiss = "needs_sign_in") {
    const had = this.held.delete(engine) || this.known.delete(engine);
    this.known.delete(engine);
    this.absentAt.set(engine, this.now());
    this.missed.set(engine, why);
    const files = this.files;
    const paths = this.paths;
    if (files !== undefined && paths !== undefined) {
      const targets = engine === "claude-agent" ? [await paths.claude().catch(() => undefined)] : [await paths.codex().catch(() => undefined), ...this.codexFiles];
      await Promise.all(targets.filter((t): t is string => t !== undefined).map((file) => files.removeStandIn(file).catch(() => undefined)));
    }
    if (had) this.emit(engine);
  }

  /**
   * Whether `tag` (Cloud's tag for who this runtime acts for) is the person it acted for. Another person drops every
   * sign-in held and the lanes known, before anything of theirs is used. An answer with no tag (an older Cloud) says
   * nothing either way.
   */
  private async samePerson(tag: string | undefined): Promise<boolean> {
    if (tag === undefined) return true;
    const before = this.person;
    this.person = tag;
    if (before === undefined || before === tag) return true;
    this.lanesKnown = undefined;
    await Promise.all(FOLLOWED_ENGINES.map((engine) => this.clear(engine)));
    for (const engine of FOLLOWED_ENGINES) this.absentAt.delete(engine);
    return false;
  }

  /**
   * Who pays for each engine, as Cloud says now: one ask per launch (launches at once share it), so a lane or person
   * change applies to the very next launch. Unreachable, the answer of the last REVALIDATE_MS serves; older, none does
   * (LaneUnknown), so a restart never guesses.
   */
  private lanesNow(engine: FollowedEngine): Promise<CloudLanes> {
    const cloud = this.cloud!;
    if (this.lanesRound !== undefined) return this.lanesRound;
    const round = (async () => {
      try {
        const answer = await cloud.lanes();
        await this.samePerson(answer.person);
        this.lanesKnown = { at: this.now(), answer };
        return answer;
      } catch (error) {
        // Refused (this computer acts for no one now): nothing held is anyone's to use.
        if (gone(error)) {
          this.lanesKnown = undefined;
          await Promise.all(FOLLOWED_ENGINES.map((e) => this.clear(e)));
        }
        const known = this.lanesKnown;
        if (known !== undefined && this.now() - known.at < REVALIDATE_MS) return known.answer;
        throw new LaneUnknown(engine);
      }
    })();
    this.lanesRound = round;
    void round.finally(() => {
      if (this.lanesRound === round) this.lanesRound = undefined;
    }).catch(() => undefined);
    return round;
  }

  /** The lane a launch of `engine` runs on here (LaunchLane); rejects with LaneUnknown when Cloud can't say. */
  async lane(engine: FollowedEngine): Promise<LaunchLane> {
    if (this.cloud === undefined) return "legacy";
    const answer = await this.lanesNow(engine);
    const bound = answer.lanes?.[engine];
    if (bound !== undefined) return bound;
    if (answer.lanes !== undefined) return "none";
    // An older Cloud: a sign-in that follows the person, in any state, is what pays (it always won the launch), so
    // its expiry never hands the launch to the key.
    return answer.followed.includes(engine) ? "followed_login" : "legacy";
  }

  /**
   * The login as Cloud has it now: from memory while it was checked within REVALIDATE_MS (unless `force`), else one
   * `known_version` look. Gone (signed out everywhere, needs a new sign-in, or Cloud refuses this computer) clears it;
   * Cloud unreachable keeps what is held.
   */
  ensureHeld(engine: FollowedEngine, force = false): Promise<Held | undefined> {
    const cloud = this.cloud;
    if (cloud === undefined) return Promise.resolve(undefined);
    const held = this.held.get(engine);
    if (!force && held !== undefined && this.now() - held.checkedAt < REVALIDATE_MS) return Promise.resolve(held);
    if (!force && held === undefined && this.now() - (this.absentAt.get(engine) ?? -Infinity) < REVALIDATE_MS) return Promise.resolve(undefined);
    const running = this.checks.get(engine);
    if (running !== undefined) return running;
    const check = (async () => {
      // Credentials stay outside this computer: no token is asked for, and none stays held. Unknown: none is asked for either.
      const ruled = await this.ruled();
      if (ruled === true) {
        if (this.held.has(engine)) await this.clear(engine);
        return undefined;
      }
      if (ruled === undefined) {
        if (!this.held.has(engine)) this.missed.set(engine, "unreachable");
        return this.held.get(engine);
      }
      try {
        let got = await cloud.get(CLOUD_ENGINE[engine], held?.version);
        // Another person's answer: what was held went with the last one; theirs is read whole.
        if (got !== undefined && !(await this.samePerson(got.person)) && got.unchanged === true) got = await cloud.get(CLOUD_ENGINE[engine]);
        if (got === undefined) {
          await this.clear(engine);
          return undefined;
        }
        const current = this.held.get(engine);
        if (got.unchanged === true && current !== undefined && got.version === current.version) {
          current.checkedAt = this.now();
          return current;
        }
        return this.hold(engine, got);
      } catch (error) {
        if (gone(error)) {
          await this.clear(engine, expired(error) || (error instanceof CloudError && error.status === 404) ? "needs_sign_in" : "unreachable");
          return undefined;
        }
        if (!this.held.has(engine)) this.missed.set(engine, "unreachable");
        return this.held.get(engine);
      }
    })();
    return this.flight(this.checks, engine, check);
  }

  /**
   * A newer token than `usedVersion`, once: another computer's refresh first (a `known_version` look), else Cloud's
   * serialized refresh, but only when the token nears expiry, or (`refused`) at most once in REFRESH_MIN_MS. One at a
   * time per engine; every caller of a round shares its answer. On `invalid_grant` it looks once more (a new sign-in
   * may have landed) and otherwise drops the sign-in, so the card shows.
   */
  renew(engine: FollowedEngine, usedVersion: number, reason: RenewReason = "expiry"): Promise<Held | undefined> {
    const current = this.held.get(engine);
    if (current !== undefined && current.version > usedVersion && !this.nearExpiry(current)) return Promise.resolve(current);
    const running = this.renewals.get(engine);
    if (running !== undefined) return running;
    const cloud = this.cloud;
    if (cloud === undefined) return Promise.resolve(undefined);
    const round = (async () => {
      const fresh = await this.ensureHeld(engine, true);
      if (fresh === undefined) return undefined;
      if (fresh.version > usedVersion && !this.nearExpiry(fresh)) return fresh;
      const last = this.refreshedAt.get(engine);
      const allowed = this.nearExpiry(fresh) || (reason === "refused" && (last === undefined || this.now() - last >= REFRESH_MIN_MS));
      if (!allowed) return fresh;
      this.refreshedAt.set(engine, this.now());
      try {
        return this.hold(engine, await cloud.refresh(CLOUD_ENGINE[engine], fresh.version));
      } catch (error) {
        if (expired(error)) {
          const again = await cloud.get(CLOUD_ENGINE[engine]).catch(() => undefined);
          if (again?.access_token !== undefined && again.version > fresh.version) return this.hold(engine, again);
          await this.clear(engine);
          return undefined;
        }
        if (gone(error)) {
          await this.clear(engine, "unreachable");
          return undefined;
        }
        return this.held.get(engine);
      }
    })().catch(() => this.held.get(engine));
    return this.flight(this.renewals, engine, round);
  }

  /** The real token behind `presented` (this runtime's stand-in for `engine`), fresh; undefined for anything else. */
  async swap(engine: FollowedEngine, presented: string | undefined): Promise<Swapped | undefined> {
    if (!this.owns(engine, presented)) return undefined;
    let held = await this.ensureHeld(engine);
    if (held !== undefined && this.nearExpiry(held)) held = (await this.renew(engine, held.version, "expiry")) ?? undefined;
    return held === undefined ? undefined : { engine, token: held.access, version: held.version };
  }

  /**
   * The CLI's own refresh (codex's refresh route; claude's at its base URL), answered here with stand-ins. Never
   * forwarded, and never a refresh in Cloud of its own: only a token near expiry is renewed first. A refresh token
   * that is not this runtime's stand-in is refused.
   */
  async answerRefresh(engine: FollowedEngine, body: unknown): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const given = body !== null && typeof body === "object" ? (body as { refresh_token?: unknown }).refresh_token : undefined;
    const refused = { status: 400, body: { error: "invalid_grant", error_description: "Sign in again on this Cloud computer." } };
    if (!this.ownsRefresh(engine, given)) return refused;
    const held = await this.ensureHeld(engine);
    const renewed = held === undefined ? undefined : this.nearExpiry(held) ? await this.renew(engine, held.version, "expiry") : held;
    if (renewed === undefined) return refused;
    return engine === "claude-agent"
      ? {
          status: 200,
          body: {
            token_type: "Bearer",
            access_token: this.claudeStandIn.access,
            refresh_token: this.claudeStandIn.refresh,
            expires_in: STAND_IN_EXPIRES_S,
            ...(renewed.profile.scopes ? { scope: renewed.profile.scopes.join(" ") } : {}),
          },
        }
      : { status: 200, body: { id_token: this.codexIdStandIn(renewed.profile), access_token: this.codexAccessStandIn(renewed.profile), refresh_token: this.codexRefreshStandIn } };
  }

  /** Codex's auth.json with stand-ins and the real account id. */
  codexStandInFile(profile: LoginProfile) {
    return JSON.stringify(
      {
        auth_mode: profile.auth_mode ?? "chatgpt",
        OPENAI_API_KEY: null,
        tokens: {
          id_token: this.codexIdStandIn(profile),
          access_token: this.codexAccessStandIn(profile),
          refresh_token: this.codexRefreshStandIn,
          ...(profile.account_id ? { account_id: profile.account_id } : {}),
        },
        last_refresh: new Date(this.now()).toISOString(),
      },
      null,
      2,
    );
  }

  /**
   * The credential a sign-in made in the runtime container left in its private folder (signInHere.ts), uploaded with
   * the person's consent (they started it from the card that says it follows them) and held. Only that folder's file
   * comes here: nothing the tools container holds is ever read as a sign-in.
   */
  async captureFrom(engine: FollowedEngine, text: string): Promise<CaptureResult> {
    const cloud = this.cloud;
    if (cloud === undefined) return "none";
    // Never under the rule, nor while Cloud cannot say: a sign-in is not made or uploaded from inside the computer.
    if ((await this.ruled()) !== false) return "none";
    const found = engine === "claude-agent" ? parseClaudeCredentials(text) : parseCodexAuth(text);
    if (found === undefined || isStandIn(found.credential.access_token) || isStandIn(found.credential.refresh_token)) return "none";
    try {
      const stored = await cloud.put(CLOUD_ENGINE[engine], { consent: true, credential: found.credential, profile: found.profile, label: found.label });
      this.hold(engine, { engine: CLOUD_ENGINE[engine], version: stored.version, status: "ready", access_token: found.credential.access_token, expires_at: found.credential.expires_at ?? null, profile: found.profile });
      this.emit(engine);
      return "captured";
    } catch {
      return "failed";
    }
  }

  /** Sign out everywhere: Cloud drops the sign-in for every computer of the person; this one forgets it now. */
  async signOut(engine: FollowedEngine) {
    if (this.cloud === undefined) throw new Error("A sign-in follows you only on Cloud computers");
    if ((await this.ruled()) !== false) throw new Error(OUTSIDE_REMOVE);
    await this.cloud.remove(CLOUD_ENGINE[engine]);
    await this.clear(engine);
  }

  /**
   * A launch of `engine` on its followed sign-in, the lane Cloud names for it: claude gets its token stand-in (which
   * wins over any credentials file), codex a stand-in auth.json in `env.CODEX_HOME` (else the active home), written
   * over whatever is there, and its refresh route; neither keeps an API key from `env`. When the sign-in can't serve
   * (none, needs a new sign-in, Cloud unreachable with nothing held, the stand-ins unwritten) it says why and nothing
   * launches: no other login stands in. Undefined only off a Cloud computer, where no sign-in follows anyone.
   */
  async launchEnv(engine: FollowedEngine, env: Record<string, string | undefined> | undefined, codexRefreshUrl?: string): Promise<FollowedLaunch | undefined> {
    if (this.cloud === undefined) return undefined;
    const miss = (why: FollowedMiss): FollowedLaunch => ({ unavailable: why, message: followedMissMessage(engine, why) });
    // Never a capture here: only a sign-in made in the runtime container is taken (signInHere.ts).
    const held = await this.ensureHeld(engine).catch(() => undefined);
    if (held === undefined) return miss(this.missed.get(engine) ?? "unreachable");
    const { ANTHROPIC_API_KEY: _a, ANTHROPIC_AUTH_TOKEN: _t, OPENAI_API_KEY: _o, CODEX_API_KEY: _c, ...rest } = env ?? {};
    if (engine === "claude-agent") {
      return {
        env: {
          ...rest,
          CLAUDE_CODE_OAUTH_TOKEN: this.claudeStandIn.access,
          ...(held.profile.subscription_type ? { CLAUDE_CODE_SUBSCRIPTION_TYPE: held.profile.subscription_type } : {}),
          ...(held.profile.rate_limit_tier ? { CLAUDE_CODE_RATE_LIMIT_TIER: held.profile.rate_limit_tier } : {}),
        },
      };
    }
    try {
      const file = env?.CODEX_HOME ? path.join(env.CODEX_HOME, "auth.json") : await this.paths!.codex();
      const now = await this.files!.read(file);
      const access = now === undefined ? undefined : parseCodexAuth(now)?.credential.access_token;
      if (!this.owns("codex", access)) await this.files!.write(file, this.codexStandInFile(held.profile));
      this.codexFiles.add(file);
    } catch {
      return miss("unreachable");
    }
    return { env: { ...rest, ...(codexRefreshUrl ? { CODEX_REFRESH_TOKEN_URL_OVERRIDE: codexRefreshUrl } : {}) } };
  }

  /** Removes `engine`'s stand-in files here (never a real login), keeping what is held: a launch on another lane. */
  async dropStandIns(engine: FollowedEngine, env: Record<string, string | undefined> | undefined) {
    const files = this.files;
    if (files === undefined || this.paths === undefined || engine !== "codex") return;
    const file = env?.CODEX_HOME ? path.join(env.CODEX_HOME, "auth.json") : await this.paths.codex().catch(() => undefined);
    if (file !== undefined) await files.removeStandIn(file).catch(() => undefined);
  }
}

/** This runtime's followed sign-ins: joined to Cloud on a Cloud computer (computerSecrets.ts), idle elsewhere. */
export const followedLogins = new FollowedLogins();

/**
 * Whether this computer runs `engine` on a login of its person's that it was not signed in to itself (A3's heartbeat
 * `engines_signed_in`): a sign-in that follows them or, where their credentials stay outside it, a connection of
 * theirs that serves the engine now.
 */
export const hasFollowedLogin = async (engine: FollowedEngine): Promise<boolean> => {
  const outside = await followedLogins.connections().catch(() => undefined);
  return outside === undefined ? followedLogins.hasLogin(engine) : (await outside.serving(engine)).length > 0;
};

/** A launch of `engine` on its followed sign-in (FollowedLogins.launchEnv); undefined off a Cloud computer. */
export const withFollowedLogin = (engine: FollowedEngine, env: Record<string, string | undefined> | undefined, logins: FollowedLogins = followedLogins) =>
  Effect.gen(function* () {
    if (!logins.connected) return undefined;
    const egress = yield* Effect.serviceOption(EgressRoute);
    const refreshUrl = engine === "codex" && Option.isSome(egress) ? egress.value.route(CODEX_LOGIN_REFRESH) : undefined;
    return yield* Effect.promise(() => logins.launchEnv(engine, env, refreshUrl));
  });
