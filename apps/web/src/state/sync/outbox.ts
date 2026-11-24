// The device's durable outbox (client.ts Outbox) in its key-value store: one per computer a connection reaches
// (runtimeOutbox), plus ChatSender's ("cloud"), which holds each send, stop and answer from the moment it is made until
// its computer answered it or Cloud took it, so a send made just before a reload or a crash goes out once after it, in
// order. Every open page of the device (tabs, desktop windows) shares the store, so each entry names the page that put
// it (pages.ts): a page loads its own and takes over those of pages that are gone, never those of one still open,
// which still sends them itself. Once another page goes (pages.ts watches every page it hears open, and every page
// whose entries it found), a page that reads this outbox takes that page's entries over then (`taken`), without a
// reload. A page that can no longer answer for its entries (it lost its lock) takes and sends nothing (`ours`), deletes
// none it wrote before, and rewrites one only while nobody took it over: it loads anew. A call it makes meanwhile is
// kept, under its name, for the next page to take over.
import type { Outbox, OutboxEntry } from "@caveman-app/session-protocol/client";
import type { Kv } from "./kv.ts";
import { report, type Pages } from "./pages.ts";

/** An entry as the store keeps it: the page that put it (none: put before pages had owners, so nobody's now). */
type Kept = OutboxEntry & { readonly page?: string };

const entryOf = ({ page: _page, ...entry }: Kept): OutboxEntry => entry;
const byTime = (a: OutboxEntry, b: OutboxEntry) => a.at - b.at;

/**
 * The request ids each page has written under its name in each outbox (put, or taken over), until it deleted them:
 * once it lost its lock, another page may hold any of them. Per page and scope, as several outboxes on one page can
 * share a scope.
 */
const written = new WeakMap<Pages, Map<string, Set<string>>>();
const writtenBy = (pages: Pages, scope: string): Set<string> => {
  let byScope = written.get(pages);
  if (!byScope) written.set(pages, (byScope = new Map()));
  let ids = byScope.get(scope);
  if (!ids) byScope.set(scope, (ids = new Set()));
  return ids;
};

export function kvOutbox(kv: Kv, scope: string, pages: Pages): Outbox {
  const prefix = `outbox/${scope}/`;
  const listeners = new Set<(entries: ReadonlyArray<OutboxEntry>) => boolean | void>();
  const mine = writtenBy(pages, scope);
  let stopWatching: (() => void) | undefined;

  /**
   * Takes over, under this page's name, the entries in `kept` that `ours` says are this page's to send now. Lost on
   * the way (its lock went while it read), it takes nothing more, and none: another page may be taking them now.
   */
  const takeOver = async (kept: ReadonlyArray<readonly [string, Kept]>, ours: (page: string | undefined) => Promise<boolean>): Promise<Array<OutboxEntry>> => {
    const taken: Array<OutboxEntry> = [];
    for (const [key, e] of kept) {
      if (!(await ours(e.page))) continue;
      if (!pages.owns()) return [];
      mine.add(e.request_id);
      if (e.page !== pages.id) await kv.put(key, { ...e, page: pages.id } satisfies Kept);
      taken.push(entryOf(e));
    }
    return pages.owns() ? taken.sort(byTime) : [];
  };

  /**
   * `page` went: what it left here becomes this page's, if a reader here hands it on now (`taken`; one closing says
   * no). Nobody does: it is the gone page's again, for the next page that loads this outbox.
   *
   * Each entry is this page's in the store before any reader has it. A reader acts on one at once (lets go of a call
   * Cloud cannot carry, deletes one once answered), and each write to the store applies in the order made (IndexedDB:
   * one transaction each): a rename written after the reader's delete would bring the entry back, under this page.
   * Given back only when no reader took it, so nothing has acted on it then. Each write is made only while `owns()`
   * still says this page holds its lock: lost meanwhile, another page may be taking the same entries over.
   */
  const takeGone = (page: string) =>
    pages.exclusive(scope, async () => {
      if (listeners.size === 0 || !pages.owns()) return;
      const theirs = (await kv.scan<Kept>(prefix)).filter(([, e]) => e.page === page);
      if (theirs.length === 0 || !pages.owns()) return;
      for (const [, e] of theirs) mine.add(e.request_id);
      await kv.batch(theirs.map(([key, e]) => [key, { ...e, page: pages.id } satisfies Kept] as const));
      const entries = theirs.map(([, e]) => entryOf(e)).sort(byTime);
      let handed = false;
      for (const listener of [...listeners]) {
        try {
          if (listener(entries) !== false) handed = true;
        } catch (error) {
          report(error);
        }
      }
      if (!handed && pages.owns()) await kv.batch(theirs);
    });

  return {
    load: () =>
      pages.exclusive(scope, async () => {
        // It cannot answer for any entry now: it takes none (the page loads anew).
        if (!pages.owns()) return [];
        const alive = new Map<string, boolean>();
        return takeOver(await kv.scan<Kept>(prefix), async (owner) => {
          if (owner === undefined || owner === pages.id) return true;
          if (!alive.has(owner)) alive.set(owner, await pages.alive(owner));
          if (alive.get(owner)) pages.watch(owner);
          return !alive.get(owner);
        });
      }),
    ours: () => pages.owns(),
    taken: (listener) => {
      listeners.add(listener);
      stopWatching ??= pages.onGone((page) => void takeGone(page).catch(report));
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        stopWatching?.();
        stopWatching = undefined;
      };
    },
    // A page that lost its lock rewrites an entry it wrote before (a later mark on it) only while the store still has
    // it under its name, read and written under the outbox's lock that every takeover holds: another page may have
    // taken it over. A call it never put is kept under its name, and the next page to load this outbox takes it over
    // (this one, loaded anew) if no open page took it first, so a send made in the moment before the reload is not lost.
    put: async (e) => {
      await pages.ready;
      const key = `${prefix}${e.request_id}`;
      const kept = { ...e, page: pages.id } satisfies Kept;
      if (pages.owns() || !mine.has(e.request_id)) {
        mine.add(e.request_id);
        return kv.put(key, kept);
      }
      await pages.exclusive(scope, async () => {
        if ((await kv.get<Kept>(key))?.page === pages.id) await kv.put(key, kept);
      });
    },
    // After the puts made before it, as they wait for `ready` too.
    delete: async (requestId) => {
      await pages.ready;
      if (!pages.owns()) return;
      mine.delete(requestId);
      await kv.delete(`${prefix}${requestId}`);
    },
  };
}

