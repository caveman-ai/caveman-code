// ), apps/server/src/provider/ClaudeModelCatalog.ts @ ab3a3cd1.
import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ModelSelection,
  ProviderDriverKind,
  type ProviderOptionDescriptor,
  type ServerProviderModel,
  type ServerProviderUpdateRequiredModel,
} from "@caveman-app/protocol";
import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import * as Option from "effect/Option";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  readCustomModelEntries,
} from "@caveman-app/shared/model";
import { compareSemverVersions } from "@caveman-app/shared/semver";

import {
  type ClaudeCodeCompatibility,
  type ClaudeCodeProfile,
  decodeClaudeModelAdapter,
  decodeClaudeProfileAdapter,
} from "./ClaudeModelManifest.ts";
import * as ModelCatalog from "@caveman-app/engine-core/server/ModelCatalog";
import { modelsDevFacts, releasesOf } from "@caveman-app/engine-core/server/modelsDev";
import { BUNDLED_MODEL_MANIFEST, resolveProviderCatalog } from "./ModelManifest.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const EMPTY_CAPABILITIES: ModelCapabilities = { optionDescriptors: [] };

export interface ClaudeCatalogModel {
  readonly model: ServerProviderModel;
  readonly runtime: ClaudeCodeProfile;
  readonly compatibility: ClaudeCodeCompatibility;
  /** Found on models.dev, not in this build's catalog (`withNewestClaudeCode`). */
  readonly discovered?: true;
}

/** Whose releases follow Claude's catalog on models.dev. */
const CLAUDE_MAKER = "anthropic";

export interface ClaudeModelCatalog {
  readonly models: ReadonlyArray<ClaudeCatalogModel>;
}

function tryResolveClaudeModelCatalog(
  resolved: ModelCatalog.ProviderCatalog | undefined,
): ClaudeModelCatalog | null {
  if (!resolved) return null;

  const models: Array<ClaudeCatalogModel> = [];
  for (const entry of resolved.models) {
    const profile = decodeClaudeProfileAdapter(entry.profileAdapter ?? {});
    const adapter = decodeClaudeModelAdapter(entry.adapter ?? {});
    if (Option.isNone(profile) || Option.isNone(adapter)) return null;
    models.push({
      model: ModelCatalog.catalogServerModel(resolved, entry),
      runtime: profile.value.claudeCode ?? {},
      compatibility: adapter.value.claudeCode ?? {},
      ...(entry.discovered ? { discovered: true as const } : {}),
    });
  }

  return {
    models,
  };
}

/**
 * Claude's catalog from its manifest entry, falling back to the bundled entry
 * when the current one is missing or has invalid adapters, with each family's
 * newest Anthropic release on models.dev beside it (ModelCatalog
 * `withSuccessors`): Claude Fable 5.2 runs on Fable 5.1's profile the day
 * models.dev lists it. The fallback is resolved on each read so its new-model
 * badges can expire.
 */
export function resolveClaudeModelCatalog(
  catalog: ModelCatalog.ProviderCatalog | undefined,
  releases: ReadonlyArray<ModelCatalog.Release> = releasesOf(CLAUDE_MAKER),
): ClaudeModelCatalog {
  const withReleases = (resolved: ModelCatalog.ProviderCatalog | null | undefined) =>
    resolved ? ModelCatalog.withSuccessors(resolved, releases) : undefined;
  return (
    tryResolveClaudeModelCatalog(withReleases(catalog)) ??
    tryResolveClaudeModelCatalog(
      withReleases(resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, CLAUDE)),
    ) ?? {
      models: [],
    }
  );
}

/** This build's catalog alone, nothing from models.dev: for defaults and tests. */
export const BUNDLED_CLAUDE_MODEL_CATALOG = resolveClaudeModelCatalog(undefined, []);

let listed: ClaudeModelCatalog | undefined;
let live: { readonly facts: unknown; readonly catalog: ClaudeModelCatalog } | undefined;

/**
 * Keeps the catalog Claude Agent's provider resolved last (ClaudeDriver): the
 * current manifest, a remote one included, with models.dev's releases. The
 * manifest and models.dev are one per process, so every instance resolves
 * the same catalog.
 */
export function rememberClaudeModelCatalog(catalog: ClaudeModelCatalog | undefined): void {
  listed = catalog;
}

