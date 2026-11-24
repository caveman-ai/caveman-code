// Bounded model checks of sending in a chat exactly once (S5): the real ChatSender over the real Session Protocol
// client (connect() through the session-protocol package's ModelRuntime) and fakeCloud's queue. A call goes to the
// runtime with orCloud, as hub.ts routeFor hands it while Cloud lists the runtime online and its link is not
// "unreachable" (a link still connecting counts); one not out within UNSENT_MS, that lost its link that long before its
// answer, whose client the pool closed, or that was turned away because the chat is moving, goes to Cloud's queue.
// Cloud hands queued calls to the same runtime when the checker says, which runs each and then posts its result.
// The runs at the end of the file add a page that loses its Web Lock, a chat that moves to another computer, a direct
// channel beside the relay, a device store that applies writes in order and may fall behind, and a reload: the real
// kvOutbox, connectDirect and a second ChatSender and client on the same store.
// Run: pnpm --filter @caveman-app/web exec vitest run src/state/sync/sender.modelcheck.test.ts (CLIENT_DELIVERY_FULL=1 for the
// larger bound; see `bound` below and .claude/skills/client-delivery/SKILL.md).
import {
  assertHolds,
  checkAsync,
  formatTrace,
  type Action,
  type AsyncSpec,
  type Verdict,
  type VirtualTimers,
} from "@caveman-app/model-check";
import {
  CallNotSent,
  CallTimeout,
  connect,
  DEFAULT_TIMEOUT_MS,
  memoryOutbox,
  outboxAt,
  SessionProtocolError,
  type Client,
  type Outbox,
  type OutboxEntry,
} from "@caveman-app/session-protocol/client";
import {
  connectDirect,
  pathOf,
  type RtcChannel,
  type RtcPeer,
  type RtcPeerConstructor,
} from "@caveman-app/session-protocol/direct";
import {
  describe,
  FULL,
  installClock,
  ModelRuntime,
  runtimeSteps,
  SESSION,
  type ModelSocket,
  type Request,
  type RuntimeSnapshot,
} from "../../../../../packages/session-protocol/test/modelRuntime.ts";
import { expectFinding } from "../../../../../packages/session-protocol/test/finding.ts";
import { test } from "vitest";
import { fakeCloud } from "./fakes.test-support.ts";
import { memoryKv, type Kv } from "./kv.ts";
import { kvOutbox } from "./outbox.ts";
import { onlyPage, type Pages } from "./pages.ts";
import { ChatSender, RESEND_OUT_WITHIN_MS, type Route } from "./sender.ts";

const CLOCK = "clock: fire the next timer";
const CALLS = ["r1", "r2"] as const;

// The promise in plain words: each is the exact name a verdict reports.
const ENDS_ALLOWED =
  "a send ends answered by the runtime, queued in Cloud, timed out or stale, never otherwise";
const ONE_WAY =
  "a call the runtime answered on the device's connection is never also queued in Cloud";
const IN_ORDER = "the runtime runs a chat's calls in the order they were sent";
const EVERY_SEND_ENDS =
  "every send ends, and the runtime ran every call Cloud took, once the link and Cloud are up";
const EVERY_SEND_ENDS_LINK_GONE =
  "every send ends, and the runtime ran every call Cloud took, once Cloud is up, though the link never comes back";

interface Sending {
  readonly timers: VirtualTimers;
  readonly restore: () => void;
  readonly runtime: ModelRuntime;
  /** The pool's connection to the runtime: a new one on the same outbox once the pool let the last go. */
  client: Client;
  readonly cloud: ReturnType<typeof fakeCloud>;
  readonly runtimeOutbox: ReturnType<typeof memoryOutbox>;
  readonly cloudOutbox: ReturnType<typeof memoryOutbox>;
  readonly sender: ChatSender;
  readonly called: Array<string>;
  /** How each send() ended: "runtime", "cloud", or the error. */
  readonly fates: Record<string, string>;
  /** Request ids Cloud's queue handed to the runtime. */
  readonly delivered: Array<string>;
  /** Request ids whose result the runtime posted to Cloud (Cloud holds them no more). */
  readonly finished: Array<string>;
  /** Request ids the runtime ran because the device sent them over its connection (not Cloud's queue). */
  readonly ranDirect: Set<string>;
  readonly violations: Array<string>;
  readonly used: {
    drops: number;
    lost: number;
    moving: number;
    tokenFailures: number;
    cloudDown: number;
    poolDrops: number;
    clock: number;
  };
}

interface Options {
  /**
   * How later calls are routed. "routeFor": as hub.ts routeFor does, the runtime while it is reachable, whatever the
   * earlier calls did, so ChatSender alone keeps a call behind one in Cloud's queue there (finding 8a). "follows": the
   * route itself names Cloud's queue once a call went there, so later calls take send()'s Cloud route.
   */
  readonly route: "routeFor" | "follows";
  /** The token function may throw once (finding 3's trigger, as the composer sees it). */
  readonly tokenFails: boolean;
  /** The link may drop once, and the runtime may run a call whose answer is then lost (finding 8b's trigger). */
  readonly drops: boolean;
  /** Cloud may go down and come back once, so POST /calls and the call state read fail meanwhile (finding 8c's trigger). */
  readonly cloudOutage: boolean;
  /** Once the link drops, no socket opens again: the relay never comes back (the drain does not open one either). */
  readonly relayGone?: boolean;
  /** The pool may let the connection go once (RuntimePool dropGone or idle: client.close()); a new one takes over. */
  readonly poolDrops?: boolean;
  /** Clock steps the run may take (default 3). The drain moves the clock as well. */
  readonly clock?: number;
}

/**
 * Cloud's mailbox hands a queued call to the chat's runtime, which runs it once (its receipts dedupe by request id, the
 * person's principal both ways); Cloud reads it "delivered" until the runtime posts its result (`finish`).
 */
const deliver = (s: Sending, id: string) => {
  s.delivered.push(id);
  s.cloud.delivered(SESSION, id);
  if (s.runtime.receipts.has(id)) return;
  s.runtime.receipts.set(id, { queued: true });
  s.runtime.ran.push(id);
};
const finish = (s: Sending, id: string) => {
  s.finished.push(id);
  s.cloud.ran(SESSION, id);
};

/** The link dropped in a run whose relay never comes back. */
const linkGone = (s: Sending, options: Options) =>
  options.relayGone === true && s.used.drops + s.used.lost > 0;

