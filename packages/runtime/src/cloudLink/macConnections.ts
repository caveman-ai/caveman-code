// This Mac's side of "sign in once, everywhere" (cloud-computers SPEC §4, CONTRACT §4). A person connects a Claude
// plan or a compact plan once; Cloud keeps the ordered list and the secrets, for this Mac and every Cloud computer.
//
// - The list: `GET runtime/model-connections` as the runtime's enroller, read again when it is a few seconds old and
//   kept (it holds no secret) for when Cloud cannot be reached. Not signed in to Caveman: nothing is connected, and
//   everything works as it did before connections.
// - Use: once the person connected an engine's plan, that engine's chats here run on their connections, in Cloud's
//   order. The CLI holds a stand-in (modelConnections.ts), as on a Cloud computer; the egress scrub
//   (secrets/EgressScrub.ts) attaches the real credential here, on the endpoints its CLI uses and nowhere else. A
//   Claude plan's token is the sealed copy this runtime keeps (read from Cloud once on a Mac that did not make the
// connection); a compact plan's is a short-lived access token from Cloud, kept in memory until it ends. Cloud alone
// refreshes a compact sign-in (formal/SignInOnce.tla): this Mac never holds the refresh token.
// - Without a plan connected (none, expired, its kind switched off, or Cloud out of reach with nothing kept), the
//   engine runs on this Mac's own `claude` or `codex` login, exactly as before. That login is never read, copied or
//   uploaded here, and an account the person keeps in a folder of its own always runs on its own login.
// - With the plan connected and everything that serves the engine used up, a new chat starts on this Mac's own login
//   too, and says so in one line ("Your Claude plan is used up until 11:08 PM. Running on this Mac's own login.").
// - Offline: the Claude token keeps working. compact works until its access token ends; a launch after that finds no
//   credential to be had and runs on this Mac's own `codex` login if there is one.
// - Codex reads its sign-in only from `auth.json` in its home, beside its settings and chat history. So a connection
//   never stands behind the person's own `~/.codex` login (a stand-in there would overwrite it): it runs Codex's
//   default account, whose home is the runtime's own. A chat the person keeps on this Mac's own `codex login` stays
//   on it.
import * as fs from "node:fs";
import * as path from "node:path";

import { providerKeyValues } from "../provider/ProviderKeySeal.ts";
import { CONNECT_WHERE } from "./credentialRule.ts";
import {
  CODEX_LOGIN_REFRESH,
  followedTokens,
  STAND_IN_MARK,
  type LoginFiles,
} from "./engineLogins.ts";
import { CloudError, type Identity } from "./identity.ts";
import type { LinkState } from "./index.ts";
import {
  accessModelConnection,
  addModelConnection,
  hearAnswers,
  lacksConnections,
  LIST_REUSE_MS,
  listModelConnections,
  orderModelConnections,
  OutsideConnections,
  PLAN_KIND,
  removeModelConnection,
  type ChatGptCredential,
  type ModelConnection,
  type ModelConnectionList,
} from "./modelConnections.ts";

/** The runtime's sealed store for the copies it keeps of Claude plan tokens, by connection. */
export interface SealedTokens {
  readonly get: (connectionId: string) => Promise<string | undefined>;
  readonly set: (connectionId: string, token: string) => Promise<void>;
  readonly remove: (connectionId: string) => Promise<void>;
}

/** Where the last list Cloud gave is kept for when Cloud cannot be reached. It holds no secret. */
export interface RememberedList {
  readonly get: () => Promise<ModelConnectionList | undefined>;
  readonly set: (list: ModelConnectionList) => Promise<void>;
}

/** What the egress scrub needs to send a request made on a stand-in with its connection's real credential. */
export interface LocalPlane {
  /** What each stand-in stands for, and what the providers said since. */
  readonly connections: OutsideConnections;
  /** The headers that carry `connection`'s credential; undefined when it cannot be had now. */
  readonly credential: (
    connection: ModelConnection,
  ) => Promise<Readonly<Record<string, string>> | undefined>;
  /** The provider refused the credential as over: whether a newer one is to be had, for the request to go once more. */
  readonly refused: (connection: ModelConnection) => Promise<boolean>;
  /** The provider said the plan is used up, until `until` when it named a time. */
  readonly usedUp: (connection: ModelConnection, until: number | undefined) => void;
}

