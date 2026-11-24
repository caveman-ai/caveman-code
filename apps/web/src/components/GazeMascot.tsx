import type { MascotPose } from "@caveman-app/ui/mascot/poses";
import { useEffect, useRef, useState } from "react";
import { MascotOnFloor } from "./EmptyState.tsx";

const CATCH_UP_MS = 70; // the eyes land a beat after the pointer, like eyes do
const LINGER_MS = 600; // the pointer left the window: it keeps looking there a moment
const NEAR = 0.6; // within this many sprite widths of its face it looks straight at you
const SLACK = 8; // degrees past a direction's edge before the eyes switch (no flicker)
const SLEEP_MS = 30_000; // no pointer, no keys: it nods off
const TYPE_MS = 900; // it works the rock until this long after your last key
const WAKE_MS = 500; // the wave (4 frames at 8 fps), then back to watching

/**
 * The new chat's companion, watching you: its eyes follow the pointer
 * anywhere in the window (pose `look`: centre plus eight directions, one
 * pixel each), it works the rock while you type, nods off when nothing
 * happens, and wakes with a wave.
 *
 * Cheap by construction: no animation loop and no React render per move. A
 * move is one angle against a cached face position, and the eyes change by
 * one CSS variable (`--px-frame`) only when the direction does. React renders
 * only when the pose changes. Reduced motion: it holds still, looking ahead.
 */
export function GazeMascot({ scale, perched = false }: { scale: 2 | 3 | 4; /** It stands on something: no floor of its own. */ perched?: boolean }) {
  const unit = useRef<HTMLDivElement>(null);
  const [pose, setPose] = useState<MascotPose>("look");

  useEffect(() => {
    const el = unit.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let shown: MascotPose = "look";
    let frame = 0; // the gaze on screen: 0 centre, then N, NE, E, SE, S, SW, W, NW
    let want = 0;
    let due = 0;
    let face: { x: number; y: number; near: number } | null = null; // null: measure on the next move
    let lastActive = performance.now();
    let gazeTimer = 0;
    let sleepTimer = 0;
    let typeTimer = 0;
    let wakeTimer = 0;

    const paint = () => (shown === "look" && frame ? el.style.setProperty("--px-frame", String(frame)) : el.style.removeProperty("--px-frame"));
    const show = (p: MascotPose) => {
      if (p === shown) return;
      shown = p;
      paint();
      setPose(p);
    };

    const settle = () => {
      gazeTimer = 0;
      if (want === frame) return;
      frame = want;
      paint();
    };
    const aim = (next: number, delay: number) => {
      want = next;
      const at = performance.now() + delay;
      if (gazeTimer && due <= at) return; // already landing sooner
      clearTimeout(gazeTimer);
      due = at;
      gazeTimer = window.setTimeout(settle, delay);
    };

    const measure = () => {
      const r = (el.querySelector(".px-strip") ?? el).getBoundingClientRect();
      face = { x: r.left + r.width / 2, y: r.top + r.height * 0.4, near: r.width * NEAR };
    };
    const direction = (dx: number, dy: number, current: number) => {
      const d = Math.hypot(dx, dy);
      if (d < face!.near * (current === 0 ? 1.25 : 1)) return 0;
      const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // 0 east, 90 south
      if (current) {
        const off = ((deg - ((current - 1) * 45 - 90) + 540) % 360) - 180;
        if (Math.abs(off) <= 22.5 + SLACK) return current;
      }
      return 1 + ((((Math.round((deg + 90) / 45)) % 8) + 8) % 8);
    };

    const nap = () => {
      const quiet = performance.now() - lastActive;
      if (quiet < SLEEP_MS) sleepTimer = window.setTimeout(nap, SLEEP_MS - quiet);
      else if (shown === "look") show("sleeping");
    };
    const wake = () => {
      show("wave");
      wakeTimer = window.setTimeout(() => {
        show("look");
        sleepTimer = window.setTimeout(nap, SLEEP_MS);
      }, WAKE_MS);
    };

    const onMove = (e: PointerEvent) => {
      lastActive = performance.now();
      if (shown === "sleeping") return wake();
      if (!face) measure();
      aim(direction(e.clientX - face!.x, e.clientY - face!.y, want), CATCH_UP_MS);
    };
    const onLeave = () => aim(0, LINGER_MS);
    const onKey = () => {
      lastActive = performance.now();
      if (shown === "sleeping") return wake();
      if (shown === "wave") return;
      show("working");
      clearTimeout(typeTimer);
      typeTimer = window.setTimeout(() => shown === "working" && show("look"), TYPE_MS);
    };
    const stale = () => {
      face = null;
    };

    const root = document.documentElement;
    const resized = new ResizeObserver(stale);
    if (el.parentElement) resized.observe(el.parentElement);
    window.addEventListener("pointermove", onMove, { passive: true });
    root.addEventListener("pointerleave", onLeave, { passive: true });
    document.addEventListener("keydown", onKey, { passive: true });
    window.addEventListener("resize", stale, { passive: true });
    document.addEventListener("scroll", stale, { passive: true, capture: true });
    sleepTimer = window.setTimeout(nap, SLEEP_MS);
    return () => {
      resized.disconnect();
      window.removeEventListener("pointermove", onMove);
      root.removeEventListener("pointerleave", onLeave);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", stale);
      document.removeEventListener("scroll", stale, { capture: true });
      for (const t of [gazeTimer, sleepTimer, typeTimer, wakeTimer]) clearTimeout(t);
      el.style.removeProperty("--px-frame");
    };
  }, []);

  return (
    <div ref={unit} data-pose={pose}>
      <MascotOnFloor pose={pose} scale={scale} floor={!perched} />
    </div>
  );
}
