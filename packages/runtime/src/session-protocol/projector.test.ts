// message.done names the workspace whose agent wrote a user-role message.
import type { OrchestrationV2DomainEvent } from "@caveman-app/protocol";
import { DateTime } from "effect";
import { describe, expect, test } from "vitest";

import type { WorkspaceActivity } from "@caveman-app/session-protocol";

import { claudeTurnWebSearches, normalizeClaudeTurnTokenUsage } from "../provider/ClaudeTurnTokenUsage.ts";

import { CHIEF_QUIET, quietChiefReply } from "../chief/quiet.ts";
import { defaultModelSlug, emptyThreadState, foldActivity, replyLine, foldNativeSubagents, foldOpenAsks, NATIVE_SUBAGENTS_KEPT, nestUnder, projectEvent, threadActivity, usageBilling, type DraftEvent, type OpenAsk } from "./projector.ts";

test("a user-role message from another thread's agent says who sent it, also after waiting for its run", () => {
  const state = emptyThreadState();
  const ctx = {
    at: "2026-10-15T00:00:00.000Z",
    displayText: () => undefined,
    // The daemon's answer: a workspace, a thread with no workspace (a delegated child) by its title, or unknown.
    sender: (threadId: string) =>
      threadId === "caveman:lead" ? { workspace_id: "lead", title: "Lead" } : threadId === "child" ? { title: "Child task" } : undefined,
  };
  const run = (id: string, status: string) =>
    projectEvent(state, { type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx).events;
  const user = (runId: string, messageId: string, senderThreadId?: string) =>
    projectEvent(
      state,
      { type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: messageId, attachments: [], parentItemId: null, ...(senderThreadId ? { senderThreadId } : {}) } } as unknown as OrchestrationV2DomainEvent,
      ctx,
    ).events;

  run("r1", "running");
  expect(user("r1", "m1", "caveman:lead")).toMatchObject([{ type: "message.done", payload: { role: "user", text: "m1", from: { workspace_id: "lead", title: "Lead" } } }]);
  expect(user("r1", "m2", "child")[0]!.payload).toMatchObject({ from: { title: "Child task" } });
  expect((user("r1", "m2b", "child")[0]!.payload as { from: object }).from).not.toHaveProperty("workspace_id");
  expect(user("r1", "m2c", "unknown-thread")[0]!.payload).not.toHaveProperty("from");
  expect(user("r1", "m3")[0]!.payload).not.toHaveProperty("from");

  // Queued: the sender is looked up with the item, and kept until the run starts.
  expect(user("r2", "m4", "caveman:lead")).toEqual([]);
  expect(run("r2", "running").find((e) => e.type === "message.done")).toMatchObject({ payload: { from: { workspace_id: "lead", title: "Lead" } } });
});

test("a steered or queued message says how it reached the engine; a turn of its own says nothing", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined };
  const run = (id: string, status: string) =>
    projectEvent(state, { type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx).events;
  const user = (runId: string, messageId: string, inputIntent: string) =>
    projectEvent(
      state,
      { type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: messageId, attachments: [], parentItemId: null, inputIntent } } as unknown as OrchestrationV2DomainEvent,
      ctx,
    ).events;
  run("r1", "running");
  expect(user("r1", "m1", "turn_start")[0]!.payload).not.toHaveProperty("delivery");
  expect(user("r1", "m2", "steer")[0]!.payload).toMatchObject({ delivery: "steer" });
  expect(user("r1", "m3", "promoted_queued_to_steer")[0]!.payload).toMatchObject({ delivery: "steer" });
  // A queued turn waits for its run, and keeps how it came.
  expect(user("r2", "m4", "queued_turn")).toEqual([]);
  expect(run("r2", "running").find((e) => e.type === "message.done")).toMatchObject({ payload: { delivery: "queue" } });
});

test("a scheduled task's prompt names its task, by title while the task is known, also after waiting for its run", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-21T00:00:00.000Z", displayText: () => undefined, scheduledTask: (id: string) => (id === "task-1" ? "Nightly triage" : undefined) };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } });
  const user = (runId: string, messageId: string, fields: object = {}) =>
    project({ type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: `${messageId} text`, attachments: [], parentItemId: null, ...fields } });
  run("r1", "running");
  expect(user("r1", "m1", { scheduledTaskId: "task-1" })).toMatchObject([{ type: "message.done", payload: { scheduled_task: { task_id: "task-1", title: "Nightly triage" } } }]);
  expect(user("r1", "m2", { scheduledTaskId: "gone" })[0]!.payload).toEqual({ role: "user", text: "m2 text", scheduled_task: { task_id: "gone" } });
  expect(user("r1", "m3")[0]!.payload).not.toHaveProperty("scheduled_task");
  expect(user("r2", "m4", { scheduledTaskId: "task-1" })).toEqual([]);
  expect(run("r2", "running").find((e) => e.type === "message.done")).toMatchObject({ payload: { scheduled_task: { title: "Nightly triage" } } });
});

test("an automatic delivery never shows as the person's bubble; its turn still starts and ends", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-15T00:00:00.000Z", displayText: () => undefined, sender: (id: string) => (id === "caveman:peer" ? { workspace_id: "peer", title: "Peer" } : undefined) };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } });
  const message = (id: string, fields: object) => project({ type: "message.updated", payload: { id, role: "user", text: `${id} text`, runId: null, ...fields } });
  const user = (runId: string, messageId: string, fields: object = {}) =>
    project({ type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: `${messageId} text`, attachments: [], parentItemId: null, ...fields } });

  // A delegated task's result and a background wake: hidden even if T3 ever files them as user_message items.
  run("r1", "queued");
  expect(message("wake", { delegatedCompletion: { parentRunId: "r0", generation: 1, taskIds: ["t1"] } })).toEqual([]);
  expect(message("bg", { notification: { source: { kind: "background_task" }, outcome: "updated", summary: "Background activity updated" } })).toEqual([]);
  expect(user("r1", "wake")).toEqual([]);
  const started = run("r1", "running");
  expect(started.map((e) => e.type)).toEqual(["turn.started"]);
  expect(user("r1", "bg")).toEqual([]);
  // What T3 files them as today: a notification row.
  expect(project({ type: "turn-item.updated", payload: { type: "notification", id: "n1", runId: "r1", parentItemId: null, outcome: "completed", summary: 'Delegated task "Fix" finished' } })).toMatchObject([
    { type: "notification", payload: { level: "info", title: 'Delegated task "Fix" finished' } },
  ]);
  expect(run("r1", "completed").map((e) => e.type)).toEqual(["turn.done"]);

  // A peer's automatic reply, a scheduled prompt and the person's own words still show.
  run("r2", "running");
  message("reply", { senderThreadId: "caveman:peer", notification: { source: { kind: "system" }, outcome: "updated", summary: "x" } });
  expect(user("r2", "reply", { senderThreadId: "caveman:peer" })).toMatchObject([{ type: "message.done", payload: { from: { workspace_id: "peer" } } }]);
  message("scheduled", { scheduledTaskId: "task-1", notification: { source: { kind: "system" }, outcome: "updated", summary: "x" } });
  expect(user("r2", "scheduled", { scheduledTaskId: "task-1" })).toMatchObject([{ type: "message.done", payload: { role: "user" } }]);
  message("mine", {});
  expect(user("r2", "mine")).toMatchObject([{ type: "message.done", payload: { role: "user", text: "mine text" } }]);
});

test("compaction streams as started then done; a done-only engine sends done alone; a retry is one event per attempt", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-15T00:00:00.000Z", displayText: () => undefined };
  const project = (payload: object) => projectEvent(state, { type: "turn-item.updated", payload: { runId: "r1", parentItemId: null, ...payload } } as unknown as OrchestrationV2DomainEvent, ctx).events;

  // Codex: running, then completed.
  expect(project({ id: "c1", type: "compaction", status: "running" })).toMatchObject([{ type: "compaction.started", item_id: "c1" }]);
  expect(project({ id: "c1", type: "compaction", status: "running" })).toEqual([]);
  expect(project({ id: "c1", type: "compaction", status: "completed", beforeTokenCount: 182000, afterTokenCount: 31000 })).toMatchObject([
    { type: "compaction.done", item_id: "c1", payload: { status: "completed", before_tokens: 182000, after_tokens: 31000 } },
  ]);
  expect(project({ id: "c1", type: "compaction", status: "completed" })).toEqual([]);
  // Claude: only the result.
  expect(project({ id: "c2", type: "compaction", status: "completed" })).toMatchObject([{ type: "compaction.done", payload: { status: "completed" } }]);

  const failure = { message: "Overloaded" };
  const first = DateTime.makeUnsafe("2026-10-15T00:00:00.000Z");
  const retry = (startedAt: DateTime.Utc, status: string, attempt: number, maxAttempts: number | null = 5) =>
    project({ id: "e1", type: "error", status, startedAt, failure, retry: { attempt, maxAttempts, retryDelayMs: maxAttempts === null ? null : 2000 } });
  expect(retry(first, "running", 1)).toMatchObject([
    { type: "error", item_id: `e1@${DateTime.toEpochMillis(first)}`, payload: { message: "Overloaded", retry: { attempt: 1, max_attempts: 5, delay_ms: 2000 } } },
  ]);
  expect(retry(first, "running", 1)).toEqual([]);
  const second = retry(first, "running", 2, null);
  expect(second).toMatchObject([{ type: "error", payload: { retry: { attempt: 2 } } }]);
  expect((second[0]!.payload as { retry: object }).retry).toEqual({ attempt: 2 });
  // The call recovered; a later failure in the same provider turn starts a new burst and a new line.
  expect(retry(first, "completed", 2)).toEqual([]);
  const later = DateTime.makeUnsafe("2026-10-15T00:01:00.000Z");
  expect(retry(later, "running", 1)).toMatchObject([{ type: "error", item_id: `e1@${DateTime.toEpochMillis(later)}`, payload: { retry: { attempt: 1 } } }]);
});

// usage events carry the engine of the run that spent the tokens, so
// spend.summary by engine splits a workspace's spend at a handoff (and folds
// further Codex accounts into the one Codex engine).


const ctx = { at: "2026-10-15T00:00:00.000Z", displayText: () => undefined };
const run = (id: string, providerInstanceId: string, rootNodeId: string) =>
  ({ type: "run.created", payload: { id, status: "running", modelSelection: { model: "m" }, providerInstanceId, rootNodeId } }) as never;
const spent = (id: string, nodeId: string) =>
  ({ type: "provider-turn.updated", payload: { id, nodeId, turnTokenUsage: { inputTokens: 10, outputTokens: 2 } } }) as never;

