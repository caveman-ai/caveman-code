import { describe, expect, it } from "vitest";
import { awaitsYou, type WorkspaceView } from "../state/model.ts";
import type { TranscriptItem } from "../state/transcript-model.ts";
import { doneToday, holdFor, linesOf, pulseOf, rowLine, spendText, stacksForInbox, type SpendRow } from "./inbox-model.ts";

const w = (id: string, over: Partial<WorkspaceView>): WorkspaceView => ({
  id,
  title: id,
  repo: "api",
  repoRef: { path: "/repos/api" },
  branch: null,
  state: "working",
  asleep: false,
  detail: null,
  engine: { id: "caveman", label: "Caveman" },
  computer: { kind: "this_mac", label: "This Mac" },
  parentId: null,
  sessionId: `s-${id}`,
  projectId: null,
  createdAt: "2026-10-15T10:00:00Z",
  updatedAt: "2026-10-15T10:00:00Z",
  unread: false,
  ...over,
});

const ids = (stacks: ReturnType<typeof stacksForInbox>) => stacks.map((s) => [s.id, s.rows.map((r) => r.workspace.id)]);

describe("inbox stacks", () => {
  const all = [
    w("late-ask", { state: "needs_input", updatedAt: "2026-10-15T10:09:00Z" }),
    w("early-ask", { state: "needs_input", updatedAt: "2026-10-15T10:01:00Z" }),
    w("failed", { state: "failed", unread: true }),
    w("read", { state: "completed", unread: false }),
    w("gone", { state: "archived" }),
    w("queued", { state: "queued" }),
    w("young", { createdAt: "2026-10-15T10:05:00Z", updatedAt: "2026-10-15T10:00:01Z" }),
    w("old", { createdAt: "2026-10-15T09:00:00Z", updatedAt: "2026-10-15T10:09:59Z" }),
  ];

  it("orders stacks by urgency and rows by who waited longest", () => {
    expect(ids(stacksForInbox(all, null))).toEqual([
      ["needs", ["early-ask", "late-ask"]],
      ["review", ["failed"]],
      ["working", ["old", "young"]],
      ["waiting", ["queued"]],
    ]);
  });

  it("stacks by status: a lead waiting on its agents is at work, a plan to build is yours to review", () => {
    const quiet = { ask: null, turnStartedAt: null, lastOutcome: null, turnEndedAt: null, todos: null, readyToBuild: false };
    const stacks = stacksForInbox(
      [
        w("lead", { state: "completed", unread: true }),
        w("builder", { parentId: "lead", state: "working" }),
        w("plan", { state: "completed", unread: false, activity: { ...quiet, readyToBuild: true } }),
        w("approve", { state: "needs_input", activity: { ...quiet, ask: { kind: "approval", prompt: "Push to main?" } } }),
      ],
      null,
    );
    expect(ids(stacks)).toEqual([
      ["needs", ["approve"]],
      ["review", ["plan"]],
      ["working", ["builder", "lead"]],
    ]);
    expect(stacks[0]!.rows[0]!.status).toMatchObject({ id: "approve", label: "Approve" });
  });

  it("counts in the sidebar exactly what its decision stacks hold", () => {
    const decisions = stacksForInbox(all, null).filter((s) => s.decision).flatMap((s) => s.rows.map((r) => r.workspace.id));
    expect(all.filter(awaitsYou).map((x) => x.id).sort()).toEqual(decisions.sort());
  });

  it("keeps the open row in its stack and place after it is read or answered", () => {
    const before = [w("a", { state: "completed", unread: true, updatedAt: "2026-10-15T10:01:00Z" }), w("b", { state: "completed", unread: true, updatedAt: "2026-10-15T10:02:00Z" })];
    const hold = holdFor(stacksForInbox(before, null), "a");
    expect(hold).toEqual({ id: "a", stack: "review", since: "2026-10-15T10:01:00Z" });
    // Opened: seen, and a new turn bumped its time. Still first in review.
    const after = [w("a", { state: "working", unread: false, updatedAt: "2026-10-15T10:05:00Z" }), before[1]!];
    expect(ids(stacksForInbox(after, hold))).toEqual([["review", ["a", "b"]]]);
    // Let go: it files where it now belongs.
    expect(ids(stacksForInbox(after, null))).toEqual([
      ["review", ["b"]],
      ["working", ["a"]],
    ]);
  });
});

describe("done today", () => {
  const now = new Date("2026-10-15T18:00:00");
  const at = (h: number) => new Date(2026, 9, 15, h).toISOString();

  it("closes the board with today's finished work you have read, newest first", () => {
    const all = [
      w("read-early", { state: "completed", unread: false, updatedAt: at(9) }),
      w("read-late", { state: "failed", unread: false, updatedAt: at(15) }),
      w("unread", { state: "completed", unread: true, updatedAt: at(16) }),
      w("yesterday", { state: "completed", unread: false, updatedAt: new Date(2026, 9, 14, 23).toISOString() }),
      w("working", { updatedAt: at(17) }),
    ];
    const stacks = stacksForInbox(all, null);
    const done = doneToday(all, stacks, now);
    expect(done?.id).toBe("done");
    expect(done?.decision).toBe(false);
    // Unread work is in Ready for review, never twice; yesterday's is gone.
    expect(done?.rows.map((r) => r.workspace.id)).toEqual(["read-late", "read-early"]);
  });

  it("is absent when nothing finished today", () => {
    const all = [w("a", { state: "working" })];
    expect(doneToday(all, stacksForInbox(all, null), now)).toBeNull();
  });
});

