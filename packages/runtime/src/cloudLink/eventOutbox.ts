// The outbox of an org workload's public events (CONTRACT §3.4). Mapped events are numbered with the session's
// own seq and kept in SQLite (migration 064) in the same write that records how far the session's journal was
// mapped and the mapper's state, so nothing is mapped twice or lost when the runtime restarts. A sender posts them
// in seq order, at most 256 KiB a request, and drops them only once Cloud answered; Cloud keeps each seq once, so
// a batch sent again after a crash changes nothing. Every event goes through the egress scrub before it leaves.
import type { Scrubber } from "@caveman-app/session-protocol";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { maskEnd } from "../session-protocol/secrets.ts";
import { CUT_FIELDS, initialMapperState, type MapperState, type PublicEvent, type SessionOrigin } from "./publicEvents.ts";
import type { PostedEvent, SessionStartPayload } from "./sessions.ts";
import type { OtlpSpan } from "./traces.ts";

/** One request holds at most this much JSON (§3.4). */
export const BATCH_MAX_BYTES = 256 * 1024;
/** A batch waits at most this long for more events (§3.4). */
export const BATCH_WAIT_MS = 250;
/** Room for the request's own JSON around its events. */
const ENVELOPE_BYTES = 64;

/** A session Cloud started on this computer without a person, as kept here. */
export interface CloudSessionRow {
  /** Cloud's session id: its events go to /runtime/sessions/<id>/events. */
  readonly sessionId: string;
  /** Cloud's workspace id: its run state goes to /runtime/workspaces/<id>/run-state. */
  readonly workspaceId: string;
  /**
   * The local session (Session Protocol) it runs as; `automation:<id>` for one the automation runner holds,
   * `pending:<id>` while its start is under way (a redelivered start resumes it), `none:<id>` for one that failed.
   */
  readonly localSessionId: string;
  /** api or automation (an org workload, whose events and traces go to Cloud), or person (nothing goes). */
  readonly origin: SessionOrigin | "person";
  readonly start: SessionStartPayload;
  readonly nextSeq: number;
  /** The local session's events up to this cursor are mapped. */
  readonly mappedThrough: number;
  readonly state: MapperState;
  /** The pull request last reported (pullRequestEvent's key). */
  readonly pullRequest: string | undefined;
  /** Outputs already uploaded: path -> sha256. */
  readonly outputs: Readonly<Record<string, string>>;
}

interface RawRow {
  readonly session_id: string;
  readonly workspace_id: string;
  readonly local_session_id: string;
  readonly origin: string;
  readonly start_json: string;
  readonly next_seq: number;
  readonly mapped_through: number;
  readonly mapper_state: string;
  readonly pull_request: string | null;
  readonly outputs_json: string | null;
}

const rowOf = (raw: RawRow): CloudSessionRow => ({
  sessionId: raw.session_id,
  workspaceId: raw.workspace_id,
  localSessionId: raw.local_session_id,
  origin: raw.origin as SessionOrigin | "person",
  start: JSON.parse(raw.start_json) as SessionStartPayload,
  nextSeq: raw.next_seq,
  mappedThrough: raw.mapped_through,
  state: JSON.parse(raw.mapper_state) as MapperState,
  pullRequest: raw.pull_request ?? undefined,
  outputs: raw.outputs_json ? (JSON.parse(raw.outputs_json) as Record<string, string>) : {},
});

