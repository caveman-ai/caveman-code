/**
 * PluginRegistry: the marketplaces this runtime knows (the Caveman catalog
 * shipped with the app, the team's from Caveman Cloud, ones you added, your
 * personal one, the open repository's), the plugins installed from them, and
 * what a session gets. Each call reads Settings, Cloud's installs for the
 * repository and the immutable checkouts, so a session started after a
 * change sees it and a running session keeps the bundle it started with. A
 * git checkout holds its callers at most `CHECKOUT_WAIT_MS` after it started:
 * it goes on in the background and its plugins arrive with a later session.
 *
 * Installs: mine in Settings (`installed`), a project's in Caveman Cloud
 * (Settings `projects` when signed out), the team's in Caveman Cloud. Which
 * are on follows `effectiveInstalls` (marketplaces.ts). Credentials granted
 * to a marketplace's plugins are kept by `CredentialGrants`, served by the
 * broker, keyed by the marketplace's source.
 *
 * @module plugins/PluginRegistry
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type ClaudeAgentPluginOptions,
  type RuntimeHooks,
  SessionPlugins,
  type SessionStartSource,
} from "@caveman-app/engine-core/server/SessionPlugins";
import type { PluginMarketplace, PluginServer, PluginSettings, ThreadId } from "@caveman-app/protocol";
import { isHiddenSecret, isReservedEnvName } from "@caveman-app/session-protocol";
import { type MarketplaceInfo, PanelContribution, type PluginInfo, type PluginSummary } from "@caveman-app/session-protocol/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { toolsSocket } from "../cloudLink/tools.ts";
import { appProxyHome } from "../router/proxyLauncher.ts";
import { pluginDirsForTools } from "../cloudLink/toolsMirror.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ProjectSecrets, ProjectSecretsError } from "../secrets/ProjectSecrets.ts";
import { PluginSettingsLock, ServerSettingsService } from "../serverSettings.ts";
import { threadWorkspaceEnv } from "../session-protocol/workspaceIsolation.ts";
import type { DraftEvent } from "../session-protocol/projector.ts";
import { SessionStore } from "../session-protocol/store.ts";
import { CO_AUTHOR_INSTRUCTION, coAuthorOn } from "../git/coAuthor.ts";
import { coAuthorGitEnv, SECRET_NAMES_ENV, setCoAuthorFlag, TOOLS_HOOKS_DIR, writeCoAuthorHooks, writeToolsCoAuthorHooks } from "../git/coAuthorHooks.ts";
import { hiddenPathsFor, readProjectPrefs, type ProjectPrefs } from "../session-protocol/projectPrefs.ts";
import { claudeReadDenyRules } from "@caveman-app/shared/ignorePaths";
import { cavemanSections, extraSections, type InstructionEngine, InstructionSources, renderSections } from "../instructions/EngineInstructions.ts";
import { Memory } from "../memory/MemoryService.ts";
import { readIdentity } from "../cloudLink/identity.ts";
import { readAccount } from "../session-protocol/cloudSignin.ts";
import { CloudComputer, CloudLinkState, linkDirOf } from "../cloudLink/index.ts";
import { ruleOf } from "../cloudLink/credentialRule.ts";
import { runtimePlugins } from "../cloudLink/plugins.ts";
import { readRepositoryLink } from "../project/ProjectDiscovery.ts";
import { CredentialBroker, CredentialGrants } from "./CredentialBroker.ts";
import { makeHookRunner, withPostToolUseNote } from "./hooks.ts";
import { routeThroughHub } from "./hubRoute.ts";
import { McpProviderSessions } from "@caveman-app/engine-core/server/McpProviderSessions";
import { allHooks, type LoadedPlugin, loadPlugin, loadSpace, type MarketEntry, MARKETPLACE_FILES } from "./load.ts";
import { currentProfileSkills, KEY_FILE } from "../cloudLink/profile.ts";
import { CloudSyncState } from "../cloudLink/cloudSync.ts";
import {
  CATALOG_NAME,
  catalogDir,
  type CloudPlugins,
  cloudRecords,
  cloudRepoUrl,
  type EffectiveInstall,
  effectiveInstalls,
  type InstallRecord,
  localRecords,
  COMMIT,
  migrateCatalogName,
  migrateConnectors,
  migrateSpaces,
  sameRepoUrl,
  parseMarketplaceSource,
  readRepoDeclared,
  type RepoDeclared,
  renderPluginCapabilities,
  repoKeyOf,
  type SpaceContents,
} from "./marketplaces.ts";
import { CONNECTOR_PLUGINS, PERSONAL_SPACE_ID, PERSONAL_SPACE_URL, personalPlugin, serverCredentials, serverProblem } from "./personal.ts";
import { setupHomes } from "../session-protocol/setupScan.ts";
import {
  containmentFor,
  credentialFilesFor,
  detectSandboxLater,
  lspServersOffered,
  monitorsOffered,
  type PluginBundle,
  projectForAcp,
  projectForCaveman,
  projectForClaudeAgent,
  projectForCodex,
  resolveBundle,
  type Sandbox,
  serverKeys,
} from "./resolve.ts";
import { changedPaths, checkoutSpace, checkSpaceUrl, resolveSpaceRef, spaceIdFor, spaceNameFor, treeDigest, treeStamp, watchedTreeStamp } from "./spaces.ts";

/** The pseudo-space a Cloud computer's profile skills load from. */
export const PROFILE_SPACE_ID = "profile";

/** How long after a checkout starts its callers go on without it. */
const CHECKOUT_WAIT_MS = 30_000;
/** A failed checkout is retried after this, not for every session. */
const RETRY_FAILED_MS = 60_000;
/** Cloud's installs for a repository are read again after this. */
const CLOUD_TTL_MS = 60_000;
/** While Caveman Cloud does not answer, it is asked again after this long; reads meanwhile take the last answer. */
const CLOUD_RETRY_MS = 10_000;
/** Names no marketplace may take: the runtime's own. */
const RESERVED_MARKETS = new Set([PERSONAL_SPACE_ID, PROFILE_SPACE_ID]);

export class PluginRegistryError extends Schema.TaggedError<PluginRegistryError>()(
  "PluginRegistryError",
  {
    message: Schema.String,
    /** The caller asked for something that cannot be (unknown id, undeclared name); otherwise an internal failure. */
    invalid: Schema.optionalKey(Schema.Boolean),
    /** It needs something this runtime lacks (Caveman Cloud for a team install). */
    unsupported: Schema.optionalKey(Schema.Boolean),
    /** Refused for this person (a Required plugin turned off, a team install without org admin). */
    forbidden: Schema.optionalKey(Schema.Boolean),
  },
) {}

/** Session Protocol `PluginInfo`. */
export type PluginListing = typeof PluginInfo.Type;

/** A plugin's MCP server that signs in, for connect. */
export interface AuthServer {
  readonly server: string;
  readonly url: string;
  readonly auth: "oauth" | "github";
  readonly unavailable?: string | undefined;
}

/** A marketplace as the registry reads it. */
export interface Market {
  readonly name: string;
  readonly displayName: string;
  readonly kind: MarketplaceInfo["kind"] | "hidden";
  /** A git URL, a folder path, or `caveman`. */
  readonly source: string;
  readonly ref?: string | undefined;
  readonly commit?: string | undefined;
  /** What its plugins' credential grants are keyed by. */
  readonly key: string;
  readonly status: "ready" | "checking_out" | "failed";
  readonly problems: ReadonlyArray<string>;
  /**
   * Whether teammates can fetch its plugins: yes (the catalog, a team
   * marketplace), add_to_team (a git repository on a host: `team` is what an
   * admin adds to the org), no (a folder on this computer).
   */
  readonly shareable: "yes" | "add_to_team" | "no";
  readonly team?: { readonly repo: string; readonly ref?: string | undefined } | undefined;
  /** In display order. `plugin` once its files are read (in place, or installed from elsewhere). */
  readonly entries: ReadonlyArray<{ readonly name: string; readonly entry?: MarketEntry | undefined; readonly plugin?: LoadedPlugin | undefined }>;
}

export interface KnownPlugins {
  /** Installed plugins whose files are read (on or turned off), then the personal and profile pseudo-plugins. */
  readonly plugins: ReadonlyArray<{ readonly plugin: LoadedPlugin; readonly enabled: boolean }>;
  readonly markets: ReadonlyArray<Market>;
  /** The effective set (marketplaces.ts): every installed or offered plugin by id. */
  readonly installs: ReadonlyMap<string, EffectiveInstall>;
  /** The open repository's key (`host/owner/name`), when there is one. */
  readonly repository?: string | undefined;
  /** Cloud's project for the repository, when signed in. */
  readonly project?: CloudPlugins["project"];
  /** Installed plugins whose hooks run: trusted, and their files still the ones trusted (`<id>#<digest>`). */
  readonly trusted: ReadonlyArray<string>;
  /** Installed plugins with hooks that were trusted but no longer are: their files changed, or the trust predates digests. */
  readonly trustDropped: ReadonlyArray<string>;
  /** Caveman Cloud did not answer: the team and project installs are the last ones it gave. */
  readonly cloudProblem?: string | undefined;
  /**
   * Marketplaces that failed to check out, plugins (or parts) that failed to
   * load, and recent failures preparing a session's plugins, one line each.
   */
  readonly problems: ReadonlyArray<string>;
}

/** A plugin.list row: the wire summary less what only the hub knows (needs_connect), and its servers that sign in. */
export interface ListedPlugin {
  readonly summary: Omit<PluginSummary, "needs_connect">;
  readonly authServers: ReadonlyArray<AuthServer>;
  readonly plugin?: LoadedPlugin | undefined;
  readonly market: Market;
  readonly shared: boolean;
}

/** A trust entry: `<id>#<digest>` (Settings.plugins.trusted). */
export const trustEntry = (id: string, digest: string) => `${id}#${digest}`;
/** The plugin id a trust entry is for. */
export const trustedId = (entry: string) => entry.split("#")[0]!;

/** How plugin processes are contained here, as `PluginInfo.containment` says it. */
const CONTAINMENT: Record<Sandbox, NonNullable<PluginListing["containment"]>> = {
  macos: "macos_sandbox",
  bwrap: "bubblewrap",
  none: "env_filter",
};

export interface InstallRequest {
  readonly id: string;
  readonly scope: "me" | "project" | "team";
  /** A project install: the project and its repository key. */
  readonly project?: { readonly id: string; readonly name: string; readonly repository: string | undefined } | undefined;
  readonly policy?: "available" | "default" | "required" | undefined;
  readonly connection?: "personal" | "shared" | undefined;
  /** Where the marketplace is visible from (a repository's own marketplace). */
  readonly cwd?: string | undefined;
  /** A team or project install from a git marketplace teammates do not have: add it to the team first (org admins). */
  readonly addToTeam?: boolean | undefined;
}

/** Writes Caveman Cloud keeps (project and team installs): the handlers bring the person's sign-in. */
export interface CloudWrites {
  readonly install: (input: {
    readonly scope: "team" | "project";
    readonly project?: InstallRequest["project"];
    readonly plugin_id: string;
    readonly source?: { readonly url: string; readonly path?: string };
    readonly commit?: string;
    readonly version?: string;
    readonly policy: "available" | "default" | "required";
    readonly connection: "personal" | "shared";
  }) => Promise<void>;
  readonly uninstall: (input: { readonly scope: "team" | "project"; readonly project?: InstallRequest["project"]; readonly plugin_id: string }) => Promise<void>;
  /** Adds a git marketplace to the org (POST /code/marketplaces): org admins. */
  readonly addMarketplace: (input: { readonly name: string; readonly repo: string; readonly ref?: string; readonly commit: string }) => Promise<void>;
}