const senderSpec = (options: Options): AsyncSpec<Sending, object> => ({
  make: async () => {
    const { timers, restore } = installClock();
    const runtime = new ModelRuntime(0);
    const runtimeOutbox = memoryOutbox();
    const cloudOutbox = memoryOutbox();
    const client = connect("wss://relay.test/rt-1", runtime.token, undefined, {
      socket: runtime.factory,
      outbox: runtimeOutbox,
    });
    const cloud = fakeCloud();
    const sender = new ChatSender({ api: cloud.api, outbox: cloudOutbox, retryMs: () => 1_000 });
    const s: Sending = {
      timers,
      restore,
      runtime,
      client,
      cloud,
      runtimeOutbox,
      cloudOutbox,
      sender,
      called: [],
      fates: {},
      delivered: [],
      finished: [],
      ranDirect: new Set(),
      violations: [],
      used: {
        drops: 0,
        lost: 0,
        moving: 0,
        tokenFailures: 0,
        cloudDown: 0,
        poolDrops: 0,
        clock: 0,
      },
    };
    const run = runtime.answer.bind(runtime);
    runtime.answer = (socket, request, how) => {
      const id = request.params.request_id;
      const before = runtime.ran.length;
      run(socket, request, how);
      if (typeof id === "string" && runtime.ran.length > before) s.ranDirect.add(id);
    };
    await timers.settle();
    return s;
  },
  actions: (s) => {
    const step = (name: string, run: () => void | Promise<unknown>): Action<Sending> => ({
      name,
      run: async () => {
        await run();
        await s.timers.settle();
      },
    });
    const steps = runtimeSteps(s.runtime, {
      drops: options.drops && s.used.drops < 1,
      lostAnswers: options.drops && s.used.lost < 1,
    });
    const actions: Array<Action<Sending>> = steps
      .filter((one) => !(one.name === "socket opens" && linkGone(s, options)))
      .map((one) =>
        step(one.name, () => {
          if (one.name.startsWith("link drops")) s.used.drops++;
          if (one.name.endsWith("the answer is lost")) s.used.lost++;
          one.run();
        }),
      );
    const next = CALLS.find((id) => !s.called.includes(id));
    if (next)
      actions.push(
        step(`send turn.submit ${next}`, () => {
          s.called.push(next);
          const route = (): Route =>
            options.route === "follows" && s.cloud.posted.length > 0
              ? { via: "cloud" }
              : { via: "runtime", client: s.client, epoch: 1, orCloud: true };
          s.sender
            .send(
              SESSION,
              "turn.submit",
              { session_id: SESSION, request_id: next, input: { text: next } },
              route(),
              route,
            )
            .then(
              (outcome) => void (s.fates[next] = outcome.via),
              (error: unknown) => {
                const allowed =
                  error instanceof CallTimeout ||
                  (error instanceof CallNotSent && error.reason === "stale");
                s.fates[next] =
                  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
                if (!allowed) s.violations.push(`send ${next} failed: ${s.fates[next]}`);
              },
            );
        }),
      );
    // Cloud's queue hands a chat's calls over first in, first out (Caveman Cloud's mailbox; assumed here), and the
    // runtime takes the next only once it posted the last one's result (cloudLink/calls.ts).
    const running = s.delivered.find((id) => !s.finished.includes(id));
    if (running !== undefined)
      actions.push(
        step(`the runtime posts ${running}'s result to Cloud`, () => finish(s, running)),
      );
    const queuedNext =
      running === undefined
        ? [...new Set(s.cloud.posted.map((p) => p.request_id))].find(
            (id) => !s.delivered.includes(id),
          )
        : undefined;
    if (queuedNext !== undefined)
      actions.push(
        step(`Cloud's queue delivers ${queuedNext} to the runtime`, () => deliver(s, queuedNext)),
      );
    if (options.poolDrops && s.used.poolDrops < 1)
      actions.push(
        step(
          "the pool lets the connection go (its client closes; a new one opens on the same outbox)",
          () => {
            s.used.poolDrops++;
            s.client.close();
            s.client = connect("wss://relay.test/rt-1", s.runtime.token, undefined, {
              socket: s.runtime.factory,
              outbox: s.runtimeOutbox,
            });
          },
        ),
      );
    if (s.used.moving < 1 && s.runtime.moving === null)
      actions.push(
        step("the chat starts moving (the runtime turns calls away: lease_lost)", () => {
          s.used.moving++;
          s.runtime.moving = "lease_lost";
        }),
      );
    if (options.cloudOutage && s.used.cloudDown < 1)
      actions.push(
        step(
          "Cloud goes down (POST /calls fails until it is back)",
          () => (s.used.cloudDown++, s.cloud.setDown(true)),
        ),
      );
    if (s.used.cloudDown === 1)
      actions.push(step("Cloud is back", () => (s.used.cloudDown++, s.cloud.setDown(false))));
    if (options.tokenFails && s.used.tokenFailures < 1)
      actions.push(
        step("the token function fails once", () => {
          s.used.tokenFailures++;
          s.runtime.tokenFailures = 1;
        }),
      );
    if (s.used.clock < (options.clock ?? 3) && s.timers.nextAt() !== undefined)
      actions.push(step(CLOCK, () => (s.used.clock++, s.timers.advanceToNext())));
    return actions;
  },
  observe: (s) => ({
    called: [...s.called],
    fates: { ...s.fates },
    posted: s.cloud.posted.map((p) => p.request_id),
    delivered: [...s.delivered],
    finished: [...s.finished],
    ranDirect: [...s.ranDirect].sort(),
    violations: [...s.violations],
    outboxes: {
      runtime: [...s.runtimeOutbox.entries.keys()].sort(),
      cloud: [...s.cloudOutbox.entries.keys()].sort(),
    },
    runtime: s.runtime.snapshot(),
    timers: s.timers.pending().map((timer) => timer.at - s.timers.now),
    used: { ...s.used },
  }),
  invariants: {
    [ENDS_ALLOWED]: (o) => (o as View).violations.length === 0,
    [ONE_WAY]: (o) =>
      Object.entries((o as View).fates).every(
        ([id, fate]) => fate !== "runtime" || !(o as View).posted.includes(id),
      ),
    [IN_ORDER]: (o) => {
      const ran = (o as View).runtime.ran;
      return ran.every(
        (id, i) =>
          i === 0 ||
          CALLS.indexOf(ran[i - 1] as (typeof CALLS)[number]) <
            CALLS.indexOf(id as (typeof CALLS)[number]),
      );
    },
  },
  eventually: {
    // Progress: every send() made settles (runtime, cloud, or an allowed error) and Cloud's queue hands over and finishes
    // every call it took, once Cloud is up, and the link too unless the run's relay never comes back. So the drain runs
    // to the deliveries, where a call queued in Cloud would run after a later one.
    [options.relayGone ? EVERY_SEND_ENDS_LINK_GONE : EVERY_SEND_ENDS]: (o) =>
      (o as View).called.every((id) => (o as View).fates[id] !== undefined) &&
      (o as View).posted.every((id) => (o as View).finished.includes(id)),
  },
  // One fair round with Cloud up: Cloud comes back, the socket opens (unless the run's relay is gone), the runtime
  // answers every request in arrival order, Cloud's queue hands over what it holds and the runtime posts each result;
  // with nothing of that left, the clock moves.
  drain: async (s) => {
    const did: Array<string> = [];
    if (s.used.cloudDown === 1) {
      s.used.cloudDown++;
      s.cloud.setDown(false);
      did.push("Cloud is back");
    }
    const connecting = s.runtime.connecting();
    if (connecting && !linkGone(s, options)) {
      s.runtime.open(connecting);
      did.push("socket opens");
    }
    for (const socket of s.runtime.live()) {
      for (const request of [...socket.requests]) {
        s.runtime.answer(socket, request);
        did.push(`runtime answers ${describe(request)}`);
      }
    }
    for (const id of [...new Set(s.cloud.posted.map((p) => p.request_id))].filter(
      (id) => !s.finished.includes(id),
    )) {
      if (!s.delivered.includes(id)) deliver(s, id);
      finish(s, id);
      did.push(`Cloud's queue delivers ${id}, the runtime posts its result`);
    }
    if (did.length === 0 && (await s.timers.advanceToNext())) did.push("clock");
    await s.timers.settle();
    return did;
  },
  drainRounds: 20,
  dispose: (s) => s.restore(),
});

interface View {
  readonly called: ReadonlyArray<string>;
  readonly fates: Record<string, string>;
  readonly posted: ReadonlyArray<string>;
  readonly finished: ReadonlyArray<string>;
  readonly ranDirect: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
  readonly runtime: RuntimeSnapshot;
}

