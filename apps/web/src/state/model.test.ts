import { expect, test } from "vitest";
import { AGENT_LINGER_MS, agentRows, archivedProjects, chatPlace, chatStage, chatStatus, chatStatuses, filterFolders, filterProjectsLabel, storedFilterProjects, toggleFilterProject, firstStatus, folderRowsShown, folderShowMore, foldersForSidebar, type FolderCutoff, liveAndDone, openInPanes, passesFilter, pickableProjects, recentAgents, rowAge, handOverPlan, renameGroup, moveKeys, topicView, topicRowLife, carryMarks, shareMarks, type AgentRow, type ChatLife, type NativeSubagentView, type WorkspaceView } from "./model.ts";

const ws = (id: string, over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  title: id,
  repo: "app",
  repoRef: { path: "/repos/app" },
  branch: null,
  state: "completed",
  asleep: false,
  detail: null,
  engine: { id: "caveman", label: "Caveman" },
  computer: { kind: "this_mac", label: "This Mac" },
  parentId: null,
  sessionId: null,
  projectId: "p-app",
  createdAt: "2026-10-15T08:00:00Z",
  updatedAt: "2026-10-15T08:00:00Z",
  unread: false,
  ...over,
});

const projects = [
  { id: "p-app", name: "app", path: "/src/app" },
  { id: "p-site", name: "site", path: "/src/site" },
  { id: "p-empty", name: "empty", path: "/src/empty" },
];

test("a folder shows its first rows, then every later one still at work or waiting, before Show more", () => {
  const all = [
    ...Array.from({ length: 10 }, (_, i) => ws(`c${i}`, { createdAt: "2026-10-15T09:00:00Z" })),
    ws("busy", { state: "working" }),
    ws("lead"),
    ws("agent", { parentId: "lead", state: "needs_input" }),
    ws("idle"),
  ];
  const [app] = foldersForSidebar(projects, all);
  const { shown, hidden } = folderRowsShown(app!.rows, 8, chatStatuses(all));
  expect(shown.length).toBe(10);
  expect(shown.slice(8).map((r) => r.workspace.id).sort()).toEqual(["busy", "lead"]);
  expect(hidden).toBe(3);
});

// A project of 40 chats, c0 the most recently started, a minute apart; `use` makes a chat the most recently active, in
// turn, and `arrive` starts new ones.
const longProject = () => {
  const at = (n: number) => new Date(Date.parse("2026-10-15T08:00:00Z") + n * 60_000).toISOString();
  let chats = Array.from({ length: 40 }, (_, i) => ws(`c${i}`, { createdAt: at(100 - i), updatedAt: at(100 - i) }));
  let clock = 200;
  const rows = () => foldersForSidebar(projects, chats)[0]!.rows;
  return {
    at,
    rows,
    use: (...ids: string[]) => ids.forEach((id) => (chats = chats.map((w) => (w.id === id ? { ...w, updatedAt: at(clock++) } : w)))),
    arrive: (...ids: string[]) => (chats = [...chats, ...ids.map((id) => ws(id, { createdAt: at(clock), updatedAt: at(clock++) }))]),
    shown: (cutoff?: FolderCutoff) => folderRowsShown(rows(), 8, chatStatuses(chats), cutoff),
  };
};
const ids = (rows: ReadonlyArray<{ workspace: WorkspaceView }>) => rows.map((r) => r.workspace.id);
const named = (prefix: string, from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `${prefix}${from + i}`);

test("Show more opens a folder to the next fifteen chats, and to every chat when no more than fifteen are left", () => {
  const p = longProject();
  const opened = folderShowMore(p.rows(), p.shown().shown, 15);
  expect(opened).toEqual({ since: p.at(100 - 22), id: "c22" });
  if (opened === "all") throw new Error("expected a cutoff");
  expect(ids(p.shown(opened).shown)).toEqual(named("c", 0, 22));
  expect(folderShowMore(p.rows(), p.shown(opened).shown, 15)).toEqual({ since: p.at(100 - 37), id: "c37" });
  expect(folderShowMore(p.rows(), p.shown({ since: p.at(100 - 37), id: "c37" }).shown, 15)).toBe("all");
});

test("a project's chats stay in the order they were started: a reply moves none, and Show more keeps what it opened", () => {
  const p = longProject();
  const opened = folderShowMore(p.rows(), p.shown().shown, 15);
  if (opened === "all") throw new Error("expected a cutoff");
  p.use("c30");
  p.use(...named("c", 1, 8));
  expect(ids(p.rows())).toEqual(named("c", 0, 39));
  const { shown, hidden } = p.shown(opened);
  expect(ids(shown)).toEqual(named("c", 0, 22));
  expect(hidden).toBe(17);
});

test("more chats than a folder's first rows arriving while it is part open all show, above the ones it showed, no gap", () => {
  const p = longProject();
  const opened = folderShowMore(p.rows(), p.shown().shown, 15);
  if (opened === "all") throw new Error("expected a cutoff");
  p.arrive(...named("n", 0, 9));
  const { shown } = p.shown(opened);
  expect(ids(shown)).toEqual([...named("n", 0, 9).reverse(), ...named("c", 0, 22)]);
});

