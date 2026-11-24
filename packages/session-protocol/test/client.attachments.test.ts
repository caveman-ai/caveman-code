// What the subscribers on a session receive around their attach answers. The real connect() against ModelRuntime
// (server.ts's contract: an attach answer, then its backlog, then live events, one attachment per connection and
// session), on a virtual clock, with frames delivered when the test says.
import { afterEach, expect, test } from "vitest";
import {
  CallTimeout,
  connect,
  type Client,
  type Subscription,
  type SubscriptionState,
} from "../src/client.ts";
import {
  ATTACH_DEADLINE_MS,
  contiguityBreak,
  describe,
  installClock,
  ModelRuntime,
  SESSION,
  tag,
  type ModelSocket,
} from "./modelRuntime.ts";

let restore: (() => void) | undefined;
afterEach(() => restore?.());

interface Viewer {
  /** What onEvent and onReset were handed, after what the viewer held: `e<epoch>.<cursor>` or `reset <epoch>`. */
  readonly log: Array<string>;
  state: SubscriptionState | "attaching";
  refused: unknown;
  /** onError: the subscription ended after it attached, with this reason. */
  ended: string | undefined;
  sub: Subscription | undefined;
}

const subscribe = (
  client: Client,
  held: ReadonlyArray<string>,
  from: { cursor: number; epoch?: number },
): Viewer => {
  const viewer: Viewer = {
    log: [...held],
    state: "attaching",
    refused: undefined,
    ended: undefined,
    sub: undefined,
  };
  client
    .attach(SESSION, from.cursor, (event) => void viewer.log.push(tag(event)), {
      ...(from.epoch !== undefined ? { epoch: from.epoch } : {}),
      onReset: (epoch) => void viewer.log.push(`reset ${epoch}`),
      onState: (state) => (viewer.state = state),
      onError: (error) => (viewer.ended = error.error.data?.reason ?? error.message),
    })
    .then(
      (sub) => (viewer.sub = sub),
      (error: unknown) => (viewer.refused = error),
    );
  return viewer;
};

const start = async (events: number, frames: "settle" | "stepwise" = "settle") => {
  const clock = installClock();
  restore = clock.restore;
  const runtime = new ModelRuntime(events, { frames });
  const client = connect("wss://relay.test/rt-1", runtime.token, undefined, {
    socket: runtime.factory,
  });
  await clock.timers.settle();
  runtime.open(runtime.connecting()!);
  await clock.timers.settle();
  return { timers: clock.timers, runtime, client, socket: runtime.live()[0]! };
};

const attaches = (socket: ModelSocket) =>
  socket.requests.filter((request) => request.method === "session.attach");

test("a subscriber sharing a session follows a rewritten journal when the other subscriber's attach times out", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();
  expect({ state: a.state, log: a.log }).toEqual({ state: "live", log: ["e1.1"] });

  // B joins from its epoch-1 cache and the runtime does not answer it in time; meanwhile the journal is rewritten, and
  // A's attachment ends with journal_reset.
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  const stuck = attaches(socket)[0]!;
  runtime.rewrite(1);
  await timers.settle();
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  expect(b.refused).toBeInstanceOf(CallTimeout);

  for (const request of attaches(socket)) if (request !== stuck) runtime.answer(socket, request);
  await timers.settle();
  expect({ state: a.state, log: a.log }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1"],
  });
});

test("a subscriber left reconnecting attaches again when the attach it was waiting on times out", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();
  // The link drops, and B joins from its cache while it is down: on the next socket B's attach also brings A back.
  runtime.drop(socket);
  await timers.settle();
  expect(a.state).toBe("reconnecting");
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.advanceToNext();
  runtime.open(runtime.connecting()!);
  await timers.settle();
  const next = runtime.live()[0]!;
  const stuck = attaches(next)[0]!;
  // The runtime does not answer it in time.
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  expect(b.refused).toBeInstanceOf(CallTimeout);

  for (const request of attaches(next)) if (request !== stuck) runtime.answer(next, request);
  await timers.settle();
  expect({ state: a.state, log: a.log }).toEqual({ state: "live", log: ["e1.1"] });
});

