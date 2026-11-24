// ), packages/provider-pi/src/server/driver.ts @ ab3a3cd1 (adapted for the in-process Caveman engine).
/**
 * CavemanDriver — the `ProviderDriver` for the Caveman engine: the in-process
 * adapter, a snapshot built from the stored keys and the engine's model
 * catalog (no binary, no version probe: the engine ships inside the app), and
 * text generation as one harness turn (sideText.ts).
 *
 * @module provider-caveman/server/driver
 */
import {
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@caveman-app/protocol";
import * as EgressRoute from "@caveman-app/engine-core/server/EgressRoute";
import * as ProviderHost from "@caveman-app/engine-core/server/ProviderHost";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import { ProviderDriverError } from "@caveman-app/engine-core/server/errors";
import { makeManagedServerProvider } from "@caveman-app/engine-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@caveman-app/engine-core/server/maintenanceResolver";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@caveman-app/engine-core/server/driver";
import { buildServerProvider, providerModelsFromSettings, type ServerProviderDraft } from "@caveman-app/engine-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@caveman-app/engine-core/server/snapshotSettings";
import * as TextGenerationOperations from "@caveman-app/engine-core/server/textGenerationOperations";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { CavemanSettings } from "../settings.ts";
import {
  CAVEMAN_AUTO_MODEL,
  CAVEMAN_GATEWAY_URL,
  CAVEMAN_PROVIDER,
  CavemanAdapterV2Driver,
  cavemanModelRefusal,
  modelsThroughScrub,
  resolveCavemanModel,
} from "./adapter.ts";
import { cavemanModels, readCavemanKeys, storedSignIns, type CavemanKeys } from "./credentials.ts";
import { accountSlug, CHATGPT_PLAN_PROVIDER, CREDITS_PROVIDER, loadCreditsModels } from "./credits.ts";
import { defaultEffort, effortIds } from "./engineConfig.ts";
import { investigationTools } from "./investigation.ts";
import { harnessSideTurn, sideCallModel, streamThrough, type SideCallEngine } from "./sideText.ts";

import type { Api, Model } from "@earendil-works/pi-ai";
import { loadModelsDevCache, refreshModelsDev } from "@caveman-app/engine-core/server/modelsDev";
import { currentModels, FEATURED_PROVIDERS, inListedOrder, listPriceUsd, providerInfo, providerOrder, signInOf } from "./providers.ts";

const DRIVER_KIND = CAVEMAN_PROVIDER;
const decodeSettings = Schema.decodeSync(CavemanSettings);

const PRESENTATION = {
  displayName: "Caveman",
  showInteractionModeToggle: false,
  // The engine's tool policy asks with Claude Agent's approval cards (approvals.ts).
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: true,
} as const;

const AUTO_MODEL: ServerProviderModel = {
  slug: CAVEMAN_AUTO_MODEL,
  name: "Auto",
  isCustom: false,
  isDefault: true,
  capabilities: null,
};

/** Auto's line in the picker: what it does on this computer (autoRouter.ts). */
const autoModel = (): ServerProviderModel => ({
  ...AUTO_MODEL,
  description: "Caveman Cloud picks the model and effort among everything you connected",
});

/** The composer's effort control for a reasoning model: the catalog's levels, what an untouched turn runs at marked (defaultEffort). */
export const effortCapabilities = (model: Model<Api>): ServerProviderModel["capabilities"] => {
  const level = defaultEffort(model);
  if (level === undefined) return null;
  const ids = effortIds(model);
  const current = level === "off" ? "none" : level;
  return {
    optionDescriptors: [
      {
        id: "effort",
        label: "Effort",
        type: "select",
        options: ids.map((id) => ({ id, label: effortLabel(id), ...(id === current ? { isDefault: true } : {}) })),
        currentValue: current,
      },
    ],
  };
};

const EFFORT_LABELS: Readonly<Record<string, string>> = { none: "None", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const effortLabel = (id: string) => EFFORT_LABELS[id] ?? id;

/** The providers that have a stored key, in Models & keys order. */
export const keyedProviders = (keys: CavemanKeys) => Object.keys(keys).sort((a, b) => providerOrder(a) - providerOrder(b) || a.localeCompare(b));

/**
 * Auto, then each keyed provider's catalog: its current models first (each
 * family's newest, providers.ts), then the rest marked legacy, which the
 * picker keeps under "More models" and search still finds. Endpoints,
 * Caveman credits and a plan list everything they have.
 */
export const cavemanModelList = (keys: CavemanKeys, settings: CavemanSettings, routing = false) =>
  Effect.map(cavemanModels(keys), (models): ReadonlyArray<ServerProviderModel> => {
    const listed: Array<ServerProviderModel> = routing ? [autoModel()] : [];
    for (const provider of keyedProviders(keys)) {
      const catalog = models.getModels(provider);
      const current = currentModels(provider, catalog);
      for (const model of inListedOrder(provider, catalog)) {
        listed.push({
          slug: provider === CREDITS_PROVIDER || provider === CHATGPT_PLAN_PROVIDER ? accountSlug(provider, model) : `${provider}/${model.id}`,
          name: model.name || model.id,
          subProvider: provider,
          isCustom: false,
          ...(current !== undefined && !current.includes(model) ? { isLegacy: true } : {}),
          capabilities: effortCapabilities(model),
        });
      }
    }
    const defaultModel = resolveCavemanModel("default", keys);
    return providerModelsFromSettings(listed.map((model) => !routing && model.slug === defaultModel ? { ...model, isDefault: true } : model), settings.customModels.filter((model) => (typeof model === "string" ? model : model.slug) !== "auto" || routing), null);
  });

export const checkCavemanStatus = Effect.fn("checkCavemanStatus")(function* (
  instanceId: ProviderInstance["instanceId"],
  settings: CavemanSettings,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const host = yield* ProviderHost.ProviderHost;
  // models.dev (engine-core modelsDev.ts): the copy on disk now, a fetch every 15 minutes in the background, shown at
  // the next check.
  yield* Effect.promise(() => loadModelsDevCache(host.paths.stateDir));
  // What credits sell, as Cloud last said (credits.ts; the runtime reads Cloud hourly).
  yield* Effect.promise(() => loadCreditsModels(host.paths.stateDir));
  const updateChecks = yield* host.settings.get.pipe(
    Effect.map((s) => s.enableProviderUpdateChecks),
    Effect.orElseSucceed(() => false),
  );
  yield* Effect.forkDetach(
    Effect.promise(() =>
      refreshModelsDev({ stateDir: host.paths.stateDir, allowNetwork: updateChecks }),
    ),
  );
  // A model list is a probe: where the routing credential is minted on demand (a Cloud computer's credits key) it asks
  // Cloud nothing (`offered`); elsewhere the credential held says.
  const routing = yield* Effect.promise(async () => (host.routing?.offered !== undefined ? await host.routing.offered() : (await host.routing?.get()) !== undefined));
  const stored = yield* readCavemanKeys(instanceId).pipe(Effect.option);
  if (stored._tag === "None") {
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: [],
      probe: { installed: true, version: null, status: "error", auth: { status: "unknown" }, message: "Could not read the Caveman engine's API keys." },
    });
  }
  const keys = stored.value;
  const providers = keyedProviders(keys);
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: yield* cavemanModelList(keys, settings, routing),
    probe: {
      installed: true,
      version: null,
      status: providers.length === 0 ? "warning" : "ready",
      auth:
        providers.length === 0
          ? { status: "unauthenticated" }
          : {
              status: "authenticated",
              type: "api_key",
              label: providers.map((p) => (keys[p]?.oauth !== undefined ? `${signInOf(p)?.plan ?? providerInfo(p)?.label ?? p} plan` : (providerInfo(p)?.label ?? p))).join(", "),
            },
      ...(providers.length === 0
        ? { message: "Add a key or a sign-in in Settings > Models & keys to use the Caveman engine." }
        : {}),
    },
  });
});

