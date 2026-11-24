// ), packages/provider-grok/src/server/adapter.ts @ 13aa882c22.
import { makeProviderFailure } from "@caveman-app/engine-core/server/failure";
import {
  XAiPromptFailureText,
  isXAiTaskCompletedWakeNotification,
  xAiRateLimitedErrorCode,
} from "./xaiAcpExtension.ts";
import { discoverGrokSkills, leadingGrokSkillMention } from "./skills.ts";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import { resolveSelfInvocation, type SelfInvocation } from "@caveman-app/shared/nodeRuntime";
import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type RuntimeMode,
} from "@caveman-app/protocol";
import { GrokSettings } from "../settings.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "@caveman-app/effect-acp/errors";
import type * as EffectAcpSchema from "@caveman-app/effect-acp/compat";
import { getModelSelectionStringOptionValue } from "@caveman-app/shared/model";

import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import { makeAcpNativeLoggerFactory } from "@caveman-app/provider-acp/server/nativeLogging";
import {
  applyGrokAcpModelSelection,
  currentGrokModelIdFromSessionSetup,
  GROK_DEFAULT_MODEL_SLUG,
  grokApprovalOptions,
  makeGrokAcpRuntime,
  resolveGrokAcpBaseModelId,
} from "./acpSupport.ts";
import { grokModelReasoningEfforts } from "./status.ts";
import {
  extractGrokPlanMarkdownFromToolCallData,
  extractXAiAcpBackgroundToolMutation,
  extractXAiAcpSubagentEndNotice,
  extractXAiAcpSubagentUpdate,
  extractXAiAskUserQuestionIdentity,
  extractXAiAskUserQuestions,
  extractXAiBackgroundTaskCompletion,
  extractXAiKilledBackgroundTasks,
  extractXAiMonitorTaskId,
  xAiBackgroundShellTaskId,
  isXAiPersistentMonitor,
  extractXAiExitPlanMarkdown,
  registerXAiSubagentFinished,
  makeXAiAskUserQuestionCancelledResponse,
  makeXAiAskUserQuestionResponse,
  makeXAiExitPlanModeCapturedResponse,
  normalizeXAiAcpToolCallState,
  registerXAiBackgroundTaskTracking,
  XAiAskUserQuestionRequest,
  XAiExitPlanModeRequest,
} from "./xaiAcpExtension.ts";
import {
  isHostProcessEnvName,
  mergeProviderInstanceEnvironment,
  withoutRuntimeEnv,
} from "@caveman-app/engine-core/server/instanceEnvironment";
import { acpPermissionDisposition } from "@caveman-app/provider-acp/server/clientPolicy";
import {
  collectSessionConfigOptionValues,
  findModelConfigOption,
  sessionModelStateFromInitialize,
} from "@caveman-app/provider-acp/server/runtimeModel";
import * as AcpSessionRuntime from "@caveman-app/provider-acp/server/AcpSessionRuntime";
import * as ProviderEventLoggers from "@caveman-app/engine-core/server/ProviderEventLoggers";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@caveman-app/engine-core/server/ProviderContinuationRequests";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import {
  ProviderAdapterDriverCreateError,
  type ProviderAdapterDriver,
  type ProviderAdapterDriverCreateInput,
} from "@caveman-app/engine-core/server/adapterDriver";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2ExtensionContext,
  type AcpAdapterV2Flavor,
  type AcpAdapterV2RuntimeInput,
} from "@caveman-app/provider-acp/server/adapter";

