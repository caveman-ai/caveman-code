import type { ChiefChangeSet, ChiefItem } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { waitingLine } from "../../components/pane/WaitingOn.tsx";
import { queuedNotes } from "../../state/chief-model.ts";
import type { WorkspaceView } from "../../state/model.ts";
import { actionOfKey, blockedByFixedBase, chatToOpen, workActions, workProject } from "./work-actions.ts";
import { chatByRef, chiefAtWork, groupOf, itemByRef, plainRefs, prStatus, prTone, reviewHint, untrackedChats, WORK_GROUPS, WORK_REF_PATTERN, workDocs, workGroups, workId, workKey, workPullRequest, workStatus, workWaiting, type Work } from "./work-model.ts";

const t0 = "2026-10-28T09:00:00.000Z";
const item = (id: string, patch: Partial<ChiefItem> = {}): ChiefItem => ({
  id,
  text: `note ${id}`,
  state: "queued",
  rank: 1,
  pinned: false,
  project_ids: ["p-app"],
  source: "composer",
  workspace_ids: [],
  created_at: t0,
  updated_at: t0,
  ...patch,
});
const chat = (id: string, patch: Partial<WorkspaceView> = {}): WorkspaceView =>
  ({
    id,
    title: `chat ${id}`,
    repo: "app",
    repoRef: { path: "/app" },
    branch: null,
    state: "working",
    asleep: false,
    detail: null,
    engine: { id: "codex", label: "Codex" },
    computer: { kind: "caveman_cloud", label: "cloud-1" },
    parentId: null,
    sessionId: null,
    projectId: "p-app",
    createdAt: t0,
    updatedAt: t0,
    unread: false,
    ...patch,
  }) as WorkspaceView;

