import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Org workloads on a Cloud computer (cloudLink/eventOutbox.ts): the sessions Cloud started here without a person
// (origin api or automation), and the public events each one still has to post, numbered by its own seq. Rows
// leave the outbox only once Cloud has them, so a restart posts what the last run could not.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_sessions (
      session_id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      local_session_id TEXT NOT NULL UNIQUE,
      origin TEXT NOT NULL,
      start_json TEXT NOT NULL,
      next_seq INTEGER NOT NULL,
      mapped_through INTEGER NOT NULL,
      mapper_state TEXT NOT NULL,
      pull_request TEXT,
      outputs_json TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_session_outbox (
      session_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (session_id, seq)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS cloud_session_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      span TEXT NOT NULL
    )
  `;
});
