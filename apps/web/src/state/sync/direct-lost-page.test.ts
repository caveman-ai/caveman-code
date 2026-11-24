// A page that lost its lock sends nothing on the direct channel either, so a call it kept without a wentOut mark
// (sender.ts wentOut) never ran: the next page may post it to Cloud's queue without asking `resendable`.
import { afterEach, expect, test } from "vitest";
import { CallNotSent, SessionProtocolError } from "@caveman-app/session-protocol/client";
import { connectDirect } from "@caveman-app/session-protocol/direct";
import { fakeCloud, until } from "./fakes.test-support.ts";
import { memoryKv, type Kv } from "./kv.ts";
import { kvOutbox } from "./outbox.ts";
import { onlyPage, type Pages } from "./pages.ts";
import { ChatSender, type Route } from "./sender.ts";

interface FakeRuntime {
  readonly url: string;
  readonly executions: string[];
  readonly state: { silentDirect: boolean; holdRelaySubmits: boolean; relayDown: boolean };
  dropRelay(): void;
  close(): Promise<void>;
}
const FAKES = "../../../../../packages/session-protocol/test/directFakes.ts";
const fakes = async () =>
  (await import(/* @vite-ignore */ new URL(FAKES, import.meta.url).href)) as {
    fakeRuntime: () => Promise<FakeRuntime>;
    fakeRtc: (url: string) => { Rtc: unknown; peers: Array<{ channel: { kill(): void } | null }> };
  };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("a call handed to the channel just before its page lost its lock runs once: never on the runtime from the lost page and again from Cloud's queue", async () => {
  const { fakeRuntime, fakeRtc } = await fakes();
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const base = memoryKv();
  // y1's mark (wentOut) is slow to write, as an IndexedDB write can be.
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let gated = false;
  const store: Kv = {
    ...base,
    put: async (key, value) => {
      if (
        key === "outbox/cloud/y1" &&
        (value as { params: { wentOut?: boolean } }).params.wentOut
      ) {
        gated = true;
        await gate;
      }
      return base.put(key, value);
    },
  };
  let owns = true;
  const pages: Pages = { ...onlyPage("a"), owns: () => owns };
  const cloud = fakeCloud();
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox: kvOutbox(store, "runtime/rt", pages),
    direct: {
      rtc: fakeRtc(runtime.url).Rtc as never,
      iceServers: [],
      network: () => () => undefined,
      silenceMs: 60_000,
    },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  const sender = new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(store, "cloud", pages),
    retryMs: () => 5,
  });
  const route: Route = { via: "runtime", client, runtime: "rt", epoch: 1, orCloud: true };
  const submit = (session: string, id: string) =>
    void sender
      .send(
        session,
        "turn.submit",
        { session_id: session, request_id: id, kind: "followup", input: { text: id } } as never,
        route,
      )
      .catch(() => undefined);
  // Two chats on one laptop: y1's mark is being written as x1 is handed to the channel's client behind it.
  submit("s1", "y1");
  await until(() => gated);
  submit("s2", "x1");
  // Kept by the direct client as it hands x1 to the channel's client, behind y1's mark.
  await until(() => base.data.has("outbox/runtime/rt/x1"));
  owns = false; // the page loses its lock
  release();
  await sleep(300);
  // The next page: the chats moved off rt, so the client would not send a call that went out there again.
  new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", onlyPage("next")),
    retryMs: () => 5,
    resendable: () => false,
  });
  await until(() => cloud.posted.length > 0, 500).catch(() => undefined);
  // Each call ran once on rt already, or goes once to Cloud: never both.
  const both = runtime.executions.filter((id) => cloud.posted.some((p) => p.request_id === id));
  expect(both, "ran on rt from the lost page and posted to Cloud's queue past resendable").toEqual(
    [],
  );
  expect(runtime.executions, "nothing ran from the lost page").toEqual([]);
  expect(
    cloud.posted.map((p) => p.request_id),
    "x1 goes once, from the next page",
  ).toEqual(["x1"]);
});

