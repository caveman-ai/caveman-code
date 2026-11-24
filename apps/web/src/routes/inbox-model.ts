// The inbox as one queue of stacks. The top two wait on the person (decisions);
// the rest are agents at work, shown so nothing runs out of sight. Inside a
// stack the row that has waited longest leads, so every agent gets served in turn.

import type { Result } from "@caveman-app/session-protocol";
import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { chatStatuses, type ChatStatus, type WorkspaceView } from "../state/model.ts";
import { firstLine, latestStep } from "../state/now.ts";
import type { SessionView, TranscriptItem } from "../state/transcript-model.ts";

export type StackId = "needs" | "review" | "working" | "waiting" | "done";

export interface InboxRow {
  readonly workspace: WorkspaceView;
  /** Its status (model.ts chatStatus), its agents counted: what its stack and its glyph say. */
  readonly status: ChatStatus | null;
  /** What the stack orders by and the row's age counts from. */
  readonly since: string;
}

export interface Stack {
  readonly id: StackId;
  readonly label: string;
  readonly icon: PixelIconName;
  /** Waits on the person: never folded away. */
  readonly decision: boolean;
  readonly rows: ReadonlyArray<InboxRow>;
}

/**
 * The open row. It keeps the stack and place it had when opened until the
 * user moves on, so reading it (which marks it seen) or answering it never
 * pulls it out from under them.
 */
export interface Hold {
  readonly id: string;
  readonly stack: StackId;
  readonly since: string;
}

// Stacks pick by status, not raw state: a lead whose own turn ended while its agents work is at work,
// not ready for review, and a plan waiting to be built is the person's to review.
const STACKS: ReadonlyArray<Omit<Stack, "rows"> & { pick: (w: WorkspaceView, s: ChatStatus | null) => boolean; since: (w: WorkspaceView) => string }> = [
  { id: "needs", label: "Needs you", icon: "state-needs-input", decision: true, pick: (_, s) => s?.id === "approve" || s?.id === "secret" || s?.id === "answer", since: (w) => w.updatedAt },
  {
    id: "review",
    label: "Ready for review",
    icon: "state-done",
    decision: true,
    pick: (w, s) => s?.id === "ready" || s?.id === "done" || s?.id === "stopped" || (s?.id === "failed" && w.unread),
    since: (w) => w.updatedAt,
  },
  // Running and queued work keeps its start order: rows never reshuffle as events land.
  { id: "working", label: "Working", icon: "state-working", decision: false, pick: (_, s) => s?.id === "working" || s?.id === "agents", since: (w) => w.createdAt },
  { id: "waiting", label: "Waiting", icon: "state-queued", decision: false, pick: (_, s) => s?.id === "queued" || s?.id === "asleep", since: (w) => w.createdAt },
];

/** Every live workspace in its stack, oldest first; empty stacks are left out. */
export function stacksForInbox(workspaces: ReadonlyArray<WorkspaceView>, hold: Hold | null): Stack[] {
  const live = workspaces.filter((w) => w.state !== "archived");
  const statuses = chatStatuses(live);
  return STACKS.flatMap(({ pick, since, ...stack }) => {
    const rows = live
      .filter((w) => (w.id === hold?.id ? hold.stack === stack.id : pick(w, statuses.get(w.id) ?? null)))
      .map((w) => ({ workspace: w, status: statuses.get(w.id) ?? null, since: w.id === hold?.id ? hold.since : since(w) }))
      .sort((a, b) => a.since.localeCompare(b.since) || a.workspace.id.localeCompare(b.workspace.id));
    return rows.length > 0 ? [{ ...stack, rows }] : [];
  });
}

/**
 * Finished today and already read, so out of the stacks above: the board's
 * closing stack, newest first. Null when there is none.
 */
export function doneToday(workspaces: ReadonlyArray<WorkspaceView>, stacks: ReadonlyArray<Stack>, now = new Date()): Stack | null {
  const shown = new Set(stacks.flatMap((s) => s.rows.map((r) => r.workspace.id)));
  const today = now.toDateString();
  const rows = workspaces
    .filter((w) => (w.state === "completed" || w.state === "failed") && !shown.has(w.id) && new Date(w.updatedAt).toDateString() === today)
    .map((w) => ({ workspace: w, status: null, since: w.updatedAt }))
    .sort((a, b) => b.since.localeCompare(a.since) || a.workspace.id.localeCompare(b.workspace.id));
  return rows.length > 0 ? { id: "done", label: "Done today", icon: "state-done", decision: false, rows } : null;
}

/** Hold a row where it stands now. */
export function holdFor(stacks: ReadonlyArray<Stack>, id: string): Hold | null {
  for (const s of stacks) {
    const row = s.rows.find((r) => r.workspace.id === id);
    if (row) return { id, stack: s.id, since: row.since };
  }
  return null;
}

type LineView = Pick<SessionView, "items" | "pendingAsk" | "changedFiles">;