export class PluginRegistry extends Context.Service<
  PluginRegistry,
  {
    /** What this runtime knows, without a repository. */
    readonly known: Effect.Effect<KnownPlugins, PluginRegistryError>;
    /** What a session in `cwd` knows: its repository's marketplace and declared plugins, its project's installs. */
    readonly knownAt: (cwd: string | undefined) => Effect.Effect<KnownPlugins, PluginRegistryError>;
    /** `plugin.list` rows, in display order. */
    readonly listing: (query: { readonly marketplace?: string | undefined; readonly query?: string | undefined; readonly cwd?: string | undefined }) => Effect.Effect<
      { readonly plugins: ReadonlyArray<ListedPlugin>; readonly featured: ReadonlyArray<string>; readonly categories: ReadonlyArray<string>; readonly cloudProblem?: string | undefined },
      PluginRegistryError
    >;
    /** Installed plugins in PluginInfo shape (the Manage view, tests). */
    readonly list: Effect.Effect<ReadonlyArray<PluginListing>, PluginRegistryError>;
    readonly marketplaces: (cwd?: string) => Effect.Effect<ReadonlyArray<MarketplaceInfo>, PluginRegistryError>;
    /** Adds a git marketplace pinned to the commit its ref names now, or a folder read in place. */
    readonly addMarketplace: (source: string) => Effect.Effect<{ readonly name: string; readonly already_added: boolean }, PluginRegistryError>;
    /** Repins a git marketplace; trust is dropped for each plugin whose files changed. */
    readonly updateMarketplace: (name: string) => Effect.Effect<{ readonly changed: ReadonlyArray<string>; readonly trust_dropped: ReadonlyArray<string> }, PluginRegistryError>;
    /** Removes a marketplace you added, my installs from it and the credentials granted to it. */
    readonly removeMarketplace: (name: string) => Effect.Effect<void, PluginRegistryError>;
    /** Installs a plugin; `cloud` carries project and team writes. Answers its servers that sign in. */
    readonly install: (request: InstallRequest, cloud?: CloudWrites) => Effect.Effect<ReadonlyArray<AuthServer>, PluginRegistryError>;
    readonly uninstall: (request: Omit<InstallRequest, "policy" | "connection">, cloud?: CloudWrites) => Effect.Effect<void, PluginRegistryError>;
    /**
     * On or off for me; a Required plugin cannot be turned off. `onlyHere`: for the project at `cwd` alone (its own
     * switch, Settings repoSwitches), leaving every other project as it is.
     */
    readonly setEnabled: (pluginId: string, enabled: boolean, cwd?: string, onlyHere?: boolean) => Effect.Effect<void, PluginRegistryError>;
    /** Grants a credential a plugin of the marketplace declares (seen from `cwd`). Takes effect at each plugin process start. */
    readonly grant: (marketplace: string, name: string, value: Redacted.Redacted<string>, cwd?: string) => Effect.Effect<void, PluginRegistryError>;
    readonly revoke: (marketplace: string, name: string, cwd?: string) => Effect.Effect<void, PluginRegistryError>;
    /** The enabled plugins and their bundle, for a session about to start in `worktree` (its root, when it has one). */
    readonly session: (worktree?: string) => Effect.Effect<PluginSession, PluginRegistryError>;
    /**
     * The session a thread runs with: its first successful read, kept while its worktree stays the same. Its engine is
     * given this one (SessionPlugins), and the MCP hub reads from it which server each of the thread's keys names.
     */
    readonly forThread: (threadId: ThreadId, worktree: string | undefined) => Effect.Effect<PluginSession, PluginRegistryError>;
    /** Claude Agent options for a session (copies plugins into the state dir once). */
    readonly claudeAgent: (
      session: PluginSession,
    ) => Effect.Effect<ClaudeAgentPluginOptions, PluginRegistryError>;
    /** Personal MCP servers, each with its credential names and which are granted. */
    readonly servers: Effect.Effect<ReadonlyArray<PersonalServer>, PluginRegistryError>;
    /** Adds (or with `replace`, replaces) a personal server. */
    readonly saveServer: (server: PluginServer, replace: boolean) => Effect.Effect<void, PluginRegistryError>;
    /** Removes a personal server and revokes its credentials. */
    readonly removeServer: (name: string) => Effect.Effect<void, PluginRegistryError>;
    /** On or off everywhere; with `onlyHere`, for the project at `cwd` alone (Settings repoServerSwitches). */
    readonly setServerEnabled: (name: string, enabled: boolean, cwd?: string, onlyHere?: boolean) => Effect.Effect<void, PluginRegistryError>;
    /** The project at `cwd`'s own switches for personal servers, by server name: each wins over the server's own there. */
    readonly serverSwitches: (cwd?: string) => Effect.Effect<ReadonlyMap<string, boolean>, PluginRegistryError>;
    /** Whether a plugin's hooks run (default: they do not): trust holds for its files as they are now. */
    readonly setTrusted: (pluginId: string, trusted: boolean, cwd?: string) => Effect.Effect<void, PluginRegistryError>;
    /** Forgets Cloud's cached installs (after a write). */
    readonly refreshCloud: Effect.Effect<void>;
    /**
     * The repository keys sharing a project's plugins: Caveman Cloud's project
     * for `repository` when signed in, else the project kept here. Its own first.
     */
    readonly projectRepos: (projectId: string, repository: string | undefined) => Effect.Effect<ReadonlyArray<string>, PluginRegistryError>;
    /** Replaces the repositories of a project kept here (signed out). */
    readonly setProjectRepos: (projectId: string, repos: ReadonlyArray<string>) => Effect.Effect<void, PluginRegistryError>;
    /** Whether this runtime is signed in to Caveman Cloud. */
    readonly linked: Effect.Effect<boolean>;
    /** The person's org role at sign-in (owner and admin connect shared accounts); undefined when unknown. */
    readonly role: Effect.Effect<"owner" | "admin" | "member" | undefined>;
    /** The hidden capability block for each mentioned plugin that is on in `cwd` (composer @plugin). */
    readonly capabilities: (ids: ReadonlyArray<string>, cwd: string | undefined) => Effect.Effect<ReadonlyArray<string>, PluginRegistryError>;
  }
>()("caveman/plugins/PluginRegistry") {}

/** A personal server as mcp.list shows it. */
export interface PersonalServer {
  readonly server: PluginServer;
  readonly credentials: ReadonlyArray<{ readonly name: string; readonly granted: boolean }>;
}

export interface PluginSession {
  readonly plugins: ReadonlyArray<LoadedPlugin>;
  readonly bundle: PluginBundle;
  /**
   * Bundle keys of servers only the runtime's MCP hub may reach: they sign in
   * with runtime-held OAuth tokens or the runtime's GitHub login, so no
   * engine gets their URL directly.
   */
  readonly hubOnly: ReadonlyArray<string>;
  /** How each hub-only key signs in, with its URL; a plugin's server names the plugin and the session's repository (shared accounts). */
  readonly remoteAuth: Readonly<Record<string, { readonly auth: "oauth" | "github"; readonly url: string; readonly plugin?: string; readonly repository?: string }>>;
  /** Its plugins whose hooks are off because their trust dropped (KnownPlugins.trustDropped), by id and the name people know. */
  readonly trustDropped?: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

const isPanel = Schema.is(PanelContribution);

const fail = (cause: unknown) =>
  new PluginRegistryError({ message: cause instanceof Error ? cause.message : String(cause) });
const invalid = (message: string) => new PluginRegistryError({ message, invalid: true });

/** A plugin's MCP servers that sign in (`auth` in its .mcp.json). */
export const authServers = (plugin: Pick<LoadedPlugin, "mcpServers">): AuthServer[] =>
  Object.entries(plugin.mcpServers).flatMap(([server, config]) =>
    "url" in config && config.auth !== undefined ? [{ server, url: config.url, auth: config.auth, ...(config.unavailable === undefined ? {} : { unavailable: config.unavailable }) }] : [],
  );

const text = (value: unknown) => (typeof value === "string" && value.trim() !== "" ? value.trim() : undefined);

/** A plugin's PluginInfo fields from its files (or, not fetched yet, its marketplace entry). */
function infoOf(
  id: string,
  plugin: LoadedPlugin | undefined,
  entry: MarketEntry | undefined,
  input: { readonly enabled: boolean; readonly trusted: boolean; readonly trustDropped?: boolean; readonly sandbox: Sandbox; readonly hookPolicy: Parameters<typeof lspServersOffered>[1]; readonly granted: ReadonlyArray<string> },
): PluginListing {
  if (plugin === undefined) {
    return {
      id,
      name: entry?.name ?? id.split("@")[0]!,
      ...(text(entry?.fields.version) === undefined ? {} : { version: text(entry?.fields.version)! }),
      ...(text(entry?.fields.description) === undefined ? {} : { description: text(entry?.fields.description)! }),
      enabled: input.enabled,
      skills: [],
      commands: [],
      agents: [],
      hooks: [],
      mcp_servers: [],
      panels: [],
      ...(entry?.origin.kind === "unsupported" ? { problems: [`${entry.name}: ${entry.origin.why}`] } : {}),
    };
  }
  const offered = lspServersOffered(plugin, input.hookPolicy);
  const refused = Object.keys(plugin.lspServers).filter((name) => !(name in offered));
  const offeredMonitors = monitorsOffered(plugin, input.hookPolicy);
  const refusedMonitors = plugin.monitors.map((m) => m.name).filter((name) => !(name in offeredMonitors));
  return {
    id,
    name: plugin.name,
    ...(plugin.version === undefined ? {} : { version: plugin.version }),
    ...(plugin.description === undefined ? {} : { description: plugin.description }),
    enabled: input.enabled,
    skills: plugin.skills.map((s) => s.name),
    commands: plugin.commands.map((c) => c.name),
    agents: plugin.agents.map((a) => a.name),
    // What trust covers, frontmatter hooks included: no hook runs under trust that was not listed.
    hooks: [...new Set(Object.keys(allHooks(plugin)))],
    hook_entries: Object.entries(allHooks(plugin)).flatMap(([event, matchers]) =>
      matchers.flatMap((m) =>
        m.hooks.map((hook) => ({
          event,
          ...(m.matcher === undefined ? {} : { matcher: m.matcher }),
          type: hook.type,
          ...(hook.command === undefined ? {} : { command: hook.command }),
          ...(hook.args === undefined ? {} : { args: [...hook.args] }),
          ...(hook.prompt === undefined ? {} : { prompt: hook.prompt }),
        })),
      ),
    ),
    trusted: input.trusted,
    ...(input.trustDropped === true ? { trust_dropped: true } : {}),
    mcp_servers: Object.keys(plugin.mcpServers),
    sse_servers: Object.entries(plugin.mcpServers).flatMap(([name, server]) => (server.type === "sse" ? [name] : [])),
    lsp_servers: Object.keys(offered),
    monitors: Object.keys(offeredMonitors),
    // A panel whose entry the protocol would refuse is not offered.
    panels: (plugin.contributes.panels ?? []).filter(isPanel),
    tools: (plugin.contributes.tools ?? []).map((tool) => ({ ...tool })),
    connectors: (plugin.contributes.connectors ?? []).map((connector) => ({
      ...connector,
      granted: (connector.credentials ?? []).filter((name) => input.granted.includes(name)),
    })),
    containment: CONTAINMENT[input.sandbox],
    // What is always in context, before any MCP server has listed its tools (the hub adds those).
    idle_tokens_estimate: Math.ceil(
      Buffer.byteLength(
        [...plugin.rules.map((r) => r.text), ...plugin.skills.map((sk) => `- ${sk.name}: ${sk.description} (${sk.path})`)].join("\n"),
        "utf8",
      ) / 4,
    ),
    unmeasured_servers: Object.keys(plugin.mcpServers),
    problems: [
      ...plugin.problems,
      ...refused.map((name) => `${plugin.name}: LSP server ${name} left out: it reads \${...} beyond the plugin root`),
      ...refusedMonitors.map((name) => `${plugin.name}: monitor ${name} left out: it reads \${...} beyond the plugin root`),
    ],
  };
}

/** The interface fields a plugin presents, from its files or (not fetched yet) its marketplace entry. */
function presentationOf(plugin: LoadedPlugin | undefined, entry: MarketEntry | undefined) {
  const ui = plugin?.interface;
  const fields = entry?.fields;
  const entryUi = (typeof fields?.interface === "object" && fields.interface !== null ? fields.interface : {}) as Record<string, unknown>;
  return {
    display_name: ui?.display_name ?? text(entryUi.displayName),
    short_description: ui?.short_description ?? text(entryUi.shortDescription) ?? text(fields?.description),
    developer: ui?.developer ?? text(entryUi.developerName),
    category: text(fields?.category) ?? ui?.category ?? text(entryUi.category),
    logo: ui?.logo,
    logo_dark: ui?.logo_dark,
    brand_color: ui?.brand_color,
    brand_color_dark: ui?.brand_color_dark,
    capabilities: ui?.capabilities,
  };
}
const defined = <T extends object>(fields: T) =>
  Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };

