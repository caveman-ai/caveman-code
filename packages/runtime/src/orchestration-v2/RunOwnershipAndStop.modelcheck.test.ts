/**
 * Model check: who owns a run while Stop races the provider path.
 *
 * Drives the real Orchestrator (thread.stop), EffectWorker, ProviderTurnStartService, RunExecutionService,
 * ProviderTurnControlService, ProjectionStore and EventSink over in-memory SQLite. The checker's gates live only in
 * test doubles: the scripted provider adapter, an EventSink wrapper that parks Stop between its plan and its commit and
 * the start's starting-to-running write before it reaches the writer, and a ProjectionStore wrapper that parks the run's
 * ownership read before its terminal write. Two SQLite triggers on
 * the real thread projection table log any write that moves its updatedAt or active provider thread backward.
 *
 * Queue mode ("queued runs between runs" below) drives the same runtime through the thread's queued runs: each run's
 * end, the Orchestrator's end-of-run reaction (parked by the EventSink wrapper's stream), and the messages, Stop and
 * failed starts that come between them. The skill at .claude/skills/run-ownership-and-stop/SKILL.md says what this
 * covers and how to read a counterexample.
 */
import { describe, expect, it } from "vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2StoredEvent,
} from "@caveman-app/protocol";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as References from "effect/References";
import * as Stream from "effect/Stream";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as SqlClient from "effect/sql/SqlClient";
import {
  assertHolds,
  checkAsync,
  formatTrace,
  replay,
  VirtualTimers,
  type Action,
  type AsyncSpec,
  type Verdict,
} from "@caveman-app/model-check";
import { Gates, openHarness, type Harness } from "@caveman-app/model-check/effect";
import { canonicalKey } from "@caveman-app/model-check";
import * as McpProviderSessions from "@caveman-app/engine-core/server/McpProviderSessions";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as CommandPolicy from "./CommandPolicy.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderSwitchService from "./ProviderSwitchService.ts";
import * as ProviderTurnControlService from "./ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "./ProviderTurnStartService.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";
import * as RuntimeRequestService from "./RuntimeRequestService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadForkService from "./ThreadForkService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "./ThreadTitleRegenerationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { makeReplayServerConfig } from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const threadId = ThreadId.make("thread:stop");

/** Which actor a fiber acts for; forked children inherit it. */
class Actor extends Context.Reference<string>("modelcheck/RunOwnershipAndStop/Actor", {
  defaultValue: () => "",
}) {}

type ProviderEvent = ProviderAdapter.ProviderAdapterV2Event;

interface ScriptedTurn {
  readonly id: string;
  /** running: the provider works on it; ending: its terminal is on the way; ended: the runtime has its terminal. */
  status: "running" | "ending" | "ended";
  endedBy: "provider" | "interrupt" | null;
  interruptCalls: number;
  /** The adapter dropped the turn before reporting it, so the runtime never hears of it. */
  forgotten: boolean;
  readonly runOrdinal: number;
  readonly snapshot: OrchestrationV2ProviderTurn;
}

/** The provider as the runtime sees it through the adapter: what it was asked, and what it reports, in order. */
interface ScriptedProvider {
  readonly turns: Array<ScriptedTurn>;
  /** Events the provider has emitted that the runtime has not received yet, oldest first. */
  readonly unreported: Array<{ readonly label: string; readonly event: ProviderEvent }>;
  delivered: Queue.Queue<ProviderEvent> | undefined;
  /**
   * Deliver an interrupt's reports with the interrupt, for a restart: its effect waits for them through a bounded loop
   * of yields, not a gate, so a separate step would come after it gave up.
   */
  reportInterruptsAtOnce: boolean;
  /** Queue mode: every report reaches the runtime as the provider sends it, so a turn's path to the provider is not a schedule of its own. */
  reportAtOnce: boolean;
  /** Queue mode: the messages whose turn/start the provider refuses. */
  readonly refuses: ReadonlySet<string>;
}

/** What the EventSink wrapper saw: Stop's commit, failed compare-and-sets, and each effect a committed write enqueued. */
interface Probe {
  stopCommitted: boolean;
  /** Each compare-and-set that did not commit, named for the write it guarded (`casWrite`), in order. */
  readonly failedCas: Array<string>;
  readonly failedCasEventIds: Set<string>;
  readonly committedEffectIds: Set<string>;
  /**
   * Each checkpoint.capture, to the settled run.updated committed in the write that enqueued it (null if none). Only the
   * first such write counts: the outbox ignores a repeated effect id, so that write's row is the one that stays.
   */
  readonly checkpointTerminalEventIds: Map<string, string | null>;
  /** Queue mode: the log position after Stop's committed write, the point from which Stop holds the queue. */
  stopCommitSequence: number | undefined;
  /** Queue mode: how many run ends the Orchestrator's end-of-run reaction has reached (parked at or past its gate). */
  reactionsReached: number;
}

interface World {
  readonly context: Context.Context<never>;
  readonly provider: ScriptedProvider;
  readonly probe: Probe;
}

interface Sys {
  readonly harness: Harness<World>;
  readonly timers: VirtualTimers;
  readonly restoreTimers: () => void;
  stopPressed: boolean;
  workers: number;
  /** Queue mode only: the bound and the messages that reached the thread during the check. */
  readonly queue?: QueueSys;
}

const providerTurnEvent = (
  turn: ScriptedTurn,
  status: OrchestrationV2ProviderTurn["status"],
): ProviderEvent => ({
  type: "provider_turn.updated",
  driver,
  providerTurn: {
    ...turn.snapshot,
    status,
    completedAt: status === "running" ? null : turn.snapshot.startedAt,
  },
});

const terminalEvent = (turn: ScriptedTurn, status: "completed" | "interrupted"): ProviderEvent => ({
  type: "turn.terminal",
  driver,
  providerThreadId: turn.snapshot.providerThreadId,
  providerTurnId: turn.snapshot.id,
  runOrdinal: turn.runOrdinal,
  status,
  failure: null,
  threadDisposition: "reusable",
});

/** The gate where the adapter's openSession waits while it starts the provider process. */
const OPEN_SESSION = "provider: open the session";

/** The gate where the adapter's startTurn writes turn/start; once released, the provider runs the turn. */
const RECEIVE_TURN_START = "provider: receive turn/start";

const makeAdapter = (
  provider: ScriptedProvider,
  gates: Gates["Service"],
  cwd: string,
): ProviderAdapter.ProviderAdapterV2["Service"] => ({
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
  // Like Codex's openSession, which starts the app-server process before it returns. A Stop that lands meanwhile
  // interrupts it, and ProviderSessionManager.open closes what the open started.
  openSession: (input) =>
    Effect.gen(function* () {
      yield* gates.gate(OPEN_SESSION);
      const now = yield* DateTime.now;
      const delivered = yield* Queue.unbounded<ProviderEvent>();
      provider.delivered = delivered;
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
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
        events: Stream.fromQueue(delivered),
        ensureThread: ({ threadId }) =>
          Effect.succeed({
            id: ProviderThreadId.make(`provider-thread:codex:${threadId}`),
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
          } satisfies OrchestrationV2ProviderThread),
        resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
        // Like Codex's turn/start: the request reaches the provider, then the adapter waits for its answer.
        // Interrupting the wait does not take the request back, and like Codex's startNativeTurn the
        // interrupted adapter drops a turn it has not reported yet: the provider runs it unseen.
        startTurn: (turn) =>
          Effect.gen(function* () {
            yield* gates.gate(RECEIVE_TURN_START);
            // A provider that refuses the turn (a bad model, an expired login): the start fails and starts nothing.
            if (provider.refuses.has(turn.message.messageId)) {
              return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                driver,
                threadId: turn.threadId,
                providerThreadId: turn.providerThread.id,
                runId: turn.runId,
                cause: "the provider refused turn/start",
              });
            }
            const scripted: ScriptedTurn = {
              id: `turn ${provider.turns.length + 1}`,
              status: "running",
              endedBy: null,
              interruptCalls: 0,
              forgotten: false,
              runOrdinal: turn.runOrdinal,
              snapshot: {
                id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                providerThreadId: turn.providerThread.id,
                nodeId: turn.rootNodeId,
                runAttemptId: turn.attemptId,
                nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
                ordinal: turn.providerTurnOrdinal,
                status: "running",
                startedAt: yield* DateTime.now,
                completedAt: null,
              },
            };
            provider.turns.push(scripted);
            const running = {
              label: `${scripted.id} running`,
              event: providerTurnEvent(scripted, "running"),
            };
            if (provider.reportAtOnce && provider.delivered !== undefined) {
              yield* Queue.offer(provider.delivered, running.event);
              return;
            }
            provider.unreported.push(running);
            yield* gates.gate("provider: answer turn/start").pipe(
              Effect.onInterrupt(() =>
                Effect.sync(() => {
                  const index = provider.unreported.indexOf(running);
                  if (index < 0) return;
                  provider.unreported.splice(index, 1);
                  scripted.forgotten = true;
                }),
              ),
            );
          }),
        steerTurn: () => Effect.die("unused"),
        interruptTurn: (interrupt) =>
          Effect.gen(function* () {
            const turn = provider.turns.find(
              (candidate) => candidate.snapshot.id === interrupt.providerTurnId,
            );
            if (turn === undefined) return;
            turn.interruptCalls++;
            if (turn.status !== "running") return;
            turn.status = "ending";
            turn.endedBy = "interrupt";
            const reports = [
              providerTurnEvent(turn, "interrupted"),
              terminalEvent(turn, "interrupted"),
            ];
            if (
              (provider.reportInterruptsAtOnce || provider.reportAtOnce) &&
              provider.delivered !== undefined
            ) {
              turn.status = "ended";
              yield* Queue.offerAll(provider.delivered, reports);
              return;
            }
            provider.unreported.push(
              { label: `${turn.id} interrupted`, event: reports[0]! },
              { label: `${turn.id} terminal interrupted`, event: reports[1]! },
            );
          }),
        respondToRuntimeRequest: () => Effect.die("unused"),
        readThreadSnapshot: () => Effect.die("unused"),
        rollbackThread: () => Effect.die("unused"),
        forkThread: () => Effect.die("unused"),
      };
    }),
});

type SinkInput = Parameters<EventSink.EventSinkV2["Service"]["writeWithEffects"]>[0];

/** Records each effect a committed write enqueued and, for a new checkpoint.capture, the settled run event beside it. */
const recordCommitted = (probe: Probe, input: Pick<SinkInput, "events" | "effects">) => {
  for (const effect of input.effects) {
    probe.committedEffectIds.add(effect.id);
    if (
      effect.request.type !== "checkpoint.capture" ||
      probe.checkpointTerminalEventIds.has(effect.id)
    )
      continue;
    const runId = effect.request.runId;
    const terminal = input.events.find(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === runId &&
        SETTLED.has(event.payload.status),
    );
    probe.checkpointTerminalEventIds.set(effect.id, terminal?.id ?? null);
  }
};

/** The gate where the start's starting-to-running write waits for the writer, after every ownership read saw "starting". */
const START_RUNNING_WRITE = "start: write the run running (read starting)";

/** The start's starting-to-running write: the only write in this bound with a run.updated to running. */
const isRunningWrite = (events: SinkInput["events"]) =>
  events.some((event) => event.type === "run.updated" && event.payload.status === "running");

/** Which write a compare-and-set guarded, for the probe and the coverage assertions. */
const casWrite = (events: SinkInput["events"]) =>
  isRunningWrite(events)
    ? "running write"
    : events.some((event) => event.type === "run.updated" && SETTLED.has(event.payload.status))
      ? "terminal write"
      : "other write";

