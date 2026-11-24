/**
 * Session Protocol handlers for plugins and marketplaces: plugin.*,
 * marketplace.*, credential.grant and credential.revoke, connectors (the
 * catalog's plugins that sign in) and personal MCP servers (mcp.*), all on
 * the PluginRegistry. Project and team installs go to Caveman Cloud with the
 * person's own sign-in. A credential value goes from the request into the
 * secret store and is never returned or logged. On a Cloud computer whose
 * person's credentials stay outside it none is taken (credential.grant is
 * refused, session-protocol/insideComputer.ts): its file would be the agent's
 * to read. Nor is a server or marketplace whose command line or URL carries
 * one (mcp.add, marketplace.add). One an earlier run kept can still be
 * revoked.
 *
 * @module plugins/protocolHandlers
 */
import type { PluginServer } from "@caveman-app/protocol";
import type { ConnectorInfo, McpServerInfo, PluginSummary } from "@caveman-app/session-protocol/protocol";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";

import { type Handler, ProtocolError } from "../session-protocol/handlers.ts";
import { credentialRule } from "../cloudLink/credentialsOutside.ts";
import { makeInsideComputer } from "../session-protocol/insideComputer.ts";
import { OUTSIDE_SERVER_KEY, outsideLine } from "../cloudLink/credentialRule.ts";
import { type Connection, Connectors } from "./connectors.ts";
import { type HubServer, McpHub, type McpHubError, personalServer } from "./McpHub.ts";
import { addOrgMarketplace, installPlugin, listProjects, projectForRepository, uninstallPlugin } from "../cloudLink/plugins.ts";
import { makeAccountStore } from "../session-protocol/account.ts";
import { allHooks, type LoadedPlugin } from "./load.ts";
import { CATALOG_NAME } from "./marketplaces.ts";
import { headerCredential, holdsCredential, keyStaysOnMac, serverCredentials, serverProblem, settleSignIn } from "./personal.ts";
import {
  type AuthServer,
  type CloudWrites,
  type InstallRequest,
  type ListedPlugin,
  type PersonalServer,
  type PluginListing,
  PluginRegistry,
  PluginRegistryError,
} from "./PluginRegistry.ts";
import { mcpServerKey, serverKeys } from "./resolve.ts";
import { skippedUntil, skipping, StalledMcpServers } from "./StalledMcpServers.ts";

type PluginMethod =
  | "plugin.list"
  | "plugin.read"
  | "plugin.install"
  | "plugin.uninstall"
  | "plugin.connect"
  | "plugin.disconnect"
  | "marketplace.list"
  | "marketplace.add"
  | "marketplace.update"
  | "marketplace.remove"
  | "plugin.set_enabled"
  | "plugin.set_trusted"
  | "credential.grant"
  | "credential.revoke"
  | "mcp.list"
  | "mcp.add"
  | "mcp.remove"
  | "mcp.set_enabled"
  | "mcp.tools"
  | "mcp.skipped"
  | "mcp.retry"
  | "connector.list"
  | "connector.connect"
  | "connector.disconnect";

/** A personal server on the wire. `extra` adds what only the hub knows (sign-in, tools). */
export const serverInfo = (
  { server, credentials }: PersonalServer,
  extra: Partial<Pick<typeof McpServerInfo.Type, "status" | "problem" | "tools" | "idle_tokens_estimate">> = {},
): typeof McpServerInfo.Type => {
  const headerOf = new Map((server.headers ?? []).map((header) => [headerCredential(server.name, header), header]));
  return {
    name: server.name,
    ...(server.command === undefined ? {} : { command: server.command }),
    ...(server.args === undefined ? {} : { args: [...server.args] }),
    ...(server.url === undefined ? {} : { url: server.url }),
    ...(server.auth === undefined ? {} : { auth: server.auth }),
    source: server.source,
    enabled: server.enabled,
    credentials: credentials.map((c) => ({ ...c, ...(headerOf.has(c.name) ? { header: headerOf.get(c.name)! } : {}) })),
    ...(server.cloudConsent === true ? { cloud_available: true } : {}),
    ...extra,
  };
};

const tokens = (bytes: number) => Math.ceil(bytes / 4);
const invalidParams = (message: string) => new PluginRegistryError({ message, invalid: true });

