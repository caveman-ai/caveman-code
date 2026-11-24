// Where the Caveman adapter finds the Chief's profile (engine-core ChiefSessions). The adapter
// is built with the engine registry, before the Session Protocol route that owns the Chief:
// the route binds the Chief here once its handlers exist. A session that opens before that
// waits for it, and fails if it never comes: it never opens as a coding session by default.
import * as ChiefSessions from "@caveman-app/engine-core/server/ChiefSessions";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** How long a session that opens before the route waits for it. */
export const BIND_WAIT_MS = 30_000;

type Profile = ChiefSessions.ChiefSessions["Service"]["profile"];

export class ChiefHost extends Context.Service<
  ChiefHost,
  {
    readonly profile: Profile;
    /** The route's Chief; the last bind wins. */
    readonly bind: (profile: Profile) => Effect.Effect<void>;
  }
>()("caveman/chief/ChiefHost") {}

/** One host for the adapter (ChiefSessions) and the route (ChiefHost): provide this same value to both. */
export const layer = Layer.effectContext(
  Effect.gen(function* () {
    let bound: Profile | undefined;
    const ready = yield* Deferred.make<Profile>();
    const profile: Profile = (threadId) =>
      bound !== undefined
        ? bound(threadId)
        : Deferred.await(ready).pipe(
            Effect.timeoutOrElse({ duration: `${BIND_WAIT_MS} millis`, orElse: () => Effect.fail(new Error("the Chief's host is not up yet")) }),
            Effect.flatMap((next) => next(threadId)),
          );
    const host = ChiefHost.of({
      profile,
      bind: (next) => Effect.sync(() => void (bound = next)).pipe(Effect.andThen(Deferred.succeed(ready, next)), Effect.asVoid),
    });
    return Context.make(ChiefHost, host).pipe(Context.add(ChiefSessions.ChiefSessions, ChiefSessions.ChiefSessions.of({ profile })));
  }),
);