/**
 * The runtime's EventSink with Stop parked between its plan and its commit, the start's starting-to-running write parked
 * before it reaches the writer, and every compare-and-set recorded.
 *
 * The running write's gate is the gap between the start's last ownership read (`isCurrentAttemptInStatus("starting")`,
 * served by the reader worker in production) and its compare-and-set, so a Stop can commit there. It is
 * uninterruptible, with the write: `commitThenPublish` enters the writer uninterruptibly, and Stop's cancellation reaches
 * the start only through `EffectWorker.runOnce`'s `raceFirst` after Stop has committed, so a start already waiting on
 * the writer runs its compare-and-set first. The gate is on every write method, so a mutation that swaps the
 * compare-and-set for a plain write still waits there.
 *
 * In queue mode (`reaction`), the Orchestrator's subscription to run updates (the only `stream` of `run.updated` with no
 * thread in this bound) parks each run end it reacts to before `handleRunUpdate` takes it: the end-of-run reaction is a
 * step of its own, and a message can reach the thread between a run's end and that reaction.
 */
const layerEventSinkProbed = (
  gates: Gates["Service"],
  probe: Probe,
  reaction?: (stored: OrchestrationV2StoredEvent) => string | undefined,
) =>
  Layer.effect(
    EventSink.EventSinkV2,
    Effect.gen(function* () {
      const real = yield* EventSink.EventSinkV2;
      const waitForWriter = <A, E, R>(
        events: SinkInput["events"],
        write: Effect.Effect<A, E, R>,
      ) =>
        isRunningWrite(events)
          ? Effect.uninterruptible(Effect.andThen(gates.gate(START_RUNNING_WRITE), write))
          : write;
      return EventSink.EventSinkV2.of({
        ...real,
        stream: (input) => {
          const events = real.stream(input);
          if (
            reaction === undefined ||
            input?.eventType !== "run.updated" ||
            input.threadId !== undefined
          )
            return events;
          return events.pipe(
            Stream.tap((stored) => {
              const name = reaction(stored);
              if (name === undefined) return Effect.void;
              probe.reactionsReached++;
              return gates.gate(name);
            }),
          );
        },
        commitCommand: (input) =>
          Effect.gen(function* () {
            const stop = (yield* Actor) === "stop";
            if (stop) yield* gates.gate(stopCommit(input));
            const result = yield* real.commitCommand(input);
            if (stop) probe.stopCommitted = result.committed;
            if (stop && result.committed) probe.stopCommitSequence = result.receipt.resultSequence;
            if (result.committed) recordCommitted(probe, input);
            return result;
          }),
        commitCommandIfRunCurrent: (input) =>
          Effect.gen(function* () {
            const stop = (yield* Actor) === "stop";
            if (stop) yield* gates.gate(stopCommit(input));
            const result = yield* real.commitCommandIfRunCurrent(input);
            const committed = Option.isSome(result) && result.value.committed;
            if (stop) probe.stopCommitted = committed;
            if (stop && committed) probe.stopCommitSequence = result.value.receipt.resultSequence;
            if (committed) recordCommitted(probe, input);
            return result;
          }),
        write: (input) => waitForWriter(input.events, real.write(input)),
        writeWithEffects: (input) =>
          waitForWriter(
            input.events,
            real
              .writeWithEffects(input)
              .pipe(Effect.tap(() => Effect.sync(() => recordCommitted(probe, input)))),
          ),
        writeIfRunCurrent: (input) =>
          waitForWriter(
            input.events,
            real.writeIfRunCurrent(input).pipe(
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (result.committed) {
                    recordCommitted(probe, { events: input.events, effects: input.effects ?? [] });
                  } else {
                    probe.failedCas.push(casWrite(input.events));
                    for (const event of input.events) probe.failedCasEventIds.add(event.id);
                  }
                }),
              ),
            ),
          ),
      });
    }),
  );

/**
 * The runtime's ProjectionStore with the run's ownership read before its terminal write parked after it returns.
 * Production serves these reads from a reader worker, so other writers commit between the read and the write; the
 * caller is found by its own name (RunExecutionService's shouldFinalizeRun control from ProviderTurnStartService).
 */
const layerProjectionStoreProbed = (gates: Gates["Service"]) =>
  Layer.effect(
    ProjectionStore.ProjectionStoreV2,
    Effect.gen(function* () {
      const real = yield* ProjectionStore.ProjectionStoreV2;
      return {
        ...real,
        getRuntimeRecoveryProjection: (threadId) => {
          const read = real.getRuntimeRecoveryProjection(threadId);
          return new Error().stack?.includes("shouldFinalizeRun") === true
            ? Effect.tap(read, (projection) =>
                gates.gate(ownershipRead(projection.runs[0]?.status ?? "no run")),
              )
            : read;
        },
      } satisfies ProjectionStore.ProjectionStoreV2["Service"];
    }),
  );

/** The gate names carry what the parked fiber already read, so two schedules that differ only there stay apart. */
const ownershipRead = (runStatus: string) =>
  `run: read ownership before the terminal write (read ${runStatus})`;

const stopCommit = (
  input: Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0] &
    Partial<
      Pick<
        Parameters<EventSink.EventSinkV2["Service"]["commitCommandIfRunCurrent"]>[0],
        "ifRunCurrent"
      >
    >,
) => {
  const expected = input.ifRunCurrent;
  const plan = [
    ...input.events.flatMap((event) =>
      event.type === "run.updated" ? [`run ${event.payload.status}`] : [],
    ),
    ...input.effects.map((effect) => `enqueue ${effect.request.type}`),
    ...(input.cancelUnsettledEffects?.effectTypes ?? []).map((type) => `cancel ${type}`),
    ...(expected === undefined
      ? []
      : [
          `if still ${expected.expectedStatus} with ${expected.providerTurnIds.length} provider turns`,
        ]),
  ];
  return `${STOP_COMMIT} (${plan.length === 0 ? "nothing" : plan.join(", ")})`;
};
const STOP_COMMIT = "stop: commit";

/** The orchestration services runtimeLayer.ts wires, composed as testkit/ProviderReplayHarness.ts layerWithRegistry does. */
// No provider instance here refreshes usage: the ingestor's usage-limit refresh finds nothing to run.
const layerNoProviderInstances = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: () => Effect.succeed(undefined),
  listInstances: Effect.succeed([]),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  subscribeChanges: Effect.never,
});

const layerSystem = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  serverConfig: ServerConfig.ServerConfig["Service"],
  gates: Gates["Service"],
  probe: Probe,
  reaction?: (stored: OrchestrationV2StoredEvent) => string | undefined,
) => {
  const layerServerConfig = Layer.succeed(ServerConfig.ServerConfig, serverConfig);
  const layerRuntime = RuntimePolicy.layer;
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerProvidedRegistry = ProviderAdapterRegistry.layerSingle(adapter).pipe(
    Layer.provide(McpProviderSessions.layer),
  );
  const layerServerSettings = ServerSettings.layerTest({ responseStreamingMode: "turn" }).pipe(
    Layer.orDie,
  );
  const layerStores = Layer.mergeAll(
    EventStore.layer,
    layerProjectionStoreProbed(gates).pipe(Layer.provide(ProjectionStoreWithV1.layer)),
    ProjectStore.layer,
    CommandReceiptStore.layer,
    EffectOutbox.layer,
    TurnItemPositionStore.layer,
  ).pipe(Layer.provide(Layer.merge(layerDatabase, layerServerConfig)));
  const layerEventSinkProvided = layerEventSinkProbed(gates, probe, reaction).pipe(
    Layer.provide(
      EventSink.layerFromStores.pipe(Layer.provide(Layer.mergeAll(layerStores, layerDatabase))),
    ),
  );
  const layerCommandReceiptStoreProvided = CommandReceiptStore.layer.pipe(
    Layer.provide(layerDatabase),
  );
  const layerProviderEventIngestorProvided = ProviderEventIngestor.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerStores,
        layerEventSinkProvided,
        IdAllocator.layer,
        ThreadCommandExecutor.layer,
        GitVcsDriver.layer.pipe(
          Layer.provide(layerServerConfig),
          Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
        ),
      ),
    ),
  );
  // No git: baselines and captures are skipped, so nothing waits on a child process the checker cannot schedule.
  const layerCheckpointStore = Layer.mock(CheckpointStore.CheckpointStore)({
    isGitRepository: () => Effect.succeed(false),
  });
  const layerCheckpointServiceProvided = CheckpointService.layer.pipe(
    Layer.provide(Layer.mergeAll(layerCheckpointStore, IdAllocator.layer)),
  );
  const layerContextHandoffServiceProvided = ContextHandoffService.layer.pipe(
    Layer.provide(IdAllocator.layer),
  );
  const layerPersistence = Layer.mergeAll(
    layerStores,
    layerEventSinkProvided,
    layerCommandReceiptStoreProvided,
    IdAllocator.layer,
    layerProviderEventIngestorProvided,
  );
  const layerCommandOutputHubProvided = CommandOutputHub.layer.pipe(
    Layer.provide(Layer.merge(layerEventSinkProvided, layerStores)),
  );
  const layerProviderSessionManagerProvided = ProviderSessionManager.layerWithOptions({
    configureMcp: false,
  }).pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCommandOutputHubProvided,
        layerProvidedRegistry,
        layerEventSinkProvided,
        IdAllocator.layer,
        McpProviderSessions.layer,
        McpSessionRegistryTestkit.layer,
        layerProviderEventIngestorProvided,
        layerStores,
      ),
    ),
  );
  const layerProviderSwitchServiceProvided = ProviderSwitchService.layer.pipe(
    Layer.provide(layerProvidedRegistry),
  );
  const layerRunExecutionServiceProvided = RunExecutionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        McpAppModelContext.layerEmpty,
        layerCheckpointServiceProvided,
        layerEventSinkProvided,
        IdAllocator.layer,
        layerProviderEventIngestorProvided,
        layerServerSettings,
        layerStores,
      ),
    ),
  );
  const layerProviderTurnStartServiceProvided = ProviderTurnStartService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerContextHandoffServiceProvided,
        layerEventSinkProvided,
        IdAllocator.layer,
        layerStores,
        layerProviderSessionManagerProvided,
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        layerRunExecutionServiceProvided,
        layerRuntime,
        layerServerConfig,
        layerServerSettings,
      ),
    ),
  );
  const layerProviderTurnControlServiceProvided = ProviderTurnControlService.layer.pipe(
    Layer.provide(Layer.merge(layerStores, layerProviderSessionManagerProvided)),
  );
  const layerRuntimeRequestServiceProvided = RuntimeRequestService.layer.pipe(
    Layer.provide(Layer.merge(layerStores, layerProviderSessionManagerProvided)),
  );
  const layerCheckpointRollbackServiceProvided = CheckpointRollbackService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCheckpointServiceProvided,
        layerEventSinkProvided,
        IdAllocator.layer,
        layerStores,
        layerProviderSessionManagerProvided,
        ThreadCommandExecutor.layer,
        layerRuntime,
        layerServerConfig,
        layerServerSettings,
      ),
    ),
  );
  const layerCheckpointCaptureServiceProvided = CheckpointCaptureService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCheckpointServiceProvided,
        layerEventSinkProvided,
        IdAllocator.layer,
        layerStores,
      ),
    ),
  );
  const layerRunFinalizationServiceProvided = RunFinalizationService.layer.pipe(
    Layer.provide(Layer.merge(layerCheckpointCaptureServiceProvided, layerStores)),
  );
  const layerThreadTitleRegenerationTest = Layer.succeed(
    ThreadTitleRegenerationService.ThreadTitleRegenerationService,
    ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
      execute: () => Effect.void,
    }),
  );
  const layerOrchestratorProvided = Orchestrator.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerCheckpointServiceProvided,
        CommandPolicy.layer,
        layerContextHandoffServiceProvided,
        layerPersistence,
        layerProvidedRegistry,
        layerRuntime,
        layerProviderSessionManagerProvided,
        layerProviderSwitchServiceProvided,
        layerRunExecutionServiceProvided,
        layerServerSettings,
        ThreadForkService.layer,
      ),
    ),
  );
  const layerThreadManagementProvided = Layer.unwrap(
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      return Layer.mock(ThreadManagementService.ThreadManagementService)({
        dispatch: orchestrator.dispatch,
        getThreadRecords: orchestrator.getThreadRecords,
        getThreadProjection: orchestrator.getThreadProjection,
        recoverDelegatedTask: orchestrator.recoverDelegatedTask,
        delegatedTaskResultPending: orchestrator.delegatedTaskResultPending,
        stopDelegatedTasks: ThreadManagementService.makeStopDelegatedTasks({
          getThreadRecords: orchestrator.getThreadRecords,
          dispatch: orchestrator.dispatch,
        }),
      });
    }),
  ).pipe(Layer.provide(layerOrchestratorProvided));
  const layerEffectExecutorProvided = EffectWorker.layerExecutor.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRunFinalizationServiceProvided,
        layerCheckpointRollbackServiceProvided,
        layerProviderSessionManagerProvided,
        layerProviderTurnControlServiceProvided,
        layerProviderTurnStartServiceProvided,
        layerRuntimeRequestServiceProvided,
        layerThreadTitleRegenerationTest,
        layerServerSettings,
        layerThreadManagementProvided,
      ),
    ),
  );
  const layerEffectWorkerProvided = EffectWorker.layer.pipe(
    Layer.provide(Layer.merge(layerStores, layerEffectExecutorProvided)),
  );
  // The EventSink is the probed one every service above writes through; queue mode seeds the thread with it.
  return Layer.mergeAll(
    layerOrchestratorProvided,
    layerEffectWorkerProvided,
    layerDatabase,
    layerEventSinkProvided,
  ).pipe(
    Layer.provide(ProviderTurnStartServiceTestkit.layer),
    Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
    Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "None")),
  );
};

