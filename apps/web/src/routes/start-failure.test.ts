// A chat that did not start in Cloud: one sentence of ours, and what failed underneath only behind Details.
import { SessionProtocolError } from "@caveman-app/session-protocol/client";
import { expect, test } from "vitest";
import { CloudError } from "../state/sync/cloud-api.ts";
import { COULD_NOT_START, startFailure } from "./start-failure.ts";

test("one of our own sentences is said as it is, with nothing behind it", () => {
  expect(startFailure(new Error("Cloud is busy. Trying again."))).toEqual({
    line: "The chat didn't start: Cloud is busy. Trying again.",
  });
  expect(startFailure("The clone was refused.")).toEqual({
    line: "The chat didn't start: The clone was refused.",
  });
  // A sentence with no full stop gets one.
  expect(startFailure(new Error("Sign in to Caveman first")).line).toBe(
    "The chat didn't start: Sign in to Caveman first.",
  );
});

test("a driver's words, a stack, a status code or a path are never the sentence: they wait behind Details", () => {
  const raw =
    "create failed: boat-eu-2: ENOSPC: no space left on device (vm 4f2a, rootfs)\n    at provision (/srv/boat/driver.js:412:19)";
  expect(startFailure(new Error(raw))).toEqual({
    line: `The chat didn't start: ${COULD_NOT_START}`,
    detail: raw,
  });
  for (const text of [
    "Caveman answered 502",
    "Error: socket hang up",
    'pod {"phase":"Pending"} unschedulable',
    "fatal: could not read /home/caveman/repo/.git/HEAD",
    "see https://status.example/incident",
    "lowercase reason from a driver",
  ]) {
    const said = startFailure(new Error(text));
    expect(said.line, text).toBe("The chat didn't start: Cloud couldn't start it.");
    expect(said.detail).toBe(text);
  }
});

test("Cloud's own refusal at a limit or a plan with nothing left is written for the person, and said", () => {
  const limit = new CloudError(
    409,
    "cave_code_computer_limit_plan_kept",
    "Your plan keeps no more chats in Cloud. Archive one first.",
  );
  expect(startFailure(limit).line).toBe(
    "The chat didn't start: Your plan keeps no more chats in Cloud. Archive one first.",
  );
  expect(startFailure(limit).detail).toBeUndefined();
  // The same through this Mac's runtime: Cloud's code rides on the protocol error.
  const through = new SessionProtocolError({
    code: -32000,
    message: "Your plan keeps no more chats in Cloud. Archive one first.",
    data: { reason: "invalid_state", cloud_code: "cave_code_computer_limit_plan_kept" },
  });
  expect(startFailure(through).line).toBe(
    "The chat didn't start: Your plan keeps no more chats in Cloud. Archive one first.",
  );
});

test("seen from elsewhere, it names the project's repository and never a machine", () => {
  expect(startFailure("Cloud is busy. Trying again.", "The chat on acme/api").line).toBe(
    "The chat on acme/api didn't start: Cloud is busy. Trying again.",
  );
  expect(startFailure("", "The chat on acme/api")).toEqual({
    line: "The chat on acme/api didn't start: Cloud couldn't start it.",
  });
});