test("an attach the runtime answers after its deadline still resets the subscriber before its backlog is delivered", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();

  // The journal is rewritten as epoch 2: the client attaches again on epoch 1, and the runtime commits e2.2.
  runtime.rewrite(1);
  await timers.settle();
  const late = attaches(socket)[0]!;
  expect(late.params).toMatchObject({ cursor: 1, epoch: 1 });
  runtime.commit();
  // The runtime answers (reset, epoch 2, then the backlog from cursor 1) only after the client's 30 s ran out.
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  runtime.answer(socket, late);
  await timers.settle();
  expect({ log: a.log, splice: contiguityBreak(a.log) }).toEqual({
    log: ["e1.1", "reset 2", "e2.1", "e2.2"],
    splice: null,
  });

  // The retry that follows the timeout asks from where A stands now, and nothing is replayed twice.
  await timers.advanceToNext();
  const retry = attaches(socket)[0]!;
  expect(retry.params).toMatchObject({ cursor: 2, epoch: 2 });
  runtime.answer(socket, retry);
  await timers.settle();
  expect({ state: a.state, log: a.log }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1", "e2.2"],
  });
});

test("a subscription attaches again when the runtime answers an attach it timed out on after the subscription's own", async () => {
  const { timers, runtime, client, socket } = await start(1, "stepwise");
  // A's attach is not answered in time; B attaches from its epoch-1 cache.
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  const stuck = attaches(socket)[0]!;
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  expect(a.refused).toBeInstanceOf(CallTimeout);
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  // The runtime answers B, then A's old attach, whose attachment replaces B's; then e1.2 commits.
  runtime.answer(
    socket,
    attaches(socket).find((request) => request !== stuck)!,
  );
  runtime.answer(socket, stuck);
  runtime.commit();
  socket.deliverAll();
  await timers.settle();
  const again = attaches(socket);
  expect(again.map((request) => request.params)).toMatchObject([{ cursor: 1, epoch: 1 }]);
  runtime.answer(socket, again[0]!);
  socket.deliverAll();
  await timers.settle();
  expect({ state: b.state, log: b.log }).toEqual({ state: "live", log: ["e1.1", "e1.2"] });
});

test("a late answer to a let-go subscription's attach never splices its backlog into the subscription attached now", async () => {
  const { timers, runtime, client, socket } = await start(1, "stepwise");
  // A's attach is not answered in time; B attaches from its epoch-1 cache and is answered on epoch 1.
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  const stuck = attaches(socket)[0]!;
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  expect(a.refused).toBeInstanceOf(CallTimeout);
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.answer(
    socket,
    attaches(socket).find((request) => request !== stuck)!,
  );
  socket.deliverAll();
  await timers.settle();
  // The journal is rewritten: B's attachment ends and B attaches again on epoch 1. Before that answer, the runtime
  // answers A's old attach (epoch 2, backlog from cursor 0) and commits e2.2 on its attachment.
  runtime.rewrite(1);
  socket.deliverAll();
  await timers.settle();
  const again = attaches(socket).find((request) => request !== stuck)!;
  runtime.answer(socket, stuck);
  runtime.commit();
  socket.deliverAll();
  await timers.settle();
  expect(contiguityBreak(b.log)).toBeNull();
  runtime.answer(socket, again);
  socket.deliverAll();
  await timers.settle();
  expect({ state: b.state, log: b.log }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1", "e2.2"],
  });
});

test("an attach answer still on the wire at its deadline delivers nothing into the next subscription", async () => {
  const { timers, runtime, client, socket } = await start(1, "stepwise");
  runtime.rewrite(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  // The runtime answers A in time and commits e2.2, but those frames are still on the wire when A's 30 s run out.
  runtime.answer(socket, attaches(socket)[0]!);
  runtime.commit();
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  expect(a.refused).toBeInstanceOf(CallTimeout);

  // B attaches from its epoch-1 cache; A's answer, its backlog and e2.2 arrive before B's own answer.
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  socket.deliverAll();
  await timers.settle();
  expect(b.log).toEqual(["e1.1"]);
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverAll();
  await timers.settle();
  expect({ state: b.state, log: b.log }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1", "e2.2"],
  });
});

test("events a let-go attachment already sent never reach the next subscription before its own answer", async () => {
  const { timers, runtime, client, socket } = await start(1, "stepwise");
  // A attaches from its epoch-1 cache; the journal is rewritten as epoch 2 before the runtime answers, then e2.2 commits.
  const a = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.rewrite(1);
  runtime.answer(socket, attaches(socket)[0]!);
  runtime.commit();
  // Only A's answer has arrived; its backlog and e2.2 are on the wire. A is let go (its feed moved to Cloud's copy
  // meanwhile), the runtime handles the detach at once, and B attaches from the same epoch-1 cache.
  socket.deliverNext();
  await timers.settle();
  void a.sub!.detach();
  await timers.settle();
  runtime.answer(
    socket,
    socket.requests.find((request) => request.method === "session.detach")!,
  );
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverAll();
  await timers.settle();
  expect(b.log).toEqual(["e1.1", "reset 2", "e2.1", "e2.2"]);
});

