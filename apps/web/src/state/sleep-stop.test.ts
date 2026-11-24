import type { SessionEvent } from "@caveman-app/session-protocol";
import { beforeEach, expect, test, vi } from "vitest";
import { legacyGenerated } from "./generated.ts";
import {
  continueNote,
  isContinueNote,
  lidStoppedEnds,
  pressContinue,
  type ContinueState,
  LID_NOTE_TITLE,
  lidStops,
  recordLidOutcome,
  resetLidStops,
  stoppedByLid,
  withLidOutcome,
} from "./sleep-stop.ts";
import { SessionModel } from "./transcript.ts";

// A page's local storage, in node.
const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  });
  resetLidStops();
});

let cursor = 0;
const at = "2026-11-21T10:00:00.000Z";
const ev = (
  type: SessionEvent["type"],
  payload: unknown,
  extra: Partial<SessionEvent> = {},
): SessionEvent =>
  ({ session_id: "s1", cursor: ++cursor, at, type, payload, ...extra }) as SessionEvent;

function chat(...events: SessionEvent[]) {
  const m = new SessionModel();
  // Numbered in the order given, whatever order they were made in.
  events.forEach((e, i) => m.apply({ ...e, cursor: i + 1 } as SessionEvent));
  return m.snapshot().items;
}

const turn = (...tail: SessionEvent[]) => [
  ev("message.done", { role: "user", text: "Fix the build" }, { item_id: "u1" }),
  ev("turn.started", { engine: "caveman" }),
  ev(
    "tool.started",
    { name: "Read", title: "Read main.ts", kind: "read", input: {} },
    { item_id: "t1" },
  ),
  ev("tool.done", { status: "completed" }, { item_id: "t1" }),
  ev(
    "tool.started",
    { name: "Bash", title: "Run npm test", kind: "command", input: { command: "npm test" } },
    { item_id: "t2" },
  ),
  ...tail,
];

test("a turn stopped right after the runtime's lid note reads as a sleep stop", () => {
  const items = chat(
    ...turn(
      ev("notification", { level: "info", title: LID_NOTE_TITLE, body: "Moves on with a plan." }),
      ev("turn.done", { status: "interrupted" }),
    ),
  );
  expect(items.findLast((i) => i.kind === "turn_end")).toMatchObject({
    outcome: "interrupted",
    stoppedBy: "sleep",
  });
});

test("an ordinary stop, a finished turn and a note from an earlier turn are not sleep stops", () => {
  expect(
    chat(...turn(ev("turn.done", { status: "interrupted" }))).findLast(
      (i) => i.kind === "turn_end",
    ),
  ).not.toHaveProperty("stoppedBy");
  expect(
    chat(
      ...turn(
        ev("notification", { level: "info", title: LID_NOTE_TITLE }),
        ev("turn.done", { status: "completed" }),
      ),
    ).findLast((i) => i.kind === "turn_end"),
  ).not.toHaveProperty("stoppedBy");
  // The note belonged to a turn that went on and finished; the next turn's own stop is the person's.
  const later = chat(
    ...turn(
      ev("notification", { level: "info", title: LID_NOTE_TITLE }),
      ev("turn.done", { status: "completed" }),
    ),
    ev("turn.started", { engine: "caveman" }),
    ev("turn.done", { status: "interrupted" }),
  );
  expect(later.findLast((i) => i.kind === "turn_end")).not.toHaveProperty("stoppedBy");
});

test("stoppedByLid: a stop between the lid closing and a minute after the Mac woke", () => {
  const lid = { at: Date.parse("2026-11-21T10:00:00Z"), woke: Date.parse("2026-11-21T10:30:00Z") };
  expect(stoppedByLid("2026-11-21T10:00:00.500Z", [lid])).toBe(true);
  expect(stoppedByLid("2026-11-21T09:59:59Z", [lid])).toBe(true);
  expect(stoppedByLid("2026-11-21T10:30:40Z", [lid])).toBe(true);
  expect(stoppedByLid("2026-11-21T09:50:00Z", [lid])).toBe(false);
  expect(stoppedByLid("2026-11-21T10:32:00Z", [lid])).toBe(false);
  expect(stoppedByLid("2026-11-21T10:10:00Z", undefined)).toBe(false);
  expect(stoppedByLid("not a time", [lid])).toBe(false);
});

