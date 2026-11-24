// What an org workload spends, for Cloud's meter (POST /api/v1/code/runtime/usage, control-api code/tree.go): every
// model call of the session's tree keyed by Cloud's session id. That report charges the tree budget a caller set
// (`budget_usd`) and is what the session object's `usage` sums; its answer says when the tree parked. A session's tree
// is the workspace it runs as (an automation's: the workspaces its run's steps were adopted as) and every
// delegate_task child under them. Only numbers and the model leave, as for This Mac's local usage.
import type { SessionEvent } from "@caveman-app/session-protocol";

import type { WorkspaceRecord } from "../session-protocol/store.ts";
import type { SessionUsageEvent } from "./sessions.ts";

type Usage = Extract<SessionEvent, { type: "usage" }>["payload"];

/** At most this many calls a report (Cloud refuses more). */
export const USAGE_BATCH = 100;

/** The local workspaces and sessions whose calls are a Cloud session's. */
export function treeOf(
  row: { readonly localSessionId: string; readonly start: { readonly automation?: { readonly run_id: string } | null } },
  records: ReadonlyArray<WorkspaceRecord>,
): { readonly sessions: ReadonlyArray<string>; readonly workspaces: ReadonlyArray<string>; readonly records: ReadonlyArray<WorkspaceRecord> } {
  const runId = row.start.automation?.run_id;
  const roots = row.localSessionId.startsWith("automation:")
    ? records.filter((r) => runId !== undefined && r.internal.automation?.run === runId)
    : records.filter((r) => r.session.id === row.localSessionId);
  const ids = new Set(roots.map((r) => r.workspace.id));
  for (let grew = true; grew; ) {
    grew = false;
    for (const r of records) {
      const parent = r.workspace.parent_workspace_id;
      if (!ids.has(r.workspace.id) && parent !== undefined && ids.has(parent)) {
        ids.add(r.workspace.id);
        grew = true;
      }
    }
  }
  const members = records.filter((r) => ids.has(r.workspace.id));
  return { sessions: members.map((r) => r.session.id), workspaces: [...ids], records: members };
}

/**
 * One call as Cloud's meter takes it, or undefined for what is no model call (a web search, billed where it ran).
 * A cost Cloud would not take (a basis other than billed or list_price) goes as unmeasured: an honest null.
 */
export function usageEventOf(requestId: string, sessionId: string, at: string, usage: Usage & { readonly bucket?: string }): SessionUsageEvent | undefined {
  if (usage.bucket === "web") return undefined;
  const basis = usage.cost?.basis;
  return {
    request_id: requestId,
    session_id: sessionId,
    model: (usage.model ?? "").slice(0, 200) || "unknown",
    input_tokens: usage.input_tokens,
    output_tokens: usage.output_tokens,
    cache_read_tokens: usage.cache_read_tokens,
    cache_write_tokens: usage.cache_write_tokens,
    routed: false,
    cost: usage.cost && (basis === "billed" || basis === "list_price") ? { usd: usage.cost.usd, basis } : null,
    occurred_at: at,
  };
}
