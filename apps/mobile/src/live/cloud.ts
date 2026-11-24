// The phone's side of Caveman Cloud: who is signed in, which computers are theirs, and the bearer the relay takes.
//
// A phone has no cookie jar to lean on and no runtime of its own to mint for it, so it signs in the way This Mac's
// runtime does (packages/runtime session-protocol/cloudSignin.ts): Cloud's device sign-in with the "code" connection,
// approved in a browser, which grants an access token (15 minutes) and a refresh token (each good once). Both are kept
// in the phone's Keychain (SecretStore), never in the app's store or its disk copy. With them it mints the same short
// bearer the desktop app uses (POST /api/v1/code/desktop-token, an hour, chat routes and relay attach only) and uses
// that for a person's chats, as the web does on the same routes: the list (GET /api/v1/code/chats, which names their
// runtimes), a call queued for a computer that is away (POST .../calls), a move (POST .../move), a wake hint, and the
// relay (connection.ts).
//
// The sign-in itself reaches Cloud's auth routes, the token mint, and the three routes Cloud opens to the Code app's
// sign-in for a device with no runtime to ask through (Caveman Cloud the spec): the person's computers (GET
// /api/v1/code/computers?mine=true: a sleeping Cloud computer has no runtime, so only its row says it exists, and
// that it updates when it next wakes or lost its disk), a workspace on a Cloud computer (POST /api/v1/code/workspaces)
// and their projects (GET /api/v1/code/projects). A Cloud from before 0165 refuses the first two: the computers are
// then the runtimes the chat list names, as before, and a chat starts on a Mac only.
//
// The same sign-in reads and changes the person's pull requests through Cloud, with no Mac on line (CONTRACT §12:
// the seven routes under /api/v1/code/reviews; src/pulls/ draws them).
//
// Platform-neutral: fetch and a SecretStore, so it runs the same on a phone, in a browser and in Node's tests.

/** Where the phone keeps what must not leave it: the Keychain or Keystore on a phone (native.ts). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Caveman's hosted Cloud (apps/web state/cloud.ts HOSTED_CLOUD). */
export const HOSTED_CLOUD = "https://app.caveman.so";

/** What Cloud's own row says of a computer (GET /api/v1/code/computers), as much as the phone reads. */
export interface ComputerRow {
  readonly desired_state: string;
  readonly observed_state: string;
  /** What holds it up, in Cloud's words ("" when nothing does). */
  readonly observed_reason: string;
  /** "usage": asleep because the plan's usage and credits ran out. */
  readonly sleep_reason?: string;
  /** Beside "usage", while nothing pays yet: when the plan resets. Absent when nothing says when. Never an amount. */
  readonly resets_at?: string;
  /** Its runtime is older than Cloud's minimum: it updates when it next wakes. */
  readonly runtime_outdated?: boolean;
  /** When Cloud last lost the disk it kept for it; its chats continued from their copies. */
  readonly disk_lost_at?: string;
}

/** One of the person's computers, as Cloud lists it: a Mac ("laptop") or a Cloud computer. */
export interface Computer {
  /**
   * The runtime it runs as now. "" while it has none: a Cloud computer that sleeps (Cloud ends its runtime's key at
   * every stop and mints another at the wake), or one not started yet. It is reached by `computer_id`.
   */
  readonly runtime_id: string;
  readonly computer_id: string;
  readonly kind: "laptop" | "cloud";
  readonly name: string;
  /** Heard from within 75 s and its relay link up. */
  readonly online: boolean;
  /** A Cloud computer's own state; absent for a Mac. */
  readonly state?: "running" | "starting" | "suspended" | "stopped" | "deleted";
  readonly last_seen_at: string;
  /** Its row, where this sign-in may read it (Cloud the spec); absent from a Cloud that names only runtimes. */
  readonly row?: ComputerRow;
}

/** A chat as Cloud lists it for the person (GET /api/v1/code/chats), as much as the phone reads. */
export interface CloudChat {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly computer_id: string;
  /** "" while its Cloud computer is not asked to run: it has no runtime then (Cloud sends null), and is reached by `computer_id`. */
  readonly runtime_id: string;
  /**
   * `sleep_reason` "usage": its Cloud computer sleeps because the plan is used up and nothing pays for its time now;
   * `resets_at`: when the plan resets, absent when nothing says when.
   */
  readonly where: {
    readonly kind: "laptop" | "cloud";
    readonly name: string;
    readonly online?: boolean;
    readonly sleep_reason?: "usage";
    readonly resets_at?: string;
  };
  /**
   * Whether the chat can run somewhere else than where it is, as its runtime said and Cloud's own rows allow; absent
   * when its runtime has not said. `stays`, exactly when it is false: why, as a code to word (never a sentence).
   */
  readonly movable?: boolean;
  readonly stays?: { readonly code: string };
  /**
   * On its way to another place, whoever started the move: `to` is "cloud" or the computer id of one of the person's
   * Macs, `waiting_turn` that it waits for the chat's turn to end, `since` when it was asked.
   */
  readonly moving?: { readonly to: string; readonly waiting_turn: boolean; readonly since: string };
  readonly kind: string;
  readonly title: string;
  readonly engine: string;
  readonly model?: string;
  /** owner/name on GitHub; absent for a plain folder or a repository with no remote there. */
  readonly repo?: string;
  /** The chat's own branch; absent for a chat that runs in a plain folder itself. */
  readonly branch?: string;
  /** False: Caveman cannot fetch the repository as this person (their GitHub account is not linked). */
  readonly repo_verified?: boolean;
  readonly status: "idle" | "working" | "needs_you" | "error";
  /** What it waits on the person for, in a line, while it does. */
  readonly needs_you?: { readonly kind: string; readonly summary: string };
  /** The chat that started it (a builder's lead), by its session. */
  readonly parent_session_id?: string;
  readonly last_activity_at: string;
  /** Which writing of the chat's saved copy Cloud holds (it starts over when the chat is rebuilt). */
  readonly epoch?: number;
  /** The calls a device queued for it that have not run yet. */
  readonly calls: ReadonlyArray<QueuedCall>;
}

