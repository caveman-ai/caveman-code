// The Plugins page's own list as data: what every agent gets, as one line and one switch each. Plugins and the MCP
// servers you added come first; your skills and rules are files, folded under them. A plugin's own servers and skills
// are part of the plugin, so they are on its page, not here. With a project picked, the list is what that project's
// chats get, and each switch is the project's own. What waits on the person (a sign-in, a key, hooks to trust) keeps
// its place and is counted once, on one line above the list. Pure, so the page, the tests and the counts agree.
import type { Result } from "@caveman-app/session-protocol";
import type { PluginSummary, RuleInfo } from "./api.ts";
import { displayName, ENGINE_LABEL, pluginScope, signInTag, skillEngines } from "./model.ts";

export type Server = Result<"mcp.list">["servers"][number];
export type Skill = Result<"skill.list">["skills"][number];

export type RowKind = "plugin" | "server" | "skill" | "rule";

export interface Row {
  /** Unique in the list. */
  readonly key: string;
  readonly kind: RowKind;
  readonly to: string;
  readonly name: string;
  readonly line: string;
  /** warn: something to do (amber); off: turned off (the row reads quieter). */
  readonly tone?: "warn" | "off" | undefined;
  /** What it waits on the person for, if anything: the line above the list counts it. */
  readonly need?: NeedKind | undefined;
  /** The plugin it is: its logo marks the row, and its id is what the switch turns on and off. */
  readonly plugin?: PluginSummary | undefined;
  /** The switch at the row's end. A file (a skill, a rule) has none: the engines read it themselves. */
  readonly toggle?: { readonly on: boolean; readonly locked?: string | undefined } | undefined;
  /** Whose it is, where that isn't the list's own: the team's, what the repository suggests, or the open project's alone. */
  readonly tag?: string | undefined;
  /** Lower case: what a search matches. */
  readonly text: string;
}

export type GroupId = "plugins" | "servers" | "skills" | "rules";

/** A kind of task: sign in to servers, give servers their keys, connect plugins, trust hooks. */
export type NeedKind = "sign_in" | "keys" | "connect" | "hooks";

export interface Group {
  readonly id: GroupId;
  readonly title: string;
  readonly rows: ReadonlyArray<Row>;
  /** Files the engines read on their own (skills, rules): shut until asked for, so the list opens on what has a switch. */
  readonly folded: boolean;
}

const enc = encodeURIComponent;

export const pluginPath = (id: string) => `/plugins/p/${enc(id)}`;
export const serverPath = (name: string, pluginId?: string) =>
  `/plugins/mcp/${enc(name)}${pluginId ? `?plugin=${enc(pluginId)}` : ""}`;
export const skillPath = (path: string) => `/plugins/skill?path=${enc(path)}`;
export const rulePath = (path: string) => `/plugins/rule?path=${enc(path)}`;

