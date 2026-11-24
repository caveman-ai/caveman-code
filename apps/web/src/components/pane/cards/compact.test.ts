import { expect, test } from "vitest";
import { compact } from "./PaneCardsView.tsx";

test("token counts read short: no trailing .0, millions as M", () => {
  expect(compact(950)).toBe("950");
  expect(compact(41_000)).toBe("41k");
  expect(compact(41_250)).toBe("41.3k");
  expect(compact(182_000)).toBe("182k");
  expect(compact(999_000)).toBe("999k");
  expect(compact(1_000_000)).toBe("1M");
  expect(compact(1_250_000)).toBe("1.3M");
  expect(compact(4_210_000)).toBe("4.2M");
});