test("withLidOutcome keeps a lid per chat and drops what is a week old", () => {
  const woke = Date.parse("2026-11-21T10:30:00Z");
  const old = { at: woke - 9 * 864e5, woke: woke - 9 * 864e5 };
  const kept = withLidOutcome(
    { a: [old], b: [old] },
    { moving: 1, paused: 1, chats: ["a"], at: woke - 1000 },
    woke,
  );
  expect(kept).toEqual({ a: [{ at: woke - 1000, woke }] });
  // No time, no record.
  expect(withLidOutcome({}, { moving: 0, paused: 1, chats: ["a"] }, woke)).toEqual({});
});

test("recordLidOutcome survives a reload through local storage", () => {
  recordLidOutcome({ moving: 0, paused: 1, chats: ["s9"], at: 1_000 }, 5_000);
  expect(lidStops()).toEqual({ s9: [{ at: 1_000, woke: 5_000 }] });
  resetLidStops();
  expect(lidStops()).toEqual({ s9: [{ at: 1_000, woke: 5_000 }] });
});

test("the note says what the runtime's restartNote says for a chat that stopped when its computer slept", () => {
  const items = chat(
    ...turn(
      ev("notification", { level: "info", title: LID_NOTE_TITLE }),
      ev("turn.done", { status: "interrupted" }),
    ),
  );
  const end = items.findLast((i) => i.kind === "turn_end")!;
  // Pinned to packages/runtime/src/cloudLink/moveEngines.ts restartNote(turn, { cause: "stopped" }): same lines, same order.
  expect(continueNote(items, end.id)).toBe(
    [
      "[Caveman Code] Your last turn stopped when this computer went to sleep, and continues now.",
      "These tools already ran before it stopped; their effects on files are here:\n- Read main.ts (completed)\n- npm test (stopped before it finished)",
      "The person asked:\nFix the build",
      "Carry on from where it stopped. Don't run a command again unless you need its result again.",
    ].join("\n\n"),
  );
});

test("the note with no tool and no message, and for a turn that isn't there", () => {
  const items = chat(
    ev("turn.started", { engine: "caveman" }),
    ev("turn.done", { status: "interrupted" }),
  );
  expect(continueNote(items, items.at(-1)!.id)).toBe(
    [
      "[Caveman Code] Your last turn stopped when this computer went to sleep, and continues now.",
      "No tool had run yet.",
      "Carry on from where it stopped. Don't run a command again unless you need its result again.",
    ].join("\n\n"),
  );
  expect(continueNote(items, "nope")).toBeUndefined();
});

test("the note lists at most 20 tools, only the last turn's, and a failed or declined tool says so", () => {
  const many = Array.from({ length: 22 }, (_, i) => [
    ev(
      "tool.started",
      { name: "Read", title: `Read f${i}.ts`, kind: "read", input: {} },
      { item_id: `m${i}` },
    ),
    ev(
      "tool.done",
      { status: i === 0 ? "failed" : i === 1 ? "declined" : "completed" },
      { item_id: `m${i}` },
    ),
  ]).flat();
  const items = chat(
    ev("message.done", { role: "user", text: "first" }, { item_id: "u0" }),
    ev("turn.started", { engine: "caveman" }),
    ev(
      "tool.started",
      { name: "Read", title: "Read old.ts", kind: "read", input: {} },
      { item_id: "old" },
    ),
    ev("tool.done", { status: "completed" }, { item_id: "old" }),
    ev("turn.done", { status: "completed" }),
    ev("message.done", { role: "user", text: "second" }, { item_id: "u1" }),
    ev("turn.started", { engine: "caveman" }),
    ...many,
    ev("turn.done", { status: "interrupted" }),
  );
  const note = continueNote(items, items.at(-1)!.id)!;
  expect(note).not.toContain("old.ts");
  expect(note).toContain("- Read f0.ts (failed)");
  expect(note).toContain("- Read f1.ts (declined)");
  expect(note).toContain("- and 2 more");
  expect(note).toContain("The person asked:\nsecond");
});

