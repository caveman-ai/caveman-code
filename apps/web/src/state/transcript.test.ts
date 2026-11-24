import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test, vi } from "vitest";
import { resetTime, SessionModel } from "./transcript.ts";
import type { ToolItem, TranscriptItem } from "./transcript-model.ts";
import { summarizeParts } from "./tool-actions.ts";
import { THIS_COMPUTER } from "../lib/platform.ts";

let cursor = 0;
const at = "2026-10-15T08:00:00.000Z";
const ev = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}): SessionEvent =>
  ({ session_id: "s1", cursor: ++cursor, at, type, payload, ...extra }) as SessionEvent;

test("turn harness attribution: reducer retains the original harness through updates after a switch", () => {
  cursor = 0;
  const m = new SessionModel();
  for (const event of [
    ev("message.done", { role: "user", text: "check it" }, { item_id: "u1" }),
    ev("turn.started", { engine: "codex", model: "gpt-6.1-luna" }),
    ev("message.delta", { text: "Checking." }, { item_id: "a1" }),
    ev("reasoning.delta", { text: "Read first." }, { item_id: "r1" }),
    ev("tool.started", { name: "Read", title: "Read main.ts", kind: "read", input: {} }, { item_id: "tool1" }),
    ev("plan.updated", { kind: "todos", steps: [{ text: "Check", status: "in_progress" }] }, { item_id: "plan1" }),
    ev("error", { reason: "engine_unavailable", message: "Retrying", retry: { attempt: 1 } }, { item_id: "retry1" }),
    ev("ask.user", { kind: "approval", title: "Run?", options: [{ id: "yes", label: "Allow", decision: "allow" }] }, { item_id: "ask1" }),
    ev("subagent.started", { title: "Explore" }, { item_id: "sub1" }),
    ev("message.done", { role: "assistant", text: "Explored." }, { item_id: "nested1", parent_item_id: "sub1" }),
    ev("turn.done", { status: "completed" }),
  ]) m.apply(event);
  const before = m.snapshot();
  expect(before.items[0]).not.toHaveProperty("engine");
  expect(before.items.slice(1).every((i) => i.engine === "codex")).toBe(true);
  const sub = before.items.find((i) => i.kind === "subagent")!;
  expect(sub.kind === "subagent" && sub.items[0]?.engine).toBe("codex");

  // Switching the current turn, even without model metadata, cannot relabel existing items on an update.
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  for (const event of [
    ev("message.done", { role: "assistant", text: "Checked." }, { item_id: "a1" }),
    ev("tool.done", { status: "completed" }, { item_id: "tool1" }),
    ev("plan.updated", { kind: "todos", steps: [{ text: "Check", status: "completed" }] }, { item_id: "plan1" }),
    ev("error", { reason: "engine_unavailable", message: "Retrying again", retry: { attempt: 2 } }, { item_id: "retry1" }),
    ev("ask.resolved", { outcome: "answered", response: { kind: "approval", option_id: "yes" } }, { item_id: "ask1" }),
    ev("subagent.done", { status: "completed" }, { item_id: "sub1" }),
  ]) m.apply(event);
  const after = m.snapshot();
  expect(after.items.map((i) => [i.id, i.engine])).toEqual(before.items.map((i) => [i.id, i.engine]));
  expect(after.items.find((i) => i.id === "a1")).toMatchObject({ engine: "codex", text: "Checked.", streaming: false });
  expect(before.items.find((i) => i.id === "a1")).toMatchObject({ engine: "codex", text: "Checking." });
  m.apply(ev("message.done", { role: "assistant", text: "New harness." }, { item_id: "a2" }));
  expect(m.snapshot().items.at(-1)).toMatchObject({ engine: "claude-agent", text: "New harness." });
});

test("a subagent the person stopped reads stopped, told apart from one that failed", () => {
  cursor = 0;
  const m = new SessionModel();
  for (const e of [
    ev("message.done", { role: "user", text: "look around" }, { item_id: "u1" }),
    ev("turn.started", { engine: "claude-agent" }),
    ev("subagent.started", { title: "Explore" }, { item_id: "stopped", turn_id: "r1" }),
    ev("subagent.started", { title: "Build" }, { item_id: "broken", turn_id: "r1" }),
    ev("subagent.started", { title: "Read" }, { item_id: "fine", turn_id: "r1" }),
    ev("subagent.done", { status: "completed" }, { item_id: "fine", turn_id: "r1" }),
    ev("subagent.done", { status: "failed", summary: "crashed" }, { item_id: "broken", turn_id: "r1" }),
    // Stop: the runtime ends the subagent it cut off "interrupted" (projector.ts).
    ev("subagent.done", { status: "interrupted" }, { item_id: "stopped", turn_id: "r1" }),
    ev("turn.done", { status: "interrupted" }, { turn_id: "r1" }),
  ]) m.apply(e);
  const status = new Map(m.snapshot().items.flatMap((i) => (i.kind === "subagent" ? [[i.id, i.status] as const] : [])));
  expect(Object.fromEntries(status)).toEqual({ stopped: "stopped", broken: "failed", fine: "done" });
});

test("folds a turn into user, assistant, tool, subagent and ask items; drops usage", () => {
  cursor = 0;
  const m = new SessionModel();
  const events: SessionEvent[] = [
    ev("message.done", { role: "user", text: "fix it" }, { item_id: "u1" }),
    ev("turn.started", { engine: "caveman" }),
    ev("message.delta", { text: "Found " }, { item_id: "a1" }),
    ev("message.delta", { text: "the cause." }, { item_id: "a1" }),
    ev("tool.started", { name: "bash", title: "go test ./...", kind: "command", input: {} }, { item_id: "t1" }),
    ev("tool.output", { text: "ok\n" }, { item_id: "t1" }),
    ev("tool.done", { status: "completed" }, { item_id: "t1" }),
    ev("subagent.started", { title: "Explore" }, { item_id: "sa1" }),
    ev("tool.started", { name: "read", title: "retry.go", kind: "read", input: {} }, { item_id: "t2", parent_item_id: "sa1" }),
    ev("tool.done", { status: "completed" }, { item_id: "t2", parent_item_id: "sa1" }),
    ev("subagent.done", { status: "completed" }, { item_id: "sa1" }),
    ev("usage", { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: { usd: 0.01, basis: "billed" } }),
    ev("ask.user", { kind: "question", questions: [{ id: "q1", prompt: "Redis or Postgres?", options: [{ id: "pg", label: "Postgres" }], multi_select: false, allow_text: true }] }, { item_id: "k1" }),
  ];
  for (const e of events) m.apply(e);

  let v = m.snapshot();
  expect(v.running).toBe(true);
  expect(v.items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "subagent", "ask"]);
  const assistant = v.items[1]!;
  expect(assistant.kind === "assistant" && assistant.text).toBe("Found the cause.");
  const tool = v.items[2]!;
  // A shell command says what it did, and keeps the command its line opens to.
  expect(tool.kind === "tool" && [tool.verb, tool.subject, tool.command, tool.status, tool.output]).toEqual(["Tested", "./...", "go test ./...", "done", "ok\n"]);
  const sub = v.items[3]!;
  expect(sub.kind === "subagent" && sub.items.map((i) => i.kind === "tool" && i.subject)).toEqual(["retry.go"]);
  expect(v.pendingAsk?.prompt).toBe("Redis or Postgres?");

  m.apply(ev("ask.resolved", { outcome: "answered", response: { kind: "question", answers: [{ question_id: "q1", option_ids: ["pg"] }] } }, { item_id: "k1" }));
  m.apply(ev("turn.done", { status: "completed" }));
  v = m.snapshot();
  expect(v.pendingAsk).toBeNull();
  expect(v.running).toBe(false);
  const ask = v.items[4]!;
  expect(ask.kind === "ask" && ask.resolution).toBe("Postgres");
});

test("ignores events at or below the last cursor", () => {
  cursor = 0;
  const m = new SessionModel();
  const e = ev("message.delta", { text: "x" }, { item_id: "a" });
  m.apply(e);
  m.apply(e);
  const item = m.snapshot().items[0]!;
  expect(item.kind === "assistant" && item.text).toBe("x");
});

test("queue.updated bumps queueVersion (the queue strip re-reads) and adds nothing to the transcript", () => {
  cursor = 0;
  const m = new SessionModel();
  expect(m.snapshot().queueVersion).toBe(0);
  m.apply(ev("queue.updated", { turns: [{ turn_id: "t2", text: "then test", queued_at: at }] }));
  m.apply(ev("queue.updated", { turns: [] }));
  expect(m.snapshot()).toMatchObject({ queueVersion: 2, items: [] });
});

test("session.restored drops what came after its turn; goal.updated sets and clears the goal", () => {
  cursor = 0;
  const m = new SessionModel();
  for (const e of [
    ev("message.done", { role: "user", text: "one" }, { item_id: "u1" }),
    ev("turn.started", { engine: "claude-agent" }),
    ev("message.done", { role: "assistant", text: "did one" }, { item_id: "a1" }),
    ev("turn.done", { status: "completed" }),
    ev("goal.updated", { objective: "Ship it", native: false }),
    ev("message.done", { role: "user", text: "two" }, { item_id: "u2" }),
    ev("turn.started", { engine: "claude-agent" }),
    ev("subagent.started", { title: "Explore" }, { item_id: "sa1" }),
    ev("message.done", { role: "assistant", text: "did two" }, { item_id: "a2" }),
    ev("turn.done", { status: "completed" }),
  ])
    m.apply(e);
  expect(m.snapshot().goal).toEqual({ objective: "Ship it", native: false });
  const end = m.snapshot().items.find((i) => i.kind === "turn_end")!;
  expect(end.kind === "turn_end" && end.cursor).toBe(4);

  m.apply(ev("session.restored", { at: 4, branch_workspace_id: "w2" }));
  const v = m.snapshot();
  expect(v.items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual(["one", "did one", "turn_end", "restored"]);
  expect(v.items.at(-1)).toMatchObject({ kind: "restored", branchWorkspaceId: "w2" });
  // A later item with a dropped id comes back as new.
  m.apply(ev("message.done", { role: "user", text: "two again" }, { item_id: "u2" }));
  expect(m.snapshot().items.at(-1)).toMatchObject({ kind: "user", text: "two again" });

  m.apply(ev("goal.updated", { objective: null, native: false }));
  expect(m.snapshot().goal).toBeNull();
});

test("a user-role message another thread wrote keeps its sender; the person's own has none", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "mine" }, { item_id: "u1" }));
  m.apply(ev("message.done", { role: "user", text: "done: see [Auth](t3-context://v1/thread/ws_a)", from: { workspace_id: "ws_a", title: "Auth" } }, { item_id: "u2" }));
  // A sender with no workspace (a delegated child) still says who it is.
  m.apply(ev("message.done", { role: "user", text: "child done", from: { title: "Child task" } }, { item_id: "u3" }));
  const [mine, peer, child] = m.snapshot().items;
  expect(mine).not.toHaveProperty("from");
  expect(peer).toMatchObject({ kind: "user", text: "done: see [Auth](t3-context://v1/thread/ws_a)", from: { workspace_id: "ws_a", title: "Auth" } });
  expect(child).toMatchObject({ kind: "user", from: { title: "Child task" } });
});

