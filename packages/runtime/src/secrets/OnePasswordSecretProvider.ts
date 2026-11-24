// ), packages/secret-provider-onepassword/src/shared/definition.ts and
// packages/secret-provider-onepassword/src/server/driver.ts @ 97e35bcf23 (#27115).
/**
 * 1Password, through its `op` CLI: signed in either by the 1Password app on this computer
 * (`--account`, upstream way; an unlock may prompt with Touch ID) or, Caveman's addition, as a
 * service account whose token the runtime keeps sealed and hands `op` in its environment only
 * (OP_SERVICE_ACCOUNT_TOKEN), never on its command line.
 *
 * A value comes back on `op`'s stdout and goes straight to the caller. Nothing here logs stdout
 * or stderr: a failure is classified from stderr (`op` prints errors there, never a value) and
 * only the class and the exit code are logged.
 *
 * Unlike T3, the separator `op inject` needs comes from node:crypto, so this module does not
 * depend on `effect/Crypto` (which Effect 4.1 replaces).
 *
 * @module secrets/OnePasswordSecretProvider
 */
import { randomUUID } from "node:crypto";

import { spawnAndCollect } from "@caveman-app/engine-core/server/snapshotProbe";
import { withoutRuntimeEnv } from "@caveman-app/engine-core/server/instanceEnvironment";
import { OnePasswordSecretProviderConfig, SecretProviderKind } from "@caveman-app/protocol";
import {
  isOnePasswordReference,
  ONE_PASSWORD_REFERENCE_PLACEHOLDER,
} from "@caveman-app/session-protocol";
import { resolveSpawnCommand } from "@caveman-app/shared/shell";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as ChildProcess from "effect/process/ChildProcess";

import {
  defineSecretProvider,
  defineSecretProviderDriver,
  type SecretProviderAuth,
  type SecretReadFailure,
  type SecretReadOutcome,
} from "./secretProviderDriver.ts";

export const ONE_PASSWORD_KIND = SecretProviderKind.make("one_password");

export const definition = defineSecretProvider({
  kind: ONE_PASSWORD_KIND,
  label: "1Password",
  configSchema: OnePasswordSecretProviderConfig,
  isReference: isOnePasswordReference,
  referencePlaceholder: ONE_PASSWORD_REFERENCE_PLACEHOLDER,
  invalidReferenceMessage: "Use a 1Password reference like op://vault/item/field.",
});

// Bounds a read long enough to reach for a fingerprint reader, short enough not to wedge a rebuild.
const READ_TIMEOUT = Duration.seconds(45);

/** Errors `op` prints when it cannot sign in: no session, a locked or unreachable app, a refused prompt or token. */
const LOCKED =
  /not (?:currently )?signed in|session (?:has )?expired|authoriz|unlock|is locked|invalid (?:service account )?token|unauthori[sz]ed|\b401\b|no accounts? (?:configured|found)|desktop app|biometric|sign ?in/i;
/** Errors `op` prints when it answered but holds no such thing. */
const NOT_FOUND =
  /isn't (?:an item|a vault|a field|in)|could not find|not found|no item|does(?:n't| not) exist|more than one (?:item|vault|field)/i;

/** The class of a failed run, from what `op` printed on stderr. Never logged, never returned. */
export const classifyOnePasswordError = (stderr: string): SecretReadFailure =>
  NOT_FOUND.test(stderr) ? "not_found" : LOCKED.test(stderr) ? "locked" : "failed";

const isNotInstalled = (error: unknown): boolean => {
  const tag = (error as { readonly _tag?: unknown })?._tag;
  if (tag === "ProviderCommandNotFoundError") return true;
  const text = `${String((error as { readonly message?: unknown })?.message ?? "")} ${String(
    (error as { readonly cause?: { readonly code?: unknown } })?.cause?.code ?? "",
  )} ${String((error as { readonly reason?: unknown })?.reason ?? "")}`;
  return /ENOENT|NotFound|not found/i.test(text);
};

export interface OnePasswordDriverOptions {
  /** The `op` binary; tests point it at a fake. */
  readonly binary?: string;
}

/** How `op` signs in for one provider entry: its environment and the `--account` flag, or a missing token. */
const signIn = (
  config: OnePasswordSecretProviderConfig,
  auth: SecretProviderAuth,
):
  | { readonly env: Record<string, string | undefined>; readonly flags: ReadonlyArray<string> }
  | "no_token" => {
  // The runtime's own variables never reach `op`; neither does a service account token from the
  // runtime's environment, which would sign `op` in as someone the settings do not name.
  const base = { ...withoutRuntimeEnv(process.env), OP_SERVICE_ACCOUNT_TOKEN: undefined };
  if (config.serviceAccount === true) {
    if (auth.serviceAccountToken === undefined || auth.serviceAccountToken === "")
      return "no_token";
    return { env: { ...base, OP_SERVICE_ACCOUNT_TOKEN: auth.serviceAccountToken }, flags: [] };
  }
  return { env: base, flags: config.account === undefined ? [] : [`--account=${config.account}`] };
};