export const make = Effect.fn("PluginRegistry.make")(function* () {
  const settingsService = yield* ServerSettingsService;
  const config = yield* ServerConfig;
  const broker = yield* CredentialBroker;
  const grants = yield* Effect.serviceOption(CredentialGrants);
  const computer = yield* CloudComputer;
  const link = yield* CloudLinkState;
  const spacesDir = path.join(config.stateDir, "spaces");
  const projectionDir = path.join(config.stateDir, "plugins", "claude");
  // Brokered values for stdio servers, one 0600 file per server, inside the denied state dir.
  // Files from an earlier run serve no running session.
  const credentialsDir = path.join(config.stateDir, "plugin-credentials");
  // Best-effort: leftover files serve no running session and sit inside the denied state
  // dir. A failure here must never stop the runtime from starting.
  yield* Effect.tryPromise(() => fs.rm(credentialsDir, { recursive: true, force: true })).pipe(Effect.ignore);
  const contain = {
    ...containmentFor(config.stateDir),
    // Plugins share one package cache: HOME is not writable to them.
    // ponytail: one cache for every plugin (one could plant a package another runs); per plugin if that matters.
    cache: path.join(config.providerStatusCacheDir, "plugins"),
    worktrees: config.worktreesDir,
  };
  // The bubblewrap probe answers in the background (detectSandboxLater); what lists or launches a plugin waits for it.
  const sandboxProbe = detectSandboxLater();
  const sandboxReady = Effect.promise(() => sandboxProbe);
  const onComputerTools = toolsSocket() !== undefined;
  const catalog = catalogDir();
  const home = os.homedir();
  // ponytail: one lock serialises every Settings read-modify-write below, so concurrent
  // adds/removes/toggles/grants cannot lose each other's change. The registry is the only
  // writer of the plugins settings domain (cloudSync.ts's computer apply takes the same lock). Per-marketplace locks if this ever gates throughput.
  const settingsLock = yield* PluginSettingsLock;
  const lock = <A, E, R>(effect: Effect.Effect<A, E, R>) => settingsLock.withPermits(1)(effect);

  // ponytail: the last few session-time failures, runtime-wide; per thread if the UI must name the session.
  const recent: string[] = [];
  const note = (line: string) =>
    Effect.sync(() => {
      recent.push(line);
      if (recent.length > 10) recent.shift();
    });

  // Checkouts in flight (shared by concurrent callers), verified ones and recent failures. A pinned
  // checkout is verified (checkoutSpace re-hashes it) once per runtime, not on every read: hashing
  // every checkout took seconds and every plugin and marketplace read waited on it. One that has
  // gone from disk is checked out again.
  interface Checkout {
    readonly promise: Promise<string>;
    readonly startedAt: number;
    dir?: string;
    failedAt?: number;
  }
  const checkouts = new Map<string, Checkout>();
  const checkout = (space: { readonly url: string; readonly commit: string }): Checkout => {
    const key = `${space.url}\0${space.commit}`;
    const entry = checkouts.get(key);
    if (
      entry !== undefined &&
      (entry.dir !== undefined ? existsSync(entry.dir) : entry.failedAt === undefined || Date.now() - entry.failedAt < RETRY_FAILED_MS)
    ) {
      return entry;
    }
    const fresh: Checkout = {
      promise: checkoutSpace({ ...space, spacesDir, onReplaced: (reason) => Effect.runSync(note(reason)) }),
      startedAt: Date.now(),
    };
    checkouts.set(key, fresh);
    fresh.promise.then(
      (dir) => (fresh.dir = dir),
      () => (fresh.failedAt = Date.now()),
    );
    return fresh;
  };
  /** A checkout's directory, waiting at most until CHECKOUT_WAIT_MS after it started. */
  const checkedOut = (space: { readonly url: string; readonly commit: string }) =>
    Effect.suspend(() => {
      const { promise, startedAt, failedAt } = checkout(space);
      const done = Effect.tryPromise({ try: () => promise, catch: fail });
      // A recent failure is reported as it is; a checkout in flight only until its wait is up.
      return failedAt !== undefined
        ? done
        : done.pipe(
            Effect.timeoutOrElse({
              duration: Math.max(0, startedAt + CHECKOUT_WAIT_MS - Date.now()),
              orElse: () => Effect.fail(fail(`${space.url}: still checking out; its plugins arrive with a later session`)),
            }),
          );
    });
  const statusOf = (message: string): Market["status"] => (message.includes("still checking out") ? "checking_out" : "failed");

  // A pinned checkout and the catalog never change under a path: read once.
  const readOnce = new Map<string, Promise<unknown>>();
  const once = <A>(key: string, read: () => Promise<A>): Promise<A> => {
    let found = readOnce.get(key) as Promise<A> | undefined;
    if (found === undefined) {
      found = read();
      readOnce.set(key, found);
      found.catch(() => readOnce.delete(key));
    }
    return found;
  };
  const loadRoot = (root: string, name: string, immutable: boolean, own: boolean) =>
    immutable ? once(`space\0${root}\0${name}\0${own}`, () => loadSpace(root, name, name, own)) : loadSpace(root, name, name, own);

  /** A marketplace from a root on disk: its entries in order, each plugin read in place where it lives there. */
  const marketAt = (
    root: string,
    base: Omit<Market, "entries" | "status" | "problems" | "displayName" | "name"> & { readonly name?: string; readonly displayName?: string },
    immutable: boolean,
  ) =>
    Effect.tryPromise({
      try: async (): Promise<Market> => {
        // Added from this computer by the person (a folder, a repository on disk): its entries may name ssh and file:// repositories.
        const own = base.kind === "personal" || (base.kind === "added" && !/^https:\/\//.test(base.source));
        // The name first: plugin ids carry it.
        const first = await loadRoot(root, base.name ?? "", immutable, own);
        const name = base.name ?? first.market?.name ?? path.basename(root);
        const loaded = name === (base.name ?? "") ? first : await loadRoot(root, name, immutable, own);
        const entries =
          loaded.market === undefined
            ? loaded.plugins.map((plugin) => ({ name: plugin.name, plugin }))
            : loaded.market.entries.map((entry) => ({ name: entry.name, entry, plugin: loaded.plugins.find((p) => p.name === entry.name) }));
        return {
          ...base,
          name,
          displayName: base.displayName ?? loaded.market?.displayName ?? name,
          status: "ready",
          problems: loaded.problems,
          entries,
        };
      },
      catch: fail,
    });

  const emptyMarket = (base: Omit<Market, "entries" | "status" | "problems">, problem: string): Market => ({ ...base, status: statusOf(problem), problems: [problem], entries: [] });

  // Caveman Cloud: what applies to a repository, read again after CLOUD_TTL_MS. When Cloud does not
  // answer, the last answer for that repository stays (kept on disk across restarts, per org: another
  // org's never stands in), so a Required plugin never drops out because Cloud is down; the problem
  // says so, and Cloud is asked again after CLOUD_RETRY_MS.
  const cloudCache = new Map<string, { readonly at: number; readonly value: Promise<CloudPlugins | undefined> }>();
  const cloudProblem: { last?: string | undefined } = {};
  const lastGoodFile = path.join(config.stateDir, "plugins", "cloud-installs.json");
  const lastGood = (): Record<string, CloudPlugins> => {
    try {
      return JSON.parse(readFileSync(lastGoodFile, "utf8")) as Record<string, CloudPlugins>;
    } catch {
      return {};
    }
  };
  const keepGood = (key: string, value: CloudPlugins | undefined) =>
    fs
      .mkdir(path.dirname(lastGoodFile), { recursive: true })
      .then(() => {
        const all = lastGood();
        if (value === undefined) delete all[key];
        else all[key] = value;
        return fs.writeFile(lastGoodFile, JSON.stringify(all), { mode: 0o600 });
      })
      .catch(() => undefined);
  const cloudFor = (repository: string | undefined) =>
    Effect.promise(async () => {
      const identity = readIdentity(computer?.linkDir ?? linkDirOf(config.stateDir));
      if (identity === undefined) return undefined;
      const key = `${identity.organizationId}\0${repository ?? ""}`;
      const cached = cloudCache.get(key);
      if (cached !== undefined && Date.now() - cached.at < CLOUD_TTL_MS) return cached.value;
      const value = runtimePlugins(identity, link, repository).then(
        async (answer) => {
          cloudProblem.last = undefined;
          await keepGood(key, answer);
          return answer;
        },
        async (cause: Error) => {
          cloudProblem.last = `Couldn't reach Caveman: team and project plugins are the last ones it gave (${cause.message})`;
          // Asked again after CLOUD_RETRY_MS, the last good answer meanwhile.
          cloudCache.set(key, { at: Date.now() - CLOUD_TTL_MS + CLOUD_RETRY_MS, value });
          return lastGood()[key] ?? (await cached?.value.catch(() => undefined));
        },
      );
      cloudCache.set(key, { at: Date.now(), value });
      return value;
    });

  const pluginsNow = settingsService.getSettings.pipe(
    Effect.mapError(fail),
    Effect.map((settings) => settings.plugins),
  );
  const update = (patch: NonNullable<Parameters<typeof settingsService.updateSettings>[0]["plugins"]>) =>
    settingsService.updateSettings({ plugins: patch }).pipe(Effect.mapError(fail), Effect.asVoid);

  /** Ids written while the catalog was named `caveman` move to its name now, once. */
  let catalogRenamed = false;
  const migrateCatalog = Effect.gen(function* () {
    if (catalogRenamed) return;
    yield* lock(
      Effect.gen(function* () {
        const next = migrateCatalogName(yield* pluginsNow);
        if (next !== undefined) yield* update(next);
      }),
    );
    catalogRenamed = true;
  });

  /** Connectors (personal servers) become the catalog plugins they now are, once. */
  let connectorsMoved = false;
  const migrateConnectorServers = Effect.gen(function* () {
    if (connectorsMoved || catalog === undefined) return;
    if (!(yield* pluginsNow).servers.some((s) => s.source === "connector")) {
      connectorsMoved = true;
      return;
    }
    const market = yield* marketAt(catalog, { name: CATALOG_NAME, kind: "caveman", source: "caveman", key: "caveman:catalog", shareable: "yes" }, true).pipe(Effect.option);
    if (Option.isNone(market)) return;
    const urls = new Map(market.value.entries.flatMap((e) => (e.plugin === undefined ? [] : [[`${e.name}@${CATALOG_NAME}`, authServers(e.plugin).map((a) => a.url)] as const])));
    yield* lock(
      Effect.gen(function* () {
        const next = migrateConnectors(yield* pluginsNow, CONNECTOR_PLUGINS, urls);
        if (next !== undefined) yield* update(next);
      }),
    );
    connectorsMoved = true;
  });

  /**
   * Spaces (Settings before marketplaces) become marketplaces and installs,
   * each once its checkout is read (marketplaces.ts migrateSpaces). One whose
   * checkout is not there yet waits for a later call.
   */
  const migrate = Effect.gen(function* () {
    yield* migrateCatalog;
    yield* migrateConnectorServers;
    if ((yield* pluginsNow).spaces.length === 0) return;
    const read = new Map<string, SpaceContents>();
    for (const space of (yield* pluginsNow).spaces) {
      const dir = yield* checkedOut(space).pipe(Effect.option);
      if (Option.isNone(dir)) continue;
      const loaded = yield* Effect.tryPromise(() => loadSpace(dir.value, "_")).pipe(Effect.option);
      if (Option.isNone(loaded)) continue;
      read.set(`${space.url}\0${space.commit}`, {
        marketplace: loaded.value.market?.name,
        // Only plugins that loaded were ever on in a space; a broken or remote entry was not.
        plugins: loaded.value.plugins.map((p) => p.name),
      });
    }
    if (read.size === 0) return;
    yield* lock(
      Effect.gen(function* () {
        const plugins = yield* pluginsNow;
        yield* update(migrateSpaces(plugins, (space) => read.get(`${space.url}\0${space.commit}`)));
      }),
    );
  });

  /** The marketplaces visible from `cwd` (its repository's too), in tab order; a name taken earlier is left out. */
  const marketsAt = (settings: PluginSettings, cwd: string | undefined, cloud: CloudPlugins | undefined, declared: RepoDeclared, repository: string | undefined) =>
    Effect.gen(function* () {
      const out: Market[] = [];
      const catalogBase = { name: CATALOG_NAME, kind: "caveman" as const, source: "caveman", key: "caveman:catalog", shareable: "yes" as const };
      if (catalog !== undefined) {
        out.push(yield* marketAt(catalog, catalogBase, true).pipe(Effect.catch((error) => Effect.succeed(emptyMarket({ ...catalogBase, displayName: "Caveman" }, error.message)))));
      }
      // A git repository on a host teammates can fetch (https, as Caveman Cloud takes it) can be added to the team.
      const teamable = (url: string, ref: string | undefined): Pick<Market, "shareable" | "team"> =>
        /^https:\/\/[^\s@]+$/.test(url) ? { shareable: "add_to_team", team: { repo: url.replace(/\.git$/, ""), ...(ref === undefined ? {} : { ref }) } } : { shareable: "no" };
      const git = (name: string, kind: Market["kind"], url: string, commit: string, ref: string | undefined, key = url) => {
        const base = { name, displayName: name, kind, source: url, commit, ...(ref === undefined || ref === "" ? {} : { ref }), key, ...(kind === "team" ? { shareable: "yes" as const } : teamable(url, ref)) };
        return checkedOut({ url, commit }).pipe(
          Effect.flatMap((dir) => marketAt(dir, base, true)),
          Effect.catch((error) => Effect.succeed(emptyMarket(base, error.message))),
        );
      };
      const team = yield* Effect.forEach(
        (cloud?.marketplaces ?? []).filter((m) => COMMIT.test(m.commit)),
        (m) => {
          const url = cloudRepoUrl(m.repo);
          if (url === undefined) {
            const base = { name: m.name, displayName: m.name, kind: "team" as const, source: m.repo, key: m.repo, shareable: "yes" as const };
            return Effect.succeed(emptyMarket(base, `${m.repo}: Caveman Code fetches team marketplaces over https only`));
          }
          // The same repository the person added under the same name (an org Space they had added): one marketplace,
          // under the key its credentials were granted with.
          const mine = settings.marketplaces.find((a) => a.name === m.name && a.source.kind === "git" && sameRepoUrl(a.source.url, url));
          return git(m.name, "team", url, m.commit, m.ref, mine?.source.kind === "git" ? mine.source.url : url);
        },
        { concurrency: "unbounded" },
      );
      out.push(...team);
      const added = yield* Effect.forEach(
        settings.marketplaces.filter(({ name, source }) => !team.some((t) => t.name === name && source.kind === "git" && t.key === source.url)),
        ({ name, source }) => {
          if (source.kind === "git") return git(name, "added", source.url, source.commit, source.ref);
          const base = { name, kind: "added" as const, source: source.path, key: source.path, shareable: "no" as const };
          return marketAt(source.path, base, false).pipe(Effect.catch((error) => Effect.succeed(emptyMarket({ ...base, displayName: name }, error.message))));
        },
        { concurrency: "unbounded" },
      );
      out.push(...added);
      // Spaces whose checkout never read (migrateSpaces leaves them): listed so they can be removed, grants and all.
      for (const space of settings.spaces) {
        out.push({ name: spaceIdFor(space.url), displayName: spaceNameFor(space.url), kind: "added", source: space.url, commit: space.commit, key: space.url, shareable: "no", status: "failed", problems: ["It could not be read as a marketplace: remove it, or check that its repository is reachable."], entries: [] });
      }
      // Codex's personal marketplace, read in place.
      if (existsSync(path.join(home, ".agents", "plugins", "marketplace.json"))) {
        const base = { kind: "personal" as const, source: path.join(home, ".agents", "plugins"), key: `folder:${home}`, shareable: "no" as const };
        out.push(yield* marketAt(home, base, false).pipe(Effect.catch((error) => Effect.succeed(emptyMarket({ ...base, name: "personal-marketplace", displayName: "Personal" }, error.message)))));
      }
      if (cwd !== undefined && MARKETPLACE_FILES.some((file) => existsSync(path.join(cwd, file)))) {
        const own = repository === undefined ? undefined : cloudRepoUrl(repository);
        const base = { kind: "repo" as const, source: cwd, key: `folder:${cwd}`, ...(own === undefined ? { shareable: "no" as const } : teamable(own, undefined)) };
        out.push(yield* marketAt(cwd, base, false).pipe(Effect.catch((error) => Effect.succeed(emptyMarket({ ...base, name: path.basename(cwd), displayName: path.basename(cwd) }, error.message)))));
      }
      // Marketplaces the repository's .claude/settings.json names: a folder in it is read in place; a git one is
      // offered (its plugins run code, so it is added on the person's click, as Claude Code asks).
      const known = new Set(out.map((m) => m.name));
      for (const { name, source } of declared.marketplaces) {
        if (known.has(name)) continue;
        if (source.kind === "folder") {
          const base = { name, kind: "repo" as const, source: source.path, key: `folder:${source.path}`, shareable: "no" as const };
          out.push(yield* marketAt(source.path, base, false).pipe(Effect.catch((error) => Effect.succeed(emptyMarket({ ...base, displayName: name }, error.message)))));
        } else {
          out.push({ name, displayName: name, kind: "repo", source: source.url, key: source.url, ...teamable(source.url, source.ref), status: "ready", problems: ["This repository uses it: add it to see its plugins."], entries: [] });
        }
      }
      const seen = new Set<string>(RESERVED_MARKETS);
      return out.filter((m) => {
        if (seen.has(m.name)) {
          recent.push(`${m.source}: a marketplace named ${m.name} is already known; this one is left out`);
          if (recent.length > 10) recent.shift();
          return false;
        }
        seen.add(m.name);
        return true;
      });
    });

  /** An installed plugin's files: in place, or a remote entry's checkout at its pinned commit. */
  const filesOf = (market: Market, row: Market["entries"][number], record: InstallRecord) =>
    Effect.gen(function* () {
      if (row.plugin !== undefined) return row.plugin;
      const origin = row.entry?.origin;
      if (origin === undefined || origin.kind === "unsupported") return yield* Effect.fail(fail(`${record.id}: ${origin?.why ?? "not in its marketplace"}`));
      if (origin.kind === "local") return yield* Effect.fail(fail(`${record.id}: its files could not be read`));
      // The files are always the entry's own repository and folder: an install (Cloud's above all) only picks the
      // commit, and only of that repository, so it can never point anyone at other code or another folder.
      const commit = (record.source !== undefined && sameRepoUrl(record.source.url, origin.url) ? record.commit : undefined) ?? origin.sha;
      if (commit === undefined) return yield* Effect.fail(fail(`${record.id}: install it again to pin it to a commit`));
      const dir = yield* checkedOut({ url: origin.url, commit });
      const root = origin.path === undefined ? dir : path.join(dir, origin.path);
      const fields = row.entry!.fields;
      return yield* Effect.tryPromise({
        try: () => once(`plugin\0${root}\0${market.name}\0${JSON.stringify(fields)}`, () => loadPlugin(root, market.name, { entry: fields })),
        catch: fail,
      });
    });

  const knownAt = (cwd: string | undefined) =>
    Effect.gen(function* () {
      yield* migrate;
      const settings = yield* pluginsNow;
      const problems: string[] = [];
      const repository = cwd === undefined ? undefined : repoKeyOf(yield* Effect.promise(() => readRepositoryLink(cwd).catch(() => undefined)));
      const cloud = yield* cloudFor(repository);
      const declared: RepoDeclared = cwd === undefined ? { marketplaces: [], enabled: [] } : yield* Effect.promise(() => readRepoDeclared(cwd));
      const markets = yield* marketsAt(settings, cwd, cloud, declared, repository);
      const byDefault = (kinds: ReadonlyArray<Market["kind"]>) =>
        markets.filter((m) => kinds.includes(m.kind)).flatMap((m) => m.entries.filter((e) => e.entry?.installation === "installed_by_default").map((e) => `${e.name}@${m.name}`));
      // Installed by default in the catalog or a team marketplace: on, as Codex does (Caveman or an admin chose it).
      const chosen = byDefault(["caveman", "team"]).map((id): InstallRecord => ({ id, scope: id.endsWith(`@${CATALOG_NAME}`) ? "repo" : "team", policy: "default" }));
      // What the repository asks for (its marketplace's defaults, its enabledPlugins) is only offered until the person turns it on there.
      const suggested = [...byDefault(["repo"]), ...declared.enabled];
      const consent = repoConsentKey(cwd, repository);
      const installs = effectiveInstalls([...localRecords(settings, consent, suggested), ...cloudRecords(cloud), ...chosen], settings.disabled, switchesAt(settings.repoSwitches, consent));
      const plugins: Array<{ plugin: LoadedPlugin; enabled: boolean }> = [];
      const loadedMarkets = markets.map((m) => ({ ...m, entries: [...m.entries] }));
      for (const install of installs.values()) {
        if (!install.installed) continue;
        const at = install.id.lastIndexOf("@");
        const market = loadedMarkets.find((m) => m.name === install.id.slice(at + 1));
        const index = market?.entries.findIndex((e) => e.name === install.id.slice(0, at)) ?? -1;
        if (market === undefined || index < 0) {
          problems.push(`${install.id}: ${market === undefined ? `its marketplace ${install.id.slice(at + 1)} is not added here` : "its marketplace no longer lists it"}`);
          continue;
        }
        const row = market.entries[index]!;
        const loaded = yield* filesOf(market, row, install.record).pipe(
          Effect.map((plugin) => ({ plugin })),
          Effect.catch((error) => Effect.succeed({ problem: error.message })),
        );
        if ("problem" in loaded) {
          problems.push(loaded.problem);
          continue;
        }
        market.entries[index] = { ...row, plugin: loaded.plugin };
        plugins.push({ plugin: { ...loaded.plugin, origin: { url: market.key, commit: market.commit ?? install.record.commit ?? "" } }, enabled: install.on });
      }
      // Trust holds only for the files that were trusted: any other digest (an update, an edit in place, another source) drops it.
      const trusted: string[] = [];
      const dropped: string[] = [];
      for (const entry of settings.trusted) {
        const id = trustedId(entry);
        const loaded = plugins.find((p) => p.plugin.id === id)?.plugin;
        if (loaded === undefined) continue;
        if (entry === trustEntry(id, yield* digestOf(loaded, entryOf(loadedMarkets, loaded)))) trusted.push(id);
        else if (Object.keys(allHooks(loaded)).length > 0) dropped.push(id);
      }
      const trustDropped = [...new Set(dropped)].filter((id) => !trusted.includes(id));
      for (const m of loadedMarkets) problems.push(...m.problems);
      // A project's own switch for a personal server wins over the server's there.
      const serversHere = switchesAt(settings.repoServerSwitches, consent);
      const personal = personalPlugin(
        settings.servers.map((s) => (serversHere.has(s.name) ? { ...s, enabled: serversHere.get(s.name)! } : s)),
        path.join(config.stateDir, "personal"),
      );
      if (personal !== undefined) plugins.push({ plugin: personal, enabled: true });
      // A Cloud computer's copy of This Mac's home skills (cloudLink/profile.ts), loaded like a plugin.
      const profileSkills = yield* Effect.tryPromise(() =>
        fs.realpath(currentProfileSkills(config.stateDir)).then(
          (root) => loadPlugin(root, PROFILE_SPACE_ID, { entry: { name: "my-skills", description: "Your skills from This Mac", skills: "./" } }),
          () => undefined,
        ),
      ).pipe(Effect.catch((error) => Effect.sync(() => void problems.push(`your skills from This Mac: ${error.message}`))));
      if (profileSkills !== undefined && profileSkills.skills.length > 0) plugins.push({ plugin: profileSkills, enabled: true });
      if (cloudProblem.last !== undefined) problems.push(cloudProblem.last);
      return {
        plugins,
        markets: loadedMarkets,
        installs,
        trusted,
        trustDropped,
        ...(cloudProblem.last === undefined ? {} : { cloudProblem: cloudProblem.last }),
        ...(repository === undefined ? {} : { repository }),
        ...(cloud?.project === undefined ? {} : { project: cloud.project }),
        problems: [...problems, ...recent],
      } satisfies KnownPlugins;
    });
  const known = knownAt(undefined);

  /**
   * My skills in ~/.agents/skills (where skill.save me and imports write) as a
   * plugin Claude Agent loads: Codex reads that folder itself and the Caveman
   * engine is given it (repoSkillRoots' sibling), but Claude Agent reads only
   * ~/.claude/skills. A copy without links or key files, made again when the
   * folder changes. Not on a Cloud computer: the profile brings them there.
   */
  const homeSkills = path.join(home, ".agents", "skills");
  // The copy of ~/.agents/skills by the stamp of what it is made from, kept while the folder is unchanged (watched):
  // a turn re-reads none of it, and a turn that starts while a session is still making it waits for that one.
  let homeSkillsCopy: { readonly key: string; readonly plugin: Promise<LoadedPlugin | undefined> } | undefined;
  const homeSkillsPlugin = async (): Promise<LoadedPlugin | undefined> => {
    if (onComputerTools || !existsSync(homeSkills)) return undefined;
    const source = await fs.realpath(homeSkills);
    const claudeSkills = (await fs.readdir(path.join(setupHomes(process.env, home).claudeDir, "skills")).catch(() => [] as string[])).sort();
    const stamp = await watchedTreeStamp(source);
    const key = `${source}\0${stamp}\0${claudeSkills.join("\0")}`;
    if (homeSkillsCopy?.key !== key) {
      const plugin = copyHomeSkills(source, stamp, claudeSkills);
      homeSkillsCopy = { key, plugin };
      plugin.catch(() => {
        if (homeSkillsCopy?.plugin === plugin) homeSkillsCopy = undefined;
      });
    }
    return homeSkillsCopy.plugin;
  };
  const copyHomeSkills = async (source: string, stamp: string, claudeSkills: ReadonlyArray<string>): Promise<LoadedPlugin | undefined> => {
    const parent = path.join(config.stateDir, "plugins", "home-skills");
    // What the copy was made from, by stamp: a runtime that starts again finds it without hashing the folder's files.
    const madeFrom = path.join(parent, "made-from.json");
    const made = await fs.readFile(madeFrom, "utf8").then((text) => JSON.parse(text) as { stamp?: string; claudeSkills?: string[]; target?: string }, () => undefined);
    const reused =
      made?.stamp === stamp && made.claudeSkills?.join("\0") === claudeSkills.join("\0") && typeof made.target === "string" && path.dirname(made.target) === parent && existsSync(made.target)
        ? made.target
        : undefined;
    const target = reused ?? path.join(parent, createHash("sha256").update(`${await treeDigest(source)}\0${claudeSkills.join("\0")}`).digest("hex").slice(0, 16));
    if (!existsSync(target)) {
      const tmp = `${target}.tmp-${process.pid}-${randomUUID()}`;
      await fs.mkdir(path.join(tmp, ".claude-plugin"), { recursive: true });
      await fs.writeFile(path.join(tmp, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "my-skills", description: "Your skills in ~/.agents/skills" }));
      // A skill Claude already reads from ~/.claude/skills (an installer links it there too) is not copied again.
      const claudeHas = new Set(claudeSkills);
      await fs.cp(source, path.join(tmp, "skills"), {
        recursive: true,
        filter: async (file) =>
          file === source ||
          (!(path.dirname(file) === source && claudeHas.has(path.basename(file))) && !(await fs.lstat(file)).isSymbolicLink() && !KEY_FILE.test(path.basename(file))),
      });
      await fs.rename(tmp, target).catch(() => fs.rm(tmp, { recursive: true, force: true }));
      // Earlier copies serve no new session.
      for (const old of await fs.readdir(parent)) if (path.join(parent, old) !== target && old !== "made-from.json" && !old.includes(".tmp-")) await fs.rm(path.join(parent, old), { recursive: true, force: true });
    }
    if (reused === undefined) await fs.writeFile(madeFrom, JSON.stringify({ stamp, claudeSkills, target })).catch(() => undefined);
    const loaded = await loadPlugin(target, "home");
    return loaded.skills.length > 0 ? loaded : undefined;
  };

  /**
   * What hook trust is bound to: where the plugin comes from (its marketplace's
   * key), every file under its root, and the hooks its marketplace entry adds
   * from outside the root (`entry`, the fields it was loaded with). A pinned
   * checkout never changes, so its files' digest is read once; one read in
   * place is read again only when its files' sizes or times change (treeStamp).
   */
  const digests = new Map<string, string>();
  const stamped = new Map<string, { readonly stamp: string; readonly digest: string }>();
  const digestOf = (plugin: LoadedPlugin, entry: MarketEntry["fields"] | undefined) =>
    Effect.promise(async () => {
      const key = `${plugin.origin?.url ?? plugin.space}\0${plugin.root}`;
      const cached = digests.get(key);
      if (cached !== undefined) return cached;
      const pinned = plugin.root.startsWith(`${spacesDir}${path.sep}`) || (catalog !== undefined && plugin.root.startsWith(`${realpathOr(catalog)}${path.sep}`));
      const stamp = pinned ? undefined : await treeStamp(plugin.root).catch(() => undefined);
      const was = stamped.get(key);
      if (stamp !== undefined && was?.stamp === stamp) return was.digest;
      const tree = await treeDigest(plugin.root).catch(() => "unreadable");
      const digest = createHash("sha256").update(`${plugin.origin?.url ?? plugin.space}\0${tree}`).digest("hex");
      if (pinned) digests.set(key, digest);
      else if (stamp !== undefined) stamped.set(key, { stamp, digest });
      return digest;
    }).pipe(
      // Mixed in only when there are some, so trust kept for a plugin whose entry adds none still holds.
      Effect.map((files) => (entry?.hooks === undefined ? files : createHash("sha256").update(`${files}\0${JSON.stringify(entry.hooks)}`).digest("hex"))),
    );
  /** The marketplace entry fields an installed plugin was loaded with. */
  const entryOf = (markets: ReadonlyArray<Market>, plugin: LoadedPlugin) =>
    markets.find((m) => m.name === plugin.space)?.entries.find((e) => e.plugin?.id === plugin.id)?.entry?.fields;

  const isGranted = (key: string, name: string) =>
    Option.isSome(grants) ? grants.value.isGranted(key, name) : Effect.succeed(false);
  const grantedIn = (key: string, plugin: LoadedPlugin | undefined) =>
    Effect.filter(
      [...new Set((plugin?.contributes.connectors ?? []).flatMap((c) => c.credentials ?? []))],
      (name) => isGranted(key, name),
    );

  const listing = (q: { readonly marketplace?: string | undefined; readonly query?: string | undefined; readonly cwd?: string | undefined }) =>
    Effect.gen(function* () {
      const sandbox = yield* sandboxReady;
      const hookPolicy = { keep: [], ...contain, sandbox };
      const k = yield* knownAt(q.cwd);
      const loaded = new Map(k.plugins.map(({ plugin }) => [plugin.id, plugin]));
      const rows: ListedPlugin[] = [];
      for (const market of k.markets) {
        if (q.marketplace !== undefined && market.name !== q.marketplace) continue;
        for (const row of market.entries) {
          const id = `${row.name}@${market.name}`;
          const install = k.installs.get(id);
          if (row.entry?.installation === "not_available" && install?.installed !== true) continue;
          const plugin = loaded.get(id) ?? row.plugin;
          const info = infoOf(id, plugin, row.entry, {
            enabled: install?.on ?? false,
            trusted: k.trusted.includes(id),
            trustDropped: k.trustDropped.includes(id),
            sandbox,
            hookPolicy,
            granted: yield* grantedIn(market.key, plugin),
          });
          const presentation = presentationOf(plugin, row.entry);
          const summary: ListedPlugin["summary"] = {
            ...info,
            marketplace: market.name,
            installed: install?.installed ?? false,
            // A team or project install offered as Available names its scope and policy too, uninstalled.
            ...(install !== undefined && (install.installed || install.policy === "available") ? { scope: install.scope === "repo" ? ("project" as const) : install.scope } : {}),
            ...(install !== undefined && install.scope !== "me" && install.scope !== "repo" ? { policy: install.policy, connection: install.shared ? ("shared" as const) : ("personal" as const) } : {}),
            ...(install?.suggested === true ? { suggested: true } : {}),
            ...(install !== undefined && install.installed && install.on !== install.everywhere ? { here: install.on ? ("on" as const) : ("off" as const) } : {}),
            required: install?.required ?? false,
            interface: defined(presentation),
            includes: {
              skills: plugin?.skills.length ?? 0,
              mcp_servers: Object.keys(plugin?.mcpServers ?? {}).length,
              connections: plugin === undefined ? 0 : authServers(plugin).length,
              hooks: info.hook_entries?.length ?? 0,
              commands: plugin?.commands.length ?? 0,
              agents: plugin?.agents.length ?? 0,
              rules: plugin?.rules.length ?? 0,
            },
            ...(row.entry === undefined ? {} : { installation: row.entry.installation, authentication: row.entry.authentication }),
          };
          rows.push({ summary, authServers: plugin === undefined ? [] : authServers(plugin), plugin, market, shared: install?.shared === true });
        }
      }
      const needle = q.query?.trim().toLowerCase() ?? "";
      const matched =
        needle === ""
          ? rows
          : rows.filter(({ summary: s }) =>
              [s.name, s.description, s.interface.display_name, s.interface.short_description, s.interface.developer, s.interface.category].some((v) => v?.toLowerCase().includes(needle)),
            );
      const caveman = k.markets.find((m) => m.kind === "caveman");
      return {
        plugins: matched,
        featured: (caveman?.entries ?? []).map((e) => `${e.name}@${caveman!.name}`),
        categories: [...new Set(rows.flatMap((r) => (r.summary.interface.category === undefined ? [] : [r.summary.interface.category])))],
        ...(k.cloudProblem === undefined ? {} : { cloudProblem: k.cloudProblem }),
      };
    });

  /** The market and entry for a plugin id, from what `cwd` sees. */
  const entryFor = (k: KnownPlugins, id: string) => {
    const at = id.lastIndexOf("@");
    const market = at <= 0 ? undefined : k.markets.find((m) => m.name === id.slice(at + 1));
    const row = market?.entries.find((e) => e.name === id.slice(0, at));
    return market === undefined || row === undefined ? Effect.fail(invalid(`no plugin ${id}`)) : Effect.succeed({ market, row });
  };

  const bundleFor = (plugins: ReadonlyArray<LoadedPlugin>, worktree: string | undefined, trusted: ReadonlyArray<string>) =>
    settingsService.getSettings.pipe(
      Effect.mapError(fail),
      Effect.flatMap((settings) => Effect.map(sandboxReady, (sandbox) => ({ settings, sandbox }))),
      Effect.flatMap(({ settings, sandbox }) =>
        resolveBundle(plugins, {
          envAllowlist: settings.plugins.envAllowlist,
          trusted,
          contain,
          sandbox,
          credentialsDir,
          ...(worktree === undefined ? {} : { worktree }),
          ...(onComputerTools ? { brokeredInEnv: true } : {}),
          ...(ruleOf(link).known() === true ? { keysStayOutside: true } : {}),
        }).pipe(Effect.mapError(fail)),
      ),
      Effect.provideService(CredentialBroker, broker),
    );

  const session = (worktree?: string) =>
    Effect.gen(function* () {
      const k = yield* knownAt(worktree);
      const plugins = k.plugins.filter((p) => p.enabled).map((p) => p.plugin);
      const servers = (yield* pluginsNow).servers;
      const remoteAuth: Record<string, { auth: "oauth" | "github"; url: string; plugin?: string; repository?: string }> = {};
      // A server that signs in reaches engines only through the hub, like a connector. Each sign-in is keyed as its
      // server is in the bundle: a personal server whose name a plugin's server took has its full-id key there.
      for (const [key, { plugin, server }] of serverKeys(plugins)) {
        const config = plugin.mcpServers[server];
        if (plugin.space === PERSONAL_SPACE_ID) {
          const mine = servers.find((s) => s.name === server);
          if (mine?.auth !== undefined && mine.url !== undefined) remoteAuth[key] = { auth: mine.auth, url: mine.url };
        } else if (config !== undefined && "url" in config && config.auth !== undefined && config.unavailable === undefined) {
          remoteAuth[key] = { auth: config.auth, url: config.url, plugin: plugin.id, ...(k.repository === undefined ? {} : { repository: k.repository }) };
        }
      }
      const bundle = yield* bundleFor(plugins, worktree, k.trusted);
      // On a Cloud computer stdio servers start only through the hub: in the tools container, with
      // their keys in memory (McpHub.ts), so no engine's config ever holds one.
      const stdio = onComputerTools ? Object.entries(bundle.mcpServers).filter(([, server]) => server.type === "stdio").map(([key]) => key) : [];
      const trustDropped = plugins.filter((p) => k.trustDropped.includes(p.id)).map((p) => ({ id: p.id, name: p.interface.display_name ?? p.name }));
      return {
        plugins,
        bundle,
        hubOnly: [...new Set([...Object.keys(remoteAuth), ...stdio])],
        remoteAuth,
        ...(trustDropped.length === 0 ? {} : { trustDropped }),
      } satisfies PluginSession;
    }).pipe(Effect.tapError((error) => note(`session plugins: ${error.message}`)));

  // ponytail: one small entry per thread for the runtime's lifetime; evict on thread close if it matters.
  const threadSessions = new Map<string, { readonly worktree: string | undefined; readonly session: PluginSession }>();
  // A restored or resumed workspace gets a new worktree path, baked into its servers' write roots, so it is read again.
  const forThread = (threadId: ThreadId, worktree: string | undefined) =>
    Effect.suspend(() => {
      const cached = threadSessions.get(threadId);
      if (cached !== undefined && cached.worktree === worktree) return Effect.succeed(cached.session);
      return session(worktree).pipe(
        Effect.map((read) => {
          // Two first reads at once: the thread keeps the one that landed first, which its engine may already have.
          const landed = threadSessions.get(threadId);
          if (landed !== undefined && landed.worktree === worktree) return landed.session;
          threadSessions.set(threadId, { worktree, session: read });
          return read;
        }),
      );
    });

  /**
   * Checks out `commit` beside a marketplace's current pin and compares them:
   * which of its plugins had a file under them change (or moved, or went, or
   * had their manifest or hooks change, as from marketplace.json outside the
   * plugin). An Error when the new commit does not check out.
   */
  const compareCheckouts = async (name: string, before: { readonly url: string; readonly commit: string }, commit: string) => {
    let next: string;
    try {
      next = await checkout({ url: before.url, commit }).promise;
    } catch (cause) {
      return cause instanceof Error ? cause : new Error(String(cause));
    }
    const old = await checkout(before).promise.catch(() => undefined);
    const roots = async (dir: string | undefined) => {
      if (dir === undefined) return undefined;
      const real = await fs.realpath(dir);
      // Read as marketAt reads a marketplace the person added: one not on https may name file:// and ssh entries.
      const own = !/^https:\/\//.test(before.url);
      const { plugins, market } = await loadSpace(dir, name, name, own).catch(() => ({ plugins: [] as ReadonlyArray<LoadedPlugin>, market: undefined }));
      // Display fields change nothing that runs: editing them keeps trust.
      const running = ({ author: _a, homepage: _h, category: _c, interface: _i, keywords: _k, license: _l, ...rest }: { readonly [field: string]: unknown }) => rest;
      // A remote entry's files are fetched at install, not here: its source and fields stand for them.
      const remote = (market?.entries ?? []).flatMap((e) =>
        e.origin.kind === "git" ? [[`${e.name}@${name}`, { root: JSON.stringify(e.origin), resolved: JSON.stringify(running(e.fields)) }] as const] : [],
      );
      return new Map([
        ...plugins.map((p) => [p.id, { root: path.relative(real, p.root).split(path.sep).join("/"), resolved: JSON.stringify([running(p.manifest), p.hooks]) }] as const),
        ...remote,
      ]);
    };
    const [was, now] = await Promise.all([roots(old), roots(next)]);
    // ponytail: the old checkout gone (and not fetchable) means nothing to compare: every plugin counts as changed.
    const files = old === undefined ? undefined : await changedPaths(old, next);
    const under = (root: string) => (files ?? []).some((f) => root === "" || f.startsWith(`${root}/`));
    const ids = new Set([...(was?.keys() ?? []), ...(now?.keys() ?? [])]);
    return [...ids].filter((pluginId) => {
      const a = was?.get(pluginId);
      const b = now?.get(pluginId);
      return files === undefined || a === undefined || b === undefined || a.root !== b.root || a.resolved !== b.resolved || under(a.root);
    });
  };

  /** Credential names the marketplace's loaded plugins declare, as `cwd` sees them. */
  const declaredIn = (marketName: string, cwd?: string) =>
    knownAt(cwd).pipe(
      Effect.map(
        ({ plugins, markets }) =>
          new Set(
            [...plugins.map(({ plugin }) => plugin), ...(markets.find((m) => m.name === marketName)?.entries.flatMap((e) => (e.plugin === undefined ? [] : [e.plugin])) ?? [])]
              .filter((plugin) => plugin.space === marketName)
              .flatMap((plugin) => plugin.contributes.connectors ?? [])
              .flatMap((connector) => connector.credentials ?? []),
          ),
      ),
    );
  const needGrants = Option.isSome(grants)
    ? Effect.succeed(grants.value)
    : Effect.fail(fail("this runtime has no credential store"));
  /** Running servers read their file at each start: removing it makes a revocation reach them. */
  const dropCredentialFiles = (marketName: string) =>
    Effect.tryPromise({
      try: () => fs.rm(credentialFilesFor(credentialsDir, { space: marketName }), { recursive: true, force: true }),
      catch: fail,
    });
  /** What a marketplace's grants are keyed by: personal servers, an added one's source, or a known one's. */
  const grantKey = (marketName: string, cwd?: string) =>
    Effect.gen(function* () {
      if (marketName === PERSONAL_SPACE_ID) return PERSONAL_SPACE_URL;
      const market = (yield* knownAt(cwd)).markets.find((m) => m.name === marketName);
      return market === undefined ? yield* Effect.fail(invalid(`no marketplace ${marketName}`)) : market.key;
    });
  /** Rewrites an added marketplace's granted-name list (names only). */
  const withGranted = (
    marketplaces: PluginSettings["marketplaces"],
    marketName: string,
    next: (names: ReadonlyArray<string>) => ReadonlyArray<string>,
  ) => marketplaces.map((m) => (m.name === marketName ? { ...m, granted: next(m.granted ?? []) } : m));

  const info = (m: Market): MarketplaceInfo => ({
    name: m.name,
    display_name: m.displayName,
    kind: m.kind === "hidden" ? "added" : m.kind,
    source: m.source,
    ...(m.ref === undefined ? {} : { ref: m.ref }),
    ...(m.commit === undefined ? {} : { commit: m.commit }),
    plugin_count: m.entries.length,
    status: m.status,
    problems: [...m.problems],
    shareable: m.shareable,
  });

  const install = (request: InstallRequest, cloud?: CloudWrites) =>
    Effect.gen(function* () {
      const k = yield* knownAt(request.cwd);
      const { market, row } = yield* entryFor(k, request.id);
      if (row.entry?.installation === "not_available") return yield* Effect.fail(invalid(`${request.id} is not offered for install`));
      // A remote entry is pinned now: the commit its ref names (or its sha), checked out before it counts.
      const origin = row.entry?.origin;
      if (origin?.kind === "unsupported") return yield* Effect.fail(invalid(`${request.id}: ${origin.why}`));
      const remote =
        origin?.kind === "git" && row.plugin === undefined
          ? yield* Effect.tryPromise({
              try: async () => {
                const commit = origin.sha ?? (await resolveSpaceRef(origin.url, origin.ref));
                return { source: { url: origin.url, ...(origin.path === undefined ? {} : { path: origin.path }) }, commit };
              },
              catch: (e) => invalid((e as Error).message),
            })
          : undefined;
      const plugin = row.plugin ?? (remote === undefined ? undefined : yield* filesOf(market, row, { id: request.id, scope: "me", policy: "default", ...remote }));
      const version = plugin?.version ?? text(row.entry?.fields.version);
      if (request.scope === "me") {
        yield* lock(
          Effect.gen(function* () {
            const settings = yield* pluginsNow;
            const others = settings.installed.filter((i) => i.id !== request.id);
            yield* update({
              installed: [...others, { id: request.id, ...(version === undefined ? {} : { version }), ...remote, enabled: true }],
              disabled: settings.disabled.filter((id) => id !== request.id),
              // Installed again, it starts on in every project.
              repoSwitches: settings.repoSwitches.filter((r) => r.id !== request.id),
            });
          }),
        );
      } else if (cloud !== undefined && (request.scope === "team" || readIdentity(computer?.linkDir ?? linkDirOf(config.stateDir)) !== undefined)) {
        // Teammates get it through Caveman Cloud: only from a marketplace every teammate has (the catalog, the team's).
        if (market.shareable === "no") {
          return yield* Effect.fail(invalid(`${request.id} is in a folder on this computer; your team cannot get it from there. Put it in a git repository and add that as a marketplace.`));
        }
        if (market.shareable === "add_to_team") {
          if (request.addToTeam !== true || market.team === undefined) {
            return yield* Effect.fail(invalid(`Your team does not have the ${market.displayName} marketplace: add it to the team and install (an Admin or Owner can).`));
          }
          if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(market.name)) {
            return yield* Effect.fail(invalid(`Caveman names marketplaces in lower case: ${market.name} cannot be added to the team as it is named.`));
          }
          const team = market.team;
          const commit = market.commit ?? (yield* Effect.tryPromise({ try: () => resolveSpaceRef(team.repo, team.ref), catch: (e) => invalid((e as Error).message) }));
          yield* Effect.tryPromise({
            try: () => cloud.addMarketplace({ name: market.name, repo: team.repo, ...(team.ref === undefined ? {} : { ref: team.ref }), commit }),
            catch: (e) => mapCloud(e),
          });
        }
        // On by default and a pin are an admin's to set (Cloud refuses a member's): a member's install is offered
        // (Available) and follows the entry's own sha.
        const member = (yield* role) === "member";
        const policy = request.policy ?? (member ? "available" : "default");
        const pin = member ? undefined : remote;
        yield* Effect.tryPromise({
          try: () =>
            cloud.install({
              scope: request.scope === "team" ? "team" : "project",
              ...(request.project === undefined ? {} : { project: request.project }),
              plugin_id: request.id,
              ...pin,
              ...(version === undefined ? {} : { version }),
              policy,
              connection: request.connection ?? "personal",
            }),
          catch: (e) => mapCloud(e),
        });
        cloudCache.clear();
      } else if (request.scope === "project") {
        const project = request.project;
        if (project === undefined) return yield* Effect.fail(invalid("a project install names its project"));
        yield* lock(
          Effect.gen(function* () {
            const settings = yield* pluginsNow;
            const current = settings.projects.find((p) => p.id === project.id) ?? { id: project.id, repos: [], installed: [] };
            const repos = [...new Set([...(project.repository === undefined ? [] : [project.repository]), ...current.repos])];
            const entry = { id: request.id, ...(version === undefined ? {} : { version }), ...remote, enabled: true, policy: request.policy ?? ("default" as const) };
            const next = { ...current, repos, installed: [...current.installed.filter((i) => i.id !== request.id), entry] };
            yield* update({ projects: [...settings.projects.filter((p) => p.id !== project.id), next] });
          }),
        );
      } else {
        return yield* Effect.fail(new PluginRegistryError({ message: "Installing for the team needs your Caveman account: sign in first.", unsupported: true }));
      }
      return plugin === undefined ? [] : authServers(plugin);
    });

  const role = Effect.sync(() => readAccount(computer?.linkDir ?? linkDirOf(config.stateDir))?.role);

  const mapCloud = (cause: unknown) => {
    const status = (cause as { status?: number }).status;
    const message = (cause as Error).message ?? String(cause);
    return status === 403
      ? new PluginRegistryError({ message: `Sign in to Caveman again to install for your team: it takes an Admin or Owner (${message})`, forbidden: true })
      : status !== undefined && status >= 400 && status < 500
        ? invalid(message)
        : fail(cause);
  };

  const registry = PluginRegistry.of({
    known,
    knownAt,
    listing,
    list: listing({}).pipe(Effect.map((l) => l.plugins.filter((p) => p.summary.installed).map((p) => p.summary as PluginListing))),
    marketplaces: (cwd) => knownAt(cwd).pipe(Effect.map((k) => k.markets.map(info))),
    refreshCloud: Effect.sync(() => cloudCache.clear()),
    linked: Effect.sync(() => readIdentity(computer?.linkDir ?? linkDirOf(config.stateDir)) !== undefined),
    role,
    capabilities: (ids, cwd) =>
      knownAt(cwd).pipe(
        Effect.map((k) => {
          const on = k.plugins.filter((p) => p.enabled).map((p) => p.plugin);
          const keys = [...serverKeys(on)];
          return ids.flatMap((id) => {
            const plugin = on.find((p) => p.id === id);
            if (plugin === undefined) return [];
            const block = renderPluginCapabilities({
              displayName: plugin.interface.display_name ?? plugin.name,
              namespace: plugin.name,
              hasSkills: plugin.skills.length > 0,
              servers: keys.filter(([, v]) => v.plugin.id === id).map(([key]) => key),
            });
            return block === undefined ? [] : [block];
          });
        }),
      ),
    projectRepos: (projectId, repository) =>
      Effect.gen(function* () {
        const cloud = yield* cloudFor(repository);
        const repos = cloud !== undefined ? (cloud.project?.repos ?? []) : ((yield* pluginsNow).projects.find((p) => p.id === projectId)?.repos ?? []);
        return [...new Set([...(repository === undefined ? [] : [repository]), ...repos])];
      }),
    setProjectRepos: (projectId, repos) =>
      lock(
        Effect.gen(function* () {
          const settings = yield* pluginsNow;
          const current = settings.projects.find((p) => p.id === projectId) ?? { id: projectId, repos: [], installed: [] };
          yield* update({ projects: [...settings.projects.filter((p) => p.id !== projectId), { ...current, repos: [...new Set(repos)] }] });
        }),
      ),
    addMarketplace: (input) =>
      Effect.gen(function* () {
        const parsed = yield* Effect.try({ try: () => parseMarketplaceSource(input), catch: (e) => invalid((e as Error).message) });
        // A bare repository on disk (no working tree to read in place) is a git marketplace, as a space was.
        const source =
          parsed.kind === "folder" && existsSync(path.join(parsed.path, "HEAD")) && existsSync(path.join(parsed.path, "objects"))
            ? ({ kind: "git", url: parsed.path } as const)
            : parsed;
        const settings = yield* pluginsNow;
        let market: PluginMarketplace;
        if (source.kind === "folder") {
          const same = settings.marketplaces.find((m) => m.source.kind === "folder" && m.source.path === source.path);
          if (same !== undefined) return { name: same.name, already_added: true };
          const stat = yield* Effect.tryPromise({ try: () => fs.stat(source.path), catch: () => invalid(`${source.path} is not a folder`) });
          if (!stat.isDirectory()) return yield* Effect.fail(invalid(`${source.path} is not a folder`));
          const read = yield* Effect.tryPromise({ try: () => loadSpace(source.path, path.basename(source.path)), catch: (e) => invalid((e as Error).message) });
          if (read.market === undefined && read.plugins.length === 0) return yield* Effect.fail(invalid(`${source.path} holds no marketplace.json or plugin: ${read.problems.join("; ")}`));
          market = { name: read.market?.name ?? path.basename(source.path), source: { kind: "folder", path: source.path }, added_at: new Date().toISOString() };
        } else {
          yield* Effect.try({ try: () => checkSpaceUrl(source.url), catch: (e) => invalid((e as Error).message) });
          const same = settings.marketplaces.find((m) => m.source.kind === "git" && m.source.url === source.url);
          if (same !== undefined) return { name: same.name, already_added: true };
          // Resolve and check out outside the lock: ls-remote and a fetch can take up to the git timeout.
          const commit = yield* Effect.tryPromise({ try: () => resolveSpaceRef(source.url, source.ref), catch: (e) => invalid((e as Error).message) });
          const dir = yield* Effect.tryPromise({ try: () => checkout({ url: source.url, commit }).promise, catch: (e) => invalid((e as Error).message) });
          const read = yield* Effect.tryPromise({ try: () => loadSpace(dir, "_"), catch: (e) => invalid((e as Error).message) });
          if (read.market === undefined && read.plugins.length === 0) return yield* Effect.fail(invalid(`${source.url} holds no marketplace.json or plugin: ${read.problems.join("; ")}`));
          market = {
            name: read.market?.name ?? read.plugins[0]?.name ?? "marketplace",
            source: { kind: "git", url: source.url, ...(source.ref === undefined ? {} : { ref: source.ref }), commit },
            added_at: new Date().toISOString(),
          };
        }
        // Another add of the same source may have finished while this one cloned (an import adds several at once):
        // that is the same marketplace, already added, not a second one under a taken name.
        const added = market.source;
        const sameSource = (m: PluginMarketplace) =>
          added.kind === "folder" ? m.source.kind === "folder" && m.source.path === added.path : m.source.kind === "git" && m.source.url === added.url;
        const taken = new Set([...(yield* known).markets.map((m) => m.name), ...RESERVED_MARKETS]);
        return yield* lock(
          Effect.gen(function* () {
            const now = yield* pluginsNow;
            const same = now.marketplaces.find(sameSource);
            if (same !== undefined) return { name: same.name, already_added: true };
            if (taken.has(market.name) || now.marketplaces.some((m) => m.name === market.name)) return yield* Effect.fail(invalid(`a marketplace named ${market.name} is already added`));
            yield* update({ marketplaces: [...now.marketplaces, market] });
            return { name: market.name, already_added: false };
          }),
        );
      }),
    updateMarketplace: (name) =>
      Effect.gen(function* () {
        const before = (yield* pluginsNow).marketplaces.find((m) => m.name === name);
        if (before === undefined) return yield* Effect.fail(invalid(`no marketplace ${name} you added`));
        // A folder is read in place: nothing to repin.
        if (before.source.kind === "folder") return { changed: [], trust_dropped: [] };
        const source = before.source;
        const commit = yield* Effect.tryPromise({ try: () => resolveSpaceRef(source.url, source.ref), catch: (e) => invalid((e as Error).message) });
        if (commit === source.commit) return { changed: [], trust_dropped: [] };
        const changed = yield* Effect.promise(() => compareCheckouts(name, source, commit));
        if (changed instanceof Error) return yield* Effect.fail(invalid(changed.message));
        return yield* lock(
          Effect.gen(function* () {
            const settings = yield* pluginsNow;
            const dropped = settings.trusted.filter((entry) => changed.includes(trustedId(entry)));
            yield* update({
              marketplaces: settings.marketplaces.map((m) => (m.name === name && m.source.kind === "git" ? { ...m, source: { ...m.source, commit } } : m)),
              ...(dropped.length === 0 ? {} : { trusted: settings.trusted.filter((entry) => !dropped.includes(entry)) }),
            });
            return { changed, trust_dropped: dropped.map(trustedId) };
          }),
        );
      }),
    removeMarketplace: (name) =>
      // Read outside the lock: reading what is known may migrate, which takes it.
      Effect.flatMap(declaredIn(name), (declared) => lock(
        Effect.gen(function* () {
          const settings = yield* pluginsNow;
          const market = settings.marketplaces.find((m) => m.name === name);
          const space = settings.spaces.find((sp) => spaceIdFor(sp.url) === name);
          if (market === undefined && space !== undefined) {
            // A space that never migrated: it goes, with the credentials granted to it.
            yield* update({ spaces: settings.spaces.filter((sp) => sp !== space) });
            if (Option.isSome(grants)) yield* Effect.forEach(space.granted ?? [], (n) => grants.value.revoke(space.url, n).pipe(Effect.mapError(fail)));
            return yield* dropCredentialFiles(name);
          }
          if (market === undefined) return yield* Effect.fail(invalid(`no marketplace ${name} you added`));
          const key = market.source.kind === "git" ? market.source.url : market.source.path;
          // Recorded grants cover a marketplace whose checkout failed; declaredIn covers older ones.
          const names = new Set([...(market.granted ?? []), ...declared]);
          const ofIt = (id: string) => id.endsWith(`@${name}`);
          yield* update({
            marketplaces: settings.marketplaces.filter((m) => m !== market),
            installed: settings.installed.filter((i) => !ofIt(i.id)),
            disabled: settings.disabled.filter((id) => !ofIt(id)),
            trusted: settings.trusted.filter((entry) => !ofIt(trustedId(entry))),
            // A yes to a repository's suggestion of its plugins goes too: a marketplace of that name added later starts unasked.
            repoEnabled: settings.repoEnabled.filter((r) => !ofIt(r.id)),
            repoSwitches: settings.repoSwitches.filter((r) => !ofIt(r.id)),
          });
          if (Option.isSome(grants)) yield* Effect.forEach(names, (n) => grants.value.revoke(key, n).pipe(Effect.mapError(fail)));
          yield* dropCredentialFiles(name);
        }),
      )),
    install,
    uninstall: (request, cloud) =>
      Effect.gen(function* () {
        if (request.scope === "me") {
          return yield* lock(
            Effect.gen(function* () {
              const settings = yield* pluginsNow;
              if (!settings.installed.some((i) => i.id === request.id)) return yield* Effect.fail(invalid(`${request.id} is not installed for you`));
              yield* update({ installed: settings.installed.filter((i) => i.id !== request.id) });
            }),
          );
        }
        const local = request.project === undefined ? undefined : (yield* pluginsNow).projects.find((p) => p.id === request.project!.id);
        if (request.scope === "project" && local?.installed.some((i) => i.id === request.id)) {
          return yield* lock(
            Effect.gen(function* () {
              const settings = yield* pluginsNow;
              yield* update({ projects: settings.projects.map((p) => (p.id === local.id ? { ...p, installed: p.installed.filter((i) => i.id !== request.id) } : p)) });
            }),
          );
        }
        if (cloud === undefined) return yield* Effect.fail(new PluginRegistryError({ message: "This install is kept in Caveman: sign in first.", unsupported: true }));
        yield* Effect.tryPromise({
          try: () => cloud.uninstall({ scope: request.scope === "team" ? "team" : "project", ...(request.project === undefined ? {} : { project: request.project }), plugin_id: request.id }),
          catch: mapCloud,
        });
        cloudCache.clear();
      }),
    setEnabled: (pluginId, on, cwd, onlyHere) =>
      Effect.flatMap(knownAt(cwd), (k) => lock(
        Effect.gen(function* () {
          const install = k.installs.get(pluginId);
          const repository = repoConsentKey(cwd, k.repository);
          // A plugin the repository suggests is turned on, and off again, for this repository only.
          const settings0 = yield* pluginsNow;
          const accepted = settings0.repoEnabled.some((r) => r.repository === repository && r.id === pluginId);
          if (repository !== undefined && ((on && install?.suggested === true) || (!on && accepted))) {
            const others = settings0.repoEnabled.filter((r) => !(r.repository === repository && r.id === pluginId));
            yield* update({ repoEnabled: on ? [...others, { repository, id: pluginId }] : others });
            // Installed only because this repository asked for it: withdrawing the yes is turning it off.
            if (on || install?.scope === "repo") return;
          }
          if (install === undefined || !install.installed) {
            // A personal or profile pseudo-plugin has nothing to turn off here.
            return yield* Effect.fail(invalid(`no installed plugin ${pluginId}`));
          }
          if (!on && install.required) return yield* Effect.fail(new PluginRegistryError({ message: `${pluginId} is required by your team and cannot be turned off`, forbidden: true }));
          const settings = yield* pluginsNow;
          if (onlyHere === true) {
            if (repository === undefined) return yield* Effect.fail(invalid("a project's own switch needs its folder (cwd)"));
            // Kept only while it says something other than everywhere does.
            const rest = settings.repoSwitches.filter((r) => !(r.repository === repository && r.id === pluginId));
            yield* update({ repoSwitches: on === install.everywhere ? rest : [...rest, { repository, id: pluginId, enabled: on }] });
            return;
          }
          const others = settings.disabled.filter((id) => id !== pluginId);
          yield* update({
            installed: settings.installed.map((i) => (i.id === pluginId ? { ...i, enabled: on } : i)),
            disabled: on ? others : [...others, pluginId],
          });
        }),
      )),
    grant: (marketName, name, value, cwd) =>
      Effect.flatMap(Effect.all([grantKey(marketName, cwd), declaredIn(marketName, cwd)]), ([key, declared]) => lock(
        Effect.gen(function* () {
          const store = yield* needGrants;
          if (!declared.has(name)) {
            return yield* Effect.fail(invalid(`no ${marketName === PERSONAL_SPACE_ID ? "server of yours" : `plugin in ${marketName}`} asks for ${name}`));
          }
          yield* store.grant(key, name, value).pipe(Effect.mapError(fail));
          // Personal grants are tracked by the servers that declare them; others only for marketplaces you added.
          const settings = yield* pluginsNow;
          if (settings.marketplaces.some((m) => m.name === marketName)) {
            yield* update({ marketplaces: withGranted(settings.marketplaces, marketName, (ns) => [...new Set([...ns, name])]) });
          }
        }),
      )),
    revoke: (marketName, name, cwd) =>
      Effect.flatMap(grantKey(marketName, cwd), (key) => lock(
        Effect.gen(function* () {
          const store = yield* needGrants;
          yield* store.revoke(key, name).pipe(Effect.mapError(fail));
          yield* dropCredentialFiles(marketName);
          const settings = yield* pluginsNow;
          if (settings.marketplaces.some((m) => m.name === marketName)) {
            yield* update({ marketplaces: withGranted(settings.marketplaces, marketName, (ns) => ns.filter((n) => n !== name)) });
          }
        }),
      )),
    session,
    forThread,
    servers: Effect.gen(function* () {
      const { servers } = yield* pluginsNow;
      return yield* Effect.forEach(servers, (server) =>
        Effect.forEach(serverCredentials(server), (name) =>
          isGranted(PERSONAL_SPACE_URL, name).pipe(Effect.map((granted) => ({ name, granted }))),
        ).pipe(Effect.map((credentials) => ({ server, credentials }) satisfies PersonalServer)),
      );
    }),
    saveServer: (server, replace) =>
      lock(
        Effect.gen(function* () {
          const problem = serverProblem(server);
          if (problem !== undefined) return yield* Effect.fail(invalid(problem));
          const { servers } = yield* pluginsNow;
          const same = (s: PluginServer) => s.name.toLowerCase() === server.name.toLowerCase();
          if (!replace && servers.some(same)) return yield* Effect.fail(invalid(`${server.name} is already one of your servers`));
          if (replace && !servers.some(same)) return yield* Effect.fail(invalid(`no server ${server.name}`));
          yield* update({ servers: replace ? servers.map((s) => (same(s) ? server : s)) : [...servers, server] });
        }),
      ),
    removeServer: (name) =>
      lock(
        Effect.gen(function* () {
          const { servers } = yield* pluginsNow;
          const server = servers.find((s) => s.name === name);
          if (server === undefined) return yield* Effect.fail(invalid(`no server ${name}`));
          yield* update({ servers: servers.filter((s) => s !== server), repoServerSwitches: (yield* pluginsNow).repoServerSwitches.filter((r) => r.id !== name) });
          // A name another server still declares keeps its grant.
          const still = new Set(servers.filter((s) => s !== server).flatMap(serverCredentials));
          if (Option.isSome(grants)) {
            yield* Effect.forEach(
              serverCredentials(server).filter((n) => !still.has(n)),
              (n) => grants.value.revoke(PERSONAL_SPACE_URL, n).pipe(Effect.mapError(fail)),
            );
          }
          yield* dropCredentialFiles(PERSONAL_SPACE_ID);
        }),
      ),
    setServerEnabled: (name, on, cwd, onlyHere) =>
      Effect.flatMap(onlyHere === true ? consentKeyAt(cwd) : Effect.succeed(undefined), (repository) => lock(
        Effect.gen(function* () {
          const { servers, repoServerSwitches } = yield* pluginsNow;
          const server = servers.find((s) => s.name === name);
          if (server === undefined) return yield* Effect.fail(invalid(`no server ${name}`));
          if (onlyHere === true) {
            if (repository === undefined) return yield* Effect.fail(invalid("a project's own switch needs its folder (cwd)"));
            // Kept only while it says something other than the server's own switch does.
            const rest = repoServerSwitches.filter((r) => !(r.repository === repository && r.id === name));
            yield* update({ repoServerSwitches: on === server.enabled ? rest : [...rest, { repository, id: name, enabled: on }] });
            return;
          }
          yield* update({ servers: servers.map((s) => (s.name === name ? { ...s, enabled: on } : s)) });
        }),
      )),
    serverSwitches: (cwd) => Effect.flatMap(consentKeyAt(cwd), (repository) => Effect.map(pluginsNow, (settings) => switchesAt(settings.repoServerSwitches, repository))),
    setTrusted: (pluginId, on, cwd) =>
      Effect.flatMap(knownAt(cwd), ({ plugins, markets }) =>
        Effect.gen(function* () {
          const plugin = plugins.find((p) => p.plugin.id === pluginId)?.plugin;
          if (plugin === undefined) return yield* Effect.fail(invalid(`no plugin ${pluginId}`));
          // Trust is for these files: the digest is taken now, from what the person reviewed.
          const digest = yield* digestOf(plugin, entryOf(markets, plugin));
          yield* lock(
            Effect.gen(function* () {
              const others = (yield* pluginsNow).trusted.filter((entry) => trustedId(entry) !== pluginId);
              yield* update({ trusted: on ? [...others, trustEntry(pluginId, digest)] : others });
            }),
          );
        }),
      ),
    claudeAgent: (session) =>
      Effect.tryPromise({
        // Personal servers have no plugin directory to copy: only their MCP servers reach Claude. My ~/.agents/skills do, as a plugin.
        try: async () => {
          const mine = await homeSkillsPlugin().catch((cause: Error) => void Effect.runSync(note(`your skills in ~/.agents/skills: ${cause.message}`)));
          return projectForClaudeAgent(session.bundle, [...session.plugins.filter((p) => p.space !== PERSONAL_SPACE_ID), ...(mine === undefined ? [] : [mine])], projectionDir);
        },
        catch: fail,
      }).pipe(Effect.tapError((error) => note(`Claude Agent plugin copy: ${error.message}`))),
  });
  // Another computer's removal of a marketplace or server goes through the same removal as one made here, so what was
  // granted to it is revoked (cloudLink/cloudSync.ts, which cannot import this module).
  (yield* CloudSyncState).removals = { marketplace: registry.removeMarketplace, server: registry.removeServer };
  return registry;
});

