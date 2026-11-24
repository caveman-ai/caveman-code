// ), apps/server/src/persistence/Sqlite.test.ts @ ab3a3cd1; perf from eb1d80c667.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@caveman-app/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";

import { WAL_SIZE_LIMIT_BYTES } from "./Sqlite.ts";
import * as SqlitePersistence from "./Sqlite.ts";

const lockHolderSource = `
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("BEGIN IMMEDIATE");
process.stdout.write("locked\\n");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, Number(process.argv[2]));
`;

const spawnWriteLockHolder = (dbPath: string, holdMs: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const holder = NodeChildProcess.spawn(
          process.execPath,
          ["-e", lockHolderSource, dbPath, String(holdMs)],
          { stdio: ["ignore", "pipe", "ignore"] },
        );
        holder.stdout.once("data", () => resolve());
        holder.on("error", reject);
        holder.on("exit", () =>
          reject(new Error("lock holder exited before acquiring the write lock")),
        );
      }),
  );

it.effect("waits out a concurrent writer instead of failing with SQLITE_BUSY", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-busy-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE busy_probe(id INTEGER PRIMARY KEY)`;
    yield* spawnWriteLockHolder(dbPath, 300);
    yield* sql`INSERT INTO busy_probe(id) VALUES (${1})`;
    const rows = yield* sql<{ readonly id: number }>`SELECT id FROM busy_probe`;
    assert.deepEqual([...rows], [{ id: 1 }]);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("limits the WAL file size in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly journal_size_limit: number }>`PRAGMA journal_size_limit`;
    assert.equal(rows[0]?.journal_size_limit, WAL_SIZE_LIMIT_BYTES);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// Linux names an open, already-deleted file "<path> (deleted)" in /proc/self/fd.
// SQLite names its temp files "etilqs_*" and, without TMPDIR, puts them in
// /var/tmp while os.tmpdir() is /tmp, so match the name, not the directory.
const openDeletedTempFiles = () =>
  NodeFS.readdirSync("/proc/self/fd").flatMap((fd) => {
    try {
      const target = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
      return target.includes("/etilqs_") && target.endsWith(" (deleted)") ? [target] : [];
    } catch {
      return [];
    }
  });

it.effect.skipIf(HostProcess.Platform.defaultValue() !== "linux")(
  "keeps a write transaction's statement journal off the temp directory",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-temp-"));
    const persistence = SqlitePersistence.layerFromPath(
      NodePath.join(tempDir, "state.sqlite"),
    ).pipe(Layer.provide(NodeServices.layer));

    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE journal_probe(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)`;
      for (let id = 0; id < 64; id++) {
        yield* sql`INSERT INTO journal_probe VALUES (${id}, ${"x".repeat(4096)})`;
      }
      const before = new Set(openDeletedTempFiles());
      const opened = yield* sql.withTransaction(
        Effect.gen(function* () {
          // A multi-row update can fail halfway, so SQLite journals every page
          // it changes, here well past the 64 KiB it holds in memory by default.
          yield* sql`UPDATE journal_probe SET payload = payload || 'y'`;
          return openDeletedTempFiles().filter((target) => !before.has(target));
        }),
      );
      assert.deepEqual(opened, []);
    }).pipe(
      Effect.provide(persistence),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);

it.effect("drops planner statistics a database already has", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-stats-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const persistence = () =>
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));

  return Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`CREATE TABLE walk_probe(node_id TEXT PRIMARY KEY, parent_node_id TEXT)`;
      yield* sql`INSERT INTO walk_probe VALUES ('node-1', NULL), ('node-2', 'node-1')`;
      // Stats from a nearly empty table, as an older build collected on a new install.
      yield* sql`ANALYZE walk_probe`;
    }).pipe(Effect.provide(persistence()));

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const stats = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM sqlite_stat1
      `;
      assert.equal(stats[0]?.count, 0);
      // A connection still using the old stats scans the table at each step.
      const plan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        WITH RECURSIVE retained(node_id) AS (
          SELECT 'node-2'
          UNION
          SELECT parent.parent_node_id FROM walk_probe AS parent
          INNER JOIN retained ON parent.node_id = retained.node_id
        )
        SELECT node_id FROM retained
      `;
      assert.include(
        plan.map((row) => row.detail),
        "SEARCH parent USING INDEX sqlite_autoindex_walk_probe_1 (node_id=?)",
      );
    }).pipe(Effect.provide(persistence()));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("only fsyncs the database file at WAL checkpoints", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-sync-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly synchronous: number }>`PRAGMA synchronous`;
    // 1 is NORMAL.
    assert.equal(rows[0]?.synchronous, 1);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("applies busy_timeout in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly timeout: number }>`PRAGMA busy_timeout`;
    assert.equal(rows[0]?.timeout, 5000);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("enables checkpoint_fullfsync in the shared persistence setup", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      readonly checkpoint_fullfsync: number;
    }>`PRAGMA checkpoint_fullfsync`;
    assert.equal(rows[0]?.checkpoint_fullfsync, 1);
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

// A database created before new ones got incremental auto_vacuum: WAL mode, auto_vacuum NONE.
const writeLegacyDatabase = (dbPath: string) => {
  const db = new NodeSqlite.DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("CREATE TABLE kept(value TEXT)");
  db.exec("INSERT INTO kept VALUES ('keep')");
  db.exec("CREATE TABLE churn(value BLOB)");
  db.exec("INSERT INTO churn VALUES (zeroblob(1048576))");
  db.exec("DELETE FROM churn");
  const mode = db.prepare("PRAGMA auto_vacuum").get() as { auto_vacuum: number };
  db.close();
  return mode.auto_vacuum;
};

it.effect("switches a database from before incremental auto_vacuum on open, keeping its rows", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-vacuum-"));
  const dbPath = NodePath.join(tempDir, "statev2.sqlite");
  const legacyMode = writeLegacyDatabase(dbPath);

  return Effect.gen(function* () {
    assert.equal(legacyMode, 0);
    const sql = yield* SqlClient.SqlClient;
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 2 }]);
    assert.deepEqual(yield* sql`SELECT value FROM kept`, [{ value: "keep" }]);
    // The rebuild already dropped the freed megabyte (256 pages); a migration that drops an
    // index after it (073) frees a page or two, which the minute's reclaim returns.
    const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
    assert.isBelow(free[0]?.freelist_count ?? Infinity, 8);
  }).pipe(
    Effect.provide(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("leaves a database over the size cap as it is", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sqlite-vacuum-big-"));
  const dbPath = NodePath.join(tempDir, "statev2.sqlite");
  writeLegacyDatabase(dbPath);

  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const outcome = yield* SqlitePersistence.convertToIncrementalAutoVacuum(1024);
    assert.equal(outcome, "too_large");
    assert.deepEqual(yield* sql`PRAGMA auto_vacuum`, [{ auto_vacuum: 0 }]);
    assert.deepEqual(yield* sql`SELECT value FROM kept`, [{ value: "keep" }]);
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: dbPath })),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
