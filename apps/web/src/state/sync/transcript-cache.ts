// Opened chats kept on the device by (session, epoch, cursor) (S8): reopening one paints it at once and resumes from
// its cursor, so a phone on a slow link never downloads a long chat twice. Only a gap-free prefix of the journal is
// kept; a new epoch replaces it. Bounded by bytes and chats, least recently used out first.
import type { SessionEvent } from "@caveman-app/session-protocol";
import type { Kv } from "./kv.ts";

const PAGE = 256;
const INDEX = "tx/index";

interface Entry {
  readonly epoch: number;
  readonly through: number;
  readonly bytes: number;
  readonly used_at: number;
}
type Index = Record<string, Entry>;

export interface CachedTranscript {
  readonly epoch: number;
  readonly events: ReadonlyArray<SessionEvent>;
}

export interface TranscriptCacheOptions {
  readonly maxBytes?: number;
  readonly maxChats?: number;
  readonly now?: () => number;
}

const pageKey = (session: string, epoch: number, page: number) => `tx/${session}/p/${epoch}/${String(page).padStart(8, "0")}`;
const pagesOf = (session: string) => `tx/${session}/p/`;

export class TranscriptCache {
  private readonly maxBytes: number;
  private readonly maxChats: number;
  private readonly now: () => number;
  /** One write at a time: appends read the last page and the index before writing them. */
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  private readonly kv: Kv;

  constructor(kv: Kv, options: TranscriptCacheOptions = {}) {
    this.kv = kv;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.maxChats = options.maxChats ?? 200;
    this.now = options.now ?? Date.now;
  }

  private serial<T>(run: () => Promise<T>): Promise<T> {
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Ignore new work while finishing accepted operations, including the feed's final append. */
  async close(): Promise<void> {
    this.closed = true;
    await this.chain;
  }

  /** How much of the chat is cached (epoch, cursor through), from the index alone; does not mark it used. */
  held(session: string): Promise<{ readonly epoch: number; readonly through: number } | null> {
    if (this.closed) return Promise.resolve(null);
    return this.serial(async () => {
      const entry = ((await this.kv.get<Index>(INDEX)) ?? {})[session];
      return entry && entry.through > 0 ? { epoch: entry.epoch, through: entry.through } : null;
    });
  }

  /** The chat as cached, or null. Marks it used. */
  load(session: string): Promise<CachedTranscript | null> {
    if (this.closed) return Promise.resolve(null);
    return this.serial(async () => {
      const index = (await this.kv.get<Index>(INDEX)) ?? {};
      const entry = index[session];
      if (!entry || entry.through === 0) return null;
      const pages = await this.kv.scan<SessionEvent[]>(`${pagesOf(session)}${entry.epoch}/`);
      const events = pages.flatMap(([, page]) => page);
      // Only a gap-free prefix is ever written; anything else is a store that lost a page: start over.
      if (events.length !== entry.through || events.some((e, i) => e.cursor !== i + 1)) {
        await this.drop(index, session);
        return null;
      }
      index[session] = { ...entry, used_at: this.now() };
      await this.kv.put(INDEX, index);
      return { epoch: entry.epoch, events };
    });
  }

  /**
   * Events after what is cached, in cursor order. A new epoch replaces the chat's cache; events that would leave a
   * hole are not kept (the cache is always a prefix of the journal). `warm`: kept ahead of an open (a prefetch), so it
   * does not count as used: a chat the person opened is never evicted for one they might open.
   */
  append(session: string, epoch: number, events: ReadonlyArray<SessionEvent>, options: { readonly warm?: boolean } = {}): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.serial(async () => {
      const index = (await this.kv.get<Index>(INDEX)) ?? {};
      let entry = index[session];
      const deletes: string[] = [];
      if (entry && entry.epoch !== epoch) {
        deletes.push(...(await this.kv.scan(pagesOf(session))).map(([k]) => k));
        entry = undefined;
      }
      let through = entry?.through ?? 0;
      const fresh = events.filter((e) => e.cursor > through);
      if (fresh.length === 0 && deletes.length === 0 && entry) return;
      if (fresh.length > 0 && fresh[0]!.cursor !== through + 1) {
        // Nothing of the old epoch may outlive it, even when these events cannot be kept.
        if (deletes.length > 0) {
          delete index[session];
          await this.kv.batch([[INDEX, index]], deletes);
        }
        return;
      }
      const writes = new Map<string, SessionEvent[]>();
      let bytes = entry?.bytes ?? 0;
      for (const event of fresh) {
        if (event.cursor !== through + 1) break;
        const page = Math.floor((event.cursor - 1) / PAGE);
        const key = pageKey(session, epoch, page);
        let list = writes.get(key);
        if (!list) {
          list = (event.cursor - 1) % PAGE === 0 ? [] : ((await this.kv.get<SessionEvent[]>(key)) ?? []);
          writes.set(key, list);
        }
        list.push(event);
        bytes += JSON.stringify(event).length;
        through = event.cursor;
      }
      index[session] = { epoch, through, bytes, used_at: options.warm ? (entry?.used_at ?? 0) : this.now() };
      for (const evicted of this.overBudget(index, session)) {
        deletes.push(...(await this.kv.scan(pagesOf(evicted))).map(([k]) => k));
        delete index[evicted];
      }
      await this.kv.batch([...writes.entries(), [INDEX, index]], deletes);
    });
  }

  /** Forget a chat (its journal was rewritten and nothing of the new epoch is held yet, or it was deleted). */
  forget(session: string): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.serial(async () => this.drop((await this.kv.get<Index>(INDEX)) ?? {}, session));
  }

  private async drop(index: Index, session: string): Promise<void> {
    const keys = (await this.kv.scan(pagesOf(session))).map(([k]) => k);
    delete index[session];
    await this.kv.batch([[INDEX, index]], keys);
  }

  /** Least recently used chats to drop so the rest fit; never `keep`. */
  private overBudget(index: Index, keep: string): string[] {
    const order = Object.entries(index)
      .filter(([id]) => id !== keep)
      .sort(([, a], [, b]) => a.used_at - b.used_at);
    let bytes = Object.values(index).reduce((sum, e) => sum + e.bytes, 0);
    let chats = Object.keys(index).length;
    const out: string[] = [];
    for (const [id, entry] of order) {
      if (bytes <= this.maxBytes && chats <= this.maxChats) break;
      out.push(id);
      bytes -= entry.bytes;
      chats--;
    }
    return out;
  }
}
