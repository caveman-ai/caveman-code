// Which way to GitHub comes first (github-way.ts): Caveman's GitHub App needs an owner or admin.
import { expect, test } from "vitest";
import { canConnectThroughCaveman, ghFirst } from "./github-way.ts";

test("an owner or an admin who is signed in connects through Caveman; the gh way is not first for them", () => {
  for (const role of ["owner", "admin", "Owner", "ADMIN"]) {
    expect(canConnectThroughCaveman({ signed_in: true, role })).toBe(true);
    expect(ghFirst({ signed_in: true, role })).toBe(false);
  }
});

test("a member below admin gets the gh way first", () => {
  for (const role of ["member", "engineer", "billing", "viewer", ""])
    expect(ghFirst({ signed_in: true, role })).toBe(true);
  expect(ghFirst({ signed_in: true })).toBe(true);
});

test("a signed-out person, and an account that could not be read, get the gh way first", () => {
  expect(ghFirst({ signed_in: false, role: "owner" })).toBe(true);
  expect(ghFirst({ signed_in: false })).toBe(true);
  expect(ghFirst(null)).toBe(true);
  expect(ghFirst(undefined)).toBe(true);
});
