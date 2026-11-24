// The Chiefs and their one shared board in the runtime's Session Protocol SQLite
// (session-protocol/store.ts runs it with the rest of SCHEMA): each Chief's profile, Queue items
// (each on one Chief's board), change sets, which chats each item started, and an append-only log
// of every board change (the delta a Chief turn reads is the log since its last).
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/** The profiles table under `name` (a rebuild makes it under another name, then renames it). */
const profilesTable = (name: string) => `CREATE TABLE IF NOT EXISTS ${name} (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     avatar TEXT NOT NULL,
     model TEXT,
     access TEXT,
     project_ids TEXT NOT NULL DEFAULT '[]',
     soul TEXT NOT NULL,
     autonomy INTEGER,
     updates TEXT,
     topics TEXT,
     home INTEGER NOT NULL DEFAULT 0,
     removed_at TEXT,
     project_id TEXT,
     project_default INTEGER NOT NULL DEFAULT 0,
     role TEXT,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL)`;
const PROFILE_COLUMNS = "id, name, avatar, model, access, project_ids, soul, home, removed_at, created_at, updated_at";

export const CHIEF_SCHEMA = [
  // One row per Chief, keyed by its workspace (kind chief). `project_ids`: the projects it works in, a JSON list; empty:
  // every project. `project_id` and `project_default`: what a Chief made 2026-11-15 to 17 (when each Chief had one
  // project) shows older clients, kept while its list is just that project; nothing routes by them. `home`: the one
  // Chief of a runtime from before profiles. `role`: one line on what it does. A removed Chief keeps its row
  // (removed_at), so its old chats still name it. `access` NULL: the chats it starts take what a new chat in their
  // project takes. `autonomy`, `updates` NULL: Settings' (chief_autonomy, chief_updates).
  profilesTable("chief_profiles"),
  // chief_id: the Chief whose board the item is on. NULL only on rows from before Chiefs had profiles: the home Chief's.
  `CREATE TABLE IF NOT EXISTS chief_items (
     id TEXT PRIMARY KEY,
     chief_id TEXT,
     text TEXT NOT NULL,
     title TEXT,
     state TEXT NOT NULL,
     rank REAL NOT NULL,
     pinned INTEGER NOT NULL DEFAULT 0,
     projects TEXT NOT NULL DEFAULT '[]',
     change_set_id TEXT,
     blocked_on TEXT,
     not_before TEXT,
     detail TEXT,
     asked TEXT,
     source TEXT NOT NULL,
     start INTEGER NOT NULL DEFAULT 0,
     proposal TEXT,
     delivered INTEGER NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL,
     seq INTEGER,
     pull_request TEXT,
     attachments TEXT,
     updates TEXT,
     proof TEXT,
     heard_in TEXT,
     done_when TEXT,
     check_in TEXT,
     started_at TEXT,
     checked_at TEXT,
     sent_as TEXT,
     sent_in TEXT)`,
  `CREATE TABLE IF NOT EXISTS chief_change_sets (
     id TEXT PRIMARY KEY,
     title TEXT NOT NULL,
     repos TEXT NOT NULL DEFAULT '[]',
     contract TEXT NOT NULL DEFAULT '',
     merge_order TEXT NOT NULL DEFAULT '[]',
     state TEXT NOT NULL,
     created_at TEXT NOT NULL,
     updated_at TEXT NOT NULL)`,
  // A chat is linked the moment it is made. role "held": a fan-out sibling still waiting for its
  // task (kept in `task`, its images in `task_attachments`, until it is sent); run_id: the Chief turn that started it,
  // for its limits. Where the watcher (chief/watch.ts) stands with the chat, so a relaunch picks up there: `applied`,
  // the cursor of its latest turn event the watcher moved the item by; `held`, how often its update was held for its
  // Chief, and `heard`, the last of those its Chief was handed; `early`, 1 while its finish waits for the move that
  // ends the item; `narrated`, the turn whose result for this item its Chief was handed to explain.
  `CREATE TABLE IF NOT EXISTS chief_item_workspaces (
     item_id TEXT NOT NULL,
     workspace_id TEXT NOT NULL,
     role TEXT NOT NULL,
     at TEXT NOT NULL,
     run_id TEXT,
     task TEXT,
     task_attachments TEXT,
     applied INTEGER,
     held INTEGER,
     heard INTEGER,
     early INTEGER,
     narrated TEXT,
     PRIMARY KEY (item_id, workspace_id))`,
  `CREATE INDEX IF NOT EXISTS chief_item_workspaces_run ON chief_item_workspaces (run_id)`,
  `CREATE INDEX IF NOT EXISTS chief_item_workspaces_ws ON chief_item_workspaces (workspace_id)`,
  // The last number each Chief's board gave an item (chief_id '' for rows from before profiles), so a removed
  // item's number is never given again: an old [[12]] in the transcript always means the same item.
  `CREATE TABLE IF NOT EXISTS chief_numbers (
     chief_id TEXT PRIMARY KEY,
     last INTEGER NOT NULL)`,
  // Each routine's last run (an automation with a chief output, packages/automations README "A routine"), by its
  // automation's id: the Chief it reported to (chief_id), what its step decided and its report, cut to
  // ROUTINE_SUMMARY_CHARS (chief/store.ts).
  `CREATE TABLE IF NOT EXISTS chief_routines (
     automation_id TEXT PRIMARY KEY,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     run_id TEXT NOT NULL,
     ran_at TEXT NOT NULL,
     status TEXT NOT NULL,
     decision TEXT,
     summary TEXT NOT NULL,
     chief_id TEXT)`,
  // A routine's run that found news, by run: its report (as its card shows it) until its Chief (chief_id) heard it
  // (heard_at), so a restart between its row and its wake delivers it then, once.
  `CREATE TABLE IF NOT EXISTS chief_routine_news (
     run_id TEXT PRIMARY KEY,
     automation_id TEXT NOT NULL,
     project_id TEXT NOT NULL,
     name TEXT NOT NULL,
     report TEXT NOT NULL,
     at TEXT NOT NULL,
     heard_at TEXT,
     chief_id TEXT)`,
  // chief_id: whose item it touched (a removed item's owner is known only from here).
  `CREATE TABLE IF NOT EXISTS chief_board_events (
     seq INTEGER PRIMARY KEY AUTOINCREMENT,
     at TEXT NOT NULL,
     item_id TEXT,
     kind TEXT NOT NULL,
     chief_id TEXT)`,
  // The person's corrections: one per item and kind per UTC day; lessons.ts keeps the newest 20 per Chief.
  `CREATE TABLE IF NOT EXISTS chief_lessons (
     id TEXT PRIMARY KEY,
     chief_id TEXT NOT NULL,
     item_id TEXT NOT NULL,
     kind TEXT NOT NULL,
     text TEXT NOT NULL,
     at TEXT NOT NULL)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chief_lessons_daily ON chief_lessons (chief_id, item_id, kind, substr(at, 1, 10))`,
];