test("a chat at work past the fold shows without stretching Show more's step, and folds once it is idle", () => {
  const at = (n: number) => new Date(Date.parse("2026-10-15T08:00:00Z") + n * 60_000).toISOString();
  const chats = Array.from({ length: 40 }, (_, i) => ws(`c${i}`, { createdAt: at(100 - i), ...(i === 35 ? { state: "working" as const } : {}) }));
  const rows = foldersForSidebar(projects, chats)[0]!.rows;
  const first = folderRowsShown(rows, 8, chatStatuses(chats));
  expect(ids(first.shown)).toEqual([...named("c", 0, 7), "c35"]);
  const opened = folderShowMore(rows, first.shown, 15);
  expect(opened).toEqual({ since: at(100 - 22), id: "c22" });
  if (opened === "all") throw new Error("expected a cutoff");
  expect(ids(folderRowsShown(rows, 8, chatStatuses(chats), opened).shown)).toEqual([...named("c", 0, 22), "c35"]);
  const idle = chats.map((w) => (w.id === "c35" ? { ...w, state: "completed" as const } : w));
  const idleRows = foldersForSidebar(projects, idle)[0]!.rows;
  expect(ids(folderRowsShown(idleRows, 8, chatStatuses(idle), opened).shown)).toEqual(named("c", 0, 22));
});

test("chats started at the same moment still open fifteen at a time, in the same order every time", () => {
  const chats = Array.from({ length: 40 }, (_, i) => ws(`c${String(i).padStart(2, "0")}`));
  const rows = foldersForSidebar(projects, [...chats].reverse())[0]!.rows;
  expect(ids(rows)).toEqual(ids(foldersForSidebar(projects, chats)[0]!.rows));
  const first = folderRowsShown(rows, 8, chatStatuses(chats));
  const opened = folderShowMore(rows, first.shown, 15);
  if (opened === "all") throw new Error("expected a cutoff");
  const { shown, hidden } = folderRowsShown(rows, 8, chatStatuses(chats), opened);
  expect(ids(shown)).toEqual(ids(rows.slice(0, 23)));
  expect(hidden).toBe(17);
});

test("folders hold their workspaces, builders under their lead, archived left out", () => {
  const folders = foldersForSidebar(projects, [
    ws("lead", { createdAt: "2026-10-15T09:00:00Z" }),
    ws("builder", { parentId: "lead" }),
    ws("old", { createdAt: "2026-10-15T07:00:00Z", updatedAt: "2026-10-15T12:00:00Z" }),
    ws("gone", { state: "archived" }),
    ws("orphan", { parentId: "gone" }),
  ]);
  const app = folders.find((f) => f.project.id === "p-app")!;
  expect(app.rows.map((r) => [r.workspace.id, r.children.map((c) => c.id)])).toEqual([
    ["lead", ["builder"]],
    ["orphan", []],
    ["old", []],
  ]);
  expect(app.count).toBe(4);
});

test("delegated agents nest under their lead at every level; one waiting on the user is in the queue's Priority", () => {
  const all = [
    ws("lead", { createdAt: "2026-10-15T09:00:00Z" }),
    ws("child", { parentId: "lead", createdAt: "2026-10-15T08:00:00Z", updatedAt: "2026-10-15T10:00:00Z" }),
    ws("grandchild", { parentId: "child", state: "needs_input" }),
    ws("sibling", { parentId: "lead", createdAt: "2026-10-15T08:30:00Z" }),
  ];
  const app = foldersForSidebar(projects, all).find((f) => f.project.id === "p-app")!;
  expect(app.rows.map((r) => [r.workspace.id, r.children.map((c) => [c.id, c.depth])])).toEqual([
    ["lead", [["sibling", 1], ["child", 1], ["grandchild", 2]]],
  ]);
  expect(app.count).toBe(4);
});

test("the folder whose newest workspace started last comes first; empty projects keep their added order", () => {
  const folders = foldersForSidebar(projects, [
    ws("a", { createdAt: "2026-10-15T08:00:00Z", updatedAt: "2026-10-15T12:00:00Z" }),
    ws("s", { projectId: "p-site", createdAt: "2026-10-15T09:00:00Z" }),
  ]);
  expect(folders.map((f) => f.project.id)).toEqual(["p-site", "p-app", "p-empty"]);
});

test("pinned projects lead in the order they were pinned, chats or none; an archived one goes last, then away once it has no live chat", () => {
  const organized = [
    { id: "p-app", name: "app", path: "/src/app" },
    { id: "p-site", name: "site", path: "/src/site", pinned_at: "2026-10-20T00:00:00Z" },
    { id: "p-empty", name: "empty", path: "/src/empty", pinned_at: "2026-10-19T00:00:00Z" },
    { id: "p-old", name: "old", path: "/src/old", archived_at: "2026-10-18T00:00:00Z" },
    { id: "p-gone", name: "gone", path: "/src/gone", archived_at: "2026-10-21T00:00:00Z", pinned_at: "2026-10-01T00:00:00Z" },
  ];
  const work = [
    ws("a", { createdAt: "2026-10-15T09:00:00Z" }),
    ws("s", { projectId: "p-site", createdAt: "2026-10-15T08:00:00Z" }),
    ws("o", { projectId: "p-old", createdAt: "2026-10-15T10:00:00Z" }),
    ws("g", { projectId: "p-gone", state: "archived" }),
  ];
  const folders = foldersForSidebar(organized, work);
  expect(folders.map((f) => f.project.id)).toEqual(["p-empty", "p-site", "p-app", "p-old"]);
  expect(folders[0]!.project.pinnedAt).toBe("2026-10-19T00:00:00Z");
  expect(folders[3]!.project.archivedAt).toBe("2026-10-18T00:00:00Z");
  expect(archivedProjects(organized, folders).map((p) => p.id)).toEqual(["p-gone"]);
  // Its last chat archived, the old project leaves the folders for Archived projects, newest archive first.
  const later = foldersForSidebar(organized, work.filter((w) => w.id !== "o"));
  expect(later.map((f) => f.project.id)).toEqual(["p-empty", "p-site", "p-app"]);
  expect(archivedProjects(organized, later).map((p) => p.id)).toEqual(["p-gone", "p-old"]);
});

