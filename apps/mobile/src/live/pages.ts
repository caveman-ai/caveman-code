// What the prototype's drawn screens are, without the drawing (live/views.tsx): each one's size, as a frame would
// stream at (a 16:10 browser viewport, a Cloud computer's desktop), where its controls are in frame pixels, what a
// click on one does, and the way the agent's cursor goes round it while it works. The scripted source
// (live/scripted.ts) keeps each page's state and lands clicks with these, the agent's and yours alike.
import type { DrawnScreen } from "../board/model";

/** A control on a page, by the page's own name for it. */
export type Spot = "theme" | "hero" | "start" | `row:${number}` | `step:${number}`;

/** Everything a page can change to: the Runs page's theme and picked row, onboarding's hero and picked step. */
export interface PageState {
  dark: boolean;
  row: number;
  hero: number;
  step: number;
}

export const FIRST_PAGE: PageState = { dark: true, row: -1, hero: 0, step: -1 };

/** What a click on `spot` does to the page. Onboarding's hero goes from the one it found to the two it tries. */
export function press(page: PageState, spot: Spot): PageState {
  if (spot === "theme") return { ...page, dark: !page.dark };
  if (spot === "hero") return { ...page, hero: page.hero === 1 ? 2 : 1 };
  if (spot === "start") return { ...page, step: 0 };
  const [kind, n] = spot.split(":");
  return kind === "row" ? { ...page, row: Number(n) } : { ...page, step: Number(n) };
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A stop on the agent's way round a screen: where its cursor goes, what it clicks there, and how long it stays. */
export interface Stop {
  x: number;
  y: number;
  click?: Spot;
  wait?: number;
}

export interface Page {
  width: number;
  height: number;
  spots: readonly (readonly [Spot, Rect])[];
  /** Round and round while the agent uses the screen. */
  path: readonly Stop[];
}

/** The control under a point, if any. */
export function spotAt(page: Page, x: number, y: number): Spot | null {
  return page.spots.find(([, r]) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.[0] ?? null;
}

/** The Runs page's four runs (components/RunsPreview.tsx RUNS), each a row. */
const RUN_ROWS = 4;
export const RUN_ROW = (i: number): Rect => ({ x: 32, y: 152 + i * 74, w: 736, h: 64 });
export const THEME: Rect = { x: 724, y: 10, w: 44, h: 44 };

export const HERO: Rect = { x: 40, y: 96, w: 660, h: 104 };
export const START: Rect = { x: 40, y: 258, w: 180, h: 52 };
export const STEP = (i: number): Rect => ({ x: 40 + i * 245, y: 350, w: 229, h: 110 });
const STEPS = 3;

/** The Simulator window's size, and where the phone's screen sits in it, under the title bar. */
export const SIM = { width: 400, height: 560, bar: 32, screen: { x: 20, y: 48, w: 360, h: 496 } };

/** Where the onboarding page sits on the desktop: in the browser window, under its bar. */
export const WINDOW = { x: 80, y: 44, bar: 44 };
const inWindow = { x: WINDOW.x, y: WINDOW.y + WINDOW.bar };

const onboardingSpots: readonly (readonly [Spot, Rect])[] = [
  ["hero", HERO],
  ["start", START],
  ...Array.from({ length: STEPS }, (_, i) => [`step:${i}` as Spot, STEP(i)] as const),
];
const onboardingPath: readonly Stop[] = [
  { x: 330, y: 146, click: "hero", wait: 1600 },
  { x: 399, y: 405, click: "step:1" },
  { x: 130, y: 284 },
  { x: 380, y: 140, click: "hero", wait: 1600 },
  { x: 644, y: 405, click: "step:2" },
];

export const PAGES: Record<DrawnScreen, Page> = {
  runs: {
    width: 800,
    height: 500,
    spots: [["theme", THEME], ...Array.from({ length: RUN_ROWS }, (_, i) => [`row:${i}` as Spot, RUN_ROW(i)] as const)],
    // Checking the page light and dark, as it takes its screenshots.
    path: [
      { x: 420, y: 184 },
      { x: 746, y: 32, click: "theme", wait: 1400 },
      { x: 520, y: 258, click: "row:1" },
      { x: 600, y: 406 },
      { x: 746, y: 32, click: "theme", wait: 1400 },
      { x: 380, y: 332, click: "row:2" },
    ],
  },
  onboarding: { width: 800, height: 500, spots: onboardingSpots, path: onboardingPath },
  // The onboarding page in the desktop's browser window.
  desktop: {
    width: 960,
    height: 600,
    spots: onboardingSpots.map(([spot, r]) => [spot, { ...r, x: r.x + inWindow.x, y: r.y + inWindow.y }] as const),
    path: onboardingPath.map((stop) => ({ ...stop, x: stop.x + inWindow.x, y: stop.y + inWindow.y })),
  },
  // This Mac's Simulator window, the push on its lock screen: a Mac's frames are the app's window alone. Nothing on it
  // answers the phone's touches (a Mac takes no computer.input), so it has no spots.
  simulator: {
    width: SIM.width,
    height: SIM.height,
    spots: [],
    path: [
      { x: 200, y: 214, wait: 1400 },
      { x: 300, y: 262, wait: 1200 },
    ],
  },
};
