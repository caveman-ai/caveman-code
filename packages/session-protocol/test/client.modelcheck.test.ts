// Bounded model checks of the real Session Protocol client (src/client.ts connect()), driven through every order of
// the steps below by @caveman-app/model-check. The far end is ModelRuntime (modelRuntime.ts), a runtime playing
// server.ts's contract; the clock is VirtualTimers, so retries, connect timeouts, deadlines and unsentAfterMs fire
// only when the checker moves time. Run: pnpm --filter @caveman-app/session-protocol exec vitest run test/client.modelcheck.test.ts
// (CLIENT_DELIVERY_FULL=1 for the larger bound; see "The bounds" below and .claude/skills/client-delivery/SKILL.md).
import {
  assertHolds,
  canonicalKey,
  checkAsync,
  formatTrace,
  type Action,
  type AsyncSpec,
  type Verdict,
  type VirtualTimers,
} from "@caveman-app/model-check";
import { expect, test } from "vitest";
import {
  CallNotSent,
  CallTimeout,
  connect,
  memoryOutbox,
  type Client,
  type OutboxEntry,
  type SubscriptionState,
} from "../src/client.ts";
import {
  abandoned,
  ATTACH_DEADLINE_MS,
  contiguityBreak,
  describe,
  FULL,
  installClock,
  ModelRuntime,
  position,
  runtimeSteps,
  SESSION,
  tag,
  type Request,
  type RuntimeSnapshot,
} from "./modelRuntime.ts";

const URL = "wss://relay.test/rt-1";
const CLOCK = "clock: fire the next timer";

const report = <S>(run: string, verdict: Verdict<S>, show?: (state: S) => string) => {
  const name = `${run} [${FULL ? "full" : "default"} bound]`;
  if (verdict.ok)
    console.log(
      `${name}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}`,
    );
  else
    console.log(
      `${name}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states)\n${formatTrace(verdict.trace, show)}`,
    );
};

const settled = (timers: VirtualTimers) => timers.settle();
/** What a subscriber's attach() rejects with when the runtime does not answer it in time. */
const ATTACH_TIMED_OUT = new CallTimeout("session.attach", ATTACH_DEADLINE_MS).message;

// The promise in plain words: each is the exact name a verdict reports.
const CONTIGUOUS = "each subscriber gets cursors 1..n of one epoch, with a reset between epochs";
const NOT_ENDED = "no attached subscription ends while the runtime keeps the chat";
const CAUGHT_UP = "every subscriber catches up with the journal and says live";
const LIVE_ATTACHED =
  "a subscriber says live only while the runtime keeps the chat attached on its connection";
const LET_GO = "the runtime keeps the chat attached only while a subscriber holds it";
const REFUSED_ON_DEADLINE =
  "an attach() fails only when its deadline runs out: this runtime refuses none, and a missing token is no refusal";
const CALLS_SAFE =
  "a mutating call ends answered, not sent, timed out, or still in the outbox; it goes out again only when resend allows it, never ahead of an earlier one";
const CALLS_END =
  "every call ends answered, not sent or timed out once the link is up, and leaves the outbox";

// ---------------------------------------------------------------------------------------------------------------
// Event stream: every subscriber gets cursors 1..n of one epoch, a reset between epochs, across a link drop, backlogs
// that overlap what a subscriber holds, a frame the relay loses, a rewritten journal and a second subscriber joining.

interface Subscriber {
  readonly name: string;
  /** What onEvent and onReset were handed: `e<epoch>.<cursor>` or `reset <epoch>`. */
  readonly log: Array<string>;
  state: SubscriptionState | "attaching";
  /** onError: the subscription ended after it attached. */
  ended: string | null;
  /** attach() rejected: the first attach was refused or not answered in time; the caller tries again (ChatFeed). */
  refused: string | null;
  /** attach() has not settled yet. */
  waiting: boolean;
}

interface Stream {
  readonly timers: VirtualTimers;
  readonly restore: () => void;
  readonly runtime: ModelRuntime;
  readonly client: Client;
  readonly subs: Array<Subscriber>;
  readonly used: {
    drops: number;
    commits: number;
    losses: number;
    rewrites: number;
    clock: number;
    tokenFailures: number;
  };
}

