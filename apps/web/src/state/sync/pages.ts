// The pages open on this device (tabs, desktop windows) that share its store. Each outbox entry names the page that put
// it, and a page takes over only what a page that is gone left (outbox.ts): a call another open page still handles is
// never sent a second time from here. Web Locks say which pages are open, and each page tells the others it is open
// (a BroadcastChannel), so each open page watches every other one's lock and takes over its calls the moment it goes.
// A page that can no longer vouch for its entries (it let go of its lock for the back/forward cache, or the platform
// took it) sends none of them again and loads anew. Where the platform has no Web Locks (a browser older than Safari
// 15.4 or Firefox 96) or refuses them (site data blocked), this page owns every entry, as every page did before pages
// had owners: the runtime and Cloud still run a request id once. (Both need a secure context, as the app's request
// ids, crypto.randomUUID, already do.)

export interface Pages {
  /** This page: every outbox entry it puts says so. */
  readonly id: string;
  /** Settled once other pages can see this one open (or it is known they cannot): an entry put before could look left over. */
  readonly ready: Promise<void>;
  /**
   * Whether this page still answers for its entries. False once it lost its lock: another page may have taken them
   * over and be sending them, so this one sends none of them again (it loads anew).
   */
  owns(): boolean;
  /** Whether the page with this id is open now (this one is). Where that cannot be told, open: `onGone` says when it goes. */
  alive(id: string): Promise<boolean>;
  /** Watch the page with this id (one found owning entries): `onGone` says when it goes. Pages that say they are open are watched already. */
  watch(id: string): void;
  /** Calls `listener` with each watched page as it goes. Returns how to stop. */
  onGone(listener: (id: string) => void): () => void;
  /**
   * Runs `take` while no other open page runs one under the same name: two pages never take over one entry. A page
   * that lost its lock runs it only so (refused the lock, it rejects): what it writes then must never land between
   * another page's takeover reading an entry and writing it.
   */
  exclusive<T>(name: string, take: () => Promise<T>): Promise<T>;
}

const LOCK = "caveman-page/";
const CHANNEL = "caveman-pages";

/** This page among the device's: Web Locks where the platform has them and lets this page use them, else onlyPage. */
export function devicePages(id: string = crypto.randomUUID()): Pages {
  const locks = (globalThis.navigator as { locks?: LockManager } | undefined)?.locks;
  if (!locks) return onlyPage(id);
  const window = globalThis as unknown as EventTarget & {
    location?: Location;
    sessionStorage?: Storage;
  };
  const reload = () => window.location?.reload();
  let storage: Storage | undefined;
  try {
    storage = window.sessionStorage;
  } catch {
    // Refused (site data blocked): nothing to count reloads in; each goes at once.
  }
  const backedOff = backedOffReload(reload, storage);
  return lockedPages(locks, id, {
    lifecycle: window,
    reload: (why) => (why === "lost" ? backedOff() : reload()),
  });
}

let windowPage: Pages | undefined;
/**
 * This window's page (devicePages), one for the document's life however often the app mounts: React runs a state
 * initializer twice in development (StrictMode), and the page it drops would hold its lock and say it is open forever.
 */
export const thisPage = (): Pages => (windowPage ??= devicePages());

export interface LockedPageOptions {
  /** The page's life: its lock is held until this settles (a browser page's never does; the platform lets go as it goes). */
  readonly life?: Promise<void>;
  /** Where pagehide and pageshow arrive (the window). */
  readonly lifecycle?: EventTarget;
  /**
   * Loads the page anew: what a page that lost its lock does, once it is shown. `lost`: the lock went while the page
   * was shown, which a platform that takes it on every load would repeat without end (back it off); `shown`: shown
   * again from the back/forward cache, which takes a navigation each time.
   */
  readonly reload?: (why: "lost" | "shown") => void;
}

const RELOADS = "caveman-page/reloads";
/** How long a reload for a lost lock counts toward the next one's wait. */
export const RELOAD_WINDOW_MS = 10 * 60_000;
/** Reloads in RELOAD_WINDOW_MS that go at once; each one after that waits twice as long as the one before. */
const RELOADS_AT_ONCE = 3;
const RELOAD_FIRST_WAIT_MS = 1_000;
const RELOAD_MAX_WAIT_MS = 60_000;

/**
 * `reload`, backed off across this tab's page lives: the reloads a lost lock caused are kept in `storage`
 * (sessionStorage outlives a reload and is the tab's own). The first RELOADS_AT_ONCE in RELOAD_WINDOW_MS go at once;
 * each one after waits twice as long as the one before, up to a minute. Asked twice, it reloads once.
 */
export function backedOffReload(
  reload: () => void,
  storage: Pick<Storage, "getItem" | "setItem"> | undefined,
  clock: { readonly now: () => number; readonly wait: (run: () => void, ms: number) => void } = {
    now: () => Date.now(),
    wait: (run, ms) => void setTimeout(run, ms),
  },
): () => void {
  let asked = false;
  return () => {
    if (asked) return;
    asked = true;
    const now = clock.now();
    let recent: Array<number> = [];
    try {
      const kept: unknown = JSON.parse(storage?.getItem(RELOADS) ?? "[]");
      if (Array.isArray(kept))
        recent = kept.filter(
          (at): at is number => typeof at === "number" && now - at < RELOAD_WINDOW_MS,
        );
    } catch {
      // Unreadable: none kept.
    }
    const over = recent.length - RELOADS_AT_ONCE;
    clock.wait(
      () => {
        try {
          storage?.setItem(RELOADS, JSON.stringify([...recent, clock.now()]));
        } catch {
          // Full or refused: it reloads all the same.
        }
        reload();
      },
      over < 0 ? 0 : Math.min(RELOAD_MAX_WAIT_MS, RELOAD_FIRST_WAIT_MS * 2 ** over),
    );
  };
}

