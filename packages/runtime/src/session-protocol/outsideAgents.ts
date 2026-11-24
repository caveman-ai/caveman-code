// Outside agents (docs/ §2, §4): agents Caveman Code did not launch,
// operating it through `caveman-code mcp`. Their names and levels (the registry, kept in the session store), and the
// one gate every call of an `agent:<id>` connection passes before its handler: which methods, on which chats, with
// which params, and what of the answer goes back. Anything not in the gate's table is refused.
import * as fs from "node:fs";
import * as path from "node:path";

import type { AccessMode, EngineDescriptor, OutsideAgent, OutsideAgentLevel, Params, SessionEvent, Workspace } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";

import { codeHome } from "../cli/code.ts";
import { isToolAsk } from "./clientTools.ts";
import { isGrillAsk } from "./grill.ts";
import { ProtocolError } from "./handlers.ts";
import { THIS_MAC } from "./projector.ts";
import type { WorkspaceRecord } from "./store.ts";

export type Level = OutsideAgentLevel;
type AskUser = Extract<SessionEvent, { type: "ask.user" }>["payload"];

/** An agent connection's principal: `agent:<agent_id>`. Never `local`, never a Cloud user. */
export const AGENT_PRINCIPAL = "agent:";
export const isAgentPrincipal = (principal: string | undefined) => principal?.startsWith(AGENT_PRINCIPAL) === true;

const LEVEL_RANK: Record<Level, number> = { read: 0, supervised: 1, full: 2 };
export const LEVEL_LABEL: Record<Level, string> = { read: "Read", supervised: "Supervised", full: "Full access" };
/** The lower of a stored level and the `--at-most` the command was started with. */
export const lowerLevel = (level: Level, atMost: Level | undefined): Level => (atMost !== undefined && LEVEL_RANK[atMost] < LEVEL_RANK[level] ? atMost : level);

/** Access modes as upstream runtimeModeRank orders them (DispatchModeLimit.ts). */
const ACCESS_RANK: Record<AccessMode, number> = { ask: 0, auto: 1, review: 2, full: 3 };
export const ACCESS_LABEL: Record<AccessMode, string> = { ask: "Supervised", auto: "Auto-accept edits", review: "Auto", full: "Full access" };
/** The most a level's chats run with: Supervised's wait for the person on every command and edit it hasn't allowed. */
export const MOST_ACCESS: Record<Level, AccessMode | undefined> = { read: undefined, supervised: "ask", full: "full" };
const fits = (level: Level, access: AccessMode) => {
  const most = MOST_ACCESS[level];
  return most !== undefined && ACCESS_RANK[access] <= ACCESS_RANK[most];
};

/** The runaway guard: an agent's own chats with a running turn at once. */
export const MAX_WORKING = 10;
/** Workspace statuses of a running turn that isn't waiting on the person. */
export const RUNNING_STATUSES = new Set<Workspace["status"]>(["starting", "working", "waiting"]);

const SETTINGS = "Caveman Code > Settings > Caveman MCP";
export const disconnected = (name: string) => `Disconnected in ${SETTINGS}. Tell your user; they can allow ${name} there.`;

const forbidden = (message: string) => Effect.fail(new ProtocolError({ reason: "forbidden", message }));
const fail = (reason: string, message: string) => Effect.fail(new ProtocolError({ reason, message }));

// ------------------------------------------------------------------- names

/** Control, bidirectional and zero-width characters: none may shape how a name reads. */
const UNSEEN = /[\u0000-\u001f\u007f-\u009f­؜᠎​-‏‪-‮⁠-⁩﻿]/g;
const MAX_NAME = 40;
/** Names an agent never takes as they are: the person's own, the product's. A Chief's name joins them. */
const RESERVED = ["You", "Caveman"];

/**
 * The name an agent goes by: its control and bidirectional characters stripped, trimmed and capped at 40 characters,
 * with " (agent)" after it when it would read as the person, Caveman or one of their Chiefs. Undefined when nothing
 * is left.
 */