const showSending = (o: object) => {
  const v = o as View;
  return `fates ${JSON.stringify(v.fates)} · ran ${v.runtime.ran.join(",") || "-"} (direct ${v.ranDirect.join(",") || "-"}) · queued in Cloud ${v.posted.join(",") || "-"}${v.violations.length ? ` · ${v.violations.join("; ")}` : ""}`;
};

const check = async (run: string, options: Options): Promise<Verdict<object>> => {
  const name = `${run} [${FULL ? "full" : "default"} bound]`;
  const verdict: Verdict<object> = await checkAsync(senderSpec(options));
  if (verdict.ok)
    console.log(
      `${name}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}`,
    );
  else
    console.log(
      `${name}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states)\n${formatTrace(verdict.trace, showSending)}`,
    );
  return verdict;
};
const run = async (name: string, options: Options) =>
  assertHolds(await check(name, options), { show: showSending });

const verified: Options = {
  route: "routeFor",
  tokenFails: false,
  drops: false,
  cloudOutage: false,
};
/**
 * The bounds. CLIENT_DELIVERY_FULL=1 (FULL) runs each check with three clock steps; unset, as in the package's
 * `vitest run`, `small` cuts that so the file takes seconds.
 */
const bound = (small: Partial<Options>): Partial<Options> => (FULL ? {} : small);

// Finding 8a's run, fixed: routed as hub.ts routeFor routes, a call behind one in Cloud's queue follows it there
// because ChatSender asks Cloud whether it still holds the chat's earlier calls. Finding 3 (client.ts open), fixed: a
// token function that threw once rejected a send that never went out with SessionProtocolError "unauthorized", not
// CallNotSent, so ChatSender did not queue it in Cloud and the message was lost; this run takes that trigger too.
test(
  "chat sender: each call reaches the runtime once, in order, and every send ends, routed as hub.ts routeFor routes, through a token function that fails once",
  { timeout: 600_000 },
  () => run("chat sender (routeFor)", { ...verified, tokenFails: true }),
);

test(
  "chat sender: the same when the route itself sends calls behind one queued in Cloud there",
  { timeout: 600_000 },
  () => run("chat sender (route follows the queue)", { ...verified, route: "follows" }),
);

// Finding 8b's run, fixed: a call goes to Cloud's queue only once the calls before it went their way for good, so one
// never out does not pass one waiting to be resent after a drop; and a call out when the link drops that goes to Cloud's
// queue once UNSENT_MS passed takes the one out behind it along, so that one is not resent first on a socket that
// opens in between. Three clock steps at both bounds: each trace takes two (the reconnect, then UNSENT_MS).
test(
  "chat sender with a link drop after a send went out: each call runs once, in order, and every send ends",
  { timeout: 600_000 },
  () => run("chat sender (link drop)", { ...verified, drops: true }),
);

// Finding 8c's run is inside this one, fixed the same way: one turned away does not pass another waiting out a failed
// post.
test(
  "chat sender with a link drop, a lost answer and a Cloud outage: each call still runs once, in order, and every send ends",
  { timeout: 600_000 },
  () =>
    run("chat sender (drops and an outage)", {
      ...verified,
      drops: true,
      cloudOutage: true,
      ...bound({ clock: 1 }),
    }),
);

// The relay never comes back once the link drops: a send that went out before must neither wait for the link itself
// nor hold up the calls behind it. The drain opens no socket either, so progress comes from the clock alone.
test(
  "chat sender when the relay never comes back after the link drops: each call runs once, in order, and every send ends once Cloud is up",
  { timeout: 600_000 },
  () => run("chat sender (relay gone)", { ...verified, drops: true, relayGone: true }),
);

// The pool lets the connection go (RuntimePool dropGone or its idle drop close the client) with a send on it
// unanswered, and a new connection on the same outbox takes over: nothing it left there goes out again behind a later
// call in Cloud's queue.
test(
  "chat sender when the pool lets the connection go: each call runs once, in order, and every send ends",
  { timeout: 600_000 },
  () =>
    run("chat sender (pool drop)", {
      ...verified,
      drops: true,
      poolDrops: true,
      ...bound({ clock: 1 }),
    }),
);

// ------------------------------------------------------------------------------------------------------------------
// A page that loses its Web Lock, a chat that moves, and a reload. A send is in the device's outbox from the moment it
// is made; a page that lost its lock sends none of its calls, and the page loaded anew takes over what it left.
//
// Page A sends through the real kvOutbox on a device store shared by every page (memoryKv): the sender's ("cloud") and
// rt-1's connection's ("runtime/rt-1"). Its Pages is onlyPage with `owns` turned false by a step, as lockedPages says
// once the lock is lost; no other page is open until the reload, so `exclusive` running without a lock is what
// lockedPages does then too. At any step page A may lose its lock; the chats Cloud lists may move to rt-2 (Cloud's list
// places them there, so `resendable` says no for a call that went out to rt-1; rt-1 turns their calls away with
// lease_lost; Cloud's queue hands them to rt-2, whose receipts know none of rt-1's, as when the receipt has not reached
// the chat's copy); rt-1 may answer, refuse, run a call and answer nothing, or run it and lose its answer with the link;
// the relay or the direct channel may drop; and the device store may fall behind, after which each write lands as a step
// of its own, in the order made (IndexedDB), and a read waits for the writes before it. At the end the page reloads:
// page A's document goes (its sockets close under it, its timers never fire, the writes it asked for land), and page B,
// a new ChatSender and client on the same store, takes over what A left, with Cloud's queue and rt-1's receipts as they
// are. Two things no verified run does: let a call's five-minute deadline run out (a send that times out fails where the
// person sees it, and nothing here settles whether it may then never run), and reload while a lost page's rewrite
// waits on its read (finding 13, open: its own FINDING test below).

const RT1 = "rt-1";
const RT2 = "rt-2";
const RELAY = `wss://relay.test/${RT1}`;
/** A reload this long after page A's last step: past RESEND_OUT_WITHIN_MS. */
const LATE_MS = 11 * 60_000;
/** The direct channel's silence limit, past every run's clock: its pinger never fires. */
const CHANNEL_SILENCE_MS = 1_000_000_000;

const NEVER_TWICE =
  "a call never runs twice: on two runtimes, or on rt-1 and again from Cloud's queue";
const MADE_ORDER = "the runtimes run each chat's calls in the order they were made";
const ONE_WAY_HELD =
  "a call answered on the device's connection while its page held its lock is never also queued in Cloud";
const DELIVERED =
  "every call the person made runs on a runtime once the page has reloaded, unless its loss is one ACCEPTED_LOSS names";

/**
 * The accepted ways a call the person made never runs, each with its rule. DELIVERED excuses a call only in one of
 * these, and the trace says which; nothing else is excused.
 */
