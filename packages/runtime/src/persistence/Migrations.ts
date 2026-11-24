// ), apps/server/src/persistence/Migrations.ts @ ab3a3cd1.
/**
 * Migration runner with an inline loader.
 *
 * Uses Migrator.make with fromRecord to define migrations inline.
 * All migrations are statically imported - no dynamic file system loading.
 *
 * `runMigrations` is called by the SQLite persistence layer at startup, so the
 * schema is always up to date before the application starts. A database a
 * newer build migrated is refused first (DatabaseNewerThanRuntime).
 */

import * as Migrator from "effect/sql/Migrator";
import * as Effect from "effect/Effect";
import * as Runtime from "effect/Runtime";
import * as SqlClient from "effect/sql/SqlClient";
import { SERVER_EXIT_CODE_DATABASE_NEWER } from "@caveman-app/protocol";
import { RUNTIME_VERSION } from "../runtimeVersion.ts";
import { reconcileV2PreviewMigration } from "./reconcileV2PreviewMigration.ts";

// Import all migrations statically
import Migration0001 from "./Migrations/001_OrchestrationEvents.ts";
import Migration0002 from "./Migrations/002_OrchestrationCommandReceipts.ts";
import Migration0003 from "./Migrations/003_CheckpointDiffBlobs.ts";
import Migration0004 from "./Migrations/004_ProviderSessionRuntime.ts";
import Migration0005 from "./Migrations/005_Projections.ts";
import Migration0006 from "./Migrations/006_ProjectionThreadSessionRuntimeModeColumns.ts";
import Migration0007 from "./Migrations/007_ProjectionThreadMessageAttachments.ts";
import Migration0008 from "./Migrations/008_ProjectionThreadActivitySequence.ts";
import Migration0009 from "./Migrations/009_ProviderSessionRuntimeMode.ts";
import Migration0010 from "./Migrations/010_ProjectionThreadsRuntimeMode.ts";
import Migration0011 from "./Migrations/011_OrchestrationThreadCreatedRuntimeMode.ts";
import Migration0012 from "./Migrations/012_ProjectionThreadsInteractionMode.ts";
import Migration0013 from "./Migrations/013_ProjectionThreadProposedPlans.ts";
import Migration0014 from "./Migrations/014_ProjectionThreadProposedPlanImplementation.ts";
import Migration0015 from "./Migrations/015_ProjectionTurnsSourceProposedPlan.ts";
import Migration0016 from "./Migrations/016_CanonicalizeModelSelections.ts";
import Migration0017 from "./Migrations/017_ProjectionThreadsArchivedAt.ts";
import Migration0018 from "./Migrations/018_ProjectionThreadsArchivedAtIndex.ts";
import Migration0019 from "./Migrations/019_ProjectionSnapshotLookupIndexes.ts";
import Migration0020 from "./Migrations/020_AuthAccessManagement.ts";
import Migration0021 from "./Migrations/021_AuthSessionClientMetadata.ts";
import Migration0022 from "./Migrations/022_AuthSessionLastConnectedAt.ts";
import Migration0023 from "./Migrations/023_ProjectionThreadShellSummary.ts";
import Migration0024 from "./Migrations/024_BackfillProjectionThreadShellSummary.ts";
import Migration0025 from "./Migrations/025_CleanupInvalidProjectionPendingApprovals.ts";
import Migration0026 from "./Migrations/026_CanonicalizeModelSelectionOptions.ts";
import Migration0027 from "./Migrations/027_ProviderSessionRuntimeInstanceId.ts";
import Migration0028 from "./Migrations/028_ProjectionThreadSessionInstanceId.ts";
import Migration0029 from "./Migrations/029_ProjectionThreadDetailOrderingIndexes.ts";
import Migration0030 from "./Migrations/030_ProjectionThreadShellArchiveIndexes.ts";
import Migration0031 from "./Migrations/031_AuthAuthorizationScopes.ts";
import Migration0032 from "./Migrations/032_AuthPairingProofKeyThumbprint.ts";
import Migration0033 from "./Migrations/033_ProjectionThreadsSettled.ts";
import Migration0034 from "./Migrations/034_ProjectionThreadsSnoozed.ts";
import Migration0035 from "./Migrations/035_ProjectionThreadTitleRegeneration.ts";
import Migration0036 from "./Migrations/036_ProjectionThreadsPinned.ts";
import Migration0037 from "./Migrations/037_ProjectionTurnsKeysetIndex.ts";
import Migration0038 from "./Migrations/038_ProjectionThreadsPinOrderKey.ts";
import Migration0039 from "./Migrations/039_ProjectionProjectsDefaultThreadEnvMode.ts";
import Migration0040 from "./Migrations/040_ProjectionProjectFaviconPath.ts";
import Migration0041 from "./Migrations/041_AuthSessionClientConnection.ts";
import Migration0042 from "./Migrations/042_ProjectionThreadLinkedPullRequest.ts";
import Migration0043 from "./Migrations/043_ProjectionThreadsUnsettledAt.ts";
import Migration0044 from "./Migrations/044_ClearAutomaticProjectModelDefaults.ts";
import Migration0045 from "./Migrations/045_ProjectionProjectsAutoPull.ts";
import Migration0046 from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import Migration0047 from "./Migrations/047_ProjectionProjectIcon.ts";
import Migration0048 from "./Migrations/048_ProjectionThreadBranchPullRequest.ts";
import Migration0049 from "./Migrations/049_ProjectionThreadsActiveOrderKey.ts";
import Migration0050 from "./Migrations/050_ProjectionThreadPullRequests.ts";
import Migration0051 from "./Migrations/051_ProjectionThreadMessageContext.ts";
import Migration0052 from "./Migrations/052_ProjectionThreadTitleState.ts";
import Migration0053 from "./Migrations/053_PullRequestFilesViewed.ts";
import Migration0054 from "./Migrations/054_ProjectionThreadsAutoSettleDisabledAt.ts";
import Migration0055 from "./Migrations/055_OrchestrationV2.ts";
import Migration0056 from "./Migrations/056_RemoveRedundantProjectionIndexes.ts";
import Migration0057 from "./Migrations/057_ScheduledTaskWebhooks.ts";
import Migration0058 from "./Migrations/058_WebhookRelayDeliveries.ts";
import Migration0059 from "./Migrations/059_McpAppModelContext.ts";
import Migration0060 from "./Migrations/060_ThreadSnapshotWindowIndexes.ts";
import Migration0061 from "./Migrations/061_PullRequestReviewGuides.ts";
import Migration0062 from "./Migrations/062_ThreadFailureLookupIndex.ts";
import Migration0063 from "./Migrations/063_AutomationRuns.ts";
import Migration0064 from "./Migrations/064_CloudSessionOutbox.ts";
import Migration0065 from "./Migrations/065_AutomationCloudRecords.ts";
import Migration0067 from "./Migrations/067_CodexUsageNativeTurnIndex.ts";
import Migration0068 from "./Migrations/068_WebhookDedupe.ts";
import Migration0069 from "./Migrations/069_CanonicalizeThreadPullRequestLinks.ts";
import Migration0070 from "./Migrations/070_AutomationRunWorkedMs.ts";
// 071 is retired (retiredMigrationIds).
import Migration0072 from "./Migrations/072_ActiveTurnItemIndexes.ts";
import Migration0073 from "./Migrations/073_DropOrchestrationEventCorrelationIndex.ts";
import Migration0074 from "./Migrations/074_DelegatedRecoveryIndexes.ts";
import Migration0075 from "./Migrations/075_ProjectionProjectsPinArchive.ts";
import Migration0076 from "./Migrations/076_ScheduledTaskRunCount.ts";
import Migration0077 from "./Migrations/077_SubagentDeliveryState.ts";

