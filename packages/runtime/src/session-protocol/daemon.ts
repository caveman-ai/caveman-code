// Follows upstream stored-event stream and journals each workspace thread's
// events as v1 session events. The offset, the per-thread projector state and
// the appended events commit in one transaction, so a restart resumes exactly
// where the last commit left off: no event lost, none journaled twice. A failed
// commit resumes the same way, after a wait; an event the projection itself
// cannot take, or whose rows break a constraint, is skipped, so it never stops
// every chat's journal.
import { randomUUID } from "node:crypto";

import { isProviderNativeSubagentThread, type OrchestrationV2DomainEvent, type OrchestrationV2StoredEvent, ThreadId } from "@caveman-app/protocol";
import type { BuildersResult, Scrubber, SessionEvent, ToolThread, Workspace } from "@caveman-app/session-protocol";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SqlError from "effect/sql/SqlError";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { projectDomainEventForWire, projectTurnItemForDetail } from "../orchestration-v2/WireProjection.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { recordChanges } from "./sources.ts";
import { ProjectSecrets } from "../secrets/ProjectSecrets.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { CHIEF_QUIET } from "../chief/quiet.ts";
import { childWorkspaceId, emptyThreadState, engineIdForInstance, foldNativeSubagents, nestUnder, ownToolThreadIds, projectEvent, THIS_MAC, threadActivity, usageBilling, type DraftEvent, type ThreadState } from "./projector.ts";
import { inlineAttachmentData } from "./attachments.ts";
import { inboxOf, withInbox, type InboxThread } from "./inbox.ts";
import { followLinkedPullRequest } from "./pullRequests.ts";
import { cutMarkerOf, makeOutputScrub, maskCut } from "./secrets.ts";
import { SessionStore, withAwaiting, type WorkspaceRecord } from "./store.ts";
import { awaitingOf, foldBackground } from "./awaiting.ts";
import { withTopic } from "./topics.ts";

import { ACCOUNT_TAGS } from "./engineAccounts.ts";
import { SubagentAuto } from "../router/subagentAuto.ts";
import { threadMarker } from "../automations/journal.ts";

const HELD_STATUSES = new Set(["archived", "parked"]);
const TERMINAL_STATUS: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "interrupted"]);
const INBOX_BACKFILLED = "inbox_backfilled";
/** How long the projector waits before it goes again after a failure: doubling from the first, up to the most. */
const RETRY_FIRST_MS = 1_000;
const RETRY_MOST_MS = 60_000;

/**
 * The database's failure (full, read-only, locked, an I/O error), not the event's. A constraint the event's rows break
 * is the event's: they break it every time they go again.
 */
const databaseFailure = (cause: Cause.Cause<unknown>) =>
  cause.reasons.some((reason) => {
    const error = Cause.isFailReason(reason) ? reason.error : Cause.isDieReason(reason) ? reason.defect : undefined;
    return SqlError.isSqlError(error) && error.reason._tag !== "ConstraintError" && error.reason._tag !== "UniqueViolation";
  });

/**
 * `drafts` with the start of a secret value masked where the runtime cut a text inside one (WireProjection: a Chief
 * tool's answer read as a detail, a subagent's result, a failure, a tool input's one-line summary): the journal's scrub
 * masks whole values only, and a cut value's start is not one. Masked as /ws masks the same texts (maskCut).
 */
const maskCutValues = (scrubber: Scrubber, drafts: Array<DraftEvent>): Array<DraftEvent> => {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return cutMarkerOf(value) === undefined ? value : maskCut(scrubber, value);
    if (Array.isArray(value)) {
      const out = value.map(walk);
      return out.some((x, i) => x !== value[i]) ? out : value;
    }
    if (value === null || typeof value !== "object") return value;
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const entries = Object.entries(value);
    const out = entries.map(([key, x]) => [key, walk(x)] as const);
    return out.some(([, x], i) => x !== entries[i]![1]) ? Object.fromEntries(out) : value;
  };
  return drafts.map((draft) => walk(draft) as DraftEvent);
};

