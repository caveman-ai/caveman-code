// ), apps/server/src/orchestration-v2/Adapters/AcpRegistryAdapterV2.test.ts @ ab3a3cd1.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ModelSelection,
  type OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@caveman-app/protocol";
import { resolveSelfInvocation } from "@caveman-app/shared/nodeRuntime";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "@caveman-app/effect-acp/errors";
import type * as EffectAcpSchema from "@caveman-app/effect-acp/compat";

import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { makeProviderFailure } from "@caveman-app/engine-core/server/failure";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as SessionPlugins from "@caveman-app/engine-core/server/SessionPlugins";
import * as TestProviderHost from "@caveman-app/engine-testing/TestProviderHost";
import * as ServerSettings from "../../serverSettings.ts";
import type {
  AcpRegistryAvailableCommands,
  AcpRegistryLiveConfiguration,
} from "@caveman-app/provider-acp-registry/testing";
import * as AcpRegistrySupport from "@caveman-app/provider-acp-registry/server/AcpRegistrySupport";
import * as AcpRegistryRuntimeCoordinator from "@caveman-app/provider-acp-registry/server/AcpRegistryRuntimeCoordinator";
import { ACP_SESSION_MODE_OPTION_ID } from "@caveman-app/provider-acp/server/sessionConfig";
import * as AcpSessionRuntime from "@caveman-app/provider-acp/server/AcpSessionRuntime";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import {
  decodeAcpReplayTranscript,
  makeAcpReplayCompletenessAssertion,
  makeAcpReplayRuntime,
  makeTurnInput,
} from "./AcpAdapterV2.testkit.ts";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import { AcpRegistryAdapterV2Driver } from "@caveman-app/provider-acp-registry/server";
import {
  ACP_REGISTRY_PROVIDER,
  makeAcpRegistryAdapterV2,
  acpRegistryPromptFailure,
  acpRegistryProbeResult,
} from "@caveman-app/provider-acp-registry/testing";

const registryUrl = "https://registry.test/registry.json";
const decodeAcpRegistryAdapterSettings = Schema.decodeUnknownEffect(
  AcpRegistryAdapterV2Driver.configSchema,
);

const layerHost = TestProviderHost.layer().pipe(
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const layerRegistry = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          version: "1.0.0",
          agents: [
            {
              id: "fixture-agent",
              name: "Fixture Agent",
              version: "1.0.0",
              description: "ACP V2 adapter fixture",
              // Every platform the registry names: the tests run the agent from commandPath on any host.
              distribution: {
                binary: Object.fromEntries(
                  ["darwin-aarch64", "darwin-x86_64", "linux-aarch64", "linux-x86_64", "windows-aarch64", "windows-x86_64"].map(
                    (target) => [target, { archive: "https://registry.test/unused", cmd: "fixture-agent", args: [] }],
                  ),
                ),
              },
            },
          ],
        }),
      ),
    ),
  ),
);

// Adapters given an explicit runtime never resolve through the catalog.
const layerInjectedRuntimeCatalog = Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
  resolve: () => Effect.die("the runtime is injected"),
});

const layerTest = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  layerHost,
  layerRegistry,
  ServerSettings.layerTest(),
);

