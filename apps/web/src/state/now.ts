// What an agent is doing this second, for the Overview's Agents card, the
// Agents tab, the inbox's row lines and the strip on a chat's box: every
// subagent with its newest step, read from a SessionView's items.

import type { Workspace } from "@caveman-app/session-protocol";
import type { WireRunner } from "./runner.ts";
import type { ToolItem, TranscriptItem } from "./transcript-model.ts";

type SubagentItem = Extract<TranscriptItem, { kind: "subagent" }>;

/** One line for what an agent does: "Running go test ./...". `live` while it is happening. */
export interface StepLine {
  readonly text: string;
  readonly icon: ToolItem["icon"] | "thinking" | "writing";
  readonly live: boolean;
}

export interface AgentNow {
  readonly id: string;
  readonly title: string;
  /** A delegated agent's own workspace; null for an engine's native subagent. */
  readonly workspaceId: string | null;
  readonly status: SubagentItem["status"];
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly engine: string | null;
  readonly runner: WireRunner | null;
  readonly summary: string | null;
  /** Under another subagent: 1 for the session's own. */
  readonly depth: number;
  /** Its newest step; null before it took one. */
  readonly step: StepLine | null;
  /** Tool calls it made, its own subagents' included. */
  readonly steps: number;
  /** A question it waits on (asks inside it, unresolved). */
  readonly asking: boolean;
  /** Its own transcript. */
  readonly items: ReadonlyArray<TranscriptItem>;
}

/** Every subagent in the transcript, nested ones after their parent, each with what it does now. */
export function agentsOf(items: ReadonlyArray<TranscriptItem>, depth = 1, out: AgentNow[] = []): AgentNow[] {
  for (const it of items) {
    if (it.kind !== "subagent") continue;
    out.push({
      id: it.id,
      title: it.title,
      workspaceId: it.workspaceId,
      status: it.status,
      startedAt: it.startedAt,
      finishedAt: it.finishedAt,
      engine: it.agent,
      runner: it.runner,
      summary: it.summary,
      depth,
      step: it.status === "running" ? latestStep(it.items) : null,
      steps: countTools(it.items),
      asking: it.items.some((a) => a.kind === "ask" && a.resolution === null),
      items: it.items,
    });
    agentsOf(it.items, depth + 1, out);
  }
  return out;
}

/** An agent a chat's turn left at work. */
export interface AtWork {
  readonly id: string;
  readonly title: string;
  readonly startedAt: string;
  /** It waits on the person rather than working. */
  readonly asking: boolean;
  /** What it is doing this second ("Reading retry.go"), when its row shows its steps; null otherwise. */
  readonly activity: string | null;
  /** When that step began, to tell the newest; "" when unknown. */
  readonly activityAt: string;
}

/** When the newest of these steps began: its newest tool call's start, "" when it has none since the person spoke. */
function newestStepAt(items: ReadonlyArray<TranscriptItem>): string {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool") return it.startedAt;
    if (it.kind === "user" || it.kind === "turn_end") break;
  }
  return "";
}

/**
 * The agent at work whose activity is newest, for the strip on the box (upstream #25299: the line shows the newest
 * activity rather than a list): the latest step begun, else the last listed with one; null when none says what it does.
 */
export function newestActivity(agents: ReadonlyArray<AtWork>): AtWork | null {
  let best: AtWork | null = null;
  for (const a of agents) if (a.activity !== null && (best === null || a.activityAt >= best.activityAt)) best = a;
  return best;
}

/** An agent the chat started as its own chat: a builder or a delegated agent. */
type ChildChat = Pick<Workspace, "id" | "title" | "status" | "created_at">;

/**
 * What a chat waits on, as its Agents card counts them: its subagents still running (nested ones
 * included) and the chats it started still at work, each once. A delegated agent's own chat says
 * whether it works; its row in the transcript says when it started.
 */
export function agentsAtWork(items: ReadonlyArray<TranscriptItem>, children: ReadonlyArray<ChildChat>): AtWork[] {
  const agents = agentsOf(items);
  const chats = new Set(children.map((c) => c.id));
  const doing = (a: AgentNow | undefined) => ({ activity: a?.step?.text || null, activityAt: a?.step ? newestStepAt(a.items) : "" });
  return [
    ...children
      .filter((c) => c.status === "starting" || c.status === "working" || c.status === "needs_input")
      .map((c) => {
        const row = agents.find((a) => a.workspaceId === c.id);
        return { id: c.id, title: c.title, startedAt: row?.startedAt || c.created_at, asking: c.status === "needs_input", ...doing(row) };
      }),
    ...agents.filter((a) => a.status === "running" && !(a.workspaceId !== null && chats.has(a.workspaceId))).map((a) => ({ id: a.id, title: a.title, startedAt: a.startedAt, asking: a.asking, ...doing(a) })),
  ];
}

/** An agent's newest step since the person last spoke: what it is doing this second. */
export function latestStep(items: ReadonlyArray<TranscriptItem>): StepLine | null {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]!;
    if (it.kind === "tool") return { text: [it.verb, it.subject].filter(Boolean).join(" "), icon: it.icon, live: it.status === "running" };
    if (it.kind === "subagent") return { text: it.title, icon: "agent", live: it.status === "running" };
    if (it.kind === "reasoning" && it.streaming) return { text: "Thinking", icon: "thinking", live: true };
    if (it.kind === "assistant") return { text: firstLine(it.text), icon: "writing", live: it.streaming };
    if (it.kind === "user" || it.kind === "turn_end") break;
  }
  return null;
}

function countTools(items: ReadonlyArray<TranscriptItem>): number {
  let n = 0;
  for (const it of items) {
    if (it.kind === "tool") n++;
    else if (it.kind === "subagent") n += countTools(it.items);
  }
  return n;
}

/** The first line of markdown as plain words. */
export function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim()) ?? "";
  return line
    .replace(/^\s*(?:#+|>|[-*+]|\d+\.)\s+/, "")
    .replace(/`|\*\*/g, "")
    .replace(/(^|\s)[*_](\S(?:.*?\S)?)[*_](?=\s|[.,;:!?]|$)/g, "$1$2")
    .trim();
}

/** "12s", "4m 08s", "1h 04m": a clock that reads at a glance and never jumps width within a unit. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