/**
 * The outbox of the connection to one runtime. A Mac's runtime id is its enrolment, and its calls wait under it. A
 * Cloud computer's changes at every wake (cloud-computers CONTRACT §5.3), so its calls wait under its computer
 * (`computerId`), where the runtime it wakes as finds what the one before left. What waits under the runtime's own id
 * goes out from here too, and leaves there once answered: a page from before computers kept theirs put it there, or a
 * connection opened before this device knew whose runtime it was.
 */
export function runtimeOutbox(kv: Kv, runtimeId: string | null, computerId: string | undefined, pages: Pages): Outbox {
  const byRuntime = kvOutbox(kv, `runtime/${runtimeId ?? "this-device"}`, pages);
  if (computerId === undefined) return byRuntime;
  const byComputer = kvOutbox(kv, `computer/${computerId}`, pages);
  return {
    load: async () => {
      const kept = await byComputer.load();
      const known = new Set(kept.map((e) => e.request_id));
      return [...kept, ...(await byRuntime.load()).filter((e) => !known.has(e.request_id))].sort(byTime);
    },
    ours: () => pages.owns(),
    taken: (listener) => {
      const offs = [byComputer.taken?.(listener), byRuntime.taken?.(listener)];
      return () => offs.forEach((off) => off?.());
    },
    put: (entry) => byComputer.put(entry),
    delete: async (requestId) => {
      await Promise.all([byComputer.delete(requestId), byRuntime.delete(requestId)]);
    },
  };
}

/** An outbox in a store known later (whose part of the device store it is): every load, put and delete waits for it. */
export function laterOutbox(outbox: Promise<Outbox>, pages: Pages): Outbox {
  return {
    load: () => outbox.then((o) => o.load()),
    ours: () => pages.owns(),
    taken: (listener) => {
      let off: (() => void) | undefined;
      let gone = false;
      void outbox.then((o) => {
        if (!gone) off = o.taken?.(listener);
      });
      return () => {
        gone = true;
        off?.();
      };
    },
    put: (entry) => outbox.then((o) => o.put(entry)),
    delete: (requestId) => outbox.then((o) => o.delete(requestId)),
  };
}
