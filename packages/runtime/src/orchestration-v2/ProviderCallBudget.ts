import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/**
 * A provider that stays up but stops answering never settles a call: Claude's control requests
 * and Codex's JSON-RPC requests settle only on an answer or when the process ends. Each provider
 * call a thread's effect waits on runs within a budget well past its slowest real answer, and
 * fails with this error once it runs out, so the caller's own failure handling records the
 * outcome on the thread instead of the thread's effects waiting for good.
 */
export class ProviderUnresponsiveError extends Schema.TaggedError<ProviderUnresponsiveError>()(
  "ProviderUnresponsiveError",
  {
    operation: Schema.String,
    budget: Schema.String,
  },
) {
  override get message(): string {
    return `The provider stopped answering: ${this.operation} got no reply within ${this.budget}.`;
  }
}

/** An interrupt, a steer, a runtime request's answer or a subagent stop: answered in seconds. */
export const PROVIDER_CONTROL_BUDGET = Duration.minutes(1);
/** A session open, a thread load or a turn start, which may install an agent or wait on a sign-in. */
export const PROVIDER_START_BUDGET = Duration.minutes(20);

/** Why the runtime ends a session whose provider stopped answering. */
export const PROVIDER_UNRESPONSIVE_DETAIL = "The provider stopped answering.";

export const withinProviderBudget =
  (operation: string, budget: Duration.Duration) =>
  <A, E, R>(call: Effect.Effect<A, E, R>): Effect.Effect<A, E | ProviderUnresponsiveError, R> =>
    call.pipe(
      Effect.timeoutOrElse({
        duration: budget,
        orElse: () =>
          Effect.fail(
            new ProviderUnresponsiveError({ operation, budget: Duration.format(budget) }),
          ),
      }),
    );

/** Whether a failure, or a cause it wraps, is a provider call that ran out of its budget. */
export const isProviderUnresponsive = (error: unknown): boolean =>
  Predicate.isTagged(error, "ProviderUnresponsiveError") ||
  (Predicate.hasProperty(error, "cause") && isProviderUnresponsive(error.cause));
