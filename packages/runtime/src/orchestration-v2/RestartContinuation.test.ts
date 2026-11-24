// ), apps/server/src/orchestration-v2/RestartContinuation.test.ts @ ab3a3cd1.
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ThreadProjection,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ServerSettings from "../serverSettings.ts";
import { restartContinuationRun, continueRestartedRun } from "./RestartContinuation.ts";
import { continuationStartRetryDelayMs } from "./RestartBackgroundNote.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

// What a restart continuation tells the agent (RestartContinuation.ts).
const CONTINUE_PROMPT =
  "Continue where you left off. Your last turn was cut short, so a command or other action it started may have finished or may still be running. Before you repeat one that changes state, confirm it did not take effect and is not still running; if you cannot tell, say so instead of repeating it.";

const threadId = ThreadId.make("thread:restart");
const runId = RunId.make("run:restart");
const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const providerThreadId = ProviderThreadId.make("provider-thread:restart");
const sessionId = ProviderSessionId.make("session:restart");
const attemptId = RunAttemptId.make("attempt:restart");
// "No project" threads belong to the environment's Scratch project.
const scratchProjectId = ProjectId.make("project:scratch");
const now = DateTime.makeUnsafe("2026-10-03T12:00:00.000Z");

function makeProjection() {
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("restart-project"),
      providerInstanceId: instanceId,
      archivedAt: null,
      deletedAt: null,
      lineage: { parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
    },
    runs: [
      {
        id: runId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId,
        activeAttemptId: attemptId,
        status: "running",
        requestedAt: now,
        completedAt: null,
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        appThreadId: threadId,
        ownerNodeId: null,
        driver,
        providerInstanceId: instanceId,
        providerSessionId: sessionId,
        nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
        status: "active",
      },
    ],
    providerSessions: [
      { id: sessionId, driver, providerInstanceId: instanceId, status: "running" },
    ],
    providerTurns: [
      {
        id: ProviderTurnId.make("turn:restart"),
        providerThreadId,
        runAttemptId: attemptId,
        status: "running",
      },
    ],
    runtimeRequests: [],
    attempts: [],
    nodes: [],
    subagents: [],
    messages: [],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
}

it("requires matching saved native state for an unfinished root run", () => {
  const projection = makeProjection();
  assert.equal(restartContinuationRun(projection, now)?.id, runId);
  for (const invalid of [
    { ...projection, thread: { ...projection.thread, archivedAt: {} } },
    { ...projection, thread: { ...projection.thread, deletedAt: {} } },
    {
      ...projection,
      thread: { ...projection.thread, providerInstanceId: ProviderInstanceId.make("other") },
    },
    {
      ...projection,
      providerThreads: [{ ...projection.providerThreads[0]!, nativeThreadRef: null }],
    },
    {
      ...projection,
      providerSessions: [
        {
          ...projection.providerSessions[0]!,
          providerInstanceId: ProviderInstanceId.make("other"),
        },
      ],
    },
    { ...projection, providerTurns: [] },
    ...[
      "queued",
      "preparing",
      "starting",
      "waiting",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
    ].map((status) => ({ ...projection, runs: [{ ...projection.runs[0]!, status }] })),
  ])
    assert.isUndefined(restartContinuationRun(invalid as OrchestrationV2ThreadProjection, now));
});

it("continues a live turn whose session the adapter never marked running", () => {
  const projection = makeProjection();
  // Codex, Claude, Cursor and ACP sessions stay "ready" for their whole life.
  const withSessionStatus = (status: string) =>
    ({
      ...projection,
      providerSessions: [{ ...projection.providerSessions[0]!, status }],
    }) as OrchestrationV2ThreadProjection;
  for (const status of ["starting", "ready", "running", "waiting"])
    assert.equal(restartContinuationRun(withSessionStatus(status), now)?.id, runId, status);
  for (const status of ["stopped", "error"])
    assert.isUndefined(restartContinuationRun(withSessionStatus(status), now), status);
});

it("recovers an admitted continuation after another crash before provider start", () => {
  const projection = makeProjection();
  const starting = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "starting" as const,
        restartContinuationOfRunId: RunId.make("run:previous-crash"),
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  assert.equal(restartContinuationRun(starting, now)?.id, runId);
});

it.effect(
  "recovers a continuation cut after it started, before its provider reported the turn",
  () =>
    Effect.gen(function* () {
      const projection = makeProjection();
      // The turn start marked the run, its attempt and the provider thread
      // running, then captured the baseline checkpoint before starting the turn.
      const running = {
        ...projection,
        runs: [
          { ...projection.runs[0]!, restartContinuationOfRunId: RunId.make("run:previous-crash") },
        ],
        providerSessions: [{ ...projection.providerSessions[0]!, status: "ready" as const }],
        providerTurns: [],
      };
      assert.equal(restartContinuationRun(running, now)?.id, runId);
      const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(running),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeWithEffects: (input) =>
                Effect.sync(() => {
                  writes.push(input);
                  return [];
                }),
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
            Layer.mock(EffectOutbox.EffectOutboxV2)({}),
          ),
        ),
      );
      // An update's graceful shutdown records it too.
      yield* recovery.prepareForShutdown;
      assert.deepEqual(
        writes.map((write) => write.effects[0]?.request),
        [{ type: "provider-runtime.continue", sourceRunId: runId }],
      );
    }),
);