/** A page of what Cloud saved of a chat (GET /api/v1/code/chats/{id}/events), oldest first: each event whole, by its place in the chat. */
export interface SavedPage {
  readonly epoch: number;
  readonly events: ReadonlyArray<{
    readonly cursor: number;
    readonly type: string;
    readonly at: string;
    readonly event: unknown;
  }>;
  readonly more: boolean;
  /** Cloud holds another writing than the one asked for: drop what was read and read from the start. */
  readonly reset?: boolean;
}

/** A call queued in Cloud for a chat whose computer was away (POST /api/v1/code/chats/{id}/calls). */
export interface QueuedCall {
  readonly request_id: string;
  readonly method: string;
  readonly status: "queued" | "delivered" | "done" | "failed" | "expired";
  /** Still queued and why: its Mac sleeps and Cloud is moving the chat, or the chat cannot move and waits for its Mac. */
  /** `code`, with not_movable: why the chat cannot move, in the codes a chat's `stays` uses and Cloud's own (repo_unverified, cloud_full). */
  readonly waiting?: {
    readonly reason: "laptop_asleep" | "not_movable";
    readonly detail?: string;
    readonly code?: string;
  };
  readonly error?: { readonly code: string; readonly message: string };
}

/** This device's signature over a call or a move (session-protocol devices.ts signCall): a Mac runs only what its devices signed. */
export interface Signed {
  readonly device_id: string;
  readonly at: string;
  readonly signature: string;
}

/** One of the person's projects as Cloud keeps it: its name and its repositories (host/owner/name). */
export interface CloudProject {
  readonly name: string;
  readonly repos: ReadonlyArray<string>;
}

/** What the install says about direct channels to Macs (the chat list's `direct`): off, or the STUN servers to use. */
export interface DirectAdvert {
  readonly enabled: boolean;
  readonly stun_servers: ReadonlyArray<string>;
}

export interface Account {
  readonly email: string;
}

/** Cloud answered with an error: its code (`cave_...`) and plain message when it sent them. */
export class CloudError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  /** What Cloud adds to a refusal for a client to act on: `resets_at`, when a plan that is used up serves again. */
  readonly details: Readonly<Record<string, unknown>> | undefined;
  constructor(
    status: number,
    message: string,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "CloudError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Where a move sends a chat: Cloud (which computer is Caveman's choice), or one of the person's Macs by its computer id. */
export type MoveTo = "cloud" | { readonly computer_id: string };

/** Nobody is signed in on this phone, or the sign-in ended (revoked, or a month old): sign in again. */
export class SignedOut extends Error {
  constructor(message = "Your Caveman sign-in ended. Sign in again.") {
    super(message);
    this.name = "SignedOut";
  }
}

/** A sign-in under way: the code Cloud's page asks the person to confirm, and the page. */
export interface SignIn {
  readonly user_code: string;
  /** Cloud's approve page with the code filled in: the app opens it in the browser. */
  readonly url: string;
  readonly expires_at: number;
  /** The account, once the person approved; null when `cancel` ended it. Rejects in plain words otherwise (expired, denied). */
  readonly done: Promise<Account | null>;
  cancel(): void;
}

/** The protocol's shapes, which Cloud's Review routes answer in (CONTRACT §12). */
type PrSummary = import("@caveman-app/session-protocol").PrSummary;
type PrDetail = import("@caveman-app/session-protocol").PrDetail;
type PrDiscussionItem = import("@caveman-app/session-protocol").PrDiscussionItem;

/** The open pull requests of the organization's repositories that GitHub shows the person, newest update first. */
export interface ReviewList {
  readonly prs: ReadonlyArray<PrSummary>;
  /** A repository whose pull requests could not be read (no GitHub link for its installation), and why in Cloud's words. */
  readonly errors: ReadonlyArray<{ readonly repo?: string; readonly message: string }>;
  /** "not_connected": Cloud keeps no GitHub link of the person's, so nothing is listed; `connect_url` is where one is made. */
  readonly github: "connected" | "not_connected";
  readonly connect_url?: string;
}

/** A pull request's changed files, each with its patch; a file GitHub sent no patch for is in `omitted`. */
export interface PullDiff {
  readonly head_sha?: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly old_path?: string;
    readonly status: "added" | "modified" | "deleted" | "renamed";
    readonly additions: number;
    readonly deletions: number;
    readonly patch: string;
  }>;
  readonly omitted: ReadonlyArray<string>;
}