export const layer = Layer.effect(PluginRegistry, make());

/** One repository's own switches out of a settings list (repoSwitches, repoServerSwitches), by id; none without a repository. */
const switchesAt = (list: ReadonlyArray<{ readonly repository: string; readonly id: string; readonly enabled: boolean }>, repository: string | undefined): ReadonlyMap<string, boolean> =>
  new Map(repository === undefined ? [] : list.filter((r) => r.repository === repository).map((r) => [r.id, r.enabled] as const));

/** The key the folder at `cwd` keeps its own switches and suggestions under (repoConsentKey); undefined without a folder. */
const consentKeyAt = (cwd: string | undefined) =>
  cwd === undefined ? Effect.succeed(undefined) : Effect.promise(() => readRepositoryLink(cwd).catch(() => undefined)).pipe(Effect.map((link) => repoConsentKey(cwd, repoKeyOf(link))));

/**
 * What a repository's suggestions and its own switches are kept under: its key (`host/owner/name`), else its folder.
 * A linked worktree answers its main checkout's folder, so a project without a remote keeps them in every worktree.
 */
function repoConsentKey(cwd: string | undefined, repository: string | undefined): string | undefined {
  if (repository !== undefined) return repository;
  return cwd === undefined ? undefined : realpathOr(mainCheckout(cwd));
}

