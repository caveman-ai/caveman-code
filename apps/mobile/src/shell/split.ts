// Where the shell's columns go, from the window's size and its safe-area insets alone (no React here, so it is tested on
// its own: split.test.ts). shell/layout.tsx says why the lines fall where they do.
import type { EdgeInsets } from "react-native-safe-area-context";

export interface Layout {
  /** The sidebar stands beside the panel instead of lying behind it. */
  split: boolean;
  /** How wide the sidebar is, and the inspector that can take its place. */
  side: number;
  /** The vertical bar at the trailing edge, on its side: how wide, or 0 where the screen's buttons stay in its bar. */
  rail: number;
  /** The sidebar, the panel and the inspector all fit at once. */
  three: boolean;
}

/** Two columns: a sidebar and a panel at least as wide as a small phone. */
const SPLIT_MIN_WIDTH = 600;
/** Any iPhone on its side is too short for two columns, so it stays a phone. */
const SPLIT_MIN_HEIGHT = 500;
const SIDE_MIN = 260;
const SIDE_MAX = 340;
/** The vertical bar where the system doesn't say how wide it is: a 44pt glass circle with room either side. */
const RAIL_WIDTH = 72;
/** The panel between the sidebar and the inspector, before the inspector has to take the sidebar's place. */
const MAIN_MIN = 480;
/** The gap the panel keeps from the screen's edges and the rail: the desktop's frame (AppShell, p-2). */
export const GAP = 8;
/** Where the rail's circles start: under the corner iOS 27 keeps for the clock and the signal on the Duo. */
export const RAIL_TOP = 88;
/** The widest a sheet stands where the screen is wider than a phone: centred, as iPadOS's form sheets are. */
export const SHEET_MAX = 560;

export const PHONE: Layout = { split: false, side: 0, rail: 0, three: false };

export function deriveLayout(width: number, height: number, insets: EdgeInsets): Layout {
  if (width - insets.left - insets.right < SPLIT_MIN_WIDTH || height < SPLIT_MIN_HEIGHT)
    return PHONE;
  const side = Math.min(SIDE_MAX, Math.max(SIDE_MIN, Math.round(width * 0.32)));
  const rail = width > height ? Math.max(insets.right, RAIL_WIDTH) : 0;
  const right = rail || Math.max(insets.right, GAP);
  return { split: true, side, rail, three: width - insets.left - right - side * 2 >= MAIN_MIN };
}
