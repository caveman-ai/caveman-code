// Where each open chat is read from and where its calls go, for one window (S4-S6, S12). The window's own runtime
// (This Mac on the desktop, the computer a web tab picked) serves its chats as before; a chat that runs on another
// computer is read through the runtime pool while that computer answers and from Cloud's copy while it does not, and
// its sends go to it directly or through Cloud's queue. When Cloud's list says a chat moved, or a computer slept or
// woke, every open chat switches source by (epoch, cursor): no reload, nothing shown twice, nothing skipped.
import type { RuntimeHello, SessionEvent } from "@caveman-app/session-protocol";
import type { Params } from "@caveman-app/session-protocol";
import { connect, type Client, type Handshake, type OutboxEntry, type Subscription } from "@caveman-app/session-protocol/client";
import { DEFAULT_ICE_SERVERS, pathOf, type DirectOptions } from "@caveman-app/session-protocol/direct";
import { ChatFeed, type FeedSink, type FeedState } from "./chat-feed.ts";
import { ChatListStore } from "./chat-list.ts";
import { liveRuntimes, runtimeOnline } from "./chats-view.ts";
import { CloudError, type CloudApi } from "./cloud-api.ts";
import { dropUnscoped, LOCAL_SCOPE, personScope, scopedKv, type Kv } from "./kv.ts";
import { kvOutbox, runtimeOutbox } from "./outbox.ts";
import type { Pages } from "./pages.ts";
import { RuntimePool, type PoolEndpoint, type RuntimePoolOptions } from "./runtime-pool.ts";
import { ChatSender, queuedLine, RESEND_OUT_WITHIN_MS, type Route } from "./sender.ts";
import { deviceHooks, type DeviceApproval } from "./device-hooks.ts";
import { submittedMessageId } from "./message-id.ts";
import type { LatencyVia } from "./latency.ts";
import { TranscriptCache } from "./transcript-cache.ts";
import { WakeHints, type WakeReason } from "./wake.ts";
import { alwaysPresent, type Presence } from "./presence.ts";
import { THIS_COMPUTER } from "../../lib/platform.ts";
import type { CallState, ChatCallMethod, ChatSummary, RuntimeState } from "./wire.ts";
import type { QueuedStart } from "../cloud.ts";

export interface Home {
  /** The runtime this window talks to directly; null before it is known (or on a web tab that picked none). */
  readonly runtimeId: string | null;
  readonly client: Client | null;
}

/** A call this window queued in Cloud, as the pane shows it. */
export interface QueuedCall {
  readonly call: CallState;
  /** queuedLine: null once it ran. */
  readonly line: string | null;
  /** A send's words. */
  readonly text?: string;
  /** A send's item id in the transcript (submittedMessageId). */
  readonly itemId?: string;
}

export interface SyncHubOptions {
  /**
   * Cloud's chat routes for this device and who is signed in (`org:user`); null when it has none (not signed in, a
   * runtime link without Cloud) or does not know yet (useCloud then).
   */
  readonly api: CloudApi | null;
  readonly person?: string;
  /** The device store; each person's part of it is theirs alone (F-1), and goes when they sign out. */
  readonly kv: Kv;
  readonly endpoint: (runtimeId: string) => PoolEndpoint | null;
  readonly home: () => Home;
  /**
   * The window's own runtime is on this device (the desktop's loopback): reachable whatever Cloud says. A web tab's is
   * reached through the relay, so Cloud's word that it is offline (a Mac asleep) sends its chats to Cloud's copy.
   */
  readonly homeLocal?: boolean;
  /** Test seam: how the pool opens a runtime connection. */
  readonly connect?: RuntimePoolOptions["connect"];
  /**
   * The direct path to laptops' runtimes (S14): the platform's WebRTC and Google's STUN unless given here; false: never.
   * Cloud computers are reached through the relay only.
   */
  readonly direct?: Omit<DirectOptions, "enabled" | "onPath"> | false;
  /** Whether the person is at this device (presence.ts; default: always): said on the list's stream. */
  readonly presence?: Presence;
  /**
   * This page among the device's open ones (pages.ts devicePages): each outbox here takes over only what a page that is
   * gone left. onlyPage: every entry in the store is this page's to send (one page at a time, as in tests).
   */
  readonly pages: Pages;
}

interface Open {
  readonly feed: ChatFeed;
  /** The chat's summary seq the last time the list was read for it: a newer one may mean its runtime has it now. */
  seq: number | null;
  /**
   * The pooled connection held while the feed reads its runtime, and the client it reads through (direct or relay);
   * `waiting`: held open while its Mac has not allowed this device, the feed reading Cloud's copy meanwhile (K4).
   */
  held: { readonly runtimeId: string; readonly release: () => void; client: Client; readonly waiting?: boolean } | null;
  synced: number | null;
}

/** The prefetch pass waits for the list to settle this long, then takes this many chats and this many copy pages each. */
const PREFETCH_DELAY_MS = 2_000;
const PREFETCH_CHATS = 8;
const PREFETCH_PAGES = 3;

/**
 * A refused runtime's computer is looked up again (Cloud's list read anew) at most this often: as long as the pool
 * leaves a runtime it could not reach alone (GONE_MS), so one that stays refused costs one read a minute.
 */
const LOOK_UP_EVERY_MS = 60_000;

/** How long a reload's resend waits for Cloud's list (from the store or live) before it judges a call without it. */
const LIST_WAIT_MS = 10_000;

/** Where the chats this device started in Cloud, and whose computer has not made them yet, are kept for a reload. */
const STARTS_KEY = "chats/starts";

/**
 * A start whose computer is up and has not made its chat is asked about these long after one another, and then no
 * more until the computer wakes as another runtime: only Cloud's word on the call says a start failed (one that ran
 * puts its chat on the list by itself). Nothing is asked while the computer is still on its way up.
 */
export const START_ASKS_MS: ReadonlyArray<number> = [3_000, 6_000, 12_000, 24_000, 48_000];

/** A start as the hub holds it: `live`, it runs as a call of this window's now, and its queued call says no more. */
type Start = QueuedStart & { readonly live?: true };

/** The call is still Cloud's or its computer's to run. */
const open = (call: Pick<CallState, "status">) => call.status === "queued" || call.status === "delivered";

/**
 * A chat this device started in Cloud, as Cloud's list will carry it once its computer made it: listed from Send, on
 * "Cloud" (words.md: never a computer's name), with nothing run yet and its start as its one open call.
 */
export function startingChat(start: QueuedStart): ChatSummary {
  return {
    session_id: start.session_id,
    workspace_id: start.workspace_id,
    runtime_id: "",
    computer_id: start.start.computer_id,
    where: { kind: "cloud", name: "Cloud", online: false },
    title: start.start.title ?? (start.start.task.split("\n")[0]!.slice(0, 80) || start.start.repo),
    engine: start.start.engine,
    ...(start.start.options?.model ? { model: start.start.options.model } : {}),
    repo: start.start.repo,
    ...(start.start.base_ref ? { base_branch: start.start.base_ref } : {}),
    kind: "chat",
    status: "idle",
    last_activity_at: start.call.created_at,
    epoch: 0,
    head: 0,
    synced_through: null,
    archived: false,
    person: { seen_cursor: 0, pinned: false },
    calls: [start.call],
    seq: 0,
  };
}

