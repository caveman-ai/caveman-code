// Workspace.inbox: a chat's done, snooze, pin and read state. upstream keeps it on the engine thread
// (Orchestrator thread.settle / snooze / pin / visit / mark-unread, and ThreadSettlementService's
// auto-settle), so the runtime only reads it from there and sends the person's changes as T3 commands.
import type { CommandId, OrchestrationV2ServerCommand, ThreadId } from "@caveman-app/protocol";
import type { InboxAction, WorkspaceInbox } from "@caveman-app/session-protocol";
import { DateTime } from "effect";

import type { WorkspaceRecord } from "./store.ts";

type Time = DateTime.Utc | null | undefined;

/** The thread fields it reads: a thread shell's, or any thread.* event's payload. */
export interface InboxThread {
  readonly settledOverride?: "settled" | "active" | null;
  readonly settledAt?: Time;
  readonly snoozedUntil?: Time;
  readonly snoozedAt?: Time;
  readonly pinnedAt?: Time;
  readonly lastVisitedAt?: Time;
}

const iso = (value: Time) => (value == null ? undefined : DateTime.formatIso(value));

/** The thread's inbox state as the wire has it; undefined when there is none. */
export function inboxOf(thread: InboxThread): WorkspaceInbox | undefined {
  const done_at = thread.settledOverride === "settled" ? iso(thread.settledAt) : undefined;
  const snoozed_until = iso(thread.snoozedUntil);
  const inbox: WorkspaceInbox = {
    ...(done_at ? { done_at } : {}),
    ...(snoozed_until ? { snoozed_until, ...(thread.snoozedAt ? { snoozed_at: iso(thread.snoozedAt)! } : {}) } : {}),
    ...(thread.pinnedAt ? { pinned_at: iso(thread.pinnedAt)! } : {}),
    ...(thread.lastVisitedAt ? { visited_at: iso(thread.lastVisitedAt)! } : {}),
  };
  return Object.keys(inbox).length === 0 ? undefined : inbox;
}

/** The record carrying `inbox`, or the same record when it already does. Never bumps `updated_at`: the queue keeps its order. */
export function withInbox(record: WorkspaceRecord, inbox: WorkspaceInbox | undefined): WorkspaceRecord {
  if (JSON.stringify(record.workspace.inbox) === JSON.stringify(inbox)) return record;
  const { inbox: _, ...workspace } = record.workspace;
  return { ...record, workspace: inbox ? { ...workspace, inbox } : workspace };
}

const DAY_MS = 86_400_000;
/** Statuses a done chat may be archived in: nothing runs, waits or asks. */
const RESTING: ReadonlySet<string> = new Set(["idle", "failed", "parked"]);

/** A pull request still under way: the chat behind it may be wanted for its review, so it is never archived by itself. */
const OPEN_PR: ReadonlySet<string> = new Set(["open", "draft"]);

/**
 * The chats done for at least `days` (Settings' inbox_archive_done_after_days), at rest, not pinned, without an open
 * pull request, and not the Chief's or a setup chat. The queue's Done shelf counts down to the same moment (web
 * inbox-state.ts archivesAt).
 */
export function dueForArchive(records: ReadonlyArray<WorkspaceRecord>, days: number, now: number): WorkspaceRecord[] {
  return records.filter(({ workspace: w }) => {
    const doneAt = w.inbox?.done_at ? Date.parse(w.inbox.done_at) : Number.NaN;
    return w.kind === undefined && RESTING.has(w.status) && !w.inbox?.pinned_at && !OPEN_PR.has(w.pull_request?.state ?? "") && doneAt <= now - days * DAY_MS;
  });
}

/** The T3 command that makes the change. */
export function inboxCommand(action: InboxAction, threadId: ThreadId, commandId: CommandId): OrchestrationV2ServerCommand {
  const base = { commandId, threadId };
  switch (action.do) {
    case "done":
      return { ...base, type: "thread.settle" };
    case "reopen":
      return { ...base, type: "thread.unsettle", reason: "user" };
    case "snooze":
      return { ...base, type: "thread.snooze", snoozedUntil: action.until };
    case "wake":
      return { ...base, type: "thread.unsnooze", reason: "user" };
    case "pin":
      return { ...base, type: "thread.pin" };
    case "unpin":
      return { ...base, type: "thread.unpin" };
    case "seen":
      return { ...base, type: "thread.visit", visitedAt: action.through };
    case "unread":
      return { ...base, type: "thread.mark-unread" };
  }
}
