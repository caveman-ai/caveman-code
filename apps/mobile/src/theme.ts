// The deck (packages/ui/src/styles/globals.css, html[data-surface="deck"], and pixel.css's accents) as plain values,
// light and dark: React Native has no CSS variables. Each hex is what the deck's HSL token renders to; keep them in
// step when the deck moves. The app follows the system theme like the desktop does, unless Settings pins one.
//
// Type is the desktop's (STYLE.md 4, ): the system's own faces, SF Pro and SF Mono on an iPhone,
// nothing to download, weights 400, 500 and 600 only, mono for code, paths, branches and commands and never for a
// label. The sizes are the desktop's scale moved up for a finger and an arm's length: its 13px rows and menus read
// at 15 to 16 here, its 12px headings and meta at 13, so every tier keeps its place. SF tracks itself by size, so
// only display sizes carry the desktop's slight negative tracking.
import { createContext, useContext, useSyncExternalStore } from "react";
import { Platform, useColorScheme, useWindowDimensions } from "react-native";

const dark = {
  /** Behind everything: the sidebar, the shell around the panel (--sidebar). */
  shell: "#09090a",
  /** The screen you read on (--background). */
  panel: "#121213",
  /** Cards on the panel: the approval, a run, a moment (--card). */
  card: "#1a1a1b",
  /** Menus, popovers and sheets (--popover): one step above a card. */
  popover: "#1b1c1d",
  /** One step up: the held or highlighted row, your own message (--accent). */
  raised: "#222224",
  /** A quiet filled control: a raised button, a track, a code chip (--secondary). */
  control: "#232325",
  /** A selected row in the sidebar (--sidebar-accent). */
  selected: "#232325",
  /** Every hairline (--border). */
  hairline: "#232426",
  /** The edge of a menu, popover or sheet: the field grey in dark, the hairline in light (menu.tsx menuSurface). */
  edge: "#2e2e31",
  /** A text field's edge, and a switch's track while off (--input). */
  field: "#2e2e31",
  /** Label tier: titles, menu labels, an unread or open chat (--foreground). */
  text: "#e3e4e6",
  /** Chat prose: the answer's body at 80% ink, so bold and headings stand out at full ink (ai/response.tsx). */
  prose: "#b9babc",
  /** Between label and description: a delegated agent's row, the model in a header (--secondary-foreground). */
  soft: "#cbcbcd",
  /** Description tier: one-line descriptions, read rows, a menu's headings (--muted-foreground, 6.3:1). */
  muted: "#959597",
  /** Tertiary tier: section headings, ages, hints, the quietest text that still reads (--subtle-foreground, 5.4:1). */
  subtle: "#8a8a8c",
  /** Done, verified, live (--success). Never decoration. */
  success: "#3fcf7b",
  /** Needs you: the amber dot, the amber count (--warning). */
  warning: "#f09c2d",
  /** Failed, and a destructive row (--destructive). */
  destructive: "#e36369",
  /** A piece of work or a chat named in running text (styles.css .work-link: the blue at 62% over ink). */
  link: "#7eabf3",
  /** The one chrome blue, "here" (--target): a live ring, a drop target, the agent's screen in use. Never a resting fill. */
  target: "#3c83f6",
  /** The monochrome primary (STYLE.md 3): a light fill with ink on it; the send button, the one white action. */
  primary: "#e3e4e6",
  onPrimary: "#121213",
  /** Lines added and removed, the "+12 −3" (--diff-add-ink, --diff-del-ink). Never a state. */
  added: "#6ee7b7",
  removed: "#fda4af",
  /** Effort past the ceiling (--effort-max red at Max, --effort-ultra purple at Ultracode): the level only. */
  effortMax: "#f55c5c",
  effortUltra: "#be8bf9",
  /** A speed past standard (--speed): the bolt, nothing else. */
  speed: "#f7c245",
  /** The blue tag (--tag-blue): the model picker's Default. */
  tag: "#202b3d",
  tagEdge: "#27354a",
  tagInk: "#c5dafb",
  /** The green tag (--tag-green): a sign-in that works ("Signed in"). */
  tagGreen: "#2b4422",
  tagGreenEdge: "#364f2d",
  tagGreenInk: "#bdeac8",
  /** The yellow tag (--tag-yellow): what isn't set up yet ("Not connected", "Not trusted"). */
  tagYellow: "#33301d",
  tagYellowEdge: "#59532e",
  tagYellowInk: "#f9e796",
  /** The purple tag (--tag-purple): a project's scope. */
  tagPurple: "#221f38",
  tagPurpleEdge: "#4a4378",
  tagPurpleInk: "#b6afe5",
  /** The sidebar's rows at rest (--sidebar-foreground): grey in dark, near-black in light; full ink when selected. */
  sidebarInk: "#929294",
  /** Where Liquid Glass isn't available: the popover's grey under the frost. */
  glass: "#1b1c1d",
  scrim: "#000000",
};

