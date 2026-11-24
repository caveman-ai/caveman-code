// The sidebar's lists (sidebar/model.ts): both ways of reading the chats, the Chiefs' cut-off and their order by when
// you last opened them, subagents kept under their parents, and which row wears the selection.
import { describe, expect, it, vi } from "vitest";

vi.mock("../store/persist", () => ({
  KEYS: { board: "board", inbox: "inbox", sessions: "sessions", boot: "boot" },
  read: () => null,
  write: () => {},
  flush: () => {},
  remove: () => {},
  clearPersisted: () => {},
  onLeave: () => () => {},
  FRESH: false,
}));

import type { Chat } from "../board/model";
import { EMPTY_INBOX, type InboxState } from "../store/inbox";
import { chiefsView, cutOff, type Folds, hereOf, isHere, isShut, projectsView, queueView, type SideChat, sideChats, type SideInputs, stateWord, toggledFold } from "./model";

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const DAY = 86_400_000;

function chat(id: string, over: Partial<Chat> = {}): Chat {
  return { id, title: id, repo: "app", device: "mbp", engine: "claude", model: "opus", phase: "done", line: "", items: [], startedAt: NOW - DAY, updatedAt: NOW - 10 * MIN, ...over };
}

const NO_FOLDS: Folds = { folded: [], expanded: [] };

function inputs(chats: Chat[], inbox: Partial<InboxState> = {}, over: Partial<SideInputs> = {}): SideInputs {
  return { chats, inbox: { ...EMPTY_INBOX, ...inbox }, prs: new Map(), open: null, now: NOW, ...over };
}

const ids = (rows: readonly { id: string }[]) => rows.map((r) => r.id);

describe("rows", () => {
  it("keeps subagents under their parent, never as rows, and lets their ask light the parent up", () => {
    const chats = [chat("lead", { phase: "working" }), chat("kid-a", { parent: "lead", phase: "working" }), chat("kid-b", { parent: "lead", phase: "needs", line: "wants to run pnpm add x", updatedAt: NOW - MIN })];
    const rows = sideChats(inputs(chats));
    expect(ids(rows)).toEqual(["lead"]);
    expect(ids(rows[0]!.agents)).toEqual(["kid-a", "kid-b"]);
    expect(rows[0]!.phase).toBe("needs");
    // A tap opens the subagent that asks, as nav/ref.ts openRow does.
    expect(rows[0]!.opens).toBe("kid-b");
    // Its activity is its subagents' too.
    expect(rows[0]!.at).toBe(NOW - MIN);
  });

  it("reads unread as the desktop does: something to answer or look at since you last had it open", () => {
    const chats = [chat("ask", { phase: "needs" }), chat("seen", { phase: "ready" }), chat("new", { phase: "ready" }), chat("busy", { phase: "working" }), chat("open", { phase: "needs" })];
    const rows = sideChats(inputs(chats, { seen: { seen: "ready" } }, { open: "open" }));
    const unread = Object.fromEntries(rows.map((r) => [r.id, r.unread]));
    expect(unread).toEqual({ ask: true, seen: false, new: true, busy: false, open: false });
  });

  it("leaves archived chats out and takes the name you gave", () => {
    const rows = sideChats(inputs([chat("a"), chat("b")], { archived: { a: true }, titles: { b: "Renamed" } }));
    expect(ids(rows)).toEqual(["b"]);
    expect(rows[0]!.title).toBe("Renamed");
  });
});

