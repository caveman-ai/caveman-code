// The phone's transcript from a runtime's events: what each kind of event puts on screen, in the order a turn sends them.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { describe, expect, it } from "vitest";

import { answerFor, LiveTranscript, type LiveItem } from "./transcript.ts";

const AT = Date.parse("2026-11-09T10:00:00.000Z");

/** Events in cursor order, as a runtime journals them. */
function feed() {
  const t = new LiveTranscript();
  let cursor = 0;
  const ev = (
    type: SessionEvent["type"],
    payload: unknown,
    ids: { item_id?: string; parent_item_id?: string } = {},
  ) => {
    cursor += 1;
    t.apply(
      {
        session_id: "s",
        cursor,
        at: new Date(AT + cursor * 1000).toISOString(),
        type,
        payload,
        ...ids,
      } as unknown as SessionEvent,
      AT + 3_600_000,
    );
    return cursor;
  };
  return { t, ev };
}

const kinds = (items: readonly LiveItem[]) => items.map((item) => item.kind);
const tool = (name: string, kind: string, input: unknown = {}) => ({
  name,
  title: name,
  kind,
  input,
});

describe("words", () => {
  it("arrive a piece at a time into one item, and the finished message has the last word", () => {
    const { t, ev } = feed();
    ev("turn.started", { model: "claude-sonnet-4-5" });
    expect(t.running).toBe(true);
    expect(t.line).toBe("Thinking");
    ev("message.delta", { text: "All five " }, { item_id: "m1" });
    const first = t.items();
    expect(first).toMatchObject([{ kind: "text", id: "m1", text: "All five ", at: AT + 2000 }]);
    expect(t.line).toBe("Writing");
    ev("message.delta", { text: "checks " }, { item_id: "m1" });
    ev("message.delta", { text: "pass." }, { item_id: "m1" });
    // A new array each time something changed, so a screen holding the old one re-renders; the same one otherwise.
    expect(t.items()).not.toBe(first);
    expect(t.items()).toBe(t.items());
    expect(t.items()).toMatchObject([
      { kind: "text", id: "m1", text: "All five checks pass.", at: AT + 2000 },
    ]);
    // The snapshot is the truth (a scrubbed secret, a corrected word).
    ev("message.done", { role: "assistant", text: "All five checks pass now." }, { item_id: "m1" });
    expect(t.items()).toMatchObject([
      { kind: "text", id: "m1", text: "All five checks pass now." },
    ]);
    ev("turn.done", { status: "completed" });
    expect(t.running).toBe(false);
    expect(t.outcome).toBe("completed");
    expect(t.model).toBe("claude-sonnet-4-5");
  });

  it("an event already applied is not applied twice, and a subagent's own events stay out of the chat", () => {
    const { t, ev } = feed();
    const cursor = ev("message.delta", { text: "Once." }, { item_id: "m1" });
    t.apply({
      session_id: "s",
      cursor,
      at: new Date(AT).toISOString(),
      type: "message.delta",
      item_id: "m1",
      payload: { text: "Once." },
    } as unknown as SessionEvent);
    ev(
      "message.delta",
      { text: "Inside the subagent." },
      { item_id: "m2", parent_item_id: "agent-1" },
    );
    expect(t.items()).toMatchObject([{ kind: "text", text: "Once." }]);
    expect(t.cursor).toBe(2);
  });

  it("never start ahead of the phone's clock, whatever the Mac's says", () => {
    const t = new LiveTranscript();
    t.apply(
      {
        session_id: "s",
        cursor: 1,
        at: new Date(AT + 60_000).toISOString(),
        type: "message.delta",
        item_id: "m1",
        payload: { text: "Hi" },
      } as unknown as SessionEvent,
      AT,
    );
    expect(t.items()).toMatchObject([{ at: AT }]);
  });
});

