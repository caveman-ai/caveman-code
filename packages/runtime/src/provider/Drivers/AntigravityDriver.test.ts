// ), apps/server/src/provider/Drivers/AntigravityDriver.test.ts @ 13aa882c22.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type AntigravitySettings,
} from "@caveman-app/protocol";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { HttpClient } from "effect/http";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import {
  ANTIGRAVITY_AUTH_STDOUT_PREFIX,
  resolveAntigravityInstanceDirectories,
} from "../antigravityAuthSupport.ts";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import * as ModelManifest from "../ModelManifest.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import { AntigravityDriver } from "./AntigravityDriver.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

const hostPlatform = HostProcess.Platform.defaultValue();
const windowsHost = hostPlatform === "win32";
const decodeRequest = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      method: Schema.optional(Schema.String),
      params: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);
const blockedCredentialKeys = new Set([
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_GENAI_USE_VERTEXAI",
]);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

const makeHarness = Effect.fn("makeAntigravityDriverHarness")(function* (
  options: {
    readonly config?: Partial<AntigravitySettings>;
    readonly enabled?: boolean;
    /** Variables set on the instance in Settings, beside the fixture's own. */
    readonly instanceEnv?: Readonly<Record<string, string>>;
    /** The thread's workspace ports and computer.toml [env], as SessionPlugins hands them out. */
    readonly workspaceEnv?: Readonly<Record<string, string>>;
  } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const nodePath = yield* HostProcess.ExecutablePath;
  const baseEnv = yield* HostProcess.Environment;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-driver-" });
  const instanceId = ProviderInstanceId.make(path.basename(root));
  const mockAgentPath = yield* path.fromFileUrl(
    new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
  );
  const requestLog = path.join(root, "requests.jsonl");
  const directories = yield* resolveAntigravityInstanceDirectories(config.stateDir, instanceId);
  const profileDirectory = directories.profile;
  const instancePath = `${path.join(root, "instance-bin")}:${baseEnv.PATH ?? ""}`;

  const makeExecutable = Effect.fn("AntigravityDriverTest.makeExecutable")(function* (
    name: string,
    loginRequired = false,
  ) {
    const directory = path.join(root, name);
    const executablePath = path.join(directory, "agy_acp_server.par");
    const harnessPath = path.join(directory, "localharness_external");
    yield* fs.makeDirectory(directory, { recursive: true });
    const authorizationUrl =
      "https://accounts.google.com/o/oauth2/v2/auth?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A51234%2F&state=fixture-state";
    yield* fs.writeFileString(
      executablePath,
      [
        "#!/bin/sh",
        ...(loginRequired
          ? [`printf '%s\\n' ${shellQuote(ANTIGRAVITY_AUTH_STDOUT_PREFIX + authorizationUrl)}`]
          : []),
        `exec ${shellQuote(nodePath)} ${shellQuote(mockAgentPath)} "$@"`,
        "",
      ].join("\n"),
    );
    yield* fs.writeFileString(harnessPath, "#!/bin/sh\nexit 99\n");
    yield* fs.chmod(executablePath, 0o755);
    yield* fs.chmod(harnessPath, 0o755);
    return {
      executablePath,
      harnessPath,
      source: "managed",
      version: name,
      managedVersionDirectory: directory,
    } satisfies AntigravityInstallation.AntigravityExecutable;
  });

  const first = yield* makeExecutable("runtime 'one");
  const second = yield* makeExecutable("runtime two");
  const signedOut = yield* makeExecutable("runtime signed-out", true);
  const controls = { selected: first, failResolution: false, beforeAcquire: Effect.void };
  const acquisitions: Array<{ binaryPath: string | undefined; path: string | undefined }> = [];
  const releases: Array<string | null> = [];
  const launches: Array<{
    command: string;
    args: ReadonlyArray<string>;
    cwd: string | undefined;
    extendEnv: boolean | undefined;
    profileDirectory: string | undefined;
    harnessPath: string | undefined;
    forceFileStorage: string | undefined;
    credentialKeys: ReadonlyArray<string>;
    geminiApiKey: string | undefined;
    tempDirectory: string | undefined;
    environment: Readonly<Record<string, string | undefined>>;
    handle: ChildProcessSpawner.ChildProcessHandle;
  }> = [];

  const layerInstallation = Layer.mock(AntigravityInstallation.AntigravityInstallation)({
    managedDirectory: root,
    resolve: () =>
      Effect.gen(function* () {
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        return controls.selected;
      }),
    acquire: (binaryPath, environment) =>
      Effect.gen(function* () {
        acquisitions.push({ binaryPath, path: environment?.PATH });
        yield* controls.beforeAcquire;
        if (controls.failResolution) {
          return yield* new AntigravityInstallation.AntigravityInstallationError({
            operation: "resolve",
            detail: "Fixture resolution failed.",
          });
        }
        const selected = controls.selected;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            releases.push(selected.version);
          }),
        );
        return selected;
      }),
  });
  const observedSpawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand")
        return yield* Effect.die("Unexpected process pipeline.");
      const handle = yield* spawner.spawn(command);
      const environment = command.options.env ?? {};
      const env = (name: string) => {
        const value = environment[name];
        return Redacted.isRedacted(value) ? Redacted.value(value) : value;
      };
      launches.push({
        command: command.command,
        args: command.args.map(String),
        cwd: command.options.cwd,
        extendEnv: command.options.extendEnv,
        profileDirectory: env("GEMINI_HOME"),
        harnessPath: env("ANTIGRAVITY_HARNESS_PATH"),
        forceFileStorage: env("AGY_ACP_FORCE_FILE_STORAGE"),
        credentialKeys: Object.keys(environment).filter((key) =>
          blockedCredentialKeys.has(key.toUpperCase()),
        ),
        geminiApiKey: env("GEMINI_API_KEY"),
        tempDirectory:
          environment.ANTIGRAVITY_HARNESS_PATH === undefined ? undefined : env("TMPDIR"),
        environment: Object.fromEntries(Object.keys(environment).map((name) => [name, env(name)])),
        handle,
      });
      return handle;
    }),
  );
  const instance = yield* AntigravityDriver.create({
    instanceId,
    displayName: "Google test account",
    enabled: options.enabled ?? true,
    config: { ...AntigravityDriver.defaultConfig(), ...options.config },
    environment: [
      { name: "PATH", value: instancePath },
      { name: "T3_ACP_ANTIGRAVITY", value: "1" },
      { name: "T3_ACP_REQUEST_LOG_PATH", value: requestLog },
      { name: "GEMINI_API_KEY", value: "must-not-be-used" },
      { name: "google_api_key", value: "must-not-be-used" },
      { name: "GOOGLE_APPLICATION_CREDENTIALS", value: "/must-not-be-used.json" },
      { name: "GOOGLE_GENAI_USE_VERTEXAI", value: "true" },
      { name: "GEMINI_HOME", value: "/must-not-be-used" },
      { name: "ANTIGRAVITY_HARNESS_PATH", value: "/must-not-be-used" },
      { name: "BROWSER", value: "must-not-run" },
      ...Object.entries(options.instanceEnv ?? {}).map(([name, value]) => ({ name, value })),
    ].map((variable) => ({ ...variable, sensitive: false })),
  }).pipe(
    Effect.provide(layerInstallation),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observedSpawner),
    Effect.provideService(SessionPlugins.SessionPlugins, {
      acp: () => Effect.succeed([]),
      claudeAgent: () => Effect.die("unused"),
      codex: () => Effect.die("unused"),
      env: () => Effect.succeed(options.workspaceEnv ?? {}),
    }),
  );
  const refresh = instance.refreshModels;
  if (!refresh) return yield* Effect.die("Antigravity does not expose model refresh.");
  const readRequests = Effect.gen(function* () {
    if (!(yield* fs.exists(requestLog))) return [];
    const text = yield* fs.readFileString(requestLog);
    return yield* Effect.forEach(text.split(/\r?\n/u).filter(Boolean), (line) =>
      decodeRequest(line),
    );
  });
  const assertClosed = Effect.gen(function* () {
    for (const launch of launches) {
      yield* launch.handle.exitCode.pipe(Effect.ignore);
      expect(yield* launch.handle.isRunning).toBe(false);
      if (launch.cwd) expect(yield* fs.exists(launch.cwd)).toBe(false);
      if (launch.tempDirectory) expect(yield* fs.exists(launch.tempDirectory)).toBe(false);
    }
  });
  return {
    instance,
    refresh,
    fs,
    path,
    profileDirectory,
    directories,
    instancePath,
    first,
    second,
    signedOut,
    controls,
    acquisitions,
    releases,
    launches,
    readRequests,
    assertClosed,
  };
});

