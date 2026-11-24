// Colour themes: the built-ins (Catppuccin, Dracula, Nord ...) and the user's
// imported ones, each a light and/or dark ThemePalette of 16 colours. A palette
// is spread over every deck token in globals.css (surfaces, text, states,
// charts, tags), and code blocks and the terminal read those tokens, so one
// palette recolours the whole app. Modelled on upstream theme library
// (apps/web/src/themePalette.ts), with a smaller palette shape.
import { WALLPAPERS, type WallpaperArtwork } from "./wallpaper-catalog.ts";
import type { CustomTheme, ThemePalette } from "@caveman-app/session-protocol";

export type ThemeAppearance = "dark" | "light";

export interface ColorTheme {
  readonly id: string;
  readonly name: string;
  /** Groups flavours on the gallery ("Catppuccin"). */
  readonly family: string;
  readonly dark?: ThemePalette | undefined;
  readonly light?: ThemePalette | undefined;
  readonly source?: string | undefined;
  readonly wallpaper?: WallpaperArtwork | undefined;
}

// ---------------------------------------------------------------- colour math

type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.slice(1, 7), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

/** `t` of the way from a to b, in sRGB. */
export function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([x[0] + (y[0] - x[0]) * t, x[1] + (y[1] - x[1]) * t, x[2] + (y[2] - x[2]) * t]);
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The colour, pushed away from the background just far enough to reach `min` contrast on it. */
export function ensureContrast(color: string, background: string, min: number): string {
  if (contrast(color, background) >= min) return color;
  const target = luminance(background) > 0.18 ? "#000000" : "#ffffff";
  for (let t = 0.05; t < 1; t += 0.05) {
    const next = mix(color, target, t);
    if (contrast(next, background) >= min) return next;
  }
  return target;
}

