// One row per chat in the sidebar, whatever computer it runs on (S3, S12): the chats of the runtime this window talks
// to directly (This Mac on the desktop), merged with Caveman Cloud's list of every synced chat. A chat both lists know
// is one row: it stays where it was, and says where it runs now. Where a chat runs is a detail, shown as a glyph.
import type { Workspace } from "@caveman-app/session-protocol";
import type { WorkspaceState, WorkspaceView } from "../model.ts";
import type { ChatListSnapshot } from "./chat-list.ts";
import type { CallState, ChatSummary, RuntimeState } from "./wire.ts";

/** Cloud's checks word for a pull request, as the runtime says it; "none" is unknown. */
function checksOf(word: string): { readonly checks: "passing" | "failing" | "pending" } | Record<never, never> {
  return word === "pass" ? { checks: "passing" } : word === "fail" ? { checks: "failing" } : word === "pending" ? { checks: "pending" } : {};
}

/** Where a chat runs, for its row's glyph and its view's state line. */
export interface WhereView {
  readonly kind: "this_mac" | "laptop" | "cloud";
  readonly name: string;
  readonly runtimeId: string;
  readonly computerId: string;
  /** Its runtime answers right now (Cloud's heartbeat view). */
  readonly online: boolean;
  /** A Cloud computer that is asleep (it wakes when someone sends). */
  readonly asleep: boolean;
  /** A Cloud computer on its way up: Cloud says it is starting, or a send waits in Cloud's queue for it, which wakes it. */
  readonly waking?: boolean;
}

/** What Cloud adds to a row: where it runs, the calls queued for it, its read mark. */
export interface SyncedView {
  readonly where: WhereView;
  /** Read from Cloud's list (not this window's runtime): opened through the runtime pool or Cloud's copy. */
  readonly remote: boolean;
  readonly calls: ReadonlyArray<CallState>;
  readonly epoch: number;
  readonly head: number;
  readonly seenCursor: number;
}

export type MergedView = WorkspaceView & { readonly synced?: SyncedView };

const STATE: Record<ChatSummary["status"], WorkspaceState> = {
  idle: "completed",
  working: "working",
  needs_you: "needs_input",
  error: "failed",
};

/**
 * Whether a chat's runtime is on line, by the newest word this device has: the runtime's own change, or the chat's
 * summary when it is newer (a runtime that just took a chat over writes its summary before its own change reaches
 * every device, K11). Undefined when neither says.
 */
export function runtimeOnline(chat: Pick<ChatSummary, "runtime_id" | "where" | "seq">, runtimes: ReadonlyMap<string, RuntimeState>): boolean | undefined {
  const runtime = runtimes.get(chat.runtime_id);
  if (chat.where.online !== undefined && (!runtime || chat.seq > (runtime.seq ?? 0))) return chat.where.online;
  return runtime?.online;
}

/**
 * When Cloud last heard from a runtime, as a string that orders by time: one never heard from (last_seen_at null, a Mac
 * whose link has not run yet) before any heard at all.
 */
export const heardAt = (r: Pick<RuntimeState, "last_seen_at">): string => r.last_seen_at ?? "";

/** `a` is newer word of its computer than `b`: it came on line later, or was heard from later. */
const newerRuntime = (a: RuntimeState, b: RuntimeState) => ((a.seq ?? 0) !== (b.seq ?? 0) ? (a.seq ?? 0) > (b.seq ?? 0) : heardAt(a) > heardAt(b));

/** Each Cloud computer's newest runtime that is on line, by computer id (runtimeNow). */
export function liveRuntimes(runtimes: ReadonlyMap<string, RuntimeState>): ReadonlyMap<string, RuntimeState> {
  const live = new Map<string, RuntimeState>();
  for (const runtime of runtimes.values()) {
    if (runtime.kind !== "cloud" || !runtime.online) continue;
    const best = live.get(runtime.computer_id);
    if (best === undefined || newerRuntime(runtime, best)) live.set(runtime.computer_id, runtime);
  }
  return live;
}

/**
 * The runtime a chat is on now, looked up by its computer. Cloud mints a new runtime id at every wake of a Cloud
 * computer (cloud-computers CONTRACT §5.3), and a chat's summary names the runtime that held it when Cloud last wrote
 * it. So where another runtime of the chat's computer is on line and is the newer word, the chat is there, before its
 * summary says so. A Mac's runtime id is its enrolment, allowed device by device: it is never looked up this way.
 */