describe("by project", () => {
  const chats = [
    chat("old-app", { repo: "app", updatedAt: NOW - 50 * MIN }),
    chat("new-app", { repo: "app", phase: "working", updatedAt: NOW - 2 * MIN }),
    chat("cloud", { repo: "cloud", phase: "ready", updatedAt: NOW - 5 * MIN }),
    chat("pin", { repo: "app", pinned: true, updatedAt: NOW - 90 * MIN }),
    chat("ancient", { repo: "attic", updatedAt: NOW - 9 * DAY }),
  ];

  it("leads with Pinned, then a folder per project, newest first inside and out, then Recent", () => {
    const view = projectsView(sideChats(inputs(chats)), NO_FOLDS, { chat: null, chief: null }, NOW);
    expect(view.map((s) => s.key)).toEqual(["pinned", "project:app", "project:cloud", "project:attic", "recent"]);
    expect(ids(view[1]!.rows)).toEqual(["new-app", "old-app"]);
    expect(ids(view.at(-1)!.rows)).toEqual(["new-app", "cloud", "old-app", "pin", "ancient"]);
  });

  it("starts a quiet project folded, and opens it against that", () => {
    const view = projectsView(sideChats(inputs(chats)), NO_FOLDS, { chat: null, chief: null }, NOW);
    const attic = view.find((s) => s.key === "project:attic")!;
    expect(attic.shut).toBe(true);
    expect(view.find((s) => s.key === "project:app")!.shut).toBe(false);
    const opened = toggledFold(NO_FOLDS, "project:attic", true);
    expect(isShut(opened, "project:attic", true)).toBe(false);
    expect(isShut(toggledFold(opened, "project:attic", true), "project:attic", true)).toBe(true);
    // A section that starts open folds into the folded list, and back.
    const folded = toggledFold(NO_FOLDS, "recent");
    expect(folded.folded).toEqual(["recent"]);
    expect(toggledFold(folded, "recent")).toEqual(NO_FOLDS);
  });

  it("cuts a project at five and Recent at eight, keeping the chat on screen in view", () => {
    const many = Array.from({ length: 12 }, (_, i) => chat(`c${i}`, { updatedAt: NOW - i * MIN }));
    const rows = sideChats(inputs(many));
    const view = projectsView(rows, NO_FOLDS, { chat: "c10", chief: null }, NOW);
    const app = view.find((s) => s.key === "project:app")!;
    expect(ids(app.rows)).toEqual(["c0", "c1", "c2", "c3", "c4", "c10"]);
    expect(app.hidden).toBe(6);
    expect(view.find((s) => s.key === "recent")!.rows).toHaveLength(9);
    const all = projectsView(rows, { folded: [], expanded: ["project:app"] }, { chat: null, chief: null }, NOW);
    expect(all.find((s) => s.key === "project:app")!.rows).toHaveLength(12);
  });
});

describe("the queue", () => {
  it("sorts by state into the queue and the shelves, as T3's sidebar does", () => {
    const chats = [
      chat("late-ask", { phase: "needs", need: { kind: "approval", command: "x", summary: "", at: NOW - 2 * MIN } }),
      chat("early-ask", { phase: "needs", need: { kind: "approval", command: "y", summary: "", at: NOW - 30 * MIN } }),
      chat("looked", { phase: "ready", updatedAt: NOW - MIN }),
      chat("fresh", { phase: "ready", updatedAt: NOW - 20 * MIN }),
      chat("busy-old", { phase: "working" }),
      chat("busy-new", { phase: "working" }),
      chat("merged", { phase: "done", updatedAt: NOW - 3 * MIN }),
      chat("over", { phase: "done", updatedAt: NOW - 60 * MIN }),
      chat("nap", { phase: "ready" }),
      chat("pin", { phase: "working", pinned: true }),
      chat("pin-done", { phase: "done", pinned: true, updatedAt: NOW - 90 * MIN }),
    ];
    const inbox = { seen: { looked: "ready" as const }, since: { "busy-old": NOW - 40 * MIN, "busy-new": NOW - 5 * MIN }, snoozed: { nap: { at: NOW - MIN, phase: "ready" as const, until: NOW + 60 * MIN } } };
    const view = queueView(sideChats(inputs(chats, inbox)), { folded: ["shelf:settled", "shelf:snoozed"], expanded: [] }, { chat: null, chief: null });
    const by = Object.fromEntries(view.map((s) => [s.key, ids(s.rows)]));
    expect(view.map((s) => s.key)).toEqual(["pinned", "queue", "shelf:working", "shelf:snoozed", "shelf:settled"]);
    // A pinned chat is never settled by its merge (the runtime's ThreadSettlementService): it keeps its pin.
    expect(by.pinned).toEqual(["pin", "pin-done"]);
    // The oldest ask first, then what is new to look at before what you looked at already.
    expect(by.queue).toEqual(["early-ask", "late-ask", "fresh", "looked"]);
    expect(by["shelf:working"]).toEqual(["busy-new", "busy-old"]);
    expect(by["shelf:snoozed"]).toEqual(["nap"]);
    // The Done shelf, newest first.
    expect(by["shelf:settled"]).toEqual(["merged", "over"]);
    expect(view.find((s) => s.key === "shelf:settled")!.shut).toBe(true);
    // What waits on you never folds away.
    expect(queueView(sideChats(inputs(chats, inbox)), { folded: ["queue"], expanded: [] }, { chat: null, chief: null }).find((s) => s.key === "queue")!.shut).toBe(false);
  });

  it("wakes a snoozed chat that asks, or whose turn moved on", () => {
    const chats = [chat("asks", { phase: "needs" }), chat("moved", { phase: "ready" }), chat("over", { phase: "working" })];
    const snoozed = { asks: { at: 0, phase: "working" as const, until: NOW + DAY }, moved: { at: 0, phase: "working" as const, until: NOW + DAY }, over: { at: 0, phase: "working" as const, until: NOW - 1 } };
    const rows = sideChats(inputs(chats, { snoozed }));
    expect(rows.map((r) => r.snoozedUntil)).toEqual([null, null, null]);
  });

  it("says each state in a word, and leaves Ready unlabelled", () => {
    expect(stateWord({ phase: "needs", pr: null })).toEqual({ word: "Needs you", tone: "needs" });
    expect(stateWord({ phase: "working", pr: null })?.word).toBe("Working");
    expect(stateWord({ phase: "ready", pr: { state: "open", number: 1 } })).toBeNull();
    expect(stateWord({ phase: "done", pr: { state: "merged", number: 1 } })?.word).toBe("Merged");
    // A shelf that says it in its head doesn't say it on every row.
    expect(stateWord({ phase: "working", pr: null }, "working")).toBeNull();
    expect(stateWord({ phase: "done", pr: null }, "settled")).toBeNull();
    expect(stateWord({ phase: "done", pr: { state: "merged", number: 1 } }, "settled")?.word).toBe("Merged");
  });
});