test("a picker offers pinned projects first and leaves archived ones out, unless already picked", () => {
  const list = [
    { id: "a" },
    { id: "b", pinned_at: "2026-10-20T00:00:00Z" },
    { id: "c", archived_at: "2026-10-20T00:00:00Z" },
    { id: "d", pinned_at: "2026-10-19T00:00:00Z" },
  ];
  expect(pickableProjects(list).map((p) => p.id)).toEqual(["d", "b", "a"]);
  expect(pickableProjects(list, "c").map((p) => p.id)).toEqual(["d", "b", "a", "c"]);
});

test("a workspace whose project is not listed gets a folder named after its repo", () => {
  const folders = foldersForSidebar([], [ws("x", { projectId: null, repo: "legacy" }), ws("y", { projectId: "p-unknown", repo: "legacy" })]);
  expect(folders).toHaveLength(1);
  expect(folders[0]!.project).toEqual({ id: "repo:legacy", name: "legacy", path: null });
  expect(folders[0]!.count).toBe(2);
});

test("a queue row says how long ago it moved in its largest whole unit", () => {
  const now = Date.parse("2026-10-18T12:00:00Z");
  expect(rowAge("2026-10-18T11:59:30Z", now)).toBe("now");
  // A clock a little ahead of this one is still now, never a negative age.
  expect(rowAge("2026-10-18T12:00:20Z", now)).toBe("now");
  expect(rowAge("2026-10-18T11:56:00Z", now)).toBe("4m");
  expect(rowAge("2026-10-18T09:00:00Z", now)).toBe("3h");
  expect(rowAge("2026-09-23T12:00:00Z", now)).toBe("25d");
  expect(rowAge("not a date", now)).toBe("");
});

test("a chat's place is its project on GitHub, else the computer it runs on", () => {
  const github = { host: "github.com", full_name: "caveman-ai/app", web_url: "https://github.com/caveman-ai/app" };
  expect(chatPlace(ws("a"), { name: "app", repository: github })).toEqual({ on: "github", name: "app" });
  expect(chatPlace(ws("b"), { name: "app", repository: { ...github, host: "gitlab.com" } })).toEqual({ on: "computer", name: "app" });
  expect(chatPlace(ws("c"), { name: "notes" })).toEqual({ on: "computer", name: "notes" });
  // No project listed: its repo says where it lives.
  expect(chatPlace(ws("d", { repo: "caveman-ai/app", repoRef: { url: "git@github.com:caveman-ai/app.git" } }), undefined)).toEqual({ on: "github", name: "caveman-ai/app" });
  expect(chatPlace(ws("e", { repo: "scratch" }), undefined)).toEqual({ on: "computer", name: "scratch" });
});

test("a lead's native subagents sit beside its delegated agents, each after whoever started it, newest first", () => {
  const sub = (itemId: string, startedAt: string, over: Partial<NativeSubagentView> = {}): NativeSubagentView => ({ itemId, parentItemId: null, title: itemId, engine: "claude-agent", state: "completed", startedAt, endedAt: null, ...over });
  const lead = ws("lead", {
    subagents: [
      sub("explore", "2026-10-15T09:00:00Z", { state: "working" }),
      sub("deeper", "2026-10-15T09:01:00Z", { parentItemId: "explore" }),
      sub("old", "2026-10-15T07:00:00Z"),
      // Its parent fell out of the runtime's latest 20: it stands on its own.
      sub("orphan", "2026-10-15T06:00:00Z", { parentItemId: "gone" }),
    ],
  });
  const delegated = ws("delegated", { parentId: "lead", updatedAt: "2026-10-15T08:00:00Z", subagents: [sub("its-own", "2026-10-15T08:30:00Z")] });
  const nested = ws("nested", { parentId: "delegated", updatedAt: "2026-10-15T08:10:00Z" });
  const [row] = foldersForSidebar(projects, [lead, delegated, nested])[0]!.rows;
  const rows = agentRows(row!.workspace, row!.children);
  expect(rows.map((r) => [r.kind, r.kind === "chat" ? r.workspace.id : r.subagent.itemId, r.depth])).toEqual([
    ["subagent", "explore", 1],
    ["subagent", "deeper", 2],
    ["chat", "delegated", 1],
    ["subagent", "its-own", 2],
    ["chat", "nested", 2],
    ["subagent", "old", 1],
    ["subagent", "orphan", 1],
  ]);
  // A native subagent opens in the chat whose transcript holds it.
  expect(rows.filter((r) => r.kind === "subagent").map((r) => r.kind === "subagent" && r.workspaceId)).toEqual(["lead", "lead", "delegated", "lead", "lead"]);
  // A chat with neither has no agents.
  expect(agentRows(ws("alone"), [])).toEqual([]);
});