/**
 * What a session compiles a model selection against: the catalog the picker
 * was built from, so a model found on models.dev runs with the effort levels,
 * Ultracode and fast mode it was listed with. Before Claude Agent resolves
 * one, the bundled catalog with what Anthropic released since.
 */
export function claudeModelCatalogNow(): ClaudeModelCatalog {
  if (listed !== undefined) return listed;
  const facts = modelsDevFacts();
  if (live === undefined || live.facts !== facts) {
    live = { facts, catalog: resolveClaudeModelCatalog(undefined) };
  }
  return live.catalog;
}

/**
 * A model found on models.dev needs the newest Claude Code: an older one runs
 * it as a model it doesn't know, without its effort levels or adaptive
 * thinking. So its minimum is `newest` where that is above its family's, and
 * an older Claude Code lists it as an update away (and Claude Code updates
 * itself, engineUpdates.ts). With no newest version to go by (update checks
 * off, offline), its family's minimum stands.
 */
export function withNewestClaudeCode(
  catalog: ClaudeModelCatalog,
  newest: string | null | undefined,
): ClaudeModelCatalog {
  if (!newest || !catalog.models.some((entry) => entry.discovered)) return catalog;
  return {
    models: catalog.models.map((entry) => {
      const minVersion = entry.compatibility.minVersion;
      if (!entry.discovered || (minVersion && compareSemverVersions(minVersion, newest) >= 0)) {
        return entry;
      }
      return { ...entry, compatibility: { ...entry.compatibility, minVersion: newest } };
    }),
  };
}

/**
 * One row of the installed `claude`'s own model list (the SDK's initialize
 * `models`), which the CLI tailors to its version and the person's login. A
 * model it lists runs on it, whatever the manifest knows.
 */
export interface ClaudeReportedModel {
  /** The Anthropic id the row calls (`claude-opus-5-5`), with no `[1m]`-style suffix. */
  readonly slug: string;
  /** The row's own value when it is an alias for `slug` (`opus`, `default`). */
  readonly alias?: string;
  /** Effort levels the model takes; undefined when the CLI does not say. */
  readonly effortLevels?: ReadonlyArray<string>;
  readonly fastMode: boolean;
}

/** The SDK's `ModelInfo`, as far as the catalog reads it. */
export interface ClaudeModelInfoRow {
  readonly value: string;
  readonly resolvedModel?: string;
  readonly supportsEffort?: boolean;
  readonly supportedEffortLevels?: ReadonlyArray<string>;
  readonly supportsFastMode?: boolean;
}

/** An Anthropic model id. A person's custom option (`ANTHROPIC_CUSTOM_MODEL_OPTION`) or a cloud lane's id is not one. */
const CLAUDE_MODEL_ID = /^claude-[a-z0-9][a-z0-9.-]*$/;
const CLAUDE_ALIAS = /^[a-z][a-z0-9-]*$/;

/** The rows of `models` that name an Anthropic model, in the CLI's order. */
export function parseClaudeReportedModels(
  models: ReadonlyArray<ClaudeModelInfoRow> | undefined,
): ReadonlyArray<ClaudeReportedModel> {
  return (models ?? []).flatMap((info) => {
    const slug = (info.resolvedModel ?? info.value).trim().replace(/\[[^\]]*\]$/u, "");
    if (!CLAUDE_MODEL_ID.test(slug)) return [];
    const value = info.value.trim();
    const effortLevels =
      info.supportedEffortLevels ?? (info.supportsEffort === false ? [] : undefined);
    return [
      {
        slug,
        ...(value !== slug && CLAUDE_ALIAS.test(value) && !value.startsWith("claude-")
          ? { alias: value }
          : {}),
        ...(effortLevels ? { effortLevels } : {}),
        fastMode: info.supportsFastMode === true,
      },
    ];
  });
}

/** `claude-opus-5-5` as family `opus`, version [5, 5]; a date suffix only names a build of one version. */
const CLAUDE_LINE = /^claude-([a-z]+(?:-[a-z]+)*)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/u;

function claudeLine(slug: string): { family: string; version: [number, number] } | undefined {
  const match = CLAUDE_LINE.exec(slug);
  return match
    ? { family: match[1]!, version: [Number(match[2]), Number(match[3] ?? 0)] }
    : undefined;
}

const compareVersions = (a: readonly [number, number], b: readonly [number, number]) =>
  a[0] - b[0] || a[1] - b[1];

