// ), apps/server/src/provider/providerCompatibility.test.ts @ ab3a3cd1.
import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@caveman-app/protocol";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as ServerConfig from "../config.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderLatestVersions from "@caveman-app/engine-core/server/ProviderLatestVersions";
import * as ProviderInstanceRegistry from "./ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "@caveman-app/engine-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@caveman-app/engine-core/server/maintenanceResolver";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import * as Schema from "effect/Schema";
import { satisfiesSemverRange } from "@caveman-app/shared/semver";
import {
  applyProviderCompatibility,
  CAVEMAN_CODE_VERSION,
  ProviderCompatibilityPolicy,
  resolveProviderCompatibility,
} from "./providerCompatibility.ts";
import { resolveAntigravityReleaseAsset } from "./antigravityRelease.ts";
import bundledManifest from "./model-manifest.json" with { type: "json" };

const decodeCompatibilityPolicies = Schema.decodeUnknownSync(
  Schema.Array(ProviderCompatibilityPolicy),
);
const driver = ProviderDriverKind.make("codex");
const policy: ProviderCompatibilityPolicy = {
  driver,
  cavemanCodeRange: ">=0.0.0 <0.1.0",
  recommendedVersion: "2.0.0",
  recommendedRange: ">=2.0.0 <3.0.0",
  ranges: [
    { range: "<1.0.0", status: "broken" },
    { range: ">=1.0.0 <1.5.0", status: "unsupported" },
    { range: ">=1.5.0 <2.0.0", status: "graceful" },
    { range: ">=2.0.0 <3.0.0", status: "supported" },
  ],
};
const provider: ServerProvider = {
  driver,
  instanceId: ProviderInstanceId.make("codex-work"),
  enabled: true,
  installed: true,
  version: "0.9.0",
  status: "error",
  message: "Authentication failed",
  checkedAt: "2026-09-22T00:00:00Z",
  auth: { status: "unauthenticated" },
  models: [],
  skills: [],
  slashCommands: [],
};

