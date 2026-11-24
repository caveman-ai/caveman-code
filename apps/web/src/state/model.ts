// View models the screens render. The runtime connection (state/runtime.ts)
// builds them from Session Protocol v1; screens never read wire types.

export type WorkspaceState = "needs_input" | "working" | "queued" | "completed" | "failed" | "archived";

export type ComputerKind = "this_mac" | "laptop" | "caveman_cloud" | "pool";

export interface WorkspaceView {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  /** The repository as the runtime names it (Session Protocol Repo): what its secrets are stored under. */
  readonly repoRef: { readonly path: string } | { readonly url: string };
  readonly branch: string | null;
  readonly state: WorkspaceState;
  /** Parked: its computer sleeps until the next message (shown with the sleeping mark). */
  readonly asleep: boolean;
  /** Its place in Cloud is on its way up for a message that was sent (sync/chats-view.ts WhereView.waking). */
  readonly waking?: boolean;
  /** One plain line under the title: "running tests", "PR #4182 in review". */
  readonly detail: string | null;
  /** Its latest answer as plain text on one line (Workspace.activity.last_reply, or Cloud's preview): what a queue row says under its title. */
  readonly reply?: string;
  readonly engine: { readonly id: string; readonly label: string };
  /**
   * Where it runs. `id`: the computer's, as the runtime names it (its own computer: THIS_MAC_ID), or as Cloud names
   * another computer (Settings > Computers lists a Cloud computer's chats by it); absent for the window's own Mac in
   * Cloud's list.
   */
  readonly computer: { readonly kind: ComputerKind; readonly label: string; readonly id?: string };
  readonly parentId: string | null;
  /** An automation run's step or check: opened from the run view, never a row in the chat sidebar. */
  readonly automationStep?: boolean;
  readonly sessionId: string | null;
  /** The project (sidebar folder) it was started in; null when the runtime names none. */
  readonly projectId: string | null;
  /** The larger piece of work it belongs to (Workspace.topic): its group in the sidebar by topic; absent in none. */
  readonly topic?: string;
  /** Its topic's emoji (Workspace.topic_icon), the group's mark; absent when the topic has none. */
  readonly topicIcon?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Something happened since the user last opened it. */
  readonly unread: boolean;
  /** Its engine's own subagents (Workspace.subagents), which run inside its transcript. */
  readonly subagents?: ReadonlyArray<NativeSubagentView>;
  /** What its latest turn is at (Workspace.activity); absent from a runtime that does not project it. */
  readonly activity?: ActivityView;
  /** Its branch's pull request (Workspace.pull_request), for the queue's pill; absent when there is none. */
  readonly pullRequest?: PullRequestView;
  /** What its worktree holds that its base does not (Workspace.unmerged): uncommitted files, commits; absent when nothing. */
  readonly unmerged?: { readonly files: number; readonly commits: number };
  /**
   * A chat that works in several sources of its project (Workspace.source and checkouts): each one, the primary
   * first, with its own pull request and what it holds that its base does not. Absent for a chat in one source,
   * whose `pullRequest` and `unmerged` say it all.
   */
  readonly sources?: ReadonlyArray<SourceView>;
  /** Done, snoozed or pinned (Workspace.inbox; state/inbox-state.ts reads it); absent when none of them. */
  readonly inbox?: InboxView;
  /** The outside agent that started it through `caveman-code mcp` (Workspace.started_by): its name; absent for the person's own. */
  readonly startedBy?: string;
  /** How to serve what it built (Workspace.preview, its agent's register_preview): its Open preview chip. */
  readonly preview?: { readonly command: string; readonly path: string };
}

/**
 * Who runs a chat, as its meta says it: the engine's label, then the outside agent that started it beside it, never in
 * its place ("Claude Agent · Claude Code"), so an agent's name never stands where the engine's does.
 */
export function engineLine(w: Pick<WorkspaceView, "startedBy">, engineLabel: string): string {
  return w.startedBy ? `${engineLabel} · ${w.startedBy}` : engineLabel;
}

/** Workspace.inbox as the screens read it. Its read mark is in `unread`. */
export interface InboxView {
  readonly doneAt: string | null;
  readonly snoozedUntil: string | null;
  readonly snoozedAt: string | null;
  readonly pinnedAt: string | null;
}

/** One source of a chat in several, as the queue's pills read it. */
export interface SourceView {
  /** Its name in the project: the folder its checkout sits in under the chat's folder. */
  readonly name: string;
  readonly pullRequest?: PullRequestView;
  readonly unmerged?: { readonly files: number; readonly commits: number };
  /** Its repository (owner/name) and host, which Review reads its pull request through; absent for the primary, which is the project's own. */
  readonly repo?: string;
  readonly host?: string;
}

export interface PullRequestView {
  readonly number: number;
  readonly url: string;
  readonly state: "draft" | "open" | "merged" | "closed";
  /** Its checks on the head commit, when known. */
  readonly checks?: "passing" | "failing" | "pending";
  /** Its review decision, when known. */
  readonly review?: "approved" | "changes_requested" | "review_required";
  /**
   * While its checks fail: those failures set against its base branch's CI (Workspace.pull_request.base_ci). `on_base`
   * are the failing checks that fail on `base` too; `base_state` is CI on the base's head now.
   */
  readonly base_ci?: {
    readonly base: string;
    readonly failing: ReadonlyArray<string>;
    readonly on_base: ReadonlyArray<string>;
    readonly base_state: "passing" | "failing" | "pending" | "unknown";
  };
}

/** Workspace.activity as the screens read it: the runtime folds it from the chat's journal, so a row never attaches the session to know. */
export interface ActivityView {
  /** The ask it waits on (status needs_input): an approval, a question or a key, and one line of it. */
  readonly ask: { readonly kind: "question" | "approval" | "secret" | "tool"; readonly prompt: string } | null;
  /** When the running turn started. */
  readonly turnStartedAt: string | null;
  readonly lastOutcome: "completed" | "interrupted" | "failed" | null;
  /** When the latest finished turn ended; null before the runtime stamped it. */
  readonly turnEndedAt: string | null;
  /**
   * Its turn ended but it still waits on work that will wake it: a delegated agent, background work it marked, a pull
   * request it watches (Workspace.activity.awaiting). Absent from a runtime that does not say.
   */
  readonly awaiting?: boolean;
  /** The latest todo list: steps done and in all. */
  readonly todos: { readonly done: number; readonly total: number } | null;
  /** Grill mode finished its decisions doc: the plan waits to be built. */
  readonly readyToBuild: boolean;
}

