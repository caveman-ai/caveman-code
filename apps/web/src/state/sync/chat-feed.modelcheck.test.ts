// Bounded model checks of one open chat's feed: the real ChatFeed, TranscriptCache (over memoryKv) and the real
// Session Protocol client (connect() through the session-protocol package's ModelRuntime), with fakeCloud's copy route
// behind a gate so each copy page answers when the checker says. The steps are the hub's calls into the feed
// (hub.ts route/reroute: use, copyAdvanced, retryNow, close) and the runtime's, network's and clock's.
// Run: pnpm --filter @caveman-app/web exec vitest run src/state/sync/chat-feed.modelcheck.test.ts (CLIENT_DELIVERY_FULL=1 for
// the larger bound; see `bound` below and .claude/skills/client-delivery/SKILL.md).
import {
  assertHolds,
  canonicalKey,
  checkAsync,
  formatTrace,
  GateQueue,
  type Action,
  type AsyncSpec,
  type Verdict,
  type VirtualTimers,
} from "@caveman-app/model-check";
import { connect, type AttachOptions, type Client } from "@caveman-app/session-protocol/client";
import type { SessionEvent } from "@caveman-app/session-protocol";
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
} from "../../../../../packages/session-protocol/test/modelRuntime.ts";
import { expect, test } from "vitest";
import { ChatFeed, type FeedState } from "./chat-feed.ts";
import type { CopyPage } from "./wire.ts";
import { fakeCloud } from "./fakes.test-support.ts";
import { memoryKv } from "./kv.ts";
import { TranscriptCache } from "./transcript-cache.ts";

const CLOCK = "clock: fire the next timer";
const COPY_ANSWERS = "Cloud's copy answers a page";

// The promise in plain words: each is the exact name a verdict reports.
const CONTIGUOUS = "the view gets cursors 1..n of one epoch, with a reset between epochs";
const ONE_SUBSCRIPTION = "the feed holds at most one subscription";
const CACHE_PREFIX = "the cache holds a gap-free prefix of one epoch";
const SETTLES =
  "a closed feed lets go of its subscription; an open one catches up with its source and says so";

/** Subscriptions the feed holds on the client: attach() resolved, and neither detached nor ended since. */
interface Held {
  live: number;
  attaching: number;
}

/** The real client, counting what the feed holds of it. Everything else passes straight through. */
const counting = (real: Client, held: Held): Client => ({
  call: real.call,
  on: real.on,
  close: real.close,
  hello: real.hello,
  onHello: real.onHello,
  attach: async (session, cursor, onEvent, attachOptions) => {
    const options: AttachOptions =
      typeof attachOptions === "function" ? { onError: attachOptions } : (attachOptions ?? {});
    let state: "attaching" | "live" | "gone" = "attaching";
    const gone = () => {
      if (state === "live") held.live--;
      state = "gone";
    };
    held.attaching++;
    try {
      const sub = await real.attach(session, cursor, onEvent, {
        ...options,
        onError: (error) => (gone(), options.onError?.(error)),
      });
      if (state === "attaching") {
        state = "live";
        held.live++;
      }
      return {
        session: sub.session,
        cursor: sub.cursor,
        epoch: () => sub.epoch?.(),
        detach: () => (gone(), sub.detach()),
      };
    } finally {
      held.attaching--;
    }
  },
});

interface Feed {
  readonly timers: VirtualTimers;
  readonly nextDelay: () => number | undefined;
  readonly restore: () => void;
  readonly runtime: ModelRuntime;
  readonly client: Client;
  /** A second connection to the runtime, made when the list moves the chat to it (finding 4's second trigger). */
  other: Client | null;
  readonly cloud: ReturnType<typeof fakeCloud>;
  readonly kv: ReturnType<typeof memoryKv>;
  readonly gates: GateQueue;
  readonly feed: ChatFeed;
  /** What the sink was handed: `e<epoch>.<cursor>` or `reset <epoch>`. */
  readonly log: Array<string>;
  state: FeedState["kind"];
  source: "runtime" | "copy";
  closed: boolean;
  readonly held: Held;
  /** The epoch Cloud's list names for the chat (epochHint). */
  listEpoch: number;
  /** Cloud's copy as it stands (fakeCloud keeps no getter). */
  copyNow: { epoch: number; through: number };
  /** Cloud's copy as the hub last told the feed of it (openFeed, then each copyAdvanced): what the copy source must reach. */
  announced: { epoch: number; through: number };
  /** Which page the next released copy read gets: the one Cloud read when asked (the answer was in flight), or now. */
  copyTiming: "asked" | "now";
  readonly used: {
    switches: number;
    commits: number;
    rewrites: number;
    copySyncs: number;
    refusals: number;
    listChanges: number;
    drops: number;
    clock: number;
  };
}