const EMPTY: ModelConnectionList = { connections: [], kinds: {} };
/** A compact access token this close to its end is asked for again. */
const ACCESS_MARGIN_MS = 60_000;
/** A key read for this Mac's egress serves this long before Cloud is asked again (a key removed in Cloud stops here within it). */
const KEY_REUSE_MS = 10 * 60_000;
/** How long a launch waits for Cloud's list when the one it knows is old, before it goes on with that one. */
const LAUNCH_WAIT_MS = 3_000;
/** As Cloud: a plan its provider called used up, naming no time, is tried again after this. */
const USED_UP_UNNAMED_MS = 15 * 60_000;

/** The sign-in files of a launch on this Mac, in the home the runtime made for it: its own files, never through a link. */
export const localLoginFiles: LoginFiles = {
  read: async (file) => {
    try {
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        return fs.fstatSync(fd).isFile() ? fs.readFileSync(fd, "utf8") : undefined;
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return undefined;
    }
  },
  write: async (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, text, { mode: 0o600 });
    fs.renameSync(temporary, file);
  },
  removeStandIn: async (file) => {
    const text = await localLoginFiles.read(file);
    if (text !== undefined && text.includes(STAND_IN_MARK)) fs.rmSync(file, { force: true });
  },
};

const truthy = (value: string | undefined) =>
  value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";

export class MacConnections {
  /** The stand-ins this run issued, what each stands for, and what the providers said since. */
  readonly connections: OutsideConnections;
  readonly #identity: () => Identity | undefined;
  readonly #link: LinkState;
  readonly #sealed: SealedTokens;
  readonly #remembered: RememberedList;
  readonly #stateDir: string;
  readonly #fetch: typeof fetch | undefined;
  readonly #now: () => number;
  #known: { readonly at: number; readonly list: ModelConnectionList } | undefined;
  #reading: Promise<ModelConnectionList> | undefined;
 /** Credentials read for this Mac's egress, in memory only: a compact access token until it ends, a key for a while. */
  readonly #held = new Map<
    string,
    {
      readonly headers: Readonly<Record<string, string>>;
      readonly token: string;
      readonly until: number;
    }
  >();
  /** Connections a provider said are over, this run: Cloud hears it from a Cloud computer's request or a reconnect. */
  readonly #over = new Set<string>();
  readonly #usedUp = new Map<string, number>();
  readonly #listeners = new Set<() => void>();
  /** What each engine's next chat here runs on, looked up at most every few seconds. */
  readonly #readiness = new Map<
    string,
    {
      readonly at: number;
      readonly listAt: number | undefined;
      readonly value: Promise<ModelConnection | undefined>;
    }
  >();
  /** Cloud last answered the list with no route for it: a Cloud from before connections, which cannot keep one. */
  #lacks = false;
  /** The scrub's routes, once it runs: a stand-in is worth nothing without it, so nothing launches on one before. */
  #route: ((upstream: string) => string | undefined) | undefined;
  /** Whether a base URL is one of the scrub's routes to Anthropic's own API (the engines' launches are pointed at them first). */
  #toAnthropic: ((url: string) => boolean) | undefined;

  constructor(input: {
    readonly identity: () => Identity | undefined;
    readonly link: LinkState;
    readonly sealed: SealedTokens;
    readonly remembered: RememberedList;
    readonly stateDir: string;
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
  }) {
    this.#identity = input.identity;
    this.#link = input.link;
    this.#sealed = input.sealed;
    this.#remembered = input.remembered;
    this.#stateDir = input.stateDir;
    this.#fetch = input.fetch;
    this.#now = input.now ?? Date.now;
    this.connections = new OutsideConnections({
      list: () => this.list(),
      usedUpUnnamedMs: USED_UP_UNNAMED_MS,
      ...(input.now ? { now: input.now } : {}),
    });
    hearAnswers(input.link, this.connections);
  }

  /** Whether this Mac is signed in to Caveman: without that nothing here applies. */
  get signedIn(): boolean {
    return this.#identity() !== undefined;
  }