/**
 * A linked worktree's main checkout: its `.git` is a file naming its own git directory, whose `commondir` names the
 * one it shares. Any other folder (a checkout, a submodule, no repository) is itself.
 */
const mainCheckout = (dir: string): string => {
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const pointer = read(path.join(dir, ".git"))?.match(/^gitdir:\s*(.+)$/m);
  if (!pointer) return dir;
  const gitDir = path.resolve(dir, pointer[1]!.trim());
  const common = read(path.join(gitDir, "commondir"))?.trim();
  if (common === undefined) return dir;
  const commonDir = path.resolve(gitDir, common);
  return path.basename(commonDir) === ".git" ? path.dirname(commonDir) : dir;
};

const realpathOr = (dir: string) => {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
};

/**
 * The repository's own skill folders (`.claude/skills`, `.agents/skills`) for the Caveman engine, as Claude
 * Agent and Codex read them. Only folders that really live in the checkout. Not on a Cloud computer: the
 * engine reads skills in the runtime container, beside runtime.key, and the checkout is the agent's to write.
 */
export function repoSkillRoots(cwd: string | undefined, onComputer: boolean): ReadonlyArray<string> {
  if (cwd === undefined || onComputer) return [];
  let root: string;
  try {
    root = realpathSync(cwd);
  } catch {
    return [];
  }
  return [".claude/skills", ".agents/skills"].flatMap((rel) => {
    try {
      const dir = realpathSync(path.join(root, rel));
      return dir.startsWith(`${root}${path.sep}`) && statSync(dir).isDirectory() ? [dir] : [];
    } catch {
      return [];
    }
  });
}