const subscribe = (
  client: Client,
  name: string,
  cached: ReadonlyArray<string>,
  from: { epoch?: number; cursor: number },
): Subscriber => {
  const sub: Subscriber = {
    name,
    log: [...cached],
    state: "attaching",
    ended: null,
    refused: null,
    waiting: true,
  };
  client
    .attach(SESSION, from.cursor, (event) => void sub.log.push(tag(event)), {
      ...(from.epoch !== undefined ? { epoch: from.epoch } : {}),
      onReset: (epoch) => void sub.log.push(`reset ${epoch}`),
      onState: (state) => (sub.state = state),
      onError: (error) => (sub.ended = error.error.data?.reason ?? error.message),
    })
    .then(
      () => {
        sub.waiting = false;
        if (sub.state === "attaching") sub.state = "live";
      },
      (error: unknown) => {
        sub.waiting = false;
        sub.refused = error instanceof Error ? error.message : String(error);
      },
    );
  return sub;
};

/** Who joins A, in order, each from a cache at epoch 1 (`joins` counts them). */
const JOINERS = ["B", "C"] as const;

/**
 * How many of each step one trace may take. `losses` counts commits whose frame the relay loses; `joins`, B and C;
 * `tokenFailures`, connection attempts whose token function throws (none unless set).
 */
interface StreamBudget {
  readonly drops: number;
  readonly commits: number;
  readonly losses: number;
  readonly rewrites: number;
  readonly joins: number;
  readonly clock: number;
  readonly tokenFailures?: number;
}

// The bounds. CLIENT_DELIVERY_FULL=1 (FULL) runs the larger one; unset, as in the package's `vitest run`, the smaller,
// which keeps this file to seconds. The verified stream run leaves B out by default, and the stepwise run leaves the
// clock to the drain (no checker clock steps): every other step is in both. The runs that keep a fixed finding's old
// counterexample checked take only the steps it took, at both bounds.
const STREAM: StreamBudget = FULL
  ? { drops: 1, commits: 2, losses: 1, rewrites: 1, joins: 1, clock: 3 }
  : { drops: 1, commits: 2, losses: 1, rewrites: 1, joins: 0, clock: 2 };
const STEPWISE: StreamBudget = FULL
  ? { drops: 1, commits: 2, losses: 0, rewrites: 1, joins: 1, clock: 3 }
  : { drops: 1, commits: 2, losses: 0, rewrites: 1, joins: 1, clock: 0 };

interface StreamView {
  readonly subs: ReadonlyArray<{
    readonly name: string;
    readonly log: ReadonlyArray<string>;
    readonly state: string;
    readonly ended: string | null;
    readonly refused: string | null;
    readonly waiting: boolean;
  }>;
  readonly runtime: RuntimeSnapshot;
  readonly tokenFailuresArmed: number;
  readonly timers: ReadonlyArray<number>;
  readonly used: Stream["used"];
}

/**
 * The clock may run out the 30 s deadline of any attach, an attach() another subscriber shares included, and the
 * runtime may still answer an attach the client gave up on, on a step of its own; the drain never does, so progress
 * holds whether that answer comes late or not at all. `frames`: "stepwise" makes each frame's arrival a step of
 * its own (modelRuntime.ts), so a drop, a commit, a rewrite, B's attach or a deadline can land between an attach answer
 * and its backlog. `budget`: how many of each step a trace may take.
 */
