// ), apps/server/src/orchestration-v2/RunFinalizationQueue.test.ts @ 21baef5c87.
import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, GitCommandError, RunId, ThreadId } from "@caveman-app/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WorkspaceEntries from "../workspace/WorkspaceEntries.ts";
import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as CheckpointRollback from "./CheckpointRollbackService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderSessions from "./ProviderSessionManager.ts";
import * as ProviderTurnControl from "./ProviderTurnControlService.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as RuntimeRequests from "./RuntimeRequestService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadTitles from "./ThreadTitleRegenerationService.ts";

it.effect.each([
  ["starts the next turn after a post-capture Git status failure", false],
  ["keeps the next turn queued when checkpoint capture fails", true],
] as const)("%s", ([, captureFails]) => {
  const threadId = ThreadId.make("thread:finalization-queue");
  const runId = RunId.make("run:finalization-queue");
  const scopeId = CheckpointScopeId.make("scope:finalization-queue");
  const calls: string[] = [];
  const checkpointFailure = new CheckpointCapture.CheckpointCaptureExecutionError({
    threadId,
    runId,
    scopeId,
    cause: "checkpoint storage unavailable",
  });
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getCheckpointContext: () =>
      Effect.succeed({
        runs: [],
        checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
        checkpoints: [],
      }),
  });
  const observer = RunFinalization.layerObserver.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
        Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: () =>
            Effect.gen(function* () {
              calls.push("refresh");
              return yield* new GitCommandError({
                operation: "statusDetailsLocal",
                command: "git",
                cwd: "/repo",
                detail: "VCS process timed out after 30000ms",
              });
            }),
        }),
      ),
    ),
  );
  const finalization = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        projections,
        observer,
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.gen(function* () {
              calls.push("capture");
              if (captureFails) return yield* checkpointFailure;
            }),
        }),
      ),
    ),
  );
  const executor = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        finalization,
        Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
        Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
        Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
        Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
        Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        ServerSettings.layerTest(),
        Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
          start: () => Effect.sync(() => calls.push("start")).pipe(Effect.asVoid),
        }),
      ),
    ),
  );
  const outbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
  const worker = EffectWorker.layer.pipe(Layer.provideMerge(Layer.merge(executor, outbox)));

  return Effect.gen(function* () {
    const queue = yield* EffectOutbox.EffectOutboxV2;
    const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* queue.enqueue([
      {
        id: "effect:finalization-queue:capture",
        commandId: CommandId.make("command:finalization-queue:capture"),
        threadId,
        request: { type: "checkpoint.capture", runId, scopeId },
      },
      {
        id: "effect:finalization-queue:start",
        commandId: CommandId.make("command:finalization-queue:start"),
        threadId,
        request: { type: "provider-turn.start", runId: RunId.make("run:next") },
      },
    ]);

    assert.equal(yield* effectWorker.drain(2), captureFails ? 1 : 2);
    const captured = Option.getOrThrow(yield* queue.get("effect:finalization-queue:capture"));
    const started = Option.getOrThrow(yield* queue.get("effect:finalization-queue:start"));
    assert.equal(captured.status, captureFails ? "pending" : "succeeded");
    assert.equal(captured.attemptCount, 1);
    assert.equal(started.status, captureFails ? "pending" : "succeeded");
    assert.equal(started.attemptCount, captureFails ? 0 : 1);
    assert.deepEqual(calls, captureFails ? ["capture"] : ["capture", "refresh", "start"]);
    if (captureFails) assert.include(captured.lastError ?? "", "checkpoint storage unavailable");
    else assert.equal(captured.lastError, null);
  }).pipe(Effect.provide(Layer.fresh(worker)));
});

