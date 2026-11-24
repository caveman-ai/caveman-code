/**
 * Reads plugins from disk into engine-neutral data. A marketplace root (a
 * pinned checkout, a folder, the Caveman catalog) holds either a
 * `marketplace.json` of plugins, or is itself one plugin. A plugin's manifest
 * is merged from the agent-plugins root `plugin.json`, `.codex-plugin/`,
 * `.claude-plugin/` and `.cursor-plugin/`, first wins per field, as Codex
 * reads them.
 *
 * Every read is confined to the plugin's root: a symlink that leads outside
 * it is refused, so a space cannot point a skill at `~/.ssh`.
 *
 * @module plugins/load
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { GRILL_MCP_SERVER } from "../grill/grill.ts";
import {
  CavemanSidecar,
  CONTAINED_HOOK_TYPES,
  type Contributes,
  decodeMcpFile,
  Hooks,
  HooksFile,
  type LspServer,
  LspServers,
  Marketplace,
  type MarketplaceEntry,
  type McpServerConfig,
  type Monitor,
  Monitors,
  PluginManifest,
  parseFrontmatter,
} from "./format.ts";

export interface PluginItem {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the markdown file. */
  readonly path: string;
  /** Hooks in its frontmatter, which Claude registers too; absent when it has none or they are left out. */
  readonly hooks?: Hooks;
}

export interface PluginRule {
  readonly name: string;
  readonly path: string;
  readonly text: string;
}

export interface LoadedPlugin {
  /** `<plugin>@<space>`, Claude Code's plugin@marketplace shape. */
  readonly id: string;
  readonly name: string;
  readonly space: string;
  /** Absolute, real path of the plugin directory. */
  readonly root: string;
  readonly version?: string | undefined;
  readonly description?: string | undefined;
  readonly skills: ReadonlyArray<PluginItem>;
  readonly commands: ReadonlyArray<PluginItem>;
  readonly agents: ReadonlyArray<PluginItem>;
  /** hooks.json and the manifest's hooks, for the whole session; an item's own are on the item (`allHooks`). */
  readonly hooks: Hooks;
  readonly mcpServers: Readonly<Record<string, McpServerConfig>>;
  /** `.lsp.json` plus the manifest's `lspServers`. */
  readonly lspServers: Readonly<Record<string, LspServer>>;
  /** The manifest's `monitors`, else `monitors/monitors.json`. */
  readonly monitors: ReadonlyArray<Monitor>;
  readonly rules: ReadonlyArray<PluginRule>;
  readonly contributes: Contributes;
  /** plugin.json merged with its marketplace entry. */
  readonly manifest: PluginManifest;
  /** How it presents itself (Codex `interface`, else Claude fields, else its marketplace entry); logos as data: URLs. */
  readonly interface: PluginPresentation;
  /** Parts of the plugin left out (hooks the runtime cannot contain), one line each. */
  readonly problems: ReadonlyArray<string>;
  /** The space's repo and commit, set by the registry. Credential grants bind to it. */
  readonly origin?: { readonly url: string; readonly commit: string } | undefined;
}

export interface LoadedSpace {
  readonly plugins: ReadonlyArray<LoadedPlugin>;
  /** One line per plugin or file that could not be loaded. */
  readonly problems: ReadonlyArray<string>;
}

export class PluginLoadError extends Error {}

/** Session Protocol `PluginInterface` plus the detail page's fields; nothing invented. */
export interface PluginPresentation {
  readonly display_name?: string;
  readonly short_description?: string;
  readonly long_description?: string;
  readonly developer?: string;
  readonly category?: string;
  readonly capabilities?: ReadonlyArray<string>;
  readonly logo?: string;
  readonly logo_dark?: string;
  readonly brand_color?: string;
  readonly brand_color_dark?: string;
  readonly default_prompts?: ReadonlyArray<string>;
  readonly website?: string;
  readonly privacy?: string;
  readonly terms?: string;
  readonly screenshots?: ReadonlyArray<string>;
}

/** Where a marketplace entry's plugin comes from. */
export type EntryOrigin =
  | { readonly kind: "local"; readonly dir: string }
  /** A git repository (`github`, `url`, `git-subdir`), optionally a folder in it; pinned to a commit at install. */
  | { readonly kind: "git"; readonly url: string; readonly ref?: string; readonly sha?: string; readonly path?: string }
  | { readonly kind: "unsupported"; readonly why: string };