/** A plugin's estimate plus the tool schemas its servers last listed through the hub, and each server's share. */
export function pluginWithMeasured(plugin: PluginListing, measured: (server: HubServer) => { readonly bytes: number } | undefined): PluginListing {
  const perServer = Object.fromEntries(
    (plugin.unmeasured_servers ?? []).flatMap((server) => {
      const m = measured({ plugin: plugin.id, server });
      return m === undefined ? [] : [[server, tokens(m.bytes)] as const];
    }),
  );
  const added = Object.values(perServer).reduce((sum, n) => sum + n, 0);
  return {
    ...plugin,
    idle_tokens_estimate: (plugin.idle_tokens_estimate ?? 0) + added,
    unmeasured_servers: (plugin.unmeasured_servers ?? []).filter((server) => !(server in perServer)),
    server_idle_tokens_estimate: perServer,
  };
}

/** A project a plugin is installed for, as the handlers resolve a project.list id. */
export interface ProjectRef {
  readonly id: string;
  readonly name: string;
  readonly path: string;
  /** `host/owner/name`; undefined for a repository with no origin. */
  readonly repository: string | undefined;
}

/**
 * The server an mcp.tools check names by `name` alone: the person's own server of that name, on or off, or else the
 * server whose key it is outside any repository (a plugin's `<plugin>__<server>`, which clients sent before the check
 * took `plugin`).
 */
const serverNamed = (r: PluginRegistry["Service"], name: string) =>
  r.servers.pipe(
    Effect.flatMap((own) =>
      own.some((s) => s.server.name === name)
        ? Effect.succeed(personalServer(name))
        : r.session().pipe(
            Effect.map((s): HubServer => {
              const owner = serverKeys(s.plugins).get(name);
              return owner === undefined ? personalServer(name) : { plugin: owner.plugin.id, server: owner.server };
            }),
          ),
    ),
  );

/** Which of a plugin's parts reach each engine (resolve.ts projections). */
function enginesOf(plugin: LoadedPlugin | undefined): Array<{ engine: "claude-agent" | "codex" | "caveman"; gets: string[]; misses: string[] }> {
  if (plugin === undefined) return [];
  const servers = Object.values(plugin.mcpServers);
  const sse = servers.some((s) => s.type === "sse");
  const hooks = Object.keys(plugin.hooks);
  // Hooks in skill, command and agent frontmatter run in Claude Agent alone: only its plugin copy carries them.
  const itemHooks = [...plugin.skills, ...plugin.commands, ...plugin.agents].some((item) => item.hooks !== undefined);
  const parts = {
    skills: plugin.skills.length > 0,
    "MCP servers": servers.length > 0,
    commands: plugin.commands.length > 0,
    agents: plugin.agents.length > 0,
    hooks: Object.keys(allHooks(plugin)).length > 0,
    rules: plugin.rules.length > 0,
  };
  const has = (Object.keys(parts) as Array<keyof typeof parts>).filter((k) => parts[k]);
  const reach = (misses: ReadonlyArray<string>) => ({ gets: has.filter((p) => !misses.includes(p)), misses: has.filter((p) => misses.includes(p)) });
  return [
    { engine: "claude-agent", ...reach([]) },
    // Codex: no agents or hooks of its own (the runtime runs SessionStart hooks), no SSE. Commands reach Codex and the
    // Caveman engine as their text (plugins/commands.ts).
    { engine: "codex", ...reach(["agents", ...(itemHooks || hooks.some((h) => h !== "SessionStart") ? ["hooks"] : []), ...(sse && servers.every((s) => s.type === "sse") ? ["MCP servers"] : [])]) },
    { engine: "caveman", ...reach(["agents", ...(itemHooks ? ["hooks"] : []), ...(sse && servers.every((s) => s.type === "sse") ? ["MCP servers"] : [])]) },
  ];
}