function claudeModelName(slug: string): string {
  const line = claudeLine(slug);
  if (!line) return slug;
  const family = line.family
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
  const [major, minor] = line.version;
  return `Claude ${family} ${major}${minor > 0 ? `.${minor}` : ""}`;
}

const EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * A model the manifest lacks takes its family's newest model's options and
 * runtime profile (effort labels, effort map, context window), cut to what
 * the CLI says it supports. Without a family it gets just the CLI's effort
 * levels and fast mode, and Claude Code picks the default effort.
 */
function reportedCatalogModel(
  row: ClaudeReportedModel,
  template: ClaudeCatalogModel | undefined,
): ClaudeCatalogModel {
  const effortMap = template?.runtime.effortMap ?? {};
  const supportsEffort = (id: string) =>
    row.effortLevels === undefined ||
    row.effortLevels.includes(id) ||
    (effortMap[id] != null && row.effortLevels.includes(effortMap[id]));
  const fromTemplate = (template?.model.capabilities?.optionDescriptors ?? []).flatMap(
    (descriptor): Array<ProviderOptionDescriptor> => {
      if (descriptor.type === "boolean") {
        return descriptor.id === "fastMode" && !row.fastMode ? [] : [descriptor];
      }
      if (descriptor.id !== "effort") return [descriptor];
      const options = descriptor.options.filter((option) => supportsEffort(option.id));
      return options.length === 0 ? [] : [{ ...descriptor, options }];
    },
  );
  const fastMode: ProviderOptionDescriptor = {
    id: "fastMode",
    label: "Fast Mode",
    type: "boolean",
  };
  const optionDescriptors: Array<ProviderOptionDescriptor> = template
    ? [
        ...fromTemplate,
        ...(row.fastMode && !fromTemplate.some((descriptor) => descriptor.id === "fastMode")
          ? [fastMode]
          : []),
      ]
    : [
        ...(row.effortLevels && row.effortLevels.length > 0
          ? [
              {
                id: "effort",
                label: "Reasoning",
                type: "select" as const,
                options: row.effortLevels.map((id) => ({ id, label: EFFORT_LABELS[id] ?? id })),
              },
            ]
          : []),
        ...(row.fastMode ? [fastMode] : []),
      ];
  return {
    model: {
      slug: row.slug,
      name: claudeModelName(row.slug),
      isCustom: false,
      capabilities: { optionDescriptors },
    },
    runtime: template?.runtime ?? {},
    compatibility: {},
  };
}

/**
 * The catalog as the installed `claude` sees it, so a new Claude model shows
 * up the day the CLI has it rather than with a Caveman Code release:
 *
 * - a model it lists that the catalog lacks is added (`reportedCatalogModel`);
 * - a model it lists runs, whatever the manifest's minimum version says;
 * - its aliases (`opus`, `sonnet`) and its `default` point where it says;
 * - a model it lists under an alias is current, and so is each family's newest
 *   listed model; an older one without an alias is legacy. Families it does
 *   not list keep the manifest's classification.
 */
