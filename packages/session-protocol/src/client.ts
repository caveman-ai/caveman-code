// A small Session Protocol client for browsers and Node 22 (global WebSocket).
// Reconnects on its own, resends unanswered calls (safe: mutating calls are
// deduped by their request_id, the rest are reads or connection-scoped),
// re-attaches every session from the (epoch, cursor) it delivered, turns
// screencasts back on, and drops events it has already delivered. Mutating
// calls go out in the order they were made, wait in a durable outbox until
// answered (so a reload resends them; not one that carries a credential or
// typed text: outboxKeeps), and every call has a deadline. Every connection
// opens with runtime.hello, whose answer it keeps.
import type {
  MethodName,
  NotificationName,
  NotificationParams,
  Params,
  Result,
  RpcError,
  RuntimeHello,
  Session,
  SessionEvent,
} from "./protocol.ts";
import { LEGACY_RUNTIME, PROTOCOL_REVISION } from "./revision.ts";

export class SessionProtocolError extends Error {
  readonly error: RpcError;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "SessionProtocolError";
    this.error = error;
  }
}

/** The runtime took longer than the call's deadline to answer, counted from when the call last went out. */
export class CallTimeout extends Error {
  readonly method: MethodName;
  readonly timeoutMs: number;
  constructor(method: MethodName, timeoutMs: number) {
    super(`The runtime did not answer ${method} within ${Math.round(timeoutMs / 1000)} s.`);
    this.name = "CallTimeout";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * A mutating call that did not go to the runtime (again). `unsent`: it never went out (no open socket within the call's
 * `unsentAfterMs`, or its client closed first) and is out of the outbox, so the caller may send it another way (Cloud's
 * queue) under the same request id. `unanswered`: the same for one that went out and was given up on before its answer
 * came (its socket lost for as long, its client closed, or its caller took it back); it may have run, so it goes on
 * only under its request id, whose receipt the runtime answers a repeat with. `stale`: it went out once with no answer,
 * and `ConnectOptions.resend` said not to send it again (its chat moved or changed epoch since, or it waited too long);
 * it may have run.
 */
export class CallNotSent extends Error {
  readonly method: MethodName;
  readonly reason: "unsent" | "unanswered" | "stale";
  constructor(method: MethodName, reason: "unsent" | "unanswered" | "stale") {
    super(
      reason === "unsent"
        ? `${method} could not reach the runtime.`
        : reason === "unanswered"
          ? `${method} lost the runtime before its answer came.`
          : `${method} was not sent again: its chat changed since, or it waited too long.`,
    );
    this.name = "CallNotSent";
    this.method = method;
    this.reason = reason;
  }
}

export type ConnectionState = "connecting" | "open" | "unauthorized" | "closed";

/**
 * The socket closed with an application code (4000-4999), e.g. Cloud's
 * relay: 4401 sign in again, 4404 the runtime is not connected; or 1006 when
 * the upgrade itself was refused (a browser cannot read why). Passed to
 * onState with "unauthorized" (4401) or "closed"; the client keeps retrying.
 */
export class ConnectionClosed extends Error {
  readonly code: number;
  constructor(code: number, reason: string) {
    super(reason || `connection closed (${code})`);
    this.name = "ConnectionClosed";
    this.code = code;
  }
}

/**
 * A fixed token, or a function the client calls before every connection
 * attempt (cache inside it if minting a token is expensive). "" sends no
 * bearer: the browser's same-origin session cookie authenticates (Cloud's relay).
 */
export type TokenSource = string | (() => string | Promise<string>);

/**
 * "live": attached and following. "reconnecting": nothing follows the chat for it now (the link dropped, the runtime
 * ended its attachment over a rewritten journal, or an attach the client let go of took its place); the client
 * re-attaches by itself.
 */
export type SubscriptionState = "live" | "reconnecting";

export interface AttachOptions {
  /** The journal epoch the caller's events through `from_cursor` belong to (a cache's). Omitted: trust the cursor. */
  readonly epoch?: number;
  /**
   * The chat's journal was rewritten (it moved, or its runtime lost the tail of it): drop every event held for it.
   * Events from cursor 1 of `epoch` follow.
   */
  readonly onReset?: (epoch: number) => void;
  /** The subscription ended for good, with the runtime's reason (see Client.attach). */
  readonly onError?: (error: SessionProtocolError) => void;
  readonly onState?: (state: SubscriptionState) => void;
}

export interface Subscription {
  readonly session: Session;
  /** Cursor of the last event delivered to onEvent. */
  cursor(): number;
  /** The journal epoch of the delivered events; undefined from a runtime from before epochs. */
  epoch?(): number | undefined;
  detach(): Promise<void>;
}

export interface CallOptions {
  /** How long the runtime may take to answer once the call is out; 0 waits forever. Default DEFAULT_TIMEOUT_MS. */
  readonly timeoutMs?: number;
  /**
   * A mutating call that may go another way: one that has not gone out on an open socket this long after it was made,
   * or after the socket it went out on was lost, is withdrawn (outbox entry deleted) and fails with CallNotSent
   * ("unsent", or "unanswered" or "stale" once it went out), as it does if the client closes before it is answered.
   * Unset: it waits for a socket.
   */
  readonly unsentAfterMs?: number;
  /**
   * Aborted before the call is answered, a mutating call leaves as one past `unsentAfterMs` does (its caller's take-back).
   * Any other call leaves too, with CallNotSent, and no later socket sends it again (connectDirect moved it elsewhere).
   * A call listens to it only until it settles, so calls may share one: aborted later, it takes back none of them.
   */
  readonly signal?: AbortSignal;
  /** The chat's journal epoch when the call was made, kept with its outbox entry (ConnectOptions.resend reads it). */
  readonly epoch?: number;
  /** The call went out on an open socket (the first time). */
  readonly onSent?: () => void;
  /**
   * A mutating call that already went out on another connection to this runtime (direct.ts hands its calls between
   * the channel and the relay), first made at `at` (epoch ms): it may have run, so it goes out here only as a resend
   * would (`ConnectOptions.resend`), and once withdrawn it is "unanswered" or "stale", never "unsent".
   */
  readonly wentOut?: { readonly at: number };
  /**
   * When a mutating call was first made (epoch ms), if another client of the same outbox made it and hands it on before
   * it went out (direct.ts, from a dying channel to the relay): its outbox entry keeps that time, so it keeps its place
   * ahead of the calls made after it, across a reload too. `wentOut.at` says the same for one that went out.
   */
  readonly madeAt?: number;
  /**
   * A mutating call's outbox entry is written (or the store failed, and it goes out all the same): a reload from now on
   * finds it there. Never for one the outbox does not keep (outboxKeeps), nor one withdrawn first. The call goes out
   * only once what it returns settles, so what the caller writes then is kept before the call can run (the sender's
   * mark that it may have run).
   */
  readonly onKept?: () => void | Promise<void>;
}

export interface Client {
  call<M extends MethodName>(method: M, params: Params<M>, options?: CallOptions): Promise<Result<M>>;
  /**
   * Deliver every event after `from_cursor` exactly once, in order, across
   * reconnects. The subscription ends for good, through `onError`, on a
   * refused re-attach (`not_found`, `forbidden`, `lease_lost`, `parked`,
   * `unauthorized`, ...), an end the runtime sends (`session.ended`), or a hole
   * in the stream that re-attaching does not fill. A rewritten journal
   * (`journal_reset`, a new epoch) does not end it: `onReset` fires and the
   * events replay from the start.
   */
  attach(
    session_id: string,
    from_cursor: number,
    onEvent: (event: SessionEvent) => void,
    options?: ((error: SessionProtocolError) => void) | AttachOptions,
  ): Promise<Subscription>;
  on<N extends Exclude<NotificationName, "session.event" | "session.events">>(
    name: N,
    handler: (params: NotificationParams<N>) => void,
  ): () => void;
  /**
   * The runtime's runtime.hello answer on the latest connection (LEGACY_RUNTIME for a runtime from before it); undefined
   * until one answers.
   */
  hello(): RuntimeHello | undefined;
  /** Each new answer: every connection asks again, since the runtime may have been updated in between. */
  onHello(listener: (hello: RuntimeHello) => void): () => void;
  close(): void;
}

/** A mutating call waiting for its answer, as the outbox keeps it. */
export interface OutboxEntry {
  readonly request_id: string;
  readonly method: MethodName;
  readonly params: unknown;
  /** Epoch ms the call was first made. */
  readonly at: number;
  /** CallOptions.epoch. */
  readonly epoch?: number;
}

/**
 * Where unanswered mutating calls wait, keyed by request id: an entry is put before the call goes out and deleted
 * once it is answered, so a page that reloads (or an app that restarts) resends what it had in flight. The runtime
 * dedupes by request id, so a resend of a call that ran returns its first answer.
 */
export interface Outbox {
  /** Every entry left by an earlier client, oldest first. */
  load(): Promise<ReadonlyArray<OutboxEntry>>;
  /**
   * Entries the outbox takes over after `load` (another page of the device held them then and has gone since: web
   * outbox.ts), oldest first: the client sends them as it sends those `load` returned, unless it says no (false: it is
   * closing), and then the outbox does not take them. Returns how to stop listening.
   */
  taken?(listener: (entries: ReadonlyArray<OutboxEntry>) => boolean | void): () => void;
  /**
   * Whether the calls this outbox keeps may go out from here now. False once the page can no longer answer for them
   * (it lost its Web Lock: another page may be sending them): none goes out again, and the page loads anew.
   */
  ours?(): boolean;
  put(entry: OutboxEntry): Promise<void>;
  delete(request_id: string): Promise<void>;
}

/** An outbox that lives as long as the page: calls survive reconnects, not reloads. */
export const memoryOutbox = (): Outbox & { readonly entries: Map<string, OutboxEntry> } => {
  const entries = new Map<string, OutboxEntry>();
  return {
    entries,
    load: async () => [...entries.values()].sort((a, b) => a.at - b.at),
    put: async (entry) => void entries.set(entry.request_id, entry),
    delete: async (request_id) => void entries.delete(request_id),
  };
};

/**
 * Mutating calls whose params carry a credential (a secret's value; a provider, web search or voice key; a Cloud
 * token) or what the person types (a password at a prompt or into a page). The runtime keeps none of these values, and
 * the outbox, plain text in the device's storage, keeps none either: such a call waits in memory, resent under its
 * request id across reconnects but not across a reload.
 */
const NOT_KEPT = new Set<MethodName>([
  "secret.set",
  "environment.build_secret.set",
  "credential.grant",
  "engine.account.add",
  "web.keys.set",
  "chief.voice.key",
  "cloud.enroll",
  "term.write",
  "browser.input",
  "computer.input",
]);
/** Whether a mutating call's entry may be put in the outbox (see NOT_KEPT). */
export const outboxKeeps = (method: MethodName): boolean => !NOT_KEPT.has(method);

/**
 * One socket's first exchange, before anything else goes out on it (a laptop runtime's device approval, S13): the hook
 * reads the frames the runtime sends first and makes calls of its own; pending calls, re-attaches and screencasts wait
 * until it resolves. A rejection drops the socket (reported to onState as "unauthorized") and the client tries again;
 * a HandshakeRefused ends the client instead. Resolving with `seal` makes every later frame on that socket go through
 * it, one at a time in the order sent; with `open`, every frame the runtime sends after it is read through it, in
 * order, and one it cannot open (or a plain one) drops the socket (deviceClient.ts, for the laptop that allowed this
 * device). Sealed frames that arrive while the handshake still runs wait for it.
 */
export type Handshake = (link: HandshakeLink) => Promise<void | HandshakeDone>;
export interface HandshakeDone {
  readonly seal?: (frame: string) => Promise<string>;
  readonly open?: (frame: string) => Promise<string | undefined>;
}
/** A frame sealed by the far side of a device handshake (devices.ts sealFrame). */
const SEALED_PREFIX = '{"device_frame"';
/** The runtime said no for good (a laptop that did not allow this device): calls fail with `error`, no more tries. */
export class HandshakeRefused extends Error {
  readonly error: RpcError;
  constructor(error: RpcError) {
    super(error.message);
    this.name = "HandshakeRefused";
    this.error = error;
  }
}
export interface HandshakeLink {
  /** A call on this socket only, sent at once and never resent. */
  call(method: string, params: unknown): Promise<unknown>;
  /** The params of the next notification named `method` on this socket (one that came before the hook asked included). */
  next(method: string, timeoutMs?: number): Promise<unknown>;
}

/**
 * Opens the socket for an attempt in place of a WebSocket (a WebRTC data channel to a laptop runtime, S14 lane P). It
 * returns an object that behaves as a browser WebSocket does: `readyState` 1 once open, `send`, `close`, and the
 * `onopen`/`onmessage`/`onerror`/`onclose` handlers this client sets. `bearer` is the token for this attempt.
 */
export type SocketFactory = (url: string, bearer: string) => WebSocket;

export interface ConnectOptions {
  /** Another transport for every attempt (see SocketFactory). Default: a WebSocket to `url`. */
  readonly socket?: SocketFactory;
  /** Runs first on every socket (see Handshake). */
  readonly handshake?: Handshake;
  /** Where mutating calls wait until answered. Default: memory (lost on reload). */
  readonly outbox?: Outbox;
  /** An answer to a call an earlier client left in the outbox (a send made before a reload). */
  readonly onRestored?: (entry: OutboxEntry, outcome: { readonly result: unknown } | { readonly error: Error }) => void;
  /** Default deadline for every call; 0 waits forever. */
  readonly timeoutMs?: number;
  /**
   * Asked before a mutating call goes out again (on a new socket after the first went down, or after a reload left it
   * in the outbox): false drops it (outbox entry deleted, CallNotSent "stale"), so a send whose chat moved or changed
   * epoch since, or that waited too long, never runs late. Default: always resend.
   */
  readonly resend?: (entry: OutboxEntry) => boolean;
  /**
   * Turn the screencasts it had on back on, on each new socket. Default true. False leaves that to the caller, who
   * sets them up again on "open" (connectDirect, which moves them between its paths).
   */
  readonly restoreScreencasts?: boolean;
  /** This client's build, sent in runtime.hello (`client_version`). Default "". */
  readonly clientVersion?: string;
}

/** The subprotocol the runtime selects; browsers send the token beside it. */
export const SUBPROTOCOL = "caveman.session.v1";
const BEARER_PROTOCOL = "base64url.bearer.";
const MIN_DELAY_MS = 250;
const MAX_DELAY_MS = 5_000;
/** Backoff resets only after a connection has stayed open this long. */
const STABLE_MS = 10_000;
/**
 * A runtime on this computer that has never answered is starting (the desktop shows "Starting Caveman Code's
 * runtime…"): a refused loopback connect costs nothing, so retry it this often for the first START_WINDOW_MS
 * instead of backing off to 1-2 s and missing the moment it listens.
 */
const LOCAL_START_RETRY_MS = 50;
const START_WINDOW_MS = 30_000;
/**
 * An attempt that has not opened by then is dropped and retried: a runtime
 * accepts TCP before it serves upgrades, and a browser queues every later
 * socket to that port behind an unanswered one. The cap doubles per dropped
 * attempt (to MAX_CONNECT_TIMEOUT_MS), so a slow but healthy link still opens.
 */
const CONNECT_TIMEOUT_MS = 3_000;
const MAX_CONNECT_TIMEOUT_MS = 30_000;
/** Re-attaches in a row that get no further past a gap before giving up. */
const MAX_GAP_RETRIES = 3;
/** Re-attach failures worth retrying; every other reason ends the subscription. */
const TRANSIENT = new Set(["rate_limited", "engine_unavailable", "internal"]);
/**
 * A call's deadline, counted from when it last went out on an open socket (never while the link is down): long enough
 * for the slowest honest call (a plugin clone, a pull request pushed over a slow link), short of forever.
 */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** session.attach answers before its backlog, at once from a healthy runtime: one that does not is retried sooner. */
const ATTACH_TIMEOUT_MS = 30_000;
/**
 * Attach answers past their deadline one socket may still owe. Each may yet start an attachment, so the client keeps
 * every one until the socket goes; a socket owing more is dropped for a fresh one, which owes none.
 */
const MAX_OVERDUE = 64;
/**
 * The runtime keeps a request id's answer for a day (server.ts receipts): an outbox entry older than this is not
 * resent, since the runtime could no longer tell a resend from a new call.
 */
export const OUTBOX_MAX_AGE_MS = 23 * 60 * 60 * 1000;

/** The newest outbox time handed out in this page (outboxAt). */
let outboxClock = 0;
/**
 * How far past now a kept time moves the outbox clock: a call stamped a moment ahead (a clock stepped back since, a burst
 * in one millisecond) still goes before the next one, and a time far ahead (a clock that was wrong, a damaged entry)
 * does not stamp every later call in the future, where no resend window would ever close on it.
 */
export const OUTBOX_KEPT_AHEAD_MS = 1_000;
/**
 * The `at` of an outbox entry made now: epoch ms, past every one handed out before in this page, so every writer (each
 * client, connectDirect beside its relay client on one outbox, ChatSender) keeps the order its calls were made in, two
 * made in one millisecond included: an outbox lists its entries by `at`, then by request id. `kept`: the time a call
 * that went out elsewhere keeps (CallOptions.wentOut), which every later one passes, up to OUTBOX_KEPT_AHEAD_MS past now.
 */
export const outboxAt = (kept?: number): number => {
  if (kept !== undefined) {
    outboxClock = Math.max(outboxClock, Math.min(kept, Date.now() + OUTBOX_KEPT_AHEAD_MS));
    return kept;
  }
  return (outboxClock = Math.max(Date.now(), outboxClock + 1));
};

/** Node 22's WebSocket (undici) takes upgrade headers; the DOM typing does not know that. */
type NodeWebSocket = new (url: string, init: { headers: Record<string, string> }) => WebSocket;
/** WebSocket.OPEN, which a SocketFactory's sockets share. */
const OPEN = 1;
const base64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

interface Pending {
  method: MethodName;
  params: unknown;
  resolve: (result: never) => void;
  reject: (error: Error) => void;
  timeoutMs: number;
  timer?: ReturnType<typeof setTimeout>;
  /** The outbox holds it under this request id until it settles. */
  requestId?: string;
  /** Its outbox entry (what `resend` is asked about). */
  entry?: OutboxEntry;
  /** Its id in `pending`, once there. */
  id?: number;
  /** It went out on a socket at least once (another client's: it came from the outbox, or CallOptions.wentOut). */
  wentOut?: boolean;
  /** Withdrawn for its caller to send another way (CallNotSent). */
  withdrawn?: boolean;
  /** CallOptions.unsentAfterMs: it may go another way. */
  unsentAfterMs?: number;
  /** Withdraws it if it is not out on an open socket by then. */
  unsent?: ReturnType<typeof setTimeout> | undefined;
  onSent?: () => void;
  /** Runs as the answer arrives, before anything after it is read off the socket (session.attach's reset), late too. */
  onAnswer?: (result: unknown) => void;
  /** Already resent once on a fresh token after an `unauthorized` reply. */
  refreshed?: boolean;
}
interface Subscriber {
  cursor: number;
  epoch: number | undefined;
  onEvent: (event: SessionEvent) => void;
  options: AttachOptions;
}
/** One session's attachment on this connection, shared by its subscribers. */
interface Attached {
  subs: Set<Subscriber>;
  /** The journal epoch the runtime last answered with. */
  epoch: number | undefined;
  /** session.attach calls in flight or waiting to retry. */
  syncing: number;
  /** A gap arrived while syncing; look again when the sync ends. */
  gapPending: boolean;
  /** Gap re-attaches since an event was last delivered. */
  gaps: number;
  retry: number;
  /** Following on an open socket (its subscribers were last told "live"). */
  live: boolean;
}

interface Shake {
  readonly calls: Map<number, { resolve: (r: unknown) => void; reject: (e: Error) => void }>;
  readonly early: Array<{ method: string; params: unknown }>;
  readonly waits: Array<{ method: string; resolve: (p: unknown) => void }>;
}

type AttachResult = Result<"session.attach"> & { readonly epoch?: number; readonly reset?: boolean };

const isMutatingParams = (params: unknown): params is { request_id: string } =>
  typeof params === "object" && params !== null && typeof (params as { request_id?: unknown }).request_id === "string";

const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
/** A runtime.hello answer as the runtime sent it, or undefined when it is not one. */
const readHello = (value: unknown): RuntimeHello | undefined => {
  const v = value as Partial<Record<keyof RuntimeHello, unknown>> | null;
  if (v === null || typeof v !== "object" || typeof v.version !== "string" || !isCount(v.protocol_revision) || !isCount(v.min_client_revision)) return undefined;
  if (!Array.isArray(v.capabilities) || !v.capabilities.every((c) => typeof c === "string")) return undefined;
  return { version: v.version, protocol_revision: v.protocol_revision, min_client_revision: v.min_client_revision, capabilities: v.capabilities };
};

export const connect = (
  url: string,
  token: TokenSource,
  onState?: (state: ConnectionState, error?: Error) => void,
  options: ConnectOptions = {},
): Client => {
  const parsed = new URL(url); // a bad URL throws here, not on every attempt
  const target = String(parsed);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname);
  const startedAt = Date.now();
  const outbox = options.outbox ?? memoryOutbox();
  const defaultTimeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let everOpened = false;
  const pending = new Map<number, Pending>();
  const attached = new Map<string, Attached>();
  /**
   * Per session, the entry whose session.attach answer was read last on this socket. The runtime keeps one attachment
   * per connection and session and sends its events only after its answer, so what arrives before an entry's own answer
   * comes from an attachment this client let go of.
   */
  const streams = new Map<string, Attached>();
  /** onAnswer of each call that ran out its deadline on this socket: an attach answered late still starts an attachment. */
  const overdue = new Map<number, (result: unknown) => void>();
  const screencasts = new Map<string, Params<"browser.screencast">>();
  const handlers = new Map<string, Set<(params: never) => void>>();
  let socket: WebSocket | undefined;
  let closed = false;
  /** runtime.hello: the latest answer, the id of the one out on the current socket, and who hears new answers. */
  let hello: RuntimeHello | undefined;
  let helloId: number | undefined;
  const helloListeners = new Set<(hello: RuntimeHello) => void>();
  let delay = MIN_DELAY_MS;
  let connectTimeout = CONNECT_TIMEOUT_MS;
  let nextId = 1;

  const settle = (id: number | undefined, p: Pending) => {
    if (id !== undefined) pending.delete(id);
    clearTimeout(p.timer);
    clearTimeout(p.unsent);
    if (p.requestId !== undefined) void outbox.delete(p.requestId).catch(() => undefined);
  };
  /**
   * An unanswered call that may go another way leaves, so its caller can send it there under the same request id. One
   * that went out goes on only as a resend would (`resend`).
   */
  const withdraw = (p: Pending) => {
    if (p.withdrawn || (p.id !== undefined && pending.get(p.id) !== p)) return;
    p.withdrawn = true;
    settle(p.id, p);
    p.reject(new CallNotSent(p.method, !p.wentOut ? "unsent" : p.entry && options.resend && !options.resend(p.entry) ? "stale" : "unanswered"));
  };

  /** The open socket passed its handshake: calls may go out on it. */
  let ready = false;
  /** What the handshake made every later frame on this socket go through, and the frames still being sealed. */
  let seal: ((frame: string) => Promise<string>) | undefined;
  let sealing: Promise<void> = Promise.resolve();
  /** The handshake said no for good. */
  let refused: HandshakeRefused | undefined;
  const transmit = (target: WebSocket, frame: string) => {
    if (!seal) return target.send(frame);
    // Sealed at once (each frame's sequence number is its place in this order), sent after the frames before it.
    const sealed = seal(frame);
    sealed.catch(() => undefined);
    sealing = sealing
      .then(() => sealed)
      .then((sealed) => {
        if (socket === target && target.readyState === OPEN) target.send(sealed);
      })
      .catch(() => target.close());
  };
  const send = (id: number, p: Pending) => {
    if (socket?.readyState !== OPEN || !ready) return;
    // Its outbox no longer answers for it: another page may be sending it. It waits here until the page loads anew.
    if (p.entry && outbox.ours?.() === false) return;
    if (p.wentOut && p.entry && options.resend && !options.resend(p.entry)) {
      settle(id, p);
      return p.reject(new CallNotSent(p.method, "stale"));
    }
    const first = !p.wentOut;
    p.wentOut = true;
    clearTimeout(p.unsent);
    p.unsent = undefined;
    transmit(socket, JSON.stringify({ jsonrpc: "2.0", id, method: p.method, params: p.params }));
    // The deadline runs while the call is out; a resend on a new socket starts it again.
    clearTimeout(p.timer);
    if (p.timeoutMs > 0) {
      p.timer = setTimeout(() => {
        if (pending.get(id) !== p) return;
        settle(id, p);
        if (p.onAnswer) overdue.set(id, p.onAnswer);
        p.reject(new CallTimeout(p.method, p.timeoutMs));
        if (overdue.size > MAX_OVERDUE) socket?.close();
      }, p.timeoutMs);
    }
    if (first) p.onSent?.();
  };

  const enqueue = (p: Pending) => {
    const id = nextId++;
    p.id = id;
    pending.set(id, p);
    send(id, p);
  };

  /** Calls an earlier client left (or a page that has gone since), sent again in turn. */
  const restore = (restored: ReadonlyArray<OutboxEntry>) => {
    for (const entry of restored) {
      const report = (outcome: { result: unknown } | { error: Error }) => options.onRestored?.(entry, outcome);
      if (closed) return;
      if (Date.now() - entry.at > OUTBOX_MAX_AGE_MS) {
        void outbox.delete(entry.request_id).catch(() => undefined);
        report({ error: new Error(`${entry.method} was not answered before the runtime forgot its request id; it was not resent.`) });
        continue;
      }
      // Left by a version from before outboxKeeps: the credential or typed text leaves the device's storage, unsent.
      if (!outboxKeeps(entry.method)) {
        void outbox.delete(entry.request_id).catch(() => undefined);
        report({ error: new Error(`${entry.method} carries a credential or typed text, which is never sent again after a reload.`) });
        continue;
      }
      enqueue({
        method: entry.method,
        params: entry.params,
        requestId: entry.request_id,
        entry,
        // An earlier client may have sent it: `resend` decides before it goes out again.
        wentOut: true,
        timeoutMs: defaultTimeout,
        resolve: ((result: unknown) => report({ result })) as (r: never) => void,
        reject: (error) => report({ error }),
      });
    }
  };
  // Mutating calls go out one after another in the order made: each waits for the one before it to be in the
  // outbox and on the wire (not for its answer). The calls an earlier client left go first.
  let lane: Promise<unknown> = (async () => {
    let restored: ReadonlyArray<OutboxEntry> = [];
    try {
      restored = await outbox.load();
    } catch {
      // An outbox that cannot be read holds nothing to resend.
    }
    restore(restored);
  })();
  // What the outbox takes over later goes in turn, behind what was made before it came.
  const stopTaking = outbox.taken?.((entries) => {
    if (closed) return false;
    lane = lane.then(() => restore(entries));
    return true;
  });

  const call = <M extends MethodName>(method: M, params: Params<M>, callOptions?: CallOptions) =>
    new Promise<Result<M>>((resolve, reject) => {
      if (closed) return reject(new Error("client closed"));
      if (refused) return reject(new SessionProtocolError(refused.error));
      if (method === "browser.screencast" && options.restoreScreencasts !== false) {
        const sc = params as Params<"browser.screencast">;
        if (sc.enabled) screencasts.set(sc.workspace_id, sc);
        else screencasts.delete(sc.workspace_id);
      }
      // The caller's take-back counts until the call settles, however it settles: a signal that outlives the call keeps
      // no listener for it, and an abort after that takes back nothing (a call its client closed on, kept in the outbox
      // for the next client, stays there).
      const signal = callOptions?.signal;
      const takeBack = () => withdraw(p);
      const over = () => signal?.removeEventListener("abort", takeBack);
      const p: Pending = {
        method,
        params,
        resolve: ((result: never) => (over(), resolve(result))) as (r: never) => void,
        reject: (error) => (over(), reject(error)),
        timeoutMs: callOptions?.timeoutMs ?? defaultTimeout,
        ...(callOptions?.onSent ? { onSent: callOptions.onSent } : {}),
      };
      if (!isMutatingParams(params)) {
        if (signal?.aborted) return reject(new CallNotSent(method, "unsent"));
        signal?.addEventListener("abort", takeBack, { once: true });
        enqueue(p);
        return;
      }
      // One made elsewhere, out or not, keeps the time it was made (outboxAt).
      const at = outboxAt(callOptions?.wentOut?.at ?? callOptions?.madeAt);
      const entry: OutboxEntry = { request_id: params.request_id, method, params, at, ...(callOptions?.epoch !== undefined ? { epoch: callOptions.epoch } : {}) };
      p.requestId = entry.request_id;
      p.entry = entry;
      if (callOptions?.wentOut) p.wentOut = true;
      const unsentAfter = callOptions?.unsentAfterMs;
      if (unsentAfter !== undefined) {
        p.unsentAfterMs = unsentAfter;
        p.unsent = setTimeout(() => withdraw(p), unsentAfter);
      }
      signal?.addEventListener("abort", takeBack, { once: true });
      if (signal?.aborted) withdraw(p);
      const gone = () => (unsentAfter !== undefined ? withdraw(p) : p.reject(new Error("client closed")));
      lane = lane.then(async () => {
        if (p.withdrawn) return;
        if (closed) return gone();
        // A full or broken store still sends: the call just would not survive a reload.
        if (outboxKeeps(method)) await outbox.put(entry).catch(() => undefined);
        // Withdrawn while the store wrote: its delete may have run first.
        if (p.withdrawn) return void outbox.delete(entry.request_id).catch(() => undefined);
        if (outboxKeeps(method)) {
          try {
            await callOptions?.onKept?.();
          } catch {
            // What the caller keeps is its own: the call goes out all the same.
          }
        }
        if (p.withdrawn) return void outbox.delete(entry.request_id).catch(() => undefined);
        if (closed) return gone();
        enqueue(p);
      });
    });

  const low = (a: Attached) => Math.min(...Array.from(a.subs, (s) => s.cursor));

  const end = (session_id: string, a: Attached, error: SessionProtocolError) => {
    if (attached.get(session_id) === a) attached.delete(session_id);
    const subs = [...a.subs];
    a.subs.clear();
    for (const s of subs) s.options.onError?.(error);
  };

  const reset = (s: Subscriber, epoch: number) => {
    s.cursor = 0;
    s.epoch = epoch;
    s.options.onReset?.(epoch);
  };

  /** The entry's attachment ended or another took its place: nothing follows the chat for it until an attach answer. */
  const lapse = (a: Attached) => {
    if (!a.live) return;
    a.live = false;
    for (const s of a.subs) s.options.onState?.("reconnecting");
  };

  /**
   * The attach answer, read before anything after it on the socket (one that came after its deadline too): what
   * follows it is this entry's. A rewritten journal (new epoch, or a cursor past its head) drops what each subscriber
   * holds, so the replay that follows is delivered rather than deduped away.
   */
  const answered = (session_id: string, a: Attached, sent: number, result: AttachResult) => {
    streams.set(session_id, a);
    const now = attached.get(session_id);
    if (now !== a) {
      // A let-go entry's: its attachment took the place of the current entry's, which attaches again unless it is
      // syncing (that sync's end looks again). With no current entry it feeds no one: a runtime from before the attach
      // lane (server.ts laneOf) may have run the detach attach() sent ahead of this attach, so detach again.
      if (!now) return void call("session.detach", { session_id }).catch(() => undefined);
      lapse(now);
      if (now.syncing === 0) reattach(session_id, now);
      return;
    }
    const epoch = result.epoch ?? a.epoch;
    let dropped = false;
    for (const s of a.subs) {
      const stale =
        result.reset === true || (epoch !== undefined && s.epoch !== undefined && s.epoch !== epoch) || s.cursor > result.session.head;
      if (stale) {
        reset(s, epoch ?? 0);
        dropped = true;
      } else if (epoch !== undefined) s.epoch = epoch;
    }
    a.epoch = epoch;
    if (dropped) a.gaps = 0;
    // The runtime replays from 0 on its own `reset`; a drop this client decided must ask for that replay.
    if (dropped && result.reset !== true && sent > 0) a.gapPending = true;
    if (!a.live) {
      a.live = true;
      for (const s of a.subs) s.options.onState?.("live");
    }
  };

  /** Attach from the lowest cursor any subscriber has; the others drop what they already have. */
  const sync = async (session_id: string, a: Attached): Promise<Session> => {
    a.syncing++;
    let session: Session;
    try {
      const cursor = low(a);
      const lowest = [...a.subs].find((s) => s.cursor === cursor);
      const epoch = a.epoch ?? lowest?.epoch;
      const params = { session_id, cursor, batch: true, ...(epoch !== undefined ? { epoch } : {}) } as Params<"session.attach">;
      ({ session } = await new Promise<AttachResult>((resolve, reject) => {
        if (closed) return reject(new Error("client closed"));
        enqueue({
          method: "session.attach",
          params,
          resolve: resolve as (r: never) => void,
          reject,
          timeoutMs: Math.min(defaultTimeout || ATTACH_TIMEOUT_MS, ATTACH_TIMEOUT_MS),
          onAnswer: (result) => answered(session_id, a, cursor, result as AttachResult),
        });
      }));
    } finally {
      a.syncing--;
    }
    resume(session_id, a);
    return session;
  };

  /**
   * Nothing syncs any more: act on a gap or a rewritten journal that arrived meanwhile, and attach again for subscribers
   * no attachment on this socket feeds: the attach that was to bring them back after a drop failed, or a let-go entry's
   * late answer took their attachment's place while it was out.
   */
  const resume = (session_id: string, a: Attached) => {
    if (a.syncing > 0 || attached.get(session_id) !== a) return;
    if (a.gapPending) {
      a.gapPending = false;
      return gap(session_id, a);
    }
    if (streams.get(session_id) !== a) reattach(session_id, a);
  };

  const reattach = (session_id: string, a: Attached) => {
    sync(session_id, a).then(
      () => (a.retry = MIN_DELAY_MS),
      (error: unknown) => {
        if (closed || attached.get(session_id) !== a) return;
        // No answer in time: the link is up but the runtime is stuck; try again, like a transient refusal.
        const refused = error instanceof SessionProtocolError ? error : undefined;
        const transient = error instanceof CallTimeout || (refused?.error.data !== undefined && TRANSIENT.has(refused.error.data.reason));
        if (!transient) return refused ? end(session_id, a, refused) : undefined;
        a.syncing++; // waiting to retry counts as syncing, so reconnects and gaps leave it alone
        setTimeout(() => {
          a.syncing--;
          if (attached.get(session_id) === a) reattach(session_id, a);
        }, refused?.error.data?.retry_after_ms ?? a.retry);
        a.retry = Math.min(a.retry * 2, MAX_DELAY_MS);
      },
    );
  };

  /** A gap breaks the contract: never skip events, ask again from the last one, a few times. */
  const gap = (session_id: string, a: Attached) => {
    if (a.syncing > 0) {
      a.gapPending = true;
      return;
    }
    if (++a.gaps <= MAX_GAP_RETRIES) return reattach(session_id, a);
    end(
      session_id,
      a,
      new SessionProtocolError({
        code: -32012,
        message: `session ${session_id}: the runtime skipped events after cursor ${low(a)}`,
        data: { reason: "internal" },
      }),
    );
    void call("session.detach", { session_id }).catch(() => undefined);
  };

  /** While a handshake runs: its own calls by id, notifications it has not taken yet, and what it waits for. */
  let shaking: Shake | null = null;

  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  // Check the transport envelope before touching it. Keep event types open for newer
  // runtimes: an unknown event still occupies a cursor in the ordered stream.
  const isEvent = (value: unknown): value is SessionEvent =>
    record(value) &&
    typeof value.session_id === "string" &&
    Number.isSafeInteger(value.cursor) &&
    (value.cursor as number) >= 0 &&
    typeof value.at === "string" &&
    typeof value.type === "string" &&
    record(value.payload);

  const onMessage = (raw: string) => {
    // A malformed frame is dropped, never thrown into the socket's handler.
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!record(parsed) || parsed.jsonrpc !== "2.0") return;
    const msg = parsed as Record<string, any>;
    if (shaking) {
      const own = typeof msg.id === "number" && !("method" in msg) ? shaking.calls.get(msg.id) : undefined;
      if (own) {
        shaking.calls.delete(msg.id);
        return msg.error ? own.reject(new SessionProtocolError(msg.error)) : own.resolve(msg.result);
      }
      if (typeof msg.method === "string" && msg.id === undefined && msg.method !== "session.event" && msg.method !== "session.events") {
        const wait = shaking.waits.findIndex((w) => w.method === msg.method);
        if (wait >= 0) return shaking.waits.splice(wait, 1)[0]!.resolve(msg.params);
        shaking.early.push({ method: msg.method, params: msg.params });
      }
    }
    // A runtime that asks who this device is after the handshake stopped waiting (a slow laptop the device did not
    // know for one), or that turns a call away for it: drop the socket, keep the calls, and say hello on the next one.
    const late = options.handshake !== undefined && !shaking && unseal === undefined;
    if (late && msg.method === "device.challenge") return socket?.close();
    if (typeof msg.id === "number" && !("method" in msg)) {
      if ("error" in msg && (!record(msg.error) || typeof msg.error.code !== "number" || typeof msg.error.message !== "string")) return;
      if (!("error" in msg) && !("result" in msg)) return;
      if (msg.id === helloId) return heard(msg.error ? (msg.error.code === -32601 ? LEGACY_RUNTIME : undefined) : readHello(msg.result));
      const p = pending.get(msg.id);
      if (!p) {
        const onAnswer = overdue.get(msg.id);
        overdue.delete(msg.id);
        if (!msg.error) onAnswer?.(msg.result);
        return;
      }
      if (late && msg.error?.data?.reason === "device_not_approved") {
        clearTimeout(p.timer);
        return socket?.close();
      }
      const unauthorized = msg.error?.data?.reason === "unauthorized";
      if (unauthorized && typeof token !== "string" && !p.refreshed) {
        p.refreshed = true; // reconnect on a fresh token; the call is resent then
        clearTimeout(p.timer);
        socket?.close();
        return;
      }
      settle(msg.id, p);
      if (!msg.error) {
        p.onAnswer?.(msg.result);
        return p.resolve(msg.result as never);
      }
      const error = new SessionProtocolError(msg.error);
      if (unauthorized) onState?.("unauthorized", error);
      p.reject(error);
      return;
    }
    if (msg.method === "session.event" || msg.method === "session.events") {
      const events = msg.method === "session.event" ? [msg.params] : record(msg.params) ? msg.params.events : undefined;
      if (!Array.isArray(events) || !events.every(isEvent)) return;
      if (events.some((event) => event.session_id !== events[0]?.session_id)) return;
      const a = events[0] && attached.get(events[0].session_id);
      if (!a || streams.get(events[0]!.session_id) !== a) return; // not ours, or an attachment let go of
      let hole = false;
      for (const event of events) {
        for (const s of a.subs) {
          if (event.cursor <= s.cursor) continue; // already delivered
          if (event.cursor !== s.cursor + 1) {
            hole = true;
            continue;
          }
          s.cursor = event.cursor;
          a.gaps = 0;
          s.onEvent(event);
        }
      }
      if (hole) gap(events[0]!.session_id, a);
      return;
    }
    if (msg.method === "session.ended") {
      // The runtime ended an attachment itself. A rewritten journal re-attaches on the old epoch and gets `reset`;
      // any other reason ends the subscription with it.
      const { session_id, error } = msg.params as { session_id: string; error: RpcError };
      const a = attached.get(session_id);
      if (!a || streams.get(session_id) !== a) return;
      if ((error.data?.reason as string | undefined) !== "journal_reset") return end(session_id, a, new SessionProtocolError(error));
      a.gaps = 0;
      lapse(a);
      if (a.syncing === 0) reattach(session_id, a);
      else a.gapPending = true;
      return;
    }
    for (const handler of handlers.get(msg.method) ?? []) handler(msg.params as never);
  };

