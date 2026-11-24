// ), apps/server/src/vcs/worktreeRemoval.ts @ fa42465ff6.
import { randomUUID } from "node:crypto";
import { GitCommandError } from "@caveman-app/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import type * as GitVcsDriver from "./GitVcsDriver.ts";

const INDEX_LIST_MAX_BYTES = 64 * 1024 * 1024;

/** Where a repository's removed worktrees wait to be deleted: in its common git dir, so a rename gets them there. */
const TRASH = "caveman-trash";
/**
 * In the trash, the worktrees Git has not yet let go: never swept, as one may still go back. What a stopped runtime
 * left there recoverWorktreeTrash finishes.
 */
const PENDING = "pending";

// One deletion at a time across every repository: a worktree with its dependencies is ~200k files, and many deleted
// at once (Archive all) starve each other of the disk.
const emptying = Semaphore.makeUnsafe(1);

/**
 * Deletes the worktrees Git let go in `commonDir`'s trash, its own and any a stopped runtime left there. Background
 * work: a folder that will not go now stays for the next removal in that repository to try again.
 */
export const emptyWorktreeTrash = (commonDir: string) =>
  emptying.withPermits(1)(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const trash = path.join(commonDir, TRASH);
      for (const name of yield* fileSystem
        .readDirectory(trash)
        .pipe(Effect.orElseSucceed(() => []))) {
        if (name === PENDING) continue;
        yield* fileSystem.remove(path.join(trash, name), { recursive: true }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("could not delete a removed worktree", {
              path: path.join(trash, name),
              error,
            }),
          ),
        );
      }
    }),
  );

const recovered = new Map<string, Deferred.Deferred<void>>();

/**
 * Finishes the removals a stopped runtime left pending in `commonDir`'s trash, once per repository and process, before
 * this process first adds or removes a worktree there (so none of its own removals is pending yet). Each had passed
 * Git's checks and only its metadata was left: `prune` (`git worktree prune`) drops a registration whose folder is gone,
 * one Git let go (its admin directory, named by the folder's `.git`, gone) is deleted, and one Git still keeps (a
 * locked worktree) stays pending. Without this Git keeps the registration and refuses that branch's next worktree.
 */
export const recoverWorktreeTrash = <E, R>(
  commonDir: string,
  prune: Effect.Effect<unknown, E, R>,
): Effect.Effect<void, never, R | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const key = path.resolve(commonDir);
    const known = recovered.get(key);
    if (known !== undefined) return yield* Deferred.await(known);
    const done = Deferred.makeUnsafe<void>();
    recovered.set(key, done);
    const trash = path.join(key, TRASH);
    const pending = path.join(trash, PENDING);
    const adminDirOf = (name: string) =>
      fileSystem.readFileString(path.join(pending, name, ".git")).pipe(
        Effect.map((pointer) => pointer.trim()),
        Effect.map((pointer) =>
          pointer.startsWith("gitdir:")
            ? path.resolve(pending, name, pointer.slice("gitdir:".length).trim())
            : null,
        ),
        Effect.orElseSucceed(() => null),
      );
    const registered = (name: string) =>
      adminDirOf(name).pipe(
        Effect.flatMap((adminDir) =>
          adminDir === null ? Effect.succeed(true) : fileSystem.exists(adminDir),
        ),
        Effect.orElseSucceed(() => true),
      );
    yield* Effect.gen(function* () {
      const names = yield* fileSystem.readDirectory(pending).pipe(Effect.orElseSucceed(() => []));
      if (names.length === 0) return;
      const held = yield* Effect.filter(names, registered);
      if (held.length > 0) yield* prune.pipe(Effect.ignore);
      let letGo = false;
      for (const name of names) {
        if (yield* registered(name)) {
          yield* Effect.logWarning(
            "a pending worktree removal stays: git still keeps the worktree",
            {
              path: path.join(pending, name),
            },
          );
          continue;
        }
        yield* fileSystem.rename(path.join(pending, name), path.join(trash, name)).pipe(
          Effect.tap(() => Effect.sync(() => (letGo = true))),
          Effect.ignore,
        );
      }
      if (letGo) yield* emptyWorktreeTrash(key).pipe(Effect.forkDetach);
    }).pipe(Effect.ensuring(Deferred.succeed(done, undefined)));
  });

