import * as React from "react";
import { cn } from "../lib/cn";

/** How long replaced words take to lift away (stream.css `.rolling-out`). */
export const ROLL_MS = 150;

const reducedMotion = () => typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One line that says something new in place. When `id` changes, the old words lift away and fade as the new ones rise
 * in, inside the line's own height, so nothing around it moves. What leaves is a still copy of the line's last frame,
 * never a second mount of what it held. `enter`: the first words rise in too (a line appearing for a new step).
 */
export function Rolling({ id, enter = false, className, children }: { id: string; enter?: boolean; className?: string; children: React.ReactNode }) {
  const live = React.useRef<HTMLDivElement>(null);
  const ghost = React.useRef<HTMLDivElement>(null);
  const last = React.useRef<{ id: string; line: Node | null }>({ id, line: null });
  // Whether this id's words rise in: decided once per id, so a re-render mid-rise never cuts it short.
  const rise = React.useRef({ id, on: enter });
  if (rise.current.id !== id) rise.current = { id, on: true };
  React.useLayoutEffect(() => {
    const was = last.current;
    const box = ghost.current;
    if (was.id === id || !was.line || !box || reducedMotion()) return;
    box.replaceChildren(was.line);
    box.classList.remove("rolling-out");
    void box.offsetWidth;
    box.classList.add("rolling-out");
    const timer = window.setTimeout(() => box.replaceChildren(), ROLL_MS);
    return () => window.clearTimeout(timer);
  }, [id]);
  // Every commit keeps a copy of how the line looks, for the moment it is replaced: the line itself, not what it opens.
  React.useLayoutEffect(() => {
    const line = live.current?.querySelector('[data-slot="trace-line"]') ?? live.current?.firstElementChild ?? null;
    last.current = { id, line: line ? line.cloneNode(true) : null };
  });
  return (
    <div className={cn("rolling", className)}>
      <div ref={ghost} aria-hidden inert className="rolling-ghost" />
      <div key={id} ref={live} className={rise.current.on && !reducedMotion() ? "rolling-in" : undefined}>
        {children}
      </div>
    </div>
  );
}
