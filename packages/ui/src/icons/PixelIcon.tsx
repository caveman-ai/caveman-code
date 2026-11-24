import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { cn } from "../lib/cn";
import { Mascot } from "../mascot/Mascot";
import { DONE_CHECK, DONE_CHECK_WIDTH, DONE_DISC, PLAIN_CHECK, PLAIN_CHECK_WIDTH } from "./check";
import { appearFrames, DIM, FAINT, FOLDER, GLYPHS, glyphPaths, INK, PIXEL_PALETTE, SHADE, STATE_STRIPS, type GlyphPath } from "./glyphs";
import type { PixelIconName, PixelIconProps } from "./names";
import { armPops } from "./pop";
import { SPARK, toyFor, type Flipbook } from "./toys";

export { STATE_STRIPS };

type Drawn = Exclude<PixelIconName, "engine-caveman">;

function memo<K, V>(make: (key: K) => V) {
  const cache = new Map<K, V>();
  return (key: K) => {
    let value = cache.get(key);
    if (value === undefined) cache.set(key, (value = make(key)));
    return value;
  };
}

const iconPaths = memo((name: Drawn) => glyphPaths(GLYPHS[name]));
const iconAppear = memo((name: Drawn) => appearFrames(GLYPHS[name]));
// Frames side by side as one wide grid: one path (and one React key) per colour. Keyed by the frames array,
// which is a module constant or one of the memos above.
const stripPaths = memo((frames: string[][]) => glyphPaths(frames[0]!.map((_, y) => frames.map((grid) => grid[y]).join(""))));

/**
 * Ink follows the text tier (currentColor); every other colour is an accent
 * that a parent may flatten to ink through `--px-accent` (nav rows at rest).
 */
function fillStyle(char: string): CSSProperties | undefined {
  if (char === INK) return undefined;
  if (char === SHADE) return { fillOpacity: 0.4 };
  if (char === DIM) return { fillOpacity: 0.7 };
  if (char === FAINT) return { fillOpacity: 0.16 };
  if (char === SPARK) return { fill: "var(--px-accent, hsl(var(--px-shine)))" };
  return { fill: `var(--px-accent, hsl(var(${PIXEL_PALETTE[char]})))` };
}

function Paths({ paths }: { paths: GlyphPath[] }) {
  return paths.map((p) => <path key={p.char} d={p.d} fill="currentColor" style={fillStyle(p.char)} />);
}

function a11y(label: string | undefined) {
  return label ? { role: "img", "aria-label": label } : { "aria-hidden": true as const };
}

/**
 * A pixel icon from names.ts at 16, 32 or 48 px. Inside a `.px-play-hover`
 * parent it is a toy (toys.ts, pixel.css "Toys"): hover wakes it up, a press
 * sets it off, each a flipbook drawn on its own grid. Elsewhere (a transcript
 * line, a card) it is only its drawing.
 */
export function PixelIcon({ name, scale = 1, label, className, play }: PixelIconProps) {
  // The Caveman engine is the mascot's bust itself (lane ui-mascot), still; it sinks a pixel while pressed.
  if (name === "engine-caveman") {
    return <Mascot cut="bust" scale={scale} animate={false} {...(label ? { label } : {})} className={cn("px-rise shrink-0", className)} />;
  }
  if (name === "state-done" || name === "state-connected") return <Check name={name} scale={scale} label={label} className={className} />;
  return <DrawnIcon name={name} scale={scale} label={label} className={className} play={play} />;
}

/**
 * The two checks, drawn as real icons on the same 16 box (check.ts): done is the success disc with a white check, which
 * `--px-accent` flattens to ink where a row rests as the pixel glyphs do; connected is the bare check in ink. `land`
 * plays its arrival once (pixel.css "Checks"): the disc grows in, then the check draws.
 */
function Check({ name, scale = 1, label, className, land = false }: { name: "state-done" | "state-connected"; scale?: number; label?: string | undefined; className?: string | undefined; land?: boolean }) {
  const size = 16 * scale;
  const line = { fill: "none", strokeLinecap: "round", strokeLinejoin: "round" } as const;
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} className={cn("shrink-0", land && "px-check-land", className)} {...a11y(label)}>
      {name === "state-done" ? (
        <>
          <circle cx={DONE_DISC.cx} cy={DONE_DISC.cy} r={DONE_DISC.r} style={{ fill: "var(--px-accent, hsl(var(--success)))" }} />
          <path className="px-check-path" d={DONE_CHECK} stroke="#fff" strokeWidth={DONE_CHECK_WIDTH} pathLength={1} {...line} />
        </>
      ) : (
        <path className="px-check-path" d={PLAIN_CHECK} stroke="currentColor" strokeWidth={PLAIN_CHECK_WIDTH} pathLength={1} {...line} />
      )}
    </svg>
  );
}

