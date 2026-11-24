// One other agent's own setup (Claude Code, Codex, Cursor) as data, from import.scan. Each agent keeps using what it
// has when it runs here; a row's switch gives that thing to every agent (the first time by bringing it in, after that
// by turning what came in on or off). Files an agent reads where they are (its skills, its rule files) are listed
// without a switch, and what cannot be given to the others says why. Pure, so the page and the tests agree.
import type { ImportItem, ImportSource, PluginSummary } from "./api.ts";
import { type ImportFrom, keyOf, refOf, SETUP } from "./import-model.ts";
import { pluginPath, type Server, serverPath } from "./installed.ts";
import { displayName } from "./model.ts";

export type AgentId = ImportFrom;
export const AGENT_NAME = SETUP;
/** What runs it here: "Claude Agent chats already use it". */
export const AGENT_CHATS: Record<AgentId, string> = {
  claude: "Claude Agent chats",
  codex: "Codex chats",
  cursor: "Cursor chats",
};

export const agentPath = (agent: AgentId) => `/plugins/agent/${agent}`;
export const isAgent = (id: string | undefined): id is AgentId =>
  id === "claude" || id === "codex" || id === "cursor";

export type AgentKind = "plugin" | "mcp_server" | "skill" | "instructions";
type Ref = ReturnType<typeof refOf>;

export interface AgentRow {
  readonly key: string;
  readonly kind: AgentKind;
  readonly name: string;
  readonly line: string;
  /**
   * off: its agent's alone, a switch away from every agent. on: every agent has it. own: a file its agent reads where
   * it is. cant: it cannot be given to the others; `reason` says why.
   */
  readonly state: "off" | "on" | "own" | "cant";
  readonly reason?: string | undefined;
  /** Turning it on the first time: what import.apply takes, a plugin's marketplace first. Empty once it is here. */
  readonly refs: ReadonlyArray<Ref>;
  /** What it is here once brought in: the switch turns this on and off, and the row opens it. */
  readonly here?:
    | { readonly kind: "plugin"; readonly id: string }
    | { readonly kind: "server"; readonly name: string }
    | undefined;
  readonly to?: string | undefined;
  /** What it will ask for once on: a key, or a sign-in. */
  readonly hint?: string | undefined;
  readonly plugin?: PluginSummary | undefined;
  readonly text: string;
}

export interface AgentSection {
  readonly kind: AgentKind;
  readonly title: string;
  readonly rows: ReadonlyArray<AgentRow>;
  readonly folded: boolean;
}

const TITLE: Record<AgentKind, string> = {
  plugin: "Plugins",
  mcp_server: "MCP servers",
  skill: "Skills",
  instructions: "Rules",
};
const ORDER: ReadonlyArray<AgentKind> = ["plugin", "mcp_server", "skill", "instructions"];

/** A name as two setups may spell it: letters and digits only, lower case. */
const plain = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
/** A reason as the runtime words it may start with the name ("pg: …"); the row already shows the name. */
const bare = (name: string, reason: string | undefined) =>
  (reason?.startsWith(`${name}: `) ? reason.slice(name.length + 2) : reason) ??
  "it cannot be shared";
const sentence = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;

/** What an MCP server will ask for once on: keys to paste, or a sign-in for a URL that has none. */
function hintOf(item: ImportItem): string | undefined {
  const keys = item.credentials?.length ?? 0;
  if (keys > 0) return keys === 1 ? "Needs a key" : `Needs ${keys} keys`;
  return /^https?:\/\//.test(item.detail) ? "Signs in" : undefined;
}

export interface Mine {
  readonly plugins: ReadonlyArray<PluginSummary> | null;
  readonly servers: ReadonlyArray<Server> | null;
}

/** The agents that have something of their own on this computer, in the order people know them. */
export function agentsWithSetup(sources: ReadonlyArray<ImportSource>): ReadonlyArray<AgentId> {
  return sources
    .filter((s) => s.found && s.items.some((i) => i.kind !== "marketplace"))
    .map((s) => s.from);
}

/**
 * One agent's setup: Plugins and MCP servers (each with its switch), then its skills and rule files, folded. Its
 * marketplaces are not rows: a plugin brings its own. Within a section: what every agent has first, then what only this
 * agent has, then what cannot be shared; by name.
 */