/** Cloud's calls: what can be queued for a computer that is asleep. */
const QUEUEABLE = new Set<string>(["turn.submit", "turn.interrupt", "ask.respond"]);

/**
 * What a call that needs a chat's sleeping place says (words.md): "Cloud", never a Cloud computer's name, or the Mac's
 * own name; and nothing for the person to do, since a send or an opening wakes Cloud by itself.
 */
export function asleepLine(chat: Pick<ChatSummary, "where"> | undefined): string {
  if (!chat) return "This chat can't be reached right now.";
  return `${chat.where.kind === "cloud" ? "Cloud" : chat.where.name || "Your Mac"} is asleep. This works once it's awake.`;
}

export class SyncHub {
  list: ChatListStore | null = null;
  readonly pool: RuntimePool;
  /** The signed-in person's cached transcripts (this device's own before any sign-in). */
  cache: TranscriptCache;
  sender: ChatSender | null = null;
  /** Who Cloud's routes are for (`org:user`), and their part of the device store. */
  private person: string | null = null;
  private kv: ReturnType<typeof scopedKv>;
  private listOff: (() => void) | null = null;
  private wakes: WakeHints | null = null;
  private prefetching = false;
  private prefetchTimer: ReturnType<typeof setTimeout> | undefined;
  private options: SyncHubOptions;
  private started = false;
  private stopping: Promise<void> | null = null;
  private closing = false;
  private storeReady: Promise<void> | undefined;
  private readonly stores: Array<{ kv: ReturnType<typeof scopedKv>; cache: TranscriptCache }> = [];
  private readonly initial: Promise<void>;
  private readonly open = new Map<string, Open>();
  private readonly offs: Array<() => void> = [];
  /** Calls this window queued in Cloud, by session: what the pane says about them until they run. */
  private readonly queued = new Map<string, Map<string, CallState>>();
  /** What each queued send says (its text) and its item id in the transcript, by request id. */
  private readonly queuedText = new Map<string, string>();
  private readonly queuedItem = new Map<string, string>();
  /** Queued calls Cloud's list has carried. It carries open calls only (queued or delivered): one it drops ran. */
  private readonly listedCalls = new Set<string>();
  /** Queued calls the list has not carried yet, by request id: the seq of their chat's summary when Cloud was last asked. */
  private readonly askedCalls = new Map<string, number>();
  /** Each runtime's state as the pool last heard of it from Cloud's list (tendPool). */
  private readonly runtimesSeen = new Map<string, RuntimeState>();
  /**
   * Runtimes of Cloud computers the relay refused or could not find while a chat here was open on them, and when
   * Cloud's list was last read again for each (lookAgain): once per LOOK_UP_EVERY_MS, however often it is refused.
   */
  private readonly lookedUp = new Map<string, number>();
  /** Sends held in a Mac's connection until it allows this device (K4), by request id: the Mac's runtime id. */
  private readonly heldForApproval = new Map<string, string>();
  /**
   * Chats whose changes or pull request were opened while their Cloud computer slept (wake "open"), by session: since
   * when it wakes for that, and whether Cloud refused the last ask. Gone once the computer answers.
   */
  private readonly opened = new Map<string, { since: number; failed: boolean }>();
  /** Chats this device started in Cloud whose computer has not made them yet (started), by session. */
  private readonly starts = new Map<string, Start>();
  /** Cloud's word on each one's call: the runtime of its computer it is asked about for (askStart), and the next ask. */
  private readonly startAsks = new Map<string, { readonly runtime: string; readonly timer: ReturnType<typeof setTimeout> | undefined }>();
  /** Chats that got another workspace id than the one this window opened them under, by that one (startMoved). */
  private readonly movedStarts = new Map<string, string>();
  private readonly listeners = new Set<() => void>();

  constructor(options: SyncHubOptions) {
    this.options = { ...options, api: null };
    this.initial = dropUnscoped(options.kv).catch(() => undefined);
    this.kv = scopedKv(options.kv, LOCAL_SCOPE);
    this.cache = new TranscriptCache(this.kv);
    this.stores.push({ kv: this.kv, cache: this.cache });
    this.pool = new RuntimePool({
      endpoint: options.endpoint,
      outbox: (id) => runtimeOutbox(this.kv, id, this.cloudComputerOf(id), options.pages),
      resend: (id) => this.resendable(id),
      handshake: (id) => deviceHooks().handshake?.(id),
      ...(options.connect ? { connect: options.connect } : {}),
      direct: (id) => this.directFor(id),
    });
    if (options.api) this.useCloud(options.api, options.person ?? "");
  }

  /** This window's part of the device store now: the signed-in person's, or the device's own before a sign-in. */
  store(): Kv {
    return this.kv;
  }

  private changeStore(scope: string): void {
    this.kv = scopedKv(this.options.kv, scope, this.storeReady);
    this.cache = new TranscriptCache(this.kv);
    this.stores.push({ kv: this.kv, cache: this.cache });
  }

  /** A direct path for a laptop's runtime (S14), as Cloud's list knows it when its connection opens; none for the rest. */
  private directFor(runtimeId: string): DirectOptions | undefined {
    const options = this.options.direct;
    if (options === false || this.list?.get().runtimes.get(runtimeId)?.kind !== "laptop" || !this.directAllowed()) return undefined;
    return {
      iceServers: () => this.directIceServers(),
      ...options,
      enabled: () => this.list?.get().runtimes.get(runtimeId)?.kind === "laptop" && this.directAllowed(),
    };
  }

  /** The install allows direct channels to laptops (S14): it said so, or said nothing. */
  directAllowed(): boolean {
    return this.options.direct !== false && this.list?.get().direct?.enabled !== false;
  }

  /** The STUN servers the install advertises; Google's public one only when it says nothing. */
  directIceServers(): ReadonlyArray<{ readonly urls: string }> {
    const advert = this.list?.get().direct;
    return advert ? advert.stun_servers.map((urls) => ({ urls })) : DEFAULT_ICE_SERVERS;
  }

  /**
   * Cloud's chat routes became available to this device for `person` (`org:user`; the desktop got a token from its
   * runtime's sign-in): the list, the copy and Cloud's queue from now on, kept in that person's part of the device
   * store. Another person signed in here: the last one's part goes first (signedOut).
   */
  useCloud(api: CloudApi, person: string): void {
    if (this.stopping && !this.started) return;
    if (this.list && this.person === person) return;
    if (this.list) void this.signedOut();
    this.person = person;
    this.changeStore(personScope(person));
    const cache = this.cache;
    this.options = { ...this.options, api };
    this.list = new ChatListStore({ api, kv: this.kv, presence: this.presence(), onGone: (id) => void cache.forget(id).catch(() => undefined) });
    this.wakes = new WakeHints(api);
    this.sender = new ChatSender({
      api,
      outbox: kvOutbox(this.kv, "cloud", this.options.pages),
      // A send that went out before a reload goes to Cloud's queue only as the client would send it again: its chat
      // still runs there, on the same epoch, as Cloud's list says once it is read.
      resendable: async (runtime, entry) => (await this.listRead(), this.resendable(runtime)(entry)),
      // A send a reload posted again shows its words again, as when it was made (noteSend).
      onQueued: (session, call, params) => void this.noteSend(session, call, params).catch(() => this.noteQueued(session, call)),
      callFields: async (call) => (await deviceHooks().callFields?.(call)) ?? {},
    });
    void this.restoreStarts(this.list);
    if (this.started && !this.stopping) this.follow(this.list);
  }

