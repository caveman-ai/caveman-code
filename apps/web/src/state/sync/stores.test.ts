// The device stores under the sync state: the transcript cache, the outbox on the key-value store, the SSE reader,
// the runtime pool and the sender.
import type { Client, ConnectionState, ConnectOptions, SocketFactory } from "@caveman-app/session-protocol/client";
import type { RuntimeHello } from "@caveman-app/session-protocol";
import { CallNotSent, connect, memoryOutbox, SessionProtocolError, type OutboxEntry } from "@caveman-app/session-protocol/client";
import { afterEach, expect, test, vi } from "vitest";
import { ModelRuntime, SESSION, type ModelSocket } from "../../../../../packages/session-protocol/test/modelRuntime.ts";
import { CloudError, readEvents, type CloudApi } from "./cloud-api.ts";
import { event, fakeCloud, idbOrderedKv, until } from "./fakes.test-support.ts";
import { memoryKv } from "./kv.ts";
import { kvOutbox, runtimeOutbox } from "./outbox.ts";
import { backedOffReload, devicePages, lockedPages, onlyPage, RELOAD_WINDOW_MS, type Pages } from "./pages.ts";
import { RuntimePool } from "./runtime-pool.ts";
import { AnsweredElsewhere, ChatSender, queuedLine, RESEND_OUT_WITHIN_MS, UNSENT_MS, type Route } from "./sender.ts";
import { TranscriptCache } from "./transcript-cache.ts";

afterEach(() => vi.useRealTimers());

/** The device's store as IndexedDB applies it (each read and write a moment later, in the order made): what every test here runs on. */
const deviceStore = () => idbOrderedKv(memoryKv());

const events = (session: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => event(session, from + i));

// ------------------------------------------------------------ transcript cache

test("the cache keeps a gap-free prefix per chat, across pages", async () => {
  const cache = new TranscriptCache(deviceStore());
  await cache.append("s1", 1, events("s1", 1, 300));
  await cache.append("s1", 1, events("s1", 250, 600)); // overlaps: only 301.. are new
  await cache.append("s1", 1, events("s1", 700, 710)); // a hole: not kept
  const loaded = await cache.load("s1");
  expect(loaded?.epoch).toBe(1);
  expect(loaded?.events.map((e) => e.cursor)).toEqual(Array.from({ length: 600 }, (_, i) => i + 1));
});

test("a new epoch replaces the chat's cache, never mixes with it", async () => {
  const kv = deviceStore();
  const cache = new TranscriptCache(kv);
  await cache.append("s1", 1, events("s1", 1, 10));
  await cache.append("s1", 2, events("s1", 5, 6)); // epoch 2 not from 1: nothing kept, epoch 1 gone
  expect(await cache.load("s1")).toBeNull();
  await cache.append("s1", 2, events("s1", 1, 3));
  expect((await cache.load("s1"))?.events.map((e) => e.cursor)).toEqual([1, 2, 3]);
  expect([...kv.data.keys()].filter((k) => k.includes("/p/1/"))).toEqual([]);
});

test("the cache is bounded: the least recently used chats go first", async () => {
  let now = 0;
  const cache = new TranscriptCache(deviceStore(), { maxChats: 2, now: () => ++now });
  await cache.append("a", 1, events("a", 1, 2));
  await cache.append("b", 1, events("b", 1, 2));
  await cache.load("a"); // a is used again
  await cache.append("c", 1, events("c", 1, 2));
  expect(await cache.load("b")).toBeNull();
  expect(await cache.load("a")).not.toBeNull();
  expect(await cache.load("c")).not.toBeNull();

  const small = new TranscriptCache(deviceStore(), { maxBytes: 2_000, now: () => ++now });
  await small.append("x", 1, events("x", 1, 10));
  await small.append("y", 1, events("y", 1, 10));
  expect(await small.load("x")).toBeNull();
  expect(await small.load("y")).not.toBeNull();
});

test("a prefetch never evicts a chat the person opened, and reading how much is held marks nothing used", async () => {
  let now = 0;
  const cache = new TranscriptCache(deviceStore(), { maxChats: 2, now: () => ++now });
  await cache.append("opened", 1, events("opened", 1, 2));
  await cache.append("warm-1", 1, events("warm-1", 1, 3), { warm: true });
  expect(await cache.held("opened")).toEqual({ epoch: 1, through: 2 });
  expect(await cache.held("warm-1")).toEqual({ epoch: 1, through: 3 });
  expect(await cache.held("never")).toBeNull();
  // The next prefetch goes over the bound: the other prefetched chat goes, not the opened one.
  await cache.append("warm-2", 1, events("warm-2", 1, 2), { warm: true });
  expect(await cache.held("warm-1")).toBeNull();
  expect(await cache.held("opened")).not.toBeNull();
  expect(await cache.held("warm-2")).not.toBeNull();
});

// ------------------------------------------------------------ outbox

test("the outbox keeps calls per scope, oldest first, until deleted", async () => {
  const kv = deviceStore();
  const a = kvOutbox(kv, "rt-1", onlyPage());
  const b = kvOutbox(kv, "rt-2", onlyPage());
  await a.put({ request_id: "r2", method: "turn.submit", params: {}, at: 2 });
  await a.put({ request_id: "r1", method: "turn.interrupt", params: {}, at: 1 });
  await b.put({ request_id: "r3", method: "turn.submit", params: {}, at: 3 });
  expect((await a.load()).map((e) => e.request_id)).toEqual(["r1", "r2"]);
  await a.delete("r1");
  expect((await kvOutbox(kv, "rt-1", onlyPage()).load()).map((e) => e.request_id)).toEqual(["r2"]);
  expect((await b.load()).map((e) => e.request_id)).toEqual(["r3"]);
});

test("a Cloud computer's calls wait under its computer, where the runtime it wakes as finds them; a Mac's wait under its runtime", async () => {
  const kv = deviceStore();
  await runtimeOutbox(kv, "rt-box", "c-box", onlyPage()).put({ request_id: "r1", method: "turn.submit", params: {}, at: 1 });
  await runtimeOutbox(kv, "rt-mac", undefined, onlyPage()).put({ request_id: "r2", method: "turn.submit", params: {}, at: 2 });
  await runtimeOutbox(kv, null, undefined, onlyPage()).put({ request_id: "r3", method: "turn.submit", params: {}, at: 3 });
  expect([...kv.data.keys()]).toEqual(["outbox/computer/c-box/r1", "outbox/runtime/rt-mac/r2", "outbox/runtime/this-device/r3"]);
  // Cloud mints a new runtime id at every wake: the computer's next runtime takes what the one before left.
  const woken = runtimeOutbox(kv, "rt-box-2", "c-box", onlyPage());
  expect((await woken.load()).map((e) => e.request_id)).toEqual(["r1"]);
  await woken.delete("r1");
  // A Mac's runtime id is its enrolment: another runtime id is another Mac's sign-in, and takes none of it.
  expect(await runtimeOutbox(kv, "rt-mac-2", undefined, onlyPage()).load()).toEqual([]);
  expect([...kv.data.keys()]).toEqual(["outbox/runtime/rt-mac/r2", "outbox/runtime/this-device/r3"]);
});

test("what waits under a Cloud computer's runtime id goes out with what waits under its computer, once, and leaves there once answered", async () => {
  const kv = deviceStore();
  // A page from before computers kept theirs, or a connection opened before this device knew whose runtime it was.
  const before = kvOutbox(kv, "runtime/rt-box", onlyPage("page-before"));
  await before.put({ request_id: "r2", method: "turn.submit", params: {}, at: 2 });
  await before.put({ request_id: "both", method: "turn.submit", params: {}, at: 4 });
  const page = onlyPage();
  const now = runtimeOutbox(kv, "rt-box", "c-box", page);
  await now.put({ request_id: "r1", method: "turn.submit", params: {}, at: 1 });
  await now.put({ request_id: "r3", method: "turn.submit", params: {}, at: 3 });
  await now.put({ request_id: "both", method: "turn.submit", params: {}, at: 4 });
  // In the order made, whichever it waited under; one kept under both goes out once.
  expect((await runtimeOutbox(kv, "rt-box", "c-box", page).load()).map((e) => e.request_id)).toEqual(["r1", "r2", "r3", "both"]);
  for (const id of ["r1", "r2", "both"]) await now.delete(id);
  expect([...kv.data.keys()]).toEqual(["outbox/computer/c-box/r3"]);
});

// ------------------------------------------------------------ SSE

test("server-sent events are read across chunk boundaries, comments skipped", async () => {
  const chunks = ["id: 1\nevent: chat\nda", "ta: {\"a\":1}\n\n: keepalive\n\n", "event: gone\r", "\ndata: x\r\ndata: y\r\n\r\n"];
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(new TextEncoder().encode(chunk));
      c.close();
    },
  });
  const out = [];
  for await (const e of readEvents(body)) out.push(e);
  expect(out).toEqual([
    { event: "chat", data: '{"a":1}', id: "1" },
    { event: "gone", data: "x\ny", id: "1" },
  ]);
});

// ------------------------------------------------------------ runtime pool

const fakeConnect = () => {
  type Opened = { url: string; closed: boolean; onState: (s: ConnectionState, e?: Error) => void; options: ConnectOptions | undefined; hello?: RuntimeHello; answerHello: (hello: RuntimeHello) => void };
  const opened: Array<Opened> = [];
  const connect = ((url: string, _token: unknown, onState: (s: ConnectionState, e?: Error) => void, options?: ConnectOptions) => {
    const listeners = new Set<(hello: RuntimeHello) => void>();
    const entry: Opened = { url, closed: false, onState, options, answerHello: (hello) => ((entry.hello = hello), listeners.forEach((l) => l(hello))) };
    opened.push(entry);
    return {
      call: async () => ({}),
      attach: async () => ({}),
      on: () => () => undefined,
      hello: () => entry.hello,
      onHello: (listener: (hello: RuntimeHello) => void) => (listeners.add(listener), () => void listeners.delete(listener)),
      close: () => void (entry.closed = true),
    } as unknown as Client;
  }) as never;
  return { opened, connect };
};

test("the pool keeps each runtime's runtime.hello answer and tells its listeners, without opening a connection to read it", () => {
  const { opened, connect } = fakeConnect();
  const pool = new RuntimePool({ endpoint: (id) => ({ url: `wss://cloud.test/${id}`, token: "" }), connect });
  let heard = 0;
  pool.subscribe(() => heard++);
  expect(pool.hello("rt-1")).toBeUndefined();
  expect(opened).toHaveLength(0);
  pool.acquire("rt-1");
  const nightly = { version: "0.6.0-nightly.20261201.1", protocol_revision: 2, min_client_revision: 2, capabilities: [] };
  opened[0]!.answerHello(nightly);
  expect(pool.hello("rt-1")).toEqual(nightly);
  expect(heard).toBe(1);
  expect(pool.hello("rt-2")).toBeUndefined();
});

test("the pool holds one connection per runtime and closes it two idle minutes after the last user", async () => {
  vi.useFakeTimers();
  const { opened, connect } = fakeConnect();
  const pool = new RuntimePool({ endpoint: (id) => ({ url: `wss://cloud.test/relay/v1/runtimes/${id}`, token: "" }), connect });
  const a1 = pool.acquire("rt-1")!;
  const a2 = pool.acquire("rt-1")!;
  const b = pool.acquire("rt-2")!;
  expect(a1.client).toBe(a2.client);
  expect(opened.map((o) => o.url)).toEqual(["wss://cloud.test/relay/v1/runtimes/rt-1", "wss://cloud.test/relay/v1/runtimes/rt-2"]);
  a1.release();
  a1.release(); // twice is once
  vi.advanceTimersByTime(3 * 60_000);
  expect(opened[0]!.closed).toBe(false); // a2 still holds it
  a2.release();
  vi.advanceTimersByTime(60_000);
  expect(opened[0]!.closed).toBe(false);
  // Held again inside the window: it stays, no second socket.
  const again = pool.acquire("rt-1")!;
  vi.advanceTimersByTime(5 * 60_000);
  expect(opened[0]!.closed).toBe(false);
  again.release();
  vi.advanceTimersByTime(2 * 60_000);
  expect(opened[0]!.closed).toBe(true);
  expect(pool.openRuntimes()).toEqual(["rt-2"]);
  b.release();
  // A new user after the close opens a fresh connection.
  pool.acquire("rt-1");
  expect(opened).toHaveLength(3);
});