test("a subscription on a new epoch never takes an event a let-go attachment sent from the old one", async () => {
  const { timers, runtime, client, socket } = await start(2, "stepwise");
  // A attaches from its epoch-1 cache (e1.1): the runtime answers on epoch 1, with e1.2 behind the answer.
  const a = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverNext();
  await timers.settle();
  // A is let go while e1.2 is on the wire, and the runtime handles the detach at once. The journal is rewritten as epoch
  // 2 (e2.1, then e2.2), and B, holding e2.1 from Cloud's copy, attaches on epoch 2.
  void a.sub!.detach();
  await timers.settle();
  runtime.answer(
    socket,
    socket.requests.find((request) => request.method === "session.detach")!,
  );
  runtime.rewrite(1);
  runtime.commit();
  const b = subscribe(client, ["e2.1"], { cursor: 1, epoch: 2 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverAll();
  await timers.settle();
  expect(b.log).toEqual(["e2.1", "e2.2"]);
});

test("an answer to an attach made for a let-go subscription never resets the subscription attached now", async () => {
  const { timers, runtime, client, socket } = await start(1, "stepwise");
  const a = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverAll();
  await timers.settle();
  // The journal is rewritten: A's attachment ends with journal_reset and the client attaches again on epoch 1. The
  // runtime answers (reset, epoch 2), and A is let go while that answer is on the wire.
  runtime.rewrite(1);
  socket.deliverAll();
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  void a.sub!.detach();
  await timers.settle();
  runtime.answer(
    socket,
    socket.requests.find((request) => request.method === "session.detach")!,
  );
  // B, holding e2.1 from Cloud's copy, attaches on epoch 2. The old answer arrives, then the link drops before its
  // backlog does; B's attach goes out again on the next socket, from where B stood.
  const b = subscribe(client, ["e2.1"], { cursor: 1, epoch: 2 });
  await timers.settle();
  socket.deliverNext();
  await timers.settle();
  runtime.drop(socket);
  await timers.settle();
  await timers.advanceToNext();
  runtime.open(runtime.connecting()!);
  await timers.settle();
  const next = runtime.live()[0]!;
  runtime.answer(next, attaches(next)[0]!);
  next.deliverAll();
  await timers.settle();
  expect({ state: b.state, log: b.log }).toEqual({ state: "live", log: ["e2.1"] });
});

test.each(["is never answered", "is refused"] as const)(
  "a live subscription whose attachment a let-go attach's late answer replaced attaches again when the attach it waited on %s",
  async (how) => {
    const { timers, runtime, client, socket } = await start(1);
    // A's attach is not answered in time. B attaches from its epoch-1 cache, is answered, and is live.
    const a = subscribe(client, [], { cursor: 0 });
    await timers.settle();
    const stuck = attaches(socket)[0]!;
    await timers.advanceBy(ATTACH_DEADLINE_MS);
    expect(a.refused).toBeInstanceOf(CallTimeout);
    const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
    await timers.settle();
    runtime.answer(
      socket,
      attaches(socket).find((request) => request !== stuck)!,
    );
    await timers.settle();
    expect(b.state).toBe("live");
    // C joins B's session. While its attach is out, the runtime answers A's old attach, whose attachment takes the place
    // of B's; then C's attach gets no answer in time, or is turned away.
    const c = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
    await timers.settle();
    const joining = attaches(socket).find((request) => request !== stuck)!;
    runtime.answer(socket, stuck);
    await timers.settle();
    if (how === "is never answered") await timers.advanceBy(ATTACH_DEADLINE_MS);
    else {
      socket.requests = socket.requests.filter((request) => request !== joining);
      socket.push({
        id: joining.id,
        error: { code: -32010, message: "not now", data: { reason: "forbidden" } },
      });
      await timers.settle();
    }
    expect(c.refused).toBeDefined();

    for (const request of attaches(socket))
      if (request !== joining) runtime.answer(socket, request);
    runtime.commit();
    await timers.settle();
    expect({ state: b.state, log: b.log }).toEqual({ state: "live", log: ["e1.1", "e1.2"] });
  },
);

test("the end of a let-go attachment never sends the subscription attached now around again", async () => {
  const { timers, runtime, client, socket } = await start(1, "stepwise");
  const a = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverAll();
  await timers.settle();
  // A is let go and B attaches from the same cache. The journal is rewritten before the runtime handles A's detach,
  // so A's attachment ends with journal_reset ahead of B's answer (reset, epoch 2) on the wire.
  void a.sub!.detach();
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.rewrite(1);
  runtime.answer(
    socket,
    socket.requests.find((request) => request.method === "session.detach")!,
  );
  runtime.answer(socket, attaches(socket)[0]!);
  socket.deliverAll();
  await timers.settle();
  expect({
    state: b.state,
    log: b.log,
    attaching: attaches(socket).map((request) => request.params),
  }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1"],
    attaching: [],
  });
});

test("a socket that owes more late attach answers than the client keeps is dropped for a fresh one", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();
  // The journal is rewritten and the runtime never answers A's attaches on this socket again: each times out, and each
  // may still be answered while the socket lives.
  runtime.rewrite(1);
  await timers.settle();
  let owed = 0;
  while (socket.readyState === 1 && owed < 100) {
    owed = attaches(socket).length;
    await timers.advanceToNext();
    await timers.settle();
  }
  // client.ts MAX_OVERDUE: the 65th timed-out attach drops the socket.
  expect(owed).toBe(65);

  while (!runtime.connecting()) await timers.advanceToNext();
  runtime.open(runtime.connecting()!);
  await timers.settle();
  const next = runtime.live()[0]!;
  while (attaches(next).length === 0) await timers.advanceToNext();
  runtime.answer(next, attaches(next)[0]!);
  await timers.settle();
  expect({ state: a.state, log: a.log }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1"],
  });
});