/**
 * A chat's one status, the same on every row that shows it (sidebar, queue, inbox). upstream resolves a
 * thread's pill the same way (Sidebar.logic.ts resolveThreadStatusPill @ ab3a3cd1: Pending Approval,
 * Awaiting Input, Working, Waiting, Plan Ready, Completed); ours also tells an approval from a question
 * from a missing key, says a lead is waiting on its agents, and carries the turn's clock and todos.
 */
export type ChatStatusId = "approve" | "secret" | "answer" | "ready" | "failed" | "working" | "agents" | "queued" | "done" | "stopped" | "waking" | "asleep";

export interface ChatStatus {
  readonly id: ChatStatusId;
  /** The word a row shows: "Approve", "Working", "Ready to build". */
  readonly label: string;
  /** One more line for its tooltip: the ask itself, "3 of 5 steps, 2 agents at work". */
  readonly detail: string | null;
  /** It waits on the person: the row says its label, a filter's Needs you finds it. */
  readonly action: boolean;
  /** A working turn's start, for its clock. */
  readonly since: string | null;
  /** A working turn's todos, for "3/5". */
  readonly progress: { readonly done: number; readonly total: number } | null;
  /** Its agents at work (`agentsAtWork`). */
  readonly agents: number;
}

/** Most pressing first: a closed folder shows the first of its chats' statuses in this order. */
export const CHAT_STATUS_ORDER: ReadonlyArray<ChatStatusId> = ["approve", "secret", "answer", "ready", "failed", "working", "agents", "queued", "done", "stopped", "waking", "asleep"];

/** Its agents at work: builders and delegated agents under it (`children`, any depth) and its own native subagents. */
export function agentsAtWork(w: WorkspaceView, children: ReadonlyArray<WorkspaceView>): number {
  return children.filter((c) => c.state === "working" || c.state === "needs_input").length + (w.subagents ?? []).filter((s) => s.state === "working").length;
}

/**
 * What a chat is at, or null when there is nothing to say (finished and read). `agents` is
 * `agentsAtWork`: a lead whose own turn ended while they still work is waiting on them, not done. So is a chat the
 * runtime says awaits (`activity.awaiting`: work that will wake it, its agents among it): waiting on its agents when
 * the list shows them, else on background work it started (a task, a pull request it watches), at work all the same.
 */
export function chatStatus(w: WorkspaceView, agents = 0): ChatStatus | null {
  const a = w.activity;
  const none = { detail: null, action: false, since: null, progress: null, agents };
  if (w.state === "archived") return null;
  // An ask inside one of its native subagents leaves the chat's status at working; the open ask still waits on the person.
  if (w.state === "needs_input" || (w.state === "working" && a?.ask)) {
    const ask = a?.ask ?? null;
    if (ask?.kind === "approval") return { ...none, id: "approve", label: "Approve", detail: ask.prompt, action: true };
    if (ask?.kind === "secret") return { ...none, id: "secret", label: "Needs a key", detail: ask.prompt, action: true };
    return { ...none, id: "answer", label: ask ? "Answer" : "Needs you", detail: ask?.prompt ?? null, action: true };
  }
  const atWork = agents > 0 ? `${agents} ${agents === 1 ? "agent" : "agents"} at work` : null;
  if (w.state === "working") {
    const todos = a?.todos && a.todos.total > 0 ? a.todos : null;
    const detail = [todos ? `${todos.done} of ${todos.total} steps` : null, atWork].filter(Boolean).join(", ");
    return { ...none, id: "working", label: "Working", detail: detail || null, since: a?.turnStartedAt ?? w.updatedAt, progress: todos };
  }
  if (agents > 0 && w.state !== "failed") return { ...none, id: "agents", label: "Waiting on agents", detail: atWork };
  if (a?.awaiting && w.state !== "failed") return { ...none, id: "working", label: "Waiting", detail: "on background work" };
  if (a?.readyToBuild) return { ...none, id: "ready", label: "Ready to build", detail: "Its decisions doc is written", action: true };
  if (w.state === "failed") return { ...none, id: "failed", label: "Failed", detail: "Its last turn ended in an error" };
  // Where it runs: Cloud on its way up for a send (never a turn yet), or asleep until one.
  if (w.waking) return { ...none, id: "waking", label: "Waking…" };
  if (w.asleep) return { ...none, id: "asleep", label: "Asleep" };
  if (w.state === "queued") return { ...none, id: "queued", label: "Queued" };
  if (!w.unread) return null;
  // "Finished", not "Done": Done is the person's word for a chat they are through with (the queue's Done shelf).
  return a?.lastOutcome === "interrupted" ? { ...none, id: "stopped", label: "Stopped" } : { ...none, id: "done", label: "Finished" };
}

/**
 * Where a chat stands, the queue's sections. Needs you: it asks (an approval, a question, a key), or its last turn
 * failed and nobody has looked. Working: its turn, its agents, or a message waiting to start. Ready for review: its
 * turn ended and its work is not on its base yet (hasWorkToLand), or a plan waits to be built. Done: nothing left
 * for the person.
 */
export type ChatStage = "needs" | "working" | "review" | "done";

const ASKS: ReadonlySet<ChatStatus["id"]> = new Set(["approve", "answer", "secret"]);
const AT_WORK: ReadonlySet<ChatStatus["id"]> = new Set(["working", "agents", "queued"]);

export function chatStage(status: ChatStatus | null, w: Pick<WorkspaceView, "unread" | "pullRequest" | "unmerged" | "sources">): ChatStage {
  if (status && (ASKS.has(status.id) || (status.id === "failed" && w.unread))) return "needs";
  if (status && AT_WORK.has(status.id)) return "working";
  if (status?.id === "ready" || hasWorkToLand(w)) return "review";
  return "done";
}

