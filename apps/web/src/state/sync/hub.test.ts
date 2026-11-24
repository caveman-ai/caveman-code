import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect, ConnectionClosed, type Client, type ConnectionState, type Outbox } from "@caveman-app/session-protocol/client";
import { afterEach, expect, test, vi } from "vitest";
import { event, fakeCloud, fakeRuntimeClient, idbOrderedKv, runtime, summary, until } from "./fakes.test-support.ts";
import { liveRuntimes, runtimeNow } from "./chats-view.ts";
import { SyncHub } from "./hub.ts";
import { UNSENT_MS } from "./sender.ts";
import { memoryKv, personScope } from "./kv.ts";
import { webPerson } from "./cloud-api.ts";
import { desktopPerson } from "./desktop-cloud.ts";
import { runtimeOutbox } from "./outbox.ts";
import { deviceHooks, registerDeviceHooks } from "./device-hooks.ts";
import { submittedMessageId } from "./message-id.ts";
import type { CallState } from "./wire.ts";
import type { QueuedStart } from "../cloud.ts";
import { onlyPage, type Pages } from "./pages.ts";

/** The device's store as IndexedDB applies it (each read and write a moment later, in the order made). */
const deviceStore = () => idbOrderedKv(memoryKv());

const hubs: SyncHub[] = [];
afterEach(() => {
  for (const h of hubs.splice(0)) h.stop();
});

/** A window: This Mac's runtime as its own, Cloud's list, and fake runtimes behind the pool. */
const windowOn = (cloud: ReturnType<typeof fakeCloud>, runtimes: Record<string, ReturnType<typeof fakeRuntimeClient>>, home = fakeRuntimeClient()) => {
  const opened: string[] = [];
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: deviceStore(),
    home: () => ({ runtimeId: "rt-mac", client: home.client }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "t" }),
    connect: ((url: string, _token: unknown, onState?: (s: ConnectionState) => void) => {
      const id = url.split("/").pop()!;
      opened.push(id);
      queueMicrotask(() => onState?.("open"));
      return runtimes[id]!.client;
    }) as never,
  });
  hubs.push(hub);
  hub.start();
  return { hub, home, opened };
};
const view = () => {
  const shown: number[] = [];
  return { shown, sink: { reset: () => void (shown.length = 0), apply: (e: SessionEvent) => void shown.push(e.cursor) } };
};

test("a chat that moves from This Mac to a Cloud computer keeps its view: no reload, no duplicate, no gap", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" } }));
  const { hub, home, opened } = windowOn(cloud, { "rt-box": box });
  for (let i = 0; i < 3; i++) home.append("s1");
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 3);
  expect(opened).toEqual([]); // This Mac's own chat: no pooled connection

  // The lid moves it: the box adopted cursors 1..3 (same epoch here) and goes on.
  box.journal("s1").events = home.journal("s1").events.slice();
  box.append("s1");
  box.append("s1");
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, status: "working" }));
  await until(() => v.shown.length === 5);
  expect(v.shown).toEqual([1, 2, 3, 4, 5]);
  expect(opened).toEqual(["rt-box"]);
  expect(box.attaches.at(-1)).toMatchObject({ session: "s1", cursor: 3 });
  expect(hub.elsewhere("s1")).toBe(true);
});

test("a Cloud computer that falls asleep: the view reads Cloud's copy, then the computer again when it wakes", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub } = windowOn(cloud, { "rt-box": box });
  for (let i = 0; i < 4; i++) box.append("s1");
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 4);

  box.append("s1");
  cloud.copy("s1", 1, box.journal("s1").events.slice());
  cloud.runtime(runtime("rt-box", { online: false, computer_state: "suspended" }));
  await until(() => states.at(-1) === "copy");
  expect(v.shown).toEqual([1, 2, 3, 4, 5]);
  expect(box.active()).toBe(0); // no socket held on a sleeping computer

  box.append("s1");
  cloud.runtime(runtime("rt-box", { online: true, computer_state: "running" }));
  await until(() => v.shown.length === 6 && states.at(-1) === "live");
  expect(v.shown).toEqual([1, 2, 3, 4, 5, 6]);
});

test("a send to a sleeping computer's chat is queued in Cloud and shows as queued", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box", { online: false, computer_state: "suspended" }));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s1") !== undefined);
  const client = hub.clientFor("s1");
  const result = await client.call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "hi" } });
  // The composer's echo stays: the transcript shows it, dimmed, with where it waits.
  expect(result).toMatchObject({ disposition: "started" });
  expect(hub.queuedCalls("s1")[0]).toMatchObject({ call: { status: "queued" }, text: "hi", line: "Queued · waking Cloud computer 1", itemId: await submittedMessageId("s1", "r1") });
  expect(cloud.posted).toEqual([{ session: "s1", request_id: "r1", method: "turn.submit" }]);
  // Anything else needs the computer, and says so.
  await expect(client.call("queue.list", { session_id: "s1" })).rejects.toThrow("Cloud is asleep. This works once it's awake.");
  // It ran there: Cloud's list says done, the line goes.
  cloud.put(summary("s1", { runtime_id: "rt-box", calls: [{ id: "call-1", request_id: "r1", method: "turn.submit", status: "done", created_at: "2026-10-21T12:00:00.000Z" }] }));
  await until(() => hub.queuedCalls("s1").length === 0);
});

test("a stop queued for a sleeping computer leaves the line above the composer once it ran: Cloud's list just stops listing it", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box", { online: false, computer_state: "suspended" }));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s1") !== undefined);
  await hub.clientFor("s1").call("turn.interrupt", { request_id: "r1", session_id: "s1" });
  // Cloud's list carries a chat's open calls only: queued or delivered.
  const call: CallState = { id: "call-1", request_id: "r1", method: "turn.interrupt", status: "queued", created_at: "2026-10-21T12:00:00.000Z" };
  cloud.put(summary("s1", { runtime_id: "rt-box", calls: [call] }));
  await until(() => hub.summary("s1")?.calls.length === 1);
  expect(hub.queuedCalls("s1")).toMatchObject([{ call: { status: "queued" }, line: "Queued · waking Cloud computer 1" }]);
  // The computer woke, ran it and slept again: the list has no word of it any more.
  cloud.ran("s1", "r1");
  cloud.put(summary("s1", { runtime_id: "rt-box", calls: [] }));
  await until(() => hub.summary("s1")?.calls.length === 0);
  expect(hub.queuedCalls("s1")).toEqual([]);
});

test("a call that ran before this window read a list carrying it leaves its line too; one Cloud has not listed yet stays", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box", { online: false, computer_state: "suspended" }));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const asked = vi.spyOn(cloud.api, "callState");
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s1") !== undefined);
  await hub.clientFor("s1").call("turn.interrupt", { request_id: "r1", session_id: "s1" });
  // Cloud handed it over and the computer ran it before the list said anything of it: the next summary has no word of it.
  cloud.ran("s1", "r1");
  cloud.put(summary("s1", { runtime_id: "rt-box", title: "Ran" }));
  await until(() => hub.summary("s1")?.title === "Ran");
  await until(() => hub.queuedCalls("s1").length === 0).catch(() => undefined);
  expect(hub.queuedCalls("s1")).toEqual([]);
  // A summary Cloud wrote before it queued the next call does not list that one either, though Cloud holds it.
  await hub.clientFor("s1").call("turn.interrupt", { request_id: "r2", session_id: "s1" });
  cloud.put(summary("s1", { runtime_id: "rt-box", title: "Written before r2" }));
  await until(() => asked.mock.calls.some(([, requestId]) => requestId === "r2"));
  await Promise.all(asked.mock.results.map((r) => r.value));
  await new Promise((r) => setTimeout(r, 0));
  expect(hub.queuedCalls("s1")).toMatchObject([{ call: { request_id: "r2", status: "queued" }, line: "Queued · waking Cloud computer 1" }]);
});

test("a send to a reachable computer's chat goes over the relay, not through Cloud", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub, opened } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s1") !== undefined);
  await hub.clientFor("s1").call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "hi" } });
  expect(box.calls.map((c) => c.method)).toEqual(["turn.submit"]);
  expect(cloud.posted).toEqual([]);
  expect(opened).toEqual(["rt-box"]);
});

