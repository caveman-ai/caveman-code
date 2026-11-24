// ), packages/secret-provider-core/src/shared/definition.ts and
// packages/secret-provider-core/src/server/driver.ts @ 97e35bcf23 (#27115). T3 keeps these in a
// package of their own; here they live with the runtime's other secrets machinery.
/**
 * One kind of secret provider (1Password): what clients and the runtime both need to know about
 * it, and the driver that reads the secrets its references name.
 *
 * Unlike upstream driver, a read says why a reference could not be read (`SecretReadFailure`), so
 * Settings can tell a locked vault from a missing item without ever seeing the value.
 *
 * @module secrets/secretProviderDriver
 */
import type { SecretProviderKind } from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Schema from "effect/Schema";

/** Why a secret could not be read. Never carries any part of a value. */
export type SecretReadFailure =
  /** The provider's CLI is not on this computer. */
  | "not_installed"
  /** Not signed in, locked, or the sign-in was refused (a dismissed unlock prompt, a revoked token). */
  | "locked"
  /** The provider answered: no such vault, item or field. */
  | "not_found"
  /** The provider did not answer in time. */
  | "timeout"
  /** Anything else the provider refused. */
  | "failed"
  /** No secret provider by the reference's name, or one of a kind this build cannot read. */
  | "unknown_provider"
  /** The reference is not syntax its provider reads. */
  | "invalid_reference"
  /** A service account provider whose token was never added. */
  | "no_token"
  /** The secret is a Claude Agent credential, which Caveman Code never reads. */
  | "refused";

export interface SecretReadOutcome {
  readonly value?: string;
  readonly failure?: SecretReadFailure;
}

/** What the server gives every driver. A driver builds anything else it needs itself. */
export type SecretProviderDriverServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem;

/** What clients and the server both need to know about one kind of secret provider. */
export interface SecretProviderDefinition<Config = unknown> {
  readonly kind: SecretProviderKind;
  readonly label: string;
  readonly configSchema: Schema.Codec<Config, unknown>;
  /** Whether `reference` is syntax this kind can read. */
  readonly isReference: (reference: string) => boolean;
  readonly referencePlaceholder: string;
  readonly invalidReferenceMessage: string;
}

export const defineSecretProvider = <Config>(
  definition: SecretProviderDefinition<Config>,
): SecretProviderDefinition<Config> => definition;

/** Credentials the runtime holds for one provider entry, attached at read time only. */
export interface SecretProviderAuth {
  /** A service account's token, from the runtime's sealed store. */
  readonly serviceAccountToken?: string;
}

export interface SecretProviderDriver {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition;
  /**
   * Outcomes in input order. `config` has decoded with the definition's `configSchema` and every
   * reference passed its `isReference`.
   */
  readonly read: (
    config: unknown,
    references: ReadonlyArray<string>,
    auth: SecretProviderAuth,
  ) => Effect.Effect<ReadonlyArray<SecretReadOutcome>, never, SecretProviderDriverServices>;
  /** Whether the provider is reachable and signed in, as Settings' check shows it. Reads no secret. */
  readonly check: (
    config: unknown,
    auth: SecretProviderAuth,
  ) => Effect.Effect<
    SecretReadOutcome & { readonly detail?: string },
    never,
    SecretProviderDriverServices
  >;
}

export const defineSecretProviderDriver = <Config>(driver: {
  readonly kind: SecretProviderKind;
  readonly definition: SecretProviderDefinition<Config>;
  readonly read: (
    config: Config,
    references: ReadonlyArray<string>,
    auth: SecretProviderAuth,
  ) => Effect.Effect<ReadonlyArray<SecretReadOutcome>, never, SecretProviderDriverServices>;
  readonly check: (
    config: Config,
    auth: SecretProviderAuth,
  ) => Effect.Effect<
    SecretReadOutcome & { readonly detail?: string },
    never,
    SecretProviderDriverServices
  >;
}): SecretProviderDriver => {
  const isConfig = Schema.is(driver.definition.configSchema);
  return {
    kind: driver.kind,
    definition: driver.definition,
    read: (config, references, auth) =>
      isConfig(config)
        ? driver.read(config, references, auth)
        : Effect.succeed(references.map(() => ({ failure: "unknown_provider" as const }))),
    check: (config, auth) =>
      isConfig(config)
        ? driver.check(config, auth)
        : Effect.succeed({ failure: "unknown_provider" as const }),
  };
};

/** What Settings says about a failure, one line, never naming a value. */
export const secretReadFailureMessage = (
  failure: SecretReadFailure,
  label = "The secret provider",
): string => {
  switch (failure) {
    case "not_installed":
      return `${label}'s command line tool is not installed on this computer.`;
    case "locked":
      return `${label} is locked or not signed in. Unlock it, then refresh.`;
    case "not_found":
      return `${label} has no such vault, item or field.`;
    case "timeout":
      return `${label} did not answer in time.`;
    case "failed":
      return `${label} could not read it.`;
    case "unknown_provider":
      return "No secret provider by that name on this computer.";
    case "invalid_reference":
      return "That is not a reference its secret provider reads.";
    case "no_token":
      return `${label}'s service account has no token yet. Add it in Settings > Secret providers.`;
    case "refused":
      return "Claude Agent runs on your own claude login; Caveman Code never reads its credentials.";
  }
};