/**
 * Its work is not on its base yet: a pull request still open, or, with none merged or closed, uncommitted files or
 * commits of its own (Workspace.unmerged). A merged pull request has landed even when its squashed commits still
 * read as ahead.
 */
export function hasWorkToLand(w: Pick<WorkspaceView, "pullRequest" | "unmerged" | "sources">): boolean {
  // A chat in several sources has work to land while any one of them does.
  if (w.sources) return w.sources.some(landing);
  return landing(w);
}

function landing(w: Pick<WorkspaceView, "pullRequest" | "unmerged">): boolean {
  const pr = w.pullRequest?.state;
  if (pr === "open" || pr === "draft") return true;
  if (pr === "merged" || pr === "closed") return false;
  return (w.unmerged?.files ?? 0) + (w.unmerged?.commits ?? 0) > 0;
}

/**
 * What a chat's work holds that no pull request speaks for yet: its own `unmerged`, or for a chat in several sources
 * the sum over the sources that have no pull request. Undefined when nothing.
 */
export function unmergedWork(w: Pick<WorkspaceView, "pullRequest" | "unmerged" | "sources">): WorkspaceView["unmerged"] {
  if (!w.sources) return w.pullRequest ? undefined : w.unmerged;
  const open = w.sources.filter((s) => !s.pullRequest);
  const files = open.reduce((n, s) => n + (s.unmerged?.files ?? 0), 0);
  const commits = open.reduce((n, s) => n + (s.unmerged?.commits ?? 0), 0);
  return files + commits > 0 ? { files, commits } : undefined;
}

/** Every chat's status, each counting the agents under it from the list itself. */
export function chatStatuses(workspaces: ReadonlyArray<WorkspaceView>): Map<string, ChatStatus | null> {
  const under = new Map<string, WorkspaceView[]>();
  for (const w of workspaces) if (w.parentId && w.state !== "archived") under.set(w.parentId, [...(under.get(w.parentId) ?? []), w]);
  const below = (id: string, seen: Set<string>): WorkspaceView[] =>
    (under.get(id) ?? []).flatMap((c) => {
      if (seen.has(c.id)) return [];
      seen.add(c.id);
      return [c, ...below(c.id, seen)];
    });
  return new Map(workspaces.map((w) => [w.id, chatStatus(w, agentsAtWork(w, below(w.id, new Set([w.id]))))]));
}

/** The most pressing of several statuses (a closed folder's chats), or null. */
export function firstStatus(statuses: ReadonlyArray<ChatStatus | null>): ChatStatus | null {
  let best: ChatStatus | null = null;
  for (const s of statuses) if (s && (!best || CHAT_STATUS_ORDER.indexOf(s.id) < CHAT_STATUS_ORDER.indexOf(best.id))) best = s;
  return best;
}

/** What the sidebar shows (its filter): every chat, the ones waiting on the person, the ones at work, or the unread. */
export type ChatFilter = "all" | "needs" | "working" | "unread";

export function passesFilter(filter: ChatFilter, w: WorkspaceView, status: ChatStatus | null): boolean {
  switch (filter) {
    case "all":
      return true;
    case "needs":
      return chatStage(status, w) === "needs";
    case "working":
      return chatStage(status, w) === "working";
    case "unread":
      return w.unread;
  }
}

/**
 * The sidebar's folders under its filter: a lead stays when it or an agent under it passes, a project
 * scope keeps that project's folder alone (empty or not), and while a filter is on, folders left
 * with no chats drop out.
 */
/** The projects the sidebar's filter kept on this device: `projects`, or an older build's single `project`. */
export function storedFilterProjects(saved: { readonly project?: unknown; readonly projects?: unknown } | null): string[] {
  if (Array.isArray(saved?.projects)) return [...new Set(saved.projects.filter((p): p is string => typeof p === "string"))];
  return typeof saved?.project === "string" ? [saved.project] : [];
}

/** The picked projects with `id` added or taken out. */
export function toggleFilterProject(projects: ReadonlyArray<string>, id: string): string[] {
  return projects.includes(id) ? projects.filter((p) => p !== id) : [...projects, id];
}

/** Where a filtered list is from, as its line says it: "app", "app and site", "3 projects". */
export function filterProjectsLabel(names: ReadonlyArray<string>): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return names[0]!;
  if (names.length === 2) return `${names[0]} and ${names[1]}`;
  return `${names.length} projects`;
}

export function filterFolders(folders: ReadonlyArray<SidebarFolder>, filter: ChatFilter, projectIds: ReadonlyArray<string>, statuses: ReadonlyMap<string, ChatStatus | null>): ReadonlyArray<SidebarFolder> {
 // No project picked: every one (upstream #25284 lets several be picked at once).
  if (filter === "all" && projectIds.length === 0) return folders;
  const scoped = projectIds.length === 0 ? folders : folders.filter((f) => projectIds.includes(f.project.id));
  if (filter === "all") return scoped;
  const passes = (w: WorkspaceView) => passesFilter(filter, w, statuses.get(w.id) ?? null);
  return scoped.map((f) => ({ ...f, rows: f.rows.filter((r) => passes(r.workspace) || r.children.some(passes)) })).filter((f) => f.rows.length > 0);
}

/**
 * A native subagent: the engine's own (Claude's Agent tool, Codex's collab agents). It is a row of
 * its chat's transcript, never a chat, so opening it opens that chat at its row.
 */
export interface NativeSubagentView {
  /** Its row in the chat's transcript (the subagent.started item). */
  readonly itemId: string;
  /** The native subagent that started it. */
  readonly parentItemId: string | null;
  readonly title: string;
  /** The engine running it, for its logo. */
  readonly engine: string;
  readonly state: "working" | "completed" | "failed" | "stopped";
  readonly startedAt: string;
  /** When it stopped working; null while it works, and on one listed before the runtime stamped it. */
  readonly endedAt: string | null;
}

/** Waits on the person: a question, or finished or failed work they have not opened since. The inbox and its count. */
export function awaitsYou(w: WorkspaceView): boolean {
  return w.state === "needs_input" || ((w.state === "completed" || w.state === "failed") && w.unread);
}

