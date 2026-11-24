// ), apps/server/src/orchestration-v2/AttachmentClaims.ts @ ab3a3cd1.
import * as FileSystem from "effect/FileSystem";
import {
  ChatAttachmentId,
  getProviderAttachmentLimitError,
  ThreadId,
  type ChatAttachment,
} from "@caveman-app/protocol";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { isSvgAttachment } from "@caveman-app/shared/image";

import {
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  planAttachmentClaim,
  resolveAttachmentPath,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as DocumentText from "../provider/DocumentText.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

export class AttachmentClaimError extends Schema.TaggedError<AttachmentClaimError>()(
  "AttachmentClaimError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export const validateAttachmentLimits = Effect.fn("AttachmentClaims.validateAttachmentLimits")(
  function* (attachments: ReadonlyArray<ChatAttachment>) {
    const error = getProviderAttachmentLimitError(attachments);
    if (error) return yield* new AttachmentClaimError({ message: error });
  },
);

export interface ClaimedAttachments {
  readonly attachments: ReadonlyArray<ChatAttachment>;
  readonly claimedPaths: ReadonlyArray<string>;
}

export function attachmentIsPendingUpload(attachment: ChatAttachment): boolean {
  return parseThreadSegmentFromAttachmentId(attachment.id) === PENDING_ATTACHMENT_THREAD_SEGMENT;
}

/**
 * A thread sends its own minted attachments and pending uploads freely. Any other id (another
 * thread's minted one, or one with no thread segment, as a migrated transcript carries) says
 * nothing that makes its file this thread's, so the thread's history decides (AttachmentHistory.ts):
 * it is sent only when this thread's messages, its V1 transcript still being imported, or the
 * history it inherited as a fork already name it exactly. Deleting a thread keeps a file any live
 * thread's history names, so a send accepted here never names a file a deletion removes.
 */
const refuseAttachmentsOutsideHistory = Effect.fn(
  "AttachmentClaims.refuseAttachmentsOutsideHistory",
)(function* (threadId: string, attachments: ReadonlyArray<ChatAttachment>) {
  const ownSegment = toSafeThreadAttachmentSegment(threadId);
  const checked = attachments.flatMap((attachment) => {
    const segment = parseThreadSegmentFromAttachmentId(attachment.id);
    return segment === PENDING_ATTACHMENT_THREAD_SEGMENT ||
      (segment !== null && segment === ownSegment)
      ? []
      : [{ attachment, minted: segment !== null }];
  });
  if (checked.length === 0) return;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const named = yield* projections
    .getThreadHistoryAttachmentIds(
      ThreadId.make(threadId),
      checked.map(({ attachment }) => attachment.id),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new AttachmentClaimError({
            message: "Attachments cannot be sent: this thread's history could not be read.",
            cause,
          }),
      ),
    );
  const outside = checked.find(({ attachment }) => !named.has(attachment.id));
  if (outside !== undefined) {
    return yield* new AttachmentClaimError({
      message: outside.minted
        ? `Attachment '${outside.attachment.name}' cannot be sent: it belongs to another thread.`
        : `Attachment '${outside.attachment.name}' cannot be sent: it is not one of this thread's attachments.`,
    });
  }
});

/** Remove partial claims only before dispatch, or after proving they were not accepted. */
export const releaseClaimedAttachments = Effect.fn("AttachmentClaims.releaseClaimedAttachments")(
  function* (claimedPaths: ReadonlyArray<string>) {
    if (claimedPaths.length === 0) return;
    const fileSystem = yield* FileSystem.FileSystem;
    yield* Effect.forEach(
      claimedPaths,
      (path) =>
        fileSystem
          .remove(path)
          .pipe(
            Effect.ignore,
            Effect.andThen(fileSystem.remove(`${path}.txt`, { force: true }).pipe(Effect.ignore)),
          ),
      {
        concurrency: 1,
        discard: true,
      },
    ).pipe(Effect.uninterruptible);
  },
);

/**
 * Claims pending uploads into the target thread's attachment store before the
 * command enters the orchestrator: verifies the staged file, copies it under a
 * thread-scoped id, and rewrites the attachment ref. A copy, not a move — the
 * pending file stays behind as the retry source for a failed bootstrap, and
 * the periodic pending sweep reclaims it later. The thread's own claimed
 * attachments pass through untouched; any other id passes only when this
 * thread's history names it (a fork's inherited ones, a migrated chat's own).
 */
