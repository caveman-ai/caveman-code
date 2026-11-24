// ), apps/server/src/provider/ProviderInstanceRegistry.test.ts @ ab3a3cd1; perf from 76ff0eb2a1, 6e45544850.
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
/**
 * Multi-instance validation slices for the live `ProviderInstanceRegistry`.
 *
 * Two axes of the driver/registry refactor are exercised here:
 *
 *  1. **Same driver, many instances** — the "multi-instance codex slice"
 *     describe block below configures two independent `codex` instances and
 *     asserts each gets its own closures and identity. This is the
 *     multi-codex capability the refactor exists to unlock.
 *
 *  2. **Many drivers, one registry** — the "all drivers slice" describe
 *     block below configures one instance of every shipped driver
 *     (`codex`, `claudeAgent`, `cursor`, `grok`, `opencode`) in a single
 *     `ProviderInstanceConfigMap` and asserts the registry boots them all
 *     without cross-contamination. This proves the driver SPI is uniform
 *     across every provider — any driver plugs into the registry through
 *     the same `ProviderDriver` value contract.
 *
 * Every instance in these tests is configured with `enabled: false` so the
 * provider-status checks short-circuit to pending/disabled snapshots
 * without trying to spawn real `codex` / `claude` / `agent` / `grok` / `opencode`
 * binaries. That keeps the assertions focused on registry routing
 * behaviour rather than the runtime details of each provider.
 */
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  type ClaudeSettings,
  type CodexSettings,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
  ProviderInstanceId,
} from "@caveman-app/protocol";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import { ProviderDriverError } from "./Errors.ts";
import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "./ProviderOrchestrationAdapterInfrastructure.ts";
import * as ProviderHostLive from "./ProviderHostLive.ts";

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

// The mock CLIs from makeTildeProviderFixtures are scripts Windows cannot execute.
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const makeCodexConfig = (overrides: Partial<CodexSettings>): CodexSettings => ({
  enabled: false,
  binaryPath: "codex",
  homePath: "",
  shadowHomePath: "",
  launchArgs: "",
  chatGptLogin: false,
  customModels: [],
  ...overrides,
});

const makeClaudeConfig = (overrides: Partial<ClaudeSettings>): ClaudeSettings => ({
  enabled: false,
  binaryPath: "claude",
  homePath: "",
  customModels: [],
  launchArgs: "",
  autoCompactWindow: "",
  idleCompaction: "default",
  ...overrides,
});

const makeTildeProviderFixtures = Effect.fn(
  "ProviderInstanceRegistry.test.makeTildeProviderFixtures",
)(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homePath = yield* HostProcess.HomeDirectory;
  const fixtureDir = yield* fileSystem.makeTempDirectoryScoped({
    directory: homePath,
    prefix: ".t3-provider-path-test-",
  });
  const codexPath = path.join(fixtureDir, "codex");
  const claudePath = path.join(fixtureDir, "claude");
  const claudeHomePath = path.join(fixtureDir, "claude-home");
  const codexScriptPath = path.join(fixtureDir, "codex-script.json");
  const codexFixtureDir = path.join(import.meta.dirname, "testFixtures");

  yield* fileSystem.copyFile(path.join(codexFixtureDir, "codexCollabMockPeer.sh"), codexPath);
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexCollabMockPeer.mjs"),
    path.join(fixtureDir, "codexCollabMockPeer.mjs"),
  );
  yield* fileSystem.copyFile(
    path.join(codexFixtureDir, "codexMultiAgentWire.json"),
    path.join(fixtureDir, "codexMultiAgentWire.json"),
  );
  yield* fileSystem.writeFileString(
    codexScriptPath,
    JSON.stringify({ rootThreadId: "probe-thread", notifications: [] }),
  );
  yield* fileSystem.chmod(codexPath, 0o755);

  yield* fileSystem.copyFile(
    yield* path.fromFileUrl(
      new URL("./testing/ProviderInstanceRegistryLive.fixture.mjs", import.meta.url),
    ),
    claudePath,
  );
  yield* fileSystem.chmod(claudePath, 0o755);
  yield* fileSystem.makeDirectory(claudeHomePath);

  const asTildePath = (filePath: string) => `~/${path.relative(homePath, filePath)}`;
  return {
    codexBinaryPath: asTildePath(codexPath),
    claudeBinaryPath: asTildePath(claudePath),
    claudeHomePath,
    codexScriptPath,
  };
});

