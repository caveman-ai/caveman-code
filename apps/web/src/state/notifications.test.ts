import type { ChiefItem, Settings, Workspace } from "@caveman-app/session-protocol";
import { expect, test, vi } from "vitest";

vi.mock("./runtime.tsx", () => ({}));
import {
  chiefNotices,
  clearNotices,
  clip,
  mergeNewer,
  needsYouCount,
  noticeFor,
  post,
  postNotices,
  titleFor,
  waitsOnYou,
  type ChiefNow,
  type ChiefsHeard,
  type ChiefsNow,
} from "./notifications.ts";

const on = { needs_input: true, turn_done: true };
const ws = (status: Workspace["status"], extra: Partial<Workspace> = {}) => ({ id: "w1", title: "Fix webhook retry storm", status, ...extra }) as Workspace;

test("a session that starts waiting on you says so", () => {
  expect(noticeFor(ws("working"), ws("needs_input"), on)).toEqual({ title: "Needs you", body: "Fix webhook retry storm" });
  expect(noticeFor(ws("needs_input"), ws("needs_input"), on)).toBeNull();
});

test("a session that finishes or fails says so", () => {
  expect(noticeFor(ws("working"), ws("idle"), on)?.title).toBe("Finished");
  expect(noticeFor(ws("starting"), ws("failed"), on)?.title).toBe("Stopped with an error");
  // Archiving or restoring a finished one is not news.
  expect(noticeFor(ws("archived"), ws("idle"), on)).toBeNull();
});

test("a turn that ends while work that wakes it still runs is not finished; a failure still says so", () => {
  const awaiting = { activity: { last_outcome: "completed" as const, awaiting: true as const } };
  expect(noticeFor(ws("working"), ws("idle", awaiting), on)).toBeNull();
  expect(noticeFor(ws("working"), ws("failed", awaiting), on)?.title).toBe("Stopped with an error");
});

test("a chat whose waited-on work settles without waking it (a watched pull request merged) says Finished once", () => {
  const awaiting = { activity: { last_outcome: "completed" as const, awaiting: true as const } };
  const settled = { activity: { last_outcome: "completed" as const } };
  expect(noticeFor(ws("working"), ws("idle", awaiting), on)).toBeNull();
  expect(noticeFor(ws("idle", awaiting), ws("idle", settled), on)?.title).toBe("Finished");
  expect(noticeFor(ws("idle", settled), ws("idle", settled), on)).toBeNull();
  expect(noticeFor(ws("idle", awaiting), ws("idle", settled), { needs_input: true, turn_done: false })).toBeNull();
});

test("each kind follows its own setting", () => {
  expect(noticeFor(ws("working"), ws("needs_input"), { needs_input: false, turn_done: true })).toBeNull();
  expect(noticeFor(ws("working"), ws("idle"), { needs_input: true, turn_done: false })).toBeNull();
});

test("nothing on first sight, and nothing for a lead's builders or the Chief", () => {
  expect(noticeFor(undefined, ws("needs_input"), on)).toBeNull();
  expect(noticeFor(ws("working"), ws("idle", { parent_workspace_id: "lead" }), on)).toBeNull();
  expect(noticeFor(ws("working", { kind: "chief" }), ws("idle", { kind: "chief" }), on)).toBeNull();
});

test("a lead's agent that waits on you while its lead is not at work says so (an approval the lead cannot answer)", () => {
  const lead = (status: Workspace["status"]) => ({ id: "lead", title: "Ship the release", status }) as Workspace;
  const agent = (status: Workspace["status"]) => ws(status, { parent_workspace_id: "lead", title: "Write the notes" });
  expect(noticeFor(agent("working"), agent("needs_input"), on, lead("idle"))).toEqual({ title: "Needs you", body: "Write the notes · agent of Ship the release" });
  // A lead at work (or itself waiting on you) speaks for its agents.
  expect(noticeFor(agent("working"), agent("needs_input"), on, lead("working"))).toBeNull();
  expect(noticeFor(agent("working"), agent("needs_input"), on, lead("needs_input"))).toBeNull();
  // Only the moment it starts waiting, only with the setting on, and never a finished agent.
  expect(noticeFor(agent("needs_input"), agent("needs_input"), on, lead("idle"))).toBeNull();
  expect(noticeFor(agent("working"), agent("needs_input"), { needs_input: false, turn_done: true }, lead("idle"))).toBeNull();
  expect(noticeFor(agent("working"), agent("idle"), on, lead("idle"))).toBeNull();
});

