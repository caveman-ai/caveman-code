// ), apps/server/src/persistence/DatabaseStorage.ts @ 5752253818.
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import { forkParked } from "../serverActivation.ts";

/** Pages returned per reclaim pass; one minute of churn, not a backlog. */
const RECLAIM_PAGES_PER_PASS = 1024;
const COMPACTION_INTERVAL = Duration.hours(6);

export class DatabaseStorage extends Context.Service<
  DatabaseStorage,
  {
    /** Return free pages to the filesystem on databases with incremental auto_vacuum. */
    readonly reclaim: Effect.Effect<void>;
  }
>()("t3/persistence/DatabaseStorage") {}

/**
 * Prunes event history the projections already cover every few hours and
 * hands freed pages back to the filesystem every minute. ProjectionMaintenance
 * says what is kept and publishes the pruned-through boundary that sends an
 * older replay cursor to a snapshot.
 */
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Only VACUUM changes auto_vacuum, and nothing runs one while the runtime has the database open.
  let incrementalVacuum: boolean | undefined;
  const readIncrementalVacuum = Effect.suspend(() =>
    incrementalVacuum !== undefined
      ? Effect.succeed(incrementalVacuum)
      : Effect.map(
          sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`,
          (mode) => (incrementalVacuum = mode[0]?.auto_vacuum === 2),
        ),
  );

  const reclaim = Effect.gen(function* () {
    if (!(yield* readIncrementalVacuum)) return;
    // The driver steps a statement without result columns once, and each
    // step of incremental_vacuum frees one page. Yield between pages so
    // client requests can run.
    for (let page = 0; page < RECLAIM_PAGES_PER_PASS; page++) {
      const free = yield* sql<{ readonly freelist_count: number }>`PRAGMA freelist_count`;
      if ((free[0]?.freelist_count ?? 0) === 0) break;
      yield* sql`PRAGMA incremental_vacuum(1)`;
      yield* Effect.yieldNow;
    }
  }).pipe(
    Effect.catch((cause) => Effect.logWarning("Database space reclamation failed", { cause })),
  );

  // Even a pass that deletes nothing scans the event store. Persist completion
  // so restarting does not trigger another scan before the six-hour interval.
  const compactedAtPath = path.join(path.dirname(config.dbPath), "compacted-at");
  const compact = Effect.gen(function* () {
    let sliceStarted = yield* Clock.monotonicTimeNanos;
    const betweenPages = Effect.gen(function* () {
      const elapsed = (yield* Clock.monotonicTimeNanos) - sliceStarted;
      if (elapsed < 25_000_000n) return;
      // Keep background maintenance at 10% duty, including pages that exceed the budget.
      yield* Effect.sleep((Number(elapsed) / 1_000_000) * 9);
      sliceStarted = yield* Clock.monotonicTimeNanos;
    });
    const result = yield* maintenance.pruneEventStore(betweenPages);
    const completedAt = yield* Clock.currentTimeMillis;
    yield* fs.writeFileString(compactedAtPath, String(completedAt)).pipe(Effect.ignore);
    if (result.deletedEventCount > 0 || result.deletedReceiptCount > 0) {
      yield* Effect.logInfo("Compacted orchestration history", result);
    }
  }).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Orchestration history compaction failed", { cause }),
    ),
  );
  const lastCompactedAt = yield* fs.readFileString(compactedAtPath).pipe(
    Effect.map(Number),
    Effect.orElseSucceed(() => Number.NaN),
  );
  const intervalMs = Duration.toMillis(COMPACTION_INTERVAL);
  const untilDueMs = Number.isFinite(lastCompactedAt)
    ? lastCompactedAt + intervalMs - (yield* Clock.currentTimeMillis)
    : 0;
  const firstCompactionDelay = Duration.millis(
    Math.min(intervalMs, Math.max(Duration.toMillis(Duration.minutes(1)), untilDueMs)),
  );

  yield* forkParked(
    Effect.sleep(firstCompactionDelay).pipe(
      Effect.andThen(compact.pipe(Effect.repeat(Schedule.spaced(COMPACTION_INTERVAL)))),
    ),
  );
  yield* forkParked(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(reclaim.pipe(Effect.repeat(Schedule.spaced("1 minute")))),
    ),
  );

  return DatabaseStorage.of({ reclaim });
});

export const layer = Layer.effect(DatabaseStorage, make);
