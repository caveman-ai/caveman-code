// Ported from T3 Code (MIT), packages/provider-acp-registry/src/server/AcpRegistrySupport.test.ts @ ab3a3cd1.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AcpRegistrySearchInput,
  AcpRegistrySearchResult,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@caveman-app/protocol";
import { AcpRegistrySettings } from "../settings.ts";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { SpawnExecutableResolution } from "@caveman-app/shared/shell";
import { cliArchiveTarCommand } from "@caveman-app/shared/cliRelease";
import { findGitBash } from "@caveman-app/shared/posixShell";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import { acpAgentEnvironment } from "./agentEnvironment.ts";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";

const registryUrl = "https://registry.test/registry.json";
/**
 * Most cases simulate a Linux host. The ones that look up real files on this machine take
 * Windows' own rules on Windows (';'-separated PATH, PATHEXT): a `C:\` path is no Linux path.
 */
const windowsHost = process.platform === "win32";
const localPlatform: NodeJS.Platform = windowsHost ? "win32" : "linux";
/** The registry target and command suffix of a binary agent for `localPlatform` on x64. */
const localTarget = windowsHost ? "windows-x86_64" : "linux-x86_64";
const localExe = windowsHost ? ".exe" : "";
const localPathDelimiter = windowsHost ? ";" : ":";
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
/** A PATH that starts with `directory`, as a pattern. */
const pathStartingWith = (directory: string) =>
  expect.stringMatching(new RegExp(`^${escapeRegExp(directory)}${localPathDelimiter}`, "u"));
const archiveUrl = "https://registry.test/example-agent.bin";
const decodeAcpRegistrySettings = Schema.decodeSync(AcpRegistrySettings);
const decodeSearchInput = Schema.decodeEffect(AcpRegistrySearchInput);
const decodeSearchResult = Schema.decodeEffect(AcpRegistrySearchResult);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

function makeAgent(
  distribution: AcpRegistrySupport.AcpRegistryAgent["distribution"],
): AcpRegistrySupport.AcpRegistryAgent {
  return {
    id: "example-agent",
    name: "Example Agent",
    version: "1.2.3",
    description: "ACP Registry test agent",
    distribution,
  };
}

function makeRegistry(agent: AcpRegistrySupport.AcpRegistryAgent): string {
  return JSON.stringify({ version: "1.0.0", agents: [agent] });
}

function settings(input: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings {
  return decodeAcpRegistrySettings({
    agentId: "example-agent",
    ...input,
  });
}

function layerResolver(
  execute: Parameters<typeof HttpClient.make>[0],
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = "linux",
) {
  return Layer.mergeAll(
    NodeServices.layer,
    NodeCrypto.layer,
    TestProviderHost.layer().pipe(
      Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    ),
    Layer.succeed(HostProcess.Platform, platform),
    Layer.succeed(HostProcess.Architecture, "x64"),
    Layer.succeed(HostProcess.Environment, environment),
    Layer.succeed(HttpClient.HttpClient, HttpClient.make(execute)),
  );
}

/** A POSIX shell word for `value`. */
const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/**
 * Installs a fake package manager from a `#!/bin/sh` fixture. Windows runs no `#!` script, so
 * there the command is a `.cmd` that hands the fixture to Git Bash, as npm's own shims are .cmd.
 * Its settings go beside it, so it also runs on the contained environment an ACP agent's install
 * gets; a variable the caller's environment sets still wins.
 */
const installFakeCommand = Effect.fn("AcpRegistrySupport.test.installFakeCommand")(function* (
  fixture: string,
  directory: string,
  name: string,
  fakeSettings: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const source = yield* path.fromFileUrl(new URL(`./testing/${fixture}`, import.meta.url));
  const writeSettings = (script: string) =>
    fileSystem.writeFileString(
      `${script}.env`,
      Object.entries(fakeSettings)
        .map(([variable, value]) => `[ -n "\${${variable}+set}" ] || export ${variable}=${shellWord(value)}\n`)
        .join(""),
    );
  if (!windowsHost) {
    const command = path.join(directory, name);
    yield* fileSystem.copyFile(source, command);
    yield* fileSystem.chmod(command, 0o755);
    yield* writeSettings(command);
    return command;
  }
  const bash = findGitBash();
  if (bash === undefined) return yield* Effect.die("These fakes need Git for Windows' bash.");
  const script = path.join(directory, `${name}.sh`);
  yield* fileSystem.copyFile(source, script);
  yield* writeSettings(script);
  const command = path.join(directory, `${name}.cmd`);
  yield* fileSystem.writeFileString(command, `@"${bash}" "${script}" %*\r\n`);
  return command;
});

const makeFakeNpmToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeNpmToolchain")(function* (
  rootDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toolchainBin = path.join(rootDirectory, "fake-node", "bin");
  const globalPrefix = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "npm");
  // npm puts Windows command shims in the prefix itself; the resolver names them in PATHEXT's case.
  const globalBin = windowsHost ? globalPrefix : path.join(globalPrefix, "bin");
  const executablePath = path.join(globalBin, windowsHost ? "example-agent.CMD" : "example-agent");
  const logPath = path.join(rootDirectory, "npm.log");
  yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
  yield* fileSystem.makeDirectory(globalPrefix, { recursive: true });
  yield* fileSystem.writeFileString(logPath, "");
  const fakeSettings = {
    FAKE_NPM_LOG: logPath,
    FAKE_NPM_PREFIX: path.join(rootDirectory, "external-npm-global"),
    FAKE_NPM_MANIFEST: encodeUnknownJson({
      name: "@example/acp",
      version: "1.2.3",
      bin: { "example-agent": "dist/cli.js" },
    }),
  };
  const npmPath = yield* installFakeCommand(
    "AcpRegistrySupport.npm.fixture.sh",
    toolchainBin,
    "npm",
    fakeSettings,
  );
  return {
    environment: {
      ...process.env,
      PATH: `${toolchainBin}${localPathDelimiter}${process.env.PATH ?? ""}`,
      ...fakeSettings,
    } satisfies NodeJS.ProcessEnv,
    executablePath,
    globalBin,
    logPath,
    npmPath,
  };
});

