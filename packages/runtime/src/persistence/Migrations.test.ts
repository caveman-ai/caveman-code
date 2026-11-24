// ), apps/server/src/persistence/Migrations.test.ts @ ab3a3cd1.
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { SERVER_EXIT_CODE_DATABASE_NEWER } from "@caveman-app/protocol";
import * as Runtime from "effect/Runtime";

import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import {
  DatabaseNewerThanRuntime,
  migrationEntries,
  migrationManifest,
  runMigrations,
} from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
/** This build's newest migration: a database may record it under another name (a fork or local build). */
const latestMigrationId = Math.max(...migrationManifest.map(([id]) => id));
/** A migration only a newer build has. */
const newerMigrationId = latestMigrationId + 1;

const tableNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    readonly name: string;
  }>`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`;
  return rows.map((row) => row.name);
});

// PR #27's migration, which its branch numbers 66.
const AuthSessionRuntimeModeCeiling = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  if (!columns.some((column) => column.name === "runtime_mode_ceiling")) {
    yield* sql`ALTER TABLE auth_sessions ADD COLUMN runtime_mode_ceiling TEXT`;
  }
});

/** Runs `use` as a build whose manifest also has AuthSessionRuntimeModeCeiling at `id`. */
const withAuthSessionRuntimeModeCeilingAt = <A, E, R>(id: number, use: Effect.Effect<A, E, R>) => {
  const entries = migrationEntries as unknown as Array<readonly [number, string, unknown]>;
  return Effect.acquireUseRelease(
    Effect.sync(() => {
      const later = entries.findIndex(([entryId]) => entryId > id);
      const index = later === -1 ? entries.length : later;
      entries.splice(index, 0, [
        id,
        "AuthSessionRuntimeModeCeiling",
        AuthSessionRuntimeModeCeiling,
      ]);
      return index;
    }),
    () => use,
    (index) => Effect.sync(() => entries.splice(index, 1)),
  );
};

const authSessionColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`PRAGMA table_info(auth_sessions)`;
  return rows.map((row) => row.name);
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("migrates a fresh database through the whole manifest", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      // This build's newest id, taken by another build's migration (a later one is DatabaseNewerThanRuntime's).
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${latestMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations.slice(0, -1)) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      const [lastId, lastName] = v2Migrations.at(-1)!;
      assert.include(String(exit), `${lastId}_${lastName} (recorded: FutureMainMigration)`);
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${latestMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  // T3 lets an older build start on a newer build's database; we refuse (a nightly's database under a stable build).
  it.effect(
    "refuses a database a newer build migrated, naming both versions, and changes nothing",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;
        const before = { history: yield* history, tables: yield* tableNames };

        const error = yield* Effect.flip(runMigrations());

        assert.instanceOf(error, DatabaseNewerThanRuntime);
        const refused = error as DatabaseNewerThanRuntime;
        assert.deepInclude(refused, {
          databaseMigration: newerMigrationId,
          databaseVersion: undefined,
          runtimeMigration: latestMigrationId,
          runtimeVersion: RUNTIME_VERSION,
        });
        assert.strictEqual(
          refused.message,
          `This database was last used by a newer Caveman Code (migration ${newerMigrationId}); this runtime is ${RUNTIME_VERSION} (migration ${latestMigrationId}) and won't open it. Update Caveman Code; nothing was changed.`,
        );
        // What the desktop reads: the exit code, and the name a log line starts with.
        assert.strictEqual(refused[Runtime.errorExitCode], SERVER_EXIT_CODE_DATABASE_NEWER);
        assert.strictEqual(refused.name, "DatabaseNewerThanRuntime");
        assert.isTrue(String(refused).startsWith("DatabaseNewerThanRuntime: This database"));
        assert.deepStrictEqual({ history: yield* history, tables: yield* tableNames }, before);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("names the newer build when it recorded itself at that migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      // What a newer build (one that knows its version) leaves after it migrates.
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${newerMigrationId}, 'NewerV2Migration')`;
      yield* sql`CREATE TABLE IF NOT EXISTS caveman_database_writers (migration_id INTEGER PRIMARY KEY, version TEXT NOT NULL)`;
      yield* sql`INSERT INTO caveman_database_writers (migration_id, version) VALUES (${latestMigrationId}, '0.4.2'), (${newerMigrationId}, '0.4.3-nightly.20261109.12')`;

      const error = (yield* Effect.flip(runMigrations())) as DatabaseNewerThanRuntime;

      assert.strictEqual(error.databaseVersion, "0.4.3-nightly.20261109.12");
      assert.include(
        error.message,
        `This database was last used by Caveman Code 0.4.3-nightly.20261109.12 (migration ${newerMigrationId}); this runtime is ${RUNTIME_VERSION}`,
      );
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a build that doesn't know its version (from source) records nothing", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      assert.strictEqual(RUNTIME_VERSION, "0.0.0");
      assert.notInclude(yield* tableNames, "caveman_database_writers");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses a migration at a retired id, even on a fresh database", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const exit = yield* Effect.exit(withAuthSessionRuntimeModeCeilingAt(66, runMigrations()));

      assert.isTrue(Exit.isFailure(exit), "the build started on a fresh database");
      assert.include(String(exit), "66_AuthSessionRuntimeModeCeiling");
      assert.include(String(exit), `take ${newerMigrationId}`);
      const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table'`;
      assert.deepStrictEqual(tables, []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("a migration added after the latest runs on a database this build wrote", () =>
    Effect.gen(function* () {
      yield* runMigrations();

      assert.deepStrictEqual(
        yield* withAuthSessionRuntimeModeCeilingAt(newerMigrationId, runMigrations()),
        [[newerMigrationId, "AuthSessionRuntimeModeCeiling"]],
      );
      assert.include(yield* authSessionColumns, "runtime_mode_ceiling");
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