export interface PhoneCloud {
  readonly url: string;
  /** Who is signed in on this phone; null when nobody is. */
  account(): Promise<Account | null>;
  signIn(): Promise<SignIn>;
  /** Ends the sign-in in Cloud and forgets it here. The device key stays: it is this phone's, not the account's. */
  signOut(): Promise<void>;
  /**
   * The person's computers, Macs first, whatever state each is in, and what the install says about direct channels.
   * One entry a computer: its row where Cloud lets this sign-in read it, with the runtime it runs as now, if any.
   * `cloud`: a chat can start on a Cloud computer from here (this Caveman runs them, and lets this sign-in ask).
   * `cloudOff`: this Caveman said it runs no Cloud computers for this organization (its `cloud_computers: false`);
   * false from one that does not say.
   */
  computers(): Promise<{
    readonly computers: ReadonlyArray<Computer>;
    readonly direct: DirectAdvert | undefined;
    readonly cloud: boolean;
    readonly cloudOff: boolean;
  }>;
  /** The person's open chats, on every computer, newest activity first. */
  chats(): Promise<ReadonlyArray<CloudChat>>;
  /** The person's projects as Cloud keeps them; none from a Cloud that does not say. */
  projects(): Promise<ReadonlyArray<CloudProject>>;
  /** Where a runtime is reached through the relay, and the bearer for each attempt (minted again before it lapses). */
  relay(runtimeId: string): { readonly url: string; readonly token: () => Promise<string> };
  /** The relay refused the bearer it was given: drop it, so the next attempt mints another. */
  renew(): void;
  /**
   * Asks Cloud to wake a Cloud computer the person is about to use. `state`: what the computer is doing now, when
   * Cloud says. Rejects with Cloud's own sentence when it will not wake (nothing pays for its time, a limit).
   */
  wake(computerId: string): Promise<{ readonly state?: Computer["state"] }>;
  /**
   * A workspace on a Cloud computer for `repo` (owner/name on GitHub). Which computer is Cloud's choice: the
   * project's own, woken if it sleeps, or a new one. The chat itself is started on that computer's runtime once it
   * is up (workspace.create), as the web does.
   */
  startInCloud(input: {
    readonly title: string;
    readonly repo: string;
    readonly base_branch?: string;
    readonly engine: string;
  }): Promise<{ readonly workspace_id: string; readonly computer_id: string }>;
  /** Queues a send, a Stop or an answer for a chat whose computer does not answer; Cloud delivers it, waking or moving as it must. */
  queue(
    sessionId: string,
    call: {
      readonly request_id: string;
      readonly method: "turn.submit" | "turn.interrupt" | "ask.respond";
      readonly params: Record<string, unknown>;
      readonly device?: Signed;
    },
  ): Promise<QueuedCall>;
  /** A queued call as it stands now; null once Cloud no longer has it. */
  queued(sessionId: string, requestId: string): Promise<QueuedCall | null>;
  /** What Cloud saved of a chat, a page after `after`: how a chat reads while its computer sleeps, with nothing woken. */
  saved(sessionId: string, epoch: number, after: number): Promise<SavedPage>;
  /**
   * Moves a chat to Cloud or to one of the person's Macs as the same chat (Cloud's move: one place holds it at a
   * time). `pending`: its own computer was asked to let it go at its turn's end; else it is on `computer_id` now.
   * Rejects with Cloud's own sentence when the chat cannot move.
   */
  move(
    sessionId: string,
    move: { readonly request_id: string; readonly to: MoveTo; readonly device?: Signed },
  ): Promise<{ readonly pending: boolean; readonly computer_id?: string }>;
  // Review from Cloud (CONTRACT §12), for a phone with no Mac on line: seven routes on the sign-in itself (the relay
  // bearer reads 401 there). GitHub is asked as the person, so what they see and may do is GitHub's to say, and an
  // approval, a comment or a merge is theirs. `repo` is owner/name on GitHub. A refusal rejects as Cloud said it:
  // 409 `cave_code_github_not_connected` (its `details.connect_url` is where GitHub connects), 409
  // `cave_code_github_refused` with GitHub's own words, 404 for a pull request the person cannot see.
  /** What waits to be reviewed; null from a Cloud that keeps Review from this sign-in. */
  reviews(): Promise<ReviewList | null>;
  /** One pull request: its checks, its reviewers, its files (without patches) and what the person may do (`can`). */
  pull(repo: string, number: number): Promise<PrDetail>;
  pullDiff(repo: string, number: number): Promise<PullDiff>;
  /** Its comments, its reviews with something said and its line threads, oldest first. */
  pullDiscussion(repo: string, number: number): Promise<ReadonlyArray<PrDiscussionItem>>;
  /** Approves, asks for changes (a body is required) or comments, as the person's review. */
  reviewPull(
    repo: string,
    number: number,
    review: { readonly verdict: "approve" | "request_changes" | "comment"; readonly body?: string },
  ): Promise<void>;
  /** A comment on the pull request; with `path` and `line` one on that line of the head (`side: "old"` for the base); with `thread_id` a reply. */
  commentOnPull(
    repo: string,
    number: number,
    comment: {
      readonly body: string;
      readonly path?: string;
      readonly line?: number;
      readonly side?: "new" | "old";
      readonly thread_id?: string;
    },
  ): Promise<void>;
  /** Merges it. With `head_sha`, GitHub refuses a head that moved since it was read. */
  mergePull(
    repo: string,
    number: number,
    merge: { readonly method: "squash" | "merge" | "rebase"; readonly head_sha?: string },
  ): Promise<void>;
}

interface Session {
  readonly access_token: string;
  readonly refresh_token: string | undefined;
  readonly email: string;
}

const SESSION = "caveman.cloud.session";
/** Ask for a new relay bearer this long before the one held expires. */
const EARLY_MS = 60_000;

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** A field that is words, or nothing. */
const text = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

const CALL_STATUS = new Set(["queued", "delivered", "done", "failed", "expired"]);
/** Cloud's word on a queued call (CallState), as much as the phone reads. */
function queuedCall(call: Record<string, unknown> | null): QueuedCall | null {
  if (
    !call ||
    typeof call.request_id !== "string" ||
    typeof call.method !== "string" ||
    typeof call.status !== "string" ||
    !CALL_STATUS.has(call.status)
  )
    return null;
  const why = record(call.waiting) ? call.waiting : undefined;
  const reason =
    why?.reason === "laptop_asleep" || why?.reason === "not_movable" ? why.reason : undefined;
  const detail = text(why?.detail);
  const code = text(why?.code);
  const waiting: QueuedCall["waiting"] = reason
    ? { reason, ...(detail ? { detail } : {}), ...(code ? { code } : {}) }
    : undefined;
  const error =
    record(call.error) && typeof call.error.code === "string"
      ? { code: call.error.code, message: text(call.error.message) ?? "" }
      : undefined;
  return {
    request_id: call.request_id,
    method: call.method,
    status: call.status as QueuedCall["status"],
    ...(waiting ? { waiting } : {}),
    ...(error ? { error } : {}),
  };
}