/** One plugin a marketplace lists, before it is loaded. */
export interface MarketEntry {
  readonly name: string;
  readonly origin: EntryOrigin;
  /** The entry's other fields: they stand in for (and under) the plugin's manifest. */
  readonly fields: ManifestOverrides;
  /** Ours from Codex's policy: offered, on at install, or hidden. */
  readonly installation: "available" | "installed_by_default" | "not_available";
  readonly authentication: "on_install" | "on_use";
}

export interface ReadMarketplace {
  readonly name: string;
  readonly displayName?: string;
  readonly description?: string;
  /** In the file's order, which is the display order. */
  readonly entries: ReadonlyArray<MarketEntry>;
}

const decodeManifest = Schema.decodeUnknownSync(PluginManifest);
/**
 * A manifest with the fields that do not decode left out, each named in `problems`: one field in a shape we
 * do not read must not hide the plugin's skills, commands and servers (DESIGN §2: read, never rewrite).
 * `name` is never left out: without it there is no plugin.
 */
function decodeManifestLenient(raw: unknown): { readonly manifest: PluginManifest; readonly problems: ReadonlyArray<string> } {
  try {
    return { manifest: decodeManifest(raw), problems: [] };
  } catch (cause) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw cause;
    const fields = raw as Record<string, unknown>;
    const bad = Object.keys(fields).filter((key) => {
      if (key === "name") return false;
      try {
        decodeManifest({ name: fields.name, [key]: fields[key] });
        return false;
      } catch {
        return true;
      }
    });
    const kept = Object.fromEntries(Object.entries(fields).filter(([key]) => !bad.includes(key)));
    return { manifest: decodeManifest(kept), problems: bad.map((key) => `"${key}" left out: not a shape Caveman Code reads`) };
  }
}
const decodeSidecar = (json: unknown) => (json === undefined ? {} : Schema.decodeUnknownSync(CavemanSidecar)(json));
/** A plugin's rules (always in context) are at most this many bytes. */
export const MAX_RULES_BYTES = 16 * 1024;
const decodeMarketplace = Schema.decodeUnknownSync(Marketplace);
const decodeHooksFile = Schema.decodeUnknownSync(HooksFile);
const decodeHooks = Schema.decodeUnknownOption(Hooks);
const decodeLspServers = Schema.decodeUnknownSync(LspServers);
const decodeMonitors = Schema.decodeUnknownSync(Monitors);

/** The real path of `rel` under `root`, or undefined when it does not exist. Throws when it escapes. */
async function resolveInside(root: string, rel: string): Promise<string | undefined> {
  const joined = path.resolve(root, rel);
  let real: string;
  try {
    real = await fs.realpath(joined);
  } catch {
    return undefined;
  }
  if (real !== root && !real.startsWith(root + path.sep)) {
    throw new PluginLoadError(`${rel} leads outside the plugin`);
  }
  return real;
}

/**
 * The first link under `root` (relative path) whose target is outside it, or
 * would be once created. Hook trust hashes the plugin's own files (spaces.ts
 * treeDigest), where a link that stays inside is covered by its target's own
 * entry; one that leaves would run code no digest saw.
 */
async function linkOutside(root: string): Promise<string | undefined> {
  for (const entry of await fs.readdir(root, { withFileTypes: true, recursive: true })) {
    if (!entry.isSymbolicLink()) continue;
    const file = path.join(entry.parentPath, entry.name);
    const real = await fs.realpath(file).catch(async () => path.resolve(path.dirname(file), await fs.readlink(file)));
    if (real !== root && !real.startsWith(root + path.sep)) return path.relative(root, file);
  }
  return undefined;
}

/** A JSON, markdown or rules file a plugin or marketplace holds is read only up to this size. */
export const MAX_PLUGIN_FILE_BYTES = 1024 * 1024;

/** A regular file's text, refusing one over MAX_PLUGIN_FILE_BYTES (or a FIFO or device, which would hang the read). */
async function readCapped(file: string, rel: string): Promise<string> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new PluginLoadError(`${rel} is not a file`);
  if (stat.size > MAX_PLUGIN_FILE_BYTES) throw new PluginLoadError(`${rel} is over ${MAX_PLUGIN_FILE_BYTES / 1024} KiB`);
  return fs.readFile(file, "utf8");
}

