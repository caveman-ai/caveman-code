// Ours, not a T3 port: the runs a schedule itself started since it last changed, which a schedule's
// maxRuns counts. Existing rows start at 0; none of them has a maxRuns, so none stops early.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN scheduled_run_count INTEGER NOT NULL DEFAULT 0`;
});
