import type { SessionEvent } from "@caveman-app/session-protocol";
import { connect, type Client, type Subscription } from "@caveman-app/session-protocol/client";
import { expect, test } from "vitest";
import { installClock, ModelRuntime, SESSION } from "../../../../../packages/session-protocol/test/modelRuntime.ts";
import { ChatFeed, type FeedState } from "./chat-feed.ts";
import { event, fakeCloud, fakeRuntimeClient, until } from "./fakes.test-support.ts";
import { memoryKv } from "./kv.ts";
import { TranscriptCache } from "./transcript-cache.ts";
import type { CopyPage } from "./wire.ts";

/** What a view shows: the events it was handed, reset when told. */
const view = () => {
  const shown: number[] = [];
  const resets: number[] = [];
  const states: FeedState["kind"][] = [];
  return {
    shown,
    resets,
    states,
    sink: {
      reset: (epoch: number) => {
        resets.push(epoch);
        shown.length = 0;
      },
      apply: (e: SessionEvent) => shown.push(e.cursor),
    },
    onState: (s: FeedState) => states.push(s.kind),
  };
};
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

test("attach backlog is history; only events past its head animate as live output", async () => {
  const rt = fakeRuntimeClient();
  rt.append("resume");
  rt.append("resume");
  const deliveries: Array<{ cursor: number; historical: boolean | undefined }> = [];
  const feed = new ChatFeed({ sessionId: "resume", sink: { reset: () => undefined, apply: (event, historical?: boolean) => { deliveries.push({ cursor: event.cursor, historical }); } } });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => deliveries.length === 2 && feed.current().kind === "live");
  rt.append("resume");
  expect(deliveries).toEqual([{ cursor: 1, historical: true }, { cursor: 2, historical: true }, { cursor: 3, historical: false }]);
  feed.close();
});

test("a view switches runtime, copy, runtime with no duplicate and no gap", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 5; i++) rt.append("s1");
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, copy: (epoch, after) => cloud.api.events("s1", epoch, after), onState: v.onState });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.shown.length === 5);
  rt.append("s1"); // 6, live
  await until(() => v.shown.length === 6);

  // The computer goes to sleep. Cloud's copy has 1..8: two it never streamed, and the ones the view already shows.
  rt.append("s1");
  rt.append("s1");
  cloud.copy("s1", 1, rt.journal("s1").events.slice());
  feed.use({ kind: "copy" });
  await until(() => v.shown.length === 8 && feed.current().kind === "copy");
  expect(feed.current()).toEqual({ kind: "copy", through: 8 });

  // It wakes with more: the view goes back to it from cursor 8.
  rt.append("s1");
  rt.append("s1");
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.shown.length === 10);
  rt.append("s1");
  await until(() => v.shown.length === 11);
  expect(v.shown).toEqual(range(1, 11));
  expect(rt.attaches.map((a) => a.cursor)).toEqual([0, 8]);
  expect(rt.active()).toBe(1);
  expect(v.resets).toEqual([]);
});

test("a copy behind the runtime adds nothing and repeats nothing", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 6; i++) rt.append("s1");
  cloud.copy("s1", 1, rt.journal("s1").events.slice(0, 3)); // the copy is three behind
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, copy: (epoch, after) => cloud.api.events("s1", epoch, after) });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.shown.length === 6);
  feed.use({ kind: "copy" });
  await until(() => feed.current().kind === "copy");
  cloud.copy("s1", 1, rt.journal("s1").events.slice()); // it catches up
  feed.copyAdvanced();
  rt.append("s1");
  cloud.copy("s1", 1, rt.journal("s1").events.slice());
  feed.copyAdvanced();
  await until(() => v.shown.length === 7);
  expect(v.shown).toEqual(range(1, 7));
});

test("a new epoch (the chat moved back, or its runtime lost a tail) drops what the view holds and replays", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 4; i++) rt.append("s1");
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, copy: (epoch, after) => cloud.api.events("s1", epoch, after) });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.shown.length === 4);
  rt.rewrite("s1", ["x", "y"]);
  await until(() => v.resets.length === 1 && v.shown.length === 2);
  expect(v.resets).toEqual([2]);
  expect(feed.position()).toEqual({ epoch: 2, cursor: 2 });

  // The copy too: one on epoch 3 answers `reset` to a read on epoch 2.
  cloud.copy("s1", 3, [event("s1", 1, "p"), event("s1", 2, "q"), event("s1", 3, "r")]);
  feed.use({ kind: "copy" });
  await until(() => v.resets.length === 2 && v.shown.length === 3);
  expect(v.resets).toEqual([2, 3]);
  expect(v.shown).toEqual([1, 2, 3]);
});

