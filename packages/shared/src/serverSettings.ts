// ), packages/shared/src/serverSettings.ts @ ab3a3cd1.
import type { ModelPreferences } from "@caveman-app/protocol/settings";
import {
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_TEXT_GENERATION_MODEL,
  DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  defaultInstanceIdForDriver,
  isProviderAvailable,
  isUnconfiguredDefaultInstanceEnabled,
  resolveProjectProviderInstanceEnabled,
  resolveProviderInstanceEnabled,
  isProviderTextGenerationCapable,
  type ModelSelection,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  ProjectSettingsOverrides,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ServerSettings,
  type ServerSettingsPatch,
} from "@caveman-app/protocol";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deepMerge } from "./Struct.ts";
import { fromLenientJson } from "./schemaJson.ts";
import { createModelSelection, readCustomModelEntries } from "./model.ts";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveBackgroundActivitySettings,
} from "./backgroundActivitySettings.ts";

// Only observability: a value the server migrates on load elsewhere in the file must not drop it.
const ServerObservabilitySettingsJson = fromLenientJson(
  Schema.Struct({ observability: ServerSettings.fields.observability }),
);
const decodeServerObservabilitySettingsJson = Schema.decodeUnknownOption(
  ServerObservabilitySettingsJson,
);

/** @deprecated Read `resolveProjectSettings(...).settings.enableAgentBrowserAccess`. */
export function resolveProjectAgentBrowserAccess(
  settings: Pick<
    ServerSettings,
    "enableAgentBrowserAccess" | "projectAgentBrowserAccessOverrides" | "projectSettingsOverrides"
  >,
  projectId: ProjectId,
): boolean {
  return (
    settings.projectSettingsOverrides[projectId]?.enableAgentBrowserAccess ??
    settings.projectAgentBrowserAccessOverrides[projectId] ??
    settings.enableAgentBrowserAccess
  );
}

/** @deprecated Read `resolveProjectSettings(...).settings.defaultAutoPull`. */
export function resolveProjectAutoPull(
  settings: Pick<
    ServerSettings,
    "defaultAutoPull" | "projectAutoPullOverrides" | "projectSettingsOverrides"
  >,
  projectId: ProjectId,
  legacyAutoPull: boolean | undefined,
): boolean {
  // Existing opt-ins stay enabled until explicitly overridden or reset.
  return (
    settings.projectSettingsOverrides[projectId]?.defaultAutoPull ??
    settings.projectAutoPullOverrides[projectId] ??
    (legacyAutoPull === true || settings.defaultAutoPull)
  );
}

export function isModelSelectionProviderEnabled(
  settings: ServerSettings,
  selection: ModelSelection,
): boolean {
  const instanceConfig = settings.providerInstances[selection.instanceId];
  if (instanceConfig !== undefined) {
    return resolveProviderInstanceEnabled(instanceConfig);
  }

  return isUnconfiguredDefaultInstanceEnabled(selection.instanceId);
}

const TEXT_GENERATION_FALLBACK_DRIVERS = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "muse",
  "pi",
  "opencode",
  "antigravity",
].map((driver) => ProviderDriverKind.make(driver));

/**
 * The text generation model on the first instance `isEnabled` accepts: the
 * built-in default instances in preference order, then, when
 * `includeConfiguredInstances` is set, configured instances of those
 * drivers. `null` when none is.
 *
 * The model is the driver's cheap default, unless `defaultModelSelection`
 * (the thread default) is one of that instance's custom models. A custom
 * model usually means a backend that may refuse the built-in default, and
 * the thread default, with its options, is known to work there.
 *
 * `includeConfiguredInstances` is for the project-scoped caller only: a
 * project that disabled every built-in instance should still be able to
 * fall back to one it configured itself. The machine-level caller leaves it
 * unset, since widening the candidates there would change behavior for
 * every user regardless of project scope.
 */
export function fallbackTextGenerationModelSelection(
  providerInstances: ServerSettings["providerInstances"],
  isEnabled: (instanceId: ProviderInstanceId, driver: ProviderDriverKind) => boolean,
  options?: {
    readonly includeConfiguredInstances?: boolean;
    readonly defaultModelSelection?: ModelSelection | null;
  },
): ModelSelection | null {
  const candidates = [
    ...TEXT_GENERATION_FALLBACK_DRIVERS.map(
      (driver) => [defaultInstanceIdForDriver(driver), driver] as const,
    ),
    ...(options?.includeConfiguredInstances === true
      ? Object.entries(providerInstances).flatMap(([instanceId, instance]) =>
          TEXT_GENERATION_FALLBACK_DRIVERS.includes(instance.driver)
            ? [[ProviderInstanceId.make(instanceId), instance.driver] as const]
            : [],
        )
      : []),
  ];
  const match = candidates.find(([instanceId, driver]) => isEnabled(instanceId, driver));
  if (match === undefined) return null;
  const [instanceId, driver] = match;
  const threadDefault = options?.defaultModelSelection;
  const config = providerInstances[instanceId]?.config as { customModels?: unknown } | undefined;
  if (
    threadDefault?.instanceId === instanceId &&
    readCustomModelEntries(config?.customModels).some((entry) => entry.slug === threadDefault.model)
  ) {
    return threadDefault;
  }
  return {
    instanceId,
    model:
      DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_MODEL_BY_PROVIDER[driver] ??
      DEFAULT_TEXT_GENERATION_MODEL,
  };
}