test("agents still at work come first with their whole tree; finished ones fold away after them", () => {
  const sub = (itemId: string, startedAt: string, over: Partial<NativeSubagentView> = {}): NativeSubagentView => ({ itemId, parentItemId: null, title: itemId, engine: "claude-agent", state: "completed", startedAt, endedAt: null, ...over });
  const lead = ws("lead", {
    subagents: [
      sub("explore", "2026-10-15T09:00:00Z"),
      // A finished subagent's own subagent still works: the whole tree is live.
      sub("deeper", "2026-10-15T09:01:00Z", { parentItemId: "explore", state: "working" }),
      sub("old", "2026-10-15T07:00:00Z", { state: "failed" }),
    ],
  });
  const asking = ws("asking", { parentId: "lead", state: "needs_input", updatedAt: "2026-10-15T08:00:00Z" });
  const builder = ws("builder", { parentId: "lead", updatedAt: "2026-10-15T08:30:00Z" });
  const resting = ws("resting", { parentId: "builder", updatedAt: "2026-10-15T08:20:00Z", asleep: true, state: "queued" });
  const [row] = foldersForSidebar(projects, [lead, asking, builder, resting])[0]!.rows;
  const { live, done } = liveAndDone(agentRows(row!.workspace, row!.children));
  const id = (r: AgentRow) => (r.kind === "chat" ? r.workspace.id : r.subagent.itemId);
  expect(live.map(id)).toEqual(["explore", "deeper", "asking"]);
  // A parked agent is not at work.
  expect(done.map(id)).toEqual(["builder", "resting", "old"]);
  expect(liveAndDone([])).toEqual({ live: [], done: [] });
});

test("an agent tree leaves the sidebar once all of it finished a while ago, unless its chat is open", () => {
  const sub = (itemId: string, over: Partial<NativeSubagentView> = {}): NativeSubagentView => ({ itemId, parentItemId: null, title: itemId, engine: "claude-agent", state: "completed", startedAt: "2026-10-15T08:00:00Z", endedAt: null, ...over });
  const lead = ws("lead", {
    subagents: [
      sub("long-done", { startedAt: "2026-10-15T08:00:00Z", endedAt: "2026-10-15T08:05:00Z" }),
      sub("just-done", { startedAt: "2026-10-15T08:01:00Z", endedAt: "2026-10-15T08:55:00Z" }),
      sub("working", { startedAt: "2026-10-15T08:02:00Z", state: "working" }),
      // Listed before the runtime stamped ends: it counts from its start.
      sub("unstamped", { startedAt: "2026-10-15T07:00:00Z", state: "stopped" }),
    ],
  });
  const builder = ws("builder", { parentId: "lead", updatedAt: "2026-10-15T08:10:00Z" });
  // Its own agent finished just now: the builder's tree stays.
  const fresh = ws("fresh", { parentId: "builder", updatedAt: "2026-10-15T08:58:00Z" });
  const failed = ws("failed", { parentId: "lead", state: "failed", updatedAt: "2026-10-15T08:20:00Z" });
  const parked = ws("parked", { parentId: "lead", state: "queued", asleep: true, updatedAt: "2026-10-15T08:30:00Z" });
  const waiting = ws("waiting", { parentId: "lead", state: "queued", updatedAt: "2026-10-15T07:00:00Z" });
  const asking = ws("asking", { parentId: "lead", state: "needs_input", updatedAt: "2026-10-15T07:00:00Z" });
  const [row] = foldersForSidebar(projects, [lead, builder, fresh, failed, parked, waiting, asking])[0]!.rows;
  const rows = agentRows(row!.workspace, row!.children);
  const now = Date.parse("2026-10-15T09:00:00Z");
  const id = (r: AgentRow) => (r.kind === "chat" ? r.workspace.id : r.subagent.itemId);
  const { rows: kept, next } = recentAgents(rows, now);
  expect(kept.map(id).sort()).toEqual(["asking", "builder", "fresh", "just-done", "waiting", "working"]);
  // It looks again when the next one shown would leave: the one that finished at 8:55.
  expect(next).toBe(Date.parse("2026-10-15T08:55:00Z") + AGENT_LINGER_MS);
  // The chat on screen keeps its tree.
  expect(recentAgents(rows, now, "failed").rows.map(id)).toContain("failed");
  // Nothing finished, nothing to look for; nothing at all, nothing shown.
  expect(recentAgents(agentRows(lead, []).filter((r) => r.kind === "subagent" && r.subagent.state === "working"), now)).toEqual({ rows: rows.filter((r) => id(r) === "working"), next: null });
  expect(recentAgents([], now)).toEqual({ rows: [], next: null });
});

test("open chats come in pane order; archived or unknown ids are skipped", () => {
  const list = [ws("a"), ws("b", { state: "archived" }), ws("c")];
  expect(openInPanes(list, ["c", "gone", "b", "a"]).map((w) => w.id)).toEqual(["c", "a"]);
  expect(openInPanes(list, [])).toEqual([]);
});

