// The plan meter in the sidebar's account row: a ring for how much of the person's Caveman Code plan's week is used,
// and on a click the popover with the week, its reset and the way to Settings > Plan (which holds every limit, the
// credits, Pay as you go and the plans). Free has no limits: a row over the account row leads to a plan instead. It
// reads account.get, the same answer Settings > Account shows; signed out, or on a Caveman Cloud that sells no plans,
// it shows nothing.

import { publicCredits, publicOffer } from "@caveman-app/session-protocol";
import { menuItem } from "@caveman-app/ui/components/menu";
import { Popover, PopoverContent, PopoverTrigger } from "@caveman-app/ui/components/popover";
import { cn } from "@caveman-app/ui/lib/cn";
import { Icon, ArrowRight01Icon } from "@caveman-app/ui/icons/huge";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { useAccountRead } from "../state/account.ts";
import { useRuntimeClient, useRuntimeSelector, type RuntimeContextValue } from "../state/runtime.tsx";
import { ProgressRing } from "../components/ProgressRing.tsx";
import { planMeter, readKept, rowText, turnEnded, workingKey, type MeterTone, type PlanMeter as Meter, type PlanUsage, type UsageRow } from "./plan-meter-model.ts";
import { Glyph } from "@caveman-app/ui/icons/Glyph";

/** The last answer, so the meter paints with the sidebar on the next launch instead of popping in under it. */
const KEEP_KEY = "caveman.planUsage";
/** At most one read a minute while the window is visible; none while it is hidden. */
const POLL_MS = 60_000;
/** Coming back to the window reads again, unless a read just happened. */
const FOCUS_GAP_MS = 15_000;
/** After a turn ends, Cloud settles its holds before the windows show the spend. */
const SETTLE_MS = 2_000;

const selectWorking = (v: RuntimeContextValue) => workingKey(v.workspaces);
const visible = () => document.visibilityState === "visible";

function kept(): PlanUsage | null {
  try {
    return readKept(localStorage.getItem(KEEP_KEY));
  } catch {
    return null;
  }
}

function keep(usage: PlanUsage | null): void {
  try {
    if (usage?.credits) {
      // An invoice's confirm page is a link anyone holding it can open: never kept, and the meter does not need it.
      const auto = usage.credits.auto_topup;
      // Only a percent and a reset are kept about the plan: nothing an older runtime sent in dollars reaches the disk.
      const credits = { ...publicCredits(usage.credits), grants: [], ...(auto ? { auto_topup: { ...auto, confirm_url: null } } : {}) };
      localStorage.setItem(KEEP_KEY, JSON.stringify({ signed_in: true, credits, offer: usage.offer ? publicOffer(usage.offer) : null }));
    } else localStorage.removeItem(KEEP_KEY);
  } catch {
    // Storage full or off: the meter still shows, it just paints a moment later next launch.
  }
}

/**
 * account.get, kept fresh: on connect and on every sign-in or sign-out (cloud.changed), a moment after a turn
 * ends, when the window comes back, and once a minute while it is visible. A failed read keeps the last answer on
 * screen; signed out or no plans sold, it stops reading until the sign-in changes. A browser window with no computer
 * behind it reads Cloud itself (state/account.ts).
 */
function usePlanUsage(): PlanUsage | null {
  const { client, connection } = useRuntimeClient();
  const account = useAccountRead();
  const working = useRuntimeSelector(selectWorking);
  const [usage, setUsage] = useState<PlanUsage | null>(kept);
  const read = useRef({ busy: false, again: false, at: 0, watch: true, stale: false });

  // `fresh`: what is in flight may predate the change (a turn ending, a sign-in), so read once more after it.
  const load = useCallback((fresh = false) => {
    const r = read.current;
    if (!account) return;
    if (r.busy) {
      r.again ||= fresh;
      return;
    }
    r.busy = true;
    r.at = Date.now();
    r.stale = false;
    account()
      .then(
        (account) => {
          // Signed in but Cloud did not answer (account.error): keep what we last knew rather than blink out.
          if (account.signed_in && account.credits === undefined) return;
          const next: PlanUsage | null = account.signed_in && account.credits ? { signed_in: true, credits: account.credits, offer: account.offer ?? null } : null;
          r.watch = next !== null;
          keep(next);
          setUsage(next);
        },
        () => undefined,
      )
      .finally(() => {
        r.busy = false;
        if (r.again) {
          r.again = false;
          load(true);
        }
      });
  }, [account]);

  // On connect, and whenever the sign-in changes.
  useEffect(() => {
    load();
    return client?.on("cloud.changed", () => {
      read.current.watch = true;
      load(true);
    });
  }, [client, connection, load]);

  // Window focus and the minute poll, only while the window is visible.
  useEffect(() => {
    if (!account) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (visible()) timer = setTimeout(tick, ms);
    };
    // A read for any other reason (a turn ending, focus) restarts the minute.
    const tick = () => {
      const since = Date.now() - read.current.at;
      if (since < POLL_MS - 1_000) return schedule(POLL_MS - since);
      if (read.current.watch) load();
      schedule(POLL_MS);
    };
    const back = () => {
      if (!visible()) return clearTimeout(timer);
      const since = Date.now() - read.current.at;
      if (read.current.watch && (read.current.stale || since >= FOCUS_GAP_MS)) {
        load();
        schedule(POLL_MS);
      } else schedule(Math.max(1_000, POLL_MS - since));
    };
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    schedule(POLL_MS);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", back);
      document.removeEventListener("visibilitychange", back);
    };
  }, [account, load]);

  // A turn ended somewhere: read again once Cloud has settled it (or on return, if the window is hidden).
  const before = useRef(working);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    const ended = turnEnded(before.current, working);
    before.current = working;
    if (!ended || !read.current.watch) return;
    if (!visible()) {
      read.current.stale = true;
      return;
    }
    clearTimeout(settle.current);
    settle.current = setTimeout(() => load(true), SETTLE_MS);
  }, [working, load]);
  useEffect(() => () => clearTimeout(settle.current), []);

  return usage;
}