test("a call held in the channel's lane on a page that lost its lock keeps its place when the channel dies: the next page sends the chat's calls in the order made", async () => {
  const { fakeRuntime, fakeRtc } = await fakes();
  const runtime = await fakeRuntime();
  cleanups.push(runtime.close);
  const base = memoryKv();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let gated = false;
  const store: Kv = {
    ...base,
    put: async (key, value) => {
      if (
        key === "outbox/cloud/y1" &&
        (value as { params: { wentOut?: boolean } }).params.wentOut
      ) {
        gated = true;
        await gate;
      }
      return base.put(key, value);
    },
  };
  let owns = true;
  const pages: Pages = { ...onlyPage("a"), owns: () => owns };
  const cloud = fakeCloud();
  const rtc = fakeRtc(runtime.url);
  const client = connectDirect(runtime.url, "secret", undefined, {
    outbox: kvOutbox(store, "runtime/rt", pages),
    direct: {
      rtc: rtc.Rtc as never,
      iceServers: [],
      network: () => () => undefined,
      silenceMs: 60_000,
    },
  });
  cleanups.push(() => client.close());
  await until(() => client.path() === "direct");
  const sender = new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(store, "cloud", pages),
    retryMs: () => 5,
  });
  // s2 is a chat Cloud lists; s1 one it does not yet, so only the laptop's connection takes its calls.
  const listed: Route = { via: "runtime", client, runtime: "rt", epoch: 1, orCloud: true };
  const unlisted: Route = { via: "runtime", client, runtime: "rt", epoch: 1 };
  const submit = (session: string, id: string, route: Route) =>
    void sender
      .send(
        session,
        "turn.submit",
        { session_id: session, request_id: id, kind: "followup", input: { text: id } } as never,
        route,
      )
      .catch(() => undefined);
  submit("s2", "y1", listed);
  await until(() => gated);
  submit("s1", "x1", unlisted);
  await until(() => base.data.has("outbox/runtime/rt/x1"));
  owns = false;
  // Sent as the page waits to reload: kept under its name, after x1.
  submit("s1", "x3", unlisted);
  await until(() => base.data.has("outbox/runtime/rt/x3"));
  release();
  await sleep(50);
  rtc.peers[0]!.channel!.kill();
  await until(() => client.path() === "relay");
  await sleep(200);
  expect(runtime.executions, "nothing ran from the lost page").toEqual([]);
  // The next page, on the relay alone, sends what the lost page kept for the laptop.
  const next = connectDirect(runtime.url, "secret", undefined, {
    outbox: kvOutbox(base, "runtime/rt", onlyPage("next")),
  });
  cleanups.push(() => next.close());
  await until(() => runtime.executions.includes("x1") && runtime.executions.includes("x3"));
  expect(
    runtime.executions.filter((id) => id.startsWith("x")),
    "chat s1's sends, in the order sent",
  ).toEqual(["x1", "x3"]);
});

const wentOut = (kv: { data: Map<string, unknown> }, id: string) =>
  (kv.data.get(`outbox/cloud/${id}`) as { params: { wentOut?: boolean } } | undefined)?.params
    .wentOut;

