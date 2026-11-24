// ), apps/server/src/persistence/initializeV2Database.ts @ ab3a3cd1; abandoned copies from 293669d759.
import * as NodeSqlite from "node:sqlite";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export class V2DatabaseImportError extends Schema.TaggedError<V2DatabaseImportError>()(
  "V2DatabaseImportError",
  { sourcePath: Schema.String, destinationPath: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return `Could not copy the V1 database at ${this.sourcePath} to ${this.destinationPath}. The V1 database has not been migrated.`;
  }
}

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

// A copy being written changes every few seconds while its backup runs.
const ABANDONED_AFTER_MS = 60 * 60 * 1000;

/**
 * Removes the copies a killed start left beside the database. A copy stays while the process
 * its name carries is alive, or while anything in it changed in the last hour: a runtime in
 * another PID namespace, or an older build whose copies carry no process id, may still be
 * writing it.
 */
const removeAbandonedCopies = Effect.fn("removeAbandonedCopies")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fs.readDirectory(directory).pipe(
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed([]),
    ),
  );
  for (const entry of entries) {
    const copy = /^\.v2-import-(?:(\d+)-)?[A-Za-z0-9]{6}$/.exec(entry);
    if (copy === null || (copy[1] !== undefined && isProcessAlive(Number(copy[1])))) continue;
    const copyPath = path.join(directory, entry);
    yield* Effect.gen(function* () {
      const files = (yield* fs.readDirectory(copyPath)).map((name) => path.join(copyPath, name));
      let lastChangeMs = 0;
      for (const file of [copyPath, ...files]) {
        const { mtime } = yield* fs.stat(file);
        if (Option.isSome(mtime)) lastChangeMs = Math.max(lastChangeMs, mtime.value.getTime());
      }
      if ((yield* Clock.currentTimeMillis) - lastChangeMs < ABANDONED_AFTER_MS) return;
      yield* fs.remove(copyPath, { recursive: true });
    }).pipe(
      // Its own process may have just finished and removed it.
      Effect.ignore({ log: true }),
    );
  }
});

/** Seed V2 once. Its copied legacy tables remain the source for lazy transcript import. */
export const initializeV2Database = Effect.fn("initializeV2Database")(function* (
  destinationPath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(destinationPath);
  const sourcePath = path.join(directory, "state.sqlite");
  yield* removeAbandonedCopies(directory).pipe(Effect.ignore({ log: true }));
  yield* Effect.gen(function* () {
    if (yield* fs.exists(destinationPath)) return;
    if (!(yield* fs.exists(sourcePath))) return;
    const temporaryDirectory = yield* fs.makeTempDirectoryScoped({
      directory,
      // The process id tells a later start whether this copy is still being written.
      prefix: `.v2-import-${process.pid}-`,
    });
    const snapshotPath = path.join(temporaryDirectory, "snapshot.sqlite");
    yield* Effect.tryPromise(async () => {
      const database = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
      try {
        await NodeSqlite.backup(database, snapshotPath);
      } finally {
        database.close();
      }
    });
    // Publish only a complete snapshot, without replacing an existing V2 database.
    yield* fs
      .link(snapshotPath, destinationPath)
      .pipe(
        Effect.catch((error) =>
          error.reason._tag === "AlreadyExists" ? Effect.void : Effect.fail(error),
        ),
      );
  }).pipe(
    Effect.scoped,
    Effect.mapError((cause) => new V2DatabaseImportError({ sourcePath, destinationPath, cause })),
  );
});