export const GROK_PROVIDER = ProviderDriverKind.make("grok");
const GROK_DRIVER_KIND = GROK_PROVIDER;
export const GROK_DEFAULT_INSTANCE_ID = defaultInstanceIdForDriver(GROK_DRIVER_KIND);
const DEFAULT_GROK_SETTINGS = Schema.decodeSync(GrokSettings)({});
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export const GrokProviderCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  sessions: {
    ...AcpProviderCapabilitiesV2.sessions,
    supportsModelSwitchInSession: true,
    supportsRuntimeModeSwitchInSession: false,
  },
  threads: {
    ...AcpProviderCapabilitiesV2.threads,
    canReadThreadSnapshot: true,
    canForkThread: false,
    canForkFromTurn: false,
  },
  subagents: {
    ...AcpProviderCapabilitiesV2.subagents,
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
  },
  tools: {
    ...AcpProviderCapabilitiesV2.tools,
    supportsMcpTools: true,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanReadConversationSnapshot: true,
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface GrokAdapterV2Options {
  readonly instanceId: Parameters<typeof makeAcpAdapterV2>[0]["instanceId"];
  readonly settings: GrokSettings;
  readonly environment: NodeJS.ProcessEnv;
  /** Names set on the instance in Settings; a workspace's [env] never replaces them. */
  readonly instanceEnvironmentNames?: ReadonlyArray<string>;
  readonly hostPlatform: NodeJS.Platform;
  readonly selfInvocation: SelfInvocation;
  readonly nativeLogging?: Parameters<typeof makeAcpAdapterV2>[0]["nativeLogging"];
  readonly continuationRequests?: Parameters<typeof makeAcpAdapterV2>[0]["continuationRequests"];
  readonly testHooks?: Parameters<typeof makeAcpAdapterV2>[0]["testHooks"];
  readonly makeRuntime?: (
    input: AcpAdapterV2RuntimeInput,
  ) => Effect.Effect<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    EffectAcpErrors.AcpError,
    ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom | Scope.Scope
  >;
  readonly assertComplete?: Effect.Effect<void, EffectAcpErrors.AcpError>;
}

const registerGrokAcpExtensions: NonNullable<AcpAdapterV2Flavor["registerExtensions"]> = ({
  runtime,
  requestUserInput,
  applyBackgroundTaskMutation,
  finishSubagent,
  captureProposedPlan,
  lastProposedPlanMarkdown,
}) =>
  registerXAiBackgroundTaskTracking(runtime, applyBackgroundTaskMutation).pipe(
    Effect.andThen(registerXAiSubagentFinished(runtime, finishSubagent)),
    Effect.andThen(registerGrokAskUserQuestionExtensions({ runtime, requestUserInput })),
    Effect.andThen(
      registerGrokExitPlanModeExtensions({
        runtime,
        captureProposedPlan,
        lastProposedPlanMarkdown,
      }),
    ),
  );

/**
 * Grok intercepts exit_plan_mode and reverse-requests client approval. Capture
 * the plan into upstream proposed-plan card and abandon the native gate so the turn
 * does not hang (#8358; mirrors the Claude ExitPlanMode pattern).
 */
const registerGrokExitPlanModeExtensions = ({
  runtime,
  captureProposedPlan,
  lastProposedPlanMarkdown,
}: Pick<
  AcpAdapterV2ExtensionContext,
  "runtime" | "captureProposedPlan" | "lastProposedPlanMarkdown"
>) =>
  Effect.forEach(
    ["x.ai/exit_plan_mode", "_x.ai/exit_plan_mode"] as const,
    (method) =>
      runtime.handleExtRequest(method, XAiExitPlanModeRequest, (params) =>
        Effect.gen(function* () {
          const fallback = yield* lastProposedPlanMarkdown;
          yield* captureProposedPlan({
            planMarkdown: extractXAiExitPlanMarkdown(params, fallback),
          });
          return makeXAiExitPlanModeCapturedResponse();
        }),
      ),
    { discard: true },
  );

const registerGrokAskUserQuestionExtensions = ({
  runtime,
  requestUserInput,
}: Pick<AcpAdapterV2ExtensionContext, "runtime" | "requestUserInput">) =>
  Effect.forEach(
    ["x.ai/ask_user_question", "_x.ai/ask_user_question"] as const,
    (method) =>
      runtime.handleExtRequest(method, XAiAskUserQuestionRequest, (params, requestContext) => {
        const identity = extractXAiAskUserQuestionIdentity(params);
        const questions = extractXAiAskUserQuestions(params).map((question) => ({
          ...question,
          options: [...question.options],
        }));
        return requestUserInput(
          {
            nativeItemId: `${identity.sessionId}:xai-question:${identity.toolCallId}`,
            nativeRequestId: identity.toolCallId,
            questions,
          },
          requestContext,
        ).pipe(
          Effect.flatMap(({ acknowledgeNativeResponse, answers }) =>
            Effect.succeed(
              answers === null
                ? makeXAiAskUserQuestionCancelledResponse()
                : makeXAiAskUserQuestionResponse(params, answers),
            ).pipe(Effect.tap(() => acknowledgeNativeResponse)),
          ),
        );
      }),
    { discard: true },
  );

type GrokSelectConfigOption = Extract<
  EffectAcpSchema.SessionConfigOption,
  { readonly type: "select" }
>;

function findGrokReasoningEffortOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): GrokSelectConfigOption | undefined {
  return configOptions.find(
    (option): option is GrokSelectConfigOption =>
      option.category === "thought_level" && option.type === "select",
  );
}