test("on the web, the tab's own Mac asleep: its chats read from Cloud's copy and sends queue in Cloud", async () => {
  const cloud = fakeCloud();
  const mac = fakeRuntimeClient();
  cloud.runtime(runtime("rt-mac", { kind: "laptop", online: false }));
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" } }));
  cloud.copy("s1", 1, [1, 2].map(() => mac.append("s1")));
  const hub = new SyncHub({ pages: onlyPage(), api: cloud.api, kv: deviceStore(), home: () => ({ runtimeId: "rt-mac", client: mac.client }), endpoint: () => null, homeLocal: false });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => states.at(-1) === "copy" && v.shown.length === 2);
  expect(mac.attaches).toEqual([]);
  expect(hub.routeFor("s1")).toEqual({ via: "cloud" });
});

test("a queued send's line follows Cloud: waiting for the Mac, then delivered", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-mac", { kind: "laptop", online: false }));
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" } }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s1") !== undefined);
  await hub.clientFor("s1").call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "hi" } });
  const at = "2026-10-21T12:00:00.000Z";
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" }, calls: [{ id: "call-1", request_id: "r1", method: "turn.submit", status: "queued", created_at: at, waiting: { reason: "laptop_asleep" } }] }));
  await until(() => hub.queuedCalls("s1")[0]?.line === "Waiting for Julius's MacBook");
  // Cloud moved it to a Cloud computer and delivered it there.
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, calls: [{ id: "call-1", request_id: "r1", method: "turn.submit", status: "delivered", created_at: at }] }));
  await until(() => hub.queuedCalls("s1")[0]?.line === "Delivered · api-box");
});

test("a web tab's own Mac that Cloud says is asleep: its chats go through the hub; on the desktop they never do", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-mac", { kind: "laptop", online: false }));
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" } }));
  const mac = fakeRuntimeClient();
  const web = new SyncHub({ pages: onlyPage(), api: cloud.api, kv: deviceStore(), home: () => ({ runtimeId: "rt-mac", client: mac.client }), endpoint: () => null, homeLocal: false });
  const desktop = new SyncHub({ pages: onlyPage(), api: cloud.api, kv: deviceStore(), home: () => ({ runtimeId: "rt-mac", client: mac.client }), endpoint: () => null, homeLocal: true });
  hubs.push(web, desktop);
  web.start();
  desktop.start();
  await until(() => web.summary("s1") !== undefined && desktop.summary("s1") !== undefined);
  expect(web.throughHub("s1")).toBe(true);
  expect(desktop.throughHub("s1")).toBe(false);
  cloud.runtime(runtime("rt-mac", { kind: "laptop", online: true }));
  await until(() => web.list?.get().runtimes.get("rt-mac")?.online === true);
  expect(web.throughHub("s1")).toBe(false);
});

// ------------------------------------------------------------ F-1: the device store is one person's

test("one device, two people: the next person never sees the last one's list, transcripts or waiting calls; sign-out wipes them", async () => {
  const kv = deviceStore();
  const deviceOf = (person: string, cloud: ReturnType<typeof fakeCloud>) => {
    const hub = new SyncHub({ pages: onlyPage(), api: null, kv, home: () => ({ runtimeId: null, client: null }), endpoint: () => null });
    hubs.push(hub);
    hub.start();
    hub.useCloud(cloud.api, person);
    return hub;
  };
  // Alice: a chat, its transcript cached, and a send Cloud has not confirmed (Cloud went down) waiting on the device.
  const alice = fakeCloud();
  alice.runtime(runtime("rt-a", { online: false }));
  for (let i = 1; i <= 5; i++) alice.put(summary("alice-chat", { runtime_id: "rt-a", title: "Alice's secret plan", head: i }));
  const a = deviceOf("org-1:alice", alice);
  await until(() => a.summary("alice-chat") !== undefined);
  await a.list!.flush();
  await a.cache.append("alice-chat", 1, [1, 2].map((c) => ({ session_id: "alice-chat", cursor: c, at: "2026-10-21T12:00:00.000Z", type: "message.delta", payload: { text: "secret" } }) as SessionEvent));
  alice.setDown(true);
  void a.clientFor("alice-chat").call("turn.submit", { request_id: "ra", session_id: "alice-chat", kind: "followup", input: { text: "ship it" } }).catch(() => undefined);
  await until(() => [...kv.data.keys()].some((k) => k.includes("outbox/cloud/ra")));
  a.stop();

  // Bob on the same device, before and after his list arrives: nothing of Alice's, his stream from his own seq.
  const bob = fakeCloud();
  bob.put(summary("bob-chat", { title: "Bob's chat" }));
  let release = () => undefined as void;
  const listed = new Promise<void>((r) => (release = r));
  const bobApi = { ...bob.api, list: async () => (await listed, bob.api.list()) };
  const b = deviceOf("org-1:bob", { ...bob, api: bobApi });
  await new Promise((r) => setTimeout(r, 30));
  expect([...b.list!.get().chats.keys()]).toEqual([]);
  release();
  await until(() => b.summary("bob-chat") !== undefined);
  expect([...b.list!.get().chats.keys()]).toEqual(["bob-chat"]);
  expect(bob.streamAfters[0]).toBe(bob.seq());
  expect(await b.cache.load("alice-chat")).toBeNull();
  await new Promise((r) => setTimeout(r, 30));
  expect(bob.posted).toEqual([]);

  // Alice again: hers is still hers. Then she signs out, and nothing of hers is left on the device.
  await b.list!.flush();
  b.stop();
  alice.setDown(false);
  const again = deviceOf("org-1:alice", alice);
  await until(() => again.summary("alice-chat") !== undefined);
  expect((await again.cache.load("alice-chat"))?.events).toHaveLength(2);
  const hers = again.cache;
  await again.signedOut();
  expect(again.hasCloud()).toBe(false);
  // A write still in flight from before lands nowhere.
  await hers.append("alice-chat", 1, [3].map((c) => ({ session_id: "alice-chat", cursor: c, at: "2026-10-21T12:00:00.000Z", type: "message.delta", payload: { text: "late" } }) as SessionEvent));
  expect([...kv.data.keys()].filter((k) => k.includes(encodeURIComponent("org-1:alice")))).toEqual([]);
  expect([...kv.data.keys()].some((k) => k.includes(encodeURIComponent("org-1:bob")))).toBe(true);
});

test("signing out closes the person's sender: it takes over nothing more from their outbox", async () => {
  const cloud = fakeCloud();
  let watching = 0;
  const pages: Pages = { ...onlyPage(), onGone: () => (watching++, () => void watching--) };
  const hub = new SyncHub({ pages, api: cloud.api, kv: deviceStore(), home: () => ({ runtimeId: null, client: null }), endpoint: () => null });
  hubs.push(hub);
  expect(watching).toBe(1);
  await hub.signedOut();
  expect(watching).toBe(0);
});