test("a chat's one status: what it asks of you first, then work, then what finished", () => {
  const ask = (kind: "question" | "approval" | "secret") => ws("a", { state: "needs_input", activity: { ask: { kind, prompt: "Run the migration?" }, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false } });
  expect(chatStatus(ask("approval"))).toMatchObject({ id: "approve", label: "Approve", detail: "Run the migration?", action: true });
  expect(chatStatus(ask("secret"))).toMatchObject({ id: "secret", action: true });
  expect(chatStatus(ask("question"))).toMatchObject({ id: "answer", label: "Answer" });
  // An ask inside a native subagent: the chat still reads working, but the ask is the person's.
  expect(chatStatus(ws("k", { state: "working", activity: { ask: { kind: "approval", prompt: "Edit main.go?" }, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false } }))?.id).toBe("approve");
  // A runtime that projects no activity still says it waits on you.
  expect(chatStatus(ws("b", { state: "needs_input" }))).toMatchObject({ id: "answer", label: "Needs you", detail: null });
  const working = ws("c", { state: "working", activity: { ask: null, turnStartedAt: "2026-10-15T08:00:00Z", lastOutcome: null, turnEndedAt: null, todos: { done: 3, total: 5 }, readyToBuild: false } });
  expect(chatStatus(working, 2)).toMatchObject({ id: "working", since: "2026-10-15T08:00:00Z", progress: { done: 3, total: 5 }, detail: "3 of 5 steps, 2 agents at work", action: false });
  // Its own turn over, its agents still at work: waiting on them, not done.
  expect(chatStatus(ws("d", { unread: true }), 3)).toMatchObject({ id: "agents", label: "Waiting on agents", agents: 3 });
  expect(chatStatus(ws("e", { activity: { ask: null, turnStartedAt: null, lastOutcome: "completed", turnEndedAt: null, todos: null, readyToBuild: true } }))).toMatchObject({ id: "ready", action: true });
  expect(chatStatus(ws("f", { state: "failed" }))?.id).toBe("failed");
  expect(chatStatus(ws("g", { state: "queued", asleep: true }))?.id).toBe("asleep");
  expect(chatStatus(ws("h", { unread: true }))?.id).toBe("done");
  expect(chatStatus(ws("i", { unread: true, activity: { ask: null, turnStartedAt: null, lastOutcome: "interrupted", turnEndedAt: null, todos: null, readyToBuild: false } }))?.id).toBe("stopped");
  // Finished and read: nothing to say.
  expect(chatStatus(ws("j"))).toBeNull();
});

test("statuses count each chat's agents from the list; a closed folder shows the most pressing", () => {
  const all = [
    ws("lead", { unread: true }),
    ws("builder", { parentId: "lead", state: "working" }),
    ws("its-own", { parentId: "builder", state: "needs_input" }),
    ws("other", { subagents: [{ itemId: "s", parentItemId: null, title: "s", engine: "claude-agent", state: "working", startedAt: "2026-10-15T08:00:00Z", endedAt: null }], state: "working" }),
  ];
  const statuses = chatStatuses(all);
  expect(statuses.get("lead")).toMatchObject({ id: "agents", agents: 2 });
  expect(statuses.get("builder")).toMatchObject({ id: "working", agents: 1 });
  expect(statuses.get("other")).toMatchObject({ id: "working", agents: 1 });
  expect(firstStatus([...statuses.values()])?.id).toBe("answer");
  expect(firstStatus([null, null])).toBeNull();
});

test("a chat whose turn ended while work that wakes it still runs is at work, not finished, and its agents are counted once", () => {
  const ended = { ask: null, turnStartedAt: null, lastOutcome: "completed" as const, turnEndedAt: "2026-10-15T08:30:00Z", todos: null, readyToBuild: false };
  const awaiting = ws("watch", { unread: true, activity: { ...ended, awaiting: true } });
  // A pull request it watches, a background task: no agent to name.
  expect(chatStatus(awaiting)).toMatchObject({ id: "working", label: "Waiting", detail: "on background work", action: false, since: null, agents: 0 });
  expect(chatStage(chatStatus(awaiting), awaiting)).toBe("working");
  // Its delegated agent is listed under it: waiting on agents, the agent counted once.
  const statuses = chatStatuses([ws("lead", { unread: true, activity: { ...ended, awaiting: true } }), ws("child", { parentId: "lead", state: "working" })]);
  expect(statuses.get("lead")).toMatchObject({ id: "agents", label: "Waiting on agents", agents: 1, detail: "1 agent at work" });
  // A failed turn still says so; once the work settles it reads as finished.
  expect(chatStatus(ws("failed", { state: "failed", activity: { ...ended, awaiting: true } }))?.id).toBe("failed");
  expect(chatStatus(ws("settled", { unread: true, activity: ended }))?.id).toBe("done");
});

test("the sidebar filter keeps a lead when it or an agent under it passes, and scopes to the projects picked", () => {
  const all = [
    ws("asks", { state: "needs_input", updatedAt: "2026-10-15T09:00:00Z" }),
    ws("lead", { updatedAt: "2026-10-15T08:30:00Z" }),
    ws("builder", { parentId: "lead", state: "working" }),
    ws("read", { updatedAt: "2026-10-15T07:00:00Z" }),
    ws("site", { projectId: "p-site", unread: true }),
  ];
  const folders = foldersForSidebar(projects, all);
  const statuses = chatStatuses(all);
  const rows = (f: ReturnType<typeof filterFolders>) => f.map((x) => [x.project.id, x.rows.map((r) => r.workspace.id)]);
  expect(filterFolders(folders, "all", [], statuses)).toBe(folders);
  expect(rows(filterFolders(folders, "needs", [], statuses))).toEqual([["p-app", ["asks"]]]);
  expect(rows(filterFolders(folders, "working", [], statuses))).toEqual([["p-app", ["lead"]]]);
  expect(rows(filterFolders(folders, "unread", [], statuses))).toEqual([["p-site", ["site"]]]);
  // A project scope keeps its folder even when empty; a filter on top drops what is left empty.
  expect(rows(filterFolders(folders, "all", ["p-empty"], statuses))).toEqual([["p-empty", []]]);
  expect(rows(filterFolders(folders, "needs", ["p-site"], statuses))).toEqual([]);
 // Several projects at once (upstream #25284), in the sidebar's own order.
  expect(rows(filterFolders(folders, "all", ["p-site", "p-app"], statuses)).map(([id]) => id)).toEqual(
    folders.filter((f) => f.project.id === "p-site" || f.project.id === "p-app").map((f) => f.project.id),
  );
  expect(rows(filterFolders(folders, "unread", ["p-app", "p-site"], statuses))).toEqual([["p-site", ["site"]]]);
  expect(passesFilter("unread", ws("x", { unread: true }), null)).toBe(true);
});