describe("the Chief's work", () => {
  test("groups by where it stands: an ask needs you whatever its state, a dropped item is gone", () => {
    expect(groupOf(item("a", { state: "needs_you" }))).toBe("needs");
    expect(groupOf(item("b", { state: "queued", asked: { question: "Which?", recommended: "This", asked_at: t0 } }))).toBe("needs");
    expect(groupOf(item("c", { state: "started" }))).toBe("working");
    expect(groupOf(item("d", { state: "review" }))).toBe("review");
    for (const state of ["unsorted", "queued", "proposed", "scheduled"] as const) expect(groupOf(item("e", { state }))).toBe("queued");
    expect(groupOf(item("e", { state: "blocked", blocked_on: { kind: "capacity" } }))).toBe("blocked");
    expect(groupOf(item("f", { state: "done" }))).toBe("done");
    expect(groupOf(item("g", { state: "dropped" }))).toBeNull();
  });

  test("numbers read CH-12 for the home Chief and the first letters of another's name", () => {
    expect(workKey({ name: "Chief", home: true })).toBe("CH");
    expect(workKey({ name: "Ugg", home: false })).toBe("UGG");
    expect(workKey({ name: "Brak 2", home: false })).toBe("BRA");
    expect(workKey(null)).toBe("CH");
    expect(workId("CH", item("a", { number: 12 }))).toBe("CH-12");
    expect(workId("CH", item("a"))).toBeNull();
  });

  test("each piece of work carries its chats, how many finished, and its change set", () => {
    const set: ChiefChangeSet = { id: "cs-1", title: "Meter", project_ids: ["p-cloud", "p-app"], contract: "Cloud owns the price.", merge_order: ["p-cloud", "p-app"], state: "open", created_at: t0, updated_at: t0 };
    const groups = workGroups(
      [
        item("meter", { number: 26, title: "Computer-hour cost meter", state: "started", change_set_id: "cs-1", workspace_ids: ["w1", "w2", "gone"] }),
        item("drop", { state: "dropped" }),
        // A note the Chief acted on without a chat ("start the README one now") is not work.
        item("told", { number: 27, state: "done" }),
        item("rev", { number: 24, state: "review", workspace_ids: ["w3"] }),
      ],
      [chat("w1", { state: "completed" }), chat("w2"), chat("w3", { state: "completed", pullRequest: { number: 1415, url: "https://x/pull/1415", state: "open" } })],
      [set],
      "CH",
    );
    expect(groups.map((g) => g.group)).toEqual(["working", "review"]);
    const meter = groups[0]!.work[0]!;
    expect(meter).toMatchObject({ id: "CH-26", title: "Computer-hour cost meter", done: 1 });
    expect(meter.chats.map((c) => c.id)).toEqual(["w1", "w2"]);
    expect(meter.changeSet?.id).toBe("cs-1");
    const docs = workDocs(groups);
    expect(docs.flatMap((d) => d.docs.map((x) => x.key)).sort()).toEqual(["contract:cs-1", "guide:p-app:1415"]);
  });

  test("[[12]] names the item numbered 12, and reads as its title where only text shows", () => {
    const items = [item("a", { number: 12, title: "Idle billing" }), item("b", { number: 3 })];
    expect(itemByRef("[[12]]", items)?.id).toBe("a");
    expect(itemByRef("[[99]]", items)).toBeNull();
    expect(plainRefs("[[12]] needs you; [[3]] waits; [[99]] is gone.", items)).toBe("Idle billing needs you; note b waits; [[99]] is gone.");
  });

  test("two child drafts under one item link to their own chats, including older UUID-only replies", () => {
    const search = "c68da759-dd44-48c2-9be4-f18b94ed491e";
    const csv = "f06d97d3-c4e8-4496-b5d5-bba631ff2f77";
    const items = [item("ci-1234abcd", { number: 1, title: "Drafts", workspace_ids: [search, csv] })];
    const chats = [chat(search, { title: "Search checklist" }), chat(csv, { title: "CSV example" })];
    expect(chatByRef(`[[chat:${csv}]]`, items, chats)?.title).toBe("CSV example");
    expect(chatByRef(`[[${search}]]`, items, chats)?.title).toBe("Search checklist");
    expect(chatByRef(`[[chat:${csv}]]`, [], chats)).toBeNull();
    expect(chatByRef("[[1]]", items, chats)).toBeNull();
    expect(itemByRef("[[ci-1234abcd]]", items)?.number).toBe(1);
    expect(plainRefs(`[[1]]: [[chat:${csv}]] and [[${search}]]`, items, chats)).toBe("Drafts: CSV example and Search checklist");
    expect(`[[chat:${csv}]]`.match(WORK_REF_PATTERN)?.[0]).toBe(`[[chat:${csv}]]`);
    expect("[[unknown]]".match(WORK_REF_PATTERN)).toBeNull();
  });

  test("blocked work names its dependency without mistaking it for ready work", () => {
    const search = item("search", { title: "Search", state: "started" });
    const csv = item("csv", { state: "blocked", blocked_on: { kind: "item", item_id: "search" } });
    expect(workWaiting(csv, [search, csv])).toBe("Waiting for Search");
    expect(workWaiting(csv, [csv])).toBe("Waiting for earlier work");
    expect(workWaiting({ ...csv, state: "queued" }, [search, csv])).toBeNull();
    expect(workGroups([search, csv], [], [], "CH").find((g) => g.group === "blocked")?.work[0]?.waiting).toBe("Waiting for Search");
  });
});

