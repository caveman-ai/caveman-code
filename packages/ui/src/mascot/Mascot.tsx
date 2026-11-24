import type { CSSProperties } from "react";

import { cn } from "../lib/cn";
import { DEFAULT_COMPANION, useBody, useCompanion } from "./cast";
import { MASCOT_GRID, MASCOT_POSES, type MascotProps } from "./poses";
import { MASCOT_SPRITES, type MascotPath } from "./sprites";

// The idle blink: the shut-eye layer shows for the last 4% of a 4.3 s cycle,
// a held step, never a fade. At rest (reduced motion, animate={false}) the
// layer stays hidden and his eyes stay open.
const BLINK_KEYFRAMES = "@keyframes mascot-blink{0%{opacity:0}96%{opacity:1}}";
const BLINK_STYLE: CSSProperties = { opacity: 0, animation: "mascot-blink 4.3s steps(1, end) infinite" };

function Paths({ paths }: { paths: readonly MascotPath[] }) {
  return paths.map(([token, d]) => <path key={token} d={d} style={{ fill: `hsl(var(--id-${token}))` }} />);
}

/**
 * The pixel caveman (STYLE.md section 10). Frames of the pose sit side by side
 * in one inline SVG strip that pixel.css steps through (`.px-strip`); looping
 * poses loop, the others play once and hold their last frame. Integer scale
 * only; reduced motion and `animate={false}` show frame 0.
 *
 * The body is played by the companion picked in Settings, in its skin tone,
 * unless `character` or `tone` say otherwise (cast.ts). While a companion's
 * sheet loads, the strip keeps its size and stays empty.
 */
export function Mascot({ pose = "idle", cut = "body", scale = 1, animate = true, label, className, character, tone }: MascotProps) {
  const mine = useCompanion();
  const isBody = cut === "body";
  const who = isBody ? (character ?? mine.character) : "caveman";
  const skin = isBody ? (tone ?? mine.tone) : DEFAULT_COMPANION.tone;
  const body = useBody(who);
  const { w, h } = MASCOT_GRID[cut];
  const { frames, fps, loop, still } = MASCOT_POSES[pose];
  const sheet = isBody ? body?.[pose] : MASCOT_SPRITES.bust[pose];
  // A still pose (look) never plays: its caller picks the frame with --px-frame.
  const play = animate && frames > 1 && !still;
  const blinks = animate && !!sheet?.blink;
  const strip = {
    "--px-w": w,
    "--px-h": h,
    "--px-frames": frames,
    "--px-fps": fps,
    "--px-scale": scale,
  } as CSSProperties;
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("px-strip select-none", skin !== DEFAULT_COMPANION.tone && `px-skin-${skin}`, className)}
      data-play={play && loop ? "loop" : undefined}
      style={strip}
    >
      {sheet ? (
        <svg
          // A new pose or character remounts the strip so a play-once pose starts from frame 0.
          key={`${cut}-${who}-${pose}`}
          className="px-strip-track px-art"
          viewBox={`0 0 ${w * frames} ${h}`}
          shapeRendering="crispEdges"
          style={play && !loop ? { animation: `px-strip-once ${frames / fps}s steps(${frames}, jump-none) forwards` } : undefined}
        >
          <Paths paths={sheet.paths} />
          {blinks && sheet.blink ? (
            <g style={BLINK_STYLE}>
              <Paths paths={sheet.blink} />
            </g>
          ) : null}
        </svg>
      ) : null}
      {blinks ? (
        <style href="caveman-mascot-blink" precedence="default">
          {BLINK_KEYFRAMES}
        </style>
      ) : null}
    </span>
  );
}