test("a device store from before scopes is dropped: nobody can say whose it was", async () => {
  const kv = deviceStore();
  await kv.put("chats/list", { chats: [summary("old")], runtimes: [], seq: 9 });
  await kv.put("tx/index", { old: { epoch: 1, through: 1, bytes: 1, used_at: 1 } });
  await kv.put("outbox/cloud/r1", { request_id: "r1" });
  const cloud = fakeCloud();
  const hub = new SyncHub({ pages: onlyPage(), api: cloud.api, person: "org-1:bob", kv, home: () => ({ runtimeId: null, client: null }), endpoint: () => null });
  hubs.push(hub);
  hub.start();
  await until(() => hub.list!.get().ready);
  expect(hub.summary("old")).toBeUndefined();
  await until(() => ![...kv.data.keys()].some((k) => /^(chats|tx|outbox)\//.test(k)));
});

test("who is signed in: the web asks Cloud on its cookie (renewed once); the desktop reads its runtime's enrollment", async () => {
  const answers: Array<[number, unknown]> = [[200, { user: { id: "u-1", organization_id: "org-1", email: "a@x.dev" } }]];
  const fetchFake = (async (url: string) => {
    if (url === "/api/v1/auth/refresh") return new Response(null, { status: 401 });
    const [status, body] = answers.shift()!;
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  expect(await webPerson(fetchFake)).toBe("org-1:u-1");
  answers.push([401, {}]);
  expect(await webPerson(fetchFake)).toBeNull();
  answers.push([503, {}]);
  await expect(webPerson(fetchFake)).rejects.toThrow("503");
  expect(desktopPerson({ cloud_url: "https://cloud.test", runtime_id: "rt-1" })).toBe("https://cloud.test rt-1");
  expect(desktopPerson({ cloud_url: "https://cloud.test" })).toBeNull();
});

// ------------------------------------------------------------ X-3: a send never waits on a runtime it cannot reach

/** Sockets the relay refuses until `accept`, recording every frame sent on any of them. */
const relaySockets = () => {
  const frames: string[] = [];
  let accepting = false;
  let opened = 0;
  const socket = () => {
    const ws = {
      readyState: 0,
      onopen: null as null | (() => void),
      onerror: null as null | (() => void),
      onclose: null as null | ((e: { code: number; reason: string }) => void),
      onmessage: null as null | ((m: { data: string }) => void),
      send: (frame: string) => void frames.push(frame),
      close: () => void (ws.readyState = 3),
    };
    setTimeout(() => {
      if (!accepting) return ws.onerror?.();
      opened++;
      ws.readyState = 1;
      ws.onopen?.();
    }, 5);
    return ws as unknown as WebSocket;
  };
  return { frames, socket, accept: () => (accepting = true), opened: () => opened };
};

test("a send the relay cannot carry although Cloud lists its computer online goes to Cloud's queue, and the runtime never gets it later", { timeout: 15_000 }, async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const relay = relaySockets();
  const kv = deviceStore();
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv,
    home: () => ({ runtimeId: "rt-mac", client: fakeRuntimeClient().client }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "" }),
    connect: ((url: string, token: string, onState: never, options: object) => connect(url, token, onState, { ...options, socket: relay.socket })) as never,
  });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  const client = hub.clientFor("s1");
  const send = client.call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "fix the tests" } });
  // A stop right behind it follows it to Cloud's queue, in order.
  const stop = client.call("turn.interrupt", { request_id: "r2", session_id: "s1" });
  await expect(send).resolves.toMatchObject({ disposition: "started" });
  await stop;
  expect(cloud.posted).toEqual([
    { session: "s1", request_id: "r1", method: "turn.submit" },
    { session: "s1", request_id: "r2", method: "turn.interrupt" },
  ]);
  expect(hub.queuedCalls("s1").map((q) => q.call.request_id)).toEqual(["r1", "r2"]);
  expect(await runtimeOutbox(kv, "rt-box", "c-rt-box", onlyPage()).load()).toEqual([]);
  // The relay reaches the computer again (and Cloud's list says so), and the computer ran both from Cloud's queue:
  // nothing of either goes out on it.
  relay.accept();
  cloud.runtime(runtime("rt-box"));
  cloud.ran("s1", "r1");
  cloud.ran("s1", "r2");
  await until(() => hub.reachable("rt-box"));
  void hub.clientFor("s1").call("turn.submit", { request_id: "r3", session_id: "s1", kind: "followup", input: { text: "next" } }).catch(() => undefined);
  await until(() => relay.frames.some((f) => f.includes('"r3"')), 5_000);
  await new Promise((r) => setTimeout(r, 50));
  expect(relay.frames.some((f) => f.includes('"r1"') || f.includes('"r2"'))).toBe(false);
});

/** Sockets that neither open nor fail (a relay the network left hanging) until `openNewest`, recording every frame. */
const hangingRelay = () => {
  const frames: string[] = [];
  const sockets: Array<{ readyState: number; onopen: null | (() => void) }> = [];
  const socket = () => {
    const ws = {
      readyState: 0,
      onopen: null as null | (() => void),
      onerror: null as null | (() => void),
      onclose: null as null | ((e: { code: number; reason: string }) => void),
      onmessage: null as null | ((m: { data: string }) => void),
      send: (frame: string) => void frames.push(frame),
      close: () => void (ws.readyState = 3),
    };
    sockets.push(ws);
    return ws as unknown as WebSocket;
  };
  const openNewest = () => {
    const ws = sockets.findLast((s) => s.readyState === 0)!;
    ws.readyState = 1;
    ws.onopen?.();
  };
  return { frames, sockets, socket, openNewest };
};

test("a stop right behind a send that waited out a hanging relay follows it to Cloud's queue, though the relay opens before Cloud hands the send over", { timeout: 20_000 }, async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const relay = hangingRelay();
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: deviceStore(),
    home: () => ({ runtimeId: "rt-mac", client: fakeRuntimeClient().client }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "" }),
    connect: ((url: string, token: string, onState: never, options: object) => connect(url, token, onState, { ...options, socket: relay.socket })) as never,
  });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  const client = hub.clientFor("s1");
  const send = client.call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "fix the tests" } });
  void client.call("turn.interrupt", { request_id: "r2", session_id: "s1" }).catch(() => undefined);
  // The relay neither opens nor fails for UNSENT_MS: the send goes to Cloud's queue. Its link reads "connecting", so
  // routeFor still names the runtime for the stop.
  await expect(send).resolves.toMatchObject({ disposition: "started" });
  await until(() => relay.sockets.some((s) => s.readyState === 0));
  relay.openNewest();
  await until(() => cloud.posted.some((p) => p.request_id === "r2") || relay.frames.some((f) => f.includes('"r2"')));
  // The runtime would run a stop that came over the relay before the send Cloud still holds.
  expect(relay.frames.filter((f) => f.includes('"r2"')).map((f) => (JSON.parse(f) as { method: string }).method)).toEqual([]);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
});

/**
 * A relay that carries sockets, turns them away (the computer is not connected to it) or leaves them hanging, as `set`
 * says when each one is tried; `dropOpen` loses the open one (1006). Every frame is recorded with its socket.
 */
const flakyRelay = () => {
  const frames: Array<{ readonly socket: number; readonly method: string; readonly requestId?: string }> = [];
  type Socket = { readyState: number; onopen: null | (() => void); onerror: null | (() => void); onclose: null | ((e: { code: number; reason: string }) => void); onmessage: null | ((m: { data: string }) => void); send: (frame: string) => void; close: () => void };
  const sockets: Socket[] = [];
  let mode: "carry" | "refuse" | "hang" = "carry";
  const socket = () => {
    const n = sockets.length;
    const ws: Socket = {
      readyState: 0,
      onopen: null,
      onerror: null,
      onclose: null,
      onmessage: null,
      send: (frame) => {
        const { method, params } = JSON.parse(frame) as { method: string; params?: { request_id?: string } };
        frames.push({ socket: n, method, ...(params?.request_id !== undefined ? { requestId: params.request_id } : {}) });
      },
      close: () => void (ws.readyState = 3),
    };
    sockets.push(ws);
    setTimeout(() => {
      if (ws.readyState !== 0 || mode === "hang") return;
      if (mode === "refuse") return ws.onerror?.();
      ws.readyState = 1;
      ws.onopen?.();
    }, 5);
    return ws as unknown as WebSocket;
  };
  const dropOpen = () => {
    const ws = sockets.find((s) => s.readyState === 1)!;
    ws.readyState = 3;
    ws.onclose?.({ code: 1006, reason: "" });
  };
  return { frames, socket, dropOpen, set: (next: typeof mode) => (mode = next) };
};

const hubOn = (cloud: ReturnType<typeof fakeCloud>, relay: { socket: () => WebSocket }) => {
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: deviceStore(),
    home: () => ({ runtimeId: "rt-mac", client: fakeRuntimeClient().client }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "" }),
    connect: ((url: string, token: string, onState: never, options: object) => connect(url, token, onState, { ...options, socket: relay.socket })) as never,
  });
  hubs.push(hub);
  hub.start();
  return hub;
};

