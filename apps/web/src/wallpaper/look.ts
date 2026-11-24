// A wallpaper's look: which picture is behind a new chat, the effect laid over it and how it is tuned. Pure: what
// the person picked (kept by store.ts) and what the shader is handed for it (shader.ts). Numbers are in the units
// Settings shows: percent, and px for blur.

export type EffectId = "none" | "dither" | "grain" | "glass" | "dots";

/** "none": the plain panel. "image": the person's own. Else a painting's id (paintings.ts). */
export type SourceId = string;

export interface WallpaperPick {
  readonly source: SourceId;
  /** Theme picks may change the picture. A manual picture turns this off. */
  readonly matchTheme: boolean;
  readonly effect: EffectId;
  /** How strongly the effect shows, 0 to 100. */
  readonly amount: number;
  /** How large its pattern is, 0 to 100: a dither's pixel, the grain, a rib of glass, a dot. */
  readonly size: number;
  /** 40 to 140: the picture's light. */
  readonly brightness: number;
  /** px, a person's image only. */
  readonly blur: number;
  /** 0 to 90: how far the picture is taken toward the panel's colour. */
  readonly dim: number;
  /** 0 to 100: how much of the box's height fades into the panel at the bottom. */
  readonly fade: number;
  /** 30 to 100: how solid the chat box's glass is. */
  readonly box: number;
  /** A painting that moves does. Off: it holds still. */
  readonly motion: boolean;
  /** The person's image, 0 (black) to 1 (white) on average, measured as it was kept: which ink reads on it. */
  readonly imageLight: number;
}

/** Each number's range, and where it starts. */
export const RANGE = {
  amount: { min: 0, max: 100, start: 25 },
  size: { min: 0, max: 100, start: 25 },
  brightness: { min: 40, max: 140, start: 100 },
  blur: { min: 0, max: 40, start: 0 },
  dim: { min: 0, max: 90, start: 0 },
  fade: { min: 0, max: 100, start: 0 },
  box: { min: 30, max: 100, start: 72 },
} as const satisfies Record<string, { min: number; max: number; start: number }>;
export type Dial = keyof typeof RANGE;

export const EFFECTS: Readonly<Record<EffectId, { name: string; line: string }>> = {
  none: { name: "None", line: "The picture as it is." },
  dither: { name: "Dither", line: "Fine pixels in a few tones." },
  grain: { name: "Grain", line: "Film grain." },
  glass: { name: "Reeded glass", line: "Seen through ribbed glass." },
  dots: { name: "Dots", line: "A board of small lamps." },
};

/** The painting a new install wears: the page's own colour with a cave wall's paintings faint in it (paintings/mist.ts). */
export const DEFAULT_SOURCE = "mist";

/** Nothing over it: the painting's marks are its texture. */
export const DEFAULT_WALLPAPER: WallpaperPick = {
  source: DEFAULT_SOURCE,
  matchTheme: true,
  effect: "none",
  amount: RANGE.amount.start,
  size: RANGE.size.start,
  brightness: RANGE.brightness.start,
  blur: RANGE.blur.start,
  dim: RANGE.dim.start,
  fade: RANGE.fade.start,
  box: RANGE.box.start,
  motion: true,
  imageLight: 0.2,
};

const within = (
  value: unknown,
  { min, max, start }: { min: number; max: number; start: number },
) =>
  typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : start;

/**
 * What was kept, with anything this build does not know put back to its default. `sources` are the pictures there
 * are to pick: a kept one that is gone (a painting dropped, an image removed) is the default again.
 */
