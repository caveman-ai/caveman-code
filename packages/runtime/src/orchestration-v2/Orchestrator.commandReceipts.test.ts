import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@caveman-app/protocol";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };

/** The next capability read waits here: a dispatch past its receipt check, still planning. */
interface PlanningGate {
  readonly reached: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

const makeLayer = (gate: Ref.Ref<Option.Option<PlanningGate>>) => {
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () =>
      Ref.getAndSet(gate, Option.none()).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: ({ reached, release }) =>
              Deferred.succeed(reached, undefined).pipe(Effect.andThen(Deferred.await(release))),
          }),
        ),
        Effect.as(CodexProviderCapabilitiesV2),
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () => Effect.die("No provider process needed for command receipts"),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  return ProviderReplayHarness.layerWithRegistry(
    { name: "command-receipts" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: SqlitePersistence.layerMemory, runEffectWorker: false },
  );
};

const create = (orchestrator: Orchestrator.OrchestratorV2["Service"], threadId: ThreadId) =>
  orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:create:${threadId}`),
    threadId,
    projectId: ProjectId.make("project:command-receipts"),
    title: threadId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });

const send = (
  orchestrator: Orchestrator.OrchestratorV2["Service"],
  threadId: ThreadId,
  commandId: CommandId,
) =>
  orchestrator.dispatch({
    type: "message.dispatch",
    commandId,
    threadId,
    messageId: MessageId.make(`message:${threadId}`),
    text: `hello ${threadId}`,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });

it.effect("refuses a message whose command id another thread committed while it was planning", () =>
  Effect.gen(function* () {
    const gate = yield* Ref.make<Option.Option<PlanningGate>>(Option.none());
    yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadA = ThreadId.make("thread:command-receipts-a");
      const threadB = ThreadId.make("thread:command-receipts-b");
      yield* create(orchestrator, threadA);
      yield* create(orchestrator, threadB);
      const commandId = CommandId.make("command:command-receipts:reused");

      // B passes its receipt check (no receipt yet) and is still planning under its own
      // thread's lock when A, under another lock, commits the same command id.
      const planning: PlanningGate = {
        reached: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* Ref.set(gate, Option.some(planning));
      const second = yield* send(orchestrator, threadB, commandId).pipe(
        Effect.exit,
        Effect.forkChild,
      );
      yield* Deferred.await(planning.reached);
      const first = yield* send(orchestrator, threadA, commandId);
      yield* Deferred.succeed(planning.release, undefined);
      const secondExit = yield* Fiber.join(second);

      assert.isTrue(first.storedEvents.every((stored) => stored.event.threadId === threadA));
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadA)).runs, 1);
      // Thread B never got the message, so its sender must not hear it was sent.
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadB)).runs, 0);
      assert.isTrue(Exit.isFailure(secondExit), "B's message was reported sent");
      if (Exit.isFailure(secondExit)) {
        const error = secondExit.cause.reasons.find((reason) => reason._tag === "Fail")?.error;
        assert.deepInclude(error, {
          _tag: "OrchestratorCommandIdConflictError",
          commandId,
          receiptThreadId: threadA,
          commandThreadId: threadB,
        });
      }
    }).pipe(Effect.provide(makeLayer(gate)));
  }),
);