/** Columns added after their table shipped: CREATE TABLE IF NOT EXISTS never adds one to an older database. */
const CHIEF_COLUMNS: ReadonlyArray<{ readonly table: string; readonly column: string; readonly type: string }> = [
  // Mission proof, check-in pace, first start and the last check-in claimed by the watcher.
  { table: "chief_items", column: "done_when", type: "TEXT" },
  { table: "chief_items", column: "check_in", type: "TEXT" },
  { table: "chief_items", column: "started_at", type: "TEXT" },
  { table: "chief_items", column: "checked_at", type: "TEXT" },
  { table: "chief_items", column: "chief_id", type: "TEXT" },
  { table: "chief_board_events", column: "chief_id", type: "TEXT" },
  { table: "chief_items", column: "asked", type: "TEXT" },
  { table: "chief_items", column: "seq", type: "INTEGER" },
  // The pull request of the item's chat, as last synced (Board.pullRequest follows it).
  { table: "chief_items", column: "pull_request", type: "TEXT" },
  // The note's images, as references into the attachment store (chief/attachments.ts).
  { table: "chief_items", column: "attachments", type: "TEXT" },
  // How much the person hears: a Chief's own level, its autonomy, and an item's override (chief/updates.ts).
  { table: "chief_profiles", column: "autonomy", type: "INTEGER" },
  { table: "chief_profiles", column: "updates", type: "TEXT" },
  // The groups (Workspace.topic) a Chief manages, a JSON list; NULL: none (chief.manage).
  { table: "chief_profiles", column: "topics", type: "TEXT" },
  { table: "chief_items", column: "updates", type: "TEXT" },
  // Its chats' latest screenshots, stored like the note's images (chief/proof.ts).
  { table: "chief_items", column: "proof", type: "TEXT" },
  // A Chief's one project, and whether it was that project's first, while each Chief had one (2026-11-15 to 17): kept
  // for older clients.
  { table: "chief_profiles", column: "project_id", type: "TEXT" },
  { table: "chief_profiles", column: "project_default", type: "INTEGER NOT NULL DEFAULT 0" },
  // One line on what a Chief does (ChiefProfile.role).
  { table: "chief_profiles", column: "role", type: "TEXT" },
  // The Chief a routine's run reported to (outputs.chief.to, else one that works in its project).
  { table: "chief_routines", column: "chief_id", type: "TEXT" },
  { table: "chief_routine_news", column: "chief_id", type: "TEXT" },
  // The session of the Chief that first heard a moved item's note (Board.Item heard_in).
  { table: "chief_items", column: "heard_in", type: "TEXT" },
  // The exact request id and session of the latest accepted delivery, paired for its transcript message id.
  { table: "chief_items", column: "sent_as", type: "TEXT" },
  { table: "chief_items", column: "sent_in", type: "TEXT" },
  // A held sibling's images, as references into the attachment store, until its task is sent.
  { table: "chief_item_workspaces", column: "task_attachments", type: "TEXT" },
  // Where the watcher stands with each chat. None yet on an older database: its first start replays every running
  // item's chats once, as every start did before.
  { table: "chief_item_workspaces", column: "applied", type: "INTEGER" },
  { table: "chief_item_workspaces", column: "held", type: "INTEGER" },
  { table: "chief_item_workspaces", column: "heard", type: "INTEGER" },
  { table: "chief_item_workspaces", column: "early", type: "INTEGER" },
  // The turn whose result its Chief was handed to explain (watch.ts), once per chat and item: later turns of the same
  // request (a rebase, a check fixed), a merge or a relaunch explain nothing again.
  { table: "chief_item_workspaces", column: "narrated", type: "TEXT" },
];

