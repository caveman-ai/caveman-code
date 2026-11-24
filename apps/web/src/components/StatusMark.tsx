import type { PixelIconName } from "@caveman-app/ui/icons/names";
import { PixelAppear, PixelIcon, StateMark, type STATE_STRIPS } from "@caveman-app/ui/icons/PixelIcon";
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useState } from "react";
import { short } from "../lib/short.ts";
import type { ChatStatus, ChatStatusId } from "../state/model.ts";

/** Whatever a chat waits on you for (approve, answer, a key, build), its row shows one dot; the tooltip says which. */
const ICON: Record<ChatStatusId, PixelIconName | null> = {
  approve: "state-needs-you",
  secret: "state-needs-you",
  answer: "state-needs-you",
  ready: "state-needs-you",
  failed: "state-failed",
  working: "state-working",
  agents: "state-agents",
  queued: "state-queued",
  done: "state-finished",
  stopped: "state-stopped",
  // On its way up: the ring turns, as for any wait that ends by itself.
  waking: "state-working",
  asleep: "state-sleeping",
};

type Strip = keyof typeof STATE_STRIPS;
/** The ring (glyphs.ts): these turn while they last... */
const LOOP: Partial<Record<ChatStatusId, Strip>> = { working: "state-working", agents: "state-agents", waking: "state-working" };
/**
 * ...with a comet for each agent at work once there are two or more (four at most, the ring's room), whether the
 * lead is still on its own turn or waiting on them; one agent keeps the lead's own ring.
 */
const agentsRing = (agents: number): Strip | undefined => (agents >= 4 ? "state-agents-4" : agents === 3 ? "state-agents-3" : agents === 2 ? "state-agents" : undefined);
/** ...and these play once as they land, only when the status changes in view, never on a row's first paint. */
const LANDING: Partial<Record<ChatStatusId, Strip>> = { stopped: "state-stopped", done: "state-finished" };

/**
 * A chat's status where its row ends (model.ts chatStatus): one glyph. What waits on the person is an amber dot,
 * whatever it asks (the ask is its tooltip and accessible name); it dithers in when it arrives while the row is on
 * screen. A finished turn is the same dot in green. A working turn adds its todos ("3/5") or its clock once it has run
 * a minute; a lead waiting on its agents, how many. `compact`: the glyph alone (a closed folder's roll-up). `animate`
 * defaults on: the ring moves (a CSS step strip, no script; reduced motion holds it still): a working turn's spinner, a
 * comet for each of its agents at work once there are two or more, and a stop or a finish landing while the row is on
 * screen. The clock, count or todos sit before the ring on the row's own line, so the ring always ends the row on one
 * edge and on the title's centre, whatever text comes and goes beside it. `small`: 11px text and a 12px ring, for a
 * secondary line (a queue card's project line). Null when the status has no mark.
 */
export function StatusMark({ status, compact = false, animate = true, small = false, className }: { status: ChatStatus; compact?: boolean; animate?: boolean; small?: boolean; className?: string }) {
  // Has the status changed while this row was on screen? Then a stop, a finish or the dot lands; on first paint it rests.
  const [seen, setSeen] = useState(status.id);
  const [changed, setChanged] = useState(false);
  // The dot lands when an ask arrives, not when a question turns into an approval (the same dot either way).
  const [arrived, setArrived] = useState(false);
  if (seen !== status.id) {
    setSeen(status.id);
    setChanged(true);
    setArrived(ICON[seen] !== ICON[status.id]);
  }
  const icon = ICON[status.id];
  if (!icon) return null;
  const looping = status.id === "working" || status.id === "agents" ? (agentsRing(status.agents) ?? LOOP[status.id]) : status.id === "waking" ? LOOP.waking : undefined;
  const strip = animate ? (looping ?? (changed ? LANDING[status.id] : undefined)) : undefined;
  const label = status.detail ? `${status.label}: ${status.detail}` : status.label;
  const meta = compact ? null : status.id === "working" ? (
    status.progress ? (
      <span className="text-muted-foreground">
        {status.progress.done}/{status.progress.total}
      </span>
    ) : status.since ? (
      <Clock since={status.since} />
    ) : null
  ) : status.id === "agents" ? (
    <span className="text-muted-foreground">{status.agents}</span>
  ) : null;
  const ring = strip ? (
    <StateMark key={strip} name={strip} animate />
  ) : status.action ? (
    animate && arrived ? <PixelAppear name={icon} className="text-warning" /> : <PixelIcon name={icon} className="text-warning" />
  ) : (
    <PixelIcon name={icon} />
  );
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex shrink-0 items-center font-normal leading-4 tabular-nums",
        small ? "gap-1 text-[11px]" : "gap-1.5 text-[12px]",
        className,
      )}
    >
      {meta}
      {/* The pixel ring draws at 16px; scaled to 12 with its box pulled in to match, as the sidebar's other small marks. */}
      {small ? <span className="-m-0.5 inline-flex scale-75">{ring}</span> : ring}
    </span>
  );
}

/** How long a turn has run, in whole minutes and up ("4m", "2h"): nothing for its first minute, so a quick turn never ticks. */
function Clock({ since }: { since: string }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const ran = now - Date.parse(since);
  return ran >= 60_000 ? <span className="text-muted-foreground">{short(ran)}</span> : null;
}
