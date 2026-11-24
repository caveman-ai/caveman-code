import { cn } from "@caveman-app/ui/lib/cn";
import { RunnerMark, runnerEdge, type Runner } from "@caveman-app/ui/components/runner-badge";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { useState } from "react";
import { MARK, type Mark } from "../../../panels/agents/states.ts";
import { clock } from "../../../state/now.ts";
import { Card, Fold } from "./Card.tsx";

// The Overview's Agents card: every builder and subagent working for this
// chat, each saying what it is doing this second. A row opens that agent in
// the panel (AgentView); finished agents fold under one line while others
// still work.

export interface AgentRowView {
  readonly key: string;
  readonly title: string;
  readonly state: { readonly label: string; readonly mark: Mark };
  readonly runner: Runner;
  /** What it does now (live) or the last thing it said; null before its first step. */
  readonly line: { readonly text: string; readonly live: boolean } | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  /** 1 for this chat's own; deeper ones sit under their parent. */
  readonly depth: number;
}

const LIVE: ReadonlyArray<Mark> = ["working", "needs"];

/** The card's one-line count: who needs you, else who works, else how the finished ones ended (stopped ones never count as done). */
export function agentsSummary(rows: ReadonlyArray<Pick<AgentRowView, "state">>): string {
  const needs = rows.filter((r) => r.state.mark === "needs").length;
  if (needs > 0) return `${needs} ${needs === 1 ? "needs" : "need"} you`;
  const live = rows.filter((r) => LIVE.includes(r.state.mark)).length;
  if (live > 0) return `${live} working`;
  const finished = rows.length;
  const stopped = rows.filter((r) => r.state.mark === "failed").length;
  return stopped === 0 ? `${finished} done` : stopped === finished ? `${stopped} stopped` : `${finished - stopped} done, ${stopped} stopped`;
}

export function AgentsCard({ rows, at, onOpen }: { rows: ReadonlyArray<AgentRowView>; at: number; onOpen: (key: string) => void }) {
  const live = rows.filter((r) => LIVE.includes(r.state.mark));
  const finished = rows.filter((r) => !LIVE.includes(r.state.mark));
  const needs = rows.filter((r) => r.state.mark === "needs").length;
  const [showFinished, setShowFinished] = useState(false);
  const list = (shown: ReadonlyArray<AgentRowView>, label: string) => (
    <ul aria-label={label} className="flex flex-col gap-px">
      {shown.map((r) => (
        <AgentRow key={r.key} row={r} at={at} onOpen={() => onOpen(r.key)} />
      ))}
    </ul>
  );
  return (
    <Card
      title="Agents"
      defaultOpen
      {...(needs > 0 ? { tone: "attention" as const } : {})}
      aside={
        <span className="flex items-center gap-1.5 text-[12px] tabular-nums text-muted-foreground">
          {live.length > 0 ? <span aria-hidden className={cn("size-1.5 shrink-0", MARK[needs > 0 ? "needs" : "working"])} /> : null}
          <span key={`${needs}:${live.length}`} className="animate-in fade-in-0 duration-150">
            {agentsSummary(rows)}
          </span>
        </span>
      }
    >
      {live.length > 0 ? list(live, "Agents at work") : null}
      {finished.length > 0 && live.length > 0 ? (
        <>
          <button
            type="button"
            aria-expanded={showFinished}
            onClick={() => setShowFinished(!showFinished)}
            className="mt-px flex h-7 w-full items-center gap-1.5 rounded-md px-2.5 text-left text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <Icon icon={ArrowRight01Icon} className={cn("size-3.5 transition-transform duration-150 ease-snap", showFinished && "rotate-90")} />
            {finished.length} finished
          </button>
          <Fold open={showFinished}>{list(finished, "Finished agents")}</Fold>
        </>
      ) : finished.length > 0 ? (
        list(finished, "Finished agents")
      ) : null}
    </Card>
  );
}

/** One agent: who runs it, what it does now, its clock. The whole row opens it. */
function AgentRow({ row, at, onOpen }: { row: AgentRowView; at: number; onOpen: () => void }) {
  const live = LIVE.includes(row.state.mark);
  const edge = runnerEdge(row.runner.engine, row.state.mark === "working");
  const end = live ? at : row.finishedAt ? Date.parse(row.finishedAt) : null;
  const time = row.startedAt && end !== null ? clock(end - Date.parse(row.startedAt)) : null;
  return (
    <li {...edge} style={{ ...edge.style, marginLeft: (row.depth - 1) * 14 }} className={cn(edge.className, "rounded-md animate-in fade-in-0 duration-150 ease-snap motion-reduce:animate-none")}>
      <button
        type="button"
        onClick={onOpen}
        data-agent-key={row.key}
        aria-label={`Open ${row.title}: ${row.state.label}${row.line ? `, ${row.line.text}` : ""}`}
        className="group/agent flex w-full items-center gap-2.5 rounded-md py-1.5 pl-2.5 pr-1.5 text-left outline-none transition-colors duration-75 hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <RunnerMark runner={row.runner} size={20} className="w-7" />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] text-foreground">{row.title}</span>
            {time ? (
              <span title={live ? "Working for" : "Took"} className="shrink-0 text-[12px] leading-[18px] tabular-nums text-[hsl(var(--subtle-foreground))]">
                {time}
              </span>
            ) : null}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-muted-foreground">
            <span aria-hidden className={cn("size-1.5 shrink-0", MARK[row.state.mark])} />
            <span
              key={row.line?.text ?? row.state.label}
              className={cn("min-w-0 truncate animate-in fade-in-0 duration-150", row.line?.live && "lucy-shimmer", row.state.mark === "needs" && "text-[hsl(var(--warning))]")}
            >
              {row.line?.text || row.state.label}
            </span>
          </span>
        </span>
        <Icon icon={ArrowRight01Icon} className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-[opacity,transform] duration-150 ease-snap group-hover/agent:translate-x-0.5 group-hover/agent:opacity-100 group-focus-visible/agent:opacity-100" />
      </button>
    </li>
  );
}
