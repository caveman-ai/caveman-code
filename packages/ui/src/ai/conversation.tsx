// Conversation: shadcn/ui's Message Scroller (2026-10 chat components, MIT)
// without its @shadcn/react primitive. The thread's scroll area follows the
// bottom while a reply streams, lets go the moment the reader scrolls up, and
// offers a round "scroll to end" button until they are back. Content growth
// is watched with a ResizeObserver, so nothing polls. Following glides: each
// frame closes a fifth of the way to the end, so a new line or a step's row
// eases the view down instead of jumping it ("janky and
// bumpy ... should be much smoother"); more than a screen lands at once.
// A message sent brings the view to it on a spring (arrive), unless the
// reader is scrolling at that moment.
// The end shows the latest turn from its start ("the most recent message is towards the top of
// the chat and there's more empty space"): room under a short last turn puts its first row where a new chat's first
// message sits, as compact and Claude do, so a sent message rises to the top and its reply fills the space below.
import { Icon, ArrowDown02Icon } from "../icons/huge";
import * as React from "react";
import { cn } from "../lib/cn";
import { arriveStep, conversationTuning as tuning, isConversationScrollKey, isConversationScrollTarget, onTune, ROOM_REACH, tailRoom, TURN_ANCHOR } from "./conversation-scroll";

type State = {
  atEnd: boolean;
  toEnd: (smooth?: boolean) => void;
  /** Stops following the bottom, as a reader scrolling up does: for a jump to something above the end. */
  letGo: () => void;
  /**
   * Holds the view still for `ms` while something the reader just opened grows under their pointer, then follows
   * again (if it was following): what they clicked stays where they clicked it while it opens.
   */
  hold: (ms?: number) => void;
  /**
   * The person just sent a message: the view goes to it and follows again, on a spring, from wherever they were
   * reading. Nothing moves if they are scrolling as it goes out: the view stays in their hands.
   */
  arrive: () => void;
};
const Ctx = React.createContext<State>({ atEnd: true, toEnd: () => {}, letGo: () => {}, hold: () => {}, arrive: () => {} });

/** The attribute a transcript puts on its latest turn's first row; and the tuning the scroll lab moves. */
export { ROOM_REACH, TURN_ANCHOR };
export { conversationTuning, DEFAULT_TUNING, tune, type ConversationTuning } from "./conversation-scroll";

/** What a parent holds to move the view from outside it (the pane's send). */
export type ConversationHandle = Pick<State, "arrive">;

/** The keys that scroll the view. */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
/** How near the end (px) a reader scrolling down has to come to be followed again. */
const SLACK = 80;
/** How long `hold()` keeps the view still by default: a disclosure's open (DISCLOSURE_MS) and a frame. */
const HOLD_MS = 220;
/** A wheel, touch or key this recent is the reader scrolling (a trackpad's momentum sends wheels until it stops). */
const SCROLLING_MS = 150;
/**
 * How long a sent message keeps the spring: the message, then the turn's working line, land after the send, and each
 * is taken up on the same motion rather than the follow's.
 */
const ARRIVE_MS = 600;

/**
 * The thread's scroll area. Pass the padding for the reading column through `contentClassName`.
 * `waiting`: something at the end waits for the reader (an approval, a question); scrolled away from it, the
 * scroll button names it, since the agent stays stopped until they answer.
 */