test("a subscription the runtime ends shows why, shows the copy meanwhile, and comes back by itself", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 3; i++) rt.append("s1");
  const v = view();
  const states: FeedState[] = [];
  const feed = new ChatFeed({
    sessionId: "s1",
    sink: v.sink,
    copy: (epoch, after) => cloud.api.events("s1", epoch, after),
    onState: (s) => states.push(s),
    retryMs: () => 20,
  });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.shown.length === 3);
  rt.append("s1");
  rt.append("s1");
  cloud.copy("s1", 1, rt.journal("s1").events.slice());
  rt.refuse("lease_lost"); // the next attach is refused too
  rt.end("lease_lost");
  await until(() => states.some((s) => s.kind === "ended"));
  expect(states.find((s) => s.kind === "ended")).toEqual({ kind: "ended", reason: "lease_lost", message: "This chat moved to another computer." });
  await until(() => v.shown.length === 5); // never a silent freeze: the copy fills in
  rt.refuse(undefined);
  rt.append("s1");
  await until(() => feed.current().kind === "live" && v.shown.length === 6);
  expect(v.shown).toEqual(range(1, 6));
  expect(rt.attaches.length).toBeGreaterThanOrEqual(2);
});

test("a link that drops says reconnecting, then live", async () => {
  const rt = fakeRuntimeClient();
  rt.append("s1");
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, onState: v.onState });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => feed.current().kind === "live");
  rt.linkDown();
  expect(feed.current().kind).toBe("reconnecting");
});

test("a chat opened while its computer's relay token cannot be minted waits for one, never shown refused", async () => {
  const { timers, restore } = installClock();
  try {
    // The real client: the desktop mints a Cloud computer's relay token through This Mac's runtime and Cloud.
    const runtime = new ModelRuntime(1);
    const client = connect("wss://relay.test/rt-1", runtime.token, undefined, { socket: runtime.factory });
    const shown: number[] = [];
    const states: FeedState[] = [];
    const feed = new ChatFeed({ sessionId: SESSION, sink: { reset: () => undefined, apply: (e) => void shown.push(e.cursor) }, onState: (s) => void states.push(s) });
    feed.use({ kind: "runtime", runtimeId: "rt-1", client });
    await timers.settle();
    // The first attempt fails before it opens, and Cloud is out of reach for the next token.
    runtime.tokenFailures = 1;
    runtime.drop(runtime.connecting()!);
    await timers.settle();
    while (runtime.tokenFailures > 0) await timers.advanceToNext();
    await timers.settle();
    expect(states).toEqual([{ kind: "loading" }]);

    while (!runtime.connecting()) await timers.advanceToNext();
    runtime.open(runtime.connecting()!);
    await timers.settle();
    const socket = runtime.live()[0]!;
    runtime.answer(socket, socket.requests.find((r) => r.method === "session.attach")!);
    await timers.settle();
    expect({ kinds: [...new Set(states.map((s) => s.kind))], shown }).toEqual({ kinds: ["loading", "live"], shown: [1] });
    feed.close();
    client.close();
  } finally {
    restore();
  }
});

test("a chat shown again opens on what the window holds and catches up without saying reconnecting", async () => {
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 3; i++) rt.append("s1");
  const first = view();
  const one = new ChatFeed({ sessionId: "s1", sink: first.sink, onState: first.onState });
  one.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => one.current().kind === "live" && first.shown.length === 3);
  one.close();

  rt.append("s1");
  const again = view();
  const two = new ChatFeed({ sessionId: "s1", sink: again.sink, onState: again.onState, start: { epoch: undefined, cursor: 3 } });
  two.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => two.current().kind === "live" && again.shown.length === 1);
  expect(again.shown).toEqual([4]);
  // Nothing dropped: the line under the chat never comes and goes.
  expect(again.states).not.toContain("reconnecting");
  // A link that drops after that still says so.
  rt.linkDown();
  expect(two.current().kind).toBe("reconnecting");
});