/**
 * `projectId` has no default: a caller that forgets it would otherwise fall
 * back to the machine's own writer choice, silently ignoring a project that
 * turned the writer's instance off. Pass `null` explicitly outside a
 * project's scope.
 */
export function resolveSourceControlWriterModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  const selection = settings.sourceControlWriterModelSelection;
  const textWriter = () => textGenerationWriters(settings, providers, projectId)[0]!;
  if (
    !selection ||
    !resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    return textWriter();
  }
  if (providers === undefined) {
    return selection;
  }

  const provider = providers.find((candidate) => candidate.instanceId === selection.instanceId);
  return provider !== undefined && chosenTextProviderRuns(settings, provider, projectId)
    ? selection
    : textWriter();
}

/** Auth types that spend the person's own money per call rather than a plan they already pay for. */
const API_KEY_AUTH_TYPES = new Set([
  "apikey",
  "api-key",
  "api_key",
  "gemini-api-key",
  "agent-platform",
  "amazonbedrock",
  "bedrock",
  "vertex",
]);

/**
 * The Caveman engine's key slots a plan pays for, as its models name them in `subProvider`: Caveman
 * credits and a compact plan linked through Caveman Cloud (provider-caveman credits.ts
 * CREDITS_PROVIDER, CHATGPT_PLAN_PROVIDER). Every other slot is the person's own key.
 */
export const CAVEMAN_PLAN_SLOTS: ReadonlySet<string> = new Set(["caveman", "chatgpt"]);

/**
 * Who should write a review guide first: 0 a subscription (Claude Max/Pro, a compact plan, a
 * Cursor or Grok account, a Google login, Caveman credits), 1 a login whose kind the harness does
 * not report, 2 an API key. The Caveman engine decides per model: a credits or plan model is 0,
 * a model on the person's own key 2.
 */
export function reviewGuideWriterRank(provider: ServerProvider, model?: string): number {
  if (provider.driver === "caveman") {
    const slot = provider.models.find((candidate) => candidate.slug === model)?.subProvider;
    return slot !== undefined && CAVEMAN_PLAN_SLOTS.has(slot) ? 0 : 2;
  }
  const type = provider.auth.type?.toLowerCase();
  if (type === undefined) return 1;
  return API_KEY_AUTH_TYPES.has(type) ? 2 : 0;
}

/**
 * The models a review guide is written on: good enough for a tour of a change, far cheaper than a
 * frontier model, one family or more on every harness. `price` is the list price, input plus output
 * in USD per million tokens (pi-ai's catalog, 2026-10-22), which orders them; a harness's own model
 * the catalog does not price carries an estimate. A harness listing none of these writes no guide
 * on its own; nano, lite and mini models are left out as too weak for one.
 */
const REVIEW_GUIDE_MODELS: ReadonlyArray<{ readonly family: string; readonly match: RegExp; readonly price: number }> = [
  // Claude Agent, Cursor, Pi, OpenCode, the Caveman engine: $0.10 / $0.50.
  { family: "Claude Haiku", match: /haiku/i, price: 0.6 },
  // Codex, Cursor, the Caveman engine: $0.10 / $0.50.
  { family: "GPT Luna", match: /luna/i, price: 0.6 },
  // Cursor (glm-5p3-flash), OpenCode, the Caveman engine: $0.15 / $0.50.
  { family: "GLM Flash", match: /glm.*flash/i, price: 0.65 },
  // OpenCode, Pi, the Caveman engine: $0.30 / $1.20.
  { family: "DeepSeek Flash", match: /deepseek.*flash/i, price: 1.5 },
  // Grok's fast models; xAI lists grok-code-fast at $0.20 / $1.50.
  { family: "Grok fast", match: /^grok.*fast/i, price: 1.7 },
 // native own Composer, on a Cursor plan; an estimate.
  { family: "Composer", match: /^composer/i, price: 3 },
  // Antigravity, Cursor, Pi, OpenCode: Gemini 3.x Flash at $0.75 / $3.75. Not lite, image or live.
  { family: "Gemini Flash", match: /gemini.*flash(?!.*(lite|image|live|computer))/i, price: 4.5 },
  // Muse Code's fast model, on a Muse plan; an estimate.
  { family: "Muse Spark", match: /muse-spark/i, price: 5 },
];