const ACCEPTED_LOSS = {
  // Page A's own client would not send it again (its chat moved off rt-1, or it waited past RESEND_OUT_WITHIN_MS): the
  // send ends CallNotSent "stale".
  stale:
    "a call whose chat moved or changed epoch since it was made is dropped, as the client's resend would drop it",
  // Page B let it go as one that may have run: the sender's mark (Held.wentOut) or a connection's outbox entry (resent
  // as one that went out), and it is older than ten minutes or its chat moved. Never one rt-1 refused, or one its
  // connection let go unsent.
  mayHaveRun:
    "a call that may have gone out with no answer goes to Cloud after a reload only as the client would resend it: " +
    "within ten minutes (RESEND_OUT_WITHIN_MS), and while Cloud's list still places its chat on the computer it went out to, on the same epoch; " +
    "a call its connection kept but never sent before the reload gets the same ten-minute rule. " +
    "One the runtime refused (its chat moving) or its connection never sent loses its mark, and goes to Cloud's queue from the page loaded anew",
  // A call Cloud cannot carry, in the sender's outbox at the reload but in no connection's.
  noCloud:
    "a call Cloud cannot carry is lost when its page closes while it still waits in memory behind the chat's earlier call, before its connection's outbox holds it",
} as const;
/** The one accepted way a call runs twice: Cloud had it before the chat moved. */
const ACCEPTED_TWICE =
  "a call that ran on a Mac can run again if Cloud moves the chat to a Cloud computer before the call's receipt reached the chat's copy";

/** One call the person makes: its chat, and whether Cloud lists that chat (orCloud) or only rt-1's connection takes it. */
interface Made {
  readonly id: string;
  readonly chat: string;
  readonly listed: boolean;
}

interface LostOptions {
  /** The calls, in the order the person makes them (page A only). */
  readonly calls: ReadonlyArray<Made>;
  /** connectDirect with its channel to rt-1 up from the start (no new channel once it dies); else connect() on the relay. */
  readonly direct: boolean;
  /** The relay may drop once, and rt-1 may run a call and lose its answer with its link once. */
  readonly drops: boolean;
  /** direct: the channel may die once. */
  readonly channelDies: boolean;
  /** rt-1 may run a call and answer nothing, once. */
  readonly silent: boolean;
  /**
   * The device store falls behind for the rest of page A's life: "step", once at any step; "always", from the start;
   * "never".
   */
  readonly slowStore: "never" | "step" | "always";
  /** The listed chats may move to rt-2, once. */
  readonly moves: boolean;
  /**
   * The reload is a step of its own, at any step of page A's life, and the steps after it (rt-1's answers, Cloud's
   * deliveries, a move) come in every order. Unset, the page reloads only where the drain does, and what follows takes
   * the drain's order.
   */
  readonly reloadSteps: boolean;
  /** reloadSteps: the page may also reload eleven minutes after page A's last step (frozen meanwhile: no timer fires). */
  readonly lateReload: boolean;
  /**
   * The page may reload while a read of page A's waits in the store: the read a lost page makes before it rewrites one
   * of its entries (outbox.ts put), so the rewrite never happens (finding 13's trigger). Unset, page A reloads only once
   * no read of it waits, and the drain lets the store catch up with page A before it reloads.
   */
  readonly cutsRewrite?: boolean;
  readonly clock: number;
}

/** One store operation not applied yet: `write` names a write; a read has none and waits only for the writes before it. */
interface StoreOp {
  readonly write: string | undefined;
  readonly apply: () => Promise<unknown>;
  readonly settle: (outcome: Promise<unknown>) => void;
}
interface DeviceStore {
  /** Each write lands as a step of its own, in the order made. */
  behind: boolean;
  /** Page A's document went: what it asks of the store from now on never answers. */
  gone: boolean;
  readonly queue: Array<StoreOp>;
}

const short = (key: string) =>
  key
    .replace(`outbox/runtime/${RT1}/`, `${RT1}'s outbox `)
    .replace("outbox/cloud/", "the sender's outbox ");
const marksOf = (value: unknown): string => {
  const params = (value as { params?: { wentOut?: unknown; noCloud?: unknown } } | undefined)
    ?.params;
  return `${params?.wentOut ? " (may have gone out)" : ""}${params?.noCloud ? " (Cloud cannot carry it)" : ""}`;
};

/** Page A's view of the device store: IndexedDB applies writes in the order made, and runs a read after them. */
const pageStore = (kv: Kv, store: DeviceStore): Kv => {
  const op = <T>(write: string | undefined, apply: () => Promise<T>): Promise<T> => {
    if (store.gone) return new Promise<T>(() => undefined);
    if (store.queue.length === 0 && (write === undefined || !store.behind)) return apply();
    return new Promise<T>((resolve, reject) =>
      store.queue.push({
        write,
        apply,
        settle: (outcome) => void (outcome as Promise<T>).then(resolve, reject),
      }),
    );
  };
  return {
    get: <T>(key: string) => op(undefined, () => kv.get<T>(key)),
    scan: <T>(prefix: string) => op(undefined, () => kv.scan<T>(prefix)),
    put: (key, value) => op(`${short(key)}${marksOf(value)}`, () => kv.put(key, value)),
    delete: (key) => op(`the delete of ${short(key)}`, () => kv.delete(key)),
    batch: (writes, deletes) =>
      op(`a batch of ${writes.map(([key]) => short(key)).join(", ")}`, () =>
        kv.batch(writes, deletes),
      ),
    clear: (prefix) => op(`the clear of ${prefix}`, () => kv.clear(prefix)),
  };
};

/** The oldest write lands, and the reads that waited only for it run. */
const landNext = (store: DeviceStore) => {
  const next = store.queue.shift();
  next?.settle(next.apply());
  while (store.queue[0] !== undefined && store.queue[0].write === undefined) {
    const read = store.queue.shift()!;
    read.settle(read.apply());
  }
};

/** The runtime's end of a direct channel: a socket of its own on rt-1's ModelRuntime, so one receipt per request id across both paths. */
class ModelChannel implements RtcChannel {
  readyState = "connecting";
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  socket: ModelSocket | undefined;
  private readonly runtime: ModelRuntime;
  constructor(runtime: ModelRuntime) {
    this.runtime = runtime;
  }
  /** ICE and DTLS are through: the channel opens. */
  open(): void {
    const socket = this.runtime.factory(RELAY, "") as unknown as ModelSocket;
    socket.readyState = 1;
    socket.onmessage = (event) => this.onmessage?.({ data: event.data });
    socket.onclose = () => this.lost();
    socket.onerror = () => this.lost();
    this.socket = socket;
    this.readyState = "open";
    this.onopen?.();
  }
  private lost(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.onclose?.();
  }
  send(data: string | Uint8Array): void {
    // A ping is binary, and none goes: the channel's silence limit is past every run's clock.
    if (typeof data === "string") this.socket?.send(data);
  }
  close(): void {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.socket?.close();
  }
}

/** RTCPeerConnection for connectDirect: its channel opens when the check says (`ModelChannel.open`), after the offer's answer. */
const modelRtc = (
  runtime: ModelRuntime,
  peers: Array<{ readonly channel: ModelChannel | null }>,
): RtcPeerConstructor =>
  class implements RtcPeer {
    channel: ModelChannel | null = null;
    localDescription: { sdp: string } | null = null;
    connectionState = "new";
    readonly sctp = { maxMessageSize: 64 * 1024 };
    onicecandidate: RtcPeer["onicecandidate"] = null;
    onconnectionstatechange: (() => void) | null = null;
    constructor() {
      peers.push(this);
    }
    createDataChannel(): RtcChannel {
      return (this.channel = new ModelChannel(runtime));
    }
    async createOffer() {
      return { sdp: "v=0 model-offer", type: "offer" };
    }
    async setLocalDescription(description: { readonly sdp?: string }) {
      this.localDescription = { sdp: description.sdp ?? "" };
    }
    async setRemoteDescription() {
      this.connectionState = "connected";
    }
    async addIceCandidate() {}
    close() {
      this.connectionState = "closed";
      this.channel?.close();
    }
  };