describe("projector grill mode", () => {
  test("the thread's mode reaches turn.started; a round still open when its turn ends is cancelled", () => {
    const state = emptyThreadState();
    const mode = (interactionMode: string) => ({ type: "thread.interaction-mode-updated", payload: { interactionMode } }) as never;
    expect(projectEvent(state, mode("grill"), ctx).mode).toBe("grill");
    expect(projectEvent(state, mode("grill"), ctx).mode).toBeUndefined();
    expect(projectEvent(state, run("r1", "claudeAgent", "n1"), ctx).events[0]).toMatchObject({ type: "turn.started", payload: { mode: "grill" } });
    state.asks["grill:a1"] = "open";
    state.asks["approval-1"] = "open";
    const done = projectEvent(
      state,
      { type: "run.updated", payload: { id: "r1", status: "completed", modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: "n1" } } as never,
      ctx,
    ).events;
    expect(done.map((e) => e.type)).toEqual(["ask.resolved", "turn.done"]);
    expect(done[0]).toMatchObject({ item_id: "grill:a1", turn_id: "r1", payload: { outcome: "cancelled" } });
    expect(state.asks["approval-1"]).toBe("open");
  });

  test("the grill tools draw as their round, never as tool rows; proposed plans never reach the wire", () => {
    const state = emptyThreadState();
    const tool = (id: string, toolName: string, input: unknown = {}) =>
      ({ type: "turn-item.updated", payload: { id, runId: "r1", type: "dynamic_tool", toolName, input, status: "completed" } }) as never;
    const shown = [
      tool("c1", "mcp__caveman-grill__grill_round"),
      tool("c2", "ToolSearch", { query: "select:mcp__caveman-grill__grill_round,mcp__caveman-grill__grill_finish" }),
      tool("x1", "caveman-grill.grill_finish"),
      tool("v1", "mcp__caveman_grill__grill_round"),
      tool("k1", "mcp__linear__list_issues"),
      tool("k2", "ToolSearch", { query: "select:mcp__linear__list_issues" }),
    ].flatMap((event) => projectEvent(state, event, ctx).events);
    expect(shown.filter((e) => e.type === "tool.started").map((e) => e.item_id)).toEqual(["k1", "k2"]);
    expect(shown.filter((e) => e.type === "tool.done").map((e) => e.item_id)).toEqual(["k1", "k2"]);
    const plan = (kind: string) => ({ type: "plan.updated", payload: { id: `p-${kind}`, runId: "r1", kind, steps: [], markdown: "## Plan" } }) as never;
    expect(projectEvent(state, plan("proposed_plan"), ctx).events).toEqual([]);
    expect(projectEvent(state, plan("todo_list"), ctx).events[0]).toMatchObject({ type: "plan.updated", payload: { kind: "todos" } });
  });

  test("a ToolSearch started before its query waits for it: a grill load never shows, and no row is left running", () => {
    const state = emptyThreadState();
    const tool = (id: string, toolName: string, input: unknown, status: string) =>
      ({ type: "turn-item.updated", payload: { id, runId: "r1", type: "dynamic_tool", toolName, input, status } }) as never;
    const grillQuery = { query: "select:mcp__caveman-grill__grill_round,mcp__caveman-grill__grill_finish" };
    const shown = [
      // Claude shows the call as the model begins it, input still empty.
      tool("g1", "ToolSearch", {}, "inProgress"),
      tool("g1", "ToolSearch", grillQuery, "inProgress"),
      tool("g1", "ToolSearch", grillQuery, "completed"),
      tool("s1", "ToolSearch", {}, "inProgress"),
      tool("s1", "ToolSearch", { query: "select:mcp__linear__list_issues" }, "inProgress"),
      tool("s1", "ToolSearch", { query: "select:mcp__linear__list_issues" }, "completed"),
      // Ended before a query ever came: it shows, and ends.
      tool("e1", "ToolSearch", {}, "failed"),
    ].flatMap((event) => projectEvent(state, event, ctx).events);
    expect(shown.filter((e) => e.type === "tool.started").map((e) => e.item_id)).toEqual(["s1", "e1"]);
    expect(shown.filter((e) => e.type === "tool.done").map((e) => e.item_id)).toEqual(["s1", "e1"]);
    expect((shown.find((e) => e.type === "tool.started")!.payload as { input: unknown }).input).toEqual({ query: "select:mcp__linear__list_issues" });
    // A row already out that turns out to load the grill tools keeps its line and still ends.
    const late = [
      tool("w1", "ToolSearch", { query: "grill" }, "inProgress"),
      tool("w1", "ToolSearch", grillQuery, "inProgress"),
      tool("w1", "ToolSearch", grillQuery, "completed"),
    ].flatMap((event) => projectEvent(state, event, ctx).events);
    expect(late.map((e) => e.type)).toEqual(["tool.started", "tool.done"]);
  });

  test("Claude's Read, Grep, Glob and LS are reads and searches, not unnamed tools", () => {
    const state = emptyThreadState();
    const tool = (id: string, toolName: string) =>
      ({ type: "turn-item.updated", payload: { id, runId: "r1", type: "dynamic_tool", toolName, title: "src/app.ts", input: {}, status: "inProgress" } }) as never;
    const kinds = [tool("a", "Read"), tool("b", "Grep"), tool("c", "Glob"), tool("d", "LS"), tool("e", "TodoWrite"), tool("f", "mcp__linear__list_issues")]
      .flatMap((event) => projectEvent(state, event, ctx).events)
      .filter((e) => e.type === "tool.started")
      .map((e) => (e.payload as { kind: string }).kind);
    expect(kinds).toEqual(["read", "search", "search", "search", "other", "mcp"]);
  });
});

describe("projector tool failures", () => {
  test("a failed code cell or MCP call carries its error into tool.done; a successful one carries none", () => {
    const state = emptyThreadState();
    const item = (id: string, status: string, output?: unknown) =>
      ({ type: "turn-item.updated", payload: { id, runId: "r1", type: "dynamic_tool", toolName: "mcp__caveman_code__delegate_task", input: {}, status, ...(output === undefined ? {} : { output }) } }) as never;
    const events = [item("f1", "failed", { isError: true, error: "mcp_tool_error: target.model must not be empty" }), item("ok1", "completed", { taskId: "t1" })].flatMap(
      (event) => projectEvent(state, event, ctx).events,
    );
    const done = events.filter((e) => e.type === "tool.done");
    expect(done[0]).toMatchObject({ item_id: "f1", payload: { status: "failed", error: "mcp_tool_error: target.model must not be empty" } });
    expect(done[1]!.payload).toEqual({ status: "completed", result: { taskId: "t1" } });
    // A bash call that failed outright (in a code cell too) shows its error as the row's output.
    const bash = { type: "turn-item.updated", payload: { id: "b1", runId: "r1", type: "command_execution", input: "sleep 900", status: "failed", output: "bash could not start: limit" } } as never;
    const shown = projectEvent(state, bash, ctx).events;
    expect(shown.map((e) => e.type)).toEqual(["tool.started", "tool.output", "tool.done"]);
    expect(shown[1]!.payload).toEqual({ text: "bash could not start: limit" });
    expect(shown[2]!.payload).toMatchObject({ status: "failed" });
  });
});

describe("projector own tools on other threads", () => {
  // The daemon's answers: a workspace, a delegated child's thread with none, and a thread no longer known (undefined).
  const known: Record<string, { workspace_id?: string; title: string }> = {
    "caveman:checkout": { workspace_id: "w-checkout", title: "Fix checkout" },
    "child-1": { title: "Review stage 3a" },
    "caveman:new-a": { workspace_id: "w-a", title: "Fix login" },
    "caveman:new-b": { workspace_id: "w-b", title: "Fix logout" },
  };
  const threadCtx = { ...ctx, toolThread: (id: string) => known[id] };
  const tool = (id: string, toolName: string, input: object, status: string, output?: unknown) =>
    ({ type: "turn-item.updated", payload: { id, runId: "r1", type: "dynamic_tool", toolName, input, status, ...(output === undefined ? {} : { output }) } }) as never;

  test("thread_send names its target on tool.started, by its workspace when it has one, and its result on tool.done", () => {
    const state = emptyThreadState();
    const send = (status: string, output?: unknown) => projectEvent(state, tool("t1", "mcp__caveman-code__thread_send", { threadId: "caveman:checkout", message: "Land it" }, status, output), threadCtx).events;
    expect(send("inProgress")).toMatchObject([{ type: "tool.started", payload: { name: "mcp__caveman-code__thread_send", threads: [{ workspace_id: "w-checkout", title: "Fix checkout" }] } }]);
    const done = send("completed", { threadId: "caveman:checkout", messageId: "m1" }).find((e) => e.type === "tool.done")!;
    expect(done.payload).toMatchObject({ status: "completed", threads: [{ workspace_id: "w-checkout", title: "Fix checkout" }] });
    // A delegated child's thread has no workspace: its title alone.
    const child = projectEvent(emptyThreadState(), tool("t2", "caveman-code.thread_read", { threadId: "child-1" }, "completed"), threadCtx).events;
    expect(child[0]!.payload).toMatchObject({ threads: [{ title: "Review stage 3a" }] });
    expect((child[0]!.payload as { threads: ReadonlyArray<object> }).threads[0]).not.toHaveProperty("workspace_id");
  });

  test("the threads thread_launch and create_threads made are named on tool.done; an unknown thread and other tools name none", () => {
    const launched = projectEvent(emptyThreadState(), tool("l1", "mcp__caveman-code__thread_launch", { title: "Fix login", message: "Go" }, "completed", { threadId: "caveman:new-a" }), threadCtx).events;
    expect(launched[0]!.payload).not.toHaveProperty("threads");
    expect(launched.find((e) => e.type === "tool.done")!.payload).toMatchObject({ threads: [{ workspace_id: "w-a", title: "Fix login" }] });
    const created = projectEvent(
      emptyThreadState(),
      tool("c1", "mcp__caveman-code__create_threads", { threads: [{ prompt: "A" }, { prompt: "B" }] }, "completed", { threads: [{ threadId: "caveman:new-a" }, { threadId: "caveman:new-b" }] }),
      threadCtx,
    ).events;
    expect(created.find((e) => e.type === "tool.done")!.payload).toMatchObject({ threads: [{ title: "Fix login" }, { title: "Fix logout" }] });
    // A failed launch made nothing; a thread the runtime no longer knows, and a tool on no thread, name none.
    const failed = projectEvent(emptyThreadState(), tool("l2", "mcp__caveman-code__thread_launch", { title: "X" }, "failed", { isError: true, error: "nope" }), threadCtx).events;
    expect(failed.find((e) => e.type === "tool.done")!.payload).not.toHaveProperty("threads");
    expect(projectEvent(emptyThreadState(), tool("u1", "mcp__caveman-code__thread_wait", { threadId: "gone" }, "completed"), threadCtx).events[0]!.payload).not.toHaveProperty("threads");
    expect(projectEvent(emptyThreadState(), tool("o1", "mcp__caveman-code__list_scheduled_tasks", { threadId: "caveman:checkout" }, "completed"), threadCtx).events[0]!.payload).not.toHaveProperty("threads");
  });
});

