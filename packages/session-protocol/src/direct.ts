// The direct path to a laptop's runtime (DESIGN S14). A device reaches a laptop through Caveman Cloud's relay; once
// that connection is open (and, on a laptop, its device allowed), this client asks the runtime over it for a WebRTC
// data channel, with STUN only (no TURN: the relay is the fallback), and runs a second Session Protocol connection
// over the channel. While the channel is up, calls and subscriptions go over it; when it drops, they go back to the
// relay, and it is tried again later and after a network change. The person sees one connection throughout:
//
// - Subscriptions move by cursor, make before break: the new path attaches from the last delivered event while the
//   old one still delivers, each event goes out once (the lower path's copy is dropped), and the old one detaches once
//   the new one answered. A dying direct path hands over before its subscribers would hear "reconnecting".
// - Calls in flight on a direct path that dies go again on the relay, in the order they were made, under the same
//   request id (the runtime answers a repeat with its first answer), and only as a resend would (ConnectOptions.resend),
//   as do those moving the other way. A mutating call never overtakes an earlier one still out on the slower relay;
//   one going direct waits in the durable outbox like any other, so a reload resends it.
// - A terminal, a command watch or a screencast lives on the connection that set it up: calls about it go there, through
//   a switch of paths, until it is let go of or that path goes ("open" then has the page set it up on the path left;
//   a browser screencast this client turns back on there itself, as a relay client does after a reconnect). A
//   terminal's output, which the runtime also sends every connection following its chat, counts only from there.
// - So does control of a screen (browser.control, computer.control; moving a page takes it): its input and page moves go
//   where it was taken, even past calls still out on the relay, since they run nowhere else. A take the runtime refused
//   points there too until it is let go of or that path goes: what follows is refused there as it would be anywhere.
// - A call moved off the relay is taken back from the relay's client, which would send it again once it reconnects.
// - Notifications every connection gets (workspace.changed, ...) arrive once, not once per path.
// - The relay connection stays open beside the channel: falling back costs one attach, not a reconnect.
//
// Signaling (direct.offer, direct.candidate) goes only over the relay connection, after its handshake (device
// approval), and the runtime runs the same handshake again on the channel. The channel's DTLS fingerprint comes from
// that signaling, so Caveman Cloud carries SDP and candidates and nothing else new.
import {
  CallNotSent,
  CallTimeout,
  connect,
  memoryOutbox,
  OUTBOX_MAX_AGE_MS,
  outboxAt,
  outboxKeeps,
  SessionProtocolError,
  type AttachOptions,
  type CallOptions,
  type Client,
  type ConnectionState,
  type ConnectOptions,
  type Outbox,
  type OutboxEntry,
  type Subscription,
  type SubscriptionState,
  type TokenSource,
} from "./client.ts";
import { DIRECT_CHANNEL_LABEL, DirectReader, directMessages, directPing } from "./directWire.ts";
import type { MethodName, NotificationName, Params, Result, Session, SessionEvent } from "./protocol.ts";

