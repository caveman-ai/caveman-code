// Settings > Appearance on the page: light/dark, colour theme, text size, code
// font and density from the runtime's Settings. The last applied values are
// kept on this device too, so the next start paints in them before the
// runtime answers.
import { setWallpaperTheme } from "../wallpaper/store.ts";
import type { Settings } from "@caveman-app/session-protocol";
import { useEffect } from "react";
import { useRuntimeSelector } from "./runtime.tsx";
import { THEME_TOKEN_NAMES, findTheme, onlyAppearance, themeHalf, themeTokens } from "./themes.ts";

export type Appearance = { [K in "theme" | "color_theme" | "custom_themes" | "text_size" | "mono_font" | "density"]?: Settings[K] | undefined };

const KEY = "caveman.appearance";

/** Root font size: every text size (rem, via the build's px-to-rem pass) scales from it. */
export const TEXT_SIZE_PX: Readonly<Record<NonNullable<Settings["text_size"]>, number>> = { small: 15, default: 16, large: 18, larger: 20 };

/** Code font stacks. The default is the system's (fonts.css: SF Mono on a Mac); JetBrains Mono ships with the app. */
export const MONO_FONTS: Readonly<Record<NonNullable<Settings["mono_font"]>, { label: string; stack: string | null }>> = {
 // Concrete names before ui-monospace: an engine that does not know the keyword can take it for the proportional UI font (upstream order).
  sf_mono: { label: "SF Mono", stack: null },
  jetbrains_mono: { label: "JetBrains Mono", stack: '"JetBrains Mono Variable", "JetBrains Mono", ui-monospace, Menlo, monospace' },
  menlo: { label: "Menlo", stack: "Menlo, Monaco, monospace" },
};

const prefersDark = () => typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;

export function applyAppearance(a: Appearance): void {
  const html = document.documentElement;
  const wanted = a.theme === "light" ? "light" : a.theme === "dark" ? "dark" : prefersDark() ? "dark" : "light";
  // A one-sided theme (Monokai) wears its own side whatever the mode asks.
  const theme = findTheme(a.color_theme, a.custom_themes);
  const { appearance, palette } = themeHalf(theme, wanted);
  const dark = appearance === "dark";
  html.classList.toggle("dark", dark);
  html.style.colorScheme = dark ? "dark" : "light";
  for (const name of THEME_TOKEN_NAMES) html.style.removeProperty(name);
  if (palette) {
    for (const [name, value] of Object.entries(themeTokens(palette, appearance))) html.style.setProperty(name, value);
    html.dataset.theme = a.color_theme;
  } else delete html.dataset.theme;
  setWallpaperTheme(theme.wallpaper ? theme.id : null);
  // Never derived from the media query: a forced side flips prefers-color-scheme, and System would flip it back, forever.
  if (typeof window !== "undefined") window.cavemanDesktop?.setTheme?.(onlyAppearance(theme) ?? a.theme ?? "system");
  const px = TEXT_SIZE_PX[a.text_size ?? "default"];
  if (px === 16) html.style.removeProperty("font-size");
  else html.style.fontSize = `${px}px`;
  const stack = MONO_FONTS[a.mono_font ?? "sf_mono"].stack;
  if (stack === null) html.style.removeProperty("--font-jetbrains");
  else html.style.setProperty("--font-jetbrains", stack);
  if (a.density === "compact") html.dataset.density = "compact";
  else delete html.dataset.density;
  // A phone's status bar and a browser's toolbar wear the page's colour (index.html's theme-color).
  const meta = document.querySelector?.('meta[name="theme-color"]');
  const background = meta && getComputedStyle(html).getPropertyValue("--background").trim();
  if (meta && background) meta.setAttribute("content", `hsl(${background})`);
}

/** What this device showed last; System theme when nothing is kept. */
export function cachedAppearance(): Appearance {
  try {
    const a = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Appearance;
    // A theme another build wrote may lack a colour: find out here, not in the first paint.
    for (const t of a.custom_themes ?? []) for (const half of [t.dark, t.light]) if (half) themeTokens(half, "dark");
    return a;
  } catch {
    localStorage.removeItem(KEY);
    return {};
  }
}

/** The appearance half of Settings. Only the chosen custom theme rides along: it is all a paint needs. */
export function settingsAppearance(settings: Settings): Appearance {
  return {
    theme: settings.theme,
    color_theme: settings.color_theme,
    custom_themes: settings.custom_themes?.filter((t) => t.id === settings.color_theme),
    text_size: settings.text_size,
    mono_font: settings.mono_font,
    density: settings.density,
  };
}

/** Keeps the page on the runtime's Settings, and System theme on the OS's. */
export function AppearanceSync(): null {
  const settings = useRuntimeSelector((v) => v.settings);
  const a: Appearance | null = settings && settingsAppearance(settings);
  const key = JSON.stringify(a);
  useEffect(() => {
    if (a === null) return;
    applyAppearance(a);
    localStorage.setItem(KEY, key);
    if (a.theme !== "system" || typeof matchMedia !== "function") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    const follow = () => applyAppearance(a);
    media.addEventListener("change", follow);
    return () => media.removeEventListener("change", follow);
  }, [key]);
  return null;
}