const serverConfig = Effect.runPromise(
  makeReplayServerConfig("run-ownership-and-stop").pipe(
    Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
);

const inWorld = <A, E>(sys: Sys, effect: Effect.Effect<A, E, any>) =>
  Effect.provide(effect, sys.harness.value.context) as Effect.Effect<A, E, never>;

const runIn = <A, E>(sys: Sys, effect: Effect.Effect<A, E, any>) =>
  sys.harness.run(inWorld(sys, effect));

const query = <Row extends object>(sys: Sys, statement: string) =>
  runIn(
    sys,
    Effect.flatMap(SqlClient.SqlClient, (sql) => sql.unsafe<Row>(statement)),
  );

/**
 * Every write that moves the projected thread's updated_at back, or moves active_provider_thread_id off a provider thread
 * it had, leaves a row: SQLite triggers on the real projection table, so they see each statement, not one sample per step.
 * With one provider thread and no switch, any move off the one it had is a move backward.
 */
const recordThreadRegressions = (sys: Sys) =>
  runIn(
    sys,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql.unsafe("CREATE TABLE modelcheck_thread_regressions (what TEXT NOT NULL)");
      yield* sql.unsafe(`
        CREATE TRIGGER modelcheck_thread_updated_at_back
        AFTER UPDATE OF updated_at ON orchestration_v2_projection_threads
        WHEN NEW.updated_at < OLD.updated_at
        BEGIN INSERT INTO modelcheck_thread_regressions VALUES ('updatedAt'); END
      `);
      yield* sql.unsafe(`
        CREATE TRIGGER modelcheck_thread_active_provider_thread_back
        AFTER UPDATE OF active_provider_thread_id ON orchestration_v2_projection_threads
        WHEN OLD.active_provider_thread_id IS NOT NULL
          AND NEW.active_provider_thread_id IS NOT OLD.active_provider_thread_id
        BEGIN INSERT INTO modelcheck_thread_regressions VALUES ('activeProviderThreadId'); END
      `);
    }),
  );

/** Quiet: every fiber is parked or done and no zero-delay timer is queued. Delayed timers wait for the clock. */
const settle = async (sys: Sys) => {
  for (let round = 0; round < 3; round++) {
    await sys.harness.settle();
    await sys.timers.settle();
  }
};

const dispatch = (command: Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) => orchestrator.dispatch(command));

const makeProvider = (): ScriptedProvider => ({
  turns: [],
  unreported: [],
  delivered: undefined,
  reportInterruptsAtOnce: false,
  reportAtOnce: false,
  refuses: new Set(),
});

const makeProbe = (): Probe => ({
  stopCommitted: false,
  failedCas: [],
  failedCasEventIds: new Set(),
  committedEffectIds: new Set(),
  checkpointTerminalEventIds: new Map(),
  stopCommitSequence: undefined,
  reactionsReached: 0,
});

const make = async (): Promise<Sys> => {
  const config = await serverConfig;
  const timers = new VirtualTimers();
  const restoreTimers = timers.install();
  try {
    const harness = await openHarness(
      Effect.gen(function* () {
        const gates = yield* Gates;
        const provider = makeProvider();
        const probe = makeProbe();
        const context = yield* Layer.build(
          layerSystem(makeAdapter(provider, gates, config.cwd), config, gates, probe).pipe(
            Layer.provide(layerNoProviderInstances),
          ),
        );
        return { context, provider, probe } satisfies World;
      }),
    );
    const sys: Sys = { harness, timers, restoreTimers, stopPressed: false, workers: 0 };
    await recordThreadRegressions(sys);
    await runIn(
      sys,
      Effect.gen(function* () {
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:stop"),
          title: "Stop",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send"),
          threadId,
          messageId: MessageId.make("message:send"),
          text: "Edit the files",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
      }),
    );
    await settle(sys);
    return sys;
  } catch (error) {
    restoreTimers();
    throw error;
  }
};

const dispose = async (sys: Sys) => {
  try {
    // Closing interrupts every fiber, and a start parked at its uninterruptible write gate would hold the close forever.
    while (sys.harness.gates.release(START_RUNNING_WRITE)) await settle(sys);
    await sys.harness.close();
  } finally {
    sys.restoreTimers();
  }
};

const PRESS_STOP = "user: press Stop";
const RUN_EFFECT = "worker: run the next effect";
const PROVIDER_FINISHES = "provider: finish the turn on its own";
const FIRE_TIMER = "clock: fire the next timer";

const SETTLED = new Set(["waiting", "completed", "interrupted", "failed", "cancelled"]);
const outcome = (status: string) =>
  status === "waiting" || status === "completed" ? "completed" : status;

interface Obs {
  readonly run: string;
  readonly attempt: string;
  readonly providerTurns: ReadonlyArray<string>;
  readonly signals: ReadonlyArray<string>;
  readonly effects: ReadonlyArray<string>;
  /** The run's status after each run.updated, in commit order, repeats collapsed. */
  readonly runHistory: ReadonlyArray<string>;
  readonly attemptHistory: ReadonlyArray<string>;
  readonly provider: ReadonlyArray<string>;
  readonly unreported: ReadonlyArray<string>;
  readonly stopPressed: boolean;
  readonly stopCommitted: boolean;
  readonly failedCasLeftTrace: boolean;
  /** Each compare-and-set that did not commit, by the write it guarded. */
  readonly failedCas: ReadonlyArray<string>;
  /** A checkpoint.capture in the outbox that no committed settled run.updated was written beside. */
  readonly checkpointWithoutTerminal: boolean;
  /** Which thread fields some write has moved backward (updatedAt, activeProviderThreadId). */
  readonly threadRegressions: ReadonlyArray<string>;
  readonly parked: ReadonlyArray<string>;
  readonly stop: string;
  readonly workersRunning: number;
  readonly timerPending: boolean;
}

const collapse = (values: ReadonlyArray<string>) =>
  values.filter((value, index) => index === 0 || values[index - 1] !== value);

const observe = async (sys: Sys): Promise<Obs> => {
  const { provider, probe } = sys.harness.value;
  const [run] = await query<{ status: string }>(
    sys,
    "SELECT status FROM orchestration_v2_projection_runs",
  );
  const [attempt] = await query<{ status: string }>(
    sys,
    "SELECT status FROM orchestration_v2_projection_run_attempts",
  );
  const providerTurns = await query<{ status: string }>(
    sys,
    "SELECT status FROM orchestration_v2_projection_provider_turns ORDER BY ordinal",
  );
  const signals = await query<{ type: string; status: string }>(
    sys,
    "SELECT type, status FROM orchestration_v2_projection_turn_items WHERE type IN ('run_interrupt_request', 'run_interrupt_result') ORDER BY type",
  );
  const effects = await query<{ effect_type: string; status: string; attempt_count: number }>(
    sys,
    "SELECT effect_type, status, attempt_count FROM orchestration_v2_effect_outbox ORDER BY rowid",
  );
  const log = await query<{ event_type: string; payload_json: string }>(
    sys,
    "SELECT event_type, payload_json FROM orchestration_events WHERE aggregate_kind = 'thread' AND event_type IN ('run.created', 'run.updated', 'run-attempt.created', 'run-attempt.updated') ORDER BY sequence",
  );
  const loggedEventIds = new Set(
    (await query<{ event_id: string }>(sys, "SELECT event_id FROM orchestration_events")).map(
      (row) => row.event_id,
    ),
  );
  const outbox = await query<{ effect_id: string; effect_type: string }>(
    sys,
    "SELECT effect_id, effect_type FROM orchestration_v2_effect_outbox",
  );
  const outboxIds = outbox.map((row) => row.effect_id);
  const regressions = await query<{ what: string }>(
    sys,
    "SELECT DISTINCT what FROM modelcheck_thread_regressions ORDER BY what",
  );
  const statuses = (prefix: string) =>
    collapse(
      log
        .filter((row) => row.event_type.startsWith(prefix))
        .map((row) => (JSON.parse(row.payload_json) as { status: string }).status),
    );
  const fibers = sys.harness.fibers();
  return {
    run: run?.status ?? "none",
    attempt: attempt?.status ?? "none",
    providerTurns: providerTurns.map((row) => row.status),
    signals: signals.map((row) => `${row.type}:${row.status}`),
    effects: effects.map(
      (row) =>
        `${row.effect_type}:${row.status}${row.status === "pending" && row.attempt_count > 0 ? ` (retry after attempt ${row.attempt_count})` : ""}`,
    ),
    runHistory: statuses("run."),
    attemptHistory: statuses("run-attempt."),
    provider: provider.turns.map(
      (turn) =>
        `${turn.id}:${turn.status}${turn.endedBy === null ? "" : ` by ${turn.endedBy}`}${turn.forgotten ? " (never reported)" : ""}, interruptTurn x${turn.interruptCalls}`,
    ),
    unreported: provider.unreported.map((entry) => entry.label),
    stopPressed: sys.stopPressed,
    stopCommitted: probe.stopCommitted,
    failedCasLeftTrace:
      [...probe.failedCasEventIds].some((id) => loggedEventIds.has(id)) ||
      outboxIds.some((id) => !probe.committedEffectIds.has(id)),
    failedCas: [...probe.failedCas],
    checkpointWithoutTerminal: outbox.some((row) => {
      if (row.effect_type !== "checkpoint.capture") return false;
      const terminal = probe.checkpointTerminalEventIds.get(row.effect_id);
      return terminal === undefined || terminal === null || !loggedEventIds.has(terminal);
    }),
    threadRegressions: regressions.map((row) => row.what),
    parked: sys.harness.gates.parked(),
    stop: fibers.stop ?? "not pressed",
    workersRunning: Object.entries(fibers).filter(
      ([name, status]) => name.startsWith("worker") && status === "running",
    ).length,
    timerPending: sys.timers.nextAt() !== undefined,
  };
};

const forkWorker = (sys: Sys) => {
  sys.workers++;
  sys.harness.fork(
    `worker ${sys.workers}`,
    inWorld(
      sys,
      Effect.flatMap(EffectWorker.OrchestrationEffectWorkerV2, (worker) => worker.runOnce).pipe(
        Effect.provideService(Actor, "worker"),
      ),
    ),
  );
};

const pressStop = (sys: Sys) => {
  sys.stopPressed = true;
  sys.harness.fork(
    "stop",
    inWorld(
      sys,
      dispatch({ type: "thread.stop", commandId: CommandId.make("stop"), threadId }).pipe(
        Effect.provideService(Actor, "stop"),
      ),
    ),
  );
};