// The run still continues the earlier cut, but its new attempt carries the person's message.
it("does not resume a continuation the person restarted with their own message as the automatic one", () => {
  const projection = makeProjection();
  const restartedAttemptId = RunAttemptId.make("attempt:restart:restarted");
  for (const status of ["starting", "running"] as const) {
    const restarted = {
      ...projection,
      runs: [
        {
          ...projection.runs[0]!,
          status,
          activeAttemptId: restartedAttemptId,
          userMessageId: MessageId.make("message:restart:person"),
          restartContinuationOfRunId: RunId.make("run:previous-crash"),
        },
      ],
      attempts: [
        { id: attemptId, runId, reason: "initial", status: "superseded" },
        {
          id: restartedAttemptId,
          runId,
          reason: "steering_restart",
          status: status === "starting" ? "pending" : "running",
        },
      ],
      providerSessions: [{ ...projection.providerSessions[0]!, status: "ready" as const }],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.isUndefined(restartContinuationRun(restarted, now), status);
  }
});

it("does not continue settled root runs with restart-cancelled background work", () => {
  const projection = makeProjection();
  const settled = {
    ...projection,
    runs: [
      {
        ...projection.runs[0]!,
        status: "completed" as const,
        restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
      },
    ],
    providerThreads: [{ ...projection.providerThreads[0]!, status: "idle" as const }],
    providerSessions: [{ ...projection.providerSessions[0]!, status: "stopped" as const }],
    providerTurns: [],
  };
  for (const projectId of [scratchProjectId, projection.thread.projectId])
    for (const status of ["completed", "waiting"] as const)
      assert.isUndefined(
        restartContinuationRun(
          {
            ...settled,
            thread: { ...settled.thread, projectId },
            runs: [{ ...settled.runs[0]!, status }],
          },
          now,
        ),
      );
});

it.effect.each(["completed", "waiting", "cancelled"] as const)(
  "ignores a pending restart continuation for a %s run whose provider turn settled",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const work = [{ kind: "shell" as const, label: "sleep 25 && echo DONE" }];
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartCancelledBackgroundWork: work }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(projection),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.lengthOf(commands, 0);
    }),
);

it.effect.each(["completed", "waiting", "cancelled"] as const)(
  "wakes a %s run whose awaited monitor the restart cancelled, with the note as its prompt",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const work = [
        { kind: "monitor" as const, label: "Watch CI run 42", awaited: true as const },
        { kind: "shell" as const, label: "vp run dev" },
      ];
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status, restartCancelledBackgroundWork: work }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      } as unknown as OrchestrationV2ThreadProjection;
      const commands: Parameters<
        ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
      >[0][] = [];
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: () => Effect.succeed(projection),
              recoverDelegatedTask: () => Effect.void,
              dispatch: (command) => {
                commands.push(command);
                return Effect.succeed({} as never);
              },
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.lengthOf(commands, 1);
      const command = commands[0]!;
      assert.equal(command.type, "message.dispatch");
      if (command.type !== "message.dispatch") return;
      assert.equal(command.restartContinuationOfRunId, runId);
      assert.include(command.text, "- monitor: Watch CI run 42");
      assert.include(command.text, "- shell: vp run dev");
    }),
);

it.effect("does not continue a failed run that lost background work", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const projection = {
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "failed",
          restartCancelledBackgroundWork: [{ kind: "shell" as const, label: "sleep 25" }],
        },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "failed" }],
    } as unknown as OrchestrationV2ThreadProjection;
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              commands.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    assert.lengthOf(commands, 0);
  }),
);

it.effect.each([
  [false, undefined],
  [true, undefined],
  [false, true],
  [true, false],
] as const)(
  "records restart intent before it cancels the cut run when opt-in is %s and project override is %s",
  ([enabled, projectOverride]) =>
    Effect.gen(function* () {
      let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
      const written: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              continueThreadsAfterServerUpdate: enabled,
              projectSettingsOverrides:
                projectOverride === undefined
                  ? {}
                  : {
                      [ProjectId.make("restart-project")]: {
                        continueThreadsAfterServerUpdate: projectOverride,
                      },
                    },
            }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(makeProjection()),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeWithEffects: (input) =>
                Effect.sync(() => {
                  assert.isUndefined(committed, "intent is written before the cancellation");
                  written.push(...input.effects);
                  return [];
                }),
              commitCommand: (input) => {
                committed = input;
                return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile("startup");
      assert.isDefined(committed);
      assert.isTrue(
        committed!.events.some(
          (event) => event.type === "run.updated" && event.payload.status === "cancelled",
        ),
      );
      assert.deepEqual(
        written.map((effect) => effect.request),
        (projectOverride ?? enabled)
          ? [{ type: "provider-runtime.continue", sourceRunId: runId }]
          : [],
      );
    }),
);