/** The transcript cache as stored: its index entry and every event in its pages, or what is wrong with the layout. */
const cached = (
  kv: ReturnType<typeof memoryKv>,
): { epoch: number; through: number; events: Array<string> } | null | string => {
  const index = (kv.data.get("tx/index") ?? {}) as Record<
    string,
    { epoch: number; through: number }
  >;
  const entry = index[SESSION];
  const pages = [...kv.data.entries()]
    .filter(([key]) => key.startsWith(`tx/${SESSION}/p/`))
    .sort(([a], [b]) => (a < b ? -1 : 1));
  if (!entry)
    return pages.length === 0
      ? null
      : `pages without an index entry: ${pages.map(([k]) => k).join(", ")}`;
  const foreign = pages.filter(([key]) => !key.startsWith(`tx/${SESSION}/p/${entry.epoch}/`));
  if (foreign.length > 0)
    return `pages of another epoch than ${entry.epoch}: ${foreign.map(([k]) => k).join(", ")}`;
  return {
    epoch: entry.epoch,
    through: entry.through,
    events: pages.flatMap(([, page]) => (page as Array<SessionEvent>).map(tag)),
  };
};

/** TranscriptCache's promise read off what is stored: null when it holds. */
const cacheProblem = (cache: ReturnType<typeof cached>): string | null => {
  if (cache === null || typeof cache === "string") return cache;
  const prefix = Array.from({ length: cache.through }, (_, i) => `e${cache.epoch}.${i + 1}`);
  return canonicalKey(cache.events) === canonicalKey(prefix)
    ? null
    : `index says epoch ${cache.epoch} through ${cache.through}, pages hold ${cache.events.join(" ")}`;
};

interface Options {
  /** Steps of a refused subscription: the runtime ends it (lease_lost), adopts the chat again, and the list changes. */
  readonly refusals: boolean;
  /** With refusals: the feed has Cloud's copy and reads it while refused (ended()), as hub.openFeed gives it with Cloud. */
  readonly copyFill: boolean;
  /**
   * The hub may call retryNow while an attach is in flight: the retry timer's, or use()'s when reroute moved the chat
   * to another connection and then saw the list's new seq (hub.ts reroute: route, then retryNow). Finding 4's trigger.
   */
  readonly retryDuringAttach: boolean;
  /** The hub may switch to Cloud's copy while an older copy read still waits for its page: finding 5's trigger. */
  readonly copyDuringRead: boolean;
  /**
   * When the runtime handles a session.detach. server.ts takes a socket's attaches and detaches of one chat in arrival
   * order (laneOf's attach lane), so an attach and a detach never finish out of the order they were sent. "prompt": the
   * detach as soon as it is next, before anything else. "late": a detach waits as a step of its own while other steps
   * happen (finding 2b, fixed).
   */
  readonly detach: "prompt" | "late";
  /** With refusals: the journal may be rewritten too. */
  readonly rewrites: boolean;
  /** Source switches after hub.openFeed routed the feed to the runtime (copy, runtime, ...). */
  readonly switches: number;
  /**
   * Check only these properties (default: all). A finding run uses it to look past the first property a trace breaks
   * to a later harm on the same path, never to make a verified run pass.
   */
  readonly only?: ReadonlyArray<string>;
  /** "stepwise": each frame's arrival is a step of its own (modelRuntime.ts). Default "settle". */
  readonly frames?: "settle" | "stepwise";
  /** Link drops the run may take (default 0: the pooled connection stays up). The client reconnects on a clock step. */
  readonly drops?: number;
  /** Times Cloud's copy may catch up with the runtime (default 1). */
  readonly copySyncs?: number;
  /** Commits the runtime may make (default 1). */
  readonly commits?: number;
  /** With refusals: times the hub may hear of a list change (retryNow; default 1). */
  readonly listChanges?: number;
  /** Clock steps the run may take (default 3 with refusals, else 2). The drain moves the clock as well. */
  readonly clock?: number;
}

