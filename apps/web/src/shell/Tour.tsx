// The tour after the first run: six stops over the real shell, each a spotlight on one part (the rest dimmed) and a
// card with the caveman. Arrows and Enter step, Esc ends. It never runs on its own: it starts when the person asks for
// it (startTour: Show me around in the first run, Help > Show the Tour opening /tour, the shortcut sheet's link).
// docs/ "Tour".

import { Button } from "@caveman-app/ui/components/button";
import { Keycap, menuSurface } from "@caveman-app/ui/components/menu";
import { cn } from "@caveman-app/ui/lib/cn";
import { Mascot } from "@caveman-app/ui/mascot/Mascot";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Navigate } from "react-router";
import { funnelStep } from "../state/desktop.ts";
import { formatChord } from "../panels/chrome.tsx";
// Asking for the tour lives in tour-state.ts, so what asks loads without the tour.
import { END_EVENT, PENDING_KEY, START_EVENT, startTour } from "./tour-state.ts";

/** /tour (Help > Show the Tour): the Chief, with the tour over it. */
export function TourRoute() {
  useEffect(() => {
    funnelStep("tour_replayed");
    startTour();
  }, []);
  return <Navigate to="/chief" replace />;
}

/** `chord`: the shortcut for it, shown in the desktop app (a browser does not bind it). */
type Stop = { readonly anchor: string; readonly title: string; readonly text: string; readonly chord?: string };

const STOPS: ReadonlyArray<Stop> = [
  // A phone's sidebar is a drawer, shut: its parts below are not on screen, the button that opens it is (SidebarToggle.tsx).
  { anchor: "[data-tour=menu]", title: "Everything is in here", text: "Your projects and their Chiefs, your chats, Review, Plugins and Automations. Tap to open; tap a chat and it closes." },
  { anchor: "[data-tour=chief]", title: "Hand work to a Chief", text: "Give a Chief a mission, once or every day. It starts the chats that do the work, keeps them moving and tells you what needs you. + makes another." },
  { anchor: "[data-tour=new-chat]", title: "Start a chat yourself", text: "Pick the engine, the project and where it runs.", chord: "mod+n" },
  { anchor: "[data-tour=projects]", title: "Your project", text: "Chats live under their project, each in its own copy of the repo. Add another project with +." },
  { anchor: "[data-tour=places]", title: "Review, Plugins and Automations", text: "Pull requests waiting on you, the skills and tools your agents use, and work that runs on a schedule." },
  { anchor: "[data-tour=queue]", title: "What needs you first", text: "Queue lists every chat by what it needs from you: answers and reviews first, then the rest." },
  { anchor: "[data-composer]", title: "Your first task", text: "Say what to build. The agent works in its own copy of the repo, and nothing lands until you review it." },
];

const PAD = 4; // the spotlight's margin around its part
const GAP = 12; // between the spotlight and the card
const CARD_W = 300;

type Box = { top: number; left: number; width: number; height: number };

/**
 * The part on screen: not hidden (a chat kept rendered behind another page has its own copy of a bar) and not inside
 * something shut (a phone's drawer stays mounted, slid away and inert).
 */
const shown = (anchor: string) => [...document.querySelectorAll<HTMLElement>(anchor)].find((el) => el.getClientRects().length > 0 && !el.closest("[inert]")) ?? null;
const shownStops = () => STOPS.filter((s) => shown(s.anchor) !== null);