const streamSpec = (options: {
  readonly frames?: "settle" | "stepwise";
  readonly budget: StreamBudget;
}): AsyncSpec<Stream, StreamView> => ({
  make: async () => {
    const { timers, restore } = installClock();
    const runtime = new ModelRuntime(1, { frames: options.frames ?? "settle" });
    const client = connect(URL, runtime.token, undefined, { socket: runtime.factory });
    const subs = [subscribe(client, "A", [], { cursor: 0 })];
    await settled(timers);
    return {
      timers,
      restore,
      runtime,
      client,
      subs,
      used: { drops: 0, commits: 0, losses: 0, rewrites: 0, clock: 0, tokenFailures: 0 },
    };
  },
  actions: (s) => {
    const step = (name: string, run: () => void | Promise<unknown>): Action<Stream> => ({
      name,
      run: async () => {
        await run();
        await settled(s.timers);
      },
    });
    const budget = options.budget;
    // server.ts laneOf takes a chat's attaches and detaches on one connection in arrival order: an attach waits for a
    // detach sent before it (the detach that lets go of a late-answered attach, then a join). Two attaches, or a detach
    // and an attach sent before it, may still be answered either way.
    const answers = (request: Request) =>
      request.method !== "session.attach" ||
      !s.runtime.sockets.some(
        (socket) =>
          socket.requests.includes(request) &&
          socket.requests.some((r) => r.method === "session.detach" && r.id < request.id),
      );
    const actions: Array<Action<Stream>> = runtimeSteps(s.runtime, {
      drops: s.used.drops < budget.drops,
      answers,
    }).map((one) =>
      step(one.name, () => {
        if (one.name.startsWith("link drops")) s.used.drops++;
        one.run();
      }),
    );
    if (s.used.commits < budget.commits) {
      const next = `e${s.runtime.epoch}.${s.runtime.journal.length + 1}`;
      const commit = (relay: "once" | "lost") => () => {
        s.used.commits++;
        if (relay === "lost") s.used.losses++;
        s.runtime.commit(relay);
      };
      actions.push(step(`runtime commits ${next}`, commit("once")));
      if (s.used.losses < budget.losses)
        actions.push(step(`runtime commits ${next}, the relay loses it`, commit("lost")));
    }
    if (s.used.rewrites < budget.rewrites)
      actions.push(
        step(
          `journal rewritten as epoch ${s.runtime.epoch + 1} with 1 event`,
          () => (s.used.rewrites++, s.runtime.rewrite(1)),
        ),
      );
    const joiner = JOINERS[s.subs.length - 1];
    if (joiner && s.subs.length < 1 + budget.joins)
      actions.push(
        step(
          `${joiner} attaches from its cache (epoch 1, e1.1)`,
          () => void s.subs.push(subscribe(s.client, joiner, ["e1.1"], { epoch: 1, cursor: 1 })),
        ),
      );
    if (s.used.tokenFailures < (budget.tokenFailures ?? 0))
      actions.push(
        step("the token function fails once", () => {
          s.used.tokenFailures++;
          s.runtime.tokenFailures = 1;
        }),
      );
    if (s.used.clock < budget.clock && s.timers.nextAt() !== undefined)
      actions.push(step(CLOCK, () => (s.used.clock++, s.timers.advanceToNext())));
    return actions;
  },
  observe: (s) => ({
    subs: s.subs.map(({ name, log, state, ended, refused, waiting }) => ({
      name,
      log: [...log],
      state,
      ended,
      refused,
      waiting,
    })),
    runtime: s.runtime.snapshot(),
    tokenFailuresArmed: s.runtime.tokenFailures,
    timers: s.timers.pending().map((timer) => timer.at - s.timers.now),
    used: { ...s.used },
  }),
  invariants: {
    [CONTIGUOUS]: (o) => o.subs.every((sub) => contiguityBreak(sub.log) === null),
    [NOT_ENDED]: (o) => o.subs.every((sub) => sub.ended === null),
    [REFUSED_ON_DEADLINE]: (o) =>
      o.subs.every((sub) => sub.refused === null || sub.refused === ATTACH_TIMED_OUT),
    // A session.ended still on the wire (frames one at a time) has not reached the client yet.
    [LIVE_ATTACHED]: (o) =>
      o.subs.every(
        (sub) =>
          sub.state !== "live" ||
          sub.ended !== null ||
          sub.refused !== null ||
          o.runtime.sockets.some(
            (socket) =>
              socket.attachedBy !== null ||
              socket.inbox.some((frame) => frame.startsWith("session.ended")),
          ),
      ),
  },
  eventually: {
    // A frame the relay lost is noticed only when something after it reaches the client: a later event on the same
    // attachment, or a new attach's backlog (after a drop, a rewrite, or B joining). Catch-up is not claimed only while
    // the lost event is still the last thing its attachment sent (ModelSocket.attachment.withheld).
    [CAUGHT_UP]: (o) =>
      o.runtime.sockets.some((socket) => socket.withheld !== null) ||
      o.subs.every((sub) => {
        if (sub.refused !== null) return true;
        const at = position(sub.log);
        return (
          sub.state === "live" &&
          at.cursor === o.runtime.journal &&
          (at.epoch === undefined || at.epoch === o.runtime.epoch)
        );
      }),
    // An attach every subscriber gave up on (or whose subscription ended) may still be answered late: the client lets go
    // of what that starts, so the runtime stops streaming the chat to it.
    [LET_GO]: (o) =>
      o.subs.some((sub) => sub.refused === null && sub.ended === null) ||
      o.runtime.sockets.every((socket) => socket.attachedBy === null),
  },
  drain: async (s) => {
    const did: Array<string> = [];
    const connecting = s.runtime.connecting();
    if (connecting) {
      s.runtime.open(connecting);
      did.push("socket opens");
    }
    for (const socket of s.runtime.live()) {
      for (const request of [...socket.requests]) {
        // server.ts may answer it later than any bound the client knows, or refuse it: progress may not wait for an
        // answer the client gave up on. A checker step may still answer it late.
        if (abandoned(request)) continue;
        s.runtime.answer(socket, request);
        did.push(`runtime answers ${describe(request)}`);
      }
    }
    const arrived = s.runtime.deliverAll();
    if (arrived > 0) did.push(`${arrived} frames arrive`);
    if (did.length === 0 && (await s.timers.advanceToNext())) did.push("clock");
    await settled(s.timers);
    return did;
  },
  drainRounds: 20,
  dispose: (s) => s.restore(),
});

