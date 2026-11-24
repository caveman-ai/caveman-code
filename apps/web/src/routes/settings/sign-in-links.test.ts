import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

// "Sign in ... in <section>" sends people to the section that holds the sign-in (Account), not one that used to.
const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("Computers sends a signed-out person to Account, where Sign in to Caveman is", () => {
  expect(read("./Account.tsx")).toContain("Sign in to Caveman");
  const computers = read("./Computers.tsx");
  expect(computers).toMatch(/<NavLink to="\/settings\/account">Sign in<\/NavLink>/);
  expect(computers).not.toContain('to="/settings/general"');
});