export function sanitizeName(raw: string, chiefNames: ReadonlyArray<string>): string | undefined {
  const cleaned = raw.normalize("NFKC").replace(UNSEEN, "").replace(/\s+/g, " ").trim();
  const name = [...cleaned].slice(0, MAX_NAME).join("").trim();
  if (name === "") return undefined;
  const fold = (s: string) => s.normalize("NFKC").replace(UNSEEN, "").trim().toLowerCase();
  return [...RESERVED, ...chiefNames].some((taken) => fold(taken) === fold(name)) ? `${name} (agent)` : name;
}

// ---------------------------------------------------------------- registry

export interface AgentEntry {
  readonly name: string;
  readonly level: Level;
  readonly blocked: boolean;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
}

/** The session store's kv key holding every agent by name, and which name each agent_id first connected as. */
export const REGISTRY_KEY = "outside_agents";
/** agent_ids remembered: one per `caveman-code mcp` install that ever connected; the oldest go first. */
const MAX_IDS = 1_000;

interface Kv {
  readonly kvGet: (key: string) => Effect.Effect<string | undefined>;
  readonly kvSet: (key: string, value: string) => Effect.Effect<void>;
}

export type Registry = Effect.Success<ReturnType<typeof makeRegistry>>;

/** Every outside agent that has connected, by name: its level (Supervised at first) and whether the person blocked it. */
export const makeRegistry = (kv: Kv) =>
  Effect.gen(function* () {
    const raw = yield* kv.kvGet(REGISTRY_KEY);
    let stored: { agents?: ReadonlyArray<AgentEntry>; ids?: Record<string, string> } = {};
    try {
      stored = JSON.parse(raw ?? "{}");
    } catch {
      // A value no runtime wrote: start over.
    }
    const agents = new Map((stored.agents ?? []).map((a) => [a.name, a] as const));
    const ids = new Map(Object.entries(stored.ids ?? {}));
    const save = Effect.suspend(() => kv.kvSet(REGISTRY_KEY, JSON.stringify({ agents: [...agents.values()], ids: Object.fromEntries(ids) })));
    return {
      entries: (): ReadonlyArray<AgentEntry> => [...agents.values()],
      get: (name: string) => agents.get(name),
      /** The name `agentId` first connected as, if it ever did. */
      nameOf: (agentId: string) => ids.get(agentId),
      /** `agentId` connected as `name` (refused before this when blocked or renamed): first seen once, last seen now. */
      seen: (agentId: string, name: string, at: string) =>
        Effect.suspend(() => {
          const before = agents.get(name);
          const entry: AgentEntry = before ? { ...before, last_seen_at: at } : { name, level: "supervised", blocked: false, first_seen_at: at, last_seen_at: at };
          agents.set(name, entry);
          if (!ids.has(agentId)) {
            ids.set(agentId, name);
            while (ids.size > MAX_IDS) ids.delete(ids.keys().next().value!);
          }
          return save.pipe(Effect.as(entry));
        }),
      /** The person's change in Settings: its level, or blocked (disconnected) and allowed again. */
      update: (name: string, change: { readonly level?: Level | undefined; readonly blocked?: boolean | undefined }) =>
        Effect.suspend(() => {
          const before = agents.get(name);
          if (before === undefined) return Effect.succeed(undefined);
          const entry: AgentEntry = { ...before, ...(change.level !== undefined ? { level: change.level } : {}), ...(change.blocked !== undefined ? { blocked: change.blocked } : {}) };
          agents.set(name, entry);
          return save.pipe(Effect.as(entry));
        }),
    };
  });

/** One agent as Settings lists it, from the registry entry and what the runtime has now. */
export const listed = (entry: AgentEntry, connected: number, workspaces: ReadonlyArray<Workspace>): OutsideAgent => {
  const own = workspaces.filter((w) => w.started_by?.agent === entry.name && w.status !== "archived");
  return { ...entry, connected, chats: own.length, working: own.filter((w) => RUNNING_STATUSES.has(w.status)).length };
};