/** The guide model `slug` is, by its name after any `provider/` prefix; undefined for any other. */
const reviewGuideModel = (slug: string) =>
  REVIEW_GUIDE_MODELS.find((model) => model.match.test(slug.slice(slug.lastIndexOf("/") + 1)));

/** How full the fullest reported plan window is, 0 when the harness reports none. */
export const planUsedPercent = (provider: ServerProvider) =>
  Math.max(0, ...(provider.usageLimits?.windows ?? []).map((window) => window.usedPercent));

const runnableTextProvider = (
  settings: ServerSettings,
  provider: ServerProvider,
  projectId: ProjectId | null,
) =>
  provider.enabled &&
  provider.installed &&
  provider.auth.status !== "unauthenticated" &&
  isProviderAvailable(provider) &&
  isProviderTextGenerationCapable(provider) &&
  resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId);

/**
 * Whether a model the person chose can run on `provider`: as `runnableTextProvider`, except that a provider whose first
 * probe has not finished (`probePending`) keeps the choice, its installed and auth fields being placeholders yet.
 */
const chosenTextProviderRuns = (
  settings: ServerSettings,
  provider: ServerProvider,
  projectId: ProjectId | null,
) =>
  provider.probePending === true
    ? provider.enabled &&
      isProviderAvailable(provider) &&
      isProviderTextGenerationCapable(provider) &&
      resolveProjectProviderInstanceEnabled(settings, projectId, provider.instanceId)
    : runnableTextProvider(settings, provider, projectId);

/**
 * The guide models a harness can run, one per kind of billing: the cheapest it lists; within a
 * family curated before "More models", a low-effort variant first (Antigravity names its efforts),
 * then newest first as harnesses list them. The Caveman engine gives one on a plan (credits) and one
 * on the person's keys; the ranking puts the plan first. A harness that has not listed its models
 * yet is taken at its built-in cheap text model when that is a guide model.
 */
function reviewGuideModels(provider: ServerProvider): ReadonlyArray<string> {
  const builtIn = DEFAULT_TEXT_GENERATION_MODEL_BY_PROVIDER[provider.driver];
  const listed =
    provider.models.length > 0
      ? [...provider.models].sort(
          (a, b) =>
            Number(a.isLegacy === true) - Number(b.isLegacy === true) ||
            Number(!/-low$/i.test(a.slug)) - Number(!/-low$/i.test(b.slug)),
        )
      : builtIn === undefined
        ? []
        : [{ slug: builtIn, subProvider: undefined }];
  // Cheapest family first; the sort is stable, so within one the order above holds.
  const cheapest = (models: ReadonlyArray<{ readonly slug: string }>) =>
    models
      .flatMap((model) => {
        const guide = reviewGuideModel(model.slug);
        return guide === undefined ? [] : [{ slug: model.slug, price: guide.price, family: REVIEW_GUIDE_MODELS.indexOf(guide) }];
      })
      .sort((a, b) => a.price - b.price || a.family - b.family)[0]?.slug;
  if (provider.driver !== "caveman") return [cheapest(listed)].filter((slug) => slug !== undefined);
  const onPlan = (model: { readonly subProvider?: string | undefined }) =>
    model.subProvider !== undefined && CAVEMAN_PLAN_SLOTS.has(model.subProvider);
  return [cheapest(listed.filter(onPlan)), cheapest(listed.filter((model) => !onPlan(model)))].filter(
    (slug) => slug !== undefined,
  );
}

/** A guide model as a selection; Claude runs Haiku at medium effort unless told, and a guide wants it cheap. */
const reviewGuideSelection = (provider: ServerProvider, model: string): ModelSelection =>
  provider.driver === "claudeAgent" && /haiku/i.test(model)
    ? { instanceId: provider.instanceId, model, options: [{ id: "effort", value: "low" }] }
    : { instanceId: provider.instanceId, model };

/**
 * Every guide model the harnesses here can run, best first: a subscription before an API key
 * (Caveman credits count as a subscription, the person's own keys as keys); within a rank the
 * cheapest by list price (`REVIEW_GUIDE_MODELS`), then the plan with the most room left, then the
 * text generation preference order. Never a frontier model; empty when nothing here has a cheap one.
 */