interface Paging {
  readonly timers: VirtualTimers;
  readonly restore: () => void;
  /** The clock's first reading: entry times are observed from here. */
  readonly start: number;
  readonly delays: ReadonlyMap<number, number>;
  readonly intervals: ReadonlySet<number>;
  /** rt-1, the computer the chats run on until they move. */
  readonly runtime: ModelRuntime;
  readonly kv: ReturnType<typeof memoryKv>;
  readonly store: DeviceStore;
  readonly cloud: ReturnType<typeof fakeCloud>;
  readonly peers: Array<{ readonly channel: ModelChannel | null }>;
  page: "a" | "b";
  /** Page A holds its Web Lock. */
  owns: boolean;
  /** Cloud's list places the listed chats on rt-2. */
  moved: boolean;
  /** How many posts Cloud had when the chats moved. */
  postsAtMove: number | undefined;
  /** The page's client: page A's, then page B's. */
  client: Client;
  /** Page A's client as its routes hand it to the sender, recording how each call ended (`ends`). */
  seen: Client;
  sender: ChatSender;
  readonly called: Array<string>;
  /** How each send() on page A ended. */
  readonly fates: Record<string, string>;
  /** How page A's client ended each call, as the sender heard it. */
  readonly ends: Record<string, string>;
  readonly answeredHeld: Set<string>;
  readonly delivered: Array<string>;
  readonly finished: Array<string>;
  /** rt-2's receipts: the move carried none of rt-1's. */
  readonly receipts2: Set<string>;
  /** Every run, in the order run: "rt-1 x1", "rt-2 x1". */
  readonly runs: Array<string>;
  /** Calls page B let go as ones that may have run (ACCEPTED_LOSS.mayHaveRun, if no refusal or unsent end says otherwise). */
  readonly dropped: Set<string>;
  /** Calls Cloud cannot carry that page A left in the sender's outbox and in no connection's (ACCEPTED_LOSS.noCloud). */
  readonly noCloudLost: Set<string>;
  readonly violations: Array<string>;
  readonly used: {
    drops: number;
    lost: number;
    channel: number;
    silent: number;
    lock: number;
    move: number;
    behind: number;
    reload: number;
    clock: number;
  };
}

const madeOf = (options: LostOptions, id: string): Made => {
  const made = options.calls.find((c) => c.id === id);
  if (!made) throw new Error(`no call ${id} in this run`);
  return made;
};
const listedChat = (options: LostOptions, chat: unknown) =>
  options.calls.some((c) => c.chat === chat && c.listed);

/**
 * hub.ts resendable, for the client's `resend` and the sender's: within RESEND_OUT_WITHIN_MS, and while Cloud's list
 * places the chat on the runtime it went out to (a chat Cloud does not list: the age alone).
 */
const resendableNow = (s: Paging, options: LostOptions, runtime: string, entry: OutboxEntry) =>
  runtime === RT1 &&
  Date.now() - entry.at <= RESEND_OUT_WITHIN_MS &&
  !(s.moved && listedChat(options, (entry.params as { session_id?: unknown }).session_id));

const endOf = (error: unknown): string =>
  error instanceof CallNotSent
    ? error.reason
    : error instanceof SessionProtocolError
      ? `refused: ${String(error.error.data?.reason)}`
      : error instanceof CallTimeout
        ? "timed out"
        : error instanceof Error
          ? error.message
          : String(error);

const pageClient = (
  s: Paging,
  options: LostOptions,
  outbox: Outbox,
  channel: boolean,
  onRestored?: (
    entry: OutboxEntry,
    outcome: { readonly result: unknown } | { readonly error: Error },
  ) => void,
): Client => {
  const common = {
    socket: s.runtime.factory,
    outbox,
    resend: (entry: OutboxEntry) => resendableNow(s, options, RT1, entry),
    ...(onRestored ? { onRestored } : {}),
  };
  if (!options.direct) return connect(RELAY, s.runtime.token, undefined, common);
  return connectDirect(RELAY, s.runtime.token, undefined, {
    ...common,
    direct: {
      rtc: modelRtc(s.runtime, s.peers),
      iceServers: [],
      network: () => () => undefined,
      silenceMs: CHANNEL_SILENCE_MS,
      enabled: () => channel && s.peers.length === 0,
    },
  });
};

/** Page A's client as the sender sees it, recording how each mutating call ended without delaying the sender's handlers. */
const observed = (s: Paging, client: Client): Client => ({
  ...client,
  call: ((method, params, callOptions) => {
    const answer = client.call(method, params, callOptions);
    const id = (params as { request_id?: unknown }).request_id;
    if (typeof id === "string")
      answer.then(
        () => {
          if (s.page !== "a") return;
          s.ends[id] = "answered";
          if (s.owns) s.answeredHeld.add(id);
        },
        (error: unknown) => void (s.page === "a" && (s.ends[id] = endOf(error))),
      );
    return answer;
  }) as Client["call"],
});

/** rt-1 turns a listed chat's call away once the chat moved, unless it already ran it (its receipt answers). */
const refusing = (s: Paging, options: LostOptions, request: Request) => {
  const id = request.params.request_id;
  return (
    typeof id === "string" &&
    s.moved &&
    listedChat(options, request.params.session_id) &&
    !s.runtime.receipts.has(id)
  );
};
const runOn1 = (s: Paging, id: string) => {
  s.runtime.receipts.set(id, { turn_id: `turn-${id}`, disposition: "started" });
  s.runtime.ran.push(id);
  s.runs.push(`${RT1} ${id}`);
};

const queuedIds = (s: Paging) => [...new Set(s.cloud.posted.map((p) => p.request_id))];
const whereTo = (s: Paging, options: LostOptions, id: string) =>
  s.moved && madeOf(options, id).listed ? RT2 : RT1;

/** Cloud's queue hands a call to the computer its chat runs on now, which runs it once (its own receipts). */
const deliverFromQueue = (s: Paging, options: LostOptions, id: string) => {
  const { chat } = madeOf(options, id);
  s.delivered.push(id);
  s.cloud.delivered(chat, id);
  if (whereTo(s, options, id) === RT2) {
    if (s.receipts2.has(id)) return;
    s.receipts2.add(id);
    s.runs.push(`${RT2} ${id}`);
    return;
  }
  if (!s.runtime.receipts.has(id)) runOn1(s, id);
};
const finishFromQueue = (s: Paging, options: LostOptions, id: string) => {
  s.finished.push(id);
  s.cloud.ran(madeOf(options, id).chat, id);
};

const sendCall = (s: Paging, made: Made) => {
  s.called.push(made.id);
  // As hub.ts routes: rt-1's connection while Cloud lists the chat there (with orCloud) or does not list it (without);
  // Cloud's queue once a listed chat moved (this device has no connection to rt-2 here).
  const route = (): Route =>
    made.listed && s.moved
      ? { via: "cloud" }
      : {
          via: "runtime",
          client: s.seen,
          runtime: RT1,
          epoch: 1,
          ...(made.listed ? { orCloud: true } : {}),
        };
  s.sender
    .send(
      made.chat,
      "turn.submit",
      { session_id: made.chat, request_id: made.id, input: { text: made.id } },
      route(),
      route,
    )
    .then(
      (outcome) => void (s.fates[made.id] = outcome.via),
      (error: unknown) => {
        const fate =
          error instanceof CallNotSent
            ? `CallNotSent ${error.reason}`
            : error instanceof Error
              ? `${error.name}: ${error.message}`
              : String(error);
        s.fates[made.id] = fate;
        const allowed =
          error instanceof CallTimeout ||
          (error instanceof CallNotSent && error.reason === "stale");
        if (!allowed) s.violations.push(`send ${made.id} failed: ${fate}`);
      },
    );
};

