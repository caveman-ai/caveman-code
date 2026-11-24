/**
 * import.scan / import.apply / import.folder: bringing in what someone set up
 * for Claude Code, Codex and Cursor, and plain folders.
 *
 * The scan reads, never writes, and never reads a secret value: MCP servers
 * become names, commands and URLs, with env and header names only (the
 * personal-server importer, `importEntry`); a marketplace URL that carries a
 * credential is left out. Apply goes through the plugin registry (`ImportOps`),
 * so it adds marketplaces and installs plugins exactly as the Plugins page does.
 *
 * Read, as each tool writes them:
 * - Claude Code (`CLAUDE_CONFIG_DIR` or ~/.claude): `plugins/known_marketplaces.json`,
 *   `settings.json` `enabledPlugins` + `extraKnownMarketplaces` (as Codex's
 *   external-agent migration reads them, codex-rs external-agent-migration
 *   source_cla.rs), `~/.claude.json` `mcpServers`, `skills/`, `CLAUDE.md`.
 * - Codex (`CODEX_HOME` or ~/.codex): `config.toml` `[marketplaces.*]`,
 *   `[plugins."id"] enabled`, `[mcp_servers.*]`, `skills/`, `AGENTS.md`.
 * - Cursor: `~/.cursor/mcp.json`.
 *
 * @module plugins/import/scan
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { PluginServer } from "@caveman-app/protocol";
import type { ImportItem, ImportItemRef, ImportSource } from "@caveman-app/session-protocol";

import { type CodexConfig, commandLine, readCodexConfig, setupHomes, shownUrl, type SetupHomes } from "../../session-protocol/setupScan.ts";
import { KEY_FILE } from "../../cloudLink/profile.ts";
import { holdsCredential, type ImportFrom, importEntry, isSkipped, serverCredentials } from "../personal.ts";

type Item = typeof ImportItem.Type;
export type Ref = typeof ImportItemRef.Type;

export interface ImportHomes extends SetupHomes {
 /** native config folder (mcp.json). */
  readonly cursorDir: string;
  /** Personal skills (`~/.agents/skills`): where skills from a folder or a managed-away Codex home are copied. */
  readonly agentsSkills: string;
}

export function importHomes(env: NodeJS.ProcessEnv, home: string): ImportHomes {
  return { ...setupHomes(env, home), cursorDir: path.join(home, ".cursor"), agentsSkills: path.join(home, ".agents", "skills") };
}

/** What this runtime already has, so the scan can say "available" instead of importing twice. */
export interface ImportExisting {
  /** Added marketplaces by name, with the key of the source they were added from (undefined: built in, like `caveman`). */
  readonly marketplaces: ReadonlyMap<string, string | undefined>;
  /** A source string's key, comparable with `marketplaces`' values (default: the string itself). */
  readonly sourceKey?: (source: string) => string;
  /** Installed plugin ids (`name@marketplace`). */
  readonly installed: ReadonlyArray<string>;
  /** Personal MCP server names. */
  readonly servers: ReadonlyArray<string>;
}

/** What apply does for an item; never sent to a client. */
export type ImportPayload =
  | { readonly kind: "marketplace"; readonly source: string }
  | { readonly kind: "plugin"; readonly id: string; readonly marketplace: string }
  | { readonly kind: "mcp_server"; readonly server: PluginServer }
  | { readonly kind: "skill"; readonly dir: string };

export interface ScannedItem {
  readonly item: Item;
  readonly payload?: ImportPayload;
}

export interface ScannedSource {
  readonly from: ImportFrom;
  readonly found: boolean;
  readonly items: ReadonlyArray<ScannedItem>;
}

/** Claude Code names these marketplaces without a source of their own; Codex maps them the same way. */
const IMPLICIT_MARKETPLACES: Readonly<Record<string, string>> = {
  "claude-plugins-official": "anthropics/claude-plugins-official",
  "claude-code-plugins": "anthropics/claude-code",
  // Codex's built-in curated marketplace.
  "openai-curated": "openai/plugins",
};

const OWNER_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** As format.ts PluginName: no separators, no leading dot. */
const isName = (name: string) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name);