/**
 * ChatFeed's own fields that decide what it does next and show nowhere else in the observation, so two states that
 * differ only there are not merged. `generation` is left out: it only counts up, and what matters is which work in
 * flight still holds the current one, which no field says. A renamed field fails here instead of going unread.
 */
const internals = (feed: ChatFeed) => {
  const fields = feed as unknown as {
    cursor: number;
    epoch?: number;
    attempts: number;
    copyReading: boolean;
    copyAgain: boolean;
    pendingCache: Array<SessionEvent>;
  };
  for (const name of ["cursor", "attempts", "copyReading", "copyAgain", "pendingCache"] as const) {
    if (fields[name] === undefined)
      throw new Error(
        `ChatFeed has no field ${name}: update internals() in chat-feed.modelcheck.test.ts`,
      );
  }
  const { cursor, epoch, attempts, copyReading, copyAgain, pendingCache } = fields;
  return {
    cursor,
    epoch: epoch ?? null,
    attempts,
    copyReading,
    copyAgain,
    pendingCache: pendingCache.map(tag),
  };
};

/** A request of `method` sent before `request` on its socket and not answered yet. */
const before = (runtime: ModelRuntime, request: Request, method: string) =>
  runtime.sockets.some(
    (socket) =>
      socket.requests.includes(request) &&
      socket.requests.some((r) => r.method === method && r.id < request.id),
  );

/**
 * Whether the runtime may answer `request` now as a step of its own (prompt detaches are answered by settleFeed). An
 * attach and a detach go in the order sent, as laneOf's attach lane takes them; two attaches may still go either way.
 */
const answerable = (runtime: ModelRuntime, request: Request, detach: Options["detach"]) => {
  if (abandoned(request)) return false;
  if (request.method === "session.detach")
    return detach === "late" && !before(runtime, request, "session.attach");
  if (request.method === "session.attach") return !before(runtime, request, "session.detach");
  return true;
};

/** Answers one detach that "prompt" has the runtime handle now; true when it did. */
const promptDetaches = (runtime: ModelRuntime, detach: Options["detach"]): boolean => {
  if (detach === "late") return false;
  for (const socket of runtime.live()) {
    const request = socket.requests.find(
      (r) => r.method === "session.detach" && !before(runtime, r, "session.attach"),
    );
    if (request) {
      runtime.answer(socket, request);
      return true;
    }
  }
  return false;
};

const settleFeed = async (f: Pick<Feed, "timers" | "runtime">, detach: Options["detach"]) => {
  await f.timers.settle();
  while (promptDetaches(f.runtime, detach)) await f.timers.settle();
};

/** The properties a run checks (Options.only). */
const checked = (options: Options, properties: Record<string, (o: object) => boolean>) =>
  options.only === undefined
    ? properties
    : Object.fromEntries(
        Object.entries(properties).filter(([name]) => options.only!.includes(name)),
      );

/** Cloud's copy becomes the runtime's journal as it is now. */
const setCopy = (f: Feed) => {
  f.cloud.copy(SESSION, f.runtime.epoch, f.runtime.journal.slice());
  f.copyNow = { epoch: f.runtime.epoch, through: f.runtime.journal.length };
};