describe("pull requests on the board", () => {
  const pr = { number: 31, url: "https://github.com/o/r/pull/31", state: "open" } as const;

  test("a pull request reads at a glance: what needs you first, then its checks", () => {
    expect(prStatus(pr)).toBeNull();
    expect(prStatus({ ...pr, checks: "passing" })).toBe("CI passing");
    expect(prStatus({ ...pr, checks: "pending" })).toBe("CI pending");
    expect(prStatus({ ...pr, checks: "failing", review: "approved" })).toBe("CI failing");
    expect(prStatus({ ...pr, checks: "passing", review: "changes_requested" })).toBe("changes requested");
    expect(prStatus({ ...pr, checks: "passing", review: "approved" })).toBe("approved, CI passing");
    expect(prStatus({ ...pr, state: "merged", checks: "failing" })).toBe("merged");
    expect(prStatus({ ...pr, state: "closed" })).toBe("closed");
  });

  test("its chip is green while healthy, amber when it needs you, plain once merged or closed", () => {
    expect(prTone(pr)).toBe("pr");
    expect(prTone({ ...pr, checks: "failing" })).toBe("warn");
    expect(prTone({ ...pr, review: "changes_requested" })).toBe("warn");
    expect(prTone({ ...pr, state: "merged" })).toBeUndefined();
    expect(prTone({ ...pr, state: "closed", checks: "failing" })).toBeUndefined();
  });

  test("work ready for review says it waits on the person: their review, or their merge once approved", () => {
    expect(WORK_GROUPS.find((g) => g.id === "review")?.label).toBe("Ready for review");
    expect(reviewHint(undefined)).toBe("Waiting on you to look at its changes");
    expect(reviewHint(pr)).toBe("Waiting on your review of #31");
    expect(reviewHint({ ...pr, checks: "passing" })).toBe("Waiting on your review of #31 · CI passing");
    expect(reviewHint({ ...pr, review: "approved", checks: "pending" })).toBe("Waiting on you to merge #31 · CI pending");
  });

  test("the board's copy of the pull request wins over the chat's pill, which fills in for items from before", () => {
    const synced = { ...pr, checks: "failing" } as const;
    expect(workPullRequest(item("a", { pull_request: synced }), [chat("w1", { pullRequest: pr })])).toEqual(synced);
    expect(workPullRequest(item("a"), [chat("w1"), chat("w2", { pullRequest: pr })])).toEqual(pr);
    expect(workPullRequest(item("a"), [chat("w1")])).toBeUndefined();
  });

  test("untracked: the person's chats under way in its projects that no Chief's board follows, newest first", () => {
    const at = (m: number) => `2026-10-28T09:${String(m).padStart(2, "0")}:00.000Z`;
    const chats = [
      chat("mine", { updatedAt: at(1) }),
      chat("asks", { state: "needs_input", updatedAt: at(3) }),
      chat("waits", { state: "queued", updatedAt: at(2) }),
      chat("parked", { state: "queued", asleep: true }),
      chat("idle", { state: "completed" }),
      chat("failed", { state: "failed" }),
      chat("archived", { state: "archived" }),
      chat("on-a-board"),
      chat("other-chiefs"),
      chat("builder", { parentId: "mine" }),
      chat("step", { automationStep: true }),
      chat("elsewhere", { projectId: "p-site" }),
      chat("no-project", { projectId: null }),
      chat("cloud-only"),
    ];
    const local = new Set(chats.map((c) => c.id).filter((id) => id !== "cloud-only"));
    const board = [item("a", { workspace_ids: ["on-a-board"] }), item("b", { chief_id: "ugg", workspace_ids: ["other-chiefs"] })];
    expect(untrackedChats(chats, local, board, ["p-app"]).map((c) => c.id)).toEqual(["asks", "waits", "mine"]);
    // A Chief that names no projects works in every one, a chat in none included.
    expect(untrackedChats(chats, local, board, []).map((c) => c.id)).toEqual(["asks", "waits", "mine", "elsewhere", "no-project"]);
  });
});

