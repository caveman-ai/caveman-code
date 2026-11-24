// What the T3 /ws route sends a client, read over a real socket: never a repository secret's value (16-SECRETS), and
// never less than the command printed.
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  DEFAULT_TERMINAL_ID,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type TerminalAttachStreamEvent,
  type TerminalEvent,
  ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import { createScrubber } from "@caveman-app/session-protocol";
import {
  makeProviderFailure,
  MAX_PROVIDER_FAILURE_MESSAGE_LENGTH,
} from "@caveman-app/engine-core/server/failure";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import * as CommandOutputHub from "./orchestration-v2/CommandOutputHub.ts";
import * as EventSink from "./orchestration-v2/EventSink.ts";
import * as EventStore from "./orchestration-v2/EventStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./orchestration-v2/legacy/ProjectionStoreWithV1.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ThreadLaunchService from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "./orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "./orchestration-v2/ThreadSearch.ts";
import {
  projectTurnItemForDetail,
  TRUNCATED_FOR_TRANSPORT,
} from "./orchestration-v2/WireProjection.ts";
import * as OrchestrationEventStore from "./persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import { ProjectSecrets } from "./secrets/ProjectSecrets.ts";
import { terminalsOnFakePty } from "./testkit/fakePty.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import { serveWs, stubService, wsClient } from "./testkit/wsServer.ts";

// A repository with a few ordinary hideable secrets.
const STRIPE_KEY = ("sk_" + "test_51NzQx2LkP0aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0u");
/** Shorter than its mask, `[secret:POSTGRES_PASSWORD]`. */
const PASSWORD = "Pw9x!secr3tZ";
const scrubber = createScrubber([
  { name: "OPENAI_API_KEY", value: ("sk-" + "proj-7Qx9vL2mZp4tR8wYbN3kD6fH1jS5aC0e") },
  { name: "DATABASE_URL", value: "postgres://app:Xk3pQ9zL2mW8vR4t@db.internal:5432/app" },
  { name: "STRIPE_SECRET_KEY", value: STRIPE_KEY },
  { name: "POSTGRES_PASSWORD", value: PASSWORD },
]);
const MASKED = "[secret:STRIPE_SECRET_KEY]";
/** What `cat .env` printed. */
const ENV_FILE = `STRIPE_SECRET_KEY=${STRIPE_KEY}\nNODE_ENV=production\n`;

const codex = ProviderInstanceId.make("codex");

/** The real command output hub on the real event sink and projections (in-memory SQLite). */
const commandOutput = Layer.unwrap(
  Effect.sync(() => {
    const db = SqlitePersistence.layerMemory;
    const stores = Layer.merge(EventStore.layer, ProjectionStoreWithV1.layer).pipe(
      Layer.provide(db),
    );
    const sink = EventSink.layer.pipe(Layer.provide(Layer.mergeAll(stores, db)));
    return Layer.mergeAll(
      db,
      sink,
      IdAllocator.layer,
      CommandOutputHub.layer.pipe(Layer.provide(Layer.merge(sink, stores))),
    );
  }),
);

/** A thread with one running command row, as Codex's or Claude Agent's adapter projects it. */
const seedRunningCommand = (itemId: TurnItemId) =>
  Effect.gen(function* () {
    const ids = yield* IdAllocator.IdAllocatorV2;
    const events = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const projectId = yield* ids.allocate.project({ fixtureName: "ws-secrets" });
    const threadId: ThreadId = yield* ids.allocate.thread({ fixtureName: "ws-secrets", projectId });
    const thread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Dev server",
      providerInstanceId: codex,
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      branchPullRequest: null,
      activeOrderKey: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    const item: OrchestrationV2TurnItem = {
      id: itemId,
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      title: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      type: "command_execution",
      input: "pnpm dev",
      status: "running",
    };
    yield* events.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    yield* events.write({
      events: [
        {
          id: yield* ids.allocate.event({ threadId }),
          type: "turn-item.updated",
          threadId,
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: codex,
          occurredAt: now,
          payload: item,
        },
      ],
    });
    return threadId;
  });

