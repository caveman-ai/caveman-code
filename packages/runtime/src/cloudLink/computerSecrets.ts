// Secrets on a Cloud computer (CONTRACT TRUST T4): repository secrets and
// server keys come from Caveman Cloud's resolve route for the person whose
// work this computer runs, and live only in this process's memory. Nothing is
// written to the volume. Every value joins the scrubber before it is handed
// to anything, and a server key reaches only its own server's process (the
// MCP hub starts it; engines see the hub endpoint).
//
// Where the person's credentials stay outside the computer (credentialRule.ts) only the workspace's own repository
// secrets are read here, which are the agent's to read by design. A service account's credentials, a personal
// server's keys and the engines' keys are not asked for; names come from the same resolve (Cloud refuses the list
// there), and nothing is written to Cloud from inside the computer: what other computers read is not this one's to
// change.
import * as fs from "node:fs";
import * as path from "node:path";

import { createScrubber, repositoryKey, type Repo, type SecretEntry, type SecretInfo } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { CLOUD_SERVERS_REPOSITORY, cloudCredentialName, CredentialBroker, layerSecretStore } from "../plugins/CredentialBroker.ts";
import { PERSONAL_SPACE_URL } from "../plugins/personal.ts";
import { ProjectSecrets, ProjectSecretsError, type SecretsChanged } from "../secrets/ProjectSecrets.ts";
import * as ProjectSecretsLive from "../secrets/ProjectSecretsLive.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { accountVault } from "./accountCredentials.ts";
import { errorText, listNames, resolveAll, resolveValues } from "./cloudSync.ts";
import { call } from "./computers.ts";
import { OUTSIDE_CONNECT, OUTSIDE_REMOVE, onYourMac } from "./credentialRule.ts";
import { credentialRule } from "./credentialsOutside.ts";
import { CloudError, readIdentity, refused } from "./identity.ts";
import { EngineCloudKeys, engineKeyName, type EngineCloudKeysShape } from "./engineKeys.ts";
import { followedCloudOver, followedLogins, toolsLoginFiles } from "./engineLogins.ts";
import { connectionsFor } from "./modelConnections.ts";
import { toolsSocket } from "./tools.ts";
import { toolsHome } from "./toolsMirror.ts";
import { CloudComputer, CloudLinkState } from "./index.ts";

/** How long a resolve answers from memory before asking Cloud again (each resolve is a row in the person's access log). */
const FRESH_MS = 5 * 60_000;
/** When Cloud cannot be reached (network, 5xx): the last values serve until they are this old, then none. */
const STALE_MS = 10 * 60_000;
/** After Cloud refused (401, 403): none, without asking again, for this long. */
const REFUSED_MS = 60_000;

/**
 * Cloud closing a service account's computer: the account is disabled, or the computer runs others' work too.
 * Like a refusal, nothing resolved before is used any more (never the last values, as when Cloud is unreachable).
 */
const shut = (error: unknown) => error instanceof CloudError && (error.code === "cave_code_service_account_inactive" || error.code === "cave_code_computer_shared");

/** Cloud refused the request itself as malformed (400): asking again gets the same answer, so it is not asked again. */
const malformed = (error: unknown) => error instanceof CloudError && error.status === 400;

/**
 * A slot This Mac keeps in its own store under a key no repository has (caveman:connectors, local:<path>). Cloud keeps
 * secrets only for a repository and caveman:servers (Caveman Cloud secrets.go secretRepository) and answers anything
 * else with a 400, so a computer never asks it: such a slot is empty here.
 */
export const keptOnMacOnly = (repository: string) => repository !== CLOUD_SERVERS_REPOSITORY && /^[a-z][a-z0-9+-]*:(?!\/\/)/i.test(repository);

/**
 * Values per key from `fetch`, in memory: fresh ones for FRESH_MS; on a refusal none (and forgotten) for
 * REFUSED_MS; on a malformed request none, and Cloud is not asked for that key again until `forget`; when Cloud
 * is unreachable the last ones until STALE_MS, then none. `onDrop` hears a forgotten key.
 */