/** The meter for the sidebar, kept fresh; null when there is nothing to show. */
export function usePlanMeter(): Meter | null {
  return planMeter(usePlanUsage(), new Date());
}

const FILL: Record<MeterTone, string> = { normal: "bg-foreground/70", amber: "bg-warning", cap: "bg-destructive" };
const ARC: Record<MeterTone, string | undefined> = { normal: undefined, amber: "text-warning", cap: "text-destructive" };

/** A thin bar for one limit in the popover; the label carries the share for a screen reader. */
function Bar({ row, label, className }: { row: UsageRow; label: string; className?: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={row.percent} className={cn("h-1 overflow-hidden rounded-full bg-foreground/10", className)}>
      <div
        className={cn("h-full w-full rounded-full transition-transform duration-300 ease-snap motion-reduce:transition-none", FILL[row.tone])}
        style={{ transform: `translateX(-${100 - row.percent}%)` }}
      />
    </div>
  );
}

/** Free over the account row: its name and the way to a plan. Its credits are in Settings > Plan. */
export function GetAPlanRow({ meter }: { meter: Extract<Meter, { kind: "credits" }> }) {
  return (
    <Link
      to="/settings/plan"
      aria-label={`${meter.words}. Get a plan`}
      className="mx-3 mb-0.5 flex h-8 shrink-0 items-center gap-2 rounded-lg px-1.5 text-[12.5px] outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="text-[13px] font-medium text-sidebar-accent-foreground">{meter.plan}</span>
      <span className="ml-auto text-muted-foreground underline-offset-2 hover:text-sidebar-accent-foreground hover:underline">Get a plan</span>
    </Link>
  );
}

/**
 * The ring in the account row: the week's share used, amber from 80%, red and full at the cap. It opens the popover on
 * a click or Enter (never by itself); hovering names the share and the reset.
 */
export function PlanRing({ meter }: { meter: Extract<Meter, { kind: "windows" }> }) {
  const [open, setOpen] = useState(false);
  // At the cap the words already say when it resets.
  const hint = meter.bar.resets && meter.bar.tone !== "cap" ? `${meter.words}. ${meter.bar.resets}` : meter.words;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Plan usage: ${meter.words}`}
          title={hint}
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground outline-none transition-colors duration-75 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            open && "bg-sidebar-accent/60 text-sidebar-accent-foreground",
          )}
        >
          <ProgressRing percent={meter.bar.percent} arcClassName={ARC[meter.bar.tone]} />
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" sideOffset={6} aria-label="Plan usage" className="w-[280px] p-0">
        <PlanUsageDetails meter={meter} onLeave={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/**
 * The popover: the week (and a limit that is used up) as its percent, its reset and a bar, and the way to Settings >
 * Plan, which is where every limit, credits, Pay as you go and the other plans are. Nothing here is in dollars.
 */
export function PlanUsageDetails({ meter, onLeave }: { meter: Extract<Meter, { kind: "windows" }>; onLeave?: () => void }) {
  return (
    <>
      <div className="px-3 pb-3 pt-3">
        <div className="flex h-5 items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-foreground">{meter.plan}</span>
          <span className="text-[12px] text-muted-foreground">Plan usage</span>
        </div>
        {meter.trial ? <p className="mt-0.5 text-[12px] text-muted-foreground">{meter.trial}</p> : null}
        {meter.rows.map((row) => (
          <div key={row.window} className="mt-3">
            <div className="flex h-5 items-center justify-between gap-3 text-[13px]">
              <span className="text-foreground">{row.label}</span>
              <span className={cn("text-[12px] tabular-nums", row.tone === "cap" ? "text-destructive" : "text-muted-foreground")}>{rowText(row)}</span>
            </div>
            <Bar row={row} label={row.tone === "cap" ? `${row.label}: used up` : `${row.label}: ${row.percent}% used`} className="mt-1" />
          </div>
        ))}
        {meter.creditsCarryOn ? <p className="mt-3 text-[12px] text-muted-foreground">Turns run on credits until the plan resets.</p> : null}
      </div>
      <div className="border-t border-border p-1.5">
        <Link to="/settings/plan" onClick={onLeave} className={cn(menuItem, "hover:bg-accent focus-visible:bg-accent")}>
          Plan and credits
          <Icon icon={ArrowRight01Icon} className="ml-auto" />
        </Link>
        {meter.gifts > 0 ? (
          <Link to="/settings/plan" onClick={onLeave} className={cn(menuItem, "hover:bg-accent focus-visible:bg-accent")}>
            <Glyph name="gift" />
            Give a free month
            <span className="ml-auto tabular-nums text-muted-foreground">{meter.gifts} left</span>
          </Link>
        ) : null}
      </div>
    </>
  );
}
