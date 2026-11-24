// Turn telemetry's journal side (docs/ "Where it comes from"). On each
// telemetry.turns ask, the journal rows past this runtime's cursor are folded (turnFacts.ts) into settled turns'
// facts, which wait in caveman_sp_turn_facts until the desktop acknowledges them. Nothing runs between asks: with
// telemetry off nobody asks, and no turn, stream or journal write ever waits on any of it.
import { randomBytes } from "node:crypto";

import type { Session, SessionEvent, TurnFact, Workspace } from "@caveman-app/session-protocol";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import { SessionStore } from "../session-protocol/store.ts";
import { emptyFoldState, fold, settleQuiet, unmet, type ChatInfo, type Fact, type FoldState } from "./turnFacts.ts";

const STATE_KEY = "telemetry_turns_state";
/**
 * Journal rows read at once, and chunks per ask. The reads run on the store's reader, a second connection in a worker
 * thread (NodeSqliteClient.readOnly), so they hold up neither the event loop nor a journal write. What stays on the
 * main thread, parsing and folding a chunk, takes about a millisecond (measured over a real 2 GB journal), and the
 * loop is free between chunks. A backlog is caught up over the next asks.
 */
export const READ = 500;
const CHUNKS = 8;
/** Facts that wait at most; the oldest go first. */
const OUTBOX = 1_000;
/** Facts per answer. */
const ANSWER = 200;

/** The event types the fold reads. Text and reasoning deltas, tool output and diffs never are. */
const TYPES = [
  "turn.started",
  "turn.done",
  "message.done",
  "tool.started",
  "tool.done",
  "subagent.started",
  "subagent.done",
  "ask.user",
  "ask.resolved",
  "plan.updated",
  "usage",
  "context.updated",
  "compaction.done",
  "model.routed",
  "engine.status",
  "error",
  "checkpoint.created",
  "checkpoint.resolved",
  "session.restored",
];

interface Saved extends FoldState {
  /** The disclosure moment this state counts from. */
  readonly since: string;
  /**
   * Hashes the opaque ids, and never leaves. A new one with each new `since`: after telemetry was off, nothing sent
   * links to what was sent before (the desktop starts a new anonymous id too).
   */
  readonly salt: string;
  /** The last journal rowid read. */
  cursor: number;
  /** The last outbox seq given. */
  seq: number;
}

/** Who a chat belongs to, from its workspace (none: a chat deleted since, counted as the person's). */
export const originOf = (workspace: Workspace | undefined): Pick<ChatInfo, "origin" | "pick"> => {
  if (workspace === undefined) return { origin: "person" };
  if (workspace.kind === "chief") return { origin: "chief" };
  if (workspace.kind === "setup") return { origin: "setup" };
  if (workspace.automation !== undefined) return { origin: "automation" };
  if (workspace.runner !== undefined) return { origin: "delegated", pick: workspace.runner.pick.by };
  if (workspace.parent_workspace_id !== undefined) return { origin: "builder" };
  if (workspace.started_by !== undefined) return { origin: "outside_agent" };
  return { origin: "person" };
};