test("the sidebar filter's projects: kept as a list, an older single project read as one, and how its line names them", () => {
  expect(storedFilterProjects({ projects: ["a", "b", "a", 3] })).toEqual(["a", "b"]);
  expect(storedFilterProjects({ project: "a" })).toEqual(["a"]);
  expect(storedFilterProjects({ project: null })).toEqual([]);
  expect(storedFilterProjects(null)).toEqual([]);
  expect(toggleFilterProject(["a"], "b")).toEqual(["a", "b"]);
  expect(toggleFilterProject(["a", "b"], "a")).toEqual(["b"]);
  expect(filterProjectsLabel([])).toBeNull();
  expect(filterProjectsLabel(["app"])).toBe("app");
  expect(filterProjectsLabel(["app", "site"])).toBe("app and site");
  expect(filterProjectsLabel(["app", "site", "docs"])).toBe("3 projects");
});

test("a chat in a plain folder on another computer sits in a folder that says so, never a nameless one", () => {
  const [folder] = foldersForSidebar([], [ws("notes", { projectId: null, repo: "" })]);
  expect(folder!.project.name).toBe("No repository");
  // One in a repository goes by the repository, as before.
  expect(foldersForSidebar([], [ws("web", { projectId: null, repo: "acme/web" })])[0]!.project.name).toBe("acme/web");
});

/** The sidebar by topic with every chat live: its list. */
const topicItems = (folders: Parameters<typeof topicView>[0], order: ReadonlyArray<string>) => topicView(folders, order, () => "live").items;
const topicShown = (folders: Parameters<typeof topicView>[0], order: ReadonlyArray<string>) => topicView(folders, order, () => "live").shown;

test("by topic: chats sharing a topic make a group, a lone topic or none stays loose, newest first until arranged", () => {
  const folders = foldersForSidebar(projects, [
    ws("pricing-a", { title: "Plans page", topic: "Billing Redesign", updatedAt: "2026-10-15T08:00:00Z" }),
    ws("pricing-b", { title: "Seat math", topic: "Billing Redesign", projectId: "p-site", updatedAt: "2026-10-17T08:00:00Z" }),
    ws("lone", { title: "Relay drops", topic: "Relay Reliability", updatedAt: "2026-10-16T08:00:00Z" }),
    ws("none", { title: "Netflix", updatedAt: "2026-10-14T08:00:00Z" }),
    // A builder stays under its lead, whatever its own topic.
    ws("builder", { title: "Sub", parentId: "pricing-a", topic: "Other" }),
  ]);
  const items = topicItems(folders, []);
  expect(items.map((i) => (i.kind === "group" ? [i.key, i.rows.map((r) => r.workspace.id)] : i.key))).toEqual([
    ["g:Billing Redesign", ["pricing-b", "pricing-a"]],
    "c:lone",
    "c:none",
  ]);
  const group = items[0]!;
  expect(group.kind === "group" && group.rows[1]!.children.map((c) => c.id)).toEqual(["builder"]);
  // The person drags the loose "none" above the group: it stays there; a new chat would come in on top.
  const order = moveKeys([], topicShown(folders, []), ["c:none"], "g:Billing Redesign", "before");
  expect(order).toEqual(["c:none", "g:Billing Redesign", "c:pricing-b", "c:pricing-a", "c:lone"]);
  expect(topicItems(folders, order).map((i) => i.key)).toEqual(["c:none", "g:Billing Redesign", "c:lone"]);
  // A group dragged below the last loose chat takes its chats with it.
  const moved = moveKeys(order, topicShown(folders, order), ["g:Billing Redesign", "c:pricing-b", "c:pricing-a"], "c:lone", "after");
  expect(topicItems(folders, moved).map((i) => i.key)).toEqual(["c:none", "c:lone", "g:Billing Redesign"]);
  // With a filter hiding "lone", a drag among what shows leaves it where it was, and a new chat on screen keeps its place.
  const filtered = moveKeys(moved, ["c:new", "c:none", "g:Billing Redesign", "c:pricing-b", "c:pricing-a"], ["c:none"], "c:pricing-a", "after");
  expect(filtered).toEqual(["c:new", "c:lone", "g:Billing Redesign", "c:pricing-b", "c:pricing-a", "c:none"]);
});

test("a chat dropped on a loose one starts a group in that chat's place", () => {
  const order = ["c:a", "c:b", "c:c"];
  const placed = moveKeys(order, order, ["g:New"], "c:b", "before");
  expect(moveKeys(placed, order, ["c:c"], "c:b", "after")).toEqual(["c:a", "g:New", "c:b", "c:c"]);
});