describe("projector web searches and page reads", () => {
  const web = (id: string, status: string, fields: object = {}) =>
    ({ type: "turn-item.updated", payload: { id, runId: "r1", parentItemId: null, type: "web_search", title: null, status, ...fields } }) as never;
  const project = (...events: ReadonlyArray<never>) => {
    const state = emptyThreadState();
    return events.flatMap((event) => projectEvent(state, event, ctx).events);
  };
  const started = (events: ReadonlyArray<DraftEvent>) => events.filter((e) => e.type === "tool.started").map((e) => e.payload);
  const result = (events: ReadonlyArray<DraftEvent>) => (events.find((e) => e.type === "tool.done")!.payload as { result?: unknown }).result;

  test("Claude's WebSearch is a search titled by its query; its hits are titles and addresses", () => {
    // ClaudeAdapterV2: patterns from the tool's `query`, results `{ title, url }` from its search output.
    const events = project(
      web("w1", "running", { patterns: ["FIFA World Cup 2026 ticket pricing"] }),
      web("w1", "completed", {
        patterns: ["FIFA World Cup 2026 ticket pricing"],
        results: [
          { title: " Tickets | FIFA World Cup 2026™ ", url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/tickets" },
          { title: "Ticket prices", url: "https://gpcustomersupportfwc2026.tickets.fifa.com/hc/en-gb/articles/1" },
        ],
      }),
    );
    expect(started(events)).toEqual([{ name: "web_search", title: "FIFA World Cup 2026 ticket pricing", kind: "web", input: { queries: ["FIFA World Cup 2026 ticket pricing"] } }]);
    expect(result(events)).toEqual([
      { title: "Tickets | FIFA World Cup 2026™", url: "https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/tickets" },
      { title: "Ticket prices", url: "https://gpcustomersupportfwc2026.tickets.fifa.com/hc/en-gb/articles/1" },
    ]);
  });

  test("Claude's WebFetch is a page read titled by its site; the page's text never reaches the wire", () => {
    // ClaudeAdapterV2: patterns from the tool's `url`, one result `{ url, snippet }` with up to 8,000 characters of the page.
    const url = "https://www.example.com/docs/retry?lang=en";
    const events = project(web("f1", "running", { patterns: [url] }), web("f1", "completed", { patterns: [url], results: [{ url, snippet: "x".repeat(8000) }] }));
    expect(started(events)).toEqual([{ name: "web_fetch", title: "example.com", kind: "web", input: { url } }]);
    expect(result(events)).toEqual([{ url }]);
  });

  test("Codex's search waits for its query before it opens; an openPage or findInPage is a page read", () => {
    // CodexAdapterV2: item/started carries `query: ""` and no action (no patterns), item/completed the query; results come through null.
    const search = project(web("c1", "running"), web("c1", "completed", { patterns: ["FIFA World Cup 2026 ticket prices official"] }));
    expect(search.map((e) => e.type)).toEqual(["tool.started", "tool.done"]);
    expect(started(search)).toMatchObject([{ name: "web_search", title: "FIFA World Cup 2026 ticket prices official" }]);
    expect(result(search)).toBeUndefined();
    // openPage: [url, query]; findInPage: [pattern, url, query].
    expect(started(project(web("c2", "completed", { patterns: ["https://docs.python.org/3/library/asyncio.html", "asyncio"] })))).toMatchObject([
      { name: "web_fetch", title: "docs.python.org", input: { url: "https://docs.python.org/3/library/asyncio.html" } },
    ]);
    expect(started(project(web("c3", "completed", { patterns: ["TaskGroup", "http://localhost:8080/guide", "asyncio"] })))).toMatchObject([{ name: "web_fetch", title: "localhost:8080" }]);
    // One that never learns its query still shows once it ends.
    expect(started(project(web("c4", "running"), web("c4", "completed")))).toEqual([{ name: "web_search", title: "", kind: "web", input: {} }]);
  });

  test("an ACP agent's search keeps its sources' addresses; its fetch is a page read", () => {
    // provider-acp: a backend search titled "Web search: <query>" with bare `{ url }` sources; a fetch `{ url, snippet }` under its path.
    const search = project(
      web("a1", "completed", {
        title: "Web search: effect schema union",
        patterns: ["effect schema union"],
        results: [{ url: "https://effect.website/docs/schema/basic-usage" }, { url: "https://effect.website/docs/schema/basic-usage" }, { url: "file:///etc/hosts" }, { url: "javascript:alert(1)" }, { url: "not a url" }, {}],
      }),
    );
    expect(started(search)).toMatchObject([{ name: "web_search", title: "effect schema union" }]);
    expect(result(search)).toEqual([{ url: "https://effect.website/docs/schema/basic-usage" }]);
    const fetch = project(web("a2", "completed", { patterns: ["https://effect.website/docs"], results: [{ url: "https://effect.website/docs", snippet: "Effect docs" }] }));
    expect(started(fetch)).toMatchObject([{ name: "web_fetch", title: "effect.website" }]);
    expect(result(fetch)).toEqual([{ url: "https://effect.website/docs" }]);
    // A search with no address left has no result at all.
    expect(result(project(web("a3", "completed", { patterns: ["q"], results: [{ url: "ftp://example.com/a" }] })))).toBeUndefined();
  });

  test("a query that only mentions a site is still a search, and both stay web for taint", () => {
    const events = project(web("q1", "completed", { patterns: ["site:github.com effect-ts issues", "https://github.com is down"] }));
    expect(started(events)).toMatchObject([{ name: "web_search", kind: "web", title: "site:github.com effect-ts issues" }]);
  });
});

describe("projector usage", () => {
  test("usage carries a turn's web searches as a count, only when it ran some", () => {
    const state = emptyThreadState();
    const searched = (id: string, nodeId: string, webSearches?: number) =>
      ({ type: "provider-turn.updated", payload: { id, nodeId, turnTokenUsage: { inputTokens: 10, outputTokens: 2, ...(webSearches === undefined ? {} : { webSearches }) } } }) as never;
    const events = [run("r1", "claudeAgent", "n1"), searched("t1", "n1", 3), run("r2", "claudeAgent", "n2"), searched("t2", "n2")].flatMap(
      (event) => projectEvent(state, event, ctx).events,
    );
    const [first, second] = events.filter((e) => e.type === "usage").map((e) => e.payload);
    expect(first).toMatchObject({ engine: "claude-agent", input_tokens: 10, web_searches: 3, cost: null });
    expect(second).not.toHaveProperty("web_searches");
  });

  test("a turn that reports its running total as it goes (Muse) records the total it ended with, once", () => {
    const state = emptyThreadState();
    const update = (status: string, inputTokens: number, cachedInputTokens: number, outputTokens: number) =>
      ({ type: "provider-turn.updated", payload: { id: "t1", nodeId: "n1", status, turnTokenUsage: { usageScope: "main_agent", usageStatus: "partial", hasSubagents: false, inputTokens, cachedInputTokens, outputTokens } } }) as never;
    // The recorded subagent_v2 Muse turn: four model calls, each update the turn's total so far.
    const events = [
      run("r1", "muse", "n1"),
      update("running", 32900, 0, 129),
      update("running", 66044, 32625, 252),
      update("running", 99404, 65762, 342),
      update("running", 132949, 98899, 370),
      update("completed", 132949, 98899, 370),
      update("completed", 132949, 98899, 370),
    ].flatMap((event) => projectEvent(state, event, ctx).events);
    expect(events.filter((e) => e.type === "usage").map((e) => e.payload)).toEqual([
      expect.objectContaining({ engine: "muse", input_tokens: 132949 - 98899, cache_read_tokens: 98899, output_tokens: 370 }),
    ]);
  });

  test("usage after a handoff carries the new run's engine", () => {
    const state = emptyThreadState();
    const events = [run("r1", "claudeAgent", "n1"), spent("t1", "n1"), run("r2", "codex-account-0a1b2c3d", "n2"), spent("t2", "n2")].flatMap(
      (event) => projectEvent(state, event, ctx).events,
    );
    expect(events.filter((e) => e.type === "usage").map((e) => [e.turn_id, (e.payload as { engine?: string }).engine])).toEqual([
      ["r1", "claude-agent"],
      ["r2", "codex"],
    ]);
  });
});

describe("projector route lines", () => {
  test("the Caveman engine's own route reaches the wire as model.routed, and its usage names the routed model", () => {
    const state = emptyThreadState();
    const routed = { type: "turn-item.updated", payload: { id: "route-1", runId: "r1", type: "system_notice", status: "completed", message: "Routed to openai/gpt-6-luna", routedModel: "openai/gpt-6-luna" } } as never;
    const events = [run("r1", "caveman", "n1"), routed, routed, spent("t1", "n1")].flatMap((event) => projectEvent(state, event, ctx).events);
    expect(events.filter((e) => e.type === "model.routed")).toMatchObject([{ turn_id: "r1", payload: { model: "openai/gpt-6-luna" } }]);
    expect(events.find((e) => e.type === "usage")).toMatchObject({ payload: { engine: "caveman", model: "openai/gpt-6-luna" } });
    expect(events.some((e) => e.type === "notification")).toBe(false);
  });

  test("usage names the model the engine says the turn ran on, over Auto's selection, and prices it", () => {
    const state = emptyThreadState();
    const auto = { type: "run.created", payload: { id: "r1", status: "running", modelSelection: { model: "auto" }, providerInstanceId: "caveman", rootNodeId: "n1" } } as never;
    const spentOn = { type: "provider-turn.updated", payload: { id: "t1", nodeId: "n1", turnTokenUsage: { inputTokens: 1_000_000, outputTokens: 0, model: "openai/gpt-5-nano" } } } as never;
    const events = [auto, spentOn].flatMap((event) => projectEvent(state, event, { ...ctx, billing: () => "api_key" as const }).events);
    expect(events.find((e) => e.type === "usage")).toMatchObject({ payload: { model: "openai/gpt-5-nano", cost: { usd: 0.05, basis: "list_price" } } });
  });

  test("a Caveman turn the engine says ran on the person's plan (Sign in with ChatGPT) is the plan's, unpriced", () => {
    const state = emptyThreadState();
    const auto = { type: "run.created", payload: { id: "r1", status: "running", modelSelection: { model: "auto" }, providerInstanceId: "caveman", rootNodeId: "n1" } } as never;
    const onPlan = { type: "provider-turn.updated", payload: { id: "t1", nodeId: "n1", turnTokenUsage: { inputTokens: 1_000_000, outputTokens: 0, model: "openai/gpt-5-nano", billing: "plan" } } } as never;
    const events = [auto, onPlan].flatMap((event) => projectEvent(state, event, { ...ctx, billing: () => "api_key" as const }).events);
    expect(events.find((e) => e.type === "usage")).toMatchObject({ payload: { model: "openai/gpt-5-nano", billing: "plan", cost: null } });
  });
});

describe("projector usage pricing and timing", () => {
  test("Claude API-key logins are priced; subscription and unknown logins keep dollars unknown", () => {
    const snapshot = (instanceId: string, type: string) => ({ instanceId, auth: { status: "authenticated", type } }) as never;
    const billing = usageBilling({}, [snapshot("claudeAgent", "apiKey"), snapshot("claude-agent:plan", "claude_max_20x_subscription")]);
    expect(billing("claudeAgent", "claude-agent")).toBe("api_key");
    expect(billing("claude-agent:plan", "claude-agent")).toBe("plan");
    // A login Claude doesn't describe stays a plan's: never priced on a guess.
    expect(billing("missing", "claude-agent")).toBe("plan");
    const state = emptyThreadState();
    const context = { ...ctx, billing };
    const run = { type: "run.created", payload: { id: "r1", status: "running", modelSelection: { model: "claude-opus-5-5" }, providerInstanceId: "claudeAgent", rootNodeId: "n1" } } as never;
    const usage = { type: "provider-turn.updated", payload: { id: "t1", nodeId: "n1", turnTokenUsage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 0, cacheCreationTokens: 300_000, cacheCreation1hTokens: 100_000 } } } as never;
    const events = [run, usage].flatMap((e) => projectEvent(state, e, context).events);
    expect(events.find((e) => e.type === "usage")).toMatchObject({ payload: { engine: "claude-agent", billing: "api_key", cost: { usd: 6.6, basis: "list_price" } } });
  });

  test("a turn whose usage the engine never reported (a Claude Agent turn stopped mid-way) records no usage, never a measured $0", () => {
    const state = emptyThreadState();
    const context = { ...ctx, billing: () => "api_key" as const };
    const claude = { type: "run.created", payload: { id: "r1", status: "running", modelSelection: { model: "claude-opus-5-5" }, providerInstanceId: "claudeAgent", rootNodeId: "n1" } } as never;
    // What the adapter attaches to a turn whose SDK result carried no usage, as on a Stop.
    const stopped = { type: "provider-turn.updated", payload: { id: "t1", nodeId: "n1", status: "interrupted", turnTokenUsage: normalizeClaudeTurnTokenUsage(undefined, false, "interrupted") } } as never;
    const events = [claude, stopped].flatMap((e) => projectEvent(state, e, context).events);
    expect(events.filter((e) => e.type === "usage")).toEqual([]);
  });

  test("a turn whose total leaves a count out records no usage until one names both, never that count as 0", () => {
    const state = emptyThreadState();
    const context = { ...ctx, billing: () => "api_key" as const };
    const claude = { type: "run.created", payload: { id: "r1", status: "running", modelSelection: { model: "claude-opus-5-5" }, providerInstanceId: "claudeAgent", rootNodeId: "n1" } } as never;
    const ended = (turnTokenUsage: unknown) => ({ type: "provider-turn.updated", payload: { id: "t1", nodeId: "n1", status: "completed", turnTokenUsage } }) as never;
    const partial = ended({ usageScope: "turn", usageStatus: "partial", hasSubagents: false, inputTokens: 1_000 });
    expect([claude, partial].flatMap((e) => projectEvent(state, e, context).events).filter((e) => e.type === "usage")).toEqual([]);
    const settled = ended({ usageScope: "turn", usageStatus: "complete", hasSubagents: false, inputTokens: 1_000, outputTokens: 200 });
    expect(projectEvent(state, settled, context).events.filter((e) => e.type === "usage")).toMatchObject([{ payload: { input_tokens: 1_000, output_tokens: 200 } }]);
  });

  test("the web searches of a turn whose tokens the engine never said still reach Settings, on the chat's next usage from that engine", () => {
    const state = emptyThreadState();
    // The Claude Agent adapter's own counting: modelUsage is cumulative per CLI process, WebSearch's searches land on the side model.
    let processSearches = 0;
    const claudeTurn = (id: string, nodeId: string, status: "completed" | "interrupted", result: { subtype: "success" | "error_during_execution"; usage: unknown; modelUsage: unknown }) => {
      const searched = claudeTurnWebSearches(result, processSearches);
      processSearches = searched.processSearches;
      return { type: "provider-turn.updated", payload: { id, nodeId, status, turnTokenUsage: normalizeClaudeTurnTokenUsage(result, false, status, [], searched.turn) } } as never;
    };
    const spentTokens = { input_tokens: 3, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const noTokens = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
    const searchedSoFar = (n: number) => ({ "claude-sonnet-4-6": { webSearchRequests: 0 }, "claude-haiku-4-5": { webSearchRequests: n } });
    const searchesOf = (events: ReadonlyArray<DraftEvent>) =>
      events.filter((e) => e.type === "usage").map((e) => [e.turn_id, (e.payload as { engine?: string }).engine, (e.payload as { web_searches?: number }).web_searches]);
    const events = [
      run("r1", "claudeAgent", "n1"),
      claudeTurn("t1", "n1", "completed", { subtype: "success", usage: spentTokens, modelUsage: searchedSoFar(1) }),
      // A background agent searched twice more; the next turn is stopped before its first model call answers.
      run("r2", "claudeAgent", "n2"),
      claudeTurn("t2", "n2", "interrupted", { subtype: "error_during_execution", usage: noTokens, modelUsage: searchedSoFar(3) }),
      // Another engine's turn in the same chat never takes them.
      run("r3", "codex", "n3"),
      spent("t3", "n3"),
      run("r4", "claudeAgent", "n4"),
      claudeTurn("t4", "n4", "completed", { subtype: "success", usage: spentTokens, modelUsage: searchedSoFar(3) }),
      run("r5", "claudeAgent", "n5"),
      claudeTurn("t5", "n5", "completed", { subtype: "success", usage: spentTokens, modelUsage: searchedSoFar(3) }),
    ].flatMap((event) => projectEvent(state, event, ctx).events);
    expect(searchesOf(events)).toEqual([
      ["r1", "claude-agent", 1],
      ["r3", "codex", undefined],
      ["r4", "claude-agent", 2],
      ["r5", "claude-agent", undefined],
    ]);
    // A total the stopped turn names both counts in later is its own record, with its own searches, never counted twice.
    const later = emptyThreadState();
    const ended = (id: string, nodeId: string, turnTokenUsage: unknown) => ({ type: "provider-turn.updated", payload: { id, nodeId, status: "interrupted", turnTokenUsage } }) as never;
    const settled = [
      run("r1", "claudeAgent", "n1"),
      ended("t1", "n1", { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false, webSearches: 2 }),
      ended("t1", "n1", { usageScope: "main_agent", usageStatus: "partial", hasSubagents: false, inputTokens: 10, outputTokens: 2, webSearches: 2 }),
      run("r2", "claudeAgent", "n2"),
      spent("t2", "n2"),
    ].flatMap((event) => projectEvent(later, event, ctx).events);
    expect(searchesOf(settled)).toEqual([
      ["r1", "claude-agent", 2],
      ["r2", "claude-agent", undefined],
    ]);
  });

  test("Codex on an API key is priced at the catalog's list price; on a ChatGPT login it is a plan's; turns carry TTFT and length", () => {
    const state = emptyThreadState();
 // The daemon's billing over server settings where the compact toggle made its own instance.
    const billing = usageBilling({ codex: { config: {} }, "codex-account-chatgpt": { config: { chatGptLogin: true } } });
    expect([billing("caveman", "caveman"), billing("claudeAgent", "claude-agent"), billing("codex-other", "codex")]).toEqual(["api_key", "plan", "api_key"]);
    const codexRun = (id: string, instance: string, node: string) =>
      ({ type: "run.created", payload: { id, status: "running", modelSelection: { model: "gpt-6.1-sol" }, providerInstanceId: instance, rootNodeId: node } }) as never;
    const delta = (runId: string) => ({ type: "message.updated", payload: { id: `m-${runId}`, runId, role: "assistant", text: "hi", streaming: true } }) as never;
    const usage = (id: string, node: string) =>
      ({ type: "provider-turn.updated", payload: { id, nodeId: node, turnTokenUsage: { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 0 } } }) as never;
    const at = (iso: string) => ({ ...ctx, at: iso, billing });
    const events = [
      projectEvent(state, codexRun("r1", "codex", "n1"), at("2026-10-16T00:00:00.000Z")),
      projectEvent(state, delta("r1"), at("2026-10-16T00:00:01.500Z")),
      projectEvent(state, usage("t1", "n1"), at("2026-10-16T00:00:09.000Z")),
      projectEvent(state, codexRun("r2", "codex-account-chatgpt", "n2"), at("2026-10-16T00:01:00.000Z")),
      projectEvent(state, usage("t2", "n2"), at("2026-10-16T00:01:05.000Z")),
    ].flatMap((r) => r.events);
    const [apiKey, plan] = events.filter((e) => e.type === "usage").map((e) => e.payload as Record<string, unknown>);
    // gpt-6.1-sol lists at $2 in / $10 out per million tokens in the bundled catalog.
    expect(apiKey).toMatchObject({ engine: "codex", billing: "api_key", cost: { usd: 3, basis: "list_price" }, ttft_ms: 1500, duration_ms: 9000 });
    expect(plan).toMatchObject({ engine: "codex", billing: "plan", cost: null, duration_ms: 5000 });
    expect(plan!.ttft_ms).toBeUndefined();
  });
});

test("an ACP session notice is a notification with its title and description apart, not reply text", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-28T00:00:00.000Z", displayText: () => undefined };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  project({ type: "run.updated", payload: { id: "r1", status: "running", modelSelection: { model: "grok-build" }, providerInstanceId: "grok", rootNodeId: null } });
  const withDescription = project({ type: "turn-item.updated", payload: { id: "n1", runId: "r1", parentItemId: null, type: "system_notice", status: "completed", title: "Context compacted", message: "Context compacted\n\nOlder turns were summarized." } });
  expect(withDescription.map((e) => [e.type, e.payload])).toEqual([["notification", { level: "info", title: "Context compacted", body: "Older turns were summarized." }]]);
  const titleOnly = project({ type: "turn-item.updated", payload: { id: "n2", runId: "r1", parentItemId: null, type: "system_notice", status: "completed", title: "Model switched", message: "Model switched" } });
  expect(titleOnly.map((e) => [e.type, e.payload])).toEqual([["notification", { level: "info", title: "Model switched" }]]);
});

