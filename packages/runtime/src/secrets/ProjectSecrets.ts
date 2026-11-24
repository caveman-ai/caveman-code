/**
 * ProjectSecrets - a repository's environment secrets: the `.env` a user
 * pasted, imported or typed into a secret card. They belong to the
 * repository, not to this computer: every method is keyed by the repository
 * key (`repositoryKey`: `host/owner/name` from the checkout's origin, the key
 * Caveman Cloud stores them under, or `local:<realpath>` without one), so a
 * session that moves between computers finds the same names.
 *
 * Values go in through `set` and come out only through `resolve`, which the
 * broker uses to inject them into the processes the runtime starts. Clients
 * see names (`list`), never values.
 *
 * `scrubber` covers every stored value of every repository: a value must not
 * reach a model or a transcript from any session, not only its own
 * repository's.
 *
 * Spec: docs/
 *
 * @module ProjectSecrets
 */
import { SECRET_NAME_PATTERN, type Repo, type SecretEntry, type SecretInfo, type Scrubber } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

export class ProjectSecretsError extends Schema.TaggedError<ProjectSecretsError>()("ProjectSecretsError", {
  message: Schema.String,
  /**
   * `origin_changed`: keyOf withheld a checkout whose origin now names
   * another repository than the one it was pinned to (repin accepts it).
   * `not_a_repository`: keyOf got a path outside git or a URL it cannot key.
   */
  reason: Schema.optional(Schema.Literals(["origin_changed", "not_a_repository"])),
}) {}

export interface SecretsChanged {
  /** The repository key. */
  readonly repository: string;
  readonly names: ReadonlyArray<string>;
}

export class ProjectSecrets extends Context.Service<
  ProjectSecrets,
  {
    /**
     * The repository key for a Session Protocol Repo: a URL normalized with
     * `repositoryKey`; a path's git top level, by its `origin` remote when it
     * has one, else `local:<realpath>`. Fails for a path that is not a git
     * repository.
     */
    readonly keyOf: (repo: Repo) => Effect.Effect<string, ProjectSecretsError>;
    /**
     * A checkout's key is pinned at its first use; keyOf fails with
     * `origin_changed` once the origin names another repository. The person
     * accepts the new one here (secret.repin). Returns the new key.
     */
    readonly repin: (repo: Repo) => Effect.Effect<string, ProjectSecretsError>;
    readonly list: (repository: string) => Effect.Effect<ReadonlyArray<SecretInfo>, ProjectSecretsError>;
    readonly set: (
      repository: string,
      entries: ReadonlyArray<{ readonly name: string; readonly value: Redacted.Redacted<string> }>,
    ) => Effect.Effect<ReadonlyArray<SecretInfo>, ProjectSecretsError>;
    readonly remove: (repository: string, name: string) => Effect.Effect<void, ProjectSecretsError>;
    /** Plaintext, for the broker only: env for a process it starts. Never send this to a client. */
    readonly resolve: (repository: string) => Effect.Effect<ReadonlyArray<SecretEntry>, ProjectSecretsError>;
    /** Whether the repository has any secret; engines must route through the egress scrub when it does. */
    readonly has: (repository: string) => Effect.Effect<boolean, ProjectSecretsError>;
    /** Scrubs every value of every repository; rebuilt on each change. */
    readonly scrubber: Effect.Effect<Scrubber>;
    readonly changes: Stream.Stream<SecretsChanged>;
  }
>()("caveman/secrets/ProjectSecrets") {}

/**
 * The environment variable an agent's request_secret label names: the label
 * itself when it is one (`STRIPE_SECRET_KEY`), else its words upper-snake-cased
 * (`GitHub webhook secret` -> `GITHUB_WEBHOOK_SECRET`).
 */
export const secretNameFor = (label: string): string => {
  const trimmed = label.trim();
  if (SECRET_NAME_PATTERN.test(trimmed)) return trimmed;
  const name = trimmed.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[A-Z_]/.test(name) ? name : `SECRET_${name}`;
};
