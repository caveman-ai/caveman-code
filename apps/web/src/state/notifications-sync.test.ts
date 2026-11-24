// Needs-you across computers: a chat on a Cloud computer or another Mac raises the notice, the title count and the
// badge from Cloud's list as this runtime's own chats do, one notice per transition whichever source reports it.
import type { Workspace } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { mergeNewer, needsYouCount, noticesBetween, titleFor } from "./notifications.ts";
import type { ChatListSnapshot } from "./sync/chat-list.ts";
import { noticeable } from "./sync/chats-view.ts";
import { runtime, summary } from "./sync/fakes.test-support.ts";
import type { ChatSummary } from "./sync/wire.ts";

const settings = { needs_input: true, turn_done: true };
const HOME = "rt-mac";
const at = (min: number) => new Date(Date.parse("2026-10-21T12:00:00.000Z") + min * 60_000).toISOString();
const local = (id: string, status: Workspace["status"], min: number): Workspace => ({
  id,
  title: `Local ${id}`,
  repo: { url: "https://github.com/acme/app" },
  base_ref: "main",
  branch: "main",
  engine: "caveman",
  computer: { id: "c-mac", kind: "this_mac", label: "This Mac", status: "online" },
  session_id: `s-${id}`,
  status,
  created_at: at(0),
  updated_at: at(min),
});
const list = (chats: ChatSummary[]): ChatListSnapshot => ({ status: "live", chats: new Map(chats.map((c) => [c.session_id, c])), runtimes: new Map([["rt-box", runtime("rt-box")]]), seq: 1, ready: true });
const boxChat = (status: ChatSummary["status"], min: number, extra: Partial<ChatSummary> = {}) =>
  summary("s-box", { workspace_id: "w-box", runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, title: "Go 1.26 upgrade", status, last_activity_at: at(min), ...extra });
const homeChat = (status: ChatSummary["status"], min: number) => summary("s-w1", { workspace_id: "w1", runtime_id: HOME, where: { kind: "laptop", name: "Julius's MacBook" }, status, last_activity_at: at(min) });

/** A window's notice loop: whole views (the poll, the list stream) and single pushes (workspace.changed). */
const window = () => {
  let known: Map<string, Workspace> | null = null;
  const posted: string[] = [];
  const step = (next: Map<string, Workspace>) => {
    const before = known;
    known = next;
    if (before) for (const { notice } of noticesBetween(before, next, settings)) posted.push(`${notice.title}: ${notice.body}`);
  };
  return {
    posted,
    view: (raw: Workspace[], chats: ChatSummary[]) => step(mergeNewer(known ?? new Map(), noticeable(new Map(raw.map((w) => [w.id, w])), list(chats), HOME).values(), true)),
    push: (w: Workspace) => known && step(mergeNewer(known, [w], false)),
    count: () => needsYouCount(known ?? new Map()),
  };
};

test("a chat on a Cloud computer that starts needing you raises one notice and counts in the title", () => {
  const win = window();
  win.view([local("w1", "idle", 1)], [boxChat("working", 1)]);
  win.view([local("w1", "idle", 1)], [boxChat("needs_you", 2, { needs_you: { kind: "approval", summary: "Run the migration?" } })]);
  expect(win.posted).toEqual(["Needs you: Go 1.26 upgrade"]);
  expect(win.count()).toBe(1);
  expect(titleFor(win.count())).toBe("(1) Caveman Code");
  // The list stream sends the chat again (a read mark changed elsewhere): no second notice.
  win.view([local("w1", "idle", 1)], [boxChat("needs_you", 2, { person: { seen_cursor: 9, pinned: false } })]);
  expect(win.posted).toHaveLength(1);
  // It finishes there.
  win.view([local("w1", "idle", 1)], [boxChat("idle", 3)]);
  expect(win.posted).toEqual(["Needs you: Go 1.26 upgrade"]);
  expect(win.count()).toBe(0);
});

test("this runtime's own chat that needs you is one notice, whether its push or Cloud's list says it first", () => {
  const win = window();
  win.view([local("w1", "working", 1)], [homeChat("working", 1)]);
  // The runtime's push first, then the poll and Cloud's list agree.
  win.push(local("w1", "needs_input", 2));
  win.view([local("w1", "needs_input", 2)], [homeChat("needs_you", 2)]);
  expect(win.posted).toEqual(["Needs you: Local w1"]);
  // Cloud's list alone (the push and poll lag) changes nothing for a chat this runtime holds: its own word wins.
  const other = window();
  other.view([local("w1", "working", 1)], [homeChat("working", 1)]);
  other.view([local("w1", "working", 1)], [homeChat("needs_you", 2)]);
  expect(other.posted).toEqual([]);
});

test("a chat the lid moved to a Cloud computer is Cloud's: its parked record here raises nothing, its state there does", () => {
  const win = window();
  const moved = (status: ChatSummary["status"], min: number) => summary("s-w1", { workspace_id: "w1", runtime_id: "rt-box", where: { kind: "cloud", name: "api-box" }, status, last_activity_at: at(min) });
  win.view([local("w1", "parked", 1)], [moved("working", 1)]);
  win.view([local("w1", "parked", 1)], [moved("needs_you", 2)]);
  win.view([local("w1", "parked", 1)], [moved("needs_you", 2)]);
  expect(win.posted).toEqual(["Needs you: Chat s-w1"]); // Cloud's title, the chat's own now
});