test("a chat opened before paints from the device's cache and resumes from its cursor", async () => {
  const kv = memoryKv();
  const cache = new TranscriptCache(kv);
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 5; i++) rt.append("s1");
  const first = view();
  const one = new ChatFeed({ sessionId: "s1", sink: first.sink, cache, cacheEveryMs: 1 });
  one.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => first.shown.length === 5);
  await one.writeCache();
  one.close();

  rt.append("s1");
  const second = view();
  const two = new ChatFeed({ sessionId: "s1", sink: second.sink, cache });
  two.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => second.shown.length === 6);
  expect(second.shown).toEqual(range(1, 6));
  expect(rt.attaches.at(-1)).toEqual({ session: "s1", cursor: 5, epoch: 1 });
});

test("a cache from an old epoch is dropped on attach, never shown mixed with the new one", async () => {
  const kv = memoryKv();
  const cache = new TranscriptCache(kv);
  await cache.append("s1", 1, [event("s1", 1), event("s1", 2), event("s1", 3)]);
  const rt = fakeRuntimeClient();
  rt.rewrite("s1", ["x", "y"]); // epoch 2
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, cache, cacheEveryMs: 1 });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.resets.length === 1 && v.shown.length === 2);
  expect(v.shown).toEqual([1, 2]);
  await feed.writeCache();
  expect(await cache.load("s1")).toMatchObject({ epoch: 2, events: [{ cursor: 1 }, { cursor: 2 }] });
});

test("an event's delay from commit is measured for live events only, never the attach's backlog, per way it came", async () => {
  const { latency } = await import("./latency.ts");
  latency.clear();
  const rt = fakeRuntimeClient();
  for (let i = 0; i < 4; i++) rt.append("s1"); // backlog, committed long ago
  rt.journal("s1").events.forEach((e) => ((e as { at: string }).at = "2026-10-21T00:00:00.000Z"));
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client, via: "direct" });
  await until(() => v.shown.length === 4 && feed.current().kind === "live");
  expect(latency.stats()).toEqual([]);
  rt.append("s1"); // live
  rt.append("s1");
  await until(() => v.shown.length === 6);
  expect(latency.stats().map((s) => [s.path, s.via, s.count])).toEqual([["event", "direct", 2]]);
  latency.clear();
});

test("the copy is never asked for an epoch nobody knows yet; it is read once the list names it", async () => {
  const cloud = fakeCloud();
  cloud.copy("s1", 3, range(1, 2).map((c) => event("s1", c)));
  const asked: number[] = [];
  let hint: number | undefined;
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, onState: v.onState, epochHint: () => hint, copy: (epoch, after) => (asked.push(epoch), cloud.api.events("s1", epoch, after)) });
  feed.use({ kind: "copy" });
  await new Promise((r) => setTimeout(r, 20));
  expect(asked).toEqual([]);
  hint = 3;
  feed.copyAdvanced();
  await until(() => v.shown.length === 2);
  expect(asked).toEqual([3]);
});

test("while its runtime refuses the chat, the view reads more of Cloud's copy as it grows, and attaches at once when told to", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  cloud.copy("s1", 1, range(1, 2).map((c) => event("s1", c)));
  rt.refuse("not_found");
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, onState: v.onState, retryMs: () => 60_000, epochHint: () => 1, copy: (epoch, after) => cloud.api.events("s1", epoch, after) });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => v.shown.length === 2 && v.states.at(-1) === "ended");
  cloud.copy("s1", 1, range(1, 3).map((c) => event("s1", c)));
  feed.copyAdvanced();
  await until(() => v.shown.length === 3);
  rt.refuse(undefined);
  for (let i = 0; i < 4; i++) rt.append("s1");
  feed.retryNow();
  await until(() => v.shown.length === 4 && v.states.at(-1) === "live");
  expect(v.shown).toEqual([1, 2, 3, 4]);
});