  /** The runtime's answer to this socket's runtime.hello (another refusal, such as an outside agent's gate, says nothing). */
  const heard = (answer: RuntimeHello | undefined) => {
    helloId = undefined;
    if (answer === undefined) return;
    hello = answer;
    for (const listener of [...helloListeners]) listener(answer);
  };

  const retry = () => {
    if (closed || refused) return;
    if (local && !everOpened && Date.now() - startedAt < START_WINDOW_MS) return void setTimeout(open, LOCAL_START_RETRY_MS);
    setTimeout(open, delay);
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  };

  const open = async () => {
    if (closed) return;
    onState?.("connecting");
    let bearer: string;
    try {
      bearer = typeof token === "string" ? token : await token();
    } catch (cause) {
      const error = new SessionProtocolError({
        code: -32006,
        message: `no token: ${cause instanceof Error ? cause.message : String(cause)}`,
        data: { reason: "unauthorized" },
      });
      onState?.("unauthorized", error);
      // Reads fail now. A mutating call waits for a token as it waits for a socket: it may have run, and it leaves the
      // outbox only once answered (or withdrawn after `unsentAfterMs`, to go another way). So does an attach, a first
      // one too: no runtime refused the chat, and the next socket that opens takes it out at once.
      for (const [id, p] of pending) {
        if (p.entry || p.method === "session.attach") continue;
        settle(id, p);
        p.reject(error);
      }
      return retry();
    }
    if (closed) return;
    // Tokens never ride in the URL: a header where the platform allows one,
    // otherwise a subprotocol beside the one the runtime selects.
    const ws = options.socket
      ? options.socket(target, bearer)
      : // globalThis.window, so Node-only consumers (the runtime) typecheck without the DOM lib.
        typeof (globalThis as { window?: unknown }).window === "undefined"
        ? new (WebSocket as unknown as NodeWebSocket)(target, { headers: { authorization: `Bearer ${bearer}` } })
        : new WebSocket(target, bearer ? [SUBPROTOCOL, BEARER_PROTOCOL + base64url(bearer)] : [SUBPROTOCOL]);
    socket = ws;
    let stable: ReturnType<typeof setTimeout> | undefined;
    let opening: ReturnType<typeof setTimeout> | undefined;
    let lost = false;
    let opened = false;
    // Node 22 fires only `error`, never `close`, when an attempt fails (refused
    // or a 401 upgrade), so either one ends this socket, once.
    const onLost = () => {
      if (lost) return;
      lost = true;
      ready = false;
      helloId = undefined;
      seal = undefined;
      unseal = undefined;
      unsealing = Promise.resolve();
      held = [];
      streams.clear();
      overdue.clear();
      if (shaking) {
        for (const c of shaking.calls.values()) c.reject(new Error("the connection closed"));
        shaking = null;
      }
      clearTimeout(stable);
      clearTimeout(opening);
      if (socket === ws) socket = undefined;
      ws.close();
      // Calls out on this socket wait for the next one; their deadlines start again when they are resent. One that may
      // go another way waits no longer than it would have to go out the first time, counted from the first socket lost.
      for (const p of pending.values()) {
        clearTimeout(p.timer);
        if (p.wentOut && p.unsentAfterMs !== undefined && p.unsent === undefined) p.unsent = setTimeout(() => withdraw(p), p.unsentAfterMs);
      }
      for (const a of attached.values()) {
        if (!a.live) continue;
        a.live = false;
        for (const s of a.subs) s.options.onState?.("reconnecting");
      }
      retry();
    };
    // A refused upgrade (no socket: a 401/404 answer, nothing listening) reaches onState as 1006.
    ws.onerror = () => {
      if (!lost && !opened) onState?.("closed", new ConnectionClosed(1006, "the connection was refused"));
      onLost();
    };
    ws.onclose = (event: CloseEvent) => {
      if (!lost && event.code >= 4000 && event.code < 5000) {
        onState?.(event.code === 4401 ? "unauthorized" : "closed", new ConnectionClosed(event.code, event.reason));
      }
      onLost();
    };
    opening = setTimeout(() => {
      connectTimeout = Math.min(connectTimeout * 2, MAX_CONNECT_TIMEOUT_MS);
      onLost();
    }, connectTimeout);
    const flush = () => {
      ready = true;
      // First on the socket, before the calls below. Never resent: the next socket asks again.
      helloId = nextId++;
      transmit(ws, JSON.stringify({ jsonrpc: "2.0", id: helloId, method: "runtime.hello", params: { client_version: options.clientVersion ?? "", protocol_revision: PROTOCOL_REVISION } }));
      // Before "open": a call made then goes out at once, and would go out again here.
      for (const [id, p] of pending) send(id, p);
      onState?.("open");
      // An attach still in `pending` was just resent; dedupe absorbs its overlap.
      for (const [session_id, a] of attached) if (a.syncing === 0) reattach(session_id, a);
      for (const sc of screencasts.values()) void call("browser.screencast", sc).catch(() => undefined);
    };
    ws.onopen = () => {
      if (lost) return;
      opened = true;
      everOpened = true;
      clearTimeout(opening);
      connectTimeout = CONNECT_TIMEOUT_MS;
      stable = setTimeout(() => (delay = MIN_DELAY_MS), STABLE_MS);
      const handshake = options.handshake;
      if (!handshake) return flush();
      const mine: Shake = { calls: new Map(), early: [], waits: [] };
      shaking = mine;
      const link: HandshakeLink = {
        call: (method, params) =>
          new Promise((resolve, reject) => {
            if (socket !== ws || lost) return reject(new Error("the connection closed"));
            const id = nextId++;
            mine.calls.set(id, { resolve, reject });
            ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
          }),
        next: (method, timeoutMs = 10_000) =>
          new Promise((resolve, reject) => {
            const early = mine.early.findIndex((n) => n.method === method);
            if (early >= 0) return resolve(mine.early.splice(early, 1)[0]!.params);
            const timer = setTimeout(() => reject(new Error(`the runtime sent no ${method}`)), timeoutMs);
            mine.waits.push({ method, resolve: (params) => (clearTimeout(timer), resolve(params)) });
          }),
      };
      handshake(link).then(
        (done) => {
          if (shaking === mine) shaking = null;
          if (socket !== ws || lost) return;
          seal = done?.seal;
          sealing = Promise.resolve();
          // Frames the runtime sealed before this resolved are read first, in order.
          const early = held;
          held = [];
          if (done?.open) {
            unseal = done.open;
            for (const frame of early) receive(ws, frame);
          } else if (early.length > 0) return ws.close();
          flush();
        },
        (cause: unknown) => {
          if (shaking === mine) shaking = null;
          if (socket !== ws || lost) return;
          if (cause instanceof HandshakeRefused) {
            // Nothing waiting will run: say so to every caller and subscriber, and stop trying.
            refused = cause;
            const error = new SessionProtocolError(cause.error);
            for (const [id, p] of pending) {
              settle(id, p);
              p.reject(error);
            }
            for (const [session_id, a] of attached) end(session_id, a, error);
            onState?.("closed", error);
            return onLost();
          }
          onState?.("unauthorized", cause instanceof Error ? cause : new Error(String(cause)));
          onLost();
        },
      );
    };
    ws.onmessage = (message) => receive(ws, String(message.data));
  };

