// ), apps/server/src/checkpointing/CheckpointStore.ts @ ab3a3cd1; perf from 87ae8d5815.
/**
 * CheckpointStore - Repository interface for filesystem-backed workspace checkpoints.
 *
 * Owns hidden Git-ref checkpoint capture/restore and diff computation for a
 * workspace thread timeline. It does not store user-facing checkpoint metadata
 * and does not coordinate provider conversation rollback.
 *
 * The live adapter resolves the active VCS driver once per checkpoint operation
 * and delegates to the driver's optional checkpoint capability.
 *
 * Uses Effect `Context.Service` for dependency injection and exposes typed
 * domain errors for checkpoint storage operations.
 *
 * @module CheckpointStore
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  CheckpointRef,
  VcsProcessExitError,
  VcsUnsupportedOperationError,
} from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { CheckpointStoreError } from "./Errors.ts";
import { prefixNumstat, prefixPatch, readSourceRoot, splitSourcePath } from "./SourceRoots.ts";
import type { VcsCheckpointOps } from "../vcs/VcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

export interface CaptureCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  /** The worktree is freshly made: when it is verifiably clean, the checkpoint is HEAD's own tree (no snapshot). */
  readonly fresh?: boolean;
}

export interface RestoreCheckpointInput {
  readonly cwd: string;
  readonly checkpointRef: CheckpointRef;
  readonly fallbackToHead?: boolean;
  /** Only make the restore's checks, failing as it would (ignored files in its way); nothing changes. */
  readonly dryRun?: boolean;
}

export interface DiffCheckpointsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
  readonly fallbackFromToHead?: boolean;
  readonly ignoreWhitespace: boolean;
  readonly format?: "patch" | "numstat";
  /** Maximum bytes collected from the diff command. */
  readonly maxOutputBytes?: number;
  /** Limits the diff to these exact paths. An empty list yields an empty diff. */
  readonly filePaths?: ReadonlyArray<string>;
}

export interface ListAuthoredPathsInput {
  readonly cwd: string;
  readonly fromCheckpointRef: CheckpointRef;
  readonly toCheckpointRef: CheckpointRef;
}

export interface DeleteCheckpointRefsInput {
  readonly cwd: string;
  readonly checkpointRefs: ReadonlyArray<CheckpointRef>;
}

/** Service tag for checkpoint persistence and restore operations. */
export class CheckpointStore extends Context.Service<
  CheckpointStore,
  {
    /** Check whether cwd is inside a Git worktree. */
    readonly isGitRepository: (cwd: string) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Capture a checkpoint commit and store it at the provided checkpoint ref.
     *
     * Uses an isolated temporary Git index and writes a hidden ref.
     */
    readonly captureCheckpoint: (
      input: CaptureCheckpointInput,
    ) => Effect.Effect<void, CheckpointStoreError>;

    /** Check whether a checkpoint ref exists. */
    readonly hasCheckpointRef: (
      input: Omit<RestoreCheckpointInput, "fallbackToHead" | "dryRun">,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Restore workspace and staging state to a checkpoint.
     *
     * Optionally falls back to current `HEAD` when the checkpoint ref is missing.
     */
    readonly restoreCheckpoint: (
      input: RestoreCheckpointInput,
    ) => Effect.Effect<boolean, CheckpointStoreError>;

    /**
     * Compute a diff between two checkpoint refs. Defaults to a full patch.
     *
     * Numstat output has NUL-delimited paths for file summaries.
     * Can optionally treat a missing "from" ref as `HEAD`.
     */
    readonly diffCheckpoints: (
      input: DiffCheckpointsInput,
    ) => Effect.Effect<string, CheckpointStoreError>;

    /**
     * List paths changed by work done after the "from" checkpoint: uncommitted
     * edits at either checkpoint, commits made after "from", and commits that
     * left HEAD. Commits a pull, merge, or rebase brought in are older than
     * "from", so their paths are not listed.
     *
     * Returns null when HEAD did not move or a checkpoint does not record HEAD.
     * Then every changed path belongs to the turn.
     */
    readonly listAuthoredPaths: (
      input: ListAuthoredPathsInput,
    ) => Effect.Effect<ReadonlySet<string> | null, CheckpointStoreError>;

    /**
     * Delete the provided checkpoint refs.
     *
     * Best-effort delete: missing refs are tolerated.
     */
    readonly deleteCheckpointRefs: (
      input: DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, CheckpointStoreError>;
  }
>()("t3/checkpointing/CheckpointStore") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;

  const resolveCheckpoints = Effect.fn("CheckpointStore.resolveCheckpoints")(function* (
    operation: string,
    cwd: string,
  ) {
    const handle = yield* vcsRegistry.resolve({ cwd });
    if (!handle.driver.checkpoints) {
      return yield* new VcsUnsupportedOperationError({
        operation,
        kind: handle.kind,
        detail: `${handle.kind} driver does not implement checkpoint operations.`,
      });
    }
    return handle.driver.checkpoints satisfies VcsCheckpointOps;
  });

  const isGitRepository: CheckpointStore["Service"]["isGitRepository"] = (cwd) =>
    vcsRegistry
      .detect({ cwd, requestedKind: "git" })
      .pipe(Effect.map((repository) => repository !== null));

  const captureCheckpoint: CheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "captureCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.captureCheckpoint", input.cwd);
    return yield* checkpoints.captureCheckpoint(input);
  });

  const hasCheckpointRef: CheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "hasCheckpointRef",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.hasCheckpointRef", input.cwd);
    return yield* checkpoints.hasCheckpointRef(input);
  });

  const restoreCheckpoint: CheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "restoreCheckpoint",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.restoreCheckpoint", input.cwd);
    return yield* checkpoints.restoreCheckpoint(input);
  });

  const diffCheckpoints: CheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "diffCheckpoints",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.diffCheckpoints", input.cwd);
    return yield* checkpoints.diffCheckpoints(input);
  });

  const listAuthoredPaths: CheckpointStore["Service"]["listAuthoredPaths"] = Effect.fn(
    "listAuthoredPaths",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints("CheckpointStore.listAuthoredPaths", input.cwd);
    return yield* checkpoints.listAuthoredPaths(input);
  });

  const deleteCheckpointRefs: CheckpointStore["Service"]["deleteCheckpointRefs"] = Effect.fn(
    "deleteCheckpointRefs",
  )(function* (input) {
    const checkpoints = yield* resolveCheckpoints(
      "CheckpointStore.deleteCheckpointRefs",
      input.cwd,
    );
    return yield* checkpoints.deleteCheckpointRefs(input);
  });

  const single: CheckpointStore["Service"] = {
    isGitRepository,
    captureCheckpoint,
    hasCheckpointRef,
    restoreCheckpoint,
    diffCheckpoints,
    listAuthoredPaths,
    deleteCheckpointRefs,
  };
  return CheckpointStore.of(overSources(single));
});