const feedSpec = (options: Options): AsyncSpec<Feed, object> => ({
  make: async () => {
    const { timers, nextDelay, restore } = installClock();
    const runtime = new ModelRuntime(2, { frames: options.frames ?? "settle" });
    const kv = memoryKv();
    const cache = new TranscriptCache(kv);
    await cache.append(SESSION, 1, runtime.journal.slice(0, 1));
    const cloud = fakeCloud();
    cloud.copy(SESSION, 1, runtime.journal.slice());
    const copyNow = { epoch: 1, through: runtime.journal.length };
    const gates = new GateQueue();
    const held: Held = { live: 0, attaching: 0 };
    const client = counting(
      connect("wss://relay.test/rt-1", runtime.token, undefined, { socket: runtime.factory }),
      held,
    );
    // The pool's connection is open; reconnects are the client check's.
    await timers.settle();
    runtime.open(runtime.connecting()!);
    const log: Array<string> = [];
    const sys = {
      timers,
      nextDelay,
      restore,
      runtime,
      client,
      other: null,
      cloud,
      kv,
      gates,
      log,
      held,
      listEpoch: 1,
      copyNow,
      announced: { ...copyNow },
      copyTiming: "now",
      state: "loading",
      source: "runtime",
      closed: false,
    } as Omit<Feed, "feed" | "used">;
    // GET /code/chats/{id}/events: Cloud reads its copy when the request arrives, and the answer reaches the device
    // later. The checker picks the page as Cloud read it when asked (the answer was in flight across later steps) or as
    // it reads now (the request was).
    const copy = (epoch: number, after: number) => {
      const asked = cloud.api.events(SESSION, epoch, after);
      asked.catch(() => undefined);
      return new Promise<CopyPage>(
        (resolve) =>
          void gates.parkUnsafe(COPY_ANSWERS, () =>
            resolve(sys.copyTiming === "asked" ? asked : cloud.api.events(SESSION, epoch, after)),
          ),
      );
    };
    const feed = new ChatFeed({
      sessionId: SESSION,
      sink: {
        reset: (epoch) => void log.push(`reset ${epoch}`),
        apply: (event) => void log.push(tag(event)),
      },
      ...(options.refusals && !options.copyFill ? {} : { copy }),
      epochHint: () => sys.listEpoch,
      cache,
      onState: (state) => (sys.state = state.kind),
      retryMs: () => 2_000,
      cacheEveryMs: 1_000,
    });
    const system: Feed = Object.assign(sys, {
      feed,
      used: {
        switches: 0,
        commits: 0,
        rewrites: 0,
        copySyncs: 0,
        refusals: 0,
        listChanges: 0,
        drops: 0,
        clock: 0,
      },
    });
    // hub.openFeed routes the feed at once: here, to the runtime that holds the chat.
    feed.use({ kind: "runtime", runtimeId: "rt-1", client });
    system.source = "runtime";
    await settleFeed(system, options.detach);
    return system;
  },
  actions: (f) => {
    const step = (name: string, run: () => void | Promise<unknown>): Action<Feed> => ({
      name,
      run: async () => {
        await run();
        await settleFeed(f, options.detach);
      },
    });
    const actions: Array<Action<Feed>> = runtimeSteps(f.runtime, {
      drops: f.used.drops < (options.drops ?? 0),
      answers: (request) => answerable(f.runtime, request, options.detach),
    }).map((one) =>
      step(one.name, () => {
        if (one.name.startsWith("link drops")) f.used.drops++;
        one.run();
      }),
    );
    // Closing is the last thing the hub does to a feed: what follows is only the drain, which must let go.
    if (f.closed) return [];
    if (f.gates.parked().length > 0) {
      for (const timing of ["asked", "now"] as const) {
        actions.push(
          step(`${COPY_ANSWERS} it read ${timing === "asked" ? "when asked" : "now"}`, () => {
            f.copyTiming = timing;
            f.gates.release(COPY_ANSWERS);
          }),
        );
      }
    }
    if (!f.closed) {
      const switches = options.switches;
      if (f.used.switches < switches && f.source !== "runtime")
        actions.push(
          step("hub: read from the runtime", () => {
            f.used.switches++;
            f.source = "runtime";
            f.feed.use({ kind: "runtime", runtimeId: "rt-1", client: f.client });
          }),
        );
      if (
        f.used.switches < switches &&
        f.source !== "copy" &&
        (options.copyDuringRead || f.gates.parked().length === 0)
      )
        actions.push(
          step("hub: read Cloud's copy", () => {
            f.used.switches++;
            f.source = "copy";
            f.feed.use({ kind: "copy" });
          }),
        );
      if (f.used.copySyncs < (options.copySyncs ?? 1) && (!options.refusals || options.copyFill))
        actions.push(
          step("Cloud's copy catches up with the runtime (hub: copyAdvanced)", () => {
            f.used.copySyncs++;
            setCopy(f);
            f.listEpoch = f.runtime.epoch;
            f.announced = { ...f.copyNow };
            f.feed.copyAdvanced();
          }),
        );
      actions.push(step("hub: the feed closes", () => ((f.closed = true), f.feed.close())));
    }
    if (f.used.commits < (options.commits ?? 1))
      actions.push(
        step(
          `runtime commits e${f.runtime.epoch}.${f.runtime.journal.length + 1}`,
          () => (f.used.commits++, f.runtime.commit()),
        ),
      );
    // A synced chat's new epoch comes from Cloud before the runtime rewrites its journal (handlers.ts rebuildFromCopy
    // and bumpHeld call BumpEpoch first; an adopted move takes the index's epoch), and a rebuild is Cloud's copy: Cloud's
    // copy never lags the runtime's epoch.
    if (f.used.rewrites < 1 && (!options.refusals || options.rewrites))
      actions.push(
        step(`journal rewritten as epoch ${f.runtime.epoch + 1} with 1 event`, () => {
          f.used.rewrites++;
          f.runtime.rewrite(1);
          setCopy(f);
        }),
      );
    if (options.refusals) {
      if (f.used.refusals < 1 && f.runtime.moving === null)
        actions.push(
          step("runtime ends the subscription: lease_lost (the chat is moving)", () => {
            f.used.refusals++;
            f.runtime.moving = "lease_lost";
            f.runtime.end("lease_lost");
          }),
        );
      if (f.runtime.moving !== null)
        actions.push(
          step("the runtime adopts the chat again", () => void (f.runtime.moving = null)),
        );
      if (!f.closed && f.used.listChanges < (options.listChanges ?? 1)) {
        if (options.retryDuringAttach || f.held.attaching === 0)
          actions.push(
            step(
              "hub: the list changed the chat (retryNow)",
              () => (f.used.listChanges++, f.feed.retryNow()),
            ),
          );
        if (options.retryDuringAttach)
          actions.push(
            step(
              "hub: the list moved the chat to another connection (use it, then retryNow)",
              () => {
                f.used.listChanges++;
                f.other ??= counting(
                  connect("wss://relay.test/rt-1?second", f.runtime.token, undefined, {
                    socket: f.runtime.factory,
                  }),
                  f.held,
                );
                f.feed.use({ kind: "runtime", runtimeId: "rt-1", client: f.other });
                f.feed.retryNow();
              },
            ),
          );
      }
    }
    // Attach deadlines are the client check's (client.modelcheck.test.ts): here the runtime answers attaches in time.
    if (
      f.used.clock < (options.clock ?? (options.refusals ? 3 : 2)) &&
      f.timers.nextAt() !== undefined &&
      f.nextDelay() !== ATTACH_DEADLINE_MS
    )
      actions.push(step(CLOCK, () => (f.used.clock++, f.timers.advanceToNext())));
    return actions;
  },
  observe: (f) => ({
    log: [...f.log],
    state: f.state,
    source: f.source,
    closed: f.closed,
    held: { ...f.held },
    cache: cached(f.kv),
    copy: { list: f.listEpoch, ...f.copyNow, announced: { ...f.announced } },
    parked: f.gates.parked(),
    runtime: f.runtime.snapshot(),
    timers: f.timers.pending().map((timer) => timer.at - f.timers.now),
    used: { ...f.used },
    internals: internals(f.feed),
  }),
  invariants: checked(options, {
    [CONTIGUOUS]: (o) => contiguityBreak((o as FeedView).log) === null,
    [ONE_SUBSCRIPTION]: (o) => (o as FeedView).held.live <= 1,
    [CACHE_PREFIX]: (o) => cacheProblem((o as FeedView).cache) === null,
  }),
  eventually: checked(options, {
    [SETTLES]: (o) => {
      const v = o as FeedView;
      if (v.closed)
        return v.held.live === 0 && v.runtime.sockets.every((socket) => socket.attached === null);
      const at = position(v.log);
      if (v.source === "runtime" && v.runtime.moving === null)
        return (
          v.state === "live" &&
          at.cursor === v.runtime.journal &&
          (at.epoch === undefined || at.epoch === v.runtime.epoch)
        );
      if (v.source === "runtime") return v.state === "ended";
      // On Cloud's copy: no page out, and the view holds at least what the hub last said the copy holds (a later epoch counts).
      const { announced } = v.copy;
      const reached =
        at.epoch !== undefined &&
        (at.epoch > announced.epoch ||
          (at.epoch === announced.epoch && at.cursor >= announced.through));
      return v.state === "copy" && v.parked.length === 0 && reached;
    },
  }),
  drain: async (f) => {
    const did: Array<string> = [];
    f.copyTiming = "now";
    for (const gate of f.gates.releaseAll()) did.push(`${gate} it reads now`);
    const connecting = f.runtime.connecting();
    if (connecting) {
      f.runtime.open(connecting);
      did.push("socket opens");
    }
    for (const socket of f.runtime.live()) {
      for (const request of [...socket.requests]) {
        if (!answerable(f.runtime, request, options.detach)) continue;
        f.runtime.answer(socket, request);
        did.push(`runtime answers ${describe(request)}`);
      }
    }
    const arrived = f.runtime.deliverAll();
    if (arrived > 0) did.push(`${arrived} frames arrive`);
    if (did.length === 0 && (await f.timers.advanceToNext())) did.push("clock");
    await settleFeed(f, options.detach);
    return did;
  },
  drainRounds: 20,
  // checkAsync stops at 100,000 by default; the full-bound stepwise run explores more.
  maxStates: 250_000,
  dispose: (f) => f.restore(),
});

