import type { Workspace } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import type { WorkspaceView } from "../model.ts";
import type { ChatListSnapshot } from "./chat-list.ts";
import { chatLink } from "../../components/transcript/links.ts";
import { chatWorkspace, formerRoot, liveRuntimes, mergeChats, noticeable, whereOf } from "./chats-view.ts";
import { runtime, summary } from "./fakes.test-support.ts";
import type { ChatSummary, RuntimeState } from "./wire.ts";

const local = (id: string, session: string, over: Partial<WorkspaceView> = {}): WorkspaceView => ({
  id,
  title: `Local ${id}`,
  repo: "app",
  repoRef: { path: "/src/app" },
  branch: "main",
  state: "completed",
  asleep: false,
  detail: null,
  engine: { id: "caveman", label: "Caveman" },
  computer: { kind: "this_mac", label: "This Mac" },
  parentId: null,
  sessionId: session,
  projectId: "p1",
  createdAt: "2026-10-21T10:00:00.000Z",
  updatedAt: "2026-10-21T11:00:00.000Z",
  unread: true,
  ...over,
});
const list = (chats: ChatSummary[], runtimes: RuntimeState[] = []): ChatListSnapshot => ({
  status: "live",
  chats: new Map(chats.map((c) => [c.session_id, c])),
  runtimes: new Map(runtimes.map((r) => [r.runtime_id, r])),
  seq: 9,
  ready: true,
});
const HOME = "rt-mac";

test("a chat in both the Cloud list and this runtime's list is one row, where the person left it", () => {
  const rows = mergeChats(
    [local("w1", "s1"), local("w2", "s2")],
    list([summary("s1", { workspace_id: "w1", runtime_id: HOME, where: { kind: "laptop", name: "Julius's MacBook" }, head: 4, person: { seen_cursor: 4, pinned: false } }), summary("s3")], [runtime("rt-cloud-1")]),
    HOME,
  );
  expect(rows.map((r) => r.id)).toEqual(["w1", "w2", "w-s3"]);
  expect(rows.filter((r) => r.sessionId === "s1")).toHaveLength(1);
  // Read on another device: read here too.
  expect(rows[0]!.unread).toBe(false);
  expect(rows[0]!.computer.kind).toBe("this_mac");
  expect(rows[0]!.synced?.remote).toBe(false);
  expect(rows[2]!.synced?.remote).toBe(true);
});

test("a chat the lid moved to a Cloud computer keeps its row and says where it runs now", () => {
  const rows = mergeChats(
    [local("w1", "s1", { state: "queued", asleep: true })],
    list([summary("s1", { workspace_id: "w1", runtime_id: "rt-cloud-1", status: "working", head: 9 })], [runtime("rt-cloud-1")]),
    HOME,
  );
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ id: "w1", projectId: "p1", state: "working", asleep: false, computer: { kind: "caveman_cloud", label: "Cloud computer 1" } });
  expect(rows[0]!.synced).toMatchObject({ remote: true, where: { kind: "cloud", runtimeId: "rt-cloud-1", online: true } });
});

test("chats on two Cloud computers and another Mac, with an asleep computer, map to rows", () => {
  const rows = mergeChats(
    [],
    list(
      [
        summary("a", { runtime_id: "rt-1", where: { kind: "cloud", name: "api-box" }, status: "needs_you", needs_you: { kind: "approval", summary: "Run the migration?" } }),
        summary("b", { runtime_id: "rt-2", where: { kind: "cloud", name: "web-box" } }),
        summary("c", { runtime_id: "rt-laptop", where: { kind: "laptop", name: "Work MacBook" } }),
        summary("d", { kind: "chief" }),
        summary("e", { archived: true }),
      ],
      [runtime("rt-1"), runtime("rt-2", { online: false, computer_state: "suspended" }), runtime("rt-laptop", { kind: "laptop", online: false })],
    ),
    HOME,
  );
  expect(rows.map((r) => r.sessionId)).toEqual(["a", "b", "c"]);
  expect(rows[0]).toMatchObject({ state: "needs_input", activity: { ask: { kind: "approval", prompt: "Run the migration?" } } });
  expect(rows[1]).toMatchObject({ asleep: true, synced: { where: { kind: "cloud", online: false, asleep: true } } });
  expect(rows[2]).toMatchObject({ computer: { kind: "laptop", label: "Work MacBook" }, synced: { where: { online: false } } });
});

