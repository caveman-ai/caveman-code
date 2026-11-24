// The read mark: an 8-bit box whose green check draws itself in held frames when ticked live (fill, the short leg,
// the long leg, four sparks out of the corners), and rests on its last frame. A mark that was already there when
// the page loaded shows still; reduced motion skips straight to the end. One SVG of whole-pixel rects.
import { cn } from "@caveman-app/ui/lib/cn";
import { useEffect, useRef, useState } from "react";

type Px = readonly [number, number];

/** The box's outline: 12 grid pixels a side with the corners stepped off. */
const OUTLINE: Px[] = [];
for (let i = 3; i <= 12; i++) OUTLINE.push([i, 2], [i, 13], [2, i], [13, i]);
const FILL: Px[] = [];
for (let y = 3; y <= 12; y++) for (let x = 3; x <= 12; x++) FILL.push([x, y]);

/** The check, two pixels thick, in the order it draws. */
const STROKES: Px[][] = [
  [[4, 7], [4, 8]],
  [[5, 8], [5, 9], [6, 9], [6, 10]],
  [[7, 8], [7, 9], [8, 7], [8, 8]],
  [[9, 6], [9, 7], [10, 5], [10, 6], [11, 4], [11, 5]],
];
const CHECK = STROKES.flat();
const SPARKS_NEAR: Px[] = [[1, 1], [14, 1], [1, 14], [14, 14]];
const SPARKS_FAR: Px[] = [[0, 0], [15, 0], [0, 15], [15, 15]];

/** Frame 1 fills and hops, 2-5 draw the check, 5 and 6 throw the sparks, 7 rests. */
const LAST = 7;
const FRAME_MS = 50;

export function PixelCheck({ checked, scale = 2, className }: { checked: boolean; scale?: 1 | 2; className?: string }) {
  const [frame, setFrame] = useState(checked ? LAST : 0);
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (!checked) return setFrame(0);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setFrame(LAST);
    let f = 1;
    setFrame(f);
    const timer = setInterval(() => {
      f += 1;
      setFrame(f);
      if (f >= LAST) clearInterval(timer);
    }, FRAME_MS);
    return () => clearInterval(timer);
  }, [checked]);

  const on = frame > 0;
  const hop = frame === 1 || frame === 2 ? -1 : 0;
  const drawn = frame === 0 ? [] : STROKES.slice(0, Math.max(0, Math.min(STROKES.length, frame - 1))).flat();
  const sparks = frame === 5 ? SPARKS_NEAR : frame === 6 ? SPARKS_FAR : [];
  const size = 16 * scale;
  const rects = (px: Px[], dy = 0) => px.map(([x, y]) => <rect key={`${x},${y}`} x={x} y={y + dy} width={1} height={1} />);

  return (
    <svg width={size} height={size} viewBox="0 0 16 16" shapeRendering="crispEdges" aria-hidden className={cn("px-art shrink-0", className)}>
      {on ? (
        <>
          <g fill="hsl(var(--success))">{rects([...OUTLINE, ...FILL], hop)}</g>
          <g fill="hsl(var(--background))">{rects(drawn, hop)}</g>
          <g fill="hsl(var(--success))">{rects(sparks)}</g>
        </>
      ) : (
        <>
          <g fill="currentColor">{rects(OUTLINE)}</g>
          {/* A ghost of the check on hover says what a click does. */}
          <g fill="currentColor" className="opacity-0 transition-opacity duration-100 group-hover:opacity-30">
            {rects(CHECK)}
          </g>
        </>
      )}
    </svg>
  );
}