test("a message an outside agent sent keeps its name and says it is an outside agent, with no thread to open", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "Add a retry to the webhook", from: { title: "Grok", agent: true } }, { item_id: "u1" }));
  const [sent] = m.snapshot().items;
  expect(sent).toMatchObject({ kind: "user", from: { title: "Grok", agent: true } });
  expect(sent).not.toHaveProperty("from.workspace_id");
});

test("a thought stops streaming once the next item lands, not at the turn's end", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude" }));
  m.apply(ev("reasoning.delta", { text: "Load the tool first." }, { item_id: "r1" }));
  expect(m.snapshot().items[0]).toMatchObject({ kind: "reasoning", streaming: true });
  m.apply(ev("tool.started", { name: "bash", title: "head docs/DIRECTION.md", kind: "command", input: {} }, { item_id: "t1" }));
  let v = m.snapshot();
  expect(v.running).toBe(true);
  expect(v.items[0]).toMatchObject({ kind: "reasoning", streaming: false, text: "Load the tool first." });
  // A late delta for the same thought adds its text without animating it again.
  m.apply(ev("reasoning.delta", { text: " Then ask." }, { item_id: "r1" }));
  v = m.snapshot();
  expect(v.items[0]).toMatchObject({ streaming: false, text: "Load the tool first. Then ask." });
  m.apply(ev("reasoning.delta", { text: "Now the round." }, { item_id: "r2" }));
  expect(m.snapshot().items.map((i) => i.kind === "reasoning" && i.streaming)).toEqual([false, false, true]);
});

test("compaction, routing and retries become their own lines", () => {
  cursor = 0;
  const m = new SessionModel();
  for (const e of [
    ev("turn.started", { engine: "caveman" }),
    ev("model.routed", { model: "anthropic/claude-opus-5-5" }, { item_id: "r1" }),
    ev("model.routed", { model: "anthropic/claude-opus-5-5" }, { item_id: "r2" }),
    ev("compaction.started", {}, { item_id: "c1" }),
  ]) m.apply(e);
  let v = m.snapshot();
  // Same model again: no second line.
  expect(v.items.map((i) => i.kind)).toEqual(["route", "compaction"]);
  expect(v.items[1]).toMatchObject({ status: "running", before: null });

  for (const e of [
    ev("compaction.done", { status: "completed", before_tokens: 182000, after_tokens: 31000 }, { item_id: "c1" }),
    ev("compaction.done", { status: "completed" }, { item_id: "c2" }),
    ev("error", { reason: "engine_unavailable", message: "Overloaded", retry: { attempt: 1, max_attempts: 5 } }, { item_id: "e1" }),
    ev("error", { reason: "engine_unavailable", message: "Overloaded", retry: { attempt: 2, max_attempts: 5 } }, { item_id: "e1" }),
    ev("model.routed", { model: "anthropic/claude-sonnet-5-5" }, { item_id: "r3" }),
  ]) m.apply(e);
  v = m.snapshot();
  expect(v.items.map((i) => i.kind)).toEqual(["route", "compaction", "compaction", "retry", "route"]);
  expect(v.items[1]).toMatchObject({ status: "done", before: 182000, after: 31000 });
  expect(v.items[2]).toMatchObject({ status: "done", before: null });
  expect(v.items[3]).toMatchObject({ kind: "retry", attempt: 2, max: 5 });
  expect(v.items[4]).toMatchObject({ model: "anthropic/claude-sonnet-5-5" });

  // A turn that stops mid-compaction does not leave it running.
  m.apply(ev("compaction.started", {}, { item_id: "c3" }));
  m.apply(ev("turn.done", { status: "interrupted" }));
  expect(m.snapshot().items.find((i) => i.id === "c3")).toMatchObject({ status: "failed" });
});

test("a route line shows when the model changes from the last surviving route of its thread or builder", () => {
  cursor = 0;
  const m = new SessionModel();
  const routes = () => {
    const v = m.snapshot();
    const sub = v.items.find((i) => i.kind === "subagent");
    return { root: v.items.filter((i) => i.kind === "route").length, builder: sub?.kind === "subagent" ? sub.items.filter((i) => i.kind === "route").length : 0 };
  };
  m.apply(ev("turn.started", { engine: "caveman" }));
  m.apply(ev("model.routed", { model: "anthropic/claude-opus-5-5" }, { item_id: "r1" }));
  m.apply(ev("turn.done", { status: "completed" }));
  const done = cursor;
  m.apply(ev("turn.started", { engine: "caveman" }));
  m.apply(ev("model.routed", { model: "anthropic/claude-sonnet-5-5" }, { item_id: "r2" }));
  m.apply(ev("subagent.started", { title: "Review" }, { item_id: "sa1" }));
  m.apply(ev("model.routed", { model: "anthropic/claude-opus-5-5" }, { item_id: "r3", parent_item_id: "sa1" }));
  expect(routes()).toEqual({ root: 2, builder: 1 });
  // The builder's route does not count for the parent: sonnet again is no change there.
  m.apply(ev("model.routed", { model: "anthropic/claude-sonnet-5-5" }, { item_id: "r4" }));
  expect(routes().root).toBe(2);
  // Restored to the first turn: the sonnet route is gone, so routing to sonnet shows again.
  m.apply(ev("session.restored", { at: done }));
  m.apply(ev("model.routed", { model: "anthropic/claude-sonnet-5-5" }, { item_id: "r5" }));
  expect(routes().root).toBe(2);
});

test("grill: a round keeps every question, its body and pick; one answer per question folds it; grill.finished and the mode", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent", mode: "grill" }));
  expect(m.snapshot().mode).toBe("grill");
  const options = [
    { id: "pg", label: "Postgres", description: "One table" },
    { id: "redis", label: "Redis" },
  ];
  m.apply(
    ev(
      "ask.user",
      {
        kind: "question",
        round: 2,
        questions: [
          { id: "store", prompt: "Where do sessions live?", detail: "**Today** it is stateless.", options, recommended: "pg", multi_select: false, allow_text: true },
          { id: "ttl", prompt: "How long?", options: [{ id: "30d", label: "30 days" }], recommended: "nope", multi_select: false, allow_text: true },
          { id: "where", prompt: "Which clients?", options: [{ id: "web", label: "Web" }, { id: "mac", label: "Mac" }], multi_select: true, allow_text: true },
        ],
      },
      { item_id: "k1" },
    ),
  );
  const asked = m.snapshot().pendingAsk!;
  expect(asked).toMatchObject({ round: 2, answers: null, resolution: null });
  expect(asked.questions).toEqual([
    { id: "store", prompt: "Where do sessions live?", detail: "**Today** it is stateless.", options: [{ id: "pg", label: "Postgres", description: "One table" }, { id: "redis", label: "Redis", description: null }], recommended: "pg", multiSelect: false },
    // A recommendation that names no option is dropped.
    { id: "ttl", prompt: "How long?", detail: null, options: [{ id: "30d", label: "30 days", description: null }], recommended: null, multiSelect: false },
    { id: "where", prompt: "Which clients?", detail: null, options: [{ id: "web", label: "Web", description: null }, { id: "mac", label: "Mac", description: null }], recommended: null, multiSelect: true },
  ]);

  m.apply(
    ev("ask.resolved", { outcome: "answered", response: { kind: "question", answers: [{ question_id: "store", option_ids: ["pg"] }, { question_id: "ttl", option_ids: [], text: "7 days" }, { question_id: "where", option_ids: ["web", "mac"], text: "CLI" }] } }, { item_id: "k1" }),
  );
  const answered = m.snapshot().items.at(-1)!;
  expect(answered.kind === "ask" && [answered.resolution, answered.answers]).toEqual([
    "Postgres; 7 days; Web, Mac, CLI",
    [
      { questionId: "store", optionIds: ["pg"], text: null },
      { questionId: "ttl", optionIds: [], text: "7 days" },
      { questionId: "where", optionIds: ["web", "mac"], text: "CLI" },
    ],
  ]);

  m.apply(ev("grill.finished" as SessionEvent["type"], { doc_path: "docs/", summary: "Postgres, 7 days." }, { item_id: "g1" }));
  expect(m.snapshot().items.at(-1)).toEqual({ kind: "grill_finished", id: "g1", docPath: "docs/", summary: "Postgres, 7 days." });

  // Approvals are no round; a turn that names no mode keeps the last one.
  m.apply(ev("ask.user", { kind: "approval", title: "Run it?", options: [{ id: "accept", label: "Allow", decision: "allow" }] }, { item_id: "k2" }));
  expect(m.snapshot().pendingAsk).toMatchObject({ round: null, questions: [] });
  // An engine that repeats its title as the detail (the Caveman engine's "Run sleep 120") shows the line once.
  m.apply(ev("ask.user", { kind: "approval", title: "Run ls", detail: "Run ls", options: [{ id: "accept", label: "Allow", decision: "allow" }] }, { item_id: "k3" }));
  expect(m.snapshot().pendingAsk).toMatchObject({ prompt: "Run ls" });
  // Full access and it asked anyway: the card says why, and why at all; a reason that only repeats the title is dropped.
  m.apply(ev("ask.user", { kind: "approval", title: "Run rm", reason: "Dangerous rm on a variable path", full_access_override: "engine_check", options: [] }, { item_id: "k4" }));
  expect(m.snapshot().pendingAsk).toMatchObject({ reason: "Dangerous rm on a variable path", fullAccessOverride: "engine_check" });
  m.apply(ev("ask.user", { kind: "approval", title: "Run rm", reason: "Run rm", options: [] }, { item_id: "k5" }));
  expect(m.snapshot().pendingAsk).not.toHaveProperty("reason");
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  expect(m.snapshot().mode).toBe("grill");
  m.apply(ev("turn.started", { engine: "claude-agent", mode: "default" }));
  expect(m.snapshot().mode).toBe("default");
});