  /** The egress scrub runs: its routes, for codex's refresh, and which of them lead to Anthropic's own API. */
  routed(route: (upstream: string) => string | undefined, toAnthropic?: (url: string) => boolean) {
    this.#route = route;
    this.#toAnthropic = toAnthropic;
    this.#readiness.clear();
  }

  /** Hears the list change (a connection made, removed, reordered, used up or over). */
  onChange(listener: () => void) {
    this.#listeners.add(listener);
    return () => void this.#listeners.delete(listener);
  }

  #changed() {
    this.connections.forget();
    this.#readiness.clear();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  /** `list` with what this Mac heard from the providers itself since: used up until a time, or over. */
  #seen(list: ModelConnectionList): ModelConnectionList {
    if (this.#over.size === 0 && this.#usedUp.size === 0) return list;
    const now = this.#now();
    return {
      kinds: list.kinds,
      connections: list.connections.map((c) => {
        if (this.#over.has(c.id) && c.status !== "revoked")
          return { ...c, status: "expired" as const };
        const until = this.#usedUp.get(c.id);
        return until !== undefined && until > now && c.status === "ready"
          ? { ...c, status: "used_up" as const, used_up_until: new Date(until).toISOString() }
          : c;
      }),
    };
  }

  /** One read of Cloud's list at a time. Cloud out of reach: the last list it gave. Signed out there: nothing. */
  #read(identity: Identity): Promise<ModelConnectionList> {
    this.#reading ??= (async () => {
      const before = this.#known?.list;
      try {
        const list = await listModelConnections(identity, this.#link, this.#fetch);
        this.#lacks = false;
        this.#known = { at: this.#now(), list };
        await this.#remembered.set(list).catch(() => undefined);
        // A connection that is gone from the list, or made again, takes its copy and what was heard of it with it.
        for (const gone of before?.connections ?? []) {
          if (list.connections.some((c) => c.id === gone.id)) continue;
          this.#held.delete(gone.id);
          this.#over.delete(gone.id);
          this.#usedUp.delete(gone.id);
          await this.#sealed.remove(gone.id).catch(() => undefined);
        }
        if (JSON.stringify(before) !== JSON.stringify(list)) this.#changed();
        return list;
      } catch (error) {
        // Out of reach says nothing of what Cloud can do: only an answer changes it.
        if (error instanceof CloudError) this.#lacks = lacksConnections(error);
        // Cloud says this runtime is nobody's now (signed out, revoked), or knows no connections (an older Cloud).
        const none =
          error instanceof CloudError &&
          (error.status === 401 || error.status === 403 || error.status === 404);
        const list = none
          ? EMPTY
          : (before ?? (await this.#remembered.get().catch(() => undefined)) ?? EMPTY);
        this.#known = { at: this.#now(), list };
        if (none && before !== undefined && before.connections.length > 0) this.#changed();
        return list;
      } finally {
        this.#reading = undefined;
      }
    })();
    return this.#reading;
  }

  /**
   * The person's connections as Cloud last gave them, with what this Mac heard since. A list already known answers
   * at once and is read again behind when it is older than `maxAgeMs`: a Cloud that hangs never holds engine.list.
   * `waitMs`: how long an old list waits for that read first (a launch: a plan connected on another device a moment
   * ago must run it, and a Cloud that hangs holds it no longer than this). Not signed in to Caveman: none.
   */
  async list(maxAgeMs = LIST_REUSE_MS, waitMs = 0): Promise<ModelConnectionList> {
    const identity = this.#identity();
    if (identity === undefined) return EMPTY;
    const known = this.#known;
    if (known !== undefined && this.#now() - known.at < maxAgeMs) return this.#seen(known.list);
    const read = this.#read(identity);
    if (known === undefined) return this.#seen(await read);
    void read.catch(() => undefined);
    if (waitMs > 0)
      await Promise.race([
        read.catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, waitMs).unref?.()),
      ]);
    return this.#seen((this.#known ?? known).list);
  }

