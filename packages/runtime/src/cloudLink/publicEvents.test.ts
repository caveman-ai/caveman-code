import type { SessionEvent } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";

import { cut, expectInput, initialMapperState, mapSessionEvent, pullRequestEvent, PUBLIC_PAYLOAD_MAX_BYTES, sessionError, stopReasonOf, terminated, type MapperState } from "./publicEvents.ts";

let cursor = 0;
const ev = (type: string, payload: unknown, extra: Partial<{ item_id: string; turn_id: string; parent_item_id: string }> = {}) =>
  ({ session_id: "s", cursor: ++cursor, at: "2026-10-21T10:00:00.000Z", type, payload, ...extra }) as unknown as SessionEvent;

const run = (events: ReadonlyArray<SessionEvent>, state: MapperState = initialMapperState(), outputs: Record<string, unknown> = {}) =>
  events.flatMap((e) => mapSessionEvent(state, e, "api", (id) => outputs[id])).map((p) => [p.type, p.data]);

describe("mapSessionEvent", () => {
  test("a turn: status, the caller's message, a tool and its output, the answer, usage, idle with its stop reason", () => {
    const out = run(
      [
        ev("message.done", { role: "user", text: "Fix the bug" }, { item_id: "m1" }),
        ev("turn.started", { engine: "caveman" }, { turn_id: "t1" }),
        ev("reasoning.delta", { text: "Look at " }, { item_id: "r1" }),
        ev("reasoning.delta", { text: "the test." }, { item_id: "r1" }),
        ev("tool.started", { name: "command", title: "npm test", kind: "command", input: { command: "npm test" } }, { item_id: "c1" }),
        ev("tool.output", { text: "1 failing\n" }, { item_id: "c1" }),
        ev("tool.done", { status: "failed", error: "exit 1" }, { item_id: "c1" }),
        ev("tool.started", { name: "read", title: "a.ts", kind: "read", input: { path: "a.ts" } }, { item_id: "c2" }),
        ev("tool.done", { status: "completed" }, { item_id: "c2" }),
        ev("message.done", { role: "assistant", text: "Fixed." }, { item_id: "m2" }),
        ev("usage", { model: "m", input_tokens: 10, output_tokens: 2, cache_read_tokens: 5, cache_write_tokens: 0, cost: { usd: 0.25, basis: "list_price" } }),
        ev("usage", { model: "m", input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_write_tokens: 0, cost: null }),
        ev("turn.done", { status: "completed" }, { turn_id: "t1" }),
      ],
      undefined,
      { c2: "export const a = 1;\n" },
    );
    expect(out).toEqual([
      ["user.message", { text: "Fix the bug", origin: "api" }],
      ["session.status", { status: "running", stop_reason: null }],
      ["agent.thinking", { text: "Look at the test." }],
      ["agent.tool_use", { id: "c1", name: "command", input: { command: "npm test" } }],
      ["agent.tool_result", { tool_use_id: "c1", is_error: true, output: "1 failing\n\nexit 1" }],
      ["agent.tool_use", { id: "c2", name: "read", input: { path: "a.ts" } }],
      ["agent.tool_result", { tool_use_id: "c2", is_error: false, output: "export const a = 1;\n" }],
      ["agent.message", { text: "Fixed." }],
      ["session.usage", { input_tokens: 10, output_tokens: 2, cache_read_tokens: 5, cost_usd: 0.25 }],
      ["session.usage", { input_tokens: 11, output_tokens: 3, cache_read_tokens: 5, cost_usd: 0.25 }],
      ["session.status", { status: "idle", stop_reason: "end_turn" }],
    ]);
  });

  test("asks are requires_action with what answers them; the runtime's own rows are not the agent's tools", () => {
    const state = initialMapperState();
    const out = run(
      [
        ev("tool.started", { name: "worktree", title: "git checkout -b x", kind: "command", input: { path: "/w" } }, { item_id: "worktree:w1" }),
        ev("tool.done", { status: "completed" }, { item_id: "worktree:w1" }),
        ev("turn.started", { engine: "claude-agent" }, { turn_id: "t1" }),
        ev("tool.started", { name: "command", title: "rm -rf build", kind: "command", input: { command: "rm -rf build" } }, { item_id: "c1" }),
        ev("ask.user", { kind: "approval", title: "Run rm -rf build?", tool_item_id: "c1", options: [{ id: "accept", label: "Allow", decision: "allow" }, { id: "decline", label: "Deny", decision: "deny" }] }, { item_id: "a1" }),
        ev("ask.resolved", { outcome: "answered", response: { kind: "approval", option_id: "accept" } }, { item_id: "a1" }),
        ev("ask.user", { kind: "question", questions: [{ id: "q1", prompt: "Which db?", options: [{ id: "o1", label: "Postgres" }], multi_select: false, allow_text: true }] }, { item_id: "a2" }),
        ev("ask.user", { kind: "tool", name: "lookup_order", input: { id: "ord_1" } }, { item_id: "tool:1" }),
        ev("ask.user", { kind: "secret", repo: { url: "https://github.com/a/b" }, name: "TOKEN", reason: "deploy" }, { item_id: "a4" }),
      ],
      state,
    );
    expect(out).toEqual([
      ["session.status", { status: "running", stop_reason: null }],
      ["agent.tool_use", { id: "c1", name: "command", input: { command: "rm -rf build" } }],
      ["requires_action", { ask_id: "a1", kind: "approval", question: "Run rm -rf build?", name: "command", input: { command: "rm -rf build" }, options: ["allow", "deny"] }],
      ["session.status", { status: "requires_action", stop_reason: "requires_action" }],
      ["session.status", { status: "running", stop_reason: null }],
      ["requires_action", { ask_id: "a2", kind: "question", question: "Which db?", options: ["Postgres"], questions: [{ id: "q1", prompt: "Which db?", options: ["Postgres"], multi_select: false }] }],
      ["session.status", { status: "requires_action", stop_reason: "requires_action" }],
      ["requires_action", { ask_id: "tool:1", kind: "tool", name: "lookup_order", input: { id: "ord_1" } }],
      ["requires_action", { ask_id: "a4", kind: "question", question: "The agent asked for the secret TOKEN (deploy). Grant it to the service account; an answer here only lets it go on without it." }],
    ]);
  });

  test("a failed turn says why and ends with an error; an interrupted one says so; a retried error is not one", () => {
    const out = run([
      ev("turn.started", { engine: "codex" }),
      ev("error", { reason: "rate_limited", message: "slow down", retry: { attempt: 1 } }),
      ev("turn.done", { status: "failed", error: "the model refused" }),
      ev("turn.started", { engine: "codex" }),
      ev("turn.done", { status: "interrupted" }),
      ev("error", { reason: "internal", message: "boom" }),
    ]);
    expect(out).toEqual([
      ["session.status", { status: "running", stop_reason: null }],
      ["session.error", { code: "turn_failed", message: "the model refused" }],
      ["session.status", { status: "idle", stop_reason: "error" }],
      ["session.status", { status: "running", stop_reason: null }],
      ["session.status", { status: "idle", stop_reason: "interrupted" }],
      ["session.error", { code: "internal", message: "boom" }],
    ]);
  });

  test("a caller's message says the input it was, once, across a restart; other messages and refusals say theirs or none", () => {
    const state = initialMapperState();
    expectInput(state, "msg-1", "mail_1");
    expectInput(state, "msg-2", "mail_2");
    const first = run([ev("message.done", { role: "user", text: "Deploy is green.", from: { workspace_id: "w2", title: "deployer" } }, { item_id: "wake-1" }), ev("message.done", { role: "user", text: "Refund 4412" }, { item_id: "msg-1" })], state);
    // The outbox keeps the state as JSON between batches.
    const kept = JSON.parse(JSON.stringify(state)) as MapperState;
    const rest = run([ev("message.done", { role: "user", text: "Refund 4413" }, { item_id: "msg-2" }), ev("message.done", { role: "user", text: "Refund 4412" }, { item_id: "msg-1" })], kept);
    expect([...first, ...rest]).toEqual([
      ["user.message", { text: "Deploy is green.", origin: "agent" }],
      ["user.message", { text: "Refund 4412", origin: "api", input_id: "mail_1" }],
      ["user.message", { text: "Refund 4413", origin: "api", input_id: "mail_2" }],
      ["user.message", { text: "Refund 4412", origin: "api" }],
    ]);
    expect(kept.inputs).toEqual({});
    expect(sessionError("2026-10-21T10:00:00.000Z", "message_refused", "This chat is moving to another computer.", "mail_3").data).toEqual({ code: "message_refused", message: "This chat is moving to another computer.", input_id: "mail_3" });
    expect(sessionError("2026-10-21T10:00:00.000Z", "agent_invalid", "bad").data).toEqual({ code: "agent_invalid", message: "bad" });
  });

  test("subagents start and end by their item", () => {
    expect(
      run([
        ev("subagent.started", { title: "Write tests", workspace_id: "w2" }, { item_id: "sa1" }),
        ev("subagent.done", { status: "completed", summary: "ok" }, { item_id: "sa1" }),
      ]),
    ).toEqual([
      ["agent.subagent", { workspace_id: "w2", title: "Write tests", status: "running" }],
      ["agent.subagent", { workspace_id: "w2", title: "Write tests", status: "completed" }],
    ]);
  });

  test("the state round-trips through JSON mid-tool, so a restart maps the rest the same", () => {
    const state = initialMapperState();
    run([ev("tool.started", { name: "command", title: "ls", kind: "command", input: { command: "ls" } }, { item_id: "c1" }), ev("tool.output", { text: "a\n" }, { item_id: "c1" })], state);
    const again = JSON.parse(JSON.stringify(state)) as MapperState;
    expect(run([ev("tool.done", { status: "completed" }, { item_id: "c1" })], again)).toEqual([["agent.tool_result", { tool_use_id: "c1", is_error: false, output: "a\n" }]]);
  });

  test("inputs and outputs past 64 KiB are cut and say so", () => {
    const big = "x".repeat(PUBLIC_PAYLOAD_MAX_BYTES + 10);
    expect(cut(big)).toEqual({ value: "x".repeat(PUBLIC_PAYLOAD_MAX_BYTES), truncated: true });
    expect(cut({ a: big }).truncated).toBe(true);
    expect(cut({ a: 1 })).toEqual({ value: { a: 1 }, truncated: false });
    const [use] = run([ev("tool.started", { name: "edit", title: "f", kind: "edit", input: { text: big } }, { item_id: "e1" })]);
    expect(use![1]).toMatchObject({ truncated: true });
  });

  test("a custom tool's input past 64 KiB reaches the caller whole: its handler acts on it, so only what is shown is cut", () => {
    const content = "a".repeat(PUBLIC_PAYLOAD_MAX_BYTES + 10);
    const out = run([
      ev("tool.started", { name: "save_file", title: "save_file", kind: "mcp", input: { path: "notes.md", content } }, { item_id: "c1" }),
      ev("ask.user", { kind: "tool", name: "save_file", input: { path: "notes.md", content } }, { item_id: "tool:1" }),
    ]);
    expect(out.map(([type, data]) => [type, (data as { truncated?: boolean }).truncated === true])).toEqual([
      ["agent.tool_use", true],
      ["requires_action", false],
      ["session.status", false],
    ]);
    expect(out[1]).toEqual(["requires_action", { ask_id: "tool:1", kind: "tool", name: "save_file", input: { path: "notes.md", content } }]);
  });

  test("the end is said once; a pull request when it shows and when its state changes", () => {
    const state = initialMapperState();
    expect(terminated(state, "t", "end_turn").map((e) => e.data)).toEqual([{ status: "terminated", stop_reason: "end_turn" }]);
    expect(terminated(state, "t", null)).toEqual([]);
    const ws = { pull_request: { number: 7, url: "https://github.com/a/b/pull/7", state: "open" }, updated_at: "t" } as never;
    const first = pullRequestEvent(ws, undefined);
    expect(first.event?.data).toEqual({ url: "https://github.com/a/b/pull/7", state: "open" });
    expect(pullRequestEvent(ws, first.key).event).toBeUndefined();
    expect(pullRequestEvent({ pull_request: { number: 7, url: "https://github.com/a/b/pull/7", state: "merged" }, updated_at: "t" } as never, first.key).event?.data).toEqual({
      url: "https://github.com/a/b/pull/7",
      state: "merged",
    });
  });

  test("a turn that stops after Cloud parked the tree says budget_reached; a failure stays an error; a new turn clears it", () => {
    const state = initialMapperState();
    run([ev("turn.started", { engine: "caveman" }, { turn_id: "t1" })], state);
    state.budget = true;
    expect(run([ev("turn.done", { status: "interrupted" }, { turn_id: "t1" })], state)).toEqual([["session.status", { status: "idle", stop_reason: "budget_reached" }]]);
    expect(stopReasonOf(state, "error")).toBe("error");
    expect(stopReasonOf(state, "end_turn")).toBe("budget_reached");
    run([ev("turn.started", { engine: "caveman" }, { turn_id: "t2" })], state);
    expect(state.budget).toBeUndefined();
    expect(run([ev("turn.done", { status: "interrupted" }, { turn_id: "t2" })], state)).toEqual([["session.status", { status: "idle", stop_reason: "interrupted" }]]);
  });
});
