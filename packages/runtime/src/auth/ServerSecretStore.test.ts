// ), apps/server/src/auth/ServerSecretStore.test.ts @ ab3a3cd1.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as PlatformError from "effect/PlatformError";

import * as ServerConfig from "../config.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const layerServerConfig = () =>
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-secret-store-test-" });

const layerServerSecretStore = () => Layer.provide(ServerSecretStore.layer, layerServerConfig());

const layerPermissionDeniedFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      readFile: (path) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "readFile",
            pathOrDescriptor: path,
            description: "Permission denied while reading secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerPermissionDeniedSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerPermissionDeniedFileSystem),
  );

const layerRenameFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      rename: (from, to) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "rename",
            pathOrDescriptor: `${String(from)} -> ${String(to)}`,
            description: "Permission denied while persisting secret file.",
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerRenameFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRenameFailureFileSystem),
  );

const layerRemoveFailureFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;

    return {
      ...fileSystem,
      remove: (path, options) =>
        Effect.fail(
          PlatformError.systemError({
            _tag: "PermissionDenied",
            module: "FileSystem",
            method: "remove",
            pathOrDescriptor: String(path),
            description: `Permission denied while removing secret file.${options ? " options-set" : ""}`,
          }),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerRemoveFailureSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerRemoveFailureFileSystem),
  );

const layerConcurrentReadMissFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const readCountRef = yield* Ref.make(0);
    const readBarrier = yield* Deferred.make<void>();

    return {
      ...fileSystem,
      readFile: (path) =>
        /[\\/]session-signing-key\.bin$/.test(String(path))
          ? Ref.updateAndGet(readCountRef, (count) => count + 1).pipe(
              Effect.flatMap((count) => {
                if (count > 2) {
                  return fileSystem.readFile(path);
                }
                return Effect.gen(function* () {
                  if (count === 2) {
                    yield* Deferred.succeed(readBarrier, void 0);
                  }
                  yield* Deferred.await(readBarrier);
                  return yield* Effect.failCause(
                    Cause.fail(
                      PlatformError.systemError({
                        _tag: "NotFound",
                        module: "FileSystem",
                        method: "readFile",
                        pathOrDescriptor: String(path),
                        description: "Secret file does not exist yet.",
                      }),
                    ),
                  );
                });
              }),
            )
          : fileSystem.readFile(path),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerConcurrentCreateSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerConcurrentReadMissFileSystem),
  );

const layerFirstWriteFailsFileSystem = Layer.effect(
  FileSystem.FileSystem,
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const failedRef = yield* Ref.make(false);

    return {
      ...fileSystem,
      open: (path, options) =>
        fileSystem.open(path, options).pipe(
          Effect.map((file) =>
            Object.create(file, {
              writeAll: {
                value: (buffer: Uint8Array) =>
                  Ref.getAndSet(failedRef, true).pipe(
                    Effect.flatMap((alreadyFailed) =>
                      alreadyFailed
                        ? file.writeAll(buffer)
                        : Effect.fail(
                            PlatformError.systemError({
                              _tag: "Unknown",
                              module: "FileSystem",
                              method: "write",
                              pathOrDescriptor: String(path),
                              description: "ENOSPC: no space left on device",
                            }),
                          ),
                    ),
                  ),
              },
            }),
          ),
        ),
    } satisfies FileSystem.FileSystem;
  }),
).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const layerFirstWriteFailsSecretStore = () =>
  ServerSecretStore.layer.pipe(
    Layer.provide(layerServerConfig()),
    Layer.provideMerge(layerFirstWriteFailsFileSystem),
  );