test("the mode comes from the attach reply; the backlog replayed after it does not override it, live turns do", () => {
  // A reload while Build it is queued behind a grill turn: the session is default, the backlog's last turn.started says grill.
  cursor = 0;
  const m = new SessionModel();
  m.setMode("default", 3);
  m.apply(ev("turn.started", { engine: "claude-agent", mode: "grill" })); // 1
  m.apply(ev("message.done", { role: "user", text: "sessions" }, { item_id: "u1" })); // 2
  m.apply(ev("turn.started", { engine: "claude-agent", mode: "grill" })); // 3: still backlog
  expect(m.snapshot().mode).toBe("default");
  m.apply(ev("turn.started", { engine: "claude-agent", mode: "grill" })); // 4: live
  expect(m.snapshot().mode).toBe("grill");

  // Replayed before the reply lands: the reply still wins.
  cursor = 0;
  const late = new SessionModel();
  late.apply(ev("turn.started", { engine: "claude-agent", mode: "grill" }));
  late.setMode("default", 1);
  expect(late.snapshot().mode).toBe("default");
  // A local set after turn.submit keeps the head.
  late.setMode("grill");
  late.apply(ev("turn.started", { engine: "claude-agent", mode: "default" })); // 2: live
  expect(late.snapshot().mode).toBe("default");
});

test("todos are one list per id, updated where it first showed", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("plan.updated", { kind: "todos", steps: [{ text: "Jitter", status: "in_progress" }] }, { item_id: "p1" }));
  m.apply(ev("message.done", { role: "assistant", text: "on it" }, { item_id: "a1" }));
  m.apply(ev("plan.updated", { kind: "todos", steps: [{ text: "Jitter", status: "completed" }] }, { item_id: "p1" }));
  const v = m.snapshot();
  expect(v.items.map((i) => i.kind)).toEqual(["plan", "assistant"]);
  expect(v.items[0]).toEqual({ kind: "plan", id: "p1:plan", steps: [{ text: "Jitter", status: "completed" }] });
});

test("a stored proposed plan (plan mode, before grill mode) shows nothing and keeps the todos", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("plan.updated", { kind: "todos", steps: [{ text: "Jitter", status: "in_progress" }] }, { item_id: "p1" }));
  m.apply(ev("plan.updated", { kind: "proposed", steps: [], markdown: "# Plan\n\n1. Jitter" }, { item_id: "p2" }));
  const v = m.snapshot();
  expect(v.items).toEqual([{ kind: "plan", id: "p1:plan", steps: [{ text: "Jitter", status: "in_progress" }] }]);
  expect(v.plan).toEqual([{ text: "Jitter", status: "in_progress" }]);
});

test("the Caveman engine's reads and kills of a running command name what they did and the command", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("tool.started", { name: "command", title: "sleep 20 && echo finished", kind: "command", input: { command: "sleep 20 && echo finished" } }, { item_id: "t1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "t1" }));
  m.apply(ev("tool.started", { name: "bash", title: "sleep 20 && echo finished", kind: "other", input: { action: "read", sessionId: "1", waitMs: 3000 } }, { item_id: "t2" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "t2" }));
  m.apply(ev("tool.started", { name: "bash", title: "sleep 20 && echo finished", kind: "other", input: { action: "kill", sessionId: "1" } }, { item_id: "t3" }));
  const rows = m.snapshot().items.map((i) => (i.kind === "tool" ? `${i.verb} ${i.subject}` : i.kind));
  expect(rows).toEqual(["Waited 20s", "Checked sleep 20 && echo finished", "Stopping sleep 20 && echo finished"]);
});

test("Claude's Read, titled with its own name, says the path once; an edit or a command keeps its title", () => {
  cursor = 0;
  const m = new SessionModel();
  const file = "/Users/me/state/worktrees/repo/chat/retry.ts";
  m.apply(ev("tool.started", { name: "Read", title: `Read ${file}`, kind: "read", input: { file_path: file } }, { item_id: "t1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "t1" }));
  m.apply(ev("tool.started", { name: "edit", title: file, kind: "edit", input: { path: file } }, { item_id: "t2" }));
  m.apply(ev("tool.started", { name: "command", title: "command -v node", kind: "command", input: { command: "command -v node" } }, { item_id: "t3" }));
  m.apply(ev("tool.started", { name: "Grep", title: "Grep", kind: "search", input: { pattern: "retry\\(" } }, { item_id: "t4" }));
  const rows = m.snapshot().items.map((i) => (i.kind === "tool" ? `${i.verb} ${i.subject}` : i.kind));
  expect(rows).toEqual([`Read ${file}`, `Editing ${file}`, "Running command -v node", "Searching for retry\\("]);
});

test("a web search says its query and opens to its sources; a page read says its site and opens to the page", () => {
  cursor = 0;
  const m = new SessionModel();
  const page = "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/tickets";
  m.apply(ev("tool.started", { name: "web_search", title: "FIFA World Cup 2026 ticket pricing", kind: "web", input: { queries: ["FIFA World Cup 2026 ticket pricing"] } }, { item_id: "w1" }));
  m.apply(ev("tool.started", { name: "web_fetch", title: "fifa.com", kind: "web", input: { url: page } }, { item_id: "w2" }));
  const line = (i: TranscriptItem) => (i.kind === "tool" ? [`${i.verb} ${i.subject}`, i.icon, i.sources] : i.kind);
  expect(m.snapshot().items.map(line)).toEqual([
    ["Searching the web for FIFA World Cup 2026 ticket pricing", "web", []],
    ["Fetching fifa.com", "web", [{ title: null, url: page }]],
  ]);
  m.apply(
    ev(
      "tool.done",
      {
        status: "completed",
        result: [
          { title: "Tickets - FIFA World Cup 2026™", url: page },
          { url: "https://www.aljazeera.com/sports/2026/5/6/fifa-chief-infantino-defends-world-cup-ticket-prices" },
          { title: "dup", url: page },
          { title: "no", url: "javascript:alert(1)" },
        ],
      },
      { item_id: "w1" },
    ),
  );
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "w2" }));
  expect(m.snapshot().items.map(line)).toEqual([
    [
      "Searched the web for FIFA World Cup 2026 ticket pricing",
      "web",
      [
        { title: "Tickets - FIFA World Cup 2026™", url: page },
        { title: null, url: "https://www.aljazeera.com/sports/2026/5/6/fifa-chief-infantino-defends-world-cup-ticket-prices" },
      ],
    ],
    ["Fetched fifa.com", "web", [{ title: null, url: page }]],
  ]);
});

test("a page read takes the title and address its engine reports; a session from before web_fetch reads its pages too", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("tool.started", { name: "web_fetch", title: "docs.python.org", kind: "web", input: { url: "https://docs.python.org/3/library/asyncio.html" } }, { item_id: "f1" }));
  m.apply(ev("tool.done", { status: "completed", result: [{ title: "asyncio", url: "https://docs.python.org/3/library/asyncio.html" }, { url: "https://docs.python.org/3/" }] }, { item_id: "f1" }));
  // Before the runtime told them apart, a WebFetch was a web_search titled by its address, its result the page's text.
  m.apply(ev("tool.started", { name: "web_search", title: "https://example.com/", kind: "web", input: { queries: ["https://example.com/"] } }, { item_id: "f2" }));
  m.apply(ev("tool.done", { status: "completed", result: [{ url: "https://example.com/", snippet: "Example Domain" }] }, { item_id: "f2" }));
  // A search that never said its query (an ACP agent's, titled by its label) searched the web.
  m.apply(ev("tool.started", { name: "web_search", title: "Web search", kind: "web", input: {} }, { item_id: "s1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "s1" }));
  const rows = m.snapshot().items.map((i) => (i.kind === "tool" ? [i.verb, i.subject, i.icon, i.sources] : i.kind));
  expect(rows).toEqual([
    ["Fetched", "docs.python.org", "web", [{ title: "asyncio", url: "https://docs.python.org/3/library/asyncio.html" }]],
    ["Fetched", "example.com", "web", [{ title: null, url: "https://example.com/" }]],
    ["Searched the web", "", "web", []],
  ]);
});

test("a steered or queued message keeps how it was sent, for its Steered / From queue label", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "fix it" }, { item_id: "u1" }));
  m.apply(ev("message.done", { role: "user", text: "and the docs", delivery: "steer" }, { item_id: "u2" }));
  m.apply(ev("message.done", { role: "user", text: "then ship", delivery: "queue" }, { item_id: "u3" }));
  expect(m.snapshot().items.map((i) => (i.kind === "user" ? i.delivery : i.kind))).toEqual(["message", "steer", "queue"]);
});

test("usage adds to the session's tokens and never carries a price into the view", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("usage", { model: "m", input_tokens: 1000, output_tokens: 200, cache_read_tokens: 3000, cache_write_tokens: 50, cost: { usd: 0.42, basis: "list_price" } }));
  m.apply(ev("usage", { model: "m", input_tokens: 10, output_tokens: 5, cache_read_tokens: 0, cache_write_tokens: 0, cost: null }));
  const v = m.snapshot();
  expect(v.tokens).toBe(4265);
  expect(v.items).toEqual([]);
  expect(JSON.stringify(v)).not.toContain("0.42");
});