/** A workspace under a lead: a builder or a delegated agent, `depth` 1 for the lead's own, 2 for theirs. */
export type ChildView = WorkspaceView & { readonly depth: number };

export interface SidebarRow {
  readonly workspace: WorkspaceView;
  /** Everything under it, each after its own parent. */
  readonly children: ReadonlyArray<ChildView>;
}

/** Most recently active first; chats active at the same moment by id, so the order is the same every time. */
const byActivity = (a: Pick<WorkspaceView, "updatedAt" | "id">, b: Pick<WorkspaceView, "updatedAt" | "id">) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/**
 * Most recently started first; chats started at the same moment by id, so the order is the same every time. A project's
 * chats keep this order: a reply or a status change never moves a row, only a new chat comes in at the top.
 */
const byStart = (a: Pick<WorkspaceView, "createdAt" | "id">, b: Pick<WorkspaceView, "createdAt" | "id">) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);

/**
 * Leads (workspaces whose parent is not among `workspaces`) with everything under them, each child
 * after its parent, siblings most recently started first (`byStart`).
 */
export function leadsWithChildren(workspaces: ReadonlyArray<WorkspaceView>): Array<{ lead: WorkspaceView; children: ChildView[] }> {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  const under = new Map<string, WorkspaceView[]>();
  const leads: WorkspaceView[] = [];
  for (const w of workspaces) {
    if (w.parentId && byId.has(w.parentId)) under.set(w.parentId, [...(under.get(w.parentId) ?? []), w]);
    else leads.push(w);
  }
  const walk = (id: string, depth: number, out: ChildView[], seen: Set<string>): ChildView[] => {
    for (const child of (under.get(id) ?? []).sort(byStart)) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      out.push({ ...child, depth });
      walk(child.id, depth + 1, out, seen);
    }
    return out;
  };
  return leads.sort(byStart).map((lead) => ({ lead, children: walk(lead.id, 1, [], new Set([lead.id])) }));
}

/** A row under a lead: an agent's chat (a builder, a delegated agent), or a native subagent that opens in its chat at its row. */
export type AgentRow =
  | { readonly kind: "chat"; readonly id: string; readonly depth: number; readonly workspace: ChildView }
  | { readonly kind: "subagent"; readonly id: string; readonly depth: number; readonly workspaceId: string; readonly subagent: NativeSubagentView };

/**
 * Everything under a lead, as the sidebar folds it: its agents' chats (`children`, each after its
 * parent) and the native subagents of the lead and of each of those chats, each after the chat or
 * subagent that started it. Siblings most recently started first.
 */
export function agentRows(lead: WorkspaceView, children: ReadonlyArray<ChildView>): AgentRow[] {
  const native = (owner: WorkspaceView, depth: number): Array<{ at: string; rows: AgentRow[] }> => {
    const list = owner.subagents ?? [];
    const known = new Set(list.map((s) => s.itemId));
    const under = (parent: string | null) =>
      list.filter((s) => (s.parentItemId !== null && known.has(s.parentItemId) ? s.parentItemId : null) === parent).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    const walk = (s: NativeSubagentView, d: number, seen: Set<string>): AgentRow[] => {
      if (seen.has(s.itemId)) return [];
      seen.add(s.itemId);
      return [{ kind: "subagent", id: `${owner.id}:${s.itemId}`, depth: d, workspaceId: owner.id, subagent: s }, ...under(s.itemId).flatMap((c) => walk(c, d + 1, seen))];
    };
    const seen = new Set<string>();
    return under(null).map((s) => ({ at: s.startedAt, rows: walk(s, depth, seen) }));
  };
  const chats: Array<{ at: string; rows: AgentRow[] }> = [];
  for (const child of children) {
    const rows: AgentRow[] = [{ kind: "chat", id: child.id, depth: child.depth, workspace: child }, ...native(child, child.depth + 1).flatMap((g) => g.rows)];
    // A lead's own agent starts a group; that agent's own agents stay in it.
    const group = chats.at(-1);
    if (child.depth === 1 || !group) chats.push({ at: child.createdAt, rows });
    else group.rows.push(...rows);
  }
  return [...native(lead, 1), ...chats].sort((a, b) => b.at.localeCompare(a.at)).flatMap((g) => g.rows);
}

/** An agent that still works or waits on the person. */
export function agentLive(row: AgentRow): boolean {
  return row.kind === "chat" ? row.workspace.state === "working" || row.workspace.state === "needs_input" : row.subagent.state === "working";
}

/** A lead's agent rows in trees: each of the lead's own agents with everything under it. */
function agentTrees(rows: ReadonlyArray<AgentRow>): AgentRow[][] {
  const trees: AgentRow[][] = [];
  for (const row of rows) {
    if (row.depth === 1 || trees.length === 0) trees.push([row]);
    else trees.at(-1)!.push(row);
  }
  return trees;
}

/**
 * A lead's agent rows (`agentRows`) split as the sidebar shows them: the lead's own agents still at
 * work, each with everything under it (finished or not, so its tree stays whole), then the finished
 * ones. Order is kept within each.
 */
export function liveAndDone(rows: ReadonlyArray<AgentRow>): { live: AgentRow[]; done: AgentRow[] } {
  const trees = agentTrees(rows);
  const live = trees.filter((g) => g.some(agentLive));
  return { live: live.flat(), done: trees.filter((g) => !live.includes(g)).flat() };
}

/** How long the sidebar keeps a finished agent under its lead. Its chat's Agents panel lists it for good. */
export const AGENT_LINGER_MS = 10 * 60_000;

/**
 * When an agent finished, in ms, or null while it works, waits on the person or is queued to run. A
 * delegated agent's chat (finished, failed or parked) last changed when its run ended; a native
 * subagent listed before the runtime stamped its end counts from its start.
 */
function agentEnded(row: AgentRow): number | null {
  if (row.kind === "chat") {
    const w = row.workspace;
    return w.state === "completed" || w.state === "failed" || (w.state === "queued" && w.asleep) ? Date.parse(w.updatedAt) : null;
  }
  return row.subagent.state === "working" ? null : Date.parse(row.subagent.endedAt ?? row.subagent.startedAt);
}