describe("ProviderInstanceRegistry — multi-instance codex slice", () => {
  // `ServerConfig.layerTest` needs `FileSystem` to materialize its scratch
  // directory. `Layer.merge` just unions requirements, so we have to push
  // `Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)` through `Layer.provideMerge` to satisfy that
  // dependency while still surfacing NodeServices to the test body (the
  // codex driver's `create` yields `ChildProcessSpawner` directly).
  const layerBaseDeps = ServerConfig.layerTest(process.cwd(), {
    prefix: "provider-instance-registry-test",
  }).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(Layer.mock(ServerSecretStore.ServerSecretStore)({})),
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provideMerge(layerBase),
  );

  it.live("boots two independent codex instances from a ProviderInstanceConfigMap", () =>
    Effect.gen(function* () {
      const personalId = ProviderInstanceId.make("codex_personal");
      const workId = ProviderInstanceId.make("codex_work");
      const codexDriverKind = ProviderDriverKind.make("codex");

      const configMap: ProviderInstanceConfigMap = {
        [personalId]: {
          driver: codexDriverKind,
          displayName: "Codex (personal)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-personal/bin/codex",
            homePath: "/home/julius/.codex_personal",
            chatGptLogin: true,
            customModels: ["personal-preview"],
          }),
        },
        [workId]: {
          driver: codexDriverKind,
          displayName: "Codex (work)",
          enabled: false,
          config: makeCodexConfig({
            binaryPath: "/opt/codex-work/bin/codex",
            homePath: "/home/julius/.codex",
            chatGptLogin: true,
            customModels: ["work-preview"],
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
        drivers: [CodexDriver],
        configMap,
      });

      const instances = yield* registry.listInstances;
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [personalId, workId].toSorted(),
      );
      expect(instances.every((instance) => instance.driverKind === codexDriverKind)).toBe(true);
      expect(instances.map((instance) => instance.displayName).toSorted()).toEqual(
        ["Codex (personal)", "Codex (work)"].toSorted(),
      );

      // Each instance must be retrievable by id and carry its *own* closures.
      const personal = yield* registry.getInstance(personalId);
      const work = yield* registry.getInstance(workId);
      expect(personal).toBeDefined();
      expect(work).toBeDefined();
      expect(personal!.orchestrationAdapter).not.toBe(work!.orchestrationAdapter);
      expect(personal!.textGeneration).not.toBe(work!.textGeneration);
      expect(personal!.snapshot).not.toBe(work!.snapshot);

      // Snapshots identify themselves by instanceId + driver — this is
      // what makes per-instance routing distinguishable downstream.
      const personalSnapshot = yield* personal!.snapshot.getSnapshot;
      expect(personalSnapshot.instanceId).toBe(personalId);
      expect(personalSnapshot.driver).toBe(codexDriverKind);
      expect(personalSnapshot.enabled).toBe(false);
      // The layout resolves the configured home through the host Path.
      const path = yield* Path.Path;
      expect(personalSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex_personal")}`,
      );

      const workSnapshot = yield* work!.snapshot.getSnapshot;
      expect(workSnapshot.instanceId).toBe(workId);
      expect(workSnapshot.driver).toBe(codexDriverKind);
      expect(workSnapshot.enabled).toBe(false);
      expect(workSnapshot.continuation?.groupKey).toBe(
        `codex:home:${path.resolve("/home/julius/.codex")}`,
      );

      // Nothing goes to the unavailable bucket — both drivers are registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["replacement", "removal"] as const)(
    "never routes a turn to an engine instance that a settings %s is retiring",
    (scenario) =>
      Effect.gen(function* () {
        let closed = 0;
        const closeStarted = yield* Deferred.make<void>();
        const releaseClose = yield* Deferred.make<void>();
        const replacementStarted = yield* Deferred.make<void>();
        const releaseReplacement = yield* Deferred.make<void>();
        const retiredId = ProviderInstanceId.make("retired");
        const siblingId = ProviderInstanceId.make("sibling");
        const nextId = scenario === "replacement" ? retiredId : ProviderInstanceId.make("new");
        const driver: typeof CodexDriver = {
          ...CodexDriver,
          create: (input) =>
            Effect.gen(function* () {
              if (input.displayName === "Second") {
                yield* Deferred.succeed(replacementStarted, undefined);
                yield* Deferred.await(releaseReplacement);
              }
              const instance = yield* CodexDriver.create(input);
              if (input.instanceId === retiredId && input.displayName !== "Second") {
                // Holds the retired instance mid-teardown, as Codex's app-server shutdown does.
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(closeStarted, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseClose)),
                    Effect.andThen(Effect.sync(() => closed++)),
                  ),
                );
              }
              return instance;
            }),
        };
        const entry = {
          driver: CodexDriver.driverKind,
          enabled: false,
          config: makeCodexConfig({}),
        };
        const { registry, mutator } = yield* makeProviderInstanceRegistry({
          drivers: [driver],
          configMap: { [retiredId]: entry, [siblingId]: entry },
        });
        const sibling = yield* registry.getInstance(siblingId);
        const reconcile = yield* mutator
          .reconcile({
            [siblingId]: entry,
            [nextId]: {
              ...entry,
              displayName: "Second",
              config: makeCodexConfig({ customModels: ["replacement-model"] }),
            },
          })
          .pipe(Effect.forkChild({ startImmediately: true }));

        const routing = Effect.gen(function* () {
          return {
            closed,
            routed: (yield* registry.getInstance(retiredId))?.instanceId,
            listed: (yield* registry.listInstances).map((instance) => instance.instanceId),
          };
        });
        // Observe first and assert after the reconcile is released, so a failure
        // cannot strand the fiber inside the held teardown.
        yield* Deferred.await(closeStarted);
        const whileClosing = yield* routing;
        yield* Deferred.succeed(releaseClose, undefined);
        yield* Deferred.await(replacementStarted);
        const whileRebuilding = yield* routing;
        yield* Deferred.succeed(releaseReplacement, undefined);
        yield* Fiber.join(reconcile);

        expect(whileClosing).toEqual({ closed: 0, routed: undefined, listed: [siblingId] });
        expect(whileRebuilding).toEqual({ closed: 1, routed: undefined, listed: [siblingId] });
        expect((yield* registry.getInstance(nextId))?.displayName).toBe("Second");
        expect(yield* registry.getInstance(siblingId)).toBe(sibling);
        expect(closed).toBe(1);
      }).pipe(Effect.provide(layerTest)),
  );

  it.effect.each(["replacement", "removal", "creation failure"] as const)(
    "lets go of every retired engine instance across repeated settings edits (%s)",
    (scenario) =>
      Effect.gen(function* () {
        const parent = yield* Scope.make();
        const fileSystem = yield* FileSystem.FileSystem;
        const homePath = yield* fileSystem.makeTempDirectoryScoped();
        let creates = 0;
        let closes = 0;
        const driver: typeof CodexDriver = {
          ...CodexDriver,
          create: (input) =>
            Effect.gen(function* () {
              creates++;
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  closes++;
                }),
              );
              if (input.config.binaryPath === "creation-failure") {
                return yield* new ProviderDriverError({
                  driver: CodexDriver.driverKind,
                  instanceId: input.instanceId,
                  detail: "fixture creation failed",
                });
              }
              return yield* CodexDriver.create(input);
            }),
        };
        const siblingId = ProviderInstanceId.make("sibling");
        const retiredId = ProviderInstanceId.make("retired");
        const entry = {
          driver: CodexDriver.driverKind,
          enabled: false,
          config: makeCodexConfig({ homePath }),
        };
        const finalizerCount = () => {
          const state = parent.state;
          return state._tag === "Open" ? (state.finalizers?.size ?? 1) : 0;
        };
        yield* Effect.gen(function* () {
          const { registry, mutator } = yield* makeProviderInstanceRegistry({
            drivers: [driver],
            configMap: { [siblingId]: entry },
          });
          const sibling = yield* registry.getInstance(siblingId);
          const baseline = finalizerCount();
          for (let index = 0; index < 20; index++) {
            yield* mutator.reconcile({
              [siblingId]: entry,
              [retiredId]: {
                ...entry,
                config: makeCodexConfig({
                  homePath,
                  binaryPath: scenario === "creation failure" ? "creation-failure" : "unused-codex",
                  customModels: [`revision-${index}`],
                }),
              },
            });
            if (scenario === "removal") yield* mutator.reconcile({ [siblingId]: entry });
          }
          yield* mutator.reconcile({ [siblingId]: entry });
          expect(yield* registry.getInstance(siblingId)).toBe(sibling);
          expect(closes).toBe(creates - 1);
          expect(finalizerCount()).toBe(baseline);
        }).pipe(
          Effect.provideService(Scope.Scope, parent),
          Effect.ensuring(Scope.close(parent, Exit.void)),
        );
        expect(closes).toBe(creates);
      }).pipe(Effect.provide(layerTest)),
  );

  it.live("treats an explicit in-config enabled:false as disabling despite the envelope", () =>
    Effect.gen(function* () {
      // Old settings files can carry both flags with conflicting values.
      // The explicit false must win so a user's disable is never undone.
      const staleId = ProviderInstanceId.make("codex_stale");
      const configMap: ProviderInstanceConfigMap = {
        [staleId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          config: makeCodexConfig({ enabled: false }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap,
      });

      const instance = yield* registry.getInstance(staleId);
      expect(instance).toBeDefined();
      expect(instance!.enabled).toBe(false);
      const snapshot = yield* instance!.snapshot.getSnapshot;
      expect(snapshot.enabled).toBe(false);
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("reports Codex's answer when a redemption changed nothing", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* makeTildeProviderFixtures();
      yield* fileSystem.writeFileString(
        fixtures.codexScriptPath,
        JSON.stringify({
          rootThreadId: "probe-thread",
          notifications: [],
          account: { type: "chatgpt", email: "test@example.com", planType: "plus" },
          failRateLimitsRead: true,
          resetCreditOutcome: "alreadyRedeemed",
        }),
      );
      const codexId = ProviderInstanceId.make("codex_reset");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [CodexDriver],
        configMap: {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: true,
            environment: [
              { name: "T3_CODEX_COLLAB_SCRIPT", value: fixtures.codexScriptPath, sensitive: false },
            ],
            config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
          },
        },
      });
      const codex = yield* registry.getInstance(codexId);
      expect(codex).toBeDefined();
      // The usage read fails, so the re-probe cannot confirm new limits.
      yield* codex!.snapshot.refresh;
      expect(yield* codex!.consumeResetCredit!()).toBe("alreadyRedeemed");
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("runs Codex and Claude readiness probes from configured tilde paths", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();

      const codexId = ProviderInstanceId.make("codex_tilde");
      const claudeId = ProviderInstanceId.make("claude_tilde");
      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [
            {
              name: "T3_CODEX_COLLAB_SCRIPT",
              value: fixtures.codexScriptPath,
              sensitive: false,
            },
          ],
          config: makeCodexConfig({ enabled: true, binaryPath: fixtures.codexBinaryPath }),
        },
        [claudeId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv | ClaudeDriverEnv>({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex).toBeDefined();
      expect(claude).toBeDefined();

      const [codexSnapshot, claudeSnapshot] = yield* Effect.all(
        [codex!.snapshot.refresh, claude!.snapshot.refresh],
        { concurrency: "unbounded" },
      );
      expect(codexSnapshot).toMatchObject({ status: "ready", installed: true, version: "0.0.0" });
      expect(claudeSnapshot).toMatchObject({
        status: "ready",
        installed: true,
        version: "2.1.219",
      });
    }).pipe(Effect.provide(layerTest)),
  );

  it.live("runs Claude instance probes in the server state dir, not the server cwd", () =>
    Effect.gen(function* () {
      if (yield* HostProcess.isWindows) return;

      const fixtures = yield* makeTildeProviderFixtures();
      const { stateDir } = yield* ServerConfig.ServerConfig;
      const claudeId = ProviderInstanceId.make("claude_state_dir");
      const { registry } = yield* makeProviderInstanceRegistry<ClaudeDriverEnv>({
        drivers: [ClaudeDriver],
        configMap: {
          [claudeId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            // Packaged desktop builds start the server in $HOME, where some
            // `claude` wrappers refuse to run.
            environment: [{ name: "T3_CLAUDE_REQUIRED_CWD", value: stateDir, sensitive: false }],
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      });
      const claude = yield* registry.getInstance(claudeId);

      expect(yield* claude!.snapshot.refresh).toMatchObject({
        status: "ready",
        version: "2.1.219",
        auth: { status: "authenticated" },
      });
    }).pipe(Effect.provide(layerTest)),
  );

  // Caveman Code product rule: the runtime never reads, stores or forwards the
  // user's Claude login. T3 read the OAuth token and account file to bank
  // rate-limit resets on Linux; any touch of those files fails this test.
  it.live.skipIf(windowsHost)("checks a Claude subscription login without reading its login files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixtures = yield* makeTildeProviderFixtures();
      const touched: Array<string> = [];
      const isLoginFile = (value: unknown): value is string =>
        typeof value === "string" &&
        (value.endsWith(".credentials.json") || value.endsWith(".claude.json"));
      const guardedFileSystem = new Proxy(fileSystem, {
        get: (target, key, receiver) => {
          const member = Reflect.get(target, key, receiver);
          if (typeof member !== "function") return member;
          return (...args: Array<unknown>) => {
            const loginFile = args.find(isLoginFile);
            if (loginFile === undefined) return member.apply(target, args);
            touched.push(loginFile);
            return Effect.die(new Error(`read Claude login file ${loginFile}`));
          };
        },
      });
      const requestedUrls: Array<string> = [];
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requestedUrls.push(request.url);
          return HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }));
        }),
      );
      const instanceId = ProviderInstanceId.make("claude_login");
      const { registry } = yield* makeProviderInstanceRegistry({
        drivers: [ClaudeDriver],
        configMap: {
          [instanceId]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
            config: makeClaudeConfig({
              enabled: true,
              binaryPath: fixtures.claudeBinaryPath,
              homePath: fixtures.claudeHomePath,
            }),
          },
        },
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, guardedFileSystem),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const instance = yield* registry.getInstance(instanceId);

      expect(yield* instance!.snapshot.refresh).toMatchObject({
        status: "ready",
        auth: { status: "authenticated" },
      });
      expect(instance!.consumeResetCredit).toBeUndefined();
      expect(touched).toEqual([]);
      expect(requestedUrls.filter((url) => url.includes("anthropic.com"))).toEqual([]);
    }).pipe(
      // T3 read the token file only off macOS, where the Keychain holds it.
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provide(layerTest),
    ),
  );

  const makeClaudeCacheFixture = Effect.fnUntraced(function* (
    state: "ready" | "signed-out" | "usage-failed",
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const fixtures = yield* makeTildeProviderFixtures();
    const recovered = path.join(fixtures.claudeHomePath, "recovered");
    const probeLog = path.join(fixtures.claudeHomePath, "probes.log");
    const instanceId = ProviderInstanceId.make("claude_cache");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [ClaudeDriver],
      configMap: {
        [instanceId]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [
            { name: "T3_CLAUDE_PROBE_LOG", value: probeLog, sensitive: false },
            // A custom endpoint in the host's environment would read as signed in (ClaudeProvider).
            { name: "ANTHROPIC_BASE_URL", value: "", sensitive: false },
            ...(state === "ready"
              ? []
              : [
                  {
                    name:
                      state === "signed-out"
                        ? "T3_CLAUDE_LOGIN_MARKER"
                        : "T3_CLAUDE_USAGE_FAILS_UNTIL",
                    value: recovered,
                    sensitive: false,
                  },
                ]),
          ],
          config: makeClaudeConfig({
            enabled: true,
            binaryPath: fixtures.claudeBinaryPath,
            homePath: fixtures.claudeHomePath,
          }),
        },
      },
    });
    const instance = yield* registry.getInstance(instanceId);
    expect(instance).toBeDefined();
    return {
      refresh: instance!.snapshot.refresh,
      recover: fs.writeFileString(recovered, ""),
      probeLog: fs.readFileString(probeLog),
    };
  });

  it.effect.skipIf(windowsHost)("reuses Claude's successful usage probe on refresh", () =>
    Effect.gen(function* () {
      const fixture = yield* makeClaudeCacheFixture("ready");
      const first = yield* fixture.refresh;
      const second = yield* fixture.refresh;
      expect(first.usageLimits?.windows.map((window) => window.id)).toEqual(["five_hour"]);
      expect(second.usageLimits).toEqual(first.usageLimits);
      expect(yield* fixture.probeLog).toBe("probe\n");
    }).pipe(Effect.provide(layerTest)),
  );

  for (const state of ["signed-out", "usage-failed"] as const) {
    it.effect.skipIf(windowsHost)(
      state === "signed-out"
        ? "shows Claude usage on the first refresh after signing back in"
        : "retries Claude usage on the first refresh after a failed usage read",
      () =>
        Effect.gen(function* () {
          const fixture = yield* makeClaudeCacheFixture(state);
          const before = yield* fixture.refresh;
          if (state === "signed-out") {
            expect(before.auth.status).toBe("unauthenticated");
            expect(before.usageLimits).toBeUndefined();
          } else {
            expect(before.auth.status).toBe("authenticated");
            expect(before.usageLimits?.unavailable?.reason).toBe("probeFailed");
          }

          yield* fixture.recover;
          const after = yield* fixture.refresh;
          expect(after.auth.status).toBe("authenticated");
          expect(after.usageLimits?.unavailable).toBeUndefined();
          expect(after.usageLimits?.windows.map((window) => window.id)).toEqual(["five_hour"]);
        }).pipe(Effect.provide(layerTest)),
    );
  }

  it.live(
    "shadows instances whose driver is not registered in this build without failing boot",
    () =>
      Effect.gen(function* () {
        const codexId = ProviderInstanceId.make("codex_main");
        const ghostId = ProviderInstanceId.make("ghost_main");

        const configMap: ProviderInstanceConfigMap = {
          [codexId]: {
            driver: ProviderDriverKind.make("codex"),
            enabled: false,
            config: makeCodexConfig({}),
          },
          [ghostId]: {
            driver: ProviderDriverKind.make("ghostDriver"),
            displayName: "A fork-only driver we don't ship",
            enabled: false,
            config: { arbitrary: "payload", preserved: true },
          },
        };

        const { registry } = yield* makeProviderInstanceRegistry<CodexDriverEnv>({
          drivers: [CodexDriver],
          configMap,
        });

        const instances = yield* registry.listInstances;
        expect(instances).toHaveLength(1);
        expect(instances[0]!.instanceId).toBe(codexId);

        const unavailable = yield* registry.listUnavailable;
        expect(unavailable).toHaveLength(1);
        const ghost = unavailable[0]!;
        expect(ghost.instanceId).toBe(ghostId);
        expect(ghost.driver).toBe("ghostDriver");
        expect(ghost.availability).toBe("unavailable");
        expect(ghost.unavailableReason).toMatch(/ghostDriver/);
      }).pipe(Effect.provide(layerTest)),
  );
});