describe("your messages", () => {
  it("show at once as sending, then sent, and the runtime's own event takes the echo's place", () => {
    const { t, ev } = feed();
    t.echo("sp-msg:1", "Ship it", false, AT);
    expect(t.items()).toEqual([
      { kind: "you", id: "sp-msg:1", text: "Ship it", at: AT, state: "sending" },
    ]);
    t.sent("sp-msg:1");
    expect(t.items()).toMatchObject([{ state: "sent" }]);
    ev("message.done", { role: "user", text: "Ship it" }, { item_id: "sp-msg:1" });
    // Once, where it already sat, at the time it was sent.
    expect(t.items()).toEqual([
      { kind: "you", id: "sp-msg:1", text: "Ship it", at: AT, state: "sent" },
    ]);
  });

  it("a message that was refused stays, marked as not sent, through a rewritten journal, until it is sent again", () => {
    const { t } = feed();
    t.echo("m1", "Too late", false, AT);
    t.fail("m1");
    expect(t.items()).toMatchObject([{ kind: "you", id: "m1", text: "Too late", state: "failed" }]);
    expect(t.failed("m1")).toMatchObject({ text: "Too late" });
    // The journal starts over (the chat moved): what the person typed is theirs to take back, nobody else's.
    t.reset();
    expect(t.items()).toMatchObject([{ kind: "you", id: "m1", state: "failed" }]);
    // Sent again: its mark goes with it, and the new send's own echo stands in its place.
    t.unecho("m1");
    expect(t.items()).toEqual([]);
    expect(t.failed("m1")).toBeUndefined();
  });

  it("a send taken back leaves nothing behind, and a steer says it is one", () => {
    const { t, ev } = feed();
    t.echo("sp-msg:1", "Ship it", false, AT);
    t.unecho("sp-msg:1");
    expect(t.items()).toEqual([]);
    ev("message.done", { role: "user", text: "Use pnpm", delivery: "steer" }, { item_id: "u2" });
    expect(t.items()).toMatchObject([
      { kind: "you", text: "Use pnpm", steer: true, state: "sent" },
    ]);
  });

  it("another agent's message reads as said to the chat, not as yours", () => {
    const { t, ev } = feed();
    ev(
      "message.done",
      { role: "user", text: "Review the diff.", from: { workspace_id: "w0", title: "Lead" } },
      { item_id: "u1" },
    );
    expect(t.items()).toMatchObject([
      { kind: "text", text: "From Lead: Review the diff.", phase: "commentary" },
    ]);
  });

  it("what the runtime wrote for the agent is one quiet line, never the person's own message or the instructions", () => {
    const { t, ev } = feed();
    const told =
      "[Caveman Code] Your builders have finished. Review the merged branch, run the checks and open a pull request.";
    ev(
      "message.done",
      {
        role: "user",
        text: "Port the settings page finished its turn. Read its diff.",
        from: { workspace_id: "b1", title: "Port the settings page" },
        generated: { shown: "Port the settings page finished" },
      },
      { item_id: "g1" },
    );
    ev(
      "message.done",
      {
        role: "user",
        text: told,
        generated: { shown: "Builders finished" },
        builders_result: {
          total: 30,
          merged: 28,
          left_out: [
            { title: "Port the sidebar", why: "conflicts in a.ts" },
            { title: "Port the menu", why: "its agent stopped" },
          ],
          pull_requests: [{ number: 128, url: "https://github.com/acme/app/pull/128" }],
        },
      },
      { item_id: "g2" },
    );
    expect(t.items()).toMatchObject([
      { kind: "text", text: "Port the settings page finished", phase: "commentary" },
      { kind: "text", text: "28 of 30 merged · 2 left out · PR #128", phase: "commentary" },
    ]);
    expect(JSON.stringify(t.items())).not.toContain("Your builders have finished");
    expect(kinds(t.items())).not.toContain("you");
  });
});