export function rankReviewGuideWriters(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider>,
  projectId: ProjectId | null,
): ReadonlyArray<ModelSelection> {
  const order = (driver: ProviderDriverKind) => {
    const index = TEXT_GENERATION_FALLBACK_DRIVERS.indexOf(driver);
    return index < 0 ? TEXT_GENERATION_FALLBACK_DRIVERS.length : index;
  };
  return providers
    .filter((provider) => runnableTextProvider(settings, provider, projectId))
    .flatMap((provider) =>
      reviewGuideModels(provider).map((model) => ({
        selection: reviewGuideSelection(provider, model),
        rank: reviewGuideWriterRank(provider, model),
        price: reviewGuideModel(model)?.price ?? Number.POSITIVE_INFINITY,
        used: planUsedPercent(provider),
        order: order(provider.driver),
      })),
    )
    .sort((a, b) => a.rank - b.rank || a.price - b.price || a.used - b.used || a.order - b.order)
    .map(({ selection }) => selection);
}

/**
 * Who writes a chat's title (and commit text with no writer of its own), in the order to try them: the text generation
 * model set in Settings while its provider can run it, then the PR guide's cheap writers (`rankReviewGuideWriters`), a
 * subscription before a key. A default instance that holds no login (an API-key Codex account beside the person's
 * compact one) is passed over instead of failing every title. Never empty: with nothing able, the Settings model, so
 * the failure names what the person chose.
 */
