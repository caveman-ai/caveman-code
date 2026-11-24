/**
 * Whose a stored attachment file is: the threads whose history names its id.
 *
 * A thread's history is its own messages and tool items (and its V1 transcript while that import
 * is pending), then, for a fork, what it inherited: each source's messages and items through the
 * run it was forked at, as the fork's transcript shows them (a run-less entry only from an
 * imported transcript, as isTurnItemAtOrBeforeRun decides).
 *
 * - A claim sends an id that is not the thread's own minted one only when the sending thread's
 *   history names it exactly.
 * - Deleting a thread removes an id its history names only when no other live thread's history
 *   names it, and, for an id minted for another thread, that thread is gone.
 *
 * Both decide on the same durable records, so a send that is accepted names a file every later
 * deletion keeps.
 *
 * Case: a claim matches the id exactly, because on a case-sensitive disk a differently cased id is
 * another file, perhaps another chat's. Deletion compares the file an id may name (fileIdentity),
 * because on a case-insensitive disk differently cased ids are one file; and the removal takes
 * every file of that identity, so a variant kept for a live chat is not left behind once no chat
 * names any of them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  attachmentFileIdentity,
  parseThreadSegmentFromAttachmentId,
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  toSafeThreadAttachmentSegment,
} from "../attachmentStore.ts";

/**
 * The attachment ids that the V1 transcripts of migrated threads whose import is still pending
 * name: part of those threads' history until the import copies them into their V2 messages. Only
 * the legacy importer reads V1 tables (V1ImportBoundary.test), so it provides this
 * (LegacyV1ThreadImporter.layerPendingTranscriptAttachments). The SQLite projection store requires
 * it, so a store built without it does not compile.
 */
export class PendingTranscriptAttachments extends Context.Service<
  PendingTranscriptAttachments,
  {
    readonly namings: (input: {
      /** Null: every pending thread's. */
      readonly threadIds: ReadonlyArray<string> | null;
      /** Null: every id; otherwise only these, exactly. */
      readonly attachmentIds: ReadonlyArray<string> | null;
    }) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: string; readonly attachmentId: string }>,
      unknown
    >;
  }
>()("caveman/orchestration-v2/PendingTranscriptAttachments") {}

/**
 * For a database that holds no migrated thread (the replay test harness, which may not reach the
 * importer). The runtime wires the importer's reader instead (runtimeLayer.ts).
 */
export const layerNoPendingTranscripts = Layer.succeed(PendingTranscriptAttachments, {
  namings: () => Effect.succeed([]),
});

/** The stored file an id may name (attachmentFileIdentity). */
export const fileIdentity = attachmentFileIdentity;

export interface AttachmentHistoryThread {
  readonly deleted: boolean;
  readonly historyOrigin: string | null;
  /** A run fork's source: the fork inherits the source's history through this run. */
  readonly forkedFrom: { readonly threadId: string; readonly runId: string } | null;
}

/** One attachment id a thread's own message or tool item names. */
export interface AttachmentHistoryNaming {
  readonly threadId: string;
  /** Null for an entry with no run: an imported transcript's. */
  readonly runId: string | null;
  readonly attachmentId: string;
}

export interface AttachmentHistoryRecords {
  /** Every thread a naming belongs to, and every fork between them and the thread asked about. */
  readonly threads: ReadonlyMap<string, AttachmentHistoryThread>;
  readonly runOrdinals: ReadonlyMap<string, number>;
  readonly namings: ReadonlyArray<AttachmentHistoryNaming>;
}

export function attachmentHistory(records: AttachmentHistoryRecords) {
  const byThread = new Map<string, Array<AttachmentHistoryNaming>>();
  for (const naming of records.namings) {
    const own = byThread.get(naming.threadId);
    if (own === undefined) byThread.set(naming.threadId, [naming]);
    else own.push(naming);
  }
  const ordinal = (runId: string) => records.runOrdinals.get(runId);
  const inheritedThrough = (
    naming: AttachmentHistoryNaming,
    source: AttachmentHistoryThread,
    throughRunId: string,
  ) => {
    if (naming.runId === null) return source.historyOrigin === "v1_import";
    const named = ordinal(naming.runId);
    const through = ordinal(throughRunId);
    return named !== undefined && through !== undefined && named <= through;
  };

  /** The attachment ids `threadId`'s history names: its own, then each fork source's. */
  const entries = (threadId: string): Array<string> => {
    const ids = (byThread.get(threadId) ?? []).map((naming) => naming.attachmentId);
    const seen = new Set([threadId]);
    let fork = records.threads.get(threadId)?.forkedFrom ?? null;
    while (fork !== null && !seen.has(fork.threadId)) {
      seen.add(fork.threadId);
      const source = records.threads.get(fork.threadId);
      if (source === undefined) break;
      const throughRunId = fork.runId;
      for (const naming of byThread.get(fork.threadId) ?? []) {
        if (inheritedThrough(naming, source, throughRunId)) ids.push(naming.attachmentId);
      }
      fork = source.forkedFrom;
    }
    return ids;
  };

  const namedByOtherLiveThread = (threadId: string, matches: (attachmentId: string) => boolean) =>
    [...records.threads].some(
      ([otherThreadId, thread]) =>
        otherThreadId !== threadId && !thread.deleted && entries(otherThreadId).some(matches),
    );

  return {
    entries,
    /** Whether `threadId`'s history names exactly this id: what a claim may send. */
    names: (threadId: string, attachmentId: string) =>
      entries(threadId).some((named) => named === attachmentId),
    /**
     * The files deleting `threadId` removes: each id its history names, unless another live
     * thread's history names that file, or the id was minted for another thread that is live
     * (`liveSegments`: the segments of the live threads other than `threadId`).
     */
    removableOnDeletion: (threadId: string, liveSegments: ReadonlySet<string>) => {
      const ownSegment = toSafeThreadAttachmentSegment(threadId);
      return [...new Set(entries(threadId))].filter((attachmentId) => {
        const segment = parseThreadSegmentFromAttachmentId(attachmentId);
        // A pending upload is its uploader's until claimed; the pending sweep removes it.
        if (segment === PENDING_ATTACHMENT_THREAD_SEGMENT) return false;
        if (segment !== null && segment !== ownSegment && liveSegments.has(segment)) return false;
        const identity = fileIdentity(attachmentId);
        return !namedByOtherLiveThread(threadId, (named) => fileIdentity(named) === identity);
      });
    },
  };
}