export function withReportedClaudeModels(
  catalog: ClaudeModelCatalog,
  reported: ReadonlyArray<ClaudeReportedModel>,
): ClaudeModelCatalog {
  if (reported.length === 0) return catalog;

  const models = [...catalog.models];
  for (const row of reported) {
    if (resolveClaudeCatalogModel({ models }, row.slug)) continue;
    const line = claudeLine(row.slug);
    const family = line
      ? models.filter(
          (entry) => !entry.model.isCustom && claudeLine(entry.model.slug)?.family === line.family,
        )
      : [];
    const template = family.toSorted((a, b) =>
      compareVersions(claudeLine(b.model.slug)!.version, claudeLine(a.model.slug)!.version),
    )[0];
    // Beside its family, newest first; a family the catalog has never seen leads.
    models.splice(
      family[0] ? models.indexOf(family[0]) : 0,
      0,
      reportedCatalogModel(row, template),
    );
  }

  /** Each row as the catalog entry it calls. */
  const listed = reported.map((row) => ({
    row,
    slug: resolveClaudeCatalogModel({ models }, row.slug)!.model.slug,
  }));
  const listedSlugs = new Set(listed.map(({ slug }) => slug));
  const newestListed = new Map<string, readonly [number, number]>();
  for (const slug of listedSlugs) {
    const line = claudeLine(slug);
    const newest = line && newestListed.get(line.family);
    if (line && (!newest || compareVersions(line.version, newest) > 0)) {
      newestListed.set(line.family, line.version);
    }
  }
  const aliasTargets = new Map<string, string>();
  for (const { row, slug } of listed) {
    if (row.alias && !aliasTargets.has(row.alias)) aliasTargets.set(row.alias, slug);
  }
  const defaultSlug = aliasTargets.get("default");
  aliasTargets.delete("default");
  const movedAliases = new Set([...aliasTargets.keys()].map((alias) => alias.toLowerCase()));
  const aliased = new Set(aliasTargets.values());

  return {
    models: models.map((entry) => {
      if (entry.model.isCustom) return entry;
      const {
        slug,
        isLegacy: wasLegacy,
        isDefault: wasDefault,
        aliases: _aliases,
        ...model
      } = entry.model;
      const line = claudeLine(slug);
      const newest = line && newestListed.get(line.family);
      const order = newest ? compareVersions(line.version, newest) : undefined;
      const featured = aliased.has(slug) || defaultSlug === slug;
      const isLegacy =
        order === undefined
          ? wasLegacy
          : !featured && (order < 0 || (!listedSlugs.has(slug) && wasLegacy));
      const isDefault = defaultSlug ? slug === defaultSlug : wasDefault;
      const aliases = [
        ...(entry.model.aliases ?? []).filter((alias) => !movedAliases.has(alias.toLowerCase())),
        ...[...aliasTargets].flatMap(([alias, target]) => (target === slug ? [alias] : [])),
      ];
      return {
        model: {
          ...model,
          slug,
          ...(aliases.length > 0 ? { aliases } : {}),
          ...(isDefault ? { isDefault: true } : {}),
          ...(isLegacy ? { isLegacy: true } : {}),
        },
        runtime: entry.runtime,
        // A model the CLI lists runs on it, whatever minimum version the manifest names.
        compatibility: listedSlugs.has(slug) ? {} : entry.compatibility,
      };
    }),
  };
}

/**
 * Claude models an installed CLI listed that the bundled manifest lacks, by
 * slug. What a model id takes (effort, fast mode, context window) belongs to
 * the model, not to a login, so every session in this process resolves its
 * options from them; each instance's picker still lists only what its own
 * CLI reported.
 */
const learnedClaudeModels = new Map<string, ClaudeCatalogModel>();

export function rememberClaudeModels(catalog: ClaudeModelCatalog): void {
  for (const entry of catalog.models) {
    if (
      entry.model.isCustom ||
      resolveClaudeCatalogModel(BUNDLED_CLAUDE_MODEL_CATALOG, entry.model.slug)
    ) {
      continue;
    }
    const { aliases: _aliases, isDefault: _isDefault, ...model } = entry.model;
    learnedClaudeModels.set(model.slug, { ...entry, model });
  }
}

/** `catalog` and the learned models it lacks. */
export function withLearnedClaudeModels(catalog: ClaudeModelCatalog): ClaudeModelCatalog {
  const learned = [...learnedClaudeModels.values()].filter(
    (entry) => !resolveClaudeCatalogModel(catalog, entry.model.slug),
  );
  return learned.length === 0 ? catalog : { models: [...catalog.models, ...learned] };
}

/**
 * The catalog sessions compile against (claudeModelCatalogNow: the manifest with
 * models.dev's releases) and every model an installed CLI has listed since this
 * process started.
 */
export const knownClaudeModelCatalog = (): ClaudeModelCatalog =>
  withLearnedClaudeModels(claudeModelCatalogNow());

/** Tests: forget the learned models. */
export const forgetLearnedClaudeModels = (): void => learnedClaudeModels.clear();

/**
 * Scope the catalog to one instance's settings: custom model slugs stay opaque
 * (a built-in alias they shadow is dropped, canonical slugs and capabilities
 * are preserved), and custom entries that declare their own capabilities are
 * appended so the adapter resolves effort / fast mode / thinking against the
 * user's descriptors instead of the empty default. Custom entries carry no
 * runtime profile, so option values pass through to Claude Code verbatim.
 */