test("a native subagent's steps and result file under its row, and an end the engine corrects replaces what showed", () => {
  // The order the runtime journals Claude's Agent tool in (the recorded `subagent` fixture): rows, steps, a summary end, the full result.
  cursor = 0;
  const m = new SessionModel();
  const sa = "turn-item:task%3Aa1%3Asubagent";
  const result = "message:task%3Aa1%3Aresult";
  for (const e of [
    ev("message.done", { role: "user", text: "Spawn a subagent to read package.json" }, { item_id: "u1" }),
    ev("turn.started", { engine: "claude-agent" }),
    ev("subagent.started", { title: "Read package.json", agent: "claude-agent" }, { item_id: sa, turn_id: "r1" }),
    ev("tool.started", { name: "Read", title: "Read package.json", kind: "read", input: { path: "package.json" } }, { item_id: "toolu_1", parent_item_id: sa, turn_id: "r1" }),
    ev("subagent.started", { title: "Deeper look", agent: "claude-agent" }, { item_id: "sa2", parent_item_id: sa, turn_id: "r1" }),
    ev("message.delta", { text: "Nested " }, { item_id: "m2", parent_item_id: "sa2", turn_id: "r1" }),
    ev("message.done", { role: "assistant", text: "Nested ok" }, { item_id: "m2", parent_item_id: "sa2", turn_id: "r1" }),
    ev("subagent.done", { status: "completed", summary: "Nested ok" }, { item_id: "sa2", parent_item_id: sa, turn_id: "r1" }),
    ev("tool.done", { status: "completed" }, { item_id: "toolu_1", parent_item_id: sa, turn_id: "r1" }),
    ev("subagent.done", { status: "completed", summary: "Read package.json" }, { item_id: sa, turn_id: "r1" }),
    ev("message.done", { role: "assistant", text: "Read package.json" }, { item_id: result, parent_item_id: sa, turn_id: "r1" }),
    ev("subagent.done", { status: "completed", summary: "Here is package.json: {}" }, { item_id: sa, turn_id: "r1" }),
    ev("message.done", { role: "assistant", text: "Here is package.json: {}" }, { item_id: result, parent_item_id: sa, turn_id: "r1" }),
    ev("message.done", { role: "assistant", text: "Both read." }, { item_id: "a1", turn_id: "r1" }),
    ev("turn.done", { status: "completed" }),
  ]) m.apply(e);
  const v = m.snapshot();
  expect(v.items.map((i) => i.kind)).toEqual(["user", "subagent", "assistant", "turn_end"]);
  const sub = v.items[1]!;
  if (sub.kind !== "subagent") throw new Error("no subagent row");
  expect([sub.status, sub.summary]).toEqual(["done", "Here is package.json: {}"]);
  expect(sub.items.map((i) => (i.kind === "assistant" ? `${i.kind}:${i.text}` : i.kind))).toEqual(["tool", "subagent", "assistant:Here is package.json: {}"]);
  const nested = sub.items[1]!;
  expect(nested.kind === "subagent" && nested.items.map((i) => i.kind === "assistant" && i.text)).toEqual(["Nested ok"]);
});

test("the runtime's own tools read in words in every engine's spelling, never as mcp__caveman-code__… names", () => {
  cursor = 0;
  const m = new SessionModel();
  // The Caveman engine's spelling (non-word characters become _), Claude's, and Codex's.
  m.apply(ev("tool.started", { name: "mcp__caveman_code__delegate_task", title: "mcp__caveman_code__delegate_task", kind: "mcp", input: { task: "CHILD" } }, { item_id: "d1" }));
  m.apply(ev("tool.started", { name: "mcp__caveman-code__thread_send", title: "mcp__caveman-code__thread_send", kind: "mcp", input: {} }, { item_id: "d2" }));
  m.apply(ev("tool.started", { name: "caveman-code.thread_wait", title: "caveman-code.thread_wait", kind: "mcp", input: {} }, { item_id: "d3" }));
  let tools = m.snapshot().items.filter((i) => i.kind === "tool");
  expect(tools.map((t) => t.kind === "tool" && [t.verb, t.subject])).toEqual([["Delegating a child task", ""], ["Sending to a thread", ""], ["Waiting for a thread", ""]]);
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "d1" }));
  m.apply(ev("tool.done", { status: "failed", error: "limit_reached" }, { item_id: "d2" }));
  tools = m.snapshot().items.filter((i) => i.kind === "tool");
  expect(tools.slice(0, 2).map((t) => t.kind === "tool" && [t.verb, t.status])).toEqual([["Delegated a child task", "done"], ["Send to a thread", "failed"]]);
  // Legacy stored calls still read in words after the server rename.
  m.apply(ev("tool.started", { name: "mcp__t3-code__t3_thread_send", title: "mcp__t3-code__t3_thread_send", kind: "mcp", input: {} }, { item_id: "legacy" }));
  const legacy = m.snapshot().items.at(-1)!;
  expect(legacy.kind === "tool" && legacy.verb).toBe("Sending to a thread");
  // An action tool reads as its action; a transcript from before the merge still reads the same.
  m.apply(ev("tool.started", { name: "mcp__caveman-code__preview_act", title: "mcp__caveman-code__preview_act", kind: "mcp", input: { action: "click", locator: "text=Send" } }, { item_id: "a1" }));
  m.apply(ev("tool.started", { name: "mcp__caveman-code__preview_click", title: "mcp__caveman-code__preview_click", kind: "mcp", input: { locator: "text=Send" } }, { item_id: "a2" }));
  m.apply(ev("tool.started", { name: "caveman-code.queue", title: "caveman-code.queue", kind: "mcp", input: { action: "list" } }, { item_id: "a3" }));
  m.apply(ev("tool.started", { name: "caveman-code.queue_list", title: "caveman-code.queue_list", kind: "mcp", input: {} }, { item_id: "a4" }));
  const acts = m.snapshot().items.filter((i) => i.kind === "tool").slice(-4);
  expect(acts.map((t) => t.kind === "tool" && t.verb)).toEqual([
    "Clicking in the preview browser",
    "Clicking in the preview browser",
    "Listing queued messages",
    "Listing queued messages",
  ]);
  // Another server's tool keeps its own name.
  m.apply(ev("tool.started", { name: "mcp__github__create_issue", title: "mcp__github__create_issue", kind: "mcp", input: {} }, { item_id: "g1" }));
  const other = m.snapshot().items.at(-1)!;
  expect(other.kind === "tool" && other.verb).toBe("Calling");
});

test("a tool on other threads names them, opens to what it said there, and its run's summary says it in words", () => {
  cursor = 0;
  const m = new SessionModel();
  const tools = () => m.snapshot().items.filter((i): i is ToolItem => i.kind === "tool");
  const checkout = { workspace_id: "w-checkout", title: "Fix checkout" };
  m.apply(ev("tool.started", { name: "mcp__caveman-code__thread_send", title: "mcp__caveman-code__thread_send", kind: "mcp", input: { threadId: "caveman:b", message: "Land **it**" }, threads: [checkout] }, { item_id: "s1" }));
  expect(tools()[0]).toMatchObject({ verb: "Sending to Fix checkout", subject: "", icon: "agent", threads: [{ thread: checkout, text: "Land **it**" }] });
  m.apply(ev("tool.done", { status: "completed", result: { threadId: "caveman:b" } }, { item_id: "s1" }));
  expect(tools()[0]).toMatchObject({ verb: "Sent to Fix checkout", status: "done", threads: [{ thread: checkout }], parts: [{ action: "caveman", subject: "Sent to Fix checkout" }] });
  // A question, and an answer to one.
  m.apply(ev("tool.started", { name: "caveman-code.thread_send", title: "", kind: "mcp", input: { threadId: "caveman:b", message: "Which?", expectReply: true }, threads: [checkout] }, { item_id: "s2" }));
  m.apply(ev("tool.started", { name: "caveman-code.thread_send", title: "", kind: "mcp", input: { threadId: "caveman:b", message: "This", inReplyTo: "m1" }, threads: [checkout] }, { item_id: "s3" }));
  expect(tools().slice(1).map((t) => t.verb)).toEqual(["Asking Fix checkout", "Replying to Fix checkout"]);
  // A thread the runtime did not know reads as before, and still opens to its message.
  m.apply(ev("tool.started", { name: "mcp__caveman-code__thread_send", title: "", kind: "mcp", input: { threadId: "gone", message: "Hello" } }, { item_id: "s4" }));
  m.apply(ev("tool.done", { status: "failed", error: "thread_not_found" }, { item_id: "s4" }));
  expect(tools()[3]).toMatchObject({ verb: "Send to a thread", status: "failed", threads: [{ thread: null, text: "Hello" }] });
  // Its run's summary never says it was sent.
  expect(summarizeParts(tools()[3]!.parts)).toBe("Tried to send to a thread");
  // A read says nothing there: it names the thread, which its line opens.
  m.apply(ev("tool.started", { name: "mcp__caveman-code__thread_read", title: "", kind: "mcp", input: { threadId: "caveman:b" }, threads: [checkout] }, { item_id: "r1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "r1" }));
  expect(tools()[4]).toMatchObject({ verb: "Read Fix checkout", threads: [{ thread: checkout, text: null }] });
  expect(summarizeParts(tools().flatMap((t) => t.parts))).toBe("Used 5 Caveman Code tools");
  expect(summarizeParts([...tools()[0]!.parts, ...tools()[4]!.parts, { action: "read", subject: "a.ts" }])).toBe("Sent to Fix checkout, read Fix checkout, read a.ts");
});

test("a new thread goes by its input's title until the runtime names what it made; create_threads pairs each with its prompt", () => {
  cursor = 0;
  const m = new SessionModel();
  const tools = () => m.snapshot().items.filter((i): i is ToolItem => i.kind === "tool");
  m.apply(ev("tool.started", { name: "mcp__caveman-code__thread_launch", title: "", kind: "mcp", input: { title: "Fix login", message: "Go" } }, { item_id: "l1" }));
  expect(tools()[0]).toMatchObject({ verb: "Starting Fix login", threads: [{ thread: { title: "Fix login" }, text: "Go" }] });
  m.apply(ev("tool.done", { status: "completed", threads: [{ workspace_id: "w-a", title: "Fix login" }] }, { item_id: "l1" }));
  expect(tools()[0]).toMatchObject({ verb: "Started Fix login", threads: [{ thread: { workspace_id: "w-a", title: "Fix login" }, text: "Go" }] });
  m.apply(ev("tool.started", { name: "mcp__caveman-code__create_threads", title: "", kind: "mcp", input: { threads: [{ prompt: "A" }, { prompt: "B" }, { prompt: "C" }] } }, { item_id: "c1" }));
  expect(tools()[1]).toMatchObject({ verb: "Creating threads", threads: [{ thread: null, text: "A" }, { thread: null, text: "B" }, { thread: null, text: "C" }] });
  const made = [{ workspace_id: "w1", title: "One" }, { workspace_id: "w2", title: "Two" }, { workspace_id: "w3", title: "Three" }];
  m.apply(ev("tool.done", { status: "completed", threads: made }, { item_id: "c1" }));
  expect(tools()[1]).toMatchObject({ verb: "Started 3 threads", threads: made.map((thread, i) => ({ thread, text: ["A", "B", "C"][i] })) });
});

test("a delegate_task row gives way to its agent's card once both are there, in either order; one that failed stays", () => {
  cursor = 0;
  const m = new SessionModel();
  const kinds = () => m.snapshot().items.map((i) => (i.kind === "tool" ? `tool:${i.verb}` : i.kind));
  const delegate = (id: string, task: string, cardFirst: boolean) => {
    m.apply(ev("tool.started", { name: "mcp__caveman-code__delegate_task", title: "", kind: "mcp", input: { title: "Review", task: "Review it" } }, { item_id: id }));
    const card = () => m.apply(ev("subagent.started", { title: "Review", workspace_id: `w-${task}`, task_id: task }, { item_id: `card-${task}` }));
    if (cardFirst) card();
    m.apply(ev("tool.done", { status: "completed", result: { taskId: task } }, { item_id: id }));
    if (!cardFirst) card();
  };
  m.apply(ev("tool.started", { name: "mcp__caveman-code__delegate_task", title: "", kind: "mcp", input: { title: "Review", task: "Review it" } }, { item_id: "d0" }));
  expect(kinds()).toEqual(["tool:Delegating Review"]);
  m.apply(ev("tool.done", { status: "failed", error: "limit_reached" }, { item_id: "d0" }));
  delegate("d1", "node:t1", true);
  delegate("d2", "node:t2", false);
  expect(kinds()).toEqual(["tool:Delegate Review", "subagent", "subagent"]);
  // A row settled before its card: the card stands where the row stood, ahead of what came after it.
  delegate("d3", "node:t3", false);
  m.apply(ev("message.done", { role: "assistant", text: "Both are on it." }, { item_id: "a1" }));
  m.apply(ev("tool.started", { name: "mcp__caveman-code__delegate_task", title: "", kind: "mcp", input: { title: "Docs", task: "Write it" } }, { item_id: "d4" }));
  // Claude Agent keeps the MCP envelope: the task id is inside its text block.
  m.apply(ev("tool.done", { status: "completed", result: { content: [{ type: "text", text: JSON.stringify({ taskId: "node:t4" }) }] } }, { item_id: "d4" }));
  m.apply(ev("tool.started", { name: "Read", title: "Read a.ts", kind: "read", input: {} }, { item_id: "r1" }));
  m.apply(ev("reasoning.delta", { text: "Now the tests" }, { item_id: "th1" }));
  m.apply(ev("subagent.started", { title: "Docs", workspace_id: "w-t4", task_id: "node:t4" }, { item_id: "card-node:t4" }));
  expect(kinds().slice(3)).toEqual(["subagent", "assistant", "subagent", "tool:Reading", "reasoning"]);
  // A thought streaming at the end goes on: the card landed before it, not after.
  const thought = m.snapshot().items.at(-1)!;
  expect(thought.kind === "reasoning" && thought.streaming).toBe(true);
  const failed = m.snapshot().items[0]!;
  expect(failed.kind === "tool" && failed.threads).toEqual([{ thread: { title: "Review" }, text: "Review it" }]);
});

test("each finished turn keeps the checkpoint it ended at, in either order; a restore drops the later ones", () => {
  cursor = 0;
  const m = new SessionModel();
  const turn = (id: string, checkpointFirst: boolean) => {
    m.apply(ev("message.done", { role: "user", text: `do ${id}` }, { item_id: `u-${id}` }));
    m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: id }));
    const checkpoint = () => m.apply(ev("checkpoint.created", { checkpoint_id: `checkpoint:${id}`, ref: `refs/t3/${id}` }, { turn_id: id }));
    if (checkpointFirst) checkpoint();
    m.apply(ev("turn.done", { status: "completed" }, { turn_id: id }));
    if (!checkpointFirst) checkpoint();
    return cursor;
  };
  // The runtime reports a checkpoint just before its turn.done (checkpoint.captured); a late one still lands.
  // turn() returns the cursor of its last event: here the turn.done, which a restore names.
  const firstDone = turn("t1", true);
  turn("t2", false);
  let v = m.snapshot();
  const ends = v.items.filter((i) => i.kind === "turn_end");
  expect(ends.map((i) => i.kind === "turn_end" && i.checkpoint)).toEqual(["checkpoint:t1", "checkpoint:t2"]);
  expect(v.checkpoints).toEqual([
    { id: "checkpoint:t1", own: true },
    { id: "checkpoint:t2", own: true },
  ]);
  // Restored to the first turn: the second turn's checkpoint goes with it.
  m.apply(ev("session.restored", { at: firstDone }));
  v = m.snapshot();
  expect(v.checkpoints.map((c) => c.id)).toEqual(["checkpoint:t1"]);
});