  /**
   * Whether Cloud can keep a plan connected here, as it last answered the list: not a Cloud from before connections.
   * Asked before a sign-in opens, so nobody approves in the browser for a connection Cloud cannot take. One that
   * could not is asked again first: an updated Cloud is heard at once.
   */
  async canConnect(): Promise<boolean> {
    await this.list();
    if (this.#lacks) await this.fresh();
    return !this.#lacks;
  }

  /** The list read from Cloud now (after a change made here, or to see one made elsewhere). */
  async fresh(): Promise<ModelConnectionList> {
    const identity = this.#identity();
    if (identity === undefined) return EMPTY;
    return this.#seen(await this.#read(identity));
  }

  /**
   * Whether `engine`'s chats on this Mac run on the person's connections: they connected its plan (a Claude plan for
 * Claude Agent, a compact plan for Codex), it has not ended, and Cloud has its kind switched on. A key alone never
   * takes an engine off this Mac's own login: it serves their Cloud computers.
   */
  async runsOn(engine: "claude-agent" | "codex"): Promise<boolean> {
    const list = await this.list().catch(() => EMPTY);
    const plan = PLAN_KIND[engine];
    return (
      list.kinds[plan]?.on !== false &&
      list.connections.some(
        (c) =>
          c.kind === plan &&
          c.serves.includes(engine) &&
          (c.status === "ready" || c.status === "used_up"),
      )
    );
  }

  /**
   * The connection `engine`'s next chat here runs on: the first in the person's order that serves it and whose
   * credential can be had now. Undefined when the engine runs on this Mac's own login: not signed in to Caveman, its
   * plan not connected, the scrub not running, or nothing to be had (Cloud out of reach and nothing kept). `waitMs`:
   * how long an old list waits for Cloud first (`list`).
   */
  async ready(engine: "claude-agent" | "codex", waitMs = 0): Promise<ModelConnection | undefined> {
    if (this.#identity() === undefined || this.#route === undefined) return undefined;
    await this.list(LIST_REUSE_MS, waitMs).catch(() => undefined);
    // Looked up once per list read, and again every few seconds: a credential may have ended meanwhile.
    const listAt = this.#known?.at;
    const held = this.#readiness.get(engine);
    if (held !== undefined && held.listAt === listAt && this.#now() - held.at < LIST_REUSE_MS)
      return held.value;
    const value = (async () => {
      if (!(await this.runsOn(engine))) return undefined;
      for (const connection of await this.connections.serving(engine))
        if ((await this.credential(connection)) !== undefined) return connection;
      return undefined;
    })().catch(() => undefined);
    this.#readiness.set(engine, { at: this.#now(), listAt, value });
    return value;
  }

  /**
   * The headers that carry `connection`'s credential on a request of this Mac's: a Claude plan's sealed token, a
 * compact plan's short-lived access token and account, a key. Read from Cloud's access route when none is held
   * (each read is in the person's access log); undefined when it cannot be had (Cloud out of reach and nothing held,
   * or Cloud says the connection is over).
   */
  async credential(
    connection: ModelConnection,
  ): Promise<Readonly<Record<string, string>> | undefined> {
    const now = this.#now();
    if (connection.kind === "claude_plan") {
      const kept = await this.#sealed.get(connection.id).catch(() => undefined);
      if (kept !== undefined) return { authorization: `Bearer ${kept}` };
    }
    const held = this.#held.get(connection.id);
    if (held !== undefined && held.until - now > ACCESS_MARGIN_MS) return held.headers;
    const identity = this.#identity();
    const access =
      identity === undefined
        ? undefined
        : await accessModelConnection(identity, this.#link, connection.id, this.#fetch).catch(
            (error: unknown) => (this.#refusedByCloud(connection, error), undefined),
          );
    if (access === undefined)
      return held !== undefined && held.until > now ? held.headers : undefined;
    if (
      connection.kind === "claude_plan" &&
      typeof access.token === "string" &&
      access.token !== ""
    ) {
      await this.#sealed.set(connection.id, access.token).catch(() => undefined);
      return { authorization: `Bearer ${access.token}` };
    }
    if (
      connection.kind === "chatgpt_plan" &&
      typeof access.access_token === "string" &&
      access.access_token !== ""
    ) {
      const ends =
        typeof access.expires_at === "string" ? Date.parse(access.expires_at) : Number.NaN;
      const headers = {
        authorization: `Bearer ${access.access_token}`,
        ...(access.account_id ? { "chatgpt-account-id": access.account_id } : {}),
      };
      // In the scrub from now on: a token that lands in a model request's body is replaced first.
      if (!followedTokens.values.has(access.access_token)) {
        followedTokens.values.add(access.access_token);
        followedTokens.generation++;
      }
      this.#held.set(connection.id, {
        headers,
        token: access.access_token,
        until: Number.isFinite(ends) ? ends : now + ACCESS_MARGIN_MS * 2,
      });
      return headers;
    }
    if (
      (connection.kind === "api_key" || connection.kind === "gateway") &&
      typeof access.key === "string" &&
      access.key !== ""
    ) {
      const headers: Record<string, string> =
        connection.provider === "anthropic"
          ? { "x-api-key": access.key }
          : { authorization: `Bearer ${access.key}` };
      providerKeyValues.add(access.key);
      this.#held.set(connection.id, {
        headers,
        token: access.key,
        until: now + KEY_REUSE_MS + ACCESS_MARGIN_MS,
      });
      return headers;
    }
    return undefined;
  }

