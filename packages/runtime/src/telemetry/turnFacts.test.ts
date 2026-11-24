// The turn fold (docs/): what a turn did, how it ended, and what the person
// did next, from journal events alone; nothing that could carry content leaves it.
import type { SessionEvent } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";

import { emptyFoldState, engineToken, fold, powerOfTwo, roughly, settleQuiet, SETTLE_MS, token, type ChatInfo, type FoldState } from "./turnFacts.ts";

const T0 = Date.UTC(2026, 10, 7, 4, 0, 0);
const SINCE = new Date(T0 - 60_000).toISOString();

/** A journal for one chat: each event gets the next cursor, at T0 + `ms`. */
function journal(session = "sess-1") {
  let cursor = 0;
  const events: Array<SessionEvent> = [];
  const add = (ms: number, type: string, payload: unknown, ids: { turn?: string; item?: string; parent?: string } = {}) => {
    cursor += 1;
    events.push({
      session_id: session,
      cursor,
      at: new Date(T0 + ms).toISOString(),
      ...(ids.turn ? { turn_id: ids.turn } : {}),
      ...(ids.item ? { item_id: ids.item } : {}),
      ...(ids.parent ? { parent_item_id: ids.parent } : {}),
      type,
      payload,
    } as SessionEvent);
    return cursor;
  };
  return { events, add };
}

const run = (state: FoldState, events: ReadonlyArray<SessionEvent>, info?: (id: string) => ChatInfo | undefined) =>
  fold(state, events, { since: SINCE, salt: "salt-a", info: info ?? (() => ({ origin: "person", turns: 0, context: [10_000, 200_000] })) });