export function agentSections(
  agent: AgentId,
  sources: ReadonlyArray<ImportSource>,
  mine: Mine,
): ReadonlyArray<AgentSection> {
  const items = sources.find((s) => s.from === agent)?.items ?? [];
  const everywhere = new Map(sources.flatMap((s) => s.items).map((i) => [keyOf(i), i]));
  const markets = new Map(items.filter((i) => i.kind === "marketplace").map((i) => [i.name, i]));
  const server = (name: string) =>
    mine.servers?.find((s) => s.name.toLowerCase() === name.toLowerCase()) ??
    mine.servers?.find((s) => plain(s.name) === plain(name));
  const cant = (item: ImportItem, kind: AgentKind, line: string): AgentRow => ({
    key: keyOf(item),
    kind,
    name: item.name,
    line,
    state: "cant",
    reason: sentence(bare(item.name, item.reason)),
    refs: [],
    text: `${item.name} ${line}`.toLowerCase(),
  });

  const row = (item: ImportItem): AgentRow | undefined => {
    if (item.kind === "marketplace") return undefined;
    if (item.kind === "plugin") {
      const at = item.name.lastIndexOf("@");
      const known = mine.plugins?.find((p) => p.id === item.name);
      const name = known ? displayName(known) : at > 0 ? item.name.slice(0, at) : item.name;
      const line =
        known?.interface.short_description ??
        known?.description ??
        (at > 0 ? `From ${item.name.slice(at + 1)}` : "");
      const base = {
        key: keyOf(item),
        kind: "plugin" as const,
        name,
        line,
        plugin: known,
        text: `${name} ${item.name} ${line}`.toLowerCase(),
      };
      if (item.action === "skip") return { ...cant(item, "plugin", line), name, plugin: known };
      if (item.action === "available") {
        const here = known?.installed ? { kind: "plugin" as const, id: known.id } : undefined;
        return {
          ...base,
          state: !known?.installed || known.enabled ? "on" : "off",
          refs: [],
          here,
          to: here ? pluginPath(here.id) : undefined,
        };
      }
      const market = at > 0 ? markets.get(item.name.slice(at + 1)) : undefined;
      return {
        ...base,
        state: "off",
        refs: [...(market?.action === "add" ? [refOf(market)] : []), refOf(item)],
      };
    }
    if (item.kind === "mcp_server") {
      if (item.action === "skip") return cant(item, "mcp_server", item.detail);
      const base = {
        key: keyOf(item),
        kind: "mcp_server" as const,
        name: item.name,
        line: item.detail,
        text: `${item.name} ${item.detail}`.toLowerCase(),
      };
      // Another setup lists the same server: until it is here, that setup's row is what brings it in.
      const twin = item.same_as
        ? everywhere.get(
            keyOf({ from: item.same_as.from, kind: "mcp_server", name: item.same_as.name }),
          )
        : undefined;
      const bring = item.action === "import" ? item : twin?.action === "import" ? twin : undefined;
      if (bring) return { ...base, state: "off", refs: [refOf(bring)], hint: hintOf(bring) };
      const saved = server(twin?.name ?? item.name) ?? server(item.name);
      const here = saved ? { kind: "server" as const, name: saved.name } : undefined;
      return {
        ...base,
        state: saved && !saved.enabled ? "off" : "on",
        refs: [],
        here,
        to: here ? serverPath(here.name) : undefined,
      };
    }
    const kind = item.kind;
    if (item.action === "skip") return cant(item, kind, item.detail);
    const base = {
      key: keyOf(item),
      kind,
      name: item.name,
      line: item.detail,
      text: `${item.name} ${item.detail}`.toLowerCase(),
    };
    // A skill only this agent's folder holds can be copied to where every agent reads; one read in place has no switch.
    return item.action === "import"
      ? { ...base, state: "off", refs: [refOf(item)] }
      : { ...base, state: "own", refs: [] };
  };

  const rank = (r: AgentRow) =>
    r.state === "on" ? 0 : r.state === "off" ? 1 : r.state === "own" ? 1 : 2;
  const rows = items.flatMap((i) => row(i) ?? []);
  return ORDER.map((kind) => ({
    kind,
    title: TITLE[kind],
    rows: rows
      .filter((r) => r.kind === kind)
      .sort(
        (a, b) =>
          rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
      ),
    folded: kind === "skill" || kind === "instructions",
  })).filter((s) => s.rows.length > 0);
}

/** The rows a switch can turn on: its agent's alone for now. */
export const canTurnOn = (sections: ReadonlyArray<AgentSection>): ReadonlyArray<AgentRow> =>
  sections
    .flatMap((s) => s.rows)
    .filter((r) => r.state === "off" && (r.refs.length > 0 || r.here !== undefined));
/** The rows a switch can turn off: here, and on. */
export const canTurnOff = (sections: ReadonlyArray<AgentSection>): ReadonlyArray<AgentRow> =>
  sections.flatMap((s) => s.rows).filter((r) => r.state === "on" && r.here !== undefined);

/** What turning rows on asks of the runtime: one import.apply for what is not here yet, and a switch for what is. */
export function turnOnPlan(rows: ReadonlyArray<AgentRow>): {
  readonly bring: ReadonlyArray<Ref>;
  readonly enable: ReadonlyArray<NonNullable<AgentRow["here"]>>;
} {
  const seen = new Set<string>();
  const bring = rows
    .filter((r) => r.here === undefined)
    .flatMap((r) => r.refs)
    .filter((ref) => (seen.has(keyOf(ref)) ? false : (seen.add(keyOf(ref)), true)));
  return { bring, enable: rows.flatMap((r) => (r.here ? [r.here] : [])) };
}

/** The sections narrowed to rows matching every word of `query`; all of them when it is blank. */
export function filterSections(
  sections: ReadonlyArray<AgentSection>,
  query: string,
): ReadonlyArray<AgentSection> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return sections;
  return sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => words.every((w) => r.text.includes(w))) }))
    .filter((s) => s.rows.length > 0);
}