test("the pool reports a runtime the relay cannot reach, and gives each runtime its own outbox", async () => {
  const { opened, connect } = fakeConnect();
  const kv = deviceStore();
  const pool = new RuntimePool({ endpoint: (id) => ({ url: `wss://cloud.test/${id}`, token: "" }), connect, outbox: (id) => kvOutbox(kv, id, onlyPage()) });
  pool.acquire("rt-1");
  expect(pool.link("rt-1")).toBe("connecting");
  const { ConnectionClosed } = await import("@caveman-app/session-protocol/client");
  opened[0]!.onState("closed", new ConnectionClosed(4404, "runtime not connected"));
  expect(pool.link("rt-1")).toBe("unreachable");
  opened[0]!.onState("open");
  expect(pool.link("rt-1")).toBe("open");
  expect(opened[0]!.options?.outbox).toBeDefined();
  expect(new RuntimePool({ endpoint: () => null, connect }).acquire("rt-x")).toBeNull();
});

// ------------------------------------------------------------ sender

test("a runtime the relay cannot reach is not retried while nobody holds it, and only after a while or Cloud's word", async () => {
  const { ConnectionClosed } = await import("@caveman-app/session-protocol/client");
  const { opened, connect } = fakeConnect();
  const pool = new RuntimePool({ endpoint: (id) => ({ url: `wss://cloud.test/${id}`, token: "" }), connect, goneMs: 200 });
  // Held: a view wants it, so it keeps trying through a gap.
  const held = pool.acquire("rt-1")!;
  opened[0]!.onState("closed", new ConnectionClosed(1006, "the connection was refused"));
  expect(opened[0]!.closed).toBe(false);
  // Let go while unreachable: closed now (no reconnect every few seconds), and still reads unreachable.
  held.release();
  expect(opened[0]!.closed).toBe(true);
  expect(pool.openRuntimes()).toEqual([]);
  expect(pool.link("rt-1")).toBe("unreachable");
  pool.revive("rt-1"); // Cloud's list says something new of it
  expect(pool.link("rt-1")).toBeUndefined();
  // Idle when the relay says the runtime is gone (a deleted computer, K16): closed at once.
  pool.acquire("rt-2")!.release();
  opened[1]!.onState("closed", new ConnectionClosed(4404, "runtime not connected"));
  expect(opened[1]!.closed).toBe(true);
  expect(pool.link("rt-2")).toBe("unreachable");
  await new Promise((r) => setTimeout(r, 250));
  expect(pool.link("rt-2")).toBeUndefined(); // tried again after a while
  // Idle connections to runtimes no chat lives on any more go; held ones stay.
  pool.acquire("rt-3")!.release();
  const kept = pool.acquire("rt-4")!;
  pool.keepOnly(new Set(["rt-1"]));
  expect(pool.openRuntimes()).toEqual(["rt-4"]);
  kept.release();
});

test("a send to a runtime this device reaches goes there; otherwise Cloud queues it", async () => {
  const cloud = fakeCloud();
  const calls: string[] = [];
  const client = { call: async (method: string) => (calls.push(method), { turn_id: "t1" }) } as unknown as Client;
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  await expect(sender.send("s1", "turn.submit", { request_id: "r1", text: "hi" }, { via: "runtime", client })).resolves.toEqual({ via: "runtime", result: { turn_id: "t1" } });
  const queued = await sender.send("s1", "turn.submit", { request_id: "r2", text: "while asleep" }, { via: "cloud" });
  expect(queued).toMatchObject({ via: "cloud", call: { request_id: "r2", status: "queued" } });
  expect(calls).toEqual(["turn.submit"]);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r2"]);
});

test("a send queued while Cloud is down is posted once Cloud is back, and once after a reload", async () => {
  const cloud = fakeCloud();
  const kv = deviceStore();
  cloud.setDown(true);
  const first = new ChatSender({ api: cloud.api, outbox: kvOutbox(kv, "cloud", onlyPage()), retryMs: () => 5 });
  const pending = first.send("s1", "turn.submit", { request_id: "r1", input: { text: "hi" } }, { via: "cloud" });
  await until(() => kv.data.size === 1);
  // The page reloads while Cloud is still down; the new page's sender finds the call and posts it when Cloud answers.
  const queued: string[] = [];
  const texts: unknown[] = [];
  const second = new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(kv, "cloud", onlyPage()),
    retryMs: () => 5,
    onQueued: (_s, call, params) => (queued.push(call.request_id), texts.push((params as { input?: { text?: string } }).input?.text)),
  });
  void second;
  cloud.setDown(false);
  await until(() => queued.length === 1);
  // The words come back with it, so the reloaded page shows the send it is waiting on.
  expect(texts).toEqual(["hi"]);
  await expect(pending).resolves.toMatchObject({ via: "cloud" });
  await until(() => kv.data.size === 0);
  // Two posts of one request id, one call in Cloud.
  expect(new Set(cloud.posted.map((p) => p.request_id))).toEqual(new Set(["r1"]));
  expect(await cloud.api.callState("s1", "r1")).toMatchObject({ id: "call-1" });
});

test("a reload never sends a call older than Cloud's queue keeps one: it would run long after its person moved on", async () => {
  const cloud = fakeCloud();
  const kv = deviceStore();
  const outbox = kvOutbox(kv, "cloud", onlyPage());
  const day = 24 * 60 * 60 * 1000;
  // A device that was signed out for two days kept one call, and a newer one.
  await outbox.put({ request_id: "old", method: "turn.submit", params: { session_id: "s1", call: { request_id: "old", text: "fix it" } }, at: Date.now() - 2 * day });
  await outbox.put({ request_id: "new", method: "turn.submit", params: { session_id: "s1", call: { request_id: "new", text: "hi" } }, at: Date.now() - 60_000 });
  const queued: string[] = [];
  new ChatSender({ api: cloud.api, outbox, retryMs: () => 5, onQueued: (_s, call) => queued.push(call.request_id) });
  await until(() => kv.data.size === 0);
  expect(queued).toEqual(["new"]);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["new"]);
});

test("sends for one chat go out in the order made, even when the first waits for Cloud", async () => {
  const cloud = fakeCloud();
  cloud.setDown(true);
  const order: string[] = [];
  const client = { call: async (_m: string, p: { request_id: string }) => (order.push(p.request_id), {}) } as unknown as Client;
  const sender = new ChatSender({ api: { ...cloud.api, call: async (...args) => (order.push(args[1]), cloud.api.call(...args)) }, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()), retryMs: () => 5 });
  const first = sender.send("s1", "turn.submit", { request_id: "r1" }, { via: "cloud" });
  const second = sender.send("s1", "turn.interrupt", { request_id: "r2" }, { via: "runtime", client });
  await new Promise((r) => setTimeout(r, 30));
  expect(order.filter((id) => id === "r2")).toEqual([]); // the stop waits for the send to be queued
  cloud.setDown(false);
  await Promise.all([first, second]);
  expect(order.filter((id, i) => order.indexOf(id) === i)).toEqual(["r1", "r2"]);
});

test("a second answer to one ask says it was answered on another device", async () => {
  const cloud = fakeCloud();
  const client = {
    call: async () => {
      throw new SessionProtocolError({ code: -32004, message: "already answered", data: { reason: "invalid_state" } });
    },
  } as unknown as Client;
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  await expect(sender.send("s1", "ask.respond", { request_id: "r1" }, { via: "runtime", client })).rejects.toBeInstanceOf(AnsweredElsewhere);
  expect(queuedLine({ status: "failed", error: { code: "invalid_state", message: "already answered" } } as never, { name: "x", cloud: true })).toBe("Answered on another device");
});

test("a send or stop the runtime turns away in a move's window follows the chat through Cloud's queue, under its request id (CHAOS-15)", async () => {
  const cloud = fakeCloud();
  const refusal = (reason: string, message: string) => new SessionProtocolError({ code: -32010, message, data: { reason: reason as "lease_lost" } });
  const answers: Record<string, SessionProtocolError> = {
    r1: refusal("lease_lost", "This chat moved to another computer."),
    r2: refusal("not_found", "That chat is still on its way to this computer. Try again in a moment."),
    r3: refusal("parked", "the session is parked; call session.resume first"),
  };
  const client = {
    call: async (_m: string, p: { request_id: string }) => {
      throw answers[p.request_id];
    },
  } as unknown as Client;
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  // One chat each: a call behind one in Cloud's queue would follow it there without asking the runtime.
  await expect(sender.send("s1", "turn.submit", { request_id: "r1", text: "hi" }, { via: "runtime", client, orCloud: true })).resolves.toMatchObject({ via: "cloud", call: { request_id: "r1" } });
  await expect(sender.send("s2", "turn.interrupt", { request_id: "r2" }, { via: "runtime", client, orCloud: true })).resolves.toMatchObject({ via: "cloud", call: { request_id: "r2" } });
  // A chat the person parked is not moving: that refusal stays the runtime's.
  await expect(sender.send("s3", "turn.submit", { request_id: "r3", text: "hi" }, { via: "runtime", client, orCloud: true })).rejects.toBe(answers.r3);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
});

// ------------------------------------------------------------ a chat's calls run in the order sent, across both ways

/** A client whose calls go out at once and are answered as `answer` says, recording which went out. */
const wireClient = (answer: (requestId: string) => Promise<unknown> = async () => ({})) => {
  const sent: string[] = [];
  const client = {
    call: (_method: string, params: { request_id: string }, options?: { onSent?: () => void }) => {
      sent.push(params.request_id);
      options?.onSent?.();
      return answer(params.request_id);
    },
  } as unknown as Client;
  return { sent, client };
};

test("a call behind one Cloud still holds follows it to Cloud's queue, and goes to the runtime again once the chat's computer ran it", async () => {
  const cloud = fakeCloud();
  const { sent, client } = wireClient();
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  const route: Route = { via: "runtime", client, orCloud: true };
  // The computer was asleep: the send waits in Cloud's queue while it wakes.
  await sender.send("s1", "turn.submit", { request_id: "r1", input: { text: "fix the tests" } }, { via: "cloud" });
  // The relay reaches it now, but the send is not handed over yet: the stop goes behind it.
  await expect(sender.send("s1", "turn.interrupt", { request_id: "r2" }, route)).resolves.toMatchObject({ via: "cloud", call: { request_id: "r2" } });
  // Another chat is not held back.
  await expect(sender.send("s2", "turn.submit", { request_id: "r3" }, route)).resolves.toMatchObject({ via: "runtime" });
  cloud.ran("s1", "r1");
  cloud.ran("s1", "r2");
  await expect(sender.send("s1", "turn.submit", { request_id: "r4" }, route)).resolves.toMatchObject({ via: "runtime" });
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
  expect(sent).toEqual(["r3", "r4"]);
});

test("after a reload, a call behind one the reload sent to Cloud's queue again follows it there", async () => {
  const cloud = fakeCloud();
  const outbox = kvOutbox(deviceStore(), "cloud", onlyPage());
  await outbox.put({ request_id: "r1", method: "turn.submit", params: { session_id: "s1", call: { request_id: "r1", input: { text: "fix the tests" } } }, at: Date.now() - 60_000 });
  const { sent, client } = wireClient();
  const sender = new ChatSender({ api: cloud.api, outbox, retryMs: () => 5 });
  await expect(sender.send("s1", "turn.interrupt", { request_id: "r2" }, { via: "runtime", client, orCloud: true })).resolves.toMatchObject({ via: "cloud" });
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
  expect(sent).toEqual([]);
});

