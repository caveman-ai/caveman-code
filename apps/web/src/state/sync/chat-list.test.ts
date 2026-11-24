import { afterEach, expect, test } from "vitest";
import { ChatListStore } from "./chat-list.ts";
import { fakeCloud, runtime, summary, until } from "./fakes.test-support.ts";
import { memoryKv } from "./kv.ts";
import { latency } from "./latency.ts";

const stores: ChatListStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.stop();
});
const start = (cloud: ReturnType<typeof fakeCloud>, kv = memoryKv()) => {
  const store = new ChatListStore({ api: cloud.api, kv, retryMs: () => 5 });
  stores.push(store);
  void store.start();
  return store;
};

test("the list loads once, then follows the stream: chats, runtimes and chats that go", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a"));
  const store = start(cloud);
  await until(() => store.get().status === "live" && store.get().chats.has("a"));
  cloud.put(summary("b", { status: "working" }));
  cloud.runtime(runtime("rt-cloud-1", { online: false, computer_state: "suspended" }));
  await until(() => store.get().chats.has("b") && store.get().runtimes.has("rt-cloud-1"));
  expect(store.get().chats.get("b")?.status).toBe("working");
  cloud.gone("a");
  await until(() => !store.get().chats.has("a"));
  expect(store.get().seq).toBe(cloud.seq());
  expect(cloud.lists()).toBe(1);
});

test("a status change heard on the stream is a status sample via the list; other changes and the first read are none", async () => {
  latency.clear();
  const statusSamples = () => latency.stats().find((s) => s.path === "status" && s.via === "list")?.count ?? 0;
  const cloud = fakeCloud();
  cloud.put(summary("a", { last_activity_at: new Date().toISOString() }));
  const store = start(cloud);
  await until(() => store.get().status === "live" && store.get().chats.has("a"));
  cloud.put(summary("a", { title: "Renamed", last_activity_at: new Date().toISOString() }));
  await until(() => store.get().chats.get("a")?.title === "Renamed");
  expect(statusSamples()).toBe(0);
  cloud.put(summary("a", { title: "Renamed", status: "working", last_activity_at: new Date(Date.now() - 40).toISOString() }));
  await until(() => store.get().chats.get("a")?.status === "working");
  expect(statusSamples()).toBe(1);
  const sample = latency.stats().find((s) => s.path === "status")!;
  expect(sample.p50).toBeGreaterThanOrEqual(40);
  expect(sample.p50).toBeLessThan(5_000);
  latency.clear();
});

test("a dropped stream resumes from the last seq it saw, with no second full read", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a"));
  const store = start(cloud);
  await until(() => store.get().status === "live");
  const seqBefore = store.get().seq;
  cloud.dropStreams();
  cloud.put(summary("b")); // while the device is away
  await until(() => store.get().chats.has("b"));
  expect(cloud.streamAfters).toEqual([seqBefore, seqBefore]);
  expect(cloud.lists()).toBe(1);
});

test("a reset (Cloud no longer has the changes since our seq) reads the whole list again", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a"));
  const kv = memoryKv();
  const first = start(cloud, kv);
  await until(() => first.get().status === "live");
  await first.flush();
  first.stop();

  // Away for long enough that Cloud forgot the changes after our seq; "a" went meanwhile.
  cloud.put(summary("b"));
  cloud.gone("a");
  cloud.compact();
  const second = start(cloud, kv);
  // The stored list paints first...
  await until(() => second.get().ready);
  // ...then the reset replaces it with Cloud's.
  await until(() => second.get().chats.has("b") && !second.get().chats.has("a") && second.get().status === "live");
  expect(cloud.lists()).toBe(2);
  expect(second.get().seq).toBe(cloud.seq());
});

test("the next launch paints the stored list at once and asks only for what changed since", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a"));
  const kv = memoryKv();
  const first = start(cloud, kv);
  await until(() => first.get().status === "live");
  await first.flush();
  const seq = first.get().seq;
  first.stop();

  cloud.setDown(true);
  const second = start(cloud, kv);
  await until(() => second.get().ready);
  expect([...second.get().chats.keys()]).toEqual(["a"]);
  expect(second.get().status).not.toBe("live");
  cloud.setDown(false);
  cloud.put(summary("b"));
  await until(() => second.get().chats.has("b"));
  expect(cloud.streamAfters.at(-1)).toBe(seq);
  expect(cloud.lists()).toBe(1);
});

test("an older version of a chat never replaces a newer one", async () => {
  const cloud = fakeCloud();
  const store = start(cloud);
  await until(() => store.get().status === "live");
  const newer = cloud.put(summary("a", { title: "new" }));
  await until(() => store.get().chats.get("a")?.title === "new");
  // A replay that carries an older version (seq below what is held) is ignored.
  cloud.chats.set("a", { ...newer, title: "old", seq: newer.seq - 1 });
  cloud.dropStreams();
  await until(() => cloud.openStreams() === 1);
  expect(store.get().chats.get("a")?.title).toBe("new");
});