test("the follow-up reads as a quiet row, not the person's bubble", () => {
  const items = chat(...turn(ev("turn.done", { status: "interrupted" })));
  const note = continueNote(items, items.at(-1)!.id)!;
  expect(isContinueNote(note)).toBe(true);
  expect(isContinueNote("Please continue")).toBe(false);
  expect(legacyGenerated(note)?.line).toBe("Continued after your computer slept");
  const m = new SessionModel();
  m.echo("m9", note);
  expect(m.snapshot().items[0]).toMatchObject({
    kind: "user",
    generated: { line: "Continued after your computer slept" },
  });
});

test("lidStoppedEnds: a lid stops one turn; the person's own stop after Continue is theirs", () => {
  const lid = { at: Date.parse("2026-11-21T10:00:00Z"), woke: Date.parse("2026-11-21T10:30:00Z") };
  const timed = (
    time: string,
    type: SessionEvent["type"],
    payload: unknown,
    extra: Partial<SessionEvent> = {},
  ) => ev(type, payload, { at: time, ...extra });
  const items = chat(
    timed(
      "2026-11-21T09:58:00Z",
      "message.done",
      { role: "user", text: "Fix the build" },
      { item_id: "u1" },
    ),
    timed("2026-11-21T09:58:00Z", "turn.started", { engine: "caveman" }),
    timed("2026-11-21T10:00:01Z", "turn.done", { status: "interrupted" }),
    // Continue, then Stop, within a minute of the Mac waking.
    timed(
      "2026-11-21T10:30:10Z",
      "message.done",
      { role: "user", text: "Carry on" },
      { item_id: "u2" },
    ),
    timed("2026-11-21T10:30:10Z", "turn.started", { engine: "caveman" }),
    timed("2026-11-21T10:30:20Z", "turn.done", { status: "interrupted" }),
  );
  const ends = items.filter((i) => i.kind === "turn_end").map((i) => i.id);
  expect([...lidStoppedEnds(items, [lid])]).toEqual([ends[0]]);
  // A turn begun after the Mac woke is never the lid's, even with no earlier stop in the window.
  expect([
    ...lidStoppedEnds(items.slice(items.findIndex((i) => i.id === ends[0]) + 1), [lid]),
  ]).toEqual([]);
  expect(lidStoppedEnds(items, undefined).size).toBe(0);
});

test("the note lists the tools a subagent ran, in order, as restartNote does", () => {
  const items = chat(
    ev("message.done", { role: "user", text: "Look around" }, { item_id: "u1" }),
    ev("turn.started", { engine: "caveman" }),
    ev(
      "tool.started",
      { name: "Read", title: "Read a.ts", kind: "read", input: {} },
      { item_id: "t1" },
    ),
    ev("tool.done", { status: "completed" }, { item_id: "t1" }),
    ev("subagent.started", { title: "Explore" }, { item_id: "sub1" }),
    ev(
      "tool.started",
      { name: "Read", title: "Read b.ts", kind: "read", input: {} },
      { item_id: "t2", parent_item_id: "sub1" },
    ),
    ev("tool.done", { status: "completed" }, { item_id: "t2", parent_item_id: "sub1" }),
    ev("turn.done", { status: "interrupted" }),
  );
  expect(continueNote(items, items.at(-1)!.id)).toContain(
    "- Read a.ts (completed)\n- Read b.ts (completed)",
  );
});

test("pressContinue sends one follow-up however many presses land, and comes back up only after a failure", async () => {
  const state = { current: "idle" as ContinueState };
  const shown: ContinueState[] = [];
  let release!: () => void;
  const send = vi.fn(() => new Promise<void>((r) => (release = r)));
  const first = pressContinue(state, send, (s) => shown.push(s));
  // A second press while the first is in flight does nothing.
  await pressContinue(state, send, (s) => shown.push(s));
  release();
  await first;
  // Nor does one after it went.
  await pressContinue(state, send, (s) => shown.push(s));
  expect(send).toHaveBeenCalledTimes(1);
  expect(shown).toEqual(["sending", "sent"]);

  const failed = { current: "idle" as ContinueState };
  const boom = vi.fn(() => Promise.reject(new Error("offline")));
  await pressContinue(failed, boom, () => undefined);
  expect(failed.current).toBe("idle");
  await pressContinue(failed, boom, () => undefined);
  expect(boom).toHaveBeenCalledTimes(2);
});
