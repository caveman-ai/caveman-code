// Every chat of this person on every computer, as Caveman Cloud keeps the list (S3): read once, then followed on one
// stream per device, resumed from the last sequence number it saw, and kept in the device's store so the next launch
// paints the list at once and asks only for what changed since.
import { readEvents, SignedOut, type CloudApi } from "./cloud-api.ts";
import type { Kv } from "./kv.ts";
import { latency, statusDelay } from "./latency.ts";
import { liveRuntimes, runtimeNow } from "./chats-view.ts";
import { alwaysPresent, type Presence } from "./presence.ts";
import type { ChatList, ChatSummary, DirectAdvert, PersonState, PersonStatePatch, RuntimeState } from "./wire.ts";

export type ListStatus = "loading" | "live" | "reconnecting" | "signed_out";

export interface ChatListSnapshot {
  readonly status: ListStatus;
  /** By session id. */
  readonly chats: ReadonlyMap<string, ChatSummary>;
  /** By runtime id. */
  readonly runtimes: ReadonlyMap<string, RuntimeState>;
  readonly seq: number;
  /** Loaded from Cloud (or this device's store) at least once. */
  readonly ready: boolean;
  /** The install's word on direct channels (S14), as the list last said it. */
  readonly direct?: DirectAdvert;
}

const STORE_KEY = "chats/list";
const PERSIST_MS = 500;
const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 30_000;
/** A stream that stayed up this long resets the backoff. */
const STABLE_MS = 30_000;
/** Cloud writes a keepalive every 25 s: a stream silent this long is a dead socket (a network change, a sleep). */
export const SILENT_MS = 60_000;
/** The whole list is read again on request (lookAgain) at most this often. */
export const LOOK_AGAIN_MS = 5_000;
/** An open chat's read mark goes to Cloud at most this often: each one takes a seq and reaches every device (F-L5). */
export const SEEN_EVERY_MS = 10_000;

export interface ChatListOptions {
  readonly api: CloudApi;
  readonly kv: Kv;
  /** Test seam for the backoff's clock. */
  readonly retryMs?: (attempt: number) => number;
  /** Whether the person is at this device: said on the stream (F-7), which reopens when it changes. */
  readonly presence?: Presence;
  /** Test seam: SILENT_MS. */
  readonly silentMs?: number;
  /** The network or the window came back: open a new stream now (default: the browser's `online` and a window shown). */
  readonly wakeups?: (reconnect: () => void) => () => void;
  /** Test seam: SEEN_EVERY_MS. */
  readonly seenEveryMs?: number;
  /** Test seam: LOOK_AGAIN_MS. */
  readonly lookAgainMs?: number;
  /** A chat left the person's list for good (deleted, or no longer synced): what the device keeps of it goes too. */
  readonly onGone?: (sessionId: string) => void;
}

/** `online`, and the window shown again: a stream from before may be dead without a word. */
const browserWakeups = (reconnect: () => void): (() => void) => {
  if (typeof window === "undefined" || typeof document === "undefined") return () => undefined;
  const shown = () => document.visibilityState === "visible" && reconnect();
  window.addEventListener("online", reconnect);
  document.addEventListener("visibilitychange", shown);
  return () => {
    window.removeEventListener("online", reconnect);
    document.removeEventListener("visibilitychange", shown);
  };
};

export class ChatListStore {
  private chats = new Map<string, ChatSummary>();
  private runtimes = new Map<string, RuntimeState>();
  private direct: DirectAdvert | undefined;
  private seq = 0;
  private status: ListStatus = "loading";
  private ready = false;
  private snapshot: ChatListSnapshot;
  private readonly listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private stopped = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  /** Marks sent and not answered, by session: shown at once, undone if Cloud refuses them. */
  private readonly marks = new Map<string, { readonly id: number; readonly person: PersonState }>();
  private markIds = 0;
  private running: Promise<void> | null = null;
  /** Bumps on every start: a loop from before a stop and start ends quietly. */
  private runs = 0;
  /** Ends the backoff wait at once (reconnect). */
  private waking: (() => void) | null = null;
  /** reconnect() asked for a new stream now. */
  private reopen = false;
  /** Read marks of open chats, shown at once and sent at most every SEEN_EVERY_MS (the latest one last). */
  private readonly seen = new Map<string, { cursor: number; sentAt: number; timer: ReturnType<typeof setTimeout> | undefined }>();
  private offs: Array<() => void> = [];
  /** When the list was last read again on request (lookAgain). */
  private lookedAt = Number.NEGATIVE_INFINITY;
  /** Chats this device started in Cloud that Cloud's list does not carry yet (starting), by session. */
  private started: ReadonlyMap<string, ChatSummary> = new Map();