/**
 * A lead's agent rows without the ones long done: a tree (one of the lead's own agents and
 * everything under it) leaves once every agent in it finished `AGENT_LINGER_MS` before `now`, unless
 * it holds `open` (the chat on screen). `next` is when the next tree still shown would leave, for
 * the caller to look again then; null when none will.
 */
export function recentAgents(rows: ReadonlyArray<AgentRow>, now: number, open?: string): { rows: AgentRow[]; next: number | null } {
  let next: number | null = null;
  const kept = agentTrees(rows).filter((tree) => {
    if (open !== undefined && tree.some((a) => a.kind === "chat" && a.id === open)) return true;
    const ends = tree.map(agentEnded);
    if (ends.some((end) => end === null)) return true;
    const leaves = Math.max(...(ends as number[])) + AGENT_LINGER_MS;
    if (leaves <= now) return false;
    next = next === null ? leaves : Math.min(next, leaves);
    return true;
  });
  return { rows: kept.flat(), next };
}

/** A sidebar folder: a project, or, for workspaces whose project the runtime did not list, their repo (`path` null). */
export interface ProjectView {
  readonly id: string;
  readonly name: string;
  readonly path: string | null;
  /** Its repository on GitHub (or another host), when the checkout has an origin. */
  readonly repository?: RepositoryView;
  /** A plain folder in no git repository (Project.no_git): its chats run in it, with no branch. */
  readonly no_git?: true;
  /** When it was pinned (Project.pinned_at): its folder leads the list. */
  readonly pinnedAt?: string;
  /** When it was archived (Project.archived_at): its folder shows, last, only while it has live chats. */
  readonly archivedAt?: string;
  /** Its mark, drawn in place of the folder (Project.logo); absent: the folder. */
  readonly logo?: ProjectLogoView;
  /** How its logo is chosen (Project.logo_mode): the folder, or the person's image; absent: what the checkout shows. */
  readonly logoMode?: "none" | "picked";
}

/** A project's logo (Project.logo): its image's id (project.logo.read has the image), its file, and whether it was found (`auto`). */
export interface ProjectLogoView {
  readonly id: string;
  readonly path?: string;
  readonly auto?: true;
}

/** The project fields the sidebar and the pickers order by: the wire's Project has them all. */
export interface OrganizedProject {
  readonly id: string;
  readonly pinned_at?: string;
  readonly archived_at?: string;
}

/** Pinned projects in the order they were pinned, then the rest in the order given. */
export function pinnedFirst<P extends OrganizedProject>(projects: ReadonlyArray<P>): P[] {
  const pinned = projects.filter((p) => p.pinned_at && !p.archived_at).sort((a, b) => a.pinned_at!.localeCompare(b.pinned_at!));
  return [...pinned, ...projects.filter((p) => !pinned.includes(p))];
}

/**
 * The projects a picker offers (upstream pickableProjectGroups): archived ones left out, unless it is the one already
 * picked (`keep`), and pinned ones first.
 */
export function pickableProjects<P extends OrganizedProject>(projects: ReadonlyArray<P>, keep?: string | null): P[] {
  return pinnedFirst(projects.filter((p) => !p.archived_at || p.id === keep));
}

/**
 * The sidebar's Archived projects: archived ones with no folder in `folders` (no live chat left outside Pinned),
 * most recently archived first.
 */
export function archivedProjects<P extends OrganizedProject>(projects: ReadonlyArray<P>, folders: ReadonlyArray<SidebarFolder>): P[] {
  const shown = new Set(folders.map((f) => f.project.id));
  return projects.filter((p) => p.archived_at && !shown.has(p.id)).sort((a, b) => b.archived_at!.localeCompare(a.archived_at!));
}

export interface RepositoryView {
  readonly host: string;
  /** owner/name. */
  readonly full_name: string;
  readonly web_url: string;
}

export interface SidebarFolder {
  readonly project: ProjectView;
  /** Leads with their builders nested under them, most recently started first. */
  readonly rows: ReadonlyArray<SidebarRow>;
  /** Workspaces in the folder, builders included. */
  readonly count: number;
}

/**
 * Every project as a folder holding its workspaces. A builder sits under its
 * lead; one whose lead is archived or missing stands on its own. Archived
 * workspaces are left out. Pinned projects come first, in the order they were
 * pinned, with or without chats. Then folders whose newest workspace was
 * started last (starting one moves a folder up; work in progress never
 * reshuffles them), then empty projects in the order they were added. An
 * archived project keeps a folder, last, only while it has live chats; with
 * none it is in `archivedProjects` instead.
 */
export function foldersForSidebar(
  projects: ReadonlyArray<{ readonly id: string; readonly name: string; readonly path: string; readonly repository?: RepositoryView; readonly no_git?: true; readonly pinned_at?: string; readonly archived_at?: string; readonly logo?: ProjectLogoView; readonly logo_mode?: "none" | "picked" }>,
  workspaces: ReadonlyArray<WorkspaceView>,
): SidebarFolder[] {
  const live = workspaces.filter((w) => w.state !== "archived");
  const folders = new Map<string, { project: ProjectView; rows: SidebarRow[]; count: number; newest: string; added: number }>(
    projects.map((p, added) => [
      p.id,
      {
        project: { id: p.id, name: p.name, path: p.path, ...(p.repository ? { repository: p.repository } : {}), ...(p.no_git ? { no_git: true as const } : {}), ...(p.pinned_at ? { pinnedAt: p.pinned_at } : {}), ...(p.archived_at ? { archivedAt: p.archived_at } : {}), ...(p.logo ? { logo: p.logo } : {}), ...(p.logo_mode ? { logoMode: p.logo_mode } : {}) },
        rows: [],
        count: 0,
        newest: "",
        added,
      },
    ]),
  );
  const known = new Set(projects.map((p) => p.id));
  for (const { lead: root, children: kids } of leadsWithChildren(live)) {
    const id = root.projectId && known.has(root.projectId) ? root.projectId : `repo:${root.repo}`;
    let folder = folders.get(id);
    // A chat in a plain folder on another computer: Cloud holds no name for the folder, so its group says what it is.
    if (!folder) folders.set(id, (folder = { project: { id, name: root.repo || "No repository", path: null }, rows: [], count: 0, newest: "", added: projects.length }));
    folder.rows.push({ workspace: root, children: kids });
    folder.count += 1 + kids.length;
    for (const w of [root, ...kids]) if (w.createdAt > folder.newest) folder.newest = w.createdAt;
  }
  // Pinned first (by when), then the rest, then archived ones still holding chats. Archived outranks pinned.
  const rank = (p: ProjectView) => (p.archivedAt ? 2 : p.pinnedAt ? 0 : 1);
  return [...folders.values()]
    .filter((f) => !f.project.archivedAt || f.rows.length > 0)
    .sort((a, b) => rank(a.project) - rank(b.project) || (a.project.pinnedAt && b.project.pinnedAt ? a.project.pinnedAt.localeCompare(b.project.pinnedAt) : 0) || b.newest.localeCompare(a.newest) || a.added - b.added)
    .map(({ project, rows, count }) => ({ project, rows, count }));
}

