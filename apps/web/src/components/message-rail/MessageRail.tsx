// The message rail (STYLE.md section 11, message-rail-ref.png): one hard 2px
// mark per user message down the left edge of the transcript. A mark's length
// and brightness are the message's amplitude (its length, square-root scaled,
// 4 to 28 px); the message in view is white and 4px longer. Over the rail the
// waveform blooms (transform only, ease-snap, no overshoot): every mark stretches by its
// own amplitude, and the hovered mark swells like a dock, x2.6 with neighbours
// x1.8, x1.35 and x1.1. The whole column is one hover target: the mark
// nearest the pointer's height is the hovered one, so there are no dead rows.
// A card beside the mark previews the message and the reply, with a bookmark
// (kept per session in localStorage). Click or Enter scrolls to the message.
// One tab stop; Up/Down move, B bookmarks.
import { cn } from "@caveman-app/ui/lib/cn";
import { useStableCallback } from "@caveman-app/ui/lib/use-stable-callback";
import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Icon } from "../transcript/marks.tsx";
import { Bookmark01Icon } from "@caveman-app/ui/icons/huge";

export interface RailMessage {
  readonly id: string;
  readonly text: string;
  /** The first answer after it, for the preview card. */
  readonly reply: string;
}

/** 0..1 by message length, square-root scaled: a one-word nudge and a page-long brief read far apart. */
export function amplitude(text: string): number {
  return Math.min(1, Math.sqrt(text.trim().length / 2000));
}

export const markWidth = (amp: number) => 4 + Math.round(amp * 24);
const SWELL = [2.6, 1.8, 1.35, 1.1];
/** A swollen mark stops short of the preview card (left-12 + its 6px bridge). */
const MAX_SWOLLEN = 44;

/** How far a mark grows while the pointer is on the rail: its amplitude, times the dock swell near the hovered one. */
export function swell(amp: number, distance: number): number {
  return (1 + amp * 0.5) * (distance >= 0 && distance < SWELL.length ? SWELL[distance]! : 1);
}