test("a usage limit shows once: the notice, not the CLI's own limit text and a failure banner too", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "claude-haiku-5-5" }, providerInstanceId: "claudeAgent", rootNodeId: null } });
  // As acceptance journey 1 saw it on Claude Haiku 5.5 at the weekly limit.
  run("r1", "running");
  const notice = project({ type: "turn-item.updated", payload: { id: "n1", runId: "r1", parentItemId: null, type: "system_notice", status: "completed", message: "Claude usage limit reached. This turn is paused until the 7-day limit resets in 30h 11m." } });
  expect(notice.map((e) => e.type)).toEqual(["notification"]);
  expect(project({ type: "message.updated", payload: { id: "m1", runId: "r1", role: "assistant", text: "You've hit your weekly limit · resets Oct 18 at 7am (America/Los_Angeles)", streaming: false } })).toEqual([]);
  project({ type: "turn-item.updated", payload: { id: "e1", runId: "r1", parentItemId: null, type: "error", status: "failed", startedAt: null, failure: { message: "Claude API rate limit reached. Try again later.", class: "usage_limit" } } });
  // The notice said it: no failure text, though the engine's class still marks the turn (telemetry counts it).
  expect(run("r1", "failed").map((e) => [e.type, e.payload])).toEqual([["turn.done", { status: "failed", failure: { class: "usage_limit" } }]]);
  // Without a notice, the failure keeps its text and the engine's words stay.
  run("r2", "running");
  expect(project({ type: "message.updated", payload: { id: "m2", runId: "r2", role: "assistant", text: "You've hit your weekly limit · resets Oct 18", streaming: false } })).toHaveLength(1);
  project({ type: "turn-item.updated", payload: { id: "e2", runId: "r2", parentItemId: null, type: "error", status: "failed", startedAt: null, failure: { message: "Claude API rate limit reached. Try again later.", class: "usage_limit" } } });
  expect(run("r2", "failed")).toMatchObject([{ type: "turn.done", payload: { status: "failed", error: "Claude API rate limit reached. Try again later." } }]);
});

test("a Caveman plan or credits limit is one engine.status notice that says until when, not a failure banner too", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-23T12:00:00.000Z", displayText: () => undefined };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "caveman/anthropic/claude-opus-5-5" }, providerInstanceId: "caveman", rootNodeId: null } });
  const failed = (id: string, runId: string, failure: object) => project({ type: "turn-item.updated", payload: { id, runId, parentItemId: null, type: "error", status: "failed", startedAt: null, failure } });
  run("r1", "running");
  const window = { message: "Your Caveman plan's 5-hour usage window is used up.", class: "usage_limit", code: "cave_code_credits_exhausted", retryable: true, resetAt: "2026-10-23T15:00:00.000Z" };
  expect(failed("e1", "r1", window)).toEqual([
    expect.objectContaining({ type: "engine.status", turn_id: "r1", payload: { engine: "caveman", rate_limit: { limited: true, resets_at: "2026-10-23T15:00:00.000Z" }, message: window.message } }),
  ]);
  // The same item again says nothing more, and the turn ends without repeating it.
  expect(failed("e1", "r1", window)).toEqual([]);
  expect(run("r1", "failed").map((e) => [e.type, e.payload])).toEqual([["turn.done", { status: "failed", failure: { class: "usage_limit", code: "cave_code_credits_exhausted" } }]]);
  // Out of credits: no reset time.
  run("r2", "running");
  const [none] = failed("e2", "r2", { message: "No Caveman plan usage or credits are left for this model.", class: "usage_limit", code: "cave_code_credits_exhausted", retryable: false });
  expect(none).toMatchObject({ type: "engine.status", payload: { rate_limit: { limited: true } } });
  expect((none!.payload as { rate_limit: object }).rate_limit).not.toHaveProperty("resets_at");
  // Any other usage limit keeps its failure banner.
  run("r3", "running");
  expect(failed("e3", "r3", { message: "429 rate_limit_error", class: "usage_limit", code: null, retryable: true })).toEqual([]);
  expect(run("r3", "failed")).toMatchObject([{ type: "turn.done", payload: { status: "failed", error: "429 rate_limit_error" } }]);
});

