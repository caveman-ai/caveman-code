import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@caveman-app/protocol";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Statement from "effect/sql/Statement";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { planProjectCommand } from "./ProjectCommands.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import type * as ProviderAdapter from "@caveman-app/engine-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process: the effect worker is off"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = () =>
  Layer.mergeAll(
    layerDatabase,
    ProjectionStoreWithV1.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "command-id-reuse" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false },
    ),
  );

const projectId = ProjectId.make("project:command-id-reuse");

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:create:${threadId}`),
      threadId,
      projectId,
      title: "untitled",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const rename = (threadId: ThreadId, commandId: CommandId, title: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId,
      threadId,
      title,
    });
  });

/** Commits a project.create the way ProjectService.commit does. */
const commitProjectCreate = (commandId: CommandId, id: ProjectId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const planned = planProjectCommand({
      command: {
        type: "project.create",
        commandId,
        projectId: id,
        title: "Shared id",
        workspaceRoot: `/tmp/${id}`,
      },
      state: { project: undefined, workspaceOwner: undefined },
      eventId: EventId.make(`event:${commandId}`),
      now,
    });
    if (Result.isFailure(planned)) return yield* Effect.die(planned.failure);
    const { committed } = yield* eventSink.commitProjectCommand({
      commandId,
      projectId: id,
      commandType: "project.create",
      acceptedAt: now,
      event: planned.success,
    });
    assert.isTrue(committed);
  });

/**
 * Holds a dispatch after its command receipt checks, at its first other
 * statement, so another command can take the id before this one commits.
 */
const holdAfterReceiptCheck = Effect.gen(function* () {
  const checked = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  let step: "checking" | "checked" | "released" = "checking";
  const transformer: Statement.Transformer = (statement) =>
    Effect.suspend(() => {
      if (statement.compile()[0].includes("orchestration_command_receipts")) {
        if (step === "checking") step = "checked";
        return Effect.succeed(statement);
      }
      if (step !== "checked") return Effect.succeed(statement);
      step = "released";
      return Deferred.succeed(checked, undefined).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(statement),
      );
    });
  return {
    checked,
    release,
    hold: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.provideService(effect, Statement.CurrentTransformer, transformer),
  };
});

type DispatchExit = Exit.Exit<
  Orchestrator.OrchestratorV2DispatchResult,
  Orchestrator.OrchestratorV2Error
>;

const outcome = (exit: DispatchExit) =>
  Exit.isSuccess(exit)
    ? `accepted with events for ${[
        ...new Set(exit.value.storedEvents.map(({ event }) => event.threadId)),
      ].join(", ")}`
    : Option.match(Cause.findErrorOption(exit.cause), {
        onNone: () => `defect: ${String(Cause.squash(exit.cause))}`,
        onSome: (error) => `${error._tag}: ${userFacingDispatchErrorMessage(error)}`,
      });

const titleOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return (yield* projections.getThreadShell(threadId))?.title;
  });

describe("a command id names one command", () => {
  it.effect("reusing a command id on another thread is refused", () =>
    Effect.gen(function* () {
      const a = ThreadId.make("thread:reuse-sequential-a");
      const b = ThreadId.make("thread:reuse-sequential-b");
      yield* createThread(a);
      yield* createThread(b);
      const commandId = CommandId.make("command:rename:sequential");
      yield* rename(a, commandId, "A renamed");

      const reused = yield* Effect.exit(rename(b, commandId, "B renamed"));

      assert.equal(
        outcome(reused),
        "OrchestratorCommandIdConflictError: Command command:rename:sequential was already handled for thread thread:reuse-sequential-a and cannot be replayed for thread:reuse-sequential-b.",
      );
      assert.equal(yield* titleOf(b), "untitled");
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("a command whose id another thread takes mid-dispatch is refused", () =>
    Effect.gen(function* () {
      const a = ThreadId.make("thread:reuse-racing-a");
      const b = ThreadId.make("thread:reuse-racing-b");
      yield* createThread(a);
      yield* createThread(b);
      const commandId = CommandId.make("command:rename:racing");
      const gate = yield* holdAfterReceiptCheck;
      const pending = yield* Effect.forkChild(
        Effect.exit(gate.hold(rename(b, commandId, "B renamed"))),
      );
      yield* Deferred.await(gate.checked);
      yield* rename(a, commandId, "A renamed");
      yield* Deferred.succeed(gate.release, undefined);

      const reused = yield* Fiber.join(pending);

      assert.equal(
        outcome(reused),
        "OrchestratorCommandIdConflictError: Command command:rename:racing was already handled for thread thread:reuse-racing-a and cannot be replayed for thread:reuse-racing-b.",
      );
      assert.equal(yield* titleOf(a), "A renamed");
      assert.equal(yield* titleOf(b), "untitled");
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("a thread command reusing a project command's id is refused as a conflict", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:reuse-project-id");
      const otherProject = ProjectId.make("project:command-id-reuse-owner");
      const createId = CommandId.make("command:shared-with-project:create");
      yield* commitProjectCreate(createId, otherProject);

      const created = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.create",
          commandId: createId,
          threadId,
          projectId,
          title: "Reused id",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.equal(
        outcome(created),
        "OrchestratorCommandIdConflictError: Command command:shared-with-project:create was already handled for project project:command-id-reuse-owner and cannot be replayed for thread:reuse-project-id.",
      );
      assert.isUndefined(yield* titleOf(threadId));

      yield* createThread(threadId);
      const sendId = CommandId.make("command:shared-with-project:message");
      yield* commitProjectCreate(sendId, ProjectId.make("project:command-id-reuse-message"));
      const sent = yield* Effect.exit(
        orchestrator.dispatch({
          type: "message.dispatch",
          commandId: sendId,
          threadId,
          messageId: MessageId.make("message:shared-with-project"),
          text: "hello",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      assert.equal(
        outcome(sent),
        "OrchestratorCommandIdConflictError: Command command:shared-with-project:message was already handled for project project:command-id-reuse-message and cannot be replayed for thread:reuse-project-id.",
      );
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 0);
    }).pipe(Effect.provide(layerTest())),
  );

  it.effect("a project command that takes the id while a thread command plans fails it typed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:reuse-project-racing");
      yield* createThread(threadId);
      const commandId = CommandId.make("command:rename:project-racing");
      const gate = yield* holdAfterReceiptCheck;
      const pending = yield* Effect.forkChild(
        Effect.exit(gate.hold(rename(threadId, commandId, "renamed"))),
      );
      yield* Deferred.await(gate.checked);
      yield* commitProjectCreate(commandId, ProjectId.make("project:command-id-reuse-racing"));
      yield* Deferred.succeed(gate.release, undefined);

      const reused = yield* Fiber.join(pending);

      assert.equal(
        outcome(reused),
        "OrchestratorDispatchError: Command command:rename:project-racing was already used by a project command.",
      );
      assert.equal(yield* titleOf(threadId), "untitled");
    }).pipe(Effect.provide(layerTest())),
  );
});
