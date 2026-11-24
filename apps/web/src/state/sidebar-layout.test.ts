import { expect, test, vi } from "vitest";
import { PHONE_QUERY } from "../lib/screen.ts";
import { clampSidebarWidth, keyedSidebarTop, keyedSidebarWidth, readSidebarLayout, settleSidebarTop, sidebarTopStops, snapSidebarTop, SIDEBAR_TOP, SIDEBAR_WIDTH, sidebarDrawerOpen, toggleSidebar } from "./sidebar-layout.ts";

const storage = (items: Record<string, string>) => ({ getItem: (k: string) => items[k] ?? null });

test("the sidebar starts shown at its usual width; a stored shape comes back, kept within bounds", () => {
  expect(readSidebarLayout(storage({}))).toEqual({ hidden: false, width: SIDEBAR_WIDTH.default });
  expect(readSidebarLayout(storage({ "caveman.sidebarHidden": "1", "caveman.sidebarWidth": "300" }))).toEqual({ hidden: true, width: 300 });
  expect(readSidebarLayout(storage({ "caveman.sidebarWidth": "9000" })).width).toBe(SIDEBAR_WIDTH.max);
  expect(readSidebarLayout(storage({ "caveman.sidebarWidth": "wide" })).width).toBe(SIDEBAR_WIDTH.default);
});

test("a dragged width is whole pixels within bounds", () => {
  expect(clampSidebarWidth(100)).toBe(SIDEBAR_WIDTH.min);
  expect(clampSidebarWidth(301.6)).toBe(302);
  expect(clampSidebarWidth(Number.NaN)).toBe(SIDEBAR_WIDTH.default);
});

test("the edge moves with the arrow keys, further with Shift, to a bound with Home and End", () => {
  expect(keyedSidebarWidth(272, "ArrowRight", false)).toBe(288);
  expect(keyedSidebarWidth(272, "ArrowLeft", true)).toBe(SIDEBAR_WIDTH.min);
  expect(keyedSidebarWidth(272, "End", false)).toBe(SIDEBAR_WIDTH.max);
  expect(keyedSidebarWidth(272, "Home", false)).toBe(SIDEBAR_WIDTH.min);
  expect(keyedSidebarWidth(272, "a", false)).toBeNull();
});

test("the top settles folded under a row, whole near all of it, and at the dragged height between", () => {
  expect(settleSidebarTop(SIDEBAR_TOP.fold - 1, 300)).toBe(0);
  expect(settleSidebarTop(SIDEBAR_TOP.fold, 300)).toBe(SIDEBAR_TOP.fold);
  expect(settleSidebarTop(140.4, 300)).toBe(140);
  expect(settleSidebarTop(297, 300)).toBeNull();
  expect(settleSidebarTop(300, 300)).toBeNull();
});

// A top of rows: three of 29px, a heading, then five of 33px.
const edges = [28, 57, 86, 123, 155, 188, 221, 254, 287];
const full = 295;

test("the top stops folded, under each of its rows, and at all of it", () => {
  expect(sidebarTopStops(edges, full)).toEqual([0, ...edges, full]);
  // A row shorter than a fold, or one ending at the very foot, is no stop of its own.
  expect(sidebarTopStops([12, 40, 293], 295)).toEqual([0, 40, 295]);
});

test("a drag rests on the nearest stop, so a row shows whole or not at all", () => {
  const stops = sidebarTopStops(edges, full);
  // Five rows of 33px; let go a little under the third and three show.
  expect(snapSidebarTop(229, stops)).toBe(221);
  expect(snapSidebarTop(240, stops)).toBe(254);
  expect(snapSidebarTop(10, stops)).toBe(0);
  expect(snapSidebarTop(400, stops)).toBe(full);
});

test("the arrow keys move the hairline a row, Home folds and End shows all", () => {
  const stops = sidebarTopStops(edges, full);
  expect(keyedSidebarTop(full, stops, "ArrowUp")).toBe(287);
  expect(keyedSidebarTop(254, stops, "ArrowUp")).toBe(221);
  expect(keyedSidebarTop(28, stops, "ArrowUp")).toBe(0);
  expect(keyedSidebarTop(0, stops, "ArrowUp")).toBe(0);
  expect(keyedSidebarTop(0, stops, "ArrowDown")).toBe(28);
  expect(keyedSidebarTop(287, stops, "ArrowDown")).toBe(full);
  expect(keyedSidebarTop(200, stops, "Home")).toBe(0);
  expect(keyedSidebarTop(0, stops, "End")).toBe(full);
  expect(keyedSidebarTop(200, stops, "a")).toBeNull();
});

test("on a phone the sidebar's toggle opens and shuts its drawer; the wide window's tucked-away shape is left alone", () => {
  const items = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => items.set(k, v) });
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query === PHONE_QUERY }));
  toggleSidebar();
  expect(sidebarDrawerOpen()).toBe(true);
  expect(items.has("caveman.sidebarHidden")).toBe(false);
  toggleSidebar();
  expect(sidebarDrawerOpen()).toBe(false);
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  toggleSidebar();
  expect(items.get("caveman.sidebarHidden")).toBe("1");
  expect(sidebarDrawerOpen()).toBe(false);
  vi.unstubAllGlobals();
});
