// ), apps/server/src/orchestration-v2/ThreadSearch.test.ts @ ab3a3cd1.
import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@caveman-app/protocol";
import { createScrubber } from "@caveman-app/session-protocol";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Tracer from "effect/Tracer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadSearch from "./ThreadSearch.ts";

/** A value pasted into a chat before it was stored as a secret. */
const STRIPE_KEY = ("sk_" + "live_51NcQ7xZ9wTqLm3Rb8KvYp2Hd");
const secrets = Layer.mock(ProjectSecrets)({
  scrubber: Effect.succeed(createScrubber([{ name: "STRIPE_SECRET_KEY", value: STRIPE_KEY }])),
});

const layerTest = Layer.mergeAll(
  ThreadSearch.layer.pipe(Layer.provide(secrets)),
  ProjectionStoreWithV1.layer,
  ProjectStore.layer,
).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 8, 27, 0, minute));

const createProject = (projectId: ProjectId) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title: projectId,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const thread = (
  threadId: ThreadId,
  projectId: ProjectId,
  overrides: { readonly archivedAt?: DateTime.Utc; readonly deletedAt?: DateTime.Utc } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: threadId,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
  },
});

const message = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly minute?: number; readonly streaming?: boolean } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`message:${id}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: role === "user" ? "user" : "agent",
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.layer(layerTest)("ThreadSearch", (it) => {
  it.effect("returns one finished user or assistant match per active thread", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search");
      const deletedProject = ProjectId.make("project:search-deleted");
      yield* createProject(project);
      yield* createProject(deletedProject);
      yield* Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
        projects.apply({
          sequence: 0,
          eventId: EventId.make("deleted:project"),
          aggregateKind: "project",
          aggregateId: deletedProject,
          occurredAt: DateTime.formatIso(at(2)),
          commandId: null,
          causationEventId: null,
          correlationId: null,
          metadata: {},
          type: "project.deleted",
          payload: { projectId: deletedProject, deletedAt: DateTime.formatIso(at(2)) },
        }),
      );

      const both = ThreadId.make("thread:both");
      const assistantOnly = ThreadId.make("thread:assistant");
      const events: ReadonlyArray<OrchestrationV2DomainEvent> = [
        thread(both, project),
        message(both, "both-assistant", "assistant", "needle from the answer", { minute: 3 }),
        message(both, "both-user-old", "user", "older needle question", { minute: 1 }),
        message(both, "both-user-new", "user", "newer needle question", { minute: 2 }),
        thread(assistantOnly, project),
        message(assistantOnly, "assistant-only", "assistant", "needle in an answer"),
        message(assistantOnly, "assistant-streaming", "user", "needle still typing", {
          streaming: true,
        }),
        message(assistantOnly, "assistant-system", "system", "needle system prompt"),
        thread(ThreadId.make("thread:archived"), project, { archivedAt: at(1) }),
        message(ThreadId.make("thread:archived"), "archived", "user", "needle archived"),
        thread(ThreadId.make("thread:deleted"), project, { deletedAt: at(1) }),
        message(ThreadId.make("thread:deleted"), "deleted", "user", "needle deleted"),
        thread(ThreadId.make("thread:orphaned"), deletedProject),
        message(ThreadId.make("thread:orphaned"), "orphaned", "user", "needle orphaned"),
      ];
      yield* Effect.forEach(events, projections.apply, { discard: true });

      const result = yield* search.search({ query: "NEEDLE", limit: 20 });
      assert.deepEqual(
        result.matches.map((match) => [match.threadId, match.source, match.snippet]),
        [
          [both, "user", "newer needle question"],
          [assistantOnly, "assistant", "needle in an answer"],
        ],
      );
      assert.lengthOf((yield* search.search({ query: "needle", limit: 1 })).matches, 1);
      // LIKE wildcards in the query match literally.
      assert.deepEqual((yield* search.search({ query: "ne%le" })).matches, []);
    }),
  );

  it.effect("matches and cuts snippets on the text with secret values masked", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-secrets");
      yield* createProject(project);
      const pasted = ThreadId.make("thread:pasted");
      const mentioned = ThreadId.make("thread:mentioned");
      const edge = ThreadId.make("thread:edge");
      yield* Effect.forEach(
        [
          thread(pasted, project),
          message(pasted, "pasted", "user", `here is the key: ${STRIPE_KEY}`),
          thread(mentioned, project),
          // Its best match holds the value; an older one names the key's prefix in its own words.
          message(mentioned, "mentioned-old", "assistant", "live keys start with sk_live_51N", {
            minute: 1,
          }),
          message(mentioned, "mentioned-key", "user", `try ${STRIPE_KEY} instead`, { minute: 2 }),
          thread(edge, project),
          message(
            edge,
            "edge",
            "assistant",
            `${"x".repeat(68)} haystack ${"y".repeat(137)} ${STRIPE_KEY} ${"z".repeat(100)}`,
          ),
        ],
        projections.apply,
        { discard: true },
      );

      // A guessed piece of the value finds nothing it would not find in the masked text.
      assert.deepEqual((yield* search.search({ query: STRIPE_KEY.slice(0, 16) })).matches, []);
      assert.deepEqual(
        (yield* search.search({ query: "sk_live_51N" })).matches.map((match) => [
          match.threadId,
          match.snippet,
        ]),
        [[mentioned, "live keys start with sk_live_51N"]],
      );
      assert.deepEqual(
        (yield* search.search({ query: "here is the key" })).matches.map((match) => match.snippet),
        ["here is the key: [secret:STRIPE_SECRET_KEY]"],
      );
      // The snippet's window ends 20 characters into where the value was: it cuts the mask, never the value.
      const [cut] = (yield* search.search({ query: "haystack" })).matches;
      assert.equal(cut?.threadId, edge);
      assert.isAtMost(cut!.snippet.length, 240);
      assert.isTrue(cut!.snippet.endsWith(" [secret:STRIPE_SECRE…"));
    }),
  );

  it.effect("a value repeated through one thread costs a few scans, not one per message", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const project = ProjectId.make("project:search-echoed");
      yield* createProject(project);
      const echoed = ThreadId.make("thread:echoed");
      const plain = ThreadId.make("thread:plain");
      yield* Effect.forEach(
        [
          thread(echoed, project),
          // The key pasted again and again; the thread's one match in its own words ranks below every paste.
          ...Array.from({ length: 40 }, (_, i) =>
            message(echoed, `echoed-${i}`, "user", `retry with ${STRIPE_KEY}`, { minute: i + 2 }),
          ),
          message(echoed, "echoed-words", "assistant", "sk_live keys are for production", {
            minute: 1,
          }),
          thread(plain, project),
          message(plain, "plain", "user", "which sk_live key is current?"),
        ],
        projections.apply,
        { discard: true },
      );

      const scans: Array<string> = [];
      const tracer = Tracer.make({
        span(options) {
          const span = new Tracer.NativeSpan(options);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            end(endTime, exit);
            const query = span.attributes.get("db.query.text");
            if (typeof query === "string" && query.includes("orchestration_v2_projection_messages"))
              scans.push(query);
          };
          return span;
        },
      });
      const { matches } = yield* search
        .search({ query: "sk_live" })
        .pipe(Effect.withTracer(tracer));
      assert.deepEqual(
        matches
          .flatMap((match) =>
            match.projectId === project ? [[match.threadId, match.snippet]] : [],
          )
          .sort(),
        [
          [echoed, "sk_live keys are for production"],
          [plain, "which sk_live key is current?"],
        ],
      );
      assert.isAtMost(scans.length, 3);
    }),
  );

  it.effect("reports an unreadable match as a decode failure", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-corrupt");
      const threadId = ThreadId.make("thread:corrupt");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "corrupt", "user", "20260927")],
        projections.apply,
        { discard: true },
      );
      yield* sql`
        UPDATE orchestration_v2_projection_messages
        SET payload_json = json_set(payload_json, '$.text', 20260927)
        WHERE message_id = 'corrupt'
      `;

      const error = yield* Effect.flip(search.search({ query: "0260927" }));
      assert.equal(error.operation, "decode");
    }),
  );
});

it.effect("searches on the reader worker while the writer is busy", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-search-" });
    const layerFile = Layer.mergeAll(
      ThreadSearch.layer.pipe(Layer.provide(secrets)),
      ProjectionStoreWithV1.layer,
      ProjectStore.layer,
    ).pipe(
      Layer.provideMerge(SqlitePersistence.layerFromPath(path.join(directory, "state.sqlite"))),
      Layer.provide(NodeServices.layer),
    );

    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const search = yield* ThreadSearch.ThreadSearch;
      const sql = yield* SqlClient.SqlClient;
      const project = ProjectId.make("project:search-reader");
      const threadId = ThreadId.make("thread:reader");
      yield* createProject(project);
      yield* Effect.forEach(
        [thread(threadId, project), message(threadId, "reader", "user", "needle on the reader")],
        projections.apply,
        { discard: true },
      );

      // A write transaction holds the writer connection. A search on the writer would queue
      // behind it and never finish; one on the reader worker does not wait.
      const writerHeld = yield* Deferred.make<void>();
      const releaseWriter = yield* Deferred.make<void>();
      const writer = yield* Effect.forkChild(
        sql.withTransaction(
          Deferred.succeed(writerHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseWriter)),
          ),
        ),
      );
      yield* Deferred.await(writerHeld);
      const result = yield* search.search({ query: "needle" });
      yield* Deferred.succeed(releaseWriter, undefined);
      yield* Fiber.join(writer);

      assert.deepEqual(
        result.matches.map((match) => match.threadId),
        [threadId],
      );
    }).pipe(Effect.provide(layerFile));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
