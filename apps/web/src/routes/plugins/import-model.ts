// The import checklist as data. import.scan answers per setup (Claude Code, Codex, Cursor); people think per kind of
// thing (my MCP servers, my plugins), so the checklist is per kind, one row per thing however many setups list it.
// In each kind: what can come in (ticked), a count of what is already here, and what can't, with why, folded away.
import type { ImportItem, ImportSource } from "./api.ts";

export type ImportFrom = ImportItem["from"];
export type ImportKind = ImportItem["kind"];

export const SETUP: Record<ImportFrom, string> = {
  claude: "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
};

export const KIND_TITLE: Record<ImportKind, string> = {
  mcp_server: "MCP servers",
  plugin: "Plugins",
  skill: "Skills",
  marketplace: "Marketplaces",
  instructions: "Rules",
};
/** MCP servers first: the thing people bring most and miss most. Marketplaces after plugins: a plugin brings its own. */
const KIND_ORDER: ReadonlyArray<ImportKind> = [
  "mcp_server",
  "plugin",
  "skill",
  "marketplace",
  "instructions",
];

export interface ImportRow {
  /** The item import.apply takes for it (its first setup's). */
  readonly item: ImportItem;
  readonly key: string;
  /** Every setup that lists it, first the one it comes in from. */
  readonly from: ReadonlyArray<ImportFrom>;
  readonly state: "pick" | "here" | "cant";
  /** Why it can't come in, without its own name in front. */
  readonly reason?: string | undefined;
  /** What it will ask for once in: its keys, or a sign-in. */
  readonly hint?: string | undefined;
}

export interface ImportGroup {
  readonly kind: ImportKind;
  readonly title: string;
  readonly pick: ReadonlyArray<ImportRow>;
  readonly here: ReadonlyArray<ImportRow>;
  readonly cant: ReadonlyArray<ImportRow>;
}

export const keyOf = (i: Pick<ImportItem, "from" | "kind" | "name">) =>
  `${i.from}\u0000${i.kind}\u0000${i.name}`;
export const refOf = (i: Pick<ImportItem, "from" | "kind" | "name">) => ({
  from: i.from,
  kind: i.kind,
  name: i.name,
});

/** A reason as the runtime words it may start with the name ("pg: …"); the row already shows the name. */
const bare = (name: string, reason: string | undefined) =>
  reason?.startsWith(`${name}: `) ? reason.slice(name.length + 2) : reason;

/** What an MCP server will ask for after import: keys to paste, or a sign-in for a URL that has none. */
function hintOf(item: ImportItem): string | undefined {
  if (item.kind !== "mcp_server") return undefined;
  const keys = item.credentials?.length ?? 0;
  if (keys > 0) return keys === 1 ? "Needs a key" : `Needs ${keys} keys`;
  return /^https?:\/\//.test(item.detail) ? "Signs in" : undefined;
}

export function importGroups(sources: ReadonlyArray<ImportSource>): ReadonlyArray<ImportGroup> {
  const items = sources.flatMap((s) => s.items);
  // A server another setup lists the same way joins that setup's row, named as that setup spells it.
  const joins = (item: ImportItem) =>
    item.same_as === undefined
      ? undefined
      : keyOf({ from: item.same_as.from, kind: item.kind, name: item.same_as.name });
  const alsoIn = new Map<string, ImportFrom[]>();
  for (const item of items) {
    const key = joins(item);
    if (key !== undefined) alsoIn.set(key, [...(alsoIn.get(key) ?? []), item.from]);
  }
  const rows = items
    .filter(
      (item) => item.same_as === undefined || !items.some((other) => keyOf(other) === joins(item)),
    )
    .map((item): ImportRow => {
      const key = keyOf(item);
      const state = item.action === "skip" ? "cant" : item.action === "available" ? "here" : "pick";
      return {
        item,
        key,
        from: [item.from, ...(alsoIn.get(key) ?? [])],
        state,
        reason:
          state === "cant" ? (bare(item.name, item.reason) ?? "it cannot be imported") : undefined,
        hint: state === "pick" ? hintOf(item) : undefined,
      };
    });
  return KIND_ORDER.map((kind) => {
    const of = rows.filter((r) => r.item.kind === kind);
    return {
      kind,
      title: KIND_TITLE[kind],
      pick: of.filter((r) => r.state === "pick"),
      here: of.filter((r) => r.state === "here"),
      cant: of.filter((r) => r.state === "cant"),
    };
  }).filter((g) => g.pick.length + g.here.length + g.cant.length > 0);
}

/** What import starts ticked: everything that can come in. */
export const initiallyPicked = (groups: ReadonlyArray<ImportGroup>): ReadonlySet<string> =>
  new Set(groups.flatMap((g) => g.pick.map((r) => r.key)));

/** How many things can come in, for the way in ("Import 14 from Claude Code and Codex"). */
export const importableCount = (sources: ReadonlyArray<ImportSource>): number =>
  importGroups(sources).reduce((n, g) => n + g.pick.length, 0);

/** "Claude Code and Codex": the setups that have something to bring. */
export function setupsWithSomething(sources: ReadonlyArray<ImportSource>): string {
  const names = importGroups(sources)
    .flatMap((g) => g.pick.flatMap((r) => r.from))
    .filter((f, i, all) => all.indexOf(f) === i)
    .sort((a, b) => Object.keys(SETUP).indexOf(a) - Object.keys(SETUP).indexOf(b))
    .map((f) => SETUP[f]);
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** import.apply clones marketplaces; a setup with many of them takes minutes, so the call is given this long. */
export const IMPORT_TIMEOUT_MS = 30 * 60_000;
