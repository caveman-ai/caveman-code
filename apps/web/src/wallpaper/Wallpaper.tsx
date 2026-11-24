import { findWallpaper, WALLPAPERS } from "../state/wallpaper-catalog.ts";
import { Button } from "@caveman-app/ui/components/button";
import { loadWallpaperBlob } from "./image-cache.ts";
import { cn } from "@caveman-app/ui/lib/cn";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactNode,
} from "react";
import { effectUniforms, inkFor, readingLimit, type Rgb, type WallpaperPick } from "./look.ts";
import { findPainting, type Painting } from "./paintings.ts";
import { NO_PAINTING, createRenderer, type Frame, type Renderer } from "./shader.ts";
import { useWallpaperImage } from "./store.ts";
import { createSwarm } from "./swarm.ts";
import { glyphAtlas } from "./tiles.ts";
import { onTheWall } from "./wall.ts";

/** Frames a second for a painting that does not ask for its own: they drift, so this is plenty. */
const FPS = 15;
/** A painting holds still once nobody has touched the app for this long: an open window is not a reason to draw. */
const AWAY_MS = 120_000;
/** Where every painting's clock stands: a new chat opened later carries on from the last one's moment. */
let clock = 40;
/** A canvas with a picture's shader compiled on it (and a person's image uploaded to it). */
interface Easel {
  readonly glsl: string;
  readonly image: HTMLImageElement | null;
  readonly canvas: HTMLCanvasElement;
  readonly renderer: Renderer;
}
/**
 * Easels whose box has gone, newest last. The next box that wants the same picture takes one back, so opening a new
 * chat again compiles nothing, uploads nothing and draws in its first frame.
 */
const parked: Easel[] = [];
const KEEP = 3;
const takeParked = (glsl: string, image: HTMLImageElement | null): Easel | undefined => {
  const at = parked.findIndex((e) => e.glsl === glsl && e.image === image);
  return at < 0 ? undefined : parked.splice(at, 1)[0];
};
function park(easel: Easel): void {
  easel.canvas.remove();
  parked.push(easel);
  while (parked.length > KEEP) parked.shift()!.renderer.dispose(true);
}
function makeEasel(
  glsl: string,
  image: HTMLImageElement | null,
): Easel | { readonly error: string } {
  const canvas = document.createElement("canvas");
  canvas.className = "absolute left-0 top-0";
  const renderer = createRenderer(canvas, glsl);
  if ("error" in renderer) return renderer;
  renderer.setImage(image, image?.naturalWidth, image?.naturalHeight);
  return { glsl, image, canvas, renderer };
}

/**
 * A box with the person's wallpaper behind what is in it: a painting or their own image, through the picked effect,
 * tuned as they set it. Anything inside marked `data-wallpaper-reads` is words on the wallpaper: it wears the ink
 * that reads on this picture, and the picture is kept to 4.5:1 against that ink everywhere (shader.ts). A painting
 * that moves does so only while the window is in front, somebody is there, and nobody has asked for less motion.
 * A living one (paintings.ts `life`) also answers the pointer: its creatures turn aside from it, and a click on the
 * bare wall sends them off. With no wallpaper it is a plain box.
 */