it.effect("lets a cut blocking delegate_task wake its parent like an async task", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const task = (id: string, completionWake: "settled_only" | "always", status: string) => ({
      id: NodeId.make(id),
      threadId,
      runId,
      origin: "app_owned",
      childThreadId: ThreadId.make(`thread:${id}`),
      driver,
      providerInstanceId: instanceId,
      completionWake,
      status,
    });
    const projection = {
      ...base,
      subagents: [
        task("task:waited", "settled_only", "running"),
        task("task:async", "always", "running"),
        task("task:finished", "settled_only", "completed"),
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: () => Effect.succeed([]),
            commitCommand: (input) => {
              committed = input;
              return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
            },
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.reconcile("startup");
    const upgraded = (committed?.events ?? []).flatMap((event) =>
      event.type === "subagent.updated" ? [event.payload] : [],
    );
    assert.deepEqual(
      upgraded.map((row) => ({ id: row.id, completionWake: row.completionWake })),
      [{ id: NodeId.make("task:waited"), completionWake: "always" }],
    );
  }),
);

it.effect.each(["running", "waiting"])(
  "wakes a %s run to restart the native subagent it waited on",
  (status) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const item = (id: string, extra: Record<string, unknown>) => ({
        id,
        threadId,
        runId,
        nodeId: null,
        status: "running",
        ...extra,
      });
      const projection = {
        ...base,
        runs: [{ ...base.runs[0]!, status }],
        providerTurns: [
          { ...base.providerTurns[0]!, status: status === "waiting" ? "completed" : "running" },
        ],
        turnItems: [
          // Codex keeps a native subagent on its own child provider thread.
          item("item:native", {
            type: "subagent",
            origin: "provider_native",
            providerThreadId: ProviderThreadId.make("provider-thread:child"),
            nativeItemRef: { driver, nativeId: "agent-1" },
            title: "Sleeper",
            childThreadId: ThreadId.make("thread:child"),
          }),
          item("item:shell", { type: "command_execution", providerThreadId, input: "ls" }),
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      let committed: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] | undefined;
      const written: Array<EffectOutbox.PendingOrchestrationEffectV2> = [];
      const recovery = yield* ProviderRuntimeRecovery.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getRecoveryThreadIds: () => Effect.succeed([threadId]),
              getRuntimeRecoveryProjection: () => Effect.succeed(projection),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              writeWithEffects: (input) =>
                Effect.sync(() => {
                  written.push(...input.effects);
                  return [];
                }),
              commitCommand: (input) => {
                committed = input;
                return Effect.succeed({ committed: true, cancelledEffectCount: 0 } as never);
              },
            }),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
            Layer.mock(EffectOutbox.EffectOutboxV2)({
              listByCommandId: () => Effect.succeed([]),
              reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
            }),
          ),
        ),
      );
      yield* recovery.reconcile("startup");
      const work = (committed?.events ?? []).flatMap((event) =>
        event.type === "run.background-work-cancelled" ? [event.payload] : [],
      );
      // The subagent is reported on the run that awaited it. A running run's
      // shell died with its turn.
      assert.deepEqual(work, [
        {
          runId,
          restartCancelledBackgroundWork: [
            { kind: "subagent", label: "Sleeper (id agent-1)", id: "item:native" },
            ...(status === "waiting"
              ? [{ kind: "shell" as const, label: "ls", id: "item:shell" }]
              : []),
          ],
        },
      ]);
      assert.deepEqual(
        written.map((effect) => effect.request),
        [{ type: "provider-runtime.continue", sourceRunId: runId }],
      );
    }),
);

it.effect("does not duplicate delivery and yields to newer user work or opt-out", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    projection = { ...projection, runs: [{ ...projection.runs[0]!, status: "cancelled" }] };
    const commands: Parameters<
      ThreadManagementService.ThreadManagementService["Service"]["dispatch"]
    >[0][] = [];
    const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: () => Effect.succeed(projection),
      recoverDelegatedTask: () => Effect.void,
      dispatch: (command) => {
        commands.push(command);
        if (command.type === "message.dispatch")
          projection = { ...projection, messages: [{ id: command.messageId } as never] };
        return Effect.succeed({} as never);
      },
    });
    const layerEnabled = Layer.merge(
      layerThreads,
      ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    assert.match(String(commands[0]!.commandId), /run:restart$/);
    if (commands[0]!.type === "message.dispatch")
      assert.equal(commands[0]!.restartContinuationOfRunId, runId);
    projection = {
      ...projection,
      messages: [],
      runs: [
        ...projection.runs,
        {
          ...projection.runs[0]!,
          id: RunId.make("run:user-newer"),
          ordinal: 2,
          status: "completed",
        },
      ],
    };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(layerEnabled),
    );
    assert.lengthOf(commands, 1);
    projection = { ...projection, runs: [projection.runs[0]!] };
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.merge(
          layerThreads,
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: false }),
        ),
      ),
    );
    assert.lengthOf(commands, 1);
  }),
);