interface FeedView {
  readonly copy: {
    readonly list: number;
    readonly epoch: number;
    readonly through: number;
    readonly announced: { readonly epoch: number; readonly through: number };
  };
  readonly log: ReadonlyArray<string>;
  readonly state: FeedState["kind"];
  readonly source: Feed["source"];
  readonly closed: boolean;
  readonly held: Held;
  readonly cache: ReturnType<typeof cached>;
  readonly parked: ReadonlyArray<string>;
  readonly runtime: RuntimeSnapshot;
}

const showFeed = (o: object) => {
  const v = o as FeedView;
  const cache =
    v.cache === null
      ? "none"
      : typeof v.cache === "string"
        ? v.cache
        : `epoch ${v.cache.epoch} through ${v.cache.through}: ${v.cache.events.join(" ")}`;
  const attachments = v.runtime.sockets
    .filter((socket) => socket.attached !== null)
    .map((socket) => `through ${socket.attached}`);
  return (
    `view [${v.log.join(" ")}] state ${v.state} source ${v.source}${v.closed ? " closed" : ""} · held ${v.held.live} (attaching ${v.held.attaching}) · cache ${cache}` +
    ` · runtime epoch ${v.runtime.epoch} head ${v.runtime.journal}${v.runtime.moving ? ` ${v.runtime.moving}` : ""}, attached ${attachments.join(", ") || "nowhere"}` +
    ` · Cloud's copy epoch ${v.copy.epoch} through ${v.copy.through}`
  );
};