test("a turn's work, wait and cost; settled by the next turn, which resent the prompt on another effort", () => {
  const { events, add } = journal();
  add(0, "turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "max", access: "full", mode: "default" }, { turn: "t1" });
  add(10, "message.done", { role: "user", text: "x".repeat(300), attachments: [{ type: "image" }, { type: "file" }, { type: "image" }] }, { turn: "t1", item: "u1" });
  add(20, "engine.status", { engine: "claude-agent", version: "2.1.312" });
  add(1_000, "tool.started", { kind: "read" }, { turn: "t1", item: "k1" });
  add(1_500, "tool.done", { status: "completed" }, { turn: "t1", item: "k1" });
  add(2_000, "tool.started", { kind: "command" }, { turn: "t1", item: "k2" });
  add(2_100, "ask.user", { kind: "approval", options: [{ id: "yes", decision: "allow" }, { id: "no", decision: "deny" }] }, { turn: "t1", item: "a1" });
  add(12_100, "ask.resolved", { outcome: "answered", response: { kind: "approval", option_id: "no" } }, { turn: "t1", item: "a1" });
  add(12_200, "tool.done", { status: "declined" }, { turn: "t1", item: "k2" });
  // A native subagent's own tool: inside its row, not one of the turn's.
  add(12_300, "subagent.started", {}, { turn: "t1", item: "s1" });
  add(12_400, "tool.started", { kind: "edit" }, { turn: "t1", item: "k3", parent: "s1" });
  add(12_500, "subagent.done", { status: "failed" }, { turn: "t1", item: "s1" });
  add(12_600, "plan.updated", { kind: "todos", steps: [{ status: "completed" }, { status: "completed" }, { status: "pending" }] }, { turn: "t1" });
  add(12_700, "error", { reason: "engine_unavailable", retry: { attempt: 1 }, failure: { class: "provider_error", code: "api_error_529" } }, { turn: "t1" });
  add(12_800, "context.updated", { used_tokens: 50_000, window_tokens: 200_000 });
  add(12_900, "compaction.done", { status: "completed" }, { turn: "t1" });
  add(13_000, "usage", { model: "claude-opus-5-5", input_tokens: 100, output_tokens: 40, cache_read_tokens: 9_000, cache_write_tokens: 500, cost: null, billing: "plan", ttft_ms: 900, web_searches: 1 }, { turn: "t1" });
  add(13_100, "usage", { model: "claude-opus-5-5", input_tokens: 10, output_tokens: 4, cache_read_tokens: 0, cache_write_tokens: 0, cost: null, ttft_ms: 50 }, { turn: "t1" });
  add(14_000, "turn.done", { status: "completed" }, { turn: "t1" });
  add(14_100, "checkpoint.created", { checkpoint_id: "c1", ref: "r", files: [{ path: "/Users/x/a.ts", additions: 10, deletions: 2 }, { path: "b.ts", additions: 5, deletions: 0 }] }, { turn: "t1" });

  const state = emptyFoldState();
  expect(run(state, events)).toEqual([]); // held: what comes next is not known yet

  // The person comes back 40 s later, on high, with the same words.
  add(54_000, "turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "high", mode: "default" }, { turn: "t2" });
  add(54_010, "message.done", { role: "user", text: "x".repeat(300) }, { turn: "t2", item: "u2" });
  const facts = run(state, events.slice(-2));
  expect(facts).toHaveLength(1);
  const fact = facts[0]!;
  expect(fact).toMatchObject({
    index: 1,
    engine: "claude-agent",
    engine_version: "2.1.312",
    model: "claude-opus-5-5",
    effort: "max",
    access: "full",
    mode: "default",
    billing: "plan",
    origin: "person",
    queued: false,
    prompt_chars: 256,
    images: 2,
    files: 1,
    context_tokens: 10_000,
    context_window: 200_000,
    context_end_tokens: 50_000,
    status: "completed",
    moved: false,
    retries: 1,
    rate_limited: false,
    duration_ms: 14_000,
    ttft_ms: 900,
    wait_ms: 10_000,
    // The approval's 10 s inside the command count once, as waiting: tools 500 + 100 + 100.
    tool_ms: 700,
    requests: 2,
    input_tokens: 110,
    output_tokens: 44,
    cache_read_tokens: 9_000,
    cache_write_tokens: 500,
    web_searches: 1,
    compactions: 1,
    compactions_failed: 0,
    tools: 2,
    tools_failed: 0,
    tools_declined: 1,
    tool_read: 1,
    tool_command: 1,
    tool_edit: 0,
    subagents: 1,
    subagents_failed: 1,
    approvals: 1,
    approvals_denied: 1,
    questions: 0,
    todos: 3,
    todos_done: 2,
    files_changed: 2,
    lines_added: 15,
    lines_removed: 2,
    next: "followup",
    next_gap_ms: 40_000,
    next_switch: "effort",
    next_same_prompt: true,
    undone: false,
    kept: false,
    restored: false,
  });
  // To the hour: a turn's start cannot line up with a usage report's exact time.
  expect(fact.started_at).toBe(new Date(T0).toISOString().replace(/:\d\d:\d\d\.\d{3}Z$/, ":00:00.000Z"));
  expect(fact.duration_ms - fact.wait_ms - fact.tool_ms).toBeGreaterThanOrEqual(0);
  // Opaque: neither the chat's nor the turn's real id, and no path or text anywhere in it.
  expect(fact.id).toMatch(/^[0-9a-f]{32}$/);
  expect(fact.session).toMatch(/^[0-9a-f]{32}$/);
  const wire = JSON.stringify(fact);
  for (const secret of ["sess-1", "t1", "/Users", "a.ts", "xxx"]) expect(wire).not.toContain(secret);
});

test("a chat that stays quiet settles its last turn with no next after the settle window", () => {
  const { events, add } = journal();
  add(0, "turn.started", { engine: "codex", model: "gpt-6.1-sol", effort: "high" }, { turn: "t1" });
  add(5, "message.done", { role: "user", text: "hi" }, { turn: "t1" });
  add(3_000, "turn.done", { status: "completed" }, { turn: "t1" });
  const state = emptyFoldState();
  expect(run(state, events)).toEqual([]);
  expect(settleQuiet(state, T0 + 3_000 + SETTLE_MS - 1)).toEqual([]);
  const [fact] = settleQuiet(state, T0 + 3_000 + SETTLE_MS);
  expect(fact).toMatchObject({ next: "none", next_same_prompt: false, engine: "codex", effort: "high", prompt_chars: 2 });
  expect(fact).not.toHaveProperty("next_gap_ms");
  expect(fact).not.toHaveProperty("next_switch");
  // Settled once.
  expect(settleQuiet(state, T0 + 10 * SETTLE_MS)).toEqual([]);
});

test("a next turn after the settle window does not count as a follow-up", () => {
  const { events, add } = journal();
  add(0, "turn.started", { engine: "codex", model: "gpt-6.1-sol" }, { turn: "t1" });
  add(1_000, "turn.done", { status: "completed" }, { turn: "t1" });
  add(1_000 + SETTLE_MS + 1, "turn.started", { engine: "codex", model: "gpt-6.1-sol" }, { turn: "t2" });
  const [fact] = run(emptyFoldState(), events);
  expect(fact).toMatchObject({ next: "none" });
});

test("a failed turn says the engine's class and code, and a usage limit marks it rate limited", () => {
  const { events, add } = journal();
  add(0, "turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "max" }, { turn: "t1" });
  add(100, "error", { reason: "engine_unavailable", retry: { attempt: 1 }, failure: { class: "usage_limit", code: "api_error_429" } }, { turn: "t1" });
  add(200, "error", { reason: "engine_unavailable", retry: { attempt: 2 }, failure: { class: "usage_limit", code: "api_error_429" } }, { turn: "t1" });
  add(9_000, "turn.done", { status: "failed", error: "Claude Agent gave up after repeated API errors.", failure: { class: "provider_error", code: "api_error" } }, { turn: "t1" });
  const state = emptyFoldState();
  run(state, events);
  const [fact] = settleQuiet(state, T0 + 9_000 + SETTLE_MS);
  expect(fact).toMatchObject({ status: "failed", failure_class: "provider_error", failure_code: "api_error", retries: 2, rate_limited: true, duration_ms: 9_000 });
  expect(JSON.stringify(fact)).not.toContain("gave up");
});

test("undone changes, a restore past the turn, a steer and a queued prompt", () => {
  const { events, add } = journal();
  const start = add(0, "turn.started", { engine: "caveman", model: "caveman-auto" }, { turn: "t1" });
  add(10, "message.done", { role: "user", text: "do it", delivery: "queue" }, { turn: "t1" });
  add(20, "model.routed", { model: "glm-5" }, { turn: "t1" });
  add(30, "message.done", { role: "user", text: "also this", delivery: "steer" }, { turn: "t1" });
  add(2_000, "turn.done", { status: "completed" }, { turn: "t1" });
  add(2_100, "checkpoint.created", { checkpoint_id: "c1", ref: "r", files: [] }, { turn: "t1" });
  add(5_000, "checkpoint.resolved", { checkpoint_id: "c1", resolution: "undone", files: [] });
  add(6_000, "session.restored", { at: start - 1 });
  const state = emptyFoldState();
  run(state, events);
  const [fact] = settleQuiet(state, T0 + 2_000 + SETTLE_MS);
  expect(fact).toMatchObject({ model: "caveman-auto", routed_model: "glm-5", queued: true, steers: 1, prompt_chars: 4, undone: true, kept: false, restored: true });
});

test("only turns started since the disclosure count, each once, and a fork's copies count with its source", () => {
  const { events, add } = journal();
  // Started before `since`: never counted, though it ends after.
  add(-120_000, "turn.started", { engine: "codex", model: "m" }, { turn: "old" });
  add(1_000, "turn.done", { status: "completed" }, { turn: "old" });
  add(2_000, "turn.started", { engine: "codex", model: "m" }, { turn: "new" });
  add(3_000, "turn.done", { status: "completed" }, { turn: "new" });
  const state = emptyFoldState();
  run(state, events);
  const facts = settleQuiet(state, T0 + 3_000 + SETTLE_MS);
  expect(facts.map((f) => f.index)).toEqual([2]);
  // The same journal again (a move rewrote it): nothing new.
  run(state, events);
  expect(settleQuiet(state, T0 + 10 * SETTLE_MS)).toEqual([]);

  const fork = journal("fork-1");
  fork.add(2_000, "turn.started", { engine: "codex", model: "m" }, { turn: "copied" });
  fork.add(3_000, "turn.done", { status: "completed" }, { turn: "copied" });
  fork.add(4_000, "turn.started", { engine: "codex", model: "m" }, { turn: "own" });
  fork.add(5_000, "turn.done", { status: "completed" }, { turn: "own" });
  const forked = emptyFoldState();
  run(forked, fork.events, () => ({ origin: "delegated", pick: "auto", copiedThrough: 2, turns: 1 }));
  const [own] = settleQuiet(forked, T0 + 5_000 + SETTLE_MS);
  expect(own).toMatchObject({ index: 2, origin: "delegated", pick: "auto", duration_ms: 1_000 });
  expect(settleQuiet(forked, T0 + 10 * SETTLE_MS)).toEqual([]);
});

test("who started a turn: an agent's mail and a schedule override the person's chat", () => {
  const { events, add } = journal();
  add(0, "turn.started", { engine: "codex", model: "m" }, { turn: "t1" });
  add(1, "message.done", { role: "user", text: "from a schedule", scheduled_task: { task_id: "x" } }, { turn: "t1" });
  add(2, "turn.done", { status: "completed" }, { turn: "t1" });
  add(3, "turn.started", { engine: "codex", model: "m" }, { turn: "t2" });
  add(4, "message.done", { role: "user", text: "from another agent", from: { title: "Builder" } }, { turn: "t2" });
  add(5, "turn.done", { status: "interrupted", reason: "moved" }, { turn: "t2" });
  const state = emptyFoldState();
  const [first] = run(state, events);
  const [second] = settleQuiet(state, T0 + 5 + SETTLE_MS);
  expect(first).toMatchObject({ origin: "scheduled", next: "followup", next_same_prompt: false });
  expect(second).toMatchObject({ origin: "agent", status: "interrupted", moved: true });
});

test("names that are not token-shaped go as other; sizes round down to a power of two", () => {
  expect(token("claude-opus-5-5")).toBe("claude-opus-5-5");
  expect(token("acp:gemini")).toBe("acp:gemini");
  expect(token("openrouter/qwen3-coder@latest")).toBe("openrouter/qwen3-coder@latest");
  expect(token("/Users/me/models/secret.gguf")).toBe("other");
  expect(token("Users/me/models/secret.gguf")).toBe("other");
  expect(token("ollama/home/x")).toBe("other");
  expect(token("C:/models/x.gguf")).toBe("other");
  expect(token("ollama/qwen3:32b")).toBe("ollama/qwen3:32b");
  expect([engineToken("claude-agent"), engineToken("acp:gemini"), engineToken("acp:"), engineToken("mystery")]).toEqual(["claude-agent", "acp:gemini", "other", "other"]);
  expect(token("has space")).toBe("other");
  expect(token("x".repeat(81))).toBe("other");
  expect([0, 1, 2, 3, 300, 1024, 1025].map(powerOfTwo)).toEqual([0, 1, 2, 2, 256, 1024, 1024]);
});

test("a new chat's first message, journaled before its turn and with no turn id, is that turn's prompt", () => {
  const { events, add } = journal();
  add(0, "message.done", { role: "user", text: "build the thing", attachments: [{ type: "image" }] });
  add(1, "tool.started", { kind: "command" }, { item: "setup" }); // the chat's setup, before any turn: not counted
  add(2, "tool.done", { status: "completed" }, { item: "setup" });
  add(3, "turn.started", { engine: "codex", model: "m" }, { turn: "t1" });
  add(9, "turn.done", { status: "completed" }, { turn: "t1" });
  add(10, "turn.started", { engine: "codex", model: "m" }, { turn: "t2" });
  add(11, "message.done", { role: "user", text: "build the thing" }, { turn: "t2" });
  const [fact] = run(emptyFoldState(), events);
  expect(fact).toMatchObject({ prompt_chars: 8, images: 1, tools: 0, next: "followup", next_same_prompt: true });
});

test("a journal rewritten under the fold (a chat moved back) replays nothing: no made-up next turn, no doubled index", () => {
  const { events, add } = journal();
  add(0, "turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "high" }, { turn: "a1" });
  add(1, "message.done", { role: "user", text: "first" }, { turn: "a1" });
  add(2_000, "turn.done", { status: "completed" }, { turn: "a1" });
  add(3_000, "turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "max" }, { turn: "a2" });
  add(3_001, "message.done", { role: "user", text: "second" }, { turn: "a2" });
  add(5_000, "turn.done", { status: "failed", failure: { class: "provider_error" } }, { turn: "a2" });
  const state = emptyFoldState();
  expect(run(state, events).map((f) => f.index)).toEqual([1]);
  // The move back writes the same events again (same cursors and times, new rowids), then the chat goes on.
  const replay = events.map((e) => ({ ...e }));
  const { events: after, add: next } = journal();
  for (let i = 0; i < events.length; i++) next(0, "x", {});
  after.length = 0;
  next(60_000, "turn.started", { engine: "claude-agent", model: "claude-opus-5-5", effort: "max" }, { turn: "a3" });
  next(60_001, "message.done", { role: "user", text: "third" }, { turn: "a3" });
  const facts = run(state, [...replay, ...after]);
  expect(facts).toHaveLength(1);
  expect(facts[0]).toMatchObject({ index: 2, status: "failed", effort: "max", next: "followup", next_gap_ms: 55_000, next_same_prompt: false });
  expect(facts[0]).not.toHaveProperty("next_switch");
  next(61_000, "turn.done", { status: "completed" }, { turn: "a3" });
  run(state, after.slice(-1));
  expect(settleQuiet(state, T0 + 61_000 + SETTLE_MS)[0]).toMatchObject({ index: 3 });
});

test("times and token counts leave to two significant figures; an event of an unexpected shape is skipped", () => {
  expect([0, 99, 100, 123, 1_234, 98_765, 123_456_789].map(roughly)).toEqual([0, 99, 100, 120, 1_200, 99_000, 120_000_000]);
  const { events, add } = journal();
  add(0, "turn.started", { engine: "codex", model: "m" }, { turn: "t1" });
  add(10, "plan.updated", { kind: "todos" }, { turn: "t1" }); // no steps: skipped, the turn goes on
  add(20, "usage", { model: "m", input_tokens: 123_456, output_tokens: 7_891, cache_read_tokens: 99, cache_write_tokens: 0, cost: null, ttft_ms: 1_234 }, { turn: "t1" });
  add(45_678, "turn.done", { status: "completed" }, { turn: "t1" });
  const state = emptyFoldState();
  run(state, events);
  const [fact] = settleQuiet(state, T0 + 45_678 + SETTLE_MS);
  expect(fact).toMatchObject({ input_tokens: 120_000, output_tokens: 7_900, cache_read_tokens: 99, ttft_ms: 1_200, duration_ms: 46_000, todos: 0 });
});