/** Holds every write until released, and reports the first read that starts once a write is under way. */
const layerGatedWriteFileSystem = (gate: {
  readonly writing: Deferred.Deferred<void>;
  readonly readDuringWrite: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;

      return {
        ...fileSystem,
        readFile: (path) =>
          fileSystem
            .readFile(path)
            .pipe(
              Effect.ensuring(
                Deferred.isDone(gate.writing).pipe(
                  Effect.flatMap((writing) =>
                    writing
                      ? Deferred.succeed(gate.readDuringWrite, void 0)
                      : Effect.succeed(false),
                  ),
                ),
              ),
            ),
        open: (path, options) =>
          fileSystem.open(path, options).pipe(
            Effect.map((file) =>
              Object.create(file, {
                writeAll: {
                  value: (buffer: Uint8Array) =>
                    Deferred.succeed(gate.writing, void 0).pipe(
                      Effect.andThen(Deferred.await(gate.release)),
                      Effect.andThen(file.writeAll(buffer)),
                    ),
                },
              }),
            ),
          ),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

/**
 * A disk that keeps written bytes in memory until they are synced but records
 * names (creates, renames, links) at once, an order POSIX allows and delayed
 * allocation produces. `onDisk` holds what each file would contain after a
 * power loss.
 */
const layerPowerLossFileSystem = (onDisk: Map<string, Uint8Array>) =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const unsynced = new Uint8Array();
      const record = (path: string, bytes: Uint8Array) =>
        Effect.sync(() => {
          onDisk.set(path, bytes);
        });

      return {
        ...fileSystem,
        writeFile: (path, data, options) =>
          fileSystem.writeFile(path, data, options).pipe(Effect.tap(() => record(path, unsynced))),
        open: (path, options) =>
          fileSystem.open(path, options).pipe(
            Effect.tap(() =>
              options?.flag?.startsWith("w") ? record(path, unsynced) : Effect.void,
            ),
            Effect.map((file) =>
              Object.create(file, {
                sync: {
                  get: () =>
                    file.sync.pipe(
                      Effect.andThen(fileSystem.readFile(path)),
                      Effect.flatMap((bytes) => record(path, Uint8Array.from(bytes))),
                    ),
                },
              }),
            ),
          ),
        rename: (from, to) =>
          fileSystem.rename(from, to).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                onDisk.set(to, onDisk.get(from) ?? unsynced);
                onDisk.delete(from);
              }),
            ),
          ),
        link: (from, to) =>
          fileSystem
            .link(from, to)
            .pipe(Effect.tap(() => record(to, onDisk.get(from) ?? unsynced))),
        remove: (path, options) =>
          fileSystem.remove(path, options).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                onDisk.delete(path);
              }),
            ),
          ),
      } satisfies FileSystem.FileSystem;
    }),
  ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const writeStoredSecret = (name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFile(path.join(secretStore.directory!, `${name}.bin`), bytes);
  });

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("ServerSecretStore.layer", (it) => {
  it.effect("returns Option.none when a secret file does not exist", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const secret = yield* secretStore.get("missing-secret");

      assert.isTrue(Option.isNone(secret));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("reuses an existing secret instead of regenerating it", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const first = yield* secretStore.getOrCreateRandom("session-signing-key", 32);
      const second = yield* secretStore.getOrCreateRandom("session-signing-key", 32);

      assert.deepEqual(Array.from(second), Array.from(first));
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("returns the persisted secret when concurrent creators race", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const [first, second] = yield* Effect.all(
        [
          secretStore.getOrCreateRandom("session-signing-key", 32),
          secretStore.getOrCreateRandom("session-signing-key", 32),
        ],
        { concurrency: "unbounded" },
      );
      const persisted = yield* secretStore.get("session-signing-key");
      const persistedBytes = Option.getOrThrow(persisted);

      assert.deepEqual(Array.from(first), Array.from(persistedBytes));
      assert.deepEqual(Array.from(second), Array.from(persistedBytes));
    }).pipe(Effect.provide(layerConcurrentCreateSecretStore())),
  );

  it.effect("uses restrictive permissions for the secret directory and files", () =>
    Effect.gen(function* () {
      const chmodCalls: Array<{ readonly path: string; readonly mode: number }> = [];
      const layerRecordingFileSystem = Layer.effect(
        FileSystem.FileSystem,
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;

          return {
            ...fileSystem,
            rename: () => Effect.void,
            chmod: (path, mode) =>
              Effect.sync(() => {
                chmodCalls.push({ path: String(path), mode });
              }),
          } satisfies FileSystem.FileSystem;
        }),
      ).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        yield* secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3]));
      }).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerRecordingFileSystem),
          ),
        ),
      );

      assert.isTrue(
        chmodCalls.some((call) => call.mode === 0o700 && /[\\/]secrets$/.test(call.path)),
      );
      assert.isAtLeast(chmodCalls.filter((call) => call.mode === 0o600).length, 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("propagates read failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("session-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStoreReadError);
      assert.include(error.message, "Failed to read secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerPermissionDeniedSecretStore())),
  );

  it.effect("propagates write failures instead of treating them as success", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(
        secretStore.set("session-signing-key", Uint8Array.from([1, 2, 3])),
      );

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.include(error.message, "Failed to persist secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRenameFailureSecretStore())),
  );

  it.effect("propagates remove failures other than missing-file errors", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;

      const error = yield* Effect.flip(secretStore.remove("session-signing-key"));

      assert.instanceOf(error, ServerSecretStore.SecretStoreRemoveError);
      assert.include(error.message, "Failed to remove secret session-signing-key.");
      assert.instanceOf(error.cause, PlatformError.PlatformError);
      assert.equal((error.cause as PlatformError.PlatformError).reason._tag, "PermissionDenied");
    }).pipe(Effect.provide(layerRemoveFailureSecretStore())),
  );

  it.effect("refuses to replace a secret that already exists when creating one", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const fileSystem = yield* FileSystem.FileSystem;

      yield* secretStore.create("secret-request-first", Uint8Array.from([1, 2, 3]));
      const error = yield* Effect.flip(
        secretStore.create("secret-request-first", Uint8Array.from([4, 5, 6])),
      );

      assert.isTrue(ServerSecretStore.isSecretAlreadyExistsError(error));
      assert.deepEqual(
        Array.from(Option.getOrThrow(yield* secretStore.get("secret-request-first"))),
        [1, 2, 3],
      );
      assert.deepEqual(yield* fileSystem.readDirectory(secretStore.directory!), [
        "secret-request-first.bin",
      ]);
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("replaces a key that an interrupted creation left empty or short", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* writeStoredSecret("server-signing-key", new Uint8Array());
      yield* writeStoredSecret("provider-key-seal", Uint8Array.from([1, 2, 3, 4]));

      for (const name of ["server-signing-key", "provider-key-seal"]) {
        const key = yield* secretStore.getOrCreateRandom(name, 32);
        const persisted = Option.getOrThrow(yield* secretStore.get(name));

        assert.strictEqual(key.length, 32, `${name} came back with the wrong length`);
        assert.deepEqual(Array.from(persisted), Array.from(key));
      }
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("agrees on one replacement when concurrent callers find a short key", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      yield* writeStoredSecret("asset-access-signing-key", new Uint8Array());

      const keys = yield* Effect.all(
        Array.from({ length: 4 }, () =>
          secretStore.getOrCreateRandom("asset-access-signing-key", 32),
        ),
        { concurrency: "unbounded" },
      );
      const persisted = Option.getOrThrow(yield* secretStore.get("asset-access-signing-key"));

      assert.strictEqual(persisted.length, 32);
      for (const key of keys) {
        assert.deepEqual(Array.from(key), Array.from(persisted));
      }
    }).pipe(Effect.provide(layerServerSecretStore())),
  );

  it.effect("leaves no secret behind when writing a new one fails", () =>
    Effect.gen(function* () {
      const secretStore = yield* ServerSecretStore.ServerSecretStore;
      const fileSystem = yield* FileSystem.FileSystem;

      const error = yield* Effect.flip(secretStore.getOrCreateRandom("server-signing-key", 32));

      assert.instanceOf(error, ServerSecretStore.SecretStorePersistError);
      assert.isTrue(
        Option.isNone(yield* secretStore.get("server-signing-key")),
        "the failed write left a key file behind",
      );
      assert.deepEqual(yield* fileSystem.readDirectory(secretStore.directory!), []);
      const key = yield* secretStore.getOrCreateRandom("server-signing-key", 32);
      assert.strictEqual(key.length, 32);
    }).pipe(Effect.provide(layerFirstWriteFailsSecretStore())),
  );

  it.effect("keeps a saved credential whole when power is lost right after saving it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const onDisk = new Map<string, Uint8Array>();
      const credential = new TextEncoder().encode('{"apiKey":"sk-test-saved-key"}');

      yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        yield* secretStore.set("provider-auth-binding", credential);

        for (const [path, bytes] of onDisk) {
          yield* fileSystem.writeFile(path, bytes);
        }

        assert.deepEqual(
          Array.from(Option.getOrThrow(yield* secretStore.get("provider-auth-binding"))),
          Array.from(credential),
          "the saved credential did not survive the power loss",
        );
      }).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerPowerLossFileSystem(onDisk)),
          ),
        ),
      );
    }),
  );

  it.effect("never hands a concurrent caller a secret that is still being written", () =>
    Effect.gen(function* () {
      const gate = {
        writing: yield* Deferred.make<void>(),
        readDuringWrite: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      return yield* Effect.gen(function* () {
        const secretStore = yield* ServerSecretStore.ServerSecretStore;
        const creator = yield* Effect.forkChild(
          secretStore.getOrCreateRandom("asset-access-signing-key", 32),
        );
        yield* Deferred.await(gate.writing);
        const racer = yield* Effect.forkChild(
          secretStore.getOrCreateRandom("asset-access-signing-key", 32),
        );
        yield* Deferred.await(gate.readDuringWrite);
        yield* Deferred.succeed(gate.release, void 0);
        const created = yield* Fiber.join(creator);
        const raced = yield* Fiber.join(racer);
        const persisted = Option.getOrThrow(yield* secretStore.get("asset-access-signing-key"));

        assert.strictEqual(raced.length, 32, "the racing caller got a partial key");
        assert.deepEqual(Array.from(created), Array.from(persisted));
        assert.deepEqual(Array.from(raced), Array.from(persisted));
      }).pipe(
        Effect.provide(
          ServerSecretStore.layer.pipe(
            Layer.provide(layerServerConfig()),
            Layer.provideMerge(layerGatedWriteFileSystem(gate)),
          ),
        ),
      );
    }),
  );
});
