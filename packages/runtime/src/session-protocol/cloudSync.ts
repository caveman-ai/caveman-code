// The cloud.profile.*, cloud.secrets/server.set_available, cloud.holdings*
// and cloud.access_log methods (cloudLink/cloudSync.ts). Everything that
// sends a value to Cloud, deletes from it or reads its log is for the person
// whose runtime this is (the same "just me" rule as secret.*).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { choicesFor, CloudSyncState, macSync } from "../cloudLink/cloudSync.ts";
import { readIdentity } from "../cloudLink/identity.ts";
import { CloudComputer, linkDirOf } from "../cloudLink/index.ts";
import { liveServersSocket } from "../cloudLink/tools.ts";
import * as ServerConfig from "../config.ts";
import { CredentialBroker } from "../plugins/CredentialBroker.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { type Handler, ProtocolError } from "./handlers.ts";

type CloudSyncMethod =
  | "cloud.profile.status"
  | "cloud.profile.sync"
  | "cloud.secrets.set_available"
  | "cloud.server.set_available"
  | "cloud.holdings"
  | "cloud.holdings.remove"
  | "cloud.access_log";

const fail = (reason: string, message: string) => new ProtocolError({ reason, message });
const asProtocol = (error: unknown) =>
  error instanceof ProtocolError ? error : fail(/Sign in/.test(String((error as Error)?.message)) ? "invalid_state" : "internal", (error as Error)?.message ?? String(error));

export const makeCloudSyncHandlers = (allowed: (principal: string | undefined) => boolean) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const computer = yield* CloudComputer;
    const sync = yield* CloudSyncState;
    const secrets = yield* ProjectSecrets;
    const settings = yield* Effect.serviceOption(ServerSettingsService);
    const broker = yield* Effect.serviceOption(CredentialBroker);
    // This Mac's side needs Settings and the broker; a host without them (some tests) answers unsupported.
    const mac =
      computer === undefined && Option.isSome(settings) && Option.isSome(broker)
        ? yield* macSync.pipe(Effect.provideService(ServerSettingsService, settings.value), Effect.provideService(CredentialBroker, broker.value))
        : undefined;
    const needMac = <A>(principal: string | undefined, use: (side: NonNullable<typeof mac>) => Effect.Effect<A, unknown>) =>
      !allowed(principal)
        ? Effect.fail(fail("forbidden", "Only the person this computer belongs to can change what it keeps with Caveman"))
        : mac === undefined
          ? Effect.fail(fail(computer ? "invalid_state" : "unsupported", computer ? "A Cloud computer takes these from This Mac" : "This runtime has no Settings to sync"))
          : use(mac).pipe(Effect.mapError(asProtocol));
    const status = () =>
      Effect.promise(() => serverKeysShared(computer !== undefined)).pipe(
        Effect.map((shared) => ({ ...(({ server_keys_shared: _s, ...rest }) => rest)(sync.status), items: [...sync.status.items], ...(shared ? { server_keys_shared: true as const } : {}) })),
      );

    const handlers = {
      "cloud.profile.status": () => status(),
      "cloud.profile.sync": (_p, ctx) =>
        Effect.gen(function* () {
          if (!allowed(ctx.principal)) return yield* Effect.fail(fail("forbidden", "Only the person this computer belongs to can sync it"));
          if (mac === undefined) {
            sync.wake?.();
            return yield* status();
          }
          yield* mac.resume.pipe(Effect.ignore);
          return yield* status();
        }),
      "cloud.secrets.set_available": (p, ctx) =>
        needMac(ctx.principal, (side) =>
          Effect.gen(function* () {
            const repository = yield* secrets.keyOf(p.repo);
            const names = yield* side.setRepository(repository, p.available, p.names);
            return { repository, available: p.available, names: [...names] };
          }),
        ),
      "cloud.server.set_available": (p, ctx) =>
        needMac(ctx.principal, (side) => side.setServer(p.name, p.available).pipe(Effect.map((names) => ({ available: p.available, names })))),
      "cloud.holdings": (_p, ctx) => needMac(ctx.principal, (side) => side.holdings.pipe(Effect.map((items) => ({ items })))),
      "cloud.holdings.remove": (p, ctx) =>
        Effect.suspend(() =>
          p.all !== true && p.kind === undefined
            ? Effect.fail(fail("invalid_params", "say what to remove: all, or a kind (and its id)"))
            : needMac(ctx.principal, (side) => side.remove(p).pipe(Effect.map((removed) => ({ removed })))),
        ),
      "cloud.access_log": (p, ctx) =>
        needMac(ctx.principal, (side) => side.accessLog(Math.min(500, p.limit ?? 100)).pipe(Effect.map((entries) => ({ entries })))),
    } satisfies { readonly [M in CloudSyncMethod]: Handler<M> };
    /**
     * Before This Mac signs out: deletes what Cloud holds for the person, then forgets the choices. Never fails
     * the sign-out; what could not be deleted is the answer (undefined when everything went).
     */
    const deleteCloudCopies: Effect.Effect<string | undefined> =
      mac === undefined
        ? Effect.succeed(undefined)
        : mac.signOut.pipe(
            Effect.as(undefined),
            Effect.catch((error) =>
              Effect.logWarning("Could not delete everything Caveman Cloud holds for you", error).pipe(Effect.as(error instanceof Error ? error.message : String(error))),
            ),
          );
    return { handlers, deleteCloudCopies };
  });

/**
 * Whether the agent's commands can read MCP server keys on Cloud computers (the H3 copy): yes unless this is a
 * Cloud computer whose hub starts servers in the servers container (its own uid). This Mac cannot vouch for
 * any computer, so it says yes.
 */
export const serverKeysShared = async (onComputer: boolean) => !onComputer || (await liveServersSocket()) === undefined;

/**
 * Which of a repository's secrets are available on Cloud computers for the account signed in now (secret.list's
 * cloud_available and cloud_names): all of them, or the `stored` names opted in one by one (Add from this Mac).
 */
export const cloudAvailability = (stateDir: string, repository: string, stored: ReadonlyArray<string>): { cloud_available?: true; cloud_names?: Array<string> } => {
  const choices = choicesFor(stateDir, readIdentity(linkDirOf(stateDir)));
  if (choices.repositories.includes(repository)) return { cloud_available: true };
  const opted = new Set(choices.names?.[repository] ?? []);
  // A name deleted here is deleted from Cloud too, though it stays opted in for when it comes back.
  const names = stored.filter((name) => opted.has(name));
  return names.length > 0 ? { cloud_names: names } : {};
};
