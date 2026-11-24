import { describe, expect, test } from "vitest";
import { arrangedSidebarRows, mergeSidebarRows } from "./sidebar-order-model.ts";

describe("filtered sidebar ordering", () => {
  test("first save keeps hidden projects in their original slots after clearing the filter", () => {
    const ids = ["app", "hidden", "studio", "other"];
    const full = arrangedSidebarRows(ids, []);
    const saved = mergeSidebarRows(full, ["app", "studio"], ["studio", "app"]);
    expect(saved).toEqual(["studio", "hidden", "app", "other"]);
    expect(arrangedSidebarRows(ids, saved)).toEqual(saved);
  });

  test("later filtered moves preserve the saved hidden slots and append new projects", () => {
    const full = arrangedSidebarRows(
      ["app", "hidden", "studio", "new"],
      ["studio", "hidden", "app", "removed"],
    );
    expect(mergeSidebarRows(full, ["studio", "app"], ["app", "studio"])).toEqual([
      "app",
      "hidden",
      "studio",
      "new",
    ]);
  });

  test("unfiltered moves and a filter with one project retain every current row", () => {
    const full = ["app", "studio", "other"];
    expect(mergeSidebarRows(full, full, ["other", "app", "studio"])).toEqual([
      "other",
      "app",
      "studio",
    ]);
    expect(mergeSidebarRows(full, ["studio"], ["studio"])).toEqual(full);
  });
});
