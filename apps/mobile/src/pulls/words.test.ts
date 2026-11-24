// Every sentence a person reads about a pull request on the phone: the list's rows and its one line about what it
// could not read, a pull request's state and checks, the merge question, the first message of a chat started from
// one, and what a failed read or a refused change says. None of them names a status code, Cloud's raw answer or a
// word the vocabulary leaves out.
import { describe, expect, it } from "vitest";

import { ago, detail, NOW, PRS, refusal } from "./testing";
import {
  ageOf,
  askText,
  checksSaid,
  CONNECT_GITHUB,
  couldNotRead,
  GROUP_LABEL,
  mergeBar,
  mergeQuestion,
  passes,
  readable,
  refusedWords,
  reviewsSaid,
  rowLine,
  stateLine,
  unreadWords,
  waitLine,
} from "./words";

describe("a row in the list", () => {
  it("says where the pull request is and how long ago it changed", () => {
    expect(rowLine(PRS[0]!, NOW)).toBe("acme/api #7 · 40m");
    expect(rowLine(PRS[1]!, NOW)).toBe("acme/api #12 · 3h");
    expect(rowLine({ repo: "acme/api", number: 9, updated_at: "" }, NOW)).toBe("acme/api #9");
  });

  it("counts an age in minutes, hours and days, as the phone's other rows do", () => {
    expect(ageOf(ago(0), NOW)).toBe("now");
    expect(ageOf(ago(59), NOW)).toBe("59m");
    expect(ageOf(ago(60), NOW)).toBe("1h");
    expect(ageOf(ago(60 * 47), NOW)).toBe("1d");
    expect(ageOf("not a time", NOW)).toBe("");
  });

  it("names the groups as the web's queue does", () => {
    expect(GROUP_LABEL.needs_you).toBe("Needs your review");
    expect(GROUP_LABEL.yours).toBe("Yours");
  });

  it("says once which repositories Cloud could not read, in the web's words", () => {
    expect(couldNotRead([])).toBeNull();
    expect(
      couldNotRead([{ repo: "acme/mobile", message: "Connect GitHub to see its pull requests." }]),
    ).toBe("Could not read acme/mobile: Connect GitHub to see its pull requests.");
    expect(
      couldNotRead([
        { repo: "acme/mobile", message: "Connect GitHub to see its pull requests." },
        { repo: "acme/tv", message: "Connect GitHub to see its pull requests." },
        { repo: "acme/mobile", message: "again" },
      ]),
    ).toBe("Could not read acme/mobile, acme/tv: Connect GitHub to see its pull requests.");
  });
});

