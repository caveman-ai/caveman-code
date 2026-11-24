/**
 * ClientScrub - what the T3 `/ws` API (ws.ts) sends a client, scrubbed of every
 * repository's secret values, as Session Protocol scrubs the same reads: a
 * value never comes back from an API (16-SECRETS). The event store, the
 * projections and terminal history keep raw output; a read is scrubbed on its
 * way out, with the scrubber of that moment.
 *
 * Live output (a command row, a terminal) goes through a following stream
 * (session-protocol/secrets.ts), which holds back a tail that could begin a
 * value until more output says whether it does. Once output pauses, the held
 * tail goes out anyway, as Session Protocol's terminals and tool.watch send it.
 *
 * Spec: docs/
 *
 * @module ClientScrub
 */
import type {
  OrchestrationV2CommandOutputFrame,
  TerminalAttachStreamEvent,
  TerminalEvent,
} from "@caveman-app/protocol";
import type { Scrubber } from "@caveman-app/session-protocol";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { followingStream, makeCommandOutputScrub, maskCut } from "../session-protocol/secrets.ts";

/** A mask the scrubber writes, `[secret:NAME]` or `[secret:A,B]`. */
const NAMED_MASK = /\[secret:[^\]]+\]/g;
const UNNAMED_MASK = "[secret]";

/**
 * `text` with every secret value masked, never longer than it was. Its schema may bound it, and it met that bound
 * (a failure message cut at 4096, a search snippet at 240): one character past it and the wire encoder fails the whole
 * read. A mask that names a short value is longer than the value, but every value the scrubber matches is at least as
 * long as `[secret]`, so where the names do not fit the masks lose theirs, from the last one back. No text is cut.
 */
function scrubWithin(scrubber: Scrubber, text: string): string {
  const masked = maskCut(scrubber, text);
  let over = masked.length - text.length;
  if (over <= 0) return masked;
  const masks = [...masked.matchAll(NAMED_MASK)];
  const unnamed = new Set<number>();
  for (let i = masks.length - 1; i >= 0 && over > 0; i--) {
    unnamed.add(masks[i]!.index);
    over -= masks[i]![0].length - UNNAMED_MASK.length;
  }
  return masked.replace(NAMED_MASK, (mask, at: number) => (unnamed.has(at) ? UNNAMED_MASK : mask));
}

/**
 * `value` with every repository's secret values masked in each string it holds, keys included, as Session Protocol's
 * replays are (scrubDeep), a value a cut fell inside included (maskCut), each string no longer than it was
 * (scrubWithin). Only arrays and plain objects are walked, so a decoded value keeps its DateTimes for the wire
 * encoder. A part with nothing to mask comes back as the same object, not a copy.
 */
export function scrubForClient<A>(scrubber: Scrubber, value: A): A {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return scrubWithin(scrubber, v);
    if (Array.isArray(v)) {
      const out = v.map(walk);
      return out.some((x, i) => x !== v[i]) ? out : v;
    }
    if (v === null || typeof v !== "object") return v;
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return v;
    const entries = Object.entries(v);
    const out = entries.map(([key, x]) => [scrubWithin(scrubber, key), walk(x)] as const);
    return out.some(([key, x], i) => key !== entries[i]![0] || x !== entries[i]![1])
      ? Object.fromEntries(out)
      : v;
  };
  return walk(value) as A;
}

const textViews = new WeakMap<Scrubber, (text: string) => string>();

/**
 * One stored text as scrubForClient sends it, for a read that answers about text without sending it (a thread find
 * counts its matches on this). The same function for the same scrubber, so a find's cached scan is reused until a
 * secret is set.
 */
export function textForClient(scrubber: Scrubber): (text: string) => string {
  let view = textViews.get(scrubber);
  if (view === undefined) textViews.set(scrubber, (view = (text) => scrubWithin(scrubber, text)));
  return view;
}

/** How long live output may pause before a held-back tail goes out (an echo, a prompt): Session Protocol's TERMINAL_FLUSH_MS. */
export const LIVE_OUTPUT_FLUSH_MS = 30;

/** A live stream's scrub: what each batch from the source becomes, and what waits once the source pauses. */
export interface LiveScrub<A> {
  readonly push: (batch: Arr.NonEmptyReadonlyArray<A>) => ReadonlyArray<A>;
  /** Something pushed since the last idle may still be held back. */
  readonly pending: () => boolean;
  readonly idle: () => ReadonlyArray<A>;
}