/** The session protocol server's telemetry.turns, over its own store. */
export const makeTurnTelemetry = Effect.gen(function* () {
  const store = yield* SessionStore;
  const sql = store.sql;
  // One ask at a time: two would fold the same rows twice.
  const lane = yield* Semaphore.make(1);

  /**
   * Just before the first turn that started at or after `since`, or its prompt (a new chat's is journaled before its
   * turn starts); the journal's end when neither is there yet. Both through the (type, at) index.
   */
  const startOf = (since: string) =>
    Effect.gen(function* () {
      const [first] = yield* sql<{ rowid: number | null }>`SELECT min(rowid) AS rowid FROM caveman_sp_events
        WHERE type IN ('turn.started', 'message.done') AND at >= ${since}`;
      if (first?.rowid != null) return first.rowid - 1;
      const [last] = yield* sql<{ rowid: number | null }>`SELECT max(rowid) AS rowid FROM caveman_sp_events`;
      return last?.rowid ?? 0;
    }).pipe(NodeSqliteClient.readOnly);

  /**
   * The rows past `cursor`, only the types the fold reads, with what it never reads dropped by SQLite before
   * JavaScript sees them: a tool's input and output, a reply's text, an attachment's bytes, a question's text.
   * `+type` keeps SQLite on the rowid range: through the (type, at) index it would scan every row of these types in
   * the journal on every ask, however few are new. A reply (megabytes, at times) is skipped by its first bytes, as
   * store.ts writes them, before SQLite parses it; one written otherwise is parsed and dropped as before.
   */
  const read = (cursor: number) =>
    sql<{ rowid: number; event: string }>`SELECT rowid, CASE type
        WHEN 'tool.started' THEN json_remove(event, '$.payload.input', '$.payload.files', '$.payload.title', '$.payload.name')
        WHEN 'tool.done' THEN json_remove(event, '$.payload.result', '$.payload.error')
        WHEN 'subagent.started' THEN json_remove(event, '$.payload.title')
        WHEN 'subagent.done' THEN json_remove(event, '$.payload.summary')
        WHEN 'ask.user' THEN json_remove(event, '$.payload.questions', '$.payload.detail', '$.payload.reason', '$.payload.input')
        WHEN 'engine.status' THEN json_remove(event, '$.payload.message')
        WHEN 'error' THEN json_remove(event, '$.payload.message')
        WHEN 'message.done' THEN CASE WHEN json_extract(event, '$.payload.role') = 'user'
          THEN json_set(event, '$.payload.attachments', json((SELECT json_group_array(json_object('type', json_extract(a.value, '$.type')))
            FROM json_each(event, '$.payload.attachments') AS a)))
          ELSE json_remove(event, '$.payload.text') END
        ELSE event END AS event
      FROM caveman_sp_events WHERE rowid > ${cursor} AND +type IN ${sql.in(TYPES)}
        AND NOT (type = 'message.done' AND substr(event, 1, 1000) LIKE '%"type":"message.done","payload":{"role":"assistant"%')
        ORDER BY rowid LIMIT ${READ}`.pipe(NodeSqliteClient.readOnly);

  /** Past the next READ rows, whatever they hold: where a chunk SQLite could not read ends. */
  const skipChunk = (cursor: number) =>
    sql<{ rowid: number | null }>`SELECT max(rowid) AS rowid FROM (SELECT rowid FROM caveman_sp_events WHERE rowid > ${cursor} ORDER BY rowid LIMIT ${READ})`.pipe(
      NodeSqliteClient.readOnly,
      Effect.map(([row]) => row?.rowid ?? undefined),
    );

  /** Each chat the fold has not met: its workspace's say, its turns and context fill before `cursor`. */
  const lookUp = (chats: ReadonlyMap<string, number>) =>
    Effect.gen(function* () {
      const infos = new Map<string, ChatInfo>();
      if (chats.size === 0) return infos;
      const records = yield* sql<{ session_id: string; workspace: string; session: string }>`SELECT session_id, workspace, session
        FROM caveman_sp_workspaces WHERE session_id IN ${sql.in([...chats.keys()])}`;
      const bySession = new Map(records.map((r) => [r.session_id, r]));
      for (const [sessionId, cursor] of chats) {
        const record = bySession.get(sessionId);
        const workspace = record === undefined ? undefined : (JSON.parse(record.workspace) as Workspace);
        const session = record === undefined ? undefined : (JSON.parse(record.session) as Session);
        const [turns] = yield* sql<{ n: number }>`SELECT count(*) AS n FROM caveman_sp_events
          WHERE session_id = ${sessionId} AND type = 'turn.started' AND cursor < ${cursor}`;
        const [context] = yield* sql<{ used: number | null; win: number | null }>`SELECT json_extract(event, '$.payload.used_tokens') AS used,
            json_extract(event, '$.payload.window_tokens') AS win FROM caveman_sp_events
          WHERE session_id = ${sessionId} AND type = 'context.updated' AND cursor < ${cursor} ORDER BY cursor DESC LIMIT 1`;
        infos.set(sessionId, {
          ...originOf(workspace),
          ...(session?.forked_from === undefined ? {} : { copiedThrough: session.forked_from.cursor }),
          turns: turns?.n ?? 0,
          ...(context?.used == null || context.win == null ? {} : { context: [context.used, context.win] as const }),
        });
      }
      return infos;
    }).pipe(NodeSqliteClient.readOnly);

  /** One chunk: its rows, and where the cursor goes next (undefined: nothing past it). */
  const chunkAt = (cursor: number) =>
    read(cursor).pipe(
      Effect.map((rows) => ({ rows, past: rows.at(-1)?.rowid, full: rows.length === READ })),
      // Rows SQLite cannot read (JSON it cannot parse): skip a chunk's worth rather than stop turn stats for good.
      Effect.catch((error) =>
        Effect.logWarning("Turn telemetry skipped journal rows it could not read", error).pipe(
          Effect.andThen(skipChunk(cursor)),
          Effect.map((past) => ({ rows: [] as ReadonlyArray<{ readonly rowid: number; readonly event: string }>, past, full: past !== undefined })),
        ),
      ),
    );

  /** telemetry.turns (protocol.ts): acknowledge, fold what the journal gained, answer what waits. */
  const take = (params: { readonly since: string; readonly ack?: number | undefined }, now: number = Date.now()) =>
    lane.withPermits(1)(
      Effect.gen(function* () {
        const raw = yield* store.kvGet(STATE_KEY);
        const before = raw === undefined ? undefined : (JSON.parse(raw) as Saved);
        let saved: Saved;
        if (before !== undefined && before.since === params.since && typeof before.salt === "string") saved = before;
        else {
          // A new disclosure moment: count from its first turn with a new salt, and drop what waited from before it
          // (telemetry was off in between). The seq goes on, so a late ack of an old one never drops a new fact.
          saved = { ...emptyFoldState(), since: params.since, salt: randomBytes(32).toString("hex"), cursor: yield* startOf(params.since), seq: before?.seq ?? 0 };
          yield* sql`DELETE FROM caveman_sp_turn_facts`;
        }
        if (params.ack !== undefined) yield* sql`DELETE FROM caveman_sp_turn_facts WHERE seq <= ${params.ack}`;

        const facts: Array<Fact> = [];
        let end = false;
        for (let chunk = 0; chunk < CHUNKS && !end; chunk++) {
          if (chunk > 0) yield* Effect.sleep("2 millis");
          const { rows, past, full } = yield* chunkAt(saved.cursor);
          const events = rows.flatMap((row) => {
            try {
              return [JSON.parse(row.event) as SessionEvent];
            } catch {
              return [];
            }
          });
          const infos = yield* lookUp(unmet(saved, events));
          facts.push(...fold(saved, events, { since: params.since, salt: saved.salt, info: (id) => infos.get(id) }));
          saved.cursor = past ?? saved.cursor;
          end = !full;
        }
        // Quiet chats settle only once the journal is read to its end: a backlog may still hold their next turn.
        if (end) facts.push(...settleQuiet(saved, now));

        yield* sql.withTransaction(
          Effect.gen(function* () {
            for (const fact of facts) {
              saved.seq += 1;
              yield* sql`INSERT INTO caveman_sp_turn_facts (seq, fact) VALUES (${saved.seq}, ${JSON.stringify({ seq: saved.seq, ...fact })})`;
            }
            yield* sql`DELETE FROM caveman_sp_turn_facts WHERE seq <= ${saved.seq - OUTBOX}`;
            yield* store.kvSet(STATE_KEY, JSON.stringify(saved));
          }),
        );
        const waiting = yield* sql<{ fact: string }>`SELECT fact FROM caveman_sp_turn_facts ORDER BY seq LIMIT ${ANSWER}`;
        return { facts: waiting.map((row) => JSON.parse(row.fact) as TurnFact) };
      }).pipe(Effect.orDie),
    );

  return { take };
});