describe("AcpRegistryAdapterV2", () => {
  it("preserves and sanitizes structured ACP errors without exposing arbitrary defects", () => {
    const limit = new EffectAcpErrors.AcpRequestError({
      code: -31001,
      errorMessage: "Rate limit exceeded for mistral (model: mistral-vibe-cli-latest).",
    });
    assert.deepEqual(acpRegistryPromptFailure("mistral-vibe", limit), {
      class: "usage_limit",
      message: limit.errorMessage,
      code: "-31001",
      retryable: null,
    });
    assert.equal(acpRegistryPromptFailure("other-agent", limit).class, "provider_error");
    assert.equal(
      acpRegistryPromptFailure("mistral-vibe", new Error("private defect")).message,
      "Provider turn failed.",
    );
    const rejected = acpRegistryPromptFailure(
      "any-agent",
      new EffectAcpErrors.AcpRequestError({
        code: -32603,
        errorMessage: "Request rejected. api_key=private-key https://example.test/?token=secret",
      }),
    );
    assert.include(rejected.message, "Request rejected.");
    assert.notInclude(rejected.message, "private-key");
    assert.notInclude(rejected.message, "token=secret");
  });
  it("is registered as a generic provider driver with schema defaults", () => {
    assert.equal(AcpRegistryAdapterV2Driver.driverKind, ACP_REGISTRY_PROVIDER);
    assert.deepEqual(AcpRegistryAdapterV2Driver.defaultConfig(), {
      source: "registry",
      commandArgs: [],
      enabled: true,
      agentId: "",
      commandPath: "",
      authMethodId: "",
      distribution: "auto",
      customModels: [],
    });
  });

  describe("the agent's own pickers", () => {
    type Frame = Record<string, unknown>;
    const outbound = (method: string, params: unknown = "<any>"): Frame => ({
      type: "expect_outbound",
      frame: { kind: "request", method, params },
    });
    const answer = (method: string, result: unknown): Frame => ({
      type: "emit_inbound",
      frame: { kind: "response", method, result },
    });
    const permissionModeOption = (currentValue: string) => ({
      id: "permission-mode",
      name: "Permission mode",
      category: "mode",
      type: "select",
      currentValue,
      options: ["ask", "auto"].map((value) => ({ value, name: value })),
    });

    // A scripted ACP v1 agent: initialize, session/new answered with `setup`,
    // then the frames Caveman Code must send (and the agent's answers) to apply
    // the user's stored model or mode pick.
    const openWithStoredPicks = Effect.fn("openWithStoredPicks")(function* (input: {
      readonly setup: unknown;
      readonly pickFrames: ReadonlyArray<Frame>;
      readonly customModels?: ReadonlyArray<string>;
      readonly storedModel?: string;
      readonly storedModePick?: string;
      readonly turnModels?: ReadonlyArray<string>;
      readonly rejectedModel?: string;
    }) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-acp-registry-stored-picks-",
      });
      const statusPath = path.join(replayDir, "status.json");
      const transcript = yield* decodeAcpReplayTranscript(
        {
          provider: ACP_REGISTRY_PROVIDER,
          protocol: "acp.ndjson-jsonrpc",
          version: "1",
          scenario: "stored-picks",
          entries: [
            outbound("initialize"),
            answer("initialize", {
              protocolVersion: 1,
              agentCapabilities: { loadSession: false },
              authMethods: [{ id: "test", name: "Test" }],
            }),
            outbound("session/new"),
            answer("session/new", { sessionId: "agent-session", ...(input.setup as object) }),
            ...input.pickFrames,
          ] as never,
        },
        ACP_REGISTRY_PROVIDER,
      );
      const instanceId = ProviderInstanceId.make("acp-registry-stored-picks");
      let published: AcpRegistryLiveConfiguration | undefined;
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
          customModels: input.customModels ?? [],
        }),
        environment: {},
        makeRuntime: makeAcpReplayRuntime({
          customModels: input.customModels,
          transcript,
          statusPath,
          scriptPath: yield* path.fromFileUrl(
            new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
          ),
          childProcessSpawner,
          fileSystem,
        }),
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            layerInjectedRuntimeCatalog,
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (_startupKey, effect) => effect,
              publishLiveConfiguration: (_instanceId, configuration) =>
                Effect.sync(() => {
                  published = configuration;
                }),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-stored-picks");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: replayDir,
      });
      const stored: ModelSelection = {
        instanceId,
        model: input.storedModel ?? "default",
        ...(input.storedModePick === undefined
          ? {}
          : { options: [{ id: ACP_SESSION_MODE_OPTION_ID, value: input.storedModePick }] }),
      };
      const configurations: Array<AcpRegistryLiveConfiguration | undefined> = [];
      yield* Effect.gen(function* () {
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("provider-session-stored-picks"),
          modelSelection: stored,
          runtimePolicy,
        });
        configurations.push(published);
        if (input.turnModels === undefined) return;
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: stored,
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        let current = stored;
        for (const [index, model] of input.turnModels.entries()) {
          const target: ModelSelection = { instanceId, model };
          const plan = yield* adapter.planSelectionTransition({
            current,
            target,
            sessionCapabilities: runtime.providerSession.capabilities,
          });
          assert.equal(plan.type, "apply_on_next_turn");
          yield* runtime.startTurn(
            makeTurnInput({
              threadId,
              providerThread,
              instanceId,
              runtimePolicy,
              now,
              ordinal: index + 1,
              modelSelection: target,
            }),
          );
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.terminal") {
                  assert.equal(event.status, "completed", event.failure?.message);
                }
              }),
            ),
          );
          configurations.push(published);
          current = target;
        }
      }).pipe(
        Effect.match({
          onFailure: (error) => {
            assert.isDefined(input.rejectedModel);
            assert.equal(
              makeProviderFailure({ cause: error }).message,
              `The agent did not accept the model "${input.rejectedModel}". Choose another model for this provider, then retry.`,
            );
          },
          onSuccess: () => assert.isUndefined(input.rejectedModel),
        }),
        Effect.scoped,
      );
      // Closing the session stops the agent, which writes its replay status in
      // the same tick as its last answer. The script must be consumed exactly.
      yield* makeAcpReplayCompletenessAssertion(fileSystem, statusPath, transcript);
      return { configurations };
    });

    it.effect("switches an agent that only advertises modes with session/set_mode", () =>
      openWithStoredPicks({
        setup: {
          modes: {
            currentModeId: "default",
            availableModes: ["default", "autoEdit"].map((id) => ({ id, name: id })),
          },
        },
        pickFrames: [
          outbound("session/set_mode", { sessionId: "agent-session", modeId: "autoEdit" }),
          answer("session/set_mode", {}),
        ],
        storedModePick: "autoEdit",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect("switches a mode config option under its own id", () =>
      openWithStoredPicks({
        setup: { configOptions: [permissionModeOption("ask")] },
        pickFrames: [
          outbound("session/set_config_option", {
            sessionId: "agent-session",
            configId: "permission-mode",
            value: "auto",
          }),
          answer("session/set_config_option", { configOptions: [permissionModeOption("auto")] }),
        ],
        storedModePick: "auto",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    const modelOption = (id: string, currentValue: string, grouped = false) => ({
      id,
      name: "Model",
      category: "model",
      type: "select",
      currentValue,
      options: grouped
        ? [{ group: "models", name: "Models", options: [{ value: "default", name: "Default" }] }]
        : [{ value: "auto", name: "Auto" }],
    });
    const configOptionUpdate = (configOptions: ReadonlyArray<unknown>): Frame => ({
      type: "emit_inbound",
      frame: {
        kind: "notification",
        method: "session/update",
        params: {
          sessionId: "agent-session",
          update: { sessionUpdate: "config_option_update", configOptions },
        },
      },
    });
    const prompt = (...updates: ReadonlyArray<Frame>): ReadonlyArray<Frame> => [
      outbound("session/prompt"),
      ...updates,
      answer("session/prompt", { stopReason: "end_turn" }),
    ];
    const setModel = (modelId: string): ReadonlyArray<Frame> => [
      outbound("session/set_model", { sessionId: "agent-session", modelId }),
      answer("session/set_model", {}),
    ];

    it.effect(
      "discovers session models and switches through live model configuration changes",
      () =>
        Effect.gen(function* () {
          const flatOption = (current: string) => modelOption("live-model", current);
          const groupedOption = (current: string) =>
            modelOption("replacement-model", current, true);
          const { configurations } = yield* openWithStoredPicks({
            setup: {
              models: {
                currentModelId: "hermes",
                availableModels: ["hermes", "auto", "default"].map((modelId) => ({
                  modelId,
                  name: modelId,
                })),
              },
            },
            customModels: ["custom-model"],
            storedModel: "default",
            turnModels: [
              "hermes",
              "custom-model",
              "auto",
              "default",
              "hermes",
              "custom-model",
              "auto",
              "custom-model",
              "default",
              "hermes",
            ],
            pickFrames: [
              ...setModel("default"),
              ...setModel("hermes"),
              ...prompt(),
              ...setModel("custom-model"),
              ...prompt(),
              ...setModel("auto"),
              ...prompt(),
              ...setModel("default"),
              ...prompt(),
              ...setModel("hermes"),
              ...prompt(configOptionUpdate([flatOption("hermes")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("custom-model")] }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "live-model",
                value: "auto",
              }),
              answer("session/set_config_option", { configOptions: [flatOption("auto")] }),
              ...prompt(configOptionUpdate([groupedOption("auto")])),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "custom-model",
              }),
              answer("session/set_config_option", {
                configOptions: [groupedOption("custom-model")],
              }),
              ...prompt(),
              outbound("session/set_config_option", {
                sessionId: "agent-session",
                configId: "replacement-model",
                value: "default",
              }),
              answer("session/set_config_option", { configOptions: [groupedOption("default")] }),
              ...prompt(configOptionUpdate([])),
              ...setModel("hermes"),
              ...prompt(),
            ],
          });
          assert.deepEqual(
            configurations.map((configuration) => ({
              models: configuration?.models.map((model) => model.id),
              current: configuration?.currentModelId,
            })),
            [
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
              { models: ["hermes", "auto", "default"], current: null },
              { models: ["hermes", "auto", "default"], current: "auto" },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["auto"], current: null },
              { models: ["auto"], current: null },
              { models: ["default"], current: null },
              { models: ["default"], current: null },
              { models: ["hermes", "auto", "default"], current: "default" },
              { models: ["hermes", "auto", "default"], current: "hermes" },
            ],
          );
        }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    it.effect.each([
      "config",
      "legacy",
      "updated-config",
      "removed-config",
      "configuration-update",
      "unavailable-before-configuration",
    ] as const)(
      "rejects an unavailable explicit model in a %s catalog before inference",
      (catalog) => {
        const duringTurn = catalog === "updated-config" || catalog === "removed-config";
        const duringConfiguration = catalog === "configuration-update";
        const changesOptions =
          duringConfiguration || catalog === "unavailable-before-configuration";
        const model = duringTurn || duringConfiguration ? "hermes" : "missing";
        const restrictedOption = {
          ...modelOption("model", "other"),
          options: [{ value: "other", name: "Other" }],
        };
        return openWithStoredPicks({
          setup: {
            ...(catalog === "legacy" || catalog === "removed-config"
              ? {
                  models: {
                    currentModelId: "other",
                    availableModels: [{ modelId: "other", name: "Other" }],
                  },
                }
              : {}),
            configOptions:
              catalog === "legacy"
                ? []
                : [
                    {
                      ...modelOption("model", "hermes"),
                      options: [{ value: "hermes", name: "Hermes" }],
                    },
                    ...(changesOptions ? [permissionModeOption("ask")] : []),
                  ],
          },
          storedModel: model,
          ...(duringTurn ? { turnModels: [model, model] } : {}),
          ...(changesOptions ? { storedModePick: "auto" } : {}),
          rejectedModel: model,
          pickFrames: duringTurn
            ? prompt(configOptionUpdate(catalog === "removed-config" ? [] : [restrictedOption]))
            : duringConfiguration
              ? [
                  outbound("session/set_config_option", {
                    sessionId: "agent-session",
                    configId: "permission-mode",
                    value: "auto",
                  }),
                  answer("session/set_config_option", {
                    configOptions: [restrictedOption, permissionModeOption("auto")],
                  }),
                ]
              : [],
        }).pipe(Effect.provide(layerTest), Effect.scoped);
      },
    );

    // regression: #19519 models come from session model state, not a hardcoded list
    it.effect("keeps unadvertised default and auto selections agent-controlled", () =>
      Effect.gen(function* () {
        const { configurations } = yield* openWithStoredPicks({
          setup: {
            models: {
              currentModelId: "hermes",
              availableModels: ["hermes", "other"].map((modelId) => ({ modelId, name: modelId })),
            },
          },
          storedModel: "default",
          turnModels: ["auto", "default", "other", "default", "auto", "default", "auto"],
          pickFrames: [
            ...prompt(),
            ...prompt(),
            ...setModel("other"),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("live-model", "other"),
                  options: [{ value: "other", name: "Other" }],
                },
              ]),
            ),
            ...prompt(),
            ...prompt(),
            ...prompt(
              configOptionUpdate([
                {
                  ...modelOption("replacement-model", "other", true),
                  options: [
                    {
                      group: "models",
                      name: "Models",
                      options: [{ value: "other", name: "Other" }],
                    },
                  ],
                },
              ]),
            ),
            ...prompt(),
          ],
        });
        assert.deepEqual(
          configurations.map((configuration) => configuration?.currentModelId),
          ["hermes", "hermes", "hermes", "other", "other", "other", "other", "other"],
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
    const modelOptions = [
      { id: "fast", name: "Fast", category: "model", type: "boolean", currentValue: false },
      {
        id: " ",
        name: "Unnamed",
        category: "model",
        type: "select",
        currentValue: "unaddressable",
        options: [{ value: "unaddressable", name: "Unaddressable" }],
      },
      {
        id: "provider",
        name: "Provider",
        category: "model",
        type: "select",
        currentValue: "gateway",
        options: [
          {
            group: "hosted",
            name: "Hosted",
            options: [
              { value: "gateway", name: "Gateway" },
              { value: "codex", name: "Codex" },
            ],
          },
        ],
      },
      {
        id: "model",
        name: "Model",
        category: "model",
        type: "select",
        currentValue: "later-model",
        options: [{ value: "later-model", name: "Later model" }],
      },
    ] as const;

    it.effect("opens a model from the catalog by writing the first usable model select", () =>
      Effect.gen(function* () {
        const setup = { sessionId: "agent-session", configOptions: modelOptions };
        const catalog = acpRegistryProbeResult(ProviderInstanceId.make("acp-registry-mode-pick"), {
          sessionId: setup.sessionId,
          initializeResult: { protocolVersion: 1 },
          sessionSetupResult: {
            ...setup,
            // The catalog uses the normalized groupId; ACP v1 sends group on the wire.
            configOptions: modelOptions.map((option) =>
              option.id === "provider"
                ? {
                    ...option,
                    options: [{ ...option.options[0], groupId: option.options[0].group }],
                  }
                : option,
            ),
          },
          modelConfigId: "provider",
        });
        assert.deepEqual(catalog.models, [
          { id: "gateway", name: "Gateway", description: null },
          { id: "codex", name: "Codex", description: null },
        ]);
        assert.equal(catalog.currentModelId, "gateway");
        const model = catalog.models[1]?.id;
        assert.isDefined(model);
        const opened = yield* openWithStoredPicks({
          setup,
          pickFrames: [
            outbound("session/set_config_option", {
              sessionId: "agent-session",
              configId: "provider",
              value: "codex",
            }),
            answer("session/set_config_option", {
              configOptions: modelOptions.map((option) =>
                option.id === "provider" ? { ...option, currentValue: "codex" } : option,
              ),
            }),
          ],
          storedModel: model,
        });
        assert.equal(opened.configurations.at(-1)?.currentModelId, "codex");
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );

    // Only the first usable model select is addressable, so a model offered
    // by a later one is unavailable: the turn fails instead of running on
    // "gateway", and no configuration is written.
    it.effect("rejects a later-option model without writing configuration", () =>
      openWithStoredPicks({
        setup: { configOptions: modelOptions },
        pickFrames: [],
        storedModel: "later-model",
        rejectedModel: "later-model",
      }).pipe(Effect.provide(layerTest), Effect.scoped),
    );
  });

  describe("URL sign-in", () => {
    type RuntimeService = AcpSessionRuntime.AcpSessionRuntime["Service"];
    const layerSignIn = Layer.mergeAll(
      layerTest,
      AcpRegistryRuntimeCoordinator.layer,
      layerInjectedRuntimeCatalog,
    );

    // The mock agent asks for a URL sign-in mid-turn and waits for the answer.
    const startTurnAwaitingSignIn = Effect.fn("startTurnAwaitingSignIn")(function* (name: string) {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const handlers: {
        sessionUpdate?: Parameters<RuntimeService["handleSessionUpdate"]>[0];
        permission?: Parameters<RuntimeService["handleRequestPermission"]>[0];
      } = {};
      const elicitationAnswer = yield* Deferred.make<EffectAcpSchema.CreateElicitationResponse>();
      const instanceId = ProviderInstanceId.make(`acp-registry-url-sign-in-${name}`);
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          authMethodId: "test",
        }),
        environment: {},
        makeRuntime: (input) =>
          Effect.gen(function* () {
            const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
            const context = yield* Layer.build(
              AcpSessionRuntime.layer({
                ...runtimeInput,
                spawn: {
                  command: process.execPath,
                  args: [mockAgentPath],
                  cwd: input.cwd,
                  env: { T3_ACP_EMIT_URL_ELICITATION: "1" },
                },
                authMethodId: "test",
              }).pipe(
                Layer.provide(
                  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                ),
              ),
            );
            const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
              Effect.provide(context),
            );
            return {
              ...runtime,
              handleSessionUpdate: (handler) =>
                Effect.sync(() => {
                  handlers.sessionUpdate = handler;
                }).pipe(Effect.andThen(runtime.handleSessionUpdate(handler))),
              handleRequestPermission: (handler) =>
                Effect.sync(() => {
                  handlers.permission = handler;
                }).pipe(Effect.andThen(runtime.handleRequestPermission(handler))),
              handleElicitation: (handler) =>
                runtime.handleElicitation((params, requestContext) =>
                  handler(params, requestContext).pipe(
                    Effect.tap((answer) => Deferred.succeed(elicitationAnswer, answer)),
                  ),
                ),
            } satisfies RuntimeService;
          }),
      });
      const threadId = ThreadId.make(`thread-acp-registry-url-sign-in-${name}`);
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make(`provider-session-url-sign-in-${name}`),
        modelSelection,
        runtimePolicy,
      });
      const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      yield* runtime.events.pipe(
        Stream.runForEach((event) => Queue.offer(events, event)),
        Effect.forkScoped,
      );
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const turn = yield* runtime
        .startTurn(
          makeTurnInput({
            threadId,
            providerThread,
            instanceId,
            runtimePolicy,
            now: yield* DateTime.now,
          }),
        )
        .pipe(Effect.forkScoped);
      while (Option.isNone(yield* coordinator.getUrlAuthAction(instanceId))) {
        yield* Effect.sleep("20 millis");
      }
      if (handlers.sessionUpdate === undefined || handlers.permission === undefined) {
        return yield* Effect.die("the ACP runtime must register its update and permission handlers");
      }
      return {
        coordinator,
        elicitationAnswer,
        events,
        instanceId,
        permission: handlers.permission,
        providerThread,
        runtime,
        sessionUpdate: handlers.sessionUpdate,
        turn,
      };
    });

    it.live("keeps streaming and asking for approvals while a sign-in waits for the person", () =>
      Effect.gen(function* () {
        const signIn = yield* startTurnAwaitingSignIn("busy");
        const update = yield* signIn
          .sessionUpdate({
            sessionId: "mock-session-1",
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "still streaming during sign-in" },
            },
          })
          .pipe(Effect.forkScoped);
        yield* signIn
          .permission(
            {
              sessionId: "mock-session-1",
              toolCall: { toolCallId: "tool-during-sign-in", title: "`ls`", kind: "execute" },
              options: [
                { optionId: "allow", name: "Allow", kind: "allow_once" },
                { optionId: "reject", name: "Reject", kind: "reject_once" },
              ],
            },
            { requestId: "permission-during-sign-in", method: "session/request_permission" },
          )
          .pipe(Effect.forkScoped);
        let streamed = false;
        let approvalShown = false;
        const projected = yield* Effect.gen(function* () {
          while (!streamed || !approvalShown) {
            const event = yield* Queue.take(signIn.events);
            streamed ||=
              event.type === "message.updated" &&
              event.message.text.includes("still streaming during sign-in");
            approvalShown ||=
              event.type === "runtime_request.updated" &&
              event.runtimeRequest.status === "pending";
          }
        }).pipe(Effect.timeoutOption("3 seconds"));
        const observed = {
          projected: Option.isSome(projected),
          streamed,
          approvalShown,
          updateHandled: update.pollUnsafe() !== undefined,
          signInStillPending: Option.isSome(
            yield* signIn.coordinator.getUrlAuthAction(signIn.instanceId),
          ),
        };
        // The person signs in, so nothing is left waiting when the session closes.
        yield* signIn.coordinator.acceptUrlAuthentication({
          instanceId: signIn.instanceId,
          elicitationId: "url-elicitation-1",
        });

        assert.deepEqual(observed, {
          projected: true,
          streamed: true,
          approvalShown: true,
          updateHandled: true,
          signInStillPending: true,
        });
      }).pipe(Effect.provide(layerSignIn), Effect.scoped),
    );

    it.live("Stop withdraws a sign-in the agent is still waiting on", () =>
      Effect.gen(function* () {
        const signIn = yield* startTurnAwaitingSignIn("stop");
        let providerTurnId: OrchestrationV2ProviderTurn["id"] | undefined;
        while (providerTurnId === undefined) {
          const event = yield* Queue.take(signIn.events);
          if (event.type === "provider_turn.updated") providerTurnId = event.providerTurn.id;
        }
        const stopped = yield* signIn.runtime
          .interruptTurn({ providerThread: signIn.providerThread, providerTurnId })
          .pipe(Effect.exit, Effect.timeoutOption("5 seconds"));

        const observed = {
          stopReturned: Option.isSome(stopped) && Exit.isSuccess(stopped.value),
          agentAnswer: Option.getOrNull(
            yield* Deferred.await(signIn.elicitationAnswer).pipe(Effect.timeoutOption("1 second")),
          ),
          signInStillPending: Option.isSome(
            yield* signIn.coordinator.getUrlAuthAction(signIn.instanceId),
          ),
        };
        yield* signIn.coordinator.acceptUrlAuthentication({
          instanceId: signIn.instanceId,
          elicitationId: "url-elicitation-1",
        });
        yield* Fiber.interrupt(signIn.turn);

        assert.deepEqual(observed, {
          stopReturned: true,
          agentAnswer: { action: "cancel" },
          signInStillPending: false,
        });
      }).pipe(Effect.provide(layerSignIn), Effect.scoped),
    );
  });

  it.effect("offers client terminals to Devin only and client fs to no registry agent", () =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const path = yield* Path.Path;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const advertisedCapabilities = Effect.fn("advertisedCapabilities")(function* (
        agentId: string,
      ) {
        let clientCapabilities: unknown;
        const instanceId = ProviderInstanceId.make(`acp-registry-capabilities-${agentId}`);
        const adapter = yield* makeAcpRegistryAdapterV2({
          selfInvocation: yield* resolveSelfInvocation(),
          instanceId,
          settings: yield* decodeAcpRegistryAdapterSettings({ agentId, authMethodId: "test" }),
          environment: {},
          makeRuntime: (input) =>
            Effect.gen(function* () {
              clientCapabilities = input.clientCapabilities;
              const { processEnvironment: _processEnvironment, ...runtimeInput } = input;
              const context = yield* Layer.build(
                AcpSessionRuntime.layer({
                  ...runtimeInput,
                  spawn: {
                    command: process.execPath,
                    args: [mockAgentPath],
                    cwd: input.cwd,
                    env: { T3_ACP_SESSION_LIFECYCLE: "1" },
                  },
                  authMethodId: "test",
                }).pipe(
                  Layer.provide(
                    Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
                  ),
                ),
              );
              return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
                Effect.provide(context),
              );
            }),
        }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        yield* adapter.openSession({
          threadId: ThreadId.make(`thread-acp-registry-capabilities-${agentId}`),
          providerSessionId: ProviderSessionId.make(`provider-session-capabilities-${agentId}`),
          modelSelection: { instanceId, model: "default" },
          runtimePolicy,
        });
        return clientCapabilities;
      });

      assert.deepInclude(yield* advertisedCapabilities("devin"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: true,
      });
      assert.deepInclude(yield* advertisedCapabilities("gemini"), {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("opens a real ACP child process resolved from registry configuration", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: host.paths.providerStatusCacheDir,
        toolsDir: host.paths.baseDir + "/tools",
        registryUrl,
      });
      const settings = yield* decodeAcpRegistryAdapterSettings({
        agentId: "fixture-agent",
        commandPath: process.execPath,
        authMethodId: "test",
      });
      let startupActive = false;
      let startupCount = 0;
      const instanceId = ProviderInstanceId.make("acp-registry-fixture");
      const commandsPublished = yield* Deferred.make<{
        readonly instanceId: ProviderInstanceId;
        readonly commands: AcpRegistryAvailableCommands;
      }>();
      const configurationPublished = yield* Deferred.make<AcpRegistryLiveConfiguration>();
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings,
        environment: {
          T3_ACP_SESSION_LIFECYCLE: "1",
          T3_ACP_COMMAND_ADVERTISEMENT_DELAY_MS: "750",
        },
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator)({
              withForegroundStartup: (agentId, effect) =>
                Effect.acquireUseRelease(
                  Effect.sync(() => {
                    assert.equal(agentId, "fixture-agent");
                    startupActive = true;
                    startupCount += 1;
                  }),
                  () => effect,
                  () =>
                    Effect.sync(() => {
                      startupActive = false;
                    }),
                ),
              runBackgroundProbe: (_agentId, effect) => effect.pipe(Effect.map(Option.some)),
              withSessionMutation: (effect) => effect,
              clearAvailableCommands: () => Effect.void,
              publishAvailableCommands: (publishedInstanceId, commands) =>
                Deferred.succeed(commandsPublished, {
                  instanceId: publishedInstanceId,
                  commands,
                }).pipe(Effect.asVoid),
              getAvailableCommands: () => Effect.succeed(Option.none()),
              watchAvailableCommands: () => Effect.never,
              clearLiveConfiguration: () => Effect.void,
              publishLiveConfiguration: (_publishedInstanceId, configuration) =>
                Deferred.succeed(configurationPublished, configuration).pipe(Effect.asVoid),
              getLiveConfiguration: () => Effect.succeed(Option.none()),
              watchLiveConfiguration: () => Effect.never,
              requestUrlAuthentication: () => Effect.succeed(false),
              acceptUrlAuthentication: () => Effect.succeed(false),
              getUrlAuthAction: () => Effect.succeed(Option.none()),
              watchUrlAuthAction: () => Effect.never,
            }),
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (configuredSettings, cwd, environment) =>
                Effect.sync(() => assert.isTrue(startupActive)).pipe(
                  Effect.andThen(resolver.resolve(configuredSettings, cwd, environment)),
                  Effect.map((resolved) => ({
                    ...resolved,
                    spawn: {
                      ...resolved.spawn,
                      args: [mockAgentPath],
                    },
                  })),
                ),
            }),
          ),
        ),
      );
      const threadId = ThreadId.make("thread-acp-registry-fixture");
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: process.cwd(),
      });
      const modelSelection = { instanceId, model: "default" } as const;
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-fixture"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });

      assert.equal(runtime.providerSession.driver, "acpRegistry");
      assert.equal(startupCount, 1);
      assert.isFalse(startupActive);
      assert.equal(providerThread.nativeThreadRef?.nativeId, "mock-session-1");
      assert.equal(providerThread.nativeMetadata?.itemIdentityVersion, 2);
      assert.isTrue(runtime.providerSession.capabilities.threads.canReadThreadSnapshot);
      assert.isTrue(runtime.providerSession.capabilities.threads.canForkThread);
      assert.deepEqual(yield* Deferred.await(commandsPublished), {
        instanceId,
        commands: {
          slashCommands: [
            {
              name: "review",
              description: "Review the current changes",
              input: { hint: "focus" },
            },
          ],
          skills: [
            {
              name: "workspace-skill",
              description: "Run the workspace skill",
              path: "acp://skill/workspace-skill",
              scope: "agent",
              enabled: true,
            },
          ],
        },
      });
      const configuration = yield* Deferred.await(configurationPublished);
      assert.equal(configuration.currentModelId, "default");
      assert.deepInclude(configuration.models[0], {
        id: "default",
        name: "Auto",
        description: null,
      });
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  // Caveman Code product rule: plugins get no ambient secrets. A registry
  // agent is third-party code, so the runtime's environment (API keys,
  // GITHUB_TOKEN, Caveman keys) must never reach it; only its instance's
  // configured variables do, and its home is its own.
  it.effect("starts a registry agent without the runtime's own environment, and [env] cannot undo its containment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const host = yield* ProviderHost.ProviderHost;
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.env.CAVEMAN_SENTINEL_SECRET = "sentinel-secret";
        }),
        () =>
          Effect.sync(() => {
            delete process.env.CAVEMAN_SENTINEL_SECRET;
          }),
      );
      const mockAgentPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-mock-agent.ts", import.meta.url),
      );
      const dumpDirectory = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "caveman-acp-env-",
      });
      const dumpPath = path.join(dumpDirectory, "env.json");
      const resolver = yield* AcpRegistrySupport.makeAcpRegistryCatalog({
        cacheDir: host.paths.providerStatusCacheDir,
        toolsDir: host.paths.baseDir + "/tools",
        registryUrl,
      });
      const instanceId = ProviderInstanceId.make("acp-registry-env");
      const adapter = yield* AcpRegistryAdapterV2Driver.create({
        instanceId,
        displayName: undefined,
        enabled: true,
        environment: [
          { name: "T3_ACP_ENV_DUMP_PATH", value: dumpPath, sensitive: false },
          { name: "AGENT_API_KEY", value: "configured-key", sensitive: true },
        ],
        config: yield* decodeAcpRegistryAdapterSettings({
          agentId: "fixture-agent",
          commandPath: process.execPath,
          authMethodId: "test",
        }),
      }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(AcpRegistrySupport.AcpRegistryCatalog)({
              resolve: (configuredSettings, cwd, environment) =>
                resolver.resolve(configuredSettings, cwd, environment).pipe(
                  Effect.map((resolved) => ({
                    ...resolved,
                    spawn: { ...resolved.spawn, args: [mockAgentPath] },
                  })),
                ),
            }),
            Layer.succeed(
              ProviderEventLoggers.ProviderEventLoggers,
              ProviderEventLoggers.NoOpProviderEventLoggers,
            ),
          ),
        ),
        // The workspace's [env] tries to take back the home, the credential and PATH.
        Effect.provideService(SessionPlugins.SessionPlugins, {
          acp: () => Effect.succeed([]),
          claudeAgent: () => Effect.die("unused"),
          codex: () => Effect.die("unused"),
          env: () =>
            Effect.succeed({
              CAVEMAN_PORT_WEB: "42100",
              HOME: "/repo-home",
              AGENT_API_KEY: "repo-key",
              PATH: "/repo/bin",
            }),
        }),
      );
      const threadId = ThreadId.make("thread-acp-registry-env");
      yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-acp-registry-env"),
        modelSelection: { instanceId, model: "default" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        }),
      });

      const agentEnvironment = JSON.parse(yield* fileSystem.readFileString(dumpPath));
      assert.isUndefined(agentEnvironment.CAVEMAN_SENTINEL_SECRET);
      assert.equal(agentEnvironment.AGENT_API_KEY, "configured-key");
      assert.equal(agentEnvironment.PATH, process.env.PATH);
      assert.equal(
        agentEnvironment.HOME,
        path.join(host.paths.stateDir, "acp-homes", "acp-registry-env"),
      );
      assert.isTrue(yield* fileSystem.exists(agentEnvironment.HOME));
      assert.equal(agentEnvironment.CAVEMAN_PORT_WEB, "42100");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect.each([
    {
      failure: "a lost session",
      error: {
        code: -32603,
        message: "Internal error",
        data: {
          details:
            "Request session.send failed with message: session event delivery failed: session not found: copilot-session",
        },
      },
      restarts: true,
    },
    {
      failure: "a lost session reported in the message",
      error: {
        code: -32603,
        message:
          "Request session.send failed with message: session event delivery failed: session not found: copilot-session",
      },
      restarts: true,
    },
    {
      failure: "a session-lock timeout",
      error: {
        code: -32603,
        message: "Internal error",
        data: {
          details:
            "session lock unavailable during is_session_generation_current: acquisition timed out",
        },
      },
      restarts: true,
    },
    {
      failure: "a session-lock timeout reported in the message",
      error: {
        code: -32603,
        message:
          "Request session.send failed with message: session lock unavailable during is_session_generation_current: acquisition timed out",
      },
      restarts: true,
    },
    {
      failure: "an unrelated internal error",
      error: {
        code: -32603,
        message: "Request session.send failed with message: Session directory no longer exists",
      },
      restarts: false,
    },
  ] as const)("runs Copilot's next message after $failure", ({ error, restarts }) =>
    Effect.gen(function* () {
      const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const replayDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-copilot-lost-" });
      const scriptPath = yield* path.fromFileUrl(
        new URL("../../../scripts/acp-replay-agent.ts", import.meta.url),
      );
      const request = (method: string, params: unknown = "<any>") => ({
        type: "expect_outbound",
        frame: { kind: "request", method, params },
      });
      const respond = (method: string, response: object) => ({
        type: "emit_inbound",
        frame: { kind: "response", method, ...response },
      });
      const start = (sessionId: string) => [
        request("initialize"),
        respond("initialize", {
          result: { protocolVersion: 1, agentCapabilities: { loadSession: true } },
        }),
        request("session/new"),
        respond("session/new", { result: { sessionId } }),
      ];
      const failedPrompt = [
        ...start("copilot-session"),
        request("session/prompt"),
        respond("session/prompt", { error }),
      ];
      const completedPrompt = [
        request("session/prompt"),
        respond("session/prompt", { result: { stopReason: "end_turn" } }),
      ];
      const processes = restarts
        ? [
            failedPrompt,
            [
              // The replacement process takes the same session back (session/load), with no new one first.
              ...start("replacement-session").slice(0, 2),
              request("session/load", {
                sessionId: "copilot-session",
                cwd: "<workspace>",
                mcpServers: "<any>",
              }),
              respond("session/load", { result: {} }),
              ...completedPrompt,
            ],
          ]
        : [[...failedPrompt, ...completedPrompt]];
      let spawned = 0;
      const instanceId = ProviderInstanceId.make("copilot-lost-session");
      const adapter = yield* makeAcpRegistryAdapterV2({
        selfInvocation: yield* resolveSelfInvocation(),
        instanceId,
        settings: yield* decodeAcpRegistryAdapterSettings({ agentId: "github-copilot-cli" }),
        environment: {},
        makeRuntime: (runtimeInput) =>
          Effect.gen(function* () {
            const index = spawned++;
            const transcript = yield* decodeAcpReplayTranscript(
              {
                provider: ACP_REGISTRY_PROVIDER,
                protocol: "acp.ndjson-jsonrpc",
                version: "1",
                scenario: `copilot-lost-session-${index}`,
                entries: processes[index] as never,
              },
              ACP_REGISTRY_PROVIDER,
            ).pipe(Effect.orDie);
            return yield* makeAcpReplayRuntime({
              transcript,
              statusPath: path.join(replayDir, `status-${index}.json`),
              scriptPath,
              childProcessSpawner,
              fileSystem,
            })(runtimeInput);
          }),
      }).pipe(Effect.provide(layerInjectedRuntimeCatalog));
      const threadId = ThreadId.make("thread-copilot-lost-session");
      const modelSelection = { instanceId, model: "default" } as const;
      const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: replayDir,
      });
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("session-copilot-lost-session"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const now = yield* DateTime.now;
      const runTurn = (ordinal: number) =>
        runtime
          .startTurn(
            makeTurnInput({ threadId, providerThread, instanceId, runtimePolicy, now, ordinal }),
          )
          .pipe(
            Effect.andThen(
              runtime.events.pipe(
                Stream.filter((event) => event.type === "turn.terminal"),
                Stream.take(1),
                Stream.runCollect,
              ),
            ),
            Effect.map(([terminal]) => terminal?.status),
          );
      assert.equal(yield* runTurn(1), "failed");
      assert.equal(yield* runTurn(2), "completed");
      assert.equal(spawned, restarts ? 2 : 1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