/**
 * `source` through the scrub `make` builds, which follows the current scrubber (a secret set mid-stream). When the
 * source has been quiet for LIVE_OUTPUT_FLUSH_MS while something may be held, what the scrub holds goes out. The
 * source is pulled in a fiber of its own that a pause does not interrupt, so the pause loses none of its output.
 */
const liveScrubbed = <A, E, R>(
  source: Stream.Stream<A, E, R>,
  scrubber: Effect.Effect<Scrubber>,
  make: (current: () => Scrubber) => LiveScrub<A>,
): Stream.Stream<A, E, R> =>
  Stream.transformPull(source, (pull, scope) =>
    Effect.gen(function* () {
      let latest = yield* scrubber;
      const scrub = make(() => latest);
      const follow = Effect.map(scrubber, (current) => {
        latest = current;
      });
      let next: Fiber.Fiber<Arr.NonEmptyReadonlyArray<A>, Effect.Error<typeof pull>> | undefined;
      return Effect.gen(function* () {
        while (true) {
          next ??= yield* Effect.forkIn(pull, scope);
          if (
            scrub.pending() &&
            Option.isNone(yield* Effect.timeoutOption(Fiber.await(next), LIVE_OUTPUT_FLUSH_MS))
          ) {
            yield* follow;
            const held = scrub.idle();
            if (Arr.isReadonlyArrayNonEmpty(held)) return held;
            continue;
          }
          const batch = yield* Fiber.join(next);
          next = undefined;
          yield* follow;
          const out = scrub.push(batch);
          if (Arr.isReadonlyArrayNonEmpty(out)) return out;
        }
      });
    }),
  );

/**
 * One command row's live frames (CommandOutputHub), scrubbed with one following stream (makeCommandOutputScrub). The
 * tail it holds back while the command runs goes out once the row has been quiet for LIVE_OUTPUT_FLUSH_MS, so a
 * command that prints a line and then works quietly shows that line now, not at its next one.
 */
export const scrubCommandOutput = <E, R>(
  frames: Stream.Stream<OrchestrationV2CommandOutputFrame, E, R>,
  scrubber: Effect.Effect<Scrubber>,
): Stream.Stream<OrchestrationV2CommandOutputFrame, E, R> =>
  liveScrubbed(frames, scrubber, commandOutputScrub);

/** scrubCommandOutput's scrub, step by step (the secret-containment check drives it). */
export const commandOutputScrub = (
  current: () => Scrubber,
): LiveScrub<OrchestrationV2CommandOutputFrame> => {
  const scrub = makeCommandOutputScrub(current);
  /** The last frame, while its command still runs and the scrub may hold its tail. */
  let running: OrchestrationV2CommandOutputFrame | undefined;
  return {
    push: (batch) =>
      batch.map((frame) => {
        running = frame.running ? frame : undefined;
        return scrub(frame);
      }),
    pending: () => running !== undefined,
    idle: () => {
      const last = running!;
      running = undefined;
      const text = scrub.idle();
      return text === "" ? [] : [{ ...last, kind: "append", text }];
    },
  };
};

export type TerminalStreamEvent = TerminalEvent | TerminalAttachStreamEvent;

interface ScrubbedTerminal {
  readonly threadId: string;
  readonly terminalId: string;
  readonly stream: ReturnType<typeof followingStream>;
}

/**
 * Terminal events (one terminal's attach or observe, or every terminal's) scrubbed with a following stream per
 * terminal, as Session Protocol's terminals are. A snapshot starts its terminal's stream with the history, so a value
 * the history ends inside is still caught by the output that completes it. An exit or a close sends what the stream
 * held, masked if it could be a value's start; a clear or a restart starts the stream over. Once output pauses for
 * LIVE_OUTPUT_FLUSH_MS, what a stream holds goes out as that terminal's output.
 */
export const scrubTerminalEvents = <A extends TerminalStreamEvent, E, R>(
  events: Stream.Stream<A, E, R>,
  scrubber: Effect.Effect<Scrubber>,
): Stream.Stream<A, E, R> =>
  // Each event keeps its type, and an added one is output, which both event unions have.
  liveScrubbed(
    events,
    scrubber,
    terminalEventsScrub as unknown as (current: () => Scrubber) => LiveScrub<A>,
  );