/**
 * A chat that works in several sources runs in a folder holding one worktree per source (SourceRoots.ts). A
 * checkpoint of that folder is one checkpoint in each source, under the same ref name, and reads as one:
 *
 * - it is taken in every source or in none (the primary last, so the primary holding the ref means all do);
 * - it is restored in every source that holds it, or in none: each is checked first, and one that fails after
 *   others went back puts those back as they were;
 * - its diff and its authored paths are every source's, each path starting with its source's name.
 *
 * A source added to the chat later holds no ref of earlier checkpoints, and a restore to one leaves it as it is.
 * Any other folder goes straight to `single`, unchanged.
 */
export function overSources(single: CheckpointStore["Service"]): CheckpointStore["Service"] {
  const members = (root: string) => {
    const names = readSourceRoot(root);
    if (names === undefined) return undefined;
    const held = names.filter((name) => {
      try {
        return fs.statSync(path.join(root, name)).isDirectory();
      } catch {
        return false;
      }
    });
    return held.map((name) => ({ name, cwd: path.join(root, name) }));
  };
  const failed = (operation: string, cwd: string, detail: string) =>
    new VcsProcessExitError({ operation, command: "git", cwd, exitCode: 1, detail });
  const has = (cwd: string, checkpointRef: CheckpointRef) =>
    single.hasCheckpointRef({ cwd, checkpointRef });

  return {
    isGitRepository: (cwd) => {
      const sources = members(cwd);
      return sources === undefined
        ? single.isGitRepository(cwd)
        : Effect.succeed(sources.length > 0);
    },

    captureCheckpoint: (input) => {
      const sources = members(input.cwd);
      if (sources === undefined) return single.captureCheckpoint(input);
      if (sources.length === 0)
        return Effect.fail(
          failed(
            "CheckpointStore.captureCheckpoint",
            input.cwd,
            "This chat's folder holds none of its sources.",
          ),
        );
      // The primary last: until it holds the ref, the checkpoint does not exist.
      const order = [...sources.slice(1), sources[0]!];
      return Effect.forEach(
        order,
        (source) => single.captureCheckpoint({ ...input, cwd: source.cwd }),
        { discard: true },
      ).pipe(
        Effect.onError(() =>
          Effect.forEach(
            sources,
            (source) =>
              single
                .deleteCheckpointRefs({ cwd: source.cwd, checkpointRefs: [input.checkpointRef] })
                .pipe(Effect.ignore),
            { discard: true },
          ),
        ),
      );
    },

    hasCheckpointRef: (input) => {
      const sources = members(input.cwd);
      if (sources === undefined) return single.hasCheckpointRef(input);
      return sources.length === 0
        ? Effect.succeed(false)
        : has(sources[0]!.cwd, input.checkpointRef);
    },

    restoreCheckpoint: (input) => {
      const sources = members(input.cwd);
      if (sources === undefined) return single.restoreCheckpoint(input);
      return Effect.gen(function* () {
        if (sources.length === 0) return false;
        if (!(yield* has(sources[0]!.cwd, input.checkpointRef)) && input.fallbackToHead !== true)
          return false;
        // A source that joined the chat after this checkpoint holds no ref of it and stays as it is.
        const held: Array<{ readonly name: string; readonly cwd: string }> = [];
        for (const source of sources) {
          if (input.fallbackToHead === true || (yield* has(source.cwd, input.checkpointRef)))
            held.push(source);
        }
        for (const source of held) {
          const possible = yield* single.restoreCheckpoint({
            ...input,
            cwd: source.cwd,
            dryRun: true,
          });
          if (!possible) return false;
        }
        if (input.dryRun === true) return true;
        // Each source as it is now, so one that fails after others went back can put them back.
        const undo = CheckpointRef.make(`refs/caveman/restore-undo/${randomUUID()}`);
        const back: Array<string> = [];
        const dropUndo = Effect.forEach(
          held,
          (source) =>
            single
              .deleteCheckpointRefs({ cwd: source.cwd, checkpointRefs: [undo] })
              .pipe(Effect.ignore),
          { discard: true },
        );
        return yield* Effect.gen(function* () {
          for (const source of held)
            yield* single.captureCheckpoint({ cwd: source.cwd, checkpointRef: undo });
          for (const source of held) {
            back.push(source.cwd);
            const restored = yield* single.restoreCheckpoint({ ...input, cwd: source.cwd });
            if (!restored)
              return yield* failed(
                "CheckpointStore.restoreCheckpoint",
                source.cwd,
                `The checkpoint could not be restored in ${source.name}.`,
              );
          }
          return true;
        }).pipe(
          Effect.onError(() =>
            Effect.forEach(
              back,
              (cwd) =>
                single
                  .restoreCheckpoint({ cwd, checkpointRef: undo, fallbackToHead: false })
                  .pipe(Effect.ignore),
              { discard: true },
            ),
          ),
          Effect.ensuring(dropUndo),
        );
      });
    },

    diffCheckpoints: (input) => {
      const sources = members(input.cwd);
      if (sources === undefined) return single.diffCheckpoints(input);
      return Effect.gen(function* () {
        const names = sources.map((source) => source.name);
        const wanted = input.filePaths
          ?.map((file) => splitSourcePath(names, file))
          .filter((file) => file !== undefined);
        let out = "";
        for (const source of sources) {
          const filePaths = wanted
            ?.filter((file) => file.name === source.name)
            .map((file) => file.path);
          if (filePaths !== undefined && filePaths.length === 0) continue;
          if (!(yield* has(source.cwd, input.toCheckpointRef))) continue;
          if (
            input.fallbackFromToHead !== true &&
            !(yield* has(source.cwd, input.fromCheckpointRef))
          )
            continue;
          const left =
            input.maxOutputBytes === undefined
              ? undefined
              : Math.max(1, input.maxOutputBytes - out.length);
          const { filePaths: _all, maxOutputBytes: _max, ...rest } = input;
          const diff = yield* single.diffCheckpoints({
            ...rest,
            cwd: source.cwd,
            ...(filePaths === undefined ? {} : { filePaths }),
            ...(left === undefined ? {} : { maxOutputBytes: left }),
          });
          out +=
            input.format === "numstat"
              ? prefixNumstat(diff, source.name)
              : prefixPatch(diff, source.name);
        }
        return out;
      });
    },

    listAuthoredPaths: (input) => {
      const sources = members(input.cwd);
      if (sources === undefined) return single.listAuthoredPaths(input);
      return Effect.gen(function* () {
        const authored = new Set<string>();
        let anyImported = false;
        for (const source of sources) {
          if (
            !(yield* has(source.cwd, input.toCheckpointRef)) ||
            !(yield* has(source.cwd, input.fromCheckpointRef))
          )
            continue;
          const refs = { ...input, cwd: source.cwd };
          const own = yield* single.listAuthoredPaths(refs);
          if (own !== null) {
            anyImported = true;
            for (const file of own) authored.add(`${source.name}/${file}`);
            continue;
          }
          // Nothing was brought in here: every path this source changed is the turn's.
          const changed = yield* single.diffCheckpoints({
            ...refs,
            ignoreWhitespace: false,
            format: "numstat",
          });
          for (const record of prefixNumstat(changed, source.name).split("\0")) {
            const counts = /^(\d+|-)\t(\d+|-)\t/.exec(record);
            if (counts) {
              if (record.length > counts[0].length) authored.add(record.slice(counts[0].length));
            } else if (record.length > 0) authored.add(record);
          }
        }
        return anyImported ? authored : null;
      });
    },

    deleteCheckpointRefs: (input) => {
      const sources = members(input.cwd);
      if (sources === undefined) return single.deleteCheckpointRefs(input);
      return Effect.forEach(
        sources,
        (source) => single.deleteCheckpointRefs({ ...input, cwd: source.cwd }),
        { discard: true },
      );
    },
  };
}

export const layer = Layer.effect(CheckpointStore, make);