test("subagent.started says who runs a delegated child and who chose it; a native subagent has no runner", () => {
  const state = emptyThreadState();
  const runner = { engine: "codex" as const, instance_id: "codex-account-ab12", account_tag: "WK", model: "gpt-6.1-sol", effort: "high", pick: { by: "auto" as const, kind: "review" as const } };
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined, runner: (threadId: string) => (threadId === "child-1" ? runner : undefined) };
  const project = (payload: object) => projectEvent(state, { type: "turn-item.updated", payload: { type: "subagent", runId: "r1", parentItemId: null, status: "running", result: null, prompt: "Review it", title: "Review", ...payload } } as unknown as OrchestrationV2DomainEvent, ctx).events;
  expect(project({ id: "s1", origin: "app_owned", providerInstanceId: "codex-account-ab12", childThreadId: "child-1", subagentId: "node:task-1" })).toMatchObject([
    // The task id its delegate_task call returned: the card takes that row's place.
    { type: "subagent.started", payload: { title: "Review", agent: "codex", runner, task_id: "node:task-1" } },
  ]);
  const native = project({ id: "s2", origin: "provider_native", providerInstanceId: "claudeAgent", childThreadId: null, subagentId: "native-1" })[0]!.payload;
  expect(native).not.toHaveProperty("runner");
  expect(native).not.toHaveProperty("task_id");
  // A child the runtime recorded nothing for (an older delegation) starts as before.
  expect(project({ id: "s3", origin: "app_owned", providerInstanceId: "codex", childThreadId: "child-old" })[0]!.payload).not.toHaveProperty("runner");
});

test("turn.started names the login it runs on: the person's own claude, a further Claude login, a Codex account", () => {
  const started = (instance: string) => projectEvent(emptyThreadState(), run("r1", instance, "n1"), ctx).events[0]!.payload as { engine: string; account_id?: string };
  expect(started("claudeAgent")).toMatchObject({ engine: "claude-agent", account_id: "claudeAgent:default" });
  expect(started("claudeAgent-account-1a2b3c4d")).toMatchObject({ engine: "claude-agent", account_id: "claudeAgent-account-1a2b3c4d" });
  expect(started("codex-account-chatgpt-5e6f7a8b")).toMatchObject({ engine: "codex", account_id: "codex-account-chatgpt-5e6f7a8b" });
  // The Caveman engine's accounts are keys, named by its models: none on the turn.
  expect(started("caveman")).not.toHaveProperty("account_id");
});

test("turn.started carries the effort the turn runs at, from the model's own effort option", () => {
  const started = (modelSelection: object) =>
    projectEvent(emptyThreadState(), { type: "run.created", payload: { id: "r1", status: "running", modelSelection, providerInstanceId: "codex", rootNodeId: "n1" } } as never, ctx).events[0]!.payload as { model: string; effort?: string };
  // Codex (and Grok, Muse) name it reasoningEffort; Claude and the Caveman engine name it effort.
  expect(started({ model: "gpt-6-luna", options: [{ id: "reasoningEffort", value: "low" }] })).toMatchObject({ model: "gpt-6-luna", effort: "low" });
  expect(started({ model: "claude-sonnet-5-5", options: [{ id: "thinking", value: true }, { id: "effort", value: "high" }] })).toMatchObject({ effort: "high" });
  // Pi names it thinking, OpenCode variant.
  expect(started({ model: "openai-codex/gpt-5.5", options: [{ id: "thinking", value: "medium" }] })).toMatchObject({ effort: "medium" });
  expect(started({ model: "opencode/big-pickle", options: [{ id: "variant", value: "high" }] })).toMatchObject({ effort: "high" });
  // No effort picked: none on the turn, never a guess.
  expect(started({ model: "m" })).not.toHaveProperty("effort");
  expect(started({ model: "m", options: [{ id: "fastMode", value: true }] })).not.toHaveProperty("effort");
});

test("an answer streamed only on its turn item (Codex) reaches the client as message.delta, then message.done", () => {
  const state = emptyThreadState();
  const project = (event: object) => projectEvent(state, event as never, ctx).events;
  const item = (text: string, streaming: boolean) =>
    project({ type: "turn-item.updated", payload: { id: "ti-1", type: "assistant_message", messageId: "msg-1", runId: "r1", parentItemId: null, text, streaming } });
  const message = (text: string, streaming: boolean) =>
    project({ type: "message.updated", payload: { id: "msg-1", role: "assistant", runId: "r1", text, streaming } });
  project({ type: "run.created", payload: { id: "r1", status: "running", modelSelection: { model: "gpt-6-luna" }, providerInstanceId: "codex", rootNodeId: "n1" } });

  expect(item("Pine", true)).toMatchObject([{ type: "message.delta", item_id: "msg-1", payload: { text: "Pine" } }]);
  expect(item("Pineapple grew", true)).toMatchObject([{ type: "message.delta", item_id: "msg-1", payload: { text: "apple grew" } }]);
  // An engine that also streams the message sends nothing twice.
  expect(message("Pineapple grew", true)).toEqual([]);
  expect(message("Pineapple grew tall.", true)).toMatchObject([{ type: "message.delta", payload: { text: " tall." } }]);
  expect(item("Pineapple grew tall.", true)).toEqual([]);
  // The finished message closes it, on the same item id; the finished turn item adds nothing.
  expect(message("Pineapple grew tall.", false)).toMatchObject([{ type: "message.done", item_id: "msg-1", payload: { role: "assistant", text: "Pineapple grew tall." } }]);
  expect(item("Pineapple grew tall.", false)).toEqual([]);
  expect(item("Pineapple grew tall. Late", true)).toEqual([]);
});

describe("projector native subagents", () => {
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined };
  const subagent = (state: ReturnType<typeof emptyThreadState>, payload: object) =>
    projectEvent(state, { type: "turn-item.updated", payload: { id: "s1", type: "subagent", runId: "r1", parentItemId: null, origin: "provider_native", providerInstanceId: "claudeAgent", childThreadId: "child-1", prompt: "Map it", title: "Map current onboarding state", status: "running", result: null, ...payload } } as unknown as OrchestrationV2DomainEvent, ctx).events;

  test("a native subagent's child thread is remembered against its item and turn", () => {
    const state = emptyThreadState();
    subagent(state, {});
    expect(state.native).toEqual({ "child-1": { item: "s1", turn: "r1" } });
  });

  test("a subagent that first ends with a summary and then with its full result ends again; the same end once", () => {
    const state = emptyThreadState();
    subagent(state, {});
    expect(subagent(state, { status: "completed", result: "Read package.json" })).toMatchObject([{ type: "subagent.done", payload: { status: "completed", summary: "Read package.json" } }]);
    expect(subagent(state, { status: "completed", result: "Here is package.json: {}" })).toMatchObject([{ type: "subagent.done", item_id: "s1", payload: { summary: "Here is package.json: {}" } }]);
    expect(subagent(state, { status: "completed", result: "Here is package.json: {}" })).toEqual([]);
  });

  test("a finished message T3 corrects goes out again on the same item; an unchanged one does not", () => {
    const state = emptyThreadState();
    const message = (text: string, streaming = false) =>
      projectEvent(state, { type: "message.updated", payload: { id: "m1", runId: null, role: "assistant", text, streaming } } as unknown as OrchestrationV2DomainEvent, ctx).events;
    expect(message("Read package.json")).toMatchObject([{ type: "message.done", item_id: "m1", payload: { text: "Read package.json" } }]);
    expect(message("Read package.json")).toEqual([]);
    expect(message("Here is package.json: {}")).toMatchObject([{ type: "message.done", item_id: "m1", payload: { role: "assistant", text: "Here is package.json: {}" } }]);
  });

  test("a child thread's events nest under its row and its turn; turns, usage and its prompt stay out", () => {
    const at = "2026-10-17T00:00:00.000Z";
    const drafts = [
      { at, type: "turn.started", payload: {} },
      { at, type: "message.done", item_id: "prompt", payload: { role: "user", text: "Map it" } },
      { at, type: "tool.started", item_id: "t1", payload: { name: "Read" } },
      { at, type: "subagent.started", item_id: "s2", payload: { title: "Deeper" } },
      { at, type: "ask.user", item_id: "a1", parent_item_id: "t1", payload: {} },
      { at, type: "usage", payload: {} },
      { at, type: "plan.updated", item_id: "p1", payload: {} },
      { at, type: "message.done", item_id: "m1", turn_id: "child-run", payload: { role: "assistant", text: "Done" } },
    ] as unknown as Array<DraftEvent>;
    expect(nestUnder(drafts, { item: "s1", turn: "r1" }).map((e) => [e.type, e.item_id, e.parent_item_id, e.turn_id])).toEqual([
      ["tool.started", "t1", "s1", "r1"],
      ["subagent.started", "s2", "s1", "r1"],
      ["ask.user", "a1", "s1", "r1"],
      ["message.done", "m1", "s1", "r1"],
    ]);
  });

  test("the chat lists its native subagents with their status and end, never a delegated agent, the latest kept", () => {
    const at = "2026-10-17T00:00:00.000Z";
    const started = (id: string, payload: object = {}, parent?: string) => ({ at, type: "subagent.started", item_id: id, ...(parent ? { parent_item_id: parent } : {}), payload: { title: id, agent: "claude-agent", ...payload } }) as unknown as DraftEvent;
    const done = (id: string, status: string, when = at) => ({ at: when, type: "subagent.done", item_id: id, payload: { status } }) as unknown as DraftEvent;
    const one = foldNativeSubagents(undefined, [started("s1"), started("d1", { workspace_id: "w-child" }), started("s2", {}, "s1")]);
    expect(one).toEqual([
      { item_id: "s1", title: "s1", agent: "claude-agent", status: "working", started_at: at },
      { item_id: "s2", parent_item_id: "s1", title: "s2", agent: "claude-agent", status: "working", started_at: at },
    ]);
    const end = "2026-10-17T00:05:00.000Z";
    const two = foldNativeSubagents(one, [done("s2", "failed", end), done("s1", "completed", end), done("d1", "completed")]);
    expect(two?.map((s) => [s.status, s.ended_at])).toEqual([
      ["completed", end],
      ["failed", end],
    ]);
    // Nothing new (an engine correcting a result ends it again, same status): the same list, its end kept, so the workspace is not rewritten.
    expect(foldNativeSubagents(two, [done("s1", "completed", "2026-10-17T00:09:00.000Z"), { at, type: "tool.started", item_id: "t1", payload: {} } as unknown as DraftEvent])).toBe(two);
    const many = foldNativeSubagents(undefined, Array.from({ length: NATIVE_SUBAGENTS_KEPT + 5 }, (_, i) => started(`n${i}`)));
    expect(many).toHaveLength(NATIVE_SUBAGENTS_KEPT);
    expect(many?.[0]?.item_id).toBe("n5");
  });
});