/**
 * Page A's document goes and page B loads: A's sockets close under it (none of its handlers runs again, and rt-1 runs
 * nothing it had not run), its timers never fire, the writes it asked of the store land and nothing else it asks does.
 * Late: eleven minutes pass first.
 */
const reload = async (s: Paging, options: LostOptions, late: boolean) => {
  s.used.reload++;
  for (const socket of s.runtime.live()) {
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    s.runtime.drop(socket);
  }
  for (const timer of s.timers.pending()) s.timers.clearTimeout(timer.id);
  s.store.gone = true;
  for (const op of s.store.queue.splice(0)) if (op.write !== undefined) void op.apply();
  await s.timers.settle();
  if (late) s.timers.now += LATE_MS;
  s.page = "b";
  for (const [key, value] of s.kv.data) {
    if (!key.startsWith("outbox/cloud/")) continue;
    const entry = value as OutboxEntry & {
      readonly params: { readonly wentOut?: true; readonly noCloud?: true };
    };
    if (entry.params.noCloud && !s.kv.data.has(`outbox/runtime/${RT1}/${entry.request_id}`))
      s.noCloudLost.add(entry.request_id);
    // ChatSender.resendOne: one marked as having gone out is posted only within RESEND_OUT_WITHIN_MS.
    if (
      entry.params.wentOut &&
      !entry.params.noCloud &&
      Date.now() - entry.at > RESEND_OUT_WITHIN_MS
    )
      s.dropped.add(entry.request_id);
  }
  const pages = onlyPage("b");
  s.client = pageClient(
    s,
    options,
    kvOutbox(s.kv, `runtime/${RT1}`, pages),
    false,
    (entry, outcome) => {
      if (
        "error" in outcome &&
        outcome.error instanceof CallNotSent &&
        outcome.error.reason === "stale"
      )
        s.dropped.add(entry.request_id);
    },
  );
  s.sender = new ChatSender({
    api: s.cloud.api,
    outbox: kvOutbox(s.kv, "cloud", pages),
    retryMs: () => 1_000,
    resendable: (runtime, entry) => {
      const again = resendableNow(s, options, runtime, entry);
      if (!again) s.dropped.add(entry.request_id);
      return again;
    },
  });
};

/** A read of page A's waits in the store (behind its writes). */
const readWaits = (s: Paging) => s.store.queue.some((op) => op.write === undefined);

/** A clock step fires the next timer, never a call's deadline (see the skill: no run lets one run out) nor the pinger. */
const clockable = (s: Paging) => {
  const next = s.timers.pending()[0];
  return (
    next !== undefined && !s.intervals.has(next.id) && s.delays.get(next.id) !== DEFAULT_TIMEOUT_MS
  );
};

interface LostView {
  readonly page: "a" | "b";
  readonly called: ReadonlyArray<string>;
  readonly fates: Record<string, string>;
  readonly ends: Record<string, string>;
  readonly answeredHeld: ReadonlyArray<string>;
  readonly posted: ReadonlyArray<string>;
  readonly postsAtMove: number | null;
  readonly finished: ReadonlyArray<string>;
  readonly runs: ReadonlyArray<string>;
  readonly dropped: ReadonlyArray<string>;
  readonly noCloudLost: ReadonlyArray<string>;
  readonly violations: ReadonlyArray<string>;
  readonly owns: boolean;
  readonly moved: boolean;
  readonly store: ReadonlyArray<string>;
  readonly writes: ReadonlyArray<string>;
}

/** The accepted loss that lets this call never run, if it does: a key of ACCEPTED_LOSS. */
const excuse = (v: LostView, id: string): keyof typeof ACCEPTED_LOSS | undefined => {
  if (v.fates[id] === "CallNotSent stale") return "stale";
  if (
    v.dropped.includes(id) &&
    !["refused: lease_lost", "refused: not_found", "unsent"].includes(v.ends[id] ?? "")
  )
    return "mayHaveRun";
  if (v.noCloudLost.includes(id)) return "noCloud";
  return undefined;
};
const ranSomewhere = (v: LostView, id: string) => v.runs.some((run) => run.endsWith(` ${id}`));