it.live("a running command's last line reaches a /ws subscriber once the command goes quiet", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(commandOutput);
    const url = yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services });
    const itemId = TurnItemId.make("turn-item:dev-server");
    const threadId = yield* seedRunningCommand(itemId).pipe(Effect.provide(services));
    // Its tail could begin one of the stored values in a form the scrub knows, so the scrub holds it back.
    const line = "  Health check: http://localhost:3000/health\n";
    assert.notEqual(scrubber.stream().push(line), line);

    // The dev server prints its line, then stays up and says nothing more.
    const hub = yield* CommandOutputHub.CommandOutputHub.pipe(Effect.provide(services));
    yield* hub.append({ threadId, itemId, chunk: line });

    const rpc = yield* wsClient(url);
    let shown = "";
    yield* rpc["orchestration.subscribeCommandOutput"]({ threadId, itemId }).pipe(
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          shown = frame.kind === "replace" ? frame.text : shown + frame.text;
        }),
      ),
      // Far past the hub's 100 ms frame interval and the 30 ms a held tail waits for more output.
      Effect.timeoutOption("1500 millis"),
    );
    assert.equal(shown, line);
  }),
);

const claudeAgent = ProviderInstanceId.make("claudeAgent");
const modelSelection = {
  instanceId: claudeAgent,
  model: "claude-sonnet-4-5",
} satisfies ModelSelection;
const THREAD = ThreadId.make("thread:ws-secrets");
const RUN = RunId.make("run:ws-secrets");
const NODE = NodeId.make("node:ws-secrets");

/**
 * Thread reads on the real projections (in-memory SQLite). ThreadManagementService passes them through, as its own
 * getTurnItem and snapshot reads do.
 */
const transcripts = Layer.unwrap(
  Effect.sync(() => {
    const projections = ProjectionStoreWithV1.layer.pipe(
      Layer.provideMerge(SqlitePersistence.layerMemory),
    );
    const management = Layer.unwrap(
      Effect.gen(function* () {
        const store = yield* ProjectionStore.ProjectionStoreV2;
        return Layer.mock(ThreadManagementService.ThreadManagementService)({
          ensureLegacyTranscript: () => Effect.void,
          getThreadSnapshot: (id) => store.getThreadSnapshot(id).pipe(Effect.orDie),
          getThreadSnapshotWindow: (id, options) =>
            store.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
          streamStoredEventsFrom: () => Stream.never,
          readShellSnapshot: (options) =>
            store.readShellSnapshot(options).pipe(Effect.map(Effect.orDie), Effect.orDie),
          getThreadShell: (id) => store.getThreadShell(id).pipe(Effect.orDie),
          getTurnItem: (input) =>
            store.getTurnItem(input).pipe(
              Effect.orDie,
              Effect.map((item) => ({
                item: item === null ? null : projectTurnItemForDetail(item),
              })),
            ),
          searchThread: (...args) => store.searchThread(...args).pipe(Effect.orDie),
          searchThreadStream: (...args) => store.searchThreadStream(...args).pipe(Stream.orDie),
        });
      }),
    );
    return Layer.mergeAll(projections, management.pipe(Layer.provide(projections)));
  }),
);

const commandItem = (
  id: string,
  now: DateTime.Utc,
  fields: Partial<Extract<OrchestrationV2TurnItem, { type: "command_execution" }>>,
): Extract<OrchestrationV2TurnItem, { type: "command_execution" }> => ({
  id: TurnItemId.make(id),
  threadId: THREAD,
  runId: RUN,
  nodeId: NODE,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 1,
  status: "completed",
  title: "cat .env",
  startedAt: now,
  completedAt: now,
  updatedAt: now,
  type: "command_execution",
  input: "cat .env",
  output: ENV_FILE,
  exitCode: 0,
  ...fields,
});

/**
 * A Claude Agent thread whose agent printed the .env twice: once in a command that exited 0, once in a Bash call that
 * failed (Claude Agent reports no exit code, so the row keeps its error text on the wire).
 */