/**
 * Migration loader with all migrations defined inline.
 *
 * Key format: "{id}_{name}" where:
 * - id: numeric migration ID (determines execution order)
 * - name: descriptive name for the migration
 *
 * Uses Migrator.fromRecord which parses the key format and
 * returns migrations sorted by ID.
 */
export const migrationEntries = [
  [1, "OrchestrationEvents", Migration0001],
  [2, "OrchestrationCommandReceipts", Migration0002],
  [3, "CheckpointDiffBlobs", Migration0003],
  [4, "ProviderSessionRuntime", Migration0004],
  [5, "Projections", Migration0005],
  [6, "ProjectionThreadSessionRuntimeModeColumns", Migration0006],
  [7, "ProjectionThreadMessageAttachments", Migration0007],
  [8, "ProjectionThreadActivitySequence", Migration0008],
  [9, "ProviderSessionRuntimeMode", Migration0009],
  [10, "ProjectionThreadsRuntimeMode", Migration0010],
  [11, "OrchestrationThreadCreatedRuntimeMode", Migration0011],
  [12, "ProjectionThreadsInteractionMode", Migration0012],
  [13, "ProjectionThreadProposedPlans", Migration0013],
  [14, "ProjectionThreadProposedPlanImplementation", Migration0014],
  [15, "ProjectionTurnsSourceProposedPlan", Migration0015],
  [16, "CanonicalizeModelSelections", Migration0016],
  [17, "ProjectionThreadsArchivedAt", Migration0017],
  [18, "ProjectionThreadsArchivedAtIndex", Migration0018],
  [19, "ProjectionSnapshotLookupIndexes", Migration0019],
  [20, "AuthAccessManagement", Migration0020],
  [21, "AuthSessionClientMetadata", Migration0021],
  [22, "AuthSessionLastConnectedAt", Migration0022],
  [23, "ProjectionThreadShellSummary", Migration0023],
  [24, "BackfillProjectionThreadShellSummary", Migration0024],
  [25, "CleanupInvalidProjectionPendingApprovals", Migration0025],
  [26, "CanonicalizeModelSelectionOptions", Migration0026],
  [27, "ProviderSessionRuntimeInstanceId", Migration0027],
  [28, "ProjectionThreadSessionInstanceId", Migration0028],
  [29, "ProjectionThreadDetailOrderingIndexes", Migration0029],
  [30, "ProjectionThreadShellArchiveIndexes", Migration0030],
  [31, "AuthAuthorizationScopes", Migration0031],
  [32, "AuthPairingProofKeyThumbprint", Migration0032],
  [33, "ProjectionThreadsSettled", Migration0033],
  [34, "ProjectionThreadsSnoozed", Migration0034],
  [35, "ProjectionThreadTitleRegeneration", Migration0035],
  [36, "ProjectionThreadsPinned", Migration0036],
  [37, "ProjectionTurnsKeysetIndex", Migration0037],
  [38, "ProjectionThreadsPinOrderKey", Migration0038],
  [39, "ProjectionProjectsDefaultThreadEnvMode", Migration0039],
  [40, "ProjectionProjectFaviconPath", Migration0040],
  [41, "AuthSessionClientConnection", Migration0041],
  [42, "ProjectionThreadLinkedPullRequest", Migration0042],
  [43, "ProjectionThreadsUnsettledAt", Migration0043],
  [44, "ClearAutomaticProjectModelDefaults", Migration0044],
  [45, "ProjectionProjectsAutoPull", Migration0045],
  [46, "RepairAutomaticSettlementTimestamps", Migration0046],
  [47, "ProjectionProjectIcon", Migration0047],
  [48, "ProjectionThreadBranchPullRequest", Migration0048],
  [49, "ProjectionThreadsActiveOrderKey", Migration0049],
  [50, "ProjectionThreadPullRequests", Migration0050],
  [51, "ProjectionThreadMessageContext", Migration0051],
  [52, "ProjectionThreadTitleState", Migration0052],
  [53, "PullRequestFilesViewed", Migration0053],
  [54, "ProjectionThreadsAutoSettleDisabledAt", Migration0054],
  // Released as 53 and 54 in V2 previews; reconcileV2PreviewMigration preserves their ledger.
  // Preserve this migration's schema. Future V2 schema changes need new migrations.
  [55, "OrchestrationV2", Migration0055],
  [56, "RemoveRedundantProjectionIndexes", Migration0056],
  [57, "ScheduledTaskWebhooks", Migration0057],
  [58, "WebhookRelayDeliveries", Migration0058],
  [59, "McpAppModelContext", Migration0059],
  [60, "ThreadSnapshotWindowIndexes", Migration0060],
  [61, "PullRequestReviewGuides", Migration0061],
  [62, "ThreadFailureLookupIndex", Migration0062],
  [63, "AutomationRuns", Migration0063],
  [64, "CloudSessionOutbox", Migration0064],
  [65, "AutomationCloudRecords", Migration0065],
  [67, "CodexUsageNativeTurnIndex", Migration0067],
  [68, "WebhookDedupe", Migration0068],
  [69, "CanonicalizeThreadPullRequestLinks", Migration0069],
  [70, "AutomationRunWorkedMs", Migration0070],
  [72, "ActiveTurnItemIndexes", Migration0072],
  [73, "DropOrchestrationEventCorrelationIndex", Migration0073],
  [74, "DelegatedRecoveryIndexes", Migration0074],
  [75, "ProjectionProjectsPinArchive", Migration0075],
  [76, "ScheduledTaskRunCount", Migration0076],
  [77, "SubagentDeliveryState", Migration0077],
] as const;