export function scopeClaudeModelCatalog(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
): ClaudeModelCatalog {
  const customEntries = readCustomModelEntries(customModels);
  if (customEntries.length === 0) return catalog;
  const customAliases = new Set(customEntries.map((entry) => entry.slug.toLowerCase()));

  const builtInModels = catalog.models.map((entry) => {
    if (!entry.model.aliases?.some((alias) => customAliases.has(alias.toLowerCase()))) {
      return entry;
    }
    return {
      ...entry,
      model: {
        ...entry.model,
        aliases: entry.model.aliases.filter((alias) => !customAliases.has(alias.toLowerCase())),
      },
    };
  });
  const builtInSlugs = new Set(builtInModels.map((entry) => entry.model.slug));
  const customCatalogModels: Array<ClaudeCatalogModel> = [];
  for (const entry of customEntries) {
    if (!entry.capabilities || builtInSlugs.has(entry.slug)) continue;
    customCatalogModels.push({
      model: {
        slug: entry.slug,
        name: entry.name,
        isCustom: true,
        capabilities: entry.capabilities,
      },
      runtime: {},
      compatibility: {},
    });
  }

  return { models: [...builtInModels, ...customCatalogModels] };
}

const CLAUDE_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function stripClaudeContextWindowSuffix(value: string): string {
  return value.replace(/\[[^\]]*\]$/, "").trim();
}

export function claudeReportedModels(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
  reported: ReadonlyArray<ClaudeModelInfo> | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!reported?.length) return [];
  const known = new Set(
    [
      ...catalog.models.flatMap(({ model }) => [model.slug, ...(model.aliases ?? [])]),
      ...readCustomModelEntries(customModels).map((entry) => entry.slug),
    ].map((id) => stripClaudeContextWindowSuffix(id).toLowerCase()),
  );
  const models: Array<ServerProviderModel> = [];
  for (const info of reported) {
    const slug = info.value.trim();
    // `default` is Claude Code's pointer at its own default model, not a model.
    if (!slug || slug === "default") continue;
    const ids = [slug, info.resolvedModel ?? ""]
      .map((id) => stripClaudeContextWindowSuffix(id).toLowerCase())
      .filter((id) => id.length > 0);
    if (ids.some((id) => known.has(id))) continue;
    for (const id of ids) known.add(id);
    const efforts = info.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
    models.push({
      slug,
      name: info.displayName.trim() || slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: efforts.length
          ? [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                // `default` is not an effort, so choosing it sends none and Claude Code picks.
                options: [
                  { id: "default", label: "Default", isDefault: true },
                  ...efforts.map((id) => ({ id, label: CLAUDE_EFFORT_LABELS[id] ?? id })),
                ],
              },
            ]
          : [],
      },
    });
  }
  return models;
}