test("handing a group to a Chief: a chat on another board and one outside its projects stay, the rest go", () => {
  const folders = foldersForSidebar(projects, [
    ws("free", { topic: "Relay" }),
    ws("other", { topic: "Relay" }),
    ws("away", { topic: "Relay", projectId: "p-site" }),
    ws("mine", { topic: "Relay" }),
  ]);
  const group = topicItems(folders, [])[0]!;
  if (group.kind !== "group") throw new Error("no group");
  const plan = handOverPlan(group.rows, { id: "ugg", project_ids: ["p-app"] }, new Map([["other", "chief"], ["mine", "ugg"]]));
  expect(plan.handed.map((r) => r.workspace.id)).toEqual(["free"]);
  expect(plan.kept.map((k) => [k.row.workspace.id, k.why, k.chiefId])).toEqual([
    ["other", "board", "chief"],
    ["away", "projects", undefined],
  ]);
  // A Chief in every project (none listed) takes the one from another project too.
  expect(handOverPlan(group.rows, { id: "ugg", project_ids: [] }, new Map()).handed).toHaveLength(4);
});

test("a rename never takes another Chief's group: its name is refused; the group's own Chief moves with it", () => {
  const chief = { id: "chief", name: "Chief" };
  const repro = { id: "repro", name: "Reprochief" };
  const managers = new Map([
    ["Group A", chief],
    ["Group B", repro],
    ["Also Chief's", chief],
  ]);
  const managerOf = (topic: string) => managers.get(topic);
  // A, Chief's, renamed to B, Reprochief's: refused, and Reprochief keeps B.
  expect(renameGroup("Group A", "Group B", managerOf)).toEqual({ taken: repro });
  // An unmanaged group renamed into B is refused too: B is Reprochief's to grow.
  expect(renameGroup("Loose", "Group B", managerOf)).toEqual({ taken: repro });
  // To a new name: Chief takes it, then gives A up.
  expect(renameGroup("Group A", "Group C", managerOf)).toEqual({ take: chief, release: chief });
  // Into another group Chief manages: nothing to take, A given up.
  expect(renameGroup("Group A", "Also Chief's", managerOf)).toEqual({ take: undefined, release: chief });
  // No Chief on either side, or the same name: no Chief changes.
  expect(renameGroup("Loose", "Other", managerOf)).toEqual({ take: undefined, release: undefined });
  expect(renameGroup("Group A", "Group A", managerOf)).toEqual({ take: undefined, release: undefined });
});

test("a group dropped on one of its own chats stays where it was", () => {
  const order = ["c:a", "g:G", "c:g1", "c:g2", "c:b"];
  expect(moveKeys(order, order, ["g:G", "c:g1", "c:g2"], "c:g2", "after")).toEqual(order);
});

test("by topic: a group shows its live chats and folds the rest; one with nothing live closes, unless pinned or reopened", () => {
  const folders = foldersForSidebar(projects, [
    ws("a1", { topic: "Alpha", topicIcon: "🧭", updatedAt: "2026-10-15T08:00:00Z" }),
    ws("a2", { topic: "Alpha", topicIcon: "🧭", updatedAt: "2026-10-16T08:00:00Z" }),
    ws("a3", { topic: "Alpha", updatedAt: "2026-10-14T08:00:00Z" }),
    ws("b1", { topic: "Beta", topicIcon: "🔐", updatedAt: "2026-10-12T08:00:00Z" }),
    ws("b2", { topic: "Beta", topicIcon: "🔐", updatedAt: "2026-10-13T08:00:00Z" }),
    ws("loose-done", { updatedAt: "2026-10-11T08:00:00Z" }),
    ws("loose-asleep", { updatedAt: "2026-10-10T08:00:00Z" }),
    ws("loose-live", { updatedAt: "2026-10-09T08:00:00Z" }),
  ]);
  const lives: Record<string, ChatLife> = { a1: "live", a2: "done", a3: "snoozed", b1: "done", b2: "done", "loose-done": "done", "loose-asleep": "snoozed", "loose-live": "live" };
  const life = (w: WorkspaceView) => lives[w.id]!;
  const view = topicView(folders, [], life);
  expect(view.items.map((i) => i.key)).toEqual(["g:Alpha", "c:loose-live"]);
  const alpha = view.items[0]!;
  if (alpha.kind !== "group") throw new Error("no group");
  expect(alpha.icon).toBe("🧭");
  expect(alpha.rows.map((r) => r.workspace.id)).toEqual(["a1"]);
  expect(alpha.rest.map((r) => r.workspace.id)).toEqual(["a2", "a3"]);
  expect([alpha.done, alpha.snoozed]).toEqual([1, 1]);
  // Beta has nothing live: closed, with its emoji and every chat.
  expect(view.closed.map((g) => [g.id, g.icon, g.rows.map((r) => r.workspace.id)])).toEqual([["g:Beta", "🔐", ["b2", "b1"]]]);
  expect(view.done.map((r) => r.workspace.id)).toEqual(["loose-done"]);
  expect(view.snoozed.map((r) => r.workspace.id)).toEqual(["loose-asleep"]);
  // Pinned, Beta stays open with nothing live, above everything; reopened (kept), it stays in its place.
  const pinned = topicView(folders, [], life, { pinned: new Set(["Beta"]), kept: new Set() });
  expect(pinned.items.map((i) => [i.key, i.kind === "group" && i.pinned])).toEqual([["g:Beta", true], ["g:Alpha", false], ["c:loose-live", false]]);
  expect(pinned.closed).toEqual([]);
  const kept = topicView(folders, ["g:Alpha", "c:loose-live", "g:Beta"], life, { pinned: new Set(), kept: new Set(["Beta"]) });
  expect(kept.items.map((i) => i.key)).toEqual(["g:Alpha", "c:loose-live", "g:Beta"]);
});

