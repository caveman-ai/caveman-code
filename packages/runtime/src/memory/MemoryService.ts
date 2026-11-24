/**
 * Memory in the runtime (docs/memory.md): one
 * store per account, a copy per session in the form each engine was trained
 * on, one commit path, and the Session Protocol's memory.* methods.
 *
 * No dreaming: nothing rewrites notes after a
 * session. A note reaches the brief when the user said it (told, with their
 * quote verified), when it is a team note, or when the user pinned it; what an
 * agent saves on its own stays a draft.
 *
 * - Claude Agent: its own auto-memory pointed at the session's copy
 *   (`autoMemoryDirectory`, its own `autoDreamEnabled` off), writes ingested from its
 *   PostToolUse hook, subagent writes refused in PreToolUse.
 * - Codex: the copy as a writable root and the brief after its instructions;
 *   writes ingested from its fileChange items.
 * - The Caveman engine: the brief through EngineInstructions; its file tools
 *   reach the copy, and each write is ingested as it lands.
 * - Every engine: the turn-end sweep commits anything else in the copy as
 *   quarantined drafts. Subagent sessions get a read-only pointer.
 * - Pushes (memory/MemoryPush.ts): notes reach the agent when they matter,
 *   matched without a model. Claude Agent: PostToolUse (reads, edits, shell
 *   reads), PostToolUseFailure (a failed command) and SessionStart after a
 *   compaction, beside its own per-turn recall. Codex: steered into its turn
 *   from its command and file-change items, put back into its history after a
 *   compaction, and its message's notes in front of each turn. The Caveman
 *   engine: on its tool results (RuntimeHooks), and in front of each turn.
 *
 * Thread memory is no new store: agents search past threads with
 * thread_search and the user @-references them.
 *
 * @module memory/MemoryService
 */
import { resolveCavemanMcpToolId } from "@caveman-app/shared/cavemanMcpToolPresentation";
import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { MEMORY_ROOT, type MemoryPushEvent } from "@caveman-app/engine-core/server/SessionPlugins";
import type { SessionEvent } from "@caveman-app/session-protocol";
import { repositoryKey } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { type Identity, loadIdentity, pinAllows } from "../cloudLink/identity.ts";
import * as ServerConfig from "../config.ts";
import { type InstructionEngine, repositorySections } from "../instructions/EngineInstructions.ts";
import { claudeToolName } from "../plugins/hooks.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { SessionStore, typedMessages, type WorkspaceRecord } from "../session-protocol/store.ts";
import { importClaudeMemories } from "./MemoryInterchange.ts";
import { BRIEF_MAX_TOKENS, type CopyEvent, type CopySession, ingest, noteName, render, startSession, SUBAGENT_POINTER, turnEndSweep, type RenderContext } from "./MemoryCopy.ts";
import { changedSince, compactNotes, keepAsk, outputTail, PushIndex, PushLedger, type PushTrigger, readsOf, renderChangedFiles, renderKeep, renderPush, repoRelative } from "./MemoryPush.ts";
import { MemorySandbox, sandboxSupported } from "./MemorySandbox.ts";
import { alive, MemoryStore, metaOf, type NoteRow, type Operation, type WriterContext } from "./MemoryStore.ts";

export interface MemorySettings {
  readonly enabled: boolean;
}
/** on unless the user turns it off. */
export const DEFAULT_MEMORY_SETTINGS: MemorySettings = { enabled: true };

type Engine = "claude" | "codex" | "caveman" | "other";
const ENGINE: Record<string, Engine> = { "claude-agent": "claude", codex: "codex", caveman: "caveman" };

/** A note as the Memory panel shows it. */
export interface MemoryNote {
  readonly id: string;
  readonly scope: "me" | "project";
  readonly repo: string | null;
  readonly path: string;
  readonly name: string;
  readonly text: string;
  readonly authority: NoteRow["authority"];
  readonly tainted: boolean;
  readonly pinned: boolean;
  readonly suspect: string | null;
  readonly added: string;
  readonly updated_at: string;
  readonly by: string;
  /** The thread it was learned in, when one wrote it. */
  readonly thread: { readonly workspace_id: string; readonly title: string } | null;
  readonly vid: string;
  /** How often it reached a session (memory_use) and when last; null when never. */
  readonly uses: { readonly count: number; readonly last_at: string } | null;
  /** Why we know it: the writer's claim and what the note carries about its origin. */
  readonly provenance: {
    readonly source: string;
    readonly quote?: string;
    readonly cites?: ReadonlyArray<string>;
    readonly url?: string;
    readonly why?: string;
    readonly how?: string;
  };
}

export interface ThreadMemory {
  readonly threadId: string;
  readonly engine: Engine;
  readonly subagent: boolean;
  readonly copyDir: string;
  readonly brief: string;
  readonly copy: CopySession | undefined;
}

export class Memory extends Context.Service<
  Memory,
  {
    readonly settings: Effect.Effect<MemorySettings>;
    /** The thread's memory, set up at its first engine session; undefined when memory is off or it has no workspace. */
    readonly thread: (threadId: string) => Effect.Effect<ThreadMemory | undefined>;
    /** The brief (or a subagent's pointer) for engines that take it as text; "" for Claude Agent, which loads its copy natively. */
    readonly brief: (threadId: string, engine: InstructionEngine) => Effect.Effect<string>;
    /** Claude Agent's auto-memory settings and hooks for the thread. */
    readonly claude: (threadId: string) => Effect.Effect<{ readonly settings: Record<string, unknown>; readonly hooks: Record<string, ReadonlyArray<unknown>> }>;
    /** Codex: the copy as a writable root, and its file changes ingested. */
    readonly codex: (threadId: string) => Effect.Effect<CodexMemory | undefined>;
    /**
     * The Caveman engine: the copy its file tools may reach, and each write ingested (no onWrite for a
     * subagent, which only reads it); postToolUse gives notes for a tool's result (RuntimeHooks).
     */
    readonly caveman: (threadId: string) => Effect.Effect<
      | {
          readonly dir: string;
          readonly onWrite?: (event: AbsoluteCopyEvent) => string | undefined;
          readonly postToolUse: (tool: string, input: unknown, output: unknown) => Promise<string | undefined>;
        }
      | undefined
    >;
    /** Notes the person's message names, and where to save what it asks to keep, for engines without their own per-turn recall (Codex, the Caveman engine). */
    readonly prompt: (threadId: string, text: string) => Effect.Effect<string | undefined>;
    /** A write an engine made under the thread's copy, by absolute path: why it was not saved, when it wasn't. */
    readonly ingest: (threadId: string, event: AbsoluteCopyEvent) => Effect.Effect<string | undefined>;
    readonly turnEnd: (threadId: string) => Effect.Effect<void>;
    readonly taint: (threadId: string) => Effect.Effect<void>;
    /** Another workspace's agent wrote to this one (mail, a task it started it with): a tainted sender taints the receiver. */
    readonly carryTaint: (fromThreadId: string, toThreadId: string) => Effect.Effect<void>;
    /** Codex's refused memory writes since its last turn, as one line for the front of its next (it has no reply channel); taken once. */
    readonly notice: (threadId: string) => Effect.Effect<string | undefined>;
    /** Whether the thread read outside content (its own taint, kept in the store). */
    readonly tainted: (threadId: string) => Effect.Effect<boolean>;
    /** memory_sql for a thread (read-only outside code mode). */
    readonly query: (threadId: string, sql: string, params: ReadonlyArray<unknown>) => Effect.Effect<string, Error>;
    /** The Chief saves what the person told it: a told note in user/ or one repository, only with their exact words as its quote. */
    readonly remember: (
      threadId: string,
      input: { readonly text: string; readonly quote: string; readonly repoPath?: string; readonly typedAfter?: number },
    ) => Effect.Effect<{ readonly id: string; readonly vid: string }, Error>;
    /** Follows session events: taint and turn-end sweeps. Fork it once. */
    readonly run: Effect.Effect<void>;
    readonly api: MemoryApi;
  }
>()("caveman/memory/Memory") {}

