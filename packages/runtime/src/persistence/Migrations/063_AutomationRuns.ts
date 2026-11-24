import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Automation runs (automations/journal.ts): one row per run, its append-only journal (SEMANTICS §11.1),
// and the threads its steps and checks run in, which the Session Protocol projector adopts as workspaces.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_runs (
      run_id TEXT PRIMARY KEY,
      automation_id TEXT NOT NULL,
      automation TEXT NOT NULL,
      project_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      concurrency_key TEXT NOT NULL,
      revision_digest TEXT NOT NULL,
      revision_json TEXT NOT NULL,
      trigger_json TEXT NOT NULL,
      inputs_json TEXT,
      apply INTEGER NOT NULL,
      status TEXT NOT NULL,
      reason TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      wallet_json TEXT NOT NULL,
      spent_json TEXT,
      steps_json TEXT NOT NULL,
      branch TEXT,
      head TEXT,
      worktree TEXT,
      base_json TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_runs_automation ON automation_runs(automation_id, started_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_runs_project ON automation_runs(project_id, started_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_runs_status ON automation_runs(status)`;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_run_events (
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (run_id, seq)
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS automation_run_threads (
      thread_id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      automation TEXT NOT NULL,
      step TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      check_index INTEGER
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS automation_run_threads_run ON automation_run_threads(run_id)`;
});