test("a turn's end carries the files it changed, in either order, and closes its card once they are kept or undone", () => {
  cursor = 0;
  const m = new SessionModel();
  const files = [{ path: "pilot.md", additions: 45, deletions: 0 }];
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }));
  m.apply(ev("checkpoint.created", { checkpoint_id: "checkpoint:t1", ref: "refs/t3/t1", files }, { turn_id: "t1" }));
  m.apply(ev("turn.done", { status: "completed" }, { turn_id: "t1" }));
  // A checkpoint that lands after its turn.done brings its files too.
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t2" }));
  m.apply(ev("turn.done", { status: "completed" }, { turn_id: "t2" }));
  m.apply(ev("checkpoint.created", { checkpoint_id: "checkpoint:t2", ref: "refs/t3/t2", files: [] }, { turn_id: "t2" }));
  const ends = () => m.snapshot().items.flatMap((i) => (i.kind === "turn_end" ? [i] : []));
  expect(ends().map((e) => [e.checkpoint, e.files, e.resolved])).toEqual([
    ["checkpoint:t1", files, undefined],
    ["checkpoint:t2", [], undefined],
  ]);
  m.apply(ev("checkpoint.resolved", { checkpoint_id: "checkpoint:t1", resolution: "undone", files: ["pilot.md"] }, { turn_id: "t1" }));
  expect(ends()[0]!.resolved).toBe("undone");
  // An older checkpoint with no files says nothing about them (no card, not an empty one).
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t3" }));
  m.apply(ev("checkpoint.created", { checkpoint_id: "checkpoint:t3", ref: "refs/t3/t3" }, { turn_id: "t3" }));
  m.apply(ev("turn.done", { status: "completed" }, { turn_id: "t3" }));
  expect(ends()[2]).not.toHaveProperty("files");
});

test("a huge turn's end carries the files the runtime listed and the total over all of them", () => {
  cursor = 0;
  const m = new SessionModel();
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `vendor/${i}.ts`, additions: 2, deletions: 1 }));
  const files_total = { count: 250, additions: 500, deletions: 250 };
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }));
  m.apply(ev("checkpoint.created", { checkpoint_id: "checkpoint:t1", ref: "refs/t3/t1", files, files_total }, { turn_id: "t1" }));
  m.apply(ev("turn.done", { status: "completed" }, { turn_id: "t1" }));
  const end = m.snapshot().items.find((i) => i.kind === "turn_end");
  expect(end).toMatchObject({ checkpoint: "checkpoint:t1", filesTotal: files_total });
  expect(end?.kind === "turn_end" && end.files).toHaveLength(200);
});

test("a fork's copied checkpoints are not its own", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("checkpoint.created", { checkpoint_id: "checkpoint:src", ref: "refs/t3/src" }, { turn_id: "src" }));
  m.apply(ev("turn.done", { status: "completed" }, { turn_id: "src" }));
  m.setForkedAt(cursor);
  m.apply(ev("checkpoint.created", { checkpoint_id: "checkpoint:own", ref: "refs/t3/own" }, { turn_id: "own" }));
  expect(m.snapshot().checkpoints).toEqual([
    { id: "checkpoint:src", own: false },
    { id: "checkpoint:own", own: true },
  ]);
});

test("a memory notification is a memory row carrying the notes' ids, never a plain notice", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "Remember: tests run in UTC." }, { item_id: "u1" }));
  m.apply(ev("turn.started", { engine: "codex" }));
  m.apply(ev("notification", { level: "info", title: "Remembered · Tests in UTC", memory: { kind: "remembered", notes: [{ id: "n1", name: "Tests in UTC" }] } }));
  m.apply(ev("notification", { level: "info", title: "Compression off: proxy unavailable" }));
  const items = m.snapshot().items;
  expect(items.map((i) => i.kind)).toEqual(["user", "memory", "notice"]);
  expect(items[1]).toMatchObject({ kind: "memory", action: "remembered", notes: [{ id: "n1", name: "Tests in UTC" }], at });
});

test("a Chief's moment is a moment row carrying its notification's line, never a plain notice", () => {
  cursor = 0;
  const m = new SessionModel();
  const moment = { kind: "needs_you" as const, workspace_id: "ws-1", item_id: "ci-1", text: "Which port?", ask: { id: "ask-1", kind: "question" as const } };
  m.apply(ev("notification", { level: "info", title: "Fix the login redirect needs you", body: "Which port?", moment }, { item_id: "mo-1" }));
  expect(m.snapshot().items).toEqual([{ kind: "moment", id: "mo-1", at, moment, text: "Fix the login redirect needs you\nWhich port?" }]);
});

const reaction = (message: string, emoji: "👍" | "👀" | "✅" | "❤️") =>
  ev("notification", { level: "info", title: `Reacted ${emoji}`, moment: { kind: "reaction", message_id: message, emoji } });

test("a Chief's reaction is its message's badge, never a transcript item", () => {
  cursor = 0;
  const m = new SessionModel();
  expect(m.snapshot().reactions.size).toBe(0);
  m.apply(ev("message.done", { role: "user", text: "Queue the docs pass" }, { item_id: "user-1" }));
  m.apply(reaction("user-1", "👍"));
  const view = m.snapshot();
  expect(view.items.map((i) => i.id)).toEqual(["user-1"]);
  expect([...view.reactions]).toEqual([["user-1", "👍"]]);
  // One that arrives before its message (or for one this view never held) still waits under that message's id.
  m.apply(reaction("user-2", "👀"));
  expect(m.snapshot().items.map((i) => i.id)).toEqual(["user-1"]);
  expect(m.snapshot().reactions.get("user-2")).toBe("👀");
});

test("a later reaction on the same message takes the earlier one's place; the same one again changes nothing", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "Fix the flaky test" }, { item_id: "user-1" }));
  m.apply(ev("message.done", { role: "user", text: "And the docs" }, { item_id: "user-2" }));
  m.apply(reaction("user-1", "👀"));
  m.apply(reaction("user-2", "👍"));
  m.apply(reaction("user-1", "✅"));
  const view = m.snapshot();
  expect(Object.fromEntries(view.reactions)).toEqual({ "user-1": "✅", "user-2": "👍" });
  expect(view.items.map((i) => i.kind)).toEqual(["user", "user"]);
  // Repeating the latest leaves the map as it was, so no row re-renders for it.
  m.apply(reaction("user-1", "✅"));
  expect(m.snapshot().reactions).toBe(view.reactions);
});