export const migrationManifest = migrationEntries.map(([id, name]) => [id, name] as const);

/**
 * Ids no migration may ever take. Databases have recorded migrations above
 * each of them, and the migrator never runs an id below the highest one
 * recorded, so a migration given one would never run there and the V2 ledger
 * guard would refuse to start. 66: builds from main ran 67-69 above it, and the
 * 2026-10-28 lane builds recorded their own migrations at 66. 71: the
 * 2026-11-05 upstream sync numbered its migrations from 72, leaving 70 and 71 to
 * another change; main's 70 took one, and databases record 72-74 above 71. A new
 * migration, including one a branch numbered earlier, takes the id after the
 * highest.
 */
export const retiredMigrationIds: ReadonlyArray<number> = [66, 71];

const assertNoRetiredMigrationIds = Effect.fn("assertNoRetiredMigrationIds")(function* () {
  const misnumbered = migrationEntries.filter(([id]) => retiredMigrationIds.includes(id));
  if (misnumbered.length === 0) return;
  const nextId = Math.max(...migrationEntries.map(([id]) => id)) + 1;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This build gives migrations retired ids: ${misnumbered.map(([id, name]) => `${id}_${name}`).join(", ")}. Databases have already run migrations above them, so they would never run there. Renumber them to take ${nextId} onward.`,
  });
});

/** The newest migration this build has. */
const NEWEST_MIGRATION_ID = Math.max(...migrationEntries.map(([id]) => id));

/**
 * A database a newer build migrated, opened by an older one (a nightly's database under a stable build, a newer
 * desktop's under an older `caveman-code`): refused before anything runs, so the older build never writes to a
 * schema it does not know. T3 lets it start; we don't. The process exits 79 (SERVER_EXIT_CODE_DATABASE_NEWER) and
 * prints its name and message, which the desktop shows, and it stops restarting it. A MigrationError ("BadState", like
 * assertV2MigrationsCanRun's), so runMigrations' error channel stays as upstream.
 */
export class DatabaseNewerThanRuntime extends Migrator.MigrationError {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_DATABASE_NEWER;
  readonly databaseMigration: number;
  /** The build that last opened the database at that migration, when it recorded itself (recordWriter). */
  readonly databaseVersion: string | undefined;
  readonly runtimeMigration: number;
  readonly runtimeVersion: string;

  constructor(versions: {
    readonly databaseMigration: number;
    readonly databaseVersion?: string | undefined;
    readonly runtimeMigration: number;
    readonly runtimeVersion: string;
  }) {
    const by = versions.databaseVersion
      ? `Caveman Code ${versions.databaseVersion}`
      : "a newer Caveman Code";
    super({
      kind: "BadState",
      message: `This database was last used by ${by} (migration ${versions.databaseMigration}); this runtime is ${versions.runtimeVersion} (migration ${versions.runtimeMigration}) and won't open it. Update Caveman Code; nothing was changed.`,
    });
    this.databaseMigration = versions.databaseMigration;
    this.databaseVersion = versions.databaseVersion;
    this.runtimeMigration = versions.runtimeMigration;
    this.runtimeVersion = versions.runtimeVersion;
  }
}
// What a log line and the stack start with: the desktop looks for this name.
DatabaseNewerThanRuntime.prototype.name = "DatabaseNewerThanRuntime";