/** Show more's cutoff (`folderShowMore`): the row it opened down to, by when it was started and its id. */
export interface FolderCutoff {
  readonly since: string;
  readonly id: string;
}

/** A chat's row in the sidebar by topic, with its project (the hover card says which). */
export type TopicRow = SidebarRow & { readonly project: ProjectView };

/**
 * Where a chat stands in the sidebar by topic, on the queue's shelves (inbox-state.ts chatLife): live while the queue
 * would show it on Pinned, Needs you, Working or Ready for review; done once someone calls it done; or snoozed.
 */
export type ChatLife = "live" | "done" | "snoozed";

/**
 * One item of the sidebar by topic: an open group (two or more chats sharing a topic) or a live chat in none. `key` is
 * what the person's arrangement keeps: "g:<topic>" or "c:<chat id>".
 */
export type TopicItem = TopicGroupItem | { readonly kind: "chat"; readonly key: string; readonly row: TopicRow };

export interface TopicGroupItem {
  readonly kind: "group";
  readonly key: string;
  readonly topic: string;
  /** The emoji most of its chats carry (Workspace.topic_icon); absent when none has one. */
  readonly icon?: string;
  /** Pinned by the person (TopicMarks.pinned): on top, and never closes. */
  readonly pinned: boolean;
  /** Its live chats, in the person's order. */
  readonly rows: ReadonlyArray<TopicRow>;
  /** The rest, folded behind one line: its done chats, then its snoozed ones, each in the person's order. */
  readonly rest: ReadonlyArray<TopicRow>;
  readonly done: number;
  readonly snoozed: number;
}

/** A group with nothing live in it: in Closed groups at the foot of the sidebar, newest first. */
export interface ClosedGroup {
  /** Its group key, "g:<topic>", what the Closed groups shelf knows it by. */
  readonly id: string;
  readonly topic: string;
  readonly icon?: string;
  /** Every chat in it, in the person's order. */
  readonly rows: ReadonlyArray<TopicRow>;
  /** When its last chat was active. */
  readonly at: string;
}

/** The sidebar by topic: its list in the person's order, and at its foot what is over. */
export interface TopicView {
  /** Pinned groups first, then open groups and live loose chats, in the person's order. */
  readonly items: ReadonlyArray<TopicItem>;
  readonly closed: ReadonlyArray<ClosedGroup>;
  /** Loose chats that are over: the Done and Snoozed shelves, most recently active first. */
  readonly done: ReadonlyArray<TopicRow>;
  readonly snoozed: ReadonlyArray<TopicRow>;
  /**
   * Every key in the order shown: each item, a group's chats after it (its folded ones after its live ones), and a
   * closed group, with its chats, in the place it keeps while closed. What a first drag writes as the order (moveKeys).
   */
  readonly shown: ReadonlyArray<string>;
}

/** The person's marks on groups, kept on this device by topic: pinned on top, and reopened (kept open until closed). */
export interface TopicMarks {
  readonly pinned: ReadonlySet<string>;
  readonly kept: ReadonlySet<string>;
}

/**
 * The person's marks after group `from` takes the name `to` (a rename, or a merge into a group already called that), or
 * none (null: an ungroup). `from`'s marks go, and `to` keeps each mark either group had.
 */
export function carryMarks(marks: TopicMarks, from: string, to: string | null): TopicMarks {
  const carry = (set: ReadonlySet<string>) => {
    const next = new Set(set);
    next.delete(from);
    if (to !== null && (set.has(from) || set.has(to))) next.add(to);
    return next;
  };
  return { pinned: carry(marks.pinned), kept: carry(marks.kept) };
}

/**
 * The marks while group `from` is being renamed `to`: `to` takes every mark `from` has and `from` keeps them, so the
 * group is marked under either name while its chats move (carryMarks settles it after).
 */
export function shareMarks(marks: TopicMarks, from: string, to: string): TopicMarks {
  const share = (set: ReadonlySet<string>) => (set.has(from) ? new Set([...set, to]) : set);
  return { pinned: share(marks.pinned), kept: share(marks.kept) };
}

export const chatKey = (id: string) => `c:${id}`;
export const groupKey = (topic: string) => `g:${topic}`;

/**
 * In the person's order (`order`, keys as TopicItem's), what it does not name yet first, most recently active first:
 * a new chat or group comes in at the top and nothing the person arranged moves.
 */
function arranged<T extends { readonly key: string; readonly at: string }>(items: ReadonlyArray<T>, order: ReadonlyArray<string>): T[] {
  const rank = new Map(order.map((key, i) => [key, i]));
  return [...items].sort((a, b) => {
    const ra = rank.get(a.key);
    const rb = rank.get(b.key);
    if (ra === undefined || rb === undefined) return ra === rb ? b.at.localeCompare(a.at) : ra === undefined ? -1 : 1;
    return ra - rb;
  });
}