/**
 * A lock named for the page, held for its life. A page going into the back/forward cache lets go of it (pagehide,
 * persisted): Safari takes a cached page's locks anyway (WebLockManager::suspend), Chrome would keep them, and Firefox
 * never caches a page that holds one. Every open page watching it then takes over its calls at once, and the page,
 * shown again (pageshow, persisted), loads anew under a new name instead of sending what was taken. A lock the
 * platform takes from it otherwise (its request rejects after it was granted) is lost the same way. Refused before it
 * was granted (site data blocked), this page owns every entry (onlyPage), and neither says it is open nor answers.
 */
export function lockedPages(
  locks: LockManager,
  id: string,
  options: LockedPageOptions = {},
): Pages {
  const {
    life = new Promise<void>(() => undefined),
    lifecycle,
    reload = () => undefined,
  } = options;
  let state: "asking" | "held" | "refused" | "lost" = "asking";
  /** Shown: not in the back/forward cache. A page that lost its lock there loads anew once shown. */
  let shown = true;
  let letGo!: () => void;
  const hold = new Promise<void>((resolve) => (letGo = resolve));
  let settle!: () => void;
  const ready = new Promise<void>((resolve) => (settle = resolve));
  let channel: BroadcastChannel | undefined;
  // Settles `ready` too: a page lost while it still asks (into the back/forward cache before its lock came) waits for
  // no lock, and keeps a call it makes from then on as any page that lost its lock does (outbox.ts).
  const lose = () => {
    if (state === "lost") return;
    state = "lost";
    settle();
    letGo();
    channel?.close();
    channel = undefined;
    if (shown) reload("lost");
  };
  const refuse = () => {
    state = "refused";
    settle();
  };
  try {
    locks
      .request(LOCK + id, () => {
        // Lost while it asked: it lets go of the lock the moment it comes, and stays lost.
        if (state === "lost") return undefined;
        state = "held";
        settle();
        return Promise.race([life, hold]);
      })
      .then(
        // Let go: the page's life ended, or it let go for the back/forward cache.
        () => lose(),
        // Refused before it was granted; taken from it after.
        () => (state === "asking" ? refuse() : lose()),
      );
  } catch {
    refuse();
  }
  lifecycle?.addEventListener("pagehide", (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    shown = false;
    lose();
  });
  lifecycle?.addEventListener("pageshow", (event) => {
    if (!(event as PageTransitionEvent).persisted) return;
    shown = true;
    if (state === "lost") reload("shown");
  });
  const listeners = new Set<(id: string) => void>();
  const watched = new Set<string>();
  // Only a page that holds its lock watches (refused or lost, it asks for no other page's lock), and only while it
  // holds it is it told a page went.
  const watch = (other: string) => {
    if (other === id || watched.has(other)) return;
    watched.add(other);
    void ready.then(() => {
      if (state !== "held") return;
      // Granted once the page holding it is gone; let go at once, so a page asking whether it is open sees it gone.
      locks
        .request(LOCK + other, () => undefined)
        .then(
          () => {
            watched.delete(other);
            if (state !== "held") return;
            for (const listener of [...listeners]) {
              try {
                listener(other);
              } catch (error) {
                report(error);
              }
            }
          },
          () => watched.delete(other),
        );
    });
  };
  // Every page says it is open once it holds its lock, and those open already answer: each watches all the others.
  const Channel = (globalThis as { BroadcastChannel?: typeof BroadcastChannel }).BroadcastChannel;
  if (Channel) {
    void ready.then(() => {
      if (state !== "held") return;
      const open = new Channel(CHANNEL);
      channel = open;
      (open as { unref?: () => void }).unref?.();
      open.onmessage = (
        message: MessageEvent<{ readonly open?: string; readonly here?: string }>,
      ) => {
        const other = message.data?.open ?? message.data?.here;
        if (typeof other !== "string" || other === id || state !== "held") return;
        watch(other);
        if (message.data.open !== undefined) open.postMessage({ here: id });
      };
      open.postMessage({ open: id });
    });
  }
  const only = onlyPage(id);
  return {
    id,
    ready,
    owns: () => state !== "lost",
    alive: async (other) => {
      await ready;
      if (state === "refused") return only.alive(other);
      // A page that lost its lock judges no other gone: it takes nothing over.
      if (state === "lost" || other === id) return true;
      try {
        return ((await locks.query()).held ?? []).some((lock) => lock.name === LOCK + other);
      } catch {
        // Not told: open until its lock says otherwise (watch).
        return true;
      }
    },
    watch,
    onGone: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    exclusive: async (name, take) => {
      await ready;
      if (state === "refused") return take();
      let ran = false;
      try {
        return await locks.request(`caveman-outbox/${name}`, () => ((ran = true), take()));
      } catch (error) {
        // The lock was refused, not the work: it runs all the same, but not on a page that lost its own lock.
        if (ran || state === "lost") throw error;
        return take();
      }
    },
  };
}

/** This page owns every entry: no other page is open, as far as it can tell. */
export function onlyPage(id: string = crypto.randomUUID()): Pages {
  return {
    id,
    ready: Promise.resolve(),
    owns: () => true,
    alive: async (other) => other === id,
    watch: () => undefined,
    onGone: () => () => undefined,
    exclusive: (_name, take) => take(),
  };
}

/** A listener's error, said where the platform says such things, without stopping the others. */
export const report = (error: unknown): void =>
  (globalThis as { reportError?: (error: unknown) => void }).reportError?.(error);
