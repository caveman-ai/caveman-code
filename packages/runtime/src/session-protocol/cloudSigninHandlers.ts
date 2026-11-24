// The Caveman sign-in family of the Session Protocol: cloud.enroll, cloud.status, cloud.client_token, cloud.signin and
// cloud.signout. The flow itself (device code, approval, enrolling this computer) is cloudSignin.ts; these handlers wire
// it to the runtime's settings, secret store, router key and Remote control switch. The settings, store and link state
// they act on are handlers.ts's own, passed in (CloudSigninDeps), as the other families (account.ts, cloudSync.ts) take theirs.
import * as os from "node:os";

import * as Effect from "effect/Effect";

import type { CloudStatus, Settings } from "@caveman-app/session-protocol";

import {
  accountSignOut,
  freshSession,
  type AccountSession,
  type AccountStore,
} from "../cloudLink/account.ts";
import { desktopTokenOf } from "../cloudLink/clientToken.ts";
import {
  CloudError,
  cloudOrigin,
  enroll,
  pinAllows,
  pinnedCloud,
  readIdentity,
} from "../cloudLink/identity.ts";
import { type CloudComputerInfo, type LinkState, linkDirOf } from "../cloudLink/index.ts";
import { appProxyTokens, writeAppProxyCloud } from "../router/proxyLauncher.ts";
import {
  type SigninState,
  HOSTED_CLOUD,
  readAccount,
  signOut,
  startSignin,
} from "./cloudSignin.ts";
import { type Handler, ProtocolError } from "./handlers.ts";

type SigninMethod =
  | "cloud.enroll"
  | "cloud.status"
  | "cloud.client_token"
  | "cloud.signin"
  | "cloud.signout";

/** Cloud's answer to an enrollment as a protocol reason. */
// A Cloud 401 is the person's Cloud sign-in, never this client's runtime token (`unauthorized` makes the client reconnect).
export const enrollReason = (status: number) =>
  status === 401
    ? "cloud_unauthorized"
    : status === 403
      ? "forbidden"
      : status === 429
        ? "rate_limited"
        : status >= 500
          ? "internal"
          : "invalid_params";

const fail = (reason: string, message: string) =>
  Effect.fail(new ProtocolError({ reason, message }));

/** What these handlers take from handlers.ts. */
export interface CloudSigninDeps {
  /** Set on a Cloud computer, which is enrolled by the computers service and signs nobody in. */
  readonly cloud: CloudComputerInfo | undefined;
  readonly cloudLink: LinkState;
  readonly signin: SigninState;
  readonly stateDir: string;
  readonly accountStore: AccountStore;
  readonly getSettings: Effect.Effect<Settings>;
  /** cloud.status `moves`, `sync`: handlers.ts's readings of the lid's moves and of sync. */
  readonly movesState: Effect.Effect<CloudStatus["moves"]>;
  readonly syncAvailable: () => boolean;
  readonly syncOn: Effect.Effect<boolean>;
  /** Whether this computer can open pull requests (a source-control sign-in). */
  readonly pullRequests: boolean;
  /** Hands an approved session to the secret store (undefined forgets it). */
  readonly keepSignIn: (session: AccountSession | undefined) => Promise<void>;
  readonly routerKey: {
    readonly refresh: () => Promise<unknown>;
    readonly clear: () => Promise<unknown>;
  };
  /** Before a sign-out: what Cloud holds for the person goes (undefined when everything went). */
  readonly deleteCloudCopies: Effect.Effect<string | undefined>;
  /** The Caveman credits key, forgotten with the sign-in. */
  readonly clearCredits: Effect.Effect<unknown, unknown>;
  /** Remote control back to following sync (a first sign-in), or off in the saved settings. */
  readonly remoteControlFollowsSync: Effect.Effect<unknown>;
  readonly remoteControlOff: Effect.Effect<unknown>;
}