const readText = (file: string) => fs.readFile(file, "utf8").catch(() => undefined);
const exists = (file: string) => fs.access(file).then(() => true, () => false);

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(file);
  if (text === undefined) return undefined;
  try {
    const json: unknown = JSON.parse(text);
    return json !== null && typeof json === "object" && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined;
  } catch {
    // A file its tool is midway through writing: nothing from it.
    return undefined;
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

export const refKey = (ref: Ref) => `${ref.from}\u0000${ref.kind}\u0000${ref.name}`;

/** The protocol's view: payloads stripped. */
export const importSources = (sources: ReadonlyArray<ScannedSource>): Array<typeof ImportSource.Type> =>
  sources.map((s) => ({ from: s.from, found: s.found, items: s.items.map((i) => i.item) }));

// ------------------------------------------------------------ marketplaces

interface MarketplaceSource {
  /** What marketplace.add takes: owner/repo[@ref], a git URL, or an absolute folder. */
  readonly source?: string;
  /** Why it cannot be added. */
  readonly problem?: string;
}

/**
 * A Claude Code marketplace source (`{source: "github", repo}`, `{source: "git", url}`,
 * `{source: "directory", path}`) or a Codex one (`source_type`, `source`, `ref`) as marketplace.add's string:
 * `owner/repo[@ref]`, `<git URL>[#ref]` or an absolute folder.
 */
function marketplaceSource(kind: string | undefined, value: string | undefined, ref: string | undefined, base: string): MarketplaceSource {
  if (value === undefined) {
    return { problem: kind === undefined ? "it has no source" : `a "${kind}" marketplace source cannot be added` };
  }
  if (kind === "directory" || kind === "local" || (kind === undefined && (path.isAbsolute(value) || value.startsWith(".")))) {
    return { source: path.resolve(base, value) };
  }
  if (OWNER_REPO.test(value)) return { source: ref === undefined ? value : `${value}@${ref}` };
  if (holdsCredential([value])) return { problem: "its URL holds a credential; add it by hand without one" };
  if (/^(https|ssh|git):\/\//.test(value) || /^[\w.-]+@[\w.-]+:/.test(value)) return { source: ref === undefined ? value : `${value}#${ref}` };
  return { problem: `${value} is not a git URL, owner/repo or folder` };
}

/** Shown, never a credential: URLs are cut to host and path. */
const shownSource = (source: string) => (/^[a-z][a-z0-9+.-]*:\/\//i.test(source) ? shownUrl(source) : source);

function marketplaceItem(
  from: ImportFrom,
  name: string,
  found: MarketplaceSource,
  existing: ImportExisting,
  planned: Map<string, string>,
): ScannedItem {
  const base = { from, kind: "marketplace" as const, name };
  if (!isName(name)) return { item: { ...base, detail: "", action: "skip", reason: "its name has characters a marketplace name cannot have" } };
  if (found.source === undefined) return { item: { ...base, detail: "", action: "skip", reason: found.problem ?? "it has no source" } };
  const detail = shownSource(found.source);
  if (existing.marketplaces.has(name)) {
    return existing.marketplaces.get(name) === (existing.sourceKey ?? String)(found.source)
      ? { item: { ...base, detail, action: "available" } }
      : { item: { ...base, detail, action: "skip", reason: `another marketplace is already named ${name}` } };
  }
  const earlier = planned.get(name);
  if (earlier !== undefined && earlier !== found.source) {
    return { item: { ...base, detail, action: "skip", reason: `another setup has a different marketplace named ${name}` } };
  }
  planned.set(name, found.source);
  return { item: { ...base, detail, action: "add" }, payload: { kind: "marketplace", source: found.source } };
}

function pluginItem(from: ImportFrom, id: string, existing: ImportExisting, marketplaces: ReadonlyMap<string, ScannedItem>): ScannedItem {
  const base = { from, kind: "plugin" as const, name: id, detail: id };
  const at = id.lastIndexOf("@");
  const marketplace = at > 0 ? id.slice(at + 1) : "";
  if (at <= 0 || !isName(id.slice(0, at)) || !isName(marketplace)) return { item: { ...base, action: "skip", reason: "it is not a plugin@marketplace id" } };
  if (existing.installed.includes(id)) return { item: { ...base, action: "available" } };
  const market = marketplaces.get(marketplace);
  const ready = market === undefined ? existing.marketplaces.has(marketplace) : market.item.action !== "skip";
  if (!ready) {
    const reason = market === undefined ? `its marketplace ${marketplace} is not known` : `its marketplace ${marketplace} cannot be added: ${market.item.reason}`;
    return { item: { ...base, action: "skip", reason } };
  }
  return { item: { ...base, action: "install" }, payload: { kind: "plugin", id, marketplace } };
}

// ------------------------------------------------------------ MCP servers

interface RawServer {
  readonly name: string;
  readonly from: ImportFrom;
  readonly entry: { command?: unknown; args?: unknown; url?: unknown; type?: unknown; env: ReadonlyArray<string>; headers: ReadonlyArray<string>; enabled?: boolean; problem?: string };
}

/** Claude Code's and native `mcpServers` map: values for command, args and url; names only for env and headers. */
function jsonServers(from: ImportFrom, servers: unknown): RawServer[] {
  return Object.entries(record(servers)).flatMap(([name, value]) => {
    if (value === null || typeof value !== "object") return [];
    const raw = value as Record<string, unknown>;
    return [{ name, from, entry: { command: raw.command, args: raw.args, url: raw.url, type: raw.type, env: Object.keys(record(raw.env)), headers: Object.keys(record(raw.headers)) } }];
  });
}

const SETUP_NAME: Readonly<Record<ImportFrom, string>> = { claude: "Claude Code", codex: "Codex", cursor: "Cursor" };

/** What a server runs or reaches, to tell one listed by two setups from two servers sharing a name. */
const serverTarget = (server: PluginServer) => server.url ?? JSON.stringify([server.command, ...(server.args ?? [])]);

const union = (a: ReadonlyArray<string> | undefined, b: ReadonlyArray<string> | undefined) => [...new Set([...(a ?? []), ...(b ?? [])])];

/**
 * One server two setups list, with every key either gives it: a token Codex sends is not lost because Claude Code
 * listed the URL bare. A header means a key, so a merged URL server with one no longer signs in.
 */
function mergeKeys(kept: PluginServer, also: PluginServer): PluginServer {
  const env = union(kept.env, also.env);
  const headers = union(kept.headers, also.headers);
  const { env: _env, headers: _headers, auth, ...rest } = kept;
  const signsIn = headers.length === 0 ? (auth ?? also.auth) : undefined;
  return { ...rest, ...(env.length ? { env } : {}), ...(headers.length ? { headers } : {}), ...(signsIn === undefined ? {} : { auth: signsIn }) };
}

/**
 * Each setup's servers as rows. The first setup listing a name imports it (Claude Code, Codex, Cursor order); a later
 * one running the same command or URL is that server again (`same_as`, its keys joined to the first row's), and one
 * running something else under the name cannot come in beside it. A name already among the person's servers is
 * available.
 */
function serverItems(raw: ReadonlyArray<RawServer>, existing: ImportExisting): Map<ImportFrom, ScannedItem[]> {
  const first = new Map<string, { readonly from: ImportFrom; readonly name: string; readonly target: string; readonly at: number }>();
  const out = new Map<ImportFrom, ScannedItem[]>();
  const row = (base: Item, server: PluginServer): ScannedItem => {
    const credentials = serverCredentials(server);
    const { credentials: _was, ...item } = base;
    return { item: { ...item, action: "import", ...(credentials.length === 0 ? {} : { credentials: [...credentials] }) }, payload: { kind: "mcp_server", server } };
  };
  for (const { name, from, entry } of raw) {
    const detail = typeof entry.url === "string" ? shownUrl(entry.url) : commandLine(entry.command, entry.args);
    const base = { from, kind: "mcp_server" as const, name, detail };
    const result = importEntry(name, from, entry);
    const list = out.get(from) ?? [];
    out.set(from, list);
    if (isSkipped(result)) {
      list.push({ item: { ...base, action: "skip", reason: result.reason } });
      continue;
    }
    const key = result.server.name.toLowerCase();
    const seen = first.get(key);
    if (existing.servers.some((s) => s.toLowerCase() === key)) {
      list.push({ item: { ...base, action: "available" } });
    } else if (seen === undefined) {
      first.set(key, { from, name, target: serverTarget(result.server), at: list.length });
      list.push(row({ ...base, action: "import" }, result.server));
    } else if (seen.target === serverTarget(result.server)) {
      const theirs = out.get(seen.from)!;
      const kept = theirs[seen.at]!;
      if (kept.payload?.kind === "mcp_server") theirs[seen.at] = row(kept.item, mergeKeys(kept.payload.server, result.server));
      list.push({ item: { ...base, action: "available", same_as: { from: seen.from, name: seen.name } } });
    } else {
      list.push({ item: { ...base, action: "skip", reason: `${SETUP_NAME[seen.from]} has a different server named ${result.server.name}` } });
    }
  }
  return out;
}

// ------------------------------------------------------------ skills and instructions

/** Skill folders (each with a SKILL.md) directly under `dir`, by name. Dot folders (Codex's .system) are not the user's. */
export async function skillDirs(dir: string): Promise<Array<{ readonly name: string; readonly dir: string }>> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const found = await Promise.all(
    entries
      .filter((e) => !e.name.startsWith(".") && (e.isDirectory() || e.isSymbolicLink()))
      .map(async (e) => ((await exists(path.join(dir, e.name, "SKILL.md"))) ? [{ name: e.name, dir: path.join(dir, e.name) }] : [])),
  );
  return found.flat().sort((a, b) => a.name.localeCompare(b.name));
}

// ------------------------------------------------------------ Codex config.toml

const flat = (map: CodexConfig["marketplaces"]) =>
  new Map([...map].map(([name, table]) => [name, Object.fromEntries(Object.entries(table).filter((e): e is [string, string | boolean] => typeof e[1] === "string" || typeof e[1] === "boolean"))]));
const flatTables = (config: CodexConfig) => ({ marketplaces: flat(config.marketplaces), plugins: flat(config.plugins) });

/** `[marketplaces.<name>]` and `[plugins."<id>"]` tables of Codex's config.toml (readCodexConfig): their string and boolean keys. */
export const codexTables = (toml: string): { marketplaces: Map<string, Record<string, string | boolean>>; plugins: Map<string, Record<string, string | boolean>> } =>
  flatTables(readCodexConfig(toml));

// ------------------------------------------------------------ scan

export interface ScanOptions {
  readonly existing: ImportExisting;
 /** Codex runs on the person's own home (compact login), so it already reads ~/.codex skills and AGENTS.md. */
  readonly codexOwnHome: boolean;
}

export async function scanImports(homes: ImportHomes, options: ScanOptions): Promise<ScannedSource[]> {
  const { existing } = options;
  const planned = new Map<string, string>();

  // Claude Code.
  const known = record(await readJson(path.join(homes.claudeDir, "plugins", "known_marketplaces.json")));
  const settings = record(await readJson(path.join(homes.claudeDir, "settings.json")));
  const extra = record(settings.extraKnownMarketplaces);
  const enabled = Object.entries(record(settings.enabledPlugins)).flatMap(([id, on]) => (on === true ? [id] : []));
  const claudeMarkets = new Map<string, ScannedItem>();
  const claudeNames = [...new Set([...Object.keys(known), ...Object.keys(extra), ...enabled.map((id) => id.slice(id.lastIndexOf("@") + 1))])];
  for (const name of claudeNames) {
    // A settings entry wins over the registry, as in Claude Code.
    const value = record(extra[name] ?? known[name]);
    const fields = typeof value.source === "object" ? record(value.source) : value;
    const kind = text(fields.source);
    const declared =
      kind === "github" ? text(fields.repo) : kind === "git" ? text(fields.url) : kind === "directory" || kind === "local" ? text(fields.path) : kind === undefined ? text(fields.repo) ?? text(fields.url) ?? text(fields.path) : undefined;
    const implicit = IMPLICIT_MARKETPLACES[name];
    if (declared === undefined && implicit === undefined && !(name in known) && !(name in extra)) continue; // only named by a plugin id
    const found = declared === undefined && implicit !== undefined ? { source: implicit } : marketplaceSource(kind, declared, text(fields.ref) ?? text(value.ref), homes.claudeDir);
    claudeMarkets.set(name, marketplaceItem("claude", name, found, existing, planned));
  }

  // Codex.
  const toml = (await readText(path.join(homes.codexHome, "config.toml"))) ?? "";
  const codexConfig = readCodexConfig(toml);
  const codex = flatTables(codexConfig);
  const codexEnabled = [...codex.plugins].flatMap(([id, table]) => (table.enabled === true ? [id] : []));
  const codexMarkets = new Map<string, ScannedItem>();
  for (const [name, table] of codex.marketplaces) {
    const sourceType = typeof table.source_type === "string" ? table.source_type : undefined;
    const value = typeof table.source === "string" ? text(table.source) : undefined;
    codexMarkets.set(name, marketplaceItem("codex", name, marketplaceSource(sourceType, value, typeof table.ref === "string" ? text(table.ref) : undefined, homes.codexHome), existing, planned));
  }
  for (const id of codexEnabled) {
    const name = id.slice(id.lastIndexOf("@") + 1);
    const implicit = IMPLICIT_MARKETPLACES[name];
    if (!codexMarkets.has(name) && implicit !== undefined) codexMarkets.set(name, marketplaceItem("codex", name, { source: implicit }, existing, planned));
  }

  // MCP servers, in Claude Code, Codex, Cursor order: the first of a name is imported.
  const claudeJson = record(await readJson(homes.claudeJson));
  const cursorJson = await readJson(path.join(homes.cursorDir, "mcp.json"));
  const servers = serverItems(
    [
      ...jsonServers("claude", claudeJson.mcpServers),
      ...codexConfig.servers.map((s) => ({
        name: s.name,
        from: "codex" as const,
        entry: { command: s.command, args: s.args, url: s.url, env: [...s.env], headers: [...s.headers], ...(s.enabled === undefined ? {} : { enabled: s.enabled }), ...(s.problem === undefined ? {} : { problem: s.problem }) },
      })),
      ...jsonServers("cursor", cursorJson?.mcpServers),
    ],
    existing,
  );

  // Plugins resolve against both tools' marketplaces: a Claude plugin may live in a marketplace only Codex lists.
  const allMarkets = new Map([...codexMarkets, ...claudeMarkets]);
  const claudePlugins = enabled.map((id) => pluginItem("claude", id, existing, allMarkets));
  const codexPlugins = codexEnabled.map((id) => pluginItem("codex", id, existing, allMarkets));

  const claudeSkills = (await skillDirs(path.join(homes.claudeDir, "skills"))).map(
    (s): ScannedItem => ({ item: { from: "claude", kind: "skill", name: s.name, detail: s.dir, action: "available" } }),
  );
  const personalSkills = new Set((await skillDirs(homes.agentsSkills)).map((s) => s.name));
  const codexSkills = (await skillDirs(path.join(homes.codexHome, "skills"))).map((s): ScannedItem => {
    const base = { from: "codex" as const, kind: "skill" as const, name: s.name, detail: s.dir };
    // A managed Codex home does not read ~/.codex/skills; a copy in ~/.agents/skills reaches it.
    if (options.codexOwnHome || personalSkills.has(s.name)) return { item: { ...base, action: "available" } };
    return { item: { ...base, action: "import" }, payload: { kind: "skill", dir: s.dir } };
  });

  const instructions = async (from: ImportFrom, file: string, reach: boolean): Promise<ScannedItem[]> =>
    (await exists(file))
      ? [
          {
            item: reach
              ? { from, kind: "instructions", name: path.basename(file), detail: file, action: "available" }
              : { from, kind: "instructions", name: path.basename(file), detail: file, action: "skip", reason: "Codex reads it only when it runs on your own ChatGPT login" },
          },
        ]
      : [];

  return [
    {
      from: "claude",
      found: (await exists(homes.claudeDir)) || (await exists(homes.claudeJson)),
      items: [...claudeMarkets.values(), ...claudePlugins, ...(servers.get("claude") ?? []), ...claudeSkills, ...(await instructions("claude", path.join(homes.claudeDir, "CLAUDE.md"), true))],
    },
    {
      from: "codex",
      found: await exists(homes.codexHome),
      items: [
        // A config.toml Codex cannot read brings nothing: the row says so rather than the scan finding nothing.
        ...(codexConfig.problem === undefined
          ? []
          : [{ item: { from: "codex" as const, kind: "mcp_server" as const, name: "config.toml", detail: path.join(homes.codexHome, "config.toml"), action: "skip" as const, reason: codexConfig.problem } }]),
        ...codexMarkets.values(),
        ...codexPlugins,
        ...(servers.get("codex") ?? []),
        ...codexSkills,
        ...(await instructions("codex", path.join(homes.codexHome, "AGENTS.md"), options.codexOwnHome)),
      ],
    },
    { from: "cursor", found: await exists(homes.cursorDir), items: servers.get("cursor") ?? [] },
  ];
}

// ------------------------------------------------------------ apply

/** The registry calls apply needs (lane R's PluginRegistry). */
export interface ImportOps {
  /** Answers the name it was added (or was already) under: its marketplace.json's, which plugin ids then carry. */
  readonly addMarketplace: (source: string) => Promise<{ readonly name: string }>;
  /** Installs `name@marketplace` for me. */
  readonly install: (id: string) => Promise<unknown>;
  readonly saveServer: (server: PluginServer) => Promise<unknown>;
}

const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

/** Marketplaces added at once by an import. */
const MARKETPLACES_AT_ONCE = 4;

/** A skill folder copied by import is at most this many bytes. */
export const MAX_COPIED_SKILL_BYTES = 16 * 1024 * 1024;

/**
 * Copies a skill folder into `into/<name>`; refuses to replace one already
 * there, a folder that is itself a link, and one over MAX_COPIED_SKILL_BYTES.
 * Links inside it and key or env files (profile.ts KEY_FILE) are left out: a
 * link would reach whatever it names from the person's own skills folder.
 */
export async function copySkill(dir: string, into: string, name = path.basename(dir)): Promise<string> {
  if (!isName(name)) throw new Error(`${name} is not a skill folder name`);
  if ((await fs.lstat(dir)).isSymbolicLink()) throw new Error(`${dir} is a link: copy the folder it points to instead`);
  const target = path.join(into, name);
  if (await exists(target)) throw new Error(`a skill named ${name} is already in ${into}`);
  await fs.mkdir(into, { recursive: true });
  let bytes = 0;
  const filter = async (source: string) => {
    if (source === dir) return true;
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || KEY_FILE.test(path.basename(source))) return false;
    if (stat.isFile()) bytes += stat.size;
    if (bytes > MAX_COPIED_SKILL_BYTES) throw new Error(`${name} is over ${MAX_COPIED_SKILL_BYTES / 1024 / 1024} MiB`);
    return stat.isFile() || stat.isDirectory();
  };
  try {
    await fs.cp(dir, target, { recursive: true, errorOnExist: true, force: false, filter });
  } catch (cause) {
    await fs.rm(target, { recursive: true, force: true });
    throw cause;
  }
  return target;
}

/**
 * Imports the chosen items of a fresh scan: marketplaces first, then plugins (a plugin whose marketplace
 * failed fails with it), servers and skills. Items marked available need nothing; skipped ones fail with their reason.
 */
export async function applyImports(
  sources: ReadonlyArray<ScannedSource>,
  refs: ReadonlyArray<Ref>,
  ops: ImportOps,
  homes: Pick<ImportHomes, "agentsSkills">,
): Promise<{ imported: number; failed: Array<{ ref: Ref; reason: string }> }> {
  const byKey = new Map(sources.flatMap((s) => s.items.map((i) => [refKey(i.item), i] as const)));
  const failed: Array<{ ref: Ref; reason: string }> = [];
  const brokenMarkets = new Map<string, string>();
  // The tool's name for a marketplace may not be its marketplace.json name, which ids carry here.
  const renamed = new Map<string, string>();
  let imported = 0;
  const order = { marketplace: 0, plugin: 1, mcp_server: 2, skill: 3, instructions: 4 } as const;
  const chosen = [...new Map(refs.map((r) => [refKey(r), r])).values()].sort((a, b) => order[a.kind] - order[b.kind]);
  const adds = new Map<string, Promise<{ readonly name: string }>>();
  const one = async (ref: Ref) => {
    const scanned = byKey.get(refKey(ref));
    if (scanned === undefined) {
      failed.push({ ref, reason: "it is no longer in that setup" });
      return;
    }
    const { item, payload } = scanned;
    if (item.action === "skip") {
      failed.push({ ref, reason: item.reason ?? "it cannot be imported" });
      if (item.kind === "marketplace") brokenMarkets.set(item.name, item.reason ?? "it cannot be added");
      return;
    }
    if (payload === undefined) return; // available: already read in place
    try {
      if (payload.kind === "marketplace") {
        try {
          // Claude Code and Codex may both list it: one add, both rows share how it went.
          const adding = adds.get(payload.source) ?? ops.addMarketplace(payload.source);
          adds.set(payload.source, adding);
          const { name } = await adding;
          if (name !== item.name) renamed.set(item.name, name);
        } catch (cause) {
          brokenMarkets.set(item.name, message(cause));
          throw cause;
        }
      } else if (payload.kind === "plugin") {
        const broken = brokenMarkets.get(payload.marketplace);
        if (broken !== undefined) throw new Error(`its marketplace ${payload.marketplace} was not added: ${broken}`);
        const name = renamed.get(payload.marketplace);
        await ops.install(name === undefined ? payload.id : `${payload.id.slice(0, payload.id.lastIndexOf("@"))}@${name}`);
      } else if (payload.kind === "mcp_server") {
        await ops.saveServer(payload.server);
      } else {
        await copySkill(payload.dir, homes.agentsSkills);
      }
      imported++;
    } catch (cause) {
      failed.push({ ref, reason: message(cause) });
    }
  };
  // Marketplaces are mostly git clones: a few at a time (the registry checks out outside its lock and re-checks
  // names under it), so a setup with twenty no longer takes minutes. Everything after them, in order.
  const markets = chosen.filter((r) => r.kind === "marketplace");
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(MARKETPLACES_AT_ONCE, markets.length) }, async () => {
    while (next < markets.length) await one(markets[next++]!);
  }));
  for (const ref of chosen.filter((r) => r.kind !== "marketplace")) await one(ref);
  return { imported, failed };
}