/** What every text run is told: the prompt says what to answer, and the answer is only its JSON. */
const TEXT_INSTRUCTIONS = "Answer with exactly the JSON the user asks for.";

/**
 * Commit messages, PR text, branch names and titles: one harness turn with no tools (sideText.ts). A review guide that
 * reads its checkout gets the read-only investigation tools (investigation.ts) and as many requests as it needs,
 * inside the request's time limit.
 */
export const makeCavemanTextGeneration = Effect.fn("makeCavemanTextGeneration")(function* (
  instanceId: ProviderInstance["instanceId"],
  /** Test seam: a scripted model. Production passes nothing. */
  engine: SideCallEngine = {},
) {
  const context = yield* Effect.context<ProviderHost.ProviderHost>();
  // Optional: a host without the egress scrub keeps no secrets.
  const egress = yield* Effect.serviceOption(EgressRoute.EgressRoute);
  const runJson: TextGenerationOperations.Runner = (request) =>
    Effect.gen(function* () {
      const failed = (detail: string, cause?: unknown) => new TextGenerationError({ operation: request.operation, detail, ...(cause === undefined ? {} : { cause }) });
      const keys = yield* readCavemanKeys(instanceId).pipe(Effect.mapError((cause) => failed("Could not read the Caveman engine's API keys.", cause)));
      const model = resolveCavemanModel(request.modelSelection.model, keys);
      if (model === null) return yield* failed(cavemanModelRefusal(request.modelSelection.model));
      // A staged diff, or a file a review guide reads, goes to the model: through the egress scrub, as side text does.
      if (Option.isSome(egress) && egress.value.route(CAVEMAN_GATEWAY_URL) === undefined) {
        const blocked = yield* egress.value.hasSecrets(request.cwd).pipe(Effect.orElseSucceed(() => true));
        if (blocked) return yield* failed("This project has secrets, and the Caveman engine cannot run without the egress scrub that keeps them from the model.");
      }
      const signedIn = yield* cavemanModels(keys, yield* storedSignIns(instanceId));
      const models = Option.isSome(egress) ? modelsThroughScrub(signedIn, egress.value.route) : signedIn;
      const harnessModel = sideCallModel(engine, models, model);
      if (harnessModel === undefined) return yield* failed(`The Caveman engine has no model ${model}.`);
      const investigate = request.investigate;
      const generated = Effect.tryPromise({
        try: (signal) =>
          harnessSideTurn({
            model: harnessModel,
            stream: engine.streamFn ?? streamThrough(models),
            instructions: TEXT_INSTRUCTIONS,
            prompt: request.prompt,
            cwd: request.cwd,
            // The tools run in this process, on the checkout, and only read (investigation.ts).
            tools: investigate === undefined ? [] : investigationTools(request.cwd),
            signal,
          }),
        catch: (cause) => failed("Caveman text generation failed.", cause),
      });
      const outcome =
        investigate === undefined
          ? yield* generated
          : yield* generated.pipe(
              Effect.timeoutOrElse({
                duration: investigate.timeoutMs,
                orElse: () => Effect.fail(failed("The Caveman engine ran out of time reading the change.")),
              }),
            );
      if (outcome.status === "error") return yield* failed("Caveman text generation failed.", new Error(outcome.error ?? outcome.stopReason));
      const { usage } = outcome;
      if (request.onUsage !== undefined && usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0) {
        const costUsd = usage.costUsd ?? listPriceUsd(model, { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite });
        request.onUsage({
          inputTokens: usage.input,
          outputTokens: usage.output,
          cacheReadTokens: usage.cacheRead,
          cacheWriteTokens: usage.cacheWrite,
          ...(costUsd === undefined ? {} : { costUsd }),
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Caveman", outcome.finalText);
    }).pipe(Effect.provide(context));
  return TextGenerationOperations.fromRunner("CavemanTextGeneration", runJson);
});

export type CavemanDriverEnv = FileSystem.FileSystem | IdAllocator.IdAllocatorV2 | Path.Path | ProviderHost.ProviderHost;

export const CavemanDriver: ProviderDriver<CavemanSettings, CavemanDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "Caveman", supportsMultipleInstances: true },
  configSchema: CavemanSettings,
  defaultConfig: (): CavemanSettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const effectiveConfig = { ...config, enabled } satisfies CavemanSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({ driverKind: DRIVER_KIND, instanceId });
      const stamp = (snapshot: ServerProviderDraft): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const orchestrationAdapter = yield* CavemanAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      });
      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const host = yield* ProviderHost.ProviderHost;
      const checkProvider = checkCavemanStatus(instanceId, effectiveConfig).pipe(
        Effect.map(stamp),
        Effect.provideService(ProviderHost.ProviderHost, host),
      );
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () =>
          Effect.succeed(makeManualOnlyProviderMaintenanceCapabilities({ provider: DRIVER_KIND, packageName: null })),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: () => checkProvider,
        checkProvider,
      });
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: yield* makeCavemanTextGeneration(instanceId),
      } satisfies ProviderInstance;
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({ driver: DRIVER_KIND, instanceId, detail: "Failed to build the Caveman engine instance.", cause }),
      ),
    ),
};