describe("ProviderInstanceRegistry — all drivers slice", () => {
  // All drivers need `NodeServices` (ChildProcessSpawner + FileSystem + Path).
  const layerInfra = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer).pipe(
    Layer.provideMerge(
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(
          EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
        ),
      }),
    ),
  );
  const layerBaseDeps = ServerSecretStore.layer.pipe(
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), {
        prefix: "provider-instance-registry-all-drivers-test",
      }),
    ),
    Layer.provideMerge(layerInfra),
    Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(layerTestHttpClient),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ProviderLatestVersions.layer),
    Layer.provideMerge(McpProviderSessions.layer),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
  );
  const layerBase = ProviderHostLive.layer.pipe(Layer.provideMerge(layerBaseDeps));
  const layerTest = ProviderOrchestrationAdapterInfrastructure.layer.pipe(
    Layer.provideMerge(layerBase),
  );

  it.live("boots one instance of every shipped driver from a single config map", () =>
    Effect.gen(function* () {
      const codexId = ProviderInstanceId.make("codex_default");
      const claudeId = ProviderInstanceId.make("claude_default");

      const codexDriverKind = ProviderDriverKind.make("codex");
      const claudeDriverKind = ProviderDriverKind.make("claudeAgent");

      const configMap: ProviderInstanceConfigMap = {
        [codexId]: {
          driver: codexDriverKind,
          displayName: "Codex",
          enabled: false,
          config: makeCodexConfig({ homePath: "/home/julius/.codex", chatGptLogin: true }),
        },
        [claudeId]: {
          driver: claudeDriverKind,
          displayName: "Claude",
          enabled: false,
          config: makeClaudeConfig({
            homePath: "/home/julius/.claude-work",
            launchArgs: "--verbose",
          }),
        },
      };

      const { registry } = yield* makeProviderInstanceRegistry<
        CodexDriverEnv | ClaudeDriverEnv
      >({
        drivers: [CodexDriver, ClaudeDriver],
        configMap,
      });

      // Every configured instance must materialize — none downgraded to a
      // shadow snapshot, because every driver in the map is registered.
      const unavailable = yield* registry.listUnavailable;
      expect(unavailable).toEqual([]);

      const instances = yield* registry.listInstances;
      expect(instances).toHaveLength(2);
      expect(instances.map((instance) => instance.instanceId).toSorted()).toEqual(
        [codexId, claudeId].toSorted(),
      );

      // Instance lookup by id resolves each instance to its own bundle —
      // this is how rest-of-server routes turn/session calls in the new
      // model. Each driver's bundle carries its advertised `driverKind`.
      const codex = yield* registry.getInstance(codexId);
      const claude = yield* registry.getInstance(claudeId);
      expect(codex?.driverKind).toBe(codexDriverKind);
      expect(claude?.driverKind).toBe(claudeDriverKind);
      expect(codex?.displayName).toBe("Codex");
      expect(claude?.displayName).toBe("Claude");

      // Every instance owns its own set of closures — no sharing across
      // drivers. `orchestrationAdapter` / `textGeneration` / `snapshot` are all
      // distinct references even when two instances happen to share a
      // trait (e.g. several drivers use a stub-or-real
      // `textGeneration`; they must still be different object values).
      const adapters = [
        codex!.orchestrationAdapter,
        claude!.orchestrationAdapter,
      ];
      expect(new Set(adapters).size).toBe(adapters.length);
      const textGenerations = [
        codex!.textGeneration,
        claude!.textGeneration,
      ];
      expect(new Set(textGenerations).size).toBe(textGenerations.length);
      const snapshots = [
        codex!.snapshot,
        claude!.snapshot,
      ];
      expect(new Set(snapshots).size).toBe(snapshots.length);

      // Snapshots identify themselves by `instanceId` + `driver` so
      // downstream aggregation in `ProviderRegistry` can tell instances
      // apart even when two share a driver. With `enabled: false`, the
      // check short-circuits and we get a disabled/pending snapshot back
      // — that's enough signal to validate the stamping wrapper without
      // spawning real binaries.
      const codexSnapshot = yield* codex!.snapshot.getSnapshot;
      expect(codexSnapshot.instanceId).toBe(codexId);
      expect(codexSnapshot.driver).toBe(codexDriverKind);
      expect(codexSnapshot.enabled).toBe(false);
      expect(codexSnapshot.continuation?.groupKey).toBe(
        `codex:home:${(yield* Path.Path).resolve("/home/julius/.codex")}`,
      );

      const claudeSnapshot = yield* claude!.snapshot.getSnapshot;
      expect(claudeSnapshot.instanceId).toBe(claudeId);
      expect(claudeSnapshot.driver).toBe(claudeDriverKind);
      expect(claudeSnapshot.enabled).toBe(false);
      expect(claudeSnapshot.continuation?.groupKey).toBe(
        `claude:home:${(yield* Path.Path).resolve("/home/julius/.claude-work")}`,
      );
    }).pipe(Effect.provide(layerTest)),
  );
});