export interface AbsoluteCopyEvent extends Omit<CopyEvent, "file"> {
  readonly path: string;
}
export interface CodexMemory {
  /** The copy Codex may write; none for a subagent, which only reads it. */
  readonly writableRoot?: string;
  readonly onFileChange: (changes: ReadonlyArray<{ readonly path: string; readonly kind: string; readonly diff: string }>) => void | Promise<void>;
  /** Notes for what Codex just did (memory/MemoryPush.ts): text to steer into its turn, or undefined. */
  readonly push: (event: MemoryPushEvent) => Promise<string | undefined>;
}

/** What the Session Protocol's memory.* methods do (handlers map them onto the wire). */
export interface MemoryApi {
  readonly status: Effect.Effect<{
    readonly enabled: boolean;
    readonly notes: number;
    readonly drafts: number;
    readonly unverified: number;
    readonly brief_tokens: number;
    readonly sql: boolean;
    readonly claude_import: { readonly available: number; readonly imported: boolean };
  }>;
  readonly list: (input: { readonly query?: string; readonly project_id?: string; readonly repo_path?: string }) => Effect.Effect<ReadonlyArray<MemoryNote>>;
  readonly history: (id: string) => Effect.Effect<ReadonlyArray<MemoryNote>>;
  readonly put: (input: { readonly id?: string; readonly text: string; readonly scope: "me" | "project"; readonly repo_path?: string; readonly name?: string }) => Effect.Effect<MemoryNote, Error>;
  readonly forget: (id: string) => Effect.Effect<void, Error>;
  readonly undo: (id: string) => Effect.Effect<MemoryNote | null, Error>;
  readonly pin: (id: string, pinned: boolean) => Effect.Effect<MemoryNote, Error>;
  readonly keep: (id: string) => Effect.Effect<MemoryNote, Error>;
  readonly erase: (id: string) => Effect.Effect<void, Error>;
  /** The one-time import of Claude Agent's own memories: every note comes in as a draft. */
  readonly importClaude: Effect.Effect<{ readonly imported: number; readonly skipped: number }, Error>;
}

/**
 * How each engine names the runtime's own server's tools: Claude Agent `mcp__caveman-code__<tool>`, Codex
 * `caveman-code.<tool>`, the Caveman engine `mcp__caveman_code__<tool>` (non-word characters as `_`); any other engine,
 * any of them. Plugins and personal servers can't take those names (plugins/load.ts reservedServerName). A
 * runtime toolkit an engine reaches by name (the Chief's) joins here.
 */
// Legacy prefixes remain readable for stored tool events.
const RUNTIME_TOOL_PREFIXES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "claude-agent": ["mcp__caveman-code__", "mcp__t3-code__"],
  codex: ["caveman-code.", "t3-code."],
  caveman: ["mcp__caveman_code__", "mcp__t3_code__"],
};
const ANY_RUNTIME_TOOL_PREFIX = Object.values(RUNTIME_TOOL_PREFIXES).flat();
/** The runtime's own tool a call names, as `engine` names it; undefined for every other tool. */
export const runtimeTool = (name: string, engine?: string): string | undefined => {
  const prefix = ((engine === undefined ? undefined : RUNTIME_TOOL_PREFIXES[engine]) ?? ANY_RUNTIME_TOOL_PREFIX).find((p) => name.startsWith(p));
  return prefix === undefined ? undefined : (resolveCavemanMcpToolId(name) ?? name.slice(prefix.length));
};
/** The runtime server's tools that bring outside content: its browser (preview_*) and pull-request reads. */
const RUNTIME_OUTSIDE = /^(?:preview_|list_thread_pull_requests$|read_pull_request_guide$)/;
/** The runtime's tools that bring another thread's text in, naming it as `threadId`: that thread's taint comes along. */
export const THREAD_READS: ReadonlySet<string> = new Set([
  "thread_read",
  "queue",
  "pending_request",
  // The names before queue and pending_request took actions, for sessions recorded then.
  "queue_read",
  "pending_request_read",
]);
/** thread_search quotes other threads too: its result names them. */
const THREAD_SEARCH = "thread_search";
/** The thread ids a tool result names (JSON, or JSON inside a text block). */
const threadIdsIn = (result: unknown) => [...(JSON.stringify(result ?? null) ?? "").matchAll(/\\*"threadId\\*"\s*:\s*\\*"([^"\\]+)/g)].map((m) => m[1]!);
/**
 * Does a tool call bring outside content into the session (docs/memory.md "What
 * taints a session")? Web and browser tools; every MCP server's tools, named
 * `mcp__<server>__<tool>` (Claude Agent, the Caveman engine) or
 * `<server>.<tool>` (Codex), but the runtime's own (RUNTIME_TOOL_PREFIXES).
 */
export const taints = (tool: { readonly kind: string; readonly name: string }, engine?: string): boolean => {
  if (tool.kind === "web" || tool.kind === "browser") return true;
  const own = runtimeTool(tool.name, engine);
  if (own !== undefined) return RUNTIME_OUTSIDE.test(own);
  return tool.kind === "mcp" || /^[\w-]+\.[\w.-]+$/.test(tool.name);
};
/** A session's log shows it read outside content. */
export const taintedBy = (events: ReadonlyArray<SessionEvent>, engine?: string): boolean => events.some((e) => e.type === "tool.started" && taints(e.payload, engine));
/** Where a log's text from other threads came from: peer messages (by workspace), thread reads and searches (by thread). */
export const heardFrom = (events: ReadonlyArray<SessionEvent>, engine?: string) => {
  const workspaces = new Set<string>();
  const threads = new Set<string>();
  const searches = new Set<string>();
  // A message from a thread outside every workspace: nothing here can vouch for what it read.
  let unknown = false;
  for (const e of events) {
    if (e.type === "message.done" && e.payload.role === "user" && e.payload.from !== undefined) {
      if (e.payload.from.workspace_id === undefined) unknown = true;
      else workspaces.add(e.payload.from.workspace_id);
    } else if (e.type === "tool.started") {
      const own = runtimeTool(e.payload.name, engine);
      const target = (e.payload.input as { readonly threadId?: unknown } | null | undefined)?.threadId;
      if (own !== undefined && THREAD_READS.has(own) && typeof target === "string") threads.add(target);
      if (own === THREAD_SEARCH && e.item_id) searches.add(e.item_id);
    } else if (e.type === "tool.done" && e.item_id && searches.has(e.item_id)) {
      for (const id of threadIdsIn(e.payload.result)) threads.add(id);
    }
  }
  return { workspaces, threads, unknown };
};