/** Fails with DatabaseNewerThanRuntime when the database records a migration newer than this build's newest. Reads only. */
const assertDatabaseNotNewer = Effect.fn("assertDatabaseNotNewer")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('effect_sql_migrations', 'caveman_database_writers')
  `;
  if (!tables.some((table) => table.name === "effect_sql_migrations")) return;
  const newest = yield* sql<{
    readonly id: number | null;
  }>`SELECT MAX(migration_id) AS id FROM effect_sql_migrations`;
  const databaseMigration = newest[0]?.id ?? 0;
  if (databaseMigration <= NEWEST_MIGRATION_ID) return;
  const writer = tables.some((table) => table.name === "caveman_database_writers")
    ? yield* sql<{
        readonly version: string;
      }>`SELECT version FROM caveman_database_writers WHERE migration_id = ${databaseMigration}`
    : [];
  return yield* new DatabaseNewerThanRuntime({
    databaseMigration,
    databaseVersion: writer[0]?.version,
    runtimeMigration: NEWEST_MIGRATION_ID,
    runtimeVersion: RUNTIME_VERSION,
  });
});

/**
 * This build as the last to open the database at its newest migration, for an older build's refusal to name. Not a
 * numbered migration: older builds ignore the table. A build that doesn't know its version (0.0.0, from source) leaves
 * no record, so the refusal says "a newer Caveman Code" rather than naming it.
 */
const recordWriter = Effect.fn("recordWriter")(function* () {
  if (RUNTIME_VERSION === "0.0.0") return;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS caveman_database_writers (migration_id INTEGER PRIMARY KEY, version TEXT NOT NULL)`;
  yield* sql`
    INSERT INTO caveman_database_writers (migration_id, version) VALUES (${NEWEST_MIGRATION_ID}, ${RUNTIME_VERSION})
    ON CONFLICT (migration_id) DO UPDATE SET version = excluded.version
  `;
});