const seedLeakyThread = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const driver = ProviderDriverKind.make("claudeAgent");
  yield* projections.apply({
    id: EventId.make("event:thread-created"),
    type: "thread.created",
    threadId: THREAD,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: THREAD,
      projectId: ProjectId.make("project:ws-secrets"),
      title: "Deploy",
      providerInstanceId: claudeAgent,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projections.apply({
    id: EventId.make("event:run-created"),
    type: "run.created",
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    driver,
    providerInstanceId: claudeAgent,
    occurredAt: now,
    payload: {
      id: RUN,
      threadId: THREAD,
      ordinal: 1,
      providerInstanceId: claudeAgent,
      modelSelection,
      providerThreadId: null,
      userMessageId: MessageId.make("message:ws-secrets"),
      rootNodeId: NODE,
      activeAttemptId: null,
      status: "completed",
      requestedAt: now,
      startedAt: now,
      completedAt: now,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  for (const item of [
    commandItem("item:cat-env", now, {}),
    commandItem("item:deploy", now, {
      ordinal: 2,
      status: "failed",
      title: "cat .env && npm run deploy",
      input: "cat .env && npm run deploy",
      output: `${ENV_FILE}npm ERR! missing script: deploy`,
      exitCode: undefined,
    }),
  ]) {
    yield* projections.apply({
      id: EventId.make(`event:${item.id}`),
      type: "turn-item.updated",
      threadId: THREAD,
      runId: RUN,
      nodeId: NODE,
      driver,
      occurredAt: now,
      payload: item,
    });
  }
});

it.live("a finished command read over /ws never carries a secret value", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(transcripts);
    yield* seedLeakyThread.pipe(Effect.provide(services));
    const rpc = yield* wsClient(
      yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services }),
    );

    const { item } = yield* rpc["orchestration.getTurnItem"]({
      threadId: THREAD,
      itemId: TurnItemId.make("item:cat-env"),
    });
    assert.equal(
      item?.type === "command_execution" ? item.output : undefined,
      `STRIPE_SECRET_KEY=${MASKED}\nNODE_ENV=production\n`,
    );
  }),
);

it.live("a thread read over /ws never carries a secret value", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(transcripts);
    yield* seedLeakyThread.pipe(Effect.provide(services));
    const rpc = yield* wsClient(
      yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services }),
    );

    const subscribed = yield* rpc["orchestration.subscribeThread"]({
      threadId: THREAD,
      requestCompletionMarker: true,
    }).pipe(
      Stream.takeUntil((item) => item.kind === "synchronized"),
      Stream.runCollect,
    );
    const projection = yield* rpc["orchestration.getThreadProjection"]({ threadId: THREAD });
    for (const read of [JSON.stringify(subscribed), JSON.stringify(projection)]) {
      // The failed call's row still says why it failed...
      assert.include(read, "missing script: deploy");
      assert.include(read, MASKED);
      // ...but not with the value it printed.
      assert.notInclude(read, STRIPE_KEY);
    }
  }),
);

/** Output whose value starts 20 characters before `cut`, so a cut there falls inside it. */
const straddling = (cut: number) => {
  const assignment = "STRIPE_SECRET_KEY=";
  return `${"#".repeat(cut - 20 - assignment.length)}${assignment}${STRIPE_KEY}\nNODE_ENV=production\n`;
};

it.live("a value the runtime's cut fell inside never reads over /ws", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(transcripts);
    yield* seedLeakyThread.pipe(Effect.provide(services));
    const now = yield* DateTime.now;
    // A failed Bash call's error keeps 2048 characters on the wire; a detail read keeps 256 KiB. The truncation note
    // counts toward each cap, so the cut falls that much earlier.
    const note = Buffer.byteLength(TRUNCATED_FOR_TRANSPORT, "utf8");
    const failed = commandItem("item:failed-long", now, {
      ordinal: 3,
      status: "failed",
      output: straddling(2048 - note),
      exitCode: undefined,
    });
    const long = commandItem("item:cat-long", now, {
      ordinal: 4,
      output: straddling(256 * 1024 - note),
    });
    yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        Effect.forEach([failed, long], (item) =>
          projections.apply({
            id: EventId.make(`event:${item.id}`),
            type: "turn-item.updated",
            threadId: THREAD,
            runId: RUN,
            nodeId: NODE,
            driver: ProviderDriverKind.make("claudeAgent"),
            occurredAt: now,
            payload: item,
          }),
        ),
      ),
      Effect.provide(services),
    );
    const rpc = yield* wsClient(
      yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services }),
    );

    const outputOf = (items: ReadonlyArray<OrchestrationV2TurnItem>, id: TurnItemId) =>
      items.flatMap((item) =>
        item.id === id && item.type === "command_execution" && item.output !== undefined
          ? [item.output]
          : [],
      );
    const projection = yield* rpc["orchestration.getThreadProjection"]({ threadId: THREAD });
    const subscribed = yield* rpc["orchestration.subscribeThread"]({
      threadId: THREAD,
      requestCompletionMarker: true,
    }).pipe(
      Stream.takeUntil((event) => event.kind === "synchronized"),
      Stream.runCollect,
    );
    const { item } = yield* rpc["orchestration.getTurnItem"]({ threadId: THREAD, itemId: long.id });
    const outputs = [
      ...outputOf(projection.turnItems, failed.id),
      ...subscribed.flatMap((event) =>
        event.kind === "snapshot" && "projection" in event
          ? outputOf(event.projection.turnItems, failed.id)
          : [],
      ),
      ...outputOf(item === null ? [] : [item], long.id),
    ];
    assert.lengthOf(outputs, 3);
    for (const output of outputs) {
      assert.equal(
        output.slice(output.lastIndexOf("STRIPE_SECRET_KEY=")),
        "STRIPE_SECRET_KEY=[secret]\n… output truncated for transport",
      );
      assert.notInclude(output, STRIPE_KEY.slice(0, 8));
    }
  }),
);