/**
 * The argv an MCP client runs to connect (Settings > Caveman MCP's Install and Copy): `caveman-code` when the person
 * put it on their PATH, else the launcher in the Caveman Code home, else (a development checkout) this runtime's entry.
 */
export function connectCommand(env: NodeJS.ProcessEnv = process.env, entry: string | undefined = process.argv[1]): ReadonlyArray<string> {
  try {
    if (fs.lstatSync("/usr/local/bin/caveman-code").isSymbolicLink()) return ["caveman-code", "mcp"];
  } catch {
    // Not on the PATH.
  }
  const launcher = path.join(codeHome(env), "bin", "caveman-code");
  if (fs.existsSync(launcher)) return [launcher, "mcp"];
  let bin = entry === undefined ? "" : path.resolve(entry);
  try {
    bin = fs.realpathSync(bin);
  } catch {
    // As given.
  }
  return [process.execPath, bin, "code", "mcp"];
}

// ----------------------------------------------------------------- lineage

/** What the target rule reads of a chat: what kind it is, who started it, and the chat it hangs under. */
export type Lineage = Pick<Workspace, "id" | "kind" | "parent_workspace_id" | "started_by">;
const MAX_HOPS = 8;

/** A chat and the chats above it (builders and delegated children hang under their lead), nearest first. */
export function lineageOf(first: Lineage, parentOf: (id: string) => Lineage | undefined): ReadonlyArray<Lineage> {
  const chain = [first];
  for (let at = first; at.parent_workspace_id !== undefined && chain.length <= MAX_HOPS; ) {
    const parent = parentOf(at.parent_workspace_id);
    if (parent === undefined || chain.some((w) => w.id === parent.id)) break;
    chain.push(parent);
    at = parent;
  }
  return chain;
}

/** lineageOf, reading each parent from the store. */
export const lineageIn = (first: Lineage, parentOf: (id: string) => Effect.Effect<Lineage | undefined>) =>
  Effect.gen(function* () {
    const chain: Array<Lineage> = [first];
    for (let at = first; at.parent_workspace_id !== undefined && chain.length <= MAX_HOPS; ) {
      const parent = yield* parentOf(at.parent_workspace_id);
      if (parent === undefined || chain.some((w) => w.id === parent.id)) break;
      chain.push(parent);
      at = parent;
    }
    return chain as ReadonlyArray<Lineage>;
  });

/** A Chief's chat, a setup chat, or a chat under one: never an outside agent's to reach. */
export const hidden = (chain: ReadonlyArray<Lineage>) => chain.some((w) => w.kind === "chief" || w.kind === "setup");
/** A chat `name` started, or one under it. */
export const owns = (chain: ReadonlyArray<Lineage>, name: string) => chain.some((w) => w.started_by?.agent === name);

/** engine.list (and engine.changed) as an outside agent gets it: no logins and no plan limits, which are the person's. */
export const enginesForAgents = <T extends { readonly engines: ReadonlyArray<EngineDescriptor> }>(value: T): T => ({
  ...value,
  engines: value.engines.map(({ usage_limits: _limits, usage_on_credits: _credits, auth, ...engine }) => ({ ...engine, auth: { state: auth.state, accounts: [] } })),
});

/** Whether a notification reaches an agent connection: workspace.changed for chats it may read, and engine.changed. */
export const agentHears = (method: string, params: unknown, readable: (workspace: Workspace) => boolean) =>
  method === "engine.changed" || (method === "workspace.changed" && params !== null && typeof params === "object" && readable(params as Workspace));

// -------------------------------------------------------------------- gate

