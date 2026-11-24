// ), apps/server/src/provider/ProviderHostLive.ts @ ab3a3cd1.
/**
 * The server's implementation of `ProviderHost.ProviderHost`, the only server surface
 * provider drivers and adapters may use.
 *
 * @module provider/ProviderHostLive
 */
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { ProviderCredentialError } from "@caveman-app/engine-core/server/errors";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import { makePathRefresh } from "../os-jank.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as DocumentText from "./DocumentText.ts";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import * as ProviderKeySeal from "./ProviderKeySeal.ts";
import { routingCredential } from "../router/routerKey.ts";
import { computerCreditsSource } from "../cloudLink/computerCredits.ts";
import { computerKeySource } from "../cloudLink/modelConnections.ts";

export const layer = Layer.effect(
  ProviderHost.ProviderHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const serverSettings = yield* ServerSettings.ServerSettingsService;
    const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const digest = yield* Digest.Digest;
    const fileSystem = yield* FileSystem.FileSystem;
    // Credentials are sealed at rest under a key in the runtime's secret store (ProviderKeySeal).
    const seal = yield* ProviderKeySeal.make;
    // A Cloud computer's Caveman chats pay from its person's credits: a short-lived key Cloud mints its runtime, in
    // memory only (cloudLink/computerCredits.ts). None on This Mac.
    const credits = yield* computerCreditsSource;
    // And where its person's credentials stay outside it, their own keys stay in Cloud: the engine's key slots are
    // stand-ins for their key connections (cloudLink/modelConnections.ts). None on This Mac.
    const connections = yield* computerKeySource;
    // On Windows, PATH read again from the registry before each probe (os-jank.ts).
    const refreshEnvironment = yield* makePathRefresh;
    return ProviderHost.ProviderHost.of({
      routing: routingCredential,
      ...(credits === undefined ? {} : { credits }),
      ...(connections === undefined ? {} : { connections }),
      paths: {
        cwd: config.cwd,
        baseDir: config.baseDir,
        stateDir: config.stateDir,
        providerStatusCacheDir: config.providerStatusCacheDir,
        attachmentsDir: config.attachmentsDir,
      },
      settings: {
        get: serverSettings.getSettings,
        withSnapshot: serverSettings.withSettingsSnapshot,
        changes: serverSettings.streamChanges,
        subscribe: serverSettings.subscribeChanges,
      },
      shouldRunBackgroundWork: backgroundPolicy.shouldRunScopeWork,
      refreshEnvironment,
      resolveAttachmentPath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment }),
      resolveExtractedTextPath: (path) =>
        DocumentText.resolveExtractedTextPath(path).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
        ),
      credentials: (namespace, bindingId) =>
        ProviderCredentialStore.make(namespace, bindingId).pipe(
          Effect.map((store) => ({
            binding: store.binding,
            get: store.get.pipe(
              Effect.flatMap((stored) =>
                stored._tag === "None"
                  ? Effect.succeed(stored)
                  : seal.open(stored.value, store.binding.key).pipe(
                      Effect.flatMap(
                        Option.match({
                          // Sealed by an older runtime under a key in the OS keychain: gone, and dropped so a new one can be added.
                          onNone: () => store.remove.pipe(Effect.ignore, Effect.as(Option.none<Uint8Array>())),
                          // A blob from before sealing is sealed on its first read; a failed write keeps it readable.
                          onSome: ({ plain, legacy }) =>
                            (legacy ? seal.seal(plain, store.binding.key).pipe(Effect.flatMap(store.set), Effect.ignore) : Effect.void).pipe(Effect.as(Option.some(plain))),
                        }),
                      ),
                    ),
              ),
              Effect.mapError((cause) => new ProviderCredentialError({ operation: "get", cause })),
            ),
            set: (credentials: Uint8Array) =>
              seal
                .seal(credentials, store.binding.key)
                .pipe(
                  Effect.flatMap(store.set),
                  Effect.mapError(
                    (cause) => new ProviderCredentialError({ operation: "set", cause }),
                  ),
                ),
            remove: store.remove.pipe(
              Effect.mapError(
                (cause) => new ProviderCredentialError({ operation: "remove", cause }),
              ),
            ),
          })),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
          Effect.provideService(Digest.Digest, digest),
        ),
    });
  }),
);
