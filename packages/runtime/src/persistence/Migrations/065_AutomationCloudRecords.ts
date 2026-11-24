import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// A Cloud-hosted automation run's record (automations/cloudHost.ts), owed to Cloud's POST /runtime/runs until Cloud
// takes it: written before the first try, removed once Cloud answers, so a restart sends what the last one could not
// (CORRECTNESS H2). A run that never started has a row too: its failed record.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_cloud_records (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      body_json TEXT NOT NULL,
      owed_at TEXT NOT NULL,
      tries INTEGER NOT NULL DEFAULT 0,
      last_error TEXT
    )
  `;
});