/** What the gate reads of the runtime (server.ts gives it the store and handlers; tests give fakes). */
export interface GateDeps {
  readonly workspace: (id: string) => Effect.Effect<WorkspaceRecord | undefined>;
  readonly session: (id: string) => Effect.Effect<WorkspaceRecord | undefined>;
  readonly workspaces: Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
  /** The paths of the person's projects (project.list). */
  readonly projectPaths: Effect.Effect<ReadonlyArray<string>>;
  /** Settings' default engine, which a new chat that names none runs on. */
  readonly defaultEngine: Effect.Effect<string>;
  /** A new chat's access when it asks for none: its project's default, else the person's. */
  readonly defaultAccess: (engine: string, repoPath: string) => Effect.Effect<AccessMode>;
  /** The access modes an engine honours: ["full"] for one that can't ask before acting (accessFor); undefined: all. */
  readonly accessModes: (engine: string) => Effect.Effect<ReadonlyArray<AccessMode> | undefined>;
 /** What the chat's thread runs at now (upstream runtime and interaction mode), when it has one. */
  readonly threadModes: (record: WorkspaceRecord) => Effect.Effect<{ readonly access: AccessMode; readonly grill: boolean } | undefined>;
 /** The engine's request the runtime holds under this ask id while it waits (upstream runtime request): its kind. */
  readonly pendingRequest: (record: WorkspaceRecord, askId: string) => Effect.Effect<{ readonly kind: string } | undefined>;
  /** The ask.user the chat journaled under this id. */
  readonly askEvent: (record: WorkspaceRecord, askId: string) => Effect.Effect<AskUser | undefined>;
  /** Whether `path` is an image item of the chat's journal (an attachment, a screenshot, a tool's image), by realpath. */
  readonly journalImage: (record: WorkspaceRecord, path: string) => Effect.Effect<boolean>;
}

export interface AgentCaller {
  readonly name: string;
  /** min(the person's level for its name, its `--at-most`), read on this call. */
  readonly level: Level;
}

export interface Gated {
  /** The params the handler runs with: the agent's, with what the gate set (a lowered access, a marked answer). */
  readonly params: Record<string, unknown>;
  /** What of the answer goes back. */
  readonly result?: (value: unknown) => Effect.Effect<unknown, ProtocolError>;
}

interface Ctx {
  readonly agent: AgentCaller;
  readonly method: string;
  readonly params: Record<string, unknown>;
  /** The chat a targeted method acts on. */
  readonly record: WorkspaceRecord | undefined;
  readonly deps: GateDeps;
}

interface Rule {
  readonly level: Level;
  /** read: any chat but a Chief's or a setup chat. change: also, below Full, only a chat the agent's name started. */
  readonly target?: "read" | "change";
  readonly check?: (ctx: Ctx) => Effect.Effect<Record<string, unknown>, ProtocolError>;
  readonly result?: (ctx: Ctx, value: unknown) => Effect.Effect<unknown, ProtocolError>;
}

const ownChats = (ctx: Ctx) =>
  ctx.deps.workspaces.pipe(Effect.map((all) => all.filter((r) => r.workspace.started_by?.agent === ctx.agent.name && RUNNING_STATUSES.has(r.workspace.status))));
const runaway = (ctx: Ctx) =>
  ownChats(ctx).pipe(
    Effect.flatMap((running) =>
      running.length >= MAX_WORKING
        ? fail("rate_limited", `${ctx.agent.name} has ${running.length} chats working, the most at once (${MAX_WORKING}). Wait for one to finish (chat_wait) or stop one (chat_stop), then call again.`)
        : Effect.void,
    ),
  );

const GRILL = "Grill mode is the person's: an agent would start a round of questions only they can answer. Leave mode out.";
/** The end of a refusal the person can lift: they raise the agent's level. */
const raise = (ctx: Ctx) => `ask your user to raise ${ctx.agent.name} in ${SETTINGS}.`;
const sameDir = (a: string, b: string) => {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return real(a) === real(b);
};

/** The access an explicit request asks for, refused above the level. */
const explicitFits = (ctx: Ctx, access: AccessMode | undefined) =>
  access === undefined || fits(ctx.agent.level, access)
    ? Effect.void
    : forbidden(`Access "${access}" (${ACCESS_LABEL[access]}) is above ${ctx.agent.name}'s level (${LEVEL_LABEL[ctx.agent.level]}): its chats run at ${ACCESS_LABEL[MOST_ACCESS[ctx.agent.level] ?? "ask"]} at most. Leave access out, or ${raise(ctx)}`);
