// The inbox's rows, shared by the Chief's Running rail: a stack header, a
// queue row weighted by what it asks of you, and the one glyph a quiet row ends on.
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState, type ReactNode } from "react";
import { relativeTime } from "../components/Transcript.tsx";
import { EngineMark } from "../components/transcript/marks.tsx";
import { StatusMark } from "../components/StatusMark.tsx";
import type { ChatStatus, WorkspaceView } from "../state/model.ts";
import { useSession } from "../state/runtime.tsx";
import { rowLine, type InboxRow, type SpendRow, type Stack, type StackId } from "./inbox-model.ts";
import { ContextMeter, Peek } from "./inbox-vitals.tsx";
import { ChatPrMarks } from "./review/parts.tsx";
import "./inbox.css";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

const age = (since: string) => relativeTime(since).replace(" ago", "").replace("just now", "now");

/** FRESH_FOR_MS after it arrives (or until you reach for it), a new row or card wears its arrival. The page's own history never does. */
export const FRESH_FOR_MS = 4000;
export function useFresh(arrived: boolean): { fresh: boolean; seen: () => void } {
  const [fresh, setFresh] = useState(arrived);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setFresh(false), FRESH_FOR_MS);
    return () => clearTimeout(t);
  }, [fresh]);
  return { fresh, seen: () => setFresh(false) };
}

/**
 * A stack as a Linear list group: a quiet sentence-case header (glyph, label, count) over its rows, no rules
 * between groups, only space. A group that can fold says so with a caret on the left, the way a Notion toggle does.
 */
export function StackGroup({ stack, closed, onToggle, children }: { stack: Stack; closed: boolean; onToggle: (() => void) | null; children: ReactNode }) {
  const head = (
    <>
      <Glyph name={stack.icon} className="text-[hsl(var(--subtle-foreground))]" />
      <span className={stack.decision ? "text-foreground/75" : undefined}>{stack.label}</span>
      <span className="tabular-nums text-[hsl(var(--subtle-foreground))]">{stack.rows.length}</span>
    </>
  );
 // compact section label: small, medium weight, at 45% ink; a group that asks something of you lifts its name.
  const bar = "flex h-7 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] font-medium text-[hsl(var(--subtle-foreground))]";
  return (
    <div role="group" aria-label={stack.label} className="px-2 pt-2 first:pt-1">
      {onToggle ? (
        <button
          type="button"
          aria-expanded={!closed}
          onClick={onToggle}
          className={cn(bar, "group/fold outline-none transition-colors duration-100 hover:bg-foreground/[0.04] hover:text-foreground/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring")}
        >
          {head}
          <Icon
            icon={ArrowRight01Icon}
            className={cn("ml-auto size-3.5 opacity-0 transition-[transform,opacity] duration-150 group-hover/fold:opacity-100 group-focus-visible/fold:opacity-100", !closed && "rotate-90", closed && "opacity-100")}
          />
        </button>
      ) : (
        <h2 className={bar}>{head}</h2>
      )}
      {closed ? null : <div className="flex flex-col gap-px">{children}</div>}
    </div>
  );
}

/**
 * One row, weighted by what it asks of you. Every row is the same line: engine mark, title, then its age
 * and one glyph. A chat that needs you adds what it asks on a second, muted line under its title, and its
 * amber glyph is the only colour; no card, no border. The rest waits in the peek.
 */
export function QueueRow({ row, stack, open, tabStop, fresh, spend, onOpen }: { row: InboxRow; stack: StackId; open: boolean; tabStop: boolean; fresh: boolean; spend: SpendRow | undefined; onOpen: () => void }) {
  const w = row.workspace;
  // ponytail: each row attaches its session for its line and vitals (and so opens at once); a summary on workspace.list when queues run long.
  const { view } = useSession(w.state === "queued" ? null : w.sessionId);
  const [arrived] = useState(fresh);
  const asks = stack === "needs";
  const bright = open || asks || (stack === "review" && w.unread);
  return (
    <Peek workspace={w} view={view} spend={spend} quiet={open}>
      <button
        type="button"
        data-row={w.id}
        tabIndex={tabStop ? 0 : -1}
        aria-current={open ? "true" : undefined}
        onClick={onOpen}
        className={cn(
          "relative flex w-full flex-col justify-center rounded-md px-2 text-left outline-none transition-colors duration-75 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          asks ? "gap-0.5 py-1.5" : "h-8",
          open ? "bg-foreground/10" : "hover:bg-foreground/[0.05] focus-visible:bg-foreground/[0.05]",
          arrived && (asks ? "inbox-arrive" : "inbox-row-in"),
        )}
      >
        <span className="flex h-5 w-full items-center gap-2.5">
          <EngineMark engine={w.engine.id} className="shrink-0" />
          {/* Long titles fade out at the edge instead of ending in an ellipsis. */}
          <span
            className={cn(
              "min-w-0 flex-1 overflow-hidden whitespace-nowrap text-[13px] [mask-image:linear-gradient(to_right,black_calc(100%-28px),transparent)]",
              bright ? "text-foreground/90" : "text-foreground/65",
            )}
          >
            {w.title}
          </span>
          <ChatPrMarks workspace={w} projectId={w.projectId} />
          {asks ? (
            <>
              <time dateTime={row.since} className="shrink-0 text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">
                {age(row.since)}
              </time>
              {/* Its dot, the same as its sidebar row's; the ask itself is the line under the title. */}
              {row.status ? <StatusMark status={row.status} /> : null}
            </>
          ) : (
            <RowGlyph workspace={w} status={row.status} context={view?.context ?? null} />
          )}
        </span>
        {asks ? (
          <span className="line-clamp-2 w-full pl-[26px] text-[12.5px] leading-[18px] text-muted-foreground">{rowLine(w, view).text}</span>
        ) : null}
      </button>
    </Peek>
  );
}

/** The one thing a quiet row shows at its end: a working turn's context meter, else its status (model.ts chatStatus). */
export function RowGlyph({ workspace: w, status, context }: { workspace: WorkspaceView; status: ChatStatus | null; context: { used: number; window: number } | null }) {
  if (status?.id === "working" && context) return <ContextMeter used={context.used} total={context.window} cells={5} />;
  if (status && status.id !== "stopped") return <StatusMark status={status} />;
  if (w.state === "failed") return <Glyph name="state-failed" label="Failed" />;
  if (w.state === "completed") return <Glyph name="state-done" label="Done" />;
  if (w.state === "queued") return <Glyph name={w.asleep ? "state-sleeping" : "state-queued"} label={w.asleep ? "Asleep" : "Queued"} className="text-muted-foreground" />;
  if (w.state === "working" && context) return <ContextMeter used={context.used} total={context.window} cells={5} />;
  return null;
}

/** Re-render every `ms` so ages stay current between runtime changes. */
export function useTick(ms: number) {
  const [, setN] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setN((n) => n + 1), ms);
    return () => clearInterval(t);
  }, [ms]);
}