const showStream = (o: StreamView) =>
  o.subs
    .map(
      (sub) =>
        `${sub.name}[${sub.state}${sub.ended ? ` ended ${sub.ended}` : ""}${sub.refused ? ` refused: ${sub.refused}` : ""}] ${sub.log.join(" ")}`,
    )
    .join(" | ") + ` · runtime epoch ${o.runtime.epoch} head ${o.runtime.journal}`;

test(
  "client event stream: every subscriber gets each event of its epoch once and in order, and catches up",
  { timeout: 1_800_000 },
  async () => {
    const verdict = await checkAsync(streamSpec({ budget: STREAM }));
    report("client event stream", verdict, showStream);
    assertHolds(verdict, { show: showStream });
  },
);

test(
  "client event stream with each frame arriving as a step of its own",
  { timeout: 1_800_000 },
  async () => {
    const verdict = await checkAsync(streamSpec({ frames: "stepwise", budget: STEPWISE }));
    report("client event stream (frames one at a time)", verdict, showStream);
    assertHolds(verdict, { show: showStream });
  },
);

// Finding 2a (client.ts onMessage), fixed: the runtime answers a reattach after its 30 s deadline, past a rewrite. The
// client still reads that answer, so its reset comes before the backlog behind it. The stream run above reaches this
// at both bounds; this run keeps the old counterexample's steps checked.
test(
  "client event stream when the runtime answers an attach after its deadline",
  { timeout: 600_000 },
  async () => {
    const verdict = await checkAsync(
      streamSpec({ budget: { drops: 0, commits: 1, losses: 0, rewrites: 1, joins: 0, clock: 2 } }),
    );
    report("client event stream (a late attach answer)", verdict, showStream);
    assertHolds(verdict, { show: showStream });
  },
);

// Finding 2a on the wire, fixed: an attach answer still on the wire when the client's 30 s run out is read when it
// arrives, so its backlog never reaches a subscriber on the old epoch. The full-bound stepwise run reaches this; at the
// default bound, which leaves clock steps out of that run, this run keeps the old counterexample's steps checked.
test(
  "client event stream when an attach answer is still on the wire at its deadline",
  { timeout: 600_000 },
  async () => {
    const verdict = await checkAsync(
      streamSpec({
        frames: "stepwise",
        budget: { drops: 0, commits: 1, losses: 0, rewrites: 1, joins: 1, clock: 2 },
      }),
    );
    report("client event stream (an answer slow on the wire)", verdict, showStream);
    assertHolds(verdict, { show: showStream });
  },
);

// Finding 1 (client.ts sync and attach), fixed: B's attach() times out while A shares the session, after the
// journal_reset that ends A's attachment arrived. A still acts on it: it attaches again and follows epoch 2. The
// full-bound stream runs above reach this trace too, and the same root after a drop (B's attach was to bring A back);
// at the default bound, which leaves B out of the stream run, this run keeps the old counterexample's steps checked.
test(
  "client event stream when an attach times out while another subscriber shares the session",
  { timeout: 600_000 },
  async () => {
    const verdict = await checkAsync(
      streamSpec({ budget: { drops: 0, commits: 0, losses: 0, rewrites: 1, joins: 1, clock: 2 } }),
    );
    report("client event stream (a shared attach times out)", verdict, showStream);
    assertHolds(verdict, { show: showStream });
  },
);

