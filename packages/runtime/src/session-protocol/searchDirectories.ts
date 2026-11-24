// Directory candidates for fs.search's opt-in folder mentions. Kept separate from
// WorkspaceEntries: its native index ranks/limits before our project hidden paths apply.
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { IgnoreMatcher } from "@caveman-app/shared/ignorePaths";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { git, LifecycleError } from "./lifecycle.ts";

const IGNORE_CHECK_CHUNK_SIZE = 1000;

/**
 * Walk directories only, pruning before descent. Git owns gitignore semantics (including nested rules,
 * global excludes and negation); the same project matcher as file search owns the other hidden paths.
 * A tracked file can live under an ignored directory: keep its ancestors, but not ignored siblings.
 */
export const searchDirectories = (
  driver: GitVcsDriver.GitVcsDriver["Service"],
  worktree: string,
  files: ReadonlyArray<string>,
  hidden: IgnoreMatcher,
) =>
  Effect.gen(function* () {
    const filePaths = new Set(files);
    const ancestors = new Set<string>();
    for (const file of files) {
      for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1)) ancestors.add(file.slice(0, at));
    }
    const root = yield* Effect.tryPromise({
      try: () => fs.realpath(worktree),
      catch: (error) => new LifecycleError(`Could not resolve ${worktree}: ${error}`),
    });
    const children = (directory: string) =>
      Effect.tryPromise({
        try: async () => {
          const absolute = path.join(root, directory);
          try {
            // Do not follow a directory replaced by a symlink since its parent was read, either.
            if ((await fs.realpath(absolute)) !== absolute) return [];
            return (await fs.readdir(absolute, { withFileTypes: true }))
              .filter((entry) => entry.isDirectory() && entry.name !== ".git")
              .map((entry) => (directory === "" ? entry.name : `${directory}/${entry.name}`))
              .filter((relative) => !hidden(relative, true));
          } catch (error) {
            // A disappearing or unreadable folder must not break every @ mention in the checkout.
            if (["ENOENT", "ENOTDIR", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
            throw error;
          }
        },
        catch: (error) => new LifecycleError(`Could not search directories in ${worktree}: ${error}`),
      });

    const directories: string[] = [];
    let pending = [""];
    while (pending.length > 0) {
      const candidates = (yield* Effect.forEach(pending, children, { concurrency: 16 })).flat();
      pending = [];
      for (let offset = 0; offset < candidates.length; offset += IGNORE_CHECK_CHUNK_SIZE) {
        const batch = candidates.slice(offset, offset + IGNORE_CHECK_CHUNK_SIZE);
        const result = yield* git(driver, worktree, ["check-ignore", "--no-index", "-z", "--stdin"], {
          allowNonZeroExit: true,
          // NULs preserve whitespace, newlines and git's quote-worthy characters; --no-index
          // avoids pathspec magic. Use the real directory path without a trailing slash: git
          // otherwise lets "parent/*" match "parent/" and prevents valid negated children.
          stdin: `${batch.join("\0")}\0`,
        });
        if (result.exitCode !== 0 && result.exitCode !== 1) return yield* Effect.fail(new LifecycleError(result.stderr || "git check-ignore failed"));
        const ignored = new Set(result.stdout.split("\0"));
        for (const relative of batch) {
          if (ignored.has(relative) && !ancestors.has(relative)) continue;
          directories.push(`${relative}/`);
          // A gitlink is a directory on disk but a file in ls-files. Mention the folder, never
          // recursively walk another repository (or its potentially enormous ignored dependency tree).
          if (!filePaths.has(relative)) pending.push(relative);
        }
      }
    }
    return directories;
  });