describe("provider compatibility", () => {
  it("offers Homebrew metadata recovery only while installed and latest versions are incompatible", () => {
    const versionAdvisory = {
      status: "current",
      currentVersion: "1.0.0",
      latestVersion: "1.0.0",
      canUpdate: true,
      updateCommand: "brew upgrade --cask codex",
      checkedAt: provider.checkedAt,
      message: null,
    } as const;
    for (const [version, command] of [
      ["1.0.0", "brew upgrade --cask codex"],
      ["0.9.0", "brew upgrade codex"],
    ] as const) {
      const stale = {
        ...provider,
        version,
        versionAdvisory: {
          ...versionAdvisory,
          currentVersion: version,
          latestVersion: version,
          updateCommand: command,
        },
      };
      const result = applyProviderCompatibility(stale, [policy], []);
      assert.include(result.compatibilityAdvisory?.message ?? "", `brew update && ${command}`);
      assert.include(result.compatibilityAdvisory?.message ?? "", "environment's host");
      assert.include(result.compatibilityAdvisory?.message ?? "", "refresh provider status");
      assert.strictEqual(result.message, provider.message);
      assert.deepStrictEqual(result.versionAdvisory, stale.versionAdvisory);

      const refreshed = applyProviderCompatibility(
        { ...result, versionAdvisory: { ...stale.versionAdvisory, latestVersion: "2.0.0" } },
        [policy],
        [],
      );
      assert.strictEqual(refreshed.compatibilityAdvisory?.latestVersionStatus, "supported");
      assert.notInclude(refreshed.compatibilityAdvisory?.message ?? "", "brew update");
    }

    for (const advisory of [
      { ...versionAdvisory, updateCommand: "npm install -g @openai/codex@latest" },
      { ...versionAdvisory, updateCommand: null, canUpdate: false },
      { ...versionAdvisory, latestVersion: null },
      { ...versionAdvisory, latestVersion: "9.0.0" },
    ]) {
      const result = applyProviderCompatibility(
        { ...provider, versionAdvisory: advisory },
        [policy],
        [],
      );
      assert.notInclude(result.compatibilityAdvisory?.message ?? "", "brew update");
    }
  });

  it("bundles a compatibility policy for every built-in harness", () => {
    for (const builtIn of BUILT_IN_DRIVERS) {
      // Registry entries are arbitrary external ACP agents, not one versioned harness.
      if (builtIn.driverKind === "acpRegistry") continue;
      // The Caveman engine runs in process from a vendored build that ships with
      // the app, so there is no installed harness version to check.
      if (builtIn.driverKind === "caveman") continue;
      assert.isDefined(
        resolveProviderCompatibility(
          ModelManifest.BUNDLED_MODEL_MANIFEST.compatibility,
          builtIn.driverKind,
          null,
        ),
        `Missing bundled compatibility policy for ${builtIn.driverKind}`,
      );
    }
  });

  it("ships Caveman Code's own policies, for the engines it runs, keyed on this build", () => {
    const bundled = ModelManifest.BUNDLED_MODEL_MANIFEST;
    assert.deepStrictEqual(
      bundled.compatibility?.map((entry) => entry.driver),
      ["codex", "claudeAgent", "cursor", "opencode", "muse", "grok", "pi", "antigravity"],
    );
    assert.deepStrictEqual(Object.keys(bundled.currentModels), ["codex", "claudeAgent"]);
    assert.deepStrictEqual(Object.keys(bundled.providers ?? {}), ["codex", "claudeAgent"]);
    for (const entry of bundled.compatibility ?? []) {
      assert.isTrue(satisfiesSemverRange(CAVEMAN_CODE_VERSION, entry.cavemanCodeRange));
    }
    const status = (kind: string, version: string) =>
      resolveProviderCompatibility(bundled.compatibility, ProviderDriverKind.make(kind), version)
        ?.status;
    assert.strictEqual(status("codex", "0.159.0"), "supported");
    assert.strictEqual(status("codex", "0.150.0"), "unsupported");
    assert.strictEqual(status("codex", "0.148.0"), "broken");
    assert.strictEqual(status("claudeAgent", "2.1.281"), "supported");
    // Before 2.1.281 some sessions (Bedrock, telemetry off) read CLAUDE.md only, so a repo with just an
    // AGENTS.md gave Claude Agent no instructions: it still works, and the app recommends the update.
    assert.strictEqual(status("claudeAgent", "2.1.280"), "graceful");
    assert.strictEqual(status("claudeAgent", "2.1.200"), "graceful");
    assert.strictEqual(status("claudeAgent", "2.1.110"), "unsupported");
 // native date version carries a build hash.
    assert.strictEqual(status("cursor", "2026.05.09-0a1b2c3"), "supported");
    assert.strictEqual(status("cursor", "2026.04.01"), "unknown");
    assert.strictEqual(status("opencode", "2.0.28"), "supported");
    assert.strictEqual(status("opencode", "1.14.20"), "graceful");
    // Muse appends a release revision.
    assert.strictEqual(status("muse", "1.4.6-R2"), "supported");
    assert.strictEqual(status("antigravity", "agy_acp_server_1.1.1"), "supported");
    // A policy for a later release does not apply to this build.
    assert.isUndefined(
      resolveProviderCompatibility([{ ...policy, cavemanCodeRange: ">=99.0.0" }], driver, "2.0.0"),
    );
  });

  it("supports the managed Antigravity runtime in the bundled manifest", () => {
    const policies = decodeCompatibilityPolicies(bundledManifest.compatibility);
    const release = resolveAntigravityReleaseAsset("darwin", "arm64");
    assert.strictEqual(
      resolveProviderCompatibility(
        policies,
        ProviderDriverKind.make("antigravity"),
        `agy_acp_server_${release?.version}`,
      )?.status,
      "supported",
    );
  });

  it("classifies boundaries and treats unlisted versions and release tags as unknown", () => {
    for (const [version, expected] of [
      ["0.9.9", "broken"],
      ["1.0.0", "unsupported"],
      ["1.5.0", "graceful"],
      ["2.0.0", "supported"],
      ["v2.0.0", "supported"],
      ["3.0.0", "unknown"],
      ["2.0.0-beta.1", "unknown"],
      ["agy_acp_server_20260818_01_RC01", "unknown"],
      [null, "unknown"],
    ] as const) {
      assert.strictEqual(resolveProviderCompatibility([policy], driver, version)?.status, expected);
    }
    assert.isUndefined(resolveProviderCompatibility([policy], driver, "0.9.0", "0.1.0"));
  });

  it("supports every driver without inventing policies for uncovered adapters", () => {
    for (const kind of ["codex", "claudeAgent", "customDriver"]) {
      const adapter = ProviderDriverKind.make(kind);
      assert.strictEqual(
        resolveProviderCompatibility([{ ...policy, driver: adapter }], adapter, "2.0.0")?.status,
        "supported",
      );
      assert.isUndefined(resolveProviderCompatibility([], adapter, "2.0.0"));
    }
  });

  it("relaxes remote policy without losing probe errors, and falls back when a policy is omitted", () => {
    const broken = applyProviderCompatibility(provider, [], [policy]);
    assert.strictEqual(broken.compatibilityAdvisory?.status, "broken");
    const relaxed = { ...policy, ranges: [{ range: ">=0.0.0", status: "supported" as const }] };
    const supported = applyProviderCompatibility(broken, [relaxed], [policy]);
    assert.strictEqual(supported.compatibilityAdvisory?.status, "supported");
    assert.strictEqual(supported.status, "error");
    assert.strictEqual(supported.message, "Authentication failed");
    assert.strictEqual(
      applyProviderCompatibility(supported, [{ ...policy, cavemanCodeRange: ">=9.0.0" }], [policy])
        .compatibilityAdvisory?.status,
      "broken",
    );
    const removed = applyProviderCompatibility(supported, [], []);
    assert.isUndefined(removed.compatibilityAdvisory);
    assert.strictEqual(removed.status, "error");
    assert.strictEqual(removed.message, "Authentication failed");
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, enabled: false }, [], [policy]).compatibilityAdvisory,
    );
    assert.isUndefined(
      applyProviderCompatibility({ ...broken, installed: false }, [], [policy])
        .compatibilityAdvisory,
    );
  });

  it("rejects invalid ranges and recommendations outside the first supported match", () => {
    const decode = Schema.decodeUnknownSync(ProviderCompatibilityPolicy);
    assert.doesNotThrow(() => decode(policy));
    const prefixed = decode({
      ...policy,
      cavemanCodeRange: ">=v0.0.0 <v0.1",
      recommendedRange: "^v2",
      ranges: [{ range: ">=v2.0 <v3", status: "supported" }],
    });
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "2.0.0")?.status,
      "supported",
    );
    assert.strictEqual(
      resolveProviderCompatibility([prefixed], driver, "3.0.0")?.status,
      "unknown",
    );
    for (const invalid of [
      { ...policy, cavemanCodeRange: "*" },
      { ...policy, recommendedVersion: "3.0.0" },
      { ...policy, ranges: [{ range: ">=2.0.0 garbage", status: "supported" }] },
      { ...policy, recommendedVersion: "2.0.0; echo unsafe" },
      { ...policy, ranges: [{ range: ">=0.0.0", status: "broken" }, ...policy.ranges] },
    ])
      assert.throws(() => decode(invalid));
  });
});

