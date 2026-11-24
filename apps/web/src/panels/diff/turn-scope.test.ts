import { expect, test } from "vitest";
import { scopeLabel, turnScope, turnScopes } from "./turn-scope.ts";

const own = (id: string) => ({ id, own: true });

test("a turn diffs from the checkpoint the turn before ended at; the first turn from the base", () => {
  const cps = [own("c1"), own("c2"), own("c3")];
  expect(turnScope(cps, "c1")).toEqual({ turn: 1, to: "c1", latest: false });
  expect(turnScope(cps, "c2")).toEqual({ turn: 2, from: "c1", to: "c2", latest: false });
  expect(turnScope(cps, "c3")).toEqual({ turn: 3, from: "c2", to: "c3", latest: true });
  expect(scopeLabel(turnScope(cps, "c3"))).toBe("Latest turn");
  expect(scopeLabel(turnScope(cps, "c2"))).toBe("Turn 2");
  expect(scopeLabel(null)).toBe("All changes");
});

test("the menu lists the turns newest first", () => {
  expect(turnScopes([own("c1"), own("c2")]).map((s) => s.to)).toEqual(["c2", "c1"]);
});

test("a fork offers only turns whose both ends it can read", () => {
  const cps = [{ id: "src1", own: false }, { id: "src2", own: false }, own("f1"), own("f2")];
  // Copied turns name the source chat's checkpoints; the fork's first own turn started from one of them.
  expect(turnScope(cps, "src2")).toBeNull();
  expect(turnScope(cps, "f1")).toBeNull();
  expect(turnScope(cps, "f2")).toEqual({ turn: 4, from: "f1", to: "f2", latest: true });
  expect(turnScopes(cps).map((s) => s.to)).toEqual(["f2"]);
  expect(turnScope(cps, "gone")).toBeNull();
});
