// When the Caveman engine's modules load. provider-caveman imports them on first use rather than at the runtime's
// start (its engine.ts, Caveman Cloud the spec addendum 2026-10-24); the server starts this once it listens so a first
// turn finds them loaded, without putting them back in front of what a start, or a wake's first turn, waits on.
import { loadCavemanEngine } from "@caveman-app/provider-caveman/server";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as CloudLink from "./cloudLink/index.ts";
import { markStartup } from "./startupTrace.ts";

/** How often a Cloud computer's runtime looks whether its link is up. */
const LINK_LOOK_MS = 100;
/** How long after its relay connected a Cloud computer's runtime loads the engine: past the start of the turn a wake brings. */
const AFTER_LINK_MS = 20_000;

/**
 * Loads the engine: on This Mac, and on a warm pod waiting for its claim, at once. On a Cloud computer with its
 * identity, 20 s after its relay connected, and never before it did: loading the engine while the relay dialled put up
 * to 1.5 s into the link, and loading it as the relay connected put as much into the first turn, because a woken
 * computer is handed the message that woke it as its link comes on, and a new one its first chat. The import holds the
 * runtime's one thread for 1.2 to 1.5 s under gVisor (0.4 s on a VM), and that stood between the message and its
 * turn. A Caveman chat's turn that comes first imports the engine itself, as its first use does. A link not up
 * within a minute does not hold the load longer.
 */
export const loadCavemanEngineAfterStart = (load: () => Promise<unknown> = loadCavemanEngine, afterLinkMs = AFTER_LINK_MS) =>
  Effect.gen(function* () {
    const computer = yield* CloudLink.CloudComputer;
    if (computer !== undefined && computer.computerId !== "") {
      const link = yield* CloudLink.CloudLinkState;
      const up = yield* Effect.repeat(
        Effect.sync(() => link.connected?.() === true),
        { until: (up) => up, schedule: Schedule.spaced(LINK_LOOK_MS) },
      ).pipe(Effect.timeoutOption("1 minute"));
      if (Option.isSome(up)) yield* Effect.sleep(afterLinkMs);
    }
    yield* Effect.tryPromise(load).pipe(
      Effect.andThen(Effect.sync(() => markStartup("Caveman engine loaded"))),
      // A chat's first turn then fails with the same cause.
      Effect.catchCause((cause) => Effect.logError("The Caveman engine could not be loaded", cause)),
    );
  });
