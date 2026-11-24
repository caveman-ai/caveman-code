// ), packages/provider-core/src/server/ModelCatalog.ts @ ab3a3cd1.
/**
 * ModelCatalog — the model metadata a provider reads from upstream model manifest.
 *
 * The server owns the manifest itself (bundle, remote refresh, disk cache,
 * compatibility policies). A provider only sees its own catalog entry, so a
 * provider package never depends on the manifest file or how it is fetched.
 * Reads never wait on the network.
 *
 * @module provider-core/server/ModelCatalog
 */
import type {
  ModelCapabilities,
  ProviderDriverKind,
  ServerProviderModel,
} from "@caveman-app/protocol";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import { compareLines, modelLine, newestOfFamilies } from "./modelLine.ts";
import type { ServerProviderDraft } from "./snapshotProbe.ts";

/** One model entry in a provider's manifest catalog. */
export interface ProviderCatalogModel {
  readonly slug: string;
  readonly name: string;
  readonly shortName?: string;
  readonly subProvider?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly status: "current" | "legacy";
  readonly badge?: "new";
  readonly capabilities: ModelCapabilities | null;
  /** Provider-owned metadata for this model; the provider decodes it. */
  readonly adapter: unknown;
  /** Provider-owned metadata for the model's capability profile. */
  readonly profileAdapter: unknown;
  /**
   * Released after this catalog was written and found on models.dev (`withSuccessors`): it runs on its family's
   * newest entry's profile and adapter, and the engine decides what more it needs (Claude: the newest Claude Code).
   */
  readonly discovered?: true;
}

/** A provider's catalog entry: its models and the chat default. */
export interface ProviderCatalog {
  readonly models: ReadonlyArray<ProviderCatalogModel>;
  readonly defaultChatModel: string | undefined;
}

export class ModelCatalog extends Context.Service<
  ModelCatalog,
  {
    /**
     * The driver's catalog from the manifest in memory (disk cache or bundle),
     * or `undefined` when the manifest has no entry for it. Never fetches.
     */
    readonly current: (
      driverKind: ProviderDriverKind,
    ) => Effect.Effect<ProviderCatalog | undefined>;
    /** The same catalog from the bundled manifest; for fallbacks when remote data is invalid. */
    readonly bundled: (driverKind: ProviderDriverKind) => ProviderCatalog | undefined;
    /**
     * Starts a TTL-gated remote refresh in the background. Provider checks call
     * this; it never fails and never blocks the check.
     */
    readonly refreshInBackground: Effect.Effect<void>;
  }
>()("@caveman-app/engine-core/server/ModelCatalog") {}

/** A catalog model as the snapshot model it presents. */
export const catalogServerModel = (
  catalog: ProviderCatalog,
  entry: ProviderCatalogModel,
): ServerProviderModel => ({
  slug: entry.slug,
  name: entry.name,
  ...(entry.shortName ? { shortName: entry.shortName } : {}),
  ...(entry.subProvider ? { subProvider: entry.subProvider } : {}),
  ...(entry.aliases ? { aliases: entry.aliases } : {}),
  ...(entry.badge ? { badge: entry.badge } : {}),
  isCustom: false,
  ...(catalog.defaultChatModel === entry.slug ? { isDefault: true } : {}),
  ...(entry.status === "legacy" ? { isLegacy: true } : {}),
  capabilities: entry.capabilities,
});

/** How a driver matches its discovered slugs to catalog entries. */
export interface CatalogMatching {
  /**
   * Maps a slug to the family the catalog names it by, such as a dated Codex
   * build to its base model. Defaults to the slug itself.
   */
  readonly family?: (slug: string) => string;
}

const familyOf = (matching: CatalogMatching | undefined, slug: string) =>
  matching?.family?.(slug) ?? slug;

/**
 * Reclassifies built-in models as legacy or current from the catalog. Custom
 * models are user-defined and never reclassified.
 */
export function classifyCatalogModels(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ProviderCatalog | undefined,
  matching?: CatalogMatching,
): ReadonlyArray<ServerProviderModel> {
  return models.map((model) => {
    if (model.isCustom) return model;
    const entry =
      catalog?.models.find((candidate) => candidate.slug === model.slug) ??
      catalog?.models.find((candidate) => candidate.slug === familyOf(matching, model.slug));
    if (entry?.status === "legacy") return model.isLegacy ? model : { ...model, isLegacy: true };
    if (!model.isLegacy) return model;
    const { isLegacy: _isLegacy, ...rest } = model;
    return rest;
  });
}

/**
 * Moves `isDefault` to the catalog's chat default when the catalog names one
 * the models include. Providers that learn their default from the runtime can
 * be overridden here without a release. Aliases that pointed at the old
 * default move with the flag so the shared "provider default" alias keeps
 * resolving.
 */
