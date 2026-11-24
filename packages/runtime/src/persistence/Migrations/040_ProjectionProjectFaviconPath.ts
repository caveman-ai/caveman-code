// ), apps/server/src/persistence/Migrations/040_ProjectionProjectFaviconPath.ts @ ab3a3cd1.
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "favicon_path")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN favicon_path TEXT
    `;
  }
});
