// Session Protocol v1 state in the runtime's SQLite: workspaces, the
// per-session event journal (gap-free cursors within its epoch), request_id
// receipts, mail, claims, ports and settings. Event appends commit in one
// transaction with whatever they derive from (upstream projection discipline) and
// publish after the commit, in commit order. A journal rewritten under a new
// epoch (an adopted chat, a rebuild from Cloud's copy) says so on `resets`
// before its events publish, so no reader mixes two epochs.
import { createHash } from "node:crypto";
import * as fs from "node:fs";

import type { AgentSessionImportSource } from "@caveman-app/protocol";
import type { BuilderState, SessionEvent, Session, Workspace } from "@caveman-app/session-protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { CHIEF_SCHEMA, migrateChiefSchema } from "../chief/schema.ts";
import * as ServerConfig from "../config.ts";
import { quotable } from "../memory/MemoryStore.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import { foldActivity, foldOpenAsks, replyLine, type DraftEvent, type OpenAsk } from "./projector.ts";

/** Runtime-only facts about a workspace that never go on the wire. */
export interface WorkspaceInternal {
  readonly threadId: string;
  readonly worktreePath: string | null;
  readonly repoPath: string | null;
  /**
   * A chat that works in several sources of its project (Workspace.checkouts): `worktreePath` is the chat's folder,
   * the engine's working directory and no repository itself, and these are the sources in it, the primary first
   * (`repoPath` is its repository), each in the folder `name` there: a worktree of `repoPath`, or for a plain folder
   * (`folder`) a link to it. Absent for a chat in one source, whose `worktreePath` is its worktree (sources.ts).
   */
  readonly sources?: ReadonlyArray<{ readonly name: string; readonly repoPath: string; readonly folder?: true }>;
  /** The sources the engine has been told it works in (the note that goes with a message, sources.ts sourcesNote). */
  readonly sourcesTold?: ReadonlyArray<string>;
  /**
   * The chat was in one source until another was added (workspace.add_source): its folder stayed where it was and
   * what it held moved into the primary's folder in it, which the engine is told with the sources.
   */
  readonly sourcesJoined?: true;
  /**
   * On a Cloud computer, until Cloud has registered the chat: the workspace Cloud placed for it (the id its
   * `POST workspaces` answered), which its registration takes up; "" when nobody placed it (a builder this runtime
   * starts itself). Absent once registered, and for a chat whose placement this runtime does not know.
   */
  readonly placedWorkspaceId?: string;
  readonly setup?: "ran" | "skipped" | "failed" | "none";
  /**
   * A delegate_task child the projector adopted under its parent's workspace. T3 made its thread
   * and owns its checkout (the parent's, or a worktree T3 prepared), so archiving never removes it.
   */
  readonly delegated?: true;
  /**
   * A chat in a project's folder itself: a plain folder's (Project.no_git), or one imported from a session that ran
   * there (`imported`). worktreePath is repoPath and it has no branch, so archive leaves the folder and nothing that
   * needs its own checkout runs on it.
   */
  readonly inFolder?: true;
  /**
   * A chat project.import_chats made from a Claude Code or Codex session that ran in its project's folder (it runs
   * there, inFolder): which session, and the transcript file as it was read, so the session is never imported twice.
   */
  readonly imported?: { readonly engine: string; readonly nativeId: string; readonly source: AgentSessionImportSource };
  /** An automation step's or check's thread (automations/steps.ts): which run, step and attempt it is, for spend and the run view. */
  readonly automation?: { readonly automation: string; readonly run: string; readonly step: string; readonly attempt: number; readonly check?: number };
  /** goal.set: the session goal; `native` when the engine keeps it (Codex), else the runtime prepends it to each turn. */
  readonly goal?: { readonly objective: string; readonly native: boolean };
  /**
   * The "Compression off" line this session was last shown: `here` on a Cloud computer (once ever), `proxy`
   * while the app proxy is out, `retrieve` while its MCP server is out (each cleared on recovery). Kept with the
   * record so a relaunch doesn't tell the same thing again.
   */
  readonly compressionOffTold?: "here" | "proxy" | "retrieve";
  /**
   * workspace.create answered before the disk: its worktree, thread and first turn are still being made in the
   * background, and record lookups wait for them (handlers.ts settled).
   */
  readonly preparing?: true;
  /** Why the workspace never started (its worktree or thread could not be made), in plain words: only archive works. */
  readonly startFailed?: string;
  /**
   * A chat made ahead on the New chat page (handlers.ts spares) so its engine starts while the person types: no
   * thread yet, never listed or published. workspace.create takes it, or it is dropped (dropSpare).
   */
  readonly spare?: true;
  /**
   * The asks still waiting on the person, oldest first (projector.ts foldOpenAsks). Workspace.activity shows only
   * the latest, so when it is answered the one before it shows again.
   */
  readonly openAsks?: ReadonlyArray<OpenAsk>;
  /**
   * A chat a Cloud computer started on a pull request (handlers.ts): the pull request's own branch and the commit it
   * was at when the chat last moved it, so each push of the chat's caveman/pr-N-* branch moves it on through Cloud
   * (update-head), or, for a fork Cloud may not write, goes to one follow-up pull request against its base.
   */
  readonly pullRequestHead?: {
    readonly number: number;
    readonly url: string;
    readonly base: string;
    readonly headRef: string;
    readonly headSha: string;
    readonly fork: boolean;
    readonly maintainerCanModify: boolean;
    /** The follow-up pull request a fork's pushes go to, once opened. */
    readonly followUp?: number;
  };
}

/**
 * A stored event as v1 sends it now. Sessions recorded with plan mode hold `plan.updated` of
 * kind `proposed`, which v1 no longer has: it replays as the assistant's text, at the same
 * cursor (a gap would read as a runtime bug).
 */