// A send out on a connection when its page loses its lock may have run there. Its connection lets it go unanswered
// later, and the sender heads it for Cloud's queue, but a lost page posts nothing: the next page posts it, maybe long
// after (the chat may have moved since), and must judge it as one that may have run.
for (const path of ["channel", "relay"] as const) {
  test(`a send out on the ${path} when its page lost its lock keeps its mark when that connection goes: the next page asks resendable`, async () => {
    const { fakeRuntime, fakeRtc } = await fakes();
    const runtime = await fakeRuntime();
    cleanups.push(runtime.close);
    const base = memoryKv();
    let owns = true;
    const pages: Pages = { ...onlyPage("a"), owns: () => owns };
    const cloud = fakeCloud();
    const rtc = fakeRtc(runtime.url);
    const client = connectDirect(runtime.url, "secret", undefined, {
      outbox: kvOutbox(base, "runtime/rt", pages),
      direct:
        path === "channel"
          ? {
              rtc: rtc.Rtc as never,
              iceServers: [],
              network: () => () => undefined,
              silenceMs: 60_000,
            }
          : {
              rtc: rtc.Rtc as never,
              enabled: () => false,
              iceServers: [],
              network: () => () => undefined,
            },
    });
    cleanups.push(() => client.close());
    if (path === "channel") {
      await until(() => client.path() === "direct");
      runtime.state.silentDirect = true;
    } else {
      await sleep(100);
      runtime.state.holdRelaySubmits = true;
    }
    const sender = new ChatSender({
      api: cloud.api,
      outbox: kvOutbox(base, "cloud", pages),
      retryMs: () => 5,
      unsentMs: 100,
    });
    const listed: Route = { via: "runtime", client, runtime: "rt", epoch: 1, orCloud: true };
    void sender
      .send(
        "s1",
        "turn.submit",
        { session_id: "s1", request_id: "x1", kind: "followup", input: { text: "x1" } } as never,
        listed,
      )
      .catch(() => undefined);
    await until(() => wentOut(base, "x1") === true);
    // Out on its connection, its answer held back.
    await sleep(50);
    owns = false;
    if (path === "channel") {
      rtc.peers[0]!.channel!.kill();
      await until(() => client.path() === "relay");
    } else {
      runtime.state.relayDown = true;
      runtime.dropRelay();
    }
    // Long enough for its connection to let it go unanswered (unsentMs) and the sender to head it for Cloud's queue.
    await sleep(500);
    expect(wentOut(base, "x1"), "still marked as one that may have gone out").toBe(true);
    // The next page: the chat moved off rt, so the client would not send it again.
    new ChatSender({
      api: cloud.api,
      outbox: kvOutbox(base, "cloud", onlyPage("next")),
      retryMs: () => 5,
      resendable: () => false,
    });
    await sleep(300);
    expect(
      cloud.posted.map((p) => p.request_id),
      "not posted to Cloud's queue past resendable",
    ).toEqual([]);
  });
}

// The mark is kept only for a call that may have run. One its connection never sent, or one the runtime refused
// (no receipt), still goes to Cloud's queue from the page loaded anew, the chat moved or not.
test("a send the runtime refused as its chat moves, after its page lost its lock, still goes to Cloud's queue from the next page", async () => {
  const base = memoryKv();
  let owns = true;
  const pages: Pages = { ...onlyPage("a"), owns: () => owns };
  const cloud = fakeCloud();
  let refuse!: (error: unknown) => void;
  const client = {
    call: (
      _method: string,
      _params: unknown,
      options: { onKept?: () => unknown; onSent?: () => void },
    ) =>
      new Promise((_resolve, reject) => {
        void (async () => {
          await options.onKept?.();
          options.onSent?.();
          refuse = reject;
        })();
      }),
  };
  const sender = new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", pages),
    retryMs: () => 5,
  });
  const route = {
    via: "runtime",
    client,
    runtime: "rt",
    epoch: 1,
    orCloud: true,
  } as unknown as Route;
  void sender
    .send(
      "s1",
      "turn.submit",
      { session_id: "s1", request_id: "x1", kind: "followup", input: { text: "x1" } } as never,
      route,
    )
    .catch(() => undefined);
  await until(() => wentOut(base, "x1") === true);
  owns = false;
  // The chat is moving: rt refuses it, and keeps no receipt.
  refuse(
    new SessionProtocolError({
      code: -32010,
      message: "moved",
      data: { reason: "lease_lost" },
    } as never),
  );
  // Headed for Cloud's queue, kept as one that never ran.
  await until(() => wentOut(base, "x1") !== true);
  new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", onlyPage("next")),
    retryMs: () => 5,
    resendable: () => false,
  });
  await until(() => cloud.posted.length > 0, 1_000).catch(() => undefined);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["x1"]);
});

