import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@caveman-app/protocol";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("The queue transition test does not run a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const gate: { complete: Effect.Effect<unknown, unknown> | undefined } = { complete: undefined };
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "queue-dispatch-order" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  {
    databaseLayer: SqlitePersistence.layerMemory,
    runEffectWorker: false,
    transformProjectionStore: (store) => ({
      ...store,
      canStartQueuedRun: (id) =>
        store.canStartQueuedRun(id).pipe(
          Effect.tap(() => {
            const complete = gate.complete;
            gate.complete = undefined;
            return complete === undefined ? Effect.void : complete.pipe(Effect.orDie);
          }),
        ),
    }),
  },
);

for (const input of [
  {
    name: "a queued send cannot overtake an earlier send between turns",
    queued: true,
    held: false,
    mode: "queue_after_active",
    expected: "queued",
  },
  {
    name: "a new send starts past a held queue once the active run ends",
    queued: true,
    held: true,
    mode: "queue_after_active",
    expected: "starting",
  },
  {
    name: "an explicit immediate send can precede a held queue",
    queued: true,
    held: true,
    mode: "start_immediately",
    expected: "starting",
  },
  {
    name: "a queued send starts when no earlier run waits",
    queued: false,
    held: false,
    mode: "queue_after_active",
    expected: "starting",
  },
  ...(["provider", "web", "server"] as const).map((source) => ({
    name: `a ${source} send beside held work keeps its hold policy between turns`,
    queued: true,
    held: false,
    heldSibling: true,
    source,
    mode: "queue_after_active" as const,
    expected: "queued" as const,
    expectedHeld: source !== "provider",
  })),
] as const) {
  const scenario = {
    source: "web" as "web" | "provider" | "server",
    heldSibling: false,
    expectedHeld: false,
    ...input,
  };
  it.effect(scenario.name, () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:queue-dispatch-order");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:queue-dispatch-order"),
        title: "Queue dispatch order",
        modelSelection: { instanceId, model: "gpt-5.1-codex" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      const send = (key: string, mode: "start_immediately" | "queue_after_active") =>
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(key),
          threadId,
          messageId: MessageId.make(key),
          text: key,
          attachments: [],
          dispatchMode: { type: mode },
          createdBy: key === "later" && scenario.source !== "web" ? "agent" : "user",
          creationSource: key === "later" ? scenario.source : "web",
        });
      yield* send("working", "start_immediately");
      if (scenario.queued) yield* send("earlier", "queue_after_active");
      if (scenario.heldSibling) yield* send("held-sibling", "queue_after_active");
      const before = yield* orchestrator.getThreadProjection(threadId);
      const working = before.runs.find((run) => run.userMessageId === "working")!;
      const earlier = before.runs.find((run) => run.userMessageId === "earlier");
      const heldSibling = before.runs.find((run) => run.userMessageId === "held-sibling");
      const now = yield* DateTime.now;
      // The completed turn is projected before the queue worker starts its successor.
      // Keep that real boundary stable instead of depending on machine load.
      const complete = sink.write({
        events: [
          {
            id: EventId.make("working-completed"),
            type: "run.updated",
            threadId,
            runId: working.id,
            occurredAt: now,
            payload: { ...working, status: "completed", completedAt: now },
          },
          ...(earlier === undefined
            ? []
            : [
                {
                  id: EventId.make("earlier-hold"),
                  type: "run.updated" as const,
                  threadId,
                  runId: earlier.id,
                  occurredAt: now,
                  payload: { ...earlier, queueHeld: scenario.held },
                },
              ]),
          ...(heldSibling === undefined
            ? []
            : [
                {
                  id: EventId.make("sibling-held"),
                  type: "run.updated" as const,
                  threadId,
                  runId: heldSibling.id,
                  occurredAt: now,
                  payload: { ...heldSibling, queueHeld: true },
                },
              ]),
        ],
      });
      if (scenario.queued && !scenario.held) {
        gate.complete = complete;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            gate.complete = undefined;
          }),
        );
      } else yield* complete;
      yield* send("later", scenario.mode);
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === working.id)?.status, "completed");
      const later = after.runs.find((run) => run.userMessageId === "later")!;
      assert.equal(later.status, scenario.expected);
      if (scenario.expected === "queued") {
        assert.equal(later.queueHeld === true, scenario.expectedHeld);
        assert.isAbove(later.queuePosition!, earlier!.queuePosition!);
      }
      if (scenario.held) {
        const stillHeld = after.runs.find((run) => run.id === earlier!.id)!;
        assert.equal(stillHeld.status, "queued");
        assert.isTrue(stillHeld.queueHeld);
        assert.notEqual(later.queueHeld, true);
      }
      if (heldSibling !== undefined) {
        const stillHeld = after.runs.find((run) => run.id === heldSibling.id)!;
        assert.equal(stillHeld.status, "queued");
        assert.isTrue(stillHeld.queueHeld);
        assert.notEqual(after.runs.find((run) => run.id === earlier!.id)?.queueHeld, true);
      }
      // A replay of the same accepted command must not create another run.
      yield* send("later", scenario.mode);
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.length,
        after.runs.length,
      );
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}