/** Where a server of yours came from, in the row's words. */
export const SOURCE_WORD: Record<Server["source"], string> = {
  manual: "Added by you",
  claude: "From Claude Code",
  codex: "From Codex",
  cursor: "From Cursor",
  connector: "Connector",
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** A credential as people know it: the header it is sent as, else its variable's name. */
export const credentialLabel = (c: Server["credentials"][number]) => c.header ?? c.name;

/** The one thing a server of yours waits on, if any: a sign-in, or the keys not granted yet. */
export function serverNeed(
  s: Server,
): { readonly kind: "sign_in" | "keys"; readonly text: string } | undefined {
  if (!s.enabled) return undefined;
  if (
    s.auth === "oauth" &&
    s.status !== undefined &&
    s.status !== "connected" &&
    s.status !== "signing_in"
  )
    return { kind: "sign_in", text: signInTag({ status: s.status, problem: s.problem }).label };
  const missing = s.credentials.filter((c) => !c.granted).map(credentialLabel);
  if (missing.length > 0)
    return {
      kind: "keys",
      text: `Needs ${missing.length === 1 ? missing[0] : `${missing.length} keys`}`,
    };
  return undefined;
}

/** What a server of yours still needs, in words; undefined when nothing. */
export const serverNeeds = (s: Server): string | undefined => serverNeed(s)?.text;

function serverRow(s: Server, inProject: boolean): Row {
  const need = serverNeed(s);
  const tools = s.tools?.length ? plural(s.tools.length, "tool") : undefined;
  const line =
    need?.text ??
    (s.enabled && s.status === "signing_in"
      ? "Signing in…"
      : [SOURCE_WORD[s.source], tools].filter(Boolean).join(" · "));
  return {
    key: `server:${s.name}`,
    kind: "server",
    to: serverPath(s.name),
    name: s.name,
    line,
    tone: !s.enabled ? "off" : need ? "warn" : undefined,
    need: need?.kind,
    toggle: { on: s.enabled },
    tag: inProject && s.here === "on" ? ONLY_HERE : undefined,
    text: `${s.name} ${s.url ?? s.command ?? ""} ${line}`.toLowerCase(),
  };
}

/** A plugin's own wait: a sign-in it skipped or lost, or hooks it brings that wait for trust. */
export function pluginNeed(
  p: PluginSummary,
): { readonly kind: "connect" | "hooks"; readonly text: string } | undefined {
  if (!p.enabled) return undefined;
  if (p.needs_connect) return { kind: "connect", text: "Not connected" };
  if (p.hooks.length > 0 && p.trusted !== true)
    return {
      kind: "hooks",
      text: p.trust_dropped ? "Hooks changed: trust them again" : "Hooks wait for your trust",
    };
  return undefined;
}

/** On in the open project and no other: installed for it alone, or switched on there while off everywhere. */
const ONLY_HERE = "Only here";

function pluginRow(p: PluginSummary, inProject: boolean): Row {
  const need = pluginNeed(p);
  const line = need?.text ?? p.interface.short_description ?? p.description ?? p.marketplace;
  const offered = !p.installed && !p.required && p.suggested === true;
  return {
    key: `plugin:${p.id}`,
    kind: "plugin",
    to: pluginPath(p.id),
    name: displayName(p),
    line,
    tone: !p.enabled ? "off" : need ? "warn" : undefined,
    need: need?.kind,
    plugin: p,
    toggle: p.required ? { on: true, locked: "Your team requires it" } : { on: p.enabled },
    tag: p.required
      ? "Required"
      : offered
        ? "Suggested"
        : inProject && (pluginScope(p) === "project" || p.here === "on")
          ? ONLY_HERE
          : pluginScope(p) === "team"
            ? "Team"
            : undefined,
    text: `${displayName(p)} ${p.name} ${line}`.toLowerCase(),
  };
}

function skillRow(s: Skill): Row {
  const line = s.description || "Your skill";
  return {
    key: `skill:${s.path}`,
    kind: "skill",
    to: skillPath(s.path),
    name: s.name,
    line,
    text: `${s.name} ${s.description}`.toLowerCase(),
  };
}

function ruleRow(r: RuleInfo): Row {
  const readers = skillEngines(r.engines)
    .map((e) => ENGINE_LABEL[e])
    .join(", ");
  const line =
    r.engines.length === 0
      ? "Another file takes its place"
      : r.exists
        ? `Read by ${readers}`
        : `Not written yet · ${readers} would read it`;
  return {
    key: `rule:${r.path}`,
    kind: "rule",
    to: rulePath(r.path),
    name: r.name,
    line,
    tone: r.exists && r.engines.length > 0 ? undefined : "off",
    text: `${r.name} ${line}`.toLowerCase(),
  };
}

export interface InstalledInput {
  readonly servers: ReadonlyArray<Server> | null;
  /** plugin.list: the installed ones are kept, and with a project picked what its repository suggests. */
  readonly plugins: ReadonlyArray<PluginSummary> | null;
  readonly skills: ReadonlyArray<Skill> | null;
  readonly rules: ReadonlyArray<RuleInfo> | null;
  /** The project picked, by id: the list is what its chats get (the lists were read for its folder). Absent: what every project gets. */
  readonly project?: string | undefined;
}

const byName = (a: Row, b: Row) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
const onFirst = (a: Row, b: Row) =>
  Number(a.tone === "off") - Number(b.tone === "off") || byName(a, b);

/**
 * Plugins, MCP servers, Skills, Rules; empty groups are left out. Within a group: what is on before what is off, then
 * by name. Everywhere, it is what every project gets (yours and your team's). With a project, it is what that project's
 * chats get: every plugin installed (for everywhere or for it alone), what its repository suggests, and your MCP
 * servers, each on or off as that project has it; then the project's own skill and rule files.
 */
export function installedGroups(input: InstalledInput): ReadonlyArray<Group> {
  const here = input.project;
  const all = input.plugins ?? [];
  const inProject = here !== undefined;
  const plugins = all
    .filter((p) =>
      inProject
        ? p.installed || p.required || p.suggested === true
        : (p.installed || p.required) && pluginScope(p) !== "project",
    )
    .map((p) => pluginRow(p, inProject))
    .sort(onFirst);
  const servers = (input.servers ?? []).map((s) => serverRow(s, inProject)).sort(onFirst);
  const skills = (input.skills ?? [])
    .filter((s) =>
      here === undefined ? s.scope === "me" : s.scope === "project" && s.project_id === here,
    )
    .map(skillRow)
    .sort(byName);
  const rules = (input.rules ?? [])
    .filter((r) => (here === undefined ? r.scope === "me" : r.project_id === here))
    .map(ruleRow)
    .sort(onFirst);
  const groups: Array<Group> = [
    { id: "plugins", title: "Plugins", rows: plugins, folded: false },
    { id: "servers", title: "MCP servers", rows: servers, folded: false },
    { id: "skills", title: "Skills", rows: skills, folded: true },
    { id: "rules", title: "Rules", rows: rules, folded: true },
  ];
  return groups.filter((g) => g.rows.length > 0);
}

/** One kind of task: what it is, the things it is for, and its line. */
export interface Need {
  readonly kind: NeedKind;
  /** "Sign in to 9 servers"; for one thing, "Sign in to figma". */
  readonly title: string;
  readonly line: string;
  readonly rows: ReadonlyArray<Row>;
}

const NEED_ORDER: ReadonlyArray<NeedKind> = ["sign_in", "keys", "connect", "hooks"];

/** "figma, mobbin and 5 more": who a task is for, short enough for one line. */
const someNames = (rows: ReadonlyArray<Row>) =>
  rows.length <= 3
    ? rows.map((r) => r.name).join(", ")
    : `${rows
        .slice(0, 2)
        .map((r) => r.name)
        .join(", ")} and ${rows.length - 2} more`;

const NEED_TITLE: Record<NeedKind, (n: number, name: string) => string> = {
  sign_in: (n, name) => (n === 1 ? `Sign in to ${name}` : `Sign in to ${n} servers`),
  keys: (n, name) => (n === 1 ? `Add a key for ${name}` : `Add keys for ${n} servers`),
  connect: (n, name) => (n === 1 ? `Connect ${name}` : `Connect ${n} plugins`),
  hooks: (n, name) => (n === 1 ? `Trust ${name}'s hooks` : `Trust hooks from ${n} plugins`),
};

/**
 * What waits on the person, one task per kind: sign-ins first (a server that can't sign in does nothing), then keys,
 * plugins to connect, hooks to trust.
 */
export function needsOf(groups: ReadonlyArray<Group>): ReadonlyArray<Need> {
  const rows = groups.flatMap((g) => g.rows).filter((r) => r.need !== undefined);
  return NEED_ORDER.flatMap((kind): Need[] => {
    const of = rows.filter((r) => r.need === kind);
    return of.length === 0
      ? []
      : [{ kind, title: NEED_TITLE[kind](of.length, of[0]!.name), line: someNames(of), rows: of }];
  });
}

/** The rows that do nothing until set up (a sign-in, a key, a connection): what "Turn them off" turns off. Hooks aren't: their plugin works without them. */
export const blockedRows = (needs: ReadonlyArray<Need>): ReadonlyArray<Row> =>
  needs.filter((n) => n.kind !== "hooks").flatMap((n) => n.rows);

/** The one line above the list: "12 need a sign-in or a key · 6 have hooks to trust"; "" when nothing waits. */
export function needsLine(needs: ReadonlyArray<Need>): string {
  const blocked = blockedRows(needs).length;
  const hooks = needs.find((n) => n.kind === "hooks")?.rows.length ?? 0;
  const only = needs.length === 1 && needs[0]!.rows.length === 1 ? needs[0]! : undefined;
  if (only) return only.title;
  return [
    blocked > 0 ? `${blocked} ${blocked === 1 ? "needs" : "need"} a sign-in or a key` : null,
    hooks > 0 ? `${hooks} ${hooks === 1 ? "has" : "have"} hooks to trust` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The groups narrowed to rows matching every word of `query`; all of them when it is blank. */
export function filterGroups(groups: ReadonlyArray<Group>, query: string): ReadonlyArray<Group> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return groups;
  return groups
    .map((g) => ({ ...g, rows: g.rows.filter((r) => words.every((w) => r.text.includes(w))) }))
    .filter((g) => g.rows.length > 0);
}
