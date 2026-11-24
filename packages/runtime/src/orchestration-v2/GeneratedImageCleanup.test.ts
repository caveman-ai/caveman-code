import * as fs from "node:fs";
import * as path from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId, EventId, MessageId, NodeId, ProjectId, ProviderInstanceId, RunId, ThreadId, TurnItemId,
  type OrchestrationV2AppThread, type OrchestrationV2TurnItem,
} from "@caveman-app/protocol";
import * as IdAllocator from "@caveman-app/engine-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { createAttachmentId, storedAttachmentFileNames } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { storeGeneratedImage } from "../generatedImage.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as AttachmentHistory from "./AttachmentHistory.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectionStoreWithV1 from "./legacy/ProjectionStoreWithV1.ts";
import * as ResourceCleanupService from "./ResourceCleanupService.ts";
import { planThreadDeletion } from "./ThreadDeletion.ts";

// Real raster persistence, production projections, deletion planner, SQLite
// outbox/leases/recovery, and production filesystem cleanup. No provider process
// or terminal/browser is involved in attachment deletion.
const database = SqlitePersistence.layerMemory;
const config = ServerConfig.layerTest(process.cwd(), { prefix: "generated image %20-cleanup-" }).pipe(
  Layer.provide(NodeServices.layer),
);
const layerTest = (storage: "sqlite" | "memory") => Layer.mergeAll(
  database,
  config,
  IdAllocator.layer,
  (storage === "sqlite" ? ProjectionStoreWithV1.layer : ProjectionStore.layerMemory).pipe(
    Layer.provide(Layer.merge(database, config)),
  ),
  EffectOutbox.layer.pipe(Layer.provide(database)),
  ResourceCleanupService.layer.pipe(Layer.provide(Layer.mergeAll(
    config,
    NodeServices.layer,
    Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
    Layer.mock(PreviewManager.PreviewManager)({ close: () => Effect.void }),
    Layer.mock(ScheduledTaskService.ScheduledTaskService)({ deleteForThread: () => Effect.void }),
  ))),
);
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGMIWFDxHwAFFAJo4L9/vgAAAABJRU5ErkJggg==";