export const makeOutbox = (sql: SqlClient.SqlClient) => {
  const orDie = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.orDie(effect);

  /** Records a session Cloud started here; a second start of the same session keeps the first. */
  const register = (input: { readonly sessionId: string; readonly workspaceId: string; readonly localSessionId: string; readonly origin: SessionOrigin | "person"; readonly start: SessionStartPayload }) =>
    orDie(
      sql`INSERT INTO cloud_sessions (session_id, workspace_id, local_session_id, origin, start_json, next_seq, mapped_through, mapper_state, created_at)
          VALUES (${input.sessionId}, ${input.workspaceId}, ${input.localSessionId}, ${input.origin}, ${JSON.stringify(input.start)}, 1, 0,
                  ${JSON.stringify(initialMapperState())}, ${new Date().toISOString()})
          ON CONFLICT (session_id) DO NOTHING`,
    ).pipe(Effect.asVoid);

  /** The local session a registered one now runs as (a pending start that made its workspace, or one that failed). */
  const adopt = (sessionId: string, localSessionId: string) =>
    orDie(sql`UPDATE cloud_sessions SET local_session_id = ${localSessionId} WHERE session_id = ${sessionId}`).pipe(Effect.asVoid);

  const all = orDie(sql<RawRow>`SELECT * FROM cloud_sessions ORDER BY created_at`).pipe(Effect.map((rows) => rows.map(rowOf)));
  const byCloudId = (sessionId: string) =>
    orDie(sql<RawRow>`SELECT * FROM cloud_sessions WHERE session_id = ${sessionId}`).pipe(Effect.map((rows) => (rows[0] ? rowOf(rows[0]) : undefined)));
  const byLocal = (localSessionId: string) =>
    orDie(sql<RawRow>`SELECT * FROM cloud_sessions WHERE local_session_id = ${localSessionId}`).pipe(Effect.map((rows) => (rows[0] ? rowOf(rows[0]) : undefined)));
  const byWorkspace = (workspaceId: string) =>
    orDie(sql<RawRow>`SELECT * FROM cloud_sessions WHERE workspace_id = ${workspaceId}`).pipe(Effect.map((rows) => (rows[0] ? rowOf(rows[0]) : undefined)));

  /**
   * Queues `events` with the next seqs and records, in the same transaction, how far the journal was mapped and the
   * mapper's state after it. Answers the events as numbered.
   */
  const enqueue = (
    sessionId: string,
    events: ReadonlyArray<PublicEvent>,
    progress: { readonly mappedThrough?: number; readonly state?: MapperState; readonly pullRequest?: string; readonly outputs?: Record<string, string>; readonly spans?: ReadonlyArray<OtlpSpan> } = {},
  ) =>
    orDie(
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<RawRow>`SELECT * FROM cloud_sessions WHERE session_id = ${sessionId}`;
          const row = rows[0];
          if (row === undefined) return [] as Array<PostedEvent>;
          let seq = row.next_seq;
          const numbered: Array<PostedEvent> = [];
          for (const event of events) {
            const posted = { seq: seq++, type: event.type, created_at: event.created_at, data: event.data };
            numbered.push(posted);
            yield* sql`INSERT INTO cloud_session_outbox (session_id, seq, type, created_at, data) VALUES (${sessionId}, ${posted.seq}, ${posted.type}, ${posted.created_at}, ${JSON.stringify(posted.data)})`;
          }
          for (const span of progress.spans ?? []) yield* sql`INSERT INTO cloud_session_spans (session_id, span) VALUES (${sessionId}, ${JSON.stringify(span)})`;
          yield* sql`UPDATE cloud_sessions SET
              next_seq = ${seq},
              mapped_through = ${Math.max(row.mapped_through, progress.mappedThrough ?? 0)},
              mapper_state = ${progress.state === undefined ? row.mapper_state : JSON.stringify(progress.state)},
              pull_request = ${progress.pullRequest ?? row.pull_request},
              outputs_json = ${progress.outputs === undefined ? row.outputs_json : JSON.stringify(progress.outputs)}
            WHERE session_id = ${sessionId}`;
          return numbered;
        }),
      ),
    );

  /** The oldest queued events of a session, in seq order. */
  const pending = (sessionId: string, limit = 500) =>
    orDie(
      sql<{ seq: number; type: string; created_at: string; data: string }>`SELECT seq, type, created_at, data FROM cloud_session_outbox
        WHERE session_id = ${sessionId} ORDER BY seq LIMIT ${limit}`,
    ).pipe(Effect.map((rows) => rows.map((r): PostedEvent => ({ seq: r.seq, type: r.type, created_at: r.created_at, data: JSON.parse(r.data) }))));

  const sessionsWithPending = orDie(sql<{ session_id: string }>`SELECT DISTINCT session_id FROM cloud_session_outbox`).pipe(Effect.map((rows) => rows.map((r) => r.session_id)));

  /** Finished trace spans (queued with enqueue), kept until Cloud has them. */
  const pendingSpans = (sessionId: string, limit = 200) =>
    orDie(sql<{ id: number; span: string }>`SELECT id, span FROM cloud_session_spans WHERE session_id = ${sessionId} ORDER BY id LIMIT ${limit}`).pipe(
      Effect.map((rows) => rows.map((r) => ({ id: r.id, span: JSON.parse(r.span) as OtlpSpan }))),
    );
  const sessionsWithSpans = orDie(sql<{ session_id: string }>`SELECT DISTINCT session_id FROM cloud_session_spans`).pipe(Effect.map((rows) => rows.map((r) => r.session_id)));
  const postedSpans = (sessionId: string, throughId: number) => orDie(sql`DELETE FROM cloud_session_spans WHERE session_id = ${sessionId} AND id <= ${throughId}`).pipe(Effect.asVoid);

  /** Cloud has every event through `seq`. */
  const posted = (sessionId: string, seq: number) => orDie(sql`DELETE FROM cloud_session_outbox WHERE session_id = ${sessionId} AND seq <= ${seq}`).pipe(Effect.asVoid);

  return { register, adopt, all, byCloudId, byLocal, byWorkspace, enqueue, pending, sessionsWithPending, posted, pendingSpans, sessionsWithSpans, postedSpans };
};
export type Outbox = ReturnType<typeof makeOutbox>;

