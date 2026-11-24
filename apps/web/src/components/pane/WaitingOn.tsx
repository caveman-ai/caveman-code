import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { useEffect, useState } from "react";
import { MARK } from "../../panels/agents/states.ts";
import { clock, newestActivity, type AtWork } from "../../state/now.ts";

/**
 * The strip on a chat's box once its turn is over and the agents it started
 * still work: how many, what the newest of them is doing (else who they are),
 * and for how long, so a quiet chat reads as waiting rather than done. It
 * opens them in the Overview's Agents card. `noun`: what it counts, agents unless said (the Chief's box: tasks).
 */
export function WaitingOn({ agents, onOpen, noun = ["agent", "agents"] }: { agents: ReadonlyArray<AtWork>; onOpen: () => void; noun?: readonly [string, string] }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const needs = agents.filter((a) => a.asking).length;
  const [one, many] = noun;
  const label = needs > 0 ? `${needs} ${needs === 1 ? `${one} needs` : `${many} need`} you` : `Waiting on ${agents.length} ${agents.length === 1 ? one : many}`;
  const titles = agents.map((a) => a.title).join(", ");
  const line = waitingLine(agents);
  // The longest at work sets the clock.
  const since = Math.min(...agents.map((a) => Date.parse(a.startedAt)).filter(Number.isFinite));
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${label}: ${titles}${line.activity ? `. ${line.activity}` : ""}. Show ${many}`}
      className="group/waiting flex h-7 min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors duration-75 animate-in fade-in-0 hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring motion-reduce:animate-none"
    >
      {/* An 8px slot, as the queue's ring and its numbers have: the words start on one line down the tray. */}
      <span aria-hidden className="grid w-2 shrink-0 place-items-center">
        <span className={cn("size-1.5", MARK[needs > 0 ? "needs" : "working"])} />
      </span>
      <span className={cn("shrink-0", needs > 0 ? "text-[hsl(var(--warning))]" : "lucy-shimmer")}>{label}</span>
      <span className="min-w-0 flex-1 truncate text-[hsl(var(--subtle-foreground))]">
        {line.who}
        {line.activity ? <span className="ml-1.5 text-muted-foreground">{line.activity}</span> : null}
      </span>
      {Number.isFinite(since) ? <span className="shrink-0 tabular-nums text-[hsl(var(--subtle-foreground))]">{clock(now - since)}</span> : null}
      <Icon icon={ArrowRight01Icon} className="size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snap group-hover/waiting:translate-x-0.5" />
    </button>
  );
}

/**
 * What the strip says after its count (upstream #25299): one agent, its name and what it is doing; several, the one
 * whose step is newest and that step; none saying what it does, every name.
 */
export function waitingLine(agents: ReadonlyArray<AtWork>): { readonly who: string; readonly activity: string | null } {
  const only = agents.length === 1 ? agents[0]! : null;
  if (only) return { who: only.title, activity: only.activity };
  const newest = newestActivity(agents);
  if (newest) return { who: `${newest.title}:`, activity: newest.activity };
  return { who: agents.map((a) => a.title).join(", "), activity: null };
}