describe("row lines", () => {
  const item = (x: Partial<TranscriptItem> & { kind: TranscriptItem["kind"] }) => x as TranscriptItem;
  const view = (items: TranscriptItem[], over: { changedFiles?: number; pendingAsk?: Extract<TranscriptItem, { kind: "ask" }> } = {}) => ({
    items,
    pendingAsk: over.pendingAsk ?? null,
    changedFiles: over.changedFiles ?? 0,
  });

  it("shows the question an agent waits on", () => {
    const ask = item({ kind: "ask", id: "k", askKind: "question", prompt: "Postgres or Redis?", options: [], resolution: null }) as Extract<TranscriptItem, { kind: "ask" }>;
    expect(rowLine(w("a", { state: "needs_input" }), view([ask], { pendingAsk: ask })).text).toBe("Postgres or Redis?");
  });

  it("shows what a working agent does this second, and only that since the last message", () => {
    const said = item({ kind: "assistant", text: "Old plan", streaming: false });
    const tool = item({ kind: "tool", verb: "Running", subject: "go test ./...", status: "running" });
    expect(rowLine(w("a", {}), view([said, item({ kind: "user" }), tool]))).toEqual({ text: "Running go test ./...", live: true });
    expect(rowLine(w("a", { branch: "fix" }), view([said, item({ kind: "user" })]))).toEqual({ text: "api · fix", live: false });
  });

  it("sums up finished work by its files and its last words", () => {
    const done = item({ kind: "assistant", text: "\n## 3 retries now spread out\n\nDetails", streaming: false });
    expect(rowLine(w("a", { state: "completed" }), view([done], { changedFiles: 2 })).text).toBe("2 files · 3 retries now spread out");
    expect(rowLine(w("a", { state: "failed" }), view([done])).text).toBe("Failed · 3 retries now spread out");
    const named = item({ kind: "assistant", text: "Stopped at **batch 41**: `events_2024_q3` has rows with _no_ org", streaming: false });
    expect(rowLine(w("a", { state: "completed" }), view([named])).text).toBe("Stopped at batch 41: events_2024_q3 has rows with no org");
  });
});

describe("session vitals", () => {
  const now = Date.parse("2026-10-15T10:15:00Z");
  const tool = (at: string, added: number | null = null, removed: number | null = null) => ({ kind: "tool", startedAt: at, added, removed }) as unknown as TranscriptItem;

  it("counts tool calls per minute, builders included, oldest minute first", () => {
    const builder = { kind: "subagent", items: [tool("2026-10-15T10:14:30Z")] } as unknown as TranscriptItem;
    const pulse = pulseOf([tool("2026-10-15T09:00:00Z"), tool("2026-10-15T10:01:10Z"), tool("2026-10-15T10:14:05Z"), builder], now);
    expect(pulse).toHaveLength(15);
    expect(pulse[0]).toBe(0); // 10:00 to 10:01: nothing; the 09:00 call is out of the window
    expect(pulse[1]).toBe(1);
    expect(pulse[14]).toBe(2);
  });

  it("adds up the lines the agent's edits wrote", () => {
    const builder = { kind: "subagent", items: [tool("2026-10-15T10:00:00Z", 5, 1)] } as unknown as TranscriptItem;
    expect(linesOf([tool("2026-10-15T10:00:00Z", 38, 12), tool("2026-10-15T10:00:00Z"), builder])).toEqual({ added: 43, removed: 13 });
  });

  it("shows measured spend, and a plan session as its tokens and the plan's most-used window, never a price", () => {
    const row = (over: Partial<SpendRow>): SpendRow => ({ key: "w", label: "w", input_tokens: 1200, output_tokens: 300, cache_read_tokens: 0, cache_write_tokens: 0, measured_usd: 0.4213, saved_usd: null, saved_usd_partial: false, saved_tokens: 0, basis: "billed", ...over });
    expect(spendText(row({}))).toEqual({ text: "$0.42", title: "1.5K tokens, billed" });
    expect(spendText(row({ web_searches: 3 }))?.title).toBe("1.5K tokens, billed; includes 3 web searches");
    const windows = [
      { label: "Session", used_percent: 12 },
      { label: "Weekly", used_percent: 37.4 },
    ];
    expect(spendText(row({ measured_usd: null, basis: "plan" }), windows)).toEqual({
      text: "1.5K · Weekly 37%",
      title: "1.5K tokens on a subscription plan: no per-call price. Plan used: Weekly 37% · Session 12%",
    });
    expect(spendText(row({ measured_usd: null, basis: "plan" }))?.text).toBe("1.5K tokens");
    // A per-token key is never labelled a plan: no public price reads Unpriced, an older row that does not say reads Tokens.
    expect(spendText(row({ measured_usd: null, basis: "unpriced" }))?.text).toBe("Unpriced");
    expect(spendText(row({ measured_usd: null, basis: "none" }))?.text).toBe("Tokens");
    expect(spendText(undefined)).toBeNull();
  });
});