describe("the Chiefs", () => {
  const chiefs = ["home", "oona", "grug", "ada", "bo"].map((id) => ({ id, needs: 0, working: 0, ready: 0 }));

  it("puts the ones you opened last first and the rest in their own order", () => {
    const { shown, hidden } = chiefsView(chiefs, { grug: NOW - MIN, bo: NOW }, false);
    expect(ids(shown)).toEqual(["bo", "grug", "home"]);
    expect(hidden).toBe(2);
  });

  it("drops the rest open, and always shows the Chief on screen", () => {
    expect(ids(chiefsView(chiefs, {}, true).shown)).toEqual(["home", "oona", "grug", "ada", "bo"]);
    const kept = chiefsView(chiefs, {}, false, "bo");
    expect(ids(kept.shown)).toEqual(["home", "oona", "grug", "bo"]);
    expect(kept.hidden).toBe(1);
  });

  it("shows three or fewer whole", () => {
    expect(cutOff(chiefs.slice(0, 3), 3, false)).toEqual({ shown: chiefs.slice(0, 3), hidden: 0 });
  });
});

describe("selection", () => {
  const rows = sideChats(inputs([chat("lead", { phase: "working" }), chat("kid", { parent: "lead", phase: "working" }), chat("other")]));
  const ids = new Set(["lead", "kid", "other"]);

  it("marks the chat or the Chief in the main panel, a chat's guide as the chat", () => {
    expect(hereOf({ name: "Thread", id: "other" }, ids)).toEqual({ chat: "other", chief: null });
    expect(hereOf({ name: "Chief", id: "oona" }, ids)).toEqual({ chat: null, chief: "oona" });
    expect(hereOf({ name: "Guide", id: "other" }, ids)).toEqual({ chat: "other", chief: null });
    expect(hereOf({ name: "Guide", id: "Caveman Cloud-612" }, ids)).toEqual({ chat: null, chief: null });
    expect(hereOf({ name: "Home" }, ids)).toEqual({ chat: null, chief: null });
  });

  it("lights a parent while one of its subagents is on screen and its group is shut", () => {
    const lead = rows.find((r) => r.id === "lead") as SideChat;
    expect(isHere(lead, { chat: "kid", chief: null }, false)).toBe(true);
    expect(isHere(lead, { chat: "kid", chief: null }, true)).toBe(false);
    expect(isHere(lead, { chat: "lead", chief: null }, true)).toBe(true);
  });
});
