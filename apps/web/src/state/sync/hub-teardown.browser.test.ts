import { expect, test } from "vitest";
import { ChatFeed } from "./chat-feed.ts";
import { event, fakeCloud, fakeRuntimeClient, until } from "./fakes.test-support.ts";
import { SyncHub } from "./hub.ts";
import { indexedDbKv, LOCAL_SCOPE, personScope, scopedKv, type Kv } from "./kv.ts";
import { onlyPage } from "./pages.ts";
import { TranscriptCache } from "./transcript-cache.ts";

test("real IndexedDB keeps the final transcript, then starts a cleared fixture without late cache writes", async () => {
  const device = indexedDbKv(`hub-teardown-${crypto.randomUUID()}`);
  const home = fakeRuntimeClient();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  let hold = false;
  const kv: Kv = {
    ...device,
    get: async <T>(key: string) => {
      const value = await device.get<T>(key);
      if (hold && key === `${LOCAL_SCOPE}tx/index`) {
        hold = false;
        entered.resolve();
        await released.promise;
      }
      return value;
    },
  };
  const hub = new SyncHub({
    pages: onlyPage(),
    api: null,
    kv,
    home: () => ({ runtimeId: "rt", client: home.client }),
    endpoint: () => null,
  });
  const staleStore = hub.store();
  const staleCache = hub.cache;
  hub.start();
  home.append("s1");
  const feed = hub.openFeed(
    "s1",
    { reset: () => undefined, apply: () => undefined },
    () => undefined,
  );
  try {
    await until(() => feed.current().kind === "live");
    await feed.writeCache();
    home.append("s1");
    hold = true;
    const stopping = hub.stop();
    await entered.promise;
    let settled = false;
    void stopping.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    released.resolve();
    await stopping;

    // A reload without a source paints the final event from the actual device database.
    const cached = new TranscriptCache(scopedKv(device, LOCAL_SCOPE));
    expect((await cached.load("s1"))?.events.map((e) => e.cursor)).toEqual([1, 2]);
    const painted: number[] = [];
    const offline = new ChatFeed({
      sessionId: "s1",
      cache: cached,
      sink: { reset: () => undefined, apply: (e) => void painted.push(e.cursor) },
    });
    try {
      await until(() => painted.length === 2);
      expect(painted).toEqual([1, 2]);
    } finally {
      offline.close();
    }
    await device.clear("");
    // Old async callbacks cannot repopulate or delete anything after teardown completes.
    await staleCache.append("s1", 1, [event("s1", 1), event("s1", 2)]);
    await staleStore.put("late", "old fixture");
    expect(await cached.load("s1")).toBeNull();
    expect(await device.scan("")).toEqual([]);
  } finally {
    released.resolve();
    await hub.stop();
    await device.clear("");
  }
});

test("real IndexedDB preserves a new outbox entry after an old read and immediate same-person sign-in", async () => {
  const device = indexedDbKv(`hub-sign-out-${crypto.randomUUID()}`);
  const cloud = fakeCloud();
  const person = "alice";
  await device.put(`${personScope(person)}old`, "old session");
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    person,
    kv: device,
    home: () => ({ runtimeId: null, client: null }),
    endpoint: () => null,
  });
  hub.start();
  try {
    // Native request/transaction ordering only: no delay, fake clock or held callback.
    const reading = hub.store().get("old");
    const signingOut = hub.signedOut();
    hub.useCloud(cloud.api, person);
    const entry = {
      request_id: "new-call",
      method: "turn.submit",
      params: { session_id: "s1" },
      at: 1,
    };
    const keeping = hub.store().put("outbox/cloud/new-call", entry);
    await Promise.all([reading, signingOut, keeping]);
    expect(await device.get(`${personScope(person)}outbox/cloud/new-call`)).toEqual(entry);
    expect(await device.get(`${personScope(person)}old`)).toBeUndefined();
  } finally {
    await hub.stop();
    await device.clear("");
  }
});