export const makePluginHandlersWith = (deps: {
  readonly projectOf: (id: string) => Effect.Effect<ProjectRef | undefined>;
  /** The project whose checkout is `cwd`, for a project install the Plugins page names by path. */
  readonly projectAt?: (cwd: string) => Effect.Effect<ProjectRef | undefined>;
  /** Asks a URL server whether it signs in (personal.ts signInNeeded); tests answer without the network. */
  readonly probe?: (url: string) => Promise<boolean | undefined>;
}) => Effect.gen(function* () {
  const registry = yield* Effect.serviceOption(PluginRegistry);
  const hub = yield* Effect.serviceOption(McpHub);
  const connectors = yield* Effect.serviceOption(Connectors);
  // Servers Claude Agent leaves out of new chats; a host without the store skips none.
  const stalled = yield* Effect.serviceOption(StalledMcpServers);
  const account = yield* makeAccountStore;
  /** Whether a plugin's or server's key may be kept on this computer. */
  const insideComputer = yield* makeInsideComputer;
  /** Whether the person's keys stay outside this computer (a Cloud computer under the rule; never a Mac). */
  const rule = yield* credentialRule;
  /**
   * A server or marketplace whose command line or URL carries a key (personal.ts holdsCredential, as an import and
   * the profile leave one out) is a key kept with it: taken only where this computer may keep one.
   */
  const noKeyInLine = (what: "server" | "marketplace", line: ReadonlyArray<string | undefined>) =>
    holdsCredential(line.filter((part) => part !== undefined)) ? insideComputer(outsideLine(what)) : Effect.void;
  /** A server's sign-in state, for one that signs in. */
  const signIn = (server: PluginServer) =>
    server.auth === undefined || server.url === undefined || Option.isNone(connectors)
      ? Effect.succeed<Connection | undefined>(undefined)
      : connectors.value.status({ name: server.name, url: server.url, auth: server.auth });
  const signInFields = (c: Connection | undefined) =>
    c === undefined
      ? {}
      : { status: c.status, ...(c.problem === undefined ? {} : { problem: c.problem }), ...(c.heldBy === undefined ? {} : { held_by: c.heldBy }), ...(c.heldReason === undefined ? {} : { held_reason: c.heldReason }) };
  const measured = (server: HubServer) => (Option.isSome(hub) ? Option.getOrUndefined(hub.value.measured(server)) : undefined);
  const withMeasured = (plugin: PluginListing) => pluginWithMeasured(plugin, measured);
  /** Closes every connection the hub has to the server, in every thread (the key it has differs by repository). */
  const closeConnections = (server: HubServer) => (Option.isSome(hub) ? hub.value.disconnect(server) : Effect.void);
  const hubError = (error: McpHubError) =>
    new ProtocolError({ reason: error.reason === "not_found" ? "not_found" : error.reason === "sign_in" ? "invalid_state" : "internal", message: error.message });
  const run = <A>(use: (registry: PluginRegistry["Service"]) => Effect.Effect<A, PluginRegistryError>) =>
    Option.isNone(registry)
      ? Effect.fail(new ProtocolError({ reason: "unsupported", message: "this runtime has no plugins" }))
      : use(registry.value).pipe(
          Effect.mapError(
            (error) =>
              new ProtocolError({
                reason: error.forbidden ? "forbidden" : error.unsupported ? "unsupported" : error.invalid ? "invalid_params" : "internal",
                message: error.message,
              }),
          ),
        );
  const done = Effect.as({});
  /**
   * A plugin server's sign-in, under the key the hub knows it by; a shared install's falls back to the team's
   * account. To one who connects the team's account (`team`), a shared install's is the team's alone.
   */
  const serverSignIn = (row: Pick<ListedPlugin, "plugin" | "shared" | "summary">, s: AuthServer, team = false) =>
    Option.isNone(connectors) || row.plugin === undefined
      ? Effect.succeed<Connection | undefined>(undefined)
      : connectors.value.status({ name: mcpServerKey(row.plugin.name, s.server), url: s.url, auth: s.auth }, row.shared ? { shared: { pluginId: row.summary.id, ...(team ? { alone: true } : {}) } } : {});
  /** On, and a server it needs has no working sign-in (neither the person's own nor, for a shared install, the team's). */
  const needsConnect = (row: ListedPlugin, team: boolean) =>
    !row.summary.enabled || row.plugin === undefined
      ? Effect.succeed(false)
      : Effect.forEach(
          row.authServers.filter((s) => s.unavailable === undefined),
          (s) => serverSignIn(row, s, team).pipe(Effect.map((c) => c !== undefined && c.status !== "connected")),
        ).pipe(Effect.map((list) => list.some(Boolean)));
  const summaryOf = (row: ListedPlugin, team: boolean) =>
    needsConnect(row, team).pipe(
      Effect.map((needs_connect): PluginSummary => ({ ...(withMeasured(row.summary as PluginListing) as typeof row.summary), needs_connect })),
    );
  const rowOf = (r: PluginRegistry["Service"], id: string, cwd: string | undefined) =>
    r.listing({ cwd }).pipe(
      Effect.flatMap((l) => {
        const row = l.plugins.find((p) => p.summary.id === id);
        return row === undefined ? Effect.fail(new PluginRegistryError({ message: `no plugin ${id}`, invalid: true })) : Effect.succeed(row);
      }),
    );
  /** Members connect their own account; owners and admins (or a role not known) connect a shared install's team account. */
  const connectsTeam = (r: PluginRegistry["Service"]) => Effect.map(r.role, (role) => role !== "member");
  /**
   * Servers still without a working sign-in, for the connect step. A shared
   * install's are the team's account to connect, offered to admins only; a
   * member connects their own (plugin.connect picks it for them).
   */
  const targetsOf = (r: PluginRegistry["Service"], row: ListedPlugin) =>
    row.plugin === undefined || row.summary.authentication === "on_use"
      ? Effect.succeed([])
      : Effect.flatMap(connectsTeam(r), (team) => Effect.filter(row.authServers, (s) =>
          s.unavailable !== undefined ? Effect.succeed(true) : serverSignIn(row, s, team).pipe(Effect.map((c) => c === undefined || c.status !== "connected")),
        ).pipe(
          Effect.map((servers) =>
            servers.map((s) => ({
              plugin_id: row.summary.id,
              server: s.server,
              title: row.summary.interface.display_name ?? row.summary.name,
              auth: s.auth,
              ...(s.unavailable === undefined ? {} : { unavailable: s.unavailable }),
              ...(row.shared && team ? { shared: true } : {}),
            })),
          ),
        ));
  /** A project install's project: by its project.list id, else (scope project) the project whose checkout is `cwd`. */
  const projectFor = (p: { readonly scope: string; readonly project_id?: string | undefined; readonly cwd?: string | undefined }) =>
    p.project_id !== undefined
      ? deps.projectOf(p.project_id).pipe(
          Effect.flatMap((project) => (project === undefined ? Effect.fail(new PluginRegistryError({ message: `no project ${p.project_id}`, invalid: true })) : Effect.succeed(project))),
        )
      : p.scope === "project" && p.cwd !== undefined && deps.projectAt !== undefined
        ? deps.projectAt(p.cwd).pipe(
            Effect.flatMap((project) => (project === undefined ? Effect.fail(new PluginRegistryError({ message: `no project at ${p.cwd}`, invalid: true })) : Effect.succeed(project))),
          )
        : Effect.succeed(undefined);
  /** Project and team writes in Caveman Cloud, with the person's own sign-in; a project is found by its repository, or made. */
  const cloudWrites: CloudWrites = {
    install: async (input) => {
      const projectId = input.scope === "project" ? await cloudProjectFor(input.project) : undefined;
      await installPlugin(account, {
        scope: input.scope,
        ...(projectId === undefined ? {} : { project_id: projectId }),
        plugin_id: input.plugin_id,
        ...(input.source === undefined ? {} : { source: input.source }),
        ...(input.commit === undefined ? {} : { commit: input.commit }),
        ...(input.version === undefined ? {} : { version: input.version }),
        policy: input.policy,
        connection: input.connection,
      });
    },
    uninstall: async (input) => {
      const projectId = input.scope === "project" ? (await cloudProjectOf(input.project))?.id : undefined;
      if (input.scope === "project" && projectId === undefined) throw new Error(`${input.project?.name ?? "this project"} has no plugins with Caveman`);
      await uninstallPlugin(account, { scope: input.scope, ...(projectId === undefined ? {} : { project_id: projectId }), plugin_id: input.plugin_id });
    },
    addMarketplace: async (input) => {
      await addOrgMarketplace(account, input);
    },
  };
  /** Cloud's project holding the repository; Cloud keeps repository keys lower-case. */
  const cloudProjectOf = async (project: InstallRequest["project"]) => {
    const key = project?.repository?.toLowerCase();
    if (key === undefined) return undefined;
    return (await listProjects(account)).find((p) => p.repos.some((r) => r.toLowerCase() === key));
  };
  const cloudProjectFor = async (project: InstallRequest["project"]) => {
    if (project?.repository === undefined) throw new Error("A project install needs a repository with an origin on a git host");
    return (await projectForRepository(account, project.repository, project.name)).id;
  };
  /** Signs in to one of a plugin's servers; for a shared install the team's account (an admin), or with `shared: false` the person's own. */
  const connect = (row: ListedPlugin, server: string, shared?: boolean) =>
    Effect.gen(function* () {
      const s = row.authServers.find((a) => a.server === server);
      if (row.plugin === undefined || s === undefined) return yield* Effect.fail(new PluginRegistryError({ message: `${row.summary.id} has no server ${server} that signs in`, invalid: true }));
      if (s.unavailable !== undefined) return yield* Effect.fail(new PluginRegistryError({ message: s.unavailable, invalid: true }));
      if (Option.isNone(connectors)) return yield* Effect.fail(new PluginRegistryError({ message: "this runtime has no sign-ins", invalid: true }));
      const c = yield* connectors.value.connect({ name: mcpServerKey(row.plugin.name, s.server), url: s.url, auth: s.auth }, row.shared && shared !== false ? { shared: { pluginId: row.summary.id } } : {});
      // A connection made before the sign-in would keep failing: the next one starts fresh.
      if (c.status === "connected") yield* closeConnections({ plugin: row.plugin.id, server: s.server });
      return {
        status: c.status,
        ...(c.authorizationUrl === undefined ? {} : { authorization_url: c.authorizationUrl }),
        ...(c.problem === undefined ? {} : { problem: c.problem }),
      };
    });
  /** Catalog plugins whose servers sign in: what Connectors listed before plugins (connector.list). */
  const catalogConnectors = (r: PluginRegistry["Service"]) =>
    r.listing({ marketplace: CATALOG_NAME }).pipe(Effect.map((l) => l.plugins.filter((p) => p.authServers.length > 0)));
  return {
    "plugin.list": (p) =>
      Option.isNone(registry)
        ? Effect.succeed({ plugins: [], featured: [], categories: [] })
        : run((r) =>
            Effect.gen(function* () {
              const l = yield* r.listing(p);
              const team = yield* connectsTeam(r);
              return {
                plugins: yield* Effect.forEach(l.plugins, (row) => summaryOf(row, team)),
                featured: [...l.featured],
                categories: [...l.categories],
                ...(l.cloudProblem === undefined ? {} : { cloud_problem: l.cloudProblem }),
              };
            }),
          ),
    "plugin.read": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const row = yield* rowOf(r, p.id, p.cwd);
          const team = yield* connectsTeam(r);
          const plugin = row.plugin;
          const ui = plugin?.interface ?? {};
          const servers = yield* Effect.forEach(Object.entries(plugin?.mcpServers ?? {}), ([name, config]) => {
            const auth = row.authServers.find((a) => a.server === name);
            return (auth === undefined || plugin === undefined ? Effect.succeed(undefined) : serverSignIn(row, auth, team)).pipe(
              Effect.map((c) => ({
                name,
                transport: config.type ?? ("stdio" as const),
                ...(auth === undefined ? {} : { auth: auth.auth, connected: c?.status === "connected" }),
                ...(c?.problem === undefined || c.status === "connected" ? {} : { problem: c.problem }),
                ...(c?.heldBy === undefined ? {} : { held_by: c.heldBy }),
                ...(auth?.unavailable === undefined ? {} : { unavailable: auth.unavailable }),
                ...(c?.shared === true ? { shared: true, ...(c.sharedBy === undefined ? {} : { shared_by: c.sharedBy }) } : {}),
              })),
            );
          });
          const summary = yield* summaryOf(row, team);
          return {
            plugin: {
              ...summary,
              ...(ui.long_description === undefined ? {} : { long_description: ui.long_description }),
              default_prompts: [...(ui.default_prompts ?? [])],
              links: { ...(ui.website === undefined ? {} : { website: ui.website }), ...(ui.privacy === undefined ? {} : { privacy: ui.privacy }), ...(ui.terms === undefined ? {} : { terms: ui.terms }) },
              ...(ui.screenshots === undefined ? {} : { screenshots: [...ui.screenshots] }),
              skill_details: (plugin?.skills ?? []).map((s) => ({ name: s.name, description: s.description })),
              server_details: servers,
              rules: (plugin?.rules ?? []).map((rule) => rule.name),
              engines: enginesOf(plugin),
              source: row.market.source,
              ...(row.market.commit === undefined ? {} : { commit: row.market.commit }),
            },
          };
        }),
      ),
    "plugin.install": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const project = yield* projectFor(p);
          if (p.scope === "project" && project === undefined) return yield* Effect.fail(new PluginRegistryError({ message: "a project install names its project (project_id, or its path as cwd)", invalid: true }));
          yield* r.install(
            {
              id: p.id,
              scope: p.scope,
              ...(project === undefined ? {} : { project: { id: project.id, name: project.name, repository: project.repository } }),
              ...(p.policy === undefined ? {} : { policy: p.policy }),
              ...(p.connection === undefined ? {} : { connection: p.connection }),
              ...(p.add_to_team === undefined ? {} : { addToTeam: p.add_to_team }),
              cwd: p.cwd ?? project?.path,
            },
            cloudWrites,
          );
          const row = yield* rowOf(r, p.id, p.cwd ?? project?.path);
          return { installed: true as const, needs_connect: yield* targetsOf(r, row) };
        }),
      ),
    "plugin.uninstall": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const project = yield* projectFor(p);
          yield* r.uninstall(
            { id: p.id, scope: p.scope, ...(project === undefined ? {} : { project: { id: project.id, name: project.name, repository: project.repository } }), cwd: p.cwd ?? project?.path },
            cloudWrites,
          );
        }),
      ).pipe(done),
    "plugin.connect": (p) =>
      run((r) =>
        Effect.all([rowOf(r, p.id, p.cwd), connectsTeam(r)]).pipe(Effect.flatMap(([row, team]) => connect(row, p.server, p.shared ?? team))),
      ),
    "plugin.disconnect": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const row = yield* rowOf(r, p.id, p.cwd);
          const s = row.authServers.find((a) => a.server === p.server);
          if (!row.shared || s === undefined) return yield* Effect.fail(invalidParams(`${p.id} has no team account for ${p.server}`));
          if (!(yield* connectsTeam(r))) return yield* Effect.fail(new PluginRegistryError({ message: "Only an admin removes the team's account", forbidden: true }));
          if (Option.isNone(connectors)) return yield* Effect.fail(invalidParams("this runtime has no sign-ins"));
          yield* connectors.value.disconnectShared({ url: s.url, auth: s.auth }, { pluginId: row.summary.id }).pipe(Effect.mapError((error) => new PluginRegistryError({ message: error.message })));
          yield* closeConnections({ plugin: row.summary.id, server: s.server });
        }),
      ).pipe(done),
    "marketplace.list": (p) => run((r) => r.marketplaces(p.cwd).pipe(Effect.map((marketplaces) => ({ marketplaces: [...marketplaces] })))),
    "marketplace.add": (p) => noKeyInLine("marketplace", [p.source]).pipe(Effect.andThen(run((r) => r.addMarketplace(p.source)))),
    "marketplace.update": (p) => run((r) => r.updateMarketplace(p.name).pipe(Effect.map((u) => ({ changed: [...u.changed], trust_dropped: [...u.trust_dropped] })))),
    "marketplace.remove": (p) => run((r) => r.removeMarketplace(p.name)).pipe(done),
    "plugin.set_enabled": (p) =>
      run((r) => r.setEnabled(p.plugin_id, p.enabled, p.cwd, p.here)).pipe(
        // A Required plugin stays on: the state forbids it, not the person.
        Effect.mapError((error) => (error.reason === "forbidden" ? new ProtocolError({ reason: "invalid_state", message: error.message }) : error)),
        done,
      ),
    "plugin.set_trusted": (p) => run((r) => r.setTrusted(p.plugin_id, p.trusted, p.cwd)).pipe(done),
    "credential.grant": (p) => insideComputer(OUTSIDE_SERVER_KEY).pipe(Effect.andThen(run((r) => r.grant(p.marketplace, p.name, Redacted.make(p.value), p.cwd))), done),
    "credential.revoke": (p) => run((r) => r.revoke(p.marketplace, p.name, p.cwd)).pipe(done),
    "mcp.list": (p) =>
      Option.isNone(registry)
        ? Effect.succeed({ servers: [] })
        : run((r) => Effect.all([r.servers, r.serverSwitches(p.cwd)])).pipe(
            Effect.flatMap(([servers, here]) =>
              Effect.forEach(servers, (s) =>
                signIn(s.server).pipe(
                  Effect.map((c) => {
                    const m = measured(personalServer(s.server.name));
                    // The project's own switch wins there, and is named only where it differs from the server's.
                    const on = here.get(s.server.name) ?? s.server.enabled;
                    return {
                      ...serverInfo(s, {
                        ...signInFields(c),
                        ...(m === undefined ? {} : { tools: [...m.tools], idle_tokens_estimate: tokens(m.bytes) }),
                        // A key it needs is not here and cannot be brought in: it is in no chat on this computer, and says so.
                        ...(rule.known() === true && s.credentials.some((credential) => !credential.granted) ? { problem: keyStaysOnMac(s.server.name) } : {}),
                      }),
                      enabled: on,
                      ...(on === s.server.enabled ? {} : { here: on ? ("on" as const) : ("off" as const) }),
                    };
                  }),
                ),
              ),
            ),
            Effect.map((servers) => ({ servers })),
          ),
    "mcp.add": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const server: PluginServer = {
            name: p.name.trim(),
            ...(p.command === undefined ? {} : { command: p.command.trim() }),
            ...(p.args === undefined ? {} : { args: p.args }),
            ...(p.url === undefined ? {} : { url: p.url.trim() }),
            ...(p.env === undefined || p.env.length === 0 ? {} : { env: p.env }),
            ...(p.headers === undefined || p.headers.length === 0 ? {} : { headers: p.headers }),
            ...(p.auth === undefined ? {} : { auth: p.auth }),
            source: "manual",
            enabled: true,
          };
          // Nothing is asked of a URL the runtime would refuse anyway.
          const problem = serverProblem(server);
          if (problem !== undefined) return yield* Effect.fail(invalidParams(problem));
          // A URL set to sign in that answers without one and offers none is kept without (OAuth could not start there).
          const settled = yield* Effect.promise(() => settleSignIn(server, deps.probe));
          yield* r.saveServer(settled, false);
          const saved = (yield* r.servers).find((s) => s.server.name === settled.name);
          return serverInfo(saved ?? { server: settled, credentials: serverCredentials(settled).map((name) => ({ name, granted: false })) });
        }),
        // First of all, before its URL is asked whether it signs in: a key in its command line or URL is sent nowhere.
      ).pipe((add) => Effect.andThen(noKeyInLine("server", [p.command, ...(p.args ?? []), p.url]), add)),
    "mcp.remove": (p) => run((r) => r.removeServer(p.name)).pipe(done),
    "mcp.set_enabled": (p) => run((r) => r.setServerEnabled(p.name, p.enabled, p.cwd, p.here)).pipe(done),
    "mcp.tools": (p) => {
      if (Option.isNone(hub)) return Effect.fail(new ProtocolError({ reason: "unsupported", message: "this runtime has no MCP hub" }));
      const asked: Effect.Effect<HubServer, ProtocolError> =
        p.plugin === undefined ? run((r) => serverNamed(r, p.server)) : Effect.succeed({ plugin: p.plugin, server: p.server });
      return asked.pipe(
        Effect.flatMap((server) =>
          hub.value.tools(server).pipe(
            Effect.mapError(hubError),
            Effect.map((tools) => ({
              tools: tools.map((t) => ({ name: t.name, ...(t.description === undefined ? {} : { description: t.description }) })),
              idle_tokens_estimate: tokens(measured(server)?.bytes ?? 0),
            })),
          ),
        ),
      );
    },
    "mcp.skipped": () =>
      Option.isNone(stalled)
        ? Effect.succeed({ servers: [] })
        : stalled.value.list.pipe(
            Effect.map((list) => {
              const now = Date.now();
              return {
                servers: list
                  .filter((s) => skipping(s, now))
                  .map((s) => ({ server: s.server, at: s.at, until: new Date(skippedUntil(s)).toISOString() })),
              };
            }),
          ),
    "mcp.retry": (p) => (Option.isNone(stalled) ? Effect.void : stalled.value.retry(p.server)).pipe(done),
    // Connectors are the Caveman catalog's plugins whose servers sign in; connecting one installs it for me.
    "connector.list": () =>
      run((r) =>
        catalogConnectors(r).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (row) => {
              const s = row.authServers[0]!;
              return (row.plugin === undefined ? Effect.succeed(undefined) : serverSignIn(row, s)).pipe(
                Effect.map((c): typeof ConnectorInfo.Type => ({
                  id: row.summary.name,
                  name: row.summary.interface.display_name ?? row.summary.name,
                  description: row.summary.interface.short_description ?? row.summary.description ?? "",
                  url: s.url,
                  auth: s.auth,
                  added: row.summary.installed,
                  ...(s.unavailable === undefined ? signInFields(c) : { unavailable: s.unavailable }),
                })),
              );
            }),
          ),
          Effect.map((list) => ({ connectors: list })),
        ),
      ),
    "connector.connect": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const row = (yield* catalogConnectors(r)).find((c) => c.summary.name === p.id);
          if (row !== undefined) {
            if (!row.summary.installed) yield* r.install({ id: row.summary.id, scope: "me" });
            return yield* connect(yield* rowOf(r, row.summary.id, undefined), row.authServers[0]!.server);
          }
          // One of your own servers that signs in.
          const server = (yield* r.servers).find((s) => s.server.name === p.id)?.server;
          if (server === undefined) return yield* Effect.fail(invalidParams(`no connector or server ${p.id}`));
          if (server.auth === undefined || server.url === undefined) return yield* Effect.fail(invalidParams(`${p.id} does not sign in`));
          if (Option.isNone(connectors)) return yield* Effect.fail(invalidParams("this runtime has no sign-ins"));
          // One that answers without a sign-in (imported before imports asked) needs none: kept without, it just works.
          const settled = yield* Effect.promise(() => settleSignIn(server, deps.probe));
          if (settled.auth === undefined) {
            // A sign-in kept from before goes with it, so no tokens stay behind that nothing can forget.
            yield* connectors.value.disconnect(server.url).pipe(Effect.ignore);
            yield* r.saveServer(settled, true);
            yield* closeConnections(personalServer(server.name));
            return { status: "connected" as const };
          }
          const c = yield* connectors.value.connect({ name: server.name, url: server.url, auth: server.auth }, { moveToCloud: p.move_to_cloud === true });
          // A connection made before the sign-in would keep failing: the next one starts fresh.
          if (c.status === "connected") yield* closeConnections(personalServer(server.name));
          return {
            status: c.status,
            ...(c.authorizationUrl === undefined ? {} : { authorization_url: c.authorizationUrl }),
            ...(c.problem === undefined ? {} : { problem: c.problem }),
          };
        }),
      ),
    "connector.disconnect": (p) =>
      run((r) =>
        Effect.gen(function* () {
          const row = (yield* catalogConnectors(r)).find((c) => c.summary.name === p.id);
          const own = (yield* r.servers).find((s) => s.server.name === p.id)?.server;
          const url = row?.authServers[0]?.url ?? own?.url;
          if (url === undefined || (row?.authServers[0]?.auth ?? own?.auth) !== "oauth") return yield* Effect.fail(invalidParams(`${p.id} has no sign-in to forget`));
          if (Option.isSome(connectors))
            yield* connectors.value.disconnect(url).pipe(Effect.mapError((error) => new PluginRegistryError({ message: error.message })));
          yield* closeConnections(row === undefined ? personalServer(p.id) : { plugin: row.summary.id, server: row.authServers[0]!.server });
        }),
      ).pipe(done),
  } satisfies { readonly [M in PluginMethod]: Handler<M> };
});

/** Without projects (tests, hosts with no project store): project installs answer not found. */
export const makePluginHandlers = makePluginHandlersWith({ projectOf: () => Effect.succeed(undefined) });