test("session.restored drops the reactions that came after its point, and the one they replaced shows again", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "Ship it" }, { item_id: "user-1" }));
  m.apply(reaction("user-1", "👍"));
  const kept = cursor;
  m.apply(reaction("user-1", "❤️"));
  m.apply(ev("message.done", { role: "user", text: "And tag it" }, { item_id: "user-2" }));
  m.apply(reaction("user-2", "👀"));
  expect(Object.fromEntries(m.snapshot().reactions)).toEqual({ "user-1": "❤️", "user-2": "👀" });
  m.apply(ev("session.restored", { at: kept }));
  expect(Object.fromEntries(m.snapshot().reactions)).toEqual({ "user-1": "👍" });
});

test("retrieve unavailable renders as a compression notice after the person's message", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "retrieve" }));
  m.apply(ev("message.done", { role: "user", text: "fix it" }, { turn_id: "retrieve", item_id: "user-retrieve" }));
  m.apply(ev("notification", { level: "info", title: "Compression off: retrieve unavailable" }, { turn_id: "retrieve" }));
  expect(m.snapshot().items).toMatchObject([{ kind: "user" }, { kind: "notice", text: "Compression off: retrieve unavailable" }]);
});

test("an approval carries the tool call it waits on, as its line shows it", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }));
  m.apply(ev("tool.started", { name: "command", title: "git log --oneline -1", kind: "command", input: { command: "git log --oneline -1" } }, { item_id: "tool-1", turn_id: "t1" }));
  m.apply(ev("ask.user", { kind: "approval", title: "Show the latest commit", detail: "Show the latest commit", tool_item_id: "tool-1", options: [{ id: "accept", label: "Allow", decision: "allow" }] }, { item_id: "k1", turn_id: "t1" }));
  m.apply(ev("ask.user", { kind: "approval", title: "Push", options: [{ id: "accept", label: "Allow", decision: "allow" }] }, { item_id: "k2", turn_id: "t1" }));
  const asks = m.snapshot().items.filter((i) => i.kind === "ask");
  expect(asks.map((a) => a.kind === "ask" && a.waitsOn)).toEqual([{ icon: "run", subject: "git log --oneline -1" }, undefined]);
  // The step it holds, by id: its line waits on the person until the answer comes.
  expect(asks.map((a) => a.kind === "ask" && a.toolItemId)).toEqual(["tool-1", undefined]);
});

test("an approval's options keep what each decides, so the card can lead with the one that lets the step run", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }));
  m.apply(ev("ask.user", { kind: "approval", title: "Push", options: [{ id: "accept", label: "Allow", decision: "allow" }, { id: "decline", label: "Deny", decision: "deny" }] }, { item_id: "k1", turn_id: "t1" }));
  const ask = m.snapshot().items.find((i) => i.kind === "ask");
  expect(ask?.kind === "ask" && ask.options.map((o) => o.decision)).toEqual(["allow", "deny"]);
});

test("an approval whose deny takes a note says so; one with no deny, or from an engine that takes none, does not", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }));
  const options = [{ id: "accept", label: "Allow", decision: "allow" }, { id: "decline", label: "Deny", decision: "deny" }];
  m.apply(ev("ask.user", { kind: "approval", title: "Run rm -rf build", accepts_feedback: true, options }, { item_id: "k1", turn_id: "t1" }));
  m.apply(ev("ask.user", { kind: "approval", title: "Push", accepts_feedback: true, options: options.slice(0, 1) }, { item_id: "k2", turn_id: "t1" }));
  m.apply(ev("ask.user", { kind: "approval", title: "Push", options }, { item_id: "k3", turn_id: "t1" }));
  const asks = m.snapshot().items.filter((i) => i.kind === "ask");
  expect(asks.map((a) => a.kind === "ask" && a.acceptsFeedback)).toEqual([true, undefined, undefined]);
});

test("a question's options keep their previews; a blank one is none", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }));
  m.apply(
    ev(
      "ask.user",
      {
        kind: "question",
        questions: [
          {
            id: "layout",
            prompt: "Which layout?",
            options: [
              { id: "side", label: "Sidebar", description: "Nav on the left", preview: "┌──┬───┐\n│▤ │   │" },
              { id: "top", label: "Top bar", preview: " " },
            ],
            multi_select: false,
            allow_text: true,
          },
        ],
      },
      { item_id: "q1", turn_id: "t1" },
    ),
  );
  const ask = m.snapshot().pendingAsk!;
  expect(ask.options).toEqual([
    { id: "side", label: "Sidebar", description: "Nav on the left", preview: "┌──┬───┐\n│▤ │   │" },
    { id: "top", label: "Top bar", description: null },
  ]);
  expect(ask.questions[0]!.options[0]).toMatchObject({ preview: "┌──┬───┐\n│▤ │   │" });
});

test("a patch over several files says each, opens to each, and settles as one line of what it did", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "codex" }, { turn_id: "t1" }));
  const files = [
    { path: "/w/src/d.ts", old_path: "/w/src/c.ts", status: "renamed" },
    { path: "/w/src/e.ts", status: "deleted" },
    { path: "/w/src/a.ts", status: "added" },
    { path: "/w/src/b.ts", status: "modified" },
  ];
  m.apply(ev("tool.started", { name: "edit", title: "/w/src/c.ts", kind: "edit", input: { path: "/w/src/c.ts" }, files }, { item_id: "patch", turn_id: "t1" }));
  const running = m.snapshot().items.find((i) => i.kind === "tool")!;
  expect(running).toMatchObject({
    verb: "Moving",
    subject: "/w/src/c.ts → /w/src/d.ts",
    then: "deleting /w/src/e.ts, creating /w/src/a.ts, editing /w/src/b.ts",
    icon: "edit",
    files: [
      { path: "/w/src/d.ts", oldPath: "/w/src/c.ts", status: "renamed" },
      { path: "/w/src/e.ts", oldPath: null, status: "deleted" },
      { path: "/w/src/a.ts", oldPath: null, status: "added" },
      { path: "/w/src/b.ts", oldPath: null, status: "modified" },
    ],
  });
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "patch", turn_id: "t1" }));
  const done = m.snapshot().items.find((i) => i.kind === "tool")!;
  expect(done).toMatchObject({ verb: "Moved /w/src/c.ts → /w/src/d.ts, deleted e.ts, created a.ts, edited b.ts", subject: "" });
  expect(done.kind === "tool" && done.parts.length).toBe(4);
  // Every file it edited reads as an edit of that file: "Edited a.ts, b.ts".
  m.apply(ev("tool.started", { name: "edit", title: "/w/a.ts", kind: "edit", input: { path: "/w/a.ts" }, files: [{ path: "/w/a.ts", status: "modified" }, { path: "/w/b.ts", status: "modified" }] }, { item_id: "patch2", turn_id: "t1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "patch2", turn_id: "t1" }));
  expect(m.snapshot().items.find((i) => i.id === "patch2")).toMatchObject({ verb: "Edited", subject: "/w/a.ts, /w/b.ts" });
  // One file and no list: as before.
  m.apply(ev("tool.started", { name: "edit", title: "/w/one.ts", kind: "edit", input: { path: "/w/one.ts" } }, { item_id: "edit3", turn_id: "t1" }));
  expect(m.snapshot().items.find((i) => i.id === "edit3")).not.toHaveProperty("files");
});

test("a notice raised as a message goes out reads under that message; an older one stays where it was", () => {
  cursor = 0;
  const m = new SessionModel();
  const t = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString();
  m.apply(ev("notification", { level: "warning", title: "Uncommitted changes were not put back" }, { at: t(0) }));
  // The runtime's order: the notice, then the turn, then the person's message (sent at once).
  m.apply(ev("notification", { level: "info", title: "Compression off: proxy unavailable" }, { at: t(120) }));
  m.apply(ev("turn.started", { engine: "claude-agent" }, { turn_id: "r1", at: t(120) }));
  m.apply(ev("message.done", { role: "user", text: "fix it" }, { item_id: "u1", turn_id: "r1", at: t(121) }));
  m.apply(ev("message.done", { role: "assistant", text: "Fixed." }, { item_id: "a1", turn_id: "r1", at: t(125) }));
  const v = m.snapshot();
  expect(v.items.map((i) => (i.kind === "notice" ? i.text : i.kind))).toEqual(["Uncommitted changes were not put back", "user", "Compression off: proxy unavailable", "assistant"]);
});

test("a streamed answer's deltas find their row from the end of a long chat, not by walking it", () => {
  const m = new SessionModel();
  let c = 0;
  const e = (type: SessionEvent["type"], payload: unknown, extra: Partial<SessionEvent> = {}) => m.apply({ session_id: "s", cursor: ++c, at, type, payload, ...extra } as SessionEvent);
  for (let i = 0; i < 300; i++) {
    e("message.done", { role: "user", text: `turn ${i}` }, { item_id: `u${i}` });
    e("turn.started", { engine: "claude-agent" });
    e("message.done", { role: "assistant", text: "done" }, { item_id: `a${i}` });
    e("turn.done", { status: "completed" });
  }
  e("message.done", { role: "user", text: "one more" }, { item_id: "u-last" });
  e("turn.started", { engine: "claude-agent" });
  // Count the rows the search for each delta's row looks at (it was every row of the chat, from the top, per delta).
  let visits = 0;
  const count = <T,>(search: (this: T[], pred: (v: T, i: number, a: T[]) => unknown) => number) =>
    function (this: T[], pred: (v: T, i: number, a: T[]) => unknown) {
      return search.call(this, (v, i, arr) => (visits++, pred(v, i, arr)));
    };
  const [findIndex, findLastIndex] = [Array.prototype.findIndex, Array.prototype.findLastIndex];
  const first = vi.spyOn(Array.prototype, "findIndex").mockImplementation(count(findIndex) as never);
  const last = vi.spyOn(Array.prototype, "findLastIndex").mockImplementation(count(findLastIndex) as never);
  try {
    for (let d = 0; d < 200; d++) e("message.delta", { text: "word " }, { item_id: "a-last" });
  } finally {
    first.mockRestore();
    last.mockRestore();
  }
  const answer = m.snapshot().items.at(-1);
  expect(answer?.kind === "assistant" && answer.text.length).toBe(1000);
  expect(visits).toBeLessThan(200 * 4);
});

test("after a restore, a subagent's tool still takes its output", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "go" }, { item_id: "u1" }));
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  m.apply(ev("turn.done", { status: "completed" }));
  const done = cursor;
  m.apply(ev("message.done", { role: "user", text: "more" }, { item_id: "u2" }));
  m.apply(ev("session.restored", { at: done }));
  m.apply(ev("message.done", { role: "user", text: "again" }, { item_id: "u3" }));
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  m.apply(ev("subagent.started", { title: "Explore" }, { item_id: "sa1" }));
  m.apply(ev("tool.started", { name: "read", title: "retry.go", kind: "read", input: {} }, { item_id: "t1", parent_item_id: "sa1" }));
  m.apply(ev("tool.output", { text: "package retry\n" }, { item_id: "t1", parent_item_id: "sa1" }));
  const sub = m.snapshot().items.find((i) => i.kind === "subagent");
  expect(sub?.kind === "subagent" && sub.items.map((i) => i.kind === "tool" && i.output)).toEqual(["package retry\n"]);
  expect(m.snapshot().items.map((i) => i.kind)).toEqual(["user", "turn_end", "restored", "user", "subagent"]);
});