it.effect("prepares no continuation for background work another provider thread launched", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const claudeThreadId = ProviderThreadId.make("provider-thread:claude");
    // A Claude turn left a background subagent open, then the thread switched
    // to Codex and its turn settled. Recovery would cancel Claude's work.
    const projection = {
      ...base,
      runs: [{ ...base.runs[0]!, status: "completed" }],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      turnItems: [
        {
          id: "turn-item:claude-subagent",
          runId: RunId.make("run:claude"),
          providerThreadId: claudeThreadId,
          type: "subagent",
          status: "running",
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.lengthOf(writes, 0);
    // The same work on the settled run's own provider thread does wake it.
    const ownWork = {
      ...projection,
      turnItems: [{ ...projection.turnItems[0]!, providerThreadId }],
    } as OrchestrationV2ThreadProjection;
    const ownRecovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.succeed(ownWork),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* ownRecovery.prepareForShutdown;
    assert.lengthOf(writes, 1);
    assert.deepEqual(writes[0]!.effects[0]?.request, {
      type: "provider-runtime.continue",
      sourceRunId: runId,
    });
  }),
);

const backgroundSubagent = {
  turnItem: {
    id: "turn-item:background-subagent",
    runId,
    nodeId: null,
    providerThreadId,
    providerInstanceId: instanceId,
    type: "subagent",
    subagentId: "subagent:background",
    title: "Background reviewer",
    status: "running",
  },
  work: {
    kind: "subagent" as const,
    label: "Background reviewer",
    id: "turn-item:background-subagent",
  },
};
const devServer = {
  turnItem: {
    id: "turn-item:dev-server",
    runId,
    nodeId: null,
    providerThreadId,
    providerInstanceId: instanceId,
    type: "command_execution",
    input: "vp run dev",
    status: "running",
  },
  work: { kind: "shell" as const, label: "vp run dev", id: "turn-item:dev-server" },
};

it.effect.each([
  ["completed", scratchProjectId, backgroundSubagent, true],
  ["waiting", ProjectId.make("restart-project"), backgroundSubagent, true],
  ["completed", ProjectId.make("restart-project"), devServer, false],
  ["waiting", scratchProjectId, devServer, false],
] as const)(
  "cleans up background work of a %s run in project %s and wakes it only for awaited work",
  ([status, projectId, background, wakes]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const projection = {
        ...base,
        thread: { ...base.thread, projectId },
        runs: [{ ...base.runs[0]!, status }],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
        turnItems: [background.turnItem],
        subagents:
          background === backgroundSubagent
            ? [
                {
                  id: "subagent:background",
                  runId,
                  origin: "provider_native",
                  driver,
                  providerInstanceId: instanceId,
                  status: "running",
                },
              ]
            : [],
      } as unknown as OrchestrationV2ThreadProjection;
      for (const trigger of ["startup", "shutdown"] as const) {
        const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
        const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
        const recovery = yield* ProviderRuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getRecoveryThreadIds: () => Effect.succeed([threadId]),
                getRuntimeRecoveryProjection: () => Effect.succeed(projection),
              }),
              Layer.mock(EventSink.EventSinkV2)({
                writeWithEffects: (input) =>
                  Effect.sync(() => {
                    writes.push(input);
                    return [];
                  }),
                commitCommand: (input) =>
                  Effect.sync(() => {
                    commits.push(input);
                    return { committed: true, cancelledEffectCount: 0 } as never;
                  }),
              }),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
              Layer.mock(EffectOutbox.EffectOutboxV2)({
                listByCommandId: () => Effect.succeed([]),
                reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
              }),
            ),
          ),
        );
        if (trigger === "shutdown") yield* recovery.prepareForShutdown;
        yield* recovery.reconcile(trigger);
        // Shutdown and a startup after a kill both record the wake before
        // they cancel the work.
        const recorded = writes.flatMap((write) => write.effects);
        assert.lengthOf(commits[0]!.effects, 0);
        assert.deepEqual(
          recorded.map((effect) => effect.request),
          wakes ? [{ type: "provider-runtime.continue", sourceRunId: runId }] : [],
        );
        assert.lengthOf(commits, 1);
        const events = commits[0]!.events;
        assert.isTrue(
          events.some(
            (event) => event.type === "turn-item.updated" && event.payload.status === "cancelled",
          ),
        );
        const note = events.find((event) => event.type === "run.background-work-cancelled");
        assert.equal(note?.runId, runId);
        assert.deepEqual(note?.payload.restartCancelledBackgroundWork, [background.work]);
        if (status === "completed")
          assert.isFalse(events.some((event) => event.type === "run.updated"));
      }
    }),
);

it("does not wake a settled run for work left by a session that already stopped", () => {
  const base = makeProjection();
  const projection = {
    ...base,
    runs: [{ ...base.runs[0]!, status: "completed" }],
    providerThreads: [{ ...base.providerThreads[0]!, status: "idle" }],
    turnItems: [backgroundSubagent.turnItem],
  } as unknown as OrchestrationV2ThreadProjection;
  assert.equal(restartContinuationRun(projection, now)?.id, runId);
  for (const status of ["stopped", "error"])
    assert.isUndefined(
      restartContinuationRun(
        {
          ...projection,
          providerSessions: [{ ...projection.providerSessions[0]!, status }],
        } as OrchestrationV2ThreadProjection,
        now,
      ),
      status,
    );
});