test("no Cloud list: this runtime's chats as they are", () => {
  const mine = [local("w1", "s1")];
  expect(mergeChats(mine, null, HOME)).toBe(mine);
});

test("a synced chat's pins, done and snooze are Cloud's, not the runtime's", () => {
  const rows = mergeChats(
    [local("w1", "s1", { inbox: { doneAt: null, snoozedUntil: null, snoozedAt: null, pinnedAt: "2026-10-20T00:00:00.000Z" } })],
    list([summary("s1", { workspace_id: "w1", runtime_id: HOME, person: { seen_cursor: 0, pinned: false, done_at: "2026-10-21T09:00:00.000Z" } })]),
    HOME,
  );
  expect(rows[0]!.inbox).toEqual({ doneAt: "2026-10-21T09:00:00.000Z", snoozedUntil: null, snoozedAt: null, pinnedAt: null });
});

test("a builder on a Cloud computer sits under its lead, wherever the lead runs", () => {
  const rows = mergeChats(
    [local("w-lead", "s-lead")],
    list([summary("s-b1", { kind: "builder", parent_session_id: "s-lead" }), summary("s-b2", { kind: "builder", parent_session_id: "s-cloud-lead" }), summary("s-cloud-lead", { workspace_id: "w-cloud-lead" })]),
    HOME,
  );
  expect(rows.find((r) => r.sessionId === "s-b1")?.parentId).toBe("w-lead");
  expect(rows.find((r) => r.sessionId === "s-b2")?.parentId).toBe("w-cloud-lead");
});

test("a chat the lid moved reads as Cloud says: the turn the move cut on this runtime does not make it Stopped", () => {
  const cut = { ask: null, turnStartedAt: null, lastOutcome: "interrupted" as const, turnEndedAt: null, todos: null, readyToBuild: false };
  const rows = mergeChats(
    [local("w1", "s1", { activity: cut, unread: true })],
    list([summary("s1", { workspace_id: "w1", runtime_id: "rt-cloud-1", status: "idle", head: 9 })], [runtime("rt-cloud-1")]),
    HOME,
  );
  expect(rows[0]!.activity).toBeUndefined();
  // On this runtime still, its own last turn is its word.
  const here = mergeChats([local("w1", "s1", { activity: cut })], list([summary("s1", { workspace_id: "w1", runtime_id: HOME, head: 9 })]), HOME);
  expect(here[0]!.activity).toEqual(cut);
});

test("a chat on another Mac running mail from a chat here says whose it is, so only the asking chat tells the person", () => {
  const seen = noticeable(new Map(), list([summary("s-helper", { kind: "chat", status: "working", asked_by_session_id: "s-asker" }), summary("s-other", { kind: "chat" })]), HOME);
  expect(seen.get("w-s-helper")?.asked_by_session_id).toBe("s-asker");
  expect(seen.get("w-s-other")).not.toHaveProperty("asked_by_session_id");
});