/**
 * Grok's permission mode is fixed at launch. Explicit approval or sandbox
 * overrides launch it asking, so every mutating prompt reaches upstream policy
 * check instead of being bypassed by always-approve or Grok's auto classifier.
 */
export function grokLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
): RuntimeMode {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

/** Grok's own login and home, such as XAI_API_KEY and GROK_HOME. */
const GROK_OWN_ENV = /^(?:GROK|XAI)_/i;

/**
 * Grok runs its own commands, so the workspace's ports and [env] go on its
 * process. As for Antigravity, they never replace what the agent owns: the
 * variables set on the instance in Settings, the host's PATH and the others a
 * process needs to run, and Grok's own login and home. The rest of the host's
 * env sits under them.
 */
function withGrokWorkspaceEnvironment(
  options: Pick<GrokAdapterV2Options, "environment" | "instanceEnvironmentNames">,
  workspaceEnvironment: NodeJS.ProcessEnv | undefined,
): NodeJS.ProcessEnv {
  const agentOwnedNames = new Set(
    [
      ...(options.instanceEnvironmentNames ?? []),
      ...Object.keys(options.environment).filter(isHostProcessEnvName),
    ].map((name) => name.toUpperCase()),
  );
  return {
    ...options.environment,
    ...Object.fromEntries(
      Object.entries(workspaceEnvironment ?? {}).filter(
        ([name]) => !agentOwnedNames.has(name.toUpperCase()) && !GROK_OWN_ENV.test(name),
      ),
    ),
  };
}

export function makeGrokAcpAdapterFlavor(
  options: GrokAdapterV2Options,
  homeDirectory: string,
): AcpAdapterV2Flavor {
  return {
    driver: GROK_PROVIDER,
    runtimeHarness: "Grok",
    capabilities: GrokProviderCapabilitiesV2,
    interruptPromptOnCancel: false,
    // User Stop (requestRuntimeRestart) still hard-kills the process group and
    // respawns so existing background tasks stop too. Non-Stop interrupts
    // (mid-prompt steering, restart_active) omit requestRuntimeRestart and stay
    // soft: session/cancel carries cancelTrigger=ctrl_c, the session survives,
    // and background work remains available to the replacement turn.
    restartRuntimeAfterInterrupt: true,
    terminateRuntimeProcessGroupOnInterrupt: true,
    // Steering restarts on a settled turn additionally skip session/cancel so
    // fire-and-forget subagents survive the steer (E1 harness confirmed the
    // Grok CLI accepts a concurrent session/prompt in that state).
    preserveRuntimeOnSettledInterrupt: true,
    // Grok ACP initialize reports promptCapabilities.image:false but the agent
    // still accepts image content blocks (verified with real screenshots).
    supportsImagePrompts: true,
    supportsCompaction: true,
    // Grok expands only a leading `/name`, while the `$` picker inserts `$name` from the
    // `grok inspect` catalog. Ask that catalog again so other `$` text is left alone.
    rewriteUserText: (text, turnInput) => {
      const mention = leadingGrokSkillMention(text);
      if (mention === undefined) return Effect.succeed(text);
      return discoverGrokSkills(
        options.settings,
        options.environment,
        turnInput.runtimePolicy.cwd ?? undefined,
      ).pipe(
        Effect.map((skills) =>
          skills.some((skill) => skill.enabled && skill.name === mention.name)
            ? `/${mention.name}${mention.rest}`
            : text,
        ),
        Effect.orElseSucceed(() => text),
      );
    },
    resolveModelId: (selection) => resolveGrokAcpBaseModelId(selection.model),
    getModelContextWindow: (selection, session) => {
      if (selection.instanceId !== options.instanceId) return undefined;
      const modelId = resolveGrokAcpBaseModelId(selection.model);
      const models =
        session.sessionSetupResult.models ??
        sessionModelStateFromInitialize(session.initializeResult);
      const window = models?.availableModels.find((model) => model.modelId === modelId)?._meta
        ?.totalContextTokens;
      // contextWindows includes selectable larger windows; totalContextTokens is the default.
      return typeof window === "number" && Number.isSafeInteger(window) && window > 0
        ? window
        : undefined;
    },
    modelSelectionOptionIds: ["reasoningEffort"],
    applyModelSelection: ({ runtime, startResult, modelSelection }) =>
      Effect.gen(function* () {
        const requestedModelId = resolveGrokAcpBaseModelId(modelSelection.model);
        // The catalog offers Grok's effort under this id, while the session's
        // own config option is `reasoning_effort`, so the generic option loop
        // cannot apply it.
        const requestedReasoningEffort = getModelSelectionStringOptionValue(
          modelSelection,
          "reasoningEffort",
        );
        // As in the generic option loop, an effort Grok does not take leaves
        // Grok's own in place instead of failing the session open.
        const effortNotApplied = (model: string | undefined, detail: string) =>
          Effect.logWarning("Grok did not take the requested reasoning effort", {
            sessionId: startResult.sessionId,
            model,
            reasoningEffort: requestedReasoningEffort,
            detail,
          });
        if (startResult.initializeResult.protocolVersion === 1) {
          const setup = startResult.sessionSetupResult;
          const currentModelId = currentGrokModelIdFromSessionSetup(setup);
          // The setup result keeps the effort the session started at; Grok
          // reports every later change through its thought_level option.
          const currentReasoningEffort = findGrokReasoningEffortOption(
            yield* runtime.getConfigOptions,
          )?.currentValue;
          const selectModel = (reasoningEffort: string | undefined) =>
            applyGrokAcpModelSelection({
              runtime,
              currentModelId,
              currentReasoningEffort,
              requestedModelId,
              requestedReasoningEffort: reasoningEffort,
              mapError: (cause) => cause,
            });
          if (requestedReasoningEffort === undefined) {
            return yield* selectModel(undefined);
          }
          // Model and effort share one set_model, so an effort the target model
          // does not take must not cost the model switch.
          const targetModelId =
            requestedModelId === GROK_DEFAULT_MODEL_SLUG ? currentModelId : requestedModelId;
          const targetModel = setup.models?.availableModels.find(
            (model) => model.modelId.trim() === targetModelId,
          );
          if (
            targetModel !== undefined &&
            !grokModelReasoningEfforts(targetModel).includes(requestedReasoningEffort)
          ) {
            yield* effortNotApplied(targetModelId, "The model does not offer it.");
            return yield* selectModel(undefined);
          }
          return yield* selectModel(requestedReasoningEffort).pipe(
            Effect.catchTags({
              AcpRequestError: (error) =>
                selectModel(undefined).pipe(
                  Effect.tap(() => effortNotApplied(targetModelId, error.message)),
                ),
            }),
          );
        }
        const appliedModel = yield* applyGrokAcpModelSelection({
          runtime: { setSessionModel: (model) => runtime.setModel(model).pipe(Effect.as({})) },
          currentModelId: findModelConfigOption(yield* runtime.getConfigOptions)?.currentValue,
          requestedModelId,
          mapError: (cause) => cause,
        });
        // Read after the model write, which answers with the new model's options.
        const effortOption = findGrokReasoningEffortOption(yield* runtime.getConfigOptions);
        if (requestedReasoningEffort === undefined || effortOption === undefined) {
          return appliedModel;
        }
        if (!collectSessionConfigOptionValues(effortOption).includes(requestedReasoningEffort)) {
          yield* effortNotApplied(appliedModel, "The model does not offer it.");
          return appliedModel;
        }
        yield* runtime.setConfigOption(effortOption.id, requestedReasoningEffort).pipe(
          Effect.catchTags({
            AcpRequestError: (error) => effortNotApplied(appliedModel, error.message),
          }),
        );
        return appliedModel;
      }),
    makeRuntime:
      options.makeRuntime ??
      (({ runtimePolicy, processEnvironment, ...input }) =>
        makeGrokAcpRuntime({
          ...input,
          interruptPromptOnCancel: input.interruptPromptOnCancel ?? false,
          grokSettings: options.settings,
          environment: withGrokWorkspaceEnvironment(options, processEnvironment),
          runtimeMode: grokLaunchRuntimeMode(runtimePolicy),
        })),
    // In its Auto mode Grok decides routine actions itself and only asks about
    // what its classifier blocked, so every prompt it sends goes to the user.
    permissionDisposition: (policy, request) =>
      grokLaunchRuntimeMode(policy) === "auto" ? "ask" : acpPermissionDisposition(policy, request),
    approvalOptions: grokApprovalOptions,
    promptFailure: (cause) =>
      makeProviderFailure({
        cause,
        ...(isAcpRequestError(cause)
          ? {
              message:
                cause.cause instanceof XAiPromptFailureText
                  ? cause.cause.message
                  : cause.errorMessage,
              code: String(cause.code),
              class: cause.code === xAiRateLimitedErrorCode ? "usage_limit" : "provider_error",
            }
          : { class: "provider_error" }),
      }),
    registerExtensions: registerGrokAcpExtensions,
    extractSubagentUpdate: extractXAiAcpSubagentUpdate,
    extractSubagentEndNotice: extractXAiAcpSubagentEndNotice,
    normalizeToolCall: normalizeXAiAcpToolCallState,
    extractProposedPlanMarkdown: (toolCall) =>
      extractGrokPlanMarkdownFromToolCallData(toolCall.data, {
        platform: options.hostPlatform,
        environment: options.environment,
        homeDirectory,
      }),
    extractBackgroundTaskId: extractXAiMonitorTaskId,
    isBackgroundCommandTool: (toolCall) => xAiBackgroundShellTaskId(toolCall) !== undefined,
    extractBackgroundToolMutation: extractXAiAcpBackgroundToolMutation,
    extractBackgroundTaskCompletion: (toolCall) => [
      ...extractXAiBackgroundTaskCompletion(toolCall),
      ...extractXAiKilledBackgroundTasks(toolCall),
    ],
    isPersistentBackgroundTool: isXAiPersistentMonitor,
    isProviderWakeNotification: isXAiTaskCompletedWakeNotification,
    deferFinalizeForBackgroundWork: true,
    enablePostSettleContinuation: true,
    ...(options.assertComplete === undefined ? {} : { assertComplete: options.assertComplete }),
  };
}

export const makeGrokAdapterV2 = Effect.fn("makeGrokAdapterV2")(function* (
  options: GrokAdapterV2Options,
) {
  return yield* makeAcpAdapterV2({
    instanceId: options.instanceId,
    flavor: makeGrokAcpAdapterFlavor(options, yield* HostProcess.HomeDirectory),
    selfInvocation: options.selfInvocation,
    ...(options.nativeLogging === undefined ? {} : { nativeLogging: options.nativeLogging }),
    ...(options.continuationRequests === undefined
      ? {}
      : { continuationRequests: options.continuationRequests }),
    ...(options.testHooks === undefined ? {} : { testHooks: options.testHooks }),
  });
});

export type GrokAdapterV2DriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | Path.Path
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost;

export const GrokAdapterV2Driver: ProviderAdapterDriver<GrokSettings, GrokAdapterV2DriverEnv> = {
  driverKind: GROK_DRIVER_KIND,
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => DEFAULT_GROK_SETTINGS,
  create: Effect.fn("GrokAdapterV2Driver.create")(
    function* (input: ProviderAdapterDriverCreateInput<GrokSettings>) {
      const hostEnvironment = yield* HostProcess.Environment;
      const hostPlatform = yield* HostProcess.Platform;
      const selfInvocation = yield* resolveSelfInvocation();
      const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
      const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
      return yield* makeGrokAdapterV2({
        instanceId: input.instanceId,
        settings: { ...input.config, enabled: input.enabled },
        environment: withoutRuntimeEnv(
          yield* mergeProviderInstanceEnvironment(input.environment, hostEnvironment),
        ),
        instanceEnvironmentNames: input.environment.map((variable) => variable.name),
        hostPlatform,
        selfInvocation,
        continuationRequests,
        nativeLogging: (threadId) =>
          makeNativeLogger({
            nativeEventLogger: providerEventLoggers.native,
            provider: GROK_PROVIDER,
            threadId,
          }),
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapterDriverCreateError({
              driver: GROK_DRIVER_KIND,
              instanceId: input.instanceId,
              detail: "Failed to create Grok ACP adapter.",
              cause,
            }),
        ),
      ),
  ),
};

const layer: Layer.Layer<
  ProviderAdapter.ProviderAdapterV2,
  never,
  | Path.Path
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers
  | ProviderHost.ProviderHost
> = Layer.effect(
  ProviderAdapter.ProviderAdapterV2,
  Effect.gen(function* () {
    const hostEnvironment = yield* HostProcess.Environment;
    const hostPlatform = yield* HostProcess.Platform;
    const selfInvocation = yield* resolveSelfInvocation();
    const providerEventLoggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const continuationRequests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    const makeNativeLogger = yield* makeAcpNativeLoggerFactory();
    return yield* makeGrokAdapterV2({
      instanceId: GROK_DEFAULT_INSTANCE_ID,
      settings: DEFAULT_GROK_SETTINGS,
      environment: withoutRuntimeEnv(hostEnvironment),
      hostPlatform,
      selfInvocation,
      continuationRequests,
      nativeLogging: (threadId) =>
        makeNativeLogger({
          nativeEventLogger: providerEventLoggers.native,
          provider: GROK_PROVIDER,
          threadId,
        }),
    });
  }),
);
