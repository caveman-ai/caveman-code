// Browse's list: where plugins come from. Caveman's catalog and the team's are one source each however many
// marketplaces back them; every other marketplace (one you added, your own, the open repository's) is its own.
import type { MarketplaceInfo, PluginSummary } from "./api.ts";

/** CAVEMAN, TEAM, or a marketplace's name. */
export type BrowseSource = string;

// A marketplace's name is [a-z0-9._-], so these can never be one: a marketplace you added named "caveman" is its own.
export const CAVEMAN = "@caveman";
export const TEAM = "@team";

/** The source a plugin's marketplace belongs to. */
export function sourceOf(
  marketplace: string,
  markets: ReadonlyArray<MarketplaceInfo>,
): BrowseSource {
  const kind = markets.find((m) => m.name === marketplace)?.kind;
  return kind === "caveman" ? CAVEMAN : kind === "team" ? TEAM : marketplace;
}

/** Where Browse shows a source. Caveman's has its own too: on a phone, /plugins/browse is the list alone. */
export const sourcePath = (source: BrowseSource) => `/plugins/browse/${encodeURIComponent(source)}`;

/** The plugins one source lists. */
export function sourcePlugins(
  source: BrowseSource,
  plugins: ReadonlyArray<PluginSummary>,
  markets: ReadonlyArray<MarketplaceInfo>,
): ReadonlyArray<PluginSummary> {
  return plugins.filter((p) => sourceOf(p.marketplace, markets) === source);
}

export function sourceTitle(source: BrowseSource, markets: ReadonlyArray<MarketplaceInfo>): string {
  if (source === CAVEMAN) return "Caveman";
  if (source === TEAM) return "Your team";
  return markets.find((m) => m.name === source)?.display_name ?? source;
}

export interface SourceRow {
  readonly source: BrowseSource;
  readonly title: string;
  readonly line: string;
  readonly market?: MarketplaceInfo | undefined;
  readonly tone?: "warn" | undefined;
}

const plural = (n: number) => (n === 1 ? "1 plugin" : `${n} plugins`);

/**
 * Caveman first, then the team's (signed in), then the open repository's, then the marketplaces you added or made,
 * in the order they were added. A marketplace still being copied, or one that failed, says so on its line.
 */
export function browseSources(
  plugins: ReadonlyArray<PluginSummary>,
  markets: ReadonlyArray<MarketplaceInfo>,
  signedIn: boolean,
): ReadonlyArray<SourceRow> {
  const count = (source: BrowseSource) => sourcePlugins(source, plugins, markets).length;
  const own = markets.filter((m) => m.kind !== "caveman" && m.kind !== "team");
  const rank = (m: MarketplaceInfo) => (m.kind === "repo" ? 0 : m.kind === "personal" ? 2 : 1);
  return [
    { source: CAVEMAN, title: "Caveman", line: plural(count(CAVEMAN)) },
    ...(signedIn
      ? [
          {
            source: TEAM,
            title: "Your team",
            line: count(TEAM) === 0 ? "Nothing shared yet" : plural(count(TEAM)),
          },
        ]
      : []),
    ...[...own]
      .sort((a, b) => rank(a) - rank(b))
      .filter((m) => m.kind !== "personal" || count(m.name) > 0)
      .map((m): SourceRow => {
        const problem = m.status === "failed" ? (m.problems[0] ?? "Couldn't be read") : undefined;
        const line =
          m.status === "checking_out"
            ? "Copying…"
            : (problem ??
              (m.kind === "repo"
                ? `Suggested here · ${plural(count(m.name))}`
                : plural(count(m.name))));
        return {
          source: m.name,
          title: m.kind === "personal" ? "Made by you" : m.display_name,
          line,
          market: m,
          tone: problem ? "warn" : undefined,
        };
      }),
  ];
}
