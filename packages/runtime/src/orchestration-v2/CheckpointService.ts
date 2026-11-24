// ), apps/server/src/orchestration-v2/CheckpointService.ts @ ab3a3cd1.
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  NodeId,
  OrchestrationV2Checkpoint,
  OrchestrationV2CheckpointScope,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Hex from "effect/encoding/Hex";
import * as KeyedLock from "@caveman-app/shared/KeyedLock";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { isGitImport, parseTurnDiffFilesFromNumstat } from "../checkpointing/Diffs.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";

const CHECKPOINT_REFS_PREFIX = "refs/t3/orchestration-v2/checkpoints";
const ORDINAL_REF_SEGMENT = "/ordinal/";
const TURN_START_REF_SEGMENT = "/turn-start/";
const ROOT_CHECKPOINT_SCOPE_NAME = "root";

export class CheckpointRootScopePrepareError extends Schema.TaggedError<CheckpointRootScopePrepareError>()(
  "CheckpointRootScopePrepareError",
  {
    threadId: ThreadId,
    runId: RunId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to prepare root checkpoint scope for run ${this.runId}.`;
  }
}

export class CheckpointScopeEnsureError extends Schema.TaggedError<CheckpointScopeEnsureError>()(
  "CheckpointScopeEnsureError",
  {
    scopeId: CheckpointScopeId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ensure checkpoint scope ${this.scopeId}.`;
  }
}

export class CheckpointBaselineCaptureError extends Schema.TaggedError<CheckpointBaselineCaptureError>()(
  "CheckpointBaselineCaptureError",
  {
    scopeId: CheckpointScopeId,
    ordinalWithinScope: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint baseline ${this.ordinalWithinScope} for scope ${this.scopeId}.`;
  }
}

export class CheckpointCaptureError extends Schema.TaggedError<CheckpointCaptureError>()(
  "CheckpointCaptureError",
  {
    scopeId: CheckpointScopeId,
    parentCheckpointId: Schema.optional(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to capture checkpoint for scope ${this.scopeId}.`;
  }
}

export class CheckpointRestoreError extends Schema.TaggedError<CheckpointRestoreError>()(
  "CheckpointRestoreError",
  {
    scopeId: CheckpointScopeId,
    checkpointId: CheckpointId,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to restore checkpoint ${this.checkpointId} for scope ${this.scopeId}.`;
  }
}

export class CheckpointDeleteStaleRefsError extends Schema.TaggedError<CheckpointDeleteStaleRefsError>()(
  "CheckpointDeleteStaleRefsError",
  {
    scopeId: CheckpointScopeId,
    checkpointIds: Schema.Array(CheckpointId),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to delete stale checkpoint refs for scope ${this.scopeId}.`;
  }
}

export const CheckpointServiceV2Error = Schema.Union([
  CheckpointRootScopePrepareError,
  CheckpointScopeEnsureError,
  CheckpointBaselineCaptureError,
  CheckpointCaptureError,
  CheckpointRestoreError,
  CheckpointDeleteStaleRefsError,
]);
export type CheckpointServiceV2Error = typeof CheckpointServiceV2Error.Type;

const isCheckpointRestoreError = Schema.is(CheckpointRestoreError);

export interface CheckpointServiceV2Shape {
  readonly prepareRootRunScope: (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly rootNodeId: NodeId;
    readonly providerThreadId: ProviderThreadId;
    readonly cwd: string;
    readonly createdAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly ensureScope: (
    scope: OrchestrationV2CheckpointScope,
  ) => Effect.Effect<OrchestrationV2CheckpointScope, CheckpointServiceV2Error>;
  readonly captureBaseline: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
    /** The chat's worktree is freshly made: a verifiably clean one is kept as HEAD's tree, with no snapshot. */
    readonly fresh?: boolean;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly materializeBaselineCheckpoint: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly ordinalWithinScope: number;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly capture: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly runId: RunId | null;
    readonly nodeId: NodeId;
    readonly ordinalWithinScope: number;
    readonly appRunOrdinal: number | null;
    readonly capturedAt: DateTime.Utc;
  }) => Effect.Effect<OrchestrationV2Checkpoint, CheckpointServiceV2Error>;
  readonly restore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  /** Fails as `restore` would before changing anything (ignored files in its way, a missing ref); changes nothing. */
  readonly checkRestore: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoint: OrchestrationV2Checkpoint;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
  readonly deleteStaleRefs: (input: {
    readonly scope: OrchestrationV2CheckpointScope;
    readonly checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>;
  }) => Effect.Effect<void, CheckpointServiceV2Error>;
}

