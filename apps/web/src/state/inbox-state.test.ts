// upstream client rules for done, snooze and pin (threadSettled.ts), on Workspace.inbox.
import { expect, test } from "vitest";
import type { SnoozeOption } from "@caveman-app/session-protocol";
import {
  applyInbox,
  archivesAt,
  canSnooze,
  chatLife,
  customSnooze,
  DEFAULT_SNOOZE_OPTIONS,
  inboxSection,
  isSnoozed,
  pickSnooze,
  pinnedChats,
  queueSections,
  snoozeOptionFrom,
  snoozeOptionText,
  snoozePresets,
  tidyable,
  waitsOnYou,
  wakeLabel,
  withSnoozeOption,
} from "./inbox-state.ts";
import { chatStatuses, type InboxView, type WorkspaceView } from "./model.ts";

const NOW = Date.parse("2026-10-20T12:00:00Z");
const inbox = (over: Partial<InboxView>): InboxView => ({ doneAt: null, snoozedUntil: null, snoozedAt: null, pinnedAt: null, ...over });
const w = (id: string, over: Partial<WorkspaceView>): WorkspaceView =>
  ({ id, title: id, repo: "api", state: "completed", asleep: false, parentId: null, createdAt: "2026-10-20T09:00:00Z", updatedAt: "2026-10-20T10:00:00Z", unread: false, ...over }) as WorkspaceView;
const snoozed = (over: Partial<WorkspaceView> = {}) => w("s", { inbox: inbox({ snoozedUntil: "2026-10-20T15:00:00Z", snoozedAt: "2026-10-20T11:00:00Z" }), ...over });

test("a snooze holds until its time, unless the chat raised its hand since", () => {
  expect(isSnoozed(snoozed(), NOW)).toBe(true);
  expect(isSnoozed(snoozed(), Date.parse("2026-10-20T15:00:00Z"))).toBe(false);
  // It asks something, or a turn failed after the snooze: back in the list.
  expect(isSnoozed(snoozed({ state: "needs_input" }), NOW)).toBe(false);
  expect(isSnoozed(snoozed({ state: "failed", updatedAt: "2026-10-20T11:30:00Z" }), NOW)).toBe(false);
  // A turn that finished after the snooze (a background wake, say) keeps it asleep (T3 #22202).
  expect(isSnoozed(snoozed({ state: "completed", updatedAt: "2026-10-20T11:30:00Z" }), NOW)).toBe(true);
  // Its last change came before the snooze: it stays asleep.
  expect(isSnoozed(snoozed({ state: "failed", updatedAt: "2026-10-20T10:30:00Z" }), NOW)).toBe(true);
  expect(isSnoozed(snoozed({ state: "working", updatedAt: "2026-10-20T11:30:00Z" }), NOW)).toBe(true);
});

test("no snooze while it asks something or a message waits to start", () => {
  expect(canSnooze(w("a", { state: "needs_input" }))).toBe(false);
  expect(canSnooze(w("a", { state: "queued" }))).toBe(false);
  expect(canSnooze(w("a", { state: "working" }))).toBe(true);
});

const activity = (turnStartedAt: string) => ({ ask: null, turnStartedAt, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false });

