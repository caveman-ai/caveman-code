// This Mac's connections (macConnections.ts) on the runtime's own stores: a Claude plan token's copy sealed with the
// provider-key seal (AES-256-GCM under a random key in the runtime's secret store, never the OS keychain; sealing and
// opening put it in the egress scrub, as every provider key is), and the last list Cloud gave in the runtime's
// key-value store (names, order and state only).
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ProviderKeySeal from "../provider/ProviderKeySeal.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { readIdentity } from "./identity.ts";
import { CloudComputer, CloudLinkState, linkDirOf } from "./index.ts";
import {
  joinMacConnections,
  MacConnections,
  macConnectionsOf,
  type RememberedList,
  type SealedTokens,
} from "./macConnections.ts";
import type { ModelConnectionList } from "./modelConnections.ts";

/** The secret store's name for a connection's sealed token. */
export const sealedTokenName = (connectionId: string) => `model-connection-${connectionId}`;
/** kv: the person's connections as Cloud last listed them, for when Cloud cannot be reached. No secret is in it. */
export const REMEMBERED_CONNECTIONS = "cloud.model_connections";

/**
 * This runtime's connections on a Mac, made once per runtime. Undefined on a Cloud computer (nothing of a person's is
 * kept there) and on a runtime with no secret store to keep a token's copy in.
 */
export const makeMacConnections = Effect.gen(function* () {
  if ((yield* CloudComputer) !== undefined) return undefined;
  const link = yield* CloudLinkState;
  const made = macConnectionsOf(link);
  if (made !== undefined) return made;
  const secrets = yield* Effect.serviceOption(ServerSecretStore);
  if (Option.isNone(secrets)) return undefined;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* SessionStore;
  const seal = yield* ProviderKeySeal.make.pipe(
    Effect.provideService(ServerSecretStore, secrets.value),
  );
  const aad = (connectionId: string) => `model-connection:${connectionId}`;
  const sealed: SealedTokens = {
    get: (connectionId) =>
      Effect.runPromise(
        secrets.value.get(sealedTokenName(connectionId)).pipe(
          Effect.flatMap((stored) =>
            Option.isNone(stored)
              ? Effect.succeed(Option.none())
              : seal.open(stored.value, aad(connectionId)),
          ),
          Effect.map((opened) => {
            if (Option.isNone(opened)) return undefined;
            try {
              const parsed = JSON.parse(new TextDecoder().decode(opened.value.plain)) as {
                readonly key?: unknown;
              };
              return typeof parsed.key === "string" && parsed.key !== "" ? parsed.key : undefined;
            } catch {
              return undefined;
            }
          }),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    // `key`: ProviderKeySeal puts every `key` it seals or opens in the egress scrub.
    set: (connectionId, token) =>
      Effect.runPromise(
        seal.seal(new TextEncoder().encode(JSON.stringify({ key: token })), aad(connectionId)).pipe(
          Effect.flatMap((bytes) => secrets.value.set(sealedTokenName(connectionId), bytes)),
          Effect.mapError(() => new Error("Could not keep the connection's token on this Mac.")),
        ),
      ),
    remove: (connectionId) =>
      Effect.runPromise(secrets.value.remove(sealedTokenName(connectionId)).pipe(Effect.ignore)),
  };
  const remembered: RememberedList = {
    get: () =>
      Effect.runPromise(
        store.kvGet(REMEMBERED_CONNECTIONS).pipe(
          Effect.map((raw) =>
            raw === undefined ? undefined : (JSON.parse(raw) as ModelConnectionList),
          ),
          Effect.orElseSucceed(() => undefined),
        ),
      ),
    set: (list) =>
      Effect.runPromise(
        store.kvSet(REMEMBERED_CONNECTIONS, JSON.stringify(list)).pipe(Effect.ignore),
      ),
  };
  const linkDir = linkDirOf(config.stateDir);
  const connections = new MacConnections({
    identity: () => readIdentity(linkDir),
    link,
    sealed,
    remembered,
    stateDir: config.stateDir,
  });
  joinMacConnections(link, connections);
  return connections;
});
