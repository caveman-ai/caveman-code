// One address for "connect GitHub in Caveman Cloud": the state's constant, which Review's Connect GitHub opens when
// Cloud names no address of its own, and which the new chat's repo menu links to. source.ts keeps no copy of it.
import { afterEach, expect, test, vi } from "vitest";
import { GITHUB_CONNECT_PATH } from "../../state/cloud.ts";
import * as source from "./source.ts";

afterEach(() => vi.unstubAllGlobals());

test("GITHUB_CONNECT_PATH is Cloud's own connect page, and Review does not define a second one", () => {
  expect(GITHUB_CONNECT_PATH).toBe("/cave-agent/code");
  expect("GITHUB_CONNECT_PATH" in source).toBe(false);
});

test("Connect GitHub opens that page in its own tab unless Cloud sent another address", () => {
  const open = vi.fn();
  vi.stubGlobal("window", { open });
  source.connectGitHub();
  source.connectGitHub("https://app.cave.test/cave-agent/code?next=review");
  expect(open.mock.calls).toEqual([
    [GITHUB_CONNECT_PATH, "_blank", "noopener"],
    ["https://app.cave.test/cave-agent/code?next=review", "_blank", "noopener"],
  ]);
});