const reportNext = async (sys: Sys) => {
  const { provider } = sys.harness.value;
  const next = provider.unreported.shift();
  if (next === undefined || provider.delivered === undefined)
    throw new Error("the provider has nothing to report");
  if (next.event.type === "turn.terminal") {
    const id = next.event.providerTurnId;
    const turn = provider.turns.find((candidate) => candidate.snapshot.id === id);
    if (turn !== undefined) turn.status = "ended";
  }
  await Effect.runPromise(Queue.offer(provider.delivered, next.event));
};

const finishOnItsOwn = async (sys: Sys) => {
  const { provider } = sys.harness.value;
  const turn = provider.turns.find((candidate) => candidate.status === "running")!;
  turn.endedBy = "provider";
  if (turn.forgotten) {
    turn.status = "ended";
    return;
  }
  turn.status = "ending";
  const reports = [
    { label: `${turn.id} completed`, event: providerTurnEvent(turn, "completed") },
    { label: `${turn.id} terminal completed`, event: terminalEvent(turn, "completed") },
  ];
  if (provider.reportAtOnce && provider.delivered !== undefined) {
    turn.status = "ended";
    await Effect.runPromise(
      Queue.offerAll(
        provider.delivered,
        reports.map((report) => report.event),
      ),
    );
    return;
  }
  provider.unreported.push(...reports);
};

/** The per-thread lane runs one effect at a time; the next pending one is claimable once none is running. */
const effectClaimable = (o: Pick<Obs, "workersRunning" | "effects">) =>
  o.workersRunning === 0 &&
  o.effects.every((effect) => !effect.endsWith(":running")) &&
  o.effects.some((effect) => effect.endsWith(":pending"));

/** Each step comes a millisecond after the last, so timestamps differ as in production; no sleeper is due that soon. */
const step = (name: string, act: (sys: Sys) => void | Promise<void>): Action<Sys> => ({
  name,
  run: async (sys) => {
    sys.harness.clock.advanceTo(sys.harness.clock.currentTimeMillisUnsafe() + 1);
    await act(sys);
    await settle(sys);
  },
});

type StopWindow =
  | "never"
  | "anytime"
  | "after the provider turn is projected"
  | "committed before turn/start reaches the provider";

/** Whether Stop may be pressed now: a window narrows the schedules to the ones a check is about. */
const stopEnabled = (o: Obs, stop: StopWindow) => {
  if (o.stopPressed) return false;
  switch (stop) {
    case "never":
      return false;
    case "anytime":
      return true;
    case "after the provider turn is projected":
      return o.providerTurns.length > 0;
    case "committed before turn/start reaches the provider":
      return o.provider.length === 0;
  }
};

/**
 * In the "committed before turn/start reaches the provider" window, turn/start waits while Stop is in flight and has not
 * committed, so Stop's commit always lands before the request does. Every other gate stays free.
 */
const gateEnabled = (o: Obs, stop: StopWindow, name: string) =>
  !(
    stop === "committed before turn/start reaches the provider" &&
    name === RECEIVE_TURN_START &&
    o.stopPressed &&
    !o.stopCommitted &&
    o.stop === "running"
  );

const enabled = (o: Obs, stop: StopWindow) => [
  ...o.parked
    .filter((name) => gateEnabled(o, stop, name))
    .map((name) => step(name, (s) => void s.harness.gates.release(name))),
  ...(o.unreported[0] === undefined
    ? []
    : [step(`provider: report ${o.unreported[0]}`, reportNext)]),
  ...(o.provider.some((turn) => turn.includes(":running"))
    ? [step(PROVIDER_FINISHES, finishOnItsOwn)]
    : []),
  ...(effectClaimable(o) ? [step(RUN_EFFECT, forkWorker)] : []),
  ...(stopEnabled(o, stop) ? [step(PRESS_STOP, pressStop)] : []),
  ...(o.timerPending ? [step(FIRE_TIMER, (s) => s.timers.advanceToNext().then(() => {}))] : []),
];

const STOPPED = new Set(["interrupted", "failed", "cancelled"]);
const COMPLETED = new Set(["waiting", "completed"]);

/** After the first status in `from`, every later settled status stays the same outcome. */
const keepsOutcome = (history: ReadonlyArray<string>, from: ReadonlySet<string>) => {
  const first = history.findIndex((status) => from.has(status));
  return (
    first < 0 ||
    history
      .slice(first)
      .every((status) => !SETTLED.has(status) || outcome(status) === outcome(history[first]!))
  );
};

const neverRunsAgain = (history: ReadonlyArray<string>) => {
  const first = history.findIndex((status) => SETTLED.has(status));
  return first < 0 || history.slice(first).every((status) => SETTLED.has(status));
};

const invariants = {
  "a settled run never runs again": (o: Obs) => neverRunsAgain(o.runHistory),
  "a stopped run never completes afterwards": (o: Obs) => keepsOutcome(o.runHistory, STOPPED),
  "a completed run is never stopped afterwards": (o: Obs) => keepsOutcome(o.runHistory, COMPLETED),
  "a settled attempt never runs again": (o: Obs) => neverRunsAgain(o.attemptHistory),
  "a stopped attempt never completes afterwards": (o: Obs) =>
    keepsOutcome(o.attemptHistory, STOPPED),
  "a completed attempt is never stopped afterwards": (o: Obs) =>
    keepsOutcome(o.attemptHistory, COMPLETED),
  "a failed compare-and-set commits nothing": (o: Obs) => !o.failedCasLeftTrace,
  "the provider is told to interrupt a turn at most once": (o: Obs) =>
    o.provider.every((turn) => /interruptTurn x[01]$/.test(turn)),
  "a checkpoint is enqueued only beside a committed terminal": (o: Obs) =>
    !o.checkpointWithoutTerminal,
  "the thread's updatedAt never moves backward": (o: Obs) =>
    !o.threadRegressions.includes("updatedAt"),
  "the thread's active provider thread never moves backward": (o: Obs) =>
    !o.threadRegressions.includes("activeProviderThreadId"),
};

/**
 * One fair round for liveness: every parked fiber released, every report delivered, the lane run once, the next timer
 * fired. The provider never finishes a turn on its own here, so only the runtime can end it.
 */
const drain = async (sys: Sys): Promise<ReadonlyArray<string>> => {
  const did: Array<string> = [];
  for (const name of sys.harness.gates.releaseAll()) did.push(name);
  await settle(sys);
  while (sys.harness.value.provider.unreported[0] !== undefined) {
    did.push(`provider: report ${sys.harness.value.provider.unreported[0].label}`);
    await reportNext(sys);
    await settle(sys);
  }
  if (effectClaimable(await observe(sys))) {
    did.push(RUN_EFFECT);
    forkWorker(sys);
    await settle(sys);
  }
  if (await sys.timers.advanceToNext()) {
    did.push(FIRE_TIMER);
    await settle(sys);
  }
  return did;
};

/**
 * Once Stop is pressed, no turn the provider was asked to start is still running. Pressed, not committed: a Stop that
 * plans again or writes nothing must still reach the provider.
 */
const stopReachesProvider = (o: Obs) =>
  !o.stopPressed || o.provider.every((turn) => !turn.includes(":running"));

const spec = (options: {
  readonly stop: StopWindow;
  readonly liveness?: boolean;
  readonly without?: ReadonlyArray<string>;
}): AsyncSpec<Sys, Obs> => ({
  make,
  dispose,
  observe,
  actions: (_sys, o) => enabled(o, options.stop),
  invariants: Object.fromEntries(
    Object.entries(invariants).filter(([name]) => !(options.without ?? []).includes(name)),
  ),
  ...(options.liveness === true
    ? { eventually: { "Stop reaches the provider": stopReachesProvider }, drain, drainRounds: 8 }
    : {}),
});

const show = (o: Obs) =>
  [
    `run ${o.run} (history ${o.runHistory.join(" > ")})`,
    `attempt ${o.attempt}`,
    `provider turns projected [${o.providerTurns.join(", ")}]`,
    `adapter [${o.provider.join("; ")}]`,
    o.unreported.length === 0 ? "" : `unreported [${o.unreported.join(", ")}]`,
    `effects [${o.effects.join(", ")}]`,
    o.signals.length === 0 ? "" : `items [${o.signals.join(", ")}]`,
    o.failedCas.length === 0 ? "" : `failed compare-and-set [${o.failedCas.join(", ")}]`,
    o.threadRegressions.length === 0 ? "" : `thread moved back [${o.threadRegressions.join(", ")}]`,
    `stop ${o.stopCommitted ? "committed" : o.stop}`,
    o.parked.length === 0 ? "" : `parked [${o.parked.join(", ")}]`,
  ]
    .filter((part) => part !== "")
    .join(" | ");

const report = (label: string, verdict: Verdict<Obs>, seconds: number) => {
  if (verdict.ok) {
    console.log(
      `${label}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}, ${seconds.toFixed(1)} s`,
    );
  } else {
    console.log(
      `${label}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states, ${seconds.toFixed(1)} s)\n${formatTrace(verdict.trace, show)}`,
    );
  }
};

const timed = async (label: string, run: () => Promise<Verdict<Obs>>) => {
  const started = performance.now();
  const verdict = await run();
  report(label, verdict, (performance.now() - started) / 1000);
  return verdict;
};

/**
 * On a busy machine the exhaustive checks take over vitest's 120 s default (both "Stop anytime" checks timed out at load
 * average 75 on an 18-core Mac), so they get ten minutes: a slow machine should make the run slow, not flaky.
 */
const LONG_RUN = 600_000;

describe("run ownership and Stop", () => {
  it(
    "the provider path alone keeps every promise over every schedule",
    async () => {
      const verdict = await timed("provider path", () => checkAsync(spec({ stop: "never" })));
      assertHolds(verdict, { show });
    },
    LONG_RUN,
  );

  it(
    "Stop pressed once the provider turn is projected keeps every promise and reaches the provider",
    async () => {
      const verdict = await timed("Stop after the turn is projected", () =>
        checkAsync(spec({ stop: "after the provider turn is projected", liveness: true })),
      );
      assertHolds(verdict, { show });
    },
    LONG_RUN,
  );

  // Holding turn/start back while Stop is in flight makes Stop commit first in every schedule here, so this window
  // checks each way Stop can land while the start is still on its way to the provider, and pins those commits.
  it(
    "Stop committed before turn/start reaches the provider keeps every promise and reaches the provider",
    async () => {
      const seen: Array<Obs> = [];
      const base = spec({
        stop: "committed before turn/start reaches the provider",
        liveness: true,
      });
      const verdict = await timed("Stop before turn/start reaches the provider", () =>
        checkAsync({ ...base, observe: (sys) => observe(sys).then((o) => (seen.push(o), o)) }),
      );
      assertHolds(verdict, { show });
      const reached = (what: string, holds: (o: Obs) => boolean) =>
        expect(seen.some(holds), what).toBe(true);
      const stopAboutToCommit = (o: Obs) => o.parked.some((name) => name.startsWith(STOP_COMMIT));
      reached(
        "Stop commits while the start waits to send turn/start",
        (o) => stopAboutToCommit(o) && o.parked.includes(RECEIVE_TURN_START),
      );
      reached(
        "Stop commits while the start opens the provider session",
        (o) => stopAboutToCommit(o) && o.parked.includes(OPEN_SESSION),
      );
      reached(
        "Stop commits while the start's running write waits for the writer",
        (o) => stopAboutToCommit(o) && o.parked.includes(START_RUNNING_WRITE),
      );
      reached("the starting-to-running compare-and-set fails", (o) =>
        o.failedCas.includes("running write"),
      );
      reached(
        "Stop commits before the worker claims the start",
        (o) => stopAboutToCommit(o) && o.effects.includes("provider-turn.start:pending"),
      );
      reached(
        "Stop cancels the start",
        (o) => o.stopCommitted && o.effects.includes("provider-turn.start:cancelled"),
      );
    },
    LONG_RUN,
  );

  it(
    "Stop pressed at any point keeps every promise, over every schedule",
    async () => {
      const seen: Array<Obs> = [];
      const base = spec({ stop: "anytime" });
      const verdict = await timed("Stop anytime", () =>
        checkAsync({ ...base, observe: (sys) => observe(sys).then((o) => (seen.push(o), o)) }),
      );
      assertHolds(verdict, { show });
      const reached = (what: string, holds: (o: Obs) => boolean) =>
        expect(seen.some(holds), what).toBe(true);
      reached(
        "Stop commits between the ownership read and the terminal write",
        (o) => o.parked.includes(ownershipRead("running")) && o.stopCommitted,
      );
      reached("the terminal write's compare-and-set fails", (o) =>
        o.failedCas.includes("terminal write"),
      );
      reached("the starting-to-running compare-and-set fails", (o) =>
        o.failedCas.includes("running write"),
      );
      reached("Stop's interrupt reaches the adapter", (o) =>
        o.provider.some((turn) => turn.endsWith("interruptTurn x1")),
      );
      reached("the interrupt waits on the clock", (o) => o.timerPending);
      reached("Stop cancels a start in flight", (o) =>
        o.effects.includes("provider-turn.start:cancelled"),
      );
    },
    LONG_RUN,
  );

  it(
    "Stop pressed at any point reaches the provider",
    async () => {
      const verdict = await timed("Stop anytime, reaches the provider", () =>
        checkAsync(spec({ stop: "anytime", liveness: true })),
      );
      assertHolds(verdict, { show });
    },
    LONG_RUN,
  );
});