it.effect("wakes a run whose subagent's own shell the restart cut, past a wake it cut first", () =>
  Effect.gen(function* () {
    const base = makeProjection();
    const cutWake = {
      ...base.runs[0]!,
      id: RunId.make("run:wake"),
      ordinal: 2,
      status: "starting",
      startedAt: null,
    };
    const withShell = (parentTaskId?: string) =>
      ({
        ...base,
        runs: [{ ...base.runs[0]!, status: "waiting", startedAt: now }, cutWake],
        providerThreads: [
          {
            ...base.providerThreads[0]!,
            status: "idle",
            pendingBackgroundTasks: [
              {
                kind: "command",
                taskId: "shell:1",
                description: "sleep 150",
                ...(parentTaskId === undefined ? {} : { parentTaskId }),
              },
            ],
          },
        ],
        providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
      }) as unknown as OrchestrationV2ThreadProjection;
    assert.equal(restartContinuationRun(withShell("agent:1"), now)?.id, runId);
    // A shell the agent started itself still does not wake it.
    assert.isUndefined(restartContinuationRun(withShell(), now));

    const texts = yield* continuationTexts({
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "completed",
          startedAt: now,
          completedAt: now,
          restartCancelledBackgroundWork: [
            { kind: "subagent", label: "sleep 150 (subagent agent:1)", id: "agent:1" },
          ],
        },
        { ...cutWake, status: "cancelled", completedAt: now },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(texts, 1);
    assert.include(texts[0], "- subagent: sleep 150 (subagent agent:1)");
    // A run the user stopped before it started still takes precedence.
    const stopped = yield* continuationTexts({
      ...base,
      runs: [
        {
          ...base.runs[0]!,
          status: "completed",
          startedAt: now,
          completedAt: now,
          restartCancelledBackgroundWork: [
            { kind: "subagent", label: "sleep 150 (subagent agent:1)", id: "agent:1" },
          ],
        },
        { ...cutWake, status: "interrupted", completedAt: now },
      ],
      providerTurns: [{ ...base.providerTurns[0]!, status: "completed" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(stopped, 0);
  }),
);

it.effect("does not cancel or resume a run that completes while shutdown intent commits", () =>
  Effect.gen(function* () {
    let projection = makeProjection();
    const commits: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([threadId]),
            getRuntimeRecoveryProjection: () => Effect.sync(() => projection),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                assert.lengthOf(input.events, 0);
                assert.equal(input.effects[0]?.request.type, "provider-runtime.continue");
                projection = {
                  ...projection,
                  runs: [{ ...projection.runs[0]!, status: "completed" }],
                };
                return [];
              }),
            commitCommand: (input) =>
              Effect.sync(() => {
                commits.push(input);
                return { committed: true, cancelledEffectCount: 0 } as never;
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
            runRecoveryOnce: Effect.succeed(false),
          }),
          Layer.mock(EffectOutbox.EffectOutboxV2)({
            reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
          }),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    yield* recovery.reconcile("shutdown");
    assert.isFalse(
      commits.some((commit) => commit.events.some((event) => event.type === "run.updated")),
    );
    let dispatched = false;
    yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: () =>
              Effect.sync(() => {
                dispatched = true;
                return {} as never;
              }),
          }),
        ),
      ),
    );
    assert.isFalse(dispatched);
  }),
);

const continuationDispatches = (
  projection: OrchestrationV2ThreadProjection,
  sourceRunId: RunId = runId,
) =>
  Effect.gen(function* () {
    const dispatches: Array<Extract<OrchestrationV2Command, { type: "message.dispatch" }>> = [];
    yield* continueRestartedRun({ threadId, sourceRunId }).pipe(
      Effect.provide(
        Layer.merge(
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(projection),
            recoverDelegatedTask: () => Effect.void,
            dispatch: (command) => {
              if (command.type === "message.dispatch") dispatches.push(command);
              return Effect.succeed({} as never);
            },
          }),
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
        ),
      ),
    );
    return dispatches;
  });

const continuationTexts = (projection: OrchestrationV2ThreadProjection) =>
  continuationDispatches(projection).pipe(
    Effect.map((dispatches) => dispatches.map((command) => command.text)),
  );

const cutMidTurn = (extra: Record<string, unknown> = {}) => {
  const base = makeProjection();
  return {
    ...base,
    runs: [
      {
        ...base.runs[0]!,
        status: "cancelled",
        completedAt: now,
        userMessageId: MessageId.make("message:user"),
        ...extra,
      },
    ],
    providerTurns: [{ ...base.providerTurns[0]!, status: "cancelled" }],
  } as unknown as OrchestrationV2ThreadProjection;
};

const queuedFollowUp = {
  id: RunId.make("run:queued"),
  ordinal: 2,
  providerInstanceId: instanceId,
  providerThreadId,
  status: "queued",
  queueHeld: true,
};

it.effect("continues a cut run past queued follow-ups, which stay held", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    assert.equal(
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, queuedFollowUp],
        } as unknown as OrchestrationV2ThreadProjection,
        now,
      )?.id,
      runId,
    );
    const cut = cutMidTurn();
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, queuedFollowUp],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, [CONTINUE_PROMPT]);
  }),
);