const makeMigrationLoader = (throughId?: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      migrationEntries
        .filter(([id]) => throughId === undefined || id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

// V2's schema migrations start at 55 after the legacy schema migrations.
const FIRST_V2_MIGRATION_ID = 55;

/**
 * Fail before migrating when the migrator would skip one of V2's own
 * migrations. It skips every id up to the highest recorded one, whatever name
 * was recorded, so a database that took a V2 id for another migration would
 * start without V2's schema and fail on first use. Earlier ids keep the
 * warning below: databases with a site-local migration there still work.
 */
const assertV2MigrationsCanRun = Effect.fn("assertV2MigrationsCanRun")(function* (
  throughId?: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
  `;
  if (tables.length === 0) return;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const latestRecordedId = Math.max(0, ...recorded.map((row) => row.migration_id));
  const recordedNames = new Map(recorded.map((row) => [row.migration_id, row.name]));
  const skipped = migrationEntries.flatMap(([id, name]) => {
    if (
      id < FIRST_V2_MIGRATION_ID ||
      id > latestRecordedId ||
      (throughId !== undefined && id > throughId)
    )
      return [];
    const recordedName = recordedNames.get(id);
    if (recordedName === name) return [];
    return [`${id}_${name} (recorded: ${recordedName ?? "nothing"})`];
  });
  if (skipped.length === 0) return;
  return yield* new Migrator.MigrationError({
    kind: "BadState",
    message: `This database's migration history would skip required schema migrations: ${skipped.join(", ")}. The migrator skips every id up to the highest recorded id (${latestRecordedId}), regardless of name. It was probably written by a different build. Start the build that wrote it, or report this migration history so an upgrade path can be added.`,
  });
});