test("the queue view: pinned, then needs you, working, ready for review, and only what was called done in Done", () => {
  const all = [
    snoozed(),
    w("s-late", { inbox: inbox({ snoozedUntil: "2026-10-21T09:00:00Z", snoozedAt: "2026-10-20T11:00:00Z" }) }),
    w("d-old", { inbox: inbox({ doneAt: "2026-10-18T10:00:00Z" }) }),
    w("d", { inbox: inbox({ doneAt: "2026-10-19T10:00:00Z" }) }),
    w("p2", { inbox: inbox({ pinnedAt: "2026-10-20T09:00:00Z" }) }),
    w("p1", { inbox: inbox({ pinnedAt: "2026-10-19T09:00:00Z" }) }),
    w("old", { updatedAt: "2026-10-19T10:00:00Z" }),
    // Its agent asks the person: the agent waits on them, the lead waits on its agent (at work).
    w("new", { updatedAt: "2026-10-20T11:30:00Z" }),
    // An agent stays under its lead, unless it asks the person something.
    w("agent", { parentId: "new" }),
    w("asking", { parentId: "new", state: "needs_input", updatedAt: "2026-10-20T11:00:00Z" }),
    w("gone", { state: "archived" }),
    // A snooze it has raised its hand through no longer holds: back in the list. Its failure was seen: it finished,
    // so it is the person's to review until they call it done.
    snoozed({ id: "woke", state: "failed", updatedAt: "2026-10-20T11:40:00Z" }),
    // A failure nobody has looked at needs the person.
    w("broke", { state: "failed", unread: true, updatedAt: "2026-10-20T11:20:00Z" }),
    // Work not on its base yet waits for review: files or commits of its own, or a pull request still open.
    w("dirty", { updatedAt: "2026-10-20T11:10:00Z", unmerged: { files: 3, commits: 0 } }),
    w("pr", { updatedAt: "2026-10-20T11:05:00Z", pullRequest: { number: 4, url: "u", state: "open" } }),
    // A plan waiting to be built is the person's to review.
    w("plan", { updatedAt: "2026-10-20T10:30:00Z", activity: { ...activity("x"), turnStartedAt: null, readyToBuild: true } }),
    // Landed (a merged pull request), or nothing to land at all: still ready for review until it is called done.
    w("merged", { updatedAt: "2026-10-20T11:15:00Z", unmerged: { files: 0, commits: 2 }, pullRequest: { number: 5, url: "u", state: "merged" } }),
    // The person's word wins: marked done with work on its branch, it is done.
    w("d-dirty", { unmerged: { files: 1, commits: 1 }, inbox: inbox({ doneAt: "2026-10-20T08:00:00Z" }) }),
    // At work by when its turn started, so a row holds still while its events move updated_at.
    w("busy-old", { state: "working", updatedAt: "2026-10-20T11:55:00Z", activity: activity("2026-10-20T10:00:00Z") }),
    w("busy-new", { state: "working", updatedAt: "2026-10-20T11:50:00Z", activity: activity("2026-10-20T11:50:00Z") }),
    // A lead whose own turn ended while its agent works is at work, not finished.
    w("lead", { updatedAt: "2026-10-20T11:00:00Z" }),
    w("helper", { parentId: "lead", state: "working" }),
  ];
  expect(inboxSection(all[0]!, NOW)).toBe("snoozed");
  const ids = (list: ReadonlyArray<WorkspaceView>) => list.map((x) => x.id);
  const q = queueSections(all, chatStatuses(all), NOW);
  expect(ids(q.pinned)).toEqual(["p1", "p2"]);
  expect(ids(q.needs)).toEqual(["broke", "asking"]);
  expect(ids(q.working)).toEqual(["busy-new", "new", "lead", "busy-old"]);
  expect(ids(q.review)).toEqual(["woke", "merged", "dirty", "pr", "plan", "old"]);
  expect(ids(q.snoozed)).toEqual(["s", "s-late"]);
  // Only the chats called done, by when each was called done, newest first.
  expect(ids(q.done)).toEqual(["d-dirty", "d", "d-old"]);
  expect(ids(pinnedChats(all))).toEqual(["p1", "p2"]);
});

test("a done chat is archived the set number of days after it was marked done, unless it is kept", () => {
  const done = w("d", { inbox: inbox({ doneAt: "2026-10-19T10:00:00Z" }) });
  expect(archivesAt(done, 7)).toBe(Date.parse("2026-10-26T10:00:00Z"));
  expect(archivesAt(done, null)).toBeNull();
  expect(archivesAt(done, undefined)).toBeNull();
  // A pull request still under way keeps it, as the runtime's sweep does (dueForArchive); a merged one does not.
  expect(archivesAt({ ...done, pullRequest: { number: 1, url: "u", state: "open" } }, 7)).toBeNull();
  expect(archivesAt({ ...done, pullRequest: { number: 1, url: "u", state: "draft" } }, 7)).toBeNull();
  expect(archivesAt({ ...done, pullRequest: { number: 1, url: "u", state: "merged" } }, 7)).toBe(Date.parse("2026-10-26T10:00:00Z"));
  expect(archivesAt(w("open", {}), 7)).toBeNull();
});