async function readJsonInside(root: string, rel: string): Promise<unknown> {
  const file = await resolveInside(root, rel);
  if (file === undefined) return undefined;
  try {
    return JSON.parse(await readCapped(file, rel));
  } catch (cause) {
    throw new PluginLoadError(`${rel}: ${(cause as Error).message}`);
  }
}

async function isDir(file: string): Promise<boolean> {
  return (await fs.stat(file).catch(() => undefined))?.isDirectory() ?? false;
}

/** Markdown files under `dir` (recursive), as paths relative to it, sorted. As Claude Code, `.md` in any case. */
async function markdownFiles(root: string, dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const real = await resolveInside(root, path.join(dir, rel));
    if (real === undefined) return;
    if (!(await isDir(real))) {
      if (real.toLowerCase().endsWith(".md")) out.push(rel);
      return;
    }
    for (const entry of (await fs.readdir(real)).sort()) {
      if (!entry.startsWith(".")) await walk(rel === "" ? entry : path.join(rel, entry));
    }
  };
  await walk("");
  return out;
}

/**
 * A name that would pass for one of the runtime's own MCP servers (caveman-code, the grill's, web search's, a setup chat's),
 * as any engine spells it: the Caveman engine writes non-word characters as `_`, and a server key that only starts with
 * the name still makes tool names that start like the runtime's (`caveman_code__x` makes `mcp__caveman_code__x__tool`).
 * Memory's taint check exempts the runtime's tools by those names (memory/MemoryService.ts RUNTIME_TOOL_PREFIXES).
 */
export const reservedServerName = (name: string) =>
  // Keep legacy t3-code reserved too: stored tools still resolve as ours.
  // caveman_web: web_search and web_fetch (mcp/toolkits/web); caveman-setup: a setup chat's server (SETUP_MCP_SERVER,
  // mcp/toolkits/setup). The Caveman engine runs both without a card.
  ["caveman-code", "t3-code", GRILL_MCP_SERVER, "caveman_web", "caveman-setup"].some((reserved) => new RegExp(`^${reserved.replace(/[^a-z0-9]/g, "_")}(?:_|$)`).test(name.toLowerCase().replace(/[^a-z0-9]/g, "_")));

const asList = (value: string | ReadonlyArray<string> | undefined): ReadonlyArray<string> =>
  value === undefined ? [] : typeof value === "string" ? [value] : value;