it.effect("a remote policy refresh preserves a newer health result on the registry stream", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const health = yield* Ref.make<ServerProvider>({
      ...provider,
      status: "ready" as ServerProvider["status"],
      message: "Healthy",
    });
    const manifest = yield* Ref.make<ModelManifest.ModelManifestData>({
      version: 1,
      currentModels: {},
      compatibility: [policy],
    });
    const instance: ProviderInstance = {
      instanceId: provider.instanceId,
      driverKind: driver,
      enabled: true,
      displayName: undefined,
      continuationIdentity: { driverKind: driver, continuationKey: "test-codex" },
      snapshot: {
        getSnapshot: Ref.get(health),
        refresh: Ref.get(health),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
      },
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const refresh = Deferred.succeed(started, undefined).pipe(
      Effect.andThen(Deferred.await(release)),
      Effect.andThen(
        Ref.updateAndGet(manifest, (current) => ({
          ...current,
          compatibility: [
            { ...policy, ranges: [{ range: ">=0.0.0", status: "supported" as const }] },
          ],
        })),
      ),
    );
    const layerDependencies = Layer.mergeAll(
      ProviderLatestVersions.layer,
      Layer.succeed(ModelManifest.ModelManifest, {
        current: Ref.get(manifest),
        refresh,
        forceRefresh: refresh,
        refreshInBackground: Effect.void,
      }),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: (id) => Effect.succeed(id === instance.instanceId ? instance : undefined),
        listInstances: Effect.succeed([instance]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
      }),
      ServerConfig.layerTest(process.cwd(), { prefix: "compatibility-registry-test" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    yield* Effect.gen(function* () {
      const registry = yield* ProviderRegistry.ProviderRegistry;
      yield* Deferred.await(started);
      assert.strictEqual(
        (yield* registry.getProviders)[0]?.compatibilityAdvisory?.status,
        "broken",
      );
      yield* Ref.set(health, provider);
      const latestHealth = yield* registry.refreshInstance(provider.instanceId);
      assert.strictEqual(latestHealth[0]?.message, "Authentication failed");
      const supported = yield* Stream.toPull(
        registry.streamChanges.pipe(
          Stream.filter((snapshots) => snapshots[0]?.compatibilityAdvisory?.status === "supported"),
        ),
      );
      const subscribed = yield* supported.pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      const updated = (yield* Fiber.join(subscribed))[0]?.[0];
      assert.strictEqual(updated?.compatibilityAdvisory?.status, "supported");
      assert.strictEqual(updated?.status, "error");
      assert.strictEqual(updated?.message, "Authentication failed");
    }).pipe(Effect.provide(ProviderRegistry.layer.pipe(Layer.provide(layerDependencies))));
  }).pipe(Effect.scoped),
);

it("recomputes latest-version compatibility without losing the underlying update advisory", () => {
  const snapshot: ServerProvider = {
    ...provider,
    version: "2.0.0",
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "2.0.0",
      latestVersion: "4.0.0",
      canUpdate: true,
      updateCommand: "npm install -g fixture@latest",
      checkedAt: provider.checkedAt,
      message: null,
    },
  };
  const blockedPolicy: ProviderCompatibilityPolicy = {
    ...policy,
    ranges: [...policy.ranges, { range: ">=3.0.0", status: "broken" }],
  };
  const blocked = applyProviderCompatibility(snapshot, [blockedPolicy], []);
  assert.strictEqual(blocked.compatibilityAdvisory?.latestVersionStatus, "broken");
  const relaxed = applyProviderCompatibility(
    blocked,
    [{ ...policy, ranges: [{ range: ">=2.0.0", status: "supported" }] }],
    [],
  );
  assert.strictEqual(relaxed.compatibilityAdvisory?.latestVersionStatus, "supported");
  assert.deepStrictEqual(relaxed.versionAdvisory, snapshot.versionAdvisory);
});