// A let-go entry's late answer, read while the current entry's subscribers are joined by another: A's attach times out,
// B attaches and is live, C joins B, and the runtime answers A's old attach, whose attachment takes the place of B's.
// C's attach then times out (or is refused), and B must attach again rather than say "live" while the runtime's
// attachment is A's. No other run has a third subscriber. server.ts's attach lane answers a chat's attaches on one
// connection in the order sent, so it would not answer A's after C's: this keeps the client from relying on that.
test(
  "client event stream when a let-go attach is answered while a join is out",
  { timeout: 600_000 },
  async () => {
    const verdict = await checkAsync(
      streamSpec({ budget: { drops: 0, commits: 1, losses: 0, rewrites: 0, joins: 2, clock: 3 } }),
    );
    report("client event stream (a let-go answer during a join)", verdict, showStream);
    assertHolds(verdict, { show: showStream });
  },
);

// A token function that throws (DesktopCloudToken while Cloud is briefly out of reach) while A's first attach or a
// re-attach waits on the next socket: the attach keeps waiting, as a mutating call does, instead of failing
// "unauthorized" though no runtime refused it. The same at both bounds: a rewrite puts the re-attach out, a drop leaves
// it waiting, and a clock step reconnects.
test("client event stream through a token function that fails", { timeout: 600_000 }, async () => {
  const verdict = await checkAsync(
    streamSpec({
      budget: {
        drops: 1,
        commits: 0,
        losses: 0,
        rewrites: 1,
        joins: 0,
        clock: 2,
        tokenFailures: 1,
      },
    }),
  );
  report("client event stream (a token function that fails)", verdict, showStream);
  assertHolds(verdict, { show: showStream });
});

// ---------------------------------------------------------------------------------------------------------------
// Mutating calls: the durable outbox, resend, the wire order, reloads and the token function.

interface Calls {
  readonly timers: VirtualTimers;
  readonly restore: () => void;
  readonly runtime: ModelRuntime;
  /** The page's durable store: it outlives a reload. */
  readonly outbox: ReturnType<typeof memoryOutbox>;
  client: Client;
  /** Request ids in the order they were called. */
  readonly called: Array<string>;
  /** Every way each call (or its restored outbox entry) ended, across clients. */
  readonly fates: Record<string, Array<string>>;
  /** What ConnectOptions.resend said, per request id, not yet used by a transmission. */
  readonly allowed: Set<string>;
  readonly transmitted: Set<string>;
  readonly violations: Array<string>;
  moved: boolean;
  readonly used: {
    drops: number;
    lost: number;
    unauthorized: number;
    reloads: number;
    tokenFailures: number;
    clock: number;
  };
}

const LEFT_IN_OUTBOX = "left in the outbox (client closed)";

const fateOf = (
  calls: Calls,
  requestId: string,
  outcome: { result: unknown } | { error: Error },
) => {
  const list = (calls.fates[requestId] ??= []);
  if ("result" in outcome) return void list.push("answered");
  const error = outcome.error;
  if (error instanceof CallNotSent) {
    list.push(`not sent (${error.reason})`);
    if (error.reason === "unsent" && calls.transmitted.has(requestId))
      calls.violations.push(`${requestId} reported unsent after it went out`);
    return;
  }
  if (error instanceof CallTimeout) return void list.push("timed out");
  if (error.message === "client closed" && calls.outbox.entries.has(requestId))
    return void list.push(LEFT_IN_OUTBOX);
  if (/runtime forgot its request id/.test(error.message))
    return void list.push("too old to resend");
  list.push(
    `failed: ${error.message}${calls.outbox.entries.has(requestId) ? "" : ", outbox entry gone"}`,
  );
  calls.violations.push(
    `${requestId} ended "${error.message}" and ${calls.outbox.entries.has(requestId) ? "is still in the outbox" : "left the outbox"}`,
  );
};

const openClient = (calls: Calls): Client =>
  connect(URL, calls.runtime.token, undefined, {
    socket: calls.runtime.factory,
    outbox: calls.outbox,
    resend: (entry: OutboxEntry) => {
      if (calls.moved) return false;
      calls.allowed.add(entry.request_id);
      return true;
    },
    onRestored: (entry, outcome) => fateOf(calls, entry.request_id, outcome),
  });

