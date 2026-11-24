import type { Settings } from "@caveman-app/session-protocol";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { goToActions } from "../shell/goto-actions.ts";
import {
  getWallpaperPick,
  getWallpaperSnapshot,
  resetWallpaper,
  setWallpaper,
  setWallpaperMatchingTheme,
} from "../wallpaper/store.ts";
import { previewThemeSelection } from "./theme-selection.ts";

const base = { theme: "dark", color_theme: "caveman" } as Settings;

beforeEach(() => {
  vi.stubGlobal("document", {
    documentElement: {
      classList: { toggle: vi.fn() },
      dataset: {},
      style: { setProperty: vi.fn(), removeProperty: vi.fn() },
    },
  });
  setWallpaper({ source: "mist", effect: "glass", blur: 8, dim: 15, matchTheme: true });
});
afterEach(() => vi.unstubAllGlobals());

test("a command-palette theme pick selects its wallpaper and a failed save restores the earlier picture and dials", () => {
  const action = goToActions("Mint Drift", base, false, "").find(
    (candidate) => "settings" in candidate.act,
  );
  if (!action || !("settings" in action.act)) throw new Error("Missing theme action");
  const previous = getWallpaperPick();
  const { rollback } = previewThemeSelection(base, action.act.settings);
  expect(getWallpaperSnapshot().source).toBe("super-visuals-mint-drift");
  expect(getWallpaperPick()).toMatchObject({ source: "theme", effect: "none", blur: 0, dim: 0 });
  rollback(base);
  expect(getWallpaperPick()).toEqual(previous);
  expect(getWallpaperSnapshot().source).toBe("mist");
});

test("failure leaves a newer manual wallpaper or dial change alone", () => {
  const { rollback } = previewThemeSelection(base, { color_theme: "super-visuals-mint-drift" });
  setWallpaper({ source: "none", blur: 12 });
  rollback(base);
  expect(getWallpaperPick()).toMatchObject({ source: "none", blur: 12 });
});

test("an earlier failed pick cannot undo a later selection from another surface", () => {
  const earlier = previewThemeSelection(base, { color_theme: "super-visuals-mint-drift" });
  previewThemeSelection(base, { color_theme: "super-visuals-dune-above-blue-sea" });
  earlier.rollback(base);
  expect(getWallpaperSnapshot().source).toBe("super-visuals-dune-above-blue-sea");
});

test.each([false, true])(
  "failed rapid picks restore the original manual wallpaper (reverse answers: %s)",
  (reverse) => {
    const previous = getWallpaperPick();
    const first = previewThemeSelection(base, { color_theme: "super-visuals-mint-drift" });
    const second = previewThemeSelection(base, {
      color_theme: "super-visuals-dune-above-blue-sea",
    });
    const attempts = reverse ? [second, first] : [first, second];
    for (const attempt of attempts) attempt.rollback(base);
    expect(getWallpaperPick()).toEqual(previous);
  },
);

test("a failed later pick restores the last successful picture, even if its answer arrived later", () => {
  const first = previewThemeSelection(base, { color_theme: "super-visuals-mint-drift" });
  const second = previewThemeSelection(base, { color_theme: "super-visuals-dune-above-blue-sea" });
  second.rollback({ ...base, color_theme: "super-visuals-mint-drift" });
  first.commit();
  expect(getWallpaperSnapshot().source).toBe("super-visuals-mint-drift");
  expect(getWallpaperPick().source).toBe("theme");
});

test.each(["super-visuals-mint-drift", "mist", "none"])(
  "manual picture %s survives theme picks from either surface",
  (source) => {
    setWallpaper({ source, effect: "glass", blur: 8 });
    const before = getWallpaperPick();
    const selection = previewThemeSelection(base, {
      color_theme: "super-visuals-dune-above-blue-sea",
    });
    selection.commit();
    expect(getWallpaperPick()).toEqual(before);
    expect(getWallpaperSnapshot().source).toBe(source);
  },
);

test("unlinking freezes the image; reset and later theme picks cannot relink it", () => {
  previewThemeSelection(base, { color_theme: "super-visuals-mint-drift" }).commit();
  setWallpaper({ blur: 8 });
  setWallpaperMatchingTheme(false);
  expect(getWallpaperPick()).toMatchObject({
    source: "super-visuals-mint-drift",
    matchTheme: false,
    blur: 8,
  });
  resetWallpaper();
  previewThemeSelection(base, { color_theme: "super-visuals-dune-above-blue-sea" }).commit();
  expect(getWallpaperSnapshot().source).toBe("super-visuals-mint-drift");
  expect(getWallpaperPick().matchTheme).toBe(false);
  setWallpaper({ blur: 8 });
  setWallpaperMatchingTheme(true);
  expect(getWallpaperSnapshot()).toMatchObject({
    source: "super-visuals-dune-above-blue-sea",
    matchTheme: true,
    blur: 8,
  });
});

test("a color-only theme retains the previous matching image, and the next wallpaper theme follows again", () => {
  previewThemeSelection(base, { color_theme: "super-visuals-mint-drift" }).commit();
  previewThemeSelection(base, { color_theme: "github" }).commit();
  expect(getWallpaperSnapshot()).toMatchObject({
    source: "super-visuals-mint-drift",
    matchTheme: true,
  });
  previewThemeSelection(base, { color_theme: "super-visuals-dune-above-blue-sea" }).commit();
  expect(getWallpaperSnapshot().source).toBe("super-visuals-dune-above-blue-sea");
});