function resolveClaudeCatalogModel(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ClaudeCatalogModel | undefined {
  const value = slugOrAlias?.trim();
  if (!value) return undefined;
  return (
    catalog.models.find((entry) => entry.model.slug === value) ??
    catalog.models.find((entry) =>
      entry.model.aliases?.some((alias) => alias.toLowerCase() === value.toLowerCase()),
    )
  );
}

export function resolveClaudeModelSlug(catalog: ClaudeModelCatalog, slugOrAlias: string): string {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.slug ?? slugOrAlias;
}

export function getClaudeCatalogModelCapabilities(
  catalog: ClaudeModelCatalog,
  slugOrAlias: string | null | undefined,
): ModelCapabilities {
  return resolveClaudeCatalogModel(catalog, slugOrAlias)?.model.capabilities ?? EMPTY_CAPABILITIES;
}

function isVersionSupported(
  compatibility: ClaudeCodeCompatibility,
  version: string | null | undefined,
): boolean {
  if (!compatibility.minVersion && !compatibility.maxVersionExclusive) return true;
  if (!version) return false;
  if (compatibility.minVersion && compareSemverVersions(version, compatibility.minVersion) < 0) {
    return false;
  }
  return !(
    compatibility.maxVersionExclusive &&
    compareSemverVersions(version, compatibility.maxVersionExclusive) >= 0
  );
}

export function resolveClaudeModelsForVersion(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ClaudeCatalogModel["model"]> {
  return catalog.models
    .filter((entry) => isVersionSupported(entry.compatibility, version))
    .map((entry) => entry.model);
}

/**
 * Current catalog models the installed Claude Code is too old to run, so the
 * picker can show them as "update to use" instead of hiding them.
 */
export function resolveClaudeUpdateRequiredModels(
  catalog: ClaudeModelCatalog,
  version: string | null | undefined,
): ReadonlyArray<ServerProviderUpdateRequiredModel> {
  if (!version) return [];
  return catalog.models.flatMap(({ model, compatibility }) => {
    const minVersion = compatibility.minVersion;
    if (model.isLegacy || !minVersion || compareSemverVersions(version, minVersion) >= 0) {
      return [];
    }
    return [
      {
        slug: model.slug,
        name: model.name,
        ...(model.badge ? { badge: model.badge } : {}),
        minVersion,
      },
    ];
  });
}

export function formatClaudeVersionUpgradeMessage(
  catalog: ClaudeModelCatalog,
  version: string | null,
): string | undefined {
  const unavailable = catalog.models
    .filter(
      (entry) =>
        entry.compatibility.minVersion &&
        (!version || compareSemverVersions(version, entry.compatibility.minVersion) < 0),
    )
    .toSorted((left, right) =>
      compareSemverVersions(left.compatibility.minVersion!, right.compatibility.minVersion!),
    )[0];
  if (!unavailable?.compatibility.minVersion) return undefined;
  const versionLabel = version ? `v${version}` : "the installed version";
  return `Claude Agent ${versionLabel} is too old for ${unavailable.model.name}. Upgrade to v${unavailable.compatibility.minVersion} or newer to access it.`;
}

export function resolveClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  model: string | null | undefined,
  raw: string | null | undefined,
): string | undefined {
  if (!resolveClaudeCatalogModel(catalog, model)) {
    const effort = raw?.trim();
    return effort && ["low", "medium", "high", "xhigh", "max"].includes(effort)
      ? effort
      : undefined;
  }

  const caps = getClaudeCatalogModelCapabilities(catalog, model);
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "effort", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "effort");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function normalizeClaudeCatalogEffort(
  catalog: ClaudeModelCatalog,
  effort: string | null | undefined,
  model: string | null | undefined,
): string | undefined {
  if (!effort) return undefined;
  const effortMap = resolveClaudeCatalogModel(catalog, model)?.runtime.effortMap;
  if (!effortMap || !Object.prototype.hasOwnProperty.call(effortMap, effort)) return effort;
  return effortMap[effort] ?? undefined;
}

export function isClaudeCatalogUltracodeEffort(effort: string | null | undefined): boolean {
  return effort === "ultracode";
}

function resolveClaudeCatalogContextWindow(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): string | undefined {
  const caps = getClaudeCatalogModelCapabilities(catalog, modelSelection?.model);
  const raw = getModelSelectionStringOptionValue(modelSelection, "contextWindow");
  const descriptors = getProviderOptionDescriptors({
    caps,
    ...(raw ? { selections: [{ id: "contextWindow", value: raw }] } : {}),
  });
  const descriptor = descriptors.find((candidate) => candidate.id === "contextWindow");
  const value = getProviderOptionCurrentValue(descriptor);
  return typeof value === "string" ? value : undefined;
}

export function resolveClaudeCatalogApiModelId(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection,
): string {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection.model);
  const slug = entry?.model.slug ?? modelSelection.model;
  const descriptors = getProviderOptionDescriptors({
    caps: entry?.model.capabilities ?? EMPTY_CAPABILITIES,
    selections: modelSelection.options,
  });
  for (const [optionId, suffixes] of Object.entries(entry?.runtime.modelSuffixes ?? {})) {
    const value = getProviderOptionCurrentValue(
      descriptors.find((descriptor) => descriptor.id === optionId),
    );
    if (typeof value === "string" && suffixes[value]) return `${slug}${suffixes[value]}`;
  }
  return slug;
}

export function resolveClaudeCatalogContextWindowTokens(
  catalog: ClaudeModelCatalog,
  modelSelection: ModelSelection | undefined,
): number | undefined {
  const entry = resolveClaudeCatalogModel(catalog, modelSelection?.model);
  if (!entry) return undefined;
  if (entry.runtime.fixedContextWindowTokens) return entry.runtime.fixedContextWindowTokens;
  const contextWindow = resolveClaudeCatalogContextWindow(catalog, modelSelection);
  return contextWindow ? entry.runtime.contextWindowTokens?.[contextWindow] : undefined;
}
