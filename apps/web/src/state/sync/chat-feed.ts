// One open chat's events, from wherever they can be read right now (S4): the runtime that holds the chat while it
// is reachable, Caveman Cloud's copy while it is not, this device's cache first of all. Every source speaks the same
// (epoch, cursor), so switching between them mid-chat delivers each event once, in order, with no reload. A rewritten
// journal (a new epoch) drops everything and replays. A subscription that ends says why and comes back by itself.
import { SessionProtocolError, type Client, type Subscription } from "@caveman-app/session-protocol/client";
import { pathOf } from "@caveman-app/session-protocol/direct";
import type { Session, SessionEvent } from "@caveman-app/session-protocol";
import { eventDelay, latency, type LatencyVia } from "./latency.ts";
import type { TranscriptCache } from "./transcript-cache.ts";
import type { CopyPage } from "./wire.ts";

export type FeedSource =
  /** The runtime holding the chat, over loopback, the relay or a direct channel (`via`, for the latency meter). */
  | { readonly kind: "runtime"; readonly runtimeId: string; readonly client: Client; readonly via?: LatencyVia }
  /** Cloud's copy: the runtime is asleep or unreachable. */
  | { readonly kind: "copy" };

export type FeedState =
  | { readonly kind: "loading" }
  /** Following the runtime live. */
  | { readonly kind: "live" }
  /** The runtime's link dropped; coming back by itself. */
  | { readonly kind: "reconnecting" }
  /** Showing Cloud's copy, through `through`. */
  | { readonly kind: "copy"; readonly through: number }
  /** The runtime ended the subscription (the chat moved, its lease went): `message` says why; it retries by itself. */
  | { readonly kind: "ended"; readonly reason: string; readonly message: string };

export interface FeedSink {
  /** Drop every event held for the chat: a new epoch's events follow from cursor 1. */
  reset(epoch: number): void;
  /** Attach/cache/copy replay is a snapshot, never a new animated arrival. */
  apply(event: SessionEvent, historical: boolean): void;
  /** The runtime's attach answer (mode, access, where it was forked). */
  attached?(session: Session): void;
  /** The device's cache was shown whole: the view may paint before any source answers. */
  painted?(): void;
}

export interface ChatFeedOptions {
  readonly sessionId: string;
  readonly sink: FeedSink;
  /** Cloud's copy, a page after `after` (GET /code/chats/{id}/events). Absent: no copy to read (no Cloud). */
  readonly copy?: (epoch: number, after: number) => Promise<CopyPage>;
  /** The epoch Cloud's list says the chat is on, for a first copy read before anything else named one. */
  readonly epochHint?: () => number | undefined;
  readonly cache?: TranscriptCache;
  readonly onState?: (state: FeedState) => void;
  /** Back-off before attaching again after the runtime ended or refused the subscription. */
  readonly retryMs?: (attempt: number) => number;
  /** How long to gather events before writing them to the cache. */
  readonly cacheEveryMs?: number;
  /** Where the sink already stands (a view that kept its transcript): go on from there, not from the cache. */
  readonly start?: { readonly epoch: number | undefined; readonly cursor: number };
}

type CopyEvent = CopyPage["events"][number];

export class ChatFeed {
  private epoch: number | undefined;
  private cursor = 0;
  private source: FeedSource | null = null;
  /** Bumps on every source change and every retryNow: work started before drops what it gets. */
  private generation = 0;
  private sub: Subscription | null = null;
  private state: FeedState = { kind: "loading" };
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  /** Events past this cursor arrived live (not the attach's backlog): their delay from commit is measured. */
  private liveFrom = Number.POSITIVE_INFINITY;
  private copyReading = false;
  private copyAgain = false;
  private pendingCache: SessionEvent[] = [];
  private cacheTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly ready: Promise<void>;
  private readonly options: ChatFeedOptions;

  constructor(options: ChatFeedOptions) {
    this.options = options;
    if (options.start && options.start.cursor > 0) {
      this.epoch = options.start.epoch;
      this.cursor = options.start.cursor;
    }
    this.ready = this.fromCache();
  }

  /** (epoch, cursor) of the last event delivered. */
  position(): { readonly epoch: number | undefined; readonly cursor: number } {
    return { epoch: this.epoch, cursor: this.cursor };
  }

  current(): FeedState {
    return this.state;
  }