test("every chat on a Cloud computer reads as a workspace that keeps its lead, the same object until Cloud's word on it changes", () => {
  const lead = summary("s-lead", { workspace_id: "w-lead" });
  const builder = summary("s-b1", { workspace_id: "w-b1", kind: "builder", parent_session_id: "s-lead", status: "working" });
  const first = noticeable(new Map(), list([lead, builder]), HOME);
  expect(first.get("w-b1")?.parent_workspace_id).toBe("w-lead");
  expect(chatWorkspace(builder, whereOf(builder, new Map(), HOME), undefined, "w-lead").parent_workspace_id).toBe("w-lead");
  // Another chat changed: this one's workspace is the one a pane already holds, so nothing that shows it re-renders.
  const again = noticeable(new Map(), list([lead, builder, summary("s-other")]), HOME);
  expect(again.get("w-b1")).toBe(first.get("w-b1"));
});

// markMovedAway's parked record: this Mac's worktree and the ports it allocated there stay on it.
const parked: Workspace = {
  id: "w1",
  title: "Fix login",
  repo: { url: "https://github.com/acme/app" },
  base_ref: "main",
  branch: "fix-login",
  engine: "caveman",
  computer: { id: "this-mac", kind: "this_mac", label: "MacBook", status: "online" },
  session_id: "s1",
  status: "parked",
  root_path: "/Users/dev/.caveman/worktrees/app-fix-login",
  ports: { web: 4310 },
  project_id: "p1",
  created_at: "2026-10-21T10:00:00.000Z",
  updated_at: "2026-10-21T11:00:00.000Z",
};
const movedTo = () => [
  summary("s1", { workspace_id: "w1", runtime_id: "rt-cloud-1", status: "working" }),
  summary("s1", { workspace_id: "w1", runtime_id: "rt-studio", where: { kind: "laptop", name: "Studio" }, status: "working" }),
];
const moveRuntimes = new Map([runtime("rt-cloud-1"), runtime("rt-studio", { kind: "laptop" })].map((r) => [r.runtime_id, r]));

test("a chat this Mac moved to another computer opens with none of this Mac's checkout paths or ports", () => {
  for (const chat of movedTo()) {
    const shown = chatWorkspace(chat, whereOf(chat, moveRuntimes, HOME), parked);
    expect(shown.computer.kind).not.toBe("this_mac");
    // Copy absolute path, the environment card's ports and the localhost server links read these: none is where it runs.
    expect(shown).not.toHaveProperty("root_path");
    expect(shown).not.toHaveProperty("ports");
    // The chat itself is the one this Mac knew.
    expect(shown).toMatchObject({ id: "w1", branch: "fix-login", project_id: "p1", status: "working" });
  }
});

test("a chat this Mac moved to another computer still opens its earlier turns' files: this Mac's path reads relative to the chat's folder", () => {
  for (const chat of movedTo()) {
    const shown = chatWorkspace(chat, whereOf(chat, moveRuntimes, HOME), parked);
    // An answer from before the move links the file by this Mac's checkout; the moved branch has it at src/login.ts.
    expect(chatLink(`${parked.root_path}/src/login.ts#L12`, formerRoot(shown))).toEqual({ kind: "file", path: "src/login.ts", line: 12 });
    expect(shown).not.toHaveProperty("root_path");
  }
  // Only a chat this Mac held has one: a chat Cloud's list alone knows, and a record of this runtime's own, have none.
  const elsewhere = movedTo()[0]!;
  expect(formerRoot(chatWorkspace(elsewhere, whereOf(elsewhere, moveRuntimes, HOME)))).toBeNull();
  expect(formerRoot(parked)).toBeNull();
});

test("a runtime Cloud has never heard from (last_seen_at null) is older word of its computer than one it has", () => {
  const heard = runtime("heard", { computer_id: "box", seq: 4, last_seen_at: "2026-11-16T11:00:00.000Z" });
  const never = runtime("never", { computer_id: "box", seq: 4, last_seen_at: null });
  expect(liveRuntimes(new Map([[never.runtime_id, never], [heard.runtime_id, heard]])).get("box")?.runtime_id).toBe("heard");
  expect(liveRuntimes(new Map([[heard.runtime_id, heard], [never.runtime_id, never]])).get("box")?.runtime_id).toBe("heard");
});
