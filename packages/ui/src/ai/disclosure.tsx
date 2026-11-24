import * as React from "react";
import { cn } from "../lib/cn";
import { ease } from "../components/motion";

/** Shared by thoughts, tool output, work groups and finished turns. Matches stream.css. */
export const DISCLOSURE_MS = 200;

/**
 * Keep the closing body alive until its transition finishes. Retargeting the CSS
 * transition makes a rapid reopen continue from its current size. Closed content
 * is inert immediately; history mounts at its final size without an entrance.
 */
export function DisclosureContent({
  open,
  immediate = false,
  innerClassName,
  className,
  children,
  onTransitionEnd,
  ...props
}: React.ComponentProps<"div"> & { open: boolean; immediate?: boolean; innerClassName?: string }) {
  const [present, setPresent] = React.useState(open);
  if (open && !present) setPresent(true);
  React.useEffect(() => {
    if (open || !present) return;
    if (immediate || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setPresent(false);
      return;
    }
    // transitionend may never fire in a background tab or after display:none.
    const timer = window.setTimeout(() => setPresent(false), DISCLOSURE_MS);
    return () => window.clearTimeout(timer);
  }, [open, present, immediate]);
  return (
    <div
      {...props}
      className={cn("stream-disclosure", className)}
      data-open={open}
      data-immediate={immediate || undefined}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      onTransitionEnd={(event) => {
        onTransitionEnd?.(event);
        if (!open && event.target === event.currentTarget && event.propertyName === "grid-template-rows") setPresent(false);
      }}
    >
      <div className={cn("stream-disclosure-inner", innerClassName)}>{open || (present && !immediate) ? children : null}</div>
    </div>
  );
}

/**
 * A long message/code preview keeps its first lines visible while its size changes. At rest its size is CSS's own
 * (the limit while collapsed, the content's otherwise), so mounting one measures nothing: a chat's history mounts
 * rows by the dozen, most of them out of view, and a height read in each forced a layout of the whole chat per
 * preview. Only a deliberate toggle reads sizes, to animate between them.
 */
export function PreviewContent({ collapsed, collapsedRem, onCollapsed, className, children, ...props }: Omit<React.ComponentProps<"div">, "ref"> & { collapsed: boolean; collapsedRem: number; onCollapsed?: () => void }) {
  const box = React.useRef<HTMLDivElement>(null);
  const animation = React.useRef<Animation | null>(null);
  // What the box last showed: null before its first effect. An effect that runs again on the same state (a chat
  // shown again re-runs every layout effect in it) only restates the rest size.
  const shown = React.useRef<boolean | null>(null);
  const latest = React.useRef({ collapsed, onCollapsed });
  latest.current = { collapsed, onCollapsed };
  React.useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const rest = () => {
      el.style.maxHeight = collapsed ? `${collapsedRem}rem` : "";
    };
    const was = shown.current;
    shown.current = collapsed;
    if (was === null || was === collapsed) {
      rest();
      if (was === null && collapsed) latest.current.onCollapsed?.();
      return;
    }
    // Read the current interpolated height before cancelling a reversed transition.
    const from = el.getBoundingClientRect().height;
    animation.current?.cancel();
    animation.current = null;
    rest();
    const to = el.getBoundingClientRect().height;
    const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const keyboard = document.activeElement?.matches(":focus-visible");
    if (reduce || keyboard || Math.abs(from - to) <= 0.5) {
      if (collapsed) latest.current.onCollapsed?.();
      return;
    }
    // The limit is lifted while the height moves, so a collapse starts from the whole height, not the limit.
    const move = el.animate(
      [
        { height: `${from}px`, maxHeight: "none" },
        { height: `${to}px`, maxHeight: "none" },
      ],
      { duration: DISCLOSURE_MS, easing: ease.disclosure },
    );
    animation.current = move;
    move.onfinish = () => {
      if (animation.current !== move) return;
      animation.current = null;
      if (collapsed) latest.current.onCollapsed?.();
    };
  }, [collapsed, collapsedRem]);
  React.useEffect(() => {
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const motionChanged = () => {
      if (!media?.matches || !animation.current) return;
      animation.current.cancel();
      animation.current = null;
      if (latest.current.collapsed) latest.current.onCollapsed?.();
    };
    media?.addEventListener("change", motionChanged);
    return () => {
      media?.removeEventListener("change", motionChanged);
      animation.current?.cancel();
    };
  }, []);
  return <div {...props} ref={box} data-collapsed={collapsed || undefined} className={cn("stream-preview", className)}><div className="flow-root">{children}</div></div>;
}