export function resolver(fetch: (key: string) => Effect.Effect<ReadonlyArray<SecretEntry>, unknown>, what: (key: string) => string, onDrop: (key: string) => void = () => {}) {
  const cache = new Map<string, { at: number; entries: ReadonlyArray<SecretEntry> }>();
  const refusedUntil = new Map<string, number>();
  const resolve = (key: string): Effect.Effect<ReadonlyArray<SecretEntry>> =>
    Effect.suspend(() => {
      const now = Date.now();
      const hit = cache.get(key);
      if (hit && now - hit.at < FRESH_MS) return Effect.succeed(hit.entries);
      if ((refusedUntil.get(key) ?? 0) > now) return Effect.succeed([]);
      return fetch(key).pipe(
        Effect.tap((entries) =>
          Effect.sync(() => {
            cache.set(key, { at: Date.now(), entries });
            refusedUntil.delete(key);
          }),
        ),
        Effect.catch((error) => {
          if (malformed(error)) {
            cache.delete(key);
            refusedUntil.set(key, Number.POSITIVE_INFINITY);
            onDrop(key);
            return Effect.logWarning(`${what(key)}: Caveman Cloud refused the request as malformed (${errorText(error)}); none are used here and it is not asked again`).pipe(
              Effect.as([]),
            );
          }
          if (refused(error) || shut(error)) {
            cache.delete(key);
            refusedUntil.set(key, Date.now() + REFUSED_MS);
            onDrop(key);
            return Effect.logWarning(`${what(key)}: Caveman Cloud refused (${errorText(error)}); none are used here`).pipe(Effect.as([]));
          }
          const usable = hit !== undefined && Date.now() - hit.at < STALE_MS;
          if (!usable) {
            cache.delete(key);
            onDrop(key);
          }
          return Effect.logWarning(`${what(key)}: Caveman Cloud unavailable (${errorText(error)}); ${usable ? "the last ones stay for a few minutes" : "none are used here"}`).pipe(
            Effect.as(usable ? hit.entries : []),
          );
        }),
      );
    });
  /** Asks Cloud at the next resolve. */
  const forget = (key: string) => {
    cache.delete(key);
    refusedUntil.delete(key);
  };
  return { resolve, forget };
}

/** Every value this computer resolved (repository secrets and server keys): the scrubber's input, memory only. */
export class CloudValues extends Context.Reference<{ readonly seen: Map<string, string>; version: number }>("caveman/cloudLink/CloudValues", {
  defaultValue: () => ({ seen: new Map(), version: 0 }),
}) {}

const remember = (values: { seen: Map<string, string>; version: number }, entries: ReadonlyArray<SecretEntry>, prefix: string) => {
  for (const { name, value } of entries) {
    const key = `${prefix}\0${name}\0${value}`;
    if (!values.seen.has(key)) {
      values.seen.set(key, value);
      values.version++;
    }
  }
};

/** origin's URL from a checkout's .git/config, read as a file: git never runs in a checkout the agent can write. */
export function originOf(root: string): string | undefined {
  let text: string;
  try {
    text = fs.readFileSync(path.join(root, ".git", "config"), "utf8");
  } catch {
    return undefined;
  }
  let inOrigin = false;
  for (const line of text.split("\n")) {
    const section = /^\s*\[\s*remote\s+"([^"]*)"\s*\]/.exec(line);
    if (section) inOrigin = section[1] === "origin";
    else if (/^\s*\[/.test(line)) inOrigin = false;
    else if (inOrigin) {
      const url = /^\s*url\s*=\s*(.+?)\s*$/.exec(line);
      if (url) return url[1];
    }
  }
  return undefined;
}

const cloudError = (error: unknown) => new ProjectSecretsError({ message: errorText(error) });

/** What a secret change made from inside a Cloud computer under the rule says. */
export const OUTSIDE_SECRETS = `Change secrets ${onYourMac("Settings > Projects")}.`;