type Palette = Record<keyof typeof dark, string>;

const light: Palette = {
  shell: "#f5f5f5",
  panel: "#ffffff",
  card: "#ffffff",
  popover: "#ffffff",
  raised: "#f3f3f3",
  control: "#f0f0f0",
  selected: "#e7e7e7",
  hairline: "#e7e7e7",
  edge: "#e7e7e7",
  field: "#80838a",
  text: "#1f1f21",
  prose: "#4c4c4d",
  soft: "#3c3c3f",
  muted: "#5c5c5e",
  subtle: "#66686d",
  success: "#218349",
  warning: "#995b13",
  destructive: "#ca2b30",
  link: "#345c9e",
  target: "#3c83f6",
  primary: "#1f1f21",
  onPrimary: "#ffffff",
  added: "#047857",
  removed: "#be123c",
  effortMax: "#cc1e1e",
  effortUltra: "#7a36d3",
  speed: "#a26107",
  tag: "#eaf1fc",
  tagEdge: "#c5d5ee",
  tagInk: "#315682",
  tagGreen: "#e5efdf",
  tagGreenEdge: "#c3d7b8",
  tagGreenInk: "#365e2d",
  tagYellow: "#f6f0d7",
  tagYellowEdge: "#ddd09c",
  tagYellowInk: "#6d5915",
  tagPurple: "#eeeafa",
  tagPurpleEdge: "#cfc4e9",
  tagPurpleInk: "#66508d",
  sidebarInk: "#333333",
  glass: "#ffffff",
  scrim: "#000000",
};

/** The system face (fonts.css --font-inter): SF Pro on an iPhone and a Mac's browser, Roboto on Android. */
export const sans = Platform.select({
  ios: "System",
  android: "sans-serif",
  default: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif',
});
/** The system mono (fonts.css --font-jetbrains): SF Mono. Code, paths, branches, commands; never a label. */
export const mono = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: '"SF Mono", SFMono-Regular, ui-monospace, "Cascadia Mono", Menlo, Consolas, monospace',
});
/** Whole hundreds only: the deck never goes past 600 and never draws an in-between weight. */
export const weight = { regular: "400", medium: "500", semibold: "600" } as const;

const tabular = ["tabular-nums" as const];