describe("Workspace.activity: what a chat's latest turn is at, for a row that never attaches its session", () => {
  const at = "2026-10-18T00:00:00.000Z";
  const later = "2026-10-18T00:05:00.000Z";
  const draft = (type: string, payload: object, ids: { item_id?: string; parent_item_id?: string; at?: string } = {}) => ({ at, type, payload, ...ids }) as unknown as DraftEvent;
  const approval = (id: string, title: string, parent?: string) => draft("ask.user", { kind: "approval", title, detail: "rm -rf build", options: [] }, { item_id: id, ...(parent ? { parent_item_id: parent } : {}) });
  const question = (id: string, ...prompts: Array<string>) =>
    draft("ask.user", { kind: "question", questions: prompts.map((prompt, i) => ({ id: `q${i}`, prompt, options: [], multi_select: false, allow_text: true })) }, { item_id: id });
  const secret = (id: string) => draft("ask.user", { kind: "secret", repo: { path: "/r" }, name: "STRIPE_KEY", reason: "To run the payment tests\nand nothing else" }, { item_id: id });
  const resolved = (id: string, outcome = "answered", parent?: string) => draft("ask.resolved", { outcome }, { item_id: id, ...(parent ? { parent_item_id: parent } : {}) });
  const turnStarted = (ids: { parent_item_id?: string; at?: string } = {}) => draft("turn.started", { engine: "claude-agent" }, ids);
  const turnDone = (status: string, ids: { parent_item_id?: string; at?: string } = {}) => draft("turn.done", { status }, ids);
  const todos = (...statuses: Array<string>) => draft("plan.updated", { kind: "todos", steps: statuses.map((status, i) => ({ text: `step ${i}`, status })) }, { item_id: "p1" });
  /** The store's fold: open asks first, then the activity that shows the latest. */
  const fold = (prev: { activity: WorkspaceActivity | undefined; asks: ReadonlyArray<OpenAsk> | undefined }, events: Array<DraftEvent>) => {
    const asks = foldOpenAsks(prev.asks, events);
    return { activity: foldActivity(prev.activity, events, asks), asks };
  };
  const empty = { activity: undefined, asks: undefined };

  test("an approval, a question and a secret each show as their kind with one line of their prompt", () => {
    expect(fold(empty, [approval("a1", "Run rm -rf build?")]).activity).toEqual({ ask: { kind: "approval", prompt: "Run rm -rf build?" } });
    expect(fold(empty, [question("q1", "  Which database?\nWe store sessions.", "How do people sign in?")]).activity).toEqual({ ask: { kind: "question", prompt: "Which database?" } });
    expect(fold(empty, [secret("s1")]).activity).toEqual({ ask: { kind: "secret", prompt: "STRIPE_KEY: To run the payment tests" } });
    const long = fold(empty, [approval("a2", "x".repeat(300))]).activity!.ask!.prompt;
    expect(long).toHaveLength(140);
    expect(long.endsWith("…")).toBe(true);
  });

  test("resolving the ask clears it; with two open, the one still open shows, whichever is answered first", () => {
    const one = fold(empty, [question("q1", "Which database?")]);
    expect(fold(one, [resolved("q1")])).toEqual({ activity: undefined, asks: undefined });
    const two = fold(one, [approval("a1", "Allow Bash?")]);
    expect(two.activity?.ask).toEqual({ kind: "approval", prompt: "Allow Bash?" });
    // The latest answered: the question before it shows again.
    expect(fold(two, [resolved("a1")]).activity?.ask).toEqual({ kind: "question", prompt: "Which database?" });
    // The older one cancelled: the latest still shows, and nothing else changed.
    const rest = fold(two, [resolved("q1", "cancelled")]);
    expect(rest.activity).toBe(two.activity);
    expect(rest.asks).toEqual([{ item_id: "a1", kind: "approval", prompt: "Allow Bash?" }]);
    // An ask inside a native subagent still waits on the person.
    const nested = fold(empty, [approval("n1", "Allow Read?", "sub1")]);
    expect(nested.activity?.ask).toEqual({ kind: "approval", prompt: "Allow Read?" });
    expect(fold(nested, [resolved("n1", "expired", "sub1")]).activity).toBeUndefined();
  });

  test("a running turn has its start; its end keeps how it ended, interrupted included, and when", () => {
    const running = fold(empty, [turnStarted()]);
    expect(running.activity).toEqual({ turn_started_at: at });
    const done = fold(running, [turnDone("completed")]);
    expect(done.activity).toEqual({ last_outcome: "completed", turn_ended_at: at });
    // A turn under way has not ended: the last end goes until this one's.
    const next = fold(done, [turnStarted({ at: later })]);
    expect(next.activity).toEqual({ turn_started_at: later, last_outcome: "completed" });
    expect(fold(next, [turnDone("interrupted", { at: later })]).activity).toEqual({ last_outcome: "interrupted", turn_ended_at: later });
    expect(fold(next, [turnDone("failed")]).activity).toEqual({ last_outcome: "failed", turn_ended_at: at });
  });

  test("the latest todo list counts its completed steps, until the next list replaces it", () => {
    const first = fold(empty, [todos("completed", "in_progress", "pending")]);
    expect(first.activity).toEqual({ todos: { done: 1, total: 3 } });
    expect(fold(first, [turnStarted(), turnDone("completed")]).activity).toEqual({ last_outcome: "completed", turn_ended_at: at, todos: { done: 1, total: 3 } });
    expect(fold(first, [todos("completed", "completed", "completed", "pending")]).activity).toEqual({ todos: { done: 3, total: 4 } });
    expect(fold(first, [todos()]).activity).toBeUndefined();
  });

  test("grill finished: ready to build until the next turn starts", () => {
    const grilling = fold(empty, [turnStarted()]);
    const finished = fold(grilling, [draft("grill.finished", { doc_path: "docs/", summary: "Postgres" }), turnDone("completed")]);
    expect(finished.activity).toEqual({ last_outcome: "completed", turn_ended_at: at, ready_to_build: true });
    expect(fold(finished, [turnStarted({ at: later })]).activity).toEqual({ turn_started_at: later, last_outcome: "completed" });
  });

  test("a native subagent's own turns, todos and grill never touch the chat's", () => {
    const running = fold(empty, [turnStarted()]);
    const inside = { parent_item_id: "sub1" };
    const nested = [
      turnStarted({ ...inside, at: later }),
      turnDone("failed", inside),
      draft("plan.updated", { kind: "todos", steps: [{ text: "x", status: "completed" }] }, inside),
      draft("grill.finished", { doc_path: "d.md", summary: "s" }, inside),
    ];
    expect(fold(running, nested).activity).toBe(running.activity);
  });

  test("the latest answer is the line under the title: plain, on one line; the person's words and a subagent's never replace it", () => {
    const said = (role: string, text: string, ids: { parent_item_id?: string } = {}) => draft("message.done", { role, text }, { item_id: "m", ...ids });
    const answered = fold(empty, [said("assistant", "## Done\n\nThe **tests** pass; see [the log](https://x.test/log).\n\n- `pnpm test` is green")]);
    expect(answered.activity).toEqual({ last_reply: "Done The tests pass; see the log. pnpm test is green" });
    expect(fold(answered, [said("user", "thanks"), said("assistant", "inner", { parent_item_id: "sub1" }), said("assistant", "  \n ")]).activity).toBe(answered.activity);
    expect(fold(answered, [said("assistant", "Next one")]).activity).toEqual({ last_reply: "Next one" });
  });

  test("a reply line keeps snake_case and arithmetic, and cuts a long answer with an ellipsis", () => {
    expect(replyLine("Renamed `user_id` to account_id, 2 * 3 * 4 is 24")).toBe("Renamed user_id to account_id, 2 * 3 * 4 is 24");
    expect(replyLine("Run ```pnpm test``` first")).toBe("Run pnpm test first");
    expect(replyLine("````md\n```ts\nx\n```\n````")).toBe("x");
    expect(replyLine("Changed it:\n```ts\nconst a = 1;\n```\nDone.")).toBe("Changed it: const a = 1; Done.");
    const long = replyLine("word ".repeat(100));
    expect(long).toHaveLength(280);
    expect(long.endsWith("…")).toBe(true);
  });

  test("events that change nothing give back the same object, so the workspace is not rewritten", () => {
    const state = fold(empty, [turnStarted(), todos("completed", "pending"), question("q1", "Which database?")]);
    const same = fold(state, [draft("message.delta", { text: "hi" }), draft("tool.started", { name: "Read" }, { item_id: "t1" }), resolved("unknown"), question("q1", "Which database?")]);
    expect(same.asks).toBe(state.asks);
    expect(same.activity).toBe(state.activity);
    expect(fold(state, []).activity).toBe(state.activity);
    expect(foldActivity(undefined, [draft("message.delta", { text: "hi" })], undefined)).toBeUndefined();
  });
});

test("a run that fails before its engine starts shows the person's message and ends failed with the reason", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } });
  const user = (runId: string, messageId: string) =>
    project({ type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: `${messageId} text`, attachments: [], parentItemId: null } });

  // As a forked chat's first turn saw it when Claude could not fork the session: the run never left starting.
  expect(run("r1", "starting")).toEqual([]);
  expect(user("r1", "m1")).toEqual([]);
  project({ type: "turn-item.updated", payload: { id: "e1", runId: "r1", parentItemId: null, type: "error", status: "failed", startedAt: null, failure: { message: "Session s1 not found", class: "provider_error" } } });
  expect(run("r1", "failed").map((e) => [e.type, e.payload])).toEqual([
    ["turn.started", { engine: "claude-agent", model: "m", mode: "default", account_id: "claudeAgent:default" }],
    ["message.done", { role: "user", text: "m1 text" }],
    ["turn.done", { status: "failed", error: "Session s1 not found", failure: { class: "provider_error" } }],
  ]);
  expect(run("r1", "failed")).toEqual([]);

  // A queued input taken off the queue was never sent: nothing shows.
  run("r2", "queued");
  user("r2", "m2");
  expect(run("r2", "cancelled")).toEqual([]);
});

test("a stop or a crash that catches a send before its engine starts keeps the person's message and ends the turn interrupted, once (CHAOS-4)", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-22T00:00:00.000Z", displayText: () => undefined };
  const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
  const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } });
  const user = (runId: string, messageId: string) =>
    project({ type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: `${messageId} text`, attachments: [], parentItemId: null } });
  const shown = (events: ReturnType<typeof run>) => events.map((e) => [e.type, e.type === "turn.started" ? undefined : e.payload]);

  // A stop right behind a send: the run was still preparing.
  run("r1", "preparing");
  user("r1", "m1");
  expect(shown(run("r1", "interrupted"))).toEqual([
    ["turn.started", undefined],
    ["message.done", { role: "user", text: "m1 text" }],
    ["turn.done", { status: "interrupted" }],
  ]);
  expect(run("r1", "interrupted")).toEqual([]);
  expect(user("r1", "m1")).toEqual([]);

  // A kill -9 while it was starting: the restart's recovery cancels it.
  run("r2", "starting");
  user("r2", "m2");
  expect(shown(run("r2", "cancelled"))).toEqual([
    ["turn.started", undefined],
    ["message.done", { role: "user", text: "m2 text" }],
    ["turn.done", { status: "interrupted" }],
  ]);
  expect(run("r2", "cancelled")).toEqual([]);
});

test("a chat whose last turn failed lists as failed until its next turn starts; a stop or a success lists as idle", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined };
  const run = (id: string, status: string) =>
    projectEvent(state, { type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx);

  expect(threadActivity(state)).toBe("idle");
  run("r1", "running");
  expect(threadActivity(state)).toBe("working");
  // As a Claude Agent chat on a signed-out claude saw it: "Not logged in", then the turn failed.
  run("r1", "failed");
  expect(threadActivity(state)).toBe("failed");
  run("r2", "running");
  expect(threadActivity(state)).toBe("working");
  run("r2", "completed");
  expect(threadActivity(state)).toBe("idle");
  run("r3", "running");
  run("r3", "interrupted");
  expect(threadActivity(state)).toBe("idle");
  // An open question still comes first.
  run("r4", "running");
  run("r4", "failed");
  state.asks.a1 = "open";
  expect(threadActivity(state)).toBe("needs_input");
});

test("a chat stopped with inputs queued is idle: a held input waits for the person, nothing runs", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-17T00:00:00.000Z", displayText: () => undefined };
  const run = (id: string, status: string, queueHeld?: boolean) =>
    projectEvent(state, { type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null, ...(queueHeld === undefined ? {} : { queueHeld }) } } as unknown as OrchestrationV2DomainEvent, ctx);

  run("r1", "running");
  run("r2", "queued");
  expect(threadActivity(state)).toBe("working");
  // Stop: the running turn ends and the queue is held, as after a restart cut the turn.
  run("r2", "queued", true);
  run("r1", "interrupted");
  expect(threadActivity(state)).toBe("idle");
  // queue.resume (or the person's next message) lets it go.
  run("r2", "queued", false);
  expect(threadActivity(state)).toBe("working");
  run("r2", "running");
  run("r2", "completed");
  expect(threadActivity(state)).toBe("idle");
});

