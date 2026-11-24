// The terminal wears the deck: every colour is a globals.css token, read at
// runtime (tokens are "H S% L%" triples; xterm takes hex). ANSI colours map
// onto the state and chart tokens, so `ls`, test runners and prompts match
// the rest of the app instead of xterm's stock palette.

import type { ITheme } from "@xterm/xterm";

/** "240 2.7% 7.3%" -> "#121213". */
export function hslToHex(triple: string): string {
  const [h = 0, s = 0, l = 0] = triple.trim().split(/[\s,%]+/).map(Number);
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

export function deckTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement);
  const t = (name: string) => hslToHex(styles.getPropertyValue(`--${name}`));
  // On the light deck, ANSI black is ink and white a mid grey: the dark mapping would print near-white on white.
  const light = !document.documentElement.classList.contains("dark");
  return {
    background: t("background"),
    foreground: t("foreground"),
    cursor: t("foreground"),
    cursorAccent: t("background"),
    // 20% foreground: a selection that reads on the panel without hiding the text.
    selectionBackground: `${t("foreground")}33`,
    black: light ? t("foreground") : t("secondary"),
    brightBlack: t("muted-foreground"),
    red: t("destructive"),
    brightRed: t("destructive"),
    green: t("success"),
    brightGreen: t("success"),
    yellow: t("warning"),
    brightYellow: t("warning"),
    blue: t("chart-1"),
    brightBlue: t("chart-line"),
    magenta: t("chart-4"),
    brightMagenta: t("chart-5"),
    cyan: t("chart-tone-2"),
    brightCyan: t("chart-tone-2"),
    white: light ? t("muted-foreground") : t("secondary-foreground"),
    brightWhite: light ? t("secondary-foreground") : t("foreground"),
  };
}