/** Takes the enabled step of that name; STOP_COMMIT matches Stop's commit whatever Stop planned. */
const takeStep = async (sys: Sys, name: string) => {
  const action = enabled(await observe(sys), "anytime").find(
    (candidate) =>
      candidate.name === name ||
      (name === STOP_COMMIT && candidate.name.startsWith(`${STOP_COMMIT} (`)),
  );
  if (action === undefined)
    throw new Error(`"${name}" is not enabled: ${show(await observe(sys))}`);
  await action.run(sys);
};

/**
 * Outside the checked bound: the run's turn 1 runs, then a restart (`restart_active`) commits the run's next attempt,
 * leaving turn 1 for provider-turn.restart to interrupt. That effect waits for the interrupt's reports through a bounded
 * loop of yields, so the adapter double delivers them with the interrupt.
 */
const startThenRestart = async () => {
  const sys = await make();
  try {
    for (const name of [
      RUN_EFFECT,
      OPEN_SESSION,
      START_RUNNING_WRITE,
      RECEIVE_TURN_START,
      "provider: answer turn/start",
      "provider: report turn 1 running",
    ])
      await takeStep(sys, name);
    const [run] = await query<{ run_id: string }>(
      sys,
      "SELECT run_id FROM orchestration_v2_projection_runs",
    );
    await runIn(
      sys,
      dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("restart"),
        threadId,
        messageId: MessageId.make("message:restart"),
        text: "Edit other files",
        attachments: [],
        dispatchMode: { type: "restart_active", targetRunId: RunId.make(run!.run_id) },
        createdBy: "user",
        creationSource: "web",
      }),
    );
    await settle(sys);
    sys.harness.value.provider.reportInterruptsAtOnce = true;
    return sys;
  } catch (error) {
    await dispose(sys);
    throw error;
  }
};

/** Replays one schedule with Stop's commit named STOP_COMMIT whatever Stop planned, then drains until nothing is left. */
const replayToQuiet = async (trace: ReadonlyArray<string>) => {
  const rerun = await replay(
    {
      ...spec({ stop: "anytime" }),
      actions: (_sys, o) =>
        enabled(o, "anytime").map((action) =>
          action.name.startsWith(`${STOP_COMMIT} (`) ? { ...action, name: STOP_COMMIT } : action,
        ),
    },
    trace,
  );
  try {
    for (let round = 0; round < 8 && (await drain(rerun.system)).length > 0; round++);
    return { steps: rerun.steps, final: await observe(rerun.system) };
  } finally {
    await dispose(rerun.system);
  }
};

describe("Stop racing the start, replayed", () => {
  // Was finding 3: Stop stamps its events when it plans them, and the session attach stamped after that committed first.
  it("a Stop planned before the provider session opens and committed after it leaves the thread's activity time", async () => {
    const { steps, final } = await replayToQuiet([
      RUN_EFFECT,
      PRESS_STOP,
      OPEN_SESSION,
      STOP_COMMIT,
    ]);
    expect(steps.at(-1)!.state.stopCommitted).toBe(true);
    expect(steps.map((step) => step.state.threadRegressions)).toEqual(steps.map(() => []));
    expect(final.run).toBe("interrupted");
    expect(final.threadRegressions, show(final)).toEqual([]);
  });

  it("Stop pressed while turn/start is on its way to the provider interrupts the turn the provider starts", async () => {
    const { final } = await replayToQuiet([
      RUN_EFFECT,
      OPEN_SESSION,
      START_RUNNING_WRITE,
      RECEIVE_TURN_START,
      PRESS_STOP,
      STOP_COMMIT,
    ]);
    expect(final.stopCommitted).toBe(true);
    expect(final.run).toBe("interrupted");
    expect(final.provider, show(final)).toEqual(["turn 1:ended by interrupt, interruptTurn x1"]);
  });

  it("Stop pressed after the provider accepted turn/start, before the runtime records the turn, interrupts it", async () => {
    const { final } = await replayToQuiet([
      RUN_EFFECT,
      OPEN_SESSION,
      START_RUNNING_WRITE,
      RECEIVE_TURN_START,
      "provider: answer turn/start",
      PRESS_STOP,
      STOP_COMMIT,
    ]);
    expect(final.stopCommitted).toBe(true);
    expect(final.run).toBe("interrupted");
    expect(final.provider, show(final)).toEqual(["turn 1:ended by interrupt, interruptTurn x1"]);
  });

  it("Stop planned before the provider reports the turn and committed after it interrupts the turn", async () => {
    const { final } = await replayToQuiet([
      RUN_EFFECT,
      OPEN_SESSION,
      START_RUNNING_WRITE,
      RECEIVE_TURN_START,
      PRESS_STOP,
      "provider: report turn 1 running",
      STOP_COMMIT,
    ]);
    expect(final.stopCommitted).toBe(true);
    expect(final.run).toBe("interrupted");
    expect(final.provider, show(final)).toEqual(["turn 1:ended by interrupt, interruptTurn x1"]);
  });

  // Outside the checked bound: a restart (`restart_active`) starts the run's next attempt from provider-turn.restart.
  it("Stop pressed while a restart's turn/start is on its way to the provider interrupts the turn the provider starts", async () => {
    const sys = await startThenRestart();
    const take = (name: string) => takeStep(sys, name);
    try {
      await take(RUN_EFFECT);
      for (const name of [START_RUNNING_WRITE, RECEIVE_TURN_START, PRESS_STOP, STOP_COMMIT])
        await take(name);
      expect((await observe(sys)).stopCommitted).toBe(true);
      for (let round = 0; round < 8 && (await drain(sys)).length > 0; round++);
      const final = await observe(sys);
      expect(final.run).toBe("interrupted");
      expect(final.provider, show(final)).toEqual([
        "turn 1:ended by interrupt, interruptTurn x1",
        "turn 2:ended by interrupt, interruptTurn x1",
      ]);
    } finally {
      await dispose(sys);
    }
  });

  it("Stop pressed after a restart commits, before its effect interrupts the old turn, interrupts that turn", async () => {
    const sys = await startThenRestart();
    try {
      expect((await observe(sys)).effects).toContain("provider-turn.restart:pending");
      for (const name of [PRESS_STOP, STOP_COMMIT]) await takeStep(sys, name);
      expect((await observe(sys)).stopCommitted).toBe(true);
      for (let round = 0; round < 8 && (await drain(sys)).length > 0; round++);
      const final = await observe(sys);
      expect(final.run).toBe("interrupted");
      expect(final.provider, show(final)).toEqual(["turn 1:ended by interrupt, interruptTurn x1"]);
      expect(final.providerTurns).toEqual(["interrupted"]);
    } finally {
      await dispose(sys);
    }
  });

  it("a Stop planned before the provider turn is recorded leaves a run that finished meanwhile finished", async () => {
    const { steps, final } = await replayToQuiet([
      RUN_EFFECT,
      OPEN_SESSION,
      START_RUNNING_WRITE,
      RECEIVE_TURN_START,
      PROVIDER_FINISHES,
      PRESS_STOP,
      "provider: report turn 1 running",
      "provider: report turn 1 completed",
      "provider: report turn 1 terminal completed",
      ownershipRead("running"),
      STOP_COMMIT,
    ]);
    const beforeStopCommit = steps.at(-2)!.state;
    expect([beforeStopCommit.run, beforeStopCommit.attempt]).toEqual(["waiting", "completed"]);
    expect({
      run: outcome(final.run),
      stoppedAfterwards: final.runHistory.includes("interrupted"),
      attemptHistory: final.attemptHistory,
      interruptResults: final.signals.filter((signal) => signal.startsWith("run_interrupt_result")),
    }).toEqual({
      run: "completed",
      stoppedAfterwards: false,
      attemptHistory: ["pending", "running", "completed"],
      interruptResults: [],
    });
  });
});

// Queue mode: the thread's queued runs, the end-of-run reaction that starts the next one (handleRunUpdate), and the
// messages that reach the thread between a run's end and that reaction, which take the reaction's work first
// (startQueueBetweenRuns in Orchestrator.ts, a deviation from T3).

/**
 * The provider path's gates, which queue mode lets through: the checks above explore how Stop races a turn's start,
 * so here a queued run's start reaches the provider in the step that claims it, and every report arrives as it is sent.
 */
const passProviderPath = (gates: Gates["Service"]): Gates["Service"] => ({
  gate: (name) =>
    name === OPEN_SESSION ||
    name === RECEIVE_TURN_START ||
    name === ANSWER_TURN_START ||
    name === START_RUNNING_WRITE ||
    name.startsWith("run: read ownership")
      ? Effect.void
      : gates.gate(name),
});
const ANSWER_TURN_START = "provider: answer turn/start";

/** Messages are named for the run they queue or start: A is the active run, P the person's, R a delegated result. */
const labelOf = (messageId: string) =>
  messageId.startsWith("message:")
    ? messageId.slice("message:".length)
    : messageId.startsWith("async-answer:")
      ? "Q"
      : messageId;
const messageIdOf = (label: string) => MessageId.make(`message:${label}`);

/**
 * Whose a message is. R is a delegated agent's result, which goes ahead of the person's queued messages; W is a pull
 * request watch's wake and B a provider's wake (a background task ended); Q is the person's answer to a question asked
 * as a message; the rest are the person's.
 */
type Kind = "person" | "result" | "wake";
const kindOf = (label: string): Kind =>
  label === "R" ? "result" : label === "W" || label === "B" ? "wake" : "person";

/** What may reach the thread during a check, once each: P2 the person's message, R, Q, W and B as in `kindOf`. */
type SendLabel = "P2" | "R" | "Q" | "W" | "B";

interface QueueBound {
  readonly label: string;
  /** The person's messages queued behind A when the check starts, in order, and how a queued start fails. */
  readonly queued: ReadonlyArray<{
    readonly label: string;
    /**
     * `unrecorded`: its provider thread is gone, so the start fails with no failure on the run (the next starts).
     * `recorded`: its attempt is gone, so the start fails and records a failure of class unknown (the queue holds).
     * `provider refuses`: the start reaches the provider, which refuses turn/start (a provider failure: the queue holds).
     */
    readonly fails?: "unrecorded" | "recorded" | "provider refuses";
  }>;
  readonly sends: ReadonlyArray<SendLabel>;
  /** When a send may come, if not at any point: a narrower bound that still reaches the schedule a check is about. */
  readonly sendWhen?: Partial<Record<SendLabel, (o: QObs) => boolean>>;
  readonly stop: boolean;
}

interface SendRecord {
  readonly label: SendLabel;
  /** The runs queued and not held when it reached the thread, in delivery order. */
  readonly ahead: ReadonlyArray<string>;
  /** It reached the thread between a run's end and the reaction to it, with a run waiting in the queue. */
  readonly gap: boolean;
}

interface QueueSys {
  readonly bound: QueueBound;
  readonly sends: Array<SendRecord>;
}

