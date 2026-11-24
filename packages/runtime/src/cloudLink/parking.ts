// Parking a Cloud computer on Cloud's word (CONTRACT §5.1 and SPEC §7.3 of docs/;
// the protocol is formal/NothingLost.tla's Announce, Park, StopAcked and Wake). Cloud names a stop in the heartbeat
// reply before it takes the computer down. From then on no turn of a person's starts here (their message waits in
// Cloud's queue), each running turn stops at its next tool boundary, never inside a tool, every chat is copied to
// Cloud whole, and only then the heartbeat says `parked: <stop id>`. A stop Cloud calls off (`stop: null`) and a
// computer that woke are one case: the turns a park stopped carry on, told what already ran. A tool that outlives the
// stop's deadline is never cut by this runtime: Cloud takes the computer down unacknowledged, and the turn is picked
// up after the wake as after any crash. No tool starts once a stop stands: the gate before each tool holds it until
// the turn is stopped, or the stop is called off.
//
// This file is the loop and what "a tool runs" means; what parks, copies and resumes a chat is the session layer's
// (session-protocol/handlers.ts), which hands it in.
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";

import type { Lifecycle, Stop } from "./lifecycle.ts";

/** How often the loop looks while a stop stands or turns are owed (a heartbeat reply that changes the stop wakes it at once). */
export const PARK_LOOK_MS = 1_000;
/** Chats parked at once. */
const PARK_AT_ONCE = 4;

/** A journaled event as far as a tool boundary needs it. */
export interface TurnMark {
  readonly type: string;
  readonly item_id?: string | null | undefined;
}

/**
 * Whether a tool of the chat's open turn runs now, from the turn's events in order: one started with no end. A tool
 * waiting on the person's permission has not run, so a turn held at an ask stands at a boundary; so does one that ended.
 * `held`: the tools the gate before each tool is holding (session-protocol/handlers.ts): shown as started, none of
 * them has run, and none will while the stop stands.
 */
export function toolRuns(
  turn: ReadonlyArray<TurnMark>,
  held: ReadonlySet<string> = new Set(),
): boolean {
  const open = new Set<string>();
  const asks = new Set<string>();
  for (const event of turn) {
    const id = event.item_id ?? "";
    if (event.type === "turn.done") return false;
    if (event.type === "tool.started" && held.has(id)) continue;
    if (event.type === "tool.started") open.add(id);
    else if (event.type === "tool.done") open.delete(id);
    else if (event.type === "ask.user") asks.add(id);
    else if (event.type === "ask.resolved") asks.delete(id);
  }
  return open.size > 0 && asks.size === 0;
}

export interface ParkingInput {
  /** The chats that live on this computer. */
  readonly chats: Effect.Effect<ReadonlyArray<string>>;
  /**
   * One chat parked for `stop`: no turn of it runs (one that ran was stopped at its next tool boundary) and Cloud's copy
   * holds all of it, its files and turn checkpoints too. False: not yet (a tool still runs, its copy did not land).
   * `wanted` says whether the stop still stands: a park waiting on a tool gives up once it does not.
   */
  readonly park: (sessionId: string, stop: Stop, wanted: () => boolean) => Effect.Effect<boolean>;
  /** Whether every chat here is still as its park left it (none at work, each copy at its head): asked once a look after `parked` was said. */
  readonly quiet: Effect.Effect<boolean>;
  /** The turns a park stopped carry on. True once none is owed. */
  readonly resume: Effect.Effect<boolean>;
  /** Something that is no chat works here (a hosted automation run): never cut by a stop this runtime acknowledged. */
  readonly working: () => boolean;
  /** Every heartbeat names this stop as parked from now on, the first at once; undefined: none does. */
  readonly say: (stopId: string | undefined) => void;
  readonly log: (message: string) => Effect.Effect<void>;
  readonly lookMs?: number;
}

export interface Parking {
  /** A stop stands: no turn of a person's starts here until it is gone. */
  readonly stopping: () => boolean;
  /** Cloud's word, from a heartbeat reply (the link's onLifecycle). */
  readonly heard: (lifecycle: Lifecycle) => void;
  /** The loop, for the runtime's life. */
  readonly run: Effect.Effect<never>;
}

export const makeParking = (input: ParkingInput): Parking => {
  // undefined: Cloud has not answered a heartbeat since this runtime started, so what it wants is not known yet.
  let stop: Stop | null | undefined;
  // The stop `parked` was said for.
  let said: string | undefined;
  // Turns a park stopped may wait to carry on: a runtime that starts looks once (it may have parked before it went down).
  let owed = true;
  let poked = Deferred.makeUnsafe<void>();
  const sleep = Effect.raceFirst(
    Effect.sleep(input.lookMs ?? PARK_LOOK_MS),
    Effect.suspend(() => Deferred.await(poked)),
  ).pipe(Effect.andThen(Effect.sync(() => void (poked = Deferred.makeUnsafe<void>()))));

  const look = Effect.gen(function* () {
    const want = stop;
    if (want === undefined) return;
    if (want === null) {
      if (said !== undefined) {
        said = undefined;
        input.say(undefined);
      }
      if (owed) owed = !(yield* input.resume);
      return;
    }
    owed = true;
    const wanted = () => stop !== null && stop !== undefined && stop.id === want.id;
    // Parked and said so: looked at again only once something moved (a turn the runtime itself started, a late event).
    if (said === want.id && (yield* input.quiet)) return;
    const parked = yield* Effect.forEach(
      yield* input.chats,
      (sessionId) => input.park(sessionId, want, wanted),
      { concurrency: PARK_AT_ONCE },
    );
    if (!wanted() || said === want.id || parked.some((done) => !done) || input.working()) return;
    said = want.id;
    input.say(want.id);
    yield* input.log(
      `parking: every chat here is parked and copied; Caveman Cloud hears parked for its ${want.reason} stop ${want.id}`,
    );
  });

  return {
    stopping: () => stop !== null && stop !== undefined,
    heard: (lifecycle) => {
      const changed = stop === undefined || (stop?.id ?? null) !== (lifecycle.stop?.id ?? null);
      stop = lifecycle.stop;
      if (changed) Deferred.doneUnsafe(poked, Exit.void);
    },
    run: look.pipe(
      Effect.catchCause((cause) => input.log(`parking: a look failed: ${Cause.pretty(cause)}`)),
      Effect.andThen(sleep),
      Effect.forever,
    ) as Effect.Effect<never>,
  };
};