function typeFor(c: Palette) {
  const face = { fontFamily: sans };
  return {
    /** A new chat's question (NewChat.tsx h1): 26 on 34, medium, -0.02em. */
    display: { ...face, fontSize: 26, lineHeight: 34, fontWeight: weight.medium, letterSpacing: -0.5, color: c.text },
    /**
     * The title a page opens on (Home's "Caveman", All agents, a workspace): 24, a quarter under iOS's 32 large title
 *, near native 22.
     */
    largeTitle: { ...face, fontSize: 24, lineHeight: 30, fontWeight: weight.semibold, letterSpacing: -0.3, color: c.text },
    /** A page's title inside a sheet, a name under its portrait (Settings' 20px title, a fifth smaller on the phone). */
    title: { ...face, fontSize: 18, lineHeight: 24, fontWeight: weight.semibold, letterSpacing: -0.2, color: c.text },
    /** A sheet's title, an empty state's title (EmptyState: 17 on 24 at 600). */
    heading: { ...face, fontSize: 17, lineHeight: 24, fontWeight: weight.semibold, color: c.text },
    /** A label that leads: a card's name, an unread or open chat, a chosen option. */
    label: { ...face, fontSize: 15, lineHeight: 20, fontWeight: weight.medium, color: c.text },
    /** A row's label in a list, a menu or the sidebar (the desktop's 13 to 14). Its description is the same size in `muted`. */
    row: { ...face, fontSize: 16, lineHeight: 22, fontWeight: weight.regular, color: c.text },
    /** Text you type and read plainly: the composer, a field. Full ink. */
    body: { ...face, fontSize: 16, lineHeight: 24, fontWeight: weight.regular, color: c.text },
    /** An answer's prose (ai/response.tsx: 14 on 24 at 80% ink): bold and headings go to full `text`. */
    prose: { ...face, fontSize: 16, lineHeight: 26, fontWeight: weight.regular, color: c.prose },
    /** A description under a row, a card's second line. */
    small: { ...face, fontSize: 13, lineHeight: 18, fontWeight: weight.regular, color: c.muted },
    /** Ages, times and counts beside meta: tertiary, tabular. */
    meta: { ...face, fontSize: 13, lineHeight: 18, fontWeight: weight.regular, color: c.subtle, fontVariant: tabular },
    /** The sidebar's section headings ("Chiefs", "Projects"): 12px at 500 in the tertiary grey on the desktop. */
    section: { ...face, fontSize: 13, lineHeight: 18, fontWeight: weight.medium, color: c.subtle },
    /** A menu's or a sheet's group heading ("Add", "Plugins and Spaces"): 12px regular grey on the desktop. */
    group: { ...face, fontSize: 13, lineHeight: 18, fontWeight: weight.regular, color: c.muted },
    /** Counts, tags and other micro type (the desktop's 11px). */
    micro: { ...face, fontSize: 12, lineHeight: 16, fontWeight: weight.medium, color: c.muted, fontVariant: tabular },
    /** A button's words (the desktop's 13px at 500). Colour comes from the button. */
    button: { ...face, fontSize: 15, lineHeight: 20, fontWeight: weight.medium },
    /** A step's detail in mono: a command, a path. */
    line: { fontFamily: mono, fontSize: 12, lineHeight: 17, color: c.subtle },
    /** Code blocks and logs (the desktop's 12 on 20). */
    code: { fontFamily: mono, fontSize: 13, lineHeight: 20, color: c.text },
  };
}

const THEMES = {
  dark: { c: dark as Palette, t: typeFor(dark), dark: true, scheme: "dark" as const },
  light: { c: light, t: typeFor(light), dark: false, scheme: "light" as const },
};

export type Theme = (typeof THEMES)["dark"] | (typeof THEMES)["light"];
export type Colors = Palette;
export type Appearance = "system" | "light" | "dark";

/**
 * Corners, on the desktop's scale: rows rounded-md to -lg (6 to 8), controls rounded-lg (8 on a 32px button), cards
 * rounded-xl (12), menus 12 around 6px of padding so their rows sit concentric. A phone's controls are 44 tall, so
 * they round 10 to keep the desktop's proportion; a menu rounds 14 around its 8-round rows; a sheet keeps the
 * system's large top corners.
 */
export const radius = { row: 8, control: 10, card: 12, menu: 14, bubble: 16, sheet: 28 } as const;

/** A hairline, as thin as the screen draws one. */
export const hairline = 1;

/**
 * How far type on floating chrome (the bar's capsule, the status capsule, chips, the strip, the toast) follows Dynamic
 * Type: it sits in a 44 pt shape that doesn't grow, so past 1.3 it holds, and a long press shows it large (iOS's Large
 * Content Viewer) instead.
 */