const report = (run: string, verdict: Verdict<object>) => {
  const name = `${run} [${FULL ? "full" : "default"} bound]`;
  if (verdict.ok)
    console.log(
      `${name}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}`,
    );
  else
    console.log(
      `${name}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states)\n${formatTrace(verdict.trace, showFeed)}`,
    );
};

const check = async (name: string, options: Options): Promise<Verdict<object>> => {
  const verdict = await checkAsync(feedSpec(options));
  report(name, verdict);
  return verdict;
};
const run = async (name: string, options: Options) =>
  assertHolds(await check(name, options), { show: showFeed });
const verified: Options = {
  refusals: false,
  copyFill: false,
  retryDuringAttach: false,
  copyDuringRead: false,
  detach: "prompt",
  rewrites: false,
  switches: 2,
};
/**
 * The bounds. CLIENT_DELIVERY_FULL=1 (FULL) runs each check with the budgets its options name; unset, as in the
 * package's `vitest run`, `small` cuts them so the file takes seconds.
 */
const bound = (small: Partial<Options>): Partial<Options> => (FULL ? {} : small);

test(
  "chat feed switching sources: cache, runtime and Cloud's copy deliver each event once, and the cache stays a prefix",
  { timeout: 1_800_000 },
  () => run("chat feed switching sources", { ...verified, ...bound({ clock: 0, commits: 0 }) }),
);

test(
  "chat feed refused and retried, also while an attach is out: one subscription at most, back live after the chat is adopted, let go on close",
  { timeout: 1_800_000 },
  () =>
    run("chat feed refused and retried", {
      ...verified,
      refusals: true,
      rewrites: true,
      switches: 0,
      retryDuringAttach: true,
      ...bound({ clock: 1, commits: 0 }),
    }),
);