describe("work", () => {
  it("tool calls in a row are one group, closed by the words that follow; a failure is on its step", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("tool.started", tool("Read src/relay.ts", "read"), { item_id: "t1" });
    ev("tool.started", tool("pnpm test", "command", { command: "pnpm test" }), { item_id: "t2" });
    expect(t.line).toBe("pnpm test");
    ev("tool.done", { status: "completed" }, { item_id: "t1" });
    ev(
      "tool.done",
      { status: "failed", error: "1 test failed\n  at relay.test.ts" },
      { item_id: "t2" },
    );
    expect(t.items()).toMatchObject([
      {
        kind: "work",
        steps: [
          { tool: "read", text: "Read src/relay.ts" },
          { tool: "run", text: "pnpm test", detail: "1 test failed" },
        ],
      },
    ]);
    expect((t.items()[0] as { endedAt?: number }).endedAt).toBeUndefined();
    ev("message.delta", { text: "One test fails." }, { item_id: "m1" });
    expect((t.items()[0] as { endedAt?: number }).endedAt).toBe(AT + 6000);
    // Work after the words is a group of its own.
    ev("tool.started", tool("Edit src/relay.ts", "edit"), { item_id: "t3" });
    ev("tool.done", { status: "declined" }, { item_id: "t3" });
    ev("turn.done", { status: "completed" });
    expect(kinds(t.items())).toEqual(["work", "text", "work"]);
    expect(t.items()[2]).toMatchObject({
      steps: [{ tool: "edit", text: "Edit src/relay.ts", detail: "Denied" }],
      endedAt: AT + 9000,
    });
  });

  it("a call's input arriving later fills its step in place", () => {
    const { t, ev } = feed();
    ev("tool.started", tool("Bash", "command"), { item_id: "t1" });
    ev("tool.started", tool("pnpm lint", "command", { command: "pnpm lint" }), { item_id: "t1" });
    expect(t.items()).toEqual([
      {
        kind: "work",
        id: "work:1",
        steps: [{ tool: "run", text: "pnpm lint" }],
        startedAt: AT + 1000,
      },
    ]);
  });

  it("the chat's worktree being made is not work, but its failure is said", () => {
    const { t, ev } = feed();
    ev("tool.started", tool("worktree", "other"), { item_id: "worktree:w1" });
    ev("tool.done", { status: "completed" }, { item_id: "worktree:w1" });
    expect(t.items()).toEqual([]);
    ev("tool.started", tool("worktree", "other"), { item_id: "worktree:w2" });
    ev(
      "tool.done",
      { status: "failed", error: "fatal: not a git repository" },
      { item_id: "worktree:w2" },
    );
    expect(t.items()).toMatchObject([{ kind: "text", text: "fatal: not a git repository" }]);
  });

  it("a delegated agent is a link to its chat; a native one is a line of work", () => {
    const { t, ev } = feed();
    ev("subagent.started", { title: "Explore", workspace_id: "w2" }, { item_id: "a1" });
    ev("subagent.started", { title: "Review", workspace_id: "w3" }, { item_id: "a2" });
    ev("subagent.started", { title: "the search" }, { item_id: "a3" });
    expect(t.items()).toMatchObject([
      { kind: "agents", children: ["w2", "w3"] },
      { kind: "work", steps: [{ text: "Started the search" }] },
    ]);
  });
});

const approval = {
  kind: "approval",
  title: "Run a command",
  tool_item_id: "t1",
  options: [
    { id: "yes", decision: "allow" },
    { id: "no", decision: "deny" },
  ],
};
const question = {
  kind: "question",
  questions: [
    {
      id: "q1",
      prompt: "Which database?",
      recommended: "pg",
      options: [
        { id: "pg", label: "Postgres", description: "What the app uses" },
        { id: "lite", label: "SQLite" },
      ],
    },
  ],
};