export function Conversation({
  className,
  contentClassName,
  waiting,
  handle,
  children,
  ...props
}: React.ComponentProps<"div"> & { contentClassName?: string; waiting?: string | undefined; handle?: React.Ref<ConversationHandle> }) {
  const viewport = React.useRef<HTMLDivElement>(null);
  const content = React.useRef<HTMLDivElement>(null);
  // The empty room under the content, and the latest turn's start it is measured from (the one row carrying TURN_ANCHOR).
  const room = React.useRef<HTMLDivElement>(null);
  const anchor = React.useRef<Element | null>(null);
  const reach = React.useRef<HTMLElement | null>(null);
  const follow = React.useRef(true);
  // Where the view last stood: its scrollTop and its distance from the end.
  const last = React.useRef({ top: 0, gap: 0 });
  // Shown before: a later show puts the view back where it stood (the first one has nothing to put back).
  const shown = React.useRef(false);
  const [atEnd, setAtEnd] = React.useState(true);
  // Until when the view stays still for something the reader opened (hold).
  const heldUntil = React.useRef(0);
  // When the reader last scrolled by hand (wheel, touch, keys).
  const scrolledAt = React.useRef(Number.NEGATIVE_INFINITY);
  // A sent message's arrival in flight: where the view is (finer than the scroller reports), its speed, the last
  // frame's time, and until when growth at the end is still part of it.
  const arrival = React.useRef<{ at: number; speed: number; last: number; until: number } | null>(null);
  // Starts the frames that follow the end (set by the layout effect that owns them).
  const keepUp = React.useRef<() => void>(() => {});

  // The round button shows whenever the view is not following the end.
  const setFollow = React.useCallback((on: boolean) => {
    if (!on) arrival.current = null;
    if (follow.current === on) return;
    follow.current = on;
    setAtEnd(on);
  }, []);

  // To the end and following again. Smooth, it travels on the arrival's spring (the frames that follow the end
  // run it): one motion for the scroll button and a sent message, whatever the distance.
  const toEnd = React.useCallback(
    (smooth = false) => {
      const el = viewport.current;
      if (!el) return;
      setFollow(true);
      if (!smooth) return void el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      arrival.current = { at: el.scrollTop, speed: 0, last: 0, until: performance.now() + ARRIVE_MS };
      keepUp.current();
    },
    [setFollow],
  );

  const letGo = React.useCallback(() => setFollow(false), [setFollow]);
  const arrive = React.useCallback(() => {
    if (performance.now() - scrolledAt.current >= SCROLLING_MS) toEnd(true);
  }, [toEnd]);
  React.useImperativeHandle(handle, () => ({ arrive }), [arrive]);
  // The reader's own scroll: it ends an arrival in flight, and a message sent during it moves nothing.
  const scrolling = () => {
    scrolledAt.current = performance.now();
    arrival.current = null;
  };
  const release = React.useRef(0);
  const hold = React.useCallback((ms = HOLD_MS) => {
    heldUntil.current = Math.max(heldUntil.current, performance.now() + ms);
    const el = viewport.current;
    if (!el) return;
    // The browser's scroll anchoring would keep a row below the opening part still (the live end) and slide what
    // was clicked up out from under the pointer; held, nothing moves the view.
    el.style.overflowAnchor = "none";
    window.clearTimeout(release.current);
    release.current = window.setTimeout(() => {
      el.style.overflowAnchor = follow.current ? "none" : "";
    }, heldUntil.current - performance.now());
  }, []);
  React.useEffect(() => () => window.clearTimeout(release.current), []);

  React.useLayoutEffect(() => {
    const el = viewport.current;
    const inner = content.current;
    if (!el || !inner) return;
    // A pin records where it left the view, so its own scroll event (which can land after the reader's next
    // wheel) reads as no move, and the wheel's move is measured from here.
    const record = () => {
      last.current = { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
    };
    // The room under the latest turn: sized so the end puts its start at the content's own top padding. It sits
    // outside the observed content, so resizing it never re-triggers the observer.
    let roomPx = 0;
    const fit = () => {
      const space = room.current;
      if (!space) return;
      const previous = anchor.current;
      let a = previous;
      if (!a?.isConnected || !a.hasAttribute(TURN_ANCHOR)) a = anchor.current = inner.querySelector(`[${TURN_ANCHOR}]`);
      // The turn can arrive after its send spring expired, or start from the queue without a send at all.
      // Start its motion when the anchor lands; following never takes the view from a reader scrolling history.
      const now = performance.now();
      if (tuning.room && previous && a && a !== previous && follow.current && now - scrolledAt.current >= SCROLLING_MS) {
        arrival.current = { at: el.scrollTop, speed: arrival.current?.speed ?? 0, last: arrival.current?.last ?? 0, until: now + ARRIVE_MS };
      }
      const next =
        a && tuning.room
          ? tailRoom(
              a.getBoundingClientRect().top - inner.getBoundingClientRect().top,
              inner.offsetHeight,
              el.clientHeight,
              (parseFloat(getComputedStyle(inner).paddingTop) || 0) + tuning.inset,
              tuning.maxRoom,
            )
          : 0;
      // The rail's column comes and goes with the rail: a new one takes the room as it is.
      let r = reach.current;
      const fresh = !r?.isConnected;
      if (fresh) r = reach.current = inner.querySelector<HTMLElement>(`[${ROOM_REACH}]`);
      if (next === roomPx) {
        if (fresh && r) r.style.bottom = `${-next}px`;
        return;
      }
      roomPx = next;
      space.style.height = `${next}px`;
      if (r) r.style.bottom = `${-next}px`;
    };
    const pin = () => {
      el.scrollTop = el.scrollHeight;
      record();
    };
    // Growth while following: the view eases to the end over a few frames. Every step is recorded as a pin is, so
    // the scroll events it causes read as no move. A hold waits it out; a reader letting go stops it.
    let frame = 0;
    let wait = 0;
    const glide = () => {
      frame = 0;
      if (!follow.current) return;
      const held = heldUntil.current - performance.now();
      if (held > 0) {
        if (!wait)
          wait = window.setTimeout(() => {
            wait = 0;
            glide();
          }, held);
        return;
      }
      const reduce = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
      const now = performance.now();
      // An arrival at rest past its time is over: growth from here is followed as any other.
      if (arrival.current && arrival.current.speed === 0 && now > arrival.current.until) arrival.current = null;
      const landing = arrival.current;
      if (landing && !reduce) {
        const end = el.scrollHeight - el.clientHeight;
        // Moved since by something else (the browser holding the view as a row above it grew): on from there.
        if (Math.abs(el.scrollTop - landing.at) > 1) landing.at = el.scrollTop;
        // From far up the chat the view starts most of a screen from the end, at rest: the rest is the travel seen.
        // Far is measured to the content's last line: the empty room under a new turn is not history to skip.
        if (end - roomPx - landing.at > el.clientHeight * tuning.arriveFar) {
          landing.at = end - el.clientHeight * tuning.arriveFrom;
          landing.speed = 0;
        }
        // A frame after a pause (the view had settled, then the turn's first row landed) counts as one frame.
        const ms = landing.last && now - landing.last < 100 ? now - landing.last : 1000 / 60;
        const next = arriveStep(landing.at, landing.speed, end, ms);
        const settled = end - next.at < 0.5 && Math.abs(next.speed) < 8;
        landing.at = settled ? end : next.at;
        landing.speed = settled ? 0 : next.speed;
        landing.last = now;
        el.scrollTop = landing.at;
        record();
        if (!settled) frame = requestAnimationFrame(glide);
        return;
      }
      // Reduced motion lands at once, below: no arrival to fly.
      arrival.current = null;
      const gap = el.scrollHeight - el.clientHeight - el.scrollTop;
      if (gap <= 0.5) return record();
      const was = el.scrollTop;
      el.scrollTop += reduce || gap > el.clientHeight ? gap : Math.max(1, gap * tuning.glide);
      record();
      // A fraction of a pixel the scroller cannot take up is the end: no frame spins on it.
      if (el.scrollTop === was) return;
      frame = requestAnimationFrame(glide);
    };
    keepUp.current = () => {
      if (!frame && !wait) frame = requestAnimationFrame(glide);
    };
    // Mounting, or shown again after being hidden (a chat switched back to: React's Activity re-runs this, and a
    // display: none scroller lost its offset). A reader who was following lands on the end; one who had scrolled up
    // lands where they were reading, still let go. Pinning them to the end left the view at the bottom unfollowed:
    // the next growth (a card opening) slid in under it. The room first: a chat opens on its latest turn. Mounting let go
    // (a chat opened again where its reader left it: its rows let go and placed the view in their own layout effects,
    // which run first), the view stays where they put it: the room only grows under the content.
    fit();
    if (follow.current) pin();
    else {
      if (shown.current) el.scrollTop = last.current.top;
      last.current = { top: el.scrollTop, gap: el.scrollHeight - el.scrollTop - el.clientHeight };
    }
    shown.current = true;
    const ro = new ResizeObserver(() => {
      fit();
      if (follow.current) keepUp.current();
    });
    ro.observe(inner);
    ro.observe(el);
    const untune = onTune(() => {
      fit();
      if (follow.current) keepUp.current();
    });
    return () => {
      untune();
      ro.disconnect();
      cancelAnimationFrame(frame);
      window.clearTimeout(wait);
      keepUp.current = () => {};
    };
  }, []);

  // Only a view that can scroll lets go: a wheel over a short thread would leave its first overflow unfollowed.
  const scrolledUp = (el: HTMLElement) => {
    if (el.scrollHeight > el.clientHeight) letGo();
  };

  const value = React.useMemo(() => ({ atEnd, toEnd, letGo, hold, arrive }), [atEnd, toEnd, letGo, hold, arrive]);
  return (
    <Ctx.Provider value={value}>
      <div data-slot="conversation" className={cn("relative flex min-h-0 flex-1 flex-col", className)} {...props}>
        <div
          ref={viewport}
          data-slot="conversation-viewport"
          // Following owns the motion; browser anchoring belongs to someone reading history.
          style={{ overflowAnchor: atEnd ? "none" : undefined }}
          role="log"
          aria-live="off"
          // A wheel or key that scrolls up lets go at once: its scroll event can land after the next growth
          // (a streaming reply, older rows mounting) already re-pinned the end, which undid the reader's scroll.
          onWheel={(e) => {
            scrolling();
            if (e.deltaY < 0 && isConversationScrollTarget(e.target, e.currentTarget, e.deltaY)) scrolledUp(e.currentTarget);
          }}
          onTouchMove={scrolling}
          onKeyDown={(e) => {
            if (!isConversationScrollKey(e.target)) return;
            if (SCROLL_KEYS.has(e.key)) scrolling();
            if (e.key === "ArrowUp" || e.key === "PageUp" || e.key === "Home") scrolledUp(e.currentTarget);
          }}
          onScroll={(e) => {
            const el = e.currentTarget;
            const top = el.scrollTop;
            const gap = el.scrollHeight - top - el.clientHeight;
            // Moving up (the scrollbar, touch, a selection drag) lets go. Content shrinking under the view clamps
            // it to the end, which is not the reader leaving. Growth the observer has not pinned yet moves nothing.
            if (top < last.current.top && gap > 1) setFollow(false);
            // Only a reader coming back down near the end is followed again. Being near the end is not enough: a
            // reader scrolling up inside the slack, or rows laying out above the view (content-visibility, which
            // scroll anchoring absorbs with the gap unchanged), would re-follow and be snapped back on every growth.
            else if (gap < SLACK && gap < last.current.gap) setFollow(true);
            last.current = { top, gap };
          }}
          // Focusable from the keyboard's area moves (F6), so its arrows and Page keys scroll it; never a Tab stop.
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
        >
          <div ref={content} data-slot="conversation-content" className={contentClassName}>
            {children}
          </div>
          <div ref={room} aria-hidden data-slot="conversation-room" />
        </div>
        <ScrollButton waiting={waiting} />
      </div>
    </Ctx.Provider>
  );
}

/** The round button that brings the reader back to the newest message; a pill naming what waits there, when something does. */
export function ScrollButton({ waiting }: { waiting?: string | undefined }) {
  const { atEnd, toEnd } = React.useContext(Ctx);
  const label = waiting ? `${waiting}: scroll to it` : "Scroll to the newest message";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-active={!atEnd}
      data-waiting={waiting ? true : undefined}
      // Faded out at the end, it is gone for the keyboard and screen readers too.
      inert={atEnd}
      aria-hidden={atEnd || undefined}
      onClick={() => toEnd(true)}
      className={cn(
        "absolute bottom-3 left-1/2 z-10 flex h-8 min-w-8 -translate-x-1/2 items-center justify-center gap-1.5 rounded-full border border-input bg-secondary text-secondary-foreground shadow-[var(--shadow-overlay)] outline-none",
        "transition-[opacity,transform,color] duration-200 ease-snap hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        "data-[active=false]:pointer-events-none data-[active=false]:translate-y-2 data-[active=false]:opacity-0 data-[active=false]:duration-100",
        waiting && "pl-3 pr-2.5 text-[12px] font-medium text-foreground",
      )}
    >
      {waiting ? (
        <>
          <span aria-hidden className="size-1.5 rounded-full bg-warning" />
          {waiting}
        </>
      ) : null}
      <Icon icon={ArrowDown02Icon} className="size-4" />
    </button>
  );
}

/** Scroll the conversation to its end (after the user sends a message, say). */
export function useConversation(): State {
  return React.useContext(Ctx);
}
