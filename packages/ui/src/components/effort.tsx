import * as React from "react";
import { cn } from "../lib/cn";

/*
 * Effort: how hard the model thinks before it acts. One line at the foot of the model picker (founder
 * 2026-10-27: the old slider, cleaner): "Effort", a track with one stop per level the model offers, lowest on
 * the left, and the level's name. The thumb is a notched pixel block that glides from stop to stop under the
 * pointer, the arrow keys or ←/→ from the picker's search; no free sliding between stops. The model chip names
 * the level beside the model.
 *
 * Past the ceiling the level changes colour (effortTier): Max is danger red, Ultracode purple, on the word,
 * the thumb and the stops at those levels, so the track shows where the danger starts.
 *
 * Where the model starts (`start`, Settings.model_defaults or its own default) is a hollow square in place of its
 * stop while the thumb is elsewhere. With `save`, the level's word is then dotted underneath and a
 * click makes the chat's level (and speed) the model's start: no button of its own, so the line never grows.
 */

const LABELS: Record<string, string> = {
  none: "None",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(level: string): string {
  return LABELS[level] ?? level.charAt(0).toUpperCase() + level.slice(1);
}

export type EffortTier = "base" | "max" | "ultra";

/** Past the ceiling: Max is danger red, Claude's Ultracode purple; the rest stay ink. */
export function effortTier(level: string | undefined): EffortTier {
  const l = level?.toLowerCase() ?? "";
  return l === "max" ? "max" : l === "ultracode" ? "ultra" : "base";
}

// Chrome text in a tier's colour (the model chip, the slider's word, the pip); ink levels keep the deck's grey.
export const EFFORT_TIER_TEXT: Record<EffortTier, string> = {
  base: "",
  max: "text-[hsl(var(--effort-max))]",
  ultra: "text-[hsl(var(--effort-ultra))]",
};
const TIER_FILL: Record<EffortTier, string> = {
  base: "bg-foreground",
  max: "bg-[hsl(var(--effort-max))]",
  ultra: "bg-[hsl(var(--effort-ultra))]",
};

/** The effort to use on a model: the wanted level if offered, else the model's default, else the middle stop. */
export function pickEffort(efforts: readonly string[], wanted?: string, fallback?: string): string | undefined {
  if (wanted && efforts.includes(wanted)) return wanted;
  if (fallback && efforts.includes(fallback)) return fallback;
  return efforts[Math.floor((efforts.length - 1) / 2)];
}

/** One step along the levels, held at either end (a slider, not a cycle). */
export function stepLevel(levels: readonly string[], current: string | undefined, step: 1 | -1): string | undefined {
  const i = current ? levels.indexOf(current) : -1;
  return levels[Math.min(levels.length - 1, Math.max(0, (i < 0 ? 0 : i) + step))];
}

/**
 * The level's name in every level's width at once: the stack is as wide as the longest, so a change never
 * shifts what sits beside it (the slider's track, the model chip's edge).
 */
export function EffortWord({ levels, value, className, labelOf = effortLabel }: { levels: readonly string[]; value: string; className?: string; labelOf?: (level: string) => string }) {
  return (
    <span className={cn("grid justify-items-end text-right", EFFORT_TIER_TEXT[effortTier(value)], className)}>
      {(levels.includes(value) ? levels : [...levels, value]).map((level) => (
        <span key={level} className={cn("col-start-1 row-start-1 whitespace-nowrap", level !== value && "invisible")} aria-hidden={level !== value || undefined}>
          {labelOf(level)}
        </span>
      ))}
    </span>
  );
}

// Room between the track's ends and the first and last stop: half the thumb and a little air.
const PAD = 10;
const THUMB_W = 12;
// Fill and thumb glide to the next stop on the chrome curve; nothing overshoots.
const GLIDE = "transition-transform duration-150 ease-snap motion-reduce:transition-none";

export function EffortSlider({
  levels,
  value,
  start,
  save,
  onChange,
  className,
}: {
  levels: readonly string[];
  value: string | undefined;
  /** The level the model starts at: marked while the thumb is elsewhere. */
  start?: string | undefined;
  /** While the chat is not where the model starts: the word, dotted, makes it the start ("Make Max the default for …"). */
  save?: { readonly label: string; readonly onSave: () => void } | undefined;
  onChange: (level: string) => void;
  className?: string;
}) {
  return (
    <StepSlider
      label="Effort"
      caption={{ text: "Effort", title: "How hard the model thinks before it acts. Higher is slower and smarter." }}
      levels={levels}
      value={value}
      start={start}
      save={save}
      tierOf={effortTier}
      onChange={onChange}
      // A click keeps focus where it was (the picker's search), so the keys carry on there.
      keepFocus
      className={className}
    />
  );
}

/**
 * The effort slider's track, for any short row of levels (a Chief's autonomy and updates use it too): one stop per
 * level, lowest on the left, a notched pixel thumb that glides stop to stop under the pointer or the arrow keys, and
 * the level's name after it. `caption` is the grey word before the track; leave it out where a row already names it.
 */
export function StepSlider({
  label,
  caption,
  levels,
  value,
  labelOf = effortLabel,
  tierOf = () => "base",
  start,
  save,
  keepFocus = false,
  onChange,
  className,
  wordClassName,
}: {
  /** What a screen reader calls it. */
  label: string;
  caption?: { readonly text: string; readonly title?: string | undefined } | undefined;
  levels: readonly string[];
  value: string | undefined;
  labelOf?: (level: string) => string;
  tierOf?: (level: string) => EffortTier;
  start?: string | undefined;
  save?: { readonly label: string; readonly onSave: () => void } | undefined;
  /** A pointer press leaves focus where it was (the model picker's search). */
  keepFocus?: boolean;
  onChange: (level: string) => void;
  className?: string | undefined;
  /** The level's name: a min width here lines up the tracks of sliders stacked in rows. */
  wordClassName?: string | undefined;
}) {
  const track = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ rect: DOMRect; last: number } | null>(null);
  const n = levels.length;
  const index = Math.max(0, value ? levels.indexOf(value) : 0);
  const at = (i: number) => (n > 1 ? i / (n - 1) : 0.5);
  // The thumb follows the value at rest; while dragging it follows the pointer, stop to stop, ahead of a slow save.
  React.useLayoutEffect(() => {
    if (!drag.current) track.current?.style.setProperty("--p", String(at(index)));
  }, [index, n]);
  if (n < 2) return null;
  const level = levels[index]!;
  const tier = tierOf(level);

  const set = (i: number) => {
    track.current?.style.setProperty("--p", String(at(i)));
    if (levels[i] !== value) onChange(levels[i]!);
  };
  const fromPointer = (clientX: number, rect: DOMRect) => Math.round(Math.min(1, Math.max(0, (clientX - rect.left - PAD) / Math.max(1, rect.width - PAD * 2))) * (n - 1));
  const move = (clientX: number) => {
    const d = drag.current;
    if (!d) return;
    const i = fromPointer(clientX, d.rect);
    if (i !== d.last) {
      d.last = i;
      set(i);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const step: Record<string, 1 | -1> = { ArrowLeft: -1, ArrowDown: -1, PageDown: -1, ArrowRight: 1, ArrowUp: 1, PageUp: 1 };
    const next = e.key in step ? stepLevel(levels, level, step[e.key]!) : e.key === "Home" ? levels[0] : e.key === "End" ? levels[n - 1] : null;
    if (!next) return;
    e.preventDefault();
    set(levels.indexOf(next));
  };
  const word = <EffortWord levels={levels} value={level} labelOf={labelOf} className={cn("text-[13px]", tier === "base" && "text-foreground", wordClassName)} />;

  return (
    <div className={cn("flex select-none items-center gap-3", className)}>
      {caption ? (
        <span className="text-[12px] text-muted-foreground" title={caption.title}>
          {caption.text}
        </span>
      ) : null}
      <div
        ref={track}
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={n - 1}
        aria-valuenow={index}
        aria-valuetext={labelOf(level)}
        data-tier={tier}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          if (keepFocus) e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { rect: e.currentTarget.getBoundingClientRect(), last: index };
          move(e.clientX);
        }}
        onPointerMove={(e) => move(e.clientX)}
        onPointerUp={() => (drag.current = null)}
        onPointerCancel={() => (drag.current = null)}
        onLostPointerCapture={() => (drag.current = null)}
        onKeyDown={onKeyDown}
        className="relative h-6 min-w-0 flex-1 cursor-pointer touch-none rounded-md bg-background shadow-[inset_0_0_0_1px_hsl(var(--border))] outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Fill: a track-wide layer slid in from the left so its edge sits under the thumb. */}
        <div aria-hidden className="absolute inset-0 overflow-hidden rounded-md">
          <div className={cn("absolute inset-0 rounded-md bg-secondary shadow-[inset_0_0_0_1px_hsl(var(--input))] will-change-transform", GLIDE)} style={{ transform: `translateX(calc(-100% + ${PAD + THUMB_W / 2}px + var(--p, 0) * (100% - ${PAD * 2}px)))` }} />
        </div>
        {levels.map((stop, i) =>
          stop === start && stop !== level ? (
            <span
              key={stop}
              aria-hidden
              data-start=""
              className={cn("absolute top-1/2 size-[7px] -translate-y-1/2 shadow-[inset_0_0_0_1px_currentColor]", EFFORT_TIER_TEXT[tierOf(stop)] || "text-muted-foreground")}
              style={{ left: `calc(${PAD - 3.5}px + ${at(i)} * (100% - ${PAD * 2}px))` }}
            />
          ) : (
            <span
              key={stop}
              aria-hidden
              className={cn("absolute top-1/2 size-[3px] -translate-y-1/2", tierOf(stop) === "base" ? "bg-muted-foreground/80" : TIER_FILL[tierOf(stop)])}
              style={{ left: `calc(${PAD - 1.5}px + ${at(i)} * (100% - ${PAD * 2}px))` }}
            />
          ),
        )}
        {/* Thumb: rides a carrier as wide as the stops' span, so translateX(100%) is the last stop. */}
        <div aria-hidden className="pointer-events-none absolute inset-y-0" style={{ left: PAD, right: PAD }}>
          <div className={cn("h-full w-full will-change-transform", GLIDE)} style={{ transform: "translateX(calc(var(--p, 0) * 100%))" }}>
            <span className={cn("px-notch-2 absolute top-1 h-4 shadow-[inset_0_-2px_0_hsl(var(--id-outline)/0.28)]", TIER_FILL[tier])} style={{ left: -THUMB_W / 2, width: THUMB_W }} />
          </div>
        </div>
      </div>
      {save ? (
        <button
          type="button"
          aria-label={save.label}
          title={save.label}
          // A click keeps focus in the picker's search, like the track.
          onPointerDown={(e) => e.preventDefault()}
          onClick={save.onSave}
          className="rounded-sm underline decoration-muted-foreground decoration-dotted decoration-1 underline-offset-4 outline-none transition-colors duration-75 hover:decoration-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {word}
        </button>
      ) : (
        word
      )}
    </div>
  );
}