/**
 * Migrator run function - no schema dumping needed
 * Uses the base Migrator.make without platform dependencies
 */
const run = Migrator.make({});

export interface RunMigrationsOptions {
  readonly toMigrationInclusive?: number | undefined;
}

/**
 * Run all pending migrations.
 *
 * Creates the migrations tracking table (effect_sql_migrations) if it doesn't exist,
 * then runs any migrations with ID greater than the latest recorded migration.
 *
 * Returns array of [id, name] tuples for migrations that were run.
 *
 * @returns Effect containing array of executed migrations
 */
export const runMigrations = Effect.fn("runMigrations")(function* ({
  toMigrationInclusive,
}: RunMigrationsOptions = {}) {
  // A fresh install runs a migration at a retired id without error and only
  // upgraded databases refuse it, so check before touching any database.
  yield* assertNoRetiredMigrationIds();
  // Before anything writes: a newer build's database is left as it is.
  yield* assertDatabaseNotNewer();
  const includesV2 =
    toMigrationInclusive === undefined || toMigrationInclusive >= FIRST_V2_MIGRATION_ID;
  const previewMigrations = includesV2 ? yield* reconcileV2PreviewMigration() : [];
  if (includesV2) {
    yield* assertV2MigrationsCanRun(toMigrationInclusive);
  }
  const executedMigrations = [
    ...previewMigrations,
    ...(yield* run({ loader: makeMigrationLoader(toMigrationInclusive) })),
  ];
  const migrations = executedMigrations.map(([id, name]) => `${id}_${name}`);
  yield* migrations.length === 0
    ? Effect.logDebug("Database schema is current")
    : Effect.log("Migrations ran successfully").pipe(Effect.annotateLogs({ migrations }));

  // The migrator keys on migration_id: a database that recorded a different
  // migration under a shared id (local or fork builds) keeps that id and
  // silently skips this build's migration at it. Surface the divergence so the
  // skipped schema change is diagnosable.
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{
    readonly migration_id: number;
    readonly name: string;
  }>`SELECT migration_id, name FROM effect_sql_migrations`;
  const manifestNames = new Map<number, string>(migrationEntries.map(([id, name]) => [id, name]));
  const divergent = recorded.flatMap((row) => {
    const expected = manifestNames.get(row.migration_id);
    if (expected === undefined) {
      return [`${row.migration_id}:${row.name} (unknown to this build)`];
    }
    return expected === row.name
      ? []
      : [`${row.migration_id}:${row.name} (this build: ${expected})`];
  });
  if (divergent.length > 0) {
    yield* Effect.logWarning(
      "Database migration history diverges from this build; recorded migration ids are skipped, not reconciled by name.",
    ).pipe(Effect.annotateLogs({ divergent }));
  }
  if (toMigrationInclusive === undefined) yield* recordWriter();
  return executedMigrations;
});
