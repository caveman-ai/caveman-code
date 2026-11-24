// ), apps/server/src/orchestration-v2/CheckpointService.test.ts @ ab3a3cd1.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
  VcsProcessTimeoutError,
  VcsUnsupportedOperationError,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";

it.effect.each([false, true, "interrupt"] as const)(
  "materializes baseline, lookup fails=%s",
  (lookupFails) => {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:materialize-baseline"),
      threadId: ThreadId.make("thread:materialize-baseline"),
      runId: RunId.make("run:materialize-baseline:3"),
      nodeId: NodeId.make("node:materialize-baseline:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:materialize-baseline"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const hasCheckpointRef = vi.fn((_input: CheckpointStore.RestoreCheckpointInput) =>
      lookupFails === "interrupt"
        ? Effect.interrupt
        : lookupFails
          ? Effect.fail(
              new VcsProcessTimeoutError({
                operation: "test.ref",
                command: "git",
                cwd: "/repo",
                timeoutMs: 30000,
              }),
            )
          : Effect.succeed(true),
    );
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef,
            captureCheckpoint: () => Effect.void,
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );

    return Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      if (lookupFails === "interrupt") {
        const exit = yield* Effect.exit(
          checkpoints.materializeBaselineCheckpoint({ scope, ordinalWithinScope: 2 }),
        );
        assert.isTrue(Exit.hasInterrupts(exit));
        const captureExit = yield* Effect.exit(
          checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          }),
        );
        assert.isTrue(Exit.hasInterrupts(captureExit));
        return;
      }
      const baseline = yield* checkpoints.materializeBaselineCheckpoint({
        scope,
        ordinalWithinScope: 2,
      });

      assert.equal(baseline.ordinalWithinScope, 2);
      assert.equal(
        baseline.ref,
        yield* CheckpointService.checkpointRefForScopeOrdinal({
          scopeId: scope.id,
          ordinalWithinScope: 2,
        }),
      );
      assert.equal(baseline.status, lookupFails ? "missing" : "ready");
      assert.deepEqual(hasCheckpointRef.mock.calls[0]?.[0], {
        cwd: scope.cwd,
        checkpointRef: baseline.ref,
      });
    }).pipe(Effect.provide(layerTest));
  },
);

it.effect(
  "skips unsupported baseline and turn checkpoints without swallowing capture failures",
  () =>
    Effect.gen(function* () {
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("checkpoint-scope:capture-failure"),
        threadId: ThreadId.make("thread:capture-failure"),
        runId: RunId.make("run:capture-failure:1"),
        nodeId: NodeId.make("node:capture-failure:1"),
        parentScopeId: null,
        providerThreadId: ProviderThreadId.make("provider-thread:capture-failure"),
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/repo/ignored",
        createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
      };
      for (const captureError of [
        new VcsProcessTimeoutError({
          operation: "test.capture",
          command: "git",
          cwd: scope.cwd,
          timeoutMs: 30000,
        }),
        new VcsUnsupportedOperationError({
          operation: "test.capture",
          kind: "git",
          detail: "The workspace directory is ignored by its Git repository.",
        }),
      ]) {
        const layerTest = CheckpointService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              IdAllocator.layer,
              Layer.mock(CheckpointStore.CheckpointStore)({
                isGitRepository: () => Effect.succeed(true),
                hasCheckpointRef: () => Effect.succeed(false),
                captureCheckpoint: () => Effect.fail(captureError),
              }),
            ),
          ),
          Layer.provideMerge(NodeCrypto.layer),
        );
        yield* Effect.gen(function* () {
          const checkpoints = yield* CheckpointService.CheckpointServiceV2;
          const baseline = yield* Effect.result(
            checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 }),
          );
          const checkpoint = yield* checkpoints.capture({
            scope,
            ordinalWithinScope: 1,
            runId: scope.runId!,
            nodeId: scope.nodeId!,
            appRunOrdinal: 1,
            capturedAt: scope.createdAt,
          });

          assert.deepEqual(
            { baseline: baseline._tag, turn: checkpoint.status, files: checkpoint.files },
            captureError._tag === "VcsUnsupportedOperationError"
              ? { baseline: "Success", turn: "missing", files: [] }
              : { baseline: "Failure", turn: "error", files: [] },
          );
          if (baseline._tag === "Failure") {
            assert.strictEqual(baseline.failure.cause, captureError);
          } else {
            const materialized = yield* checkpoints.materializeBaselineCheckpoint({
              scope,
              ordinalWithinScope: 0,
            });
            assert.strictEqual(materialized.status, "missing");
          }
        }).pipe(Effect.provide(layerTest));
      }
    }),
);

