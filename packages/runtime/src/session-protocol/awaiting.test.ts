// Workspace.activity.awaiting folded from a thread's own events (awaiting.ts): a turn that ended while a delegate, an
// awaited background task or a pull request watch still runs is at work, and stops being so when that work settles.
import type { OrchestrationV2DomainEvent } from "@caveman-app/protocol";
import type { WorkspaceActivity } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";

import { awaitingOf, foldBackground } from "./awaiting.ts";
import { emptyThreadState, projectEvent, type ThreadState } from "./projector.ts";
import { withAwaiting, type WorkspaceRecord } from "./store.ts";

const THREAD = "caveman:lead";
const ctx = { at: "2026-11-15T00:00:00.000Z", displayText: () => undefined };

/** Folds events as the daemon does: background first, then the projection, the state saved as JSON between events. */
const replay = (events: ReadonlyArray<unknown>, from: ThreadState = emptyThreadState()) => {
  let state = structuredClone(from);
  const seen: Array<boolean> = [];
  for (const raw of events) {
    const event = { threadId: THREAD, ...(raw as object) } as OrchestrationV2DomainEvent;
    foldBackground(state, event);
    projectEvent(state, event, ctx);
    seen.push(awaitingOf(state));
    state = JSON.parse(JSON.stringify(state)) as ThreadState;
  }
  return { state, seen, awaiting: seen.at(-1) ?? false };
};

const run = (id: string, status: string, fields: object = {}) => ({
  type: "run.updated",
  payload: {
    id,
    status,
    ordinal: Number(id.slice(1)),
    modelSelection: { model: "m" },
    providerInstanceId: "claudeAgent",
    rootNodeId: null,
    ...fields,
  },
});
const item = (id: string, type: string, status: string, fields: object = {}) => ({
  type: "turn-item.updated",
  payload: {
    id,
    type,
    status,
    runId: "r1",
    parentItemId: null,
    title: null,
    nativeItemRef: null,
    ...fields,
  },
});
const subagent = (status: string) =>
  item("sub-1", "subagent", status, {
    origin: "app_owned",
    childThreadId: "child",
    subagentId: "task-1",
    prompt: "Fix it",
    providerInstanceId: "claudeAgent",
    result: null,
  });
