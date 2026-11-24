/**
 * Marketplaces and installs, the parts that need no service: where the
 * Caveman catalog ships, what `marketplace.add` accepts, what a repository
 * declares (.claude/settings.json), which plugins are on for a session (the
 * effective set), and moving Settings from spaces to marketplaces.
 *
 * Effective set for a session in repository R of project P:
 * `required(team) ∪ required(P) ∪ ((default(team) ∪ default(P) ∪ mine ∪
 * repo-declared) − my turned-off)`. Required cannot be turned off.
 *
 * @module plugins/marketplaces
 */
import { existsSync, realpathSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { PluginInstall, PluginMarketplace, PluginSettings } from "@caveman-app/protocol";

import { spaceIdFor, spaceNameFor } from "./spaces.ts";

/**
 * The Caveman catalog's marketplace name (catalog/.agents/plugins/marketplace.json).
 * Not `caveman`: the open-source caveman marketplace Claude Code users add is named that.
 */
export const CATALOG_NAME = "caveman-curated";
/** What the catalog was called before (2026-10-17): ids `*@caveman` written then move to CATALOG_NAME. */
export const OLD_CATALOG_NAME = "caveman";

/**
 * The catalog shipped with the app: `catalog/` beside the runtime bundle
 * (scripts/bundle.ts copies it), or the repository's top-level `catalog/` when
 * running from source. CAVEMAN_CATALOG_DIR overrides both (tests).
 */
export function catalogDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.CAVEMAN_CATALOG_DIR !== undefined) return env.CAVEMAN_CATALOG_DIR === "" ? undefined : env.CAVEMAN_CATALOG_DIR;
  const here = path.dirname(fileURLToPath(import.meta.url));
  return [path.join(here, "catalog"), path.resolve(here, "../../../../catalog")].find((dir) => existsSync(dir));
}

export type MarketplaceSource =
  | { readonly kind: "git"; readonly url: string; readonly ref?: string }
  | { readonly kind: "folder"; readonly path: string };

/**
 * What `marketplace.add` takes: `owner/name[@ref]` on GitHub, a git URL with
 * `#ref` or a trailing `@ref`, or an absolute folder path.
 */
