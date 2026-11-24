// A voice drawn as a line (wave.ts), on a canvas the size of its box: the call's stage draws the Chief's voice, yours
// and the ring with it, and the mic draws what it hears while you dictate. It runs at the screen's own rate, reads its
// sound once a frame without touching React, takes its ink from the text colour (so a colour transition crossfades
// it), and fades out toward both ends. Flat with nothing to move, it stops drawing; under reduced motion it stays flat.
import { useEffect, useRef } from "react";
import {
  BANDS,
  LAYERS,
  newWave,
  retargetWave,
  stepWave,
  waveAt,
  waveSettled,
  type WaveRest,
  type WaveSource,
  type WaveState,
} from "./wave.ts";

/** Each layer's ink and stroke, the line first. */
const ALPHA = [1, 0.5, 0.3, 0.16] as const;
const STROKE = [2, 1.5, 1.25, 1.25] as const;
/** The tint between the line and its reflection (the last layer): the voice's body. */
const BODY = 0.1;
/** How tall the drift stands, in CSS pixels, whatever the box's height. */
const REST_PX = 2;
/** A box shorter than this draws finer strokes. The partials' cycles are written for a line ROOMY_PX long: a shorter one takes fewer, a longer one more. */
const SMALL_PX = 24;
const ROOMY_PX = 440;

/**
 * Sizes a canvas to its box in device pixels; true when that changed it. Setting a canvas's size clears it, even to the
 * size it has, so a size that holds is left alone: a line that changes what it draws (a call's mode) keeps its frame.
 */
export function fitCanvas(
  el: Pick<HTMLCanvasElement, "clientWidth" | "clientHeight" | "width" | "height">,
  dpr: number,
): boolean {
  const width = Math.round(el.clientWidth * dpr);
  const height = Math.round(el.clientHeight * dpr);
  if (el.width === width && el.height === height) return false;
  el.width = width;
  el.height = height;
  return true;
}

export function VoiceWave({
  source,
  rest,
  layers = LAYERS,
  className,
}: {
  /** The sound to draw; null: none. */ source: WaveSource | null;
  rest: WaveRest;
  /** The line alone (1), or with its echoes. */ layers?: number;
  className?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const wave = useRef<WaveState | null>(null);
  if (wave.current === null) wave.current = newWave();

  useEffect(() => {
    const el = canvas.current;
    const g = el?.getContext("2d");
    const s = wave.current;
    if (!el || !g || !s) return;
    // Muted: flat from the next frame, not a few seconds of the last word easing out.
    retargetWave(s, source !== null, rest);
    const ink = getComputedStyle(el);
    const bands = new Float32Array(BANDS);
    let fade: CanvasGradient | null = null;
    let dpr = 1;

    const fit = () => {
      dpr = window.devicePixelRatio || 1;
      if (!fitCanvas(el, dpr) && fade) return;
      // Out toward both ends, so the line comes from nothing instead of starting at an edge.
      fade = g.createLinearGradient(0, 0, el.width, 0);
      fade.addColorStop(0, "rgb(0 0 0 / 0)");
      fade.addColorStop(0.16, "rgb(0 0 0 / 1)");
      fade.addColorStop(0.84, "rgb(0 0 0 / 1)");
      fade.addColorStop(1, "rgb(0 0 0 / 0)");
    };
    const draw = () => {
      const { width, height } = el;
      if (width === 0 || height === 0 || !fade) return;
      g.clearRect(0, 0, width, height);
      const mid = height / 2;
      // A small box (the mic's pill) draws finer and with fewer turns, so it stays a line and not a scribble.
      const fine = height < SMALL_PX * dpr ? 0.75 : 1;
      const detail = Math.min(1.8, Math.max(0.5, width / (ROOMY_PX * dpr)));
      const half = mid - STROKE[0] * fine * dpr;
      const drift = Math.min(0.3, (REST_PX * dpr) / half);
      g.lineCap = "round";
      g.lineJoin = "round";
      g.strokeStyle = g.fillStyle = ink.color;
      const step = 2 * dpr;
      const points = Math.floor(width / step);
      const count = Math.min(layers, LAYERS);
      /** Adds a layer's curve to the path, left to right, or back again to close a shape. */
      const trace = (layer: number, back = false) => {
        for (let i = 0; i <= points; i++) {
          const px = (back ? points - i : i) * step;
          const y = mid - waveAt(s, (px / width) * 2 - 1, layer, drift, detail) * half;
          if (i === 0 && !back) g.moveTo(px, y);
          else g.lineTo(px, y);
        }
      };
      if (count === LAYERS) {
        g.globalAlpha = BODY;
        g.beginPath();
        trace(0);
        trace(LAYERS - 1, true);
        g.fill();
      }
      for (let layer = count - 1; layer >= 0; layer--) {
        g.globalAlpha = ALPHA[layer]!;
        g.lineWidth = STROKE[layer]! * fine * dpr;
        g.beginPath();
        trace(layer);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.globalCompositeOperation = "destination-in";
      g.fillStyle = fade;
      g.fillRect(0, 0, width, height);
      g.globalCompositeOperation = "source-over";
    };

    let frame = 0;
    let last = 0;
    const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const tick = (now: number) => {
      // A tab back from the background picks up where it was instead of lurching.
      const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      // Dragged to another screen, or zoomed: the same box in other pixels.
      if (window.devicePixelRatio !== dpr) fit();
      if (source) source.bands(bands);
      else bands.fill(0);
      stepWave(s, dt, source ? source.level() : 0, bands, rest);
      draw();
      // Flat and silent, with nothing to listen for: one last frame, then it rests until what it draws changes.
      frame =
        source === null && rest === "flat" && waveSettled(s) ? 0 : requestAnimationFrame(tick);
    };
    const resized = new ResizeObserver(() => {
      fit();
      draw();
    });
    resized.observe(el);
    // Drawn at once, so a change of what it draws never shows a frame without the line.
    fit();
    draw();
    if (!still) frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      resized.disconnect();
    };
  }, [source, rest, layers]);

  return <canvas ref={canvas} aria-hidden className={className} />;
}