export const claimPendingAttachments = Effect.fn("AttachmentClaims.claimPendingAttachments")(
  function* (input: {
    readonly threadId: string;
    readonly attachments: ReadonlyArray<ChatAttachment>;
  }) {
    yield* validateAttachmentLimits(input.attachments);
    if (
      new Set(input.attachments.map((attachment) => attachment.id)).size !==
      input.attachments.length
    ) {
      return yield* new AttachmentClaimError({
        message: "Duplicate attachment ids are not allowed.",
      });
    }
    yield* refuseAttachmentsOutsideHistory(input.threadId, input.attachments);
    if (!input.attachments.some(attachmentIsPendingUpload)) {
      return { attachments: input.attachments, claimedPaths: [] } satisfies ClaimedAttachments;
    }
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const claimedPaths: string[] = [];
    const documents = yield* DocumentText.DocumentText;
    const attachments = yield* Effect.forEach(
      input.attachments,
      (attachment) =>
        Effect.gen(function* () {
          if (!attachmentIsPendingUpload(attachment)) {
            return attachment;
          }
          const claim = planAttachmentClaim({
            attachmentsDir: serverConfig.attachmentsDir,
            threadId: input.threadId,
            attachmentId: attachment.id,
          });
          if (!claim.ok) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: ${claim.reason}.`,
            });
          }
          const info = yield* fileSystem.stat(claim.currentPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Attachment '${attachment.name}' cannot be sent: attachment not found.`,
                  cause,
                }),
            ),
          );
          if (Number(info.size) !== attachment.sizeBytes) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: stored size does not match.`,
            });
          }
          const normalized: ChatAttachment = {
            ...attachment,
            id: ChatAttachmentId.make(claim.finalId),
            name:
              attachment.type === "file" &&
              isSvgAttachment(attachment) &&
              !/\.svg$/i.test(attachment.name)
                ? `${attachment.name}.svg`
                : attachment.name,
            mimeType: attachment.mimeType.toLowerCase(),
          };
          const expectedPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: normalized,
          });
          if (expectedPath !== claim.finalPath) {
            return yield* new AttachmentClaimError({
              message: `Attachment '${attachment.name}' cannot be sent: attachment type does not match the upload.`,
            });
          }
          // A copy, not a hard link: an agent editing the delivered file in
          // place must not mutate the retry source. fs.copyFile cannot be
          // cancelled, so the copy and its rollback registration stay in one
          // uninterruptible region: an interrupt landing mid-copy still waits
          // for the write to settle and records the path before cleanup runs.
          yield* fileSystem.copyFile(claim.currentPath, claim.finalPath).pipe(
            Effect.mapError(
              (cause) =>
                new AttachmentClaimError({
                  message: `Failed to claim attachment '${attachment.name}' for this thread.`,
                  cause,
                }),
            ),
            Effect.andThen(Effect.sync(() => claimedPaths.push(claim.finalPath))),
            Effect.uninterruptible,
          );
          // The upload's extracted text travels with it, or is read now.
          const sidecar = `${claim.currentPath}.txt`;
          if (yield* fileSystem.exists(sidecar).pipe(Effect.orElseSucceed(() => false))) {
            yield* fileSystem.copyFile(sidecar, `${claim.finalPath}.txt`).pipe(
              Effect.andThen(Effect.sync(() => claimedPaths.push(`${claim.finalPath}.txt`))),
              Effect.onError(() =>
                fileSystem.remove(`${claim.finalPath}.txt`, { force: true }).pipe(Effect.ignore),
              ),
              Effect.uninterruptible,
              Effect.ignore,
            );
          } else {
            const extracted = yield* documents.ensure(claim.finalPath);
            if (extracted) claimedPaths.push(extracted);
          }
          return normalized;
        }),
      { concurrency: 1 },
    ).pipe(Effect.onError(() => releaseClaimedAttachments(claimedPaths)));
    return { attachments, claimedPaths } satisfies ClaimedAttachments;
  },
);
