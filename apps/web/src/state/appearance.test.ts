import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAppearance, MONO_FONTS } from "./appearance.ts";
import { findTheme, hexToHslTriple } from "./themes.ts";

/** Just the parts of <html> applyAppearance touches. */
function fakeHtml() {
  const classes = new Set<string>(["dark"]);
  const props = new Map<string, string>();
  const html = {
    classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) },
    style: {
      colorScheme: "",
      fontSize: "",
      setProperty: (name: string, value: string) => props.set(name, value),
      removeProperty: (name: string) => (name === "font-size" ? (html.style.fontSize = "") : props.delete(name)),
    },
    dataset: {} as Record<string, string>,
  };
  vi.stubGlobal("document", { documentElement: html });
  return { html, classes, props };
}

afterEach(() => vi.unstubAllGlobals());

describe("MONO_FONTS", () => {
  it("names every concrete face before a generic keyword, and ends on monospace", () => {
    for (const { stack } of Object.values(MONO_FONTS)) {
      if (stack === null) continue;
      const families = stack.split(",").map((f) => f.trim());
      const firstGeneric = families.findIndex((f) => /^(ui-monospace|monospace)$/.test(f));
      expect(families.slice(firstGeneric).every((f) => !/^"?SF Mono"?$|^SFMono-Regular$/.test(f)), stack).toBe(true);
      expect(families.at(-1)).toBe("monospace");
    }
  });
});

describe("applyAppearance", () => {
  it("applies theme, text size, code font and density, and undoes them back to the defaults", () => {
    const { html, classes, props } = fakeHtml();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
 // SF Mono is the default now (fonts.css, ); JetBrains Mono is the one a person picks.
    applyAppearance({ theme: "light", text_size: "larger", mono_font: "jetbrains_mono", density: "compact" });
    expect(classes.has("dark")).toBe(false);
    expect(html.style.colorScheme).toBe("light");
    expect(html.style.fontSize).toBe("20px");
    expect(props.get("--font-jetbrains")).toContain("JetBrains Mono");
    expect(html.dataset.density).toBe("compact");

    applyAppearance({ theme: "dark" });
    expect(classes.has("dark")).toBe(true);
    expect(html.style.fontSize).toBe("");
    expect(props.has("--font-jetbrains")).toBe(false);
    expect(html.dataset.density).toBeUndefined();
  });

  it("spreads a colour theme over the deck tokens, wears a one-sided theme's side, and clears it all for Caveman", () => {
    const { html, classes, props } = fakeHtml();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    applyAppearance({ theme: "light", color_theme: "catppuccin-mocha" });
    expect(classes.has("dark")).toBe(false);
    expect(props.get("--background")).toBe(hexToHslTriple("#eff1f5"));
    expect(html.dataset.theme).toBe("catppuccin-mocha");

    applyAppearance({ theme: "light", color_theme: "monokai" });
    expect(classes.has("dark")).toBe(true);
    expect(props.get("--background")).toBe(hexToHslTriple("#272822"));

    applyAppearance({ theme: "dark", color_theme: "custom:mine", custom_themes: [{ id: "custom:mine", name: "Mine", dark: findTheme("nord").dark! }] });
    expect(props.get("--background")).toBe(hexToHslTriple("#2e3440"));

    // The desktop is told the theme's own side, never one read back from prefers-color-scheme (that would loop).
    const setTheme = vi.fn();
    vi.stubGlobal("window", { cavemanDesktop: { setTheme } });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    applyAppearance({ theme: "system", color_theme: "monokai" });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    applyAppearance({ theme: "system", color_theme: "monokai" });
    applyAppearance({ theme: "system", color_theme: "nord" });
    expect(setTheme.mock.calls).toEqual([["dark"], ["dark"], ["system"]]);

    applyAppearance({ theme: "dark", color_theme: "caveman" });
    expect([...props.keys()].filter((k) => k !== "--font-jetbrains")).toEqual([]);
    expect(html.dataset.theme).toBeUndefined();
  });

  it("follows the OS for System", () => {
    const { classes } = fakeHtml();
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    applyAppearance({ theme: "system" });
    expect(classes.has("dark")).toBe(true);
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    applyAppearance({});
    expect(classes.has("dark")).toBe(false);
  });
});
