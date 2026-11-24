// The wallpaper a person picked for the new chat (Settings > Appearance > Wallpaper), and their own image for it.
// Kept on this device, as the companion is: a wallpaper belongs to a screen, and a person's image never leaves it.
import { useSyncExternalStore } from "react";
import { DEFAULT_WALLPAPER, RANGE, parseWallpaper, type WallpaperPick } from "./look.ts";
import { WALLPAPERS } from "../state/wallpaper-catalog.ts";
import { PAINTINGS } from "./paintings.ts";

const KEY = "caveman.wallpaper";
const IMAGE_KEY = "caveman.wallpaper.image";

const hasStorage = typeof localStorage !== "undefined";
let image = hasStorage ? localStorage.getItem(IMAGE_KEY) : null;
/** The pictures there are to pick: no wallpaper, each painting, and the person's image once they have one. */
const sources = () => [
  "none",
  "theme",
  ...WALLPAPERS.map((art) => art.id),
  ...PAINTINGS.map((p) => p.id),
  ...(image ? ["image"] : []),
];
let pick = parseWallpaper(hasStorage ? localStorage.getItem(KEY) : null, sources());

let themeSource: string | null = null;
let revision = 0;
let resolved = pick.source === "theme" ? { ...pick, source: "none" } : pick;
const listeners = new Set<() => void>();
const publish = () => {
  resolved =
    pick.matchTheme && themeSource
      ? { ...pick, source: themeSource }
      : pick.source === "theme"
        ? { ...pick, source: "none" }
        : pick;
  listeners.forEach((listener) => listener());
};

/** The saved choice, including "theme" when the picture follows the selected color theme. */
export const getWallpaperPick = (): WallpaperPick => pick;
/** User and preview edits, excluding passive color synchronization. */
export const getWallpaperRevision = (): number => revision;
/** Stable snapshot for React and consumers of the wallpaper store. */
export const getWallpaperSnapshot = (): WallpaperPick => resolved;

/** Colors may sync from another client; a manually chosen picture remains this device's. */
export function setWallpaperTheme(source: string | null): void {
  if (themeSource === source) return;
  const previous = resolved.source;
  themeSource = source;
  if (pick.matchTheme) writeWallpaper({ source: source ? "theme" : previous, matchTheme: true });
  else publish();
}
const subscribe = (onChange: () => void) => {
  listeners.add(onChange);
  return () => void listeners.delete(onChange);
};

function writeWallpaper(next: Partial<WallpaperPick>): void {
  pick = {
    ...pick,
    ...(next.source === undefined ? {} : { matchTheme: next.source === "theme" }),
    ...next,
  };
  if (hasStorage) localStorage.setItem(KEY, JSON.stringify(pick));
  publish();
}

export function setWallpaper(next: Partial<WallpaperPick>): void {
  revision++;
  writeWallpaper(next);
}

/** Unlinking freezes the visible picture; linking uses this theme's picture when it has one. */
export function setWallpaperMatchingTheme(matchTheme: boolean): void {
  setWallpaper({ source: matchTheme && themeSource ? "theme" : resolved.source, matchTheme });
}

/** The effect and every dial back where they start; the picture stays. */
export function resetWallpaper(): void {
  const { source, imageLight, matchTheme } = pick;
  setWallpaper({ ...DEFAULT_WALLPAPER, source, imageLight, matchTheme });
}

export function useWallpaper(): WallpaperPick {
  return useSyncExternalStore(subscribe, getWallpaperSnapshot, () => DEFAULT_WALLPAPER);
}

/** The person's own image, as a data URL; null until they choose one. */
export function useWallpaperImage(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => image,
    () => null,
  );
}

/** The longest side kept: enough for a wide window on a dense screen, small enough to keep here. */
const LONGEST = 1920;

/**
 * Keeps a person's image as their wallpaper, scaled down, and picks it with nothing over it: their picture first,
 * as it is. Throws what to tell them when the file is not a picture or will not fit in this device's storage.
 */
export async function setWallpaperImage(file: Blob): Promise<void> {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error("That file isn't a picture Caveman Code can read.");
  });
  const scale = Math.min(1, LONGEST / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const url = canvas.toDataURL("image/jpeg", 0.88);
  try {
    localStorage.setItem(IMAGE_KEY, url);
  } catch {
    throw new Error("This device has no room left to keep that picture.");
  }
  // How light it is, from a thumbnail of it: which ink its words wear.
  const small = document.createElement("canvas");
  small.width = small.height = 32;
  const sctx = small.getContext("2d", { willReadFrequently: true })!;
  sctx.drawImage(canvas, 0, 0, 32, 32);
  const px = sctx.getImageData(0, 0, 32, 32).data;
  let light = 0;
  for (let i = 0; i < px.length; i += 4)
    light += (px[i]! * 0.2126 + px[i + 1]! * 0.7152 + px[i + 2]! * 0.0722) / 255;
  image = url;
  setWallpaper({ source: "image", imageLight: light / (px.length / 4), blur: RANGE.blur.start });
}

/** Forgets the person's image; a wallpaper that was showing it goes back to the default painting. */
export function removeWallpaperImage(): void {
  if (hasStorage) localStorage.removeItem(IMAGE_KEY);
  image = null;
  setWallpaper(pick.source === "image" ? { source: DEFAULT_WALLPAPER.source } : {});
}
