import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The work time a run has used of its deadline (SEMANTICS §10.2, automations/runner.ts deadlineOf), so a runtime
// restart goes on from it instead of giving the run a new deadline.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE automation_runs ADD COLUMN worked_ms INTEGER NOT NULL DEFAULT 0`;
});