/** My ~/.agents/skills for the Caveman engine (skill.save me and imports write there). Not on a Cloud computer: the profile brings them. */
export function homeSkillRoots(onComputer: boolean, home = os.homedir()): ReadonlyArray<string> {
  if (onComputer) return [];
  try {
    const dir = realpathSync(path.join(home, ".agents", "skills"));
    return statSync(dir).isDirectory() ? [dir] : [];
  } catch {
    return [];
  }
}

const EMPTY_SESSION: PluginSession = {
  hubOnly: [],
  remoteAuth: {},
  plugins: [],
  bundle: {
    plugins: [],
    skills: [],
    commands: [],
    agents: [],
    hooks: [],
    mcpServers: {},
    rules: [],
    hookPolicy: { keep: [], deny: [], read: [] },
  },
};

/**
 * SessionPlugins from this registry. A thread snapshots its plugins on its
 * first successful read and keeps them while its worktree stays the same. A
 * space that fails never blocks a session: it starts without that space's
 * plugins and the failure shows in `known.problems`. When the whole read
 * fails, the session runs without plugins and the next read tries again.
 */
export const layerSessionPlugins = Layer.effect(
  SessionPlugins,
  Effect.gen(function* () {
    const registry = yield* PluginRegistry;
    // Session Protocol workspaces; a host without them adds no environment.
    const store = yield* Effect.serviceOption(SessionStore);
    // Memory (memory/MemoryService.ts): its brief is the last instruction source; Claude Agent gets its own memory directory instead.
    const memory = yield* Effect.serviceOption(Memory);
    const memorySource = Option.isSome(memory) ? [{ title: "Memory", read: (threadId: ThreadId, engine: InstructionEngine) => memory.value.brief(threadId, engine) }] : [];
    const withSources = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.gen(function* () {
        const sources = yield* InstructionSources;
        return yield* effect.pipe(Effect.provideService(InstructionSources, [...sources, ...memorySource]));
      });
    // The workspace's worktree root: the thread's plugin servers may write there.
    const worktreeOf = (threadId: ThreadId) =>
      Option.isSome(store)
        ? store.value.getByThread(threadId).pipe(Effect.map((record) => record?.internal.worktreePath || undefined))
        : Effect.succeed(undefined);
    // A Cloud computer pulls This Mac's profile before the first session and again at each start (cloudLink/cloudSync.ts).
    const sync = yield* CloudSyncState;
    const beforeSession = Effect.promise(() => sync.beforeSession?.() ?? Promise.resolve());
    // A chat whose plugin's hooks stopped for trust says so once per plugin, rather than going quiet.
    const told = new Map<string, Set<string>>();
    const tellTrustDropped = (threadId: ThreadId, session: PluginSession) =>
      Option.isNone(store) || session.trustDropped === undefined
        ? Effect.void
        : store.value.getByThread(threadId).pipe(
            Effect.flatMap((record) => {
              const seen = told.get(threadId) ?? new Set<string>();
              told.set(threadId, seen);
              const fresh = (session.trustDropped ?? []).filter((p) => !seen.has(p.id));
              if (record === undefined || fresh.length === 0) return Effect.void;
              for (const p of fresh) seen.add(p.id);
              const at = new Date().toISOString();
              return store.value.append(record.session.id, () =>
                Effect.succeed({
                  events: fresh.map(
                    (p) =>
                      ({
                        at,
                        type: "notification",
                        payload: { level: "warning", title: `${p.name}'s hooks changed or were trusted before an update; they're off until you trust them again`, body: "Plugins > Needs you" },
                      }) as DraftEvent,
                  ),
                  value: undefined,
                }),
              );
            }),
            Effect.ignore,
          );
    const forThread = (threadId: ThreadId) =>
      beforeSession.pipe(Effect.andThen(worktreeOf(threadId))).pipe(
        Effect.flatMap((worktree) => registry.forThread(threadId, worktree)),
        Effect.tap((session) => tellTrustDropped(threadId, session)),
        Effect.catch((error) =>
          Effect.logWarning("Plugins unavailable for this session", error.message).pipe(
            Effect.as(EMPTY_SESSION),
          ),
        ),
      );
    // Repository secrets for engine processes (secrets/EngineEgress.ts); a host without them has none.
    const secrets = yield* Effect.serviceOption(ProjectSecrets);
    const projections = yield* Effect.serviceOption(ProjectionStoreV2);
    const projects = yield* Effect.serviceOption(ProjectStoreV2);
    // The thread's project root when the stores are in this context; otherwise the
    // caller's cwd, which keyOf maps from a worktree to its main checkout's key.
    const workspaceRootOf = (threadId: ThreadId) =>
      Option.isNone(projections) || Option.isNone(projects)
        ? Effect.succeed(undefined)
        : projections.value.getThread(threadId).pipe(
            Effect.flatMap((thread) => projects.value.get(thread.projectId)),
            Effect.map((row) => Option.getOrUndefined(row)?.workspaceRoot),
            Effect.orElseSucceed(() => undefined),
          );
    // Every listed name resolved, or a failure: a locked store must stop the engine, not start it without them.
    const resolveAll = (key: string) =>
      Option.isNone(secrets)
        ? Effect.succeed([])
        : Effect.all([secrets.value.resolve(key), secrets.value.list(key)]).pipe(
            Effect.flatMap(([entries, names]) =>
              names.every((info) => entries.some(({ name }) => name === info.name))
                ? Effect.succeed(entries)
                : Effect.fail(new ProjectSecretsError({ message: "Project secrets are locked: unlock the OS keychain and restart Caveman Code" })),
            ),
          );
    // Caveman's commit attribution (Settings > General > Git), read per session so a change applies to the next one.
    const attribution = Option.isSome(store)
      ? store.value.kvGet("settings").pipe(Effect.map((raw) => (coAuthorOn(raw) ? CO_AUTHOR_INSTRUCTION : "")))
      : Effect.succeed("");
    // And enforced by git: every engine's tool processes commit through the runtime's hooks (git/coAuthorHooks.ts),
    // whose flag settings.set keeps current; each session start puts back whatever an engine's tools changed there.
    // On a Cloud computer they are written into its tools container (which cannot read the runtime's state directory)
    // with the flag as the setting reads at that session's start. Hooks that cannot be written leave the instruction alone.
    const serverConfig = yield* Effect.serviceOption(ServerConfig);
    const tools = toolsSocket();
    const coAuthorSetting = Option.isSome(store) ? store.value.kvGet("settings").pipe(Effect.map(coAuthorOn)) : Effect.succeed(coAuthorOn(undefined));
    const commitHooks: Effect.Effect<string | undefined> = Option.isNone(serverConfig)
      ? Effect.succeed(undefined)
      : tools !== undefined
        ? coAuthorSetting.pipe(
            Effect.flatMap((on) => Effect.promise(() => writeToolsCoAuthorHooks(tools, on))),
            Effect.map((written) => (written ? TOOLS_HOOKS_DIR : undefined)),
          )
        : Effect.sync((): string | undefined => writeCoAuthorHooks(serverConfig.value.stateDir)).pipe(
            Effect.catchCause((cause) => Effect.logWarning("Commit hooks unavailable", cause).pipe(Effect.as(undefined))),
          );
    if (tools === undefined) {
      yield* commitHooks.pipe(Effect.flatMap((dir) => (dir === undefined ? Effect.void : coAuthorSetting.pipe(Effect.map((on) => setCoAuthorFlag(dir, on))))));
    }
    // The thread's hidden paths (Settings > Projects, .cavemanignore in its checkout); none without a workspace.
    const hiddenPaths = (threadId: ThreadId) =>
      Option.isNone(store)
        ? Effect.succeed<string[]>([])
        : store.value.getByThread(threadId).pipe(
            Effect.flatMap((record) =>
              record?.internal.worktreePath ? hiddenPathsFor(store.value, record.workspace.project_id, record.internal.worktreePath) : Effect.succeed<string[]>([]),
            ),
            Effect.map((lines) => lines.map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"))),
          );
    // The user's own instructions for the thread's repository (Settings > Projects), private to this computer.
    const projectInstructions = (threadId: ThreadId) =>
      Option.isNone(store)
        ? Effect.succeed("")
        : store.value.getByThread(threadId).pipe(
            Effect.flatMap((record) => (record?.workspace.project_id ? readProjectPrefs(store.value, record.workspace.project_id) : Effect.succeed<ProjectPrefs>({}))),
            Effect.map((prefs) => prefs.instructions?.trim() ?? ""),
          );
    // Every engine is told which paths are hidden; Claude Agent and the Caveman engine also enforce them.
    const instructions = (threadId: ThreadId) =>
      Effect.all([attribution, hiddenPaths(threadId), projectInstructions(threadId)]).pipe(
        Effect.map(([credit, hidden, own]) =>
          [
            own === "" ? "" : `<project_instructions>\nThe user's own instructions for this repository:\n${own}\n</project_instructions>`,
            credit,
            hidden.length === 0
              ? ""
              : `<hidden_paths>\nThe user hid these paths (gitignore syntax) from search and file tools. Do not read, list or search them unless the user asks:\n${hidden.join("\n")}\n</hidden_paths>`,
          ]
            .filter((part) => part !== "")
            .join("\n\n"),
        ),
      );
    // Hub-only servers reach Claude Agent, Codex and ACP agents only as the runtime's hub endpoint, with the
    // thread's runtime MCP credential; a thread without one gets none of them.
    const mcpSessions = yield* Effect.serviceOption(McpProviderSessions);
    const hubRouted = (threadId: ThreadId, s: PluginSession) =>
      (Option.isSome(mcpSessions) ? mcpSessions.value.read(threadId) : Effect.succeed(undefined)).pipe(
        Effect.map((runtime) => routeThroughHub(s.bundle.mcpServers, runtime, (key) => s.hubOnly.includes(key), s.hubOnly)),
      );
    // Codex runs only the hooks it trusts itself (hooks.state in its config), so the runtime runs trusted
    // plugins' SessionStart hooks as the thread loads (`source`) and hands their text over as developer
    // instructions, and keeps them to run again after a compaction.
    const codexSessionStart = (threadId: ThreadId, s: PluginSession, source: SessionStartSource) =>
      worktreeOf(threadId).pipe(
        Effect.flatMap((worktree): Effect.Effect<{ readonly start?: string | undefined; readonly hooks?: RuntimeHooks | undefined }> => {
          const hooks = makeHookRunner(s.bundle, { sessionId: threadId, cwd: worktree ?? process.cwd() });
          return hooks === undefined ? Effect.succeed({}) : Effect.promise(() => hooks.sessionStart(source).catch(() => undefined)).pipe(Effect.map((start) => ({ start, hooks })));
        }),
      );
    // Claude Agent and Codex take one appended prompt: their projection's text, the runtime's, then the extra sources.
    const appended = (threadId: ThreadId, text: string, engine: InstructionEngine) =>
      Effect.all([instructions(threadId), withSources(extraSections(threadId, engine))]).pipe(
        Effect.map(([own, extra]) => [text, own, renderSections(extra)].filter((part) => part !== "").join("\n\n")),
      );
    // The thread's repository secrets, plaintext, for the engine's own process (never its MCP servers or plugins).
    const secretEnvOf = (threadId: ThreadId, cwd: string | undefined): Effect.Effect<Record<string, string>, ProjectSecretsError> =>
        Option.isNone(secrets)
          ? Effect.succeed({})
          : workspaceRootOf(threadId).pipe(
              Effect.flatMap((root) =>
                (root ?? cwd) === undefined
                  ? Effect.succeedNone
                  : secrets.value.keyOf({ path: (root ?? cwd)! }).pipe(
                      Effect.map(Option.some),
                      // Not a git repository: no repository, so no secrets. Any other failure (an
                      // origin that changed, a locked store) stops the engine.
                      Effect.catchIf(
                        (error) => error.reason === "not_a_repository",
                        () => Effect.succeedNone,
                      ),
                    ),
              ),
              Effect.flatMap((key) => (Option.isNone(key) ? Effect.succeed([]) : resolveAll(key.value))),
              // Names the engine itself uses never come from a repository.
              Effect.map((entries) =>
                Object.fromEntries(
                  entries.filter(({ name }) => !isReservedEnvName(name, "engine")).map(({ name, value }) => [name, value]),
                ),
              ),
            );
    return SessionPlugins.of({
      instructions,
      hiddenPaths,
      // Beside the workspace's variables and the commit hooks' git config: the names (never values) of the repository's
      // hidden secrets, which those hooks refuse in a commit or push (git/coAuthorHooks.ts). Every engine, the Caveman
      // engine included, which takes its secrets straight from secretEnv.
      env: (threadId) =>
        Effect.all([
          Option.isSome(store) ? threadWorkspaceEnv(store.value, threadId) : Effect.succeed({}),
          commitHooks,
          worktreeOf(threadId).pipe(
            Effect.flatMap((cwd) => secretEnvOf(threadId, cwd ?? undefined)),
            Effect.map((env): Record<string, string> => {
              const hidden = Object.entries(env).filter(([name, value]) => isHiddenSecret(name, value)).map(([name]) => name);
              return hidden.length === 0 ? {} : { [SECRET_NAMES_ENV]: hidden.join(" ") };
            }),
            Effect.orElseSucceed((): Record<string, string> => ({})),
          ),
        ]).pipe(
          Effect.map(([env, hooks, names]) => {
            const withNames = { ...env, ...names };
            return hooks === undefined ? withNames : { ...withNames, ...coAuthorGitEnv(hooks, { ...process.env, ...withNames }) };
          }),
        ),
      secretEnv: secretEnvOf,
      acp: (threadId) =>
        forThread(threadId).pipe(
          Effect.flatMap((s) => hubRouted(threadId, s).pipe(Effect.map((mcpServers) => projectForAcp({ ...s.bundle, mcpServers })))),
        ),
      caveman: (threadId, cwd) =>
        Effect.all([forThread(threadId), instructions(threadId), Option.isSome(memory) ? memory.value.caveman(threadId) : Effect.succeed(undefined)]).pipe(
          Effect.flatMap(([s, runtime, copy]) =>
            withSources(cavemanSections({ threadId, cwd, rules: s.bundle.rules, runtime })).pipe(
              Effect.map((sections) => {
                // Memory's pushes ride the tool results, after the plugins' own notes.
                const hooks = withPostToolUseNote(makeHookRunner(s.bundle, { sessionId: threadId, cwd }), copy?.postToolUse);
                const projected = projectForCaveman(s.bundle, sections);
                return {
                  ...projected,
                  skillRoots: [...projected.skillRoots, ...repoSkillRoots(cwd, tools !== undefined), ...homeSkillRoots(tools !== undefined)],
                  hubOnly: s.hubOnly,
                  ...(copy === undefined ? {} : { memory: { dir: copy.dir, ...(copy.onWrite === undefined ? {} : { onWrite: copy.onWrite }) } }),
                  ...(hooks === undefined ? {} : { hooks }),
                };
              }),
            ),
          ),
        ),
      codex: (threadId, source) =>
        forThread(threadId).pipe(
          Effect.flatMap((s) =>
            Effect.all([hubRouted(threadId, s), codexSessionStart(threadId, s, source)]).pipe(
              Effect.map(([mcpServers, { start, hooks }]) => {
                const projected = projectForCodex({ ...s.bundle, mcpServers });
                const options = hooks === undefined ? projected : { ...projected, afterCompaction: () => hooks.sessionStart("compact").catch(() => undefined) };
                return start === undefined
                  ? options
                  : { ...options, developerInstructions: [options.developerInstructions, `# SessionStart hooks\n\n${start}`].filter((t) => t !== "").join("\n\n") };
              }),
            ),
          ),
          Effect.flatMap((options) => appended(threadId, options.developerInstructions, "codex").pipe(Effect.map((developerInstructions) => ({ ...options, developerInstructions })))),
          Effect.flatMap((options) =>
            Option.isNone(memory) ? Effect.succeed(options) : memory.value.codex(threadId).pipe(Effect.map((copy) => (copy === undefined ? options : { ...options, memory: copy }))),
          ),
        ),
      claudeAgent: (threadId) =>
        forThread(threadId).pipe(
          Effect.flatMap((s) =>
            Effect.all([registry.claudeAgent(s), hubRouted(threadId, s)]).pipe(
              Effect.map(([options, mcpServers]) => ({ ...options, mcpServers })),
              // A Cloud computer runs Claude in its tools container, which cannot read the state dir: the copies go there.
              Effect.flatMap((options) =>
                tools === undefined || Option.isNone(serverConfig) || options.plugins.length === 0
                  ? Effect.succeed(options)
                  : Effect.tryPromise({
                      try: () => pluginDirsForTools(tools, options.plugins.map((p) => p.path), serverConfig.value.stateDir),
                      catch: (cause) => new PluginRegistryError({ message: `Claude Agent plugin copy for the tools container: ${String(cause)}` }),
                    }).pipe(Effect.map((dirs) => ({ ...options, plugins: options.plugins.map((p, i) => ({ ...p, path: dirs[i]! })) }))),
              ),
            ),
          ),
          Effect.catch((error) =>
            Effect.logWarning("Plugins unavailable for this session", error.message).pipe(
              // No plugins: nothing is copied, so this cannot fail.
              Effect.andThen(Effect.promise(() => projectForClaudeAgent(EMPTY_SESSION.bundle, [], ""))),
            ),
          ),
          Effect.flatMap((options) =>
            Effect.all([
              appended(threadId, options.appendSystemPrompt, "claude-agent"),
              hiddenPaths(threadId),
              Option.isSome(memory) ? memory.value.claude(threadId) : Effect.succeed(undefined),
            ]).pipe(
              Effect.map(([appendSystemPrompt, hidden, copy]) => {
                // The app proxies' home holds the app's own Caveman sign-in: Claude's file tools never read it (its bash
                // can, so the egress scrub also redacts the token).
                const proxyHome = appProxyHome();
                const deny = [...claudeReadDenyRules(hidden), ...(proxyHome === undefined ? [] : [`Read(/${proxyHome}/**)`])];
                return {
                  ...options,
                  appendSystemPrompt,
                  ...(deny.length === 0 ? {} : { disallowedTools: deny }),
                  ...(copy === undefined ? {} : { sdkSettings: copy.settings, hooks: copy.hooks }),
                };
              }),
            ),
          ),
        ),
    });
  }),
);