export function runtimeNow(chat: Pick<ChatSummary, "runtime_id" | "computer_id" | "where">, runtimes: ReadonlyMap<string, RuntimeState>, live: ReadonlyMap<string, RuntimeState> = liveRuntimes(runtimes)): string {
  if (chat.where.kind !== "cloud") return chat.runtime_id;
  const now = live.get(chat.computer_id);
  if (now === undefined || now.runtime_id === chat.runtime_id) return chat.runtime_id;
  const named = runtimes.get(chat.runtime_id);
  // The runtime its summary names still answers and is the newer word: the chat is where its summary says.
  return named?.online === true && !newerRuntime(now, named) ? chat.runtime_id : now.runtime_id;
}

export function whereOf(chat: Pick<ChatSummary, "runtime_id" | "computer_id" | "where" | "seq"> & Partial<Pick<ChatSummary, "calls">>, runtimes: ReadonlyMap<string, RuntimeState>, homeRuntimeId: string | null): WhereView {
  const runtime = runtimes.get(chat.runtime_id);
  // The window's own Mac is "this_mac" (its rows keep the runtime's own label); every other computer by Cloud's name.
  const kind = chat.where.kind === "cloud" ? "cloud" : chat.runtime_id === homeRuntimeId ? "this_mac" : "laptop";
  const online = runtimeOnline(chat, runtimes) ?? kind === "this_mac";
  return {
    kind,
    name: chat.where.name,
    runtimeId: chat.runtime_id,
    computerId: chat.computer_id,
    online,
    // A chat in Cloud that Cloud names no runtime for is asleep as much as one whose computer Cloud says is suspended:
    // a Cloud computer's runtime ends with its sleep (CONTRACT §5.3), and the list then holds the chat with none.
    asleep: chat.where.kind === "cloud" && (runtime === undefined || runtime.computer_state === "suspended" || runtime.computer_state === "stopped"),
    waking: chat.where.kind === "cloud" && !online && (runtime?.computer_state === "starting" || (chat.calls ?? []).some((c) => c.status === "queued")),
  };
}

/** A Cloud list entry as the screens read a chat. */
export function chatView(chat: ChatSummary, runtimes: ReadonlyMap<string, RuntimeState>, homeRuntimeId: string | null, engineLabel = chat.engine, projectId: string | null = null): MergedView {
  const where = whereOf(chat, runtimes, homeRuntimeId);
  const unread = chat.person.seen_cursor < chat.head;
  const repo = chat.repo ?? "";
  return {
    id: chat.workspace_id,
    title: chat.title,
    // owner/name, as a runtime names a chat on a GitHub repository (runtime.tsx toView): one folder per repository.
    repo,
    repoRef: { url: repo },
    branch: chat.branch ?? null,
    state: chat.archived ? "archived" : STATE[chat.status],
    // On its way up, it is no longer asleep: the row says the one it is.
    asleep: where.asleep && !where.waking,
    ...(where.waking ? { waking: true } : {}),
    detail: null,
    engine: { id: chat.engine, label: engineLabel },
    // The window's own Mac goes by no id here: its runtime names it THIS_MAC_ID, and a this_mac row with another id is
    // a chat it let go to another Mac (runtime.tsx livesHere).
    computer: { kind: where.kind === "cloud" ? "caveman_cloud" : where.kind === "laptop" ? "laptop" : "this_mac", label: where.name, ...(where.computerId && where.kind !== "this_mac" ? { id: where.computerId } : {}) },
    parentId: null,
    sessionId: chat.session_id,
    projectId,
    createdAt: chat.last_activity_at,
    updatedAt: chat.last_activity_at,
    unread,
    ...(chat.preview ? { reply: chat.preview } : {}),
    ...(chat.needs_you
      ? { activity: { ask: { kind: chat.needs_you.kind === "approval" ? "approval" : "question", prompt: chat.needs_you.summary }, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: chat.needs_you.kind === "plan" } }
      : {}),
    ...(chat.pull_request ? { pullRequest: { number: chat.pull_request.number, url: chat.pull_request.url, state: chat.pull_request.state, ...checksOf(chat.pull_request.checks) } } : {}),
    ...(chat.person.pinned || chat.person.done_at || chat.person.snoozed_until
      ? { inbox: { doneAt: chat.person.done_at ?? null, snoozedUntil: chat.person.snoozed_until ?? null, snoozedAt: null, pinnedAt: chat.person.pinned ? chat.last_activity_at : null } }
      : {}),
    synced: { where, remote: true, calls: chat.calls, epoch: chat.epoch, head: chat.head, seenCursor: chat.person.seen_cursor },
  };
}

/**
 * The sidebar's chats: every chat of this window's runtime, then every chat in Cloud's list that runtime does not
 * have, one row per session. A chat in both keeps its local row (fresher, and where the person left it) and takes from
 * Cloud where it runs now, its queued calls, its pull request and the person's marks, which every device shares. A
 * chat that moved away from this runtime (the lid, a Move to) shows Cloud's state: that is where it lives now.
 */
