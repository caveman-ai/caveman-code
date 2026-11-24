import { readFileSync } from "node:fs";
import { describe, expect, it, vi, afterEach } from "vitest";
import { getWallpaperPick, getWallpaperSnapshot, setWallpaper } from "../wallpaper/store.ts";
import { applyAppearance, settingsAppearance } from "./appearance.ts";
import { allThemes, findTheme, themeHalf } from "./themes.ts";
import { WALLPAPERS, WALLPAPER_CREDIT } from "./wallpaper-catalog.ts";
import {
  featuredThemes,
  filterThemeGallery,
  orderedGalleryThemes,
} from "../routes/settings/theme-gallery-model.ts";

afterEach(() => vi.unstubAllGlobals());

describe("wallpaper themes", () => {
  it("bundles small previews while keeping all 55 credited originals in the separately published pack", () => {
    expect(WALLPAPERS).toHaveLength(55);
    expect(new Set(WALLPAPERS.map((art) => art.id)).size).toBe(55);
    expect(WALLPAPER_CREDIT.author).toBe("Ahmed Hassan");
    expect(WALLPAPER_CREDIT.licenseUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    for (const art of WALLPAPERS) {
      expect(art.image).toMatch(/^https:\/\/download\.caveman\.so\/code\/wallpapers\/v1\//);
      expect(art.credit.author).toBeTruthy();
      expect(art.credit.licenseUrl).toMatch(/^https:\/\//);
      for (const url of [
        new URL(`../../../../wallpapers/images/${art.image.split("/").at(-1)}`, import.meta.url)
          .href,
        art.thumbnail,
      ]) {
        const bytes = readFileSync(new URL(url));
        expect(bytes.toString("ascii", 0, 4), art.slug).toBe("RIFF");
        expect(bytes.toString("ascii", 8, 12), art.slug).toBe("WEBP");
      }
      const theme = findTheme(art.id);
      expect(theme.wallpaper).toBe(art);
      expect(themeHalf(theme, "light").appearance).toBe("light");
      expect(themeHalf(theme, "dark").appearance).toBe("dark");
    }
  });

  it("follows synced artwork while matching, retains it for color-only themes, and respects manual pictures", () => {
    const props = new Map<string, string>();
    const html = {
      classList: { toggle: vi.fn() },
      dataset: {} as Record<string, string>,
      style: {
        setProperty: (key: string, value: string) => props.set(key, value),
        removeProperty: (key: string) => props.delete(key),
      },
    };
    vi.stubGlobal("document", { documentElement: html });
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const id = "super-visuals-dune-above-blue-sea";
    setWallpaper({ source: "theme" });
    applyAppearance({ color_theme: id, theme: "dark" });
    expect(getWallpaperSnapshot().source).toBe(id);
    const dark = props.get("--background");
    applyAppearance({ color_theme: id, theme: "light" });
    expect(props.get("--background")).not.toBe(dark);
    expect(getWallpaperSnapshot().source).toBe(id);
    expect(getWallpaperPick().source).toBe("theme");
    // An explicit picture remains this device's when colors sync or the mode changes.
    setWallpaper({ source: "mist" });
    applyAppearance({ color_theme: "super-visuals-mint-drift" });
    expect(getWallpaperSnapshot().source).toBe("mist");
    setWallpaper({ source: "theme" });
    expect(getWallpaperSnapshot().source).toBe("super-visuals-mint-drift");
    applyAppearance({ color_theme: "github" });
    expect(getWallpaperSnapshot().source).toBe("super-visuals-mint-drift");
    expect(getWallpaperPick().matchTheme).toBe(true);
    applyAppearance({ color_theme: id });
    expect(getWallpaperSnapshot().source).toBe(id);
    applyAppearance({ color_theme: "removed-theme" });
    expect(getWallpaperSnapshot().source).toBe(id);
    applyAppearance({ color_theme: "super-visuals-mint-drift" });
    expect(getWallpaperSnapshot().source).toBe("super-visuals-mint-drift");
    setWallpaper({ source: id });
    applyAppearance({ color_theme: "github" });
    applyAppearance({ color_theme: "super-visuals-mint-drift" });
    expect(getWallpaperSnapshot().source).toBe(id);
    // The existing persisted field is enough: no separate wallpaper preference can drift from its palette.
    expect(
      settingsAppearance({ theme: "dark", color_theme: id } as Parameters<
        typeof settingsAppearance
      >[0]).color_theme,
    ).toBe(id);
  });
});

describe("theme gallery", () => {
  const themes = allThemes([
    { id: "custom:mine", name: "My violet", dark: findTheme("nord").dark! },
  ]);
  it("searches styles, names and credits, and separates wallpaper and color-only themes", () => {
    expect(filterThemeGallery(themes, "AHMED pastel", "all").length).toBeGreaterThan(0);
    expect(filterThemeGallery(themes, "", "wallpapers")).toHaveLength(55);
    expect(
      filterThemeGallery(themes, "abstract blue", "wallpapers").map((theme) => theme.id),
    ).toContain("super-visuals-midnight-currents");
    expect(filterThemeGallery(themes, "pixel art", "wallpapers").map((theme) => theme.id)).toEqual([
      "super-visuals-pixel-river-valley",
    ]);
    expect(filterThemeGallery(themes, "", "colors").every((theme) => !theme.wallpaper)).toBe(true);
    expect(filterThemeGallery(themes, "violet", "colors").map((theme) => theme.id)).toContain(
      "custom:mine",
    );
    const natural = filterThemeGallery(themes, "", "wallpapers", "Natural landscapes");
    expect(natural).toHaveLength(8);
    expect(filterThemeGallery(themes, "no such theme", "all")).toHaveLength(0);
  });

  it("shows varied wallpapers first in a stable order, keeping every theme once", () => {
    const ordered = orderedGalleryThemes(themes);
    expect(ordered).toHaveLength(themes.length);
    expect(new Set(ordered.map((theme) => theme.id)).size).toBe(themes.length);
    expect(new Set(ordered.slice(0, 6).map((theme) => theme.wallpaper?.category)).size).toBe(6);
    expect(ordered.slice(55).every((theme) => !theme.wallpaper)).toBe(true);
  });

  it("finds darker artwork across styles without including bright wallpapers or color-only themes", () => {
    const dark = filterThemeGallery(themes, "", "all", "All styles", true);
    expect(dark.length).toBeGreaterThanOrEqual(20);
    expect(dark.every((theme) => theme.wallpaper?.dark)).toBe(true);
    expect(dark.map((theme) => theme.id)).toContain("night-atmospheric-glow");
    expect(dark.map((theme) => theme.id)).not.toContain("super-visuals-mint-drift");
  });

  it("can advance through every shelf theme without selection-dependent reordering", () => {
    const expected = featuredThemes(themes, "caveman").map((theme) => theme.id);
    let selected = "caveman";
    const visited = [];
    for (let step = 0; step < expected.length; step++) {
      const shelf = featuredThemes(themes, selected).map((theme) => theme.id);
      expect(shelf).toEqual(expected);
      selected = shelf[(shelf.indexOf(selected) + 1) % shelf.length]!;
      visited.push(selected);
    }
    expect(new Set(visited).size).toBe(expected.length);
  });

  it("keeps any active theme visible in the small shelf without duplicates", () => {
    for (const selected of ["nord", "custom:mine", "super-visuals-ember-doorway", "caveman"]) {
      const featured = featuredThemes(themes, selected);
      expect(featured).toHaveLength(6);
      expect(featured.some((theme) => theme.id === selected)).toBe(true);
      expect(new Set(featured.map((theme) => theme.id)).size).toBe(6);
    }
  });
});
