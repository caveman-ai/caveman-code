import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2ServerCommand,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { checkpointWorkspace } from "@caveman-app/engine-testing/replayWorkspace";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { STEER_UNANSWERED_STOP_REASON } from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };

type ProviderCall = "start" | "steer" | "interrupt";

/**
 * A Codex stand-in whose first session stays up but stops answering the calls in `unanswered`.
 * Each such call settles only when the session's process ends (its scope closes), as Codex's
 * JSON-RPC requests and Claude's control requests do. Later sessions answer everything.
 */
const unresponsiveProviderHarness = Effect.fn("unresponsiveProviderHarness")(function* (
  name: string,
  unanswered: ReadonlySet<ProviderCall>,
  steering: "active" | "interrupt-restart" = "active",
) {
  const cwd = yield* checkpointWorkspace(name);
  const started: ProviderAdapter.ProviderAdapterV2TurnInput[] = [];
  const steered: string[] = [];
  const sessions = { opened: 0, ended: 0 };
  const sessionEvents: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>[] = [];
  const capabilities = {
    ...CodexProviderCapabilitiesV2,
    turns: {
      ...CodexProviderCapabilitiesV2.turns,
      supportsActiveSteering: steering === "active",
      supportsSteeringByInterruptRestart: steering === "interrupt-restart",
    },
  };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        sessions.opened += 1;
        const stopsAnswering = sessions.opened === 1;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        sessionEvents.push(events);
        const processEnded = yield* Deferred.make<never, ProviderAdapter.ProviderAdapterV2Error>();
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sessions.ended += 1;
          }).pipe(
            Effect.andThen(
              Deferred.fail(
                processEnded,
                new ProviderAdapter.ProviderAdapterProtocolError({
                  driver,
                  detail: "The provider process ended.",
                }),
              ),
            ),
          ),
        );
        const answer = <A>(
          call: ProviderCall,
          answered: Effect.Effect<A, ProviderAdapter.ProviderAdapterV2Error>,
        ) => (stopsAnswering && unanswered.has(call) ? Deferred.await(processEnded) : answered);
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            answer(
              "start",
              Effect.gen(function* () {
                started.push(turn);
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: now,
                    completedAt: null,
                  },
                });
              }),
            ),
          steerTurn: (turn) =>
            answer(
              "steer",
              Effect.sync(() => {
                steered.push(turn.message.text);
              }),
            ),
          interruptTurn: () => answer("interrupt", Effect.void),
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  // The real effect worker daemon runs every effect, as on a server. The test shares its database.
  const database = SqlitePersistence.layerMemory;
  const layer = Layer.merge(
    ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(adapter),
      {
        databaseLayer: database,
      },
    ),
    database,
  );
  return { cwd, started, steered, sessions, sessionEvents, layer };
});

const createThread = (name: string, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make(`project:${name}`),
      title: "An agent that stops answering",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    return threadId;
  });

type DispatchMode = Extract<
  OrchestrationV2ServerCommand,
  { readonly type: "message.dispatch" }
>["dispatchMode"];

const send = (threadId: ThreadId, text: string, dispatchMode: DispatchMode) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(text),
      threadId,
      messageId: MessageId.make(`message:${text}`),
      text,
      attachments: [],
      dispatchMode,
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** Starts the thread's first turn and waits until its provider turn runs. */
const startFirstTurn = (name: string, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = yield* createThread(name, cwd);
    const running = yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.forkScoped,
    );
    yield* send(threadId, "first", { type: "start_immediately" });
    yield* Fiber.join(running);
    return threadId;
  });

/**
 * Moves the test clock in small steps while the daemon, the store and the provider stand-in run
 * on the real event loop, until `done` holds. Each step is small next to the budgets involved.
 */
const advanceUntil = <E>(failure: string, limit: "25 minutes", done: Effect.Effect<boolean, E>) =>
  Effect.gen(function* () {
    for (let elapsed = 0; elapsed <= 25 * 60; elapsed += 2) {
      if (yield* done) return;
      yield* TestClock.adjust("2 seconds");
      yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 10)));
    }
    assert.fail(`${failure} within ${limit}`);
  });

it.effect(
  "a Stop the provider never answers ends the turn, and the next message starts on a new session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "unanswered-stop";
        const harness = yield* unresponsiveProviderHarness(name, new Set(["interrupt"]));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* startFirstTurn(name, harness.cwd);
          const first = harness.started[0]!;
          // Stop as the app sends it: what is queued behind the turn waits.
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("stop"),
            threadId,
            runId: first.runId,
            holdQueue: true,
          });
          // The person writes again while the stopped turn still reads as running.
          yield* send(threadId, "next", { type: "queue_after_active" });

          yield* advanceUntil(
            "the message sent after an unanswered Stop never started",
            "25 minutes",
            Effect.sync(() =>
              harness.started.some((turn) => turn.message.messageId === "message:next"),
            ),
          );

          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            projection.runs.find((run) => run.id === first.runId)?.status,
            "interrupted",
          );
          // The stopped turn's session ended; the next turn opened a new one.
          assert.deepEqual(harness.sessions, { opened: 2, ended: 1 });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  { timeout: 180_000 },
);

