import type { Settings } from "@caveman-app/session-protocol";
import { getWallpaperPick, getWallpaperRevision, setWallpaper } from "../wallpaper/store.ts";
import type { WallpaperPick } from "../wallpaper/look.ts";
import { applyAppearance, settingsAppearance } from "./appearance.ts";
import type { SettingsPatch } from "./settings-saves.ts";
import { findTheme } from "./themes.ts";

let selection = 0;
let batch = 0;
let confirmed = 0;
let baseline: WallpaperPick = getWallpaperPick();
let paintedRevision = -1;
let pending: Array<{ id: number; wallpaper: WallpaperPick }> = [];

/** Explicit picks share one pending-save journal across the gallery and command palette. */
export function previewThemeSelection(
  current: Settings,
  patch: SettingsPatch,
): {
  commit: () => void;
  rollback: (saved: Settings) => void;
} {
  const before = getWallpaperPick();
  // A new batch starts from what was actually kept, including a manual choice made between requests.
  if (pending.length === 0 || getWallpaperRevision() !== paintedRevision) {
    batch++;
    confirmed = 0;
    baseline = before;
    pending = [];
  }
  const mine = ++selection;
  const group = batch;
  applyAppearance(settingsAppearance({ ...current, ...patch }));
  if (
    before.matchTheme &&
    patch.color_theme &&
    findTheme(patch.color_theme, patch.custom_themes ?? current.custom_themes).wallpaper
  ) {
    setWallpaper({ source: "theme", effect: "none", brightness: 100, blur: 0, dim: 0, fade: 0 });
  }
  const entry = { id: mine, wallpaper: getWallpaperPick() };
  paintedRevision = getWallpaperRevision();
  pending.push(entry);
  let settled = false;
  const settle = (success: boolean) => {
    if (settled || group !== batch) return;
    settled = true;
    // A manual picture or dial change wins over every outstanding request in this batch.
    if (getWallpaperRevision() !== paintedRevision) {
      batch++;
      pending = [];
      return;
    }
    if (success && mine > confirmed) {
      confirmed = mine;
      baseline = entry.wallpaper;
    }
    pending = pending.filter((attempt) => attempt.id !== mine);
    const latest = pending.findLast((attempt) => attempt.id > confirmed);
    const next = latest?.wallpaper ?? baseline;
    if (getWallpaperPick() !== next) setWallpaper(next);
    paintedRevision = getWallpaperRevision();
  };
  return {
    commit: () => settle(true),
    rollback: (saved) => {
      if (mine === selection && group === batch) applyAppearance(settingsAppearance(saved));
      settle(false);
    },
  };
}