test("a message shows as it is sent; the runtime's message.done takes its place, and a refused send takes it back", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "assistant", text: "Done." }, { item_id: "a0" }));
  m.echo("sp-msg:1", "and the tests");
  let v = m.snapshot();
  expect(v.items.map((i) => [i.kind, i.kind === "user" && i.pending === true])).toEqual([
    ["assistant", false],
    ["user", true],
  ]);
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  m.apply(ev("message.done", { role: "user", text: "and the tests" }, { item_id: "sp-msg:1" }));
  v = m.snapshot();
  // One row, in its place, now the runtime's.
  expect(v.items.map((i) => [i.kind, i.kind === "user" && i.pending === true])).toEqual([
    ["assistant", false],
    ["user", false],
  ]);
  m.unecho("sp-msg:1");
  expect(m.snapshot().items).toHaveLength(2);
  m.echo("sp-msg:2", "queued instead");
  m.unecho("sp-msg:2");
  expect(m.snapshot().items).toHaveLength(2);
});

test("a new chat's worktree row reads Setting up worktree, then Set up worktree, with its branch", () => {
  cursor = 0;
  const m = new SessionModel();
  const input = { path: "/w/repo/fix-abc", branch: "caveman/fix-abc123", base_ref: "main" };
  m.apply(ev("message.done", { role: "user", text: "fix it" }, { item_id: "sp-msg:1" }));
  m.apply(ev("tool.started", { name: "worktree", kind: "command", title: "git worktree add /w/repo/fix-abc", input }, { item_id: "worktree:w1" }));
  let tool = m.snapshot().items[1]!;
  expect(tool.kind === "tool" && [tool.verb, tool.subject, tool.status]).toEqual(["Setting up worktree", "caveman/fix-abc123", "running"]);
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "worktree:w1" }));
  tool = m.snapshot().items[1]!;
  expect(tool.kind === "tool" && [tool.verb, tool.status]).toEqual(["Set up worktree", "done"]);
});

test("a move says where the chat went and why, once", () => {
  cursor = 0;
  const m = new SessionModel();
  const time = new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (const e of [
    ev("session.parked", { reason: "move", to: "cloud", cause: "lid" }),
    ev("session.resumed", { computer_id: "cmp_cloud" }),
    ev("session.parked", { reason: "move", to: "this_mac", cause: "user" }),
    ev("session.resumed", { computer_id: "this-mac" }),
    ev("session.parked", { reason: "move", to: "cloud", cause: "asleep" }),
    ev("session.resumed", { computer_id: "cmp_cloud" }),
    ev("session.parked", { reason: "user" }),
    ev("session.resumed", { computer_id: "cmp_cloud" }),
    // Pushed to another of the person's Macs: that Mac by its name, never this one.
    ev("session.parked", { reason: "move", to: "this_mac", cause: "user", name: "Mac B" }),
  ])
    m.apply(e);
  expect(m.snapshot().items.map((i) => i.kind === "notice" && i.text)).toEqual([
    `Moved to Cloud when the lid closed at ${time}.`,
    `Moved to ${THIS_COMPUTER} at ${time}.`,
    `Moved to Cloud at ${time} while ${THIS_COMPUTER} slept.`,
    "Parked.",
    "Session resumed.",
    `Moved to Mac B at ${time}.`,
  ]);
});

test("a move that did not go through says so, and the chat carries on where it is", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("session.parked", { reason: "move", to: "cloud", cause: "lid" }));
  m.apply(ev("session.resumed", { computer_id: "this-mac", move_failed: "This Caveman Cloud runs no Cloud computers" }));
  // One line, in place of "Moved to Cloud…".
  expect(m.snapshot().items.map((i) => i.kind === "notice" && [i.tone, i.text])).toEqual([["warning", "Didn't move: This Caveman Cloud runs no Cloud computers. It carries on here."]]);
  expect(m.snapshot().movedTo).toBeNull();
});

test("a shell command's line says what it did; its approval, its terminal card and its line's opening keep the command as it ran", () => {
  cursor = 0;
  const m = new SessionModel();
  const command = `cd "/Users/me/repo" && sed -n 1,40p src/a.ts; grep -n retry src/b.ts`;
  m.apply(ev("tool.started", { name: "command", title: command, kind: "command", input: { command } }, { item_id: "t1" }));
  m.apply(ev("ask.user", { kind: "approval", title: "Run it?", tool_item_id: "t1", options: [{ id: "accept", label: "Allow", decision: "allow" }] }, { item_id: "k1" }));
  let tool = m.snapshot().items[0]!;
  expect(tool.kind === "tool" && [tool.verb, tool.subject, tool.then, tool.icon]).toEqual(["Reading", "src/a.ts", "searching for retry in src/b.ts", "read"]);
  const ask = m.snapshot().items[1]!;
  expect(ask.kind === "ask" && ask.waitsOn).toEqual({ icon: "run", subject: command });
  m.apply(ev("tool.output", { text: "1: retry\n" }, { item_id: "t1" }));
  m.apply(ev("tool.done", { status: "completed" }, { item_id: "t1" }));
  tool = m.snapshot().items[0]!;
  // Settled, the line is the done line alone: no `then` left over from while it ran.
  expect(tool.kind === "tool" && [tool.verb, tool.subject, tool.then, tool.command]).toEqual(["Read a.ts, searched for retry in src/b.ts", "", undefined, command]);
  expect(m.snapshot().artifacts.map((a) => a.kind === "terminal" && [a.title, a.command])).toEqual([["sed -n 1,40p src/a.ts; grep -n retry src/b.ts", command]]);
  // A shell write names its file but leaves the file cards to the engine's own edits.
  m.apply(ev("tool.started", { name: "command", title: "cat > notes.md <<'EOF'\nhi\nEOF", kind: "command", input: {} }, { item_id: "t2" }));
  expect(m.snapshot().artifacts.filter((a) => a.kind === "file")).toEqual([]);
});

test("a web call fetches an address or searches the web for words", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("tool.started", { name: "web_search", title: "effect 4 release notes", kind: "web", input: {} }, { item_id: "w1" }));
  m.apply(ev("tool.started", { name: "web_search", title: "https://effect.website/blog", kind: "web", input: {} }, { item_id: "w2" }));
  const rows = m.snapshot().items.map((i) => (i.kind === "tool" ? `${i.verb} ${i.subject}` : i.kind));
  expect(rows).toEqual(["Searching the web for effect 4 release notes", "Fetching effect.website"]);
});

test("a call shows its turns once: the note the person said is the spoken turn, handed to the Chief", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("voice.call", { call_id: "vc-1", state: "started" }));
  m.apply(ev("voice.turn", { call_id: "vc-1", role: "voice", text: "Hey. Want the walkthrough?" }));
  // The note's message can land before its spoken turn: the turn takes its place.
  m.apply(ev("message.done", { role: "user", text: "add dark mode to runs" }, { item_id: "u1" }));
  m.apply(ev("voice.turn", { call_id: "vc-1", role: "person", text: "add dark mode to runs", handoff: { item_id: "ci-1", text: "add dark mode to runs" } }));
  // Words shown first, handed off a moment later (an empty handoff turn), and a note arriving after its turn.
  m.apply(ev("voice.turn", { call_id: "vc-1", role: "person", text: "and the logs page" }));
  m.apply(ev("voice.turn", { call_id: "vc-1", role: "person", text: "", handoff: { item_id: "ci-2", text: "and the logs page" } }));
  m.apply(ev("message.done", { role: "user", text: "and the logs page" }, { item_id: "u2" }));
  m.apply(ev("voice.call", { call_id: "vc-1", state: "ended", duration_ms: 42_000, reason: "goodbye" }));
  const items = m.snapshot().items as ReadonlyArray<TranscriptItem>;
  expect(items.map((i) => (i.kind === "spoken" ? `${i.role}${i.handoff ? "→chief" : ""}: ${i.text}` : i.kind === "call" ? `call ${i.state}` : i.kind))).toEqual([
    "call started",
    "voice: Hey. Want the walkthrough?",
    "person→chief: add dark mode to runs",
    "person→chief: and the logs page",
    "call ended",
  ]);
  const end = items.at(-1)!;
  expect(end.kind === "call" && [end.durationMs, end.reason]).toEqual([42_000, "goodbye"]);
});

const callRows = (m: SessionModel) =>
  m.snapshot().items.map((i) => (i.kind === "spoken" ? `${i.role}${i.handoff ? "→chief" : ""}: ${i.text}` : i.kind === "call" ? `call ${i.state}` : i.kind === "user" ? `${i.id}: ${i.text}` : i.kind));

test("a note typed in the Chief after a call shows, though a note said on the call had its words", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("voice.call", { call_id: "vc-1", state: "started" }));
  // Queued delivery: the spoken turn first, the note's own message after it.
  m.apply(ev("voice.turn", { call_id: "vc-1", role: "person", text: "check the build", handoff: { item_id: "ci-1", text: "check the build" } }));
  m.apply(ev("message.done", { role: "user", text: "check the build", delivery: "steer" }, { item_id: "u-voice" }));
  m.apply(ev("voice.call", { call_id: "vc-1", state: "ended", duration_ms: 10_000, reason: "goodbye" }));
  // Later the same words typed in the Chief's box (chief.capture), and a scheduled task that says them.
  m.apply(ev("message.done", { role: "user", text: "check the build" }, { item_id: "u-typed" }));
  m.apply(ev("message.done", { role: "user", text: "check the build", scheduled_task: { task_id: "t1" } }, { item_id: "u-task" }));
  expect(callRows(m)).toEqual(["call started", "person→chief: check the build", "call ended", "u-typed: check the build", "u-task: check the build"]);
});

