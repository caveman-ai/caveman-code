import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Moves the Session Protocol projector's cursor (session-protocol/store.ts
 * creates the table at startup) to the event log's head, as if it had
 * journaled every event. Event pruning never passes this cursor, so tests of
 * pruning without the Session Protocol store call this first.
 */
export const journalThroughHead = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS caveman_sp_projector (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_sequence INTEGER NOT NULL)
  `;
  yield* journalThrough(
    (yield* sql<{ readonly sequence: number }>`
      SELECT COALESCE(MAX(sequence), 0) AS sequence FROM orchestration_events
    `)[0]?.sequence ?? 0,
  );
});

/** Sets the Session Protocol projector's cursor; the table must exist. */
export const journalThrough = (sequence: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO caveman_sp_projector (id, last_sequence) VALUES (1, ${sequence})
      ON CONFLICT (id) DO UPDATE SET last_sequence = excluded.last_sequence
    `;
  });