/** "#1e1e2e" -> "240 21.1% 15.1%", the "H S% L%" triple every deck token holds. */
export function hexToHslTriple(hex: string): string {
  const [r, g, b] = hexToRgb(hex).map((c) => c / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const f = (n: number) => Number(n.toFixed(1));
  return `${f(h)} ${f(s * 100)}% ${f(l * 100)}%`;
}

export function appearanceOf(panel: string): ThemeAppearance {
  return luminance(panel) > 0.18 ? "light" : "dark";
}

// ------------------------------------------------------------------ built-ins

type Core = Pick<ThemePalette, "panel" | "text" | "dim" | "accent" | "red" | "orange" | "yellow" | "green" | "cyan" | "blue" | "purple" | "pink"> &
  Partial<Pick<ThemePalette, "shell" | "raised" | "hover" | "border">>;

/**
 * A palette from a theme's published colours. The surfaces it doesn't name
 * come from its panel and text the way the Caveman deck builds its own: a
 * shell a step darker (dark) or greyer (light), cards a step up, hairlines.
 */
export function palette(c: Core): ThemePalette {
  const dark = appearanceOf(c.panel) === "dark";
  return {
    shell: c.shell ?? (dark ? mix(c.panel, "#000000", 0.2) : mix(c.panel, c.text, 0.04)),
    raised: c.raised ?? (dark ? mix(c.panel, c.text, 0.035) : mix(c.panel, "#ffffff", 0.6)),
    hover: c.hover ?? mix(c.panel, c.text, dark ? 0.08 : 0.06),
    border: c.border ?? mix(c.panel, c.text, dark ? 0.1 : 0.11),
    ...c,
  };
}

const LATTE = palette({ shell: "#e6e9ef", panel: "#eff1f5", text: "#4c4f69", dim: "#6c6f85", accent: "#8839ef", red: "#d20f39", orange: "#fe640b", yellow: "#df8e1d", green: "#40a02b", cyan: "#179299", blue: "#1e66f5", purple: "#8839ef", pink: "#ea76cb" });
const TOKYO_DAY = palette({ shell: "#d0d5e3", panel: "#e1e2e7", text: "#3760bf", dim: "#6172b0", accent: "#2e7de9", red: "#f52a65", orange: "#b15c00", yellow: "#8c6c3e", green: "#587539", cyan: "#007197", blue: "#2e7de9", purple: "#9854f1", pink: "#7847bd" });
const TOKYO_ACCENTS = { accent: "#7aa2f7", red: "#f7768e", orange: "#ff9e64", yellow: "#e0af68", green: "#9ece6a", cyan: "#7dcfff", blue: "#7aa2f7", purple: "#bb9af7", pink: "#9d7cd8" } as const;
const ROSE_DAWN = palette({ shell: "#f2e9e1", panel: "#faf4ed", raised: "#fffaf3", text: "#575279", dim: "#797593", accent: "#907aa9", red: "#b4637a", orange: "#ea9d34", yellow: "#ea9d34", green: "#286983", cyan: "#56949f", blue: "#56949f", purple: "#907aa9", pink: "#d7827e" });
const AYU_LIGHT = palette({ shell: "#f3f4f5", panel: "#fcfcfc", text: "#5c6166", dim: "#8a9199", accent: "#fa8d3e", red: "#f07171", orange: "#fa8d3e", yellow: "#f2ae49", green: "#86b300", cyan: "#4cbf99", blue: "#399ee6", purple: "#a37acc", pink: "#ed9366" });

/** The look with no theme: globals.css as written. */
export const CAVEMAN_THEME_ID = "caveman";

/** Built-in themes, in gallery order. Colours are each theme's published palette. */
export const BUILT_IN_THEMES: ReadonlyArray<ColorTheme> = [
  { id: CAVEMAN_THEME_ID, name: "Caveman", family: "Caveman" },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    family: "Catppuccin",
    dark: palette({ shell: "#181825", panel: "#1e1e2e", hover: "#313244", text: "#cdd6f4", dim: "#a6adc8", accent: "#cba6f7", red: "#f38ba8", orange: "#fab387", yellow: "#f9e2af", green: "#a6e3a1", cyan: "#94e2d5", blue: "#89b4fa", purple: "#cba6f7", pink: "#f5c2e7" }),
    light: LATTE,
  },
  {
    id: "catppuccin-macchiato",
    name: "Catppuccin Macchiato",
    family: "Catppuccin",
    dark: palette({ shell: "#1e2030", panel: "#24273a", hover: "#363a4f", text: "#cad3f5", dim: "#a5adcb", accent: "#c6a0f6", red: "#ed8796", orange: "#f5a97f", yellow: "#eed49f", green: "#a6da95", cyan: "#8bd5ca", blue: "#8aadf4", purple: "#c6a0f6", pink: "#f5bde6" }),
    light: LATTE,
  },
  {
    id: "catppuccin-frappe",
    name: "Catppuccin Frappé",
    family: "Catppuccin",
    dark: palette({ shell: "#292c3c", panel: "#303446", hover: "#414559", text: "#c6d0f5", dim: "#a5adce", accent: "#ca9ee6", red: "#e78284", orange: "#ef9f76", yellow: "#e5c890", green: "#a6d189", cyan: "#81c8be", blue: "#8caaee", purple: "#ca9ee6", pink: "#f4b8e4" }),
    light: LATTE,
  },
  {
    id: "dracula",
    name: "Dracula",
    family: "Dracula",
    dark: palette({ shell: "#21222c", panel: "#282a36", hover: "#44475a", text: "#f8f8f2", dim: "#6272a4", accent: "#bd93f9", red: "#ff5555", orange: "#ffb86c", yellow: "#f1fa8c", green: "#50fa7b", cyan: "#8be9fd", blue: "#bd93f9", purple: "#ff79c6", pink: "#ff79c6" }),
    // Alucard, Dracula's official light theme.
    light: palette({ panel: "#fffbeb", text: "#1f1f1f", dim: "#635d97", accent: "#644ac9", red: "#cb3a2a", orange: "#a34d14", yellow: "#846e15", green: "#14710a", cyan: "#036a96", blue: "#644ac9", purple: "#a3144d", pink: "#a3144d" }),
  },
  {
    id: "nord",
    name: "Nord",
    family: "Nord",
    dark: palette({ shell: "#292e39", panel: "#2e3440", hover: "#3b4252", text: "#d8dee9", dim: "#616e88", accent: "#88c0d0", red: "#bf616a", orange: "#d08770", yellow: "#ebcb8b", green: "#a3be8c", cyan: "#8fbcbb", blue: "#81a1c1", purple: "#b48ead", pink: "#b48ead" }),
    light: palette({ shell: "#e5e9f0", panel: "#eceff4", text: "#2e3440", dim: "#4c566a", accent: "#5e81ac", red: "#bf616a", orange: "#d08770", yellow: "#ebcb8b", green: "#a3be8c", cyan: "#8fbcbb", blue: "#5e81ac", purple: "#b48ead", pink: "#b48ead" }),
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    family: "Gruvbox",
    dark: palette({ shell: "#1d2021", panel: "#282828", hover: "#3c3836", text: "#ebdbb2", dim: "#a89984", accent: "#fabd2f", red: "#fb4934", orange: "#fe8019", yellow: "#fabd2f", green: "#b8bb26", cyan: "#8ec07c", blue: "#83a598", purple: "#d3869b", pink: "#d3869b" }),
    light: palette({ shell: "#f2e5bc", panel: "#fbf1c7", hover: "#ebdbb2", text: "#3c3836", dim: "#7c6f64", accent: "#b57614", red: "#9d0006", orange: "#af3a03", yellow: "#b57614", green: "#79740e", cyan: "#427b58", blue: "#076678", purple: "#8f3f71", pink: "#8f3f71" }),
  },
  {
    id: "solarized",
    name: "Solarized",
    family: "Solarized",
    dark: palette({ panel: "#002b36", hover: "#073642", text: "#93a1a1", dim: "#586e75", accent: "#268bd2", red: "#dc322f", orange: "#cb4b16", yellow: "#b58900", green: "#859900", cyan: "#2aa198", blue: "#268bd2", purple: "#6c71c4", pink: "#d33682" }),
    light: palette({ shell: "#eee8d5", panel: "#fdf6e3", text: "#586e75", dim: "#93a1a1", accent: "#268bd2", red: "#dc322f", orange: "#cb4b16", yellow: "#b58900", green: "#859900", cyan: "#2aa198", blue: "#268bd2", purple: "#6c71c4", pink: "#d33682" }),
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    family: "Tokyo Night",
    dark: palette({ shell: "#16161e", panel: "#1a1b26", hover: "#292e42", text: "#c0caf5", dim: "#737aa2", ...TOKYO_ACCENTS }),
    light: TOKYO_DAY,
  },
  {
    id: "tokyo-night-storm",
    name: "Tokyo Night Storm",
    family: "Tokyo Night",
    dark: palette({ shell: "#1f2335", panel: "#24283b", hover: "#292e42", text: "#c0caf5", dim: "#737aa2", ...TOKYO_ACCENTS }),
    light: TOKYO_DAY,
  },
  {
    id: "one",
    name: "One Dark",
    family: "One",
    dark: palette({ shell: "#21252b", panel: "#282c34", hover: "#2c313a", text: "#abb2bf", dim: "#7f848e", accent: "#61afef", red: "#e06c75", orange: "#d19a66", yellow: "#e5c07b", green: "#98c379", cyan: "#56b6c2", blue: "#61afef", purple: "#c678dd", pink: "#c678dd" }),
    light: palette({ shell: "#eaeaeb", panel: "#fafafa", text: "#383a42", dim: "#696c77", accent: "#4078f2", red: "#e45649", orange: "#986801", yellow: "#c18401", green: "#50a14f", cyan: "#0184bc", blue: "#4078f2", purple: "#a626a4", pink: "#ca1243" }),
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    family: "Rosé Pine",
    dark: palette({ shell: "#191724", panel: "#1f1d2e", hover: "#26233a", text: "#e0def4", dim: "#908caa", accent: "#c4a7e7", red: "#eb6f92", orange: "#f6c177", yellow: "#f6c177", green: "#31748f", cyan: "#9ccfd8", blue: "#9ccfd8", purple: "#c4a7e7", pink: "#ebbcba" }),
    light: ROSE_DAWN,
  },
  {
    id: "rose-pine-moon",
    name: "Rosé Pine Moon",
    family: "Rosé Pine",
    dark: palette({ shell: "#232136", panel: "#2a273f", hover: "#393552", text: "#e0def4", dim: "#908caa", accent: "#c4a7e7", red: "#eb6f92", orange: "#f6c177", yellow: "#f6c177", green: "#3e8fb0", cyan: "#9ccfd8", blue: "#9ccfd8", purple: "#c4a7e7", pink: "#ea9a97" }),
    light: ROSE_DAWN,
  },
  {
    id: "github",
    name: "GitHub",
    family: "GitHub",
    dark: palette({ shell: "#010409", panel: "#0d1117", raised: "#161b22", hover: "#21262d", text: "#e6edf3", dim: "#8d96a0", accent: "#2f81f7", red: "#f85149", orange: "#db6d28", yellow: "#d29922", green: "#3fb950", cyan: "#39c5cf", blue: "#58a6ff", purple: "#bc8cff", pink: "#f778ba" }),
    light: palette({ shell: "#f6f8fa", panel: "#ffffff", raised: "#ffffff", text: "#1f2328", dim: "#59636e", accent: "#0969da", red: "#cf222e", orange: "#bc4c00", yellow: "#9a6700", green: "#1a7f37", cyan: "#1b7c83", blue: "#0969da", purple: "#8250df", pink: "#bf3989" }),
  },
  {
    id: "everforest",
    name: "Everforest",
    family: "Everforest",
    dark: palette({ shell: "#232a2e", panel: "#2d353b", hover: "#3d484d", text: "#d3c6aa", dim: "#9da9a0", accent: "#a7c080", red: "#e67e80", orange: "#e69875", yellow: "#dbbc7f", green: "#a7c080", cyan: "#83c092", blue: "#7fbbb3", purple: "#d699b6", pink: "#d699b6" }),
    light: palette({ shell: "#efebd4", panel: "#fdf6e3", text: "#5c6a72", dim: "#829181", accent: "#8da101", red: "#f85552", orange: "#f57d26", yellow: "#dfa000", green: "#8da101", cyan: "#35a77c", blue: "#3a94c5", purple: "#df69ba", pink: "#df69ba" }),
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    family: "Kanagawa",
    dark: palette({ shell: "#16161d", panel: "#1f1f28", hover: "#2a2a37", text: "#dcd7ba", dim: "#727169", accent: "#7e9cd8", red: "#e46876", orange: "#ffa066", yellow: "#e6c384", green: "#98bb6c", cyan: "#7aa89f", blue: "#7e9cd8", purple: "#957fb8", pink: "#d27e99" }),
    // Lotus, Kanagawa's light theme.
    light: palette({ shell: "#e5ddb0", panel: "#f2ecbc", text: "#545464", dim: "#8a8980", accent: "#4d699b", red: "#c84053", orange: "#cc6d00", yellow: "#77713f", green: "#6f894e", cyan: "#597b75", blue: "#4d699b", purple: "#624c83", pink: "#b35b79" }),
  },
  {
    id: "ayu",
    name: "Ayu",
    family: "Ayu",
    dark: palette({ shell: "#0b0e14", panel: "#0d1017", text: "#bfbdb6", dim: "#6c7380", accent: "#e6b450", red: "#f07178", orange: "#ff8f40", yellow: "#ffb454", green: "#aad94c", cyan: "#95e6cb", blue: "#59c2ff", purple: "#d2a6ff", pink: "#f29668" }),
    light: AYU_LIGHT,
  },
  {
    id: "ayu-mirage",
    name: "Ayu Mirage",
    family: "Ayu",
    dark: palette({ shell: "#1f2430", panel: "#242936", text: "#cccac2", dim: "#707a8c", accent: "#ffcc66", red: "#f28779", orange: "#ffad66", yellow: "#ffd173", green: "#d5ff80", cyan: "#95e6cb", blue: "#73d0ff", purple: "#dfbfff", pink: "#f29e74" }),
    light: AYU_LIGHT,
  },
  {
    id: "monokai",
    name: "Monokai",
    family: "Monokai",
    dark: palette({ shell: "#1e1f1c", panel: "#272822", hover: "#3e3d32", text: "#f8f8f2", dim: "#75715e", accent: "#a6e22e", red: "#f92672", orange: "#fd971f", yellow: "#e6db74", green: "#a6e22e", cyan: "#66d9ef", blue: "#66d9ef", purple: "#ae81ff", pink: "#f92672" }),
  },
  {
    id: "night-owl",
    name: "Night Owl",
    family: "Night Owl",
    dark: palette({ shell: "#010e1a", panel: "#011627", hover: "#0b2942", text: "#d6deeb", dim: "#637777", accent: "#82aaff", red: "#ef5350", orange: "#f78c6c", yellow: "#ecc48d", green: "#addb67", cyan: "#7fdbca", blue: "#82aaff", purple: "#c792ea", pink: "#ff869a" }),
  },
  ...WALLPAPERS.map(wallpaperTheme),
];