  /** Read from `source` from now on, continuing at the cursor delivered so far. */
  use(source: FeedSource): void {
    if (this.closed || sameSource(this.source, source)) return;
    this.source = source;
    const mine = ++this.generation;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    void this.sub?.detach().catch(() => undefined);
    this.sub = null;
    void this.ready.then(() => {
      if (mine !== this.generation || this.closed) return;
      if (source.kind === "runtime") void this.attach(mine, source.client, source.via);
      else void this.readCopy(mine);
    });
  }

  /**
   * Cloud's copy has more (the list's `synced_through` moved): read it, if that is the source, or while the runtime
   * refuses the chat (it shows the copy meanwhile).
   */
  copyAdvanced(): void {
    if (this.source?.kind !== "copy" && this.state.kind !== "ended") return;
    // While refused, the view still says why (and tries the runtime again): the copy only fills in.
    void this.readCopy(this.generation, this.source?.kind === "copy");
  }

  /**
   * Cloud's list said something new about the chat (the runtime that took it over in a move wrote its summary): a
   * subscription the runtime refused is tried again now, not after its back-off, so a chat that just landed there is
   * followed from the moment it has it (K11).
   */
  retryNow(): void {
    if (this.closed || this.state.kind !== "ended" || this.source?.kind !== "runtime") return;
    const source = this.source;
    // "ended" holds while an attach is on its way (use()'s, which reroute starts just before, or the retry timer's,
    // sent before the list spoke): under a new generation that one is let go when it answers, never held beside this.
    const mine = ++this.generation;
    clearTimeout(this.retryTimer);
    this.attempts = 0;
    void this.attach(mine, source.client, source.via);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    clearTimeout(this.retryTimer);
    void this.sub?.detach().catch(() => undefined);
    this.sub = null;
    void this.writeCache();
  }

  private setState(state: FeedState): void {
    this.state = state;
    this.options.onState?.(state);
  }

  private async fromCache(): Promise<void> {
    const cached = await this.options.cache?.load(this.options.sessionId).catch(() => null);
    if (this.closed || !cached || this.cursor > 0) return;
    this.epoch = cached.epoch;
    for (const event of cached.events) this.deliver(event, false);
    if (cached.events.length > 0) this.options.sink.painted?.();
  }

  private deliver(event: SessionEvent, persist = true, historical = true): boolean {
    if (event.cursor <= this.cursor) return true; // already shown
    if (event.cursor !== this.cursor + 1) return false; // a hole: never skip
    this.cursor = event.cursor;
    this.options.sink.apply(event, historical);
    if (persist) this.queueCache(event);
    return true;
  }

  private dropAll(epoch: number): void {
    this.epoch = epoch;
    this.cursor = 0;
    this.pendingCache = [];
    void this.options.cache?.forget(this.options.sessionId).catch(() => undefined);
    this.options.sink.reset(epoch);
  }

  private async attach(mine: number, client: Client, via?: LatencyVia): Promise<void> {
    // A feed opening on a transcript this window already holds (a chat shown again) is loading what came since, not
    // reconnecting: nothing dropped. Said as "Reconnecting", the line came and went under the chat on every switch.
    if (this.state.kind !== "ended" && this.state.kind !== "live") this.setState(this.cursor > 0 && this.state.kind !== "loading" ? { kind: "reconnecting" } : { kind: "loading" });
    this.liveFrom = Number.POSITIVE_INFINITY;
    const onEvent = (event: SessionEvent) => {
      if (mine !== this.generation) return;
      if (via && event.cursor > this.liveFrom && event.cursor > this.cursor) latency.record("event", via === "relay" ? pathOf(client) : via, eventDelay(event as SessionEvent & { committed_ms?: number }));
      this.deliver(event, true, event.cursor <= this.liveFrom);
    };
    try {
      const sub = await client.attach(this.options.sessionId, this.cursor, onEvent, {
        ...(this.epoch !== undefined ? { epoch: this.epoch } : {}),
        onReset: (epoch) => mine === this.generation && this.dropAll(epoch),
        onState: (state) => mine === this.generation && this.setState({ kind: state }),
        onError: (error) => mine === this.generation && this.ended(mine, client, error),
      });
      if (mine !== this.generation) return void sub.detach().catch(() => undefined);
      this.sub = sub;
      this.liveFrom = sub.session.head;
      this.attempts = 0;
      const epoch = sub.epoch?.();
      if (epoch !== undefined) this.epoch = epoch;
      this.options.sink.attached?.(sub.session);
      this.setState({ kind: "live" });
    } catch (error) {
      if (mine !== this.generation) return;
      this.ended(mine, client, error);
    }
  }

