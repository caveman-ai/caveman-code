import type { CloudStatus } from "@caveman-app/session-protocol";
import { expect, test } from "vitest";
import { registrationProblem, signedInAccount } from "./signin-model.ts";

const account = { email: "ada@example.com", organization_name: "Analytical Engines" };
const signin = {
  user_code: "ABCD-WXYZ",
  verification_uri: "https://app.caveman.so/activate",
  verification_uri_complete: "https://app.caveman.so/activate?user_code=ABCD-WXYZ",
  expires_at: "2026-11-21T10:10:00.000Z",
};
const status = (value: Partial<CloudStatus>) => ({ state: "off", ...value }) as CloudStatus;

test("an account with a live enrollment is signed in, and its computer has nothing to report", () => {
  const live = status({ account, runtime_id: "r1" });
  expect(signedInAccount(live)).toEqual(account);
  expect(registrationProblem(live)).toBeNull();
});

test("an account Caveman kept without registering this computer is signed in, with the reason beside it", () => {
  const refused = status({
    account,
    signin_error:
      "Your role in your Caveman organization cannot turn on remote control (Engineer, Admin or Owner can).",
  });
  expect(signedInAccount(refused)).toEqual(account);
  expect(registrationProblem(refused)).toBe(
    "Your role in your Caveman organization cannot turn on remote control (Engineer, Admin or Owner can).",
  );
  // After a restart the reason is gone but the account is kept: the line still says Remote control is off.
  expect(registrationProblem(status({ account }))).toBe(
    "Remote control is off because Caveman did not register this computer.",
  );
});

test("nobody is signed in without an account, while a sign-in waits for approval, or when Caveman refused this computer", () => {
  expect(signedInAccount(null)).toBeNull();
  expect(signedInAccount(status({}))).toBeNull();
  expect(signedInAccount(status({ state: "not_enrolled", signin }))).toBeNull();
  // Trying again from the signed-in page: the waiting page, not the welcome.
  expect(signedInAccount(status({ account, signin }))).toBeNull();
  expect(registrationProblem(status({ account, signin }))).toBeNull();
  expect(signedInAccount(status({ account, runtime_id: "r1", state: "unauthorized" }))).toBeNull();
});
