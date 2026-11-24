// ), packages/provider-grok/src/server/driver.test.ts @ 13aa882c22.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import { resolveLatestProviderVersion } from "@caveman-app/engine-core/server/maintenanceResolver";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import { GrokDriver } from "./driver.ts";

import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import { createModelSelection } from "@caveman-app/shared/model";

const plainEnv = (env: Readonly<Record<string, string | Redacted.Redacted<string> | undefined>> | undefined): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env ?? {}).map(([name, value]) => [name, Redacted.isRedacted(value) ? Redacted.value(value) : value]));

const layerTest = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ProviderLatestVersions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Grok must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Grok must not spawn a process"),
);

/** Answers every spawn with `onSpawn(command, args)` on stdout, like a stub `brew`. */
function stdoutSpawner(onSpawn: (command: string, args: ReadonlyArray<string>) => string) {
  return ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.encodeText(Stream.make(onSpawn(executable, args))),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
}

// The `#!/bin/sh` stub below cannot be resolved as an executable on Windows.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

it.layer(layerTest)("GrokDriver", (it) => {
  it.effect.skipIf(windowsHost)("updates through the configured executable's own updater", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-driver-" });
      const grokHome = path.join(tempDir, "Grok Home");
      const binaryPath = path.join(grokHome, "bin", "grok");
      yield* fs.makeDirectory(path.dirname(binaryPath), { recursive: true });
      yield* fs.writeFileString(binaryPath, "#!/bin/sh\n");
      yield* fs.chmod(binaryPath, 0o755);

      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-update"),
        displayName: "Grok test",
        enabled: false,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        config: { ...GrokDriver.defaultConfig(), binaryPath },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.packageName).toBe("@xai-official/grok");
      expect(capabilities.update).toMatchObject({
        command: `'${binaryPath}' update`,
        executable: binaryPath,
        args: ["update"],
      });
      expect(capabilities.update?.env?.GROK_HOME).toBe(grokHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  // Each case puts a stub `brew` at `<prefix>/bin/brew` beside the Grok binary.
  const homebrewCases = [
    {
      name: "upgrades a Homebrew grok-build cask through brew",
      binary: ["Caskroom", "grok-build", "1.2.3,456", "grok"],
      reportedPrefix: "own",
      // The cask's version is read later, by the update check (T3 #19581).
      brewArgs: [["--prefix"]],
      latestVersion: "1.2.4",
      reportsInstallPath: false,
      update: (brewPath: string, _binaryPath: string) => ({
        command: "brew upgrade --cask grok-build",
        executable: brewPath,
        args: ["upgrade", "--cask", "grok-build"],
        lockKey: "homebrew",
      }),
    },
    {
      // `grok update` would install a second copy beside the cask.
      name: "stays manual-only for a cask another brew prefix owns",
      binary: ["Caskroom", "grok-build", "1.2.3", "grok"],
      reportedPrefix: "/opt/homebrew",
      brewArgs: [["--prefix"]],
      latestVersion: undefined,
      // The manual-update hint names the binary Caveman Code runs.
      reportsInstallPath: true,
      update: () => null,
    },
    {
      // A formula keg such as `node` holding an npm global is not Grok's owner.
      name: "keeps grok update for an npm global inside a Homebrew node keg",
      binary: [
        "Cellar",
        "node",
        "22",
        "lib",
        "node_modules",
        "@xai-official",
        "grok",
        "bin",
        "grok",
      ],
      reportedPrefix: "own",
      brewArgs: [],
      latestVersion: undefined,
      reportsInstallPath: false,
      update: (_brewPath: string, binaryPath: string) => ({
        executable: binaryPath,
        args: ["update"],
        lockKey: "grok",
        // npm 12 otherwise skips the postinstall that installs the new binary.
        env: expect.objectContaining({ npm_config_allow_scripts: "@xai-official/grok" }),
      }),
    },
  ] as const;

  for (const testCase of homebrewCases) {
    it.effect.skipIf(windowsHost)(testCase.name, () => {
      const brewArgs: Array<ReadonlyArray<string>> = [];
      let prefix = "";
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        prefix = yield* fs.realPath(yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-brew-" }));
        const brewPath = path.join(prefix, "bin", "brew");
        const binaryPath = path.join(prefix, ...testCase.binary);
        for (const executable of [brewPath, binaryPath]) {
          yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
          yield* fs.writeFileString(executable, "#!/bin/sh\n");
          yield* fs.chmod(executable, 0o755);
        }

        const instance = yield* GrokDriver.create({
          instanceId: ProviderInstanceId.make("grok-homebrew"),
          displayName: "Grok test",
          enabled: false,
          environment: [],
          config: { ...GrokDriver.defaultConfig(), binaryPath },
        });
        const capabilities = yield* instance.snapshot.resolveMaintenance();

        const update = testCase.update(brewPath, binaryPath);
        expect(brewArgs).toEqual(testCase.brewArgs);
        expect(capabilities.update).toEqual(update && expect.objectContaining(update));
        expect(capabilities.installPath).toBe(
          testCase.reportsInstallPath ? binaryPath : undefined,
        );
        if (testCase.latestVersion !== undefined) {
          expect(yield* resolveLatestProviderVersion(capabilities)).toBe(testCase.latestVersion);
          expect(brewArgs).toEqual([...testCase.brewArgs, ["info", "--json=v2", "grok-build"]]);
        }
      }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          stdoutSpawner((command, args) => {
            expect(command).toBe(`${prefix}/bin/brew`);
            brewArgs.push(args);
            if (args[0] === "--prefix") {
              return `${testCase.reportedPrefix === "own" ? prefix : testCase.reportedPrefix}\n`;
            }
            return JSON.stringify({ casks: [{ version: "1.2.4,789" }] });
          }),
        ),
        Effect.scoped,
      );
    });
  }

  it.effect("keeps the runtime's own variables off the Grok it runs for text generation", () => {
    const runtimeOnly = {
      CAVEMAN_CODE_DEV_AUTH_TOKEN: "runtime-dev-token",
      CAVEMAN_CODE_OTLP_HEADERS: "authorization=Bearer runtime-otlp",
      CAVEMAN_CLOUD_LINK_DIR: "/cloud/link",
      CAVEMAN_WORKSPACE_ROOT: "/cloud/workspace",
    };
    const launches: Array<{ readonly args: ReadonlyArray<string>; readonly env: NodeJS.ProcessEnv }> =
      [];
    return Effect.gen(function* () {
      // The runtime's own env, as the runtime process holds it.
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          const saved = Object.keys(runtimeOnly).map((name) => [name, process.env[name]] as const);
          Object.assign(process.env, runtimeOnly);
          return saved;
        }),
        (saved) =>
          Effect.sync(() => {
            for (const [name, value] of saved) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }),
      );
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-text-env"),
        displayName: "Grok test",
        enabled: true,
        environment: [],
        config: GrokDriver.defaultConfig(),
      });
      yield* instance.textGeneration
        .generateThreadTitle({
          cwd: process.cwd(),
          message: "wire up grok",
          modelSelection: createModelSelection(ProviderInstanceId.make("grok-text-env"), "grok-build"),
        })
        .pipe(Effect.ignore);
      // The text generation agent, and any status probe the enabled instance started meanwhile.
      expect(launches.filter((launch) => launch.args.includes("stdio"))).toHaveLength(1);
      for (const launch of launches) {
        expect(
          Object.fromEntries(Object.keys(runtimeOnly).map((name) => [name, launch.env[name]])),
        ).toEqual(Object.fromEntries(Object.keys(runtimeOnly).map((name) => [name, undefined])));
      }
    }).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        ChildProcessSpawner.make((command) => {
          if (command._tag === "StandardCommand") {
            launches.push({ args: command.args.map((arg) => (Redacted.isRedacted(arg) ? Redacted.value(arg) : arg)), env: plainEnv(command.options.env) });
          }
          return Effect.fail(
            PlatformError.systemError({ _tag: "NotFound", module: "grok-text-env", method: "spawn" }),
          );
        }),
      ),
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.scoped,
    );
  });

  it.effect("stays manual-only when the configured executable does not exist", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-grok-missing-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok-missing"),
        displayName: "Grok test",
        enabled: false,
        environment: [],
        config: { ...GrokDriver.defaultConfig(), binaryPath: path.join(tempDir, "grok") },
      });
      expect((yield* instance.snapshot.resolveMaintenance()).update).toBeNull();
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