/** The command files a manifest names: paths, or the `source` of each entry in Claude Code's object form. */
function commandPaths(value: PluginManifest["commands"], problem: (line: string) => void): ReadonlyArray<string> {
  if (value === undefined || typeof value === "string" || Array.isArray(value)) return asList(value as string | ReadonlyArray<string> | undefined);
  return Object.entries(value).flatMap(([command, entry]) => {
    const source = typeof entry === "object" && entry !== null ? (entry as { source?: unknown }).source : undefined;
    if (typeof source === "string") return [source];
    problem(`command "${command}" left out: only a command with a source file is read`);
    return [];
  });
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;

async function readItem(root: string, file: string, fallbackName: string): Promise<PluginItem> {
  const real = (await resolveInside(root, file))!;
  const { data } = parseFrontmatter(await readCapped(real, file));
  // Hooks that do not decode never reach Claude: the plugin copy leaves them out.
  const hooks = data.hooks === undefined ? undefined : Option.getOrUndefined(decodeHooks(data.hooks));
  return {
    name: str(data.name) ?? fallbackName,
    description: str(data.description) ?? "",
    path: real,
    ...(hooks === undefined || Object.keys(hooks).length === 0 ? {} : { hooks }),
  };
}

async function loadSkills(root: string, dirs: ReadonlyArray<string>): Promise<PluginItem[]> {
  const skills = new Map<string, PluginItem>();
  for (const dir of dirs) {
    const real = await resolveInside(root, dir);
    if (real === undefined || !(await isDir(real))) continue;
    // A path that is itself a skill directory, or a directory of skills.
    const candidates = (await resolveInside(root, path.join(dir, "SKILL.md")))
      ? [dir]
      : (await fs.readdir(real)).sort().map((entry) => path.join(dir, entry));
    for (const candidate of candidates) {
      const skillFile = path.join(candidate, "SKILL.md");
      if ((await resolveInside(root, skillFile)) === undefined) continue;
      const item = await readItem(root, skillFile, path.basename(candidate));
      if (!skills.has(item.name)) skills.set(item.name, item);
    }
  }
  return [...skills.values()];
}

/** Commands are namespaced by subdirectory (`git/commit.md` is `git:commit`), as in Claude Code. */
async function loadMarkdownItems(
  root: string,
  paths: ReadonlyArray<string>,
  nameFrom: "path" | "frontmatter",
): Promise<PluginItem[]> {
  const items = new Map<string, PluginItem>();
  for (const base of paths) {
    for (const rel of await markdownFiles(root, base)) {
      const file = rel === "" ? base : path.join(base, rel);
      const pathName = (rel === "" ? path.basename(base) : rel)
        .replace(/\.md$/, "")
        .split(path.sep)
        .join(":");
      const item = await readItem(root, file, pathName);
      const named = nameFrom === "path" ? { ...item, name: pathName } : item;
      if (!items.has(named.name)) items.set(named.name, named);
    }
  }
  return [...items.values()];
}

function mergeHooks(into: Record<string, Hooks[string]>, add: Hooks): void {
  for (const [event, matchers] of Object.entries(add)) {
    into[event] = [...(into[event] ?? []), ...matchers];
  }
}

/**
 * Every hook a plugin brings, as a person reviews and trusts them: its own (hooks.json, the manifest's), then those
 * in its skills', commands' and agents' frontmatter, which Claude Agent runs while that item is in use.
 */
export function allHooks(plugin: Pick<LoadedPlugin, "hooks" | "skills" | "commands" | "agents">): Hooks {
  const all: Record<string, Hooks[string]> = {};
  mergeHooks(all, plugin.hooks);
  for (const item of [...plugin.skills, ...plugin.commands, ...plugin.agents]) if (item.hooks !== undefined) mergeHooks(all, item.hooks);
  return all;
}

/**
 * `hooks` without those the runtime cannot contain, each named in `problems`. What is left out leaves no trace: an
 * event whose every hook was left out is no hook, so the plugin has nothing to trust for it (a plugin of only
 * `mcp_tool` hooks would otherwise wait for trust over nothing).
 */
function containable(hooks: Hooks, where: string, problems: Array<string>): Record<string, Hooks[string]> {
  return Object.fromEntries(
    Object.entries(hooks).flatMap(([event, matchers]) => {
      const kept = matchers
        .map((matcher) => ({
          ...matcher,
          hooks: matcher.hooks.filter((hook) => {
            if (CONTAINED_HOOK_TYPES.has(hook.type)) return true;
            problems.push(`${where}: ${event} hook of type "${hook.type}" left out`);
            return false;
          }),
        }))
        .filter((matcher) => matcher.hooks.length > 0);
      return kept.length > 0 ? [[event, kept]] : [];
    }),
  );
}

type ManifestOverrides = Omit<MarketplaceEntry, "source" | "strict" | "policy">;

/** Manifest files in the order Codex reads them; the first to give a field wins. */
const MANIFESTS = ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"] as const;
const AGENT_PLUGINS_SCHEMA = /^https:\/\/agent-plugins\.org\/schemas\//;

/** The plugin's manifest files merged, first wins per field; undefined when it has none. */
async function readManifest(root: string): Promise<{ readonly manifest: PluginManifest; readonly problems: ReadonlyArray<string> } | undefined> {
  let merged: Record<string, unknown> | undefined;
  const problems: Array<string> = [];
  for (const file of [...MANIFESTS].reverse()) {
    const raw = await readJsonInside(root, file);
    if (raw === undefined) continue;
    // A root plugin.json is a manifest only in the agent-plugins format; anything else of that name is not ours to read.
    if (file === "plugin.json" && !(typeof raw === "object" && raw !== null && AGENT_PLUGINS_SCHEMA.test(String((raw as { $schema?: unknown }).$schema ?? "")))) continue;
    try {
      const decoded = decodeManifestLenient(raw);
      merged = { ...merged, ...(decoded.manifest as Record<string, unknown>) };
      problems.push(...decoded.problems.map((p) => `${file}: ${p}`));
    } catch (cause) {
      throw new PluginLoadError(`${file}: ${(cause as Error).message}`);
    }
  }
  return merged === undefined ? undefined : { manifest: merged as PluginManifest, problems };
}

const ICON_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};
export const MAX_ICON_BYTES = 64 * 1024;