export const upgradeStoredEvent = (event: SessionEvent): SessionEvent => {
  const stored = event as { readonly type: string; readonly payload: { readonly kind?: string; readonly markdown?: string } };
  return stored.type === "plan.updated" && stored.payload.kind === "proposed"
    ? ({ ...event, type: "message.done", payload: { role: "assistant", text: stored.payload.markdown ?? "" } } as SessionEvent)
    : event;
};

export interface WorkspaceRecord {
  readonly workspace: Workspace;
  readonly session: Session;
  readonly internal: WorkspaceInternal;
}

/** The notice and its persisted outage marker change together, including when recovery clears it. */
export function compressionOffUpdate(record: WorkspaceRecord, told: WorkspaceInternal["compressionOffTold"], at: string, title?: string) {
  if (record.internal.compressionOffTold === told) return { record, events: [] as Array<DraftEvent>, value: undefined };
  const { compressionOffTold: _, ...internal } = record.internal;
  return {
    record: { ...record, internal: told === undefined ? internal : { ...internal, compressionOffTold: told } },
    events: title === undefined ? [] : [{ at, type: "notification", payload: { level: "info", title } } as DraftEvent],
    value: undefined,
  };
}

export interface Receipt {
  readonly paramsHash: string;
  readonly result: unknown;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS caveman_sp_workspaces (
     id TEXT PRIMARY KEY,
     session_id TEXT NOT NULL UNIQUE,
     thread_id TEXT NOT NULL UNIQUE,
     workspace TEXT NOT NULL,
     session TEXT NOT NULL,
     internal TEXT NOT NULL,
     created_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_events (
     session_id TEXT NOT NULL,
     cursor INTEGER NOT NULL,
     type TEXT NOT NULL,
     at TEXT NOT NULL,
     event TEXT NOT NULL,
     PRIMARY KEY (session_id, cursor))`,
  `CREATE INDEX IF NOT EXISTS caveman_sp_events_type ON caveman_sp_events (type, at)`,
  // Each session journal's epoch (CONTRACT §1): absent means 1, the epoch every journal starts at.
  `CREATE TABLE IF NOT EXISTS caveman_sp_journals (
     session_id TEXT PRIMARY KEY,
     epoch INTEGER NOT NULL)`,
  // The Cloud copy's outbox (cloudLink/copy.ts): a row while a synced chat has something Cloud's copy lacks, with
  // when its next copy is due and how many failed in a row. Durable, so a copy owed before a crash is made after it.
  `CREATE TABLE IF NOT EXISTS caveman_sp_copy_outbox (
     session_id TEXT PRIMARY KEY,
     due_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     last_error TEXT)`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_thread_state (
     thread_id TEXT PRIMARY KEY,
     state TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_projector (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     last_sequence INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_display_text (
     message_id TEXT PRIMARY KEY,
     text TEXT NOT NULL)`,
  // Messages sent as follow-ups that T3 queued (turn.submit kind followup): T3 keeps no kind, and a follow-up goes
  // behind the follow-ups ahead of it and in front of the rest of the queue (aheadOfQueue), restarts included.
  `CREATE TABLE IF NOT EXISTS caveman_sp_followups (
     message_id TEXT PRIMARY KEY,
     at INTEGER NOT NULL)`,
  // submit prunes marks older than FOLLOWUPS_KEPT_MS on every queued follow-up.
  `CREATE INDEX IF NOT EXISTS caveman_sp_followups_at ON caveman_sp_followups (at)`,
  // An agent's message (a mail's wake, a builder's or lead's) for a chat leaving this computer or gone from it (owe):
  // its copies carry it, it is handed on to where the chat is, or it runs here if the chat stays (settleOwedInput).
  `CREATE TABLE IF NOT EXISTS caveman_sp_owed_input (
     session_id TEXT NOT NULL,
     request_id TEXT NOT NULL,
     text TEXT NOT NULL,
     sender_title TEXT NOT NULL,
     sender_workspace_id TEXT,
     at INTEGER NOT NULL,
     PRIMARY KEY (session_id, request_id))`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_receipts (
     principal TEXT NOT NULL,
     method TEXT NOT NULL,
     request_id TEXT NOT NULL,
     params_hash TEXT NOT NULL,
     result TEXT NOT NULL,
     expires_at INTEGER NOT NULL,
     PRIMARY KEY (principal, method, request_id))`,
  // putReceipt sweeps expired receipts on every mutating call, remote control's per-frame input among them.
  `CREATE INDEX IF NOT EXISTS caveman_sp_receipts_expiry ON caveman_sp_receipts (expires_at)`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_kv (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_ports (
     port INTEGER PRIMARY KEY,
     workspace_id TEXT NOT NULL,
     name TEXT NOT NULL)`,
  // What this runtime made for a workspace on a service its computer runs (workspaceIsolation.ts): a Postgres
  // database (`name`), a Redis index (`name`), at the service's host:port (`at`). Only what is listed here is ever
  // dropped or flushed, and only for the workspace it lists.
  `CREATE TABLE IF NOT EXISTS caveman_sp_isolation (
     kind TEXT NOT NULL,
     at TEXT NOT NULL,
     name TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     PRIMARY KEY (kind, at, name))`,
  `CREATE TABLE IF NOT EXISTS caveman_sp_mail (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     id TEXT NOT NULL UNIQUE,
     to_workspace_id TEXT NOT NULL,
     message TEXT NOT NULL)`,
  // Runtime-level spend: usage of side calls that belong to no session
  // (message.caveman_version, skill.record). spend.summary adds it to the usage events.
  `CREATE TABLE IF NOT EXISTS caveman_sp_spend (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     workspace_id TEXT,
     usage TEXT NOT NULL)`,
  // Turn telemetry's outbox (telemetry/turnTelemetry.ts): settled turns' facts until the desktop acknowledges them.
  `CREATE TABLE IF NOT EXISTS caveman_sp_turn_facts (
     seq INTEGER PRIMARY KEY,
     fact TEXT NOT NULL)`,
  // The Chief's board (chief/schema.ts).
  ...CHIEF_SCHEMA,
  `CREATE TABLE IF NOT EXISTS caveman_sp_claims (
     path TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     PRIMARY KEY (path, workspace_id))`,
  // The thread whose agent a user-role message came from, when the runtime submitted it for one (mail, a task an
  // agent started a workspace with): T3 carries no sender for it, so the projector sets `from` from here. `agent`: an
  // outside agent's name (outsideAgents.ts), whose `thread_id` is its principal (`agent:<id>`), no thread at all.
  `CREATE TABLE IF NOT EXISTS caveman_sp_senders (
     message_id TEXT PRIMARY KEY,
     thread_id TEXT NOT NULL,
     agent TEXT)`,
  // A user-role message the runtime wrote for an agent (builders.ts: a builder's result, its builders' one result, the
  // word to carry on): the one line a person reads of it, and the builders' result as JSON. The projector sets
  // message.done `generated` (and `builders_result`) from here, as it sets `from` from caveman_sp_senders.
  `CREATE TABLE IF NOT EXISTS caveman_sp_generated (
     message_id TEXT PRIMARY KEY,
     shown TEXT NOT NULL,
     result TEXT)`,
  // What became of each builder of a lead here (builders.ts keeps it as its row, merge and pause change): a
  // BuilderState as JSON, which every Workspace a client reads carries as `builder`.
  `CREATE TABLE IF NOT EXISTS caveman_sp_builder_states (
     workspace_id TEXT PRIMARY KEY,
     state TEXT NOT NULL)`,
  // The person's own words, quoted for a workspace from another session (a chat an agent started for them): each a
  // verbatim substring of one of that session's user messages, so memory counts it as theirs.
  `CREATE TABLE IF NOT EXISTS caveman_sp_workspace_user_quotes (
     workspace_id TEXT NOT NULL,
     quote TEXT NOT NULL,
     source_session TEXT NOT NULL,
     source_message_id TEXT NOT NULL,
     at TEXT NOT NULL,
     PRIMARY KEY (workspace_id, quote))`,
];

/** A quote of the person's words attached to a workspace (putQuotes). */
export interface UserQuote {
  readonly workspace_id: string;
  readonly quote: string;
  readonly source_session: string;
  readonly source_message_id: string;
  readonly at: string;
}

/** The message id submit gives a turn (handlers.ts): one per session and request_id. */
export const submittedMessageId = (sessionId: string, requestId: string) =>
  `sp-msg:${createHash("sha256").update(`${sessionId}\0${requestId}`).digest("hex").slice(0, 24)}`;

/**
 * The workspace id of a chat Caveman Cloud placed on this Cloud computer, from the id of the workspace Cloud placed
 * for it (workspace.create's placed_workspace_id): a device that had Cloud place the chat names it by this id from that
 * moment, before this runtime made it (apps/web state/sync/message-id.ts placedWorkspaceId, the same sum). A v4-shaped
 * id, as every other workspace's: Cloud's own ids start with their time, and a branch is named by an id's start.
 */
export const placedWorkspaceId = (placed: string) => {
  const sum = createHash("sha256").update(`caveman:placed-workspace\0${placed.toLowerCase()}`).digest().subarray(0, 16);
  sum[6] = (sum[6]! & 0x0f) | 0x40;
  sum[8] = (sum[8]! & 0x3f) | 0x80;
  const hex = sum.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/**
 * The request id under which the runtime `runtimeId`, which the chat moved away from, hands the person's message sent as
 * `requestId` on to where the chat is now (handlers passOn, CHAOS-19). Cloud's call under the person's own id says only
 * that some computer answered it, maybe this one before the move, so the hand-on is its own call there; the message
 * keeps the person's request id wherever it runs (forwardedOf).
 */
export const forwardedRequestId = (runtimeId: string, requestId: string) => `forwarded:${runtimeId}:${requestId}`;
/** The person's request id a handed-on message carries (forwardedRequestId), or undefined for any other. */
export const forwardedOf = (requestId: string) => /^forwarded:[^:]+:(.+)$/s.exec(requestId)?.[1];

/** What the person typed in a session's log, verbatim: user-role messages no agent sent. */
export const typedMessages = (events: ReadonlyArray<SessionEvent>) =>
  events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" && e.payload.from === undefined ? [{ id: e.item_id ?? `e${e.cursor}`, text: e.payload.text }] : []));

export interface PublishedEvent {
  readonly event: SessionEvent;
}

/** A session's journal rewritten under a new epoch: what readers hold of it no longer holds. */
export interface JournalReset {
  readonly session_id: string;
  readonly epoch: number;
}

/** What a transact body commits and publishes. `epochs`: journals it rewrote, each under its new epoch. */
export interface Committed<A> {
  readonly value: A;
  readonly published: ReadonlyArray<SessionEvent>;
  readonly changed: ReadonlyArray<Workspace>;
  readonly epochs?: ReadonlyArray<JournalReset>;
}

/** The journal facts a Workspace carries on the wire (CONTRACT §1). */
export interface JournalFacts {
  readonly epoch: number;
  readonly head: number;
  /** Cloud's copy's last cursor in `epoch`; null when the chat does not sync. */
  readonly synced_through: number | null;
}

export class SessionStore extends Context.Service<
  SessionStore,
  {
    readonly sql: SqlClient.SqlClient;
    /** Committed events, in commit order. */
    readonly events: PubSub.PubSub<SessionEvent>;
    readonly workspaceChanges: PubSub.PubSub<Workspace>;
    readonly putWorkspace: (record: WorkspaceRecord) => Effect.Effect<void>;
    readonly getWorkspace: (id: string) => Effect.Effect<WorkspaceRecord | undefined>;
    readonly getBySession: (sessionId: string) => Effect.Effect<WorkspaceRecord | undefined>;
    readonly getByThread: (threadId: string) => Effect.Effect<WorkspaceRecord | undefined>;
    /** Every workspace but a spare (WorkspaceInternal.spare). */
    readonly listWorkspaces: () => Effect.Effect<ReadonlyArray<WorkspaceRecord>>;
    /** A spare chat no one took (or, without an id, every one a crash left): its row and what its session holds. */
    readonly dropSpare: (id?: string) => Effect.Effect<void>;
    /**
     * Appends events to a session in one transaction with `inside` (which
     * may read and write other rows), then publishes them. Returns the
     * stored events.
     */
    readonly append: <A>(
      sessionId: string,
      build: (record: WorkspaceRecord) => Effect.Effect<{ readonly events: ReadonlyArray<DraftEvent>; readonly value: A; readonly record?: WorkspaceRecord }>,
    ) => Effect.Effect<{ readonly events: ReadonlyArray<SessionEvent>; readonly value: A }>;
    /**
     * Runs `body` holding the append lane and inside one transaction; publishes what it returns. A journal it rewrote
     * (`epochs`) takes its new epoch in the same transaction, and its reset publishes before any event.
     */
    readonly transact: <A>(body: Effect.Effect<Committed<A>>) => Effect.Effect<A>;
    /** Journal rewrites, each published before the rewritten journal's events. */
    readonly resets: PubSub.PubSub<JournalReset>;
    /** The session journal's epoch now (1 until it is rewritten). */
    readonly epochOf: (sessionId: string) => number;
    /**
     * Chats the last run journaled that ended without a clean stop (an OS crash may have eaten its last commits, which
     * devices may hold): read once at start from the file beside the database (CHAOS-5, X-4).
     */
    readonly crashed: ReadonlyArray<string>;
    /** The runtime stops cleanly: no chat it journaled needs a new epoch at the next start. */
    readonly cleanStop: Effect.Effect<void>;
    /**
     * Runs `read` between commits: no append commits or publishes while it runs, so what it reads (a head, an epoch)
     * and a subscription it takes agree.
     */
    readonly betweenCommits: <A, E, R>(read: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
    /** A workspace with its journal facts (epoch, head, how far Cloud's copy stands), as clients get it. */
    readonly withJournal: (record: WorkspaceRecord) => Effect.Effect<Workspace>;
    /** withJournal for many, in one read. */
    readonly withJournals: (records: ReadonlyArray<WorkspaceRecord>) => Effect.Effect<ReadonlyArray<Workspace>>;
    /**
     * Inside a transaction: append drafts to a session, bumping its head, and fold them into the workspace's
     * activity (withActivity). The caller publishes the returned workspace when its `activity` changed.
     */
    readonly appendInTx: (record: WorkspaceRecord, drafts: ReadonlyArray<DraftEvent>) => Effect.Effect<{ readonly events: ReadonlyArray<SessionEvent>; readonly record: WorkspaceRecord }>;
    readonly readEvents: (sessionId: string, afterCursor: number, throughCursor: number) => Effect.Effect<ReadonlyArray<SessionEvent>>;
    /**
     * readEvents as each event's JSON text, at most `limit` of them, for the attach backlog: an event the replay
     * scrub and upgrades leave as stored goes out as stored, never parsed and re-serialized.
     */
    readonly readEventJson: (
      sessionId: string,
      afterCursor: number,
      throughCursor: number,
      limit: number,
    ) => Effect.Effect<ReadonlyArray<{ readonly cursor: number; readonly json: string }>>;
    readonly getReceipt: (principal: string, method: string, requestId: string) => Effect.Effect<Receipt | undefined>;
    readonly putReceipt: (principal: string, method: string, requestId: string, receipt: Receipt, ttlMs: number) => Effect.Effect<void>;
    readonly kvGet: (key: string) => Effect.Effect<string | undefined>;
    readonly kvSet: (key: string, value: string) => Effect.Effect<void>;
    readonly publishWorkspace: (workspace: Workspace) => Effect.Effect<void>;
    /**
     * Attaches quotes of the person's words to a workspace, each only if it is a verbatim substring of one of the
     * source sessions' typed user messages (the check a told note's quote gets): the session quoting, then any other
     * that first heard the words (a Chief's moved item: Board.Item heard_in). Fails naming the first that is not, storing none.
     */
    readonly putQuotes: (workspaceId: string, sourceSessionIds: ReadonlyArray<string>, quotes: ReadonlyArray<string>) => Effect.Effect<ReadonlyArray<UserQuote>, Error>;
    readonly quotes: (workspaceId: string) => Effect.Effect<ReadonlyArray<UserQuote>>;
  }
>()("caveman/session-protocol/SessionStore") {}

/**
 * A record after events journaled for it: its open asks and what its chat is at (Workspace.activity), from the
 * scrubbed events, so no secret value reaches the workspace either. The same record when neither changed; a
 * caller publishes the workspace when its `activity` is no longer the one it passed in.
 */
export const withActivity = (record: WorkspaceRecord, events: ReadonlyArray<DraftEvent>): WorkspaceRecord => {
  const openAsks = foldOpenAsks(record.internal.openAsks, events);
  const activity = foldActivity(record.workspace.activity, events, openAsks);
  if (openAsks === record.internal.openAsks && activity === record.workspace.activity) return record;
  const { activity: _activity, ...workspace } = record.workspace;
  const { openAsks: _asks, ...internal } = record.internal;
  return {
    ...record,
    workspace: activity === record.workspace.activity ? record.workspace : { ...workspace, ...(activity ? { activity } : {}) },
    internal: openAsks === record.internal.openAsks ? record.internal : { ...internal, ...(openAsks ? { openAsks } : {}) },
  };
};

/**
 * The record with Workspace.activity.awaiting as its thread's background work says (awaiting.ts), or the same record
 * when it already says so. Never bumps `updated_at`: the queue keeps its order.
 */
export const withAwaiting = (record: WorkspaceRecord, awaiting: boolean): WorkspaceRecord => {
  if ((record.workspace.activity?.awaiting === true) === awaiting) return record;
  const { awaiting: _, ...rest } = record.workspace.activity ?? {};
  // Folded with no events, so its keys stand in the order the next fold builds them.
  const activity = foldActivity(awaiting ? { ...rest, awaiting: true } : rest, [], record.internal.openAsks);
  const { activity: _activity, ...workspace } = record.workspace;
  return { ...record, workspace: activity ? { ...workspace, activity } : workspace };
};

const parseRecord = (row: { workspace: string; session: string; internal: string }): WorkspaceRecord => ({
  workspace: JSON.parse(row.workspace),
  session: JSON.parse(row.session),
  internal: JSON.parse(row.internal),
});

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Every event is scrubbed of every repository's secret values here, before it is stored or published,
  // and again on replay, for events stored before a value was set.
  const secrets = yield* ProjectSecrets;
  for (const statement of SCHEMA) yield* sql.unsafe(statement).pipe(Effect.orDie);
  // Chief columns an older database lacks (chief/schema.ts).
  yield* migrateChiefSchema(sql).pipe(Effect.orDie);
  // Senders recorded before outside agents.
  if (!(yield* sql<{ name: string }>`SELECT name FROM pragma_table_info('caveman_sp_senders')`.pipe(Effect.orDie)).some((c) => c.name === "agent")) {
    yield* sql.unsafe(`ALTER TABLE caveman_sp_senders ADD COLUMN agent TEXT`).pipe(Effect.orDie);
  }
  // Mail an older runtime woke a workspace with: its message id is the one submit derived from `mail:<id>`, so its
  // sender is named here and readEvents gives those messages their `from`.
  // ponytail: reruns at every start (idempotent, a hash per mail row); a done-marker if mail runs to many thousands.
  const sent = yield* sql<{ id: string; session_id: string; thread_id: string }>`SELECT m.id, t.session_id, f.thread_id FROM caveman_sp_mail m
    JOIN caveman_sp_workspaces t ON t.id = m.to_workspace_id
    JOIN caveman_sp_workspaces f ON f.id = json_extract(m.message, '$.from_workspace_id')`.pipe(Effect.orDie);
  for (const row of sent) {
    yield* sql`INSERT OR IGNORE INTO caveman_sp_senders (message_id, thread_id) VALUES (${submittedMessageId(row.session_id, `mail:${row.id}`)}, ${row.thread_id})`.pipe(Effect.orDie);
  }
  // Chats answered before Workspace.activity.last_reply get their latest answer once (a kv mark): the newest
  // message.done of the chat's own agent, scrubbed as replay scrubs. Later answers fold it as they land (withActivity).
  if ((yield* sql<{ value: string }>`SELECT value FROM caveman_sp_kv WHERE key = 'activity.last_reply'`.pipe(Effect.orDie)).length === 0) {
    const answered = yield* sql<{ id: string; workspace: string; reply: string }>`SELECT id, workspace, reply FROM (SELECT w.id, w.workspace,
        (SELECT json_extract(e.event, '$.payload.text') FROM caveman_sp_events e
          WHERE e.session_id = w.session_id AND e.type = 'message.done' AND json_extract(e.event, '$.payload.role') = 'assistant'
            AND json_extract(e.event, '$.parent_item_id') IS NULL
          ORDER BY e.cursor DESC LIMIT 1) AS reply
      FROM caveman_sp_workspaces w WHERE json_extract(w.workspace, '$.activity.last_reply') IS NULL) WHERE reply IS NOT NULL`.pipe(Effect.orDie);
    const scrubber = answered.length === 0 ? undefined : yield* secrets.scrubber;
    yield* sql
      .withTransaction(
        Effect.gen(function* () {
          for (const row of answered) {
            const line = replyLine(scrubber!.scrub(row.reply));
            if (!line) continue;
            const workspace = JSON.parse(row.workspace) as Workspace;
            // Last, as foldActivity orders its keys, so its next fold compares equal when nothing changed.
            const next: Workspace = { ...workspace, activity: { ...workspace.activity, last_reply: line } };
            yield* sql`UPDATE caveman_sp_workspaces SET workspace = ${JSON.stringify(next)} WHERE id = ${row.id}`;
          }
          yield* sql`INSERT INTO caveman_sp_kv (key, value) VALUES ('activity.last_reply', '1') ON CONFLICT (key) DO NOTHING`;
        }),
      )
      .pipe(Effect.orDie);
  }
  const events = yield* PubSub.unbounded<SessionEvent>();
  const workspaceChanges = yield* PubSub.unbounded<Workspace>();
  const resets = yield* PubSub.unbounded<JournalReset>();
  // Every rewritten journal's epoch, read once; set inside the rewriting transaction, so a reader that sees its rows sees its epoch.
  const epochs = new Map((yield* sql<{ session_id: string; epoch: number }>`SELECT session_id, epoch FROM caveman_sp_journals`.pipe(Effect.orDie)).map((r) => [r.session_id, r.epoch] as const));
  const epochOf = (sessionId: string) => epochs.get(sessionId) ?? 1;
  // Every chat this run journals, written beside the database and synced before devices hear of its first event: it
  // survives the crash that eats the database's last commits (synchronous=NORMAL), so the next start knows which chats
  // devices may hold events of that the journal lost. A clean stop removes it. The last run's crashed chats stay in it
  // until then: what this run records for them (a new epoch, X-4's hold) may be lost by another crash the same way.
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const journaledPath = config._tag === "Some" ? `${config.value.dbPath}.journaled` : undefined;
  const crashed = journaledPath !== undefined && fs.existsSync(journaledPath) ? [...new Set(fs.readFileSync(journaledPath, "utf8").split("\n").filter((id) => id !== ""))] : [];
  const journaled = new Set<string>(crashed);
  const markJournaled = (published: ReadonlyArray<SessionEvent>) =>
    Effect.sync(() => {
      if (journaledPath === undefined) return;
      const fresh = [...new Set(published.map((e) => e.session_id))].filter((id) => !journaled.has(id));
      if (fresh.length === 0) return;
      const fd = fs.openSync(journaledPath, "a");
      try {
        fs.writeSync(fd, fresh.map((id) => `${id}\n`).join(""));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      for (const id of fresh) journaled.add(id);
    });
  // One writer at a time, publishing before the next commits, so subscribers
 // see events in cursor order (EventSink.ts does the same for upstream events).
  const lane = yield* Semaphore.make(1);

  type Row = { workspace: string; session: string; internal: string };
  const one = (rows: ReadonlyArray<Row>) => (rows[0] === undefined ? undefined : parseRecord(rows[0]));

  const putWorkspace = (record: WorkspaceRecord) =>
    sql`INSERT INTO caveman_sp_workspaces (id, session_id, thread_id, workspace, session, internal, created_at)
        VALUES (${record.workspace.id}, ${record.session.id}, ${record.internal.threadId},
                ${JSON.stringify(record.workspace)}, ${JSON.stringify(record.session)},
                ${JSON.stringify(record.internal)}, ${record.workspace.created_at})
        ON CONFLICT (id) DO UPDATE SET workspace = excluded.workspace, session = excluded.session,
          internal = excluded.internal, thread_id = excluded.thread_id`.pipe(Effect.asVoid, Effect.orDie);

  const appendInTx = (record: WorkspaceRecord, drafts: ReadonlyArray<DraftEvent>) =>
    Effect.gen(function* () {
      const fresh = one(yield* sql<Row>`SELECT workspace, session, internal FROM caveman_sp_workspaces WHERE session_id = ${record.session.id}`) ?? record;
      let head = fresh.session.head;
      const stored: Array<SessionEvent> = [];
      const scrubber = yield* secrets.scrubber;
      const scrubbed = drafts.map(scrubber.scrubDeep);
      for (const draft of scrubbed) {
        head += 1;
        const event = { session_id: fresh.session.id, cursor: head, ...draft } as SessionEvent;
        stored.push(event);
        yield* sql`INSERT INTO caveman_sp_events (session_id, cursor, type, at, event)
                   VALUES (${event.session_id}, ${event.cursor}, ${event.type}, ${event.at}, ${JSON.stringify(event)})`;
      }
      // Folded here, not in the projector alone: grill rounds and grill.finished are journaled by grill.ts itself.
      const folded = withActivity(record, scrubbed);
      const next: WorkspaceRecord = { ...folded, session: { ...folded.session, head } };
      yield* putWorkspace(next);
      return { events: stored, record: next };
    }).pipe(Effect.orDie);

  const transact = <A>(body: Effect.Effect<Committed<A>>) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const before = new Map<string, number | undefined>();
        const result = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              const out = yield* body;
              for (const reset of out.epochs ?? []) {
                yield* sql`INSERT INTO caveman_sp_journals (session_id, epoch) VALUES (${reset.session_id}, ${reset.epoch})
                           ON CONFLICT (session_id) DO UPDATE SET epoch = excluded.epoch`;
                if (!before.has(reset.session_id)) before.set(reset.session_id, epochs.get(reset.session_id));
                epochs.set(reset.session_id, reset.epoch);
              }
              return out;
            }),
          )
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                for (const [id, epoch] of before) epoch === undefined ? epochs.delete(id) : epochs.set(id, epoch);
              }),
            ),
            Effect.orDie,
          );
        yield* PubSub.publishAll(resets, result.epochs ?? []);
        yield* markJournaled(result.published);
        yield* PubSub.publishAll(events, result.published);
        yield* PubSub.publishAll(workspaceChanges, result.changed);
        return result.value;
      }),
    );

  /** How far Cloud's copy of each chat stands (cloudLink/copy.ts keeps it beside the moves copy state, `moves:<id>`). */
  const copiedThrough = (sessionIds: ReadonlyArray<string>) =>
    sessionIds.length === 0
      ? Effect.succeed(new Map<string, { readonly cursor: number; readonly epoch: number | undefined }>())
      : sql<{ key: string; value: string }>`SELECT key, value FROM caveman_sp_kv WHERE key IN ${sql.in(sessionIds.map((id) => `moves:${id}`))}`.pipe(
          Effect.map(
            (rows) =>
              new Map(
                rows.flatMap((row) => {
                  try {
                    const copy = JSON.parse(row.value) as { cursor?: unknown; epoch?: unknown };
                    return typeof copy.cursor === "number" ? [[row.key.slice("moves:".length), { cursor: copy.cursor, epoch: typeof copy.epoch === "number" ? copy.epoch : undefined }] as const] : [];
                  } catch {
                    return [];
                  }
                }),
              ),
          ),
          Effect.orDie,
        );
  /**
   * What became of each builder among these workspaces (caveman_sp_builder_states), by workspace id. Every record is
   * asked for: the table holds builders only, and one Cloud started here for a lead on another computer names no
   * parent on this one.
   */
  const builderStates = (ids: ReadonlyArray<string>) =>
    ids.length === 0
      ? Effect.succeed(new Map<string, BuilderState>())
      : sql<{ workspace_id: string; state: string }>`SELECT workspace_id, state FROM caveman_sp_builder_states WHERE workspace_id IN ${sql.in(ids)}`.pipe(
          Effect.map((rows) => new Map(rows.map((row) => [row.workspace_id, JSON.parse(row.state) as BuilderState] as const))),
          Effect.orDie,
        );
  const withJournals = (records: ReadonlyArray<WorkspaceRecord>) =>
    Effect.all([copiedThrough(records.map((r) => r.session.id)), builderStates(records.map((r) => r.workspace.id))]).pipe(
      Effect.map(([copies, builders]) =>
        records.map((record) => {
          const epoch = epochOf(record.session.id);
          const copy = copies.get(record.session.id);
          const builder = builders.get(record.workspace.id);
          return { ...record.workspace, epoch, head: record.session.head, synced_through: copy === undefined ? null : copy.epoch === undefined || copy.epoch === epoch ? copy.cursor : 0, ...(builder === undefined ? {} : { builder }) };
        }),
      ),
    );

  const getBySession = (sessionId: string) =>
    sql<Row>`SELECT workspace, session, internal FROM caveman_sp_workspaces WHERE session_id = ${sessionId}`.pipe(Effect.map(one), Effect.orDie);

  /** Stored events as readers get them: scrubbed of today's values, upgraded, mail given its sender. */
  const prepareEvents = (stored: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const scrubber = yield* secrets.scrubber;
      const events: Array<SessionEvent> = stored.map((event) => scrubber.scrubDeep(upgradeStoredEvent(JSON.parse(event))));
      // Journaled before its message carried a sender (mail from an older runtime): a message the runtime submitted
      // for an agent gets its `from` here, so no reader takes it for the person's words.
      const unnamed = events.flatMap((e) => (e.type === "message.done" && e.payload.role === "user" && e.payload.from === undefined && e.item_id !== undefined ? [e.item_id] : []));
      if (unnamed.length === 0) return events;
      const senders = new Map(
        (yield* sql<{ message_id: string; thread_id: string; agent: string | null; workspace: string | null }>`SELECT s.message_id, s.thread_id, s.agent, w.workspace FROM caveman_sp_senders s
          LEFT JOIN caveman_sp_workspaces w ON w.thread_id = s.thread_id WHERE s.message_id IN ${sql.in(unnamed)}`).map((r) => [r.message_id, r] as const),
      );
      if (senders.size === 0) return events;
      return events.map((e) => {
        const sender = e.type === "message.done" && e.item_id !== undefined ? senders.get(e.item_id) : undefined;
        if (sender === undefined || e.type !== "message.done") return e;
        // An outside agent's message: its name, never its principal.
        if (sender.agent !== null) return { ...e, payload: { ...e.payload, from: { title: sender.agent, agent: true as const } } };
        const workspace = sender.workspace === null ? undefined : (JSON.parse(sender.workspace) as Workspace);
        return { ...e, payload: { ...e.payload, from: workspace ? { workspace_id: workspace.id, title: workspace.title } : { title: sender.thread_id } } };
      });
    });

  const readEvents = (sessionId: string, afterCursor: number, throughCursor: number) =>
    sql<{ event: string }>`SELECT event FROM caveman_sp_events
        WHERE session_id = ${sessionId} AND cursor > ${afterCursor} AND cursor <= ${throughCursor}
        ORDER BY cursor`.pipe(
      Effect.flatMap((rows) => prepareEvents(rows.map((row) => row.event))),
      Effect.orDie,
    );

  const readEventJson = (sessionId: string, afterCursor: number, throughCursor: number, limit: number) =>
    Effect.gen(function* () {
      const rows = yield* sql<{ cursor: number; type: string; event: string }>`SELECT cursor, type, event FROM caveman_sp_events
        WHERE session_id = ${sessionId} AND cursor > ${afterCursor} AND cursor <= ${throughCursor}
        ORDER BY cursor LIMIT ${limit}`;
      const scrubber = yield* secrets.scrubber;
      // Parsed only where prepareEvents could change it: a value of today's to scrub, a stored proposed plan,
      // a user message that may need its sender.
      const mayChange = scrubber.mayChangeJson ?? (() => true);
      const reparse = rows.flatMap((row, i) =>
        row.type === "plan.updated" || (row.type === "message.done" && row.event.includes(`"role":"user"`)) || mayChange(row.event) ? [i] : [],
      );
      const prepared = reparse.length === 0 ? [] : yield* prepareEvents(reparse.map((i) => rows[i]!.event));
      const json = rows.map((row) => row.event);
      reparse.forEach((i, k) => (json[i] = JSON.stringify(prepared[k])));
      return rows.map((row, i) => ({ cursor: row.cursor, json: json[i]! }));
    }).pipe(Effect.orDie);

  const putQuotes = (workspaceId: string, sourceSessionIds: ReadonlyArray<string>, quotes: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const typed: Array<{ readonly session: string; readonly id: string; readonly text: string }> = [];
      for (const sessionId of new Set(sourceSessionIds)) {
        const source = yield* getBySession(sessionId);
        if (source !== undefined) for (const m of typedMessages(yield* readEvents(source.session.id, 0, source.session.head))) typed.push({ session: sessionId, id: m.id, text: m.text });
      }
      const at = new Date().toISOString();
      const rows: Array<UserQuote> = [];
      for (const quote of quotes) {
        // As long as a told note's quote must be (memory/MemoryStore.ts verifiedQuote), and verbatim in one message.
        if (!quotable(quote)) return yield* Effect.fail(new Error(`too short for the user's words: ${JSON.stringify(quote)} (a quote is at least 20 characters and 4 words)`));
        const message = typed.find((m) => m.text.includes(quote));
        if (message === undefined) return yield* Effect.fail(new Error(`not the user's words: ${JSON.stringify(quote.slice(0, 80))} is in none of their messages in that session`));
        rows.push({ workspace_id: workspaceId, quote, source_session: message.session, source_message_id: message.id, at });
      }
      for (const row of rows) {
        yield* sql`INSERT OR IGNORE INTO caveman_sp_workspace_user_quotes (workspace_id, quote, source_session, source_message_id, at)
                   VALUES (${row.workspace_id}, ${row.quote}, ${row.source_session}, ${row.source_message_id}, ${row.at})`.pipe(Effect.orDie);
      }
      return rows;
    });

  return SessionStore.of({
    sql,
    events,
    workspaceChanges,
    putWorkspace,
    getWorkspace: (id) =>
      sql<Row>`SELECT workspace, session, internal FROM caveman_sp_workspaces WHERE id = ${id}`.pipe(Effect.map(one), Effect.orDie),
    getBySession,
    getByThread: (threadId) =>
      sql<Row>`SELECT workspace, session, internal FROM caveman_sp_workspaces WHERE thread_id = ${threadId}`.pipe(Effect.map(one), Effect.orDie),
    listWorkspaces: () =>
      sql<Row>`SELECT workspace, session, internal FROM caveman_sp_workspaces WHERE json_extract(internal, '$.spare') IS NULL ORDER BY created_at DESC`.pipe(
        Effect.map((rows) => rows.map(parseRecord)),
        Effect.orDie,
      ),
    dropSpare: (id) =>
      lane.withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            // Only a spare: a chat workspace.create took is no longer one.
            const rows = yield* sql<Row>`SELECT workspace, session, internal FROM caveman_sp_workspaces
                                         WHERE json_extract(internal, '$.spare') IS NOT NULL AND (${id ?? null} IS NULL OR id = ${id ?? null})`;
            for (const row of rows.map(parseRecord)) {
              yield* sql`DELETE FROM caveman_sp_events WHERE session_id = ${row.session.id}`;
              yield* sql`DELETE FROM caveman_sp_thread_state WHERE thread_id = ${row.internal.threadId}`;
              yield* sql`DELETE FROM caveman_sp_workspaces WHERE id = ${row.workspace.id}`;
            }
          }),
        ).pipe(Effect.orDie),
      ),
    append: (sessionId, build) =>
      transact(
        Effect.gen(function* () {
          const record = yield* getBySession(sessionId);
          if (record === undefined) return yield* Effect.die(new Error(`no session ${sessionId}`));
          const built = yield* build(record);
          const { events: stored, record: next } = yield* appendInTx(built.record ?? record, built.events);
          // What `build` changed, or the events' activity (grill.finished).
          const changed = next.workspace !== record.workspace && JSON.stringify(next.workspace) !== JSON.stringify(record.workspace);
          return { value: { events: stored, value: built.value }, published: stored, changed: changed ? [next.workspace] : [] };
        }),
      ),
    transact,
    resets,
    epochOf,
    crashed,
    cleanStop: Effect.sync(() => {
      if (journaledPath !== undefined) fs.rmSync(journaledPath, { force: true });
      journaled.clear();
    }),
    betweenCommits: (read) => lane.withPermits(1)(read),
    withJournal: (record) => withJournals([record]).pipe(Effect.map((list) => list[0]!)),
    withJournals,
    appendInTx,
    readEvents,
    readEventJson,
    getReceipt: (principal, method, requestId) =>
      sql<{ params_hash: string; result: string }>`SELECT params_hash, result FROM caveman_sp_receipts
        WHERE principal = ${principal} AND method = ${method} AND request_id = ${requestId}
          AND expires_at > ${Date.now()}`.pipe(
        Effect.map((rows) =>
          rows[0] === undefined ? undefined : { paramsHash: rows[0].params_hash, result: JSON.parse(rows[0].result) },
        ),
        Effect.orDie,
      ),
    putReceipt: (principal, method, requestId, receipt, ttlMs) =>
      Effect.gen(function* () {
        yield* sql`DELETE FROM caveman_sp_receipts WHERE expires_at <= ${Date.now()}`;
        yield* sql`INSERT OR REPLACE INTO caveman_sp_receipts (principal, method, request_id, params_hash, result, expires_at)
                   VALUES (${principal}, ${method}, ${requestId}, ${receipt.paramsHash},
                           ${JSON.stringify(receipt.result ?? null)}, ${Date.now() + ttlMs})`;
      }).pipe(Effect.orDie),
    kvGet: (key) =>
      sql<{ value: string }>`SELECT value FROM caveman_sp_kv WHERE key = ${key}`.pipe(
        Effect.map((rows) => rows[0]?.value),
        Effect.orDie,
      ),
    kvSet: (key, value) =>
      sql`INSERT INTO caveman_sp_kv (key, value) VALUES (${key}, ${value})
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`.pipe(Effect.asVoid, Effect.orDie),
    publishWorkspace: (workspace) => PubSub.publish(workspaceChanges, workspace).pipe(Effect.asVoid),
    putQuotes,
    quotes: (workspaceId) =>
      sql<UserQuote>`SELECT workspace_id, quote, source_session, source_message_id, at FROM caveman_sp_workspace_user_quotes
        WHERE workspace_id = ${workspaceId} ORDER BY at, quote`.pipe(Effect.orDie),
  });
});

export const layer = Layer.effect(SessionStore, make);
