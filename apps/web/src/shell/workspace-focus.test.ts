import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { leafAreas, stepArea } from "./workspace-focus.ts";

test("F6 steps through the areas and wraps both ways; from outside any, it starts at an end", () => {
  expect(stepArea(4, 0, 1)).toBe(1);
  expect(stepArea(4, 3, 1)).toBe(0);
  expect(stepArea(4, 0, -1)).toBe(3);
  expect(stepArea(4, -1, 1)).toBe(0);
  expect(stepArea(4, -1, -1)).toBe(3);
  expect(stepArea(0, -1, 1)).toBe(-1);
});

test("an area holding others counts only when none of them shows (a page with panes is its panes)", () => {
  const page = { id: "page", kids: ["conversation", "composer", "panel"] };
  const parts = page.kids.map((id) => ({ id, kids: [] as string[] }));
  const sidebar = { id: "sidebar", kids: [] as string[] };
  const contains = (outer: { kids: string[] }, inner: { id: string }) => outer.kids.includes(inner.id);
  expect(leafAreas([sidebar, page, ...parts], contains).map((a) => a.id)).toEqual(["sidebar", "conversation", "composer", "panel"]);
  // Review or the Chief: no pane inside, so the page is the area.
  expect(leafAreas([sidebar, { id: "page", kids: [] }], contains).map((a) => a.id)).toEqual(["sidebar", "page"]);
});

test("the areas are marked where they live, and the keys mount above the shell and Settings", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  // One sidebar: the collapsed rail is gone (a hidden sidebar is fully out of the way).
  expect(read("./Sidebar.tsx").match(/data-focus-area="sidebar"/g)).toHaveLength(1);
  const pane = read("../components/pane/PaneFrame.tsx");
  expect(pane).toContain('data-focus-area="conversation"');
  expect(pane).toContain('data-focus-area="composer"');
  expect(read("../panels/SidePanel.tsx")).toContain('data-focus-area="panel"');
  expect(read("./AppShell.tsx")).toContain('data-focus-area="page"');
  const settings = read("../routes/Settings.tsx");
  expect(settings).toContain('data-focus-area="settings-sections"');
  expect(settings).toContain('data-focus-area="settings-section"');
  expect(read("../routes/FirstRun.tsx")).toContain("<WorkspaceFocus />");
});