export function Wallpaper({
  pick,
  className,
  children,
  showLoadStatus = false,
  gone = false,
}: {
  pick: WallpaperPick;
  className?: string;
  children?: ReactNode;
  showLoadStatus?: boolean;
  /** The picture fades to the plain panel (a new chat's box docking as its chat opens); words wear the panel's ink. */
  gone?: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const colours = usePageColours();
  const own = useWallpaperImage();
  const painting = findPainting(pick.source);
  const artwork = findWallpaper(pick.source);
  const source = artwork?.image ?? (pick.source === "image" ? own : null);
  const image = useImage(source);
  const imageState = useSyncExternalStore(watchImages, () =>
    source ? imageStatus(source) : "idle",
  );
  // No WebGL2 here, or a painting that does not compile: the plain panel.
  const [failed, setFailed] = useState<string | null>(null);
  const wanted = painting ? painting.glsl : image ? NO_PAINTING : null;
  const glsl = wanted === failed ? null : wanted;
  const ink = inkFor(
    pick,
    painting ? painting.light : (artwork?.light ?? pick.imageLight),
    colours.panel,
  );

  // What a frame is drawn from, as it is now: a dial moving redraws, it never rebuilds the shader.
  const live = useRef({ pick, colours, ink });
  const redraw = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    live.current = { pick, colours, ink };
    redraw.current();
  }, [pick, colours, ink]);

  // Before the box is first shown: a picture drawn here before is on the page in the same frame as the box.
  useLayoutEffect(() => {
    const box = stage.current;
    const into = holder.current;
    if (!box || !into || glsl === null) return;
    const less = matchMedia("(prefers-reduced-motion: reduce)");
    const every = 1000 / (painting?.fps ?? FPS);
    let easel: Easel | undefined;
    let raf = 0;
    let last = 0;
    let touched = performance.now();
    let t = clock;
    // A living painting's creatures: a new page of them each time, as a pond is never the same twice.
    const swarm = painting?.life ? createSwarm(painting.life, Math.random() * 2 ** 32) : null;

    const moving = () =>
      Boolean(painting?.moves) &&
      live.current.pick.motion &&
      !less.matches &&
      !document.hidden &&
      document.hasFocus() &&
      performance.now() - touched < AWAY_MS;
    const paint = () => {
      if (!easel) return;
      const { pick, colours, ink } = live.current;
      const { canvas, renderer } = easel;
      const look = effectUniforms(pick);
      // A dither, and a painting that is pixel art, is drawn one canvas pixel a pixel of its own and shown enlarged
      // unsmoothed: a fraction of the work, and the same picture. Everything else is drawn at the screen's own
      // density, up to twice.
      const pixel = Math.max(look.effect === 1 ? look.grain : 0, painting?.pixel ?? 0);
      const scale = pixel > 0 ? 1 / pixel : Math.min(devicePixelRatio, 2);
      const [w, h] = [
        Math.max(1, Math.ceil(box.clientWidth * scale)),
        Math.max(1, Math.ceil(box.clientHeight * scale)),
      ];
      if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
      Object.assign(canvas.style, {
        width: `${w / scale}px`,
        height: `${h / scale}px`,
        imageRendering: pixel > 0 ? "pixelated" : "auto",
      });
      const frame: Frame = {
        time: t,
        ...look,
        brightness: pick.brightness / 100,
        blur: pick.blur,
        dim: pick.dim / 100,
        fade: pick.fade / 100,
        panel: colours.panel,
        limit: readingLimit(ink),
        inkLight: ink === "light",
      };
      if (swarm) {
        swarm.resize(box.clientWidth, box.clientHeight);
        renderer.setTiles(swarm.tiles());
      }
      renderer.draw(frame, scale);
    };
    const frame = (ms: number) => {
      raf = 0;
      if (moving()) {
        raf = requestAnimationFrame(frame);
        if (ms - last < every - 2) return;
        // A frame after a pause picks up where it stopped, not where the wall clock is.
        const passed = Math.min(0.25, (ms - last) / 1000);
        t = (t + passed) % 3600;
        clock = t;
        swarm?.step(passed);
      }
      last = ms;
      paint();
    };
    const ask = () => {
      raf ||= requestAnimationFrame(frame);
    };
    // Somebody is here again: a painting that had stopped for nobody carries on.
    const touch = () => {
      const away = performance.now() - touched >= AWAY_MS;
      touched = performance.now();
      if (away) ask();
    };
    const show = (made: Easel | { readonly error: string }) => {
      if ("error" in made) {
        console.warn(`wallpaper: ${made.error}`);
        return setFailed(glsl);
      }
      easel = made;
      if (swarm) made.renderer.setGlyphs(glyphAtlas());
      into.append(made.canvas);
      paint();
      ask();
    };
    redraw.current = ask;
    // One kept from before goes up now. A new one is compiled after this frame, so the box itself never waits on it.
    const kept = takeParked(glsl, image);
    if (kept) show(kept);
    else raf = requestAnimationFrame(() => ((raf = 0), show(makeEasel(glsl, image))));

    const sized = new ResizeObserver(ask);
    sized.observe(box);
    const woke = ["focus", "blur", "visibilitychange"] as const;
    for (const name of woke)
      (name === "visibilitychange" ? document : window).addEventListener(name, ask);
    for (const name of ["pointermove", "keydown"] as const)
      window.addEventListener(name, touch, { passive: true });
    less.addEventListener("change", ask);
    // The pointer, to a living painting: where it is, and a click on the wall itself. One that holds still is deaf.
    const place = (e: PointerEvent) => {
      const { left, top } = box.getBoundingClientRect();
      return [e.clientX - left, e.clientY - top] as const;
    };
    const near = (e: PointerEvent) => swarm?.hover(...place(e));
    const gone = () => swarm?.hover(null);
    const click = (e: PointerEvent) => {
      if (e.button !== 0 || !moving()) return;
      if (onTheWall(e.target, box)) swarm?.poke(...place(e));
    };
    if (swarm) {
      box.addEventListener("pointermove", near, { passive: true });
      box.addEventListener("pointerleave", gone);
      box.addEventListener("pointerdown", click);
    }
    return () => {
      box.removeEventListener("pointermove", near);
      box.removeEventListener("pointerleave", gone);
      box.removeEventListener("pointerdown", click);
      cancelAnimationFrame(raf);
      redraw.current = () => undefined;
      sized.disconnect();
      for (const name of woke)
        (name === "visibilitychange" ? document : window).removeEventListener(name, ask);
      for (const name of ["pointermove", "keydown"] as const)
        window.removeEventListener(name, touch);
      less.removeEventListener("change", ask);
      if (easel) park(easel);
    };
  }, [glsl, image, painting]);

  const on = glsl !== null;
  const reads = on && !gone;
  return (
    <div
      ref={stage}
      data-ink={reads ? ink : undefined}
      style={on ? ({ "--wallpaper-box": pick.box / 100 } as CSSProperties) : undefined}
      className={cn("relative isolate", reads && "wallpaper-stage", className)}
    >
      {on ? (
        <div
          ref={holder}
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-0 -z-10 overflow-hidden transition-opacity duration-300 ease-snap motion-reduce:transition-none",
            gone && "opacity-0",
          )}
        />
      ) : null}
      {children}
      {showLoadStatus && artwork && imageState !== "ready" ? (
        <div
          role="status"
          className="absolute bottom-2 right-3 flex items-center gap-2 text-[11.5px] text-muted-foreground"
        >
          {imageState === "error" ? (
            <>
              <span>Picture couldn’t load.</span>
              <Button variant="ghost" onClick={() => source && load(source, true)}>
                Retry
              </Button>
            </>
          ) : (
            "Loading picture…"
          )}
        </div>
      ) : null}
    </div>
  );
}

