import { expect, test } from "vitest";
import { event, fakeCloud, fakeRuntimeClient, summary, until } from "./fakes.test-support.ts";
import { SyncHub } from "./hub.ts";
import { LOCAL_SCOPE, memoryKv, personScope, scopedKv, type Kv } from "./kv.ts";
import { onlyPage } from "./pages.ts";
import { TranscriptCache } from "./transcript-cache.ts";
import type { QueuedStart } from "../cloud.ts";

function gate() {
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  return {
    entered: entered.promise,
    release: () => released.resolve(),
    wait: () => (entered.resolve(), released.promise),
  };
}

function localHub(kv: Kv, home = fakeRuntimeClient()) {
  const hub = new SyncHub({
    pages: onlyPage(),
    api: null,
    kv,
    home: () => ({ runtimeId: "rt", client: home.client }),
    endpoint: () => null,
  });
  hub.start();
  return { hub, home };
}

test("stopping waits for an accepted append before the next fixture clears the device store", async () => {
  const device = memoryKv();
  const held = gate();
  let hold = true;
  const kv: Kv = {
    ...device,
    get: async <T>(key: string) => {
      const value = await device.get<T>(key);
      if (key === `${LOCAL_SCOPE}tx/index` && hold) {
        hold = false;
        await held.wait();
      }
      return value;
    },
  };
  const { hub } = localHub(kv);
  const oldCache = hub.cache;
  const writing = oldCache.append("s1", 1, [event("s1", 1)]);
  await held.entered;
  let stopped = false;
  const stopping = Promise.resolve(hub.stop()).then(() => {
    stopped = true;
  });
  const nextFixture = stopping.then(() => device.clear(""));
  try {
    await Promise.resolve();
    expect(stopped, "stop must not finish while an accepted append can still write").toBe(false);
  } finally {
    held.release();
    await Promise.all([writing, nextFixture]);
    await hub.stop();
  }
  const nextCache = new TranscriptCache(scopedKv(device, LOCAL_SCOPE));
  expect(await nextCache.load("s1")).toBeNull();
  await oldCache.append("s1", 1, [event("s1", 1), event("s1", 2)]);
  await hub.store().put("late", "old fixture");
  expect(await nextCache.load("s1")).toBeNull();
  expect(await device.get(`${LOCAL_SCOPE}late`)).toBeUndefined();
});

test("stop persists the feed's final events so an offline reopen paints the complete transcript", async () => {
  const device = memoryKv();
  const { hub, home } = localHub(device);
  home.append("s1");
  const shown: number[] = [];
  const feed = hub.openFeed(
    "s1",
    { reset: () => undefined, apply: (e) => void shown.push(e.cursor) },
    () => undefined,
  );
  try {
    await until(() => feed.current().kind === "live");
    await feed.writeCache();
    home.append("s1");
    expect(shown).toEqual([1, 2]);
    await hub.stop();
    expect(
      (await new TranscriptCache(scopedKv(device, LOCAL_SCOPE)).load("s1"))?.events.map(
        (e) => e.cursor,
      ),
    ).toEqual([1, 2]);
  } finally {
    await hub.stop();
  }
});

test("a prefetch answered after stop cannot write into a later fixture", async () => {
  const device = memoryKv();
  const cloud = fakeCloud();
  cloud.put(summary("s1", { synced_through: 1 }));
  cloud.copy("s1", 1, [event("s1", 1)]);
  const held = gate();
  const hub = new SyncHub({
    pages: onlyPage(),
    api: {
      ...cloud.api,
      events: async (...args) => (await held.wait(), cloud.api.events(...args)),
    },
    kv: device,
    home: () => ({ runtimeId: null, client: null }),
    endpoint: () => null,
  });
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  const fetching = hub.prefetchTails();
  await held.entered;
  try {
    await hub.stop();
    await device.clear("");
  } finally {
    held.release();
    await fetching;
    await hub.stop();
  }
  expect([...device.data.keys()]).toEqual([]);
});

test("stop waits for writes already delegated to the scoped store and leaves them persisted", async () => {
  const device = memoryKv();
  const held = gate();
  const { hub } = localHub({
    ...device,
    put: async (key, value) => {
      await held.wait();
      await device.put(key, value);
    },
  });
  const store = hub.store();
  const writing = store.put("pending", "kept");
  await held.entered;
  let stopped = false;
  const stopping = hub.stop().then(() => {
    stopped = true;
  });
  try {
    // A cache operation is not needed for this write: the scoped store owns its completion.
    await hub.cache.close();
    expect(stopped).toBe(false);
  } finally {
    held.release();
    await Promise.all([writing, stopping]);
  }
  expect(await device.get(`${LOCAL_SCOPE}pending`)).toBe("kept");
  await store.delete("pending");
  expect(await device.get(`${LOCAL_SCOPE}pending`)).toBe("kept");
});

test("a synchronous StrictMode stop/start keeps accepting final transcript events", async () => {
  const device = memoryKv();
  const { hub, home } = localHub(device);
  const firstCache = hub.cache;
  const stopping = hub.stop();
  hub.start();
  await stopping;
  expect(hub.cache).toBe(firstCache);
  home.append("s1");
  const feed = hub.openFeed(
    "s1",
    { reset: () => undefined, apply: () => undefined },
    () => undefined,
  );
  try {
    await until(() => feed.current().kind === "live");
  } finally {
    await hub.stop();
  }
  expect(
    (await new TranscriptCache(scopedKv(device, LOCAL_SCOPE)).load("s1"))?.events.map(
      (e) => e.cursor,
    ),
  ).toEqual([1]);
});