  private readonly options: ChatListOptions;

  constructor(options: ChatListOptions) {
    this.options = options;
    this.snapshot = this.make();
  }

  get = (): ChatListSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Paints the stored list, then follows Cloud until stop(). */
  start(): Promise<void> {
    if (this.running && !this.stopped) return this.running;
    this.stopped = false;
    const reconnect = () => this.reconnect();
    this.offs = [(this.options.presence ?? alwaysPresent).subscribe(reconnect), (this.options.wakeups ?? browserWakeups)(reconnect)];
    this.running = this.run(++this.runs);
    return this.running;
  }

  stop(): void {
    this.stopped = true;
    for (const off of this.offs.splice(0)) off();
    for (const mark of this.seen.values()) clearTimeout(mark.timer);
    this.abort?.abort();
    clearTimeout(this.persistTimer);
  }

  /** Drops the stream and opens a new one now, from the same seq (the network came back, presence changed). */
  reconnect(): void {
    if (this.stopped) return;
    this.reopen = true;
    this.abort?.abort();
    this.waking?.();
  }

  /**
   * Reads the whole list again now, beside the stream: a runtime this device was sent to refused it or could not be
   * found, and its Cloud computer may have woken under a new runtime id no event has told of yet (hub.ts). At most
   * once every LOOK_AGAIN_MS; a read that fails leaves the list as it is.
   */
  lookAgain(): void {
    if (this.stopped || !this.ready || Date.now() - this.lookedAt < (this.options.lookAgainMs ?? LOOK_AGAIN_MS)) return;
    this.lookedAt = Date.now();
    void this.refetch().catch(() => undefined);
  }

  /**
   * The chats this device started in Cloud whose computer has not made them yet (hub.ts `startQueued`): each is listed
   * from Send, as its own summary will be, until Cloud's list carries its session or its workspace. All of them, each
   * time: one left out is gone.
   */
  starting(chats: ReadonlyArray<ChatSummary>): void {
    this.started = new Map(chats.map((c) => [c.session_id, c]));
    this.publish();
  }

  /** The chat as Cloud's own list carries it, by its session or else its workspace: never one only this device started. */
  carried(sessionId: string, workspaceId: string): ChatSummary | undefined {
    const chat = this.chats.get(sessionId);
    if (chat) return chat;
    for (const other of this.chats.values()) if (other.workspace_id === workspaceId) return other;
    return undefined;
  }

  /**
   * The person read an open chat through `cursor`: shown at once, sent to Cloud at once if none went in the last
   * SEEN_EVERY_MS, else once that is up with the latest cursor. A working chat's every event never becomes a write.
   */
  markSeen(sessionId: string, cursor: number): void {
    const chat = this.chats.get(sessionId);
    if (!chat || cursor <= chat.person.seen_cursor) return;
    const mark = this.seen.get(sessionId) ?? { cursor: 0, sentAt: Number.NEGATIVE_INFINITY, timer: undefined };
    this.seen.set(sessionId, mark);
    if (cursor <= mark.cursor) return;
    mark.cursor = cursor;
    this.publish();
    if (mark.timer !== undefined) return;
    const send = () => {
      mark.timer = undefined;
      mark.sentAt = Date.now();
      void this.setState(sessionId, { seen_cursor: mark.cursor }).catch(() => undefined);
    };
    const wait = mark.sentAt + (this.options.seenEveryMs ?? SEEN_EVERY_MS) - Date.now();
    if (wait <= 0) send();
    else mark.timer = setTimeout(send, wait);
  }