export function MessageRail({
  messages,
  sessionId,
  root,
  reveal,
}: {
  messages: ReadonlyArray<RailMessage>;
  sessionId: string;
  root: RefObject<HTMLElement | null>;
  /** Mounts a message a long transcript has not rendered yet (Transcript's windowed list). */
  reveal?: RefObject<((id: string) => void) | null>;
}) {
  const [bookmarks, toggleBookmark] = useBookmarks(sessionId);
  const [hover, setHover] = useState<number | null>(null);
  const [focus, setFocus] = useState<number | null>(null);
  const [card, setCard] = useState(false);
  const current = useCurrentMessage(messages, root);
  const rail = useRef<HTMLDivElement>(null);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelJump = useRef<(() => void) | null>(null);
  useEffect(() => () => cancelJump.current?.(), [sessionId]);
  const listId = useId();
  const active = hover ?? focus;

  const element = useCallback((id: string) => root.current?.querySelector<HTMLElement>(`[data-user-message="${CSS.escape(id)}"]`) ?? null, [root]);
  const jump = (i: number) => {
    cancelJump.current?.();
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const id = messages[i]!.id;
    const target = element(id);
    let smooth = Boolean(target) && !reduce;
    if (target) {
      // A mounted tail can still be across an unloaded gap. Animating through it mounts rows
      // mid-scroll and moves the destination away from the browser's original target.
      const gap = root.current?.querySelector<HTMLElement>("[data-transcript-gap]");
      const scroller = gap ? scrollParent(target) : null;
      const gapTop = gap?.getBoundingClientRect().top;
      const crossesGap = gapTop !== undefined && scroller &&
        (target.getBoundingClientRect().top < gapTop) !== (scroller.getBoundingClientRect().top < gapTop);
      if (crossesGap) smooth = false;
    } else {
      // Mount the missing target and its following rows without visiting the history in between.
      reveal?.current?.(id);
    }
    if (root.current) cancelJump.current = settleMessageJump(root.current, () => element(id), smooth);
  };

  // First show waits 80 ms (a pointer crossing the rail shouldn't flash a card); moving along it is instant.
  const enter = (i: number) => {
    if (i === hover) return;
    setHover(i);
    if (card || showTimer.current) return;
    showTimer.current = setTimeout(() => {
      showTimer.current = null;
      setCard(true);
    }, 80);
  };
  const leave = () => {
    if (showTimer.current) clearTimeout(showTimer.current);
    showTimer.current = null;
    setHover(null);
    setCard(false);
  };
  useEffect(() => () => void (showTimer.current && clearTimeout(showTimer.current)), []);

  // Rows are evenly spaced: measure the first and last once per entry, then map the pointer's height to the nearest mark.
  const rows = useRef<{ top: number; step: number } | null>(null);
  const nearest = (clientY: number) => {
    const list = rail.current?.querySelector<HTMLElement>("[role=listbox]");
    if (!rows.current && list) {
      const marks = list.querySelectorAll<HTMLElement>("[role=option]");
      const a = marks[0]!.getBoundingClientRect();
      const b = marks[marks.length - 1]!.getBoundingClientRect();
      rows.current = { top: a.top + a.height / 2, step: marks.length > 1 ? (b.top - a.top) / (marks.length - 1) : 1 };
    }
    const r = rows.current;
    return r ? Math.max(0, Math.min(messages.length - 1, Math.round((clientY - r.top) / r.step))) : 0;
  };

  if (messages.length < 2) return null;
  const shown = active !== null && (card || focus !== null) ? messages[active] : undefined;

  // The list can shrink only when this flex parent is bounded too; a long rail must not extend the conversation.
  return (
    <div
      ref={rail}
      className="relative flex max-h-full flex-col justify-center"
      onPointerLeave={() => {
        rows.current = null;
        leave();
      }}
    >
      <div
        role="listbox"
        tabIndex={0}
        aria-label="Your messages"
        aria-activedescendant={focus !== null ? `${listId}-${focus}` : undefined}
        aria-description="Up and Down move, Enter jumps to the message, B bookmarks it"
        onFocus={() => setFocus((f) => f ?? (current >= 0 ? current : messages.length - 1))}
        onBlur={() => setFocus(null)}
        onPointerMove={(e) => enter(nearest(e.clientY))}
        onClick={(e) => jump(nearest(e.clientY))}
        onKeyDown={(e) => {
          if (focus === null) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            setFocus(Math.max(0, Math.min(messages.length - 1, focus + (e.key === "ArrowDown" ? 1 : -1))));
          } else if (e.key === "Home" || e.key === "End") {
            setFocus(e.key === "Home" ? 0 : messages.length - 1);
          } else if (e.key === "Enter" || e.key === " ") {
            jump(focus);
          } else if (e.key === "b" || e.key === "B") {
            toggleBookmark(messages[focus]!.id);
          } else return;
          e.preventDefault();
        }}
        className="flex max-h-full cursor-pointer flex-col overflow-hidden rounded-md py-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        style={{ gap: messages.length > 40 ? 2 : messages.length > 20 ? 4 : 6 }}
      >
        <MessageMarks messages={messages} listId={listId} current={current} active={active} focus={focus} bookmarks={bookmarks} />
      </div>
      {shown ? (
        <RailCard
          message={shown}
          bookmarked={bookmarks.has(shown.id)}
          onBookmark={() => toggleBookmark(shown.id)}
          onOpen={() => jump(messages.indexOf(shown))}
          top={markTop(rail.current, listId, messages.indexOf(shown))}
        />
      ) : null}
    </div>
  );
}

interface MessageMarksProps {
  messages: ReadonlyArray<RailMessage>;
  listId: string;
  current: number;
  active: number | null;
  focus: number | null;
  bookmarks: ReadonlySet<string>;
}