export const makeDriver = (options: OnePasswordDriverOptions = {}) => {
  const binary = options.binary ?? "op";

  // `--cache=false` skips the `op daemon`, which hangs on prompts a background server cannot show.
  const run = Effect.fn("OnePasswordDriver.run")(function* (
    args: ReadonlyArray<string>,
    env: Record<string, string | undefined>,
  ) {
    const spawnCommand = yield* resolveSpawnCommand(binary, ["--cache=false", ...args], { env });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        shell: spawnCommand.shell,
        env,
      }),
    );
  });

  // A secret is passed on verbatim; surrounding whitespace can be part of it.
  const nonEmpty = (value: string): SecretReadOutcome =>
    value.trim().length > 0 ? { value } : { failure: "not_found" };

  const readOne = Effect.fn("OnePasswordDriver.readOne")(function* (
    login: {
      readonly env: Record<string, string | undefined>;
      readonly flags: ReadonlyArray<string>;
    },
    reference: string,
  ) {
    const result = yield* run(["read", ...login.flags, "--no-newline", reference], login.env);
    if (result.code !== 0) {
      const failure = classifyOnePasswordError(result.stderr);
      yield* Effect.logWarning("Could not read secret from 1Password", {
        stage: "read",
        exitCode: result.code,
        failure,
      });
      return { failure } satisfies SecretReadOutcome;
    }
    return nonEmpty(result.stdout);
  });

  // One `op inject` costs one unlock for every reference in the template. `op` ignores piped stdin
  // from Node, so the template goes through a temp file; it holds references only, never a value.
  // A random separator after every reference keeps one secret from shifting the others, and leaves
  // any trailing newline outside the values.
  const readTogether = Effect.fn("OnePasswordDriver.readTogether")(function* (
    login: {
      readonly env: Record<string, string | undefined>;
      readonly flags: ReadonlyArray<string>;
    },
    references: ReadonlyArray<string>,
  ) {
    const fileSystem = yield* FileSystem.FileSystem;
    const separator = `__caveman-secret-${randomUUID()}__`;
    const templatePath = yield* fileSystem.makeTempFileScoped({ prefix: "caveman-op-inject-" });
    yield* fileSystem.writeFileString(
      templatePath,
      references.map((reference) => `{{ ${reference} }}${separator}`).join(""),
    );
    const result = yield* run(["inject", ...login.flags, "-i", templatePath], login.env);
    const values = result.stdout.split(separator);
    const trailing = values.pop();
    if (
      result.code !== 0 ||
      values.length !== references.length ||
      trailing === undefined ||
      trailing.trim().length > 0
    ) {
      const failure = result.code !== 0 ? classifyOnePasswordError(result.stderr) : "failed";
      yield* Effect.logWarning("Could not batch-read secrets from 1Password", {
        stage: "inject",
        exitCode: result.code,
        references: references.length,
        failure,
      });
      return { failure } as const;
    }
    return { values: values.map(nonEmpty) } as const;
  }, Effect.scoped);

  /** `None` when 1Password did not answer in time; a run that could not start is a failure outcome. */
  const bounded = <A, E, R>(stage: "read" | "inject" | "whoami", effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.timeoutOption(READ_TIMEOUT),
      Effect.tap((outcome) =>
        Option.isNone(outcome)
          ? Effect.logWarning("1Password did not answer in time", { stage })
          : Effect.void,
      ),
      Effect.map((outcome): Option.Option<A | { readonly failure: SecretReadFailure }> => outcome),
      Effect.catch((error) => {
        const failure: SecretReadFailure = isNotInstalled(error) ? "not_installed" : "failed";
        return Effect.logWarning("Could not run 1Password", { stage, failure }).pipe(
          Effect.as(Option.some({ failure })),
        );
      }),
    );

  return defineSecretProviderDriver({
    kind: definition.kind,
    definition,
    read: Effect.fn("OnePasswordDriver.read")(function* (config, references, auth) {
      const login = signIn(config, auth);
      if (login === "no_token") return references.map(() => ({ failure: "no_token" as const }));
      if (references.length > 1) {
        const together = yield* bounded("inject", readTogether(login, references));
        // Reading one by one after a timeout would only wait that long again for each reference.
        if (Option.isNone(together)) return references.map(() => ({ failure: "timeout" as const }));
        if ("values" in together.value) return together.value.values;
        // Signed out or not installed: each read would fail the same way.
        if (together.value.failure === "locked" || together.value.failure === "not_installed") {
          const failure = together.value.failure;
          return references.map(() => ({ failure }));
        }
      }
      return yield* Effect.forEach(references, (reference) =>
        bounded("read", readOne(login, reference)).pipe(
          Effect.map((outcome) =>
            Option.getOrElse(outcome, () => ({ failure: "timeout" as const })),
          ),
        ),
      );
    }),
    check: Effect.fn("OnePasswordDriver.check")(function* (config, auth) {
      const login = signIn(config, auth);
      if (login === "no_token") return { failure: "no_token" as const };
      const outcome = yield* bounded(
        "whoami",
        run(["whoami", ...login.flags], login.env).pipe(
          Effect.map((result): SecretReadOutcome =>
            result.code === 0 ? {} : { failure: classifyOnePasswordError(result.stderr) },
          ),
        ),
      );
      return Option.getOrElse(outcome, () => ({ failure: "timeout" as const }));
    }),
  });
};

export const driver = makeDriver();
