import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@caveman-app/protocol";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerTest = Layer.mergeAll(
  SqlitePersistence.layerMemory,
  ProjectionStoreWithV1.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-visit-race" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
  ),
);

it.live("a chat visited while its first turn starts keeps the turn's provider thread", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make("thread:visit-race");
    const providerThreadId = ProviderThreadId.make("provider-thread:visit-race");

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("command:visit-race:create"),
      threadId,
      projectId: ProjectId.make("project:visit-race"),
      title: "Visit race",
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });

    // The visit reads the thread, then reads the clock before it commits. Hold
    // it there, as a reader-worker read lets other writers in.
    const visitHasRead = yield* Deferred.make<void>();
    const releaseVisit = yield* Deferred.make<void>();
    const clock = yield* Clock.Clock;
    let held = false;
    const holdingClock: Clock.Clock = Object.assign(Object.create(clock) as Clock.Clock, {
      currentTimeMillis: Effect.gen(function* () {
        const span = yield* Effect.option(Effect.currentSpan);
        if (
          !held &&
          Option.isSome(span) &&
          span.value.name === "orchestrationV2.dispatch.threadVisit"
        ) {
          held = true;
          yield* Deferred.succeed(visitHasRead, undefined);
          yield* Deferred.await(releaseVisit);
        }
        return clock.currentTimeMillisUnsafe();
      }),
    });

    yield* Effect.sleep("20 millis");
    const visitedAt = DateTime.formatIso(yield* DateTime.now);
    const visit = yield* orchestrator
      .dispatch({
        type: "thread.visit",
        commandId: CommandId.make("command:visit-race:visit"),
        threadId,
        visitedAt,
      })
      .pipe(Effect.provideService(Clock.Clock, holdingClock), Effect.forkChild);
    yield* Deferred.await(visitHasRead).pipe(Effect.timeout("10 seconds"));

    // The turn's start, written as ProviderTurnStartService writes it: without
    // the thread lock the visit holds.
    yield* Effect.sleep("20 millis");
    const startedAt = yield* DateTime.now;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("event:visit-race:provider-thread"),
          type: "provider-thread.updated",
          threadId,
          driver: adapter.driver,
          providerInstanceId: instanceId,
          occurredAt: startedAt,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        },
      ],
    });
    yield* Deferred.succeed(releaseVisit, undefined);
    yield* Fiber.join(visit);

    const thread = yield* projections.getThread(threadId);
    assert.deepEqual(
      {
        activeProviderThreadId: thread.activeProviderThreadId,
        updatedAt: DateTime.formatIso(thread.updatedAt),
        lastVisitedAt: thread.lastVisitedAt && DateTime.formatIso(thread.lastVisitedAt),
      },
      {
        activeProviderThreadId: providerThreadId,
        updatedAt: DateTime.formatIso(startedAt),
        lastVisitedAt: visitedAt,
      },
    );
  }).pipe(Effect.provide(layerTest)),
);
