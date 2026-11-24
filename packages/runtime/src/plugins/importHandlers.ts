/**
 * Session Protocol handlers for import.scan, import.apply and import.folder:
 * bringing in Claude Code, Codex and Cursor setups and plain folders
 * (import/scan.ts). Marketplaces and plugins go through the registry, so an
 * import is the same add and install the Plugins page does; plugins install for me.
 *
 * @module plugins/importHandlers
 */
import * as path from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";

import { type Handler, ProtocolError } from "../session-protocol/handlers.ts";
import type { McpImportCandidate } from "@caveman-app/session-protocol/protocol";

import { applyImports, classifyFolder, copySkill, type FolderKind, importHomes, type ImportExisting, type ImportOps, importSources, type Ref, refKey, type ScannedItem, type ScannedSource, scanImports } from "./import/scan.ts";
import { allHooks, type LoadedPlugin, loadPlugin, loadSpace } from "./load.ts";
import { settleSignIn, signInNeeded } from "./personal.ts";
import { parseMarketplaceSource } from "./marketplaces.ts";
import { PluginRegistry, type PluginRegistryError } from "./PluginRegistry.ts";

type ImportMethod = "import.scan" | "import.apply" | "import.folder" | "mcp.import_scan" | "mcp.import";

/**
 * mcp.import_scan's rows: Claude Code's and Codex's MCP servers from the same scan import.scan makes (Cursor was never
 * part of it). A server another setup already brings, or one already added, says so as its reason.
 */
function mcpCandidates(sources: ReadonlyArray<ScannedSource>): Array<typeof McpImportCandidate.Type> {
  return sources.flatMap((source) =>
    source.from === "cursor"
      ? []
      : source.items.flatMap(({ item, payload }: ScannedItem) => {
          if (item.kind !== "mcp_server") return [];
          const base = { name: item.name, from: source.from as "claude" | "codex" };
          if (payload?.kind === "mcp_server") {
            const s = payload.server;
            return [{ ...base, name: s.name, ...(s.command === undefined ? {} : { command: s.command }), ...(s.args === undefined ? {} : { args: [...s.args] }), ...(s.url === undefined ? {} : { url: s.url }), ...(item.credentials ? { credentials: [...item.credentials] } : {}) }];
          }
          const reason = item.action === "skip" ? (item.reason ?? "it cannot be imported") : item.same_as !== undefined ? "another setup brings the same server" : "a server with this name is already added";
          return [{ ...base, reason }];
        }),
  );
}

/** Comparable form of a marketplace source: its git URL or folder (the ref is not part of what it is). */
const sourceKey = (source: string) => {
  const parsed = parseMarketplaceSource(source);
  return parsed.kind === "git" ? parsed.url : parsed.path;
};

/** A registry call as a promise that rejects with its plain message. */
const promise = <A>(effect: Effect.Effect<A, PluginRegistryError>): Promise<A> =>
  Effect.runPromise(Effect.exit(effect)).then((exit) => {
    if (Exit.isSuccess(exit)) return exit.value;
    const error = Cause.squash(exit.cause);
    throw new Error(error instanceof Error ? error.message : String(error));
  });

/** What a folder would bring, for import.folder's preview: every plugin it holds in place, with its servers' commands and its hooks (frontmatter ones too). */
async function previewFolder(dir: string, found: FolderKind) {
  if (found.kind === "skills") return { name: path.basename(dir), skills: found.skills.map((s) => s.name), mcp_servers: [], hooks: [], rules: [] };
  const read = await loadSpace(dir, "preview", path.basename(dir));
  const plugins: ReadonlyArray<LoadedPlugin> = read.plugins;
  const named = (p: LoadedPlugin) => (found.kind === "marketplace" ? { plugin: p.name } : {});
  return {
    name: read.market?.name ?? plugins[0]?.name ?? path.basename(dir),
    skills: plugins.flatMap((p) => p.skills.map((s) => (found.kind === "marketplace" ? `${p.name}:${s.name}` : s.name))),
    mcp_servers: plugins.flatMap((p) =>
      Object.entries(p.mcpServers).map(([name, server]) => ({
        name,
        ...named(p),
        ...("command" in server && server.command !== undefined ? { command: server.command, args: [...(server.args ?? [])] } : {}),
        ...("url" in server ? { url: server.url } : {}),
      })),
    ),
    hooks: plugins.flatMap((p) =>
      Object.entries(allHooks(p)).flatMap(([event, matchers]) => matchers.flatMap((m) => m.hooks.map((h) => ({ event, ...named(p), ...(h.command === undefined ? {} : { command: h.command }) })))),
    ),
    rules: plugins.flatMap((p) => p.rules.map((rule) => (found.kind === "marketplace" ? `${p.name}:${rule.name}` : rule.name))),
  };
}