/**
 * A file inside the plugin as a data: URL when it is a small image; otherwise
 * none. Never a URL elsewhere: showing the Plugins page must not call a third
 * party.
 */
export async function iconFor(root: string, icon: unknown): Promise<string | undefined> {
  const value = str(icon);
  if (value === undefined || /^[a-z][a-z0-9+.-]*:/i.test(value)) return undefined;
  const type = ICON_TYPES[path.extname(value).toLowerCase()];
  if (type === undefined || path.isAbsolute(value)) return undefined;
  try {
    const file = await resolveInside(root, value);
    if (file === undefined) return undefined;
    // A FIFO or device would hang or never end the read.
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_ICON_BYTES) return undefined;
    return `data:${type};base64,${(await fs.readFile(file)).toString("base64")}`;
  } catch {
    // Outside the plugin or unreadable: no icon, never the plugin's failure.
    return undefined;
  }
}

const url = (value: unknown) => {
  const text = str(value);
  return text !== undefined && /^https?:\/\//i.test(text) ? text : undefined;
};
const color = (value: unknown) => {
  const text = str(value);
  return text !== undefined && /^#[0-9a-f]{3,8}$/i.test(text) ? text : undefined;
};
const strings = (value: unknown, max: number, chars = Infinity) =>
  Array.isArray(value) ? value.flatMap((v) => (typeof v === "string" && v.trim() !== "" && v.length <= chars ? [v.trim()] : [])).slice(0, max) : undefined;
const defined = <T extends object>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

/**
 * How the plugin presents itself: the Codex `interface` block, else Claude's
 * fields (description, author.name, homepage, icon), else its marketplace
 * entry. The entry's `category` wins, as in Codex.
 */
export async function pluginInterface(root: string, manifest: PluginManifest, entry?: ManifestOverrides): Promise<PluginPresentation> {
  const ui = (typeof manifest.interface === "object" && manifest.interface !== null ? manifest.interface : {}) as Record<string, unknown>;
  const fromEntry = (typeof entry?.interface === "object" && entry.interface !== null ? entry.interface : {}) as Record<string, unknown>;
  const pick = (key: string) => ui[key] ?? fromEntry[key];
  const author = manifest.author ?? entry?.author;
  const authorName = str(author) ?? (typeof author === "object" && author !== null ? str((author as { name?: unknown }).name) : undefined);
  return defined({
    display_name: str(pick("displayName")),
    short_description: str(pick("shortDescription")) ?? str(manifest.description) ?? str(entry?.description),
    long_description: str(pick("longDescription")),
    developer: str(pick("developerName")) ?? authorName,
    category: str(entry?.category) ?? str(pick("category")) ?? str(manifest.category),
    capabilities: strings(pick("capabilities"), 8),
    logo: (await iconFor(root, pick("logo"))) ?? (await iconFor(root, pick("composerIcon"))) ?? (await iconFor(root, (manifest as { icon?: unknown }).icon)),
    logo_dark: await iconFor(root, pick("logoDark")),
    brand_color: color(pick("brandColor")),
    brand_color_dark: color(pick("brandColorDark")),
    default_prompts: strings(pick("defaultPrompt"), 3, 128),
    website: url(pick("websiteURL")) ?? url(manifest.homepage) ?? url(entry?.homepage),
    privacy: url(pick("privacyPolicyURL")),
    terms: url(pick("termsOfServiceURL")),
    screenshots: strings(pick("screenshots"), 8),
  });
}

/**
 * `owner/name` on GitHub, or an https git URL. A marketplace names where its
 * plugins come from, so never a file:// path on this computer or an ssh host
 * (which would get the person's ssh key), unless the person added the
 * marketplace from this computer themselves (`own`).
 */