  /** Cloud would not hand the credential over because the connection is over (409) or its kind is off (403): heard here at once. */
  #refusedByCloud(connection: ModelConnection, error: unknown) {
    if (!(error instanceof CloudError)) return;
    if (error.code === "cave_code_connection_reconnect" && !this.#over.has(connection.id)) {
      this.#over.add(connection.id);
      this.#held.delete(connection.id);
      this.#changed();
    }
    if (error.code === "cave_code_connection_kind_off") this.#known = undefined;
  }

  /**
 * A provider refused `connection`'s credential as over. A compact plan: Cloud is asked for its token again, and a
   * newer one sends the request once more. A Claude plan's token never changes: the copy kept here goes, and the
   * connection reads expired here until the person connects it again.
   */
  async refused(connection: ModelConnection): Promise<boolean> {
    const refusedToken = this.#held.get(connection.id)?.token;
    this.#held.delete(connection.id);
    if (connection.kind === "chatgpt_plan") {
      await this.credential(connection);
      const now = this.#held.get(connection.id)?.token;
      if (now !== undefined && now !== refusedToken) return true;
    }
    if (connection.kind === "claude_plan")
      await this.#sealed.remove(connection.id).catch(() => undefined);
    if (connection.kind === "claude_plan" || connection.kind === "chatgpt_plan") {
      this.#over.add(connection.id);
      this.#changed();
    }
    return false;
  }

  /** A provider said `connection`'s plan is used up: listed so until `until` (no time named: as Cloud, a quarter of an hour). */
  usedUp(connection: ModelConnection, until: number | undefined) {
    this.#usedUp.set(connection.id, until ?? this.#now() + USED_UP_UNNAMED_MS);
    this.#changed();
  }

  /** What the egress scrub uses while this Mac is signed in to Caveman; undefined otherwise. */
  plane(): LocalPlane | undefined {
    if (this.#identity() === undefined) return undefined;
    return {
      connections: this.connections,
      credential: (connection) => this.credential(connection),
      refused: (connection) => this.refused(connection),
      usedUp: (connection, until) => this.usedUp(connection, until),
    };
  }

  /** The home of Codex's default account here: the runtime's own (provider/CodexApiKeyAccount.ts), never the person's `~/.codex`. */
  get #codexSlot(): string {
    return path.join(this.#stateDir, "providers", "codex", "codex", "home");
  }

  /**
   * Where Codex runs on a connection here. Its default account's home while that holds no key of this Mac's own, so
   * Codex's own probe reads the stand-in sign-in there (signed in, with its models, before the first chat); else a
   * home beside it. Either is the runtime's own: the person's `~/.codex` is never written.
   */
  async codexHome(): Promise<string> {
    const text = await localLoginFiles.read(path.join(this.#codexSlot, "auth.json"));
    return text === undefined || text.includes(STAND_IN_MARK)
      ? this.#codexSlot
      : path.join(this.#stateDir, "providers", "codex", "everywhere", "home");
  }

  /**
 * Makes Codex's default home say what is true now: a connection's stand-in sign-in while a compact plan runs Codex
   * here, and no stand-in once none does (one left behind would read as signed in and run nothing). A key of this
   * Mac's own in that home is never touched. Answers whether the home changed, for Codex to be probed again.
   */
  async settleCodexHome(): Promise<boolean> {
    const file = path.join(this.#codexSlot, "auth.json");
    const before = await localLoginFiles.read(file);
    if (before !== undefined && !before.includes(STAND_IN_MARK)) return false;
    const first = await this.ready("codex");
    if (first === undefined) {
      if (before === undefined) return false;
      await localLoginFiles.removeStandIn(file);
      return true;
    }
    if (first.kind !== "chatgpt_plan") return false;
    await this.connections.launch(
      "codex",
      { CODEX_HOME: this.#codexSlot },
      { files: localLoginFiles, codexRefreshUrl: this.#route?.(CODEX_LOGIN_REFRESH) },
    );
    return (await localLoginFiles.read(file)) !== before;
  }

  /**
   * Whether a launch with `env` is the engine on this Mac's own login, going to its provider's own API: the launch a
   * connection may stand behind. An account the person keeps in a folder of its own (a second Claude login, another
   * Codex account), a cloud lane (Bedrock, Vertex, Foundry) and a gateway of their own keep their own credentials.
   */
  ownLoginLaunch(
    engine: "claude-agent" | "codex",
    env: Readonly<Record<string, string | undefined>> | undefined,
  ): boolean {
    const accounts = path.join(this.#stateDir, "providers");
    const inside = (dir: string | undefined) =>
      dir !== undefined &&
      (path.resolve(dir) === accounts || path.resolve(dir).startsWith(`${accounts}${path.sep}`));
    if (engine === "codex")
      return env?.CODEX_HOME !== undefined && path.resolve(env.CODEX_HOME) === this.#codexSlot;
    if (inside(env?.CLAUDE_CONFIG_DIR)) return false;
    if (
      ["CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"].some(
        (name) => truthy(env?.[name]),
      )
    )
      return false;
    const base = env?.ANTHROPIC_BASE_URL?.trim();
    // A launch already pointed at the scrub's route to Anthropic (EngineEgress.ts does that first) still goes there.
    if (!base || this.#toAnthropic?.(base) === true) return true;
    try {
      return new URL(base).hostname === "api.anthropic.com";
    } catch {
      return false;
    }
  }

  /**
   * `env` for a launch of `engine` on the person's connections: the stand-in of the first that serves it, and for
   * Codex the runtime's own home with a stand-in sign-in. Undefined when this launch runs on this Mac's own login as
   * before: not signed in to Caveman, no plan connected (or none that can be had now), the scrub not running, or an
   * account in a folder of its own.
   */
  async launch(
    engine: "claude-agent" | "codex",
    env: Record<string, string | undefined> | undefined,
    session: string | undefined,
  ): Promise<Record<string, string | undefined> | undefined> {
    const route = this.#route;
    if (route === undefined || !this.ownLoginLaunch(engine, env)) return undefined;
    const knownBefore = this.#known;
    let first = await this.ready(engine, LAUNCH_WAIT_MS);
    if (
      first === undefined &&
      this.#identity() !== undefined &&
      knownBefore !== undefined &&
      this.#known === knownBefore
    ) {
      // Before this launch runs on this Mac's own login: a plan connected a moment ago, on another device, is found by
      // reading Cloud's list now, even when the cached miss is less than a second old. If ready already read a new
      // list, use that answer. A Cloud that hangs holds the launch no longer than a launch waits.
      await Promise.race([
        this.fresh().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, LAUNCH_WAIT_MS).unref?.()),
      ]);
      first = await this.ready(engine);
    }
    if (first === undefined) {
      // Nothing connected runs it now: a stand-in an earlier launch left in Codex's home goes, so it never passes for a sign-in.
      if (engine === "codex") await this.settleCodexHome().catch(() => undefined);
      // Never back to this Mac's own login in silence: where the person's plan is connected and everything that
      // serves the engine is used up, the chat says so in one line, and what it runs on instead.
      if (await this.runsOn(engine).catch(() => false))
        await this.connections.ownLogin(engine, session).catch(() => undefined);
      return undefined;
    }
    const launched = await this.connections.launch(
      engine,
      engine === "codex" ? { ...env, CODEX_HOME: await this.codexHome() } : env,
      {
        session,
        files: localLoginFiles,
        codexRefreshUrl: engine === "codex" ? route(CODEX_LOGIN_REFRESH) : undefined,
      },
    );
    return "env" in launched ? launched.env : undefined;
  }

  // ------------------------------------------------------------------------------------------- what a person changes

  #signedInAs(): Identity {
    const identity = this.#identity();
    if (identity === undefined)
      throw new CloudError(
        409,
        "Sign in to Caveman first, in Settings > Account.",
        "not_signed_in",
      );
    return identity;
  }

  /** Keeps a Claude plan's token (what `claude setup-token` printed) in Cloud for the person, and a sealed copy here. */
  async connectClaude(token: string): Promise<ModelConnection> {
    const identity = this.#signedInAs();
    const connection = await addModelConnection(
      identity,
      this.#link,
      { kind: "claude_plan", token },
      this.#fetch,
    );
    await this.#sealed.set(connection.id, token);
    this.#over.delete(connection.id);
    await this.fresh();
    this.#changed();
    return connection;
  }

  /**
 * Hands a compact sign-in the official `codex login` made in a private home to Cloud, which alone refreshes it from
   * then on. Nothing of it is kept here: this Mac asks Cloud for short-lived access tokens like every other.
   */
  async connectChatGpt(credential: ChatGptCredential): Promise<ModelConnection> {
    const identity = this.#signedInAs();
    const connection = await addModelConnection(
      identity,
      this.#link,
      { kind: "chatgpt_plan", credential },
      this.#fetch,
    );
    this.#over.delete(connection.id);
    this.#held.delete(connection.id);
    await this.fresh();
    this.#changed();
    return connection;
  }

  /** Puts `connectionId` first in the person's order, for every computer. */
  async useFirst(connectionId: string): Promise<void> {
    const identity = this.#signedInAs();
    const list = await this.fresh();
    if (!list.connections.some((c) => c.id === connectionId))
      throw new CloudError(
        404,
        `That sign-in was removed. Connect it again in ${CONNECT_WHERE}.`,
        "not_found",
      );
    await orderModelConnections(
      identity,
      this.#link,
      [connectionId, ...list.connections.filter((c) => c.id !== connectionId).map((c) => c.id)],
      this.#fetch,
    );
    await this.fresh();
    this.#changed();
  }

  /** Removes a connection from Cloud, so from every computer, and the copy kept here. */
  async remove(connectionId: string): Promise<void> {
    const identity = this.#signedInAs();
    await removeModelConnection(identity, this.#link, connectionId, this.#fetch);
    this.#held.delete(connectionId);
    await this.#sealed.remove(connectionId).catch(() => undefined);
    await this.fresh();
    this.#changed();
  }
}

const byLink = new WeakMap<LinkState, MacConnections>();
const routes = new WeakMap<
  LinkState,
  {
    readonly route: (upstream: string) => string | undefined;
    readonly toAnthropic: (url: string) => boolean;
  }
>();

/** This Mac's connections, for the runtime whose link `link` is; undefined on a Cloud computer and before they are made. */
export const macConnectionsOf = (link: LinkState): MacConnections | undefined => byLink.get(link);

/** Makes `connections` the ones of the runtime whose link `link` is (one per runtime, made where its accounts are). */
export const joinMacConnections = (link: LinkState, connections: MacConnections) => {
  byLink.set(link, connections);
  const scrub = routes.get(link);
  if (scrub !== undefined) connections.routed(scrub.route, scrub.toAnthropic);
};

/** The egress scrub of the runtime whose link `link` is runs: stand-ins work from now on. */
export const egressRuns = (
  link: LinkState,
  route: (upstream: string) => string | undefined,
  toAnthropic: (url: string) => boolean,
) => {
  routes.set(link, { route, toAnthropic });
  byLink.get(link)?.routed(route, toAnthropic);
};
