// What the orchestration HTTP API (/api/orchestration/*) sends a client: never a repository secret's value
// (16-SECRETS), as the /ws route's reads of the same projections (ws.secrets.test.ts).
import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_VERSION,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@caveman-app/protocol";
import { createScrubber } from "@caveman-app/session-protocol";
import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { Etag, HttpRouter } from "effect/http";

import * as OrchestrationEventStore from "../persistence/OrchestrationEventStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as OrchestrationHttp from "./http.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const STRIPE_KEY = ("sk_" + "test_51NzQx2LkP0aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0u");
const scrubber = createScrubber([
  { name: "OPENAI_API_KEY", value: ("sk-" + "proj-7Qx9vL2mZp4tR8wYbN3kD6fH1jS5aC0e") },
  { name: "STRIPE_SECRET_KEY", value: STRIPE_KEY },
]);
const MASKED = "[secret:STRIPE_SECRET_KEY]";
/** What `cat .env` printed. */
const ENV_FILE = `STRIPE_SECRET_KEY=${STRIPE_KEY}\nNODE_ENV=production\n`;

const claudeAgent = ProviderInstanceId.make("claudeAgent");
const driver = ProviderDriverKind.make("claudeAgent");
const modelSelection = {
  instanceId: claudeAgent,
  model: "claude-sonnet-4-5",
} satisfies ModelSelection;
const PROJECT = ProjectId.make("project:http-secrets");
const THREAD = ThreadId.make("thread:http-secrets");
const TITLED = ThreadId.make("thread:http-secrets:titled");
const RUN = RunId.make("run:http-secrets");
const NODE = NodeId.make("node:http-secrets");

const store = Layer.mergeAll(
  ProjectionStoreWithV1.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

/** ThreadManagementService passes the reads through to the real projections, as its own reads do. */
const management = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return Layer.mock(ThreadManagementService.ThreadManagementService)({
      ensureLegacyTranscript: () => Effect.void,
      getThreadSnapshot: (id) => projections.getThreadSnapshot(id).pipe(Effect.orDie),
      getThreadSnapshotWindow: (id, options) =>
        projections.getThreadSnapshotWindow(id, options).pipe(Effect.orDie),
      getThreadHistoryPage: (...args) =>
        projections.getThreadHistoryPage(...args).pipe(Effect.orDie),
      readShellSnapshot: (options) =>
        projections.readShellSnapshot(options).pipe(Effect.map(Effect.orDie), Effect.orDie),
      streamStoredEventsFrom: () => Stream.empty,
    });
  }),
);

const thread = (id: ThreadId, title: string, at: DateTime.Utc) =>
  ({
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: at,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId: PROJECT,
      title,
      providerInstanceId: claudeAgent,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  }) as const;

/**
 * A Claude Agent thread whose agent printed the .env in a Bash call that failed (Claude Agent reports no exit code,
 * so the row keeps its error text on the wire), and a thread named after a first line that pasted the key.
 */
const seed = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* projections.apply(thread(THREAD, "Deploy", now));
  yield* projections.apply(thread(TITLED, `Charge with ${STRIPE_KEY}`, now));
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
      userMessageId: MessageId.make("message:http-secrets"),
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
  const failed: OrchestrationV2TurnItem = {
    id: TurnItemId.make("item:deploy"),
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "failed",
    title: "cat .env && npm run deploy",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "command_execution",
    input: "cat .env && npm run deploy",
    output: `${ENV_FILE}npm ERR! missing script: deploy`,
  };
  yield* projections.apply({
    id: EventId.make("event:item-deploy"),
    type: "turn-item.updated",
    threadId: THREAD,
    runId: RUN,
    nodeId: NODE,
    driver,
    occurredAt: now,
    payload: failed,
  });
});

const TestLayer = Layer.mergeAll(
  management,
  Layer.effectDiscard(seed),
  Layer.mock(OrchestrationEventStore.OrchestrationEventStore)({
    latestApplicationSequence: Effect.succeed(0),
  }),
  Layer.mock(ProjectStore.ProjectStoreV2)({ listShells: () => Effect.succeed([]) }),
  Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({}),
  Layer.mock(ProjectSecrets)({ scrubber: Effect.succeed(scrubber) }),
).pipe(Layer.provideMerge(store));

class OrchestrationApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.orchestration,
) {}

/** An environment session that may read orchestration, and nothing else. */
const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
  effect.pipe(
    Effect.provideService(EnvironmentAuthenticatedPrincipal, {
      sessionId: AuthSessionId.make("http-secrets"),
      subject: "http-secrets",
      method: "browser-session-cookie",
      scopes: new Set([AuthOrchestrationReadScope]),
    }),
  ),
);

const withHttp = <A>(use: (get: (path: string) => Promise<Response>) => Promise<A>) =>
  Effect.gen(function* () {
    const context = yield* Effect.context<Layer.Success<typeof TestLayer>>();
    const appLayer = HttpApiBuilder.layer(OrchestrationApi).pipe(
      Layer.provide(OrchestrationHttp.layer),
      Layer.provide(auth),
      Layer.provide(Layer.succeedContext(context)),
      Layer.provide(NodeHttpPlatform.layer),
      Layer.provide(Etag.layerWeak),
      Layer.provide(NodeServices.layer),
    );
    return yield* Effect.acquireUseRelease(
      Effect.sync(() => HttpRouter.toWebHandler(appLayer, { disableLogger: true })),
      ({ handler }) =>
        Effect.promise(() =>
          use((path) =>
            handler(
              new Request(`http://environment.test${path}`, {
                headers: {
                  [ORCHESTRATION_PROTOCOL_HEADER]: String(ORCHESTRATION_PROTOCOL_VERSION),
                },
              }),
            ),
          ),
        ),
      ({ dispose }) => Effect.promise(() => dispose()),
    );
  });

it.layer(TestLayer)("orchestration HTTP API", (it) => {
  it.effect("a thread or shell read over HTTP never carries a secret value", () =>
    withHttp(async (get) => {
      const thread = `/api/orchestration/threads/${encodeURIComponent(THREAD)}`;
      // Older than everything in the thread, so the page holds all of it.
      const cursor = encodeThreadHistoryCursor({
        snapshotSequence: 0,
        sourceThreadId: THREAD,
        sourceItemId: "end",
        position: 100,
      });
      const reads: Record<string, string> = {};
      for (const [name, path] of [
        ["shell", "/api/orchestration/shell"],
        ["thread", thread],
        ["bounded", `${thread}/bounded`],
        ["compact bounded", `${thread}/bounded?compactTurnItems=1`],
        ["history", `${thread}/history?cursor=${encodeURIComponent(cursor)}`],
      ] as const) {
        const response = await get(path);
        assert.equal(response.status, 200, name);
        reads[name] = await response.text();
      }
      // The reads carry what they are for: the failed call's error, and each thread by its title.
      assert.include(reads.shell, TITLED);
      for (const name of ["thread", "bounded", "compact bounded", "history"]) {
        assert.include(reads[name], "missing script: deploy", name);
      }
      const unmasked = Object.entries(reads).flatMap(([name, body]) =>
        body.includes(STRIPE_KEY) || !body.includes(MASKED) ? [name] : [],
      );
      assert.deepEqual(unmasked, []);
    }),
  );
});