const layerDeps = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-antigravity-driver-config-",
}).pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Unexpected quota request")),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
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
  Layer.provideMerge(ModelManifest.layerTest),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
);
const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(layerDeps),
);

it.layer(layerTest)("AntigravityDriver", (it) => {
  it.effect.skipIf(windowsHost)(
    "preserves the Node install message when starting a standalone provider",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Install Node.js");
        expect(h.launches).toEqual([]);
      }).pipe(
        Effect.scoped,
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Environment, { PATH: "" }),
      ),
  );

  it.effect.skipIf(windowsHost)("does not launch a process for a disabled instance", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ enabled: false });
      const snapshot = yield* h.instance.snapshot.refresh;
      expect(snapshot.status).toBe("disabled");
      expect(h.acquisitions).toEqual([]);
      expect(h.launches).toEqual([]);
      expect(yield* h.fs.exists(h.profileDirectory)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("refreshes models after slow process startup", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const entered = yield* Deferred.make<void>();
      const ready = yield* Deferred.make<void>();
      h.controls.beforeAcquire = Deferred.succeed(entered, undefined).pipe(
        Effect.andThen(Deferred.await(ready)),
      );
      const refresh = yield* h.refresh().pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      yield* TestClock.adjust("70 seconds");
      yield* Deferred.succeed(ready, undefined);
      yield* Fiber.join(refresh);
      const snapshot = yield* h.instance.snapshot.getSnapshot;
      expect(snapshot.auth.status).toBe("authenticated");
      expect(snapshot.models.length).toBeGreaterThan(0);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "refreshes through the selected executable and personal Google ACP",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.status).toBe("ready");
        expect(snapshot.auth.status).toBe("authenticated");
        expect(snapshot.models.map((model) => model.slug)).toEqual([
          "gemini-test-low",
          "gemini-test-high",
        ]);
        expect(snapshot.models[0]?.aliases).toContain(ANTIGRAVITY_DEFAULT_MODEL);
        expect(snapshot.models.every((model) => model.isLegacy !== true)).toBe(true);
        expect(snapshot.slashCommands.map((command) => command.name)).toEqual(["plan", "logout"]);
        expect(snapshot.supportsTextGeneration).toBe(true);
        h.controls.selected = h.second;
        yield* h.refresh();

        expect(h.acquisitions).toEqual([
          { binaryPath: "", path: h.instancePath },
          { binaryPath: "", path: h.instancePath },
        ]);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.command)).toEqual([
          h.first.executablePath,
          h.second.executablePath,
        ]);
        expect(nativeLaunches.map((launch) => launch.harnessPath)).toEqual([
          h.first.harnessPath,
          h.second.harnessPath,
        ]);
        for (const launch of nativeLaunches) {
          expect(launch.args).toEqual(hostPlatform === "linux" ? ["--uid="] : []);
          expect(launch.profileDirectory).toBe(h.profileDirectory);
          expect(launch.forceFileStorage).toBe("1");
          expect(launch.extendEnv).toBe(false);
        }
        for (const launch of h.launches) expect(launch.credentialKeys).toEqual([]);
        expect(h.releases).toEqual([h.first.version, h.second.version]);
        const requests = yield* h.readRequests;
        expect(requests.map((request) => request.method)).toEqual([
          "initialize",
          "auth/login",
          "session/new",
          "initialize",
          "auth/login",
          "session/new",
        ]);
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["oauth-personal", "oauth-personal"]);
        expect(
          requests
            .filter((request) => request.method === "session/new")
            .map((request) => request.params?.mcpServers),
        ).toEqual([[], []]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "authenticates with the configured API key method and labels the account by method",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness({
          config: { authMethod: "gemini-api-key", apiKey: "fixture-gemini-key" },
        });
        yield* h.refresh();
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth).toMatchObject({
          status: "authenticated",
          type: "gemini-api-key",
          label: "Gemini API key",
        });
        expect(snapshot.models.length).toBeGreaterThan(0);
        const nativeLaunches = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(nativeLaunches.map((launch) => launch.geminiApiKey)).toEqual(["fixture-gemini-key"]);
        const requests = yield* h.readRequests;
        expect(
          requests
            .filter((request) => request.method === "auth/login")
            .map((request) => request.params?.methodId),
        ).toEqual(["gemini-api-key"]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("reports the missing credential before launching a process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ config: { authMethod: "gemini-api-key" } });
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("API key");
      expect(h.launches.filter((launch) => launch.harnessPath !== undefined)).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "closes refresh processes and clears account metadata when Google sign-in is required",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.refresh().pipe(Effect.flip);
        expect(error.detail).toContain("Sign in to Antigravity");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.slashCommands).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.acquisitions).toHaveLength(2);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "clears account metadata when a text helper needs Google sign-in",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.refresh();
        h.controls.selected = h.signedOut;
        const error = yield* h.instance.textGeneration
          .generateThreadTitle({
            cwd: h.profileDirectory,
            message: "Repair Google login",
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
          })
          .pipe(Effect.flip);
        expect(error._tag).toBe("TextGenerationError");
        const snapshot = yield* h.instance.snapshot.getSnapshot;
        expect(snapshot.auth.status).toBe("unauthenticated");
        expect(snapshot.models).toEqual([]);
        expect(snapshot.supportsTextGeneration).toBe(false);
        expect(h.releases).toEqual([h.first.version, h.signedOut.version]);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)("keeps the previous catalog when executable resolution fails", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.refresh();
      const before = yield* h.instance.snapshot.getSnapshot;
      h.controls.failResolution = true;
      const error = yield* h.refresh().pipe(Effect.flip);
      expect(error.detail).toContain("previous model list is unchanged");
      const after = yield* h.instance.snapshot.getSnapshot;
      expect(after.models).toEqual(before.models);
      expect(after.auth).toEqual(before.auth);
      expect(h.acquisitions).toHaveLength(2);
      expect(h.releases).toEqual([h.first.version]);
      yield* h.assertClosed;
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "gives each process its own temp directory and removes it when the process closes",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const tempRoot = h.directories.runtimeTemp;
        yield* h.refresh();
        yield* h.refresh();
        const directories = h.launches.flatMap((launch) =>
          launch.tempDirectory === undefined ? [] : [launch.tempDirectory],
        );
        expect(directories).toHaveLength(2);
        for (const directory of directories) {
          expect(h.path.dirname(directory)).toBe(tempRoot);
        }
        expect(new Set(directories).size).toBe(2);
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "removes runtime temp directories left by a previous server on create",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const instanceId = ProviderInstanceId.make("antigravity-orphan-sweep");
        const directories = yield* resolveAntigravityInstanceDirectories(
          config.stateDir,
          instanceId,
        );
        const legacyRoot = path.join(directories.profile, "antigravity-acp", "tmp");
        for (const root of [directories.runtimeTemp, legacyRoot]) {
          const orphan = path.join(root, "run-orphan", "_MEI123", "google3");
          yield* fs.makeDirectory(orphan, { recursive: true });
          yield* fs.writeFileString(path.join(orphan, "payload.bin"), "stale");
        }
        yield* AntigravityDriver.create({
          instanceId,
          displayName: "Sweep",
          enabled: false,
          config: AntigravityDriver.defaultConfig(),
          environment: [],
        }).pipe(
          Effect.provide(
            Layer.mock(AntigravityInstallation.AntigravityInstallation)({
              managedDirectory: config.stateDir,
              resolve: () => Effect.die("unused"),
              acquire: () => Effect.die("unused"),
            }),
          ),
        );
        expect(yield* fs.exists(directories.runtimeTemp)).toBe(false);
        expect(yield* fs.exists(legacyRoot)).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "never hands the runtime's own variables to the agent or its browser helper",
    () =>
      Effect.gen(function* () {
        // config.ts reads the dev token and OTLP headers; a Cloud computer sets the link dir and checkout.
        const runtimeOnly = {
          CAVEMAN_CODE_DEV_AUTH_TOKEN: "dev-auth-token-sentinel",
          CAVEMAN_CODE_OTLP_HEADERS: "authorization=Bearer otlp-sentinel",
          CAVEMAN_RUNTIME_LINK_WAIT: "1",
          CAVEMAN_CLOUD_LINK_DIR: "/cloud-link-sentinel",
          CAVEMAN_WORKSPACE_ROOT: "/workspace-root-sentinel",
        };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const saved = Object.keys(runtimeOnly).map(
              (name) => [name, process.env[name]] as const,
            );
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
        const h = yield* makeHarness();
        yield* h.refresh();
        expect(h.launches.filter((launch) => launch.harnessPath !== undefined)).toHaveLength(1);
        for (const launch of h.launches) {
          expect(launch.extendEnv).toBe(false);
          expect(
            Object.fromEntries(
              Object.keys(runtimeOnly).map((name) => [name, launch.environment[name]]),
            ),
          ).toEqual({});
        }
        yield* h.assertClosed;
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "gives a session's agent the workspace's ports and [env] under what the agent owns",
    () =>
      Effect.gen(function* () {
        // The runtime's own env: a host DATABASE_URL (the shell the runtime started from) and a TERM.
        const host = { DATABASE_URL: "postgres://host-db.test/host", TERM: "host-term" };
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const saved = Object.keys(host).map((name) => [name, process.env[name]] as const);
            Object.assign(process.env, host);
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
        // What the person set on the instance in Settings.
        const instanceEnv = { HTTPS_PROXY: "http://settings-proxy.test:3128" };
        const workspaceEnv = {
          CAVEMAN_PORT_WEB: "42100",
          CAVEMAN_PORT: "42100",
          DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/postgres",
          // The repo tries to take back the instance's proxy, the agent's PATH and TERM, and its
          // profile, credential, browser helper and temp directory.
          HTTPS_PROXY: "http://repo-proxy.test:3128",
          PATH: "/repo/bin",
          TERM: "repo-term",
          GEMINI_HOME: "/workspace-gemini-home",
          GEMINI_API_KEY: "workspace-gemini-key",
          BROWSER: "workspace-browser",
          TMPDIR: "/workspace-tmp",
        };
        const h = yield* makeHarness({ instanceEnv, workspaceEnv });
        const cwd = yield* h.fs.makeTempDirectoryScoped({ prefix: "t3-antigravity-workspace-" });
        const threadId = ThreadId.make("thread-antigravity-workspace-env");
        yield* (yield* McpProviderSessions.McpProviderSessions).set({
          environmentId: EnvironmentId.make("environment-antigravity-workspace-env"),
          threadId,
          providerSessionId: "mcp-session-antigravity-workspace-env",
          providerInstanceId: h.instance.instanceId,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer antigravity-session-token",
          browserToolsAvailable: false,
        });
        yield* h.instance.orchestrationAdapter
          .openSession({
            threadId,
            providerSessionId: ProviderSessionId.make("provider-session-antigravity-workspace-env"),
            modelSelection: { instanceId: h.instance.instanceId, model: "gemini-test-low" },
            runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd,
            }),
          })
          .pipe(Effect.scoped);
        const agents = h.launches.filter((launch) => launch.harnessPath !== undefined);
        expect(agents).toHaveLength(1);
        const environment = agents[0]!.environment;
        // Antigravity runs its own commands, so its environment is what `pnpm dev` sees. Like a
        // registry agent's commands, they also get the session's MCP credential, so the ACP
        // terminal fallback (acp-mcp-call) can reach the Caveman Code tools.
        expect({
          CAVEMAN_PORT_WEB: environment.CAVEMAN_PORT_WEB,
          CAVEMAN_PORT: environment.CAVEMAN_PORT,
          DATABASE_URL: environment.DATABASE_URL,
          HTTPS_PROXY: environment.HTTPS_PROXY,
          PATH: environment.PATH,
          TERM: environment.TERM,
          CAVEMAN_CODE_ACP_MCP_ENDPOINT: environment.CAVEMAN_CODE_ACP_MCP_ENDPOINT,
          CAVEMAN_CODE_ACP_MCP_AUTHORIZATION: environment.CAVEMAN_CODE_ACP_MCP_AUTHORIZATION,
        }).toEqual({
          CAVEMAN_PORT_WEB: workspaceEnv.CAVEMAN_PORT_WEB,
          CAVEMAN_PORT: workspaceEnv.CAVEMAN_PORT,
          DATABASE_URL: workspaceEnv.DATABASE_URL,
          HTTPS_PROXY: instanceEnv.HTTPS_PROXY,
          PATH: h.instancePath,
          TERM: host.TERM,
          CAVEMAN_CODE_ACP_MCP_ENDPOINT: "http://127.0.0.1:43123/mcp",
          CAVEMAN_CODE_ACP_MCP_AUTHORIZATION: "Bearer antigravity-session-token",
        });
        expect(environment.GEMINI_HOME).toBe(h.profileDirectory);
        expect(environment.GEMINI_API_KEY).toBeUndefined();
        expect(environment.BROWSER).not.toBe(workspaceEnv.BROWSER);
        expect(h.path.dirname(environment.TMPDIR ?? "")).toBe(h.directories.runtimeTemp);
        yield* agents[0]!.handle.exitCode.pipe(Effect.ignore);
        expect(yield* agents[0]!.handle.isRunning).toBe(false);
      }).pipe(Effect.scoped),
  );

  it.effect("probes through installation resolution without launching a process", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness({ enabled: true });
      const snapshot = yield* h.instance.snapshot.refresh;
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe(h.first.version);
      expect(h.launches).toEqual([]);
      expect(h.acquisitions).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