// A reply streams into the preview card, not the waveform. Keep its marks while only replies change.
const MessageMarks = memo(function MessageMarks({ messages, listId, current, active, focus, bookmarks }: MessageMarksProps) {
  const swelling = active !== null;
  return (
    <>
      {messages.map((m, i) => {
        const amp = amplitude(m.text);
        const here = i === current;
        const marked = bookmarks.has(m.id);
        const d = active === null ? -1 : Math.abs(i - active);
        const width = markWidth(amp) + (here ? 4 : 0);
        const scale = swelling ? Math.min(MAX_SWOLLEN, width * swell(amp, d)) / width : 1;
        const lit = here || d === 0 || marked || d === 1;
        return (
          <div
            key={m.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === focus}
            aria-label={`${marked ? "Bookmarked: " : ""}${m.text.slice(0, 80)}`}
            className="flex h-[6px] w-9 items-center pl-1"
          >
            <span
              aria-hidden
              className={cn(
                "block h-[2px] origin-left transition-[transform,background-color,opacity] duration-200 ease-snap motion-reduce:transition-none",
                here || d === 0 ? "bg-foreground" : lit ? "bg-foreground/70" : "bg-muted-foreground",
              )}
              // Quiet marks fade with their amplitude: a long brief is a bright line, a nudge a faint tick.
              style={{ width, transform: `scaleX(${scale})`, opacity: lit ? 1 : 0.35 + amp * 0.5 }}
            />
            {marked ? <span aria-hidden className="ml-[3px] block size-[2px] bg-foreground/70" /> : null}
          </div>
        );
      })}
    </>
  );
}, (a, b) =>
  a.listId === b.listId && a.current === b.current && a.active === b.active && a.focus === b.focus && a.bookmarks === b.bookmarks &&
  (a.messages === b.messages || (a.messages.length === b.messages.length && a.messages.every((m, i) => m.id === b.messages[i]!.id && m.text === b.messages[i]!.text))),
);

function markTop(rail: HTMLDivElement | null, listId: string, i: number): number {
  const mark = rail?.querySelector<HTMLElement>(`#${CSS.escape(`${listId}-${i}`)}`);
  if (!rail || !mark) return 0;
  return mark.getBoundingClientRect().top - rail.getBoundingClientRect().top + 3;
}