export function parseWallpaper(
  raw: string | null,
  sources: ReadonlyArray<SourceId>,
): WallpaperPick {
  let kept: Partial<Record<keyof WallpaperPick, unknown>> = {};
  try {
    const parsed: unknown = JSON.parse(raw ?? "{}");
    if (parsed !== null && typeof parsed === "object") kept = parsed;
  } catch {
    // Not JSON: the default.
  }
  const d = DEFAULT_WALLPAPER;
  return {
    source:
      typeof kept.source === "string" && sources.includes(kept.source) ? kept.source : d.source,
    matchTheme:
      typeof kept.matchTheme === "boolean"
        ? kept.matchTheme
        : typeof kept.source === "string" && sources.includes(kept.source)
          ? kept.source === "theme"
          : d.matchTheme,
    effect:
      typeof kept.effect === "string" && kept.effect in EFFECTS
        ? (kept.effect as EffectId)
        : d.effect,
    amount: within(kept.amount, RANGE.amount),
    size: within(kept.size, RANGE.size),
    brightness: within(kept.brightness, RANGE.brightness),
    blur: within(kept.blur, RANGE.blur),
    dim: within(kept.dim, RANGE.dim),
    fade: within(kept.fade, RANGE.fade),
    box: within(kept.box, RANGE.box),
    motion: typeof kept.motion === "boolean" ? kept.motion : d.motion,
    imageLight: within(kept.imageLight, { min: 0, max: 1, start: d.imageLight }),
  };
}

// ---------------------------------------------------------------- reading

export type Rgb = readonly [number, number, number];

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Relative luminance of a colour whose channels run 0 to 1. */
export const luminance = ([r, g, b]: Rgb): number =>
  0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);

/** What words on a wallpaper keep against it (WCAG AA for text). */
export const READING_CONTRAST = 4.5;

/** Words on a wallpaper are near white or near black, whichever the picture takes. */
export const INKS: Readonly<Record<"light" | "dark", Rgb>> = {
  light: [0.98, 0.98, 0.98],
  dark: [0.1, 0.1, 0.11],
};

/**
 * Which ink the words on this wallpaper wear. A dark picture takes light words whatever the theme, as a desktop
 * does; one taken far toward a light panel takes dark ones. `light` is the picture's own (0 to 1), or "panel" for
 * a painting in the page's own colour.
 */
export function inkFor(
  pick: Pick<WallpaperPick, "brightness" | "dim">,
  light: number | "panel",
  panel: Rgb,
): "light" | "dark" {
  const ground = luminance(panel) ** (1 / 2.2);
  const shown = light === "panel" ? ground : Math.min(1, light * (pick.brightness / 100));
  const mixed = shown + (ground - shown) * (pick.dim / 100);
  return mixed < 0.55 ? "light" : "dark";
}

/**
 * The luminance a picture is held to under words: at most this under light ink, at least this under dark ink. It is
 * what leaves the ink at `READING_CONTRAST` exactly.
 */
export function readingLimit(ink: "light" | "dark"): number {
  const l = luminance(INKS[ink]);
  return ink === "light"
    ? (l + 0.05) / READING_CONTRAST - 0.05
    : READING_CONTRAST * (l + 0.05) - 0.05;
}

// ----------------------------------------------------------------- shader

/** What the shader is handed for an effect: its pattern's size in CSS px, and its strength. */
export function effectUniforms(pick: Pick<WallpaperPick, "effect" | "amount" | "size">): {
  effect: number;
  grain: number;
  amount: number;
} {
  const amount = pick.amount / 100;
  const size = pick.size / 100;
  switch (pick.effect) {
    case "none":
      return { effect: 0, grain: 1, amount: 0 };
    // A dither's pixel is 1 to 5 px. The more of it, the fewer tones a channel has, from 25 (a texture you have to
    // look for) down to 2 (a poster); the curve spends most of the dial on the quiet end.
    case "dither":
      return { effect: 1, grain: 1 + Math.round(size * 4), amount: 1.6 + 24 * (1 - amount) ** 1.6 };
    case "grain":
      return { effect: 2, grain: 0.75 + size * 2.25, amount };
    case "glass":
      return { effect: 3, grain: 8 + size * 72, amount };
    case "dots":
      return { effect: 4, grain: 4 + size * 16, amount };
  }
}