const fullOnly = (modes: ReadonlyArray<AccessMode> | undefined) => modes !== undefined && modes.length > 0 && modes.every((m) => m === "full");

/** The chat's access now: its thread's, else what the session last said; a chat with none runs Full (upstream default). */
const accessNow = (ctx: Ctx, record: WorkspaceRecord) =>
  ctx.deps.threadModes(record).pipe(Effect.map((modes) => modes?.access ?? record.session.access ?? ("full" as const)));
const personRuns = (access: AccessMode, what: string) => forbidden(`The person runs this chat at ${ACCESS_LABEL[access]}; only they can ${what}.`);
/** ask.respond and checkpoint.undo: the chat's access, unchanged by the call, must be at or below the level. */
const accessStays = (what: string) => (ctx: Ctx) =>
  accessNow(ctx, ctx.record!).pipe(Effect.flatMap((access) => (fits(ctx.agent.level, access) ? Effect.succeed(ctx.params) : personRuns(access, what))));

const create = (ctx: Ctx) =>
  Effect.gen(function* () {
    const p = ctx.params as Params<"workspace.create">;
    const below = ctx.agent.level !== "full";
    if (p.options?.mode === "grill") return yield* forbidden(GRILL);
    if (below) {
      if (!("path" in p.repo)) return yield* forbidden(`Below Full access, ${ctx.agent.name} starts chats only in the person's projects (projects), never from a URL.`);
      for (const key of ["pull_request", "branch", "base_ref"] as const) {
        if (p[key] !== undefined) return yield* forbidden(`Below Full access, ${ctx.agent.name} can't set ${key}: its chats start from the project's own branch. Leave it out, or ${raise(ctx)}`);
      }
      if (p.computer_id !== undefined && p.computer_id !== THIS_MAC.id) return yield* forbidden(`${ctx.agent.name} starts chats on This Mac only.`);
      if (p.options?.account_id !== undefined) return yield* forbidden("Which login runs a chat is the person's to pick: leave account_id out.");
      const repoPath = p.repo.path;
      if (!(yield* ctx.deps.projectPaths).some((known) => sameDir(known, repoPath))) {
        return yield* forbidden(`${repoPath} is not one of the person's projects (projects). Below Full access, ${ctx.agent.name} starts chats only in those.`);
      }
    }
    yield* runaway(ctx);
    const engine = p.engine ?? (yield* ctx.deps.defaultEngine);
    yield* explicitFits(ctx, p.options?.access);
    // An engine that can't ask before acting runs every chat at Full access (accessFor), whatever was asked.
    if (!fits(ctx.agent.level, "full") && fullOnly(yield* ctx.deps.accessModes(engine))) {
      return yield* forbidden(`${engine} runs every chat at Full access (it can't ask before acting), above ${ctx.agent.name}'s level (${LEVEL_LABEL[ctx.agent.level]}). Pick an engine that asks first (engines), or ${raise(ctx)}`);
    }
    // Left out: the lower of the project's (or the person's) default and the agent's level.
    const most = MOST_ACCESS[ctx.agent.level]!;
    if (p.options?.access === undefined && most !== "full") {
      const fallback = "path" in p.repo ? yield* ctx.deps.defaultAccess(engine, p.repo.path) : "full";
      if (!fits(ctx.agent.level, fallback)) return { ...ctx.params, options: { ...p.options, access: most } };
    }
    return ctx.params;
  });

/** The person waits on it: an approval, a secret, a custom tool's call, a grill round. Never a plain question. */
const personOnly = (ask: { readonly item_id: string; readonly kind: string }) => ask.kind !== "question" || isGrillAsk(ask.item_id) || isToolAsk(ask.item_id);