export const makeProjectSecrets = Effect.gen(function* () {
  const computer = (yield* CloudComputer)!;
  const link = yield* CloudLinkState;
  const values = yield* CloudValues;
  const identity = () => readIdentity(computer.linkDir);
  const rule = yield* credentialRule;
  /** Whether credentials stay outside this computer; while Cloud cannot say, what asks fails rather than guess. */
  const outside = Effect.tryPromise({ try: () => rule.outside(), catch: (error) => error });
  const names = new Map<string, ReadonlyArray<SecretInfo>>();
  const changes = yield* PubSub.unbounded<SecretsChanged>();
  let scrubber = createScrubber([]);
  let built = -1;
  const scrub = () => {
    if (built !== values.version) {
      scrubber = createScrubber([...values.seen].map(([key, value]) => ({ name: key.split("\0")[1]!, value })));
      built = values.version;
    }
    return scrubber;
  };
  const cloud = <A>(run: (id: NonNullable<ReturnType<typeof identity>>) => Promise<A>) =>
    Effect.suspend(() => {
      const id = identity();
      return id === undefined ? Effect.fail(cloudError("this computer has no Cloud identity")) : Effect.tryPromise({ try: () => run(id), catch: (error) => error });
    });
  const changed = (repository: string) => PubSub.publish(changes, { repository, names: (names.get(repository) ?? []).map((s) => s.name) });
  const infos = (repository: string, list: ReadonlyArray<{ name: string; updated_at?: string }>) =>
    list.map((e) => ({ name: e.name, repository, updated_at: e.updated_at ?? new Date().toISOString(), hidden: true }));

  // Values (CloudValues keeps every one for the scrubber, even after Cloud forgets it here). On a service account's
  // computer the answer also carries its credentials and host-bound variables (accountCredentials.ts): every real
  // value joins the scrubber, and processes get a host-bound variable as its stand-in.
  const values$ = resolver(
    (repository) =>
      Effect.all([outside, cloud((id) => resolveAll(id, link, repository))]).pipe(
        Effect.map(([ruled, { secrets, credentials, connectors }]) => {
          // Under the rule Cloud answers no credentials, and none is taken if it did: only their names, for the
          // connector proxy to be asked by (accountCredentials.ts).
          const entries = accountVault.take(secrets, ruled ? undefined : credentials, ruled ? connectors : undefined);
          remember(values, [...secrets.map(({ name, value }) => ({ name, value })), ...accountVault.values()], repository);
          names.set(repository, infos(repository, entries));
          return entries;
        }),
      ),
    (repository) => `Repository secrets for ${repository}`,
    (repository) => {
      names.delete(repository);
      accountVault.clear();
    },
  );
  const resolve = (repository: string) => (keptOnMacOnly(repository) ? Effect.succeed([] as ReadonlyArray<SecretEntry>) : values$.resolve(repository));
  /** Names only (GET, no value, no access-log row); a refusal lists none. */
  const listFromCloud = (repository: string) =>
    keptOnMacOnly(repository)
      ? Effect.succeed([] as ReadonlyArray<SecretInfo>)
      : cloud((id) => listNames(id, link, repository)).pipe(
          Effect.map((list) => infos(repository, list)),
          Effect.tap((list) => Effect.sync(() => names.set(repository, list))),
          Effect.catch((error) =>
            refused(error)
              ? Effect.sync(() => {
                  names.delete(repository);
                  values$.forget(repository);
                  return [] as ReadonlyArray<SecretInfo>;
                })
              : Effect.fail(cloudError(error)),
          ),
        );
  /** Under the rule Cloud refuses the list to a computer: the names are those of what it resolved. */
  const list = (repository: string) =>
    outside.pipe(
      Effect.mapError(cloudError),
      Effect.flatMap((ruled) => (ruled && !keptOnMacOnly(repository) ? resolve(repository).pipe(Effect.map(() => names.get(repository) ?? [])) : listFromCloud(repository))),
    );
  /** Under the rule nothing is written to Cloud from inside the computer. */
  const writable = outside.pipe(
    Effect.mapError(cloudError),
    Effect.flatMap((ruled) => (ruled ? Effect.fail(new ProjectSecretsError({ message: OUTSIDE_SECRETS })) : Effect.void)),
  );

  const service = ProjectSecrets.of({
    keyOf: (repo: Repo) =>
      Effect.suspend(() => {
        if ("url" in repo) {
          const key = repositoryKey(repo.url);
          return key === undefined ? Effect.fail(new ProjectSecretsError({ message: `${repo.url} is not a repository URL`, reason: "not_a_repository" })) : Effect.succeed(key);
        }
        const inside = repo.path === computer.workspaceRoot || repo.path.startsWith(`${computer.workspaceRoot}${path.sep}`);
        const origin = inside ? originOf(computer.workspaceRoot) : undefined;
        const key = origin === undefined ? undefined : repositoryKey(origin);
        return key === undefined
          ? Effect.fail(new ProjectSecretsError({ message: `${repo.path} is not this computer's repository`, reason: "not_a_repository" }))
          : Effect.succeed(key);
      }),
    repin: () => Effect.fail(new ProjectSecretsError({ message: "A Cloud computer's repository is the workspace's" })),
    list,
    set: (repository, entries) =>
      keptOnMacOnly(repository)
        ? Effect.fail(new ProjectSecretsError({ message: `A Cloud computer keeps no ${repository} secrets` }))
        : cloud((id) => call(id, link, "PUT", "secrets", { repository, secrets: entries.map((e) => ({ name: e.name, value: Redacted.value(e.value) })) })).pipe(
            Effect.mapError(cloudError),
            Effect.tap(() =>
              Effect.sync(() => {
                values$.forget(repository);
                // Hidden from now on, not from the next resolve: a running session may print it already.
                remember(values, entries.map((e) => ({ name: e.name, value: Redacted.value(e.value) })), repository);
              }),
            ),
            Effect.andThen(list(repository)),
            Effect.tap(() => changed(repository)),
            Effect.map(() => (names.get(repository) ?? []).filter((s) => entries.some((e) => e.name === s.name))),
          ),
    remove: (repository, name) =>
      keptOnMacOnly(repository)
        ? Effect.void
        : cloud((id) =>
            call(id, link, "DELETE", `secrets/${encodeURIComponent(name)}?repository=${encodeURIComponent(repository)}`).catch((error) => {
              if (!(error instanceof CloudError && error.status === 404)) throw error;
            }),
          ).pipe(
            Effect.mapError(cloudError),
            Effect.tap(() => Effect.sync(() => values$.forget(repository))),
            Effect.andThen(list(repository)),
            Effect.tap(() => changed(repository)),
            Effect.asVoid,
          ),
    resolve,
    has: (repository) => resolve(repository).pipe(Effect.map((entries) => entries.length > 0)),
    scrubber: Effect.sync(scrub),
    changes: Stream.fromPubSub(changes),
  });
  return ProjectSecrets.of({
    ...service,
    set: (repository, entries) => writable.pipe(Effect.andThen(service.set(repository, entries))),
    remove: (repository, name) => writable.pipe(Effect.andThen(service.remove(repository, name))),
  });
});

