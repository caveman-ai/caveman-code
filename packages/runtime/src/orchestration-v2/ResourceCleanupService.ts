// ), apps/server/src/orchestration-v2/ResourceCleanupService.ts @ ab3a3cd1.
import { ThreadId } from "@caveman-app/protocol";
import { CAVEMAN_PROVIDER, forgetCavemanThreads } from "@caveman-app/provider-caveman/server";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import {
  parseAttachmentFileExtension,
  resolveAttachmentPathById,
  storedAttachmentFileNames,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals([
      "terminal",
      "preview",
      "attachment",
      "scheduled-tasks",
      "engine-state",
    ]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  /** Closes every preview session of the thread; server browser tabs end with them. */
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
  /**
   * Removes what the Caveman engine keeps in the state dir (its journal, harness checkpoints and SessionStart records) for native threads
   * only deleted threads name, keeping what a live thread continues from. Every deleted thread's, not only the one
   * being deleted: a run kept for a live thread goes at the next deletion after that thread moved past it.
   */
  readonly cleanupEngineState: () => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    cleanupAttachments: () => Effect.void,
    cleanupEngineState: () => Effect.void,
  }),
}) {}

/**
 * The native threads to forget, and the native threads and runs to keep. A thread is live while it is not deleted,
 * and while a live fork has yet to read its conversation from it. Live threads keep their native threads and the
 * native turns their conversations continue from (a fork's source run until its first turn, an adopted chat's head).
 */
const nativeStateToForget = (references: ProjectionStore.ProjectionNativeThreadReferences) => {
  const pendingForkSources = new Set(references.pendingForkSources);
  const live = references.providerThreads.filter(
    (providerThread) =>
      !providerThread.deleted ||
      (providerThread.threadId !== null && pendingForkSources.has(providerThread.threadId)),
  );
  const keep = new Set(
    live.flatMap((providerThread) =>
      [providerThread.nativeThreadId, providerThread.headNativeId].filter(
        (id): id is string => id !== null,
      ),
    ),
  );
  const forget = new Set(
    references.providerThreads.flatMap((providerThread) =>
      providerThread.nativeThreadId === null || keep.has(providerThread.nativeThreadId)
        ? []
        : [providerThread.nativeThreadId],
    ),
  );
  return { forget, keep };
};

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    // Absent where a layer builds this service without projections (tests): engine state then stays.
    const projections = yield* Effect.serviceOption(ProjectionStore.ProjectionStoreV2);
    return {
      cleanupScheduledTasks: (threadId: ThreadId) =>
        scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          ),
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.gen(function* () {
          // An id without an extension of its own (a migrated transcript's, or an image minted
          // without one) names `<id>.<ext>` for whatever extension it was stored with, a document
          // as much as an image, so its files are found by listing the directory once.
          const entries = attachmentIds.some((id) => parseAttachmentFileExtension(id) === null)
            ? yield* fileSystem.readDirectory(config.attachmentsDir).pipe(
                Effect.catchIf(
                  (error) => error.reason._tag === "NotFound",
                  () => Effect.succeed<Array<string>>([]),
                ),
                Effect.mapError(
                  (cause) => new ResourceCleanupError({ operation: "attachment", cause }),
                ),
              )
            : [];
          yield* Effect.forEach(
            attachmentIds,
            (attachmentId) => {
              const extension = parseAttachmentFileExtension(attachmentId);
              // A document whose file is already gone can still leave its extracted text behind.
              const extended =
                extension === null
                  ? null
                  : (resolveAttachmentPathById({
                      attachmentsDir: config.attachmentsDir,
                      attachmentId,
                    }) ??
                    resolveAttachmentRelativePath({
                      attachmentsDir: config.attachmentsDir,
                      relativePath: `${attachmentId}.${extension}`,
                    }));
              const paths =
                extension === null
                  ? storedAttachmentFileNames(entries, attachmentId).flatMap((name) => {
                      const path = resolveAttachmentRelativePath({
                        attachmentsDir: config.attachmentsDir,
                        relativePath: name,
                      });
                      return path === null ? [] : [path];
                    })
                  : extended === null
                    ? []
                    : [extended, `${extended}.txt`];
              return Effect.forEach(paths, (path) => fileSystem.remove(path, { force: true }), {
                discard: true,
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                ),
              );
            },
            { discard: true, concurrency: 4 },
          );
        }),
      cleanupEngineState: () =>
        Option.isNone(projections)
          ? Effect.void
          : projections.value.getNativeThreadReferences(CAVEMAN_PROVIDER).pipe(
              Effect.flatMap((references) =>
                Effect.tryPromise(() =>
                  forgetCavemanThreads(config.stateDir, nativeStateToForget(references)),
                ),
              ),
              Effect.mapError(
                (cause) => new ResourceCleanupError({ operation: "engine-state", cause }),
              ),
            ),
    };
  }),
);