describe("asks", () => {
  it("an approval shows the command it would run and what it said before; Allow answers it", () => {
    const { t, ev } = feed();
    ev(
      "message.done",
      { role: "assistant", text: "The schema is behind. I need to migrate it. Then the tests." },
      { item_id: "m1" },
    );
    ev("tool.started", tool("Bash", "command", { command: "pnpm db:migrate" }), { item_id: "t1" });
    ev("ask.user", approval, { item_id: "ask1" });
    expect(t.ask).toMatchObject({
      id: "ask1",
      line: "pnpm db:migrate",
      need: {
        kind: "approval",
        command: "pnpm db:migrate",
        summary: "The schema is behind. I need to migrate it.",
      },
    });
    expect(t.items().at(-1)).toEqual({ kind: "ask", id: "ask1", command: "pnpm db:migrate" });
    expect(answerFor(t.ask!, { kind: "allow" })).toEqual({ kind: "approval", option_id: "yes" });
    expect(answerFor(t.ask!, { kind: "deny" })).toEqual({ kind: "approval", option_id: "no" });
    // Words with a no go to an engine that takes them, and are left for a steer where it does not.
    expect(answerFor(t.ask!, { kind: "deny", instead: "Use the staging database" })).toEqual({
      kind: "approval",
      option_id: "no",
    });
    expect(
      answerFor(
        { ...t.ask!, payload: { ...t.ask!.payload, accepts_feedback: true } as never },
        { kind: "told", text: "Use staging" },
      ),
    ).toEqual({ kind: "approval", option_id: "no", feedback: "Use staging" });
    ev(
      "ask.resolved",
      { outcome: "answered", response: { kind: "approval", option_id: "yes" } },
      { item_id: "ask1" },
    );
    expect(t.ask).toBeNull();
    expect(t.items().at(-1)).toMatchObject({ kind: "ask", answer: "allowed" });
  });

  it("the work an ask interrupted is over once the engine goes on: the next message is a new turn, not a steer", () => {
    const { t, ev } = feed();
    ev("tool.started", tool("Bash", "command", { command: "pnpm db:migrate" }), { item_id: "t1" });
    ev("ask.user", approval, { item_id: "ask1" });
    // While it waits, its work is still open above the ask.
    expect(t.items()).toMatchObject([{ kind: "work" }, { kind: "ask" }]);
    expect((t.items()[0] as { endedAt?: number }).endedAt).toBeUndefined();
    ev(
      "ask.resolved",
      { outcome: "answered", response: { kind: "approval", option_id: "yes" } },
      { item_id: "ask1" },
    );
    ev("tool.done", { status: "completed" }, { item_id: "t1" });
    ev("message.done", { role: "assistant", text: "Migrated." }, { item_id: "m1" });
    expect((t.items()[0] as { endedAt?: number }).endedAt).toBe(AT + 5000);

    // More calls after an ask start a group of their own, and the one before it is closed there.
    const again = feed();
    again.ev("tool.started", tool("Bash", "command", { command: "pnpm db:migrate" }), {
      item_id: "t1",
    });
    again.ev("ask.user", approval, { item_id: "ask1" });
    again.ev(
      "ask.resolved",
      { outcome: "answered", response: { kind: "approval", option_id: "yes" } },
      { item_id: "ask1" },
    );
    again.ev("tool.started", tool("pnpm test", "command"), { item_id: "t2" });
    expect(kinds(again.t.items())).toEqual(["work", "ask", "work"]);
    expect((again.t.items()[0] as { endedAt?: number }).endedAt).toBe(AT + 4000);
    again.ev("turn.done", { status: "completed" });
    expect((again.t.items()[2] as { endedAt?: number }).endedAt).toBe(AT + 5000);
  });

  it("an approval the person refused reads as denied; one nobody answered goes, never as a no nobody gave", () => {
    const refused = feed();
    refused.ev(
      "ask.user",
      { ...approval, tool_item_id: undefined, detail: "rm -r build" },
      { item_id: "ask1" },
    );
    expect(refused.t.ask?.line).toBe("rm -r build");
    refused.ev(
      "ask.resolved",
      {
        outcome: "answered",
        response: {
          kind: "approval",
          option_id: approval.options.find((o: { decision: string }) => o.decision === "deny")!.id,
        },
      },
      { item_id: "ask1" },
    );
    expect(refused.t.items()).toMatchObject([
      { kind: "ask", command: "rm -r build", answer: "denied" },
    ]);
    expect(refused.t.outcomeOf("ask1")).toBe("answered");

    // Its computer restarted, or went to sleep, with the ask open: nobody said no.
    for (const outcome of ["expired", "cancelled"]) {
      const lapsed = feed();
      lapsed.ev(
        "ask.user",
        { ...approval, tool_item_id: undefined, detail: "rm -r build" },
        { item_id: "ask1" },
      );
      lapsed.ev("ask.resolved", { outcome }, { item_id: "ask1" });
      expect(lapsed.t.items()).toEqual([]);
      expect(lapsed.t.ask).toBeNull();
      expect(lapsed.t.outcomeOf("ask1")).toBe(outcome);
    }
  });

  it("a question shows its options, the recommended one marked, and the answer reads as your message", () => {
    const { t, ev } = feed();
    ev("ask.user", question, { item_id: "ask1" });
    expect(t.ask?.need).toMatchObject({
      kind: "question",
      question: "Which database?",
      options: [
        { label: "Postgres", detail: "What the app uses", recommended: true },
        { label: "SQLite" },
      ],
    });
    expect(answerFor(t.ask!, { kind: "option", option: { label: "SQLite" } })).toEqual({
      kind: "question",
      answers: [{ question_id: "q1", option_ids: ["lite"] }],
    });
    // A bare yes takes the one it recommends; your own words go as they are.
    expect(answerFor(t.ask!, { kind: "allow" })).toEqual({
      kind: "question",
      answers: [{ question_id: "q1", option_ids: ["pg"] }],
    });
    expect(answerFor(t.ask!, { kind: "told", text: "Neither, use DuckDB" })).toEqual({
      kind: "question",
      answers: [{ question_id: "q1", option_ids: [], text: "Neither, use DuckDB" }],
    });
    ev(
      "ask.resolved",
      {
        outcome: "answered",
        response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["lite"] }] },
      },
      { item_id: "ask1" },
    );
    expect(t.items()).toMatchObject([{ kind: "you", text: "SQLite", state: "sent" }]);
  });

  it("one only the Mac can answer says so, and the phone has no answer for it", () => {
    const { t, ev } = feed();
    ev("ask.user", { kind: "secret", name: "STRIPE_KEY" }, { item_id: "ask1" });
    expect(t.ask).toMatchObject({ need: null, line: "Needs STRIPE_KEY: add it on your Mac" });
    expect(answerFor(t.ask!, { kind: "allow" })).toBeNull();
  });
});