/** The tour, when it is pending; nothing otherwise. */
export function Tour() {
  const [stops, setStops] = useState<ReadonlyArray<Stop> | null>(null);
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [cardH, setCardH] = useState(0);

  // Pending: start once the shell has drawn its parts (a frame after mount, a little later on a slow first paint).
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const begin = () => {
      if (localStorage.getItem(PENDING_KEY) !== "1") return;
      clearTimeout(t);
      t = setTimeout(() => {
        const found = shownStops();
        setIndex(0);
        if (found.length > 0) setStops(found);
        else {
          localStorage.removeItem(PENDING_KEY);
          window.dispatchEvent(new Event(END_EVENT));
        }
      }, 400);
    };
    begin();
    window.addEventListener(START_EVENT, begin);
    return () => {
      clearTimeout(t);
      window.removeEventListener(START_EVENT, begin);
    };
  }, []);

  // Focus goes back where it was when the tour ends.
  const before = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (stops && !before.current) before.current = document.activeElement as HTMLElement | null;
  }, [stops]);
  const end = useCallback((finished: boolean) => {
    localStorage.removeItem(PENDING_KEY);
    setStops(null);
    before.current?.focus();
    before.current = null;
    window.dispatchEvent(new Event(END_EVENT));
    if (finished) funnelStep("tour_done");
  }, []);

  const stop = stops?.[index] ?? null;
  const last = stops !== null && index === stops.length - 1;

  // Where the part is, now and whenever the window or the part changes size.
  useLayoutEffect(() => {
    if (!stop) return;
    const el = shown(stop.anchor);
    // Its part went away since the tour began (a section that folds): on to the next.
    if (!el) return last ? end(true) : setIndex((i) => i + 1);
    el.scrollIntoView({ block: "nearest" });
    const measure = () => {
      const r = el.getBoundingClientRect();
      setBox({ top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      removeEventListener("resize", measure);
    };
  }, [stop, last, end]);

  useLayoutEffect(() => {
    if (card.current) setCardH(card.current.offsetHeight);
  }, [stop, box]);

  useEffect(() => {
    if (!stops) return;
    const key = (e: KeyboardEvent) => {
      const onButton = (e.target as Element | null)?.closest?.("button") && card.current?.contains(e.target as Node);
      if (e.key === "Escape") end(false);
      // Enter on Back or Skip is that button's; held keys step once.
      else if (e.key === "Enter" && onButton) return;
      else if ((e.key === "ArrowRight" || e.key === "Enter") && !e.repeat) last ? end(true) : setIndex((i) => i + 1);
      else if (e.key === "ArrowLeft" && !e.repeat) setIndex((i) => Math.max(0, i - 1));
      else if (e.key === "Tab") {
        // Modal: Tab moves between the card's own buttons.
        const buttons = [...(card.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
        if (buttons.length === 0) return;
        const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(at + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length]!.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener("keydown", key, true);
    return () => removeEventListener("keydown", key, true);
  }, [stops, last, end]);

  if (!stops || !stop || !box) return null;

  // The card beside a narrow part (the sidebar's), above a wide one (the composer); always inside the window.
  const beside = box.width < 420 && box.left + box.width + GAP + CARD_W < innerWidth - 8;
  const top = beside ? Math.min(Math.max(8, box.top), innerHeight - cardH - 8) : Math.max(8, box.top - GAP - cardH);
  const left = beside ? box.left + box.width + GAP : Math.min(Math.max(8, box.left + box.width / 2 - CARD_W / 2), innerWidth - CARD_W - 8);

  return (
    <div className="dashboard-scope fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="Tour">
      {/* The dim is the spotlight's own shadow: one hole, moved from part to part. */}
      <div
        aria-hidden
        className="pointer-events-none fixed rounded-[12px] shadow-[0_0_0_100vmax_hsl(0_0%_0%/0.55)] ring-1 ring-foreground/25 transition-[top,left,width,height] duration-200 ease-snap motion-reduce:transition-none"
        style={box}
      />
      <div
        ref={card}
        key={index}
        className={cn(menuSurface, "fixed flex flex-col gap-3 p-4 animate-in fade-in duration-150 ease-snap")}
        style={{ top, left, width: CARD_W }}
      >
        <div className="flex items-start gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-accent">
            <Mascot cut="bust" animate={false} />
          </span>
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold leading-5">{stop.title}</h2>
            <p className="mt-1 text-[13px] leading-5 text-muted-foreground">
              {stop.text}
              {stop.chord && window.cavemanDesktop ? <Keycap className="ml-1.5 bg-transparent align-[1px]">{formatChord(stop.chord)}</Keycap> : null}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] tabular-nums text-[hsl(var(--subtle-foreground))]">
            {index + 1} of {stops.length}
          </span>
          <button type="button" className="-my-[3px] py-[3px] text-[12px] text-muted-foreground outline-none transition-colors duration-75 hover:text-foreground focus-visible:underline" onClick={() => end(false)}>
            Skip
          </button>
          <span className="ml-auto flex gap-1.5">
            {index > 0 ? (
              <Button size="sm" variant="ghost" onClick={() => setIndex(index - 1)}>
                Back
              </Button>
            ) : null}
            <Button size="sm" autoFocus onClick={() => (last ? end(true) : setIndex(index + 1))}>
              {last ? "Start building" : "Next"}
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}