/** Lets the event loop run out: every answer already given has been read. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** A runtime's client whose attaches wait until the test lets them through: an attach still on its way. */
const slowAttaches = (rt: ReturnType<typeof fakeRuntimeClient>) => {
  const waiting: Array<() => void> = [];
  const client: Client = {
    ...rt.client,
    attach: (...args: Parameters<Client["attach"]>) => new Promise<Subscription>((resolve, reject) => void waiting.push(() => void rt.client.attach(...args).then(resolve, reject))),
  };
  return { client, waiting, release: () => waiting.splice(0).forEach((go) => go()) };
};

/** Cloud's copy route: Cloud reads its copy when asked, and each answer reaches the device when the test lands it. */
const slowCopy = (cloud: ReturnType<typeof fakeCloud>, session: string) => {
  const out: Array<() => void> = [];
  const copy = (epoch: number, after: number) => {
    const asked = cloud.api.events(session, epoch, after);
    return new Promise<CopyPage>((resolve) => void out.push(() => resolve(asked)));
  };
  return { copy, out, land: () => out.shift()!() };
};
const text = (e: SessionEvent) => (e.payload as { text: string }).text;

test("a chat the hub moves to another connection after its runtime ended the subscription is held there once, and let go on close", async () => {
  const before = fakeRuntimeClient();
  const after = fakeRuntimeClient();
  before.append("s1");
  before.append("s1");
  after.journal("s1").events = before.journal("s1").events.slice();
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, onState: v.onState, retryMs: () => 60_000 });
  feed.use({ kind: "runtime", runtimeId: "rt-a", client: before.client });
  await until(() => feed.current().kind === "live" && v.shown.length === 2);
  before.end("lease_lost");
  expect(feed.current().kind).toBe("ended");

  // hub.ts reroute: route() points the feed at the chat's new connection, and the list's new seq calls retryNow.
  feed.use({ kind: "runtime", runtimeId: "rt-b", client: after.client });
  feed.retryNow();
  await until(() => feed.current().kind === "live");
  await settle();
  expect({ held: after.active(), shown: v.shown }).toEqual({ held: 1, shown: [1, 2] });
  feed.close();
  await settle();
  expect(after.active(), "subscriptions left after the chat closed").toBe(0);
});

test("a retry already on its way when the list speaks leaves the feed holding one subscription, and none after close", async () => {
  const rt = fakeRuntimeClient();
  rt.append("s1");
  const slow = slowAttaches(rt);
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, onState: v.onState, retryMs: () => 1 });
  rt.refuse("lease_lost"); // the chat is moving
  feed.use({ kind: "runtime", runtimeId: "rt", client: slow.client });
  await until(() => slow.waiting.length === 1);
  slow.release();
  await until(() => feed.current().kind === "ended" && slow.waiting.length === 1); // the retry timer's attach is out

  // The runtime adopted the chat while that attach was out, and the list says so.
  rt.refuse(undefined);
  feed.retryNow();
  slow.release();
  await until(() => feed.current().kind === "live");
  await settle();
  expect({ held: rt.active(), shown: v.shown }).toEqual({ held: 1, shown: [1] });
  feed.close();
  await settle();
  expect(rt.active(), "subscriptions left after the chat closed").toBe(0);
});

test("copy, runtime, then copy again while Cloud's first page is out: the view still reads Cloud's copy to its end", async () => {
  const cloud = fakeCloud();
  cloud.copy("s1", 1, range(1, 2).map((c) => event("s1", c)));
  const copy = slowCopy(cloud, "s1");
  const rt = slowAttaches(fakeRuntimeClient());
  const v = view();
  // The view kept its transcript through cursor 1.
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, copy: copy.copy, start: { epoch: 1, cursor: 1 } });
  feed.use({ kind: "copy" }); // the runtime is away
  await until(() => copy.out.length === 1);
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client }); // it came back
  await until(() => rt.waiting.length === 1);
  feed.use({ kind: "copy" }); // the relay cannot reach it after all
  await settle();
  copy.land();
  await settle();
  rt.release(); // the let-go attach answers, and is let go
  await settle();
  while (copy.out.length > 0) copy.land();
  await settle();
  expect({ shown: v.shown, state: feed.current() }).toEqual({ shown: [2], state: { kind: "copy", through: 2 } });
  feed.close();
});