describe("a turn its computer cut, which nobody stopped", () => {
  it("put to sleep with an ask open: no Denied and no You stopped, as the runtime's own note says it carries on", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("ask.user", approval, { item_id: "ask1" });
    // What the runtime writes when Cloud puts its computer to sleep (handlers.ts parkForStop): the ask cancelled, the
    // turn interrupted with no reason, then its note.
    ev("ask.resolved", { outcome: "cancelled" }, { item_id: "ask1" });
    ev("turn.done", { status: "interrupted" }, { item_id: "turn-1" });
    expect(kinds(t.items())).toEqual(["stop"]);
    ev("notification", {
      level: "info",
      title: "Paused while this computer sleeps",
      body: "This turn stopped at a safe point so this Cloud computer could go to sleep. It carries on by itself when the computer wakes.",
    });
    expect(t.items()).toEqual([]);
  });

  it("restarted under it: the ask lapsed, and the turn's end is not the person's Stop", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("ask.user", approval, { item_id: "ask1" });
    ev("ask.resolved", { outcome: "expired" }, { item_id: "ask1" });
    ev("turn.done", { status: "interrupted" }, { item_id: "turn-1" });
    expect(t.items()).toEqual([]);
  });

  it("stopped by the person with an ask open still says so: any other note changes nothing", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("ask.user", approval, { item_id: "ask1" });
    ev("ask.resolved", { outcome: "cancelled" }, { item_id: "ask1" });
    ev("turn.done", { status: "interrupted" }, { item_id: "turn-1" });
    ev("notification", { level: "info", title: "Checks passed" });
    expect(kinds(t.items())).toEqual(["stop"]);
  });
});

describe("how a turn ends", () => {
  it("stopped by you leaves a mark; moved to another computer does not; a failure says why", () => {
    const stopped = feed();
    stopped.ev("turn.started", {});
    stopped.ev("turn.done", { status: "interrupted" }, { item_id: "turn-1" });
    expect(kinds(stopped.t.items())).toEqual(["stop"]);

    const moved = feed();
    moved.ev("turn.done", { status: "interrupted", reason: "moved" });
    expect(moved.t.items()).toEqual([]);

    const failed = feed();
    failed.ev("ask.user", approval, { item_id: "ask1" });
    failed.ev("turn.done", { status: "failed", error: "The engine is signed out." });
    expect(failed.t.ask).toBeNull();
    expect(failed.t.items().at(-1)).toMatchObject({
      kind: "text",
      text: "The engine is signed out.",
    });
    expect(failed.t.outcome).toBe("failed");
  });

  it("an error being retried is a line, not an entry; one that ends things is said", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("error", { message: "Overloaded", retry: { attempt: 1 } });
    expect(t.line).toBe("Trying again");
    expect(t.items()).toEqual([]);
    ev("turn.done", { status: "completed" });
    ev("error", { message: "The chat's folder is gone." });
    expect(t.items()).toMatchObject([{ kind: "text", text: "The chat's folder is gone." }]);
  });

  it("going back to an earlier turn drops what came after it, and a rewritten journal drops everything", () => {
    const { t, ev } = feed();
    ev("message.done", { role: "user", text: "First" }, { item_id: "u1" });
    const kept = ev("turn.done", { status: "completed" });
    ev("message.done", { role: "user", text: "Second" }, { item_id: "u2" });
    ev("message.done", { role: "assistant", text: "Done." }, { item_id: "m2" });
    ev("session.restored", { at: kept });
    expect(t.items()).toMatchObject([{ kind: "you", text: "First" }]);
    t.reset();
    expect(t.items()).toEqual([]);
    expect(t.cursor).toBe(0);
  });
});