it.live("a message at its length bound still reads over /ws once the secret in it is masked", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(transcripts);
    yield* seedLeakyThread.pipe(Effect.provide(services));
    // A provider error that quoted the command it ran, cut to the most a failure message may hold. Its value is bare,
    // so makeProviderFailure's own redaction (a `password=` or `token:` form) leaves it for the runtime's mask.
    const failure = makeProviderFailure({
      message: `Command failed: psql -h db.internal app -W ${PASSWORD}\n${"psql: error: connection refused\n".repeat(200)}`,
    });
    assert.equal(failure.message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
    const now = yield* DateTime.now;
    const itemId = TurnItemId.make("item:provider-error");
    yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        projections.apply({
          id: EventId.make("event:provider-error"),
          type: "turn-item.updated",
          threadId: THREAD,
          runId: RUN,
          nodeId: NODE,
          driver: ProviderDriverKind.make("claudeAgent"),
          occurredAt: now,
          payload: {
            id: itemId,
            threadId: THREAD,
            runId: RUN,
            nodeId: NODE,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 3,
            status: "failed",
            title: "Provider error",
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            type: "error",
            failure,
          },
        }),
      ),
      Effect.provide(services),
    );
    const rpc = yield* wsClient(
      yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services }),
    );

    const messageIn = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
      items.flatMap((item) =>
        item.id === itemId && item.type === "error" ? [item.failure.message] : [],
      );
    const { item } = yield* rpc["orchestration.getTurnItem"]({ threadId: THREAD, itemId });
    const projection = yield* rpc["orchestration.getThreadProjection"]({ threadId: THREAD });
    const subscribed = yield* rpc["orchestration.subscribeThread"]({
      threadId: THREAD,
      requestCompletionMarker: true,
    }).pipe(
      Stream.takeUntil((event) => event.kind === "synchronized"),
      Stream.runCollect,
    );
    const messages = [
      ...messageIn(item === null ? [] : [item]),
      ...messageIn(projection.turnItems),
      ...subscribed.flatMap((event) =>
        event.kind === "snapshot" && "projection" in event
          ? messageIn(event.projection.turnItems)
          : [],
      ),
    ];
    assert.lengthOf(messages, 3);
    for (const message of messages) {
      assert.notInclude(message, PASSWORD);
      assert.include(message, "Command failed: psql -h db.internal app -W [secret");
      assert.isAtMost(message.length, MAX_PROVIDER_FAILURE_MESSAGE_LENGTH);
      // Nothing the provider said is lost to the mask: the message as it was, the value masked.
      assert.equal(message, failure.message.replace(PASSWORD, "[secret]"));
    }
  }),
);

const PROJECT = ProjectId.make("project:ws-secrets");

const seedProject = Effect.gen(function* () {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* (yield* ProjectStore.ProjectStoreV2).apply({
    sequence: 0,
    eventId: EventId.make("event:project-created"),
    aggregateKind: "project",
    aggregateId: PROJECT,
    occurredAt: now,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId: PROJECT,
      title: "ws-secrets",
      workspaceRoot: "/work/ws-secrets",
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  });
});

/** The real thread search on the same projections, with the repository's secrets. */
const searchable = Layer.mergeAll(
  ProjectStore.layer,
  ThreadSearch.layer.pipe(
    Layer.provide(Layer.mock(ProjectSecrets)({ scrubber: Effect.succeed(scrubber) })),
  ),
).pipe(Layer.provideMerge(transcripts));