export const FLOAT_TYPE = 1.3;

/** The smallest a finger can hit (STYLE.md 12; the phone's rule is Apple's 44). */
export const touch = 44;

/**
 * The phone's layout, measured off the apps the founder pointed at (Cursor, Grok and Claude on iOS 26) and settled by
 * the 2026-11-06 review panel (docs/). One size for everything that floats, so
 * nothing sits between two sizes: the bar's circles, the status capsule, the jump circle, a sheet's X and the
 * composer's buttons are all 44.
 */
export const layout = {
  /** Glass controls, tiles, the composer and a sheet's content sit this far in from the screen's edge. */
  inset: 16,
  /** Every circle and capsule that floats over content. */
  float: 44,
  /** Between floating neighbours (the bar's two circles, the capsule and the jump circle). */
  floatGap: 8,
  /** The composer at rest: a glass capsule this tall, 8 above the home indicator's safe area. */
  composer: 56,
  /** The composer's corner, at rest and grown into its card. */
  composerRadius: 28,
  /** The floating row (status capsule, jump circle) sits this far above the composer. */
  rowAbove: 10,
  /** The progressive blur and dim under the top bar, and under the composer. */
  fadeTop: 120,
  fadeBottom: 96,
  /** A flat card's corner (New Chief's character card, a computer's card atop its chats), never glass. */
  tile: { radius: 16 },
  /** Row heights: a Chief's character row, a two-line row (chats, workspaces, devices), a one-line row, a sheet's row. */
  row: { chief: 68, double: 60, single: 54, sheet: 50 },
  /** A large sheet's corner; a medium sheet floats this far from the screen's edges. */
  sheet: { radius: 38, float: 8 },
} as const;

/**
 * The one glass everything floating wears (DECISIONS.md, "one material"): the bar's circles, the title and status
 * capsules, the jump circle, the queued card and the chat bar. Where the system has Liquid Glass it draws its own;
 * elsewhere this frost: the page blurred 22 and lifted in colour, a grey fill over it, and a hairline edge. With
 * Reduce Transparency or Increase Contrast on, it is the opaque `solid` grey with the `solidEdge`.
 */
export const glass = {
  float: {
    blur: 22,
    saturate: 1.8,
    fill: { dark: "rgba(44,44,47,0.62)", light: "rgba(250,250,252,0.72)" },
    edge: { dark: "rgba(255,255,255,0.07)", light: "rgba(0,0,0,0.06)" },
    solid: { dark: "#1c1c1e", light: "#ffffff" },
    solidEdge: { dark: "#2e2e31", light: "#d9d9dc" },
  },
} as const;

/**
 * A chat's rhythm, in points (DECISIONS.md "Rhythm"). The calm comes from these gaps, not from headers: a big gap after
 * your message, small gaps inside the agent's turn, a big gap after its final answer.
 */
export const rhythm = {
  /** Your bubble to the turn's first line ("Worked for", or the first words while it runs). */
  bubbleToTurn: 28,
  /** "Worked for 2m 38s ›" to the final answer. */
  turnToAnswer: 14,
  /** Inside an open turn: a part's header to its prose, prose to the next header, paragraph to paragraph, list items. */
  headerToProse: 4,
  proseToHeader: 12,
  paragraph: 12,
  listItem: 6,
  /** The final answer to its Changes pill, and the pill to the action row. */
  answerToChanges: 16,
  changesToActions: 12,
  /** A steer: room above its bubble, its "Steered at 1m 30s" caption, room to the work that follows. */
  steerAbove: 20,
  steerCaption: 6,
  steerBelow: 20,
  /** The end of one turn to the next bubble. */
  turnGap: 40,
  /** A date line between messages more than 30 minutes apart: above and below it, in place of `turnGap`. */
  dateAbove: 32,
  dateBelow: 16,
} as const;

export const AppearanceContext = createContext<{ appearance: Appearance; setAppearance: (next: Appearance) => void }>({
  appearance: "system",
  setAppearance: () => {},
});

