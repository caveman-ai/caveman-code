// @effect-diagnostics nodeBuiltinImport:off
/**
 * Model check of database upgrades. How to run it, read a failure, and change it: .claude/skills/migration-upgrade.
 *
 * The databases users hold are built with the real migrations and driven through the real startup code:
 * - every recorded prefix of the manifest and the three V2 preview histories upgrade, on Sqlite.layerFromPath, to the
 *   schema of a fresh install and keep their rows;
 * - a run that fails at a SQL statement leaves the database where it started, at the committed preview reconcile, or
 *   fully migrated, and the next app start completes;
 * - a database a newer build migrated (any id past this build's newest) is refused as such, unchanged;
 * - the V2 ledger guard refuses exactly the other histories on which the Effect migrator would skip a V2 migration;
 * - released prefixes still build the schema their release shipped, and the manifest's holes stay the known ones.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { canonicalKey, crashPoints } from "@caveman-app/model-check";
import * as NodeSqliteClient from "@caveman-app/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as References from "effect/References";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as Statement from "effect/sql/Statement";
import type * as Tracer from "effect/Tracer";

import {
  DatabaseNewerThanRuntime,
  migrationEntries,
  migrationManifest,
  retiredMigrationIds,
  runMigrations,
} from "./Migrations.ts";
import PullRequestFilesViewed from "./Migrations/053_PullRequestFilesViewed.ts";
import OrchestrationV2 from "./Migrations/055_OrchestrationV2.ts";
import RemoveRedundantProjectionIndexes from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";
import * as SqlitePersistence from "./Sqlite.ts";

type Ledger = ReadonlyArray<readonly [number, string]>;

const manifestIds: ReadonlyArray<number> = migrationManifest.map(([id]) => id);
const headId = Math.max(...manifestIds);
const prefixes = [0, ...manifestIds];
// Migrations.ts FIRST_V2_MIGRATION_ID (not exported).
const FIRST_V2_ID = 55;
const v2Entries = migrationManifest.filter(([id]) => id >= FIRST_V2_ID);
// A migration later given one of these ids is skipped by every database already past it, so each stays empty for
// good. Mirrors retiredMigrationIds in Migrations.ts, where runMigrations refuses a migration at any of them.
const KNOWN_HOLES = [66, 71];
// The schema each desktop release's prefix built when it shipped: sha256 of canonicalKey(schemaOf(...).objects).
const RELEASES = [
  {
    tag: "desktop-v0.1.0-beta.1",
    throughId: 65,
    schemaSha256: "978eede7f59218b65e5c637a38052d3662f052da5359af5da572269da989ae8b",
  },
];
// Migrations that delete user rows on purpose, and the tables they delete from.
const INTENTIONAL_DELETIONS: ReadonlyArray<{
  readonly id: number;
  readonly tables: ReadonlyArray<string>;
}> = [
  // 025_CleanupInvalidProjectionPendingApprovals: pending approvals with no approval request behind them.
  { id: 25, tables: ["projection_pending_approvals"] },
  // 031_AuthAuthorizationScopes: the alpha cutover drops role-bearing pairing links and sessions.
  { id: 31, tables: ["auth_pairing_links", "auth_sessions"] },
];

const report = (line: string) => console.log(`[migration-upgrade] ${line}`);

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "migration-upgrade-"));
afterAll(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));
let fileCount = 0;
const scratchFile = (label: string) =>
  NodePath.join(scratch, `${++fileCount}-${label.replace(/[^a-z0-9]+/gi, "-")}.sqlite`);
const copyOf = (file: string) => {
  const copy = scratchFile("case");
  NodeFS.copyFileSync(file, copy);
  return copy;
};
const discard = (...files: ReadonlyArray<string>) => {
  for (const file of files)
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      NodeFS.rmSync(`${file}${suffix}`, { force: true });
};

const withDatabase = <A, E>(file: string, use: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  use.pipe(Effect.provide(NodeSqliteClient.layer({ filename: file })));

/** What the app does on start: Sqlite.layerFromPath's pragmas, auto_vacuum switch, WAL and runMigrations. */
const startApp = <A, E>(file: string, use: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  use.pipe(
    Effect.provide(SqlitePersistence.layerFromPath(file).pipe(Layer.provide(NodeServices.layer))),
  );

// Sqlite.ts layerSetup turns foreign keys on before runMigrations, and with them on, dropping a parent table
// cascades, so every direct run of runMigrations below turns them on too.
const foreignKeysOn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA foreign_keys = ON`;
});

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const ledgerOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const exists = yield* sql`SELECT 1 FROM sqlite_schema WHERE name = 'effect_sql_migrations'`;
  if (exists.length === 0) return [] as Ledger;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const) as Ledger;
});

/** sqlite_schema plus what SQLite derives from it: columns, indexes and their columns, foreign keys. */
const schemaOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const objects = yield* sql<{
    readonly type: string;
    readonly name: string;
    readonly tbl_name: string;
    readonly sql: string | null;
  }>`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name`;
  const columns = yield* sql`
    SELECT m.name AS tbl, c.* FROM sqlite_schema m, pragma_table_xinfo(m.name) c
    WHERE m.type = 'table' ORDER BY m.name, c.cid
  `;
  const indexes = yield* sql`
    SELECT m.name AS tbl, i.* FROM sqlite_schema m, pragma_index_list(m.name) i
    WHERE m.type = 'table' ORDER BY m.name, i.name
  `;
  const indexColumns = yield* sql`
    SELECT i.name AS idx, x.* FROM sqlite_schema m, pragma_index_list(m.name) i, pragma_index_xinfo(i.name) x
    WHERE m.type = 'table' ORDER BY i.name, x.seqno
  `;
  const foreignKeys = yield* sql`
    SELECT m.name AS tbl, f.* FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' ORDER BY m.name, f.id, f.seq
  `;
  const tables: Record<string, unknown> = {};
  for (const object of objects) {
    if (object.type !== "table") continue;
    const own = indexes.filter((index) => index.tbl === object.name);
    tables[object.name] = {
      columns: columns.filter((column) => column.tbl === object.name),
      indexes: own,
      indexColumns: own.map((index) => indexColumns.filter((column) => column.idx === index.name)),
      foreignKeys: foreignKeys.filter((fk) => fk.tbl === object.name),
    };
  }
  return {
    objects: objects.map((object) => ({
      ...object,
      sql: object.sql?.replace(/\s+/g, " ").trim() ?? null,
    })),
    tables,
  };
});
type DatabaseSchema = Effect.Success<typeof schemaOf>;

/** Schema, ledger and every row: what a failed run must leave untouched. */
const snapshotOf = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const schema = yield* schemaOf;
  const rows: Record<string, ReadonlyArray<string>> = {};
  for (const object of schema.objects) {
    if (object.type !== "table") continue;
    const tableRows = yield* sql.unsafe<Record<string, unknown>>(
      `SELECT * FROM ${quote(object.name)}`,
    );
    // A ledger row's created_at is when a run wrote it, which differs between two runs of the same migrations.
    rows[object.name] = tableRows
      .map(({ created_at, ...row }) =>
        canonicalKey(object.name === "effect_sql_migrations" ? row : { created_at, ...row }),
      )
      .sort();
  }
  return { schema, ledger: yield* ledgerOf, rows };
});
type Snapshot = Effect.Success<typeof snapshotOf>;

const withoutTables = (
  schema: DatabaseSchema,
  drop: (table: string) => boolean,
): DatabaseSchema => ({
  objects: schema.objects.filter((object) => !drop(object.tbl_name)),
  tables: Object.fromEntries(Object.entries(schema.tables).filter(([name]) => !drop(name))),
});

/** The objects two schemas disagree on, one per line; empty when they agree. */
const schemaDiff = (actual: DatabaseSchema, expected: DatabaseSchema): string => {
  const lines: Array<string> = [];
  const key = (object: DatabaseSchema["objects"][number]) => `${object.type} ${object.name}`;
  const actualObjects = new Map(actual.objects.map((object) => [key(object), object]));
  for (const object of expected.objects) {
    const other = actualObjects.get(key(object));
    if (other === undefined) lines.push(`missing ${key(object)}: ${object.sql}`);
    else if (canonicalKey(other) !== canonicalKey(object))
      lines.push(`differs ${key(object)}:\n    have: ${other.sql}\n    want: ${object.sql}`);
  }
  const expectedKeys = new Set(expected.objects.map(key));
  for (const name of actualObjects.keys()) if (!expectedKeys.has(name)) lines.push(`extra ${name}`);
  for (const [table, shape] of Object.entries(expected.tables)) {
    if (
      actual.tables[table] !== undefined &&
      canonicalKey(actual.tables[table]) !== canonicalKey(shape)
    )
      lines.push(`differs table ${table} (columns, indexes or foreign keys)`);
  }
  return lines.join("\n  ");
};

const rowsDiff = (actual: Snapshot, expected: Snapshot): string =>
  [...new Set([...Object.keys(actual.rows), ...Object.keys(expected.rows)])]
    .filter((table) => canonicalKey(actual.rows[table]) !== canonicalKey(expected.rows[table]))
    .map((table) => {
      const have = new Set(actual.rows[table] ?? []);
      const want = new Set(expected.rows[table] ?? []);
      const extra = [...have].filter((row) => !want.has(row));
      const missing = [...want].filter((row) => !have.has(row));
      return (
        `rows of ${table}: ${missing.length} missing ${missing.slice(0, 2).join(" ")}; ` +
        `${extra.length} extra ${extra.slice(0, 2).join(" ")}`
      );
    })
    .join("\n  ");

interface SeededRow {
  readonly era: number;
  readonly table: string;
  readonly key: Readonly<Record<string, unknown>>;
}

/**
 * Writes one row into every table the schema has at this point, as a user's data piles up across releases. Values
 * follow each column's declared type, a foreign key points at a row its parent table already has, and an
 * `IN (...)` CHECK gets its first allowed value.
 */
const seedRows = (era: number, label: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const tables = yield* sql<{ readonly name: string; readonly sql: string }>`
      SELECT name, sql FROM sqlite_schema
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'effect_sql_migrations'
      ORDER BY rowid
    `;
    const seeded: Array<SeededRow> = [];
    for (const table of tables) {
      const columns = yield* sql.unsafe<{
        readonly cid: number;
        readonly name: string;
        readonly type: string;
        readonly notnull: number;
        readonly dflt_value: string | null;
        readonly pk: number;
        readonly hidden: number;
      }>(`PRAGMA table_xinfo(${quote(table.name)})`);
      const foreignKeys = yield* sql.unsafe<{
        readonly table: string;
        readonly from: string;
        readonly to: string;
      }>(`PRAGMA foreign_key_list(${quote(table.name)})`);
      const row: Record<string, unknown> = {};
      for (const column of columns) {
        if (column.hidden !== 0) continue;
        const foreignKey = foreignKeys.find((fk) => fk.from === column.name);
        if (foreignKey !== undefined) {
          const parent = yield* sql.unsafe<{ readonly value: unknown }>(
            `SELECT ${quote(foreignKey.to)} AS value FROM ${quote(foreignKey.table)} LIMIT 1`,
          );
          row[column.name] = parent[0]?.value ?? null;
          continue;
        }
        if (column.pk === 0 && (column.notnull === 0 || column.dflt_value !== null)) continue;
        const type = column.type.toUpperCase();
        const allowed = new RegExp(`\\b${column.name}\\s+IN\\s*\\(\\s*'([^']*)'`, "i").exec(
          table.sql,
        )?.[1];
        row[column.name] =
          allowed !== undefined
            ? allowed
            : type.includes("INT")
              ? era * 1000 + column.cid + 1
              : type.includes("REAL")
                ? era + 0.5
                : type.includes("BLOB")
                  ? new Uint8Array([era % 256])
                  : /json/i.test(column.name)
                    ? "{}"
                    : `${label}:${column.name}`;
      }
      const names = Object.keys(row);
      yield* sql.unsafe(
        `INSERT INTO ${quote(table.name)} (${names.map(quote).join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
        names.map((name) => row[name]),
      );
      const keyColumns = columns.filter((column) => column.pk > 0).map((column) => column.name);
      const key = Object.fromEntries(
        (keyColumns.length > 0 ? keyColumns : names).map((name) => [name, row[name]]),
      );
      seeded.push({ era, table: table.name, key });
    }
    return seeded;
  });

/** Seeded rows that are gone, other than those a migration after their era deletes on purpose. */
const lostRows = (seeded: ReadonlyArray<SeededRow>) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lost: Array<string> = [];
    for (const row of seeded) {
      if (
        INTENTIONAL_DELETIONS.some(
          (deletion) => deletion.id > row.era && deletion.tables.includes(row.table),
        )
      )
        continue;
      const columns = Object.keys(row.key);
      const where = columns.map((column) => `${quote(column)} IS ?`).join(" AND ");
      const found = yield* sql.unsafe<{ readonly found: number }>(
        `SELECT COUNT(*) AS found FROM ${quote(row.table)} WHERE ${where}`,
        columns.map((column) => row.key[column]),
      );
      if (found[0]?.found !== 1)
        lost.push(`${row.table} row written at prefix ${row.era} ${canonicalKey(row.key)}`);
    }
    return lost;
  });

interface StartState {
  readonly label: string;
  readonly file: string;
  readonly seeded: ReadonlyArray<SeededRow>;
}

const vacuumInto = (file: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`VACUUM INTO '${file}'`);
  });

/**
 * The databases users hold: one per recorded prefix of the manifest, as the build that stopped at that id left it
 * with a row written at every prefix along the way, and the three histories the published V2 previews wrote.
 */
const buildStartStates = Effect.gen(function* () {
  const states: Array<StartState> = [];
  const seeded: Array<SeededRow> = [];
  yield* withDatabase(
    scratchFile("build"),
    Effect.gen(function* () {
      yield* foreignKeysOn;
      for (const k of prefixes) {
        // Prefix 0 is a first start: no tables at all, not even the migrations table.
        if (k > 0)
          yield* runMigrations({ toMigrationInclusive: k }).pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                new Error(
                  `the database at prefix ${prefixes[prefixes.indexOf(k) - 1]}, with a row in every table, could not ` +
                    `take migration ${k}: every user upgrading from there hits this.\n${Cause.pretty(cause)}`,
                ),
              ),
            ),
          );
        seeded.push(...(yield* seedRows(k, `prefix-${k}`)));
        const file = scratchFile(`prefix-${k}`);
        yield* vacuumInto(file);
        states.push({ label: `prefix ${k}`, file, seeded: [...seeded] });
      }
    }),
  );
  const at52 = states[prefixes.indexOf(52)]!;
  const previews = [
    { label: "V2 preview 53_OrchestrationV2", record: { "53_OrchestrationV2": OrchestrationV2 } },
    {
      label: "V2 preview 54_OrchestrationV2",
      record: {
        "53_PullRequestFilesViewed": PullRequestFilesViewed,
        "54_OrchestrationV2": OrchestrationV2,
      },
    },
    {
      label: "V2 preview 54_OrchestrationV2 + 55_RemoveRedundantProjectionIndexes",
      record: {
        "53_PullRequestFilesViewed": PullRequestFilesViewed,
        "54_OrchestrationV2": OrchestrationV2,
        "55_RemoveRedundantProjectionIndexes": RemoveRedundantProjectionIndexes,
      },
    },
  ];
  for (const preview of previews) {
    const file = scratchFile(preview.label);
    const work = copyOf(at52.file);
    const previewSeeded = yield* withDatabase(
      work,
      Effect.gen(function* () {
        yield* foreignKeysOn;
        yield* Migrator.make({})({ loader: Migrator.fromRecord(preview.record) });
        const rows = yield* seedRows(53, preview.label);
        yield* vacuumInto(file);
        return rows;
      }),
    );
    discard(work);
    states.push({ label: preview.label, file, seeded: [...at52.seeded, ...previewSeeded] });
  }
  return states;
});

/** Built once per test file run and shared by every test, so any one test can run alone (-t). */
let worldPromise:
  | Promise<{ readonly startStates: ReadonlyArray<StartState>; readonly fresh: Snapshot }>
  | undefined;
const world = Effect.promise(
  () =>
    (worldPromise ??= Effect.runPromise(
      Effect.gen(function* () {
        const startStates = yield* buildStartStates;
        const fresh = yield* startApp(scratchFile("fresh"), snapshotOf);
        return { startStates, fresh };
      }).pipe(Effect.provideService(References.MinimumLogLevel, "Warn")),
    )),
);
const prefixState = (startStates: ReadonlyArray<StartState>, id: number) =>
  startStates[prefixes.indexOf(id)]!;

interface ScheduledStatement {
  /** The `Migrator <id>_<name>` step it ran in, or the runMigrations step around the migrator. */
  readonly step: string;
  readonly sql: string;
}

const STEP_SPANS = ["reconcileV2PreviewMigration", "assertV2MigrationsCanRun", "runMigrations"];
const stepOf = (span: Tracer.Span): string => {
  const names: Array<string> = [];
  for (
    let at: Tracer.AnySpan | undefined = span;
    at?._tag === "Span";
    at = Option.getOrUndefined(at.parent)
  )
    names.push(at.name);
  const migration = names.find((name) => name.startsWith("Migrator "));
  if (migration !== undefined) return migration;
  const step = names.find((name) => STEP_SPANS.includes(name)) ?? "runMigrations";
  return step === "runMigrations" && names.includes("sql.transaction")
    ? "Migrator (its own statements)"
    : step;
};

/**
 * Every SQL statement passes through Effect's statement transformer before it runs, so that is where a crash is
 * injected: the chosen statement is swapped for one SQLite rejects ("no such table: injected_crash_point"), the same
 * SqlError a failing migration statement raises. Nothing in Migrations.ts changes.
 */
const recordingSchedule =
  (into: Array<ScheduledStatement>): Statement.Transformer =>
  (statement, _sql, _fiber, span) => {
    into.push({ step: stepOf(span), sql: statement.compile()[0].replace(/\s+/g, " ").trim() });
    return Effect.succeed(statement);
  };
const crashingAt = (index: number): Statement.Transformer => {
  let seen = 0;
  return (statement, sql) =>
    Effect.succeed(seen++ === index ? sql.unsafe("SELECT * FROM injected_crash_point") : statement);
};
const runMigrationsWith = (transformer: Statement.Transformer) =>
  Effect.andThen(
    foreignKeysOn,
    runMigrations().pipe(Effect.provideService(Statement.CurrentTransformer, transformer)),
  );

/** ensureMigrationsTable runs before the migrator's transaction, so a failed first run may leave the empty table. */
const withoutEmptyLedgerTable = (snapshot: Snapshot): Snapshot =>
  snapshot.ledger.length > 0 || snapshot.rows["effect_sql_migrations"] === undefined
    ? snapshot
    : {
        ...snapshot,
        schema: withoutTables(snapshot.schema, (table) => table === "effect_sql_migrations"),
        rows: Object.fromEntries(
          Object.entries(snapshot.rows).filter(([name]) => name !== "effect_sql_migrations"),
        ),
      };

/**
 * A history another build left: our manifest through `base`, with at most one change. `foreign` is a site-local
 * migration recorded at an id past `base` (a fork, a branch build, a lane build's 066); `hole` is one of our ids that
 * build never had; `rename` is one of our ids that build used for its own migration.
 */
interface History {
  readonly base: number;
  readonly edit: { readonly kind: "none" | "foreign" | "hole" | "rename"; readonly id: number };
}
const describeHistory = ({ base, edit }: History) =>
  `prefix ${base}${edit.kind === "none" ? "" : ` with ${edit.kind} ${edit.id}`}`;

const siteLocalMigration = (id: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.unsafe(`CREATE TABLE site_local_${id} (id INTEGER PRIMARY KEY)`);
  });

/** The manifest of the build that wrote the history, for the same Effect migrator runMigrations uses. */
const otherBuildLoader = ({ base, edit }: History) => {
  const record: Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>> = {};
  for (const [id, name, migration] of migrationEntries) {
    if (id > base || ((edit.kind === "hole" || edit.kind === "rename") && id === edit.id)) continue;
    record[`${id}_${name}`] = migration;
  }
  if (edit.kind === "foreign" || edit.kind === "rename")
    record[`${edit.id}_SiteLocalMigration`] = siteLocalMigration(edit.id);
  return Migrator.fromRecord(record);
};

/** The manifest ids the Effect migrator would run here: it skips every id up to the highest one recorded. */
const migratorSelection = Effect.gen(function* () {
  const noOps = Object.fromEntries(
    migrationEntries.map(([id, name]) => [`${id}_${name}`, Effect.void]),
  );
  return (yield* Migrator.make({})({ loader: Migrator.fromRecord(noOps) })).map(([id]) => id);
});

const isNewerRefusal = (cause: Cause.Cause<unknown>) =>
  Option.getOrUndefined(Cause.findErrorOption(cause)) instanceof DatabaseNewerThanRuntime;

const isGuardRefusal = (cause: Cause.Cause<unknown>) => {
  const error = Option.getOrUndefined(Cause.findErrorOption(cause));
  return (
    error instanceof Migrator.MigrationError &&
    error.kind === "BadState" &&
    error.message.includes("would skip required schema migrations")
  );
};

describe("migration upgrade", () => {
  it("the manifest climbs by one except at the ids it keeps empty on purpose", () => {
    const holes: Array<number> = [];
    for (let id = 1; id < headId; id++) if (!manifestIds.includes(id)) holes.push(id);
    assert.deepStrictEqual(
      manifestIds,
      [...manifestIds].sort((a, b) => a - b),
      "migrationEntries are in id order",
    );
    assert.deepStrictEqual(
      holes,
      KNOWN_HOLES,
      `the manifest's holes below ${headId} changed. A new migration takes ${headId + 1}: an id below the highest ` +
        "one a database has run is skipped there, whatever its name.",
    );
    assert.deepStrictEqual(
      retiredMigrationIds,
      KNOWN_HOLES,
      "Migrations.ts retiredMigrationIds must name every hole, so a build that fills one fails on a fresh install too",
    );
  });

  it.effect("each released prefix still builds the schema its release shipped", () =>
    Effect.gen(function* () {
      const { startStates } = yield* world;
      for (const release of RELEASES) {
        const file = copyOf(prefixState(startStates, release.throughId).file);
        const schema = yield* withDatabase(file, schemaOf);
        discard(file);
        const digest = NodeCrypto.createHash("sha256")
          .update(canonicalKey(schema.objects))
          .digest("hex");
        report(`release ${release.tag}: prefix ${release.throughId} schema sha256 ${digest}`);
        assert.strictEqual(
          digest,
          release.schemaSha256,
          `${release.tag}: migrations 1..${release.throughId} now build a different schema than the release ` +
            "shipped. Its users already ran them and never will again; put the change in a new migration. " +
            `What changed: git diff ${release.tag} -- packages/runtime/src/persistence/Migrations/`,
        );
      }
    }),
  );

  it.effect(
    "every start state upgrades on app start to the fresh-install schema and keeps its rows",
    () =>
      Effect.gen(function* () {
        const { startStates, fresh } = yield* world;
        assert.deepStrictEqual(
          fresh.ledger,
          migrationManifest,
          "a fresh install records the whole manifest",
        );
        let rows = 0;
        for (const state of startStates) {
          const file = copyOf(state.file);
          const exit = yield* Effect.exit(startApp(file, snapshotOf));
          if (Exit.isFailure(exit))
            assert.fail(`${state.label}: the app failed to start:\n${Cause.pretty(exit.cause)}`);
          assert.strictEqual(
            schemaDiff(exit.value.schema, fresh.schema),
            "",
            `${state.label}: the upgraded schema differs from a fresh install`,
          );
          assert.deepStrictEqual(
            exit.value.ledger,
            migrationManifest,
            `${state.label}: ledger after the upgrade`,
          );
          assert.deepStrictEqual(
            yield* withDatabase(file, lostRows(state.seeded)),
            [],
            `${state.label}: rows lost`,
          );
          rows += state.seeded.length;
          discard(file);
        }
        report(
          `upgrade: ${startStates.length} start states (prefixes 0..${headId}, 3 V2 preview histories), each started ` +
            `once on Sqlite.layerFromPath; ${rows} seeded rows checked; exhaustive over recorded prefixes`,
        );
      }),
  );

  it.effect(
    "a run that fails at any statement leaves a committed step, and the next app start completes",
    () =>
      Effect.gen(function* () {
        const { startStates, fresh } = yield* world;
        const fullSweep = new Set([
          "prefix 0",
          ...RELEASES.map((release) => `prefix ${release.throughId}`),
          ...startStates
            .filter((state) => state.label.startsWith("V2 preview"))
            .map((state) => state.label),
        ]);
        const restarted = new Set<string>();
        let crashes = 0;
        let restarts = 0;
        for (const state of startStates) {
          const startFile = copyOf(state.file);
          const before = yield* withDatabase(startFile, snapshotOf);
          const schedule: Array<ScheduledStatement> = [];
          const recorded = yield* Effect.exit(
            withDatabase(startFile, runMigrationsWith(recordingSchedule(schedule))),
          );
          if (Exit.isFailure(recorded))
            assert.fail(
              `${state.label}: the run without a crash failed:\n${Cause.pretty(recorded.cause)}`,
            );
          const completed = yield* withDatabase(startFile, snapshotOf);
          assert.strictEqual(
            schemaDiff(completed.schema, fresh.schema),
            "",
            `${state.label}: migrated schema`,
          );
          assert.deepStrictEqual(
            completed.ledger,
            migrationManifest,
            `${state.label}: migrated ledger`,
          );
          restarted.add(canonicalKey(before)).add(canonicalKey(completed));

          // The preview reconcile commits in its own transaction before the migrator runs, so a later failure leaves
          // its result: it must be the schema and ledger of a recorded prefix.
          const reconciledFile = copyOf(state.file);
          yield* withDatabase(reconciledFile, reconcileV2PreviewMigration());
          const reconciled = yield* withDatabase(reconciledFile, snapshotOf);
          if (canonicalKey(reconciled) !== canonicalKey(before)) {
            const throughId = reconciled.ledger.at(-1)![0];
            const prefixFile = copyOf(prefixState(startStates, throughId).file);
            const prefix = yield* withDatabase(prefixFile, snapshotOf);
            assert.deepStrictEqual(
              reconciled.ledger,
              prefix.ledger,
              `${state.label}: reconciled ledger`,
            );
            assert.strictEqual(
              schemaDiff(reconciled.schema, prefix.schema),
              "",
              `${state.label}: reconciled schema vs prefix ${throughId}`,
            );
            discard(prefixFile);
          }
          discard(startFile, reconciledFile);

          const migrationStarts = schedule.flatMap((statement, index) =>
            statement.step.startsWith("Migrator ") && statement.step !== schedule[index - 1]?.step
              ? [index]
              : [],
          );
          const lastBeforeCommit = schedule.findLastIndex((statement) =>
            statement.step.startsWith("Migrator"),
          );
          const bounded = new Set([migrationStarts[0], migrationStarts.at(-1), lastBeforeCommit]);
          for (const { ran, lost } of crashPoints(schedule)) {
            const index = ran.length;
            if (lost.length === 0 || !(fullSweep.has(state.label) || bounded.has(index))) continue;
            crashes++;
            const crash =
              `${state.label}: crash at statement ${index} of ${schedule.length} ` +
              `(${lost[0]!.step}): ${lost[0]!.sql.slice(0, 160)}`;
            const file = copyOf(state.file);
            const exit = yield* Effect.exit(
              withDatabase(file, runMigrationsWith(crashingAt(index))),
            );
            const after = yield* withDatabase(file, snapshotOf);
            const asBefore =
              canonicalKey(withoutEmptyLedgerTable(after)) ===
                canonicalKey(withoutEmptyLedgerTable(before)) ||
              canonicalKey(after) === canonicalKey(reconciled);
            // Some migrations stamp rows with SQLite's 'now', so a run's result is compared with the recorded run by
            // schema, ledger and seeded rows rather than byte for byte.
            const fullyMigrated = Effect.suspend(() =>
              schemaDiff(after.schema, fresh.schema) === "" &&
              canonicalKey(after.ledger) === canonicalKey(migrationManifest)
                ? Effect.map(
                    withDatabase(file, lostRows(state.seeded)),
                    (lost) => lost.length === 0,
                  )
                : Effect.succeed(false),
            );
            assert.isTrue(
              (Exit.isFailure(exit) && asBefore) || (yield* fullyMigrated),
              `${crash}\n  the run ${Exit.isFailure(exit) ? "failed" : "succeeded"} and left a database that is not ` +
                `where it started, reconciled, or fully migrated.\n  ledger: ${canonicalKey(after.ledger)}\n` +
                `  schema vs start:\n  ${schemaDiff(after.schema, before.schema)}\n` +
                `  schema vs migrated:\n  ${schemaDiff(after.schema, completed.schema)}\n` +
                `  rows vs start:\n  ${rowsDiff(after, before)}\n  rows vs migrated:\n  ${rowsDiff(after, completed)}`,
            );
            const key = canonicalKey(after);
            if (!restarted.has(key)) {
              restarted.add(key);
              restarts++;
              const restart = yield* Effect.exit(startApp(file, snapshotOf));
              if (Exit.isFailure(restart))
                assert.fail(
                  `${crash}\n  the next app start failed:\n${Cause.pretty(restart.cause)}`,
                );
              assert.strictEqual(
                schemaDiff(restart.value.schema, fresh.schema),
                "",
                `${crash}\n  the next app start left a schema unlike a fresh install`,
              );
              assert.deepStrictEqual(
                restart.value.ledger,
                migrationManifest,
                `${crash}\n  ledger after the next start`,
              );
            }
            discard(file);
          }
        }
        report(
          `crash: ${crashes} crashed runs from ${startStates.length} start states (every statement for ` +
            `${[...fullSweep].join(", ")}; for the other prefixes the first and last migration and the last statement ` +
            `before commit); ${restarted.size} distinct databases, ${restarts} of them new and restarted on ` +
            "Sqlite.layerFromPath",
        );
      }),
  );

  it.effect(
    "the V2 ledger guard refuses exactly the histories the migrator would skip a V2 migration on",
    () =>
      Effect.gen(function* () {
        const { startStates, fresh } = yield* world;
        const bases = prefixes.filter((id) => id >= FIRST_V2_ID - 3);
        const histories: Array<History> = [];
        for (const base of bases) {
          histories.push({ base, edit: { kind: "none", id: 0 } });
          for (const id of [...manifestIds, ...KNOWN_HOLES, headId + 1].filter((id) => id > base))
            histories.push({ base, edit: { kind: "foreign", id } });
          for (const id of manifestIds.filter((id) => id >= FIRST_V2_ID - 2 && id <= base)) {
            histories.push({ base, edit: { kind: "hole", id } });
            histories.push({ base, edit: { kind: "rename", id } });
          }
        }
        let refused = 0;
        let newer = 0;
        let started = 0;
        let unbuildable = 0;
        for (const history of histories) {
          const label = describeHistory(history);
          const changed =
            history.edit.kind === "hole" || history.edit.kind === "rename"
              ? history.edit.id
              : Infinity;
          const from = Math.max(...prefixes.filter((id) => id <= history.base && id < changed));
          const file = copyOf(prefixState(startStates, from).file);
          const built = yield* Effect.exit(
            withDatabase(
              file,
              Effect.andThen(
                foreignKeysOn,
                Migrator.make({})({ loader: otherBuildLoader(history) }),
              ),
            ),
          );
          if (Exit.isFailure(built)) {
            unbuildable++;
            discard(file);
            continue;
          }
          const selectionFile = copyOf(file);
          const selection = yield* withDatabase(selectionFile, migratorSelection);
          const { before, exit, after } = yield* withDatabase(
            file,
            Effect.gen(function* () {
              const before = yield* snapshotOf;
              const exit = yield* Effect.exit(Effect.andThen(foreignKeysOn, runMigrations()));
              return { before, exit, after: yield* snapshotOf };
            }),
          );
          discard(file, selectionFile);
          const recorded = new Map(before.ledger);
          // A newer build's database: refused before the ledger guard or any migration runs, and left as it is.
          if (Math.max(0, ...recorded.keys()) > headId) {
            newer++;
            const outcome = Exit.isSuccess(exit)
              ? "started the app"
              : `failed another way:\n${Cause.pretty(exit.cause)}`;
            assert.isTrue(
              Exit.isFailure(exit) && isNewerRefusal(exit.cause),
              `${label}: the database records a migration past ${headId}, but runMigrations ${outcome}`,
            );
            assert.strictEqual(
              canonicalKey(after),
              canonicalKey(before),
              `${label}: the refusal changed the database`,
            );
            continue;
          }
          const skipped = migrationManifest.filter(
            ([id, name]) => recorded.get(id) !== name && !selection.includes(id),
          );
          const skippedV2 = skipped.filter(([id]) => id >= FIRST_V2_ID);
          if (skippedV2.length > 0) {
            refused++;
            const outcome = Exit.isSuccess(exit)
              ? "started the app"
              : `failed another way:\n${Cause.pretty(exit.cause)}`;
            assert.isTrue(
              Exit.isFailure(exit) && isGuardRefusal(exit.cause),
              `${label}: the migrator skips ${skippedV2.map(([id, name]) => `${id}_${name}`).join(", ")}, ` +
                `but runMigrations ${outcome}`,
            );
            assert.strictEqual(
              canonicalKey(after),
              canonicalKey(before),
              `${label}: the refusal changed the database`,
            );
            for (const [id, name] of skippedV2)
              assert.include(
                String(exit),
                `${id}_${name}`,
                `${label}: the refusal names every skipped migration`,
              );
            continue;
          }
          started++;
          if (Exit.isFailure(exit))
            assert.fail(
              `${label}: the migrator skips no V2 migration, yet it failed:\n${Cause.pretty(exit.cause)}`,
            );
          const afterRecorded = new Map(after.ledger);
          for (const [id, name] of v2Entries)
            assert.strictEqual(
              afterRecorded.get(id),
              name,
              `${label}: V2 migration ${id}_${name} after the start`,
            );
          // A skipped id below 55 is the site-local case Migrations.ts accepts with a warning; its schema stays out.
          if (skipped.length === 0)
            assert.strictEqual(
              schemaDiff(
                withoutTables(after.schema, (table) => table.startsWith("site_local_")),
                fresh.schema,
              ),
              "",
              `${label}: schema after the start, beside the site-local table`,
            );
        }
        report(
          `ledger guard: ${histories.length} histories (prefixes ${bases[0]}..${headId}, each as recorded and with ` +
            `one foreign id past it, or one hole or rename at ids ${FIRST_V2_ID - 2}+); ${newer} refused as newer, ${refused} refused, ` +
            `${started} started, ${unbuildable} that no build could write; exhaustive over that set`,
        );
      }),
  );
});
