// An org workload's spend for Cloud's meter: the session's own workspace (or its automation run's step workspaces)
// and every delegate_task child under them; numbers and the model only, an unmeasured cost as null.
import type { WorkspaceRecord } from "../session-protocol/store.ts";
import { expect, test } from "vitest";

import { treeOf, usageEventOf } from "./sessionUsage.ts";

const record = (id: string, extra: { parent?: string; run?: string } = {}) =>
  ({
    workspace: { id, session_id: `s-${id}`, ...(extra.parent ? { parent_workspace_id: extra.parent } : {}) },
    session: { id: `s-${id}` },
    internal: { threadId: `t-${id}`, ...(extra.run ? { automation: { automation: "triage", run: extra.run, step: "fix", attempt: 1 } } : {}) },
  }) as unknown as WorkspaceRecord;

const records = [
  record("lead"),
  record("child", { parent: "lead" }),
  record("grandchild", { parent: "child" }),
  record("other"),
  record("step1", { run: "run_1" }),
  record("step1-child", { parent: "step1" }),
  record("step-other-run", { run: "run_2" }),
];

test("an API session's tree is its workspace and every child under it, never a neighbour", () => {
  const tree = treeOf({ localSessionId: "s-lead", start: { automation: null } }, records);
  expect([...tree.workspaces].sort()).toEqual(["child", "grandchild", "lead"]);
  expect([...tree.sessions].sort()).toEqual(["s-child", "s-grandchild", "s-lead"]);
});

test("an automation session's tree is its run's step workspaces and their children", () => {
  const tree = treeOf({ localSessionId: "automation:sesn_1", start: { automation: { run_id: "run_1" } } }, records);
  expect([...tree.workspaces].sort()).toEqual(["step1", "step1-child"]);
  expect(treeOf({ localSessionId: "pending:sesn_1", start: { automation: null } }, records).sessions).toEqual([]);
});

test("a call goes as Cloud's meter takes it; a web search is no model call; a cost Cloud would not take goes as null", () => {
  const usage = { model: "claude-sonnet-4-6", input_tokens: 10, output_tokens: 2, cache_read_tokens: 5, cache_write_tokens: 1, cost: { usd: 0.25, basis: "list_price" as const }, billing: "api_key" as const };
  expect(usageEventOf("s-lead:7", "sesn_1", "2026-10-21T10:00:00.000Z", usage)).toEqual({
    request_id: "s-lead:7",
    session_id: "sesn_1",
    model: "claude-sonnet-4-6",
    input_tokens: 10,
    output_tokens: 2,
    cache_read_tokens: 5,
    cache_write_tokens: 1,
    routed: false,
    cost: { usd: 0.25, basis: "list_price" },
    occurred_at: "2026-10-21T10:00:00.000Z",
  });
  expect(usageEventOf("spend:1", "sesn_1", "2026-10-21T10:00:00.000Z", { ...usage, bucket: "web" })).toBeUndefined();
  expect(usageEventOf("spend:2", "sesn_1", "2026-10-21T10:00:00.000Z", { ...usage, cost: { usd: 1, basis: "guessed" } as never })?.cost).toBeNull();
  expect(usageEventOf("s-lead:8", "sesn_1", "2026-10-21T10:00:00.000Z", { ...usage, cost: null })?.cost).toBeNull();
});
