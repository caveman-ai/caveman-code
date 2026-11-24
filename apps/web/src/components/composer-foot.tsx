// The foot of a chat's box (Codex's "branch ⌄  This Mac ⌄" under the composer, the context ring at its end): where
// the chat is, or where a new one starts. One set of chips for both, so a place reads the same before a chat and
// during one, and swapping it moves the same way (STYLE.md 8, "A place swapping").
import { Button } from "@caveman-app/ui/components/button";
import { duration, ease } from "@caveman-app/ui/motion";
import { ArrowDown01Icon, Icon, type IconSvgElement } from "@caveman-app/ui/icons/huge";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  forwardRef,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";

/** A chip's or a fact's box and words: 28px, the icon first, 13px regular, a step under ink until hovered, open or picked. */
const FOOT = "h-7 min-w-0 gap-1.5 px-1.5 text-[13px] font-normal text-foreground/70";

/** The chevron that says a chip opens: smaller and quieter than its words, tucked against them. */
const Chevron = forwardRef<HTMLSpanElement>(function Chevron(_, ref) {
  return (
    <span ref={ref} aria-hidden className="-ml-0.5 flex shrink-0 opacity-60">
      <Icon icon={ArrowDown01Icon} className="size-3" />
    </span>
  );
});

/**
 * A chip of the foot that opens something: the kit's ghost button, its icon, its words, a chevron. `picked` draws it
 * in ink: it holds a pick other than its default.
 */
export const FootChip = forwardRef<
  HTMLButtonElement,
  ComponentPropsWithoutRef<"button"> & { icon?: IconSvgElement; picked?: boolean }
>(function FootChip({ icon, picked, className, children, ...rest }, ref) {
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      className={cn(FOOT, "shrink", picked && "text-foreground", className)}
      {...rest}
    >
      {icon ? <Icon icon={icon} className="size-4 shrink-0" /> : null}
      {children}
      <Chevron />
    </Button>
  );
});

/** A fact of the foot that opens nothing (an open chat's repository, its branch): the chip's icon and words, no chevron, no hover. */
export function FootLabel({
  icon,
  mark,
  title,
  className,
  children,
}: {
  icon?: IconSvgElement;
  mark?: ReactNode;
  title?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span title={title} className={cn("flex items-center", FOOT, className)}>
      {mark ?? (icon ? <Icon icon={icon} className="size-4 shrink-0" /> : null)}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A place a chat runs, as the foot names it. */
export interface Place {
  /** What makes it another place: a change of it is a swap. */
  readonly id: string;
  readonly name: string;
  readonly icon: IconSvgElement;
  /** Cloud, which sits over the Macs: it comes down into the chip and leaves upward; a Mac comes up and leaves downward. */
  readonly high: boolean;
}

const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/** How far a place travels as it leaves or arrives, in px (STYLE.md 8: short travel), and which way its home is: Cloud's above, a Mac's below. */
const TRAVEL = 8;
const home = (place: Place) => `translateY(${place.high ? -TRAVEL : TRAVEL}px)`;

/**
 * Where a chat runs, in the foot: the place's icon and name, a button that opens the places it can go to, or with
 * `fixed` a fact (the chat can't go anywhere from here). `children` follow the name (a dot while Cloud sets up).
 *
 * Another place swaps in (STYLE.md 8, "A place swapping"): the one that was goes home as the new one comes from its
 * own, Cloud from above and a Mac from below, so This Mac to Cloud rolls down and the way back rolls up; the chevron
 * glides to the end of the new name. Transform, opacity and the figure's 2px blur only, so it runs on the compositor;
 * nothing overshoots, and a second swap starts over the first. Nothing plays on first paint, for a name changing in
 * place, or under reduced motion.
 */
export const PlaceChip = forwardRef<
  HTMLButtonElement,
  Omit<ComponentPropsWithoutRef<"button">, "children"> & {
    place: Place;
    picked?: boolean;
    fixed?: boolean;
    children?: ReactNode;
  }
>(function PlaceChip({ place, picked, fixed, className, children, ...rest }, ref) {
  const arriving = useRef<HTMLSpanElement>(null);
  const leaving = useRef<HTMLSpanElement>(null);
  const chevron = useRef<HTMLSpanElement>(null);
  // The place the last paint showed, and the one on its way out while a swap plays.
  const shown = useRef(place);
  const [gone, setGone] = useState<Place | null>(null);
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = place;
    if (was.id !== place.id) setGone(was);
  });
  useLayoutEffect(() => {
    const [to, from] = [arriving.current, leaving.current];
    if (!gone || !to || !from) return;
    if (typeof to.animate !== "function" || reducedMotion()) {
      setGone(null);
      return;
    }
    // One roll: both travel for the whole of it, on the long-travel curve; the old name is gone in its first half.
    const roll = { duration: duration.slow, easing: ease.drawer };
    const exit = from.animate(
      [
        { opacity: 1, filter: "blur(0px)" },
        { opacity: 0, filter: "blur(2px)", offset: 0.5 },
        { opacity: 0, filter: "blur(2px)", transform: home(gone) },
      ],
      { ...roll, fill: "forwards" },
    );
    // The new name is sharp and whole by the time it slows, and settles the last pixels in ink.
    const entrance = to.animate(
      [
        { opacity: 0, filter: "blur(2px)", transform: home(shown.current) },
        { opacity: 1, filter: "blur(0px)", offset: 0.6 },
        { opacity: 1, filter: "blur(0px)" },
      ],
      roll,
    );
    // The chevron stood at the old name's end and goes to the new one's (FLIP): a shorter name pulls it in with the
    // roll; a longer one pushes it out ahead, quickly, so it never rides over the letters arriving under it.
    const shift = from.offsetWidth - to.offsetWidth;
    const glide =
      shift === 0
        ? undefined
        : chevron.current?.animate(
            [{ transform: `translateX(${shift}px)` }, { transform: "none" }],
            shift > 0 ? roll : { duration: duration.fast, easing: ease.snap },
          );
    let live = true;
    void exit.finished.then(
      () => live && setGone(null),
      () => undefined,
    );
    return () => {
      live = false;
      for (const animation of [exit, entrance, glide]) animation?.cancel();
    };
  }, [gone]);

  const face = (p: Place) => (
    <>
      <Icon icon={p.icon} className="size-4 shrink-0" />
      <span className="truncate">{p.name}</span>
    </>
  );
  const body = (
    <span className="relative flex min-w-0 items-center">
      {gone ? (
        <span
          ref={leaving}
          aria-hidden
          className="pointer-events-none absolute inset-y-0 left-0 flex items-center gap-1.5 whitespace-nowrap"
        >
          {face(gone)}
        </span>
      ) : null}
      <span ref={arriving} className="flex min-w-0 items-center gap-1.5">
        {face(place)}
        {children}
      </span>
    </span>
  );
  if (fixed) return <span className={cn("flex items-center", FOOT, className)}>{body}</span>;
  return (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="sm"
      className={cn(FOOT, "shrink", picked && "text-foreground", className)}
      {...rest}
    >
      {body}
      <Chevron ref={chevron} />
    </Button>
  );
});