test("a chat its runtime refused, switched to Cloud's copy while the fill-in page is out, reads Cloud's copy to its end", async () => {
  const cloud = fakeCloud();
  cloud.copy("s1", 1, range(1, 2).map((c) => event("s1", c)));
  const copy = slowCopy(cloud, "s1");
  const rt = fakeRuntimeClient();
  rt.refuse("lease_lost");
  const v = view();
  const feed = new ChatFeed({ sessionId: "s1", sink: v.sink, copy: copy.copy, start: { epoch: 1, cursor: 1 }, retryMs: () => 60_000 });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => feed.current().kind === "ended" && copy.out.length === 1); // the fill-in read is out
  feed.use({ kind: "copy" }); // the chat's new computer is asleep
  await settle();
  copy.land();
  await settle();
  while (copy.out.length > 0) copy.land();
  await settle();
  expect({ shown: v.shown, state: feed.current() }).toEqual({ shown: [2], state: { kind: "copy", through: 2 } });
  feed.close();
});

test("Cloud's page a refused chat asked for, landing after the runtime took it back, leaves the view following the runtime", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  rt.append("s1", "a");
  rt.append("s1", "b");
  cloud.copy("s1", 1, rt.journal("s1").events.slice());
  const copy = slowCopy(cloud, "s1");
  const feed = new ChatFeed({ sessionId: "s1", sink: { reset: () => undefined, apply: () => undefined }, copy: copy.copy, retryMs: () => 1 });
  feed.use({ kind: "runtime", runtimeId: "rt", client: rt.client });
  await until(() => feed.current().kind === "live" && feed.position().cursor === 2);

  rt.end("lease_lost"); // ended() shows why and reads Cloud's copy meanwhile
  expect(feed.current().kind).toBe("ended");
  await until(() => copy.out.length === 1 && feed.current().kind === "live"); // the retry timer's attach came back
  copy.land();
  await settle();
  expect(feed.current()).toEqual({ kind: "live" });
  feed.close();
});

test("Cloud's page read on an epoch the journal has since left is never shown or cached on the new one", async () => {
  const cloud = fakeCloud();
  const rt = fakeRuntimeClient();
  rt.append("s1", "a");
  rt.append("s1", "b");
  cloud.copy("s1", 1, rt.journal("s1").events.slice());
  const kv = memoryKv();
  const cache = new TranscriptCache(kv);
  await cache.append("s1", 1, rt.journal("s1").events.slice(0, 1));
  const copy = slowCopy(cloud, "s1");
  const slow = slowAttaches(rt);
  const shown: string[] = [];
  const feed = new ChatFeed({
    sessionId: "s1",
    sink: { reset: (epoch) => void shown.push(`reset ${epoch}`), apply: (e) => void shown.push(text(e)) },
    copy: copy.copy,
    cache,
    retryMs: () => 1,
  });
  rt.refuse("lease_lost"); // the chat is moving
  feed.use({ kind: "runtime", runtimeId: "rt", client: slow.client });
  await until(() => slow.waiting.length === 1);
  slow.release();
  // Refused: the fill-in read (epoch 1 after 1) is out, and so is the retry timer's attach.
  await until(() => feed.current().kind === "ended" && copy.out.length === 1 && slow.waiting.length === 1);

  rt.refuse(undefined); // adopted
  slow.release();
  await until(() => feed.current().kind === "live" && feed.position().cursor === 2);
  // The journal is rewritten as epoch 2, and Cloud's copy with it (handlers.ts takes the epoch from Cloud first).
  rt.rewrite("s1", ["x"]);
  cloud.copy("s1", 2, rt.journal("s1").events.slice());
  expect(feed.position()).toEqual({ epoch: 2, cursor: 1 });
  // It moves again before Cloud's epoch-1 page lands: refused once more.
  rt.refuse("lease_lost");
  rt.end("lease_lost");
  expect(feed.current().kind).toBe("ended");

  copy.land();
  await settle();
  while (copy.out.length > 0) copy.land();
  await settle();
  expect.soft(shown).toEqual(["a", "b", "reset 2", "x"]);
  await feed.writeCache();
  const stored = await cache.load("s1");
  expect({ epoch: stored?.epoch, events: stored?.events.map(text) }).toEqual({ epoch: 2, events: ["x"] });
  feed.close();
});