describe("a pull request's page", () => {
  it("says who opened it, what goes into what, and where", () => {
    expect(stateLine(PRS[0]!)).toEqual({
      author: "bob",
      branches: "main ← fix-login",
      repo: "acme/api",
    });
    expect(stateLine({ ...PRS[0]!, author: undefined }).author).toBe("");
  });

  it("says how many checks pass and names each that fails", () => {
    expect(checksSaid(detail().checks_list)).toEqual({
      line: "2 of 3 checks pass",
      failing: ["test"],
      mark: "fail",
    });
    expect(
      checksSaid([
        { name: "test", status: "passed" },
        { name: "lint", status: "passed" },
      ]),
    ).toEqual({ line: "2 of 2 checks pass", failing: [], mark: "pass" });
    expect(
      checksSaid([
        { name: "test", status: "passed" },
        { name: "e2e", status: "pending" },
        { name: "docs", status: "skipped" },
      ]),
    ).toEqual({ line: "1 of 2 checks pass · 1 running", failing: [], mark: "running" });
    expect(checksSaid([{ name: "test", status: "passed" }])?.line).toBe("1 check passes");
    expect(checksSaid([{ name: "test", status: "failed" }])?.line).toBe("1 check fails");
    expect(checksSaid([{ name: "test", status: "pending" }])?.line).toBe("1 check running");
  });

  it("says nothing of checks where there are none, or only skipped ones", () => {
    expect(checksSaid([])).toBeNull();
    expect(checksSaid([{ name: "docs", status: "skipped" }])).toBeNull();
  });

  it("says who reviewed it and how, then who is still asked", () => {
    expect(
      reviewsSaid([
        { login: "carol", state: "commented" },
        { login: "ada", state: "pending" },
      ]),
    ).toBe("carol reviewed · waiting on ada");
    expect(
      reviewsSaid([
        { login: "bob", state: "approved" },
        { login: "dan", state: "changes_requested" },
      ]),
    ).toBe("bob approved · dan asked for changes");
    expect(
      reviewsSaid([
        { login: "ada", state: "pending" },
        { login: "eve", state: "pending" },
      ]),
    ).toBe("waiting on ada, eve");
    expect(reviewsSaid([])).toBeNull();
  });

  it("says what bars a merge only for an open pull request GitHub names something for", () => {
    expect(mergeBar(detail({ mergeable: "conflicting" }))).toBe("Conflicts with main");
    expect(mergeBar(detail({ mergeable: "blocked" }))).toBe("Blocked by a branch rule");
    expect(mergeBar(detail({ mergeable: "clean" }))).toBeNull();
    expect(mergeBar(detail({ mergeable: "unknown" }))).toBeNull();
    expect(mergeBar(detail({ mergeable: "conflicting", state: "merged" }))).toBeNull();
  });

  it("asks the merge once, names its method on the button, and says so when checks fail", () => {
    expect(mergeQuestion(detail(), "squash")).toEqual({
      title: "Merge #7?",
      line: "fix-login into main on acme/api. Some checks fail.",
      confirm: "Squash and merge",
      failing: true,
    });
    expect(mergeQuestion(detail({ checks_list: [] }), "rebase")).toEqual({
      title: "Merge #7?",
      line: "fix-login into main on acme/api.",
      confirm: "Rebase and merge",
      failing: false,
    });
  });

  it("reads a bot's comment without its markup", () => {
    expect(
      readable(
        "<!-- bot -->\n<details><summary>Report</summary>\n\nAll good.\n</details>\n\n\n\nDone.",
      ),
    ).toBe("Report\n\nAll good.\n\nDone.");
    expect(readable("  \n")).toBe("");
  });

  it("counts a wait's seconds once one has passed", () => {
    expect(waitLine("Merging", NOW, NOW + 400)).toBe("Merging…");
    expect(waitLine("Merging", NOW, NOW + 3_200)).toBe("Merging… 3s");
    expect(waitLine("Approving", NOW, NOW - 50)).toBe("Approving…");
  });
});

describe("the first message of a chat about a pull request", () => {
  const text = askText(PRS[0]!);

  it("names the pull request, its repository, its address and its head branch, then the web's Ask instruction", () => {
    expect(text.split("\n")).toEqual([
      "About pull request #7: “Stop the login redirect loop” in acme/api (https://github.com/acme/api/pull/7), head branch `fix-login`.",
      "Answer the question below about this pull request. Read the code on its head branch; change nothing.",
      "",
      "Explain this: what it does and why.",
    ]);
  });

  it("never says the chat is on the head branch: a chat the phone starts begins on the repository's own", () => {
    expect(text).not.toMatch(/you are on/i);
  });

  it("opens with what the chat is titled by", () => {
    expect(text.split(/[:.!?\n]/)[0]).toBe("About pull request #7");
  });
});