test.each([
  "in the order sent",
  "the detach first (a runtime from before the attach lane)",
] as const)(
  "an attach its only subscriber gave up on is let go, so the chat streams to no one once the runtime answers it: %s",
  async (order) => {
    const { timers, runtime, client, socket } = await start(1);
    // A's attach is not answered in time, and the person has left the chat: nothing attaches it again.
    const a = subscribe(client, [], { cursor: 0 });
    await timers.settle();
    const stuck = attaches(socket)[0]!;
    await timers.advanceBy(ATTACH_DEADLINE_MS);
    expect(a.refused).toBeInstanceOf(CallTimeout);
    expect(socket.requests.map(describe).filter((line) => line !== "runtime.hello")).toEqual([
      "session.attach from 0",
      "session.detach",
    ]);
    // The runtime answers the old attach late, which starts an attachment on this connection, and runs the detach.
    const detach = socket.requests.find((request) => request.method === "session.detach")!;
    if (order === "in the order sent") runtime.answer(socket, stuck);
    runtime.answer(socket, detach);
    if (order !== "in the order sent") runtime.answer(socket, stuck);
    await timers.settle();
    for (const request of socket.requests) runtime.answer(socket, request);
    await timers.settle();
    expect(runtime.snapshot().sockets[0]!.attachedBy).toBeNull();
  },
);

test("a subscription whose journal was rewritten says reconnecting until the runtime answers its attach again", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();
  expect(a.state).toBe("live");
  // The runtime ends A's attachment with journal_reset and is slow to answer the attach that follows.
  runtime.rewrite(1);
  await timers.settle();
  expect({ state: a.state, attaching: attaches(socket).length }).toEqual({
    state: "reconnecting",
    attaching: 1,
  });
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  await timers.advanceToNext();
  expect({ state: a.state, attaching: attaches(socket).length }).toEqual({
    state: "reconnecting",
    attaching: 2,
  });
  runtime.answer(socket, attaches(socket).at(-1)!);
  await timers.settle();
  expect({ state: a.state, log: a.log }).toEqual({
    state: "live",
    log: ["e1.1", "reset 2", "e2.1"],
  });
});