test("a send out on the relay when the pool lets its connection go goes to Cloud's queue ahead of the stop behind it, and never out on the relay again", { timeout: 15_000 }, async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const relay = flakyRelay();
  const hub = hubOn(cloud, relay);
  await until(() => hub.summary("s1") !== undefined);
  const client = hub.clientFor("s1");
  const send = client.call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "fix the tests" } }).then(
    (result) => result,
    (error: unknown) => error,
  );
  await until(() => relay.frames.some((f) => f.requestId === "r1"));
  // The link goes with the send on it unanswered, and the relay then says the computer is not connected: nobody holds
  // the connection, so the pool closes it.
  relay.set("refuse");
  relay.dropOpen();
  await until(() => !hub.reachable("rt-box"));
  const stop = client.call("turn.interrupt", { request_id: "r2", session_id: "s1" });
  await stop;
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
  expect(await send).toMatchObject({ disposition: "started" });
  expect(await runtimeOutbox(hub.store(), "rt-box", "c-rt-box", onlyPage()).load()).toEqual([]);
  // The relay reaches the computer again, which ran both from Cloud's queue: neither goes out on it again.
  relay.set("carry");
  cloud.ran("s1", "r1");
  cloud.ran("s1", "r2");
  cloud.runtime(runtime("rt-box"));
  await until(() => hub.reachable("rt-box"));
  void hub.clientFor("s1").call("turn.submit", { request_id: "r3", session_id: "s1", kind: "followup", input: { text: "next" } }).catch(() => undefined);
  await until(() => relay.frames.some((f) => f.requestId === "r3"), 5_000);
  await new Promise((r) => setTimeout(r, 50));
  expect(relay.frames.filter((f) => f.requestId === "r1" || f.requestId === "r2").map((f) => f.socket)).toEqual([0]);
});

test("a stop behind a send out on the relay when the relay goes for good reaches Cloud's queue behind the send within UNSENT_MS", { timeout: 15_000 }, async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const relay = flakyRelay();
  const hub = hubOn(cloud, relay);
  await until(() => hub.summary("s1") !== undefined);
  const client = hub.clientFor("s1");
  const send = client.call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "fix the tests" } }).then(
    (result) => result,
    (error: unknown) => error,
  );
  await until(() => relay.frames.some((f) => f.requestId === "r1"));
  // The link goes with the send on it unanswered, and every later socket hangs: the link reads "connecting" for good,
  // so routeFor names the runtime for the stop, and the chat's open view would hold the connection.
  relay.set("hang");
  relay.dropOpen();
  const stop = client.call("turn.interrupt", { request_id: "r2", session_id: "s1" }).then(
    (result) => result,
    (error: unknown) => error,
  );
  await until(() => cloud.posted.length >= 2, UNSENT_MS + 2_000).catch(() => undefined);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
  expect(await send).toMatchObject({ disposition: "started" });
  expect(await stop).toEqual({});
  expect(relay.frames.filter((f) => f.requestId === "r2")).toEqual([]);
});

test("a call that went out with no answer is not sent again once its chat moved, changed epoch or waited too long", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box"));
  cloud.runtime(runtime("rt-mac", { kind: "laptop" }));
  cloud.put(summary("s1", { runtime_id: "rt-box", epoch: 2 }));
  cloud.put(summary("s2", { runtime_id: "rt-mac", epoch: 1 }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s2") !== undefined);
  const entry = (session_id: string, epoch: number, at = Date.now()) => ({ request_id: "r", method: "turn.submit" as const, params: { request_id: "r", session_id }, at, epoch });
  const box = hub.resendable("rt-box");
  expect(box(entry("s1", 2))).toBe(true);
  expect(box(entry("s1", 1))).toBe(false); // the journal was rewritten since
  expect(box(entry("s2", 1))).toBe(false); // the chat runs on the Mac now
  expect(box(entry("s1", 2, Date.now() - 11 * 60_000))).toBe(false); // the night the Mac slept
  expect(box(entry("unlisted", 1))).toBe(true);
  // The window's own runtime, as it is when asked.
  expect(hub.resendable(null)(entry("s2", 1))).toBe(true);
  expect(hub.resendable(null)(entry("s1", 2))).toBe(false);
});

test("after a reload, a send that went out is posted to Cloud's queue only while Cloud's list still places its chat where it went out, on that epoch", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box"));
  cloud.runtime(runtime("rt-c"));
  cloud.put(summary("s1", { runtime_id: "rt-c", epoch: 1 })); // moved off rt-box since
  cloud.put(summary("s2", { runtime_id: "rt-box", epoch: 2 })); // its journal rewritten since
  cloud.put(summary("s3", { runtime_id: "rt-box", epoch: 1 }));
  // What the page before the reload left in the sender's outbox: each went out on rt-box's connection at epoch 1.
  const kv = deviceStore();
  for (const session_id of ["s1", "s2", "s3"]) {
    const request_id = `${session_id}-out`;
    kv.data.set(`${personScope("")}outbox/cloud/${request_id}`, { request_id, method: "turn.submit", params: { session_id, call: { request_id, input: { text: "hi" } }, wentOut: true, runtime: "rt-box" }, at: Date.now() - 60_000, epoch: 1 });
  }
  const hub = new SyncHub({ pages: onlyPage(), api: cloud.api, kv, home: () => ({ runtimeId: "rt-mac", client: null }), endpoint: () => null });
  hubs.push(hub);
  hub.start();
  await until(() => ![...kv.data.keys()].some((key) => key.includes("outbox/cloud/")));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["s3-out"]);
});

test("Move to from a device that does not hold the chat is the person's move, through Cloud, whether its computer is up or asleep", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-mac", { kind: "laptop", computer_id: "c-mac" }));
  cloud.runtime(runtime("rt-box", { computer_id: "c-box" }));
  cloud.runtime(runtime("rt-two", { computer_id: "c-two", online: false }));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  cloud.put(summary("s2", { runtime_id: "rt-two" }));
  const { hub } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s2") !== undefined);
  await expect(hub.clientFor("s1").call("session.move", { request_id: "m1", session_id: "s1", to: { computer_id: "c-two" } })).resolves.toEqual({ pending: true });
  await hub.clientFor("s2").call("session.move", { request_id: "m2", session_id: "s2", to: "cloud" });
  expect(cloud.moves).toEqual([
    { session: "s1", to: { computer_id: "c-two" } },
    { session: "s2", to: "cloud" },
  ]);
  expect(box.calls.map((c) => c.method)).toEqual([]);
  // Checking needs the chat's computer: asked there when it is up; an asleep one leaves it to the move.
  await hub.clientFor("s1").call("session.move.check", { session_id: "s1", to: "cloud" });
  expect(box.calls.map((c) => c.method)).toEqual(["session.move.check"]);
  await expect(hub.clientFor("s2").call("session.move.check", { session_id: "s2", to: "cloud" })).resolves.toEqual({ login: null });
});

test("This Mac is never sent to the chat's computer, which would read it as the Mac the chat came from: the window's own runtime pulls it (C2)", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  // The chat came from Mac A; this window is Mac B's (its home runtime, rt-mac), awake beside a Cloud computer that is up, and one asleep.
  cloud.runtime(runtime("rt-mac", { kind: "laptop", computer_id: "c-mac" }));
  cloud.runtime(runtime("rt-mac-a", { kind: "laptop", computer_id: "c-mac-a" }));
  cloud.runtime(runtime("rt-box", { computer_id: "c-box" }));
  cloud.runtime(runtime("rt-two", { computer_id: "c-two", online: false }));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  cloud.put(summary("s2", { runtime_id: "rt-two" }));
  const { hub } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s2") !== undefined);
  for (const session of ["s1", "s2"]) {
    await expect(hub.clientFor(session).call("session.move", { request_id: `m-${session}`, session_id: session, to: "this_mac" })).rejects.toThrow(/own window/);
    await expect(hub.clientFor(session).call("session.move.check", { session_id: session, to: "this_mac" })).rejects.toThrow(/own window/);
  }
  expect(box.calls).toEqual([]);
  expect(cloud.moves).toEqual([]);
});