export function mergeChats(
  local: ReadonlyArray<WorkspaceView>,
  list: ChatListSnapshot | null,
  homeRuntimeId: string | null,
  engineLabel?: (id: string) => string,
  /** This window's project for a repository (owner/name): a chat on a Cloud computer sits in the same folder. */
  projectFor?: (repo: string) => string | null,
): ReadonlyArray<MergedView> {
  if (!list || list.chats.size === 0) return local;
  const bySession = new Map<string, ChatSummary>();
  for (const chat of list.chats.values()) {
    // Chief, setup and automation chats have their own pages; builders show under their lead in the runtime's list.
    if (chat.kind === "chief" || chat.kind === "setup" || chat.kind === "automation") continue;
    bySession.set(chat.session_id, chat);
  }
  const out: MergedView[] = [];
  const seen = new Set<string>();
  for (const w of local) {
    const chat = w.sessionId ? bySession.get(w.sessionId) : undefined;
    if (w.sessionId) seen.add(w.sessionId);
    if (!chat) {
      out.push(w);
      continue;
    }
    const remote = chatView(chat, list.runtimes, homeRuntimeId, engineLabel?.(chat.engine));
    const movedAway = chat.runtime_id !== homeRuntimeId;
    // Pins, done and snooze are the person's, kept by Cloud: the runtime's own marks give way. A chat that moved away
    // is what Cloud says of it: this runtime's last turn (the one the move cut, "Stopped") no longer speaks for it.
    const { inbox: _runtimeMarks, activity: localActivity, ...rest } = w;
    // Its latest answer: Cloud's once it moved away (this runtime no longer hears it), else this runtime's, else Cloud's.
    const reply = movedAway ? (remote.reply ?? w.reply) : (w.reply ?? remote.reply);
    out.push({
      ...rest,
      ...(remote.inbox ? { inbox: remote.inbox } : {}),
      ...(movedAway ? { state: remote.state, asleep: remote.asleep, computer: remote.computer, ...(remote.waking ? { waking: true } : {}) } : {}),
      ...((movedAway ? remote.activity : localActivity) ? { activity: (movedAway ? remote.activity : localActivity)! } : {}),
      ...(remote.pullRequest && !w.pullRequest ? { pullRequest: remote.pullRequest } : {}),
      ...(reply ? { reply } : {}),
      // Read marks are the person's, kept by Cloud for every device: read on the phone, read here.
      unread: movedAway ? remote.unread : w.unread && remote.unread,
      synced: { ...remote.synced!, remote: movedAway },
    });
  }
  // A builder sits under its lead, by the lead's workspace on whichever list has it.
  const workspaceOf = new Map<string, string>([...local.flatMap((w) => (w.sessionId ? [[w.sessionId, w.id] as const] : [])), ...[...bySession.values()].map((c) => [c.session_id, c.workspace_id] as const)]);
  for (const chat of bySession.values()) {
    if (seen.has(chat.session_id) || chat.archived) continue;
    const row = chatView(chat, list.runtimes, homeRuntimeId, engineLabel?.(chat.engine), chat.repo ? (projectFor?.(chat.repo) ?? null) : null);
    const lead = chat.parent_session_id ? workspaceOf.get(chat.parent_session_id) : undefined;
    out.push(lead ? { ...row, parentId: lead } : row);
  }
  return out;
}

/** This Mac's record without its worktree and the ports it allocated there: This Mac's alone (protocol.ts root_path). */
const notHere = ({ root_path: _root, ports: _ports, ...rest }: Workspace) => rest;

const WORKSPACE_STATUS: Record<ChatSummary["status"], Workspace["status"]> = { idle: "idle", working: "working", needs_you: "needs_input", error: "failed" };
const workspaces = new WeakMap<ChatSummary, { readonly local: Workspace | undefined; readonly where: string; readonly workspace: Workspace }>();
const formerRoots = new WeakMap<Workspace, string>();

/**
 * The checkout a chat this Mac moved to another computer had here (its parked record's root_path), for the workspace
 * chatWorkspace built for it; null for any other. Its earlier turns name files there, and the moved branch holds them
 * at the same place in its folder, so those paths still read relative to it. Never a folder to copy, reveal or serve.
 */
export function formerRoot(workspace: Workspace | undefined): string | null {
  return (workspace && formerRoots.get(workspace)) ?? null;
}

/**
 * A chat that runs on another computer as the pane reads a workspace: this runtime's record of it when it has one (a
 * chat the lid moved), with where it runs and its state from Cloud's list, which is where it lives now. `lead` is the
 * workspace of the chat that started it (a builder's parent_session_id), as the runtime's own record would name it.
 */
