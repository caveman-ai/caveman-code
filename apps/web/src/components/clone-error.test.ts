import { describe, expect, test } from "vitest";
import { cloneWay } from "./clone-error.ts";

describe("cloneWay", () => {
  test("a failed login is a sign in", () => {
    expect(
      cloneWay("could not clone https://github.com/acme/widget.git: authentication failed"),
    ).toBe("sign-in");
    expect(
      cloneWay(
        "could not clone acme/widget: repository not found, or private and git has no sign-in for it here",
      ),
    ).toBe("sign-in");
    expect(
      cloneWay(
        "GitHub refused the credentials for acme/widget: sign in to GitHub again, then retry.",
      ),
    ).toBe("sign-in");
    expect(
      cloneWay(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
      ),
    ).toBe("sign-in");
    expect(cloneWay("git@github.com: Permission denied (publickey).")).toBe("sign-in");
    expect(cloneWay("The requested URL returned error: 403")).toBe("sign-in");
  });
  test("a network error, a timeout or anything unknown is a retry", () => {
    expect(cloneWay("could not clone https://github.com/acme/widget.git: network error")).toBe(
      "retry",
    );
    expect(
      cloneWay("Couldn't reach GitHub to read acme/widget; check the connection and retry."),
    ).toBe("retry");
    expect(cloneWay("could not clone acme/widget: git did not finish")).toBe("retry");
    expect(cloneWay("could not clone acme/widget: repository not found")).toBe("retry");
    // A refusal on this computer's disk is not a GitHub sign-in; only SSH's publickey refusal is.
    expect(cloneWay("fatal: could not create work tree dir 'widget': Permission denied")).toBe(
      "retry",
    );
    expect(cloneWay("git@github.com: Permission denied (publickey).")).toBe("sign-in");
    expect(cloneWay("Request timed out")).toBe("retry");
    expect(cloneWay("")).toBe("retry");
  });
});
