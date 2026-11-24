import { extractKnownSecrets } from "@caveman-app/session-protocol";
import { describe, expect, test } from "vitest";
import { mask } from "./SecretSheet.tsx";
import { settle } from "./useSecretCatch.ts";

const A = ("sk_" + "live_51Hx9QaZ8bYc7dWe6fVg5hUi4jTk3");
const B = ("sk_" + "live_99Hx9QaZ8bYc7dWe6fVg5hUi4jTk");

describe("settle", () => {
  const x = extractKnownSecrets(`use ${A} and ${B}`);

  test("saved as named: the $NAMEs stay", () => {
    expect(settle(x.text, x.entries, x.entries)).toBe("use $STRIPE_SECRET_KEY and $STRIPE_SECRET_KEY_2");
  });

  test("a rename follows, without touching the longer name", () => {
    const saved = [{ name: "STRIPE_LIVE", value: A }, x.entries[1]!];
    expect(settle(x.text, x.entries, saved)).toBe("use $STRIPE_LIVE and $STRIPE_SECRET_KEY_2");
  });

  test("an entry left out gets its text back", () => {
    expect(settle(x.text, x.entries, [x.entries[1]!])).toBe(`use ${A} and $STRIPE_SECRET_KEY_2`);
  });
});

test("mask shows at most the last 4 characters", () => {
  expect(mask(A)).toBe("••••••••jTk3");
  expect(mask("short")).toBe("••••••••");
});