// The posting itself, on stand-ins for the browser's Notification, document and window.
class FakeNotice {
  static permission: NotificationPermission = "granted";
  static posted: FakeNotice[] = [];
  closed = false;
  private onClick: (() => void) | undefined;
  readonly title: string;
  readonly options: NotificationOptions;
  constructor(title: string, options: NotificationOptions) {
    this.title = title;
    this.options = options;
    FakeNotice.posted.push(this);
  }
  close() {
    this.closed = true;
  }
  addEventListener(_: "click", fn: () => void) {
    this.onClick = fn;
  }
  click() {
    this.onClick?.();
  }
}

function browser(visible: boolean, permission: NotificationPermission = "granted") {
  FakeNotice.permission = permission;
  FakeNotice.posted = [];
  vi.stubGlobal("Notification", FakeNotice);
  vi.stubGlobal("document", { visibilityState: visible ? "visible" : "hidden", hasFocus: () => visible });
  const focus = vi.fn();
  vi.stubGlobal("window", { focus });
  return focus;
}

const list = (...items: Workspace[]) => new Map(items.map((w) => [w.id, w]));

test("posts only while the app is away and allowed; a click opens the session; coming back clears", () => {
  const before = list(ws("working"));
  const after = list(ws("needs_input"));
  const open = vi.fn();

  browser(true);
  postNotices(before, after, on, new Map(), open);
  expect(FakeNotice.posted).toHaveLength(0);

  browser(false, "default");
  postNotices(before, after, on, new Map(), open);
  expect(FakeNotice.posted).toHaveLength(0);

  const focus = browser(false);
  const shown = new Map<string, Notification>();
  postNotices(before, after, on, shown, open);
  expect(FakeNotice.posted.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([["Needs you", "Fix webhook retry storm", "workspace:w1"]]);
  FakeNotice.posted[0]!.click();
  expect(focus).toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith("/w/w1");

  postNotices(list(ws("working")), list(ws("idle")), on, shown, open);
  expect(FakeNotice.posted[0]!.closed).toBe(true); // the newer notice replaces it
  clearNotices(shown);
  expect(FakeNotice.posted[1]!.closed).toBe(true);
  expect(shown.size).toBe(0);
  vi.unstubAllGlobals();
});

test("the desktop's Dock badge counts the sessions posted while away, and coming back clears it", () => {
  browser(false);
  const setBadge = vi.fn();
  vi.stubGlobal("window", { focus: vi.fn(), cavemanDesktop: { setBadge } });
  const shown = new Map<string, Notification>();
  const two = (status: Workspace["status"]) => list(ws(status), ws(status, { id: "w2", title: "Ship the docs" }));
  postNotices(two("working"), two("needs_input"), on, shown, vi.fn());
  expect(setBadge).toHaveBeenLastCalledWith(2);
  // The same sessions again replace their notices: still two.
  setBadge.mockClear();
  postNotices(two("working"), two("idle"), on, shown, vi.fn());
  expect(setBadge).not.toHaveBeenCalled();
  clearNotices(shown);
  expect(setBadge).toHaveBeenLastCalledWith(0);
  vi.unstubAllGlobals();
});

test("pushes catch a turn shorter than the poll; an older poll answer never undoes a push", () => {
  const at = (status: Workspace["status"], t: number, extra: Partial<Workspace> = {}) => ws(status, { updated_at: `2026-10-17T20:00:0${t}.000Z`, ...extra });
  // The poll saw it idle; the runtime then pushed working and failed, both inside one 2 s poll.
  let known = mergeNewer(new Map(), [at("idle", 0)], true);
  const steps: Array<string | null> = [];
  for (const w of [at("working", 1), at("failed", 2)]) {
    const next = mergeNewer(known, [w], false);
    steps.push(noticeFor(known.get(w.id), next.get(w.id)!, on)?.title ?? null);
    known = next;
  }
  expect(steps).toEqual([null, "Stopped with an error"]);
  // A poll answer read before the last push arrives after it: the push stands, so no second notice.
  const polled = mergeNewer(known, [at("working", 1), at("idle", 0, { id: "w2" })], true);
  expect(polled.get("w1")!.status).toBe("failed");
  expect(noticeFor(known.get("w1"), polled.get("w1")!, on)).toBeNull();
  // A whole list drops what it no longer has; a push keeps the rest.
  expect([...mergeNewer(polled, [at("idle", 3, { id: "w2" })], true).keys()]).toEqual(["w2"]);
  expect([...mergeNewer(polled, [at("idle", 3, { id: "w3" })], false).keys()]).toEqual(["w1", "w2", "w3"]);
});

test("a notice clicked while the desktop window is closed brings the window back", () => {
  browser(false);
  const showWindow = vi.fn();
  const focus = vi.fn();
  vi.stubGlobal("window", { focus, cavemanDesktop: { showWindow, setBadge: vi.fn() } });
  const open = vi.fn();
  postNotices(list(ws("working")), list(ws("needs_input")), on, new Map(), open);
  FakeNotice.posted[0]!.click();
  expect(showWindow).toHaveBeenCalledTimes(1);
  expect(focus).toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith("/w/w1");
  vi.unstubAllGlobals();
});

test("the title counts the chats waiting on you, so a background tab says so", () => {
  const w = (id: string, status: Workspace["status"], over: Partial<Workspace> = {}) => [id, { id, title: id, status, updated_at: "2026-10-17T10:00:00Z", ...over } as Workspace] as const;
  const list = new Map([
    w("a", "needs_input"),
    w("b", "working"),
    w("lead", "working"),
    // The lead is at work: it speaks for its agent.
    w("agent", "needs_input", { parent_workspace_id: "lead" }),
    w("idle-lead", "idle"),
    // Its lead has stopped: nobody but the person can answer it.
    w("orphan", "needs_input", { parent_workspace_id: "idle-lead" }),
    w("chief", "needs_input", { kind: "chief" }),
  ]);
  expect(needsYouCount(list)).toBe(2);
  expect(titleFor(2)).toBe("(2) Caveman Code");
  expect(titleFor(0)).toBe("Caveman Code");
});

test("a chat running mail from a chat on another Mac leaves the telling to that chat, except when it waits on you while that chat is not at work", () => {
  const asked = (status: Workspace["status"]) => ws(status, { asked_by_session_id: "sess-on-studio" });
  const asker = (status: Workspace["status"]) => ({ id: "w-asker", session_id: "sess-on-studio", title: "Plan the migration", status }) as Workspace;
  expect(noticeFor(asked("working"), asked("idle"), on, undefined, asker("idle"))).toBeNull();
  expect(noticeFor(asked("working"), asked("failed"), on, undefined, asker("idle"))).toBeNull();
 // The lead rule: the asking chat at work, or itself waiting on you, speaks for it.
  expect(noticeFor(asked("working"), asked("needs_input"), on, undefined, asker("working"))).toBeNull();
  expect(noticeFor(asked("working"), asked("needs_input"), on, undefined, asker("needs_input"))).toBeNull();
  expect(noticeFor(asked("working"), asked("needs_input"), on, undefined, asker("idle"))).toEqual({ title: "Needs you", body: "Fix webhook retry storm · asked by Plan the migration" });
  // An asking chat the list does not have (not synced) cannot speak for it.
  expect(noticeFor(asked("working"), asked("needs_input"), on)).toEqual({ title: "Needs you", body: "Fix webhook retry storm" });
  // Its own turns again once that mail's turn ended.
  expect(noticeFor(asked("working"), ws("idle"), on)?.title).toBe("Finished");

  // The count and the posted notices find the asking chat in the list by its session.
  const helper = { ...asked("needs_input"), id: "w-helper" } as Workspace;
  expect(needsYouCount(new Map([["w-helper", helper], ["w-asker", asker("working")]]))).toBe(0);
  expect(needsYouCount(new Map([["w-helper", helper], ["w-asker", asker("idle")]]))).toBe(1);
});

// ------------------------------------------------------------------ the Chiefs

const T = (min: number) => new Date(Date.parse("2026-11-17T09:00:00.000Z") + min * 60_000).toISOString();
const chief = (latest: ChiefNow["latest"], over: Partial<ChiefNow> = {}): ChiefNow => ({ name: "Maintainer", path: "/chief/c1", home: false, latest, working: false, ...over });
const said = (reply: string | undefined, min: number) => ({ reply, at: T(min) });
const item = (id: string, over: Partial<ChiefItem> = {}): ChiefItem =>
  ({ id, chief_id: "c1", text: `note ${id}`, state: "started", rank: 1, pinned: false, project_ids: [], source: "note", workspace_ids: [], created_at: T(0), updated_at: T(0), ...over }) as ChiefItem;
const now = (c: ChiefNow, items: ChiefItem[] | null = []): ChiefsNow => ({ chiefs: new Map([["c1", c]]), items });
const asked = (question: string) => ({ question, recommended: "Go ahead", asked_at: T(1) });

/** A window's Chief loop: each look at the Chiefs gives what it tells, and what it heard is carried to the next. */
function chiefWatch(settings: Settings["notifications"] = on, chats: ReadonlyMap<string, Workspace> = new Map(), readAt: (id: string) => string | null = () => null) {
  let heard: ChiefsHeard | null = null;
  return (look: ChiefsNow) => {
    const next = chiefNotices(heard, look, settings, chats, readAt);
    heard = next.heard;
    return next.notices.map((n) => [n.title, n.body, n.tag, n.path]);
  };
}

test("a Chief's reply says so once, titled with its name; the same reply again says nothing", () => {
  const look = chiefWatch();
  expect(look(now(chief(said("I'll keep CI green.", 0))))).toEqual([]);
  const reply = "CI is green again: the flaky upload test is fixed in #31.";
  expect(look(now(chief(said(reply, 5))))).toEqual([["Maintainer", reply, "chief:c1", "/chief/c1"]]);
  // Read again (a reconnect's workspace.get), or a later turn that said nothing new.
  expect(look(now(chief(said(reply, 5))))).toEqual([]);
  expect(look(now(chief(said(reply, 9))))).toEqual([]);
});

test("nothing for what a Chief said before the app started, nor before its last word was read", () => {
  const look = chiefWatch();
  expect(look(now(chief(undefined)))).toEqual([]);
  // Its first reading is first sight, though it moved from nothing.
  expect(look(now(chief(said("Morning. Two pull requests wait on you.", 0))))).toEqual([]);
  expect(look(now(chief(said("Morning. Two pull requests wait on you.", 0))))).toEqual([]);
});

test("a Chief speaks when its turn ends, with its last words, never mid-turn", () => {
  const look = chiefWatch();
  look(now(chief(said("Earlier.", 0))));
  expect(look(now(chief(said("Looking at the failures.", 1), { working: true })))).toEqual([]);
  // Its last message came while it still worked: the turn's end says it.
  expect(look(now(chief(said("Fixed: the cache key missed the locale.", 2), { working: true })))).toEqual([]);
  expect(look(now(chief(said("Fixed: the cache key missed the locale.", 3))))).toEqual([["Maintainer", "Fixed: the cache key missed the locale.", "chief:c1", "/chief/c1"]]);
});

test("a reply the person already read here, or with Messages from Chiefs off, says nothing", () => {
  const read = chiefWatch(on, new Map(), () => T(10));
  read(now(chief(said("Earlier.", 0))));
  expect(read(now(chief(said("Seen on its page.", 8))))).toEqual([]);
  expect(read(now(chief(said("After you left.", 12))))).toHaveLength(1);
  const off = chiefWatch({ ...on, chief_messages: false });
  off(now(chief(said("Earlier.", 0))));
  expect(off(now(chief(said("The release notes are up.", 1))))).toEqual([]);
});

test("a reply's work references read as their titles, and a long one is clipped", () => {
  const id = "0f6c1b9e-1111-4222-8333-944445555666";
  const look = chiefWatch(on, new Map([[id, { id, title: "Fix the locale cache" } as Workspace]]));
  const items = [item("a", { number: 12, title: "Flaky upload test", workspace_ids: [id] })];
  look(now(chief(said("Earlier.", 0)), items));
  expect(look(now(chief(said(`[[12]] is fixed in [[chat:${id}]]; [[40]] is gone.`, 1)), items))[0]?.[1]).toBe("Flaky upload test is fixed in Fix the locale cache; #40 is gone.");
  const body = look(now(chief(said(`${"word ".repeat(60)}end`, 2)), items))[0]?.[1] ?? "";
  expect(body.length).toBeLessThanOrEqual(160);
  expect(body.endsWith("…")).toBe(true);
  expect(clip("short line\n  here")).toBe("short line here");
});

test("a Chief's item that starts waiting on you says so once, with its title and its ask", () => {
  const look = chiefWatch();
  const c = chief(said("Earlier.", 0));
  const old = item("old", { state: "needs_you", title: "Old ask", detail: "Tests failed" });
  // Already waiting when the app started: not news.
  expect(look(now(c, [old]))).toEqual([]);
  const next = [old, item("b", { state: "review", title: "Upgrade lodash", asked: asked("Merge #31 now that CI is green?") })];
  expect(look(now(c, next))).toEqual([["Maintainer", "Upgrade lodash · Merge #31 now that CI is green?", "chief-item:b", "/chief/c1"]]);
  // Still waiting on the next board: not again.
  expect(look(now(c, next))).toEqual([]);
  // A failed chat's item takes that chat's notice's place.
  const failed = [...next, item("f", { state: "needs_you", title: "Fix the webhook", detail: "Tests failed", workspace_ids: ["w9"] })];
  expect(look(now(c, failed))).toEqual([["Maintainer", "Fix the webhook · Tests failed", "workspace:w9", "/chief/c1"]]);
  // Done or dropped never waits.
  expect(waitsOnYou(item("d", { state: "done", asked: asked("Old?") }))).toBe(false);
});

test("an item whose chat asks itself, or with Needs you off, says nothing; the board's first reading is first sight", () => {
  const chat = chiefWatch(on, new Map([["w1", ws("needs_input")]]));
  chat(now(chief(undefined), []));
  expect(chat(now(chief(undefined), [item("q", { state: "needs_you", detail: "Which region?", workspace_ids: ["w1"] })]))).toEqual([]);
  const off = chiefWatch({ ...on, needs_input: false });
  off(now(chief(undefined), []));
  expect(off(now(chief(undefined), [item("q", { state: "needs_you", detail: "Tests failed" })]))).toEqual([]);
  const first = chiefWatch();
  expect(first(now(chief(undefined), null))).toEqual([]);
  expect(first(now(chief(undefined), [item("q", { state: "needs_you", detail: "Tests failed" })]))).toEqual([]);
  // Another runtime's board (no board, then its first reading) is first sight too.
  expect(first(now(chief(undefined), null))).toEqual([]);
  expect(first(now(chief(undefined), [item("r", { state: "needs_you", detail: "Checks failing" })]))).toEqual([]);
});

test("an item from a one-Chief runtime is the home Chief's", () => {
  const look = chiefWatch();
  const home: ChiefsNow = { chiefs: new Map([["h", chief(undefined, { name: "Chief", path: "/chief", home: true })]]), items: [] };
  look(home);
  const legacy: { -readonly [K in keyof ChiefItem]?: ChiefItem[K] } = { ...item("x", { state: "needs_you", title: "Ship docs" }) };
  delete legacy.chief_id;
  expect(look({ ...home, items: [legacy as ChiefItem] })).toEqual([["Chief", "Ship docs", "chief-item:x", "/chief"]]);
});

test("Chief notices post only while the app is away; a click opens the Chief; the Dock counts them", () => {
  const reply = { title: "Maintainer", body: "CI is green again.", tag: "chief:c1", path: "/chief/c1" };
  browser(true);
  post([reply], new Map(), vi.fn());
  expect(FakeNotice.posted).toHaveLength(0);

  browser(false);
  const setBadge = vi.fn();
  const focus = vi.fn();
  vi.stubGlobal("window", { focus, cavemanDesktop: { setBadge } });
  const open = vi.fn();
  post([reply, { title: "Maintainer", body: "Upgrade lodash · Merge #31?", tag: "chief-item:b", path: "/chief/c1" }], new Map(), open);
  expect(FakeNotice.posted.map((n) => [n.title, n.options.body, n.options.tag])).toEqual([
    ["Maintainer", "CI is green again.", "chief:c1"],
    ["Maintainer", "Upgrade lodash · Merge #31?", "chief-item:b"],
  ]);
  expect(setBadge).toHaveBeenLastCalledWith(2);
  FakeNotice.posted[0]!.click();
  expect(focus).toHaveBeenCalled();
  expect(open).toHaveBeenCalledWith("/chief/c1");
  vi.unstubAllGlobals();
});

test("a Chief's word about a failed chat stays, whichever arrives first; the chat asking the person replaces it", () => {
  const word = { title: "Maintainer", body: "Fix the webhook · Tests failed", tag: "workspace:w1", path: "/chief/c1", chief: true } as const;
  const failed = () => postNotices(list(ws("working")), list(ws("failed")), on, shown, vi.fn());
  browser(false);
  // The chat's Stopped first: the Chief's word replaces it.
  let shown = new Map<string, Notification>();
  failed();
  post([word], shown, vi.fn());
  expect(FakeNotice.posted.map((n) => [n.title, n.closed])).toEqual([
    ["Stopped with an error", true],
    ["Maintainer", false],
  ]);
  // The Chief's word first: the chat's Stopped after it says nothing.
  browser(false);
  shown = new Map();
  post([word], shown, vi.fn());
  failed();
  expect(FakeNotice.posted.map((n) => [n.title, n.closed])).toEqual([["Maintainer", false]]);
  // The chat asks the person itself: its own notice replaces the Chief's.
  postNotices(list(ws("working")), list(ws("needs_input")), on, shown, vi.fn());
  expect(FakeNotice.posted.map((n) => [n.title, n.closed])).toEqual([
    ["Maintainer", true],
    ["Needs you", false],
  ]);
  vi.unstubAllGlobals();
});

test("the count of what waits on you includes each Chief item waiting on you, once", () => {
  const chats = new Map([
    ["w1", ws("needs_input")],
    ["w2", ws("working", { id: "w2" })],
  ]);
  const items = [
    item("a", { state: "needs_you", detail: "Tests failed", workspace_ids: ["w2"] }),
    item("b", { state: "blocked", asked: asked("Which region?") }),
    // Its chat asks itself: counted once, as that chat.
    item("c", { state: "needs_you", workspace_ids: ["w1"] }),
    item("d", { state: "started" }),
    item("e", { state: "done", asked: asked("Old?") }),
  ];
  expect(needsYouCount(chats, items)).toBe(3);
  expect(needsYouCount(chats)).toBe(1);
});