test("by topic: the open chat holds where it stood when opened; a lead's agents count only while one asks the person", () => {
  const folders = foldersForSidebar(projects, [
    ws("a1", { topic: "Alpha" }),
    ws("a2", { topic: "Alpha" }),
    ws("builder", { parentId: "a2" }),
    ws("solo", {}),
  ]);
  const lives: Record<string, ChatLife> = { a1: "done", a2: "done", builder: "live", solo: "done" };
  const life = (w: WorkspaceView) => lives[w.id]!;
  // a2's agent finished and nobody called it done: as the queue files it, it doesn't hold a2 (or Alpha) open.
  expect(topicView(folders, [], life).closed.map((g) => g.id)).toEqual(["g:Alpha"]);
  // An agent that asks the person something does: a2 is live, so Alpha stays open with a2 in it.
  const asking = foldersForSidebar(projects, [ws("a1", { topic: "Alpha" }), ws("a2", { topic: "Alpha" }), ws("builder", { parentId: "a2", state: "needs_input" })]);
  const alpha = topicView(asking, [], life).items.find((i) => i.key === "g:Alpha");
  expect(alpha?.kind === "group" && alpha.rows.map((r) => r.workspace.id)).toEqual(["a2"]);
  // So does the open agent, held live from when it was opened.
  expect(topicView(folders, [], life, undefined, { id: "builder", life: "live" }).items.map((i) => i.key)).toContain("g:Alpha");
  // "solo" finished while open: it holds its place in the list until the person leaves it.
  expect(topicView(folders, [], life, undefined, { id: "solo", life: "live" }).items.map((i) => i.key)).toContain("c:solo");
  expect(topicView(folders, [], life).done.map((r) => r.workspace.id)).toEqual(["solo"]);
  // A done chat opened from a closed group stays in it: the group doesn't come back for a look.
  expect(topicView(folders, [], life, undefined, { id: "a1", life: "done" }).closed.map((g) => g.id)).toEqual(["g:Alpha"]);
  // The hold is the row's: a2 open while its agent asked (live then) stays live after the agent stops asking, until the
  // person leaves it.
  expect(topicRowLife(asking, "a2", life)).toBe("live");
  expect(topicRowLife(folders, "a2", life)).toBe("done");
  expect(topicView(folders, [], life, undefined, { id: "a2", life: "live" }).items.map((i) => i.key)).toContain("g:Alpha");
  expect(topicRowLife(folders, "nowhere", life)).toBeUndefined();
});

test("by topic: a group renamed keeps its marks, and merged into another keeps that group's too", () => {
  const marks = { pinned: new Set(["Beta"]), kept: new Set(["Alpha"]) };
  const names = (m: ReturnType<typeof carryMarks>) => ({ pinned: [...m.pinned].sort(), kept: [...m.kept].sort() });
  // Alpha merged into pinned Beta: Beta stays pinned and takes Alpha's reopened mark.
  expect(names(carryMarks(marks, "Alpha", "Beta"))).toEqual({ pinned: ["Beta"], kept: ["Beta"] });
  // Beta merged into Alpha: Alpha keeps its reopened mark and takes Beta's pin.
  expect(names(carryMarks(marks, "Beta", "Alpha"))).toEqual({ pinned: ["Alpha"], kept: ["Alpha"] });
  // A fresh name takes what the group had; an ungroup drops it.
  expect(names(carryMarks(marks, "Beta", "Gamma"))).toEqual({ pinned: ["Gamma"], kept: ["Alpha"] });
  expect(names(carryMarks(marks, "Alpha", null))).toEqual({ pinned: ["Beta"], kept: [] });
  // While Beta's chats move to Gamma, both names are pinned; once they have, only Gamma is.
  const moving = shareMarks(marks, "Beta", "Gamma");
  expect(names(moving)).toEqual({ pinned: ["Beta", "Gamma"], kept: ["Alpha"] });
  expect(names(carryMarks(moving, "Beta", "Gamma"))).toEqual({ pinned: ["Gamma"], kept: ["Alpha"] });
});

test("by topic: a group closed at the first drag keeps its place, and comes back there", () => {
  const folders = foldersForSidebar(projects, [
    ws("a1", { topic: "Alpha", updatedAt: "2026-10-17T08:00:00Z" }),
    ws("a2", { topic: "Alpha", updatedAt: "2026-10-17T08:00:00Z" }),
    ws("b1", { topic: "Beta", updatedAt: "2026-10-16T08:00:00Z" }),
    ws("b2", { topic: "Beta", updatedAt: "2026-10-16T08:00:00Z" }),
    ws("loose", { updatedAt: "2026-10-15T08:00:00Z" }),
  ]);
  const lives: Record<string, ChatLife> = { a1: "live", a2: "live", b1: "done", b2: "done", loose: "live" };
  const life = (w: WorkspaceView) => lives[w.id]!;
  const closedBeta = topicView(folders, [], life);
  expect(closedBeta.items.map((i) => i.key)).toEqual(["g:Alpha", "c:loose"]);
  // Beta is closed, but the order a first drag writes holds it between Alpha and the loose chat.
  expect(closedBeta.shown).toEqual(["g:Alpha", "c:a1", "c:a2", "g:Beta", "c:b1", "c:b2", "c:loose"]);
  const order = moveKeys([], closedBeta.shown, ["c:loose"], "g:Alpha", "before");
  // Beta comes back where it was, under Alpha, not at the top.
  lives.b1 = "live";
  expect(topicView(folders, order, life).items.map((i) => i.key)).toEqual(["c:loose", "g:Alpha", "g:Beta"]);
});