it.effect(
  "a steer the provider never answers stops its turn and starts as a turn of its own",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "unanswered-steer";
        const harness = yield* unresponsiveProviderHarness(name, new Set(["steer", "interrupt"]));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* startFirstTurn(name, harness.cwd);
          const first = harness.started[0]!;
          yield* send(threadId, "also update the changelog", {
            type: "steer_active",
            targetRunId: first.runId,
          });

          yield* advanceUntil(
            "the steer the provider never answered never reached it",
            "25 minutes",
            Effect.sync(() =>
              harness.started.some(
                (turn) => turn.message.messageId === "message:also update the changelog",
              ),
            ),
          );

          assert.deepEqual(harness.steered, []);
          const projection = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            projection.runs.find((run) => run.id === first.runId)?.status,
            "interrupted",
          );
          const stop = projection.turnItems.find(
            (item) => item.runId === first.runId && item.type === "run_interrupt_result",
          );
          assert.equal(
            stop?.type === "run_interrupt_result" ? stop.message : undefined,
            STEER_UNANSWERED_STOP_REASON,
          );
          assert.deepEqual(harness.sessions, { opened: 2, ended: 1 });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  { timeout: 180_000 },
);

it.effect(
  "a turn start the provider never answers fails its run, and the next message starts on a new session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "unanswered-start";
        const harness = yield* unresponsiveProviderHarness(name, new Set(["start"]));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = yield* createThread(name, harness.cwd);
          yield* send(threadId, "first", { type: "start_immediately" });
          const firstRun = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
            projection.runs.find((run) => run.userMessageId === "message:first"),
          );

          yield* advanceUntil(
            "the turn start the provider never answered never ended its run",
            "25 minutes",
            Effect.map(firstRun, (run) => run?.status === "failed"),
          );

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const failure = projection.turnItems.find(
            (item) => item.runId === (projection.runs[0]?.id ?? null) && item.type === "error",
          );
          assert.include(
            failure?.type === "error" ? failure.failure.message : "",
            "The provider stopped answering: a turn start got no reply within 20m.",
          );
          assert.deepEqual(harness.sessions, { opened: 1, ended: 1 });

          yield* send(threadId, "again", { type: "start_immediately" });
          yield* advanceUntil(
            "the message sent after an unanswered turn start never started",
            "25 minutes",
            Effect.sync(() =>
              harness.started.some((turn) => turn.message.messageId === "message:again"),
            ),
          );
          assert.deepEqual(harness.sessions, { opened: 2, ended: 1 });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  { timeout: 180_000 },
);

it.effect(
  "a restart whose interrupt the provider never answers starts its turn again on a new session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "unanswered-restart";
        const harness = yield* unresponsiveProviderHarness(
          name,
          new Set(["interrupt"]),
          "interrupt-restart",
        );
        yield* Effect.gen(function* () {
          const threadId = yield* startFirstTurn(name, harness.cwd);
          const first = harness.started[0]!;
          yield* send(threadId, "use the other approach", {
            type: "restart_active",
            targetRunId: first.runId,
          });

          yield* advanceUntil(
            "the restart whose interrupt the provider never answered never started again",
            "25 minutes",
            Effect.sync(() => harness.started.length > 1),
          );

          assert.equal(harness.started[1]?.runId, first.runId);
          assert.deepEqual(harness.sessions, { opened: 2, ended: 1 });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  { timeout: 180_000 },
);

it.effect(
  "a run whose ingestion fails while the provider stops answering ends its session, and the next message starts on a new one",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const name = "unanswered-ingestion-failure";
        const harness = yield* unresponsiveProviderHarness(name, new Set(["interrupt"]));
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const sql = yield* SqlClient.SqlClient;
          const threadId = yield* startFirstTurn(name, harness.cwd);
          const first = harness.started[0]!;
          // The store refuses the turn's next update, as a full disk would.
          yield* sql.unsafe(`
            CREATE TEMP TRIGGER refuse_provider_turn_updates
            BEFORE INSERT ON orchestration_events
            WHEN NEW.event_type = 'provider-turn.updated'
            BEGIN SELECT RAISE(ABORT, 'database or disk is full'); END
          `);
          const firstTurn = (yield* orchestrator.getThreadProjection(threadId)).providerTurns[0]!;
          yield* Queue.offer(harness.sessionEvents[0]!, {
            type: "provider_turn.updated",
            driver,
            providerTurn: firstTurn,
          });
          const firstRun = Effect.map(orchestrator.getThreadProjection(threadId), (projection) =>
            projection.runs.find((run) => run.id === first.runId),
          );
          yield* advanceUntil(
            "the run whose ingestion failed never failed",
            "25 minutes",
            Effect.map(firstRun, (run) => run?.status === "failed"),
          );
          yield* sql.unsafe("DROP TRIGGER refuse_provider_turn_updates");

          yield* send(threadId, "next", { type: "start_immediately" });
          yield* advanceUntil(
            "the message sent after the failed run never started",
            "25 minutes",
            Effect.sync(() =>
              harness.started.some((turn) => turn.message.messageId === "message:next"),
            ),
          );

          const projection = yield* orchestrator.getThreadProjection(threadId);
          const next = projection.runs.find((run) => run.userMessageId === "message:next");
          assert.equal(next?.status, "running");
          assert.deepEqual(
            projection.turnItems.filter((item) => item.type === "error" && item.runId === next?.id),
            [],
          );
          assert.equal(
            projection.providerTurns.find((turn) => turn.id === firstTurn.id)?.status,
            "interrupted",
          );
          // The session that stopped answering ended; the next turn opened a new one.
          assert.deepEqual(harness.sessions, { opened: 2, ended: 1 });
        }).pipe(Effect.provide(harness.layer));
      }),
    ),
  { timeout: 180_000 },
);