describe("what could not be read", () => {
  it("says the network is gone, and that it loads by itself", () => {
    expect(unreadWords(refusal.offline(), "list")).toBe(
      "No network. Pull requests load when you're back online.",
    );
    expect(unreadWords(refusal.offline(), "pull")).toBe(
      "No network. Loads when you're back online.",
    );
  });

  it("says what failed where Cloud answered and nothing could be read", () => {
    expect(unreadWords(refusal.busy(), "list")).toBe("Couldn't load pull requests.");
    expect(unreadWords(refusal.busy(), "pull")).toBe("Couldn't load this pull request.");
    expect(unreadWords(refusal.busy(), "discussion")).toBe("Couldn't load the discussion.");
    expect(unreadWords(refusal.busy(), "patch")).toBe("Couldn't load this file's lines.");
  });

  it("says the one thing to do: connect GitHub, sign in again, or look on the Mac", () => {
    expect(unreadWords(refusal.notConnected(), "pull")).toBe(CONNECT_GITHUB);
    expect(unreadWords(Object.assign(new Error("gone"), { name: "SignedOut" }), "list")).toBe(
      "Sign in to Caveman again (Settings > Account).",
    );
    expect(
      unreadWords(
        Object.assign(new Error("cave_agent_operation_forbidden"), {
          name: "CloudError",
          status: 403,
          code: "cave_agent_operation_forbidden",
        }),
        "pull",
      ),
    ).toBe("Review it on your Mac (Review).");
    expect(unreadWords(refusal.notFound(), "pull")).toBe(
      "Can't find this pull request in your projects.",
    );
  });

  it("is tried again by itself only where what failed passes by itself", () => {
    expect(passes(refusal.offline())).toBe(true);
    expect(passes(refusal.busy())).toBe(true);
    expect(passes(refusal.notFound())).toBe(false);
    expect(passes(refusal.github("No."))).toBe(false);
    expect(passes(refusal.notConnected())).toBe(false);
  });
});

describe("a change that was refused", () => {
  it("says GitHub's own words where GitHub refused it", () => {
    expect(
      refusedWords(
        refusal.github("At least 1 approving review is required by reviewers with write access."),
        "merge",
      ),
    ).toBe("At least 1 approving review is required by reviewers with write access.");
    expect(
      refusedWords(
        refusal.github("Head branch was modified. Review and try the merge again."),
        "merge",
      ),
    ).toBe("Head branch was modified. Review and try the merge again.");
  });

  it("says GitHub refused it where Cloud passed on no sentence of GitHub's", () => {
    expect(refusedWords(refusal.github("Caveman answered 409."), "approve")).toBe(
      "GitHub refused it.",
    );
    expect(refusedWords(refusal.github("cave_code_github_refused"), "approve")).toBe(
      "GitHub refused it.",
    );
    expect(refusedWords(refusal.github(""), "approve")).toBe("GitHub refused it.");
  });

  it("says what did not happen when nothing was reached, and what failed otherwise", () => {
    expect(refusedWords(refusal.offline(), "approve")).toBe("No network. Not approved.");
    expect(refusedWords(refusal.offline(), "changes")).toBe("No network. Not sent.");
    expect(refusedWords(refusal.offline(), "comment")).toBe("No network. Not sent.");
    expect(refusedWords(refusal.offline(), "merge")).toBe("No network. Not merged.");
    expect(refusedWords(refusal.busy(), "approve")).toBe("Couldn't approve.");
    expect(refusedWords(refusal.busy(), "comment")).toBe("Couldn't send.");
    expect(refusedWords(refusal.busy(), "merge")).toBe("Couldn't merge.");
  });

  it("says the one thing to do where that is why", () => {
    expect(refusedWords(refusal.notConnected(), "approve")).toBe(CONNECT_GITHUB);
    expect(refusedWords(refusal.notFound(), "merge")).toBe(
      "Can't find this pull request in your projects.",
    );
  });

  it("never shows a status code, a code name or Cloud's raw answer", () => {
    const errors = [
      refusal.busy(),
      refusal.notFound(),
      refusal.offline(),
      refusal.notConnected(),
      refusal.github("cave_code_github_refused"),
      Object.assign(new Error("That Cloud computer is full."), {
        name: "CloudError",
        status: 409,
        code: "cave_code_computer_full",
      }),
    ];
    for (const error of errors) {
      for (const said of [
        refusedWords(error, "approve"),
        refusedWords(error, "merge"),
        refusedWords(error, "comment"),
        unreadWords(error, "list"),
        unreadWords(error, "pull"),
      ]) {
        expect(said).not.toMatch(/\d{3}|cave_|Caveman answered|Cloud computer|Failed to fetch/);
        expect(said).not.toMatch(/try again|retry/i);
      }
    }
  });
});