test("an engine's default model comes from its active account first: Codex on a ChatGPT login is not the default instance", () => {
 // As the runtime saw it with the compact login switched on and no API key: only codex-account-compact lists models.
  const providers = [
    { instanceId: "codex", models: [] },
    { instanceId: "codex-account-chatgpt", models: [{ slug: "gpt-6.1-sol", isDefault: true }, { slug: "gpt-6-luna" }] },
    { instanceId: "claudeAgent", models: [{ slug: "claude-opus-5-5" }, { slug: "claude-haiku-5-5", isDefault: true }] },
  ];
  expect(defaultModelSlug(providers, ["codex-account-chatgpt", "codex"])).toBe("gpt-6.1-sol");
  // The old lookup asked the default instance only, and found nothing ("no model is known for codex").
  expect(defaultModelSlug(providers, ["codex"])).toBeUndefined();
  // The active account has no models yet: the default instance's still count; the default model, else the first.
  expect(defaultModelSlug(providers, ["claudeAgent:another", "claudeAgent"])).toBe("claude-haiku-5-5");
  expect(defaultModelSlug([{ instanceId: "pi", models: [{ slug: "a" }, { slug: "b" }] }], ["pi"])).toBe("a");
});

test("an approval names the tool call it waits on, by the provider's id for both (Claude's permission callback)", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-18T00:00:00.000Z", displayText: () => undefined };
  const project = (payload: object) => projectEvent(state, { type: "turn-item.updated", payload } as unknown as OrchestrationV2DomainEvent, ctx).events;
  projectEvent(state, { type: "run.updated", payload: { id: "r1", status: "running", modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx);
  const ref = (nativeId: string) => ({ driver: "claudeAgent", nativeId, strength: "strong" });
  const command = (status: string) => ({ type: "command_execution", id: "turn-item:tool-1", runId: "r1", parentItemId: null, status, input: "git log --oneline -1", nativeItemRef: ref("toolu_1") });
  expect(project(command("running")).map((e) => e.type)).toEqual(["tool.started"]);
  const ask = (requestId: string, nativeId: string) => ({ type: "approval_request", id: `approval:${requestId}`, runId: "r1", parentItemId: null, status: "waiting", requestId, requestKind: "command", prompt: "Show the latest commit", nativeItemRef: ref(nativeId) });
  const [asked] = project(ask("req-1", "toolu_1"));
  expect(asked).toMatchObject({ type: "ask.user", payload: { kind: "approval", title: "Show the latest commit", tool_item_id: "turn-item:tool-1" } });
  // A request for no open tool names none, and a finished tool is forgotten.
  expect(project(ask("req-2", "toolu_other"))[0]!.payload).not.toHaveProperty("tool_item_id");
  project(command("completed"));
  expect(state.openTools).toEqual({});
  expect(project(ask("req-3", "toolu_1"))[0]!.payload).not.toHaveProperty("tool_item_id");
  // Full access, and Claude asked anyway: its reason and the cause go out with the ask.
  const [overridden] = project({ ...ask("req-4", "toolu_x"), reason: "Dangerous rm on a path built from a variable", fullAccessOverride: "provider_check" });
  expect(overridden).toMatchObject({ payload: { reason: "Dangerous rm on a path built from a variable", full_access_override: "engine_check" } });
  const [rule] = project({ ...ask("req-5", "toolu_y"), fullAccessOverride: "ask_rule" });
  expect(rule).toMatchObject({ payload: { full_access_override: "ask_rule" } });
  expect(rule!.payload).not.toHaveProperty("reason");
});

test("a Codex patch over several files names every file, a move's old path too; one plain file adds nothing to its title", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-28T00:00:00.000Z", displayText: () => undefined };
  const project = (payload: object) => projectEvent(state, { type: "turn-item.updated", payload } as unknown as OrchestrationV2DomainEvent, ctx).events;
  projectEvent(state, { type: "run.updated", payload: { id: "r1", status: "running", modelSelection: { model: "m" }, providerInstanceId: "codex", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx);
 // CodexAdapterV2's turn item for one patch (upstream #22541): the title is the first change's path.
  const changes = [
    { operation: "update", path: "/w/d.ts", oldPath: "/w/c.ts" },
    { operation: "delete", path: "/w/e.ts" },
    { operation: "add", path: "/w/a.ts" },
    { operation: "update", path: "/w/b.ts" },
  ];
  const patch = (status: string, list: object[] | undefined, id = "turn-item:patch-a") => ({ type: "file_change", id, runId: "r1", parentItemId: null, status, fileName: "/w/c.ts", ...(list ? { changes: list } : {}) });
  const [started] = project(patch("running", changes));
  expect(started).toMatchObject({
    type: "tool.started",
    payload: {
      name: "edit",
      title: "/w/c.ts",
      kind: "edit",
      input: { path: "/w/c.ts" },
      files: [
        { path: "/w/d.ts", old_path: "/w/c.ts", status: "renamed" },
        { path: "/w/e.ts", status: "deleted" },
        { path: "/w/a.ts", status: "added" },
        { path: "/w/b.ts", status: "modified" },
      ],
    },
  });
  // The same files again: no second start. A change to them: the row hears it while it runs.
  expect(project(patch("running", changes)).map((e) => e.type)).toEqual([]);
  expect(project(patch("running", changes.slice(0, 2)))).toMatchObject([{ type: "tool.started", payload: { files: [{ path: "/w/d.ts" }, { path: "/w/e.ts" }] } }]);
  expect(project(patch("completed", changes.slice(0, 2))).map((e) => e.type)).toEqual(["tool.done"]);
  // One file that did not move says no more than its title; an ACP agent's own words for an operation still read.
  expect(project(patch("completed", [{ operation: "update", path: "/w/c.ts" }], "turn-item:one"))[0]!.payload).not.toHaveProperty("files");
  expect(project(patch("completed", undefined, "turn-item:none"))[0]!.payload).not.toHaveProperty("files");
  expect(project(patch("completed", [{ operation: "create", path: "/w/n.ts" }, { operation: "rename", path: "/w/m.ts", oldPath: "/w/l.ts" }], "turn-item:acp"))[0]).toMatchObject({
    payload: { files: [{ path: "/w/n.ts", status: "added" }, { path: "/w/m.ts", old_path: "/w/l.ts", status: "renamed" }] },
  });
});

test("an approval whose engine takes a note says so; a question's options carry their previews", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-28T00:00:00.000Z", displayText: () => undefined };
  const event = (type: string, payload: object) => projectEvent(state, { type, payload } as unknown as OrchestrationV2DomainEvent, ctx).events;
  event("run.updated", { id: "r1", status: "running", modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null });
  const request = (id: string, capability: object, status = "pending") => ({ id, nodeId: `node:${id}`, kind: "command", status, responseCapability: capability, createdAt: ctx.at, resolvedAt: null });
  const approval = (requestId: string) => ({ type: "approval_request", id: `approval:${requestId}`, runId: "r1", parentItemId: null, status: "waiting", requestId, requestKind: "command", prompt: "Run rm -rf build" });
 // Claude's live request supports feedback (upstream #23657); it comes just before its turn item, as ClaudeAdapterV2 emits them.
  expect(event("runtime-request.updated", request("req-1", { type: "live", providerSessionId: "ps1", supportsFeedback: true }))).toEqual([]);
  expect(event("turn-item.updated", approval("req-1"))).toMatchObject([{ type: "ask.user", payload: { kind: "approval", accepts_feedback: true } }]);
  // Codex's (no flag) and a request that can't be answered live take no note.
  event("runtime-request.updated", request("req-2", { type: "live", providerSessionId: "ps1" }));
  expect(event("turn-item.updated", approval("req-2"))[0]!.payload).not.toHaveProperty("accepts_feedback");
  event("runtime-request.updated", request("req-3", { type: "not_resumable", reason: "restarted" }));
  expect(event("turn-item.updated", approval("req-3"))[0]!.payload).not.toHaveProperty("accepts_feedback");
  // Answered: the note's flag is forgotten, and the ask resolves as before.
  expect(event("runtime-request.updated", { ...request("req-1", { type: "live", providerSessionId: "ps1", supportsFeedback: true }, "resolved"), decision: "decline", feedback: "Clean dist/ instead" })).toMatchObject([
    { type: "ask.resolved", payload: { outcome: "answered", response: { kind: "approval", option_id: "decline" } } },
  ]);
  expect(state.feedback).toEqual({});

 // Claude's AskUserQuestion options keep their previews (upstream #21932); a blank one is not sent.
  const [asked] = event("turn-item.updated", {
    type: "user_input_request",
    id: "question:q1",
    runId: "r1",
    parentItemId: null,
    status: "waiting",
    requestId: "req-q",
    questions: [
      {
        id: "layout",
        header: "Layout",
        question: "Which layout?",
        options: [
          { label: "Sidebar", description: "Nav on the left", preview: "┌──┬─────┐\n│▤ │     │\n└──┴─────┘" },
          { label: "Top bar", description: "Nav on top", preview: "  " },
          { label: "None", description: "No nav" },
        ],
      },
    ],
  });
  const options = (asked!.payload as { questions: Array<{ options: Array<object> }> }).questions[0]!.options;
  expect(options[0]).toEqual({ id: "Sidebar", label: "Sidebar", description: "Nav on the left", preview: "┌──┬─────┐\n│▤ │     │\n└──┴─────┘" });
  expect(options[1]).not.toHaveProperty("preview");
  expect(options[2]).not.toHaveProperty("preview");
});

test("a command whose engine keeps only its output's tail streams every line once, in order", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-20T00:00:00.000Z", displayText: () => undefined };
  const project = (payload: object) => projectEvent(state, { type: "turn-item.updated", payload } as unknown as OrchestrationV2DomainEvent, ctx).events;
  projectEvent(state, { type: "run.updated", payload: { id: "r1", status: "running", modelSelection: { model: "m" }, providerInstanceId: "acp", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx);
  const command = (status: string, output: string) => ({ type: "command_execution", id: "turn-item:terminal", runId: "r1", parentItemId: null, status, input: "make", output });
  // A 1 MiB build log in 4 KiB chunks; the ACP adapter saves its last 320 KiB on each one.
  const log = Array.from({ length: (1024 * 1024) / 64 }, (_, index) => `${String(index + 1).padStart(8, "0")} ${"x".repeat(54)}\n`).join("");
  const window = 320 * 1024;
  let streamed = "";
  for (let end = 4096; end <= log.length; end += 4096) {
    const status = end === log.length ? "completed" : "running";
    for (const event of project(command(status, log.slice(Math.max(0, end - window), end)))) {
      if (event.type === "tool.output") streamed += (event.payload as { text: string }).text;
    }
  }
  expect(streamed.length).toBe(log.length);
  expect(streamed === log).toBe(true);
  expect(state.outputTails).toEqual({});

  // A snapshot that moved past everything sent goes out whole.
  const jump = (status: string, output: string) => ({ ...command(status, output), id: "turn-item:jump" });
  expect(project(jump("running", "a\n".repeat(200))).filter((e) => e.type === "tool.output")).toHaveLength(1);
  const fresh = "b\n".repeat(200);
  expect(project(jump("completed", fresh)).flatMap((e) => (e.type === "tool.output" ? [(e.payload as { text: string }).text] : []))).toEqual([fresh]);
});

test("a call shown as the model begins it goes out again once its input is whole, and only then", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-20T00:00:00.000Z", displayText: () => undefined };
  const project = (payload: object) => projectEvent(state, { type: "turn-item.updated", payload } as unknown as OrchestrationV2DomainEvent, ctx).events;
  projectEvent(state, { type: "run.updated", payload: { id: "r1", status: "running", modelSelection: { model: "m" }, providerInstanceId: "claudeAgent", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, ctx);
  // ClaudeAdapterV2 starts Bash's item at content_block_start with no command, and fills it in on the same item.
  const bash = (input: string, status = "running", output?: string) => ({
    type: "command_execution",
    id: "turn-item:tool-1",
    runId: "r1",
    parentItemId: null,
    status,
    input,
    ...(output === undefined ? {} : { output }),
  });
  const COMMAND = "for i in 1 2 3; do echo $i; sleep 1; done";
  expect(project(bash(""))).toMatchObject([{ type: "tool.started", item_id: "turn-item:tool-1", payload: { name: "command", title: "", input: { command: "" } } }]);
  expect(project(bash(COMMAND))).toMatchObject([{ type: "tool.started", item_id: "turn-item:tool-1", payload: { name: "command", title: COMMAND, input: { command: COMMAND } } }]);
  // The same input again, its output, its end: no further start.
  expect(project(bash(COMMAND)).map((e) => e.type)).toEqual([]);
  expect(project(bash(COMMAND, "running", "1\n")).map((e) => e.type)).toEqual(["tool.output"]);
  expect(project(bash(COMMAND, "completed", "1\n2\n3\n")).map((e) => e.type)).toEqual(["tool.output", "tool.done"]);
  expect(state.shapes).toEqual({});
  // A finished call is never restarted, whatever its item says later.
  expect(project(bash("echo other", "completed", "1\n2\n3\n")).filter((e) => e.type === "tool.started")).toEqual([]);
  // A call first seen whole and finished at once goes out once.
  const once = { ...bash("ls", "completed", "a\n"), id: "turn-item:tool-2" };
  expect(project(once).map((e) => e.type)).toEqual(["tool.started", "tool.output", "tool.done"]);
  expect(state.shapes).toEqual({});
});

test("a thought's line goes out as its block starts, before its text; its text then streams as it grows", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-20T00:00:00.000Z", displayText: () => undefined };
  const thought = (text: string, streaming = true) =>
    projectEvent(state, { type: "turn-item.updated", payload: { id: "t1", runId: "r1", parentItemId: null, type: "reasoning", text, streaming } } as unknown as OrchestrationV2DomainEvent, ctx).events;
  expect(thought("")).toMatchObject([{ type: "reasoning.delta", payload: { text: "" } }]);
  expect(thought("")).toEqual([]);
  expect(thought("Reading")).toMatchObject([{ type: "reasoning.delta", payload: { text: "Reading" } }]);
  expect(thought("Reading the repo", false)).toMatchObject([{ type: "reasoning.delta", payload: { text: " the repo" } }]);
});

test("a turn's checkpoint carries the files the turn itself changed, with their line counts; a baseline sends nothing", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-23T00:00:00.000Z", displayText: () => undefined };
  const captured = (runId: string | null, files: ReadonlyArray<{ path: string; kind: string; additions: number; deletions: number }>) =>
    projectEvent(state, { type: "checkpoint.captured", payload: { id: `cp-${runId}`, runId, ref: "refs/t3/x", status: "ready", files } } as unknown as OrchestrationV2DomainEvent, ctx).events;
  expect(captured("r1", [{ path: "pilot.md", kind: "modified", additions: 45, deletions: 0 }])).toMatchObject([
    { type: "checkpoint.created", turn_id: "r1", payload: { checkpoint_id: "cp-r1", ref: "refs/t3/x", files: [{ path: "pilot.md", additions: 45, deletions: 0 }] } },
  ]);
  expect(captured("r2", [])[0]!.payload).toEqual({ checkpoint_id: "cp-r2", ref: "refs/t3/x", files: [] });
  expect(captured(null, [{ path: "a", kind: "modified", additions: 1, deletions: 0 }])).toEqual([]);
});

test("a huge turn's checkpoint lists the files the wire carried and counts them all in files_total", () => {
  const state = emptyThreadState();
  const ctx = { at: "2026-10-23T00:00:00.000Z", displayText: () => undefined };
  const files = Array.from({ length: 200 }, (_, i) => ({ path: `vendor/${i}.ts`, kind: "added", additions: 2, deletions: 1 }));
  const filesTotal = { count: 250, additions: 500, deletions: 250 };
  const [created] = projectEvent(state, { type: "checkpoint.captured", payload: { id: "cp-big", runId: "r1", ref: "refs/t3/x", status: "ready", files, filesTotal } } as unknown as OrchestrationV2DomainEvent, ctx).events;
  expect(created!.payload).toMatchObject({ checkpoint_id: "cp-big", files_total: filesTotal });
  expect((created!.payload as { files: ReadonlyArray<unknown> }).files).toHaveLength(200);
});

describe("a Chief's no-op lines", () => {
  const setup = () => {
    const state = emptyThreadState();
    const ctx = { at: "2026-11-11T00:00:00.000Z", displayText: () => undefined, quietReply: CHIEF_QUIET };
    const project = (event: unknown) => projectEvent(state, event as OrchestrationV2DomainEvent, ctx).events;
    const run = (id: string, status: string) => project({ type: "run.updated", payload: { id, status, modelSelection: { model: "m" }, providerInstanceId: "caveman", rootNodeId: null } });
    const wake = (runId: string) => project({ type: "turn-item.updated", payload: { type: "notification", id: `n-${runId}`, runId, parentItemId: null, outcome: "updated", summary: "Fix changed" } });
    const note = (runId: string, messageId: string) => project({ type: "turn-item.updated", payload: { type: "user_message", runId, messageId, text: "did the login fix merge?", attachments: [], parentItemId: null } });
    const tool = (runId: string, id: string, toolName: string, status = "completed") => project({ type: "turn-item.updated", payload: { id, runId, type: "dynamic_tool", toolName, input: {}, status } });
    const say = (runId: string, id: string, text: string, streaming = false) => project({ type: "message.updated", payload: { id, role: "assistant", text, runId, streaming } });
    const shown = (events: ReadonlyArray<DraftEvent>) => events.filter((e) => e.type === "message.delta" || e.type === "message.done").map((e) => (e.payload as { text: string }).text);
    return { run, wake, note, tool, say, shown };
  };

  test("a wake's no-op line never reaches the person, streamed or finished; its real lines show", () => {
    const { run, wake, tool, say, shown } = setup();
    run("w1", "running");
    wake("w1");
    expect(shown(say("w1", "a1", "Nothing new", true))).toEqual([]);
    expect(shown(say("w1", "a1", "Nothing new to act on."))).toEqual([]);
    expect(shown(say("w1", "a2", "Nothing here needs you."))).toEqual([]);
    // A correction of a hidden line: still a no-op, unseen; with something to say, it shows.
    expect(shown(say("w1", "a2", "Nothing needs you right now."))).toEqual([]);
    expect(shown(say("w1", "a2", "[[12]] needs your approval to push."))).toEqual(["[[12]] needs your approval to push."]);
    expect(shown(say("w1", "a3", "[[12]] found the slow start", true))).toEqual([]);
    expect(shown(say("w1", "a3", "[[12]] found the slow start: adapters load before the window opens."))).toEqual(["[[12]] found the slow start: adapters load before the window opens."]);
    // A no_answer wake: what it went ahead with is the news.
    expect(shown(say("w1", "a4", "Went with SQLite."))).toEqual(["Went with SQLite."]);
    // A closing word after only tools with cards goes; after a read, or a failed tool, it is the answer.
    tool("w1", "k1", "chat_send");
    expect(shown(say("w1", "a5", "Sent."))).toEqual([]);
    run("w2", "running");
    wake("w2");
    tool("w2", "k2", "chat_digest");
    expect(shown(say("w2", "b1", "Done."))).toEqual(["Done."]);
    run("w3", "running");
    wake("w3");
    tool("w3", "k3", "chat_send", "failed");
    expect(shown(say("w3", "b2", "Sent."))).toEqual(["Sent."]);
  });

  test("a person's note is always answered: a short reply shows, also when the note joined a wake's turn", () => {
    const { run, wake, note, tool, say, shown } = setup();
    run("t1", "running");
    note("t1", "m1");
    tool("t1", "k1", "chat_digest");
    expect(shown(say("t1", "c1", "Not yet."))).toEqual(["Not yet."]);
    tool("t1", "k2", "chat_start");
    expect(shown(say("t1", "c2", "Started."))).toEqual(["Started."]);
    expect(shown(say("t1", "c3", "Nothing needs you right now."))).toEqual(["Nothing needs you right now."]);
    // A note steered into a wake's turn: no longer a wake.
    run("w1", "running");
    wake("w1");
    note("w1", "m2");
    expect(shown(say("w1", "c4", "Nothing new to act on."))).toEqual(["Nothing new to act on."]);
    // A long reply streams as it comes.
    const long = "[[3]] fixed the wrap. ".repeat(10);
    expect(shown(say("t1", "c5", long, true))).toEqual([long]);
  });

  test("any other thread streams and shows everything", () => {
    const state = emptyThreadState();
    const plain = { at: "2026-11-11T00:00:00.000Z", displayText: () => undefined };
    projectEvent(state, { type: "run.updated", payload: { id: "r1", status: "running", modelSelection: { model: "m" }, providerInstanceId: "caveman", rootNodeId: null } } as unknown as OrchestrationV2DomainEvent, plain);
    projectEvent(state, { type: "turn-item.updated", payload: { type: "notification", id: "n1", runId: "r1", parentItemId: null, outcome: "updated", summary: "x" } } as unknown as OrchestrationV2DomainEvent, plain);
    expect(projectEvent(state, { type: "message.updated", payload: { id: "c1", role: "assistant", text: "Noted.", runId: "r1", streaming: true } } as unknown as OrchestrationV2DomainEvent, plain).events.map((e) => e.type)).toEqual(["message.delta"]);
  });

  test("quietChiefReply hides only listed filler, only on a wake", () => {
    const wake = { wake: true, tools: [], toolFailed: false };
    for (const line of ["Nothing new to act on.", "Nothing here needs you.", "No reply needed.", "Noted.", "Nothing to report"]) expect([line, quietChiefReply(line, wake)]).toEqual([line, true]);
    for (const line of ["Not yet.", "No.", "Yes.", "Still failing.", "Needs your approval.", "Blocked on credentials.", "Waiting on you.", "Don't merge yet!", "Today's limit reached.", "Went with SQLite.", "Done."])
      expect([line, quietChiefReply(line, wake)]).toEqual([line, false]);
    expect(quietChiefReply("Started.", { wake: true, tools: ["mcp__chief__chat_start"], toolFailed: false })).toBe(true);
    expect(quietChiefReply("Started.", { wake: true, tools: ["chat_start", "memory_sql"], toolFailed: false })).toBe(false);
    for (const tools of [["playbook", "chat_send"], ["mcp__chief__playbook", "mcp__chief__react", "mcp__chief__chat_send"]]) {
      expect(quietChiefReply("Sent.", { ...wake, tools })).toBe(true);
      expect(quietChiefReply("Sent.", { ...wake, tools, toolFailed: true })).toBe(false);
      expect(quietChiefReply("Sent.", { ...wake, tools: [...tools, "chat_digest"] })).toBe(false);
    }
    expect(quietChiefReply("Done.", { ...wake, tools: ["playbook", "react"] })).toBe(false);
    for (const line of ["Nothing new to act on.", "Started.", "Not yet."]) expect(quietChiefReply(line, { wake: false, tools: ["chat_start"], toolFailed: false })).toBe(false);
  });

  test("after a reaction, a bare acknowledgement is hidden even on the person's note; a real answer still shows", () => {
    const reacted = { wake: false, tools: ["mcp__chief__react"], toolFailed: false };
    for (const line of ["Noted.", "On it!", "Got it.", "Queued", "Will do.", "Sounds good."]) expect([line, quietChiefReply(line, reacted)]).toEqual([line, true]);
    for (const line of ["Done.", "Started.", "OK.", "Okay.", "Not yet.", "Noted: the docs wait until Friday.", "Started the fix in app."]) expect([line, quietChiefReply(line, reacted)]).toEqual([line, false]);
    // A failed tool in the turn: the words may be about it, so they show.
    expect(quietChiefReply("Noted.", { ...reacted, toolFailed: true })).toBe(false);
    // No reaction: a note's short answer always shows.
    expect(quietChiefReply("Noted.", { wake: false, tools: ["queue_add"], toolFailed: false })).toBe(false);
  });
});