export const makeCloudSigninHandlers = (deps: CloudSigninDeps) => {
  const {
    cloud,
    cloudLink,
    signin,
    stateDir,
    accountStore,
    getSettings,
    movesState,
    syncAvailable,
    syncOn,
    pullRequests,
    keepSignIn,
    routerKey,
    deleteCloudCopies,
    clearCredits,
    remoteControlFollowsSync,
    remoteControlOff,
  } = deps;
  const handlers: { readonly [M in SigninMethod]: Handler<M> } = {
    "cloud.enroll": (p) =>
      cloud
        ? fail("invalid_state", "a Cloud computer is enrolled by the computers service")
        : Effect.try({
            try: () => cloudOrigin(p.cloud_url),
            catch: (error) =>
              new ProtocolError({
                reason: "invalid_params",
                message: `Could not enroll with Caveman: ${(error as Error).message}`,
              }),
          }).pipe(
            Effect.filterOrFail(
              (cloudUrl) => pinAllows(cloudUrl),
              () =>
                new ProtocolError({
                  reason: "forbidden",
                  message: `Your organization set this computer's Caveman server to ${pinnedCloud()?.cloudUrl} (CAVEMAN_CLOUD_URL).`,
                }),
            ),
            Effect.andThen((cloudUrl) =>
              Effect.tryPromise({
                try: () =>
                  enroll({
                    dir: linkDirOf(stateDir),
                    cloudUrl,
                    bearer: p.token,
                    name: p.name ?? os.hostname(),
                  }),
                // Not a CloudError: Cloud was unreachable (or the key could not be written).
                catch: (error) =>
                  error instanceof CloudError
                    ? new ProtocolError({
                        reason: enrollReason(error.status),
                        message: `Caveman did not enroll this runtime (${error.status}): ${error.message}`,
                      })
                    : new ProtocolError({
                        reason: "internal",
                        message: `Could not enroll with Caveman: ${(error as Error).message}`,
                      }),
              }),
            ),
            Effect.map((id) => ({
              cloud_url: id.cloudUrl,
              runtime_id: id.runtimeId,
              organization_id: id.organizationId,
              computer_id: id.computerId,
            })),
          ),
    "cloud.status": () =>
      Effect.gen(function* () {
        const moves = yield* movesState;
        const dir = cloud?.linkDir ?? linkDirOf(stateDir);
        const id = readIdentity(dir);
        // The account Cloud approved, kept with or without a runtime identity: Cloud may have refused to
        // register this computer (a role without Remote control, Cloud unreachable) and the person is still
        // signed in (cloudSignin.ts).
        const account = readAccount(dir);
        const status = cloudLink.status;
        // A link kept only for moves (no relay) is Remote control off.
        const state =
          status === undefined || status === "stopped" || cloudLink.relay === false
            ? "off"
            : status;
        const pending = signin.current;
        return {
          state,
          ...(id
            ? { cloud_url: id.cloudUrl, runtime_id: id.runtimeId, computer_id: id.computerId }
            : {}),
          // cloudLink/usageReporter.ts reports while This Mac is signed in.
          ...(id && !cloud ? { usage_reported: true } : {}),
          ...(account ? { account } : {}),
          ...(pending
            ? {
                signin: {
                  user_code: pending.user_code,
                  verification_uri: pending.verification_uri,
                  verification_uri_complete: pending.verification_uri_complete,
                  expires_at: pending.expires_at,
                },
              }
            : {}),
          ...(signin.error ? { signin_error: signin.error } : {}),
          ...(moves ? { moves } : {}),
          // What this computer does that a client may offer, once it is signed in to a Cloud.
          ...(id
            ? {
                capabilities: {
                  // A Cloud computer opens them through Cloud as the repository's App; This Mac with its source-control sign-in.
                  pull_requests: cloud ? true : pullRequests,
                  // Claude Agent and Codex traffic shortened by the app's proxies, with caveman_retrieve reachable (on a
                  // Cloud computer, served from the runtime container).
                  compression: false,
                },
              }
            : {}),
          ...(id
            ? {
                sync: {
                  available: syncAvailable(),
                  on: yield* syncOn,
                  ...(!cloud && syncAvailable() && (yield* getSettings).sync_chats === undefined
                    ? { ask: true }
                    : {}),
                },
              }
            : {}),
        };
      }),
    "cloud.client_token": (_p, ctx) =>
      Effect.gen(function* () {
        // The desktop renderer's: a client through the relay already has the person's own Cloud session.
        if (ctx.principal !== undefined && ctx.principal !== "local")
          return yield* fail(
            "forbidden",
            "only a client on this computer gets a Caveman token from it",
          );
        const session = yield* Effect.promise(() =>
          freshSession(accountStore).catch(() => undefined),
        );
        if (session === undefined)
          return yield* fail("invalid_state", "Sign in to Caveman first (Settings, Account)");
        const out = yield* Effect.tryPromise({
          try: () => desktopTokenOf(accountStore, session, Date.now()),
          catch: (error) =>
            new ProtocolError({
              reason: "invalid_state",
              message: `Caveman gave no token for the app: ${(error as Error).message}`,
            }),
        });
        appProxyTokens.add(out.token);
        return out;
      }),
    "cloud.signin": (params) =>
      cloud
        ? fail("invalid_state", "a Cloud computer is enrolled by the computers service")
        : Effect.gen(function* () {
            const settings = yield* getSettings;
            const run = Effect.runPromiseWith(yield* Effect.context<never>());
            const cloudUrl = yield* Effect.try({
              try: () => cloudOrigin(settings.cloud_url ?? HOSTED_CLOUD),
              catch: (error) =>
                new ProtocolError({
                  reason: "invalid_params",
                  message: `Could not start the Caveman sign-in: ${(error as Error).message}`,
                }),
            });
            const p = yield* Effect.tryPromise({
              try: () =>
                startSignin({
                  state: signin,
                  cloudUrl,
                  dir: linkDirOf(stateDir),
                  name: os.hostname(),
                  keep: keepSignIn,
                  provider: params.provider,
                  email: params.email,
                  intent: params.intent,
                  // Signed in: the app's proxy is up, so Auto can route once caveman is signed in too (proxyLauncher.ts).
                  // Approved but not registered (an account, no identity): signed in with Remote control off in the
                  // saved settings, so no link starts for a computer Cloud does not know.
                  onDone: (enrolled, account) => {
                    if (!enrolled && !account) return;
                    void (account ? run(remoteControlOff) : Promise.resolve())
                      .then(() => routerKey.refresh())
                      .catch(() => undefined);
                  },
                }),
              // Not a CloudError: Cloud was unreachable.
              catch: (error) =>
                new ProtocolError({
                  reason: error instanceof CloudError ? enrollReason(error.status) : "internal",
                  message: `Could not start the Caveman sign-in: ${(error as Error).message}`,
                }),
            });
            // Whoever approves the code links this computer, but drives it only from a device this Mac allows on its own
            // screen (session-protocol/devices.ts): Remote control follows sync again, as on a first sign-in (S13).
            yield* remoteControlFollowsSync;
            return {
              user_code: p.user_code,
              verification_uri: p.verification_uri,
              verification_uri_complete: p.verification_uri_complete,
              expires_at: p.expires_at,
            };
          }),
    "cloud.signout": (p) =>
      cloud
        ? fail("invalid_state", "a Cloud computer is enrolled by the computers service")
        : Effect.gen(function* () {
            // T2: what Cloud holds for this person goes first, unless they said to keep it.
            const copiesLeft =
              p.delete_cloud_copies !== false ? yield* deleteCloudCopies : undefined;
            signin.current?.cancel();
            signin.current = signin.error = undefined;
            const dir = linkDirOf(stateDir);
            const problem = yield* Effect.promise(() =>
              signOut({ dir, identity: readIdentity(dir), token: cloudLink.token }),
            );
            yield* Effect.promise(routerKey.clear);
            yield* Effect.promise(() => accountSignOut(accountStore));
            yield* clearCredits.pipe(Effect.ignore);
            // The proxies read the signed-out sign-in from here; bringing one back up is the proxy pass's (index.ts),
            // whose spawn and readiness poll a sign-out never waits on.
            yield* Effect.promise(writeAppProxyCloud);
            if (problem)
              yield* Effect.logWarning(
                `Signed out of Caveman Cloud here; Cloud was not told: ${problem}`,
              );
            yield* remoteControlOff;
            return copiesLeft === undefined ? {} : { cloud_copies_error: copiesLeft };
          }),
  };
  return handlers;
};