test("after a reload, a left-over call Cloud keeps failing holds back only its own chat: other chats' sends, stops and left-over calls still go", async () => {
  const cloud = fakeCloud();
  const outbox = kvOutbox(deviceStore(), "cloud", onlyPage());
  await outbox.put({ request_id: "r0", method: "turn.submit", params: { session_id: "s1", call: { request_id: "r0", input: { text: "fix the tests" } } }, at: Date.now() - 120_000 });
  await outbox.put({ request_id: "r1", method: "turn.submit", params: { session_id: "s2", call: { request_id: "r1", input: { text: "hi" } } }, at: Date.now() - 60_000 });
  // Cloud's calls route keeps answering 503 for the first chat's left-over call.
  let failing = true;
  const attempts: string[] = [];
  const api: CloudApi = {
    ...cloud.api,
    call: async (...args) => {
      attempts.push(args[1]);
      if (failing && args[1] === "r0") throw new CloudError(503, "unavailable", "Service Unavailable");
      return cloud.api.call(...args);
    },
  };
  const queued: string[] = [];
  const { sent, client } = wireClient();
  const sender = new ChatSender({ api, outbox, retryMs: () => 5, onQueued: (_s, call) => queued.push(call.request_id) });
  const route: Route = { via: "runtime", client, orCloud: true };
  await until(() => attempts.filter((id) => id === "r0").length >= 3);

  const send = sender.send("s3", "turn.submit", { request_id: "r2", input: { text: "hi" } }, route);
  const stop = sender.send("s3", "turn.interrupt", { request_id: "r3" }, route);
  const behind = sender.send("s1", "turn.interrupt", { request_id: "r4" }, route);
  await new Promise((r) => setTimeout(r, 50));
  expect(sent).toEqual(["r2", "r3"]);
  await expect(send).resolves.toMatchObject({ via: "runtime" });
  await expect(stop).resolves.toMatchObject({ via: "runtime" });
  expect(queued).toEqual(["r1"]);
  // The stop in the left-over call's own chat still waits for it, and follows it into Cloud's queue once Cloud takes it.
  expect(attempts).not.toContain("r4");
  failing = false;
  await expect(behind).resolves.toMatchObject({ via: "cloud", call: { request_id: "r4" } });
  expect(cloud.posted.filter((p) => p.session === "s1").map((p) => p.request_id)).toEqual(["r0", "r4"]);
  expect(sent).toEqual(["r2", "r3"]);
});

test("two calls a moving chat turned away reach Cloud's queue in the order sent, though the first one's post waits out a Cloud outage", async () => {
  const cloud = fakeCloud();
  const attempts: string[] = [];
  const turnAway: Array<() => void> = [];
  const { client } = wireClient(
    () => new Promise((_resolve, reject) => turnAway.push(() => reject(new SessionProtocolError({ code: -32010, message: "This chat moved to another computer.", data: { reason: "lease_lost" } })))),
  );
  const sender = new ChatSender({ api: { ...cloud.api, call: async (...args) => (attempts.push(args[1]), cloud.api.call(...args)) }, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()), retryMs: () => 20 });
  const route: Route = { via: "runtime", client, epoch: 1, orCloud: true };
  const send = sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "fix the tests" } }, route);
  const stop = sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r2" }, route);
  await until(() => turnAway.length === 2);
  cloud.setDown(true);
  turnAway[0]!();
  // The send's post fails while Cloud blinks, and waits out its back-off.
  await until(() => attempts.includes("r1"));
  cloud.setDown(false);
  turnAway[1]!();
  await Promise.all([send, stop]);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1", "r2"]);
});

/**
 * A client whose calls go out at once and wait for an answer until the test gives one; one its caller takes back, or
 * that `lose` withdraws (as its lost link's UNSENT_MS would), fails with CallNotSent "unanswered".
 */
const heldClient = () => {
  const sent: string[] = [];
  const open = new Map<string, { readonly resolve: (result: unknown) => void; readonly reject: (error: unknown) => void; readonly method: string }>();
  const lose = (requestId: string) => {
    const call = open.get(requestId);
    if (open.delete(requestId)) call!.reject(new CallNotSent(call!.method as never, "unanswered"));
  };
  const client = {
    call: (method: string, params: { request_id: string }, options?: { onSent?: () => void; signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        sent.push(params.request_id);
        open.set(params.request_id, { resolve, reject, method });
        options?.signal?.addEventListener("abort", () => lose(params.request_id), { once: true });
        options?.onSent?.();
      }),
  } as unknown as Client;
  return { sent, client, lose, unanswered: () => [...open.keys()] };
};

test("a call routed to Cloud's queue takes the one before it, unanswered on the runtime's connection, there ahead of it", async () => {
  const cloud = fakeCloud();
  const happened: string[] = [];
  const wire = heldClient();
  const sender = new ChatSender({ api: { ...cloud.api, call: async (...args) => (happened.push(`Cloud queued ${args[1]}`), cloud.api.call(...args)) }, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  const send = sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "fix the tests" } }, { via: "runtime", client: wire.client, epoch: 1, orCloud: true });
  await until(() => wire.sent.length === 1);
  // The relay now says the computer is not connected, with the send on its socket unanswered: the stop is routed to Cloud.
  void sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r2" }, { via: "cloud" });
  // Waited for, not timed: the stop is posted after a few of the store's writes, each a timer tick (up to ~16 ms on Windows).
  await until(() => happened.length >= 2);
  expect(happened).toEqual(["Cloud queued r1", "Cloud queued r2"]);
  expect(wire.unanswered()).toEqual([]);
  await expect(send).resolves.toMatchObject({ via: "cloud" });
});

test("a call out behind one that goes to Cloud's queue is taken back from the runtime's connection and follows it there", async () => {
  const cloud = fakeCloud();
  const happened: string[] = [];
  const wire = heldClient();
  const sender = new ChatSender({ api: { ...cloud.api, call: async (...args) => (happened.push(`Cloud queued ${args[1]}`), cloud.api.call(...args)) }, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  const route: Route = { via: "runtime", client: wire.client, epoch: 1, orCloud: true };
  const send = sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "fix the tests" } }, route);
  const stop = sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r2" }, route);
  await until(() => wire.sent.length === 2);
  // The link went with both on it unanswered, and the send's wait for another runs out first: the stop must not go out
  // again on a socket that opens before its own wait does.
  wire.lose("r1");
  await new Promise((r) => setTimeout(r, 20));
  expect(wire.unanswered()).toEqual([]);
  expect(happened).toEqual(["Cloud queued r1", "Cloud queued r2"]);
  await expect(send).resolves.toMatchObject({ via: "cloud" });
  await expect(stop).resolves.toMatchObject({ via: "cloud" });
});

test("a call sent while the one before it is still on its way into Cloud's queue follows it there, though the runtime is reachable again", async () => {
  const cloud = fakeCloud();
  const wire = heldClient();
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()), retryMs: () => 20 });
  const route: Route = { via: "runtime", client: wire.client, epoch: 1, orCloud: true };
  const send = sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "fix the tests" } }, route);
  await until(() => wire.sent.length === 1);
  // The send loses its link and heads for Cloud's queue while Cloud blinks: its post waits out the outage.
  cloud.setDown(true);
  wire.lose("r1");
  await new Promise((r) => setTimeout(r, 10));
  const stop = sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r2" }, route);
  await new Promise((r) => setTimeout(r, 50));
  expect(wire.sent).toEqual(["r1"]);
  cloud.setDown(false);
  await expect(send).resolves.toMatchObject({ via: "cloud" });
  await expect(stop).resolves.toMatchObject({ via: "cloud" });
  expect([...new Set(cloud.posted.map((p) => p.request_id))]).toEqual(["r1", "r2"]);
});

test("a call goes onto the connection its route hands it before the route lets go of it, though Cloud is asked about the chat first", async () => {
  const cloud = fakeCloud();
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  // An earlier call Cloud has run since: the next one asks Cloud about it before it goes.
  await sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r0", input: { text: "fix the tests" } }, { via: "cloud" });
  cloud.ran("s1", "r0");
  const client = connect("wss://relay.test/rt-1", "", undefined, { socket: () => ({ readyState: 0, close: () => undefined }) as unknown as WebSocket });
  // hub.ts routeFor: the pool's hold is let go on a microtask, and the pool closes a connection nobody holds whose
  // relay just said the computer is unreachable.
  const route = (): Route => {
    queueMicrotask(() => client.close());
    return { via: "runtime", client, epoch: 1, orCloud: true };
  };
  await expect(sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r1" }, { via: "runtime", client, epoch: 1, orCloud: true }, route)).resolves.toMatchObject({ via: "cloud" });
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r0", "r1"]);
});

test("a call routed to Cloud's queue does not wait for one before it that Cloud could not carry", async () => {
  const cloud = fakeCloud();
  // This Mac's own runtime on loopback, or a Mac that has not allowed this device yet: the send waits for it, however long.
  const waiting = { call: () => new Promise(() => undefined) } as unknown as Client;
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(deviceStore(), "cloud", onlyPage()) });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "fix the tests" } }, { via: "runtime", client: waiting, epoch: 1 });
  const stop = sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r2" }, { via: "cloud" });
  // Waited for, not timed: the stop is posted after a few of the store's writes, each a timer tick (up to ~16 ms on Windows).
  await until(() => cloud.posted.length > 0);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r2"]);
  await expect(stop).resolves.toMatchObject({ via: "cloud" });
});

test("a call behind one that lost its link before the answer reaches Cloud's queue behind it within UNSENT_MS, and the relay never gets the first again", async () => {
  vi.useFakeTimers();
  type Socket = { readyState: number; onopen: null | (() => void); onclose: null | ((e: { code: number; reason: string }) => void); onmessage: null | ((m: { data: string }) => void); send: (frame: string) => void; close: () => void };
  const sockets: Socket[] = [];
  const frames: Array<{ id: number; params: { request_id?: string } }> = [];
  const client = connect("wss://relay.test/rt-1", "", undefined, {
    socket: () => {
      const ws: Socket = { readyState: 0, onopen: null, onclose: null, onmessage: null, send: (frame) => void frames.push(JSON.parse(frame)), close: () => void (ws.readyState = 3) };
      sockets.push(ws);
      return ws as unknown as WebSocket;
    },
  });
  const open = async () => {
    const ws = sockets.at(-1)!;
    ws.readyState = 1;
    ws.onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    return ws;
  };
  const cloud = fakeCloud();
  const happened: string[] = [];
  const sender = new ChatSender({ api: { ...cloud.api, call: async (...args) => (happened.push(`Cloud queued ${args[1]}`), cloud.api.call(...args)) }, outbox: memoryOutbox() });
  const route: Route = { via: "runtime", client, epoch: 1, orCloud: true };
  await open();
  const send = sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "fix the tests" } }, route);
  await vi.advanceTimersByTimeAsync(0);
  // The send is on the wire when the link drops, and every socket after it hangs: the relay never comes back.
  sockets[0]!.onclose?.({ code: 1006, reason: "" });
  const stop = sender.send("s1", "turn.interrupt", { session_id: "s1", request_id: "r2" }, route);
  await vi.advanceTimersByTimeAsync(UNSENT_MS);
  expect(happened).toEqual(["Cloud queued r1", "Cloud queued r2"]);
  await expect(send).resolves.toMatchObject({ via: "cloud" });
  await expect(stop).resolves.toMatchObject({ via: "cloud" });
  // If it comes back after all, the send it may have run is Cloud's to hand over, not the relay's to resend.
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  await open();
  expect(frames.filter((f) => f.params?.request_id !== undefined).map((f) => f.params.request_id)).toEqual(["r1"]);
  client.close();
});