it.effect.each([
  // refreshPullRequestStatus waits on the per-cwd remote write lock, which a background fetch can hold for minutes.
  ["the PR status step waits on the remote lock", "pull-request"],
  ["the local git status is slow", "local-status"],
] as const)("starts the next turn while %s after a saved checkpoint", ([, slowStep]) => {
  const threadId = ThreadId.make("thread:finalization-queue-slow-refresh");
  const runId = RunId.make("run:finalization-queue-slow-refresh");
  const scopeId = CheckpointScopeId.make("scope:finalization-queue-slow-refresh");
  const calls: string[] = [];

  return Effect.gen(function* () {
    const slowStepEntered = yield* Deferred.make<void>();
    const releaseSlowStep = yield* Deferred.make<void>();
    const holdSlowStep = (label: string) =>
      Effect.gen(function* () {
        calls.push(`${label}:entered`);
        yield* Deferred.succeed(slowStepEntered, undefined);
        yield* Deferred.await(releaseSlowStep);
        calls.push(`${label}:done`);
      });
    const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getCheckpointContext: () =>
        Effect.succeed({
          runs: [],
          checkpointScopes: [{ id: scopeId, runId, kind: "root_run" as const, cwd: "/repo" }],
          checkpoints: [],
        }),
      // The finished run is still the thread's latest when the refresh reads it.
      getThreadShell: () =>
        Effect.succeed({ id: threadId, branch: "feature/x", activeRunId: null } as never),
    });
    const observer = RunFinalization.layerObserver.pipe(
      Layer.provide(
        Layer.mergeAll(
          projections,
          Layer.mock(WorkspaceEntries.WorkspaceEntries)({ refresh: () => Effect.void }),
          Layer.mock(PullRequestService.PullRequestService)({ refreshAfterTurn: () => Effect.void }),
          Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
            refreshLocalStatus: () =>
              (slowStep === "local-status" ? holdSlowStep("local-status") : Effect.void).pipe(
                Effect.as({ refName: "feature/x", isDefaultRef: false } as never),
              ),
            refreshPullRequestStatus: () =>
              (slowStep === "pull-request" ? holdSlowStep("pull-request") : Effect.void).pipe(
                Effect.as(null),
              ),
          }),
        ),
      ),
    );
    const finalization = RunFinalization.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          projections,
          observer,
          Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
            execute: () => Effect.sync(() => void calls.push("capture")),
          }),
        ),
      ),
    );
    const executor = EffectWorker.layerExecutor.pipe(
      Layer.provide(
        Layer.mergeAll(
          finalization,
          Layer.mock(ProviderSessions.ProviderSessionManagerV2)({}),
          Layer.mock(ProviderTurnControl.ProviderTurnControlServiceV2)({}),
          Layer.mock(CheckpointRollback.CheckpointRollbackServiceV2)({}),
          Layer.mock(RuntimeRequests.RuntimeRequestServiceV2)({}),
          Layer.mock(ThreadTitles.ThreadTitleRegenerationService)({}),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          ServerSettings.layerTest(),
          Layer.mock(ProviderTurnStart.ProviderTurnStartServiceV2)({
            start: () => Effect.sync(() => void calls.push("start")),
          }),
        ),
      ),
    );
    const outbox = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
    const worker = EffectWorker.layer.pipe(Layer.provideMerge(Layer.merge(executor, outbox)));

    yield* Effect.gen(function* () {
      const queue = yield* EffectOutbox.EffectOutboxV2;
      const effectWorker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* queue.enqueue([
        {
          id: "effect:finalization-queue-slow-refresh:capture",
          commandId: CommandId.make("command:finalization-queue-slow-refresh:capture"),
          threadId,
          request: { type: "checkpoint.capture", runId, scopeId },
        },
      ]);
      const capture = yield* effectWorker.runOnce.pipe(Effect.forkChild);
      yield* Deferred.await(slowStepEntered);
      // The checkpoint is saved; its effect must end without waiting for the refresh (bounded only to fail fast).
      const captureEnded = yield* Fiber.join(capture).pipe(
        Effect.timeoutOption("5 seconds"),
        TestClock.withLive,
      );
      // The person's next message starts a run while the refresh is still under way.
      yield* queue.enqueue([
        {
          id: "effect:finalization-queue-slow-refresh:start",
          commandId: CommandId.make("command:finalization-queue-slow-refresh:start"),
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("run:next") },
        },
      ]);
      const claimedWhileRefreshing = yield* effectWorker.runOnce;
      const started = Option.getOrThrow(
        yield* queue.get("effect:finalization-queue-slow-refresh:start"),
      );
      const callsWhileRefreshing = [...calls];
      yield* Deferred.succeed(releaseSlowStep, undefined);
      yield* Fiber.join(capture);

      assert.deepEqual(
        {
          captureEnded: Option.isSome(captureEnded),
          claimedWhileRefreshing,
          startStatus: started.status,
          calls: callsWhileRefreshing,
        },
        {
          captureEnded: true,
          claimedWhileRefreshing: true,
          startStatus: "succeeded",
          calls: ["capture", `${slowStep}:entered`, "start"],
        },
      );
    }).pipe(Effect.provide(Layer.fresh(worker)));
  });
});
