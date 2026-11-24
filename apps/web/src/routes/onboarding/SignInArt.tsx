// The sign-in page's picture: the app itself (a new chat), a window cut off by the panel's right and bottom edges, in front of the
// Caveman site's dusk (caveman-site-launch public/hero/cave-dusk.png: the volcano, the clouds, the monolith). Embers
// rise behind the window into the sky and the dusk leans a little away from the pointer. Reduced motion: the still
// picture. docs/ "1. Sign in".

import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef } from "react";
import appDark from "./art/app-dark.webp";
import appLight from "./art/app-light.webp";
import cave from "./art/cave-dusk.webp";

const RATIO = 2184 / 1224; // the picture's width over its height
const LEAN = 10; // px the dusk moves at most against the pointer
// The screenshots are a new chat on a fresh install with three projects (the caveman over "What should we build"),
// 960px wide at 2x, its top 600px.
const SHOT = { w: 960, h: 600 };
const WIDTH = 760; // the window, in CSS px; the panel shows its left part, the caveman inside it

export function SignInArt({ className }: { className?: string }) {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = panel.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // One CSS variable pair per move, no render: the scene's transform reads them.
    const move = (e: PointerEvent) => {
      el.style.setProperty("--lean-x", `${(0.5 - e.clientX / innerWidth) * 2 * LEAN}px`);
      el.style.setProperty("--lean-y", `${(0.5 - e.clientY / innerHeight) * LEAN}px`);
    };
    addEventListener("pointermove", move, { passive: true });
    return () => removeEventListener("pointermove", move);
  }, []);

  return (
    <div ref={panel} aria-hidden className={cn("relative overflow-hidden rounded-2xl bg-[#2a2140] [container-type:size]", className)}>
      {/* The dusk, a little larger than the panel and raised, so the volcano and its clouds sit above the window. */}
      <div
        className="absolute left-0 top-[-24cqh] transition-transform duration-700 ease-out motion-reduce:transition-none"
        style={{
          width: `max(100cqw, ${RATIO * 130}cqh)`,
          height: `max(130cqh, ${100 / RATIO}cqw)`,
          transform: "translate3d(var(--lean-x, 0px), var(--lean-y, 0px), 0) scale(1.04)",
          transformOrigin: "30% 40%",
        }}
      >
        <img src={cave} alt="" draggable={false} className="absolute inset-0 size-full select-none object-cover [image-rendering:pixelated]" />
      </div>
      <Embers />
      <div
        className="absolute bottom-[-112px] left-10 overflow-hidden rounded-xl bg-[#f5f5f5] shadow-[0_0_0_1px_rgb(255_255_255/0.4),0_30px_80px_-16px_rgb(20_8_30/0.7)] dark:bg-[#09090a] dark:shadow-[0_0_0_1px_rgb(255_255_255/0.14),0_30px_80px_-16px_rgb(10_4_20/0.8)]"
        style={{ width: WIDTH }}
      >
        {/* The title band the desktop window has above the sidebar, with its three lights. */}
        <div className="flex h-7 items-center gap-2 px-3.5">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <img src={appLight} alt="" width={SHOT.w} height={SHOT.h} draggable={false} className="block h-auto w-full dark:hidden" />
        <img src={appDark} alt="" width={SHOT.w} height={SHOT.h} draggable={false} className="hidden h-auto w-full dark:block" />
      </div>
    </div>
  );
}

type Ember = { x: number; y: number; vy: number; sway: number; phase: number; life: number; age: number; size: number; hue: string };
const HUES = ["#fff0c2", "#ffd38a", "#ffb054", "#ff8a2a"];
const COUNT = 64;
const FPS = 30;

/** Pixel embers on a canvas over the dusk, behind the window: they climb into the sky, sway and fade. Nothing under reduced motion. */
function Embers() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    let w = 0;
    let h = 0;
    const size = () => {
      const dpr = window.devicePixelRatio || 1;
      w = canvas.clientWidth;
      h = canvas.clientHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.globalCompositeOperation = "lighter";
    };
    const born = (scatter: boolean): Ember => {
      const life = 3 + Math.random() * 5;
      return {
        x: Math.random() * w,
        y: h * (0.45 + Math.random() * 0.6),
        vy: 16 + Math.random() * 30,
        sway: 6 + Math.random() * 16,
        phase: Math.random() * Math.PI * 2,
        life,
        age: scatter ? Math.random() * life : 0,
        size: Math.random() < 0.3 ? 4 : 3,
        hue: HUES[Math.floor(Math.random() * HUES.length)]!,
      };
    };
    size();
    const embers = Array.from({ length: COUNT }, () => born(true));
    const resized = new ResizeObserver(size);
    resized.observe(canvas);

    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = (now - last) / 1000;
      if (dt < 1 / FPS) return;
      last = now;
      ctx.clearRect(0, 0, w, h);
      for (let i = 0; i < embers.length; i++) {
        const e = embers[i]!.age + dt > embers[i]!.life ? born(false) : embers[i]!;
        if (e !== embers[i]) embers[i] = e;
        else e.age += dt;
        const t = e.age / e.life;
        // Whole pixels, like the picture: no subpixel blur.
        const x = Math.round(e.x + Math.sin(e.phase + e.age * 1.3) * e.sway);
        const y = Math.round(e.y - e.vy * e.age);
        const a = Math.min(1, t * 4) * (1 - t * t);
        ctx.fillStyle = e.hue;
        // A soft square halo, then the whole-pixel core: light added to the picture, never darkening it.
        ctx.globalAlpha = a * 0.22;
        ctx.fillRect(x - e.size, y - e.size, e.size * 3, e.size * 3);
        ctx.globalAlpha = a;
        ctx.fillRect(x, y, e.size, e.size);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      resized.disconnect();
    };
  }, []);

  return <canvas ref={ref} className="pointer-events-none absolute inset-0 size-full" />;
}