/** How many of each step one trace may take: link drops, lost answers, clock steps (calls are always r1 and r2). */
interface CallsBudget {
  readonly drops: number;
  readonly lost: number;
  readonly clock: number;
}

/** The bounds, as for the stream: FULL takes three clock steps, the default one. */
const CALLS: CallsBudget = FULL ? { drops: 1, lost: 1, clock: 3 } : { drops: 1, lost: 1, clock: 1 };

/**
 * `reload`: the page may reload once onto the same outbox. `unauthorized`: the runtime may answer one call
 * "unauthorized" (its token expired), so the client reconnects on a fresh token. `tokenFails`: the token function may
 * throw once (DesktopCloudToken.get while This Mac's runtime is away): finding 3's trigger.
 */
const callsSpec = (options: {
  readonly reload: boolean;
  readonly unauthorized: boolean;
  readonly tokenFails: boolean;
  readonly budget: CallsBudget;
}): AsyncSpec<Calls, object> => ({
  make: async () => {
    const { timers, restore } = installClock();
    const runtime = new ModelRuntime(0);
    const calls: Calls = {
      timers,
      restore,
      runtime,
      outbox: memoryOutbox(),
      client: undefined as unknown as Client,
      called: [],
      fates: {},
      allowed: new Set(),
      transmitted: new Set(),
      violations: [],
      moved: false,
      used: { drops: 0, lost: 0, unauthorized: 0, reloads: 0, tokenFailures: 0, clock: 0 },
    };
    runtime.onFrame = (frame) => {
      const id = frame.requestId;
      if (id === undefined) return;
      if (calls.transmitted.has(id) && !calls.allowed.delete(id))
        calls.violations.push(`${id} went out again without resend allowing it`);
      calls.transmitted.add(id);
      const mine = calls.called.indexOf(id);
      const onThisSocket = new Set(
        runtime.wire.filter((w) => w.socket === frame.socket).map((w) => w.requestId),
      );
      for (const earlier of calls.called.slice(0, mine)) {
        if (calls.outbox.entries.has(earlier) && !onThisSocket.has(earlier))
          calls.violations.push(`${id} went out on socket ${frame.socket} before ${earlier}`);
      }
    };
    calls.client = openClient(calls);
    await timers.settle();
    return calls;
  },
  actions: (c) => {
    const step = (name: string, run: () => void | Promise<unknown>): Action<Calls> => ({
      name,
      run: async () => {
        await run();
        await c.timers.settle();
      },
    });
    const budget = options.budget;
    const actions: Array<Action<Calls>> = runtimeSteps(c.runtime, {
      drops: c.used.drops < budget.drops,
      lostAnswers: c.used.lost < budget.lost,
      unauthorized: options.unauthorized && c.used.unauthorized < 1,
    }).map((one) =>
      step(one.name, () => {
        if (one.name.startsWith("link drops")) c.used.drops++;
        if (one.name.endsWith("the answer is lost")) c.used.lost++;
        if (one.name.endsWith(": unauthorized")) c.used.unauthorized++;
        one.run();
      }),
    );
    const next = ["r1", "r2"].find((id) => !c.called.includes(id));
    if (next) {
      actions.push(
        step(`call turn.submit ${next}`, () => {
          c.called.push(next);
          c.client
            .call(
              "turn.submit",
              { session_id: SESSION, request_id: next, input: { text: next } } as never,
              { epoch: 1 },
            )
            .then(
              (result) => fateOf(c, next, { result }),
              (error: Error) => fateOf(c, next, { error }),
            );
        }),
      );
    }
    if (options.reload && c.used.reloads < 1)
      actions.push(
        step("the page reloads (a new client on the same outbox)", () => {
          c.used.reloads++;
          c.client.close();
          c.client = openClient(c);
        }),
      );
    if (options.tokenFails && c.used.tokenFailures < 1)
      actions.push(
        step("the token function fails once", () => {
          c.used.tokenFailures++;
          c.runtime.tokenFailures = 1;
        }),
      );
    if (!c.moved)
      actions.push(
        step("the chat moves (resend says no from now on)", () => void (c.moved = true)),
      );
    if (c.used.clock < budget.clock && c.timers.nextAt() !== undefined)
      actions.push(step(CLOCK, () => (c.used.clock++, c.timers.advanceToNext())));
    return actions;
  },
  observe: (c) => ({
    fates: structuredClone(c.fates),
    outbox: [...c.outbox.entries.keys()].sort(),
    called: [...c.called],
    transmitted: [...c.transmitted].sort(),
    allowed: [...c.allowed].sort(),
    violations: [...c.violations],
    moved: c.moved,
    tokenFailuresArmed: c.runtime.tokenFailures,
    runtime: c.runtime.snapshot(),
    timers: c.timers.pending().map((timer) => timer.at - c.timers.now),
    used: { ...c.used },
  }),
  // A call's earlier fates do not change what can happen next (violations are recorded as they happen): its latest does.
  key: (o) =>
    canonicalKey({
      ...o,
      fates: Object.fromEntries(
        Object.entries((o as { fates: Record<string, Array<string>> }).fates).map(([id, list]) => [
          id,
          list.at(-1),
        ]),
      ),
    }),
  invariants: {
    [CALLS_SAFE]: (o) => (o as { violations: ReadonlyArray<string> }).violations.length === 0,
  },
  eventually: {
    // Progress: on the live client, every call made (and every entry a closed client left in the outbox) ends. "Left in
    // the outbox" is not an end: the next client on that outbox must finish it, and nothing may stay there.
    [CALLS_END]: (o) => {
      const { called, fates, outbox } = o as {
        called: ReadonlyArray<string>;
        fates: Record<string, ReadonlyArray<string>>;
        outbox: ReadonlyArray<string>;
      };
      return (
        outbox.length === 0 &&
        called.every((id) => fates[id] !== undefined && fates[id]!.at(-1) !== LEFT_IN_OUTBOX)
      );
    },
  },
  // One fair round with the link up: open the socket, answer every request in arrival order, else move the clock.
  drain: async (c) => {
    const did: Array<string> = [];
    const connecting = c.runtime.connecting();
    if (connecting) {
      c.runtime.open(connecting);
      did.push("socket opens");
    }
    for (const socket of c.runtime.live()) {
      for (const request of [...socket.requests]) {
        c.runtime.answer(socket, request);
        did.push(`runtime answers ${describe(request)}`);
      }
    }
    if (did.length === 0 && (await c.timers.advanceToNext())) did.push("clock");
    await c.timers.settle();
    return did;
  },
  drainRounds: 20,
  dispose: (c) => c.restore(),
});