test("an action's change, as T3's orchestrator makes it", () => {
  const at = new Date(NOW);
  const now = at.toISOString();
  expect(applyInbox(undefined, { do: "done" }, "2026-10-20T10:00:00Z", at)).toEqual({ done_at: now });
  // Done unpins and clears snooze; pinning clears done and snooze.
  expect(applyInbox({ pinned_at: "x", visited_at: "v" }, { do: "done" }, "", at)).toEqual({ done_at: now, visited_at: "v" });
  expect(applyInbox({ snoozed_until: "u", snoozed_at: "s" }, { do: "done" }, "", at)).toEqual({ done_at: now });
  expect(applyInbox({ done_at: "d", snoozed_until: "u", snoozed_at: "s" }, { do: "pin" }, "", at)).toEqual({ pinned_at: now });
  expect(applyInbox({ done_at: "d" }, { do: "reopen" }, "", at)).toBeUndefined();
  expect(applyInbox({ pinned_at: "p" }, { do: "snooze", until: "2026-10-21T09:00:00.000Z" }, "", at)).toEqual({ pinned_at: "p", snoozed_until: "2026-10-21T09:00:00.000Z", snoozed_at: now });
  expect(applyInbox({ snoozed_until: "u", snoozed_at: "s" }, { do: "wake" }, "", at)).toBeUndefined();
  // Seen never moves the mark back; unread puts it just before the chat's last change.
  expect(applyInbox({ visited_at: "2026-10-20T11:00:00.000Z" }, { do: "seen", through: "2026-10-20T10:00:00.000Z" }, "", at)).toEqual({ visited_at: "2026-10-20T11:00:00.000Z" });
  expect(applyInbox(undefined, { do: "unread" }, "2026-10-20T10:00:00.000Z", at)).toEqual({ visited_at: "2026-10-20T09:59:59.999Z" });
});

test("snooze presets, a custom time and the wake label", () => {
  const ids = snoozePresets(new Date(2026, 9, 20, 12, 0)).map((p) => p.id);
  expect(ids).toEqual(["after:60", "after:180", "at:today:18:00", "at:tomorrow:09:00", "at:monday:09:00"]);
  // This evening until 6:00 PM passes; next week is left out when tomorrow is that Monday (a Sunday).
  expect(snoozePresets(new Date(2026, 9, 20, 17, 30)).map((p) => p.id)).toContain("at:today:18:00");
  expect(snoozePresets(new Date(2026, 9, 20, 18, 0)).map((p) => p.id)).not.toContain("at:today:18:00");
  expect(snoozePresets(new Date(2026, 9, 25, 12, 0)).map((p) => p.id)).not.toContain("at:monday:09:00");
  const local = new Date(2026, 9, 20, 12, 0);
  expect(customSnooze("2026-10-21", "09:30", local)).toBe(new Date(2026, 9, 21, 9, 30).toISOString());
  expect(customSnooze("2026-10-19", "09:30", local)).toBeNull();
  expect(customSnooze("2026-02-30", "09:30", local)).toBeNull();
  expect(wakeLabel("2026-10-20T12:40:00Z", NOW)).toBe("40m");
  expect(wakeLabel("2026-10-20T15:00:00Z", NOW)).toBe("3h");
  expect(wakeLabel("2026-10-22T12:00:00Z", NOW)).toBe("2d");
  expect(wakeLabel("2026-10-20T11:00:00Z", NOW)).toBe("now");
});

// upstream snooze preset tests (#26208), on our menu.
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);
const time = (d: Date) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
const menu = (now: Date, options?: ReadonlyArray<SnoozeOption>) => snoozePresets(now, options, time).map((p) => `${p.label} ${p.when}`);

test("custom snooze options list soonest first and name the day when the label does not", () => {
  // Wednesday 20:00.
  expect(
    menu(at(2026, 4, 8, 20), [
      { kind: "at", day: "monday", time: "18:00" },
      { kind: "at", day: "tomorrow", time: "21:00" },
      { kind: "after", minutes: 360 },
      { kind: "after", minutes: 180 },
    ]),
  ).toEqual(["In 3 hours 23:00", "In 6 hours Thu 2:00", "Tomorrow 21:00", "Next week Mon 18:00"]);
});

test("a today option drops once its time passes, and a weekday on that day moves to next week", () => {
  // Monday 18:30.
  const presets = snoozePresets(at(2026, 4, 13, 18, 30), [
    { kind: "at", day: "today", time: "18:00" },
    { kind: "at", day: "monday", time: "09:00" },
  ]);
  expect(presets.map((p) => p.id)).toEqual(["at:monday:09:00"]);
  expect(new Date(presets[0]!.until)).toEqual(at(2026, 4, 20, 9));
});