const makeFakeUvToolchain = Effect.fn("AcpRegistrySupport.test.makeFakeUvToolchain")(function* (
  rootDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toolchainBin = path.join(rootDirectory, "fake-uv", "bin");
  const globalBin = path.join(rootDirectory, "tools", "example-agent", "1.2.3", "python", "bin");
  // uv's Windows launchers are .exe; the resolver names them in PATHEXT's case.
  const executablePath = path.join(globalBin, windowsHost ? "fast-agent.EXE" : "fast-agent");
  const logPath = path.join(rootDirectory, "uv.log");
  yield* fileSystem.makeDirectory(toolchainBin, { recursive: true });
  yield* fileSystem.writeFileString(logPath, "");
  const fakeSettings = {
    FAKE_UV_LOG: logPath,
    FAKE_UV_BIN: path.join(rootDirectory, "external-uv-bin"),
    FAKE_UV_EXECUTABLE: executablePath,
  };
  const uvPath = yield* installFakeCommand(
    "AcpRegistrySupport.uv.fixture.sh",
    toolchainBin,
    "uv",
    fakeSettings,
  );
  return {
    environment: {
      ...process.env,
      PATH: `${toolchainBin}${localPathDelimiter}${process.env.PATH ?? ""}`,
      ...fakeSettings,
    } satisfies NodeJS.ProcessEnv,
    executablePath,
    globalBin,
    logPath,
    uvPath,
  };
});