const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

/** A field of an event at most this long names it (an ask's id and kind, a tool's name, a result's tool_use_id). */
const NAME_MAX_BYTES = 1024;

/**
 * An event too big for one request on its own: every long text in it cut, saying so. When that is still too big (many
 * long texts, or thousands of rows), only the fields that name the event go: an ask without its input can still be
 * answered, and one without its id never can.
 */
export function fitEvent(event: PostedEvent, max = BATCH_MAX_BYTES - ENVELOPE_BYTES): PostedEvent {
  if (jsonBytes(event) <= max) return event;
  const room = Math.floor(max / 4);
  const shrink = (value: unknown): unknown => {
    if (typeof value === "string") return Buffer.byteLength(value, "utf8") > room ? Buffer.from(value, "utf8").subarray(0, room).toString("utf8").replace(/�+$/, "") : value;
    if (Array.isArray(value)) return value.map(shrink);
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shrink(v)]));
    return value;
  };
  const shrunk = { ...event, data: { ...(shrink(event.data) as Record<string, unknown>), truncated: true } };
  if (jsonBytes(shrunk) <= max) return shrunk;
  const named = { ...event, data: { ...Object.fromEntries(Object.entries(event.data as Record<string, unknown>).filter(([, v]) => jsonBytes(v) <= NAME_MAX_BYTES)), truncated: true } };
  return jsonBytes(named) <= max ? named : { ...event, data: { truncated: true } };
}

/**
 * An event's data with every secret value masked, also the start of one the mapper's cut fell inside (publicEvents
 * CUT_FIELDS): the cut leaves no marker, and a whole-value scrub cannot recognise a value's start.
 */
function scrubData(data: unknown, scrubber: Scrubber): unknown {
  const scrubbed = scrubber.scrubDeep(data);
  if (typeof data !== "object" || data === null || (data as { truncated?: unknown }).truncated !== true) return scrubbed;
  const ends = CUT_FIELDS.flatMap((field) => {
    const text = (data as Record<string, unknown>)[field];
    return typeof text === "string" ? [[field, maskEnd(scrubber, text)] as const] : [];
  });
  return { ...(scrubbed as Record<string, unknown>), ...Object.fromEntries(ends) };
}

/** Queued events as requests: scrubbed, in seq order, each request at most 256 KiB. */
export function batchesOf(events: ReadonlyArray<PostedEvent>, scrubber: Scrubber, max = BATCH_MAX_BYTES): Array<Array<PostedEvent>> {
  const out: Array<Array<PostedEvent>> = [];
  let batch: Array<PostedEvent> = [];
  let size = ENVELOPE_BYTES;
  for (const raw of events) {
    const event = fitEvent({ ...raw, data: scrubData(raw.data, scrubber) }, max - ENVELOPE_BYTES);
    const bytes = jsonBytes(event) + 1;
    if (batch.length > 0 && size + bytes > max) {
      out.push(batch);
      batch = [];
      size = ENVELOPE_BYTES;
    }
    batch.push(event);
    size += bytes;
  }
  if (batch.length > 0) out.push(batch);
  return out;
}