/** Every terminal's events, as TerminalManager.subscribe hands them to a listener until stopped. */
export type TerminalEventSource = (
  listener: (event: TerminalEvent) => Effect.Effect<void>,
) => Effect.Effect<() => void>;

/**
 * Every terminal's events scrubbed once, as they happen, for every client that follows all terminals
 * (`subscribeTerminalEvents`), as Session Protocol scrubs each terminal once for every connection. Such a client gets
 * no snapshot, so a scrub of its own would start at whatever output it saw first, and the rest of a value two reads
 * split would go out raw. This one has followed each terminal since the scope began. A listener gets what is
 * scrubbed after it subscribes.
 */
export const sharedTerminalEvents = (
  subscribe: TerminalEventSource,
  scrubber: Effect.Effect<Scrubber>,
): Effect.Effect<TerminalEventSource, never, Scope.Scope> =>
  Effect.gen(function* () {
    const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
    const events = yield* Queue.unbounded<TerminalEvent>();
    yield* Effect.acquireRelease(
      subscribe((event) => Queue.offer(events, event).pipe(Effect.asVoid)),
      (stop) => Effect.sync(stop),
    );
    yield* scrubTerminalEvents(Stream.fromQueue(events), scrubber).pipe(
      Stream.runForEach((event) =>
        Effect.forEach(
          [...listeners],
          (listener) => listener(event).pipe(Effect.ignoreCause({ log: true })),
          {
            discard: true,
          },
        ),
      ),
      Effect.forkScoped,
    );
    return (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      });
  });

/** scrubTerminalEvents's scrub, step by step (the secret-containment check drives it). */
export const terminalEventsScrub = (current: () => Scrubber): LiveScrub<TerminalStreamEvent> => {
  const terminals = new Map<string, ScrubbedTerminal>();
  /** Terminals that took output since the last idle. */
  const waiting = new Set<ScrubbedTerminal>();
  const keyOf = (threadId: string, terminalId: string) => `${threadId}\u0000${terminalId}`;
  const start = (threadId: string, terminalId: string) => {
    const previous = terminals.get(keyOf(threadId, terminalId));
    if (previous !== undefined) waiting.delete(previous);
    const terminal = { threadId, terminalId, stream: followingStream(current) };
    terminals.set(keyOf(threadId, terminalId), terminal);
    return terminal;
  };
  /** Text a stream held, sent on its own: no `sequence`, since it is no new terminal event but the rest of one sent. */
  const output = (terminal: ScrubbedTerminal, data: string): ReadonlyArray<TerminalStreamEvent> =>
    data === ""
      ? []
      : [{ type: "output", threadId: terminal.threadId, terminalId: terminal.terminalId, data }];
  /** What the terminal's stream held, before the event that ends it. */
  const end = (event: Extract<TerminalStreamEvent, { type: "exited" | "closed" }>) => {
    const terminal = terminals.get(keyOf(event.threadId, event.terminalId));
    if (terminal === undefined) return [event];
    waiting.delete(terminal);
    if (event.type === "closed") terminals.delete(keyOf(event.threadId, event.terminalId));
    return [...output(terminal, terminal.stream.end()), event];
  };
  const scrub = (event: TerminalStreamEvent): ReadonlyArray<TerminalStreamEvent> => {
    switch (event.type) {
      case "snapshot":
      case "started":
      case "restarted": {
        const terminal = start(event.snapshot.threadId, event.snapshot.terminalId);
        waiting.add(terminal);
        return [
          {
            ...event,
            snapshot: { ...event.snapshot, history: terminal.stream.push(event.snapshot.history) },
          },
        ];
      }
      case "output": {
        const terminal =
          terminals.get(keyOf(event.threadId, event.terminalId)) ??
          start(event.threadId, event.terminalId);
        waiting.add(terminal);
        // An event whose text is all held still goes out, empty, so its sequence leaves no gap.
        return [{ ...event, data: terminal.stream.push(event.data) }];
      }
      case "cleared":
        start(event.threadId, event.terminalId);
        return [event];
      case "exited":
      case "closed":
        return end(event);
      default:
        return [event];
    }
  };
  return {
    push: (batch) => batch.flatMap(scrub),
    pending: () => waiting.size > 0,
    idle: () => {
      const held = [...waiting].flatMap((terminal) => output(terminal, terminal.stream.idle()));
      waiting.clear();
      return held;
    },
  };
};