const lostPageSpec = (options: LostOptions): AsyncSpec<Paging, object> => ({
  make: async () => {
    // Past every outbox time this process handed out (client.ts outboxAt keeps one clock for the module), so each
    // system's entry times follow from its own trace.
    const start = outboxAt() + 1;
    const { timers, restore, delays, intervals } = installClock(start);
    const runtime = new ModelRuntime(0);
    const kv = memoryKv();
    const store: DeviceStore = { behind: options.slowStore === "always", gone: false, queue: [] };
    const s = {
      timers,
      restore,
      start,
      delays,
      intervals,
      runtime,
      kv,
      store,
      cloud: fakeCloud(),
      peers: [],
      page: "a",
      owns: true,
      moved: false,
      postsAtMove: undefined,
      called: [],
      fates: {},
      ends: {},
      answeredHeld: new Set(),
      delivered: [],
      finished: [],
      receipts2: new Set(),
      runs: [],
      dropped: new Set(),
      noCloudLost: new Set(),
      violations: [],
      used: {
        drops: 0,
        lost: 0,
        channel: 0,
        silent: 0,
        lock: 0,
        move: 0,
        behind: 0,
        reload: 0,
        clock: 0,
      },
    } as Omit<Paging, "client" | "seen" | "sender"> as Paging;
    const answer = runtime.answer.bind(runtime);
    runtime.answer = (socket, request, how = "ok") => {
      if (how !== "unauthorized" && refusing(s, options, request)) {
        // rt-1 no longer holds the chat: it turns the call away (CHAOS-15) and keeps no receipt.
        socket.requests = socket.requests.filter((r) => r !== request);
        if (how === "lost") return runtime.drop(socket);
        return socket.push({
          id: request.id,
          error: { code: -32010, message: "lease_lost", data: { reason: "lease_lost" } },
        });
      }
      const before = runtime.ran.length;
      answer(socket, request, how);
      if (runtime.ran.length > before) s.runs.push(`${RT1} ${String(request.params.request_id)}`);
    };
    const pages: Pages = { ...onlyPage("a"), owns: () => s.owns };
    const device = pageStore(kv, store);
    s.client = pageClient(s, options, kvOutbox(device, `runtime/${RT1}`, pages), true);
    s.seen = observed(s, s.client);
    s.sender = new ChatSender({
      api: s.cloud.api,
      outbox: kvOutbox(device, "cloud", pages),
      retryMs: () => 1_000,
      resendable: (rt, entry) => resendableNow(s, options, rt, entry),
    });
    await timers.settle();
    // The relay is open before the person sends, and with connectDirect so is the channel.
    const relay = runtime.connecting();
    if (!relay) throw new Error("no relay socket");
    runtime.open(relay);
    await timers.settle();
    if (options.direct) {
      const offer = relay.requests.find((r) => r.method === "direct.offer");
      if (!offer) throw new Error("no direct.offer on the relay");
      runtime.answer(relay, offer);
      await timers.settle();
      s.peers[0]?.channel?.open();
      await timers.settle();
      if (pathOf(s.client) !== "direct") throw new Error("the direct channel did not come up");
    }
    return s;
  },
  actions: (s) => {
    const step = (name: string, run: () => void | Promise<unknown>): Action<Paging> => ({
      name,
      run: async () => {
        await run();
        await s.timers.settle();
      },
    });
    const actions: Array<Action<Paging>> = [];
    const channel = s.page === "a" ? s.peers[0]?.channel?.socket : undefined;
    for (const one of runtimeSteps(s.runtime, {
      drops: true,
      lostAnswers: options.drops && s.used.lost < 1,
    })) {
      if (one.name.startsWith("link drops")) {
        const dies = channel !== undefined && one.name === `link drops (socket ${channel.n})`;
        if (
          dies ? !(options.channelDies && s.used.channel < 1) : !(options.drops && s.used.drops < 1)
        )
          continue;
        actions.push(
          step(dies ? `the direct channel dies (socket ${channel.n})` : one.name, () => {
            if (dies) s.used.channel++;
            else s.used.drops++;
            one.run();
          }),
        );
      } else if (one.name.endsWith("the answer is lost"))
        actions.push(
          step(one.name, () => {
            s.used.lost++;
            one.run();
          }),
        );
      else actions.push(step(one.name, one.run));
    }
    if (options.silent && s.used.silent < 1)
      for (const socket of s.runtime.live()) {
        const first =
          socket.readyState === 1
            ? socket.requests.find((r) => typeof r.params?.request_id === "string")
            : undefined;
        if (!first || refusing(s, options, first)) continue;
        actions.push(
          step(`runtime runs ${describe(first)} and answers nothing (socket ${socket.n})`, () => {
            s.used.silent++;
            socket.requests = socket.requests.filter((r) => r !== first);
            const id = String(first.params.request_id);
            if (!s.runtime.receipts.has(id)) runOn1(s, id);
          }),
        );
      }
    const made = s.page === "a" ? options.calls.find((c) => !s.called.includes(c.id)) : undefined;
    if (made)
      actions.push(
        step(
          `send turn.submit ${made.id} (${made.chat}${made.listed ? "" : ", Cloud cannot carry it"})`,
          () => sendCall(s, made),
        ),
      );
    const landing = s.store.queue[0]?.write;
    if (landing !== undefined)
      actions.push(step(`the device store writes ${landing}`, () => landNext(s.store)));
    if (options.slowStore === "step" && s.page === "a" && !s.store.behind)
      actions.push(
        step("the device store falls behind (each write lands as a step from now on)", () => {
          s.used.behind++;
          s.store.behind = true;
        }),
      );
    const running = s.delivered.find((id) => !s.finished.includes(id));
    if (running !== undefined)
      actions.push(
        step(`the runtime posts ${running}'s result to Cloud`, () =>
          finishFromQueue(s, options, running),
        ),
      );
    const queuedNext =
      running === undefined ? queuedIds(s).find((id) => !s.delivered.includes(id)) : undefined;
    if (queuedNext !== undefined)
      actions.push(
        step(`Cloud's queue delivers ${queuedNext} to ${whereTo(s, options, queuedNext)}`, () =>
          deliverFromQueue(s, options, queuedNext),
        ),
      );
    if (s.page === "a" && s.owns)
      actions.push(
        step("the page loses its lock", () => {
          s.used.lock++;
          s.owns = false;
        }),
      );
    if (options.moves && !s.moved && options.calls.some((c) => c.listed))
      actions.push(
        step(
          `the chat moves to ${RT2} (Cloud's list places it there; ${RT1} turns its calls away)`,
          () => {
            s.used.move++;
            s.moved = true;
            s.postsAtMove = s.cloud.posted.length;
          },
        ),
      );
    if (options.reloadSteps && s.page === "a" && (options.cutsRewrite === true || !readWaits(s))) {
      actions.push(step("the page reloads", () => reload(s, options, false)));
      if (options.lateReload)
        actions.push(step("the page reloads eleven minutes later", () => reload(s, options, true)));
    }
    if (s.used.clock < options.clock && clockable(s))
      actions.push(step(CLOCK, () => (s.used.clock++, s.timers.advanceToNext())));
    return actions;
  },
  observe: (s): object => ({
    page: s.page,
    owns: s.owns,
    moved: s.moved,
    postsAtMove: s.postsAtMove ?? null,
    called: [...s.called],
    fates: { ...s.fates },
    ends: { ...s.ends },
    answeredHeld: [...s.answeredHeld].sort(),
    posted: s.cloud.posted.map((p) => p.request_id),
    delivered: [...s.delivered],
    finished: [...s.finished],
    runs: [...s.runs],
    dropped: [...s.dropped].sort(),
    noCloudLost: [...s.noCloudLost].sort(),
    violations: [...s.violations],
    store: [...s.kv.data.entries()]
      .map(([key, value]) => {
        const kept = value as OutboxEntry & { readonly page?: string };
        return `${short(key)} at ${kept.at - s.start} page ${String(kept.page)}${marksOf(value)}`;
      })
      .sort(),
    writes: s.store.queue.map((op) => op.write ?? "a read"),
    behind: s.store.behind,
    runtime: s.runtime.snapshot(),
    receipts2: [...s.receipts2].sort(),
    timers: s.timers
      .pending()
      .filter((timer) => !s.intervals.has(timer.id))
      .map((timer) => timer.at - s.timers.now),
    used: { ...s.used },
  }),
  invariants: {
    [ENDS_ALLOWED]: (o) => (o as LostView).violations.length === 0,
    [ONE_WAY_HELD]: (o) =>
      (o as LostView).answeredHeld.every((id) => !(o as LostView).posted.includes(id)),
    [NEVER_TWICE]: (o) => {
      const v = o as LostView;
      return v.called.every((id) => {
        if (!v.runs.includes(`${RT1} ${id}`) || !v.runs.includes(`${RT2} ${id}`)) return true;
        // ACCEPTED_TWICE: Cloud had it before the chat moved.
        const first = v.posted.indexOf(id);
        return v.postsAtMove !== null && first >= 0 && first < v.postsAtMove;
      });
    },
    [MADE_ORDER]: (o) => {
      const v = o as LostView;
      const first: Array<string> = [];
      for (const run of v.runs) {
        const id = run.slice(run.indexOf(" ") + 1);
        if (!first.includes(id)) first.push(id);
      }
      const made = options.calls.map((c) => c.id);
      return first.every((id, i) =>
        first
          .slice(0, i)
          .every(
            (before) =>
              madeOf(options, before).chat !== madeOf(options, id).chat ||
              made.indexOf(before) < made.indexOf(id),
          ),
      );
    },
  },
  eventually: {
    // Page B is there: from every state the drain reloads, so what page B does with page A's outboxes is judged even
    // where every call ran already (a call page A ran must not run again from page B).
    [DELIVERED]: (o) => {
      const v = o as LostView;
      return (
        v.page === "b" &&
        v.called.every((id) => ranSomewhere(v, id) || excuse(v, id) !== undefined) &&
        v.posted.every((id) => v.finished.includes(id))
      );
    },
  },
  // One fair round: the page reloads (at once) if it has not, a connecting socket opens, rt-1 answers every request,
  // Cloud's queue hands over what it holds and each result is posted; with nothing of that left, the clock moves.
  drain: async (s) => {
    const did: Array<string> = [];
    if (s.page === "a") {
      // Unless the run takes finding 13's trigger, the store first lands what stands before a read of page A's, as the
      // reload step waits for; the writes still waiting then land with the reload, page A seeing none of them.
      if (options.cutsRewrite !== true && readWaits(s)) {
        while (readWaits(s)) {
          landNext(s.store);
          await s.timers.settle();
        }
        did.push("the device store lands what page A reads after");
      }
      await reload(s, options, false);
      did.push("the page reloads");
    }
    const connecting = s.runtime.connecting();
    if (connecting) {
      s.runtime.open(connecting);
      did.push("socket opens");
    }
    for (const socket of s.runtime.live()) {
      for (const request of [...socket.requests]) {
        s.runtime.answer(socket, request);
        did.push(`runtime answers ${describe(request)}`);
      }
    }
    for (const id of queuedIds(s).filter((id) => !s.finished.includes(id))) {
      if (!s.delivered.includes(id)) deliverFromQueue(s, options, id);
      finishFromQueue(s, options, id);
      did.push(
        `Cloud's queue delivers ${id} to ${whereTo(s, options, id)}, which posts its result`,
      );
    }
    const next = s.timers.pending()[0];
    if (
      did.length === 0 &&
      next !== undefined &&
      !s.intervals.has(next.id) &&
      (await s.timers.advanceToNext())
    )
      did.push("clock");
    await s.timers.settle();
    return did;
  },
  drainRounds: 20,
  maxStates: 400_000,
  dispose: (s) => s.restore(),
});