/** The emoji most of `rows` carry, the newest chat's on a tie; undefined when none has one. */
function groupIcon(rows: ReadonlyArray<TopicRow>): string | undefined {
  const counts = new Map<string, { n: number; at: string }>();
  for (const { workspace: w } of rows) {
    if (!w.topicIcon) continue;
    const was = counts.get(w.topicIcon);
    counts.set(w.topicIcon, { n: (was?.n ?? 0) + 1, at: was && was.at > w.updatedAt ? was.at : w.updatedAt });
  }
  let best: string | undefined;
  for (const [icon, c] of counts) {
    const b = best === undefined ? undefined : counts.get(best)!;
    if (!b || c.n > b.n || (c.n === b.n && c.at > b.at)) best = icon;
  }
  return best;
}

const newestFirst = (a: TopicRow, b: TopicRow) => byActivity(a.workspace, b.workspace);

/**
 * Where a lead's row stands in the sidebar by topic: by the lead's own state, as the queue files it (queueSections);
 * one of its agents counts only while it asks the person something.
 */
function rowLife(r: SidebarRow, life: (w: WorkspaceView) => ChatLife): ChatLife {
  return r.children.some((c) => c.state === "needs_input" && life(c) === "live") ? "live" : life(r.workspace);
}

const holds = (r: SidebarRow, id: string) => r.workspace.id === id || r.children.some((c) => c.id === id);

/**
 * Where the row holding chat `id` (a lead, or one of its agents) stands now; undefined when no row holds it. What the
 * sidebar by topic holds that row at while the chat is open (topicView `held`).
 */
export function topicRowLife(folders: ReadonlyArray<SidebarFolder>, id: string, life: (w: WorkspaceView) => ChatLife): ChatLife | undefined {
  for (const f of folders) for (const r of f.rows) if (holds(r, id)) return rowLife(r, life);
  return undefined;
}

/**
 * The folders' rows by topic, as Dia keeps tab groups, with the queue's lifecycle in them. Chats sharing a topic sit in
 * one group; a topic with one chat leaves it loose, and a chat in no topic is loose. A lead's agents stay under it, and
 * a lead is live while it is, or while one of its agents asks the person something.
 *
 * `life` says where each chat stands (inbox-state.ts chatLife). A group shows its live chats and folds the rest behind
 * one line; a group with nothing live closes, to Closed groups, unless the person pinned it (pinned groups come first)
 * or reopened it (`marks.kept`). A loose chat that is over goes to the Done or Snoozed shelf. `held` is the open chat
 * and where its row stood when it was opened (topicRowLife), so nothing moves under the person until they leave it.
 * Groups and loose chats share one order, the person's (`order`); the rows in a group keep it too.
 */
export function topicView(
  folders: ReadonlyArray<SidebarFolder>,
  order: ReadonlyArray<string>,
  life: (w: WorkspaceView) => ChatLife,
  marks: TopicMarks = { pinned: new Set(), kept: new Set() },
  held?: { readonly id: string; readonly life: ChatLife },
): TopicView {
  const rows = folders.flatMap((f) => f.rows.map((r): TopicRow => ({ ...r, project: f.project })));
  const lifeOfRow = (r: TopicRow): ChatLife => (held && holds(r, held.id) ? held.life : rowLife(r, life));
  const byTopic = new Map<string, TopicRow[]>();
  for (const r of rows) if (r.workspace.topic) byTopic.set(r.workspace.topic, [...(byTopic.get(r.workspace.topic) ?? []), r]);
  const sorted = (members: ReadonlyArray<TopicRow>) => arranged(members.map((r) => ({ key: chatKey(r.workspace.id), at: r.workspace.updatedAt, r })), order).map((m) => m.r);
  const items: Array<TopicItem & { readonly at: string }> = [];
  const closed: ClosedGroup[] = [];
  const done: TopicRow[] = [];
  const snoozed: TopicRow[] = [];
  for (const [topic, members] of byTopic) {
    if (members.length < 2) continue;
    const all = sorted(members);
    const at = members.reduce((at, r) => (r.workspace.updatedAt > at ? r.workspace.updatedAt : at), "");
    const icon = groupIcon(members);
    const lives = all.map(lifeOfRow);
    const pinned = marks.pinned.has(topic);
    if (!lives.includes("live") && !pinned && !marks.kept.has(topic)) {
      closed.push({ id: groupKey(topic), topic, ...(icon ? { icon } : {}), rows: all, at });
      continue;
    }
    const live = all.filter((_, i) => lives[i] === "live");
    const over = all.filter((_, i) => lives[i] === "done");
    const asleep = all.filter((_, i) => lives[i] === "snoozed");
    items.push({ kind: "group", key: groupKey(topic), topic, ...(icon ? { icon } : {}), pinned, rows: live, rest: [...over, ...asleep], done: over.length, snoozed: asleep.length, at });
  }
  for (const r of rows) {
    if (r.workspace.topic && (byTopic.get(r.workspace.topic)?.length ?? 0) >= 2) continue;
    const where = lifeOfRow(r);
    if (where === "live") items.push({ kind: "chat", key: chatKey(r.workspace.id), row: r, at: r.workspace.updatedAt });
    else (where === "done" ? done : snoozed).push(r);
  }
  // Closed groups keep their place in the person's order while they are away, so one comes back where it was.
  const placed = arranged<(TopicItem | { readonly kind: "closed"; readonly key: string; readonly group: ClosedGroup }) & { readonly at: string }>(
    [...items, ...closed.map((group) => ({ kind: "closed" as const, key: group.id, group, at: group.at }))],
    order,
  );
  const pinnedGroup = (i: (typeof placed)[number]) => i.kind === "group" && i.pinned;
  const shownOrder = [...placed.filter(pinnedGroup), ...placed.filter((i) => !pinnedGroup(i))];
  return {
    items: shownOrder.flatMap((i): TopicItem[] => (i.kind === "closed" ? [] : [(({ at: _, ...item }) => item as TopicItem)(i)])),
    closed: closed.sort((a, b) => b.at.localeCompare(a.at)),
    done: done.sort(newestFirst),
    snoozed: snoozed.sort(newestFirst),
    shown: shownOrder.flatMap((i) => [i.key, ...(i.kind === "chat" ? [] : (i.kind === "closed" ? i.group.rows : [...i.rows, ...i.rest]).map((r) => chatKey(r.workspace.id)))]),
  };
}

