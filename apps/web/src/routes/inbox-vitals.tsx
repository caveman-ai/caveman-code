// How a session is going, drawn rather than written: the context window as
// pixel cells, an activity pulse, plan progress. The words live one layer
// down, in the peek: a card that opens on hover with everything about one
// session, so the queue can stay quiet.

import { Tooltip, TooltipContent, TooltipTrigger } from "@caveman-app/ui/components/tooltip";
import { cn } from "@caveman-app/ui/lib/cn";
import { useState, type ReactElement, type ReactNode } from "react";
import { EngineMark } from "../components/transcript/marks.tsx";
import type { WorkspaceView } from "../state/model.ts";
import { useRuntimeSelector } from "../state/runtime.tsx";
import type { PlanStep, SessionView } from "../state/transcript-model.ts";
import { linesOf, pulseOf, rowLine, spendText, type SpendRow } from "./inbox-model.ts";

/**
 * How full the engine's context window is: pixel cells, lit ones turning to
 * the warning colour from 80%, where compaction is near.
 */
export function ContextMeter({ used, total, cells = 10, label = false }: { used: number; total: number; cells?: number; label?: boolean }) {
  const share = total > 0 ? Math.min(1, used / total) : 0;
  const lit = Math.round(share * cells);
  const pct = Math.round(share * 100);
  return (
    <span role="img" aria-label={`Context window ${pct}% full`} className="flex shrink-0 items-center gap-1.5">
      <span aria-hidden className="flex gap-px">
        {Array.from({ length: cells }, (_, i) => (
          <span key={i} className={cn("h-2 w-[3px]", i < lit ? (share >= 0.8 ? "bg-warning" : "bg-foreground/70") : "bg-muted-foreground/25")} />
        ))}
      </span>
      {label ? <span aria-hidden className="tabular-nums">{pct}%</span> : null}
    </span>
  );
}

/** Tool calls per minute over the last 15 minutes: momentum at a glance; flat is quiet. */
function Pulse({ bins }: { bins: ReadonlyArray<number> }) {
  const peak = Math.max(1, ...bins);
  const calls = bins.reduce((a, b) => a + b, 0);
  return (
    <span role="img" aria-label={`${calls} tool calls in the last 15 minutes`} className="flex h-3 shrink-0 items-end gap-px">
      {bins.map((n, i) => (
        <span key={i} className={cn("w-[2px]", n > 0 ? "bg-foreground/60" : "bg-muted-foreground/25")} style={{ height: n > 0 ? `${Math.max(4, Math.round((n / peak) * 12))}px` : "2px" }} />
      ))}
    </span>
  );
}

function PlanBar({ plan }: { plan: ReadonlyArray<PlanStep> }) {
  return (
    <span aria-hidden className="flex flex-1 gap-0.5">
      {plan.map((s, i) => (
        <span key={i} className={cn("h-1 flex-1 rounded-full", s.status === "completed" ? "bg-foreground/60" : s.status === "in_progress" ? "bg-foreground/30" : "bg-muted-foreground/20")} />
      ))}
    </span>
  );
}

/**
 * Wraps one row or tile: hovering it opens the session's whole story beside
 * it. `quiet` keeps it shut (the open agent is already on screen).
 */
export function Peek({ workspace, view, spend, quiet = false, side = "right", children }: { workspace: WorkspaceView; view: SessionView | null; spend: SpendRow | undefined; quiet?: boolean; side?: "right" | "bottom"; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip open={open && !quiet} onOpenChange={setOpen}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side} align="start" sideOffset={10} collisionPadding={12} className="w-[300px] p-0 text-[13px]">
        <SessionPeek workspace={workspace} view={view} spend={spend} />
      </TooltipContent>
    </Tooltip>
  );
}

function SessionPeek({ workspace: w, view, spend }: { workspace: WorkspaceView; view: SessionView | null; spend: SpendRow | undefined }) {
  const line = rowLine(w, view);
  const items = view?.items ?? [];
  const lines = linesOf(items);
  const bins = pulseOf(items, Date.now());
  const calls = bins.reduce((a, b) => a + b, 0);
  const engines = useRuntimeSelector((v) => v.engines);
  const money = spendText(spend, engines.find((e) => e.id === w.engine.id)?.usage_limits);
  const plan = view?.plan ?? [];
  const step = plan.findIndex((s) => s.status === "in_progress");
  return (
    <div className="flex flex-col">
      <div className="flex flex-col gap-0.5 px-3 pb-2.5 pt-3">
        <span className="flex items-center gap-2">
          <EngineMark engine={w.engine.id} className="shrink-0" />
          <span className="min-w-0 truncate font-medium text-foreground">{w.title}</span>
        </span>
        <span className="truncate pl-6 text-[12px] text-muted-foreground">
          {w.repo}
          {w.branch ? <span className="font-mono text-[11.5px]"> · {w.branch}</span> : null} · {w.computer.label}
        </span>
      </div>
      <p className={cn("border-t border-border px-3 py-2.5 leading-5", line.live ? "lucy-shimmer" : "text-foreground/90")}>{line.text}</p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-border px-3 py-2.5 text-[12px]">
        {view?.context ? (
          <Fact label="Context">
            <ContextMeter used={view.context.used} total={view.context.window} label />
          </Fact>
        ) : null}
        <Fact label="Last 15 min">
          <Pulse bins={bins} />
          <span className="tabular-nums">{calls}</span>
        </Fact>
        {money ? (
          <Fact label="Spend">
            <span className="tabular-nums text-foreground" title={money.title}>
              {money.text}
            </span>
          </Fact>
        ) : null}
        {lines.added + lines.removed > 0 ? (
          <Fact label="Lines">
            <span className="tabular-nums">
              <span className="text-diff-add-ink">+{lines.added}</span> <span className="text-diff-del-ink">−{lines.removed}</span>
            </span>
          </Fact>
        ) : null}
      </dl>
      {plan.length > 0 ? (
        <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2.5 text-[12px] text-muted-foreground">
          <span className="flex items-center gap-2">
            <PlanBar plan={plan} />
            <span className="tabular-nums">
              {plan.filter((s) => s.status === "completed").length} of {plan.length}
            </span>
          </span>
          {step >= 0 ? <span className="truncate text-foreground/80">{plan[step]!.text}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex h-4 items-center gap-1.5 text-muted-foreground">{children}</dd>
    </div>
  );
}