  hasCloud(): boolean {
    return this.list !== null;
  }

  /** Who Cloud's routes are for now (`org:user`), or null. */
  cloudPerson(): string | null {
    return this.list ? this.person : null;
  }

  /** Cloud's chat routes for this device, once it has them. */
  cloud(): CloudApi | null {
    return this.options.api;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.stopping && this.closing) {
      this.storeReady = this.stopping;
      const api = this.options.api;
      const person = this.person;
      this.list = null;
      this.sender = null;
      this.changeStore(LOCAL_SCOPE);
      if (api) this.useCloud(api, person ?? "");
      this.closing = false;
    }
    // React's synchronous setup/cleanup/setup replay resumes the same stores before shutdown has begun.
    this.stopping = null;
    this.followStarted();
  }

  private followStarted(): void {
    if (this.list) this.follow(this.list);
    this.offs.push(this.pool.subscribe(() => this.reroute()));
    // A Mac allowed this device (or said no): its chats read from it again, or stay on Cloud's copy (K4).
    const offApproval = deviceHooks().onApproval?.(() => this.reroute());
    if (offApproval) this.offs.push(offApproval);
  }

  /**
   * What this device still waits for on `runtimeId` before it may drive it: a Mac that has not allowed it yet, or said
   * no (S13). Reading never needs it, so its chats read from Cloud's copy meanwhile; sends wait for it (K4).
   */
  approvalFor(runtimeId: string | null | undefined): DeviceApproval | null {
    return runtimeId ? (deviceHooks().approval?.(runtimeId) ?? null) : null;
  }

  private presence(): Presence {
    return this.options.presence ?? alwaysPresent;
  }

  private follow(list: ChatListStore): void {
    void list.start();
    this.listOff = list.subscribe(() => this.reroute());
    this.reroute();
  }

  /**
   * The person signed out here (or another signed in): Cloud's list, queue and copy go, and so does everything this
   * device kept for them (list, cached transcripts, calls waiting), so the next person never sees any of it (F-1).
   */
  async signedOut(): Promise<void> {
    if (this.stopping && !this.started) return;
    const kv = this.kv;
    const had = this.person !== null;
    this.listOff?.();
    this.listOff = null;
    this.list?.stop();
    this.list = null;
    this.sender?.close();
    this.sender = null;
    this.wakes = null;
    this.person = null;
    clearTimeout(this.prefetchTimer);
    this.options = { ...this.options, api: null };
    this.queued.clear();
    this.queuedText.clear();
    this.queuedItem.clear();
    this.listedCalls.clear();
    this.askedCalls.clear();
    for (const ask of this.startAsks.values()) clearTimeout(ask.timer);
    this.startAsks.clear();
    this.starts.clear();
    this.movedStarts.clear();
    this.pool.closeAll();
    const wiped = had ? kv.wipe().catch(() => undefined) : Promise.resolve();
    // Replacements, including a quick sign-in by the same person, must read and write after the clear itself.
    this.storeReady = Promise.all([this.storeReady, wiped]).then(() => undefined);
    this.changeStore(LOCAL_SCOPE);
    this.reroute();
    await wiped;
  }

  /** Stop sources now; resolve after final transcript writes and device-store operations have settled. */
  stop(): Promise<void> {
    this.started = false;
    if (this.stopping) return this.stopping;
    clearTimeout(this.prefetchTimer);
    for (const ask of this.startAsks.values()) clearTimeout(ask.timer);
    this.startAsks.clear();
    for (const off of this.offs.splice(0)) off();
    this.listOff?.();
    this.listOff = null;
    this.list?.stop();
    for (const id of [...this.open.keys()]) this.close(id);
    this.pool.closeAll();
    const stopping = Promise.resolve().then(async () => {
      if (this.stopping !== stopping) return;
      this.closing = true;
      this.sender?.close();
      await Promise.all([
        this.initial,
        ...this.stores.splice(0).map(async ({ kv, cache }) => {
          await cache.close();
          await kv.close();
        }),
      ]);
    });
    this.stopping = stopping;
    return stopping;
  }

  /** The window's runtime changed (a web tab picked another computer, This Mac's runtime restarted): look again. */
  homeChanged(): void {
    this.reroute();
  }

  /**
   * A connection of its own to `runtimeId`, outside the pool, with `handshake` in place of the device hooks' (Join your
   * other Mac's, which proves a pairing code once): null when that runtime cannot be reached from here. The caller closes it.
   */
  connectOnce(runtimeId: string, handshake: Handshake): Client | null {
    const endpoint = this.options.endpoint(runtimeId);
    if (!endpoint) return null;
    return (this.options.connect ?? connect)(endpoint.url, endpoint.token, undefined, { handshake });
  }

  /** The runtime this window talks to directly (null on a web tab that picked none). */
  homeRuntimeId(): string | null {
    return this.options.home().runtimeId;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  summary(sessionId: string): ChatSummary | undefined {
    return this.list?.get().chats.get(sessionId);
  }

  /** The chat runs on a computer other than this window's own (Cloud's list says so). */
  elsewhere(sessionId: string): boolean {
    const chat = this.summary(sessionId);
    return chat !== undefined && chat.runtime_id !== this.options.home().runtimeId;
  }

  /**
   * The chat's pane talks through the hub (clientFor) rather than the window's own client: it runs on another computer,
   * or on the window's own runtime that a web tab cannot reach now (Cloud says it is offline, or there is no link).
   */
  throughHub(sessionId: string): boolean {
    const chat = this.summary(sessionId);
    if (!chat) return false;
    if (chat.runtime_id !== this.options.home().runtimeId) return true;
    if (this.options.homeLocal) return false;
    return this.options.home().client === null || this.offline(chat) || this.approvalFor(chat.runtime_id) !== null;
  }

  /**
   * The reconnect counter of the connection a chat on another computer is reached through (clientFor): the latest open
   * of the pooled connection to its runtime, so it changes on every (re)open there and when the chat runs elsewhere.
   */
  connectionFor(sessionId: string): number {
    const chat = this.summary(sessionId);
    return chat ? this.pool.lastOpened(chat.runtime_id) : 0;
  }

  /** `runtimeId`'s runtime.hello answer, when this device holds a connection to it that has answered (skew.ts). */
  runtimeHello(runtimeId: string): RuntimeHello | undefined {
    return this.pool.hello(runtimeId);
  }

  /** Cloud's newest word is that the chat's runtime is off line (runtimeOnline). */
  private offline(chat: ChatSummary): boolean {
    const runtimes = this.list?.get().runtimes;
    return runtimes !== undefined && runtimeOnline(chat, runtimes) === false;
  }

  /**
   * Whether this device can talk to `runtimeId` right now; `chat`, one of its chats, whose summary may be newer word
   * that it is on line (runtimeOnline).
   */
  reachable(runtimeId: string, chat?: ChatSummary): boolean {
    if (runtimeId === this.options.home().runtimeId) return this.options.home().client !== null;
    const runtimes = this.list?.get().runtimes;
    const online = chat?.runtime_id === runtimeId && runtimes ? runtimeOnline(chat, runtimes) : runtimes?.get(runtimeId)?.online;
    return online === true && this.pool.link(runtimeId) !== "unreachable" && this.options.endpoint(runtimeId) !== null;
  }

  /**
   * The calls this window queued in Cloud for a chat, newest last, as Cloud's list says of them now: a send's text and
   * transcript item id (the runtime's own message replaces it there), and the status line to show under it.
   */
  queuedCalls(sessionId: string): ReadonlyArray<QueuedCall> {
    const mine = this.queued.get(sessionId);
    if (!mine) return [];
    const chat = this.summary(sessionId);
    const listed = new Map((chat?.calls ?? []).map((c) => [c.request_id, c] as const));
    const place = { name: chat?.where.name ?? "its computer", cloud: chat?.where.kind === "cloud" };
    return [...mine.values()].map((c) => {
      const call = listed.get(c.request_id) ?? c;
      // Held for a Mac to allow this device: what it waits for, in the waiting screen's words.
      const waiting = call.status === "queued" && this.heldForApproval.has(c.request_id) ? (this.approvalFor(this.heldForApproval.get(c.request_id))?.title ?? null) : undefined;
      const text = this.queuedText.get(c.request_id);
      const itemId = this.queuedItem.get(c.request_id);
      // A start this window runs as its own call now (startLive): the message waits for that, as one just sent does.
      const live = this.starts.get(sessionId)?.live === true && this.starts.get(sessionId)?.call.request_id === c.request_id;
      return { call, line: live ? null : waiting !== undefined ? waiting : queuedLine(call, place), ...(text !== undefined ? { text } : {}), ...(itemId !== undefined ? { itemId } : {}) };
    });
  }

  /**
   * Asks Cloud to wake the Cloud computer a chat runs on, if it sleeps: the person is typing in the chat ("typing"), or
   * opened something of it that needs its computer, its changes or its pull request ("open"). Never because a window
   * or a chat is merely open: a send wakes (Cloud wakes a computer for a call queued for it), looking does not, and a
   * computer put to sleep stays asleep. Bounded (wake.ts); a Mac is never asked. True when a hint went out.
   */
  wake(sessionId: string, reason: WakeReason): boolean {
    const chat = this.summary(sessionId);
    if (!chat || !this.wakes || chat.where.kind !== "cloud") return false;
    const runtime = this.list?.get().runtimes.get(chat.runtime_id);
    const asleep = runtime?.online !== true || runtime.computer_state === "suspended" || runtime.computer_state === "stopped";
    if (!asleep) return false;
    // Opened for something that needs it: the panel counts its wait from here, and says so if Cloud refuses.
    const opened = reason === "open" ? (this.opened.get(sessionId) ?? { since: Date.now(), failed: false }) : null;
    const sent = this.wakes.hint(chat.computer_id, reason, () => {
      const now = this.opened.get(sessionId);
      if (!now) return;
      this.opened.set(sessionId, { ...now, failed: true });
      this.notify();
    });
    if (opened) {
      this.opened.set(sessionId, sent ? { ...opened, failed: false } : opened);
      this.notify();
    }
    return sent;
  }

  /**
   * The chat runs in Cloud and its computer cannot be reached from here now (asleep, or on its way up): what its
   * changes and pull request wait for, waking it as they are opened (wake "open").
   */
  asleepInCloud(sessionId: string): boolean {
    const chat = this.summary(sessionId);
    return chat !== undefined && chat.where.kind === "cloud" && !this.reachable(chat.runtime_id, chat);
  }

  /**
   * A chat's changes or pull request opened while its Cloud computer slept: since when it wakes for that (ms), and
   * whether Cloud refused the last ask (it is asked again within wake.ts's bounds). Null once it answers, or when
   * nothing was opened.
   */
  openWait(sessionId: string): { readonly since: number; readonly failed: boolean } | null {
    return this.asleepInCloud(sessionId) ? (this.opened.get(sessionId) ?? null) : null;
  }

  /**
   * Since when (ms) a chat's sleeping Cloud computer wakes for this window: a send of its waiting in Cloud's queue
   * (which Cloud wakes the computer for), or its changes or pull request opened (wake "open"). What the chat's one
   * line counts while it wakes. Null when nothing waits, the computer answers, or the chat runs on a Mac (which
   * nothing here wakes).
   */
  wakingSince(sessionId: string): number | null {
    const chat = this.summary(sessionId);
    if (!chat || chat.where.kind !== "cloud" || this.reachable(chat.runtime_id, chat)) return null;
    const since = this.queuedCalls(sessionId)
      .filter((q) => q.call.status === "queued")
      .map((q) => Date.parse(q.call.created_at))
      .filter((at) => Number.isFinite(at));
    const opened = this.opened.get(sessionId);
    if (opened) since.push(opened.since);
    return since.length === 0 ? null : Math.min(...since);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  /** A chat's row is under the pointer or focused: open its runtime's connection now, so the click finds it up (S14). */
  preconnect(sessionId: string): void {
    const chat = this.summary(sessionId);
    if (!chat || chat.runtime_id === this.options.home().runtimeId || !this.reachable(chat.runtime_id, chat)) return;
    // Let go at once: the pool keeps it two idle minutes, which covers the click.
    this.pool.acquire(chat.runtime_id)?.release();
  }

  /** How a chat's events and calls travel now, for the latency meter. */
  viaFor(sessionId: string): LatencyVia {
    const chat = this.summary(sessionId);
    if (!chat || (chat.runtime_id === this.options.home().runtimeId && !this.throughHub(sessionId))) return this.options.homeLocal ? "loopback" : pathOf(this.options.home().client);
    if (!this.reachable(chat.runtime_id, chat)) return "queue";
    return this.pool.isDirect(chat.runtime_id) ? "direct" : "relay";
  }

  /** Opens a chat's feed (one per session per window), reading from wherever it can be read now. */
  openFeed(sessionId: string, sink: FeedSink, onState: (state: FeedState) => void, start?: { epoch: number | undefined; cursor: number }): ChatFeed {
    this.close(sessionId);
    const api = this.options.api;
    const feed = new ChatFeed({
      sessionId,
      sink,
      onState,
      cache: this.cache,
      ...(start ? { start } : {}),
      ...(api ? { copy: (epoch: number, after: number) => api.events(sessionId, epoch, after) } : {}),
      // A chat still starting has no copy in Cloud to read: its epoch is its computer's to say.
      epochHint: () => (this.starts.has(sessionId) ? undefined : this.summary(sessionId)?.epoch),
    });
    const open: Open = { feed, held: null, synced: this.summary(sessionId)?.synced_through ?? null, seq: this.summary(sessionId)?.seq ?? null };
    this.open.set(sessionId, open);
    this.route(sessionId, open);
    return feed;
  }

  close(sessionId: string): void {
    const open = this.open.get(sessionId);
    if (!open) return;
    this.open.delete(sessionId);
    open.feed.close();
    open.held?.release();
  }

  /**
   * Where a call for this chat goes now: its runtime when this device reaches it, else Cloud's queue. A call to a
   * runtime the device reaches through the network may still go to Cloud's queue if it cannot go out (X-3); one to the
   * desktop's own runtime on loopback, or for a chat Cloud does not list, never does.
   */
  routeFor(sessionId: string): Route | null {
    const chat = this.summary(sessionId);
    const home = this.options.home();
    // A Mac that has not allowed this device yet takes its calls once it does (its connection holds them); Cloud's
    // queue would hand them to a Mac that refuses them (K4).
    const waiting = chat !== undefined && this.approvalFor(chat.runtime_id) !== null;
    const runtime = (client: Client): Route => ({
      via: "runtime",
      client,
      ...(chat ? { runtime: chat.runtime_id, computer: chat.computer_id, epoch: chat.epoch } : {}),
      ...(chat && this.sender && !waiting && !(this.options.homeLocal && chat.runtime_id === home.runtimeId) ? { orCloud: true } : {}),
    });
    if (!chat || chat.runtime_id === home.runtimeId) {
      const asleep = chat !== undefined && !this.options.homeLocal && this.offline(chat);
      return home.client && !asleep ? runtime(home.client) : this.sender ? { via: "cloud" } : null;
    }
    if (this.reachable(chat.runtime_id, chat)) {
      const held = this.pool.acquire(chat.runtime_id);
      if (held) {
        // Held for the call's length (the pool closes it two idle minutes after). A direct path, when up, carries it.
        queueMicrotask(held.release);
        return runtime(held.client);
      }
    }
    return this.sender ? { via: "cloud" } : null;
  }

  /**
   * Whether a call to `runtimeId` that went out with no answer may go out again (ConnectOptions.resend, and the
   * sender's after a reload): not once it is older than RESEND_OUT_WITHIN_MS, nor when Cloud's list says its chat now
   * runs elsewhere or on another epoch (X-3). A Cloud computer that woke under a new runtime id is not elsewhere: the
   * call went out to that computer, and its journal there is the one the call was made for.
   * `runtimeId` null: the window's own runtime, whichever it is then.
   */
  resendable(runtimeId: string | null): (entry: OutboxEntry) => boolean {
    return (entry) => {
      if (Date.now() - entry.at > RESEND_OUT_WITHIN_MS) return false;
      const sessionId = (entry.params as { session_id?: unknown } | null)?.session_id;
      const chat = typeof sessionId === "string" ? this.summary(sessionId) : undefined;
      if (!chat) return true;
      const target = runtimeId ?? this.options.home().runtimeId;
      return (target === null || chat.runtime_id === target || this.wasOnComputer(target, chat, entry)) && (entry.epoch === undefined || entry.epoch === chat.epoch);
    };
  }

  /**
   * `runtimeId` was a runtime of the Cloud computer `chat` is on now: the computer the call's entry names (sender.ts
   * Held.computer), or the one Cloud's list had that runtime on while this window knew it.
   */
  private wasOnComputer(runtimeId: string, chat: ChatSummary, entry: OutboxEntry): boolean {
    if (chat.where.kind !== "cloud") return false;
    const named = (entry.params as { computer?: unknown } | null)?.computer;
    return (typeof named === "string" ? named : this.cloudComputerOf(runtimeId)) === chat.computer_id;
  }

  /**
   * The Cloud computer `runtimeId` is a runtime of, whose calls wait under it (runtimeOutbox): as Cloud's list says of
   * the runtime, or said while this window knew it, or says of a chat on it, whose summary can name a runtime before
   * the runtime's own change gets here (K11). Undefined for a Mac's runtime, and for one nothing here names.
   */
  cloudComputerOf(runtimeId: string): string | undefined {
    const list = this.list?.get();
    const runtime = list?.runtimes.get(runtimeId) ?? this.runtimesSeen.get(runtimeId);
    if (runtime) return runtime.kind === "cloud" ? runtime.computer_id : undefined;
    for (const chat of list?.chats.values() ?? []) if (chat.runtime_id === runtimeId) return chat.where.kind === "cloud" ? chat.computer_id : undefined;
    return undefined;
  }

  /** Settles once Cloud's list has been read (from the store or live), or after LIST_WAIT_MS without it. */
  private listRead(): Promise<void> {
    const list = this.list;
    if (!list || list.get().ready) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        off();
        resolve();
      };
      const timer = setTimeout(done, LIST_WAIT_MS);
      const off = list.subscribe(() => void (list.get().ready && done()));
    });
  }

  /**
   * A Session Protocol client for one chat that runs elsewhere: send, stop and answer go to its runtime or Cloud's
   * queue; anything else needs its runtime and says so plainly while it sleeps. The pane's surfaces (composer,
   * transcript actions, side panels) use it as they would the window's own client.
   */
  clientFor(sessionId: string): Client {
    const runtimeClient = (): Client | null => {
      const chat = this.summary(sessionId);
      if (!chat || !this.reachable(chat.runtime_id, chat)) return null;
      const held = this.pool.acquire(chat.runtime_id);
      if (!held) return null;
      queueMicrotask(held.release);
      return held.client;
    };
    const asleep = () => new Error(asleepLine(this.summary(sessionId)));
    return {
      call: async (method, params, options) => {
        // "This Mac" is this window's own computer, which only its own runtime pulls a chat to (Moves.tsx
        // pullToThisMac). The chat's computer would read it as the Mac the chat came from (audit C2): never sent there.
        if ((method === "session.move" || method === "session.move.check") && (params as Params<"session.move">).to === "this_mac") {
          throw new Error(`Continue on ${THIS_COMPUTER} from ${THIS_COMPUTER}'s own window, or move it to one of your Macs by name.`);
        }
        // Move to from a device that does not hold the chat: the person's move, through Cloud (M-6). Cloud mails the
        // chat's computer when it is up, or moves it itself while it is away; a check needs the computer, if it is up.
        if (method === "session.move" && this.options.api) {
          const to = this.cloudTarget((params as Params<"session.move">).to);
          if (to) {
            // Signed by this device over exactly this move: a Mac holding the chat lets it go only for a device it allowed.
            // A move to a Mac comes signed already (Move to's moveParams, over the same computer): that signature goes.
            const { request_id, device } = params as Params<"session.move">;
            const signed = device ? { device } : ((await deviceHooks().moveFields?.({ session_id: sessionId, request_id, to }).catch(() => undefined)) ?? {});
            return { pending: (await this.options.api.move(sessionId, to, { request_id, ...signed })).pending } as never;
          }
        }
        if (method === "session.move.check" && this.options.api && !runtimeClient()) return { login: null } as never;
        // Nothing to warm on a Mac that has not allowed this device: the call would only wait for it.
        if (method === "turn.prewarm" && this.approvalFor(this.summary(sessionId)?.runtime_id)) return {} as never;
        if (method === "turn.prewarm" && !runtimeClient()) {
          // Typing in a chat whose computer sleeps: wake it (S14) instead of warming an engine nobody can reach.
          this.wake(sessionId, "typing");
          return {} as never;
        }
        if (QUEUEABLE.has(method) && this.approvalFor(this.summary(sessionId)?.runtime_id)?.state === "pending") return this.holdForApproval(sessionId, method as ChatCallMethod, params as never) as never;
        if (QUEUEABLE.has(method)) {
          const route = this.routeFor(sessionId);
          if (!route || !this.sender) throw asleep();
          // Asked again once the chat's earlier calls are out; the sender keeps one behind a call Cloud still holds there.
          const outcome = await this.sender.send(sessionId, method as ChatCallMethod, params as never, route, () => this.routeFor(sessionId) ?? route);
          if (outcome.via === "runtime") return outcome.result as never;
          await this.noteSend(sessionId, outcome.call, params);
          // Queued in Cloud: the composer's echo stays (the transcript shows it dimmed, with where it waits) until the
          // runtime's own message for this request id takes its place.
          return (method === "turn.submit" ? { turn_id: outcome.call.id, disposition: "started" } : {}) as never;
        }
        const client = runtimeClient();
        if (!client) throw asleep();
        return client.call(method, params, options);
      },
      attach: async (session, cursor, onEvent, attachOptions): Promise<Subscription> => {
        const client = runtimeClient();
        if (!client) throw asleep();
        return client.attach(session, cursor, onEvent, attachOptions);
      },
      on: (name, handler) => runtimeClient()?.on(name, handler) ?? (() => undefined),
      // Read from the pool, never opening a connection for it; the pool's listeners hear each answer.
      hello: () => {
        const chat = this.summary(sessionId);
        return chat ? this.pool.hello(chat.runtime_id) : undefined;
      },
      onHello: (listener) => {
        let last: RuntimeHello | undefined;
        return this.pool.subscribe(() => {
          const chat = this.summary(sessionId);
          const hello = chat ? this.pool.hello(chat.runtime_id) : undefined;
          if (hello && hello !== last) listener((last = hello));
        });
      },
      close: () => undefined,
    };
  }

  /** A move's target as Cloud's move route takes it: "cloud" or a computer (a runtime by its computer). Never This Mac (above). */
  private cloudTarget(to: Params<"session.move">["to"]): "cloud" | { readonly computer_id: string } | null {
    if (to === "cloud") return "cloud";
    if (to === "this_mac") return null;
    if ("computer_id" in to) return { computer_id: to.computer_id };
    const computerId = this.list?.get().runtimes.get(to.runtime_id)?.computer_id;
    return computerId ? { computer_id: computerId } : null;
  }

  /** A send shown in the transcript before its runtime runs it: its words and item id, and where it waits. */
  private async noteSend(sessionId: string, call: CallState, params: unknown): Promise<void> {
    const text = (params as { input?: { text?: unknown } }).input?.text;
    if (typeof text === "string") this.queuedText.set(call.request_id, text);
    // Noted at once, so the calls behind it are listed after it.
    this.noteQueued(sessionId, call);
    if (typeof text !== "string") return;
    const itemId = await submittedMessageId(sessionId, call.request_id);
    if (!itemId) return;
    this.queuedItem.set(call.request_id, itemId);
    for (const listener of this.listeners) listener();
  }

  /**
   * A send, stop or answer in a chat on a Mac that has not allowed this device yet (K4): it waits in that Mac's
   * connection (held open meanwhile, so the Mac's question stays up) and goes the moment the Mac allows it. Shown
   * at once as waiting for the Mac, never as working; the runtime's own message replaces it once it runs.
   */
  private async holdForApproval(sessionId: string, method: ChatCallMethod, params: { readonly request_id: string } & Record<string, unknown>): Promise<unknown> {
    const chat = this.summary(sessionId);
    const route = this.routeFor(sessionId);
    if (!chat || !this.sender || route?.via !== "runtime") throw new Error("This chat is not reachable right now.");
    const hold = chat.runtime_id === this.options.home().runtimeId ? null : this.pool.acquire(chat.runtime_id);
    const call: CallState = { id: `held-${params.request_id}`, request_id: params.request_id, method, status: "queued", created_at: new Date().toISOString() };
    this.heldForApproval.set(params.request_id, chat.runtime_id);
    void this.sender
      .send(sessionId, method, params, route)
      .then(
        () => this.noteQueued(sessionId, { ...call, status: "done" }),
        (error: unknown) => this.noteQueued(sessionId, { ...call, status: "failed", error: { code: "not_sent", message: error instanceof Error ? error.message : String(error) } }),
      )
      .finally(() => hold?.release());
    await this.noteSend(sessionId, call, params);
    return method === "turn.submit" ? { turn_id: call.id, disposition: "started" } : {};
  }

  /**
   * A chat this device started in Cloud (POST workspaces with `start`, CONTRACT §6.8): Cloud holds its start, and it
   * is one of the person's chats from now on. It is listed, opens under the id its computer will give it, and shows
   * its first message as a send queued in Cloud is shown, with where it waits. Cloud's own summary takes its place
   * once the computer made it; a start that failed there says so under the message (startsFailed).
   */
  async startQueued(start: QueuedStart): Promise<void> {
    if (!this.list) return;
    this.starts.set(start.session_id, start);
    await this.showStart(start);
    this.saveStarts();
    this.listStarts();
    this.reroute();
  }

  /** The start of a chat this device started in Cloud, while its computer has not made it; `live`: this window runs it now. */
  startOf(sessionId: string): (QueuedStart & { readonly live?: true }) | undefined {
    return this.starts.get(sessionId);
  }

  /** The starts Cloud says failed or lapsed, which nothing took over yet: what shell/QueuedStarts.tsx hands on. */
  startsFailed(): ReadonlyArray<QueuedStart> {
    return [...this.starts.values()].filter((s) => !s.live && (s.call.status === "failed" || s.call.status === "expired"));
  }

  /** The start of the chat this window opened under `workspaceId` at Send, while its computer has not made it. */
  startAt(workspaceId: string): QueuedStart | undefined {
    for (const start of this.starts.values()) if (start.workspace_id === workspaceId) return start;
    return undefined;
  }

  /** This window runs the start as a call of its own now (the way before the queue): its queued call says no more. */
  startLive(sessionId: string): void {
    const start = this.starts.get(sessionId);
    if (!start || start.live) return;
    this.starts.set(sessionId, { ...start, live: true });
    this.notify();
  }

  /** The chat is no longer this start's to show: it runs under another chat's ids now, or the person gave it up. */
  startSettled(sessionId: string): void {
    const start = this.starts.get(sessionId);
    if (!start) return;
    this.dropStart(start);
    this.listStarts();
    this.reroute();
  }

  /** The workspace a chat opened under `workspaceId` at Send got instead, when its computer gave it another id. */
  startMoved(workspaceId: string): string | undefined {
    return this.movedStarts.get(workspaceId);
  }

  /** The start's first message in its chat's transcript, under the id the runtime gives it (`<request id>:task`). */
  private async showStart(start: QueuedStart): Promise<void> {
    const requestId = start.call.request_id;
    if (start.start.task.trim()) {
      this.queuedText.set(requestId, start.start.task);
      const itemId = await submittedMessageId(start.session_id, `${requestId}:task`);
      if (itemId && this.starts.has(start.session_id)) this.queuedItem.set(requestId, itemId);
    }
    if (this.starts.has(start.session_id)) this.noteQueued(start.session_id, start.call);
  }

  private listStarts(): void {
    this.list?.starting([...this.starts.values()].map(startingChat));
  }

  private saveStarts(): void {
    const kept = [...this.starts.values()].map(({ live: _live, ...start }) => start);
    void (kept.length > 0 ? this.kv.put(STARTS_KEY, kept) : this.kv.delete(STARTS_KEY)).catch(() => undefined);
  }

  /** The starts a page before this one left: listed and shown again, and asked about at once (it may have been long). */
  private async restoreStarts(list: ChatListStore): Promise<void> {
    const kept = await this.kv.get<ReadonlyArray<QueuedStart>>(STARTS_KEY).catch(() => undefined);
    if (!kept || this.list !== list || (this.stopping && !this.started)) return;
    for (const start of kept) {
      if (this.starts.has(start.session_id)) continue;
      this.starts.set(start.session_id, start);
      await this.showStart(start);
    }
    if (this.list !== list || (this.stopping && !this.started)) return;
    this.listStarts();
    for (const start of kept) if (open(start.call)) this.askStart(start.session_id, "", -1);
    this.reroute();
  }

  private dropStart(start: QueuedStart): void {
    this.starts.delete(start.session_id);
    clearTimeout(this.startAsks.get(start.session_id)?.timer);
    this.startAsks.delete(start.session_id);
    this.saveStarts();
  }

  /**
   * Each start against Cloud's list: one whose chat the list carries now is over (the list's own summary is the chat
   * from here; another workspace id than the one it opened under is noted, startMoved). One whose computer is up and
   * has not made the chat is asked about (askStart), since a start that failed there puts nothing on the list.
   */
  private tendStarts(): void {
    const list = this.list;
    if (!list || this.starts.size === 0) return;
    let over = false;
    const live = liveRuntimes(list.get().runtimes);
    for (const start of [...this.starts.values()]) {
      const carried = list.carried(start.session_id, start.workspace_id);
      const runtime = live.get(start.start.computer_id)?.runtime_id;
      if (carried) {
        if (carried.workspace_id !== start.workspace_id) this.movedStarts.set(start.workspace_id, carried.workspace_id);
        this.dropStart(start);
        over = true;
      } else if (runtime !== undefined && this.startAsks.get(start.session_id)?.runtime !== runtime && open(start.call)) {
        this.askStart(start.session_id, runtime, 0);
      }
    }
    if (over) {
      this.listStarts();
      this.notify();
    }
  }

  /**
   * Asks Cloud what became of a start's call: for `runtime`, its computer's runtime now, START_ASKS_MS[attempt] from
   * now and then at the next while the call is still open; attempt -1 (a reload), now and once.
   */
  private askStart(sessionId: string, runtime: string, attempt: number): void {
    clearTimeout(this.startAsks.get(sessionId)?.timer);
    const ask = () => {
      this.startAsks.set(sessionId, { runtime, timer: undefined });
      const start = this.starts.get(sessionId);
      const api = this.options.api;
      if (!start || !api) return;
      const again = () => {
        if (attempt >= 0 && attempt + 1 < START_ASKS_MS.length && this.starts.has(sessionId) && this.startAsks.get(sessionId)?.runtime === runtime) this.askStart(sessionId, runtime, attempt + 1);
      };
      void api.callState(sessionId, start.call.request_id).then((call) => {
        const now = this.starts.get(sessionId);
        if (!now) return;
        if (open(call)) {
          if (call.status !== now.call.status) this.startSaid(now, call);
          return again();
        }
        // It ran: the chat is its computer's, under the ids its answer names, and the list brings it. Read now.
        const made = call.status === "done" ? (call.result as { readonly id?: unknown } | null | undefined) : undefined;
        if (typeof made?.id === "string" && made.id !== now.workspace_id) {
          this.movedStarts.set(now.workspace_id, made.id);
          this.dropStart(now);
          this.listStarts();
          this.reroute();
        } else this.startSaid(now, call);
        if (call.status === "done") this.list?.lookAgain();
      }, again);
    };
    this.startAsks.set(sessionId, { runtime, timer: setTimeout(ask, attempt < 0 ? 0 : START_ASKS_MS[attempt]) });
  }

  /** Cloud's newer word on a start's call: under the message, and kept for a reload. */
  private startSaid(start: Start, call: CallState): void {
    const next = { ...start, call };
    this.starts.set(start.session_id, next);
    this.noteQueued(start.session_id, call);
    this.saveStarts();
    this.listStarts();
  }

  private noteQueued(sessionId: string, call: CallState): void {
    let mine = this.queued.get(sessionId);
    if (!mine) this.queued.set(sessionId, (mine = new Map()));
    mine.set(call.request_id, call);
    for (const listener of this.listeners) listener();
  }

  private schedulePrefetch(): void {
    if (!this.started) return;
    clearTimeout(this.prefetchTimer);
    this.prefetchTimer = setTimeout(() => void this.prefetchTails(), PREFETCH_DELAY_MS);
  }

  /**
   * Keeps the tails of the chats most likely opened next warm in this device's cache (S14): those that need the person,
   * those at work, then the most recent, read from Cloud's copy (no computer woken, no socket opened). Bounded: a few
   * chats a pass, a few pages each, one at a time; the cache's own bounds evict the rest. Returns how many it filled.
   */
  async prefetchTails(): Promise<number> {
    const api = this.options.api;
    const list = this.list?.get();
    const cache = this.cache;
    if (!api || !list || this.prefetching) return 0;
    this.prefetching = true;
    let filled = 0;
    try {
      const rank = (c: ChatSummary) => (c.status === "needs_you" ? 0 : c.status === "working" ? 1 : 2);
      const candidates = [...list.chats.values()]
        .filter((c) => !c.archived && (c.kind === "chat" || c.kind === "builder") && (c.synced_through ?? 0) > 0 && !this.open.has(c.session_id))
        .sort((a, b) => rank(a) - rank(b) || b.last_activity_at.localeCompare(a.last_activity_at))
        .slice(0, PREFETCH_CHATS);
      for (const chat of candidates) {
        if (!this.started || this.cache !== cache) break;
        // How much is held, from the cache's index: nothing read, nothing marked used (F-L3).
        const held = await cache.held(chat.session_id).catch(() => null);
        let epoch = chat.epoch;
        let through = held && held.epoch === chat.epoch ? held.through : 0;
        const copied = chat.synced_through ?? 0;
        if (through >= copied) continue;
        for (let page = 0; page < PREFETCH_PAGES && through < copied; page++) {
          const got = await api.events(chat.session_id, epoch, through).catch(() => null);
          if (!got || !this.started || this.cache !== cache) break;
          if (got.reset) {
            await cache.forget(chat.session_id).catch(() => undefined);
            epoch = got.epoch;
            through = 0;
            continue;
          }
          const events = got.events.map((e) => ({ ...(e.event as object), session_id: chat.session_id, cursor: e.cursor }) as SessionEvent);
          if (events.length === 0) break;
          await cache.append(chat.session_id, got.epoch, events, { warm: true }).catch(() => undefined);
          through = events[events.length - 1]!.cursor;
          if (!got.more) break;
        }
        filled++;
      }
    } finally {
      this.prefetching = false;
    }
    return filled;
  }

  private reroute(): void {
    this.revivePool();
    this.schedulePrefetch();
    this.tendStarts();
    for (const [sessionId, open] of this.open) {
      this.route(sessionId, open);
      const chat = this.summary(sessionId);
      // The relay refused its Cloud computer's runtime, or could not find it: the computer may have woken under a new
      // runtime id (Cloud mints one at every wake) that no event has told this device of. Look it up again by reading
      // Cloud's list, once for that runtime id: the list names the computer's runtime now, and the chat follows it.
      if (chat?.where.kind === "cloud" && this.pool.link(chat.runtime_id) === "unreachable" && Date.now() - (this.lookedUp.get(chat.runtime_id) ?? Number.NEGATIVE_INFINITY) > LOOK_UP_EVERY_MS) {
        this.lookedUp.set(chat.runtime_id, Date.now());
        this.list?.lookAgain();
      }
      const synced = chat?.synced_through ?? null;
      if (synced !== null && synced !== open.synced) {
        open.synced = synced;
        open.feed.copyAdvanced();
      }
      // The list spoke about this chat (the computer it moved to adopted it and wrote its summary): a subscription its
      // runtime refused while it was still taking the chat over is tried again now, not after the back-off (K11).
      const seq = chat?.seq ?? null;
      if (seq !== null && seq !== open.seq) {
        open.seq = seq;
        open.feed.retryNow();
      }
    }
    // Calls that ran are no longer this window's to show. One the list never carried may have run before this window
    // read a summary written after it was queued, or not be in one yet: only Cloud can say which.
    for (const [sessionId, mine] of this.queued) {
      const chat = this.summary(sessionId);
      const listed = new Map((chat?.calls ?? []).map((c) => [c.request_id, c] as const));
      for (const [requestId, call] of mine) {
        const now = listed.get(requestId);
        if (now) this.listedCalls.add(requestId);
        const held = this.heldForApproval.has(requestId);
        const ran = now === undefined && (this.listedCalls.has(requestId) || (call.status !== "queued" && (!held || call.status === "done")));
        if (ran || now?.status === "done") this.forgetQueued(sessionId, requestId);
        else if (now === undefined && !held && chat) this.askRan(sessionId, requestId, chat.seq);
      }
    }
    // An opening's wait ends once its chat's computer answers (or the chat no longer runs in Cloud).
    for (const sessionId of this.opened.keys()) if (!this.asleepInCloud(sessionId)) this.opened.delete(sessionId);
    this.trimPool();
    for (const listener of this.listeners) listener();
  }

  /** Asks Cloud about a queued call its list has not carried, once per summary of its chat; one that ran goes. */
  private askRan(sessionId: string, requestId: string, seq: number): void {
    const api = this.options.api;
    if (!api || this.askedCalls.get(requestId) === seq) return;
    this.askedCalls.set(requestId, seq);
    void api
      .callState(sessionId, requestId)
      .then(
        (call) => call.status !== "queued" && call.status !== "delivered",
        // Forgotten (a week after it ran); any other failure is asked again with the next summary.
        (error: unknown) => error instanceof CloudError && error.status === 404,
      )
      .then((ran) => {
        if (!ran || !this.queued.get(sessionId)?.has(requestId)) return;
        this.forgetQueued(sessionId, requestId);
        for (const listener of this.listeners) listener();
      });
  }

  private forgetQueued(sessionId: string, requestId: string): void {
    const mine = this.queued.get(sessionId);
    mine?.delete(requestId);
    if (mine?.size === 0) this.queued.delete(sessionId);
    this.heldForApproval.delete(requestId);
    this.queuedText.delete(requestId);
    this.queuedItem.delete(requestId);
    this.listedCalls.delete(requestId);
    this.askedCalls.delete(requestId);
  }

  /** A runtime the relay could not reach is tried again once Cloud's list says something new of it (K16). */
  private revivePool(): void {
    for (const [id, state] of this.list?.get().runtimes ?? []) {
      if (this.runtimesSeen.get(id) === state) continue;
      this.runtimesSeen.set(id, state);
      this.pool.revive(id);
    }
  }

  /** Once the feeds have moved: a connection nobody holds to a runtime no chat lives on any more goes now (K16). */
  private trimPool(): void {
    const list = this.list?.get();
    if (list) this.pool.keepOnly(new Set([...list.chats.values()].map((c) => c.runtime_id)));
  }

  /** Points an open feed at the best source for its chat now, holding a pooled connection while it reads from one. */
  private route(sessionId: string, open: Open): void {
    const pick = this.pick(sessionId);
    if (pick.kind === "pooled") {
      // Same runtime: its connection follows a direct path coming up or going by itself (by cursor, under the feed).
      if (open.held?.runtimeId === pick.runtimeId && !open.held.waiting) return;
      // Held while the Mac had not allowed this device: the same connection, read from now on.
      const kept = open.held?.runtimeId === pick.runtimeId ? open.held : null;
      const held = kept ? null : this.pool.acquire(pick.runtimeId);
      if (!kept) open.held?.release();
      open.held = kept ? { ...kept, waiting: false } : held ? { runtimeId: pick.runtimeId, release: held.release, client: held.client } : null;
      if (kept) return open.feed.use({ kind: "runtime", runtimeId: pick.runtimeId, client: kept.client, via: "relay" });
      // "relay": the feed labels each event by the path its connection used then (chat-feed.ts, pathOf).
      return open.feed.use(held ? { kind: "runtime", runtimeId: pick.runtimeId, client: held.client, via: "relay" } : { kind: "copy" });
    }
    if (pick.kind === "waiting") {
      // The Mac's connection stays open (its question to the person stays up, and it is ready the moment they allow
      // this device); the view reads Cloud's copy meanwhile.
      if (open.held?.runtimeId !== pick.runtimeId) {
        const held = this.pool.acquire(pick.runtimeId);
        open.held?.release();
        open.held = held ? { runtimeId: pick.runtimeId, release: held.release, client: held.client, waiting: true } : null;
      } else open.held = { ...open.held, waiting: true };
      return open.feed.use({ kind: "copy" });
    }
    open.held?.release();
    open.held = null;
    if (pick.kind === "home") open.feed.use({ kind: "runtime", runtimeId: pick.runtimeId, client: pick.client, via: this.options.homeLocal ? "loopback" : "relay" });
    else if (pick.kind === "copy") open.feed.use({ kind: "copy" });
  }

  private pick(sessionId: string): { kind: "home"; runtimeId: string; client: Client } | { kind: "pooled"; runtimeId: string } | { kind: "waiting"; runtimeId: string } | { kind: "copy" } | { kind: "none" } {
    const chat = this.summary(sessionId);
    const home = this.options.home();
    // Reading never needs a Mac's word (S13): until it allows this device, its chats read from Cloud's copy (K4).
    const waiting = chat !== undefined && this.options.api !== null && this.approvalFor(chat.runtime_id) !== null;
    if (!chat || chat.runtime_id === home.runtimeId) {
      const asleep = chat !== undefined && !this.options.homeLocal && this.offline(chat);
      if (home.client && !asleep && !waiting) return { kind: "home", runtimeId: home.runtimeId ?? "home", client: home.client };
      return chat && this.options.api ? { kind: "copy" } : { kind: "none" };
    }
    if (this.reachable(chat.runtime_id, chat)) return waiting ? { kind: "waiting", runtimeId: chat.runtime_id } : { kind: "pooled", runtimeId: chat.runtime_id };
    return this.options.api ? { kind: "copy" } : { kind: "none" };
  }
}