/**
 * Removes the linked worktree at `worktreePath`, through `run` for Git's own steps.
 *
 * Git deletes a worktree's files before `git worktree remove` returns, and a checkout with its dependencies takes
 * seconds alone and minutes beside others. So this makes the checks `git worktree remove` makes before deleting
 * (builtin/worktree.c), renames the folder into the repository's trash, has Git drop the now-missing worktree's
 * metadata, and deletes the folder in the background. Where the rename cannot be made (another volume, or a file held
 * open on Windows) it deletes the folder in place first, as before.
 *
 * Either way Git never deletes the files: Git for Windows before 2.54 follows NTFS junctions while it deletes a
 * worktree, and deletes what they point to, such as a shared node_modules; later versions leave them behind. Node's
 * `rm` unlinks junctions and links without following them.
 */
export const removeLinkedWorktree = Effect.fn("WorktreeRemoval.removeLinkedWorktree")(function* <
  A,
  E,
  R,
>(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly worktreePath: string;
  readonly force: boolean;
  readonly execute: GitVcsDriver.GitVcsDriver["Service"]["execute"];
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<A, E, R>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const worktreePath = input.worktreePath;
  const gitFile = path.join(worktreePath, ".git");
  // Git refuses to remove a worktree with untracked files unless forced, but
  // its check honors `status.showUntrackedFiles=no` and would delete them.
  const statusConfig = ["-c", "status.showUntrackedFiles=normal"];
  const linked = yield* fileSystem.stat(gitFile).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
  if (!linked) {
    return yield* input.run([
      ...statusConfig,
      "worktree",
      "remove",
      ...(input.force ? ["--force"] : []),
      "--",
      worktreePath,
    ]);
  }

  // Git's own refusals, worded the way it prints them.
  const refuse = (message: string, cause?: unknown) =>
    new GitCommandError({
      operation: input.operation,
      command: "git worktree remove",
      cwd: input.cwd,
      detail: `fatal: ${message}`,
      ...(cause === undefined ? {} : { cause }),
    });
  const gitOutput = (cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
    input
      .execute({
        operation: input.operation,
        cwd,
        args,
        maxOutputBytes: INDEX_LIST_MAX_BYTES,
        ...(env === undefined ? {} : { env }),
      })
      .pipe(Effect.map((result) => result.stdout));
  const samePath = (left: string, right: string) =>
    Effect.all([fileSystem.realPath(left), fileSystem.realPath(right)]).pipe(
      Effect.map(([a, b]) => a.toLowerCase() === b.toLowerCase()),
      Effect.orElseSucceed(() => false),
    );

  // A registered worktree of this repository: its `.git` file names an admin
  // directory under the common `worktrees/`, whose `gitdir` points back.
  const notAWorktree = refuse(`'${worktreePath}' is not a working tree`);
  const adminDir = path.resolve(
    worktreePath,
    (yield* gitOutput(worktreePath, ["rev-parse", "--absolute-git-dir"]).pipe(
      Effect.mapError(() => notAWorktree),
    )).trim(),
  );
  const commonDir = path.resolve(
    input.cwd,
    (yield* gitOutput(input.cwd, ["rev-parse", "--git-common-dir"])).trim(),
  );
  const pointsBack = yield* fileSystem.readFileString(path.join(adminDir, "gitdir")).pipe(
    Effect.flatMap((gitdir) => samePath(path.resolve(adminDir, gitdir.trim()), gitFile)),
    Effect.orElseSucceed(() => false),
  );
  if (!pointsBack || !(yield* samePath(path.dirname(adminDir), path.join(commonDir, "worktrees"))))
    return yield* notAWorktree;
  // Git counts the file's existence as a lock. T3 passes at most one
  // `--force`, which never removes a locked worktree. Anything but a
  // confirmed absence refuses.
  const lockFile = path.join(adminDir, "locked");
  const locked = yield* fileSystem.stat(lockFile).pipe(
    Effect.as(true),
    Effect.catch((error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed(false)
        : Effect.fail(refuse(`cannot inspect the lock of '${worktreePath}'`, error)),
    ),
  );
  if (locked) {
    const reason = (yield* fileSystem.readFileString(lockFile).pipe(Effect.option)).pipe(
      Option.map((text) => text.trim()),
      Option.getOrElse(() => ""),
    );
    return yield* refuse(
      reason === ""
        ? "cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"
        : `cannot remove a locked working tree, lock reason: ${reason}\nuse 'remove -f -f' to override or unlock first`,
    );
  }
  if (!input.force) {
    // Bound like Git's own check, so `core.worktree` can't point it elsewhere.
    const boundEnv = { GIT_DIR: gitFile, GIT_WORK_TREE: worktreePath };
    const submodules = refuse("working trees containing submodules cannot be moved or removed");
    // An unreadable path counts as present, so a doubt refuses.
    const present = (target: string) =>
      fileSystem.exists(target).pipe(Effect.orElseSucceed(() => true));
    if (yield* present(path.join(adminDir, "modules"))) return yield* submodules;
    const index = yield* gitOutput(worktreePath, ["ls-files", "--stage", "-z"], boundEnv);
    for (const entry of index.split("\0")) {
      if (!entry.startsWith("160000 ")) continue;
      const submodule = entry.slice(entry.indexOf("\t") + 1);
      if (yield* present(path.join(worktreePath, submodule, ".git"))) return yield* submodules;
    }
    const status = yield* gitOutput(
      worktreePath,
      [...statusConfig, "status", "--porcelain", "--ignore-submodules=none"],
      boundEnv,
    );
    if (status !== "")
      return yield* refuse(
        `'${worktreePath}' contains modified or untracked files, use --force to delete it`,
      );
  }

  const gitFileContents = yield* fileSystem
    .readFileString(gitFile)
    .pipe(Effect.mapError(() => notAWorktree));
  yield* recoverWorktreeTrash(
    commonDir,
    input.execute({ operation: input.operation, cwd: input.cwd, args: ["worktree", "prune"] }),
  ).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  const trash = path.join(commonDir, TRASH);
  const name = `${path.basename(worktreePath)}-${randomUUID().slice(0, 8)}`;
  const aside = path.join(trash, PENDING, name);
  const movedAside = yield* fileSystem.makeDirectory(path.dirname(aside), { recursive: true }).pipe(
    Effect.andThen(fileSystem.rename(worktreePath, aside)),
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );
  if (!movedAside) {
    // A file held open can stop the delete partway. Putting `.git` back, when
    // that works, leaves a worktree that a retry can remove.
    yield* fileSystem.remove(worktreePath, { recursive: true }).pipe(
      Effect.tapError(() =>
        fileSystem.writeFileString(gitFile, gitFileContents).pipe(Effect.ignore),
      ),
      Effect.mapError((cause) => refuse(`failed to delete '${worktreePath}'`, cause)),
    );
  }
  // The folder is gone, so Git only drops the worktree's metadata. Unless Git dropped it (its admin directory gone; a
  // `run` may answer a refusal with its exit code), the folder comes back from the trash: the worktree stays as it
  // was, for a retry.
  const putBack = movedAside
    ? fileSystem.rename(aside, worktreePath).pipe(Effect.ignore)
    : Effect.void;
  const result = yield* input
    .run(["worktree", "remove", "--force", "--force", "--", worktreePath])
    .pipe(Effect.onError(() => putBack));
  if (!movedAside) return result;
  if (yield* fileSystem.exists(adminDir).pipe(Effect.orElseSucceed(() => true))) {
    // Git kept it, whatever `run` answered: a failure, so no caller goes on as if it were gone.
    yield* putBack;
    return yield* refuse(`git kept '${worktreePath}' registered`);
  }
  // Git let it go: only now can a sweep take it. Should this rename fail, it stays pending, kept.
  yield* fileSystem.rename(aside, path.join(trash, name)).pipe(Effect.ignore);
  yield* emptyWorktreeTrash(commonDir).pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
    Effect.forkDetach,
  );
  return result;
});