const thumbs = new Map<string, string>();
let easel: HTMLCanvasElement | null = null;
/** Canvas pixels a CSS px in a living painting's still. */
const LIVING_THUMB = 0.4;
/** A painting as a small still, drawn once on one shared canvas: a tile is a picture, never a shader of its own. */
function thumbOf(painting: Painting): string {
  const kept = thumbs.get(painting.id);
  if (kept !== undefined) return kept;
  easel ??= Object.assign(document.createElement("canvas"), { width: 296, height: 148 });
  const made = createRenderer(easel, painting.glsl);
  let url = "";
  if (!("error" in made)) {
    made.setImage(null);
    // A living one from further back, so a tile this small holds a few of its creatures.
    const scale = painting.life ? LIVING_THUMB : 1;
    if (painting.life) {
      const swarm = createSwarm(painting.life);
      // With the lamp held over the middle of it, as it is seen with a pointer on the page.
      swarm.hover(easel.width / scale / 2, easel.height / scale / 2);
      swarm.resize(easel.width / scale, easel.height / scale);
      made.setGlyphs(glyphAtlas());
      made.setTiles(swarm.tiles());
    }
    made.draw(
      {
        time: 40,
        effect: 0,
        grain: 1,
        amount: 0,
        brightness: 1,
        blur: 0,
        dim: 0,
        fade: 0,
        panel: [0.07, 0.07, 0.075],
        limit: readingLimit("light"),
        inkLight: true,
      },
      scale,
    );
    url = easel.toDataURL("image/jpeg", 0.86);
    made.dispose();
  }
  thumbs.set(painting.id, url);
  return url;
}