it.live("thread search over /ws never shows or confirms a secret value", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(searchable);
    yield* seedLeakyThread.pipe(Effect.provide(services));
    const now = yield* DateTime.now;
    yield* Effect.gen(function* () {
      yield* seedProject;
      // Pasted before the key was stored as a secret.
      yield* (yield* ProjectionStore.ProjectionStoreV2).apply({
        id: EventId.make("event:message-pasted"),
        type: "message.updated",
        threadId: THREAD,
        providerInstanceId: claudeAgent,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: MessageId.make("message:pasted"),
          threadId: THREAD,
          runId: null,
          nodeId: null,
          role: "user",
          text: `use STRIPE_SECRET_KEY=${STRIPE_KEY} for staging`,
          attachments: [],
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
    }).pipe(Effect.provide(services));
    const rpc = yield* wsClient(
      yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services }),
    );

    const { matches } = yield* rpc["orchestration.searchThreads"]({ query: "staging" });
    assert.deepEqual(
      matches.map((match) => match.snippet),
      [`use STRIPE_SECRET_KEY=${MASKED} for staging`],
    );
    // Whether a thread matches says nothing about the value: a right guess finds nothing.
    for (const guess of [STRIPE_KEY.slice(0, 20), STRIPE_KEY.slice(10)]) {
      assert.deepEqual((yield* rpc["orchestration.searchThreads"]({ query: guess })).matches, []);
    }
  }),
);

it.live("find in a thread over /ws never confirms a secret value", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(searchable);
    yield* Effect.all([seedProject, seedLeakyThread]).pipe(Effect.provide(services));
    const now = yield* DateTime.now;
    const base = {
      threadId: THREAD,
      runId: RUN,
      nodeId: NODE,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      status: "completed",
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    } as const;
    // The agent quoted the key it read back, and its plan names it again.
    const items: ReadonlyArray<OrchestrationV2TurnItem> = [
      {
        ...base,
        id: TurnItemId.make("item:quoted"),
        ordinal: 3,
        type: "assistant_message",
        messageId: MessageId.make("message:quoted"),
        text: `Staging charges with STRIPE_SECRET_KEY=${STRIPE_KEY} now.`,
        streaming: false,
      },
      {
        ...base,
        id: TurnItemId.make("item:plan"),
        ordinal: 4,
        type: "proposed_plan",
        planId: PlanId.make("plan:quoted"),
        markdown: `1. Rotate \`${STRIPE_KEY}\` after staging.`,
        streaming: false,
      },
    ];
    yield* ProjectionStore.ProjectionStoreV2.pipe(
      Effect.flatMap((projections) =>
        Effect.forEach(items, (item) =>
          projections.apply({
            id: EventId.make(`event:${item.id}`),
            type: "turn-item.updated",
            threadId: THREAD,
            runId: RUN,
            nodeId: NODE,
            driver: ProviderDriverKind.make("claudeAgent"),
            occurredAt: now,
            payload: item,
          }),
        ),
      ),
      Effect.provide(services),
    );
    const rpc = yield* wsClient(
      yield* serveWs({ scopes: [AuthOrchestrationReadScope], scrubber, services }),
    );
    const find = (query: string) => rpc["orchestration.searchThread"]({ threadId: THREAD, query });
    const findStreamed = (query: string) =>
      rpc["orchestration.searchThreadStream"]({ threadId: THREAD, query }).pipe(Stream.runCollect);

    // A right guess of the value, or of a piece of it, finds no more than a wrong one does.
    for (const guess of [
      STRIPE_KEY,
      STRIPE_KEY.slice(0, 20),
      STRIPE_KEY.slice(10),
      "sk_test_51Nz",
    ]) {
      const found = yield* find(guess);
      assert.deepEqual([found.totalMatches, found.match], [0, null], guess);
      const streamed = yield* findStreamed(guess);
      assert.deepEqual(
        streamed.map((frame) => [frame.totalMatches, frame.match]),
        [[0, null]],
        guess,
      );
    }
    // A find counts what the reader is shown: the words around the value, and its mask.
    assert.equal((yield* find("staging")).totalMatches, 2);
    assert.equal((yield* find(MASKED)).totalMatches, 2);
    assert.deepEqual((yield* findStreamed(MASKED)).at(-1)?.match, {
      entryId: "message:quoted",
      runId: RUN,
      occurrence: 0,
    });
  }),
);

