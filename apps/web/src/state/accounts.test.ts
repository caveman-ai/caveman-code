import { expect, test } from "vitest";
import { isConnection, pickableLogins } from "./accounts.ts";

test("only this computer's own logins can be picked for a chat; a runtime from before connections lists only those", () => {
  const accounts = [
    { id: "connection:c1", where: "everywhere" as const },
    { id: "connection:c2", where: "cloud" as const },
    { id: "claudeAgent:default", where: "this_mac" as const },
    { id: "claudeAgent-account-1" },
  ];
  expect(accounts.map(isConnection)).toEqual([true, true, false, false]);
  expect(pickableLogins(accounts).map((a) => a.id)).toEqual([
    "claudeAgent:default",
    "claudeAgent-account-1",
  ]);
  expect(pickableLogins([])).toEqual([]);
});
