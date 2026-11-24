/**
 * EgressRoute - the runtime's project-secrets egress scrub as an engine sees
 * it: a loopback base URL that forwards a model provider's traffic with every
 * secret value replaced by `[secret:NAME]`. An engine whose model calls the
 * runtime cannot point at it must not run against a repository with secrets.
 *
 * Absent from the context: the host runs no scrub and keeps no secrets.
 *
 * @module EgressRoute
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export class EgressRoute extends Context.Service<
  EgressRoute,
  {
    /** The scrubbed base URL for `upstream`; undefined when the scrub is not running. */
    readonly route: (upstream: string) => string | undefined;
    /** Whether `url` is already one of the scrub's routes (never route a route). */
    readonly owns: (url: string) => boolean;
    /**
     * Whether the repository checked out at `cwd` has secrets. Fails when the
     * store cannot tell (a locked keychain): callers refuse, as for `true`.
     */
    readonly hasSecrets: (cwd: string) => Effect.Effect<boolean, unknown>;
  }
>()("@caveman-app/engine-core/server/EgressRoute") {}