it.effect("continues a resumed queued run that ran after an earlier continuation", () =>
  Effect.gen(function* () {
    // The continuation (ordinal 3) ran ahead of the held queue, then the user
    // resumed the queued run (ordinal 1 here) and the server restarted again.
    const finishedContinuation = {
      id: RunId.make("run:earlier-continuation"),
      ordinal: 3,
      providerInstanceId: instanceId,
      providerThreadId,
      status: "completed",
      completedAt: DateTime.makeUnsafe("2026-10-03T10:00:00.000Z"),
    };
    const live = makeProjection();
    assert.equal(
      restartContinuationRun(
        {
          ...live,
          runs: [...live.runs, finishedContinuation],
        } as unknown as OrchestrationV2ThreadProjection,
        now,
      )?.id,
      runId,
    );
    const cut = cutMidTurn({ completedAt: DateTime.makeUnsafe("2026-10-03T10:05:00.000Z") });
    const texts = yield* continuationTexts({
      ...cut,
      runs: [...cut.runs, finishedContinuation],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, [CONTINUE_PROMPT]);
  }),
);

it("backs off twice from a continuation the provider never took, then lets it fail", () => {
  const base = makeProjection();
  const failedStart = (id: string, of: RunId) => ({
    ...base.runs[0]!,
    id: RunId.make(id),
    activeAttemptId: RunAttemptId.make(`attempt:${id}`),
    status: "failed" as const,
    restartContinuationOfRunId: of,
  });
  const first = failedStart("run:retry-1", runId);
  const second = failedStart("run:retry-2", first.id);
  const third = failedStart("run:retry-3", second.id);
  const projection = (failureClass = "provider_error", providerTurns = base.providerTurns) =>
    ({
      runs: [{ ...base.runs[0]!, status: "cancelled" }, first, second, third],
      providerTurns,
      turnItems: [first, second, third].map((run) => ({
        id: `error:${run.id}`,
        type: "error",
        status: "failed",
        runId: run.id,
        nodeId: run.rootNodeId,
        ordinal: 1,
        updatedAt: now,
        failure: { class: failureClass, message: "Failed.", code: null, retryable: null },
      })),
    }) as unknown as Parameters<typeof continuationStartRetryDelayMs>[1];
  assert.deepEqual(
    [first, second, third].map((run) => continuationStartRetryDelayMs(run, projection())),
    [60_000, 180_000, undefined],
  );
  for (const failureClass of ["usage_limit", "permission_error", "validation_error"])
    assert.isUndefined(continuationStartRetryDelayMs(first, projection(failureClass)));
  // Once the provider took the prompt, starting again would repeat the turn.
  assert.isUndefined(
    continuationStartRetryDelayMs(
      first,
      projection("provider_error", [
        { ...base.providerTurns[0]!, runAttemptId: first.activeAttemptId, status: "failed" },
      ] as never),
    ),
  );
});

it.effect("continues again after a continuation fails before its prompt", () =>
  Effect.gen(function* () {
    const cut = cutMidTurn();
    const failedStart = {
      ...cut.runs[0]!,
      id: RunId.make("run:failed-start"),
      ordinal: 2,
      activeAttemptId: RunAttemptId.make("attempt:failed-start"),
      status: "failed",
      restartContinuationOfRunId: runId,
    };
    const dispatches = yield* continuationDispatches(
      { ...cut, runs: [...cut.runs, failedStart] } as unknown as OrchestrationV2ThreadProjection,
      failedStart.id,
    );
    assert.deepEqual(
      dispatches.map((command) => command.restartContinuationOfRunId),
      [failedStart.id],
    );
  }),
);

it.effect.each([
  ["running", null, 0],
  ["completed", "Done.", 1],
] as const)(
  "a parent's Stop on the task's run blocks the child only while the task is %s",
  ([status, result, expected]) =>
    Effect.gen(function* () {
      const parentThreadId = ThreadId.make("thread:parent");
      const parentRunId = RunId.make("run:parent");
      const taskId = NodeId.make("node:task");
      const cut = cutMidTurn();
      const child = {
        ...cut,
        thread: {
          ...cut.thread,
          lineage: { parentThreadId, relationshipToParent: "subagent" },
          forkedFrom: { type: "node", nodeId: taskId },
        },
      } as unknown as OrchestrationV2ThreadProjection;
      const parent = {
        thread: { id: parentThreadId },
        subagents: [{ id: taskId, runId: parentRunId, origin: "app_owned", status, result }],
        turnItems: [{ id: "turn-item:stop", runId: parentRunId, type: "run_interrupt_request" }],
      };
      let dispatched = 0;
      yield* continueRestartedRun({ threadId, sourceRunId: runId }).pipe(
        Effect.provide(
          Layer.merge(
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              getThreadRecords: (id) =>
                Effect.succeed((id === parentThreadId ? parent : child) as never),
              recoverDelegatedTask: () => Effect.void,
              dispatch: () =>
                Effect.sync(() => {
                  dispatched += 1;
                  return {} as never;
                }),
            }),
            ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          ),
        ),
      );
      assert.equal(dispatched, expected);
    }),
);

it.effect("does not continue a run the user asked to stop before the restart", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      turnItems: [{ id: "turn-item:interrupt", runId, type: "run_interrupt_request" }],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.deepEqual(texts, []);
  }),
);

it.effect("does not continue a cut /compact or /logout turn", () =>
  Effect.gen(function* () {
    // A compaction with instructions is one too (isNativeCompactCommand).
    for (const text of ["/compact", " /LOGOUT ", "/compact later"]) {
      const texts = yield* continuationTexts({
        ...cutMidTurn(),
        messages: [{ id: MessageId.make("message:user"), text, attachments: [] }],
      } as unknown as OrchestrationV2ThreadProjection);
      assert.deepEqual(texts, [], text);
    }
    const texts = yield* continuationTexts({
      ...cutMidTurn(),
      messages: [
        { id: MessageId.make("message:user"), text: "/compaction notes", attachments: [] },
      ],
    } as unknown as OrchestrationV2ThreadProjection);
    assert.lengthOf(texts, 1);
  }),
);

