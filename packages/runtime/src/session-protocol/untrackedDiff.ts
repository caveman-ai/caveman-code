// fs.diff's new files: each untracked file's patch against nothing, as `git diff --no-index /dev/null <file>` writes it.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Effect from "effect/Effect";

import { toolsIndex, toolsSocket } from "../cloudLink/tools.ts";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { git } from "./lifecycle.ts";
import { PARSEABLE_DIFF, splitDiffSections } from "./diffSections.ts";

type Git = GitVcsDriver.GitVcsDriver["Service"];

/** Up to this many new files, each is its own `git diff --no-index`; past it, one batch answers them all. */
export const UNTRACKED_ONE_BY_ONE = 3;

export interface UntrackedPatch {
  readonly path: string;
  readonly patch: string;
}

const onePatch = (driver: Git, worktree: string, file: string) =>
  git(driver, worktree, [...PARSEABLE_DIFF, "--no-index", "--", "/dev/null", file], {
    allowNonZeroExit: true,
  }).pipe(
    Effect.map(
      (result): UntrackedPatch => ({ path: file, patch: result.stdout }),
    ),
  );

const oneByOne = (
  driver: Git,
  worktree: string,
  files: ReadonlyArray<string>,
) =>
  Effect.forEach(files, (file) => onePatch(driver, worktree, file), {
    concurrency: 8,
  });

/**
 * The files are added with --intent-to-add to an empty, throwaway index, so a plain `git diff` (index against the
 * working tree) writes each one as a new file, byte for byte what `--no-index /dev/null <file>` writes, in three git
 * runs whatever their number; one run per file took seconds for a turn that wrote a few hundred files. The batch
 * answers in numstat's order, which lines its patches up with exact (-z) paths; a file it misses, or a batch that
 * fails, is asked for on its own as before.
 */
export const untrackedPatches = (
  driver: Git,
  worktree: string,
  files: ReadonlyArray<string>,
): Effect.Effect<ReadonlyArray<UntrackedPatch>, Error> => {
  if (files.length <= UNTRACKED_ONE_BY_ONE)
    return oneByOne(driver, worktree, files);
  // On a Cloud computer git runs in the tools container, whose temporary directory is not the runtime's.
  const tools = toolsSocket();
  const tempIndex =
    tools === undefined
      ? Effect.acquireRelease(
          Effect.sync(() =>
            path.join(
              fs.mkdtempSync(path.join(os.tmpdir(), "caveman-untracked-")),
              "index",
            ),
          ),
          (index) =>
            Effect.sync(() =>
              fs.rmSync(path.dirname(index), { recursive: true, force: true }),
            ),
        )
      : Effect.map(toolsIndex(tools), (index) => index.path);
  const batch = Effect.scoped(
    Effect.gen(function* () {
      const env = { GIT_INDEX_FILE: yield* tempIndex };
      yield* git(
        driver,
        worktree,
        [
          "--literal-pathspecs",
          "add",
          "--intent-to-add",
          "--pathspec-from-file=-",
          "--pathspec-file-nul",
        ],
        { env, stdin: `${files.join("\0")}\0` },
      );
      const [numstat, whole] = yield* Effect.all(
        [
          git(driver, worktree, [...PARSEABLE_DIFF, "--no-renames", "--numstat", "-z"], {
            env,
          }),
          git(driver, worktree, [...PARSEABLE_DIFF, "--no-renames"], { env }),
        ],
        { concurrency: 2 },
      );
      const paths = numstat.stdout
        .split("\0")
        .filter(Boolean)
        .map((line) => line.split("\t").slice(2).join("\t"));
      const sections = splitDiffSections(whole.stdout);
      const byPath = new Map<string, string>();
      if (paths.length === sections.length)
        paths.forEach((file, i) => byPath.set(file, sections[i]!));
      return yield* Effect.forEach(
        files,
        (file) => {
          const patch = byPath.get(file);
          return patch === undefined
            ? onePatch(driver, worktree, file)
            : Effect.succeed({ path: file, patch });
        },
        { concurrency: 8 },
      );
    }),
  );
  return batch.pipe(Effect.catch(() => oneByOne(driver, worktree, files)));
};
