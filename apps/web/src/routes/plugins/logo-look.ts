// How a plugin's logo should sit on a tile, read from its own pixels: manifests
// say nothing about whether a mark is drawn for a light ground, a dark one, or
// carries its own square (Slack's aubergine icon). Read once per image and kept.
import { useEffect, useSyncExternalStore } from "react";

export interface LogoLook {
  /** Opaque across its whole face: an app icon with its own ground, shown edge to edge. */
  readonly tile: boolean;
  /** Most of its ink is too dark to see on a dark tile. */
  readonly darkInk: boolean;
  /** Most of its ink is near white, lost on a white tile. */
  readonly lightInk: boolean;
  /** One colour of ink (a black mark, a white one): flipped light for dark, it reads as the vendor's own variant would. */
  readonly mono: boolean;
}

const lum = (r: number, g: number, b: number) => {
  const c = (v: number) => ((v /= 255) <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const contrast = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
// The dark deck's card, #1a1a1b. Under 2:1 a stroke is lost on it. On white only near-white is: vendors draw
// their colour marks for white, and a yellow (Hugging Face's) or mint (Supabase's) mark still reads there.
const DARK_TILE = lum(0x1a, 0x1a, 0x1b);
const LOST_ON_DARK = 2;
const LOST_ON_WHITE = 1.25;

/** `rgba`: a `size` x `size` drawing of the logo, letterboxed to keep its shape. */
export function lookOf(rgba: ArrayLike<number>, size: number): LogoLook {
  // A tile fills its face: nine tenths of the square a tenth in from the edge (past rounded corners) is opaque.
  // An outline mark (Neon's) or a letterboxed wordmark leaves holes.
  const inset = Math.round(size * 0.1);
  let face = 0;
  let solid = 0;
  for (let y = inset; y < size - inset; y++)
    for (let x = inset; x < size - inset; x++) {
      face++;
      if (rgba[(y * size + x) * 4 + 3]! >= 200) solid++;
    }
  const inks: [number, number, number][] = [];
  for (let p = 0; p < size * size; p++) if (rgba[p * 4 + 3]! >= 128) inks.push([rgba[p * 4]!, rgba[p * 4 + 1]!, rgba[p * 4 + 2]!]);
  const n = inks.length;
  if (n === 0) return { tile: false, darkInk: false, lightInk: false, mono: false };
  const mean = [0, 1, 2].map((k) => inks.reduce((a, c) => a + c[k]!, 0) / n);
  const share = (f: (c: [number, number, number]) => boolean) => inks.filter(f).length / n;
  return {
    tile: solid / face >= 0.9,
    darkInk: share((c) => contrast(lum(...c), DARK_TILE) < LOST_ON_DARK) >= 0.5,
    lightInk: share((c) => contrast(lum(...c), 1) < LOST_ON_WHITE) >= 0.5,
    mono: share((c) => Math.max(...c.map((v, k) => Math.abs(v - mean[k]!))) <= 48) >= 0.9,
  };
}

const SIZE = 32;
// null: not read (still loading, or an image the page may not read, like a cross-origin one without CORS).
const looks = new Map<string, LogoLook | null>();
const listeners = new Set<() => void>();

function read(src: string) {
  if (looks.has(src)) return;
  looks.set(src, null);
  const img = new Image();
  if (typeof img.decode !== "function") return;
  if (/^https?:/i.test(src)) img.crossOrigin = "anonymous";
  img.src = src;
  void img.decode().then(
    () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = SIZE;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        // An SVG without a size of its own reports 0: drawn square, as a tile would show it.
        const w = img.naturalWidth || SIZE;
        const h = img.naturalHeight || SIZE;
        const k = SIZE / Math.max(w, h);
        ctx.drawImage(img, (SIZE - w * k) / 2, (SIZE - h * k) / 2, w * k, h * k);
        looks.set(src, lookOf(ctx.getImageData(0, 0, SIZE, SIZE).data, SIZE));
        listeners.forEach((l) => l());
      } catch {
        // A tainted canvas: the logo shows as a plain mark.
      }
    },
    () => {},
  );
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

/** The logo's look once read; null until then, or when it cannot be read. */
export function useLogoLook(src: string | undefined): LogoLook | null {
  const look = useSyncExternalStore(
    subscribe,
    () => (src === undefined ? null : (looks.get(src) ?? null)),
    () => null,
  );
  useEffect(() => {
    if (src !== undefined) read(src);
  }, [src]);
  return look;
}