/** Threads named after the message that started them: one pasted a key into its first line. */
const seedTitledThreads = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  for (const [id, archivedAt] of [
    ["thread:titled-active", null],
    ["thread:titled-archived", now],
  ] as const) {
    const threadId = ThreadId.make(id);
    yield* projections.apply({
      id: EventId.make(`event:${id}`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId: PROJECT,
        title: `Charge with ${STRIPE_KEY}`,
        providerInstanceId: claudeAgent,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
  }
});

it.live("a launch and the thread lists over /ws never carry a secret value", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(searchable);
    yield* Effect.all([seedProject, seedLeakyThread, seedTitledThreads]).pipe(
      Effect.provide(services),
    );
    const store = Context.get(services, ProjectionStore.ProjectionStoreV2);
    const enrichment = yield* PubSub.unbounded<never>();
    const reads = Context.mergeAll(
      services,
      Context.make(
        ServerRuntimeStartup.ServerRuntimeStartup,
        stubService({ enqueueCommand: (effect: unknown) => effect }),
      ),
      // Launching onto the existing thread answers with its projection, the failed Bash call's error in it.
      Context.make(
        ThreadLaunchService.ThreadLaunchService,
        stubService({
          launch: () =>
            store.getThreadSnapshot(THREAD).pipe(
              Effect.orDie,
              Effect.map(({ projection }) => ({ threadId: THREAD, projection, resumed: true })),
            ),
        }),
      ),
      Context.make(
        OrchestrationEventStore.OrchestrationEventStore,
        stubService({
          latestApplicationSequence: Effect.succeed(0),
          streamProjectedApplicationEvents: () => Stream.never,
        }),
      ),
      Context.make(
        ProjectEnrichmentService.ProjectEnrichmentService,
        stubService({
          subscribeChanges: PubSub.subscribe(enrichment),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: true,
            }),
        }),
      ),
    );
    const rpc = yield* wsClient(
      yield* serveWs({
        scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        scrubber,
        services: reads,
      }),
    );

    const launched = yield* rpc["orchestration.launchThread"]({
      commandId: CommandId.make("command:launch"),
      threadId: THREAD,
      reuseExistingThread: true,
      projectId: PROJECT,
      title: "Deploy",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    });
    const firstOf = <A, E>(stream: Stream.Stream<A, E>) =>
      stream.pipe(Stream.take(1), Stream.runCollect);
    const shell = yield* firstOf(rpc["orchestration.subscribeShell"]({}));
    const archivedShell = yield* firstOf(rpc["orchestration.subscribeArchivedShell"]({}));
    const archived = yield* rpc["orchestration.getArchivedShellSnapshot"]({});

    const read = { launched, shell, archivedShell, archived };
    // The reads carry what they are for: the failed call's error, and each thread by its title.
    assert.include(JSON.stringify(launched), "missing script: deploy");
    assert.include(JSON.stringify(shell), "thread:titled-active");
    for (const listed of [archivedShell, archived])
      assert.include(JSON.stringify(listed), "thread:titled-archived");
    for (const [name, value] of Object.entries(read)) {
      assert.include(JSON.stringify(value), MASKED, name);
      assert.notInclude(JSON.stringify(value), STRIPE_KEY, name);
    }
  }),
);

/** Collects a stream's events in the background. */
const collect = <A, E>(stream: Stream.Stream<A, E>) =>
  Effect.gen(function* () {
    const events: Array<A> = [];
    yield* stream.pipe(
      Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
      Effect.forkScoped,
    );
    return events;
  });

const outputOf = (events: ReadonlyArray<TerminalEvent | TerminalAttachStreamEvent>) =>
  events.map((event) => (event.type === "output" ? event.data : "")).join("");

/** Waits for what a client has received to satisfy `condition`. */
const until = (condition: () => boolean) =>
  Effect.suspend(() => (condition() ? Effect.void : Effect.fail("not yet"))).pipe(
    Effect.retry(Schedule.spaced("10 millis")),
    Effect.timeout("5 seconds"),
  );