/**
 * The next number on a Chief's board: one past the last it gave (or its highest item, for a board numbered before the
 * counter), recorded so it is never given again. The number a person reads (CH-12) and the Chief cites ([[12]]).
 */
export const nextNumber = (sql: SqlClient.SqlClient, chiefId: string | null) =>
  Effect.gen(function* () {
    const key = chiefId ?? "";
    const counted = yield* sql<{ last: number }>`SELECT last FROM chief_numbers WHERE chief_id = ${key}`;
    const highest = yield* sql<{ top: number | null }>`SELECT MAX(seq) AS top FROM chief_items WHERE chief_id IS ${chiefId}`;
    const next = Math.max(counted[0]?.last ?? 0, highest[0]?.top ?? 0) + 1;
    yield* sql`INSERT INTO chief_numbers (chief_id, last) VALUES (${key}, ${next}) ON CONFLICT (chief_id) DO UPDATE SET last = excluded.last`;
    return next;
  });

/** Numbers every item that has none, oldest first: after the column is added, and when items change boards. */
export const numberItems = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const rows = yield* sql<{ id: string; chief_id: string | null }>`SELECT id, chief_id FROM chief_items WHERE seq IS NULL ORDER BY created_at, id`;
    for (const row of rows) yield* sql`UPDATE chief_items SET seq = ${yield* nextNumber(sql, row.chief_id)} WHERE id = ${row.id}`;
  });

/**
 * After CHIEF_SCHEMA, idempotent: adds each column an older database lacks, then the indexes on them. A profiles
 * table made by a build of several Chiefs from before 22a8196f has `access TEXT NOT NULL`, which a Chief with no
 * permissions picked (NULL) can't be written into: it is rebuilt with `access` nullable, its rows copied, in one
 * transaction.
 */
export const migrateChiefSchema = (sql: SqlClient.SqlClient) =>
  Effect.gen(function* () {
    const profileColumns = yield* sql<{ name: string; notnull: number }>`SELECT name, "notnull" FROM pragma_table_info('chief_profiles')`;
    if (profileColumns.some((c) => c.name === "access" && c.notnull === 1)) {
      yield* sql.withTransaction(
        Effect.gen(function* () {
          yield* sql.unsafe(`DROP TABLE IF EXISTS chief_profiles_next`);
          yield* sql.unsafe(profilesTable("chief_profiles_next"));
          yield* sql.unsafe(`INSERT INTO chief_profiles_next (${PROFILE_COLUMNS}) SELECT ${PROFILE_COLUMNS} FROM chief_profiles`);
          yield* sql.unsafe(`DROP TABLE chief_profiles`);
          yield* sql.unsafe(`ALTER TABLE chief_profiles_next RENAME TO chief_profiles`);
        }),
      );
    }
    for (const { table, column, type } of CHIEF_COLUMNS) {
      const columns = yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${table})`;
      if (!columns.some((c) => c.name === column)) yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
    yield* sql.unsafe(`CREATE INDEX IF NOT EXISTS chief_items_chief ON chief_items (chief_id)`);
    // At most one live Chief marked a project's first (2026-11-15 to 17): nothing new is marked so, and nothing routes
    // by it, but a database from then keeps it.
    yield* sql.unsafe(`CREATE UNIQUE INDEX IF NOT EXISTS chief_profiles_project_default ON chief_profiles (project_id) WHERE project_default = 1 AND removed_at IS NULL`);
    yield* numberItems(sql);
  });