it.effect.each(["sqlite", "memory"] as const)(
  "deletes only the owning chat's persisted generated images through deletion/outbox cleanup (%s)",
  (storage) => Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const { attachmentsDir, baseDir } = yield* ServerConfig.ServerConfig;
    const now = yield* DateTime.now;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const sql = yield* SqlClient.SqlClient;
    const source = ThreadId.make("image-source");
    const fork = ThreadId.make("image-source-fork");
    const unrelated = ThreadId.make("image-unrelated");
    const foreign = ThreadId.make("image-foreign");
    const runId = RunId.make("image-source-run");
    const instanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId, model: "test" };
    const makeThread = (id: ThreadId): OrchestrationV2AppThread => ({
      id, projectId: ProjectId.make("image-project"), title: id,
      providerInstanceId: instanceId, modelSelection, runtimeMode: "full-access", interactionMode: "default",
      branch: null, worktreePath: null, activeProviderThreadId: null,
      lineage: id === fork
        ? { parentThreadId: source, relationshipToParent: "fork", rootThreadId: source }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: id === fork ? { type: "run", threadId: source, runId } : null,
      createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
    });
    for (const threadId of [source, unrelated, foreign, fork]) {
      yield* store.apply({ id: EventId.make(`create:${threadId}`), type: "thread.created", threadId, occurredAt: now, payload: makeThread(threadId) });
    }
    yield* store.apply({
      id: EventId.make("source-run"), type: "run.created", threadId: source, runId, occurredAt: now,
      payload: {
        id: runId, threadId: source, ordinal: 1, providerInstanceId: instanceId, modelSelection,
        providerThreadId: null, userMessageId: MessageId.make("image-input"), rootNodeId: null,
        activeAttemptId: null, status: "completed", requestedAt: now, startedAt: now, completedAt: now,
        checkpointId: null, contextHandoffId: null,
      },
    });
    const save = (threadId: ThreadId) => Effect.promise(() => storeGeneratedImage(attachmentsDir, threadId, png));
    const singular = yield* save(source);
    const multiple = yield* save(source);
    const forkImage = yield* save(fork);
    const foreignImage = yield* save(foreign);
    const workspace = path.join(baseDir, "workspace");
    const sibling = `${attachmentsDir}-sibling`;
    fs.mkdirSync(workspace, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const arbitrary = [
      path.join(workspace, path.basename(singular)),
      path.join(sibling, path.basename(singular)),
      path.join(attachmentsDir, "provider-native.png"),
      singular.replace(/\.png$/, ".jpg"),
    ];
    for (const file of arbitrary) fs.writeFileSync(file, "provider-owned");
    const idOf = (file: string) => path.basename(file, path.extname(file));
    const publish = (threadId: ThreadId, name: string, output: unknown, toolName = "image_generation") => store.apply({
      id: EventId.make(`tool:${threadId}:${name}`), type: "turn-item.updated", threadId, occurredAt: now,
      payload: {
        id: TurnItemId.make(`tool:${threadId}:${name}`), threadId, runId: threadId === source ? runId : null,
        nodeId: null, providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
        ordinal: name === "native" ? 1 : 2, status: "completed", title: "Generate image",
        startedAt: now, completedAt: now, updatedAt: now, type: "dynamic_tool", toolName, input: {}, output,
      } satisfies OrchestrationV2TurnItem,
    });
    yield* publish(source, "native", { saved_path: singular });
    yield* publish(source, "dynamic", { saved_paths: [multiple, singular, foreignImage, ...arbitrary] });
    // The fork really inherits the source run and also explicitly references it.
    yield* publish(fork, "dynamic", { saved_path: singular, saved_paths: [multiple, forkImage] });
    yield* publish(unrelated, "native", { saved_path: singular, saved_paths: [multiple, foreignImage] });
    assert.isTrue((yield* store.getThreadProjection(fork)).visibleTurnItems.some((row) => row.visibility === "inherited" && row.item.id === `tool:${source}:native`));
    if (storage === "sqlite") {
      const persisted = yield* sql<{ output: string }>`SELECT json_extract(payload_json, '$.output.saved_path') AS output
        FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${`tool:${source}:native`}`;
      assert.equal(persisted[0]?.output, singular);
    }
    // Existing message attachments, html_render, and MCP documents still share
    // the same ID-only cleanup path.
    const regularId = createAttachmentId(source, "txt")!;
    const htmlId = createAttachmentId(source, "html")!;
    const appId = createAttachmentId(source, "html")!;
    const regularFiles = [`${regularId}.txt`, `${htmlId}.html`, `${appId}.html`].map((name) => path.join(attachmentsDir, name));
    for (const file of regularFiles) fs.writeFileSync(file, "stored attachment");
    yield* store.apply({
      id: EventId.make("message-attachment"), type: "message.updated", threadId: source, occurredAt: now,
      payload: {
        id: MessageId.make("message-attachment"), threadId: source, runId: null, nodeId: null, role: "user", text: "input",
        attachments: [{ type: "file", id: regularId, name: "input.txt", mimeType: "text/plain", sizeBytes: 17 }],
        streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      },
    });
    yield* publish(source, "html", [{ type: "text", text: JSON.stringify({ htmlRender: { attachmentId: htmlId, title: "page", height: 300 } }) }], "mcp__caveman-code__html_render");
    yield* publish(source, "mcp", { t3McpApp: { attachmentId: appId, server: "art", tool: "generate", resourceUri: "ui://art/result" } }, "art.generate");
    // While the fork lives it shows the run it inherited, so the files that run published stay;
    // the source's message outside any run is not in the fork's history.
    assert.deepEqual(new Set(yield* store.getThreadAttachmentIds(source)), new Set([regularId]));

    const deleteThread = Effect.fn(function* (threadId: ThreadId) {
      const command = { type: "thread.delete" as const, commandId: CommandId.make(`delete:${threadId}`), threadId };
      // Same narrow reads and production planner used by Orchestrator's entry point.
      const projection = yield* store.getThreadRecords(threadId, ["runs", "attempts", "nodes", "runtimeRequests", "subagents", "providerSessions"]);
      const plan = yield* planThreadDeletion({ command, projection, attachmentIds: yield* store.getThreadAttachmentIds(threadId), now, idAllocator });
      yield* sql.withTransaction(Effect.gen(function* () {
        for (const event of plan.events) yield* store.apply(event);
        yield* outbox.enqueue(plan.effects);
      }));
      assert.isNotNull((yield* store.getThread(threadId)).deletedAt);
      const effects = yield* outbox.listByCommandId(command.commandId);
      const attachment = effects.find((effect) => effect.request.type === "attachment.cleanup");
      let recovered = false;
      while (true) {
        const next = yield* outbox.claimNext({ workerId: "image-cleanup", leaseDurationMs: 60_000 });
        if (Option.isNone(next)) break;
        const effect = next.value;
        switch (effect.request.type) {
          case "scheduled-tasks.cleanup": yield* cleanup.cleanupScheduledTasks(effect.threadId); break;
          case "terminal.cleanup": yield* cleanup.cleanupTerminals(effect.threadId); break;
          case "preview.cleanup": yield* cleanup.cleanupPreviews(effect.threadId); break;
          case "engine-state.cleanup": yield* cleanup.cleanupEngineState(); break;
          case "attachment.cleanup":
            yield* cleanup.cleanupAttachments(effect.request.attachmentIds);
            if (threadId === source && !recovered) {
              // A real removal followed by process loss before acknowledgment.
              assert.isFalse(fs.existsSync(singular));
              assert.isFalse(fs.existsSync(multiple));
              assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
              recovered = true;
              continue;
            }
            break;
          default: assert.fail(`Unexpected deletion effect: ${effect.request.type}`);
        }
        assert.isTrue(yield* outbox.succeed({ effectId: effect.id, workerId: "image-cleanup" }));
      }
      if (attachment !== undefined) {
        const settled = Option.getOrThrow(yield* outbox.get(attachment.id));
        assert.equal(settled.status, "succeeded");
        assert.equal(settled.attemptCount, threadId === source ? 2 : 1);
      }
    });
    yield* deleteThread(unrelated);
    assert.isTrue(fs.existsSync(singular));
    assert.isTrue(fs.existsSync(multiple));
    yield* deleteThread(fork);
    assert.isFalse(fs.existsSync(forkImage));
    assert.isTrue(fs.existsSync(singular));
    assert.isTrue(fs.existsSync(multiple));
    yield* deleteThread(source);
    for (const file of [singular, multiple, ...regularFiles]) assert.isFalse(fs.existsSync(file), file);
    for (const file of [foreignImage, ...arbitrary]) assert.isTrue(fs.existsSync(file), file);
    assert.isNull((yield* store.getThread(foreign)).deletedAt);
  }).pipe(Effect.provide(layerTest(storage))),
);