export const makeImportHandlers = (deps: {
  readonly home: string;
  readonly codexOwnHome: Effect.Effect<boolean>;
  readonly env?: NodeJS.ProcessEnv;
  /** Asks a URL server whether it signs in (personal.ts signInNeeded); tests answer without the network. */
  readonly probe?: (url: string) => Promise<boolean | undefined>;
}) =>
  Effect.gen(function* () {
    const registry = yield* Effect.serviceOption(PluginRegistry);
    const homes = importHomes(deps.env ?? process.env, deps.home);
    const fail = (reason: "unsupported" | "invalid_params" | "internal", message: string) => new ProtocolError({ reason, message });
    const withRegistry = <A>(use: (registry: PluginRegistry["Service"]) => Promise<A>) =>
      Option.isNone(registry)
        ? Effect.fail(fail("unsupported", "this runtime has no plugins"))
        : Effect.tryPromise({ try: () => use(registry.value), catch: (cause) => fail("internal", (cause as Error).message) });

    const existing = async (r: PluginRegistry["Service"]): Promise<ImportExisting> => {
      const [markets, known, servers] = await Promise.all([promise(r.marketplaces()), promise(r.known), promise(r.servers)]);
      return {
        marketplaces: new Map(markets.map((m) => [m.name, m.kind === "caveman" ? undefined : sourceKey(m.source)])),
        sourceKey,
        installed: [...known.installs.keys()],
        servers: servers.map((s) => s.server.name),
      };
    };
    const scan = async (r: PluginRegistry["Service"]) =>
      scanImports(homes, { existing: await existing(r), codexOwnHome: await Effect.runPromise(deps.codexOwnHome) });
    // Servers are saved one at a time (one settings file), but each URL server's sign-in question is asked of all of
    // them at once before the first save, so ten remote servers wait as long as the slowest, not the sum.
    const ops = (r: PluginRegistry["Service"], sources: ReadonlyArray<ScannedSource>, refs: ReadonlyArray<Ref>): ImportOps => {
      const chosen = new Set(refs.map(refKey));
      const asked = new Map<string, Promise<boolean | undefined>>();
      const probe = deps.probe ?? signInNeeded;
      const ask = (url: string) => asked.get(url) ?? asked.set(url, probe(url).catch(() => undefined)).get(url)!;
      for (const { item, payload } of sources.flatMap((s) => s.items)) {
        if (payload?.kind !== "mcp_server" || !chosen.has(refKey(item))) continue;
        const { url, auth, headers } = payload.server;
        if (url !== undefined && auth === "oauth" && (headers?.length ?? 0) === 0) void ask(url);
      }
      return {
        addMarketplace: (source) => promise(r.addMarketplace(source)),
        install: (id) => promise(r.install({ id, scope: "me" })),
        saveServer: async (server) => promise(r.saveServer(await settleSignIn(server, ask), false)),
      };
    };

    const handlers: { readonly [M in ImportMethod]: Handler<M> } = {
      "import.scan": () => withRegistry(async (r) => ({ sources: importSources(await scan(r)) })),
      "import.apply": (p) =>
        withRegistry(async (r) => {
          const sources = await scan(r);
          return applyImports(sources, p.items, ops(r, sources, p.items), homes);
        }),
      // The MCP-only import, kept for older clients: the same scan and apply as import.scan and import.apply.
      "mcp.import_scan": () => withRegistry(async (r) => ({ candidates: mcpCandidates(await scan(r)) })),
      "mcp.import": (p) =>
        withRegistry(async (r) => {
          const sources = (await scan(r)).filter((s) => s.from !== "cursor");
          // Older clients name a server as mcp.import_scan offered it: its saved (cleaned) name, not the config's.
          const items = sources.flatMap((s) => s.items).filter(({ payload }) => payload?.kind === "mcp_server" && (p.names === undefined || p.names.includes(payload.server.name)));
          const refs = items.map(({ item }) => ({ from: item.from, kind: item.kind, name: item.name }));
          const { failed } = await applyImports(sources, refs, ops(r, sources, refs), homes);
          const lost = new Map(failed.map((f) => [refKey(f.ref), f.reason]));
          const skipped = mcpCandidates(sources).filter((c) => c.reason !== undefined);
          return {
            added: items.flatMap(({ item, payload }) => (!lost.has(refKey(item)) && payload?.kind === "mcp_server" ? [payload.server.name] : [])),
            skipped: [...skipped, ...failed.map((f) => ({ name: f.ref.name, from: f.ref.from as "claude" | "codex", reason: f.reason }))],
          };
        }),
      "import.folder": (p) =>
        Effect.tryPromise({ try: () => classifyFolder(p.path), catch: (cause) => fail("invalid_params", (cause as Error).message) }).pipe(
          Effect.flatMap((found) =>
            withRegistry(async (r) => {
              const preview = await previewFolder(p.path, found);
              // Nothing is written until the person has seen what it brings.
              if (p.confirm !== true) return { kind: found.kind, preview };
              if (found.kind === "skills") {
                for (const skill of found.skills) await copySkill(skill.dir, homes.agentsSkills, skill.name);
                return { kind: "skills" as const, added: found.skills.map((s) => s.name).join(", "), preview };
              }
              // A folder that is one plugin is a marketplace of one: read in place, no git.
              const { name } = await promise(r.addMarketplace(p.path));
              if (found.kind === "marketplace") return { kind: "marketplace" as const, added: name, preview };
              const id = `${(await loadPlugin(p.path, name)).name}@${name}`;
              await promise(r.install({ id, scope: "me" }));
              return { kind: "plugin" as const, added: id, preview };
            }),
          ),
        ),
    };
    return handlers;
  });