const TASK = NodeId.make("task:delegated");
const REQUEST = RuntimeRequestId.make("request:question");
const PULL_REQUEST = { host: "github.com", repository: "caveman/app", number: 7 } as const;

/** The run ends the Orchestrator's end-of-run reaction takes: its subscription's filter, for this thread's own runs. */
const REACTED = new Set(["completed", "interrupted", "failed", "cancelled", "rolled_back"]);
const REACTION = "reaction:";
const reactionGate = (stored: OrchestrationV2StoredEvent) =>
  stored.event.type === "run.updated" &&
  REACTED.has(stored.event.payload.status) &&
  !String(stored.commandId).startsWith("command:runtime-reconcile:")
    ? `${REACTION} ${labelOf(stored.event.payload.userMessageId)} ${stored.event.payload.status}`
    : undefined;

const queueMessage = (label: string) =>
  dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${label}`),
    threadId,
    messageId: messageIdOf(label),
    text: label === "A" ? "Edit the files" : `Then ${label}`,
    attachments: [],
    dispatchMode: { type: label === "A" ? "start_immediately" : "queue_after_active" },
    createdBy: "user",
    creationSource: "web",
  });

const runOf = (label: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadProjection(threadId),
  ).pipe(
    Effect.map((projection) =>
      projection.runs.find((run) => run.userMessageId === messageIdOf(label))!,
    ),
  );

const rewriteRun = (run: OrchestrationV2Run, patch: Partial<OrchestrationV2Run>, why: string) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      commandId: CommandId.make(`seed:${why}`),
      events: [
        {
          id: EventId.make(`seed:${why}`),
          type: "run.updated",
          threadId,
          runId: run.id,
          ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
          providerInstanceId: run.providerInstanceId,
          occurredAt: yield* DateTime.now,
          payload: { ...run, ...patch },
        },
      ],
    });
  });

/**
 * What the bound needs before the check starts, after A runs: A's delegated task finished and its result claimed for
 * delivery as message R (as seedParentWithTerminalTask in DelegatedCompletionDelivery.test.ts), a question asked as a
 * message (seedPendingQuestion in runtimeLayer.test.ts), a pull request watch, the queued messages, and the stale
 * records that make a queued start fail.
 */
const seedQueue = (bound: QueueBound) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const active = yield* runOf("A");
    if (bound.sends.includes("R")) {
      yield* rewriteRun(
        active,
        {
          delegatedCompletion: {
            disposition: "open",
            nextGeneration: 2,
            delivery: { generation: 1, messageId: messageIdOf("R"), taskIds: [TASK] },
          },
        },
        "delegation",
      );
      yield* sink.write({
        commandId: CommandId.make("seed:task"),
        events: [
          {
            id: EventId.make("seed:task"),
            type: "subagent.updated",
            threadId,
            runId: active.id,
            nodeId: TASK,
            driver,
            providerInstanceId: instanceId,
            occurredAt: now,
            payload: {
              id: TASK,
              threadId,
              runId: active.id,
              parentNodeId: active.rootNodeId!,
              origin: "app_owned",
              createdBy: "agent",
              driver,
              providerInstanceId: instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: null,
              prompt: "Check the other files.",
              title: null,
              model: null,
              completionWake: "settled_only",
              completionDelivery: { state: "claimed", observedByRunId: null },
              status: "completed",
              result: "child finished",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
            },
          },
        ],
      });
    }
    if (bound.sends.includes("Q")) {
      const nodeId = NodeId.make("node:question");
      yield* sink.write({
        commandId: CommandId.make("seed:question"),
        events: [
          {
            id: EventId.make("seed:question:node"),
            type: "node.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: nodeId,
              threadId,
              runId: null,
              parentNodeId: null,
              rootNodeId: nodeId,
              kind: "user_input_request",
              status: "waiting",
              countsForRun: false,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: REQUEST,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("seed:question:request"),
            type: "runtime-request.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: REQUEST,
              nodeId,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
          {
            id: EventId.make("seed:question:item"),
            type: "turn-item.updated",
            threadId,
            nodeId,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:question"),
              type: "user_input_request",
              threadId,
              runId: null,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 0,
              status: "waiting",
              title: null,
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              requestId: REQUEST,
              questions: [{ id: "color", header: "Color", question: "Which color?", options: [] }],
            },
          },
        ],
      });
    }
    if (bound.sends.includes("W")) {
      yield* dispatch({
        type: "thread.pull-request.watch",
        commandId: CommandId.make("seed:watch"),
        threadId,
        ...PULL_REQUEST,
        watching: true,
        link: { url: "https://github.com/caveman/app/pull/7", source: "agent" },
      });
    }
    for (const { label } of bound.queued) yield* queueMessage(label);
    for (const { label, fails } of bound.queued) {
      if (fails === "unrecorded") {
        yield* rewriteRun(
          yield* runOf(label),
          { providerThreadId: ProviderThreadId.make("provider-thread:gone") },
          `${label}:gone`,
        );
      }
      if (fails === "recorded") {
        yield* rewriteRun(
          yield* runOf(label),
          { activeAttemptId: RunAttemptId.make("attempt:gone") },
          `${label}:gone`,
        );
      }
    }
  });

const makeQueue = (bound: QueueBound) => async (): Promise<Sys> => {
  const config = await serverConfig;
  const timers = new VirtualTimers();
  const restoreTimers = timers.install();
  try {
    const harness = await openHarness(
      Effect.gen(function* () {
        const gates = passProviderPath(yield* Gates);
        const provider: ScriptedProvider = {
          ...makeProvider(),
          reportAtOnce: true,
          refuses: new Set(
            bound.queued
              .filter((queued) => queued.fails === "provider refuses")
              .map((queued) => messageIdOf(queued.label)),
          ),
        };
        const probe = makeProbe();
        const context = yield* Layer.build(
          layerSystem(
            makeAdapter(provider, gates, config.cwd),
            config,
            gates,
            probe,
            reactionGate,
          ).pipe(Layer.provide(layerNoProviderInstances)),
        );
        return { context, provider, probe } satisfies World;
      }),
    );
    const sys: Sys = {
      harness,
      timers,
      restoreTimers,
      stopPressed: false,
      workers: 0,
      queue: { bound, sends: [] },
    };
    await recordThreadRegressions(sys);
    await runIn(
      sys,
      Effect.gen(function* () {
        yield* dispatch({
          type: "thread.create",
          commandId: CommandId.make("create"),
          threadId,
          projectId: ProjectId.make("project:stop"),
          title: "Queue",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        yield* queueMessage("A");
      }),
    );
    await settle(sys);
    // A's start runs to the provider, which reports the turn running at once.
    forkWorker(sys);
    await settle(sys);
    await runIn(sys, seedQueue(bound));
    await settle(sys);
    return sys;
  } catch (error) {
    restoreTimers();
    throw error;
  }
};

interface QRun {
  readonly label: string;
  readonly status: string;
  readonly held: boolean;
  readonly ordinal: number;
  readonly position: number | null;
}

const qrun = (payload: OrchestrationV2Run): QRun => ({
  label: labelOf(payload.userMessageId),
  status: payload.status,
  held: payload.queueHeld === true,
  ordinal: payload.ordinal,
  position: payload.queuePosition ?? null,
});

/**
 * The queue's order, stated here rather than read from QueuedRunOrder.ts: delegated results first, then the order the
 * runs were queued in (their queue position, else their ordinal). A held run waits for the person.
 */
const deliveryOrder = (runs: ReadonlyArray<QRun>) =>
  runs
    .filter((run) => run.status === "queued" && !run.held)
    .toSorted(
      (left, right) =>
        Number(kindOf(right.label) === "result") - Number(kindOf(left.label) === "result") ||
        (left.position ?? left.ordinal) - (right.position ?? right.ordinal) ||
        left.ordinal - right.ordinal,
    );

const ACTIVE = new Set(["preparing", "starting", "running", "waiting"]);

const QUEUE_PROPERTIES = {
  twoActive: "never two runs active at once",
  providerTwoTurns: "the provider runs one of the thread's turns at a time",
  heldStarts: "a held run never starts",
  stopHolds: "once Stop commits, only the person's message starts a run",
  order: "queued runs start in queue order, a delegated result ahead of the person's messages",
  jumps: "a message never starts ahead of what was queued before it reached the thread",
  finalizedTwice: "a delegated delivery is finalized once",
} as const;

interface QObs {
  readonly runs: ReadonlyArray<QRun>;
  /** The runs that executed, in the order they ran: the last is the one latestExecutedRun reads as having just ended. */
  readonly ran: ReadonlyArray<string>;
  /** The delegated task's delivery and A's cohort. */
  readonly delivery: string;
  readonly effects: ReadonlyArray<string>;
  readonly provider: ReadonlyArray<string>;
  readonly parked: ReadonlyArray<string>;
  /** Run ends committed that the end-of-run reaction has not reached yet, oldest first (the one it is parked at is in `parked`). */
  readonly reactions: ReadonlyArray<string>;
  readonly fibers: ReadonlyArray<string>;
  readonly sends: ReadonlyArray<SendRecord>;
  readonly stopPressed: boolean;
  readonly stopCommitted: boolean;
  readonly stop: string;
  readonly workersRunning: number;
  readonly timerPending: boolean;
  /** The properties some prefix of the run log broke (see `analyzeQueue`); sticky, so a break is never merged away. */
  readonly broken: ReadonlyArray<string>;
  /** The run log, `label status` per run update in commit order: shown in a trace, left out of a state's identity. */
  readonly log: ReadonlyArray<string>;
}

interface LogRun extends QRun {
  readonly sequence: number;
  /**
   * The run's delegated cohort after this write: its disposition and the delivery generation out, if any. A write whose
   * payload has no cohort keeps the recorded one, as the projection does (`keepRecordedRunField`): the run's own writers
   * leave it out so a newer cohort is never overwritten.
   */
  readonly delivery: string;
}

/**
 * Every queue property over the run log in commit order, so a break inside one step (two writes the step made) is seen,
 * not only the state the step ends in.
 */
const analyzeQueue = (
  log: ReadonlyArray<LogRun>,
  sends: ReadonlyArray<SendRecord>,
  stopSequence: number | undefined,
  taskDeliveries: ReadonlyArray<string>,
): Array<string> => {
  const broken = new Set<string>();
  const now = new Map<string, LogRun>();
  const firstSeen = new Map<string, number>();
  const started = new Map<string, number>();
  // Which run must start first, from what was queued (and not held) when each message reached the thread. A person's
  // message or a wake waits behind all of it (else it jumped the queue); a delegated result only behind the results,
  // and goes ahead of the rest (else the queue's order broke: results first).
  const mustPrecede = sends.flatMap((send) =>
    send.ahead.map((ahead): readonly [string, string, string] =>
      kindOf(send.label) === "result" && kindOf(ahead) !== "result"
        ? [send.label, ahead, QUEUE_PROPERTIES.order]
        : [ahead, send.label, QUEUE_PROPERTIES.jumps],
    ),
  );
  for (const [index, entry] of log.entries()) {
    const previous = now.get(entry.label);
    if (!firstSeen.has(entry.label)) firstSeen.set(entry.label, index);
    const starts =
      entry.status !== "queued" &&
      entry.status !== "cancelled" &&
      !started.has(entry.label) &&
      (previous === undefined || previous.status === "queued");
    if (starts) {
      started.set(entry.label, index);
      if (previous?.held === true) broken.add(QUEUE_PROPERTIES.heldStarts);
      if (previous !== undefined && deliveryOrder([...now.values()])[0]?.label !== entry.label) {
        broken.add(QUEUE_PROPERTIES.order);
      }
      if (
        stopSequence !== undefined &&
        entry.sequence > stopSequence &&
        kindOf(entry.label) !== "person"
      ) {
        broken.add(QUEUE_PROPERTIES.stopHolds);
      }
      for (const [first, then, property] of mustPrecede) {
        const ahead = now.get(first);
        if (
          then === entry.label &&
          ahead !== undefined &&
          ahead.status === "queued" &&
          !ahead.held
        ) {
          broken.add(property);
        }
      }
    }
    now.set(entry.label, entry);
    if ([...now.values()].filter((run) => ACTIVE.has(run.status)).length > 1)
      broken.add(QUEUE_PROPERTIES.twoActive);
  }
  // A result that should have gone first but reached the log only after the run it should precede started.
  for (const [first, then, property] of mustPrecede) {
    const at = started.get(then);
    const seen = firstSeen.get(first);
    if (at !== undefined && seen !== undefined && seen > at) broken.add(property);
  }
  // Finalizing a delivery marks its task delivered and takes the delivery off A's cohort; doing either twice changes state.
  const cohort = log.filter((entry) => entry.label === "A").map((entry) => entry.delivery);
  const left = cohort.flatMap((delivery, index) =>
    index > 0 && delivery !== cohort[index - 1]
      ? (cohort[index - 1]!.match(/ g\d+$/)?.[0] ?? [])
      : [],
  );
  if (
    taskDeliveries.filter((state) => state === "delivered").length > 1 ||
    left.length !== new Set(left).size
  ) {
    broken.add(QUEUE_PROPERTIES.finalizedTwice);
  }
  return [...broken].sort();
};

const observeQueue = async (sys: Sys): Promise<QObs> => {
  const { provider, probe } = sys.harness.value;
  const runRows = await query<{ payload_json: string }>(
    sys,
    "SELECT payload_json FROM orchestration_v2_projection_runs",
  );
  const payloads = runRows.map((row) => JSON.parse(row.payload_json) as OrchestrationV2Run);
  const runs = payloads
    .map(qrun)
    .toSorted(
      (left, right) => left.ordinal - right.ordinal || left.label.localeCompare(right.label),
    );
  const end = (run: OrchestrationV2Run) =>
    run.completedAt === null || run.completedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Date.parse(String(run.completedAt));
  const ran = payloads
    .filter(
      (run) => run.status !== "queued" && !(run.status === "cancelled" && run.startedAt === null),
    )
    .toSorted((left, right) => end(left) - end(right) || left.ordinal - right.ordinal)
    .map((run) => labelOf(run.userMessageId));
  const logRows = await query<{
    sequence: number;
    command_id: string | null;
    payload_json: string;
  }>(
    sys,
    "SELECT sequence, command_id, payload_json FROM orchestration_events WHERE aggregate_kind = 'thread' AND event_type IN ('run.created', 'run.updated') ORDER BY sequence",
  );
  const cohorts = new Map<string, string>();
  const log = logRows.map((row): LogRun & { readonly command: string | null } => {
    const payload = JSON.parse(row.payload_json) as OrchestrationV2Run;
    const run = qrun(payload);
    const cohort = payload.delegatedCompletion;
    const delivery =
      cohort === undefined
        ? (cohorts.get(run.label) ?? "none")
        : `${cohort.disposition}${cohort.delivery === null || cohort.delivery === undefined ? "" : ` g${cohort.delivery.generation}`}`;
    cohorts.set(run.label, delivery);
    return { ...run, sequence: row.sequence, command: row.command_id, delivery };
  });
  const reacted = log.filter(
    (entry) =>
      REACTED.has(entry.status) &&
      !String(entry.command ?? "").startsWith("command:runtime-reconcile:"),
  );
  const taskRows = await query<{ payload_json: string }>(
    sys,
    "SELECT payload_json FROM orchestration_events WHERE event_type = 'subagent.updated' ORDER BY sequence",
  );
  const taskDeliveries = taskRows.map(
    (row) =>
      (JSON.parse(row.payload_json) as { completionDelivery?: { state: string } })
        .completionDelivery?.state ?? "none",
  );
  const effects = await query<{ effect_type: string; status: string }>(
    sys,
    "SELECT effect_type, status FROM orchestration_v2_effect_outbox ORDER BY rowid",
  );
  const fibers = sys.harness.fibers();
  const sends = sys.queue?.sends ?? [];
  const lastA = log.findLast((entry) => entry.label === "A");
  return {
    runs,
    ran,
    delivery: `task ${taskDeliveries.at(-1) ?? "none"}, A's cohort ${lastA?.delivery ?? "none"}`,
    effects: effects.map((row) => `${row.effect_type}:${row.status}`),
    provider: provider.turns.map(
      (turn) =>
        `${turn.id}:${turn.status}${turn.endedBy === null ? "" : ` by ${turn.endedBy}`}, interruptTurn x${turn.interruptCalls}`,
    ),
    parked: sys.harness.gates.parked(),
    reactions: reacted
      .slice(probe.reactionsReached)
      .map((entry) => `${entry.label} ${entry.status}`),
    fibers: Object.entries(fibers)
      .filter(([name]) => name.startsWith("send ") || name === "stop")
      .map(([name, status]) => `${name} ${status}`),
    sends: [...sends],
    stopPressed: sys.stopPressed,
    stopCommitted: probe.stopCommitted,
    stop: fibers.stop ?? "not pressed",
    workersRunning: Object.entries(fibers).filter(
      ([name, status]) => name.startsWith("worker") && status === "running",
    ).length,
    timerPending: sys.timers.nextAt() !== undefined,
    broken: [
      ...analyzeQueue(log, sends, probe.stopCommitSequence, taskDeliveries),
      ...(provider.turns.filter((turn) => turn.status === "running").length > 1
        ? [QUEUE_PROPERTIES.providerTwoTurns]
        : []),
    ].sort(),
    log: log.map((entry) => `${entry.label} ${entry.status}${entry.held ? " held" : ""}`),
  };
};