test("Move to from another device carries its request id and this device's signature over exactly that move", async () => {
  const signed: Array<unknown> = [];
  registerDeviceHooks({ moveFields: async (move) => (signed.push(move), { device: { device_id: "phone-1", at: "2026-10-21T23:00:00.000Z", signature: "sig" } }) });
  try {
    const cloud = fakeCloud();
    cloud.runtime(runtime("rt-mac", { kind: "laptop", computer_id: "c-mac" }));
    cloud.runtime(runtime("rt-box", { computer_id: "c-box" }));
    cloud.put(summary("s1", { runtime_id: "rt-mac" }));
    const { hub } = windowOn(cloud, {});
    await until(() => hub.summary("s1") !== undefined);
    await hub.clientFor("s1").call("session.move", { request_id: "m1", session_id: "s1", to: { computer_id: "c-box" } });
    expect(signed).toEqual([{ session_id: "s1", request_id: "m1", to: { computer_id: "c-box" } }]);
    expect(cloud.moveExtras).toEqual([{ request_id: "m1", device: { device_id: "phone-1", at: "2026-10-21T23:00:00.000Z", signature: "sig" } }]);
    // A move to a Mac that Move to signed already (moveParams) goes with that signature: one key operation per move.
    const own = { device_id: "phone-1", at: "2026-10-21T23:01:00.000Z", signature: "sig-2" };
    await hub.clientFor("s1").call("session.move", { request_id: "m2", session_id: "s1", to: { computer_id: "c-mac-2" }, device: own });
    expect(signed).toHaveLength(1);
    expect(cloud.moveExtras.at(-1)).toEqual({ request_id: "m2", device: own });
  } finally {
    registerDeviceHooks({});
  }
});

// ------------------------------------------------------------ K11: following a move without lag

test("a chat the lid moves to a Cloud computer still taking it over is followed the moment the list says it has it", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box", { computer_id: "c-box" }));
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" }, head: 2, synced_through: 2 }));
  const { hub, home } = windowOn(cloud, { "rt-box": box });
  for (let i = 0; i < 2; i++) home.append("s1");
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 2);

  // The lid: Cloud names the box at once; the box is still adopting the chat, so it refuses the subscription.
  box.refuse("not_found");
  cloud.copy("s1", 1, home.journal("s1").events.slice());
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, status: "working", head: 2, synced_through: 2 }));
  await until(() => states.at(-1) === "ended");
  const refusedAt = Date.now();

  // It has the chat now and says so in its summary: the view follows it at once, not after the 2 s back-off.
  box.refuse(undefined);
  box.journal("s1").events = home.journal("s1").events.slice();
  box.append("s1", "smoke ok");
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, status: "working", head: 3, synced_through: 2 }));
  await until(() => v.shown.length === 3, 1_000);
  expect(Date.now() - refusedAt).toBeLessThan(1_000);
  expect(v.shown).toEqual([1, 2, 3]);
  expect(states.at(-1)).toBe("live");
});

test("a chat This Mac let go of before the list named its new computer is followed there on one subscription, let go on close", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" }, head: 2, synced_through: 2 }));
  const { hub, home } = windowOn(cloud, { "rt-box": box });
  for (let i = 0; i < 2; i++) home.append("s1");
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 2 && states.at(-1) === "live");

  // The move: This Mac's lease goes first, then the box adopts the chat and its summary names it (a new seq too).
  home.end("lease_lost");
  await until(() => states.at(-1) === "ended");
  box.journal("s1").events = home.journal("s1").events.slice();
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, status: "working", head: 2, synced_through: 2 }));
  await until(() => states.at(-1) === "live");
  await new Promise((r) => setTimeout(r, 0));
  expect(box.active(), "subscriptions the open chat holds on the box").toBe(1);
  hub.close("s1");
  await new Promise((r) => setTimeout(r, 0));
  expect(box.active(), "subscriptions left on the box after the chat closed").toBe(0);
});

test("a chat on a computer this device has not heard come on line is followed once the chat's own summary says it is", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  // The box's runtime is fresh: its own "on line" change has not reached this device; the list knows it off line.
  cloud.runtime({ ...runtime("rt-box", { online: false, computer_state: "starting" }), seq: 1 });
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box", online: false } }));
  for (let i = 0; i < 2; i++) box.append("s1");
  cloud.copy("s1", 1, box.journal("s1").events.slice());
  const { hub, opened } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => states.at(-1) === "copy");
  expect(opened).toEqual([]);
  // It adopted the chat and wrote its summary, which says it is on line: attach now, not when Cloud's runtime change comes.
  box.append("s1");
  cloud.put(summary("s1", { runtime_id: "rt-box", where: { kind: "cloud", name: "api-box", online: true }, status: "working", head: 3 }));
  await until(() => v.shown.length === 3 && states.at(-1) === "live");
  expect(opened).toEqual(["rt-box"]);
  // A newer word from the runtime itself wins again.
  cloud.runtime({ ...runtime("rt-box", { online: false, computer_state: "suspended" }), seq: 1_000 });
  await until(() => states.at(-1) === "copy");
});

test("a chat that goes home lets go of its Cloud computer's connection at once, so a deleted computer is never retried", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub, home } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s1") !== undefined);
  hub.openFeed("s1", view().sink, () => undefined);
  await until(() => hub.pool.openRuntimes().includes("rt-box"));
  // Home: the chat is on This Mac again; its lid-made computer is about to be deleted.
  home.journal("s1").events = box.journal("s1").events.slice();
  cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "Julius's MacBook" } }));
  await until(() => hub.pool.openRuntimes().length === 0, 1_000);
});

// ------------------------------------------------------------ K4: a Mac that has not allowed this device yet

test("a Mac that has not allowed this browser: its chat reads from Cloud's copy with why; a send waits for the Mac, never in Cloud, and goes once allowed", async () => {
  const before = deviceHooks();
  let pending = true;
  const listeners = new Set<() => void>();
  registerDeviceHooks({
    approval: (id) => (id === "rt-mac" && pending ? { state: "pending", title: "Waiting for MacBook Pro to allow this browser", detail: "On MacBook Pro, choose Allow when it asks, and check it shows 482913. You only do this once." } : null),
    onApproval: (l) => (listeners.add(l), () => void listeners.delete(l)),
  });
  try {
    const cloud = fakeCloud();
    const mac = fakeRuntimeClient();
    cloud.runtime(runtime("rt-mac", { kind: "laptop", name: "MacBook Pro" }));
    cloud.put(summary("s1", { runtime_id: "rt-mac", where: { kind: "laptop", name: "MacBook Pro" }, head: 2, synced_through: 2 }));
    cloud.copy("s1", 1, [1, 2].map(() => mac.append("s1")));
    // The Mac's connection holds every call until the Mac allows this device (its handshake waits for that).
    let allow = () => undefined as void;
    const allowed = new Promise<void>((r) => (allow = r));
    const gated: Client = { ...mac.client, call: ((method: never, params: never, options: never) => allowed.then(() => mac.client.call(method, params, options))) as Client["call"] };
    const opened: string[] = [];
    const hub = new SyncHub({
      pages: onlyPage(),
      api: cloud.api,
      kv: deviceStore(),
      home: () => ({ runtimeId: "rt-alpha", client: fakeRuntimeClient().client }),
      endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "" }),
      connect: ((url: string, _token: unknown, onState?: (s: ConnectionState) => void) => {
        opened.push(url.split("/").pop()!);
        queueMicrotask(() => onState?.("open"));
        return gated;
      }) as never,
    });
    hubs.push(hub);
    hub.start();
    await until(() => hub.summary("s1") !== undefined);
    const v = view();
    const states: string[] = [];
    hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
    await until(() => v.shown.length === 2 && states.at(-1) === "copy");
    expect(mac.attaches).toEqual([]); // the Mac serves nothing to this browser yet: never asked
    expect(opened).toEqual(["rt-mac"]); // its connection stays open, so its question to the person stays up
    expect(hub.approvalFor("rt-mac")?.detail).toContain("482913");
    expect(hub.routeFor("s1")).toMatchObject({ via: "runtime" });
    expect(hub.routeFor("s1")).not.toHaveProperty("orCloud");

    const result = await hub.clientFor("s1").call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "hi" } });
    expect(result).toMatchObject({ disposition: "started" });
    expect(hub.queuedCalls("s1")).toMatchObject([{ text: "hi", line: "Waiting for MacBook Pro to allow this browser" }]);
    expect(cloud.posted).toEqual([]); // Cloud would hand it to a Mac that refuses it

    // The person allows this browser on the Mac: the send goes, and the view reads the Mac from where the copy ended.
    pending = false;
    allow();
    for (const l of listeners) l();
    await until(() => mac.calls.some((c) => c.method === "turn.submit"));
    await until(() => mac.attaches.length === 1);
    expect(mac.attaches[0]).toMatchObject({ cursor: 2 });
    await until(() => hub.queuedCalls("s1").every((q) => q.line === null));
  } finally {
    registerDeviceHooks(before);
  }
});