const failure = async (response: Response): Promise<CloudError> => {
  const body = (await response.json().catch(() => null)) as {
    error?: { code?: unknown; message?: unknown; details?: unknown };
  } | null;
  const { code, message, details } = record(body?.error) ? body.error : {};
  return new CloudError(
    response.status,
    typeof message === "string" && message !== ""
      ? message
      : `Caveman answered ${response.status}.`,
    typeof code === "string" ? code : undefined,
    record(details) ? details : undefined,
  );
};

export function phoneCloud(options: {
  readonly url?: string;
  readonly secrets: SecretStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}): PhoneCloud {
  const origin = new URL(options.url ?? HOSTED_CLOUD).origin;
  const { secrets } = options;
  const now = options.now ?? Date.now;
  const call = (
    route: string,
    init: {
      method?: string;
      bearer?: string | undefined;
      body?: unknown;
      signal?: AbortSignal;
    } = {},
  ) =>
    (options.fetch ?? fetch)(`${origin}${route}`, {
      method: init.method ?? "GET",
      headers: {
        accept: "application/json",
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });

  /** The relay bearer held (never kept on disk: an hour's, minted again from the sign-in). */
  let token: { readonly value: string; readonly expiresAt: number } | null = null;
  /** The sign-in as last read or written; undefined until the Keychain was asked. */
  let session: Session | null | undefined;
  const load = async (): Promise<Session | null> => {
    if (session !== undefined) return session;
    const text = await secrets.get(SESSION);
    let kept: unknown = null;
    try {
      kept = text === null ? null : JSON.parse(text);
    } catch {
      kept = null;
    }
    session =
      record(kept) &&
      typeof kept.access_token === "string" &&
      kept.access_token !== "" &&
      typeof kept.email === "string"
        ? {
            access_token: kept.access_token,
            refresh_token: typeof kept.refresh_token === "string" ? kept.refresh_token : undefined,
            email: kept.email,
          }
        : null;
    return session;
  };
  /** Whether Cloud lets this sign-in read computers' rows: not known until asked, false once it refused. */
  let rowsOpen: boolean | undefined;
  const save = async (next: Session | null) => {
    session = next;
    token = null;
    if (!next) rowsOpen = undefined;
    if (next) await secrets.set(SESSION, JSON.stringify(next));
    else await secrets.delete(SESSION);
  };

  /** One refresh at a time: Cloud honours each refresh token once, so a second would sign the person out. */
  let refreshing: Promise<Session> | null = null;
  const refresh = (expired: string): Promise<Session> =>
    (refreshing ??= (async () => {
      const kept = await load();
      if (!kept) throw new SignedOut();
      // Another call refreshed already: use the pair it kept.
      if (kept.access_token !== expired) return kept;
      if (!kept.refresh_token) {
        await save(null);
        throw new SignedOut();
      }
      const response = await call("/api/v1/auth/refresh", {
        method: "POST",
        body: { refresh_token: kept.refresh_token },
      }).catch(() => undefined);
      // Unreachable, or Cloud failing for a moment, is not refused: the sign-in is kept for the next try.
      if (!response || response.status >= 500 || response.status === 429)
        throw new CloudError(response?.status ?? 503, "Caveman is not reachable right now.");
      const pair = response.ok
        ? ((await response.json().catch(() => null)) as {
            access_token?: unknown;
            refresh_token?: unknown;
          } | null)
        : null;
      if (typeof pair?.access_token !== "string" || pair.access_token === "") {
        await save(null);
        throw new SignedOut();
      }
      const next: Session = {
        ...kept,
        access_token: pair.access_token,
        refresh_token:
          typeof pair.refresh_token === "string" ? pair.refresh_token : kept.refresh_token,
      };
      await save(next);
      return next;
    })().finally(() => (refreshing = null)));

  /** One call to Cloud's auth-side routes on the sign-in itself, refreshed once when its access token has lapsed. */
  const asPerson = async (
    route: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> => {
    const kept = await load();
    if (!kept) throw new SignedOut("Sign in to Caveman to reach your computers.");
    let response = await call(route, { ...init, bearer: kept.access_token });
    if (response.status !== 401) return response;
    const fresh = await refresh(kept.access_token);
    response = await call(route, { ...init, bearer: fresh.access_token });
    if (response.status === 401) {
      if ((await load())?.access_token === fresh.access_token) await save(null);
      throw new SignedOut();
    }
    return response;
  };

  let minting: Promise<string> | null = null;
  const bearer = (): Promise<string> => {
    if (token && token.expiresAt - now() > EARLY_MS) return Promise.resolve(token.value);
    return (minting ??= (async () => {
      const response = await asPerson("/api/v1/code/desktop-token", { method: "POST", body: {} });
      if (!response.ok) throw await failure(response);
      const minted = (await response.json().catch(() => null)) as {
        token?: unknown;
        expires_at?: unknown;
      } | null;
      const expiresAt =
        typeof minted?.expires_at === "string" ? Date.parse(minted.expires_at) : Number.NaN;
      if (typeof minted?.token !== "string" || minted.token === "" || Number.isNaN(expiresAt))
        throw new CloudError(502, "Caveman minted no token for this phone.");
      token = { value: minted.token, expiresAt };
      return minted.token;
    })().finally(() => (minting = null)));
  };

  /** One call to the chat routes on the relay bearer, minted again once when Cloud refuses the one held. */
  const api = async (
    route: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<Response> => {
    let response = await call(route, { ...init, bearer: await bearer() });
    if (response.status === 401) {
      token = null;
      response = await call(route, { ...init, bearer: await bearer() });
    }
    if (response.status === 401) throw new SignedOut();
    if (!response.ok) throw await failure(response);
    return response;
  };

  /** Cloud's list of the person's chats, with their runtimes and the install's word on direct channels. */
  interface List {
    chats?: ReadonlyArray<Record<string, unknown>>;
    runtimes?: ReadonlyArray<Record<string, unknown>>;
    direct?: { enabled?: unknown; stun_servers?: unknown };
  }
  let listing: Promise<List> | null = null;
  // One read for whoever asks while it is out: the computers and the chats are both in it.
  const readList = (): Promise<List> =>
    (listing ??= (async () =>
      (await (await api("/api/v1/code/chats?archived=false")).json()) as List)().finally(
      () => (listing = null),
    ));

  /**
   * The person's own computers' rows, and whether this Caveman runs Cloud computers (`cloud_computers`); null from a
   * Cloud that keeps them from this sign-in (before the spec) or has none.
   */
  const readRows = async (): Promise<{
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly cloud: boolean;
    readonly off: boolean;
  } | null> => {
    if (rowsOpen === false) return null;
    const response = await asPerson("/api/v1/code/computers?mine=true");
    if (response.status === 403 || response.status === 404) {
      rowsOpen = false;
      return null;
    }
    if (!response.ok) throw await failure(response);
    rowsOpen = true;
    const body = (await response.json().catch(() => null)) as {
      computers?: unknown;
      cloud_computers?: unknown;
    } | null;
    return {
      rows: Array.isArray(body?.computers) ? body.computers.filter(record) : [],
      cloud: body?.cloud_computers === true,
      off: body?.cloud_computers === false,
    };
  };

  const signIn = async (): Promise<SignIn> => {
    const response = await call("/api/v1/auth/device/code", {
      method: "POST",
      body: { connection: "code" },
    });
    if (!response.ok) {
      const refused = await failure(response);
      throw refused.code === "cave_device_login_disabled"
        ? new CloudError(403, "This Caveman server does not allow device sign-in.", refused.code)
        : refused;
    }
    const code = (await response.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      verification_uri_complete?: string;
      expires_in: number;
      interval?: number;
    };
    // The approve page is this Cloud's own: the app opens it as a link, so it never opens another site on Cloud's word.
    const here = (uri: string | undefined) => {
      try {
        return uri === undefined || new URL(uri).origin === origin;
      } catch {
        return false;
      }
    };
    if (!here(code.verification_uri) || !here(code.verification_uri_complete))
      throw new CloudError(502, "Caveman sent an approve page on another site.");
    const abort = new AbortController();
    const expiresAt = now() + code.expires_in * 1000;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        abort.signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), {
          once: true,
        });
      });
    const done = (async (): Promise<Account | null> => {
      let interval = Math.max(1, code.interval ?? 5) * 1000;
      while (!abort.signal.aborted) {
        await sleep(interval);
        if (abort.signal.aborted) return null;
        if (now() >= expiresAt) throw new Error("The code expired. Sign in again.");
        let grant: {
          access_token?: string;
          refresh_token?: string;
          delivery_ack_token?: string;
          error?: string;
        };
        try {
          const answer = await call("/api/v1/auth/device/token", {
            method: "POST",
            body: { device_code: code.device_code },
          });
          if (answer.status >= 500 || answer.status === 429) continue; // Cloud busy for a moment: keep waiting
          grant = (await answer
            .json()
            .catch(() => ({ error: `http_${answer.status}` }))) as typeof grant;
        } catch {
          continue; // unreachable for a moment: keep waiting until the code expires
        }
        if (grant.error === "authorization_pending") continue;
        if (grant.error === "slow_down") {
          interval += 5_000;
          continue;
        }
        if (grant.error === "expired_token") throw new Error("The code expired. Sign in again.");
        if (grant.error === "access_denied")
          throw new Error("The sign-in was denied in the browser. Sign in again if that was you.");
        if (grant.error || !grant.access_token)
          throw new Error("Caveman refused the sign-in. Sign in again.");
        if (grant.delivery_ack_token)
          await call("/api/v1/auth/device/ack", {
            method: "POST",
            bearer: grant.access_token,
            body: { device_code: code.device_code, ack_token: grant.delivery_ack_token },
          }).catch(() => undefined);
        const me = await call("/api/v1/auth/me", { bearer: grant.access_token });
        if (!me.ok) throw await failure(me);
        const email = ((await me.json()) as { user?: { email?: unknown } }).user?.email;
        if (typeof email !== "string" || email === "")
          throw new CloudError(502, "Caveman did not say which account approved.");
        if (abort.signal.aborted) {
          // Cancelled while Cloud answered: the grant is ended, never kept.
          await call("/api/v1/auth/logout", {
            method: "POST",
            bearer: grant.access_token,
            body: grant.refresh_token ? { refresh_token: grant.refresh_token } : {},
          }).catch(() => undefined);
          return null;
        }
        await save({ access_token: grant.access_token, refresh_token: grant.refresh_token, email });
        return { email };
      }
      return null;
    })();
    return {
      user_code: code.user_code,
      url:
        code.verification_uri_complete ??
        `${code.verification_uri}?user_code=${encodeURIComponent(code.user_code)}&connection=code`,
      expires_at: expiresAt,
      done,
      cancel: () => abort.abort(),
    };
  };

  /** A pull request's route under Cloud's Review routes; one that names no repository or number is nowhere. */
  const pullRoute = (repo: string, number: number, rest = ""): string => {
    const [owner, name, more] = repo.split("/");
    if (!owner || !name || more !== undefined || !Number.isInteger(number) || number < 1)
      throw new CloudError(404, "Caveman has no such pull request.", "cave_not_found");
    return `/api/v1/code/reviews/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/${number}${rest}`;
  };
  /** One of Cloud's Review routes on the sign-in: what it answered, or its refusal as Cloud said it. */
  const reviewRoute = async (
    route: string,
    init: { method?: string; body?: unknown } = {},
  ): Promise<unknown> => {
    const response = await asPerson(route, init);
    if (!response.ok) throw await failure(response);
    return response.json().catch(() => null);
  };
  const records = <T>(value: unknown): T[] =>
    Array.isArray(value) ? (value.filter(record) as unknown as T[]) : [];
  const review: Pick<
    PhoneCloud,
    | "reviews"
    | "pull"
    | "pullDiff"
    | "pullDiscussion"
    | "reviewPull"
    | "commentOnPull"
    | "mergePull"
  > = {
    reviews: async () => {
      const response = await asPerson("/api/v1/code/reviews");
      // A Cloud that keeps Review from this sign-in, or serves none: there is nothing to list.
      if (response.status === 403 || response.status === 404) return null;
      if (!response.ok) throw await failure(response);
      const body = (await response.json().catch(() => null)) as {
        prs?: unknown;
        errors?: unknown;
        github?: unknown;
        connect_url?: unknown;
      } | null;
      const connect = text(body?.connect_url);
      return {
        prs: records<PrSummary>(body?.prs).filter(
          (pr) =>
            typeof pr.repo === "string" &&
            typeof pr.number === "number" &&
            typeof pr.title === "string",
        ),
        errors: records<Record<string, unknown>>(body?.errors).flatMap((e) =>
          text(e.message) !== undefined
            ? [
                {
                  ...(text(e.repo) !== undefined ? { repo: text(e.repo)! } : {}),
                  message: text(e.message)!,
                },
              ]
            : [],
        ),
        github: body?.github === "not_connected" ? "not_connected" : "connected",
        ...(connect ? { connect_url: connect } : {}),
      };
    },
    pull: async (repo, number) => {
      const body = await reviewRoute(pullRoute(repo, number));
      if (!record(body) || typeof body.number !== "number" || typeof body.title !== "string")
        throw new CloudError(502, "Caveman did not send the pull request.");
      const can = record(body.can) ? body.can : {};
      return {
        ...(body as unknown as PrDetail),
        body: typeof body.body === "string" ? body.body : "",
        mergeable:
          body.mergeable === "clean" ||
          body.mergeable === "conflicting" ||
          body.mergeable === "blocked"
            ? body.mergeable
            : "unknown",
        checks_list: records(body.checks_list),
        reviewers: records(body.reviewers),
        files: records(body.files),
        // What Cloud did not say the person may do is not theirs to try.
        can: {
          merge: can.merge === true,
          review: can.review === true,
          comment: can.comment === true,
          merge_methods: Array.isArray(can.merge_methods)
            ? can.merge_methods.filter(
                (m): m is "squash" | "merge" | "rebase" =>
                  m === "squash" || m === "merge" || m === "rebase",
              )
            : [],
          ready: false,
        },
      };
    },
    pullDiff: async (repo, number) => {
      const body = await reviewRoute(pullRoute(repo, number, "/diff"));
      const diff = record(body) ? body : {};
      const head = text(diff.head_sha);
      return {
        ...(head ? { head_sha: head } : {}),
        files: records<PullDiff["files"][number]>(diff.files).filter(
          (f) => typeof f.path === "string" && typeof f.patch === "string",
        ),
        omitted: Array.isArray(diff.omitted)
          ? diff.omitted.filter((path): path is string => typeof path === "string")
          : [],
      };
    },
    pullDiscussion: async (repo, number) => {
      const body = await reviewRoute(pullRoute(repo, number, "/discussion"));
      return records<PrDiscussionItem>(record(body) ? body.items : null).filter(
        (item) =>
          item.type === "comment" || (item.type === "thread" && Array.isArray(item.comments)),
      );
    },
    reviewPull: async (repo, number, review) =>
      void (await reviewRoute(pullRoute(repo, number, "/review"), {
        method: "POST",
        body: { verdict: review.verdict, ...(review.body ? { body: review.body } : {}) },
      })),
    commentOnPull: async (repo, number, comment) =>
      void (await reviewRoute(pullRoute(repo, number, "/comments"), {
        method: "POST",
        body: {
          body: comment.body,
          ...(comment.path !== undefined
            ? {
                path: comment.path,
                line: comment.line,
                ...(comment.side ? { side: comment.side } : {}),
              }
            : {}),
          ...(comment.thread_id !== undefined ? { thread_id: comment.thread_id } : {}),
        },
      })),
    mergePull: async (repo, number, merge) =>
      void (await reviewRoute(pullRoute(repo, number, "/merge"), {
        method: "POST",
        body: { method: merge.method, ...(merge.head_sha ? { head_sha: merge.head_sha } : {}) },
      })),
  };

  return {
    url: origin,
    ...review,
    account: async () => {
      const kept = await load();
      return kept ? { email: kept.email } : null;
    },
    signIn,
    signOut: async () => {
      const kept = await load();
      await save(null);
      if (kept)
        await call("/api/v1/auth/logout", {
          method: "POST",
          bearer: kept.access_token,
          body: kept.refresh_token ? { refresh_token: kept.refresh_token } : {},
        }).catch(() => undefined);
    },
    computers: async () => {
      // The rows are extra: a moment without them still lists what the runtimes name.
      const [list, read] = await Promise.all([
        readList(),
        readRows().catch((error: unknown) => {
          if (error instanceof SignedOut) throw error;
          return null;
        }),
      ]);
      // The runtime each computer runs as now. Cloud lists them newest heartbeat first: a computer's first is its live
      // one, unless a later one is the one on line.
      const live = new Map<string, Computer>();
      for (const r of list.runtimes ?? []) {
        if (
          typeof r.runtime_id !== "string" ||
          typeof r.computer_id !== "string" ||
          (r.kind !== "laptop" && r.kind !== "cloud") ||
          r.computer_state === "deleted"
        )
          continue;
        const now: Computer = {
          runtime_id: r.runtime_id,
          computer_id: r.computer_id,
          kind: r.kind,
          name: text(r.name) ?? (r.kind === "cloud" ? "Cloud computer" : "Mac"),
          online: r.online === true,
          ...(typeof r.computer_state === "string"
            ? { state: r.computer_state as NonNullable<Computer["state"]> }
            : {}),
          last_seen_at: text(r.last_seen_at) ?? "",
        };
        const had = live.get(now.computer_id);
        if (!had || (!had.online && now.online)) live.set(now.computer_id, now);
      }
      const computers: Computer[] = [];
      const listed = new Set<string>();
      for (const row of read?.rows ?? []) {
        const id = text(row.id);
        const desired = text(row.desired_state) ?? "";
        const observed = text(row.observed_state) ?? "";
        if (id === undefined || desired === "deleted" || observed === "deleted") continue;
        const kind = row.driver === "local" ? "laptop" : "cloud";
        const now = live.get(id);
        // A Mac's row without a runtime is one that signed out of Caveman: there is nothing to reach.
        if (kind === "laptop" && !now) continue;
        const sleepReason = text(row.sleep_reason);
        const resetsAt = text(row.resets_at);
        const diskLostAt = text(row.disk_lost_at);
        listed.add(id);
        computers.push({
          runtime_id: now?.runtime_id ?? "",
          computer_id: id,
          kind,
          name: text(row.name) ?? now?.name ?? (kind === "cloud" ? "Cloud computer" : "Mac"),
          online: now?.online ?? false,
          // As Cloud reads a Cloud computer's row for the chat list (cave_code_computer_state).
          ...(kind === "cloud"
            ? {
                state:
                  now?.state ??
                  (desired === "running"
                    ? observed === "running"
                      ? "running"
                      : "starting"
                    : desired === "suspended"
                      ? "suspended"
                      : "stopped"),
              }
            : {}),
          last_seen_at: now?.last_seen_at ?? "",
          row: {
            desired_state: desired,
            observed_state: observed,
            observed_reason: text(row.observed_reason) ?? "",
            ...(sleepReason ? { sleep_reason: sleepReason } : {}),
            ...(resetsAt ? { resets_at: resetsAt } : {}),
            ...(row.runtime_outdated === true ? { runtime_outdated: true } : {}),
            ...(diskLostAt ? { disk_lost_at: diskLostAt } : {}),
          },
        });
      }
      // What only a runtime names: every computer on a Cloud that keeps its rows, and one a colleague made that runs the person's chat.
      for (const now of live.values()) if (!listed.has(now.computer_id)) computers.push(now);
      // Macs first, then Cloud computers, each by name: the order the person reads them in.
      computers.sort((a, b) =>
        a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "laptop" ? -1 : 1,
      );
      const direct =
        record(list.direct) && typeof list.direct.enabled === "boolean"
          ? {
              enabled: list.direct.enabled,
              stun_servers: Array.isArray(list.direct.stun_servers)
                ? list.direct.stun_servers.filter((s): s is string => typeof s === "string")
                : [],
            }
          : undefined;
      return { computers, direct, cloud: read?.cloud === true, cloudOff: read?.off === true };
    },
    chats: async () =>
      ((await readList()).chats ?? []).flatMap((c): CloudChat[] => {
        const session_id = text(c.session_id);
        const workspace_id = text(c.workspace_id);
        const computer_id = text(c.computer_id);
        const where = record(c.where) ? c.where : {};
        if (
          session_id === undefined ||
          workspace_id === undefined ||
          computer_id === undefined ||
          c.archived === true
        )
          return [];
        const repo = text(c.repo);
        const branch = text(c.branch);
        const model = text(c.model);
        const resets = text(where.resets_at);
        const staysCode = record(c.stays) ? text(c.stays.code) : undefined;
        const going = record(c.moving) ? c.moving : undefined;
        const goingTo = text(going?.to);
        const needs =
          record(c.needs_you) && text(c.needs_you.summary) !== undefined
            ? { kind: text(c.needs_you.kind) ?? "", summary: text(c.needs_you.summary)! }
            : undefined;
        const parent = text(c.parent_session_id);
        return [
          {
            session_id,
            workspace_id,
            computer_id,
            runtime_id: text(c.runtime_id) ?? "",
            where: {
              kind: where.kind === "cloud" ? "cloud" : "laptop",
              name: text(where.name) ?? "",
              ...(typeof where.online === "boolean" ? { online: where.online } : {}),
              ...(where.sleep_reason === "usage"
                ? { sleep_reason: "usage" as const, ...(resets ? { resets_at: resets } : {}) }
                : {}),
            },
            ...(typeof c.movable === "boolean" ? { movable: c.movable } : {}),
            ...(c.movable === false && staysCode ? { stays: { code: staysCode } } : {}),
            ...(goingTo
              ? {
                  moving: {
                    to: goingTo,
                    waiting_turn: going?.waiting_turn === true,
                    since: text(going?.since) ?? "",
                  },
                }
              : {}),
            kind: text(c.kind) ?? "chat",
            title: text(c.title) ?? "",
            engine: text(c.engine) ?? "",
            ...(model ? { model } : {}),
            ...(repo ? { repo } : {}),
            ...(branch ? { branch } : {}),
            ...(typeof c.repo_verified === "boolean" ? { repo_verified: c.repo_verified } : {}),
            status:
              c.status === "working" || c.status === "needs_you" || c.status === "error"
                ? c.status
                : "idle",
            ...(needs ? { needs_you: needs } : {}),
            ...(parent ? { parent_session_id: parent } : {}),
            last_activity_at: text(c.last_activity_at) ?? "",
            ...(typeof c.epoch === "number" ? { epoch: c.epoch } : {}),
            calls: Array.isArray(c.calls)
              ? c.calls.flatMap((call) =>
                  record(call) && queuedCall(call) ? [queuedCall(call)!] : [],
                )
              : [],
          },
        ];
      }),
    projects: async () => {
      const response = await asPerson("/api/v1/code/projects");
      if (response.status === 403 || response.status === 404) return [];
      if (!response.ok) throw await failure(response);
      const body = (await response.json().catch(() => null)) as { projects?: unknown } | null;
      return (Array.isArray(body?.projects) ? body.projects : []).flatMap((p): CloudProject[] =>
        record(p) && text(p.name) !== undefined && !text(p.archived_at)
          ? [
              {
                name: text(p.name)!,
                repos: Array.isArray(p.repos)
                  ? p.repos.filter((r): r is string => typeof r === "string")
                  : [],
              },
            ]
          : [],
      );
    },
    relay: (runtimeId) => ({
      url: `${origin.replace(/^http/, "ws")}/relay/v1/runtimes/${encodeURIComponent(runtimeId)}`,
      token: bearer,
    }),
    renew: () => {
      token = null;
    },
    wake: async (computerId) => {
      const response = await api(
        `/api/v1/code/computers/${encodeURIComponent(computerId)}/wake-hint`,
        { method: "POST", body: { reason: "connect" } },
      );
      const answer = (await response.json().catch(() => null)) as {
        computer_state?: unknown;
      } | null;
      return typeof answer?.computer_state === "string" && answer.computer_state !== ""
        ? { state: answer.computer_state as NonNullable<Computer["state"]> }
        : {};
    },
    startInCloud: async (input) => {
      const response = await asPerson("/api/v1/code/workspaces", {
        method: "POST",
        body: {
          title: input.title.slice(0, 200),
          repo: input.repo,
          base_branch: input.base_branch ?? "",
          engine: input.engine,
          computer: { kind: "cloud" },
        },
      });
      if (!response.ok) {
        const refused = await failure(response);
        // A Cloud from before the spec keeps this route from the sign-in.
        throw refused.code === "cave_agent_operation_forbidden"
          ? new CloudError(
              403,
              "This Caveman server does not start Cloud chats from a phone yet. Start it on your Mac.",
              refused.code,
            )
          : refused;
      }
      const made = (await response.json().catch(() => null)) as {
        id?: unknown;
        computer_id?: unknown;
      } | null;
      if (
        typeof made?.id !== "string" ||
        typeof made.computer_id !== "string" ||
        made.computer_id === ""
      )
        throw new CloudError(502, "Caveman made no Cloud computer for this chat.");
      return { workspace_id: made.id, computer_id: made.computer_id };
    },
    queue: async (sessionId, call) => {
      const response = await api(`/api/v1/code/chats/${encodeURIComponent(sessionId)}/calls`, {
        method: "POST",
        body: {
          ...(call.device ? { device: call.device } : {}),
          request_id: call.request_id,
          method: call.method,
          params: call.params,
        },
      });
      const state = queuedCall(
        (await response.json().catch(() => null)) as Record<string, unknown> | null,
      );
      if (!state) throw new CloudError(502, "Caveman did not say what became of the message.");
      return state;
    },
    queued: async (sessionId, requestId) => {
      try {
        return queuedCall(
          (await (
            await api(
              `/api/v1/code/chats/${encodeURIComponent(sessionId)}/calls/${encodeURIComponent(requestId)}`,
            )
          )
            .json()
            .catch(() => null)) as Record<string, unknown> | null,
        );
      } catch (error) {
        if (error instanceof CloudError && error.status === 404) return null;
        throw error;
      }
    },
    saved: async (sessionId, epoch, after) => {
      const page = (await (
        await api(
          `/api/v1/code/chats/${encodeURIComponent(sessionId)}/events?epoch=${epoch}&after=${after}&limit=2000`,
        )
      )
        .json()
        .catch(() => null)) as Record<string, unknown> | null;
      const events = Array.isArray(page?.events)
        ? page.events
            .filter(record)
            .flatMap((e) =>
              typeof e.cursor === "number" && typeof e.type === "string"
                ? [{ cursor: e.cursor, type: e.type, at: text(e.at) ?? "", event: e.event }]
                : [],
            )
        : [];
      return {
        epoch: typeof page?.epoch === "number" ? page.epoch : epoch,
        events,
        more: page?.more === true,
        ...(page?.reset === true ? { reset: true } : {}),
      };
    },
    move: async (sessionId, move) => {
      const response = await api(`/api/v1/code/chats/${encodeURIComponent(sessionId)}/move`, {
        method: "POST",
        body: {
          request_id: move.request_id,
          ...(move.device ? { device: move.device } : {}),
          to: move.to,
        },
      });
      const moved = (await response.json().catch(() => null)) as {
        pending?: unknown;
        computer_id?: unknown;
      } | null;
      return {
        pending: moved?.pending === true,
        ...(typeof moved?.computer_id === "string" && moved.computer_id !== ""
          ? { computer_id: moved.computer_id }
          : {}),
      };
    },
  };
}