it.live(
  "a terminal over /ws never shows a secret value, split across output or in its scrollback",
  () =>
    Effect.gen(function* () {
      const { pty, services } = yield* terminalsOnFakePty();
      const rpc = yield* wsClient(
        yield* serveWs({
          scopes: [AuthTerminalOperateScope, AuthTerminalReadScope],
          scrubber,
          services,
        }),
      );
      const terminal = { threadId: "thread-1", terminalId: DEFAULT_TERMINAL_ID };

      const everyTerminal = yield* collect(rpc["subscribeTerminalEvents"]({}));
      const attached = yield* collect(
        rpc["terminal.attach"]({ ...terminal, cwd: process.cwd(), cols: 100, rows: 24 }),
      );
      yield* until(
        () =>
          attached.some((event) => event.type === "snapshot") &&
          everyTerminal.some((event) => event.type === "started"),
      );
      // `cat .env` as the PTY delivers it: the value cut across two reads.
      const pty1 = pty.processes[0]!;
      pty1.print(`$ cat .env\r\nSTRIPE_SECRET_KEY=${STRIPE_KEY.slice(0, 13)}`);
      yield* Effect.sleep("100 millis");
      pty1.print(`${STRIPE_KEY.slice(13)}\r\nNODE_ENV=production\r\n$ `);
      yield* until(
        () => outputOf(attached).endsWith("$ ") && outputOf(everyTerminal).endsWith("$ "),
      );

      // A client that comes later reads the same output from the scrollback.
      const observed = yield* collect(rpc["terminal.observe"](terminal));
      yield* until(() => observed.some((event) => event.type === "snapshot"));
      const scrollback = observed
        .flatMap((event) => (event.type === "snapshot" ? [event.snapshot.history] : []))
        .join("");

      const shown = `$ cat .env\r\nSTRIPE_SECRET_KEY=${MASKED}\r\nNODE_ENV=production\r\n$ `;
      assert.equal(outputOf(attached), shown);
      assert.equal(outputOf(everyTerminal), shown);
      assert.include(scrollback, `STRIPE_SECRET_KEY=${MASKED}`);
      assert.include(scrollback, "NODE_ENV=production");
      assert.notInclude(scrollback, STRIPE_KEY.slice(0, 13));
      assert.notInclude(scrollback, STRIPE_KEY.slice(13));
    }),
);

it.live(
  "a client following every terminal from between two reads that split a value never sees the value's rest",
  () =>
    Effect.gen(function* () {
      const { pty, services } = yield* terminalsOnFakePty();
      const rpc = yield* wsClient(
        yield* serveWs({
          scopes: [AuthTerminalOperateScope, AuthTerminalReadScope],
          scrubber,
          services,
        }),
      );
      const terminal = {
        threadId: "thread-1",
        terminalId: DEFAULT_TERMINAL_ID,
        cwd: process.cwd(),
        cols: 100,
        rows: 24,
      };
      const outputOn = (events: ReadonlyArray<TerminalEvent>, terminalId: string) =>
        outputOf(events.filter((event) => event.terminalId === terminalId));

      const early = yield* collect(rpc["subscribeTerminalEvents"]({}));
      yield* collect(rpc["terminal.attach"](terminal));
      yield* until(() => early.some((event) => event.type === "started"));
      const shell = pty.processes[0]!;
      shell.print(`$ cat .env\r\nSTRIPE_SECRET_KEY=${STRIPE_KEY.slice(0, 13)}`);
      yield* until(() => outputOn(early, terminal.terminalId).endsWith("STRIPE_SECRET_KEY="));

      // Another client starts following every terminal now. Another terminal's output says its subscription is live.
      const late = yield* collect(rpc["subscribeTerminalEvents"]({}));
      yield* collect(rpc["terminal.attach"]({ ...terminal, terminalId: "other" }));
      yield* until(() => pty.processes.length === 2);
      yield* Effect.suspend(() => {
        pty.processes[1]!.print(".");
        return outputOn(late, "other") === "" ? Effect.fail("not yet") : Effect.void;
      }).pipe(Effect.retry(Schedule.spaced("10 millis")), Effect.timeout("5 seconds"));

      shell.print(`${STRIPE_KEY.slice(13)}\r\nNODE_ENV=production\r\n$ `);
      yield* until(
        () =>
          outputOn(late, terminal.terminalId).endsWith("$ ") &&
          outputOn(early, terminal.terminalId).endsWith("$ "),
      );

      assert.equal(
        outputOn(early, terminal.terminalId),
        `$ cat .env\r\nSTRIPE_SECRET_KEY=${MASKED}\r\nNODE_ENV=production\r\n$ `,
      );
      assert.equal(outputOn(late, terminal.terminalId), `${MASKED}\r\nNODE_ENV=production\r\n$ `);
    }),
);