export function parseMarketplaceSource(input: string): MarketplaceSource {
  const text = input.trim();
  if (path.isAbsolute(text)) {
    // A path with a ref is a repository on disk to pin, not a folder to read in place.
    const hash = text.indexOf("#");
    return hash > 0 ? { kind: "git", url: path.resolve(text.slice(0, hash)), ref: text.slice(hash + 1) } : { kind: "folder", path: path.resolve(text) };
  }
  const github = /^([\w.-]+\/[\w.-]+?)(?:\.git)?(?:@([^\s@]+))?$/.exec(text);
  if (github !== null) return { kind: "git", url: `https://github.com/${github[1]}.git`, ...(github[2] === undefined ? {} : { ref: github[2] }) };
  const hash = text.indexOf("#");
  if (hash > 0) return { kind: "git", url: text.slice(0, hash), ref: text.slice(hash + 1) };
  // https://host/o/r.git@v1, but never the user@ of an ssh URL.
  const at = /^(.*[/:][^/@]+)@([^/@\s]+)$/.exec(text);
  if (at !== null && /^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { kind: "git", url: at[1]!, ref: at[2]! };
  return { kind: "git", url: text };
}

/** A repository key as Caveman Cloud keeps it: `host/owner/name`, all lower-case (Cloud's asciiLower). */
export const repoKeyOf = (link: { readonly host: string; readonly full_name: string } | undefined) =>
  link === undefined ? undefined : `${link.host}/${link.full_name}`.toLowerCase();

/** `owner/name`, `host/owner/name` or a git URL as a repository key (lower-case); undefined when it is none of them. */
export function repoKeyFrom(input: string): string | undefined {
  const text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) return `github.com/${text}`.toLowerCase();
  if (/^[\w.-]+\.[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(text)) return text.toLowerCase();
  const scp = /^[^@/\s]+@([^:/\s]+):([\w.-]+\/[\w.-]+)$/.exec(text);
  if (scp !== null) return `${scp[1]}/${scp[2]}`.toLowerCase();
  try {
    const url = new URL(text);
    const parts = url.pathname.split("/").filter(Boolean);
    return parts.length === 2 ? `${url.hostname}/${parts.join("/")}`.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/** Two git URLs for the same repository: scheme, host and path compared without case, `.git` or a trailing slash. */
export const sameRepoUrl = (a: string, b: string) => {
  const norm = (url: string) => url.trim().replace(/\/+$/, "").replace(/\.git$/, "").toLowerCase();
  return norm(a) === norm(b);
};

// ------------------------------------------------------------ repository declarations

export interface RepoDeclared {
  /** extraKnownMarketplaces: offered, added only on the person's click. */
  readonly marketplaces: ReadonlyArray<{ readonly name: string; readonly source: MarketplaceSource }>;
  /** enabledPlugins set true: on for everyone working in the repository, once their marketplace is known. */
  readonly enabled: ReadonlyArray<string>;
}

/** What the repository's `.claude/settings.json` declares (Claude Code's format). Unreadable: nothing. */
export async function readRepoDeclared(root: string): Promise<RepoDeclared> {
  let json: Record<string, unknown>;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
    const file = path.join(realRoot, ".claude", "settings.json");
    const real = await fs.realpath(file);
    if (!real.startsWith(`${realRoot}${path.sep}`)) return { marketplaces: [], enabled: [] };
    json = JSON.parse(await fs.readFile(real, "utf8")) as Record<string, unknown>;
  } catch {
    return { marketplaces: [], enabled: [] };
  }
  const known = typeof json.extraKnownMarketplaces === "object" && json.extraKnownMarketplaces !== null ? (json.extraKnownMarketplaces as Record<string, unknown>) : {};
  const marketplaces = Object.entries(known).flatMap(([name, value]): Array<RepoDeclared["marketplaces"][number]> => {
    const source = (value as { source?: Record<string, unknown> } | undefined)?.source;
    const text = (key: string) => (typeof source?.[key] === "string" ? (source[key] as string) : undefined);
    switch (source?.source) {
      case "github":
        return text("repo") === undefined ? [] : [{ name, source: { kind: "git" as const, url: `https://github.com/${text("repo")}.git`, ...(text("ref") ? { ref: text("ref")! } : {}) } }];
      case "git":
      case "url":
        return text("url") === undefined ? [] : [{ name, source: { kind: "git" as const, url: text("url")!, ...(text("ref") ? { ref: text("ref")! } : {}) } }];
      case "directory": {
        // A folder path in a shared file would point into each reader's own disk: inside the repository only, links resolved.
        const rel = text("path");
        if (rel === undefined || path.isAbsolute(rel)) return [];
        const dir = insideReal(realRoot, path.resolve(realRoot, rel));
        return dir === undefined ? [] : [{ name, source: { kind: "folder" as const, path: dir } }];
      }
      default:
        return [];
    }
  });
  const enabledPlugins = typeof json.enabledPlugins === "object" && json.enabledPlugins !== null ? (json.enabledPlugins as Record<string, unknown>) : {};
  return { marketplaces, enabled: Object.entries(enabledPlugins).flatMap(([id, on]) => (on === true && id.includes("@") ? [id] : [])) };
}

/** `dir`'s real path when it exists and lies inside `realRoot` (a link out of it does not count); otherwise undefined. */
function insideReal(realRoot: string, dir: string): string | undefined {
  try {
    const real = realpathSync(dir);
    return real.startsWith(`${realRoot}${path.sep}`) ? real : undefined;
  } catch {
    return undefined;
  }
}

// ------------------------------------------------------------ effective set

export type InstallScope = "me" | "project" | "team" | "repo";
export type InstallPolicy = "available" | "default" | "required";

/** One install from any scope, as the effective set reads it. */
export interface InstallRecord {
  readonly id: string;
  readonly scope: InstallScope;
  /** Project and team installs; `default` otherwise. */
  readonly policy: InstallPolicy;
  readonly projectId?: string | undefined;
  /** A remote entry: its repository and folder, and the commit it was pinned to. */
  readonly source?: { readonly url: string; readonly path?: string | undefined } | undefined;
  readonly commit?: string | undefined;
  readonly version?: string | undefined;
  /** A shared (org-held) connection for its servers. */
  readonly shared?: boolean | undefined;
  /** Mine only: turned off in installed[]. */
  readonly enabled?: boolean | undefined;
  /** The open repository suggests it and the person has not turned it on there: offered only. */
  readonly suggested?: boolean | undefined;
}

export interface EffectiveInstall {
  readonly id: string;
  /** The widest scope it is installed at: team, then project, then me, then repo. */
  readonly scope: InstallScope;
  readonly policy: InstallPolicy;
  readonly required: boolean;
  /** Reaches sessions now. */
  readonly on: boolean;
  /** On before the open project's own switch: what every other project gets. Differs from `on` only where the project said otherwise. */
  readonly everywhere: boolean;
  /** Installed for me, my project or my team (not only offered as available). */
  readonly installed: boolean;
  /**
   * The record whose files load: a Required one that pins a commit, else my
   * own, else the widest scope (one that pins first). Only installing records
   * count: an Available offer never chooses what loads.
   */
  readonly record: InstallRecord;
  /** A team or project install connects one shared account for its servers. */
  readonly shared: boolean;
  /** Offered by the open repository, not turned on there yet. */
  readonly suggested: boolean;
}

const WIDTH: Record<InstallScope, number> = { team: 3, project: 2, me: 1, repo: 0 };

/**
 * The effective set: every record by id, with whether it is on and why it cannot be turned off. `here` is the open
 * project's own switches (Settings repoSwitches for its repository): each wins over the everywhere one, never over
 * a Required install.
 */
export function effectiveInstalls(records: ReadonlyArray<InstallRecord>, disabled: ReadonlyArray<string>, here: ReadonlyMap<string, boolean> = new Map()): Map<string, EffectiveInstall> {
  const off = new Set(disabled);
  const byId = new Map<string, InstallRecord[]>();
  for (const record of records) byId.set(record.id, [...(byId.get(record.id) ?? []), record]);
  const out = new Map<string, EffectiveInstall>();
  for (const [id, list] of byId) {
    const required = list.some((r) => (r.scope === "team" || r.scope === "project") && r.policy === "required");
    // available only offers it; a default, a required, mine or the repository's installs it.
    const installing = list.filter((r) => r.policy !== "available");
    const mine = list.find((r) => r.scope === "me");
    const everywhere = required || (installing.length > 0 && !off.has(id) && !(installing.length === 1 && mine !== undefined && mine.enabled === false));
    const on = required || (installing.length > 0 && (here.get(id) ?? everywhere));
    const pinned = installing.find((r) => (r.scope === "team" || r.scope === "project") && r.policy === "required" && r.commit !== undefined);
    const ranked = [...(installing.length > 0 ? installing : list)].sort((a, b) => WIDTH[b.scope] - WIDTH[a.scope] || Number(b.commit !== undefined) - Number(a.commit !== undefined));
    const record = pinned ?? (mine !== undefined && installing.includes(mine) ? mine : ranked[0]!);
    const widest = ranked[0]!;
    out.set(id, {
      id,
      scope: widest.scope,
      policy: required ? "required" : widest.policy,
      required,
      on,
      everywhere,
      installed: installing.length > 0,
      record,
      shared: installing.some((r) => r.shared === true),
      suggested: installing.length === 0 && list.some((r) => r.suggested === true),
    });
  }
  return out;
}

/**
 * My installs, the local projects' that cover `repoKey`, and what the
 * repository suggests (`suggested`: its enabledPlugins, its own marketplace's
 * installed-by-default entries) as records. A suggestion is on only once the
 * person turned it on for this repository (`accepted`, Settings repoEnabled
 * for `repoKey`); until then it is offered.
 */
export function localRecords(
  settings: Pick<PluginSettings, "installed" | "projects" | "repoEnabled">,
  repoKey: string | undefined,
  suggested: ReadonlyArray<string>,
): InstallRecord[] {
  const mine = settings.installed.map((i): InstallRecord => ({ ...installFields(i), scope: "me", policy: "default", enabled: i.enabled }));
  const key = repoKey?.toLowerCase();
  const projects =
    key === undefined
      ? []
      : settings.projects
          .filter((p) => p.repos.some((r) => r.toLowerCase() === key))
          .flatMap((p) => p.installed.map((i): InstallRecord => ({ ...installFields(i), scope: "project", policy: i.policy, projectId: p.id })));
  const accepted = new Set(settings.repoEnabled.filter((r) => r.repository === repoKey).map((r) => r.id));
  const repo = [...new Set(suggested)].map((id): InstallRecord => (accepted.has(id) ? { id, scope: "repo", policy: "default" } : { id, scope: "repo", policy: "available", suggested: true }));
  return [...mine, ...projects, ...repo];
}

const installFields = (i: PluginInstall) => ({
  id: i.id,
  ...(i.source === undefined ? {} : { source: { url: i.source.url, ...(i.source.path === undefined ? {} : { path: i.source.path }) } }),
  ...(i.commit === undefined ? {} : { commit: i.commit }),
  ...(i.version === undefined ? {} : { version: i.version }),
});

// ------------------------------------------------------------ Cloud's answer

/** GET /api/v1/code/runtime/plugins?repository=, as Caveman Cloud answers it (lane K, design §7). */
export interface CloudPlugins {
  readonly marketplaces: ReadonlyArray<{ readonly name: string; readonly repo: string; readonly ref?: string; readonly commit: string }>;
  readonly installs: ReadonlyArray<{
    readonly scope: "team" | "project";
    readonly project_id?: string | null;
    readonly plugin_id: string;
    readonly marketplace?: string;
    readonly source?: unknown;
    readonly commit?: string | null;
    readonly version?: string | null;
    readonly policy: InstallPolicy;
    readonly connection?: "personal" | "shared";
  }>;
  readonly project?: { readonly id: string; readonly name: string; readonly repos: ReadonlyArray<string> } | undefined;
}

/**
 * A Cloud repo (`owner/name`, `host/owner/name` or an https URL) as an https
 * git URL, the form org Spaces were added in (no `.git`). Anything else
 * (ssh, a path) is undefined: Cloud never makes a runtime fetch from there.
 */
export const cloudRepoUrl = (repo: string): string | undefined =>
  /^https:\/\/[^\s@]+$/.test(repo) ? repo : /^[\w.-]+\/[\w.-]+$/.test(repo) ? `https://github.com/${repo}` : /^[\w.-]+\.[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(repo) ? `https://${repo}` : undefined;

/** A full commit hash: SHA-1, or SHA-256 for a repository that uses it. */
export const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * Cloud's team and project installs as records. Their `source` only says
 * which repository the commit belongs to: the files always come from where
 * the plugin's marketplace says (registry filesOf takes the commit only when
 * this URL is the entry's own), so an install can never point a teammate at
 * other code or another folder.
 */
export function cloudRecords(cloud: CloudPlugins | undefined): InstallRecord[] {
  // A Cloud before its catalog rename (migration 0400) still says `x@caveman`: the catalog's, unless the org
  // added a marketplace of that name. Remove once every Cloud this app talks to runs 0400 (hosted and the
  // customer installs on its release); the app release after that drops this alias.
  const oldCatalog = !(cloud?.marketplaces ?? []).some((m) => m.name === OLD_CATALOG_NAME);
  const oldId = new RegExp(`@${OLD_CATALOG_NAME}$`);
  return (cloud?.installs ?? []).flatMap((i): InstallRecord[] => {
    if (typeof i.plugin_id !== "string" || !i.plugin_id.includes("@")) return [];
    const source = typeof i.source === "object" && i.source !== null ? (i.source as { url?: unknown }) : {};
    return [
      {
        id: oldCatalog ? i.plugin_id.replace(oldId, `@${CATALOG_NAME}`) : i.plugin_id,
        scope: i.scope === "project" ? "project" : "team",
        policy: i.policy === "required" || i.policy === "available" ? i.policy : "default",
        ...(typeof i.project_id === "string" ? { projectId: i.project_id } : {}),
        ...(typeof source.url === "string" ? { source: { url: source.url } } : {}),
        ...(typeof i.commit === "string" && COMMIT.test(i.commit) ? { commit: i.commit } : {}),
        ...(typeof i.version === "string" ? { version: i.version } : {}),
        ...(i.connection === "shared" ? { shared: true } : {}),
      },
    ];
  });
}

// ------------------------------------------------------------ migration from spaces

/** What one space's checkout holds, for its migration. */
export interface SpaceContents {
  /** marketplace.json `name`; undefined for a repository that is one plugin. */
  readonly marketplace: string | undefined;
  readonly plugins: ReadonlyArray<string>;
}

/**
 * Settings.plugins with each space it can read moved to `marketplaces` and
 * its enabled plugins to `installed`: ids `<plugin>@<spaceId>` become
 * `<plugin>@<marketplace>` in installed, disabled and trusted. A space whose
 * contents are unknown (its checkout is not there yet) stays for the next try.
 * Credential grants are keyed by the repository URL, which does not change.
 */
export function migrateSpaces(
  plugins: PluginSettings,
  contents: (space: PluginSettings["spaces"][number]) => SpaceContents | undefined,
  now = new Date().toISOString(),
): Pick<PluginSettings, "marketplaces" | "installed" | "spaces" | "disabled" | "trusted"> {
  const marketplaces = [...plugins.marketplaces];
  const installed = [...plugins.installed];
  const left: Array<PluginSettings["spaces"][number]> = [];
  const rename = new Map<string, string>();
  const taken = new Set([CATALOG_NAME, "personal", "profile", ...marketplaces.map((m) => m.name)]);
  for (const space of plugins.spaces) {
    const read = contents(space);
    if (read === undefined) {
      left.push(space);
      continue;
    }
    const spaceId = spaceIdFor(space.url);
    const already = marketplaces.find((m) => m.source.kind === "git" && m.source.url === space.url);
    let name = already?.name ?? read.marketplace ?? spaceNameFor(space.url);
    if (already === undefined) {
      if (taken.has(name)) name = spaceId;
      taken.add(name);
      const market: PluginMarketplace = {
        name,
        source: { kind: "git", url: space.url, ...(space.ref === undefined ? {} : { ref: space.ref }), commit: space.commit },
        added_at: now,
        ...(space.granted === undefined ? {} : { granted: space.granted }),
      };
      marketplaces.push(market);
    }
    for (const plugin of read.plugins) {
      const from = `${plugin}@${spaceId}`;
      const to = `${plugin}@${name}`;
      rename.set(from, to);
      if (space.enabled && !plugins.disabled.includes(from) && !installed.some((i) => i.id === to)) installed.push({ id: to, enabled: true });
    }
  }
  const renamed = (ids: ReadonlyArray<string>) => [...new Set(ids.map((id) => rename.get(id) ?? id))];
  return {
    marketplaces,
    installed,
    spaces: left,
    // A space plugin I turned off is simply not installed now.
    disabled: plugins.disabled.filter((id) => !rename.has(id)),
    trusted: renamed(plugins.trusted),
  };
}

/**
 * Personal servers Connect added before plugins become installs of the
 * catalog plugin that serves the same URL (`urls`: the catalog plugin's id to
 * its server URLs). Anything else stays a personal server.
 */
export function migrateConnectors(
  plugins: Pick<PluginSettings, "servers" | "installed">,
  map: Readonly<Record<string, string>>,
  urls: ReadonlyMap<string, ReadonlyArray<string>>,
): Pick<PluginSettings, "servers" | "installed"> | undefined {
  const moved = plugins.servers.filter((s) => s.source === "connector" && s.url !== undefined && map[s.name] !== undefined && (urls.get(map[s.name]!) ?? []).includes(s.url));
  if (moved.length === 0) return undefined;
  const installed = [...plugins.installed];
  for (const server of moved) {
    const id = map[server.name]!;
    if (!installed.some((i) => i.id === id)) installed.push({ id, enabled: server.enabled });
  }
  return { servers: plugins.servers.filter((s) => !moved.includes(s)), installed };
}

/**
 * Ids written while the catalog was named `caveman` (OLD_CATALOG_NAME), moved
 * to CATALOG_NAME in every list that names a plugin. Undefined when nothing
 * moves, or when the person added a marketplace of that name themselves (its
 * ids are theirs).
 */
export function migrateCatalogName(
  plugins: Pick<PluginSettings, "marketplaces" | "installed" | "projects" | "disabled" | "trusted" | "repoEnabled" | "repoSwitches">,
): Pick<PluginSettings, "installed" | "projects" | "disabled" | "trusted" | "repoEnabled" | "repoSwitches"> | undefined {
  if (plugins.marketplaces.some((m) => m.name === OLD_CATALOG_NAME)) return undefined;
  const old = new RegExp(`@${OLD_CATALOG_NAME}(?=$|#)`);
  const move = (id: string) => id.replace(old, `@${CATALOG_NAME}`);
  const moved = <T extends { readonly id: string }>(list: ReadonlyArray<T>) => list.map((i) => ({ ...i, id: move(i.id) }));
  const next = {
    installed: moved(plugins.installed),
    projects: plugins.projects.map((p) => ({ ...p, installed: moved(p.installed) })),
    disabled: plugins.disabled.map(move),
    trusted: plugins.trusted.map(move),
    repoEnabled: moved(plugins.repoEnabled),
    repoSwitches: moved(plugins.repoSwitches),
  };
  return JSON.stringify(next) === JSON.stringify({ installed: plugins.installed, projects: plugins.projects, disabled: plugins.disabled, trusted: plugins.trusted, repoEnabled: plugins.repoEnabled, repoSwitches: plugins.repoSwitches })
    ? undefined
    : next;
}

// ------------------------------------------------------------ composer @plugin

/** Plugin ids a message mentions (`[@Slack](plugin://slack@caveman)`, a skill as `[@slack:x](plugin://slack@caveman)`), first mention first. */
export const pluginMentions = (text: string): string[] => [...new Set([...text.matchAll(/\]\(plugin:\/\/([A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9._-]*)\)/g)].map((m) => m[1]!))];

const MAX_CAPABILITY_BYTES = 4 * 1024;
const TRUNCATED = "\n- Additional plugin capabilities omitted to fit the context limit.";

/**
 * The hidden block a message mentioning a plugin adds, as Codex renders it
 * (codex-rs core/src/plugins/render.rs): its skills' prefix and its MCP
 * servers in this session, at most 4 KiB. Undefined when it brings neither.
 */
export function renderPluginCapabilities(plugin: { readonly displayName: string; readonly namespace: string; readonly hasSkills: boolean; readonly servers: ReadonlyArray<string> }): string | undefined {
  // A plugin names itself: no line breaks, backticks or control characters into the prompt, and 64 characters at most.
  const name = plugin.displayName.replace(/[\u0000-\u001f\u007f`]+/g, " ").trim().slice(0, 64);
  const lines = [`Capabilities from the \`${name}\` plugin:`];
  if (plugin.hasSkills) lines.push(`- Skills from this plugin are prefixed with \`${plugin.namespace}:\`.`);
  if (plugin.servers.length > 0) lines.push(`- MCP servers from this plugin available in this session: ${plugin.servers.map((s) => `\`${s}\``).join(", ")}.`);
  if (lines.length === 1) return undefined;
  lines.push("Use these plugin-associated capabilities to help solve the task.");
  const text = lines.join("\n");
  if (Buffer.byteLength(text, "utf8") <= MAX_CAPABILITY_BYTES) return text;
  let prefix = Buffer.from(text, "utf8").subarray(0, MAX_CAPABILITY_BYTES - TRUNCATED.length).toString("utf8");
  // A cut inside a character leaves U+FFFD; drop it.
  prefix = prefix.replace(/�+$/, "");
  return `${prefix}${TRUNCATED}`;
}