const submit = (ctx: Ctx) =>
  Effect.gen(function* () {
    const p = ctx.params as Params<"turn.submit">;
    const record = ctx.record!;
    if (p.options?.mode === "grill") return yield* forbidden(GRILL);
    if (ctx.agent.level !== "full" && p.options?.account_id !== undefined) return yield* forbidden("Which login runs a chat is the person's to pick: leave account_id out.");
    const open = record.internal.openAsks ?? [];
    if (open.some((a) => isGrillAsk(a.item_id))) return yield* forbidden(`A grill round waits for the person in "${record.workspace.title}": only they answer it. Tell your user, then chat_wait.`);
    const modes = yield* ctx.deps.threadModes(record);
    if (modes?.grill) return yield* forbidden(`The person is grilling in "${record.workspace.title}" (grill mode): only they write there until it ends.`);
    yield* explicitFits(ctx, p.options?.access);
    // The access the chat runs at after this message: an engine without approvals runs Full; an engine switch with no
    // stored access resolves Full; else what was asked, else what the chat runs at now (the person may have raised it).
    const engine = p.options?.engine ?? record.workspace.engine;
    const switching = p.options?.engine !== undefined && p.options.engine !== record.workspace.engine;
    const stored = modes?.access ?? record.session.access;
    const after: AccessMode = fullOnly(yield* ctx.deps.accessModes(engine)) ? "full" : (p.options?.access ?? (switching && stored === undefined ? "full" : (stored ?? "full")));
    if (!fits(ctx.agent.level, after)) {
      return yield* switching && p.options?.access === undefined
        ? forbidden(`${engine} would run this chat at ${ACCESS_LABEL[after]}, above ${ctx.agent.name}'s level (${LEVEL_LABEL[ctx.agent.level]}). Keep its engine, or ${raise(ctx)}`)
        : personRuns(after, "message it");
    }
    // A turn that would start: one more of its own chats working.
    if (record.workspace.started_by?.agent === ctx.agent.name && !RUNNING_STATUSES.has(record.workspace.status)) yield* runaway(ctx);
    // A steer while the chat waits on the person would cancel that wait where steering restarts the turn: it queues.
    return p.kind === "steer" && open.some(personOnly) ? { ...ctx.params, kind: "queue" } : ctx.params;
  });

const ONLY_PERSON: Record<string, string> = {
  approval: "approve this",
  secret: "store this secret",
  tool: "answer this call for their app",
  grill: "answer a grill round",
};
const onlyPerson = (ctx: Ctx, what: string) =>
  forbidden(`Only the person can ${what}. Tell your user: "${ctx.record!.workspace.title}" waits for you in Caveman Code. Then chat_wait.`);

const respond = (ctx: Ctx) =>
  Effect.gen(function* () {
    const p = ctx.params as Params<"ask.respond">;
    const record = ctx.record!;
    if (isGrillAsk(p.ask_id)) return yield* onlyPerson(ctx, ONLY_PERSON.grill!);
    if (isToolAsk(p.ask_id)) return yield* onlyPerson(ctx, ONLY_PERSON.tool!);
    // Decided from what the runtime holds, never from the response's kind: the engine's pending request, by kind.
    const request = yield* ctx.deps.pendingRequest(record, p.ask_id);
    const ask = yield* ctx.deps.askEvent(record, p.ask_id);
    if (request === undefined) {
      const open = (record.internal.openAsks ?? []).find((a) => a.item_id === p.ask_id);
      return yield* open !== undefined ? onlyPerson(ctx, ONLY_PERSON[open.kind] ?? "answer this") : fail("invalid_state", `${p.ask_id} was already answered, or is no question of this chat.`);
    }
    if (request.kind !== "user_input") return yield* onlyPerson(ctx, ONLY_PERSON.approval!);
    if (ask?.kind === "question" && ask.round !== undefined) return yield* onlyPerson(ctx, ONLY_PERSON.grill!);
    if (p.response.kind !== "question") return yield* fail("invalid_params", "A question card takes a question response: answers, each with option ids or text.");
    yield* accessStays("answer it")(ctx);
    // Marked as the Chief marks its own, where the card takes words: the engine reads who answered. An agent the person
    // connected answers for them, so the mark says so; "not the person" alone made Claude Agent ask again (seen live).
    const questions = ask?.kind === "question" ? ask.questions : [];
    const answers = p.response.answers.map((a) => {
      const q = questions.find((q) => q.id === a.question_id);
      if (q === undefined || !q.allow_text) return a;
      const labels = a.option_ids.map((id) => q.options.find((o) => o.id === id)?.label ?? id);
      const words = a.text?.trim() ? [a.text.trim()] : [];
      return { ...a, text: `${[...labels, ...words].join(": ")} (answered for the person by ${ctx.agent.name}, an outside agent they connected)` };
    });
    return { ...ctx.params, response: { kind: "question", answers } };
  });

