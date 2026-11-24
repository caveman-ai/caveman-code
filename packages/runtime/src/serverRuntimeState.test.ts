// ), apps/server/src/serverRuntimeState.test.ts @ ab3a3cd1.
// @effect-diagnostics nodeBuiltinImport:off - Injects a real file replacement during the native SQLite transaction.
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vitest";

import { discoverRuntime, runtimeTokenPath } from "@caveman-app/shared/runtimeDiscovery";
import * as ProcessRunner from "./processRunner.ts";
import * as ServerOwnership from "./serverOwnership.ts";
import * as ServerRuntimeState from "./serverRuntimeState.ts";

const isServerRuntimeStateError = Schema.is(ServerRuntimeState.ServerRuntimeStateError);

interface CapturedLog {
  readonly message: unknown;
  readonly annotations: Readonly<Record<string, unknown>>;
}

describe("server ownership", () => {
  const layerOwnership = ProcessRunner.layer.pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  const makeState = ServerRuntimeState.makePersistedServerRuntimeState({
    config: { host: undefined, devUrl: undefined },
    port: 3773,
  });

  it.effect("lets only one of two racing starts own a state directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-race-" });
      const statePath = path.join(root, "server-runtime.json");
      const attempts = yield* Effect.all(
        [
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
          ServerOwnership.acquireServerOwnership(statePath).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      assert.equal(attempts.filter((result) => result._tag === "Success").length, 1);
      const refused = attempts.find((result) => result._tag === "Failure");
      assert.equal(refused?.failure._tag, "ServerAlreadyRunningError");
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("refuses a second owner without touching its record, then allows a restart", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          const before = yield* fs.readFileString(statePath);
          const refused = yield* ServerOwnership.acquireServerOwnership(statePath).pipe(
            Effect.flip,
          );
          assert.equal(refused._tag, "ServerAlreadyRunningError");
          assert.include(refused.message, "do not delete it while a server is running");
          assert.equal(yield* fs.readFileString(statePath), before);
        }),
      );
      assert.isFalse(yield* fs.exists(statePath));
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  describe.skipIf(HostProcess.Platform.defaultValue() === "win32")("lock file checks", () => {
    it.effect.each([
      "unchanged",
      "unlink",
      "replace",
      "during acquisition",
      "first acquisition",
      // Root bypasses directory permissions, so chmod cannot force EACCES.
      ...(process.getuid?.() === 0 ? [] : (["stat error"] as const)),
    ] as const)("monitors ownership after %s", (operation) => {
      const messages: unknown[] = [];
      const warnings: unknown[] = [];
      const logger = Logger.make(({ message, logLevel }) =>
        (logLevel === "Warn" ? warnings : messages).push(message),
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-lost-" });
        const statePath = path.join(root, "server-runtime.json");
        const lockPath = path.join(root, "server-owner.sqlite");
        const replacement = path.join(root, "replacement.sqlite");
        if (operation === "during acquisition" || operation === "first acquisition") {
          if (operation === "during acquisition") yield* fs.writeFileString(lockPath, "");
          yield* fs.writeFileString(replacement, "");
          const exec = NodeSqlite.DatabaseSync.prototype.exec;
          yield* Effect.acquireRelease(
            Effect.sync(() =>
              vi.spyOn(NodeSqlite.DatabaseSync.prototype, "exec").mockImplementationOnce(function (
                this: NodeSqlite.DatabaseSync,
                sql: string,
              ) {
                exec.call(this, sql);
                NodeFS.renameSync(replacement, lockPath);
              }),
            ),
            (spy) => Effect.sync(() => spy.mockRestore()),
          );
        }
        yield* ServerOwnership.acquireServerOwnership(statePath);
        if (operation === "unlink") {
          yield* fs.remove(lockPath);
        } else if (operation === "replace") {
          yield* fs.writeFileString(replacement, "");
          yield* fs.rename(replacement, lockPath);
        }
        if (operation === "stat error") {
          yield* fs.chmod(root, 0);
          yield* TestClock.adjust("15 seconds").pipe(
            Effect.ensuring(fs.chmod(root, 0o700).pipe(Effect.orDie)),
          );
          assert.deepEqual(warnings, [
            [`Cannot check server ownership lock at ${lockPath} (EACCES).`],
          ]);
          yield* TestClock.adjust("5 seconds");
          assert.deepEqual(messages, []);
          yield* fs.remove(lockPath);
        }
        yield* TestClock.adjust("5 seconds");
        const expected =
          operation === "unchanged"
            ? []
            : [
                [
                  `Server ownership lock at ${lockPath} was deleted or replaced. Another Caveman Code runtime may now share this home. Stop any other runtime using it, then restart this one. Do not delete server-owner.sqlite while a server is running.`,
                ],
              ];
        assert.deepEqual(messages, expected);
        if (operation !== "unchanged") {
          yield* fs.remove(`${lockPath}-journal`, { force: true });
          yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
        }
        yield* TestClock.adjust("15 seconds");
        assert.deepEqual(messages, expected);
        assert.lengthOf(warnings, operation === "stat error" ? 1 : 0);
      }).pipe(
        Effect.provide(
          Layer.merge(layerOwnership, Logger.layer([logger], { mergeWithExisting: false })),
        ),
      );
    });
  });

  it.effect("refuses beside a live pre-lock server and ignores a stale record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-legacy-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        // @effect-diagnostics-next-line globalDateInEffect:off - Legacy identity uses the real process start time, not TestClock.
        state: { ...state, startedAt: new Date().toISOString() },
      });
      const refused = yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath)).pipe(
        Effect.flip,
      );
      assert.equal(refused._tag, "ServerAlreadyRunningError");
      yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: { ...state, pid: 0 },
      });
      yield* Effect.scoped(ServerOwnership.acquireServerOwnership(statePath));
    }).pipe(Effect.provide(layerOwnership)),
  );

  it.effect("never removes a runtime record another server published", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-cleanup-" });
      const statePath = path.join(root, "server-runtime.json");
      const state = yield* makeState;
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
          yield* owner.publish(state);
          yield* ServerRuntimeState.persistServerRuntimeState({
            path: statePath,
            state: { ...state, ownerId: "other-owner" },
          });
        }),
      );
      const remaining = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);
      assert.equal(Option.getOrThrow(remaining).ownerId, "other-owner");
    }).pipe(Effect.provide(layerOwnership)),
  );

  // Umask 0002 is the login default on Fedora and on Ubuntu with user-private groups.
  it.effect.skipIf(process.platform === "win32")(
    "publishes a record discovery trusts when the runtime starts under umask 0002",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-owner-umask-" });
        const stateDir = path.join(home, "userdata");
        const statePath = path.join(stateDir, "server-runtime.json");
        yield* Effect.acquireRelease(
          Effect.sync(() => process.umask(0o002)),
          (previous) => Effect.sync(() => process.umask(previous)),
        );
        yield* fs.makeDirectory(stateDir);
        yield* fs.chmod(stateDir, 0o700);
        yield* fs.writeFileString(runtimeTokenPath(home), "token", { mode: 0o600 });
        const state = yield* makeState;
        yield* Effect.scoped(
          Effect.gen(function* () {
            const owner = yield* ServerOwnership.acquireServerOwnership(statePath);
            yield* owner.publish(state);
            const recordMode = ((yield* fs.stat(statePath)).mode & 0o777).toString(8);
            // TestClock dates the record 1970, which the pid-reuse check would read as a reused pid.
            const found = discoverRuntime(home, { startedAt: () => undefined });
            assert.equal(
              found?.pid,
              process.pid,
              `server-runtime.json was published ${recordMode}`,
            );
          }),
        );
      }).pipe(Effect.provide(layerOwnership)),
  );
});