/**
 * A computer's broker: what was granted here first, then a personal server's
 * keys from Cloud when the person turned "Available on Cloud computers" on for
 * that server (its cloudConsent, from the profile). Beside it, the person's
 * engine keys (engineKeys.ts) from the same vault key, in memory only, and their sign-ins that follow them
 * (engineLogins.ts), joined to Cloud here.
 */
export const layerBroker = Layer.effectContext(
  Effect.gen(function* () {
    // The local grants (CredentialGrants too) as on This Mac; this broker answers in front of them.
    const grants = yield* Layer.build(layerSecretStore);
    const local = Context.get(grants, CredentialBroker);
    const computer = (yield* CloudComputer)!;
    const link = yield* CloudLinkState;
    const values = yield* CloudValues;
    const settings = yield* ServerSettingsService;
    const rule = yield* credentialRule;
    const keys$ = resolver(
      (repository) =>
        Effect.suspend(() => {
          const id = readIdentity(computer.linkDir);
          return id === undefined
            ? Effect.succeed([] as ReadonlyArray<SecretEntry>)
            : // Under the rule a person's keys are not asked for: none reach this computer.
              Effect.tryPromise({ try: async () => ((await rule.outside()) ? [] : resolveValues(id, link, repository)), catch: (error) => error }).pipe(
                Effect.tap((entries) => Effect.sync(() => remember(values, entries, repository))),
              );
        }),
      () => "Your MCP servers' keys",
    );
    const keys = keys$.resolve(CLOUD_SERVERS_REPOSITORY);
    // Sign-ins that follow the person (engineLogins.ts): Claude's file in the tools home, Codex's in the one Codex
    // home a computer has (CodexApiKeyAccount.ts codexManagedHomePath), both read and written through tools.
    const socket = toolsSocket();
    const stateDir = (yield* ServerConfig.ServerConfig).stateDir;
    followedLogins.connect({
      cloud: followedCloudOver((method, route, body) => {
        const id = readIdentity(computer.linkDir);
        if (id === undefined) return Promise.reject(new Error("This computer has no Cloud identity yet"));
        return call(id, link, method, `engine-logins${route}`, body);
      }),
      files: toolsLoginFiles(socket),
      paths: {
        claude: async () => path.posix.join(socket === undefined ? (process.env.HOME ?? "/") : await toolsHome(socket), ".claude", ".credentials.json"),
        codex: async () => path.join(stateDir, "providers", "codex", "active", "home", "auth.json"),
      },
      outside: () => rule.outside(),
      connections: () => connectionsFor(computer, link),
      routesAuto: async (engine) => (await rule.outside()) && rule.routesAuto(engine),
    });
    // The rule came on while this computer ran (Cloud refused a credential route): what was held for attaching goes.
    rule.onOutside(() => {
      void followedLogins.dropAll();
      accountVault.clear();
      keys$.forget(CLOUD_SERVERS_REPOSITORY);
    });
    const engineKeys: EngineCloudKeysShape = {
      get: (engine) => keys.pipe(Effect.map((entries) => entries.find((e) => e.name === engineKeyName(engine))?.value)),
      set: (engine, key) =>
        Effect.suspend(() => {
          const id = readIdentity(computer.linkDir);
          if (id === undefined) return Effect.fail(new Error("This computer has no Cloud identity yet"));
          const name = engineKeyName(engine);
          return Effect.tryPromise({
            try: async () => {
              if (await rule.outside()) throw new Error(key === null ? OUTSIDE_REMOVE : OUTSIDE_CONNECT);
              return key === null
                ? call(id, link, "DELETE", `secrets/${encodeURIComponent(name)}?repository=${encodeURIComponent(CLOUD_SERVERS_REPOSITORY)}`).catch((error) => {
                    if (!(error instanceof CloudError && error.status === 404)) throw error;
                  })
                : call(id, link, "PUT", "secrets", { repository: CLOUD_SERVERS_REPOSITORY, secrets: [{ name, value: key }] });
            },
            catch: (error) => new Error(errorText(error)),
          }).pipe(Effect.tap(() => Effect.sync(() => keys$.forget(CLOUD_SERVERS_REPOSITORY))), Effect.asVoid);
        }),
    };
    return Context.add(Context.add(grants, EngineCloudKeys, engineKeys), CredentialBroker, {
      resolve: (request) =>
        local.resolve(request).pipe(
          Effect.flatMap((granted) =>
            Option.isSome(granted) || request.space?.url !== PERSONAL_SPACE_URL
              ? Effect.succeed(granted)
              : settings.getSettings.pipe(
                  Effect.map((s) => s.plugins.servers.find((server) => server.name === request.server)?.cloudConsent === true),
                  Effect.orElseSucceed(() => false),
                  Effect.flatMap((consented) =>
                    !consented
                      ? Effect.succeed(Option.none<Redacted.Redacted<string>>())
                      : keys.pipe(
                          Effect.map((entries) => {
                            const hit = entries.find((e) => e.name === cloudCredentialName(PERSONAL_SPACE_URL, request.name));
                            return hit === undefined ? Option.none<Redacted.Redacted<string>>() : Option.some(Redacted.make(hit.value));
                          }),
                        ),
                  ),
                ),
          ),
        ),
    });
  }),
);

/** The runtime's ProjectSecrets: Cloud's, in memory, on a Cloud computer; the sealed local store on This Mac. */
export const layerProjectSecrets = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* CloudComputer) === undefined ? ProjectSecretsLive.layer : Layer.effect(ProjectSecrets, makeProjectSecrets);
  }),
);

/** The runtime's broker: grants here, plus consented server keys from Cloud on a Cloud computer. */
export const layerCredentialBroker = Layer.unwrap(
  Effect.gen(function* () {
    return (yield* CloudComputer) === undefined ? layerSecretStore : layerBroker;
  }),
);