const showCalls = (o: object) => {
  const { fates, outbox, violations, runtime } = o as {
    fates: unknown;
    outbox: unknown;
    violations: unknown;
    runtime: RuntimeSnapshot;
  };
  return JSON.stringify({ fates, outbox, ran: runtime.ran, violations });
};

// Finding 3 (client.ts open), fixed: a token function that threw settled and rejected every pending call, so a send
// that may have run, or one restored after a reload, left the outbox for good, and one that never went out failed
// "unauthorized" instead of CallNotSent. Both runs take that trigger: a mutating call waits for a token as for a socket.
test(
  "client mutating calls on one page: resend after drops, lost answers, an expired token and a token function that fails, in call order, and every call ends",
  { timeout: 600_000 },
  async () => {
    const verdict = await checkAsync(
      callsSpec({ reload: false, unauthorized: true, tokenFails: true, budget: CALLS }),
    );
    report("client mutating calls on one page", verdict, showCalls);
    assertHolds(verdict, { show: showCalls });
  },
);

test(
  "client mutating calls across a reload: the outbox resends what was in flight, only when resend allows it, through a token function that fails, and every call ends",
  { timeout: 600_000 },
  async () => {
    const verdict = await checkAsync(
      callsSpec({ reload: true, unauthorized: false, tokenFails: true, budget: CALLS }),
    );
    report("client mutating calls across a reload", verdict, showCalls);
    assertHolds(verdict, { show: showCalls });
  },
);

test("the delivery-log reader catches a splice and a hole", () => {
  expect(contiguityBreak(["e1.1", "e1.2", "reset 2", "e2.1"])).toBeNull();
  expect(contiguityBreak(["e1.1", "e2.2"])).toMatch(/without a reset/);
  expect(contiguityBreak(["e1.1", "e1.3"])).toMatch(/after cursor 1/);
});
