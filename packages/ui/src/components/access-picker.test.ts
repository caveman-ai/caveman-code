import { expect, test } from "vitest";
import { CheckmarkBadge01Icon, SquareLock02Icon, SquareUnlock02Icon } from "../icons/huge";
import { ACCESS, ACCESS_MODES } from "./access-picker";

test("each permission mode wears its own glyph, and Full access never the badge that means guarded", () => {
  const icons = ACCESS_MODES.map((m) => ACCESS[m].icon);
  expect(new Set(icons).size).toBe(ACCESS_MODES.length);
  expect(ACCESS.ask.icon).toBe(SquareLock02Icon);
  expect(ACCESS.full.icon).toBe(SquareUnlock02Icon);
  expect(ACCESS.full.icon).not.toBe(CheckmarkBadge01Icon);
});
