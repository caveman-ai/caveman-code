// How an agent's state reads in the Agents tab and the Overview's Agents
// card: a label and a shape, never colour alone.

import type { BuilderState, Workspace } from "@caveman-app/session-protocol";
import { short } from "../../lib/short.ts";
import { resetTime } from "../../state/transcript.ts";

export { short };

export type Mark = "working" | "needs" | "done" | "failed" | "waiting" | "merged" | "left_out" | "paused";

/** Each state's shape: a ring, a hollow or flat one where colour alone would tell two apart. */
export const MARK: Record<Mark, string> = {
  working: "rounded-full bg-success",
  needs: "rotate-45 rounded-[1px] bg-warning",
  done: "rounded-full bg-muted-foreground",
  failed: "rounded-[1px] bg-destructive",
  waiting: "rounded-full border border-dashed border-muted-foreground",
  // Its work is in: a ring, not working's dot.
  merged: "rounded-full border-[1.5px] border-success",
  // Its work is not in: an empty square.
  left_out: "rounded-[1px] border border-warning",
  // Waiting for its plan's reset: a flat bar.
  paused: "scale-y-[0.45] rounded-[1px] bg-warning",
};

export const WORKSPACE_STATE: Record<Workspace["status"], { readonly label: string; readonly mark: Mark }> = {
  starting: { label: "Working", mark: "working" },
  working: { label: "Working", mark: "working" },
  needs_input: { label: "Needs input", mark: "needs" },
  idle: { label: "Done", mark: "done" },
  failed: { label: "Failed", mark: "failed" },
  waiting: { label: "Waiting", mark: "waiting" },
  parked: { label: "Parked", mark: "waiting" },
  archived: { label: "Archived", mark: "done" },
};

export const SUBAGENT_STATE = {
  running: { label: "Working", mark: "working" },
  done: { label: "Done", mark: "done" },
  failed: { label: "Failed", mark: "failed" },
  stopped: { label: "Stopped", mark: "failed" },
} as const satisfies Record<string, { label: string; mark: Mark }>;

const RESTING: ReadonlyArray<Workspace["status"]> = ["idle", "archived"];

/**
 * A delegated agent's row: its workspace's state, except that a workspace at rest whose run its lead saw end
 * stopped or failed (the lead's subagent item, `ended`) reads so, as its card in the lead's chat does. Its
 * workspace is idle, which alone would read "Done".
 */
export function builderState(status: Workspace["status"], ended: keyof typeof SUBAGENT_STATE | undefined): { readonly label: string; readonly mark: Mark } {
  return (ended === "stopped" || ended === "failed") && RESTING.includes(status) ? SUBAGENT_STATE[ended] : WORKSPACE_STATE[status];
}

export interface RowState {
  readonly label: string;
  readonly mark: Mark;
  /** More than the label says, for the row's hover: the plan a paused builder waits for. */
  readonly hint?: string;
}

/**
 * A builder's row from what its lead's runtime says became of it (Workspace.builder): "Working", "Done", "Merged",
 * "Left out: conflicts in a.ts", "Paused until 11:08 PM" (in the person's own clock; "Paused" when its plan named no
 * time), "Failed: its agent stopped". From a runtime before that field, the row reads as it did (builderState).
 */
export function builderRow(w: Pick<Workspace, "status"> & { readonly builder?: BuilderState | undefined }, ended: keyof typeof SUBAGENT_STATE | undefined, now = new Date()): RowState {
  const b = w.builder;
  if (!b) return builderState(w.status, ended);
  const why = b.why?.trim();
  switch (b.state) {
    case "working":
      return { label: "Working", mark: "working" };
    case "done":
      return { label: "Done", mark: "done" };
    case "merged":
      return { label: "Merged", mark: "merged" };
    case "left_out":
      return { label: why ? `Left out: ${why}` : "Left out", mark: "left_out" };
    case "paused": {
      const until = resetTime(b.until, now);
      return { label: until ? `Paused until ${until}` : "Paused", mark: "paused", ...(b.plan ? { hint: `${b.plan} used up` } : {}) };
    }
    case "failed":
      return { label: why ? `Failed: ${why}` : "Failed", mark: "failed" };
  }
}


/**
 * A lead's or builder's clock, read the way the Overview's Agents card reads it and a subagent's row
 * does: how long it has been at work (since its last change) while it works, how long it took once
 * it stopped. Never how long ago it last changed, which beside a subagent's duration read as one.
 */
export function workspaceClock(w: Pick<Workspace, "status" | "created_at" | "updated_at">, now: number): { readonly time: string; readonly title: string } {
  const live = w.status === "working" || w.status === "starting" || w.status === "needs_input";
  if (live) return { time: short(now - Date.parse(w.updated_at)), title: "Working for" };
  return { time: short(Date.parse(w.updated_at) - Date.parse(w.created_at)), title: "Took" };
}