test("marks show at once, are kept by Cloud, and the seen cursor never moves back", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a", { head: 10, person: { seen_cursor: 6, pinned: false } }));
  const store = start(cloud);
  await until(() => store.get().chats.has("a"));
  const pin = store.setState("a", { pinned: true });
  expect(store.get().chats.get("a")?.person.pinned).toBe(true); // before Cloud answers
  await pin;
  await store.setState("a", { seen_cursor: 3 });
  expect(store.get().chats.get("a")?.person.seen_cursor).toBe(6);
  expect(cloud.chats.get("a")?.person).toMatchObject({ pinned: true, seen_cursor: 6 });
});

test("a refused mark is taken back", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a"));
  const store = start(cloud);
  await until(() => store.get().chats.has("a"));
  cloud.chats.delete("a"); // Cloud no longer has it: the PUT is refused
  await expect(store.setState("a", { pinned: true })).rejects.toThrow();
  expect(store.get().chats.get("a")?.person.pinned).toBe(false);
});

test("signed out stops following and says so", async () => {
  const cloud = fakeCloud();
  const { SignedOut } = await import("./cloud-api.ts");
  const store = new ChatListStore({ api: { ...cloud.api, list: async () => Promise.reject(new SignedOut()) }, kv: memoryKv(), retryMs: () => 5 });
  stores.push(store);
  await store.start();
  expect(store.get().status).toBe("signed_out");
});

// ------------------------------------------------------------ F-6, F-7: a stream that is alive, and says who is here

test("a stream silent past its limit (a half-open socket) is dropped and opened again from the same seq", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a"));
  cloud.goSilent(true);
  const store = new ChatListStore({ api: cloud.api, kv: memoryKv(), retryMs: () => 5, silentMs: 100, wakeups: () => () => undefined });
  stores.push(store);
  void store.start();
  await until(() => store.get().status === "live");
  const seq = store.get().seq;
  cloud.goSilent(false);
  cloud.put(summary("b")); // no stream hears it: the first one is dead
  await until(() => store.get().chats.has("b"));
  expect(cloud.streamAfters.slice(0, 2)).toEqual([seq, seq]);
});

test("the network or the window coming back opens a new stream at once, not after the backoff", async () => {
  const cloud = fakeCloud();
  let wake = () => undefined as void;
  const store = new ChatListStore({ api: cloud.api, kv: memoryKv(), retryMs: () => 60_000, wakeups: (reconnect) => ((wake = reconnect), () => undefined) });
  stores.push(store);
  void store.start();
  await until(() => store.get().status === "live");
  cloud.setDown(true);
  cloud.dropStreams(); // the stream fails; the next try waits a minute
  await until(() => store.get().status === "reconnecting");
  cloud.setDown(false);
  wake();
  await until(() => store.get().status === "live" && cloud.streamAfters.length === 2);
});

test("the stream says whether someone is at the device, and opens again when that changes", async () => {
  const cloud = fakeCloud();
  let here = false;
  const listeners = new Set<() => void>();
  const presence = { active: () => here, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
  const store = new ChatListStore({ api: cloud.api, kv: memoryKv(), retryMs: () => 5, presence, wakeups: () => () => undefined });
  stores.push(store);
  void store.start();
  await until(() => store.get().status === "live");
  here = true;
  for (const l of listeners) l();
  await until(() => cloud.streamActive.length === 2);
  expect(cloud.streamActive).toEqual([false, true]);
});

test("an open chat's read marks show at once and reach Cloud at most once a period, the latest last", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("a", { head: 1 }));
  const puts: number[] = [];
  const api = { ...cloud.api, setState: async (id: string, patch: { seen_cursor?: number }) => (puts.push(patch.seen_cursor ?? -1), cloud.api.setState(id, patch)) };
  const store = new ChatListStore({ api, kv: memoryKv(), retryMs: () => 5, seenEveryMs: 1_000, wakeups: () => () => undefined });
  stores.push(store);
  void store.start();
  await until(() => store.get().status === "live" && store.get().chats.has("a"));
  for (let head = 2; head <= 6; head++) {
    cloud.put(summary("a", { head })); // a working chat, open on this device
    await until(() => store.get().chats.get("a")?.head === head);
    store.markSeen("a", head);
    expect(store.get().chats.get("a")?.person.seen_cursor).toBe(head);
  }
  expect(puts).toEqual([2]);
  await until(() => puts.length === 2);
  expect(puts).toEqual([2, 6]);
  await until(() => store.get().chats.get("a")?.person.seen_cursor === 6);
});