test("a restart during shutdown waits for the previous append before reading and extending it", async () => {
  const device = memoryKv();
  const held = gate();
  let hold = true;
  const { hub } = localHub({
    ...device,
    get: async <T>(key: string) => {
      const value = await device.get<T>(key);
      if (hold && key === `${LOCAL_SCOPE}tx/index`) {
        hold = false;
        await held.wait();
      }
      return value;
    },
  });
  const writing = hub.cache.append("s1", 1, [event("s1", 1)]);
  await held.entered;
  const stopping = hub.stop();
  await Promise.resolve(); // Shutdown has started; unlike the synchronous StrictMode replay.
  hub.start();
  const extending = hub.cache.append("s1", 1, [event("s1", 2)]);
  held.release();
  try {
    await Promise.all([writing, stopping, extending]);
    expect((await hub.cache.load("s1"))?.events.map((e) => e.cursor)).toEqual([1, 2]);
  } finally {
    await hub.stop();
  }
});

test("a cached read completing after its feed closed never paints into the old sink", async () => {
  const device = memoryKv();
  const held = gate();
  const { hub } = localHub(device);
  await hub.cache.append("s1", 1, [event("s1", 1)]);
  const load = hub.cache.load.bind(hub.cache);
  hub.cache.load = async (session) => {
    const cached = await load(session);
    await held.wait();
    return cached;
  };
  const shown: number[] = [];
  hub.openFeed(
    "s1",
    { reset: () => undefined, apply: (e) => void shown.push(e.cursor) },
    () => undefined,
  );
  await held.entered;
  const stopping = hub.stop();
  held.release();
  await stopping;
  expect(shown).toEqual([]);
});

test("sign-in and sign-out callbacks after stop cannot open a new writable scope", async () => {
  const device = memoryKv();
  const { hub } = localHub(device);
  await hub.stop();
  const cache = hub.cache;
  const store = hub.store();
  hub.useCloud(fakeCloud().api, "late-sign-in");
  await hub.signedOut();
  expect(hub.cache).toBe(cache);
  expect(hub.store()).toBe(store);
  await hub.cache.append("s1", 1, [event("s1", 1)]);
  expect([...device.data.keys()]).toEqual([]);
});

test("wiping a scope waits for a delegated write before clearing it", async () => {
  const device = memoryKv();
  const held = gate();
  const store = scopedKv(
    {
      ...device,
      put: async (key, value) => {
        await held.wait();
        await device.put(key, value);
      },
    },
    LOCAL_SCOPE,
  );
  const writing = store.put("secret", "old person");
  await held.entered;
  const wiping = store.wipe();
  held.release();
  await Promise.all([writing, wiping]);
  expect([...device.data.keys()]).toEqual([]);
});

test("signing the same person back in waits for the old wipe before keeping a new call", async () => {
  const device = memoryKv();
  const held = gate();
  const cloud = fakeCloud();
  const { hub } = localHub({
    ...device,
    put: async (key, value) => {
      if (key === `${personScope("alice")}outbox/cloud/old`) await held.wait();
      await device.put(key, value);
    },
  });
  hub.useCloud(cloud.api, "alice");
  const oldWrite = hub.store().put("outbox/cloud/old", { request_id: "old" });
  await held.entered;
  const wiping = hub.signedOut();
  hub.useCloud(cloud.api, "alice");
  const keeping = hub.store().put("outbox/cloud/new", { request_id: "new" });
  held.release();
  try {
    await Promise.all([oldWrite, wiping, keeping]);
    expect(await hub.store().get("outbox/cloud/new")).toEqual({ request_id: "new" });
    expect(await hub.store().get("outbox/cloud/old")).toBeUndefined();
  } finally {
    await hub.stop();
  }
});

test("stop includes a sign-out clear still in flight even when the new scope has no work", async () => {
  const device = memoryKv();
  const held = gate();
  const { hub } = localHub({
    ...device,
    clear: async (prefix) => {
      if (prefix === personScope("alice")) await held.wait();
      await device.clear(prefix);
    },
  });
  hub.useCloud(fakeCloud().api, "alice");
  const wiping = hub.signedOut();
  await held.entered;
  let stopped = false;
  const stopping = hub.stop().then(() => {
    stopped = true;
  });
  try {
    // Drain this task's microtasks while the real clear remains explicitly blocked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopped).toBe(false);
  } finally {
    held.release();
    await Promise.all([wiping, stopping]);
  }
});

test("a queued chat loaded before start is restored instead of discarded", async () => {
  const device = memoryKv();
  const cloud = fakeCloud();
  const start: QueuedStart = {
    session_id: "s-new",
    workspace_id: "w-new",
    call: {
      id: "call-start",
      request_id: "req-1",
      method: "workspace.create",
      status: "queued",
      created_at: "2026-11-13T12:00:00.000Z",
    },
    start: {
      computer_id: "box",
      workspace_id: "placed",
      repo: "acme/api",
      engine: "caveman",
      task: "Keep this queued chat",
      request_id: "req-1",
      with_task: true,
    },
  };
  cloud.startCall(start.session_id, start.call);
  await device.put(`${personScope("alice")}chats/starts`, [start]);
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    person: "alice",
    kv: device,
    home: () => ({ runtimeId: null, client: null }),
    endpoint: () => null,
  });
  try {
    // startOf is populated before showStart finishes hashing and publishes the restored chat.
    await until(() => hub.summary("s-new")?.workspace_id === "w-new");
    hub.start();
    expect(hub.startOf("s-new")).toMatchObject(start);
    expect(hub.summary("s-new")?.workspace_id).toBe("w-new");
  } finally {
    await hub.stop();
  }
});