export function textGenerationWriters(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ReadonlyArray<ModelSelection> {
  const chosen = settings.textGenerationModelSelection;
  if (providers === undefined) return [chosen];
  const provider = providers.find((candidate) => candidate.instanceId === chosen.instanceId);
  const chosenRuns = provider !== undefined && chosenTextProviderRuns(settings, provider, projectId);
  const ranked = rankReviewGuideWriters(settings, providers, projectId).filter(
    (writer) => !(writer.instanceId === chosen.instanceId && writer.model === chosen.model),
  );
  if (chosenRuns) return [chosen, ...ranked];
  return ranked.length > 0 ? ranked : [chosen];
}

/**
 * Who writes a guide nobody asked for (one started when a chat links its pull request, or a
 * prewarm): the guide model set in Settings while its provider can run it, else the cheap writers
 * (`rankReviewGuideWriters`). Empty when neither: such a guide is left for a person to ask for.
 */
export function automaticReviewGuideWriters(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ReadonlyArray<ModelSelection> {
  const selection = settings.reviewGuideModelSelection;
  if (
    selection &&
    resolveProjectProviderInstanceEnabled(settings, projectId, selection.instanceId)
  ) {
    const provider = providers?.find((candidate) => candidate.instanceId === selection.instanceId);
    if (
      providers === undefined ||
      (provider?.enabled === true &&
        isProviderAvailable(provider) &&
        isProviderTextGenerationCapable(provider))
    ) {
      return [selection];
    }
  }
  return providers === undefined ? [] : rankReviewGuideWriters(settings, providers, projectId);
}

/**
 * Who writes a guide a person asked for, in the order to try them: the automatic writers
 * (`automaticReviewGuideWriters`), and a run that fails falls to the next. With none, the source
 * control writer, so the person still gets a guide, or a failure naming a model they chose.
 */
export function reviewGuideWriters(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ReadonlyArray<ModelSelection> {
  const writers = automaticReviewGuideWriters(settings, providers, projectId);
  return writers.length > 0
    ? writers
    : [resolveSourceControlWriterModelSelection(settings, providers, projectId)];
}

/** The first of `reviewGuideWriters`: who writes the next guide. */
export function resolveReviewGuideModelSelection(
  settings: ServerSettings,
  providers: ReadonlyArray<ServerProvider> | undefined,
  projectId: ProjectId | null,
): ModelSelection {
  return reviewGuideWriters(settings, providers, projectId)[0]!;
}

export interface PersistedServerObservabilitySettings {
  readonly otlpTracesUrl: string | undefined;
  readonly otlpMetricsUrl: string | undefined;
  readonly otlpLogsUrl: string | undefined;
}

function normalizePersistedServerSettingString(
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function extractPersistedServerObservabilitySettings(input: {
  readonly observability?: {
    readonly otlpTracesUrl?: string;
    readonly otlpMetricsUrl?: string;
    readonly otlpLogsUrl?: string;
  };
}): PersistedServerObservabilitySettings {
  return {
    otlpTracesUrl: normalizePersistedServerSettingString(input.observability?.otlpTracesUrl),
    otlpMetricsUrl: normalizePersistedServerSettingString(input.observability?.otlpMetricsUrl),
    otlpLogsUrl: normalizePersistedServerSettingString(input.observability?.otlpLogsUrl),
  };
}

export function parsePersistedServerObservabilitySettings(
  raw: string,
): PersistedServerObservabilitySettings {
  const decoded = decodeServerObservabilitySettingsJson(raw);
  if (Option.isSome(decoded)) {
    return extractPersistedServerObservabilitySettings(decoded.value);
  }
  return { otlpTracesUrl: undefined, otlpMetricsUrl: undefined, otlpLogsUrl: undefined };
}

function shouldReplaceTextGenerationModelSelection(
  patch: ServerSettingsPatch["textGenerationModelSelection"] | undefined,
): boolean {
  return Boolean(patch && (patch.instanceId !== undefined || patch.model !== undefined));
}

function mergeModelSelectionOptionsById(input: {
  current: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
  patch: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }> | undefined;
}): Array<{ id: string; value: string | boolean }> | undefined {
  if (input.patch === undefined) {
    return input.current ? [...input.current] : undefined;
  }
  if (input.patch.length === 0) {
    return undefined;
  }

  const merged = new Map((input.current ?? []).map((selection) => [selection.id, selection.value]));
  for (const selection of input.patch) {
    merged.set(selection.id, selection.value);
  }
  return [...merged.entries()].map(([id, value]) => ({ id, value }));
}

/** Upsert each patched entry; `null` removes it. Entries the patch omits are untouched. */
function mergeSettingsEntries<Value>(
  current: Readonly<Record<string, Value>>,
  patch: Readonly<Record<string, Value | null>>,
): Record<string, Value> {
  const next = new Map(Object.entries(current));
  for (const [id, config] of Object.entries(patch)) {
    if (config === null) {
      next.delete(id);
    } else {
      next.set(id, config);
    }
  }
  return Object.fromEntries(next);
}

const knownProjectOverrideKeys = new Set(Object.keys(ProjectSettingsOverrides.fields));

/** The keys of an override entry this build knows (`known`), or the ones it does not. */
function pickOverrideKeys(entry: ProjectSettingsOverrides | undefined, known: boolean) {
  return Object.fromEntries(
    Object.entries<unknown>(entry ?? {}).filter(
      ([key]) => knownProjectOverrideKeys.has(key) === known,
    ),
  );
}

/**
 * `projectSettingsOverrides` entries otherwise replace whole (see the field's
 * doc comment in contracts), but `providerInstances` was added after clients
 * already round-trip a project's entry on every edit. A client built before
 * that addition sends an entry that never mentions the key, and a whole
 * replace would silently wipe it. When an incoming entry omits the key, keep
 * what is stored; a client that means to clear every provider override for
 * the project says so explicitly with `providerInstances: {}`.
 */
function mergeProjectSettingsOverridesPatch(
  current: Readonly<Record<string, ProjectSettingsOverrides>>,
  patch: Readonly<Record<string, ProjectSettingsOverrides | null>>,
): Record<string, ProjectSettingsOverrides> {
  const next = new Map(Object.entries(current));
  for (const [projectId, entry] of Object.entries(patch)) {
    if (entry === null) {
      next.delete(projectId);
      continue;
    }
    const storedProviderInstances = current[projectId]?.providerInstances;
    next.set(projectId, {
      // Preserve downgraded storage, but reject new unknown writes so clients can detect unsupported settings.
      ...pickOverrideKeys(current[projectId], false),
      ...pickOverrideKeys(entry, true),
      ...(Object.hasOwn(entry, "providerInstances") || storedProviderInstances === undefined
        ? {}
        : { providerInstances: storedProviderInstances }),
    });
  }
  return Object.fromEntries(next);
}

/**
 * Derived views of `projectSettingsOverrides` for clients that still read
 * the legacy per-key maps. Recomputed on every patch and load so they
 * cannot drift from the generic record.
 */
export function deriveLegacyProjectOverrides(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
): Pick<
  ServerSettings,
  "projectAgentBrowserAccessOverrides" | "projectAutoPullOverrides" | "projectScriptOverrides"
> {
  const projectAgentBrowserAccessOverrides: Record<string, boolean> = {};
  const projectAutoPullOverrides: Record<string, boolean> = {};
  const projectScriptOverrides: Record<string, ServerSettings["defaultProjectScripts"] | null> = {};
  for (const [projectId, entry] of Object.entries(settings.projectSettingsOverrides)) {
    if (entry.enableAgentBrowserAccess !== undefined) {
      projectAgentBrowserAccessOverrides[projectId] = entry.enableAgentBrowserAccess;
    }
    if (entry.defaultAutoPull !== undefined) {
      projectAutoPullOverrides[projectId] = entry.defaultAutoPull;
    }
    if (entry.defaultProjectScripts !== undefined) {
      projectScriptOverrides[projectId] = entry.defaultProjectScripts;
    }
  }
  return { projectAgentBrowserAccessOverrides, projectAutoPullOverrides, projectScriptOverrides };
}

/**
 * Rewrite a patch that still uses the legacy per-key project maps into
 * entries of `projectSettingsOverrides`, so older clients keep editing the
 * values the server actually reads. `null` in a legacy map clears that one
 * override.
 */
function translateLegacyProjectOverridePatch(
  current: Pick<ServerSettings, "projectSettingsOverrides">,
  patch: ServerSettingsPatch,
): ServerSettingsPatch {
  const {
    projectAgentBrowserAccessOverrides,
    projectAutoPullOverrides,
    projectScriptOverrides,
    ...rest
  } = patch;
  if (
    projectAgentBrowserAccessOverrides === undefined &&
    projectAutoPullOverrides === undefined &&
    projectScriptOverrides === undefined
  ) {
    return patch;
  }
  const currentEntries: Readonly<Record<string, ProjectSettingsOverrides>> =
    current.projectSettingsOverrides;
  const entries = new Map<string, ProjectSettingsOverrides | null>(
    Object.entries(rest.projectSettingsOverrides ?? {}),
  );
  // A canonical entry in the same patch is the newer representation; a legacy
  // map must not resurrect a key that entry deliberately omits.
  const canonicalProjectIds = new Set(Object.keys(rest.projectSettingsOverrides ?? {}));
  const applyKey = <K extends ProjectScopedServerSettingKey>(
    map: Readonly<Record<string, ProjectSettingsOverrides[K] | null>> | undefined,
    key: K,
  ) => {
    if (map === undefined) return;
    for (const [projectId, value] of Object.entries(map)) {
      if (canonicalProjectIds.has(projectId)) continue;
      const entry: ProjectSettingsOverrides = {
        ...(entries.get(projectId) ?? currentEntries[projectId]),
      };
      if (value === null || value === undefined) {
        delete entry[key];
      } else {
        entry[key] = value;
      }
      entries.set(projectId, Object.keys(entry).length === 0 ? null : entry);
    }
  };
  applyKey(projectAgentBrowserAccessOverrides, "enableAgentBrowserAccess");
  applyKey(projectAutoPullOverrides, "defaultAutoPull");
  applyKey(projectScriptOverrides, "defaultProjectScripts");
  return {
    ...rest,
    projectSettingsOverrides: Object.fromEntries(entries),
  } as ServerSettingsPatch;
}

export function applyServerSettingsPatch(
  current: ServerSettings,
  rawPatch: ServerSettingsPatch,
): ServerSettings {
  const patch = translateLegacyProjectOverridePatch(current, rawPatch);
  const selectionPatch = patch.textGenerationModelSelection;
  const {
    migrateModelPreferences,
    setModelFavorites,
    setModelsHidden,
    setProviderModelOrder,
    providerModelPreferences,
    automaticGitFetchInterval,
    providerHealthRefreshInterval,
    backgroundActivityProfile,
    backgroundActivity,
    worktreeCleanup: worktreeCleanupPatch,
    sourceControlHosts: sourceControlHostsPatch,
    // Merged per entry below; its `null` removals must not reach deepMerge.
    secretProviders: secretProvidersPatch,
    usagePriceOverrides: usagePriceOverridesPatch,
    usageModelAliases: usageModelAliasesPatch,
    // Entry replacement: deepMerge would keep keys the client meant to clear.
    projectSettingsOverrides: projectSettingsOverridesPatch,
    // Already translated into `projectSettingsOverrides` above; the legacy
    // maps are derived views and must never be merged directly.
    projectAgentBrowserAccessOverrides: _legacyBrowserAccess,
    projectAutoPullOverrides: _legacyAutoPull,
    projectScriptOverrides: _legacyScripts,
    ...patchForMerge
  } = patch;
  const currentBackgroundActivity = normalizeServerBackgroundActivitySettings(current);
  const backgroundActivityPatch =
    backgroundActivityProfile !== undefined
      ? {
          schemaVersion: 1 as const,
          profile:
            automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
              ? ("custom" as const)
              : backgroundActivityProfile,
          ...(automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
            ? { baseProfile: backgroundActivityProfile }
            : {}),
          overrides: {
            ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
            ...(providerHealthRefreshInterval !== undefined
              ? { providerHealthRefreshInterval }
              : {}),
          },
        }
      : automaticGitFetchInterval !== undefined || providerHealthRefreshInterval !== undefined
        ? {
            schemaVersion: 1 as const,
            profile: "custom" as const,
            baseProfile: getBackgroundActivityBaseProfile(currentBackgroundActivity),
            overrides: {
              ...(currentBackgroundActivity.profile === "custom"
                ? currentBackgroundActivity.overrides
                : {}),
              ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
              ...(providerHealthRefreshInterval !== undefined
                ? { providerHealthRefreshInterval }
                : {}),
            },
          }
        : undefined;
  const initialFavorites =
    patch.favorites ?? current.favorites ?? migrateModelPreferences?.favorites ?? null;
  const favorites =
    setModelFavorites?.reduce((current, change) => {
      const exists = current.some(
        (favorite) => favorite.provider === change.provider && favorite.model === change.model,
      );
      return change.favorite
        ? exists
          ? current
          : [...current, { provider: change.provider, model: change.model }]
        : current.filter(
            (favorite) => favorite.provider !== change.provider || favorite.model !== change.model,
          );
    }, initialFavorites ?? []) ?? initialFavorites;
  const initialModelPreferences =
    providerModelPreferences ??
    current.providerModelPreferences ??
    migrateModelPreferences?.providerModelPreferences ??
    null;
  let nextModelPreferences = initialModelPreferences;
  for (const change of setModelsHidden ?? []) {
    const preferences = nextModelPreferences?.[change.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    const hiddenModels = preferences.hiddenModels.filter((model) => model !== change.model);
    if (change.hidden) hiddenModels.push(change.model);
    nextModelPreferences = {
      ...nextModelPreferences,
      [change.provider]: { ...preferences, hiddenModels },
    };
  }
  if (setProviderModelOrder) {
    const preferences = nextModelPreferences?.[setProviderModelOrder.provider] ?? {
      hiddenModels: [],
      modelOrder: [],
    };
    nextModelPreferences = {
      ...nextModelPreferences,
      [setProviderModelOrder.provider]: {
        ...preferences,
        modelOrder: [...setProviderModelOrder.modelOrder],
      },
    };
  }
  const next = deepMerge(current, patchForMerge);
  const nextWithReplacementsBase = {
    ...next,
    favorites,
    providerModelPreferences: nextModelPreferences,
    ...(worktreeCleanupPatch === undefined
      ? {}
      : {
          worktreeCleanup:
            worktreeCleanupPatch?.mode === "custom"
              ? {
                  mode: "custom" as const,
                  rules: {
                    worktreeKeepWhen: next.storageCleanup.worktreeKeepWhen,
                    worktreeAfterDays: next.storageCleanup.worktreeAfterDays,
                    worktreeSettledAfterDays: next.storageCleanup.worktreeSettledAfterDays,
                    worktreeOnMerge: next.storageCleanup.worktreeOnMerge,
                    worktreeOnDelete: next.storageCleanup.worktreeOnDelete,
                    worktreeUnchanged: next.storageCleanup.worktreeUnchanged,
                    ...(current.worktreeCleanup?.mode === "custom"
                      ? current.worktreeCleanup.rules
                      : {}),
                    ...worktreeCleanupPatch.rules,
                  },
                }
              : worktreeCleanupPatch,
        }),
    ...(backgroundActivity !== undefined
      ? {
          backgroundActivity: {
            ...deepMerge(currentBackgroundActivity, backgroundActivity),
            ...(backgroundActivity.overrides !== undefined
              ? { overrides: backgroundActivity.overrides }
              : {}),
          },
        }
      : { backgroundActivity: currentBackgroundActivity }),
    ...(backgroundActivity === undefined && backgroundActivityPatch !== undefined
      ? { backgroundActivity: backgroundActivityPatch }
      : {}),
    ...(patch.providerInstances !== undefined
      ? { providerInstances: patch.providerInstances }
      : {}),
    ...(patch.worktreesDirectory !== undefined &&
    patch.worktreesDirectory !== current.worktreesDirectory
      ? {
          previousWorktreesDirectories: [
            ...current.previousWorktreesDirectories.filter(
              (directory) => directory !== patch.worktreesDirectory,
            ),
            ...(current.worktreesDirectory !== "" &&
            !current.previousWorktreesDirectories.includes(current.worktreesDirectory)
              ? [current.worktreesDirectory]
              : []),
          ],
        }
      : {}),
    // Per host, a patched field replaces the saved one: deepMerge would keep a cleared account pin.
    ...(sourceControlHostsPatch !== undefined
      ? {
          sourceControlHosts: {
            ...current.sourceControlHosts,
            ...Object.fromEntries(
              Object.entries(sourceControlHostsPatch).map(([kind, fields]) => [
                kind,
                { ...current.sourceControlHosts[kind], ...fields },
              ]),
            ),
          },
        }
      : {}),
    // A role's or task kind's pin is replaced whole: deepMerge would keep the previous pin's effort and `always`.
    ...(patch.subagents?.rolePins !== undefined || patch.subagents?.taskPins !== undefined
      ? {
          subagents: {
            ...next.subagents,
            ...(patch.subagents.rolePins !== undefined ? { rolePins: { ...current.subagents.rolePins, ...patch.subagents.rolePins } } : {}),
            ...(patch.subagents.taskPins !== undefined ? { taskPins: { ...current.subagents.taskPins, ...patch.subagents.taskPins } } : {}),
          },
        }
      : {}),
    ...(projectSettingsOverridesPatch !== undefined
      ? {
          projectSettingsOverrides: Object.fromEntries(
            Object.entries(
              mergeProjectSettingsOverridesPatch(
                current.projectSettingsOverrides,
                projectSettingsOverridesPatch,
              ),
            ).filter(([, entry]) => Object.keys(entry).length > 0),
          ),
        }
      : {}),
    ...(patch.defaultModelSelection !== undefined
      ? { defaultModelSelection: patch.defaultModelSelection }
      : {}),
    ...(patch.defaultProjectScripts !== undefined
      ? { defaultProjectScripts: patch.defaultProjectScripts }
      : {}),
    ...(secretProvidersPatch !== undefined
      ? { secretProviders: mergeSettingsEntries(current.secretProviders, secretProvidersPatch) }
      : {}),
    ...(usagePriceOverridesPatch !== undefined
      ? {
          usagePriceOverrides: mergeSettingsEntries(
            current.usagePriceOverrides,
            usagePriceOverridesPatch,
          ),
        }
      : {}),
    ...(usageModelAliasesPatch !== undefined
      ? {
          usageModelAliases: mergeSettingsEntries(
            current.usageModelAliases,
            usageModelAliasesPatch,
          ),
        }
      : {}),
    ...(patch.sourceControlWriterModelSelection !== undefined
      ? { sourceControlWriterModelSelection: patch.sourceControlWriterModelSelection }
      : {}),
    ...(patch.reviewGuideModelSelection !== undefined
      ? { reviewGuideModelSelection: patch.reviewGuideModelSelection }
      : {}),
    ...(automaticGitFetchInterval !== undefined ? { automaticGitFetchInterval } : {}),
    ...(providerHealthRefreshInterval !== undefined ? { providerHealthRefreshInterval } : {}),
  };
  const normalizedBackgroundActivity = normalizeBackgroundActivitySettings(
    nextWithReplacementsBase.backgroundActivity,
  );
  const resolvedBackgroundActivity = resolveBackgroundActivitySettings(
    normalizedBackgroundActivity,
  );
  const nextWithReplacements = {
    ...nextWithReplacementsBase,
    ...deriveLegacyProjectOverrides(nextWithReplacementsBase),
    backgroundActivity: normalizedBackgroundActivity,
    automaticGitFetchInterval: resolvedBackgroundActivity.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolvedBackgroundActivity.providerHealthRefreshInterval,
    backgroundActivityProfile: resolvedBackgroundActivity.profile,
  };
  if (!selectionPatch) {
    return nextWithReplacements;
  }

  const instanceId = selectionPatch.instanceId ?? current.textGenerationModelSelection.instanceId;
  const model = selectionPatch.model ?? current.textGenerationModelSelection.model;
  const options = shouldReplaceTextGenerationModelSelection(selectionPatch)
    ? selectionPatch.options
    : mergeModelSelectionOptionsById({
        current: current.textGenerationModelSelection.options,
        patch: selectionPatch.options,
      });

  return {
    ...nextWithReplacements,
    textGenerationModelSelection: createModelSelection(instanceId, model, options),
  };
}

/** Resolve legacy local preferences only until the environment has a saved value. */
export function resolveModelPreferences(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences> = {},
): ModelPreferences {
  return {
    favorites: settings.favorites ?? legacy.favorites ?? [],
    providerModelPreferences:
      settings.providerModelPreferences ?? legacy.providerModelPreferences ?? {},
  };
}

/** Empty legacy values do not claim ownership before another client can migrate its saved list. */
export function modelPreferencesMigrationPatch(
  settings: Pick<ServerSettings, "favorites" | "providerModelPreferences">,
  legacy: Partial<ModelPreferences>,
): ServerSettingsPatch | null {
  const favorites =
    settings.favorites === null && (legacy.favorites?.length ?? 0) > 0
      ? legacy.favorites
      : undefined;
  const providerModelPreferences =
    settings.providerModelPreferences === null &&
    Object.keys(legacy.providerModelPreferences ?? {}).length > 0
      ? legacy.providerModelPreferences
      : undefined;
  return favorites === undefined && providerModelPreferences === undefined
    ? null
    : {
        migrateModelPreferences: {
          ...(favorites === undefined ? {} : { favorites }),
          ...(providerModelPreferences === undefined ? {} : { providerModelPreferences }),
        },
      };
}