// ------------------------------------------------------------ S14

test("typing in an asleep Cloud computer's chat wakes it instead of warming an engine; a Mac is never asked", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box", { online: false, computer_state: "suspended" }));
  cloud.runtime(runtime("rt-laptop", { kind: "laptop", online: false }));
  cloud.put(summary("s1", { runtime_id: "rt-box", computer_id: "c-box" }));
  cloud.put(summary("s2", { runtime_id: "rt-laptop", computer_id: "c-laptop", where: { kind: "laptop", name: "Work MacBook" } }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s2") !== undefined);
  await hub.clientFor("s1").call("turn.prewarm", { request_id: "p1", session_id: "s1", options: {} });
  await hub.clientFor("s1").call("turn.prewarm", { request_id: "p2", session_id: "s1", options: {} });
  await hub.clientFor("s2").call("turn.prewarm", { request_id: "p3", session_id: "s2", options: {} });
  expect(cloud.wakeHints).toEqual([{ computerId: "c-box", reason: "typing" }]);
});

test("a reachable computer's chat is warmed over its connection while typing, on any device", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s1") !== undefined);
  await hub.clientFor("s1").call("turn.prewarm", { request_id: "p1", session_id: "s1", options: {} });
  expect(box.calls.map((c) => c.method)).toEqual(["turn.prewarm"]);
  expect(cloud.wakeHints).toEqual([]);
});

test("a device that connects wakes nothing: not for chats active a minute ago, not when someone comes to it", async () => {
  const cloud = fakeCloud();
  const recent = new Date(Date.now() - 60_000).toISOString();
  cloud.runtime(runtime("rt-a", { online: false, computer_state: "suspended" }));
  cloud.runtime(runtime("rt-c", { online: false, computer_state: "suspended" }));
  cloud.put(summary("a1", { runtime_id: "rt-a", computer_id: "c-a", last_activity_at: recent }));
  cloud.put(summary("c1", { runtime_id: "rt-c", computer_id: "c-c", last_activity_at: recent, status: "needs_you", needs_you: { kind: "approval", summary: "Deploy?" } }));
  let here = false;
  const listeners = new Set<() => void>();
  const presence = { active: () => here, subscribe: (l: () => void) => (listeners.add(l), () => void listeners.delete(l)) };
  const hub = new SyncHub({ pages: onlyPage(), api: cloud.api, kv: deviceStore(), home: () => ({ runtimeId: null, client: null }), endpoint: () => null, presence });
  hubs.push(hub);
  hub.start();
  await until(() => hub.list?.get().status === "live" && hub.summary("c1") !== undefined);
  here = true;
  for (const l of listeners) l();
  await new Promise((r) => setTimeout(r, 30));
  expect(cloud.wakeHints).toEqual([]);
  expect(cloud.resumes).toEqual([]);
});

test("an open chat wakes nothing, however long it is read and though it needs you; opening something that needs its computer does, once", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const cloud = fakeCloud();
    const old = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
    cloud.runtime(runtime("rt-a", { online: false, computer_state: "suspended" }));
    cloud.runtime(runtime("rt-c", { online: false, computer_state: "suspended" }));
    cloud.runtime(runtime("rt-laptop", { kind: "laptop", online: false }));
    cloud.put(summary("a1", { runtime_id: "rt-a", computer_id: "c-a", last_activity_at: old }));
    cloud.put(summary("c1", { runtime_id: "rt-c", computer_id: "c-c", last_activity_at: old, status: "needs_you", needs_you: { kind: "approval", summary: "Deploy?" } }));
    cloud.put(summary("m1", { runtime_id: "rt-laptop", computer_id: "c-laptop", last_activity_at: old, where: { kind: "laptop", name: "Work MacBook" } }));
    const { hub } = windowOn(cloud, {});
    await vi.waitUntil(() => hub.summary("m1") !== undefined);
    hub.openFeed("a1", view().sink, () => undefined);
    hub.openFeed("c1", view().sink, () => undefined);
    hub.openFeed("m1", view().sink, () => undefined);
    vi.advanceTimersByTime(10 * 60_000);
    expect(cloud.wakeHints).toEqual([]);
    expect(cloud.resumes).toEqual([]);
    // Its changes or its pull request need the computer: that asks for it, within the device's bound, and never a Mac.
    expect(hub.wake("a1", "open")).toBe(true);
    expect(hub.wake("a1", "open")).toBe(false);
    expect(hub.wake("m1", "open")).toBe(false);
    expect(cloud.wakeHints).toEqual([{ computerId: "c-a", reason: "open" }]);
  } finally {
    vi.useRealTimers();
  }
});

test("a send to an asleep Cloud computer's chat wakes it once: one call in Cloud's queue, which wakes it, and no hint beside", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-a", { online: false, computer_state: "suspended" }));
  cloud.put(summary("a1", { runtime_id: "rt-a", computer_id: "c-a" }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("a1") !== undefined);
  const send = { request_id: "r1", session_id: "a1", kind: "followup", input: { text: "carry on" }, options: {} } as never;
  await hub.clientFor("a1").call("turn.submit", send);
  // Sent again (a reload, a retry): the same call, by its request id.
  await hub.clientFor("a1").call("turn.submit", send);
  expect(new Set(cloud.posted.map((c) => `${c.session}/${c.request_id}/${c.method}`))).toEqual(new Set(["a1/r1/turn.submit"]));
  expect(cloud.queued()).toEqual(["a1/r1"]);
  expect(cloud.wakeHints).toEqual([]);
  expect(cloud.resumes).toEqual([]);
});

test("the tails of needs-you, working and recent chats are kept warm in the cache from Cloud's copy, bounded", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box", { online: false, computer_state: "suspended" }));
  const at = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
  const ids = Array.from({ length: 10 }, (_, i) => `r${i}`);
  for (const [i, id] of ids.entries()) {
    cloud.put(summary(id, { runtime_id: "rt-box", last_activity_at: at(i + 10), head: 3, synced_through: 3 }));
    cloud.copy(id, 1, [1, 2, 3].map((c) => ({ session_id: id, cursor: c, at: at(1), type: "message.delta", payload: { text: `${id}-${c}` } }) as SessionEvent));
  }
  cloud.put(summary("ask", { runtime_id: "rt-box", status: "needs_you", last_activity_at: at(500), head: 2, synced_through: 2 }));
  cloud.copy("ask", 1, [1, 2].map((c) => ({ session_id: "ask", cursor: c, at: at(1), type: "message.delta", payload: { text: `a${c}` } }) as SessionEvent));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("ask") !== undefined);
  const loads: string[] = [];
  const load = hub.cache.load.bind(hub.cache);
  hub.cache.load = (id) => (loads.push(id), load(id));
  expect(await hub.prefetchTails()).toBe(8);
  expect(await hub.prefetchTails()).toBe(0);
  expect(loads).toEqual([]); // how much is held is read from the index, not by loading whole transcripts
  hub.cache.load = load;
  expect((await hub.cache.load("ask"))?.events.map((e) => e.cursor)).toEqual([1, 2]); // needs you first, though oldest
  expect((await hub.cache.load("r0"))?.events).toHaveLength(3);
  expect(await hub.cache.load("r9")).toBeNull(); // past the bound
  // A second pass finds them warm and fetches nothing; the ninth and tenth stay cold (the bound holds).
  expect(await hub.prefetchTails()).toBe(0);
  expect(await hub.cache.load("r8")).toBeNull();
});

test("a chat gone from the list (deleted, or no longer synced) leaves the device's cache too", async () => {
  const cloud = fakeCloud();
  cloud.put(summary("s1"));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s1") !== undefined);
  await hub.cache.append("s1", 1, [event("s1", 1), event("s1", 2)]);
  cloud.gone("s1");
  await until(() => hub.summary("s1") === undefined);
  expect(await hub.cache.held("s1")).toBeNull();
});

test("hovering a row opens its computer's connection before the click", async () => {
  const cloud = fakeCloud();
  const box = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub, opened } = windowOn(cloud, { "rt-box": box });
  await until(() => hub.summary("s1") !== undefined);
  hub.preconnect("s1");
  expect(opened).toEqual(["rt-box"]);
  expect(hub.pool.openRuntimes()).toEqual(["rt-box"]);
});