  /** The runtime refused or ended the subscription: say why, show the copy meanwhile, and attach again later. */
  private ended(mine: number, client: Client, error: unknown): void {
    this.sub = null;
    const reason = error instanceof SessionProtocolError ? (error.error.data?.reason ?? "internal") : "internal";
    this.setState({ kind: "ended", reason, message: endedMessage(reason, error) });
    if (this.options.copy) void this.readCopy(mine, false);
    const wait = this.options.retryMs?.(this.attempts) ?? Math.min(2_000 * 2 ** this.attempts, 60_000);
    this.attempts++;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (mine === this.generation && !this.closed) void this.attach(mine, client, this.source?.kind === "runtime" ? this.source.via : undefined);
    }, wait);
  }

  private async readCopy(mine: number, announce = true): Promise<void> {
    const copy = this.options.copy;
    if (!copy) return;
    if (this.copyReading) {
      this.copyAgain = true;
      return;
    }
    this.copyReading = true;
    try {
      let through = this.cursor;
      for (let pages = 0; pages < 1000; pages++) {
        if (mine !== this.generation || this.closed) return;
        // Cloud's copy is read by epoch: not knowing it yet (the list has not named the chat), wait for copyAdvanced.
        const epoch = this.epoch ?? this.options.epochHint?.();
        if (epoch === undefined) break;
        const page = await copy(epoch, this.cursor);
        if (mine !== this.generation || this.closed) return;
        // A fill-in shares its generation with the retried attach, which may have replayed a rewritten journal while
        // the page was out: the page's events belong to the epoch left behind.
        if (this.epoch !== undefined && this.epoch !== epoch) continue;
        if (page.reset) {
          this.dropAll(page.epoch);
          continue;
        }
        if (this.epoch === undefined) this.epoch = page.epoch;
        let hole = false;
        for (const raw of page.events) {
          if (!this.deliver(asEvent(this.options.sessionId, raw))) {
            hole = true;
            break;
          }
        }
        through = page.through;
        if (hole || !page.more || page.events.length === 0) break;
      }
      // A fill-in never says the view shows the copy: the runtime still refuses the chat, or follows it again.
      if (announce) this.setState({ kind: "copy", through });
    } catch (error) {
      if (mine === this.generation && announce) this.setState({ kind: "copy", through: this.cursor });
      void error;
    } finally {
      this.copyReading = false;
      // Asked for while this read was out, maybe by a newer source than this read's: read for what the feed shows now.
      if (this.copyAgain) {
        this.copyAgain = false;
        this.copyAdvanced();
      }
    }
  }

  private queueCache(event: SessionEvent): void {
    if (!this.options.cache) return;
    this.pendingCache.push(event);
    if (this.cacheTimer) return;
    this.cacheTimer = setTimeout(() => void this.writeCache(), this.options.cacheEveryMs ?? 1_000);
  }

  /** Writes what arrived since the last write (tests; the feed closing). */
  async writeCache(): Promise<void> {
    clearTimeout(this.cacheTimer);
    this.cacheTimer = undefined;
    const events = this.pendingCache;
    this.pendingCache = [];
    if (!this.options.cache || events.length === 0 || this.epoch === undefined) return;
    await this.options.cache.append(this.options.sessionId, this.epoch, events).catch(() => undefined);
  }
}

const sameSource = (a: FeedSource | null, b: FeedSource) =>
  a !== null && a.kind === b.kind && (a.kind === "copy" || (b.kind === "runtime" && a.client === b.client));

/** A copy row as a SessionEvent: the copy keeps each event whole in `event`. */
function asEvent(sessionId: string, raw: CopyEvent): SessionEvent {
  const whole = raw.event as Partial<SessionEvent> | null;
  if (whole && typeof whole === "object" && typeof whole.type === "string" && "payload" in whole) {
    return { ...whole, session_id: sessionId, cursor: raw.cursor, at: whole.at ?? raw.at } as SessionEvent;
  }
  return { session_id: sessionId, cursor: raw.cursor, at: raw.at, type: raw.type, payload: raw.event } as SessionEvent;
}

function endedMessage(reason: string, error: unknown): string {
  switch (reason) {
    case "lease_lost":
    case "parked":
      return "This chat moved to another computer.";
    case "not_found":
      return "This chat is not on that computer any more.";
    case "forbidden":
    case "unauthorized":
      return "That computer refused this device. Sign in again.";
    default:
      return error instanceof Error ? error.message : "The chat stopped updating.";
  }
}