/** Drops what an agent never sees from a list of chats: a Chief's, a setup chat, and chats under either. */
const visible = <T>(ctx: Ctx, items: ReadonlyArray<T>, workspaceOf: (item: T) => Workspace) =>
  ctx.deps.workspaces.pipe(
    Effect.map((all) => {
      const byId = new Map<string, Lineage>(all.map((r) => [r.workspace.id, r.workspace] as const));
      for (const item of items) byId.set(workspaceOf(item).id, workspaceOf(item));
      return items.filter((item) => !hidden(lineageOf(workspaceOf(item), (id) => byId.get(id))));
    }),
  );

const SEARCH_LIMIT = 20;

/** Every method an outside agent may call, and how. Anything else: "Outside agents can't call <method>." */
export const GATE: Readonly<Record<string, Rule>> = {
  // The client's first call on every connection (session-protocol client.ts): which build answers, nothing of the person's.
  "runtime.hello": { level: "read" },
  "workspace.list": {
    level: "read",
    check: (ctx) => Effect.succeed({ ...ctx.params, include_chief: false }),
    result: (ctx, value) => {
      const v = value as { workspaces: ReadonlyArray<Workspace> };
      return visible(ctx, v.workspaces, (w) => w).pipe(Effect.map((workspaces) => ({ ...v, workspaces })));
    },
  },
  "chat.search": {
    level: "read",
    // A few more than asked, so the ones dropped below leave the page full.
    check: (ctx) => Effect.succeed({ ...ctx.params, limit: Math.min(50, ((ctx.params.limit as number | undefined) ?? SEARCH_LIMIT) + 10) }),
    result: (ctx, value) => {
      const v = value as { chats: ReadonlyArray<{ workspace: Workspace }> };
      const limit = (ctx.params.limit as number | undefined) ?? SEARCH_LIMIT;
      return visible(ctx, v.chats, (hit) => hit.workspace).pipe(Effect.map((chats) => ({ ...v, chats: chats.slice(0, Math.max(1, Math.min(limit, 50))) })));
    },
  },
  "project.list": { level: "read" },
  // Only which engine and access a new chat starts on, so an agent's chat_start that names no engine runs where the
  // person's would: the rest of Settings is the person's.
  "settings.get": {
    level: "read",
    result: (_ctx, value) => {
      const settings = value as { readonly default_engine?: string; readonly default_access?: AccessMode };
      return Effect.succeed({
        ...(settings.default_engine !== undefined ? { default_engine: settings.default_engine } : {}),
        ...(settings.default_access !== undefined ? { default_access: settings.default_access } : {}),
      });
    },
  },
  "engine.list": { level: "read", result: (_ctx, value) => Effect.succeed(enginesForAgents(value as { engines: ReadonlyArray<EngineDescriptor> })) },
  "workspace.get": { level: "read", target: "read" },
  "workspace.digest": { level: "read", target: "read" },
  "fs.diff": { level: "read", target: "read" },
  "queue.list": { level: "read", target: "read" },
  "media.read": {
    level: "read",
    target: "read",
    check: (ctx) =>
      ctx.deps.journalImage(ctx.record!, String(ctx.params.path)).pipe(
        Effect.flatMap((named) =>
          named
            ? Effect.succeed(ctx.params)
            : forbidden(`Outside agents read only the images a chat holds (its attachments, screenshots and tools' images): ${String(ctx.params.path)} is none of "${ctx.record!.workspace.title}"'s.`),
        ),
      ),
    result: (_ctx, value) =>
      (value as { mime_type: string }).mime_type.startsWith("image/") ? Effect.succeed(value) : fail("invalid_params", "Outside agents read only images through media.read."),
  },
  "workspace.create": { level: "supervised", check: create },
  "turn.submit": { level: "supervised", target: "change", check: submit },
  "turn.interrupt": { level: "supervised", target: "change" },
  "ask.respond": { level: "supervised", target: "change", check: respond },
  "checkpoint.undo": { level: "supervised", target: "change", check: accessStays("undo its changes") },
  "workspace.rename": { level: "supervised", target: "change" },
  "workspace.archive": { level: "supervised", target: "change" },
  "workspace.inbox": {
    level: "supervised",
    target: "change",
    check: (ctx) =>
      (ctx.params.action as { do?: string } | undefined)?.do === "done"
        ? Effect.succeed(ctx.params)
        : forbidden("Outside agents only mark a chat done in the person's inbox (action done); the rest of the inbox is theirs."),
  },
  "git.commit": { level: "full", target: "change" },
  "git.push": { level: "full", target: "change" },
  "git.pr": { level: "full", target: "change" },
  "project.create": { level: "full" },
};