// ------------------------------------------------------------ a send survives a reload

/**
 * One page of a window: the real client to one runtime (ModelRuntime plays server.ts, whose receipt answers a request
 * id's repeat) and the real ChatSender, both over the device store as this page found it. `reload()` kills the page
 * and opens the next one on the store exactly as this page last wrote it. A dead page runs no code in a browser; here
 * its objects live on, so no socket of its opens and none of its Cloud requests leaves.
 */
const windowPage = (runtime: ModelRuntime, cloud: ReturnType<typeof fakeCloud>, store: ReturnType<typeof memoryKv>) => {
  let alive = true;
  const sockets: ModelSocket[] = [];
  const socket: SocketFactory = (url, bearer) => {
    if (!alive) return { readyState: 0, send: () => undefined, close: () => undefined } as unknown as WebSocket;
    const ws = runtime.factory(url, bearer);
    sockets.push(ws as unknown as ModelSocket);
    return ws;
  };
  const api = Object.fromEntries(
    Object.entries(cloud.api).map(([name, fn]) => [name, (...args: unknown[]) => (alive ? (fn as (...a: unknown[]) => unknown)(...args) : new Promise(() => undefined))]),
  ) as unknown as CloudApi;
  const client = connect("wss://relay.test/rt-b", runtime.token, undefined, { socket, outbox: kvOutbox(store, "runtime/rt-b", onlyPage()) });
  const sender = new ChatSender({ api, outbox: kvOutbox(store, "cloud", onlyPage()), retryMs: () => 5 });
  return {
    sockets,
    sender,
    /** hub.ts routeFor for a chat on another computer that Cloud lists online: its connection, Cloud's queue if need be. */
    route: (): Route => ({ via: "runtime", client, epoch: 1, orCloud: true }),
    reload: () => {
      const kept = deviceStore();
      for (const [key, value] of store.data) kept.data.set(key, structuredClone(value));
      alive = false;
      return { next: windowPage(runtime, cloud, kept), store: kept };
    },
  };
};

test.each(["Cloud's queue hands them over first", "the new page's connection comes up first"])(
  "two sends made back to back while the first is not on the wire yet survive a reload: each runs once, in the order sent (%s)",
  async (first) => {
    vi.useFakeTimers();
    const runtime = new ModelRuntime(0);
    const cloud = fakeCloud();
    const before = windowPage(runtime, cloud, deviceStore());
    // The relay has not reached the chat's computer: the first send waits for the socket, the second behind it. Request
    // ids are random, and these sort the other way round.
    for (const [id, text] of [
      ["zz-first", "fix the tests"],
      ["aa-second", "then run them"],
    ])
      void before.sender.send(SESSION, "turn.submit", { session_id: SESSION, request_id: id!, input: { text: text! } }, before.route()).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.wire).toEqual([]);

    // The page reloads 60 ms later.
    const { next: after, store } = before.reload();
    // Cloud's queue hands a chat's calls to its computer first in, first out; the runtime runs a request id once.
    const deliverQueue = () => {
      for (const { request_id } of cloud.posted) {
        if (runtime.receipts.has(request_id)) continue;
        runtime.receipts.set(request_id, { queued: true });
        runtime.ran.push(request_id);
        cloud.ran(SESSION, request_id);
      }
    };
    const connection = async () => {
      for (const socket of after.sockets.filter((s) => s.readyState === 0)) runtime.open(socket);
      await vi.advanceTimersByTimeAsync(0);
      for (const socket of after.sockets) for (const request of [...socket.requests]) runtime.answer(socket, request);
    };
    await vi.advanceTimersByTimeAsync(0);
    for (let round = 0; round < 5; round++) {
      if (first.startsWith("Cloud")) deliverQueue();
      await connection();
      deliverQueue();
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(runtime.ran, "the runtime ran each send once, in the order sent").toEqual(["zz-first", "aa-second"]);
    expect([...store.data.keys()].filter((key) => key.includes("outbox/")), "nothing is left waiting").toEqual([]);
  },
);

test("a call Cloud cannot carry waits only in its connection's outbox once that holds it, so a reload never queues it in Cloud", async () => {
  const cloud = fakeCloud();
  const store = deviceStore();
  // A Mac that has not allowed this device yet: its connection holds the send until it does (K4).
  const client = connect("wss://relay.test/rt-mac", "", undefined, { socket: () => ({ readyState: 0, close: () => undefined }) as unknown as WebSocket, outbox: kvOutbox(store, "runtime/rt-mac", onlyPage()) });
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage()) });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "hi" } }, { via: "runtime", client, epoch: 1 }).catch(() => undefined);
  await until(() => store.data.has("outbox/runtime/rt-mac/r1") && !store.data.has("outbox/cloud/r1"));
  // The page reloads: the next page's sender finds nothing of it to post.
  const kept = deviceStore();
  for (const [key, value] of store.data) kept.data.set(key, structuredClone(value));
  new ChatSender({ api: cloud.api, outbox: kvOutbox(kept, "cloud", onlyPage()), retryMs: () => 5 });
  await new Promise((r) => setTimeout(r, 20));
  expect(cloud.posted).toEqual([]);
  expect([...kept.data.keys()]).toEqual(["outbox/runtime/rt-mac/r1"]);
  client.close();
});

test("after a reload, a call that went out with no answer goes to Cloud's queue only while the client would still send it again; one that never went out, for a day", async () => {
  const cloud = fakeCloud();
  const store = deviceStore();
  // A send out on the runtime's connection with no answer is kept as one that went out.
  const { client } = heldClient();
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage()) });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "out", input: { text: "hi" } }, { via: "runtime", client, epoch: 1, orCloud: true });
  await until(() => (store.data.get("outbox/cloud/out") as { params?: { wentOut?: boolean } } | undefined)?.params?.wentOut === true);

  const outbox = kvOutbox(deviceStore(), "cloud", onlyPage());
  const left = (request_id: string, ago: number, wentOut?: true) =>
    outbox.put({ request_id, method: "turn.submit", params: { session_id: "s1", call: { request_id, input: { text: request_id } }, ...(wentOut ? { wentOut } : {}) }, at: Date.now() - ago });
  await left("unsent-2h", 2 * 60 * 60_000);
  await left("out-11min", RESEND_OUT_WITHIN_MS + 60_000, true);
  await left("out-1min", 60_000, true);
  const queued: string[] = [];
  new ChatSender({ api: cloud.api, outbox, retryMs: () => 5, onQueued: (_s, call) => queued.push(call.request_id) });
  await until(() => queued.length === 2);
  await new Promise((r) => setTimeout(r, 20));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["unsent-2h", "out-1min"]);
  expect(await outbox.load()).toEqual([]);
});

// Found by the sender's model check (client-delivery finding 15): on its way into Cloud's queue, a call that may have run
// lost its mark at once, so a page that reloaded before Cloud took it left the next page to post it as one that never
// went out, after its chat had moved: it ran on both computers.
test("a call let go unanswered, still on its way into Cloud's queue when its page reloads, keeps its mark: the next page posts it only while the client would send it again", async () => {
  const cloud = fakeCloud();
  const store = deviceStore();
  let letGo!: () => void;
  // Its connection keeps it, sends it, and lets it go unanswered when its link has been lost for UNSENT_MS.
  const client = {
    call: (method: string, _params: unknown, options: { onKept?: () => unknown; onSent?: () => void }) =>
      new Promise((_resolve, reject) => {
        void (async () => {
          await options.onKept?.();
          options.onSent?.();
          letGo = () => reject(new CallNotSent(method as never, "unanswered"));
        })();
      }),
  } as unknown as Client;
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage()), retryMs: () => 5 });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "hi" } }, { via: "runtime", client, runtime: "rt-b", epoch: 1, orCloud: true }).catch(() => undefined);
  const mark = () => (store.data.get("outbox/cloud/r1") as { params?: { wentOut?: boolean } } | undefined)?.params?.wentOut;
  await until(() => mark() === true);
  // Cloud is down: it heads for Cloud's queue and waits there.
  cloud.setDown(true);
  letGo();
  await sleep(50);
  expect(mark(), "it may have run: still marked so").toBe(true);
  // The page reloads; meanwhile its chat moved off rt-b, so the client would not send it again.
  const kept = deviceStore();
  for (const [key, value] of store.data) kept.data.set(key, structuredClone(value));
  const next = fakeCloud();
  new ChatSender({ api: next.api, outbox: kvOutbox(kept, "cloud", onlyPage()), retryMs: () => 5, resendable: () => false });
  await until(() => ![...kept.data.keys()].some((key) => key.startsWith("outbox/cloud/")));
  expect(next.posted.map((p) => p.request_id), "not posted past resendable").toEqual([]);
});

test("a call Cloud cannot carry that a page left before its connection's outbox held it is never posted to Cloud's queue after a reload", async () => {
  const cloud = fakeCloud();
  const store = deviceStore();
  // The chat's computer's socket is not up: a send Cloud could carry waits for it, and behind it one Cloud cannot (the
  // desktop's own runtime, a Mac that has not allowed this device: no orCloud), which only that connection takes.
  const client = connect("wss://relay.test/rt-mac", "", undefined, { socket: () => ({ readyState: 0, close: () => undefined }) as unknown as WebSocket, outbox: kvOutbox(store, "runtime/rt-mac", onlyPage()) });
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage()), unsentMs: 60_000 });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "first", input: { text: "fix the tests" } }, { via: "runtime", client, epoch: 1, orCloud: true }).catch(() => undefined);
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "no-cloud", input: { text: "then run them" } }, { via: "runtime", client, epoch: 1 }).catch(() => undefined);
  await until(() => store.data.has("outbox/cloud/first") && store.data.has("outbox/cloud/no-cloud"));
  expect(store.data.get("outbox/cloud/no-cloud")).toMatchObject({ params: { noCloud: true } });
  // The page reloads.
  const kept = deviceStore();
  for (const [key, value] of store.data) kept.data.set(key, structuredClone(value));
  new ChatSender({ api: cloud.api, outbox: kvOutbox(kept, "cloud", onlyPage()), retryMs: () => 5 });
  await until(() => ![...kept.data.keys()].some((key) => key.startsWith("outbox/cloud/")));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["first"]);
  client.close();
});

test("a call that may run on a runtime's connection is marked so in the sender's outbox before its frame leaves", async () => {
  const runtime = new ModelRuntime(0);
  const cloud = fakeCloud();
  const store = deviceStore();
  // A store that takes a moment to write, as IndexedDB does.
  const slow = { ...store, put: async (k: string, v: unknown) => (await new Promise((r) => setTimeout(r, 20)), store.put(k, v)) } as typeof store;
  const marks: unknown[] = [];
  runtime.onFrame = (frame) => {
    if (frame.requestId === "r1") marks.push((store.data.get("outbox/cloud/r1") as { params?: { wentOut?: boolean } } | undefined)?.params?.wentOut);
  };
  const client = connect("wss://relay.test/rt-b", runtime.token, undefined, { socket: runtime.factory, outbox: kvOutbox(store, "runtime/rt-b", onlyPage()) });
  await until(() => runtime.sockets.length > 0);
  runtime.open(runtime.sockets[0]!);
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(slow, "cloud", onlyPage()) });
  void sender.send(SESSION, "turn.submit", { session_id: SESSION, request_id: "r1", input: { text: "fix the tests" } }, { via: "runtime", client, runtime: "rt-b", epoch: 1, orCloud: true });
  await until(() => marks.length === 1);
  // A page that closes as the frame leaves leaves a call that may have run: a reload resends it only as the client would.
  expect(marks).toEqual([true]);
  client.close();
});

