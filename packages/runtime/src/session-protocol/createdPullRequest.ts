/**
 * Reading back a pull request the runtime just opened (git.pr, "Add to repo").
 *
 * The host has accepted the create by the time this runs, so a lookup that fails or comes back
 * empty must not be reported as a failed pull request: the host's list can lag the create by a
 * moment, and a list read can fail on its own. The lookup is retried a few times, with its
 * errors swallowed; only when every try misses does the caller hear about it, as a pull request
 * that was opened but not found yet. 
 * created when its lookup fails); our protocol needs the number and URL, so the read retries.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Waits between tries: the first read is immediate, then the host gets up to ~3.5 s to list it. */
const READ_BACK_DELAYS = [Duration.millis(500), Duration.seconds(1), Duration.seconds(2)] as const;

/**
 * The first pull request `lookup` finds, trying again after each delay. `None` when every try
 * missed or failed; lookup failures are logged, never raised.
 */
export const readBackCreatedPullRequest = <A, E, R>(
  lookup: Effect.Effect<A | undefined, E, R>,
): Effect.Effect<Option.Option<A>, never, R> =>
  Effect.gen(function* () {
    const attempt = lookup.pipe(
      Effect.map(Option.fromUndefinedOr),
      Effect.catch((error) =>
        Effect.logWarning("pull request read-back after create failed", { error }).pipe(
          Effect.as(Option.none<A>()),
        ),
      ),
    );
    let found = yield* attempt;
    for (const delay of READ_BACK_DELAYS) {
      if (Option.isSome(found)) break;
      yield* Effect.sleep(delay);
      found = yield* attempt;
    }
    return found;
  });