// A turn that failed before its capture kept a start ref beside a checkpoint it never took. The next turn takes
// that rollback point itself, and the stale start ref goes with it instead of pinning its snapshot for good.
it.effect("the next turn drops the start ref of a turn whose capture never landed", () =>
  Effect.gen(function* () {
    const scope: OrchestrationV2CheckpointScope = {
      id: CheckpointScopeId.make("checkpoint-scope:failed-turn"),
      threadId: ThreadId.make("thread:failed-turn"),
      runId: RunId.make("run:failed-turn:3"),
      nodeId: NodeId.make("node:failed-turn:3"),
      parentScopeId: null,
      providerThreadId: ProviderThreadId.make("provider-thread:failed-turn"),
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
    };
    const ref = (ordinalWithinScope: number) =>
      CheckpointService.checkpointRefForScopeOrdinal({ scopeId: scope.id, ordinalWithinScope });
    const refs = new Set<string>([yield* ref(1)]);
    const layerTest = CheckpointService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          IdAllocator.layer,
          Layer.mock(CheckpointStore.CheckpointStore)({
            isGitRepository: () => Effect.succeed(true),
            hasCheckpointRef: ({ checkpointRef }) => Effect.succeed(refs.has(checkpointRef)),
            captureCheckpoint: ({ checkpointRef }) =>
              Effect.sync(() => void refs.add(checkpointRef)),
            deleteCheckpointRefs: ({ checkpointRefs }) =>
              Effect.sync(() =>
                checkpointRefs.forEach((checkpointRef) => refs.delete(checkpointRef)),
              ),
          }),
        ),
      ),
      Layer.provideMerge(NodeCrypto.layer),
    );
    yield* Effect.gen(function* () {
      const checkpoints = yield* CheckpointService.CheckpointServiceV2;
      // Turn 2 starts, then fails before its checkpoint is captured.
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 1 });
      assert.isTrue(refs.has(CheckpointService.turnStartRef(yield* ref(2))!));
      yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 2 });
    }).pipe(Effect.provide(layerTest));

    assert.deepEqual(
      new Set(refs),
      new Set([yield* ref(1), yield* ref(2), CheckpointService.turnStartRef(yield* ref(3))!]),
    );
  }).pipe(Effect.provide(NodeCrypto.layer)),
);

it.effect("a turn's card keeps the path a file it moved came from", () => {
  const scope: OrchestrationV2CheckpointScope = {
    id: CheckpointScopeId.make("checkpoint-scope:capture-rename"),
    threadId: ThreadId.make("thread:capture-rename"),
    runId: RunId.make("run:capture-rename:1"),
    nodeId: NodeId.make("node:capture-rename:1"),
    parentScopeId: null,
    providerThreadId: ProviderThreadId.make("provider-thread:capture-rename"),
    kind: "root_run",
    ordinalWithinParent: 0,
    advancesAppRunCount: true,
    cwd: "/repo",
    createdAt: DateTime.makeUnsafe("2026-07-28T00:00:00.000Z"),
  };
  const layerTest = CheckpointService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        IdAllocator.layer,
        Layer.mock(CheckpointStore.CheckpointStore)({
          isGitRepository: () => Effect.succeed(true),
          hasCheckpointRef: () => Effect.succeed(true),
          captureCheckpoint: () => Effect.void,
          // git's numstat for `mv src/old.ts src/new.ts` with one line edited, beside an edit to README.md.
          diffCheckpoints: () =>
            Effect.succeed("1\t1\t\0src/old.ts\0src/new.ts\x002\t0\tREADME.md\0"),
          listAuthoredPaths: () => Effect.succeed(null),
        }),
      ),
    ),
    Layer.provideMerge(NodeCrypto.layer),
  );
  return Effect.gen(function* () {
    const checkpoints = yield* CheckpointService.CheckpointServiceV2;
    const checkpoint = yield* checkpoints.capture({
      scope,
      ordinalWithinScope: 1,
      runId: scope.runId!,
      nodeId: scope.nodeId!,
      appRunOrdinal: 1,
      capturedAt: scope.createdAt,
    });
    // Undo puts back both sides of the move from these.
    assert.deepEqual(checkpoint.files, [
      { path: "README.md", kind: "modified", additions: 2, deletions: 0 },
      {
        path: "src/new.ts",
        previousPath: "src/old.ts",
        kind: "modified",
        additions: 1,
        deletions: 1,
      },
    ]);
  }).pipe(Effect.provide(layerTest));
});