/** A painting's still for a tile. Empty until it is drawn, a frame after the tile shows. */
export function PaintingThumb({ painting, className }: { painting: Painting; className?: string }) {
  const [url, setUrl] = useState(() => thumbs.get(painting.id) ?? null);
  const tile = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (url !== null) return;
    let active = true;
    let soon: ReturnType<typeof setTimeout> | undefined;
    const draw = () => {
      if (!active || soon !== undefined) return;
      soon = setTimeout(() => {
        if (active) setUrl(thumbOf(painting));
      }, 0);
    };
    // Compiling and reading back every still below the fold blocks the controls above it on software GL.
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            if (!active || !entries.some((entry) => entry.isIntersecting)) return;
            observer?.disconnect();
            draw();
          });
    if (observer && tile.current) observer.observe(tile.current);
    else draw();
    return () => {
      active = false;
      observer?.disconnect();
      clearTimeout(soon);
    };
  }, [painting, url]);
  return url ? (
    <img src={url} alt="" draggable={false} className={className} />
  ) : (
    <span ref={tile} className={className} />
  );
}

/** Recently decoded pictures. Gallery thumbnails never enter this cache or start a full download. */
const images = new Map<string, HTMLImageElement | null>();
const downloads = new Map<string, AbortController>();
const users = new Map<string, number>();
const errors = new Set<string>();
const waiting = new Set<() => void>();
const watchImages = (onChange: () => void) => {
  waiting.add(onChange);
  return () => void waiting.delete(onChange);
};
const imageStatus = (src: string) =>
  errors.has(src) ? "error" : images.get(src) ? "ready" : "loading";
const notifyImages = () => waiting.forEach((l) => l());
function load(src: string, retry = false): void {
  if ((downloads.has(src) && !downloads.get(src)!.signal.aborted) || (!retry && images.get(src)))
    return;
  errors.delete(src);
  images.set(src, null);
  const controller = new AbortController();
  downloads.set(src, controller);
  notifyImages();
  void (async () => {
    let objectUrl: string | undefined;
    try {
      const art = WALLPAPERS.find((art) => art.image === src);
      const image = new Image();
      image.src = art
        ? (objectUrl = URL.createObjectURL(await loadWallpaperBlob(art, controller.signal)))
        : src;
      await image.decode();
      controller.signal.throwIfAborted();
      images.delete(src);
      images.set(src, image);
      for (const key of images.keys()) {
        if (images.size <= 4) break;
        if (!users.get(key)) images.delete(key);
      }
    } catch {
      if (downloads.get(src) === controller) {
        images.delete(src);
        if (!controller.signal.aborted) errors.add(src);
      }
    } finally {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      if (downloads.get(src) === controller) downloads.delete(src);
      notifyImages();
    }
  })();
}

/** The image at `src`, once it can be drawn. */
function useImage(src: string | null): HTMLImageElement | null {
  const image = useSyncExternalStore(watchImages, () => (src ? (images.get(src) ?? null) : null));
  useEffect(() => {
    if (!src) return;
    users.set(src, (users.get(src) ?? 0) + 1);
    load(src);
    return () => {
      const count = (users.get(src) ?? 1) - 1;
      if (count > 0) users.set(src, count);
      else {
        users.delete(src);
        downloads.get(src)?.abort();
        errors.delete(src);
      }
    };
  }, [src]);
  return image;
}

/** "210 11% 4%", a deck token, as red, green and blue from 0 to 1. */
function tokenRgb(triple: string): Rgb {
  const [h = 0, s = 0, l = 0] = triple.replaceAll("%", "").trim().split(/\s+/).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

const readPanel = () =>
  getComputedStyle(document.documentElement).getPropertyValue("--background").trim();
/** The theme is worn by <html>: its class, its inline tokens (state/appearance.ts). */
function watchTheme(onChange: () => void) {
  const seen = new MutationObserver(onChange);
  seen.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "style", "data-theme"],
  });
  return () => seen.disconnect();
}

/** The page's panel colour as it is now, and again whenever the theme changes. */
function usePageColours(): { panel: Rgb } {
  const panel = useSyncExternalStore(watchTheme, readPanel);
  return useMemo(() => ({ panel: tokenRgb(panel) }), [panel]);
}