export function applyCatalogDefault(
  models: ReadonlyArray<ServerProviderModel>,
  catalog: ProviderCatalog | undefined,
  matching?: CatalogMatching,
): ReadonlyArray<ServerProviderModel> {
  const requestedSlug = catalog?.defaultChatModel;
  if (requestedSlug === undefined) return models;
  const slug =
    models.find((model) => model.slug === requestedSlug)?.slug ??
    (matching?.family === undefined
      ? undefined
      : models.find(
          (model) =>
            !model.isCustom && familyOf(matching, model.slug) === familyOf(matching, requestedSlug),
        )?.slug);
  if (slug === undefined) return models;
  const previous = models.find((model) => model.isDefault && model.slug !== slug);
  if (!previous) return models;
  const movedAliases = previous.aliases ?? [];
  return models.map((model) => {
    if (model.slug === previous.slug) {
      const { isDefault: _isDefault, aliases: _aliases, ...rest } = model;
      return rest;
    }
    if (model.slug === slug) {
      const aliases = [...new Set([...(model.aliases ?? []), ...movedAliases])];
      return { ...model, isDefault: true, ...(aliases.length > 0 ? { aliases } : {}) };
    }
    return model;
  });
}

/**
 * Reclassifies a snapshot draft's built-in models and moves its default from
 * the catalog. Drivers that announce models a newer CLI unlocks add
 * `updateRequiredModels` themselves; this clears a stale list.
 */
export function applyModelCatalog(
  draft: ServerProviderDraft,
  catalog: ProviderCatalog | undefined,
  matching?: CatalogMatching,
): ServerProviderDraft {
  const { updateRequiredModels: _previous, ...rest } = draft;
  return {
    ...rest,
    models: applyCatalogDefault(
      classifyCatalogModels(draft.models, catalog, matching),
      catalog,
      matching,
    ),
  };
}

/** A model its maker released, as models.dev names it (engine-core modelsDev.ts `releasesOf`). */
export interface Release {
  readonly slug: string;
  readonly name: string;
  /** Its release day (`2026-11-09`), when models.dev gives one. */
  readonly releasedAt?: string;
}

/** How long a model reads as new after its release: a manifest entry's `releasedAt`, or a found model's. */
export const NEW_BADGE_MS = 7 * 24 * 60 * 60 * 1000;

const isNewRelease = (releasedAt: string | undefined, nowMs: number) => {
  const at = releasedAt === undefined ? NaN : Date.parse(releasedAt);
  return nowMs >= at && nowMs - at < NEW_BADGE_MS;
};

/** An alias that names a family rather than one version of it (`fable`, `opus`), and so moves to its newest model. */
const isFamilyAlias = (alias: string) => !/\d/.test(alias);

/**
 * The catalog with each family's newest release beside it: a family the catalog has a current model of gains the
 * newest model its maker released since, which runs on that model's profile and adapter under the maker's name, and
 * reads as new for a week after its release day (none known: never). The
 * family's other models turn legacy and hand their family aliases (`fable`) to the new one; the chat default stays
 * as it is, aliases and all, since a curated choice outranks a found one. A family the catalog lacks gains nothing;
 * it waits for an entry of its own.
 */
export function withSuccessors(
  catalog: ProviderCatalog,
  releases: ReadonlyArray<Release>,
  nowMs: number = Date.now(),
): ProviderCatalog {
  const known = new Set(catalog.models.flatMap((entry) => [entry.slug, ...(entry.aliases ?? [])]));
  const fresh = releases.filter((release) => !known.has(release.slug));
  if (fresh.length === 0) return catalog;
  const ids = (entries: ReadonlyArray<ProviderCatalogModel>) => entries.map((entry) => ({ id: entry.slug, entry }));
  const families = [...new Set(catalog.models.filter((entry) => entry.status === "current").map((entry) => modelLine(entry.slug).family))];
  const added = new Map<string, ProviderCatalogModel>();
  for (const family of families) {
    const base = newestOfFamilies(ids(catalog.models), [family])[0]?.entry;
    if (base === undefined) continue;
    const line = modelLine(base.slug);
    const newer = fresh
      .map((release) => ({ id: release.slug, release, line: modelLine(release.slug) }))
      .filter((candidate) => !candidate.line.alias && !candidate.line.preview && compareLines(candidate.line, line) < 0);
    const release = newestOfFamilies(newer, [family])[0]?.release;
    if (release === undefined) continue;
    const { shortName: _shortName, badge: _badge, aliases, ...template } = base;
    const moved = catalog.models
      .filter((entry) => entry.slug !== catalog.defaultChatModel && modelLine(entry.slug).family === family)
      .flatMap((entry) => entry.aliases ?? [])
      .filter(isFamilyAlias);
    added.set(family, {
      ...template,
      slug: release.slug,
      name: release.name,
      ...(moved.length > 0 ? { aliases: [...new Set(moved)] } : {}),
      status: "current",
      ...(isNewRelease(release.releasedAt, nowMs) ? { badge: "new" as const } : {}),
      discovered: true,
    });
  }
  if (added.size === 0) return catalog;
  const models = catalog.models.map((entry): ProviderCatalogModel => {
    if (entry.slug === catalog.defaultChatModel || !added.has(modelLine(entry.slug).family)) return entry;
    const aliases = entry.aliases?.filter((alias) => !isFamilyAlias(alias));
    const { aliases: _aliases, badge: _badge, ...rest } = entry;
    return { ...rest, ...(aliases && aliases.length > 0 ? { aliases } : {}), status: "legacy" };
  });
  // Each new model sits where its family's newest stood, so the picker keeps its order.
  return {
    ...catalog,
    models: models.flatMap((entry) => {
      const family = modelLine(entry.slug).family;
      const successor = added.get(family);
      const base = successor && newestOfFamilies(ids(catalog.models), [family])[0]?.entry;
      return base?.slug === entry.slug ? [successor!, entry] : [entry];
    }),
  };
}