test("Join your other Mac's connection is its own, outside the pool, with the handshake it is given; none where the Mac cannot be reached", () => {
  const cloud = fakeCloud();
  const seen: Array<{ url: string; handshake: unknown }> = [];
  const join = async () => undefined;
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: deviceStore(),
    home: () => ({ runtimeId: "rt-own", client: fakeRuntimeClient().client }),
    endpoint: (id) => (id === "rt-gone" ? null : { url: `wss://relay.test/${id}`, token: "t" }),
    connect: ((url: string, _token: unknown, _onState: unknown, options: { handshake?: unknown }) => {
      seen.push({ url, handshake: options.handshake });
      return fakeRuntimeClient().client;
    }) as never,
  });
  hubs.push(hub);
  expect(hub.connectOnce("rt-a", join)).not.toBeNull();
  expect(seen).toEqual([{ url: "wss://relay.test/rt-a", handshake: join }]);
  // The pool holds nothing for it: a pooled connection to that Mac keeps its own handshake.
  expect(hub.pool.openRuntimes()).toEqual([]);
  expect(hub.connectOnce("rt-gone", join)).toBeNull();
});

// Cloud mints a new runtime id at every wake of a Cloud computer (cloud-computers CONTRACT §5.3): whatever here
// remembers the old one looks the computer up again by its computer id.
const BOX = { computer_id: "c-1", kind: "cloud" as const };

test("the runtime a chat is on is its computer's newest one on line; a Mac's, and a chat that moved, stay as their summary says", () => {
  const chat = summary("s1", { runtime_id: "rt-1" });
  const of = (...states: Array<ReturnType<typeof runtime>>) => new Map(states.map((r) => [r.runtime_id, r]));
  // Nothing newer, or nothing known: where its summary says.
  expect(runtimeNow(chat, of())).toBe("rt-1");
  expect(runtimeNow(chat, of(runtime("rt-1", { ...BOX, seq: 4 })))).toBe("rt-1");
  // Asleep, then awake under a new id: the chat is on the new one, whether the old one was heard to go or not.
  expect(runtimeNow(chat, of(runtime("rt-1", { ...BOX, online: false, seq: 5 }), runtime("rt-2", { ...BOX, seq: 9 })))).toBe("rt-2");
  expect(runtimeNow(chat, of(runtime("rt-1", { ...BOX, seq: 4 }), runtime("rt-2", { ...BOX, seq: 9 })))).toBe("rt-2");
  expect(runtimeNow(chat, of(runtime("rt-2", { ...BOX, seq: 9 })))).toBe("rt-2");
  // Its summary already names the new one, and the old one's last word still reads on line: the summary holds.
  expect(runtimeNow({ ...chat, runtime_id: "rt-2" }, of(runtime("rt-1", { ...BOX, seq: 4 }), runtime("rt-2", { ...BOX, seq: 9 })))).toBe("rt-2");
  // The new one not on line yet (still waking), another computer's runtime, a Mac's second enrolment: not this chat's.
  expect(runtimeNow(chat, of(runtime("rt-1", { ...BOX, online: false }), runtime("rt-2", { ...BOX, online: false })))).toBe("rt-1");
  expect(runtimeNow(chat, of(runtime("rt-9", { computer_id: "c-9", seq: 9 })))).toBe("rt-1");
  const mac = summary("s2", { runtime_id: "rt-mac", computer_id: "c-mac", where: { kind: "laptop", name: "A Mac" } });
  expect(runtimeNow(mac, of(runtime("rt-mac-2", { computer_id: "c-mac", kind: "laptop", seq: 9 })))).toBe("rt-mac");
  expect([...liveRuntimes(of(runtime("rt-1", { ...BOX, seq: 4 }), runtime("rt-2", { ...BOX, seq: 9 }), runtime("rt-mac", { kind: "laptop" }))).values()].map((r) => r.runtime_id)).toEqual(["rt-2"]);
});

test("a Cloud computer that sleeps and wakes under a new runtime id: the open chat carries on there, and so do its sends", async () => {
  const cloud = fakeCloud();
  const before = fakeRuntimeClient();
  const after = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box", BOX));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  const { hub, opened } = windowOn(cloud, { "rt-box": before, "rt-box-2": after });
  for (let i = 0; i < 3; i++) before.append("s1");
  await until(() => hub.summary("s1") !== undefined);
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 3 && states.at(-1) === "live");

  // Asleep: the view reads Cloud's copy.
  cloud.copy("s1", 1, before.journal("s1").events.slice());
  cloud.runtime(runtime("rt-box", { ...BOX, online: false, computer_state: "suspended" }));
  await until(() => states.at(-1) === "copy");

  // Awake under a new runtime id, on the same disk: Cloud's list names the new runtime, and no summary yet.
  after.journal("s1").events = before.journal("s1").events.slice();
  after.append("s1");
  cloud.runtime(runtime("rt-box-2", { ...BOX, computer_state: "running" }));
  await until(() => v.shown.length === 4 && states.at(-1) === "live");
  expect(v.shown).toEqual([1, 2, 3, 4]);
  expect(opened).toEqual(["rt-box", "rt-box-2"]);
  // From where the view stood: nothing shown twice, nothing skipped.
  expect(after.attaches.at(-1)).toMatchObject({ session: "s1", cursor: 3 });
  expect(hub.summary("s1")?.runtime_id).toBe("rt-box-2");
  expect(hub.viaFor("s1")).toBe("relay");
  // A send goes to the runtime the computer woke as, not to Cloud's queue and never to the old id.
  await hub.clientFor("s1").call("turn.submit", { request_id: "r1", session_id: "s1", kind: "followup", input: { text: "go on" } } as never);
  expect(after.calls.map((c) => c.method)).toEqual(["turn.submit"]);
  expect(before.calls).toEqual([]);
  expect(cloud.posted).toEqual([]);
  // Its summary catches up, naming the same runtime: nothing moves.
  after.append("s1");
  cloud.put(summary("s1", { runtime_id: "rt-box-2", status: "working" }));
  await until(() => v.shown.length === 5);
  expect(opened).toEqual(["rt-box", "rt-box-2"]);
});

test("the relay refuses a Cloud computer's old runtime id and no event told of the new one: Cloud's list is read again and the chat follows its computer", async () => {
  const cloud = fakeCloud();
  const after = fakeRuntimeClient();
  cloud.runtime(runtime("rt-box", BOX));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  // This device's stream is half open: what Cloud says from now on never reaches it.
  cloud.goSilent(true);
  const opened: string[] = [];
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv: deviceStore(),
    home: () => ({ runtimeId: "rt-mac", client: null }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "t" }),
    connect: ((url: string, _token: unknown, onState?: (s: ConnectionState, error?: Error) => void) => {
      const id = url.split("/").pop()!;
      opened.push(id);
      // The old id was revoked when its computer stopped: the relay refuses the upgrade, which a client reads as 1006.
      queueMicrotask(() => (id === "rt-box" ? onState?.("closed", new ConnectionClosed(1006, "refused")) : onState?.("open")));
      return (id === "rt-box" ? fakeRuntimeClient() : after).client;
    }) as never,
  });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s1") !== undefined);
  for (let i = 0; i < 2; i++) after.append("s1");
  // The computer woke as rt-box-2 meanwhile; Cloud's list knows, this device was never told.
  cloud.runtime(runtime("rt-box-2", { ...BOX, seq: 9 }));
  const lists = cloud.lists();
  const v = view();
  const states: string[] = [];
  hub.openFeed("s1", v.sink, (s) => states.push(s.kind));
  await until(() => v.shown.length === 2 && states.at(-1) === "live");
  expect(opened).toEqual(["rt-box", "rt-box-2"]);
  expect(hub.summary("s1")?.runtime_id).toBe("rt-box-2");
  // One read of the list for it, not one per retry.
  expect(cloud.lists()).toBe(lists + 1);
});