const showPaging = (o: object) => {
  const v = o as LostView;
  const excused = v.called
    .filter((id) => !ranSomewhere(v, id) && excuse(v, id) !== undefined)
    .map((id) => `${id}: ${excuse(v, id)}`);
  return [
    `page ${v.page}${v.page === "a" && !v.owns ? " (lock lost)" : ""}${v.moved ? " · moved" : ""}`,
    `sends ${JSON.stringify(v.fates)} · ends ${JSON.stringify(v.ends)}`,
    `ran ${v.runs.join(", ") || "-"} · queued in Cloud ${v.posted.join(",") || "-"}`,
    `store ${v.store.join("; ") || "-"}${v.writes.length ? ` · writing ${v.writes.join("; ")}` : ""}`,
    ...(v.dropped.length ? [`dropped as may have run ${v.dropped.join(",")}`] : []),
    ...(excused.length ? [`excused ${excused.join(", ")}`] : []),
    ...(v.violations.length ? [v.violations.join("; ")] : []),
  ].join(" · ");
};

const checkLost = async (name: string, options: LostOptions): Promise<Verdict<object>> => {
  const label = `${name} [${FULL ? "full" : "default"} bound]`;
  const began = Date.now();
  const verdict: Verdict<object> = await checkAsync(lostPageSpec(options));
  const took = `${((Date.now() - began) / 1000).toFixed(1)} s`;
  if (verdict.ok)
    console.log(
      `${label}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}, ${took}`,
    );
  else
    console.log(
      `${label}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states, ${took})\n${formatTrace(verdict.trace, showPaging)}`,
    );
  return verdict;
};
const runLost = async (name: string, options: LostOptions) =>
  assertHolds(await checkLost(name, options), { show: showPaging });
const lostBound = (small: Partial<LostOptions>): Partial<LostOptions> => (FULL ? {} : small);

const ONE_CHAT: ReadonlyArray<Made> = [
  { id: "r1", chat: "s1", listed: true },
  { id: "r2", chat: "s1", listed: true },
];
const TWO_LISTED: ReadonlyArray<Made> = [
  { id: "y1", chat: "s1", listed: true },
  { id: "x1", chat: "s2", listed: true },
];
const ONE_UNLISTED: ReadonlyArray<Made> = [
  { id: "y1", chat: "s1", listed: true },
  { id: "x1", chat: "s2", listed: false },
  { id: "x2", chat: "s2", listed: false },
];

// One chat on the relay: the lost page's marks (sender.ts: a call let go unanswered keeps its mark, a refused or
// never-sent one loses it, at once) and the ten-minute rule across the reload.
test(
  "chat sender when its page loses its lock, its chat moves and it reloads: no call runs twice, each chat's calls run in order, and every call runs unless its loss is an accepted one",
  { timeout: 1_800_000 },
  () =>
    runLost("chat sender (lost page, relay)", {
      calls: ONE_CHAT,
      direct: false,
      drops: true,
      channelDies: false,
      silent: true,
      slowStore: "step",
      moves: true,
      reloadSteps: true,
      lateReload: true,
      clock: 3,
      ...lostBound({
        silent: false,
        slowStore: "never",
        reloadSteps: false,
        lateReload: false,
        clock: 2,
      }),
    }),
);

// Two chats Cloud lists, on a laptop's direct channel, the store behind: a call can wait in the channel client's lane
// behind the other chat's mark while the page loses its lock (direct.ts: the channel's outbox answers as the page's).
test(
  "chat sender over a direct channel, two listed chats, when its page loses its lock while the store is behind: no call runs twice and every call runs unless its loss is an accepted one",
  { timeout: 1_800_000 },
  () =>
    runLost("chat sender (lost page, direct, two listed chats)", {
      calls: TWO_LISTED,
      direct: true,
      drops: false,
      channelDies: true,
      silent: false,
      slowStore: "always",
      moves: true,
      reloadSteps: true,
      lateReload: false,
      clock: 1,
      ...lostBound({ channelDies: false, reloadSteps: false, clock: 0 }),
    }),
);

// A listed chat and one Cloud does not list, on the direct channel, the store behind: the unlisted chat's calls are not
// held behind each other in the sender, so two can be in rt-1's outbox at once, and one the dying channel hands to the
// relay must keep its place there (direct.ts issue: `|| c.sent` on a lost page; the time it was made, `madeAt`).
test(
  "chat sender over a direct channel, a listed and an unlisted chat, when the channel dies and its page loses its lock: each chat's calls run in the order made",
  { timeout: 1_800_000 },
  () =>
    runLost("chat sender (lost page, direct, an unlisted chat)", {
      calls: ONE_UNLISTED,
      direct: true,
      drops: false,
      channelDies: true,
      silent: false,
      slowStore: "always",
      moves: true,
      reloadSteps: true,
      lateReload: false,
      clock: 1,
      ...lostBound({ moves: false, reloadSteps: false, clock: 0 }),
    }),
);

// FINDING 13 (open): a page that lost its lock rewrites a later mark only after it reads the entry back (outbox.ts put:
// under the outbox's lock, only while the store still has it under its name). A page that goes while that read waits
// behind its earlier writes (the store behind) never writes the mark, so a call rt-1 refused keeps the mark of one that
// may have run, and the page loaded anew drops it once its chat moved: it runs nowhere. The accepted loss of a
// later mark covers only a page that "cannot get that lock". The verified runs keep this trigger out (`cutsRewrite`).
test(
  "FINDING 13: a lost page that reloads while its rewrite reads the store back loses a refused call's new mark, and the call",
  { timeout: 600_000 },
  async () =>
    expectFinding(
      await checkLost("chat sender (finding 13: the reload cuts a lost page's rewrite)", {
        calls: ONE_CHAT,
        direct: false,
        drops: false,
        channelDies: false,
        silent: false,
        slowStore: "step",
        moves: true,
        reloadSteps: false,
        lateReload: false,
        cutsRewrite: true,
        clock: 0,
      }),
      {
        kind: "eventually",
        property: DELIVERED,
        steps: [
          "the device store falls behind",
          "the page loses its lock",
          "runtime answers turn.submit r1",
          "the page reloads",
        ],
        shows: /"r1":"refused: lease_lost".*dropped as may have run r1/,
      },
      showPaging,
    ),
);