/** The parts of a W3C RTCPeerConnection this uses: a browser's or Electron's, or node-datachannel's polyfill in tests. */
export interface RtcPeer {
  createDataChannel(label: string, init: { ordered: boolean }): RtcChannel;
  createOffer(): Promise<{ readonly sdp?: string; readonly type: string }>;
  setLocalDescription(description: { readonly sdp?: string; readonly type: string }): Promise<void>;
  setRemoteDescription(description: { readonly sdp: string; readonly type: "answer" }): Promise<void>;
  addIceCandidate(candidate: { readonly candidate: string; readonly sdpMid: string }): Promise<void>;
  readonly localDescription: { readonly sdp: string } | null;
  readonly connectionState: string;
  readonly sctp?: { readonly maxMessageSize: number } | null;
  onicecandidate: ((event: { readonly candidate: { readonly candidate: string; readonly sdpMid?: string | null } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  close(): void;
}
export interface RtcChannel {
  readonly readyState: string;
  binaryType: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  send(data: string | Uint8Array): void;
  close(): void;
}
export type RtcPeerConstructor = new (config: { iceServers: Array<{ urls: string | Array<string> }> }) => RtcPeer;
export type IceServers = ReadonlyArray<{ readonly urls: string | ReadonlyArray<string> }>;

/** Which way a runtime's traffic goes from this device now. */
export type DirectPath = "relay" | "direct";

export interface DirectOptions {
  /** Whether to try a direct path now (a laptop's runtime; Cloud computers never offer one). Asked before each try. */
  readonly enabled?: () => boolean;
  /** Default: the platform's RTCPeerConnection. None: relay only. */
  readonly rtc?: RtcPeerConstructor;
  /**
   * STUN servers, or where to read them before each try (the install's list, S14). Default: Google's public one. []
   * keeps it to this network (host candidates only). The offer passes them on, so the laptop uses the same.
   */
  readonly iceServers?: IceServers | (() => IceServers);
  /** The path changed (the pool's state, the developer overlay). */
  readonly onPath?: (path: DirectPath) => void;
  /**
   * Calls `changed` when the network may have changed (a new address, back online, the page shown again), and returns
   * a function that stops. Default: the window's online, offline and visibility events and navigator.connection.
   */
  readonly network?: (changed: (online: boolean) => void) => () => void;
  /** An attempt that has not opened (ICE, DTLS, the channel's handshake) by then is dropped. Default 10 s. */
  readonly openTimeoutMs?: number;
  /** Wait before the next attempt after `failures` failed ones in a row. Default 1 s, 5 s, 15 s, 1 min, then 5 min. */
  readonly retryMs?: (failures: number) => number;
  /** A channel silent this long (no frame, no pong) is dead. Default 6 s; pings go every third of it. */
  readonly silenceMs?: number;
}

export interface DirectClient extends Client {
  path(): DirectPath;
  /** The direct path's round trips (pings), newest last, at most 64; [] while on the relay. */
  directRtts(): ReadonlyArray<number>;
}

export const DEFAULT_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }] as const;
const OPEN_TIMEOUT_MS = 10_000;
const SILENCE_MS = 6_000;
const SIGNAL_TIMEOUT_MS = 10_000;
const RETRY_MS = [1_000, 5_000, 15_000, 60_000];
const RETRY_MAX_MS = 5 * 60_000;
/** Identical broadcast notifications from the two paths this close together are one. */
const DUPLICATE_WINDOW_MS = 3_000;
/** Notifications about something this connection opened (a terminal, a watch, a screencast): only its own path sends them. */
const CONNECTION_SCOPED = new Set<string>([
  "term.output",
  "term.exit",
  "term.resync",
  "tool.live",
  "suggestion.live",
  "browser.frame",
  "browser.state",
  "browser.pointer",
  "computer.frame",
  "computer.state",
  "computer.pointer",
  "chief.voice.send",
]);

/** A terminal's notifications: the runtime sends them to its openers and to every connection on its workspace's chat. */
const TERMINAL_NOTIFICATIONS = new Set<string>(["term.output", "term.exit", "term.resync"]);

const terminalKey = (terminal_id: string) => `term\0${terminal_id}`;
/**
 * What a call sets up, lets go of or acts through on the connection that carries it (the runtime keeps a terminal's
 * openers, a command's watchers, a screencast and who drives a screen per connection): its key, and whether the call
 * holds it (true), lets go of it (false) or only acts through it (undefined).
 */
const scopeOf = (method: MethodName, params: unknown): { readonly key: string; readonly holds?: boolean } | undefined => {
  const p = params as { terminal_id?: string; workspace_id?: string; item_id?: string; enabled?: boolean; controller?: string };
  switch (method) {
    case "term.attach":
    case "term.detach":
      return { key: terminalKey(p.terminal_id ?? ""), holds: method === "term.attach" };
    case "tool.watch":
    case "tool.unwatch":
      return { key: `tool\0${p.workspace_id}\0${p.item_id}`, holds: method === "tool.watch" };
    case "suggestion.watch":
    case "suggestion.unwatch":
      return { key: `suggestion\0${p.workspace_id}`, holds: method === "suggestion.watch" };
    case "browser.screencast":
    case "computer.screencast":
      return { key: `${method}\0${p.workspace_id}`, holds: p.enabled === true };
    case "browser.control":
    case "computer.control":
      return { key: `${method}\0${p.workspace_id}`, holds: p.controller === "user" };
    // Moving the page takes control of it, as the person acting.
    case "browser.navigate":
    case "browser.history":
      return { key: `browser.control\0${p.workspace_id}`, holds: true };
    case "browser.input":
    case "computer.input":
      return { key: `${method === "browser.input" ? "browser" : "computer"}.control\0${p.workspace_id}` };
    default:
      return undefined;
  }
};

const isMutatingParams = (params: unknown): params is { request_id: string } =>
  typeof params === "object" && params !== null && typeof (params as { request_id?: unknown }).request_id === "string";

const randomId = () => {
  const bytes = new Uint8Array(12);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
};

/** The window's own signals that the network may have changed. */
const windowNetwork = (changed: (online: boolean) => void): (() => void) => {
  const w = globalThis as unknown as {
    addEventListener?: (name: string, listener: () => void) => void;
    removeEventListener?: (name: string, listener: () => void) => void;
    document?: { visibilityState?: string; addEventListener(name: string, listener: () => void): void; removeEventListener(name: string, listener: () => void): void };
    navigator?: { onLine?: boolean; connection?: { addEventListener?(name: string, listener: () => void): void; removeEventListener?(name: string, listener: () => void): void } };
  };
  if (!w.addEventListener || !w.removeEventListener) return () => undefined;
  const online = () => changed(true);
  const offline = () => changed(false);
  const shown = () => w.document?.visibilityState === "visible" && changed(w.navigator?.onLine !== false);
  const connection = w.navigator?.connection;
  w.addEventListener("online", online);
  w.addEventListener("offline", offline);
  w.document?.addEventListener("visibilitychange", shown);
  connection?.addEventListener?.("change", online);
  return () => {
    w.removeEventListener?.("online", online);
    w.removeEventListener?.("offline", offline);
    w.document?.removeEventListener("visibilitychange", shown);
    connection?.removeEventListener?.("change", online);
  };
};

/** One try at a direct path, from the offer until it closes. */
interface Link {
  readonly id: string;
  readonly pc: RtcPeer;
  readonly channel: RtcChannel;
  client: Client | null;
  /** The channel passed its handshake: calls and subscriptions may use it. */
  ready: boolean;
  closed: boolean;
  answered: boolean;
  /** Our candidates before the runtime answered the offer; its candidates before its answer was applied. */
  readonly ours: Array<{ id: string; candidate: string; mid?: string }>;
  readonly theirs: Array<{ candidate: string; mid?: string }>;
  heardAt: number;
  readonly rtts: number[];
  timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>;
}

/** One call made on this client, until it settles. */
interface Call {
  readonly method: MethodName;
  readonly params: unknown;
  readonly options: CallOptions | undefined;
  readonly mutating: boolean;
  readonly resolve: (result: never) => void;
  readonly reject: (error: Error) => void;
  /** The link it went out on; null: the relay. */
  via: Link | null;
  /** Handed to a path (a mutating call waits its turn in the lane first). */
  sent: boolean;
  /** It went out on a socket, on either path: it may have run. */
  wentOut: boolean;
  /** Date.now() when it was made (its outbox entry's `at`). */
  readonly at: number;
  done: boolean;
  /** Takes back its copy on the relay's client: the channel carries it now, or its caller took it back. */
  relayCopy?: AbortController;
  /** Stops listening for its caller's take-back of that copy: once the copy is taken back, or the call is over. */
  unlisten?: () => void;
}

/** One subscriber's attachment on one path. */
interface Leg {
  readonly via: Link | null;
  sub: Subscription | null;
  /** The journal epoch of what this leg delivers (its runtime's answer, or its last reset). */
  epoch: number | undefined;
  live: boolean;
  gone: boolean;
}

/** A subscriber of this client: the cursor it was delivered through, and its legs (two only while switching). */
interface Sub {
  readonly session_id: string;
  readonly onEvent: (event: SessionEvent) => void;
  readonly options: AttachOptions;
  cursor: number;
  epoch: number | undefined;
  legs: Set<Leg>;
  leader: Leg | null;
  state: SubscriptionState | undefined;
  ended: boolean;
  session: Session | undefined;
  readonly first: { resolve: (session: Session) => void; reject: (error: unknown) => void; settled: boolean };
}

/**
 * A Session Protocol client that reaches its runtime through `url` (Caveman Cloud's relay) and, where the runtime
 * offers one, over a direct WebRTC data channel too (see the top of this file). Same arguments as `connect`.
 */
export function connectDirect(
  url: string,
  token: TokenSource,
  onState?: (state: ConnectionState, error?: Error) => void,
  options: ConnectOptions & { readonly direct?: DirectOptions } = {},
): DirectClient {
  const { direct: config = {}, ...relayOptions } = options;
  // The channel's client keeps no outbox (this client does) and restores nothing; it shares the handshake.
  const { outbox: _outbox, onRestored: _onRestored, socket: _socket, ...channelOptions } = relayOptions;
  const outbox = relayOptions.outbox ?? memoryOutbox();
  const Rtc = config.rtc ?? (globalThis as { RTCPeerConnection?: RtcPeerConstructor }).RTCPeerConnection;
  const iceServers = () => {
    const given = typeof config.iceServers === "function" ? config.iceServers() : (config.iceServers ?? DEFAULT_ICE_SERVERS);
    return given.map((s) => ({ urls: typeof s.urls === "string" ? s.urls : [...s.urls] }));
  };
  const openTimeoutMs = config.openTimeoutMs ?? OPEN_TIMEOUT_MS;
  const silenceMs = config.silenceMs ?? SILENCE_MS;
  const retryMs = config.retryMs ?? ((failures: number) => RETRY_MS[failures - 1] ?? RETRY_MAX_MS);

  let closed = false;
  let relayState: ConnectionState = "connecting";
  let link: Link | null = null;
  /** The runtime said it offers no direct path; asked again once the relay reconnects. */
  let refused = false;
  let failures = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let offline = false;
  let reportedOpen = false;
  /** A call went over this relay connection (a terminal or a watch may live on it). */
  let relayUsed = false;
  let path: DirectPath = "relay";
  const calls = new Set<Call>();
  /** The path each terminal, watch and screencast this client set up is on (null: the relay), until it is let go of. */
  const holders = new Map<string, Link | null>();
  /** Browser screencasts on through this client, by their `holders` key, until turned off. */
  const screencasts = new Map<string, Params<"browser.screencast">>();
  const subs = new Set<Sub>();
  const handlers = new Map<string, Set<(params: never) => void>>();
  /** Recent broadcast notifications, to drop the second copy from the other path. */
  const recent = new Map<string, { at: number; from: Link | null }>();

  const ready = () => (link?.ready === true ? link : null);

  // Calls an earlier page left in the outbox: the relay client resends them; until each is answered it counts as out
  // on the relay (no newer mutating call may overtake it on the channel), and it moves to the channel if the relay goes.
  // On the outbox's clock (outboxAt): every entry made before this client is older, every one made by it newer.
  const startedAt = outboxAt();
  const restored = new Map<string, { readonly entry: OutboxEntry; via: Link | null }>();
  const reported = new Set<string>();
  const reportRestored = (entry: OutboxEntry, outcome: { readonly result: unknown } | { readonly error: Error }) => {
    if (reported.has(entry.request_id)) return;
    reported.add(entry.request_id);
    restored.delete(entry.request_id);
    relayOptions.onRestored?.(entry, outcome);
  };
  const restoredKnown = outbox.load().then(
    (entries) => {
      for (const entry of entries) {
        // One outboxKeeps refuses (left by a version from before it) is never resent: the relay client deletes and
        // reports it, if its own read of the outbox finds it.
        if (entry.at >= startedAt || Date.now() - entry.at > OUTBOX_MAX_AGE_MS || reported.has(entry.request_id) || !outboxKeeps(entry.method)) continue;
        restored.set(entry.request_id, { entry, via: null });
      }
    },
    () => undefined,
  );
  // Those the outbox takes over later (a page that has gone since held them): the relay client resends them too. As at
  // load, one outboxKeeps refuses or too old to send again is the relay client's to delete and report, never the
  // channel's to carry, however long the relay client takes to read it.
  const stopTaking = outbox.taken?.((entries) => {
    if (closed) return false;
    for (const entry of entries) {
      if (reported.has(entry.request_id) || Date.now() - entry.at > OUTBOX_MAX_AGE_MS || !outboxKeeps(entry.method)) continue;
      restored.set(entry.request_id, { entry, via: null });
    }
    return true;
  });

  // ------------------------------------------------------------------ the connection's state as one
  const emit = (state: ConnectionState, error?: Error) => {
    reportedOpen = state === "open";
    onState?.(state, error);
  };
  /**
   * A path went away: connection-scoped subscriptions on it (terminals, watches) are gone, so "open" again tells the
   * surfaces to set them up on the path left; with none left, the relay's own state.
   */
  const reopened = () => {
    if (closed) return;
    emit(relayState === "open" || ready() ? "open" : relayState);
  };
  /** What was set up on `via`'s connection went with it: set up again, it goes on the path calls take now. */
  const forget = (via: Link | null) => {
    for (const [key, holder] of holders) if (holder === via) holders.delete(key);
  };
  /**
   * A browser screencast whose path went comes back on, on the path calls take, once one is up: as a relay client turns
   * its own back on after a reconnect (this one's relay client does not, see below). A page that hears "open" may turn
   * it on too, and that goes to the same connection, which keeps one screencast per screen; a pooled client's page
   * never hears its "open".
   */
  const restoreScreencasts = () => {
    if (closed || (relayState !== "open" && !ready())) return;
    for (const [key, sc] of screencasts) if (!holders.has(key)) void call("browser.screencast", sc).catch(() => undefined);
  };

  // The relay's client lets go of a call's entry as it takes its copy back, while the channel may carry that call still:
  // the entry of a call this client has not settled is this client's to delete. The rest is the page's outbox as it is
  // (every member, so one the Outbox gains is not left out): the relay client sends what the outbox takes over from a
  // page that has gone, and holds back, kept under the page's name, every call once the page lost its lock.
  const relayOutbox: Required<Outbox> = {
    load: () => outbox.load(),
    taken: (listener) => outbox.taken?.(listener) ?? (() => undefined),
    ours: () => outbox.ours?.() !== false,
    put: (entry) => outbox.put(entry),
    delete: (request_id) =>
      [...calls].some((c) => c.mutating && (c.params as { request_id: string }).request_id === request_id) ? Promise.resolve() : outbox.delete(request_id),
  };
  const relay = connect(
    url,
    token,
    (state, error) => {
      const was = relayState;
      relayState = state;
      if (state === "open") {
        refused = false;
        relayUsed = false;
        restoreScreencasts();
        if (!ready() || !reportedOpen) emit("open");
        tryDirect();
        return;
      }
      // What was set up on the relay's connection went with it, channel or not: set up again on "open" (the relay's own,
      // or a channel's that opens first), it goes on the path calls take then.
      if (was === "open") forget(null);
      const direct = ready();
      if (!direct) return emit(state, error);
      // The relay went while the channel carries everything: what was out on it goes again on the channel. A relay that
      // came and went with no call on it (a flapping one) had nothing set up.
      if (was === "open") {
        for (const sub of subs) if (sub.leader?.via === null) openLeg(sub, direct);
        toChannel(direct);
        restoreScreencasts();
        if (relayUsed) reopened();
      }
    },
    // A screencast the relay turned back on by itself would stream beside the one restoreScreencasts puts on the
    // channel, and no stop would reach it.
    { ...relayOptions, outbox: relayOutbox, onRestored: reportRestored, restoreScreencasts: false },
  );

  const setPath = (next: DirectPath) => {
    if (next === path) return;
    path = next;
    config.onPath?.(next);
  };

  // ------------------------------------------------------------------ calls
  /** Mutating calls are handed out in the order made, each once the one before it is out (after the restored ones). */
  let lane: Promise<unknown> = restoredKnown;
  const relayMutating = () => {
    let n = 0;
    for (const c of calls) if (c.mutating && c.sent && c.via === null && !c.done) n++;
    for (const r of restored.values()) if (r.via === null || r.via.closed) n++;
    return n;
  };

  const settle = (c: Call, outcome: { result: unknown } | { error: unknown }) => {
    if (c.done) return;
    c.done = true;
    c.unlisten?.();
    calls.delete(c);
    if (c.mutating) void outbox.delete((c.params as { request_id: string }).request_id).catch(() => undefined);
    if ("result" in outcome) c.resolve(outcome.result as never);
    else c.reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
  };

  const entryOf = (c: Call): OutboxEntry => ({
    request_id: (c.params as { request_id: string }).request_id,
    method: c.method,
    params: c.params,
    at: c.at,
    ...(c.options?.epoch !== undefined ? { epoch: c.options.epoch } : {}),
  });

  /**
   * Sends `c` on `via` (null: the relay); an answer counts only from the path it last went out on. One that went out on
   * the other path may have run: this one sends it again only as a resend would (`resend`), never as a new call.
   */
  const issue = (c: Call, via: Link | null) => {
    // Its outbox no longer answers for it (the page lost its Web Lock): it waits until the page loads anew. A call bound
    // for the channel is held back here (one already in the channel client's lane is held back there), and so is one
    // the channel had when it dies: the outbox keeps it where it was made, and the next page sends it from there. The
    // relay client puts every call first made on the relay under the page's name for the next page, and sends none of
    // them itself.
    if (c.mutating && (via !== null || c.sent) && outbox.ours?.() === false) return;
    c.via = via;
    c.sent = true;
    if (via === null) relayUsed = true;
    const scope = scopeOf(c.method, c.params);
    if (scope?.holds) holders.set(scope.key, via);
    else if (scope?.holds === false) holders.delete(scope.key);
    const client = via?.client ?? relay;
    const onSent = () => {
      if (c.wentOut) return;
      c.wentOut = true;
      c.options?.onSent?.();
    };
    const signal = via === null ? relayCopy(c) : c.options?.signal;
    // Its outbox entry keeps the time it was made (the outbox lists calls by it), never the time of a hand-over.
    client.call(c.method, c.params as never, { ...c.options, onSent, madeAt: c.at, ...(signal ? { signal } : {}), ...(c.wentOut ? { wentOut: { at: c.at } } : {}) }).then(
      (result) => {
        if (c.via !== via) return;
        // A terminal streams to the connection that opened it: attaching to it and letting go of it go there too.
        if (c.method === "term.open") holders.set(terminalKey((result as Result<"term.open">).terminal_id), via);
        settle(c, { result });
      },
      (error: unknown) => {
        if (c.via !== via) return;
        // Cut off with its channel (the runtime's own answers and deadlines are real): the hand-over resends it.
        if (via !== null && via.closed && !(error instanceof SessionProtocolError) && !(error instanceof CallTimeout)) return;
        settle(c, { error });
      },
    );
  };

  /**
   * What takes back `c`'s copy on the relay's client: this client once the channel carries it, or its caller, whose
   * signal is listened to only while that copy is out and the call is not over.
   */
  const relayCopy = (c: Call) => {
    c.unlisten?.();
    const back = new AbortController();
    c.relayCopy = back;
    const theirs = c.options?.signal;
    if (theirs?.aborted) back.abort();
    else if (theirs) {
      const abort = () => back.abort();
      theirs.addEventListener("abort", abort, { once: true });
      c.unlisten = () => theirs.removeEventListener("abort", abort);
    }
    return back.signal;
  };

  /**
   * The relay is down while `l` carries traffic: every call still out on the relay (restored ones first, then the rest
   * in the order made) goes again on the channel under its request id; the runtime answers a repeat once.
   */
  const toChannel = (l: Link) => {
    const client = l.client;
    if (!client || l.closed || outbox.ours?.() === false) return;
    for (const r of restored.values()) {
      if (r.via !== null && !r.via.closed) continue;
      r.via = l;
      const { entry } = r;
      // An earlier page may have sent it: it goes out again only as a resend would.
      client.call(entry.method, entry.params as never, { wentOut: { at: entry.at }, ...(entry.epoch !== undefined ? { epoch: entry.epoch } : {}) }).then(
        (result) => {
          void outbox.delete(entry.request_id).catch(() => undefined);
          reportRestored(entry, { result });
        },
        (error: unknown) => {
          if (!(error instanceof SessionProtocolError) && !(error instanceof CallNotSent)) return; // cut off: the relay resends it when it is back
          void outbox.delete(entry.request_id).catch(() => undefined);
          reportRestored(entry, { error });
        },
      );
    }
    for (const c of calls) {
      if (!c.sent || c.done || c.via !== null) continue;
      c.relayCopy?.abort();
      c.unlisten?.();
      // The relay's client writes a send's entry only once the sends before it are written: one taken back while it
      // waited has none. Written again before it goes out here, it lands before the delete its answer makes.
      if (c.mutating && outboxKeeps(c.method)) void outbox.put(entryOf(c)).catch(() => undefined);
      issue(c, l);
    }
  };

  const call = <M extends MethodName>(method: M, params: Params<M>, callOptions?: CallOptions): Promise<Result<M>> =>
    new Promise<Result<M>>((resolve, reject) => {
      if (closed) return reject(new Error("client closed"));
      const c: Call = { method, params, options: callOptions, mutating: isMutatingParams(params), resolve: resolve as (r: never) => void, reject, via: null, sent: false, wentOut: false, at: outboxAt(), done: false };
      calls.add(c);
      if (!c.mutating) {
        // A terminal, watch or screencast is followed and let go of on the connection that set it up, which a switch of
        // paths leaves where it is; anything else takes the path calls take now.
        const scope = scopeOf(method, params);
        if (method === "browser.screencast" && scope) {
          const sc = params as Params<"browser.screencast">;
          if (sc.enabled) screencasts.set(scope.key, sc);
          else screencasts.delete(scope.key);
        }
        return issue(c, scope && holders.has(scope.key) ? (holders.get(scope.key) as Link | null) : ready());
      }
      lane = lane.then(async () => {
        if (c.done) return;
        if (closed) return settle(c, { error: new Error("client closed") });
        // A screen is driven over the connection that took control of it. Anything else never goes ahead of an earlier
        // mutating call still out on the relay: the channel would deliver it first.
        const scope = scopeOf(method, params);
        const direct = scope && holders.has(scope.key) ? (holders.get(scope.key) as Link | null) : relayMutating() === 0 ? ready() : null;
        if (!direct) return issue(c, null);
        if (outboxKeeps(c.method)) await outbox.put(entryOf(c)).catch(() => undefined);
        if (c.done) return;
        if (closed) return settle(c, { error: new Error("client closed") });
        // The channel may have gone while the outbox wrote.
        issue(c, direct.closed ? null : direct);
      });
    });

  // ------------------------------------------------------------------ subscriptions
  const subState = (sub: Sub, state: SubscriptionState) => {
    if (sub.ended || sub.state === state) return;
    sub.state = state;
    sub.options.onState?.(state);
  };

  const closeLeg = (sub: Sub, leg: Leg) => {
    if (leg.gone) return;
    leg.gone = true;
    sub.legs.delete(leg);
    if (sub.leader === leg) sub.leader = null;
    void leg.sub?.detach().catch(() => undefined);
  };

  const endSub = (sub: Sub, error: SessionProtocolError) => {
    if (sub.ended) return;
    for (const leg of [...sub.legs]) closeLeg(sub, leg);
    sub.ended = true;
    subs.delete(sub);
    if (!sub.first.settled) {
      sub.first.settled = true;
      sub.first.reject(error);
    } else sub.options.onError?.(error);
  };

  /** Attaches `sub` on `via` from what it has, and makes that the path it follows; the others go once this answers. */
  const openLeg = (sub: Sub, via: Link | null) => {
    if (sub.ended) return;
    const leg: Leg = { via, sub: null, epoch: sub.epoch, live: false, gone: false };
    sub.legs.add(leg);
    sub.leader = leg;
    const client = via?.client ?? relay;
    client
      .attach(sub.session_id, sub.cursor, (event) => deliver(sub, leg, event), {
        ...(sub.epoch !== undefined ? { epoch: sub.epoch } : {}),
        onReset: (epoch) => {
          leg.epoch = epoch;
          // Only the path being followed rewrites what was delivered; another catches up by epoch and cursor.
          if (sub.leader !== leg || sub.ended) return;
          sub.cursor = 0;
          sub.epoch = epoch;
          sub.options.onReset?.(epoch);
        },
        onState: (state) => {
          leg.live = state === "live";
          if (sub.leader === leg) subState(sub, state);
        },
        onError: (error) => {
          if (leg.gone || sub.ended) return;
          if (sub.leader === leg) return endSub(sub, error);
          closeLeg(sub, leg);
        },
      })
      .then(
        (subscription) => {
          leg.sub = subscription;
          if (leg.gone || sub.ended) return void subscription.detach().catch(() => undefined);
          leg.epoch = subscription.epoch?.() ?? leg.epoch;
          if (sub.epoch === undefined) sub.epoch = leg.epoch;
          leg.live = true;
          sub.session = subscription.session;
          if (!sub.first.settled) {
            sub.first.settled = true;
            sub.first.resolve(subscription.session);
          }
          if (sub.leader !== leg) return;
          subState(sub, "live");
          // This path answered and follows: the one it replaces lets go.
          for (const other of [...sub.legs]) if (other !== leg) closeLeg(sub, other);
        },
        (error: unknown) => {
          if (leg.gone || sub.ended) return;
          // A channel that went before it answered: the hand-over already attached on the relay.
          if (via !== null && via.closed && !(error instanceof SessionProtocolError)) return closeLeg(sub, leg);
          if (sub.leader !== leg) return closeLeg(sub, leg);
          endSub(sub, error instanceof SessionProtocolError ? error : new SessionProtocolError({ code: -32603, message: error instanceof Error ? error.message : String(error), data: { reason: "internal" } }));
        },
      );
  };

  /** One event from one leg: delivered when it is the next one, of the epoch being shown; a copy or another epoch's is dropped. */
  const deliver = (sub: Sub, leg: Leg, event: SessionEvent) => {
    if (leg.gone || sub.ended) return;
    if (leg.epoch !== undefined && sub.epoch !== undefined && leg.epoch !== sub.epoch) return;
    if (event.cursor !== sub.cursor + 1) return;
    sub.cursor = event.cursor;
    sub.onEvent(event);
  };

  const attach = async (
    session_id: string,
    from_cursor: number,
    onEvent: (event: SessionEvent) => void,
    attachOptions?: ((error: SessionProtocolError) => void) | AttachOptions,
  ): Promise<Subscription> => {
    if (closed) throw new Error("client closed");
    const opts: AttachOptions = typeof attachOptions === "function" ? { onError: attachOptions } : (attachOptions ?? {});
    let first!: Sub["first"];
    const session = new Promise<Session>((resolve, reject) => (first = { resolve, reject, settled: false }));
    const sub: Sub = { session_id, onEvent, options: opts, cursor: from_cursor, epoch: opts.epoch, legs: new Set(), leader: null, state: undefined, ended: false, session: undefined, first };
    subs.add(sub);
    openLeg(sub, ready());
    const answered = await session;
    return {
      session: answered,
      cursor: () => sub.cursor,
      epoch: () => sub.epoch,
      detach: async () => {
        if (sub.ended) return;
        sub.ended = true;
        subs.delete(sub);
        const legs = [...sub.legs];
        for (const leg of legs) {
          leg.gone = true;
          sub.legs.delete(leg);
        }
        await Promise.all(legs.map((leg) => leg.sub?.detach().catch(() => undefined)));
      },
    };
  };

  // ------------------------------------------------------------------ notifications
  const forward = (from: Link | null) => (name: string) => (params: unknown) => {
    if (closed || (from !== null && from.closed)) return;
    // A terminal held on one path prints on the other too once the chat it belongs to follows that one: only the
    // holder's copy counts.
    if (TERMINAL_NOTIFICATIONS.has(name)) {
      const key = terminalKey((params as { terminal_id: string }).terminal_id);
      if (holders.has(key) && holders.get(key) !== from) return;
    }
    // Two paths up: a notification every connection gets arrives twice; the second copy is dropped.
    if (!CONNECTION_SCOPED.has(name) && relayState === "open" && ready()) {
      const now = Date.now();
      const key = `${name}\0${JSON.stringify(params)}`;
      const seen = recent.get(key);
      for (const [k, v] of recent) if (now - v.at > DUPLICATE_WINDOW_MS) recent.delete(k);
      if (seen && seen.from !== from && now - seen.at <= DUPLICATE_WINDOW_MS) {
        recent.delete(key);
        return;
      }
      recent.set(key, { at: now, from });
    }
    for (const handler of handlers.get(name) ?? []) handler(params as never);
  };
  const forwardRelay = forward(null);
  const relayOffs = new Map<string, () => void>();
  const listen = (client: Client, name: string, through: (name: string) => (params: unknown) => void) =>
    client.on(name as Exclude<NotificationName, "session.event" | "session.events">, through(name) as never);

  // ------------------------------------------------------------------ the direct path
  const later = () => {
    if (closed || refused) return;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(tryDirect, retryMs(Math.max(1, failures)));
  };

  /** Ends `l`; when it carried traffic, everything on it goes back to the relay first. */
  const drop = (l: Link, retry: boolean) => {
    if (l.closed) return;
    l.closed = true;
    const carried = l.ready;
    l.ready = false;
    for (const t of l.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    if (link === l) link = null;
    if (carried) {
      forget(l);
      for (const sub of subs) {
        if (sub.leader?.via === l) openLeg(sub, null);
        for (const leg of [...sub.legs]) if (leg.via === l) closeLeg(sub, leg);
      }
      // In the order they were made, before anything newer reaches the relay. One that went out on the channel may have
      // run: the relay sends it only as a resend would, and one it cannot carry in time leaves as unanswered.
      for (const c of calls) if (c.via === l && !c.done) issue(c, null);
      setPath("relay");
      restoreScreencasts();
      reopened();
    }
    l.client?.close();
    try {
      l.channel.close();
    } catch {
      // Already closed.
    }
    try {
      l.pc.close();
    } catch {
      // Already closed.
    }
    if (!retry) return;
    failures = carried ? 1 : failures + 1;
    later();
  };

  const promote = (l: Link) => {
    if (l.closed || l.ready || closed) return;
    l.ready = true;
    failures = 0;
    for (const t of l.timers) clearTimeout(t as ReturnType<typeof setTimeout>);
    l.timers = [];
    l.heardAt = Date.now();
    // Liveness: a ping when the channel has been quiet a third of the silence allowed; dead past it. A tick that came
    // late (a hidden tab's throttled timers) judges nothing: it pings and waits a whole window again.
    const every = Math.max(50, Math.floor(silenceMs / 3));
    let lastTick = Date.now();
    const pinger = setInterval(() => {
      if (l.closed) return;
      const now = Date.now();
      const late = now - lastTick > 2 * every;
      lastTick = now;
      if (late) l.heardAt = Math.max(l.heardAt, now - every);
      const quiet = now - l.heardAt;
      if (quiet > silenceMs) return drop(l, true);
      if (quiet >= every) {
        try {
          l.channel.send(directPing(performance.now()));
        } catch {
          drop(l, true);
        }
      }
    }, every);
    l.timers.push(pinger);
    const client = l.client!;
    for (const name of handlers.keys()) listen(client, name, forward(l));
    for (const sub of subs) if (!sub.ended) openLeg(sub, l);
    // A relay that is down holds calls the channel can carry now.
    if (relayState !== "open") toChannel(l);
    restoreScreencasts();
    setPath("direct");
    if (!reportedOpen) emit("open");
  };

  /** The channel as the WebSocket the channel's client expects. */
  const channelSocket = (l: Link): WebSocket => {
    const reader = new DirectReader();
    const max = () => l.pc.sctp?.maxMessageSize || undefined;
    let open = true;
    const socket = {
      readyState: 0,
      onopen: null as null | (() => void),
      onmessage: null as null | ((event: { data: string }) => void),
      onerror: null as null | (() => void),
      onclose: null as null | ((event: { code: number; reason: string }) => void),
      send(text: string) {
        if (!open) return;
        try {
          for (const message of directMessages(text, max())) l.channel.send(message);
        } catch {
          drop(l, true);
        }
      },
      close() {
        if (!open) return;
        open = false;
        socket.readyState = 3;
      },
    };
    /** Frames that came before the client heard "open" (the runtime's device challenge comes first): kept for it. */
    const early: string[] = [];
    l.channel.onmessage = (event) => {
      l.heardAt = Date.now();
      let input;
      try {
        input = reader.read(event.data as string | ArrayBuffer);
      } catch {
        return drop(l, true);
      }
      if (input.kind === "frame") {
        if (socket.readyState === 1) socket.onmessage?.({ data: input.text });
        else early.push(input.text);
      } else if (input.kind === "ping") l.channel.send(input.reply);
      else if (input.kind === "pong") {
        l.rtts.push(performance.now() - input.stamp);
        if (l.rtts.length > 64) l.rtts.shift();
      }
    };
    const lost = () => {
      // Hand over first, so subscribers never hear "reconnecting" from a path nobody follows any more.
      drop(l, true);
      if (!open) return;
      open = false;
      socket.readyState = 3;
      socket.onclose?.({ code: 1006, reason: "the direct channel closed" });
    };
    l.channel.onclose = lost;
    l.channel.onerror = lost;
    // The channel is open already: say so once the client has set its handlers.
    queueMicrotask(() => {
      if (!open) return;
      socket.readyState = 1;
      socket.onopen?.();
      for (const text of early.splice(0)) if (open) socket.onmessage?.({ data: text });
    });
    return socket as unknown as WebSocket;
  };

  /** What the channel's client gets if it tries to reconnect: the channel does not come back; a new attempt does. */
  const deadSocket = (): WebSocket => {
    const socket = { readyState: 3, onopen: null, onmessage: null, onclose: null, onerror: null as null | (() => void), send() {}, close() {} };
    setTimeout(() => socket.onerror?.(), 0);
    return socket as unknown as WebSocket;
  };

  const channelOpened = (l: Link) => {
    if (l.closed || closed) return;
    let used = false;
    l.client = connect(
      url,
      "",
      (state) => {
        if (l.closed) return;
        if (state === "open") return promote(l);
        // Refused on the channel (its handshake), or gone after it worked.
        if (l.ready || state === "unauthorized" || state === "closed") drop(l, true);
      },
      // Its outbox answers as the page's does: a call already in its lane when the page loses its lock is held back
      // there (client.ts), as issue holds back a new one, so a lost page sends nothing on the channel either.
      {
        ...channelOptions,
        outbox: { ...memoryOutbox(), ours: () => outbox.ours?.() !== false },
        socket: () => (used ? deadSocket() : ((used = true), channelSocket(l))),
      },
    );
  };

  const signal = (candidate: { id: string; candidate: string; mid?: string }) =>
    void relay.call("direct.candidate", candidate as never, { timeoutMs: SIGNAL_TIMEOUT_MS }).catch(() => undefined);

  const addTheirs = (l: Link, candidate: { candidate: string; mid?: string }) =>
    void l.pc.addIceCandidate({ candidate: candidate.candidate, sdpMid: candidate.mid ?? "0" }).catch(() => undefined);

  const tryDirect = () => {
    clearTimeout(retryTimer);
    if (closed || link || refused || offline || !Rtc || relayState !== "open" || config.enabled?.() === false) return;
    let pc: RtcPeer;
    const servers = iceServers();
    // The laptop gathers its own candidates with the same STUN servers (only stun: URLs; it takes at most four).
    const stun = servers.flatMap((s) => (typeof s.urls === "string" ? [s.urls] : s.urls)).filter((url) => /^stuns?:/.test(url)).slice(0, 4);
    try {
      pc = new Rtc({ iceServers: servers });
    } catch {
      refused = true; // this platform cannot
      return;
    }
    const channel = pc.createDataChannel(DIRECT_CHANNEL_LABEL, { ordered: true });
    channel.binaryType = "arraybuffer";
    const l: Link = { id: randomId(), pc, channel, client: null, ready: false, closed: false, answered: false, ours: [], theirs: [], heardAt: Date.now(), rtts: [], timers: [] };
    link = l;
    l.timers.push(setTimeout(() => !l.ready && drop(l, true), openTimeoutMs));
    pc.onicecandidate = (event) => {
      if (l.closed || !event.candidate || event.candidate.candidate === "") return;
      const candidate = { id: l.id, candidate: event.candidate.candidate, ...(event.candidate.sdpMid ? { mid: event.candidate.sdpMid } : {}) };
      if (l.answered) signal(candidate);
      else l.ours.push(candidate);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") drop(l, true);
    };
    channel.onopen = () => channelOpened(l);
    channel.onclose = () => drop(l, true);
    void (async () => {
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        const sdp = pc.localDescription?.sdp ?? offer.sdp ?? "";
        if (l.closed) return;
        const answer = await relay.call("direct.offer", { id: l.id, sdp, ice_servers: stun } as never, { timeoutMs: SIGNAL_TIMEOUT_MS });
        if (l.closed) return;
        await pc.setRemoteDescription({ type: "answer", sdp: (answer as { sdp: string }).sdp });
        l.answered = true;
        for (const candidate of l.ours.splice(0)) signal(candidate);
        for (const candidate of l.theirs.splice(0)) addTheirs(l, candidate);
      } catch (error) {
        // A runtime that offers none (a Cloud computer, one that cannot load WebRTC) is not asked again on this socket.
        if (error instanceof SessionProtocolError && error.error.data?.reason === "unsupported") refused = true;
        drop(l, true);
      }
    })();
  };

  relayOffs.set(
    "direct.candidate",
    relay.on("direct.candidate", (p) => {
      const l = link;
      if (!l || l.closed || p.id !== l.id) return;
      const candidate = { candidate: p.candidate, ...(p.mid !== undefined ? { mid: p.mid } : {}) };
      if (l.answered) addTheirs(l, candidate);
      else l.theirs.push(candidate);
    }),
  );

  const stopNetwork = (config.network ?? windowNetwork)((online) => {
    offline = !online;
    if (!online) return;
    failures = 0;
    const l = link;
    // On a direct path: make sure it still answers (a new network can strand it); otherwise try one now.
    if (l?.ready) {
      try {
        l.channel.send(directPing(performance.now()));
      } catch {
        drop(l, true);
      }
      return;
    }
    if (!l) tryDirect();
  });

  return {
    call,
    attach,
    on(name, handler) {
      let set = handlers.get(name);
      if (!set) {
        handlers.set(name, (set = new Set()));
        if (!relayOffs.has(name)) relayOffs.set(name, listen(relay, name, forwardRelay));
        const l = ready();
        if (l?.client) listen(l.client, name, forward(l));
      }
      set.add(handler as (params: never) => void);
      return () => void set.delete(handler as (params: never) => void);
    },
    // One runtime behind both paths: the relay connection's answer speaks for it.
    hello: () => relay.hello(),
    onHello: (listener) => relay.onHello(listener),
    close() {
      if (closed) return;
      closed = true;
      stopTaking?.();
      clearTimeout(retryTimer);
      stopNetwork();
      if (link) drop(link, false);
      // One that may go another way leaves with CallNotSent: the client it is on takes it back as it closes. On a page
      // that lost its lock, one the dead channel had stays unsettled: it is kept in the outbox, and the page reloads.
      for (const c of calls) {
        if (c.mutating && c.options?.unsentAfterMs !== undefined) {
          if (!c.sent) settle(c, { error: new CallNotSent(c.method, "unsent") });
          continue;
        }
        c.done = true;
        c.unlisten?.();
        c.reject(new Error("client closed"));
      }
      calls.clear();
      relay.close();
    },
    path: () => path,
    directRtts: () => (ready() ? [...link!.rtts] : []),
  };
}

/** `connect` with a direct path where `enabled(url)` says the runtime may offer one (the runtime pool's seam). */
export const directConnector =
  (config: Omit<DirectOptions, "enabled" | "onPath"> & { readonly enabled?: (url: string) => boolean; readonly onPath?: (url: string, path: DirectPath) => void } = {}) =>
  (url: string, token: TokenSource, onState?: (state: ConnectionState, error?: Error) => void, options: ConnectOptions = {}): DirectClient => {
    const { enabled, onPath, ...rest } = config;
    return connectDirect(url, token, onState, {
      ...options,
      direct: { ...rest, ...(enabled ? { enabled: () => enabled(url) } : {}), ...(onPath ? { onPath: (path: DirectPath) => onPath(url, path) } : {}) },
    });
  };

/** The path a client from connectDirect uses now; "relay" for any other client. */
export const pathOf = (client: Client | null | undefined): DirectPath =>
  client && typeof (client as Partial<DirectClient>).path === "function" ? (client as DirectClient).path() : "relay";