test("a send its connection kept but never sent, let go after its page lost its lock, still goes to Cloud's queue from the next page", async () => {
  const base = memoryKv();
  let owns = true;
  const pages: Pages = { ...onlyPage("a"), owns: () => owns };
  const cloud = fakeCloud();
  let letGo!: () => void;
  // Its connection keeps it (onKept: the sender marks it) and never sends it: the relay is down.
  const client = {
    call: (method: string, _params: unknown, options: { onKept?: () => unknown }) =>
      new Promise((_resolve, reject) => {
        void (async () => {
          await options.onKept?.();
          letGo = () => reject(new CallNotSent(method as never, "unsent"));
        })();
      }),
  };
  const sender = new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", pages),
    retryMs: () => 5,
  });
  const route = {
    via: "runtime",
    client,
    runtime: "rt",
    epoch: 1,
    orCloud: true,
  } as unknown as Route;
  void sender
    .send(
      "s1",
      "turn.submit",
      { session_id: "s1", request_id: "x1", kind: "followup", input: { text: "x1" } } as never,
      route,
    )
    .catch(() => undefined);
  await until(() => wentOut(base, "x1") === true);
  owns = false;
  letGo();
  // Headed for Cloud's queue, kept as one that never ran.
  await until(() => wentOut(base, "x1") !== true);
  new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", onlyPage("next")),
    retryMs: () => 5,
    resendable: () => false,
  });
  await until(() => cloud.posted.length > 0, 1_000).catch(() => undefined);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["x1"]);
});

// Found by the sender's model check (client-delivery, the lost-page runs): one that did not run loses its mark at once,
// not once the calls before it are out. A lost page posts none of those, so a call waiting behind one of them kept the
// mark of one that may have run, and the page loaded anew dropped it once its chat had moved, though it never ran.
test("a send its connection never sent, let go behind one that may have run after its page lost its lock, still goes to Cloud's queue from the next page", async () => {
  const base = memoryKv();
  let owns = true;
  const pages: Pages = { ...onlyPage("a"), owns: () => owns };
  const cloud = fakeCloud();
  const letGo = new Map<string, () => void>();
  // r1 goes out and its link is lost (it may have run); r2, kept by the connection behind it, never goes out.
  const client = {
    call: (
      method: string,
      params: { request_id: string },
      options: { onKept?: () => unknown; onSent?: () => void },
    ) =>
      new Promise((_resolve, reject) => {
        void (async () => {
          await options.onKept?.();
          if (params.request_id === "r1") options.onSent?.();
          letGo.set(params.request_id, () =>
            reject(
              new CallNotSent(
                method as never,
                params.request_id === "r1" ? "unanswered" : "unsent",
              ),
            ),
          );
        })();
      }),
  };
  const sender = new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", pages),
    retryMs: () => 5,
  });
  const route = {
    via: "runtime",
    client,
    runtime: "rt",
    epoch: 1,
    orCloud: true,
  } as unknown as Route;
  for (const id of ["r1", "r2"])
    void sender
      .send(
        "s1",
        "turn.submit",
        { session_id: "s1", request_id: id, kind: "followup", input: { text: id } } as never,
        route,
      )
      .catch(() => undefined);
  await until(() => wentOut(base, "r2") === true);
  owns = false;
  // Its connection lets both go (UNSENT_MS): r1 heads for Cloud's queue first, and the lost page posts nothing.
  letGo.get("r1")!();
  letGo.get("r2")!();
  await until(() => wentOut(base, "r2") !== true, 1_000).catch(() => undefined);
  expect(wentOut(base, "r1"), "r1 may have run: it keeps its mark").toBe(true);
  expect(wentOut(base, "r2"), "r2 never went out: it loses its mark").toBeUndefined();
  // The next page: the chat moved off rt, so r1, which may have run, is not posted; r2 is.
  new ChatSender({
    api: cloud.api,
    outbox: kvOutbox(base, "cloud", onlyPage("next")),
    retryMs: () => 5,
    resendable: () => false,
  });
  await until(() => cloud.posted.length > 0, 1_000).catch(() => undefined);
  expect(cloud.posted.map((p) => p.request_id)).toEqual(["r2"]);
});
