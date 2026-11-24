// ), apps/server/src/provider/Drivers/CodexDriver.test.ts @ ab3a3cd1.
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ResetCreditCoordinator from "../resetCreditCoordinator.ts";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as ModelManifest from "../ModelManifest.ts";
import {
  createProviderVersionAdvisory,
  resolveLatestProviderVersion,
} from "@caveman-app/engine-core/server/maintenanceResolver";
import { CodexDriver } from "./CodexDriver.ts";
import * as CodexAdapterV2 from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as ProviderCredentialStore from "../ProviderCredentialStore.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-codex-driver-maintenance-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.mock(CodexAdapterV2.CodexAppServerClientFactory)({
      open: () => Effect.die("Maintenance resolution must not open a Codex session"),
    }),
  ),
  Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
  Layer.provideMerge(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("00000000-0000-4000-8000-000000000001")),
    }),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(ResetCreditCoordinator.layerTest),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Codex must not make an HTTP request")),
    ),
  ),
);
const layerTest = ProviderHostLive.layer.pipe(Layer.provideMerge(layerDeps));

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const noSpawn = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Codex must not spawn a process"),
);
const encodeCredentials = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

it.layer(layerTest)("CodexDriver", (it) => {
  it.effect("gives an API-key account an app-managed home and in-app sign-in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const apiKey = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex_key"),
        displayName: "Codex (API key)",
        enabled: false,
        environment: [],
        config: CodexDriver.defaultConfig(),
      });
      const home = NodePath.resolve(stateDir, "providers", "codex", "codex_key", "home");
      const snapshot = yield* apiKey.snapshot.getSnapshot;
      expect(snapshot.continuation?.groupKey).toBe(`codex:home:${home}`);
      expect(snapshot.setup).toEqual({ canAuthenticate: true, canInstall: false });
      expect(apiKey.auth).toBeDefined();
      expect(yield* fs.exists(home)).toBe(true);
      // Skipped on Windows: no POSIX mode bits (a directory reports 0666); the profile's ACL keeps it the user's.
      if (process.platform !== "win32") expect((yield* fs.stat(home)).mode & 0o777).toBe(0o700);

      // The user's own Codex login waits for OpenAI's approval: opt-in, no in-app sign-in.
      const ownLogin = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex_own"),
        displayName: "Codex (ChatGPT)",
        enabled: false,
        environment: [],
        config: { ...CodexDriver.defaultConfig(), chatGptLogin: true },
      });
      expect(ownLogin.auth).toBeUndefined();
      // Its login is the CLI's own: no in-app sign-in or install.
      expect((yield* ownLogin.snapshot.getSnapshot).setup).toEqual({
        canAuthenticate: false,
        canInstall: false,
      });
      expect(yield* fs.exists(NodePath.join(stateDir, "providers", "codex", "codex_own"))).toBe(
        false,
      );
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );


  it.effect.skipIf(windowsHost)(
    "runs the standalone updater against the shared home, not the shadow home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-driver-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const sharedHome = NodePath.join(tempDir, "codex-home");
        const shadowHome = NodePath.join(tempDir, "codex-shadow");
        const binaryPath = NodePath.join(sharedHome, "packages", "standalone", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-shadow"),
          displayName: "Codex test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: sharedHome,
            shadowHomePath: shadowHome,
          },
        });

        const capabilities = yield* instance.snapshot.resolveMaintenance();
        expect(capabilities.update).toMatchObject({
          executable: binaryPath,
          args: ["update"],
          lockKey: "codex-native",
          env: { CODEX_HOME: sharedHome },
        });
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
  );

  it.effect("uses each own-login instance's environment CODEX_HOME for continuation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-codex-driver-" });
      for (const [index, account] of ["work", "personal", "work "].entries()) {
        const codexHome = NodePath.join(tempDir, account);
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`account-${index}`),
          displayName: account,
          enabled: false,
          environment: [{ name: "CODEX_HOME", value: codexHome, sensitive: false }],
          config: { ...CodexDriver.defaultConfig(), chatGptLogin: true },
        });
        expect(instance.continuationIdentity.continuationKey).toBe(`codex:home:${codexHome}`);
      }
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const instance = yield* CodexDriver.create({
        instanceId: ProviderInstanceId.make("codex-missing"),
        displayName: "Codex test",
        enabled: false,
        environment: [],
        config: {
          ...CodexDriver.defaultConfig(),
          binaryPath: NodePath.join(NodeOS.tmpdir(), "t3-codex-missing", "codex"),
        },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn), Effect.scoped),
  );

  for (const fixture of [
    {
      name: "leaves mise npm-backend installations manual-only",
      installSegments: ["mise", "installs", "npm-openai-codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "leaves mise tool aliases backed by npm manual-only",
      installSegments: ["mise", "installs", "codex", "0.110.0"],
      npmOwned: false,
    },
    {
      name: "keeps npm updates for globals in a mise Node installation",
      installSegments: ["mise", "installs", "node", "24.0.0"],
      npmOwned: true,
    },
    {
      name: "keeps npm updates for ordinary global installations",
      installSegments: ["npm-global"],
      npmOwned: true,
    },
  ] as const) {
    it.effect.skipIf(windowsHost)(fixture.name, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-installer-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const installPath = NodePath.join(tempDir, ...fixture.installSegments);
        const realBinaryPath = NodePath.join(
          installPath,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        const binaryPath = NodePath.join(tempDir, "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(realBinaryPath), { recursive: true });
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(realBinaryPath, "#!/bin/sh\n");
        yield* fs.chmod(realBinaryPath, 0o755);
        yield* fs.symlink(realBinaryPath, binaryPath);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-installer"),
          displayName: "Codex installer test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        const update = (yield* instance.snapshot.resolveMaintenance()).update;
        if (fixture.npmOwned) {
          expect(update).toMatchObject({
            executable: "npm",
            args: [
              "install",
              "-g",
              "--prefix",
              installPath,
              "--allow-scripts=@openai/codex",
              "@openai/codex@latest",
            ],
          });
        } else {
          expect(update).toBeNull();
        }
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  for (const layout of ["direct", "wrapper"] as const) {
    it.effect.skipIf(windowsHost)(`leaves a mise ${layout} installation manual-only`, () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: `t3-codex-mise-${layout}-` })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const binaryPath =
          layout === "direct"
            ? NodePath.join(tempDir, "mise", "installs", "codex", "0.110.0", "codex")
            : NodePath.join(tempDir, "omarchy", "bin", "codex");
        yield* fs.makeDirectory(NodePath.dirname(binaryPath), { recursive: true });
        yield* fs.writeFileString(
          binaryPath,
          layout === "direct"
            ? "#!/bin/sh\n"
            : '#!/bin/sh\nmise use -g --quiet "codex" || exit 1\nexec mise x "codex" -- "codex" "$@"\n',
        );
        yield* fs.chmod(binaryPath, 0o755);

        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make(`codex-mise-${layout}`),
          displayName: "Codex mise test",
          enabled: false,
          environment: [],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        });

        expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawn),
        Effect.scoped,
      ),
    );
  }

  it.effect.each([
    {
      name: "conventional shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "custom data directory",
      dataRoot: "custom-tool-data",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "renamed configured command",
      dataRoot: "mise",
      commandName: "custom-codex",
      version: "0.153.4",
      nodeFirst: false,
    },
    {
      name: "outdated provider",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.3",
      nodeFirst: false,
    },
    {
      name: "npm before shim",
      dataRoot: "mise",
      commandName: "codex",
      version: "0.153.4",
      nodeFirst: true,
    },
  ])(
    "does not mistake Homebrew mise for Codex's installer: $name",
    (fixture) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const tempDir = yield* fs
          .makeTempDirectoryScoped({ prefix: "t3-codex-mise-shim-" })
          .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
        const brewPrefix = NodePath.join(tempDir, "homebrew");
        const brewPath = NodePath.join(brewPrefix, "bin", "brew");
        const misePath = NodePath.join(brewPrefix, "Cellar", "mise", "2026.9.1", "bin", "mise");
        const shimDir = NodePath.join(tempDir, fixture.dataRoot, "shims");
        const npmPrefix = NodePath.join(tempDir, "mise", "installs", "node", "24.13.0");
        const npmBin = NodePath.join(npmPrefix, "bin");
        const npmEntry = NodePath.join(
          npmPrefix,
          "lib",
          "node_modules",
          "@openai",
          "codex",
          "bin",
          "codex.js",
        );
        for (const file of [brewPath, misePath, npmEntry]) {
          yield* fs.makeDirectory(NodePath.dirname(file), { recursive: true });
          yield* fs.writeFileString(file, "#!/bin/sh\n");
          yield* fs.chmod(file, 0o755);
        }
        yield* fs.makeDirectory(shimDir, { recursive: true });
        yield* fs.makeDirectory(npmBin, { recursive: true });
        yield* fs.symlink(misePath, NodePath.join(shimDir, fixture.commandName));
        yield* fs.symlink(npmEntry, NodePath.join(npmBin, fixture.commandName));
        const lookupPath = [
          ...(fixture.nodeFirst ? [npmBin, shimDir] : [shimDir, npmBin]),
          NodePath.dirname(brewPath),
        ].join(NodePath.delimiter);
        const probes: Array<ReadonlyArray<string>> = [];
        const metadataSpawner = ChildProcessSpawner.make((command) => {
          if (!ChildProcess.isStandardCommand(command) || command.command !== brewPath) {
            return Effect.die("Provider resolution must not execute a provider or updater");
          }
          probes.push(command.args.map(String));
          const stdout =
            command.args[0] === "--prefix"
              ? brewPrefix
              : JSON.stringify({ formulae: [{ versions: { stable: "2026.9.1" } }] });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.encodeText(Stream.make(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        const instance = yield* CodexDriver.create({
          instanceId: ProviderInstanceId.make("codex-mise-shim"),
          displayName: "Codex shim test",
          enabled: false,
          environment: [{ name: "PATH", value: lookupPath, sensitive: false }],
          config: {
            ...CodexDriver.defaultConfig(),
            binaryPath: fixture.commandName,
            homePath: NodePath.join(tempDir, "codex-home"),
          },
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, metadataSpawner));
        const capabilities = yield* instance.snapshot
          .resolveMaintenance()
          .pipe(Effect.provideService(HostProcess.Environment, { PATH: "" }));
        const latestVersion = yield* resolveLatestProviderVersion(capabilities).pipe(
          Effect.provideServiceEffect(
            ProviderLatestVersions.ProviderLatestVersions,
            ProviderLatestVersions.make([["@openai/codex", "0.153.4"]]),
          ),
        );
        expect(probes).toEqual([]);
        expect(latestVersion).toBe("0.153.4");
        expect(
          createProviderVersionAdvisory({
            driver: CodexDriver.driverKind,
            currentVersion: fixture.version,
            latestVersion,
            maintenanceCapabilities: capabilities,
          }),
        ).toMatchObject({
          status: fixture.version === "0.153.4" ? "current" : "behind_latest",
          currentVersion: fixture.version,
          latestVersion: "0.153.4",
          canUpdate: fixture.nodeFirst,
        });
        if (fixture.nodeFirst) {
          expect(capabilities.update).toMatchObject({
            executable: "npm",
            args: expect.arrayContaining([
              "--prefix",
              yield* fs.realPath(npmPrefix),
              "@openai/codex@latest",
            ]),
          });
        } else {
          expect(capabilities.update).toBeNull();
        }
      }).pipe(Effect.scoped),
    { skip: windowsHost },
  );
});
