// Where the window was: the app reopens at the size and place it was left,
// maximized again if it was, 
// (settings/DesktopAppSettings.ts, window/DesktopWindow.ts, MIT, 13aa882c22).
// Saved in <userData>/window-state.json. Bounds on no display that is
// connected now (a monitor unplugged) fall back to the default size,
// centred. Full screen is not restored: it would open a new Space at launch;
// the size under it is. Electron-free, so it tests without Electron;
// main.ts tracks the window.
import { readFileSync } from "node:fs";
import { writeFileStaged } from "./stagedWrite.ts";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState {
  /** The window's normal bounds: what it returns to from maximized or full screen. */
  readonly bounds: Rect;
  readonly maximized: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 820 } as const;
export const MIN_SIZE = { width: 880, height: 560 } as const;
/** How long the window rests before a move or resize is written. */
export const SAVE_DELAY_MS = 500;

const isRect = (value: unknown): value is Rect => {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return [r.x, r.y, r.width, r.height].every((n) => typeof n === "number" && Number.isFinite(n));
};

/** The saved state, or null when there is none or it is not one this app wrote. */
export function readWindowState(file: string): WindowState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { bounds, maximized } = parsed as Record<string, unknown>;
  if (!isRect(bounds) || bounds.width < MIN_SIZE.width || bounds.height < MIN_SIZE.height) return null;
  return { bounds: roundRect(bounds), maximized: maximized === true };
}

/** Written beside the file and renamed over it, so a crash mid-write leaves the last good state. */
export function writeWindowState(file: string, state: WindowState): void {
  writeFileStaged(file, `${JSON.stringify({ bounds: roundRect(state.bounds), maximized: state.maximized })}\n`);
}

const roundRect = (r: Rect): Rect => ({ x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) });

const fitsWithin = (w: Rect, d: Rect) => w.x >= d.x && w.y >= d.y && w.x + w.width <= d.x + d.width && w.y + w.height <= d.y + d.height;

/**
 * The bounds to open with: the saved ones when they lie wholly on a display
 * connected now (`displays`: each display's bounds), otherwise the default
 * size with no position, which Electron centres.
 */
export function initialBounds(saved: WindowState | null, displays: ReadonlyArray<Rect>): Rect | typeof DEFAULT_SIZE {
  if (saved && displays.some((d) => fitsWithin(saved.bounds, d))) return saved.bounds;
  return DEFAULT_SIZE;
}

export const sameState = (a: WindowState | null, b: WindowState): boolean =>
  a !== null &&
  a.maximized === b.maximized &&
  a.bounds.x === b.bounds.x &&
  a.bounds.y === b.bounds.y &&
  a.bounds.width === b.bounds.width &&
  a.bounds.height === b.bounds.height;
