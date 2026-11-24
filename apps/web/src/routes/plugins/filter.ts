// The plugins marketplace's search, on lib/facets and lib/fuzzy: what the search reads and the facets
// (status, category, marketplace) it can be narrowed by. Pure; the Plugins page (Home.tsx) renders it.
import { type Facet, type Filters, passes } from "../../lib/facets.ts";
import { type FieldsMatch, matchFields, queryWords } from "../../lib/fuzzy.ts";
import type { MarketplaceInfo, PluginSummary } from "./api.ts";
import { displayName } from "./model.ts";

export const STATUS_LABEL: Record<string, string> = { installed: "Installed", enabled: "On", disabled: "Off", available: "Available" };

/** A plugin is installed and on or off, or available. */
export const statusOf = (p: PluginSummary): ReadonlyArray<string> => (p.installed ? ["installed", p.enabled ? "enabled" : "disabled"] : ["available"]);

/** A category's key: Claude Code's marketplaces write them in any case. */
export const categoryKey = (c: string): string => c.trim().toLowerCase();

/** The row's second line: the description, else the developer, else the marketplace. */
export const subtitle = (p: PluginSummary): string => p.interface.short_description ?? p.interface.developer ?? p.marketplace;

/**
 * The facets: status; category in the catalog's order, headed with a capital; marketplace by its display
 * name. Each offered only where it would change the list (lib/facets).
 */
export function pluginFacets(order: { readonly categories: ReadonlyArray<string>; readonly marketplaces: ReadonlyArray<Pick<MarketplaceInfo, "name" | "display_name">> }): ReadonlyArray<Facet<PluginSummary>> {
  const categoryLabel = new Map<string, string>();
  for (const c of order.categories) categoryLabel.set(categoryKey(c), c);
  const marketLabel = new Map(order.marketplaces.map((m) => [m.name, m.display_name]));
  return [
    { key: "status", label: "Status", values: statusOf, order: Object.keys(STATUS_LABEL), labelOf: (v) => STATUS_LABEL[v] ?? v },
    {
      key: "category",
      label: "Category",
      values: (p) => (p.interface.category ? [categoryKey(p.interface.category)] : []),
      order: order.categories.map(categoryKey),
      labelOf: (v) => {
        const c = categoryLabel.get(v) ?? v;
        return c.charAt(0).toUpperCase() + c.slice(1);
      },
    },
    { key: "source", label: "From", values: (p) => [p.marketplace], order: order.marketplaces.map((m) => m.name), labelOf: (v) => marketLabel.get(v) ?? v },
  ];
}

/** Where the search hit a plugin: `ranges[0]` on the name the row shows, `ranges[1]` on its second line. */
export type PluginMatch = FieldsMatch;

/**
 * A plugin against the query: the name, the second line, then the id, developer, category and marketplace
 * (never marked, the row does not show them). Null when a word hits nothing.
 */
export function matchPluginText(p: PluginSummary, query: string): PluginMatch | null {
  const i = p.interface;
  return matchFields(query, [
    { text: displayName(p), weight: 1 },
    { text: subtitle(p), weight: 0.8 },
    ...[p.name, i.developer, i.category, p.marketplace].filter((s): s is string => s !== undefined).map((text) => ({ text, weight: 0.6 })),
  ]);
}

export interface Shown {
  readonly plugin: PluginSummary;
  readonly match: PluginMatch;
}

/**
 * The plugins the filters keep, with where the query hit each, in the catalog's order or by name; with a
 * query, catalog order becomes best match first.
 */
export function filterPlugins(plugins: ReadonlyArray<PluginSummary>, facets: ReadonlyArray<Facet<PluginSummary>>, f: Filters): ReadonlyArray<Shown> {
  const kept = plugins.flatMap((plugin) => {
    if (!passes(facets, f.picked, plugin)) return [];
    const match = matchPluginText(plugin, f.query);
    return match ? [{ plugin, match }] : [];
  });
  if (f.sort === "name") return [...kept].sort((a, b) => displayName(a.plugin).localeCompare(displayName(b.plugin), undefined, { sensitivity: "base" }));
  if (queryWords(f.query).length > 0) return [...kept].sort((a, b) => b.match.score - a.match.score);
  return kept;
}