export class CheckpointServiceV2 extends Context.Service<
  CheckpointServiceV2,
  CheckpointServiceV2Shape
>()("t3/orchestration-v2/CheckpointService/CheckpointServiceV2") {}

export const checkpointRefForScopeOrdinal = Effect.fn("checkpointRefForScopeOrdinal")(
  function* (input: { readonly scopeId: CheckpointScopeId; readonly ordinalWithinScope: number }) {
    const crypto = yield* Digest.Digest;
    const digest = yield* crypto
      .digest(Digest.sha256, new TextEncoder().encode(input.scopeId))
      .pipe(Effect.orDie);
    const scopeKey = Hex.encode(digest).slice(0, 32);
    return CheckpointRef.make(
      `${CHECKPOINT_REFS_PREFIX}/${Base64Url.encode(scopeKey)}${ORDINAL_REF_SEGMENT}${input.ordinalWithinScope}`,
    );
  },
);

/**
 * Where a later turn keeps the workspace as it began, beside the checkpoint it ends at. The checkpoint before it is
 * the previous turn's end, and the person or another program may have changed files since: those are neither turn's.
 * Null for a ref that is not a scope ordinal's.
 */
export function turnStartRef(turnCheckpointRef: CheckpointRef): CheckpointRef | null {
  const at = turnCheckpointRef.lastIndexOf(ORDINAL_REF_SEGMENT);
  if (!turnCheckpointRef.startsWith(`${CHECKPOINT_REFS_PREFIX}/`) || at < 0) return null;
  return CheckpointRef.make(
    `${turnCheckpointRef.slice(0, at)}${TURN_START_REF_SEGMENT}${turnCheckpointRef.slice(at + ORDINAL_REF_SEGMENT.length)}`,
  );
}

function checkpointIdForScopeOrdinal(
  idAllocator: IdAllocator.IdAllocatorV2["Service"],
  input: {
    readonly scopeId: CheckpointScopeId;
    readonly ordinalWithinScope: number;
  },
) {
  return idAllocator.allocate.checkpoint({
    checkpointScopeId: input.scopeId,
    name: String(input.ordinalWithinScope),
  });
}

function makeRootRunScope(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly rootNodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly cwd: string;
  readonly createdAt: DateTime.Utc;
}) {
  return Effect.gen(function* () {
    const scopeId = yield* input.idAllocator.allocate.checkpointScope({
      threadId: input.threadId,
      name: ROOT_CHECKPOINT_SCOPE_NAME,
    });
    return {
      id: scopeId,
      threadId: input.threadId,
      runId: input.runId,
      nodeId: input.rootNodeId,
      parentScopeId: null,
      providerThreadId: input.providerThreadId,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: input.cwd,
      createdAt: input.createdAt,
    } satisfies OrchestrationV2CheckpointScope;
  });
}

function makeCheckpoint(input: {
  readonly id: CheckpointId;
  readonly scope: OrchestrationV2CheckpointScope;
  readonly runId: RunId | null;
  readonly nodeId: NodeId;
  readonly parentCheckpointId: CheckpointId | null;
  readonly ordinalWithinScope: number;
  readonly appRunOrdinal: number | null;
  readonly ref: CheckpointRef;
  readonly status: OrchestrationV2Checkpoint["status"];
  readonly files: OrchestrationV2Checkpoint["files"];
  readonly capturedAt: DateTime.Utc;
}): OrchestrationV2Checkpoint {
  return {
    id: input.id,
    threadId: input.scope.threadId,
    scopeId: input.scope.id,
    runId: input.runId,
    nodeId: input.nodeId,
    parentCheckpointId: input.parentCheckpointId,
    ordinalWithinScope: input.ordinalWithinScope,
    appRunOrdinal: input.appRunOrdinal,
    ref: input.ref,
    status: input.status,
    files: input.files,
    capturedAt: input.capturedAt,
  };
}