function RailCard({
  message,
  bookmarked,
  onBookmark,
  onOpen,
  top,
}: {
  message: RailMessage;
  bookmarked: boolean;
  onBookmark: () => void;
  onOpen: () => void;
  top: number;
}) {
  return (
    // Starts flush with the rail (pl-1 is a bridge, not a gap) so the pointer can travel onto the card.
    // Sized to the chat column (.pane-chat is the "chat" inline-size container): a narrow pane never cuts it off.
    <div style={{ top: `clamp(0px, ${top}px - 44px, 100% - 104px)` }} className="absolute left-12 z-30 pl-1.5">
      <div className="w-[min(340px,calc(100cqw-4.5rem))] origin-left animate-in fade-in-0 zoom-in-[0.96] slide-in-from-left-1 rounded-xl border border-border bg-popover p-3 shadow-[var(--shadow-overlay)] duration-200 ease-snap motion-reduce:animate-none">
      <div className="flex items-start gap-2">
        <button
          type="button"
          tabIndex={-1}
          onClick={onOpen}
          className="line-clamp-2 min-w-0 flex-1 text-left text-[13px] leading-[19px] text-foreground outline-none"
        >
          {message.text}
        </button>
        <button
          type="button"
          tabIndex={-1}
          aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
          aria-pressed={bookmarked}
          onClick={onBookmark}
          className={cn(
            "-mr-1 -mt-1 grid size-7 shrink-0 place-items-center rounded-md transition-colors duration-75 hover:bg-accent",
            bookmarked ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Icon icon={Bookmark01Icon} />
        </button>
      </div>
      {message.reply ? <p className="mt-1.5 line-clamp-3 text-[13px] leading-[19px] text-muted-foreground">{message.reply}</p> : null}
      </div>
    </div>
  );
}

/** Index of the user message at the top of the reading area, updated once per frame while scrolling. */
function useCurrentMessage(messages: ReadonlyArray<RailMessage>, root: RefObject<HTMLElement | null>): number {
  const [current, setCurrent] = useState(-1);
  const indices = useMemo(() => new Map(messages.map((m, i) => [m.id, i])), [messages]);
  const refresh = useRef<(() => void) | null>(null);
  const measure = useStableCallback((el: HTMLElement, scroller: HTMLElement) => {
    const line = scroller.getBoundingClientRect().top + scroller.clientHeight * 0.35;
    // One query per frame; nested transcripts (builders) carry no user messages.
    const marks = el.querySelectorAll<HTMLElement>("[data-user-message]");
    let found = indices.size ? 0 : -1;
    for (let i = 0; i < marks.length; i++) {
      if (marks[i]!.getBoundingClientRect().top > line) break;
      const at = indices.get(marks[i]!.dataset.userMessage!);
      if (at !== undefined) found = at;
    }
    setCurrent(found);
  });
  useEffect(() => {
    const el = root.current;
    const scroller = el ? scrollParent(el) : null;
    if (!el || !scroller) return;
    let frame = 0;
    const onFrame = () => {
      frame = 0;
      measure(el, scroller);
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(onFrame);
    };
    // The next frame, when the chat just opened is laid out already: never a layout of its own.
    onScroll();
    refresh.current = onScroll;
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      refresh.current = null;
      scroller.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(frame);
    };
  }, [measure, root]);
  // A changing preview can move the transcript. Re-measure it, but keep the scroll listener
  // and any frame already queued by scrolling; both read the latest committed message index.
  useEffect(() => refresh.current?.(), [messages]);
  return current;
}

export function scrollParent(el: HTMLElement): HTMLElement | null {
  // A chat's scroller says what it is: no computed styles, which force a style pass over a chat just opened (twice,
  // with the pane's --pane-top set after).
  const viewport = el.parentElement?.closest<HTMLElement>('[data-slot="conversation-viewport"]');
  if (viewport) return viewport;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/** Keep the target after row loading and content-visibility estimates settle, respecting manual navigation. */
export function settleMessageJump(root: HTMLElement, target: () => HTMLElement | null, smooth = false): () => void {
  const scroller = scrollParent(root);
  if (!scroller) {
    target()?.scrollIntoView({ block: "start", behavior: smooth ? "smooth" : "instant" });
    return () => {};
  }
  const doc = root.ownerDocument;
  let until = 0;
  let fallback: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  let stable = 0;
  let cancelled = false;
  const cancel = () => {
    cancelled = true;
    clearTimeout(fallback);
    cancelAnimationFrame(frame);
    scroller.removeEventListener("scrollend", begin);
    scroller.removeEventListener("wheel", cancel);
    scroller.removeEventListener("touchmove", cancel);
    scroller.removeEventListener("pointerdown", cancel);
    doc.removeEventListener("keydown", cancel, true);
  };
  const align = () => {
    if (cancelled || performance.now() >= until) return cancel();
    const el = target();
    if (el) {
      const before = scroller.scrollTop;
      el.scrollIntoView({ block: "start", behavior: "instant" });
      stable = Math.abs(scroller.scrollTop - before) <= 1 ? stable + 1 : 0;
    }
    // Two unchanged layout frames; never pin a reader indefinitely or fight their next input.
    if (stable >= 2) cancel();
    else frame = requestAnimationFrame(align);
  };
  const begin = () => {
    if (cancelled) return;
    clearTimeout(fallback);
    scroller.removeEventListener("scrollend", begin);
    until = performance.now() + 500;
    frame = requestAnimationFrame(align);
  };
  scroller.addEventListener("wheel", cancel, { passive: true });
  scroller.addEventListener("touchmove", cancel, { passive: true });
  scroller.addEventListener("pointerdown", cancel, { passive: true });
  doc.addEventListener("keydown", cancel, true);
  if (smooth) {
    // Let native motion finish, then correct any layout drift. The timeout covers browsers without scrollend
    // and an already-aligned target, which emits no scroll event.
    scroller.addEventListener("scrollend", begin);
    fallback = setTimeout(begin, 1500);
    target()?.scrollIntoView({ block: "start", behavior: "smooth" });
  } else begin();
  return cancel;
}

function useBookmarks(sessionId: string): [ReadonlySet<string>, (id: string) => void] {
  const key = `caveman.rail.bookmarks.${sessionId}`;
  const [marks, setMarks] = useState<ReadonlySet<string>>(() => read(key));
  useEffect(() => setMarks(read(key)), [key]);
  const toggle = useCallback(
    (id: string) =>
      setMarks((prev) => {
        const next = new Set(prev);
        if (!next.delete(id)) next.add(id);
        try {
          if (next.size) localStorage.setItem(key, JSON.stringify([...next]));
          else localStorage.removeItem(key);
        } catch {
          // Storage full or blocked: the bookmark still holds for this visit.
        }
        return next;
      }),
    [key],
  );
  return [marks, toggle];
}

function read(key: string): ReadonlySet<string> {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}