/** The chat a targeted call names: by workspace_id, else by session_id. */
const targetOf = (params: Record<string, unknown>, deps: GateDeps) =>
  typeof params.workspace_id === "string"
    ? deps.workspace(params.workspace_id).pipe(Effect.map((record) => ({ record, named: `workspace ${params.workspace_id}` })))
    : typeof params.session_id === "string"
      ? deps.session(params.session_id).pipe(Effect.map((record) => ({ record, named: `session ${params.session_id}` })))
      : Effect.succeed({ record: undefined, named: "no chat" });

/**
 * THE GATE: whether `agent` may call `method` with `params`, the params its handler then runs with, and the filter
 * its answer goes through. Every refusal is a ProtocolError that says what to do instead.
 */
export const gate = (agent: AgentCaller, method: string, params: Record<string, unknown>, deps: GateDeps): Effect.Effect<Gated, ProtocolError> =>
  Effect.gen(function* () {
    const rule = Object.hasOwn(GATE, method) ? GATE[method] : undefined;
    if (rule === undefined) return yield* forbidden(`Outside agents can't call ${method}.`);
    if (LEVEL_RANK[agent.level] < LEVEL_RANK[rule.level]) {
      return yield* forbidden(`${method} needs the ${LEVEL_LABEL[rule.level]} level; ${agent.name} is ${LEVEL_LABEL[agent.level]}. Ask your user to raise it in ${SETTINGS}.`);
    }
    let record: WorkspaceRecord | undefined;
    if (rule.target !== undefined) {
      const target = yield* targetOf(params, deps);
      if (target.record === undefined) return yield* fail("not_found", `no ${target.named}`);
      record = target.record;
      const chain = yield* lineageIn(record.workspace, (id) => deps.workspace(id).pipe(Effect.map((r) => r?.workspace)));
      if (hidden(chain)) return yield* forbidden("Outside agents can't reach a Chief's chat or a setup chat.");
      if (rule.target === "change" && agent.level !== "full" && !owns(chain, agent.name)) {
        return yield* forbidden(
          `"${record.workspace.title}" is the person's chat: ${agent.name} (${LEVEL_LABEL[agent.level]}) changes only the chats it started. Start your own (chat_start), or ask your user to raise ${agent.name} to Full access in ${SETTINGS}.`,
        );
      }
    }
    const ctx: Ctx = { agent, method, params, record, deps };
    const checked = rule.check ? yield* rule.check(ctx) : params;
    const result = rule.result;
    return { params: checked, ...(result ? { result: (value: unknown) => result({ ...ctx, params }, value) } : {}) };
  });