test("a call first routed where Cloud cannot carry it, then rerouted to Cloud's queue, survives a reload while it waits there behind an earlier one", async () => {
  const cloud = fakeCloud();
  const store = deviceStore();
  let alive = true;
  // Cloud is down for the page before the reload: the first call's post keeps being retried, so the second waits on
  // `settled` behind it.
  const down = Object.fromEntries(
    Object.entries(cloud.api).map(([name, fn]) => [name, (...args: unknown[]) => (!alive ? new Promise(() => undefined) : name === "call" ? Promise.reject(new CloudError(503, undefined, "down")) : (fn as (...a: unknown[]) => unknown)(...args))]),
  ) as unknown as CloudApi;
  const { client } = heldClient();
  const sender = new ChatSender({ api: down, outbox: kvOutbox(store, "cloud", onlyPage()), retryMs: () => 20 });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "first", input: { text: "fix the tests" } }, { via: "runtime", client, runtime: "rt-b", epoch: 1, orCloud: true }).catch(() => undefined);
  // Made while Cloud could not carry it (a Mac that had not allowed this device yet, say); by the time the first is
  // out, its way is Cloud's queue.
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "second", input: { text: "then run them" } }, { via: "runtime", client, epoch: 1 }, () => ({ via: "cloud" })).catch(() => undefined);
  await until(() => store.data.has("outbox/cloud/first") && store.data.has("outbox/cloud/second"));
  await new Promise((r) => setTimeout(r, 200));
  // The page reloads; Cloud is back.
  const kept = deviceStore();
  for (const [key, value] of store.data) kept.data.set(key, structuredClone(value));
  alive = false;
  new ChatSender({ api: cloud.api, outbox: kvOutbox(kept, "cloud", onlyPage()), retryMs: () => 5 });
  await until(() => ![...kept.data.keys()].some((key) => key.startsWith("outbox/cloud/")));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["first", "second"]);
});

test("after a reload, a call that went out goes to Cloud's queue only while the client would send it again: its chat still runs where it went out, on that epoch", async () => {
  const cloud = fakeCloud();
  const store = deviceStore();
  const { client } = heldClient();
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage()) });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "moved", input: { text: "hi" } }, { via: "runtime", client, runtime: "rt-b", epoch: 1, orCloud: true });
  void sender.send("s2", "turn.submit", { session_id: "s2", request_id: "stayed", input: { text: "hi" } }, { via: "runtime", client, runtime: "rt-b", epoch: 3, orCloud: true });
  const wentOut = (id: string) => store.data.get(`outbox/cloud/${id}`) as { epoch?: number; params?: { wentOut?: boolean; runtime?: string } } | undefined;
  await until(() => wentOut("moved")?.params?.wentOut === true && wentOut("stayed")?.params?.wentOut === true);
  expect(wentOut("moved")).toMatchObject({ epoch: 1, params: { runtime: "rt-b" } });

  // The page reloads. Cloud's list says s1 runs on rt-c now (hub.ts resendable).
  const kept = deviceStore();
  for (const [key, value] of store.data) kept.data.set(key, structuredClone(value));
  const asked: string[] = [];
  new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(kept, "cloud", onlyPage()),
    retryMs: () => 5,
    resendable: async (runtime, entry) => (asked.push(`${entry.request_id} on ${runtime} epoch ${entry.epoch}`), entry.request_id !== "moved"),
  });
  await until(() => ![...kept.data.keys()].some((key) => key.startsWith("outbox/cloud/")));
  expect(asked.sort()).toEqual(["moved on rt-b epoch 1", "stayed on rt-b epoch 3"]);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["stayed"]);
});

test("pages open side by side share the device's store: one that opens sends only what a page that is gone left, to Cloud's queue and on a runtime's connection", async () => {
  const runtime = new ModelRuntime(0);
  const cloud = fakeCloud();
  const store = deviceStore();
  const open = new Set<string>();
  // Pages that go here are found gone at the next load (the tests below take them over as they go).
  const page = (id: string): Pages => (open.add(id), { id, ready: Promise.resolve(), owns: () => true, alive: async (other) => open.has(other), watch: () => undefined, onGone: () => () => undefined, exclusive: (_name, take) => take() });
  const sockets: Record<string, ModelSocket[]> = {};
  const socket =
    (id: string): SocketFactory =>
    (url, bearer) => {
      const ws = runtime.factory(url, bearer);
      (sockets[id] ??= []).push(ws as unknown as ModelSocket);
      return ws;
    };
  // Page A, open: its send waits for its socket to the chat's computer, in A's outboxes.
  const a = page("page-a");
  const aClient = connect("wss://relay.test/rt-b", runtime.token, undefined, { socket: socket("a"), outbox: kvOutbox(store, "runtime/rt-b", a) });
  const aSender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", a), unsentMs: 60_000 });
  void aSender.send(SESSION, "turn.submit", { session_id: SESSION, request_id: "live", input: { text: "fix the tests" } }, { via: "runtime", client: aClient, epoch: 1, orCloud: true }).catch(() => undefined);
  await until(() => store.data.has("outbox/cloud/live") && store.data.has("outbox/runtime/rt-b/live"));
  // A page that closed left a send in each.
  const at = Date.now() - 1_000;
  store.data.set("outbox/cloud/left", { request_id: "left", method: "turn.submit", params: { session_id: "s2", call: { request_id: "left", input: { text: "left" } } }, at, page: "page-gone" });
  store.data.set("outbox/runtime/rt-b/left-rt", { request_id: "left-rt", method: "turn.submit", params: { session_id: SESSION, request_id: "left-rt", input: { text: "left" } }, at, page: "page-gone" });

  // Page B opens beside A.
  const b = page("page-b");
  const queued: string[] = [];
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", b), retryMs: () => 5, onQueued: (_s, call) => queued.push(call.request_id) });
  const bClient = connect("wss://relay.test/rt-b", runtime.token, undefined, { socket: socket("b"), outbox: kvOutbox(store, "runtime/rt-b", b) });
  await until(() => queued.length > 0 && (sockets.b ?? []).length > 0);
  for (const s of sockets.b!) runtime.open(s);
  await until(() => runtime.wire.some((f) => f.requestId === "left-rt"));
  await new Promise((r) => setTimeout(r, 20));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["left"]);
  expect(runtime.wire.filter((f) => f.requestId !== undefined).map((f) => `${f.requestId} on ${sockets.a?.some((s) => s.n === f.socket) ? "a" : "b"}`)).toEqual(["left-rt on b"]);
  // What B took over is B's now: a third page that opens while B is open leaves it to B. A's stays A's.
  const c = page("page-c");
  expect(await kvOutbox(store, "runtime/rt-b", c).load()).toEqual([]);
  expect(store.data.get("outbox/cloud/live")).toMatchObject({ page: "page-a" });
  // A goes: the next page to open takes over A's.
  open.delete("page-a");
  expect((await kvOutbox(store, "cloud", page("page-d")).load()).map((e) => e.request_id)).toEqual(["live"]);
  aClient.close();
  bClient.close();
});

test("a page is open while its Web Lock is held, and the lock goes with it", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const here = lockedPages(locks, `here-${Math.random()}`);
  await here.ready;
  const other = `other-${Math.random()}`;
  let close!: () => void;
  await new Promise<void>((held) => void locks.request(`caveman-page/${other}`, () => (held(), new Promise<void>((r) => (close = r)))));
  expect([await here.alive(here.id), await here.alive(other), await here.alive("never")]).toEqual([true, true, false]);
  const went: string[] = [];
  here.onGone((id) => went.push(id));
  here.watch(other);
  close();
  await until(() => went.includes(other));
  expect(await here.alive(other)).toBe(false);
  // Where the platform cannot say which locks are held, a page is open until its lock says it went.
  const unsure = lockedPages({ request: locks.request.bind(locks), query: () => Promise.reject(new Error("query failed")) } as unknown as LockManager, `unsure-${Math.random()}`);
  expect(await unsure.alive("anyone")).toBe(true);
});

test("a page takes over the calls of a page that opened after it and closed, without a reload, and of one that took them over and closed in turn (real Web Locks)", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const cloud = fakeCloud();
  const store = deviceStore();
  const call = (request_id: string, page: string) => ({ request_id, method: "turn.submit" as const, params: { session_id: "s1", call: { request_id, input: { text: request_id } } }, at: Date.now(), page });
  // Page B opens first: its outbox holds nothing yet.
  const b = lockedPages(locks, `b-${Math.random()}`);
  const queued: string[] = [];
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", b), retryMs: () => 5, onQueued: (_s, c) => queued.push(c.request_id) });
  await new Promise((r) => setTimeout(r, 30));
  // Page A opens after it, makes a call, and closes before it went anywhere.
  let closeA!: () => void;
  const a = lockedPages(locks, `a-${Math.random()}`, { life: new Promise<void>((r) => (closeA = r)) });
  await a.ready;
  await kvOutbox(store, "cloud", a).put(call("from-a", "unused"));
  await new Promise((r) => setTimeout(r, 30));
  expect(queued).toEqual([]);
  closeA();
  await until(() => queued.includes("from-a"));
  // A page left a call nobody watched; page C opens, takes it over, and closes before it sends it.
  store.data.set("outbox/cloud/left", call("left", "a-page-nobody-heard-of"));
  let closeC!: () => void;
  const c = lockedPages(locks, `c-${Math.random()}`, { life: new Promise<void>((r) => (closeC = r)) });
  expect((await kvOutbox(store, "cloud", c).load()).map((e) => e.request_id)).toEqual(["left"]);
  closeC();
  await until(() => queued.includes("left"));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["from-a", "left"]);
});

test("two pages that open at once never both take over one entry a gone page left (real Web Locks)", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const store = deviceStore();
  // A slow store, as IndexedDB under load: each read and write takes a moment, so two loads interleave.
  const slow = { ...store, scan: async (p: string) => (await new Promise((r) => setTimeout(r, 10)), store.scan(p)), put: async (k: string, v: unknown) => (await new Promise((r) => setTimeout(r, 10)), store.put(k, v)) } as typeof store;
  store.data.set("outbox/cloud/left", { request_id: "left", method: "turn.submit", params: { session_id: "s1", call: { request_id: "left" } }, at: Date.now(), page: "gone-page" });
  const b = lockedPages(locks, `b-${Math.random()}`);
  const c = lockedPages(locks, `c-${Math.random()}`);
  await Promise.all([b.ready, c.ready]);
  const [fromB, fromC] = await Promise.all([kvOutbox(slow, "cloud", b).load(), kvOutbox(slow, "cloud", c).load()]);
  expect(fromB.length + fromC.length).toBe(1);
});

test("a page open beside one that closes takes over what that page left once it goes, in Cloud's queue and on a runtime's connection, without a reload (real Web Locks)", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const runtime = new ModelRuntime(0);
  const cloud = fakeCloud();
  const store = deviceStore();
  // Page A is open, with a send waiting in each outbox.
  const a = `a-${Math.random()}`;
  let closeA!: () => void;
  await new Promise<void>((held) => void locks.request(`caveman-page/${a}`, () => (held(), new Promise<void>((r) => (closeA = r)))));
  const at = Date.now();
  store.data.set("outbox/cloud/from-a", { request_id: "from-a", method: "turn.submit", params: { session_id: "s2", call: { request_id: "from-a", input: { text: "hi" } } }, at, page: a });
  store.data.set("outbox/runtime/rt-b/from-a-rt", { request_id: "from-a-rt", method: "turn.submit", params: { session_id: SESSION, request_id: "from-a-rt", input: { text: "hi" } }, at, page: a });
  // Page B opens beside it: A's calls are A's.
  const b = lockedPages(locks, `b-${Math.random()}`);
  const queued: string[] = [];
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", b), retryMs: () => 5, onQueued: (_s, call) => queued.push(call.request_id) });
  const client = connect("wss://relay.test/rt-b", runtime.token, undefined, { socket: runtime.factory, outbox: kvOutbox(store, "runtime/rt-b", b) });
  await until(() => runtime.sockets.length > 0);
  runtime.open(runtime.sockets[0]!);
  await new Promise((r) => setTimeout(r, 50));
  expect(cloud.posted).toEqual([]);
  expect(runtime.wire.filter((f) => f.requestId !== undefined)).toEqual([]);
  // A closes. B takes over what it left at once, and sends it.
  closeA();
  await until(() => queued.length === 1 && runtime.wire.some((f) => f.requestId === "from-a-rt"));
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["from-a"]);
  expect(store.data.get("outbox/runtime/rt-b/from-a-rt")).toMatchObject({ page: b.id });
  client.close();
});