it.effect("tells a turn cut mid-way about the background work it lost", () =>
  Effect.gen(function* () {
    const texts = yield* continuationTexts(
      cutMidTurn({
        restartCancelledBackgroundWork: [{ kind: "subagent", label: "Background reviewer" }],
      }),
    );
    assert.lengthOf(texts, 1);
    assert.include(texts[0]!, "Background reviewer");
    assert.isTrue(texts[0]!.endsWith(CONTINUE_PROMPT));
  }),
);

it.effect("shows a continuation as a Caveman Code notice whose detail is the prompt", () =>
  Effect.gen(function* () {
    const [resumed] = yield* continuationDispatches(cutMidTurn());
    assert.deepEqual(resumed?.notification, {
      source: { kind: "system" },
      outcome: "updated",
      summary: "Caveman Code restarted and resumed this turn",
      detail: CONTINUE_PROMPT,
    });
  }),
);

it.effect(
  "carries the note forward when its continuation was cut before reaching the provider",
  () =>
    Effect.gen(function* () {
      const base = makeProjection();
      const original = {
        ...base.runs[0]!,
        id: RunId.make("run:original"),
        status: "completed",
        activeAttemptId: RunAttemptId.make("attempt:original"),
        restartCancelledBackgroundWork: [{ kind: "shell", label: "sleep 25 && echo DONE" }],
      };
      const projection = {
        ...base,
        runs: [
          original,
          {
            ...base.runs[0]!,
            ordinal: 2,
            status: "cancelled",
            restartContinuationOfRunId: original.id,
          },
        ],
        // The original turn settled; the continuation's attempt never started one.
        providerTurns: [
          {
            ...base.providerTurns[0]!,
            runAttemptId: original.activeAttemptId,
            status: "completed",
          },
        ],
      } as unknown as OrchestrationV2ThreadProjection;
      const texts = yield* continuationTexts(projection);
      assert.lengthOf(texts, 1);
      assert.include(texts[0]!, "sleep 25 && echo DONE");
      assert.notInclude(texts[0]!, "Continue where");
    }),
);

it.effect("prepares later threads' continuations when one thread fails", () =>
  Effect.gen(function* () {
    const brokenThreadId = ThreadId.make("thread:broken");
    const writes: Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0][] = [];
    const recovery = yield* ProviderRuntimeRecovery.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getRecoveryThreadIds: () => Effect.succeed([brokenThreadId, threadId]),
            getRuntimeRecoveryProjection: (id) =>
              id === brokenThreadId
                ? Effect.fail(
                    new ProjectionStore.ProjectionStoreThreadNotFoundError({ threadId: id }),
                  )
                : Effect.succeed(makeProjection()),
          }),
          Layer.mock(EventSink.EventSinkV2)({
            writeWithEffects: (input) =>
              Effect.sync(() => {
                writes.push(input);
                return [];
              }),
          }),
          IdAllocator.layer,
          Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({}),
          Layer.mock(EffectOutbox.EffectOutboxV2)({}),
        ),
      ),
    );
    yield* recovery.prepareForShutdown;
    assert.deepEqual(
      writes.map((write) => write.effects[0]?.request),
      [{ type: "provider-runtime.continue", sourceRunId: runId }],
    );
  }),
);

it.effect("stops rapid restart loops but allows repeated restarts after normal work", () =>
  Effect.gen(function* () {
    const first = RunId.make("run:first-continuation");
    const second = RunId.make("run:second-continuation");
    const cut = cutMidTurn({ restartContinuationOfRunId: second });
    const withTwoLinks = {
      ...cut,
      runs: [
        ...cut.runs,
        { ...cut.runs[0]!, id: second, restartContinuationOfRunId: first },
        { ...cut.runs[0]!, id: first, restartContinuationOfRunId: undefined },
      ],
    } as unknown as OrchestrationV2ThreadProjection;
    assert.lengthOf(yield* continuationTexts(withTwoLinks), 1);

    const withThreeLinks = {
      ...withTwoLinks,
      runs: withTwoLinks.runs.map((run) =>
        run.id === first ? { ...run, restartContinuationOfRunId: RunId.make("run:root") } : run,
      ),
    } as unknown as OrchestrationV2ThreadProjection;
    const minute = 60_000;
    // How long before `now` the cut run, the second and the first were requested.
    for (const { completedAt, requestAges, expected } of [
      // Each continuation was requested within five minutes of the next one.
      { completedAt: null, requestAges: [minute, 2 * minute, 7 * minute], expected: 0 },
      { completedAt: now, requestAges: [minute, 2 * minute, 6 * minute], expected: 0 },
      // One of them worked for longer before the restart that cut it.
      { completedAt: null, requestAges: [minute, 2 * minute, 7 * minute + 1], expected: 1 },
      { completedAt: now, requestAges: [5 * minute + 1, 6 * minute, 7 * minute], expected: 1 },
    ]) {
      const projection = {
        ...withThreeLinks,
        runs: withThreeLinks.runs.map((run, index) => ({
          ...run,
          completedAt,
          requestedAt: DateTime.subtract(now, { milliseconds: requestAges[index]! }),
        })),
      };
      assert.lengthOf(yield* continuationTexts(projection), expected);
    }
  }),
);