test("a subscription whose attachment a let-go attach's late answer took says reconnecting until its own attach is answered", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  const stuck = attaches(socket)[0]!;
  await timers.advanceBy(ATTACH_DEADLINE_MS);
  expect(a.refused).toBeInstanceOf(CallTimeout);
  // A runtime from before the attach lane runs the detach that followed at once, answers B's attach, and only then A's
  // old one, whose attachment takes the place of B's.
  runtime.answer(
    socket,
    socket.requests.find((request) => request.method === "session.detach")!,
  );
  const b = subscribe(client, ["e1.1"], { cursor: 1, epoch: 1 });
  await timers.settle();
  runtime.answer(
    socket,
    attaches(socket).find((request) => request !== stuck)!,
  );
  await timers.settle();
  expect(b.state).toBe("live");
  runtime.answer(socket, stuck);
  await timers.settle();
  const again = attaches(socket);
  expect({ state: b.state, attaching: again.map((request) => request.params) }).toMatchObject({
    state: "reconnecting",
    attaching: [{ cursor: 1, epoch: 1 }],
  });
  runtime.answer(socket, again[0]!);
  runtime.commit();
  await timers.settle();
  expect({ state: b.state, log: b.log }).toEqual({ state: "live", log: ["e1.1", "e1.2"] });
});

test("a re-attach caught by a token function that fails waits for a token instead of ending the subscription", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();
  // The journal is rewritten and A attaches again. The runtime answers that attach "unauthorized" (the relay token ran
  // out), so the client reconnects for a fresh one, and minting it fails once: Cloud is briefly out of reach.
  runtime.rewrite(1);
  await timers.settle();
  runtime.tokenFailures = 1;
  runtime.answer(socket, attaches(socket)[0]!, "unauthorized");
  await timers.settle();
  while (runtime.tokenFailures > 0) await timers.advanceToNext();
  await timers.settle();
  expect({ ended: a.ended, state: a.state }).toEqual({ ended: undefined, state: "reconnecting" });

  while (!runtime.connecting()) await timers.advanceToNext();
  runtime.open(runtime.connecting()!);
  await timers.settle();
  const next = runtime.live()[0]!;
  while (attaches(next).length === 0) await timers.advanceToNext();
  runtime.answer(next, attaches(next)[0]!);
  await timers.settle();
  expect({ ended: a.ended, state: a.state, log: a.log }).toEqual({
    ended: undefined,
    state: "live",
    log: ["e1.1", "reset 2", "e2.1"],
  });
});

test("a first attach caught by a token function that fails waits for a token, then follows the chat", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  // The link drops before the runtime answers, and the next token cannot be minted: Cloud is briefly out of reach. No
  // runtime refused the chat, so ChatFeed must not hear "unauthorized" and show it ended.
  runtime.tokenFailures = 1;
  runtime.drop(socket);
  await timers.settle();
  while (runtime.tokenFailures > 0) await timers.advanceToNext();
  await timers.settle();
  expect({ refused: a.refused, sub: a.sub }).toEqual({ refused: undefined, sub: undefined });

  while (!runtime.connecting()) await timers.advanceToNext();
  runtime.open(runtime.connecting()!);
  await timers.settle();
  const next = runtime.live()[0]!;
  expect(attaches(next)).toHaveLength(1);
  runtime.answer(next, attaches(next)[0]!);
  await timers.settle();
  expect({ refused: a.refused, attached: a.sub !== undefined, state: a.state, log: a.log }).toEqual(
    { refused: undefined, attached: true, state: "live", log: ["e1.1"] },
  );
});

test("a re-attach that waited through a long token outage goes out on the first socket that opens", async () => {
  const { timers, runtime, client, socket } = await start(1);
  const a = subscribe(client, [], { cursor: 0 });
  await timers.settle();
  runtime.answer(socket, attaches(socket)[0]!);
  await timers.settle();
  // The journal is rewritten, and the link drops before the runtime answers the re-attach. Minting a token then fails
  // for a while, every connection attempt backing off further.
  runtime.rewrite(1);
  await timers.settle();
  runtime.tokenFailures = 6;
  runtime.drop(socket);
  await timers.settle();
  while (runtime.tokenFailures > 0) await timers.advanceToNext();
  while (!runtime.connecting()) await timers.advanceToNext();
  runtime.open(runtime.connecting()!);
  await timers.settle();
  // A token again and a socket: the re-attach goes out on it now, not after a backoff of its own.
  const next = runtime.live()[0]!;
  expect(attaches(next)).toHaveLength(1);
  runtime.answer(next, attaches(next)[0]!);
  await timers.settle();
  expect({ ended: a.ended, state: a.state, log: a.log }).toEqual({
    ended: undefined,
    state: "live",
    log: ["e1.1", "reset 2", "e2.1"],
  });
});
