// Which Settings sections a board lists: every one on the scripted board, and on a board that is the person's own
// only the ones whose controls are real there. A control that changes nothing is not shown.
import { describe, expect, it } from "vitest";

import { findSettings, groupsFor, listed, SECTIONS } from "./sections";

const ids = (scripted: boolean) => groupsFor(scripted).flatMap((g) => g.sections.map((s) => s.id));

describe("the Settings list", () => {
  it("is every section for someone who never signed in", () => {
    expect(ids(true)).toEqual([
      "account",
      "general",
      "notifications",
      "appearance",
      "chief",
      "models",
      "caveman-mcp",
      "computers",
      "about",
    ]);
  });

  it("is only what is real on a person's own board: nothing that would set what no computer hears", () => {
    expect(ids(false)).toEqual(["account", "appearance", "models", "computers", "about"]);
    expect(groupsFor(false).map((g) => g.label)).toEqual(["You", "App", "Work", null]);
    for (const id of ["general", "notifications", "chief", "caveman-mcp"])
      expect(
        listed(
          SECTIONS.find((s) => s.id === id)!,
          false,
        ),
      ).toBe(false);
  });

  it("finds by search only what it lists", () => {
    expect(findSettings("permissions").map((s) => s.id)).toEqual(["general"]);
    expect(findSettings("permissions", false)).toEqual([]);
    expect(findSettings("push", false)).toEqual([]);
    expect(findSettings("cloud", false).map((s) => s.id)).toEqual(["computers"]);
    expect(findSettings("plan", false).map((s) => s.id)).toEqual(["account", "models"]);
  });
});