const gitOut = (cwd: string, args: ReadonlyArray<string>) =>
  new Promise<string | undefined>((resolve) =>
    execFile("git", ["-C", cwd, ...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => resolve(error ? undefined : stdout.trim() || undefined)),
  );

/** A repository's memory id: its origin (`github.com/owner/name`), else `local/<root commit>`, so a moved folder keeps its notes. */
export const repoIdOf = async (repoPath: string): Promise<string> => {
  const remote = await gitOut(repoPath, ["config", "--get", "remote.origin.url"]);
  const key = remote ? repositoryKey(remote) : undefined;
  if (key) return key.toLowerCase().replace(/[^a-z0-9._/-]/g, "-");
  const root = (await gitOut(repoPath, ["rev-list", "--max-parents=0", "HEAD"]))?.split("\n")[0];
  return `local/${root ?? createHash("sha256").update(fs.realpathSync(repoPath)).digest("hex").slice(0, 16)}`;
};

/**
 * A thread's session copy: `<copiesDir>/<threadId>/memory`. Windows refuses `:` in a folder name (every
 * `caveman:<id>` has one) and the other reserved characters, so they go as `%XX` there; elsewhere the id is the name.
 */
export const memoryCopyDir = (copiesDir: string, threadId: string, platform: NodeJS.Platform = process.platform) =>
  path.join(
    copiesDir,
    platform === "win32" ? threadId.replace(/[%<>:"/\\|?*\x00-\x1f]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`) : threadId,
    "memory",
  );

export interface MakeOptions {
  readonly stateDir: string;
  /** Where session copies live: outside every worktree and the state directory. */
  readonly copiesDir: string;
  /** Tests pass a fixed key; the runtime keeps it in its secret store (else a 0600 file), never the OS keychain. */
  readonly keyFor?: (account: string) => Effect.Effect<Uint8Array>;
  readonly claudeHome?: string;
}

export const make = (options: MakeOptions) =>
  Effect.gen(function* () {
    const sessions = yield* SessionStore;
    const secretStore = yield* Effect.serviceOption(ServerSecretStore);
    const projectSecrets = yield* Effect.serviceOption(ProjectSecrets);
    const runSync = Effect.runSyncWith(yield* Effect.context<never>());
    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());

    // ------------------------------------------------------------ account store

    const linkDir = path.join(options.stateDir, "cloud-link");
    /**
     * The signed-in account, else "local", as readIdentity tells them apart; but a read that failed (EMFILE, EACCES,
     * EIO), which readIdentity answers as signed out too, throws: it says nothing about who is signed in.
     */
    const accountOf = () => {
      let identity: Identity;
      try {
        identity = loadIdentity(linkDir);
      } catch (error) {
        const { syscall, code } = error as NodeJS.ErrnoException;
        if (syscall !== undefined && code !== "ENOENT") throw error;
        return "local";
      }
      return pinAllows(identity.cloudUrl) ? `${identity.organizationId}.${identity.userId ?? identity.runtimeId}` : "local";
    };
    const keyOf = (account: string, dbFile: string) =>
      options.keyFor
        ? options.keyFor(account)
        : Effect.gen(function* () {
            const name = `memory-key-${account}`;
            if (Option.isSome(secretStore)) {
              // A read that failed is no missing key: setting the notes aside under a new one would orphan them all. Memory
              // stays off until the store answers (each use retries).
              const stored = yield* secretStore.value.get(name).pipe(Effect.orDie);
              if (Option.isSome(stored)) return stored.value;
            }
            const file = path.join(options.stateDir, "memory", `${account}.key`);
            if (fs.existsSync(file)) return fs.readFileSync(file);
            // Notes without a key here: an older runtime kept it in the OS keychain, which is never read. They are set
            // aside, not deleted, and memory starts over.
            if (fs.existsSync(dbFile)) {
              const aside = `${dbFile}.keychain-${Date.now()}`;
              for (const suffix of ["", "-wal", "-shm"]) if (fs.existsSync(dbFile + suffix)) fs.renameSync(dbFile + suffix, aside + suffix);
              yield* Effect.logWarning("Memory an older runtime keyed in the OS keychain was set aside; memory starts over", { aside });
            }
            const key = randomBytes(32);
            if (Option.isSome(secretStore)) {
              // A key it did not keep would be gone at the next start, and every note sealed with it set aside.
              yield* secretStore.value.set(name, key).pipe(Effect.orDie);
              return key;
            }
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.writeFileSync(file, key, { mode: 0o600 });
            return key;
          });
    /** The account's store, and the memory_sql sandbox whose copies are of it: both go when the account changes. */
    let opened: { account: string; store: MemoryStore; sandbox: MemorySandbox } | undefined;
    const storeNow = Effect.gen(function* () {
      let account: string;
      try {
        account = accountOf();
      } catch (error) {
        // An unreadable sign-in is no sign-out: memory stays in the account it is in, and opens none until it can tell.
        if (opened === undefined) return yield* Effect.die(error);
        yield* Effect.logWarning("memory: the sign-in could not be read; memory stays in its account", error);
        return opened.store;
      }
      if (opened?.account === account) return opened.store;
      const file = path.join(options.stateDir, "memory", `${account.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`);
      const key = yield* keyOf(account, file);
      if (opened !== undefined) {
        opened.store.close();
        void opened.sandbox.close();
      }
      const store = new MemoryStore(file, key);
      opened = { account, store, sandbox: new MemorySandbox(() => store) };
      return store;
    });

    // A `memory_dreams` key an older runtime stored is ignored: dreams are retired.
    const settings = sessions.kvGet("settings").pipe(
      Effect.map((raw): MemorySettings => ({ enabled: (raw === undefined ? {} : (JSON.parse(raw) as { memory_enabled?: unknown })).memory_enabled !== false })),
    );

    // ------------------------------------------------------------ repositories

    const repoIds = new Map<string, Promise<string>>();
    const repoId = (repoPath: string) => {
      let found = repoIds.get(repoPath);
      if (!found) repoIds.set(repoPath, (found = repoIdOf(repoPath)));
      return Effect.promise(() => found!);
    };
    const knownRepos = sessions.listWorkspaces().pipe(
      Effect.flatMap((records) => Effect.forEach([...new Set(records.flatMap((r) => (r.internal.repoPath ? [r.internal.repoPath] : [])))], repoId)),
    );
    // The egress scrub's (EgressScrub.layer re-provides ProjectSecrets): plugin credentials and the runtime's tokens too.
    const scrubber = Option.isSome(projectSecrets) ? projectSecrets.value.scrubber.pipe(Effect.orElseSucceed(() => undefined)) : Effect.succeed(undefined);

    // ------------------------------------------------------------ threads

    /** Each thread's memory, with the store its copy and brief came from. */
    const threads = new Map<string, ThreadMemory & { ctx: RenderContext; record: WorkspaceRecord; store: MemoryStore }>();
    const recordOf = (threadId: string) => sessions.getByThread(threadId);
    /** The chat a subagent works for (itself when it is one). */
    const rootOf = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        let root = record;
        for (let hops = 0; root.workspace.parent_workspace_id !== undefined && hops < 8; hops++) {
          const parent = yield* sessions.getWorkspace(root.workspace.parent_workspace_id);
          if (!parent) break;
          root = parent;
        }
        return root;
      });
    // Taint is kept in the store, so it outlives a restart; a session's log taints it too (sessions from before).
    const tainted = (threadId: string) => storeNow.pipe(Effect.map((store) => store.sessionTainted(`session:${threadId}`)));
    /** A tainted subagent taints the chat it reports to. */
    const taintRecord = (record: WorkspaceRecord) =>
      Effect.gen(function* () {
        const store = yield* storeNow;
        store.taintSession(`session:${record.internal.threadId}`);
        const root = yield* rootOf(record);
        if (root !== record) store.taintSession(`session:${root.internal.threadId}`);
      });
    /**
     * A session read outside content: kept in the store, else in its log (a session from before, an empty store),
     * through every thread it heard from. `seen` ends a cycle.
     */
    const readOutside = (record: WorkspaceRecord, seen: Set<string>): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (seen.has(record.internal.threadId)) return false;
        seen.add(record.internal.threadId);
        if ((yield* storeNow).sessionTainted(`session:${record.internal.threadId}`)) return true;
        return yield* logTainted(yield* sessions.readEvents(record.session.id, 0, record.session.head), record.workspace.engine, seen);
      });
    /** A log shows outside content: a tool that taints, or text from a thread that read some, or from one no workspace vouches for. */
    const logTainted = (events: ReadonlyArray<SessionEvent>, engine: string, seen = new Set<string>()): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (taintedBy(events, engine)) return true;
        const heard = heardFrom(events, engine);
        if (heard.unknown) return true;
        for (const id of heard.workspaces) {
          const sender = yield* sessions.getWorkspace(id);
          if (!sender || (yield* readOutside(sender, seen))) return true;
        }
        for (const id of heard.threads) {
          const source = yield* sessions.getByThread(id);
          if (!source || (yield* readOutside(source, seen))) return true;
        }
        return false;
      });
    /** The person's words in a session: what they typed, and their quotes another session attached to it (verified when stored). */
    const userMessages = (record: WorkspaceRecord) =>
      Effect.all([sessions.readEvents(record.session.id, 0, record.session.head), sessions.quotes(record.workspace.id)]).pipe(
        Effect.map(([events, quotes]) => [...typedMessages(events).map((m) => m.text), ...quotes.map((q) => q.quote)]),
      );

    /**
     * The Chief has no repository and no copy. Its brief is the person's own user/ notes, frozen when it
     * starts in this process; memory_sql reads everything; it writes only through remember.
     */
    const chiefThread = (threadId: string, record: WorkspaceRecord, store: MemoryStore) =>
      Effect.sync(() => {
        const lines: Array<string> = [];
        let size = 0;
        for (const row of store
          .current({ teamStores: [] })
          .filter((r) => !r.tainted && r.authority !== "draft" && r.path.startsWith("user/"))
          .sort((a, b) => b.added.localeCompare(a.added))) {
          const line = `- ${noteName(row)}: ${row.text}`;
          // ponytail: newest first up to the brief's budget (4 characters a token); older ones stay reachable through memory_sql.
          if ((size += line.length + 1) / 4 > BRIEF_MAX_TOKENS) break;
          lines.push(line);
        }
        const brief = lines.length === 0 ? "" : `<memory>\nWhat the person told you to keep (their user/ notes; memory_sql has the rest):\n${lines.join("\n")}\n</memory>`;
        const ctx = { kind: "live", session: `session:${threadId}`, repoId: "", knownRepos: [], teamStores: [], userMessages: [], brokerSecrets: [], instructionFiles: "" } satisfies RenderContext;
        const entry = { threadId, engine: "caveman" as const, subagent: false, copyDir: "", brief, copy: undefined, ctx, record, store };
        threads.set(threadId, entry);
        return entry;
      });

    /**
     * `typedAfter`: the Chief's last tainted report (ms). Only what the person typed after it may be quoted,
     * and that freshness stands in for the session's taint: a fresh quote is the person's, whatever the
     * Chief read before it (chief/tools.ts, docs/chief.md "Memory").
     */
    const remember = (threadId: string, input: { readonly text: string; readonly quote: string; readonly repoPath?: string; readonly typedAfter?: number }) =>
      Effect.gen(function* () {
        if (!(yield* settings).enabled) return yield* Effect.fail(new Error("Memory is off"));
        const record = yield* recordOf(threadId);
        if (record?.workspace.kind !== "chief") return yield* Effect.fail(new Error("Only the Chief remembers this way"));
        const store = yield* storeNow;
        if (input.typedAfter === undefined && store.sessionTainted(`session:${threadId}`)) return yield* Effect.fail(new Error("the Chief read outside content: quote only words typed since"));
        const repo = input.repoPath === undefined ? undefined : yield* repoId(input.repoPath);
        const scrub = yield* scrubber;
        const text = scrub ? scrub.scrub(input.text) : input.text;
        const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "note";
        // Its scope is user/ and every repository here; a project just added, with no chat yet, counts too.
        const ctx: WriterContext = {
          kind: "chief",
          session: `session:${threadId}`,
          knownRepos: [...(yield* knownRepos), ...(repo ? [repo] : [])],
          teamStores: [],
          userMessages:
            input.typedAfter === undefined
              ? yield* userMessages(record)
              : typedMessages((yield* sessions.readEvents(record.session.id, 0, record.session.head)).filter((e) => Date.parse(e.at) > input.typedAfter!)).map((m) => m.text),
          brokerSecrets: [],
          scrubber: scrub,
          tainted: false,
        };
        const result = store.commit(ctx, [{ path: repo ? `repos/${repo}/${slug}.md` : `user/${slug}.md`, text, meta: { quote: input.quote } }]);
        if (result.rejected.length > 0) return yield* Effect.fail(new Error(result.rejected[0]!.reason));
        const row = result.saved[0];
        if (!row) return yield* Effect.fail(new Error("memory could not save it"));
        // The Chief's brief is built once per process (chiefThread): dropped here, so its next session reads the new note.
        threads.delete(threadId);
        return { id: row.id, vid: row.vid };
      });

    /**
     * `renew`: one set up from another account's store (the person signed in elsewhere since) is set up again from
     * this one's. Mid-turn paths take it as it is: the agent may still be writing to the copy it has.
     */
    const thread = (threadId: string, renew = true) =>
      Effect.gen(function* () {
        if (!(yield* settings).enabled) return undefined;
        const store = yield* storeNow;
        const cached = threads.get(threadId);
        if (cached !== undefined && (cached.store === store || !renew)) return cached;
        const record = yield* recordOf(threadId);
        if (record?.workspace.kind === "chief") return yield* chiefThread(threadId, record, store);
        if (!record || !record.internal.repoPath) return undefined;
        const engine = ENGINE[record.workspace.engine] ?? "other";
        const subagent = record.workspace.parent_workspace_id !== undefined || record.internal.delegated === true;
        const repo = yield* repoId(record.internal.repoPath);
        const worktree = record.internal.worktreePath ?? record.internal.repoPath;
        if (!store.sessionTainted(`session:${threadId}`) && (yield* logTainted(yield* sessions.readEvents(record.session.id, 0, record.session.head), record.workspace.engine))) yield* taintRecord(record);
        // A subagent reads its root's copy; it never gets one of its own.
        if (subagent) {
          const root = yield* rootOf(record);
          const copyDir = memoryCopyDir(options.copiesDir, root.internal.threadId);
          const entry = {
            threadId,
            engine,
            subagent,
            copyDir,
            brief: SUBAGENT_POINTER(engine === "caveman" ? MEMORY_ROOT : copyDir),
            copy: undefined,
            ctx: undefined as unknown as RenderContext,
            record,
            store,
          };
          threads.set(threadId, entry);
          return entry;
        }
        const copyDir = memoryCopyDir(options.copiesDir, threadId);
        const ctx: RenderContext = {
          kind: "live",
          session: `session:${threadId}`,
          repoId: repo,
          knownRepos: [repo],
          teamStores: [],
          userMessages: [],
          brokerSecrets: [],
          instructionFiles: repositorySections(worktree)
            .map((s) => s.text)
            .join("\n"),
          fileExists: (relative) => fs.existsSync(path.join(worktree, relative)),
          // The Caveman engine maps MEMORY_ROOT to the copy, so its chats on a repo share the brief's bytes; the others need the real path.
          copyLabel: engine === "caveman" ? MEMORY_ROOT : copyDir,
          engine: engine === "claude" ? "claude" : engine === "codex" ? "codex" : "caveman",
        };
        const forkFrom = record.session.forked_from ? (yield* sessions.getBySession(record.session.forked_from.session_id))?.internal.threadId : undefined;
        const copy = startSession(store, ctx, copyDir, forkFrom === undefined ? undefined : `session:${forkFrom}`);
        const brief = store.sessionBrief(ctx.session)!.text;
        const entry = { threadId, engine, subagent, copyDir, brief, copy, ctx, record, store };
        threads.set(threadId, entry);
        return entry;
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: thread setup failed", cause).pipe(Effect.as(undefined))));

    /**
     * One quiet transcript row for a memory change or recall, at the moment it happened (docs/memory.md "In the
     * transcript"): what the person said to keep, an agent's unconfirmed draft, or the notes pushed to the agent.
     * It never fails the write or the push it reports.
     */
    const tell = (record: WorkspaceRecord, kind: "remembered" | "saved" | "recalled", rows: ReadonlyArray<NoteRow>) => {
      const notes = rows.filter((row) => row.text !== "").map((row) => ({ id: row.id, name: noteName(row) }));
      if (notes.length === 0) return Effect.void;
      const names = notes.map((n) => n.name).join(", ");
      const title =
        kind === "recalled"
          ? `Recalled ${notes.length === 1 ? "a note" : `${notes.length} notes`} · ${names}`
          : kind === "remembered"
            ? `Remembered · ${names}`
            : `Saved ${notes.length === 1 ? "a note" : `${notes.length} notes`}, unconfirmed · ${names}`;
      return sessions
        .append(record.session.id, () =>
          Effect.succeed({ events: [{ at: new Date().toISOString(), type: "notification" as const, payload: { level: "info" as const, title, memory: { kind, notes } } }], value: undefined }),
        )
        .pipe(Effect.asVoid, Effect.catchCause((cause) => Effect.logWarning("memory: transcript row not written", cause)));
    };
    /** A write's saved notes as rows: the person's words (told, team) remembered, an agent's own saved as a draft. */
    const tellSaved = (record: WorkspaceRecord, saved: ReadonlyArray<NoteRow>) =>
      Effect.all([
        tell(record, "remembered", saved.filter((r) => r.authority === "told" || r.authority === "team")),
        tell(record, "saved", saved.filter((r) => r.authority !== "told" && r.authority !== "team")),
      ]).pipe(Effect.asVoid);

    /** Commits the write's own change; returns why it was not saved, when it wasn't (the turn-end sweep then quarantines it). */
    const ingestEvent = (threadId: string, event: AbsoluteCopyEvent) =>
      Effect.gen(function* () {
        const entry = yield* thread(threadId, false);
        if (!entry?.copy) return undefined;
        const relative = path.relative(entry.copyDir, path.resolve(entry.copyDir, event.path));
        if (relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
        const store = entry.store;
        // A copy of another account's memory: nothing written in it is this account's (it is set up again at the turn's end).
        if (store !== opened?.store) return "memory moved to another account since this chat read it";
        const scrub = yield* scrubber;
        // The record as it is now: messages typed since the thread was set up count too.
        const messages = yield* userMessages((yield* recordOf(threadId)) ?? entry.record);
        entry.copy.ctx = { ...entry.ctx, userMessages: messages, tainted: store.sessionTainted(entry.ctx.session), scrubber: scrub };
        const { path: _abs, ...rest } = event;
        const scrubbed: CopyEvent = {
          ...rest,
          file: relative.split(path.sep).join("/"),
          ...(rest.content !== undefined && scrub ? { content: scrub.scrub(rest.content) } : {}),
          // The base holds an earlier write scrubbed, while the disk the agent quotes keeps the value until the turn's end.
          ...(rest.old_string !== undefined && scrub ? { old_string: scrub.scrub(rest.old_string) } : {}),
          ...(rest.new_string !== undefined && scrub ? { new_string: scrub.scrub(rest.new_string) } : {}),
          ...(rest.diff !== undefined && scrub ? { diff: scrub.scrub(rest.diff) } : {}),
        };
        let result: ReturnType<typeof ingest>;
        try {
          result = ingest(store, entry.copy, scrubbed);
        } catch (error) {
          return (error as Error).message;
        }
        if (result.saved.length > 0) {
          yield* Effect.logDebug("memory: saved", { threadId, notes: result.saved.length });
          yield* tellSaved(entry.record, result.saved);
        }
        if (result.rejected.length > 0) return result.rejected[0]!.reason;
        if (result.conflicts.length > 0) return "another session changed this note since this one read it; read it again and redo the change";
        return undefined;
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: a copy write was not ingested", cause).pipe(Effect.as("memory could not save it"))));

    const turnEnd = (threadId: string) =>
      Effect.gen(function* () {
        // Its memory_sql copy goes with the turn (the next statement builds one afresh): kept, every chat's would pile up in
        // the one sandbox process for the runtime's life.
        opened?.sandbox.forget(`session:${threadId}`);
        const entry = threads.get(threadId);
        if (!entry?.copy) return;
        const store = yield* storeNow;
        // Its copy is of another account's memory (the person signed in elsewhere since): nothing in it is this one's to
        // keep, and the next turn reads this one's.
        if (entry.store !== store) return yield* Effect.asVoid(thread(threadId));
        const scrub = yield* scrubber;
        entry.copy.ctx = { ...entry.ctx, tainted: store.sessionTainted(entry.ctx.session), scrubber: scrub };
        yield* tellSaved(entry.record, turnEndSweep(store, entry.copy, scrub));
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: turn-end sweep failed", cause)));

    const taint = (threadId: string) =>
      recordOf(threadId).pipe(
        Effect.flatMap((record) => (record ? taintRecord(record) : Effect.void)),
        Effect.catchCause((cause) => Effect.logWarning("memory: taint not recorded", cause)),
      );

    const carryTaint = (fromThreadId: string, toThreadId: string) =>
      Effect.gen(function* () {
        const from = yield* recordOf(fromThreadId);
        const to = yield* recordOf(toThreadId);
        // A sender no workspace here vouches for (a Cloud tree's, a deleted one) counts as tainted.
        if (to && (!from || (yield* readOutside(from, new Set())))) yield* taintRecord(to);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: taint not carried", cause)));

    // ------------------------------------------------------------ pushes

    /** Each session's push candidates and what each of its agent contexts was shown (memory/MemoryPush.ts). */
    const pushes = new Map<string, { store: MemoryStore; index: PushIndex; ledger: PushLedger; worktree: string }>();
    /**
     * Notes for something the agent just did, as text for it, or undefined. `context` is the
     * session, or a subagent inside it (Claude's agent_id): each is shown a note once.
     */
    const push = (threadId: string, context: string, event: MemoryPushEvent) =>
      Effect.gen(function* () {
        const entry = yield* thread(threadId, false);
        // Off, or no repository (the Chief): nothing to push.
        if (!entry?.record.internal.repoPath) return undefined;
        const store = yield* storeNow;
        const session = `session:${threadId}`;
        let state = pushes.get(threadId);
        if (state?.store !== store) {
          const repo = yield* repoId(entry.record.internal.repoPath);
          // A subagent never saw the brief: its notes are news to it too.
          const brief = entry.subagent ? undefined : store.sessionBrief(session);
          state = {
            store,
            index: new PushIndex({ repoId: repo, session, brief }, () => ({ revision: store.revision(), rows: store.current({ teamStores: [] }) })),
            ledger: new PushLedger(),
            worktree: entry.record.internal.worktreePath ?? entry.record.internal.repoPath,
          };
          pushes.set(threadId, state);
        }
        let trigger: PushTrigger;
        let notes: NoteRow[];
        // A file note's file, by note: told whether it was committed to after the note was written.
        const fileOf = new Map<string, string>();
        if (event.kind === "compact") {
          if (context !== "session") return undefined;
          trigger = "compact";
          const current = store.current({ teamStores: [] });
          // The ledger keeps each note as it was shown: what goes back is its head now, and none once forgotten or erased.
          const heads = new Map(current.filter((r) => !r.quarantined).map((r) => [`${r.store}:${r.id}`, r]));
          notes = compactNotes(
            current.filter((r) => r.by === session),
            state.ledger.shown.flatMap((r) => heads.get(`${r.store}:${r.id}`) ?? []),
          );
        } else {
          let scored: ReadonlyArray<{ readonly row: NoteRow; readonly score: number }>;
          if (event.kind === "files") {
            trigger = "file";
            const best = new Map<string, { row: NoteRow; score: number }>();
            for (const file of event.paths) {
              const relative = repoRelative(state.worktree, file, [options.copiesDir]);
              if (relative === undefined) continue;
              for (const s of state.index.match("file", { file: relative }))
                if (s.score > (best.get(s.row.vid)?.score ?? 0)) {
                  best.set(s.row.vid, s);
                  fileOf.set(s.row.vid, relative);
                }
            }
            scored = [...best.values()];
          } else if (event.kind === "failure") {
            trigger = "failure";
            scored = state.index.match("failure", { command: event.command, output: outputTail(event.output) });
          } else {
            trigger = "prompt";
            scored = state.index.match("prompt", { prompt: event.text });
          }
          notes = state.ledger.take(context, scored);
        }
        if (trigger === "compact") {
          // Beside the notes, the files changed in the chat's checkout: from its base (a worktree chat's branch point, else HEAD)
          // to the working tree, and new files.
          const worktree = state.worktree;
          const baseRef = entry.record.internal.worktreePath ? entry.record.workspace.base_ref : undefined;
          const changed = yield* Effect.promise(async () => {
            const base = baseRef ? await gitOut(worktree, ["merge-base", baseRef, "HEAD"]) : undefined;
            const [tracked, untracked] = await Promise.all([
              gitOut(worktree, ["diff", "--name-only", "--no-renames", base ?? "HEAD", "--"]),
              gitOut(worktree, ["ls-files", "--others", "--exclude-standard"]),
            ]);
            const files = [...new Set([...(tracked ?? "").split("\n"), ...(untracked ?? "").split("\n")].filter((f) => f !== ""))];
            return renderChangedFiles(files, base === undefined ? undefined : baseRef);
          });
          if (notes.length > 0) {
            store.use(notes, session, "push");
            yield* tell(entry.record, "recalled", notes);
          }
          const parts = [notes.length === 0 ? undefined : renderPush(trigger, notes), changed].filter((p): p is string => p !== undefined);
          return parts.length === 0 ? undefined : parts.join("\n\n");
        }
        if (notes.length === 0) return undefined;
        store.use(notes, session, "push");
        // Mid-turn pushes get a row; a prompt push rides in front of the person's message, whose row may not be journaled yet.
        if (trigger !== "prompt") yield* tell(entry.record, "recalled", notes);
        if (trigger !== "file") return renderPush(trigger, notes);
        // One git log per pushed note (at most PUSH_MAX): a note older than its file's last commit may be out of date.
        const worktree = state.worktree;
        const marked = yield* Effect.promise(() =>
          Promise.all(
            notes.map(async (note) => {
              const file = fileOf.get(note.vid);
              if (file === undefined) return note;
              const last = await gitOut(worktree, ["log", "-1", "--format=%cI", "--", file]);
              return changedSince(note.at, last) ? { ...note, changed: file } : note;
            }),
          ),
        );
        return renderPush(trigger, marked);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: push failed", cause).pipe(Effect.as(undefined))));

    /** A Claude-named tool call's files and failure, as push events: reads, edits, and a shell command's file reads. */
    const toolEvents = (tool: string, input: Record<string, unknown> | undefined, cwd: string): MemoryPushEvent[] => {
      const file = input?.file_path ?? input?.notebook_path ?? input?.path;
      if (/^(?:Read|Write|Edit|MultiEdit|NotebookEdit)$/.test(tool) && typeof file === "string") return [{ kind: "files", paths: [path.resolve(cwd, file)] }];
      if (tool === "Bash" && typeof input?.command === "string") {
        const reads = readsOf(input.command, cwd);
        return reads.length === 0 ? [] : [{ kind: "files", paths: reads }];
      }
      return [];
    };
    const joinNotes = (texts: ReadonlyArray<string | undefined>) => {
      const kept = texts.filter((t): t is string => t !== undefined && t !== "");
      return kept.length === 0 ? undefined : kept.join("\n\n");
    };

    // ------------------------------------------------------------ engines

    const brief = (threadId: string, engine: InstructionEngine) =>
      thread(threadId).pipe(Effect.map((entry) => (entry === undefined ? "" : entry.subagent ? entry.brief : engine === "claude-agent" ? "" : entry.brief)));

    const claude = (threadId: string) =>
      Effect.gen(function* () {
        const entry = yield* thread(threadId);
        // Off, or no workspace: Claude's own memory stays off too, so nothing lands in ~/.claude behind the app.
        if (!entry) return { settings: { autoMemoryEnabled: false, autoDreamEnabled: false }, hooks: {} };
        const under = (file: unknown) => {
          if (typeof file !== "string") return false;
          const relative = path.relative(entry.copyDir, path.resolve(file));
          return !relative.startsWith("..") && !path.isAbsolute(relative);
        };
        const writes = "Write|Edit|MultiEdit|NotebookEdit";
        // Claude's hook callbacks: subagents never write memory; a write's own change is committed as it lands.
        const preToolUse = async (input: { readonly agent_id?: string; readonly tool_input?: { readonly file_path?: unknown } }) =>
          (entry.subagent || input.agent_id) && under(input.tool_input?.file_path)
            ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Subagents don't write memory; report what you learned to your caller." } }
            : {};
        const worktree = entry.record.internal.worktreePath ?? entry.record.internal.repoPath ?? process.cwd();
        // Notes about what the call touched, for Claude or the subagent that made it.
        const pushed = async (input: { readonly agent_id?: string; readonly tool_name?: string; readonly tool_input?: unknown; readonly cwd?: string }) => {
          const events = toolEvents(input.tool_name ?? "", input.tool_input as Record<string, unknown> | undefined, input.cwd ?? worktree);
          const texts: Array<string | undefined> = [];
          for (const event of events) texts.push(await runPromise(push(threadId, input.agent_id ?? "session", event)));
          return joinNotes(texts);
        };
        const postToolUse = async (input: {
          readonly agent_id?: string;
          readonly tool_name?: string;
          readonly tool_input?: { file_path?: unknown; content?: unknown; old_string?: unknown; new_string?: unknown; replace_all?: unknown; edits?: unknown };
          readonly cwd?: string;
        }) => {
          const tool = input.tool_input;
          if (!under(tool?.file_path)) {
            const notes = await pushed(input);
            return notes === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: notes } };
          }
          if (entry.subagent || input.agent_id || !/^(?:Write|Edit|MultiEdit|NotebookEdit)$/.test(input.tool_name ?? "")) return {};
          const file = tool!.file_path as string;
          const events: AbsoluteCopyEvent[] =
            input.tool_name === "Write"
              ? [{ tool: "Write", path: file, content: String(tool!.content ?? "") }]
              : input.tool_name === "Edit"
                ? [{ tool: "Edit", path: file, old_string: String(tool!.old_string ?? ""), new_string: String(tool!.new_string ?? ""), replace_all: tool!.replace_all === true }]
                : input.tool_name === "MultiEdit" && Array.isArray(tool!.edits)
                  ? (tool!.edits as Array<{ old_string?: unknown; new_string?: unknown; replace_all?: unknown }>).map((e) => ({
                      tool: "Edit" as const,
                      path: file,
                      old_string: String(e.old_string ?? ""),
                      new_string: String(e.new_string ?? ""),
                      replace_all: e.replace_all === true,
                    }))
                  : [];
          // Awaited: the write is committed before Claude's turn can end and the turn-end sweep run.
          let refused: string | undefined;
          for (const event of events) {
            const reason = await runPromise(ingestEvent(threadId, event));
            refused ??= reason;
          }
          // Claude hears why, in the tool's result; the turn-end sweep still quarantines the change.
          return refused === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `Not saved: ${refused}` } };
        };
        // A failed command: notes about how it fails.
        const postToolUseFailure = async (input: { readonly agent_id?: string; readonly tool_input?: { readonly command?: unknown }; readonly error?: string; readonly is_interrupt?: boolean }) => {
          if (input.is_interrupt === true || typeof input.tool_input?.command !== "string") return {};
          const notes = await runPromise(push(threadId, input.agent_id ?? "session", { kind: "failure", command: input.tool_input.command, output: input.error ?? "" }));
          return notes === undefined ? {} : { hookSpecificOutput: { hookEventName: "PostToolUseFailure", additionalContext: notes } };
        };
        // After a compaction, what the summary may have dropped (PostCompact can't add context; SessionStart can).
        const sessionStart = async (input: { readonly source?: string; readonly agent_id?: string }) => {
          if (input.source !== "compact" || input.agent_id) return {};
          const notes = await runPromise(push(threadId, "session", { kind: "compact" }));
          return notes === undefined ? {} : { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: notes } };
        };
        return {
          settings: entry.subagent
            ? { autoMemoryEnabled: false, autoDreamEnabled: false }
            : { autoMemoryEnabled: true, autoMemoryDirectory: entry.copyDir, autoDreamEnabled: false },
          hooks: {
            PreToolUse: [{ matcher: writes, hooks: [preToolUse] }],
            PostToolUse: [{ matcher: `${writes}|Read|Bash`, hooks: [postToolUse] }],
            PostToolUseFailure: [{ matcher: "Bash", hooks: [postToolUseFailure] }],
            SessionStart: [{ hooks: [sessionStart] }],
          },
        };
      });

    /** Codex's refused writes by thread, until its next turn takes them (notice). */
    const refusals = new Map<string, ReadonlyArray<string>>();
    const notice = (threadId: string) =>
      Effect.sync(() => {
        const refused = refusals.get(threadId);
        refusals.delete(threadId);
        return refused && `[Caveman Code] Not saved to memory, and put back at the turn's end: ${refused.join("; ")}.`;
      });
    const codex = (threadId: string) =>
      thread(threadId).pipe(
        Effect.map((entry): CodexMemory | undefined =>
          entry === undefined
            ? undefined
            : entry.subagent
              ? // A subagent writes no memory but is pushed notes like any session.
                { onFileChange: () => undefined, push: (event) => runPromise(push(threadId, "session", event)) }
              : {
                writableRoot: entry.copyDir,
                onFileChange: async (changes) => {
                  for (const change of changes) {
                    const kind = change.kind.toLowerCase();
                    const unified = /^(?:--- |\+\+\+ |@@ )/m.test(change.diff);
                    const event: AbsoluteCopyEvent = kind.includes("delete")
                      ? { tool: "Delete", path: change.path }
                      : unified
                        ? { tool: "fileChange", path: change.path, diff: change.diff }
                        : { tool: "Write", path: change.path, content: change.diff };
                    const refused = await runPromise(ingestEvent(threadId, event));
                    if (refused !== undefined) refusals.set(threadId, [...(refusals.get(threadId) ?? []), `${path.relative(entry.copyDir, change.path) || change.path} (${refused})`]);
                  }
                },
                push: (event) => runPromise(push(threadId, "session", event)),
              },
        ),
      );

    /** The Caveman engine's tool results (its tools under Claude's names) as pushes: reads, edits, and a command's reads or failure. */
    const cavemanNote = (threadId: string, worktree: string) => async (tool: string, input: unknown, output: unknown) => {
      if (typeof output !== "string") return undefined;
      const name = claudeToolName(tool);
      const fields = (input ?? {}) as Record<string, unknown>;
      const events = toolEvents(name, fields, worktree);
      // The bash tool's result ends with its status: `exit 1`, `exit timeout…`, `exit killed`.
      const status = [...output.matchAll(/\bexit (\d+|timeout|killed)\b/g)].at(-1)?.[1];
      if (name === "Bash" && typeof fields.command === "string" && status !== undefined && status !== "0") events.push({ kind: "failure", command: fields.command, output });
      const texts: Array<string | undefined> = [];
      for (const event of events) texts.push(await runPromise(push(threadId, "session", event)));
      return joinNotes(texts);
    };
    const caveman = (threadId: string) =>
      thread(threadId).pipe(
        Effect.map((entry) => {
          if (entry === undefined) return undefined;
          const postToolUse = cavemanNote(threadId, entry.record.internal.worktreePath ?? entry.record.internal.repoPath ?? process.cwd());
          return entry.subagent
            ? { dir: entry.copyDir, postToolUse }
            : { dir: entry.copyDir, onWrite: (event: AbsoluteCopyEvent) => runSync(ingestEvent(threadId, event)), postToolUse };
        }),
      );

    const query = (threadId: string, sql: string, params: ReadonlyArray<unknown>) =>
      Effect.gen(function* () {
        const entry = yield* thread(threadId, false);
        if (!entry) return yield* Effect.fail(new Error("Memory is off"));
        const repo = entry.ctx?.repoId ?? (entry.record.internal.repoPath ? yield* repoId(entry.record.internal.repoPath) : "");
        const ctx = {
          kind: "live" as const,
          session: `session:${threadId}`,
          repoId: repo,
          knownRepos: [repo],
          teamStores: [],
          userMessages: [],
          brokerSecrets: [],
          scrubber: yield* scrubber,
          subagent: entry.subagent,
          tainted: yield* tainted(threadId),
        };
        // The sandbox of the store open now (thread opened it), whose copies hold only that account's notes.
        const { sandbox } = opened!;
        const result = yield* Effect.tryPromise({ try: () => sandbox.query(ctx, sql, params), catch: (e) => e as Error });
        // Reading `unverified` taints the session.
        if (ctx.tainted) yield* taintRecord(entry.record);
        return result.output || "(no rows)";
      });

    // ------------------------------------------------------------ notes for people

    const titles = new Map<string, { workspace_id: string; title: string } | null>();
    const threadOf = (by: string) =>
      Effect.gen(function* () {
        const threadId = by.startsWith("session:") ? by.slice(8) : undefined;
        if (!threadId) return null;
        if (titles.has(threadId)) return titles.get(threadId)!;
        const record = yield* recordOf(threadId);
        const found = record ? { workspace_id: record.workspace.id, title: record.workspace.title } : null;
        titles.set(threadId, found);
        return found;
      });
    const repoOfPath = (p: string) => (p.startsWith("repos/") ? p.split("/").slice(1, -1).join("/") : null);
    const str = (value: unknown) => (typeof value === "string" && value.length > 0 ? value : undefined);
    const toNote = (row: NoteRow & { quarantined?: boolean }, source?: NoteRow, uses?: ReadonlyMap<string, { readonly count: number; readonly last_at: string }>) =>
      Effect.gen(function* () {
        const meta = metaOf(row);
        const repo = repoOfPath(row.path);
        const cites = Array.isArray(meta.cites) ? meta.cites.filter((c): c is string => typeof c === "string") : [];
        const quote = str(meta.quote);
        const url = str(meta.url);
        const why = str(meta.why);
        const how = str(meta.how);
        return {
          id: row.id,
          scope: row.path.startsWith("user/") ? "me" : "project",
          repo,
          path: row.path,
          name: noteName(row),
          text: row.text,
          authority: row.authority,
          tainted: row.tainted === 1,
          pinned: meta.pinned === true,
          suspect: typeof meta.suspect === "string" ? meta.suspect : null,
          added: row.added,
          updated_at: row.at,
          by: row.by,
          thread: yield* threadOf((source ?? row).source.startsWith("session:") ? (source ?? row).source : row.by),
          vid: row.vid,
          uses: uses?.get(row.id) ?? null,
          provenance: {
            source: row.source,
            ...(quote ? { quote } : {}),
            ...(cites.length ? { cites } : {}),
            ...(url ? { url } : {}),
            ...(why ? { why } : {}),
            ...(how ? { how } : {}),
          },
        } satisfies MemoryNote;
      });
    const userCtx = (extra: Partial<WriterContext> = {}): Effect.Effect<WriterContext> =>
      Effect.all([knownRepos, scrubber]).pipe(
        Effect.map(([repos, scrub]) => ({ kind: "user" as const, session: "user", knownRepos: repos, teamStores: [], userMessages: [], brokerSecrets: [], scrubber: scrub, ...extra })),
      );
    const fail = (message: string) => Effect.fail(new Error(message));
    const headOf = (store: MemoryStore, id: string) => {
      const row = store.head("me", id);
      return row ? Effect.succeed(row) : fail(`No note ${id}`);
    };
    const userWrite = (op: Operation, extra: Partial<WriterContext> = {}) =>
      Effect.gen(function* () {
        const store = yield* storeNow;
        // The user's own note stays theirs to change, though no chat of its repository is left (or there never was one).
        const own = op.id ? store.visible({ teamStores: [] }, true).flatMap((r) => (r.id === op.id && repoOfPath(r.path) !== null ? [repoOfPath(r.path)!] : [])) : [];
        const base = yield* userCtx(extra);
        const ctx = own.length === 0 ? base : { ...base, knownRepos: [...base.knownRepos, ...own] };
        const result = store.commit(ctx, [op]);
        if (result.rejected.length) return yield* fail(result.rejected[0]!.reason);
        if (result.conflicts.length) return yield* fail("The note changed since you opened it; reload and try again.");
        return result.saved[0]!;
      });

    const listNotes: MemoryApi["list"] = (input) =>
      Effect.gen(function* () {
        const store = yield* storeNow;
        const repo = input.repo_path ? yield* repoId(input.repo_path) : undefined;
        const q = input.query?.trim().toLowerCase();
        const rows = store
          .current({ teamStores: [] })
          .filter((r) => !repo || r.path.startsWith("user/") || r.path.startsWith(`repos/${repo}/`))
          .filter((r) => !q || `${r.text} ${noteName(r)} ${r.path}`.toLowerCase().includes(q))
          .sort((a, b) => b.at.localeCompare(a.at));
        const uses = store.uses(rows.map((r) => r.id));
        return yield* Effect.forEach(rows, (row) => toNote(row, undefined, uses));
      });

    const claudeHome = options.claudeHome ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? os.homedir(), ".claude");

    // ------------------------------------------------------------ session events

    /** Live thread_search calls, until their result names the threads they quoted. */
    const searches = new Map<string, SessionEvent>();

    const onEvent = (event: SessionEvent) =>
      Effect.gen(function* () {
        const searchKey = `${event.session_id}\0${event.item_id ?? ""}`;
        const search = event.type === "tool.done" ? searches.get(searchKey) : undefined;
        if (event.type !== "turn.done" && event.type !== "tool.started" && event.type !== "message.done" && search === undefined) return;
        if (event.type === "message.done" && (event.payload.role !== "user" || event.payload.from === undefined)) return;
        const record = yield* sessions.getBySession(event.session_id);
        if (!record) return;
        const threadId = record.internal.threadId;
        if (event.type === "tool.started" || event.type === "message.done" || search !== undefined) {
          // Outside content taints what the session writes (docs/memory.md "What taints a session"), and so does a
          // peer's message, a thread read or a search from a thread that read some: what it read, this session now carries.
          if (event.type === "tool.started" && runtimeTool(event.payload.name, record.workspace.engine) === THREAD_SEARCH && event.item_id) searches.set(searchKey, event);
          if (search !== undefined) searches.delete(searchKey);
          if (yield* logTainted(search === undefined ? [event] : [search, event], record.workspace.engine)) yield* taintRecord(record);
          return;
        }
        yield* turnEnd(threadId);
      }).pipe(Effect.catchCause((cause) => Effect.logWarning("memory: event not handled", cause)));

    const run = Effect.gen(function* () {
      const sub = yield* PubSub.subscribe(sessions.events);
      while (true) yield* onEvent(yield* PubSub.take(sub));
    }).pipe(Effect.scoped);

    // ------------------------------------------------------------ the API

    const api: MemoryApi = {
      status: Effect.gen(function* () {
        const current = yield* settings;
        const store = yield* storeNow;
        const rows = store.current({ teamStores: [] });
        const imported = store.db.prepare("SELECT 1 FROM memory_version WHERE source LIKE 'import:claude%' LIMIT 1").get() !== undefined;
        const available = imported ? 0 : importClaudeMemories.count(claudeHome);
        const sample = render(store, {
          kind: "live",
          session: "status",
          repoId: "status/none",
          knownRepos: [],
          teamStores: [],
          userMessages: [],
          brokerSecrets: [],
          instructionFiles: "",
        });
        return {
          enabled: current.enabled,
          notes: rows.filter((r) => !r.tainted && r.authority !== "draft").length,
          drafts: rows.filter((r) => !r.tainted && r.authority === "draft").length,
          unverified: rows.filter((r) => r.tainted).length,
          brief_tokens: Math.ceil(sample.brief.length / 4),
          sql: sandboxSupported(),
          claude_import: { available, imported },
        };
      }),
      list: listNotes,
      history: (id) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          const rows = store
            .visible({ teamStores: [] }, true)
            .filter((r) => r.id === id)
            .sort((a, b) => b.vid.localeCompare(a.vid));
          const uses = store.uses([id]);
          return yield* Effect.forEach(rows, (row) => toNote(row, undefined, uses));
        }),
      put: (input) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          if (input.id) {
            const old = yield* headOf(store, input.id);
            const row = yield* userWrite({ id: old.id, baseVid: old.vid, text: input.text, ...(input.name ? { meta: { ...metaOf(old), name: input.name } } : {}) });
            return yield* toNote(row);
          }
          const repo = input.scope === "project" ? (input.repo_path ? yield* repoId(input.repo_path) : undefined) : undefined;
          if (input.scope === "project" && !repo) return yield* fail("A project note needs its project");
          // The name comes from the text as it is saved: a cut of a secret's value is no copy the commit path knows.
          const scrub = yield* scrubber;
          const slug = (scrub ? scrub.scrub(input.name ?? input.text) : (input.name ?? input.text)).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "note";
          // A project the user just added may have no chat yet: its repository is in scope all the same.
          const row = yield* userWrite(
            { path: repo ? `repos/${repo}/${slug}.md` : `user/${slug}.md`, text: input.text, meta: input.name ? { name: input.name } : {} },
            repo ? { knownRepos: [...(yield* knownRepos), repo] } : {},
          );
          return yield* toNote(row);
        }),
      forget: (id) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          const old = yield* headOf(store, id);
          yield* userWrite({ id, baseVid: old.vid, type: "forget" });
        }),
      undo: (id) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          const versions = store
            .visible({ teamStores: [] }, true)
            .filter((r) => r.id === id && !r.quarantined)
            .sort((a, b) => b.vid.localeCompare(a.vid));
          const [head, previous] = versions;
          if (!head) return yield* fail(`No note ${id}`);
          // Back to the version before the latest: a forget comes back, an edit goes back. The undo is itself a version,
          // and it restores that version as it was (an agent's draft stays a draft; a Keep undone is quarantined again).
          // A version before that was a forget (undoing the undo of a forget) is forgotten again, not restored as text.
          const row = yield* userWrite(
            previous && previous.text !== ""
              ? { id, baseVid: head.vid, text: previous.text, path: previous.path, meta: metaOf(previous), until: previous.until, restore: previous.vid }
              : { id, baseVid: head.vid, type: "forget" },
          );
          return alive(row) ? yield* toNote(row) : null;
        }),
      pin: (id, pinned) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          const old = yield* headOf(store, id);
          const meta = { ...metaOf(old) };
          if (pinned) meta.pinned = true;
          else delete meta.pinned;
          return yield* toNote(yield* userWrite({ id, baseVid: old.vid, meta }));
        }),
      keep: (id) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          const old = yield* headOf(store, id);
          return yield* toNote(yield* userWrite({ id, baseVid: old.vid }, { keep: true }));
        }),
      erase: (id) =>
        Effect.gen(function* () {
          const store = yield* storeNow;
          const old = yield* headOf(store, id);
          store.erase(yield* userCtx(), old);
        }),
      importClaude: Effect.gen(function* () {
        const store = yield* storeNow;
        const records = yield* sessions.listWorkspaces();
        const projects = new Map<string, string>();
        for (const record of records) if (record.internal.repoPath) projects.set(record.internal.repoPath, yield* repoId(record.internal.repoPath));
        const ctx: WriterContext = {
          kind: "import",
          session: "import:claude",
          knownRepos: [...new Set(projects.values())],
          teamStores: [],
          userMessages: [],
          brokerSecrets: [],
          scrubber: yield* scrubber,
        };
        // Every note comes in as a draft: none reaches a brief until the user pins or edits it.
        const result = importClaudeMemories(store, ctx, claudeHome, projects);
        return { imported: result.imported, skipped: result.skipped };
      }),
    };

    return Memory.of({
      settings,
      thread,
      brief,
      claude,
      codex,
      caveman,
      prompt: (threadId, text) =>
        Effect.gen(function* () {
          const notes = yield* push(threadId, "session", { kind: "prompt", text });
          // Asked to keep something: where to save it, beside the message (a subagent or the Chief has no copy to write).
          const entry = keepAsk(text) === undefined ? undefined : yield* thread(threadId);
          return joinNotes([notes, entry?.copy === undefined ? undefined : renderKeep(entry.ctx.copyLabel ?? entry.copyDir)]);
        }),
      ingest: ingestEvent,
      turnEnd,
      taint,
      carryTaint,
      notice,
      tainted: (threadId) => tainted(threadId).pipe(Effect.orElseSucceed(() => false)),
      query,
      remember,
      run,
      api,
    });
  });

export const layer = Layer.effect(
  Memory,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    return yield* make({ stateDir: config.stateDir, copiesDir: path.join(path.dirname(config.stateDir), "memory-copies") });
  }),
);