/**
 * What handing a group's chats to a Chief does with each (chief.manage with hand_over), as the runtime decides it: a
 * chat on a board already stays there (`board`: whose, when another Chief's), one outside the Chief's projects stays the
 * person's (`projects`), the rest go. A chat already on this Chief's board is in neither list.
 */
export function handOverPlan(
  rows: ReadonlyArray<TopicRow>,
  chief: { readonly id: string; readonly project_ids: ReadonlyArray<string> },
  boardOf: ReadonlyMap<string, string>,
): { readonly handed: ReadonlyArray<TopicRow>; readonly kept: ReadonlyArray<{ readonly row: TopicRow; readonly why: "board" | "projects"; readonly chiefId?: string }> } {
  const handed: TopicRow[] = [];
  const kept: Array<{ row: TopicRow; why: "board" | "projects"; chiefId?: string }> = [];
  for (const row of rows) {
    const on = boardOf.get(row.workspace.id);
    if (on === chief.id) continue;
    if (on !== undefined) kept.push({ row, why: "board", chiefId: on });
    else if (chief.project_ids.length > 0 && !chief.project_ids.includes(row.workspace.projectId ?? "")) kept.push({ row, why: "projects" });
    else handed.push(row);
  }
  return { handed, kept };
}

/**
 * What renaming group `from` to `to` does with who manages them (ChiefProfile.topics; `managerOf` finds a group's
 * Chief). A rename never changes another Chief's group: a name another Chief manages is refused (`taken`), whether or
 * not `from` has a Chief. Otherwise `from`'s Chief takes the new name first, unless it already manages it (`take`), and
 * gives the old one up once every chat has moved (`release`).
 */
export function renameGroup<C extends { readonly id: string }>(
  from: string,
  to: string,
  managerOf: (topic: string) => C | undefined,
): { readonly taken: C } | { readonly take: C | undefined; readonly release: C | undefined } {
  const mine = managerOf(from);
  const theirs = managerOf(to);
  if (theirs !== undefined && theirs.id !== mine?.id) return { taken: theirs };
  const moves = mine !== undefined && to !== from;
  return { take: moves && theirs === undefined ? mine : undefined, release: moves ? mine : undefined };
}

/**
 * The order with `block` (a chat, or a group's key and its chats) moved just above or below `target` (below a group is
 * below its last chat: the caller names that chat). What is on screen (`shown`) and not in `order` yet goes first, where
 * topicItems puts what the order doesn't name, so the first drag keeps everything else where it was; keys the filter
 * hides keep their places in `order`.
 */
export function moveKeys(order: ReadonlyArray<string>, shown: ReadonlyArray<string>, block: ReadonlyArray<string>, target: string, place: "before" | "after"): string[] {
  const saved = new Set(order);
  const base = [...shown.filter((k) => !saved.has(k)), ...order];
  // Onto itself (a group on one of its own chats): nothing moves.
  if (block.includes(target)) return base;
  const rest = base.filter((k) => !block.includes(k));
  const at = rest.indexOf(target);
  if (at === -1) return [...block, ...rest];
  const i = place === "after" ? at + 1 : at;
  return [...rest.slice(0, i), ...block, ...rest.slice(i)];
}

/**
 * The rows a folder shows: its first `limit`, every one down to `cutoff` in the folder's order (Show more), and, in
 * order, every later one still in play (it, or an agent under it, works or waits on the person), so no chat at work
 * hides behind the fold. `hidden` is how many are left behind it.
 */
export function folderRowsShown<R extends SidebarRow>(rows: ReadonlyArray<R>, limit: number, statuses: ReadonlyMap<string, ChatStatus | null>, cutoff?: FolderCutoff): { shown: R[]; hidden: number } {
  const inPlay = (w: WorkspaceView) => {
    const stage = chatStage(statuses.has(w.id) ? statuses.get(w.id)! : chatStatus(w), w);
    return stage === "needs" || stage === "working";
  };
  const above = (w: WorkspaceView) => cutoff !== undefined && byStart(w, { createdAt: cutoff.since, id: cutoff.id }) <= 0;
  const shown = rows.filter((r, i) => i < limit || above(r.workspace) || inPlay(r.workspace) || r.children.some(inPlay));
  return { shown, hidden: rows.length - shown.length };
}

/**
 * What Show more opens a folder to, given the rows it shows: every row down to the `page`-th one still behind the fold,
 * or all of them when no more than `page` are left. A cutoff in the folder's order (when started, then id), not the
 * rows on screen: rows never move, so a chat it showed, or one newer that arrives later, stays shown, with no gap
 * above it; chats started at the same moment still open `page` at a time.
 */
export function folderShowMore(rows: ReadonlyArray<SidebarRow>, shown: ReadonlyArray<SidebarRow>, page: number): "all" | FolderCutoff {
  const on = new Set(shown.map((r) => r.workspace.id));
  const left = rows.filter((r) => !on.has(r.workspace.id));
  if (left.length <= page) return "all";
  const last = left[page - 1]!.workspace;
  return { since: last.createdAt, id: last.id };
}

/**
 * The chats open on screen, in pane order (panes/store.ts `useOpenWorkspaces`): History's "Open" group.
 * An id with no live workspace (archived, or gone) is skipped.
 */
export function openInPanes(workspaces: ReadonlyArray<WorkspaceView>, openIds: ReadonlyArray<string>): WorkspaceView[] {
  const byId = new Map(workspaces.map((w) => [w.id, w]));
  return openIds.flatMap((id) => {
    const w = byId.get(id);
    return w && w.state !== "archived" ? [w] : [];
  });
}

/** How long ago a queue row last moved, the way upstream sidebar says it: "now", "4m", "3h", "25d". */
export function rowAge(at: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** Where a chat's work lives, for its queue row's pill: a repository on GitHub, else the computer it runs on; named by its project. */
export interface ChatPlace {
  readonly on: "github" | "computer";
  readonly name: string;
}

export function chatPlace(w: WorkspaceView, project: { readonly name: string; readonly repository?: RepositoryView } | undefined): ChatPlace {
  const github = project ? project.repository?.host === "github.com" : "url" in w.repoRef && /github\.com[/:]/.test(w.repoRef.url);
  return { on: github ? "github" : "computer", name: project?.name ?? w.repo };
}