it.effect.each(["sqlite", "memory"] as const)(
  "a chat's deletion takes only its own files, not another chat's that one of its messages names (%s)",
  (storage) => Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const owner = ThreadId.make("attachment-owner");
    const borrower = ThreadId.make("attachment-borrower");
    const instanceId = ProviderInstanceId.make("codex");
    for (const threadId of [owner, borrower]) {
      yield* store.apply({
        id: EventId.make(`create:${threadId}`), type: "thread.created", threadId, occurredAt: now,
        payload: {
          id: threadId, projectId: ProjectId.make("attachment-project"), title: threadId,
          providerInstanceId: instanceId, modelSelection: { instanceId, model: "test" },
          runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
          activeProviderThreadId: null,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
          forkedFrom: null, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
          archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
        },
      });
    }
    const ownId = createAttachmentId(borrower, "txt")!;
    const ownersId = createAttachmentId(owner, "txt")!;
    // Stored before claims refused another thread's attachment.
    yield* store.apply({
      id: EventId.make("borrowed-attachment"), type: "message.updated", threadId: borrower, occurredAt: now,
      payload: {
        id: MessageId.make("borrowed-attachment"), threadId: borrower, runId: null, nodeId: null,
        role: "user", text: "input",
        attachments: [
          { type: "file", id: ownId, name: "own.txt", mimeType: "text/plain", sizeBytes: 3 },
          { type: "file", id: ownersId, name: "owners.txt", mimeType: "text/plain", sizeBytes: 6 },
        ],
        streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      },
    });

    assert.deepEqual(yield* store.getThreadAttachmentIds(borrower), [ownId]);
  }).pipe(Effect.provide(layerTest(storage))),
);