export function useTheme(): Theme {
  const system = useColorScheme();
  const { appearance } = useContext(AppearanceContext);
  const scheme = appearance === "system" ? (system === "light" ? "light" : "dark") : appearance;
  const forced = useSyncExternalStore(watchScale, readScale, readScale);
  return forced && Platform.OS === "web" ? scaledTheme(scheme, forced) : THEMES[scheme];
}

// ---------------------------------------------------------------- text size, forced (development, the web build)

// A phone scales its text itself (Dynamic Type) and reports the scale in `useWindowDimensions().fontScale`; the web
// build has neither, so in development `__cc.ui.fontScale(1.35)` (or `__cc.fontScale`) stands in: the type styles
// grow by it on the web, and every reader of the scale (`useFontScale`: the tiles, the Chief rows, the bar's capsule,
// the box) sees it on every platform. `null` gives the scale back to the system.
let forcedScale: number | null = null;
const scaleHearers = new Set<() => void>();
const watchScale = (hear: () => void) => {
  scaleHearers.add(hear);
  return () => void scaleHearers.delete(hear);
};
const readScale = () => forcedScale;

/** Forces the text size (development): 1.35 is AX1-ish, 2.0 the largest accessibility sizes; null lets the system say. */
export function setFontScale(scale: number | null) {
  forcedScale = scale && scale > 0 ? scale : null;
  // A phone grows each line's height with its text; on the web a style that pins a line height under a grown size
  // would overlap its lines, so while the size is forced every line takes its font's own height.
  if (Platform.OS === "web" && typeof document !== "undefined") {
    let rule = document.getElementById("cc-font-scale");
    if (forcedScale && !rule) {
      rule = document.createElement("style");
      rule.id = "cc-font-scale";
      rule.textContent = 'div[dir="auto"],span[dir="auto"]{line-height:normal !important}';
      document.head.appendChild(rule);
    } else if (!forcedScale) rule?.remove();
  }
  for (const hear of scaleHearers) hear();
}

/** The text size the screen is drawn at: the forced one in development, else the system's. */
export function useFontScale(): number {
  const { fontScale } = useWindowDimensions();
  const forced = useSyncExternalStore(watchScale, readScale, readScale);
  return forced ?? fontScale;
}

const scaledThemes = new Map<string, Theme>();
/** A theme whose type styles are `k` times the size, for the web build's forced text size. */
function scaledTheme(scheme: "dark" | "light", k: number): Theme {
  const key = `${scheme}:${k}`;
  const was = scaledThemes.get(key);
  if (was) return was;
  const base = THEMES[scheme];
  const t = Object.fromEntries(
    Object.entries(base.t).map(([name, style]) => {
      const s = style as { fontSize?: number; lineHeight?: number };
      return [name, typeof s.fontSize === "number" ? { ...s, fontSize: Math.round(s.fontSize * k), ...(typeof s.lineHeight === "number" ? { lineHeight: Math.round(s.lineHeight * k) } : null) } : style];
    }),
  ) as typeof base.t;
  const theme = { ...base, t } as Theme;
  scaledThemes.set(key, theme);
  return theme;
}

if (typeof __DEV__ !== "undefined" && __DEV__) {
  const g = globalThis as { __cc?: Record<string, unknown> };
  g.__cc = { ...g.__cc, fontScale: setFontScale };
}

/** A hex colour at some opacity, for washes and gradients that fade a surface into nothing. */
export function alpha(hex: string, a: number) {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * The deck's overlay shadow (--shadow-overlay) for a menu or popover: minimal soft layers in dark, one soft drop in
 * light. React Native draws one shadow, so this is their sum.
 */
export function overlayShadow(isDark: boolean) {
  return { shadowColor: "#000", shadowOpacity: isDark ? 0.45 : 0.14, shadowRadius: isDark ? 24 : 18, shadowOffset: { width: 0, height: isDark ? 8 : 10 }, elevation: 12 } as const;
}