export const runProjector = Effect.gen(function* () {
  const store = yield* SessionStore;
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const attachmentData = (attachment: unknown) => inlineAttachmentData(attachmentsDir, attachment);
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const secrets = yield* ProjectSecrets;
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const providers = yield* Effect.serviceOption(ProviderRegistry.ProviderRegistry);
 /** Who pays for each instance's usage; a Codex instance on the person's own compact login is a plan's, never priced. */
  const noSettingsBilling = usageBilling({});
  const settingsBilling = Effect.gen(function* () {
    const instances = Option.isNone(serverSettings) ? {} : (yield* serverSettings.value.getSettings).providerInstances;
    const known = Option.isNone(providers) ? [] : yield* providers.value.getProviders;
    return usageBilling(instances, known);
  }).pipe(Effect.orElseSucceed(() => noSettingsBilling));
  const subagentAuto = yield* Effect.serviceOption(SubagentAuto);
  /** Project roots, for automation runs (adoptAutomationRun). */
  const projects = yield* Effect.serviceOption(ProjectStore.ProjectStoreV2);
  const { sql } = store;

  const readOffset = sql<{ last_sequence: number }>`SELECT last_sequence FROM caveman_sp_projector WHERE id = 1`.pipe(
    Effect.map((rows) => rows[0]?.last_sequence ?? 0),
    Effect.orDie,
  );
  const commitOffset = (sequence: number) =>
    sql`INSERT INTO caveman_sp_projector (id, last_sequence) VALUES (1, ${sequence})
        ON CONFLICT (id) DO UPDATE SET last_sequence = MAX(last_sequence, excluded.last_sequence)`;

  // Workspaces journaled before Workspace.inbox existed (T3 may have marked some done meanwhile) take it from their
  // threads once; from then on each thread event carries it (followThread).
  const backfillInbox = Effect.gen(function* () {
    if ((yield* store.kvGet(INBOX_BACKFILLED)) !== undefined) return;
    for (const record of yield* store.listWorkspaces()) {
      const shell = yield* orchestrator.getThreadShell(ThreadId.make(record.internal.threadId)).pipe(Effect.orElseSucceed(() => null));
      if (shell === null || withInbox(record, inboxOf(shell)) === record) continue;
      yield* store.append(record.session.id, (current) => Effect.succeed({ events: [], value: undefined, record: withInbox(current, inboxOf(shell)) }));
    }
    yield* store.kvSet(INBOX_BACKFILLED, "1");
  });

  /** A thread by its workspace, else (a delegated child, a T3 thread) its own title; undefined when no longer known. */
  const threadOf = (threadId: ThreadId) =>
    Effect.gen(function* () {
      const record = yield* store.getByThread(threadId);
      if (record) return { workspace_id: record.workspace.id, title: record.workspace.title };
      const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      return shell === null ? undefined : { title: shell.title };
    });

  /** A sending thread. One no longer known still sent it: its message is never the person's own. */
  const senderOf = (threadId: ThreadId) => threadOf(threadId).pipe(Effect.map((thread) => thread ?? { title: threadId }));

  /**
   * Who runs a delegate_task child (router/subagentAuto.ts), recorded by its delegation's command, with
   * the account's tag when the person set one (engine.account.tag).
   */
  const runnerFor = (commandId: string | null, threadId: string) =>
    Effect.gen(function* () {
      if (commandId === null || Option.isNone(subagentAuto)) return undefined;
      const runner = yield* subagentAuto.value.adopt(commandId, threadId);
      if (runner === undefined) return undefined;
      const tags = JSON.parse((yield* store.kvGet(ACCOUNT_TAGS)) ?? "{}") as Record<string, string>;
      const tag = tags[runner.instance_id];
      return tag ? { ...runner, account_tag: tag } : runner;
    }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));

  /**
   * A delegate_task child of a projected thread becomes a workspace of its own, nested under its
   * parent's, when T3 creates its thread (before the parent's subagent item names it): it opens as
   * a normal chat, and its asks, spend and diff work like any workspace's. A native subagent (Claude's
   * Agent tool, Codex's collab agents) stays an item in its parent's transcript.
   */
  const adoptChild = (event: Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>, commandId: string | null) =>
    Effect.gen(function* () {
      const thread = event.payload;
      const parentThreadId = thread.lineage.parentThreadId;
      if (thread.lineage.relationshipToParent !== "subagent" || isProviderNativeSubagentThread(thread) || parentThreadId === null) return undefined;
      const parent = yield* store.getByThread(parentThreadId);
      if (parent === undefined) return undefined;
      const at = DateTime.formatIso(event.occurredAt);
      const id = childWorkspaceId(thread.id);
      const engine = engineIdForInstance(thread.providerInstanceId) as Workspace["engine"];
      // A worktree-isolated child gets its path when T3 prepares it (synced below); until then, and for good when
      // it shares the parent's checkout, it works where its parent does.
      const worktreePath = thread.worktreePath ?? parent.internal.worktreePath;
      const sessionId = randomUUID();
      const runner = yield* runnerFor(commandId, thread.id);
      const record: WorkspaceRecord = {
        workspace: {
          id,
          title: thread.title,
          repo: parent.workspace.repo,
          base_ref: parent.workspace.branch,
          branch: thread.branch ?? parent.workspace.branch,
          engine,
          computer: parent.workspace.computer,
          session_id: sessionId,
          status: "starting",
          parent_workspace_id: parent.workspace.id,
          ...(parent.workspace.root_path !== undefined && worktreePath ? { root_path: worktreePath } : {}),
          ...(parent.workspace.project_id ? { project_id: parent.workspace.project_id } : {}),
          ...(runner ? { runner } : {}),
          created_at: at,
          updated_at: at,
        },
        session: {
          id: sessionId,
          workspace_id: id,
          engine,
          state: "live",
          ...(parent.session.lease ? { lease: parent.session.lease } : {}),
          head: 0,
          created_at: at,
          updated_at: at,
        },
        internal: { threadId: thread.id, worktreePath, repoPath: parent.internal.repoPath, setup: "none", delegated: true },
      };
      yield* store.putWorkspace(record);
      yield* store.publishWorkspace(record.workspace);
      return record;
    });

  /**
   * Where a native subagent's own thread is journaled. T3 gives each native subagent (Claude's Agent
   * tool, Codex's collab agents) a provider-native child thread holding its steps, and the subagent
   * item in its parent's transcript holds only its start, progress and end. The child is never a
   * workspace, so its events go into the chat that started it, under that
   * item: the lead's thread, walking up for a subagent another subagent started. The parent's
   * projector state names the item (ThreadState.native) once it has journaled it; until then (the
   * child's prompt) there is nothing to show. Found hosts are kept: a child keeps its parent.
   */
  const hosts = new Map<string, { readonly threadId: ThreadId; readonly item: string; readonly turn: string | undefined }>();
 /** Threads that are no native subagent's (the Chief's, upstream own): their events are skipped without a lookup. */
  const notNative = new Set<string>();
  const nativeHost = (threadId: ThreadId): Effect.Effect<{ readonly threadId: ThreadId; readonly item: string; readonly turn: string | undefined } | undefined> =>
    Effect.gen(function* () {
      const known = hosts.get(threadId);
      if (known) return known;
      if (notNative.has(threadId)) return undefined;
      const shell = yield* orchestrator.getThreadShell(threadId).pipe(Effect.orElseSucceed(() => null));
      const parentThreadId = shell?.lineage.parentThreadId ?? null;
      if (shell === null) return undefined;
      if (parentThreadId === null || !isProviderNativeSubagentThread(shell)) {
        notNative.add(threadId);
        return undefined;
      }
      const parentRecord = yield* store.getByThread(parentThreadId);
      const above = parentRecord === undefined ? yield* nativeHost(parentThreadId) : undefined;
      if (parentRecord === undefined && above === undefined) return undefined;
      const row = yield* sql<{ state: string }>`SELECT state FROM caveman_sp_thread_state WHERE thread_id = ${parentThreadId}`.pipe(Effect.orDie);
      const entry = row[0] ? (JSON.parse(row[0].state) as ThreadState).native?.[threadId] : undefined;
      if (entry === undefined) return undefined;
      const host = { threadId: parentRecord ? parentThreadId : above!.threadId, item: entry.item, turn: entry.turn ?? above?.turn };
      hosts.set(threadId, host);
      return host;
    });

  /**
   * An automation's run (automation.*, ScheduledTaskService) becomes a workspace of its own in the
   * automation's project when its first message, which names the task, reaches its thread: T3 made the
   * thread and owns its worktree, as for a delegated child. So does an automation file's step or check
   * (automations/steps.ts), whose thread its run recorded before starting it; its workspace carries the
   * run, so spend and the run view find it.
   */
  const adoptAutomationRun = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type !== "turn-item.updated" || event.payload.type !== "user_message") return undefined;
      const step = event.payload.scheduledTaskId === undefined ? yield* threadMarker(sql, event.threadId) : undefined;
      if (event.payload.scheduledTaskId === undefined && step === undefined) return undefined;
      if (Option.isNone(projects)) return undefined;
      const thread = yield* orchestrator.getThreadShell(event.threadId).pipe(Effect.orElseSucceed(() => null));
      if (thread === null || thread.lineage.parentThreadId !== null) return undefined;
      const root = Option.getOrUndefined(yield* projects.value.get(thread.projectId).pipe(Effect.orElseSucceed(() => Option.none())))?.workspaceRoot;
      if (root === undefined) return undefined;
      const at = DateTime.formatIso(event.occurredAt);
      const sessionId = randomUUID();
      const engine = engineIdForInstance(thread.providerInstanceId) as Workspace["engine"];
      const record: WorkspaceRecord = {
        workspace: {
          id: randomUUID(),
          title: thread.title,
          repo: { path: root },
          base_ref: thread.branch ?? "HEAD",
          branch: thread.branch ?? "HEAD",
          engine,
          computer: THIS_MAC,
          session_id: sessionId,
          status: "starting",
          root_path: thread.worktreePath ?? root,
          project_id: thread.projectId,
          created_at: at,
          updated_at: at,
          // A step's workspace stays out of the chat sidebar; the automation's run view opens it.
          ...(step === undefined
            ? {}
            : { automation: { name: step.automation, run_id: step.run, step: step.step, attempt: step.attempt, ...(step.check === undefined ? {} : { check: step.check }) } }),
        },
        session: { id: sessionId, workspace_id: "", engine, state: "live", head: 0, created_at: at, updated_at: at },
        internal: { threadId: thread.id, worktreePath: thread.worktreePath ?? root, repoPath: root, setup: "none", delegated: true, ...(step === undefined ? {} : { automation: step }) },
      };
      const placed: WorkspaceRecord = { ...record, session: { ...record.session, workspace_id: record.workspace.id } };
      yield* store.putWorkspace(placed);
      yield* store.publishWorkspace(placed.workspace);
      return placed;
    });

  /**
   * A thread's title (an agent's thread_update, workspace.rename) and topic with its emoji (workspace.topic), a child's prepared worktree, its inbox state
   * (done, snoozed, pinned, read: Workspace.inbox) and its linked pull request's host state (Workspace.pull_request,
 * synced by upstream PullRequestSyncReactor), onto its workspace.
   */
  const followThread = (record: WorkspaceRecord, event: OrchestrationV2DomainEvent, at: string): WorkspaceRecord => {
    if (!event.type.startsWith("thread.")) return record;
    if (event.type === "thread.pull-request-link-updated") {
      // Never a Chief's: it has no repository. The pill moves without bumping updated_at (pullRequests.ts).
      if (record.workspace.kind !== undefined) return record;
      const workspace = followLinkedPullRequest(record.workspace, event.payload);
      return workspace === record.workspace ? record : { ...record, workspace };
    }
    const thread = (event as Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>).payload;
    let next = "settledOverride" in thread ? withInbox(record, inboxOf(thread as InboxThread)) : record;
    if (thread.title && thread.title !== record.workspace.title) next = { ...next, workspace: { ...next.workspace, title: thread.title, updated_at: at } };
    // Its topic and emoji move the row between groups and mark its group, never move it up the list: updated_at stays.
    // A null topic is in no group.
    if (thread.topic) {
      const workspace = withTopic(next.workspace, thread.topic.name, thread.topic.icon);
      if (workspace !== next.workspace) next = { ...next, workspace };
    }
    if (record.internal.delegated && thread.worktreePath && thread.worktreePath !== record.internal.worktreePath) {
      next = {
        ...next,
        workspace: { ...next.workspace, ...(thread.branch ? { branch: thread.branch } : {}), ...(next.workspace.root_path !== undefined ? { root_path: thread.worktreePath } : {}), updated_at: at },
        internal: { ...next.internal, worktreePath: thread.worktreePath },
      };
    }
    return next;
  };

  /**
   * The Chief's cards are its tools' answers (chat_start's chats, remember's note id for Undo). The
   * stream the projector reads keeps only ids of a tool's output (WireProjection), so a Chief tool's
   * finished item takes its answer back from the projection, bounded as a detail read is. Only the
   * Chief's thread, once per call.
   */
  const withChiefToolAnswer = (event: OrchestrationV2DomainEvent) =>
    Effect.gen(function* () {
      if (event.type !== "turn-item.updated" || event.payload.type !== "dynamic_tool" || event.payload.status !== "completed" || event.payload.outputOmitted !== true) return event;
      const full = yield* orchestrator.getTurnItem({ threadId: event.threadId, itemId: event.payload.id }).pipe(Effect.orElseSucceed(() => null));
      if (full?.type !== "dynamic_tool" || full.output === undefined) return event;
      const detail = projectTurnItemForDetail(full);
      if (detail.type !== "dynamic_tool") return event;
      const { outputOmitted: _, ...payload } = event.payload;
      return { ...event, payload: { ...payload, output: detail.output } } as OrchestrationV2DomainEvent;
    });

  const projectOne = (stored: OrchestrationV2StoredEvent, scrubOutput: ReturnType<typeof makeOutputScrub>) =>
    Effect.gen(function* () {
      let event = stored.event;
      const own =
        (yield* store.getByThread(event.threadId)) ??
        (event.type === "thread.created" ? yield* adoptChild(event, stored.commandId) : undefined) ??
        (yield* adoptAutomationRun(event));
      // A native subagent's thread is journaled in its chat, under its row; only its items are.
      const host = own === undefined && event.type !== "thread.created" ? yield* nativeHost(event.threadId) : undefined;
      const record = own ?? (host ? yield* store.getByThread(host.threadId) : undefined);
      if (record === undefined) return;
      if (record.workspace.kind === "chief") event = yield* withChiefToolAnswer(event);
      const userMessage = event.type === "turn-item.updated" && event.payload.type === "user_message" ? event.payload : undefined;
      // T3 names the sender of a peer message; the runtime keeps the sender of what it submits for an agent.
      const sender =
        userMessage === undefined
          ? undefined
          : (yield* sql<{ thread_id: string; agent: string | null }>`SELECT thread_id, agent FROM caveman_sp_senders WHERE message_id = ${userMessage.messageId}`.pipe(Effect.orDie))[0];
      const sentBy = sender?.thread_id;
      // A message the runtime wrote for an agent: the line a person reads of it (caveman_sp_generated).
      const generatedRow =
        userMessage === undefined
          ? undefined
          : (yield* sql<{ shown: string; result: string | null }>`SELECT shown, result FROM caveman_sp_generated WHERE message_id = ${userMessage.messageId}`.pipe(Effect.orDie))[0];
      const generated = generatedRow === undefined ? undefined : { shown: generatedRow.shown, ...(generatedRow.result === null ? {} : { builders_result: JSON.parse(generatedRow.result) as BuildersResult }) };
      const senderThreadId = userMessage?.senderThreadId ?? (sentBy === undefined ? undefined : ThreadId.make(sentBy));
      // A scheduled task's prompt names its task; only for the message that carries one.
      const scheduledTitle =
        userMessage?.scheduledTaskId === undefined
          ? undefined
          : (yield* sql<{ title: string }>`SELECT title FROM scheduled_tasks WHERE task_id = ${userMessage.scheduledTaskId}`.pipe(Effect.orElseSucceed(() => [])))[0]?.title;
      // Usage is priced by who pays; read only for the event that carries it.
      const billing = event.type === "provider-turn.updated" ? yield* settingsBilling : noSettingsBilling;
      // An outside agent (outsideAgents.ts) sent it: its name; its thread_id is the principal its connection had.
      const from =
        senderThreadId === undefined
          ? undefined
          : userMessage?.senderThreadId === undefined && sender?.agent != null
            ? { title: sender.agent, agent: true as const }
            : yield* senderOf(senderThreadId);
      // A delegated child's item: its runner (from the child's workspace) for subagent.started.
      const child = event.type === "turn-item.updated" && event.payload.type === "subagent" && event.payload.origin === "app_owned" ? event.payload.childThreadId : null;
      const childRunner = child === null ? undefined : (yield* store.getByThread(child))?.workspace.runner;
      // One of the runtime's own tools on other threads (thread_send, thread_launch, …): each thread it names, by title.
      const named = event.type === "turn-item.updated" ? ownToolThreadIds(event.payload) : undefined;
      const toolThreads = new Map<string, ToolThread>();
      for (const id of new Set([...(named?.input ?? []), ...(named?.result ?? [])])) {
        const thread = yield* threadOf(ThreadId.make(id));
        if (thread !== undefined) toolThreads.set(id, thread);
      }
      // Git runs before the transaction; the diff only adds a diff.changed event.
      const diff =
        host === undefined && event.type === "checkpoint.captured" && event.payload.runId !== null && record.internal.worktreePath
          ? yield* recordChanges(driver, record).pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
      yield* store.transact(
        Effect.gen(function* () {
          const current = (yield* store.getByThread(host ? host.threadId : event.threadId))!;
          const stateRow = yield* sql<{ state: string }>`SELECT state FROM caveman_sp_thread_state WHERE thread_id = ${event.threadId}`;
          const state: ThreadState = stateRow[0] ? JSON.parse(stateRow[0].state) : emptyThreadState();
          const display = new Map<string, string>();
          if (event.type === "turn-item.updated" && event.payload.type === "user_message") {
            const rows = yield* sql<{ text: string }>`SELECT text FROM caveman_sp_display_text WHERE message_id = ${event.payload.messageId}`;
            if (rows[0]) display.set(event.payload.messageId, rows[0].text);
          }
          const at = DateTime.formatIso(event.occurredAt);
          foldBackground(state, event);
          const result = projectEvent(state, event, { at, displayText: (id) => display.get(id), repo: current.workspace.repo, sender: (id) => (id === senderThreadId ? from : undefined), sentBy: (id) => (id === userMessage?.messageId ? sentBy : undefined), scheduledTask: (id) => (id === userMessage?.scheduledTaskId ? scheduledTitle : undefined), generated: (id) => (id === userMessage?.messageId ? generated : undefined), billing, runner: (id) => (id === child ? childRunner : undefined), toolThread: (id) => toolThreads.get(id), attachmentData, ...(current.workspace.kind === "chief" ? { quietReply: CHIEF_QUIET } : {}) });
          const scrubber = yield* secrets.scrubber;
          const scrubbed = maskCutValues(scrubber, scrubOutput(scrubber, result.events));
          // A native subagent's own events: inside its row; its thread's title, mode and turns are not the chat's.
          const drafts = host ? nestUnder(scrubbed, host) : scrubbed;
          if (result.checkpointTurnId && diff) {
            drafts.push({ at, type: "diff.changed", turn_id: result.checkpointTurnId, payload: { files: diff } } as DraftEvent);
          }
          let next = host ? current : followThread(current, event, at);
          // A queued switch is not current until its turn starts. Native subagents never change their parent's harness.
          const started = host ? undefined : drafts.find((draft) => draft.type === "turn.started") as Omit<Extract<SessionEvent, { type: "turn.started" }>, "session_id" | "cursor"> | undefined;
          if (started?.type === "turn.started" && started.payload.engine !== next.workspace.engine) {
            next = {
              ...next,
              workspace: { ...next.workspace, engine: started.payload.engine, updated_at: at },
              session: { ...next.session, engine: started.payload.engine, updated_at: at },
            };
          }
          const followed = next !== current;
          let statusChanged = false;
          let awaitingChanged = false;
          if (host === undefined) {
            // Its turn ended, but work that will wake it still runs (awaiting.ts). Like the inbox, never moves updated_at.
            const marked = withAwaiting(next, awaitingOf(state));
            awaitingChanged = marked !== next;
            next = marked;
            if (result.engineSessionRef && current.session.engine_session_ref !== result.engineSessionRef) {
              next = { ...next, session: { ...next.session, engine_session_ref: result.engineSessionRef } };
            }
            if (result.mode && current.session.mode !== result.mode) next = { ...next, session: { ...next.session, mode: result.mode } };
            if (result.access && current.session.access !== result.access) next = { ...next, session: { ...next.session, access: result.access } };
            const activity = threadActivity(state);
            statusChanged = !HELD_STATUSES.has(current.workspace.status) && current.workspace.status !== activity;
            if (statusChanged) next = { ...next, workspace: { ...next.workspace, status: activity, updated_at: at } };
          }
          // The chat lists its native subagents (Workspace.subagents), for the sidebar.
          const subagents = foldNativeSubagents(next.workspace.subagents, drafts);
          const listed = subagents !== next.workspace.subagents;
          if (listed && subagents) next = { ...next, workspace: { ...next.workspace, subagents } };
          const appended = yield* store.appendInTx(next, drafts);
          // What the chat is at (Workspace.activity), for the sidebar: appending folds it from the same events.
          const active = appended.record.workspace.activity !== next.workspace.activity;
          yield* sql`INSERT INTO caveman_sp_thread_state (thread_id, state) VALUES (${event.threadId}, ${JSON.stringify(state)})
                     ON CONFLICT (thread_id) DO UPDATE SET state = excluded.state`;
          yield* commitOffset(stored.sequence);
          const changed: Array<Workspace> = statusChanged || followed || listed || active || awaitingChanged ? [appended.record.workspace] : [];
          return { value: undefined, published: appended.events, changed };
        }).pipe(Effect.orDie),
      );
      // The child ended: its outcome goes back to Cloud once (when Auto picked it), off the projection's path.
      if (child !== null && Option.isSome(subagentAuto) && event.type === "turn-item.updated" && TERMINAL_STATUS.has(event.payload.status)) {
        const status = event.payload.status;
        yield* subagentAuto.value.finish(child, status === "completed" ? "completed" : status === "failed" ? "failed" : "interrupted").pipe(Effect.forkDetach);
      }
    });

  /**
   * An event its projection cannot take is skipped: its offset is committed alone and the failure logged, so one
   * event never stops every chat's journal, nor stops it again at every start. The database's failure stands.
   */
  const projectOrSkip = (stored: OrchestrationV2StoredEvent, scrubOutput: ReturnType<typeof makeOutputScrub>) =>
    projectOne(stored, scrubOutput).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause) || databaseFailure(cause)
          ? Effect.failCause(cause)
          : commitOffset(stored.sequence).pipe(
              Effect.orDie,
              Effect.andThen(Effect.logError(`session protocol projector skipped event ${stored.sequence} (${stored.event.type}, thread ${stored.event.threadId}): it could not be journaled`, cause)),
            ),
      ),
    );

  /** Failures since the last event went through: how long to wait before going again. */
  let failures = 0;
  // A worker of the runtime's own, so never a client's bounded stream: that one ends once it falls
  // LIVE_STREAM_MAX_ITEMS behind, and every chat would stop journaling. Its events are cut as a client's
  // are (WireProjection).
  const follow = Effect.gen(function* () {
    yield* backfillInbox;
    // Fresh, as at a start: a failed event's text went into the old one, and the event goes again.
    const scrubOutput = makeOutputScrub();
    yield* eventSink.stream({ afterSequence: yield* readOffset }).pipe(
      Stream.map((stored) => ({ ...stored, event: projectDomainEventForWire(stored.event) })),
      Stream.runForEach((stored) => projectOrSkip(stored, scrubOutput).pipe(Effect.andThen(Effect.sync(() => void (failures = 0))))),
    );
  });

  // A failure (the database refusing a commit: a full disk) stops it until it goes again from its last commit, as a
  // restart would, so nothing is lost or journaled twice once the database takes writes again.
  while (true) {
    const exit = yield* Effect.exit(follow);
    if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return;
    failures += 1;
    yield* Effect.logError("session protocol projector stopped; it goes again from its last commit", exit.cause);
    yield* Effect.sleep(Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MOST_MS));
  }
});