/** A state's identity: everything but the printed log, whose effect on what can happen next is in the other fields. */
const queueKey = (o: QObs) => canonicalKey({ ...o, log: undefined });

const sendCommand = (label: SendLabel) => {
  switch (label) {
    case "P2":
      return queueMessage("P2");
    case "R":
      return Effect.flatMap(runOf("A"), (active) =>
        dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("send:R"),
          threadId,
          messageId: messageIdOf("R"),
          text: "Delegated task completed",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: active.id, generation: 1, taskIds: [TASK] },
        }),
      );
    case "B":
      // A provider's wake for its own background work, as "starts a provider wake queued beside a held queue" in
      // runtimeLayer.test.ts sends it: while a run goes that no Stop reached, a held queue does not hold it.
      return dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("send:B"),
        threadId,
        messageId: messageIdOf("B"),
        text: "Background task completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "provider",
      });
    case "Q":
      return dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make("send:Q"),
        threadId,
        requestId: REQUEST,
        answers: { color: "Blue" },
      });
    case "W":
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const watch = (yield* orchestrator.getThreadShell(threadId))?.pullRequests?.[0]?.watch;
        if (watch === undefined) return yield* Effect.fail("the pull request watch ended");
        return yield* dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make("send:W"),
          threadId,
          ...PULL_REQUEST,
          startedAt: watch.startedAt,
          watch: { ...watch, headSha: "abc123", failedChecks: ["lint"], wakes: 1 },
          wake: {
            messageId: messageIdOf("W"),
            text: "A check failed",
            notification: { source: { kind: "monitor" }, outcome: "updated", summary: "#7" },
          },
        });
      });
  }
};

const SEND_ACTION: Record<SendLabel, string> = {
  P2: "user: send P2 to queue",
  R: "agent: deliver R, the delegated task's result",
  Q: "user: answer the question (Q)",
  W: "watch: wake the thread (W)",
  B: "provider: wake the thread for its background task (B)",
};

/** A run's end the reaction has not taken yet: parked at its gate, or not reached. */
const awaitingReaction = (o: Pick<QObs, "reactions" | "parked">) =>
  o.reactions.length > 0 || o.parked.some((name) => name.startsWith(REACTION));

/** Between a run's end and the reaction to it, with no run going and a run waiting in the queue: the gap. */
const inGap = (o: QObs) =>
  awaitingReaction(o) &&
  !o.runs.some((run) => ACTIVE.has(run.status)) &&
  deliveryOrder(o.runs).length > 0;

const send = async (sys: Sys, label: SendLabel) => {
  const o = await observeQueue(sys);
  sys.queue!.sends.push({
    label,
    ahead: deliveryOrder(o.runs).map((run) => run.label),
    gap: inGap(o),
  });
  sys.harness.fork(
    `send ${label}`,
    inWorld(sys, sendCommand(label).pipe(Effect.provideService(Actor, "user"))),
  );
};

const queueEnabled = (bound: QueueBound, o: QObs): ReadonlyArray<Action<Sys>> => {
  // Stop holds the thread's lock from its plan to its commit: a message or a reaction released meanwhile would only wait
  // for it, the same as one released right after Stop commits, which is explored.
  const stopHoldsLock = o.parked.some((name) => name.startsWith(STOP_COMMIT));
  const sent = new Set(o.sends.map((record) => record.label));
  const running = o.runs.some((run) => run.status === "running");
  return [
    ...o.parked
      .filter((name) => !(stopHoldsLock && name.startsWith(REACTION)))
      .map((name) => step(name, (s) => void s.harness.gates.release(name))),
    ...(effectClaimable(o) ? [step(RUN_EFFECT, forkWorker)] : []),
    ...(o.provider.some((turn) => turn.includes(":running"))
      ? [step(PROVIDER_FINISHES, finishOnItsOwn)]
      : []),
    ...(o.timerPending ? [step(FIRE_TIMER, (s) => s.timers.advanceToNext().then(() => {}))] : []),
    ...(bound.stop && !o.stopPressed ? [step(PRESS_STOP, pressStop)] : []),
    ...(stopHoldsLock
      ? []
      : bound.sends
          // An answer while a turn runs steers it, which is not a queued message.
          .filter(
            (label) =>
              !sent.has(label) &&
              !(label === "Q" && running) &&
              (bound.sendWhen?.[label]?.(o) ?? true),
          )
          .map((label) => step(SEND_ACTION[label], (s) => send(s, label)))),
  ];
};

/** One fair round for the queue's liveness: every reaction and Stop released, the lane run once, the next timer fired. */
const drainQueue = async (sys: Sys): Promise<ReadonlyArray<string>> => {
  const did: Array<string> = [];
  for (const name of sys.harness.gates.releaseAll()) did.push(name);
  await settle(sys);
  const o = await observeQueue(sys);
  if (effectClaimable(o)) {
    did.push(RUN_EFFECT);
    forkWorker(sys);
    await settle(sys);
  }
  if (await sys.timers.advanceToNext()) {
    did.push(FIRE_TIMER);
    await settle(sys);
  }
  return did;
};

/** Nothing blocks the queue (no run goes and no run end waits for its reaction), so no run may wait in it unheld. */
const queueDrains = (o: QObs) =>
  o.runs.some((run) => ACTIVE.has(run.status)) || deliveryOrder(o.runs).length === 0;

const queueSpec = (
  bound: QueueBound,
  options: { readonly without?: ReadonlyArray<string> } = {},
): AsyncSpec<Sys, QObs> => ({
  make: makeQueue(bound),
  dispose,
  observe: observeQueue,
  key: queueKey,
  actions: (_sys, o) => queueEnabled(bound, o),
  invariants: Object.fromEntries(
    Object.values(QUEUE_PROPERTIES)
      .filter((name) => !(options.without ?? []).includes(name))
      .map((name) => [name, (o: QObs) => !o.broken.includes(name)]),
  ),
  eventually: { "no queued run is stranded": queueDrains },
  drain: drainQueue,
  drainRounds: 12,
});

const showQueue = (o: QObs) =>
  [
    `runs [${o.runs.map((run) => `${run.label}:${run.status}${run.held ? " held" : ""}`).join(", ")}]`,
    `log [${o.log.join(", ")}]`,
    `ran [${o.ran.join(", ")}]`,
    o.delivery.includes("none") && o.delivery.endsWith("none") ? "" : o.delivery,
    `effects [${o.effects.join(", ")}]`,
    `adapter [${o.provider.join("; ")}]`,
    o.reactions.length === 0 ? "" : `reaction pending for [${o.reactions.join(", ")}]`,
    o.sends.length === 0
      ? ""
      : `sent [${o.sends.map((record) => `${record.label}${record.gap ? " in the gap" : ""} behind [${record.ahead.join(", ")}]`).join(", ")}]`,
    o.fibers.length === 0 ? "" : `fibers [${o.fibers.join(", ")}]`,
    `stop ${o.stopCommitted ? "committed" : o.stop}`,
    o.parked.length === 0 ? "" : `parked [${o.parked.join(", ")}]`,
    o.broken.length === 0 ? "" : `BROKEN [${o.broken.join("; ")}]`,
  ]
    .filter((part) => part !== "")
    .join(" | ");