/** An outbox whose `taken` the test drives: `hand` gives every listener what it takes over. */
const handingOutbox = () => {
  const outbox = memoryOutbox();
  const listeners = new Set<(entries: ReadonlyArray<OutboxEntry>) => void>();
  return {
    outbox: { ...outbox, taken: (listener: (entries: ReadonlyArray<OutboxEntry>) => void) => (listeners.add(listener), () => void listeners.delete(listener)) },
    hand: (entries: ReadonlyArray<OutboxEntry>) => {
      for (const listener of listeners) listener(entries);
    },
    listening: () => listeners.size,
  };
};

test("a call taken over from a page that went goes in its chat's lane: this page's next send to that chat never reaches the runtime ahead of it", async () => {
  const cloud = fakeCloud();
  // Cloud takes a moment to take a call.
  const api: CloudApi = { ...cloud.api, call: async (...args) => (await new Promise((r) => setTimeout(r, 50)), cloud.api.call(...args)) };
  const { outbox, hand } = handingOutbox();
  const { client, sent } = heldClient();
  const sender = new ChatSender({ api, outbox, retryMs: () => 5 });
  await new Promise((r) => setTimeout(r, 10));
  hand([{ request_id: "orphan", method: "turn.submit", params: { session_id: "s1", call: { request_id: "orphan", input: { text: "fix the tests" } } }, at: Date.now() }]);
  const mine = sender.send("s1", "turn.submit", { session_id: "s1", request_id: "mine", input: { text: "then run them" } }, { via: "runtime", client, epoch: 1, orCloud: true });
  await new Promise((r) => setTimeout(r, 20));
  expect(sent, "nothing on the runtime's connection while the call ahead is on its way into Cloud's queue").toEqual([]);
  // Cloud holds the orphan, not run yet: the next call follows it there.
  await expect(mine).resolves.toMatchObject({ via: "cloud" });
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["orphan", "mine"]);
  expect(sent).toEqual([]);
});

test("a sender that is closed (its person signed out) takes nothing more over, and a listener that throws stops no other", async () => {
  const { outbox, hand, listening } = handingOutbox();
  const sender = new ChatSender({ api: fakeCloud().api, outbox });
  expect(listening()).toBe(1);
  sender.close();
  expect(listening()).toBe(0);

  // kvOutbox hands what it takes over to every listener, one throwing or not.
  const store = deviceStore();
  let went!: (id: string) => void;
  const pages: Pages = { ...onlyPage("here"), watch: () => undefined, onGone: (listener) => ((went = listener), () => undefined) };
  const kept = kvOutbox(store, "cloud", pages);
  store.data.set("outbox/cloud/left", { request_id: "left", method: "turn.submit", params: { session_id: "s1", call: { request_id: "left" } }, at: Date.now(), page: "gone-page" });
  const got: string[] = [];
  kept.taken!(() => {
    throw new Error("a listener that throws");
  });
  kept.taken!((entries) => void got.push(...entries.map((e) => e.request_id)));
  went("gone-page");
  await until(() => got.length === 1);
  expect(got).toEqual(["left"]);
});

const pageEvent = (type: "pagehide" | "pageshow", persisted: boolean) => Object.assign(new Event(type), { persisted });
const leftCall = (request_id: string, page: string) => ({ request_id, method: "turn.submit" as const, params: { session_id: "s1", call: { request_id, input: { text: request_id } } }, at: Date.now(), page });

test("a page whose lock the platform takes (WebKit's suspend for the back/forward cache) answers for nothing and takes nothing; the others take over its calls, and it loads anew", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const store = deviceStore();
  let suspend!: (reason: unknown) => void;
  const reloads: string[] = [];
  const a = lockedPages(locks, `a-${Math.random()}`, { life: new Promise<void>((_held, taken) => (suspend = taken)), reload: (why) => reloads.push(why) });
  const b = lockedPages(locks, `b-${Math.random()}`);
  await Promise.all([a.ready, b.ready]);
  store.data.set("outbox/cloud/a-live", leftCall("a-live", a.id));
  store.data.set("outbox/cloud/b-live", leftCall("b-live", b.id));
  const fromB: string[] = [];
  kvOutbox(store, "cloud", b).taken!((entries) => void fromB.push(...entries.map((e) => e.request_id)));
  // B heard A open, and waits for its lock.
  await new Promise((r) => setTimeout(r, 30));
  // WebKit's suspend: the held lock's promise rejects with AbortError, and the lock goes to whoever waits for it.
  suspend(new DOMException("The page went into the back/forward cache.", "AbortError"));
  await new Promise((r) => setTimeout(r, 30));
  // A answers for nothing: it loads nothing (B's call is B's), judges no page gone, and sends none of its calls again.
  expect(await kvOutbox(store, "cloud", a).load()).toEqual([]);
  expect(await a.alive(b.id)).toBe(true);
  expect(a.owns()).toBe(false);
  expect(kvOutbox(store, "cloud", a).ours!()).toBe(false);
  // B takes over A's call, and its own stays its own.
  await until(() => fromB.includes("a-live"));
  expect(store.data.get("outbox/cloud/a-live")).toMatchObject({ page: b.id });
  expect(store.data.get("outbox/cloud/b-live")).toMatchObject({ page: b.id });
  // Lost while shown: it reloads (backed off, as devicePages gives it).
  expect(reloads).toEqual(["lost"]);
});

test("a page going into the back/forward cache lets go of its lock: the others take over its calls at once, and shown again it loads anew", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const store = deviceStore();
  const window = new EventTarget();
  const reloads: string[] = [];
  const a = lockedPages(locks, `a-${Math.random()}`, { lifecycle: window, reload: (why) => reloads.push(why) });
  const b = lockedPages(locks, `b-${Math.random()}`);
  await Promise.all([a.ready, b.ready]);
  store.data.set("outbox/cloud/a-live", leftCall("a-live", a.id));
  const fromB: string[] = [];
  kvOutbox(store, "cloud", b).taken!((entries) => void fromB.push(...entries.map((e) => e.request_id)));
  await new Promise((r) => setTimeout(r, 30));
  // A reload or a close is not the cache: nothing changes.
  window.dispatchEvent(pageEvent("pagehide", false));
  expect(a.owns()).toBe(true);
  window.dispatchEvent(pageEvent("pagehide", true));
  expect(a.owns()).toBe(false);
  await until(() => fromB.includes("a-live"));
  expect(reloads, "nothing loads while the page is in the cache").toEqual([]);
  window.dispatchEvent(pageEvent("pageshow", true));
  expect(reloads).toEqual(["shown"]);
});

test("a page refused Web Locks neither says it is open nor answers one that does; a page's onGone listener that throws stops no other", async () => {
  const denied = () => Promise.reject(new DOMException("Access to the Locks API is denied in this context.", "SecurityError"));
  const ear = new BroadcastChannel("caveman-pages");
  const heard: Array<{ open?: string; here?: string }> = [];
  ear.onmessage = (message: MessageEvent<{ open?: string; here?: string }>) => void heard.push(message.data);
  const refused = lockedPages({ request: denied, query: denied } as unknown as LockManager, `refused-${Math.random()}`);
  await refused.ready;
  ear.postMessage({ open: `someone-${Math.random()}` });
  await new Promise((r) => setTimeout(r, 30));
  ear.close();
  expect(heard.filter((m) => m.open === refused.id || m.here === refused.id)).toEqual([]);

  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const here = lockedPages(locks, `here-${Math.random()}`);
  await here.ready;
  const other = `other-${Math.random()}`;
  let close!: () => void;
  await new Promise<void>((held) => void locks.request(`caveman-page/${other}`, () => (held(), new Promise<void>((r) => (close = r)))));
  const went: string[] = [];
  here.onGone(() => {
    throw new Error("a listener that throws");
  });
  here.onGone((id) => void went.push(id));
  here.watch(other);
  close();
  await until(() => went.includes(other));
});

test("a sender whose outbox no longer answers for its calls (the page lost its lock) posts none of them to Cloud", async () => {
  const cloud = fakeCloud();
  const outbox = { ...memoryOutbox(), ours: () => false };
  const sender = new ChatSender({ api: cloud.api, outbox, retryMs: () => 5 });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "hi" } }, { via: "cloud" }).catch(() => undefined);
  await new Promise((r) => setTimeout(r, 50));
  expect(cloud.posted).toEqual([]);
});

test("an outbox takes a gone page's calls over only for a reader that hands them on: one closing says no, and they stay the gone page's", async () => {
  const store = deviceStore();
  let went!: (id: string) => void;
  const pages: Pages = { ...onlyPage("here"), onGone: (listener) => ((went = listener), () => undefined) };
  const outbox = kvOutbox(store, "cloud", pages);
  store.data.set("outbox/cloud/left", leftCall("left", "gone-page"));
  const offered: string[] = [];
  outbox.taken!((entries) => (offered.push(...entries.map((e) => e.request_id)), false));
  went("gone-page");
  await until(() => offered.length === 1);
  await new Promise((r) => setTimeout(r, 10));
  expect(store.data.get("outbox/cloud/left")).toMatchObject({ page: "gone-page" });
});

/** A page that is told when another goes (`went`), as pages.ts tells it. */
const hearing = (id = "here", owns = true) => {
  let went!: (gone: string) => void;
  const pages: Pages = { ...onlyPage(id), owns: () => owns, onGone: (listener) => ((went = listener), () => undefined) };
  return { pages, went: (gone: string) => went(gone) };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("what the sender does at once with calls it takes over from a page that went (lets go of one Cloud cannot carry, deletes one Cloud took) stays done: the store renames them first", async () => {
  // The store applies each write a moment later, in the order made (IndexedDB): a rename written after the sender's
  // delete would put the call back, under this page.
  const store = deviceStore();
  const { pages, went } = hearing();
  const cloud = fakeCloud();
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", pages), retryMs: () => 5 });
  await sleep(20);
  store.data.set("outbox/cloud/a-first", { ...leftCall("a-first", "gone-page"), at: Date.now() - 2 });
  store.data.set("outbox/cloud/b-nocloud", { request_id: "b-nocloud", method: "turn.submit", params: { session_id: "s2", call: { request_id: "b-nocloud", input: { text: "b" } }, noCloud: true }, at: Date.now() - 1, page: "gone-page" });
  went("gone-page");
  await until(() => cloud.posted.length === 1);
  await sleep(100);
  expect([...store.data.keys()]).toEqual([]);
});

test("calls taken over from a page that went, each posted to Cloud's queue, are gone from the store after: the next page to load sends none again", async () => {
  const store = deviceStore();
  const { pages, went } = hearing();
  const cloud = fakeCloud();
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", pages), retryMs: () => 5 });
  await sleep(20);
  for (const [i, id] of ["a", "b", "c"].entries())
    store.data.set(`outbox/cloud/${id}`, { request_id: id, method: "turn.submit", params: { session_id: `s-${id}`, call: { request_id: id, input: { text: id } } }, at: Date.now() - 3 + i, page: "gone-page" });
  went("gone-page");
  await until(() => cloud.posted.length === 3);
  await sleep(100);
  expect([...store.data.keys()]).toEqual([]);
  expect(await kvOutbox(store, "cloud", onlyPage("next")).load()).toEqual([]);
});

test("a page that lost its lock writes over none of the calls it wrote before that another page took over, deletes none, and keeps a new one for the next page", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const store = deviceStore();
  const window = new EventTarget();
  const a = lockedPages(locks, `a-${Math.random()}`, { lifecycle: window });
  await a.ready;
  const outbox = kvOutbox(store, "cloud", a);
  const call = (request_id: string) => ({ request_id, method: "turn.submit" as const, params: { session_id: "s1", call: { request_id, input: { text: request_id } } }, at: Date.now() });
  await outbox.put(call("taken"));
  // A goes into the back/forward cache, and B takes its call over.
  window.dispatchEvent(pageEvent("pagehide", true));
  const bs = leftCall("taken", "page-b");
  store.data.set("outbox/cloud/taken", bs);
  // A writes it again (a mark on it) and lets go of it (its answer came): neither touches B's.
  await outbox.put({ ...call("taken"), wentOut: true } as never);
  await outbox.delete("taken");
  // A call A makes now is nobody else's: kept under A's name.
  await outbox.put(call("after"));
  await sleep(10);
  expect(store.data.get("outbox/cloud/taken")).toEqual(bs);
  expect(store.data.get("outbox/cloud/after")).toMatchObject({ page: a.id });
  // The page that loads next (A, anew, beside B) takes it over, and leaves B's to B.
  const anew: Pages = { ...onlyPage("a-anew"), alive: async (other) => other === "a-anew" || other === "page-b" };
  expect((await kvOutbox(store, "cloud", anew).load()).map((e) => e.request_id)).toEqual(["after"]);
});