describe("honest states (the board in the screenshot: main red, every pull request 'CI failing')", () => {
  const url = (n: number) => `https://github.com/caveman-ai/caveman-code`;
  const mainRed = { base: "main", failing: ["test"], on_base: ["test"], base_state: "failing" } as const;
  type BaseCi = NonNullable<NonNullable<ChiefItem["pull_request"]>["base_ci"]>;
  const red = (n: number, base_ci?: BaseCi): NonNullable<ChiefItem["pull_request"]> => ({ number: n, url: url(n), state: "open", checks: "failing", ...(base_ci ? { base_ci } : {}) });

  test("red only where main is red reads as ready to merge, blocked on main, not as failing", () => {
    const pr = red(48, mainRed);
    expect(workStatus(item("a", { state: "review", pull_request: pr }), { chats: [chat("w", { state: "completed" })] })).toEqual({ group: "ready", reason: "CI red on main · not this PR" });
    expect(prStatus(pr)).toBe("CI red on main · not this PR");
    expect(prTone(pr)).toBeUndefined();
    // The runtime's old flag ("Checks are failing on #48.") is outdated by the comparison.
    expect(workStatus(item("a", { state: "needs_you", detail: "Checks are failing on #48.", pull_request: pr }), { chats: [chat("w", { state: "completed" })] })?.group).toBe("ready");
    // Main fixed since: still not this PR's, and the chip says what to do.
    expect(prStatus(red(48, { ...mainRed, base_state: "passing" }))).toBe("main fixed · re-run CI");
  });

  test("its own red checks, changes requested or a closed pull request need the person; green is ready; pending is for review", () => {
    const own = red(48, { ...mainRed, failing: ["test", "lint"] });
    expect(workStatus(item("a", { state: "needs_you", detail: "Checks are failing on #48.", pull_request: own }))).toEqual({ group: "needs", reason: "its own checks fail" });
    expect(prStatus(own)).toBe("CI failing");
    expect(workStatus(item("a", { state: "review", pull_request: { number: 1, url: url(1), state: "open", review: "changes_requested" } }))?.group).toBe("needs");
    expect(workStatus(item("a", { state: "review", pull_request: { number: 1, url: url(1), state: "closed" } }))?.group).toBe("needs");
    expect(workStatus(item("a", { state: "review", pull_request: { number: 1, url: url(1), state: "open", checks: "passing" } }))?.group).toBe("ready");
    expect(workStatus(item("a", { state: "review", pull_request: { number: 1, url: url(1), state: "open", checks: "pending" } }))).toEqual({ group: "review", reason: "CI running" });
    expect(workStatus(item("a", { state: "review" }))?.group).toBe("review");
  });

  test("merged is done, whatever the item still says; a question waiting is a decision", () => {
    expect(workStatus(item("a", { state: "review", pull_request: { number: 1, url: url(1), state: "merged" } }))?.group).toBe("done");
    expect(workStatus(item("a", { state: "started" }), { chats: [chat("w", { pullRequest: { number: 1, url: url(1), state: "merged" } })] })?.group).toBe("done");
    expect(workStatus(item("a", { state: "review", asked: { question: "Ship it?", recommended: "Yes", asked_at: t0 } }))).toEqual({ group: "needs", reason: "question" });
  });

  test("working only while a chat runs: a started item whose chats all finished is judged by what they left", () => {
    expect(workStatus(item("a", { state: "started" }), { chats: [chat("w", { state: "working" })] })?.group).toBe("working");
    expect(workStatus(item("a", { state: "started" }), { chats: [chat("w", { state: "completed" })] })?.group).toBe("review");
    expect(workStatus(item("a", { state: "started" }), { chats: [chat("w", { state: "completed", pullRequest: { number: 2, url: url(2), state: "open", checks: "passing" } })] })?.group).toBe("ready");
  });

  test("blocked says what it waits on: another item's pull request, its number, a slot; a chat's blocked report shows main's red", () => {
    const items = [item("fix", { number: 9, pull_request: { number: 39, url: url(39), state: "open" } }), item("other", { number: 4 })];
    expect(workStatus(item("a", { state: "blocked", blocked_on: { kind: "item", item_id: "fix" } }), { items })).toEqual({ group: "blocked", reason: "waits on #39" });
    expect(workStatus(item("a", { state: "blocked", blocked_on: { kind: "item", item_id: "other" } }), { items, key: "CH" })).toEqual({ group: "blocked", reason: "waits on CH-4" });
    expect(workStatus(item("a", { state: "blocked", blocked_on: { kind: "capacity" } }))?.reason).toBe("waits for a free chat slot");
    const report = "Status: blocked · Left: The checks can't go green until the fix for main lands.";
    expect(workStatus(item("a", { state: "needs_you", detail: report, pull_request: red(34, mainRed) }))).toEqual({ group: "blocked", reason: "CI red on main · not this PR" });
  });
});