const gitUrlOf = (value: string, own: boolean) =>
  /^[\w.-]+\/[\w.-]+$/.test(value)
    ? `https://github.com/${value}.git`
    : /^https:\/\/[^\s@]+$/.test(value) || (own && /^(ssh:\/\/|file:\/\/|[^/\s]+@[^/\s]+:)/.test(value))
      ? value
      : undefined;

/** Where an entry's plugin is, read from its `source` as Codex and Claude Code write it. */
async function entryOrigin(root: string, pluginRoot: string, source: MarketplaceEntry["source"], own: boolean): Promise<EntryOrigin> {
  const local = async (rel: string): Promise<EntryOrigin> => {
    const dir = await resolveInside(root, path.join(pluginRoot, rel));
    return dir === undefined ? { kind: "unsupported", why: `${rel} does not exist` } : { kind: "local", dir };
  };
  if (typeof source === "string") return local(source);
  const field = (key: string) => str((source as Record<string, unknown>)[key]);
  const pinned = { ...(field("ref") === undefined ? {} : { ref: field("ref")! }), ...(field("sha") === undefined ? {} : { sha: field("sha")! }) };
  const subdir = field("path")?.replace(/^\.\//, "");
  if (subdir !== undefined && subdir.split("/").some((part) => part === ".." || part === "")) return { kind: "unsupported", why: `path ${subdir} leaves its repository` };
  switch (source.source) {
    case "local": {
      const rel = field("path");
      return rel === undefined ? { kind: "unsupported", why: "a local source needs a path" } : local(rel);
    }
    case "github":
    case "url":
    case "git":
    case "git-subdir": {
      const remote = field("repo") ?? field("url");
      const gitUrl = remote === undefined ? undefined : gitUrlOf(remote, own);
      if (gitUrl === undefined) return { kind: "unsupported", why: `${source.source} source ${remote ?? "(none)"} is not an https git repository` };
      if (source.source === "git-subdir" && subdir === undefined) return { kind: "unsupported", why: "a git-subdir source needs a path" };
      return { kind: "git", url: gitUrl, ...pinned, ...(subdir === undefined ? {} : { path: subdir }) };
    }
    default:
      return { kind: "unsupported", why: `${source.source} sources are not supported yet` };
  }
}

/** marketplace.json in the order Codex reads them; the first found is the marketplace. */
export const MARKETPLACE_FILES = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"] as const;

const POLICY_INSTALLATION = { AVAILABLE: "available", INSTALLED_BY_DEFAULT: "installed_by_default", NOT_AVAILABLE: "not_available" } as const;

/**
 * The marketplace at `dir`, or undefined when it has no marketplace.json.
 * Entries keep the file's order. `own`: the person added it from this
 * computer, so its entries may name ssh and file:// repositories.
 */
export async function readMarketplace(dir: string, own = false): Promise<ReadMarketplace | undefined> {
  const root = await fs.realpath(dir);
  for (const file of MARKETPLACE_FILES) {
    const json = await readJsonInside(root, file);
    if (json === undefined) continue;
    let market: Marketplace;
    try {
      market = decodeMarketplace(json);
    } catch (cause) {
      throw new PluginLoadError(`${file}: ${(cause as Error).message}`);
    }
    const pluginRoot = market.metadata?.pluginRoot ?? ".";
    const entries = await Promise.all(
      market.plugins.map(async ({ source, strict: _strict, policy, ...fields }): Promise<MarketEntry> => {
        const p = (typeof policy === "object" && policy !== null ? policy : {}) as { installation?: unknown; authentication?: unknown };
        return {
          name: fields.name,
          origin: await entryOrigin(root, pluginRoot, source, own).catch((cause: Error): EntryOrigin => ({ kind: "unsupported", why: cause.message })),
          fields,
          installation: POLICY_INSTALLATION[String(p.installation) as keyof typeof POLICY_INSTALLATION] ?? "available",
          authentication: p.authentication === "ON_USE" ? "on_use" : "on_install",
        };
      }),
    );
    return {
      name: market.name,
      ...(str(market.interface?.displayName) === undefined ? {} : { displayName: str(market.interface?.displayName)! }),
      ...(str(market.metadata?.description) === undefined ? {} : { description: str(market.metadata?.description)! }),
      entries,
    };
  }
  return undefined;
}

/**
 * Loads one plugin directory. `entry` is its marketplace entry, if any: its
 * fields supplement plugin.json, and stand in for it when plugin.json is absent.
 */
export async function loadPlugin(
  dir: string,
  space: string,
  options: { readonly fallbackName?: string; readonly entry?: ManifestOverrides } = {},
): Promise<LoadedPlugin> {
  const root = await fs.realpath(dir);
  const read = await readManifest(root);
  const fromFile = read?.manifest;
  const name = fromFile?.name ?? options.entry?.name ?? options.fallbackName;
  if (name === undefined) throw new PluginLoadError(`${dir}: no plugin.json`);
  // A plugin under the name of the runtime's own MCP server or grill plugin would pass for it
  // (Claude's allow rules for `mcp__caveman-code__*`, grill mode's tools and skill).
  if (reservedServerName(name)) throw new PluginLoadError(`the name "${name}" is reserved by Caveman Code`);
  const decoded = decodeManifestLenient({ ...options.entry, ...fromFile, name });
  const manifest = decoded.manifest;
  const problems: string[] = [...(read?.problems ?? []), ...decoded.problems].map((p) => `${name}: ${p}`);

  const declared: Record<string, Hooks[string]> = {};
  const hookSources = manifest.hooks === undefined ? [] : Array.isArray(manifest.hooks) ? manifest.hooks : [manifest.hooks];
  const hookFiles = ["hooks/hooks.json", ...hookSources.filter((h): h is string => typeof h === "string")];
  for (const file of new Set(hookFiles)) {
    const json = await readJsonInside(root, file);
    if (json !== undefined) mergeHooks(declared, decodeHooksFile(json).hooks);
  }
  for (const source of hookSources) {
    if (typeof source !== "object") continue;
    mergeHooks(declared, "hooks" in source && typeof source.hooks === "object" && !Array.isArray(source.hooks) ? (source as typeof HooksFile.Type).hooks : (source as Hooks));
  }
  let hooks = containable(declared, name, problems);

  let mcpServers: Record<string, McpServerConfig> = {};
  const mcpFile = await readJsonInside(root, ".mcp.json");
  if (mcpFile !== undefined) mcpServers = decodeMcpFile(mcpFile);
  for (const source of manifest.mcpServers === undefined ? [] : Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers]) {
    if (typeof source === "string") {
      const json = await readJsonInside(root, source);
      if (json !== undefined) mcpServers = { ...mcpServers, ...decodeMcpFile(json) };
    } else {
      mcpServers = { ...mcpServers, ...source };
    }
  }
  // Ours, beside the standard files so they stay valid for Claude Code and Codex: how a remote server signs in.
  const sidecar = decodeSidecar(await readJsonInside(root, "caveman.json"));
  for (const [server, { note: _note, ...extra }] of Object.entries(sidecar.mcpServers ?? {})) {
    const config = mcpServers[server];
    if (config !== undefined && "url" in config) mcpServers[server] = { ...config, ...extra };
  }

  // LSP servers and monitors are optional extras: one that cannot be read is left out, not the plugin.
  const lspServers: Record<string, LspServer> = {};
  const lspSources: unknown[] = [".lsp.json", manifest.lspServers];
  for (const source of lspSources) {
    try {
      if (source === undefined) continue;
      for (const one of Array.isArray(source) ? source : [source]) {
        const json = typeof one === "string" ? await readJsonInside(root, one) : one;
        if (json !== undefined) Object.assign(lspServers, decodeLspServers(json));
      }
    } catch (cause) {
      problems.push(`${name}: LSP servers left out: ${(cause as Error).message}`);
    }
  }
  let monitors: ReadonlyArray<Monitor> = [];
  try {
    const source = manifest.monitors ?? "monitors/monitors.json";
    const json = typeof source === "string" ? await readJsonInside(root, source) : source;
    if (json !== undefined) monitors = decodeMonitors(json);
  } catch (cause) {
    problems.push(`${name}: monitors left out: ${(cause as Error).message}`);
  }

  // Rules go into every request: at most MAX_RULES_BYTES of them per plugin.
  const rules: PluginRule[] = [];
  let ruleBytes = 0;
  for (const rel of await markdownFiles(root, "rules")) {
    const file = (await resolveInside(root, path.join("rules", rel)))!;
    const text = await readCapped(file, `rules/${rel}`);
    ruleBytes += Buffer.byteLength(text, "utf8");
    if (ruleBytes > MAX_RULES_BYTES) {
      problems.push(`${name}: rules/${rel} and later rules left out: a plugin's rules are at most ${MAX_RULES_BYTES / 1024} KiB`);
      break;
    }
    rules.push({ name: rel.replace(/\.md$/, ""), path: file, text });
  }

  const containedItems = (items: ReadonlyArray<PluginItem>) =>
    items.map((item) => (item.hooks === undefined ? item : { ...item, hooks: containable(item.hooks, `${name}: ${path.relative(root, item.path).split(path.sep).join("/")}`, problems) }));
  let skills = containedItems(await loadSkills(root, ["skills", ...asList(manifest.skills)]));
  let commands = containedItems(await loadMarkdownItems(root, ["commands", ...commandPaths(manifest.commands, (line) => problems.push(`${name}: ${line}`))], "path"));
  let agents = containedItems(await loadMarkdownItems(root, ["agents", ...asList(manifest.agents)], "frontmatter"));
  // A frontmatter hook runs through a link as a hooks.json one does: all are left out together.
  if (Object.values(allHooks({ hooks, skills, commands, agents })).some((matchers) => matchers.some((m) => m.hooks.length > 0))) {
    const link = await linkOutside(root);
    if (link !== undefined) {
      problems.push(`${name}: hooks left out: ${link} links outside the plugin`);
      const withoutHooks = (items: ReadonlyArray<PluginItem>) => items.map(({ hooks: _hooks, ...item }) => item);
      hooks = {};
      skills = withoutHooks(skills);
      commands = withoutHooks(commands);
      agents = withoutHooks(agents);
    }
  }

  return {
    id: `${name}@${space}`,
    name,
    space,
    root,
    version: manifest.version,
    description: manifest.description,
    skills,
    commands,
    agents,
    hooks,
    mcpServers,
    lspServers,
    monitors,
    rules,
    contributes: manifest.contributes ?? {},
    manifest,
    interface: await pluginInterface(root, manifest, options.entry),
    problems,
  };
}