/** A built-in or one of `custom`; unknown and absent ids are the Caveman look. */
export function findTheme(id: string | undefined, custom: ReadonlyArray<CustomTheme> = []): ColorTheme {
  return BUILT_IN_THEMES.find((t) => t.id === id) ?? customAsTheme(custom.find((t) => t.id === id)) ?? BUILT_IN_THEMES[0]!;
}

function customAsTheme(t: CustomTheme | undefined): ColorTheme | undefined {
  return t && { id: t.id, name: t.name, family: "Imported", dark: t.dark, light: t.light, source: t.source };
}

export function allThemes(custom: ReadonlyArray<CustomTheme> = []): ReadonlyArray<ColorTheme> {
  return [...BUILT_IN_THEMES, ...custom.map((t) => customAsTheme(t)!)];
}

/**
 * Which half of a theme shows for the light/dark the user asked for. A theme
 * with one half wears it whatever the mode (Monokai is always dark).
 */
export function themeHalf(theme: ColorTheme, wanted: ThemeAppearance): { appearance: ThemeAppearance; palette: ThemePalette | null } {
  const own = theme[wanted];
  if (own) return { appearance: wanted, palette: own };
  const other: ThemeAppearance = wanted === "dark" ? "light" : "dark";
  const fallback = theme[other];
  return fallback ? { appearance: other, palette: fallback } : { appearance: wanted, palette: null };
}

