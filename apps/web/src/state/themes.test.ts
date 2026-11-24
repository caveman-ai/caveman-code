import { describe, expect, it } from "vitest";
import { hslToHex } from "../panels/terminal/theme.ts";
import { BUILT_IN_THEMES, CAVEMAN_THEME_ID, THEME_TOKEN_NAMES, contrast, ensureContrast, findTheme, hexToHslTriple, themeHalf, themeTokens } from "./themes.ts";

const HEX = /^#[0-9a-f]{6}$/;

describe("built-in themes", () => {
  it("have unique ids, Caveman first, and every other theme at least one palette of #rrggbb colours", () => {
    expect(BUILT_IN_THEMES[0]!.id).toBe(CAVEMAN_THEME_ID);
    expect(new Set(BUILT_IN_THEMES.map((t) => t.id)).size).toBe(BUILT_IN_THEMES.length);
    for (const t of BUILT_IN_THEMES.slice(1)) {
      expect(t.dark ?? t.light, t.id).toBeDefined();
      for (const p of [t.dark, t.light]) for (const [k, v] of Object.entries(p ?? {})) expect(v, `${t.id}.${k}`).toMatch(HEX);
    }
  });

  it("read: body text 7:1, secondary text 4.5:1 and state colours 3:1 on the panel", () => {
    for (const t of BUILT_IN_THEMES) {
      for (const side of ["dark", "light"] as const) {
        const p = t[side];
        if (!p) continue;
        const tokens = themeTokens(p, side);
        const hex = (name: string) => hslToHex(tokens[`--${name}`]!);
        const at = `${t.id} ${side}`;
        expect(Object.keys(tokens).sort(), at).toEqual([...THEME_TOKEN_NAMES].sort());
        // hsl triples round to 0.1, so allow a hair under each bar.
        expect(contrast(hex("foreground"), hex("background")), at).toBeGreaterThan(6.9);
        expect(contrast(hex("muted-foreground"), hex("background")), at).toBeGreaterThan(4.4);
        for (const s of ["destructive", "success", "warning", "info", "primary"]) expect(contrast(hex(s), hex("background")), `${at} ${s}`).toBeGreaterThan(2.9);
        expect(contrast(hex("primary-foreground"), hex("primary")), `${at} on primary`).toBeGreaterThan(3);
        // The effort chip's red and purple text, on the composer card, the popover and its hover fill.
        for (const tier of ["effort-max", "effort-ultra", "speed"]) for (const on of ["card", "popover", "accent"]) expect(contrast(hex(tier), hex(on)), `${at} ${tier} on ${on}`).toBeGreaterThan(4.4);
      }
    }
  });
});

describe("theme helpers", () => {
  it("round-trips hex through the deck's H S% L% triples", () => {
    for (const hex of ["#1e1e2e", "#eff1f5", "#ff79c6", "#000000", "#ffffff"]) expect(hslToHex(hexToHslTriple(hex))).toBe(hex);
  });

  it("lifts a faint colour to the contrast asked for, and leaves a readable one alone", () => {
    expect(ensureContrast("#ffffff", "#000000", 7)).toBe("#ffffff");
    const lifted = ensureContrast("#6272a4", "#282a36", 4.5);
    expect(contrast(lifted, "#282a36")).toBeGreaterThanOrEqual(4.5);
  });

  it("falls back to Caveman for unknown ids, and a one-sided theme wears its side", () => {
    expect(findTheme("nope").id).toBe(CAVEMAN_THEME_ID);
    expect(findTheme(undefined).id).toBe(CAVEMAN_THEME_ID);
    expect(themeHalf(findTheme("monokai"), "light").appearance).toBe("dark");
    expect(themeHalf(findTheme("catppuccin-mocha"), "light").palette?.panel).toBe("#eff1f5");
    expect(themeHalf(findTheme(CAVEMAN_THEME_ID), "light")).toEqual({ appearance: "light", palette: null });
    const custom = { id: "custom:x", name: "X", light: findTheme("github").light! };
    expect(findTheme("custom:x", [custom]).name).toBe("X");
  });
});