/**
 * Loads every plugin a marketplace root holds in place. One bad plugin never
 * hides the others. A root that is one plugin (no marketplace.json) is named
 * `name`. Entries from elsewhere (git sources) are fetched at install, not
 * here: `remote` lists them.
 */
export async function loadSpace(
  dir: string,
  space: string,
  name = space,
  own = false,
): Promise<LoadedSpace & { readonly market?: ReadMarketplace | undefined }> {
  const root = await fs.realpath(dir);
  const plugins: LoadedPlugin[] = [];
  const problems: string[] = [];
  let market: ReadMarketplace | undefined;
  try {
    market = await readMarketplace(root, own);
  } catch (cause) {
    return { plugins, problems: [`marketplace.json: ${(cause as Error).message}`] };
  }
  if (market === undefined) {
    try {
      plugins.push(await loadPlugin(root, space, { fallbackName: name }));
    } catch (cause) {
      problems.push(`${space}: ${(cause as Error).message}`);
    }
    return { plugins, problems: [...problems, ...plugins.flatMap((p) => p.problems)] };
  }
  // A folder marketplace is read on every listing: its plugins load side by side, a few at a time.
  const loaded = await mapLimit(market.entries, LOAD_CONCURRENCY, async (entry) => {
    try {
      if (entry.origin.kind === "unsupported") throw new PluginLoadError(entry.origin.why);
      if (entry.origin.kind === "git") return undefined;
      return await loadPlugin(entry.origin.dir, space, { entry: entry.fields });
    } catch (cause) {
      return `${entry.name}: ${(cause as Error).message}`;
    }
  });
  for (const result of loaded) {
    if (typeof result === "string") problems.push(result);
    else if (result !== undefined) plugins.push(result);
  }
  return { plugins, problems: [...problems, ...plugins.flatMap((p) => p.problems)], market };
}

/** Plugins loaded at once: each reads its files in turn, so this bounds the files open. */
const LOAD_CONCURRENCY = 8;

/** `f` over `items`, at most `limit` at a time, results in order. */
async function mapLimit<A, B>(items: ReadonlyArray<A>, limit: number, f: (item: A) => Promise<B>): Promise<B[]> {
  const out = new Array<B>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await f(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