test("a page that lost its lock writes again none of the calls another page took over from it, and keeps one it had deleted and makes again", async () => {
  const store = deviceStore();
  let owns = true;
  let went!: (gone: string) => void;
  const pages: Pages = { ...onlyPage("a"), owns: () => owns, onGone: (listener) => ((went = listener), () => undefined) };
  const outbox = kvOutbox(store, "cloud", pages);
  // A takes over one call as it loads, and one as its page goes.
  store.data.set("outbox/cloud/loaded", leftCall("loaded", "gone-1"));
  expect((await outbox.load()).map((e) => e.request_id)).toEqual(["loaded"]);
  outbox.taken!(() => true);
  store.data.set("outbox/cloud/handed", leftCall("handed", "gone-2"));
  went("gone-2");
  await until(() => (store.data.get("outbox/cloud/handed") as { page: string }).page === "a");
  // And one it put and deleted (answered).
  await outbox.put({ request_id: "again", method: "turn.submit", params: { session_id: "s1" }, at: Date.now() });
  await outbox.delete("again");
  // A loses its lock; B takes over what A held.
  owns = false;
  for (const id of ["loaded", "handed"]) store.data.set(`outbox/cloud/${id}`, leftCall(id, "page-b"));
  for (const id of ["loaded", "handed", "again"]) await outbox.put({ request_id: id, method: "turn.submit", params: { session_id: "s1" }, at: Date.now() });
  await sleep(10);
  expect(Object.fromEntries([...store.data].map(([key, e]) => [key, (e as { page: string }).page]))).toEqual({
    "outbox/cloud/loaded": "page-b",
    "outbox/cloud/handed": "page-b",
    "outbox/cloud/again": "a",
  });
});

test("a send made on a page that lost its lock, before it reloads, is not lost: the next page posts it, once", async () => {
  const store = deviceStore();
  const cloud = fakeCloud();
  const { pages: lost } = hearing("lost-page", false);
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", lost), retryMs: () => 5 });
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "hi" } }, { via: "cloud" }).catch(() => undefined);
  await sleep(50);
  expect(cloud.posted, "the lost page sends nothing").toEqual([]);
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage("next")), retryMs: () => 5 });
  await until(() => cloud.posted.length > 0).catch(() => undefined);
  await sleep(50);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1"]);
});

test("a send on a page that lost its lock, made where Cloud could not carry it and then rerouted to Cloud's queue, is posted after the reload: the page writes its later marks on a call nobody took over", async () => {
  const store = deviceStore();
  const cloud = fakeCloud();
  const { pages: lost } = hearing("lost-page", false);
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", lost), retryMs: () => 5 });
  const runtimeOnly: Route = { via: "runtime", client: { call: async () => ({}) } as never };
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "hi" } }, runtimeOnly, () => ({ via: "cloud" })).catch(() => undefined);
  await sleep(50);
  expect(cloud.posted, "the lost page sends nothing").toEqual([]);
  new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage("next")), retryMs: () => 5 });
  await until(() => cloud.posted.length > 0).catch(() => undefined);
  await sleep(50);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1"]);
});

test("a page that loses its lock while it takes a gone page's calls over writes none of them after: another page may be taking them over", async () => {
  // The lock goes as the store reads (or renames); meanwhile another page takes the call over.
  const losing = (when: "scan" | "batch" = "scan") => {
    const store = deviceStore();
    let owns = true;
    store.data.set("outbox/cloud/left", leftCall("left", "gone-page"));
    const lose = () => {
      owns = false;
      store.data.set("outbox/cloud/left", leftCall("left", "other-page"));
    };
    const reading = {
      ...store,
      scan: async <T,>(prefix: string) => {
        const kept = await store.scan<T>(prefix);
        if (when === "scan") lose();
        return kept;
      },
      batch: async (writes: ReadonlyArray<readonly [string, unknown]>, deletes?: ReadonlyArray<string>) => {
        await store.batch(writes, deletes);
        if (when === "batch" && owns) lose();
      },
    };
    let went!: (gone: string) => void;
    const pages: Pages = { ...onlyPage("here"), owns: () => owns, onGone: (listener) => ((went = listener), () => undefined) };
    return { store, outbox: kvOutbox(reading, "cloud", pages), went: (gone: string) => went(gone) };
  };
  const told = losing();
  const offered: string[] = [];
  told.outbox.taken!((entries) => void offered.push(...entries.map((e) => e.request_id)));
  told.went("gone-page");
  await sleep(50);
  expect(offered).toEqual([]);
  expect((told.store.data.get("outbox/cloud/left") as { page: string }).page).toBe("other-page");

  const loading = losing();
  expect(await loading.outbox.load()).toEqual([]);
  await sleep(20);
  expect((loading.store.data.get("outbox/cloud/left") as { page: string }).page).toBe("other-page");

  // Renamed, then no reader here takes it (each closing), and the lock goes before it is given back.
  const declined = losing("batch");
  declined.outbox.taken!(() => false);
  declined.went("gone-page");
  await sleep(50);
  expect((declined.store.data.get("outbox/cloud/left") as { page: string }).page).toBe("other-page");
});

test("a call on a page that lost its lock is never marked as one that may have gone out: it cannot leave from there, and the page loaded anew an hour later still posts it", async () => {
  const store = deviceStore();
  const cloud = fakeCloud();
  const { pages: lost } = hearing("lost-page", false);
  const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", lost), retryMs: () => 5 });
  // Its connection keeps it, says so (client.ts onKept), and sends nothing from a page that lost its lock.
  const keeping = { call: (_method: string, _params: unknown, options?: { onKept?: () => unknown }) => (void options?.onKept?.(), new Promise(() => undefined)) } as unknown as Client;
  void sender.send("s1", "turn.submit", { session_id: "s1", request_id: "r1", input: { text: "hi" } }, { via: "runtime", client: keeping, runtime: "rt-b", epoch: 1, orCloud: true }).catch(() => undefined);
  await sleep(50);
  expect((store.data.get("outbox/cloud/r1") as { params: { wentOut?: boolean } }).params.wentOut).toBeUndefined();
  // Shown again from the back/forward cache an hour later, the page loads anew.
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 60_000;
  try {
    new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", onlyPage("next")), retryMs: () => 5 });
    await until(() => cloud.posted.length > 0).catch(() => undefined);
  } finally {
    Date.now = realNow;
  }
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r1"]);
});

test("a page that loses its lock as its load writes the last call it takes over hands none of them on: another page may be taking them now", async () => {
  const store = deviceStore();
  let owns = true;
  store.data.set("outbox/cloud/left", leftCall("left", "gone-page"));
  const writing = {
    ...store,
    put: async (key: string, value: unknown) => {
      await store.put(key, value);
      owns = false;
    },
  };
  const pages: Pages = { ...onlyPage("here"), owns: () => owns };
  expect(await kvOutbox(writing, "cloud", pages).load()).toEqual([]);
});

test("a page that lost its lock runs work under an outbox's lock only while no other page holds it, and none when the platform refuses it", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const window = new EventTarget();
  const a = lockedPages(locks, `a-${Math.random()}`, { lifecycle: window });
  const b = lockedPages(locks, `b-${Math.random()}`);
  await Promise.all([a.ready, b.ready]);
  window.dispatchEvent(pageEvent("pagehide", true));
  const scope = `cloud-${Math.random()}`;
  const ran: string[] = [];
  let done!: () => void;
  const takingOver = b.exclusive(scope, () => new Promise<void>((r) => (done = () => (ran.push("b"), r()))));
  await sleep(10);
  const rewriting = a.exclusive(scope, async () => void ran.push("a"));
  await sleep(30);
  expect(ran, "a waits for b's takeover").toEqual([]);
  done();
  await Promise.all([takingOver, rewriting]);
  expect(ran).toEqual(["b", "a"]);

  const refusing = { request: () => Promise.reject(new DOMException("refused", "SecurityError")), query: () => locks.query() } as unknown as LockManager;
  const life = new EventTarget();
  const c = lockedPages(refusing, `c-${Math.random()}`, { lifecycle: life });
  await c.ready;
  expect(await c.exclusive("cloud", async () => "ran"), "refused before it was granted, it owns every entry and runs it").toBe("ran");
  const d = lockedPages({ request: (name: string, granted: LockGrantedCallback<unknown>) => (name.startsWith("caveman-outbox/") ? refusing.request(name, granted) : locks.request(name, granted)), query: () => locks.query() } as unknown as LockManager, `d-${Math.random()}`, { lifecycle: life });
  await d.ready;
  life.dispatchEvent(pageEvent("pagehide", true));
  let wrote = false;
  await expect(d.exclusive("cloud", async () => void (wrote = true))).rejects.toThrow("refused");
  expect(wrote, "lost, it writes nothing without the lock").toBe(false);
});

test("a page that lost its lock rewrites a call of its own only under the outbox's lock: another page's takeover, and what that page's reader did with the call, stay done", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const base = deviceStore();
  // The lost page's read of the call is slow: another page's takeover runs meanwhile, unless the lock holds it back.
  let gating = false;
  let release!: () => void;
  const slowRead = new Promise<void>((r) => (release = r));
  const store = {
    ...base,
    get: async <T,>(key: string) => {
      const value = await base.get<T>(key);
      if (gating) await slowRead;
      return value;
    },
  };
  const window = new EventTarget();
  const a = lockedPages(locks, `a-${Math.random()}`, { lifecycle: window });
  const b = lockedPages(locks, `b-${Math.random()}`);
  await Promise.all([a.ready, b.ready]);
  const fromA = kvOutbox(store, "cloud", a);
  const fromB = kvOutbox(store, "cloud", b);
  const call = { request_id: "r1", method: "turn.submit" as const, params: { session_id: "s1", call: { request_id: "r1", input: { text: "r1" } } }, at: Date.now() };
  await fromA.put(call);
  // B reads this outbox, and acts on a call it takes over at once (as the sender lets go of one Cloud cannot carry).
  const taken: string[] = [];
  fromB.taken!((entries) => {
    for (const e of entries) {
      taken.push(e.request_id);
      void fromB.delete(e.request_id);
    }
    return true;
  });
  await sleep(30); // B heard A open, and waits for its lock
  gating = true;
  window.dispatchEvent(pageEvent("pagehide", true));
  // A marks the call (it may have gone out) as the page goes.
  const marking = fromA.put({ ...call, params: { ...call.params, wentOut: true } });
  await until(() => !base.data.has("outbox/cloud/r1"), 300).catch(() => undefined);
  release();
  await marking;
  await until(() => taken.length === 1 && !base.data.has("outbox/cloud/r1")).catch(() => undefined);
  expect(taken).toEqual(["r1"]);
  expect(base.data.get("outbox/cloud/r1"), "nothing written over B's takeover brings the call back").toBeUndefined();
});