export function chatWorkspace(chat: ChatSummary, where: WhereView, local?: Workspace, lead?: string): Workspace {
  // This runtime's record names its lead when it has one.
  const parent = local?.parent_workspace_id ?? lead;
  const key = `${where.kind}|${where.name}|${where.online}|${parent ?? ""}`;
  const known = workspaces.get(chat);
  if (known && known.local === local && known.where === key) return known.workspace;
  const base: Omit<Workspace, "status" | "computer"> = local ? notHere(local) : {
    id: chat.workspace_id,
    title: chat.title,
    repo: { url: chat.repo ?? "" },
    base_ref: chat.base_branch ?? "",
    branch: chat.branch ?? "",
    engine: chat.engine as Workspace["engine"],
    session_id: chat.session_id,
    created_at: chat.last_activity_at,
    updated_at: chat.last_activity_at,
  };
  const workspace: Workspace = {
    ...base,
    title: chat.title,
    status: chat.archived ? "archived" : WORKSPACE_STATUS[chat.status],
    // Another Mac is never this one: it reads as a computer elsewhere (no local paths, no local desktop).
    computer: { id: chat.computer_id, kind: where.kind === "cloud" ? "caveman_cloud" : "pool", label: where.name, status: where.online ? "online" : "suspended" },
    epoch: chat.epoch,
    head: chat.head,
    synced_through: chat.synced_through,
    ...(chat.asked_by_session_id ? { asked_by_session_id: chat.asked_by_session_id } : {}),
    ...(parent ? { parent_workspace_id: parent } : {}),
    ...(chat.pull_request ? { pull_request: { number: chat.pull_request.number, url: chat.pull_request.url, state: chat.pull_request.state } } : {}),
  };
  if (local?.root_path) formerRoots.set(workspace, local.root_path);
  workspaces.set(chat, { local, where: key, workspace });
  return workspace;
}

const workspaceIndex = new WeakMap<ChatListSnapshot, ReadonlyMap<string, ChatSummary>>();
/** Cloud's list by workspace id (a route names a workspace), once per version of the list. */
function byWorkspace(list: ChatListSnapshot): ReadonlyMap<string, ChatSummary> {
  let index = workspaceIndex.get(list);
  if (!index) workspaceIndex.set(list, (index = new Map([...list.chats.values()].map((c) => [c.workspace_id, c]))));
  return index;
}

/**
 * A chat that runs on another computer, as a pane reads it: from Cloud's list, by the session this window's runtime
 * knows it by (`local`), else by its workspace id. Undefined when this window's own runtime runs it (its record wins)
 * or the list doesn't have it. Its pane, and its side-panel tabs in panes of their own, talk to it through the hub.
 */
export function chatElsewhere(list: ChatListSnapshot | null, homeRuntimeId: string | null, workspaceId: string, local: Workspace | undefined): Workspace | undefined {
  const chat = list ? (local ? list.chats.get(local.session_id) : byWorkspace(list).get(workspaceId)) : undefined;
  if (!list || !chat || (local && chat.runtime_id === homeRuntimeId)) return undefined;
  return chatWorkspace(chat, whereOf(chat, list.runtimes, homeRuntimeId), local);
}

/**
 * Every chat the person has, as a workspace for the needs-you notices, the title count and the Dock badge
 * (notifications.ts), and for the Agents tab's lead and builders: this window's runtime's own chats as it reports them (its pushes are the freshest word), and
 * every other synced chat as Cloud's list has it, keyed by workspace id so one chat is one entry whichever source spoke.
 * A chat that moved away from this runtime is Cloud's: the runtime's parked record no longer says what it does.
 */
export function noticeable(raw: ReadonlyMap<string, Workspace>, list: ChatListSnapshot | null, homeRuntimeId: string | null): ReadonlyMap<string, Workspace> {
  if (!list || list.chats.size === 0) return raw;
  const out = new Map(raw);
  const workspaceOf = new Map<string, string>([...[...raw.values()].map((w) => [w.session_id, w.id] as const), ...[...list.chats.values()].map((c) => [c.session_id, c.workspace_id] as const)]);
  for (const chat of list.chats.values()) {
    if (chat.kind !== "chat" && chat.kind !== "builder") continue;
    const local = raw.get(chat.workspace_id);
    if (local && chat.runtime_id === homeRuntimeId) continue;
    const lead = chat.parent_session_id ? workspaceOf.get(chat.parent_session_id) : undefined;
    const w = chatWorkspace(chat, whereOf(chat, list.runtimes, homeRuntimeId), local, lead);
    // Cloud's word on when it last changed: a status change bumps it, so a newer runtime record never hides it.
    out.set(chat.workspace_id, chat.last_activity_at > w.updated_at ? { ...w, updated_at: chat.last_activity_at } : w);
  }
  return out;
}