/** The only half a theme has, if it has one. */
export function onlyAppearance(theme: ColorTheme): ThemeAppearance | null {
  if (theme.dark && theme.light) return null;
  return theme.dark ? "dark" : theme.light ? "light" : null;
}

// --------------------------------------------------------------- the tokens

/** The ink that reads best on a filled colour: the palette's darkest surface or white. */
function onFill(fill: string, p: ThemePalette, dark: boolean): string {
  const ink = dark ? p.shell : p.text;
  const candidates = [ink, "#ffffff", dark ? p.text : p.panel, "#000000"];
  return candidates.reduce((best, c) => (contrast(c, fill) > contrast(best, fill) ? c : best));
}

const TAGS = ["blue", "green", "yellow", "orange", "purple", "red"] as const;

/**
 * Every deck token for a palette: "H S% L%" triples for the hsl() tokens,
 * hex for the tag palette. Secondary text and state colours are lifted to
 * readable contrast on the panel when a theme's own are too faint.
 */
export function themeTokens(raw: ThemePalette, appearance: ThemeAppearance): Record<string, string> {
  const dark = appearance === "dark";
  const bg = raw.panel;
  const text = ensureContrast(raw.text, bg, 7);
  const dim = ensureContrast(raw.dim, bg, 4.5);
  const lift = (c: string) => ensureContrast(c, bg, 3);
  const p: ThemePalette = { ...raw, text, dim, ...Object.fromEntries((["accent", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"] as const).map((k) => [k, lift(raw[k])])) };
  const popover = dark ? mix(p.raised, text, 0.02) : p.raised;
  // Effort tiers (pixel.css, components/effort.tsx): chip and menu text in the theme's red and purple at 4.5:1 on every surface it sits on.
  const readable = (c: string) => [popover, p.raised, p.hover].reduce((x, on) => ensureContrast(x, on, 4.5), c);
  const effortMax = readable(p.red);
  const effortUltra = readable(p.purple);
  // Speed (components/speed.tsx): the bolt in the theme's yellow, as readable.
  const speed = readable(p.yellow);
  const hsl: Record<string, string> = {
    background: p.panel,
    foreground: text,
    card: p.raised,
    "card-foreground": text,
    popover,
    "popover-foreground": text,
    primary: p.accent,
    "primary-foreground": onFill(p.accent, p, dark),
    secondary: p.hover,
    "secondary-foreground": mix(text, dim, 0.35),
    muted: mix(p.panel, p.hover, 0.5),
    "muted-foreground": dim,
    accent: p.hover,
    "accent-foreground": text,
    destructive: p.red,
    "destructive-foreground": onFill(p.red, p, dark),
    success: p.green,
    "success-foreground": onFill(p.green, p, dark),
    warning: p.yellow,
    "warning-foreground": onFill(p.yellow, p, dark),
    info: p.blue,
    "info-foreground": onFill(p.blue, p, dark),
    border: p.border,
    input: mix(p.border, text, dark ? 0.1 : 0.35),
    ring: p.accent,
    "chart-1": p.blue,
    "chart-line": mix(p.blue, text, 0.15),
    "chart-2": p.orange,
    "chart-3": p.green,
    "chart-4": p.purple,
    "chart-5": p.pink,
    "chart-other": dim,
    "chart-tone-1": p.blue,
    "chart-tone-2": p.cyan,
    "chart-tone-3": mix(p.blue, p.panel, 0.35),
    sidebar: p.shell,
    "sidebar-foreground": ensureContrast(mix(dim, text, 0.25), p.shell, 4.5),
    "sidebar-accent": mix(p.shell, text, dark ? 0.09 : 0.08),
    "sidebar-accent-foreground": text,
    "sidebar-border": mix(p.shell, text, dark ? 0.07 : 0.09),
    "subtle-foreground": ensureContrast(mix(dim, p.panel, 0.15), p.panel, 4.5),
    control: p.raised,
    "effort-max": effortMax,
    "effort-ultra": effortUltra,
    speed,
  };
  const tokens: Record<string, string> = {};
  for (const [name, hex] of Object.entries(hsl)) tokens[`--${name}`] = hexToHslTriple(hex);
  const fill = (c: string) => mix(p.panel, c, dark ? 0.16 : 0.12);
  tokens["--tag-neutral"] = mix(p.panel, text, dark ? 0.1 : 0.06);
  tokens["--tag-neutral-border"] = mix(p.panel, text, dark ? 0.16 : 0.14);
  tokens["--tag-neutral-ink"] = mix(text, dim, 0.4);
  for (const name of TAGS) {
    const c = p[name];
    tokens[`--tag-${name}`] = fill(c);
    tokens[`--tag-${name}-border`] = mix(p.panel, c, dark ? 0.3 : 0.32);
    tokens[`--tag-${name}-ink`] = ensureContrast(mix(c, text, dark ? 0.35 : 0.3), fill(c), 4.5);
  }
  tokens["--tag-mint"] = tokens["--tag-green"]!;
  tokens["--tag-mint-border"] = tokens["--tag-green-border"]!;
  tokens["--tag-mint-ink"] = tokens["--tag-green-ink"]!;
  return tokens;
}

/** Every custom property themeTokens sets, so switching back to Caveman can clear them. */
export const THEME_TOKEN_NAMES: ReadonlyArray<string> = Object.keys(themeTokens(BUILT_IN_THEMES[1]!.dark!, "dark"));

/** Color-matched, readable light and dark chrome for each wallpaper. */
function wallpaperTheme(art: WallpaperArtwork): ColorTheme {
  const [base, accent, secondary] = art.colors;
  const shared = { accent, red: "#dc7a85", orange: "#dda075", yellow: "#d9c182", green: "#8ebd9b", cyan: secondary, blue: "#8bb5df", purple: "#b69bd0", pink: "#d99dbb" };
  return {
    id: art.id,
    name: art.name,
    family: art.credit.collection ?? "Night collection",
    source: `${art.credit.author} · ${art.credit.license}`,
    wallpaper: art,
    dark: palette({ ...shared, shell: mix(base, "#080b10", 0.84), panel: mix(base, "#0c1016", 0.79), text: mix(secondary, "#ffffff", 0.86), dim: mix(secondary, "#aab5c1", 0.75) }),
    light: palette({ ...shared, shell: mix(base, "#ffffff", 0.9), panel: mix(base, "#ffffff", 0.965), text: mix(base, "#161b23", 0.72), dim: mix(base, "#434c5a", 0.65) }),
  };
}