  /** The person's marks on a chat (read, pinned, done, snoozed), shown at once and kept by Cloud for every device. */
  async setState(sessionId: string, patch: PersonStatePatch): Promise<void> {
    const chat = this.chats.get(sessionId);
    if (!chat) throw new Error("That chat is not in your list.");
    const shown = this.marks.get(sessionId)?.person ?? chat.person;
    const id = ++this.markIds;
    this.marks.set(sessionId, { id, person: applyPatch(shown, patch) });
    this.publish();
    try {
      const person = await this.options.api.setState(sessionId, patch);
      const now = this.chats.get(sessionId);
      if (now) this.chats.set(sessionId, { ...now, person: { ...person, seen_cursor: Math.max(person.seen_cursor, now.person.seen_cursor) } });
    } finally {
      if (this.marks.get(sessionId)?.id === id) this.marks.delete(sessionId);
      this.publish();
      this.persist();
    }
  }

  private async run(id: number): Promise<void> {
    const over = () => this.stopped || id !== this.runs;
    const stored = await this.options.kv.get<ChatList>(STORE_KEY).catch(() => undefined);
    if (stored && !this.ready) {
      this.replace(stored);
      this.ready = true;
      this.publish();
    }
    let attempt = 0;
    while (!over()) {
      const opened = Date.now();
      try {
        if (this.seq === 0) await this.refetch();
        await this.follow();
      } catch (error) {
        if (error instanceof SignedOut) {
          this.setStatus("signed_out");
          return;
        }
        // Anything else (Cloud down, a dropped stream): the list stays as it is, marked reconnecting.
        if (over()) return;
      }
      if (over()) return;
      if (this.reopen) {
        // Asked for (reconnect): a new stream at once, not a backoff.
        this.reopen = false;
        attempt = 0;
        continue;
      }
      this.setStatus("reconnecting");
      if (Date.now() - opened > STABLE_MS) attempt = 0;
      // Between half and all of the doubling wait: a Cloud that restarts is not met by every device at once.
      const wait = this.options.retryMs?.(attempt) ?? Math.min(MIN_RETRY_MS * 2 ** attempt, MAX_RETRY_MS) * (0.5 + Math.random() / 2);
      attempt++;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        this.waking = () => (clearTimeout(timer), resolve());
      });
      this.waking = null;
    }
  }

  private async refetch(): Promise<void> {
    const list = await this.options.api.list();
    this.replace(list);
    this.ready = true;
    // Fresh from Cloud: live, whether or not the stream's first byte (which carries its headers) has come yet.
    this.status = "live";
    this.publish();
    this.persist();
  }

  /**
   * Reads the stream until it ends; a `reset` refetches the whole list and goes on from its seq. A stream with no byte
   * for SILENT_MS (not even a keepalive) is dropped, so a dead socket never leaves the list frozen and "live".
   */
  private async follow(): Promise<void> {
    const abort = (this.abort = new AbortController());
    let silence: ReturnType<typeof setTimeout> | undefined;
    const heard = () => {
      clearTimeout(silence);
      silence = setTimeout(() => abort.abort(), this.options.silentMs ?? SILENT_MS);
    };
    try {
      heard();
      const response = await this.options.api.stream(this.seq, abort.signal, (this.options.presence ?? alwaysPresent).active());
      if (!response.body) throw new Error("Caveman sent no stream");
      heard();
      this.setStatus("live");
      const body = response.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) {
            heard();
            controller.enqueue(chunk);
          },
        }),
      );
      return await this.read(body, abort);
    } finally {
      clearTimeout(silence);
    }
  }

  private async read(body: ReadableStream<Uint8Array>, abort: AbortController): Promise<void> {
    for await (const message of readEvents(body)) {
      if (this.stopped) return;
      const id = message.id !== undefined ? Number(message.id) : Number.NaN;
      switch (message.event) {
        case "chat": {
          const chat = JSON.parse(message.data) as ChatSummary;
          const held = this.chats.get(chat.session_id);
          if (!held || chat.seq >= held.seq) {
            // A status change heard on the list: S14's status path, measured from the runtime's stamp.
            const delay = statusDelay(held, chat);
            if (delay !== undefined) latency.record("status", "list", delay);
            this.chats.set(chat.session_id, chat);
          }
          this.advance(Number.isFinite(id) ? id : chat.seq);
          break;
        }
        case "gone": {
          const { session_id } = JSON.parse(message.data) as { session_id: string };
          this.chats.delete(session_id);
          this.seen.delete(session_id);
          this.options.onGone?.(session_id);
          this.advance(id);
          break;
        }
        case "runtime": {
          const runtime = JSON.parse(message.data) as RuntimeState;
          this.runtimes.set(runtime.runtime_id, runtime);
          this.advance(id);
          break;
        }
        case "reset": {
          // Cloud no longer holds the changes since our seq: read the list again, then follow from its seq.
          abort.abort();
          this.seq = 0;
          await this.refetch();
          return this.follow();
        }
        default:
          continue;
      }
      this.publish();
      this.persist();
    }
  }

  private advance(seq: number): void {
    if (Number.isFinite(seq) && seq > this.seq) this.seq = seq;
  }

  private replace(list: ChatList): void {
    this.chats = new Map(list.chats.map((c) => [c.session_id, c]));
    this.runtimes = new Map(list.runtimes.map((r) => [r.runtime_id, r]));
    this.seq = list.seq;
    this.direct = list.direct;
  }

  private setStatus(status: ListStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.publish();
  }

  private persist(): void {
    clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      const list: ChatList = { chats: [...this.chats.values()], runtimes: [...this.runtimes.values()], seq: this.seq, ...(this.direct ? { direct: this.direct } : {}) };
      void this.options.kv.put(STORE_KEY, list).catch(() => undefined);
    }, PERSIST_MS);
  }

  /** Writes the list to the store now (tests; a page about to go away). */
  async flush(): Promise<void> {
    clearTimeout(this.persistTimer);
    await this.options.kv.put(STORE_KEY, { chats: [...this.chats.values()], runtimes: [...this.runtimes.values()], seq: this.seq, ...(this.direct ? { direct: this.direct } : {}) } satisfies ChatList);
  }

  private make(): ChatListSnapshot {
    let chats: ReadonlyMap<string, ChatSummary> = this.chats;
    // A chat this device started in Cloud is listed from Send; Cloud's own summary of it takes its place.
    if (this.started.size > 0) {
      const listed = new Map(this.chats);
      for (const [id, chat] of this.started) if (this.carried(id, chat.workspace_id) === undefined) listed.set(id, chat);
      chats = listed;
    }
    // A Cloud computer that woke under a new runtime id: its chats are on that runtime, before their summaries say so.
    const live = liveRuntimes(this.runtimes);
    if (live.size > 0) {
      let moved: Map<string, ChatSummary> | undefined;
      for (const [id, chat] of chats) {
        const now = runtimeNow(chat, this.runtimes, live);
        if (now !== chat.runtime_id) (moved ??= new Map(chats)).set(id, { ...chat, runtime_id: now });
      }
      if (moved) chats = moved;
    }
    if (this.marks.size > 0 || this.seen.size > 0) {
      const shown = new Map(chats);
      for (const [id, mark] of this.marks) {
        const chat = shown.get(id);
        if (chat) shown.set(id, { ...chat, person: mark.person });
      }
      // Read marks not sent yet (markSeen) show as read already.
      for (const [id, mark] of this.seen) {
        const chat = shown.get(id);
        if (chat && mark.cursor > chat.person.seen_cursor) shown.set(id, { ...chat, person: { ...chat.person, seen_cursor: mark.cursor } });
      }
      chats = shown;
    }
    return { status: this.status, chats: new Map(chats), runtimes: new Map(this.runtimes), seq: this.seq, ready: this.ready, ...(this.direct ? { direct: this.direct } : {}) };
  }

  private publish(): void {
    this.snapshot = this.make();
    for (const listener of this.listeners) listener();
  }
}

/** A person state with a patch applied, as Cloud will answer it (seen never moves back). */
export function applyPatch(person: PersonState, patch: PersonStatePatch): PersonState {
  return {
    ...person,
    ...(patch.seen_cursor !== undefined ? { seen_cursor: Math.max(person.seen_cursor, patch.seen_cursor) } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : {}),
    ...(patch.done !== undefined ? { done_at: patch.done ? new Date().toISOString() : null } : {}),
    ...(patch.snoozed_until !== undefined ? { snoozed_until: patch.snoozed_until } : {}),
  };
}