describe("what its computer did not say", () => {
  it("never says who stopped a turn: the runtime does not, so the line reads only that it stopped", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("turn.done", { status: "interrupted" }, { item_id: "turn-1" });
    expect(t.items()).toMatchObject([{ kind: "stop", unowned: true }]);
  });

  it("a command whose ask nobody answered was not run, and nobody denied it", () => {
    const { t, ev } = feed();
    ev("turn.started", {});
    ev("tool.started", tool("Bash", "command", { command: "pnpm db:migrate" }), {
      item_id: "tool1",
    });
    ev("ask.user", approval, { item_id: "ask1" });
    // Its computer was stopped with the ask open.
    ev("ask.resolved", { outcome: "cancelled" }, { item_id: "ask1" });
    ev("tool.done", { status: "declined" }, { item_id: "tool1" });
    expect(t.items()).toMatchObject([{ kind: "work", steps: [{ detail: "Not run" }] }]);
    // One the person said no to still reads as denied.
    const next = feed();
    next.ev("turn.started", {});
    next.ev("tool.started", tool("Bash", "command", { command: "pnpm db:migrate" }), {
      item_id: "tool1",
    });
    next.ev("ask.user", approval, { item_id: "ask1" });
    next.ev(
      "ask.resolved",
      { outcome: "answered", response: { kind: "approval", option_id: "no" } },
      { item_id: "ask1" },
    );
    next.ev("tool.done", { status: "declined" }, { item_id: "tool1" });
    expect(next.t.items().find((item) => item.kind === "work")).toMatchObject({
      steps: [{ detail: "Denied" }],
    });
  });
});

describe("a message of yours the chat's journal has not said yet", () => {
  it("stays through a rewritten journal, after everything replayed, and takes its place when the journal says it", () => {
    const { t, ev } = feed();
    ev("message.done", { role: "user", text: "First" }, { item_id: "u1" });
    ev("message.done", { role: "assistant", text: "Done." }, { item_id: "m1" });
    // Sent while its computer slept: Cloud keeps it for the computer.
    t.echo("u2", "And the timeout case?", false, AT);
    t.sent("u2");
    expect(t.unsaid()).toMatchObject([{ id: "u2", text: "And the timeout case?" }]);
    // The computer wakes and replays its journal from the start: the message is still there, under what was replayed.
    t.reset();
    expect(t.items()).toMatchObject([{ kind: "you", text: "And the timeout case?" }]);
    const again = (cursor: number, type: string, payload: unknown, item: string) =>
      t.apply(
        {
          session_id: "s",
          cursor,
          at: new Date(AT).toISOString(),
          type,
          payload,
          item_id: item,
        } as unknown as SessionEvent,
        AT,
      );
    again(1, "message.done", { role: "user", text: "First" }, "u1");
    again(2, "message.done", { role: "assistant", text: "Done." }, "m1");
    expect(t.items().map((item) => ("text" in item ? item.text : item.kind))).toEqual([
      "First",
      "Done.",
      "And the timeout case?",
    ]);
    // The journal says it: it is the computer's own from here, once, in its place.
    again(3, "message.done", { role: "user", text: "And the timeout case?" }, "u2");
    expect(t.items().map((item) => ("text" in item ? item.text : item.kind))).toEqual([
      "First",
      "Done.",
      "And the timeout case?",
    ]);
    expect(t.unsaid()).toEqual([]);
  });

  it("goes with the chat to the computer that takes it", () => {
    const from = new LiveTranscript();
    from.echo("u2", "And the timeout case?", false, AT);
    const to = new LiveTranscript();
    to.take(from.unsaid());
    to.take(from.unsaid());
    expect(to.items()).toMatchObject([
      { kind: "you", id: "u2", text: "And the timeout case?", state: "sending" },
    ]);
    expect(to.unsaid()).toHaveLength(1);
  });
});