// The same with Cloud's copy, which the feed reads while refused (finding 7, fixed): a page lands on the epoch it was
// read for or not at all, and never says the view shows the copy. No commits and no retryNow during an attach at either
// bound (the refused run above has both), which keeps the full bound to minutes; by default no copy catch-up either,
// which still reaches both of finding 7's traces.
test(
  "chat feed refused while Cloud's copy fills in: the copy never splices an epoch or says it is shown, and the feed comes back live",
  { timeout: 1_800_000 },
  () =>
    run("chat feed refused, Cloud's copy filling in", {
      ...verified,
      refusals: true,
      copyFill: true,
      rewrites: true,
      switches: 0,
      commits: 0,
      ...bound({ clock: 1, copySyncs: 0 }),
    }),
);

// Back to Cloud's copy while a copy page is still out (finding 5, fixed): copy, runtime, copy takes a third switch. One
// clock step at the full bound, not the switching run's two, keeps it to minutes; by default no copy catch-up either,
// which still reaches finding 5's trace.
test(
  "chat feed switching back to Cloud's copy while a page is out: the copy source is still read to what the hub announced",
  { timeout: 600_000 },
  () =>
    run("chat feed switching sources (back to the copy while a page is out)", {
      ...verified,
      copyDuringRead: true,
      switches: 3,
      clock: 1,
      ...bound({ clock: 0, commits: 0, copySyncs: 0 }),
    }),
);

test(
  "chat feed switching sources across a link drop, each frame arriving as a step of its own",
  { timeout: 3_600_000 },
  () =>
    run("chat feed switching sources (a drop, frames one at a time)", {
      ...verified,
      frames: "stepwise",
      drops: 1,
      copySyncs: 0,
      ...bound({ clock: 0, commits: 0 }),
    }),
);

// Finding 6, fixed: server.ts ran a socket's attaches and detaches side by side, so a detach sent behind a reattach
// could finish first and leave the closed feed's chat attached (6a), or, as the model had it, an attach sent after a
// detach could finish first and lose its attachment to that detach (6b). laneOf now takes a chat's attaches and detaches
// in arrival order. This is both findings' runs with the runtime in order, and the commit 6b's trace took, at both
// bounds (the switching run's default bound has no commit).
test(
  "chat feed letting go while a reattach is out, then attaching again: a closed feed lets go, and a live one hears every commit",
  { timeout: 600_000 },
  () => run("chat feed (a detach behind a reattach)", { ...verified, clock: 0, copySyncs: 0 }),
);

// Finding 2b (client.ts onMessage), fixed: a let-go subscription's runtime attachment lives until its detach is
// handled, and a new attach on the same socket is answered after that. What the old attachment sends meanwhile never
// reaches the new subscription, whose events are only those after its own attach answer.
test(
  "chat feed when a detach is handled late and the feed attaches again meanwhile",
  { timeout: 1_800_000 },
  () =>
    run("chat feed (late detach)", {
      ...verified,
      detach: "late",
      ...bound({ clock: 0, copySyncs: 0 }),
    }),
);

// In order: each frame arrives as a step of its own, and the runtime handles the detach at once. The feed's first
// attach is answered while the hub has it on Cloud's copy; the answer arrives, the feed (stale generation) detaches,
// the hub switches back to the runtime, and the first attachment's backlog and a commit, still on the wire, arrive
// before the new attach's answer. The stepwise run above reaches this at the full bound; this run keeps the old
// counterexample's steps at the default bound, which leaves commits out of that run.
test(
  "chat feed when frames of a let-go attachment are still on the wire",
  { timeout: 600_000 },
  () =>
    run("chat feed (in-flight frames of a let-go attachment)", {
      ...verified,
      frames: "stepwise",
      copySyncs: 0,
      clock: 0,
    }),
);

test("the cache reader sees a splice", () => {
  const kv = memoryKv();
  kv.data.set("tx/index", { [SESSION]: { epoch: 1, through: 2 } });
  kv.data.set(`tx/${SESSION}/p/1/00000000`, [
    { payload: { text: "e1.1" } },
    { payload: { text: "e2.2" } },
  ]);
  expect(cacheProblem(cached(kv))).toMatch(/pages hold e1.1 e2.2/);
});