describe("AcpRegistrySupport", () => {
  it("preserves the registry failure when translating it for clients", () => {
    const cause = new Error("registry unavailable");
    const failure = new AcpRegistrySupport.AcpRegistryError({
      reason: "registry_unavailable",
      detail: "Could not load the ACP Registry.",
      cause,
    });

    expect(AcpRegistrySupport.toAcpRegistryOperationError(failure)).toMatchObject({
      reason: "registry_unavailable",
      message: "Could not load the ACP Registry.",
      cause: failure,
    });
  });

  it("maps supported Node platforms to ACP Registry target keys", () => {
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("darwin", "arm64")).toBe(
      "darwin-aarch64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("linux", "x64")).toBe(
      "linux-x86_64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("win32", "arm64")).toBe(
      "windows-aarch64",
    );
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("freebsd", "x64")).toBeUndefined();
    expect(AcpRegistrySupport.resolveAcpRegistryPlatformTarget("linux", "ia32")).toBeUndefined();
  });

  it("selects the preferred compatible distribution", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp"],
        },
      },
      npx: {
        package: "@example/acp@1.2.3",
        args: ["--stdio"],
      },
    });

    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "auto",
        platformTarget: "linux-x86_64",
      }),
    ).toMatchObject({ kind: "binary", args: ["acp"] });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "npx",
        platformTarget: "linux-x86_64",
      }),
    ).toEqual({
      kind: "npx",
      packageName: "@example/acp@1.2.3",
      args: ["--stdio"],
      env: {},
    });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent,
        preference: "binary",
        platformTarget: "darwin-aarch64",
      }),
    ).toBeUndefined();
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent: makeAgent({
          binary: {
            "windows-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-x64.exe",
              args: ["acp"],
            },
          },
        }),
        preference: "auto",
        platformTarget: "windows-aarch64",
      }),
    ).toMatchObject({
      kind: "binary",
      binaryTarget: { cmd: "./bin/example-agent-x64.exe" },
    });
    expect(
      AcpRegistrySupport.resolveAcpRegistryDistribution({
        agent: makeAgent({
          binary: {
            "windows-aarch64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-arm64.exe",
              args: ["acp"],
            },
            "windows-x86_64": {
              archive: archiveUrl,
              cmd: "./bin/example-agent-x64.exe",
              args: ["acp"],
            },
          },
        }),
        preference: "auto",
        platformTarget: "windows-aarch64",
      }),
    ).toMatchObject({
      kind: "binary",
      binaryTarget: { cmd: "./bin/example-agent-arm64.exe" },
    });
  });

  it.effect("resolves a local command on the selected environment without the registry", () => {
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-local-" });
      // Windows finds `dsh` through PATHEXT, whose entries are upper case.
      const commandPath = path.join(cacheDir, windowsHost ? "dsh.EXE" : "dsh");
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const hostEnvironment = { PATH: "/missing-host-bin", INHERITED: "host", OVERRIDE: "host" };
      const environment = { ...hostEnvironment, PATH: cacheDir, OVERRIDE: "provider" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, hostEnvironment));
      const localSettings = decodeAcpRegistrySettings({
        source: "local",
        commandPath: "dsh",
        commandArgs: ["--profile", "acp", "", " spaced ", "$(touch injected); $VALUE"],
      });

      expect(yield* resolver.inspect(localSettings)).toMatchObject({ status: "missing_runner" });
      expect(yield* resolver.inspect(localSettings, environment)).toEqual({
        status: "ready",
        agentId: "dsh",
        version: null,
        distribution: "local",
      });
      const resolved = yield* resolver.resolve(localSettings, "/workspace", environment);
      expect(resolved).toEqual({
        distribution: "local",
        spawn: {
          command: commandPath,
          args: ["--profile", "acp", "", " spaced ", "$(touch injected); $VALUE"],
          cwd: "/workspace",
          env: environment,
          shell: false,
        },
      });
      expect(requests).toEqual([]);
      expect(yield* fileSystem.exists(`${cacheDir}/tools`)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) => {
            requests.push(request.url);
            return Effect.die("unexpected registry request for a local provider");
          },
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("resolves a local executable path and inherits the host environment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-local-path-" });
      const commandPath = `${cacheDir}/dsh wrapper`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const environment = { PATH: "/unused", INHERITED: "host" };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));
      const resolved = yield* resolver.resolve(
        decodeAcpRegistrySettings({ source: "local", commandPath }),
        "/workspace",
        environment,
      );

      expect(resolved.spawn).toEqual({
        command: commandPath,
        args: [],
        cwd: "/workspace",
        env: environment,
        shell: false,
      });
      expect(resolved.agent).toBeUndefined();

      for (const extension of [".cmd", ".BAT"]) {
        const windowsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(SpawnExecutableResolution, () => `C:\\bin\\dsh${extension}`),
        );
        const localSettings = decodeAcpRegistrySettings({ source: "local", commandPath: "dsh" });
        for (const failure of [
          yield* windowsResolver.inspect(localSettings).pipe(Effect.flip),
          yield* windowsResolver.resolve(localSettings, "/workspace", {}).pipe(Effect.flip),
        ]) {
          expect(failure).toMatchObject({
            reason: "runner_unavailable",
            detail: expect.stringContaining("node.exe"),
          });
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected registry request"))),
    ),
  );

  it.effect("reports missing or non-executable local commands without registry fallback", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-local-missing-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const environment = { PATH: cacheDir };
      const unconfigured = decodeAcpRegistrySettings({ source: "local" });
      expect(yield* resolver.inspect(unconfigured, environment)).toEqual({
        status: "unconfigured",
      });
      expect(
        yield* resolver.resolve(unconfigured, "/workspace", environment).pipe(Effect.flip),
      ).toMatchObject({ reason: "agent_not_configured" });

      // Without an execute bit; on Windows, without a PATHEXT extension.
      const nonExecutable = `${cacheDir}/non-executable`;
      yield* fileSystem.writeFileString(nonExecutable, "#!/bin/sh\n");
      yield* fileSystem.chmod(nonExecutable, 0o644);
      for (const commandPath of ["dsh", `${cacheDir}/missing`, cacheDir, nonExecutable]) {
        const localSettings = decodeAcpRegistrySettings({ source: "local", commandPath });
        expect(yield* resolver.inspect(localSettings, environment)).toEqual({
          status: "missing_runner",
          version: null,
          distribution: "local",
        });
        expect(
          yield* resolver.resolve(localSettings, "/workspace", environment).pipe(Effect.flip),
        ).toMatchObject({
          reason: "runner_unavailable",
          detail: "Local ACP executable is not available on this environment's PATH.",
        });
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(() => Effect.die("unexpected registry request"), process.env, localPlatform),
      ),
    ),
  );

  it.effect("resolves command overrides while preserving registry args and environment", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "./bin/example-agent",
          args: ["acp", "--stdio"],
          env: { REGISTRY_VALUE: "registry", OVERRIDE_ME: "registry" },
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-override-",
      });
      const commandPath = `${cacheDir}/example-agent`;
      yield* fileSystem.writeFileString(commandPath, "#!/bin/sh\n");
      yield* fileSystem.chmod(commandPath, 0o755);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings({ commandPath }), "/workspace", {
        HOST_VALUE: "host",
        OVERRIDE_ME: "host",
      });

      expect(resolved.distribution).toBe("binary");
      expect(resolved.spawn).toEqual({
        command: commandPath,
        args: ["acp", "--stdio"],
        cwd: "/workspace",
        env: {
          HOST_VALUE: "host",
          OVERRIDE_ME: "registry",
          REGISTRY_VALUE: "registry",
        },
      });
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("installs into T3 home a package and launches its exposed command", () => {
    const agent = makeAgent({
      npx: { package: "@example/acp@V1.2.3", args: ["--stdio"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-global-package-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));

      const first = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);
      const second = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(first.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--stdio"],
        env: { PATH: pathStartingWith(toolchain.globalBin) },
      });
      expect(second.spawn.command).toBe(toolchain.executablePath);
      const npmCommands = yield* fileSystem.readFileString(toolchain.logPath);
      expect(npmCommands.match(/^install --global /gmu)).toHaveLength(1);
      expect(npmCommands).toContain("install --global @example/acp@V1.2.3");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("uses its managed prefix despite a system-owned npm prefix", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-user-global-package-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const systemPrefix = path.join(cacheDir, "system-global");
      yield* fileSystem.makeDirectory(systemPrefix);
      yield* fileSystem.chmod(systemPrefix, 0o555);
      const userHome = path.join(cacheDir, "home");
      const environment = {
        ...toolchain.environment,
        HOME: userHome,
        FAKE_NPM_PREFIX: systemPrefix,
        // The person's own prefix in another spelling; Windows hands a child one spelling only.
        NPM_CONFIG_PREFIX: systemPrefix,
      };
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, environment));

      const resolved = yield* resolver.resolve(settings(), "/workspace", environment);
      const userGlobalBin = toolchain.globalBin;
      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        env: { PATH: pathStartingWith(userGlobalBin) },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("installs into T3 home a uv tool and launches its exposed command", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==V0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-global-uv-tool-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      const resolved = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--acp"],
        env: { PATH: pathStartingWith(toolchain.globalBin) },
      });
      expect(yield* fileSystem.readFileString(toolchain.logPath)).toContain(
        "tool install --force fast-agent-acp==V0.10.1",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("honors an exact Windows PATH override when launching a global package", () => {
    const agent = makeAgent({
      uvx: { package: "fast-agent-acp==0.10.1", args: ["--acp"] },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-windows-package-path-",
      });
      const toolchain = yield* makeFakeUvToolchain(cacheDir);
      const localResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* localResolver.resolve(settings(), "/workspace", toolchain.environment);

      const windowsEnvironment = {
        ...toolchain.environment,
        Path: "C:\\host\\bin",
        PATH: "C:\\provider\\bin",
      };
      const windowsResolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(SpawnExecutableResolution, (command) => {
          if (command === "uv") return toolchain.uvPath;
          if (command === "fast-agent") return toolchain.executablePath;
          return undefined;
        }),
      );
      const resolved = yield* windowsResolver.resolve(
        settings(),
        "C:\\workspace",
        windowsEnvironment,
      );

      expect(resolved.spawn).toMatchObject({
        env: { PATH: `${toolchain.globalBin};C:\\provider\\bin` },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("installs and reuses a registry binary in the managed cache", () => {
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    const agent = makeAgent({
      binary: {
        [localTarget]: {
          archive: archiveUrl,
          cmd: `./bin/example-agent${localExe}`,
          args: ["acp"],
          // SHA-256 of binaryBytes.
          sha256: "97b29a636d7ddf7bf3567ae4d48c0f2a9b03943fd808b6efbf74f1dd3db131b7",
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-install-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const path = yield* Path.Path;
      const first = yield* resolver.resolve(settings(), "/workspace", {});
      const second = yield* resolver.resolve(settings(), "/workspace", {});

      expect(first.spawn.command).toBe(second.spawn.command);
      expect(first.spawn.command).toContain(
        path.join("tools", "example-agent", "1.2.3", localTarget, "bin", `example-agent${localExe}`),
      );
      expect(yield* fileSystem.readFileString(first.spawn.command)).toBe(
        "#!/bin/sh\necho example\n",
      );
      expect(requests).toEqual([registryUrl, archiveUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) => {
            requests.push(request.url);
            const response =
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(
                    new ReadableStream<Uint8Array>({
                      start(controller) {
                        controller.enqueue(binaryBytes.slice(0, 8));
                        controller.enqueue(binaryBytes.slice(8));
                        controller.close();
                      },
                    }),
                  );
            return Effect.succeed(HttpClientResponse.fromWeb(request, response));
          },
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect(
    "prepares the registry version despite an older PATH binary and permits explicit overrides",
    () => {
      const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho managed\n");
      const agent = makeAgent({
        binary: {
          [localTarget]: {
            archive: archiveUrl,
            cmd: `./bin/example-agent${localExe}`,
            args: ["acp"],
            // SHA-256 of binaryBytes.
            sha256: "e1eb7c905b91c400af2ec858628aec22866bfda1383b93ceb73ae01d9769fb31",
          },
        },
      });
      const requests: Array<string> = [];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-system-",
        });
        const systemBinDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-system-bin-",
        });
        const systemBinary = path.join(systemBinDir, `example-agent${localExe}`);
        yield* fileSystem.writeFileString(systemBinary, "#!/bin/sh\necho system\n");
        yield* fileSystem.chmod(systemBinary, 0o755);
        const environment = { PATH: systemBinDir };

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        }).pipe(Effect.provideService(HostProcess.Environment, environment));
        yield* resolver.search({ query: "example" });
        expect(yield* resolver.inspect(settings(), environment)).toMatchObject({
          status: "unprepared",
        });

        const overridden = settings({ commandPath: systemBinary });
        expect(yield* resolver.inspect(overridden, environment)).toMatchObject({
          status: "ready",
          version: null,
        });
        const custom = yield* resolver.resolve(overridden, "/workspace", environment);
        expect(custom.spawn.command).toBe(systemBinary);
        expect(custom.spawn.args).toEqual(["acp"]);
        expect(requests).toEqual([registryUrl]);

        yield* resolver.prepare({ agentId: "example-agent" });
        const resolved = yield* resolver.resolve(settings(), "/workspace", environment);
        expect(resolved.spawn.command).not.toBe(systemBinary);
        expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
          "#!/bin/sh\necho managed\n",
        );
        expect(yield* fileSystem.readFileString(systemBinary)).toBe("#!/bin/sh\necho system\n");

        const inspection = yield* resolver.inspect(settings(), environment);
        expect(inspection).toMatchObject({
          status: "ready",
          distribution: "binary",
          version: "1.2.3",
        });

        expect(requests).toEqual([registryUrl, registryUrl, archiveUrl]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver(
            (request) => {
              requests.push(request.url);
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  request.url === registryUrl
                    ? new Response(makeRegistry(agent))
                    : new Response(binaryBytes.buffer as ArrayBuffer),
                ),
              );
            },
            process.env,
            localPlatform,
          ),
        ),
      );
    },
  );

  it.effect("installs a tar archive with a root entry and a listing larger than 1 MiB", () => {
    const downloadUrl = "https://registry.test/agent.tar.gz";
    // A real tar packs and unpacks it, so on Windows this is a Windows agent and System32's tar.
    const target = windowsHost ? "windows-x86_64" : "linux-x86_64";
    const command = windowsHost ? "agent.exe" : "agent";
    const binary = { archive: downloadUrl, cmd: `./${command}` };
    const agent = makeAgent({
      binary: windowsHost ? { "windows-x86_64": binary } : { "linux-x86_64": binary },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-root-entry-" });
      const source = `${cacheDir}/source`;
      yield* fileSystem.makeDirectory(source);
      yield* fileSystem.writeFileString(`${source}/${command}`, "#!/bin/sh\necho managed\n");
      // 5,000 long names list past the generic 1 MiB command output cap.
      const entries = `${source}/entries`;
      yield* fileSystem.makeDirectory(entries);
      yield* Effect.forEach(
        Array.from({ length: 5_000 }, (_, index) => index),
        (index) => fileSystem.writeFileString(`${entries}/${index}-${"e".repeat(240)}`, ""),
        { concurrency: 16 },
      );
      const archivePath = `${cacheDir}/agent.tar.gz`;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const tar = yield* spawner.spawn(
        ChildProcess.make(cliArchiveTarCommand(localPlatform, process.env), [
          "-czf",
          archivePath,
          "-C",
          source,
          ".",
        ]),
      );
      expect(yield* tar.exitCode).toBe(0);
      const archive = yield* fileSystem.readFile(archivePath);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response(archive),
              ),
            ),
          ),
        ),
      );
      yield* resolver.prepare({ agentId: agent.id });
      const resolved = yield* resolver.resolve(settings(), "/workspace", {});
      expect(resolved.spawn.command).toBe(
        yield* fileSystem.realPath(`${cacheDir}/tools/example-agent/1.2.3/${target}/${command}`),
      );
      expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe(
        "#!/bin/sh\necho managed\n",
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          TestProviderHost.layer().pipe(
            Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
          ),
        ),
      ),
      Effect.provideService(HostProcess.Platform, localPlatform),
      Effect.provideService(HostProcess.Architecture, "x64"),
    );
    // Writing 5,000 entries takes seconds on a loaded machine.
  }, 30_000);

  // ARM falls back to the x64 ZIP; x64 takes it natively. Both extract with System32's tar.
  it.effect.each(["arm64", "x64"] as const)(
    "prepares a Windows x64 ZIP on %s when PATH tar cannot read ZIP",
    (architecture) => {
      const downloadUrl = "https://registry.test/agent-windows-x64.zip";
      const agent = makeAgent({
        binary: { "windows-x86_64": { archive: downloadUrl, cmd: "./agent.exe" } },
        npx: { package: "@example/acp@1.2.3" },
      });
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-acp-arm-zip-" });
        const commands: Array<string> = [];
        const spawner = ChildProcessSpawner.make((command) =>
          Effect.gen(function* () {
            if (command._tag !== "StandardCommand") return yield* Effect.die("Unexpected pipeline");
            commands.push(command.command);
            // Simulate Git's GNU tar rejecting ZIP and System32 bsdtar listing/extracting it.
            const supportsZip = command.command === "C:\\Windows\\System32\\tar.exe";
            if (supportsZip && command.args[0] === "-xf") {
              const outputDirectory = command.args.map(String)[3];
              if (!outputDirectory) return yield* Effect.die("Missing extraction directory");
              yield* fileSystem.writeFileString(path.join(outputDirectory, "agent.exe"), "fixture");
            }
            return ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(1),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(supportsZip ? 0 : 1)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode(supportsZip ? "agent.exe\r\n" : "")),
              stderr: Stream.make(
                new TextEncoder().encode(supportsZip ? "" : "GNU tar cannot read ZIP"),
              ),
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            });
          }).pipe(Effect.orDie),
        );
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: path.join(cacheDir, "tools"),
          registryUrl,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Architecture, architecture),
          Effect.provideService(HostProcess.Environment, {
            SystemRoot: "C:\\Windows",
            PATH: "C:\\Program Files\\Git\\usr\\bin;C:\\Windows\\System32",
          }),
          Effect.provideService(SpawnExecutableResolution, (command) =>
            command === "tar" ? "C:\\Program Files\\Git\\usr\\bin\\tar.exe" : command,
          ),
        );
        yield* resolver.prepare({ agentId: agent.id });
        const resolved = yield* resolver.resolve(settings(), "/workspace", {});
        expect(resolved.spawn.command).toBe(
          yield* fileSystem.realPath(
            path.join(cacheDir, "tools", agent.id, agent.version, "windows-x86_64", "agent.exe"),
          ),
        );
        expect(yield* fileSystem.readFileString(resolved.spawn.command)).toBe("fixture");
        expect(commands).toEqual([
          "C:\\Windows\\System32\\tar.exe",
          "C:\\Windows\\System32\\tar.exe",
        ]);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response("ZIP fixture"),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect("searches compatible agents with deterministic ranking and bounded metadata", () => {
    const exact = {
      ...makeAgent({ npx: { package: "@example/acp@1.2.3" } }),
      id: "codex-acp",
      name: "Codex",
      authors: ["OpenAI", "Zed Industries"],
      license: "Apache-2.0",
      website: "https://example.test/codex",
      repository: "https://example.test/codex/source",
      icon: "https://example.test/codex.svg",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    const descriptionMatch = {
      ...makeAgent({ npx: { package: "other-agent@1.2.3" } }),
      id: "other-agent",
      name: "Other Agent",
      description: "An adapter for Codex workflows",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    const incompatible = {
      ...makeAgent({
        binary: {
          "darwin-aarch64": { archive: archiveUrl, cmd: "agent" },
        },
      }),
      id: "darwin-only",
      name: "Codex Darwin",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-search-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "codex" });

      expect(result.agents.map((agent) => agent.id)).toEqual(["codex-acp", "other-agent"]);
      expect(result.agents[0]).toMatchObject({
        authors: ["OpenAI", "Zed Industries"],
        distribution: "npx",
        integrity: "registry",
        license: "Apache-2.0",
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: "1.0.0",
                  agents: [descriptionMatch, incompatible, exact],
                }),
              ),
            ),
          ),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("searches reuse an index fetched in the last five minutes", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* Effect.all(
        [resolver.search({ query: "example" }), resolver.search({ query: "example" })],
        { concurrency: "unbounded" },
      );
      expect(requests).toBe(1);

      yield* TestClock.adjust("4 minutes");
      yield* resolver.search({ query: "other" });
      expect(requests).toBe(1);

      yield* TestClock.adjust("1 minute");
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.yieldNow.pipe(
            Effect.as(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          );
        }),
      ),
    );
  });

  it.effect("searches retry the network after falling back to the cached index", () => {
    // A runner agent would be found or not by the real host's PATH (Windows has no `npm` by
    // Linux rules); a binary agent for the simulated host keeps this case about the index alone.
    const agent = makeAgent({
      binary: {
        "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
      },
    });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-retry-",
      });
      yield* fileSystem.makeDirectory(`${cacheDir}/acp-registry`, { recursive: true });
      yield* fileSystem.writeFileString(
        `${cacheDir}/acp-registry/registry.json`,
        makeRegistry(agent),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const offline = yield* resolver.search({ query: "example" });
      expect(offline.agents.map((result) => result.id)).toEqual([agent.id]);
      expect(requests).toBe(1);

      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(2);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              requests === 1
                ? new Response("unavailable", { status: 503 })
                : new Response(makeRegistry(agent)),
            ),
          );
        }),
      ),
    );
  });

  it.effect("searches retry the network after a refresh falls back within the reuse window", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    let online = true;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-refresh-fallback-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(1);

      // Prepare always refreshes; an unknown agent stops it right after the refresh.
      online = false;
      const missing = yield* resolver.prepare({ agentId: "missing-agent" }).pipe(Effect.flip);
      expect(missing.reason).toBe("agent_not_found");
      expect(requests).toBe(2);

      online = true;
      yield* resolver.search({ query: "example" });
      expect(requests).toBe(3);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              online
                ? new Response(makeRegistry(agent))
                : new Response("unavailable", { status: 503 }),
            ),
          );
        }),
      ),
    );
  });

  it.effect("filters runner recipes that the environment cannot prepare", () => {
    const runnerAgent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    const binaryAgent = {
      ...makeAgent({
        binary: {
          "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
        },
      }),
      id: "binary-agent",
      name: "Binary Agent",
    } satisfies AcpRegistrySupport.AcpRegistryAgent;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-filter-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents.map((agent) => agent.id)).toEqual(["binary-agent"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({ version: "1.0.0", agents: [runnerAgent, binaryAgent] }),
                ),
              ),
            ),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("keeps default searches at 20 and honors larger catalog limits", () => {
    const base = makeAgent({
      binary: {
        "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
      },
    });
    const agents = Array.from({ length: 26 }, (_, index) => {
      const suffix = String(index).padStart(2, "0");
      return { ...base, id: `example-agent-${suffix}`, name: `Example Agent ${suffix}` };
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-limit-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const input = yield* decodeSearchInput({ query: "", limit: 512 });
      const catalog = yield* resolver.search(input).pipe(Effect.flatMap(decodeSearchResult));
      const limited = yield* resolver.search({ query: "", limit: 25 });
      const defaultCatalog = yield* resolver.search({ query: "" });
      const matches = yield* resolver.search({ query: "example" });

      expect(catalog.agents).toHaveLength(26);
      expect(limited.agents).toHaveLength(25);
      expect(defaultCatalog.agents).toHaveLength(20);
      expect(matches.agents).toHaveLength(20);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(JSON.stringify({ version: "1.0.0", agents })),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("discards registry agents with blank names or unsafe versions", () => {
    const distribution = {
      binary: {
        "linux-x86_64": { archive: archiveUrl, cmd: "example-agent" },
      },
    } satisfies AcpRegistrySupport.AcpRegistryAgent["distribution"];
    const valid = makeAgent(distribution);
    const blankName = { ...valid, id: "blank-name", name: "   " };
    const blankVersion = { ...valid, id: "blank-version", version: "\t" };
    const parentVersion = { ...valid, id: "parent-version", version: ".." };
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-blank-fields-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents.map((agent) => agent.id)).toEqual([valid.id]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  version: "1.0.0",
                  agents: [blankName, blankVersion, parentVersion, valid],
                }),
              ),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("ignores unpinned runner recipes from the registry", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@latest" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-unpinned-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const result = yield* resolver.search({ query: "" });

      expect(result.agents).toEqual([]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
        ),
      ),
    );
  });

  it.effect("rejects package syntax for the wrong runner", () => {
    const invalidAgents = [
      { ...makeAgent({ npx: { package: "example-agent==1.2.3" } }), id: "bad-npx" },
    ];
    const validAgents = [
      { ...makeAgent({ uvx: { package: "minion-code@0.1.44" } }), id: "valid-at" },
      { ...makeAgent({ uvx: { package: "fast-agent-acp==0.9.30" } }), id: "valid-equals" },
    ];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-syntax-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const invalid = yield* resolver.prepare({ agentId: "bad-npx" }).pipe(Effect.flip);
      const validAt = yield* resolver.prepare({ agentId: "valid-at" }).pipe(Effect.flip);
      const validEquals = yield* resolver.prepare({ agentId: "valid-equals" }).pipe(Effect.flip);

      expect(invalid.reason).toBe("agent_not_found");
      expect(validAt.reason).toBe("runner_unavailable");
      expect(validEquals.reason).toBe("runner_unavailable");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({ version: "1.0.0", agents: [...invalidAgents, ...validAgents] }),
                ),
              ),
            ),
          { PATH: "" },
        ),
      ),
    );
  });

  it.effect("verifies declared SHA-256 before installing a binary", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "example-agent",
          sha256: "0".repeat(64),
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("not the declared binary");

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-checksum-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.prepare({ agentId: agent.id }).pipe(Effect.flip);

      expect(error.reason).toBe("checksum_mismatch");
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url === registryUrl
                ? new Response(makeRegistry(agent))
                : new Response(binaryBytes.buffer as ArrayBuffer),
            ),
          ),
        ),
      ),
    );
  });

  it.effect("installs into T3 home package recipes during preparation", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3", args: ["--stdio"] } });
    const requests: string[] = [];

    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-runner-",
      });
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      }).pipe(Effect.provideService(HostProcess.Environment, toolchain.environment));
      const prepared = yield* resolver.prepare({ agentId: agent.id });
      expect(prepared).toEqual({
        agentId: "example-agent",
        version: "1.2.3",
        distribution: "npx",
        prepared: true,
      });
      expect(yield* fileSystem.exists(toolchain.executablePath)).toBe(true);
      expect(yield* fileSystem.exists(toolchain.environment.FAKE_NPM_PREFIX)).toBe(false);
      expect(yield* fileSystem.readFileString(toolchain.logPath)).toContain(
        "install --global @example/acp@1.2.3",
      );
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) => {
            requests.push(request.url);
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
            );
          },
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect.each(["npx", "uvx"] as const)(
    "prepares a %s agent without the runtime's secrets reaching its install",
    (distribution) => {
      const agent = makeAgent(
        distribution === "npx"
          ? { npx: { package: "@example/acp@1.2.3", args: ["--stdio"] } }
          : { uvx: { package: "fast-agent-acp==0.10.1", args: ["--acp"] } },
      );
      const secrets = ["CAVEMAN_CODE_OTLP_HEADERS", "GITHUB_TOKEN", "OPENAI_API_KEY"];
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-prepare-contained-",
        });
        const toolchain =
          distribution === "npx"
            ? yield* makeFakeNpmToolchain(cacheDir)
            : yield* makeFakeUvToolchain(cacheDir);
        // The runtime's own environment, as HostProcess.Environment holds it in production.
        const runtimeEnvironment: NodeJS.ProcessEnv = {
          ...toolchain.environment,
          CAVEMAN_CODE_OTLP_HEADERS: "authorization=Bearer runtime-sentinel",
          GITHUB_TOKEN: "ghp_runtime_sentinel",
          OPENAI_API_KEY: "sk-runtime-sentinel",
        };

        yield* Effect.gen(function* () {
          const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
            cacheDir,
            toolsDir: `${cacheDir}/tools`,
            registryUrl,
          });
          yield* resolver.prepare({ agentId: agent.id });
          // A session then resolves the agent on its own contained environment.
          const sessionEnvironment = yield* acpAgentEnvironment("acp-registry", undefined);
          const resolved = yield* resolver.resolve(settings(), "/workspace", sessionEnvironment);
          expect(resolved.spawn.command).toBe(toolchain.executablePath);
        }).pipe(Effect.provideService(HostProcess.Environment, runtimeEnvironment));

        const log = (yield* fileSystem.readFileString(toolchain.logPath)).split("\n");
        expect({
          installs: log.filter((line) => /^(?:install --global|tool install) /u.test(line)).length,
          secretsSeenByInstall: log
            .filter((line) => line.startsWith("env "))
            .map((line) => line.slice("env ".length))
            .filter((variable) => secrets.includes(variable))
            .toSorted(),
        }).toEqual({
          // The session reused the prepared install, so it was the only one.
          installs: 1,
          secretsSeenByInstall: [],
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver(
            (request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
              ),
            process.env,
            localPlatform,
          ),
        ),
      );
    },
  );

  it.effect("falls back to a valid cached registry index when refresh fails", () => {
    const agent = makeAgent({
      npx: {
        package: "@example/acp@1.2.3",
        args: ["--stdio"],
      },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cache-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const resolved = yield* resolver.resolve(settings(), "/workspace", toolchain.environment);

      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        args: ["--stdio"],
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
            ),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("rejects unsafe command paths before downloading an archive", () => {
    const agent = makeAgent({
      binary: {
        "linux-x86_64": {
          archive: archiveUrl,
          cmd: "../outside",
        },
      },
    });
    const requests: Array<string> = [];
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-invalid-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.resolve(settings(), "/workspace", {}).pipe(Effect.flip);

      expect(error.reason).toBe("archive_invalid");
      expect(requests).toEqual([registryUrl]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests.push(request.url);
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
          );
        }),
      ),
    );
  });

  it.effect("inspects from disk without waiting for a registry refresh", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-cold-inspect-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const inspection = yield* resolver.inspect(settings());

      expect(inspection).toMatchObject({ status: "ready", agentId: agent.id });
      expect(requests).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) => {
            requests += 1;
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
            );
          },
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("fails a cold inspection immediately when no local registry is available", () => {
    let requests = 0;
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-empty-inspect-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const error = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(error.reason).toBe("registry_unavailable");
      expect(requests).toBe(0);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver((request) => {
          requests += 1;
          return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused")));
        }),
      ),
    );
  });

  it.effect("uses the effective provider environment for inspection and resolution", () => {
    const agent = makeAgent({ npx: { package: "@example/acp@1.2.3" } });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-effective-env-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));
      const toolchain = yield* makeFakeNpmToolchain(cacheDir);

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const hostInspection = yield* resolver.inspect(settings());
      const providerEnvironment = toolchain.environment;
      const instanceInspection = yield* resolver.inspect(settings(), providerEnvironment);
      const resolved = yield* resolver.resolve(settings(), "/workspace", providerEnvironment);

      expect(hostInspection).toMatchObject({ status: "missing_runner", runner: "npm" });
      expect(instanceInspection).toMatchObject({ status: "ready", distribution: "npx" });
      expect(resolved.spawn).toMatchObject({
        command: toolchain.executablePath,
        env: { PATH: pathStartingWith(toolchain.globalBin) },
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          { PATH: "" },
          localPlatform,
        ),
      ),
    );
  });

  it.effect("requires a regular executable file in the managed binary cache", () => {
    const agent = makeAgent({
      binary: {
        [localTarget]: {
          archive: archiveUrl,
          cmd: `bin/example-agent${localExe}`,
        },
      },
    });
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-non-file-",
      });
      const registryDirectory = `${cacheDir}/acp-registry`;
      const fakeExecutable = `${cacheDir}/tools/example-agent/1.2.3/${localTarget}/bin/example-agent${localExe}`;
      yield* fileSystem.makeDirectory(fakeExecutable, { recursive: true });
      yield* fileSystem.makeDirectory(registryDirectory, { recursive: true });
      yield* fileSystem.writeFileString(`${registryDirectory}/registry.json`, makeRegistry(agent));

      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      const directoryError = yield* resolver.inspect(settings()).pipe(Effect.flip);

      expect(directoryError.reason).toBe("archive_invalid");

      yield* fileSystem.remove(fakeExecutable, { recursive: true });
      yield* fileSystem.writeFileString(fakeExecutable, "#!/bin/sh\n");
      // Skipped on Windows: a file has no execute bit there.
      if (!windowsHost) {
        yield* fileSystem.chmod(fakeExecutable, 0o644);
        const modeError = yield* resolver.inspect(settings()).pipe(Effect.flip);

        expect(modeError.reason).toBe("archive_invalid");

        yield* fileSystem.chmod(fakeExecutable, 0o755);
      }
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "ready" });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent)))),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect.each([
    { name: "legacy registry", source: undefined, agentId: "example-agent", referenced: true },
    { name: "registry", source: "registry", agentId: "example-agent", referenced: true },
    { name: "padded registry", source: "registry", agentId: " example-agent ", referenced: true },
    { name: "local command", source: "local", agentId: "example-agent", referenced: false },
  ] as const)(
    "checks $name references before uninstalling only managed binaries",
    ({ source, agentId, referenced }) => {
      return Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-uninstall-",
        });
        const agentRoot = `${cacheDir}/tools/example-agent`;
        const runnerCache = `${cacheDir}/external-npx-cache/example-agent/package.json`;
        yield* fileSystem.makeDirectory(`${agentRoot}/1.2.3/linux-x86_64`, { recursive: true });
        yield* fileSystem.writeFileString(`${agentRoot}/1.2.3/linux-x86_64/agent`, "binary");
        yield* fileSystem.makeDirectory(`${cacheDir}/external-npx-cache/example-agent`, {
          recursive: true,
        });
        yield* fileSystem.writeFileString(runnerCache, "{}");

        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });
        const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
        const instanceId = ProviderInstanceId.make("uninstall-reference");
        yield* hostSettings.set({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Uninstall reference",
              enabled: true,
              config: {
                agentId,
                commandPath: "/local/agent",
                ...(source ? { source } : {}),
              },
            },
          },
        });
        const first = yield* resolver.uninstallManagedBinary({ agentId: "example-agent" });
        expect(first).toEqual({ agentId: "example-agent", removed: !referenced });
        expect(yield* fileSystem.exists(agentRoot)).toBe(referenced);
        yield* hostSettings.set(DEFAULT_SERVER_SETTINGS);
        const second = yield* resolver.uninstallManagedBinary({ agentId: "example-agent" });

        expect(second).toEqual({ agentId: "example-agent", removed: referenced });
        expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
          agentId: "example-agent",
          removed: false,
        });
        expect(yield* fileSystem.exists(agentRoot)).toBe(false);
        expect(yield* fileSystem.exists(runnerCache)).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver((request) =>
            Effect.succeed(HttpClientResponse.fromWeb(request, new Response("unused"))),
          ),
        ),
      );
    },
  );

  it.effect("keeps managed package installs when removing the same agent's binaries", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-uninstall-packages-",
      });
      const versionRoot = `${cacheDir}/tools/example-agent/1.2.3`;
      yield* fileSystem.makeDirectory(`${versionRoot}/linux-x86_64`, { recursive: true });
      yield* fileSystem.writeFileString(`${versionRoot}/linux-x86_64/agent`, "binary");
      yield* fileSystem.makeDirectory(`${versionRoot}/npm/bin`, { recursive: true });
      yield* fileSystem.writeFileString(`${versionRoot}/npm/bin/agent`, "package command");
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });
      expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
        agentId: "example-agent",
        removed: true,
      });
      expect(yield* fileSystem.exists(`${versionRoot}/linux-x86_64`)).toBe(false);
      expect(yield* fileSystem.readFileString(`${versionRoot}/npm/bin/agent`)).toBe(
        "package command",
      );
      expect(yield* resolver.uninstallManagedBinary({ agentId: "example-agent" })).toEqual({
        agentId: "example-agent",
        removed: false,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(layerResolver(() => Effect.die("unexpected HTTP request"))),
    ),
  );

  it.effect("keeps a binary prepared by another client while an uninstall is waiting", () => {
    const agent = makeAgent({
      binary: {
        [localTarget]: {
          archive: archiveUrl,
          cmd: `./bin/example-agent${localExe}`,
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const releaseDownload = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-uninstall-race-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });

        const prepareFiber = yield* resolver
          .prepare({ agentId: agent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(downloadStarted);
        const uninstallFiber = yield* resolver
          .uninstallManagedBinary({ agentId: agent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));

        expect(uninstallFiber.pollUnsafe()).toBeUndefined();
        yield* Deferred.succeed(releaseDownload, undefined);

        expect(yield* Fiber.join(prepareFiber)).toMatchObject({ prepared: true });
        expect(yield* Fiber.join(uninstallFiber)).toEqual({
          agentId: agent.id,
          removed: false,
        });
        const agentRoot = `${cacheDir}/tools/${agent.id}`;
        expect(yield* fileSystem.exists(agentRoot)).toBe(true);

        const hostSettings = yield* TestProviderHost.TestProviderHostSettings;
        const instanceId = ProviderInstanceId.make("registry-reference");
        yield* hostSettings.set({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: {
              driver: ProviderDriverKind.make("acpRegistry"),
              displayName: "Registry reference",
              enabled: true,
              config: { agentId: agent.id },
            },
          },
        });
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: false,
        });
        yield* hostSettings.set(DEFAULT_SERVER_SETTINGS);
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: true,
        });
        expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
          agentId: agent.id,
          removed: false,
        });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver(
            (request) => {
              if (request.url === registryUrl) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(makeRegistry(agent))),
                );
              }
              return Deferred.succeed(downloadStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDownload)),
                Effect.as(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(binaryBytes.buffer as ArrayBuffer),
                  ),
                ),
              );
            },
            process.env,
            localPlatform,
          ),
        ),
      );
    });
  });

  it.effect("resolves an installed agent while another agent's download is still running", () => {
    const slowArchiveUrl = "https://registry.test/slow-agent.bin";
    // The installed binary is a real file, so the host it is checked on is this machine's own.
    const agent = makeAgent({
      binary: { [localTarget]: { archive: archiveUrl, cmd: `./bin/example-agent${localExe}` } },
    });
    const slowAgent = {
      ...agent,
      distribution: {
        binary: { [localTarget]: { archive: slowArchiveUrl, cmd: `./bin/slow-agent${localExe}` } },
      },
      id: "slow-agent",
      name: "Slow Agent",
    };
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const releaseDownload = yield* Deferred.make<void>();
      return yield* Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-acp-registry-parallel-install-",
        });
        const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
          cacheDir,
          toolsDir: `${cacheDir}/tools`,
          registryUrl,
        });

        yield* resolver.resolve(settings(), "/workspace", { PATH: cacheDir });

        const prepareFiber = yield* resolver
          .prepare({ agentId: slowAgent.id })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(downloadStarted);

        const resolved = yield* resolver.resolve(settings(), "/workspace", { PATH: cacheDir });
        const path = yield* Path.Path;
        expect(resolved.spawn.command).toContain(
          path.join(
            "tools",
            "example-agent",
            "1.2.3",
            localTarget,
            "bin",
            `example-agent${localExe}`,
          ),
        );
        expect(prepareFiber.pollUnsafe()).toBeUndefined();

        yield* Deferred.succeed(releaseDownload, undefined);
        expect(yield* Fiber.join(prepareFiber)).toMatchObject({ prepared: true });
      }).pipe(
        Effect.scoped,
        Effect.provide(
          layerResolver(
            (request) => {
              if (request.url === registryUrl) {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(JSON.stringify({ version: "1.0.0", agents: [slowAgent, agent] })),
                  ),
                );
              }
              const response = HttpClientResponse.fromWeb(
                request,
                new Response(binaryBytes.buffer as ArrayBuffer),
              );
              if (request.url !== slowArchiveUrl) return Effect.succeed(response);
              return Deferred.succeed(downloadStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseDownload)),
                Effect.as(response),
              );
            },
            process.env,
            localPlatform,
          ),
        ),
      );
    });
  });

  it.effect("reserves a prepared binary until a configured instance inspects it", () => {
    const agent = makeAgent({
      binary: {
        [localTarget]: {
          archive: archiveUrl,
          cmd: `./bin/example-agent${localExe}`,
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-uninstall-reservation-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      yield* resolver.prepare({ agentId: agent.id });
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: false,
      });
      expect(yield* resolver.inspect(settings())).toMatchObject({ status: "ready" });
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response(binaryBytes.buffer as ArrayBuffer),
              ),
            ),
          process.env,
          localPlatform,
        ),
      ),
    );
  });

  it.effect("expires an abandoned prepared-binary reservation", () => {
    const agent = makeAgent({
      binary: {
        [localTarget]: {
          archive: archiveUrl,
          cmd: `./bin/example-agent${localExe}`,
        },
      },
    });
    const binaryBytes = new TextEncoder().encode("#!/bin/sh\necho example\n");
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-uninstall-expiry-",
      });
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir,
        toolsDir: `${cacheDir}/tools`,
        registryUrl,
      });

      yield* resolver.prepare({ agentId: agent.id });
      yield* TestClock.adjust("31 seconds");
      expect(yield* resolver.uninstallManagedBinary({ agentId: agent.id })).toEqual({
        agentId: agent.id,
        removed: true,
      });
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layerResolver(
          (request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                request.url === registryUrl
                  ? new Response(makeRegistry(agent))
                  : new Response(binaryBytes.buffer as ArrayBuffer),
              ),
            ),
          process.env,
          localPlatform,
        ),
      ),
    );
  });
});