test("a page that lost its lock takes nothing when it loads, its own calls included, and judges no page gone, though nobody has taken them yet", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const store = deviceStore();
  const window = new EventTarget();
  const a = lockedPages(locks, `a-${Math.random()}`, { lifecycle: window });
  await a.ready;
  store.data.set("outbox/cloud/mine", leftCall("mine", a.id));
  store.data.set("outbox/cloud/left", leftCall("left", "a-page-long-gone"));
  window.dispatchEvent(pageEvent("pagehide", true));
  expect(await a.alive("a-page-long-gone")).toBe(true);
  expect(await kvOutbox(store, "cloud", a).load()).toEqual([]);
  expect(store.data.get("outbox/cloud/mine")).toMatchObject({ page: a.id });
  expect(store.data.get("outbox/cloud/left")).toMatchObject({ page: "a-page-long-gone" });
});

test("a page that lost its lock watches no page: it is not told one it waited for went, asks for no other's lock, and its outbox takes nothing over", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const asked: string[] = [];
  const counted = { request: (name: string, granted: LockGrantedCallback<unknown>) => (asked.push(name), locks.request(name, granted)), query: () => locks.query() } as unknown as LockManager;
  const window = new EventTarget();
  const a = lockedPages(counted, `a-${Math.random()}`, { lifecycle: window });
  await a.ready;
  const other = `other-${Math.random()}`;
  let close!: () => void;
  await new Promise<void>((held) => void locks.request(`caveman-page/${other}`, () => (held(), new Promise<void>((r) => (close = r)))));
  const went: string[] = [];
  a.onGone((id) => void went.push(id));
  // A waits for the other's lock, and loses its own meanwhile; the other goes.
  a.watch(other);
  await sleep(20);
  expect(asked).toContain(`caveman-page/${other}`);
  window.dispatchEvent(pageEvent("pagehide", true));
  close();
  await sleep(30);
  expect(went).toEqual([]);
  // Asked to watch one more now, it asks for no lock.
  const another = `another-${Math.random()}`;
  a.watch(another);
  await sleep(20);
  expect(asked).not.toContain(`caveman-page/${another}`);

  // Told a page went all the same, an outbox whose page lost its lock hands nothing on and renames nothing.
  const store = deviceStore();
  const { pages, went: gone } = hearing("here", false);
  const outbox = kvOutbox(store, "cloud", pages);
  store.data.set("outbox/cloud/left", leftCall("left", "gone-page"));
  const offered: string[] = [];
  outbox.taken!((entries) => void offered.push(...entries.map((e) => e.request_id)));
  gone("gone-page");
  await sleep(30);
  expect(offered).toEqual([]);
  expect(store.data.get("outbox/cloud/left")).toMatchObject({ page: "gone-page" });
});

test("a page that goes into the back/forward cache while it still asks for its lock is settled lost: the lock, when it comes, is let go of at once, and it says nothing", async () => {
  const locks = (globalThis.navigator as { locks?: LockManager }).locks!;
  const id = `a-${Math.random()}`;
  // Its lock is not free yet: the page asks.
  let free!: () => void;
  await new Promise<void>((held) => void locks.request(`caveman-page/${id}`, () => (held(), new Promise<void>((r) => (free = r)))));
  const ear = new BroadcastChannel("caveman-pages");
  const heard: Array<{ open?: string; here?: string }> = [];
  ear.onmessage = (message: MessageEvent<{ open?: string; here?: string }>) => void heard.push(message.data);
  const window = new EventTarget();
  const reloads: string[] = [];
  const a = lockedPages(locks, id, { lifecycle: window, reload: (why) => reloads.push(why) });
  window.dispatchEvent(pageEvent("pagehide", true));
  // Settled at once: what waits for it (an outbox's put) does not wait for the lock.
  await expect(Promise.race([a.ready.then(() => "settled"), sleep(100).then(() => "still asking")])).resolves.toBe("settled");
  expect(a.owns()).toBe(false);
  // Shown again, it loads anew (once); the lock comes while it does.
  window.dispatchEvent(pageEvent("pageshow", true));
  free();
  await sleep(50);
  ear.close();
  expect(a.owns()).toBe(false);
  expect(reloads, "the lock coming changes nothing: the page is lost, and loads anew once").toEqual(["shown"]);
  expect(heard.filter((m) => m.open === id || m.here === id)).toEqual([]);
  expect(((await locks.query()).held ?? []).some((lock) => lock.name === `caveman-page/${id}`)).toBe(false);
});

test("the window's page reloads once its lock is lost: shown again from the back/forward cache at once, lost while shown after the tab's back-off", async () => {
  // A window: its own lock manager (whose lock the platform can take), lifecycle events, location and sessionStorage.
  // The tab reloaded three times in the last minute already.
  const window = new EventTarget();
  const takes: Array<(reason: unknown) => void> = [];
  const locks = {
    request: (_name: string, granted: () => unknown) => new Promise((resolve, reject) => (takes.push(reject), void Promise.resolve(granted()).then(resolve, reject))),
    query: async () => ({ held: [], pending: [] }),
  };
  const kept = new Map<string, string>();
  const reloads: number[] = [];
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
  vi.setSystemTime(10_000_000);
  kept.set("caveman-page/reloads", JSON.stringify([9_970_000, 9_980_000, 9_990_000]));
  vi.stubGlobal("navigator", { locks });
  vi.stubGlobal("addEventListener", (type: string, listener: EventListener) => window.addEventListener(type, listener));
  vi.stubGlobal("location", { reload: () => void reloads.push(Date.now()) });
  vi.stubGlobal("sessionStorage", { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) });
  try {
    // Shown again from the cache: it reloads at once, whatever the tab's count.
    const cached = devicePages("cached");
    await cached.ready;
    window.dispatchEvent(pageEvent("pagehide", true));
    window.dispatchEvent(pageEvent("pageshow", true));
    expect(reloads).toEqual([10_000_000]);

    // Lost while shown (the platform took its lock): the fourth in a minute waits a second.
    reloads.length = 0;
    const shown = devicePages("shown");
    await shown.ready;
    takes.at(-1)!(new DOMException("taken", "AbortError"));
    await vi.advanceTimersByTimeAsync(999);
    expect(reloads).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(reloads).toEqual([10_001_000]);
    expect(JSON.parse(kept.get("caveman-page/reloads")!)).toHaveLength(4);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("a tab whose page keeps losing its lock while shown reloads after a growing wait: a few at once, then twice as long each time, up to a minute", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value) };
  let now = 1_000_000;
  const waits: number[] = [];
  let reloads = 0;
  // One per page life; each asks twice (lost, then shown), and reloads once.
  const life = () => backedOffReload(() => void reloads++, storage, { now: () => now, wait: (run, ms) => (waits.push(ms), (now += ms), run()) });
  for (let i = 0; i < 10; i++) {
    const reload = life();
    reload();
    reload();
    now += 100;
  }
  expect(reloads).toBe(10);
  expect(waits).toEqual([0, 0, 0, 1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
  // A while later they go at once again.
  now += RELOAD_WINDOW_MS;
  life()();
  expect(waits.at(-1)).toBe(0);
  // A store it cannot read or write holds no reload back.
  const broken = { getItem: () => "not json", setItem: () => { throw new Error("quota"); } };
  backedOffReload(() => void reloads++, broken, { now: () => now, wait: (run, ms) => (waits.push(ms), run()) })();
  expect([reloads, waits.at(-1)]).toEqual([12, 0]);
});

test("a page the platform refuses Web Locks (site data blocked) still sends every call, and owns every entry as before pages had owners", async () => {
  const denied = () => Promise.reject(new DOMException("Access to the Locks API is denied in this context.", "SecurityError"));
  for (const locks of [{ request: denied, query: denied }, { request: () => { throw new DOMException("denied", "SecurityError"); }, query: denied }] as unknown as LockManager[]) {
    const cloud = fakeCloud();
    const store = deviceStore();
    const pages = lockedPages(locks, `refused-${Math.random()}`);
    store.data.set("outbox/cloud/left", { request_id: "left", method: "turn.submit", params: { session_id: "s1", call: { request_id: "left", input: { text: "left" } } }, at: Date.now() - 1_000, page: "another-page" });
    const queued: string[] = [];
    const sender = new ChatSender({ api: cloud.api, outbox: kvOutbox(store, "cloud", pages), retryMs: () => 5, onQueued: (_s, call) => queued.push(call.request_id) });
    const sent = sender.send("s2", "turn.submit", { session_id: "s2", request_id: "r1", input: { text: "hi" } }, { via: "cloud" });
    await expect(Promise.race([sent, new Promise((_r, reject) => setTimeout(() => reject(new Error("the send never went out")), 1_000))])).resolves.toMatchObject({ via: "cloud" });
    await until(() => queued.length === 1 && ![...store.data.keys()].some((key) => key.startsWith("outbox/cloud/")));
    expect(cloud.posted.map((p) => p.request_id).sort()).toEqual(["left", "r1"]);
  }
});

test("a queued call says plainly what it waits for", () => {
  const box = { name: "api-box", cloud: true };
  const mac = { name: "Julius's MacBook", cloud: false };
  expect(queuedLine({ status: "queued" }, box)).toBe("Queued · waking api-box");
  expect(queuedLine({ status: "queued" }, mac)).toBe("Queued · Julius's MacBook");
  expect(queuedLine({ status: "queued", waiting: { reason: "laptop_asleep" } }, mac)).toBe("Waiting for Julius's MacBook");
  expect(queuedLine({ status: "queued", waiting: { reason: "not_movable", detail: "Its repository is not on GitHub, so it waits for Julius's MacBook." } }, mac)).toBe("Its repository is not on GitHub, so it waits for Julius's MacBook.");
  expect(queuedLine({ status: "queued", waiting: { reason: "not_movable" } }, mac)).toBe("Waiting for Julius's MacBook. This chat cannot move to a Cloud computer.");
  expect(queuedLine({ status: "delivered" }, box)).toBe("Delivered · api-box");
  expect(queuedLine({ status: "done" }, box)).toBeNull();
});

test("device hooks (S13): queued calls carry the device's fields, pooled sockets run the runtime's handshake", async () => {
  const cloud = fakeCloud();
  const bodies: unknown[] = [];
  const sender = new ChatSender({
    api: { ...cloud.api, call: async (id, requestId, method, params, extra) => (bodies.push(extra), cloud.api.call(id, requestId, method, params)) },
    outbox: kvOutbox(deviceStore(), "cloud", onlyPage()),
    // Signing takes a moment (WebCrypto), and covers the call itself: awaited before the post, given the call.
    callFields: async (call) => (await new Promise((r) => setTimeout(r, 10)), { device: { signed: call } }),
  });
  await sender.send("s1", "turn.submit", { request_id: "r1", input: { text: "hi", when: undefined, list: [undefined] } }, { via: "cloud" });
  expect(bodies).toEqual([{ device: { signed: { session_id: "s1", request_id: "r1", method: "turn.submit", params: { request_id: "r1", input: { text: "hi", list: [null] } } } } }]);

  const { opened, connect } = fakeConnect();
  const handshake = async () => undefined;
  const pool = new RuntimePool({ endpoint: (id) => ({ url: `wss://cloud.test/${id}`, token: "" }), connect, handshake: (id) => (id === "rt-mac" ? handshake : undefined) });
  pool.acquire("rt-mac");
  pool.acquire("rt-box");
  expect(opened[0]!.options?.handshake).toBe(handshake);
  expect(opened[1]!.options?.handshake).toBeUndefined();
});
