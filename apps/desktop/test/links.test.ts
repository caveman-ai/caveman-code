import { expect, test } from "vitest";
import { routeFromDeepLink } from "../src/links.ts";

test("a caveman-code:// link becomes the client's hash route", () => {
  expect(routeFromDeepLink("caveman-code://w/0b8f2c1e")).toBe("/w/0b8f2c1e");
  expect(routeFromDeepLink("caveman-code://settings/general")).toBe("/settings/general");
  expect(routeFromDeepLink("caveman-code://chief")).toBe("/chief");
  expect(routeFromDeepLink("caveman-code://app/#/memory")).toBe("/memory");
  expect(routeFromDeepLink("caveman-code://app/")).toBe("/");
});

test("anything else is not a link to the app", () => {
  for (const raw of ["https://caveman.so/w/1", "javascript:alert(1)", "caveman://w/1", "not a url", ""]) expect(routeFromDeepLink(raw)).toBeNull();
});