describe("serverRuntimeState", () => {
  it.effect("persists and reads the runtime state", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "runtime", "server.json");
      const state: ServerRuntimeState.PersistedServerRuntimeState = {
        version: 1,
        pid: 123,
        host: "127.0.0.1",
        port: 4_971,
        origin: "http://127.0.0.1:4971",
        devUrl: "http://localhost:5733/",
        startedAt: "2026-06-20T00:00:00.000Z",
      };

      yield* ServerRuntimeState.persistServerRuntimeState({ path: statePath, state });
      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.deepEqual(Option.getOrThrow(restored), state);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("records the dev web URL when the server fronts a dev server", () =>
    Effect.gen(function* () {
      const state = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: new URL("http://localhost:5733") },
        port: 13_773,
      });

      assert.equal(state.devUrl, "http://localhost:5733/");
      assert.equal(state.origin, "http://127.0.0.1:13773");

      const withoutDev = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });
      assert.isFalse("devUrl" in withoutDev);
    }),
  );

  it.effect("marks a service-supervised server so CLIs can tell it from a manual one", () =>
    Effect.gen(function* () {
      const managed = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
        serviceManaged: true,
      });
      const manual = yield* ServerRuntimeState.makePersistedServerRuntimeState({
        config: { host: undefined, devUrl: undefined },
        port: 13_773,
      });

      assert.isTrue(managed.serviceManaged);
      // Older readers decode the file without the field, so it is omitted
      // rather than written as false.
      assert.isFalse("serviceManaged" in manual);
    }),
  );

  it.effect("treats a missing runtime state file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );

  it.effect("preserves malformed state decode failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.writeFileString(statePath, "{not json");

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to decode server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "decode");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to decode server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "SchemaError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("preserves runtime state read failures", () => {
    const logs: CapturedLog[] = [];
    const logger = Logger.make(({ fiber, message }) => {
      logs.push({
        message,
        annotations: fiber.getRef(References.CurrentLogAnnotations),
      });
    });

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const statePath = path.join(root, "server.json");
      yield* fileSystem.makeDirectory(statePath);

      const restored = yield* ServerRuntimeState.readPersistedServerRuntimeState(statePath);

      assert.isTrue(Option.isNone(restored));
      assert.equal(logs[0]?.message, `Failed to read server runtime state at ${statePath}.`);
      const error = logs[0]?.annotations.cause;
      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "read");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to read server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mergeAll(NodeServices.layer, NodeCrypto.layer),
          Logger.layer([logger], { mergeWithExisting: false }),
        ),
      ),
    );
  });

  it.effect("preserves runtime state persistence failures", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-server-runtime-state-test-",
      });
      const blockedDirectory = path.join(root, "not-a-directory");
      const statePath = path.join(blockedDirectory, "server.json");
      yield* fileSystem.writeFileString(blockedDirectory, "blocked");

      const error = yield* ServerRuntimeState.persistServerRuntimeState({
        path: statePath,
        state: {
          version: 1,
          pid: 123,
          port: 4_971,
          origin: "http://127.0.0.1:4971",
          startedAt: "2026-06-20T00:00:00.000Z",
        },
      }).pipe(Effect.flip);

      assert.isTrue(isServerRuntimeStateError(error));
      if (isServerRuntimeStateError(error)) {
        assert.equal(error.operation, "persist");
        assert.equal(error.statePath, statePath);
        assert.equal(error.message, `Failed to persist server runtime state at ${statePath}.`);
        assert.deepInclude(error.cause, { _tag: "PlatformError" });
      }
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
  );
});