test("a send that went out to a Cloud computer before it woke under a new runtime id goes out again after a reload; one to a computer the chat left does not", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box-2", BOX));
  cloud.put(summary("s1", { runtime_id: "rt-box-2" }));
  cloud.put(summary("s2", { runtime_id: "rt-other", computer_id: "c-2" }));
  const { hub } = windowOn(cloud, {});
  await until(() => hub.summary("s2") !== undefined);
  const entry = (session_id: string, computer?: string) => ({ request_id: `r-${session_id}`, method: "turn.submit" as const, params: { session_id, ...(computer ? { computer } : {}) }, at: Date.now(), epoch: 1 });
  // rt-box is gone from Cloud's list: the entry itself says which computer it was on.
  expect(hub.resendable("rt-box")(entry("s1", "c-1"))).toBe(true);
  expect(hub.resendable("rt-box")(entry("s1"))).toBe(false);
  expect(hub.resendable("rt-box-2")(entry("s1"))).toBe(true);
  // Another computer's runtime, and a rewritten journal: never.
  expect(hub.resendable("rt-box")(entry("s2", "c-1"))).toBe(false);
  expect(hub.resendable("rt-box")({ ...entry("s1", "c-1"), epoch: 2 })).toBe(false);
});

test("the connection to a Cloud computer keeps its waiting calls under the computer, where the runtime it wakes as finds them; a Mac's keeps them under its runtime", async () => {
  const cloud = fakeCloud();
  cloud.runtime(runtime("rt-box", BOX));
  cloud.runtime(runtime("rt-mac-2", { computer_id: "c-mac-2", kind: "laptop" }));
  cloud.put(summary("s1", { runtime_id: "rt-box" }));
  cloud.put(summary("s2", { runtime_id: "rt-mac-2", computer_id: "c-mac-2", where: { kind: "laptop", name: "Mac 2" } }));
  const kv = deviceStore();
  const outboxes = new Map<string, Outbox>();
  const hub = new SyncHub({
    pages: onlyPage(),
    api: cloud.api,
    kv,
    home: () => ({ runtimeId: "rt-mac", client: null }),
    endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "t" }),
    connect: ((url: string, _token: unknown, onState: ((s: ConnectionState) => void) | undefined, options: { outbox: Outbox }) => {
      outboxes.set(url.split("/").pop()!, options.outbox);
      queueMicrotask(() => onState?.("open"));
      return fakeRuntimeClient().client;
    }) as never,
  });
  hubs.push(hub);
  hub.start();
  await until(() => hub.summary("s2") !== undefined);
  hub.preconnect("s1");
  hub.preconnect("s2");
  const waiting = (request_id: string, session_id: string) => ({ request_id, method: "turn.submit" as const, params: { session_id, request_id }, at: Date.now() });
  await outboxes.get("rt-box")!.put(waiting("r1", "s1"));
  await outboxes.get("rt-mac-2")!.put(waiting("r2", "s2"));
  expect([...kv.data.keys()].filter((k) => k.includes("outbox/")).map((k) => k.slice(k.indexOf("outbox/")))).toEqual(["outbox/computer/c-1/r1", "outbox/runtime/rt-mac-2/r2"]);
  // The computer sleeps and wakes as rt-box-2, which the chat's summary names before the runtime's own change gets here.
  cloud.runtime(runtime("rt-box", { ...BOX, online: false, computer_state: "suspended" }));
  cloud.put(summary("s1", { runtime_id: "rt-box-2", where: { kind: "cloud", name: "Cloud computer 1", online: true } }));
  await until(() => hub.summary("s1")?.runtime_id === "rt-box-2");
  hub.preconnect("s1");
  expect((await outboxes.get("rt-box-2")!.load()).map((e) => e.request_id)).toEqual(["r1"]);
});

/** A chat New chat started in Cloud, as Cloud answered its placement: the session, the id its computer will give it, and the start's call. */
const queuedStart = (): QueuedStart => ({
  session_id: "s-new",
  workspace_id: "w-new",
  call: { id: "call-start", request_id: "req-1", method: "workspace.create", status: "queued", created_at: "2026-11-13T12:00:00.000Z" },
  start: { computer_id: "c-rt-box", workspace_id: "placed-1", repo: "acme/api", engine: "caveman", task: "Rename the billing route", request_id: "req-1", with_task: true },
});

test("a chat started in Cloud is the person's from Send: listed on Cloud with its message waiting, until its computer's own summary takes its place", async () => {
  const cloud = fakeCloud();
  const { hub } = windowOn(cloud, {});
  const start = queuedStart();
  cloud.startCall(start.session_id, start.call);
  await hub.startQueued(start);
  // Listed as its own summary will be, on "Cloud", under the id its computer will give it: the chat opens now.
  expect(hub.summary("s-new")).toMatchObject({ workspace_id: "w-new", title: "Rename the billing route", repo: "acme/api", engine: "caveman", where: { kind: "cloud", name: "Cloud" }, status: "idle" });
  expect(hub.startAt("w-new")?.session_id).toBe("s-new");
  // Its first message shows as a send queued in Cloud does, under the id the runtime's own message will carry.
  expect(hub.queuedCalls("s-new")).toEqual([
    { call: start.call, line: "Queued · waking Cloud", text: "Rename the billing route", itemId: await submittedMessageId("s-new", "req-1:task") },
  ]);
  // Its computer made it: Cloud's list carries it, and that summary is the chat from here.
  cloud.ran("s-new", "req-1");
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s-new", { workspace_id: "w-new", runtime_id: "rt-box", computer_id: "c-rt-box", title: "Rename the billing route" }));
  await until(() => hub.startOf("s-new") === undefined);
  expect(hub.summary("s-new")).toMatchObject({ runtime_id: "rt-box", workspace_id: "w-new" });
  expect(hub.startMoved("w-new")).toBeUndefined();
  // The start ran: nothing of the queue stays under the message, which is the runtime's own from here.
  await until(() => hub.queuedCalls("s-new").length === 0);
});

test("a start outlives the page that made it, and one its computer did not run is this window's to run: said failed, taken live, then let go", async () => {
  const cloud = fakeCloud();
  const kv = deviceStore();
  const page = () => {
    const hub = new SyncHub({
      pages: onlyPage(),
      api: cloud.api,
      kv,
      home: () => ({ runtimeId: "rt-mac", client: null }),
      endpoint: (id) => ({ url: `wss://relay.test/${id}`, token: "t" }),
      connect: ((_url: string, _token: unknown, onState?: (s: ConnectionState) => void) => {
        queueMicrotask(() => onState?.("open"));
        return fakeRuntimeClient().client;
      }) as never,
    });
    hubs.push(hub);
    hub.start();
    return hub;
  };
  const first = page();
  const start = queuedStart();
  cloud.startCall(start.session_id, start.call);
  await first.startQueued(start);
  await until(() => [...kv.data.keys()].some((k) => k.endsWith("chats/starts")));
  first.stop();
  // A computer on a runtime from before queued starts took the mail and ran nothing: Cloud says the call failed.
  cloud.ran("s-new", "req-1", "failed");
  const second = page();
  await until(() => second.startsFailed().length === 1);
  expect(second.summary("s-new")).toMatchObject({ workspace_id: "w-new" });
  expect(second.startsFailed()[0]).toMatchObject({ session_id: "s-new", start: { request_id: "req-1", workspace_id: "placed-1" } });
  // The window runs it as its own call, under the same request id: the message waits for that, with no word of the queue.
  second.startLive("s-new");
  expect(second.startsFailed()).toEqual([]);
  expect(second.queuedCalls("s-new")[0]).toMatchObject({ text: "Rename the billing route", line: null });
  // It ran (or the person gave it up): the chat this window showed meanwhile goes.
  second.startSettled("s-new");
  expect(second.summary("s-new")).toBeUndefined();
  expect(second.startOf("s-new")).toBeUndefined();
});

test("a chat its computer made under another id than the one it opened under is followed there", async () => {
  const cloud = fakeCloud();
  const { hub } = windowOn(cloud, {});
  const start = queuedStart();
  cloud.startCall(start.session_id, start.call);
  await hub.startQueued(start);
  cloud.runtime(runtime("rt-box"));
  cloud.put(summary("s-new", { workspace_id: "w-other", runtime_id: "rt-box", computer_id: "c-rt-box" }));
  await until(() => hub.startOf("s-new") === undefined);
  expect(hub.startMoved("w-new")).toBe("w-other");
});