describe("actions on a row", () => {
  const ready = (patch: Partial<Work> = {}): Work => ({
    item: item("a", { state: "review" }),
    id: "CH-26",
    title: "No chat limits",
    group: "ready",
    waiting: null,
    pr: { number: 48, url: "https://github.com/o/r/pull/48", state: "open", checks: "passing" },
    chats: [chat("w", { state: "completed" })],
    done: 1,
    changeSet: null,
    ...patch,
  });

  test("merge only when ready; re-run only when red; finishing whatever isn't done", () => {
    expect(workActions(ready())).toEqual(["merge", "openPr", "openChat", "done", "drop"]);
    const failing = ready({ group: "needs", pr: { number: 48, url: "u", state: "open", checks: "failing" } });
    expect(workActions(failing)).toEqual(["rerun", "openPr", "openChat", "done", "drop"]);
    expect(workActions(ready({ pr: { number: 48, url: "u", state: "draft", checks: "passing" } }))).not.toContain("merge");
    expect(workActions(ready({ group: "done", pr: { number: 48, url: "u", state: "merged" } }))).toEqual(["openPr", "openChat"]);
    expect(workActions(ready({ pr: undefined, chats: [], group: "queued" }))).toEqual(["done", "drop"]);
  });

  test("keys: bare letters only, Delete drops too", () => {
    const none = { meta: false, ctrl: false, alt: false };
    expect(actionOfKey("d", none)).toBe("done");
    expect(actionOfKey("R", none)).toBe("rerun");
    expect(actionOfKey("m", none)).toBe("merge");
    expect(actionOfKey("Delete", none)).toBe("drop");
    expect(actionOfKey("Backspace", none)).toBe("drop");
    expect(actionOfKey("d", { ...none, meta: true })).toBeUndefined();
    expect(actionOfKey("z", none)).toBeUndefined();
  });

  test("main green again: the pull requests it blocked are offered one re-run, which brings main's fix in", () => {
    const fixed = { base: "main", failing: ["test"], on_base: ["test"], base_state: "passing" } as const;
    const blocked = ready({ pr: { number: 48, url: "u", state: "open", checks: "failing", base_ci: fixed } });
    const stillRed = ready({ pr: { number: 46, url: "u", state: "open", checks: "failing", base_ci: { ...fixed, base_state: "failing" } } });
    expect(blockedByFixedBase([blocked, stillRed, ready()]).map((w) => w.pr?.number)).toEqual([48]);
    expect(chatToOpen([chat("a", { state: "completed" }), chat("b", { state: "needs_input" })])?.id).toBe("b");
    expect(workProject(ready())).toBe("p-app");
  });
});

describe("the strip on the Chief's box", () => {
  test("what waits on you first, then what works; nothing queued or done; each with its line and its start", () => {
    const board = [
      item("w", { state: "started", title: "Refactor the parser", workspace_ids: ["c1"] }),
      item("n", { state: "needs_you", title: "Pick a database", detail: "Postgres or SQLite?" }),
      item("q", { state: "queued" }),
      item("d", { state: "done", workspace_ids: ["c2"] }),
    ];
    const chats = [chat("c1", { state: "working", detail: "running tests", createdAt: "2026-10-28T08:00:00.000Z" } as Partial<WorkspaceView>)];
    expect(chiefAtWork(board, chats)).toEqual([
      { id: "n", title: "Pick a database", startedAt: t0, asking: true, activity: "Postgres or SQLite?", activityAt: t0 },
      { id: "w", title: "Refactor the parser", startedAt: "2026-10-28T08:00:00.000Z", asking: false, activity: "running tests", activityAt: "" },
    ]);
  });

  test("a note the Chief asked about is on the strip and not in the tray: shown once", () => {
    const asked = item("a", { state: "blocked", blocked_on: { kind: "you", reason: "Postgres or SQLite?" }, asked: { question: "Postgres or SQLite?", recommended: "SQLite", asked_at: t0 } });
    expect(chiefAtWork([asked], []).map((w) => w.id)).toEqual(["a"]);
    expect(queuedNotes([asked])).toEqual([]);
  });
});

describe("the strip's line", () => {
  test("a question that waits on you is the line it shows, over a working chat's step", () => {
    const board = [
      item("n", { state: "needs_you", title: "Pick a database", asked: { question: "Postgres or SQLite?", recommended: "SQLite", asked_at: t0 } }),
      item("w", { state: "started", title: "Refactor the parser", workspace_ids: ["c1"] }),
    ];
    const chats = [chat("c1", { state: "working", detail: "running tests" } as Partial<WorkspaceView>)];
    expect(waitingLine(chiefAtWork(board, chats))).toEqual({ who: "Pick a database:", activity: "Postgres or SQLite?" });
  });
});