export const layer: Layer.Layer<
  CheckpointServiceV2,
  never,
  CheckpointStore.CheckpointStore | Digest.Digest | IdAllocator.IdAllocatorV2
> = Layer.effect(
  CheckpointServiceV2,
  Effect.gen(function* () {
    const checkpointStore = yield* CheckpointStore.CheckpointStore;
    const crypto = yield* Digest.Digest;
    const checkpointRefFor = (input: Parameters<typeof checkpointRefForScopeOrdinal>[0]) =>
      checkpointRefForScopeOrdinal(input).pipe(Effect.provideService(Digest.Digest, crypto));
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const workspaceLocks = yield* KeyedLock.make<string>();
    const withWorkspaceLock = <A, E, R>(cwd: string, effect: Effect.Effect<A, E, R>) =>
      workspaceLocks.withLock(cwd, effect);

    const isGitCheckpointable = (cwd: string) =>
      checkpointStore.isGitRepository(cwd).pipe(Effect.orElseSucceed(() => false));

    const ensureScope: CheckpointServiceV2Shape["ensureScope"] = (scope) => Effect.succeed(scope);

    const captureBaseline: CheckpointServiceV2Shape["captureBaseline"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (!(yield* isGitCheckpointable(input.scope.cwd))) {
            return;
          }

          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const has = (ref: CheckpointRef) =>
            checkpointStore.hasCheckpointRef({ cwd: input.scope.cwd, checkpointRef: ref });
          const snapshot = (ref: CheckpointRef) =>
            checkpointStore
              .captureCheckpoint({
                cwd: input.scope.cwd,
                checkpointRef: ref,
                ...(input.fresh === true ? { fresh: true } : {}),
              })
              .pipe(
                Effect.catchTags({
                  VcsUnsupportedOperationError: () => Effect.void,
                }),
              );
          // A retried or restarted attempt keeps the first attempt's baseline: its writes are the turn's.
          if (input.ordinalWithinScope === 0) {
            if (!(yield* has(checkpointRef))) yield* snapshot(checkpointRef);
            return;
          }
          const startRef = turnStartRef(
            yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope + 1,
            }),
          );
          if (startRef === null || (yield* has(startRef))) return;
          // An earlier turn rolled back, or whose capture failed, left no rollback point before this one. A start ref
          // that turn kept marks no checkpoint and nothing reads it, so it stops pinning its snapshot.
          if (!(yield* has(checkpointRef))) {
            yield* snapshot(checkpointRef);
            const endedTurnStart = turnStartRef(checkpointRef);
            if (endedTurnStart !== null && (yield* has(endedTurnStart))) {
              yield* checkpointStore.deleteCheckpointRefs({
                cwd: input.scope.cwd,
                checkpointRefs: [endedTurnStart],
              });
            }
          }
          yield* snapshot(startRef);
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointBaselineCaptureError({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
              cause,
            }),
        ),
      );

    const materializeBaselineCheckpoint: CheckpointServiceV2Shape["materializeBaselineCheckpoint"] =
      (input) =>
        withWorkspaceLock(
          input.scope.cwd,
          Effect.gen(function* () {
            const checkpointRef = yield* checkpointRefFor({
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
              scopeId: input.scope.id,
              ordinalWithinScope: input.ordinalWithinScope,
            });
            const checkpointable = yield* isGitCheckpointable(input.scope.cwd);
            const available = checkpointable
              ? yield* checkpointStore
                  .hasCheckpointRef({
                    cwd: input.scope.cwd,
                    checkpointRef,
                  })
                  .pipe(
                    Effect.catch((cause) =>
                      Effect.logWarning("orchestration V2 baseline ref lookup failed", {
                        scopeId: input.scope.id,
                        checkpointRef,
                        cause: String(cause),
                      }).pipe(Effect.as(false)),
                    ),
                  )
              : false;
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: null,
              nodeId: input.scope.nodeId,
              parentCheckpointId: null,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: null,
              ref: checkpointRef,
              status: available ? "ready" : "missing",
              files: [],
              capturedAt: input.scope.createdAt,
            });
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointCaptureError({
                scopeId: input.scope.id,
                cause,
              }),
          ),
        );

    const capture: CheckpointServiceV2Shape["capture"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          const checkpointId = yield* checkpointIdForScopeOrdinal(idAllocator, {
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const parentCheckpointId =
            input.ordinalWithinScope > 0
              ? yield* checkpointIdForScopeOrdinal(idAllocator, {
                  scopeId: input.scope.id,
                  ordinalWithinScope: input.ordinalWithinScope - 1,
                })
              : null;
          const checkpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: input.ordinalWithinScope,
          });
          const previousCheckpointRef = yield* checkpointRefFor({
            scopeId: input.scope.id,
            ordinalWithinScope: Math.max(0, input.ordinalWithinScope - 1),
          });

          if (!(yield* isGitCheckpointable(input.scope.cwd))) {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: "missing",
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const captureStatus = yield* checkpointStore
            .captureCheckpoint({
              cwd: input.scope.cwd,
              checkpointRef,
            })
            .pipe(
              Effect.as("ready" as const),
              Effect.catchTags({
                VcsUnsupportedOperationError: () => Effect.succeed("missing" as const),
              }),
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 checkpoint capture failed", {
                  scopeId: input.scope.id,
                  checkpointRef,
                  cause: String(cause),
                }).pipe(Effect.as("error" as const)),
              ),
            );

          if (captureStatus !== "ready") {
            return makeCheckpoint({
              id: checkpointId,
              scope: input.scope,
              runId: input.runId,
              nodeId: input.nodeId,
              parentCheckpointId,
              ordinalWithinScope: input.ordinalWithinScope,
              appRunOrdinal: input.appRunOrdinal,
              ref: checkpointRef,
              status: captureStatus,
              files: [],
              capturedAt: input.capturedAt,
            });
          }

          const exists = (ref: CheckpointRef) =>
            checkpointStore.hasCheckpointRef({ cwd: input.scope.cwd, checkpointRef: ref }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("orchestration V2 previous checkpoint ref lookup failed", {
                  scopeId: input.scope.id,
                  checkpointRef: ref,
                  cause: String(cause),
                }).pipe(Effect.as(false)),
              ),
            );
          // A turn's files are what changed since it began: its start ref, or the checkpoint before it for a
          // thread's first turn and for turns run before start refs were kept.
          const startRef = input.ordinalWithinScope > 1 ? turnStartRef(checkpointRef) : null;
          const fromCheckpointRef =
            startRef !== null && (yield* exists(startRef)) ? startRef : previousCheckpointRef;
          const previousExists = yield* exists(fromCheckpointRef);
          const refs = {
            cwd: input.scope.cwd,
            fromCheckpointRef,
            toCheckpointRef: checkpointRef,
          };
          // A pull or rebase can change thousands of files the turn did not write.
          // Keep only the files the turn's own work touched.
          const files = previousExists
            ? yield* Effect.all([
                checkpointStore.diffCheckpoints({
                  ...refs,
                  fallbackFromToHead: false,
                  ignoreWhitespace: false,
                  format: "numstat",
                }),
                checkpointStore.listAuthoredPaths(refs).pipe(
                  Effect.catch((cause) =>
                    Effect.logWarning("orchestration V2 checkpoint authored paths failed", {
                      scopeId: input.scope.id,
                      checkpointRef,
                      cause: String(cause),
                    }).pipe(Effect.as(null)),
                  ),
                ),
              ]).pipe(
                Effect.map(([diff, authoredPaths]) =>
                  parseTurnDiffFilesFromNumstat(diff)
                    .filter((file) => !isGitImport(file, authoredPaths))
                    .map((file) => ({
                      path: file.path,
                      ...(file.previousPath === undefined
                        ? {}
                        : { previousPath: file.previousPath }),
                      kind: "modified",
                      additions: file.additions,
                      deletions: file.deletions,
                    })),
                ),
                Effect.catch((cause) =>
                  Effect.logWarning("orchestration V2 checkpoint diff summary failed", {
                    scopeId: input.scope.id,
                    checkpointRef,
                    cause: String(cause),
                  }).pipe(Effect.as([])),
                ),
              )
            : [];

          return makeCheckpoint({
            id: checkpointId,
            scope: input.scope,
            runId: input.runId,
            nodeId: input.nodeId,
            parentCheckpointId,
            ordinalWithinScope: input.ordinalWithinScope,
            appRunOrdinal: input.appRunOrdinal,
            ref: checkpointRef,
            status: "ready",
            files,
            capturedAt: input.capturedAt,
          });
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointCaptureError({
              scopeId: input.scope.id,
              cause,
            }),
        ),
      );

    const restoreOrCheck = (
      input: Parameters<CheckpointServiceV2Shape["restore"]>[0],
      dryRun: boolean,
    ): ReturnType<CheckpointServiceV2Shape["restore"]> =>
      withWorkspaceLock(
        input.scope.cwd,
        Effect.gen(function* () {
          if (input.checkpoint.status !== "ready") {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: `Checkpoint status is ${input.checkpoint.status}.`,
            });
          }

          const restored = yield* checkpointStore.restoreCheckpoint({
            cwd: input.scope.cwd,
            checkpointRef: input.checkpoint.ref,
            fallbackToHead: false,
            dryRun,
          });
          if (!restored) {
            return yield* new CheckpointRestoreError({
              scopeId: input.scope.id,
              checkpointId: input.checkpoint.id,
              cause: "Checkpoint ref is unavailable.",
            });
          }
        }),
      ).pipe(
        Effect.mapError((cause) =>
          isCheckpointRestoreError(cause)
            ? cause
            : new CheckpointRestoreError({
                scopeId: input.scope.id,
                checkpointId: input.checkpoint.id,
                cause,
              }),
        ),
      );

    const restore: CheckpointServiceV2Shape["restore"] = (input) => restoreOrCheck(input, false);
    const checkRestore: CheckpointServiceV2Shape["checkRestore"] = (input) =>
      restoreOrCheck(input, true);

    const deleteStaleRefs: CheckpointServiceV2Shape["deleteStaleRefs"] = (input) =>
      withWorkspaceLock(
        input.scope.cwd,
        checkpointStore.deleteCheckpointRefs({
          cwd: input.scope.cwd,
          checkpointRefs: input.checkpoints.flatMap((checkpoint) => {
            const startRef = turnStartRef(checkpoint.ref);
            return startRef === null ? [checkpoint.ref] : [checkpoint.ref, startRef];
          }),
        }),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new CheckpointDeleteStaleRefsError({
              scopeId: input.scope.id,
              checkpointIds: input.checkpoints.map((checkpoint) => checkpoint.id),
              cause,
            }),
        ),
      );

    return CheckpointServiceV2.of({
      prepareRootRunScope: (input) =>
        makeRootRunScope({ ...input, idAllocator }).pipe(
          Effect.mapError(
            (cause) =>
              new CheckpointRootScopePrepareError({
                threadId: input.threadId,
                runId: input.runId,
                cause,
              }),
          ),
        ),
      ensureScope,
      captureBaseline,
      materializeBaselineCheckpoint,
      capture,
      restore,
      checkRestore,
      deleteStaleRefs,
    } satisfies CheckpointServiceV2Shape);
  }),
);