  /** What the handshake made every later frame from the runtime go through, the frames on their way through, and the
   * sealed frames that came before the handshake finished. */
  let unseal: ((frame: string) => Promise<string | undefined>) | undefined;
  let unsealing: Promise<void> = Promise.resolve();
  let held: string[] = [];
  function receive(from: WebSocket, frame: string) {
    if (socket !== from) return;
    if (!unseal) {
      if (!frame.startsWith(SEALED_PREFIX)) return onMessage(frame);
      // Sealed before the handshake resolved: it waits for the key. Sealed with no handshake at all: not ours.
      if (shaking) return void held.push(frame);
      return from.close();
    }
    // Opened at once (each frame's sequence number is its place in arrival order), handed on after the frames before
    // it: in a burst each frame waits for one opening, not for every frame before it to open first (S14).
    const opened = frame.startsWith(SEALED_PREFIX) ? unseal(frame) : Promise.resolve(undefined);
    opened.catch(() => undefined);
    unsealing = unsealing.then(async () => {
      if (socket !== from) return;
      const text = await opened.catch(() => undefined);
      // A plain frame, or one that does not open at its place: the relay changed something. Drop the socket.
      if (text === undefined) return from.close();
      if (socket === from) onMessage(text);
    });
  }
  void open();

  return {
    call,
    async attach(session_id, from_cursor, onEvent, attachOptions) {
      const opts: AttachOptions = typeof attachOptions === "function" ? { onError: attachOptions } : (attachOptions ?? {});
      let a = attached.get(session_id);
      if (!a) {
        a = { subs: new Set(), epoch: undefined, syncing: 0, gapPending: false, gaps: 0, retry: MIN_DELAY_MS, live: false };
        attached.set(session_id, a);
      }
      const entry = a;
      const sub: Subscriber = { cursor: from_cursor, epoch: opts.epoch, onEvent, options: opts };
      // Events cached from another epoch than the one this chat is on now: drop them before anything is delivered.
      if (entry.epoch !== undefined && sub.epoch !== undefined && sub.epoch !== entry.epoch) reset(sub, entry.epoch);
      entry.subs.add(sub);
      try {
        const session = await sync(session_id, entry);
        return {
          session,
          cursor: () => sub.cursor,
          epoch: () => sub.epoch,
          // The session stays attached while another subscriber on this client wants it.
          detach: async () => {
            if (!entry.subs.delete(sub) || entry.subs.size > 0) return;
            if (attached.get(session_id) === entry) attached.delete(session_id);
            await call("session.detach", { session_id });
          },
        };
      } catch (error) {
        entry.subs.delete(sub);
        if (entry.subs.size === 0 && attached.get(session_id) === entry) {
          attached.delete(session_id);
          // As detach() does: an attachment the entry has, or one this attach still starts, would feed no one.
          void call("session.detach", { session_id }).catch(() => undefined);
        }
        // The others stay, and no retry of this attach will look for them: what it was to bring them is theirs now.
        else resume(session_id, entry);
        throw error;
      }
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set();
      handlers.set(name, set);
      set.add(handler as (params: never) => void);
      return () => set.delete(handler as (params: never) => void);
    },
    hello: () => hello,
    onHello(listener) {
      helloListeners.add(listener);
      return () => void helloListeners.delete(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      stopTaking?.();
      socket?.close();
      // Unanswered mutating calls stay in the outbox: the next client on it resends them. One that may go another way
      // (unsentAfterMs) leaves it instead, so it never also goes out later on a client its caller does not know of.
      for (const p of [...pending.values()]) {
        if (p.unsentAfterMs !== undefined) {
          withdraw(p);
          continue;
        }
        clearTimeout(p.timer);
        p.reject(new Error("client closed"));
      }
      pending.clear();
      onState?.("closed");
    },
  };
};