it.effect("stops a turn that brings the server down a few minutes after every resume", () =>
  Effect.gen(function* () {
    // The user's turn and `continuations` automatic ones after it, each
    // requested as a life booted and cancelled by the next boot, which is
    // asked whether to continue the latest.
    const loop = (continuations: number, lifeMinutes: number) => {
      const cut = cutMidTurn();
      const ids = Array.from({ length: continuations + 1 }, (_, life) =>
        life === continuations ? runId : RunId.make(`run:loop:${life}`),
      );
      const at = (life: number) =>
        DateTime.subtract(now, { minutes: (continuations + 1 - life) * lifeMinutes });
      return {
        ...cut,
        runs: ids.map((id, life) => ({
          ...cut.runs[0]!,
          id,
          ordinal: life + 1,
          requestedAt: at(life),
          completedAt: at(life + 1),
          restartContinuationOfRunId: life === 0 ? undefined : ids[life - 1],
        })),
      } as unknown as OrchestrationV2ThreadProjection;
    };
    assert.lengthOf(yield* continuationTexts(loop(2, 2)), 1);
    for (const continuations of [3, 4, 18])
      assert.deepEqual(yield* continuationTexts(loop(continuations, 2)), [], `${continuations}`);
    // Lives further apart than the loop window are separate restarts.
    assert.lengthOf(yield* continuationTexts(loop(18, 6)), 1);
  }),
);

it.effect.each([
  ["user_input", "pending", "live", false],
  ["user_input", "expired", "not_resumable", false],
  ["user_input", "cancelled", "not_resumable", false],
  ["command", "pending", "live", false],
  ["command", "expired", "not_resumable", false],
  ["user_input", "resolved", "live", true],
  ["command", "cancelled", "live", true],
  ["user_input", "pending", "message", true],
  ["dynamic_tool_call", "pending", "live", true],
  ["auth_refresh", "pending", "live", true],
] as const)(
  "a %s request that is %s with %s capability allows continuation: %s",
  ([kind, status, capability, shouldContinue]) =>
    Effect.gen(function* () {
      const base = makeProjection();
      const runtimeRequests = [
        {
          id: RuntimeRequestId.make("request:restart"),
          nodeId: NodeId.make("node:restart-question"),
          providerTurnId: base.providerTurns[0]!.id,
          kind,
          status,
          responseCapability:
            capability === "live"
              ? { type: capability, providerSessionId: sessionId }
              : capability === "not_resumable"
                ? { type: capability, reason: "The server restarted." }
                : { type: capability },
        },
      ];
      const live = { ...base, runtimeRequests } as unknown as OrchestrationV2ThreadProjection;
      assert.equal(restartContinuationRun(live, now) !== undefined, shouldContinue);
      const cut = {
        ...cutMidTurn(),
        runtimeRequests,
      } as unknown as OrchestrationV2ThreadProjection;
      assert.lengthOf(yield* continuationTexts(cut), shouldContinue ? 1 : 0);
    }),
);

it.effect("does not wake a snoozed or settled thread, but continues once a snooze elapsed", () =>
  Effect.gen(function* () {
    const live = makeProjection();
    for (const held of [
      { snoozedUntil: DateTime.add(now, { days: 1 }) },
      { settledOverride: "settled" as const },
    ]) {
      const thread = { ...live.thread, ...held };
      assert.isUndefined(restartContinuationRun({ ...live, thread }, now));
      assert.deepEqual(yield* continuationTexts({ ...cutMidTurn(), thread }), []);
    }
    const thread = { ...live.thread, snoozedUntil: DateTime.subtract(now, { minutes: 1 }) };
    assert.equal(restartContinuationRun({ ...live, thread }, now)?.id, runId);
  }),
);

it.effect("does not continue a run waiting on a secret the restart closed", () =>
  Effect.gen(function* () {
    const completedAt = DateTime.makeUnsafe("2026-10-03T10:05:00.000Z");
    const secret = (secretStatus: string, at: DateTime.Utc | null) =>
      ({ type: "secret_request", runId, secretStatus, completedAt: at }) as never;
    assert.isUndefined(
      restartContinuationRun({ ...makeProjection(), turnItems: [secret("pending", null)] }, now),
    );
    const cut = cutMidTurn({ completedAt });
    assert.deepEqual(
      yield* continuationTexts({ ...cut, turnItems: [secret("cancelled", completedAt)] }),
      [],
    );
    // A secret the user dismissed earlier in the run does not hold it.
    assert.lengthOf(
      yield* continuationTexts({
        ...cut,
        turnItems: [secret("cancelled", DateTime.subtract(completedAt, { seconds: 1 }))],
      }),
      1,
    );
  }),
);

it.effect.each(["completed", "failed", "interrupted"] as const)(
  "does not continue when the provider turn %s before the app run settled",
  (status) =>
    Effect.gen(function* () {
      const cut = cutMidTurn();
      assert.deepEqual(
        yield* continuationTexts({
          ...cut,
          providerTurns: [{ ...cut.providerTurns[0]!, status }],
        }),
        [],
      );
    }),
);
