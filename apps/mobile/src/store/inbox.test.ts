// The inbox's own rules, on the slice alone: Mark done and Not done, a chat that moves on, a pin, a chat that asks.
import { describe, expect, it } from "vitest";
import type { Chat, Phase } from "../board/model";
import {
  EMPTY_INBOX,
  type InboxState,
  inboxFromDisk,
  isDoneIn,
  reduceInbox,
  trackSince,
} from "./inbox";

const chat = (id: string, phase: Phase, more: Partial<Chat> = {}): Chat =>
  ({
    id,
    title: id,
    repo: "caveman-code",
    engine: "claude",
    model: "claude-opus-5-5",
    phase,
    line: "",
    items: [],
    startedAt: 0,
    updatedAt: 0,
    device: "mac",
    ...more,
  }) as Chat;

const run = (state: InboxState, ...actions: Parameters<typeof reduceInbox>[1][]) =>
  actions.reduce(reduceInbox, state);

describe("Mark done and Not done", () => {
  it("Not done brings a merged chat back off the Done shelf, until it moves on", () => {
    const merged = chat("m", "done");
    expect(isDoneIn(EMPTY_INBOX, merged)).toBe(true);
    const reopened = run(EMPTY_INBOX, { type: "inbox/reopen", id: "m", phase: "done" });
    expect(isDoneIn(reopened, merged)).toBe(false);
    // A new turn and its merge are news: the merge settles it again.
    const moved = trackSince(
      trackSince(reopened, [merged], [chat("m", "working")]),
      [chat("m", "working")],
      [merged],
    );
    expect(isDoneIn(moved, merged)).toBe(true);
  });

  it("waits while a chat asks something", () => {
    const asking = chat("a", "needs");
    const state = run(EMPTY_INBOX, { type: "inbox/done", id: "a", phase: "needs" });
    expect(state).toBe(EMPTY_INBOX);
    expect(isDoneIn(state, asking)).toBe(false);
  });

  it("files a snoozed chat on the Done shelf at once", () => {
    const snoozed = run(EMPTY_INBOX, {
      type: "inbox/snooze",
      id: "s",
      phase: "ready",
      until: Date.now() + 3_600_000,
    });
    const done = run(snoozed, { type: "inbox/done", id: "s", phase: "ready" });
    expect(done.snoozed.s).toBeUndefined();
    expect(isDoneIn(done, chat("s", "ready"))).toBe(true);
  });

  it("never counts a pinned merged chat as done unless you said so", () => {
    expect(isDoneIn(EMPTY_INBOX, chat("p", "done", { pinned: true }))).toBe(false);
  });
});

describe("a chat that does another turn", () => {
  it("leaves its done, its snooze and what you had read of it", () => {
    const marked = run(
      EMPTY_INBOX,
      { type: "inbox/done", id: "c", phase: "ready" },
      { type: "inbox/snooze", id: "d", phase: "ready", until: Date.now() + 60_000 },
    );
    const next = trackSince(
      marked,
      [chat("c", "ready"), chat("d", "ready")],
      [chat("c", "working"), chat("d", "working")],
    );
    expect(next.done.c).toBeUndefined();
    expect(next.snoozed.d).toBeUndefined();
    expect(next.seen.c).toBeUndefined();
    // Back in the phase it was marked in, it is not done again by itself.
    expect(isDoneIn(next, chat("c", "ready"))).toBe(false);
  });
});

describe("marks kept on disk", () => {
  it("reads a done mark kept before Not done existed as a Mark done", () => {
    const read = inboxFromDisk({ done: { old: { at: 1, phase: "ready" } } });
    expect(read?.done.old).toEqual({ at: 1, phase: "ready", done: true });
  });
});