test("labels follow the real day gap: a Monday option on Sunday is Tomorrow, a weekday a week out is Next", () => {
  const options: ReadonlyArray<SnoozeOption> = [
    { kind: "at", day: "tomorrow", time: "21:00" },
    { kind: "at", day: "monday", time: "18:00" },
    { kind: "at", day: "friday", time: "17:00" },
  ];
  // Sunday 14:00.
  expect(menu(at(2026, 8, 30, 14), options)).toEqual(["Tomorrow 18:00", "Tomorrow 21:00", "Friday 17:00"]);
  // Friday 10:00: today's 17:00 is a week away.
  expect(menu(at(2026, 10, 2, 10), options)).toEqual(["Tomorrow 21:00", "Next week Mon 18:00", "Next Friday 17:00"]);
});

test("two options that wake in the same minute show one row", () => {
  // Sunday, so Tomorrow 9:00 and Next week 9:00 are the same Monday.
  expect(menu(at(2026, 8, 30, 7, 1))).toEqual(["In 1 hour 8:01", "In 3 hours 10:01", "This evening 18:00", "Tomorrow 9:00"]);
  const now = at(2026, 4, 8, 15);
  now.setSeconds(25);
  expect(menu(now, [{ kind: "after", minutes: 180 }, { kind: "at", day: "today", time: "18:00" }])).toEqual(["In 3 hours 18:00"]);
});

test("a picked wait starts at the pick; a picked set time keeps the wake the menu showed", () => {
  const options: ReadonlyArray<SnoozeOption> = [{ kind: "at", day: "today", time: "18:30" }, { kind: "after", minutes: 180 }];
  const shown = snoozePresets(at(2026, 4, 8, 15), options);
  expect(pickSnooze(shown.find((p) => p.id === "after:180")!, at(2026, 4, 8, 15, 30), options)).toBe(at(2026, 4, 8, 18, 30).toISOString());
  // Sunday 23:59: "Tomorrow" means Monday 9:00, even when the pick lands after midnight.
  const late = snoozePresets(at(2026, 8, 30, 23, 59));
  expect(pickSnooze(late.find((p) => p.id === "at:tomorrow:09:00")!, at(2026, 8, 31, 0, 1))).toBe(at(2026, 8, 31, 9).toISOString());
});

test("Settings' snooze editor: an option's text, what the Add row makes, and the list it saves", () => {
  expect(snoozeOptionText({ kind: "after", minutes: 90 }, time)).toBe("In 90 minutes");
  expect(snoozeOptionText({ kind: "at", day: "friday", time: "16:30" }, time)).toBe("Friday at 16:30");
  expect(snoozeOptionFrom({ kind: "after", amount: "2", unit: "days" })).toEqual({ kind: "after", minutes: 2880 });
  expect(snoozeOptionFrom({ kind: "after", amount: "31", unit: "days" })).toBeNull();
  expect(snoozeOptionFrom({ kind: "after", amount: "0", unit: "hours" })).toBeNull();
  expect(snoozeOptionFrom({ kind: "after", amount: "1.5", unit: "hours" })).toBeNull();
  expect(snoozeOptionFrom({ kind: "at", day: "today", time: "9:00" })).toBeNull();
  expect(snoozeOptionFrom({ kind: "at", day: "today", time: "09:00" })).toEqual({ kind: "at", day: "today", time: "09:00" });
  const eight = Array.from({ length: 8 }, (_, i): SnoozeOption => ({ kind: "after", minutes: i + 1 }));
  expect(withSnoozeOption(eight, { kind: "after", minutes: 99 })).toBe(eight);
  expect(withSnoozeOption(DEFAULT_SNOOZE_OPTIONS, { kind: "after", minutes: 60 })).toBe(DEFAULT_SNOOZE_OPTIONS);
  expect(withSnoozeOption(DEFAULT_SNOOZE_OPTIONS, { kind: "after", minutes: 30 })).toHaveLength(6);
});