function DrawnIcon({ name, scale = 1, label, className, play }: PixelIconProps & { name: Drawn }) {
  const ref = useRef<SVGSVGElement>(null);
  // The flipbooks are drawn only where something can play them, so a long transcript carries none.
  const [hosted, setHosted] = useState(false);
  useLayoutEffect(() => {
    if (play === undefined && ref.current?.closest(".px-play-hover")) setHosted(true);
  }, [play]);
  useEffect(armPops, []);
  const toy = (play ?? hosted) ? toyFor(name) : null;
  const size = 16 * scale;
  const style = toy ? ({ "--px-hover": `${toy.hover.ms}ms`, "--px-pop": `${toy.pop.ms}ms` } as CSSProperties) : undefined;
  return (
    <svg ref={ref} viewBox="0 0 16 16" width={size} height={size} overflow="visible" shapeRendering="crispEdges" className={cn("px-art shrink-0", className)} style={style} {...a11y(label)}>
      <g className="px-rest">
        <Paths paths={iconPaths(name)} />
      </g>
      {toy ? <Book className="px-hover" book={toy.hover} /> : null}
      {toy ? <Book className="px-pop" book={toy.pop} /> : null}
    </svg>
  );
}

function Book({ className, book }: { className: string; book: Flipbook }) {
  return (
    <g className={className}>
      {book.frames.map((f, i) => (
        <g key={i} className="px-f" style={{ "--t": `${f.t}ms`, "--d": `${f.ms}ms` } as CSSProperties}>
          <Paths paths={f.paths} />
        </g>
      ))}
    </g>
  );
}

/**
 * Frames side by side for a `.px-strip` window (pixel.css): the strip shows
 * frame 0 at rest and plays once inside a `.px-play-hover` parent. `play`
 * "loop" loops on the document's clock, so every loop on screen (the queue's
 * working rings) shows the same frame however far apart they mounted or whatever hid one for a while; "once"
 * plays from mount and rests on the last frame.
 */
export function PixelStrip({
  frames,
  fps,
  scale = 1,
  play,
  className,
}: {
  frames: string[][];
  fps: number;
  scale?: 1 | 2 | 3;
  play?: "loop" | "once";
  className?: string | undefined;
}) {
  const style = {
    "--px-w": 16,
    "--px-h": 16,
    "--px-frames": frames.length,
    "--px-fps": fps,
    "--px-scale": scale,
    ...(play === "once" ? { "--px-frame": frames.length - 1 } : {}),
  } as CSSProperties;
  const track = useRef<SVGSVGElement>(null);
  useLayoutEffect(() => {
    if (play === "loop" && track.current) toDocumentClock(track.current);
  }, [play, frames.length, fps]);
  return (
    <span className={cn("px-strip", className)} style={style} data-play={play} aria-hidden>
      <svg
        ref={track}
        viewBox={`0 0 ${16 * frames.length} 16`}
        shapeRendering="crispEdges"
        className="px-strip-track px-art"
        // Hiding a box ends its CSS animations and showing it starts them over from that moment (a folder shut and
        // opened, a sidebar folded, a pane put away and back), with nothing React sees: the restart puts it back on the clock.
        onAnimationStart={play === "loop" ? (e) => e.target === e.currentTarget && toDocumentClock(e.currentTarget) : undefined}
      >
        <Paths paths={stripPaths(frames)} />
      </svg>
    </span>
  );
}

/** A loop started at the document's time zero, so it shows the frame every other loop on screen shows. */
function toDocumentClock(track: Element) {
  for (const loop of track.getAnimations?.() ?? []) loop.startTime = 0;
}

/** An agent state on a transcript line (glyphs.ts STATE_STRIPS): its strip while `animate`, else its still glyph. */
export function StateMark({ name, animate }: { name: keyof typeof STATE_STRIPS; animate: boolean }) {
  const s = STATE_STRIPS[name];
  // The ring's comets turn in full ink, not their row's grey, so a head reads against its faint ring.
  const ink = animate && (name === "state-working" || name.startsWith("state-agents")) ? "text-foreground" : undefined;
  // A finish or a connection lands as the vector check it rests as, not the pixel strip that ended on the old drawing.
  if (name === "state-done" || name === "state-connected") return <Check name={name} land={animate} />;
  return animate ? <PixelStrip frames={s.frames} fps={s.fps} play={s.play} className={ink} /> : <PixelIcon name={name} />;
}

/**
 * An icon arriving where another stood (a chat's status changed under its
 * row): it dithers in over four held frames (glyphs.ts appearFrames) and rests
 * as the icon. Reduced motion shows the icon at once.
 */
export function PixelAppear({ name, className }: { name: PixelIconName; className?: string }) {
  if (name === "engine-caveman") return <PixelIcon name={name} {...(className ? { className } : {})} />;
  if (name === "state-done" || name === "state-connected") return <Check name={name} land className={className} />;
  return <PixelStrip frames={iconAppear(name)} fps={16} play="once" className={className} />;
}

/**
 * The sidebar's project folder: shut, its front lifted while the `.group`
 * row is hovered, open while `open` (pixel.css `.px-folder`).
 */
export function PixelFolder({ open, className }: { open: boolean; className?: string }) {
  return (
    <span className={cn("px-folder", className)} data-open={open || undefined}>
      <PixelStrip frames={FOLDER} fps={18} />
    </span>
  );
}