const timedQueue = async (label: string, run: () => Promise<Verdict<QObs>>) => {
  const started = performance.now();
  const verdict = await run();
  const seconds = (performance.now() - started) / 1000;
  if (verdict.ok) {
    console.log(
      `${label}: ${verdict.states} states, ${verdict.transitions} transitions, depth ${verdict.depth}, exhaustive ${verdict.exhaustive}, ${seconds.toFixed(1)} s`,
    );
  } else {
    console.log(
      `${label}: ${verdict.kind} "${verdict.property}" broken after ${verdict.trace.length - 1} steps (${verdict.states} states, ${seconds.toFixed(1)} s)\n${formatTrace(verdict.trace, showQueue)}`,
    );
  }
  return verdict;
};

/** The full bound (`MODEL_CHECK_DEEP=1`, as the effect-outbox-worker check): every message and Stop at once. */
const DEEP = process.env.MODEL_CHECK_DEEP === "1";
/** A full-bound check explores thousands of states: an hour, so a loaded machine makes it slow, not flaky. */
const DEEP_RUN = 3_600_000;

const started = (o: QObs, label: string) =>
  o.runs.some((run) => run.label === label && run.status !== "queued");
const queued = (o: QObs, label: string) =>
  o.runs.some((run) => run.label === label && run.status === "queued");
const gapSend = (o: QObs, label: SendLabel) =>
  o.sends.find((record) => record.label === label && record.gap);

interface QueueCheck {
  readonly bound: QueueBound;
  /** Schedules each check must reach, so a change that stops reaching them fails here rather than passing vacuously. */
  readonly reaches: Readonly<Record<string, (o: QObs) => boolean>>;
}

/** The pre-step started what was queued ahead of `label`'s message before the reaction to the run's end ran. */
const preStepStartedAhead = (label: SendLabel) => (o: QObs) => {
  const record = gapSend(o, label);
  return (
    record !== undefined &&
    record.ahead.length > 0 &&
    started(o, record.ahead[0]!) &&
    awaitingReaction(o)
  );
};

/** R's run ended and the reaction to its end has not run: where a message finalizes R's delivery ahead of the reaction. */
const inResultGap = (o: QObs) =>
  o.runs.some((run) => run.label === "R" && REACTED.has(run.status)) && awaitingReaction(o);

const held = (o: QObs, label: string) => o.runs.some((run) => run.label === label && run.held);
const failed = (o: QObs, label: string) =>
  o.runs.some((run) => run.label === label && run.status === "failed");

const QUEUE_CHECKS: ReadonlyArray<QueueCheck & { readonly deep?: true }> = [
  {
    bound: { label: "P2 and Stop any time", queued: [{ label: "P1" }], sends: ["P2"], stop: true },
    reaches: {
      "P2 reaches the thread between a run's end and the reaction": (o) =>
        gapSend(o, "P2") !== undefined,
      "the pre-step starts P1 before the reaction runs": preStepStartedAhead("P2"),
      "Stop commits between a run's end and the reaction": (o) =>
        o.stopCommitted && awaitingReaction(o) && o.runs.some((run) => run.held),
      "Stop holds the queue once nothing runs": (o) =>
        o.stopCommitted &&
        !awaitingReaction(o) &&
        !o.runs.some((run) => ACTIVE.has(run.status)) &&
        o.runs.some((run) => run.held),
      "P2 starts at once past the queue Stop held": (o) =>
        o.stopCommitted && started(o, "P2") && held(o, "P1"),
      "P2 sent after Stop, before its run ends, waits held": (o) =>
        o.stopCommitted && held(o, "P2"),
    },
  },
  {
    bound: {
      label: "R any time, P2 between R's end and the reaction",
      queued: [{ label: "P1" }],
      sends: ["R", "P2"],
      sendWhen: { P2: inResultGap },
      stop: false,
    },
    reaches: {
      "R reaches the thread in the gap and starts ahead of P1": (o) =>
        gapSend(o, "R") !== undefined && started(o, "R") && queued(o, "P1"),
      "R queues ahead of P1 behind a running run": (o) =>
        o.sends.some(
          (record) => record.label === "R" && !record.gap && record.ahead.includes("P1"),
        ) &&
        started(o, "R") &&
        queued(o, "P1"),
      "P2's pre-step finalizes R's delivery and starts P1 before the reaction to R's end": (o) =>
        o.delivery.startsWith("task delivered") &&
        o.parked.includes(`${REACTION} R completed`) &&
        started(o, "P1"),
      "the reaction to R's end runs after the pre-step finalized it": (o) =>
        o.delivery.startsWith("task delivered") &&
        gapSend(o, "P2") !== undefined &&
        !awaitingReaction(o) &&
        started(o, "P1"),
    },
  },
  {
    bound: {
      label: "P1 fails to start, unrecorded; P2 any time",
      queued: [{ label: "P1", fails: "unrecorded" }, { label: "P3" }],
      sends: ["P2"],
      stop: false,
    },
    reaches: {
      "P1 fails to start and P3 starts": (o) => failed(o, "P1") && started(o, "P3"),
      "the pre-step goes on to P3 after P1 fails, before any reaction": (o) => {
        const record = gapSend(o, "P2");
        return (
          record !== undefined &&
          record.ahead.join() === "P1,P3" &&
          started(o, "P3") &&
          awaitingReaction(o)
        );
      },
    },
  },
  {
    bound: {
      label: "P1 fails to start, recorded; P2 any time, B beside the held queue",
      queued: [{ label: "P1", fails: "recorded" }, { label: "P3" }],
      sends: ["P2", "B"],
      // A provider's wake skips a hold only while a run goes: once P2 starts past the queue P1's failure held.
      sendWhen: {
        B: (o) => o.runs.some((run) => run.held) && o.runs.some((run) => ACTIVE.has(run.status)),
      },
      stop: false,
    },
    reaches: {
      "the failure holds P3": (o) => held(o, "P3"),
      "P2 sent in the gap starts past the queue its pre-step held": (o) =>
        gapSend(o, "P2") !== undefined && started(o, "P2") && held(o, "P3"),
      "B queues unheld beside held P3": (o) => queued(o, "B") && !held(o, "B") && held(o, "P3"),
      "B starts after P2 and P3 stays held": (o) => started(o, "B") && held(o, "P3"),
    },
  },
  {
    bound: {
      label: "the provider refuses P1; P2 any time",
      queued: [{ label: "P1", fails: "provider refuses" }, { label: "P3" }],
      sends: ["P2"],
      stop: false,
    },
    reaches: {
      "P1's start fails at the provider and holds P3": (o) => failed(o, "P1") && held(o, "P3"),
      "P2 sent between P1's failure and its reaction starts past the queue its pre-step held": (
        o,
      ) =>
        o.sends.some(
          (record) => record.label === "P2" && record.gap && record.ahead.join() === "P3",
        ) &&
        started(o, "P2") &&
        held(o, "P3"),
    },
  },
  {
    bound: { label: "the answer Q any time", queued: [{ label: "P1" }], sends: ["Q"], stop: false },
    reaches: {
      "Q reaches the thread in the gap and waits behind P1": (o) =>
        gapSend(o, "Q") !== undefined && started(o, "P1") && queued(o, "Q"),
    },
  },
  {
    bound: {
      label: "the watch's wake W any time",
      queued: [{ label: "P1" }],
      sends: ["W"],
      stop: false,
    },
    reaches: {
      "W reaches the thread in the gap and waits behind P1": (o) =>
        gapSend(o, "W") !== undefined && started(o, "P1") && queued(o, "W"),
    },
  },
  // The full bound: each message at any point, with Stop, and two queued behind A.
  {
    deep: true,
    bound: {
      label: "R and P2 any time",
      queued: [{ label: "P1" }],
      sends: ["R", "P2"],
      stop: false,
    },
    reaches: {
      "P2's pre-step finalizes R's delivery and starts P1 before the reaction to R's end": (o) =>
        o.delivery.startsWith("task delivered") &&
        o.parked.includes(`${REACTION} R completed`) &&
        started(o, "P1"),
    },
  },
  {
    deep: true,
    bound: { label: "R and Stop any time", queued: [{ label: "P1" }], sends: ["R"], stop: true },
    reaches: {
      "Stop commits with R queued": (o) => o.stopCommitted && held(o, "R"),
      "R arrives after Stop and is refused": (o) =>
        o.stopCommitted &&
        o.fibers.includes("send R failed") &&
        !o.runs.some((run) => run.label === "R"),
    },
  },
  {
    deep: true,
    bound: {
      label: "P1 and P3 queued; P2 and Stop any time",
      queued: [{ label: "P1" }, { label: "P3" }],
      sends: ["P2"],
      stop: true,
    },
    reaches: {
      "P2 in the gap waits behind P1 and P3": (o) =>
        gapSend(o, "P2")?.ahead.join() === "P1,P3" &&
        started(o, "P1") &&
        queued(o, "P3") &&
        queued(o, "P2"),
      "Stop holds P3 and P2 behind P1": (o) => o.stopCommitted && held(o, "P3") && held(o, "P2"),
    },
  },
  {
    deep: true,
    bound: {
      label: "R, P2 and Stop any time",
      queued: [{ label: "P1" }],
      sends: ["R", "P2"],
      stop: true,
    },
    reaches: {
      "R reaches the thread in the gap and starts ahead of P1": (o) =>
        gapSend(o, "R") !== undefined && started(o, "R") && queued(o, "P1"),
      "Stop commits between a run's end and the reaction": (o) =>
        o.stopCommitted && awaitingReaction(o) && o.runs.some((run) => run.held),
      "Stop holds R and P1": (o) => o.stopCommitted && held(o, "R") && held(o, "P1"),
    },
  },
  ...(["unrecorded", "recorded", "provider refuses"] as const).map((fails) => ({
    deep: true as const,
    bound: {
      label: `P1 fails to start, ${fails}; P2 and Stop any time`,
      queued: [{ label: "P1", fails }, { label: "P3" }],
      sends: ["P2"] as const,
      stop: true,
    },
    reaches: {
      "Stop commits after P1's start failed": (o: QObs) => o.stopCommitted && failed(o, "P1"),
    },
  })),
  ...(["Q", "W"] as const).map((label) => ({
    deep: true as const,
    bound: {
      label: `${label} and Stop any time`,
      queued: [{ label: "P1" }],
      sends: [label],
      stop: true,
    },
    reaches: {
      [`${label} reaches the thread in the gap and waits behind P1`]: (o: QObs) =>
        gapSend(o, label) !== undefined && started(o, "P1") && queued(o, label),
    },
  })),
];

const runQueueCheck = async (check: QueueCheck) => {
  const seen: Array<QObs> = [];
  const base = queueSpec(check.bound);
  const verdict = await timedQueue(`queue: ${check.bound.label}`, () =>
    checkAsync({ ...base, observe: (sys) => observeQueue(sys).then((o) => (seen.push(o), o)) }),
  );
  return { verdict, seen };
};

describe("queued runs between runs", () => {
  for (const check of QUEUE_CHECKS) {
    it.runIf(DEEP || check.deep !== true)(
      `${check.bound.label}: every queue promise holds over every schedule`,
      async () => {
        const { verdict, seen } = await runQueueCheck(check);
        assertHolds(verdict, { show: showQueue });
        for (const [what, holds] of Object.entries(check.reaches))
          expect(seen.some(holds), what).toBe(true);
      },
      check.deep === true ? DEEP_RUN : LONG_RUN,
    );
  }
});
