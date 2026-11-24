/**
 * The credential broker. Plugins and their MCP servers get no ambient
 * secrets: a credential reaches a plugin only when the broker grants it, and
 * the runtime attaches it to the server's launch config (or HTTP headers),
 * outside the plugin's own code.
 *
 * `layerSecretStore` is the runtime's broker: the user grants a credential to
 * a space in Settings (entered once, kept in the runtime's secret store, never
 * shown again) and the broker serves only granted names, never anything from
 * the environment. `layerDenyAll` grants nothing.
 *
 * Every value it holds joins the egress scrub (`grantedCredentials`), so one a
 * plugin's server prints reaches no model, transcript or memory note.
 *
 * @module plugins/CredentialBroker
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export interface CredentialRequest {
  /** `<plugin>@<space>`. */
  readonly plugin: string;
  /** The space's repo and pinned commit; absent for a plugin loaded outside Settings. */
  readonly space: { readonly url: string; readonly commit: string } | undefined;
  /** The plugin's MCP server name. */
  readonly server: string;
  /** Where the credential goes: the server's URL, or the command it starts. */
  readonly destination: string;
  /** The variable the plugin asks for, e.g. `DD_API_KEY`. */
  readonly name: string;
}

export class CredentialBroker extends Context.Service<
  CredentialBroker,
  {
    readonly resolve: (
      request: CredentialRequest,
    ) => Effect.Effect<Option.Option<Redacted.Redacted<string>>>;
  }
>()("caveman/plugins/CredentialBroker") {}

export const layerDenyAll = Layer.succeed(CredentialBroker, {
  resolve: () => Effect.succeed(Option.none()),
});

export class CredentialGrantError extends Error {}

/** Grants per space, by the space's repo URL. Values go in and never come back out. */
export class CredentialGrants extends Context.Service<
  CredentialGrants,
  {
    readonly grant: (
      spaceUrl: string,
      name: string,
      value: Redacted.Redacted<string>,
    ) => Effect.Effect<void, CredentialGrantError>;
    readonly revoke: (spaceUrl: string, name: string) => Effect.Effect<void, CredentialGrantError>;
    readonly isGranted: (spaceUrl: string, name: string) => Effect.Effect<boolean>;
  }
>()("caveman/plugins/CredentialGrants") {}

/** The secret store entry for `name` granted to the space at `spaceUrl`. */
export const credentialKey = (spaceUrl: string, name: string) =>
  `plugin-credential-${createHash("sha256").update(`${spaceUrl}\0${name}`).digest("hex").slice(0, 32)}`;

/**
 * The name a granted credential has in Caveman Cloud's vault (repository
 * `caveman:servers`): the first 16 hex of `credentialKey`'s hash, a dot, the
 * variable. A computer's broker derives it from the same request.
 */
export const cloudCredentialName = (spaceUrl: string, name: string) =>
  `${createHash("sha256").update(`${spaceUrl}\0${name}`).digest("hex").slice(0, 16)}.${name}`;

/** The reserved repository key server credentials are kept under in Caveman Cloud. */
export const CLOUD_SERVERS_REPOSITORY = "caveman:servers";

/**
 * Every plugin credential this runtime holds, value -> the variable it is granted as: the egress scrub masks each one
 * (EgressScrub.ts) as it does provider keys. A grant an earlier run made joins at start as PLUGIN_CREDENTIAL, its name
 * being only in its store key's hash, until a grant or a server's start names it. A revoked value stays until exit:
 * a server started before may still print it. ponytail: process-wide, like providerKeyValues.
 */
export const grantedCredentials = { values: new Map<string, string>(), generation: 0 };
/** Holds each value read, under `name`; without one (found at start), under the name it has or PLUGIN_CREDENTIAL. */
const holding =
  (name?: string) =>
  <E, R>(self: Effect.Effect<Option.Option<string>, E, R>) =>
    Effect.tap(self, (value) =>
      Effect.sync(() => {
        if (Option.isNone(value)) return;
        const next = name ?? grantedCredentials.values.get(value.value) ?? "PLUGIN_CREDENTIAL";
        if (grantedCredentials.values.get(value.value) === next) return;
        grantedCredentials.values.set(value.value, next);
        grantedCredentials.generation++;
      }),
    );
const CREDENTIAL_FILE = /^(plugin-credential-[0-9a-f]{32})\.bin$/;

const grantError =(cause: { readonly message: string }) => new CredentialGrantError(cause.message);

/** The broker and its grants on the runtime's secret store (`<stateDir>/secrets`, 0600 files). */
export const layerSecretStore = Layer.effectContext(
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
    const readKey = (key: string) =>
      secrets.get(key).pipe(
        Effect.catch((error) =>
          Effect.logWarning("Plugin credential unreadable", error.message).pipe(Effect.as(Option.none<Uint8Array>())),
        ),
      );
    const read = (spaceUrl: string, name: string) => readKey(credentialKey(spaceUrl, name));
    // Scrubbed from the start, not from its server's first start: the person may paste one into a chat before.
    const directory = secrets.directory;
    const files = directory === undefined ? [] : yield* Effect.try(() => fs.readdirSync(directory)).pipe(Effect.orElseSucceed(() => []));
    yield* Effect.forEach(files, (file) => {
      const key = CREDENTIAL_FILE.exec(file)?.[1];
      return key === undefined ? Effect.void : readKey(key).pipe(Effect.map(Option.map(decode)), holding());
    }, { discard: true });
    return Context.make(CredentialBroker, {
      resolve: ({ space, name }) =>
        // A plugin from outside Settings has no space to hold grants.
        space === undefined
          ? Effect.succeed(Option.none())
          : read(space.url, name).pipe(
              Effect.map(Option.map(decode)),
              holding(name),
              Effect.map(Option.map((value) => Redacted.make(value))),
            ),
    }).pipe(
      Context.add(CredentialGrants, {
        grant: (spaceUrl, name, value) =>
          secrets
            .set(credentialKey(spaceUrl, name), new TextEncoder().encode(Redacted.value(value)))
            .pipe(Effect.mapError(grantError), Effect.as(Option.some(Redacted.value(value))), holding(name), Effect.asVoid),
        revoke: (spaceUrl, name) =>
          secrets.remove(credentialKey(spaceUrl, name)).pipe(Effect.mapError(grantError)),
        isGranted: (spaceUrl, name) => read(spaceUrl, name).pipe(Effect.map(Option.isSome)),
      }),
    );
  }),
);