const roster = (tasks: ReadonlyArray<object>, fields: object = {}) => ({
  type: "provider-thread.updated",
  payload: {
    id: "pt-1",
    appThreadId: THREAD,
    status: "active",
    firstRunOrdinal: 1,
    nativeThreadRef: null,
    providerSessionId: "s1",
    providerInstanceId: "claudeAgent",
    pendingBackgroundTasks: tasks,
    ...fields,
  },
});
const link = (fields: object = {}) => ({
  host: "github.com",
  repository: "acme/app",
  number: 7,
  url: "https://github.com/acme/app/pull/7",
  source: "agent",
  linkedAt: "2026-11-15T00:00:00.000Z",
  snapshot: { state: "open" },
  stack: null,
  watch: {
    startedAt: "2026-11-15T00:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    passedChecks: [],
    remarksThrough: "2026-11-15T00:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
  ...fields,
});
const thread = (type: string, pullRequests: ReadonlyArray<object>, fields: object = {}) => ({
  type,
  payload: { id: THREAD, title: "Lead", activeProviderThreadId: null, pullRequests, ...fields },
});

describe("a chat awaits while its turn ended and work that wakes it still runs", () => {
  test("a delegated agent: from the turn's end until the agent ends", () => {
    const { seen } = replay([
      run("r1", "running"),
      subagent("running"),
      run("r1", "completed"),
      subagent("completed"),
    ]);
    // Never while the turn runs: the turn itself is the work then.
    expect(seen).toEqual([false, false, true, false]);
  });

  test("a turn that ended waiting for its checkpoint already awaits; a new turn is the work again", () => {
    const { seen } = replay([
      run("r1", "running"),
      subagent("running"),
      run("r1", "waiting"),
      run("r2", "running"),
    ]);
    expect(seen).toEqual([false, false, true, false]);
  });

  test("a held queued turn is no new work: the agent it waits on still counts", () => {
    const { seen } = replay([
      run("r1", "running"),
      subagent("running"),
      run("r1", "completed"),
      run("r2", "queued", { queueHeld: true }),
    ]);
    expect(seen.at(-1)).toBe(true);
  });

  test("background work the agent marked awaited (background_wait), or a background agent; a command left running is not", () => {
    const start = replay([run("r1", "running"), run("r1", "completed")]);
    expect(start.awaiting).toBe(false);
    // A dev server: the agent is done with it.
    expect(
      replay([roster([{ taskId: "t1", kind: "command", description: "pnpm dev" }])], start.state)
        .awaiting,
    ).toBe(false);
    // background_wait marks it: the agent acts on it when it ends.
    const marked = replay(
      [roster([{ taskId: "t1", kind: "command", awaited: true }])],
      start.state,
    );
    expect(marked.awaiting).toBe(true);
    expect(replay([roster([])], marked.state).awaiting).toBe(false);
    expect(replay([roster([{ taskId: "a1", kind: "subagent" }])], start.state).awaiting).toBe(true);
    expect(
      replay([roster([{ taskId: "b1", kind: "background_task" }])], start.state).awaiting,
    ).toBe(true);
  });

  test("only the thread's active provider thread's roster counts, and one handed to another thread leaves", () => {
    const start = replay([
      run("r1", "running"),
      run("r1", "completed"),
      roster([{ taskId: "b1", kind: "background_task" }]),
    ]);
    expect(start.awaiting).toBe(true);
    // Another provider thread became the active one (a switch): the old roster no longer speaks for the thread.
    expect(replay([roster([], { id: "pt-2" })], start.state).awaiting).toBe(false);
    expect(
      replay(
        [roster([{ taskId: "b1", kind: "background_task" }], { appThreadId: "caveman:other" })],
        start.state,
      ).awaiting,
    ).toBe(false);
    // A queued provider's placeholder is not active until delivery.
    const placeholder = roster([], {
      id: "pt-3",
      status: "not_loaded",
      firstRunOrdinal: null,
      providerSessionId: null,
    });
    expect(replay([placeholder], start.state).awaiting).toBe(true);
  });

  test("a persistent monitor and a rolled-back turn's work hold nothing", () => {
    const persistent = item("m1", "dynamic_tool", "running", {
      toolName: "monitor",
      input: { command: "tail -f log", persistent: true },
    });
    expect(replay([run("r1", "running"), persistent, run("r1", "completed")]).awaiting).toBe(false);
    expect(
      replay([
        run("r1", "running"),
        subagent("running"),
        run("r1", "rolled_back"),
        run("r2", "completed"),
      ]).awaiting,
    ).toBe(false);
  });

  test("a pull request it watches, until the pull request merges or the watch ends", () => {
    const start = replay([
      run("r1", "running"),
      run("r1", "completed"),
      thread("thread.pull-request-synced", [link()]),
    ]);
    expect(start.awaiting).toBe(true);
    expect(
      replay(
        [
          {
            type: "thread.pull-request-link-updated",
            payload: link({ snapshot: { state: "merged" } }),
          },
        ],
        start.state,
      ).awaiting,
    ).toBe(false);
    expect(
      replay(
        [{ type: "thread.pull-request-link-updated", payload: link({ watch: undefined }) }],
        start.state,
      ).awaiting,
    ).toBe(false);
    expect(
      replay(
        [
          {
            type: "thread.pull-request-link-updated",
            payload: link({ source: "stack-dismissed" }),
          },
        ],
        start.state,
      ).awaiting,
    ).toBe(false);
    // A visit carries the whole thread, its watch still on.
    expect(replay([thread("thread.visited", [link()])], start.state).awaiting).toBe(true);
 // A link update for a pull request the thread does not link changes nothing, as in upstream projection.
    const unlinked = replay([
      run("r1", "running"),
      run("r1", "completed"),
      { type: "thread.pull-request-link-updated", payload: link() },
    ]);
    expect(unlinked.awaiting).toBe(false);
  });

  test("a watch started on a chat that never ran a turn still awaits", () => {
    expect(replay([thread("thread.created", [link()])]).awaiting).toBe(true);
  });

  test("the answer after any prefix is the same whether the state was folded in one go or resumed from storage", () => {
    const events = [
      run("r1", "running"),
      subagent("running"),
      roster([{ taskId: "t1", kind: "command", awaited: true }]),
      run("r1", "completed"),
      thread("thread.pull-request-synced", [link()]),
      subagent("completed"),
      roster([]),
      {
        type: "thread.pull-request-link-updated",
        payload: link({ snapshot: { state: "merged" } }),
      },
    ];
    const whole = replay(events).seen;
    expect(whole).toEqual([false, false, false, true, true, true, true, false]);
    for (let cut = 1; cut < events.length; cut++) {
      const head = replay(events.slice(0, cut));
      expect([...head.seen, ...replay(events.slice(cut), head.state).seen]).toEqual(whole);
    }
  });
});

describe("withAwaiting", () => {
  const record = (activity?: WorkspaceActivity) =>
    ({
      workspace: {
        id: "w",
        updated_at: "2026-11-15T00:00:00.000Z",
        ...(activity ? { activity } : {}),
      },
      session: {},
      internal: {},
    }) as unknown as WorkspaceRecord;

  test("sets and clears it without moving updated_at, and leaves a record that already says so alone", () => {
    const ended = record({
      last_outcome: "completed",
      turn_ended_at: "2026-11-15T00:00:00.000Z",
      last_reply: "Delegated.",
    });
    const marked = withAwaiting(ended, true);
    expect(marked.workspace).toEqual({
      id: "w",
      updated_at: "2026-11-15T00:00:00.000Z",
      activity: {
        last_outcome: "completed",
        turn_ended_at: "2026-11-15T00:00:00.000Z",
        awaiting: true,
        last_reply: "Delegated.",
      },
    });
    expect(withAwaiting(marked, true)).toBe(marked);
    expect(withAwaiting(ended, false)).toBe(ended);
    expect(withAwaiting(marked, false).workspace).toEqual(ended.workspace);
    expect(withAwaiting(record(), true).workspace.activity).toEqual({ awaiting: true });
    expect(withAwaiting(record({ awaiting: true }), false).workspace).not.toHaveProperty(
      "activity",
    );
  });
});