// ------------------------------------------------------------ folder

const MARKETPLACE_FILES = [".agents/plugins/marketplace.json", ".claude-plugin/marketplace.json", ".cursor-plugin/marketplace.json"];
const PLUGIN_FILES = ["plugin.json", ".codex-plugin/plugin.json", ".claude-plugin/plugin.json", ".cursor-plugin/plugin.json"];

export type FolderKind =
  | { readonly kind: "marketplace" }
  | { readonly kind: "plugin" }
  | { readonly kind: "skills"; readonly skills: ReadonlyArray<{ readonly name: string; readonly dir: string }> };

/**
 * What a plain folder holds, no git needed: a marketplace, a plugin, a `skills/` tree, a folder of skills,
 * or one skill (its own SKILL.md). A root `plugin.json` counts only with the agent-plugins `$schema`, as Codex reads it.
 */
export async function classifyFolder(dir: string): Promise<FolderKind> {
  if (!path.isAbsolute(dir)) throw new Error("give the folder as an absolute path");
  const stat = await fs.stat(dir).catch(() => undefined);
  if (!stat?.isDirectory()) throw new Error(`${dir} is not a folder`);
  for (const file of MARKETPLACE_FILES) if (await exists(path.join(dir, file))) return { kind: "marketplace" };
  for (const file of PLUGIN_FILES) {
    if (!(await exists(path.join(dir, file)))) continue;
    if (file !== "plugin.json") return { kind: "plugin" };
    const schema = text(record(await readJson(path.join(dir, file))).$schema) ?? "";
    if (schema.startsWith("https://agent-plugins.org/schemas/")) return { kind: "plugin" };
  }
  if (await exists(path.join(dir, "SKILL.md"))) return { kind: "skills", skills: [{ name: path.basename(dir), dir }] };
  const skills = [...(await skillDirs(path.join(dir, "skills"))), ...(await skillDirs(dir))];
  if (skills.length > 0) return { kind: "skills", skills };
  throw new Error(`${dir} has no marketplace, plugin or SKILL.md`);
}