it.effect.each(["sqlite", "memory"] as const)(
  "a migrated chat's deletion takes its own legacy files, never one another live chat names (%s)",
  (storage) => Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const instanceId = ProviderInstanceId.make("codex");
    const migrated = ThreadId.make("legacy-migrated");
    const sharer = ThreadId.make("legacy-sharer");
    const deleted = ThreadId.make("legacy-deleted");
    const thread = (threadId: ThreadId): OrchestrationV2AppThread => ({
      id: threadId, projectId: ProjectId.make("legacy-project"), title: threadId,
      providerInstanceId: instanceId, modelSelection: { instanceId, model: "test" },
      runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
    });
    const nameAttachments = (threadId: ThreadId, ids: ReadonlyArray<string>) => store.apply({
      id: EventId.make(`message:${threadId}`), type: "message.updated", threadId, occurredAt: now,
      payload: {
        id: MessageId.make(`message:${threadId}`), threadId, runId: null, nodeId: null,
        role: "user", text: "input",
        attachments: ids.map((id) => ({ type: "file" as const, id, name: `${id}.txt`, mimeType: "text/plain", sizeBytes: 1 })),
        streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      },
    });
    for (const threadId of [migrated, sharer, deleted]) {
      yield* store.apply({
        id: EventId.make(`create:${threadId}`), type: "thread.created", threadId, occurredAt: now,
        payload: thread(threadId),
      });
    }
    const foreign = createAttachmentId(sharer, "txt")!;
    // Ids from before ids named their thread, as a migrated transcript carries them.
    yield* nameAttachments(migrated, ["legacy_own", "legacy_shared", "legacy_was_shared", foreign]);
    yield* nameAttachments(sharer, ["LEGACY_SHARED"]);
    yield* nameAttachments(deleted, ["legacy_was_shared"]);
    yield* store.apply({
      id: EventId.make(`delete:${deleted}`), type: "thread.deleted", threadId: deleted, occurredAt: now,
      payload: { ...thread(deleted), deletedAt: now },
    });

    assert.deepEqual(
      [...(yield* store.getThreadAttachmentIds(migrated))].sort(),
      ["legacy_own", "legacy_was_shared"],
    );

    if (storage === "sqlite") {
      // A migrated chat whose transcript is not imported yet names its files only in V1.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
        VALUES ('legacy-pending', ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}, NULL)`;
      yield* sql`INSERT INTO projection_thread_messages
        (message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at)
        VALUES
          ('legacy-pending:1', 'legacy-pending', NULL, 'user', 'q',
            '[{"type":"file","id":"legacy_own","name":"own.txt","mimeType":"text/plain","sizeBytes":1}]',
            0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)}),
          ('legacy-pending:2', 'legacy-pending', NULL, 'user', 'q', 'not json',
            0, ${DateTime.formatIso(now)}, ${DateTime.formatIso(now)})`;
      assert.deepEqual(yield* store.getThreadAttachmentIds(migrated), ["legacy_was_shared"]);
    }
  }).pipe(Effect.provide(layerTest(storage))),
);

it.effect.each(["sqlite", "memory"] as const)(
  "a migrated chat's file stays while a live fork inherits it, and goes with the last chat that does (%s)",
  (storage) => Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const instanceId = ProviderInstanceId.make("codex");
    const source = ThreadId.make("inherit-source");
    const fork = ThreadId.make("inherit-fork");
    const forkRun = RunId.make("inherit-run-1");
    const laterRun = RunId.make("inherit-run-2");
    const thread = (threadId: ThreadId, extra: Partial<OrchestrationV2AppThread> = {}): OrchestrationV2AppThread => ({
      id: threadId, projectId: ProjectId.make("inherit-project"), title: threadId,
      providerInstanceId: instanceId, modelSelection: { instanceId, model: "test" },
      runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
      ...extra,
    });
    const sourceThread = thread(source, { historyOrigin: "v1_import" });
    for (const created of [
      sourceThread,
      thread(fork, { forkedFrom: { type: "run", threadId: source, runId: forkRun } }),
    ]) {
      yield* store.apply({
        id: EventId.make(`create:${created.id}`), type: "thread.created", threadId: created.id,
        occurredAt: now, payload: created,
      });
    }
    for (const [runId, ordinal] of [[forkRun, 1], [laterRun, 2]] as const) {
      yield* store.apply({
        id: EventId.make(`run:${runId}`), type: "run.updated", threadId: source, runId, occurredAt: now,
        payload: {
          id: runId, threadId: source, ordinal, providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" }, providerThreadId: null,
          userMessageId: MessageId.make(`message:${runId}`), rootNodeId: NodeId.make(`node:${runId}`),
          activeAttemptId: null, status: "completed", requestedAt: now, startedAt: now,
          completedAt: now, checkpointId: null, contextHandoffId: null,
        },
      });
    }
    // The imported message (no run) is in the fork's history; a resend after the fork run is not.
    for (const [messageId, runId, id] of [
      ["inherit-imported", null, "legacy_imported"],
      ["inherit-late", laterRun, "legacy_late"],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`message:${messageId}`), type: "message.updated", threadId: source, occurredAt: now,
        payload: {
          id: MessageId.make(messageId), threadId: source, runId, nodeId: null, role: "user", text: "input",
          attachments: [{ type: "file", id, name: `${id}.txt`, mimeType: "text/plain", sizeBytes: 1 }],
          streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
        },
      });
    }

    assert.deepEqual(yield* store.getThreadAttachmentIds(source), ["legacy_late"]);
    assert.deepEqual(yield* store.getThreadAttachmentIds(fork), []);
    yield* store.apply({
      id: EventId.make(`delete:${source}`), type: "thread.deleted", threadId: source, occurredAt: now,
      payload: { ...sourceThread, deletedAt: now },
    });
    assert.deepEqual(yield* store.getThreadAttachmentIds(fork), ["legacy_imported"]);
  }).pipe(Effect.provide(layerTest(storage))),
);

const historyThread = (
  now: DateTime.Utc,
  threadId: ThreadId,
  extra: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread => {
  const instanceId = ProviderInstanceId.make("codex");
  return {
    id: threadId, projectId: ProjectId.make("history-project"), title: threadId,
    providerInstanceId: instanceId, modelSelection: { instanceId, model: "test" },
    runtimeMode: "full-access", interactionMode: "default", branch: null, worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
    archivedAt: null, settledOverride: null, settledAt: null, lastVisitedAt: null, deletedAt: null,
    ...extra,
  };
};

it.effect.each(["sqlite", "memory"] as const)(
  "a source chat's minted files stay while a live fork shows them, and go with the last chat that does (%s)",
  (storage) => Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const instanceId = ProviderInstanceId.make("codex");
    const source = ThreadId.make("minted-source");
    const fork = ThreadId.make("minted-fork");
    const forkRun = RunId.make("minted-run-1");
    const laterRun = RunId.make("minted-run-2");
    const sourceThread = historyThread(now, source);
    for (const created of [
      sourceThread,
      historyThread(now, fork, { forkedFrom: { type: "run", threadId: source, runId: forkRun } }),
    ]) {
      yield* store.apply({
        id: EventId.make(`create:${created.id}`), type: "thread.created", threadId: created.id,
        occurredAt: now, payload: created,
      });
    }
    for (const [runId, ordinal] of [[forkRun, 1], [laterRun, 2]] as const) {
      yield* store.apply({
        id: EventId.make(`run:${runId}`), type: "run.updated", threadId: source, runId, occurredAt: now,
        payload: {
          id: runId, threadId: source, ordinal, providerInstanceId: instanceId,
          modelSelection: { instanceId, model: "test" }, providerThreadId: null,
          userMessageId: MessageId.make(`message:${runId}`), rootNodeId: NodeId.make(`node:${runId}`),
          activeAttemptId: null, status: "completed", requestedAt: now, startedAt: now,
          completedAt: now, checkpointId: null, contextHandoffId: null,
        },
      });
    }
    const shot = createAttachmentId(source, "png")!;
    const late = createAttachmentId(source, "png")!;
    const page = createAttachmentId(source, "html")!;
    for (const [messageId, runId, id] of [["minted-shot", forkRun, shot], ["minted-late", laterRun, late]] as const) {
      yield* store.apply({
        id: EventId.make(`message:${messageId}`), type: "message.updated", threadId: source, occurredAt: now,
        payload: {
          id: MessageId.make(messageId), threadId: source, runId, nodeId: null, role: "user", text: "input",
          attachments: [{ type: "image", id, name: "shot.png", mimeType: "image/png", sizeBytes: 1 }],
          streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
        },
      });
    }
    // A page the source run published: the fork's view shows that item too.
    yield* store.apply({
      id: EventId.make("minted-page"), type: "turn-item.updated", threadId: source, occurredAt: now,
      payload: {
        id: TurnItemId.make("minted-page"), threadId: source, runId: forkRun, nodeId: null,
        providerThreadId: null, providerTurnId: null, nativeItemRef: null, parentItemId: null,
        ordinal: 1, status: "completed", title: "Render", startedAt: now, completedAt: now, updatedAt: now,
        type: "dynamic_tool", toolName: "mcp__caveman-code__html_render", input: {},
        output: [{ type: "text", text: JSON.stringify({ htmlRender: { attachmentId: page, title: "page", height: 300 } }) }],
      } satisfies OrchestrationV2TurnItem,
    });

    assert.deepEqual(yield* store.getThreadAttachmentIds(source), [late]);
    assert.deepEqual(yield* store.getThreadAttachmentIds(fork), []);
    yield* store.apply({
      id: EventId.make(`delete:${source}`), type: "thread.deleted", threadId: source, occurredAt: now,
      payload: { ...sourceThread, deletedAt: now },
    });
    assert.deepEqual(new Set(yield* store.getThreadAttachmentIds(fork)), new Set([shot, page]));
  }).pipe(Effect.provide(layerTest(storage))),
);

it.effect.each(["sqlite", "memory"] as const)(
  "deleting a migrated chat removes its documents from disk, not only its images (%s)",
  (storage) => Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const cleanup = yield* ResourceCleanupService.ResourceCleanupService;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const { attachmentsDir } = yield* ServerConfig.ServerConfig;
    const now = yield* DateTime.now;
    const migrated = ThreadId.make("disk-migrated");
    yield* store.apply({
      id: EventId.make("create:disk-migrated"), type: "thread.created", threadId: migrated, occurredAt: now,
      payload: historyThread(now, migrated, { historyOrigin: "v1_import" }),
    });
    yield* store.apply({
      id: EventId.make("message:disk-migrated"), type: "message.updated", threadId: migrated, occurredAt: now,
      payload: {
        id: MessageId.make("message:disk-migrated"), threadId: migrated, runId: null, nodeId: null,
        role: "user", text: "a report and a screenshot",
        attachments: [
          { type: "file", id: "legacy_doc", name: "report.pdf", mimeType: "application/pdf", sizeBytes: 3 },
          { type: "image", id: "legacy_shot", name: "shot.png", mimeType: "image/png", sizeBytes: 3 },
        ],
        streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      },
    });
    fs.mkdirSync(attachmentsDir, { recursive: true });
    const file = (name: string) => path.join(attachmentsDir, name);
    const own = ["legacy_doc.pdf", "legacy_doc.pdf.txt", "legacy_shot.png"];
    const bystanders = ["legacy_docs.pdf", "legacy_doc2.pdf", "other.pdf"];
    for (const name of [...own, ...bystanders]) fs.writeFileSync(file(name), "bytes");

    const command = { type: "thread.delete" as const, commandId: CommandId.make("delete:disk"), threadId: migrated };
    const projection = yield* store.getThreadRecords(migrated, ["runs", "attempts", "nodes", "runtimeRequests", "subagents", "providerSessions"]);
    const plan = yield* planThreadDeletion({ command, projection, attachmentIds: yield* store.getThreadAttachmentIds(migrated), now, idAllocator });
    const request = plan.effects.find((effect) => effect.request.type === "attachment.cleanup")?.request;
    assert.deepEqual(request?.type === "attachment.cleanup" ? [...request.attachmentIds].sort() : [], ["legacy_doc", "legacy_shot"]);
    yield* cleanup.cleanupAttachments(request?.type === "attachment.cleanup" ? request.attachmentIds : []);

    for (const name of own) assert.isFalse(fs.existsSync(file(name)), name);
    for (const name of bystanders) assert.isTrue(fs.existsSync(file(name)), name);
    // A differently cased file of the same id goes too: no live chat named any of them.
    assert.deepEqual(
      storedAttachmentFileNames(["LEGACY_DOC.PDF", "legacy_doc.pdf.txt", "legacy_doc.pdf.part", "legacy_docs.pdf"], "legacy_doc"),
      ["LEGACY_DOC.PDF", "legacy_doc.pdf.txt"],
    );
  }).pipe(Effect.provide(layerTest(storage))),
);

// An import that completes while the store reads still leaves the thread's files named: the store
// reads pending V1 transcripts before V2 messages, and an import writes V2 before marking itself.
it.effect("a transcript imported between the reads still keeps its files", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    const deleted = ThreadId.make("race-deleted");
    const imported = ThreadId.make("race-imported");
    for (const threadId of [deleted, imported]) {
      yield* store.apply({
        id: EventId.make(`create:${threadId}`), type: "thread.created", threadId, occurredAt: now,
        payload: historyThread(now, threadId, { historyOrigin: "v1_import" }),
      });
    }
    yield* store.apply({
      id: EventId.make("message:race-deleted"), type: "message.updated", threadId: deleted, occurredAt: now,
      payload: {
        id: MessageId.make("message:race-deleted"), threadId: deleted, runId: null, nodeId: null,
        role: "user", text: "shared", attachments: [{ type: "image", id: "legacy_race", name: "r.png", mimeType: "image/png", sizeBytes: 1 }],
        streaming: false, createdBy: "user", creationSource: "web", createdAt: now, updatedAt: now,
      },
    });
    assert.deepEqual(yield* store.getThreadAttachmentIds(deleted), []);
  }).pipe(
    Effect.provide(Layer.mergeAll(
      database,
      config,
      ProjectionStore.layer.pipe(
        // The other thread's import completes during the read of every thread's pending transcript:
        // its V2 message is written and its V1 transcript is no longer pending.
        Layer.provide(Layer.effect(AttachmentHistory.PendingTranscriptAttachments, Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            namings: (input) => input.threadIds !== null ? Effect.succeed([]) : sql`
              INSERT OR IGNORE INTO orchestration_v2_projection_messages
                (message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at, payload_json)
              VALUES ('race-imported:1', 'race-imported', NULL, NULL, 'user', 0, '2026-01-01T00:00:00.000Z',
                '2026-01-01T00:00:00.000Z', json_object('attachments', json_array(json_object('id', 'legacy_race'))))
            `.pipe(Effect.as([])),
          };
        }))),
        Layer.provide(Layer.merge(database, config)),
      ),
    )),
  ),
);