test("a note said on a call never takes the place of an earlier message with the same words", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "check the build" }, { item_id: "u-before" }));
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  m.apply(ev("turn.done", { status: "completed" }));
  m.apply(ev("voice.call", { call_id: "vc-1", state: "started" }));
  m.apply(ev("voice.turn", { call_id: "vc-1", role: "person", text: "check the build", handoff: { item_id: "ci-1", text: "check the build" } }));
  m.apply(ev("message.done", { role: "user", text: "check the build", delivery: "steer" }, { item_id: "u-voice" }));
  expect(callRows(m)).toEqual(["u-before: check the build", "turn_end", "call started", "person→chief: check the build"]);
});

test("a command shown as it starts takes its command when the call's input is whole, keeping its output", () => {
  cursor = 0;
  const m = new SessionModel();
  // Claude Agent shows a call as the model begins it, before its input is whole: a command with none yet.
  m.apply(ev("tool.started", { name: "command", title: "", kind: "command", input: { command: "" } }, { item_id: "t1" }));
  const [early] = m.snapshot().items;
  expect(early?.kind === "tool" && [early.verb, early.subject]).toEqual(["Running a command", ""]);
  m.apply(ev("tool.output", { text: "line-1\n" }, { item_id: "t1" }));
  const command = "for i in 1 2 3 4 5; do echo line-$i; sleep 1; done";
  m.apply(ev("tool.started", { name: "command", title: command, kind: "command", input: { command } }, { item_id: "t1" }));
  const [row] = m.snapshot().items;
  expect(row).toMatchObject({ kind: "tool", status: "running", output: "line-1\n", verb: "Running", subject: command, command });
  m.apply(ev("tool.done", { status: "completed", result: { exit_code: 0 } }, { item_id: "t1" }));
  const [done] = m.snapshot().items;
  expect(done).toMatchObject({ kind: "tool", status: "done", verb: "Ran", subject: command });
});

test("a custom tool call is an ask for its result: its name, description and input, then what was sent back", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  m.apply(ev("ask.user", { kind: "tool", name: "lookup_order", description: "Looks an order up.", input: { id: "ord_7" } }, { item_id: "tool:1" }));
  const ask = m.snapshot().items.at(-1)!;
  expect(ask.kind === "ask" && [ask.askKind, ask.prompt, ask.tool, ask.resolution]).toEqual(["tool", "lookup_order: Looks an order up.", { name: "lookup_order", input: '{\n  "id": "ord_7"\n}' }, null]);
  m.apply(ev("ask.resolved", { outcome: "answered", response: { kind: "tool", content: "shipped", is_error: false } }, { item_id: "tool:1" }));
  const answered = m.snapshot().items.at(-1)!;
  expect(answered.kind === "ask" && answered.resolution).toBe("Result sent");
});

test("the chat's agent files are offered for publishing; a deleted one is not", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(
    ev("diff.changed", {
      files: [
        { path: ".caveman/agents/triager.md", status: "added", additions: 20, deletions: 0 },
        { path: ".caveman/agents/old.md", status: "deleted", additions: 0, deletions: 9 },
        { path: ".claude/agents/x.md", status: "added", additions: 3, deletions: 0 },
        { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
      ],
    }),
  );
  expect(m.snapshot().agentFiles).toEqual([".caveman/agents/triager.md"]);
});

test("a Caveman plan or credits limit is a warning that says until when and leads to the plan; a time that does not parse is never shown", () => {
  cursor = 0;
  const m = new SessionModel();
  const resets = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  m.apply(ev("engine.status", { engine: "caveman", rate_limit: { limited: true, resets_at: resets }, message: "Your Caveman plan's 5-hour usage window is used up." }));
  m.apply(ev("engine.status", { engine: "caveman", rate_limit: { limited: true }, message: "No Caveman plan usage or credits are left for this model.  <b>Top up</b>" }));
  m.apply(ev("engine.status", { engine: "caveman", rate_limit: { limited: true, resets_at: "not a time" }, message: "Your Caveman plan's weekly usage window is used up." }));
  m.apply(ev("engine.status", { engine: "codex", rate_limit: { limited: true, resets_at: "garbage" } }));
  expect(m.snapshot().items).toEqual([
    { kind: "notice", id: expect.any(String), tone: "warning", text: `Your Caveman plan's 5-hour usage window is used up. Resets ${resetTime(resets)}.`, action: "account" },
    // Text only, as sent: the chat renders it as text, never as markup.
    { kind: "notice", id: expect.any(String), tone: "warning", text: "No Caveman plan usage or credits are left for this model. <b>Top up</b>", action: "account" },
    { kind: "notice", id: expect.any(String), tone: "warning", text: "Your Caveman plan's weekly usage window is used up.", action: "account" },
    { kind: "notice", id: expect.any(String), tone: "warning", text: "Rate limited." },
  ]);
});

test("a reset time reads as a time today and a date and time later", () => {
  const now = new Date(2026, 9, 23, 12, 0);
  expect(resetTime(new Date(2026, 9, 23, 15, 0).toISOString(), now)).toBe("3:00 PM");
  expect(resetTime(new Date(2026, 9, 27, 9, 30).toISOString(), now)).toBe("Oct 27, 9:30 AM");
  for (const bad of [undefined, "", "soon", "2026-13-45T99:00:00Z"]) expect(resetTime(bad, now)).toBeUndefined();
});

test("each item carries the model its turn started on, and keeps it when the next turn names another", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("message.done", { role: "user", text: "draft them" }, { item_id: "u1" }));
  m.apply(ev("turn.started", { engine: "caveman", model: "openrouter/x-ai/grok-4.7" }));
  m.apply(ev("message.delta", { text: "Three drafts" }, { item_id: "a1" }));
  m.apply(ev("turn.done", { status: "completed" }));
  m.apply(ev("message.done", { role: "user", text: "again" }, { item_id: "u2" }));
  // A turn that names no model attributes none (never the previous turn's).
  m.apply(ev("turn.started", { engine: "caveman" }));
  m.apply(ev("message.delta", { text: "Again." }, { item_id: "a2" }));
  m.apply(ev("message.done", { role: "assistant", text: "Three drafts are in." }, { item_id: "a1" }));
  const items = m.snapshot().items;
  expect(items.find((i) => i.id === "u1")).not.toHaveProperty("turnModel");
  expect(items.find((i) => i.id === "a1")).toMatchObject({ turnModel: "openrouter/x-ai/grok-4.7", text: "Three drafts are in." });
  expect(items.find((i) => i.id === "a2")).not.toHaveProperty("turnModel");
});

test("the desktop tool's row says what it did in which app, in every engine's spelling", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("tool.started", { name: "mcp__caveman-code__desktop", title: "desktop", kind: "mcp", input: { app: "Safari", command: "snapshot" } }, { item_id: "d1" }));
  m.apply(ev("tool.started", { name: "caveman-code.desktop", title: "desktop", kind: "mcp", input: { app: "Notes", steps: [{ command: "snapshot" }, { command: "type", args: { text: "hi" } }] } }, { item_id: "d2" }));
  m.apply(ev("tool.started", { name: "mcp__caveman_code__desktop", title: "desktop", kind: "mcp", input: { command: "click", args: { ref_id: "@a:e5" } } }, { item_id: "d3" }));
  const running = m.snapshot().items.filter((i) => i.kind === "tool");
  expect(running.map((t) => t.kind === "tool" && [t.verb, t.subject, t.icon])).toEqual([
    ["Looking at", "Safari", "other"],
    ["Typing in", "Notes", "other"],
    ["Clicking", "", "other"],
  ]);
  for (const id of ["d1", "d2", "d3"]) m.apply(ev("tool.done", { status: "completed" }, { item_id: id }));
  const done = m.snapshot().items.filter((i) => i.kind === "tool");
  expect(done.map((t) => t.kind === "tool" && `${t.verb} ${t.subject}`.trim())).toEqual(["Looked at Safari", "Typed in Notes", "Clicked"]);
});

test("a turn on another model or effort gets a switch divider before the message that opened it", () => {
  cursor = 0;
  const m = new SessionModel();
  for (const event of [
    ev("message.done", { role: "user", text: "hi" }, { item_id: "u1" }),
    ev("turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "xhigh" }),
    ev("message.done", { role: "assistant", text: "Hi." }, { item_id: "a1" }),
    ev("turn.done", { status: "completed" }),
    ev("message.done", { role: "user", text: "again" }, { item_id: "u2" }),
    ev("turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "xhigh" }),
    ev("turn.done", { status: "completed" }),
    ev("message.done", { role: "user", text: "what is this app?" }, { item_id: "u3" }),
    ev("turn.started", { engine: "claude-agent", model: "claude-sonnet-5-5", effort: "medium" }),
    ev("message.done", { role: "assistant", text: "Caveman Code." }, { item_id: "a3" }),
    ev("turn.done", { status: "completed" }),
  ]) m.apply(event);
  const kinds = m.snapshot().items.map((i) => (i.kind === "user" ? i.text : i.kind));
  expect(kinds).toEqual(["hi", "assistant", "turn_end", "again", "turn_end", "switch", "what is this app?", "assistant", "turn_end"]);
  const sw = m.snapshot().items.find((i) => i.kind === "switch");
  expect(sw).toMatchObject({ from: { model: "claude-opus-5-5", effort: "xhigh" }, to: { model: "claude-sonnet-5-5", effort: "medium" } });
});

test("a turn that names no model (Auto) never borrows the last turn's: turnModel is the running turn's own", () => {
  cursor = 0;
  const m = new SessionModel();
  m.apply(ev("turn.started", { engine: "claude-agent", model: "claude-opus-5-5" }));
  expect(m.snapshot().turnModel).toBe("claude-opus-5-5");
  m.apply(ev("turn.done", { status: "completed" }));
  expect(m.snapshot().turnModel).toBeUndefined();
  m.apply(ev("turn.started", { engine: "claude-agent" }));
  const auto = m.snapshot();
  expect(auto.running).toBe(true);
  expect(auto.turnModel).toBeUndefined();
  // The last model-bearing start still stands for what the composer offers next.
  expect(auto.turn?.model).toBe("claude-opus-5-5");
});