/**
 * A row's second line, the one thing worth reading about it: the question it
 * asks, what it said when it finished, or what it is doing this second.
 * `live` marks an action in progress (it shimmers).
 */
export function rowLine(w: WorkspaceView, view: LineView | null): { text: string; live: boolean } {
  const where = w.branch ? `${w.repo} · ${w.branch}` : w.repo;
  const said = lastSaid(view);
  switch (w.state) {
    case "needs_input":
      return { text: view?.pendingAsk?.prompt ?? `${w.repo} · waiting for you`, live: false };
    case "failed":
      return { text: `Failed · ${said ?? where}`, live: false };
    case "completed": {
      const files = view && view.changedFiles > 0 ? `${view.changedFiles} ${view.changedFiles === 1 ? "file" : "files"} · ` : "";
      return { text: files + (said ?? where), live: false };
    }
    case "working":
      return activityOf(view) ?? { text: where, live: false };
    case "queued":
      return { text: w.asleep ? `Asleep on ${w.computer.label}` : `Queued for ${w.computer.label}`, live: false };
    default:
      return { text: where, live: false };
  }
}

/** What a running agent is doing now: its latest step since the person last spoke. */
function activityOf(view: LineView | null): { text: string; live: boolean } | null {
  const step = latestStep(view?.items ?? []);
  return step ? { text: step.text, live: step.live } : null;
}

function lastSaid(view: LineView | null): string | null {
  const last = [...(view?.items ?? [])].reverse().find((i) => i.kind === "assistant");
  return last?.kind === "assistant" ? firstLine(last.text) || null : null;
}

/** Tool calls per minute over the last `minutes`, oldest first. A flat line is an agent gone quiet. */
export function pulseOf(items: ReadonlyArray<TranscriptItem>, now: number, minutes = 15): number[] {
  const bins = new Array<number>(minutes).fill(0);
  const walk = (list: ReadonlyArray<TranscriptItem>) => {
    for (const it of list) {
      if (it.kind === "subagent") walk(it.items);
      if (it.kind !== "tool") continue;
      const ago = Math.floor((now - Date.parse(it.startedAt)) / 60_000);
      if (ago >= 0 && ago < minutes) bins[minutes - 1 - ago]! += 1;
    }
  };
  walk(items);
  return bins;
}

/** Lines the agent's own edits added and removed, its builders included. */
export function linesOf(items: ReadonlyArray<TranscriptItem>): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const it of items) {
    if (it.kind === "tool") {
      added += it.added ?? 0;
      removed += it.removed ?? 0;
    } else if (it.kind === "subagent") {
      const sub = linesOf(it.items);
      added += sub.added;
      removed += sub.removed;
    }
  }
  return { added, removed };
}

export type SpendRow = Result<"spend.summary">["rows"][number];

/**
 * A session's spend as measured. A session on a subscription plan has no
 * per-call price, and says so; a per-token key on a model with no public
 * price says Unpriced: never a guess.
 */
type PlanWindows = ReadonlyArray<{ readonly label: string; readonly used_percent: number }> | undefined;

/** A plan's windows as the engine reports them, most used first: "Weekly 37%". Empty without any. */
export const planWindows = (windows: PlanWindows): ReadonlyArray<string> =>
  [...(windows ?? [])].sort((a, b) => b.used_percent - a.used_percent).map((w) => `${w.label} ${Math.round(w.used_percent)}%`);

/** A session's spend, in its peek: measured dollars, or on a plan its tokens and the plan's most-used window (the engine's `usage_limits`). */
export function spendText(row: SpendRow | undefined, windows?: PlanWindows): { text: string; title: string } | null {
  if (!row) return null;
  const tokens = compact(row.input_tokens + row.output_tokens + row.cache_read_tokens + row.cache_write_tokens);
  if (row.measured_usd === null) {
    if (row.basis === "plan") {
      const used = planWindows(windows);
      return {
        text: used.length > 0 ? `${tokens} · ${used[0]}` : `${tokens} tokens`,
        title: `${tokens} tokens on a subscription plan: no per-call price${used.length > 0 ? `. Plan used: ${used.join(" · ")}` : ""}`,
      };
    }
    if (row.basis === "unpriced") return { text: "Unpriced", title: `${tokens} tokens on your key: this model has no public price` };
    return { text: "Tokens", title: `${tokens} tokens: no price recorded` };
  }
  const basis = row.basis === "billed" ? "billed" : row.basis === "list_price" ? "at list price" : "partly priced (billed, list price, plan or unpriced)";
  const searches = row.web_searches ?? 0;
  return { text: usd(row.measured_usd), title: `${tokens} tokens, ${basis}${searches > 0 ? `; includes ${searches} web search${searches === 1 ? "" : "es"}` : ""}` };
}

const usd = (n: number) => `$${n < 100 ? n.toFixed(2) : Math.round(n).toLocaleString()}`;
export const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n));
