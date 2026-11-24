// A small async key-value store for what a device keeps across reloads: the chat list, cached transcripts, calls
// waiting for an answer. IndexedDB in a browser or the desktop window; memory in tests and where IndexedDB is missing
// (a private window that refuses it keeps working, it just forgets on reload).

export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  /** Every entry whose key starts with `prefix`, in key order. */
  scan<T>(prefix: string): Promise<Array<[string, T]>>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** Several writes and deletes as one transaction (a transcript page and its index). */
  batch(writes: ReadonlyArray<readonly [string, unknown]>, deletes?: ReadonlyArray<string>): Promise<void>;
  /** Deletes every entry whose key starts with `prefix`. */
  clear(prefix: string): Promise<void>;
}

/** The part of the device store kept before any Cloud sign-in (This Mac's own chats on the desktop). */
export const LOCAL_SCOPE = "local/";
/** One person's part of the device store (F-1): `person` is who Cloud says is signed in here, `org:user`. */
export const personScope = (person: string): string => `person/${encodeURIComponent(person)}/`;

/**
 * `kv` under `scope`: keys in and out are the scope's own. `close()` ignores new work and waits for operations already
 * handed to the device store, keeping their data. `wipe()` also deletes it, after those operations have settled.
 */
export function scopedKv(
  kv: Kv,
  scope: string,
  ready?: Promise<void>,
): Kv & { readonly scope: string; close(): Promise<void>; wipe(): Promise<void> } {
  let closed = false;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(work: Promise<T>): Promise<T> => {
    pending.add(work);
    void work.then(
      () => pending.delete(work),
      () => pending.delete(work),
    );
    return work;
  };
  // A restarted hub can accept work immediately, but its old stores finish before the new stores read or write.
  const run = <T>(work: () => Promise<T>) => track(ready ? ready.then(work) : work());
  const close = async () => {
    closed = true;
    // An empty replacement scope must also wait for its predecessor's shutdown or sign-out clear.
    await Promise.allSettled([ready, ...pending]);
  };
  return {
    scope,
    get: async (key) => (closed ? undefined : run(() => kv.get(scope + key))),
    scan: async (prefix) =>
      closed
        ? []
        : (await run(() => kv.scan(scope + prefix))).map(
            ([k, v]) => [k.slice(scope.length), v] as [string, never],
          ),
    put: async (key, value) => {
      if (closed) return;
      const kept = ready ? structuredClone(value) : value;
      await run(() => kv.put(scope + key, kept));
    },
    delete: async (key) => (closed ? undefined : run(() => kv.delete(scope + key))),
    batch: async (writes, deletes = []) => {
      if (closed) return;
      const kept = writes.map(([k, v]) => [scope + k, ready ? structuredClone(v) : v] as const);
      const removed = deletes.map((k) => scope + k);
      await run(() => kv.batch(kept, removed));
    },
    clear: async (prefix) => (closed ? undefined : run(() => kv.clear(scope + prefix))),
    close,
    wipe: async () => {
      await close();
      await kv.clear(scope);
    },
  };
}

/** What a device kept before the store had scopes: nobody can say whose it is, so it goes. */
export const dropUnscoped = (kv: Kv): Promise<void> => Promise.all(["chats/", "outbox/", "tx/"].map((prefix) => kv.clear(prefix))).then(() => undefined);

export function memoryKv(): Kv & { readonly data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  // structuredClone: a caller that mutates what it put or got must not change what is stored, as with IndexedDB.
  const copy = <T,>(v: T): T => (v === undefined ? v : structuredClone(v));
  return {
    data,
    get: async (key) => copy(data.get(key)) as never,
    scan: async (prefix) =>
      [...data.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, copy(v)] as [string, never]),
    put: async (key, value) => void data.set(key, copy(value)),
    delete: async (key) => void data.delete(key),
    batch: async (writes, deletes = []) => {
      for (const key of deletes) data.delete(key);
      for (const [key, value] of writes) data.set(key, copy(value));
    },
    clear: async (prefix) => {
      for (const key of [...data.keys()]) if (key.startsWith(prefix)) data.delete(key);
    },
  };
}

const STORE = "kv";

/** IndexedDB database `name`, one object store; falls back to memory when IndexedDB cannot be opened. */
export function indexedDbKv(name: string): Kv {
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return memoryKv();
  let fallback: Kv | null = null;
  const db = new Promise<IDBDatabase | null>((resolve) => {
    try {
      const open = idb.open(name, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(STORE);
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
      open.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  const done = (req: IDBRequest | IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      if ("oncomplete" in req) {
        req.oncomplete = () => resolve();
        req.onerror = () => reject(req.error);
        req.onabort = () => reject(req.error);
      } else {
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      }
    });
  const use = async <T,>(run: (store: Kv | IDBDatabase) => Promise<T>): Promise<T> => {
    const handle = await db;
    if (handle) return run(handle);
    return run((fallback ??= memoryKv()));
  };
  return {
    get: (key) =>
      use(async (h) => {
        if (!(h instanceof IDBDatabase)) return h.get(key);
        const req = h.transaction(STORE).objectStore(STORE).get(key);
        await done(req);
        return req.result as never;
      }),
    scan: (prefix) =>
      use(async (h) => {
        if (!(h instanceof IDBDatabase)) return h.scan(prefix);
        const store = h.transaction(STORE).objectStore(STORE);
        const range = IDBKeyRange.bound(prefix, `${prefix}￿`);
        const keys = store.getAllKeys(range);
        const values = store.getAll(range);
        await Promise.all([done(keys), done(values)]);
        return (keys.result as string[]).map((k, i) => [k, values.result[i]] as [string, never]);
      }),
    put: (key, value) =>
      use(async (h) => {
        if (!(h instanceof IDBDatabase)) return h.put(key, value);
        const tx = h.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(value, key);
        await done(tx);
      }),
    delete: (key) =>
      use(async (h) => {
        if (!(h instanceof IDBDatabase)) return h.delete(key);
        const tx = h.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        await done(tx);
      }),
    batch: (writes, deletes = []) =>
      use(async (h) => {
        if (!(h instanceof IDBDatabase)) return h.batch(writes, deletes);
        const tx = h.transaction(STORE, "readwrite");
        const store = tx.objectStore(STORE);
        for (const key of deletes) store.delete(key);
        for (const [key, value] of writes) store.put(value, key);
        await done(tx);
      }),
    clear: (prefix) =>
      use(async (h) => {
        if (!(h instanceof IDBDatabase)) return h.clear(prefix);
        const tx = h.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(IDBKeyRange.bound(prefix, `${prefix}\uffff`));
        await done(tx);
      }),
  };
}