test("Tidy takes the old chats: nothing left for the person, quiet for a day, and read or called done", () => {
  const old = "2026-10-18T11:00:00Z";
  const all = [
    w("done", { updatedAt: old, unread: true, inbox: inbox({ doneAt: "2026-10-19T11:00:00Z" }) }),
    w("quiet", { updatedAt: "2026-10-19T11:00:00Z" }),
    w("merged", { updatedAt: old, pullRequest: { number: 5, url: "", state: "merged" } }),
    // Called done an hour ago, finished an hour ago, or never read: not old yet.
    w("done-today", { updatedAt: old, inbox: inbox({ doneAt: "2026-10-20T11:00:00Z" }) }),
    w("fresh", { updatedAt: "2026-10-20T11:00:00Z" }),
    w("unseen", { updatedAt: old, unread: true }),
    // Its work has not landed: a pull request under way, or files its base does not have. Done or not.
    w("in-review", { updatedAt: old, inbox: inbox({ doneAt: old }), pullRequest: { number: 4, url: "", state: "open" } }),
    w("unlanded", { updatedAt: old, inbox: inbox({ doneAt: old }), unmerged: { files: 2, commits: 0 } }),
    // Kept by the person, at work, asking, or on screen: never.
    w("pinned", { updatedAt: old, inbox: inbox({ pinnedAt: old }) }),
    w("pinned-done", { updatedAt: old, inbox: inbox({ doneAt: old, pinnedAt: old }) }),
    w("asleep", { updatedAt: old, inbox: inbox({ doneAt: old, snoozedUntil: "2026-10-21T09:00:00Z", snoozedAt: "2026-10-20T11:00:00Z" }) }),
    w("busy", { state: "working", updatedAt: old }),
    w("asks", { state: "needs_input", updatedAt: old }),
    w("open", { updatedAt: old }),
    // A lead goes with its agents, read or not, and stays while one of them works or moved within the day.
    w("lead", { updatedAt: old }),
    w("agent", { parentId: "lead", updatedAt: old, unread: true }),
    w("lead-busy", { updatedAt: old }),
    w("agent-busy", { parentId: "lead-busy", state: "working" }),
    w("lead-fresh", { updatedAt: old }),
    w("agent-fresh", { parentId: "lead-fresh", updatedAt: "2026-10-20T11:30:00Z" }),
    // An agent called done within the day keeps its lead and itself, as a lead called done would.
    w("lead-agent-done", { updatedAt: old }),
    w("agent-done-today", { parentId: "lead-agent-done", updatedAt: old, inbox: inbox({ doneAt: "2026-10-20T11:00:00Z" }) }),
    w("gone", { state: "archived", updatedAt: old }),
  ];
  const ids = tidyable(all, chatStatuses(all), new Set(["open"]), NOW).map((x) => x.id);
  expect(ids.sort()).toEqual(["agent", "done", "lead", "merged", "quiet"]);
});

test("the Queue bell: a chat on Needs you, or a pinned one that asks; never a snoozed one before it wakes", () => {
  const lit = (all: WorkspaceView[], now = NOW) => {
    const statuses = chatStatuses(all);
    return waitsOnYou(queueSections(all, statuses, now), statuses);
  };
  expect(lit([w("quiet", {})])).toBe(false);
  expect(lit([w("asking", { state: "needs_input" })])).toBe(true);
  // Its pin keeps it off Needs you, but it still waits on the person.
  expect(lit([w("pinned", { state: "needs_input", inbox: inbox({ pinnedAt: "2026-10-20T09:00:00Z" }) })])).toBe(true);
  expect(lit([w("pinned", { inbox: inbox({ pinnedAt: "2026-10-20T09:00:00Z" }) })])).toBe(false);
  // An unseen failure from before its snooze waits until the snooze ends.
  const sleeper = snoozed({ state: "failed", unread: true, updatedAt: "2026-10-20T10:30:00Z" });
  expect(lit([sleeper])).toBe(false);
  expect(lit([sleeper], Date.parse("2026-10-20T15:00:00Z"))).toBe(true);
});

test("the sidebar by topic files a chat as the queue does: live on Pinned, Needs you, Working and Ready for review", () => {
  const all = [
    snoozed(),
    w("d", { inbox: inbox({ doneAt: "2026-10-19T10:00:00Z" }) }),
    w("p", { inbox: inbox({ pinnedAt: "2026-10-19T09:00:00Z" }) }),
    w("read", {}),
    w("broke", { state: "failed", unread: true }),
    w("busy", { state: "working" }),
    w("dirty", { unmerged: { files: 3, commits: 0 } }),
    w("lead", {}),
    w("helper", { parentId: "lead", state: "working" }),
  ];
  const statuses = chatStatuses(all);
  const q = queueSections(all, statuses, NOW);
  const live = new Set([...q.pinned, ...q.needs, ...q.working, ...q.review].map((x) => x.id));
  for (const chat of all.filter((x) => x.parentId === null)) {
    const expected = live.has(chat.id) ? "live" : q.snoozed.some((x) => x.id === chat.id) ? "snoozed" : "done";
    expect([chat.id, chatLife(chat, NOW)]).toEqual([chat.id, expected]);
  }
});