describe("acpRegistryManagedBinaryDirectories", () => {
  it.effect("lists managed package and binary command directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cacheDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-bins-",
      });
      const install = (agent: string, version: string, target: string, commandDirectory = "") =>
        fileSystem.makeDirectory(
          path.join(cacheDir, "tools", agent, version, target, commandDirectory),
          { recursive: true },
        );
      yield* install("kimi", "1.49.0", "linux-x86_64", "bin");
      yield* install("kimi", "1.50.0", "linux-x86_64", "cmd");
      yield* install("kimi", "1.50.0", "darwin-aarch64");
      yield* install("other-agent", "0.2.0", "darwin-aarch64");
      const globalBin = path.join(cacheDir, "tools", "gemini", "0.56.0", "npm", "bin");
      const geminiCommand = path.join(globalBin, "gemini");
      const receiptsDirectory = path.join(cacheDir, "acp-registry", "package-installs");
      yield* fileSystem.makeDirectory(globalBin, { recursive: true });
      yield* fileSystem.makeDirectory(receiptsDirectory, { recursive: true });
      yield* fileSystem.writeFileString(geminiCommand, "#!/bin/sh\n");
      yield* fileSystem.chmod(geminiCommand, 0o755);
      yield* fileSystem.writeFileString(
        path.join(receiptsDirectory, "gemini.json"),
        encodeUnknownJson({
          agentId: "gemini",
          agentVersion: "0.56.0",
          distribution: "npx",
          packageSpec: "@google/gemini-cli@0.56.0",
          managerPath: "/usr/bin/npm",
          binDirectory: globalBin,
          executablePath: geminiCommand,
          packageRoot: path.join(
            cacheDir,
            "tools",
            "gemini",
            "0.56.0",
            "npm",
            "lib",
            "node_modules",
            "@google",
            "gemini-cli",
          ),
          packageVersion: "0.56.0",
        }),
      );
      yield* fileSystem.writeFileString(
        path.join(cacheDir, "acp-registry", "registry.json"),
        encodeUnknownJson({
          version: "1.0.0",
          agents: [
            {
              ...makeAgent({
                binary: {
                  "linux-x86_64": { archive: archiveUrl, cmd: "bin/kimi" },
                },
              }),
              id: "kimi",
              name: "Kimi",
              version: "1.49.0",
            },
            {
              ...makeAgent({
                binary: {
                  "linux-x86_64": { archive: archiveUrl, cmd: "cmd/kimi" },
                },
              }),
              id: "kimi",
              name: "Kimi",
              version: "1.50.0",
            },
          ],
        }),
      );

      const directories = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
        cacheDir,
        toolsDir: path.join(cacheDir, "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(directories).toEqual([
        globalBin,
        path.join(cacheDir, "tools", "kimi", "1.50.0", "linux-x86_64", "cmd"),
        path.join(cacheDir, "tools", "kimi", "1.49.0", "linux-x86_64", "bin"),
      ]);

      const missing = yield* AcpRegistrySupport.acpRegistryManagedBinaryDirectories({
        cacheDir: path.join(cacheDir, "does-not-exist"),
        toolsDir: path.join(cacheDir, "does-not-exist", "tools"),
        platform: "linux",
        architecture: "x64",
      });
      expect(missing).toEqual([]);
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)), Effect.scoped),
  );
});
